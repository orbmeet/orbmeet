#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sched.h>
#include <sys/utsname.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/*
 * cellrun runs one code cell, start to finish, inside the board's container.
 *
 *   cellrun <slot> <language> <compile-ms> <run-ms> <stream-bytes>   < source
 *   cellrun --probe
 *
 * The Durable Object starts it with one `exec()` per run and reads one report
 * back from its stdout. Everything with a deadline or a process tree lives
 * here, on the same side of the container boundary as the processes it
 * governs, so nothing has to be stopped by signalling a pid from outside.
 *
 * Isolation between the runs on a board is by slot. A board runs at most
 * CELLRUN_SLOTS cells at once and each slot has:
 *
 *   - its own uid (CELLRUN_UID_BASE + slot), so concurrent runs cannot read,
 *     signal or trace each other, and per-uid limits are per run;
 *   - one fixed directory, /cells/<slot>, mode 0700, that is the only place
 *     the run may write;
 *   - a lock, so two supervisors never share a slot even when the Durable
 *     Object that started one of them is gone.
 *
 * A slot is reset before every run and again after it: every process of the
 * slot's uid is killed, then the directory is removed and recreated empty.
 * Killing by uid rather than by process group is what makes the reset total —
 * a uid cannot be left, while a process group can — and because nothing of
 * the slot's uid is alive afterwards, root's removal of the directory races
 * no one. Root never touches a path the run could have changed while the run
 * could still change it.
 *
 * Where a run may write rests on file permissions first: a slot's uid owns
 * nothing but its own directory, and cellrun removes write-for-others from
 * every writable mount the runtime adds (a fresh /tmp, /dev/shm, /dev/mqueue)
 * before each run, refusing to run if any is left. Landlock confines writes to
 * the run directory as a second layer where the kernel has it; Cloudflare's
 * does not. Seccomp, which refuses sockets, persistent IPC and keyrings, is
 * required: without it cellrun runs nothing.
 *
 * `--probe` reports what the kernel provides — Landlock, seccomp, user
 * namespaces — and what cellrun had to close, for the runner's logs.
 *
 * The report is a sequence of records, `<key> <length>\n<bytes>\n`, opened by
 * `cellrun 1\n` and closed by an `end` record, so a report cut short is
 * detectably incomplete. The exit status says whether the container is
 * still fit for use:
 *
 *   0   a report was written (whatever the snippet did)
 *   64  the arguments or the source were invalid: a runner bug
 *   69  this kernel or runtime cannot enforce the jail; replacing the
 *       container will not help
 *   70  the slot could not be reset or a phase could not be stopped; the
 *       container's state is in doubt and it should be replaced
 *   75  the slot is still held by another supervisor
 */

#ifndef CELLRUN_SLOTS
#define CELLRUN_SLOTS 3
#endif
#ifndef CELLRUN_UID_BASE
#define CELLRUN_UID_BASE 2000
#endif

#define CELLS_ROOT "/cells"
#define LOCK_ROOT "/run/cellrun"
#define GO_CACHE_TEMPLATE "/var/cache/cellrun/go-build"

#define EXIT_REPORTED 0
#define EXIT_USAGE 64
#define EXIT_JAIL_UNAVAILABLE 69
#define EXIT_REPLACE_CONTAINER 70
#define EXIT_SLOT_BUSY 75

/* Ample for MAX_CODE_CHARS of any script; the contract enforces the real bound. */
#define MAX_SOURCE_BYTES (1 << 20)
/* Per file, not per run: the disk floor below is the bound on the total. */
#define FILE_SIZE_LIMIT (64L << 20)
#define PROCESS_LIMIT 256

/* How long a new run waits for a slot a previous supervisor still holds. */
#define LOCK_WAIT_MS 5000
/* After a phase is stopped, how long its output pipes get to reach EOF. */
#define DRAIN_GRACE_MS 2000
/* How long killing a slot's processes may take before the container is suspect. */
#define SWEEP_LIMIT_MS 5000
#define DISK_CHECK_MS 250
/*
 * The disk a board must keep free. Every run on the board shares one disk, and
 * a run that fills it would fail everyone's setup until the container restarts,
 * so a phase is stopped while there is still room to clean up after it.
 */
#define DEFAULT_DISK_RESERVE_BYTES (1ULL << 30)
#define DISK_RESERVE_INODES 20000

/*
 * The environment every phase starts from. Built rather than inherited, so the
 * snippet sees nothing of the container's own environment. PATH, RUSTUP_HOME
 * and CARGO_HOME must match the image's toolchain layout.
 */
#define TOOLCHAIN_PATH \
  "PATH=/usr/local/cargo/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin"

struct language {
  const char *name;
  const char *source;
  const char *const *compile; /* NULL when the language is interpreted. */
  const char *const *run;
  int go_cache;
};

#define ARGV(...) ((const char *const[]){__VA_ARGS__, NULL})

