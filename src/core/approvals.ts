import { escalationEnabled } from "./config.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { configProtection, overlapsPart, pathOverlaps, relayInstallation, relayPathDirs, relayCodexProtected } from "./protected-config.js";
import { keyAuthority } from "./api-keys.js";
import { RAW_NETWORK_CONSENT_TEXT } from "./raw-network.js";
import { approvalKey, askableReadOnly, pathAccessOf, type ApprovalAnswer, type ApprovalAsk } from "../backends/types.js";
import { isTarget, targetDef, targetLabel } from "../targets/index.js";
import { managedSettings } from "./claude-settings.js";
import { consentEffect, extensionsOf, personOnly, touchesConfig } from "./extensions.js";
import { consultHome, foldedPath, inside, insideAnyCase, relayHome, worktreesHome } from "./config.js";
import { ancestors, db, getNode, getRun, getTurn, newId, nextQueuedTurn, now, runConfig, sleep, tx, turnEnded, workCwd, type NodeRow } from "./db.js";
import { processGone, procStart } from "./procs.js";
import { sessionParams } from "./params.js";
import { lendSlot } from "./slots.js";
import { registryPoll } from "./wake.js";
import { appendLog } from "./storage.js";
import { redactor } from "./secrets.js";
import { assertNeverCurrent, checkpointNever, readNeverFloor } from "./never-checkpoint.js";
import { neverFloorApplies } from "./never-coverage.js";
import { neverHostedWebDisabled, neverPathProblem, type NeverPolicy } from "./never-policy.js";
import { authenticateEscalationDecision, escalationDetail, escalationRequestProblem, type DecisionAuthentication } from "./escalation-authority.js";
import { escalationEffect } from "./escalation-policy.js";
import { allowOverlayInTransaction, getOverlay, settleOverlayRequestInTransaction } from "./restart-overlay.js";
import { roomOwnerExposed } from "./room-policy.js";
import { ROOM_REFUSALS } from "./room-types.js";

// Environment-consent notes use the owning root turn's literal redactor while its in-memory
// claim exists. No values or redaction hashes enter the request row, including through confirm.
const environmentRequestRedactors = new Map<string, (text: string) => string>();

/** Commands remain OS-confined: argument scanning is never execution enforcement. */
export function neverApprovalProblem(policy: NeverPolicy, kind: string, paths: readonly string[], cwd: string, access?: string): string | null {
  if (kind === "raw_network" && policy.hosts.length) return "never.hosts disables raw network in Release A; request a qualified mediated route";
  if (kind === "web" && neverHostedWebDisabled(policy)) return "never.hosts withholds hosted search and web__run, including open-page; person consent cannot screen provider effects";
  if (kind !== "file" && kind !== "path") return null;
  if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== "string" || !p || /[\0\r\n]/.test(p))) return "never cannot screen a file request without explicit literal paths";
  for (const name of paths) {
    const why = neverPathProblem(policy, path.resolve(cwd, name), kind === "file" || access !== "read" ? "write" : "read", true);
    if (why) return why;
  }
  return null;
}

export interface RequestRow {
  id: string;
  run_id: string;
  node_id: string;
  /** The turn that asked. A request is only ever answered within that turn; rows from before it was recorded have none. */
  turn_id: number | null;
  kind: string;
  summary: string;
  reason: string | null;
  detail_json: string | null;
  status: "pending" | "allowed" | "denied" | "expired";
  decided_by: string | null;
  note: string | null;
  scope: string | null;
  created_at: number;
  decided_at: number | null;
}

export function getRequest(id: string): RequestRow | undefined {
  return db().prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;
}

/**
 * Whether the request `current` is still the pending request `shown` was: same identity and the
 * same wording the person was shown. `relay approve` re-reads the request after the person types
 * the code and refuses unless this holds, so a change while they were asked cannot allow something
 * other than what was displayed.
 */
export function requestUnchanged(
  shown: Pick<RequestRow, "summary" | "kind" | "node_id"> & Partial<Pick<RequestRow, "detail_json" | "run_id" | "turn_id">>,
  current: (Pick<RequestRow, "status" | "summary" | "kind" | "node_id"> & Partial<Pick<RequestRow, "detail_json" | "run_id" | "turn_id">>) | undefined,
): boolean {
  return !!current && current.status === "pending"
    && current.summary === shown.summary && current.kind === shown.kind && current.node_id === shown.node_id
    && current.detail_json === shown.detail_json && current.run_id === shown.run_id && current.turn_id === shown.turn_id;
}
export function pendingRequests(runId?: string): RequestRow[] {
  return (runId
    ? db().prepare("SELECT * FROM requests WHERE run_id = ? AND status = 'pending' ORDER BY created_at").all(runId)
    : db().prepare("SELECT * FROM requests WHERE status = 'pending' ORDER BY created_at").all()) as unknown as RequestRow[];
}
/** Pending requests in every run the root session holding this token owns, oldest first. */
export function ownedPending(token: string): RequestRow[] {
  return db().prepare(
    "SELECT r.* FROM requests r JOIN runs u ON u.id = r.run_id WHERE u.root_token = ? AND r.status = 'pending' ORDER BY r.created_at",
  ).all(token) as unknown as RequestRow[];
}
export const hasPending = (nodeId: string) =>
  Boolean(db().prepare("SELECT 1 FROM requests WHERE node_id = ? AND status = 'pending' LIMIT 1").get(nodeId));

