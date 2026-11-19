// Processes: telling a process relay recorded from one that got its number since (pid and start
// time), finding what an agent started (by parentage, while it runs), and stopping it all. Nothing
// here reads relay's registry: what to spare, relay's own servers and workers, is passed in
// (db.ts relayProcs), and read at each look.
import { execFile, spawnSync } from "node:child_process";

/** Relay's own processes to leave alone, by pid, each with its start time as ps prints it (whitespace collapsed). */
type Spared = () => Map<number, string>;

const now = () => Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Waits until `gone` holds or `ms` have passed. It looks often at first and then every `most` ms: a
 * process just killed is gone within a millisecond or two, once its parent has reaped it (a zombie
 * still counts as alive, and Node reaps its own children only while its event loop runs), so a fixed
 * interval would mostly measure itself.
 */
async function waitGone(gone: () => boolean, ms: number, most = 50): Promise<void> {
  const deadline = now() + ms;
  for (let step = 1; !gone() && now() < deadline; step = Math.min(step * 2, most)) await sleep(step);
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The process groups that hold this process or one of the processes that started it, read fresh.
 * An agent's MCP server can itself be below an agent being reaped. Such a target needs a recorded,
 * freshly checked leader identity. Empty when ps cannot be read (reported, but best effort).
 */
let warnedAncestorRead = false;
function ancestorGroups(): Set<number> {
  const r = ps(["-axo", "pid=,ppid=,pgid="]);
  const rows = new Map<number, { ppid: number; pgid: number }>();
  for (const line of r.status === 0 ? r.stdout.split("\n") : []) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]) });
  }
  if ((r.error || r.status !== 0 || !rows.has(process.pid)) && !warnedAncestorRead) {
    warnedAncestorRead = true;
    process.stderr.write(`relay could not read process ancestry for group-signal guard; continuing without ancestry protection: ${r.error?.message ?? (r.stderr?.trim() || `ps status ${r.status}, missing current process`)}\n`);
  }
  const groups = new Set<number>();
  for (let pid = process.pid, i = 0; pid > 1 && i < 64; i++) {
    const row = rows.get(pid);
    if (!row) break;
    groups.add(row.pgid);
    pid = row.ppid;
  }
  return groups;
}

/**
 * A refusal is not ESRCH: callers must abandon cleanup derived from this target, including pid
 * fallbacks and descendant kills. An absent group can still have detached descendants to clean.
 */
export function isGroupSignalRefusal(err: unknown): err is NodeJS.ErrnoException {
  return (err as NodeJS.ErrnoException | null)?.code === "EPROTECTEDPGID";
}

/**
 * Checks a target without signalling it (also used by scripts with an injected signal sender).
 * The only ancestry exception is a recorded group leader's pid/start, never a boolean bypass.
 * The identity must match the group and is checked fresh here, immediately before use.
 */
export function assertGroupSignalAllowed(pgid: number, leader?: Proc): void {
  if (!Number.isInteger(pgid) || pgid <= 1) throw Object.assign(new Error(`relay refused invalid process group ${pgid}`), { code: "EPROTECTEDPGID" });
  if (ancestorGroups().has(pgid) && !(leader?.pid === pgid && leader.start && sameProcess(pgid, leader.start, { fresh: true }))) {
    const err = Object.assign(new Error(`relay refused process group ${pgid}: it holds relay (pid ${process.pid}) or a process that started it, without a verified leader`), { code: "EPROTECTEDPGID" });
    process.stderr.write(`${err.stack}\n`);
    throw err;
  }
}

/** Every group signal goes through the guard; see assertGroupSignalAllowed for the narrow exception. */
export function sendGroupSignal(pgid: number, sig: NodeJS.Signals, leader?: Proc): void {
  assertGroupSignalAllowed(pgid, leader);
  process.kill(-pgid, sig);
}

const startCache = new Map<number, { at: number; start: string | null }>();

/**
 * Runs ps in the C locale. Relay identifies a process by its pid and start time, and reads the
 * start time as five fields; in other locales ps prints it differently (four fields in Japanese,
 * seven in Korean), and nothing would match.
 */
