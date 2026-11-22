/**
 * The boundary canary: run by probe.ts under the exact confinement a turn is about to get, before the
 * harness starts. It tries each thing in its plan and prints one JSON object, probe name to outcome:
 * "allowed", an errno code ("EPERM"), "exit <n>" for a command that failed, or "timeout".
 * Opt-in port-0 retries instead return a JSON-encoded ListenPortOutcome string with every attempt.
 * It judges nothing; probe.ts does. Node built-ins only, so it starts fast; the few system calls
 * Node has no binding for go through osascript's JavaScript bridge (NativeCheck), in one process.
 *
 * usage: node canary.js '<plan JSON>' [deadline ms]
 */
import { execFileSync, spawn } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";

export type CanaryStep =
  | { kind: "write"; path: string }
  /** Opens for appending without writing anything, so an escape changes no content. */
  | { kind: "open-append"; path: string }
  /** Creates `path` exclusively (O_EXCL) and writes `marker`; fails if it already exists, so nothing is clobbered. */
  | { kind: "write-excl"; path: string; marker: string }
  | { kind: "readdir"; path: string }
  /** access(F_OK): whether a name exists, which Seatbelt checks as file-test-existence. */
  | { kind: "exists"; path: string }
  /** Opens without becoming the controlling terminal and without blocking, then closes. */
  | { kind: "open"; path: string; flags: "r" | "w" }
  | { kind: "hardlink"; from: string; to: string }
  /** Renames `from` to `to`; if that got through, renames it straight back. */
  | { kind: "rename"; from: string; to: string }
  /** Makes a symlink at `link` to `target`, then writes `file` through it. */
  | { kind: "symlink-write"; target: string; link: string; file: string }
  /**
   * A login save as Grok makes it (fs_atomic.rs): `temp` made new with mode 600, written and synced,
   * its mode set again, renamed onto `onto` (a decoy's), which is then made owner-only.
   */
  | { kind: "refresh"; temp: string; onto: string }
  /** Takes a lock file as Grok does (lock.rs): opens it read-write, creating it, truncates it and writes the holder line; never removes it. */
  | { kind: "lock"; path: string }
  /** Makes a symlink at `link` to `target`, and nothing more. */
  | { kind: "symlink"; target: string; link: string }
  /** Makes a directory at `dir`, then renames it onto `onto`. */
  | { kind: "mkdir-rename"; dir: string; onto: string }
  /** Makes a FIFO at `fifo` (mkfifo), then renames it onto `onto`. */
  | { kind: "fifo-rename"; fifo: string; onto: string }
  /** Writes `a`, hard-links it as `b`, then renames `b` onto `onto`: a file of two names brought in. */
  | { kind: "pair-rename"; a: string; b: string; onto: string }
  | { kind: "unlink"; path: string }
  /** Makes a symlink at `link` to `target`, then renames it onto `onto`. */
  | { kind: "symlink-rename"; target: string; link: string; onto: string }
  | { kind: "mkdir"; path: string }
  | { kind: "chmod"; path: string; mode: number }
  | { kind: "tcp"; host: string; port: number; timeoutMs: number }
  /** Sends one UDP datagram; the sandbox refuses at send (EPERM) when outbound UDP is closed. */
  | { kind: "udp"; host: string; port: number; timeoutMs: number }
  | { kind: "unix"; path: string }
  /** Listens on a TCP port of this address, then closes. */
  | { kind: "listen"; host: string }
  /**
   * Listens on this TCP port of this address (0: one the system picks), then closes; with `connect`,
   * connects to it first, and the outcome is the connect's (stage 2's port block: bind, inbound and outbound).
   * `retryOnEperm` permits a bounded set of fresh-socket attempts only for port 0 without a self-connect, and
   * retains the outcome, attempt count, error codes and available assigned ports as diagnostic JSON.
   */
  | { kind: "listen-port"; host: string; port: number; connect: boolean; retryOnEperm?: Port0ListenRetryBudget }
  /** Binds a UDP socket to this port of this address (0: one the system picks), then closes. */
  | { kind: "udp-bind"; host: string; port: number }
  /**
   * Listens on a Unix socket at this path (relative: to the working directory), then closes it
   * (which removes it); with `connect`, connects to it first, and the outcome is the connect's.
   */
  | { kind: "listen-unix"; path: string; connect: boolean }
  /** Sends a signal (0: only checks it could be sent). */
  | { kind: "signal"; pid: number; signal: number }
  | { kind: "dns"; name: string; timeoutMs: number }
  | { kind: "exec"; command: string; args: string[]; timeoutMs: number }
  /** A system call Node cannot make (see NativeCheck); all of a plan's native steps run in one osascript process. */
  | { kind: "native"; check: NativeCheck };