static const struct language LANGUAGES[] = {
  /* `-u` so a program killed at its deadline still shows what it printed. */
  {"python", "main.py", NULL, ARGV("python3", "-u", "main.py"), 0},
  {"javascript", "main.js", NULL, ARGV("node", "main.js"), 0},
  /*
   * Node runs TypeScript directly: it strips the types without checking them,
   * and refuses syntax that would need transforming (enum, namespace,
   * parameter properties) with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
   */
  {"typescript", "main.ts", NULL, ARGV("node", "main.ts"), 0},
  /*
   * The JVM ignores TMPDIR, alone among these runtimes, so its temp directory
   * is set here; JAVA_TOOL_OPTIONS would announce itself on stderr.
   */
  {"java", "Main.java", ARGV("javac", "Main.java"),
   ARGV("java", "-Djava.io.tmpdir=.", "-cp", ".", "Main"), 0},
  /*
   * `-Wall` because C and C++ are the only languages here that say nothing
   * about an uninitialised read unless asked. `-lm` because a link error on
   * <math.h> is the commonest way a first C snippet fails for no good reason.
   */
  {"c", "main.c", ARGV("gcc", "-O2", "-Wall", "-std=c17", "-o", "main", "main.c", "-lm"),
   ARGV("./main"), 0},
  {"cpp", "main.cpp", ARGV("g++", "-O2", "-Wall", "-std=c++20", "-o", "main", "main.cpp"),
   ARGV("./main"), 0},
  /* `go build` rather than `go run`, which would fold diagnostics into the run. */
  {"go", "main.go", ARGV("go", "build", "-o", "main", "main.go"), ARGV("./main"), 1},
  /* `rustc` directly: one file, no manifest, no registry to reach. */
  {"rust", "main.rs", ARGV("rustc", "-O", "-o", "main", "main.rs"), ARGV("./main"), 0},
};

struct slot {
  int index;
  uid_t uid;
  gid_t gid;
  char dir[64];
  char home[96];
  char go_cache[128];
};

struct capture {
  int fd;
  char *data;
  size_t length;
  size_t limit;
  int truncated;
};

struct phase {
  const char *name;
  const char *ended; /* "exit", "killed", "timeout", "disk" or "stopped" */
  int exit_code;
  long elapsed_ms;
  struct capture out;
  struct capture err;
};

/* The phase whose exit status is wanted; every other child is only reaped. */
static pid_t tracked_pid = -1;
static int tracked_status;
static int tracked_exited;
static int stop_requested;
static int signal_fd = -1;
/*
 * In a phase's child, before exec: where a setup failure is reported. It is
 * close-on-exec, so the parent reads EOF exactly when the exec succeeded, and
 * a jail that could not be applied is told apart from a program that failed.
 */
static int setup_status_fd = -1;

static void die(const char *what, int code) {
  fprintf(stderr, "cellrun: %s: %s\n", what, strerror(errno));
  exit(code);
}

static long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

static long parse_number(const char *text, long min, long max) {
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < min || value > max) {
    fprintf(stderr, "cellrun: invalid number: %s\n", text);
    exit(EXIT_USAGE);
  }
  return value;
}

static void reap(void) {
  for (;;) {
    int status = 0;
    pid_t pid = waitpid(-1, &status, WNOHANG);
    if (pid <= 0) return;
    if (pid == tracked_pid) {
      tracked_status = status;
      tracked_exited = 1;
    }
  }
}

/* Drains the signal fd: SIGCHLD reaps, and any stop signal is remembered. */
static void take_signals(void) {
  struct signalfd_siginfo info;
  while (read(signal_fd, &info, sizeof(info)) == sizeof(info)) {
    if (info.ssi_signo == SIGCHLD) reap();
    else stop_requested = 1;
  }
}

static void wait_child(pid_t pid, int *status) {
  while (waitpid(pid, status, 0) < 0 && errno == EINTR) {
  }
}

/* Drops to the slot's uid for good: every capability goes with root. */
static int become(const struct slot *slot) {
  return setgroups(0, NULL) == 0 && setresgid(slot->gid, slot->gid, slot->gid) == 0
         && setresuid(slot->uid, slot->uid, slot->uid) == 0 ? 0 : -1;
}

static void restore_signals(void) {
  sigset_t none;
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, NULL);
  signal(SIGPIPE, SIG_DFL);
}

/*
 * SIGKILLs every process of the slot's uid. Sent from a child that has become
 * that uid, so the kernel's own permission check scopes `kill(-1)` to exactly
 * the slot: an unprivileged sender reaches only processes of its own uid, and
 * dropping to it cleared every capability that could reach further.
 *
 * kill(-1)'s result cannot say whether anything was signalled — it counts the
 * processes it had no permission for too — so `slot_alive` is what decides.
 */
static int signal_slot(const struct slot *slot) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    if (become(slot) != 0) _exit(1);
    kill(-1, SIGKILL);
    _exit(0);
  }
  int status = 0;
  wait_child(pid, &status);
  return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
}

/* Whether any process of the slot's uid is still alive. Zombies hold nothing. */
static int slot_alive(const struct slot *slot) {
  DIR *proc = opendir("/proc");
  if (!proc) return 1;
  int alive = 0;
  struct dirent *entry;
  while (!alive && (entry = readdir(proc)) != NULL) {
    if (entry->d_name[0] < '1' || entry->d_name[0] > '9') continue;
    char path[300];
    snprintf(path, sizeof(path), "/proc/%s/status", entry->d_name);
    FILE *status = fopen(path, "re");
    if (!status) continue; /* Exited while we looked. */
    char line[256], state = '?';
    long uid = -1;
    while (fgets(line, sizeof(line), status)) {
      if (strncmp(line, "State:", 6) == 0) sscanf(line + 6, " %c", &state);
      else if (strncmp(line, "Uid:", 4) == 0) sscanf(line + 4, " %ld", &uid);
    }
    fclose(status);
    alive = uid == (long)slot->uid && state != 'Z' && state != 'X';
  }
  closedir(proc);
  return alive;
}

/*
 * Kills everything the slot's uid is running and waits until none of it is
 * left. Repeated, because a process can fork between one kill and the next;
 * cellrun is the subreaper of everything its phases start, so it reaps as it
 * goes.
 */
static int sweep(const struct slot *slot) {
  long deadline = now_ms() + SWEEP_LIMIT_MS;
  for (;;) {
    if (signal_slot(slot) != 0) return -1;
    reap();
    if (!slot_alive(slot)) return 0;
    if (now_ms() >= deadline) return -1;
    struct timespec pause = {0, 2 * 1000 * 1000};
    nanosleep(&pause, NULL);
  }
}

