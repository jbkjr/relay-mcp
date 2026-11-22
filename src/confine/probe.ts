import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CanaryStep, NativeCheck } from "./canary.js";
import type { ConfinedLaunch, ConfinementPolicy } from "./index.js";
import { relayHome, VERSION } from "../core/config.js";
import { within } from "./paths.js";
import { boundaryPaths, canonical, F_MAKECOMPRESSED, F_TRANSFEREXTENTS, persistentState, tokenFile } from "./seatbelt.js";
import { ensureRelaySocketsDir, relaySocketsDir } from "./sockets.js";
import { planStage2Network } from "./probe-stage2.js";
import type { Stage2Network } from "./seatbelt-stage2.js";
import { isGroupSignalRefusal, sendGroupSignal } from "../core/procs.js";

/**
 * Per-turn boundary probes. Before each confined launch relay runs the canary (canary.ts) under
 * exactly the confinement the harness is about to get (same profile and parameters, same working
 * directory, and the variables relay sets for the launch, all of which the fingerprint covers; not
 * the variables the harness inherits besides) and refuses the launch if anything that must be denied
 * is not, or anything that must work does not. Each probe is a real attempt against a real target relay set up outside the
 * sandbox, so a denial means the boundary held, not that the target was missing. Nothing is cached:
 * every turn is probed with its own profile.
 */

const CANARY = path.join(path.dirname(fileURLToPath(import.meta.url)), "canary.js");
/** The whole canary run may take this long before the launch is refused. It takes about half a second when idle; a short limit refused turns on a busy Mac. */
const CANARY_TIMEOUT_MS = 30000;
/**
 * The canary's own deadline, well inside CANARY_TIMEOUT_MS: by then it reports what every step got,
 * a step still running as "timeout". A stalled step then refuses the launch under its own name, and
 * an escape elsewhere is still reported, rather than the whole run timing out with no results (seen
 * once on GitHub's macOS runners, 2026-11-21).
 */
const CANARY_DEADLINE_MS = 20000;
/** How long a connect or a lookup the sandbox should refuse at once may hang before it counts as not refused. */
const STEP_TIMEOUT_MS = 1000;
/** Never routed (TEST-NET-1): a connect there is refused by the sandbox at once, or it hangs. */
const UNROUTABLE = "192.0.2.1";
/** The IPv6 documentation prefix, never routed either. */
const UNROUTABLE_V6 = "2001:db8::1";
/** A name that resolves wherever DNS works. */
const DNS_NAME = "www.apple.com";
/** The system resolver's socket: getaddrinfo reaches DNS only through it. */
const MDNS_SOCKET = "/private/var/run/mDNSResponder";
/** The system log's socket, which the profile allows (a local log, as Codex's does). */
const SYSLOG_SOCKET = "/private/var/run/syslog";
/** macOS keeps 104 bytes for a Unix socket's path, its terminating NUL included. */
const MAX_SOCKET_PATH = 103;
/** <sys/socket.h> */
const AF_ROUTE = 17;
const SOCK_RAW = 3;
/** <sys/sysctl.h>: kern.proc.pid.<pid> and kern.procargs2.<pid> by MIB. */
const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_PID = 1;
const KERN_PROCARGS2 = 49;
/** The canary's native checks run in osascript, a process of the canary's own: "self" is resolved there. */
const SELF = -1;

export interface ProbeResult {
  name: string;
  expect: "allow" | "deny";
  /** What it was tried against: a path, an address, or a command. */
  target?: string;
  /** "allowed", an errno code, "exit <n>", "timeout", or "skipped: <why>". */
  got: string;
  ok: boolean;
}

export interface ProbeReport {
  ok: boolean;
  /** The confinement probed: SHA-256 of its profile text and parameters (`ConfinedLaunch.fingerprint`). */
  profile: string;
  /** The relay version that built the profile and ran the probes. */
  relay: string;
  /** The kernel release and OS build they ran on. */
  os: string;
  /** Wall time of the whole check, setup and cleanup included. */
  ms: number;
  results: ProbeResult[];
  /** The probe that failed, when one did: the first escape (a refusal expected, "allowed" got), else the first failure. */
  failed?: ProbeResult;
}

/**
 * Addresses configured on the loopback interface besides the ones Seatbelt's "localhost" covers
 * (127.0.0.1, ::1 and lo0's link-local fe80::1): an alias someone added for a local service.
 * With the network on, the profile's loopback rule does not cover such an address (seen on macOS
 * 27.0: a connect to 127.0.0.2 was not refused), so each one found is probed and must be refused.
 */
export function loopbackAliases(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const covered = new Set(["127.0.0.1", "::1", "fe80::1"]);
  return (interfaces.lo0 ?? []).map((a) => a.address.split("%")[0]).filter((a) => !covered.has(a));
}

/**
 * Every address a connect could reach this Mac at (review R1): loopback, the unspecified addresses,
 * each address `os.networkInterfaces()` reports (link-local ones with their interface, without which
 * they cannot be connected to), and the IPv6 spellings of each IPv4 one: IPv4-mapped (`::ffff:a.b.c.d`;
 * 0.0.0.0's also written out, `0:0:0:0:0:ffff:0:0`) and IPv4-compatible (`::a.b.c.d`). Seatbelt's
 * "localhost" matches the plain addresses but not the IPv4-mapped ones, loopback's apart: through
 * 1.0.5, ::ffff:0.0.0.0 reached loopback and ::ffff:<a LAN or tailnet address> that address past the
 * network-on rule (measured on macOS 27.0.1). The probes try every spelling.
 */
export function localAddressSpellings(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out = ["127.0.0.1", "::1", "0.0.0.0", "::", "fe80::1%lo0"];
  const v4 = new Set(["127.0.0.1", "0.0.0.0"]);
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      const bare = a.address.split("%")[0];
      if (a.family === "IPv4") v4.add(bare);
      out.push(a.family === "IPv6" && /^fe[89ab][0-9a-f]:/i.test(bare) ? `${bare}%${name}` : bare);
    }
  }
  // ::0.0.0.0 is :: itself.
  for (const a of v4) out.push(`::ffff:${a}`, ...(a === "0.0.0.0" ? ["0:0:0:0:0:ffff:0:0"] : [`::${a}`]));
  return [...new Set(out)];
}

/** Thrown when relay will not launch a confined harness; `check` names the probe or check that failed. */
export class ConfinementRefused extends Error {
  constructor(readonly check: string, message: string, readonly report?: ProbeReport) {
    super(message);
    this.name = "ConfinementRefused";
  }
}

type Judge = (got: string) => boolean;
const allowed: Judge = (g) => g === "allowed";
/**
 * The sandbox's own refusal: EPERM. Not EACCES, which ordinary Unix permissions give too; any other
 * failure proves nothing.
 */
const sandboxDenied: Judge = (g) => g === "EPERM";
/** A lookup that got no answer, promptly: not a timeout, which proves nothing. Judged together with the DNS channels' own denials. */
const noAnswer: Judge = (g) => g !== "allowed" && g !== "timeout" && g !== "missing" && /^E[A-Z]+$/.test(g);
/** A Mach lookup the sandbox refused: BOOTSTRAP_NOT_PRIVILEGED (1100), not "unknown service" (1102), which only means absent. */
const machDenied: Judge = (g) => g === "kr 44c";
/** A Mach lookup that was answered: the bootstrap server returned a port (KERN_SUCCESS), not any error. */
const machAnswered: Judge = (g) => g === "allowed";
/** An IOKit user client the sandbox refused: kIOReturnNotPermitted (0xe00002e2). */
const iokitDenied: Judge = (g) => g === "kr e00002e2";
/** A sysctl write the sandbox let reach the kernel: anything but its own EPERM (the kernel may then reject the value, e.g. EINVAL). */
const notSandboxBlocked: Judge = (g) => g !== "EPERM" && /^(allowed|E[A-Z]+)$/.test(g);
/** LaunchServices refused to open the app: a failed exit with its own error, not just any failure. */
const launchServicesRefused: Judge = (g) => /^exit [1-9]\d*: .*(kLS|LSOpen|-10\d{3}|cannot be opened)/s.test(g) || sandboxDenied(g);
/**
 * An Apple event that never left the sandbox: osascript could not even find the Finder (-1728),
 * because LaunchServices, which the profile closes, could not be asked; or it could not start. Not
 * any execution error: privacy controls refusing the event (-1743) are not the sandbox.
 */
