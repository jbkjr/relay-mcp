import { escalationEnabled } from "./config.js";
import { escalationDecisionAuthentication } from "./escalation-authority.js";
import fs from "node:fs";
import { verifyNotice, type NoticeProof } from "./notices.js";
import { requestRunsRelayCommand } from "./relay-command.js";
import { recordStart, addContribution, callerLabel, familiesOf } from "./families.js";
import { targetDef, targetLabel } from "../targets/index.js";
import type { Grant } from "../backends/types.js";
import { dirIdentity } from "../confine/index.js";
import { decide, elicitationState, expireRequests, getRequest, requestView } from "./approvals.js";
import { noteCall, once, type CallRow } from "./calls.js";
import { recordEnvironmentRequest } from "./env-broker.js";
import {
  canReadItem, canReadRun, UNAVAILABLE, admitExisting, admitExtensions, admitNew, admitSpeed, admitWork, authority, changeSpeed, claimRun, expand, grantOf, knownCaller, liveChild, ownsRun, persistentGrant, publicGrant, refused, subagentRefusal, type Caller, type Instance, type Json, type ToolCall,
} from "./caller.js";
import { inside, loadConfig, networkOn, type Mode, type RelayConfig, type Speed, type Target } from "./config.js";
import { writeWorktreeContext } from "./context.js";
import { extensionsView, holdsServers, PERSON_ROUTES, personOnly, type SessionExtensions } from "./extensions.js";
import { ACTIVE, ancestors, busy, cancelledAbove, closeTurns, db, descendants, getNode, getRun, getTurn, insertNode, insertTurn, newId, now, reap, relayProcs, runConfig, runNodes, setParam, speedAfter, tx, turnSettled, updateNode, workerLive, workCwd, type NodeRow } from "./db.js";
import { dispatch, mayDispatch, queueTurn, redispatch } from "./dispatch.js";
import { groupAlive, sameProcess, stopSupervised } from "./procs.js";
import { branchChanges, checkpoint, continueMerge, deleteBranchIfMerged, filterRefusal, git, jobTree, mergeBranch, treeState, worktreeChanges, type Changes, type Worktree } from "./git.js";
import { discussionParams, localNetworkKey, reviewParams, sessionParams, speedOf } from "./params.js";
import { rawNetworkKey } from "./raw-network.js";
import { stopNodeExecutorsNow } from "./stage2-executors.js";
import { consultHeader, contextBlock, delegationPreamble } from "./prompts.js";
import { BLOCKED_NOTE, denialsOf, removedBranch, shownWork } from "./outcome.js";
import { refusalNote, type VendorRefusal } from "./refusal.js";
import { recordsReport, sweepTemps, type Swept } from "./retention.js";
import { registryBackups } from "./storage.js";
import { approvalsFor, nodeView, notesView, pendingHandle, renderTree, runRecovery } from "./views.js";
import { settled, waitFor, waitOpts, waitUntil } from "./wait.js";
import { checkoutAt, discardJobWorktree, nodeTree, openJobWorktree, retire } from "./worktree.js";
import { discuss as holdDiscussion, discussionView, LEGACY_NOTE, legacyTwoSided, settleDiscussion, type DiscussArgs } from "../modes/discussion.js";
import { openReviewOf, review as runReview, reviewOnly, reviewView, type ReviewArgs } from "../modes/review.js";

// Kept for tests that build a server from ops (broker.ts imports it from core/caller.ts since E16).
export { newInstance } from "./caller.js";

// Delegate / supervise

interface DelegateArgs {
  target?: Target; task: string; scope?: string[]; mode: Mode; allow_delegation?: boolean;
  model?: string; effort?: string; background?: boolean; cwd?: string; grant?: Grant;
  /** Give the job the extensions the run's config allows for its target, once the person consents (docs/extensions.md). */
  extensions?: boolean;
  /** The job's speed (caller.ts admitSpeed). */
  speed?: Speed;
  /** Names this call, so that repeating it returns what it started (see calls.ts). */
  request_id?: string;
}

/** The task of the topmost item above the node that the registry still has. */
const rootTaskOf = (node: NodeRow): string => ancestors(node, { self: true }).at(-1)!.task;

/**
 * Where the person was working, for a new write job's prompt: the caller's position in its checkout,
 * or, for a caller at a job's worktree root (a nested job, which always starts there), the position
 * that job recorded.
 */
function subdirFor(wt: Worktree | null, parent: NodeRow | null): string | undefined {
  if (wt?.subdir) return wt.subdir;
  if (!wt || !parent?.worktree) return undefined;
  const inherited = sessionParams(parent).subdir;
  return typeof inherited === "string" && inherited ? inherited : undefined;
}

/** What a call that gave extensions is told about consent. */
const EXTENSIONS_NOTE =
  `The agent starts only once the user consents to these extensions: relay files a request (kind extensions, marked person_only) that only they can allow, ${PERSON_ROUTES}. You may deny it. ` +
  "A session given MCP servers gets no network and no write paths outside its worktree, and may not start or steer other relay agents.";

/** A turn that is itself read-only cannot cause writes through someone else. */
const READ_ONLY_START = "your current turn is read-only, so you can start only read-only work. Do the reading yourself or delegate it in read mode, and report what would need changing.";

