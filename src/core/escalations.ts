import { recordEscalationOutcome } from "./escalation-state.js";
import type { Instance, Json } from "./caller.js";
import { escalationEnabled } from "./config.js";
import { db, getNode, getRun, getTurn, newId, runConfig, tx, workCwd } from "./db.js";
import { getRequest, requestApproval, turnGone } from "./approvals.js";
import { assertNeverCurrent, checkpointNever } from "./never-checkpoint.js";
import { escalationDecisionProblem, escalationDetail, escalationRequestProblem } from "./escalation-authority.js";
import { escalationPersonPathAvailable, escalationRuntime, type EscalationCanonical, type EscalationInput, type EscalationOutcome } from "./escalation-contract.js";
import { escalationCapabilityProblem, escalationDigest, escalationEffect, EscalationInputSchema, localhostConnectEffect, normalizeCapabilities, owningRootBinding, requiredDecider } from "./escalation-policy.js";
import { redactor, SESSION_TOKEN_SHAPE } from "./secrets.js";
import { holdsServers } from "./extensions.js";

const inFlight = new Set<string>();
export interface EscalationCall { signal: AbortSignal; sessionId?: string; requestId: string | number; onTick?: (elapsedMs: number) => void }
const failure = (error: string, reason: string): Json => ({ error, reason, recovery: "Continue within the current profile, or ask the owning root/person for a qualified replacement-turn capability." });

/** Durable admission gate shared by every broker session of the source turn. */
export function escalationTurnClosing(node: string, turn: number): boolean {
  return !!db().prepare("SELECT 1 FROM requests WHERE node_id = ? AND turn_id = ? AND kind = 'escalation' AND status = 'allowed' AND json_extract(detail_json, '$.handoff_state') IS NOT NULL LIMIT 1").get(node, turn);
}