function ps(args: string[]) {
  // By its full path: a "ps" earlier on PATH is not asked how relay's host was started.
  return spawnSync("/bin/ps", args, psOptions());
}

const psOptions = () => ({ encoding: "utf8" as const, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", LANG: "C" } });

/** ps without blocking: its exit status (null where it did not run to an exit) and output, as ps() gives them. */
function psLater(args: string[]): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile("/bin/ps", args, psOptions(), (err, stdout) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      resolve({ status: err ? (typeof code === "number" ? code : null) : 0, stdout: String(stdout ?? "") });
    });
  });
}

/**
 * The command lines of the processes that started this one, its parent first, up to `levels` of
 * them. Read only to tell how the host was started (src/mcp/host.ts). Null where ps cannot say for
 * a process that is there, so that what relay could not inspect is not taken for a plain start.
 */
export function ancestorCommandLines(levels: number): string[] | null {
  const out: string[] = [];
  let pid = process.ppid;
  for (let i = 0; i < levels && pid > 1; i++) {
    const m = ancestorRow(ps(ancestorArgs(pid)));
    if (!m) return null;
    out.push(m[2]);
    pid = Number(m[1]);
  }
  return out;
}

/**
 * ancestorCommandLines without blocking, the same ps for each process and the same answer, so that
 * a server can ask while its modules load. Each ps waits for the one before (it names the next pid),
 * and its answer is taken only when the process's event loop next runs.
 */
export async function ancestorCommandLinesLater(levels: number): Promise<string[] | null> {
  const out: string[] = [];
  let pid = process.ppid;
  for (let i = 0; i < levels && pid > 1; i++) {
    const m = ancestorRow(await psLater(ancestorArgs(pid)));
    if (!m) return null;
    out.push(m[2]);
    pid = Number(m[1]);
  }
  return out;
}

const ancestorArgs = (pid: number) => ["-ww", "-o", "ppid=,args=", "-p", String(pid)];
/** A process's parent pid and command line from ps's answer for it; null where ps could not say. */
const ancestorRow = (r: { status: number | null; stdout: string }) => /^\s*(\d+)\s+([\s\S]*)$/.exec(r.status === 0 ? r.stdout.trim() : "");

/**
 * When a process started, as reported by ps. Stored next to every pid relay records, so that a
 * number the system has since given to another process is never mistaken for the original.
 */
export function procStart(pid: number | null | undefined, opts: { fresh?: boolean } = {}): string | null {
  if (!pid || pid <= 1) return null;
  const hit = startCache.get(pid);
  if (!opts.fresh && hit && now() - hit.at < 2000) return hit.start;
  const r = ps(["-o", "lstart=", "-p", String(pid)]);
  const start = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  startCache.set(pid, { at: now(), start });
  return start;
}

/** True when the pid is alive and is still the process relay recorded (same start time, where one was recorded). */
export function sameProcess(pid: number | null | undefined, start: string | null | undefined, opts: { fresh?: boolean } = {}): boolean {
  if (!pidAlive(pid)) return false;
  return start ? sameStart(procStart(pid, opts) ?? "", start) : true;
}

/**
 * True only when the process relay recorded is known to be gone: its pid is not alive, or ps says a
 * process that started at another time has it now. Where ps cannot read the start time at the
 * moment (a fork that fails on a loaded machine), it is not known to be gone, unlike sameProcess,
 * for which a process that cannot be vouched for is not the one recorded.
 */
export function processGone(pid: number | null | undefined, start: string | null | undefined): boolean {
  if (!pidAlive(pid)) return true;
  const now_ = start ? procStart(pid) : null;
  return now_ !== null && !sameStart(now_, start!);
}

const sameStart = (a: string, b: string) => a.replace(/\s+/g, " ") === b.replace(/\s+/g, " ");

