// Admission: who is calling relay, and what it may do. A relay MCP instance's view of itself
// (Instance), the family it calls from, the run it owns, and the checks every tool call that
// starts or continues work crosses, in order: which agent it reaches, what the caller's turn
// allows, its authority over an item, what the work may be given, and whether the target can honour
// it (admitNew, admitExisting, admitWork). Each tool keeps its own checks between those, in place.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateRoot, nativeTempAlias, nativeTempRoot, privateStateRoot } from "../confine/private-root.js";
import { configProtection, overlapsPart, pathOverlaps, relayInstallation, relayPathDirs, relayCodexProtected } from "./protected-config.js";
import { consultHome, expandHome, foldedPath, harnessHome, insideAnyCase, loadConfig, networkOn, overlapsEntryAnyCase, relayHome, underTemp, worktreesHome, type Mode, type RelayConfig, type Target } from "./config.js";
import type { Context } from "./context.js";
import { createRun, descendants, getNode, getRun, nodeTurns, queuedTurnIds, runConfig, setParam, turnEnded, workCwd, type NodeRow } from "./db.js";
import type { Grant } from "../backends/types.js";
import { webGranted, type RequestRow } from "./approvals.js";
import { queuedSpeeds, sessionParams, speedOf } from "./params.js";
import { CALLER_LABEL, incapable, resolveTarget, SPEEDS, speedRank, targetDef, targetLabel, vendorFor, type Needs, type Speed, type TargetDef, type TargetSettings, type Vendor } from "../targets/index.js";
import { confinement, dirIdentity } from "../confine/index.js";
import { codexWriteRootProblem } from "../targets/codex.js";
import { keyAuthority } from "./api-keys.js";
import { extensionKeys, holdsServers, PERSON_ROUTES, resolveExtensions, takesNone, touchesConfig, type SessionExtensions } from "./extensions.js";
import { boundaryProbe, NO_PROBE } from "../confine/turn-probe.js";
import type { CallIdentity } from "./identity.js";
import { environmentAdmission, personConsentAdmission } from "./env-broker.js";
import { localModeRetired, rawNetworkGrantProblem, stage2Enabled } from "./raw-network.js";
import { ENVIRONMENT_NAME } from "./env-policy.js";
import { checkpointNever } from "./never-checkpoint.js";
import { neverGrantProblem, type NeverPolicy } from "./never-policy.js";
import { refreshEscalationPersonPath } from "./escalation-contract.js";
import { nativeCodexNeverNetworkProblem } from "../backends/never-admission.js";

/** A tool's result, as relay's MCP server returns it (as JSON). */
export type Json = Record<string, unknown>;
/** How a call is refused: the reason, worded so the agent simply carries on by itself. */
export const refused = (reason: string): Json => ({ refused: true, reason: `Refused: ${reason}` });
export const SINGLETON_REASON = "This dedicated connection has carried multiple conversations. Item access and event delivery are disabled; restart with a dedicated registration.";

/** A relay MCP instance's view of itself. runId is created lazily for a root. */
export interface Instance {
  ctx: Context;
  runId: string | null;
  cwd: string;
  /** For a root session: which family of agent its host is, when known. A launched agent's family is its node's. */
  family: Target | null;
  /** A contradicted --host is kept for explanatory labels and review transcript protection, never for routing. */
  registration?: { host: Target; client: string };
  clientName?: string;
  desktopEntry?: boolean;
  /** Correlation evidence only, hashed; a contradicted dedicated-process assumption stays revoked. */
  singletonStamps?: Map<string, string>;
  singletonViolation?: boolean;
  /**
   * Known only to this instance. A run records its owner's token, so ownership is checked, not remembered.
   * For a conversation's view of a shared process (session-token.ts), the owner hash of the token it carries.
   */
  token: string;
  /** Set on a conversation's view of a shared process, scoped by the session token its model carries. */
  carried?: true;
  /**
   * Set on a root whose host stamps every call with the session it comes from (OpenCode 2's
   * _meta["ai.opencode/sessionID"]): each call acts as that session's view of this process.
   */
  hostKey?: "opencode-session";
  /** Set on a session's view of a host-keyed process (hostKey). */
  keyed?: true;
  /** Approval requests this root session's waits have handed to its agent, so that each interrupts a wait once. */
  handedOff: Set<string>;
  /** What relay makes of the host a root session runs in, from its host profile once the session has started (mcp/server.ts). */
  host: HostView;
  /** Questions on the user's screen now, by request id, so that one decided elsewhere can be withdrawn. */
  asking: Map<string, AbortController>;
  /** Requests whose not being asked has been logged. */
  noted: Set<string>;
  /** For each run this root session owns, where its events are recorded from: the run's creation. */
  since: Map<string, number>;
  /** When this root server's watch last looked for jobs whose worker has died. */
  reapedAt?: number;
  /** This session's calls that are waiting now, by a number of their own: in which run, on which items. */
  waiting: Map<number, { runId: string; items: Set<string> }>;
}

/** What relay makes of a root session's host: what it can do, and how relay reaches the user through it. */
export interface HostView {
  recognised: boolean;
  /**
   * Puts an approval request to the user through the host. Set only for a root session whose host
   * relay may ask (see hostProfile and ask_user); `signal` withdraws the question.
   */
  elicit?: (r: RequestRow, signal: AbortSignal) => Promise<ElicitAnswer>;
  /** Why the user is not asked directly, when elicit is unset. Logged once per request. */
  noElicit?: string;
  /** Effective dialog gate and reason, reported by status even when no request is pending. */
  approvalDialogs?: { offered: boolean; reason: string };
  /**
   * Set for a root session whose host is a positively identified interactive Claude Code main
   * session: there a long status wait moves to the background and its completion starts a turn,
   * so status may wait up to LONG_WAIT_S rather than block_s.
   */
  longWaits?: boolean;
  /** The longest one call may wait, including a launched Codex's calls (HostProfile.waitCapS). */
  waitCapS?: number | null;
  /** Posts a notice to the session (Claude Code's inbox socket), where the host has one. */
  notice?: (text: string, eventId: number) => void;
  /** Whether this root session has the confirm tool (Claude-family hosts, which prompt the user before every call of it). */
  confirmTool?: boolean;
  /** Whether the host keeps a withdrawn question on screen (Codex), so that deciding elsewhere does not take it away. */
  formStays?: boolean;
  /** Why confirm is not offered to a host that would otherwise get it (its settings could answer for the person). */
  confirmWithheld?: string;
  /**
   * Whether relay's question reaches a person here: it is put to the host, and the host is
   * positively known to show it to one (HostProfile.elicit "dialog"). Only then, or through
   * confirm, can the person allow a person-only request (docs/extensions.md).
   */
  personDialog?: boolean;
  /**
   * Revision 3 rooms: set only where relay may ask the person to open a room through the host's
   * own prompt (mcp/host.ts roomOpenDialog); `roomOpenWithheld` says why not, otherwise.
   */
  roomOpen?: { surface: "claudeCli" | "codexCli"; keepsForm: boolean; why: string };
  roomOpenWithheld?: string;
}