export async function delegate(inst: Instance, a: DelegateArgs, w: ToolCall = {}): Promise<Json> {
  const seen = await once(inst, "delegate", a, w, () => delegate(inst, a, w), (c) => replay(inst, c, a, w));
  if (seen) return seen;
  const admitted = admitNew(inst, { target: a.target, model: a.model, cwd: a.cwd });
  if ("reason" in admitted) return refused(admitted.reason);
  const { caller, to } = admitted;
  if (caller.node && caller.access === "read" && a.mode === "write") return refused(READ_ONLY_START);
  const cfg = runConfig(caller.runId);
  const g = admitWork(caller, to.target, { mode: a.mode, grant: a.grant, continues: false }, w);
  if ("reason" in g) return refused(g.reason);
  const sp = admitSpeed(caller, to.target, { speed: a.speed, model: to.model ?? a.model }, w);
  if ("reason" in sp) return refused(sp.reason);
  let ext: SessionExtensions | undefined;
  if (a.extensions) {
    const e = admitExtensions(inst, caller, to.target, { network: networkOn(cfg, g.grant), writePaths: a.mode === "write" && Boolean(g.grant?.write_paths?.length), allowDelegation: a.allow_delegation }, w);
    if ("reason" in e) return refused(e.reason);
    ext = e.extensions;
  }
  // A job given MCP servers may not delegate (admitExtensions): an agent it started would not have its limits.
  const allowDelegation = a.allow_delegation !== false && !ext?.mcp_servers.length;
  const id = newId("job");
  let wt: Worktree | null = null;
  if (a.mode === "write") {
    const opened = openJobWorktree(caller.cwd, caller.runId, id, cfg.trust_git_filters);
    if ("refusal" in opened) return refused(opened.refusal);
    wt = opened;
  }
  const rootTask = caller.node ? rootTaskOf(caller.node) : "(this assignment is the top-level delegated task)";
  const parentTask = caller.node ? caller.node.task : "(the root session; its own task is not known to relay)";
  const canAsk = escalationEnabled(cfg) && !cfg.allow_dangerous;
  let node: NodeRow;
  try {
    // The identity file first: one that cannot be written fails the call before anything is recorded.
    if (wt) writeWorktreeContext(wt.worktree, { run_id: caller.runId, node_id: id, depth: caller.depth + 1 });
    // The job, its first turn and the request_id's binding are committed together (review X1): a
    // repeat finds either the whole job, ready to run, or nothing, and then starts it afresh.
    node = tx(() => {
      const n = insertNode({
        id, run_id: caller.runId, parent_id: caller.node?.id ?? null, kind: "job", target: to.target, mode: a.mode,
        depth: caller.depth + 1, allow_delegation: allowDelegation ? 1 : 0, task: a.task,
        cwd: wt ? wt.worktree : caller.cwd, repo: wt?.repo ?? null, worktree: wt?.worktree ?? null, branch: wt?.branch ?? null,
        // A harness of several families' models keeps the model its family was judged by, for every turn.
        base_sha: wt?.baseSha ?? null, model: to.model ?? a.model ?? null, effort: a.effort ?? null,
        // subdir: where the caller was in its checkout, which the prompt names. worktree_pin: the
        // worktree as relay just made it, which a relay-enforced turn checks is still the same directory.
        params_json: JSON.stringify({
          scope: a.scope ?? null, grant: persistentGrant(g.grant), speed: sp.speed,
          ...(subdirFor(wt, caller.node) ? { subdir: subdirFor(wt, caller.node) } : {}),
          ...(wt ? { worktree_pin: dirIdentity(wt.worktree) } : {}),
          ...(ext ? { extensions: ext } : {}),
        }),
      });
      recordStart(id, inst, w, to.target, n.model, cfg);
      const firstTurn = insertTurn(id, "caller", delegationPreamble(n, cfg, rootTask, parentTask, a.scope, g.grant, canAsk, ext) + a.task, a.mode);
      recordEnvironmentRequest(firstTurn, g.grant?.env);
      noteCall(inst, a, id);
      return n;
    });
  } catch (err) {
    // Nothing was recorded, so the worktree and branch made for the job belong to nothing.
    if (wt) discardJobWorktree(wt, cfg.trust_git_filters);
    throw err;
  }
  const notStarted = dispatch(id);

  const started: Json = {
    job_id: id, ...runRecovery(caller.runId), target: to.target, families: familiesOf(getNode(id)!), mode: a.mode, depth: node.depth,
    ...(!targetDef(to.target).qualified ? { target_label: targetLabel(targetDef(to.target)) } : {}),
    ...(g.grant ? { grant: publicGrant(g.grant) } : {}),
    ...(ext ? { extensions: extensionsView(ext, { consent: false }), extensions_note: EXTENSIONS_NOTE } : {}),
    // The shape status gives it (views.ts speedView): what was requested, since no harness says what tier served a turn.
    ...(sp.speed !== "standard" ? { speed: { requested: sp.speed } } : {}),
  };
  if (wt) {
    started.branch = wt.branch;
    started.base_sha = wt.baseSha;
    if (wt.callerDirty) started.note = "The job's worktree was branched from your HEAD commit. Your uncommitted changes are not visible to it.";
  }
  if (notStarted) return { ...started, status: "queued", warning: notStarted };
  if (a.background !== false) return { ...started, status: "queued" };
  const done = await waitUntil(() => settled(id), waitOpts(inst, caller.runId, w, { progressOf: id }));
  if (!done) return pendingHandle(id, started, inst);
  const view = nodeView(getNode(id)!);
  // A job that changed nothing may no longer have the branch announced when it started.
  if (removedBranch((view.result as Json | undefined) ?? null)) delete started.branch;
  return { ...started, ...view, ...runRecovery(caller.runId) };
}

/** The session doing the work a discussion or review waits on: the participant, or the reviewer job. */
function awaitedPart(n: NodeRow): string {
  if (n.kind === "discussion") return discussionParams(n).participant;
  const p = reviewParams(n);
  return p.discussion && p.discussion !== "opening" ? (getNode(p.discussion) ? discussionParams(getNode(p.discussion)!).participant : p.reviewer) : p.reviewer;
}

export async function status(inst: Instance, a: { id?: string; wait_s?: number; notice?: NoticeProof }, w: ToolCall = {}): Promise<Json> {
  // Check the pointer before any lookup, wait, reap or redispatch requested by untrusted text.
  // Verification is a separate read: only the returned event tells the model what to call next.
  if (a.notice) return { notice_verification: verifyNotice(inst, a.notice) };
  if (a.id && !canReadItem(inst, a.id)) return UNAVAILABLE();
  if (!a.id) {
    const runId = inst.ctx.kind === "child" ? inst.ctx.runId : inst.runId;
    if (runId && !canReadRun(inst, runId)) return UNAVAILABLE();
    if (!runId) return { run_id: null, nodes: [], note: "Nothing has been started from this session yet." };
    reap(runId);
    // One reading of the run serves the item list and the tree, each item's view built once.
    const nodes = runNodes(runId);
    const views = nodes.map((n) => nodeView(n, false));
    return { ...runRecovery(runId, nodes.length), run_status: getRun(runId)?.status, nodes: views, tree: renderTree(runId, { nodes, views }), ...approvalsFor(runId, inst) };
  }
  if (a.id.startsWith("run_")) {
    if (!getRun(a.id)) return { error: `unknown run ${a.id}` };
    return { ...runRecovery(a.id), run_status: getRun(a.id)!.status, nodes: runNodes(a.id).map((n) => nodeView(n, false)), tree: renderTree(a.id), ...approvalsFor(a.id, inst) };
  }
  const node = getNode(a.id);
  if (!node) return { error: `unknown id ${a.id}` };
  reap(node.run_id);
  // Work its call committed but could not start is started now (review X1), by a session of the run
  // only, so that its worker runs with that session's environment as the first call's would have.
  const notStarted = mayDispatch(inst, node.run_id) && !legacyTwoSided(node) ? redispatch(node.kind === "discussion" || node.kind === "review" ? awaitedPart(node) : node.id) : null;
  if (notStarted) return { ...nodeView(getNode(node.id)!), warning: notStarted, ...approvalsFor(node.run_id, inst) };
  if (legacyTwoSided(node)) {
    const fresh = getNode(node.id)!;
    return { ...nodeView(fresh), note: LEGACY_NOTE, children: descendants(fresh.id).map((n) => nodeView(n, false)), ...approvalsFor(fresh.run_id, inst) };
  }
  // A discussion or review has nothing running of its own: what can be waited for is the other agent's part in it.
  if (node.kind === "discussion" || node.kind === "review") {
    const part = () => {
      const now_ = getNode(node.id)!;
      if (now_.kind === "discussion") return settleDiscussion(now_.id);
      const p = reviewParams(now_);
      return p.discussion ? settleDiscussion(p.discussion) : settled(p.reviewer);
    };
    const ended = a.wait_s && a.wait_s > 0 ? await waitFor(a.id, a.wait_s, part, waitOpts(inst, node.run_id, w, { seconds: a.wait_s, long: true, progressOf: awaitedPart(node), awaits: [node.id] })) : (part(), {});
    if (!canReadItem(inst, node.id)) return UNAVAILABLE();
    const view = node.kind === "discussion" ? discussionView(node.id) : reviewView(node.id);
    return { ...view, ...ended, children: descendants(node.id).map((n) => nodeView(n, false)), ...approvalsFor(node.run_id, inst) };
  }
  const ended = a.wait_s && a.wait_s > 0 ? await waitFor(a.id, a.wait_s, () => settled(a.id!), waitOpts(inst, node.run_id, w, { seconds: a.wait_s, long: true, progressOf: node.id })) : {};
  if (!canReadItem(inst, node.id)) return UNAVAILABLE();
  const fresh = getNode(a.id)!;
  return { ...nodeView(fresh), ...ended, children: descendants(fresh.id).map((n) => nodeView(n, false)), ...approvalsFor(fresh.run_id, inst) };
}

