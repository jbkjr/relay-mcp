import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { RelayStdioTransport } from "./stdio.js";
import { z } from "zod";
import { mcpHeldForJob, neverApprovalProblem, offLimits, requestApproval, turnGone, webGranted } from "../core/approvals.js";
import { checkpointNever } from "../core/never-checkpoint.js";
import { settingsAnswerForPerson, type Consent } from "../core/claude-settings.js";
import { loadContext } from "../core/context.js";
import { loadConfig, VERSION, withDefaults, type RelayConfig } from "../core/config.js";
import { db, getNode, getRun, registerSelf, runConfig } from "../core/db.js";
import { ancestorCommandLines } from "../core/procs.js";
import { callerVendor, canReadItem, canReadRun, familyOf, newInstance, refused, SINGLETON_REASON, UNAVAILABLE, type HostView, type Instance, type Json, type ToolCall } from "../core/caller.js";
import { callIdentity, opencodeSession, sessionDiagnostic, type CallIdentity } from "../core/identity.js";
import { hostSessionOwner, issueSessionToken, ownerBusy, sessionOwner, sessionView, SessionViews, TOKEN_SHAPE } from "../core/session-token.js";
import { adopt } from "../core/adoption.js";
import { getRequest } from "../core/approvals.js";
import { openRootEnvironment, closeRootEnvironment } from "../core/env-broker.js";
import { LONG_WAIT_S } from "../core/wait.js";
import { pendingEvents, watch } from "../core/watch.js";
import * as ops from "../core/ops.js";
import { markSeen, postNotice } from "../core/events.js";
import { takeDiagnosticProblems } from "../core/storage.js";
import { questionsThrough } from "./elicit.js";
import { offerGateway, openGateway, type Gateway } from "./gateway.js";
import { DESKTOP_WAIT_S, hostProfile, hostWaitCapS, registrationAgrees, type HostProfile, type StartEvidence } from "./host.js";
import { codexToolTimeoutS } from "../targets/codex.js";
import { isTarget, resolveTarget, SPEEDS, targetDef, targetLabel, targetEnabled, TARGET_IDS, TARGETS, type Target, type Vendor } from "../targets/index.js";
import * as steering from "../core/steering.js";
import { briefText, loadBriefs } from "../targets/briefs.js";
import { escalate, escalationReceiptDelivery } from "../core/escalations.js";
import { EscalationInputSchema } from "../core/escalation-policy.js";
import { refreshEscalationPersonPath } from "../core/escalation-contract.js";
import { stage2Enabled } from "../core/stage2-switch.js";

const VENDOR_STOP_TEXT = "A vendor safety stop returns refused with the vendor's message; relay never retries, rephrases or switches models or targets automatically. ";

/**
 * How to hear back about work, for the tools' descriptions, by what the host does
 * (experiments/answers.md): Claude Code in a terminal moves a long call to the background and
 * starts a turn when it completes; read-only calls run in parallel there and in Codex. Until the
 * host has introduced itself (profile null), the plain pattern.
 */
function hearBack(profile: HostProfile | null, blockS: number): string {
  if (profile?.waits === "background") {
    return "delegate returns at once. To be told when the job finishes, call status with its id and a long wait_s: in Claude Code's main conversation that call moves to the background after about two minutes and you are notified when it completes, so you can go on working meanwhile. " +
      `wait_s may be up to ${LONG_WAIT_S} (six hours) here. ` +
      "status and result are read-only, so several waits can run in parallel (one status call per item, in the same message).";
  }
  if (profile?.waits === "parallel") {
    return `delegate returns at once. To wait for the job, call status with its id and wait_s (relay ends a wait after ${blockS} s; call again to go on waiting); status and result are read-only, so several can run in parallel while you go on with other calls.`;
  }
  return `delegate returns at once. To wait for the job, call status with its id and wait_s (relay ends a wait after ${blockS} s; call again to go on waiting); status and result are read-only, so several waits can run in parallel.`;
}

const APPROVE_TEXT =
  "Decide an approval request from a launched agent (requests appear as needs_approval in status and in pending results; each one's effect says what allowing it does: run a command outside the sandbox with the user's full access, run one inside it, reach the web, change files outside its worktree). " +
  "Allow what the user has clearly authorized for this task; deny what they would not want; ask the user when unsure. " +
  "A request marked person_only (consent to extensions, a call of an MCP server's tool, any request of a session holding MCP servers) only the user can allow, in relay's question to them where your host shows it; approve can only deny it.";
// Claude Code's answer to a permission prompt has a message only for a denial (an allow carries
// the tool's input and nothing else), so a note with an allow does not reach a Claude agent.
const NOTE_TEXT =
  "Passed to the requesting agent with the decision, where its host can take it: a Claude agent gets it only with a denial (Claude Code's answer to a permission prompt has no place for a message on allow), a Codex agent as a message added to its running turn either way. An agent inside relay's own sandbox (ACP) does not get it.";
const CONFIRM_HINT = " To allow something on the user's own say-so through your host's permission prompt, use confirm instead (a person_only request too).";

/** What "for the rest of the job" does, per switched-on target, from what each can honour. */
function scopeText(cfg: RelayConfig): string {
  const per = TARGETS.filter((t) => targetEnabled(cfg, t.id)).map((t) => {
    if (t.capabilities.approvals === "acp") {
      return `${targetLabel(t)}: relay itself allows each later request of the job that is the same (same kind, same command, same directory, same files), once each, and never widens what the job was granted`;
    }
    if (t.approvals.channel === "in-band") return `${targetLabel(t)}: a command is allowed for the rest of its session by ${targetLabel(t)} itself${t.id === "codex" ? ", except one asking for access added to its sandbox, which is allowed once only" : ""}`;
    return `${targetLabel(t)}: a web search or fetch lets the job's later web searches and fetches go ahead without asking (its shell commands get no network from it); anything else is allowed once only`;
  });
  return `once (default): this one action. job: the rest of this job. ${per.join(". ")}.`;
}

/**
 * The brief tool's answer: the prompting brief for `requested`, or for the agent this caller reaches
 * by default. Hosts with relay's plugin also have it as a skill; this is how the others read it.
 */
function briefFor(own: Target | null, cfg: RelayConfig, requested: Target | undefined, vendor: Vendor | null): Json {
  const choice = requested ? { target: requested } : resolveTarget(own, undefined, cfg, { callerVendor: vendor });
  if (!("target" in choice)) throw new Error("Name the agent you are writing for as target.");
  const brief = loadBriefs()[choice.target];
  if (!brief) throw new Error(`relay has no prompting brief for ${targetLabel(targetDef(choice.target))}. Write the task to stand alone: the goal, the context it needs, what to hand back, and how to check it.`);
  return { target: choice.target, brief: briefText(targetDef(choice.target), brief) };
}

const grant = z.object({
  network: z.boolean().optional().describe("Allow network access from the job's sandbox."),
  env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional().describe("Exact names in child_env.request, never values. Only a person through confirm or a qualified dialog can release them, for this turn only. Resume needs fresh consent. Does not grant network."),
  write_paths: z.array(z.string()).optional().describe("Absolute directories outside the worktree the job may also write to."),
  raw_network: z.boolean().optional().describe("Codex write jobs only, with network: true, where relay's config switches stage 2 on (targets.codex.stage2). The job's shell gets raw network (TCP, UDP, ssh, DNS) inside relay's own sandbox: the internet, the local network and tailnet, and this Mac's loopback but denied ports; it may listen only on its own port block, and git cannot write inside it. Only the person can allow it, once per grant before the job's turn. Not with local_network."),
  local_network: z.boolean().optional().describe("Codex write jobs only, with network: true. The job's shell may also reach this Mac's loopback and the local network (its own dev server, say), not only the internet. Only the person can allow it, once per job before it starts; it opens every local service to the job."),
}).optional().describe("Extra permissions for a job: network (read or write jobs) and extra write paths (write jobs). Only the root session can grant them, normally because the task needs the web, the user asked, or a job reported that it was blocked.");
const readGrant = z.object({ network: grant.unwrap().shape.network, env: grant.unwrap().shape.env }).optional();
/**
 * Lets a caller repeat a call whose answer it never got (a timeout, say) without starting the work
 * twice. Matched per relay server process for a dedicated root session, and per session token on a
 * shared relay (caller.ts callScope).
 */
const requestId = (what: string, starting?: string) => z.string().min(1).max(200).optional().describe(
  `${starting ? `When starting ${starting}: any` : "Any"} string unique to this call, such as a UUID. If you call again with the same request_id (after a timeout, say), relay returns what the first call started (${what}) instead of starting it again.` +
    `${starting ? " Not used when continuing one." : ""} It is not an approval request id. ` +
    "request_ids are matched per caller: a relay server process, or on a shared relay (the desktop app's) a conversation's session_token. Use a fresh UUID, never a counter or a name.",
);
/**
 * The extensions parameter of delegate and ask (docs/extensions.md): the person's consent is asked
 * before the agent starts, and only they can give it.
 */