/**
 * How a question put to the user ended. "decided": the user answered (allow, or deny). The others
 * leave the request pending: "dismissed", closed without an answer by a person (Esc in interactive
 * Claude Code); "unattributed", a host answer that decides nothing and does not show anyone saw it
 * (outcome says what the host answered); "error", the host could not ask; "withdrawn", decided
 * elsewhere first.
 */
export type ElicitAnswer =
  | { reading: "decided"; outcome: string; allow: boolean; forJob?: boolean; note?: string }
  | { reading: "dismissed" | "unattributed" | "error" | "withdrawn"; outcome: string };

export function newInstance(ctx: Context, cwd: string, family: Target | null = null): Instance {
  return {
    ctx, cwd, family, runId: ctx.kind === "child" ? ctx.runId : null, token: crypto.randomBytes(12).toString("hex"),
    handedOff: new Set(), host: { recognised: false }, asking: new Map(), noted: new Set(), since: new Map(), waiting: new Map(),
  };
}

/** Which family of agent is calling: a launched agent's own, or the host's for a root session. */
export const familyOf = (inst: Instance): Target | null =>
  inst.ctx.kind === "child" ? (getNode(inst.ctx.nodeId)?.target ?? null) : inst.ctx.kind === "root" ? inst.family : null;

/**
 * Which agent a call reaches (see resolveTarget), under the explicit-target steering policy. Judged under the config that governs the
 * call: the user's for a root session, the run's for a launched agent. `existing` is set when the
 * call continues a session that already exists.
 */
function reach(inst: Instance, requested?: Target, opts: { existing?: boolean; model?: string | null } = {}): { target: Target; model?: string } | { reason: string } {
  if (inst.ctx.kind === "poisoned") {
    return { reason: `relay context for this agent could not be loaded (${inst.ctx.reason}). Continue without delegating, consulting, or starting discussions.` };
  }
  if (inst.ctx.kind === "child" && !getRun(inst.ctx.runId)) return { reason: "this agent is no longer in the relay registry. Continue on your own." };
  const cfg = inst.ctx.kind === "root" ? loadConfig() : runConfig(inst.ctx.runId);
  return resolveTarget(familyOf(inst), requested, cfg as TargetSettings, { ...opts, callerVendor: callerVendor(inst) });
}

/**
 * The calling agent's family. A launched agent on a harness of several families' models is of
 * the family of its latest reported model only if it pinned a listed model. Auto, absent and
 * unlisted pins stay unknown even after reports: the harness may route without reporting it.
 */
export function callerVendor(inst: Instance): Vendor | null {
  const own = familyOf(inst);
  if (!own) return null;
  const def = targetDef(own);
  if (def.vendor) return def.vendor;
  if (inst.ctx.kind !== "child") return null;
  const n = getNode(inst.ctx.nodeId);
  if (!n) return null;
  if (!n.model || n.model === def.autoModel || !vendorFor(def, n.model)) return null;
  const p = sessionParams(n);
  return vendorFor(def, Object.hasOwn(p, "served_model") ? p.served_model : n.model);
}

/**
 * Admission by capability: why the target cannot honour what the call needs, or null. A target
 * confined by relay itself is refused where relay's confinement cannot enforce, and an
 * unqualified one unless targets.<id>.experimental is set; nothing is ever launched on less than it promises.
 */
function capable(target: Target, cfg: RelayConfig, needs: Needs): string | null {
  const def = targetDef(target);
  const no = incapable(def, needs);
  if (no) return no;
  if (def.capabilities.confinement === "relay-enforced") {
    const c = confinement();
    if ("reason" in c) return `${targetLabel(def)} runs only inside relay's own sandbox, and ${c.reason}, so relay does not launch it. Use another agent, or do this part yourself.`;
    if (!boundaryProbe()) return `${NO_PROBE}, so ${targetLabel(def)} cannot be used yet. Use another agent, or do this part yourself.`;
  }
  if (!def.qualified && !cfg.targets[target]?.experimental) {
    return `${targetLabel(def)} is experimental: relay has not yet qualified it with a signed-in run (its login, model selection and protocol behaviour are unverified). Set targets.${target}.experimental to true in relay's config to use it anyway.`;
  }
  return null;
}

/**
 * Under strict policy, why relay refuses a caller whose family it cannot tell, or null. Continuing a session that exists
 * (resuming a job, following up a thread, carrying on a discussion or review) needs only that,
 * besides authority over the item: it may be of the caller's own family (a root session
 * supervises everything in its run, whoever started it). Only starting an agent keeps to families.
 */
export function knownCaller(inst: Instance): string | null {
  if (inst.ctx.kind === "poisoned") return `relay context for this agent could not be loaded (${inst.ctx.reason}). Continue without delegating, consulting, or starting discussions.`;
  if (callerVendor(inst)) return null;
  const cfg = inst.ctx.kind === "child" ? runConfig(inst.ctx.runId) : loadConfig();
  if (cfg.same_family !== "refuse") return null;
  const r = resolveTarget(null, undefined, { same_family: "refuse" });
  return "reason" in r ? r.reason : null;
}

/**
 * The calling agent's side label in a discussion or review with an agent of target `other`: its
 * target id, or CALLER_LABEL where that is `other`'s too (same_family "allow", or a session of the
 * caller's own family that already exists), so that the two sides never share markers, files or
 * item ids. An unknown caller uses CALLER_LABEL as well.
 */
export const callerSide = (inst: Instance, other: string): string => {
  const own = familyOf(inst) ?? CALLER_LABEL;
  return own === other ? CALLER_LABEL : own;
};

export interface Caller {
  runId: string;
  /** The launched agent making the call; null for a root session. */
  node: NodeRow | null;
  depth: number;
  cwd: string;
  /** What the caller's current turn may do. A root session is not confined by relay. */
  access: Mode;
  /** The exact launched turn whose immutable grant supplies this caller's authority. */
  turnId?: number;
}

/** A root's cwd as given: ~ is the home folder, and a relative path is relay's own working directory's. */
export const expand = (p: string) => path.resolve(expandHome(p));

/**
 * True while the turn a launched agent's relay server was started for is still running. Deliberately
 * weaker than turnGone (approvals.ts): a cancelled run or ancestor is worded apart by admit.
 */
const turnLive = (ctx: Extract<Context, { kind: "child" }>): boolean => turnEnded(ctx.nodeId, ctx.turnId) === null;

/** Checks existing ownership. Recovery is exclusively the explicit flow in adoption.ts. */
export function claimRun(inst: Instance, runId: string): string | null {
  return ownsRun(inst, runId) ? null : "item unavailable";
}

