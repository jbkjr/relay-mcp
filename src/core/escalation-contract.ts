/** WP2/WP3 integration seam. Only the trusted worker registers a qualified lifecycle. */
import type { NeverIdentity, NeverPolicy } from "./never-policy.js";

export type RequiredDecider = "owning_run_root" | "person";
export type Capability =
  | { kind: "localhost"; port: number; operation: "connect" | "listen"; host: "127.0.0.1" | "::1"; api_effects: string }
  | { kind: "port0" }
  | { kind: "write_root"; root: string; change_to_write?: boolean }
  | { kind: "network"; mode: "mediated" | "raw" | "local" };
export type NormalizedCapability = Capability & { id: string; real_root?: string; exists?: boolean; pins?: NeverIdentity[]; transport?: "tcp"; resolved_addresses?: string[] };
export interface EscalationInput {
  capabilities: Capability[];
  reason: string;
  continuation: { argv?: string[]; command?: string; cwd?: string; work?: string };
}
export interface RootBinding { run_id: string; session_identity: string; token_version: 1 }
export interface OverlaySnapshot {
  native_thread: string; native_turn: string;
  base_policy_hash: string; launch_plan: string;
  overlay_budget_s: number;
  /** Tighter remaining job/turn/running-overlay deadline, never renewed by asking. */
  deadline_ms?: number;
}
export interface EscalationCanonical extends OverlaySnapshot {
  version: 1; request_id: string; run_id: string; node_id: string; origin_turn: number;
  mcp_session: string; mcp_call: string; access: "read" | "write";
  root: RootBinding; required_decider: RequiredDecider;
  capabilities: NormalizedCapability[]; reason: string; continuation: EscalationInput["continuation"];
  never_hash: string; approval_deadline_ms: number;
  /** Digest of the registry turn's immutable grant_json, derived by WP3, never supplied by a child. */
  baseline_grant_hash: string;
}
export interface EscalationDecision {
  route: "owning-run-root" | "person-dialog" | "person-confirm" | "person-terminal" | "terminal-deny";
  root: RootBinding; decided_by: string; at: number; note: string | null;
  request_digest: string;
}
export interface ApprovedEscalation { canonical: EscalationCanonical; digest: string; decision: EscalationDecision }
export interface OverlayReceipt { state: "restart_pending"; overlay_id?: string }
export interface EscalationOutcome {
  destination_turn: number | null; launched: boolean;
  outcome: "pending" | "running" | "completed" | "failed" | "cancelled" | "expired" | "tainted";
  cleanup: "not_started" | "verified" | "uncertain" | "survivors";
  effective_scope: string;
}
export interface EscalationRuntime {
  snapshot(): OverlaySnapshot;
  /** No compiler/provider or unsupported effects => capability_unavailable before prompting. */
  qualify(capabilities: readonly NormalizedCapability[], policy: NeverPolicy): string | null;
  /** Persist the requested WP2 record before prompting. Its binding is committed alongside
   * the authenticated terminal decision, even when that decision arrives in another process. */
  prepare?(canonical: EscalationCanonical, digest: string, signal: AbortSignal): { id: string; digest: string };
  /** Abandon a request that never reached receipt delivery. Must never queue a destination. */
  abandon?(canonical: EscalationCanonical): void;
  /** Persist pending/closing handoff only. NEVER consume, launch, or wait for the next turn here.
   * Revalidate digest, pins, floor, grant, root, deadline and signal before storing. WP2 owns
   * durable receipt delivery, teardown, destination assignment/consume-once and deadline arming.
   * A lost receipt/cancelled signal must invalidate pending state, never replay a launch.
   */
  request(approval: ApprovedEscalation, signal: AbortSignal): Promise<OverlayReceipt>;
  /** Called once by the broker's actual transport write (or its failure/closure). A failed
   * delivery invalidates pending state. Only a delivered receipt can become consumable. */
  receipt(approval: ApprovedEscalation, delivered: boolean): Promise<void>;
}

const runtimes = new Map<string, EscalationRuntime>();
const key = (node: string, turn: number) => `${node}:${turn}`;
export function registerEscalationRuntime(node: string, turn: number, runtime: EscalationRuntime): () => void {
  const k = key(node, turn);
  if (runtimes.has(k)) throw new Error("escalation runtime already registered for this turn");
  runtimes.set(k, runtime);
  return () => { if (runtimes.get(k) === runtime) runtimes.delete(k); };
}
export const escalationRuntime = (node: string, turn: number) => runtimes.get(key(node, turn));

// Keep the contract import surface stable while person-route availability owns its storage.
export {
  publishEscalationPersonPath, localEscalationPersonPath, refreshEscalationPersonPath,
  escalationPersonPathAvailable,
} from "./escalation-person-path.js";