/* Runs a fixed helper command; `as_slot` drops to the slot's uid first. */
static int run_helper(const struct slot *slot, int as_slot, const char *const *argv) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    restore_signals();
    int null_fd = open("/dev/null", O_RDWR);
    if (null_fd >= 0) {
      dup2(null_fd, STDIN_FILENO);
      dup2(null_fd, STDOUT_FILENO);
    }
    if (as_slot) {
      if (become(slot) != 0) _exit(126);
      umask(077);
    }
    execv(argv[0], (char *const *)argv);
    _exit(127);
  }
  int status = 0;
  wait_child(pid, &status);
  return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
}

/*
 * Creates one of cellrun's own root directories if it is missing, and checks
 * it is what it must be. Here rather than in the image, because a container
 * runtime may mount a fresh, empty /run over the image's (Cloudflare's does).
 *
 * /cells is 0711: a run can enter its own slot's directory but cannot list its
 * neighbours or create anything beside its own. /run/cellrun holds the slot
 * locks and is root's alone.
 */
static int ensure_root_dir(const char *path, mode_t mode) {
  if (mkdir(path, mode) != 0 && errno != EEXIST) return -1;
  struct stat info;
  if (lstat(path, &info) != 0) return -1;
  if (!S_ISDIR(info.st_mode) || info.st_uid != 0 || info.st_gid != 0) {
    errno = ENOTDIR;
    return -1;
  }
  return (info.st_mode & 07777) == mode ? 0 : chmod(path, mode);
}

/* Waits for the slot's lock, giving up after LOCK_WAIT_MS or on a stop. */
static int lock_slot(const struct slot *slot) {
  char path[64];
  snprintf(path, sizeof(path), LOCK_ROOT "/slot-%d.lock", slot->index);
  int fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) die("open slot lock", EXIT_REPLACE_CONTAINER);
  long deadline = now_ms() + LOCK_WAIT_MS;
  while (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    if (errno != EWOULDBLOCK) die("lock slot", EXIT_REPLACE_CONTAINER);
    if (stop_requested || now_ms() >= deadline) return -1;
    struct pollfd wait = {signal_fd, POLLIN, 0};
    if (poll(&wait, 1, 20) > 0) take_signals();
  }
  return fd;
}

/* Leaves the slot with no process of its uid and no directory. */
static int clear_slot(const struct slot *slot) {
  if (sweep(slot) != 0) {
    fprintf(stderr, "cellrun: slot %d: processes survived SIGKILL\n", slot->index);
    return -1;
  }
  struct stat existing;
  if (lstat(slot->dir, &existing) == 0) {
    const char *const rm[] = {"/bin/rm", "-rf", "--one-file-system", "--", slot->dir, NULL};
    if (run_helper(slot, 0, rm) != 0) {
      fprintf(stderr, "cellrun: slot %d: could not remove %s\n", slot->index, slot->dir);
      return -1;
    }
  }
  return 0;
}

/* Leaves the slot ready for a run: cleared, with a fresh, empty directory. */
static int reset_slot(const struct slot *slot) {
  if (clear_slot(slot) != 0) return -1;
  if (mkdir(slot->dir, 0700) != 0 || chown(slot->dir, slot->uid, slot->gid) != 0) {
    fprintf(stderr, "cellrun: slot %d: create %s: %s\n", slot->index, slot->dir, strerror(errno));
    return -1;
  }
  return 0;
}

static int make_slot_dir(const struct slot *slot, const char *path) {
  return mkdir(path, 0700) == 0 && chown(path, slot->uid, slot->gid) == 0 ? 0 : -1;
}

/*
 * Writes the source and the run's home into the freshly reset directory.
 * Nothing of the slot's uid has run since the reset, so these root-side
 * writes cannot meet anything a snippet left behind; O_EXCL|O_NOFOLLOW says so
 * explicitly for the one file whose name is predictable.
 */
static int prepare_run(const struct slot *slot, const struct language *language) {
  char path[128];
  snprintf(path, sizeof(path), "%s/%s", slot->dir, language->source);
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) die("create source file", EXIT_REPLACE_CONTAINER);
  size_t total = 0;
  char buffer[65536];
  for (;;) {
    ssize_t n = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) die("read source", EXIT_USAGE);
    if (n == 0) break;
    total += (size_t)n;
    if (total > MAX_SOURCE_BYTES) {
      fprintf(stderr, "cellrun: source exceeds %d bytes\n", MAX_SOURCE_BYTES);
      exit(EXIT_USAGE);
    }
    for (ssize_t written = 0; written < n;) {
      ssize_t w = write(fd, buffer + written, (size_t)(n - written));
      if (w < 0 && errno == EINTR) continue;
      if (w < 0) die("write source", EXIT_REPLACE_CONTAINER);
      written += w;
    }
  }
  if (fchown(fd, slot->uid, slot->gid) != 0 || close(fd) != 0) {
    die("finish source file", EXIT_REPLACE_CONTAINER);
  }

  if (make_slot_dir(slot, slot->home) != 0) return -1;
  if (language->go_cache) {
    /*
     * Go must write to its build cache even to read it, so each run gets a
     * private copy of the image's warmed, immutable template. Copied as the
     * slot's uid, so the copy is the run's own and the template stays as is.
     */
    char cache_parent[112];
    snprintf(cache_parent, sizeof(cache_parent), "%s/.cache", slot->home);
    if (make_slot_dir(slot, cache_parent) != 0) return -1;
    const char *const cp[] = {"/bin/cp", "-R", "--no-preserve=mode,ownership",
                              GO_CACHE_TEMPLATE, slot->go_cache, NULL};
    if (run_helper(slot, 1, cp) != 0) {
      fprintf(stderr, "cellrun: slot %d: could not copy the Go cache\n", slot->index);
      return -1;
    }
  }
  return 0;
}

