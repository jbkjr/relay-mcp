import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { confinement, type ConfinedLaunch, type Confinement, type ConfinementPolicy, type ProbeReport } from "../confine/index.js";
import { deniedTcpPorts, INTERFACE_POLL_MS, interfaceAddresses, leaseTurnPorts, listeningSnapshot, STATIC_DENIED_UDP, watchInterfaces, type InterfaceWatch, type LeaseOptions, type PortLease } from "../confine/ports.js";
import { sandboxCheckUnavailable, sandboxReports } from "../confine/sbcheck.js";
import type { Stage2Network } from "../confine/seatbelt-stage2.js";
import { boundaryProbe, NO_PROBE } from "../confine/turn-probe.js";
import { turnPolicy } from "../confine/turn.js";
import { getNode, getTurn, recordLaunchLeader } from "../core/db.js";
import { registerEscalationRuntime } from "../core/escalation-contract.js";
import { createEscalationRuntime } from "../core/escalation-runtime.js";
import { escalationDigest } from "../core/escalation-policy.js";
import { mediatedBaseline, mediatedNetworkProvider, needsMediatedNetwork, NO_MEDIATED_PROVIDER, MEDIATED_NETWORK_EFFECT, type MediatedNetworkLaunch } from "../core/mediated-network-provider.js";
import { drainGroup, groupAlive, isGroupSignalRefusal, pidAlive, procStart, sameProcess, sendGroupSignal, stopProcs, type Proc, type Watch } from "../core/procs.js";
import { diagnosticTail } from "../core/redact.js";
import { assertOverlayLaunch, overlayTurnProblem } from "../core/restart-overlay.js";
import { dirIdentity } from "../confine/seatbelt.js";
import { redact, registerTurnSecret } from "../core/secrets.js";
import { executorQuarantine, forgetExecutor, noteDescendants, recordExecutor, sweepSurvivorsNow, sweepTurnSurvivors as turnSurvivors, taintExecutor } from "../core/stage2-executors.js";
import type { PreparedState } from "./acp.js";
import { deniedCredentials } from "./codex.js";
import type { openHttpBroker, HttpBroker } from "../confine/broker-http.js";
import { codexToolTimeoutS } from "../targets/codex.js";
import { watchProcess, type TurnSpec } from "./types.js";
import { Stage2TurnGuard, stage2Admission, stage2AppServerEnv, stage2ApprovalDetail, stage2CommandEnvironmentProblem, stage2Plan, stage2QueueProblem, stage2Readback, stage2ThreadMcpProblem, stage2ThreadParams, stage2ThreadProblem, stage2TurnParams, stage2TurnReadback, type RpcLike, type Stage2Plan } from "./codex-stage2.js";

/**
 * Stage 2's executor: `codex exec-server` inside relay's Seatbelt, bound to the app server's thread
 * as its only environment, supervised and torn down with the turn (docs/codex-confinement-design.md
 * §2.2, §3.1; review C5, X3, X7, C8). Owner: WP-C. codex.ts calls openStage2; codex-app.ts calls the
 * Stage2Session hooks at the points named on each.
 */

/** The environment id relay adds and the thread selects. */
export const STAGE2_ENVIRONMENT_ID = "relay";

/** The hooks startCodexAppTurn calls for a stage-2 turn. Undefined for every other turn, which then runs exactly as before. */
export interface Stage2Session {
  /** Once, after spawn and before initialize: pin the HTTP client by pid and start time. */
  bindAppServer(pid: number): void;
  /** Immediately before thread/start or thread/resume: evidence checkpoint, excluding the threadless listing. */
  sessionsServed(): number;
  /** After the thread reply: require its connected MCP session and exact tool set. */
  threadMcpProblem(rpc: RpcLike, eff: Record<string, any>, threadId: string, checkpoint: number): Promise<string | null>;
  /** Immediately after guard.replied confirms relay's turn, before awaiting its environment readback (§14). */
  armTools(threadId?: string, nativeTurn?: string): void;
  /** At relay's turn/completed and teardown. */
  disarmTools(): void;
  /** After initialize: environment/add with the executor's URL and the token (never logged). A problem fails the turn. */
  bind(rpc: RpcLike): Promise<string | null>;
  /** After config/read: no `local` environment, only the expected broker, pinned features and no hooks. */
  readback(rpc: RpcLike, eff: Record<string, any>): Promise<string | null>;
  /** Overlaid on thread/start and thread/resume params: environments and approvalPolicy "on-request" (stage2ThreadParams; thread/resume ignores the environments). */
  threadParams(cwd: string): Record<string, unknown>;
  /** Before thread/resume of a stage-2 session: nothing queued that Codex would start by itself before the turn is bound (stage2QueueProblem). A problem fails the turn. */
  resumeProblem(rpc: RpcLike, threadId: string): Promise<string | null>;
  /** After thread/start (`resumed` false: exactly relay's executor) or thread/resume (`resumed` true: relay's executor, or none; never `local`): stage2ThreadProblem. */
  threadProblem(t: unknown, cwd: string, resumed: boolean): string | null;
  /** Overlaid on every turn/start, fresh or resumed: the executor as the turn's only environment (stage2TurnParams). Never omitted on a stage-2 turn. */
  turnParams(cwd: string): Record<string, unknown>;
  /** After turn/start's reply: the thread's environments read back, exactly relay's executor (stage2TurnReadback). A problem: kill the app server, fail the turn. */
  turnProblem(rpc: RpcLike, threadId: string, cwd: string): Promise<string | null>;
  /** The turns Codex starts during this turn (Stage2TurnGuard): request() before turn/start, started() on every turn/started, replied() with turn/start's reply. A problem: kill the app server, fail the turn. */
  readonly guard: Stage2TurnGuard;
  /**
   * Before every command or file-change approval relay would show or answer: this Mac's addresses
   * unchanged since the turn began (InterfaceWatch.changed), and a command's environment relay's
   * executor (stage2CommandEnvironmentProblem, review R4). A problem: decline, kill the app server,
   * fail the turn.
   */
  approvalProblem(kind: "command" | "file", environmentId?: unknown): string | null;
  /** Merged into the detail of command and file-change approvals only: stage2ApprovalDetail (commands marked confined, file changes not). */
  approvalDetail(kind: "command" | "file"): Record<string, unknown>;
  /**
   * The environment admission checked, with relay's no-local setting, broker token and loopback
   * proxy bypass over it, frozen: startCodexAppTurn launches
   * the app server with exactly this object and refuses any other.
   */
  readonly env: Readonly<NodeJS.ProcessEnv>;
  /** Called once the app server runs: `fail` when the executor exits or the Mac's addresses change. startCodexAppTurn kills the app server first, then fails the turn. */
  watch(fail: (error: string) => void): void;
  /** After the app server has gone: stop the executor and sweep. On group refusal, only quarantine its record and close independent resources; never signal or sweep derived processes. */
  teardown(appCleanup?: { survivors: number[]; descendants?: Proc[]; uncertain?: boolean; refused?: string }): Promise<{ survivors: number[]; warnings: string[]; uncertain?: boolean }>;
}