/** True while any process remains in the group. Children can outlive the leader. */
export function groupAlive(pgid: number | null | undefined): boolean {
  if (!pgid || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Proc {
  pid: number;
  /** Start time as ps reports it. A pid is acted on later only if it still has this start time. */
  start: string;
}

/**
 * Authentication, rather than best-effort cleanup: both endpoints must have known, fresh start
 * times. Walk a single process-table snapshot, then recheck every identity on the chain. Never
 * use the start-time cache here, nor procTree's command-line heuristic for sparing relay workers.
 * A missing/dead/reused harness or peer, a zombie, or an unreadable table refuses the connection.
 */
export function inProcessTree(root: Proc, peer: Proc): boolean {
  if (!root.start || !peer.start || !sameProcess(root.pid, root.start, { fresh: true }) || !sameProcess(peer.pid, peer.start, { fresh: true })) return false;
  const r = ps(["-axo", "pid=,ppid=,stat=,lstart="]);
  if (r.status !== 0) return false;
  const table = new Map<number, Proc & { parent: number; zombie: boolean }>();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { pid: Number(m[1]), parent: Number(m[2]), zombie: m[3].startsWith("Z"), start: m[4].replace(/\s+/g, " ") });
  }
  const chain: Proc[] = [];
  const seen = new Set<number>();
  let pid = peer.pid;
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const p = table.get(pid);
    if (!p || p.zombie) return false;
    chain.push(p);
    if (pid === root.pid) {
      const normalized = (start: string) => start.replace(/\s+/g, " ");
      return normalized(p.start) === normalized(root.start)
        && normalized(chain[0].start) === normalized(peer.start)
        && chain.every((entry) => sameProcess(entry.pid, entry.start, { fresh: true }));
    }
    pid = p.parent;
  }
  return false;
}

/**
 * One look at the process table: whether the given process is alive, and everything descended
 * from it, found by parentage. Relay's own servers and workers are left out: they belong to jobs
 * of their own. `spared` says which they are, read at every look (db.ts relayProcs: a process
 * that registers after a watch has begun is spared from the next look on; review C5). A process
 * that has exited no longer has its children, so when alive is false the list says nothing about
 * what it started.
 *
 * The table is read without command lines, which are most of ps's work over a whole table (twice
 * the time with them, a thousand processes in); only the descendants not spared as registered
 * have theirs read, for the command-line net. A command line counts only for the process the
 * table showed (same pid, same start time), so it is never taken from a process that has since
 * been given the pid. When those cannot be read, the table is read once more whole, command lines
 * included. That read only adds: command lines for what the first read found, by pid and start
 * time, and what the agent has started since. It takes nothing away from what the first read
 * found, since a descendant let go of here can outlive the agent's group unrecorded: one that has
 * been cut loose since is no longer under the agent in the second read, and one that has exited has
 * no command line there, so it is kept (killProcs signals only the process it was). When that
 * cannot be read either, nothing is learned, as when the first table cannot be read: relay's own
 * processes may be among the descendants with only their command lines to spare them (one that
 * could not read its own start time could not register), and ps failing is when that happens.
 */
export function procTree(pid: number, spared: Spared): { alive: boolean; procs: Proc[] } {
  if (!pid || pid <= 1) return { alive: false, procs: [] };
  const table = processTable(pid, false);
  if (!table) return { alive: false, procs: [] };
  const own = registered(spared());
  const unregistered = descendants(pid, table.kids, own);
  if (!unregistered.length) return { alive: table.alive, procs: [] };
  const commands = commandLines(unregistered);
  if (commands) return { alive: table.alive, procs: descendants(pid, table.kids, (p) => own(p) || RELAY_COMMAND.test(commands.get(p.pid) ?? "")) };
  const full = processTable(pid, true);
  // As when the first table cannot be read: nothing learned.
  if (!full) return { alive: false, procs: [] };
  // Relay's registered processes read after this table too, as `own` was after the first: one
  // registered in either read is relay's.
  const ownLater = registered(spared());
  const ours = (p: Listed) => own(p) || ownLater(p);
  const listed = new Map([...full.kids.values()].flat().map((p) => [p.pid, p]));
  const relayThen = (p: Listed) => {
    const l = listed.get(p.pid);
    return l?.start === p.start && RELAY_COMMAND.test(l.command ?? "");
  };
  // What the first read found under the agent, then what the second has under it as well, each
  // process once (by pid and start time).
  const first = descendants(pid, table.kids, (p) => ours(p) || relayThen(p));
  const since = descendants(pid, full.kids, (p) => ours(p) || RELAY_COMMAND.test(p.command ?? ""));
  const found = new Map([...first, ...since].map((p) => [`${p.pid} ${p.start}`, p]));
  return { alive: table.alive, procs: [...found.values()] };
}

