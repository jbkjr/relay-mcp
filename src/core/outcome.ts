// What a session's turn produced, and how its item settles: the result recorded when a turn ends
// (a job's report and the git half of it, a thread's reply, what the agent was refused, process
// warnings), recorded with the session's settling in one transaction (finishTurn), the outcome its
// node ends with, and what is said up front when it is reported
// (blocked, no_changes, re-checked as the result stands now), and what a job's result showed of its
// work, which is what merge takes (shownWork). A session borrowed for a discussion keeps its own outcome
// apart from the discussion's turns (OwnOutcome).
import path from "node:path";
import { refusalNote } from "./refusal.js";
import type { Json } from "./caller.js";
import { nodeDir, type RelayConfig } from "./config.js";
import { ACTIVE, db, getNode, nextQueuedTurn, now, tx, updateNode, type NodeRow, type NodeStatus, type TurnRow } from "./db.js";
import { sessionParams } from "./params.js";
import { parseReport } from "./prompts.js";
import type { TurnOutcome } from "./session.js";
import { keepRecord } from "./storage.js";
import { endJobTurn, stillUnchanged } from "./worktree.js";

/**
 * Records a turn's end for its session, once the turn's agent has ended (runSessionTurn): what the
 * turn produced, and the session going on to its next queued turn or settling. Relay's slow work on
 * the turn comes first (its final message's file, a job's git half), so that a job's commit is in
 * its result before the job shows as settled. Everything the registry is then told is one
 * transaction: a reader, and a call waiting on the turn (db.ts turnSettled), finds the result with
 * the session settled and a failed turn's queued turns dropped, or none of it. A message queued
 * meanwhile is either seen here (it runs next, or is dropped with a failed turn), or finds the
 * session settled and puts it back in the queue.
 */
export function finishTurn(node: NodeRow, turn: TurnRow, o: TurnOutcome, cfg: RelayConfig): void {
  const made = turnRecord(node, turn, o, cfg);
  tx(() => {
    // A turn that never started is recorded as over here, with its session (runSessionTurn).
    o.close?.();
    recordTurn(node, made, o);
    // With more messages queued the node goes straight on to the next turn. A discussion turn that
    // failed is the discussion's failure: the session's own messages queued behind it still run.
    // Going on, it shows as queued from here until its next turn holds a slot (worker.ts, which
    // does the same before each turn), so that this turn's end shows as recorded (db.ts turnSettled).
    if (o.restartPending || (nextQueuedTurn(node.id) && (o.status === "ok" || made.discussionTurn))) {
      db().prepare("UPDATE nodes SET status = 'queued', ended_at = NULL WHERE id = ? AND status != 'cancelled'").run(node.id);
      return;
    }
    settle(node.id, o, made);
  });
}

/** What a turn produced, ready to be recorded (recordTurn): the node's result and error, and whether the turn was a discussion's. */
interface TurnRecord {
  discussionTurn: boolean;
  result: Json;
  error: string | null;
}

/**
 * Makes ready the record of what a turn produced, once it has ended: its final message, kept whole
 * in a file, and the node's result, with a job's git half. A job's or thread's result is its own
 * work: a reply it wrote in a discussion it was borrowed for belongs to the discussion (which reads
 * it from the turn), not in place of that result, and so does not touch the job's result or own
 * outcome (discussionTurn).
 */
function turnRecord(node: NodeRow, turn: TurnRow, o: TurnOutcome, cfg: RelayConfig): TurnRecord {
  // Kept whole in a file (by runSessionTurn, for a turn whose agent ran); where that cannot be
  // written (a full disk, say), whole in the result instead.
  const warnings = [...o.warnings];
  let finalPath = o.finalPath;
  if (finalPath === undefined) {
    const at = path.join(nodeDir(node.run_id, node.id), `final-${turn.id}.md`);
    const problem = keepRecord(at, o.finalMessage, { consequence: "the final message is kept only in the registry" });
    if (problem) warnings.push(`${problem}.`);
    finalPath = problem ? null : at;
  }
  const unkept = finalPath === null;
  let result: Json;
  const hasOwnOutcome = node.kind === "job" || node.kind === "thread";
  const discussionTurn = hasOwnOutcome && turn.source.startsWith("discussion:");
  if (node.kind === "job") {
    const cap = 6000;
    result = {
      ...parseReport(o.finalMessage),
      final_message: o.finalMessage.length > cap && !unkept ? `${o.finalMessage.slice(0, cap)}\n… (truncated; full text at final_message_path)` : o.finalMessage,
      ...(finalPath === null ? {} : { final_message_path: finalPath }),
    };
    // The git half: commit, tip, diff, and whether the turn changed nothing (worktree.ts).
    result = { ...result, ...endJobTurn(node, turn, o, cfg) };
  } else {
    result = { reply: o.finalMessage };
  }
  // Warnings about processes stay with the result however the turn ended, and so does what the agent
  // was refused; a warning about the speed it ran at is shown with them.
  warnings.push(...(o.speedWarnings ?? []));
  if (warnings.length) result = { ...result, warnings };
  const notes = sessionParams(getNode(node.id)!).notes;
  if (notes?.length) result = { ...result, notes };
  if (o.denials?.length) result = { ...result, blocked: o.denials };
  if (o.refusal) result = { ...result, outcome: "refused", refusal: o.refusal, unfinished: true, note: refusalNote(o.refusal), ...(node.worktree ? { worktree: node.worktree } : {}) };
  return { discussionTurn, result, error: o.status === "ok" ? null : (o.error ?? o.status) };
}

