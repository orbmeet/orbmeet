import { CODE_COMPILE_TIMEOUT_MS, CODE_RUN_TIMEOUT_MS, type CodeRunResult } from "@orbmeet/whiteboard-core/code-run-contract";
import type { CodeLanguage } from "@orbmeet/whiteboard-core/code-shape-schema";
import { CODE_LANGUAGES } from "@orbmeet/whiteboard-core/code-shape-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Board, readAll, readReport, type CodeRunOutcome } from "../src/board";
import { CELLRUN_SLOTS, cellrunArgv, parseReport } from "../src/cellrun";
import {
  containerImageAvailable,
  dockerContainer,
  dockerExec,
  IMAGE,
  listCells,
  loopbackReachableFromRoot,
  rootExec,
  slotProcesses,
  startContainer,
  startLoopbackListener,
  stopContainer,
} from "./docker-container";

/**
 * The tests that can tell whether the runner actually works.
 *
 * The unit tests in `src/` prove the Durable Object's bookkeeping against a
 * fake container; they cannot prove that `rustc` is in the image or that a
 * snippet cannot read its neighbour's files. This drives the shipped `Board`
 * against the real image, with Docker standing in for the container API's
 * transport only. Half of it is adversarial: each review finding that let a
 * snippet out of its slot, or wedged one, is here as the attempt.
 *
 * Opt-in, because it needs Docker. `pnpm test:image` rebuilds the image
 * first, so it never passes against stale jail code.
 */
const available = await containerImageAvailable();

const SANDBOX_ID = "board-2cb5ddf410150fdff33e0d2840a0481f";

/**
 * Every test runs on two runtimes. Docker's own keeps the image's /run and
 * /tmp and has Landlock. The second is shaped like Cloudflare's, as observed
 * in production: the kernel has no Landlock (the syscalls return ENOSYS), and
 * fresh, empty mounts replace the image's /run and /tmp. There, file
 * permissions are all that confine a run's writes, and the same adversarial
 * tests have to pass.
 */
const RUNTIMES = [
  { runtime: "Docker, with Landlock", landlock: true, flags: [] as string[] },
  {
    runtime: "a Cloudflare-like runtime, without Landlock",
    landlock: false,
    flags: [
      "--security-opt",
      `seccomp=${new URL("./no-landlock.seccomp.json", import.meta.url).pathname}`,
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/tmp:mode=1777",
    ],
  },
];