/**
 * A check made through the system's own libraries, by osascript's JavaScript bridge (every Mac has
 * it): calls Node has no binding for. Each outcome is "allowed", an errno code, "kr <hex>" for a
 * Mach or IOKit return code, or "no-service" when the IOKit class is not on this machine.
 */
export type NativeCheck =
  /** fcntl(fd, cmd, NULL) on a descriptor opened read-only. */
  | { op: "fcntl"; path: string; cmd: number }
  /** proc_pidpath or proc_pidinfo(PROC_PIDTBSDINFO) for a process; pid -1 is the checking process itself. */
  | { op: "pidpath" | "pidinfo"; pid: number }
  /** proc_listpids(PROC_ALL_PIDS): the pids of every process. */
  | { op: "listpids" }
  /** A sysctl read, by name (sysctlbyname) or by MIB (sysctl), asking for the size only. */
  | { op: "sysctl-read"; name: string }
  | { op: "sysctl-read"; mib: number[] }
  /** socket(domain, type, protocol), closed at once. */
  | { op: "socket"; domain: number; type: number; protocol: number }
  /** A datagram Unix socket connected to this path, sending nothing, then closed. */
  | { op: "unix-dgram-connect"; path: string }
  /** bootstrap_look_up of a Mach service by its global name (the port is not used). */
  | { op: "mach"; name: string }
  /** openpty: a new pseudo-terminal pair of the process's own, closed at once. */
  | { op: "openpty" }
  /** IOServiceOpen of an IOKit user client, by the service's class name. */
  | { op: "iokit-open"; serviceClass: string }
  /** A sysctl write, by name. `value` is written as bytes. */
  | { op: "sysctl-write"; name: string; value: string }
  /** A named POSIX semaphore operation on an existing name: open it, post it, or unlink it. */
  | { op: "sem-open" | "sem-post" | "sem-unlink"; name: string }
  /** renamex_np(from, to, RENAME_SWAP): the two names exchanged. */
  | { op: "rename-swap"; from: string; to: string }
  /** setxattr(path, "com.relay.probe", …, XATTR_NOFOLLOW). */
  | { op: "setxattr"; path: string };

/** How long the native checks may take together. */
const NATIVE_TIMEOUT_MS = 5000;

/**
 * The osascript (JavaScript) side of the native checks: takes the checks as JSON and returns a JSON
 * object, check name to outcome. Errors are errno numbers here; the canary names them.
 */