#ifndef LANDLOCK_ACCESS_NET_CONNECT_TCP
#define LANDLOCK_ACCESS_NET_CONNECT_TCP (1ULL << 0)
#endif
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

/*
 * Declared here because the base image's header may predate the network field.
 * Landlock's structs are append-only and the kernel accepts trailing zeroes,
 * so this layout is valid on every ABI; the version probe decides what to set.
 */
struct cellrun_ruleset_attr {
  __u64 handled_access_fs;
  __u64 handled_access_net;
};

static void jail_fail(const char *what) {
  char message[256];
  int length = snprintf(message, sizeof(message), "%s: %s", what, strerror(errno));
  if (length > 0 && write(setup_status_fd, message, (size_t)length) < 0) {
    /* Nothing left to report through; the parent sees a bare failure. */
  }
  _exit(EXIT_REPLACE_CONTAINER);
}

/*
 * Where the kernel has Landlock: filesystem mutation is allowed beneath the run
 * directory only, plus writing to /dev/null, which ordinary programs and
 * toolchains open for discarding output. Reading and executing the image stay
 * available.
 */
static int landlock_abi(void) {
  return (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
}

static void confine_filesystem(const struct slot *slot) {
  int abi = landlock_abi();
  /* No Landlock in this kernel: file permissions alone confine writes (see top). */
  if (abi < 1) return;

  __u64 writes = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR
                 | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR
                 | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG
                 | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO
                 | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM;
  __u64 truncate = 0;
  if (abi >= 2) writes |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) truncate = LANDLOCK_ACCESS_FS_TRUNCATE;
  writes |= truncate;

  /* Defence in depth over seccomp's socket refusal, where the kernel has it. */
  struct cellrun_ruleset_attr attr = {
    .handled_access_fs = writes,
    .handled_access_net = abi >= 4 ? LANDLOCK_ACCESS_NET_CONNECT_TCP : 0,
  };
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (ruleset < 0) jail_fail("create Landlock ruleset");

  int dir = open(slot->dir, O_PATH | O_CLOEXEC | O_DIRECTORY);
  if (dir < 0) jail_fail("open run directory");
  struct landlock_path_beneath_attr beneath = {.allowed_access = writes, .parent_fd = dir};
  if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &beneath, 0) != 0) {
    jail_fail("allow the run directory");
  }
  close(dir);

  int null_fd = open("/dev/null", O_PATH | O_CLOEXEC);
  if (null_fd < 0) jail_fail("open /dev/null");
  struct landlock_path_beneath_attr devnull = {
    .allowed_access = LANDLOCK_ACCESS_FS_WRITE_FILE | truncate,
    .parent_fd = null_fd,
  };
  if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &devnull, 0) != 0) {
    jail_fail("allow /dev/null");
  }
  close(null_fd);

  if (syscall(SYS_landlock_restrict_self, ruleset, 0) != 0) jail_fail("enforce Landlock");
  close(ruleset);
}

#if !defined(__x86_64__)
#error "cellrun's seccomp policy is written for x86_64 syscall numbers"
#endif

#define DENY(err) BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ((err) & SECCOMP_RET_DATA))

/* The namespace flags a clone(2) may not carry: any of them makes a new namespace. */
#define CLONE_NEW_ANY (CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER \
                       | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWTIME)

/*
 * What a snippet may not call, and the errno it is answered with.
 *
 * No sockets at all: socket(2) is refused for every family, and socketpair(2)
 * is allowed for AF_UNIX only (below), which is how runtimes plumb their own
 * child processes. A snippet needs no network, and a family-by-family
 * denylist is one new family away from being wrong. io_uring is refused
 * because its socket and connect operations would never pass through this
 * filter.
 *
 * Kernel objects that outlive their creator are a way to leave something for
 * a later run of the same slot: SysV IPC and POSIX message queues, and the
 * uid's keyrings, which persist after its last process and which no sweep or
 * directory removal touches.
 *
 * And the kernel's own attack surface, which no snippet needs: the classes a
 * container runtime's default profile keeps from unprivileged code. New
 * namespaces above all (unshare, setns, and clone with a CLONE_NEW* flag,
 * below): an unprivileged user namespace hands its creator every capability
 * inside it, which turns the mount API, bpf and much of the kernel from
 * refused into reachable. With them the mount API itself, bpf,
 * perf_event_open, userfaultfd, kernel modules and kexec, and opening files by
 * handle. clone3 passes its flags in memory a filter cannot read, so it is
 * answered ENOSYS, as an older kernel would: glibc and the Go runtime then use
 * clone, whose flags the filter reads.
 *
 * Every other refusal is EACCES, an answer the runtime's own profile never
 * gives (it says EPERM), so a refusal can be told to be cellrun's.
 */
struct denial {
  int nr;
  int err;
};