/** Records what a turn produced (turnRecord) as the node's result and, for a job or thread, its own outcome; nothing for a discussion's turn. */
function recordTurn(node: NodeRow, made: TurnRecord, o: TurnOutcome): void {
  if (made.discussionTurn) return;
  updateNode(node.id, { result_json: JSON.stringify(made.result), error: made.error });
  if (node.kind === "job" || node.kind === "thread") recordOwnOutcome(node.id, { status: outcomeStatus(o), error: made.error });
}

/**
 * Settles a session whose turns have run out: with its own outcome after a discussion turn (a
 * job or thread borrowed for a discussion), otherwise with its turn's. A turn that did not finish takes the
 * session's queued turns with it, unless it was a discussion's.
 */
function settle(nodeId: string, o: TurnOutcome, { discussionTurn }: { discussionTurn: boolean }): void {
  const own = discussionTurn ? ownOutcome(getNode(nodeId)!) : undefined;
  if (own) finishNode(nodeId, own.status, { error: own.error });
  else finishNode(nodeId, outcomeStatus(o));
  if (o.status !== "ok" && !discussionTurn) {
    db().prepare("UPDATE turns SET status = 'cancelled', ended_at = ? WHERE node_id = ? AND status = 'queued'").run(now(), nodeId);
  }
}

/** Sets a terminal status unless the node was cancelled in the meantime; other fields always apply. */
export function finishNode(nodeId: string, status: NodeStatus, fields: Partial<NodeRow> = {}): void {
  updateNode(nodeId, { ...fields, ended_at: now() });
  db().prepare("UPDATE nodes SET status = ? WHERE id = ? AND status IN ('queued', 'running')").run(status, nodeId);
}

/**
 * A job's or thread's own outcome (the status and error its own work last ended with), kept apart from the
 * session's latest turn: a session borrowed for a discussion runs turns that are the discussion's,
 * and how they end is not the session's status. Kept in params_json, read fresh, so nothing else there is lost.
 */
export interface OwnOutcome { status: NodeStatus; error: string | null }
export function recordOwnOutcome(nodeId: string, own: OwnOutcome): void {
  // One statement, so that it is atomic inside or outside a transaction.
  db().prepare("UPDATE nodes SET params_json = json_set(COALESCE(params_json, '{}'), '$.own', json(?)) WHERE id = ?").run(JSON.stringify(own), nodeId);
}
const ownOutcome = (n: NodeRow): OwnOutcome | undefined => sessionParams(n).own;

/**
 * Settles a session left queued with nothing to run: it was requeued for a turn (a discussion's)
 * that was cancelled before it ran. It goes back to how its work last ended: a job to its own
 * outcome (as does a thread), any other session to its latest executed turn's, blocked where that turn finished but
 * its agent was refused something (its denials, as outcomeStatus reads them; review C10/X3).
 */
export function settleIdle(nodeId: string): void {
  const n = getNode(nodeId);
  if (!n || n.status !== "queued") return;
  if (db().prepare("SELECT 1 FROM turns WHERE node_id = ? AND status IN ('queued', 'running') LIMIT 1").get(nodeId)) return;
  const hasOwnOutcome = n.kind === "job" || n.kind === "thread";
  const own = hasOwnOutcome ? ownOutcome(n) : undefined;
  const last = db().prepare(`SELECT status, error, denials FROM turns WHERE node_id = ? AND status IN ('done', 'failed', 'refused')${hasOwnOutcome ? " AND source NOT LIKE 'discussion:%'" : ""} ORDER BY ended_at DESC, id DESC LIMIT 1`)
    .get(nodeId) as { status: string; error: string | null; denials: string | null } | undefined;
  const refused = last?.status === "done" && (last.denials ? (JSON.parse(last.denials) as unknown[]) : []).length > 0;
  const status: NodeStatus = own?.status ?? (last?.status === "refused" ? "refused" : last?.status === "failed" ? "failed" : refused ? "blocked" : "done");
  const error = own ? own.error : last?.status === "failed" || last?.status === "refused" ? last.error : null;
  db().prepare("UPDATE nodes SET status = ?, error = ?, ended_at = ? WHERE id = ? AND status = 'queued'").run(status, error, now(), nodeId);
}