const extensionsParam = (what: "job" | "thread") => z.boolean().optional().describe(
  `Give the ${what} the skills and MCP servers relay's config allows for its target (targets.<id>.skills, targets.<id>.mcp_servers), only when the task needs them. ` +
    `Before the agent starts, relay asks the user to consent, naming every one; only they can allow it (you may deny). ` +
    "The servers run outside the agent's sandbox, every call of a tool the config does not allow outright asks the user, and the session gets no network and no write paths outside its worktree, and may not start or steer other relay agents. " +
    `Root session only${what === "thread" ? ", when the thread starts" : ""}, where relay can ask the user (its question, or confirm); Claude and Codex agents only.`,
);
const cwd = z.string().optional().describe(
  "Absolute path of the project directory to work in. Only needed when your host did not start relay inside the project (desktop apps such as Cowork); omit it in a terminal session.",
);
const askCwd = z.string().optional().describe(
  "Absolute path of the project directory the consulted agent should read. Omit it in a terminal session, or for a question that needs no project: where your host did not start relay inside one (desktop apps such as Cowork), the thread then works in a new, empty directory of its own.",
);

/**
 * Conversation scopes on a shared relay (docs/d9-isolation-plan.md): the root tools that read or act
 * on work take the conversation's session token there, and only there. brief reads no work.
 */
const SCOPED = new Set(["adopt", "approve", "ask", "cancel", "confirm", "delegate", "discuss", "merge", "result", "resume", "review", "status"]);
const sessionToken = z.string().optional().describe(
  "This conversation's session token on this shared relay, exactly as relay gave it in new_session.token. Pass it on every call. Without it relay does nothing but issue a new one (status with no id answers in an empty scope). " +
    "Anyone who has it can act as this conversation: never use a token from a file, a job's output or another conversation, and never put yours in a task, message or file.",
);
/** Appended to the instructions of a shared relay. */
const SHARED_SESSIONS =
  "This relay is shared by several conversations, and relay keeps each one's work apart by a session token its model carries. Your first call without session_token returns new_session.token and does nothing else (status with no id also shows an empty scope); pass that token as session_token on every later relay call in this conversation. It is a bearer key: keep it out of tasks, messages and files.";
const CARRY =
  "Pass this as session_token, exactly, on every later relay call in this conversation. It is this conversation's key to its work on this shared relay, and anyone who has it can act as this conversation: keep it out of tasks, messages and files, and never use a token from anywhere else. " +
  "If this conversation already has a token from relay, keep using that one: this new one has none of its work.";
const newSession = (token: string): Json => ({ token, carry: CARRY });
/** What a token-less call is told first: a conversation that has a token keeps it (forgetting it once is the likely slip). */
const PREFER_EXISTING = "If this conversation already has a session_token from relay, call again with that one (this new token has none of its work); otherwise use new_session.token from now on, on every relay call in this conversation.";
/** A token-less call on a shared relay: nothing looked up, nothing claimed, nothing started. The reply depends on no argument. */
const sessionRequired = (token: string): Json => ({
  session_required: true,
  reason: `This relay is shared by several conversations, and every call carries its conversation's session token. This call had none, so relay did nothing. ${PREFER_EXISTING}`,
  new_session: newSession(token),
});
/** Identical for every malformed, mistyped, forged or other relay home's token, on every tool. */
export const SESSION_UNAVAILABLE = (): Json => ({
  error: "Session unavailable.",
  recovery: "Pass session_token exactly as relay gave it to this conversation (new_session.token). If this conversation has none, call without session_token to get one: a new token has none of the earlier work. " +
    "To move that work to it, the person quits and reopens the app, then runs relay adopt from a terminal (relay cancel there stops it instead).",
});
/** A call on a host-keyed process (OpenCode 2) that names no session: nothing looked up, nothing claimed, nothing started. */
const HOST_KEY_MISSING = "this relay serves several OpenCode sessions and keeps each one's work apart by the session ID OpenCode puts on every call (_meta \"ai.opencode/sessionID\"). This call carried none, so relay did nothing. OpenCode 2.1.4 sends it on every MCP tool call; if yours does not, say so to the user.";
/** The calls that start or continue work, and so need the conversation's environment broker open first. */
const STARTS = ["delegate", "ask", "resume", "discuss", "review"];
/**
 * How often a root server looks at its runs (core/watch.ts), three times a second: how soon an
 * approval request is put to the user and an item's settling becomes a notice. A tick that finds
 * nothing changed costs a read of the registry's change mark, and the wake-up itself, which is most
 * of what an idle server spends; what goes by the clock (the person route's heartbeat, the reap of
 * dead workers) keeps its own pace whatever this is.
 */
const WATCH_TICK_MS = 333;
/** How often brokers of conversations that have gone idle are closed. */
const BROKER_SWEEP_MS = 10_000;
/** Whether any text of a call holds a token-shaped string: relay never passes one on. */
const holdsToken = (v: unknown): boolean =>
  typeof v === "string" ? TOKEN_SHAPE.test(v) : Array.isArray(v) ? v.some(holdsToken) : Boolean(v && typeof v === "object" && Object.values(v).some(holdsToken));

/** What the speed parameter is, for every tool that starts or continues a session. */
const SPEED_TEXT =
  "How fast the other agent's model answers: standard, fast, or ultrafast (Codex, where the account offers it). Unset: standard, unless targets.<id>.speed in relay's config says otherwise, " +
  "or, for a launched agent, its own speed. A faster speed costs the user money or allowance (Claude's fast mode, for Opus 5.5, 5 and 4.8, is billed to usage credits; " +
  "Codex's faster tiers use more of the plan), so pass one only when the user asks for it. Relay refuses a speed the agent or its model does not have, and for Codex " +
  "one the account's catalog does not offer, checked as the turn starts, before the model is asked anything; Claude can tell only once a turn has run, so a fast Claude " +
  "turn that ran at standard comes back with a warning. The work a launched agent starts or carries on runs at that agent's own speed or slower.";
const speed = z.enum(SPEEDS).optional().describe(SPEED_TEXT);
/** The speed parameter of a call that continues a session, which goes on at it from the turn the call queues. */
const goesOn = (what: string) => `${SPEED_TEXT} ${what} goes on at it from the turn this call queues; without speed, it keeps its own.`;

/** The stdio MCP server. It holds no accepted job state: it validates, writes registry rows, and waits. */
export async function serve(argv: string[], evidence?: Promise<StartEvidence> | null): Promise<void> {
  // The installer registers the server with the host it is being installed into. A --host that
  // names no host relay knows is a broken registration: it is refused, never guessed around.
  const { host, hostProblem, desktop } = hostFromArgs(argv);
  // Each ps the start evidence runs names the next process to ask, and is answered only when this
  // process's event loop runs, which it did not while the modules loaded. Let it run before the
  // server is set up and again before it connects, so that the next ps runs meanwhile.
  if (evidence) await evidenceTurns();
  const inst = newInstance(loadContext(argv, process.env, process.cwd()), process.cwd(), host);
  // A launched agent's relay server is a child of that agent. It says so, so that cleaning up
  // after the agent leaves it, and the workers it starts, alone.
  if (inst.ctx.kind !== "root") registerSelf("server", inst.ctx.kind === "child" ? inst.ctx.nodeId : null);
  // A turn given MCP servers: relay's gateway starts them before the harness is answered, so that
  // their tools are listed from the first tools/list (docs/extensions.md).
  const gateway = inst.ctx.kind === "child" && inst.ctx.extensions ? await openGateway(inst.ctx.extensions) : undefined;
  const transport = new RelayStdioTransport();
  // The host closing stdin means it has gone (or the launched agent's turn is over). Closing the
  // transport aborts the calls still running, so a permission prompt waiting for an answer
  // withdraws its request rather than waiting on for a turn nobody is in. The gateway's servers
  // go with it.
  process.stdin.once("end", () => {
    void transport.close().catch(() => {});
    void gateway?.close();
  });
  const server = relayServer(inst, { hostProblem, desktop, gateway, evidence: inst.ctx.kind === "root" ? evidence : null });
  if (evidence) await evidenceTurns();
  await server.connect(transport);
}

/** Three turns of the event loop: a finished process's answer comes in over three (its exit, its output's end, the close). */
async function evidenceTurns(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) await new Promise(setImmediate);
}

