/* SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial */
/* QA syscall probe. Inputs and files are disposable canaries, never credentials. */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;

int main(void) {
  char *line = NULL;
  size_t capacity = 0;
  while (getline(&line, &capacity, stdin) > 0) {
    line[strcspn(line, "\r\n")] = 0;
    char *state = NULL, *id = strtok_r(line, "\t", &state);
    char *op = strtok_r(NULL, "\t", &state);
    char *a = strtok_r(NULL, "\t", &state), *b = strtok_r(NULL, "\t", &state);
    if (!id || !op || !a || strspn(id, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != strlen(id)) return 2;
    int rc = -1, error = 0;
    errno = 0;
    if (!strcmp(op, "read")) {
      int fd = open(a, O_RDONLY);
      if (fd >= 0) { char bytes[64]; rc = (int)read(fd, bytes, sizeof(bytes)); error = errno; close(fd); }
      else error = errno;
    } else if (!strcmp(op, "write")) {
      int fd = open(a, O_WRONLY | O_CREAT | O_TRUNC, 0600);
      if (fd >= 0) { rc = (int)write(fd, "qa-written\n", 11); error = errno; close(fd); }
      else error = errno;
    } else if (!strcmp(op, "link") && b) { rc = link(a, b); error = errno;
    } else if (!strcmp(op, "symlink") && b) { rc = symlink(a, b); error = errno;
    } else if (!strcmp(op, "exec")) {
      pid_t pid = 0; char *args[] = {a, NULL};
      error = posix_spawn(&pid, a, NULL, NULL, args, environ); rc = error ? -1 : 0;
      if (!error) { int status; waitpid(pid, &status, 0); }
    } else if (!strcmp(op, "mach")) {
      mach_port_t port = MACH_PORT_NULL;
      kern_return_t result = bootstrap_look_up(bootstrap_port, a, &port);
      rc = result == KERN_SUCCESS ? 0 : -1; error = (int)result;
      if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
    } else if (!strcmp(op, "tcp")) {
      int fd = socket(AF_INET, SOCK_STREAM, 0);
      if (fd >= 0) {
        struct sockaddr_in address = {0}; address.sin_len = sizeof(address); address.sin_family = AF_INET;
        address.sin_port = htons((unsigned short)atoi(a)); inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
        rc = connect(fd, (struct sockaddr *)&address, sizeof(address)); error = errno; close(fd);
      } else error = errno;
    } else if (!strcmp(op, "unix")) {
      int fd = socket(AF_UNIX, SOCK_STREAM, 0);
      if (fd >= 0) {
        struct sockaddr_un address = {0}; address.sun_len = sizeof(address); address.sun_family = AF_UNIX;
        if (strlen(a) >= sizeof(address.sun_path)) { close(fd); return 3; }
        strcpy(address.sun_path, a); rc = connect(fd, (struct sockaddr *)&address, sizeof(address)); error = errno; close(fd);
      } else error = errno;
    } else if (!strcmp(op, "env")) { rc = getenv(a) == NULL ? -1 : 0;
    } else { free(line); return 4; }
    printf("{\"id\":\"%s\",\"rc\":%d,\"error\":%d}\n", id, rc, error);
    fflush(stdout);
  }
  free(line);
  return ferror(stdin) ? 5 : 0;
}
