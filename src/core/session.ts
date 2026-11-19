import { escalationEnabled } from "./config.js";
import fs from "node:fs";
import path from "node:path";
import { launchTurn } from "../backends/run.js";
import { prepareCodexHome } from "../backends/codex-pin.js";
import { recordServed, recordWaiver } from "./families.js";
import type { Grant, TurnHandle, TurnResult } from "../backends/types.js";
import { expireRequests, hasPending, heldForJob, requestApproval } from "./approvals.js";
import { localModeRetired, rawNetworkConsent, stage2Enabled } from "./raw-network.js";
import { recordEnforcement, stage2SkillAssets, turnConfinement } from "../backends/codex-stage2.js";
import { nodeDir, type Mode } from "./config.js";
import { writeContextFile } from "./context.js";
import { cancelledAbove, db, getNode, getTurn, nodeTurns, now, recordLaunchLeader, runConfig, normaliseWorkCwd, setParam, tx, updateNode, updateTurn, workCwd, type NodeRow, type TurnRow } from "./db.js";
import { groupAlive } from "./procs.js";
import { dropSkillAssets, nodeHasLiveExecutor, noteSkillAssets } from "./stage2-executors.js";
import { assertOverlayLaunch, consumeOverlay, destinationOverlay, finishOverlay, getOverlay, originOverlay, overlayDeadlineExpired, overlayPrompt, overlayRemainingMs, overlayTurnProblem, prepareOverlayRestart, stopOverlay, type Cleanup, type OverlayRecord } from "./restart-overlay.js";
import { localNetworkKey, queuedSpeeds, reviewParams, sessionParams, speedChange, speedOf } from "./params.js";
import { acquireSlot, releaseSlot } from "./slots.js";
import { speedRank, targetDef, targetLabel, type Speed } from "../targets/index.js";
import { clipped } from "./shown.js";
import { redactOwnReview } from "./redact.js";
import { redact, withTurnSecrets } from "./secrets.js";
import { keepRecord, storageProblem, takeDiagnosticProblems, useStoragePolicy } from "./storage.js";
import { hardLinkProblem, prepareTurnTree, turnTree } from "./worktree.js";
import { buildSkillPackage, consentText, extensionsOf, gatewayWarnings, readMcpFile, writeManifest, type SessionExtensions } from "./extensions.js";
import { claimTurnEnvironment, type ClaimedEnvironment } from "./env-broker.js";
import { assertNeverLaunchCurrent, checkpointNever } from "./never-checkpoint.js";
import { neverGrantProblem } from "./never-policy.js";
import { neverToolAdapters } from "./never-tools.js";
import { capturedLaunchClass, reserveLaunch, launchReservationState, finishLaunchReservation } from "./restart-overlay.js";

/** Turns in flight in this worker process, so a signal handler can cancel them. */
const active = new Set<TurnHandle>();
/**
 * Starts still under way in this worker process. A backend's start can await something before it
 * launches the agent (the `codex exec` fallback's configuration check), and a stop that came then
 * would find no turn to cancel. So a stop aborts them (TurnSpec.signal), waits for each to settle,
 * and cancels what any of them launched with the turns already in flight (review C7/X1). Each
 * settles only once what it launched is in `active`. A relay-enforced (ACP) start gives up at each
 * step of its launch (broker, proxy, boundary probes, spawn) once the signal is aborted, cleaning up
 * what it had made (consolidation-confine.md E18).
 */
const starting = new Set<Promise<unknown>>();
const stopping = new AbortController();

/** Stops this worker's turns: aborts the starts under way, waits for them, then cancels every turn in flight and waits for it to end. */
export async function cancelActiveTurns(): Promise<void> {
  stopping.abort();
  await Promise.allSettled([...starting]);
  await Promise.all([...active].map((h) => h.cancel()));
}

/**
 * Starts a turn and puts it in `active`. The start gets the worker's stop signal and is in
 * `starting` until it has settled. It is called in the same tick as the turn's last cancelCheck
 * (acquireSlot), so a stop finds the start here or its turn in `active`.
 */
async function startTurn(start: (signal: AbortSignal) => Promise<TurnHandle>): Promise<TurnHandle> {
  const started = (async () => {
    const handle = await start(stopping.signal);
    active.add(handle);
    return handle;
  })();
  starting.add(started);
  try {
    return await started;
  } finally {
    starting.delete(started);
  }
}

/** True when the node, any ancestor, or the run has been cancelled, or the node is no longer in the registry. */
export function isCancelled(nodeId: string): boolean {
  const n = getNode(nodeId);
  return !n || cancelledAbove(n, { self: true });
}

export interface TurnOutcome extends TurnResult {
  restartPending?: boolean;
  timedOut: boolean;
  /** The turn was cancelled while queued, before it started: nothing ran, and it changes nothing about the session. */
  skipped?: boolean;
  /** What the caller has to be told about processes relay could not account for, and records relay could not keep. Kept whatever the outcome. Speed warnings are apart (TurnResult.speedWarnings). */
  warnings: string[];
  /**
   * Where the final message was kept whole (final-<turn>.md), for a turn whose agent ran: null when
   * it could not be written (said in `warnings`). Unset for a turn that ended before its agent ran,
   * whose final message turnRecord keeps.
   */
  finalPath?: string | null;
  /**
   * For a turn that ended before it started: the writes that record it as over, for the worker to
   * run in the transaction that records the turn's end for its session (outcome.ts finishTurn).
   */
  close?: () => void;
}