function outcomeStatus(o: TurnOutcome): NodeStatus {
  if (o.status === "refused") return "refused";
  // The agent says it finished, but its own stream says it was refused something on the way.
  if (o.status === "ok") return o.denials?.length ? "blocked" : "done";
  if (o.timedOut) return "timeout";
  return o.status === "interrupted" ? "cancelled" : "failed";
}

/** True when a job that changed nothing had its worktree and empty branch removed. */
export const removedBranch = (res: Json | null) => Boolean(res?.no_changes) && res?.branch === null;

/**
 * What a job's result showed of its work: the commit its diff summary is of. A result written before
 * relay recorded that commit (0.9.0) names none. A job whose work relay could not commit when its
 * turn ended, or that has no result at all, showed none of it. Merge takes what it shows (ops.ts).
 */
type Shown = { commit: string } | { legacy: true } | { unshown: string };
export function shownWork(job: NodeRow): Shown {
  const res = job.result_json ? (JSON.parse(job.result_json) as Json) : null;
  if (!res) return { unshown: `${job.id} has no result (it is ${job.status}): no turn of it got as far as relay committing its work and writing a diff summary of it` };
  if (typeof res.checkpoint_error === "string") {
    return { unshown: `relay could not commit ${job.id}'s work when the turn its result is from ended (${res.checkpoint_error}), so that result's diff summary does not show the work` };
  }
  if (!("commit" in res)) return { legacy: true };
  if (typeof res.commit !== "string") return { unshown: `relay could not tell which commit ${job.id}'s result showed` };
  return { commit: res.commit };
}

/**
 * A settled job's result as it stands now. no_changes is what its turn's end found; where the
 * worktree was kept because something the job started may still be running in it, that can have
 * written since, so the claim is checked again whenever it is reported.
 */
export function resultNow(n: NodeRow, res: Json | null): Json | null {
  if (!res?.no_changes || removedBranch(res) || ACTIVE.includes(n.status) || !n.base_sha) return res;
  const withdrawn = (late: string): Json => {
    const { no_changes: _, ...rest } = res;
    return { ...rest, warnings: [...((rest.warnings as string[] | undefined) ?? []), late] };
  };
  // Relay commits what is left in a kept worktree before merging it or removing it (merge, clean),
  // and records the branch's tip then (saveTip): a tip past the base is a change, whether or not
  // the worktree is still there to look at (review C8).
  if (n.head_sha && n.head_sha !== n.base_sha) {
    return withdrawn("Its turn ended without changing anything, but its branch has commits since: relay committed what was written in its kept worktree after the turn (before a merge, or in relay clean). Look at the branch.");
  }
  const now_ = stillUnchanged(n);
  if (now_ === true) return res;
  return withdrawn("error" in now_
    ? `Its turn ended without changing anything, but relay can no longer look at its worktree: ${now_.error}.`
    : "Its turn ended without changing anything, but its worktree has changed since: something it started kept running there. Look at the worktree before merging it.");
}

/** What a turn's agent was refused, from the turn's record. */
export const denialsOf = (t: { denials: string | null }): string[] => (t.denials ? (JSON.parse(t.denials) as string[]) : []);
export const BLOCKED_NOTE = "The agent finished its turn but was refused something it tried (listed in blocked), so its work may be incomplete.";

/**
 * What a settled item produced, where that is worth saying up front rather than leaving in its
 * result: a turn whose agent was refused something (blocked), and a write job whose turn finished
 * without changing anything.
 */
export function outcomeView(n: NodeRow, res: Json | null): Json | null {
  const out: Json = {};
  const notes: string[] = [];
  if (n.status === "refused" && res?.refusal) {
    Object.assign(out, { outcome: "refused", refusal: res.refusal, unfinished: true });
    if (typeof res.note === "string") notes.push(res.note);
  }
  if ((n.status === "blocked" || n.status === "refused") && Array.isArray(res?.blocked)) {
    out.blocked = res.blocked;
    notes.push(n.status === "refused" ? "Before its turn stopped, the agent was also refused actions listed in blocked." : `${BLOCKED_NOTE} Its final report should say what it needed: resume it with a grant, or with other instructions.`);
  }
  if (n.kind === "job" && n.mode === "write" && res?.no_changes) {
    out.outcome ??= "no_changes";
    // What relay checked is git's view (commits, uncommitted and untracked files), not every file:
    // one git ignores is not counted (review C16).
    notes.push("The job finished with no changes to merge: its branch is still at its base, with nothing uncommitted or untracked (files git ignores are not counted). Its final report may say why; resume it to try again.");
  }
  return Object.keys(out).length ? { ...out, ...(notes.length ? { outcome_note: notes.join(" ") } : {}) } : null;
}