export function result(inst: Instance | null, a: { job_id: string }): Json {
  if (inst && !canReadItem(inst, a.job_id)) return UNAVAILABLE();
  const node = getNode(a.job_id);
  if (!node) return { error: `unknown id ${a.job_id}` };
  reap(node.run_id);
  const fresh = getNode(a.job_id)!;
  if (legacyTwoSided(fresh)) return { ...nodeView(fresh), note: LEGACY_NOTE };
  if (fresh.kind === "discussion") {
    settleDiscussion(fresh.id);
    return discussionView(fresh.id);
  }
  if (fresh.kind === "review") {
    const p = reviewParams(fresh);
    if (p.discussion) settleDiscussion(p.discussion);
    return reviewView(fresh.id);
  }
  if (ACTIVE.includes(fresh.status)) return { ...nodeView(fresh), note: "Not finished yet. Use status with wait_s to wait." };
  const open = descendants(fresh.id).filter((n) => busy(n)).map((n) => n.id);
  return { ...nodeView(fresh), ...(open.length ? { children_still_running: open } : {}) };
}

export function resume(inst: Instance, a: { job_id: string; message: string; grant?: Grant; speed?: Speed }, w: ToolCall = {}): Json {
  if (!canReadItem(inst, a.job_id)) return UNAVAILABLE();
  const node = getNode(a.job_id);
  if (!node || node.kind !== "job") return { error: `${a.job_id} is not a job` };
  const caller = admitExisting(inst, node, "resume");
  if ("reason" in caller) return refused(caller.reason);
  const unknown = knownCaller(inst);
  if (unknown) return refused(unknown);
  const review = openReviewOf(node);
  if (review) return refused(reviewOnly(node, review, "resume"));
  const g = admitWork(caller, node.target!, { mode: node.mode as Mode, grant: a.grant, kept: grantOf(node), continues: true, servers: holdsServers(node), worktree: node.worktree ?? workCwd(node) }, w);
  if ("reason" in g) return refused(g.reason);
  // The job goes on at its own speed unless the call names one; a launched agent may not carry on a job faster than itself.
  const sp = admitSpeed(caller, node.target!, { speed: a.speed, current: speedAfter(node), model: node.model }, w);
  if ("reason" in sp) return refused(sp.reason);
  if (node.status === "cancelled") {
    // Cancel, then resume, is how a job is redirected at once. It works once the cancel has finished.
    if (cancelledAbove(node)) return refused(`${a.job_id} sits under something that was cancelled, so it cannot be resumed. Start a new job instead.`);
    if (workerLive(node) || groupAlive(node.agent_pgid)) return refused(`${a.job_id} is still stopping after its cancel. Try again in a moment.`);
    db().prepare("UPDATE nodes SET status = 'done', error = NULL WHERE id = ? AND status = 'cancelled'").run(node.id);
  }
  let message = a.message;
  if (g.grant?.network || g.grant?.write_paths?.length) {
    const extras = [g.grant.network ? "network access" : "", g.grant.local_network ? "this Mac's loopback and the local network, once the user consents" : "", g.grant.raw_network ? "raw network from your shell (TCP, UDP, ssh, DNS) inside relay's sandbox, once the user consents" : "", ...(g.grant.write_paths ?? []).map((p) => `write access to ${p}`)].filter(Boolean);
    message = `[relay] You have now been granted: ${extras.join("; ")}.\n\n${a.message}`;
  }
  // The grant, the message and the requeue together: the job's worker sees all of them or none.
  const { turnId, wasActive } = tx(() => {
    // The grant replaces the job's previous one and applies from its next turn; the speed, from the turn this queues.
    if (g.grant) {
      setParam(node.id, "grant", persistentGrant(g.grant));
      // Consent to local network is for the grant it was given under (session.ts localNetworkConsent).
      const given = sessionParams(node).local_network_consent;
      if (given && (!g.grant.local_network || localNetworkKey(g.grant) !== given.grant)) setParam(node.id, "local_network_consent", null);
      // Consent to raw network is for the grant it was given under (raw-network.ts rawNetworkConsent; review r_17565c33 C4).
      const raw = sessionParams(node).raw_network_consent;
      if (raw && (!g.grant.raw_network || rawNetworkKey(g.grant) !== raw.grant)) setParam(node.id, "raw_network_consent", null);
    }
    addContribution(node.id, callerLabel(inst, w));
    const q = queueTurn(node.id, "caller", message, node.mode as Mode);
    recordEnvironmentRequest(q.turnId, g.grant?.env);
    changeSpeed(node.id, q.turnId, sp.speed);
    return q;
  });
  const notStarted = dispatch(node.id);
  return {
    job_id: node.id, families: familiesOf(getNode(node.id)!), turn_id: turnId, status: wasActive ? "queued_behind_current_turn" : "queued",
    note: wasActive ? "The job is mid-turn. Your message will be delivered as its next turn when the current one ends." : "The job is continuing with your message.",
    ...(notStarted ? { warning: notStarted } : {}),
  };
}