describe.skipIf(!available).each(RUNTIMES)(`code runner container (${IMAGE}) on $runtime`, ({ landlock, flags }) => {
  let containerId: string;
  let container: ReturnType<typeof dockerContainer>;
  let board: Board;

  beforeAll(async () => {
    containerId = await startContainer({}, flags);
    container = dockerContainer(containerId);
    board = new Board(container, { log: () => {} });
  }, 120_000);

  afterAll(async () => {
    if (containerId) await stopContainer(containerId);
  });

  const start = (language: CodeLanguage, source: string, runId: string = crypto.randomUUID()) =>
    board.run({ runId, language, source, sandboxId: SANDBOX_ID });

  const runCell = async (language: CodeLanguage, source: string): Promise<CodeRunResult> => {
    const outcome = await start(language, source);
    if (outcome.kind !== "result") throw new Error(`expected a result, got ${outcome.kind}`);
    return outcome.result;
  };

  /** Waits until every slot's supervisor has finished cleaning up. */
  const settled = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (board.slots.every((slot) => slot === "free")) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`slots never settled: ${board.slots.join(", ")}`);
  };

  const HELLO: Record<CodeLanguage, string> = {
    python: 'print("hello", 6 * 7)',
    javascript: 'console.log("hello", 6 * 7);',
    typescript: 'const n: number = 6 * 7;\nconsole.log("hello", n);',
    java:
      'class Main { public static void main(String[] a) { System.out.println("hello " + 6 * 7); } }',
    c: '#include <stdio.h>\n#include <math.h>\nint main(void){ printf("hello %d\\n", (int)(sqrt(4.0)*21)); }',
    cpp: '#include <iostream>\nint main(){ std::cout << "hello " << 6*7 << "\\n"; }',
    go: 'package main\nimport "fmt"\nfunc main(){ fmt.Println("hello", 6*7) }',
    rust: 'fn main(){ println!("hello {}", 6*7); }',
  };

  describe("languages", () => {
    it("has a hello-world for every language the picker offers", () => {
      // A new language with no case here would otherwise be silently unverified,
      // and cellrun's language table lives in C where no type checks it.
      expect(Object.keys(HELLO).sort()).toEqual([...CODE_LANGUAGES].sort());
    });

    it.for([...CODE_LANGUAGES])("runs %s cleanly", { timeout: 120_000 }, async (language) => {
      const result = await runCell(language, HELLO[language]);

      expect({
        language,
        status: result.status,
        stdout: result.stdout.trim(),
        // A clean compile says nothing: a toolchain or jail artefact here
        // would show up as "Compile warnings" on every run of the language.
        stderr: result.stderr.trim().slice(0, 300),
        compileStderr: result.compileStderr.trim().slice(0, 300),
      }).toEqual({ language, status: "success", stdout: "hello 42", stderr: "", compileStderr: "" });
    });

    it("compiles Go that imports the standard library beyond fmt, within the budget", { timeout: 120_000 }, async () => {
      // A read-only cache once made this fail as "package net/http is not in
      // std"; an unwarmed one makes it take a minute on half a vCPU.
      const started = Date.now();
      const result = await runCell(
        "go",
        [
          "package main",
          'import ("encoding/json"; "fmt"; "net/http"; "math/rand"; "context")',
          "func main() {",
          "  _ = rand.Intn(1); _ = context.Background()",
          '  b, _ := json.Marshal(map[string]string{"m": http.MethodGet})',
          "  fmt.Println(string(b))",
          "}",
        ].join("\n"),
      );

      expect(result.stdout.trim()).toBe('{"m":"GET"}');
      expect(result.compileStderr).toBe("");
      expect(Date.now() - started).toBeLessThan(CODE_COMPILE_TIMEOUT_MS / 2);
    });

    it("runs TypeScript by stripping its types, and names the syntax it cannot strip", { timeout: 60_000 }, async () => {
      const result = await runCell("typescript", "enum Color { Red }\nconsole.log(Color.Red);");

      expect(result.status).toBe("error");
      expect(result.phase).toBe("run");
      expect(result.stderr).toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    });

    it("reports a C++ compile error as the compile phase", { timeout: 60_000 }, async () => {
      const result = await runCell("cpp", "int main(){ return nope; }");

      expect(result.status).toBe("error");
      expect(result.phase).toBe("compile");
      expect(result.stderr).toContain("nope");
    });

    it("reports a Rust type error as the compile phase", { timeout: 60_000 }, async () => {
      const result = await runCell("rust", 'fn main(){ let _x: i32 = "not a number"; }');

      expect(result.phase).toBe("compile");
      expect(result.stderr).toContain("E0308");
    });

    it("keeps a Java compile error out of the run phase", { timeout: 120_000 }, async () => {
      const result = await runCell("java", "class Main { void oops( }");

      expect(result.phase).toBe("compile");
      expect(result.status).toBe("error");
    });

    it("reports a compiler's warnings without mistaking them for output", { timeout: 60_000 }, async () => {
      const result = await runCell(
        "c",
        '#include <stdio.h>\nint main(void){ int unused; printf("done\\n"); }',
      );

      expect(result.status).toBe("success");
      expect(result.stdout.trim()).toBe("done");
      expect(result.compileStderr).toContain("unused");
      expect(result.stderr).toBe("");
    });

    it("keeps what a program printed before it crashed", { timeout: 60_000 }, async () => {
      const result = await runCell("python", 'print("before")\nraise ValueError("boom")');

      expect(result.phase).toBe("run");
      expect(result.status).toBe("error");
      expect(result.stdout).toContain("before");
      expect(result.stderr).toContain("ValueError");
      // The run directory is rewritten out of the traceback.
      expect(result.stderr).toContain('File "main.py"');
    });

    it("runs a source at the size limit, which arrives on stdin", { timeout: 60_000 }, async () => {
      const filler = `# ${"x".repeat(78)}\n`.repeat(600);
      const result = await runCell("python", `${filler}print("end")`);
      expect(result.stdout.trim()).toBe("end");
    });

    it("treats the source as data, never as a command", { timeout: 60_000 }, async () => {
      await runCell("python", '"; touch /tmp/pwned; echo "');
      expect(await rootExec(containerId, ["/bin/sh", "-c", "test -e /tmp/pwned && echo yes || echo no"])).toBe("no");
    });
  });

  describe("deadlines and stops", () => {
    it("kills an infinite loop and everything it started, and explains why", { timeout: 60_000 }, async () => {
      const result = await runCell(
        "python",
        'import subprocess\nsubprocess.Popen(["sleep", "300"])\nprint("looping", flush=True)\nwhile True:\n    pass',
      );

      expect(result.status).toBe("error");
      expect(result.timedOut).toBe(true);
      expect(result.stdout).toContain("looping");
      expect(result.stderr).toContain("infinite loop");
      expect(await slotProcesses(containerId)).toBe("");
    });

    it("leaves no process running once a phase ends", { timeout: 60_000 }, async () => {
      // A background child would otherwise outlive its run on a container the
      // whole board shares — and, holding stdout, keep the run from finishing.
      const started = Date.now();
      const result = await runCell(
        "python",
        "import subprocess\nsubprocess.Popen(['sleep', '300'])\nprint('parent done', flush=True)",
      );

      expect(result.status).toBe("success");
      expect(result.stdout.trim()).toBe("parent done");
      expect(Date.now() - started).toBeLessThan(CODE_RUN_TIMEOUT_MS);
      expect(await slotProcesses(containerId)).toBe("");
    });

    it("explains a program the kernel killed for memory", { timeout: 60_000 }, async () => {
      // The container's limit is 4 GiB; the kernel's OOM killer ends the hog.
      const result = await runCell(
        "python",
        "blocks = []\nwhile True:\n    blocks.append(bytearray(256 * 1024 * 1024))",
      );
      expect(result.status).toBe("error");
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toMatch(/ran out of memory/);
      expect(await slotProcesses(containerId)).toBe("");
    });

    it("ends a process that left its session along with its run", { timeout: 60_000 }, async () => {
      // Processes are ended by uid, not by group, so leaving the group is
      // allowed and changes nothing.
      const result = await runCell(
        "python",
        [
          "import os, subprocess",
          "subprocess.Popen(['sleep', '300'], start_new_session=True)",
          "os.setsid()",
          "print('detached')",
        ].join("\n"),
      );

      expect(result.stdout.trim()).toBe("detached");
      expect(await slotProcesses(containerId)).toBe("");
    });

    it("ends a Stop as cancelled, promptly, with nothing left running", { timeout: 60_000 }, async () => {
      const runId = crypto.randomUUID();
      const started = Date.now();
      const outcome = start(
        "python",
        "import subprocess\nsubprocess.Popen(['sleep', '300'])\nwhile True:\n    pass",
        runId,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(board.cancel(runId)).toBe(true);

      expect(await outcome).toEqual({ kind: "cancelled" } satisfies CodeRunOutcome);
      expect(Date.now() - started).toBeLessThan(CODE_RUN_TIMEOUT_MS);
      await settled();
      expect(await slotProcesses(containerId)).toBe("");
    });

    it("ends a Stop during compilation as cancelled, not as a compile error", { timeout: 60_000 }, async () => {
      // Constant evaluation the compiler cannot finish quickly: the Stop is
      // certain to land while the compile phase is running.
      const slowCompile = [
        "constexpr long sum() {",
        "  long s = 0;",
        "  for (long i = 0; i < 250000; ++i) for (long j = 0; j < 250000; ++j) s += i ^ j;",
        "  return s;",
        "}",
        "static_assert(sum() > 0);",
        "int main() {}",
      ].join("\n");
      const runId = crypto.randomUUID();
      const started = Date.now();
      const outcome = start("cpp", slowCompile, runId);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      board.cancel(runId);
      expect(await outcome).toEqual({ kind: "cancelled" });
      expect(Date.now() - started).toBeLessThan(CODE_COMPILE_TIMEOUT_MS / 2);
      await settled();
      expect(await slotProcesses(containerId)).toBe("");
    });

    it("ends a run whose Stop arrived first as cancelled", { timeout: 60_000 }, async () => {
      const runId = crypto.randomUUID();
      expect(board.cancel(runId)).toBe(false);
      expect(await start("python", 'print("never")', runId)).toEqual({ kind: "cancelled" });
    });
  });

  describe("the jail", () => {
    it("reports what the kernel provides, and that every shared mount is closed", { timeout: 60_000 }, async () => {
      const probe = await rootExec(containerId, ["/usr/local/bin/cellrun", "--probe"]);
      expect(probe).toMatch(landlock ? /^landlock abi-\d+$/m : /^landlock unavailable/m);
      expect(probe).toMatch(/^seccomp enforced$/m);
      expect(probe).toMatch(/^shared-mounts closed$/m);
    });

    it("cannot create IPC objects or keys that would outlive the run", { timeout: 60_000 }, async () => {
      // EACCES is cellrun's own answer. Docker's default profile refuses the
      // keyring calls too, with EPERM, so a bare failure would prove nothing.
      const result = await runCell(
        "c",
        [
          "#define _GNU_SOURCE",
          "#include <errno.h>",
          "#include <fcntl.h>",
          "#include <linux/keyctl.h>",
          "#include <mqueue.h>",
          "#include <stdio.h>",
          "#include <sys/ipc.h>",
          "#include <sys/msg.h>",
          "#include <sys/sem.h>",
          "#include <sys/shm.h>",
          "#include <sys/syscall.h>",
          "#include <unistd.h>",
          "static void show(const char *name, long result) {",
          '  printf("%s %s\\n", name, result == -1 && errno == EACCES ? "denied" : "CREATED");',
          "}",
          "int main(void) {",
          '  show("shm", shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0666));',
          '  show("msg", msgget(IPC_PRIVATE, IPC_CREAT | 0666));',
          '  show("sem", semget(IPC_PRIVATE, 1, IPC_CREAT | 0666));',
          '  show("mq", (long)mq_open("/leftover", O_CREAT | O_RDWR, 0666, NULL));',
          '  show("add_key", syscall(SYS_add_key, "user", "leftover", "x", 1, KEY_SPEC_USER_KEYRING));',
          '  show("request_key", syscall(SYS_request_key, "user", "leftover", NULL, KEY_SPEC_USER_KEYRING));',
          "  show(\"keyctl\", syscall(SYS_keyctl, KEYCTL_GET_KEYRING_ID, KEY_SPEC_USER_KEYRING, 1));",
          "}",
        ].join("\n"),
      );
      expect(result.stdout.trim().split("\n")).toEqual([
        "shm denied",
        "msg denied",
        "sem denied",
        "mq denied",
        "add_key denied",
        "request_key denied",
        "keyctl denied",
      ]);
    });

    it("runs snippets as their slot's unprivileged user", { timeout: 60_000 }, async () => {
      const result = await runCell("python", "import os\nprint(os.getuid(), os.getgid(), os.getgroups())");
      const [uid, gid, groups] = result.stdout.trim().split(" ");
      expect(Number(uid)).toBeGreaterThanOrEqual(2000);
      expect(Number(uid)).toBeLessThan(2000 + CELLRUN_SLOTS);
      expect(gid).toBe(uid);
      expect(groups).toBe("[]");
    });

    it("cannot read root-only files", { timeout: 60_000 }, async () => {
      const result = await runCell(
        "python",
        'try:\n    open("/etc/shadow").read()\n    print("READABLE")\nexcept PermissionError:\n    print("denied")',
      );
      expect(result.stdout.trim()).toBe("denied");
    });

    it("cannot open a socket of any family", { timeout: 60_000 }, async () => {
      // An allowlist of none: a family-by-family denylist left vsock, netlink
      // and abstract unix sockets reachable.
      const result = await runCell(
        "python",
        [
          "import socket",
          "families = [('inet', socket.AF_INET), ('inet6', socket.AF_INET6), ('unix', socket.AF_UNIX),",
          "            ('vsock', 40), ('netlink', 16), ('packet', 17), ('alg', 38)]",
          "for name, family in families:",
          "    try:",
          "        socket.socket(family, socket.SOCK_DGRAM if name in ('netlink', 'packet') else socket.SOCK_STREAM)",
          "        print(name, 'OPENED')",
          "    except OSError:",
          "        print(name, 'denied')",
          "a, b = socket.socketpair()",
          "a.send(b'x'); print('socketpair', b.recv(1).decode())",
        ].join("\n"),
      );
      expect(result.stdout.trim().split("\n")).toEqual([
        "inet denied",
        "inet6 denied",
        "unix denied",
        "vsock denied",
        "netlink denied",
        "packet denied",
        "alg denied",
        "socketpair x",
      ]);
    });

    it("cannot reach a service listening on the container's loopback", { timeout: 60_000 }, async () => {
      // The positive control first, so a pass can never mean "nothing was listening".
      await startLoopbackListener(containerId, 3000);
      expect(await loopbackReachableFromRoot(containerId, 3000)).toBe(true);

      const result = await runCell(
        "python",
        [
          "import socket",
          "try:",
          "    socket.create_connection(('127.0.0.1', 3000), timeout=3)",
          "    print('REACHED')",
          "except OSError:",
          "    print('blocked')",
        ].join("\n"),
      );
      expect(result.stdout.trim()).toBe("blocked");
    });

    it("cannot create an io_uring that could bypass socket filtering", { timeout: 60_000 }, async () => {
      const result = await runCell(
        "c",
        [
          "#define _GNU_SOURCE",
          "#include <errno.h>",
          "#include <stdio.h>",
          "#include <sys/syscall.h>",
          "#include <unistd.h>",
          "int main(void) {",
          "  errno = 0;",
          "  long result = syscall(__NR_io_uring_setup, 1, NULL);",
          '  printf("%s\\n", result == -1 && errno == EACCES ? "blocked" : "available");',
          "  return 0;",
          "}",
        ].join("\n"),
      );
      expect(result.stdout.trim()).toBe("blocked");
    });

    it("cannot make namespaces, or reach the kernel surface they would open", { timeout: 60_000 }, async () => {
      // EACCES is cellrun's own answer (the runtime's profile says EPERM), and
      // clone3 is answered ENOSYS so that runtimes fall back to clone.
      const result = await runCell(
        "c",
        [
          "#define _GNU_SOURCE",
          "#include <errno.h>",
          "#include <sched.h>",
          "#include <signal.h>",
          "#include <stdio.h>",
          "#include <sys/syscall.h>",
          "#include <unistd.h>",
          "static void show(const char *name, long result, int expected) {",
          '  printf("%s %s\\n", name, result == -1 && errno == expected ? "denied" : "ALLOWED");',
          "}",
          "int main(void) {",
          '  show("unshare-user", syscall(SYS_unshare, CLONE_NEWUSER), EACCES);',
          '  show("unshare-mount", syscall(SYS_unshare, CLONE_NEWNS), EACCES);',
          '  show("setns", syscall(SYS_setns, -1, 0), EACCES);',
          '  show("clone-user", syscall(SYS_clone, CLONE_NEWUSER | SIGCHLD, 0, 0, 0, 0), EACCES);',
          '  show("clone3", syscall(SYS_clone3, NULL, 0), ENOSYS);',
          '  show("mount", syscall(SYS_mount, "none", "/tmp", "tmpfs", 0, NULL), EACCES);',
          '  show("fsopen", syscall(SYS_fsopen, "tmpfs", 0), EACCES);',
          '  show("bpf", syscall(SYS_bpf, 0, NULL, 0), EACCES);',
          '  show("perf_event_open", syscall(SYS_perf_event_open, NULL, 0, -1, -1, 0), EACCES);',
          '  show("userfaultfd", syscall(SYS_userfaultfd, 0), EACCES);',
          '  show("open_by_handle_at", syscall(SYS_open_by_handle_at, -1, NULL, 0), EACCES);',
          "  /* A plain process still forks. */",
          "  pid_t child = fork();",
          "  if (child == 0) _exit(0);",
          '  printf("fork %s\\n", child > 0 ? "works" : "BROKEN");',
          "  return 0;",
          "}",
        ].join("\n"),
      );
      expect(result.stdout.trim().split("\n")).toEqual([
        "unshare-user denied",
        "unshare-mount denied",
        "setns denied",
        "clone-user denied",
        "clone3 denied",
        "mount denied",
        "fsopen denied",
        "bpf denied",
        "perf_event_open denied",
        "userfaultfd denied",
        "open_by_handle_at denied",
        "fork works",
      ]);
    });

    it("cannot write outside its own run directory, but can discard into /dev/null", { timeout: 60_000 }, async () => {
      const result = await runCell(
        "python",
        [
          "import os, subprocess",
          "def attempt(path):",
          "    try:",
          "        open(path, 'w').write('x')",
          "        return 'WROTE ' + path",
          "    except OSError:",
          "        return 'denied'",
          "for path in ['/tmp/pwned', '/var/tmp/pwned', '/dev/shm/pwned', '/cells/pwned',",
          "             '/cells/0/pwned' if os.getcwd() != '/cells/0' else '/cells/1/pwned',",
          "             '/var/cache/cellrun/go-build/pwned', '/run/cellrun/slot-0.lock']:",
          "    print(attempt(path))",
          "subprocess.run(['true'], stdout=subprocess.DEVNULL, check=True)",
          "subprocess.run('echo hidden > /dev/null', shell=True, check=True)",
          "print('devnull ok')",
        ].join("\n"),
      );

      expect(result.stdout.trim().split("\n")).toEqual([
        ...Array(7).fill("denied"),
        "devnull ok",
      ]);
      expect(result.stderr).toBe("");
    });

    it("gives each run a fresh home and temp directory inside its slot", { timeout: 60_000 }, async () => {
      const first = await runCell(
        "python",
        "import os, tempfile\nopen(os.path.expanduser('~/left-behind'), 'w').write('hi')\nprint(os.environ['HOME'], tempfile.gettempdir())",
      );
      await settled();
      const second = await runCell(
        "python",
        "import os\nprint(os.path.exists(os.path.expanduser('~/left-behind')))",
      );

      // Relative, because the runner rewrites the slot directory out of a
      // run's output — which is itself the evidence both were inside it.
      expect(first.stdout.trim()).toBe(".home .");
      expect(second.stdout.trim()).toBe("False");
    });

    it("keeps the JVM's temp files inside the run too", { timeout: 120_000 }, async () => {
      const result = await runCell(
        "java",
        'class Main { public static void main(String[] a) {'
        + ' System.out.println(System.getProperty("java.io.tmpdir")); } }',
      );
      expect(result.stdout.trim()).toBe(".");
    });
  });

  describe("runs sharing a board", () => {
    it("runs as many cells at once as there are slots, and refuses one more", { timeout: 120_000 }, async () => {
      await settled();
      const sleeper = 'import time\ntime.sleep(2)\nprint("ok")';
      const runs = Array.from({ length: CELLRUN_SLOTS }, () => start("python", sleeper));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await start("python", 'print("extra")')).toEqual({ kind: "busy" });

      const outcomes = await Promise.all(runs);
      expect(outcomes.map((outcome) => outcome.kind === "result" && outcome.result.stdout.trim()))
        .toEqual(Array(CELLRUN_SLOTS).fill("ok"));
    });

    it("cannot read, find, or kill a concurrent run", { timeout: 120_000 }, async () => {
      await settled();
      const victim = start(
        "python",
        [
          "import os, time",
          "open('secret.txt', 'w').write('s3cret')",
          "os.makedirs(os.path.expanduser('~'), exist_ok=True)",
          "print('started', flush=True)",
          "time.sleep(4)",
          "print('survived')",
        ].join("\n"),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const attacker = await runCell(
        "python",
        [
          "import os, signal",
          "mine = os.getcwd()",
          "found = []",
          "for slot in range(8):",
          "    path = f'/cells/{slot}'",
          "    if path == mine: continue",
          "    try:",
          "        found.append(open(path + '/secret.txt').read())",
          "    except OSError: pass",
          "    try:",
          "        found.extend(os.listdir(path))",
          "    except OSError: pass",
          "for pid in os.listdir('/proc'):",
          "    if not pid.isdigit() or int(pid) == os.getpid(): continue",
          "    try:",
          "        found.append(os.readlink(f'/proc/{pid}/cwd'))",
          "    except OSError: pass",
          "    try:",
          "        if os.stat(f'/proc/{pid}').st_uid != os.getuid():",
          "            os.kill(int(pid), signal.SIGKILL); found.append('killed ' + pid)",
          "    except OSError: pass",
          "print(found)",
        ].join("\n"),
      );

      expect(attacker.stdout.trim()).toBe("[]");
      const outcome = await victim;
      expect(outcome.kind === "result" && outcome.result.stdout.trim()).toBe("started\nsurvived");
    });

    it("hands the next run a clean slot whatever the last one left in it", { timeout: 120_000 }, async () => {
      // The run-directory-reuse escalation: a leftover symlink that root would
      // later write through, a tree built to be slow or impossible to delete,
      // and a process trying to outlive the run. None of it may survive.
      const before = await rootExec(containerId, ["sha256sum", "/usr/local/bin/cellrun"]);
      for (let round = 0; round < CELLRUN_SLOTS + 1; round += 1) {
        await runCell(
          "python",
          [
            "import os, subprocess",
            "os.symlink('/usr/local/bin/cellrun', 'main.py.next')",
            "for name in ['main.py', 'Main.java', 'main.c']:",
            "    try: os.remove(name)",
            "    except OSError: pass",
            "    os.symlink('/usr/local/bin/cellrun', name)",
            // Deeper than PATH_MAX, so no path-based walk can remove it.
            "home = os.getcwd()",
            "for i in range(300):",
            "    os.mkdir('d' * 200); os.chdir('d' * 200)",
            "os.chdir(home)",
            "os.makedirs('locked/inner'); open('locked/inner/f', 'w').close()",
            "os.chmod('locked/inner', 0); os.chmod('locked', 0)",
            "subprocess.Popen(['sleep', '300'], start_new_session=True)",
            "print('left a mess')",
          ].join("\n"),
        );
      }
      await settled();

      const clean = await runCell("python", 'import os\nprint(sorted(os.listdir(".")))');
      expect(clean.stdout.trim()).toBe("['.home', 'main.py']");
      expect(await rootExec(containerId, ["sha256sum", "/usr/local/bin/cellrun"])).toBe(before);
      await settled();
      expect(await slotProcesses(containerId)).toBe("");
      expect(await listCells(containerId)).toBe("");
    });
  });

  it("never needed to replace the container", () => {
    expect(container.destroyed).toEqual([]);
  });
});