const NATIVE_SCRIPT = `function run(argv) {
  var checks = JSON.parse(argv[0]);
  ObjC.bindFunction("__error", ["int *", []]);
  ObjC.bindFunction("open", ["int", ["char *", "int"]]);
  ObjC.bindFunction("close", ["int", ["int"]]);
  ObjC.bindFunction("fcntl", ["int", ["int", "int", "void *"]]);
  ObjC.bindFunction("malloc", ["void *", ["long"]]);
  ObjC.bindFunction("getpid", ["int", []]);
  ObjC.bindFunction("proc_pidpath", ["int", ["int", "void *", "unsigned int"]]);
  ObjC.bindFunction("proc_pidinfo", ["int", ["int", "int", "unsigned long long", "void *", "int"]]);
  ObjC.bindFunction("proc_listpids", ["int", ["unsigned int", "unsigned int", "void *", "int"]]);
  ObjC.bindFunction("sysctl", ["int", ["void *", "unsigned int", "void *", "long *", "void *", "long"]]);
  ObjC.bindFunction("sysctlbyname", ["int", ["char *", "void *", "long *", "void *", "long"]]);
  ObjC.bindFunction("socket", ["int", ["int", "int", "int"]]);
  ObjC.bindFunction("connect", ["int", ["int", "void *", "unsigned int"]]);
  ObjC.bindFunction("mach_task_self", ["unsigned int", []]);
  ObjC.bindFunction("task_get_special_port", ["int", ["unsigned int", "int", "unsigned int *"]]);
  ObjC.bindFunction("bootstrap_look_up", ["int", ["unsigned int", "char *", "unsigned int *"]]);
  ObjC.bindFunction("openpty", ["int", ["int *", "int *", "char *", "void *", "void *"]]);
  ObjC.import("IOKit");
  ObjC.bindFunction("IOServiceMatching", ["void *", ["char *"]]);
  ObjC.bindFunction("IOServiceGetMatchingService", ["unsigned int", ["unsigned int", "void *"]]);
  ObjC.bindFunction("IOServiceOpen", ["int", ["unsigned int", "unsigned int", "unsigned int", "unsigned int *"]]);
  ObjC.bindFunction("IOServiceClose", ["int", ["unsigned int"]]);
  ObjC.bindFunction("sem_open", ["long", ["char *", "int"]]);
  ObjC.bindFunction("sem_post", ["int", ["long"]]);
  ObjC.bindFunction("sem_unlink", ["int", ["char *"]]);
  ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]);
  ObjC.bindFunction("setxattr", ["int", ["char *", "char *", "char *", "long", "unsigned int", "int"]]);
  var kr = function (k) { return k === 0 ? "allowed" : "kr " + (k >>> 0).toString(16); };
  var buf = $.malloc(4096);
  var errno = function () { return { errno: $.__error()[0] }; };
  var out = {};
  Object.keys(checks).forEach(function (name) {
    var c = checks[name];
    try {
      if (c.op === "fcntl") {
        var fd = $.open(c.path, 0);
        if (fd < 0) { out[name] = errno(); return; }
        out[name] = $.fcntl(fd, c.cmd, null) < 0 ? errno() : "allowed";
        $.close(fd);
      } else if (c.op === "pidpath") out[name] = $.proc_pidpath(c.pid === -1 ? $.getpid() : c.pid, buf, 4096) <= 0 ? errno() : "allowed";
      else if (c.op === "pidinfo") out[name] = $.proc_pidinfo(c.pid === -1 ? $.getpid() : c.pid, 3, 0, buf, 136) <= 0 ? errno() : "allowed";
      else if (c.op === "listpids") out[name] = $.proc_listpids(1, 0, null, 0) <= 0 ? errno() : "allowed";
      else if (c.op === "sysctl-read" && c.name) out[name] = $.sysctlbyname(c.name, null, Ref(), null, 0) < 0 ? errno() : "allowed";
      else if (c.op === "sysctl-read") {
        var mib = $.NSData.alloc.initWithBase64EncodedStringOptions(c.mib64, 0);
        out[name] = $.sysctl(mib.bytes, c.mibLength, null, Ref(), null, 0) < 0 ? errno() : "allowed";
      } else if (c.op === "socket") {
        var sd = $.socket(c.domain, c.type, c.protocol);
        out[name] = sd < 0 ? errno() : "allowed";
        if (sd >= 0) $.close(sd);
      } else if (c.op === "unix-dgram-connect") {
        var u = $.socket(1, 2, 0);
        if (u < 0) { out[name] = errno(); return; }
        var addr = $.NSData.alloc.initWithBase64EncodedStringOptions(c.addr64, 0);
        out[name] = $.connect(u, addr.bytes, c.addrLength) < 0 ? errno() : "allowed";
        $.close(u);
      } else if (c.op === "mach") {
        var bp = Ref();
        var k = $.task_get_special_port($.mach_task_self(), 4, bp);
        out[name] = k !== 0 ? "bootstrap port: " + kr(k) : kr($.bootstrap_look_up(bp[0], c.name, Ref()));
      } else if (c.op === "openpty") {
        var m = Ref(), sl = Ref();
        if ($.openpty(m, sl, null, null, null) < 0) { out[name] = errno(); return; }
        $.close(m[0]);
        $.close(sl[0]);
        out[name] = "allowed";
      } else if (c.op === "iokit-open") {
        var svc = $.IOServiceGetMatchingService(0, $.IOServiceMatching(c.serviceClass));
        if (!svc) { out[name] = "no-service"; return; }
        var conn = Ref();
        var k = $.IOServiceOpen(svc, $.mach_task_self(), 0, conn);
        out[name] = kr(k);
        if (k === 0) $.IOServiceClose(conn[0]);
      } else if (c.op === "sysctl-write") {
        var v = $.NSData.alloc.initWithBase64EncodedStringOptions(c.value64, 0);
        out[name] = $.sysctlbyname(c.name, null, null, v.bytes, v.length) < 0 ? errno() : "allowed";
      } else if (c.op === "sem-unlink") {
        out[name] = $.sem_unlink(c.name) < 0 ? errno() : "allowed";
      } else if (c.op === "sem-open" || c.op === "sem-post") {
        var sp = $.sem_open(c.name, 0);
        if (sp < 0) { out[name] = errno(); return; }
        out[name] = c.op === "sem-open" ? "allowed" : ($.sem_post(sp) < 0 ? errno() : "allowed");
      } else if (c.op === "rename-swap") out[name] = $.renamex_np(c.from, c.to, 2) < 0 ? errno() : "allowed";
      else if (c.op === "setxattr") out[name] = $.setxattr(c.path, "com.relay.probe", "1", 1, 0, 1) < 0 ? errno() : "allowed";
      else out[name] = "unknown check " + c.op;
    } catch (e) { out[name] = "exception: " + e; }
  });
  return JSON.stringify(out);
}`;