/** A turn that ended before an agent ran. */
function notRun(status: TurnResult["status"], error: string): TurnOutcome {
  return { status, finalMessage: "", error, exitCode: null, timedOut: false, warnings: [] };
}

export function processWarnings(r: Pick<TurnResult, "survivors" | "unseenMs" | "warnings">): string[] {
  const out: string[] = [...(r.warnings ?? [])];
  if (r.survivors?.length) out.push(`Processes the agent started could not be stopped and may still be running (pids ${r.survivors.join(", ")}).`);
  if (r.unseenMs !== undefined) {
    out.push(`The agent was gone before relay could take a last look at what it had started; it last looked ${r.unseenMs} ms before the agent exited. Anything started in that time cannot be traced and may still be running.`);
  }
  return out;
}

/**
 * A person's/root's cancel closes the running turn in the registry before it signals the worker.
 * Backend teardown can subsequently report a transport/process failure caused by that signal. The
 * durable cancel wins in that ordering; a backend result which reached this function first still
 * records normally, before a later cancel can select the already-settled node.
 */
export function applyRecordedCancellation(result: TurnResult, recordedStatus: TurnRow["status"] | undefined): TurnResult {
  if (recordedStatus !== "cancelled") return result;
  const { refusal, ...rest } = result;
  const warnings = [...(result.warnings ?? [])];
  if (result.error && result.error !== "cancelled") warnings.push(result.error);
  if (refusal?.message) warnings.push(refusal.message);
  return { ...rest, ...(warnings.length ? { warnings } : {}), status: "interrupted", error: "cancelled" };
}

/**
 * As the turn `turnId` starts (in the transaction that claims it): the speed it runs at, which
 * becomes the session's (SessionParams.speed). That is the one the call that queued it was admitted
 * at (caller.ts changeSpeed), else the session's, the speed of the turn before it. A raise is kept
 * with the speed before it (speed_change), for settleSpeedChange. Speeds kept for this turn and for
 * earlier ones (which ended without starting) are dropped.
 */
function startSpeed(nodeId: string, turnId: number): Speed {
  const n = getNode(nodeId)!;
  const p = sessionParams(n);
  const from = speedOf(n);
  const queued = queuedSpeeds(n);
  const to = queued.find(([t]) => t === turnId)?.[1] ?? from;
  const later = queued.filter(([t]) => t > turnId);
  if (queued.length) setParam(nodeId, "speed_queued", later.length ? Object.fromEntries(later.map(([t, sp]) => [String(t), sp])) : null);
  if (to !== from) setParam(nodeId, "speed", to);
  const change = speedRank(to) > speedRank(from) ? { turn: turnId, from, to } : null;
  if (change || p.speed_change) setParam(nodeId, "speed_change", change);
  return to;
}

/**
 * Settles the raise of speed the turn `turnId` started with (startSpeed), as the turn is recorded
 * as over: kept if the turn reached the model, undone if it never did (refused before its first
 * model request, a speed the account's catalog does not offer, say), so that a later call naming no
 * speed is not refused the same way. A turn that never started raised nothing.
 */
function settleSpeedChange(nodeId: string, turnId: number, reached: boolean): void {
  const n = getNode(nodeId);
  const change = n ? speedChange(n, turnId) : null;
  if (!change) return;
  if (!reached && speedOf(n!) === change.to) setParam(nodeId, "speed", change.from);
  setParam(nodeId, "speed_change", null);
}

/**
 * Runs one turn on a session node: takes a concurrency slot, starts the agent with the given
 * access, enforces the wall-clock timeout, and records the session id and reply.
 */
export function runSessionTurn(...args: Parameters<typeof runScopedSessionTurn>): Promise<TurnOutcome> {
  return withTurnSecrets(() => runScopedSessionTurn(...args));
}

