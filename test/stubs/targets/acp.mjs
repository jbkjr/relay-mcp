// A stub ACP agent (Agent Client Protocol v1 over stdio), standing in for GitHub Copilot CLI's
// `copilot --acp`: initialize with a login-reuse auth method, authenticate, session/new and
// session/load (with replay), modes and a model reported and settable, session/prompt with
// streamed updates, session/request_permission, session/cancel, and requests to the client that
// relay must refuse. Steps come from the shared scenario (stub-agent.mjs).
//
// Started as Grok Build's `grok … agent … stdio`, it answers as Grok 1.0.62 does where relay
// relies on it: `cached_token` offered only with a stored login (the file at $GROK_AUTH_PATH, where
// relay points it, as 1.0.62's build_auth_methods looks), authenticating with it failing without one,
// a session opened without authenticating only with a stored login (without one, "Authentication required"), no session
// modes, its model reported in `models` (current and available) and in configOptions, on new and
// resumed sessions alike, from its built-in catalog (grok-4.6, its default, and grok-4.5; a test
// can give another with STUB_ACP_REPORT's `catalog`), an `-m` naming a model not in the catalog
// falling back to grok-4.6 without a word, its reasoning effort reported as a thought_level option
// (STUB_ACP_REPORT's `noEffortOption`: none), session/resume advertised and served (without a
// replay), its session files under $GROK_HOME, and its Grok, xAI and OTEL variables in the start
// record.
//
// It runs under relay's own sandbox, so it writes only where a confined harness may: its session
// files go in $COPILOT_HOME or $GROK_HOME (the harness state relay prepares), and its records go to
// stderr as `STUB-RECORD <json>` lines, which relay keeps in the agent's log.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { runSteps } from "../stub-agent.mjs";

const AGENT_MODE = "https://agentclientprotocol.com/protocol/session-modes#agent";
const MODES = [AGENT_MODE, "https://agentclientprotocol.com/protocol/session-modes#plan", "https://agentclientprotocol.com/protocol/session-modes#autopilot"];
// "unlisted-model": one the harness offers that relay's model list does not name (its family is unknown).
const MODELS = ["auto", "claude-sonnet-5.5", "claude-opus-5.5", "gpt-6.1-sol", "gpt-5.4", "gemini-3.8-flash", "unlisted-model"];
// Grok 1.0.62's built-in catalog, as session/new reports it without a signed-in catalog (a decoy login, 2026-10-17),
// with each model's reasoning-effort menu; an effort the menu lacks runs as "high", the default.
const GROK_CATALOG = ["grok-4.6", "grok-4.5"];
const GROK_EFFORTS = { "grok-4.6": ["xhigh", "high", "medium", "low"], "grok-4.5": ["high", "medium", "low"], "grok-4.7": ["xhigh", "high", "medium", "low"] };
/** Whether this is Grok Build's ACP agent: `grok [options] agent [options] stdio`. */
const isGrok = (argv) => argv.includes("agent") && argv[argv.length - 1] === "stdio";
/** Whether Grok has a stored login: a file where GROK_AUTH_PATH says (relay always sets it), looked at, never read. */
const grokLogin = () => Boolean(process.env.GROK_AUTH_PATH) && fs.existsSync(process.env.GROK_AUTH_PATH);

const record = (obj) => process.stderr.write(`STUB-RECORD ${JSON.stringify({ t: Date.now(), pid: process.pid, ...obj })}\n`);
const flag = (argv, name) => {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes("=") ? argv[i].slice(argv[i].indexOf("=") + 1) : argv[i + 1];
};