/** inst is null when the user cancels from a terminal. */
export async function cancel(inst: Instance | null, a: { id: string }): Promise<Json> {
  if (inst && !canReadItem(inst, a.id)) return UNAVAILABLE();
  if (inst?.ctx.kind === "poisoned") return refused(`relay context for this agent could not be loaded (${inst.ctx.reason}).`);
  const me = inst?.ctx.kind === "child" ? inst.ctx : null;
  let caller: Caller | null = null;
  if (me) {
    caller = liveChild(me);
    if (!caller) return refused("the turn this relay connection belonged to has ended, so it can no longer cancel anything.");
    if (a.id.startsWith("run_")) return refused("only the root session or the user can cancel a whole run. You can cancel work that you started.");
  }
  let nodes: NodeRow[];
  let runId: string;
  // A session cancels only in runs it owns; the administrative terminal is not bound by this.
  const foreignRun = (id: string) => (inst?.ctx.kind === "root" ? claimRun(inst, id) : null);
  if (a.id.startsWith("run_")) {
    if (!getRun(a.id)) return { error: `unknown run ${a.id}` };
    const no = foreignRun(a.id);
    if (no) return refused(`${a.id} cannot be cancelled from this session: ${no}.`);
    runId = a.id;
    db().prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(runId);
    nodes = runNodes(runId);
  } else {
    const node = getNode(a.id);
    if (!node) return { error: `unknown id ${a.id}` };
    const no = caller ? authority(caller, node, "cancel") : foreignRun(node.run_id);
    if (no) return refused(caller ? no : `${a.id} cannot be cancelled from this session: ${no}.`);
    runId = node.run_id;
    nodes = [node, ...descendants(node.id)];
  }
  // A discussion being cancelled may be waiting on a reply from a session it did not start. Its
  // turn there (source discussion:<id>) is dropped while it is still queued, whatever else the
  // session has queued or running. Only once the session is running that turn is the session stopped
  // with the discussion (it can be resumed afterwards). Only where the caller could cancel that
  // session directly: otherwise the discussion is closed and the reply simply goes unread.
  const borrowedParts: { discussion: string; part: NodeRow }[] = [];
  for (const d of nodes.filter((n) => n.kind === "discussion" && n.status === "open")) {
    const p = discussionParams(d);
    const part = p.borrowed ? getNode(p.participant) : undefined;
    if (!part || nodes.some((n) => n.id === part.id) || (caller && authority(caller, part, "cancel"))) continue;
    borrowedParts.push({ discussion: d.id, part });
  }
  // Dead workers are marked lost first, and agents left without one are stopped.
  reap(runId);
  const grace = runConfig(runId).cancel_grace_ms;
  /** Worker pid and agent group leader, each with the start time recorded for it, so a later signal goes only to the same process. */
  const workers = new Map<number, string | null>();
  const groups = new Map<number, string | null>();
  const groupWorkers = new Map<number, number>();
  /** Agent groups with no live worker to stop them cleanly. */
  const unsupervised = new Set<number>();
  const cancelled: string[] = [];
  const signalled = new Map<string, { worker: number | null; group: number | null }>();
  tx(() => {
    // Classified in the transaction that cancels: the session's worker starts a turn only if it is
    // still queued (runSessionTurn), so it either started the turn before this, and is stopped with
    // it, or never starts it.
    for (const { discussion, part } of borrowedParts) {
      const own = db().prepare("SELECT id, status FROM turns WHERE node_id = ? AND source = ? AND status IN ('queued', 'running')").all(part.id, `discussion:${discussion}`) as { id: number; status: string }[];
      if (own.some((t) => t.status === "running")) nodes.push(part);
      else for (const t of own) db().prepare("UPDATE turns SET status = 'cancelled', ended_at = ? WHERE id = ? AND status = 'queued'").run(now(), t.id);
    }
    for (const stale of nodes) {
      const n = getNode(stale.id)!;
      db().prepare("UPDATE turns SET status = 'cancelled', ended_at = ? WHERE node_id = ? AND status = 'queued'").run(now(), n.id);
      // A discussion or review that is open has nothing running; it is simply closed.
      if (n.status === "open") {
        updateNode(n.id, { status: "cancelled", ended_at: now(), result_json: JSON.stringify({ outcome: "cancelled" }) });
        if (n.kind === "discussion") {
          const reviewId = discussionParams(n).review_id;
          const review = reviewId ? getNode(reviewId) : undefined;
          const reconciliation = review ? reviewParams(review).discussion : undefined;
          if (review?.status === "open" && (!reconciliation || reconciliation === "opening" || reconciliation === n.id)) {
            updateNode(review.id, { status: "cancelled", ended_at: now(), result_json: JSON.stringify({ outcome: "cancelled", discussion_id: n.id, reason: "reconciliation cancelled" }) });
            cancelled.push(review.id);
          }
        }
        cancelled.push(n.id);
        continue;
      }
      // Only nodes that are active right now are signalled: a pid recorded on a finished node
      // could since have been reused by an unrelated process.
      if (!ACTIVE.includes(n.status)) continue;
      updateNode(n.id, { status: "cancelled", ended_at: now() });
      // The turn in progress ends here and now, in the same transaction: its relay connection
      // loses its authority at once, and nothing done later in this cancel can touch a turn that
      // a resume starts in the meantime.
      closeTurns(n.id, "cancelled", "cancelled");
      expireRequests(n.id);
      cancelled.push(n.id);
      const supervised = Boolean(n.worker_pid && n.worker_pid > 1 && sameProcess(n.worker_pid, n.worker_start));
      if (supervised) workers.set(n.worker_pid!, n.worker_start);
      if (n.agent_pgid && n.agent_pgid > 1) {
        groups.set(n.agent_pgid, n.agent_pid === n.agent_pgid ? n.agent_start : null);
        if (supervised) groupWorkers.set(n.agent_pgid, n.worker_pid!);
        if (!supervised) unsupervised.add(n.agent_pgid);
      }
      signalled.set(n.id, { worker: n.worker_pid, group: n.agent_pgid });
    }
  });

  const { stillOurs, refused: groupRefusals } = await stopSupervised({ workers, groups, groupWorkers, unsupervised, graceMs: grace, spared: relayProcs });
  const refusedWorkers = new Set([...groupRefusals.keys()].map(g => groupWorkers.get(g)));
  // Clear only what this cancel signalled: the item may already have been resumed under a new worker.
  for (const [id, was] of signalled) {
    if (was.group !== null && groupRefusals.has(was.group)) continue;
    if (was.worker !== null && !refusedWorkers.has(was.worker)) db().prepare("UPDATE nodes SET worker_pid = NULL, worker_start = NULL WHERE id = ? AND worker_pid IS ?").run(id, was.worker);
    if (was.group !== null && !stillOurs(was.group)) {
      db().prepare("UPDATE nodes SET agent_pid = NULL, agent_pgid = NULL, agent_start = NULL WHERE id = ? AND agent_pgid IS ?").run(id, was.group);
    }
  }
  // Stage 2: an executor whose worker had to be killed (or died) is stopped here, after its app
  // server. One whose worker is still alive is that worker's to stop (a resumed turn's, say).
  // An app group that did not exit may still reconnect to its executor's port: the executor is
  // still stopped, but its record and leases stay quarantined, as after a refusal (reap does the same).
  const executorNotes = [...signalled].filter(([, was]) => was.group === null || !groupRefusals.has(was.group))
    .map(([id, was]) => stopNodeExecutorsNow(id, undefined, was.group !== null && stillOurs(was.group) ? `untraceable app-server cleanup: process group ${was.group} did not exit` : undefined).trim()).filter(Boolean);
  const survivors = [...groups.keys()].filter((g) => stillOurs(g));
  const unstopped = survivors.filter(g => !groupRefusals.has(g));
  const warning = [...groupRefusals.values(), ...(unstopped.length ? [`process group(s) ${unstopped.join(", ")} did not exit`] : []), ...executorNotes].join("; ");
  return {
    cancelled, killed_process_groups: groups.size - survivors.length, run_cancelled: a.id.startsWith("run_"),
    ...(warning ? { warning } : {}),
  };
}

/**
 * The person's choices when merge will not take work that no result showed. `obj`: what the work is
 * called ("them", the changes; "it", the work); `look`: where to look at it; `root`: whether the
 * caller is the root session, the only one that may merge it anyway.
 */
function unshownChoices(job: NodeRow, look: string, obj: "them" | "it", worktree: boolean, root: boolean): string {
  const as = obj === "them" ? "as they are" : "as it is";
  const take = worktree ? `commits what is in the worktree to ${job.branch} and merges the branch as it then is` : `merges ${job.branch} as it is`;
  const anyway = root
    ? `or, if the user wants ${obj} merged ${as}, call merge again with include_changes_since_result: true, which ${take}`
    : `or report this to whoever started you: only the root session can merge ${obj} ${as}`;
  return `${look}; resume the job, whose next turn commits ${obj} and ends with a result that shows ${obj}; ${anyway}.`;
}

/** Merge's refusal when the job's worktree or branch holds more than the commit its result showed. */
function changedRefusal(job: NodeRow, commit: string, c: Changes, where: "worktree" | "branch", root: boolean): Json {
  const listed = c.files.length > 20 ? `${c.files.slice(0, 20).join(", ")} and ${c.files.length - 20} more` : c.files.join(", ");
  const what = where === "branch"
    ? `${job.id}'s branch ${job.branch} has moved since the end of the turn its result is from: that result's diff summary is of commit ${commit}, and the branch is now at ${c.now}. ` +
      "Something was committed to it after that turn: relay clean commits what it finds in a worktree before removing it, which may be the work of a process the job started"
    : `${job.id}'s worktree has changed since the end of the turn its result is from: that result's diff summary is of commit ${commit}, and the worktree ` +
      `${c.now === commit ? "has uncommitted changes" : c.uncommitted ? `is now at commit ${c.now}, with uncommitted changes` : `is now at commit ${c.now}`}. ` +
      "A process the job started may still be running there, or a later turn of the job may have been stopped before it ended";
  const look = where === "branch" ? `Look at them with git diff ${commit} ${c.now}` : `Look at them in ${job.worktree}`;
  return {
    ...refused(`nothing was merged, because ${what}. Changed since that commit: ${listed || "(git listed no file)"}. ${unshownChoices(job, look, "them", where === "worktree", root)}`),
    job_id: job.id, branch: job.branch, result_commit: commit, now_at: c.now, uncommitted: c.uncommitted, changed_files: c.files, diff_stat: c.stat,
  };
}

