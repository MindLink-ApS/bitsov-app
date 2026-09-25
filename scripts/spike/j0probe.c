// j0probe — attack/probe program run INSIDE the confined child (J0 spike, mock only).
//
// It attempts every read, write, network, IPC, inspection and signal operation the
// isolation contract (ARCHITECTURE §3.1) forbids, plus the positive controls it must
// still allow. It never judges; it prints one machine-readable line per attempt:
//
//   R <test-id> <OK|DENIED> <errno-name> <detail>
//
// The harness (run-isolation-tests.sh) compares confined vs unconfined (baseline) runs.
//
// Options (repeatable where noted):
//   --scratch DIR           the child's own scratch dir (positive write control)
//   --node-port N           fake node TCP port on 127.0.0.1
//   --control PATH          fake control.sock
//   --llm PATH              fake LLM socket (positive control)
//   --broker-ipc PATH       fake broker IPC socket (positive control)
//   --broker-pid PID        dummy broker pid (inspection + signal target)
//   --read ID=PATH          (rep) a protected file or dir that must be unreadable
//   --write ID=DIR          (rep) a protected dir holding DIR/canary.txt; all mutations must fail
//   --mach NAME             (rep) a mach service that must not be reachable
//   --listen PATH           try to serve a unix socket at PATH (only the LLM role may)
//   --listen-other PATH     a SECOND socket path; must be refused even for the LLM role
//   --egress IP:PORT        a non-loopback TCP endpoint (the dummy broker on this host's LAN
//                           address) — must be unreachable
//   --victim-stop/--victim-term/--victim-kill/--victim-ptrace PID
//                           disposable processes that receive the destructive signals and the
//                           ptrace attach in BOTH modes, so every one has a same-operation baseline
//   --mode baseline|confined  label only; both modes attempt the same operations
//   --cat PATH              internal: the re-exec'd child for exec.child_inherits_sandbox
//
// Secrets are never printed: the bootstrap secret is reported as length + sha256, and inherited
// descriptors are classified (hostprivate/canary/other) without echoing their contents.

#include <CommonCrypto/CommonDigest.h>
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <netinet/in.h>
#include <poll.h>
#include <servers/bootstrap.h>
#include <signal.h>
#include <stdarg.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <libproc.h>
#include <unistd.h>

extern char **environ;

#define MAXN 64
static const char *scratch, *control_path, *llm_path, *broker_ipc_path, *listen_path, *listen_other, *egress, *self_path;
static int node_port = 0, broker_pid = 0, confined = 0;
static int victim_stop = 0, victim_term = 0, victim_kill = 0, victim_ptrace = 0;
static char *reads[MAXN], *writes[MAXN], *machs[MAXN];
static int nreads, nwrites, nmachs;

static const char *ename(int e) {
    switch (e) {
    case 0: return "0";
    case EPERM: return "EPERM";
    case EACCES: return "EACCES";
    case ENOENT: return "ENOENT";
    case EEXIST: return "EEXIST";
    case ECONNREFUSED: return "ECONNREFUSED";
    case ETIMEDOUT: return "ETIMEDOUT";
    case ENETUNREACH: return "ENETUNREACH";
    case EHOSTUNREACH: return "EHOSTUNREACH";
    case EINPROGRESS: return "EINPROGRESS";
    case ESRCH: return "ESRCH";
    case EBADF: return "EBADF";
    case EINVAL: return "EINVAL";
    case ENOTSUP: return "ENOTSUP";
    case EXDEV: return "EXDEV";
    case EADDRNOTAVAIL: return "EADDRNOTAVAIL";
    default: {
        static char b[16];
        snprintf(b, sizeof b, "E%d", e);
        return b;
    }
    }
}

static void rep(const char *id, int ok, int err, const char *fmt, ...) {
    char detail[512] = "";
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(detail, sizeof detail, fmt, ap);
    va_end(ap);
    for (char *p = detail; *p; p++) if (*p == '\n') *p = ' ';
    printf("R %s %s %s %s\n", id, ok ? "OK" : "DENIED", ok ? "0" : ename(err), detail);
}

