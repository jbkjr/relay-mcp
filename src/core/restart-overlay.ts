/** Restart-only, one-destination capabilities. Authority decisions belong to WP3, never to this module. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonical, foldedPath } from "./config.js";
import { cancelledAbove, db, getNode, getRun, getTurn, insertTurn, runConfig, tx, workCwd, type NodeRow } from "./db.js";
import { assertNeverCurrent, checkpointNever } from "./never-checkpoint.js";
import { neverDigest, neverEndpointProblem, neverGrantProblem, neverPathIdentity, type NeverIdentity, type NeverPolicy } from "./never-policy.js";
import { sessionParams } from "./params.js";
import { pidAlive, procStart, sameProcess } from "./procs.js";
import { stage2Enabled } from "./stage2-switch.js";
import { assertEscalationConsumable, recordEscalationOutcome } from "./escalation-state.js";
import { mediatedBaseline, mediatedNetworkProblem, MEDIATED_NETWORK_EFFECT } from "./mediated-network-provider.js";
import { localhostConnectEffect, localhostListenEffect, PORT0_APPROVAL_TEXT } from "./escalation-policy.js";
import { executorRecords } from "./stage2-executors.js";
import { listeningSnapshot } from "../confine/ports.js";
import { STATIC_DENIED_TCP } from "../confine/port-policy.js";

let controlSnapshot = listeningSnapshot;
/** Code-only fixture seam; no configuration or child environment can replace the snapshot. */
export function setOverlayControlSnapshotForTests(snapshot: typeof listeningSnapshot | null): void { controlSnapshot = snapshot ?? listeningSnapshot; }
/** Before prompting, reject static service ports and control listeners outside relay's reserved range. */
export function localhostControlProblem(capabilities: readonly { kind: string; operation?: string; port?: number }[]): string | null {
  const local = capabilities.filter(c => c.kind === "localhost" && (c.operation === "connect" || c.operation === "listen"));
  const staticallyDenied = local.find(c => STATIC_DENIED_TCP.includes(c.port!));
  if (staticallyDenied) return `never relay.authority: static denied TCP port ${staticallyDenied.port} cannot be a localhost ${staticallyDenied.operation} exception`;
  if (!local.length) return null;
  try {
    const snapshot = controlSnapshot();
    return local.some(c => snapshot.controlPlanes.includes(c.port!)) ? "never relay.authority: control listeners cannot be localhost exceptions" : null;
  } catch (err) { return `capability_unavailable: relay cannot check localhost control listeners (${(err as Error).message})`; }
}

