// Process containment for the qualifier, including stage2's detached executors and app servers.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { scratchEnv } from "./scratch-env.mjs";
import { assertGroupSignalAllowed, isGroupSignalRefusal } from "../../dist/core/procs.js";

export const SWEEP_CAP = 64;

/** How long one process inventory may take before the watchdog gives up and fails the run, and
 * from how long on it is reported as slow. On a laptop (macOS 27.0.1 and 27.2) `ps -axEww`
 * timed out at the earlier 5 s in six qualifications while it took 0.06 s outside them, idle or
 * at load 36; the slow reports say how long those stalls really last. */
export const INVENTORY_TIMEOUT_MS = 30_000;
export const SLOW_INVENTORY_MS = 5_000;

const reportSlowInventory = (ms) => process.stderr.write(`${new Date().toISOString()} watchdog: process inventory took ${ms} ms\n`);

/** macOS ps includes the environment, so reparented/setsid children retain the scratch marker. */
export function processTable(root, inspect = spawnSync, { onSlow = reportSlowInventory, now = () => performance.now() } = {}) {
  // On macOS -e means all processes; only uppercase -E includes their environments. Orphaned
  // setsid children may name the scratch root nowhere else after their parent exits.
  const started = now();
  const r = inspect("/bin/ps", ["-axEww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="], {
    env: scratchEnv(root, { LC_ALL: "C" }), encoding: "utf8", timeout: INVENTORY_TIMEOUT_MS, maxBuffer: 64 << 20,
  });
  const ms = Math.round(now() - started);
  // Reporting a slow inventory is diagnostic: a logger that throws (runner.log not writable) must
  // neither replace the inventory's own error nor fail a good inventory. Its failure is reported
  // with that error, or else on stderr.
  let logFailure = null;
  if (ms >= SLOW_INVENTORY_MS) { try { onSlow(ms); } catch (e) { logFailure = e; } }
  const why = (e) => e?.message ?? String(e);
  const fail = (message, cause) => {
    const err = new Error(`${message}${logFailure ? `; reporting the slow inventory also failed: ${why(logFailure)}` : ""}`, cause ? { cause } : undefined);
    if (logFailure) err.loggingError = logFailure;
    return err;
  };
  if (r.error || r.status !== 0) throw fail(`watchdog cannot inspect processes after ${ms} ms: ${r.error?.message ?? r.stderr}`, r.error);
  const rows = parseProcessTable(r.stdout, r.pid);
  if (!rows.length) throw fail("watchdog process inventory was empty or unparseable");
  if (logFailure) {
    try { process.stderr.write(`${new Date().toISOString()} watchdog: process inventory took ${ms} ms (could not log it: ${why(logFailure)})\n`); } catch { /* nowhere left to report it */ }
  }
  return rows;
}

export function parseProcessTable(text, inventoryPid) {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line);
    // ps inherits our scratch marker too; its own already-exited PID is not a survivor.
    return m && +m[1] !== inventoryPid ? [{ pid: +m[1], ppid: +m[2], pgid: +m[3], stat: m[4], start: m[5].replace(/\s+/g, " "), command: m[6] }] : [];
  });
}

