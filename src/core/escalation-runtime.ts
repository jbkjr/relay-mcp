/** Trusted stage-2 adapter. No model-supplied value selects identity, policy or destination. */
import fs from "node:fs";
import { getNode, getTurn, runConfig, tx } from "./db.js";
import { getRequest } from "./approvals.js";
import { escalationDetail, escalationDecisionProblem, escalationRequestProblem } from "./escalation-authority.js";
import type { EscalationCanonical, EscalationRuntime, NormalizedCapability, OverlaySnapshot } from "./escalation-contract.js";
import { escalationDigest } from "./escalation-policy.js";
import { checkpointNever } from "./never-checkpoint.js";
import { sessionParams } from "./params.js";
import type { Grant } from "../backends/types.js";
import { mediatedBaseline, mediatedNetworkProblem } from "./mediated-network-provider.js";
import { createOverlayRequest, getOverlay, localhostControlProblem, markOverlayReceipt, settleOverlayRequestInTransaction, stopOverlay, type OverlayCapability } from "./restart-overlay.js";

function capabilities(caps: readonly NormalizedCapability[]): OverlayCapability[] {
  return caps.map(c => c.kind === "write_root"
    ? { kind: "write", root: c.real_root!, scope: fs.statSync(c.real_root!, { throwIfNoEntry: false })?.isDirectory() ? "tree" : "file" }
    : c.kind === "localhost" ? { kind: c.kind, operation: c.operation, port: c.port, host: "127.0.0.1" }
    : c.kind === "network" ? { kind: c.kind, mode: c.mode } : { kind: c.kind });
}