const appleEventRefused: Judge = (g) => /^exit [1-9]\d*: .*execution error: Can.t get application "Finder"\. \(-1728\)/s.test(g) || sandboxDenied(g);
/** launchd refused the job: a failed exit (launchd says nothing more to a sandboxed caller); relay also checks afterwards that no job was made. */
const launchdRefused: Judge = (g) => /^exit [1-9]\d*(:|$)/.test(g) || sandboxDenied(g);
/** A connect to a listening port the sandbox permits: connected, or refused by the peer, never by the sandbox. */
const reachable: Judge = (g) => g === "allowed" || g === "ECONNREFUSED";

/** An app bundle whose only act, if LaunchServices ever started it, would be to leave a marker. */
function probeApp(dir: string, marker: string): string {
  const app = path.join(dir, "RelayProbe.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "probe"), `#!/bin/sh\n: > '${marker.replace(/'/g, `'\\''`)}'\n`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>me.jbkjr.relay.probe</string>` +
      `<key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/></dict></plist>\n`,
  );
  return app;
}

/** How long the decoy semaphores' helper may take to make them, and then to remove them, before it is killed. */
const SEMAPHORE_TIMEOUT_MS = 5000;

/**
 * Removes named POSIX semaphores outside the sandbox through osascript's JavaScript bridge (Node has
 * none), one process for each: only names relay made. Failures are swallowed: they are probe
 * targets, not the boundary.
 */
function unlinkSemaphores(names: string[]): void {
  for (const name of names) {
    try {
      execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", `ObjC.bindFunction('sem_unlink',['int',['char *']]); function run(a){$.sem_unlink(a[0]);return '';}`, name], { stdio: "ignore", timeout: SEMAPHORE_TIMEOUT_MS });
    } catch {
      // Gone already, or never made.
    }
  }
}

/** The probes' decoy named POSIX semaphores (startDecoySemaphores): their names, which of them relay made, and their removal. */
export interface DecoySemaphores {
  /** One outside the /mp- namespace the profile opens, and one inside it. Short names that start with "/", as the semaphore API requires. */
  names: { outside: string; mp: string };
  /** Settles once both are made, or once relay has given up making them, with the names relay made. */
  made: Promise<Set<string>>;
  /** Removes those relay made; settles once they are gone (or relay has tried). A second call settles with the first. */
  remove(): Promise<void>;
}

/**
 * The probes' decoy named POSIX semaphores, made outside the sandbox so the confined canary can be
 * shown it cannot touch another process's semaphore, and removed once the probes are over. One
 * osascript process (its JavaScript bridge; Node has no POSIX semaphores) does both: it creates each
 * name exclusively, with O_CREAT | O_EXCL (0x0200 | 0x0800), and closes its own handle at once, so
 * that during the canary the names exist with nothing holding them open; it says on its stdout
 * which names it made, and unlinks those, and only those, when relay closes its stdin (or relay is
 * gone). A name that already exists is another program's semaphore: it is neither probed nor
 * removed. Started before the other targets are set up (by prepareLaunch, before its hard-link
 * walk); the canary waits for `made`. A helper that fails, or takes longer than SEMAPHORE_TIMEOUT_MS,
 * is killed: a decoy relay did not make fails its probes loudly, which refuses the launch, and
 * `remove` then unlinks one by one the names the helper said it made. One it never said it made is
 * left: its name is random, and leaving a decoy behind is better than removing a semaphore relay
 * may not own. Whoever starts them removes them, whatever happens.
 */
export function startDecoySemaphores(): DecoySemaphores {
  const id = crypto.randomBytes(6).toString("hex");
  const names = { outside: `/rp${id}`, mp: `/mp-rp${id}` };
  return { names, ...decoySemaphores([names.outside, names.mp]) };
}

function decoySemaphores(names: string[]): { made: Promise<Set<string>>; remove(): Promise<void> } {
  // __sem_open, the non-variadic trap behind sem_open: sem_open itself is variadic, and on arm64 a
  // fixed-argument call would leave its mode and value to whatever is on the stack (a decoy nobody,
  // even its owner, could open). The bridge hands a long back as a string, hence Number(). The
  // helper says which it made as one digit per name, in order.
  const script = `ObjC.bindFunction('__sem_open',['long',['char *','int','int','int']]);
ObjC.bindFunction('sem_close',['int',['long']]);
ObjC.bindFunction('sem_unlink',['int',['char *']]);
function run(a) {
  var mine = a.map(function (n) { var s = $.__sem_open(n, 2560, 384, 1); if (Number(s) === -1) return false; $.sem_close(s); return true; });
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($('made ' + mine.map(function (m) { return m ? '1' : '0'; }).join('') + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
  $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  a.forEach(function (n, i) { if (mine[i]) $.sem_unlink(n); });
  return '';
}`;
  let exited: number | null | undefined;
  let child: ReturnType<typeof spawn> | null = null;
  const gone = new Promise<void>((resolve) => {
    try {
      child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, ...names], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      exited = null;
      return resolve();
    }
    child.stdin!.on("error", () => {});
    child.once("error", () => ((exited ??= null), resolve()));
    child.once("close", (code) => ((exited ??= code), resolve()));
  });
  const kill = () => {
    try {
      child?.kill("SIGKILL");
    } catch {}
  };
  /** The names the helper said it made, once it has said: until then, and if it never does, none. */
  let mine: Set<string> | null = null;
  const made = new Promise<Set<string>>((resolve) => {
    if (!child) return resolve(new Set());
    let out = "";
    const timer = setTimeout(() => (kill(), resolve(mine ?? new Set())), SEMAPHORE_TIMEOUT_MS);
    child.stdout!.on("data", (d: Buffer) => {
      out += d;
      const said = /^made ([01]*)\n/.exec(out);
      if (!said || mine) return;
      mine = new Set(names.filter((_, i) => said[1][i] === "1"));
      clearTimeout(timer);
      resolve(mine);
    });
    void gone.then(() => (clearTimeout(timer), resolve(mine ?? new Set())));
  });
  let removed: Promise<void> | undefined;
  const remove = async () => {
    if (exited === undefined) {
      child!.stdin!.end();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([gone, new Promise<void>((r) => (timer = setTimeout(() => (kill(), r()), SEMAPHORE_TIMEOUT_MS)))]);
      clearTimeout(timer);
      await gone;
    }
    // Only a helper that was asked to remove them and then ended cleanly has: otherwise each name it
    // said it made is removed on its own.
    if (exited !== 0 && mine) unlinkSemaphores([...mine]);
  };
  return { made, remove: () => (removed ??= remove()) };
}

function listen(server: net.Server, at: number | string, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = () => (server.off("error", reject), resolve());
    if (typeof at === "string") server.listen(at, done);
    else server.listen(at, host, done);
  });
}

/**
 * A pseudo-terminal relay makes for itself, through script(1) (every Mac has it): the slave's path,
 * read from `tty` run inside it, so it is never one of the person's own terminals.
 */
export function foreignPty(): Promise<{ path: string; close(): void }> {
  return new Promise((resolve, reject) => {
    const c = spawn("/usr/bin/script", ["-q", "/dev/null", "/bin/sh", "-c", "/usr/bin/tty; exec /bin/sleep 60"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const close = () => {
      try {
        c.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => (close(), reject(new Error(`script(1) gave no terminal within 5 s: ${err.trim()}`))), 5000);
    c.stdout.on("data", (d) => {
      out += d;
      const m = /\/dev\/ttys[0-9]+/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ path: m[0], close });
      }
    });
    c.stderr.on("data", (d) => (err += d));
    c.on("error", (e) => (clearTimeout(timer), reject(e)));
    c.on("exit", () => (clearTimeout(timer), reject(new Error(`script(1) exited before giving a terminal: ${err.trim()}`))));
  });
}

/**
 * Runs the boundary probes for one launch. `launch` is what the mechanism's `wrap` returned for
 * `policy`; the canary runs through `launch.rewrap`, so it gets the same profile and parameters.
 */
