import { closeTurns, db, getNode, nextQueuedTurn, recordLaunchLeader, registerSelf, runConfig, tx, updateNode } from "./core/db.js";
import { procStart } from "./core/procs.js";
import { finishNode, finishTurn, settleIdle } from "./core/outcome.js";
import { cancelActiveTurns, isCancelled, runSessionTurn } from "./core/session.js";
import { housekeepDaily } from "./core/retention.js";
import { loadConfig } from "./core/config.js";
import { redact } from "./core/secrets.js";
import { storageProblem } from "./core/storage.js";
import { workerRedaction } from "./core/env-broker.js";
import { nextOverlayTurn } from "./core/restart-overlay.js";

let terminating = false;

/**
 * Entry point of a detached worker. A worker owns one session and drains its queued turns. It
 * outlives the MCP server that started it, because a child agent's MCP server exits when that
 * agent's turn ends.
 */
export async function runWorker(nodeId: string): Promise<void> {
  // Until the owning root supplies its redaction-only set, no path or diagnostic line can be
  // vouched for. Withhold whole writes, including buffers, rather than leak unknown root values.
  let redactionReady = false;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => write(redactionReady
      ? redact(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"))
      : "relay: worker diagnostic withheld: root redaction values unavailable\n", ...rest)) as typeof stream.write;
  }
  const node = getNode(nodeId);
  if (!node) throw new Error(`unknown node ${nodeId}`);
  updateNode(nodeId, { worker_pid: process.pid, worker_start: procStart(process.pid) });
  registerSelf("worker", nodeId);
  // The worker runs detached (dispatch.ts), so it leads its own session and group: record its pid
  // as a launched leader for the run's lifetime, so a process left in its group or session is
  // placed inside the launched tree even after the worker has died (src/core/presence.ts).
  recordLaunchLeader(node.run_id, process.pid, "worker", nodeId);

  const stop = () => {
    if (terminating) return;
    terminating = true;
    // Once its turns have ended, the session loop records them (each turn cancelled, the node
    // settled, the worker's claim let go) and the worker ends by itself when nothing is left to do,
    // its writes included. The timer is only a ceiling, for whatever might still hold the process
    // open, and does not itself keep it open.
    void cancelActiveTurns().then(() => setTimeout(() => process.exit(0), 300).unref());
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const cancelCheck = () => terminating || isCancelled(nodeId);

  try {
    // Fail the queued turns before recording prompts or errors that could contain root values.
    // Housekeeping still runs below, with diagnostic writes withheld if this claim fails.
    await workerRedaction(nodeId);
    redactionReady = true;
    // Only sessions have workers. A discussion or a review is a record that its caller advances.
    if (node.kind !== "job" && node.kind !== "thread" && node.kind !== "participant") throw new Error(`a ${node.kind} has no worker`);
    await sessionWorker(nodeId, cancelCheck);
  } catch (err) {
    // What a person can act on when the control directory is full or not writable; otherwise the
    // stack. No turn of the session is left marked running or queued with no worker to run it.
    const problem = redactionReady ? storageProblem(err, "the session's worker stopped there") : null;
    const error = redactionReady ? redact(problem ? `${problem}.` : `worker error: ${(err as Error).stack ?? err}`)
      : "the owning root's environment broker could not supply worker redaction values: restart the root, or on a shared relay call relay again from the conversation that owns this run, before resuming";
    // Together, as a turn's end is recorded with its session's (outcome.ts finishTurn).
    tx(() => {
      closeTurns(nodeId, "failed", error);
      finishNode(nodeId, "failed", { error, worker_pid: null });
    });
  }
  // With its session's turns done (not before, which would hold them up), at most once a day: the
  // sweep of relay's leftover temporary directories, and old runs' records where keep_records_days
  // is set. Retention is the person's policy now, not the run's when it began: their config as it is.
  // Not on the way out after a stop.
  try {
    if (!terminating) await housekeepDaily(loadConfig());
  } catch (err) {
    console.error(`relay: housekeeping was not done: ${(err as Error).message}`);
  }
}

async function sessionWorker(nodeId: string, cancelCheck: () => boolean): Promise<void> {
  for (;;) {
    // Releasing ownership and finding the inbox empty happen in one transaction, so a message
    // queued at the same moment either is seen here or finds no live worker and starts a new one.
    const turn = tx(() => {
      const t = cancelCheck() ? undefined : nextOverlayTurn(nodeId) ?? nextQueuedTurn(nodeId);
      if (!t) {
        updateNode(nodeId, { worker_pid: null, worker_start: null });
        // Requeued for a turn that was cancelled before it ran, the node is not left queued.
        if (!cancelCheck()) settleIdle(nodeId);
      }
      return t;
    });
    if (!turn) {
      // Leaving because of a cancel must not strand the node as queued with no worker.
      if (cancelCheck()) finishNode(nodeId, "cancelled");
      return;
    }
    const node = getNode(nodeId)!;
    const cfg = runConfig(node.run_id);
    db().prepare("UPDATE nodes SET status = 'queued', ended_at = NULL WHERE id = ? AND status != 'cancelled'").run(nodeId);

    const o = await runSessionTurn(nodeId, turn.id, turn.body, turn.access, node.kind === "job" ? cfg.job_timeout_s : cfg.turn_timeout_s, cancelCheck);
    // Cancelled while it waited for a slot: nothing ran, so nothing is recorded.
    if (o.skipped) continue;
    // What the turn produced is recorded, and the session goes on to its next turn or settles, in one transaction.
    finishTurn(node, turn, o, cfg);
  }
}
