// j0spawn — spike launcher for a confined child (J0 Phase 0.5, macOS).
//
// This is the shape of what the Phase 1 broker would do in Rust before exec:
//   1. create the bootstrap pipe and put the per-spawn secret in it (fd 3 in the child);
//   2. close EVERY other descriptor except stdio. macOS has no closefrom(2), so the child
//      enumerates its real descriptor table with proc_pidinfo(PROC_PIDLISTFDS), closes
//      everything above 3, re-enumerates, and refuses to exec if anything is left. This does
//      not depend on RLIMIT_NOFILE (a descriptor above a lowered soft limit, or >= 65536,
//      is still found);
//   3. replace the environment with a fixed minimal one (no tokens, no proxies, no paths);
//   4. new session (setsid: no controlling terminal), optional chdir into scratch;
//   5. apply the SBPL profile to itself with sandbox_init_with_parameters (the same
//      libsystem_sandbox entry point /usr/bin/sandbox-exec uses);
//   6. execve the child. The sandbox is inherited by the child and all its descendants
//      and cannot be removed or widened from inside.
//
// Usage:
//   j0spawn --profile FILE [--param KEY=VALUE]... [--env KEY=VALUE]... [--chdir DIR]
//           [--no-sandbox] [--report] -- /abs/path/to/program [args...]
//
// --no-sandbox runs the same scrub + exec without the profile (baseline / negative control).
// --report prints "j0spawn: child pid=N" and "j0spawn: bootstrap sha256=H len=N" on stderr, so
//          the harness can check the child received the exact secret without the secret itself
//          ever being logged.
// Exit status: the child's exit status, 128+signal if it was killed, or 125 on launcher failure.
//
// Built with -DJ0_LEGACY_RLIMIT_CLOSE it reproduces the 8c64b3bf descriptor loop
// (close 4..min(rlim_cur, 65536)); the isolation runner uses that build ONLY as the
// regression control that shows high descriptors leak without the fix.

#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

// Exported by libsystem_sandbox; not in the public SDK header.
extern int sandbox_init_with_parameters(const char *profile, uint64_t flags,
                                        const char *const parameters[], char **errorbuf);
extern void sandbox_free_error(char *errorbuf);

#define MAXP 64
#define BOOTSTRAP_FD 3

static volatile pid_t child_pid = 0;
// The child is a session/process-group leader (setsid), so -pid reaches its descendants too.
static void forward(int sig) { if (child_pid > 0) { kill(-child_pid, sig); kill(child_pid, sig); } }

static char *read_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); return NULL; }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = n >= 0 ? malloc((size_t)n + 1) : NULL;
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) { fclose(f); free(buf); return NULL; }
    buf[n] = 0;
    fclose(f);
    return buf;
}

#ifndef J0_LEGACY_RLIMIT_CLOSE
// Closes every descriptor > BOOTSTRAP_FD. Returns 0 only if a fresh enumeration of the
// descriptor table afterwards shows nothing but 0..BOOTSTRAP_FD.
static int close_all_above_bootstrap(void) {
    for (int pass = 0; pass < 4; pass++) {
        int sz = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0);
        if (sz <= 0) return -1;
        sz += 64 * (int)PROC_PIDLISTFD_SIZE;  // headroom
        struct proc_fdinfo *fds = malloc((size_t)sz);
        if (!fds) return -1;
        int n = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, fds, sz);
        if (n < 0) { free(fds); return -1; }
        int cnt = n / (int)PROC_PIDLISTFD_SIZE, left = 0;
        for (int k = 0; k < cnt; k++) {
            if (fds[k].proc_fd > BOOTSTRAP_FD) { close(fds[k].proc_fd); left++; }
        }
        free(fds);
        if (left == 0) return 0;  // this enumeration found nothing above 3
    }
    return -1;
}
#endif

