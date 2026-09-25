// dummy_broker — disposable stand-in for the node + broker endpoints (J0 spike, mock only).
//
// Listens on:
//   - a TCP port on 127.0.0.1 chosen by the kernel (fake node API port; never 3141)
//   - a unix socket  <control.sock>      (fake node control.sock)
//   - a unix socket  <llm.sock>          (fake LLM runtime socket — positive control)
//   - a unix socket  <broker.sock>       (fake broker IPC socket — positive control)
// Every accepted connection gets "pong <name>\n" and is logged to stdout.
// SIGUSR1 is counted and logged, so the harness can prove whether a signal arrived.
//
// Usage: dummy_broker <statefile> <control.sock> <llm.sock> <broker.sock>
// Writes "pid=<pid>\nport=<port>\n" to <statefile> once listening.

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

int main(int argc, char **argv) {
    if (argc != 5) { fprintf(stderr, "usage: %s state control.sock llm.sock broker.sock\n", argv[0]); return 2; }
    setvbuf(stdout, NULL, _IOLBF, 0);
    signal(SIGUSR1, on_usr1);
    signal(SIGPIPE, SIG_IGN);

    int tcp = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in in = {0};
    in.sin_family = AF_INET;
    in.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    in.sin_port = 0;
    int one = 1;
    setsockopt(tcp, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    if (bind(tcp, (struct sockaddr *)&in, sizeof in) != 0 || listen(tcp, 16) != 0) { perror("tcp"); return 2; }
    socklen_t sl = sizeof in;
    getsockname(tcp, (struct sockaddr *)&in, &sl);
    int port = ntohs(in.sin_port);
    if (port == 3141) { fprintf(stderr, "refusing port 3141\n"); return 3; }

    const char *names[4] = {"node-tcp", "control.sock", "llm.sock", "broker.sock"};
    struct pollfd pf[4] = {
        {tcp, POLLIN, 0},
        {unix_listener(argv[2]), POLLIN, 0},
        {unix_listener(argv[3]), POLLIN, 0},
        {unix_listener(argv[4]), POLLIN, 0},
    };

    FILE *st = fopen(argv[1], "w");
    if (!st) { perror(argv[1]); return 2; }
    fprintf(st, "pid=%d\nport=%d\n", getpid(), port);
    fclose(st);
    printf("LISTEN pid=%d port=%d\n", getpid(), port);

    int last_usr1 = 0;
    for (;;) {
        int r = poll(pf, 4, 200);
        if (usr1_count != last_usr1) { last_usr1 = usr1_count; printf("SIGUSR1 count=%d\n", last_usr1); }
        if (r <= 0) continue;
        for (int k = 0; k < 4; k++) {
            if (!(pf[k].revents & POLLIN)) continue;
            int c = accept(pf[k].fd, NULL, NULL);
            if (c < 0) continue;
            char msg[64];
            int n = snprintf(msg, sizeof msg, "pong %s\n", names[k]);
            (void)!write(c, msg, (size_t)n);
            close(c);
            printf("ACCEPT %s\n", names[k]);
        }
    }
}
