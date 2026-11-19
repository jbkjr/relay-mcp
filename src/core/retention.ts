// Retention (keep_records_days) and the sweep of relay's own temporary directories: what relay
// removes of its own accord. Records go only when the person has set how long to keep them, and
// only for runs nothing can use any more; a temporary directory only once whatever made it is
// provably gone.
import fs from "node:fs";
import { launchReservationProblem } from "./restart-overlay.js";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { relaySocketsDir } from "../confine/sockets.js";
import { nativeTempRoot, privateStateRoot } from "../confine/private-root.js";
import { harnessHome, relayHome, runDir, worktreesHome, type RelayConfig } from "./config.js";
import { adoptionTickets, ownerOpen } from "./adoption.js";
import { CONTEXT_DIR } from "./context.js";
import { busy, db, getNode, getRun, getTurn, reap, runNodes, tx, workerLive, type NodeRow, type RunRow, type TurnRow } from "./db.js";
import { git } from "./git.js";
import { groupAlive, pidAlive, procStart, sameProcess } from "./procs.js";
import { sessionParams } from "./params.js";
import { dropSkillAssets, nodeHasLiveExecutor, sweepOrphanedExecutors } from "./stage2-executors.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The prefix of a forgotten run's directories, moved aside in the transaction that forgets it and removed after. */
const ASIDE = ".forgotten-";
/** A run id as relay makes one: only such a name is joined to a path of relay's, so nothing outside its own directories is ever moved. */
const RUN_ID = /^run_[0-9a-f]+$/;
/** A plain directory of this user's: not a link to one, nor someone else's. */
const mine = (st: fs.Stats) => st.isDirectory() && !st.isSymbolicLink() && (typeof process.getuid !== "function" || st.uid === process.getuid());

/** When anything last happened in a run: it, or a node, turn, request or event of it, was made, started, decided or ended. */
function lastActive(runId: string): number {
  const row = db().prepare(`SELECT MAX(t) AS t FROM (
    SELECT created_at AS t FROM runs WHERE id = ?1
    UNION ALL SELECT MAX(created_at, COALESCE(started_at, 0), COALESCE(ended_at, 0)) FROM nodes WHERE run_id = ?1
    UNION ALL SELECT MAX(created_at, COALESCE(started_at, 0), COALESCE(ended_at, 0)) FROM turns WHERE node_id IN (SELECT id FROM nodes WHERE run_id = ?1)
    UNION ALL SELECT MAX(created_at, COALESCE(decided_at, 0)) FROM requests WHERE run_id = ?1
    UNION ALL SELECT MAX(created_at, COALESCE(noticed_at, 0), COALESCE(seen_at, 0)) FROM events WHERE run_id = ?1)`).get(runId) as { t: number | null };
  return row.t ?? 0;
}

/**
 * Why a run's records must stay because of what is on disk: a job's worktree, or its branch, still
 * there, or a branch relay cannot look for. A branch is gone only when git looked and found none
 * (`rev-parse -q --verify` exits 1). An unavailable repository (on a volume not mounted, say),
 * even when its parent exists, or a git that fails or does not finish, says nothing either way,
 * and the run is kept.
 */
function heldOnDisk(nodes: NodeRow[]): string | null {
  for (const n of nodes) {
    if (n.worktree && fs.existsSync(n.worktree)) return `${n.id} still has its worktree (${n.worktree})`;
    // Only a branch is on disk to protect: a read job in a repository since removed holds nothing.
    if (!n.branch || !n.repo) continue;
    if (!fs.existsSync(n.repo)) {
      return `relay cannot look for ${n.id}'s branch ${n.branch}: its repository ${n.repo} is not there (a volume not mounted?), and its absence does not establish deletion, so the run is kept until relay can look`;
    }
    const r = git(n.repo, ["rev-parse", "-q", "--verify", `refs/heads/${n.branch}`]);
    if (r.ok) return `${n.id}'s branch ${n.branch} is still in ${n.repo} (relay clean deletes it once merged)`;
    if (r.code !== 1) return `relay could not check whether ${n.id}'s branch ${n.branch} is still in ${n.repo} (${r.err || `git exited with ${r.code}`}), so the run is kept until it can`;
  }
  return null;
}

/**
 * Why a run's records stay because relay quarantined login-store entries of it after a turn
 * (backends/acp.ts, quarantine/<run>/<node>/<turn>/): its records say how they came to be there,
 * so they are kept until the person has looked and removed that directory. One that relay cannot
 * look for keeps the run too.
 */
function quarantined(id: string): string | null {
  const dir = path.join(relayHome(), "quarantine", id);
  try {
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })) return null;
  } catch (err) {
    return `relay could not look for login-store entries of it that it quarantined in ${dir} (${(err as Error).message}), so the run is kept until it can`;
  }
  return `relay quarantined login-store entries of it in ${dir}, which its records explain; delete that directory once you have looked at it`;
}

/**
 * Why a run is still in use, by the registry: its session, anything in it that is not over, or a
 * transfer of it to another session waiting to be taken up. Its session is open as adopt counts
 * it (adoption.ts ownerOpen): while its owning connection's process runs, or may (one whose start
 * relay cannot read, or a legacy owner's that has none).
 */
function stillActive(run: RunRow, nodes: NodeRow[]): string | null {
  const reserved = launchReservationProblem(run.id); if (reserved) return reserved;
  if (ownerOpen(run)) return "its session is still open";
  if (adoptionTickets(run.id).waiting) return "a transfer of it to another session, which relay adopt authorized, is waiting to be taken up";
  for (const n of nodes) {
    if (busy(n)) return `${n.id} is ${n.status}`;
    if (n.status === "open") return `${n.id} is an open ${n.kind}, waiting for its next message`;
    if (workerLive(n)) return `the worker of ${n.id} is still running`;
    if (groupAlive(n.agent_pgid)) return `an agent process of ${n.id} (group ${n.agent_pgid}) may still be running`;
  }
  const procs = db().prepare("SELECT pid, start, kind, node_id FROM relay_procs WHERE node_id IN (SELECT id FROM nodes WHERE run_id = ?)").all(run.id) as { pid: number; start: string; kind: string; node_id: string }[];
  const live = procs.find((p) => sameProcess(p.pid, p.start));
  if (live) return `relay's ${live.kind} process ${live.pid} for ${live.node_id} is still running`;
  // Keep the mapping if removal failed, so a later sweep can still prove whose directory it is.
  const temps = db().prepare("SELECT tmp_dir FROM turns WHERE tmp_dir IS NOT NULL AND node_id IN (SELECT id FROM nodes WHERE run_id = ?)").all(run.id) as { tmp_dir: string }[];
  for (const { tmp_dir } of temps) if (fs.lstatSync(tmp_dir, { throwIfNoEntry: false })) return `a turn's private temporary directory still needs sweeping (${tmp_dir})`;
  if (db().prepare("SELECT 1 FROM requests WHERE run_id = ? AND status = 'pending' LIMIT 1").get(run.id)) return "it has an approval request waiting";
  return null;
}