export async function escalate(inst: Instance, raw: EscalationInput, call: EscalationCall): Promise<Json> {
  const ctx = inst.ctx;
  if (ctx.kind !== "child" || !ctx.mayAsk) return failure("capability_unavailable", "only the authenticated live owning child may request escalation");
  const key = `${ctx.nodeId}:${ctx.turnId}`;
  if (escalationTurnClosing(ctx.nodeId, ctx.turnId)) return failure("turn_closing", "this turn already handed off an escalation; it cannot issue more work");
  if (inFlight.has(key)) return failure("escalation_pending", "this turn already has an escalation call in flight");
  const node = getNode(ctx.nodeId); const turn = getTurn(ctx.turnId);
  if (!node || node.run_id !== ctx.runId || !turn || turn.access !== ctx.access || turnGone(ctx.nodeId, ctx.turnId)) return failure("turn_ended", "the source turn is no longer live");
  const cfg = runConfig(ctx.runId);
  if (!escalationEnabled(cfg) || cfg.allow_dangerous) return failure("capability_unavailable", "escalation is disabled or the launch is not a checked confined turn");
  const runtime = escalationRuntime(ctx.nodeId, ctx.turnId);
  if (!runtime) return failure("capability_unavailable", "this backend has no qualified restart-overlay lifecycle registered");
  if (call.signal.aborted) return failure("approval_denied", "the requesting call was cancelled");
  inFlight.add(key);
  let requestId: string | undefined;
  let prepared: EscalationCanonical | undefined;
  let handedOff = false;
  try {
    const input = EscalationInputSchema.parse(raw);
    const serialized = JSON.stringify(input);
    if (serialized.length > 262144 || SESSION_TOKEN_SHAPE.test(serialized) || redactor()(serialized) !== serialized) return failure("invalid_request", "the request is too large or contains a secret/bearer token; remove it");
    const policy = checkpointNever(ctx.runId, "approval");
    const caps = normalizeCapabilities(input, workCwd(node));
    const why = escalationCapabilityProblem(caps, policy, ctx.access); if (why) return failure("capability_refused", why);
    const unavailable = runtime.qualify(caps, policy); if (unavailable) return failure("capability_unavailable", unavailable);
    const owner = getRun(ctx.runId)?.root_token;
    if (!owner) return failure("capability_unavailable", "the run has no authenticated owning root session");
    const decider = holdsServers(node) ? "person" : requiredDecider(caps, cfg);
    const snapshot = runtime.snapshot();
    if (!snapshot.native_thread || !snapshot.native_turn || !snapshot.base_policy_hash || !snapshot.launch_plan || !Number.isFinite(snapshot.overlay_budget_s) || snapshot.overlay_budget_s <= 0 || snapshot.deadline_ms !== undefined && (!Number.isFinite(snapshot.deadline_ms) || snapshot.deadline_ms <= Date.now())) return failure("capability_unavailable", "the runtime did not supply a checked identity and finite remaining deadline");
    let deadline = snapshot.deadline_ms ?? Infinity;
    if (cfg.job_timeout_s !== null) deadline = Math.min(deadline, (node.started_at ?? node.created_at) + cfg.job_timeout_s * 1000);
    if (cfg.turn_timeout_s !== null) deadline = Math.min(deadline, (turn.started_at ?? turn.created_at) + cfg.turn_timeout_s * 1000);
    const overlayBudget = Math.min(3600, snapshot.overlay_budget_s, (deadline - Date.now()) / 1000);
    if (!(overlayBudget > 0)) return failure("approval_denied", "the source job/turn deadline expired");
    requestId = newId("request");
    const canonical: EscalationCanonical = {
      ...snapshot, version: 1, request_id: requestId, run_id: ctx.runId, node_id: ctx.nodeId, origin_turn: ctx.turnId,
      mcp_session: call.sessionId ?? escalationDigest(["relay-broker-session-v1", inst.token]), mcp_call: String(call.requestId), access: ctx.access,
      root: owningRootBinding(ctx.runId, owner), required_decider: decider, capabilities: caps,
      reason: input.reason, continuation: input.continuation, never_hash: policy.hash,
      baseline_grant_hash: escalationDigest(turn.grant_json),
      overlay_budget_s: overlayBudget, approval_deadline_ms: Math.min(Date.now() + cfg.approval_timeout_s * 1000, deadline),
      ...(Number.isFinite(deadline) ? { deadline_ms: deadline } : {}),
    };
    if (decider === "person" && !escalationPersonPathAvailable(ctx.runId)) return failure("person_path_unavailable", escalationEffect(canonical));
    const digest = escalationDigest(canonical);
    // MCP retries never create another approval/overlay, even on a new broker server instance.
    const replay = db().prepare("SELECT id FROM requests WHERE node_id = ? AND turn_id = ? AND kind = 'escalation' AND json_extract(detail_json, '$.escalation.mcp_session') = ? AND json_extract(detail_json, '$.escalation.mcp_call') = ? LIMIT 1")
      .get(node.id, turn.id, canonical.mcp_session, canonical.mcp_call) as { id: string } | undefined;
    if (replay) return failure("request_replayed", `MCP call already recorded as ${replay.id}; it will not be reapplied`);
    const overlay = runtime.prepare?.(canonical, digest, call.signal);
    prepared = canonical;
    const effect = escalationEffect(canonical);
    const answer = await requestApproval(node.id, turn.id, { kind: "escalation", summary: effect, reason: input.reason, detail: { escalation: canonical, request_digest: digest, effect, ...(overlay ? { overlay } : {}) } }, () => call.signal.aborted || escalationRuntime(node.id, turn.id) !== runtime, call.onTick);
    if (!answer.allow) {
      if (getRequest(requestId)?.status === "allowed") recordEscalationOutcome(requestId, { destination_turn: null, launched: false, outcome: "cancelled", cleanup: "not_started", effective_scope: "approved but never launched" });
      return failure("approval_denied", answer.note ?? "the escalation was denied or expired");
    }
    const effective = checkpointNever(ctx.runId, "decision");
    const approved = tx(() => {
      assertNeverCurrent(ctx.runId, effective.hash);
      const row = getRequest(requestId!); const detail = row && escalationDetail(row.detail_json);
      if (!row || row.status !== "allowed" || !detail?.decision || detail.request_digest !== digest) throw new Error("no matching authenticated approval was recorded");
      // WP2's atomic allow deliberately closes this origin to all OTHER work. The owning
      // escalation must still deliver its receipt; test registry liveness without that gate.
      const no = escalationRequestProblem(detail, row, effective) ?? escalationDecisionProblem(detail, row)
        ?? (getTurn(turn.id)?.status !== "running" || getNode(node.id)?.status !== "running" ? "the source turn is no longer live" : null);
      if (no || call.signal.aborted || escalationRuntime(node.id, turn.id) !== runtime) throw new Error(no ?? "the originating call/lifecycle was lost before handoff");
      const current = runtime.snapshot();
      if (current.base_policy_hash !== canonical.base_policy_hash || current.native_thread !== canonical.native_thread || current.native_turn !== canonical.native_turn || current.launch_plan !== canonical.launch_plan || current.deadline_ms !== snapshot.deadline_ms) throw new Error("the effective source policy/identity/deadline changed after approval");
      db().prepare("UPDATE requests SET detail_json = json_set(detail_json, '$.handoff_state', 'pending') WHERE id = ?").run(row.id);
      return { canonical: detail.escalation, digest: detail.request_digest, decision: detail.decision };
    });
    // Request only: WP2 stores the consume-once continuation and closes the turn. The broker
    // returns now; it never waits for the destination, whose old app server must die first.
    const receipt = await runtime.request(approved, call.signal);
    if (call.signal.aborted) throw new Error("requesting call cancelled during handoff; runtime must invalidate pending state");
    handedOff = true;
    return { ...receipt, request_id: requestId, request_digest: digest, capabilities: caps, required_decider: decider, decision_provenance: approved.decision, overlay_budget_s: canonical.overlay_budget_s, approval_deadline_ms: canonical.approval_deadline_ms, effect: escalationEffect(canonical) };
  } catch (err) {
    if (requestId && getRequest(requestId)?.status === "allowed") {
      db().prepare("UPDATE requests SET detail_json = json_set(detail_json, '$.handoff_state', 'failed-before-launch') WHERE id = ?").run(requestId);
      recordEscalationOutcome(requestId, { destination_turn: null, launched: false, outcome: "failed", cleanup: "not_started", effective_scope: "approved but never launched" });
    }
    return failure("escalation_failed", (err as Error).message);
  } finally {
    if (prepared && !handedOff) runtime.abandon?.(prepared);
    inFlight.delete(key);
  }
}