export class ProcessSupervisor {
  constructor(root, { onSlowInventory, table = () => processTable(root, spawnSync, onSlowInventory ? { onSlow: onSlowInventory } : {}), kill = process.kill.bind(process), graceMs = 2000, pollMs = 100, sweepCap = SWEEP_CAP } = {}) {
    this.root = fs.realpathSync(root); this.table = table; this.kill = kill; this.graceMs = graceMs; this.pollMs = pollMs; this.sweepCap = sweepCap;
    this.known = new Map(); this.leaders = new Set(); this.groups = new Map(); this.cancelled = null; this.active = false;
    this.refusedGroups = new Map(); this.sources = new Map();
  }
  check() {
    if (this.cancelled) throw new Error(this.cancelled);
    if (this.refusedGroups.size) throw this.refusedGroups.values().next().value;
  }
  guardGroup(pgid) {
    if (this.refusedGroups.has(pgid)) throw this.refusedGroups.get(pgid);
    try { assertGroupSignalAllowed(pgid); }
    catch (e) { if (isGroupSignalRefusal(e)) this.refusedGroups.set(pgid, e); throw e; }
  }
  signal(pid, signal) {
    if (pid < 0) this.guardGroup(-pid);
    try { this.kill(pid, signal); }
    catch (e) {
      if (e.code === "ESRCH") return;
      // macOS answers killpg with EPERM, not ESRCH, when every member left in the group is a
      // zombie awaiting its reaper. Treat that group as gone only when a fresh look finds no
      // live member; a real refusal, or a look that fails, keeps the EPERM.
      if (e.code === "EPERM" && pid < 0 && this.groupOnlyZombies(-pid)) return;
      throw e;
    }
  }
  groupOnlyZombies(pgid) {
    try { return !this.table().some((row) => row.pgid === pgid && !row.stat?.startsWith("Z")); }
    catch { return false; }
  }
  scan() {
    const all = this.table(), byPid = new Map(all.map((row) => [row.pid, row]));
    const rows = all.filter((row) => !row.stat?.startsWith("Z"));
    // Remember selection by a group separately from membership in a group. A scratch-marked
    // process may share our group and still be safe to stop by its pinned pid.
    const owned = new Map();
    const own = (pid, sources = []) => {
      const prior = owned.get(pid);
      const next = new Set([...(prior ?? []), ...sources]);
      owned.set(pid, next);
      return !prior || next.size !== prior.size;
    };
    for (const pid of this.leaders) {
      const leader = byPid.get(pid), known = this.known.get(pid);
      if (leader && (!known || known.start === leader.start)) own(pid, [pid]);
      // The leader may exit before the first look. A live group retains its ID until its last
      // member exits; remember its members even without a leader or scratch environment.
      if (!leader) for (const row of rows) if (row.pgid === pid) own(row.pid, [pid]);
    }
    for (const [pgid, start] of this.groups) {
      const leader = byPid.get(pgid);
      if (leader && leader.start !== start) continue; // Reused group/leader number.
      for (const row of rows) if (row.pgid === pgid) own(row.pid, [pgid]);
    }
    for (const row of rows) {
      const prior = this.known.get(row.pid);
      if (prior?.start === row.start) own(row.pid, this.sources.get(`${row.pid} ${row.start}`));
      if (row.command.includes(this.root)) own(row.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (owned.has(row.pid) && row.pid === row.pgid) changed = own(row.pid, [row.pgid]) || changed;
        if (owned.has(row.ppid)) changed = own(row.pid, owned.get(row.ppid)) || changed;
      }
    }
    const found = rows.filter((row) => row.pid !== process.pid && owned.has(row.pid));
    // Check group-derived selections before pid cleanup, including detached descendants. Merely
    // sitting in an ancestor's group introduces no group selection and needs no exception.
    for (const pgid of new Set(found.flatMap(row => [...owned.get(row.pid)]))) {
      try { this.guardGroup(pgid); } catch (e) { if (!isGroupSignalRefusal(e)) throw e; }
    }
    for (const row of found) {
      this.known.set(row.pid, row);
      this.sources.set(`${row.pid} ${row.start}`, owned.get(row.pid));
      if (row.pid === row.pgid) this.groups.set(row.pgid, row.start);
    }
    return found.filter(row => ![...owned.get(row.pid)].some(g => this.refusedGroups.has(g)));
  }
  signalSame(row, signal) {
    const now = this.table().find((p) => p.pid === row.pid);
    if (!now || now.start !== row.start || now.stat?.startsWith("Z")) return false;
    for (const pgid of this.sources.get(`${now.pid} ${now.start}`) ?? []) {
      try { this.guardGroup(pgid); } catch (e) { if (isGroupSignalRefusal(e)) return false; throw e; }
    }
    this.signal(row.pid, signal);
    return true;
  }
  killGroups() {
    const rows = this.table(), byPid = new Map(rows.map((row) => [row.pid, row]));
    let refusal;
    for (const pgid of new Set([...this.leaders, ...this.groups.keys()])) {
      const leader = byPid.get(pgid), start = this.groups.get(pgid) ?? this.known.get(pgid)?.start;
      if (leader && start && leader.start !== start) continue;
      const blocked = [...(this.sources.get(`${pgid} ${leader?.start ?? start}`) ?? [])].find(g => this.refusedGroups.has(g));
      if (blocked !== undefined) { refusal ??= this.refusedGroups.get(blocked); continue; }
      try { this.guardGroup(pgid); }
      catch (e) { if (!isGroupSignalRefusal(e)) throw e; refusal ??= e; continue; }
      if (rows.some((row) => row.pgid === pgid && !row.stat?.startsWith("Z"))) this.signal(-pgid, "SIGKILL");
    }
    if (refusal) throw refusal;
  }
  async terminate() {
    // Same convergence rule as stage2-executors.sweepSurvivorsNow: freeze each newly found
    // identity before another look. Do not thaw them between discovery and SIGKILL: a TERM
    // handler could fork a new setsid child after the two fixed looks used by the old watchdog.
    const frozen = new Map(), problems = [];
    const key = (row) => `${row.pid} ${row.start}`;
    const attempt = (fn) => { try { return fn(); } catch (e) { problems.push(e.message); } };
    let quiet = false;
    try {
      for (let round = 0; round < this.sweepCap; round++) {
        const fresh = this.scan().filter((row) => !frozen.has(key(row)));
        if (!fresh.length) { quiet = true; break; }
        for (const row of fresh) if (this.signalSame(row, "SIGSTOP")) frozen.set(key(row), row);
      }
      if (!quiet) problems.push(`watchdog discovery did not converge after ${this.sweepCap} looks`);
    } catch (e) { problems.push(e.message); }
    // Even a failed/nonconvergent discovery must kill what it already froze.
    for (const row of frozen.values()) attempt(() => this.signalSame(row, "SIGKILL"));
    attempt(() => this.killGroups());
    // Look again after killing, including processes not seen before the kill. Group death is
    // never accepted as proof that detached descendants died. Recheck identity before signaling.
    const deadline = Date.now() + this.graceMs;
    let remaining;
    for (let round = 0; round < this.sweepCap; round++) {
      try { remaining = this.scan(); } catch (e) { problems.push(e.message); break; }
      if (!remaining.length) break;
      for (const row of remaining) {
        attempt(() => this.signalSame(row, "SIGSTOP"));
        attempt(() => this.signalSame(row, "SIGKILL"));
      }
      attempt(() => this.killGroups());
      if (Date.now() >= deadline) break;
      await delay(Math.min(50, Math.max(0, deadline - Date.now())));
    }
    try { remaining = this.scan(); } catch (e) { problems.push(e.message); }
    if (remaining?.length) problems.push(`watchdog survivors: ${remaining.map((r) => r.pid).join(",")}`);
    problems.push(...[...this.refusedGroups.values()].map(e => e.message));
    if (problems.length) throw new Error([...new Set(problems)].join("; "));
  }
  cancel(reason) {
    this.cancelled ??= reason;
    // An active run observes cancellation at its next bounded poll; acquisition has the same path.
  }
  async run(command, args, { env = {}, cwd, timeoutMs = 300_000, logFd, inspect = false, combineOutput = false } = {}) {
    this.check();
    if (this.active) throw new Error("supervisor runs one command at a time");
    this.active = true;
    let child, closed, settled = false, result, failure, stdout = "", stderr = "";
    try {
      // Fail before spawning if process inspection is unavailable for the qualification watchdog.
      if (inspect) { this.scan(); this.check(); }
      child = spawn(command, args, {
        cwd, env: scratchEnv(this.root, env), detached: true,
        stdio: ["ignore", logFd === undefined ? "pipe" : logFd, logFd === undefined ? "pipe" : logFd],
      });
      if (child.pid) this.leaders.add(child.pid);
      child.stdout?.on("data", (d) => { stdout = (stdout + d).slice(-16 * 1024 * 1024); });
      child.stderr?.on("data", (d) => { stderr = (stderr + d).slice(-1024 * 1024); });
      closed = new Promise((resolve) => {
        child.once("error", (e) => { failure = e; });
        child.once("close", (code, signal) => { result = { code, signal, stdout, stderr }; settled = true; resolve(); });
      });
      const deadline = Date.now() + timeoutMs;
      while (!settled) {
        if (Date.now() >= deadline) this.cancel(`timeout after ${timeoutMs}ms: ${command}`);
        this.check();
        if (inspect) { this.scan(); this.check(); }
        await Promise.race([closed, delay(this.pollMs)]);
      }
      this.check();
      if (failure) throw failure;
      if (inspect) {
        const left = this.scan();
        this.check();
        if (left.length) throw new Error(`qualification left descendants: ${left.map((r) => r.pid).join(",")}`);
      }
      if (result.code !== 0 || result.signal) throw new Error(`${command} exited ${result.code ?? result.signal}: ${stderr.slice(-2000)}`);
      return combineOutput ? result.stdout + result.stderr : result.stdout;
    } catch (e) {
      if (child?.pid) {
        // A failed group kill must not replace the error that started cleanup, or the run log
        // would show only the kill error. The run still fails; every error is kept. (A group
        // holding only zombies is not a failure; see signal().)
        const killGroup = () => { try { this.signal(-child.pid, "SIGKILL"); return null; } catch (k) { return k; } };
        const why = `qualification failed (${e?.message ?? e})`;
        if (inspect) {
          // Preserve the parent chain until discovery has frozen the descendants. Killing the
          // driver group first loses short-lived ancestry to children which changed sessions.
          try { await this.terminate(); }
          catch (cleanup) {
            const k = killGroup();
            throw new AggregateError([e, cleanup, ...(k ? [k] : [])], `${why} and watchdog cleanup failed: ${cleanup.message}${k ? `; group kill: ${k.message}` : ""}`);
          }
        } else {
          const k = killGroup();
          if (k) throw new AggregateError([e, k], `${why} and the group kill failed: ${k.message}`);
        }
        if (closed) await Promise.race([closed, delay(5000, null, { ref: false }).then(() => { throw new Error("killed child did not close its pipes"); })]);
      }
      throw e;
    } finally {
      if (child?.pid) this.leaders.delete(child.pid);
      this.active = false;
    }
  }
}