export function merge(inst: Instance, a: { job_id: string; continue?: boolean; cwd?: string; include_changes_since_result?: boolean }): Json {
  if (!canReadItem(inst, a.job_id)) return UNAVAILABLE();
  if (inst.ctx.kind === "poisoned") return refused(`relay context for this agent could not be loaded (${inst.ctx.reason}).`);
  const ctx = inst.ctx.kind === "child" ? inst.ctx : null;
  const child = ctx ? liveChild(ctx) : null;
  const me = child?.node ?? null;
  if (ctx) {
    if (!child) return refused("the turn this relay connection belonged to has ended, so it can no longer merge.");
    if (ctx.access !== "write") return refused("your current turn is read-only, so you cannot merge. Report the branch name to whoever started you.");
    if (a.cwd) return refused("cwd can only be set by the root session.");
    // Merging work that no result showed is the user's call, as merging into their checkout is.
    if (a.include_changes_since_result) {
      return refused("include_changes_since_result can only be set by the root session. Resume the job, so that its next turn ends with a result that shows its work, or report what merge said to whoever started you.");
    }
  }
  const job = getNode(a.job_id);
  if (!job || !job.branch) return { error: `${a.job_id} is not a write job with a branch` };
  if (!ctx) {
    // Merging removes the job's worktree and can commit in it, so it follows the same ownership as resume.
    const foreign = claimRun(inst, job.run_id);
    if (foreign) return refused(`${a.job_id} cannot be merged from this session: ${foreign}. Its branch ${job.branch} can still be merged with git.`);
  }
  if (child) {
    const no = authority(child, job, "merge");
    if (no) return refused(no);
  }
  if (ACTIVE.includes(job.status)) return refused(`${a.job_id} is still ${job.status}. Wait for it with status, then merge.`);
  if (removedBranch(JSON.parse(job.result_json ?? "{}") as Json)) return { job_id: job.id, status: "up_to_date", outcome: "no_changes", note: "The job has no changes to merge." };
  // Where the branch goes: a launched agent's own worktree, or the root's checkout.
  const into = checkoutAt(me?.worktree ?? (a.cwd ? expand(a.cwd) : inst.cwd));
  if (!into) return { error: "the current directory is not inside a git repository" };
  if ("error" in into) return { job_id: job.id, branch: job.branch, status: "error", error: `nothing was merged: ${into.error}` };
  const trust = runConfig(job.run_id).trust_git_filters;
  if (a.continue) return { job_id: job.id, branch: job.branch, ...afterMerge(job, continueMerge(into.at, trust)) };
  const out = { job_id: job.id, branch: job.branch };
  const worktree = job.worktree && fs.existsSync(job.worktree) ? job.worktree : null;
  // Every git command for the job's worktree runs with the git directory the repository records for it.
  const tree = worktree ? nodeTree(job) : null;
  if (tree && "error" in tree) return { ...out, status: "error", error: `nothing was merged, because relay will not run git in ${job.id}'s worktree: ${tree.error} (worktree: ${worktree})` };

  // What merge takes is what the job's result showed: the commit its diff summary is of, and only
  // while the worktree (or, once that is gone, the branch) holds nothing more. A process the job
  // started can outlive its turn and go on writing there; include_changes_since_result is the
  // user's say-so to take that too.
  const shown = a.include_changes_since_result ? null : shownWork(job);
  let commit: string | undefined;
  let note: string | undefined;
  if (shown && "unshown" in shown) {
    const look = tree ? `Look at it in ${worktree}` : `Look at it on ${job.branch} (git log ${job.base_sha ? `${job.base_sha}..` : ""}${job.branch})`;
    return { ...refused(`nothing was merged, because ${shown.unshown}, and merging now would commit it and merge it unseen. ${unshownChoices(job, look, "it", Boolean(tree), !ctx)}`), ...out };
  }
  if (shown && "commit" in shown) {
    let changes: ReturnType<typeof worktreeChanges>;
    if (tree) {
      // `git status` can run the clean filter.
      const filters = filterRefusal(tree, trust);
      if (filters) return { ...out, status: "error", error: `nothing was merged, because ${filters}` };
      changes = worktreeChanges(tree, shown.commit);
    } else {
      changes = branchChanges(into.at, job.branch, shown.commit);
    }
    if (changes && "error" in changes) return { ...out, status: "error", error: `nothing was merged, because ${changes.error}` };
    if (changes) return changedRefusal(job, shown.commit, changes, tree ? "worktree" : "branch", !ctx);
    commit = shown.commit;
  } else {
    // As before 0.9.1: anything the job left uncommitted is committed to its branch first, and the
    // branch is merged as it then is. Committing it afterwards would create work the merge never
    // included; if it cannot be committed, nothing is merged.
    if (tree) {
      const src = checkpoint(tree, job.id, trust);
      if (src.error) return { ...out, status: "error", error: `nothing was merged, because ${job.id}'s uncommitted work could not be committed first: ${src.error} (worktree: ${worktree})` };
    }
    const took = tree ? `committed anything left in ${job.id}'s worktree to ${job.branch} and took the branch as it then was` : `took ${job.branch} as it was`;
    note = shown
      ? `${job.id}'s result was written by a relay older than 0.9.1, which did not record the commit a result's diff summary is of, so relay could not check that the branch holds only what the result showed. As before, it ${took}.`
      : `With include_changes_since_result, relay ${took}, not only the commit the job's result showed.`;
  }
  // The caller's own uncommitted work is committed too, so the merge starts from a clean tree.
  if (me?.worktree && typeof into.at !== "string") {
    const cp = checkpoint(into.at, `${me.id} before merging ${job.id}`, trust);
    if (cp.error) return { ...out, status: "error", error: cp.error };
  }
  return { ...out, ...afterMerge(job, mergeBranch(into.at, job.branch, trust, commit)), ...(note ? { note } : {}) };
}

/** Once a job's branch is merged its worktree is no longer needed; it is restored if the job is resumed. */
function afterMerge(job: NodeRow, res: ReturnType<typeof mergeBranch>): Json {
  if (res.status !== "merged" && res.status !== "up_to_date") return res;
  if (!job.worktree || !job.repo) return res;
  // Agents the job started may still be working inside its worktree (read jobs and consults run in place).
  if (descendants(job.id).some((d) => busy(d))) return { ...res, worktree_kept: "agents this job started are still running in it" };
  const kept = retire(job, runConfig(job.run_id).trust_git_filters);
  return kept ? { ...res, worktree_kept: `${kept} (${job.worktree})` } : { ...res, worktree_removed: true };
}

/**
 * Removes the worktrees of runs with nothing in use, and deletes relay branches that are already
 * merged. Uncommitted work is committed to the job's branch first; a worktree whose work cannot be
 * committed is kept and listed, as are unmerged branches. Cleaning never discards work. Then the
 * temporary directories relay made and no longer needs go (retention.ts sweepTemps), and, only
 * where keep_records_days is set, the records of runs with no activity for that many days that
 * nothing uses any more.
 */
