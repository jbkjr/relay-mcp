// The generic ACP driver: one turn of a harness that speaks the Agent Client Protocol, version 1,
// as JSON-RPC over the harness's stdio (https://agentclientprotocol.com/protocol/v1). One process
// per turn, as with every other target, so no long-lived agent keeps an earlier turn's authority.
//
// ACP is relay's transport for these harnesses, not their security layer: nothing in the protocol
// sets or reports a sandbox, a login or the effective configuration. What a harness needs for
// those is in its profile (AcpProfile), and confinement is relay's own (see launch()).
import { spawn } from "node:child_process";
import { assertNeverAdapter } from "./never-admission.js";
import { neverFloorApplies } from "../core/never-coverage.js";
import { neverIdentityProblem } from "../core/never-policy.js";
import fs from "node:fs";
import crypto from "node:crypto";
import { diagnosticTail } from "../core/redact.js";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Broker } from "../confine/broker.js";
import { BRIDGE_SECRET_ENV } from "../confine/broker-names.js";
import { confinement, quarantineTokenStore, type HarnessState as SandboxState, type NetworkPolicy, type TokenStore } from "../confine/index.js";
import { type ProxyDecision, type TurnProxy } from "../confine/proxy.js";
import { loginStore, openTurnProxy, privateTurnTemp, turnPolicy } from "../confine/turn.js";
import { boundaryProbe, NO_PROBE } from "../confine/turn-probe.js";
import { streamSandboxDenials, type DenialStream } from "../confine/diagnostics.js";
import type { ProbeReport } from "../confine/index.js";
import { authFor, networkOn, relayHome, VERSION } from "../core/config.js";
import { executable } from "../core/executables.js";
import { drainGroup, isGroupSignalRefusal, killProcs, procStart, sendGroupSignal, stopProcs, type Watch } from "../core/procs.js";
import { VENDOR_NAMES, targetLabel, vendorFor } from "../targets/index.js";
import { oneLine } from "../core/shown.js";
import { getTurn, updateTurn } from "../core/db.js";
import { redact, registerTurnSecret, streamSecretValues, withTurnSecrets } from "../core/secrets.js";
import { childEnv, endpointProblem } from "./env.js";
import { activityOf, approvalKey, askableReadOnly, openAgentLog, usageFrom, watchProcess, type AgentLog, type ApprovalAsk, type Backend, type TurnHandle, type TurnResult, type TurnSpec, type Usage } from "./types.js";

/** The one ACP protocol version relay speaks. v2 changes how a turn completes, so it is refused, not guessed at. */
const ACP_VERSION = 1;

type Id = number | string;
export interface AcpMsg {
  jsonrpc?: "2.0";
  id?: Id;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

/** JSON-RPC: the method does not exist (here: a client method relay does not provide). */
const METHOD_NOT_FOUND = -32601;

/** A tool call as the agent has described it so far: its tool_call, with every tool_call_update merged in. */
export interface ToolCallState {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  locations?: { path?: unknown; line?: unknown }[];
  content?: unknown[];
}

export interface PermissionOption {
  optionId: string;
  name?: string;
  /** allow_once, allow_always, reject_once or reject_always. */
  kind: string;
}

/**
 * What a profile prepares for the harness's own state this turn: the harness state relay's sandbox
 * takes (src/confine `HarnessState`), passed through whole, and what only the turn needs. So a
 * profile can give its harness a temporary home with the harness's own home variables, links to the
 * login files it must read and the token files it rewrites; or keep the person's home ("real"), as
 * Copilot does for its keychain login. The environment goes through the sandbox layer, which refuses
 * a variable relay sets itself (HOME, TMPDIR, PATH, the proxy variables, NODE_OPTIONS, DYLD_*).
 */
export interface PreparedState extends Omit<SandboxState, "home"> {
  /** "temp" (the default): a fresh home inside the turn's temp dir. "real": the person's own HOME, read-only, which a harness with its login in the keychain needs (the keychain search list is found through HOME). */
  home?: SandboxState["home"];
  /** Per-turn directories the harness must be able to write; they must lie inside the turn's temp dir. */
  stateDirs: string[];
  /** Further executables the harness needs that are not on relay's fixed list (src/confine `ConfinementPolicy.execPaths`). */
  execPaths?: string[];
  /** Whether the harness needs the keychain (its stored login is there). A stated downgrade. */
  keychain: boolean;
  /** Whether the harness checks certificates through the system's trust daemons (Go, Rust's platform verifier, the Security framework; not Node). A stated downgrade. */
  certificateTrust?: boolean;
  /**
   * Values relay hands the harness that must never be kept (an API key): replaced by "[redacted]"
   * in everything relay reads from the agent before it uses or keeps it (see redactor).
   */
  secrets?: string[];
  /**
   * An ACP authenticate request relay makes right after initialize, with what the profile prepared:
   * how a harness is handed a secret it needs (an API key, in `meta`, as Gemini CLI takes one in
   * `_meta["api-key"]`) without putting it in an environment block, which the turn's own processes
   * can read (kern.procargs2). The method must be one the agent offers, and an error fails the turn.
   * The request is not written to the agent's log; list what in it is secret in `secrets` too.
   */
  authenticate?: { methodId: string; meta?: Record<string, unknown> };
  /**
   * For a harness that reaches relay's tools other than through the bridge entry in session/new
   * (Gemini's tool discovery, backends/gemini.ts): called once the turn's broker is open and before
   * the harness starts, with what reaching it takes: the socket, the file holding the bridge's secret
   * in the turn's own broker directory (Broker.secretFile), which this turn's profile alone may read
   * and which goes with the broker, the broker's tool list, and the turn's private temporary
   * directory (writable by the turn, removed with it). A failure stops the turn before anything starts.
   */
  bridgeReady?(bridge: { socketPath: string; secretFile: string; listTools: Broker["listTools"]; tmpDir: string }): Promise<void>;
  /**
   * Called once initialize (and authenticate, where the profile prepared one) has answered and before
   * the session is asked for (session/new, session/load or session/resume): to undo what the harness
   * did at initialize that the session's own setup must show afresh (Gemini runs relay's discovery
   * command while it answers initialize, and again for each session, so its mark is removed here,
   * backends/gemini.ts). A throw fails the turn.
   */
  afterInitialize?(): void;
  /**
   * Called once the session is set up (session/new, session/resume, or session/load and its replay)
   * and before the prompt goes out, with the version the harness reported in initialize
   * (agentInfo.version, or null). What it returns is said before the turn's prompt, in the same
   * message (`promptPrefix`: such as relay's tools being unavailable this turn after all), and in the
   * turn's warnings (`notes`). Nothing it returns can stop the turn; a throw fails it.
   */
  beforePrompt?(info: { agentVersion: string | null }): { promptPrefix?: string; notes?: string[] } | undefined;
  /** What the turn's result says about how it was prepared (warnings). */
  notes?: string[];
  /** Removes what was prepared, when the turn is over. */
  cleanup?(): void;
}

/** The shortest secret relay redacts: a shorter one could occur in ordinary text by chance. */
const MIN_SECRET = 16;

/** The streamed text updates relay reads as one stream for a turn's secrets (secretSafeLog). */
const STREAMED_TEXT = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);

/**
 * The agent's log for a turn's known by-value secrets (profile, environment and registered
 * proxy/bridge credentials, in every form core/secrets.ts cuts). Each line the agent writes is
 * redacted on its own before anything reads it (redactor), but a model streams its words in
 * pieces, and a secret split across two text chunks is whole in neither line. So, for such a turn
 * only, everything written to the log is queued in the order it came, and the text of the streamed
 * chunks (message, thought and replayed user chunks, whatever lines come between them) is read as
 * one stream. A chunk's line is written once the stream has gone on past it by one character less
 * than the longest secret, or when the log ends: by then any secret it holds a piece of is whole in
 * the stream. Each occurrence is replaced by "[redacted]" in the line it starts in and cut from the
 * lines it runs on into, and a line whose text changed is written re-serialized. Other lines wait
 * only for the chunks before them, so that the log keeps its order. Only the log waits: what relay
 * does with each line does not. A secret the agent encodes (base64, reversed) is not caught.
 */