/** Removes every row of a run from the registry. Inside the transaction that found it unused. */
function deleteRun(id: string): void {
  const inRun = "(SELECT id FROM nodes WHERE run_id = ?)";
  for (const sql of [
    `DELETE FROM injections WHERE discussion_id IN ${inRun}`,
    `DELETE FROM calls WHERE node_id IN ${inRun}`,
    "DELETE FROM elicitations WHERE request_id IN (SELECT id FROM requests WHERE run_id = ?)",
    "DELETE FROM requests WHERE run_id = ?",
    "DELETE FROM events WHERE run_id = ?",
    "DELETE FROM slots WHERE run_id = ?",
    "DELETE FROM launch_leaders WHERE run_id = ?",
    `DELETE FROM turns WHERE node_id IN ${inRun}`,
    `DELETE FROM relay_procs WHERE node_id IN ${inRun}`,
    "DELETE FROM nodes WHERE run_id = ?",
    "DELETE FROM runs WHERE id = ?",
  ]) db().prepare(sql).run(id);
}

/** A run's directories that hold its records and its harnesses' state, each with where it is moved aside to. */
function runDirs(id: string): { dir: string; aside: string }[] {
  return [runDir(id), path.join(harnessHome(), id)].map((dir) => ({ dir, aside: path.join(path.dirname(dir), `${ASIDE}${id}`) }));
}

/** Moves a run's directories aside; returns those it moved. A move that fails puts back the others and throws. */
function moveAside(dirs: { dir: string; aside: string }[]): { dir: string; aside: string }[] {
  const moved: { dir: string; aside: string }[] = [];
  for (const d of dirs) {
    try {
      fs.renameSync(d.dir, d.aside);
      moved.push(d);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      putBack(moved);
      throw new Error(`relay could not move ${d.dir} aside to remove it (${(err as Error).message})`);
    }
  }
  return moved;
}

function putBack(moved: { dir: string; aside: string }[]): void {
  for (const d of moved) {
    try {
      fs.renameSync(d.aside, d.dir);
    } catch {
      // Left aside: a run whose rows are kept still lists, and its directory is named in the error.
    }
  }
}

/**
 * Removes a forgotten run's directories, already moved aside, its transfer authorizations and,
 * unless `treesDir` is false, its directory of worktrees, once empty. Returns what was left.
 */
function removeFiles(id: string, moved: { dir: string; aside: string }[], treesDir = true): string[] {
  const left: string[] = [];
  try {
    for (const f of adoptionTickets(id).files) {
      try {
        fs.rmSync(f, { force: true });
      } catch (err) {
        left.push(`${f} (${(err as Error).message})`);
      }
    }
  } catch (err) {
    left.push((err as Error).message);
  }
  for (const d of moved) {
    try {
      fs.rmSync(d.aside, { recursive: true, force: true });
    } catch (err) {
      left.push(`${d.aside} (${(err as Error).message}; relay clean tries again)`);
    }
  }
  try {
    if (treesDir) fs.rmdirSync(path.join(worktreesHome(), id));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") left.push(`${path.join(worktreesHome(), id)} (${code === "ENOTEMPTY" ? "not empty" : (err as Error).message})`);
  }
  return left;
}

export interface Forgotten {
  /** Runs whose records were removed. */
  forgotten: string[];
  /** Runs past the limit that were kept, each with why. */
  kept: string[];
  /** What could not be removed of a run that was forgotten. */
  left: string[];
}

/**
 * Forgets the runs (all, or `runIds`) in which nothing has happened for more than `days`: their
 * rows in the registry, their records directory, their harnesses' state. A run still in use is
 * never forgotten (stillActive), nor one that a job's worktree or branch still needs (heldOnDisk), nor
 * one with login-store entries relay quarantined (quarantined).
 * What the registry says is checked again in the transaction that removes the rows, so a run taken
 * up again at that moment (a resume, say) either is seen to be in use or finds its items gone. The
 * run's directories are moved aside in that transaction, and put back if it does not commit, so
 * that none is removed for a run the registry still lists.
 */
export function forgetOldRuns(days: number, o: { runIds?: string[]; at?: number } = {}): Forgotten {
  const cutoff = (o.at ?? Date.now()) - days * DAY;
  const ids = o.runIds ?? (db().prepare("SELECT id FROM runs ORDER BY created_at").all() as { id: string }[]).map((r) => r.id);
  const out: Forgotten = { forgotten: [], kept: [], left: [] };
  const rebuild: { problem: string | null } = { problem: null };
  overwriting(() => forgetEach(ids, cutoff, out, () => { rebuild.problem = scheduleRebuild() ?? rebuild.problem; }));
  if (rebuild.problem && out.forgotten.length) out.left.push(rebuild.problem);
  rebuildRegistry(out.left);
  return out;
}

/**
 * Runs `fn`, which forgets runs, with the rows it deletes overwritten as they are deleted (the
 * registry's setting is put back after). Deleted rows are not left readable in the registry's
 * file: they are overwritten so, and when no run is active the file is rebuilt (rebuildRegistry,
 * VACUUM), which also drops the copies that earlier updates of their rows left in its free space,
 * and its write-ahead log, which holds them too, is emptied.
 */