static const struct denial DENIED[] = {
  {__NR_socket, EACCES},
  {__NR_io_uring_setup, EACCES},
  {__NR_io_uring_enter, EACCES},
  {__NR_io_uring_register, EACCES},
  {__NR_shmget, EACCES},
  {__NR_msgget, EACCES},
  {__NR_semget, EACCES},
  {__NR_mq_open, EACCES},
  {__NR_add_key, EACCES},
  {__NR_request_key, EACCES},
  {__NR_keyctl, EACCES},
  {__NR_unshare, EACCES},
  {__NR_setns, EACCES},
  {__NR_clone3, ENOSYS},
  {__NR_mount, EACCES},
  {__NR_umount2, EACCES},
  {__NR_pivot_root, EACCES},
  {__NR_chroot, EACCES},
  {__NR_open_tree, EACCES},
  {__NR_move_mount, EACCES},
  {__NR_fsopen, EACCES},
  {__NR_fsconfig, EACCES},
  {__NR_fsmount, EACCES},
  {__NR_fspick, EACCES},
  {__NR_mount_setattr, EACCES},
  {__NR_bpf, EACCES},
  {__NR_perf_event_open, EACCES},
  {__NR_userfaultfd, EACCES},
  {__NR_init_module, EACCES},
  {__NR_finit_module, EACCES},
  {__NR_delete_module, EACCES},
  {__NR_kexec_load, EACCES},
  {__NR_kexec_file_load, EACCES},
  {__NR_name_to_handle_at, EACCES},
  {__NR_open_by_handle_at, EACCES},
};

#define DENIED_COUNT (sizeof(DENIED) / sizeof(DENIED[0]))
/* Six for the ABI checks, two per denial, five for clone, four for socketpair, one to allow. */
#define FILTER_LENGTH (6 + 2 * DENIED_COUNT + 5 + 4 + 1)

/*
 * The architecture check is part of the boundary: syscall numbers are per
 * ABI, so a call from another ABI is killed, and x32's tagged numbers refused.
 */
static void confine_syscalls(void) {
  struct sock_filter filter[FILTER_LENGTH];
  size_t length = 0;
#define EMIT(instruction)                                \
  do {                                                   \
    if (length == FILTER_LENGTH) {                       \
      errno = EINVAL;                                    \
      jail_fail("assemble seccomp filter");              \
    }                                                    \
    filter[length++] = (struct sock_filter)instruction;  \
  } while (0)
  EMIT(BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)));
  EMIT(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0));
  EMIT(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));
  EMIT(BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)));
  EMIT(BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000 /* __X32_SYSCALL_BIT */, 0, 1));
  EMIT(DENY(EACCES));
  for (size_t i = 0; i < DENIED_COUNT; i++) {
    EMIT(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned)DENIED[i].nr, 0, 1));
    EMIT(DENY(DENIED[i].err));
  }
  /* clone: refused only with a namespace flag; a thread or a process is fine. */
  EMIT(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4));
  EMIT(BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])));
  EMIT(BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_NEW_ANY, 0, 1));
  EMIT(DENY(EACCES));
  EMIT(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
  /* socketpair: AF_UNIX only; anything else falls through to the allow below. */
  EMIT(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socketpair, 0, 3));
  EMIT(BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])));
  EMIT(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0));
  EMIT(DENY(EACCES));
  EMIT(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
#undef EMIT
  if (length != FILTER_LENGTH) {
    errno = EINVAL;
    jail_fail("assemble seccomp filter");
  }
  struct sock_fprog program = {
    .len = (unsigned short)length,
    .filter = filter,
  };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0, 0) != 0) {
    jail_fail("install seccomp filter");
  }
}

static void set_limit(int resource, rlim_t value) {
  struct rlimit limit = {value, value};
  if (setrlimit(resource, &limit) != 0) jail_fail("setrlimit");
}

/* The child side of a phase: enter the slot, confine, exec. Never returns. */
static void exec_phase(const struct slot *slot, const struct language *language,
                       const char *const *argv, int out, int err) {
  restore_signals();
  if (dup2(out, STDOUT_FILENO) < 0 || dup2(err, STDERR_FILENO) < 0) jail_fail("redirect output");
  int null_fd = open("/dev/null", O_RDONLY);
  if (null_fd < 0 || dup2(null_fd, STDIN_FILENO) < 0) jail_fail("close stdin");
  if (chdir(slot->dir) != 0) jail_fail("enter run directory");

  /*
   * Address space is deliberately unlimited: the JVM and the Go runtime reserve
   * large ranges up front and die under RLIMIT_AS. The container's memory is
   * the bound there. These cap what a cgroup does not: one enormous file, a
   * fork bomb (per uid, so per slot), and core dumps.
   */
  set_limit(RLIMIT_FSIZE, FILE_SIZE_LIMIT);
  set_limit(RLIMIT_NPROC, PROCESS_LIMIT);
  set_limit(RLIMIT_CORE, 0);

  if (become(slot) != 0) jail_fail("drop to the slot's uid");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) jail_fail("no_new_privs");
  confine_filesystem(slot);
  confine_syscalls();

  char home[128], tmpdir[96], cache[128], config[128], gopath[128], gocache[160];
  snprintf(home, sizeof(home), "HOME=%s", slot->home);
  snprintf(tmpdir, sizeof(tmpdir), "TMPDIR=%s", slot->dir);
  snprintf(cache, sizeof(cache), "XDG_CACHE_HOME=%s/.cache", slot->home);
  snprintf(config, sizeof(config), "XDG_CONFIG_HOME=%s/.config", slot->home);
  snprintf(gopath, sizeof(gopath), "GOPATH=%s/go", slot->home);
  snprintf(gocache, sizeof(gocache), "GOCACHE=%s", slot->go_cache);
  char *environment[] = {
    TOOLCHAIN_PATH,
    "RUSTUP_HOME=/usr/local/rustup",
    "CARGO_HOME=/usr/local/cargo",
    "LANG=C.UTF-8",
    "GOTOOLCHAIN=local",
    "GOTELEMETRY=off",
    home, tmpdir, cache, config, gopath,
    /* Last, so a language without the cache simply ends the list here. */
    language->go_cache ? gocache : NULL,
    NULL,
  };
  environ = environment;
  execvp(argv[0], (char *const *)argv);
  jail_fail(argv[0]);
}