export function secretSafeLog(log: AgentLog, secrets: readonly string[]): AgentLog & { agent(m: AcpMsg, line: string): void } {
  const list = [...new Set(secrets)].filter((s) => s.length > 0);
  if (!list.length) {
    return {
      write: (text) => log.write(text),
      end: (callback) => log.end(callback),
      get writableEnded() {
        return log.writableEnded;
      },
      agent: (_m, line) => {
        if (!log.writableEnded) log.write(line + "\n");
      },
    };
  }
  /** How far the stream must run on past a chunk before every secret it holds a piece of is whole. */
  const span = Math.max(...list.map((s) => s.length)) - 1;
  type Chunk = { m: AcpMsg; line: string; start: number; end: number; text: string };
  const queue: ({ raw: string } | Chunk)[] = [];
  /** The stream's last `span` characters, where an occurrence that ends in text still to come starts. */
  let tail = "";
  /** The stream's length so far. */
  let total = 0;
  /** Occurrences [start, end) in the stream, by start, while a line not yet written holds part of one. */
  let found: [number, number][] = [];
  const textOf = (m: AcpMsg): string | null => {
    const u = m?.method === "session/update" ? m.params?.update : undefined;
    return u && STREAMED_TEXT.has(u.sessionUpdate) && u.content?.type === "text" && typeof u.content.text === "string" ? u.content.text : null;
  };
  /** A chunk's text with every occurrence cut out, "[redacted]" where one starts in it. */
  const masked = (c: Chunk): string => {
    const cut = new Array<boolean>(c.text.length).fill(false);
    const starts = new Set<number>();
    for (const [a, b] of found) {
      if (b <= c.start || a >= c.end) continue;
      for (let i = Math.max(a, c.start); i < Math.min(b, c.end); i++) cut[i - c.start] = true;
      if (a >= c.start) starts.add(a - c.start);
    }
    let out = "";
    for (let i = 0; i < c.text.length;) {
      if (!cut[i]) {
        out += c.text[i++];
        continue;
      }
      let j = i;
      let starting = false;
      for (; j < c.text.length && cut[j]; j++) if (starts.has(j)) starting = true;
      if (starting) out += "[redacted]";
      i = j;
    }
    return out;
  };
  const drain = (all: boolean) => {
    const safe = all ? Infinity : total - span;
    while (queue.length) {
      const e = queue[0];
      if ("text" in e && e.end > safe) break;
      queue.shift();
      if (log.writableEnded) continue;
      if (!("text" in e)) {
        log.write(e.raw);
        continue;
      }
      const out = masked(e);
      if (out === e.text) {
        log.write(e.line + "\n");
        continue;
      }
      const copy = JSON.parse(e.line);
      copy.params.update.content.text = out;
      log.write(JSON.stringify(copy) + "\n");
    }
    const held = queue.find((e): e is Chunk => "text" in e);
    const from = held ? held.start : total;
    found = found.filter(([, b]) => b > from);
  };
  return {
    write(text) {
      if (queue.length) {
        queue.push({ raw: text });
        return true;
      }
      return log.write(text);
    },
    end(callback) {
      drain(true);
      log.end(callback);
    },
    get writableEnded() {
      return log.writableEnded;
    },
    agent(m, line) {
      const text = textOf(m);
      if (text === null) {
        if (queue.length) queue.push({ raw: line + "\n" });
        else if (!log.writableEnded) log.write(line + "\n");
        return;
      }
      // Occurrences that end in this text: each starts in the tail or in the text itself.
      const before = tail.length;
      const stream = tail + text;
      const origin = total - before;
      for (const s of list) {
        for (let i = stream.indexOf(s, Math.max(0, before - s.length + 1)); i !== -1; i = stream.indexOf(s, i + 1)) found.push([origin + i, origin + i + s.length]);
      }
      found.sort((x, y) => x[0] - y[0]);
      queue.push({ m, line, start: total, end: total + text.length, text });
      total += text.length;
      tail = span > 0 ? stream.slice(-span) : "";
      drain(false);
    },
  };
}

/**
 * What relay does to everything it reads from an agent that holds secrets (PreparedState.secrets):
 * each occurrence of one is replaced by "[redacted]". Applied to each line of the ACP stream before
 * it is parsed, so the reply, progress, approval requests and the agent's log all come from
 * redacted text; to stderr a whole line at a time, so a secret split across two reads is caught;
 * and to the reply once assembled, since a reply streamed in pieces can split one. A secret that
 * the agent encodes (base64, reversed) is not caught.
 */
export function redactor(secrets: readonly string[]): (text: string) => string {
  const list = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  if (list.some((s) => s.length < MIN_SECRET)) throw new Error(`a secret relay is to redact is too short (under ${MIN_SECRET} characters) to tell from ordinary text`);
  if (!list.length) return (text) => text;
  return (text) => list.reduce((t, s) => t.split(s).join("[redacted]"), text);
}

/**
 * How one harness is driven over ACP: everything the protocol leaves to the agent. Each target that
 * runs through this driver has one, reviewed as code.
 */
export interface AcpProfile {
  /** Arguments that start the harness's ACP server on stdio. */
  args(spec: TurnSpec, model: string | undefined): string[];
  /** Variables removed from the harness's environment beyond credentials: what identifies the parent, or reconfigures the harness behind relay's back. */
  scrub(key: string): boolean;
  /** Prepares the harness's own state for this turn, or says why it cannot (thrown). */
  prepareState?(spec: TurnSpec): PreparedState;
  /**
   * Login. ACP has no standard way to ask an agent how it is signed in, so this is per harness, and
   * a harness that signs in with its login (child_auth "login") must have at least one way:
   * `reuse`: exact authenticate method ids known to succeed only with an existing login, without
   * writing settings or starting a browser or device flow; relay calls the first one offered and
   * treats an error as "not signed in". `verify`: what the harness's initialize reply says about
   * its login, null when that shows an account login. With neither, relay does not launch it.
   */
  login: { reuse?: string[]; verify?(init: any): string | null; how: string };
  /** The session mode the turn must run in, or undefined to leave the agent's own. */
  mode?(spec: TurnSpec): string | undefined;
  /**
   * The category of the config option in which the harness reports the reasoning effort its
   * session runs at (ACP's `thought_level`), where it does. A turn that names an effort is then
   * stopped before the prompt unless the session reports exactly that effort: the harness may
   * run another without a word (Grok 1.0.62 runs an effort its model's menu lacks at "high").
   * Unset, the effort goes to the harness as the profile's args put it, unchecked.
   */
  effortOption?: string;
  /**
   * What an approval request (session/request_permission) asks for, in relay's terms, or null when
   * that cannot be established (the request is then refused). `call` is the tool call with what the
   * request says of it merged in; `announced`, the tool call as the agent's session updates described
   * it before this request, without anything a request said (undefined when none did): for a harness
   * whose request is a check of its own about a call it announced (Copilot's path check, whose kind
   * is "read" whatever the call would do).
   */
  normalizeApproval(call: ToolCallState, spec: TurnSpec, announced?: ToolCallState): ApprovalAsk | null;
  /** Why this turn must not run at all, checked before anything is started (a repository setting that would change the model, say). */
  refuse?(spec: TurnSpec): string | null;
  /** Whether a message chunk is the harness's own notice rather than the agent's words: kept in the log, left out of the reply. */
  notice?(text: string): boolean;
  /**
   * The models that answered the prompt, in order, where the harness reports them only in the
   * prompt's response and its session's model report gives an alias (Gemini CLI: `promptModels`).
   * `reported` is the model the session reported before the prompt, its configured id, which such a
   * harness may also list for work another model did (Gemini keys every round after a tool call by
   * it; its profile drops those, backends/gemini.ts geminiServedModels).
   * Each is a model report like any other: recorded in the item's served models and its label, and,
   * where relay pinned a model, one other than that is a switch (switchedModel: within the pinned
   * model's family a note under either same_family setting; otherwise a warning under "allow", a
   * stopped turn under "refuse"). Under "auto" or no model they are what was chosen.
   */
  servedModels?(promptResponse: unknown, reported: string | undefined): string[];
  /**
   * Whether the session's `availableModels` is a menu rather than the models the harness takes
   * (Gemini CLI lists a few; its --model takes any id, which the API then serves or refuses). When
   * true, relay does not refuse a model for being missing from the list; the model the session
   * reports must still be the one relay asked for.
   */
  acceptsUnlistedModels?: boolean;
  /**
   * For a harness that streams a loaded session's history after it answers session/load, where ACP v1
   * has the agent replay the conversation before it answers (Gemini CLI 0.64.0 starts its replay
   * without waiting for it and answers at once, acpSessionManager.ts loadSession). Relay then waits,
   * before it sends the prompt, until the session has sent no update for `quietMs`, so that what the
   * replay says is not taken for this turn's reply or activity; a replay still going after `maxMs`
   * fails the turn. Such a harness sends nothing of a new prompt before the prompt, so the quiet
   * separates the two. A user_message_chunk once the prompt is sent, which such a harness sends
   * only in a replay, means the replay was not over: the turn says so in a warning.
   */
  replaysAfterLoad?: { quietMs: number; maxMs: number };
  /**
   * The text relay sends as the prompt, from the turn's own: for a harness that takes some prompts as
   * commands of its own rather than words for its model (Gemini CLI runs a prompt that starts with
   * "/" or "$" and names one of its commands as that command). Without it, the turn's prompt as it is.
   */
  promptText?(prompt: string): string;
}

/**
 * How much of a harness's stderr a failure quotes, at most: the tail of its complete lines and
 * whatever it wrote after the last line break, together, each redacted before it is cut.
 */
const STDERR_TAIL = 2000;

/**
 * A JSON-RPC error from the agent as relay reports it: its message, and the detail the agent put in
 * its data, `data.details` or `data` itself when that is a string. Gemini CLI 0.64.0 answers a
 * session it cannot load with the message "Internal error" and the reason in `data.details`
 * ("Invalid session identifier …"), so the message alone says nothing. The detail is cut of the
 * turn's secrets (`cut`, the profile's redactor; the line it came in was cut already, but a parsed
 * string may spell a secret that its JSON escaped), cleaned and clipped as the stderr tail a
 * failure quotes is (diagnosticTail, which also cuts credentials by their shape), and put on one
 * line. Other shapes of data are left out.
 */
export function rpcErrorText(error: unknown, cut: (text: string) => string = (t) => t): string {
  const e = (error && typeof error === "object" ? error : {}) as { message?: unknown; code?: unknown; data?: unknown };
  const data = e.data as { details?: unknown } | string | null | undefined;
  const raw = typeof data === "string" ? data : typeof data?.details === "string" ? data.details : "";
  let detail = "";
  if (raw.trim()) {
    const tail = diagnosticTail(STDERR_TAIL);
    tail.write(cut(raw));
    detail = tail.text().replace(/\s*\n\s*/g, " ").trim();
  }
  const message = typeof e.message === "string" && e.message ? cut(e.message) : detail ? `error ${JSON.stringify(e.code ?? null)}` : JSON.stringify(error);
  return detail ? `${message}: ${detail}` : message;
}

/**
 * The models a Gemini CLI prompt response says answered: `_meta.quota.model_usage[].model`, in order
 * of first use (gemini-cli v0.64.0, packages/cli/src/acp/acpSession.ts, buildPromptResponse). Its
 * session reports only the configured alias, often "auto", and sends no current_model_update.
 */
export function promptModels(response: unknown): string[] {
  const usage = (response as { _meta?: { quota?: { model_usage?: unknown } } } | null)?._meta?.quota?.model_usage;
  if (!Array.isArray(usage)) return [];
  return [...new Set(usage.map((u) => (u as { model?: unknown } | null)?.model).filter((m): m is string => typeof m === "string" && m.trim() !== ""))];
}