function overwriting<T>(fn: () => T): T {
  const before = (db().prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete;
  db().exec("PRAGMA secure_delete = ON");
  try {
    return fn();
  } finally {
    db().exec(`PRAGMA secure_delete = ${Number(before)}`);
  }
}

const rebuildMarker = () => path.join(relayHome(), "registry-rebuild");

/**
 * Records that the registry's file is to be rebuilt (rebuildRegistry), before a run's rows are
 * deleted, so that a relay stopped right after deleting them leaves the rebuild to a later clean or
 * housekeeping. Never taken back when nothing was deleted after all: another relay process may have
 * deleted rows meanwhile and relied on it; a rebuild with nothing to drop costs only its time.
 * Returns what to say if it could not be recorded, or null.
 */
function scheduleRebuild(): string | null {
  try {
    fs.writeFileSync(rebuildMarker(), "pending\n", { mode: 0o600 });
    return null;
  } catch (err) {
    return `the deferred registry rebuild could not be scheduled (${(err as Error).message}); forgotten records may remain readable in relay.db and relay.db-wal`;
  }
}

/**
 * Rebuilds the registry's file and empties its write-ahead log while a rebuild is pending
 * (scheduleRebuild); what could not be done goes in `left`.
 */
function rebuildRegistry(left: string[]): void {
  const rebuild = rebuildMarker();
  if (!fs.existsSync(rebuild)) return;
  // VACUUM takes a write lock for its entire rebuild. Defer it while any session or work is
  // live, including runs unrelated to those forgotten. The marker makes a later clean or
  // housekeeping retry even when no further runs are forgotten.
  const active = (db().prepare("SELECT * FROM runs").all() as unknown as RunRow[])
    .some((run) => stillActive(run, runNodes(run.id)) !== null);
  if (active) {
    left.push("the registry rebuild and log truncation are deferred while runs are active; forgotten records may remain readable in relay.db and relay.db-wal until relay clean or housekeeping next finds all runs idle");
    return;
  }
  try {
    db().exec("VACUUM");
    // Blocked (busy) while another relay process reads or writes the registry for longer than
    // the busy timeout: the pages of the file as it was then stay in it, and the log is not emptied.
    const cp = db().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number };
    if (cp.busy !== 0 || cp.checkpointed < cp.log) {
      left.push("the registry's write-ahead log could not be emptied (another relay process was using the registry), so what the forgotten runs held may stay readable in relay.db and relay.db-wal until later writes to the registry replace it, or the next time runs are forgotten");
    } else fs.rmSync(rebuild, { force: true });
  } catch (err) {
    left.push(`the registry's file was not rebuilt, so what the forgotten runs held may stay readable in its free space until the next time (${(err as Error).message})`);
  }
}

function forgetEach(ids: string[], cutoff: number, out: Forgotten, beforeDelete: () => void): void {
  for (const id of ids) {
    if (!getRun(id) || lastActive(id) > cutoff) continue;
    if (!RUN_ID.test(id)) {
      out.kept.push(`${id}: it is not a run id relay makes, so relay leaves its records alone`);
      continue;
    }
    const disk = quarantined(id) ?? heldOnDisk(runNodes(id));
    if (disk) {
      out.kept.push(`${id}: ${disk}`);
      continue;
    }
    let moved: { dir: string; aside: string }[] = [];
    let why: string | null;
    beforeDelete();
    try {
      why = tx(() => {
        const run = getRun(id);
        if (!run || lastActive(id) > cutoff) return "skip";
        const active = stillActive(run, runNodes(id));
        if (active) return active;
        moved = moveAside(runDirs(id));
        deleteRun(id);
        return null;
      });
    } catch (err) {
      if (moved.length && getRun(id)) putBack(moved);
      out.kept.push(`${id}: ${(err as Error).message}`);
      continue;
    }
    if (why === "skip") continue;
    if (why) {
      out.kept.push(`${id}: ${why}`);
      continue;
    }
    out.forgotten.push(id);
    const left = removeFiles(id, moved);
    if (left.length) out.left.push(`${id}: its rows are gone from the registry, but not all its files: ${left.join("; ")}`);
  }
}

/** What relay clean says about records: the policy, and what it did under it. */
export function recordsReport(cfg: Pick<RelayConfig, "keep_records_days">, runIds?: string[]): Record<string, unknown> {
  if (cfg.keep_records_days === null) return { records_note: "kept: keep_records_days is not set, so relay keeps every run's prompts, logs and transcripts until you delete them" };
  const r = forgetOldRuns(cfg.keep_records_days, { runIds });
  return {
    records_note: `forgotten after ${cfg.keep_records_days} days without activity (keep_records_days)`,
    records_forgotten: r.forgotten, records_kept: r.kept, ...(r.left.length ? { records_left: r.left } : {}),
  };
}

/**
 * Why relay clean --forget does not take a run, going by its repositories, or null when every
 * repository a job of it has a branch or worktree in is not there. One that is there is relay
 * clean's to deal with; one relay cannot look at says nothing either way. Looked at before the
 * transaction that removes the run's rows, never in it: a repository on a stale network mount can
 * take longer to answer than another relay process waits for the registry.
 */
function reposGone(id: string, nodes: NodeRow[]): string | null {
  const repos = [...new Set(nodes.flatMap((n) => (n.repo && (n.branch || n.worktree) ? [n.repo] : [])))];
  if (!repos.length) return "no job of it has a branch or a worktree in a repository, so no missing repository keeps it (keep_records_days forgets it as it does any other run)";
  for (const repo of repos) {
    let there: boolean;
    try {
      there = fs.statSync(repo, { throwIfNoEntry: false }) !== undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOTDIR") return `relay cannot tell whether its repository ${repo} is there (${(err as Error).message})`;
      there = false;
    }
    if (there) return `its repository ${repo} is there, so relay clean ${id} is what applies: it removes the run's finished worktrees and its relay/* branches already merged, and keep_records_days forgets the run once nothing holds it`;
  }
  return null;
}

/**
 * What reap would settle in a run, for a preview, which must not settle it (reap records a job
 * lost, fails its turn, expires requests and stops agents left without a supervisor): a job whose
 * worker has died, or an approval request that no job can take up any more. Either keeps the run
 * in use until it is settled.
 */
function unsettled(id: string, nodes: NodeRow[]): string | null {
  const next = "run relay tree or relay clean first, or run this again with --write";
  for (const n of nodes) if (busy(n) && n.worker_pid !== null && !workerLive(n)) return `${n.id}'s worker is gone; ${next}`;
  const r = db().prepare(`SELECT id, node_id FROM requests WHERE run_id = ?1 AND status = 'pending'
    AND node_id IN (SELECT id FROM nodes WHERE run_id = ?1 AND status NOT IN ('queued', 'running')) LIMIT 1`).get(id) as { id: string; node_id: string } | undefined;
  return r ? `its approval request ${r.id} waits on ${r.node_id}, which is no longer running; ${next}` : null;
}

/** A directory as relay found it, by path and identity: acted on only while it is still that directory. */
interface Pin { path: string; dev: number; ino: number }
const pin = (p: string, st: fs.Stats): Pin => ({ path: p, dev: st.dev, ino: st.ino });

/** Throws unless `p` is still the plain directory of this user's that relay found there. */
function still(p: Pin): void {
  const st = fs.lstatSync(p.path, { throwIfNoEntry: false });
  if (!st || !mine(st) || st.dev !== p.dev || st.ino !== p.ino) throw new Error(`${p.path} changed after relay looked at it`);
}

