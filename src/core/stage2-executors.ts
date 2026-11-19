// Stage 2's executors on disk (docs/codex-confinement-design.md §2.2 steps 9, 14, 15): one record
// per running `codex exec-server`, so that relay can stop one whose own relay process died or was
// killed mid-turn (a crash, or a cancel that had to kill the worker). The worker that launched an
// executor tears it down itself and removes its record (backends/codex-env.ts); these records are
// for everyone else: reap (db.ts), cancel (ops.ts) and the retention sweep (retention.ts).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { releaseLeasesOf } from "../confine/leases.js";
import { sandboxCheckUnavailable, sandboxReports } from "../confine/sbcheck.js";
import { relayHome } from "./config.js";
import { getNode, relayProcs, setParam } from "./db.js";
import { sessionParams } from "./params.js";
import { groupAlive, isGroupSignalRefusal, killGroupNow, killProcs, pidAlive, procStart, sameProcess, type Proc } from "./procs.js";
import { finishLaunchExecutor, launchExecutorQuarantine } from "./restart-overlay.js";

/** A running executor, as relay records it. */
export interface ExecutorRecord {
  v: 1;
  /** The executor: a detached launch leader, so its pid is its process group. Its start time pins the pid against reuse. */
  pid: number;
  start: string;
  pgid: number;
  /** The relay process that launched it and tears it down (a worker, usually): while that one lives, nobody else touches the executor. */
  owner: { pid: number; start: string };
  runId: string;
  nodeId: string;
  turnId: number | null;
  /** Its lease (PortLease): the executor's port and the job's block. */
  ports: { exec: number; block: number[] };
  /** The turn's temp dir: the survivor sweep asks the kernel which processes may write it (sweepTurnSurvivors). */
  tmpDir: string;
  /** The descendants relay's watch recorded so far, each with its start time. */
  descendants: Proc[];
  createdAt: number;
  /**
   * Why a teardown or sweep could not be sure that everything of the turn stopped (processes that
   * would not die, a survivor sweep that could not run or did not converge), when so. A tainted
   * record counts as live (liveExecutorRecords), keeps its ports quarantined (its lease names it)
   * and is swept again by reap and retention, whatever its owner, until a sweep comes out clean.
   */
  tainted?: string;
}

/** A record and where it is. */
export interface Recorded {
  file: string;
  record: ExecutorRecord;
}

/** `<relay home>/executors`, mode 0700. */
export const executorsDir = (): string => path.join(relayHome(), "executors");

const RECORD = /^ex-\d+-[0-9a-f]{8}\.json$/;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const norm = (start: string) => start.replace(/\s+/g, " ");

function ensureDir(): string {
  const dir = executorsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  return dir;
}

