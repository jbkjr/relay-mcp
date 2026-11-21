// The 1.0 seam: request evidence and contribution identity, resolved once before dispatch.
// It deliberately does not turn a host conversation key into authority or durable membership.
import crypto from "node:crypto";
import { callerLabel, type Contribution } from "./families.js";
import { familyOf, SINGLETON_REASON, type Instance } from "./caller.js";
import type { RoomIdentityEvidence } from "./room-types.js";

export type Topology = "dedicated" | "shared" | "unknown";
export const SHARED_REASON = "Desktop chats in the main window share one relay process. Cowork, the Code tab's in-app bridge, remote Cowork and widgets share a second. Within each process every conversation carries its own session token, which keeps its jobs, approval requests and events apart from the others'. Code-tab sessions also have their own dedicated relay registration.";
/** A conversation's scope on a shared process (session-token.ts). */
export const TOKEN_REASON = "This relay process is shared by several conversations (desktop chats share one; Cowork, the Code tab's in-app bridge, remote Cowork and widgets share another). Relay keeps this conversation's jobs, approval requests and events apart by the session token it carries. The token is a bearer key: it separates conversations that use relay honestly, and anyone who sees it can act as this conversation.";
/** An OpenCode 2 process, before a call names its session. */
export const HOST_PROCESS_REASON = "OpenCode serves the sessions of its background service from one relay process, and puts each call's session on it. Relay keeps each session's jobs, approval requests and events apart by that session ID; a call that carries none does nothing.";
/** A session's scope on an OpenCode 2 process. */
export const HOST_KEY_REASON = "This relay process serves several OpenCode sessions (subagent sessions are sessions of their own). Relay keeps this session's jobs, approval requests and events apart by the session ID OpenCode puts on each call. That separates sessions OpenCode stamps faithfully; it is not authentication. The scope lasts as long as this relay process: after OpenCode restarts it, earlier work is recovered with relay adopt from a terminal.";
export interface SessionDiagnostic {
  scope: "dedicated-process" | "shared-process" | "unqualified-process" | "child-run" | "conversation-token" | "host-session";
  source: "native-registration" | "desktop-entry" | "client-profile" | "child-context" | "session-token" | "host-key" | "none";
  topology: Topology;
  reason: string;
  fingerprint: string;
}
export interface CallerSnapshot {
  call_id: string;
  harness: string | null;
  version: string | null;
  protocol: string;
  session: Omit<SessionDiagnostic, "fingerprint" | "reason"> & {
    reason_code: SessionDiagnostic["scope"] | "singleton-violation";
    evidence: readonly string[];
    assurance: "injected-context" | "dedicated-process-assumption" | "relay-capability" | "host-correlation" | "shared-authority" | "unqualified";
  };
  model: string | null;
  family_label: Contribution["label"];
  routing_family: ReturnType<typeof familyOf>;
  subagent: boolean;
  parent: string | null;
}
export interface CallIdentity {
  readonly snapshot: CallerSnapshot;
  readonly contribution: Contribution;
  readonly session: SessionDiagnostic;
  readonly codexSubagent: boolean;
  /** Validated per-call room evidence; deliberately excluded from the persisted snapshot. */
  readonly codex: RoomIdentityEvidence["codex"];
  readonly hostModel?: string;
}
export const fingerprint = (inst: Instance): string => crypto.createHash("sha256").update(inst.token).digest("hex").slice(0, 24);

export function sessionDiagnostic(inst: Instance): SessionDiagnostic {
  const name = inst.clientName ?? "";
  const child = inst.ctx.kind === "child";
  if (!child && inst.carried) return { scope: "conversation-token", source: "session-token", topology: "shared", reason: TOKEN_REASON, fingerprint: fingerprint(inst) };
  if (!child && inst.keyed) return { scope: "host-session", source: "host-key", topology: "shared", reason: HOST_KEY_REASON, fingerprint: fingerprint(inst) };
  const keyedProcess = !child && Boolean(inst.hostKey);
  const shared = !child && (inst.desktopEntry || /^local-agent-mode-/i.test(name) || keyedProcess);
  const dedicated = !child && !shared && /^(claude-code|codex-mcp-client)$/i.test(name) && !inst.registration;
  return {
    scope: child ? "child-run" : shared ? "shared-process" : dedicated ? "dedicated-process" : "unqualified-process",
    source: child ? "child-context" : inst.desktopEntry ? "desktop-entry" : dedicated ? "native-registration" : shared ? "client-profile" : "none",
    topology: child || dedicated ? "dedicated" : shared ? "shared" : "unknown",
    reason: inst.singletonViolation ? SINGLETON_REASON
      : child ? "Authority comes from the launched turn's run context; host metadata cannot widen it."
      : keyedProcess ? HOST_PROCESS_REASON : shared ? SHARED_REASON : dedicated ? "Qualified native registration: one conversation per relay process. Restart recovery requires explicit adoption."
      : "Conversation topology is unqualified. This process is one authority domain; host metadata provides no session isolation.",
    fingerprint: fingerprint(inst),
  };
}

function freeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}

const OPENCODE_SESSION = "ai.opencode/sessionID";
/**
 * The OpenCode session a call comes from, as OpenCode 2 stamps it (_meta["ai.opencode/sessionID"]),
 * validated as callIdentity validates it; undefined when the call carries none.
 */