export function createEscalationRuntime(o: {
  nodeId: string; turnId: number; snapshot: OverlaySnapshot;
  /** Captured baseline, never the node's mutable grant. */
  baselineGrant?: Grant;
}): { runtime: EscalationRuntime; dispose(): void } {
  const baselineHash = escalationDigest(o.baselineGrant ?? null);
  const baselineProblem = () => {
    const node = getNode(o.nodeId), turn = getTurn(o.turnId);
    const grant = node && sessionParams(node).grant;
    // Match session.grantFor: environment disclosure is per turn, separately pinned by WP3.
    const { env: _env, ...standing } = grant ?? {};
    const effective = !grant ? null : turn?.access === "write" ? standing : standing.network ? { network: true } : null;
    return !node || !turn || escalationDigest(effective) !== baselineHash ? "the standing baseline grant changed since source launch; request a fresh turn" : null;
  };
  const bindings = new Map<string, { id: string; digest: string; signal: AbortSignal; cancel: () => void }>();
  let disposed = false;
  const abandon = (c: EscalationCanonical) => {
    const b = bindings.get(c.request_id); if (!b) return;
    const r = getOverlay(c.run_id, b.id);
    if (r.state === "requested") tx(() => settleOverlayRequestInTransaction(c.run_id, b.id, b.digest, "cancelled"));
    else if (["pending_restart", "stopping", "ready", "running"].includes(r.state)) {
      if (r.state === "pending_restart" && r.receipt?.delivered === undefined) markOverlayReceipt(c.run_id, b.id, false);
      stopOverlay(c.run_id, b.id, r.launchedAt === undefined ? "call cancelled or receipt lost; allowed, not executed" : "requesting call cancelled after launch");
    }
    b.signal.removeEventListener("abort", b.cancel);
  };
  const runtime: EscalationRuntime = {
    snapshot: () => ({ ...o.snapshot }),
    qualify(caps, policy) {
      if (disposed) return "the qualified stage-2 turn has ended";
      const changed = baselineProblem(); if (changed) return changed;
      const mediated = mediatedNetworkProblem({ capabilities: caps, baseline: mediatedBaseline(o.baselineGrant, runConfig(getNode(o.nodeId)!.run_id)), policy });
      if (mediated) return mediated;
      for (const c of caps) {
        if (c.kind === "network" && c.mode === "local") return "no qualified local network provider exists in this release";
        if (c.kind === "network" && c.mode === "raw" && policy.hosts.length) return "raw network is unavailable with any never.hosts entry";
        if (c.kind === "localhost" && c.host !== "127.0.0.1") return "no qualified IPv6 localhost overlay provider exists in this release";
        if (c.kind === "write_root" && getTurn(o.turnId)?.access !== "write") return "no qualified access-change provider exists in this release; read jobs cannot acquire outside writes";
      }
      return localhostControlProblem(caps);
    },
    prepare(c, digest, signal) {
      if (disposed || signal.aborted || c.node_id !== o.nodeId || c.origin_turn !== o.turnId || escalationDigest(c) !== digest) throw new Error("escalation lifecycle/identity lost before preparation");
      const changed = baselineProblem(); if (changed) throw new Error(changed);
      const remaining = Math.min(c.overlay_budget_s * 1000, (c.deadline_ms ?? Infinity) - Date.now());
      const r = createOverlayRequest({ nodeId: o.nodeId, originTurn: o.turnId, capabilities: capabilities(c.capabilities),
        reason: c.reason, continuation: JSON.stringify(c.continuation), intended: {
          ...(c.continuation.argv ? { argv: c.continuation.argv } : {}),
          ...(c.continuation.command ? { script: c.continuation.command } : {}),
          ...(c.continuation.cwd ? { cwd: c.continuation.cwd } : {}),
        },
        authority: { owningRoot: c.root.session_identity, tokenBinding: escalationDigest(c.root), required_decider: c.required_decider },
        remainingMs: remaining, pendingMs: c.approval_deadline_ms - Date.now(), escalation: { requestId: c.request_id, digest },
      });
      const cancel = () => abandon(c);
      bindings.set(c.request_id, { id: r.id, digest: r.digest, signal, cancel });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) { cancel(); throw new Error("escalation call cancelled during preparation"); }
      return { id: r.id, digest: r.digest };
    },
    abandon,
    async request(approval, signal) {
      const c = approval.canonical, b = bindings.get(c.request_id);
      const policy = checkpointNever(c.run_id, "decision");
      return tx(() => {
        const row = getRequest(c.request_id), d = row && escalationDetail(row.detail_json);
        if (disposed || signal.aborted || !b || !row || row.status !== "allowed" || !d || d.request_digest !== approval.digest
          || escalationDigest(d.decision) !== escalationDigest(approval.decision)) throw new Error("approved escalation lost before handoff");
        const why = baselineProblem() ?? escalationRequestProblem(d, row, policy) ?? escalationDecisionProblem(d, row);
        if (why) throw new Error(why);
        const r = getOverlay(c.run_id, b.id);
        if (r.state !== "pending_restart" || r.digest !== b.digest || !r.receipt || r.receipt.delivered !== undefined) throw new Error("overlay decision/receipt is not pending");
        return { state: "restart_pending" as const, overlay_id: r.id, disclosures: r.receipt.disclosures };
      });
    },
    async receipt(approval, delivered) {
      const c = approval.canonical, b = bindings.get(c.request_id);
      if (!b) throw new Error("receipt has no prepared overlay");
      const ok = delivered && !disposed && !b.signal.aborted;
      const r = getOverlay(c.run_id, b.id);
      if (r.receipt?.delivered === undefined && r.state === "pending_restart") markOverlayReceipt(c.run_id, b.id, ok);
      else if (ok) throw new Error("receipt already invalidated; never replay");
      if (!ok) stopOverlay(c.run_id, b.id, "receipt delivery failed; allowed, not executed");
      // Keep cancellation active until the lifecycle has finished teardown/consumption.
    },
  };
  return { runtime, dispose() {
    disposed = true;
    for (const [requestId, b] of bindings) {
      const row = getRequest(requestId), d = row && escalationDetail(row.detail_json);
      const r = getOverlay(getNode(o.nodeId)!.run_id, b.id);
      // A delivered handoff is owned by the worker after handle.done, not by the broker.
      if (d && r.receipt?.delivered !== true) abandon(d.escalation);
      b.signal.removeEventListener("abort", b.cancel);
    }
  } };
}