static void sha256_hex(const void *d, size_t n, char out[65]) {
    unsigned char h[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(d, (CC_LONG)n, h);
    for (int k = 0; k < CC_SHA256_DIGEST_LENGTH; k++) snprintf(out + 2 * k, 3, "%02x", h[k]);
}

// Returns bytes read into buf (>=0) or -errno.
static int connect_unix(const char *path, char *buf, size_t bl) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -errno;
    struct sockaddr_un a = {0};
    a.sun_family = AF_UNIX;
    strncpy(a.sun_path, path, sizeof a.sun_path - 1);
    if (connect(fd, (struct sockaddr *)&a, sizeof a) != 0) { int e = errno; close(fd); return -e; }
    struct timeval tv = {2, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    ssize_t n = read(fd, buf, bl - 1);
    buf[n > 0 ? n : 0] = 0;
    close(fd);
    return n > 0 ? (int)n : 0;
}

static int connect_tcp(int family, const char *addr, int port, int timeout_ms, char *buf, size_t bl) {
    int fd = socket(family, SOCK_STREAM, 0);
    if (fd < 0) return -errno;
    struct sockaddr_storage ss = {0};
    socklen_t sl;
    if (family == AF_INET) {
        struct sockaddr_in *s = (struct sockaddr_in *)&ss;
        s->sin_family = AF_INET; s->sin_port = htons(port); inet_pton(AF_INET, addr, &s->sin_addr);
        sl = sizeof *s;
    } else {
        struct sockaddr_in6 *s = (struct sockaddr_in6 *)&ss;
        s->sin6_family = AF_INET6; s->sin6_port = htons(port); inet_pton(AF_INET6, addr, &s->sin6_addr);
        sl = sizeof *s;
    }
    fcntl(fd, F_SETFL, O_NONBLOCK);
    int r = connect(fd, (struct sockaddr *)&ss, sl);
    if (r != 0 && errno != EINPROGRESS) { int e = errno; close(fd); return -e; }
    if (r != 0) {
        struct pollfd p = {fd, POLLOUT, 0};
        if (poll(&p, 1, timeout_ms) <= 0) { close(fd); return -ETIMEDOUT; }
        int soerr = 0; socklen_t el = sizeof soerr;
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &el);
        if (soerr) { close(fd); return -soerr; }
    }
    fcntl(fd, F_SETFL, 0);
    struct timeval tv = {2, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    ssize_t n = read(fd, buf, bl - 1);
    buf[n > 0 ? n : 0] = 0;
    close(fd);
    return n > 0 ? (int)n : 0;
}

// Splits a copy of "ID=PATH"; the original string is left intact.
static void split(const char *orig, char **id, char **path) {
    char *s = strdup(orig);
    char *eq = strchr(s, '=');
    if (!eq) { fprintf(stderr, "bad ID=PATH: %s\n", orig); exit(2); }
    *eq = 0; *id = s; *path = eq + 1;
}

// ---------- reads ----------
static void test_reads(void) {
    for (int i = 0; i < nreads; i++) {
        char *id, *path; split(reads[i], &id, &path);
        char tid[128];
        struct stat st;
        int sr = stat(path, &st);
        snprintf(tid, sizeof tid, "read.%s.stat", id);
        rep(tid, sr == 0, errno, "%s (stat: existence, size, times)", path);
        // Decide by the declared id, not by stat(): stat itself is expected to be denied.
        int is_dir = strstr(id, "_dir") != NULL;
        if (is_dir) {
            snprintf(tid, sizeof tid, "read.%s.listdir", id);
            DIR *d = opendir(path);
            if (d) {
                int n = 0; struct dirent *de;
                while ((de = readdir(d))) n++;
                closedir(d);
                rep(tid, 1, 0, "%s entries=%d", path, n);
            } else rep(tid, 0, errno, "%s", path);
        } else {
            snprintf(tid, sizeof tid, "read.%s.open", id);
            int fd = open(path, O_RDONLY);
            if (fd >= 0) {
                char b[64] = {0};
                ssize_t n = read(fd, b, sizeof b - 1);
                close(fd);
                rep(tid, 1, 0, "%s read %zd bytes: %.24s", path, n, b);
            } else rep(tid, 0, errno, "%s", path);
        }
    }
}

// ---------- writes ----------
static void test_write_dir(const char *id, const char *dir, int expect_scratch) {
    char canary[1024], p2[1024], tid[160], own[1024];
    snprintf(canary, sizeof canary, "%s/canary.txt", dir);
    snprintf(own, sizeof own, "%s/own-%d.txt", scratch, getpid());
    { int fd = open(own, O_CREAT | O_WRONLY | O_TRUNC, 0644); if (fd >= 0) { (void)!write(fd, "own\n", 4); close(fd); } }
    (void)expect_scratch;
    int fd, r;

#define T(name) snprintf(tid, sizeof tid, "write.%s.%s", id, name)
    T("create");
    snprintf(p2, sizeof p2, "%s/j0-created-%d", dir, getpid());
    fd = open(p2, O_CREAT | O_EXCL | O_WRONLY, 0644);
    rep(tid, fd >= 0, errno, "%s", p2); if (fd >= 0) close(fd);

    T("mkdir");
    snprintf(p2, sizeof p2, "%s/j0-dir-%d", dir, getpid());
    r = mkdir(p2, 0755);
    rep(tid, r == 0, errno, "%s", p2);

    T("write");
    fd = open(canary, O_WRONLY | O_APPEND);
    if (fd >= 0) { ssize_t n = write(fd, "PWNED\n", 6); rep(tid, n == 6, errno, "%s", canary); close(fd); }
    else rep(tid, 0, errno, "%s", canary);

    T("truncate");
    r = truncate(canary, 1);
    rep(tid, r == 0, errno, "%s", canary);

    T("open_trunc");
    fd = open(canary, O_WRONLY | O_TRUNC);
    rep(tid, fd >= 0, errno, "%s", canary); if (fd >= 0) close(fd);

    T("chmod");
    r = chmod(canary, 0666);
    rep(tid, r == 0, errno, "%s", canary);

    T("utimes");
    r = utimes(canary, NULL);
    rep(tid, r == 0, errno, "%s", canary);

    T("setxattr");
    r = setxattr(canary, "j0.pwned", "1", 1, 0, 0);
    rep(tid, r == 0, errno, "%s", canary);

    T("rename_in_place");
    snprintf(p2, sizeof p2, "%s/canary.renamed", dir);
    r = rename(canary, p2);
    rep(tid, r == 0, errno, "%s -> %s", canary, p2);
    if (r == 0) rename(p2, canary);

    T("rename_out_to_scratch");
    snprintf(p2, sizeof p2, "%s/stolen-%s-%d", scratch, id, getpid());
    r = rename(canary, p2);
    rep(tid, r == 0, errno, "%s -> %s", canary, p2);
    if (r == 0) rename(p2, canary);

    T("rename_in_from_scratch");
    snprintf(p2, sizeof p2, "%s/j0-planted-%d", dir, getpid());
    r = rename(own, p2);
    rep(tid, r == 0, errno, "%s -> %s", own, p2);
    if (r == 0) rename(p2, own);

    T("symlink_create_in_target");
    snprintf(p2, sizeof p2, "%s/j0-symlink-%d", dir, getpid());
    r = symlink(scratch, p2);
    rep(tid, r == 0, errno, "%s -> %s", p2, scratch);

    T("symlink_escape_write");  // link lives in scratch, points at the canary
    snprintf(p2, sizeof p2, "%s/sl-%s-%d", scratch, id, getpid());
    unlink(p2);
    r = symlink(canary, p2);
    if (r != 0) rep(tid, 0, errno, "could not create %s (in scratch)", p2);
    else {
        fd = open(p2, O_WRONLY | O_APPEND);
        if (fd >= 0) { ssize_t n = write(fd, "PWNED-VIA-SYMLINK\n", 18); rep(tid, n == 18, errno, "write via %s", p2); close(fd); }
        else rep(tid, 0, errno, "write via %s -> %s", p2, canary);
        unlink(p2);
    }

    T("hardlink_create_in_target");
    snprintf(p2, sizeof p2, "%s/j0-hardlink-%d", dir, getpid());
    r = link(own, p2);
    rep(tid, r == 0, errno, "%s <- %s", p2, own);

    T("hardlink_escape");  // hard link of the canary INTO scratch, then write through it
    snprintf(p2, sizeof p2, "%s/hl-%s-%d", scratch, id, getpid());
    unlink(p2);
    r = link(canary, p2);
    if (r != 0) rep(tid, 0, errno, "link %s -> %s", canary, p2);
    else {
        fd = open(p2, O_WRONLY | O_APPEND);
        if (fd >= 0) { ssize_t n = write(fd, "PWNED-VIA-HARDLINK\n", 19); rep(tid, n == 19, errno, "link created AND written via %s", p2); close(fd); }
        else rep(tid, 1, 0, "link created in scratch (write through it: %s)", ename(errno));
        unlink(p2);
    }

    T("unlink");
    r = unlink(canary);
    rep(tid, r == 0, errno, "%s", canary);
#undef T
}

// ---------- network / IPC ----------
static void test_net(void) {
    char buf[128];
    int r;
    if (node_port) {
        r = connect_tcp(AF_INET, "127.0.0.1", node_port, 2000, buf, sizeof buf);
        rep("net.node_tcp_127.0.0.1", r >= 0, -r, "port %d reply=%s", node_port, r > 0 ? buf : "");
        r = connect_tcp(AF_INET6, "::1", node_port, 2000, buf, sizeof buf);
        rep("net.node_tcp_::1", r >= 0, -r, "port %d reply=%s", node_port, r > 0 ? buf : "");
    }
    if (control_path) {
        r = connect_unix(control_path, buf, sizeof buf);
        rep("net.control_sock", r >= 0, -r, "%s reply=%s", control_path, r > 0 ? buf : "");
    }
    if (egress) {  // non-loopback remote address (this host's own LAN IPv4, dummy broker listening)
        char host[64];
        snprintf(host, sizeof host, "%s", egress);
        char *colon = strrchr(host, ':');
        if (colon) {
            *colon = 0;
            r = connect_tcp(AF_INET, host, atoi(colon + 1), 2000, buf, sizeof buf);
            rep("net.egress_tcp_nonloopback", r > 0 && strstr(buf, "pong"), r < 0 ? -r : EIO, "%s:%s reply=%s", host, colon + 1, r > 0 ? buf : "");
        }
    }
    {
        int fd = socket(AF_INET, SOCK_DGRAM, 0);
        struct sockaddr_in a = {0};
        a.sin_family = AF_INET; a.sin_port = htons(node_port ? node_port : 9); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        ssize_t n = fd >= 0 ? sendto(fd, "x", 1, 0, (struct sockaddr *)&a, sizeof a) : -1;
        rep("net.udp_loopback_send", n == 1, errno, "127.0.0.1:%d", node_port);
        if (fd >= 0) close(fd);
    }
    {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        struct sockaddr_in a = {0};
        a.sin_family = AF_INET; a.sin_port = 0; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        r = (fd >= 0 && bind(fd, (struct sockaddr *)&a, sizeof a) == 0 && listen(fd, 1) == 0) ? 0 : -1;
        rep("net.tcp_listen_loopback", r == 0, errno, "bind+listen 127.0.0.1:0");
        if (fd >= 0) close(fd);
    }
    if (llm_path) {
        r = connect_unix(llm_path, buf, sizeof buf);
        rep("pos.llm_sock", r > 0 && strstr(buf, "pong"), r < 0 ? -r : 0, "%s reply=%s", llm_path, r > 0 ? buf : "");
    }
    if (broker_ipc_path) {
        r = connect_unix(broker_ipc_path, buf, sizeof buf);
        rep("pos.broker_ipc_sock", r > 0 && strstr(buf, "pong"), r < 0 ? -r : 0, "%s reply=%s", broker_ipc_path, r > 0 ? buf : "");
    }
    if (listen_path) {  // serve a unix socket: allowed only for ROLE=llm in its LISTEN_DIR
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un a = {0};
        a.sun_family = AF_UNIX;
        strncpy(a.sun_path, listen_path, sizeof a.sun_path - 1);
        r = (fd >= 0 && bind(fd, (struct sockaddr *)&a, sizeof a) == 0 && listen(fd, 1) == 0) ? 0 : -1;
        rep("net.listen_unix", r == 0, errno, "bind+listen %s", listen_path);
        if (fd >= 0) close(fd);
        if (r == 0) unlink(listen_path);
    }
    if (listen_other) {  // a second socket: the LLM role serves exactly one path
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un a = {0};
        a.sun_family = AF_UNIX;
        strncpy(a.sun_path, listen_other, sizeof a.sun_path - 1);
        r = (fd >= 0 && bind(fd, (struct sockaddr *)&a, sizeof a) == 0 && listen(fd, 1) == 0) ? 0 : -1;
        rep("net.listen_unix_other", r == 0, errno, "bind+listen %s", listen_other);
        if (fd >= 0) close(fd);
        if (r == 0) unlink(listen_other);
    }
    for (int i = 0; i < nmachs; i++) {
        mach_port_t port = MACH_PORT_NULL;
        kern_return_t kr = bootstrap_look_up(bootstrap_port, machs[i], &port);
        char tid[160];
        snprintf(tid, sizeof tid, "mach.%s", machs[i]);
        // KR1100 = BOOTSTRAP_NOT_PRIVILEGED (sandbox); KR1102 = BOOTSTRAP_UNKNOWN_SERVICE (absent).
        printf("R %s %s KR%d (%s)\n", tid, kr == KERN_SUCCESS ? "OK" : "DENIED", kr, bootstrap_strerror(kr));
        if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
    }
}

// ---------- inspection / signals ----------
static void test_proc(void) {
    if (!broker_pid) return;
    mach_port_t task = MACH_PORT_NULL;
    kern_return_t kr = task_for_pid(mach_task_self(), broker_pid, &task);
    printf("R proc.task_for_pid %s KR%d (%s)\n", kr == KERN_SUCCESS ? "OK" : "DENIED", kr, mach_error_string(kr));
    if (task != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), task);

    mach_port_t tn = MACH_PORT_NULL;
    kr = task_name_for_pid(mach_task_self(), broker_pid, &tn);
    printf("R proc.task_name_for_pid %s KR%d (%s)\n", kr == KERN_SUCCESS ? "OK" : "DENIED", kr, mach_error_string(kr));
    if (tn != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), tn);

    struct proc_bsdinfo bi;
    int n = proc_pidinfo(broker_pid, PROC_PIDTBSDINFO, 0, &bi, sizeof bi);
    rep("proc.pidinfo", n == (int)sizeof bi, errno, "proc_pidinfo(PROC_PIDTBSDINFO) on broker");

    char pathbuf[PROC_PIDPATHINFO_MAXSIZE];
    n = proc_pidpath(broker_pid, pathbuf, sizeof pathbuf);
    rep("proc.pidpath", n > 0, errno, "%s", n > 0 ? pathbuf : "");

    int pids[8192];
    n = proc_listallpids(pids, sizeof pids);
    rep("proc.listallpids", n > 0, errno, "proc_listallpids -> %d", n);

    {
        int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, broker_pid};
        struct kinfo_proc kp;
        size_t len = sizeof kp;
        memset(&kp, 0, sizeof kp);
        int sr = sysctl(mib, 4, &kp, &len, NULL, 0);
        int found = sr == 0 && len > 0 && kp.kp_proc.p_pid == broker_pid;
        rep("proc.sysctl_kern_proc_pid", found, sr == 0 ? ESRCH : errno, "sysctl KERN_PROC_PID %d len=%zu comm=%s", broker_pid, len, found ? kp.kp_proc.p_comm : "");
    }
    // argv/environment of another process (what `ps -E` uses): kern.procargs / kern.procargs2.
    {
        static const struct { const char *id; int op; } pa[] = {
            {"proc.sysctl_kern_procargs2", KERN_PROCARGS2}, {"proc.sysctl_kern_procargs", KERN_PROCARGS}};
        for (int k = 0; k < 2; k++) {
            int mib[3] = {CTL_KERN, pa[k].op, broker_pid};
            static char args[65536];
            size_t len = sizeof args;
            int sr = sysctl(mib, 3, args, &len, NULL, 0);
            rep(pa[k].id, sr == 0 && len > 0, sr == 0 ? ENOENT : errno, "sysctl {kern,%d,%d} len=%zu", pa[k].op, broker_pid, sr == 0 ? len : 0);
        }
    }

    int r = kill(broker_pid, 0);
    rep("sig.kill0", r == 0, errno, "kill(%d, 0)", broker_pid);
    r = kill(broker_pid, SIGUSR1);
    rep("sig.SIGUSR1", r == 0, errno, "kill(%d, SIGUSR1)", broker_pid);
}