function wireCheck(c: NativeCheck): Record<string, unknown> {
  if (c.op === "sysctl-read" && "mib" in c) return { op: c.op, mib64: Buffer.from(new Int32Array(c.mib).buffer).toString("base64"), mibLength: c.mib.length };
  if (c.op === "sysctl-write") return { op: c.op, name: c.name, value64: Buffer.from(c.value).toString("base64") };
  if (c.op === "unix-dgram-connect") {
    const p = Buffer.from(c.path);
    if (p.length > 103) throw new Error(`socket path too long: ${c.path}`);
    const addr = Buffer.alloc(106);
    addr[0] = 106;
    addr[1] = 1; // AF_UNIX
    p.copy(addr, 2);
    return { op: c.op, addr64: addr.toString("base64"), addrLength: addr.length };
  }
  return c;
}

const ERRNO_NAMES = new Map(Object.entries(os.constants.errno).map(([k, v]) => [v, k]));

/** Runs the native checks in one osascript process: name to outcome. */
function native(checks: Record<string, NativeCheck>): Promise<Record<string, string>> {
  const names = Object.keys(checks);
  if (!names.length) return Promise.resolve({});
  return new Promise((resolve) => {
    const all = (outcome: string) => resolve(Object.fromEntries(names.map((n) => [n, outcome])));
    // A MIB travels as base64 of its 32-bit integers, which the script hands to sysctl as bytes.
    // So does a socket address, built here (struct sockaddr_un: length, family, path).
    const wire = Object.fromEntries(Object.entries(checks).map(([n, c]) => [n, wireCheck(c)]));
    const c = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", NATIVE_SCRIPT, JSON.stringify(wire)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => (c.kill("SIGKILL"), all("timeout")), NATIVE_TIMEOUT_MS);
    c.stdout!.on("data", (d) => (stdout += d));
    c.stderr!.on("data", (d) => (stderr += d));
    c.once("error", (e) => (clearTimeout(timer), all(errCode(e))));
    c.once("close", (code) => {
      clearTimeout(timer);
      let got: Record<string, unknown>;
      try {
        got = JSON.parse(stdout);
      } catch {
        return all(`exit ${code}: ${stderr.trim().replace(/\s+/g, " ").slice(0, 200)}`);
      }
      resolve(Object.fromEntries(names.map((n) => {
        const g = got[n] as { errno?: number } | string | undefined;
        if (g && typeof g === "object" && typeof g.errno === "number") return [n, ERRNO_NAMES.get(g.errno) ?? `errno ${g.errno}`];
        return [n, typeof g === "string" ? g : "missing"];
      })));
    });
  });
}