async function runScopedSessionTurn(
  /** timeoutS: the turn's wall-clock limit, or null for none. */
  nodeId: string, turnId: number, prompt: string, access: Mode, timeoutS: number | null, cancelCheck: () => boolean,
): Promise<TurnOutcome> {
  /** Set once the turn is claimed as running: from then on its agent's relay connection holds the turn's authority (db.ts turnEnded). */
  let started = false;
  /**
   * Records the turn as over, and the speed change it carried with it (settleSpeedChange). A turn
   * that has started is recorded so at once, since its authority ends with it. One that never
   * started holds none: what records it is returned (close) for the worker to run in the
   * transaction that records the turn's end for its session (outcome.ts finishTurn), so that a
   * call waiting on the turn cannot find it over before its session has settled with it.
   */
  const endTurn = (fields: Partial<TurnRow>, reached: boolean): Pick<TurnOutcome, "close"> => {
    const close = () => {
      if (Object.keys(fields).length) updateTurn(turnId, fields);
      settleSpeedChange(nodeId, turnId, reached);
    };
    if (!started) return { close };
    tx(close);
    return {};
  };
  // A write job recorded by an earlier relay with a subdirectory cwd is rewritten to its worktree
  // root first (the subdirectory kept in its params), so nothing below reads the old path.
  const node = normaliseWorkCwd(getNode(nodeId)!);
  const cfg = runConfig(node.run_id);
  // The agent's log is rotated as the run's config says (log_max_mb).
  useStoragePolicy(cfg);
  const dir = nodeDir(node.run_id, node.id);
  /** What relay could not keep of this turn's records; said with its result. */
  const recordWarnings: string[] = [];
  // Decide at dispatch, not when a follow-up is queued: an earlier turn may still be running
  // then. Without a CLI session, none of the earlier prompts (including the preamble) survived.
  if (!node.session_id) {
    const earlier = nodeTurns(nodeId).filter((t) => t.id < turnId).map((t) => t.body);
    prompt = [...earlier, prompt].join("\n\n[relay] Follow-up message:\n\n");
  }
  // A copy for the person to read later. The agent is handed the prompt itself, so a copy that
  // cannot be written (a full disk, say) is said in the turn's warnings, and the turn goes on.
  const promptPath = path.join(dir, `prompt-${turnId}.txt`);
  const unkept = keepRecord(promptPath, prompt, { consequence: "no copy of this turn's prompt was kept" });
  if (unkept) recordWarnings.push(`${unkept}.`);
  else updateTurn(turnId, { prompt_path: promptPath });

  /** Ends the turn as failed before its agent ran: why, cut of secrets as everything relay keeps of a turn is. */
  const refused = (why: string): TurnOutcome => {
    const problem = redact(why);
    const ended = endTurn({ status: "failed", error: problem, ended_at: now() }, false);
    const unused = destinationOverlay(nodeId, turnId);
    if (unused?.state === "ready") finishOverlay(node.run_id, unused.id, { clean: true, problem: "destination failed before overlay consumption" });
    return { ...notRun("failed", problem), ...ended };
  };
  const overlayProblem = overlayTurnProblem(nodeId, turnId);
  if (overlayProblem) return refused(overlayProblem);
  let overlay: OverlayRecord | null = null;
  let overlayTimer: ReturnType<typeof setTimeout> | undefined;
  let overlayCleanup: Cleanup = { clean: false, problem: "overlay launch/cleanup was not confirmed" };
  const overlayAbort = new AbortController();
  // A worktree removed after its branch was merged is put back when the session is used again.
  const unprepared = prepareTurnTree(node, cfg);
  if (unprepared) return refused(unprepared);
  // A job with its own worktree starts at the worktree root (restored above), whatever subdirectory
  // an earlier relay recorded as its cwd; an in-place session inside a job's worktree starts at
  // that worktree's root too (workCwd), and any other session in its own directory.
  const startDir = workCwd(node);
  if (!fs.existsSync(startDir)) {
    // An in-place session works in its caller's directory; if that was a job's worktree, it may have been cleaned up since.
    return refused(`its working directory ${startDir} no longer exists (it belonged to a job whose worktree has been removed). Start a new job or consult instead.`);
  }
  const cancelledQueued = (): TurnOutcome => ({ ...notRun("interrupted", "cancelled while queued"), ...endTurn({ status: "cancelled", ended_at: now() }, false) });
  const dropped = (): TurnOutcome => ({ ...notRun("interrupted", "cancelled while queued"), skipped: true });
  // The turn's complete effective grant, with the environment names its caller requested, is
  // recorded while it is still queued: its environment claim, the person's consent and its launch
  // then all see the same grant. One no longer queued was dropped by a cancel and is skipped.
  const recorded = tx(() => {
    const turn = getTurn(turnId);
    if (turn?.status !== "queued") return false;
    const requested = (JSON.parse(turn.grant_json ?? "{}") as Grant).env;
    updateTurn(turnId, { grant_json: JSON.stringify({ ...grantFor(node, access), ...(requested?.length ? { env: requested } : {}) }) });
    return true;
  });
  if (!recorded) return cancelCheck() ? cancelledQueued() : dropped();
  // The turn's environment is claimed from the owning root now, before it waits for a slot, and
  // held in memory until it launches: a root that exits after this no longer fails the turn (W9).
  // The person is asked here about a one-turn grant.env request, and a denial fails the turn.
  let reserved = false, launchAttempted = false;
  let appClean = false;
  try {
    if (node.target === "codex") {
      const launchClass = capturedLaunchClass(nodeId, turnId);
      if (launchClass) {
        const retired = launchClass === "local" ? localModeRetired(cfg) : null;
        if (retired) return refused(`${retired}. So this job's agent was not started: continue it with one of those grants instead of local_network.`);
        reserveLaunch(nodeId, turnId, launchClass); reserved = true;
      }
    }
  } catch (err) { return refused((err as Error).message); }
  let environment: ClaimedEnvironment;
  try {
    environment = await claimTurnEnvironment(turnId, stopping.signal);
  } catch (err) {
    if (reserved) finishLaunchReservation(node.run_id, turnId, { clean: true });
    // A fault in relay itself (a session whose target it does not know, say) stops the worker, said
    // with its stack as any other. What the claim refused (no broker, a denial) fails this turn alone.
    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError) throw err;
    if (cancelCheck() || stopping.signal.aborted) return cancelledQueued();
    if (getTurn(turnId)?.status !== "queued") return dropped();
    return refused(storageProblem(err, "the agent was not started") ?? (err as Error).message);
  }
  // What the session was given beyond relay's isolation, and the turn's own directory for it (the
  // skill package and the gateway's manifest), in relay's control directory and removed at the end.
  const ext = extensionsOf(node);
  const extDir = path.join(dir, `ext-${turnId}`);
  // Stage 2 (backends/codex-stage2.ts): a copy of the skill package its commands can read, outside
  // relay's control directory, which relay's profile denies them. Removed with extDir.
  let extAssets: string | null = null;
  let slot: number | null = null;
  try {
    slot = await acquireSlot(node.run_id, node.id, cancelCheck);
    if (slot === null) return cancelledQueued();
    // A turn whose claim no longer applies fails as soon as it has its slot, before it starts and
    // before the person is asked about its extensions. The launch checks the claim again (take).
    try {
      environment.check();
    } catch (err) {
      return cancelCheck() ? cancelledQueued() : refused((err as Error).message);
    }
    // Any turn (a job's, a consult's, a discussion's) may ask for approval to act outside its
    // sandbox, unless approval requests are off or full access is already on. What a read-only turn
    // may ask for (the web, or a command; never file changes) is checked where the request is filed.
    const escalate = escalationEnabled(cfg) && !cfg.allow_dangerous;
    // A turn given MCP servers needs the server too: their tools are offered through it. It may
    // not delegate, whatever the session was started with: an agent it started would have none of
    // its limits (docs/extensions.md).
    const servers = Boolean(ext?.mcp_servers.length);
    const mayDelegate = node.allow_delegation === 1 && !servers;
    let relay = null;
    // Claude needs its permission prompt transport; Codex needs the stage-2 escalation broker
    // even when delegation is disabled. Tool availability cannot depend on mayDelegate.
    if (mayDelegate || servers || (escalate && ((node.target === "codex" && cfg.codex_backend === "app-server" && stage2Enabled(process.env, cfg)) || targetDef(node.target!).approvals.channel === "relay-tool"))) {
      // What this one turn may do travels with it. The child's relay server takes its authority
      // from here and from the registry, never from how the session was first created.
      const contextFile = path.join(dir, "context.json");
      writeContextFile(contextFile, {
        run_id: node.run_id, node_id: node.id, depth: node.depth,
        turn_id: turnId, access, may_delegate: mayDelegate, may_ask: escalate,
        ...(servers ? { extensions: path.join(extDir, "gateway.json") } : {}),
      });
      relay = { runId: node.run_id, nodeId: node.id, depth: node.depth, contextFile, turnId, mayDelegate, mayAsk: escalate };
    }
    // The turn starts only if it is still queued: a cancel may have dropped it while it waited for
    // its slot (a discussion's turn on a session it borrowed, see cancel). It takes its speed as it starts.
    const speed = tx(() => {
      const claimed = db().prepare("UPDATE turns SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(now(), turnId);
      if (Number(claimed.changes) !== 1) return null;
      return startSpeed(nodeId, turnId);
    });
    if (speed === null) return dropped();
    started = true;
    // A node shows as queued until it actually holds a slot.
    db().prepare("UPDATE nodes SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'").run(now(), nodeId);
    // Extensions need the person's consent before the agent starts, once per session.
    const extensions = ext ? await prepareExtensions(node, turnId, ext, extDir, cancelCheck) : null;
    // Either way the agent never ran, so the speed change the turn carried is settled as unreached (endTurn).
    if (extensions && "cancelled" in extensions) {
      endTurn({ status: "cancelled", ended_at: now() }, false);
      return notRun("interrupted", extensions.cancelled);
    }
    if (extensions && "refusal" in extensions) return refused(extensions.refusal);
    // A Codex write job given local network: the person's consent, once for the grant it holds.
    const local = await localNetworkConsent(node, turnId, access, cancelCheck);
    if (local && "cancelled" in local) {
      endTurn({ status: "cancelled", ended_at: now() }, false);
      return notRun("interrupted", local.cancelled);
    }
    if (local && "refusal" in local) return refused(local.refusal);
    // A Codex job given raw network (stage 2): the person's consent, once for the grant it holds (WP-E).
    const raw = await rawNetworkConsent(node, turnId, access, cancelCheck);
    if (raw && "cancelled" in raw) {
      endTurn({ status: "cancelled", ended_at: now() }, false);
      return notRun("interrupted", raw.cancelled);
    }
    if (raw && "refusal" in raw) return refused(raw.refusal);
    let handle: TurnHandle;
    try {
      if (cancelCheck()) throw new Error("cancelled before environment release");
      // Checked last thing before the launch: until then the agent of an earlier turn may have left
      // something running in the worktree. A turn in a job's worktree (its own, or one it works in
      // place in) gets that worktree's git directories as the repository records them; one whose
      // `.git` the agent changed is not started.
      const tree = turnTree(node);
      if (tree && "error" in tree) throw new Error(tree.error);
      // A stage-2 Codex turn is confined by relay's own Seatbelt, whose launch makes this check (prepareLaunch).
      const confinement = turnConfinement({ config: cfg, target: targetDef(node.target!), grant: grantFor(node, access) });
      const hardLinked = hardLinkProblem(node, access, cfg.allow_dangerous, tree ?? null, grantFor(node, access), confinement);
      if (hardLinked) throw new Error(hardLinked);
      // The environment claimed as the turn was picked up, only if nothing it was claimed under has
      // changed while the turn waited (its policy, config file, directory, grant or worker): if it
      // has, the turn fails here rather than launch on the earlier authority.
      const authorized = environment.take();
      // Only standing environment policy is live. Other execution limits retain the run snapshot.
      Object.assign(cfg, authorized.config);
      // A job with its own worktree is launched at the worktree root as jobTree checked it (its real
      // path, whose parent no agent can write), never at a path below it, which something the agent
      // left running could swap for a link between a check and the launch. Where the person was
      // working is said in the prompt instead (prompts.ts). An in-place session inside a job's
      // worktree starts at that worktree's root (workCwd); any other session in its own directory.
      const launchCwd = tree ? tree.worktree : workCwd(node);
      // A job's own worktree's git directories, for a target that commits natively (child_git "native").
      const gitDirs = node.worktree && tree ? [tree.commonDir, tree.gitDir] : undefined;
      const reviewId = sessionParams(node).review_id;
      const reviewNode = reviewId ? getNode(reviewId) : null;
      const independent = nodeTurns(node.id).find((t) => t.id === turnId)?.source === `review:${reviewId}`;
      // Stage 2, only while switched on: who confines this Codex turn's commands, for status and brief
      // (no registry schema change); the skill package copied where its commands can read it.
      let skills = extensions?.skills;
      if (stage2Enabled(process.env, cfg) && node.target === "codex") {
        const relayEnforced = Boolean(destinationOverlay(nodeId, turnId)) || turnConfinement({ config: cfg, target: targetDef(node.target), grant: grantFor(node, access) }) === "relay-enforced";
        recordEnforcement(node.id, turnId, relayEnforced ? "relay" : "codex");
        if (relayEnforced && skills) {
          extAssets = stage2SkillAssets({ skills });
          // Named in the registry, so that the retention sweep can remove it should this process die before the turn does.
          if (extAssets) noteSkillAssets(node.id, turnId, extAssets);
          skills = { dir: extAssets!, names: skills.names };
        }
      }
      // Bootstrap relay-owned directories before capturing their protected identities. Doing
      // this later in backend preparation let a sibling checkpoint invalidate a fresh launch.
      if (node.target === "codex") prepareCodexHome(cfg);
      const neverPolicy = checkpointNever(node.run_id, "launch");
      const neverProblem = neverGrantProblem(neverPolicy, grantFor(node, access) ?? {}, access === "write" ? [launchCwd] : []);
      if (neverProblem) throw new Error(neverProblem);
      const pendingOverlay = destinationOverlay(nodeId, turnId);
      if (pendingOverlay) {
        overlay = consumeOverlay(node.run_id, pendingOverlay.id, turnId);
        overlayTimer = setTimeout(() => {
          stopOverlay(node.run_id, overlay!.id, "overlay deadline expired");
          overlayAbort.abort();
        }, overlayRemainingMs(overlay));
      }
      setParam(node.id, "never_policy", { hash: neverPolicy.hash, version: neverPolicy.version, removed_builtins: neverPolicy.removed, hosted_web: neverPolicy.hosts.length ? "disabled" : "host policy", extension_tools: "qualified adapters only" });
      handle = await startTurn((signal) => launchTurn(targetDef(node.target!), {
        neverPolicy,
        ...(overlay ? { overlay } : {}),
        checkEnvironment: () => {
          if (reserved) { launchReservationState(node.run_id, turnId, "running"); launchAttempted = true; }
          // Even without an overlay, observe this Mac's addresses as well as any additions
          // another checkpoint kept while the backend prepared the turn.
          checkpointNever(node.run_id, "launch");
          if (overlay) assertOverlayLaunch(overlay, turnId);
          assertNeverLaunchCurrent(node.run_id, neverPolicy);
        },
        onNote: (note) => {
          const notes = sessionParams(getNode(node.id)!).notes ?? [];
          setParam(node.id, "notes", [...new Set([...notes, `Turn ${turnId}: ${redact(note)}`])]);
        },
        onServed: (model) => {
          try { recordServed(node.id, targetDef(node.target!), model); }
          catch { throw new Error("relay could not record the agent's model; the turn must stop."); }
        },
        onWaived: (which) => {
          try { recordWaiver(node.id, which); }
          catch { throw new Error("relay could not record the endpoint/settings waiver; the turn must stop."); }
        },
      target: targetDef(node.target!),
      turnId,
      sessionId: node.session_id ?? undefined,
      prompt,
      cwd: launchCwd,
      access,
      reviewReadDeny: independent && reviewNode ? reviewParams(reviewNode).caller_transcripts : undefined,
      relay,
      model: node.model ?? cfg.targets[node.target!]?.default_model ?? undefined,
      effort: node.effort ?? cfg.targets[node.target!]?.default_effort ?? undefined,
      // As the turn took it when it started (startSpeed).
      speed,
      config: cfg,
      environment: authorized.selection.env,
      environmentReleased: authorized.selection.releasedNames,
      dir,
      logPath: node.log_path ?? path.join(dir, "agent.log"),
      gitDirs,
      worktreePin: sessionParams(getNode(node.id)!).worktree_pin,
      gitEnv: tree?.env,
      escalate,
        onApproval: (ask, turnOver) => {
          const problem = overlayTurnProblem(nodeId, turnId);
          if (problem) return Promise.resolve({ allow: false, note: problem });
          return requestApproval(node.id, turnId, ask, () => turnOver() || cancelCheck() || Boolean(overlayTurnProblem(nodeId, turnId)));
        },
        heldForJob: (ask) => heldForJob(node.id, ask),
        grant: grantFor(node, access),
        markers: { runId: node.run_id, nodeId: node.id, depth: node.depth },
        ...(skills ? { skills } : {}),
        ...(ext?.mcp_servers.length ? { extensionServers: ext.mcp_servers.map((s) => s.name) } : {}),
        // For progress lines in the root session: what the agent is doing now.
        onActivity: (text) => {
          try {
            // Stored escaped whatever the backend made of it: status, progress lines and relay
            // tree show it to a person (review C12). Text already escaped passes unchanged.
            updateTurn(turnId, { activity: clipped(redact(text), 300), activity_at: now() });
          } catch {
            // Progress only.
          }
        },
        onUsage: (usage) => {
          try {
            updateTurn(turnId, { usage_json: JSON.stringify(usage) });
          } catch {
            // Reporting only.
          }
        },
        signal: AbortSignal.any([signal, overlayAbort.signal]),
      }));
    } catch (err) {
      // Stopped while it started (the worker's stop aborted it): the turn was cancelled, not refused.
      if (stopping.signal.aborted) {
        endTurn({ status: "cancelled", ended_at: now() }, false);
        return notRun("interrupted", "cancelled while the agent was being started");
      }
      // A backend refuses to launch rather than launch without the confinement it was asked for,
      // or because it could not write the files it launches the agent with (storageProblem). What
      // it refused can quote a secret (an endpoint's URL with its key in it, say).
      return refused(storageProblem(err, "the agent was not started") ?? (err as Error).message);
    }
    updateNode(nodeId, { agent_pid: handle.pid, agent_pgid: handle.pgid, agent_start: handle.startedAt, log_path: node.log_path ?? path.join(dir, "agent.log") });
    // The agent leads its own session and group (launched detached). Keep its leader id for the
    // run's lifetime so a process left in its group or session is placed inside the launched tree
    // after it exits (src/core/presence.ts), even once agent_pgid is cleared below.
    recordLaunchLeader(node.run_id, handle.pgid, "agent", nodeId);

    let timedOut = false;
    let ranMs = 0;
    let pausedMs = 0;
    const tick = 500;
    const maxPauseMs = 2 * cfg.approval_timeout_s * 1000;
    // Time spent waiting for someone to answer an approval request does not count against the
    // turn's limit. A cancel request can also arrive through the registry alone (from the CLI).
    const poll = setInterval(() => {
      if (cancelCheck()) return void handle.cancel();
      const closing = originOverlay(nodeId, turnId);
      if (closing && (closing.receipt?.delivered !== undefined || overlayDeadlineExpired(closing))) return void handle.cancel();
      if (overlay) {
        const current = getOverlay(node.run_id, overlay.id);
        if (current.state !== "running" || overlayDeadlineExpired(current)) {
          stopOverlay(node.run_id, overlay.id, current.outcome ?? "overlay deadline expired"); overlayAbort.abort(); return void handle.cancel();
        }
      }
      // The pause is capped, so repeated requests cannot hold a turn open indefinitely.
      if (hasPending(nodeId) && pausedMs < maxPauseMs) pausedMs += tick;
      else ranMs += tick;
      if (timeoutS !== null && ranMs >= timeoutS * 1000 && !timedOut) {
        timedOut = true;
        void handle.cancel();
      }
    }, tick);
    const done = applyRecordedCancellation(await handle.done, getTurn(turnId)?.status);
    clearInterval(poll);
    active.delete(handle);
    // What relay keeps of the turn (its reply, its error, the backend's warnings and speed warnings,
    // which can quote Claude's fast-mode notice, the commands its agent was refused) holds none of
    // the secrets relay passes on, nor the structured own_review arguments a reply can echo:
    // filtered before the turn row or outcome files are written, including the result returned to
    // the worker, which a job's `blocked`, a discussion's and a review's warnings are made from.
    const result: TurnResult = {
      ...done, finalMessage: redact(redactOwnReview(done.finalMessage)),
      ...(done.error !== undefined ? { error: redact(done.error) } : {}),
      ...(done.refusal ? { refusal: { ...done.refusal, message: redact(redactOwnReview(done.refusal.message)) } } : {}),
      ...(done.warnings ? { warnings: done.warnings.map((w) => redact(w)) } : {}),
      ...(done.speedWarnings ? { speedWarnings: done.speedWarnings.map((w) => redact(w)) } : {}),
      ...(done.denials ? { denials: done.denials.map((d) => redact(d)) } : {}),
    };
    const errorOf = (warnings: string[]) => redactOwnReview([timedOut ? `timed out after ${timeoutS}s.` : result.status === "ok" ? "" : (result.error ?? result.status), ...warnings, ...(result.speedWarnings ?? [])].filter(Boolean).join(" "), true) || null;
    // The turn's authority ends with its agent: the turn is recorded as over now, before relay's own
    // work on what the agent left (its process checks, the final message's file, the warnings), so
    // that nothing left of the agent can act for the turn meanwhile (db.ts turnEnded). What that work
    // finds is added to the turn's error below, before the worker records the turn's end for its
    // session; a call waiting on the turn takes it only then (db.ts turnSettled).
    const earlyError = errorOf([]);
    endTurn({
      status: result.status === "refused" ? "refused" : result.status === "ok" ? "done" : result.status === "interrupted" && !timedOut ? "cancelled" : "failed",
      refusal_json: result.refusal ? JSON.stringify(result.refusal) : null,
      reply: result.finalMessage,
      error: earlyError,
      denials: result.denials?.length ? JSON.stringify(result.denials) : null,
      ended_at: now(),
    }, result.delivered !== false);
    appClean = !done.survivors?.length && done.unseenMs === undefined && !groupAlive(handle.pgid);
    overlayCleanup = { clean: !nodeHasLiveExecutor(nodeId) && !done.survivors?.length && done.unseenMs === undefined && !groupAlive(handle.pgid), problem: done.warnings?.join(" ") ?? "", ...(done.survivors?.length ? { survivors: done.survivors } : {}) };
    if (reserved) finishLaunchReservation(node.run_id, turnId, { ...overlayCleanup, appClean });
    // The final message, kept whole in a file: one that cannot be written is said with the turn's
    // own warnings, which are what ask's caller is given.
    const finalPath = path.join(dir, `final-${turnId}.md`);
    const finalUnkept = keepRecord(finalPath, result.finalMessage, { consequence: "the final message is kept only in the registry" });
    if (finalUnkept) recordWarnings.push(`${finalUnkept}.`);

    // The backend resolves only once the agent's process group is empty. If something survived
    // even that, the record stays so it can still be found and stopped.
    const fields: Partial<NodeRow> = groupAlive(handle.pgid) ? {} : { agent_pid: null, agent_pgid: null, agent_start: null };
    // A session the prompt never reached holds none of the work: the next turn replays it all.
    if (result.sessionId && result.delivered !== false) fields.session_id = result.sessionId;
    updateNode(nodeId, fields);
    // Anything the agent started that relay cannot account for is reported, not forgotten, and so
    // is any server or tool of its extensions that relay could not offer.
    const warnings = [...processWarnings(result), ...(ext?.mcp_servers.length ? gatewayWarnings(extDir) : []), ...recordWarnings, ...takeDiagnosticProblems()].map((w) => redact(w));
    const error = errorOf(warnings);
    if (error !== earlyError) updateTurn(turnId, { error });
    // Only once the turn is recorded as over: a request still queued behind another is filed only
    // while its turn is running, so none can be filed after this.
    expireRequests(nodeId);
    const closing = originOverlay(nodeId, turnId);
    if (closing) {
      try {
        const next = prepareOverlayRestart(node.run_id, closing.id, overlayCleanup);
        if (next.state === "ready") return { ...result, status: "ok", finalMessage: overlayPrompt(next), error: undefined, timedOut, warnings, finalPath: finalUnkept ? null : finalPath, restartPending: true };
      } catch (err) {
        finishOverlay(node.run_id, closing.id, { ...overlayCleanup, problem: (err as Error).message });
        warnings.push(`Overlay allowed, not executed: ${(err as Error).message}`);
      }
    }
    if (overlay) warnings.push(overlayPrompt(getOverlay(overlay.runId, overlay.id)), `Overlay cleanup: ${overlayCleanup.clean ? "verified teardown" : "tainted; reservations retained"}.`);
    return { ...result, error: error ?? undefined, timedOut, warnings, finalPath: finalUnkept ? null : finalPath };
  } finally {
    if (reserved) finishLaunchReservation(node.run_id, turnId, launchAttempted ? { ...overlayCleanup, appClean } : { clean: true });
    if (overlayTimer) clearTimeout(overlayTimer);
    if (overlay) finishOverlay(node.run_id, overlay.id, overlayCleanup);
    // A turn that ended without launching (cancelled while it waited for its slot, say) forgets
    // the environment it claimed. One that launched has already taken it.
    environment.drop();
    if (slot !== null) releaseSlot(slot);
    fs.rmSync(extDir, { recursive: true, force: true });
    if (extAssets) {
      fs.rmSync(extAssets, { recursive: true, force: true });
      try { dropSkillAssets(nodeId, turnId); }
      catch { /* the sweep finds it gone and forgets it */ }
    }
  }
}