// Destructive signals and ptrace go to disposable victims, in BOTH modes, so each has a
// same-operation baseline. The runner checks the victims' fate independently (ps / wait status).
static void test_victims(void) {
    int r;
    if (victim_stop) { r = kill(victim_stop, SIGSTOP); rep("sig.SIGSTOP", r == 0, errno, "kill(victim %d, SIGSTOP)", victim_stop); }
    if (victim_term) { r = kill(victim_term, SIGTERM); rep("sig.SIGTERM", r == 0, errno, "kill(victim %d, SIGTERM)", victim_term); }
    if (victim_kill) { r = kill(victim_kill, SIGKILL); rep("sig.SIGKILL", r == 0, errno, "kill(victim %d, SIGKILL)", victim_kill); }
    if (victim_ptrace) {
        r = ptrace(PT_ATTACHEXC, victim_ptrace, 0, 0);
        rep("proc.ptrace_attach", r == 0, errno, "ptrace(PT_ATTACHEXC, victim %d)", victim_ptrace);
        if (r == 0) ptrace(PT_DETACH, victim_ptrace, (caddr_t)1, 0);
    }
}

// ---------- environment / descriptors ----------
static void test_env(void) {
    const char *bad[] = {"TOKEN", "SECRET", "PASS", "KEY", "AUTH", "BITSOV", "KONSENSUS", "PROXY", "COOKIE", "SESSION", NULL};
    char names[2048] = "";
    int hits = 0;
    for (char **e = environ; *e; e++) {
        const char *eq = strchr(*e, '=');
        size_t kl = eq ? (size_t)(eq - *e) : strlen(*e);
        char k[256];
        snprintf(k, sizeof k, "%.*s", (int)kl, *e);
        strncat(names, k, sizeof names - strlen(names) - 2);
        strncat(names, ",", sizeof names - strlen(names) - 1);
        char up[256];
        for (size_t j = 0; j <= strlen(k); j++) up[j] = (char)((k[j] >= 'a' && k[j] <= 'z') ? k[j] - 32 : k[j]);
        for (int b = 0; bad[b]; b++) if (strstr(up, bad[b])) hits++;
        if (eq && strstr(eq, "canary-token")) hits++;
    }
    // Names only (values are never printed). The runner requires the exact launcher set.
    printf("R env.no_sensitive_vars %s %s names=[%s] sensitive_hits=%d\n", hits ? "FOUND" : "CLEAN", hits ? "LEAK" : "0", names, hits);
}