function detailOf(r: Pick<RequestRow, "detail_json">): { cwd?: unknown; access?: unknown; sandboxed?: unknown; confined?: unknown; adds_to_sandbox?: unknown; escalates_restricted?: unknown; once_only?: unknown; never_hash?: unknown; never_version?: unknown; never_removed?: unknown } {
  try {
    return JSON.parse(r.detail_json ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
function detailCwd(r: RequestRow): string | undefined {
  const cwd = detailOf(r).cwd;
  return typeof cwd === "string" ? cwd : undefined;
}

/**
 * What allowing a request would actually let the agent do, in plain words. A command that asked
 * while staying in its sandbox goes ahead sandboxed; so does a Codex command that asked for access
 * added to its sandbox for it alone (`adds`: codex-app.ts commandAsk), with that added, which its
 * request (wants) names. A plain Codex request to leave the sandbox (`restricted`: codex-app.ts
 * commandAsk) runs in a sandbox that can write everywhere but the denied credential stores. Anything
 * else is taken to run unconfined.
 */
function effectOf(kind: string, mode: string | undefined, sandboxed: boolean, n: NodeRow | undefined, adds = false, restricted?: unknown): string {
  const readOnly = mode === "read" ? " (the session is otherwise read-only, and this command could change files)" : "";
  if (kind === "command" && sandboxed) return "runs this one command inside its sandbox, with the same limits as its other commands";
  if (kind === "command" && restricted) return `${codexEscalatedEffect(restricted)}${readOnly}`;
  if (kind === "command" && adds) return "runs this one command inside its sandbox, with the same limits as its other commands except for the access its request asks to add (in wants), for this command alone";
  if (kind === "command") return `runs this one command outside the sandbox, with your full access${readOnly}`;
  if (kind === "web") return "reaches the web for this search or fetch";
  // Where its sandbox does not let it write: outside the writable places, or (Codex, whose profile
  // keeps them read-only) configuration your agents or tools load, or an existing .git, at the top
  // of the worktree or a grant.
  if (kind === "file") return "changes these files outside its sandbox: outside its worktree and granted directories, or, at their top, configuration your agents or tools load (.claude/, .mcp.json and the like) or git metadata (an existing .git)";
  // What the session was given decides what consenting does: skills alone change none of its limits.
  if (kind === "extensions") return consentEffect(n ?? { kind: "job" }, extensionsOf(n));
  if (kind === "local_network") return LOCAL_NETWORK_EFFECT;
  if (kind === "raw_network") return RAW_NETWORK_CONSENT_TEXT;
  if (kind === "env") return "gives all tools and native subagents in this one turn the named environment values. They can read, copy and use them. Network-off still permits disclosure through model requests, results and permitted native web tools. This does not grant network, file or extension access; a resume needs fresh consent";
  if (kind === "mcp") {
    return `runs this tool of an MCP server you allowed, outside the agent's sandbox, as your own process, with exactly these arguments (allowed for the rest of the ${n?.kind === "thread" ? "thread" : "job"}: this tool, with any arguments)`;
  }
  return "uses a tool that needs permission";
}

/**
 * What allowing a Codex command to run outside its sandbox does since relay 1.0.5 (codex-app.ts
 * commandAsk, codex.ts deniedCredentials): Codex keeps it in a sandbox that writes everywhere but
 * the credential stores relay's profile denies, with the job's own network.
 */
export function codexEscalatedEffect(network: unknown): string {
  // The job's network, as its turn has it (codex-app.ts commandAsk escalates_restricted): none (no
  // grant, or hosted search only), strict through Codex's proxy, or local.
  const net = network === "strict" ? "and the job's network only through Codex's proxy (no loopback or local network)"
    : network === "local" ? "and the job's network with this Mac's loopback and the local network open, directly as well as through Codex's proxy"
    : network === "none" ? "and no network (the job's shell has none)"
    : "and the job's own network";
  return `runs this one command with write access anywhere you can write, outside its worktree too, but still unable to read or write the credential stores relay denies (~/.ssh, ~/.aws, ~/.gnupg, ~/.netrc, Codex's login), ${net}. This is not full access, but writing anywhere in your home directory (LaunchAgents, shell startup files, other repositories, relay's own state) still acts with your authority`;
}

/** What consenting to a Codex job's local network does (grant.local_network; session.ts localNetworkConsent). */
export const LOCAL_NETWORK_EFFECT = "lets this job's shell reach every service listening on this Mac's loopback and on the local network (LAN), sshd and screen sharing included, with your account's reach, loopback directly as well as through Codex's network proxy; and lets it listen on every interface, so devices on your local network or tailnet can connect to servers it starts; for the rest of the job. Without it the job keeps internet access through the proxy, and nothing local";

/**
 * What allowing a harness's own check of a path does (kind "path", Copilot's "Access paths outside
 * trusted directories"): the agent goes on with what it asked for, reading or writing there as far
 * as relay can tell, and relay's sandbox, unchanged, decides whether that succeeds. Reads are broad
 * in that sandbox (src/confine/seatbelt.ts), so an allowed read outside relay's own places happens,
 * and the effect says so plainly (review r_a74ec0a8 C1); writes stay where the turn may write. The
 * path itself is the request's `wants` and its `in_directory` (the directory holding them all, for several).
 */
function pathEffect(detail: Record<string, unknown>, n: NodeRow | undefined): string {
  const access = pathAccessOf({ detail });
  const name = n?.target && isTarget(n.target) ? targetDef(n.target).name : "the agent";
  const reads = "relay's sandbox allows reads everywhere except relay's own directories, its config and install files, and its API key files, so the read succeeds anywhere else";
  const writes = "a write outside the job's worktree, its granted directories and its temporary directory still fails";
  if (access === "read") return `lets ${name} proceed to read the path it names; ${reads}, and allowing this does not widen the sandbox`;
  if (access === "write") return `lets ${name} proceed to write the path it names; relay's sandbox still decides what it can touch, and allowing this does not widen it: ${writes}`;
  return `lets ${name} proceed to read or write the path it names (relay cannot tell which, and takes it as writing); ${reads}, ${writes}, and allowing this does not widen the sandbox`;
}

/**
 * Whether a request can be allowed for this one action only, never for the rest of the job:
 * environment consent (this turn only), and a Codex command asking for access added to its sandbox
 * (codex-app.ts commandAsk).
 */
export function onceOnly(r: Pick<RequestRow, "kind" | "detail_json">): boolean {
  return r.kind === "env" || r.kind === "escalation" || detailOf(r).once_only === true;
}

/** Whether the request comes from an agent inside relay's own sandbox, where allowing it lifts nothing. */
export function insideRelaySandbox(r: RequestRow): boolean {
  return detailOf(r).confined === true;
}

/**
 * Whether a command that asked while in its sandbox would stay there if allowed: only under relay's
 * own settings, and only where no organisation-managed Claude Code settings were found. With the
 * user's settings loaded (child_settings "inherit"), or managed ones (which outrank relay's), their
 * sandbox exclusions could let it run outside.
 */
export function staysSandboxed(askedSandboxed: unknown, childSettings: string, managed: string | null): boolean {
  return askedSandboxed === true && childSettings === "isolated" && managed === null;
}

/**
 * What a Claude agent is told when relay refuses its command request under the never floor
 * (requestApproval): Claude command approvals are not available there at all, whatever the request
 * says about its sandbox.
 */
export const CLAUDE_COMMAND_REFUSAL = "never: Claude command approvals are unavailable under the never floor, so this request was refused and nobody was asked. " +
  "Continue with the work your sandbox permits, report what you needed (under Open issues, or in your final message), or have the root session or the person arrange the work another supported way.";

export function requestView(r: RequestRow): Record<string, unknown> {
  const n = getNode(r.node_id);
  const detail = detailOf(r);
  // The access of the turn that asked, which can be narrower than the session's.
  const access = typeof detail.access === "string" ? detail.access : n?.mode;
  const sandboxed = Boolean(n) && staysSandboxed(detail.sandboxed, runConfig(n!.run_id).child_settings, managedSettings());
  // An agent inside relay's own sandbox asks for something within it: allowing it lifts nothing.
  const escalation = r.kind === "escalation" ? escalationDetail(r.detail_json) : null;
  const effect = escalation ? escalationEffect(escalation.escalation)
    : r.kind === "env" ? `${effectOf(r.kind, access, sandboxed, n)}. Execution and standing passes (names only): ${JSON.stringify(detail)}`
    : r.kind === "path" ? pathEffect(detail, n)
    : insideRelaySandbox(r) ? "lets it go ahead inside relay's sandbox, which stays on whatever you decide" : effectOf(r.kind, access, sandboxed, n, detail.adds_to_sandbox === true, detail.escalates_restricted || undefined);
  return {
    request_id: r.id, from: r.node_id, agent: n?.target, depth: n?.depth, session: access, task: r.kind === "env" ? "see the caller-supplied purpose in wants (untrusted)" : n?.task.replace(/\s+/g, " ").slice(0, 100),
    ...(n?.target && !targetDef(n.target).qualified ? { agent_label: targetLabel(targetDef(n.target)) } : {}),
    wants: r.summary, in_directory: detailCwd(r) ?? (n ? workCwd(n) : undefined), kind: r.kind, effect, ...(r.reason ? { reason: r.reason } : {}),
    // Only the person may allow it (docs/extensions.md); the root agent may deny it.
    ...(personOnly(r) ? { person_only: true } : {}),
    ...(r.kind !== "env" && onceOnly(r) ? { once_only: r.kind === "escalation" ? "one replacement turn only; never a standing grant" : "allowed for this one command only, never for the rest of the job" } : {}),
    waiting_s: Math.round((now() - r.created_at) / 1000),
    ...(r.kind === "env" ? { environment: detail } : {}),
    ...(escalation ? { required_decider: escalation.escalation.required_decider, request_digest: escalation.request_digest, escalation: escalation.escalation, ...(escalation.decision ? { decision_provenance: escalation.decision } : {}) } : {}),
    ...(detail.never_hash ? { never_policy: { hash: detail.never_hash, version: detail.never_version, removed_builtins: detail.never_removed ?? [] } } : {}),
  };
}

/**
 * True once a job's web searches and fetches need not ask: it was granted the network up front,
 * or a web request of its was allowed for the rest of the job. That approval covers the web tools
 * only (WebSearch, WebFetch), never the sandbox's network for shell commands.
 */
export function webGranted(nodeId: string): boolean {
  const n = getNode(nodeId);
  if (!n) return false;
  if (sessionParams(n).grant?.network) return true;
  // Not for an agent in relay's own sandbox, for which relay holds each approval for the same request only (heldForJob).
  if (n.target && isTarget(n.target) && !targetDef(n.target).capabilities.escalation) return false;
  return Boolean(db().prepare("SELECT 1 FROM requests WHERE node_id = ? AND kind = 'web' AND status = 'allowed' AND scope = 'job' LIMIT 1").get(nodeId));
}

/**
 * Why the turn that asked can no longer be answered, or null while it is live: the turn is running,
 * so is its session, and neither the run nor anything above the session has been cancelled. Read
 * inside the transaction that files a request or applies a decision, so that nothing is filed or
 * allowed for a turn that has ended.
 */
export function turnGone(nodeId: string, turnId: number | null): string | null {
  if (turnId === null) return "the request does not record which turn asked";
  const ended = turnEnded(nodeId, turnId);
  if (ended) return ended;
  return cancelledOver(getNode(nodeId)!);
}
function cancelledOver(n: NodeRow): string | null {
  if (getRun(n.run_id)?.status === "cancelled") return "its run has been cancelled";
  if (ancestors(n, { self: true }).some((a) => a.status === "cancelled")) return "its work has been cancelled";
  return null;
}

/**
 * As turnGone, for a turn whose environment is being claimed (W9), which is live while it is still
 * queued too: its worker claims the environment, with the person's consent to a one-turn request,
 * as it picks the turn up, before the turn waits for a concurrency slot. A queued turn is live only
 * while it is its session's next turn and the session is queued for it, as its worker leaves it.
 */
export function claimGone(nodeId: string, turnId: number | null): string | null {
  if (turnId === null) return "the request does not record which turn asked";
  const t = getTurn(turnId);
  if (t?.node_id !== nodeId || t.status !== "queued") return turnGone(nodeId, turnId);
  const n = getNode(nodeId);
  if (n?.status !== "queued") return `turn ${turnId} of ${nodeId} is not about to start (its session is ${n?.status ?? "gone"})`;
  if (nextQueuedTurn(nodeId)?.id !== turnId) return `turn ${turnId} of ${nodeId} is not its session's next turn`;
  return cancelledOver(n);
}
/** The liveness a request of this kind needs: an environment claim's turn may still be queued (claimGone). */
const goneFor = (kind: string) => (kind === "env" ? claimGone : turnGone);

/**
 * Why a file request touches what no job may change, or null: relay's control directory, its
 * config files, its install record and backups (protected-config.ts, as the sandboxes protect
 * them), another job's worktree, and what decides which API key relay hands a key-only target.
 * The same places for a harness's own check of a path (`what` "reach"), which nobody is asked
 * about, and for it also any directory holding relay's control directory or the worktrees' directory.
 */
/**
 * Whether `p` is in the consult directory of the thread asking (caller.ts newConsultDir), not in the
 * parent all of them share. It lets a path in, so compared exactly (inside, not insideAnyCase): on a
 * disk that tells case apart, a sibling named in another case is not the thread's own.
 */
function ownConsult(node: Pick<NodeRow, "cwd" | "worktree">, p: string): boolean {
  const cwd = workCwd(node);
  return insideAnyCase(cwd, consultHome()) && foldedPath(cwd) !== foldedPath(consultHome()) && inside(p, cwd);
}

export function offLimits(node: Pick<NodeRow, "cwd" | "worktree"> & Partial<Pick<NodeRow, "run_id">>, paths: string[], what: "change" | "reach" = "change"): string | null {
  const which = what === "change" ? "no job may change" : "no approval lets a job reach";
  const own = node.worktree;
  const installed = configProtection().paths;
  const codex = relayCodexProtected(node.run_id ? runConfig(node.run_id) : undefined);
  for (const p of paths.map((x) => path.resolve(workCwd(node), x))) {
    const protectedCodex = [...codex.homes, ...codex.stores].find((x) => overlapsPart(p, x.path));
    if (protectedCodex) return `${p} overlaps ${protectedCodex.what} (${protectedCodex.path}), which ${which}`;
    const config = touchesConfig(p);
    if (config) return `${p} ${foldedPath(p) === foldedPath(config) ? "is" : "holds"} relay's own config file ${config}, which ${which}`;
    const record = installed.find((c) => pathOverlaps(p, c) || insideAnyCase(p, c) || insideAnyCase(c, p));
    if (record) return `${p} overlaps relay's config or install files (${record}), which ${which}`;
    // What relay runs outside every sandbox (caller.ts grantPathProblem, review r_0c11d860 X1): never
    // a job's to change. Reading it stays possible: a read job may look at relay's own code.
    const part = what === "change" ? relayInstallation().find((x) => overlapsPart(p, x.path)) : undefined;
    if (part) return `${p} overlaps ${part.what} (${part.path}), which relay runs outside any sandbox, and which ${which}`;
    // Nor a directory on relay's PATH, or anything in one: a program put there would be run outside any sandbox.
    const onPath = what === "change" ? relayPathDirs().find((d) => insideAnyCase(p, d) || insideAnyCase(d, p)) : undefined;
    if (onPath) return `${p} is on or holds ${onPath}, a directory on relay's PATH, where a program put there would be run outside any sandbox, and which ${which}`;
    // The consults' directories too, but for the asking thread's own: what is changed there is where
    // a later consult of any conversation could look (review r_f1c46bd4 X2).
    if (insideAnyCase(p, relayHome()) || (insideAnyCase(p, consultHome()) && !ownConsult(node, p)) || (insideAnyCase(p, worktreesHome()) && !(own && insideAnyCase(p, own)))) return `${p} is inside relay's own directories, which ${which}`;
    // A path check reaches what lies below the path too: a directory holding relay's control
    // directory or the worktrees' directory (and so other jobs' worktrees) is refused as they are
    // (review r_a74ec0a8 C2). The config, install and key checks look both ways already.
    const holds = what === "reach" ? [relayHome(), worktreesHome(), consultHome()].find((d) => insideAnyCase(d, p)) : undefined;
    if (holds) return `${p} holds relay's own directories (${holds}), which ${which}`;
  }
  // Nor what decides which API key relay hands a key-only target (core/api-keys.ts keyAuthority),
  // as no grant may cover it; and while relay cannot tell where that is, nothing outside the job's own.
  const asked = paths.map((x) => path.resolve(workCwd(node), x));
  const keys = keyAuthority();
  for (const p of asked) {
    const key = keys.dirs.find(([, d]) => pathOverlaps(p, d) || insideAnyCase(p, d) || insideAnyCase(d, p));
    if (key) return `${p} overlaps ${key[0]} (${key[1]}), which ${which}`;
  }
  const outside = asked.find((p) => !(own && insideAnyCase(p, own)));
  if (keys.problem && outside) return `relay cannot load its local config, so it cannot tell which directories decide its API keys, and lets no ${what === "change" ? "job change" : "approval reach"} ${outside} until that is fixed: ${keys.problem}`;
  return null;
}

/**
 * Who decided a request, from what relay recorded in decided_by: the user in relay's approval
 * dialog ("user"), the user in the root session's permission prompt (confirm), the user from a
 * terminal, the root session (saying the user confirmed, or not), or someone relay has no words for.
 * Each place that says who decided words it from this (deciderForAgent here; events.ts for the root agent).
 */
export type Decider = "user-dialog" | "user-confirm" | "terminal" | "root" | "root-confirmed" | "other";
export function deciderOf(decidedBy: string | null): Decider {
  if (decidedBy === "user") return "user-dialog";
  if (decidedBy?.startsWith("user, through the host's permission prompt")) return "user-confirm";
  if (decidedBy === "terminal") return "terminal";
  if (decidedBy?.startsWith("root session")) return decidedBy.includes("confirmed") ? "root-confirmed" : "root";
  return "other";
}

const FOR_AGENT: Partial<Record<Decider, string>> = {
  "user-dialog": "by the user in relay's approval dialog",
  "user-confirm": "by the user, in the root session's permission prompt",
  terminal: "from a terminal (relay approve or relay deny)",
  root: "by the root session supervising this run, not by the user",
  "root-confirmed": "by the root session supervising this run, which says the user confirmed it",
};
/**
 * Who decided a request, in words for the agent that asked (relay's note to it). Codex tells its
 * agent that the user rejected or approved whoever decided, so relay says who did. Given the
 * decision, a terminal's is named by its command: an allow is relay approve's, a denial relay
 * deny's (relay approve allows no person-only request, so only relay deny can refuse one there).
 */
export const deciderForAgent = (decidedBy: string | null, allowed?: boolean): string | undefined =>
  deciderOf(decidedBy) === "terminal" && allowed !== undefined ? `from a terminal (${allowed ? "relay approve" : "relay deny"})` : FOR_AGENT[deciderOf(decidedBy)];

/**
 * Files an approval request for a launched agent and waits for the root session's decision.
 * The agent is blocked meanwhile, so its concurrency slot is lent. No answer within the timeout
 * counts as a denial.
 */
export async function requestApproval(
  nodeId: string, turnId: number, ask: ApprovalAsk, shouldAbort: () => boolean = () => false, onTick?: (elapsedMs: number) => void,
): Promise<ApprovalAnswer> {
  const node = getNode(nodeId);
  if (!node) return { allow: false, note: "unknown agent" };
  const cfg = runConfig(node.run_id);
  // Keep relay's established, person-facing reason for its own protected resources.
  // The cumulative never floor below additionally covers historical/configured resources.
  if (ask.kind === "file" || ask.kind === "path") {
    const off = offLimits(node, ask.paths ?? [], ask.kind === "path" ? "reach" : "change");
    if (off) return { allow: false, note: off };
  }
  let never: NeverPolicy;
  try {
    never = checkpointNever(node.run_id, "approval");
    // Every Claude command request is refused under the floor, one that would stay in its sandbox
    // (detail.sandboxed) as well as one asking to leave it, so the note claims neither, and offers
    // no restart overlay (those are Codex-only, restart-overlay.ts).
    if (node.target === "claude" && ask.kind === "command" && neverFloorApplies("claude", cfg)) return { allow: false, note: CLAUDE_COMMAND_REFUSAL };
    const why = neverApprovalProblem(never, ask.kind, ask.paths ?? [], workCwd(node), pathAccessOf(ask));
    if (why) return { allow: false, note: why };
  } catch (err) { return { allow: false, note: (err as Error).message }; }
  if (!escalationEnabled(cfg)) return { allow: false, note: "approval requests are turned off; report what you needed under Open issues" };
  // Only a job or consult in the middle of a turn can ask. This also stops an agent from parking
  // itself in a pending request to hold a slot or stall its own timeout. The exception is the owning
  // root's broker asking the person to release environment values to a turn its worker is picking
  // up, before the turn waits for a slot (claimGone): no agent runs then, and it holds no slot to lend.
  const turnOver = goneFor(ask.kind);
  const turn = getTurn(turnId);
  const started = turn?.status === "running" || (ask.kind === "env" && turn?.status === "queued");
  if (!turn || turn.node_id !== nodeId || !started) return { allow: false, note: "only an agent in the middle of a turn can ask for approval" };
  // A read-only session may ask to reach the web or to run a command, never to change files.
  // What decides is the turn's access, not the session's: a discussion turn on a write job's session is read-only.
  // Consent to extensions and a call of an extension's tool are not changes to files either; a
  // harness's own check of a path is asked only for a path it would read (askableReadOnly).
  if (turn.access === "read" && !askableReadOnly(ask)) return { allow: false, note: ask.kind === "path" ? `this turn is read-only, and ${pathAccessOf(ask) === "write" ? "the agent would write there" : "relay cannot tell that the agent would only read there"}` : "this turn is read-only" };
  // Relay's control directory and other jobs' worktrees are never a job's to change, so such a
  // request is refused here and nobody is asked. (An approved command is another matter: it runs
  // unconfined, which is why approving one means trusting it.)
  // Relay's own config files too, by either name of a linked one, and any directory holding one:
  // its config.json and mcp.json say what agents may be given and which servers run outside their
  // sandboxes; its install record and backups (DM8) too. On macOS a name in another case is the
  // same file (insideAnyCase).
  // A harness's own check of a path (kind "path") is refused for the same places, read or write:
  // allowing it would not open them (relay's sandbox decides), but nobody is asked about them.
  if (ask.kind === "file" || ask.kind === "path") {
    const off = offLimits(node, ask.paths ?? [], ask.kind === "path" ? "reach" : "change");
    if (off) return { allow: false, note: off };
  }
  // One request at a time per agent. An agent can issue several tool calls at once (parallel web
  // fetches, say); the later ones wait their turn, and are answered at once if an earlier
  // "rest of the job" approval has meanwhile covered them.
  // A request waiting its turn is filed only while the turn that asked is still live, checked in
  // the same transaction, so that nothing is filed after the turn has ended and been cleaned up;
  // and only while the call that asks is there: one cancelled, or whose connection has closed,
  // files nothing, also when the request ahead of it has closed meanwhile (review X1/C28, audit A9).
  const detail = ask.detail as { server?: unknown; tool?: unknown } | undefined;
  const covered = () => ask.kind === "web" ? webGranted(nodeId)
    : ask.kind === "mcp" && typeof detail?.server === "string" && typeof detail?.tool === "string"
      && mcpHeldForJob(nodeId, detail.server, detail.tool);
  const escalation = ask.kind === "escalation" ? escalationDetail(JSON.stringify(ask.detail)) : null;
  if (ask.kind === "escalation" && !escalation) return { allow: false, note: "missing canonical escalation request" };
  const id = escalation?.escalation.request_id ?? newId("request");
  const queuedAt = now();
  for (;;) {
    if (shouldAbort()) return { allow: false, note: "the call that asked was cancelled or its turn is over" };
    if (!hasPending(nodeId)) {
      try { never = checkpointNever(node.run_id, "approval"); }
      catch (err) { return { allow: false, note: (err as Error).message }; }
    }
    const filed = tx(() => {
      const gone = turnOver(nodeId, turnId);
      if (gone) return gone;
      // Another process may have grown the floor while this request waited in the queue.
      never = readNeverFloor(node.run_id) ?? never;
      const no = neverApprovalProblem(never, ask.kind, ask.paths ?? [], workCwd(node), pathAccessOf(ask));
      if (no) return no;
      if (escalation) {
        const why = escalationRequestProblem(escalation, { id, run_id: node.run_id, node_id: nodeId, turn_id: turnId, summary: ask.summary }, never);
        if (why) return why;
      }
      if (covered()) return "covered";
      if (hasPending(nodeId)) return false;
      db().prepare("INSERT INTO requests (id, run_id, node_id, turn_id, kind, summary, reason, detail_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
        .run(id, node.run_id, nodeId, turnId, ask.kind, ask.summary, ask.reason ?? null, JSON.stringify({ cwd: workCwd(node), access: turn.access, ...(ask.paths?.length ? { paths: ask.paths } : {}), ...((ask.detail as object | undefined) ?? {}), never_hash: never.hash, never_version: never.version, never_removed: never.removed }), now());
      return true;
    });
    if (filed === "covered") return { allow: true };
    if (filed === true) break;
    if (filed) return { allow: false, note: `the turn that asked is over (${filed})` };
    if (now() - queuedAt > cfg.approval_timeout_s * 1000) return { allow: false, note: "an earlier request from you was never answered" };
    await sleep(250);
  }
  if (cfg.desktop_notifications && process.platform === "darwin") {
    const text = `${node.target ? targetLabel(targetDef(node.target), node.target) : "agent"} ${nodeId} wants: ${ask.summary}`.replace(/\s+/g, " ").replace(/["\\]/g, "'").slice(0, 200);
    // relay approve refuses a person-only request (commandRefusal), so the notification does not offer it.
    const how = personOnly({ kind: ask.kind, node_id: nodeId, detail_json: getRequest(id)?.detail_json }) ? `only you can allow ${id}: relay's question, or confirm` : `relay approve ${id}`;
    try {
      spawn("/usr/bin/osascript", ["-e", `display notification "${text}" with title "relay: approval needed" subtitle "${how}"`], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // A missing notifier must not affect the request.
    }
  }
  const giveBack = lendSlot(nodeId);
  if (ask.kind === "env") environmentRequestRedactors.set(id, redactor());
  const start = now();
  const deadline = Math.min(start + cfg.approval_timeout_s * 1000, escalation?.escalation.approval_deadline_ms ?? Infinity);
  let lastTick = start;
  const poll = registryPoll();
  try {
    for (;;) {
      if (onTick && now() - lastTick >= 15000) {
        lastTick = now();
        onTick(now() - start);
      }
      const r = getRequest(id)!;
      // Cancellation/expiry must win even if an allow raced the call's disappearance.
      if (escalation && (shouldAbort() || now() >= deadline)) {
        db().prepare("UPDATE requests SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").run(now(), id);
        return { allow: false, note: "escalation call cancelled or approval deadline expired" };
      }
      if (r.status === "allowed") {
        try {
          const effective = checkpointNever(node.run_id, "approval");
          const why = neverApprovalProblem(effective, ask.kind, ask.paths ?? [], workCwd(node), pathAccessOf(ask));
          if (why) return { allow: false, note: why };
          if (effective.hash !== never.hash) return { allow: false, note: "never policy changed after the decision; ask again against the current floor" };
        } catch (err) { return { allow: false, note: (err as Error).message }; }
        return { allow: true, note: r.note ?? undefined, forJob: r.scope === "job", deciderNote: r.note ?? undefined, decider: deciderForAgent(r.decided_by, true) };
      }
      if (r.status === "denied") return { allow: false, note: r.note ?? "denied", deciderNote: r.note ?? undefined, decider: deciderForAgent(r.decided_by, false) };
      if (r.status === "expired") return { allow: false, note: "the request was closed without an answer" };
      // The turn is checked on every look, not only when the request was filed: once it has ended
      // nobody may answer for it, and the request is closed.
      const gone = shouldAbort() ? "the job was cancelled or its turn is over" : turnOver(nodeId, turnId);
      if (gone || now() > deadline) {
        db().prepare("UPDATE requests SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").run(now(), id);
        return { allow: false, note: gone ?? `nobody answered within ${cfg.approval_timeout_s}s` };
      }
      // The next look within 250 ms. A decision is recorded by another process (the root's server, a
      // terminal), whose commit to the registry brings a quick look at the request alone; once it is
      // no longer pending, the full look above takes it at once.
      const next = now() + 250;
      while (await poll.nap(next - now())) if (getRequest(id)?.status !== "pending") break;
    }
  } finally {
    environmentRequestRedactors.delete(id);
    giveBack();
  }
}

/**
 * Whether the root allowed this same request (approvalKey: kind, command, directory, files) for the
 * rest of the job, earlier in this job. For agents with no job-scoped approval of their own, whose
 * every later matching request relay then answers itself, allow-once.
 */
export function heldForJob(nodeId: string, ask: ApprovalAsk): boolean {
  const node = getNode(nodeId);
  if (!node) return false;
  try {
    const never = checkpointNever(node.run_id, "approval");
    if (neverApprovalProblem(never, ask.kind, ask.paths ?? [], workCwd(node), pathAccessOf(ask))) return false;
  } catch { return false; }
  const want = approvalKey(ask, workCwd(node));
  const rows = db().prepare("SELECT summary, detail_json FROM requests WHERE node_id = ? AND status = 'allowed' AND scope = 'job' AND kind = ?")
    .all(nodeId, ask.kind) as { summary: string; detail_json: string | null }[];
  return rows.some((r) => {
    try {
      const detail = JSON.parse(r.detail_json ?? "{}") as { paths?: string[] };
      return approvalKey({ kind: ask.kind, summary: r.summary, paths: detail.paths, detail }, workCwd(node)) === want;
    } catch {
      return false;
    }
  });
}

/**
 * Whether the person allowed a call of this tool of this extension server for the rest of the job,
 * earlier in it: then later calls of the same tool go ahead without asking, whatever their
 * arguments (the effect the person was shown says so).
 */
export function mcpHeldForJob(nodeId: string, server: string, tool: string): boolean {
  const rows = db().prepare("SELECT detail_json FROM requests WHERE node_id = ? AND kind = 'mcp' AND status = 'allowed' AND scope = 'job'").all(nodeId) as { detail_json: string | null }[];
  return rows.some((r) => {
    try {
      const d = JSON.parse(r.detail_json ?? "{}") as { server?: unknown; tool?: unknown };
      return d.server === server && d.tool === tool;
    } catch {
      return false;
    }
  });
}

/** Closes requests nobody can act on any more: the asking turn has ended or its job is no longer running. */
export function expireRequests(nodeId: string): void {
  db().prepare("UPDATE requests SET status = 'expired', decided_at = ? WHERE node_id = ? AND status = 'pending'").run(now(), nodeId);
}

/** Trusted context from ops.approve, never inferred from the free-text audit label. */
export interface ModelApprovalContext { ownerHash: string; userConfirmed: boolean }

/** Room exposure changes only the model's claimed confirmation, not its ordinary judgments. */
export function modelApprovalPolicy(id: string, context: ModelApprovalContext): { confirmed: boolean; refusal: string | null } {
  const exposed = roomOwnerExposed(context.ownerHash);
  const confirmed = context.userConfirmed && !exposed;
  const state = elicitationState(id);
  const refusal = !confirmed && (state === "asking" || state === "dismissed")
    ? exposed ? ROOM_REFUSALS.user_confirmed
      : "Refused: " + (state === "asking" ? "the user is being asked about this request directly right now" : "the user was shown this request and closed it without answering") +
        ", so you cannot allow it on your own judgment. Ask them in conversation; if they tell you to allow it, call approve again with user_confirmed: true. You may deny it without asking."
    : null;
  return { confirmed, refusal };
}

export function decide(id: string, allow: boolean, by: string, note?: string, scope: "once" | "job" = "once", authentication?: DecisionAuthentication, modelApproval?: ModelApprovalContext): Record<string, unknown> {
  // Persist additions independently: a rejected/stale decision must never roll back the floor.
  let never: NeverPolicy | undefined;
  if (allow) {
    const pending = getRequest(id);
    if (pending) {
      try { never = checkpointNever(pending.run_id, "decision"); }
      catch (err) { return { error: (err as Error).message }; }
    }
  }
  // Claiming the pending request and applying what follows from it happen together. A decision
  // that loses the race to another one changes nothing and says so.
  return tx(() => {
    const r = getRequest(id);
    if (!r) return { error: `unknown request ${id}` };
    if (r.status !== "pending") return { error: `request ${id} is already ${r.status}` };
    if (modelApproval) {
      // The same writer lock serializes this recheck with exposure recorded before room delivery.
      const policy = modelApprovalPolicy(id, modelApproval);
      if (allow && policy.refusal) return { refused: true, reason: policy.refusal };
      by = policy.confirmed ? "root session, stating that the user confirmed" : "root session";
    }
    const escalation = r.kind === "escalation" ? escalationDetail(r.detail_json) : null;
    if (r.kind === "escalation") {
      if (!escalation) return { error: "missing canonical escalation request" };
      const problem = escalationRequestProblem(escalation, r, allow ? never : undefined)
        ?? authenticateEscalationDecision(escalation, authentication, allow);
      if (problem) return { error: problem };
      if (scope !== "once") return { error: "escalation consent covers one replacement turn only; it cannot create a standing grant" };
    }
    if (allow && never) {
      try { assertNeverCurrent(r.run_id, never.hash); }
      catch (err) { return { error: (err as Error).message }; }
      const detail = JSON.parse(r.detail_json ?? "{}");
      const node = getNode(r.node_id);
      const why = neverApprovalProblem(never, r.kind, detail.paths ?? [], node ? workCwd(node) : detail.cwd, detail.path_access);
      if (why) return { error: why };
      if (detail.never_hash && detail.never_hash !== never.hash) {
        db().prepare("UPDATE requests SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").run(now(), id);
        return { error: `request ${id} has a stale never policy hash; nothing was allowed. Ask again against the current cumulative floor.` };
      }
    }
    if (allow && personOnly(r) && !["user-dialog", "user-confirm"].includes(deciderOf(by))) return { error: "only the user through a qualified dialog or confirm can allow this person-only request" };
    if (scope !== "once" && onceOnly(r)) return { error: r.kind === "env" ? "environment consent covers this turn only" : `request ${id} can be allowed for this one command only: a Codex command asking for access added to its sandbox is never allowed for the rest of the job. Nothing was decided; allow it once or deny it.` };
    // Only the turn that asked can be answered. A request left pending after it ended (filed in
    // the moment before cleanup, or by a handler that outlived its connection) is closed, and
    // nothing follows from it: a "rest of the job" approval must not reach the job's later turns.
    const gone = goneFor(r.kind)(r.node_id, r.turn_id);
    if (gone) {
      db().prepare("UPDATE requests SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").run(now(), id);
      return { error: `request ${id} can no longer be decided: ${gone}. Nothing was allowed; the agent can ask again in a later turn.` };
    }
    const at = now();
    const savedNote = note === undefined ? null : (environmentRequestRedactors.get(id)?.(note) ?? (escalation ? redactor()(note) : note));
    if (escalation?.overlay) {
      const b = escalation.overlay;
      const overlay = getOverlay(r.run_id, b.id);
      if (overlay.request.escalation?.requestId !== id || overlay.request.escalation.digest !== escalation.request_digest) throw new Error("overlay approval binding changed");
      const decision = { decisionId: id, decidedBy: authentication!.route === "owning-run-root" ? escalation.escalation.root.session_identity : by,
        route: authentication!.route === "owning-run-root" ? "supervisor" as const : "person" as const, at, ...(savedNote === null ? {} : { note: savedNote }) };
      if (allow) allowOverlayInTransaction(r.run_id, b.id, b.digest, decision);
      else settleOverlayRequestInTransaction(r.run_id, b.id, b.digest, "denied", decision);
    }
    const claimed = db().prepare("UPDATE requests SET status = ?, decided_by = ?, note = ?, scope = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(allow ? "allowed" : "denied", by, savedNote, allow ? scope : null, at, id);
    if (Number(claimed.changes) !== 1) return { error: `request ${id} was decided by someone else at the same moment` };
    if (escalation) {
      // Actual authenticated route, not the free-text by label. One transaction owns both.
      escalation.decision = { route: authentication!.route, root: escalation.escalation.root, decided_by: by, at, note: savedNote, request_digest: escalation.request_digest };
      db().prepare("UPDATE requests SET detail_json = ? WHERE id = ?").run(JSON.stringify(escalation), id);
    }
    // "For the rest of the job" on a web request is held here, in the request's scope: the job's
    // later web searches and fetches are allowed without asking (webGranted), and its grant is not
    // widened, so its shell commands get no network from it. An agent in relay's own sandbox has
    // relay answer each later request that is the same instead (heldForJob).
    return { request_id: id, decision: allow ? "allowed" : "denied", decided_by: by, ...(allow && scope === "job" ? { scope: "rest of the job" } : {}), from: r.node_id, wants: r.summary };
  });
}

// Asking the user directly. A root session's relay server puts each pending request in its runs
// to the user through the host as soon as it is filed. One row per request records who asked and
// how it ended, so that the same question is not put twice, by this server or by one started after it.

interface ElicitationRow {
  request_id: string; token: string; pid: number; pid_start: string | null; asked_at: number;
  outcome: string | null; reading: "decided" | "dismissed" | "unattributed" | "error" | "withdrawn" | null; ended_at: number | null;
}
const elicitation = (requestId: string) => db().prepare("SELECT * FROM elicitations WHERE request_id = ?").get(requestId) as ElicitationRow | undefined;

/**
 * Takes the right to put a request to the user, for the relay server holding `token`. Refused when
 * the user already answered or closed the question, or a live server is asking now. A question
 * left open by a server that has gone, or one that failed or was withdrawn under another server,
 * may be asked again.
 */
export function claimElicitation(requestId: string, token: string): boolean {
  return tx(() => {
    const row = elicitation(requestId);
    const mine = () => db().prepare("INSERT OR REPLACE INTO elicitations (request_id, token, pid, pid_start, asked_at) VALUES (?, ?, ?, ?, ?)")
      .run(requestId, token, process.pid, procStart(process.pid), now());
    if (!row) {
      mine();
      return true;
    }
    if (row.token === token) return false;
    // Abandoned only when its asker is known to be gone: a server ps cannot vouch for at the
    // moment (a fork refused on a loaded machine) may still have the question on screen.
    const abandoned = row.outcome === null && processGone(row.pid, row.pid_start);
    if (abandoned || row.reading === "error" || row.reading === "withdrawn") {
      mine();
      return true;
    }
    return false;
  });
}

export function endElicitation(requestId: string, token: string, outcome: string, reading: NonNullable<ElicitationRow["reading"]>): void {
  db().prepare("UPDATE elicitations SET outcome = ?, reading = ?, ended_at = ? WHERE request_id = ? AND token = ?").run(outcome, reading, now(), requestId, token);
}

/**
 * "asking": the question is on the user's screen now. "dismissed": they closed it without
 * answering (only where that is known to be a person: Esc in interactive Claude Code).
 * "unattributed": the host answered with something that decides nothing and that relay cannot
 * attribute to a person (a Codex decline or cancel, an answer that does not fit the form); `host`
 * is what it answered.
 */
export function elicitationState(requestId: string): "asking" | "dismissed" | { unattributed: string } | null {
  const row = elicitation(requestId);
  if (!row) return null;
  // Still asking unless its asker is known to be gone, as for claimElicitation: otherwise a
  // moment's failed ps would hand the agent a request the user is being asked about, unmarked.
  if (row.outcome === null) return processGone(row.pid, row.pid_start) ? null : "asking";
  if (row.reading === "unattributed") return { unattributed: row.outcome };
  return row.reading === "dismissed" ? "dismissed" : null;
}

/** Kept for diagnosis in the control directory: what each host answered, how fast, and how relay read it. */
export function logElicitation(entry: Record<string, unknown>): void {
  // Diagnostics only: a failed write is not the request's failure. Rotated at log_max_mb.
  appendLog(path.join(relayHome(), "elicitation.log"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}