/** What codex.ts gets back: the plan for codexFlags, the hooks for startCodexAppTurn, and abort for a failure in between. */
export interface Stage2Launch {
  plan: Stage2Plan;
  session: Stage2Session;
  /** Stops the executor and releases everything when the turn fails before startCodexAppTurn takes over. */
  abort(reason: string): Promise<void>;
}

/** What openStage2 takes from the other packages (A: ports and interfaces; D: admission and plan), in one place. */
interface Stage2Deps {
  admission: typeof stage2Admission;
  plan: typeof stage2Plan;
  lease: (proxy?: boolean) => PortLease;
  /** The TCP ports this turn denies: the static list, then the listening snapshot (decision D4). */
  deniedTcp: (own: PortLease) => number[];
  snapshot: typeof listeningSnapshot;
  interfaces: typeof interfaceAddresses;
  watchInterfaces: (baseline: string[]) => InterfaceWatch;
  openBroker: typeof openHttpBroker;
  sweepProblem: typeof sandboxCheckUnavailable;
  confinement: typeof confinement;
  probe: typeof boundaryProbe;
  resolveBin: typeof resolveBin;
  policy: typeof executorPolicy;
  launch: typeof launchExecutor;
  stop: typeof stopExecutor;
  appStart: typeof procStart;
  turnReadback: typeof stage2TurnReadback;
}

const REAL: Stage2Deps = {
  admission: stage2Admission, plan: stage2Plan, lease: (proxy) => leaseTurnPorts({ proxy }), deniedTcp: (own) => deniedTcpPorts(listeningSnapshot(), own), snapshot: listeningSnapshot,
  interfaces: interfaceAddresses, watchInterfaces: (baseline) => watchInterfaces(baseline),
  // Loaded with the first turn that opens one (it brings the MCP server and SDK), not with every worker.
  openBroker: async (...a) => (await import("../confine/broker-http.js")).openHttpBroker(...a), sweepProblem: sandboxCheckUnavailable, confinement, probe: boundaryProbe,
  resolveBin, policy: executorPolicy, launch: launchExecutor, stop: stopExecutor, appStart: procStart, turnReadback: stage2TurnReadback,
};

// Unit tests replace host resources; live tests leave every resource real unless explicitly testing a failure.
let testDeps: Partial<Stage2Deps> | null = null;
export function setStage2DepsForTests(d: Partial<Stage2Deps> | null): void { testDeps = d; }

/**
 * The normal live-test overrides: this Mac's interface
 * addresses (a unit test must change them mid-turn), and the port range leases come from (tests
 * running beside other relay processes take a scratch range, so their leases, kept per relay home,
 * cannot collide with those processes' executors). The lease, the profile and every check stay
 * relay's own. Nothing in relay calls the setters.
 */
let interfaceReader: (() => string[]) | null = null;
let leaseOptions: LeaseOptions | null = null;

/** Test-only: read this Mac's interface addresses from `read` (for the baseline and the watch), or null for the real ones. */
export function setInterfaceReaderForTests(read: (() => string[]) | null): void {
  interfaceReader = read;
}

/** Test-only: lease ports with these options (a scratch range or lease directory), or null for relay's reserved range. */
export function setLeaseOptionsForTests(o: LeaseOptions | null): void {
  leaseOptions = o;
}

/**
 * Test-only: where a live test looks at, or acts on, relay's own app server mid-turn (nothing in relay
 * sets it). "queue-checked": thread/resume's queue check has passed, and thread/resume is next (a
 * test queues a message here, as the race after the check would). "thread-reply": the reply of
 * thread/start or thread/resume, before relay checks it. "turn-bound": relay's turn/start and its
 * readback have succeeded. The hook's errors are the test's own and are not caught.
 */
