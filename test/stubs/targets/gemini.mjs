// A stub ACP agent standing in for Gemini CLI 0.64.0's `gemini --acp`, in the dialect relay's Gemini
// profile relies on (backends/gemini.ts; each point read in the 0.64.0 package, docs/gemini.md):
//
// - initialize offers Gemini's four login methods and no login state; loadSession, no session/resume.
// - authenticate {methodId: "gemini-api-key", _meta: {"api-key": <key>}} keeps the key in memory for
//   the process's later sessions (GeminiAgent.authenticate). session/new and session/load sign in as
//   the user settings say (security.auth.selectedType, in $GEMINI_CLI_HOME/.gemini/settings.json):
//   with "gemini-api-key", from that key, else GEMINI_API_KEY in its environment; without either they
//   fail with -32000 "Gemini API key is missing or not configured."
// - Its session lists a menu of models (as the real 0.64.0 listed it under relay's sandbox), not every
//   id it takes: --model takes any id. The session reports --model, else "auto".
// - With security.environmentVariableRedaction on, the commands its tools run do not see variables
//   that look like secrets (sanitizeEnvironment, 0.64.0); the stub drops them from its own
//   environment once it has read the key, since its steps' commands inherit that.
// - In an untrusted folder (GEMINI_CLI_TRUST_WORKSPACE=false) no MCP server connects, the ones passed
//   in session/new included, and its approval mode is "default".
// - Its command-based tool discovery runs in any folder, as 0.64.0's does (tool-registry.ts:376-540,
//   no trust check), whenever a config of it is initialized: while it answers initialize, for its
//   start-up config (acpRpcDispatcher.ts:81), and when each session is made or loaded
//   (acpSessionManager.ts newSession, loadSession): tools.discoveryCommand from the user settings,
//   split into words as shell-quote splits it and run without a shell; a non-zero exit, or output
//   that is not a JSON list, fails initialize, session/new or session/load. Each function declaration
//   (bare, or under function_declarations or functionDeclarations) becomes a tool named
//   discovered_tool_<name>. A step's `call` names one so; it runs tools.callCommand, without a shell,
//   with the tool's own name as its one argument and the arguments as JSON on stdin, its stdout the
//   result; an error starting it, a non-zero exit, a signal or any stderr is a failure, reported to
//   the model as 0.64.0 reports it (Stdout, Stderr, Error, Exit Code, Signal; tool-registry.ts:76-180).
//   `tools` lists them. Both commands run with the environment its redaction leaves (above).
//   STUB_GEMINI_SKIP_DISCOVERY: "1", it runs no discovery at all, as a release that changed when it
//   runs it might, for relay's check at launch that discovery ran; "load", none for session/load only
//   (initialize still runs it, as 0.64.0 does, which is what relay's check must not be fooled by).
// - initialize reports agentInfo.version as `--version` prints it (getVersion, the package's): 0.64.0,
//   or STUB_VERSION's first word.
// - Its tool calls carry no rawInput: a shell command's title is the command, and its one text
//   content says where it runs and why ("[in <dir_path>] (<description>)").
// - The prompt's response says which models answered in _meta.quota.model_usage[].model, and
//   nothing else does. As 0.64.0 builds it (acpSession.ts, modelUsageMap): the main loop only, one
//   entry per model in order of first use; the first round under the model it was routed to (its
//   ModelInfo), every later round, after a tool call, under the configured id (--model, else
//   "auto"). A session's first prompt here has one tool call (read_file-1), so two rounds; a loaded
//   session's prompt has none, so one. A `routed` hook step
//   names the model the first round was routed to (by Gemini's router, or a pin it promoted to a
//   newer id); else the pin, or under an alias gemini-3.8-flash. (A fallback taken inside a round
//   would be listed under the model that failed, which the stub does not model.)
// - With SANDBOX=sandbox-exec its runtime state (sessions) is under $GEMINI_CLI_HOME/.cache/.gemini,
//   otherwise under $GEMINI_CLI_HOME/.gemini.
// - session/load answers first and then streams the conversation, one update at a time (0.64.0
//   acpSessionManager.ts loadSession calls streamHistory without waiting for it, then returns): each
//   earlier prompt as a user_message_chunk, then what the agent said and its tool call, ending with
//   its reply, as acpSession.ts streamHistory sends them. STUB_GEMINI_REPLAY_STALL_MS pauses the
//   replay before each prompt after the first; STUB_GEMINI_EXIT_IN_REPLAY has the agent die after
//   replaying the first.
// - A prompt's first words come after the model's latency (STUB_GEMINI_LATENCY_MS, default 100). A
//   loaded session's prompt is answered with text alone, no tool call (one round).
// - A prompt whose text starts with "/" or "$" and names one of its ACP commands (memory, extensions,
//   init, restore, about, help) is run as that command, never reaching the model (acpSession.ts
//   prompt, acpCommandHandler.ts), with an empty model_usage.
// - STUB_GEMINI_REPORT_MODEL: the session reports that model, whatever --model says.
// - STUB_GEMINI_REFUSE_SIGNIN: authenticate fails, its message quoting the key it was handed (as an
//   error that quotes a request would).
// - At every start, unless the user settings turn general.sessionRetention off, it deletes each
//   session file with nothing resumable in it, here one whose prompts all failed before a reply
//   (0.64.0 gemini.tsx main, cleanupExpiredSessions; sessionUtils.ts getAllSessionFiles drops a file
//   without hasResumableContent, and identifySessionsToDelete deletes every such file). It loads a
//   session by its id whether or not it has a reply (acpSessionManager.ts loadSession, allowEmpty).
// - session/load of a session it has no file for fails as 0.64.0's does: -32603 "Internal error", with
//   the reason in data.details ("Invalid session identifier …"). STUB_GEMINI_LOAD_ERROR fails every
//   session/load so, for another reason, quoting the key it was handed in data.details.
//
// It runs under relay's own sandbox, so its records go to stderr as `STUB-RECORD <json>` lines, which
// relay keeps in the agent's log. It never records the key, only whether one came and its SHA-256.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { procArgs } from "../procargs.mjs";
import { runSteps } from "../stub-agent.mjs";