export async function clean(runId?: string): Promise<Json> {
  const runs = runId ? [runId] : (db().prepare("SELECT id FROM runs").all() as { id: string }[]).map((r) => r.id);
  let removed = 0;
  const deleted: string[] = [];
  const kept: string[] = [];
  const keptTrees: string[] = [];
  const skipped: string[] = [];
  for (const id of runs) {
    if (!getRun(id)) {
      if (runId) return { error: `unknown run ${id}` };
      // Forgotten meanwhile by another relay process's keep_records_days.
      continue;
    }
    reap(id);
    const nodes = runNodes(id);
    // Nothing is removed until every agent in the run is known to have stopped.
    if (nodes.some((n) => busy(n) || workerLive(n) || groupAlive(n.agent_pgid))) {
      skipped.push(id);
      continue;
    }
    for (const n of nodes) {
      if (!n.worktree || !n.repo || !fs.existsSync(n.repo)) continue;
      if (fs.existsSync(n.worktree)) {
        const trust = runConfig(id).trust_git_filters;
        // Before anything runs git in it: whether it is still the worktree git made, and whether
        // `git status` there could run a filter.
        const tree = jobTree(n.repo, n.worktree);
        const refusal = "error" in tree ? tree.error : filterRefusal(tree, trust);
        if ("error" in tree || refusal) {
          keptTrees.push(`${n.id}: ${refusal} (${n.worktree})`);
          continue;
        }
        // A cancelled, failed or lost job can leave work its worker never got to commit.
        if (treeState(tree) !== "clean") checkpoint(tree, `${n.id} (saved by relay clean)`, trust);
        const why = retire(n, trust);
        if (why) {
          keptTrees.push(`${n.id}: ${why} (${n.worktree})`);
          continue;
        }
        removed++;
      }
      if (!n.branch) continue;
      const r = deleteBranchIfMerged(n.repo, n.branch);
      if (r === "deleted") deleted.push(n.branch);
      else if (r === "unmerged") kept.push(`${n.branch} (${n.repo})`);
    }
  }
  const out: Json = { worktrees_removed: removed, branches_deleted: deleted, unmerged_branches_kept: kept, worktrees_kept: keptTrees, runs_skipped_still_active: skipped };
  // The sweep says what it could not do rather than throw; whatever happens to it, keep_records_days
  // is still applied and this report still made.
  let swept: Swept;
  try {
    swept = await sweepTemps();
  } catch (err) {
    swept = { removed: [], problems: [`relay's leftover temporary directories were not swept (${(err as Error).message})`] };
  }
  out.temp_dirs_removed = swept.removed;
  if (swept.problems.length) out.temp_dirs_left = swept.problems;
  // Never removed by relay, keep_records_days or not: each is a whole copy of the registry from before an upgrade.
  const backups = registryBackups();
  if (backups.length) {
    out.registry_backups_kept = backups;
    out.registry_backups_note = "copies of the registry relay made before upgrading it, each holding every run it held then, prompts included; delete them once you will not go back to the relay that wrote them";
  }
  let cfg: RelayConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    return { ...out, records_note: `kept: relay's config did not load, so keep_records_days was not applied (${(err as Error).message})` };
  }
  return { ...out, ...recordsReport(cfg, runId ? [runId] : undefined) };
}

// Consult

interface AskArgs {
  target?: Target; message: string; thread_id?: string; context?: string[]; allow_delegation?: boolean;
  model?: string; effort?: string; cwd?: string; grant?: Grant; request_id?: string;
  /** Give a new thread the extensions the run's config allows for its target, once the person consents. */
  extensions?: boolean;
  /** A new thread's speed, or a follow-up's, which the thread goes on at from its next turn (caller.ts admitSpeed). */
  speed?: Speed;
}

export async function ask(inst: Instance, a: AskArgs, w: ToolCall = {}): Promise<Json> {
  if (a.thread_id && !canReadItem(inst, a.thread_id)) return UNAVAILABLE();
  const seen = await once(inst, "ask", a, w, () => ask(inst, a, w), (c) => replay(inst, c, a, w));
  if (seen) return seen;
  /** The thread a follow-up continues, or the row of the one a new question starts. */
  let existing: NodeRow | undefined;
  let row: Parameters<typeof insertNode>[0] | undefined;
  /** A follow-up's grant, which replaces the thread's from its next turn. */
  let regrant: Grant | undefined;
  /** A new thread's extensions. */
  let ext: SessionExtensions | undefined;
  /** A follow-up's speed, which the thread goes on at from the turn it queues. */
  let respeed: Speed | undefined;
  let body: string;
  let caller: Caller;
  if (a.thread_id) {
    existing = getNode(a.thread_id);
    if (!existing || existing.kind !== "thread") return { error: `${a.thread_id} is not a consult thread` };
    const c = admitExisting(inst, existing, "continue", a.cwd);
    if ("reason" in c) return refused(c.reason);
    caller = c;
    if (a.target && existing.target !== a.target) return { error: `${a.thread_id} is a ${targetLabel(targetDef(existing.target!), existing.target!)} thread, not ${targetLabel(targetDef(a.target), a.target)}` };
    const unknown = knownCaller(inst);
    if (unknown) return refused(unknown);
    if (existing.status === "cancelled") return refused(`${a.thread_id} was cancelled. Start a new thread by omitting thread_id.`);
    if (a.extensions) return refused("a thread is given its extensions when it starts, and keeps them; omit extensions on a follow-up, or start a new thread with them.");
    body = contextBlock(a.context) + a.message;
    const g = admitWork(caller, existing.target!, { mode: "read", grant: a.grant, kept: grantOf(existing), continues: true, servers: holdsServers(existing) }, w);
    if ("reason" in g) return refused(g.reason);
    if (g.grant) {
      regrant = g.grant;
      if (g.grant.network) body = `[relay] You now have web access for the rest of this consult.\n\n${body}`;
    }
    // Asked whether or not the call names a speed: a launched agent may not carry on a thread faster than itself.
    const sp = admitSpeed(caller, existing.target!, { speed: a.speed, current: speedAfter(existing), model: existing.model }, w);
    if ("reason" in sp) return refused(sp.reason);
    respeed = sp.speed;
  } else {
    const admitted = admitNew(inst, { target: a.target, model: a.model, cwd: a.cwd, consult: true });
    if ("reason" in admitted) return refused(admitted.reason);
    caller = admitted.caller;
    const to = admitted.to;
    const g = admitWork(caller, to.target, { mode: "read", grant: a.grant, continues: false }, w);
    if ("reason" in g) return refused(g.reason);
    const sp = admitSpeed(caller, to.target, { speed: a.speed, model: to.model ?? a.model }, w);
    if ("reason" in sp) return refused(sp.reason);
    const cfg = runConfig(caller.runId);
    if (a.extensions) {
      const e = admitExtensions(inst, caller, to.target, { network: networkOn(cfg, g.grant), allowDelegation: a.allow_delegation }, w);
      if ("reason" in e) return refused(e.reason);
      ext = e.extensions;
    }
    row = {
      id: newId("thread"), run_id: caller.runId, parent_id: caller.node?.id ?? null, kind: "thread", target: to.target,
      mode: "read", depth: caller.depth + 1, allow_delegation: a.allow_delegation && !ext?.mcp_servers.length ? 1 : 0, task: a.message, cwd: caller.cwd,
      model: to.model ?? a.model ?? null, effort: a.effort ?? null, params_json: JSON.stringify({ grant: persistentGrant(g.grant), speed: sp.speed, ...(ext ? { extensions: ext } : {}) }),
    };
    const who = caller.node ? `a ${targetLabel(targetDef(caller.node.target!), caller.node.target!)} agent, ${caller.node.id}` : "the root session";
    body = consultHeader(who, to.target, row.allow_delegation === 1 && row.depth < cfg.max_depth, {
      canAsk: escalationEnabled(cfg) && !cfg.allow_dangerous, network: networkOn(cfg, g.grant), cfg, model: row.model, extensions: ext,
    }) + contextBlock(a.context) + a.message;
  }
  // The thread (a new one), the question and the request_id's binding are committed together
  // (review X1): a repeat finds the question on its way, or nothing, and then asks it afresh.
  const { node, turnId } = tx(() => {
    const n = row ? insertNode(row) : getNode(existing!.id)!;
    if (row) recordStart(n.id, inst, w, n.target!, n.model, runConfig(n.run_id));
    else addContribution(n.id, callerLabel(inst, w));
    if (regrant) setParam(n.id, "grant", persistentGrant(regrant));
    // Consults are always read-only, whatever the session did before.
    const t = queueTurn(n.id, "caller", body, "read").turnId;
    recordEnvironmentRequest(t, a.grant?.env);
    if (respeed) changeSpeed(n.id, t, respeed);
    noteCall(inst, a, n.id, t);
    return { node: n, turnId: t };
  });
  const notStarted = dispatch(node.id);
  // A new thread given extensions says which, and that the user is asked first, as delegate does.
  const given = ext ? { extensions: extensionsView(ext, { consent: false }), extensions_note: EXTENSIONS_NOTE } : {};
  if (notStarted) return { ...pendingHandle(node.id, { thread_id: node.id, turn_id: turnId }, inst), warning: notStarted, ...given };
  return { ...(await consultReply(inst, node, turnId, w)), ...given };
}

