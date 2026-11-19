/*
 * relay-sbcheck: asks the kernel whether running processes' sandboxes allow a file operation on
 * given paths (src/confine/sbcheck.ts; docs/codex-confinement-design.md §2.2 step 15, §9.1).
 *
 *   relay-sbcheck <operation> <path>... -- <pid>...
 *
 * prints one line per pid: "<pid> <sandboxed> <answer>...", each field 0, 1, or -1:<errno>, from
 * sandbox_check(pid, NULL, 0) (1: the process runs under a sandbox) and, for each path,
 * sandbox_check(pid, operation, SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, path) (0: allowed,
 * 1: denied). sandbox_check is variadic, which is why osascript's JavaScript bridge cannot make this
 * call (it returned -1) and relay builds this helper instead. It only asks; it changes nothing and
 * reports nothing to the system log. Paths must exist: the kernel denies every path it cannot resolve.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

int sandbox_check(pid_t pid, const char *operation, int type, ...);

#define SANDBOX_FILTER_PATH 1
#define SANDBOX_CHECK_NO_REPORT 0x40000000

static const char *const OPERATIONS[] = { "file-write-data", "file-write-create", "file-read-data", NULL };

static void field(int r, int err) {
  if (r < 0) printf(" -1:%d", err);
  else printf(" %d", r ? 1 : 0);
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) {
    puts("relay-sbcheck 1");
    return 0;
  }
  if (argc < 4) {
    fputs("usage: relay-sbcheck <operation> <path>... -- <pid>...\n", stderr);
    return 2;
  }
  const char *op = argv[1];
  int known = 0;
  for (int i = 0; OPERATIONS[i]; i++) if (!strcmp(op, OPERATIONS[i])) known = 1;
  if (!known) {
    fprintf(stderr, "relay-sbcheck: unknown operation %s\n", op);
    return 2;
  }
  int sep = -1;
  for (int i = 2; i < argc; i++) {
    if (!strcmp(argv[i], "--")) {
      sep = i;
      break;
    }
    if (argv[i][0] != '/') {
      fprintf(stderr, "relay-sbcheck: not an absolute path: %s\n", argv[i]);
      return 2;
    }
  }
  if (sep < 3) {
    fputs("relay-sbcheck: no path or no --\n", stderr);
    return 2;
  }
  for (int i = sep + 1; i < argc; i++) {
    char *end = NULL;
    errno = 0;
    long pid = strtol(argv[i], &end, 10);
    if (errno || !end || *end || pid <= 0 || pid > 0x7fffffff) {
      fprintf(stderr, "relay-sbcheck: not a pid: %s\n", argv[i]);
      return 2;
    }
    printf("%ld", pid);
    errno = 0;
    int s = sandbox_check((pid_t)pid, NULL, 0);
    field(s, errno);
    for (int j = 2; j < sep; j++) {
      errno = 0;
      int r = sandbox_check((pid_t)pid, op, SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, argv[j]);
      field(r, errno);
    }
    putchar('\n');
  }
  return fflush(stdout) == 0 ? 0 : 1;
}
