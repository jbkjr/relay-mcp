import fs from "node:fs";
import path from "node:path";
import { networkOn, RELAY_CLI, relayHome, worktreesHome, type Mode, type RelayConfig } from "../core/config.js";
import { relayProcs } from "../core/db.js";
import { watchProcess as watchProcs, type Watch } from "../core/procs.js";
import { type Speed, type TargetDef } from "../targets/index.js";
import type { DirPin } from "../confine/index.js";
import { checkWriteGrant } from "../confine/seatbelt.js";
import { ensurePrivateRoot, privateStateRoot } from "../confine/private-root.js";
import { clipped, oneLine } from "../core/shown.js";
import { redactOwnReview } from "../core/redact.js";
import { redact, redactor } from "../core/secrets.js";
import { logMaxBytes, remedy, rotateLog } from "../core/storage.js";
import type { VendorRefusal } from "../core/refusal.js";
import type { CodexSubagents } from "./codex-subagents.js";
import { environmentSocketFor, workerEnvironment } from "../core/env-broker.js";
import type { NeverPolicy } from "../core/never-policy.js";

/** An agent's log as a backend writes it: text in, a line at a time on disk. */
export interface AgentLog {
  write(text: string): boolean;
  /** Ends the log, the last line written; `callback` is called once it is closed. */
  end(callback?: () => void): void;
  readonly writableEnded: boolean;
}

/**
 * Opens the agent's log for appending. A failed write never takes the worker down, but it is not
 * swallowed either: `warnings()` gives what the turn's result must say about it (the first failure).
 * What is written goes to disk a whole line at a time, each line with a review's own_review
 * arguments withheld (core/redact.ts) and the secrets relay knows the shape of cut out
 * (core/secrets.ts: by value, those of relay's environment and of `env`, the environment the agent
 * is launched with, which a backend passes when it holds more than relay's own). A line is held
 * until it ends, however long, since a chunk may stop halfway through either. Past `maxBytes` (by
 * default the process's log_max_mb, core/storage.ts) the log is rotated before the line that would
 * take it past: moved to `<file>.1`, replacing an earlier one, and begun again, so that the newest
 * output is kept. A single line longer than `maxBytes` is still written whole, so a file can be
 * longer than that by that line.
 */
export function openAgentLog(file: string, o: { maxBytes?: number | null; env?: NodeJS.ProcessEnv } = {}): { log: AgentLog; warnings(): string[] } {
  const max = o.maxBytes !== undefined ? o.maxBytes : logMaxBytes();
  const cut = redactor(process.env, o.env);
  const clean = (line: string) => cut(redactOwnReview(line, true));
  /** The first write that failed: what it said, and what a person can do about it (storage.ts remedy). */
  let failed: { message: string; hint: string | null } | null = null;
  const fail = (err: unknown) => {
    failed ??= { message: (err as Error).message, hint: remedy(err) };
  };
  let unrotated: string | null = null;
  let size = 0;
  // Written synchronously: a rotation then happens between two writes, never with one in flight.
  const open = (): number | null => {
    try {
      return fs.openSync(file, "a");
    } catch (err) {
      fail(err);
      return null;
    }
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  } catch (err) {
    fail(err);
  }
  let fd = open();
  const out = (text: string) => {
    if (!text || fd === null) return;
    const buf = Buffer.from(text);
    if (max !== null && unrotated === null && size > 0 && size + buf.length > max) {
      // Nothing here throws (rotateLog says what went wrong): this runs in a backend's stream
      // handlers, where a throw would take the worker down mid-turn.
      try {
        fs.closeSync(fd);
      } catch (err) {
        fail(err);
      }
      fd = null;
      unrotated = rotateLog(file, 0);
      fd = open();
      if (fd === null) return;
      try {
        size = fs.fstatSync(fd).size;
      } catch {
        size = 0;
      }
    }
    try {
      for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off);
      size += buf.length;
    } catch (err) {
      fail(err);
    }
  };
  /**
   * The end of the text written so far that is not yet a whole line, as the chunks it came in: a
   * line break is looked for only in each new chunk, so that a long line arriving in many chunks is
   * held in time linear in its length rather than scanned again at every chunk.
   */
  let held: string[] = [];
  let ended = false;
  const log: AgentLog = {
    write(text: string): boolean {
      if (ended) return false;
      const nl = text.lastIndexOf("\n");
      if (nl < 0) {
        if (text) held.push(text);
        return true;
      }
      const whole = held.join("") + text.slice(0, nl);
      held = nl + 1 < text.length ? [text.slice(nl + 1)] : [];
      // One line at a time, so that the log is rotated between two lines of a chunk too.
      for (const l of whole.split("\n")) out(`${clean(l)}\n`);
      return true;
    },
    end(callback?: () => void): void {
      if (!ended) {
        ended = true;
        const partial = held.join("");
        if (partial) out(clean(partial));
        held = [];
        try {
          if (fd !== null) fs.closeSync(fd);
        } catch {
          // Nothing more is written to it either way.
        }
        fd = null;
      }
      if (callback) queueMicrotask(callback);
    },
    get writableEnded() {
      return ended;
    },
  };
  return {
    log,
    warnings: () => [
      ...(failed ? [`relay could not write the agent's log ${file} (${failed.message}), so the log may be missing or incomplete, though the turn itself went on${failed.hint ? `: ${failed.hint}` : ""}`] : []),
      ...(unrotated ? [`relay could not rotate the agent's log ${file} at log_max_mb (${unrotated}), so it grew past that`] : []),
    ],
  };
}

