// The stub's Claude Code: `claude -p` with stream-json output. Permission prompts go to the tool
// named by --permission-prompt-tool; without one the action is simply denied.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { emit, record } from "../stub-agent.mjs";

/** What a plugin directory (--plugin-dir) holds, as the real CLI would load it: its name and its skills. */
function pluginOf(dir) {
  if (!dir) return null;
  const name = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")).name;
  const skillsDir = path.join(dir, "skills");
  const skills = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).sort() : [];
  // Each skill's SKILL.md and files as they are now, for tests of what relay put there (the directory is gone after the turn).
  const files = (d, pre = "") => fs.readdirSync(d).flatMap((f) => (fs.lstatSync(path.join(d, f)).isDirectory() ? files(path.join(d, f), `${pre}${f}/`) : [`${pre}${f}`]));
  const content = Object.fromEntries(skills.map((s) => [s, { skill: fs.readFileSync(path.join(skillsDir, s, "SKILL.md"), "utf8"), files: files(path.join(skillsDir, s)) }]));
  return { name, dir, skills, content };
}

/** Permissions refused in this turn. The real CLI lists them in its result as permission_denials. */
const denied = [];
/** Whether this turn was asked to run in fast mode (its settings' fastMode). */
let fast = false;

export default {
  id: "claude",
  version: "2.1.302 (stub Claude Code)",

  parse(argv) {
    const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
    const resume = val("--resume");
    const mcpFile = val("--mcp-config");
    const relay = mcpFile ? JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers?.relay : undefined;
    const mode = val("--permission-mode");
    // The settings file relay passes (--settings), for tests of what it sets there (fastMode, say).
    const settingsFile = val("--settings");
    const settings = settingsFile && fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : null;
    return {
      sessionId: resume ?? val("--session-id"), resumed: Boolean(resume), relay,
      access: mode === "dontAsk" || mode === "manual" ? "read" : mode === "acceptEdits" ? "write" : argv.includes("--dangerously-skip-permissions") ? "danger" : "unknown",
      strict: argv.includes("--strict-mcp-config"),
      promptTool: val("--permission-prompt-tool"),
      plugin: pluginOf(val("--plugin-dir")),
      get extra() {
        return this.plugin ? { pluginSkills: this.plugin.content } : {};
      },
      settings,
      skillSources: val("--setting-sources")?.split(",") ?? ["user", "project", "local"],
      noSkills: argv.includes("--disable-slash-commands"),
    };
  },

  /**
   * Once it has read its prompt, as Claude Code 2.1.309 does: its sandbox, given external proxy
   * ports and SRT_DEBUG, reports them on stderr as it starts (STUB_SRT_SILENT: it does not;
   * STUB_SRT_PORT: it reports another port); and with HTTPS_PROXY its model request goes through
   * that proxy with the URL's credentials (STUB_UNPROXIED: it does not; STUB_PROXY_HOST: to another
   * host than the model endpoint). The endpoint is the test home's stub (helpers.ts), which relay's
   * proxy maps to a closed loopback port: the stub needs no network.
   */
  async afterPrompt(parsed) {
    const ports = parsed.settings?.sandbox?.network;
    if (ports?.httpProxyPort && process.env.SRT_DEBUG && !process.env.STUB_SRT_SILENT) {
      const port = process.env.STUB_SRT_PORT ?? ports.httpProxyPort;
      process.stderr.write(`[SandboxDebug] Sandbox configuration updated\n[SandboxDebug] Using external HTTP proxy on port ${port}\n[SandboxDebug] Using external SOCKS proxy on port ${ports.socksProxyPort}\n[SandboxDebug] Network infrastructure initialized\n`);
    }
    const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
    if (!proxy || process.env.STUB_UNPROXIED) return;
    const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
    await new Promise((resolve) => {
      const s = net.connect(Number(proxy.port), proxy.hostname.replace(/^\[|\]$/g, ""));
      const host = process.env.STUB_PROXY_HOST ?? "model.relay-test.invalid";
      // A model request as the real CLI sends one to an http:// base URL: absolute-form, through the proxy.
      s.on("connect", () => s.write(`POST http://${host}/v1/messages HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: Basic ${auth}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`));
      s.on("data", () => {});
      s.on("end", () => s.destroy());
      s.on("error", resolve);
      s.on("close", resolve);
    });
  },

  start(argv, parsed, sessionId) {
    // What the real CLI reports for the permission mode it was given (checked against Claude Code 2.1.286).
    const reportedMode = { acceptEdits: "acceptEdits", manual: "default", dontAsk: "dontAsk", bypassPermissions: "bypassPermissions" }[argv[argv.indexOf("--permission-mode") + 1]] ?? (argv.includes("--dangerously-skip-permissions") ? "bypassPermissions" : "default");
    // The model as the real CLI reports it: an alias such as opus is resolved to a full Claude model id.
    const asked = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "sonnet";
    const model = asked.startsWith("claude-") ? asked : `claude-${asked}-stub`;
    // Its skills and plugins as Claude Code 2.1.302 reports them: a bundled skill, a built-in plugin,
    // and a plugin from --plugin-dir with its skills as <plugin>:<skill>. A test's STUB_INIT may
    // name the plugin directory as @PKG@.
    // A skill whose front matter says user-invocable false is loaded but left out of the list, as 2.1.302 does.
    const p = parsed.plugin;
    const listedSkill = (s) => !/^user-invocable:[ \t]*["']?(?:false|no|off|0)["']?[ \t]*$/im.test(p.content[s].skill.split(/^---$/m)[1] ?? "");
    const own = [];
    const from = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, name, "SKILL.md"))) {
        if (parsed.settings?.skillOverrides?.[name] !== "off") own.push(name);
      }
    };
    if (parsed.skillSources.includes("user")) from(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, ".claude"), "skills"));
    if (parsed.skillSources.includes("project")) for (let d = process.cwd(); ; d = path.dirname(d)) {
      from(path.join(d, ".claude/skills"));
      if (fs.existsSync(path.join(d, ".git")) || path.dirname(d) === d) break;
    }
    const skills = parsed.noSkills ? [] : [...own, ...(parsed.settings?.disableBundledSkills ? [] : ["debug"]), ...(p ? p.skills.filter(listedSkill).map((s) => `${p.name}:${s}`) : [])];
    const plugins = [...(p ? [{ name: p.name, path: p.dir, source: `${p.name}@inline` }] : []), ...(parsed.settings?.disableBundledSkills ? [] : [{ name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" }])];
    // Fast mode as the real CLI reports it (2.1.302): on when its settings ask for it, off otherwise. A test can overlay it.
    fast = Boolean(parsed.settings?.fastMode);
    const overlay = JSON.parse((process.env.STUB_INIT ?? "{}").replaceAll("@PKG@", p?.dir ?? ""));
    record({ event: "skills-init", target: "claude", skills: overlay.skills ?? skills, plugins: overlay.plugins ?? plugins });
    emit({ type: "system", subtype: "init", session_id: sessionId, model, permissionMode: reportedMode, apiKeySource: "none", tools: [], mcp_servers: [], skills, plugins, fast_mode_state: fast ? "on" : "off", ...overlay });
    // The model's first message, for tests of what relay checks when it arrives.
    // With --include-partial-messages, the response's start first, as the real CLI streams it.
    if (process.env.STUB_ASSISTANT && argv.includes("--include-partial-messages")) emit({ type: "stream_event", event: { type: "message_start", message: { id: "msg_stub", role: "assistant", content: [] } }, session_id: sessionId });
    if (process.env.STUB_ASSISTANT) emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working" }] }, session_id: sessionId });
  },

  ask: (parsed) => async (command, callTool) => {
    // A request is a shell command to run outside the sandbox by default; { sandboxed: "command" } is one that asks while staying
    // in it, and { web: "query" }, { fetch: "url" } and { edit: "path" } use the other tools.
    const args = typeof command === "string" ? { tool_name: "Bash", input: { command, dangerouslyDisableSandbox: true } }
      : command.sandboxed ? { tool_name: "Bash", input: { command: command.sandboxed } }
      : command.web ? { tool_name: "WebSearch", input: { query: command.web } }
      : command.fetch ? { tool_name: "WebFetch", input: { url: command.fetch } }
      : { tool_name: "Edit", input: { file_path: command.edit.replaceAll("$RELAY_HOME", process.env.RELAY_HOME ?? "") } };
    // With nowhere to ask, the real CLI refuses the permission on the spot, and lists it all the same.
    if (!parsed.promptTool) {
      denied.push({ tool_name: args.tool_name, tool_use_id: "toolu_stub", tool_input: args.input });
      return { decision: "deny", message: "no approval channel" };
    }
    const res = await callTool(parsed.promptTool.split("__").pop(), { ...args, tool_use_id: "toolu_stub" });
    if (res.behavior !== "allow") denied.push({ tool_name: args.tool_name, tool_use_id: "toolu_stub", tool_input: args.input });
    // What an allowed call goes ahead with is the input relay hands back.
    return res.behavior === "allow" ? { decision: "allow", input: res.updatedInput } : { decision: "deny", message: res.message ?? res.error };
  },

  fail: (failure, sessionId) => emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: [failure], session_id: sessionId, permission_denials: denied }),
  // Usage as the real CLI reports it for one `claude -p` invocation.
  // With fast mode, its state and the speed the turn ran at (usage.speed), as the real CLI reports them (2.1.302); a test can overlay the result (STUB_RESULT).
  finish: (reply, sessionId) => {
    const extra = JSON.parse(process.env.STUB_RESULT ?? "{}");
    emit({
      type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId, num_turns: 3, total_cost_usd: 0.0125, permission_denials: denied,
      fast_mode_state: fast ? "on" : "off", ...extra,
      usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 5000, output_tokens: 400, speed: fast ? "fast" : "standard", ...(extra.usage ?? {}) },
    });
  },
};