function sessionFile(id, grok) {
  const dir = grok ? path.join(process.env.GROK_HOME ?? process.cwd(), "sessions", "stub") : path.join(process.env.COPILOT_HOME ?? process.cwd(), "session-state", "stub");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.json`);
}

async function acpServer(argv) {
  // As Copilot 1.0.98 does with no stored login it can use: it gives up before ACP's initialize.
  if (process.env.STUB_ACP_EXIT_AT_START) {
    process.stderr.write("Error: no stored login\n");
    process.exit(1);
  }
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

  const grok = isGrok(argv);
  // Grok reports no session modes. A test's own values come after the persona's defaults, and win.
  const report = { ...(grok ? { noModes: true } : {}), ...(process.env.STUB_ACP_REPORT ? JSON.parse(process.env.STUB_ACP_REPORT) : {}) };
  const persona = grok ? "grok" : "copilot";
  const models = grok ? (report.catalog ?? GROK_CATALOG) : MODELS;
  let session = null;
  let mode = AGENT_MODE;
  // Grok runs a model its catalog does not offer as its default, grok-4.6, and says nothing (1.0.62, `-m grok-4.7`).
  let model = grok ? (models.includes(flag(argv, "-m")) ? flag(argv, "-m") : "grok-4.6") : (flag(argv, "--model") ?? "claude-sonnet-5.5");
  const effortMenu = () => GROK_EFFORTS[model] ?? ["high"];
  const effort = () => (effortMenu().includes(flag(argv, "--reasoning-effort")) ? flag(argv, "--reasoning-effort") : "high");
  let cancelled = false;
  /** Whether an authenticate call succeeded on this connection. */
  let authenticated = false;
  /** Settles when relay first asks the agent to stop (session/cancel), whatever the agent then does. */
  let cancelAsked;
  const cancelSeen = new Promise((r) => (cancelAsked = r));
  let finishPrompt = null;
  let calls = 0;

  const sessionResult = () => ({
    ...(report.noModes ? {} : { modes: { currentModeId: mode, availableModes: MODES.map((id) => ({ id, name: id.split("#")[1] })) } }),
    ...(report.noModel ? {} : { models: { currentModelId: report.model ?? model, availableModels: models.map((modelId) => ({ modelId, name: modelId })) } }),
    configOptions: [
      ...(report.noModel ? [] : [{ id: "model", name: "Model", category: "model", type: "select", currentValue: report.model ?? model, options: models.map((value) => ({ value, name: value })) }]),
      ...(grok && !report.noEffortOption ? [{ id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: effort(), options: effortMenu().map((value) => ({ value, name: value })) }] : []),
    ],
  });

  /** How this agent asks for permission, for each kind of scenario request; resolves to what relay answered. */
  const ask = async (request) => {
    const sessionId = session.id;
    const toolCallId = `call_${++calls}`;
    let options = request.noAllowOnce
      ? [{ optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }]
      : [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }];
    let toolCall;
    if (request.path !== undefined) {
      // Copilot 1.0.98's own check of a path outside its trusted directories, as a signed-in run
      // sent it (2026-10-17, j_a7963b11): the tool call announced first (`tool`: an apply_patch
      // adding the file, its file viewer, a command, or none), then a request of kind "read",
      // whatever the call would do, with the path in rawInput and locations, and Copilot's options.
      const p = request.path;
      if (request.tool === "edit") update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "apply_patch", kind: "edit", status: "pending", rawInput: `*** Begin Patch\n*** Add File: ${p}\n+hi\n*** End Patch\n` });
      else if (request.tool === "read") update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `Viewing ${p}`, kind: "read", status: "pending", rawInput: { path: p } });
      else if (request.tool === "execute") update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Copy the file", kind: "execute", status: "pending", rawInput: { command: `cp ${p} .`, description: "Copy the file" } });
      toolCall = { toolCallId, title: "Access paths outside trusted directories", kind: "read", status: "pending", ...(p ? { rawInput: { path: p }, locations: [{ path: p }] } : { rawInput: {} }) };
      options = [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }, { optionId: "allow_always", kind: "allow_always", name: "Always allow" }, { optionId: "reject_once", kind: "reject_once", name: "Deny" }];
    } else if (request.sparse) {
      // A request that refers to nothing relay has seen, and says nothing about what it would do.
      toolCall = { toolCallId, title: "Do something" };
    } else if (typeof request === "string" || request.command) {
      const command = typeof request === "string" ? request : request.command;
      // Announced as a tool call first; the request refers to it by id only.
      update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Run shell command", kind: "execute", status: "pending", rawInput: { command, description: "stub needs it", ...(request.cwd ? { cwd: request.cwd } : {}) } });
      toolCall = { toolCallId };
    } else if (request.edit) {
      update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Editing", kind: "edit", status: "pending", locations: [{ path: request.edit }] });
      toolCall = { toolCallId, content: [{ type: "diff", path: request.edit, oldText: "a", newText: "b" }] };
    } else if (request.web || request.fetch) {
      toolCall = { toolCallId, title: "Fetching URL", kind: "fetch", rawInput: { url: request.web ?? request.fetch } };
    } else {
      toolCall = { toolCallId, title: "Unknown", kind: "other" };
    }
    const reply = await toClient("session/request_permission", { sessionId, toolCall, options });
    const o = reply.result?.outcome;
    const kind = o?.outcome === "selected" ? options.find((x) => x.optionId === o.optionId)?.kind ?? `unoffered:${o.optionId}` : o?.outcome ?? "no answer";
    // Past its path check, Copilot goes on with the call: whether that works is for relay's sandbox to say.
    let attempt;
    if (request.path && (kind === "allow_once" || kind === "allow_always") && (request.tool === "edit" || request.tool === "read")) {
      try {
        if (request.tool === "edit") fs.writeFileSync(request.path, "hi\n");
        else fs.readFileSync(request.path);
        attempt = { op: request.tool === "edit" ? "write" : "read", ok: true };
      } catch (err) {
        attempt = { op: request.tool === "edit" ? "write" : "read", ok: false, code: err.code ?? String(err) };
      }
    }
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: kind === "allow_once" && attempt?.ok !== false ? "completed" : "failed",
      ...(request.path !== undefined && kind === "reject_once" ? { rawOutput: { message: "The user rejected this tool call.", code: "rejected" } } : {}) });
    return { decision: kind === "allow_once" || kind === "allow_always" ? "allow" : "deny", optionKind: kind, ...(kind === "allow_always" ? { scope: "always" } : {}), ...(attempt ? { attempt } : {}) };
  };

  // Each message is handled as it comes, never waiting on another: a prompt waits on the client's
  // answers to its requests, which arrive as further lines.
  const handle = async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method === undefined) { answers.get(m.id)?.(m); answers.delete(m.id); return; }
    const p = m.params ?? {};
    switch (m.method) {
      case "initialize":
        record({ event: "initialize", protocolVersion: p.protocolVersion, clientCapabilities: p.clientCapabilities });
        out({ id: m.id, result: {
          protocolVersion: Number(process.env.STUB_ACP_PROTOCOL ?? 1),
          agentCapabilities: { loadSession: true, promptCapabilities: {}, mcpCapabilities: {}, sessionCapabilities: grok ? { list: {}, resume: {}, close: {} } : {} },
          authMethods: process.env.STUB_ACP_NO_AUTH_METHOD ? []
            : grok ? [...(grokLogin() ? [{ id: "cached_token", name: "cached_token" }] : []), { id: "grok.com", name: "Grok", description: "Sign in with Grok" }]
              : [{ id: "copilot-login", name: "Log in with Copilot CLI", description: "Run copilot login" }],
          ...(grok ? { _meta: { agentVersion: "1.0.62" } } : { agentInfo: { name: "stub-copilot", version: "1.0.98" } }),
        } });
        break;
      case "authenticate":
        record({ event: "authenticate", methodId: p.methodId, session: Boolean(session), sessionId: session?.id ?? null });
        if ((grok ? !grokLogin() : process.env.STUB_LOGIN === "none") || (process.env.STUB_LOGIN === "lost-after-session" && session)) out({ id: m.id, error: { code: -32000, message: "Authentication required" } });
        else {
          authenticated = true;
          out({ id: m.id, result: {} });
        }
        break;
      case "session/new":
      case "session/load":
      case "session/resume": {
        if (m.method === "session/resume" && !grok) { out({ id: m.id, error: { code: -32601, message: "unsupported session/resume" } }); return; }
        // Grok 1.0.62 with no stored login, when nothing authenticated first; with a stored login (a decoy) it opens the session unasked.
        if (grok && !grokLogin() && !authenticated) { out({ id: m.id, error: { code: -32000, message: "Authentication required", data: "no auth method id provided" } }); return; }
        const loading = m.method !== "session/new";
        const id = loading ? p.sessionId : crypto.randomUUID();
        const file = sessionFile(id, grok);
        if (loading && !fs.existsSync(file)) { out({ id: m.id, error: { code: -32002, message: `Resource not found: session ${id}` } }); return; }
        const sess = loading ? JSON.parse(fs.readFileSync(file, "utf8")) : { turns: 0 };
        session = { id, sess, file, loading, mcpServers: p.mcpServers ?? [], cwd: p.cwd };
        record({ event: "session", method: m.method, sessionId: id, cwd: p.cwd, mcpServers: (p.mcpServers ?? []).map((s) => s.name), additionalDirectories: p.additionalDirectories ?? null });
        // A load replays the conversation before it answers; a resume does not.
        if (m.method === "session/load") update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `REPLAYED turn ${sess.turns}` } });
        out({ id: m.id, result: loading ? sessionResult() : { sessionId: id, ...sessionResult() } });
        break;
      }
      case "session/set_mode":
        if (!MODES.includes(p.modeId)) { out({ id: m.id, error: { code: -32602, message: "unknown mode" } }); return; }
        mode = p.modeId;
        update(session.id, { sessionUpdate: "current_mode_update", currentModeId: mode });
        out({ id: m.id, result: {} });
        break;
      case "session/set_config_option":
        record({ event: "set_config_option", configId: p.configId, value: p.value });
        if (p.configId !== "model" || !models.includes(p.value)) { out({ id: m.id, error: { code: -32602, message: `Unknown config option value ${p.value}` } }); return; }
        // A harness that says yes and keeps its model, when a test asks for one.
        if (!report.pinModel) model = p.value;
        out({ id: m.id, result: { configOptions: sessionResult().configOptions } });
        break;
      case "session/cancel":
        record({ event: "cancel" });
        cancelAsked();
        // A misbehaving agent, when a test asks for one, takes no notice.
        if (process.env.STUB_ACP_IGNORE_TERM) return;
        cancelled = true;
        finishPrompt?.({ stopReason: "cancelled" });
        break;
      case "session/prompt": {
        session.sess.turns += 1;
        fs.writeFileSync(session.file, JSON.stringify(session.sess));
        const prompt = (p.prompt ?? []).map((b) => b.text ?? "").join("");
        const relay = session.mcpServers.find((s) => s.name === "relay");
        const parsed = { relay: relay ? { command: relay.command, args: relay.args ?? [], env: Object.fromEntries((relay.env ?? []).map((e) => [e.name, e.value])) } : undefined };
        // Client methods relay never offered must be refused, at once.
        const fsReply = await toClient("fs/read_text_file", { sessionId: session.id, path: path.join(session.cwd, "README.md") }, 5000);
        const termReply = await toClient("terminal/create", { sessionId: session.id, command: "true" }, 5000);
        record({
          event: "start", target: persona, via: "acp", argv, prompt, sessionId: session.id, resumed: session.loading, turn: session.sess.turns,
          cwd: process.cwd(), hasRelay: Boolean(parsed.relay), mode, model,
          env: {
            copilotHome: process.env.COPILOT_HOME ?? null, cacheHome: process.env.COPILOT_CACHE_HOME ?? null, autoUpdate: process.env.COPILOT_AUTO_UPDATE ?? null,
            copilotToken: Boolean(process.env.COPILOT_GITHUB_TOKEN), ghToken: Boolean(process.env.GH_TOKEN), githubToken: Boolean(process.env.GITHUB_TOKEN),
            allowAll: process.env.COPILOT_ALLOW_ALL ?? null, anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY), tmpdir: process.env.TMPDIR ?? null,
            home: process.env.HOME ?? null,
            ...(grok ? { grok: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(GROK_|XAI_|OTEL_)/.test(k) || k === "SENTRY_DSN" || k === "DISABLE_ERROR_REPORTING")) } : {}),
          },
          clientMethods: { fs: fsReply.error?.code ?? (fsReply.timeout ? "timeout" : "answered"), terminal: termReply.error?.code ?? (termReply.timeout ? "timeout" : "answered") },
        });
        if (process.env.STUB_ACP_IGNORE_TERM) for (const sig of ["SIGTERM", "SIGINT"]) { process.removeAllListeners(sig); process.on(sig, () => {}); }
        // Something said before a tool call is not the reply.
        update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me look. " } });
        update(session.id, { sessionUpdate: "tool_call", toolCallId: "read_1", title: "Reading README.md", kind: "read", status: "completed", locations: [{ path: "README.md" }] });
        const done = new Promise((resolve) => (finishPrompt = resolve));
        void (async () => {
          // A step can make the agent switch its model in the middle of the turn, as it reports it.
          const hook = async (h) => {
            if (!h.switchModel) return;
            model = h.switchModel;
            update(session.id, h.currentModelUpdate
              ? { sessionUpdate: "current_model_update", ...(h.missingModel ? {} : { currentModelId: model }) }
              : { sessionUpdate: "config_option_update", configOptions: sessionResult().configOptions });
            // Same ACP stream: the method-not-found response proves relay processed the model
            // notification before a nested call goes over the separate bridge connection.
            if (h.awaitModel) await toClient("relay/test-model-barrier", {});
            // With awaitCancel the agent goes on only once relay has asked it to stop, which relay
            // does in the same step as taking its relay tools away: a relay call after this is one
            // made after relay acted on the switch. The report goes out on the ACP stream and a relay
            // call on the bridge socket, two channels whose order relay does not control, so no fixed
            // pause could make that certain. Bounded, so that a relay that never asks fails the test
            // rather than holding it.
            if (h.awaitCancel) await Promise.race([cancelSeen, new Promise((r) => setTimeout(r, 60000))]);
          };
          const r = await runSteps({ id: persona, hook }, parsed, prompt, session.sess, ask);
          if (cancelled) return;
          record({ event: "end", target: persona, sessionId: session.id, ...r });
          if (r.failure) return finishPrompt({ error: r.failure });
          // A notice of the harness's own, sent as a message chunk ahead of the reply (Copilot's "Info: Disabled tools: task").
          if (process.env.STUB_ACP_NOTICE) update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.STUB_ACP_NOTICE } });
          // The reply, streamed in pieces.
          const half = Math.ceil(r.reply.length / 2);
          update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: r.reply.slice(0, half) } });
          update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: r.reply.slice(half) } });
          update(session.id, { sessionUpdate: "usage_update", used: 1500, size: 200000, cost: { amount: 0.0123, currency: "USD" } });
          // A harness that names the model that answered only in its prompt response (Gemini CLI's _meta),
          // when a test asks: for the served-model hook to be built on family steering's served_model.
          finishPrompt({ stopReason: report.stopReason ?? "end_turn", usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedReadTokens: 10 }, ...(report.served ? { _meta: { quota: { token_count: { input_tokens: 120, output_tokens: 30 }, model_usage: [report.served].flat().map((m) => ({ model: m, token_count: { input_tokens: 60, output_tokens: 15 } })) } } } : {}) });
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
        if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: `unsupported ${m.method}` } });
    }
  };
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => void handle(line).catch((err) => record({ event: "stub-error", error: String(err?.stack ?? err) })));
  await new Promise((resolve) => rl.on("close", resolve));
}

const acp = {
  id: "copilot",
  // What `--version` prints: Grok's, for a launcher named grok.
  get version() {
    return path.basename(process.argv[1] ?? "") === "grok" ? "grok 1.0.62 (stub)" : "GitHub Copilot CLI 1.0.98.\nRun 'copilot update' to check for updates.";
  },
  serve: (argv) => (argv.includes("--acp") || isGrok(argv) ? acpServer(argv) : null),
  parse: () => { throw new Error("the stub ACP agent runs only as `--acp` or `agent … stdio`"); },
};
export default acp;