/**
 * The SDK's own JSON Schema validator, made when it first validates something (an answer to an
 * approval dialog: mcp/elicit.ts) rather than with every server: making it costs a server's start
 * more than a millisecond, and most servers never ask the user anything.
 */
function firstUseValidator(): jsonSchemaValidator {
  let ajv: AjvJsonSchemaValidator | undefined;
  return { getValidator: (schema) => (ajv ??= new AjvJsonSchemaValidator()).getValidator(schema) };
}

/**
 * The host family named by --host, or why the flag cannot be used (no flag: neither), and whether
 * the server was started from the Claude desktop app's own entry (--desktop, which the installer
 * writes there beside --host claude). Relays before the flag ignore it.
 */
export function hostFromArgs(argv: string[]): { host: Target | null; hostProblem?: string; desktop: boolean } {
  const desktop = argv.includes("--desktop");
  const at = argv.indexOf("--host");
  if (at < 0) return { host: null, desktop };
  const value = argv[at + 1];
  if (isTarget(value)) return { host: value, desktop };
  return {
    host: null,
    desktop,
    hostProblem: `relay was started with --host ${value === undefined ? "and no value" : JSON.stringify(value)}, which is not a host relay knows (${TARGETS.map((t) => targetLabel(t, t.id)).join(", ")}). ` +
      "Relay refuses every call until the registration is fixed: run relay install for this host again, or correct --host by hand.",
  };
}

/**
 * The family a root session's host is, from its client name, for a registration without --host
 * (an older install): only when exactly one target's names match. A name that matches several, or
 * none, says nothing, and the session is treated as one whose family relay cannot tell.
 */
/** An OpenCode 0.x or 1.x release, which stamps no session on its calls. */
export const opencodeLegacy = (version: string | undefined): boolean => /^[01]\.\d+\.\d+$/.test(version ?? "") && version !== "0.0.0";