/** Whether a process is one of relay's registered ones: the same pid with the same start time. */
const registered = (own: Map<number, string>) => (p: Proc) => own.get(p.pid) === p.start;

/** A relay server or worker, by its command line. */
const RELAY_COMMAND = /\/(cli\.js|bin\/relay) (mcp|worker)\b/;
/** A process as the table lists it, with its command line when that was read. */
type Listed = Proc & { command?: string };

/**
 * One read of the whole process table: each process's children by parent, with their command lines
 * when `commands`, and whether `pid` is alive. Null when ps cannot be read.
 */
function processTable(pid: number, commands: boolean): { alive: boolean; kids: Map<number, Listed[]> } | null {
  // lstart is five fields: weekday, month, day, time, year.
  const r = ps(["-axo", commands ? "pid=,ppid=,stat=,lstart=,command=" : "pid=,ppid=,stat=,lstart="]);
  if (r.status !== 0) return null;
  const line = commands ? /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/ : /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s|$)/;
  const kids = new Map<number, Listed[]>();
  let alive = false;
  for (const l of r.stdout.split("\n")) {
    const m = line.exec(l);
    if (!m) continue;
    // A zombie is still listed, but its children have already been handed to launchd.
    if (Number(m[1]) === pid) alive = !m[3].startsWith("Z");
    const parent = Number(m[2]);
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent)!.push({ pid: Number(m[1]), start: m[4].replace(/\s+/g, " "), ...(commands ? { command: m[5] } : {}) });
  }
  return { alive, kids };
}

/**
 * The descendants of `pid` by parentage, less relay's own (`relays`) and what they started. Relay's
 * own are its registered processes, matched by pid and start time, and those whose command line
 * names a relay server or worker: a second net for one that has not finished registering, which
 * can only cause something to be spared.
 */
function descendants(pid: number, kids: Map<number, Listed[]>, relays: (p: Listed) => boolean): Proc[] {
  const procs: Proc[] = [];
  const stack = [pid];
  while (stack.length) {
    for (const k of kids.get(stack.pop()!) ?? []) {
      if (relays(k)) continue;
      procs.push({ pid: k.pid, start: k.start });
      stack.push(k.pid);
    }
  }
  return procs;
}

/**
 * The command lines of these processes, by pid, of each that is still the process given (the same
 * start time), or null when ps cannot be read. One that has gone, or whose pid another process has
 * since taken, has none, as ps itself shows none for a process gone before it reads its arguments.
 */
function commandLines(procs: Proc[]): Map<number, string> | null {
  const started = new Map(procs.map((p) => [p.pid, p.start]));
  const out = new Map<number, string>();
  // ps reads one pid on its own in about a millisecond, but goes through the whole table for a
  // list of them: a few are read one at a time.
  for (const batch of procs.length <= 6 ? procs.map((p) => [p]) : [procs]) {
    const r = ps(["-o", "pid=,lstart=,command=", "-p", batch.map((p) => p.pid).join(",")]);
    // ps exits 1, printing nothing, when none of them is there any more.
    if (r.error || (r.status !== 0 && (r.status !== 1 || r.stdout.trim()))) return null;
    for (const line of r.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
      if (m && started.get(Number(m[1])) === m[2].replace(/\s+/g, " ")) out.set(Number(m[1]), m[3]);
    }
  }
  return out;
}