export function opencodeSession(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta || !Object.hasOwn(meta, OPENCODE_SESSION)) return undefined;
  const v = meta[OPENCODE_SESSION];
  if (typeof v !== "string" || !v.trim() || v.length > 4096) throw new Error("malformed session metadata");
  return v;
}
/** Recognized session fields are validated even on unqualified hosts. Raw keys never enter snapshots. */
export function callIdentity(inst: Instance, meta: Record<string, unknown> | undefined, protocol: string, client?: { name: string; version: string }): CallIdentity {
  const evidence: string[] = [];
  const field = (obj: Record<string, unknown>, key: string, path = key): string | undefined => {
    if (!Object.hasOwn(obj, key)) return undefined;
    const v = obj[key];
    if (typeof v !== "string" || !v.trim() || v.length > 4096) throw new Error("malformed session metadata");
    evidence.push(path);
    return v;
  };
  const m = meta ?? {};
  // The token itself never enters the snapshot: only that this call's scope came from one.
  if (inst.carried) evidence.push("argument:session_token");
  const topThread = field(m, "threadId"), topSession = field(m, "sessionId");
  field(m, "windowId");
  const conversation = field(m, "anthropic/conversationUuid"), opencodeKey = field(m, OPENCODE_SESSION);
  let turn: Record<string, unknown> = {};
  const metadataPresent = Object.hasOwn(m, "x-codex-turn-metadata");
  if (metadataPresent) {
    const v = m["x-codex-turn-metadata"];
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("malformed session metadata");
    turn = v as Record<string, unknown>;
  }
  const nestedThread = field(turn, "thread_id", "x-codex-turn-metadata.thread_id");
  const nestedSession = field(turn, "session_id", "x-codex-turn-metadata.session_id");
  if ((topThread && nestedThread && topThread !== nestedThread) || (topSession && nestedSession && topSession !== nestedSession)) throw new Error("conflicting session metadata");
  const model = field(turn, "model", "x-codex-turn-metadata.model");
  const source = field(turn, "thread_source", "x-codex-turn-metadata.thread_source");
  let malformed = false;
  const roomField = (key: string): string | null => {
    if (!Object.hasOwn(turn, key)) return null;
    const v = turn[key];
    if (typeof v !== "string" || !v.trim() || v.length > 4096) { malformed = true; return null; }
    return v;
  };
  const trigger = roomField("turn_trigger");
  const clientType = roomField("client_type");
  // sandbox is the native implementation (seatbelt/none), not the permission mode.
  const originator = roomField("originator");
  const sandbox = roomField("sandbox_mode");
  roomField("sandbox");
  const approvalPolicy = roomField("approval_policy");
  let autoReview: boolean | null = null;
  if (Object.hasOwn(turn, "auto_review_enabled")) {
    if (typeof turn.auto_review_enabled !== "boolean") malformed = true;
    else autoReview = turn.auto_review_enabled;
  }
  const codex: RoomIdentityEvidence["codex"] = {
    malformed, metadata_present: metadataPresent, thread_id: nestedThread ?? null, thread_source: source ?? null, turn_trigger: trigger ?? null,
    // client_type is the app marker when no originator is supplied in turn metadata.
    originator: originator ?? clientType ?? null, sandbox: sandbox ?? null, auto_review: autoReview, approval_policy: approvalPolicy ?? null,
  };
  const codexSubagent = source === "subagent";
  if (inst.ctx.kind === "root" && sessionDiagnostic(inst).topology === "dedicated") {
    inst.singletonStamps ??= new Map();
    for (const [kind, key] of [["codex-thread", topThread ?? nestedThread], ["anthropic-conversation", conversation], ["opencode-session", opencodeKey]]) {
      if (!key) continue;
      const hash = crypto.createHash("sha256").update(JSON.stringify([kind, key])).digest("hex");
      const previous = inst.singletonStamps.get(kind!);
      if (previous && previous !== hash) inst.singletonViolation = true;
      else inst.singletonStamps.set(kind!, hash);
    }
  }
  const contribution = callerLabel(inst, { hostModel: model, codexSubagent });
  const session = sessionDiagnostic(inst);
  const { fingerprint: _fingerprint, reason: _reason, ...diagnostic } = session;
  const snapshot: CallerSnapshot = {
    call_id: crypto.randomUUID(),
    harness: (client?.name ?? inst.clientName)?.slice(0, 256) ?? null, version: client?.version.slice(0, 256) ?? null, protocol,
    session: { ...diagnostic, reason_code: inst.singletonViolation ? "singleton-violation" : session.scope, evidence, assurance: inst.ctx.kind === "child" ? "injected-context" : inst.carried ? "relay-capability" : inst.keyed ? "host-correlation" : session.topology === "dedicated" ? "dedicated-process-assumption" : session.topology === "shared" ? "shared-authority" : "unqualified" }, model: model ?? null,
    family_label: contribution.label, routing_family: familyOf(inst), subagent: codexSubagent,
    parent: inst.ctx.kind === "child" ? inst.ctx.nodeId : null,
  };
  return freeze({ snapshot, contribution: { ...contribution, snapshot }, session, codexSubagent, codex, ...(model ? { hostModel: model } : {}) });
}

/** Call after resolving a shared token view. Evidence is neither authority nor a stored caller. */
export function roomIdentityEvidence(inst: Instance, identity: CallIdentity): RoomIdentityEvidence {
  return freeze({
    call_id: identity.snapshot.call_id, scope: sessionDiagnostic(inst).scope,
    harness: inst.clientName ?? identity.snapshot.harness, family: identity.contribution.label,
    subagent: identity.codexSubagent || inst.ctx.kind === "child",
    singleton_violation: Boolean(inst.singletonViolation), codex: { ...identity.codex },
  });
}