export const ownsRun = (inst: Instance, runId: string | null) => Boolean(runId && getRun(runId)?.root_token === inst.token);

/** Identical for a missing item and a foreign one; no ids, titles, paths or run details. */
export const UNAVAILABLE = (): Json => ({
  error: "Item unavailable.",
  recovery: "If this is your own work from before a restart or reconnect, ask the person to adopt it: adopt with this id (they confirm), or relay adopt <id> --to <fingerprint> in a terminal.",
});

/** Explicit child read allowlist: its injected run, including its supervisor and siblings.
 * Mutation authority remains the narrower descendant/grant/turn check below. */
export function canReadRun(inst: Instance, runId: string): boolean {
  if (inst.singletonViolation) return false;
  return inst.ctx.kind === "root" ? ownsRun(inst, runId)
    : inst.ctx.kind === "child" ? inst.ctx.runId === runId && Boolean(getNode(inst.ctx.nodeId)) : false;
}
export function canReadItem(inst: Instance, id: string): boolean {
  const runId = id.startsWith("run_") ? getRun(id)?.id : getNode(id)?.run_id;
  return Boolean(runId && canReadRun(inst, runId));
}

/**
 * Admission for every call that starts or changes something: the fail-closed context check, the
 * two hard limits, and what the caller's current turn allows. `existing` is given when the call
 * names items that already exist, all of which must be in one run. Returns a reason when refused,
 * worded so the agent simply carries on by itself.
 */
/**
 * A new, empty directory for one consult thread that names no project, where relay was started
 * outside any (the desktop app): its own, so that nothing an agent of one conversation leaves there
 * is where another's starts (review r_f1c46bd4 C1+X2). A follow-up goes on in it. It is made under
 * consultHome, which must be a plain directory of this user's (C3+X1) holding only such directories,
 * and which no grant or file approval may write (grantPathProblem, approvals.ts offLimits).
 */
function newConsultDir(): { dir: string } | { reason: string } {
  try {
    const root = consultHome();
    fs.mkdirSync(path.dirname(root), { recursive: true });
    ensurePrivateRoot(root);
    // Every new thread's directory is below this one, where an agent can load instructions from its
    // directory's parents (CLAUDE.md, AGENTS.md): it holds only the directories relay made.
    const stray = fs.readdirSync(root, { withFileTypes: true }).find((e) => !(e.isDirectory() && /^c-[A-Za-z0-9]{6}$/.test(e.name)));
    if (stray) return { reason: `${root} holds ${JSON.stringify(stray.name)}, which relay did not put there, and which an agent asking below it could load. Remove it, or pass cwd with the absolute path of a directory to ask in.` };
    return { dir: fs.mkdtempSync(path.join(root, "c-")) };
  } catch (err) {
    return { reason: `relay could not make a directory to ask in without a project: ${(err as Error).message}. Pass cwd with the absolute path of a directory to ask in.` };
  }
}

function admit(inst: Instance, opts: { cwd?: string; existing?: { runId: string; cwd: string }; starts?: boolean; consult?: boolean } = {}): Caller | { reason: string } {
  const starts = opts.starts !== false;
  if (inst.ctx.kind === "poisoned") {
    return { reason: `relay context for this agent could not be loaded (${inst.ctx.reason}). Continue without delegating, consulting, or starting discussions.` };
  }
  if (inst.singletonViolation) return { reason: SINGLETON_REASON };
  if (inst.ctx.kind === "root") {
    const cfg = loadConfig();
    // Both agents' sandboxes can write to temp directories. Control state there could be edited by a job.
    if (underTemp(relayHome()) && !cfg.allow_temp_home) {
      return { reason: `relay's control directory (${relayHome()}) is inside a temporary directory, where a launched agent's sandbox can write. Move it (unset RELAY_HOME) before starting agents.` };
    }
    let cwd = inst.cwd;
    if (opts.cwd) {
      cwd = expand(opts.cwd);
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { reason: `cwd ${cwd} is not an existing directory.` };
    } else if (path.parse(cwd).root === cwd) {
      // Hosts that do not start relay inside the project (desktop apps) name the directory per call.
      // A call about an existing item works where that item works.
      if (opts.existing) cwd = opts.existing.cwd;
      // A new consult needs no project: it asks in a new, empty directory of its own.
      else if (opts.consult) {
        const made = newConsultDir();
        if ("reason" in made) return made;
        cwd = made.dir;
      }
      else return { reason: "relay was started outside any project directory, so it does not know where to work. Pass cwd with the absolute path of the project." };
    }
    if (opts.existing) {
      const problem = claimRun(inst, opts.existing.runId);
      if (problem) return { reason: `that item cannot be used from this session: ${problem}.` };
      return { runId: opts.existing.runId, node: null, depth: 0, cwd, access: "write" };
    }
    if (!ownsRun(inst, inst.runId) || getRun(inst.runId!)?.status === "cancelled") {
      inst.runId = createRun(cwd, cfg, inst.token);
      inst.since.set(inst.runId, getRun(inst.runId)!.created_at);
      refreshEscalationPersonPath(inst.token, { confirm: inst.host.confirmTool === true, dialog: inst.host.personDialog === true && !!inst.host.elicit });
    }
    return { runId: inst.runId!, node: null, depth: 0, cwd, access: "write" };
  }
  const ctx = inst.ctx;
  // A launched agent works where relay put it; only a root session chooses a directory.
  if (opts.cwd) return { reason: "cwd can only be set by the root session. Omit it; you work in your own directory." };
  const node = getNode(ctx.nodeId);
  const run = getRun(ctx.runId);
  if (!node || !run) return { reason: "this agent is no longer in the relay registry. Continue on your own." };
  // The relay server of a turn that has ended keeps none of that turn's authority.
  if (!turnLive(ctx)) return { reason: "the turn this relay connection belonged to has ended, so it can no longer start or change anything." };
  if (run.status === "cancelled" || node.status === "cancelled") return { reason: "this run has been cancelled. Stop and report what you have." };
  if (opts.existing && opts.existing.runId !== run.id) return { reason: "that item belongs to a different run." };
  // A session holding MCP servers starts and steers nothing: an agent it started would have none
  // of its limits (no network, every request the person's), and so would be a way round them.
  if (holdsServers(node)) return { reason: SERVERS_START_NOTHING };
  if (!ctx.mayDelegate) return { reason: "you were started with allow_delegation = false, so you cannot start or steer other agents. Do this part yourself." };
  const cfg = runConfig(run.id);
  if (starts && node.depth >= cfg.max_depth) {
    return { reason: `you are at depth ${node.depth} of ${cfg.max_depth}, the maximum, so you cannot start further agents. Do this part yourself.` };
  }
  return { runId: run.id, node, depth: node.depth, cwd: workCwd(node), access: ctx.access, turnId: ctx.turnId };
}

