// j0uclient — minimal HTTP/1.1 client over a unix socket, standing in for the confined
// assistant talking to its LLM socket (J0 spike). No TLS, no DNS, no TCP.
//
// Usage: j0uclient <socket> GET <path>
//        j0uclient <socket> POST <path> <json-body>
// Prints the raw HTTP response. Exit 0 on a 2xx status, 1 otherwise.

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
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un a = {0};
    a.sun_family = AF_UNIX;
    strncpy(a.sun_path, argv[1], sizeof a.sun_path - 1);
    if (connect(fd, (struct sockaddr *)&a, sizeof a) != 0) { perror("connect"); return 1; }
    struct timeval tv = {180, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    char req[8192];
    int n = snprintf(req, sizeof req,
                     "%s %s HTTP/1.1\r\nHost: llm\r\nConnection: close\r\nContent-Type: application/json\r\n"
                     "Content-Length: %zu\r\n\r\n%s",
                     argv[2], argv[3], strlen(body), body);
    if (write(fd, req, (size_t)n) != n) { perror("write"); return 1; }
    char buf[4096];
    ssize_t r;
    int first = 1, ok = 0;
    while ((r = read(fd, buf, sizeof buf)) > 0) {
        if (first) { ok = r > 12 && buf[9] == '2'; first = 0; }
        fwrite(buf, 1, (size_t)r, stdout);
    }
    close(fd);
    return ok ? 0 : 1;
}