/** What relay made for a run in its worktrees home (runTrees). */
interface Trees {
  /** The worktrees home, when it is there. */
  root: Pin | null;
  /** The run's directory in it, when that is a plain directory of this user's. */
  dir: Pin | null;
  /** In that directory, each job's worktree (by the job's id) and identity file's build directory (CONTEXT_BUILD) that is one too. */
  made: Pin[];
  /** Whether anything else is in the run's directory, which then stays. */
  others: boolean;
  /** What relay leaves alone, each with why. */
  alone: string[];
}

/**
 * What relay made for a run in its worktrees home, each pinned by identity. The worktrees home
 * itself must be a plain directory of this user's: through a link, what relay would remove is not
 * in its own directory, so it throws, as it does for what relay cannot look at. What relay did not
 * make, a link among them, and a job's worktree recorded outside the worktrees home (made while that
 * was elsewhere) are left alone, each said with why.
 */
function runTrees(id: string, nodes: NodeRow[]): Trees {
  const home = worktreesHome();
  const dir = path.join(home, id);
  const look = (p: string) => {
    try {
      return fs.lstatSync(p, { throwIfNoEntry: false });
    } catch (err) {
      throw new Error(`relay could not look at ${p} (${(err as Error).message})`);
    }
  };
  const t: Trees = { root: null, dir: null, made: [], others: false, alone: [] };
  for (const n of nodes) {
    if (n.worktree && path.resolve(n.worktree) !== path.join(dir, n.id) && look(n.worktree)) {
      t.alone.push(`${n.worktree}: ${n.id}'s worktree, outside relay's worktrees home ${home}, so relay does not remove it`);
    }
  }
  const root = look(home);
  if (!root) return t;
  if (!mine(root)) throw new Error(`relay's worktrees home ${home} is not a plain directory of this user's (a link, say), so relay will not look for the run's worktrees in it, nor remove anything there`);
  t.root = pin(home, root);
  const st = look(dir);
  if (!st) return t;
  if (!mine(st)) {
    t.alone.push(`${dir}: not a plain directory of this user's, as relay makes a run's directory of worktrees, so relay leaves it as it is`);
    return t;
  }
  t.dir = pin(dir, st);
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch (err) {
    throw new Error(`relay could not read ${dir} (${(err as Error).message})`);
  }
  const jobs = new Set(nodes.map((n) => n.id));
  for (const name of names) {
    const p = path.join(dir, name);
    const e = look(p);
    if (!e) continue;
    if (jobs.has(name) || CONTEXT_BUILD.test(name)) {
      if (mine(e)) {
        t.made.push(pin(p, e));
        continue;
      }
      t.alone.push(`${p}: not a plain directory of this user's (a link, say), so relay leaves it`);
    } else t.alone.push(`${p}: not a name relay gives what it makes for a job, so relay leaves it`);
    t.others = true;
  }
  return t;
}

/**
 * Moves what relay made for a run in its worktrees home aside, into <worktrees home>/.forgotten-<run>/,
 * in the transaction that removes the run's rows: once they commit, a relay stopped before removing
 * it leaves it for sweepTemps, which puts it back should the registry still list the run. Each is
 * moved only while it, the run's directory and the worktrees home are the directories relay looked
 * at. Returns the directory it was moved to, or null for nothing to move; throws, having put back
 * what it moved, when it cannot.
 */
function moveTreesAside(id: string, t: Trees): Pin | null {
  if (!t.made.length || !t.root || !t.dir) return null;
  const aside = path.join(t.root.path, `${ASIDE}${id}`);
  const moved: Pin[] = [];
  let made = false;
  try {
    still(t.root);
    still(t.dir);
    fs.mkdirSync(aside, { mode: 0o700 });
    made = true;
    for (const m of t.made) {
      still(m);
      fs.renameSync(m.path, path.join(aside, path.basename(m.path)));
      moved.push(m);
    }
    return pin(aside, fs.lstatSync(aside));
  } catch (err) {
    for (const m of moved) {
      try {
        fs.renameSync(path.join(aside, path.basename(m.path)), m.path);
      } catch {
        // Left aside: sweepTemps puts it back while the registry lists the run.
      }
    }
    try {
      if (made) fs.rmdirSync(aside);
    } catch {
      // Not empty: as above.
    }
    throw new Error(`relay could not move the run's worktrees aside to remove them (${(err as Error).message})`);
  }
}

/**
 * Puts what moveTreesAside moved to `aside` back into the run's directory in the worktrees home
 * `root`, making that directory again if it is gone. Throws what it cannot put back, leaving the
 * rest aside.
 */
function putTreesBack(root: string, id: string, aside: string): void {
  const dir = path.join(root, id);
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) fs.mkdirSync(dir);
  else if (!mine(st)) throw new Error(`${dir} is not a plain directory of this user's`);
  for (const name of fs.readdirSync(aside)) {
    const to = path.join(dir, name);
    if (fs.lstatSync(to, { throwIfNoEntry: false })) throw new Error(`${to} is already there`);
    fs.renameSync(path.join(aside, name), to);
  }
  fs.rmdirSync(aside);
}

/**
 * Removes a forgotten run's worktrees, moved aside, and its directory in the worktrees home once
 * empty, each only while the worktrees home and it are the directories relay looked at. A link
 * inside is removed as a link (rmSync goes by lstat), never what it leads to. Returns what was left.
 */
function removeTreesAside(t: Trees, aside: Pin | null): string[] {
  const left: string[] = [];
  const attempt = (p: Pin, remove: () => void, again: string) => {
    try {
      still(t.root!);
      still(p);
      remove();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") left.push(`${p.path} (${code === "ENOTEMPTY" ? "not empty" : (err as Error).message}${again})`);
    }
  };
  if (aside) attempt(aside, () => fs.rmSync(aside.path, { recursive: true, force: true }), "; relay clean tries again");
  if (t.dir && !t.others) attempt(t.dir, () => fs.rmdirSync(t.dir!.path), "");
  return left;
}

/**
 * relay clean --forget <run_id>: forgets one run that keep_records_days keeps only because a
 * repository a job of it has a branch or worktree in is not there (heldOnDisk), which relay cannot
 * tell from a volume not mounted, so only the person can say it is gone. Refused for a run still in
 * use (stillActive), with login-store entries relay quarantined, or whose repositories are not all
 * gone (reposGone). Without `write` it only reads: it settles nothing reap would settle (unsettled
 * says so instead) and says what it would do. With `write`, after reaping, it removes the run's rows
 * (overwritten, and the registry's rebuild recorded before they go, as keep_records_days does), its
 * records and its harnesses' state, and what relay made for it in its worktrees home (runTrees):
 * all moved aside in the transaction that removes the rows, in which what the registry says is
 * checked again (the repositories were looked at before it), and removed after; then the transfers
 * of it relay adopt authorized. Nothing outside relay's own directories, nothing through a link,
 * and no branch: those are in repositories that are not there.
 */
