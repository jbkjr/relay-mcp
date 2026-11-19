#!/usr/bin/env node
// Stands in for the `claude` and `codex` host CLIs in the installer tests. It keeps what the real
// ones keep (the MCP server named relay, plugin marketplaces, installed plugins) in a JSON file,
// prints what the real ones print (formats copied from Claude Code 2.1.286 and codex-cli 0.160.1),
// keeps a copy of an installed plugin where each keeps it (Claude Code 2.1.302 and codex-cli 0.162.1:
// a fresh copy of the plugin's directory on every install, under its home's plugins/cache, which
// Claude Code names in `plugin list --json` as installPath and Codex does not),
// records every call it gets, and fails where a test tells it to. It is strict where the real
// behaviour is not known: adding something that is there, or removing something that is not, fails.
//
//   FAKE_DIR             where its state and the call log live
//   FAKE_FAIL            fail any call whose command line contains this text
//   FAKE_TOUCH           a file to append a line to during `plugin list`, as something else editing it mid-run would
//   FAKE_CREATE          a file to create while a plugin is being added, as something else installing there mid-run would
//   FAKE_CLAUDE_VERSION, FAKE_CODEX_VERSION, FAKE_CODEX_LOGIN, FAKE_LOGGED_OUT
import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";

// The version a host reports for an installed plugin: this checkout's, unless a test sets an older one.
const VERSION = process.env.FAKE_PLUGIN_VERSION ?? JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const [name, ...args] = process.argv.slice(2);
const dir = process.env.FAKE_DIR;
const stateFile = path.join(dir, `${name}.json`);
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { server: null, markets: [], plugins: [] };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const out = (text) => process.stdout.write(`${text}\n`);
const fail = (text, code = 1) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};
const line = args.join(" ");
const is = (...words) => words.every((w, i) => args[i] === w);

fs.appendFileSync(path.join(dir, "calls.jsonl"), `${JSON.stringify({ bin: name, args })}\n`);
if (process.env.FAKE_FAIL && `${name} ${line}`.includes(process.env.FAKE_FAIL)) fail(`${name}: told to fail on "${process.env.FAKE_FAIL}"`);
// What a Codex turn's own check asks of Codex (relay doctor's codex launch line, codexLaunchCheck):
// its app server and `mcp list`, served by the turn tests' stub Codex, which reports the effective
// configuration from the flags it is given. Recorded as calls, like the rest; they change nothing.
if (name === "codex" && (args[0] === "app-server" || (args.includes("mcp") && args.includes("list")))) {
  const { spawnSync } = await import("node:child_process");
  // A test's stand-in for a configuration layer above relay's flags (codex-effective.json, codex-shell-policy.json)
  // or below them (codex-features.json, the person's own features), and for the login (codex-account.txt), from files in FAKE_DIR: the turn's
  // environment, which this process has, carries no STUB_* name (relay's environment policy drops them).
  const overlay = (file, key) => (fs.existsSync(path.join(dir, file)) ? { [key]: fs.readFileSync(path.join(dir, file), "utf8") } : {});
  const env = { ...process.env, STUB_DIR: process.env.STUB_DIR ?? dir, ...overlay("codex-effective.json", "STUB_CODEX_EFFECTIVE"), ...overlay("codex-shell-policy.json", "STUB_CODEX_SHELL_POLICY"), ...overlay("codex-features.json", "STUB_CODEX_FEATURES"), ...overlay("codex-account.txt", "STUB_ACCOUNT") };
  const r = spawnSync(process.execPath, [new URL("./stub-codex", import.meta.url).pathname, ...args], { stdio: "inherit", env });
  process.exit(r.status ?? 1);
}

/** Where the host keeps its copy of an installed plugin: <its home>/plugins/cache/<marketplace>/<plugin>/<version>. */
const copyOf = (id) => {
  const home = name === "claude" ? path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? "", ".claude")) : process.env.CODEX_HOME ?? "";
  const [plugin, market] = id.split("@");
  return path.join(home, "plugins", "cache", market, plugin, VERSION);
};