export const grantOf = (n: NodeRow): Grant => sessionParams(n).grant ?? {};
/** Environment requests belong to queued turns, never a standing session grant. */
export const persistentGrant = (g: Grant | null | undefined): Grant | null => g ? (({ env, ...rest }) => rest)(g) : null;

/** Session grants can change while a turn runs. Only its launch snapshot is its authority. */
function runningGrant(n: NodeRow, turnId?: number): Grant {
  const active = nodeTurns(n.id).filter((t) => t.status === "running" && (turnId === undefined || t.id === turnId));
  const grants: Grant[] = active.map((t) => {
    if (t.grant_json === null) return {};
    try { return JSON.parse(t.grant_json) as Grant; } catch { throw new Error("invalid effective turn grant"); }
  });
  return { network: grants.some((g) => g.network), local_network: grants.some((g) => g.local_network), raw_network: grants.some((g) => g.raw_network), env: [...new Set(grants.flatMap((g) => g.env ?? []))], write_paths: [...new Set(grants.flatMap((g) => g.write_paths ?? []))] };
}

/** The grant as a caller sees it: without the per-turn directory pins, which are relay's internal plumbing for confinement (write_path_pins). */
export const publicGrant = (g: Grant): Grant => ({ network: g.network, ...(g.local_network ? { local_network: true } : {}), ...(g.raw_network ? { raw_network: true } : {}), ...(g.env?.length ? { env: g.env } : {}), ...(g.write_paths ? { write_paths: g.write_paths } : {}) });

/**
 * Whether a launched agent may steer, cancel, merge or converse with an existing item. It must be
 * something the agent started, directly or through agents it started, and must not hold more than
 * the agent's own current turn does: a confined agent cannot act through a less confined one.
 */
export function authority(caller: Caller, target: NodeRow, verb: string): string | null {
  if (!caller.node) return null;
  if (!descendants(caller.node.id).some((d) => d.id === target.id)) {
    return `you can ${verb} only work that you started, or that agents you started went on to start; ${target.id} is not that.`;
  }
  const mine = runningGrant(caller.node, caller.turnId);
  if (nodeTurns(target.id).some((t) => t.status === "running" && t.grant_json === null)) {
    return `${target.id} has a running turn without a recorded effective grant, so relay cannot establish its authority and you cannot ${verb} it.`;
  }
  const current = runningGrant(target);
  const next = grantOf(target);
  const theirs = { network: current.network || next.network, local_network: current.local_network || next.local_network, raw_network: current.raw_network || next.raw_network, write_paths: [...(current.write_paths ?? []), ...(next.write_paths ?? [])] };
  // Extensions count as grants do (review X2): a skill, an MCP server or a tool that runs without
  // asking that the target's session holds and the caller's does not is more than the caller has.
  const myExtensions = new Set(extensionKeys(sessionParams(caller.node).extensions ?? undefined));
  // The web tools are compared apart from the shell's network: a web request allowed for the rest
  // of a job lets its web searches and fetches through (webGranted) without giving its shell the network.
  const more =
    (target.mode === "write" && caller.access === "read") ||
    (Boolean(theirs.network) && !mine.network) ||
    (Boolean(theirs.local_network) && !mine.local_network) ||
    (Boolean(theirs.raw_network) && !mine.raw_network) ||
    (current.env ?? []).some((name) => !(mine.env ?? []).includes(name)) ||
    (webGranted(target.id) && !webGranted(caller.node.id)) ||
    (theirs.write_paths ?? []).some((p) => !(mine.write_paths ?? []).includes(p)) ||
    extensionKeys(sessionParams(target).extensions ?? undefined).some((k) => !myExtensions.has(k));
  if (more) return `${target.id} has more access than your current turn does, so you cannot ${verb} it. Report it to whoever started you.`;
  return null;
}

/**
 * What a tool call brings besides its arguments: where to send progress and the signal that it is no
 * longer wanted (for its waits, wait.ts), its one deadline, and whether a Codex subagent thread made it.
 */
export interface ToolCall {
  /** Immutable identity resolved once at the MCP boundary, reused for every contribution. */
  identity?: CallIdentity;
  /** The harness's per-call model report; correlation evidence, never authentication. */
  hostModel?: string;
  /** Called every so often while the call waits, with a line saying how the awaited item is getting on. */
  onTick?: (elapsedMs: number, message?: string) => void;
  /** Aborted when the caller cancels the call. That ends the wait; the work goes on. */
  signal?: AbortSignal;
  /**
   * One deadline (absolute ms) for the whole tool call, where the host times its tool calls out
   * (the Claude desktop app: HostProfile.waitCapS). Every wait the call makes shares it, so nested
   * waits (a review's reconciliation: wait for the reviewer, then discuss) together stay under the
   * cap; a wait that reaches it gets no time and the call returns a pending handle. Unset where the
   * host does not time calls out, so a single long wait is bounded only by block_s as before.
   */
  deadline?: number;
  /**
   * The call comes from a Codex subagent thread (server.ts fromCodexSubagent): a root session with
   * no person in its conversation, which relay cannot tell was authorized by one. It may not allow
   * an approval request, nor give a grant (subagentRefusal, review C6).
   */
  codexSubagent?: boolean;
}

// Codex starts a relay server for each of its threads, so a native Codex subagent has a root session
// of its own, with no person in its conversation (ToolCall.codexSubagent). From one, relay takes a
// denial but not an allowance, nor a grant (review C6), nor extensions.
const SUBAGENT_ALLOW = "this call comes from a Codex subagent thread, which no person is working in, so it cannot allow a launched agent's request (whatever it is told the user said). " +
  "Return the request, with its request_id, to the agent that started you. The user can allow it by answering relay's question where Codex shows it, or with `relay approve <request_id>` in a terminal, except a request marked person_only, which relay takes from no command (the user allows it in relay's question, or through confirm). You may deny it.";

/**
 * Why a Codex subagent thread may not give a grant (review C6). A grant widens what a launched
 * agent may do as an allowance does, and the thread may not allow (SUBAGENT_ALLOW): no person is in
 * its conversation, and a grant it passes on as its parent's carries nothing relay can check (Codex
 * marks the thread as a subagent's, not who started it or what they said). The parent passes it on
 * verifiably by making the call itself, from its own thread.
 */
const SUBAGENT_GRANT =
  "this call comes from a Codex subagent thread, which no person is working in, so it cannot grant network access or write paths: relay cannot tell that the user authorized them, whatever the agent that started you said. " +
  "Make the call without grant (the launched agent then asks relay for what it needs, and the user decides), or return to the agent that started you and ask it to make this call itself with the grant, from its own thread; it can hand you the job_id to wait on with status.";

/**
 * Why a Codex subagent thread may not give extensions (as it may not give a grant): only a root
 * session gives them (docs/extensions.md X2), and a subagent thread's root session has no person
 * in its conversation, so it would choose, unchecked, which session holds skills and servers.
 */