export function forgetRun(id: string, o: { write: boolean }): Record<string, unknown> {
  if (!getRun(id)) return { error: `unknown run ${id}` };
  const refused = (why: string) => ({ run_id: id, refused: true, reason: `relay will not forget ${id}: ${why}` });
  if (!RUN_ID.test(id)) return refused("it is not a run id relay makes, so relay leaves its records alone");
  // Only the acting forget settles, as relay clean and relay tree do first: a job whose worker has
  // died is recorded lost (its agents left without a supervisor stopped), and an approval request
  // that no job can take up any more expires.
  if (o.write) reap(id);
  const nodes = runNodes(id);
  /** What the plan below rests on, of the registry: checked again in the transaction. */
  const held = (ns: NodeRow[]) => JSON.stringify(ns.map((n) => [n.id, n.repo, n.branch, n.worktree]));
  const planned = held(nodes);
  let trees: Trees;
  let files: string[];
  try {
    const run = getRun(id);
    if (!run) return { error: `unknown run ${id}` };
    const no = (o.write ? null : unsettled(id, nodes)) ?? stillActive(run, nodes) ?? quarantined(id) ?? reposGone(id, nodes);
    if (no) return refused(no);
    trees = runTrees(id, nodes);
    const own = runDirs(id).flatMap((d) => {
      try {
        return fs.lstatSync(d.dir, { throwIfNoEntry: false }) ? [d.dir] : [];
      } catch (err) {
        throw new Error(`relay could not look at ${d.dir} (${(err as Error).message})`);
      }
    });
    files = [...own, ...trees.made.map((m) => m.path), ...(trees.dir && !trees.others ? [trees.dir.path] : []), ...adoptionTickets(id).files];
  } catch (err) {
    return refused((err as Error).message);
  }
  const report = {
    run_id: id,
    dry_run: !o.write,
    registry_rows: { ...(db().prepare(`SELECT (SELECT COUNT(*) FROM nodes WHERE run_id = ?1) AS items,
      (SELECT COUNT(*) FROM turns WHERE node_id IN (SELECT id FROM nodes WHERE run_id = ?1)) AS turns,
      (SELECT COUNT(*) FROM requests WHERE run_id = ?1) AS approval_requests,
      (SELECT COUNT(*) FROM events WHERE run_id = ?1) AS events`).get(id) as Record<string, number>) },
    relay_files: files,
    ...(trees.alone.length ? { left_alone: trees.alone } : {}),
    branches_not_touched: nodes.flatMap((n) => (n.branch && n.repo ? [`${n.branch} in ${n.repo}`] : [])),
  };
  const alone = trees.alone.length ? " What left_alone names is not relay's to remove: delete it yourself once you have looked at it." : "";
  const branches = "Its branches (branches_not_touched) are in repositories that are not there, which relay cannot reach, so it does not touch them: a repository that was moved, or is on a volume not mounted, still has them.";
  if (!o.write) {
    return {
      ...report, forgotten: false,
      note: `Nothing was changed. With --write, relay removes the run's rows from the registry and relay_files from disk${trees.made.length ? " (work never committed in its worktrees goes with them)" : ""}, and nothing else.${alone} ${branches} If its repository can be put back, do that instead: relay clean then deals with the run as with any other.`,
    };
  }
  const left: string[] = [];
  const unscheduled = scheduleRebuild();
  let moved: { dir: string; aside: string }[] = [];
  const treesAside: { pin: Pin | null } = { pin: null };
  let no: string | null;
  try {
    no = overwriting(() => tx(() => {
      const run = getRun(id);
      if (!run) return "it is no longer in the registry (another relay process forgot it)";
      const now = runNodes(id);
      if (held(now) !== planned) return "its jobs' repositories, branches or worktrees changed while relay was looking; run this again";
      const active = stillActive(run, now);
      if (active) return active;
      moved = moveAside(runDirs(id));
      treesAside.pin = moveTreesAside(id, trees);
      deleteRun(id);
      return null;
    }));
  } catch (err) {
    // moveTreesAside puts back what it moved before it throws. What cannot be put back here is
    // put back by sweepTemps while the registry lists the run.
    if (getRun(id)) {
      putBack(moved);
      try {
        if (treesAside.pin) putTreesBack(trees.root!.path, id, treesAside.pin.path);
      } catch {
        // As above.
      }
    }
    return refused((err as Error).message);
  }
  if (no) return refused(no);
  if (unscheduled) left.push(unscheduled);
  left.push(...removeTreesAside(trees, treesAside.pin), ...removeFiles(id, moved, false));
  rebuildRegistry(left);
  return {
    ...report, forgotten: true, ...(left.length ? { left } : {}),
    note: `${id} is forgotten: its rows are gone from the registry, and relay_files from disk${left.length ? ", but for what left names" : ""}.${alone} ${branches} In such a repository, git worktree prune drops git's record of the worktrees removed.`,
  };
}

/**
 * A worker's housekeeping once its session's turns are done, at most once a day across every
 * relay process of this control directory (a stamp file there says when it last ran): the sweep of
 * relay's leftover temporary directories, and keep_records_days where it is set, each done whatever
 * became of the other. What it did, and what went wrong, goes to the worker's log.
 */
export async function housekeepDaily(cfg: Pick<RelayConfig, "keep_records_days">): Promise<void> {
  const stamp = path.join(relayHome(), "housekeeping");
  const st = fs.statSync(stamp, { throwIfNoEntry: false });
  if (st && Date.now() - st.mtimeMs < DAY) return;
  // Stamped first, so that the workers finishing at the same moment do not all do it. A stamp that
  // cannot be written (a full disk, say) does not stop it: the next worker then does it again.
  try {
    fs.writeFileSync(stamp, `${new Date().toISOString()}\n`);
  } catch (err) {
    console.error(`relay: could not write ${stamp} (${(err as Error).message}), so the next worker does this housekeeping again`);
  }
  try {
    const swept = await sweepTemps();
    if (swept.removed.length || swept.problems.length) console.error(`relay: removed leftover temporary directories: ${swept.removed.join(", ") || "none"}${swept.problems.length ? `; ${swept.problems.join("; ")}` : ""}`);
  } catch (err) {
    console.error(`relay: leftover temporary directories were not swept: ${(err as Error).message}`);
  }
  if (cfg.keep_records_days === null) return;
  const r = forgetOldRuns(cfg.keep_records_days);
  if (r.forgotten.length || r.left.length) console.error(`relay: keep_records_days ${cfg.keep_records_days}: forgot ${r.forgotten.join(", ") || "nothing"}${r.left.length ? `; ${r.left.join("; ")}` : ""}`);
}