/** Written whole or not at all: a temp file beside it, mode 0600, renamed into place. */
function writeAtomic(file: string, record: ExecutorRecord): void {
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Records a running executor; returns the record's file. The owner is this process. */
export function recordExecutor(r: Omit<ExecutorRecord, "v" | "owner" | "createdAt" | "descendants" | "pgid"> & { descendants?: Proc[] }): string {
  const ownerStart = procStart(process.pid);
  if (!ownerStart) throw new Error("relay could not read its own process's start time, so it cannot record Codex's executor");
  const record: ExecutorRecord = {
    v: 1, pid: r.pid, start: norm(r.start), pgid: r.pid, owner: { pid: process.pid, start: norm(ownerStart) },
    runId: r.runId, nodeId: r.nodeId, turnId: r.turnId, ports: { exec: r.ports.exec, block: [...r.ports.block] }, tmpDir: r.tmpDir,
    descendants: r.descendants ?? [], createdAt: Date.now(),
  };
  const file = path.join(ensureDir(), `ex-${r.pid}-${crypto.randomBytes(4).toString("hex")}.json`);
  writeAtomic(file, record);
  return file;
}

/** Adds descendants the watch found since; a record that is gone (torn down meanwhile) stays gone. */
export function noteDescendants(file: string, procs: Proc[]): void {
  const r = readRecord(file);
  if (!r) return;
  const known = new Set(r.descendants.map((p) => `${p.pid} ${p.start}`));
  const add = procs.filter((p) => !known.has(`${p.pid} ${norm(p.start)}`)).map((p) => ({ pid: p.pid, start: norm(p.start) }));
  if (add.length) writeAtomic(file, { ...r, descendants: [...r.descendants, ...add] });
}

export function forgetExecutor(file: string): void {
  fs.rmSync(file, { force: true });
}

function valid(x: any): x is ExecutorRecord {
  const proc = (p: any) => p && Number.isInteger(p.pid) && p.pid > 1 && typeof p.start === "string" && p.start.length > 0;
  return x && x.v === 1 && proc(x) && x.pgid === x.pid && proc(x.owner) && typeof x.nodeId === "string" && typeof x.runId === "string"
    && typeof x.tmpDir === "string" && path.isAbsolute(x.tmpDir) && Array.isArray(x.descendants) && x.descendants.every(proc)
    && x.ports && Number.isInteger(x.ports.exec) && Array.isArray(x.ports.block) && (x.tainted === undefined || typeof x.tainted === "string");
}

function readRecord(file: string): ExecutorRecord | null {
  try {
    const x = JSON.parse(fs.readFileSync(file, "utf8"));
    return valid(x) ? x : null;
  } catch {
    return null;
  }
}

/** Every record in this relay home; `problems` names files that are not records relay wrote (left alone). */
export function executorRecords(): { records: Recorded[]; problems: string[] } {
  const dir = executorsDir();
  let names: string[];
  try {
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!st) return { records: [], problems: [] };
    if (!st.isDirectory() || st.isSymbolicLink()) return { records: [], problems: [`${dir} is not a plain directory, so relay did not read executor records from it`] };
    names = fs.readdirSync(dir);
  } catch (err) {
    return { records: [], problems: [`${dir} could not be read (${(err as Error).message})`] };
  }
  const records: Recorded[] = [];
  const problems: string[] = [];
  for (const name of names.sort()) {
    if (!RECORD.test(name)) continue;
    const file = path.join(dir, name);
    const record = readRecord(file);
    if (record) records.push({ file, record });
    else problems.push(`${file} is not a readable executor record; left alone`);
  }
  return { records, problems };
}

/**
 * Whether the relay process that launched the executor may still be there to tear it down: the same
 * process (pid and start time), or a live pid whose start time cannot be read (unknown is not gone).
 */
export function ownerMayLive(r: ExecutorRecord): boolean {
  const { pid, start } = r.owner;
  return sameProcess(pid, start, { fresh: true }) || (pidAlive(pid) && procStart(pid, { fresh: true }) === null);
}

/**
 * Whether the executor's process group is still the one relay started: its leader is the process
 * recorded (pid and start time), or the leader has exited and members remain (a group id is not
 * given out again while it has members). A live leader with another start time is a reused number.
 */
export function executorGroupOurs(r: ExecutorRecord): boolean {
  if (!groupAlive(r.pgid)) return false;
  return !pidAlive(r.pid) || sameProcess(r.pid, r.start, { fresh: true });
}

/**
 * Every process of this user whose sandbox lets it write `tmpDir` and not the directory holding it:
 * this turn's, wherever they detached to (sbcheck.ts). No other relay turn's profile allows another
 * turn's temp dir; a broader sandbox (one allowing the home, say) also allows the parent and is left
 * alone; unsandboxed processes are never counted, nor zombies. `tmpDir` must exist (the kernel denies
 * every path that does not; sweepSurvivorsNow makes it again). A string, never an empty list, when
 * the look could not be made: the helper unavailable or failing, ps failing, the directory missing,
 * or the kernel unable to answer for a process that is still there.
 */