int main(int argc, char **argv) {
    const char *profile_path = NULL, *chdir_to = NULL;
    const char *params[2 * MAXP + 1];
    int np = 0;
    char *envv[MAXP + 1];
    int ne = 0;
    int no_sandbox = 0, report = 0;
    int i = 1;
    for (; i < argc; i++) {
        if (!strcmp(argv[i], "--")) { i++; break; }
        if (!strcmp(argv[i], "--profile") && i + 1 < argc) { profile_path = argv[++i]; continue; }
        if (!strcmp(argv[i], "--chdir") && i + 1 < argc) { chdir_to = argv[++i]; continue; }
        if (!strcmp(argv[i], "--no-sandbox")) { no_sandbox = 1; continue; }
        if (!strcmp(argv[i], "--report")) { report = 1; continue; }
        if (!strcmp(argv[i], "--param") && i + 1 < argc && np < 2 * MAXP) {
            char *kv = strdup(argv[++i]);
            char *eq = kv ? strchr(kv, '=') : NULL;
            if (!eq) { fprintf(stderr, "j0spawn: bad --param %s\n", argv[i]); return 125; }
            *eq = 0;
            params[np++] = kv;
            params[np++] = eq + 1;
            continue;
        }
        if (!strcmp(argv[i], "--env") && i + 1 < argc && ne < MAXP) { envv[ne++] = argv[++i]; continue; }
        fprintf(stderr, "j0spawn: unknown arg %s\n", argv[i]);
        return 125;
    }
    params[np] = NULL;
    envv[ne] = NULL;
    if (i >= argc || argv[i][0] != '/') { fprintf(stderr, "j0spawn: need -- /abs/program\n"); return 125; }
    if (!no_sandbox && !profile_path) { fprintf(stderr, "j0spawn: --profile required\n"); return 125; }
    char *profile = no_sandbox ? NULL : read_file(profile_path);
    if (!no_sandbox && !profile) return 125;

    // Per-spawn secret for the bootstrap pipe.
    unsigned char rnd[16];
    arc4random_buf(rnd, sizeof rnd);
    char secret[64];
    int off = snprintf(secret, sizeof secret, "J0-BOOTSTRAP-");
    for (size_t k = 0; k < sizeof rnd; k++) off += snprintf(secret + off, sizeof secret - off, "%02x", rnd[k]);
    secret[off++] = '\n';
    secret[off] = 0;
    memset_s(rnd, sizeof rnd, 0, sizeof rnd);
    size_t secret_len = (size_t)off;

    int p[2];
    if (pipe(p) != 0) { perror("pipe"); return 125; }

    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return 125; }
    if (pid == 0) {
        // Child: its copy of the secret is not needed (the parent writes it into the pipe).
        memset_s(secret, sizeof secret, 0, sizeof secret);
        // Bootstrap pipe read end -> fd 3, write end closed.
        close(p[1]);
        if (p[0] != BOOTSTRAP_FD) {
            if (dup2(p[0], BOOTSTRAP_FD) < 0) _exit(125);
            close(p[0]);
        }
        if (fcntl(BOOTSTRAP_FD, F_SETFD, 0) != 0) _exit(125);  // inherited across exec
#ifdef J0_LEGACY_RLIMIT_CLOSE
        struct rlimit rl;
        int maxfd = (getrlimit(RLIMIT_NOFILE, &rl) == 0 && rl.rlim_cur < 65536) ? (int)rl.rlim_cur : 65536;
        for (int fd = BOOTSTRAP_FD + 1; fd < maxfd; fd++) close(fd);
#else
        if (close_all_above_bootstrap() != 0) {
            fprintf(stderr, "j0spawn: could not close all inherited descriptors; refusing to exec\n");
            _exit(125);
        }
#endif
        if (setsid() < 0) _exit(125);
        if (chdir_to && chdir(chdir_to) != 0) { fprintf(stderr, "j0spawn: chdir: %s\n", strerror(errno)); _exit(125); }
        if (!no_sandbox) {
            char *err = NULL;
            if (sandbox_init_with_parameters(profile, 0, params, &err) != 0) {
                fprintf(stderr, "j0spawn: sandbox_init_with_parameters failed: %s\n", err ? err : "?");
                _exit(125);  // fail closed: never exec unconfined
            }
        }
        execve(argv[i], &argv[i], envv);  // envv is the ENTIRE environment
        fprintf(stderr, "j0spawn: execve %s: %s\n", argv[i], strerror(errno));
        _exit(126);
    }
    child_pid = pid;
    signal(SIGTERM, forward);  // stopping the launcher stops the confined child
    signal(SIGINT, forward);
    signal(SIGHUP, forward);
    signal(SIGALRM, forward);  // the runners' perl-alarm timeout lands here
    close(p[0]);
    signal(SIGPIPE, SIG_IGN);
    if (report) {
        unsigned char h[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(secret, (CC_LONG)secret_len, h);
        char hex[2 * CC_SHA256_DIGEST_LENGTH + 1];
        for (int k = 0; k < CC_SHA256_DIGEST_LENGTH; k++) snprintf(hex + 2 * k, 3, "%02x", h[k]);
        fprintf(stderr, "j0spawn: child pid=%d\nj0spawn: bootstrap sha256=%s len=%zu\n", pid, hex, secret_len);
    }
    size_t done = 0;
    int write_ok = 1;
    while (done < secret_len) {
        ssize_t w = write(p[1], secret + done, secret_len - done);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) { write_ok = 0; break; }
        done += (size_t)w;
    }
    memset_s(secret, sizeof secret, 0, sizeof secret);
    close(p[1]);
    if (!write_ok) fprintf(stderr, "j0spawn: bootstrap write failed: %s\n", strerror(errno));
    int st = 0;
    pid_t w;
    while ((w = waitpid(pid, &st, 0)) < 0 && errno == EINTR) {}
    if (w != pid) { perror("j0spawn: waitpid"); return 125; }
    if (WIFEXITED(st)) return WEXITSTATUS(st);
    if (WIFSIGNALED(st)) return 128 + WTERMSIG(st);
    return 125;
}