/** Waits for a consult turn and returns its reply, or a pending handle. */
async function consultReply(inst: Instance, node: NodeRow, turnId: number, w: ToolCall = {}): Promise<Json> {
  // The reply is returned with the thread settled with it (or gone on to its next turn), so that a
  // follow-up sent at once finds it as the reply left it.
  const turnDone = () => turnSettled(getTurn(turnId)) || !workerLive(getNode(node.id)!) && settled(node.id);
  const done = await waitUntil(turnDone, waitOpts(inst, node.run_id, w, { progressOf: node.id }));
  if (!canReadItem(inst, node.id)) return UNAVAILABLE();
  if (!done) return pendingHandle(node.id, { thread_id: node.id, turn_id: turnId }, inst);
  const t = getTurn(turnId)!;
  if (t.status !== "done") {
    const refusal = t.status === "refused" && t.refusal_json ? JSON.parse(t.refusal_json) as VendorRefusal : null;
    return { thread_id: node.id, ...runRecovery(node.run_id), families: familiesOf(getNode(node.id)!), error: t.error ?? `the consult turn ended as ${t.status}`, ...(refusal ? { status: "refused", outcome: "refused", refusal, unfinished: true, note: refusalNote(refusal) } : {}) };
  }
  // A reply can come with a warning about processes the agent left behind, and with what it was refused.
  const blocked = denialsOf(t);
  return { reply: t.reply, thread_id: node.id, ...runRecovery(node.run_id), families: familiesOf(getNode(node.id)!), ...notesView(getNode(node.id)!), ...(t.error ? { warning: t.error } : {}), ...(blocked.length ? { blocked, note: BLOCKED_NOTE } : {}) };
}

// Discuss and review: the flows are modes/discussion.ts and modes/review.ts. The tools answer a
// call that repeats an earlier request_id from what that call started (replay, below).

export async function discuss(inst: Instance, a: DiscussArgs, w: ToolCall = {}): Promise<Json> {
  if ([a.discussion_id, a.with].some((id) => id && !canReadItem(inst, id))) return UNAVAILABLE();
  const seen = a.discussion_id ? null : await once(inst, "discuss", a, w, () => discuss(inst, a, w), (c) => replay(inst, c, a, w));
  return seen ?? holdDiscussion(inst, a, w);
}

export async function review(inst: Instance, a: ReviewArgs, w: ToolCall = {}): Promise<Json> {
  if (a.review_id && !canReadItem(inst, a.review_id)) return UNAVAILABLE();
  const seen = a.review_id ? null : await once(inst, "review", a, w, () => review(inst, a, w), (c) => replay(inst, c, a, w));
  return seen ?? runReview(inst, a, w);
}

/**
 * Decides an approval request. Only the root session can: a launched agent is itself confined, so
 * it cannot hand a descendant more than it holds. The user can also decide from a terminal, except
 * to allow a person-only request (docs/extensions.md), which only their own session's question or
 * permission prompt can.
 */
export function approve(inst: Instance, a: { request_id: string; decision: "allow" | "deny"; note?: string; scope?: "once" | "job"; user_confirmed?: boolean }, call: ToolCall = {}): Json {
  const access = getRequest(a.request_id);
  if (!access || !canReadRun(inst, access.run_id)) return UNAVAILABLE();
  // A Codex subagent thread may deny but never allow, whatever else holds.
  const sub = a.decision === "allow" ? subagentRefusal(call, "allow") : null;
  if (sub) return refused(sub);
  if (inst.ctx.kind !== "root") {
    return refused("only the root session, or the user with `relay approve`, can decide approval requests. Carry on with your own work.");
  }
  const r = getRequest(a.request_id);
  if (!r) return { error: `unknown request ${a.request_id}` };
  // A session decides only for agents in runs it owns; recovery is explicit.
  const foreign = claimRun(inst, r.run_id);
  if (foreign) return refused(`${a.request_id} cannot be decided from here: ${foreign}.`);
  // Consent to extensions, a call of an extension's tool, and any request of a session holding MCP
  // servers are the person's alone to allow (docs/extensions.md): the root agent's word, even that
  // the user confirmed, is not their consent. It may deny them.
  if (a.decision === "allow" && personOnly(r)) {
    return refused(
      `only the user can allow ${a.request_id}: it ${r.kind === "extensions" ? "gives a launched agent extensions" : r.kind === "env" ? "releases named environment values for one turn" : r.kind === "local_network" ? "opens this Mac's loopback and the local network to a job's shell" : r.kind === "raw_network" ? "gives a job's shell raw network, with the local network and tailnet reachable" : r.kind === "mcp" ? "calls a tool of an MCP server" : "comes from a session that holds MCP servers"}, and relay takes no agent's word for their consent. ` +
        `They allow it ${PERSON_ROUTES}${inst.host.confirmTool ? " (call confirm with the request as shown)" : ""}; relay takes it from no command, relay approve included. You may deny it.`,
    );
  }
  const requester = getNode(r.node_id);
  if (a.decision === "allow" && requestRunsRelayCommand(r, requester ? workCwd(requester) : inst.cwd)) {
    return refused("this command runs relay's CLI, so only the person can allow it, through the host's approval dialog, confirm, or `relay approve` in their own terminal. You may deny it.");
  }
  // Where the user has been asked directly, their answer is the one that counts. The agent can
  // still pass on an answer they gave in conversation, by saying so.
  const state = elicitationState(r.id);
  if (a.decision === "allow" && !a.user_confirmed && (state === "asking" || state === "dismissed")) {
    return refused(
      (state === "asking" ? "the user is being asked about this request directly right now" : "the user was shown this request and closed it without answering") +
        ", so you cannot allow it on your own judgment. Ask them in conversation; if they tell you to allow it, call approve again with user_confirmed: true. You may deny it without asking.",
    );
  }
  return decide(a.request_id, a.decision === "allow", a.user_confirmed ? "root session, stating that the user confirmed" : "root session", a.note, a.scope ?? "once", escalationDecisionAuthentication(r, "owning-run-root", inst));
}

