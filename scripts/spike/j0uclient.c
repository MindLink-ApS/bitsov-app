// j0uclient — minimal HTTP/1.1 client over a unix socket, standing in for the confined
// assistant talking to its LLM socket (J0 spike). No TLS, no DNS, no TCP.
//
// Usage: j0uclient <socket> GET <path>
//        j0uclient <socket> POST <path> <json-body>
// Prints the raw HTTP response. Exit 0 only if the status line is "HTTP/1.x 2xx" and the
// response was read to EOF without error; 1 otherwise; 2 on usage / oversized request.

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 4 || (!strcmp(argv[2], "POST") && argc < 5)) {
        fprintf(stderr, "usage: %s sock GET|POST path [body]\n", argv[0]);
        return 2;
    }
    const char *body = argc > 4 ? argv[4] : "";
    struct sockaddr_un a = {0};
    a.sun_family = AF_UNIX;
    if (strlen(argv[1]) >= sizeof a.sun_path) { fprintf(stderr, "socket path too long\n"); return 2; }
    strcpy(a.sun_path, argv[1]);
    char req[8192];
    int n = snprintf(req, sizeof req,
                     "%s %s HTTP/1.1\r\nHost: llm\r\nConnection: close\r\nContent-Type: application/json\r\n"
                     "Content-Length: %zu\r\n\r\n%s",
                     argv[2], argv[3], strlen(body), body);
    if (n < 0 || (size_t)n >= sizeof req) { fprintf(stderr, "request too large (%d bytes)\n", n); return 2; }
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); return 1; }
    if (connect(fd, (struct sockaddr *)&a, sizeof a) != 0) { perror("connect"); return 1; }
    struct timeval tv = {180, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    for (size_t off = 0; off < (size_t)n;) {
        ssize_t w = write(fd, req + off, (size_t)n - off);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) { perror("write"); return 1; }
        off += (size_t)w;
    }
    char head[16] = {0};
    size_t hl = 0;
    char buf[4096];
    ssize_t r;
    while ((r = read(fd, buf, sizeof buf)) != 0) {
        if (r < 0) { if (errno == EINTR) continue; perror("read"); close(fd); return 1; }
        for (ssize_t k = 0; k < r && hl < sizeof head - 1; k++) head[hl++] = buf[k];
        fwrite(buf, 1, (size_t)r, stdout);
    }
    close(fd);
    // "HTTP/1.1 200" — version prefix, then a 2xx status.
    int ok = hl >= 12 && !strncmp(head, "HTTP/1.", 7) && head[8] == ' ' && head[9] == '2';
    return ok ? 0 : 1;
}