/** Bind transport delivery to the exact pending handoff; repeated writes cannot replay it. */
export function escalationReceiptDelivery(requestId: string, digest: string, signal: AbortSignal): (delivered: boolean) => Promise<void> {
  const row = getRequest(requestId);
  const runtime = row?.turn_id == null ? undefined : escalationRuntime(row.node_id, row.turn_id);
  let settled = false;
  return async delivered => {
    if (settled) return; settled = true;
    const ok = delivered && !signal.aborted;
    const approved = tx(() => {
      const row = getRequest(requestId); const detail = row && escalationDetail(row.detail_json);
      if (!row || row.status !== "allowed" || !detail?.decision || detail.request_digest !== digest) throw new Error("receipt has no matching approved escalation");
      const changed = db().prepare("UPDATE requests SET detail_json = json_set(detail_json, '$.receipt_delivery', ?) WHERE id = ? AND json_extract(detail_json, '$.receipt_delivery') IS NULL")
        .run(ok ? "delivered" : "failed", requestId);
      if (Number(changed.changes) !== 1) return null;
      return { canonical: detail.escalation, digest, decision: detail.decision };
    });
    if (!approved) return;
    try {
      if (!runtime) throw new Error("overlay runtime lost before receipt delivery");
      await runtime.receipt(approved, ok);
    } catch (err) {
      db().prepare("UPDATE requests SET detail_json = json_set(detail_json, '$.receipt_delivery', 'failed', '$.handoff_state', 'failed-before-launch') WHERE id = ?").run(requestId);
      recordEscalationOutcome(requestId, { destination_turn: null, launched: false, outcome: "failed", cleanup: "not_started", effective_scope: "approved but never launched" });
      throw err;
    }
  };
}

export { assertEscalationConsumable, recordEscalationOutcome } from "./escalation-state.js";

/** Results/status derive scope from authoritative requests, including failures/cancellations. */
export function escalationAccounting(nodeId: string): Json[] {
  const rows = db().prepare("SELECT id, detail_json FROM requests WHERE node_id = ? AND kind = 'escalation' AND status = 'allowed' ORDER BY created_at, id").all(nodeId) as { id: string; detail_json: string }[];
  return rows.map(row => {
    const d = escalationDetail(row.detail_json); if (!d) return { request_id: row.id, enforcement: "unknown", cleanup: "uncertain", error: "malformed escalation accounting" };
    const outcome = JSON.parse(row.detail_json).overlay_outcome as EscalationOutcome | undefined;
    const launched = outcome?.launched === true;
    const lan = d.escalation.capabilities.some(c => c.kind === "port0" || c.kind === "localhost" && c.operation === "listen");
    return { request_id: row.id, request_digest: d.request_digest, origin_turn: d.escalation.origin_turn, destination_turn: outcome?.destination_turn ?? null, capabilities: d.escalation.capabilities, required_decider: d.escalation.required_decider, decision_provenance: d.decision,
      lifetime: "one replacement turn", enforcement: "baseline plus explicit approved capability; no baseline-only confinement claim", ...outcome,
      launch: outcome ? launched ? "launched" : "allowed but never launched" : "allowed; not yet launched or launch outcome unreported",
      cleanup: outcome?.cleanup ?? "uncertain",
      ...(lan ? { lan_disclosure: launched ? "This turn allowed listeners to bind 0.0.0.0, so they could be on the LAN." : "Allowed listeners to bind 0.0.0.0, so they could be on the LAN; never launched or launch outcome unreported." } : {}),
      ...(d.escalation.capabilities.some(c => c.kind === "localhost" && c.operation === "connect") ? { connect_disclosure: `${launched ? "This turn allowed" : "Approved; never launched or launch outcome unreported:"} ${d.escalation.capabilities.flatMap(c => c.kind === "localhost" && c.operation === "connect" ? [localhostConnectEffect(c.port)] : []).join(" ")}` } : {}),
    };
  });
}