static void capture_init(struct capture *capture, int fd, size_t limit) {
  capture->fd = fd;
  capture->limit = limit;
  capture->length = 0;
  capture->truncated = 0;
  capture->data = malloc(limit > 0 ? limit : 1);
  if (!capture->data) die("allocate output buffer", EXIT_REPLACE_CONTAINER);
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
}

/*
 * Keeps the first `limit` bytes and reads the rest to nowhere: a pipe nobody
 * drains blocks its writer, which would turn "printed too much" into "timed out".
 */
static void capture_read(struct capture *capture) {
  char discard[65536];
  for (;;) {
    size_t room = capture->limit - capture->length;
    char *target = room > 0 ? capture->data + capture->length : discard;
    size_t size = room > 0 ? room : sizeof(discard);
    ssize_t n = read(capture->fd, target, size);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) return; /* EAGAIN: nothing more for now. */
    if (n == 0) {
      close(capture->fd);
      capture->fd = -1;
      return;
    }
    if (room > 0) capture->length += (size_t)n;
    else capture->truncated = 1;
  }
}

static void capture_close(struct capture *capture) {
  if (capture->fd >= 0) close(capture->fd);
  capture->fd = -1;
}

/* Cuts a truncated capture back to a whole UTF-8 character. */
static void capture_finish(struct capture *capture) {
  if (!capture->truncated) return;
  const unsigned char *bytes = (const unsigned char *)capture->data;
  size_t end = capture->length, start = end;
  while (start > 0 && end - start < 4 && (bytes[start - 1] & 0xC0) == 0x80) start--;
  if (start == 0) return;
  unsigned char lead = bytes[start - 1];
  size_t width = lead < 0x80 ? 1 : (lead & 0xE0) == 0xC0 ? 2 : (lead & 0xF0) == 0xE0 ? 3
               : (lead & 0xF8) == 0xF0 ? 4 : 1;
  if (end - (start - 1) < width) capture->length = start - 1;
}

static int disk_low(void) {
  static unsigned long long reserve;
  if (!reserve) {
    const char *configured = getenv("CELLRUN_DISK_RESERVE_BYTES");
    reserve = configured ? strtoull(configured, NULL, 10) : DEFAULT_DISK_RESERVE_BYTES;
    if (!reserve) reserve = DEFAULT_DISK_RESERVE_BYTES;
  }
  struct statvfs fs;
  if (statvfs(CELLS_ROOT, &fs) != 0) return 0;
  if ((unsigned long long)fs.f_bavail * fs.f_frsize < reserve) return 1;
  return fs.f_files > 0 && fs.f_favail < DISK_RESERVE_INODES;
}

/*
 * Runs one phase to its end and fills `phase`. Returns -1 only when the phase
 * could not be stopped, which leaves the container in doubt.
 */
static int run_phase(const struct slot *slot, const struct language *language,
                     const char *const *argv, long budget_ms, size_t stream_bytes,
                     struct phase *phase) {
  int out[2], err[2], status[2];
  if (pipe2(out, O_CLOEXEC) != 0 || pipe2(err, O_CLOEXEC) != 0 || pipe2(status, O_CLOEXEC) != 0) {
    die("pipe", EXIT_REPLACE_CONTAINER);
  }

  long started = now_ms();
  tracked_exited = 0;
  tracked_pid = fork();
  if (tracked_pid < 0) die("fork", EXIT_REPLACE_CONTAINER);
  if (tracked_pid == 0) {
    setup_status_fd = status[1];
    exec_phase(slot, language, argv, out[1], err[1]);
  }
  close(out[1]);
  close(err[1]);
  close(status[1]);
  char setup_error[256];
  ssize_t setup_length;
  while ((setup_length = read(status[0], setup_error, sizeof(setup_error) - 1)) < 0 && errno == EINTR) {
  }
  close(status[0]);
  if (setup_length != 0) {
    setup_error[setup_length > 0 ? setup_length : 0] = '\0';
    fprintf(stderr, "cellrun: %s phase could not start: %s\n", phase->name, setup_error);
    sweep(slot);
    return -1;
  }
  capture_init(&phase->out, out[0], stream_bytes);
  capture_init(&phase->err, err[0], stream_bytes);
  phase->ended = NULL;

  long deadline = started + budget_ms;
  long drain_deadline = 0;
  long next_disk_check = started + DISK_CHECK_MS;

  for (;;) {
    long now = now_ms();
    /* The phase is over once it has been stopped, or once its main process exited. */
    if (!phase->ended) {
      if (stop_requested) phase->ended = "stopped";
      else if (tracked_exited) phase->ended = "exit";
      else if (now >= deadline) phase->ended = "timeout";
      else if (now >= next_disk_check) {
        if (disk_low()) phase->ended = "disk";
        next_disk_check = now + DISK_CHECK_MS;
      }
      if (phase->ended) {
        /* Background processes too: nothing of the phase outlives it. */
        if (sweep(slot) != 0) return -1;
        drain_deadline = now_ms() + DRAIN_GRACE_MS;
      }
    }
    if (phase->ended && tracked_exited && phase->out.fd < 0 && phase->err.fd < 0) break;
    if (phase->ended && now_ms() >= drain_deadline) {
      /* Every process of the uid is gone, so whatever still holds a pipe is not ours to wait for. */
      capture_close(&phase->out);
      capture_close(&phase->err);
      if (!tracked_exited) return -1;
      break;
    }

    long wake = phase->ended ? drain_deadline : (deadline < next_disk_check ? deadline : next_disk_check);
    long timeout = wake - now_ms();
    if (timeout < 0) timeout = 0;
    struct pollfd fds[3] = {
      {signal_fd, POLLIN, 0},
      {phase->out.fd, POLLIN, 0},
      {phase->err.fd, POLLIN, 0},
    };
    int ready = poll(fds, 3, (int)timeout);
    if (ready < 0 && errno != EINTR) die("poll", EXIT_REPLACE_CONTAINER);
    if (ready <= 0) continue;
    if (fds[0].revents) take_signals();
    if (fds[1].revents && phase->out.fd >= 0) capture_read(&phase->out);
    if (fds[2].revents && phase->err.fd >= 0) capture_read(&phase->err);
  }

  phase->elapsed_ms = now_ms() - started;
  phase->exit_code = WIFEXITED(tracked_status) ? WEXITSTATUS(tracked_status)
                   : WIFSIGNALED(tracked_status) ? 128 + WTERMSIG(tracked_status) : 1;
  /*
   * A SIGKILL cellrun did not send. Nothing else of another uid can signal a
   * slot's processes, so in practice this is the kernel's OOM killer: the
   * board's runs share one container's memory.
   */
  if (strcmp(phase->ended, "exit") == 0 && WIFSIGNALED(tracked_status)
      && WTERMSIG(tracked_status) == SIGKILL) {
    phase->ended = "killed";
  }
  tracked_pid = -1;
  capture_finish(&phase->out);
  capture_finish(&phase->err);
  return 0;
}