// Classifies what an inherited descriptor would leak, without printing it.
static const char *fd_content_class(int fd, int is_pipe) {
    char b[64] = {0};
    ssize_t n;
    if (is_pipe) {
        int fl = fcntl(fd, F_GETFL);
        if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
        n = read(fd, b, sizeof b - 1);
    } else n = pread(fd, b, sizeof b - 1, 0);
    static char e[32];
    if (n < 0) { snprintf(e, sizeof e, "unreadable:%s", ename(errno)); return e; }
    if (n == 0) return "empty";
    if (!strncmp(b, "J0-HOSTPRIVATE-", 15)) return "hostprivate";
    if (!strncmp(b, "CANARY-", 7)) return "canary";
    return "other";
}

// Every open descriptor, from two independent sources, neither bounded by RLIMIT_NOFILE:
//   fd.inventory — the kernel's descriptor table, proc_pidinfo(self, PROC_PIDLISTFDS)
//   fd.scan      — fcntl(F_GETFD) on every number below kern.maxfilesperproc
// Every descriptor above 3 is read (pipes) or pread (files) and its content classified.
static void test_fds(void) {
    char list[4096] = "";
    int count = 0, ok = 0;
    int sz = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0);
    struct proc_fdinfo *fdi = sz > 0 ? malloc((size_t)sz + 64 * PROC_PIDLISTFD_SIZE) : NULL;
    int n = fdi ? proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, fdi, sz + 64 * (int)PROC_PIDLISTFD_SIZE) : -1;
    int listerr = errno;
    int highfds[256], nhigh = 0, hightype[256];
    if (n >= 0) {
        ok = 1;
        for (int k = 0; k < n / (int)PROC_PIDLISTFD_SIZE; k++) {
            int fd = fdi[k].proc_fd;
            const char *t = "?";
            switch (fdi[k].proc_fdtype) {
            case PROX_FDTYPE_VNODE: t = "vnode"; break;
            case PROX_FDTYPE_SOCKET: t = "socket"; break;
            case PROX_FDTYPE_PIPE: t = "pipe"; break;
            case PROX_FDTYPE_KQUEUE: t = "kqueue"; break;
            case PROX_FDTYPE_PSHM: t = "pshm"; break;
            case PROX_FDTYPE_PSEM: t = "psem"; break;
            }
            char one[64];
            snprintf(one, sizeof one, "%d:%s ", fd, t);
            strlcat(list, one, sizeof list);
            count++;
            if (fd > 3 && nhigh < 256) { hightype[nhigh] = fdi[k].proc_fdtype; highfds[nhigh++] = fd; }
        }
    }
    free(fdi);
    if (ok) printf("R fd.inventory INFO %d open=[%s]\n", count, list);
    else printf("R fd.inventory ERROR %s proc_pidinfo(PROC_PIDLISTFDS) failed\n", ename(listerr));

    int maxf = 0;
    size_t ml = sizeof maxf;
    if (sysctlbyname("kern.maxfilesperproc", &maxf, &ml, NULL, 0) != 0 || maxf < 65536) maxf = 1 << 18;
    char scan[4096] = "";
    int scount = 0;
    for (int fd = 0; fd < maxf; fd++) {
        if (fcntl(fd, F_GETFD) < 0) continue;
        char one[32];
        snprintf(one, sizeof one, "%d ", fd);
        strlcat(scan, one, sizeof scan);
        scount++;
    }
    printf("R fd.scan INFO %d open=[%s] limit=%d\n", scount, scan, maxf);

    for (int k = 0; k < nhigh; k++) {
        char id[64];
        snprintf(id, sizeof id, "fd.content.%d", highfds[k]);
        const char *c = hightype[k] == PROX_FDTYPE_SOCKET ? "socket(not read)" : fd_content_class(highfds[k], hightype[k] == PROX_FDTYPE_PIPE);
        printf("R %s INFO %s\n", id, c);
    }
}