/** Whether something listens on a Unix socket. A socket that neither refuses nor answers within 2 s counts as listening. */
function listening(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection(socket);
    const done = (live: boolean) => {
      c.destroy();
      resolve(live);
    };
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
    c.setTimeout(2000, () => done(true));
  });
}

/** Directories made with mkdtemp under these prefixes (six random characters after the prefix). */
const BROKER_DIR = /^relay-(?:turn|probe)-[A-Za-z0-9]{6}$/;
const PROBE_SCRATCH = /^relay-probe-[A-Za-z0-9]{6}$/;
/** A worktree identity file's build directory, beside the worktree (context.ts writeWorktreeContext). */
const CONTEXT_BUILD = new RegExp(`^\\..+${CONTEXT_DIR.replace(/\./g, "\\.")}\\.[0-9a-f]{16}$`);

export interface Swept {
  removed: string[];
  /** What could not be looked at or removed. */
  problems: string[];
}

/** Also recognizes a rename whose registry transaction rolled back after a crash. */
function matchingTempTurns(registry: DatabaseSync, dir: string, st: fs.Stats): TurnRow[] {
  return registry.prepare("SELECT * FROM turns WHERE tmp_dir IN (?, ?) AND tmp_dev = ? AND tmp_ino = ?")
    .all(dir, dir.endsWith(".swept") ? dir.slice(0, -6) : dir, st.dev, st.ino) as unknown as TurnRow[];
}

/** A directory found by the inventory of turns' private temporary directories. */
interface TurnTemp {
  dir: string;
  st?: fs.Stats;
  turn?: TurnRow;
  /** Why it is left alone, said of this one directory (relay clean's temp_dirs_left, a worker's log). */
  problem?: string;
  /** A turn's directory left alone: the directory it is in (the shared temporary directory or one of relay's own), and why (null: it matches no turn). Doctor sums these up. */
  left?: LeftTemp;
}
export interface LeftTemp { root: string; shared: boolean; reason: string | null }

/** Read-only inventory, shared by doctor and the sweep. Never read a marker from agent-writable temp space. */
function privateTurnTemps(find = (dir: string, st: fs.Stats): TurnRow[] => matchingTempTurns(db(), dir, st)): TurnTemp[] {
  const out: TurnTemp[] = [];
  // Also inventory the old shared-temp location, so upgrades report leftovers safely.
  for (const parent of new Set([os.tmpdir(), privateStateRoot(), nativeTempRoot()])) {
    let root: string;
    try {
      if (parent !== os.tmpdir() && fs.lstatSync(parent).isSymbolicLink()) {
        out.push({ dir: parent, problem: `${parent} is a symbolic link; left alone` });
        continue;
      }
      root = fs.realpathSync(parent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") out.push({ dir: parent, problem: `the temporary directory could not be read (${(err as Error).message})` });
      continue;
    }
    let names: string[];
    try { names = fs.readdirSync(root); }
    catch (err) {
      out.push({ dir: root, problem: `the temporary directory could not be read (${(err as Error).message})` });
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("relay-tmp-") && !(parent === nativeTempRoot() && /^[A-Za-z0-9]{6}(?:\.swept)?$/.test(name))) continue;
      const dir = path.join(root, name);
      try {
        const st = fs.lstatSync(dir, { throwIfNoEntry: false });
        if (!st || !st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === "function" && st.uid !== process.getuid())) continue;
        const matches = find(dir, st);
        out.push(matches.length === 1 ? { dir, st, turn: matches[0] } : { dir, st, problem: `${dir} cannot be matched to a turn in the registry; left alone`, left: { root, shared: parent === os.tmpdir(), reason: null } });
      } catch (err) {
        const reason = (err as Error).message;
        out.push({ dir, problem: `${dir} could not be checked against the registry (${reason}); left alone`, left: { root, shared: parent === os.tmpdir(), reason } });
      }
    }
  }
  return out;
}

/**
 * Unknown/legacy private temp directories require a person's investigation; doctor never removes
 * them. One line for each directory they are in (and each reason one could not be checked),
 * however many there are: one Mac had 333 left by builds before 1.0 (leftTempsLine).
 */
export function turnTempProblems(): string[] {
  let registry: DatabaseSync | undefined;
  let checked = false;
  let mapped = false;
  let unreadable: Error | undefined;
  try {
    const entries = privateTurnTemps((dir, st) => {
      if (!checked) {
        checked = true;
        const file = path.join(relayHome(), "relay.db");
        try {
          if (fs.existsSync(file)) {
            // Doctor must neither create a registry nor back up/migrate an older one. Legacy
            // registries cannot match these directories; the write-mode sweep migrates normally.
            registry = new DatabaseSync(file, { readOnly: true });
            const columns = (registry.prepare("PRAGMA table_info(turns)").all() as { name: string }[]).map((c) => c.name);
            mapped = ["tmp_dir", "tmp_dev", "tmp_ino"].every((c) => columns.includes(c));
          }
        } catch (err) {
          // Every directory then goes unchecked, not just the first: none can be matched.
          unreadable = err as Error;
        }
      }
      if (unreadable) throw unreadable;
      return registry && mapped ? matchingTempTurns(registry, dir, st) : [];
    });
    const lines: (string | { where: LeftTemp; names: string[] })[] = [];
    const groups = new Map<string, { where: LeftTemp; names: string[] }>();
    for (const e of entries) {
      if (!e.left) {
        if (e.problem) lines.push(e.problem);
        continue;
      }
      const key = JSON.stringify([e.left.root, e.left.reason]);
      let group = groups.get(key);
      if (!group) {
        group = { where: e.left, names: [] };
        groups.set(key, group);
        lines.push(group);
      }
      group.names.push(path.basename(e.dir));
    }
    return lines.map((l) => typeof l === "string" ? l : leftTempsLine(l.where, l.names));
  } finally { registry?.close(); }
}

/** The most directory names one of doctor's lines about them gives. */
const NAMED = 3;

/**
 * Doctor's line about turns' directories in one directory that relay leaves alone for one reason:
 * how many, where, a few of their names, and what to make of them. relay clean's temp_dirs_left
 * still names each one.
 */