describe.skipIf(!available)("disk floor", () => {
  it("stops a run that would fill the board's disk, and frees what it wrote", { timeout: 120_000 }, async () => {
    // Set the floor 256 MiB below what is free now, so the test needs to write
    // only that much to reach it.
    const probe = await startContainer();
    const free = Number(await rootExec(probe, ["df", "--output=avail", "-B1", "/"]).then((out) => out.split("\n")[1]));
    await stopContainer(probe);
    const containerId = await startContainer({ CELLRUN_DISK_RESERVE_BYTES: String(free - 256 * 1024 * 1024) });
    try {
      const process = await dockerExec(containerId).exec(cellrunArgv(0, "python"), {
        stdin: new Blob([
          [
            "import os",
            "chunk = b'x' * (1 << 20)",
            "for i in range(4096):",
            "    with open(f'fill{i % 8}-{i}', 'wb') as f: f.write(chunk)",
            "print('wrote everything')",
          ].join("\n"),
        ]).stream(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [report] = await Promise.all([readReport(process.stdout), readAll(process.stderr, 8 * 1024)]);
      expect(await process.exitCode).toBe(0);

      const { run } = parseReport(report);
      expect(run?.ended).toBe("disk");
      expect(run?.stdout).toBe("");
      expect(await listCells(containerId)).toBe("");
    } finally {
      await stopContainer(containerId);
    }
  });
});