export type Stage2TestHook = (point: "queue-checked" | "thread-reply" | "turn-bound", o: { rpc?: RpcLike; threadId?: string; reply?: unknown; resumed?: boolean }) => Promise<void> | void;
let testHook: Stage2TestHook | null = null;
export function setStage2HookForTests(hook: Stage2TestHook | null): void {
  testHook = hook;
}
const deps = (): Stage2Deps => {
  const read = interfaceReader, lease = leaseOptions;
  return {
    ...REAL,
    ...(read ? { interfaces: () => read(), watchInterfaces: (baseline: string[]) => watchInterfaces(baseline, INTERFACE_POLL_MS, read) } : {}),
    ...(lease ? { lease: (proxy: boolean | undefined) => leaseTurnPorts({ ...lease, proxy }) } : {}),
    ...testDeps,
  };
};

/** How long relay waits for the executor to print its URL, and for the kernel to report it sandboxed. */
const READY_MS = 15000;
const CONFINED_WAIT_MS = 5000;
/** The executor's grace after SIGTERM at teardown: it holds nothing of the person's that needs saving. */
const EXECUTOR_GRACE_MS = 500;

/** An executable named on PATH (or given as a path), as an absolute, resolved path, or null. Seatbelt needs it absolute. */
function resolveBin(bin: string, env: NodeJS.ProcessEnv): string | null {
  const ok = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (bin.includes("/")) return ok(path.resolve(bin)) ? fs.realpathSync(path.resolve(bin)) : null;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir && path.isAbsolute(dir) && ok(path.join(dir, bin))) return fs.realpathSync(path.join(dir, bin));
  }
  return null;
}

/** The executor's own CODEX_HOME: inside the turn's temp dir, so nothing of ~/.codex is needed or reachable (§3.1, D8). */
const executorHome = (tmpDir: string) => path.join(tmpDir, "codex-exec-home");

/**
 * The executor's environment, from which it builds every command's (review C8): relay's scrubbed
 * agent environment and its own CODEX_HOME and TMPDIR. When the turn may bind the job's port block,
 * it is advertised as PORT and PORTS (§5.5); closed turns are not told to use denied ports. The
 * launch adds the sandbox's own variables on top. Every route that would point Codex at another
 * executor is left out.
 */
export function executorEnv(agent: NodeJS.ProcessEnv, tmpDir: string, ports: Pick<PortLease, "block">, blockBindAllowed: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(agent)) {
    if (v === undefined || k === "CODEX_HOME" || k === "CODEX_EXEC_SERVER_URL" || /^CODEX_.*NOISE/i.test(k)) continue;
    env[k] = v;
  }
  env.CODEX_HOME = executorHome(tmpDir);
  env.TMPDIR = tmpDir;
  if (blockBindAllowed) {
    env.PORT = String(ports.block[0]);
    env.PORTS = ports.block.join(",");
  }
  return env;
}

/** The policy for the executor: turnPolicy with the stage-2 network, AF_UNIX by turn kind, CODEX_HOME in the turn's temp dir, ~/.codex and the credential stores denied (§2.3). */
export function executorPolicy(spec: TurnSpec, tmpDir: string, net: Stage2Network): ConfinementPolicy {
  const home = executorHome(tmpDir);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // The person's real HOME, read-only, as Codex's own sandbox gives commands today; the executor
  // writes only its temp CODEX_HOME. No keychain, no certificate trust (§3.1: trustd fetches past the profile).
  const state = { home: "real", stateDirs: [home], keychain: false } as PreparedState;
  const policy = turnPolicy(spec, state, tmpDir, net, os.homedir(), "Codex's executor");
  // The 1.0.5 credential denies, and all of ~/.codex and the app server's CODEX_HOME (decision D8).
  const appHome = spec.environment?.CODEX_HOME;
  const codexHomes = [path.join(os.homedir(), ".codex"), ...(appHome && path.isAbsolute(appHome) ? [appHome] : [])];
  const credentials = Object.keys(deniedCredentials(undefined, spec.config)).filter((p) => !p.endsWith("/auth.json")).map((p) => p.replace(/^~(?=\/)/, os.homedir()));
  const roots = spec.overlay?.request.roots ?? [];
  const trees = roots.filter(r => r.scope === "tree");
  return { ...policy, ...(spec.neverPolicy ? { neverPolicy: spec.neverPolicy } : {}),
    writable: [...(policy.writable ?? []), ...trees.map(r => r.root)],
    ...((policy.writablePins?.length || trees.length) ? { writablePins: [...(policy.writablePins ?? []), ...trees.map(r => dirIdentity(r.root))] } : {}),
    overlayFiles: roots.filter(r => r.scope === "file"),
    overlayRoots: roots,
    denied: [...new Set([...policy.denied, ...credentials, ...codexHomes])] };
}

/** A fresh executor token: 32 random bytes, registered as a turn secret, and its SHA-256 for argv. Never written anywhere. */
export function executorToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("hex");
  registerTurnSecret(token, "executor token");
  return { token, hash: crypto.createHash("sha256").update(token).digest("hex") };
}