const errCode = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? String((err as Error)?.message ?? err);

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> =>
  Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms).unref())]);

export interface ListenPortAttempt {
  /** null means the listen succeeded (and, if requested, the self-connect did too). */
  errorCode: string | null;
  /** Node usually cannot report the assigned port after a failed listen. */
  port: number | null;
}

export interface Port0ListenRetryBudget {
  /** Longest contiguous TCP listener-denied run in the decoy's ephemeral range, wrapping included. */
  longestDeniedRun: number;
  maxAttempts: number;
}

export interface ListenPortOutcome {
  outcome: string;
  attemptCount: number;
  attempts: ListenPortAttempt[];
  retryBudget?: Port0ListenRetryBudget;
}

async function listenPort(s: Extract<CanaryStep, { kind: "listen-port" }>): Promise<ListenPortOutcome> {
  const attempts: ListenPortAttempt[] = [];
  // Only positive, non-connecting port-0 probes opt in. Fixed ports and controls stay single-shot,
  // even if a caller mistakenly sets the flag. All sockets stay in this canary's same profile.
  // The dynamic range has 16384 ports; even a full-range deny plus the planner's margin is finite.
  const limit = s.retryOnEperm && s.port === 0 && !s.connect && Number.isInteger(s.retryOnEperm.maxAttempts)
    ? Math.max(1, Math.min(16386, s.retryOnEperm.maxAttempts)) : 1;
  let outcome = "missing";
  for (let i = 0; i < limit; i++) {
    const result = await new Promise<{ outcome: string; attempt: ListenPortAttempt }>((resolve) => {
      const srv = net.createServer((c) => c.destroy());
      const finish = (got: string) => {
        const address = srv.address();
        const attempt = { errorCode: got === "allowed" ? null : got, port: address && typeof address === "object" ? address.port : null };
        srv.close(() => resolve({ outcome: got, attempt }));
      };
      srv.once("error", (e) => finish(errCode(e)));
      try {
        srv.listen(s.port, s.host, () => void (s.connect ? connect({ host: s.host, port: (srv.address() as net.AddressInfo).port }) : Promise.resolve("allowed")).then(finish));
      } catch (err) {
        finish(errCode(err));
      }
    });
    attempts.push(result.attempt);
    outcome = result.outcome;
    if (outcome !== "EPERM") break;
  }
  return { outcome, attemptCount: attempts.length, attempts, ...(s.retryOnEperm ? { retryBudget: s.retryOnEperm } : {}) };
}

function connect(opts: net.NetConnectOpts): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(opts);
    s.once("connect", () => {
      s.destroy();
      resolve("allowed");
    });
    s.once("error", (e) => resolve(errCode(e)));
  });
}

