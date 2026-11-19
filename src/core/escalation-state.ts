/** Durable WP3 authority/accounting checks, shared with WP2 without broker dependencies. */
import { db, getTurn, tx } from "./db.js";
import type { RequestRow } from "./approvals.js";
import { escalationDetail, escalationDecisionProblem, escalationRequestProblem } from "./escalation-authority.js";
import { assertNeverCurrent } from "./never-checkpoint.js";
import type { EscalationOutcome } from "./escalation-contract.js";
const request = (id: string) => db().prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;

/** WP2 checkpoints never before its consume transaction, then calls this INSIDE that
 * transaction alongside destination assignment and its consume-once/deadline state change.
 * This validates authority only; WP2 still owns atomic consumption, teardown and launch.
 */
export function assertEscalationConsumable(requestId: string, digest: string, neverHash: string) {
  const row = request(requestId); const detail = row && escalationDetail(row.detail_json);
  if (!row || row.status !== "allowed" || !detail?.decision || detail.request_digest !== digest || detail.decision.request_digest !== digest) throw new Error("overlay has no matching immutable escalation decision");
  const policy = assertNeverCurrent(row.run_id, neverHash);
  const why = escalationRequestProblem(detail, row, policy) ?? escalationDecisionProblem(detail, row); if (why) throw new Error(why);
  const state = JSON.parse(row.detail_json!);
  if (state.receipt_delivery !== "delivered" || state.handoff_state !== "pending") throw new Error("overlay receipt was not delivered or the handoff failed; do not launch or replay it");
  return { canonical: detail.escalation, digest, decision: detail.decision };
}
/** WP2 calls after durable launch/teardown. No output from an agent supplies these fields. */
export function recordEscalationOutcome(requestId: string, outcome: EscalationOutcome): void {
  const change = () => {
    const row = request(requestId); const detail = row && escalationDetail(row.detail_json);
    if (!row || row.status !== "allowed" || !detail?.decision) throw new Error("cannot account an unapproved escalation");
    const existing = JSON.parse(row.detail_json!).overlay_outcome as EscalationOutcome | undefined;
    if (existing?.launched && !outcome.launched || existing?.destination_turn != null && existing.destination_turn !== outcome.destination_turn) throw new Error("cannot erase or reassign an overlay launch");
    if (outcome.launched && (outcome.destination_turn === null || getTurn(outcome.destination_turn)?.node_id !== row.node_id)) throw new Error("overlay destination is not a turn of the approved job");
    db().prepare("UPDATE requests SET detail_json = json_set(detail_json, '$.overlay_outcome', json(?)) WHERE id = ?").run(JSON.stringify(outcome), requestId);
  };
  if (db().isTransaction) change(); else tx(change);
}