const SUBAGENT_EXTENSIONS =
  "this call comes from a Codex subagent thread, which no person is working in, so it cannot give extensions: relay cannot tell that the user wants this work to have them, whatever the agent that started you said. " +
  "Make the call without extensions, or return to the agent that started you and ask it to make this call itself, from its own thread; it can hand you the id to wait on with status.";

/** Why a call from a Codex subagent thread may not allow an approval request, give a grant or give extensions; null for any other call. */
export function subagentRefusal(call: Pick<ToolCall, "codexSubagent">, what: "allow" | "grant" | "extensions"): string | null {
  if (!call.codexSubagent) return null;
  return what === "allow" ? SUBAGENT_ALLOW : what === "grant" ? SUBAGENT_GRANT : SUBAGENT_EXTENSIONS;
}

/**
 * Why `paths`, a grant's write paths, may not be given, or kept, for overlapping a directory that
 * decides which API key relay hands a key-only target (keyAuthority, core/api-keys.ts): relay's
 * config directory with its local config, the default key directory, and where the local config
 * moves a key file. config.json, which holds the per-target opt-in that lets relay hand a key over,
 * is protected with relay's other config files (protected-config.ts): the configured file and the
 * one a link leads to (as when the person syncs it from a dotfiles repository), and their directory where it
 * is relay's alone.
 */
function keyGrantProblem(paths: string[]): string | null {
  if (!paths.length) return null;
  const keys = keyAuthority();
  // Fail closed: a grant is kept with its job, so one given while relay cannot tell where its keys
  // are would still be there once the local config is fixed, and might then cover a key directory.
  if (keys.problem) return `relay cannot load its local config, so it cannot tell which directories decide its API keys, and no job may hold a write path until that is fixed: ${keys.problem}`;
  for (const p of paths) {
    let real = p;
    try {
      real = fs.realpathSync.native(p);
    } catch {
      // Gone since: judged by its name.
    }
    // On macOS a name in another case, or under the data volume's name, is the same directory.
    for (const [why, dir] of keys.dirs) if (insideAnyCase(real, dir) || insideAnyCase(dir, real)) return `grant.write_paths entry ${real} overlaps ${why} (${dir}), which no job may be given.`;
  }
  return null;
}