/** Identity handed to the child's own relay MCP server. null means the child gets no relay tools. */
export interface ChildContext {
  runId: string;
  nodeId: string;
  depth: number;
  contextFile: string;
  /** The turn this context is for, and what it may do: what a broker serving the turn checks every request against. */
  turnId?: number;
  mayDelegate?: boolean;
  mayAsk?: boolean;
}

export interface Grant {
  network?: boolean;
  /**
   * A Codex write job's shell may reach this Mac's loopback and the local network through Codex's
   * proxy (codex-network.ts local mode). Needs network too, and the person's consent before the
   * job's first turn under it (session.ts localNetworkConsent).
   */
  local_network?: boolean;
  /**
   * Stage 2 (docs/codex-confinement-design.md §6, decision D1): a Codex job's shell gets raw network
   * (TCP, UDP, ssh, DNS), this Mac's loopback but the denied ports, the LAN and tailnet, and a
   * TCP port block of its own, inside relay's Seatbelt. Person-only consent (core/raw-network.ts).
   * Codex write jobs only, with network: true; never with local_network (raw-network.ts rawNetworkGrantProblem).
   */
  raw_network?: boolean;
  /** Exact root environment names requested for this turn only; values never enter the registry. */
  env?: string[];
  write_paths?: string[];
  /** Each write_paths entry as relay found it when the grant was authorised (dirIdentity): resolved path, device, inode. A relay-enforced turn checks each is still that directory, reached through real directories only. */
  write_path_pins?: DirPin[];
}

/** Something a launched agent wants to do outside its sandbox. */
export interface ApprovalAsk {
  /**
   * extensions: consent to a session's extensions; mcp: a call of an extension server's tool
   * (docs/extensions.md); path: a harness's own check of a path outside the directories it trusts,
   * asked by an agent inside relay's sandbox, which still decides what the agent can touch
   * (Copilot's "Access paths outside trusted directories"; its `detail.path_access` says whether
   * the agent would read or write there, as far as relay can tell).
   */
  kind: "command" | "file" | "tool" | "web" | "extensions" | "mcp" | "env" | "path" | "local_network" | "raw_network" | "escalation";
  summary: string;
  reason?: string;
  detail?: unknown;
  /** For kind "file": the files the change would touch, absolute or relative to the agent's directory. For kind "path": the paths the agent asked for, absolute. */
  paths?: string[];
}

/**
 * What a path request (kind "path") would let the agent do there: read, write, or either, when
 * relay cannot tell from what the agent said (which it then takes as writing).
 */