export async function probeBoundary(
  launch: ConfinedLaunch, policy: ConfinementPolicy,
  /**
   * `wrap`: the same mechanism's wrap, for a decoy of a login store under the same rules (required with one).
   * `semaphores`: the decoy semaphores, when the caller has started them already; removed here, whatever happens.
   */
  opts: { harness?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; wrap?: (policy: ConfinementPolicy) => ConfinedLaunch; semaphores?: DecoySemaphores } = {},
): Promise<ProbeReport> {
  const started = performance.now();
  const tag = `.relay-probe-${crypto.randomBytes(6).toString("hex")}`;
  const servers: net.Server[] = [];
  const closers: (() => void)[] = [];
  const created: string[] = [];
  /** Config-probe paths created exclusively with the tag as marker: removed only when still that marker-bearing file (review C1/X1). */
  const configMarkers: string[] = [];
  /** Renames the probes tried, [from, to]: put back from outside should one have got through. */
  const moved: [string, string][] = [];
  const label = `me.jbkjr.relay.probe.${tag.slice(13)}`;
  const results: ProbeResult[] = [];
  let sems = opts.semaphores;
  /** The probes' scratch directory, once it is made: removed with everything in it, whatever happens. */
  let scratchDir: string | undefined;
  // Everything from here is inside the clean-up below, so that semaphores the caller handed over
  // are removed even when the probes cannot be set up (a full disk, a policy relay cannot place).
  try {
    let bounds: ReturnType<typeof boundaryPaths>;
    try {
      bounds = boundaryPaths(policy);
    } catch (err) {
      throw new ConfinementRefused("boundary", (err as Error).message);
    }
    const { worktree, tmpDir, writable } = bounds;
    const insideWritable = (p: string) => writable.some((w) => within(p, w));
    const denied = bounds.denied;

    // Targets outside the sandbox: a directory with a file to link to, a Unix socket, a TCP port, an app.
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-probe-"));
    const scratch = (scratchDir = fs.realpathSync(scratchDir));
    if (insideWritable(scratch)) {
      throw new ConfinementRefused("outside-target", `relay cannot probe this turn's confinement: its outside target ${scratch} lies inside a writable directory (is tmpDir the shared temporary directory?)`);
    }
    // The decoy semaphores (below) are made while the other targets are set up, if the caller has not begun already.
    sems ??= startDecoySemaphores();
    const { outside: semName, mp: mpName } = sems.names;
    const victim = path.join(scratch, "victim");
    fs.writeFileSync(victim, "outside\n");
    const unixPath = path.join(scratch, "s.sock");
    const unix = net.createServer((s) => s.destroy());
    const tcp = net.createServer((s) => s.destroy());
    servers.push(unix, tcp);
    await listen(unix, unixPath);
    await listen(tcp, 0);
    // IPv6 loopback, where the machine has it (every Mac's lo0 does).
    const tcp6 = net.createServer((s) => s.destroy());
    let v6: number | string;
    try {
      await listen(tcp6, 0, "::1");
      servers.push(tcp6);
      v6 = (tcp6.address() as net.AddressInfo).port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL") throw err;
      v6 = "this machine has no IPv6 loopback address";
    }
    const app = probeApp(scratch, path.join(scratch, "app-ran"));
    // A process of relay's own outside the sandbox, to signal and inspect: a decoy with an empty
    // environment, so that even an inspection that got through would find nothing of the person's.
    const outsider = spawn("/bin/sleep", ["60"], { stdio: "ignore", env: {} });
    closers.push(() => outsider.kill("SIGKILL"));
    if (!outsider.pid) throw new ConfinementRefused("signal-outside", "relay could not start a process to probe signals with");
    let pty: { path: string; close(): void };
    try {
      pty = await foreignPty();
    } catch (err) {
      throw new ConfinementRefused("foreign-pty", `relay could not make a terminal to probe this turn's confinement with (${(err as Error).message}), so it does not launch the harness`);
    }
    closers.push(pty.close);

    const checks: Record<string, { step: CanaryStep; expect: "allow" | "deny"; judge: Judge } | { skip: string; expect: "allow" | "deny" }> = {};
    const allow = (name: string, step: CanaryStep, judge: Judge = allowed) => (checks[name] = { step, expect: "allow", judge });
    const deny = (name: string, step: CanaryStep, judge: Judge = sandboxDenied) => (checks[name] = { step, expect: "deny", judge });
    const skip = (name: string, expect: "allow" | "deny", why: string) => (checks[name] = { skip: why, expect });
    // Stage 2's network checks, run in a second canary under the same rules with decoy ports and, on a
    // read turn, a decoy cwd (probe-stage2.ts).
    let stage2Decoy: { policy: ConfinementPolicy; checks: Record<string, { step: CanaryStep; expect: "allow" | "deny"; judge: Judge }> } | undefined;
    const decoy = (decoyPolicy: ConfinementPolicy & { network: Stage2Network }) => {
      if (stage2Decoy) throw new Error("the stage-2 decoy was planned twice");
      const c: Record<string, { step: CanaryStep; expect: "allow" | "deny"; judge: Judge }> = {};
      stage2Decoy = { policy: decoyPolicy, checks: c };
      return {
        allow: (name: string, step: CanaryStep, judge: Judge = allowed) => void (c[name] = { step, expect: "allow", judge }),
        deny: (name: string, step: CanaryStep, judge: Judge = sandboxDenied) => void (c[name] = { step, expect: "deny", judge }),
      };
    };

    // Whether relay created this turn's worktree (a write job): then it owns the worktree and its
    // neighbourhood (its parent is relay's worktrees directory, its siblings other jobs' worktrees).
    const relayOwnsWorktree = policy.worktreePin !== undefined;
    allow("write-tmpdir", { kind: "write", path: path.join(tmpDir, tag) });
    created.push(path.join(tmpDir, tag));
    allow("read-worktree", { kind: "readdir", path: worktree });
    if (policy.worktreeWritable) {
      allow("write-worktree", { kind: "write", path: path.join(worktree, tag) });
      created.push(path.join(worktree, tag));
    } else if (relayOwnsWorktree) {
      // A read turn on a worktree relay created: safe to write a tag into relay's own directory.
      deny("write-worktree", { kind: "write", path: path.join(worktree, tag) });
      created.push(path.join(worktree, tag));
    } else {
      // A read turn in the person's own checkout: relay does not aim a write at it; a generator test
      // covers that a read turn's worktree is not writable (review C6/X4).
      skip("write-worktree", "deny", "the worktree is the person's own checkout; a generator test covers that a read turn writes nothing there");
    }
    deny("write-outside", { kind: "write", path: path.join(scratch, "written") });
    // For a read turn the worktree is the person's own checkout, and its
    // parent, siblings and .git are the person's; relay does not aim a write at them, even one that
    // would only land on a sandbox bug. The rules for them are covered by generator tests against
    // scratch copies (test/confine.test.ts), as decided for C3.
    const beside = path.dirname(worktree);
    if (!relayOwnsWorktree) skip("write-beside-worktree", "deny", "the worktree is the person's own checkout; a generator test covers that its parent is not writable");
    else if (insideWritable(beside)) skip("write-beside-worktree", "deny", "the worktree's parent is writable by grant");
    else {
      deny("write-beside-worktree", { kind: "write", path: path.join(beside, tag) });
      created.push(path.join(beside, tag));
    }
    // Discovery that fails refuses the turn; only a genuine absence skips a probe.
    const sibling = !relayOwnsWorktree ? undefined : fs.readdirSync(beside, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(beside, d.name))
      .find((p) => p !== worktree && !insideWritable(p) && !denied.some((d) => within(p, d)));
    if (sibling) {
      deny("write-sibling-worktree", { kind: "write", path: path.join(sibling, tag) });
      created.push(path.join(sibling, tag));
    } else skip("write-sibling-worktree", "deny", relayOwnsWorktree ? "no sibling directory beside the worktree" : "the worktree is the person's own checkout; a generator test covers that a sibling is not writable");
    const { gitPointer, gitDir, commonDir } = bounds;
    if (!relayOwnsWorktree) {
      // A read turn's checkout .git is the person's: not live-probed (the whole checkout is unwritable
      // on a read turn anyway); the deny rules for it are covered by generator tests.
      skip("write-git-pointer", "deny", "the worktree is the person's own checkout; the git deny rules are covered by generator tests");
    } else {
      const pointer = fs.lstatSync(gitPointer, { throwIfNoEntry: false });
      if (pointer?.isDirectory()) {
        // A checkout's own .git directory (a read turn in the repository itself): a new file in it.
        deny("write-git-pointer", { kind: "write", path: path.join(gitPointer, tag) });
        created.push(path.join(gitPointer, tag));
      } else {
        if (!pointer) created.push(gitPointer);
        deny("write-git-pointer", { kind: "open-append", path: gitPointer });
      }
      // A .git below the repository's (the worktree's own, in a subdirectory), which would hide it from discovery.
      bounds.nestedGitPointers.forEach((p, i) => {
        if (fs.lstatSync(p, { throwIfNoEntry: false })) throw new Error(`${p} appeared while relay was probing`);
        deny(`write-nested-git-pointer-${i}`, { kind: "write", path: p });
        created.push(p);
      });
      for (const [name, d] of [["write-git-dir", gitDir], ["write-git-common-dir", commonDir]] as const) {
        if (!d || d === gitPointer || (name === "write-git-common-dir" && d === gitDir)) continue;
        deny(name, { kind: "write", path: path.join(d, tag) });
        created.push(path.join(d, tag));
      }
    }
    denied.forEach((d, i) => {
      const what = i === 0 ? "control-dir" : `denied-${i}`;
      if (!fs.lstatSync(d, { throwIfNoEntry: false })) return skip(`read-${what}`, "deny", `${d} does not exist`);
      if (!fs.statSync(d).isDirectory()) {
        // DM8 adds individual config/install files. Open existing files without truncating or
        // writing any bytes: even a broken policy must never change the person's config.
        deny(`read-${what}`, { kind: "open", path: d, flags: "r" });
        deny(`exists-${what}`, { kind: "exists", path: d });
        deny(`write-${what}`, { kind: "open", path: d, flags: "w" });
        return;
      }
      deny(`read-${what}`, { kind: "readdir", path: d });
      // Whether a name exists there (access), which Seatbelt checks apart from reads: relay's control
      // directory holds relay.db, the name probed (rule precedence, seatbelt.ts top).
      const known = fs.readdirSync(d).find((n) => n !== "." && n !== "..");
      if (known) deny(`exists-${what}`, { kind: "exists", path: path.join(d, known) });
      else skip(`exists-${what}`, "deny", `${d} is empty`);
      // These include the person's API key directory. Never aim a creating operation at
      // it, even when a broken sandbox would be the only way the write could land.
      // Write denials are exercised on the decoy below and by exact-rule generator tests.
      // Relay's own control and socket directories remain safe live write targets.
      if (d === canonical(relayHome()) || d === canonical(relaySocketsDir())) {
        deny(`write-${what}`, { kind: "write", path: path.join(d, tag) });
        created.push(path.join(d, tag));
      }
    });
    // State that outlives the turn — the real home, the real login store beside its token files, the
    // harness binary — is the person's own, so relay aims no write at it, not even one that would
    // land only on a sandbox bug. A decoy directory of relay's own, outside the writable roots, is
    // the live stand-in that the sandbox denies such a write; the rules for the real paths (home not
    // writable, login store not writable though its token file is, harness binary's directory not
    // writable) are generator tests against scratch copies (test/confine.test.ts, test/state.test.ts).
    const decoyOutside = path.join(fs.mkdtempSync(path.join(scratch, "decoy-")), "home-or-store-or-bin");
    fs.mkdirSync(decoyOutside);
    deny("write-decoy-outside", { kind: "write", path: path.join(decoyOutside, tag) });
    // Relay-owned persistent state: its writable subdirectories work; the rest of it, the files relay
    // wrote there (settings) included, cannot be changed or added to.
    const persistent = policy.state?.persistent ? persistentState(policy.state.persistent) : null;
    if (persistent) {
      persistent.writable.forEach((d, i) => {
        allow(`write-persistent-${i}`, { kind: "write", path: path.join(d, tag) });
        created.push(path.join(d, tag));
      });
      deny("write-persistent-root", { kind: "write", path: path.join(persistent.root, tag) });
      created.push(path.join(persistent.root, tag));
      for (const e of fs.readdirSync(persistent.root, { withFileTypes: true })) {
        const f = path.join(persistent.root, e.name);
        // Regular files only: never through a link (it may lead to the person's own files), never an executable.
        if (!e.isFile() || fs.statSync(f).mode & 0o111) continue;
        deny(`modify-persistent:${e.name}`, { kind: "open-append", path: f });
      }
    }
    // The harness binary's directory is the person's install location; that it is not writable is a
    // generator test (it is not among the writable roots), not a live write beside their binary.
    // Harness and tool configuration an agent could plant at the top of a writable root. Only the
    // worktree's is live-probed (the grants are the person's, so their config names are covered by
    // generator tests, not live writes — review C1/X1). A name already there (a project's own
    // .vscode, .mcp.json, a .claude/ directory) is never written or deleted: it is checked
    // non-destructively (open for writing without truncating a file; an exclusive marker inside a
    // directory). A name that is absent is created exclusively with a marker, so nothing is clobbered,
    // and only a marker-bearing file the probe made is removed. The marker is the probe's tag.
    const marker = `${tag}\n`;
    const worktreeConfig = bounds.configDenied.filter((c) => within(c, worktree));
    worktreeConfig.forEach((c, i) => {
      const st = fs.lstatSync(c, { throwIfNoEntry: false });
      if (!st) {
        deny(`write-config-${i}`, { kind: "write-excl", path: c, marker });
        configMarkers.push(c);
      } else if (st.isDirectory()) {
        const inside = path.join(c, `${tag}-cfg`);
        deny(`write-config-${i}`, { kind: "write-excl", path: inside, marker });
        configMarkers.push(inside);
      } else {
        // A file already there: opened for writing without truncating it, so its content is untouched whether the open is refused or (on a bug) allowed.
        deny(`write-config-${i}`, { kind: "open", path: c, flags: "w" });
      }
    });
    // The positive control: a lookalike name not on the list, created exclusively, must be writable.
    if (worktreeConfig.length) {
      const lookalike = path.join(worktree, ".mcp.jsonx");
      if (!fs.lstatSync(lookalike, { throwIfNoEntry: false })) {
        allow("write-config-lookalike", { kind: "write-excl", path: lookalike, marker });
        configMarkers.push(lookalike);
      } else skip("write-config-lookalike", "allow", "a file of that name is already there");
    }
    deny("hardlink-to-outside", { kind: "hardlink", from: victim, to: path.join(tmpDir, `${tag}-hl`) });
    created.push(path.join(tmpDir, `${tag}-hl`));
    deny("symlink-escape", { kind: "symlink-write", target: scratch, link: path.join(tmpDir, `${tag}-ln`), file: path.join(tmpDir, `${tag}-ln`, "through-link") });
    created.push(path.join(tmpDir, `${tag}-ln`));
    // fcntl commands that change a file through a descriptor opened read-only (F_MAKECOMPRESSED,
    // F_TRANSFEREXTENTS): tried on a decoy of relay's own outside the writable directories.
    const fcntlDecoy = path.join(scratch, "fcntl-decoy");
    fs.writeFileSync(fcntlDecoy, "decoy\n");
    deny("fcntl-makecompressed", { kind: "native", check: { op: "fcntl", path: fcntlDecoy, cmd: F_MAKECOMPRESSED } });
    deny("fcntl-transferextents", { kind: "native", check: { op: "fcntl", path: fcntlDecoy, cmd: F_TRANSFEREXTENTS } });
    // Moving a root or a protected path's ancestor away (to leave a link, or to edit what its rule
    // protects and move it back): a rename into another of relay's own writable directories, which
    // the canary undoes at once if it got through, and relay from outside if the canary did not.
    // Only directories relay made and owns are ever renamed: the worktree it created (pinned), the
    // temp dir, the state directories and relay-owned state. Never the person's granted directories
    // or anything in them: the profile's generator and the pre-turn checks cover those
    // (test/confine.test.ts), not a probe that would move the person's files if the sandbox failed.
    const relayWorktree = policy.worktreeWritable && policy.worktreePin !== undefined;
    const stateRoots = [...(policy.stateDirs ?? []).map((p) => canonical(p)), ...(bounds.persistent?.writable ?? [])];
    const owned = [tmpDir, ...stateRoots, ...(relayWorktree ? [worktree] : [])];
    const renameProbe = (name: string, from: string) => {
      const into = owned.find((w) => !within(w, from));
      if (!into) return skip(name, "deny", "no other directory of relay's own to move it into");
      const to = path.join(into, `${tag}-mv-${moved.length}`);
      moved.push([from, to]);
      deny(name, { kind: "rename", from, to });
    };
    if (relayWorktree) renameProbe("rename-worktree-root", worktree);
    else skip("rename-worktree-root", "deny", policy.worktreeWritable ? "the worktree is not one relay created (no pin), so relay does not move it" : "the worktree is not writable this turn (write-worktree shows it)");
    renameProbe("rename-tmpdir-root", tmpDir);
    stateRoots.forEach((d, i) => renameProbe(`rename-state-root-${i}`, d));
    const ancestors = bounds.fixed.filter((f) => !writable.includes(f) && f !== worktree && owned.some((o) => within(f, o)) && !bounds.hardDenied.some((d) => within(f, d)));
    if (!ancestors.length) skip("move-protected-ancestor", "deny", "no protected path has an ancestor inside relay's own writable directories but the roots themselves");
    ancestors.forEach((a, i) => renameProbe(`move-protected-ancestor-${i}`, a));
    const tcpPort = (tcp.address() as net.AddressInfo).port;
    // Stage 2 (WP-B) allows loopback but its denied ports, listening on its block, and worktree sockets
    // on write turns: its own plan replaces the checks below that it reverses (review X4).
    const stage2 = policy.network.mode === "stage2";
    if (policy.network.mode === "stage2") await planStage2Network({ allow, deny, skip, created, closers, servers, decoy }, { ...policy, network: policy.network }, { tag, worktree, tmpDir, scratch });
    if (!stage2) {
    deny("tcp-loopback", { kind: "tcp", host: "127.0.0.1", port: tcpPort, timeoutMs: STEP_TIMEOUT_MS });
    if (typeof v6 === "number") deny("tcp-loopback-v6", { kind: "tcp", host: "::1", port: v6, timeoutMs: STEP_TIMEOUT_MS });
    else skip("tcp-loopback-v6", "deny", v6);
    // Loopback by its other names: lo0's IPv6 link-local address, and any further address configured
    // on lo0, refused in both modes; and, with the network off, any other 127/8 address (127.0.0.2).
    deny("tcp-loopback-link-local", { kind: "tcp", host: "fe80::1%lo0", port: typeof v6 === "number" ? v6 : tcpPort, timeoutMs: STEP_TIMEOUT_MS });
    // Every other address of this Mac's own, IPv4-mapped and -compatible spellings included (review
    // R1: ::ffff:0.0.0.0 and ::ffff:<a LAN address> got past the network-on rule through 1.0.5),
    // refused in both modes. lo0 aliases are probed as such, next.
    const probedElsewhere = new Set(["127.0.0.1", "::1", "fe80::1%lo0", ...loopbackAliases()]);
    for (const host of localAddressSpellings()) if (!probedElsewhere.has(host)) deny(`tcp-local@${host}`, { kind: "tcp", host, port: tcpPort, timeoutMs: STEP_TIMEOUT_MS });
    loopbackAliases().forEach((a, i) => deny(`tcp-loopback-alias-${i}`, { kind: "tcp", host: a, port: tcpPort, timeoutMs: STEP_TIMEOUT_MS }));
    }
    if (policy.network.mode === "off-except-proxy") deny("tcp-loopback-127-0-0-2", { kind: "tcp", host: "127.0.0.2", port: tcpPort, timeoutMs: STEP_TIMEOUT_MS });
    else skip("tcp-loopback-127-0-0-2", "deny", "with the network on, an unconfigured 127/8 address leads nowhere, and configured ones are probed as aliases");
    deny("unix-socket", { kind: "unix", path: unixPath });
    // Unix sockets: the turn may make its own under its temp dir (the positive control), not in another
    // writable directory; and it can neither see nor reach another turn's broker, for which a decoy of
    // relay's own stands in, inside relay's sockets directory. AF_ROUTE sockets are refused outright.
    // A short name: a socket's path may not exceed 103 bytes.
    const sockName = `rp${tag.slice(13, 19)}.sock`;
    const socketProbe = (name: string, expect: "allow" | "deny", dir: string) => {
      const at = path.join(dir, sockName);
      // In the worktree, the canary's working directory, the name alone will do, however deep it is.
      const given = dir === worktree ? sockName : at;
      if (Buffer.byteLength(given) > MAX_SOCKET_PATH) return skip(name, expect, `${dir} is too deep for a Unix socket path`);
      // Allowed: listened on and connected to. Denied: the listening itself is what must be refused.
      (expect === "allow" ? allow : deny)(name, { kind: "listen-unix", path: given, connect: expect === "allow" });
      created.push(at);
    };
    socketProbe("unix-listen-tmpdir", "allow", tmpDir);
    if (stage2) { /* WP-B: planStage2Network covers worktree sockets by turn kind */ }
    else if (policy.worktreeWritable && !within(worktree, tmpDir)) socketProbe("unix-listen-worktree", "deny", worktree);
    else skip("unix-listen-worktree", "deny", "the worktree is not writable this turn");
    const decoyTurn = fs.realpathSync(fs.mkdtempSync(path.join(ensureRelaySocketsDir(), "relay-probe-")));
    closers.push(() => fs.rmSync(decoyTurn, { recursive: true, force: true }));
    const decoySocket = net.createServer((c) => c.destroy());
    servers.push(decoySocket);
    await listen(decoySocket, path.join(decoyTurn, "relay.sock"));
    deny("relay-socket-other-turn", { kind: "unix", path: path.join(decoyTurn, "relay.sock") });
    deny("read-relay-sockets", { kind: "readdir", path: relaySocketsDir() });
    deny("socket-route", { kind: "native", check: { op: "socket", domain: AF_ROUTE, type: SOCK_RAW, protocol: 0 } });
    // Mach services: an allowed one answers (the positive control, a known-present system service that
    // the allowlist grants — a controlled-allow comparison test shows it is denied once its allow is
    // removed, so the control cannot pass for the wrong reason); the pasteboard and a name of the
    // probe's own, which exists nowhere, are refused by the sandbox: 1100 (kr 44c), where an absent
    // allowed name would give 1102 (kr 44e).
    allow("mach-allowed", { kind: "native", check: { op: "mach", name: "com.apple.system.notification_center" } }, machAnswered);
    deny("mach-pasteboard", { kind: "native", check: { op: "mach", name: "com.apple.pasteboard.1" } }, machDenied);
    deny("mach-unlisted", { kind: "native", check: { op: "mach", name: `${label}.mach` } }, machDenied);
    // The certificate-trust daemon: refused by default, but when a harness takes the downgrade it must
    // answer — a real positive control that the downgrade grants it, not merely that it is not denied.
    if (policy.certificateTrust) allow("mach-trustd", { kind: "native", check: { op: "mach", name: "com.apple.trustd" } }, machAnswered);
    else deny("mach-trustd", { kind: "native", check: { op: "mach", name: "com.apple.trustd" } }, machDenied);
    // The system log's socket, the one Unix socket the profile names besides the bridge: connected,
    // never written to, so the probe adds nothing to the system log.
    allow("syslog-socket", { kind: "native", check: { op: "unix-dgram-connect", path: SYSLOG_SOCKET } });
    if (!stage2) {
      deny("listen-loopback", { kind: "listen", host: "127.0.0.1" });
      deny("listen-any", { kind: "listen", host: "0.0.0.0" });
    }
    // Another session's terminal, by path (a detached harness has none of its own unless policy.tty).
    deny("foreign-pty-read", { kind: "open", path: pty.path, flags: "r" });
    deny("foreign-pty-write", { kind: "open", path: pty.path, flags: "w" });
    // A pseudo-terminal of the turn's own (a harness running commands in one) does open.
    allow("pty-own", { kind: "native", check: { op: "openpty" } });
    // IOKit: no user client is reachable, the power-domain one (RootDomainUserClient, through
    // IOPMrootDomain) included (hardening 14). Both are refused with kIOReturnNotPermitted, which an
    // absent service (a different return) cannot imitate, so neither can pass for the wrong reason.
    deny("iokit-rootdomain", { kind: "native", check: { op: "iokit-open", serviceClass: "IOPMrootDomain" } }, iokitDenied);
    deny("iokit-foreign", { kind: "native", check: { op: "iokit-open", serviceClass: "IOSurfaceRoot" } }, iokitDenied);
    // sysctl writes: the base allows only kern.grade_cputype (the kernel then rejects the dummy value,
    // which still shows the sandbox let it through); any other sysctl write is refused.
    allow("sysctl-write-allowed", { kind: "native", check: { op: "sysctl-write", name: "kern.grade_cputype", value: "\0\0\0\0" } }, notSandboxBlocked);
    deny("sysctl-write-foreign", { kind: "native", check: { op: "sysctl-write", name: "kern.threadname", value: "relay-probe" } });
    if (policy.bridgeSocket !== undefined) allow("bridge-socket", { kind: "unix", path: canonical(policy.bridgeSocket) });
    // The bridge secret's file, where a harness's own tool helper reads it: that one file reads, and
    // nothing else of the broker directory does (its listing), nor does the file open for writing
    // (opened without truncating; nothing is written).
    if (policy.bridgeSecret !== undefined) {
      const secretFile = canonical(policy.bridgeSecret);
      allow("bridge-secret-read", { kind: "open", path: secretFile, flags: "r" });
      deny("bridge-secret-write", { kind: "open", path: secretFile, flags: "w" });
      deny("bridge-dir-list", { kind: "readdir", path: path.dirname(secretFile) });
    }
    if (policy.network.mode === "off-except-proxy") {
      deny("tcp-direct", { kind: "tcp", host: UNROUTABLE, port: 443, timeoutMs: STEP_TIMEOUT_MS });
      deny("tcp-direct-v6", { kind: "tcp", host: UNROUTABLE_V6, port: 443, timeoutMs: STEP_TIMEOUT_MS });
      // DNS: both channels must be refused by the sandbox itself (the resolver's socket, which exists
      // here outside the sandbox, and UDP), and a lookup must come back without an answer, promptly.
      if (!fs.lstatSync(MDNS_SOCKET, { throwIfNoEntry: false })?.isSocket()) throw new ConfinementRefused("dns", `relay cannot probe DNS: the system resolver's socket ${MDNS_SOCKET} is not there to be refused`);
      deny("dns-resolver-socket", { kind: "unix", path: MDNS_SOCKET });
      deny("dns-udp", { kind: "udp", host: UNROUTABLE, port: 53, timeoutMs: STEP_TIMEOUT_MS });
      deny("dns-lookup", { kind: "dns", name: DNS_NAME, timeoutMs: STEP_TIMEOUT_MS }, noAnswer);
      allow("proxy-port", { kind: "tcp", host: "127.0.0.1", port: policy.network.proxyPort, timeoutMs: STEP_TIMEOUT_MS }, reachable);
    } else {
      skip("tcp-direct", "deny", "the network is on for this turn");
      skip("tcp-direct-v6", "deny", "the network is on for this turn");
      skip("dns-resolver-socket", "deny", "the network is on for this turn");
      skip("dns-udp", "deny", "the network is on for this turn");
      skip("dns-lookup", "deny", "the network is on for this turn");
    }
    // Executables: the system's run; one outside the turn's list does not, even a harmless script.
    const script = path.join(scratch, "probe.sh");
    fs.writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    allow("exec-system", { kind: "exec", command: "/usr/bin/true", args: [], timeoutMs: 5000 });
    deny("exec-outside-list", { kind: "exec", command: script, args: [], timeoutMs: 5000 });
    deny("launchctl-submit", { kind: "exec", command: "/bin/launchctl", args: ["submit", "-l", label, "--", "/usr/bin/true"], timeoutMs: 5000 }, launchdRefused);
    // Apple events: a read-only one to the Finder; refused before it leaves the sandbox.
    deny("apple-events", { kind: "exec", command: "/usr/bin/osascript", args: ["-e", 'tell application "Finder" to count windows'], timeoutMs: 5000 }, appleEventRefused);
    // A named POSIX semaphore relay creates outside the sandbox (decoySemaphores, started above): the
    // confined canary must not open, post or unlink it (hardening 12).
    deny("sem-open-outside", { kind: "native", check: { op: "sem-open", name: semName } });
    deny("sem-post-outside", { kind: "native", check: { op: "sem-post", name: semName } });
    deny("sem-unlink-outside", { kind: "native", check: { op: "sem-unlink", name: semName } });
    // The one namespace the profile opens, /mp- (Python's multiprocessing names its semaphores
    // /mp-<random>): a decoy of relay's own there can be opened from inside. That is the positive
    // control for the deny probes above, and it shows the stated residual: the namespace is
    // machine-wide, so a /mp- semaphore of another process is reachable by its (random) name.
    allow("sem-open-mp-prefix", { kind: "native", check: { op: "sem-open", name: mpName } });
    /** The semaphore probes, each with the decoy it is aimed at. */
    const onDecoy = new Map([["sem-open-outside", semName], ["sem-post-outside", semName], ["sem-unlink-outside", semName], ["sem-open-mp-prefix", mpName]]);
    deny("signal-outside", { kind: "signal", pid: outsider.pid, signal: 0 });
    // Inspecting processes outside the sandbox: the decoy's path, its details and command line and
    // environment (KERN_PROCARGS2), its kinfo_proc, and the list of every process. The turn's own
    // process is the positive control, as is a hardware sysctl.
    deny("proc-pidpath-outside", { kind: "native", check: { op: "pidpath", pid: outsider.pid } });
    deny("proc-pidinfo-outside", { kind: "native", check: { op: "pidinfo", pid: outsider.pid } });
    deny("proc-listpids", { kind: "native", check: { op: "listpids" } });
    deny("sysctl-proc-all", { kind: "native", check: { op: "sysctl-read", name: "kern.proc.all" } });
    deny("sysctl-proc-pid-outside", { kind: "native", check: { op: "sysctl-read", mib: [CTL_KERN, KERN_PROC, KERN_PROC_PID, outsider.pid] } });
    deny("sysctl-procargs-outside", { kind: "native", check: { op: "sysctl-read", mib: [CTL_KERN, KERN_PROCARGS2, outsider.pid] } });
    allow("proc-pidpath-self", { kind: "native", check: { op: "pidpath", pid: SELF } });
    allow("sysctl-read-hw", { kind: "native", check: { op: "sysctl-read", name: "hw.ncpu" } });
    // A read-only System V IPC limit a runtime reads through sysconf (SC_SEM_NSEMS_MAX): allowed, and
    // names no process, unlike kern.proc.* above (review C2).
    allow("sysctl-read-sysv", { kind: "native", check: { op: "sysctl-read", name: "kern.sysv.semmns" } });
    // -W: had LaunchServices started the app, open would return only after it ran (and left its marker).
    deny("open-app", { kind: "exec", command: "/usr/bin/open", args: ["-W", "-g", "-j", "-n", app], timeoutMs: 5000 }, launchServicesRefused);

    // A stop that came while the targets above were being set up: no canary is started (review r_f0fce42b X2).
    const stopped = () => new ConfinementRefused("stopped", "the turn was stopped while relay was probing its sandbox, so it does not launch the harness");
    /** Runs the canary with `plan` under `l`'s confinement; what each step got. */
    const canary = async (l: ConfinedLaunch, plan: Record<string, CanaryStep>): Promise<Record<string, string>> => {
      const run = l.rewrap(process.execPath, [CANARY, JSON.stringify(plan), String(CANARY_DEADLINE_MS)]);
      if (opts.signal?.aborted) throw stopped();
      const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
        // Detached, as harnesses are launched: a new session with no controlling terminal, and a process
        // group of its own, which a timeout or a stop ends whole: the canary's osascript helper with it
        // (review r_f0fce42b X1).
        const c = spawn(run.command, run.args, { cwd: worktree, env: { ...(opts.env ?? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }), ...l.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
        const killGroup = () => {
          try {
            if (c.pid) sendGroupSignal(c.pid, "SIGKILL");
          } catch (err) {
            if (!isGroupSignalRefusal(err)) c.kill("SIGKILL");
          }
        };
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => ((timedOut = true), killGroup()), CANARY_TIMEOUT_MS);
        // A stop of the turn ends the canary at once; the launch is then refused, and cleaned up below.
        if (opts.signal?.aborted) killGroup();
        else opts.signal?.addEventListener("abort", killGroup, { once: true });
        c.once("close", () => opts.signal?.removeEventListener("abort", killGroup));
        c.stdout.on("data", (d) => (stdout += d));
        c.stderr.on("data", (d) => (stderr += d));
        c.on("error", (e) => (stderr += String(e)));
        c.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr, timedOut })));
      });
      if (opts.signal?.aborted) throw stopped();
      try {
        if (outcome.timedOut) throw new Error(`it did not finish within ${CANARY_TIMEOUT_MS} ms`);
        if (outcome.code !== 0) throw new Error(`it exited with ${outcome.code}: ${outcome.stderr.trim().slice(0, 400)}`);
        return JSON.parse(outcome.stdout);
      } catch (err) {
        throw new ConfinementRefused("canary", `relay could not run its boundary probes under this turn's confinement, so it will not launch the harness: ${(err as Error).message}`);
      }
    };
    // The decoy semaphores exist (or could not be made) before the canary starts. A probe of one
    // relay did not make is not run: the name may be another program's semaphore, which a probe
    // that got through would post or remove. It fails, which refuses the launch.
    const ours = await sems.made;
    const unmade = new Set([...onDecoy].filter(([, decoy]) => !ours.has(decoy)).map(([n]) => n));
    const plan = Object.fromEntries(Object.entries(checks).flatMap(([n, c]) => ("step" in c && !unmade.has(n) ? [[n, c.step]] : [])));
    const got = await canary(launch, plan);
    for (const n of unmade) got[n] = "not run: relay could not make this decoy semaphore (or its name was already taken)";
    // Side effects, checked from outside: no launchd job and no app run, whatever the commands said.
    if (got["launchctl-submit"] !== undefined && launchdListed(label)) got["launchctl-submit"] = "allowed (launchd has the job)";
    if (got["open-app"] !== undefined && fs.existsSync(path.join(scratch, "app-ran"))) got["open-app"] = "allowed (the app ran)";
    for (const [name, c] of Object.entries(checks)) {
      if ("skip" in c) results.push({ name, expect: c.expect, got: `skipped: ${c.skip}`, ok: true });
      else {
        const g = got[name] ?? "missing";
        results.push({ name, expect: c.expect, target: stepTarget(c.step), got: g, ok: c.judge(g) });
      }
    }
    // Stage 2's ports and a read turn's cwd: the turn's rules with decoy values (its denied ports and
    // the person's cwd are never aimed at), which must be exactly the turn's rules, as for a login
    // store's decoy below.
    if (stage2Decoy) {
      if (!opts.wrap) throw new ConfinementRefused("probe-setup", "relay cannot probe a stage-2 turn's network without aiming its rules at decoys, so it does not launch the harness");
      const decoyLaunch = opts.wrap(stage2Decoy.policy);
      if (decoyLaunch.rules !== launch.rules) throw new Error("the stage-2 decoys (ports, and a read turn's cwd) are not under this turn's rules");
      const s2 = stage2Decoy.checks;
      const s2Got = await canary(decoyLaunch, Object.fromEntries(Object.entries(s2).map(([n, c]) => [n, c.step])));
      for (const [name, c] of Object.entries(s2)) {
        const g = s2Got[name] ?? "missing";
        results.push({ name, expect: c.expect, target: stepTarget(c.step), got: g, ok: c.judge(g) });
      }
    }
    // A login store (TokenStore) is the person's own, so relay aims nothing at it: the same rules,
    // their parameters pointed at a decoy store of relay's own laid out the same, get the store's
    // probes (docs/design-token-store.md). The refresh itself is the positive control.
    if (bounds.store) {
      const real = bounds.store;
      if (!opts.wrap) throw new ConfinementRefused("probe-setup", `relay cannot probe ${real.name} without aiming its rules at a decoy, so it does not launch the harness`);
      const decoy = path.join(scratch, "decoy-store");
      fs.mkdirSync(decoy, { mode: 0o700 });
      const named = [...real.files, ...real.locks].map((f) => path.basename(f));
      const plain = (n: string) => !real.tempName.test(n) && !named.includes(n);
      for (const f of real.files) fs.writeFileSync(path.join(decoy, path.basename(f)), "decoy token\n", { mode: 0o600 });
      real.subdirs.forEach((_, j) => fs.mkdirSync(path.join(decoy, `decoy-sub-${j}`), { mode: 0o700 }));
      const other = path.join(decoy, "decoy-other");
      fs.writeFileSync(other, "decoy\n", { mode: 0o600 });
      if (![path.basename(other), `decoy-new${tag}`, ...real.subdirs.map((_, j) => `decoy-sub-${j}`)].every(plain)) throw new Error(`the decoy names clash with ${real.name}'s pattern`);
      const state = policy.state!;
      const decoyLaunch = opts.wrap({ ...policy, state: { ...state, tokenStore: { ...state.tokenStore!, dir: decoy } } });
      if (decoyLaunch.rules !== launch.rules) throw new Error(`the decoy for ${real.name} is not under this turn's rules`);
      const temps = tempNames(real.tempName, 6).map((n) => path.join(decoy, n));
      const token = path.join(decoy, path.basename(real.files[0]));
      const s: Record<string, { step: CanaryStep; expect: "allow" | "deny"; judge: Judge }> = {};
      const yes = (name: string, step: CanaryStep) => (s[name] = { step, expect: "allow", judge: allowed });
      const no = (name: string, step: CanaryStep) => (s[name] = { step, expect: "deny", judge: sandboxDenied });
      yes("store-rewrite-token", { kind: "open-append", path: token });
      yes("store-refresh", { kind: "refresh", temp: temps[0], onto: token });
      if (real.locks.length) yes("store-lock", { kind: "lock", path: path.join(decoy, path.basename(real.locks[0])) });
      no("store-other-name", { kind: "write", path: path.join(decoy, `decoy-new${tag}`) });
      no("store-other-file", { kind: "open-append", path: other });
      no("store-symlink-temp", { kind: "symlink", target: victim, link: temps[1] });
      no("store-hardlink-temp", { kind: "hardlink", from: victim, to: temps[2] });
      // A file the turn may write, linked in: only the store's file-link deny stops this one (measured).
      const own = path.join(tmpDir, `${tag}-own`);
      fs.writeFileSync(own, "decoy\n", { mode: 0o600 });
      created.push(own);
      no("store-hardlink-own-temp", { kind: "hardlink", from: own, to: temps[5] });
      no("store-mkdir-temp", { kind: "mkdir", path: temps[3] });
      no("store-symlink-onto-token", { kind: "symlink-rename", target: victim, link: path.join(tmpDir, `${tag}-link`), onto: token });
      no("store-token-out-tmp", { kind: "hardlink", from: token, to: path.join(tmpDir, `${tag}-token`) });
      no("store-other-mode", { kind: "chmod", path: other, mode: 0o644 });
      if (real.subdirs.length) no("store-subdir-temp", { kind: "write", path: path.join(decoy, "decoy-sub-0", path.basename(temps[4])) });
      created.push(path.join(tmpDir, `${tag}-link`), path.join(tmpDir, `${tag}-token`));
      // Review r_75bf1f48: other file types and a file of two names brought in, exchanges, ordinary
      // renames across the store's edge, an unescaped dot, xattrs; a rename in is the positive control.
      const more = tempNames(real.tempName, 12).slice(6).map((n) => path.join(decoy, n));
      const own2 = (n: string) => path.join(tmpDir, `${tag}-${n}`);
      created.push(own2("d"), own2("fifo"), own2("a"), own2("b"), own2("in"), own2("swap"));
      no("store-dir-rename-in", { kind: "mkdir-rename", dir: own2("d"), onto: more[0] });
      no("store-fifo-rename-in", { kind: "fifo-rename", fifo: own2("fifo"), onto: more[1] });
      no("store-pair-rename-in", { kind: "pair-rename", a: own2("a"), b: own2("b"), onto: more[2] });
      fs.writeFileSync(own2("in"), "decoy\n", { mode: 0o600 });
      yes("store-rename-in", { kind: "rename", from: own2("in"), to: more[3] });
      no("store-rename-token-away", { kind: "rename", from: token, to: path.join(decoy, `decoy-away${tag}`) });
      no("store-rename-other-in", { kind: "rename", from: other, to: more[4] });
      if (real.locks.length) {
        const lockPath = path.join(decoy, path.basename(real.locks[0]));
        if (!fs.existsSync(lockPath)) fs.writeFileSync(lockPath, "decoy\n", { mode: 0o600 });
        no("store-lock-unlink", { kind: "unlink", path: lockPath });
        // The exchange's other side, a link of relay's own in the turn's temp dir, made from outside.
        fs.symlinkSync(victim, own2("swap"));
        no("store-exchange-lock", { kind: "native", check: { op: "rename-swap", from: own2("swap"), to: lockPath } });
      }
      no("store-xattr-token", { kind: "native", check: { op: "setxattr", path: token } });
      // A name the pattern would match were its dots not escaped (the temp name with its first "." made "x").
      const undotted = path.basename(temps[0]).replace(".", "x");
      if (!real.tempName.test(undotted) && undotted !== path.basename(temps[0])) no("store-dot-escape", { kind: "write", path: path.join(decoy, undotted) });
      const storeGot = await canary(decoyLaunch, Object.fromEntries(Object.entries(s).map(([n, c]) => [n, c.step])));
      for (const [name, c] of Object.entries(s)) {
        const g = storeGot[name] ?? "missing";
        results.push({ name, expect: c.expect, target: stepTarget(c.step), got: g, ok: c.judge(g) });
      }
    }
  } catch (err) {
    if (err instanceof ConfinementRefused) throw err;
    throw new ConfinementRefused("probe-setup", `relay could not set up its boundary probes for this turn (${(err as Error).message}), so it does not launch the harness`);
  } finally {
    // The decoy semaphores go while the rest is cleaned up; removed before this returns.
    const unsems = sems?.remove();
    for (const s of servers) s.close();
    for (const c of closers) c();
    // A rename that got through and was not undone inside: put back before anything is removed.
    for (const [from, to] of moved) {
      if (!fs.lstatSync(from, { throwIfNoEntry: false }) && fs.lstatSync(to, { throwIfNoEntry: false })) {
        try {
          fs.renameSync(to, from);
        } catch {}
      }
    }
    // Undo whatever the probes managed: theirs inside, and anything an escape left outside. Only the
    // regular files and links the probes make are removed, each on its own; a directory at one of
    // these paths is never deleted, let alone recursively (a `.git` the probe did not create, say, or
    // repository metadata another process made since — review C2).
    for (const p of created) removeProbeArtifact(p);
    // Config markers: removed only when the path is still the exact marker-bearing file the probe
    // created, so a project's own config file that happens to share the path is never deleted (C1/X1).
    for (const p of configMarkers) removeProbeMarker(p, `${tag}\n`);
    if (launchdListed(label)) {
      try {
        execFileSync("/bin/launchctl", ["remove", label], { stdio: "ignore" });
      } catch {}
    }
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    await unsems;
  }
  // An escape outranks an inconclusive result (a timeout, say): it is the finding that matters.
  const failed = results.find((r) => !r.ok && r.expect === "deny" && r.got.startsWith("allowed")) ?? results.find((r) => !r.ok);
  return { ok: !failed, profile: launch.fingerprint, relay: VERSION, os: osBuild(), ms: Math.round(performance.now() - started), results, ...(failed ? { failed } : {}) };
}