/** What 0.64.0 names a discovered tool: this prefix and the name its declaration gives (tool-names.ts:237). */
const DISCOVERED_PREFIX = "discovered_tool_";
/**
 * A command line in words, as shell-quote's parse splits one with no environment (0.64.0 parses
 * tools.discoveryCommand so, tool-registry.ts:383): single quotes literal, backslashes and double
 * quotes escaping, a variable expanded to nothing. Operators are not modelled; relay's has none.
 */
function parseCommand(s) {
  const words = [];
  let word = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unterminated quote in ${s}`);
      word = (word ?? "") + s.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      word ??= "";
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === "\\" && i + 1 < s.length) word += s[++i];
        else if (s[i] === "$") while (i + 1 < s.length && /\w/.test(s[i + 1])) i++;
        else word += s[i];
      }
    } else if (c === "\\" && i + 1 < s.length) {
      word = (word ?? "") + s[++i];
    } else if (c === "$") {
      word ??= "";
      while (i + 1 < s.length && /\w/.test(s[i + 1])) i++;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}
/** Runs a command without a shell, as 0.64.0 runs discovery and calls: what it wrote, and how it ended. */
function runCommand(command, args, input) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", error = null;
    let child;
    try {
      child = spawn(command, args, { env: process.env });
    } catch (err) {
      return resolve({ stdout, stderr, error: String(err), code: null, signal: null });
    }
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => (error = String(err)));
    child.on("close", (code, signal) => resolve({ stdout, stderr, error, code, signal }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

/** Gemini's model aliases (config/models.ts), which serve nothing themselves. */
const ALIASES = new Set(["auto", "pro", "flash", "flash-lite", "auto-gemini-3", "auto-gemini-2.5"]);
const MODES = [{ id: "default", name: "Default" }, { id: "autoEdit", name: "Auto Edit" }, { id: "yolo", name: "YOLO" }];
/** The menu the real 0.64.0's session listed under relay's sandbox, 2026-10-17 (buildAvailableModels). */
const MODELS = ["auto", "gemini-3.1-pro-preview-customtools", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-3.8-flash", "gemini-3.5-flash-lite"];
const AUTH_METHODS = [
  { id: "oauth-personal", name: "Log in with Google", description: "Log in with your Google account" },
  { id: "gemini-api-key", name: "Gemini API key", description: "Use an API key with Gemini Developer API", _meta: { "api-key": { provider: "google" } } },
  { id: "vertex-ai", name: "Vertex AI", description: "Use an API key with Vertex AI GenAI API" },
  { id: "gateway", name: "AI API Gateway", description: "Use a custom AI API Gateway", _meta: { gateway: { protocol: "google", restartRequired: "false" } } },
];
/** Names and values Gemini's redaction keeps from its tools (environmentSanitization.ts, abridged). */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|AUTH|CREDENTIAL|CREDS|PRIVATE|CERT/i;
const SECRET_VALUE = /(https?|ftp|smtp):\/\/[^:\s]{1,1024}:[^@\s]{1,1024}@|AIzaSy[a-zA-Z0-9_\\-]{33}/i;

const record = (obj) => process.stderr.write(`STUB-RECORD ${JSON.stringify({ t: Date.now(), pid: process.pid, ...obj })}\n`);
const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const home = () => process.env.GEMINI_CLI_HOME ?? process.cwd();
const runtimeDir = () => (process.env.SANDBOX === "sandbox-exec" ? path.join(home(), ".cache", ".gemini") : path.join(home(), ".gemini"));
function settings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(home(), ".gemini", "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

function sessionFile(id) {
  const dir = path.join(runtimeDir(), "tmp", "stub", "chats");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.json`);
}