/** The marketplace manifest of an adapters directory, as each CLI would read it. */
const manifest = (source) => JSON.parse(fs.readFileSync(path.join(source, name === "claude" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json"), "utf8"));

// Codex keeps marketplaces and plugins in config.toml itself, so its commands rewrite the file relay edits.
const codexConfig = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "config.toml");
const marketSnippet = (m) => `\n[marketplaces.${m.name}]\nsource = ${JSON.stringify(m.path)}\n`;
const pluginSnippet = (id) => `\n[plugins.${JSON.stringify(id)}]\nenabled = true\n`;
// It writes in the file's own line endings, and takes its tables out again wherever they ended up.
const codexEol = () => (fs.existsSync(codexConfig) && fs.readFileSync(codexConfig, "utf8").includes("\r\n") ? "\r\n" : "\n");
const codexAppend = (snippet) => name === "codex" && fs.appendFileSync(codexConfig, snippet.replace(/\n/g, codexEol()));
const codexCut = (snippet) => {
  if (name !== "codex" || !fs.existsSync(codexConfig)) return;
  let text = fs.readFileSync(codexConfig, "utf8");
  for (const form of [snippet, snippet.slice(1)].flatMap((f) => [f.replace(/\n/g, "\r\n"), f])) {
    if (!text.includes(form)) continue;
    text = text.replace(form, "");
    break;
  }
  fs.writeFileSync(codexConfig, text);
};

function marketplace() {
  if (is("plugin", "marketplace", "list", "--json")) {
    const rows = name === "claude"
      ? state.markets.map((m) => m.foreign ?? { name: m.name, source: "directory", path: m.path, installLocation: m.path })
      : state.markets.map((m) => m.foreign ?? { name: m.name, root: m.path, marketplaceSource: { sourceType: "local", source: m.path } });
    return out(JSON.stringify(name === "claude" ? rows : { marketplaces: rows }, null, 2));
  }
  if (is("plugin", "marketplace", "add")) {
    const source = args[3];
    const market = { name: manifest(source).name, path: source };
    if (state.markets.some((m) => m.name === market.name)) fail(`marketplace ${market.name} is already added`);
    state.markets.push(market);
    codexAppend(marketSnippet(market));
    return save();
  }
  if (is("plugin", "marketplace", "remove")) {
    const market = state.markets.find((m) => m.name === args[3]);
    if (!market) fail(`no marketplace named ${args[3]}`);
    state.markets = state.markets.filter((m) => m !== market);
    codexCut(marketSnippet(market));
    return save();
  }
  fail(`${name}: unexpected arguments: ${line}`, 2);
}

function plugin() {
  if (args[1] === "marketplace") return marketplace();
  if (is("plugin", "list", "--json")) {
    if (process.env.FAKE_TOUCH) fs.appendFileSync(process.env.FAKE_TOUCH, "# edited meanwhile\n");
    return out(JSON.stringify(name === "claude"
      ? state.plugins.map((id) => ({ id, version: VERSION, scope: "user", enabled: true, installPath: copyOf(id) }))
      : { installed: state.plugins.map((id) => ({ pluginId: id, name: id.split("@")[0], marketplaceName: id.split("@")[1], version: VERSION, installed: true, enabled: true })), available: [] }, null, 2));
  }
  const [add, remove] = name === "claude" ? ["install", "uninstall"] : ["add", "remove"];
  const id = args[2];
  if (is("plugin", add)) {
    if (process.env.FAKE_CREATE) {
      fs.mkdirSync(path.dirname(process.env.FAKE_CREATE), { recursive: true });
      fs.writeFileSync(process.env.FAKE_CREATE, "someone else's program\n");
    }
    if (state.plugins.includes(id)) fail(`plugin ${id} is already installed`);
    const market = state.markets.find((m) => m.name === id.split("@")[1]);
    if (!market) fail(`no marketplace for ${id}`);
    // A fresh copy of the plugin's directory, replacing whatever was at that place.
    const from = path.join(market.path, id.split("@")[0]);
    fs.rmSync(copyOf(id), { recursive: true, force: true });
    if (fs.existsSync(from)) fs.cpSync(from, copyOf(id), { recursive: true });
    state.plugins.push(id);
    codexAppend(pluginSnippet(id));
    return save();
  }
  if (is("plugin", remove)) {
    if (!state.plugins.includes(id)) fail(`plugin ${id} is not installed`);
    fs.rmSync(copyOf(id), { recursive: true, force: true });
    state.plugins = state.plugins.filter((p) => p !== id);
    codexCut(pluginSnippet(id));
    return save();
  }
  fail(`${name}: unexpected arguments: ${line}`, 2);
}

function claude() {
  if (is("--version")) return out(process.env.FAKE_CLAUDE_VERSION ?? "2.1.302 (Claude Code)");
  if (is("-p")) {
    const value = (flag) => args[args.indexOf(flag) + 1];
    const settings = JSON.parse(fs.readFileSync(value("--settings"), "utf8"));
    fs.writeFileSync(path.join(dir, "claude-probe.json"), JSON.stringify({ pid: process.pid, args, settings, cwd: process.cwd() }));
    if (state.initProbe === "exit") return;
    const fixture = JSON.parse(fs.readFileSync(new URL("../fixtures/native-skill-isolation.json", import.meta.url), "utf8"));
    const init = { type: "system", subtype: "init", ...(state.initReport ?? fixture.claude[1].init) };
    // Keep it alive until relay stops it. "result": the local /skills reply already queued behind
    // init in the same chunk, as real Claude Code 2.1.303 does; relay reads nothing after init.
    // "result-first": a result before any init report, which must fail stop verification.
    const result = '{"type":"result","subtype":"success"}';
    out(state.initProbe === "result-first" ? `${result}\n${JSON.stringify(init)}` : JSON.stringify(init) + (state.initProbe === "result" ? `\n${result}` : ""));
    setInterval(() => {}, 1000);
    return;
  }
  if (is("auth", "status", "--json")) {
    const loggedIn = !process.env.FAKE_LOGGED_OUT;
    out(JSON.stringify(loggedIn ? { loggedIn, authMethod: "claude.ai", apiProvider: "firstParty", email: "someone@example.com", orgName: "Private Org", subscriptionType: "max" } : { loggedIn }));
    return process.exit(loggedIn ? 0 : 1);
  }
  if (is("mcp", "get", "relay")) {
    const s = state.server;
    if (!s) {
      out('No MCP server named "relay". Configured servers: email, macos');
      return process.exit(1);
    }
    return out([
      "relay:",
      `  Scope: ${s.scope}`,
      "  Status: ✔ Connected",
      `  Type: ${s.type}`,
      ...(s.type === "stdio" ? [`  Command: ${s.command}`, `  Args: ${s.args.join(" ")}`, "  Environment:", ...s.env.map((e) => `    ${e}`)] : [`  URL: ${s.url}`]),
      "",
      "To remove this server, run: claude mcp remove relay -s user",
    ].join("\n"));
  }
  if (is("mcp", "add", "-s", "user", "relay")) {
    if (state.server) fail("MCP server relay already exists in user config");
    const dashes = args.indexOf("--");
    const env = args.slice(5, dashes).filter((a) => a !== "-e");
    const [command, ...rest] = args.slice(dashes + 1);
    state.server = { scope: "User config (available in all your projects)", type: "stdio", command, args: rest, env };
    return save();
  }
  if (is("mcp", "remove", "-s", "user", "relay")) {
    if (!state.server) fail('No MCP server found with name: "relay"');
    state.server = null;
    return save();
  }
  if (is("plugin")) return plugin();
  fail(`claude: unexpected arguments: ${line}`, 2);
}

function codex() {
  if (is("--version")) return out(process.env.FAKE_CODEX_VERSION ?? "codex-cli 0.163.0");
  if (is("login", "status")) {
    if (process.env.FAKE_LOGGED_OUT) fail("Not logged in");
    return out(process.env.FAKE_CODEX_LOGIN ?? "Logged in using ChatGPT");
  }
  if (is("mcp", "get", "relay", "--json")) {
    const server = fs.existsSync(codexConfig) ? parse(fs.readFileSync(codexConfig, "utf8")).mcp_servers?.relay : undefined;
    if (!server) fail("Error: No MCP server named 'relay' found.");
    return out(JSON.stringify({
      name: "relay", enabled: true, disabled_reason: null,
      transport: { type: "stdio", command: server.command, args: server.args ?? [], env: server.env ?? null, env_vars: server.env_vars ?? [], cwd: null },
      enabled_tools: null, disabled_tools: null,
      startup_timeout_sec: server.startup_timeout_sec ?? null, tool_timeout_sec: server.tool_timeout_sec ?? null,
    }, null, 2));
  }
  if (is("plugin")) return plugin();
  fail(`codex: unexpected arguments: ${line}`, 2);
}

if (name === "claude") claude();
else if (name === "codex") codex();
else fail(`fake-host-cli: unknown CLI ${name}`, 2);