static void test_bootstrap(void) {
    char b[128] = {0};
    ssize_t n = read(3, b, sizeof b - 1);
    int e = errno;
    char h[65] = "";
    if (n > 0) sha256_hex(b, (size_t)n, h);
    int ok = n > 0 && !strncmp(b, "J0-BOOTSTRAP-", 13);
    memset_s(b, sizeof b, 0, sizeof b);
    rep("pos.bootstrap_pipe_fd3", ok, e, "read %zd bytes sha256=%s", n, n > 0 ? h : "-");
}

// ---------- exec inheritance ----------
// Runs argv in a child with stdout+stderr captured. Returns posix_spawn's error (0 = spawned).
static int spawn_capture(char *const argv[], char *out, size_t ol, int *status) {
    int p[2];
    if (pipe(p) != 0) return errno;
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, p[1], 1);
    posix_spawn_file_actions_adddup2(&fa, p[1], 2);
    posix_spawn_file_actions_addclose(&fa, p[0]);
    pid_t pid;
    int r = posix_spawn(&pid, argv[0], &fa, NULL, argv, environ);
    posix_spawn_file_actions_destroy(&fa);
    close(p[1]);
    out[0] = 0;
    *status = -1;
    if (r == 0) {
        size_t got = 0;
        ssize_t n;
        while (got < ol - 1 && (n = read(p[0], out + got, ol - 1 - got)) > 0) got += (size_t)n;
        out[got] = 0;
        int st;
        waitpid(pid, &st, 0);
        *status = WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st);
    }
    close(p[0]);
    return r;
}