/**
 * Allows a request on the user's own say-so (a confirmation): the tool is offered only to hosts that ask the user
 * before every call of it (Claude Code's permission prompt for a tool marked
 * anthropic/requiresUserInteraction), so a call that arrives here is one the user let through.
 * The request must be pending and in a run this session owns, and from and wants must be the
 * request's own, so that what the prompt showed is what is allowed.
 */
export function confirm(inst: Instance, a: { request_id: string; from: string; wants: string; kind: string; effect: string; in_directory: string; scope?: "once" | "job"; note?: string }): Json {
  const access = getRequest(a.request_id);
  if (!access || !canReadRun(inst, access.run_id)) return UNAVAILABLE();
  const r = getRequest(a.request_id);
  // A person-only request is allowed by no command: the user allows it only in relay's question or through confirm.
  const personal = r ? personOnly(r) : false;
  if (inst.ctx.kind !== "root" || !inst.host.confirmTool) {
    return refused(personal
      ? `confirm is only for a root session in a host that asks the user before every call of it. ${a.request_id} is person_only: only the user can allow it, ${PERSON_ROUTES}. You may deny it with approve.`
      : "confirm is only for a root session in a host that asks the user before every call of it. Use approve, or ask the user to decide from a terminal.");
  }
  if (!r) return { error: `unknown request ${a.request_id}` };
  if (!ownsRun(inst, r.run_id)) {
    return refused(personal
      ? `${a.request_id} is not in a run of this session. Its own session decides it: only the user can allow it, ${PERSON_ROUTES}, and relay deny ${a.request_id} denies it from a terminal.`
      : `${a.request_id} is not in a run of this session. Its own session, or the user from a terminal (relay approve ${a.request_id}), decides it.`);
  }
  if (r.status !== "pending") return { error: `request ${a.request_id} is already ${r.status}` };
  // Compared exactly, whitespace and all: a prompt showing "a b" must not allow a request for
  // "a\nb", which a shell runs as two commands. The effect and kind are relay's own, so that the
  // prompt shows what allowing does, not only what the agent says it wants. The directory is the
  // agent's own text too (a Codex agent names it), so it is compared the same way.
  const view = requestView(r);
  const differs = ([["from", a.from !== r.node_id], ["kind", a.kind !== view.kind], ["effect", a.effect !== view.effect], ["in_directory", a.in_directory !== view.in_directory], ["wants", a.wants !== r.summary]] as const)
    .filter(([, off]) => off).map(([field]) => field);
  if (differs.length) {
    const fields = differs.length === 1 ? differs[0] : `${differs.slice(0, -1).join(", ")} and ${differs.at(-1)}`;
    return refused(`what you passed differs in ${fields}: it does not match ${a.request_id}, which is from ${r.node_id}, of kind ${JSON.stringify(view.kind)}, with effect ${JSON.stringify(view.effect)}, in directory ${JSON.stringify(view.in_directory)}, and wants ${JSON.stringify(r.summary)}. Call confirm again with from, kind, effect, in_directory and wants exactly as needs_approval shows them (the same characters, line breaks included), so that the user sees what they are allowing.`);
  }
  return decide(r.id, true, "user, through the host's permission prompt (confirm)", a.note, a.scope ?? "once", escalationDecisionAuthentication(r, "person-confirm", inst));
}

/** Records a human message for a live discussion. The other agent sees it on its next turn, the calling agent on its next call. */
export function inject(discussionId: string, body: string): Json {
  const n = getNode(discussionId);
  if (!n || n.kind !== "discussion") return { error: `${discussionId} is not a discussion` };
  if (n.status !== "open") return { error: `${discussionId} has ended (${n.status}), so the message would not be delivered` };
  db().prepare("INSERT INTO injections (discussion_id, body, created_at) VALUES (?, ?, ?)").run(discussionId, body, now());
  return { injected: true, discussion_id: discussionId };
}

/** Answers a repeated call as the first one would have, from the item it started. A delegate repeated with background: false waits for it. */
async function replay(inst: Instance, call: CallRow, a: { request_id?: string; background?: boolean }, w: ToolCall = {}): Promise<Json> {
  const n = getNode(call.node_id);
  if (!n) return { error: `the earlier call with request_id "${call.request_id}" started ${call.node_id}, which is no longer in the registry` };
  const again = { repeated: true, repeated_note: `An earlier call with request_id "${call.request_id}" already started ${n.id}. This is that item; nothing new was started.` };
  // The session doing the work is started if the first call committed it but left it without a
  // worker (review X1): the item, or the session a discussion or review waits on.
  const session = call.tool === "discuss" ? discussionParams(n).participant : call.tool === "review" ? reviewParams(n).reviewer : n.id;
  const notStarted = redispatch(session);
  const warned = notStarted ? { warning: notStarted } : {};
  // A job or new thread given extensions says which, and that the user is asked first, as the
  // first answer did. A follow-up on a thread was not given them, and its answer did not say so.
  const startedThread = () => (db().prepare("SELECT MIN(id) AS id FROM turns WHERE node_id = ?").get(n.id) as { id: number | null }).id === call.turn_id;
  const ext = call.tool === "delegate" || (call.tool === "ask" && startedThread()) ? sessionParams(n).extensions : undefined;
  const given = ext ? { extensions: extensionsView(ext, { consent: false }), extensions_note: EXTENSIONS_NOTE } : {};
  if (call.tool === "ask") {
    if (notStarted) return { ...pendingHandle(n.id, { thread_id: n.id, turn_id: call.turn_id }, inst), ...warned, ...given, ...again };
    return { ...(await consultReply(inst, n, call.turn_id!, w)), ...given, ...again };
  }
  if (call.tool === "review") return { ...reviewView(n.id), ...warned, ...again };
  if (call.tool === "discuss") {
    const done = !notStarted && (await waitUntil(() => settleDiscussion(n.id), waitOpts(inst, n.run_id, w, { awaits: [n.id] })));
    return { ...(done ? discussionView(n.id) : pendingHandle(n.id, { discussion_id: n.id }, inst)), ...warned, ...again };
  }
  const grant = sessionParams(n).grant;
  const started: Json = {
    // The caller-visible grant, without the per-directory pins (as the first response gave it — review C7/X5).
    job_id: n.id, ...runRecovery(n.run_id), target: n.target, mode: n.mode, depth: n.depth, families: familiesOf(n), ...(grant ? { grant: publicGrant(grant) } : {}),
    ...given,
    ...(speedOf(n) !== "standard" ? { speed: { requested: speedOf(n) } } : {}),
    ...(n.branch ? { branch: n.branch, base_sha: n.base_sha } : {}),
  };
  if (notStarted) return { ...started, status: n.status, warning: notStarted, ...again };
  if (a.background === false && !(await waitUntil(() => settled(n.id), waitOpts(inst, n.run_id, w, { progressOf: n.id })))) {
    return { ...pendingHandle(n.id, started, inst), ...again };
  }
  const view = nodeView(getNode(n.id)!);
  if (removedBranch((view.result as Json | undefined) ?? null)) delete started.branch;
  return { ...started, ...view, ...again };
}