/** The agent's description of a tool call, merged into what is known about it. Fields not sent are kept. */
export function mergeToolCall(known: ToolCallState | undefined, update: Record<string, unknown>): ToolCallState {
  const out: ToolCallState = { ...(known ?? { toolCallId: String(update.toolCallId) }) };
  for (const k of ["title", "kind", "status", "rawInput", "locations", "content"] as const) {
    if (update[k] !== undefined && update[k] !== null) (out as unknown as Record<string, unknown>)[k] = update[k];
  }
  return out;
}

/** The options of an approval request (session/request_permission) that relay can use: well-formed ones only. */
export function permissionOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((o): o is PermissionOption => Boolean(o) && typeof o.optionId === "string" && typeof o.kind === "string");
}

/**
 * The answer to an approval request, as an ACP outcome. Relay answers only with an option the agent
 * offered, and never with allow_always: what "always" means is the agent's (some persist it to
 * their settings), so a decision for the rest of the job is held by relay and each later request
 * is answered allow_once. With no allow_once offered, an allowed request is refused; with no
 * reject_once offered, a refusal is "cancelled", which every agent must accept.
 */
export function permissionOutcome(options: PermissionOption[], allow: boolean): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
  const pick = (allow ? options.find((o) => o.kind === "allow_once") : undefined) ?? options.find((o) => o.kind === "reject_once");
  return pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Paths a tool call says it touches: its locations, and the path fields of its input and diffs. */
export function callPaths(call: ToolCallState): string[] {
  const out = new Set<string>();
  for (const l of call.locations ?? []) if (str(l?.path)) out.add(l.path as string);
  const input = call.rawInput && typeof call.rawInput === "object" ? (call.rawInput as Record<string, unknown>) : {};
  for (const k of ["path", "file_path", "filePath", "fileName", "file", "target", "destination"]) if (str(input[k])) out.add(input[k] as string);
  if (Array.isArray(input.paths)) for (const p of input.paths) if (str(p)) out.add(p);
  for (const c of call.content ?? []) {
    const d = c as { type?: unknown; path?: unknown };
    if (d?.type === "diff" && str(d.path)) out.add(d.path as string);
  }
  return [...out];
}

/**
 * The common reading of an ACP tool call, for profiles to build on: a command needs its command
 * line, a change its paths, a fetch its URL. Every other kind of tool call is refused: relay has no
 * reviewed reading of what it would do, and a summary of its raw input is not one. What cannot be
 * established is null, and the request is refused without reaching anyone: nobody can decide what
 * they cannot see.
 */
export function genericApproval(call: ToolCallState): ApprovalAsk | null {
  const input = call.rawInput && typeof call.rawInput === "object" && !Array.isArray(call.rawInput) ? (call.rawInput as Record<string, unknown>) : null;
  const title = str(call.title);
  switch (call.kind) {
    case "execute": {
      const argv = Array.isArray(input?.command) && input.command.length && input.command.every((a) => typeof a === "string") ? (input.command as string[]) : undefined;
      const command = str(input?.command) ?? argv?.join(" ");
      if (!command) return null;
      // The argv, when the agent gives one, is the command's identity: its joined form can be ambiguous.
      return { kind: "command", summary: command, reason: str(input?.description) ?? title, detail: { ...(str(input?.cwd) ? { cwd: input!.cwd } : {}), ...(argv ? { argv } : {}), tool_call: call.toolCallId } };
    }
    case "edit":
    case "delete":
    case "move": {
      const paths = callPaths(call);
      if (!paths.length) return null;
      return { kind: "file", summary: `${call.kind} ${paths.join(", ")}`, reason: title, paths, detail: { tool_call: call.toolCallId } };
    }
    case "fetch": {
      const url = str(input?.url) ?? str(input?.query);
      if (!url) return null;
      return { kind: "web", summary: str(input?.url) ? `fetch ${url}` : `web search: ${url}`, reason: title, detail: { tool_call: call.toolCallId } };
    }
    default:
      return null;
  }
}

/**
 * What a tool call is doing, in a few words, for progress lines, as the native backends report it
 * (activityOf): the command, the files, the URL, else the agent's own title for it.
 */
function callActivity(call: ToolCallState): string | null {
  const input = call.rawInput && typeof call.rawInput === "object" && !Array.isArray(call.rawInput) ? (call.rawInput as Record<string, unknown>) : {};
  if (call.kind === "execute" && input.command !== undefined) return activityOf("Bash", { command: input.command });
  if (call.kind === "edit" || call.kind === "delete" || call.kind === "move") {
    const paths = callPaths(call);
    if (paths.length) return activityOf("fileChange", { changes: paths.map((p) => ({ path: p })) });
  }
  if (call.kind === "fetch" && str(input.url)) return activityOf("WebFetch", { url: input.url });
  if (call.kind === "think") return null;
  const title = str(call.title);
  // The agent's own words: escaped like every other activity (review C12).
  return title ? oneLine(title, 160) : null;
}

/**
 * Token usage from an ACP prompt response's `usage` (unstable in ACP v1: inputTokens, outputTokens,
 * totalTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens), in relay's names: this turn's.
 */
function acpUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return usageFrom({
    ...r,
    ...(typeof r.cachedReadTokens === "number" ? { cached_input_tokens: r.cachedReadTokens } : {}),
    ...(typeof r.cachedWriteTokens === "number" ? { cache_creation_input_tokens: r.cachedWriteTokens } : {}),
    ...(typeof r.thoughtTokens === "number" ? { reasoning_output_tokens: r.thoughtTokens } : {}),
  });
}

/** An executable named on PATH (or given as a path), as an absolute path, or null. */
function resolveBin(bin: string, env: NodeJS.ProcessEnv): string | null {
  const ok = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (bin.includes("/")) {
    const p = path.resolve(bin);
    return ok(p) ? fs.realpathSync(p) : null;
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    if (ok(p)) return fs.realpathSync(p);
  }
  return null;
}

interface Rpc {
  child: ReturnType<typeof spawn>;
  pid: number;
  send(m: AcpMsg): void;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  disconnect(): void;
}

/**
 * Starts the harness and speaks JSON-RPC over its stdio. onMessage sees everything that is not a
 * reply to relay. Each line the agent writes is passed through `cutLine` before anything reads it.
 */
