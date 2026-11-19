// Dispatch: starting the detached worker that runs a session's queued turns, and queueing turns.
// A call that queues a turn commits it first, then starts the worker (review X1): a failure to
// start is not the call's error, and a later call starts it (redispatch).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nodeDir, RELAY_CLI, type Mode } from "./config.js";
import { ownsRun, type Instance } from "./caller.js";
import { ACTIVE, db, getNode, getRun, insertTurn, nextQueuedTurn, now, runConfig, tx, updateNode, workerLive, type NodeRow } from "./db.js";
import { logBytes, noteDiagnosticProblem, rotateLog, writeProblem } from "./storage.js";
import { workerEnvironment } from "./env-broker.js";

/** Starts a detached worker for the node unless one already owns it. */
export function ensureWorker(nodeId: string): void {
  const claimedAt = now();
  const claimed = tx(() => {
    const n = getNode(nodeId)!;
    if (workerLive(n)) return false;
    updateNode(nodeId, { worker_pid: -1, worker_start: null, worker_claimed_at: claimedAt });
    return true;
  });
  if (!claimed) return;
  try {
    const n = getNode(nodeId)!;
    // The worker's own output, rotated at the run's log_max_mb. A log that cannot be opened (a full
    // disk, a directory that is not writable) does not keep the worker from starting: what goes
    // wrong for its turn then is recorded in the registry, and the log's failure is said with this
    // process's next result (storage.ts noteDiagnosticProblem). Whether the turn can still run
    // depends on what else it must write there (its node directory, its launch files), so that is
    // left to the turn's own result to say.
    // The failure names the run's paths: said only to the conversation that owns the run.
    let fd: number | null = null;
    let logFile = "its worker.log";
    const owner = getRun(n.run_id)?.root_token ?? null;
    try {
      logFile = path.join(nodeDir(n.run_id, nodeId), "worker.log");
      const unrotated = rotateLog(logFile, logBytes(runConfig(n.run_id)));
      if (unrotated) noteDiagnosticProblem(logFile, `relay could not rotate ${logFile} at log_max_mb (${unrotated}), so it grows past that size`, owner);
      fd = fs.openSync(logFile, "a");
    } catch (err) {
      fd = null;
      noteDiagnosticProblem(logFile, writeProblem(logFile, err, `what the worker of ${nodeId} prints is not kept`), owner);
    }
    try {
      const out = fd ?? "ignore";
      const child = spawn(process.execPath, [RELAY_CLI, "worker", nodeId], { detached: true, stdio: ["ignore", out, out], env: workerEnvironment(n.run_id) });
      child.unref();
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  } catch (err) {
    // No worker was started: the claim is let go, so that the next dispatch (see redispatch) can
    // start one, rather than wait out the claim and then find the node written off as lost.
    db().prepare("UPDATE nodes SET worker_pid = NULL, worker_claimed_at = NULL WHERE id = ? AND worker_pid = -1 AND worker_claimed_at = ?").run(nodeId, claimedAt);
    throw err;
  }
}

/**
 * Starts the node's worker once its work is committed (review X1). A failure does not undo that
 * work and is not the call's error: the item exists, the caller is told its id, and the warning
 * returned here says how it gets started (redispatch).
 */
export function dispatch(nodeId: string): string | null {
  try {
    ensureWorker(nodeId);
    return null;
  } catch (err) {
    return `relay could not start the worker of ${nodeId} (${(err as Error).message}), so it has not started yet. Call again with the same request_id, or call status with id "${nodeId}", to start it.`;
  }
}

/** Whether this caller may start workers in the run: the root session that owns it, or a launched agent in it. */
export const mayDispatch = (inst: Instance, runId: string) => (inst.ctx.kind === "root" ? ownsRun(inst, runId) : inst.ctx.kind === "child" && inst.ctx.runId === runId);

/**
 * Starts the worker of a session left queued with a turn to run and no worker: one whose call
 * committed the work and then could not start a worker, or ended before it did (review X1). A
 * session with a worker, or one claimed a moment ago, is left alone: ensureWorker claims once.
 */
export function redispatch(nodeId: string): string | null {
  const n = getNode(nodeId);
  if (!n || n.status !== "queued" || n.worker_pid !== null || !nextQueuedTurn(nodeId)) return null;
  return dispatch(nodeId);
}

/** Puts a finished session back in the queue for another turn; never revives a cancelled one. */
function requeue(nodeId: string): void {
  db().prepare("UPDATE nodes SET status = 'queued', ended_at = NULL, error = NULL WHERE id = ? AND status NOT IN ('cancelled', 'queued', 'running')").run(nodeId);
}

/**
 * Queues a turn for a session, and puts the session back in the queue if it had settled (requeue).
 * `idle` runs first in that case, while the session still shows how it last ended. Call it inside
 * the transaction that records what the turn is for: the session's worker then sees all of it or
 * none. Returns the turn, and whether the session was busy (the turn then runs after its current one).
 */
export function queueTurn(nodeId: string, source: string, body: string, access: Mode, o: { idle?: (n: NodeRow) => void } = {}): { turnId: number; wasActive: boolean } {
  const n = getNode(nodeId)!;
  const wasActive = ACTIVE.includes(n.status);
  const turnId = insertTurn(nodeId, source, body, access);
  if (!wasActive) {
    o.idle?.(n);
    requeue(nodeId);
  }
  return { turnId, wasActive };
}