export type PathAccess = "read" | "write" | "read or write";
export const pathAccessOf = (ask: Pick<ApprovalAsk, "detail">): PathAccess => {
  const a = (ask.detail && typeof ask.detail === "object" ? ask.detail : {}) as { path_access?: unknown };
  return a.path_access === "read" || a.path_access === "write" ? a.path_access : "read or write";
};

/**
 * Whether a read-only turn may ask for this at all: to reach the web, to run a command, consent to
 * extensions, a call of an extension's tool, environment values, or past a harness's own check of
 * a path it would only read. Never to change files, nor past a check for a path it could write.
 */
export function askableReadOnly(ask: Pick<ApprovalAsk, "kind" | "detail">): boolean {
  if (ask.kind === "path") return pathAccessOf(ask) === "read";
  return ["web", "command", "extensions", "mcp", "env", "escalation"].includes(ask.kind);
}
/**
 * What makes two approval requests the same request, for an approval for the rest of the job: the
 * kind, the command (its argv where the agent gave one), the directory it runs in, and the files,
 * each path resolved against that directory. `cwd` is the agent's own directory, for a request
 * that names none.
 */
export function approvalKey(ask: ApprovalAsk, cwd: string): string {
  const d = (ask.detail && typeof ask.detail === "object" ? ask.detail : {}) as { cwd?: unknown; argv?: unknown };
  const dir = path.resolve(cwd, typeof d.cwd === "string" ? d.cwd : ".");
  const paths = [...new Set((ask.paths ?? []).map((p) => path.resolve(dir, p)))].sort();
  return JSON.stringify({ kind: ask.kind, command: Array.isArray(d.argv) ? d.argv : ask.summary, cwd: dir, paths });
}

export interface ApprovalAnswer {
  allow: boolean;
  /** The decision covers the rest of the job, not only this one action. */
  forJob?: boolean;
  note?: string;
  /** The note recorded with a decision (approve's or confirm's note, the dialog's note, or the dialog's "declined by the user"), if any; not relay's reasons for refusing on its own. */
  deciderNote?: string;
  /** Who decided, in words for the agent that asked ("by the user in relay's approval dialog"), when a decision was made. */
  decider?: string;
}