async function step(s: CanaryStep): Promise<string> {
  try {
    switch (s.kind) {
      case "write":
        fs.writeFileSync(s.path, "relay probe\n");
        return "allowed";
      case "open-append":
        fs.closeSync(fs.openSync(s.path, "a"));
        return "allowed";
      case "write-excl":
        fs.writeFileSync(s.path, s.marker, { flag: "wx" });
        return "allowed";
      case "open":
        fs.closeSync(fs.openSync(s.path, (s.flags === "r" ? fs.constants.O_RDONLY : fs.constants.O_WRONLY) | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK));
        return "allowed";
      case "readdir":
        fs.readdirSync(s.path);
        return "allowed";
      case "exists":
        fs.accessSync(s.path, fs.constants.F_OK);
        return "allowed";
      case "hardlink":
        fs.linkSync(s.from, s.to);
        return "allowed";
      case "rename":
        fs.renameSync(s.from, s.to);
        try {
          fs.renameSync(s.to, s.from);
        } catch {}
        return "allowed";
      case "symlink-write":
        fs.symlinkSync(s.target, s.link);
        fs.writeFileSync(s.file, "relay probe\n");
        return "allowed";
      case "refresh": {
        const fd = fs.openSync(s.temp, "wx", 0o600);
        try {
          fs.writeSync(fd, "relay probe\n");
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.chmodSync(s.temp, 0o600);
        fs.renameSync(s.temp, s.onto);
        fs.chmodSync(s.onto, 0o600);
        return "allowed";
      }
      case "lock": {
        const fd = fs.openSync(s.path, "a+", 0o600);
        try {
          fs.ftruncateSync(fd, 0);
          fs.writeSync(fd, "relay probe\n");
        } finally {
          fs.closeSync(fd);
        }
        return "allowed";
      }
      case "symlink":
        fs.symlinkSync(s.target, s.link);
        return "allowed";
      case "symlink-rename":
        fs.symlinkSync(s.target, s.link);
        fs.renameSync(s.link, s.onto);
        return "allowed";
      case "mkdir":
        fs.mkdirSync(s.path);
        return "allowed";
      case "mkdir-rename":
        fs.mkdirSync(s.dir);
        fs.renameSync(s.dir, s.onto);
        return "allowed";
      case "fifo-rename":
        execFileSync("/usr/bin/mkfifo", [s.fifo], { stdio: "ignore", timeout: 5000 });
        fs.renameSync(s.fifo, s.onto);
        return "allowed";
      case "pair-rename":
        fs.writeFileSync(s.a, "relay probe\n");
        fs.linkSync(s.a, s.b);
        fs.renameSync(s.b, s.onto);
        return "allowed";
      case "unlink":
        fs.unlinkSync(s.path);
        return "allowed";
      case "chmod":
        fs.chmodSync(s.path, s.mode);
        return "allowed";
      case "tcp":
        return await withTimeout(connect({ host: s.host, port: s.port }), s.timeoutMs);
      case "udp":
        return await withTimeout(
          new Promise<string>((resolve) => {
            // IPv6 destinations (stage 2's ::1) need an IPv6 socket; IPv4 ones get the IPv4 socket they always did.
            const sock = dgram.createSocket(net.isIPv6(s.host) ? "udp6" : "udp4");
            sock.once("error", (e) => (sock.close(), resolve(errCode(e))));
            sock.send("relay probe", s.port, s.host, (e) => {
              resolve(e ? errCode(e) : "allowed");
              try {
                sock.close();
              } catch {}
            });
          }),
          s.timeoutMs,
        );
      case "signal":
        process.kill(s.pid, s.signal);
        return "allowed";
      case "listen":
        return await new Promise<string>((resolve) => {
          const srv = net.createServer();
          srv.once("error", (e) => resolve(errCode(e)));
          srv.listen(0, s.host, () => srv.close(() => resolve("allowed")));
        });
      case "listen-port": {
        const result = await listenPort(s);
        return s.retryOnEperm ? JSON.stringify(result) : result.outcome;
      }
      case "udp-bind":
        return await new Promise<string>((resolve) => {
          const sock = dgram.createSocket(net.isIPv6(s.host) ? "udp6" : "udp4");
          sock.once("error", (e) => (sock.close(), resolve(errCode(e))));
          sock.bind(s.port, s.host, () => sock.close(() => resolve("allowed")));
        });
      case "unix":
        return await connect({ path: s.path });
      case "listen-unix":
        return await new Promise<string>((resolve) => {
          const srv = net.createServer((c) => c.destroy());
          srv.once("error", (e) => resolve(errCode(e)));
          srv.listen(s.path, () => void (s.connect ? connect({ path: s.path }) : Promise.resolve("allowed")).then((r) => srv.close(() => resolve(r))));
        });
      case "dns": {
        // Both resolvers: the system's (getaddrinfo, through mDNSResponder) and c-ares (UDP to the configured servers).
        const resolver = new dns.promises.Resolver({ timeout: s.timeoutMs, tries: 1 });
        const outcomes = await Promise.all([
          withTimeout(dns.promises.lookup(s.name).then(() => "allowed", errCode), s.timeoutMs),
          withTimeout(resolver.resolve4(s.name).then(() => "allowed", errCode), s.timeoutMs * 2),
        ]);
        return outcomes.includes("allowed") ? "allowed" : outcomes.includes("timeout") ? "timeout" : outcomes[0];
      }
      case "exec":
        return await withTimeout(
          new Promise<string>((resolve) => {
            const c = spawn(s.command, s.args, { stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            c.stderr!.on("data", (d) => (stderr += d));
            c.once("error", (e) => resolve(errCode(e)));
            c.once("close", (code, signal) => {
              const why = stderr.trim().replace(/\s+/g, " ").slice(0, 300);
              resolve(code === 0 ? "allowed" : signal ? `signal ${signal}` : `exit ${code}${why ? `: ${why}` : ""}`);
            });
          }),
          s.timeoutMs,
        );
      case "native":
        return "native steps run together";
    }
  } catch (err) {
    return errCode(err);
  }
}

const plan = JSON.parse(process.argv[2] ?? "{}") as Record<string, CanaryStep>;
// The commands first: they run in processes of their own, the slowest of the canary's steps (an
// Apple event's osascript takes most of its time), so they are started before the steps tried here
// one after another, and run while those are. Each step is the same attempt whenever it starts.
const names = [
  ...Object.keys(plan).filter((n) => plan[n].kind === "exec"),
  ...Object.keys(plan).filter((n) => plan[n].kind !== "exec" && plan[n].kind !== "native"),
];
const nativeChecks = Object.fromEntries(Object.entries(plan).flatMap(([n, s]) => (s.kind === "native" ? [[n, s.check]] : [])));
// The canary's own deadline (argv[3], ms; relay sets it below its limit for the whole run): a step
// still unsettled then is reported as "timeout", which no probe accepts as a denial, and every step
// that did settle is still reported. One stalled step then refuses the launch under its own name,
// and an escape elsewhere is still seen, instead of the whole run timing out with no results.
const deadlineMs = Number(process.argv[3]);
const got: Record<string, string> = {};
const settled = Promise.all([
  Promise.all(names.map((n) => step(plan[n]).then((o) => void (got[n] = o)))),
  native(nativeChecks).then((o) => void Object.assign(got, o)),
]);
if (Number.isFinite(deadlineMs) && deadlineMs > 0) await Promise.race([settled, new Promise((r) => setTimeout(r, deadlineMs))]);
else await settled;
for (const n of [...names, ...Object.keys(nativeChecks)]) got[n] ??= "timeout";
// Exit once the line is written: on macOS a pipe's writes are asynchronous, and exiting at once can lose it.
process.stdout.write(JSON.stringify(got) + "\n", () => process.exit(0));
