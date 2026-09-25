// j0spawn — spike launcher for a confined child (J0 Phase 0.5, macOS).
//
// This is the shape of what the Phase 1 broker would do in Rust before exec:
//   1. create the bootstrap pipe and put the per-spawn secret in it (fd 3 in the child);
//   2. close every other descriptor except stdio;
//   3. replace the environment with a fixed minimal one (no tokens, no proxies, no paths);
//   4. apply the SBPL profile to itself with sandbox_init_with_parameters (the same
//      libsystem_sandbox entry point /usr/bin/sandbox-exec uses);
//   5. execve the child. The sandbox is inherited by the child and all its descendants
//      and cannot be removed or widened from inside.
//
// Usage:
//   j0spawn --profile FILE [--param KEY=VALUE]... [--env KEY=VALUE]... [--no-sandbox]
//           -- /abs/path/to/program [args...]
//
// --no-sandbox runs the same scrub + exec without the profile (baseline / negative control).
// Exit status: the child's exit status, or 125 on launcher failure.

#include <errno.h>
#include <fcntl.h>
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
static void forward(int sig) { if (child_pid > 0) kill(child_pid, sig); }

static char *read_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); return NULL; }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)n + 1);
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) { fclose(f); return NULL; }
    buf[n] = 0;
    fclose(f);
    return buf;
}

int main(int argc, char **argv) {
    const char *profile_path = NULL;
    const char *params[2 * MAXP + 1];
    int np = 0;
    char *envv[MAXP + 1];
    int ne = 0;
    int no_sandbox = 0;
    int i = 1;
    for (; i < argc; i++) {
        if (!strcmp(argv[i], "--")) { i++; break; }
        if (!strcmp(argv[i], "--profile") && i + 1 < argc) { profile_path = argv[++i]; continue; }
        if (!strcmp(argv[i], "--no-sandbox")) { no_sandbox = 1; continue; }
        if (!strcmp(argv[i], "--param") && i + 1 < argc && np < 2 * MAXP) {
            char *kv = strdup(argv[++i]);
            char *eq = strchr(kv, '=');
            if (!eq) { fprintf(stderr, "j0spawn: bad --param %s\n", kv); return 125; }
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

    int p[2];
    if (pipe(p) != 0) { perror("pipe"); return 125; }

    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return 125; }
    if (pid == 0) {
        // Child: bootstrap pipe read end -> fd 3, write end closed.
        close(p[1]);
        if (p[0] != BOOTSTRAP_FD) {
            if (dup2(p[0], BOOTSTRAP_FD) < 0) _exit(125);
            close(p[0]);
        }
        fcntl(BOOTSTRAP_FD, F_SETFD, 0);  // inherited across exec
        // Close every other descriptor above stdio.
        struct rlimit rl;
        int maxfd = (getrlimit(RLIMIT_NOFILE, &rl) == 0 && rl.rlim_cur < 65536) ? (int)rl.rlim_cur : 65536;
        for (int fd = BOOTSTRAP_FD + 1; fd < maxfd; fd++) close(fd);
        if (!no_sandbox) {
            char *err = NULL;
            if (sandbox_init_with_parameters(profile, 0, params, &err) != 0) {
                fprintf(stderr, "j0spawn: sandbox_init_with_parameters failed: %s\n", err ? err : "?");
                _exit(125);
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
    close(p[0]);
    signal(SIGPIPE, SIG_IGN);
    (void)!write(p[1], secret, strlen(secret));
    close(p[1]);
    int st = 0;
    while (waitpid(pid, &st, 0) < 0 && errno == EINTR) {}
    if (WIFEXITED(st)) return WEXITSTATUS(st);
    if (WIFSIGNALED(st)) return 128 + WTERMSIG(st);
    return 125;
}