export const OVERLAY_DEFAULT_BUDGET_MS = 3_600_000;
const Port = z.number().int().min(1).max(65535);
export const OverlayCapabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("localhost"), operation: z.enum(["connect", "listen"]), port: Port, host: z.literal("127.0.0.1").default("127.0.0.1") }).strict(),
  z.object({ kind: z.literal("port0") }).strict(),
  z.object({ kind: z.literal("write"), root: z.string().min(1).max(4096), scope: z.enum(["file", "tree"]) }).strict(),
  z.object({ kind: z.literal("network"), mode: z.enum(["mediated", "raw", "local"]) }).strict(),
]);
export type OverlayCapability = z.infer<typeof OverlayCapabilitySchema>;
export type OverlayState = "requested" | "pending_restart" | "stopping" | "ready" | "running" | "tainted" | "expired" | "denied" | "cancelled" | "failed";
export interface OverlayDecision { decisionId: string; decidedBy: string; route: "supervisor" | "person"; at: number; note?: string }
export interface OverlayRequestInput {
  nodeId: string; originTurn: number; capabilities: unknown; reason: string; continuation: string;
  /** Authenticated, NON-SECRET identity/version bindings, derived by WP3, included in the digest. */
  authority: { owningRoot: string; tokenBinding: string; required_decider: "owning_run_root" | "person" };
  intended?: { argv?: string[]; script?: string; cwd?: string };
  /** Tighter trusted remaining job/turn bound; never supplied by the child. */
  remainingMs?: number;
  pendingMs?: number;
  escalation?: { requestId: string; digest: string };
}
export interface OverlayRecord {
  v: 1; id: string; runId: string; nodeId: string; originTurn: number; destinationTurn?: number;
  state: OverlayState; digest: string; request: {
    capabilities: OverlayCapability[]; disclosures: string[]; reason: string; continuation: string; authority: OverlayRequestInput["authority"];
    intended?: OverlayRequestInput["intended"]; grantHash: string; neverHash: string; access: "read" | "write"; originConfinement: "relay" | "native";
    roots: { root: string; scope: "file" | "tree"; pins: NeverIdentity[]; existed: boolean }[];
    createdAt: number; pendingDeadline: number; pendingMonotonicDeadline: number; clockBoot: string; budgetMs: number; hardDeadline?: number;
    escalation?: { requestId: string; digest: string };
  };
  budgetMs: number; decision?: OverlayDecision;
  receipt?: { status: "restart_pending"; id: string; digest: string; effects: OverlayCapability[]; disclosures: string[]; decision: OverlayDecision; delivered?: boolean };
  owner: { pid: number; start: string };
  consumedAt?: number; launchedAt?: number; recoveryDeadline?: number; monotonicDeadline?: number; boot?: string;
  cleanup?: Cleanup; outcome?: string;
}
export interface Cleanup { clean: boolean; problem?: string; survivors?: number[] }
interface OverlayClock { wall(): number; mono(): number; boot(): string; owner?(): { pid: number; start: string } }
// Kernel monotonic time is comparable across workers. Boot fingerprint detects reboot/clock jumps.
const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
const REAL_CLOCK: OverlayClock = { wall: Date.now, mono: monotonicMs, boot: () => String(Math.round((Date.now() - monotonicMs()) / 10_000)) };
let clock = REAL_CLOCK;
export function setOverlayClockForTests(c: OverlayClock | null): void { clock = c ?? REAL_CLOCK; }
const active = (r: OverlayRecord) => !["expired", "denied", "cancelled", "failed"].includes(r.state);
const overlap = (a: string, b: string) => { a = foldedPath(a); b = foldedPath(b); return a === b || a.startsWith(b + "/") || b.startsWith(a + "/"); };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function records(runId: string): Record<string, OverlayRecord> {
  const run = getRun(runId); if (!run) throw new Error("overlay run is unavailable");
  const saved = JSON.parse(run.config_json).params_json?.overlays;
  if (saved === undefined) return {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("malformed overlay records");
  for (const [id, r] of Object.entries(saved) as [string, OverlayRecord][]) {
    if (!r || r.v !== 1 || r.id !== id || r.runId !== runId || !r.nodeId || !Number.isSafeInteger(r.originTurn)
      || !["requested", "pending_restart", "stopping", "ready", "running", "tainted", "expired", "denied", "cancelled", "failed"].includes(r.state)
      || !r.request || neverDigest(r.request) !== r.digest || !Number.isFinite(r.budgetMs) || r.budgetMs <= 0
      || !r.owner || !Number.isInteger(r.owner.pid) || typeof r.owner.start !== "string"
      || (r.state === "running" && (!Number.isSafeInteger(r.destinationTurn) || !Number.isFinite(r.monotonicDeadline) || !Number.isFinite(r.recoveryDeadline)))) throw new Error(`malformed overlay ${id}`);
  }
  return saved;
}
function save(r: OverlayRecord): OverlayRecord {
  const all = records(r.runId); all[r.id] = r;
  db().prepare("UPDATE runs SET config_json = json_set(config_json, '$.params_json.overlays', json(?)) WHERE id = ?").run(JSON.stringify(all), r.runId);
  const bound = r.request.escalation;
  if (bound && (db().prepare("SELECT status FROM requests WHERE id = ?").get(bound.requestId) as { status: string } | undefined)?.status === "allowed") {
    const terminal = ["failed", "expired", "cancelled", "tainted"].includes(r.state);
    const status = r.destinationTurn === undefined ? undefined : getTurn(r.destinationTurn)?.status;
    recordEscalationOutcome(bound.requestId, {
      destination_turn: r.destinationTurn ?? null, launched: r.launchedAt !== undefined,
      outcome: r.state === "tainted" ? "tainted" : r.state === "running" ? r.launchedAt === undefined ? "pending" : "running"
        : !terminal ? "pending" : r.outcome?.includes("deadline") ? "expired" : status === "done" && r.launchedAt !== undefined ? "completed"
        : status === "cancelled" || r.outcome?.includes("cancelled") ? "cancelled" : "failed",
      cleanup: r.cleanup ? r.cleanup.survivors?.length ? "survivors" : r.cleanup.clean ? "verified" : "uncertain" : "not_started",
      effective_scope: `Captured baseline grant: ${getTurn(r.originTurn)?.grant_json ?? "null"}. Approved additions: ${JSON.stringify(r.request.capabilities)}; ${r.request.disclosures.join(" ")}`,
    });
  }
  return clone(r);
}
function assertHandoffOwner(r: OverlayRecord): void {
  const start = clock.owner?.().start ?? procStart(process.pid);
  if (r.owner.pid !== process.pid || !start || r.owner.start !== start) throw new Error("overlay supervisor restarted during handoff; never replay a launch");
}
function assertAuthority(r: OverlayRecord, policy: NeverPolicy): void {
  const binding = r.request.escalation;
  if (binding) assertEscalationConsumable(binding.requestId, binding.digest, policy.hash);
}
export function getOverlay(runId: string, id: string): OverlayRecord {
  const r = records(runId)[id]; if (!r) throw new Error("overlay is unavailable"); return clone(r);
}
function nodeFor(r: OverlayRecord): NodeRow {
  const n = getNode(r.nodeId); if (!n || n.run_id !== r.runId || cancelledAbove(n, { self: true })) throw new Error("overlay owner was cancelled or lost"); return n;
}
function grantHash(n: NodeRow): string { return neverDigest(sessionParams(n).grant ?? null); }
function liveOrigin(r: OverlayRecord): void {
  const n = nodeFor(r), t = getTurn(r.originTurn);
  if (n.status !== "running" || t?.node_id !== n.id || t.status !== "running") throw new Error("overlay origin is no longer live");
}
function validatePlan(r: OverlayRecord, policy: NeverPolicy): void {
  const n = nodeFor(r);
  if (grantHash(n) !== r.request.grantHash) throw new Error("overlay baseline grant changed; request a fresh decision");
  if (policy.hash !== r.request.neverHash) throw new Error("overlay never policy changed; request a fresh decision");
  assertNeverCurrent(r.runId, r.request.neverHash);
  const baseline = neverGrantProblem(policy, sessionParams(n).grant ?? {}, n.mode === "write" ? [workCwd(n)] : []); if (baseline) throw new Error(baseline);
  const mediated = mediatedNetworkProblem({ capabilities: r.request.capabilities, baseline: mediatedBaseline(sessionParams(n).grant, runConfig(n.run_id)), policy });
  if (mediated) throw new Error(`capability_unavailable: ${mediated}`);
  const controls = localhostControlProblem(r.request.capabilities); if (controls) throw new Error(controls);
  for (const c of r.request.capabilities) {
    const why = c.kind === "localhost" ? neverEndpointProblem(policy, { host: "127.0.0.1", port: c.port, transport: "tcp", operation: c.operation })
      : c.kind === "write" ? neverGrantProblem(policy, { write_paths: [c.root] })
      : c.kind === "network" ? neverGrantProblem(policy, { raw_network: c.mode !== "mediated" }) : null;
    if (why) throw new Error(why);
  }
  for (const root of r.request.roots) assertOverlayRoot(root);
}
/** Strict namespace/identity pins include absence; a newly created root requires a fresh decision. */
export function assertOverlayRoot(root: OverlayRecord["request"]["roots"][number]): void {
  if (canonical(root.root) !== root.root || neverDigest(neverPathIdentity(root.root)) !== neverDigest(root.pins)) throw new Error(`overlay write root identity changed: ${root.root}`);
  const st = fs.lstatSync(root.root, { throwIfNoEntry: false });
  if (Boolean(st) !== root.existed || (st && (st.isSymbolicLink() || (root.scope === "file" ? !st.isFile() || st.nlink !== 1 : !st.isDirectory())))) throw new Error(`overlay write root identity changed: ${root.root}`);
}

/** WP3 calls after trusted normalization/identity derivation; no approval or widening occurs here. */
export function createOverlayRequest(input: OverlayRequestInput): OverlayRecord {
  const n = getNode(input.nodeId), turn = getTurn(input.originTurn);
  if (!n || turn?.node_id !== n.id || turn.status !== "running" || n.status !== "running") throw new Error("overlay origin is not live");
  if (n.target !== "codex") throw new Error("capability_unavailable: restart overlays require the qualified Codex executor");
  const config = JSON.parse(getRun(n.run_id)!.config_json);
  if (!stage2Enabled(process.env, config) || config.codex_backend === "exec") throw new Error("capability_unavailable: overlays require enabled stage2 app-server execution");
  const capabilities = z.array(OverlayCapabilitySchema).min(1).max(32).parse(input.capabilities);
  const authority = z.object({ owningRoot: z.string().min(1).max(256), tokenBinding: z.string().min(1).max(512), required_decider: z.enum(["owning_run_root", "person"]) }).strict().parse(input.authority);
  const reason = z.string().min(1).max(8192).parse(input.reason);
  const continuation = z.string().max(262144).parse(input.continuation);
  const intended = input.intended === undefined ? undefined : z.object({ argv: z.array(z.string().max(65536)).max(1024).optional(), script: z.string().max(262144).optional(), cwd: z.string().max(4096).optional() }).strict().parse(input.intended);
  if (!input.authority?.owningRoot || !input.authority.tokenBinding || !["owning_run_root", "person"].includes(input.authority.required_decider)) throw new Error("overlay requires authenticated root identity bindings");
  if (capabilities.some(c => c.kind === "network" && ["raw", "local"].includes(c.mode)) && input.authority.required_decider !== "person") throw new Error("raw/local overlay requires a person decision");
  const policy = checkpointNever(n.run_id, "approval");
  const mediated = mediatedNetworkProblem({ capabilities, baseline: mediatedBaseline(sessionParams(n).grant, config), policy });
  if (mediated) throw new Error(`capability_unavailable: ${mediated}`);
  const roots: OverlayRecord["request"]["roots"] = [];
  const controls = localhostControlProblem(capabilities); if (controls) throw new Error(controls);
  for (const c of capabilities) {
    if (c.kind === "network" && c.mode === "local") throw new Error("capability_unavailable: no qualified local overlay provider");
    if (c.kind === "write") {
      if (!path.isAbsolute(c.root) || path.normalize(c.root) !== c.root || canonical(c.root) !== c.root || overlap(c.root, n.worktree ?? n.cwd)) throw new Error("capability_unavailable: write root must be an exact canonical root outside the worktree");
      const root = { root: c.root, scope: c.scope, pins: neverPathIdentity(c.root), existed: fs.existsSync(c.root) };
      assertOverlayRoot(root); roots.push(root);
      if (c.scope === "tree" && !root.existed) throw new Error("capability_unavailable: a writable tree must already exist as a pinned real directory");
      if (c.scope === "file" && (!fs.statSync(path.dirname(c.root)).isDirectory() || c.root.split(path.sep).some(p => /^\.(git|claude|codex|agents|gemini|mcp|envrc|vscode|bashrc|zshrc|gitconfig)(\.|$)/.test(p)))) throw new Error("capability_unavailable: exact file overlaps protected tool/git configuration");
      if (turn.access !== "write") throw new Error("capability_unavailable: read jobs require an explicit access change before outside writes");
    }
  }
  const cfg = runConfig(n.run_id);
  const configuredLimit = n.kind === "job" ? cfg.job_timeout_s : cfg.turn_timeout_s;
  const configuredRemaining = configuredLimit === null ? Infinity : Math.max(0, configuredLimit * 1000 - Math.max(0, clock.wall() - (n.kind === "job" ? n.started_at ?? n.created_at : turn.started_at ?? turn.created_at)));
  const remainingMs = Math.min(input.remainingMs ?? Infinity, configuredRemaining);
  const budgetMs = Math.min(OVERLAY_DEFAULT_BUDGET_MS, remainingMs);
  const pendingMs = Math.min(input.pendingMs ?? (2 * cfg.approval_timeout_s + 300) * 1000, remainingMs);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || !Number.isFinite(pendingMs) || pendingMs <= 0) throw new Error("overlay deadline already expired");
  const at = clock.wall(), start = clock.owner?.().start ?? procStart(process.pid);
  if (!start) throw new Error("overlay supervisor identity unavailable");
  const request: OverlayRecord["request"] = {
    capabilities, disclosures: ["The addition applies to every operation and descendant in one replacement turn. The command runs worktree code that the agent can edit after approval.", ...capabilities.flatMap(c =>
      c.kind === "port0" ? [`${PORT0_APPROVAL_TEXT} It adds no outbound network.`]
      : c.kind === "localhost" && c.operation === "listen" ? [localhostListenEffect(c.port)]
      : c.kind === "localhost" && c.operation === "connect" ? [localhostConnectEffect(c.port)]
      : c.kind === "write" ? [`Writes to exact ${c.scope} ${c.root} persist after the overlay ends.`]
      : c.kind === "network" ? [c.mode === "raw" ? "Raw network adds direct TCP/UDP/DNS and LAN/tailnet reachability, including forwarding and exfiltration effects; person-only authority."
        : MEDIATED_NETWORK_EFFECT] : [])], reason, continuation, authority, ...(intended ? { intended } : {}),
    grantHash: grantHash(n), neverHash: policy.hash, access: turn.access,
    originConfinement: sessionParams(n).codex_confinement?.turn === turn.id && sessionParams(n).codex_confinement?.enforcement === "relay" ? "relay" : "native",
    roots, createdAt: at, pendingDeadline: at + pendingMs, pendingMonotonicDeadline: clock.mono() + pendingMs, clockBoot: clock.boot(), budgetMs,
    ...(Number.isFinite(remainingMs) ? { hardDeadline: at + remainingMs } : {}),
    ...(input.escalation ? { escalation: clone(input.escalation) } : {}),
  };
  const r: OverlayRecord = { v: 1, id: `ov_${crypto.randomBytes(8).toString("hex")}`, runId: n.run_id, nodeId: n.id, originTurn: turn.id, state: "requested", request, digest: neverDigest(request), budgetMs, owner: { pid: process.pid, start } };
  return tx(() => {
    if (Object.values(records(n.run_id)).some(x => x.nodeId === n.id && active(x) && !(x.state === "running" && x.destinationTurn === turn.id))) throw new Error("overlay already pending or active for this node");
    liveOrigin(r); validatePlan(r, policy); return save(r);
  });
}
function pendingCurrent(r: OverlayRecord): void {
  if (r.request.clockBoot !== clock.boot() || clock.mono() >= r.request.pendingMonotonicDeadline || clock.wall() < r.request.createdAt || clock.wall() >= r.request.pendingDeadline || (r.request.hardDeadline !== undefined && clock.wall() >= r.request.hardDeadline)) throw new Error("overlay approval/restart deadline expired");
}
/** WP3 MUST authenticate decider and commit its terminal decision in the SAME registry transaction.
 * Call checkpointNever outside that transaction, then this function inside it. */