// A descendant stays confined: the probe re-execs ITSELF (allowed: EXEC_DIR) in --cat mode and
// the grandchild tries to read the node-data canary. It reports "CAT-ERR <errno>" or "CAT-OK".
static int cat_mode(const char *path) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) { printf("CAT-ERR %s\n", ename(errno)); return 1; }
    char b[64] = {0};
    ssize_t n = read(fd, b, sizeof b - 1);
    close(fd);
    printf("CAT-OK %s\n", n > 0 && !strncmp(b, "CANARY-", 7) ? "canary" : "other");
    return 0;
}

static void test_exec(void) {
    char out[256];
    int st, r;
    if (nreads && self_path) {
        char *id, *path;
        split(reads[0], &id, &path);
        char *a[] = {(char *)self_path, "--cat", path, NULL};
        r = spawn_capture(a, out, sizeof out, &st);
        int leaked = r == 0 && strstr(out, "CAT-OK canary") != NULL;
        char e[32] = "E?";
        char *ce = strstr(out, "CAT-ERR ");
        if (r != 0) snprintf(e, sizeof e, "%s", ename(r));
        else if (ce) sscanf(ce + 8, "%31s", e);
        printf("R exec.child_inherits_sandbox %s %s spawn=%s exit=%d grandchild read %s\n",
               leaked ? "OK" : "DENIED", leaked ? "0" : e, ename(r), st, path);
    }
    // System binaries (a shell, coreutils) are not executable in the shipping profile.
    char *sh[] = {"/bin/sh", "-c", "exit 0", NULL};
    r = spawn_capture(sh, out, sizeof out, &st);
    rep("exec.system_shell", r == 0 && st == 0, r ? r : EIO, "posix_spawn /bin/sh exit=%d", st);
    char *cat[] = {"/bin/cat", "/dev/null", NULL};
    r = spawn_capture(cat, out, sizeof out, &st);
    rep("exec.system_bin_cat", r == 0 && st == 0, r ? r : EIO, "posix_spawn /bin/cat exit=%d", st);
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (argc == 3 && !strcmp(argv[1], "--cat")) return cat_mode(argv[2]);
    if (argv[0][0] == '/') self_path = argv[0];
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        const char *v = i + 1 < argc ? argv[i + 1] : NULL;
        if (!v) break;
        if (!strcmp(a, "--scratch")) scratch = v;
        else if (!strcmp(a, "--node-port")) node_port = atoi(v);
        else if (!strcmp(a, "--control")) control_path = v;
        else if (!strcmp(a, "--llm")) llm_path = v;
        else if (!strcmp(a, "--broker-ipc")) broker_ipc_path = v;
        else if (!strcmp(a, "--broker-pid")) broker_pid = atoi(v);
        else if (!strcmp(a, "--listen")) listen_path = v;
        else if (!strcmp(a, "--listen-other")) listen_other = v;
        else if (!strcmp(a, "--egress")) egress = v;
        else if (!strcmp(a, "--victim-stop")) victim_stop = atoi(v);
        else if (!strcmp(a, "--victim-term")) victim_term = atoi(v);
        else if (!strcmp(a, "--victim-kill")) victim_kill = atoi(v);
        else if (!strcmp(a, "--victim-ptrace")) victim_ptrace = atoi(v);
        else if (!strcmp(a, "--read") && nreads < MAXN) reads[nreads++] = strdup(v);
        else if (!strcmp(a, "--write") && nwrites < MAXN) writes[nwrites++] = strdup(v);
        else if (!strcmp(a, "--mach") && nmachs < MAXN) machs[nmachs++] = strdup(v);
        else if (!strcmp(a, "--mode")) confined = !strcmp(v, "confined");
        else { fprintf(stderr, "unknown %s\n", a); return 2; }
        i++;
    }
    if (node_port == 3141) { fprintf(stderr, "refusing port 3141\n"); return 2; }
    printf("# j0probe pid=%d mode=%s\n", getpid(), confined ? "confined" : "baseline");
    test_fds();  // first: before the probe opens anything itself
    test_env();
    test_bootstrap();
    test_reads();
    test_exec();
    test_net();
    test_proc();
    test_victims();
    for (int i = 0; i < nwrites; i++) {
        char *id, *dir;
        split(writes[i], &id, &dir);
        test_write_dir(id, dir, 0);
    }
    if (scratch) test_write_dir("scratch", scratch, 1);
    printf("# j0probe done\n");
    return 0;
}