/**
 * Before a turn of a session given extensions: the person's consent, asked once per session as an
 * approval request only they can allow (docs/extensions.md), then the turn's skill package and the
 * gateway's manifest. A refusal says why the agent was not started.
 */
async function prepareExtensions(
  node: NodeRow, turnId: number, ext: SessionExtensions, extDir: string, cancelCheck: () => boolean,
): Promise<{ skills?: { dir: string; names: string[] } } | { refusal: string } | { cancelled: string }> {
  // Identify unqualified effects before consent or model launch. The gateway repeats the exact
  // definition/version/schema check and centrally screens every forwarded call.
  let catalog;
  try { catalog = await neverToolAdapters(ext.mcp_servers.length ? readMcpFile() : {}); }
  catch (err) { return { refusal: `never cannot qualify extension tools: ${(err as Error).message}` }; }
  const opaque = ext.mcp_servers.filter(s => !catalog.some(a => a.identity.server === s.name));
  if (opaque.length) return { refusal: `never withholds extension tools from ${opaque.map(s => s.name).join(", ")}: no qualified tool-specific effects adapter; opaque paths, network destinations, redirects or commands cannot be screened. Continue without these servers.` };
  if (!ext.consent) {
    const answer = await requestApproval(node.id, turnId, { kind: "extensions", summary: consentText(node, ext) }, cancelCheck);
    if (!answer.allow) {
      // A cancel while it waited ends the turn as cancelled, not failed.
      if (cancelCheck()) return { cancelled: "cancelled while waiting for the user's consent to its extensions" };
      const item = node.kind === "thread" ? "thread" : "job";
      // Who decided, in relay's words (deciderForAgent): the root session may deny, and so may anyone from a terminal.
      const why = answer.decider
        ? `consent to the extensions this ${item} was given was refused ${answer.decider}${answer.deciderNote ? ` (${answer.deciderNote})` : ""}`
        : `nobody consented to the extensions this ${item} was given (${answer.note ?? "no answer"})`;
      return { refusal: `${why}, so its agent was not started. Continue it to be asked again, or start the work without extensions.` };
    }
    setParam(node.id, "extensions", { ...ext, consent: { by: answer.decider ?? "by the user", at: now() } });
  }
  try {
    if (ext.mcp_servers.length) writeManifest(extDir, ext.mcp_servers, node.run_id);
    if (!ext.skills.length) return {};
    // Claude takes the package as a plugin; Codex as an extra skill root, with no plugin manifest.
    buildSkillPackage(extDir, ext.skills, { plugin: node.target === "claude" });
    return { skills: { dir: extDir, names: ext.skills.map((s) => s.name) } };
  } catch (err) {
    return { refusal: `${(err as Error).message}, so the agent was not started.` };
  }
}

