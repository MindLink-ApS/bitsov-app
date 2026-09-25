// j0fdplant — hostile-parent helper for the descriptor controls (J0 spike, mock only).
//
// Plays a careless parent: opens anonymous pipes that each hold a fresh host-private
// marker ("J0-HOSTPRIVATE-<random>"), moves their read ends to HIGH descriptor numbers
// (default 5000 and 70000, i.e. above a lowered soft limit and at/above 65536), then
// LOWERS the RLIMIT_NOFILE soft limit (default 256) and execs the given command, which
// inherits those descriptors. The marker value is never printed.
//
// Usage: j0fdplant [--fd N]... [--soft-limit N] -- /abs/cmd [args...]
// Prints on stderr: "j0fdplant: planted=5000,70000 failed= soft_limit=256"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

int main(int argc, char **argv) {
    int want[16], nw = 0, soft = 256, i = 1;
    for (; i < argc; i++) {
        if (!strcmp(argv[i], "--")) { i++; break; }
        if (!strcmp(argv[i], "--fd") && i + 1 < argc && nw < 16) { want[nw++] = atoi(argv[++i]); continue; }
        if (!strcmp(argv[i], "--soft-limit") && i + 1 < argc) { soft = atoi(argv[++i]); continue; }
        fprintf(stderr, "j0fdplant: unknown arg %s\n", argv[i]);
        return 125;
    }
    if (i >= argc || argv[i][0] != '/') { fprintf(stderr, "j0fdplant: need -- /abs/cmd\n"); return 125; }
    if (nw == 0) { want[nw++] = 5000; want[nw++] = 70000; }

    // Raise the soft limit so dup2 to the high numbers is possible.
    struct rlimit rl;
    if (getrlimit(RLIMIT_NOFILE, &rl) != 0) { perror("getrlimit"); return 125; }
    int maxwant = 0;
    for (int k = 0; k < nw; k++) if (want[k] > maxwant) maxwant = want[k];
    if (rl.rlim_cur <= (rlim_t)maxwant) {
        struct rlimit up = rl;
        up.rlim_cur = (rlim_t)maxwant + 1;
        if (setrlimit(RLIMIT_NOFILE, &up) != 0) fprintf(stderr, "j0fdplant: raise soft limit: %s\n", strerror(errno));
    }

    char planted[256] = "", failed[256] = "";
    for (int k = 0; k < nw; k++) {
        int p[2];
        char msg[64], one[16];
        if (pipe(p) != 0) { perror("pipe"); return 125; }
        unsigned char r[12];
        arc4random_buf(r, sizeof r);
        int off = snprintf(msg, sizeof msg, "J0-HOSTPRIVATE-");
        for (size_t j = 0; j < sizeof r; j++) off += snprintf(msg + off, sizeof msg - off, "%02x", r[j]);
        msg[off++] = '\n';
        (void)!write(p[1], msg, (size_t)off);
        memset(msg, 0, sizeof msg);
        close(p[1]);
        snprintf(one, sizeof one, "%s%d", "", want[k]);
        if (dup2(p[0], want[k]) == want[k] && fcntl(want[k], F_SETFD, 0) == 0) {
            strlcat(planted, planted[0] ? "," : "", sizeof planted);
            strlcat(planted, one, sizeof planted);
        } else {
            strlcat(failed, failed[0] ? "," : "", sizeof failed);
            strlcat(failed, one, sizeof failed);
        }
        if (p[0] != want[k]) close(p[0]);
    }

    struct rlimit down;
    if (getrlimit(RLIMIT_NOFILE, &down) == 0) {
        down.rlim_cur = (rlim_t)soft;
        if (setrlimit(RLIMIT_NOFILE, &down) != 0) fprintf(stderr, "j0fdplant: lower soft limit: %s\n", strerror(errno));
    }
    getrlimit(RLIMIT_NOFILE, &down);
    fprintf(stderr, "j0fdplant: planted=%s failed=%s soft_limit=%llu\n", planted, failed, (unsigned long long)down.rlim_cur);
    execv(argv[i], &argv[i]);
    fprintf(stderr, "j0fdplant: exec %s: %s\n", argv[i], strerror(errno));
    return 126;
}