/** The exclusions for both new and kept grants, by every name relay protects. */
function grantPathProblem(p: string, installed: string[], cfg: RelayConfig): string | undefined {
  const codex = relayCodexProtected(cfg);
  const protectedCodex = [...codex.homes, ...codex.stores].find((x) => overlapsPart(p, x.path));
  if (protectedCodex) return `grant.write_paths entry ${p} overlaps ${protectedCodex.what} (${protectedCodex.path}), which no job may be given.`;
  for (const [what, dir] of [["relay's control directory", relayHome()], ["the directory holding job worktrees", worktreesHome()], ["the directory holding confined agents' state", harnessHome()], ["the directory questions without a project are asked in", consultHome()], ["relay's private turn state", privateStateRoot()], ["native turns' private temporary state", nativeTempRoot()]] as const) {
    if (insideAnyCase(p, dir) || insideAnyCase(dir, p)) return `grant.write_paths entry ${p} overlaps ${what} (${dir}), which no job may be given.`;
  }
  // The link itself, by its own name: a job that could write where it is could point it elsewhere.
  const link = nativeTempAlias();
  if (overlapsEntryAnyCase(p, link)) return `grant.write_paths entry ${p} overlaps relay's short link to native turns' private temporary state (${link}), which no job may be given.`;
  if (underTemp(p) || ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/private/var/folders", "/var/folders"].some((dir) => insideAnyCase(p, dir))) return `grant.write_paths entry ${p} is under a shared temporary directory, which other agents can write; move it outside shared temp before granting it.`;
  const config = touchesConfig(p);
  if (config) return `grant.write_paths entry ${p} overlaps relay's config file ${config}, which no job may be given.`;
  const record = installed.find((c) => pathOverlaps(p, c) || insideAnyCase(p, c) || insideAnyCase(c, p));
  if (record) return `grant.write_paths entry ${p} overlaps relay's config or install files (${record}), which no job may be given.`;
  // What relay runs outside every sandbox (review r_0c11d860 X1): its own package, the Node it runs
  // on, and the target CLIs it starts, by the name relay starts each, the file it leads to and the
  // installation holding it. A job that could write any of them would run its code unconfined.
  const part = relayInstallation().find((x) => overlapsPart(p, x.path));
  if (part) return `grant.write_paths entry ${p} overlaps ${part.what} (${part.path}), which relay runs outside any sandbox, so no job may be given it. Grant a directory outside it.`;
  // A directory on relay's PATH, one holding it, or one inside it: a program a job put there (or a
  // directory under the program's name, which a lookup skips only if it is not runnable) would be
  // found before the one relay runs now, by a later relay process or your own shell, and run
  // outside any sandbox.
  const onPath = relayPathDirs().find((d) => insideAnyCase(d, p) || insideAnyCase(p, d));
  if (onPath) return `grant.write_paths entry ${p} ${foldedPath(onPath) === foldedPath(p) ? "is" : insideAnyCase(onPath, p) ? "holds" : "is inside"} ${onPath}, a directory on relay's PATH, where a program a job put would be run outside any sandbox, so no job may be given it. Grant a directory outside it.`;
}

/** Preserve X1/config/key explanations and recovery when a previously granted root becomes unsafe. */
function keptGrantProblem(paths: string[], cfg: RelayConfig): string | null | undefined {
  const installed = paths.length ? configProtection().paths : [];
  return paths.map(p => grantPathProblem(p, installed, cfg)).find(Boolean) ?? keyGrantProblem(paths);
}
const keptGrantRefusal = (why: string): string => `the grant this session keeps from when it was given can no longer be used: ${why} Continue it with a grant of its own (grant: {write_paths: [...]}) that leaves that out, or start a new job.`;

/**
 * Validates a grant. Only the root session can give one: a launched agent is itself confined, and
 * letting it widen a child's permissions would let a child hold more than its parent. Nor can a
 * Codex subagent thread's root session (SUBAGENT_GRANT).
 */
function checkGrant(caller: Caller, grant: Grant | undefined, mode: Mode, call: Pick<ToolCall, "codexSubagent">, cfg: RelayConfig): { grant?: Grant; reason?: string } {
  const stage2 = stage2Enabled(process.env, cfg);
  // raw_network: false asks for nothing. With stage 2 off it is no grant at all, as before stage 2
  // added the key (review R9). With it on, it counts as a grant, so a root's resume with it
  // replaces the job's grant and so drops raw network rather than keeping it.
  const raw = stage2 ? grant?.raw_network !== undefined : grant?.raw_network !== undefined && grant?.raw_network !== false;
  if (!grant || (!grant.network && !grant.write_paths?.length && !grant.env?.length && !grant.local_network && !raw)) return {};
  if (caller.node) return { reason: "only the root session can grant extra permissions. Omit grant; if the work needs more than a worktree allows, say so in your report." };
  const sub = subagentRefusal(call, "grant");
  if (sub) return { reason: sub };
  if (grant.env && (!Array.isArray(grant.env) || grant.env.some((n) => typeof n !== "string" || !ENVIRONMENT_NAME.test(n)))) return { reason: "grant.env requires exact environment variable names, never values" };
  if (mode !== "write" && grant.write_paths?.length) return { reason: "a read-only session can be granted network access but not write paths." };
  if (grant.local_network !== undefined && typeof grant.local_network !== "boolean") return { reason: "grant.local_network must be true or false." };
  if (grant.local_network && mode !== "write") return { reason: "grant.local_network is for Codex write jobs only: a read-only session's shell never reaches this Mac's loopback or the local network." };
  // grant.raw_network is checked in admitWork (raw-network.ts rawNetworkGrantProblem), after this has refused anyone but the root.
  if (grant.raw_network !== undefined && typeof grant.raw_network !== "boolean") return { reason: "grant.raw_network must be true or false." };
  if (grant.local_network && grant.network !== true) return { reason: "grant.local_network needs network: true in the same grant: it widens the job's network to this Mac's loopback and the local network." };
  const paths: string[] = [];
  const protectedPaths = configProtection().paths;
  for (const raw of grant.write_paths ?? []) {
    const expanded = expandHome(raw);
    if (!path.isAbsolute(expanded)) return { reason: `grant.write_paths must be absolute paths (got ${raw}).` };
    const p = path.resolve(expanded);
    // Relay's config and install files (protected-config.ts, as the sandboxes protect them), also
    // where the entry is one of them rather than a directory.
    const installed = protectedPaths.find((c) => pathOverlaps(p, c) || insideAnyCase(p, c) || insideAnyCase(c, p));
    const configReason = installed ? `grant.write_paths entry ${p} overlaps relay's config or install files (${installed}), which no job may be given.` : null;
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return { reason: configReason ?? `grant.write_paths entry ${p} is not an existing directory.` };
    // Its name on disk: on macOS's default disks a name in another case is the same directory.
    const real = fs.realpathSync.native(p);
    // Relay's own state decides who may do what; other jobs' worktrees belong to other jobs. Its
    // config directory (the local config there says which key file relay reads) and the key
    // directories decide which key relay hands a key-only target, and so whose account it runs on;
    // config.json, which says whether it may, is among relay's config files (configReason).
    // Relay's own config files (config.json, mcp.json; a linked one by either name, and on macOS in
    // any case or under the data volume's name) say what agents may be given and which servers run
    // outside their sandboxes.
    const off = grantPathProblem(real, protectedPaths, cfg) ?? configReason;
    if (off) return { reason: off };
    paths.push(real);
  }
  const keys = keyGrantProblem(paths);
  if (keys) return { reason: keys };
  // Pin each grant by its resolved identity now, so a later turn refuses it if the directory has been
  // swapped or an intermediate component turned into a link (relay-enforced confinement, review C4/X2).
  return { grant: { network: grant.network === true, ...(grant.local_network ? { local_network: true } : {}), ...(grant.raw_network ? { raw_network: true } : {}), write_paths: paths, ...(grant.env?.length ? { env: [...new Set(grant.env)] } : {}), ...(paths.length ? { write_path_pins: paths.map((p) => dirIdentity(p)) } : {}) } };
}

// The order of these is the order a caller is refused in (CT1).

/**
 * Admission for a call that starts a session: reach, then admit. With `existing`, it starts a
 * discussion with a session that exists: reach as for that session, admit in its run with the depth
 * limit still applied (the discussion is new), then authority over the session.
 */
export function admitNew(inst: Instance, o: { target?: Target; model?: string; cwd?: string; existing?: NodeRow | null; consult?: boolean }): { caller: Caller; to: { target: Target; model?: string } } | { reason: string } {
  const s = o.existing ?? null;
  // An existing session keeps its own model; a new one is judged by the model asked for.
  const to = reach(inst, s?.target ?? o.target, { existing: Boolean(s), model: s ? s.model : o.model });
  if ("reason" in to) return to;
  const caller = admit(inst, { cwd: o.cwd, existing: s ? { runId: s.run_id, cwd: workCwd(s) } : undefined, consult: o.consult });
  if ("reason" in caller) return caller;
  const no = s ? authority(caller, s, "bring into a discussion") : null;
  return no ? { reason: no } : { caller, to };
}

/**
 * Admission for a call that continues an item that exists (resume, a follow-up, a discussion or
 * review carried on): admit in its run, then authority over it. Continuing is not a new start: the
 * depth limit was applied when the item began.
 */
export function admitExisting(inst: Instance, n: NodeRow, verb: string, cwd?: string): Caller | { reason: string } {
  const caller = admit(inst, { cwd, existing: { runId: n.run_id, cwd: workCwd(n) }, starts: false });
  if ("reason" in caller) return caller;
  const no = authority(caller, n, verb);
  return no ? { reason: no } : caller;
}

/**
 * What the work may be given, and whether its target can honour that: checkGrant, then capable
 * under the run's config. `kept` is the grant the session already holds, which a call that gives
 * none goes on with. Write paths count only for write work. Returns the call's own grant, checked.
 */
export function admitWork(
  caller: Caller, target: Target, o: { mode: Mode; grant?: Grant; kept?: Grant; continues: boolean; servers?: boolean; worktree?: string }, call: Pick<ToolCall, "codexSubagent">,
): { grant?: Grant } | { reason: string } {
  const cfg = runConfig(caller.runId);
  // Keep grant authority and the established config/key recovery wording ahead of the
  // cumulative floor, as approval requests do for relay's own protected resources.
  // Every admitted grant still has to pass the checkpoint and its exclusions below.
  const g = checkGrant(caller, o.grant, o.mode, call, cfg);
  if (g.reason) return { reason: g.reason };
  let never: NeverPolicy;
  try {
    never = checkpointNever(caller.runId, "grant");
  } catch (err) { return { reason: (err as Error).message }; }
  // Check caller authority before examining a requested root's contents/identities.
  const neverProblem = neverGrantProblem(never, g.grant ?? o.kept ?? {}, o.mode === "write" && o.worktree ? [o.worktree] : []);
  if (neverProblem) return { reason: !g.grant && o.mode === "write" ? keptGrantRefusal(keptGrantProblem(o.kept?.write_paths ?? [], cfg) ?? neverProblem) : neverProblem };
  const envProblem = environmentAdmission(caller.runId, target, g.grant?.env ?? []);
  if (envProblem) return { reason: envProblem };
  // Local network is a Codex-only mode of its network proxy (backends/codex-network.ts), which only
  // the person can allow, before the job's first turn under it (session.ts): refused up front where
  // nobody could be asked.
  // Raw network (stage 2) is a Codex write job's, in relay's own sandbox, which only the person can
  // allow, before the job's first turn under it (raw-network.ts rawNetworkConsent): the same.
  const raw = rawNetworkGrantProblem(g.grant, o.mode, target, cfg);
  if (raw) return { reason: raw };
  if (g.grant?.raw_network) {
    const person = personConsentAdmission(caller.runId, "grant.raw_network");
    if (person) return { reason: person };
  }
  if (g.grant?.local_network) {
    // While stage 2 is switched on, local mode is refused outright (raw-network.ts localModeRetired; decision D2).
    const retired = localModeRetired(cfg);
    if (retired) return { reason: `${retired}.` };
    if (target !== "codex") return { reason: `grant.local_network is for Codex write jobs only: ${targetLabel(targetDef(target))} has no mode in which its shell reaches this Mac's loopback and the local network. Omit it.` };
    const person = personConsentAdmission(caller.runId, "grant.local_network");
    if (person) return { reason: person };
  }
  const grant = g.grant ?? o.kept;
  const nativeNetwork = nativeCodexNeverNetworkProblem({ target: targetDef(target), config: cfg, access: o.mode, grant, neverPolicy: never });
  if (nativeNetwork) return { reason: nativeNetwork };
  // Config links and key locations may have changed since authorisation, or a legacy grant may
  // predate these exclusions. Recheck keep-outs without granting anew or replacing identity pins.
  if (!g.grant && o.mode === "write") {
    const kept = keptGrantProblem(o.kept?.write_paths ?? [], cfg);
    if (kept) return { reason: keptGrantRefusal(kept) };
  }
  // A session holding MCP servers has no network, and writes nowhere outside its worktree but by the person's leave (docs/extensions.md).
  if (o.servers && networkOn(cfg, grant)) return { reason: NO_NETWORK_WITH_SERVERS };
  if (o.servers && o.mode === "write" && grant?.write_paths?.length) return { reason: NO_WRITE_PATHS_WITH_SERVERS };
  const unable = capable(target, cfg, { mode: o.mode, network: networkOn(cfg, grant), writePaths: o.mode === "write" && Boolean(grant?.write_paths?.length), continues: o.continues });
  if (unable) return { reason: unable };
  // A directory Codex's sandbox cannot make writable, by its name (codexWriteRootProblem).
  if (target === "codex" && o.mode === "write") {
    for (const p of grant?.write_paths ?? []) {
      const why = codexWriteRootProblem(p);
      if (why) return { reason: `grant.write_paths entry ${JSON.stringify(p)} ${why}. Rename the directory, or give the work to another target.` };
    }
  }
  return { grant: g.grant };
}

/** Why a session holding MCP servers may not start or steer other agents (review C2/X1, X2). */
export const SERVERS_START_NOTHING =
  "your session holds MCP servers, so it may not start or steer other agents: they would not have its limits, and could reach the services past relay's gate. Do this part yourself, or say in your report what you needed.";

/**
 * Why a session holding MCP servers is given no write paths (review C2/X1): every request of such a
 * session, a file outside its worktree included, is the person's alone to allow, and a grant is the
 * root agent's.
 */
const NO_WRITE_PATHS_WITH_SERVERS =
  "a session given MCP servers gets no write paths outside its worktree: only the user may let it change a file outside it (it asks, and they decide each time), since such a file could be a way round relay's gate. Leave out either the write paths or the extensions.";

/** Why a session holding MCP servers is given no network (review C2/X1). */
const NO_NETWORK_WITH_SERVERS =
  "a session given MCP servers gets no network: with it, the agent could use credentials it can read to reach a server's service directly, past relay's gate, where only the user may allow each call. Leave out either the network grant or the extensions.";

/**
 * The extensions a call that starts a session asks for (extensions: true), resolved from the run's
 * config for its target, or why they cannot be given: only a root session gives them, as with
 * grants, so that nothing a launched agent starts holds one (review X2); only where relay can put
 * the consent to the person; not from a Codex subagent thread (SUBAGENT_EXTENSIONS); and a session
 * with servers gets no network, no write paths and may not delegate.
 */
export function admitExtensions(
  inst: Instance, caller: Caller, target: Target, o: { network: boolean; writePaths?: boolean; allowDelegation?: boolean }, call: Pick<ToolCall, "codexSubagent">,
): { extensions: SessionExtensions } | { reason: string } {
  if (caller.node) return { reason: "only the root session can give extensions. Omit extensions; if the work needs a skill or an MCP server, say so in your report." };
  const sub = subagentRefusal(call, "extensions");
  if (sub) return { reason: sub };
  // A target that takes none is said first: starting the work where the user can be asked would not change it.
  const none = takesNone(target);
  if (none) return { reason: none };
  // Consent is the person's alone to give, so a session where relay cannot put it to them gives none.
  if (!inst.host.confirmTool && !inst.host.personDialog) {
    const why = [inst.host.noElicit, inst.host.confirmWithheld].filter(Boolean).join("; ");
    return {
      reason: `only the user can consent to extensions, and relay asks them only ${PERSON_ROUTES}: this session has neither${why ? ` (${why})` : ""}. Omit extensions, or have the user start the work from a session where relay can ask them.`,
    };
  }
  // Sources belong to the person in this root process. A selected child environment would
  // replace CODEX_HOME with relay's config/login home, which is not a skill source catalog.
  const r = resolveExtensions(runConfig(caller.runId), target, process.env);
  if ("reason" in r) return r;
  if (r.mcp_servers.length && o.network) return { reason: NO_NETWORK_WITH_SERVERS };
  if (r.mcp_servers.length && o.writePaths) return { reason: NO_WRITE_PATHS_WITH_SERVERS };
  if (r.mcp_servers.length && o.allowDelegation) {
    return { reason: "a session given MCP servers may not start other agents: they would not have its limits. Omit allow_delegation (it is off for such a session), or leave out extensions." };
  }
  return { extensions: r };
}

/** The speeds `def` runs at, slowest first, no faster than `upTo`. */
const speedsOf = (def: TargetDef, upTo: Speed = "ultrafast"): Speed[] =>
  SPEEDS.filter((s) => (s === "standard" || def.speeds?.[s]) && speedRank(s) <= speedRank(upTo));
/** `pass speed: "fast" or "standard"`, for a remedy: the speeds given, fastest first. */
const passSpeed = (speeds: Speed[]) => `pass speed: ${[...speeds].reverse().map((s) => JSON.stringify(s)).join(" or ")}`;
const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Where the speed a call would run at came from, for what a refusal tells the caller to do: the
 * call, the session it continues, the launched agent's own speed, or targets.<id>.speed. Only for
 * the call's own speed is leaving it out a way to get another, so every remedy names a speed to pass.
 */
type SpeedSource = "call" | "session" | "inherited" | "configured";

/**
 * Why `def` cannot run at `speed`, from what relay knows up front, or null: a speed it does not
 * offer at all, or (Claude) a model that has no fast mode by its name. Whether the account offers
 * it is the harness's to say: Codex's catalog when the turn starts, Claude's report when it ends.
 * `upTo`: the fastest speed a remedy may name (a launched agent's own). `continues`: the call
 * carries on a session, whose model it cannot change.
 */
function speedUnavailable(def: TargetDef, target: Target, speed: Speed, o: { model: string | null | undefined; source: SpeedSource; upTo: Speed; continues: boolean }): string | null {
  if (speed === "standard") return null;
  const from = {
    call: "",
    session: ` The session this call carries on runs at ${speed}.`,
    inherited: ` Your own session runs at ${speed}, and the work you start runs at your speed unless you pass a slower one.`,
    configured: ` Relay's config sets targets.${target}.speed to ${speed}, the speed of a call that names none.`,
  }[o.source];
  const config = o.source === "configured" ? `, or change targets.${target}.speed` : "";
  const option = def.speeds?.[speed];
  if (!option) {
    const has = speedsOf(def, o.upTo);
    return `${def.name} has no ${speed} speed in relay: it runs at ${speedsOf(def).join(" or ")}.${from} ${capitalised(passSpeed(has))} instead${config}.`;
  }
  if (option.models && o.model && option.models.has(o.model) === false) {
    const remedy = passSpeed(speedsOf(def, "standard"));
    return `${def.name}'s ${speed} speed is for ${option.models.names} only, and this call would run ${JSON.stringify(o.model)}.${from} ` +
      `${o.continues ? capitalised(remedy) : `Name one of those with model, or ${remedy}`}${config}.`;
  }
  return null;
}

/** Why a Codex subagent thread may not ask for `speed` (review C6, as for grants), above what the person set up for it. */
const subagentSpeed = (cap: Speed, def: TargetDef) =>
  `this call comes from a Codex subagent thread, which no person is working in, so it cannot raise speed above what the user set up (${cap} for ${def.name}): a faster speed costs them money or allowance, and relay cannot tell that they asked for it. ` +
  `Leave speed out or ${passSpeed(speedsOf(def, cap))}, or return to the agent that started you and ask it to make this call itself, from its own thread.`;

/**
 * The speed a call's work runs at, or why it may not run at the one asked for. A faster speed
 * costs the person money or allowance, so only the root session raises it (decided 2026-10-16): the
 * work a launched agent starts or carries on runs at the agent's own speed unless it asks for a
 * slower one, and a Codex subagent thread's root session goes no higher than what the person set
 * up. Otherwise the call's speed, else the speed the session it continues goes on at (`current`,
 * db.ts speedAfter), else targets.<id>.speed, else standard. A launched agent's own speed is that of
 * the turn it is making the call from (speedOf: a speed the root has since asked for applies only
 * from the turn that call queued). `model`: the model the session would run, for a speed some
 * models lack. Every call that continues a session comes here, with `current`, whether or not it
 * names a speed: a launched agent the root has since slowed down may not carry on a faster session
 * (as authority refuses one with more access).
 */
export function admitSpeed(caller: Caller, target: Target, o: { speed?: Speed; current?: Speed; model?: string | null }, call: Pick<ToolCall, "codexSubagent">): { speed: Speed } | { reason: string } {
  const cfg = runConfig(caller.runId);
  const def = targetDef(target);
  const configured = cfg.targets[target]?.speed ?? "standard";
  const own = caller.node ? speedOf(caller.node) : null;
  const report = "if the work needs to be faster, say so in your report.";
  if (own !== null) {
    // Asked for, or carried on: either way no faster than the agent itself.
    const faster = o.speed ?? o.current;
    if (faster && speedRank(faster) > speedRank(own)) {
      const why = o.speed ? `you asked for ${o.speed}` : `the session this call carries on runs at ${o.current}`;
      return {
        reason: `only the root session can raise speed, since a faster speed costs the user money or allowance: ${why}, and you run at ${own}, so the work you start or carry on runs at ${own}${own === "standard" ? "" : " or slower"}. ` +
          `${capitalised(passSpeed(speedsOf(def, own)))} instead; ${report}`,
      };
    }
  }
  if (o.speed && !caller.node && call.codexSubagent) {
    const cap = speedRank(o.current ?? "standard") > speedRank(configured) ? o.current! : configured;
    if (speedRank(o.speed) > speedRank(cap)) return { reason: subagentSpeed(cap, def) };
  }
  // A session that is continued keeps its speed; new work of a launched agent takes the agent's own.
  const speed = o.speed ?? o.current ?? own ?? configured;
  const source: SpeedSource = o.speed ? "call" : o.current ? "session" : own !== null ? "inherited" : "configured";
  const no = speedUnavailable(def, target, speed, { model: o.model ?? cfg.targets[target]?.default_model, source, upTo: own ?? "ultrafast", continues: o.current !== undefined });
  return no ? { reason: no } : { speed };
}

/**
 * Keeps the speed a call that continues a session admitted (admitSpeed) for the turn `turnId` it
 * queues: inside the transaction that queues it, so that a call whose message is not taken changes
 * nothing. The session takes it only as that turn starts (session.ts startSpeed), so the turns
 * queued before it, and the one running now (whose launched agent's own speed caps what it starts),
 * keep the speed they were queued at; a turn that never starts changes nothing. Speeds kept for
 * turns no longer queued are dropped here.
 */
export function changeSpeed(nodeId: string, turnId: number, to: Speed): void {
  const n = getNode(nodeId);
  if (!n) return;
  const live = queuedTurnIds(nodeId);
  const kept = queuedSpeeds(n).filter(([t]) => live.has(t) && t !== turnId);
  setParam(nodeId, "speed_queued", Object.fromEntries([...kept, [turnId, to] as const].map(([t, s]) => [String(t), s])));
}

/**
 * The launched agent making a call, as a caller, while the turn its relay connection belongs to
 * lasts; null once it has ended. For cancel and merge, which are offered only to a turn that may
 * delegate and so check no depth and no allow_delegation.
 */
export function liveChild(ctx: Extract<Context, { kind: "child" }>): Caller | null {
  const node = getNode(ctx.nodeId);
  if (!node || !turnLive(ctx)) return null;
  return { runId: ctx.runId, node, depth: node.depth, cwd: workCwd(node), access: ctx.access, turnId: ctx.turnId };
}

/**
 * Whose request_ids these are: a root session's relay server process, one conversation of a shared
 * one, or one launched agent. A dedicated root's scope is its server process (its token). On a
 * shared process (the Claude desktop app's relay-desktop) each conversation's view carries the
 * owner hash of its session token instead, so conversations' ids never meet, and a restart keeps
 * them (session-token.ts).
 */
export function callScope(inst: Instance): string | null {
  return inst.ctx.kind === "root" ? `root:${inst.token}` : inst.ctx.kind === "child" ? `node:${inst.ctx.nodeId}` : null;
}