export interface TurnSpec {
  /** Consumed, destination-bound restart overlay; never copied into standing grant. */
  overlay?: import("../core/restart-overlay.js").OverlayRecord;
  /** Durable cumulative snapshot captured at launch, shared by every provider. */
  neverPolicy?: NeverPolicy;
  /** Registry turn identity, even when the harness receives no relay MCP tools. */
  turnId?: number;
  /** Recorded synchronously before the prompt and whenever the harness reports a model. */
  onServed?: (model: string | null) => void;
  /** Record a waiver before the agent can make nested calls. */
  onWaived?: (which: "claude_settings_env" | "codex_endpoint_override") => void;
  /** A plain policy note, recorded before launch and shown in status and results. */
  onNote?: (note: string) => void;
  /** The target this turn runs, as the registry has it. */
  target: TargetDef;
  /** Resume this session when set; otherwise start a new one. */
  sessionId?: string;
  prompt: string;
  cwd: string;
  /** Applied on every turn, including resumed ones, regardless of how the session was created. */
  access: Mode;
  /** Caller host-state directories to deny reading, for the independent review turn only. */
  reviewReadDeny?: string[];
  relay: ChildContext | null;
  model?: string;
  effort?: string;
  /** The speed to ask the harness for (see Speed), pinned on every turn: standard when unset. */
  speed?: Speed;
  config: RelayConfig;
  /** Root broker's checked inherited selection, transferred only in memory for this turn. */
  environment?: NodeJS.ProcessEnv;
  /** Explicitly released names, registered by value within the turn redaction scope. */
  environmentReleased?: readonly string[];
  /** Launcher version gate, called with the final checked environment before any harness process. */
  checkEnvironment?: (env: NodeJS.ProcessEnv) => void;
  /** Scratch directory for generated config files and logs. */
  dir: string;
  logPath: string;
  /** True when this turn may ask for approval to act outside its sandbox. */
  escalate?: boolean;
  /** Files an approval request and waits for the decision (used by backends that receive requests in-process). */
  onApproval?: (ask: ApprovalAsk, turnOver: () => boolean) => Promise<ApprovalAnswer>;
  /**
   * Whether this exact request was allowed earlier for the rest of the job. For backends whose
   * agent has no job-scoped approval of its own (ACP): relay holds that scope and answers each
   * later matching request allow-once.
   */
  heldForJob?: (ask: ApprovalAsk) => boolean;
  /** Extra permissions for a write turn, granted by the root session. */
  grant?: Grant;
  /** Git directories to open for writing when child_git = "native". */
  gitDirs?: string[];
  /** The job's worktree as relay created it, which relay-enforced confinement checks is still the same directory. */
  worktreePin?: DirPin;
  /**
   * For a turn in a job's worktree: GIT_DIR and GIT_WORK_TREE as the repository records them, for
   * any git relay runs while launching it. The worktree's own `.git` file is the agent's to rewrite.
   */
  gitEnv?: { GIT_DIR: string; GIT_WORK_TREE: string };
  /** Context markers for the child process itself, so a duplicate relay server can detect it is one. */
  markers: { runId: string; nodeId: string; depth: number };
  /**
   * The skills this turn was given (docs/extensions.md): the package relay built for it (`dir`,
   * holding .claude-plugin/ and skills/<name>/) and the skills' names. The backend loads exactly
   * these and checks that the harness loads nothing else of the kind.
   */
  skills?: { dir: string; names: string[] };
  /**
   * The extension MCP servers this turn's relay server offers through its gateway, by name
   * (docs/extensions.md). The host's own web tools then ask, or are off, as under child_web "ask",
   * whatever the user's settings say: a search or fetch could carry a credential the agent read to
   * a server's service, past relay's gate.
   */
  extensionServers?: string[];
  /** Told what the agent has just started doing (a command, a tool, a file), as its event stream says. */
  onActivity?: (text: string) => void;
  /** Told the turn's token usage (and cost) whenever the agent reports it; the last report stands. */
  onUsage?: (usage: Usage) => void;
  /**
   * Aborted when the worker is stopping. A start that awaits something before it launches the agent
   * (the `codex exec` fallback's configuration check) gives up then; whatever a start launches all
   * the same is cancelled by the worker once the start has settled (session.ts).
   */
  signal?: AbortSignal;
}

/**
 * Token usage as a harness reports it, in relay's names. `cumulative`: the numbers are the
 * session's running total (Codex reports its thread's), not this turn's alone (Claude's result,
 * `codex exec`'s turn.completed).
 */
export interface Usage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  /** Model round trips within the turn, where the harness counts them (Claude's num_turns). */
  agent_steps?: number;
  cumulative?: boolean;
  /**
   * What the harness reported about its speed for the turn, in its own names, where it reports
   * any: Claude's fast_mode_state and fast_mode_disabled_reason, and its usage.speed (the speed
   * it ran at); and `notice`, the text of the notice Claude puts on its stream when it refused a
   * fast request and retried it at standard speed (usage credits run out, a spend cap reached),
   * which its result does not show. Codex reports none.
   */
  speed_report?: { fast_mode_state?: string; fast_mode_disabled_reason?: string; speed?: string; notice?: string };
  /** The speed relay asked for on the turn, kept with speed_report: the request that report answers. */
  speed_requested?: Speed;
}

/** Picks the numbers out of a usage object, by the names the harnesses use. Null when there are none. */
export function usageFrom(raw: unknown, extra: Partial<Usage> = {}): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (...keys: string[]) => keys.map((k) => r[k]).find((v): v is number => typeof v === "number" && Number.isFinite(v));
  const u: Usage = {
    input_tokens: num("input_tokens", "inputTokens"),
    cached_input_tokens: num("cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens"),
    cache_creation_input_tokens: num("cache_creation_input_tokens"),
    output_tokens: num("output_tokens", "outputTokens"),
    reasoning_output_tokens: num("reasoning_output_tokens", "reasoningOutputTokens"),
    total_tokens: num("total_tokens", "totalTokens"),
    ...extra,
  };
  for (const k of Object.keys(u) as (keyof Usage)[]) if (u[k] === undefined) delete u[k];
  return Object.keys(u).some((k) => k !== "cumulative") ? u : null;
}