async function acpServer(argv) {
  // A key in its environment, read as Gemini reads it, then kept from the commands its tools run when
  // redaction is on. A key handed over in authenticate replaces it.
  const envKey = process.env.GEMINI_API_KEY || undefined;
  // Which other credentials it was started with, before its redaction drops them from its tools:
  // other vendors' keys, and relay's proxy URL with the turn's token in it (the control for what
  // its tools then see). The proxy URL is kept for its own requests, as Gemini's undici agent keeps it.
  const startProxy = process.env.HTTPS_PROXY;
  const startedWith = { google: Boolean(process.env.GOOGLE_API_KEY), anthropic: Boolean(process.env.ANTHROPIC_API_KEY), openai: Boolean(process.env.OPENAI_API_KEY), proxy: /^https?:\/\/[^:@\s]+:[^@\s]+@/.test(startProxy ?? "") };
  let apiKey = envKey;
  let keyFrom = envKey ? "env" : null;
  const userSettings = settings();
  // Its start-up session cleanup, on unless the user settings turn it off (0.64.0's default is on).
  if (userSettings.general?.sessionRetention?.enabled !== false) {
    const dir = path.dirname(sessionFile("cleanup"));
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      let replies = 0;
      try { replies = JSON.parse(fs.readFileSync(file, "utf8")).replies ?? 0; } catch { /* unreadable: deleted too */ }
      if (!replies) { fs.rmSync(file, { force: true }); record({ event: "session-cleanup", deleted: name }); }
    }
  }
  const redaction = userSettings.security?.environmentVariableRedaction?.enabled === true;
  if (redaction) for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GEMINI_CLI_") && (SECRET_NAME.test(k) || SECRET_VALUE.test(v ?? ""))) delete process.env[k];

  // Its command-based tool discovery, from the user settings (the only settings an untrusted folder loads).
  const toolCommands = { discoveryCommand: userSettings.tools?.discoveryCommand ?? null, callCommand: userSettings.tools?.callCommand ?? null };
  /** Runs discovery as a session's config is initialized; the tools by the name the model calls them, or throws as session setup would fail. */
  const discover = async (loading = false) => {
    const tools = new Map();
    // A Gemini that does not run discovery at session setup (a release that changed it), for relay's launch check.
    const skip = process.env.STUB_GEMINI_SKIP_DISCOVERY;
    if (!toolCommands.discoveryCommand || skip === "1" || (skip === "load" && loading)) return tools;
    const [command, ...args] = parseCommand(toolCommands.discoveryCommand);
    const r = await runCommand(command, args);
    if (r.error) throw new Error(r.error);
    if (r.code !== 0) throw new Error(`Tool discovery command failed with exit code ${r.code}`);
    const items = JSON.parse(r.stdout.trim());
    if (!Array.isArray(items)) throw new Error("Tool discovery command did not return a JSON array of tools.");
    const functions = items.flatMap((t) => (Array.isArray(t?.function_declarations) ? t.function_declarations : Array.isArray(t?.functionDeclarations) ? t.functionDeclarations : t?.name ? [t] : []));
    for (const f of functions) if (f.name) tools.set(DISCOVERED_PREFIX + f.name, { original: f.name, description: f.description ?? "", parameters: f.parametersJsonSchema ?? {} });
    return tools;
  };
  /** Whether the mark relay's --list leaves is there, by the path relay's bridge.json names (for tests). */
  const discoveryMark = () => {
    if (!toolCommands.callCommand) return null;
    try {
      const listed = JSON.parse(fs.readFileSync(path.join(path.dirname(toolCommands.callCommand), "bridge.json"), "utf8")).listed;
      return { path: listed, there: fs.existsSync(listed) };
    } catch (err) {
      return { error: err.code ?? String(err) };
    }
  };
  /** A discovered tool called as the model calls it: the result as relay's tools give it (JSON), or a failure as 0.64.0 reports one. */
  const callDiscovered = async (tools, name, params) => {
    const tool = tools.get(name);
    if (!tool) return { error: `Tool "${name}" not found in registry.` };
    const r = await runCommand(toolCommands.callCommand, [tool.original], JSON.stringify(params));
    record({ event: "discovered-call", name, code: r.code, stderr: Boolean(r.stderr) });
    if (r.error || r.code !== 0 || r.signal || r.stderr) {
      return { error: [`Stdout: ${r.stdout || "(empty)"}`, `Stderr: ${r.stderr || "(empty)"}`, `Error: ${r.error ?? "(none)"}`, `Exit Code: ${r.code ?? "(none)"}`, `Signal: ${r.signal ?? "(none)"}`].join("\n") };
    }
    try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout }; }
  };

  const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const answers = new Map();
  let nextId = 1000;
  const toClient = (method, params, timeoutMs = 120000) => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { answers.delete(id); resolve({ timeout: true }); }, timeoutMs);
    answers.set(id, (m) => { clearTimeout(timer); resolve(m); });
    out({ id, method, params });
  });
  const update = (sessionId, u) => out({ method: "session/update", params: { sessionId, update: u } });

  const trusted = process.env.GEMINI_CLI_TRUST_WORKSPACE !== "false";
  let session = null;
  let mode = "default";
  const model = flag(argv, "--model") ?? "auto";
  let cancelled = false;
  let finishPrompt = null;
  let calls = 0;
  const sessionResult = () => ({
    modes: { currentModeId: mode, availableModes: MODES },
    models: { currentModelId: process.env.STUB_GEMINI_REPORT_MODEL || model, availableModels: MODELS.map((modelId) => ({ modelId, name: modelId })) },
  });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  /** The conversation so far, streamed after session/load has answered, as 0.64.0 streams it. */
  const replay = async (id, turns) => {
    await pause(20);
    for (let n = 1; n <= turns; n++) {
      if (n > 1 && process.env.STUB_GEMINI_EXIT_IN_REPLAY) {
        process.stderr.write("stub: died in the middle of its replay\n", () => process.exit(4));
        return;
      }
      if (n > 1 && process.env.STUB_GEMINI_REPLAY_STALL_MS) await pause(Number(process.env.STUB_GEMINI_REPLAY_STALL_MS));
      for (const u of [
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: `the prompt of turn ${n}` } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me look. " } },
        { sessionUpdate: "tool_call", toolCallId: `read_file-${n}`, status: "completed", title: "README.md", content: [], kind: "read" },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `REPLAYED turn ${n}` } },
      ]) {
        update(id, u);
        await pause(5);
      }
    }
  };
  /** Gemini's ACP commands (acpCommandHandler.ts), matched on the prompt's first word. */
  const COMMANDS = new Set(["memory", "extensions", "init", "restore", "about", "help"]);

  /** Gemini's permission request: its own option ids with ACP kinds; no rawInput, the command as the title. */
  const ask = async (request) => {
    const sessionId = session.id;
    const toolCallId = `run_shell_command-${++calls}`;
    const options = [
      { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
      { optionId: "proceed_always", name: "Allow for this session", kind: "allow_always" },
      { optionId: "cancel", name: "Reject", kind: "reject_once" },
    ];
    const command = typeof request === "string" ? request : request.command;
    const where = `${request.dir_path ? `[in ${request.dir_path}]` : `[current working directory ${process.cwd()}]`} (stub needs it)`;
    const call = { toolCallId, status: "pending", title: command, content: [{ type: "content", content: { type: "text", text: where } }], locations: [], kind: "execute" };
    update(sessionId, { sessionUpdate: "tool_call", ...call });
    const reply = await toClient("session/request_permission", { sessionId, options, toolCall: call });
    const o = reply.result?.outcome;
    const kind = o?.outcome === "selected" ? options.find((x) => x.optionId === o.optionId)?.kind ?? `unoffered:${o.optionId}` : o?.outcome ?? "no answer";
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: kind === "allow_once" ? "completed" : "failed", kind: "execute" });
    return { decision: kind === "allow_once" ? "allow" : "deny", optionKind: kind };
  };

  const handle = async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method === undefined) { answers.get(m.id)?.(m); answers.delete(m.id); return; }
    const p = m.params ?? {};
    switch (m.method) {
      case "initialize": {
        // Its start-up config is initialized while it answers, which runs discovery too
        // (acpRpcDispatcher.ts:81, config.initialize); a discovery that throws fails initialize.
        let atInitialize;
        try {
          atInitialize = await discover(false);
        } catch (err) {
          record({ event: "discovery-failed", at: "initialize", error: String(err?.message ?? err) });
          out({ id: m.id, error: { code: -32603, message: "Internal error", data: { details: String(err?.message ?? err) } } });
          return;
        }
        record({ event: "initialize", protocolVersion: p.protocolVersion, clientCapabilities: p.clientCapabilities, discoveredAtInitialize: atInitialize.size, discoveryMark: discoveryMark() });
        out({ id: m.id, result: {
          protocolVersion: 1, authMethods: AUTH_METHODS,
          agentInfo: { name: "gemini-cli", title: "Gemini CLI", version: (process.env.STUB_VERSION ?? "0.64.0").split(" ")[0] },
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } },
        } });
        break;
      }
      case "authenticate": {
        const key = typeof p._meta?.["api-key"] === "string" ? p._meta["api-key"] : undefined;
        record({ event: "authenticate", methodId: p.methodId, meta: Object.keys(p._meta ?? {}), keySha256: key ? sha(key) : null, session: Boolean(session) });
        if (!AUTH_METHODS.some((a) => a.id === p.methodId)) { out({ id: m.id, error: { code: -32602, message: `Invalid enum value: ${p.methodId}` } }); return; }
        if (process.env.STUB_GEMINI_REFUSE_SIGNIN) { out({ id: m.id, error: { code: -32000, message: `API key not valid. Please pass a valid API key. (request: {"api-key":"${key}"})` } }); return; }
        if (key) { apiKey = key; keyFrom = "authenticate"; }
        out({ id: m.id, result: {} });
        break;
      }
      case "session/new":
      case "session/load": {
        const selected = userSettings.security?.auth?.selectedType;
        if (selected !== "gemini-api-key" || !apiKey) { out({ id: m.id, error: { code: -32000, message: "Gemini API key is missing or not configured." } }); return; }
        const loading = m.method === "session/load";
        const id = loading ? p.sessionId : crypto.randomUUID();
        const file = sessionFile(id);
        if (loading && process.env.STUB_GEMINI_LOAD_ERROR) { out({ id: m.id, error: { code: -32603, message: "Internal error", data: { details: `the session store is locked\n  (signed in with ${apiKey})` } } }); return; }
        if (loading && !fs.existsSync(file)) {
          const details = `Invalid session identifier "${id}".\n  Searched for sessions in ${path.dirname(file)}.\n  Use --list-sessions to see available sessions, then use --resume {number}, --resume {uuid}, or --resume latest.`;
          out({ id: m.id, error: { code: -32603, message: "Internal error", data: { details } } });
          return;
        }
        const sess = loading ? JSON.parse(fs.readFileSync(file, "utf8")) : { turns: 0 };
        // Discovery as the session's config is initialized; a failure fails the session.
        let tools;
        try {
          tools = await discover(loading);
        } catch (err) {
          record({ event: "discovery-failed", error: String(err?.message ?? err) });
          out({ id: m.id, error: { code: -32603, message: "Internal error", data: { details: String(err?.message ?? err) } } });
          return;
        }
        // An untrusted folder connects no MCP server: what relay passed is recorded, and not used.
        session = { id, sess, file, loading, mcpServers: trusted ? (p.mcpServers ?? []) : [], passed: p.mcpServers ?? [], cwd: p.cwd, tools };
        record({ event: "session", method: m.method, sessionId: id, cwd: p.cwd, passedMcpServers: (p.mcpServers ?? []).map((s) => s.name), trusted, keySha256: sha(apiKey), keyFrom,
          toolCommands, discovered: [...tools.entries()].map(([name, t]) => ({ name, description: t.description, parameters: t.parameters })), discoveryMark: discoveryMark() });
        out({ id: m.id, result: loading ? sessionResult() : { sessionId: id, ...sessionResult() } });
        if (loading) void replay(id, sess.turns);
        break;
      }
      case "session/set_mode":
        if (!trusted && !["default", "plan"].includes(p.modeId)) { out({ id: m.id, error: { code: -32602, message: "untrusted folder: only default and plan" } }); return; }
        mode = p.modeId;
        out({ id: m.id, result: {} });
        break;
      case "session/cancel":
        record({ event: "cancel" });
        cancelled = true;
        finishPrompt?.({ stopReason: "cancelled" });
        break;
      case "session/prompt": {
        session.sess.turns += 1;
        fs.writeFileSync(session.file, JSON.stringify(session.sess));
        const prompt = (p.prompt ?? []).map((b) => b.text ?? "").join("");
        const relay = session.mcpServers.find((s) => s.name === "relay");
        const parsed = { relay: relay ? { command: relay.command, args: relay.args ?? [], env: Object.fromEntries((relay.env ?? []).map((e) => [e.name, e.value])) } : undefined };
        const env = process.env;
        record({
          event: "start", target: "gemini", via: "acp", argv, prompt, sessionId: session.id, resumed: session.loading, turn: session.sess.turns,
          cwd: process.cwd(), hasRelay: Boolean(parsed.relay), discovered: [...session.tools.keys()].sort(), mode, model, redaction,
          env: {
            // What the commands its tools run see, and whether a key was in its own environment at all.
            toolsSeeKey: Boolean(env.GEMINI_API_KEY), startedWithKey: Boolean(envKey), startedWith, googleKey: Boolean(env.GOOGLE_API_KEY), adc: Boolean(env.GOOGLE_APPLICATION_CREDENTIALS), project: Boolean(env.GOOGLE_CLOUD_PROJECT),
            proxyInTools: Boolean(env.HTTPS_PROXY), geminiModel: env.GEMINI_MODEL ?? null, home: env.HOME ?? null, geminiHome: env.GEMINI_CLI_HOME ?? null, sandbox: env.SANDBOX ?? null,
            geminiSandbox: env.GEMINI_SANDBOX ?? null, noRelaunch: env.GEMINI_CLI_NO_RELAUNCH ?? null, trust: env.GEMINI_CLI_TRUST_WORKSPACE ?? null, fileStorage: env.GEMINI_FORCE_FILE_STORAGE ?? null,
            systemSettings: env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? null, systemDefaults: env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ?? null,
            otel: Object.keys(env).filter((k) => k.startsWith("OTEL_")), anthropicKey: Boolean(env.ANTHROPIC_API_KEY), openaiKey: Boolean(env.OPENAI_API_KEY), tmpdir: env.TMPDIR ?? null,
          },
        });
        // Its ACP commands are run, never sent to the model: the trimmed text, its first word.
        const text = prompt.trim();
        if ((text.startsWith("/") || text.startsWith("$")) && COMMANDS.has(text.slice(1).trim().split(/\s+/)[0])) {
          record({ event: "command", command: text.slice(1).trim().split(/\s+/)[0] });
          update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Gemini CLI commands: /memory, /extensions, /init, /restore, /about, /help" } });
          out({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, _meta: { quota: { token_count: { input_tokens: 0, output_tokens: 0 }, model_usage: [] } } } });
          break;
        }
        await pause(Number(process.env.STUB_GEMINI_LATENCY_MS ?? 100));
        // A first turn looks before it answers (two rounds); a loaded session's is answered with text alone.
        const rounds = session.loading ? 1 : 2;
        if (rounds === 2) {
          update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me look. " } });
          update(session.id, { sessionUpdate: "tool_call", toolCallId: "read_file-1", title: "README.md", kind: "read", status: "completed", locations: [{ path: path.join(session.cwd, "README.md") }] });
        }
        const done = new Promise((resolve) => (finishPrompt = resolve));
        let routed = null;
        void (async () => {
          const hook = async (h) => {
            // The model the prompt's first round was routed to, where it is not the one asked for.
            if (h.routed) routed = h.routed;
            // The agent prints the key it was given: in a tool call's title, on stderr (once split across two writes).
            if (h.leakKey) {
              update(session.id, { sessionUpdate: "tool_call", toolCallId: "leak-1", title: `echo ${apiKey}`, kind: "execute", status: "completed" });
              process.stderr.write(`stub diagnostics: key=${apiKey}\n`);
              process.stderr.write(`partial ${apiKey.slice(0, 10)}`);
              await new Promise((r) => setTimeout(r, 50));
              process.stderr.write(`${apiKey.slice(10)} end\n`);
            }
            // What a command its tools run could learn of the environment the agent was started with
            // (kern.procargs2, which ps reads), asked from a child, as a tool's command would ask.
            if (h.procArgsSelf) {
              const got = procArgs(process.pid);
              // envShown: a variable relay sets in its start-up environment is there, so that what is
              // not there means something.
              record({ event: "procargs-self", readable: typeof got.text === "string", errno: got.errno ?? null, error: got.error ?? null, envShown: Boolean(got.text?.includes("GEMINI_CLI_HOME=")), keyShown: Boolean(apiKey && got.text?.includes(apiKey)), varShown: Boolean(got.text?.includes("GEMINI_API_KEY=")) });
            }
            // For tests only, not what Gemini does: the tools relay's bridge offers this turn, read from
            // the bridge relay passed in session/new (which the untrusted folder leaves unconnected), to
            // set against what discovery gave.
            if (h.bridgeTools) {
              const relayEntry = session.passed.find((s) => s.name === "relay");
              let tools = null;
              if (relayEntry) {
                const env = { ...process.env, ...Object.fromEntries((relayEntry.env ?? []).map((e) => [e.name, e.value])) };
                const client = new Client({ name: "stub-gemini-check", version: "0" });
                await client.connect(new StdioClientTransport({ command: relayEntry.command, args: relayEntry.args ?? [], env }));
                tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? "", parameters: t.inputSchema }));
                await client.close().catch(() => {});
              }
              record({ event: "bridge-tools", tools });
            }
            // What relay's tool files for the turn hold, and what can be done with them from inside the
            // turn: the secret's file is read (as any command could), recorded by its SHA-256 only.
            if (h.toolFiles) {
              const dir = toolCommands.callCommand ? path.dirname(toolCommands.callCommand) : null;
              let where = {};
              try { where = JSON.parse(fs.readFileSync(path.join(dir, "bridge.json"), "utf8")); } catch { /* recorded as missing */ }
              let secret = null;
              let readError = null;
              try { secret = fs.readFileSync(where.secret, "utf8"); } catch (err) { readError = err.code ?? String(err); }
              let writable;
              try {
                fs.closeSync(fs.openSync(where.secret, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
                writable = "opened";
              } catch (err) {
                writable = err.code ?? String(err);
              }
              let listed;
              try {
                fs.readdirSync(path.dirname(where.secret));
                listed = "listed";
              } catch (err) {
                listed = err.code ?? String(err);
              }
              const holds = (s) => Boolean(secret && s && s.includes(secret));
              let shim = null;
              try { shim = fs.readFileSync(toolCommands.callCommand, "utf8"); } catch { /* recorded as null */ }
              const homeFiles = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), "utf8"));
              record({
                event: "tool-files", dir, where, readError, secretSha256: secret ? sha(secret) : null, secretMode: secret ? (fs.statSync(where.secret).mode & 0o777) : null, writable, listed,
                inCommands: holds(toolCommands.discoveryCommand) || holds(toolCommands.callCommand), inShim: holds(shim), inEnv: Object.values(process.env).some(holds),
                inHome: homeFiles.some(holds), shim,
              });
            }
            // Another turn's secret file, whose path the test leaves in the stub's directory (readable here).
            if (h.readOtherSecret) {
              const other = fs.readFileSync(path.join(process.env.STUB_DIR, "other-secret-path"), "utf8");
              const attempt = (fn) => {
                try { fn(); return "ok"; } catch (err) { return err.code ?? String(err); }
              };
              record({
                event: "other-secret", path: other,
                read: attempt(() => fs.readFileSync(other)), exists: attempt(() => fs.accessSync(other, fs.constants.F_OK)),
                listed: attempt(() => fs.readdirSync(path.dirname(other))),
              });
            }
            // A connection to the turn's broker from inside the turn with a secret that is not the turn's.
            if (h.wrongSecret) {
              const dir = path.dirname(toolCommands.callCommand);
              const socketPath = JSON.parse(fs.readFileSync(path.join(dir, "bridge.json"), "utf8")).socket;
              const outcome = await new Promise((resolve) => {
                const sock = net.connect(socketPath);
                let data = "";
                const timer = setTimeout(() => { sock.destroy(); resolve({ answered: Boolean(data), closed: false }); }, 5000);
                sock.on("connect", () => {
                  sock.write(JSON.stringify({ relay_bridge_secret: "not-the-turns-secret-0123456789abcdef" }) + "\n");
                  sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }) + "\n");
                });
                sock.on("data", (d) => (data += d));
                sock.on("error", () => {});
                sock.on("close", () => { clearTimeout(timer); resolve({ answered: Boolean(data), closed: true }); });
              });
              record({ event: "wrong-secret", ...outcome });
            }
            // Gemini's own process reaching a host through the proxy it was started with, as its
            // requests to Google go: the proxy decides (curl takes the proxy from HTTPS_PROXY).
            if (h.proxyProbe) {
              const { spawnSync } = await import("node:child_process");
              const r = spawnSync("/usr/bin/curl", ["-s", "-m", "5", "-o", "/dev/null", `https://${h.proxyProbe}/`], { env: { ...process.env, HTTPS_PROXY: startProxy ?? "" } });
              record({ event: "proxy-probe", host: h.proxyProbe, proxied: Boolean(startProxy), status: r.status });
            }
            // Its tools reading the key file where the person keeps it, as any command could.
            if (h.readKeyFile) {
              const file = h.readKeyFile;
              let got;
              try {
                got = fs.readFileSync(file, "utf8").includes(apiKey) ? "read the key" : "read something else";
              } catch (err) {
                got = err.code ?? String(err);
              }
              let listed;
              try {
                listed = fs.readdirSync(path.dirname(file)).length >= 0 ? "listed" : "";
              } catch (err) {
                listed = err.code ?? String(err);
              }
              // Whether its name can be tested for, and whether it opens for writing (never truncated, nothing written).
              let tested;
              try {
                fs.accessSync(file, fs.constants.F_OK);
                tested = "exists";
              } catch (err) {
                tested = err.code ?? String(err);
              }
              let writable;
              try {
                fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
                writable = "opened";
              } catch (err) {
                writable = err.code ?? String(err);
              }
              record({ event: "read-key-file", got, listed, tested, writable });
            }
          };
          // Relay's tools, as discovered: the model calls them by their discovered names.
          const relayTools = session.tools.size ? { list: () => [...session.tools.keys()].sort(), call: (name, args) => callDiscovered(session.tools, name, args) } : undefined;
          const r = await runSteps({ id: "gemini", hook, relayTools }, parsed, prompt, session.sess, ask);
          if (cancelled) return;
          record({ event: "end", target: "gemini", sessionId: session.id, calls: r.calls, failure: r.failure });
          if (r.failure) return finishPrompt({ error: r.failure });
          // A reply makes the session resumable (hasResumableContent), so its start-up cleanup keeps it.
          session.sess.replies = (session.sess.replies ?? 0) + 1;
          fs.writeFileSync(session.file, JSON.stringify(session.sess));
          const reply = r.reply.replaceAll("@@KEY@@", apiKey);
          // Streamed in pieces, as models do.
          const half = Math.ceil(reply.length / 2);
          update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.slice(0, half) } });
          update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.slice(half) } });
          // The first round under the model it was routed to; a round after a tool call under the configured id.
          const answered = [...new Set([routed ?? (ALIASES.has(model) ? "gemini-3.8-flash" : model), ...(rounds === 2 ? [model] : [])])];
          finishPrompt({
            stopReason: "end_turn",
            usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240, cachedReadTokens: 20, thoughtTokens: 5 },
            _meta: { quota: { token_count: { input_tokens: 200, output_tokens: 40 }, model_usage: answered.map((mu) => ({ model: mu, token_count: { input_tokens: 100, output_tokens: 20 } })) } },
          });
        })().catch((err) => {
          record({ event: "steps-error", error: String(err?.message ?? err) });
          finishPrompt({ error: String(err?.stack ?? err) });
        });
        const res = await done;
        if (res.error) out({ id: m.id, error: { code: -32000, message: res.error } });
        else out({ id: m.id, result: { stopReason: res.stopReason, ...(res.usage ? { usage: res.usage } : {}), ...(res._meta ? { _meta: res._meta } : {}) } });
        if (cancelled) process.exit(0);
        break;
      }
      default:
        if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    }
  };
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => void handle(line).catch((err) => record({ event: "stub-error", error: String(err?.stack ?? err) })));
  await new Promise((resolve) => rl.on("close", resolve));
}

const gemini = {
  id: "gemini",
  version: "0.64.0",
  serve: (argv) => (argv.includes("--acp") ? acpServer(argv) : null),
  parse: () => { throw new Error("the stub Gemini agent runs only as `--acp`"); },
};
export default gemini;