export function familyFromClient(name: string | undefined): Target | null {
  const matches = TARGETS.filter((t) => t.clientNames.test(name ?? ""));
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * What every tool text and the instructions start with under the Claude desktop app's own entry,
 * which the app also passes into Code tab sessions, beside the relay Claude Code starts there.
 */
export const DESKTOP_STEER =
  "relay-desktop is the Claude desktop app's shared relay, for its chats and Cowork: in a session that also has relay's own tools (mcp__relay__*, as in a Code tab session), use those instead.";

/**
 * The relay tools for one instance, not yet connected. `relay mcp` connects them to stdio; the
 * broker (src/confine/broker.ts) connects them to a confined turn's socket. `desktop`: started from
 * the Claude desktop app's own entry (hostFromArgs).
 */
export function relayServer(inst: Instance, opts: { hostProblem?: string; desktop?: boolean; gateway?: Gateway;
  /** What the host profile reads of ps, asked as `relay mcp` started (host.ts startEvidence). */
  evidence?: Promise<StartEvidence> | null;
  /** Host-only no-effect handler for boundary tests; reached only for registered, validated tools. */
  toolHandler?: (name: string, args: Record<string, unknown>) => Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult>;
} = {}): McpServer {
  inst.desktopEntry = Boolean(opts.desktop);
  const ctx = inst.ctx.kind === "child" ? inst.ctx : null;
  const me = ctx ? getNode(ctx.nodeId) : undefined;
  // What this server offers comes from the policy of the one turn it was started for. A turn that
  // may not delegate gets a server only so its permission prompts have somewhere to go.
  const promptOnly = Boolean(ctx && !ctx.mayDelegate);
  // What the tools offer and say comes from the config that governs this server's calls: the
  // user's for a root session, the run's for a launched agent. If it cannot be read, every
  // registered target is offered, and the calls themselves say what is wrong.
  let governing: RelayConfig;
  try {
    governing = ctx ? (getRun(ctx.runId) ? runConfig(ctx.runId) : withDefaults({})) : inst.ctx.kind === "root" ? loadConfig() : withDefaults({});
  } catch {
    governing = withDefaults({});
  }
  const own = familyOf(inst);
  // The session's own family: its target's, or for a launched agent on a target judged per model, its model's.
  const mine = () => callerVendor(inst);
  // Whether the session has subagents of its own: a root's host has; a launched agent, as its target allows in this turn.
  const subagents = () => { const o = familyOf(inst); return !ctx || !o || steering.turnSubagents(o, ctx.access); };
  const target = z.enum(TARGET_IDS).optional().describe(steering.targetText(own, governing, opts.desktop, mine(), subagents()));
  const who = steering.reachDescription(own, governing, mine());
  // Under the desktop app's own entry: every text starts by saying which relay this is, and every
  // wait ends before the app's tool call times out (HostProfile.waitCapS, set again from the profile).
  const steer = (text: string) => (opts.desktop ? `${DESKTOP_STEER} ${text}` : text);
  if (opts.desktop && inst.ctx.kind === "root") inst.host.waitCapS = DESKTOP_WAIT_S;
  if (ctx && own === "codex") inst.host.waitCapS = hostWaitCapS(codexToolTimeoutS(governing.approval_timeout_s));
  /** How long relay lets a call wait here, for the tool texts. */
  const blockS = () => Math.min(governing.block_s, inst.host.waitCapS ?? Infinity);

  // A shared process (the desktop app's) scopes each call to the conversation whose session token
  // it carries (docs/d9-isolation-plan.md). OpenCode 2's is shared too, but scopes each call by the
  // session OpenCode stamps on it (keyed). Dedicated and unknown deployments keep one scope per process.
  const keyed = () => inst.ctx.kind === "root" && Boolean(inst.hostKey);
  const shared = () => inst.ctx.kind === "root" && sessionDiagnostic(inst).topology === "shared" && !inst.hostKey;
  const views = new SessionViews(inst);
  /** The instance each call acts as: its conversation's view on a shared process, else this one. */
  const scopes = new WeakMap<object, Instance>();
  const scoped = (extra: object): Instance => scopes.get(extra) ?? inst;
  /**
   * Conversations whose environment broker is open, by owner: closed once idle (no call acting as
   * the conversation and no work of its runs queued or running), and all with the server.
   */
  const brokered = new Map<string, Instance>();
  const openBroker = async (scope: Instance) => {
    await openRootEnvironment(scope);
    if (scope !== inst) brokered.set(scope.token, scope);
  };
  const closeIdleBrokers = () => {
    for (const [owner, view] of brokered) {
      if (views.inUse(owner) || ownerBusy(owner)) continue;
      brokered.delete(owner);
      void closeRootEnvironment(view);
    }
  };
  /** Adds session_token to the scoped tools when a client name, known only at initialization, makes this process shared. */
  const onShared: (() => void)[] = [];
  const sessionsNote = () => (shared() ? ` ${SHARED_SESSIONS}` : "");
  // A turn given MCP servers is told here, before it starts, which of them relay could not start
  // or offer (the gateway's warnings), as its result will say too: its preamble was written before.
  const gw = opts.gateway;
  const gatewayNote = gw
    ? ` This turn's MCP servers are offered as relay's tools named <server>__<tool>${gw.warnings.length ? `, but not all of them: ${gw.warnings.join("; ")}. Work without what is missing, and say so` : ""}.`
    : "";
  const server = new McpServer({ name: "relay", version: VERSION }, {
    instructions: steer(steering.instructions(own, governing, opts.desktop, mine(), subagents()) + " " + steering.noticeRule + gatewayNote + sessionsNote()),
    jsonSchemaValidator: firstUseValidator(),
  });
  // Before a tools/list response, the client has no stale list to invalidate. Coalesce a whole
  // identity/profile update (or several synchronous tool updates) through the SDK's public API.
  let toolsListed = false, initialized = false, dirtyTools = false, notifyingTools = false;
  const listRequests = new Set<string | number>();
  const notifyTools = server.sendToolListChanged.bind(server);
  const flushTools = () => {
    if (!initialized || !toolsListed || !dirtyTools || notifyingTools) return;
    notifyingTools = true;
    queueMicrotask(() => {
      notifyingTools = false;
      if (!initialized || !toolsListed || !dirtyTools || !server.isConnected()) return;
      dirtyTools = false;
      notifyTools();
    });
  };
  server.sendToolListChanged = () => {
    if (!toolsListed) return;
    dirtyTools = true;
    flushTools();
  };
  const onIdentity: (() => void)[] = [];
  const identities = new WeakMap<object, CallIdentity>();
  // Retain the public registration handles so identity-dependent text can be refreshed together.
  const registerTool: typeof server.registerTool = (name, config, cb) => {
    const invoke = cb as ToolCallback<z.ZodRawShape>;
    const scopedTool = inst.ctx.kind === "root" && SCOPED.has(name);
    const withSession = () => { config = { ...config, inputSchema: { ...(config.inputSchema as z.ZodRawShape), session_token: sessionToken } as unknown as typeof config.inputSchema }; };
    if (scopedTool && opts.desktop) withSession();
    const callback: ToolCallback<z.ZodRawShape> = async (args, extra) => {
      // XA-a: desktop evidence can first arrive with a tools/call. It only revokes the
      // connection's dialog qualification; absence on a later call never re-enables it.
      const turn = (extra._meta as Record<string, unknown> | undefined)?.["x-codex-turn-metadata"];
      if (!codexDesktop && turn && typeof turn === "object" && "client_type" in turn && turn.client_type === "desktop_app") {
        codexDesktop = true;
        profiled = false;
        for (const ctl of inst.asking.values()) ctl.abort();
      }
      configureProfile();
      if (inst.ctx.kind === "poisoned") return plain(refused(`relay context for this agent could not be loaded (${inst.ctx.reason}).${["delegate", "ask", "resume", "discuss", "review"].includes(name) ? " Continue without delegating, consulting, or starting discussions." : ""}`));
      let a = args as Record<string, unknown>;
      // The call proper, once it is known which instance it acts as.
      const act = async (scope: Instance, issued: string | undefined): Promise<CallToolResult> => {
        if (scopedTool && shared() && holdsToken(a)) return plain(refused("this call's text holds a session token. Relay never passes one to another agent or into its records: take it out and call again, and keep tokens out of tasks, messages and files."));
        scopes.set(extra, scope);
        try {
          const client = server.server.getClientVersion();
          // SDK 1.x negotiates the initialize-based protocol. Initialize is connection evidence;
          // only this request supplies session and model metadata; neither is cached from a call.
          identities.set(extra, callIdentity(scope, extra._meta as Record<string, unknown> | undefined, protocol, client));
        } catch {
          return plain(refused("invalid session metadata; this call cannot be used."));
        }
        if (configProblem) return plain({ error: configProblem });
        if (scope.ctx.kind === "root") refreshEscalationPersonPath(scope.token, { confirm: scope.host.confirmTool === true, dialog: scope.host.personDialog === true && !!scope.host.elicit });
        if (inst.singletonViolation) {
          for (const ctl of inst.asking.values()) ctl.abort();
          if (name === "status" && a.id === undefined) return plain({ session: identities.get(extra)!.session });
          if (name !== "brief") return plain(refused(identities.get(extra)!.session.reason));
        }
        // Notice verification ignores all item arguments until the pointer has been checked.
        for (const key of name === "status" && a.notice ? [] : ["id", "job_id", "thread_id", "discussion_id", "review_id", "with", ...(["approve", "confirm"].includes(name) ? ["request_id"] : [])]) {
          const id = a[key];
          if (typeof id !== "string") continue;
          const allowed = key === "request_id" ? Boolean(getRequest(id) && canReadRun(scope, getRequest(id)!.run_id)) : canReadItem(scope, id);
          if (!allowed) return plain(UNAVAILABLE());
        }
        if (inst.ctx.kind === "root" && STARTS.includes(name)) await openBroker(scope);
        else if (inst.ctx.kind === "root" && (["approve", "confirm", "adopt"].includes(name) || (name === "status" && a.id !== undefined && !a.notice))) {
          // These can start a worker for recovered work (status redispatches, a decision lets a
          // stalled turn on, an adopted run's next turn): its broker must be there for it. Best effort:
          // a read is not refused for want of one, and a worker without one fails closed, saying so.
          try { await openBroker(scope); } catch { /* The worker says what is missing. */ }
        }
        const result = opts.toolHandler ? await opts.toolHandler(name, a) : await invoke(a, extra);
        if (name === "escalate" && ctx && result.content?.[0]?.type === "text") {
          const value = JSON.parse(result.content[0].text);
          if (value.state === "restart_pending" && typeof value.request_id === "string" && typeof value.request_digest === "string") {
            const finish = escalationReceiptDelivery(value.request_id, value.request_digest, extra.signal);
            const delivery = { finish, signal: extra.signal };
            escalationDeliveries.set(extra.requestId, delivery);
            if (closed || extra.signal.aborted) {
              escalationDeliveries.delete(extra.requestId);
              await finish(false);
            }
          }
        }
        if (inst.singletonViolation && name !== "brief") return plain(refused(SINGLETON_REASON));
        if (name === "status" && result.content?.[0]?.type === "text") {
          const value = JSON.parse(result.content[0].text) as Json;
          if (value.error !== "Item unavailable." && !value.refused) {
            return plain({
              ...value, session: identities.get(extra)!.session, ...(inst.ctx.kind === "root" ? { approval_dialogs: inst.host.approvalDialogs } : {}),
              // A token-less status: the conversation's own token, if it has one, is the one to use.
              ...(issued ? { note: PREFER_EXISTING, new_session: newSession(issued) } : {}),
            });
          }
        }
        return result;
      };
      // On a shared process the call acts as the conversation its token names, decided before any
      // lookup. Without a token: plain status answers in a fresh, empty scope; every other call does
      // nothing. An invalid token gets one reply whatever the call names. Never the process's scope.
      let scope = inst;
      let issued: string | undefined;
      let pinned: Instance | undefined;
      if (scopedTool && shared()) {
        const { session_token: carried, ...rest } = a;
        a = rest;
        try {
          if (carried === undefined) {
            issued = issueSessionToken();
            scope = sessionView(inst, sessionOwner(issued)!);
            if (!(name === "status" && a.id === undefined && a.notice === undefined)) return plain(sessionRequired(issued));
          } else {
            const owner = sessionOwner(carried);
            if (!owner) return plain(SESSION_UNAVAILABLE());
            // Pinned for the whole call, so that the cache never gives one conversation two views.
            scope = pinned = views.acquire(owner);
          }
        } catch (err) {
          return plain({ error: `relay could not resolve this conversation's session: ${(err as Error).message}` });
        }
      } else if (scopedTool && keyed()) {
        // Never the process's scope, and never the last session's: each call names its own.
        let key: string | undefined;
        try {
          key = opencodeSession(extra._meta as Record<string, unknown> | undefined);
        } catch {
          return plain(refused("invalid session metadata; this call cannot be used."));
        }
        if (key === undefined) return plain(refused(HOST_KEY_MISSING));
        try {
          scope = pinned = views.acquire(hostSessionOwner(inst, inst.hostKey!, key), "host-key");
        } catch (err) {
          return plain({ error: `relay could not resolve this session's scope: ${(err as Error).message}` });
        }
      }
      try {
        return await act(scope, issued);
      } finally {
        if (pinned) views.release(pinned);
      }
    };
    const tool = server.registerTool(name, config, callback as typeof cb);
    if (scopedTool && !opts.desktop) onShared.push(() => {
      withSession();
      tool.update({ paramsSchema: config.inputSchema as z.ZodRawShape });
    });
    onIdentity.push(() => {
      const params: Record<string, z.ZodType> = { ...config.inputSchema } as Record<string, z.ZodType>;
      let changedParams = false;
      for (const key of Object.keys(params)) if (params[key] === target) {
        params[key] = z.enum(TARGET_IDS).optional().describe(steering.targetText(familyOf(inst), governing, opts.desktop, mine(), subagents()));
        changedParams = true;
      }
      const description = config.description?.replace(`(${who})`, `(${steering.reachDescription(familyOf(inst), governing, mine())})`);
      if (changedParams || description !== config.description) tool.update({ description, ...(changedParams ? { paramsSchema: params } : {}) });
    });
    return tool;
  };
  let identified = false;
  const identify = () => {
    if (identified || inst.ctx.kind !== "root") return;
    const client = server.server.getClientVersion();
    if (!client) return;
    identified = true;
    inst.clientName = client.name ?? "";
    if (inst.family && !registrationAgrees(inst.family, inst.clientName, opts.desktop)) {
      inst.registration = { host: inst.family, client: inst.clientName };
      inst.family = null;
      console.error(`relay: --host ${inst.registration.host} contradicts clientInfo ${JSON.stringify(inst.clientName)}; caller family unknown. Check the registration (relay doctor).`);
    }
    if (!inst.family && !inst.registration && !opts.hostProblem) inst.family = familyFromClient(client.name);
    // OpenCode 2 serves every session of its background service from this one process, and stamps
    // each call with its session (seen on 2.1.4); 1.x sends no such stamp, and keeps one scope.
    // Only a 0.x or 1.x release is taken for 1.x: OpenCode's own builds also say "local", "unknown"
    // or "0.0.0-dev-…" (its beta and dev channels), which are 2.x code, so they are keyed too, and
    // fail closed if they do not stamp.
    if (!opts.desktop && /^opencode$/i.test(inst.clientName) && !opencodeLegacy(client.version)) inst.hostKey = "opencode-session";
    // The app's Cowork connection without --desktop (an older entry) is shared too: its tools take
    // session_token from before the first tools/list, as the --desktop entry's do from the start.
    if (!opts.desktop && shared()) for (const share of onShared) share();
  };
  let adapted = false;
  const adaptIdentity = () => {
    if (!identified || adapted) return;
    adapted = true;
    if (familyOf(inst) !== own) for (const adapt of onIdentity) adapt();
  };
  // The SDK records clientInfo before sending initialize's result. Adapt that result through the
  // public transport, without depending on private SDK fields or a client-controlled notification.
  const connect = server.connect.bind(server);
  type Delivery = { given: number[]; approvals: string[]; scope: Instance; signal?: AbortSignal; cleanup: () => void };
  const deliveries = new Map<string | number, Delivery>();
  const escalationDeliveries = new Map<string | number, { finish: (delivered: boolean) => Promise<void>; signal: AbortSignal }>();
  const callStarted = new Map<string | number, number>();
  let closed = false;
  let protocol = "legacy";
  // What the host profile is built from that comes in after the server starts: the start evidence,
  // and for a Codex client the registration that sets its waits (hosts/codex.ts, loaded only for
  // one). Until each is in, every message but initialize waits for it (below), in the order it came:
  // only those can build the profile.
  let evidence: StartEvidence | null = null;
  let codexHost: typeof import("../hosts/codex.js") | undefined;
  let pending = 0;
  let held: Promise<void> = Promise.resolve();
  let heldCount = 0;
  const holdFor = (what: Promise<void>) => {
    pending++;
    const done = what.finally(() => { pending--; });
    held = held.then(() => done);
  };
  if (opts.evidence) holdFor(opts.evidence.then((e) => { evidence = e; }, () => {}));
  server.connect = async (transport) => {
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if ("id" in message && message.id !== undefined && listRequests.delete(message.id) && "result" in message) toolsListed = true;
      if ("result" in message && message.result && "protocolVersion" in message.result) {
        protocol = String(message.result.protocolVersion);
        identify();
        // The gateway's note too: a turn given MCP servers is told here which of them relay could not offer.
        message = { ...message, result: { ...message.result, instructions: steer(steering.instructions(familyOf(inst), governing, opts.desktop, mine(), subagents()) + " " + steering.noticeRule + gatewayNote + sessionsNote()) } };
        await send(message, options);
        adaptIdentity();
        return;
      }
      const delivery = "id" in message && "result" in message ? deliveries.get(message.id) : undefined;
      const escalation = "id" in message && message.id !== undefined ? escalationDeliveries.get(message.id) : undefined;
      let sent = false;
      try {
        await send(message, options);
        sent = true;
        if (delivery && !closed && !delivery.signal?.aborted && !inst.singletonViolation) {
          try {
            markSeen(delivery.given);
            for (const id of delivery.approvals) delivery.scope.handedOff.add(id);
          } catch { /* A later result may repeat it with the same event_id. */ }
        }
      } finally {
        if (escalation && "id" in message && message.id !== undefined) {
          escalationDeliveries.delete(message.id);
          await escalation.finish(sent && !closed && !escalation.signal.aborted);
        }
        delivery?.cleanup();
        if ("id" in message && message.id !== undefined && ("result" in message || "error" in message)) callStarted.delete(message.id);
      }
    };
    // The SDK sets the transport's onmessage as it connects and then starts the transport, which is
    // when messages can first come (stdio starts reading; an in-memory pair hands over what it
    // queued): wrapped there, every message comes through this, initialize included.
    const start = transport.start.bind(transport);
    transport.start = async () => {
      const receive = transport.onmessage?.bind(transport);
      transport.onmessage = (message, extra) => {
        if ("method" in message && message.method === "tools/list" && "id" in message) listRequests.add(message.id);
        if ("method" in message && message.method === "tools/call" && "id" in message) callStarted.set(message.id, Date.now());
        if ("method" in message && message.method === "notifications/cancelled" && message.params?.requestId !== undefined) callStarted.delete(message.params.requestId as string | number);
        const initialize = "method" in message && message.method === "initialize";
        if (initialize && !codexHost && inst.ctx.kind === "root" && /^codex-mcp-client$/i.test(String((message.params?.clientInfo as { name?: unknown } | undefined)?.name ?? ""))) {
          // A module the server cannot do without for this host: one that does not load ends it, as at its start.
          holdFor(import("../hosts/codex.js").then((m) => { codexHost = m; }, (err) => {
            console.error(err instanceof Error ? err.stack : err);
            process.exit(1);
          }));
        }
        if (heldCount === 0 && (pending === 0 || initialize)) return receive?.(message, extra);
        heldCount++;
        held = held.then(() => {
          heldCount--;
          // Delivered as the transport would have, where it would have: not after it closed.
          if (closed) return;
          try {
            receive?.(message, extra);
          } catch (err) {
            transport.onerror?.(err as Error);
          }
        });
      };
      await start();
    };
    await connect(transport);
    const onclose = transport.onclose?.bind(transport);
    transport.onclose = () => {
      closed = true;
      for (const delivery of deliveries.values()) delivery.cleanup();
      for (const delivery of escalationDeliveries.values()) void delivery.finish(false).catch(() => {});
      escalationDeliveries.clear();
      callStarted.clear();
      onclose?.();
    };
  };
  // A config that is not valid must not take the server down where nobody sees why. The server
  // starts, and every call answers with what is wrong.
  let configProblem: string | null = opts.hostProblem ?? null;
  let askUser: RelayConfig["ask_user"] = "never";
  if (inst.ctx.kind === "root") {
    try {
      askUser = loadConfig().ask_user;
    } catch (err) {
      configProblem ??= (err as Error).message;
    }
  }

  // Codex starts a relay server for each of its threads, so a native Codex subagent (one an agent
  // started with spawn_agent) has a root session of its own, with no person in its conversation.
  // Codex marks such a thread's calls in their _meta. From one, relay takes a denial but not an allowance,
  // nor a grant (caller.ts subagentRefusal, review C6).
  /** Tool changes that wait for the host's profile, known once it has introduced itself. */
  const onProfile: ((p: HostProfile) => void)[] = [];
  let profiled = false;
  let codexDesktop = false;
  let watching = false;
  const configureProfile = () => {
    if (inst.ctx.kind !== "root") return;
    identify();
    adaptIdentity();
    if (profiled || !server.server.getClientVersion()) return;
    profiled = true;
    const client = server.server.getClientVersion();
    // A registration without --host (an older install) still says who is connecting, when its
    // client name matches exactly one target. An invalid --host is not guessed around.
    // How the host was started: Claude Code's parent is this server, or one wrapper above it.
    // Null where relay could not inspect them: then nothing there is read as a person's answer.
    // The start evidence serves the first profile; one built again (codexDesktop) reads afresh.
    const early = evidence;
    evidence = null;
    let started: string[] | null = null;
    if (early) started = early.started;
    else {
      try {
        started = ancestorCommandLines(3);
      } catch {
        started = null;
      }
    }
    // And how its settings are: only for Claude Code, and only permissions.defaultMode and whether
    // hooks can answer for the person in relay's dialog or for its confirm tool
    // (src/core/claude-settings.ts). Unreadable counts as answering.
    let settingsAnswer: Consent | string | null = null;
    if (/^claude-code$/i.test(client?.name ?? "")) {
      try {
        settingsAnswer = settingsAnswerForPerson(process.env, process.cwd(), started ?? []);
      } catch (err) {
        settingsAnswer = `relay could not read Claude Code's settings (${String((err as Error).message).slice(0, 80)})`;
      }
    }
    const caps = server.server.getClientCapabilities();
    const profile = hostProfile(process.env, client, Boolean(caps?.elicitation), started, settingsAnswer, { desktopEntry: opts.desktop, codexDesktop: codexDesktop || Boolean(caps?.extensions && Object.hasOwn(caps.extensions, "io.modelcontextprotocol/ui")) });
    const host: HostView = { recognised: profile.recognised, longWaits: profile.longWaits, waitCapS: profile.waitCapS };
    if (/^codex-mcp-client$/i.test(client?.name ?? "")) {
      host.waitCapS = Math.min(host.waitCapS ?? Infinity, hostWaitCapS(codexHost!.registeredCodexToolTimeoutS()));
    }
    // Tests set the tool-call wait cap (ms) small, to exercise the shared per-call deadline without
    // waiting the real desktop cap. The production default is the host profile's.
    const capMs = Number(process.env.RELAY_WAIT_CAP_MS);
    if (capMs > 0) {
      host.waitCapS = capMs / 1000;
      host.longWaits = false;
    }
    // In Claude Code a notice posted to the session's inbox socket starts a turn when the session is
    // idle, and is read after the current tool call when it is busy. Only a Claude Code session,
    // registered as such, posts there: the variable alone is also in the environment of anything
    // started from a Claude Code session (a smoke root, a Codex CLI), whose notices would land in it.
    const inbox = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    if (inbox && profile.inbox && inst.family === "claude") {
      const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
      host.notice = (text, id) => void postNotice(inbox, token, text, id);
    }
    // What the host can do decides which tools it gets and what they say.
    host.confirmTool = profile.confirm;
    host.formStays = !profile.withdraws;
    host.confirmWithheld = profile.confirmWithheld;
    // No setting bypasses surface qualification: with no reliable idle/busy signal, the
    // dialog must be qualified in both states. Withheld questions stay in next-call events.
    const ask = askUser !== "never" && profile.elicit === "dialog";
    if (ask) host.elicit = elicitThrough(profile);
    else host.noElicit = askUser === "never" ? 'ask_user is "never"' : profile.why;
    host.approvalDialogs = { offered: ask, reason: host.noElicit ?? profile.why };
    // Only a question a person is known to see can allow a person-only request (elicit.ts).
    host.personDialog = ask && profile.elicit === "dialog";
    // Replace the view whole, also when desktop evidence revokes a previous qualification.
    inst.host = host;
    for (const adapt of onProfile) adapt(profile);
    // Approval requests are put to the user as soon as they are filed, whether or not a call is waiting.
    if (watching) return;
    watching = true;
    let ticks = 0;
    const timer = setInterval(() => {
      // Each conversation of a shared process is watched as its own root session.
      for (const one of [inst, ...views.all()]) {
        try {
          watch(one);
        } catch {
          // The registry is busy or gone; the next tick tries again.
        }
      }
      if (++ticks % Math.round(BROKER_SWEEP_MS / WATCH_TICK_MS) === 0) {
        try { closeIdleBrokers(); } catch { /* Next time. */ }
      }
    }, WATCH_TICK_MS);
    timer.unref();
    server.server.onclose = () => {
      clearInterval(timer);
      for (const one of [inst, ...views.all()]) for (const ctl of one.asking.values()) ctl.abort();
      void closeRootEnvironment(inst);
      for (const view of brokered.values()) void closeRootEnvironment(view);
      brokered.clear();
    };
  };
  server.server.oninitialized = () => {
    initialized = true;
    configureProfile();
    flushTools();
  };

  /** Asks the user about one request through the host, and says how it ended (mcp/elicit.ts). */
  const elicitThrough = questionsThrough(server);

  type ReplyExtra = { requestId: string | number; signal?: AbortSignal };
  type Extra = ReplyExtra & { _meta?: { progressToken?: string | number }; sendNotification: (n: never) => Promise<void> };
  /**
   * What a waiting call needs from its request: progress notifications, which keep the host's
   * idle timer from firing and show what the awaited item is doing, and the request's abort
   * signal, which a cancellation of the call fires (it stops the wait, never the work).
   */
  const toolCall = (extra: Extra): ToolCall => {
    const identity = identities.get(extra);
    const token = extra._meta?.progressToken;
    let n = 0;
    const onTick = token === undefined ? undefined : (elapsedMs: number, message?: string) => {
      void extra
        .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message: message ?? `waiting (${Math.round(elapsedMs / 1000)}s)` } } as never)
        .catch(() => {});
    };
    // Count from receipt, including setup before the first wait: every nested wait shares it.
    const capS = inst.host.waitCapS;
    const deadline = capS != null ? (callStarted.get(extra.requestId) ?? Date.now()) + capS * 1000 : undefined;
    return { onTick, signal: extra.signal, deadline, identity, hostModel: identity?.hostModel, codexSubagent: identity?.codexSubagent };
  };
  const plain = (value: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  /**
   * The result of a tool call. Whatever the session has not heard yet rides along, so nothing is
   * missed where no notice can be posted (Codex) or a notice went unread. Preparing a result does
   * not acknowledge events: only a successful transport write, for a live call, does that. A
   * cancelled call or closed/failed transport leaves them pending. Host wait deadlines return
   * before a host that silently drops late replies can time out. Diagnostic logs this server
   * could not write (storage.ts) come once each in the result's warnings.
   */
  const reply = (value: Json, extra: ReplyExtra) => {
    if (value.error === "Item unavailable." || inst.singletonViolation) return plain(value);
    let out = value;
    // Only the events of the conversation this call acts as (its view on a shared process).
    const scope = scoped(extra);
    if (!extra.signal?.aborted && !closed) {
      try {
        // Replies have always initialized the registry, even before this session starts work.
        // Keep that separate from acknowledging events after the transport write completes.
        db();
        const { events, given } = pendingEvents(scope, value);
        const approvals = Array.isArray(value.needs_approval)
          ? (value.needs_approval as Json[]).map((r) => r.request_id).filter((id): id is string => typeof id === "string") : [];
        if (given.length || approvals.length) {
          const cleanup = () => {
            deliveries.delete(extra.requestId);
            extra.signal?.removeEventListener("abort", cleanup);
          };
          deliveries.set(extra.requestId, { given, approvals, scope, signal: extra.signal, cleanup });
          extra.signal?.addEventListener("abort", cleanup, { once: true });
        }
        if (events.length) out = { ...value, events };
      } catch {
        // The registry is busy; the events come with a later result.
      }
      // On a shared process only relay's own diagnostics and this conversation's: a worker.log's
      // failure names its run's paths. The process's own scope (brief) hears relay's own only.
      const unlogged = takeDiagnosticProblems(shared() || keyed() ? (scope.carried || scope.keyed ? scope.token : null) : undefined);
      if (unlogged.length) out = { ...out, warnings: [...(Array.isArray(out.warnings) ? (out.warnings as string[]) : []), ...unlogged] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  };
  const guard = async (extra: ReplyExtra, fn: () => Promise<Json> | Json) => {
    configureProfile();
    if (configProblem) return reply({ error: configProblem }, extra);
    try {
      const value = await fn();
      return reply(value, extra);
    } catch (err) {
      return reply({ error: (err as Error).message }, extra);
    }
  };

  if (!promptOnly && !ctx) registerTool("adopt", {
    description: steer("Explicitly take over an orphaned run, including all its jobs, approval requests and pending events, into this connection. Pass any job, thread, discussion, review or run id as run_id and this status session's fingerprint as into_session. In a qualified Claude Code host, pass in_directory and item_count exactly as that run's adoption description reports them, so the person's permission prompt describes the whole run they are transferring. " +
      (opts.desktop ? "On relay-desktop adoption is terminal-only: its app Allow prompt does not authorize a transfer. " : "") +
      "On hosts without a qualified prompt, the person must first run relay adopt <id> --to <fingerprint> in a terminal and confirm the printed transfer. user_confirmed never authorizes adoption."),
    inputSchema: {
      run_id: z.string(), into_session: z.string(),
      in_directory: z.string().optional().describe("Required for a host permission prompt: exactly adoption.in_directory reported for this run."),
      item_count: z.number().int().nonnegative().optional().describe("Required for a host permission prompt: exactly adoption.item_count reported for this run."),
    },
    _meta: { "anthropic/requiresUserInteraction": true },
  }, (a, extra) => guard(extra, () => adopt(scoped(extra), a.run_id, a.into_session, toolCall(extra as never), a)));

  // Claude sends its permission prompts here (Codex asks through the app server). Whether this
  // turn may ask at all is part of its policy (approval requests on, and not full access); that
  // includes discussion turns, which, being read-only, may ask only for the web or a command.
  // Escalation is a child capability request, independent of permission-prompt/delegation tools.
  if (ctx?.mayAsk && me?.target === "codex" && governing.codex_backend === "app-server" && stage2Enabled(process.env, governing)) registerTool("escalate", {
    description: "Request explicit capabilities for one new turn, then return restart_pending and end this turn. This tool executes no command. The authenticated owning run root may approve clearly authorized narrow work (port-0 for tests/servers); broad raw/local network and configured person-only effects require a qualified person channel. The command runs worktree code that the agent can edit after approval. Port-0 may bind 0.0.0.0, so it is on the LAN. Never and authority protections always win. Unsupported backends return capability_unavailable.",
    inputSchema: EscalationInputSchema,
  }, (a, extra) => guard(extra, () => escalate(inst, a, { signal: extra.signal, requestId: extra.requestId, sessionId: extra.sessionId, onTick: toolCall(extra).onTick })));
  const approvals = me?.target ? targetDef(me.target).approvals : null;
  if (ctx && approvals?.channel === "relay-tool" && ctx.mayAsk) {
    const nodeId = ctx.nodeId;
    const tool = approvals.tool;
    registerTool("permission_prompt", {
      description: "Used by the host to decide permission prompts. Not for direct use.",
      inputSchema: tool.inputSchema,
    }, async (a, extra) => {
      const call = a as Record<string, unknown>;
      const ask = tool.toAsk(call);
      const answerWith = (decision: Parameters<typeof tool.reply>[1]) => ({ content: [{ type: "text" as const, text: JSON.stringify(tool.reply(call, decision)) }] });
      if (me && (ask.kind === "file" || ask.kind === "path")) {
        const why = offLimits(me, ask.paths ?? [], ask.kind === "path" ? "reach" : "change");
        if (why) return answerWith({ allow: false, message: why });
      }
      try {
        const policy = checkpointNever(ctx.runId, "approval");
        const why = neverApprovalProblem(policy, ask.kind, ask.paths ?? [], me?.worktree ?? me?.cwd ?? inst.cwd);
        if (why) return answerWith({ allow: false, message: why });
      } catch (err) { return answerWith({ allow: false, message: (err as Error).message }); }
      // Web access already granted for this job (up front, or by an earlier "rest of the job" approval).
      if (ask.kind === "web" && webGranted(nodeId)) return answerWith({ allow: true });
      // A read-only session can ask for the web or for a command, nothing else. Reads outside its
      // directory and the like are refused as before, without bothering anyone.
      if (ctx.access === "read" && ask.kind !== "web" && ask.kind !== "command") {
        return answerWith({ allow: false, message: "Not available in this read-only session. Continue without it." });
      }
      // The wait ends when the turn does (requestApproval checks it on every look) or when this
      // call goes away: cancelled, or its connection closed, which the SDK reports by aborting the signal.
      const signal = (extra as { signal?: AbortSignal }).signal;
      const answer = await requestApproval(nodeId, ctx.turnId, ask, () => Boolean(signal?.aborted), toolCall(extra as never).onTick);
      return answerWith(answer.allow
        ? { allow: true }
        : { allow: false, message: `Not approved${answer.note ? ` (${answer.note})` : ""}. Do not work around this; continue without it and say what you needed.` });
    });
  }
  // The tools of the MCP servers this turn was given, through relay's gateway: every call the
  // config does not allow outright is an approval request only the person can allow, filed for
  // this turn and answered within it (docs/extensions.md). Offered whether or not it may delegate.
  if (ctx && opts.gateway) {
    const nodeId = ctx.nodeId;
    offerGateway(server, opts.gateway, async (call, extra) => {
      if (mcpHeldForJob(nodeId, call.server, call.tool)) return { allow: true };
      return requestApproval(nodeId, ctx.turnId, { kind: "mcp", summary: call.summary, detail: { server: call.server, tool: call.tool } }, () => Boolean(extra.signal?.aborted), extra.onTick);
    }, (extra) => toolCall(extra as never).onTick, () => turnGone(nodeId, ctx.turnId));
  }
  if (promptOnly) return server;
  let approveTool: ReturnType<typeof registerTool> | undefined;
  if (inst.ctx.kind !== "child") {
    approveTool = registerTool("approve", {
      description: steer(APPROVE_TEXT),
      inputSchema: {
        request_id: z.string(), decision: z.enum(["allow", "deny"]), note: z.string().optional().describe(NOTE_TEXT),
        scope: z.enum(["once", "job"]).optional().describe(scopeText(governing)),
        user_confirmed: z.boolean().optional().describe("Set only when the user has told you, in this conversation, to allow this specific request. Needed to allow a request the user is being asked about directly or has closed without answering."),
      },
    }, (a, extra) => guard(extra, () => ops.approve(scoped(extra), a, toolCall(extra))));
  }
  // A host that asks the user before every call of a tool marked requiresUserInteraction (Claude
  // Code, even with relay allowed and in auto mode, and from background subagents; the desktop app
  // as "Deny / Allow once") makes that prompt the user's decision. Only such a host, positively
  // identified, gets confirm; anywhere else a call would be the agent's word alone.
  if (inst.ctx.kind === "root") {
    const confirmTool = registerTool("confirm", {
      description: steer(
        "Allow a launched agent's approval request with the user's own say-so: your host asks the user (Yes/No) before this call goes ahead, even with relay's tools allowed and in auto mode. " +
        "Use it to allow something the user has not clearly authorized, a request whose approval dialog they closed, or any request when relay could not show them one. " +
        "Pass request_id, from, kind, effect, in_directory and wants exactly as needs_approval shows them (the same characters, line breaks included); relay allows only a pending request of this session whose details match. " +
        "A request marked person_only is allowed only here or in relay's question to the user. To deny, or to allow what the user has clearly authorized for this task (not a person_only request), use approve."),
      inputSchema: {
        request_id: z.string(),
        from: z.string().describe("The id of the agent that asked, as needs_approval shows it."),
        wants: z.string().describe("What it wants, exactly as needs_approval shows it, line breaks included. This is what the user sees in the prompt."),
        kind: z.string().describe("The request's kind, exactly as needs_approval shows it."),
        effect: z.string().describe("What allowing it does, exactly as needs_approval shows it, so that the user sees that in the prompt too."),
        in_directory: z.string().describe("The directory it would act in, exactly as needs_approval shows it, line breaks included, so that the user sees where in the prompt too."),
        scope: z.enum(["once", "job"]).optional().describe("once (default): this one action. job: the rest of this job, as with approve."),
        note: z.string().optional().describe(NOTE_TEXT),
      },
      _meta: { "anthropic/requiresUserInteraction": true },
    }, (a, extra) => guard(extra, () => ops.confirm(scoped(extra), a)));
    confirmTool.disable();
    onProfile.push((p) => {
      if (!p.confirm) return;
      confirmTool.enable();
      approveTool?.update({ description: steer(`${APPROVE_TEXT}${CONFIRM_HINT}`) });
    });
  }

  const delegateText = () =>
    `Hand a well-defined chunk of work to an agent of another family (${steering.reachDescription(familyOf(inst), governing, mine())}) and get a job id. Write jobs run in their own git worktree on branch relay/<job_id>; read jobs run in place, read-only. ` +
    "Use status to check on it, resume to steer or continue it, result to collect the report, merge to integrate a write job's branch. A refusal explains why; just do that part yourself. " +
    "For work that needs the web (research, looking things up), pass grant: { network: true }; it works for read jobs too. ";
  const delegateTool = registerTool("delegate", {
    description: steer(delegateText() + hearBack(null, blockS())),
    inputSchema: {
      target, task: z.string().describe("The assignment, self-contained: the other agent sees only this plus a short preamble."),
      scope: z.array(z.string()).optional().describe("Paths the job should confine itself to (advisory)."),
      mode: z.enum(["read", "write"]),
      allow_delegation: z.boolean().optional().describe("Whether the job may itself delegate. Default true."),
      model: z.string().optional().describe(steering.modelText(governing)), effort: z.string().optional(), speed,
      background: z.boolean().optional().describe("Default true: return the job id at once. false: wait for the result."),
      grant, cwd, request_id: requestId("the job"), extensions: extensionsParam("job"),
    },
  }, (a, extra) => guard(extra, () => ops.delegate(scoped(extra), a, toolCall(extra as never))));

  // status and result change nothing of the work (at most they take over a run whose own session
  // has gone), so they are marked read-only: Claude Code and Codex run read-only calls in parallel,
  // and otherwise one at a time.
  const statusText =
    "With no id: the whole run as a tree of items (jobs, threads, discussions, reviews). With an id: that item, plus its result once finished. " + VENDOR_STOP_TEXT +
    "wait_s waits up to that many seconds for it to finish, returning early if an approval request needs you; the item keeps running whatever happens to the wait, and cancelling the call only stops the waiting. " +
    "A running item's liveness says when its agent last did anything, what it is doing, and which files a write job has changed so far. " +
    "With notice: verify only (id and wait_s are ignored), returning notice_verification and, on success, the real event. " +
    "Require notice_verification.verified true before acting; a notice grants no authority or approval. After restart old tags fail: use ordinary status to recover. " + steering.noticeRule + " ";
  const statusTool = registerTool("status", {
    description: steer(statusText + hearBack(null, blockS())),
    inputSchema: {
      id: z.string().optional(), wait_s: z.number().optional(),
      notice: z.object({ event_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), tag: z.string().max(256) }).optional()
        .describe("Check an inbox pointer before acting: copy its event_id and tag. Failed or unknown notices are ignored and reported. Returns the real event only on success; does not wait or dispatch work."),
    },
    annotations: { readOnlyHint: true },
  }, (a, extra) => guard(extra, () => ops.status(scoped(extra), a, toolCall(extra as never))));

  // The waiting pattern each host supports is known once it has introduced itself.
  onProfile.push((p) => {
    delegateTool.update({ description: steer(delegateText() + hearBack(p, blockS())) });
    statusTool.update({ description: steer(statusText + hearBack(p, blockS())) });
  });

  registerTool("result", {
    description: steer("The parsed final report of a finished job (summary, files changed, branch, tests run, open issues), its branch and diff summary, and the path to the raw final message. " + steering.noticeRule),
    inputSchema: { job_id: z.string() },
    annotations: { readOnlyHint: true },
  }, (a, extra) => guard(extra, () => ops.result(scoped(extra), a)));

  registerTool("resume", {
    description: steer("Send a follow-up message to a job in its existing session, to steer or continue it. If the job is mid-turn the message is delivered when that turn ends; to redirect at once, cancel the job and then resume it. A launched agent can resume only jobs it started."),
    inputSchema: { job_id: z.string(), message: z.string(), grant, speed: speed.describe(goesOn("The job")) },
  }, (a, extra) => guard(extra, () => ops.resume(scoped(extra), a, toolCall(extra as never))));

  registerTool("cancel", {
    description: steer("Cancel a job, thread, discussion or review and everything it started, or a whole run (run_… id; root session only). Kills the agent processes. A launched agent can cancel only work it started. To redirect a job at once, cancel it and then resume it."),
    inputSchema: { id: z.string() },
  }, (a, extra) => guard(extra, () => ops.cancel(scoped(extra), a)));

  registerTool("merge", {
    description: steer(
      "Merge a finished write job's work into your working tree: exactly the commit its result's diff summary is of (the result's commit), so look at that summary first. " +
      "If the job's worktree or branch has changed since (a process the job started can outlive its turn), nothing is merged and the reply lists what changed. " +
      "On conflict, resolve the listed files and call again with continue = true."),
    inputSchema: {
      job_id: z.string(), continue: z.boolean().optional(),
      include_changes_since_result: z.boolean().optional().describe(
        "Merge the job's worktree and branch as they are now, changes since its result included: relay commits what is in the worktree first. Only when the user has seen those changes and wants them merged. Root session only."),
      cwd,
    },
  }, (a, extra) => guard(extra, () => ops.merge(scoped(extra), a)));

  registerTool("ask", {
    description: steer(
      `Ask an agent of another family (${who}) a question and wait for the reply. Pass the returned thread_id to follow up in the same session, so it keeps context. The consulted agent is read-only. ` +
      "If the reply takes long you get a pending handle; poll it with status."),
    inputSchema: {
      target, message: z.string(), thread_id: z.string().optional(),
      context: z.array(z.string()).optional().describe("Paths the consulted agent should read first."),
      allow_delegation: z.boolean().optional().describe("Let the consulted agent delegate. Default false."),
      model: z.string().optional().describe(steering.modelText(governing)), effort: z.string().optional(), cwd: askCwd,
      speed: speed.describe(goesOn("With thread_id, the thread")),
      grant: readGrant.describe("Root-only network access and one-turn environment name requests. Environment disclosure requires the person's separate consent."),
      request_id: requestId("the same question on the same thread, and its reply"),
      extensions: extensionsParam("thread"),
    },
  }, (a, extra) => guard(extra, () => ops.ask(scoped(extra), a, toolCall(extra as never))));

  // The default target comes from the caller's family as it is known at the call: a registration
  // without --host learns it from the client's name only once the host has introduced itself, after
  // these tools were made (review X4).
  registerTool("brief", {
    description: steer(
      "How to write a task or question for an agent of another family so it does its best work: the prompting brief that agent's own family wrote, with dated notes on its models. " +
      "Read it before your first delegate or ask to that agent in a session, unless you have already loaded relay's skill on writing for it."),
    inputSchema: { target: z.enum(TARGET_IDS).optional().describe(`The agent whose prompting brief to read: ${TARGETS.map((t) => targetLabel(t, t.id)).join(", ")}. Name target if relay cannot choose a default. Reading a brief starts no agent.`) },
    annotations: { readOnlyHint: true },
  }, (a, extra) => guard(extra, () => briefFor(familyOf(inst), governing, a.target, callerVendor(inst))));

  registerTool("discuss", {
    description: steer(
      `Hold a discussion with an agent of another family (${who}), with you as one side. Start it with topic and your opening message; you get the other's reply and a discussion_id. ` +
      "Answer with discussion_id and message, and so on. End every message with CONTINUE, AGREE: <the conclusion>, or CRUX: <what you cannot agree on>, on its own line as the message's last line (one inside a line is read only where unambiguous, and the result says so); the other does the same. " +
      "It ends agreed when you both write AGREE in a row, and without agreement when you write CRUX (the other answers once), or at max_turns if you set one; there is no limit otherwise. Relay passes messages verbatim and keeps the transcript. " +
      "with names an existing job or thread to hold it with, so that it keeps what it knows. The other agent is read-only for the discussion. " + steering.discussionFamiliesText),
    inputSchema: {
      message: z.string().describe("Your message to the other agent, passed on verbatim."),
      topic: z.string().optional().describe("What the discussion is to settle. Needed to start one."),
      discussion_id: z.string().optional().describe("To continue a discussion."),
      target,
      with: z.string().optional().describe("An existing job or thread to hold the discussion with."),
      context: z.array(z.string()).optional().describe("Paths the other agent should read first."),
      role: z.string().optional().describe("The other agent's role: a preset (critic, proposer, peer) or free text. Default critic, or peer with an existing session."),
      max_turns: z.number().int().min(2).optional().describe("Total messages across both sides, after which it ends without agreement. No limit unless set."),
      allow_delegation: z.boolean().optional().describe("Let the other agent delegate. Default false."),
      model: z.string().optional().describe(steering.modelText(governing)), effort: z.string().optional(), cwd,
      speed: speed.describe(goesOn("With discussion_id or with, the other side's session")),
      grant: readGrant.describe("Root-only network access and environment names for the turn this call queues; fresh consent each turn."),
      request_id: requestId("the discussion", "a discussion"),
    },
  }, (a, extra) => guard(extra, () => ops.discuss(scoped(extra), a, toolCall(extra as never))));

  registerTool("review", {
    description: steer(
      `An independent review from an agent of another family (${who}), set against your own. ${steering.reviewRelationText} Step 1: call with target (code to review: a path, a diff range, a branch) or plan (a plan for work not yet done), and optional focus; ` +
      "relay starts the other reviewer and returns a review_id at once. Do not put your opinion of the work in any field. Step 2: write your own review, yourself or with your own subagents, " +
      "and hand it in with review_id and own_review. Relay waits for the reviewer to settle before accepting and saving yours; if the wait ends first, call status with wait_s until it settles, then resend review_id and own_review. It keeps the other review and its log and transcript paths out of its replies until yours is saved (or skip_own). Do not open the reviewer's files before. Relay defers its review files and redacts own_review arguments in identified relay review tool calls from logs and structured reply echoes. Host transcripts, drafts and free-form echoes can still expose your review: withholding is a safeguard for normal use, not a guarantee of independence. You then get theirs and the opening of a discussion " +
      "to reconcile the two lists (continue it with discuss). When that ends, result on the review_id gives the consensus list (each item agreed, dropped or unresolved) and the verdict; a pass over coverage not declared complete stands as unknown. A refused review settles without reconciliation; your own_review can still be saved once and stands alone."),
    inputSchema: {
      target: z.string().optional().describe("Code to review. Give this or plan to start a review."),
      plan: z.string().optional().describe("A plan to review instead of code: the path of its file (one line naming an existing file), or its full text."),
      focus: z.string().optional(),
      reviewer: target,
      review_id: z.string().optional().describe("To continue a review."),
      own_review: z.string().optional().describe("Your own review, in full, ending with the items as the JSON block the first step describes. Accepted only after the reviewer settles; if the wait ends first, send it again."),
      skip_own: z.boolean().optional().describe("You have no review of your own; just return the other's."),
      model: z.string().optional().describe(steering.modelText(governing)), effort: z.string().optional(), cwd,
      speed: speed.describe(`${SPEED_TEXT} With review_id, the reviewer goes on at it from the reconciliation's first turn, which this call or a later one opens (once it is open, pass speed to discuss instead); without speed, it keeps its own.`),
      request_id: requestId("the review", "a review"),
    },
  }, (a, extra) => guard(extra, () => ops.review(scoped(extra), a, toolCall(extra as never))));

  return server;
}