export { localNetworkKey };

/** The question the person is asked about a Codex job's local network. */
export function localNetworkText(node: Pick<NodeRow, "id" | "target">): string {
  return `allow ${node.id} (${node.target ? targetLabel(targetDef(node.target)) : "the agent"}, a write job) to reach this Mac's loopback and the local network from its shell: every service listening there, sshd and screen sharing included, with your account's reach, loopback directly as well as through Codex's proxy; and to listen on every interface, so devices on your local network or tailnet can connect to servers it starts; for the rest of the job`;
}

/**
 * Before a turn of a Codex write job whose grant says local_network: the person's consent, asked as
 * an approval request only they can allow (PERSON_KINDS), once for the grant the job holds
 * (localNetworkKey). A refusal says why the agent was not started; without consent nothing runs,
 * rather than running with less than the caller asked for.
 */
async function localNetworkConsent(
  node: NodeRow, turnId: number, access: Mode, cancelCheck: () => boolean,
): Promise<null | { refusal: string } | { cancelled: string }> {
  // A consent is for the grant it was given under. Once the session holds another (local network
  // taken away, write paths changed), it is gone, whatever this turn's access: a grant that comes
  // back later is asked about again.
  const params = sessionParams(getNode(node.id)!);
  const given = params.local_network_consent;
  if (given && (!params.grant?.local_network || localNetworkKey(params.grant) !== given.grant)) setParam(node.id, "local_network_consent", null);
  const grant = grantFor(node, access);
  if (node.target !== "codex" || access !== "write" || !grant?.network || !grant.local_network) return null;
  // While stage 2 is switched on, local mode is refused outright, not asked about (raw-network.ts localModeRetired; decision D2).
  const retired = localModeRetired(runConfig(node.run_id));
  if (retired) return { refusal: `${retired}. So this job's agent was not started: continue it with one of those grants instead of local_network.` };
  const key = localNetworkKey(grant);
  if (sessionParams(getNode(node.id)!).local_network_consent?.grant === key) return null;
  const answer = await requestApproval(node.id, turnId, { kind: "local_network", summary: localNetworkText(node) }, cancelCheck);
  if (!answer.allow) {
    if (cancelCheck()) return { cancelled: "cancelled while waiting for the user's consent to its local network" };
    const why = answer.decider
      ? `consent to this job's local network was refused ${answer.decider}${answer.deciderNote ? ` (${answer.deciderNote})` : ""}`
      : `nobody consented to this job's local network (${answer.note ?? "no answer"})`;
    return { refusal: `${why}, so its agent was not started. Continue it to be asked again, or continue it with a grant without local_network for internet access only.` };
  }
  setParam(node.id, "local_network_consent", { grant: key, by: answer.decider ?? "by the user", at: now() });
  return null;
}

/** A read turn keeps only the network part of a grant: extra write paths never apply to it. */
function grantFor(node: NodeRow, access: Mode): Grant | undefined {
  const grant = sessionParams(node).grant ?? undefined;
  if (!grant) return undefined;
  const { env, ...standing } = grant;
  return access === "write" ? standing : standing.network ? { network: true } : undefined;
}