/**
 * What a tool call is doing, in a few words, for progress lines and the commands an agent was
 * refused: the command, the file, the query. Takes Claude's tool names and inputs and Codex's item
 * types (app server and exec). Every part the agent chose is cut of the secrets relay knows the
 * shape of (core/secrets.ts) as the agent gave it, before it is clipped or escaped, which could cut
 * a secret in two or turn the line break before it into text; then put on one line and escaped
 * (oneLine: what an activity says reaches a person's terminal in relay tree and progress lines,
 * review C12).
 */
export function activityOf(tool: string, input: Record<string, unknown> = {}): string | null {
  const said = (v: unknown) => redact(String(v ?? ""));
  const line = (v: unknown, max: number) => oneLine(said(v), max);
  const file = input.file_path ?? input.path ?? input.notebook_path;
  switch (tool) {
    case "Bash": case "commandExecution": case "command_execution":
      return input.command !== undefined ? `$ ${clipped(said(Array.isArray(input.command) ? input.command.join(" ") : input.command), 160)}` : "running a command";
    case "fileChange": case "file_change": {
      const paths = ((input.changes ?? []) as { path?: unknown }[]).map((c) => c?.path).filter((x) => typeof x === "string");
      return `editing ${paths.length ? line(paths.join(", "), 160) : "files"}`;
    }
    case "mcpToolCall": case "mcp_tool_call":
      return `tool ${line(input.server, 160)}.${line(input.tool, 160)}`;
    case "webSearch": case "web_search": case "WebSearch":
      return `web search: ${line(input.query, 160)}`;
    case "WebFetch":
      return `fetching ${line(input.url, 160)}`;
    case "Grep": case "Glob":
      return `${tool.toLowerCase()} ${line(input.pattern, 160)}`;
    case "reasoning": case "agentMessage": case "agent_message": case "userMessage": case "user_message":
      return null;
  }
  if (typeof file === "string") return `${line(tool, 60)} ${line(file, 160)}`;
  return /^[A-Za-z][\w.-]*$/.test(tool) ? tool : null;
}

export interface TurnResult {
  /** Models reported by the harness, in order. */
  served?: string[];
  /** What the caller must be told that does not invalidate the agent's answer, such as cleanup problems or model switches. */
  warnings?: string[];
  /**
   * What the caller must be told about the speed the turn ran at (claude.ts ranSlower): a fast turn
   * that ran at standard, or that Claude did not say. Reported with the warnings, but kept apart
   * from them, since it says nothing about what the agent may have left running: a write job's
   * unchanged worktree is still dropped (worktree.ts endJobTurn).
   */
  speedWarnings?: string[];
  /** Processes the agent started that could not be confirmed stopped when the turn ended. */
  survivors?: number[];
  /**
   * Set when relay could not take a last look at the agent's processes while it was still alive
   * (it crashed, or was gone before the look): how long before its exit the last good look was.
   * Anything the agent started in that time cannot be traced and may still be running.
   */
  unseenMs?: number;
  status: "ok" | "failed" | "interrupted" | "refused";
  refusal?: VendorRefusal;
  /**
   * Actions the agent tried and was refused, as its own event stream reports them (a permission
   * denied, an approval declined). A turn that finishes with any is reported as blocked, not done.
   */
  denials?: string[];
  sessionId?: string;
  /**
   * False when relay knows this turn's prompt never reached the agent: it was refused or stopped
   * after its session was created and before the prompt was handed over. A new session's id is then
   * not kept, so that the next turn starts afresh with every earlier message replayed.
   */
  delivered?: boolean;
  finalMessage: string;
  error?: string;
  exitCode: number | null;
}

export interface TurnHandle {
  pid: number;
  pgid: number;
  /** When the agent process started, as ps reports it; recorded so the pid is never mistaken for a later process. */
  startedAt: string | null;
  done: Promise<TurnResult>;
  cancel(): Promise<void>;
}