function connect(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onMessage: (m: AcpMsg, line: string) => void, cutLine: (text: string) => string = (t) => t): Rpc {
  const child = spawn(executable(command, env.PATH), args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.on("error", () => {});
  let next = 1;
  const waiting = new Map<Id, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const send = (m: AcpMsg) => {
    if (!child.stdin!.writable) return;
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  };
  readline.createInterface({ input: child.stdout! }).on("line", (raw) => {
    const line = cutLine(raw);
    let m: AcpMsg;
    try {
      m = JSON.parse(line) as AcpMsg;
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (m.id !== undefined && m.method === undefined) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      // With the detail its data carries, which is where Gemini says why a session would not load.
      if (m.error) w?.reject(Object.assign(new Error(rpcErrorText(m.error, cutLine)), { code: m.error.code }));
      else w?.resolve(m.result);
      return;
    }
    onMessage(m, line);
  });
  let closed: Error | null = null;
  const rejectPending = (err: Error) => {
    closed ??= err;
    for (const w of waiting.values()) w.reject(closed);
    waiting.clear();
  };
  child.on("close", () => rejectPending(new Error("the agent exited")));
  return {
    child, pid: child.pid ?? -1, send,
    disconnect: () => rejectPending(new Error("relay disconnected the agent after cleanup was refused")),
    request: (method, params, timeoutMs) => new Promise((resolve, reject) => {
      if (closed) return reject(closed);
      const id = next++;
      let timer: NodeJS.Timeout | undefined;
      waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      // A deadline on the wait, for requests that should answer at once (initialize, login). It
      // ends relay's wait, not the agent; the turn is then refused and the agent stopped.
      if (timeoutMs) {
        timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`no answer to ${method} within ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        timer.unref();
      }
      send({ id, method, params });
    }),
  };
}

/**
 * How the harness process is started this turn: the command line, the environment to add, the
 * relay MCP server to give the agent, and what to check and close around the process. Relay
 * confines every ACP harness itself (see the relay-enforced branch); a harness whose own sandbox
 * relay could verify would be launched as it is, with relay's ordinary MCP server.
 */
interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
  relay: { command: string; args: string[]; env: Record<string, string> } | null;
  /** The boundary probes this launch passed (relay-enforced confinement). */
  probes?: ProbeReport;
  /** The label on the sandbox's deny-default rule, so relay can stream this turn's denials into its log. */
  diagnosticTag?: string;
  /** What the turn's network is, for its log: "on", or relay's proxy admitting only these hosts. */
  network?: { mode: "on" } | { mode: "proxy"; hosts: readonly string[]; log: string; trust: boolean };
  /** The target's login store, as the sandbox was given it (a stated downgrade), for the turn's log. */
  loginStore?: TokenStore;
  /** Hands the turn's log every decision of its proxy (those made before this is called included), when it has one. */
  proxyDecisions?(sink: (d: ProxyDecision) => void): void;
  /** Hands the turn's log broker authentication refusals, including any before the log opened. */
  brokerRefusals?(sink: (reason: string) => void): void;
  /** Checks the running process before the prompt is sent; returns what is wrong, or null. */
  verify(pid: number): Promise<string | null>;
  /** Takes away the agent's access to relay and the network at once (closes the turn's broker and proxy). Safe to call more than once. */
  revoke(): Promise<void>;
  /** Releases what the launch holds. Called once the process is gone. */
  close(): Promise<void>;
}

async function launch(spec: TurnSpec, bin: string, args: string[], state: PreparedState): Promise<Launch> {
  const c = spec.target.capabilities.confinement;
  // Verified confinement means checking, through the harness, that its own sandbox took; no ACP
  // harness has a verifier for that yet, so none is launched on its own sandbox's word.
  if (c === "verified") throw new Error(`relay has no way yet to verify ${targetLabel(spec.target)}'s own sandbox over ACP, so it does not launch it on that sandbox.`);
  if (c === "relay-enforced") return confinedLaunch(spec, bin, args, state);
  throw new Error(`${targetLabel(spec.target)} has no confinement relay can enforce or verify, so relay does not launch it.`);
}

/** Unit tests replace launch resources, while exercising the protocol and cleanup themselves. */
let testLaunch: typeof launch | null = null;
export function setAcpLaunchForTests(fn: typeof launch | null): void { testLaunch = fn; }

/** How long relay waits for the kernel to report the harness sandboxed before it gives up and stops it. */
const CONFINED_WAIT_MS = 5000;
/** The longest pause between two of those asks. */
const CONFINED_PAUSE_MS = 100;

/**
 * Asks the mechanism whether `pid` is confined until it says so, or until `waitMs` have passed;
 * true only on the kernel's yes. The pauses between asks start at 5 ms and double up to
 * CONFINED_PAUSE_MS: the harness reads as sandboxed once sandbox-exec has compiled and applied its
 * profile, some tens of milliseconds after the spawn, so the first ask usually comes too early, and
 * a fixed 100 ms pause after it was mostly spent waiting on a process that was already confined.
 */
export async function awaitConfined(confined: (pid: number) => boolean, pid: number, waitMs = CONFINED_WAIT_MS): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (let pause = 5; ; pause = Math.min(pause * 2, CONFINED_PAUSE_MS)) {
    if (confined(pid)) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, pause));
  }
}

/**
 * Relay-owned confinement (src/confine), in the order the architecture notes give: the turn is
 * already running in the registry; relay opens the turn's broker, makes a private temp directory,
 * wraps the harness in the mechanism's sandbox with the bridge socket as its only Unix socket,
 * gives the harness `relay bridge <socket>` as its relay MCP server, confirms from the kernel that
 * the process is sandboxed before the prompt is sent, and closes the broker when the turn ends.
 * Where the mechanism cannot enforce, the harness is refused, never run unconfined.
 */
async function confinedLaunch(spec: TurnSpec, bin: string, args: string[], state: PreparedState): Promise<Launch> {
  const name = targetLabel(spec.target);
  const mech = confinement();
  if ("reason" in mech) throw new Error(`${name} runs only inside relay's own sandbox, and ${mech.reason}, so relay does not launch it.`);
  const sandbox = mech.mechanism;
  const probe = boundaryProbe();
  if (!probe) throw new Error(`${NO_PROBE}, so it does not launch ${name}.`);
  // Without network access the turn reaches only its target's declared API hosts, through a proxy
  // relay runs for this turn alone (src/confine/proxy.ts); the sandbox lets it reach nothing else.
  const hosts = spec.target.apiHosts ?? [];
  const online = networkOn(spec.config, spec.grant);
  if (!online && !hosts.length) throw new Error(`relay cannot keep ${name} off the network: relay does not know which hosts it needs to reach its model, so its network proxy would admit none. Grant network access for this work, or use another agent.`);
  // The worker's stop, while the turn is still starting: give up before anything is launched (E18).
  const stopped = () => {
    if (spec.signal?.aborted) throw new Error(`the turn was stopped while relay was starting ${name}`);
  };
  stopped();
  const tmpDir = privateTurnTemp();
  let broker: Broker | null = null;
  /** The bridge secret's file, for a harness that reads it itself (bridgeReady): its turn's profile alone may read it. */
  let bridgeSecret: string | undefined;
  let proxy: TurnProxy | null = null;
  /** The proxy's decisions, held until the turn's log takes them. */
  const decisions: ProxyDecision[] = [];
  let sink: ((d: ProxyDecision) => void) | null = null;
  const refusals: string[] = [];
  let refusalSink: ((reason: string) => void) | null = null;
  /** Ends the agent's access to relay and to the network: when the turn is over, and on release. */
  const cut = async () => {
    await broker?.close().catch(() => {});
    await proxy?.close().catch(() => {});
  };
  const release = async () => {
    await cut();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };
  try {
    const turnId = spec.turnId ?? spec.relay?.turnId;
    if (turnId !== undefined) {
      const turn = getTurn(turnId);
      if (!turn || turn.node_id !== spec.markers.nodeId || turn.status !== "running") throw new Error("cannot record a private temporary directory for an unknown or inactive turn");
      const st = fs.lstatSync(tmpDir);
      updateTurn(turnId, { tmp_dir: tmpDir, tmp_dev: st.dev, tmp_ino: st.ino });
    }
    if (spec.relay) {
      if (spec.relay.turnId === undefined) throw new Error("relay has no turn to serve this agent's relay tools for");
      // The broker brings the MCP server and SDK, which only a turn with relay tools needs.
      const { openBroker } = await import("../confine/broker.js");
      broker = await openBroker({ nodeId: spec.relay.nodeId, turnId: spec.relay.turnId, mayDelegate: spec.relay.mayDelegate ?? false, mayAsk: spec.relay.mayAsk ?? false }, {
        onRefusal: (reason) => (refusalSink ? refusalSink(reason) : refusals.push(reason)),
      });
      registerTurnSecret(broker.bridgeCommand.env[BRIDGE_SECRET_ENV], "bridge secret");
      // A harness that takes relay's tools another way than the bridge entry is told how to reach
      // this broker, before it starts (Gemini's tool discovery): the secret in a file of the broker's,
      // which this turn's profile alone may read (ConfinementPolicy.bridgeSecret).
      if (state.bridgeReady) {
        bridgeSecret = broker.secretFile();
        await state.bridgeReady({ socketPath: broker.socketPath, secretFile: bridgeSecret, listTools: broker.listTools, tmpDir });
      }
    }
    const proxyLog = path.join(spec.dir, "proxy.jsonl");
    if (!online) {
      proxy = await openTurnProxy({
        neverPolicy: spec.neverPolicy,
        allow: [...hosts], logFile: proxyLog, label: `${spec.markers.nodeId}/${spec.relay?.turnId ?? "-"}`,
        onDecision: (d) => (sink ? sink(d) : decisions.push(d)),
      });
    }
    const network: NetworkPolicy = proxy ? proxy.network : { mode: "on" };
    stopped();
    const store = spec.target.tokenStore ? loginStore(spec.target.tokenStore, os.homedir()) : undefined;
    const policy = turnPolicy(spec, state, tmpDir, network, os.homedir(), name, broker?.socketPath, bridgeSecret);
    if (spec.neverPolicy) {
      const problem = neverIdentityProblem(spec.neverPolicy);
      if (problem) throw new Error(problem);
      if (neverFloorApplies(spec.target.id, spec.config) && (state.keychain || state.certificateTrust || state.tokenFiles?.length || spec.target.tokenStore)) throw new Error("never: this ACP credential/TRUST variant bypasses the shared floor; use a qualified key-only/store-denying route");
    }
    // Wrapped for this turn and probed under exactly that confinement (turn-probe.ts).
    const checkedSandbox = { ...sandbox, wrap: (p: Parameters<typeof sandbox.wrap>[0], command: string, argv: string[]) => {
      const wrapped = sandbox.wrap(p, command, argv);
      const complete = { ...spec.environment, ...wrapped.env };
      const problem = endpointProblem(spec.target.id, complete);
      if (problem) throw new Error(problem);
      spec.checkEnvironment?.(complete);
      return wrapped;
    } };
    const { launch: wrapped, probes } = await probe(checkedSandbox, policy, bin, args, spec.signal, spec.environment);
    stopped();
    return {
      command: wrapped.command, args: wrapped.args, env: wrapped.env, probes, diagnosticTag: wrapped.diagnosticTag,
      relay: broker ? broker.bridgeCommand : null,
      network: proxy ? { mode: "proxy", hosts, log: proxyLog, trust: Boolean(state.certificateTrust) } : { mode: "on" },
      ...(store ? { loginStore: store } : {}),
      proxyDecisions(take) {
        sink = take;
        for (const d of decisions.splice(0)) take(d);
      },
      brokerRefusals(take) {
        refusalSink = take;
        for (const reason of refusals.splice(0)) take(reason);
      },
      async verify(pid) {
        // Pin the exact process we just spawned before it receives its MCP bridge entry.
        if (broker) {
          const start = procStart(pid, { fresh: true });
          if (!start) return `relay could not determine ${name}'s process identity for its broker, so it stopped it.`;
          broker.bindHarness({ pid, start });
        }
        // sandbox-exec applies the profile and then execs the harness in the same process, so the
        // pid relay started is the one to ask about; it may take a moment to read as sandboxed.
        if (await awaitConfined((p) => sandbox.confined(p), pid)) return null;
        return `relay could not confirm from the kernel that ${name} is running under its sandbox, so it stopped it before it did anything.`;
      },
      revoke: cut,
      close: release,
    };
  } catch (err) {
    await release();
    throw err;
  }
}

export { loginStore } from "../confine/turn.js";

// Vendor classifier refusal shapes through ACP have not been observed/verified (A17).
// Do not infer a safety stop from arbitrary provider error prose or permission denials.
const fail = (error: string) => ({ status: "failed" as const, error });

/**
 * Runs one turn over ACP. Before the prompt is sent: the protocol version, the login, the session
 * (new, resumed or loaded, with this turn's relay server), the mode and the model, each as the
 * agent reports it back, and the launch's own check of the process. Anything not as asked stops
 * the agent before it has done anything.
 */
export function startAcpTurn(spec: TurnSpec, profile: AcpProfile): Promise<TurnHandle> {
  return withTurnSecrets(() => startScopedAcpTurn(spec, profile), { reuse: true });
}

async function startScopedAcpTurn(spec: TurnSpec, profile: AcpProfile): Promise<TurnHandle> {
  assertNeverAdapter(spec);
  const target = spec.target;
  const name = targetLabel(target);
  const cfg = spec.config;
  const bin = cfg.targets[target.id].bin;
  const refusal = profile.refuse?.(spec) ?? loginStrategyProblem(profile, spec);
  if (refusal) throw new Error(refusal);
  // Which family answers: a harness that runs several families' models runs only the one asked for.
  const model = spec.model;
  const pinned = Boolean(model && model !== target.autoModel);
  const strict = cfg.same_family === "refuse";
  if (target.vendor === null && strict) {
    // Grok's listed models are all one family's, but it is judged per model all the same: it is not said to run several.
    const several = new Set(Object.values(target.models ?? {})).size > 1;
    if (!model) throw new Error(`${several ? `${name} runs models of several families` : `The family of ${name} is judged by the model it runs`}, and this turn names none, so relay cannot tell which family would answer. It does not launch it.`);
    if (!vendorFor(target, model)) throw new Error(`relay does not know which family the model ${JSON.stringify(model)} is, so it does not launch ${name} with it.`);
  }
  // A harness relay's own settings hold to its listed models (listedModelsOnly) runs no other, under either setting.
  if (target.listedModelsOnly && model && !vendorFor(target, model)) {
    throw new Error(`relay lets ${name} run only the models its list names (${Object.keys(target.models ?? {}).join(", ")}), so it does not launch it with ${JSON.stringify(model)}.`);
  }
  const env = childEnv(spec, profile.scrub);
  const absolute = resolveBin(bin, env);
  if (!absolute) throw new Error(`relay could not find the ${name} harness (\`${bin}\`). Install ${target.product}, or set targets.${target.id}.bin in relay's config to its full path.`);
  const endpoint = endpointProblem(target.id, env);
  if (endpoint) throw new Error(`${endpoint}.`);

  if (spec.signal?.aborted) throw new Error(`the turn was stopped while relay was starting ${name}`);
  const state = profile.prepareState?.(spec) ?? { stateDirs: [], keychain: false };
  let launched: Launch;
  /** The profile's own secrets (PreparedState.secrets) cut out; core/secrets.ts redact cuts what relay knows of the turn and its environment. */
  let cutSecrets: (text: string) => string;
  /** Both, for what relay reports of the turn (its error, reply, warnings and sandbox denials). */
  let cleanReport: (text: string) => string;
  try {
    cutSecrets = redactor(state.secrets ?? []);
    cleanReport = (text) => redact(cutSecrets(text));
    launched = await (testLaunch ?? launch)({ ...spec, environment: env }, absolute, profile.args(spec, model), state);
    // The profile's environment reaches the harness through the launch (the sandbox layer sets it),
    // so the environment the harness gets is checked as a whole, not only what relay passed on (E10).
    Object.assign(env, launched.env);
    const added = endpointProblem(target.id, env);
    if (added) {
      await launched.close().catch(() => {});
      throw new Error(`${added}.`);
    }
  } catch (err) {
    state.cleanup?.();
    throw err;
  }

  const { log: agentLog, warnings: logWarnings } = openAgentLog(spec.logPath);
  // A turn with secrets keeps one split across streamed text chunks out of its log (secretSafeLog).
  const log = secretSafeLog(agentLog, streamSecretValues(state.secrets ?? [], env, state.env));
  /** What the proxy, the broker and the sandbox report before the log's header is written: held, in the order it came, for after it. */
  let early: string[] | null = [];
  const report = (line: string) => {
    if (early) early.push(line);
    else if (!log.writableEnded) log.write(line);
  };
  /**
   * The log's header (the launch's command line, the probes it passed, its network and login store),
   * then what was held for after it. Written in the same step as the harness's spawn, just after it,
   * so that nothing the harness sends comes before it, and so that cutting secrets out of the long
   * command line (the whole sandbox profile, some 20 ms) runs while the harness starts up, not
   * before relay starts it. Once only.
   */
  const writeHeader = () => {
    if (!early) return;
    log.write(`\n# ${new Date().toISOString()} ${launched.command} ${launched.args.map((a) => JSON.stringify(a)).join(" ")}\n`);
    if (launched.probes) {
      const p = launched.probes;
      const skipped = p.results.filter((r) => r.got.startsWith("skipped"));
      log.write(`# relay boundary probes: ${p.results.length} passed in ${p.ms} ms${skipped.length ? ` (${skipped.length} not applicable this turn: ${skipped.map((r) => r.name).join(", ")})` : ""}; profile ${p.profile}, relay ${p.relay}, ${p.os}\n`);
    }
    if (launched.network) {
      const n = launched.network;
      // With the trust downgrade the network-off claim has an exception, said here too (review r_7feaed80 C2).
      log.write(n.mode === "on" ? "# relay network: on (granted)\n" : `# relay network: off, except relay's proxy to ${n.hosts.join(", ")}${n.trust ? ", and what the certificate-trust daemons fetch for it, past the proxy (a stated downgrade)" : ""} (decisions in ${n.log})\n`);
    }
    if (launched.loginStore) {
      const st = launched.loginStore;
      log.write(`# relay login store: ${st.name} (${st.dir}): its token, lock and temp names only (${[...st.files, ...st.locks].join(", ")}, ${st.tempName}), as regular files; a stated downgrade\n`);
    }
    const held = early;
    early = null;
    for (const line of held) report(line);
  };
  // What the proxy let through or refused, as it happens: a harness that needs a host relay does
  // not admit says so here.
  launched.proxyDecisions?.((d) => report(`[proxy] ${d.event} ${d.target}${d.reason ? ` (${d.reason})` : ""}\n`));
  launched.brokerRefusals?.((reason) => report(`[broker] refused: ${reason}\n`));
  // This turn's sandbox denials, streamed from the system log into the agent's log, so that a harness
  // the profile stops says which rule stopped it. A diagnostic only; nothing of the boundary rests on it.
  const denialStream: DenialStream | null = launched.diagnosticTag
    ? streamSandboxDenials(launched.diagnosticTag, (d) => report(`[sandbox] denied ${d.operation}${d.process ? ` (${d.process})` : ""}\n`))
    : null;

  let sessionId: string | undefined = spec.sessionId;
  /** Set once the agent has answered initialize: before that, an exit says nothing about the turn itself. */
  let initialized = false;
  let finalMessage = "";
  let prompting = false;
  /** Whether this turn's session was loaded (session/load), whose replay a profile may send after its answer (replaysAfterLoad). */
  let loaded = false;
  /** When this turn's session last sent an update, for the wait on a replay that follows the load's answer. */
  let lastUpdate = 0;
  /** Set once a replay is seen to go on after the prompt was sent (replaysAfterLoad), so that it is said once. */
  let replayLate = false;
  /** Set once the mode and model have been read back as asked; from then on any other model the agent reports ends the turn. */
  let verified = false;
  /** What the caller must be told about the turn (models switched to, under same_family "allow"; how the profile prepared it). */
  const notes: string[] = [...(state.notes ?? [])];
  /** Models of the pinned model's own family the turn switched to, all in the one note at `withinNote`. */
  const withinModels: string[] = [];
  let withinNote = -1;
  /** Approval requests relay itself refused while the turn was live, so the turn is reported blocked, not done (review ACP C1). */
  const denials: string[] = [];
  /** This turn's usage as the agent reports it: cost from usage_update, tokens with the prompt's response. */
  const usage: Usage = {};
  const noted = new Set<string>();
  const servedModels: string[] = [];
  const served = (value: string | undefined) => {
    try {
      spec.onServed?.(value ?? null);
    } catch {
      finish(fail("relay could not record the model reported by the agent, so it stopped the turn and took away its relay tools."));
      return false;
    }
    if (value && servedModels.at(-1) !== value) servedModels.push(value);
    return true;
  };
  let cancelled = false;
  const stderrTail = diagnosticTail(STDERR_TAIL);
  /** Set once the turn's result is known; the handle resolves only after the process has gone. */
  let outcome: Omit<TurnResult, "sessionId" | "finalMessage" | "exitCode"> | null = null;
  let resolveDone!: (r: TurnResult) => void;
  const done = new Promise<TurnResult>((r) => (resolveDone = r));
  const calls = new Map<string, ToolCallState>();
  /** Each tool call as the agent's session updates described it, without what approval requests said of it (normalizeApproval's `announced`). */
  const announced = new Map<string, ToolCallState>();
  /** Approval requests (session/request_permission) not yet answered, so that a cancel can answer them "cancelled", as ACP requires. */
  const pending = new Map<Id, () => void>();
  /** Decisions for the rest of the job taken in this turn (earlier turns' are in the registry). */
  const heldHere = new Set<string>();
  const current: { mode?: string; model?: string; options: Map<string, { category?: string; currentValue?: unknown; values?: string[] }> } = { options: new Map() };
  const takeOptions = (list: unknown) => {
    if (!Array.isArray(list)) return;
    current.options.clear();
    for (const o of list as { id?: unknown; category?: unknown; currentValue?: unknown; options?: unknown }[]) {
      // The values a select option offers, for messages only: what is checked is currentValue.
      const values = Array.isArray(o?.options) ? (o.options as { value?: unknown }[]).map((v) => v?.value).filter((v): v is string => typeof v === "string") : undefined;
      if (typeof o?.id === "string") current.options.set(o.id, { category: typeof o.category === "string" ? o.category : undefined, currentValue: o.currentValue, ...(values?.length ? { values } : {}) });
    }
  };
  const optionFor = (category: string) => [...current.options.entries()].find(([, o]) => o.category === category);
  const modelNow = (): string | undefined => {
    const o = optionFor("model");
    return typeof o?.[1].currentValue === "string" ? o[1].currentValue : current.model;
  };
  const modeNow = (): string | undefined => {
    const o = optionFor("mode");
    return current.mode ?? (typeof o?.[1].currentValue === "string" ? o[1].currentValue : undefined);
  };
  const takeSession = (res: any) => {
    if (typeof res?.modes?.currentModeId === "string") current.mode = res.modes.currentModeId;
    if (typeof res?.models?.currentModelId === "string") current.model = res.models.currentModelId;
    takeOptions(res?.configOptions);
  };

  let groupRefused = false;
  let cleanupRefusal: string | undefined;
  const stopTimers: NodeJS.Timeout[] = [];
  const signalGroup = (sig: NodeJS.Signals) => {
    if (groupRefused || rpc.pid <= 1) return false;
    try {
      sendGroupSignal(rpc.pid, sig);
    } catch (err) {
      if (isGroupSignalRefusal(err)) {
        groupRefused = true;
        cleanupRefusal = `Agent cleanup refused for group ${rpc.pid}: ${err.message}`;
        void Promise.resolve().then(() => settle(null));
        return false;
      }
      // Already gone.
    }
    return true;
  };
  let watch!: Watch;
  /** True once a look has found the agent alive after the turn stopped starting things. */
  let settled = false;
  const finish = (r: Omit<TurnResult, "sessionId" | "finalMessage" | "exitCode">) => {
    if (outcome) return;
    outcome = r;
    // The turn is over: the agent's relay tools and its network go with it, whatever it is still doing.
    void launched.revoke();
    for (const answer of pending.values()) answer();
    pending.clear();
    // The last look, while what the agent started can still be traced to it.
    settled = watch.look() || settled;
    rpc.child.stdin!.end();
    // The agent has no reason to outlive its one turn.
    stopTimers.push(setTimeout(() => signalGroup("SIGTERM"), 200).unref());
    stopTimers.push(setTimeout(() => {
      if (signalGroup("SIGKILL")) killProcs(watch.procs());
    }, 200 + cfg.cancel_grace_ms).unref());
  };

  const onPermission = async (m: AcpMsg) => {
    const p = (m.params ?? {}) as Record<string, any>;
    const options = permissionOptions(p.options);
    let answered = false;
    const reply = (allow: boolean, why: string, denied?: string) => {
      if (answered) return;
      answered = true;
      pending.delete(m.id!);
      const result = outcome || cancelled ? { outcome: { outcome: "cancelled" } } : { outcome: permissionOutcome(options, allow) };
      // A refusal relay imposed on a live turn is a denial, so the turn ends blocked, not done. A
      // refusal because the turn is already over or cancelled is not: the turn failed for that reason.
      if (!allow && denied && !outcome && !cancelled) denials.push(denied);
      log.write(`# relay: approval request answered ${JSON.stringify(result.outcome)} (${why})\n`);
      rpc.send({ id: m.id, result });
    };
    pending.set(m.id!, () => reply(false, "the turn is over"));
    if (outcome || cancelled) return reply(false, "the turn is over");
    if (p.sessionId !== sessionId) return reply(false, "not this turn's session");
    const update = p.toolCall && typeof p.toolCall === "object" ? (p.toolCall as Record<string, unknown>) : {};
    const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    const call = mergeToolCall(id ? calls.get(id) : undefined, { ...update, toolCallId: id ?? "(none)" });
    if (id) calls.set(id, call);
    const ask = profile.normalizeApproval(call, spec, id ? announced.get(id) : undefined);
    if (!ask) return reply(false, "what it would do could not be established", `a tool call relay could not read${str(call.title) ? ` (${str(call.title)})` : ""}`);
    if (!options.some((o) => o.kind === "allow_once")) return reply(false, "the agent offered no allow-once option", ask.summary);
    // A read-only turn never asks to change files, nor to pass a check for a path the agent could
    // write; not even what was allowed for the rest of the job in one of its write turns (askableReadOnly).
    if (spec.access === "read" && !askableReadOnly(ask)) return reply(false, "this turn is read-only", ask.summary);
    const key = approvalKey(ask, spec.cwd);
    if (heldHere.has(key) || spec.heldForJob?.(ask)) return reply(true, "allowed earlier for the rest of the job");
    if (!spec.escalate || !spec.onApproval) return reply(false, "this turn cannot ask for approval", ask.summary);
    let allow = false;
    let why = "refused";
    try {
      const answer = await spec.onApproval(ask, () => outcome !== null || cancelled);
      allow = answer.allow;
      if (answer.allow && answer.forJob) heldHere.add(key);
      // Relay's own reason, where it refused without anyone deciding (a protected path, nobody answering), for the log.
      if (!answer.allow && !answer.decider && answer.note) why = `refused: ${oneLine(answer.note, 300)}`;
    } catch {
      allow = false;
    }
    reply(allow, allow ? "allowed" : why, allow ? undefined : ask.summary);
  };

  const onUpdate = (u: Record<string, any>) => {
    lastUpdate = Date.now();
    switch (u.sessionUpdate) {
      case "user_message_chunk":
        // Sent by such a harness only in a replay: once the prompt is out, the replay was not over.
        if (prompting && loaded && profile.replaysAfterLoad && !replayLate) {
          replayLate = true;
          notes.push(`${name} was still replaying the earlier conversation after relay sent this turn's prompt, so its reply may begin with part of an earlier one.`);
        }
        break;
      case "agent_message_chunk":
        // A session/load replays the conversation as updates; only this turn's words are its reply.
        if (prompting && u.content?.type === "text" && typeof u.content.text === "string" && !profile.notice?.(u.content.text)) finalMessage += u.content.text;
        break;
      case "tool_call":
      case "tool_call_update": {
        if (typeof u.toolCallId !== "string") break;
        calls.set(u.toolCallId, mergeToolCall(calls.get(u.toolCallId), u));
        announced.set(u.toolCallId, mergeToolCall(announced.get(u.toolCallId), u));
        // The reply is what the agent says after its last tool call.
        if (prompting && u.sessionUpdate === "tool_call") finalMessage = "";
        // What it has just started doing, for progress lines (a load's replay is not this turn's).
        if (prompting && (u.sessionUpdate === "tool_call" || u.status === "in_progress")) {
          const text = callActivity(calls.get(u.toolCallId)!);
          if (text) spec.onActivity?.(text);
        }
        break;
      }
      case "usage_update": {
        // ACP reports cost here, when the agent knows it; tokens come with the prompt's response.
        const cost = u.cost as { amount?: unknown; currency?: unknown } | undefined;
        if (prompting && typeof cost?.amount === "number" && cost.currency === "USD") {
          usage.cost_usd = cost.amount;
          spec.onUsage?.({ ...usage });
        }
        break;
      }
      case "current_mode_update":
        if (typeof u.currentModeId === "string") current.mode = u.currentModeId;
        break;
      case "config_option_update":
        takeOptions(u.configOptions);
        current.model = typeof optionFor("model")?.[1].currentValue === "string" ? optionFor("model")![1].currentValue as string : undefined;
        break;
      // Not in ACP v1, but a model report all the same where an agent sends one.
      case "current_model_update":
        current.model = typeof u.currentModelId === "string" ? u.currentModelId : undefined;
        for (const [key, option] of current.options) if (option.category === "model") current.options.set(key, { ...option, currentValue: current.model });
        break;
    }
    if (verified && (u.sessionUpdate === "current_model_update" || u.sessionUpdate === "config_option_update")) {
      // Only away from a model relay pinned is a switch: under "auto" or no model, a model reported
      // mid-turn is what was chosen (design-family-steering.md §2.9), recorded as any report is.
      const next = modelNow();
      if (pinned && next !== model) switchedModel(next);
      served(next);
    }
  };

  /**
   * A switch away from the model relay pinned. Within the pinned model's own family it goes on with a
   * note under either policy: the same_family policy is not at stake (Gemini falling back from pro to
   * flash, Copilot from one Claude model to another). Otherwise it continues and relabels under
   * "allow", and under "refuse" stops the turn and revokes its tools.
   */
  const switchedModel = (now: string | undefined) => {
    if (outcome) return;
    const family = now ? vendorFor(target, now) : null;
    const asked = vendorFor(target, model);
    const to = oneLine(JSON.stringify(now ?? null), 120);
    const from = oneLine(JSON.stringify(model ?? null), 120);
    const note = (text: string) => {
      const key = JSON.stringify(now ?? null);
      if (!noted.has(key)) {
        noted.add(key);
        notes.push(text);
      }
    };
    if (family && family === asked) {
      // One note for the turn, however many models of the family answered (a helper call beside the main one).
      if (!withinModels.includes(to)) withinModels.push(to);
      const text = `${name} changed its model in the middle of the turn to ${withinModels.join(", then ")}, from ${from} (switched within ${VENDOR_NAMES[family]}; same_family policy unaffected).`;
      if (withinNote < 0) withinNote = notes.push(text) - 1;
      else notes[withinNote] = text;
      return;
    }
    if (!strict) return note(`${name} changed its model in the middle of the turn to ${to} (${family ? `${VENDOR_NAMES[family]}'s` : "family unknown"}), from ${from}. same_family is "allow", so relay let the turn go on; this reply may be from that model.`);
    if (sessionId) rpc.send({ method: "session/cancel", params: { sessionId } });
    const why = !now ? "it no longer reports which model it runs, so relay cannot tell which family answers"
      : !family ? `relay cannot tell which family ${to} is, so another family's model may have answered`
      : asked ? `${VENDOR_NAMES[family]}'s model may have answered, not ${VENDOR_NAMES[asked]}'s`
      : "another family's model may have answered";
    finish(fail(`${name} changed its model mid-turn to ${JSON.stringify(now ?? null)}, from the ${JSON.stringify(model)} relay asked for, so relay stopped it and took away its relay tools: ${why}.`));
  };


  // Wait (briefly, bounded) for the denial stream to attach before the harness starts, so its early
  // denials are not missed; a slow or absent log stream resolves this after a short grace (review C4).
  if (denialStream) await denialStream.ready;
  // The last moment a stop can come before the harness exists: after this its turn is in the worker's
  // hands, and a stop cancels it like any other (E18).
  if (spec.signal?.aborted) {
    writeHeader();
    denialStream?.close();
    log.end();
    await launched.close().catch(() => {});
    state.cleanup?.();
    throw new Error(`the turn was stopped while relay was starting ${name}`);
  }
  let started: Rpc;
  try {
    started = connect(launched.command, launched.args, spec.cwd, env, (m, line) => {
      log.agent(m, line);
      if (m.id !== undefined && m.method) {
        if (m.method === "session/request_permission") return void onPermission(m).catch(() => {});
        // Relay offers no file system, terminal or other client methods (it advertised none), and
        // answers at once, so that an agent never waits on a request nobody will serve.
        return rpc.send({ id: m.id, error: { code: METHOD_NOT_FOUND, message: `relay does not provide ${m.method}` } });
      }
      if (m.method === "session/update" && m.params?.sessionId === sessionId && m.params?.update) onUpdate(m.params.update);
    }, cutSecrets);
  } finally {
    // Before anything the harness or a stream sends can be read: those come in later events.
    writeHeader();
  }
  const rpc = started;
  // Kept in the log a whole line at a time, so that a line split across reads stays one line, and
  // redacted a whole line at a time: the tail quoted in an error is made of redacted lines only.
  let errLine = "";
  const logErr = (text: string) => {
    if (!text) return;
    const clean = cutSecrets(text);
    stderrTail.write(clean + "\n");
    if (!log.writableEnded) log.write(clean.replace(/^/gm, "[stderr] ") + "\n");
  };
  rpc.child.stderr!.on("data", (chunk: Buffer) => {
    errLine += chunk.toString();
    const cut = errLine.lastIndexOf("\n");
    if (cut >= 0) {
      logErr(errLine.slice(0, cut));
      errLine = errLine.slice(cut + 1);
    }
  });
  watch = watchProcess(rpc.pid);
  let settling: Promise<void> | undefined;
  const settle = (code: number | null) => settling ??= (async () => {
    for (const timer of stopTimers) clearTimeout(timer);
    // The harness is gone: its relay tools and its network go now, not after the drain below, which
    // anything it left running would otherwise keep using (review r_7feaed80 C3).
    void launched.revoke();
    const unseenMs = watch.stop();
    if (!outcome) {
      // The tail of complete lines and whatever came after the last line break, quoted together:
      // cleaned as the tail's lines are (diagnosticTail), each part after this profile's redaction,
      // and cut to the tail's bound.
      const quoted = diagnosticTail(STDERR_TAIL);
      quoted.write(stderrTail.text() + cutSecrets(errLine));
      outcome = cancelled
        ? { status: "interrupted", error: "cancelled" }
        : fail(`${name} exited (code ${code}) before the turn finished${initialized ? "" : `, before relay could check its login (a harness that is not signed in can stop there). ${profile.login.how}`}. ${quoted.text().trim().split("\n").slice(-3).join(" ")}`.trim());
    }
    for (const answer of pending.values()) answer();
    pending.clear();
    // Whatever the agent started may be holding its output open. The streams get a moment to
    // drain and are then closed, so that neither the turn nor this worker waits on them.
    rpc.child.stdin!.end();
    if (groupRefused) rpc.disconnect();
    else {
      // Cleared once the streams have closed, so that it does not keep the worker alive for a second after its last turn.
      let drained: NodeJS.Timeout | undefined;
      await Promise.race([new Promise((r) => rpc.child.once("close", r)), new Promise((r) => { drained = setTimeout(r, 1000); })]);
      clearTimeout(drained);
    }
    rpc.child.stdout?.destroy();
    rpc.child.stderr?.destroy();
    logErr(errLine);
    log.end();
    // The turn is over only when nothing of the agent is left: children can outlive the leader.
    if (!groupRefused && rpc.pid > 1) groupRefused = !await drainGroup(rpc.pid);
    if (groupRefused) {
      cleanupRefusal ??= `Agent cleanup refused for group ${rpc.pid}`;
      rpc.child.unref();
    }
    const survivors = groupRefused ? [rpc.pid, ...watch.procs().map(p => p.pid)] : await stopProcs(watch.procs());
    denialStream?.close();
    await launched.close().catch(() => {});
    state.cleanup?.();
    // The login store as the turn left it (a stated downgrade): an exchange of two names can put a link
    // or a directory at the token's name, which no rule can tell from a rename (review r_75bf1f48).
    // Quarantine outside the sandbox before reporting, so a later personal harness cannot follow it.
    // Standalone turns have no registry turn id; give them a unique id as well.
    const turn = String(spec.relay?.turnId ?? crypto.randomUUID());
    const component = (s: string) => {
      if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error(`invalid quarantine identity: ${JSON.stringify(s)}`);
      return s;
    };
    let quarantine;
    try {
      if (launched.loginStore) quarantine = quarantineTokenStore(launched.loginStore,
        path.join(relayHome(), "quarantine", component(spec.markers.runId), component(spec.markers.nodeId), component(turn)), turn);
    } catch (err) {
      quarantine = { problem: (err as Error).message, moved: [], errors: [`QUARANTINE FAILED: ${(err as Error).message}`] };
    }
    if (quarantine?.problem) {
      const moved = quarantine.moved.length ? `Relay quarantined ${quarantine.moved.map((m) => `${JSON.stringify(m.name)} to ${JSON.stringify(m.to)}`).join("; ")}. ` : "";
      const failure = quarantine.errors.length ? `${quarantine.errors.join("; ")}. Do not use ${target.product} yourself until these names are put right. ` : "";
      const text = `${launched.loginStore!.name} is not as relay left it: ${quarantine.problem}. ${moved}${failure}You must log in again before using ${target.product}. ${profile.login.how || `Run \`${target.id} login\`.`} Relay refuses this harness's turns until the store passes its check and its login is restored.`;
      outcome = fail(outcome?.status === "failed" ? `${outcome.error}\n${text}` : text);
    }
    notes.push(...logWarnings());
    if (cleanupRefusal) notes.push(cleanupRefusal);
    resolveDone({
      served: servedModels,
      ...outcome, ...(outcome?.error !== undefined ? { error: cleanReport(outcome.error) } : {}),
      sessionId, finalMessage: cleanReport(finalMessage), exitCode: code, ...(notes.length ? { warnings: notes.map(cleanReport) } : {}), ...(prompting ? {} : { delivered: false }),
      ...(survivors.length ? { survivors } : {}), ...(settled || rpc.pid <= 1 ? {} : { unseenMs }), ...(denials.length ? { denials: denials.map(cleanReport) } : {}),
    });
  })();
  rpc.child.on("error", (err) => {
    outcome = fail(`could not start ${bin}: ${err.message}`);
    if (rpc.pid <= 1) void settle(null);
  });
  // "exit", not "close": something the agent started can hold its output open.
  rpc.child.on("exit", (code) => void settle(code));

  (async () => {
    // What the launch must confirm about the running process (relay's sandbox) comes first.
    const unconfined = await launched.verify(rpc.pid);
    if (unconfined) return finish(fail(unconfined));
    // No file system or terminal: the agent uses its own tools, inside relay's confinement.
    const init = await rpc.request("initialize", {
      protocolVersion: ACP_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "relay", title: "relay", version: VERSION },
    }, 60_000);
    initialized = true;
    if (init?.protocolVersion !== ACP_VERSION) {
      return finish(fail(`${name} speaks ACP version ${JSON.stringify(init?.protocolVersion ?? null)}, and relay speaks only version ${ACP_VERSION}, so it does not run it.`));
    }
    // The version: agentInfo's, else _meta.agentVersion (Grok 1.0.62 sends no agentInfo).
    log.write(`# relay: ${name} ${JSON.stringify(init?.agentInfo?.version ?? init?._meta?.agentVersion ?? null)} speaks ACP ${init.protocolVersion}; login methods offered ${JSON.stringify(Array.isArray(init?.authMethods) ? init.authMethods.map((m: any) => m?.id) : [])}\n`);
    const loginProblem = await checkLogin(rpc, init, profile, spec);
    if (loginProblem) return finish(fail(loginProblem));
    if (state.authenticate) {
      const authProblem = await authenticateAsPrepared(rpc, init, state.authenticate, name);
      if (authProblem) return finish(fail(authProblem));
      log.write(`# relay: signed in with ${JSON.stringify(state.authenticate.methodId)}, as the profile prepared\n`);
    }
    // What the harness did while answering initialize that its session's setup must show afresh.
    state.afterInitialize?.();

    const caps = (init.agentCapabilities ?? {}) as Record<string, any>;
    const mcpServers = launched.relay
      ? [{ name: "relay", command: launched.relay.command, args: launched.relay.args, env: Object.entries(launched.relay.env).map(([n, value]) => ({ name: n, value })) }]
      : [];
    const extra = spec.access === "write" ? (spec.grant?.write_paths ?? []) : [];
    const session = { cwd: spec.cwd, mcpServers, ...(extra.length && caps.sessionCapabilities?.additionalDirectories ? { additionalDirectories: extra } : {}) };
    let res: any;
    if (spec.sessionId) {
      // Resume reconnects without replay; load replays the conversation, which is not this turn's reply.
      if (caps.sessionCapabilities?.resume) res = await rpc.request("session/resume", { sessionId: spec.sessionId, ...session });
      else if (caps.loadSession) {
        res = await rpc.request("session/load", { sessionId: spec.sessionId, ...session });
        loaded = true;
        lastUpdate = Date.now();
      } else return finish(fail(`${name} cannot continue an earlier session over ACP, so relay cannot resume this one.`));
    } else {
      res = await rpc.request("session/new", session);
      if (typeof res?.sessionId !== "string") return finish(fail(`${name} did not give the new session an id.`));
      sessionId = res.sessionId;
    }
    takeSession(res);
    // What the session reports, for the turn's log: the evidence for the checks below.
    const offered: string[] | null = Array.isArray(res?.models?.availableModels) ? res.models.availableModels.map((m: any) => m?.modelId).filter((m: unknown): m is string => typeof m === "string") : null;
    log.write(`# relay: ${spec.sessionId ? "continued" : "new"} session ${JSON.stringify(sessionId ?? null)}; mode ${JSON.stringify(modeNow() ?? null)}, model ${JSON.stringify(modelNow() ?? null)}${offered ? `, offered ${JSON.stringify(offered)}` : ""}\n`);
    // A model the harness does not offer this account (Copilot Free offers only "auto") is said
    // plainly, before relay asks for it.
    if (model && offered?.length && !offered.includes(model) && !profile.acceptsUnlistedModels) {
      return finish(fail(`${name} does not offer the model ${JSON.stringify(model)} to this account (it offers ${[...new Set(offered)].map((m) => JSON.stringify(m)).join(", ")}), so relay stopped it before it did anything.`));
    }
    // The login again, now that the session exists: a resumed or loaded session is checked as a new one is.
    const after = await checkLogin(rpc, init, profile, spec);
    if (after) return finish(fail(after));

    // The mode and the model, set where they are not already, and then read back as the agent reports them.
    const mode = profile.mode?.(spec);
    if (mode && modeNow() !== mode) {
      const opt = optionFor("mode");
      if (res?.modes) await rpc.request("session/set_mode", { sessionId, modeId: mode });
      else if (opt) takeOptions((await rpc.request("session/set_config_option", { sessionId, configId: opt[0], value: mode }))?.configOptions);
    }
    if (model && modelNow() !== model) {
      const opt = optionFor("model");
      if (opt) takeOptions((await rpc.request("session/set_config_option", { sessionId, configId: opt[0], value: model }))?.configOptions);
    }
    if (mode && modeNow() !== mode) return finish(fail(`${name} reports the mode ${JSON.stringify(modeNow() ?? null)}, not the ${JSON.stringify(mode)} relay set, so relay stopped it before it did anything.`));
    // The reasoning effort, where the profile says the session reports it: exactly the one asked for.
    if (spec.effort && profile.effortOption) {
      const opt = optionFor(profile.effortOption)?.[1];
      if (opt?.currentValue !== spec.effort) {
        const offers = opt?.values ? ` (it offers ${opt.values.map((v) => JSON.stringify(v)).join(", ")}${model ? ` for ${JSON.stringify(model)}` : ""})` : "";
        return finish(fail(`${name} reports the reasoning effort ${JSON.stringify(opt?.currentValue ?? null)}, not the ${JSON.stringify(spec.effort)} relay asked for${offers}, so relay stopped it before it did anything.`));
      }
    }
    if (pinned || strict) {
      const reported = modelNow();
      if (reported === undefined) return finish(fail(`${name} does not report which model the session uses, so relay cannot tell which family would answer. It stopped it before it did anything.`));
      if (pinned && reported !== model) return finish(fail(`${name} reports the model ${JSON.stringify(reported)}, not the ${JSON.stringify(model)} relay asked for, so relay stopped it before it did anything.`));
    }

    // A replay the harness streams after the load's answer (replaysAfterLoad) is over before the
    // prompt goes out: until then nothing it sends is this turn's.
    if (loaded && profile.replaysAfterLoad) {
      const { quietMs, maxMs } = profile.replaysAfterLoad;
      const giveUp = Date.now() + maxMs;
      for (;;) {
        if (outcome) return;
        const idle = Date.now() - lastUpdate;
        if (idle >= quietMs) break;
        if (Date.now() > giveUp) return finish(fail(`${name} was still replaying the earlier conversation ${Math.round(maxMs / 1000)}s after loading the session, so relay could not tell this turn's reply from it. It stopped it before sending the prompt.`));
        await new Promise((r) => setTimeout(r, Math.min(quietMs - idle, 50)));
      }
      log.write(`# relay: ${name}'s replay of the session is over (no update for ${quietMs} ms); sending the prompt\n`);
    }
    const reported = modelNow();
    if (!served(reported)) return;
    // What the profile has to say now that the session is set up (Gemini: whether its tool discovery
    // ran), before the prompt and in the same message, so that the agent reads it before it acts.
    const agentVersion = typeof init?.agentInfo?.version === "string" ? init.agentInfo.version : null;
    const before = state.beforePrompt?.({ agentVersion });
    for (const note of before?.notes ?? []) {
      notes.push(note);
      log.write(`# relay: ${note}\n`);
    }
    const text = profile.promptText?.(spec.prompt) ?? spec.prompt;
    // Session setup/replay may have grown the never floor; refuse before sending agent work.
    spec.checkEnvironment?.(env);
    verified = true;
    prompting = true;
    const r = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: before?.promptPrefix ? `${before.promptPrefix}\n\n${text}` : text }] });
    const tokens = acpUsage(r?.usage);
    if (tokens) {
      Object.assign(usage, tokens);
      spec.onUsage?.({ ...usage });
    }
    // The response's own list of models, before the profile reads it (Gemini's drops the entries that
    // stand for another model's rounds): replies to relay's requests are not in the agent's log, so
    // this line is the record of what the harness said, against which what relay recorded is checked.
    const listed = promptModels(r);
    if (listed.length) log.write(`# relay: ${name}'s prompt response lists ${listed.map((m) => oneLine(JSON.stringify(m), 120)).join(", ")} in _meta.quota.model_usage\n`);
    // The models that answered, where only the prompt's response says: model reports like the rest.
    let answered: string[] = [];
    try {
      answered = profile.servedModels?.(r, reported) ?? [];
    } catch (err) {
      return finish(fail(`relay could not read which model ${name} says answered (${(err as Error).message}), so it does not count the turn as done.`));
    }
    if (answered.length) log.write(`# relay: ${name} reports ${answered.map((m) => JSON.stringify(m)).join(", then ")} answered this turn (in its prompt response)\n`);
    for (const m of answered) {
      if (pinned && m !== model) switchedModel(m);
      // Every model the response names is recorded, even after one has stopped the turn: each answered
      // all the same (review r_75bf1f48 X1). A stop already taken stays: nothing here restores the tools.
      if (!served(m)) return;
    }
    if (outcome) return;
    const stop = r?.stopReason;
    if (stop === "end_turn") finish({ status: "ok" });
    else if (stop === "cancelled" || cancelled) finish({ status: "interrupted", error: "cancelled" });
    else finish(fail(`${name}'s turn ended with ${JSON.stringify(stop ?? null)}${stop === "refusal" ? " (the model refused)" : stop === "max_tokens" || stop === "max_turn_requests" ? " (it ran out of room before finishing)" : ""}.`));
  })().catch((err: Error) => finish(cancelled ? { status: "interrupted", error: "cancelled" } : fail(`${name} over ACP: ${err.message}`)));

  const cancel = async () => {
    if (cancelled || rpc.pid <= 1) { await done; return; }
    cancelled = true;
    // Cancelled: relay tools and network end at once, whether or not the agent heeds session/cancel.
    void launched.revoke();
    settled = watch.look() || settled;
    // The clean way to stop a turn is to ask the agent, which then stops what it started and
    // answers the prompt "cancelled"; requests it was waiting on are answered "cancelled" first.
    for (const answer of pending.values()) answer();
    pending.clear();
    if (sessionId && prompting) rpc.send({ method: "session/cancel", params: { sessionId } });
    else signalGroup("SIGINT");
    const timer = setTimeout(() => {
      watch.look();
      if (signalGroup("SIGKILL")) killProcs(watch.procs());
    }, cfg.cancel_grace_ms);
    await done;
    clearTimeout(timer);
  };

  return { pid: rpc.pid, pgid: rpc.pid, startedAt: procStart(rpc.pid), done, cancel };
}