static void put(FILE *report, const char *key, const void *data, size_t length) {
  fprintf(report, "%s %zu\n", key, length);
  fwrite(data, 1, length, report);
  fputc('\n', report);
}

static void put_text(FILE *report, const char *phase, const char *field, const char *text) {
  char key[32];
  snprintf(key, sizeof(key), "%s.%s", phase, field);
  put(report, key, text, strlen(text));
}

static void put_number(FILE *report, const char *phase, const char *field, long value) {
  char text[32];
  snprintf(text, sizeof(text), "%ld", value);
  put_text(report, phase, field, text);
}

static void write_report(const struct phase *phases, int count) {
  FILE *report = fdopen(STDOUT_FILENO, "w");
  if (!report) return;
  fputs("cellrun 1\n", report);
  for (int i = 0; i < count; i++) {
    const struct phase *phase = &phases[i];
    char key[32];
    put_text(report, phase->name, "ended", phase->ended);
    put_number(report, phase->name, "exit", phase->exit_code);
    put_number(report, phase->name, "ms", phase->elapsed_ms);
    put_number(report, phase->name, "truncated", phase->out.truncated || phase->err.truncated);
    snprintf(key, sizeof(key), "%s.stdout", phase->name);
    put(report, key, phase->out.data, phase->out.length);
    snprintf(key, sizeof(key), "%s.stderr", phase->name);
    put(report, key, phase->err.data, phase->err.length);
  }
  put(report, "stopped", stop_requested ? "1" : "0", 1);
  put(report, "end", "", 0);
  /* A caller that hung up is not a failure of the run: cleanup still follows. */
  fclose(report);
}

/* Decodes the octal escapes /proc/self/mountinfo uses for spaces and the like. */
static void unescape_mount_path(char *path) {
  char *out = path;
  for (char *in = path; *in; in++) {
    if (in[0] == '\\' && in[1] >= '0' && in[1] <= '3' && in[2] >= '0' && in[2] <= '7'
        && in[3] >= '0' && in[3] <= '7') {
      *out++ = (char)((in[1] - '0') * 64 + (in[2] - '0') * 8 + (in[3] - '0'));
      in += 3;
    } else {
      *out++ = *in;
    }
  }
  *out = '\0';
}

/*
 * Removes write-for-others from every writable mount's root directory and
 * reports what is still writable by others afterwards. The runtime creates
 * these mounts (/tmp, /dev/shm, /dev/mqueue) after the image is built, so the
 * image cannot fix them; and a directory anyone may write to is a place one
 * run can leave something for another. Returns how many remain, or -1.
 */
static int close_shared_mounts(FILE *trace) {
  FILE *mounts = fopen("/proc/self/mountinfo", "re");
  if (!mounts) return -1;
  int remaining = 0;
  char line[8192];
  while (fgets(line, sizeof(line), mounts)) {
    char path[4096], options[512];
    if (sscanf(line, "%*s %*s %*s %*s %4095s %511s", path, options) != 2) continue;
    unescape_mount_path(path);
    /* Read-only mounts cannot be written by anyone, whatever their mode says. */
    if (strncmp(options, "ro", 2) == 0 && (options[2] == '\0' || options[2] == ',')) continue;
    struct stat info;
    if (lstat(path, &info) != 0 || !S_ISDIR(info.st_mode) || !(info.st_mode & S_IWOTH)) continue;
    if (chmod(path, info.st_mode & 07775) == 0) {
      if (trace) fprintf(trace, "closed %s %04o\n", path, info.st_mode & 07777);
    } else {
      if (trace) fprintf(trace, "still-writable %s %04o\n", path, info.st_mode & 07777);
      remaining++;
    }
  }
  fclose(mounts);
  return remaining;
}

/* Whether a seccomp filter can be installed and enforced, tested in a child. */
static int seccomp_works(void) {
  pid_t pid = fork();
  if (pid < 0) return 0;
  if (pid == 0) {
    restore_signals();
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) _exit(1);
    confine_syscalls();
    errno = 0;
    _exit(socket(AF_INET, SOCK_STREAM, 0) < 0 && errno == EACCES ? 0 : 1);
  }
  int status = 0;
  wait_child(pid, &status);
  return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

