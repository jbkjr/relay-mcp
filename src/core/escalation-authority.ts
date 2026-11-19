import type { Instance } from "./caller.js";
import { ancestors, getNode, getRun, getTurn, runConfig } from "./db.js";
import { escalationCapabilityProblem, escalationDigest, escalationEffect, owningRootBinding, requiredDecider } from "./escalation-policy.js";
import type { EscalationCanonical, EscalationDecision } from "./escalation-contract.js";
import type { NeverPolicy } from "./never-policy.js";

export interface EscalationDetail { escalation: EscalationCanonical; request_digest: string; decision?: EscalationDecision; overlay?: { id: string; digest: string } }
export interface DecisionAuthentication {
  route: "owning-run-root" | "person-dialog" | "person-confirm" | "person-terminal" | "terminal-deny";
  instance?: Pick<Instance, "ctx" | "token" | "host">;
  /** Must be the digest of the exact object shown by a qualified channel. */
  requestDigest: string;
}
export function escalationDetail(raw: string | null): EscalationDetail | null {
  try { const d = JSON.parse(raw ?? "{}"); return d.escalation && typeof d.request_digest === "string" ? d : null; } catch { return null; }
}
export function escalationDecisionAuthentication(row: { kind: string; detail_json: string | null }, route: DecisionAuthentication["route"], instance?: DecisionAuthentication["instance"]): DecisionAuthentication | undefined {
  const d = row.kind === "escalation" ? escalationDetail(row.detail_json) : null;
  return d ? { route, instance, requestDigest: d.request_digest } : undefined;
}
export function escalationRequestProblem(d: EscalationDetail, row: { id: string; run_id: string; node_id: string; turn_id: number | null; summary: string }, policy?: NeverPolicy): string | null {
  const c = d.escalation; const run = getRun(row.run_id); const turn = getTurn(c.origin_turn);
  const node = getNode(row.node_id);
  if (!node || run?.status !== "active" || ancestors(node, { self: true }).some(n => n.status === "cancelled")) return "escalation's owning run/job was cancelled or is unavailable";
  if (c.version !== 1 || c.request_id !== row.id || c.run_id !== row.run_id || c.node_id !== row.node_id || c.origin_turn !== row.turn_id || turn?.node_id !== row.node_id) return "escalation request identity changed";
  if (escalationDigest(c) !== d.request_digest || row.summary !== escalationEffect(c)) return "escalation canonical request digest or approval text changed";
  if (!run?.root_token || escalationDigest(owningRootBinding(row.run_id, run.root_token)) !== escalationDigest(c.root)) return "owning root session/token binding changed; ask for fresh approval";
  if (requiredDecider(c.capabilities, runConfig(row.run_id)) === "person" && c.required_decider !== "person") return "required_decider changed";
  if (c.required_decider !== "person" && c.required_decider !== "owning_run_root") return "invalid required_decider";
  if (!Number.isFinite(c.approval_deadline_ms) || Date.now() >= c.approval_deadline_ms || c.deadline_ms !== undefined && (!Number.isFinite(c.deadline_ms) || Date.now() >= c.deadline_ms)) return "escalation approval deadline expired";
  if (policy) {
    if (policy.hash !== c.never_hash) return "escalation never policy hash changed; ask against the cumulative floor";
    const why = escalationCapabilityProblem(c.capabilities, policy, c.access); if (why) return why;
  }
  if (turn?.access !== c.access) return "escalation source access changed";
  if (escalationDigest(turn.grant_json) !== c.baseline_grant_hash) return "escalation baseline grant changed; ask for fresh approval";
  return null;
}
export function authenticateEscalationDecision(d: EscalationDetail, auth: DecisionAuthentication | undefined, allow: boolean): string | null {
  if (!auth || auth.requestDigest !== d.request_digest) return "escalation decision needs authenticated channel and matching request digest; labels and reason strings are not authority";
  const c = d.escalation; const inst = auth.instance; const run = getRun(c.run_id);
  if (auth.route === "person-terminal" || auth.route === "terminal-deny") {
    if (allow && (auth.route !== "person-terminal" || c.required_decider === "person")) return "this person-only request requires a qualified dialog or confirm";
    return null; // CLI already checked interactive code and launched-agent ancestry.
  }
  if (!inst || inst.ctx.kind !== "root" || !run?.root_token || inst.token !== run.root_token || escalationDigest(owningRootBinding(c.run_id, inst.token)) !== escalationDigest(c.root)) return "missing or mismatched authenticated owning root session token";
  if (auth.route === "person-confirm") return inst.host.confirmTool === true ? null : "confirm is not a qualified person channel";
  if (auth.route === "person-dialog") return inst.host.personDialog === true && !!inst.host.elicit ? null : "dialog is not a qualified person channel";
  if (auth.route !== "owning-run-root" || allow && c.required_decider === "person") return "person-only capability cannot be authorized by the owning root";
  return null;
}

/** A consumed approval must still carry exactly the provenance recorded in its terminal row. */
export function escalationDecisionProblem(d: EscalationDetail, row: { decided_by: string | null; decided_at: number | null; note: string | null }): string | null {
  const decision = d.decision;
  if (!decision || decision.request_digest !== d.request_digest || escalationDigest(decision.root) !== escalationDigest(d.escalation.root) || decision.decided_by !== row.decided_by || decision.at !== row.decided_at || decision.note !== row.note) return "escalation decision provenance changed";
  const routes = d.escalation.required_decider === "person" ? ["person-dialog", "person-confirm"] : ["owning-run-root", "person-dialog", "person-confirm", "person-terminal"];
  return routes.includes(decision.route) ? null : "escalation decision route does not qualify for required_decider";
}