export function allowOverlayInTransaction(runId: string, id: string, digest: string, decision: OverlayDecision): OverlayRecord {
  const r = getOverlay(runId, id);
  if (r.state !== "requested" || r.digest !== digest) throw new Error("overlay decision already terminal or digest changed");
  liveOrigin(r); pendingCurrent(r); validatePlan(r, assertNeverCurrent(runId, r.request.neverHash));
  if (!decision.decisionId || !decision.decidedBy || !Number.isFinite(decision.at) || !["person", "supervisor"].includes(decision.route)) throw new Error("overlay missing decision provenance");
  if (r.request.authority.required_decider === "person" && decision.route !== "person") throw new Error("overlay requires a person decision");
  if (decision.route === "supervisor" && decision.decidedBy !== r.request.authority.owningRoot) throw new Error("overlay supervisor is not the owning root");
  r.decision = clone(decision); r.state = "pending_restart";
  r.receipt = { status: "restart_pending", id: r.id, digest, effects: clone(r.request.capabilities), disclosures: clone(r.request.disclosures), decision: clone(decision) };
  return save(r);
}
/** Standalone wrapper; WP3 uses the InTransaction form for atomic competing decisions. */
export function allowOverlay(runId: string, id: string, digest: string, decision: OverlayDecision): OverlayRecord {
  checkpointNever(runId, "decision"); return tx(() => allowOverlayInTransaction(runId, id, digest, decision));
}
export function markOverlayReceipt(runId: string, id: string, delivered: boolean): OverlayRecord {
  return tx(() => { const r = getOverlay(runId, id); if (r.state !== "pending_restart" || !r.receipt || r.receipt.delivered !== undefined) throw new Error("overlay receipt already settled"); r.receipt.delivered = delivered; r.state = "stopping"; if (!delivered) r.outcome = "receipt delivery failed; allowed, not executed"; return save(r); });
}
/** WP3's atomic deny/cancel loser protection; never silently overwrite an allow. */
export function settleOverlayRequestInTransaction(runId: string, id: string, digest: string, outcome: "denied" | "cancelled", decision?: OverlayDecision): OverlayRecord {
  const r = getOverlay(runId, id);
  if (r.digest !== digest || r.state !== "requested") throw new Error("overlay decision already terminal or digest changed");
  r.state = outcome; if (decision) r.decision = clone(decision); return save(r);
}
export function originOverlay(nodeId: string, turnId: number): OverlayRecord | null {
  const n = getNode(nodeId); if (!n) return null;
  return Object.values(records(n.run_id)).find(r => r.nodeId === nodeId && r.originTurn === turnId && active(r) && r.state !== "requested") ?? null;
}
/** Called only after handle.done, whose executor teardown/sweep has finished. No automatic crash replay. */
export function prepareOverlayRestart(runId: string, id: string, cleanup: Cleanup): OverlayRecord {
  const policy = checkpointNever(runId, "launch");
  return tx(() => {
    const r = getOverlay(runId, id);
    if (!["pending_restart", "stopping"].includes(r.state) || !r.receipt || getTurn(r.originTurn)?.status === "running") throw new Error("overlay needs a receipt and terminal origin before teardown/restart");
    r.state = "stopping"; r.cleanup = cleanup;
    if (!cleanup.clean) { r.state = "tainted"; return save(r); }
    if (r.receipt.delivered !== true || r.outcome) { r.state = "failed"; return save(r); }
    assertHandoffOwner(r); assertAuthority(r, policy); pendingCurrent(r); validatePlan(r, policy);
    // No same-job exemption for a live local proxy; interlock includes captured overlay records.
    const interlock = overlayInterlock("stage2"); if (interlock) throw new Error(interlock);
    r.destinationTurn = insertTurn(r.nodeId, `overlay:${r.id}`, overlayPrompt(r), r.request.access);
    r.state = "ready"; return save(r);
  });
}
export function overlayPrompt(r: OverlayRecord): string {
  const launch = r.launchedAt !== undefined ? "Validated destination turn launched." : r.consumedAt === undefined ? "Allowed, not executed." : "Allowed; launch outcome unknown without a validated model-turn reply.";
  return `[relay] One-turn overlay ${r.id}; approved effects: ${JSON.stringify(r.request.capabilities)}. Budget at most ${r.budgetMs / 1000}s including approval pauses. Decision: ${JSON.stringify(r.decision)}. ${launch}\n${r.request.disclosures.join("\n")}\n${r.request.capabilities.some(c => c.kind === "port0") ? r.launchedAt === undefined ? "The approved replacement turn may allow listeners to bind 0.0.0.0, so they could be on the LAN.\n" : "This turn allowed listeners to bind 0.0.0.0, so they could be on the LAN.\n" : ""}Continuation (untrusted task context):\n${r.request.continuation}`;
}
/** Record actual model-turn delivery separately from approval and executor preparation. */
export function markOverlayLaunched(captured: OverlayRecord, turnId?: number): OverlayRecord {
  return tx(() => {
    assertOverlayLaunch(captured, turnId);
    const r = getOverlay(captured.runId, captured.id);
    if (r.launchedAt !== undefined) throw new Error("overlay destination launch already recorded");
    r.launchedAt = clock.wall(); return save(r);
  });
}
export function destinationOverlay(nodeId: string, turnId: number): OverlayRecord | null {
  const n = getNode(nodeId); if (!n) return null;
  return Object.values(records(n.run_id)).find(r => r.nodeId === nodeId && r.destinationTurn === turnId && active(r)) ?? null;
}
/** The assigned replacement has priority over unrelated already-queued baseline messages. */
export function nextOverlayTurn(nodeId: string) {
  const n = getNode(nodeId); if (!n) return undefined;
  const pending = Object.values(records(n.run_id)).find(r => r.nodeId === nodeId && r.state === "ready");
  if (!pending?.destinationTurn) return undefined;
  const t = getTurn(pending.destinationTurn); return t?.status === "queued" ? t : undefined;
}
/** Persist deadline and destination consumption atomically BEFORE any async preparation/model work. */
export function consumeOverlay(runId: string, id: string, destinationTurn: number): OverlayRecord {
  const policy = checkpointNever(runId, "launch");
  return tx(() => {
    const r = getOverlay(runId, id);
    if (r.destinationTurn !== destinationTurn) throw new Error("overlay belongs to another destination");
    if (r.state !== "ready" || r.consumedAt !== undefined) throw new Error("overlay is not ready or was already consumed; no crash retry");
    const t = getTurn(destinationTurn); if (!t || t.node_id !== r.nodeId || !["queued", "running"].includes(t.status) || t.source !== `overlay:${id}`) throw new Error("overlay destination is not live");
    assertHandoffOwner(r); assertAuthority(r, policy); pendingCurrent(r); validatePlan(r, policy);
    const conflict = overlayInterlock("stage2"); if (conflict) throw new Error(conflict);
    const at = clock.wall(), ms = Math.min(r.budgetMs, r.request.hardDeadline === undefined ? Infinity : r.request.hardDeadline - at);
    if (ms <= 0) throw new Error("overlay deadline expired");
    r.budgetMs = ms; r.consumedAt = at; r.recoveryDeadline = at + ms; r.monotonicDeadline = clock.mono() + ms; r.boot = clock.boot(); r.state = "running";
    const start = clock.owner?.().start ?? procStart(process.pid);
    if (!start) throw new Error("overlay supervisor identity unavailable");
    r.owner = { pid: process.pid, start };
    return save(r);
  });
}
/** A clock discrepancy cannot renew consent. Wall time is recovery evidence; hrtime enforces elapsed time. */
export function overlayDeadlineExpired(r: OverlayRecord): boolean {
  if (r.consumedAt === undefined) return r.request.clockBoot !== clock.boot() || clock.mono() >= r.request.pendingMonotonicDeadline || clock.wall() < r.request.createdAt || clock.wall() >= r.request.pendingDeadline;
  return r.boot !== clock.boot() || clock.wall() < r.consumedAt || clock.wall() >= r.recoveryDeadline! || clock.mono() >= r.monotonicDeadline!;
}
export function stopOverlay(runId: string, id: string, outcome: string): OverlayRecord {
  const change = () => { const r = getOverlay(runId, id); if (active(r)) { r.state = "stopping"; r.outcome = outcome; return save(r); } return r; };
  return db().isTransaction ? change() : tx(change);
}
export function finishOverlay(runId: string, id: string, cleanup: Cleanup): OverlayRecord {
  return tx(() => { const r = getOverlay(runId, id); if (!active(r)) return r; if (!r.outcome && overlayDeadlineExpired(r)) r.outcome = "overlay deadline expired"; r.cleanup = cleanup; r.state = cleanup.clean ? (r.consumedAt === undefined ? "failed" : "expired") : "tainted"; return save(r); });
}
/** Tool/approval and launch gate; leaves stopping durable before returning the refusal. */
export function overlayTurnProblem(nodeId: string, turnId: number): string | null {
  const n = getNode(nodeId); if (!n) return null;
  for (const r of Object.values(records(n.run_id)).filter(r => r.nodeId === nodeId && active(r))) {
    if (r.state === "requested") continue;
    if (r.destinationTurn === turnId && r.state === "ready") continue;
    if (r.destinationTurn === turnId && r.state === "running" && !overlayDeadlineExpired(r)) continue;
    if (r.state === "running" && overlayDeadlineExpired(r)) { stopOverlay(r.runId, r.id, "overlay deadline expired"); return `overlay ${r.id} deadline expired; stopping before further work`; }
    return `overlay ${r.id} ${r.state}: turn is closing or awaiting verified overlay teardown`;
  }
  return null;
}
export interface LaunchReservation {
  v: 1; id: string; nodeId: string; turnId: number; launchClass: "local" | "stage2";
  state: "starting" | "running" | "stopping" | "tainted";
  /** Set before entering a backend: a crash from here requires proven teardown. */
  launching: boolean; owner: { pid: number; start: string }; cleanup?: Cleanup & { appClean?: boolean };
}
function reservations(runId: string): Record<string, LaunchReservation> {
  const saved = JSON.parse(getRun(runId)!.config_json).params_json?.launch_reservations;
  if (saved === undefined) return {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error(`malformed launch reservations in ${runId}`);
  for (const [id, r] of Object.entries(saved) as [string, LaunchReservation][]) {
    if (!r || r.v !== 1 || r.id !== id || !r.nodeId || !Number.isSafeInteger(r.turnId)
      || !["local", "stage2"].includes(r.launchClass) || !["starting", "running", "stopping", "tainted"].includes(r.state)
      || typeof r.launching !== "boolean" || !r.owner || !Number.isInteger(r.owner.pid) || r.owner.pid < 2 || typeof r.owner.start !== "string" || !r.owner.start
      || r.cleanup !== undefined && (!r.cleanup || typeof r.cleanup !== "object" || typeof r.cleanup.clean !== "boolean"
        || r.cleanup.problem !== undefined && typeof r.cleanup.problem !== "string"
        || r.cleanup.appClean !== undefined && typeof r.cleanup.appClean !== "boolean"
        || r.cleanup.survivors !== undefined && (!Array.isArray(r.cleanup.survivors) || r.cleanup.survivors.some(p => !Number.isInteger(p) || p < 2))))
      throw new Error(`malformed launch reservation ${id} in ${runId}; reap/cancel and verify cleanup`);
  }
  return saved;
}
function saveReservations(runId: string, saved: Record<string, LaunchReservation>): void {
  db().prepare("UPDATE runs SET config_json = json_set(config_json, '$.params_json.launch_reservations', json(?)) WHERE id = ?").run(JSON.stringify(saved), runId);
}
function capturedNetworkGrant(json: string | null): { network?: boolean; local_network?: boolean; raw_network?: boolean } {
  const grant = JSON.parse(json ?? "{}");
  if (!grant || typeof grant !== "object" || Array.isArray(grant) || [grant.network, grant.local_network, grant.raw_network].some(x => x !== undefined && typeof x !== "boolean") || grant.local_network && grant.raw_network) throw new Error("invalid captured network grant");
  return grant;
}
export function capturedLaunchClass(nodeId: string, turnId: number): LaunchReservation["launchClass"] | null {
  const n = getNode(nodeId), t = getTurn(turnId);
  if (!n || !t || t.node_id !== nodeId) throw new Error("captured launch turn is unavailable");
  if (n.target !== "codex") return null;
  const grant = capturedNetworkGrant(t.grant_json);
  if (destinationOverlay(nodeId, turnId)) return "stage2";
  if (t.access !== "write") return null;
  return grant.raw_network ? "stage2" : grant.local_network ? "local" : null;
}
/** Capture effective policy before consent. BEGIN IMMEDIATE makes opposing starts mutually exclusive. */
export function reserveLaunch(nodeId: string, turnId: number, launchClass: LaunchReservation["launchClass"]): void {
  tx(() => {
    const n = getNode(nodeId), t = getTurn(turnId);
    if (!n || !t || t.node_id !== nodeId || !["queued", "running"].includes(t.status)) throw new Error("cannot reserve an inactive launch");
    if (capturedLaunchClass(nodeId, turnId) !== launchClass) throw new Error("launch class differs from captured turn policy/overlay");
    const conflict = overlayInterlock(launchClass); if (conflict) throw new Error(conflict);
    const all = reservations(n.run_id), id = String(turnId);
    if (all[id]) throw new Error(`launch reservation ${id} already exists; verify teardown before retry`);
    const start = clock.owner?.().start ?? procStart(process.pid, { fresh: true }); if (!start) throw new Error("cannot reserve launch without supervisor identity");
    all[id] = { v: 1, id, nodeId, turnId, launchClass, state: "starting", launching: false, owner: { pid: process.pid, start } };
    saveReservations(n.run_id, all);
  });
}
export function launchReservationState(runId: string, turnId: number, state: "running" | "stopping"): void {
  tx(() => {
    const all = reservations(runId), r = all[String(turnId)]; if (!r) throw new Error(`launch reservation ${turnId} is unavailable`);
    if (state === "running") {
      if (r.state === "tainted" || r.state === "stopping") throw new Error(`launch reservation ${r.id} ${r.state}; reap/cancel and verify cleanup`);
      const conflict = overlayInterlock(r.launchClass); if (conflict) throw new Error(conflict);
      r.launching = true;
    }
    if (r.state !== "tainted") r.state = state;
    saveReservations(runId, all);
  });
}
/** Revocation closes the launch gate before any process signalling or terminal turn update. */
export function stopNodeLaunchReservations(nodeId: string): void {
  const change = () => {
    const n = getNode(nodeId); if (!n) return;
    const all = reservations(n.run_id);
    for (const r of Object.values(all)) if (r.nodeId === nodeId && r.state !== "tainted") r.state = "stopping";
    saveReservations(n.run_id, all);
  };
  if (db().isTransaction) change(); else tx(change);
}
export function finishLaunchReservation(runId: string, turnId: number, cleanup: Cleanup & { appClean?: boolean }): void {
  tx(() => {
    const all = reservations(runId), r = all[String(turnId)]; if (!r) return;
    if (cleanup.clean) delete all[r.id];
    else { r.state = "tainted"; r.cleanup = { ...r.cleanup, ...cleanup }; }
    saveReservations(runId, all);
  });
}
/** Existing executor reap/cancel/retention must retain its lease when app-server cleanup is unknown. */
export function launchExecutorQuarantine(runId: string, turnId: number | null): string | undefined {
  try {
    if (turnId === null || !getRun(runId)) return undefined;
    const r = reservations(runId)[String(turnId)];
    return r?.launching && r.cleanup?.appClean !== true ? `untraceable app-server cleanup: launch reservation ${r.id} ${r.state}; quarantine retained` : undefined;
  } catch (err) { return `untraceable app-server cleanup: launch reservation state unreadable (${(err as Error).message})`; }
}
/** Called only after the existing executor sweep proved cleanup, before releasing its lease. */
export function finishLaunchExecutor(runId: string, turnId: number | null): void {
  if (turnId === null || !getRun(runId)) return;
  const r = reservations(runId)[String(turnId)];
  if (r?.cleanup?.appClean === true) finishLaunchReservation(runId, turnId, { clean: true });
}
/** Reap owns recovery; an absent native leader cannot prove detached processes stopped. */
export function reapLaunchReservations(runId: string, stop: (r: LaunchReservation) => Cleanup): void {
  for (const r of Object.values(reservations(runId))) {
    if (sameProcess(r.owner.pid, r.owner.start, { fresh: true }) || pidAlive(r.owner.pid) && procStart(r.owner.pid, { fresh: true }) === null) continue;
    const cleanup = r.launching ? stop(r) : { clean: true };
    finishLaunchReservation(runId, r.turnId, cleanup);
  }
}
/** Retention must not erase quarantine just because the node/turn is terminal. */
export function launchReservationProblem(runId: string, nodeId?: string): string | null {
  try {
    const r = Object.values(reservations(runId)).find(r => !nodeId || r.nodeId === nodeId);
    if (r) return `launch reservation ${r.id} of ${r.nodeId} ${r.state}; reap/cancel and verify cleanup`;
    const overlay = Object.values(records(runId)).find(r => active(r) && (!nodeId || r.nodeId === nodeId));
    return overlay ? `overlay ${overlay.id} ${overlay.state}; reap/cancel and verify cleanup` : null;
  } catch (err) { return `launch reservation state unreadable: ${(err as Error).message}`; }
}
/** WP4 interlock: persisted effective class survives mutable flags/grants and worker death. */
export function overlayInterlock(starting: "stage2" | "local"): string | null {
  try {
    for (const run of db().prepare("SELECT id FROM runs").all() as { id: string }[]) {
      for (const r of Object.values(records(run.id))) {
        if (starting === "local" && active(r)) return `overlay ${r.id} ${r.state} reserves stage2; reap/cancel and verify cleanup before local launch`;
      }
      for (const r of Object.values(reservations(run.id))) {
        if (r.launchClass !== starting) return `launch reservation ${r.id} of ${r.nodeId} ${r.state} reserves ${r.launchClass}; reap/cancel and verify cleanup before ${starting} launch`;
      }
    }
    // Legacy/captured turns, including flag-off leftovers. Never consult mutable node grants/config.
    for (const row of db().prepare("SELECT t.grant_json, t.id AS turnId, t.status, n.id FROM nodes n JOIN turns t ON t.node_id=n.id WHERE n.target='codex' AND t.access='write' AND (t.status='running' OR n.agent_pgid IS NOT NULL AND t.status NOT IN ('queued'))").all() as { grant_json: string | null; turnId: number; status: string; id: string }[]) {
      let grant: { network?: boolean; local_network?: boolean; raw_network?: boolean };
      try {
        grant = capturedNetworkGrant(row.grant_json);
      } catch { return `relay cannot read the grant of a running turn of ${row.id} (turn ${row.turnId}, state ${row.status}); reap/cancel and verify cleanup before launch`; }
      if (starting === "stage2" && grant.local_network) return `${row.id} is running a turn in local network mode, and relay does not start a raw-network turn or overlay while Codex's local-network proxy runs: the proxy has no authentication (turn ${row.turnId}, state ${row.status === "running" ? "running" : "tainted; terminal turn retains agent group"}). Reap/cancel and verify that turn and its proxy have stopped`;
      if (starting === "local" && grant.raw_network) return `${row.id} is running a turn with raw network (relay's stage 2), and relay does not open Codex's local-network proxy while one runs (turn ${row.turnId}, state ${row.status === "running" ? "running" : "tainted; terminal turn retains agent group"}). Reap/cancel and verify cleanup before local launch`;
    }
    if (starting === "local") {
      const { records: executors, problems } = executorRecords();
      if (problems.length) return `executor record state unreadable: ${problems.join("; ")}; reap/cancel and verify cleanup before local launch`;
      // A record is released only by successful teardown/sweep, never by an absent leader.
      const first = executors[0];
      if (first) return `executor ${first.file} of ${first.record.nodeId} state ${first.record.tainted ? "tainted" : "running or awaiting verified teardown"}; reap/cancel and verify cleanup before local launch`;
    }
    return null;
  } catch (err) { return `overlay interlock state unreadable: ${(err as Error).message}; reap/cancel and verify cleanup before launch`; }
}
/** Synchronous recovery hook used by registry reap; stop MUST kill app server before executor/sweep. */
export function reapOverlays(runId: string, deps: { ownerAlive(r: OverlayRecord): boolean; stop(r: OverlayRecord): Cleanup }): void {
  for (const r of Object.values(records(runId))) {
    if (!active(r)) continue;
    const turn = getTurn(r.destinationTurn ?? r.originTurn);
    const over = !turn || !["queued", "running"].includes(turn.status);
    const handedOff = r.consumedAt === undefined && r.state === "stopping" && r.receipt?.delivered;
    if (!over && !["tainted", "stopping"].includes(r.state) && !overlayDeadlineExpired(r) && deps.ownerAlive(r)) continue;
    // A live worker owns the acknowledged origin handoff. Reap must not turn its clean restart into
    // an expired overlay; deadlines and worker death still take precedence.
    if (handedOff && !overlayDeadlineExpired(r) && deps.ownerAlive(r)) continue;
    stopOverlay(runId, r.id, r.consumedAt === undefined ? "interrupted before launch; allowed, not executed" : "deadline, worker death or uncertain cleanup");
    let cleanup: Cleanup;
    try { cleanup = deps.stop(r); } catch (err) { cleanup = { clean: false, problem: (err as Error).message }; }
    finishOverlay(runId, r.id, cleanup);
  }
}
export const overlayOwnerAlive = (r: OverlayRecord): boolean => sameProcess(r.owner.pid, r.owner.start, { fresh: true });
export const overlayRemainingMs = (r: OverlayRecord): number => Math.max(0, Math.min(r.monotonicDeadline! - clock.mono(), r.recoveryDeadline! - clock.wall()));

/** Final synchronous environment/executor gate; use after every asynchronous preparation. */
export function assertOverlayLaunch(captured: OverlayRecord, turnId?: number): void {
  const r = getOverlay(captured.runId, captured.id);
  if (r.state !== "running" || r.destinationTurn !== turnId || r.digest !== captured.digest || r.recoveryDeadline !== captured.recoveryDeadline || r.monotonicDeadline !== captured.monotonicDeadline || r.consumedAt !== captured.consumedAt || r.boot !== captured.boot || overlayDeadlineExpired(r)) throw new Error("overlay launch is expired, changed or not its consumed destination");
  assertHandoffOwner(r);
  const policy = assertNeverCurrent(r.runId, r.request.neverHash);
  if (r.launchedAt === undefined) assertAuthority(r, policy);
  validatePlan(r, policy);
  const conflict = overlayInterlock("stage2"); if (conflict) throw new Error(conflict);
}