export interface Invocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Accumulates what the event stream says about a turn. */
export interface StreamState {
  sessionId?: string;
  finalMessage: string;
  completed: boolean;
  failed?: string;
  refusal?: VendorRefusal;
  /** Set by the event after which the agent starts nothing more. An error alone is not that: Codex reports errors it then retries. */
  ended?: boolean;
  /** Set when what the agent reports about itself at start is not what relay asked for. The agent is stopped at once. */
  refuse?: string;
  /** Set when something the agent's turn depends on fails after the prompt has reached it (a check made later than its start report). The agent is stopped at once and the turn fails. */
  stop?: string;
  /** Actions the agent was refused, as the stream reports them (see TurnResult.denials). */
  denials?: string[];
  /** Backend warnings kept alongside the runner's own log/process warnings. */
  warnings?: string[];
  /** Native agents reported by Codex exec's collaboration items in this turn. */
  codexSubagents?: CodexSubagents;
  /** What the caller must be told about the turn's speed, from what the stream reported (see TurnResult.speedWarnings). */
  speedWarnings?: string[];
  /** What the agent said about its speed on its stream, apart from its result (Claude's fast-mode notice), for the turn's speed report. */
  speedNotices?: string[];
}

/**
 * How relay runs one turn of a target's CLI (BACKENDS has one for each target). start refuses, by
 * rejecting, what it will not launch; the version gate comes first (run.ts launchTurn). A CLI that
 * reads its prompt on stdin and writes one JSON event per line runs through run.ts streamTurn;
 * one that does not runs the turn itself (Codex's app server, an ACP harness).
 */
export interface Backend {
  start(spec: TurnSpec): Promise<TurnHandle>;
}

/** What a CLI run by streamTurn says, one JSON object per line, is read into the turn's state by its onEvent. */
export type OnEvent = (event: Record<string, unknown>, state: StreamState, spec: TurnSpec) => void;

/** Command line for the child's relay MCP server, with its context passed as an argument. */
export function relayServerCommand(ctx: ChildContext): { command: string; args: string[]; env: Record<string, string> } {
  const env = {
    ...workerEnvironment(ctx.runId),
    RELAY_ENV_SOCKET: environmentSocketFor(ctx.runId),
    RELAY_RUN_ID: ctx.runId, RELAY_NODE_ID: ctx.nodeId, RELAY_DEPTH: String(ctx.depth), RELAY_INJECTED: "1",
    RELAY_HOME: relayHome(), RELAY_WORKTREES: worktreesHome(), TMPDIR: ensurePrivateRoot(privateStateRoot()),
  };
  return {
    // Native MCP launchers normally inherit the harness's entire environment. Start this trusted
    // server with controls only, so even this turn's disclosed values cannot reach descendants.
    command: "/usr/bin/env",
    args: ["-i", ...Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined).map(([k, v]) => `${k}=${v}`), process.execPath, RELAY_CLI, "mcp", "--context", ctx.contextFile],
    env: {},
  };
}

/**
 * What a turn's spec makes of its policy, derived in one place: full access (allow_dangerous, for
 * write turns only), the network (a grant or child_network, networkOn), the write paths granted
 * beyond the worktree, and whether what would prompt goes to relay (escalation, where the agent has
 * relay's server, and never with full access).
 */
export function turnPolicy(spec: TurnSpec): { dangerous: boolean; network: boolean; writePaths: string[]; ask: boolean } {
  checkWriteGrant(spec.grant?.write_paths ?? [], spec.grant?.write_path_pins);
  const dangerous = spec.config.allow_dangerous && spec.access === "write";
  return { dangerous, network: networkOn(spec.config, spec.grant), writePaths: spec.grant?.write_paths ?? [], ask: Boolean(spec.escalate && spec.relay) && !dangerous };
}

/** watchProcess (core/procs.ts), sparing relay's own registered processes, read afresh at each look (review C5). */
export const watchProcess = (pid: number): Watch => watchProcs(pid, relayProcs);