/* Whether unprivileged user namespaces are available. Reported, not used. */
static int user_namespaces_work(void) {
  pid_t pid = fork();
  if (pid < 0) return 0;
  if (pid == 0) {
    struct slot nobody = {.uid = CELLRUN_UID_BASE, .gid = CELLRUN_UID_BASE};
    if (become(&nobody) != 0) _exit(1);
    _exit(unshare(CLONE_NEWUSER) == 0 ? 0 : 1);
  }
  int status = 0;
  wait_child(pid, &status);
  return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

/* What this kernel and runtime provide, as `key value` lines. */
static int probe(void) {
  struct utsname name;
  if (uname(&name) == 0) printf("kernel %s %s\n", name.release, name.machine);
  int abi = landlock_abi();
  if (abi >= 1) printf("landlock abi-%d\n", abi);
  else printf("landlock unavailable (%s)\n", strerror(errno));
  printf("seccomp %s\n", seccomp_works() ? "enforced" : "unavailable");
  printf("userns %s\n", user_namespaces_work() ? "available" : "unavailable");
  int remaining = close_shared_mounts(stdout);
  printf("shared-mounts %s\n", remaining == 0 ? "closed" : "OPEN");
  return EXIT_REPORTED;
}

/*
 * Establishes, before every run, that the jail can hold on this machine:
 * seccomp must be enforceable, and no writable mount may be left open to
 * everyone. Landlock is not required (see top).
 */
static void require_jail(void) {
  if (!seccomp_works()) {
    fprintf(stderr, "cellrun: seccomp cannot be enforced here\n");
    exit(EXIT_JAIL_UNAVAILABLE);
  }
  if (close_shared_mounts(stderr) != 0) {
    fprintf(stderr, "cellrun: a mount writable by everyone could not be closed\n");
    exit(EXIT_JAIL_UNAVAILABLE);
  }
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) return probe();
  if (argc != 6) {
    fprintf(stderr, "cellrun: usage: cellrun <slot> <language> <compile-ms> <run-ms> <stream-bytes>\n");
    return EXIT_USAGE;
  }
  struct slot slot;
  slot.index = (int)parse_number(argv[1], 0, CELLRUN_SLOTS - 1);
  slot.uid = (uid_t)(CELLRUN_UID_BASE + slot.index);
  slot.gid = (gid_t)(CELLRUN_UID_BASE + slot.index);
  snprintf(slot.dir, sizeof(slot.dir), CELLS_ROOT "/%d", slot.index);
  snprintf(slot.home, sizeof(slot.home), "%s/.home", slot.dir);
  snprintf(slot.go_cache, sizeof(slot.go_cache), "%s/.cache/go-build", slot.home);

  const struct language *language = NULL;
  for (size_t i = 0; i < sizeof(LANGUAGES) / sizeof(LANGUAGES[0]); i++) {
    if (strcmp(LANGUAGES[i].name, argv[2]) == 0) language = &LANGUAGES[i];
  }
  if (!language) {
    fprintf(stderr, "cellrun: unknown language: %s\n", argv[2]);
    return EXIT_USAGE;
  }
  long compile_ms = parse_number(argv[3], 1, 600000);
  long run_ms = parse_number(argv[4], 1, 600000);
  size_t stream_bytes = (size_t)parse_number(argv[5], 1, 16L << 20);

  /*
   * Signals arrive through a descriptor, so a stop is observed between any
   * two steps rather than interrupting one. SIGTERM is the Durable Object's
   * stop; SIGPIPE is ignored so a caller that hung up cannot skip cleanup.
   */
  sigset_t handled;
  sigemptyset(&handled);
  sigaddset(&handled, SIGCHLD);
  sigaddset(&handled, SIGTERM);
  sigaddset(&handled, SIGINT);
  sigaddset(&handled, SIGHUP);
  if (sigprocmask(SIG_BLOCK, &handled, NULL) != 0) die("block signals", EXIT_REPLACE_CONTAINER);
  signal_fd = signalfd(-1, &handled, SFD_NONBLOCK | SFD_CLOEXEC);
  if (signal_fd < 0) die("signalfd", EXIT_REPLACE_CONTAINER);
  signal(SIGPIPE, SIG_IGN);
  /* Everything a phase leaves behind is reparented here, to be reaped and accounted. */
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) die("subreaper", EXIT_REPLACE_CONTAINER);

  if (ensure_root_dir(CELLS_ROOT, 0711) != 0 || ensure_root_dir(LOCK_ROOT, 0700) != 0) {
    die("prepare cellrun's directories", EXIT_REPLACE_CONTAINER);
  }
  require_jail();
  if (lock_slot(&slot) < 0) {
    if (stop_requested) {
      write_report(NULL, 0);
      return EXIT_REPORTED;
    }
    fprintf(stderr, "cellrun: slot %d is still held\n", slot.index);
    return EXIT_SLOT_BUSY;
  }
  if (reset_slot(&slot) != 0 || prepare_run(&slot, language) != 0) return EXIT_REPLACE_CONTAINER;

  /* A failed compile ends the run: there is nothing to launch. */
  const char *const *steps[2] = {language->compile, language->run};
  const char *names[2] = {"compile", "run"};
  long budgets[2] = {compile_ms, run_ms};
  struct phase phases[2];
  int count = 0;
  for (int i = 0; i < 2; i++) {
    if (!steps[i]) continue;
    take_signals();
    if (stop_requested) break;
    struct phase *phase = &phases[count++];
    phase->name = names[i];
    if (run_phase(&slot, language, steps[i], budgets[i], stream_bytes, phase) != 0) {
      return EXIT_REPLACE_CONTAINER;
    }
    if (strcmp(phase->ended, "exit") != 0 || phase->exit_code != 0) break;
  }

  write_report(phases, count);
  /* The caller has its result; the slot is released when this process exits. */
  if (clear_slot(&slot) != 0) return EXIT_REPLACE_CONTAINER;
  return EXIT_REPORTED;
}