export function leftTempsLine(where: LeftTemp, names: string[], platform: NodeJS.Platform = process.platform): string {
  const one = names.length === 1;
  const named = [...names].sort().slice(0, NAMED);
  const more = names.length - named.length;
  const list = ` (${named.join(", ")}${more ? `, and ${more} more` : ""})`;
  const what = one ? path.join(where.root, names[0]) : `${names.length} directories in ${where.root}${list}`;
  if (where.reason !== null) return `${what} could not be checked against the registry (${where.reason}); left alone`;
  const head = `${what} cannot be matched to a turn in the registry; left alone.`;
  if (!where.shared) {
    return `${head} Relay removes a turn's directory here only once it matches a settled turn in this registry and nothing still uses it; a directory of a turn run under another control directory (RELAY_HOME), or of one no longer recorded, never matches.`;
  }
  // An observation, not a promise: on one Mac with macOS 27 (2026-10-21) nothing in the per-user
  // temporary directory was older than the Mac's last start, while files there untouched for days
  // stayed. dirhelper(8) documents no cleanup at restart, and its launchd job's 3-day rule
  // (CLEAN_FILES_OLDER_THAN_DAYS) had not removed those files.
  const restart = platform === "darwin" && /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(where.root)
    ? ` On macOS 27 this directory has been seen emptied when the Mac restarts (2026-10-21).` : "";
  const them = one ? "it" : "them";
  return `${head} Relay builds before 1.0 made turns' directories here without recording which turn made which, so relay cannot tell what made ${them} or whether anything still uses ${them}; 1.0 makes and uses none here.${restart}`;
}

/** A failed process inspection is unknown liveness, never evidence that a directory is unused. */
function mayLive(pid: number | null, start: string | null): boolean {
  return sameProcess(pid, start) || (pidAlive(pid) && procStart(pid) === null);
}

function turnTempUnused(turn: TurnRow): boolean {
  if (!["done", "refused", "failed", "cancelled", "lost"].includes(turn.status)) return false;
  const node = getNode(turn.node_id);
  if (!node || mayLive(node.worker_pid, node.worker_start) || mayLive(node.agent_pid, node.agent_start)) return false;
  if (launchReservationProblem(node.run_id, node.id)) return false;
  if (groupAlive(node.agent_pgid)) {
    // A leader known to have a different start time is a reused process-group number. Without
    // that positive evidence, a group whose leader has exited may still contain descendants.
    if (!node.agent_start || !pidAlive(node.agent_pgid) || !procStart(node.agent_pgid) || sameProcess(node.agent_pgid, node.agent_start)) return false;
  }
  const procs = db().prepare("SELECT pid, start FROM relay_procs WHERE node_id = ?").all(node.id) as { pid: number; start: string }[];
  if (procs.some((p) => mayLive(p.pid, p.start))) return false;
  // A stage-2 executor of the node that is still running (its record not yet acted on): its commands may use the turn's directories.
  return !nodeHasLiveExecutor(node.id);
}

/** A stage-2 turn's copy of its skill package (codex-stage2.ts stage2SkillAssets), made with mkdtemp. */
const SKILL_ASSETS = /^relay-ext-[A-Za-z0-9]{6}$/;

/** The turn whose skill-asset copy `dir` is, as its node's params name it (SessionParams.ext_assets), or null. */
function skillAssetsTurn(dir: string): { nodeId: string; turnId: number } | null {
  const rows = db().prepare("SELECT id, params_json FROM nodes WHERE params_json LIKE '%ext_assets%'").all() as { id: string; params_json: string | null }[];
  for (const r of rows) {
    for (const [turn, d] of Object.entries(sessionParams(r).ext_assets ?? {})) if (d === dir && Number.isInteger(Number(turn))) return { nodeId: r.id, turnId: Number(turn) };
  }
  return null;
}

/**
 * Removes temporary directories relay made and no longer needs, whatever the config, and returns
 * them, with what could not be looked at or removed. It never throws: a part of the sweep that
 * cannot be done (a temporary directory that is not there, say) is said, and the others are still
 * done. A crash (a worker killed, a machine stopped) leaves them behind; otherwise relay removes
 * each itself. Each is relay's by its name and owned by this user, and none is touched while
 * whatever made it may still use it:
 * - a confined turn's broker directory, or a probe's decoy of one (relay-sockets/relay-turn-*,
 *   relay-probe-*), from more than an hour ago, whose socket nobody listens on any more or that
 *   never got one; only where relay-sockets is a plain directory of this user's, not a link;
 * - a confinement probe's scratch directory ($TMPDIR/relay-probe-*), from more than an hour ago
 *   (a probe takes seconds);
 * - a turn's private relay-tmp-* directory, matched by path/device/inode in the registry, only
 *   after the turn settles and its worker, agent, group and registered processes are gone;
 * - the build directory of a job's identity file (beside its worktree), from more than ten minutes
 *   ago, which relay renames into place a moment after making it;
 * - a forgotten run's directories that could not be removed when it was forgotten (.forgotten-*),
 *   or put back if the registry still lists the run;
 * - stage 2: an executor whose relay process is gone (its record in `<relay home>/executors`), stopped
 *   with its group, descendants and detached processes, its ports given back (stage2-executors.ts),
 *   first, before any turn's directory is looked at; and a turn's skill-asset copy
 *   (relay-ext-* in relay's private root), only where the registry names it for a turn that
 *   is over, as for relay-tmp-*. One no registry entry names is left alone and said.
 */