export function sweepTurnSurvivors(tmpDir: string): Proc[] | string {
  const unavailable = sandboxCheckUnavailable();
  if (unavailable) return unavailable;
  if (!fs.existsSync(tmpDir)) return `the turn's temporary directory ${tmpDir} is not there, so the kernel cannot be asked about it`;
  const uid = process.getuid?.() ?? -1;
  const r = spawnSync("/bin/ps", ["-axo", "pid=,uid=,stat=,lstart="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" } });
  if (r.error || r.status !== 0) return `ps failed: ${r.error?.message ?? `exit ${r.status}`}`;
  const starts = new Map<number, string>();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    // A zombie has exited: nothing of it runs, and the kernel has no sandbox to ask about.
    if (m && Number(m[2]) === uid && Number(m[1]) !== process.pid && !m[3].startsWith("Z")) starts.set(Number(m[1]), norm(m[4]));
  }
  if (!starts.size) return "ps listed no processes of this user";
  const reports = sandboxReports("file-write-data", [tmpDir, path.dirname(tmpDir)], [...starts.keys()]);
  if (typeof reports === "string") return reports;
  const found: Proc[] = [];
  for (const [pid, start] of starts) {
    const rep = reports.get(pid);
    const unanswered = !rep || typeof rep.sandboxed === "string" || (rep.sandboxed && rep.answers.some((a) => a.startsWith("error")));
    if (unanswered) {
      // Gone since ps listed it: nothing to ask about. Still there: the look is not complete.
      if (sameProcess(pid, start, { fresh: true })) return `the kernel could not say whether process ${pid} is in the turn's sandbox (${!rep ? "no answer" : typeof rep.sandboxed === "string" ? rep.sandboxed : rep.answers.find((a) => a.startsWith("error"))})`;
      continue;
    }
    if (rep.sandboxed === true && rep.answers[0] === "allow" && rep.answers[1] === "deny") found.push({ pid, start });
  }
  return found;
}

/** What a survivor sweep did. */
export interface SweepResult {
  /** Processes the sweep found and stopped. */
  swept: Proc[];
  /** Processes it found that would not die, or a final look still found. */
  survivors: Proc[];
  /** Why the sweep cannot be trusted to have found everything, when so: a look that failed, or no convergence within the cap. */
  problem?: string;
}

/** How many looks a sweep takes at most before it gives up and counts what is left as survivors. */
export const SWEEP_CAP = 64;

const signalIfSame = (p: Proc, sig: NodeJS.Signals): boolean => {
  if (!sameProcess(p.pid, p.start, { fresh: true })) return false;
  try {
    process.kill(p.pid, sig);
    return true;
  } catch {
    return false;
  }
};

/**
 * The survivor sweep (§2.2 step 15), until a look finds nothing new: each process a look finds is
 * stopped (SIGSTOP), so that it cannot fork or detach before the next look; once a look finds
 * nothing new, all are killed (SIGKILL) and a last look must find nothing at all. A look that fails
 * stops the sweep with a problem (what was frozen is still killed), and so does reaching `cap`
 * looks: a sweep with a problem has not shown that nothing is left. The turn's temp dir is made again
 * if it is gone (sandbox rules name paths, so the kernel answers for it as before), and removed
 * afterwards. Synchronous. `exclude`: processes already known and handled; `look` is for tests.
 */
export function sweepSurvivorsNow(tmpDir: string, o: { exclude?: Iterable<number>; cap?: number; look?: (tmpDir: string) => Proc[] | string } = {}): SweepResult {
  const look = o.look ?? sweepTurnSurvivors;
  const cap = o.cap ?? SWEEP_CAP;
  const exclude = new Set(o.exclude ?? []);
  let made = false;
  if (!o.look && !fs.existsSync(tmpDir)) {
    try {
      fs.mkdirSync(tmpDir, { mode: 0o700 });
      made = true;
    } catch (err) {
      return { swept: [], survivors: [], problem: `the turn's temporary directory ${tmpDir} is gone and could not be made again to ask the kernel about it (${(err as Error).message})` };
    }
  }
  const frozen = new Map<number, Proc>();
  let problem: string | undefined;
  try {
    let quiet = false;
    for (let round = 0; round < cap && !quiet; round++) {
      const found = look(tmpDir);
      if (typeof found === "string") {
        problem = found;
        break;
      }
      const fresh = found.filter((p) => !frozen.has(p.pid) && !exclude.has(p.pid));
      if (!fresh.length) quiet = true;
      for (const p of fresh) if (signalIfSame(p, "SIGSTOP")) frozen.set(p.pid, p);
    }
    if (!quiet && !problem) problem = `the survivor sweep still found new processes after ${cap} looks`;
    for (const p of frozen.values()) signalIfSame(p, "SIGKILL");
    const left = new Map(stillThere([...frozen.values()], 2000).map((p) => [p.pid, p] as const));
    if (!problem) {
      // The last look: after the kill, nothing of the turn may be left at all.
      const last = look(tmpDir);
      if (typeof last === "string") problem = last;
      else for (const p of last) if (!exclude.has(p.pid)) left.set(p.pid, p);
    }
    return { swept: [...frozen.values()], survivors: [...left.values()], ...(problem ? { problem } : {}) };
  } finally {
    if (made) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Of the noted processes, those still running: same pid and start time, and not a zombie (one that has exited and waits for its parent). */
function running(procs: Proc[]): Proc[] {
  if (!procs.length) return [];
  const r = spawnSync("/bin/ps", ["-o", "pid=,stat=,lstart=", "-p", procs.map((p) => p.pid).join(",")], { encoding: "utf8", timeout: 20000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" } });
  // ps exits 1 when none of them is there; any other failure counts them all as running.
  if (r.error || (r.status !== 0 && r.status !== 1)) return procs.filter((p) => sameProcess(p.pid, p.start, { fresh: true }));
  const now = new Map<number, { zombie: boolean; start: string }>();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (m) now.set(Number(m[1]), { zombie: m[2].startsWith("Z"), start: norm(m[3]) });
  }
  return procs.filter((p) => {
    const n = now.get(p.pid);
    return n !== undefined && !n.zombie && n.start === norm(p.start);
  });
}

/** Waits, without yielding, up to `ms` for the noted processes to be gone; returns those still running. */
function stillThere(procs: Proc[], ms: number): Proc[] {
  for (let waited = 0; waited < ms && running(procs).length; waited += 50) pause(50);
  return running(procs);
}

/** What stopping one recorded executor did. */
export interface Stopped {
  file: string;
  record: ExecutorRecord;
  /** Whether the executor's group was still relay's and was killed. */
  killed: boolean;
  /** Processes the survivor sweep found outside the group and the recorded descendants, and stopped. */
  swept: number[];
  /** Pids that would not die: the record is then kept, so that a later reap or sweep tries again. */
  survivors: number[];
  /** Ports given back. */
  released: number[];
  /** Why the survivor sweep could not be trusted, if so. */
  sweep?: string;
  /** Why the record was kept, tainted, with its lease quarantined; absent when everything stopped and both were let go. */
  tainted?: string;
}

/** Keeps a record, tainted with `why`, with `left` as what is still to stop. */
export function taintExecutor(file: string, why: string, left: Proc[]): void {
  const r = readRecord(file);
  if (!r) return;
  const known = new Set(left.map((p) => p.pid));
  writeAtomic(file, { ...r, tainted: why, descendants: [...left.map((p) => ({ pid: p.pid, start: norm(p.start) })), ...r.descendants.filter((p) => !known.has(p.pid))] });
}

/** An executor-sandbox sweep cannot clear uncertainty about untraceable app-server processes. */
export function executorQuarantine(file: string, quarantine?: string): string | undefined {
  if (quarantine !== undefined) return quarantine;
  const tainted = readRecord(file)?.tainted;
  return tainted?.startsWith("untraceable app-server cleanup:") ? tainted : undefined;
}

/** Keep every identity and lease without signalling or sweeping after app-server cleanup was refused. */
export function quarantineRecordedExecutor(rec: Recorded, why: string): Stopped {
  const { file, record } = rec;
  taintExecutor(file, why, record.descendants);
  return { file, record, killed: false, swept: [], survivors: [record.pgid, ...record.descendants.map(p => p.pid)], released: [], tainted: why };
}

/**
 * Stops one recorded executor at once, as teardown would (§2.2 step 14), for an executor whose relay
 * process is gone, or whose teardown left the record tainted: its process group (with everything
 * procTree finds under it), the descendants recorded, then the survivor sweep by sandbox
 * (sweepSurvivorsNow). Nothing is signalled that is not the process recorded (pid and start time).
 * Only when all that comes out clean is the record removed and its lease given back; otherwise the
 * record is kept, tainted, and the lease stays quarantined, for the next try.
 * `sweep` is injectable for tests that simulate process identity and group-signal refusals.
 */
export function stopRecordedExecutorNow(rec: Recorded, quarantine?: string, sweep = sweepSurvivorsNow): Stopped {
  const { file, record: r } = rec;
  quarantine = executorQuarantine(file, quarantine) ?? launchExecutorQuarantine(r.runId, r.turnId);
  let killed = false;
  if (executorGroupOurs(r)) {
    try { killGroupNow(r.pgid, relayProcs); }
    catch (err) {
      if (!isGroupSignalRefusal(err)) throw err;
      // Keep the identities and lease. No descendant kill or sandbox sweep may follow refusal.
      return quarantineRecordedExecutor(rec, quarantine ?? err.message);
    }
    killed = true;
  }
  killProcs(r.descendants);
  const left = new Map(stillThere(r.descendants, 1000).map((p) => [p.pid, p] as const));
  const result = sweep(r.tmpDir, { exclude: left.keys() });
  for (const p of result.survivors) left.set(p.pid, p);
  const groupLeft = executorGroupOurs(r);
  const survivors = [...left.keys(), ...(groupLeft ? [r.pgid] : [])];
  const swept = result.swept.map((p) => p.pid);
  // The kernel's executor-sandbox sweep cannot prove the absence of untraceable processes that
  // escaped an app-server watch gap. Never turn that uncertainty into a clean lease release.
  const tainted = quarantine ?? result.problem ?? (survivors.length ? `processes would not stop: ${survivors.join(", ")}` : undefined);
  let released: number[] = [];
  if (!tainted) {
    finishLaunchExecutor(r.runId, r.turnId);
    // The record first: while it is there, the lease naming it stays held.
    forgetExecutor(file);
    released = releaseLeasesOf({ pid: r.pid, start: r.start });
  } else {
    taintExecutor(file, tainted, [...left.values()]);
  }
  return { file, record: r, killed, swept, survivors, released, ...(result.problem ? { sweep: result.problem } : {}), ...(tainted ? { tainted } : {}) };
}

/**
 * Stops every orphaned executor matching `which`: those whose owner may still live are its own to
 * tear down, and are left alone, unless its teardown already ended with the record tainted.
 * `quarantine` keeps each record and lease without signalling anything; `retain` still stops the
 * executor but keeps its record, tainted with `retain`, and so its lease (stopRecordedExecutorNow).
 */
function stopOrphansNow(which: (r: ExecutorRecord) => boolean, quarantine?: string, retain?: string): Stopped[] {
  const out: Stopped[] = [];
  for (const rec of executorRecords().records) {
    if (!which(rec.record) || (ownerMayLive(rec.record) && !rec.record.tainted)) continue;
    out.push(quarantine !== undefined ? quarantineRecordedExecutor(rec, quarantine) : stopRecordedExecutorNow(rec, retain));
  }
  return out;
}

/** A note for the node's error, as stopOrphan gives: empty when nothing may still be running. */
export function stoppedNote(stopped: Stopped[]): string {
  const left = stopped.flatMap((s) => s.survivors);
  const unsure = stopped.filter((s) => s.tainted && !s.survivors.length).map((s) => s.tainted!);
  // An app-server marker survives every later sweep (executorQuarantine): only the person clears it.
  const held = unsure.filter((t) => t.startsWith("untraceable app-server cleanup:"));
  const retry = unsure.filter((t) => !t.startsWith("untraceable app-server cleanup:"));
  return [
    ...(left.length ? [` Processes of a stage-2 executor (pids ${left.join(", ")}) may still be running, inside the turn's sandbox.`] : []),
    ...(retry.length ? [` relay could not confirm that every process of a stage-2 executor stopped (${retry.join("; ")}); its ports stay reserved until a later sweep does.`] : []),
    ...(held.length ? [` relay could not confirm that a stage-2 executor's app server stopped (${held.join("; ")}); the executor's record and ports stay quarantined, and no later sweep releases them: check that nothing of the turn is left, then remove the record yourself (docs/UPGRADING.md, Relay 1.1.3).`] : []),
  ].join("");
}

/**
 * Stops the stage-2 executors of a node whose relay process has gone (reap, after stopOrphan has
 * killed the app server, so that it cannot reconnect to whatever later holds the executor's port;
 * cancel, after stopSupervised). An executor whose owner may still be alive is left to it: a cancel
 * whose worker exits cleanly tears its own down, and a turn a resume started meanwhile under a new
 * worker is never touched. Returns a note for the node when something would not stop.
 * If app-server cleanup was refused, `quarantine` keeps the record and leases without any derived
 * executor cleanup: recorded descendants or the sandbox sweep could reach the refused group. If it
 * is only unconfirmed (the app server may still run), `retain`, an `untraceable app-server cleanup:`
 * reason, stops the executor but keeps its record and leases, so no later clean sweep releases them.
 */
export function stopNodeExecutorsNow(nodeId: string, quarantine?: string, retain?: string): string {
  return stoppedNote(stopOrphansNow((r) => r.nodeId === nodeId, quarantine, retain));
}

/**
 * The retention sweep's part (retention.ts): every orphaned executor in this relay home, whatever its
 * node (a crash that no reap has seen yet). Returns what it did, as lines, and what it could not.
 */
export function sweepOrphanedExecutors(): { stopped: string[]; problems: string[] } {
  const { problems } = executorRecords();
  const stopped: string[] = [];
  for (const s of stopOrphansNow(() => true)) {
    const what = `the stage-2 executor ${s.record.pid} of ${s.record.nodeId}${s.record.turnId !== null ? ` turn ${s.record.turnId}` : ""}`;
    if (s.survivors.length) problems.push(`${what}: pids ${s.survivors.join(", ")} would not stop; its record and lease are kept`);
    else if (s.tainted) problems.push(`${what}: relay could not confirm that everything of the turn stopped (${s.tainted}); its record and lease are kept`);
    else stopped.push(`${what}${s.killed ? " (stopped)" : ""}${s.swept.length ? `, ${s.swept.length} detached process(es) stopped` : ""}`);
  }
  return { stopped, problems };
}

/**
 * Whether a record may still have something of its turn running: the executor, its process group, a
 * process recorded as its descendant (by pid and start time; a reused pid does not count), or a
 * taint (a teardown or sweep that could not be sure).
 */
const recordLive = (r: ExecutorRecord): boolean =>
  Boolean(r.tainted) || sameProcess(r.pid, r.start) || executorGroupOurs(r) || r.descendants.some((p) => sameProcess(p.pid, p.start));

/**
 * Every recorded executor of this relay home that may still have something running (recordLive):
 * teardown keeps the record, tainted, with what would not stop or when it could not be sure. For the
 * local-mode interlock (core/raw-network.ts), which refuses local mode while stage 2 has anything
 * running. Throws when a file in the records directory cannot be read as a record, or the directory
 * itself cannot: relay then cannot tell that nothing runs, and the interlock refuses. Read-only.
 */
export function liveExecutorRecords(): ExecutorRecord[] {
  const { records, problems } = executorRecords();
  if (problems.length) throw new Error(problems.join("; "));
  return records.map((r) => r.record).filter(recordLive);
}

/**
 * Whether a record of this node may still have something running (recordLive, descendants and taint
 * included): retention leaves the turn's temp dir alone while one does, since a later sweep asks
 * the kernel about that path. True also when the records cannot all be read.
 */
export function nodeHasLiveExecutor(nodeId: string): boolean {
  const { records, problems } = executorRecords();
  return problems.length > 0 || records.some(({ record: r }) => r.nodeId === nodeId && recordLive(r));
}

/** The node param naming each turn's skill-asset copy (SessionParams.ext_assets). */
const ASSETS = "ext_assets";

/** Records that `turnId` of `nodeId` copied its skills to `dir` (a `relay-ext-*` in relay's private root), for the sweep after a crash. */
export function noteSkillAssets(nodeId: string, turnId: number, dir: string): void {
  const n = getNode(nodeId);
  if (!n) return;
  setParam(nodeId, ASSETS, { ...(sessionParams(n).ext_assets ?? {}), [String(turnId)]: dir });
}

/** Forgets a turn's skill-asset copy once it is removed. */
export function dropSkillAssets(nodeId: string, turnId: number): void {
  const n = getNode(nodeId);
  const all = n ? sessionParams(n).ext_assets : null;
  if (!all || !(String(turnId) in all)) return;
  const { [String(turnId)]: _, ...rest } = all;
  setParam(nodeId, ASSETS, Object.keys(rest).length ? rest : null);
}