const signsInWithLogin = (spec: TurnSpec) => authFor(spec.config, spec.target.id) === "login";

/** Why relay cannot check this harness's login at all, or null: under child_auth "login" a profile must name a way. */
export function loginStrategyProblem(profile: Pick<AcpProfile, "login">, spec: TurnSpec): string | null {
  if (!signsInWithLogin(spec) || profile.login.reuse?.length || profile.login.verify) return null;
  return `relay has no way to check that ${targetLabel(spec.target)} is signed in with an account, and it is set to run agents on their logins only ("child_auth": "any" for targets.${spec.target.id} allows it), so it does not launch it.`;
}

/** The profile's login check, made before the session and again once it exists. Returns what is wrong, or null. */
async function checkLogin(rpc: Rpc, init: any, profile: AcpProfile, spec: TurnSpec): Promise<string | null> {
  const name = targetLabel(spec.target);
  // With child_auth "any", whatever the harness signs in with is accepted.
  if (!signsInWithLogin(spec)) return null;
  const strategy = loginStrategyProblem(profile, spec);
  if (strategy) return strategy;
  if (profile.login.verify) {
    const own = profile.login.verify(init);
    if (own) return own;
  }
  if (!profile.login.reuse?.length) return null;
  const offered = Array.isArray(init?.authMethods) ? (init.authMethods as { id?: unknown }[]).map((m) => m?.id) : [];
  const method = profile.login.reuse.find((id) => offered.includes(id));
  if (!method) return `${name} does not offer the login check relay knows (${profile.login.reuse.join(", ")}), so relay cannot tell that it is signed in with an account. ${profile.login.how}`;
  try {
    await rpc.request("authenticate", { methodId: method }, 30_000);
    return null;
  } catch (err) {
    return `${name} is not signed in (${(err as Error).message}). ${profile.login.how}`;
  }
}

/** The authenticate request a profile prepared (PreparedState.authenticate), made once: what is wrong, or null. */
async function authenticateAsPrepared(rpc: Rpc, init: any, auth: NonNullable<PreparedState["authenticate"]>, name: string): Promise<string | null> {
  const offered = Array.isArray(init?.authMethods) ? (init.authMethods as { id?: unknown }[]).map((m) => m?.id) : [];
  if (!offered.includes(auth.methodId)) return `${name} does not offer the sign-in relay hands it (${JSON.stringify(auth.methodId)}), so relay stopped it before it did anything.`;
  try {
    await rpc.request("authenticate", { methodId: auth.methodId, ...(auth.meta ? { _meta: auth.meta } : {}) }, 30_000);
    return null;
  } catch (err) {
    return `${name} did not accept the sign-in relay handed it (${(err as Error).message}), so relay stopped it before it did anything.`;
  }
}

/** A Backend for a target driven over ACP with `profile`. */
export function acpBackend(profile: AcpProfile): Backend {
  return { start: (spec) => startAcpTurn(spec, profile) };
}