/** The kernel release and the OS build (kern.osversion), asked every time: an update between turns shows. */
function osBuild(): string {
  let build = "unknown build";
  try {
    build = execFileSync("/usr/sbin/sysctl", ["-n", "kern.osversion"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {}
  return `${os.release()} (${build})`;
}

/** What a step is tried against, for the report. */
/**
 * `n` distinct names matching a login store's temp pattern (of the form tokenStore checks): each
 * atom once, its first character for a class, and the first repeated atom repeated more each time.
 */
export function tempNames(pattern: RegExp, n: number): string[] {
  const atoms = [...pattern.source.slice(1, -1).matchAll(/(\\\.|\[([A-Za-z0-9-]+)\]|[A-Za-z0-9_-])([+*]?)/g)].map((m) => ({ ch: m[1] === "\\." ? "." : m[2] ? m[2][0] : m[1], q: m[3] }));
  const grow = atoms.findIndex((a) => a.q);
  const out = Array.from({ length: n }, (_, i) => atoms.map((a, j) => a.ch.repeat(j === grow ? i + 1 : a.q === "*" ? 0 : 1)).join(""));
  if (grow < 0 || !out.every((x) => pattern.test(x)) || new Set(out).size !== n) throw new Error(`relay could not make names for the temp pattern ${pattern.source}`);
  return out;
}

function stepTarget(s: CanaryStep): string {
  switch (s.kind) {
    case "tcp":
    case "udp":
    case "listen-port":
    case "udp-bind":
      return `${s.host}:${s.port}`;
    case "listen":
      return s.host;
    case "dns":
      return s.name;
    case "exec":
      return [s.command, ...s.args].join(" ");
    case "hardlink":
    case "rename":
      return `${s.from} -> ${s.to}`;
    case "symlink-write":
      return s.file;
    case "refresh":
      return `${s.temp} -> ${s.onto}`;
    case "symlink":
      return s.link;
    case "symlink-rename":
      return `${s.link} -> ${s.onto}`;
    case "mkdir-rename":
      return `${s.dir} -> ${s.onto}`;
    case "fifo-rename":
      return `${s.fifo} -> ${s.onto}`;
    case "pair-rename":
      return `${s.b} -> ${s.onto}`;
    case "signal":
      return `pid ${s.pid}`;
    case "native":
      return nativeTarget(s.check);
    default:
      return s.path;
  }
}

/** What a native check is tried against, for the report. */
function nativeTarget(c: NativeCheck): string {
  switch (c.op) {
    case "fcntl":
      return `fcntl ${c.cmd} on ${c.path}`;
    case "pidpath":
    case "pidinfo":
      return `${c.op} of pid ${c.pid}`;
    case "listpids":
      return "proc_listpids";
    case "sysctl-read":
      return "name" in c ? `sysctl ${c.name}` : `sysctl ${c.mib.join(".")}`;
    case "socket":
      return `socket(${c.domain}, ${c.type}, ${c.protocol})`;
    case "unix-dgram-connect":
      return c.path;
    case "mach":
      return `mach-lookup ${c.name}`;
    case "openpty":
      return "openpty";
    case "iokit-open":
      return `IOServiceOpen ${c.serviceClass}`;
    case "sysctl-write":
      return `sysctl-write ${c.name}`;
    case "sem-open":
    case "sem-post":
    case "sem-unlink":
      return `${c.op} ${c.name}`;
    case "rename-swap":
      return `${c.from} <-> ${c.to}`;
    case "setxattr":
      return `setxattr ${c.path}`;
  }
}

/**
 * Removes one thing a probe may have created, safely: a regular file or a link is unlinked; a
 * directory is left untouched, never removed recursively, so a `.git` directory the probe did not
 * create, or repository metadata a concurrent process made, is never deleted (review C2). Missing is
 * nothing to do.
 */
export function removeProbeArtifact(p: string): void {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) {
    // Only a directory the probe itself made (empty, named with its tag) is removed, and never recursively.
    try {
      fs.rmdirSync(p);
    } catch {
      // Not empty, or not ours: leave it.
    }
    return;
  }
  try {
    fs.unlinkSync(p);
  } catch {
    // Already gone.
  }
}

/** Removes a config-probe artifact only when it is a regular file whose whole content is the probe's marker: never a project's own file, whatever the path. */
export function removeProbeMarker(p: string, marker: string): void {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st || !st.isFile() || st.size !== Buffer.byteLength(marker)) return;
  try {
    if (fs.readFileSync(p, "utf8") === marker) fs.unlinkSync(p);
  } catch {
    // Gone, or unreadable: leave it.
  }
}

/** Whether launchd has a job by this label (asked from outside the sandbox). */
function launchdListed(label: string): boolean {
  try {
    execFileSync("/bin/launchctl", ["list", label], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Throws ConfinementRefused naming the failed probe (ProbeReport.failed). */
export function assertProbes(report: ProbeReport): void {
  const f = report.failed;
  if (!f) return;
  const what = f.expect === "deny" ? (f.got.startsWith("allowed") ? `escaped (${f.got})` : `was not shown to be refused by the sandbox (${f.got})`) : `was refused (${f.got})`;
  throw new ConfinementRefused(f.name, `relay will not launch the harness: boundary probe ${f.name} ${what}; expected ${f.expect}`, report);
}
