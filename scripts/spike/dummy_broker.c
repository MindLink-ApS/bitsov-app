// dummy_broker — disposable stand-in for the node + broker endpoints (J0 spike, mock only).
//
// Listens on:
//   - TCP 127.0.0.1:P and [::1]:P, P picked at random from 20000-60999 and never 3141
//     (the port is chosen and checked BEFORE bind) — fake node API port
//   - UDP 127.0.0.1:P — counts received datagrams (proves receipt, not just sendto)
//   - optionally TCP <lan-ipv4>:Q — a non-loopback "egress" target on this host's own LAN
//     address; only connections whose peer is that same address get a pong, others are
//     closed immediately
//   - a unix socket  <control.sock>      (fake node control.sock)
//   - a unix socket  <llm.sock>          (fake LLM runtime socket — positive control)
//   - a unix socket  <broker.sock>       (fake broker IPC socket — positive control)
// Every accepted connection gets "pong <name>\n" and is logged to stdout.
// SIGUSR1 is counted and logged, so the harness can prove whether a signal arrived.
//
// Usage: dummy_broker <statefile> <control.sock> <llm.sock> <broker.sock> [lan-ipv4]
//        dummy_broker --victim     (a disposable signal/ptrace target that just waits)
// Writes "pid=<pid>\nport=<port>\negress_port=<q>\n" to <statefile> once listening.

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define NODE_PORT_FORBIDDEN 3141

static volatile sig_atomic_t usr1_count = 0;
static void on_usr1(int s) { (void)s; usr1_count++; }

static int unix_listener(const char *path) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un a = {0};
    a.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof a.sun_path) { fprintf(stderr, "path too long: %s\n", path); exit(2); }
    strcpy(a.sun_path, path);
    unlink(path);
    if (bind(fd, (struct sockaddr *)&a, sizeof a) != 0 || listen(fd, 16) != 0) { perror(path); exit(2); }
    return fd;
}

// Binds family/type on addr:port. Returns fd or -1 (errno set).
static int inet_bind(int family, int type, const char *addr, int port) {
    if (port == NODE_PORT_FORBIDDEN) { errno = EACCES; return -1; }  // checked before bind
    int fd = socket(family, type, 0);
    if (fd < 0) return -1;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_storage ss = {0};
    socklen_t sl;
    if (family == AF_INET) {
        struct sockaddr_in *s = (struct sockaddr_in *)&ss;
        s->sin_family = AF_INET; s->sin_port = htons(port); inet_pton(AF_INET, addr, &s->sin_addr);
        sl = sizeof *s;
    } else {
        struct sockaddr_in6 *s = (struct sockaddr_in6 *)&ss;
        s->sin6_family = AF_INET6; s->sin6_port = htons(port); inet_pton(AF_INET6, addr, &s->sin6_addr);
        setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &one, sizeof one);
        sl = sizeof *s;
    }
    if (bind(fd, (struct sockaddr *)&ss, sl) != 0 || (type == SOCK_STREAM && listen(fd, 16) != 0)) {
        int e = errno; close(fd); errno = e; return -1;
    }
    return fd;
}

static int random_port(void) {
    int p;
    do p = 20000 + (int)arc4random_uniform(41000); while (p == NODE_PORT_FORBIDDEN);
    return p;
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--victim")) { for (;;) pause(); }
    if (argc != 5 && argc != 6) { fprintf(stderr, "usage: %s state control.sock llm.sock broker.sock [lan-ipv4]\n", argv[0]); return 2; }
    setvbuf(stdout, NULL, _IOLBF, 0);
    signal(SIGUSR1, on_usr1);
    signal(SIGPIPE, SIG_IGN);

    int tcp = -1, tcp6 = -1, udp = -1, port = 0;
    for (int tries = 0; tries < 50 && tcp < 0; tries++) {
        port = random_port();
        tcp = inet_bind(AF_INET, SOCK_STREAM, "127.0.0.1", port);
        if (tcp < 0) continue;
        udp = inet_bind(AF_INET, SOCK_DGRAM, "127.0.0.1", port);
        if (udp < 0) { close(tcp); tcp = -1; continue; }
        tcp6 = inet_bind(AF_INET6, SOCK_STREAM, "::1", port);  // optional (no IPv6 loopback = -1)
    }
    if (tcp < 0) { perror("tcp"); return 2; }

    int egress = -1, egress_port = 0;
    const char *lan = argc == 6 ? argv[5] : NULL;
    for (int tries = 0; lan && tries < 50 && egress < 0; tries++) {
        egress_port = random_port();
        egress = inet_bind(AF_INET, SOCK_STREAM, lan, egress_port);
    }
    if (lan && egress < 0) { perror("egress"); egress_port = 0; }

    enum { N = 8 };
    const char *names[N] = {"node-tcp", "node-tcp6", "control.sock", "llm.sock", "broker.sock", "egress", "udp", ""};
    struct pollfd pf[N] = {
        {tcp, POLLIN, 0}, {tcp6, POLLIN, 0},
        {unix_listener(argv[2]), POLLIN, 0}, {unix_listener(argv[3]), POLLIN, 0}, {unix_listener(argv[4]), POLLIN, 0},
        {egress, POLLIN, 0}, {udp, POLLIN, 0}, {-1, 0, 0},
    };

    FILE *st = fopen(argv[1], "w");
    if (!st) { perror(argv[1]); return 2; }
    fprintf(st, "pid=%d\nport=%d\nport6=%d\negress_port=%d\n", getpid(), port, tcp6 >= 0 ? port : 0, egress_port);
    fclose(st);
    printf("LISTEN pid=%d port=%d v6=%d egress_port=%d\n", getpid(), port, tcp6 >= 0, egress_port);

    int last_usr1 = 0;
    for (;;) {
        int r = poll(pf, N, 200);
        if (usr1_count != last_usr1) { last_usr1 = usr1_count; printf("SIGUSR1 count=%d\n", last_usr1); }
        if (r <= 0) continue;
        for (int k = 0; k < N; k++) {
            if (pf[k].fd < 0 || !(pf[k].revents & POLLIN)) continue;
            if (pf[k].fd == udp) {
                char b[64];
                if (recv(udp, b, sizeof b, 0) >= 0) printf("UDP recv\n");
                continue;
            }
            struct sockaddr_storage peer;
            socklen_t pl = sizeof peer;
            int c = accept(pf[k].fd, (struct sockaddr *)&peer, &pl);
            if (c < 0) continue;
            if (pf[k].fd == egress) {  // only this host itself may talk to the LAN listener
                char pa[64] = "";
                inet_ntop(AF_INET, &((struct sockaddr_in *)&peer)->sin_addr, pa, sizeof pa);
                if (strcmp(pa, lan) != 0) { close(c); printf("REJECT egress peer\n"); continue; }
            }
            char msg[64];
            int n = snprintf(msg, sizeof msg, "pong %s\n", names[k]);
            (void)!write(c, msg, (size_t)n);
            close(c);
            printf("ACCEPT %s\n", names[k]);
        }
    }
}
