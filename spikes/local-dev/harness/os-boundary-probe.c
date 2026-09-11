/* SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial */
/* Test only: run this binary as HARNESS_BINARY under worker.sb on the central Mac.
 * argv: allowed-worker-file, forbidden-central-file, forbidden-write-file.
 * It never reads file contents from the forbidden path; success requires open rejection.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>

int main(int argc, char **argv) {
    if (argc != 4) return 64;
    FILE *allowed = fopen(argv[1], "w+");
    if (!allowed) { perror("allowed worker write"); return 1; }
    fputs("runtime-data", allowed);
    rewind(allowed);
    if (fgetc(allowed) != 'r') return 2;
    fclose(allowed);
    errno = 0;
    FILE *forbidden = fopen(argv[2], "r");
    if (forbidden || (errno != EPERM && errno != EACCES)) {
        if (forbidden) fclose(forbidden);
        fprintf(stderr, "Central read was not denied\n"); return 3;
    }
    errno = 0;
    forbidden = fopen(argv[3], "w");
    if (forbidden || (errno != EPERM && errno != EACCES)) {
        if (forbidden) fclose(forbidden);
        fprintf(stderr, "Central write was not denied\n"); return 4;
    }
    pid_t child = fork();
    if (child < 0) return 5;
    if (child == 0) {
        execl("/bin/sh", "sh", "-c", "exit 0", (char *)0);
        _exit((errno == EPERM || errno == EACCES) ? 77 : 78);
    }
    int status;
    if (waitpid(child, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 77) {
        fprintf(stderr, "Shell execution was not denied\n"); return 6;
    }
    puts("HARNESS_OS_BOUNDARY_OK: worker read/write allowed; central read/write and shell denied");
    return 0;
}