/** A running executor. */
export interface Executor {
  pid: number;
  start: string;
  /** ws://127.0.0.1:<port>, as the executor printed it. */
  url: string;
  ports: PortLease;
  launch: ConfinedLaunch;
  probes: ProbeReport;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * What relay keeps of a running executor beyond the interface: the watch on its descendants, its
 * output tail, its process, and its record on disk (core/stage2-executors.ts) with the timer that
 * copies newly seen descendants into it.
 */
const running = new WeakMap<Executor, { watch: Watch; tail: ReturnType<typeof diagnosticTail>; child: ReturnType<typeof spawn>; record: string; persist: NodeJS.Timeout }>();

/** How often newly seen descendants are copied into the executor's record, for whoever must stop them if this process dies. */
const PERSIST_MS = 1000;

/** The last lines the executor wrote, redacted: for a failure message. */
const lastWords = (tail: { text(): string }) => tail.text().trim().split("\n").slice(-3).join(" ");

/** Spawns the executor under `launch` as a detached, registered launch leader with relay's scrubbed env, checks it is sandboxed and reads its URL (§2.2 step 9). */
export async function launchExecutor(o: { spec: TurnSpec; bin: string; launch: ConfinedLaunch; probes: ProbeReport; ports: PortLease; hash: string; env: NodeJS.ProcessEnv; tmpDir: string; signal?: AbortSignal; mechanism?: Confinement }): Promise<Executor> {
  const { spec, launch, ports } = o;
  // The launch must run exactly the executor relay asked for, on its leased port, with the token's hash.
  const want = [o.bin, "exec-server", "--listen", `ws://127.0.0.1:${ports.exec}`, "--ws-auth", "capability-token", "--ws-token-sha256", o.hash];
  const tailArgs = launch.args.slice(-want.length);
  if (want.some((a, i) => tailArgs[i] !== a)) throw new Error("relay's executor launch is not the command it prepared, so it does not start it");
  let mechanism = o.mechanism;
  if (!mechanism) {
    const found = confinement();
    if ("reason" in found) throw new Error(`relay cannot confine Codex's commands: ${found.reason}`);
    mechanism = found.mechanism;
  }
  const tail = diagnosticTail();
  const child = spawn(launch.command, launch.args, { cwd: spec.cwd, env: { ...o.env, ...launch.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let spawnError: Error | null = null;
  child.on("error", (err) => (spawnError = err));
  child.stdout!.on("data", (d: Buffer) => {
    if (out.length < 4096) out += d.toString();
    tail.write(d.toString());
  });
  child.stderr!.on("data", (d: Buffer) => tail.write(d.toString()));
  let gone: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve((gone = { code, signal }))));
  const pid = child.pid ?? -1;
  let watch: Watch | null = null;
  let record: string | null = null;
  let persist: NodeJS.Timeout | null = null;
  try {
    if (pid <= 1) {
      await new Promise((r) => setImmediate(r));
      throw new Error(`relay could not start Codex's executor: ${(spawnError as Error | null)?.message ?? "no process"}`);
    }
    // A launch leader like the agents relay starts (session.ts): a process left in its group or
    // session is placed inside the launched tree after it exits (core/presence.ts).
    recordLaunchLeader(spec.markers.runId, pid, "agent", spec.markers.nodeId);
    const start = procStart(pid, { fresh: true });
    if (!start) throw new Error("relay could not read the identity of Codex's executor, so it stopped it");
    // Recorded on disk, and named on its ports' lease, as soon as its identity is known: should this
    // process die from here on, reap, cancel or the retention sweep stops it and gives the ports back
    // (core/stage2-executors.ts), and no other relay process leases its ports while it lives.
    // The record first, so that the lease can name it: while the record is there (a teardown that
    // was not sure keeps it, tainted), the ports stay quarantined.
    record = recordExecutor({ pid, start, runId: spec.markers.runId, nodeId: spec.markers.nodeId, turnId: spec.turnId ?? null, ports: { exec: ports.exec, block: ports.block }, tmpDir: o.tmpDir });
    ports.hold?.(pid, start, record);
    watch = watchProcess(pid);
    const w = watch, file = record;
    let noted = 0;
    persist = setInterval(() => {
      const procs = w.procs();
      if (procs.length === noted) return;
      try {
        noteDescendants(file, procs);
        noted = procs.length;
      } catch {
        // Tried again at the next tick; teardown does not depend on it.
      }
    }, PERSIST_MS);
    persist.unref();
    // sandbox-exec applies the profile and execs Codex in the same process: that pid is the one to ask.
    const until = Date.now() + CONFINED_WAIT_MS;
    while (!mechanism.confined(pid)) {
      if (gone || Date.now() > until) throw new Error(`relay could not confirm from the kernel that Codex's executor runs under its sandbox, so it stopped it. ${lastWords(tail)}`.trim());
      await new Promise((r) => setTimeout(r, 50));
    }
    const ready = Date.now() + READY_MS;
    for (;;) {
      if (o.signal?.aborted) throw new Error("the turn was stopped while relay was starting Codex's executor");
      const m = /ws:\/\/127\.0\.0\.1:(\d+)\b/.exec(out);
      if (m) {
        if (Number(m[1]) !== ports.exec) throw new Error(`Codex's executor listens on port ${m[1]}, not the port relay reserved for it (${ports.exec}), so relay stopped it`);
        break;
      }
      if (gone) throw new Error(`Codex's executor exited before it was ready (${JSON.stringify(gone)}). ${lastWords(tail)}`.trim());
      if (Date.now() > ready) throw new Error(`Codex's executor did not report its address within ${READY_MS / 1000} s, so relay stopped it. ${lastWords(tail)}`.trim());
      await new Promise((r) => setTimeout(r, 25));
    }
    const ex: Executor = { pid, start, url: `ws://127.0.0.1:${ports.exec}`, ports, launch, probes: o.probes, exited };
    running.set(ex, { watch, tail, child, record: record!, persist: persist! });
    return ex;
  } catch (err) {
    if (persist) clearInterval(persist);
    watch?.look();
    watch?.stop();
    const refused = pid > 1 && !await drainGroup(pid);
    const left = refused ? [pid, ...(watch?.procs().map(p => p.pid) ?? [])] : watch ? await stopProcs(watch.procs()) : [];
    child.stdout?.destroy();
    child.stderr?.destroy();
    // Kept only if something would not stop, with what that is, for a later sweep to try again once
    // this process is gone (and for liveExecutorRecords meanwhile).
    if (record) {
      try {
        if (!left.length && !groupAlive(pid)) forgetExecutor(record);
        else taintExecutor(record, `processes of a failed executor launch would not stop: ${[...left, ...(groupAlive(pid) ? [pid] : [])].join(", ")}`, watch ? watch.procs().filter((p) => left.includes(p.pid)) : []);
      } catch {
        // A record left as it is still names the executor by start time; a sweep finds it.
      }
    }
    throw err;
  }
}

/**
 * Every process of this user whose sandbox lets it write `tmpDir` and not the directory holding it:
 * this turn's, wherever they detached to (sbcheck.ts). No other relay turn's profile allows another
 * turn's temp dir; a broader sandbox (one allowing the home, say) also allows the parent and is left
 * alone; unsandboxed processes are never counted. A string, never an empty list, when the look
 * could not be made. In core/stage2-executors.ts, which stops an orphaned executor's the same way.
 */
export function sweepTurnSurvivors(tmpDir: string): Proc[] | string {
  return turnSurvivors(tmpDir);
}

/**
 * Teardown (§2.2 step 14): the executor's group, every recorded descendant, then the survivor sweep
 * (core/stage2-executors.ts sweepSurvivorsNow). `survivors` are the pids that would not die; `swept`
 * those the sweep found outside the group and the record (detached with setsid, say) and stopped;
 * `sweep` why the sweep cannot be trusted, if so. `tainted` says why the record was kept: then its
 * lease stays quarantined (the lease names the record) and the caller must not release it.
 */
export async function stopExecutor(ex: Executor, o: { tmpDir: string; graceMs: number; quarantine?: string; appDescendants?: Proc[]; refused?: string }): Promise<{ survivors: number[]; unseenMs?: number; swept?: number[]; sweep?: string; tainted?: string }> {
  const r = running.get(ex);
  if (r && o.appDescendants?.length) noteDescendants(r.record, o.appDescendants);
  if (r) clearInterval(r.persist);
  const quarantine = r ? executorQuarantine(r.record, o.quarantine) : o.quarantine;
  const refused = (why: string) => {
    r?.watch.stop();
    r?.child.stdout?.destroy();
    r?.child.stderr?.destroy();
    r?.child.unref();
    const watched = r?.watch.procs() ?? [];
    const tainted = quarantine ?? why;
    if (r) taintExecutor(r.record, tainted, [...watched, ...(o.appDescendants ?? [])]);
    return { survivors: [ex.pid, ...watched.map(p => p.pid)], tainted };
  };
  // An app-group refusal forbids cleanup derived from that target, including executor signals
  // and sandbox sweeps. Keep the watch's identities and the record's lease holds instead.
  if (o.refused) return refused(o.refused);
  // The last look while what it started can still be traced to it.
  r?.watch.look();
  if (sameProcess(ex.pid, ex.start)) {
    try {
      sendGroupSignal(ex.pid, "SIGTERM");
    } catch (err) {
      if (isGroupSignalRefusal(err)) return refused(err.message);
      // Already gone.
    }
    const until = Date.now() + o.graceMs;
    while (pidAlive(ex.pid) && Date.now() < until) await new Promise((res) => setTimeout(res, 25));
  }
  r?.watch.look();
  const unseenMs = r?.watch.stop();
  if (groupAlive(ex.pid) && !await drainGroup(ex.pid)) return refused(`relay refused cleanup for process group ${ex.pid}`);
  r?.child.stdout?.destroy();
  r?.child.stderr?.destroy();
  const watched = r ? r.watch.procs() : [];
  const survivors = new Set(await stopProcs(watched));
  // The sweep, until a look finds nothing new, with everything it finds frozen first: a survivor can fork between looks.
  const result = sweepSurvivorsNow(o.tmpDir, { exclude: survivors });
  for (const p of result.survivors) survivors.add(p.pid);
  const swept = result.swept.map((p) => p.pid);
  const sweep = result.problem;
  if (groupAlive(ex.pid)) survivors.add(ex.pid);
  const tainted = quarantine ?? sweep ?? (survivors.size ? `processes would not stop: ${[...survivors].join(", ")}` : undefined);
  // The record goes with the executor only when everything stopped and the sweep showed it. Otherwise
  // it is kept, tainted, with what is left: the lease that names it stays quarantined, local mode stays
  // refused, and reap or retention sweeps it again.
  if (r) {
    try {
      if (!tainted) forgetExecutor(r.record);
      else taintExecutor(r.record, tainted, [...watched, ...result.survivors].filter((p) => survivors.has(p.pid)));
    } catch {
      // A record left behind is swept later; it names a process by start time, so it never stops another.
    }
  }
  return { survivors: [...survivors], ...(unseenMs !== undefined ? { unseenMs } : {}), ...(swept.length ? { swept } : {}), ...(sweep ? { sweep } : {}), ...(tainted ? { tainted } : {}) };
}

/**
 * Admission, ports, policy, probes, token and executor, in the order of §2.2 steps 1-9. Throws the
 * reason the turn cannot run. `prepared` is codex.ts's preparation (the agent's scrubbed env and the
 * person's MCP servers).
 */
export async function openStage2(spec: TurnSpec, prepared: { env: NodeJS.ProcessEnv; servers: string[] }, tmpDir: string): Promise<Stage2Launch> {
  const d = deps();
  if (spec.overlay) assertOverlayLaunch(spec.overlay, spec.turnId);
  // Freeze what admission checks. Only relay's no-local setting, broker secret and proxy bypass
  // are added for the app server; the executor gets the checked environment without those additions.
  // Admission reads the person's environment, where any executor variable is refused.
  const checked: Readonly<NodeJS.ProcessEnv> = Object.freeze({ ...prepared.env });
  const refusal = d.admission(spec, checked as NodeJS.ProcessEnv);
  if (refusal) throw new Error(refusal);
  // Teardown must be able to ask the kernel which processes are this turn's (the survivor sweep,
  // §2.2 step 15): without a working sandbox_check helper it could not show that nothing is left.
  const noSweep = d.sweepProblem();
  if (noSweep) throw new Error(`relay runs Codex's commands with raw network only where it can find every process they leave behind, and ${noSweep}, so it does not start the agent. Rebuild relay where Xcode's command line tools are installed (\`npm run build\`), then restart it.`);
  const found = d.confinement();
  if ("reason" in found) throw new Error(`relay runs Codex's commands with raw network only inside its own sandbox, and ${found.reason}, so it does not start the agent.`);
  const mechanism = found.mechanism;
  const probe = d.probe();
  if (!probe) throw new Error(`${NO_PROBE}, so it does not start Codex with raw network.`);
  const bin = d.resolveBin(spec.config.targets.codex.bin, checked);
  if (!bin) throw new Error(`relay could not find ${spec.config.targets.codex.bin} as an executable, so it cannot start Codex's executor.`);
  const overlayCaps = spec.overlay?.request.capabilities ?? [];
  const networkBaseline = mediatedBaseline(spec.grant, spec.config);
  const wantsMediated = needsMediatedNetwork(overlayCaps, networkBaseline, spec.neverPolicy);
  const ports = d.lease(wantsMediated);
  let ex: Executor | null = null;
  let broker: HttpBroker | undefined;
  let mediated: MediatedNetworkLaunch | undefined;
  let token: string | null = null;
  let iw: InterfaceWatch | null = null;
  let closed: Promise<{ survivors: number[]; warnings: string[]; uncertain?: boolean }> | null = null;
  let closing = false;
  let releaseEscalation: (() => void) | undefined;
  const close = (quarantine?: string, appDescendants?: Proc[], refused?: string) => closed ??= (async () => {
    closing = true;
    broker?.disarm();
    iw?.stop();
    const warnings: string[] = [];
    let survivors: number[] = [];
    try {
      if (ex) {
        const stopped = await d.stop(ex, { tmpDir, graceMs: EXECUTOR_GRACE_MS, ...(quarantine ? { quarantine } : {}), ...(appDescendants?.length ? { appDescendants } : {}), ...(refused ? { refused } : {}) });
        survivors = stopped.survivors;
        if (stopped.swept?.length) warnings.push(`relay found ${stopped.swept.length} process(es) of this turn's commands outside the executor's process tree (pids ${stopped.swept.join(", ")}), still in the turn's sandbox, and stopped them.`);
        if (stopped.sweep) warnings.push(`relay could not confirm that none of this turn's commands is still running (${stopped.sweep}); it stopped the executor's process group and the descendants it saw, but a command that detached itself may still be running, inside the turn's sandbox.`);
        if (survivors.length) warnings.push(refused ? `relay left this turn's executor processes alone because ${refused}: ${survivors.join(", ")}.` : `processes of this turn's commands would not stop: ${survivors.join(", ")}.`);
        if (stopped.tainted) {
          warnings.push("relay keeps this turn's executor record and its ports reserved, and refuses local-network jobs, until a later sweep (when the job is reaped, or by relay's daily housekeeping) confirms that nothing of the turn still runs.");
        }
      }
    } finally {
      // This process gives up its own claim. A tainted teardown's ports stay quarantined all the
      // same: the lease names the executor's record (PortLease.hold), a release keeps that line, and
      // the lease stays held while the record is there, until a clean sweep removes it.
      try { await mediated?.close(); }
      finally {
        try { await broker?.close(); }
        finally {
          try { releaseEscalation?.(); }
          finally { releaseEscalation = undefined; ports.release(); token = null; }
        }
      }
    }
    return { survivors, warnings, ...(refused ? { uncertain: true } : {}) };
  })();
  try {
    // Snapshot after the lease, before opening any listener of this turn (§4.3).
    const deniedTcp = d.deniedTcp(ports);
    const exact = spec.overlay?.request.capabilities.filter(c => c.kind === "localhost") ?? [];
    if (exact.length) {
      const snapshot = d.snapshot();
      if (exact.some(c => snapshot.controlPlanes.includes(c.port))) throw new Error("never relay.authority: control listeners cannot be localhost exceptions");
      if (exact.some(c => c.operation === "listen" && snapshot.ports.includes(c.port))) throw new Error("capability_unavailable: requested listen port is occupied");
    }
    if (spec.relay) {
      if (spec.relay.turnId === undefined) throw new Error("relay has no turn to serve this agent's relay tools for");
      broker = await d.openBroker({
        nodeId: spec.relay.nodeId, turnId: spec.relay.turnId,
        mayDelegate: spec.relay.mayDelegate ?? false, mayAsk: spec.relay.mayAsk ?? false,
      }, ports.broker);
    }
    const baseline = d.interfaces();
    const rawAllowed = Boolean(spec.grant?.raw_network || spec.overlay?.request.capabilities.some(c => c.kind === "network" && c.mode === "raw"));
    const blockBindAllowed = rawAllowed || exact.some(c => c.operation === "listen") || Boolean(spec.overlay?.request.capabilities.some(c => c.kind === "port0"));
    let net: Stage2Network = {
      mode: "stage2",
      deniedTcp,
      deniedUdp: [...STATIC_DENIED_UDP],
      // Without listener authority the reserved block is denied like the rest of relay's range.
      // With authority it is carved out and carried by bindPorts below.
      relayRange: blockBindAllowed ? [...ports.range] : [...ports.range, ...ports.block],
      execPort: ports.exec,
      bindPorts: blockBindAllowed ? [...ports.block] : [],
      // Unix sockets in the worktree only for write turns in a worktree relay created and pinned (review C4).
      worktreeSockets: spec.access === "write" && Boolean(spec.worktreePin),
      egress: rawAllowed ? "raw" : "none",
      ...(spec.overlay ? {
        egress: rawAllowed ? "raw" as const : "none" as const,
        connectPorts: exact.filter(c => c.operation === "connect").map(c => c.port),
        listenPorts: exact.filter(c => c.operation === "listen").map(c => c.port),
        broadBind: spec.overlay.request.capabilities.some(c => c.kind === "port0"),
      } : {}),
    };
    if (wantsMediated) {
      const selected = mediatedNetworkProvider();
      if (!selected) throw new Error(`capability_unavailable: ${NO_MEDIATED_PROVIDER}`);
      if (!spec.neverPolicy) throw new Error("mediated launch has no checked never policy");
      const context = { capabilities: overlayCaps, baseline: networkBaseline, policy: spec.neverPolicy };
      const unavailable = selected.qualify(context);
      if (unavailable) throw new Error(`capability_unavailable: ${unavailable}`);
      mediated = await selected.prepare({ ...context, spec, env: checked, tmpDir, network: net, proxyPort: ports.proxy });
      if (spec.overlay) assertOverlayLaunch(spec.overlay, spec.turnId);
      if (!rawAllowed && mediated.network.egress !== "none") throw new Error("mediated provider must not substitute raw network");
      net = mediated.network;
      spec.onNote?.(`Codex network: stage-2 mediated. ${MEDIATED_NETWORK_EFFECT}`);
    }
    const plan = d.plan(spec, net);
    const brokerReadback = broker ? {
      url: broker.url, toolTimeoutS: codexToolTimeoutS(spec.config.approval_timeout_s),
      listTools: () => broker!.listTools(), sessionsServed: () => broker!.sessionsServed(),
    } : undefined;
    if (brokerReadback) plan.broker = { url: brokerReadback.url, toolTimeoutS: brokerReadback.toolTimeoutS };
    const policy = d.policy(spec, tmpDir, net);
    const made = executorToken();
    token = made.token;
    const args = ["exec-server", "--listen", `ws://127.0.0.1:${ports.exec}`, "--ws-auth", "capability-token", "--ws-token-sha256", made.hash];
    const env = { ...executorEnv(checked, tmpDir, ports, blockBindAllowed), ...mediated?.executorEnv };
    const { launch, probes } = await probe(mechanism, policy, bin, args, spec.signal, env);
    if (spec.overlay) assertOverlayLaunch(spec.overlay, spec.turnId);
    ex = await d.launch({ spec, bin, launch, probes, ports, hash: made.hash, env, tmpDir, signal: spec.signal, mechanism });
    // Only the app server receives the broker secret. Merge both proxy spellings so neither
    // reqwest's choice of case nor an inherited proxy can divert this credential (§5.1, §5.8).
    const bypass = broker ? [...new Set([
      ...[checked.NO_PROXY, checked.no_proxy].flatMap((v) => (v ?? "").split(",").map((v) => v.trim()).filter(Boolean)),
      "127.0.0.1",
    ])].join(",") : undefined;
    const appEnv = Object.freeze({ ...stage2AppServerEnv({ ...checked, ...mediated?.appEnv }), ...broker?.env,
      ...(bypass ? { NO_PROXY: bypass, no_proxy: bypass } : {}),
    });
    const executor = ex;
    const session: Stage2Session = {
      bindAppServer(pid) {
        if (!broker) return;
        const start = d.appStart(pid, { fresh: true });
        if (!start) throw new Error("relay could not read the identity of Codex's app server");
        broker.bindAppServer({ pid, start });
      },
      sessionsServed: () => broker?.sessionsServed() ?? 0,
      threadMcpProblem: (rpc, eff, threadId, checkpoint) => stage2ThreadMcpProblem(rpc, eff, threadId, brokerReadback, checkpoint),
      armTools(threadId, nativeTurn) {
        if (spec.relay && threadId && nativeTurn && !releaseEscalation) {
          const node = getNode(spec.relay.nodeId), turn = getTurn(spec.relay.turnId!);
          if (!node || !turn || turn.node_id !== node.id || turn.status !== "running") throw new Error("escalation source turn is unavailable");
          const deadline = Math.min(spec.overlay?.recoveryDeadline ?? Infinity,
            spec.config.job_timeout_s === null ? Infinity : (node.started_at ?? node.created_at) + spec.config.job_timeout_s * 1000,
            spec.config.turn_timeout_s === null ? Infinity : (turn.started_at ?? turn.created_at) + spec.config.turn_timeout_s * 1000);
          const binding = createEscalationRuntime({ nodeId: node.id, turnId: turn.id,
            baselineGrant: spec.grant,
            snapshot: { native_thread: threadId, native_turn: nativeTurn,
              base_policy_hash: escalationDigest(policy), launch_plan: escalationDigest(plan),
              overlay_budget_s: Math.min(3600, (deadline - Date.now()) / 1000),
              ...(Number.isFinite(deadline) ? { deadline_ms: deadline } : {}),
            },
          });
          const unregister = registerEscalationRuntime(node.id, turn.id, binding.runtime);
          releaseEscalation = () => { unregister(); binding.dispose(); };
        }
        broker?.arm();
      },
      disarmTools: () => broker?.disarm(),
      async bind(rpc) {
        const secret = token;
        if (!secret) return "relay's executor for this turn is no longer available, so it stopped the agent.";
        try {
          await rpc.request("environment/add", { environmentId: STAGE2_ENVIRONMENT_ID, execServerUrl: executor.url, authBearerToken: secret });
          return null;
        } catch (err) {
          // Codex warns that executor connection errors can carry credentials (review C9): cut the token.
          return `relay could not bind Codex's thread to its sandboxed executor (environment/add: ${redact((err as Error).message).replaceAll(secret, "[redacted]")}), so it stopped the agent.`;
        }
      },
      // hooks/list in the turn's directory, as the turn will see it.
      readback: (rpc, eff) => stage2Readback(rpc, eff, spec.cwd, brokerReadback, Object.keys(plan.features)),
      threadParams: (cwd) => stage2ThreadParams(cwd, STAGE2_ENVIRONMENT_ID),
      async resumeProblem(rpc, threadId) {
        const queued = await stage2QueueProblem(rpc, threadId);
        if (!queued && testHook) await testHook("queue-checked", { rpc, threadId });
        return queued;
      },
      threadProblem(t, cwd, resumed) {
        void testHook?.("thread-reply", { reply: t, resumed });
        return stage2ThreadProblem(t, cwd, STAGE2_ENVIRONMENT_ID, { resumed });
      },
      turnParams: (cwd) => stage2TurnParams(cwd, STAGE2_ENVIRONMENT_ID),
      async turnProblem(rpc, threadId, cwd) {
        const unbound = await d.turnReadback(rpc, threadId, cwd, STAGE2_ENVIRONMENT_ID);
        if (!unbound && testHook) await testHook("turn-bound", { rpc, threadId });
        return unbound;
      },
      guard: new Stage2TurnGuard(),
      approvalProblem(kind, environmentId) {
        if (spec.markers && spec.turnId !== undefined) {
          const problem = overlayTurnProblem(spec.markers.nodeId, spec.turnId); if (problem) return problem;
        }
        // The watch is set up when the app server starts (watch): without it, relay cannot say the addresses held.
        if (!iw) return "relay stopped the Codex agent with raw network and failed the turn, because it was not watching this Mac's network addresses when an approval came in.";
        const moved = iw.changed();
        if (moved) return `relay stopped the Codex agent with raw network and failed the turn, because ${moved}.`;
        return kind === "command" ? stage2CommandEnvironmentProblem(environmentId, STAGE2_ENVIRONMENT_ID) : null;
      },
      approvalDetail: (kind) => stage2ApprovalDetail(kind),
      env: appEnv,
      watch(fail) {
        let failed = false;
        const once = (error: string) => {
          if (closing || failed) return;
          failed = true;
          broker?.disarm();
          fail(error);
        };
        if (spec.overlay) {
          const abort = () => once("overlay deadline expired or launch cancelled; stopping app server before executor");
          spec.signal?.addEventListener("abort", abort, { once: true });
          if (spec.signal?.aborted) abort();
          void executor.exited.finally(() => spec.signal?.removeEventListener("abort", abort));
        }
        void executor.exited.then(({ code, signal }) => {
          const said = running.get(executor);
          once(`relay's sandboxed executor for this Codex turn's commands exited during the turn (${signal ?? `code ${code}`}), so relay stopped the agent and failed the turn.${said ? ` ${lastWords(said.tail)}` : ""}`.trim());
        });
        broker?.onFatal((why) => once(`${why}; relay stopped the Codex app server and failed the turn.`));
        try {
          iw = d.watchInterfaces(baseline);
          iw.onChange((what) => once(`this Mac's network addresses changed during the turn (${what}); relay's network rules for this turn were not checked against them, so it stopped the agent and failed the turn.`));
        } catch (err) {
          once(`relay could not watch this Mac's network addresses during the turn (${(err as Error).message}), so it stopped the agent.`);
        }
      },
      teardown: (appCleanup) => close(appCleanup?.refused ? `untraceable app-server cleanup: ${appCleanup.refused}` : appCleanup?.uncertain ? "untraceable app-server cleanup: keep executor record and leases quarantined" : appCleanup?.survivors.length ? "app-server descendants remain; keep executor record and leases quarantined" : undefined, appCleanup?.descendants, appCleanup?.refused),
    };
    return { plan, session, abort: async () => void (await close()) };
  } catch (err) {
    await close();
    throw err;
  }
}