export async function sweepTemps(o: { at?: number } = {}): Promise<Swept> {
  const at = o.at ?? Date.now();
  const out: Swept = { removed: [], problems: [] };
  const entries = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") out.problems.push(`${dir} could not be read (${(err as Error).message})`);
      return [];
    }
  };
  const remove = (dir: string, reported = dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      out.removed.push(reported);
    } catch (err) {
      out.problems.push(`${dir} could not be removed (${(err as Error).message})`);
    }
  };
  /** The directory `name` in `parent`, if it is one of this user's, last changed more than `age` ago. */
  const old = (parent: string, name: string, age: number): string | null => {
    const dir = path.join(parent, name);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(dir, { throwIfNoEntry: false });
    } catch (err) {
      out.problems.push(`${dir} could not be looked at (${(err as Error).message})`);
      return null;
    }
    return st && mine(st) && at - st.mtimeMs >= age ? dir : null;
  };
  /** One part of the sweep: what stops it is said, and the parts after it are still done. */
  const part = async (what: () => string, sweep: () => Promise<void> | void) => {
    try {
      await sweep();
    } catch (err) {
      out.problems.push(`${what()} was not swept (${(err as Error).message})`);
    }
  };
  const tmpDir = () => `the temporary directory ${os.tmpdir()}`;

  // First: an executor left running by a relay process that died. Only one whose owner is gone, and
  // only the process recorded (pid and start time); its turn's directories wait until it is stopped.
  await part(() => "stage-2 executors left by relay processes that have gone", () => {
    const r = sweepOrphanedExecutors();
    out.removed.push(...r.stopped);
    out.problems.push(...r.problems);
  });

  await part(() => `relay's sockets directory in ${tmpDir()}`, async () => {
    const sockets = relaySocketsDir();
    // Only relay's own, as ensureRelaySocketsDir makes it: through a link, or in a directory of
    // someone else's, what would be removed is not in relay's sockets directory.
    const st = fs.lstatSync(sockets, { throwIfNoEntry: false });
    if (!st) return;
    if (!mine(st)) {
      out.problems.push(`${sockets} is not a plain directory of this user's, so relay did not sweep it`);
      return;
    }
    for (const name of entries(sockets)) {
      const dir = BROKER_DIR.test(name) ? old(sockets, name, HOUR) : null;
      if (!dir) continue;
      const socket = path.join(dir, "relay.sock");
      if (fs.existsSync(socket) && (await listening(socket))) continue;
      remove(dir);
    }
  });
  for (const parent of new Set([os.tmpdir(), privateStateRoot()])) await part(() => parent, () => {
    if (parent === privateStateRoot()) {
      const st = fs.lstatSync(parent, { throwIfNoEntry: false });
      if (!st) return;
      if (!mine(st)) throw new Error("not a plain private directory of this user's");
    }
    const tmp = fs.realpathSync(parent);
    for (const name of entries(tmp)) {
      const dir = PROBE_SCRATCH.test(name) ? old(tmp, name, HOUR) : null;
      if (dir) remove(dir);
    }
  });
  await part(() => `stage-2 skill copies in ${privateStateRoot()}`, () => {
    const parent = privateStateRoot();
    const st = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (!st) return;
    if (!mine(st)) throw new Error("not a plain private directory of this user's");
    for (const name of entries(parent)) {
      if (!SKILL_ASSETS.test(name)) continue;
      const dir = path.join(parent, name);
      const dst = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (!dst || !mine(dst)) continue;
      const owner = skillAssetsTurn(dir);
      if (!owner) {
        out.problems.push(`${dir} cannot be matched to a turn in the registry; left alone`);
        continue;
      }
      const turn = getTurn(owner.turnId);
      if (!turn || turn.node_id !== owner.nodeId) {
        out.problems.push(`${dir} is named for turn ${owner.turnId} of ${owner.nodeId}, which the registry does not have; left alone`);
        continue;
      }
      if (!turnTempUnused(turn)) continue;
      remove(dir);
      if (!fs.existsSync(dir)) dropSkillAssets(owner.nodeId, owner.turnId);
    }
  });
  await part(() => `turns' private directories in ${tmpDir()}`, () => {
    for (const entry of privateTurnTemps()) {
      if (entry.problem) { out.problems.push(entry.problem); continue; }
      if (!entry.turn || !entry.st) continue;
      // Recheck and rename under the registry lock; recursively delete only after committing.
      // Keep the new path with the same device/inode so a crash or failed removal can be retried.
      const aside = tx(() => {
        const turn = getTurn(entry.turn!.id);
        if (!turn || turn.tmp_dir !== entry.turn!.tmp_dir || turn.tmp_dev !== entry.st!.dev || turn.tmp_ino !== entry.st!.ino || !turnTempUnused(turn)) return;
        const st = fs.lstatSync(entry.dir, { throwIfNoEntry: false });
        if (!st?.isDirectory() || st.isSymbolicLink() || st.dev !== entry.st!.dev || st.ino !== entry.st!.ino) return;
        const aside = entry.dir.endsWith(".swept") ? entry.dir : `${entry.dir}.swept`;
        if (aside !== entry.dir) {
          if (fs.lstatSync(aside, { throwIfNoEntry: false })) throw new Error(`${aside} already exists; left alone`);
          fs.renameSync(entry.dir, aside);
        }
        try { db().prepare("UPDATE turns SET tmp_dir = ? WHERE id = ?").run(aside, turn.id); }
        catch (err) { if (aside !== entry.dir) fs.renameSync(aside, entry.dir); throw err; }
        return aside;
      });
      if (aside) remove(aside, entry.dir);
    }
  });
  /** The worktrees home, when it is there and a plain directory of this user's: through a link, what would be removed is not in relay's own directory. Looked at once. */
  let treesChecked: { trees: string | null } | undefined;
  const treesHome = (): string | null => {
    if (treesChecked) return treesChecked.trees;
    treesChecked = { trees: null };
    const trees = worktreesHome();
    const st = fs.lstatSync(trees, { throwIfNoEntry: false });
    if (st && !mine(st)) out.problems.push(`${trees} is not a plain directory of this user's, so relay did not sweep it`);
    if (st && mine(st)) treesChecked.trees = trees;
    return treesChecked.trees;
  };
  await part(() => `the worktrees' directory ${worktreesHome()}`, () => {
    const trees = treesHome();
    if (!trees) return;
    for (const run of entries(trees)) {
      if (!old(trees, run, 0)) continue;
      for (const name of entries(path.join(trees, run))) {
        const dir = CONTEXT_BUILD.test(name) ? old(path.join(trees, run), name, 10 * 60_000) : null;
        if (dir) remove(dir);
      }
    }
  });
  // A forgotten run's directory left aside; or, should the registry still list its run (relay was
  // killed in the transaction that forgot it), put back. Decided, and put back, under the registry's
  // lock: a run another relay process is forgetting at this moment (its directories aside, its rows
  // not yet gone) is waited for, so that nothing is put back for a run the registry then loses.
  // A forgotten run's worktrees (relay clean --forget) are put back into its directory there.
  await part(() => "the directories of forgotten runs", () => {
    const trees = treesHome();
    for (const parent of [path.join(relayHome(), "runs"), harnessHome(), ...(trees ? [trees] : [])]) {
      for (const name of entries(parent)) {
        const dir = name.startsWith(ASIDE) ? old(parent, name, 0) : null;
        if (!dir) continue;
        const id = name.slice(ASIDE.length);
        let listed: boolean;
        try {
          listed = tx(() => {
            if (!getRun(id)) return false;
            if (parent === trees) putTreesBack(trees, id, dir);
            else fs.renameSync(dir, path.join(parent, id));
            return true;
          });
        } catch (err) {
          out.problems.push(`${dir} was left as it is: relay could not check it against the registry or put it back for ${id} (${(err as Error).message})`);
          continue;
        }
        if (!listed) remove(dir);
      }
    }
  });
  return out;
}