/** Kills each process that is still the one that was noted: same pid, same start time. */
export function killProcs(procs: Proc[]): void {
  for (const p of procs) {
    const r = ps(["-o", "lstart=", "-p", String(p.pid)]);
    if (r.status !== 0 || r.stdout.trim().replace(/\s+/g, " ") !== p.start) continue;
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export interface Watch {
  /** Looks now at what the agent has started. False when the agent was already gone, so that nothing could be learned. */
  look(): boolean;
  /** Everything seen so far. */
  procs(): Proc[];
  /** Stops looking, and returns how long ago the last look that found the agent alive was. */
  stop(): number;
}

/**
 * Keeps a record of the processes an agent starts, by looking at its descendants while it runs:
 * four times a second at first, when an agent that fails tends to fail, then once a second. The
 * agents put tool processes in groups or sessions of their own, so once an agent is gone this
 * record is the only way to find them.
 *
 * It is best effort, and macOS offers nothing better without root. A process is found only while
 * it is still attached to the agent, and only if a look happens then. Two things escape:
 *  - A process cut loose from its parent (`nohup … &` from a shell that then exits) belongs to
 *    launchd at once, while the agent is still running. Unless a look caught it first, it is
 *    never seen. Nothing can be done about this from here: ps hides the environment of system
 *    binaries, so such processes cannot be tagged and found afterwards either. Agents are told to
 *    stop what they start.
 *  - Whatever an agent started since the last look, if it then dies. The callers take one more
 *    look at the moment the agent stops starting things (its last word, or the request to stop);
 *    if the agent was not alive for it (it crashed, or was gone too quickly), that gap is known,
 *    and reported as TurnResult.unseenMs.
 * So the absence of a warning is not a claim that nothing is left.
 */
export function watchProcess(pid: number, spared: Spared): Watch {
  const seen = new Map<number, Proc>();
  const began = Date.now();
  let last = began;
  let timer: NodeJS.Timeout;
  const look = () => {
    const at = Date.now();
    const tree = procTree(pid, spared);
    for (const p of tree.procs) seen.set(p.pid, p);
    if (tree.alive) last = at;
    return tree.alive;
  };
  const tick = () => {
    look();
    timer = setTimeout(tick, Date.now() - began < 5000 ? 250 : 1000);
    timer.unref();
  };
  timer = setTimeout(tick, 150);
  timer.unref();
  return {
    look,
    procs: () => [...seen.values()],
    stop: () => {
      clearTimeout(timer);
      return Date.now() - last;
    },
  };
}

/** Kills the noted processes that are still the ones noted, and returns the pids of any that would not die. */
export async function stopProcs(procs: Proc[]): Promise<number[]> {
  killProcs(procs);
  const still = () => procs.filter((p) => sameProcess(p.pid, p.start));
  await waitGone(() => !still().length, 1000);
  return still().map((p) => p.pid);
}

/** Kills what is left and waits briefly. False means protected: callers must skip derived cleanup. */
export async function drainGroup(pgid: number): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  try {
    sendGroupSignal(pgid, "SIGKILL");
  } catch (err) {
    if (isGroupSignalRefusal(err)) return false;
    // Already gone.
  }
  await waitGone(() => !groupAlive(pgid), 2000);
  return true;
}

/**
 * Kills a process group at once, with everything its members started (as procTree finds it), for
 * an agent with no supervisor left to stop it cleanly, and waits up to a second, without yielding,
 * for the group to empty. Returns whether it did; throws EPROTECTEDPGID before derived cleanup.
 */
export function killGroupNow(pgid: number, spared: Spared, leader?: Proc): boolean {
  assertGroupSignalAllowed(pgid, leader);
  const tree = procTree(pgid, spared).procs;
  try {
    sendGroupSignal(pgid, "SIGKILL", leader);
  } catch (err) {
    if (isGroupSignalRefusal(err)) throw err;
    // Already gone.
  }
  killProcs(tree);
  for (let i = 0; i < 10 && groupAlive(pgid); i++) pause(100);
  return !groupAlive(pgid);
}

/**
 * The signal phase of a cancel. `workers` and `groups` are the worker pids and agent group leaders
 * to stop, each with the start time recorded for it, so that a signal goes only to the same
 * process; `unsupervised` are the groups with no live worker to stop them cleanly. Returns the test
 * for whether a group is still the agent's, and per-group refusals. Refused targets (and their
 * supervising workers, when groupWorkers is supplied) are left alone without blocking other jobs.
 */
export async function stopSupervised(o: { workers: Map<number, string | null>; groups: Map<number, string | null>; groupWorkers?: Map<number, number>; unsupervised: Set<number>; graceMs: number; spared: Spared }): Promise<{ stillOurs: (pgid: number) => boolean; refused: Map<number, string> }> {
  const { workers, groups, groupWorkers, unsupervised, graceMs, spared } = o;
  const leader = (pgid: number) => groups.get(pgid) ? { pid: pgid, start: groups.get(pgid)! } : undefined;
  const refused = new Map<number, string>();
  const check = (pgid: number) => {
    if (refused.has(pgid)) return false;
    try { assertGroupSignalAllowed(pgid, leader(pgid)); return true; }
    catch (err) {
      if (!isGroupSignalRefusal(err)) throw err;
      refused.set(pgid, err.message); return false;
    }
  };
  // Check each target before asking its worker to stop or collecting a descendant tree.
  for (const pgid of new Set([...groups.keys(), ...unsupervised])) check(pgid);
  const workerRefused = (pid: number) => [...refused.keys()].some(g => groupWorkers?.get(g) === pid);
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig);
    } catch {
      // Already gone.
    }
  };
  // Each worker is asked to stop its own agent: it knows how to do that cleanly for its backend
  // (Codex's server must be asked in-band, or the tool processes it started are left running).
  // Agents with no worker are signalled directly. Whatever is left after the grace period is
  // killed, along with everything it started: Codex's tool processes sit outside its process group.
  // A group is still ours while its leader is the process recorded, or the leader has gone and
  // members remain (a group's id is not reused while the group has members).
  const stillOurs = (pgid: number) => refused.has(pgid) || (groupAlive(pgid) && (!pidAlive(pgid) || sameProcess(pgid, groups.get(pgid))));
  const trees = new Map<number, Proc[]>();
  for (const pgid of groups.keys()) if (!refused.has(pgid)) trees.set(pgid, procTree(pgid, spared).procs);
  for (const pid of workers.keys()) if (!workerRefused(pid)) signal(pid, "SIGTERM");
  const signalG = (pgid: number, sig: NodeJS.Signals) => {
    if (refused.has(pgid)) return false;
    try {
      sendGroupSignal(pgid, sig, leader(pgid));
    } catch (err) {
      if (isGroupSignalRefusal(err)) { refused.set(pgid, err.message); return false; }
      // Already gone.
    }
    return true;
  };
  for (const pgid of unsupervised) signalG(pgid, "SIGINT");
  const anyAlive = () => [...workers].some(([p, start]) => !workerRefused(p) && sameProcess(p, start)) || [...groups.keys()].some((g) => !refused.has(g) && stillOurs(g));
  // A look is a few signals and cached start times, cheap enough to take every 10 ms, so that the
  // cancel returns soon after the workers and agents have gone rather than up to a tick later.
  await waitGone(() => !anyAlive(), graceMs + 1500, 10);
  for (const pgid of groups.keys()) {
    if (refused.has(pgid)) continue;
    if (stillOurs(pgid)) {
      const known = new Set(trees.get(pgid)!.map((p) => p.pid));
      trees.set(pgid, [...trees.get(pgid)!, ...procTree(pgid, spared).procs.filter((p) => !known.has(p.pid))]);
      if (!signalG(pgid, "SIGKILL")) continue;
    }
    killProcs(trees.get(pgid)!);
  }
  for (const [pid, start] of workers) if (!workerRefused(pid) && sameProcess(pid, start)) signal(pid, "SIGKILL");
  await waitGone(() => !anyAlive(), 1000);
  return { stillOurs, refused };
}
