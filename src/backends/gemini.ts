// Google's Gemini CLI over ACP (`gemini --acp`): its profile for the generic driver (acp.ts). What
// this says about Gemini comes from the 0.64.0 package (docs/research/acp-google-grok.md §1.2,
// re-read in the package's bundle for docs/gemini.md) and from `gemini --acp` run without a key,
// with the network denied (initialize and its login methods, session/new refused without a key,
// authenticate rewriting its settings, where it keeps its state). Nothing here has been seen with
// a real key; the qualification run must confirm what docs/gemini.md marks unverified.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { apiKeyFile, readApiKey } from "../core/api-keys.js";
import { harnessHome, networkOn } from "../core/config.js";
import { shellQuote } from "../core/shell.js";
import { targetDef } from "../targets/index.js";
import { acpBackend, genericApproval, promptModels, type AcpProfile, type PreparedState, type ToolCallState } from "./acp.js";
import { discoveryVerified, fullVersionOf } from "./tool-discovery.js";
import type { ApprovalAsk, TurnSpec } from "./types.js";

/**
 * Where Gemini CLI reads administrator policies on macOS. They outrank every other policy tier,
 * relay's included, and no variable moves them, so relay does not run Gemini where there are any.
 */
let adminPoliciesDir = "/Library/Application Support/GeminiCli/policies";
/** Tests only: another place to look for administrator policies, or null for the real one. */
export function setAdminPoliciesDirForTests(dir: string | null): void {
  adminPoliciesDir = dir ?? "/Library/Application Support/GeminiCli/policies";
}

/**
 * Relay's settings for Gemini (its user settings, `<home>/.gemini/settings.json`), the only
 * settings it loads: system settings are pointed at files that do not exist, and the working
 * directory is untrusted, so the repository's are not read. Each key is in 0.64.0's schema.
 */
export const GEMINI_SETTINGS = Object.freeze({
  security: {
    // Sign in with an API key: the one relay hands over in ACP authenticate. Set here as well, since
    // a session is created and loaded with the method these settings name, and authenticate's own
    // write of it is refused in relay's read-only home (Gemini ignores that failure).
    auth: { selectedType: "gemini-api-key" },
    // Its own per-tool sandbox would nest inside relay's.
    toolSandboxing: false,
    // No approval is saved, and no "always" offered: relay answers each request once.
    enablePermanentToolApproval: false,
    disableAlwaysAllow: true,
    // Its tools' environment (shell commands, hooks) without variables that look like secrets, the
    // proxy URL with relay's per-turn token among them. Its own environment holds no key.
    environmentVariableRedaction: { enabled: true },
  },
  tools: { sandbox: false },
  // Clearcut usage statistics (play.googleapis.com) are on unless this says otherwise; OTEL telemetry too.
  privacy: { usageStatisticsEnabled: false },
  telemetry: { enabled: false },
  general: {
    enableAutoUpdate: false, enableAutoUpdateNotification: false, checkpointing: { enabled: false },
    // No session cleanup of Gemini's own: relay continues a session by loading it, and removes the
    // session's home with its run (core/retention.ts). The cleanup is on by default (0.64.0
    // packages/cli/src/config/settingsSchema.ts:389-437, maxAge "30d") and runs at every start, ACP
    // included (packages/cli/src/gemini.tsx:786). It deletes every session file with nothing
    // resumable in it (packages/cli/src/utils/sessionUtils.ts:295, sessionCleanup.ts:302-311), such
    // as one whose only prompt failed before the model answered (seen 2026-10-21), and every one
    // idle past maxAge. session/load then fails ("Internal error", "Invalid session identifier"), for
    // a session it would otherwise load by its id, reply or none (packages/cli/src/acp/
    // acpSessionManager.ts:216-219, allowEmpty; sessionUtils.ts:513-547). Disabled, it returns
    // before it looks (sessionCleanup.ts:116); relay's user settings outrank the schema's default
    // (packages/cli/src/config/settings.ts:255-280).
    sessionRetention: { enabled: false },
  },
  // No .env file from the working directory or above it (in an untrusted folder Gemini would still
  // take GEMINI_API_KEY, GOOGLE_API_KEY and the Cloud project from one), and no memory flags.
  advanced: { ignoreLocalEnv: true, autoConfigureMemory: false },
  hooksConfig: { enabled: false },
  ide: { enabled: false },
  // Its subagents (codebase_investigator, cli_help, generalist: on by default) run models of their own
  // choosing in a loop of their own, which the prompt's response does not report (model_usage counts
  // the main loop only), and the target says it has none (capabilities.subagents "never").
  experimental: { enableAgents: false },
});

/**
 * Relay's policy for Gemini's tools, `<home>/relay-policy.toml`, handed to each of relay's turns with
 * `--policy` (which takes the place of the user policies directory and keeps the user tier, 0.64.0
 * packages/core/src/policy/config.ts getPolicyDirectories and createPolicyEngineConfig). Never in
 * `<home>/.gemini/policies`, where Gemini looks by itself: the session the resume command opens in
 * the person's terminal, outside relay's sandbox, would then run every tool unasked.
 * In the untrusted folder relay runs it in, Gemini's approval mode is forced to "default", which
 * asks before every edit and command; relay's sandbox is the boundary instead, and nothing
 * approved lifts it, so every tool is allowed, as Copilot runs with --allow-all-tools. Gemini
 * still asks, over ACP, about the shell commands its own checks single out (git in an untrusted
 * folder, a directory outside the workspace), and relay answers those as it does every approval
 * request. Denied: save_memory (not a tool in 0.64.0, which keeps memory in a file relay clears
 * between turns, clearGeminiMemory; denied should a release bring it back), invoke_agent (its
 * subagents, switched off in GEMINI_SETTINGS as well), and without network access the two web tools, which reach the web
 * through Google's API host (search and URL fetch run at Google). That denial is defence in depth,
 * not what keeps the turn off the web: any command in the turn can reach that host through the proxy
 * with a key of its own (docs/security-model.md, "What it does not do").
 */
export function geminiPolicy(spec: Pick<TurnSpec, "config" | "grant">): string {
  const rule = (fields: Record<string, string | number | boolean>) =>
    "[[rule]]\n" + Object.entries(fields).map(([k, v]) => `${k} = ${typeof v === "string" ? JSON.stringify(v) : String(v)}`).join("\n") + "\n";
  const rules = [
    "# Written by relay before every turn; read-only to the agent. Relay's sandbox is the boundary.\n",
    rule({ toolName: "run_shell_command", decision: "allow", priority: 100, allowRedirection: true }),
    rule({ toolName: "*", decision: "allow", priority: 90 }),
    // Relay's own tools, which Gemini discovers as discovered_tool_<name> (geminiTools), are allowed
    // by the rule above; none can be discovered under a name denied below (writeGeminiToolFiles).
    rule({ toolName: "save_memory", decision: "deny", priority: 900, denyMessage: "relay keeps no memory from one turn to the next; say what should be remembered in your reply" }),
    rule({ toolName: "invoke_agent", decision: "deny", priority: 900, denyMessage: "subagents are not available in this harness under relay; do the work yourself" }),
  ];
  if (!networkOn(spec.config, spec.grant)) {
    for (const tool of ["google_web_search", "web_fetch"]) {
      rules.push(rule({ toolName: tool, decision: "deny", priority: 900, denyMessage: "this turn has no network access; ask whoever started you for a network grant if the work needs the web" }));
    }
  }
  return rules.join("\n");
}

/**
 * The Node that runs Gemini CLI. npm installs it as a script whose `#!/usr/bin/env node` line finds
 * `node` on PATH, and relay's sandbox runs executables only from its fixed list (the system's,
 * Homebrew's, /usr/local, relay's own Node) and those a profile names: a Node from a version
 * manager (fnm, nvm) needs naming. The first `node` on the PATH Gemini is given, which is relay's,
 * resolved through links; null when there is none (Gemini then cannot start, and says so).
 */
export function nodeOnPath(pathVar: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathVar ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const p = path.join(dir, "node");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return fs.realpathSync(p);
    } catch {
      // Not here.
    }
  }
  return null;
}

/**
 * Removes Gemini's private project memory from the runtime directory relay keeps between turns
 * (`<home>/.cache/.gemini/tmp/<project>/memory`). Gemini 0.64.0 loads that directory's MEMORY.md
 * into every session whatever the folder's trust (packages/core/src/context/memoryContextManager.ts
 * discoverMemoryPaths, its userProjectMemory; storage.ts getProjectMemoryDir), and its system prompt
 * asks the model to keep notes there with its file tools (prompts/promptProvider.ts and snippets.ts,
 * "Private Project Memory"). The runtime directory is kept only because loading a session needs its
 * chats, so whatever a turn wrote there would otherwise come back as standing instructions in the
 * session's later turns, and in the unconfined session the resume command opens. Called before every
 * turn (geminiState) and after it (its cleanup). The directory is the agent's to write, so nothing
 * here follows a link: one where Gemini keeps a directory is removed, never followed.
 */
export function clearGeminiMemory(home: string): void {
  // Move the entire mutable ancestor first. `home` is relay-owned and read-only to the
  // sandbox; after the rename the child cannot rename entries under the quarantine path.
  // No check or recursive removal traverses an agent-writable ancestor by its old name.
  const cache = path.join(home, ".cache");
  const held = path.join(home, `.relay-cleanup-${crypto.randomUUID()}`);
  try { fs.renameSync(cache, held); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
  try {
    const root = fs.lstatSync(held);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      fs.rmSync(held, { force: true });
      return;
    }
    cleanHeldGeminiMemory(held);
  } finally {
    if (fs.lstatSync(held, { throwIfNoEntry: false })) {
      if (fs.lstatSync(cache, { throwIfNoEntry: false })) throw new Error(`Gemini cache reappeared during cleanup; isolated cache kept at ${held}`);
      fs.renameSync(held, cache);
    }
  }
}

function cleanHeldGeminiMemory(cache: string): void {
  const runtime = path.join(cache, ".gemini");
  const tmp = path.join(runtime, "tmp");
  for (const dir of [runtime, tmp]) {
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isSymbolicLink()) {
      fs.rmSync(dir, { force: true });
      return;
    }
    if (!st.isDirectory()) return;
  }
  for (const name of fs.readdirSync(tmp)) {
    const project = path.join(tmp, name);
    const st = fs.lstatSync(project, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) fs.rmSync(project, { force: true });
    // A link or a file named memory is removed as it is; a directory with all it holds, links included, none followed.
    else if (st?.isDirectory()) fs.rmSync(path.join(project, "memory"), { recursive: true, force: true });
  }
}

/** The Gemini home of the relay session a turn belongs to (geminiState). */
export const geminiHome = (spec: Pick<TurnSpec, "markers">): string => path.join(harnessHome(), spec.markers.runId, spec.markers.nodeId, "gemini");
/** Where relay's tool policy for a turn is (geminiPolicy): in the home, outside `.gemini/`, read-only to the agent. */
export const geminiPolicyFile = (spec: Pick<TurnSpec, "markers">): string => path.join(geminiHome(spec), "relay-policy.toml");

/**
 * The Gemini home a session runs with (GEMINI_CLI_HOME): one per relay session, under relay's
 * harness directory, outside its control directory. It is relay's, and read-only to the agent,
 * but for `.cache/`. With SANDBOX=sandbox-exec Gemini keeps its runtime state there
 * (`.cache/.gemini`: its project registry, its sessions under `tmp/<project>/chats`, history) and
 * its configuration in `.gemini/` (seen with 0.64.0: Storage.getGlobalRuntimeDir), so relay can
 * keep the configuration its own and only the runtime state writable, the one thing kept from turn
 * to turn, since loading a session needs it. Relay refuses to run on `.cache` if it is anything but
 * a plain directory (an agent could otherwise swap in a link that the next turn's sandbox would
 * follow), and before every turn rebuilds the rest: its settings (GEMINI_SETTINGS) and its policy
 * (geminiPolicy, in its own file beside `.gemini/`). Nothing of the person's own Gemini configuration
 * (`~/.gemini`) comes along: no MCP servers, extensions, skills, commands, policies or stored login.
 *
 * The key is read here, from the person's key file (core/api-keys.ts), only once every refusal
 * that can come earlier has passed, and never without the per-target opt-in, which is checked here
 * again whatever ran before. Relay hands it to Gemini in the ACP authenticate request
 * (`authenticate`: methodId "gemini-api-key", `_meta["api-key"]`, which Gemini's initialize
 * advertises), and Gemini keeps it in memory for the process's sessions (GeminiAgent.authenticate,
 * 0.64.0). Not in GEMINI_API_KEY: in relay's sandbox the turn's own processes can read the
 * environment each of them was started with (kern.procargs2), so every command the agent ran could
 * read a key there (docs/gemini.md §2.4). Relay's sandbox denies the default key directory to every
 * agent it confines, and relay redacts the key from everything it reads back (`secrets`).
 */
export function geminiState(spec: TurnSpec): PreparedState {
  // The opt-in again, before the key file is opened: whatever runs this, no key without it.
  const optIn = optInProblem(spec);
  if (optIn) throw new Error(optIn);
  const key = readApiKey("gemini");
  const home = geminiHome(spec);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const cache = path.join(home, ".cache");
  const kept = fs.lstatSync(cache, { throwIfNoEntry: false });
  if (kept && (kept.isSymbolicLink() || !kept.isDirectory())) {
    throw new Error(`Gemini's session state for this session (${cache}) has been replaced by something other than a directory, which relay's sandbox would follow, so relay does not run Gemini on it. Start a new job.`);
  }
  for (const name of fs.readdirSync(home)) if (name !== ".cache") fs.rmSync(path.join(home, name), { recursive: true, force: true });
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  // Of what Gemini keeps in .cache, its sessions carry over; its private project memory does not.
  clearGeminiMemory(home);
  // Relay's tools, through Gemini's tool discovery (geminiTools), for every turn relay serves them to
  // (one with a broker), whatever the version: before the prompt, relay checks that discovery ran
  // (geminiDiscoveryCheck), and tells the agent where it did not.
  const toolsDir = spec.relay ? geminiToolsDir(spec) : null;
  /** Where the helper's --list leaves its mark, once relay has written the turn's tool files. */
  let listed: string | null = null;
  const shim = toolsDir ? writeGeminiShim(toolsDir) : null;
  const config = path.join(home, ".gemini");
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  const settings = shim ? { ...GEMINI_SETTINGS, tools: { ...GEMINI_SETTINGS.tools, ...geminiToolCommands(shim) } } : GEMINI_SETTINGS;
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.writeFileSync(geminiPolicyFile(spec), geminiPolicy(spec), { mode: 0o600 });
  const node = nodeOnPath();
  const execPaths = [...(node ? [node] : []), ...(shim ? [shim] : [])];
  return {
    stateDirs: [],
    persistent: { root: home, writable: [".cache"] },
    home: "temp",
    ...(execPaths.length ? { execPaths } : {}),
    env: {
      GEMINI_CLI_HOME: home,
      // Runtime state under .cache (above), and Gemini starts no sandbox of its own: it is inside
      // one, relay's, as its system prompt then says (prompts/promptProvider.ts getSandboxMode).
      SANDBOX: "sandbox-exec",
      // The process relay starts is the agent, not a supervisor that relaunches it.
      GEMINI_CLI_NO_RELAUNCH: "true",
      GEMINI_SANDBOX: "false",
      // Never the keychain (relay's sandbox denies it anyway): no stored key or login is looked for there.
      GEMINI_FORCE_FILE_STORAGE: "true",
      // Untrusted: the repository's .gemini/settings.json, .gemini/.env, hooks, skills, agents,
      // commands and policies are not loaded. A trusted folder's .env could set any variable,
      // GOOGLE_GEMINI_BASE_URL included, and send the key elsewhere.
      GEMINI_CLI_TRUST_WORKSPACE: "false",
      // Files that do not exist, in relay's read-only home: no administrator settings are read.
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(home, "system-settings.json"),
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(home, "system-defaults.json"),
    },
    keychain: false,
    authenticate: { methodId: "gemini-api-key", meta: { "api-key": key } },
    secrets: [key],
    ...(toolsDir ? {
      bridgeReady: async (bridge) => { listed = await writeGeminiToolFiles(toolsDir, bridge); },
      afterInitialize: () => geminiClearMark(listed),
      beforePrompt: ({ agentVersion }) => geminiDiscoveryCheck(listed, agentVersion),
    } : {}),
    // Once the turn is over, so that the person's own session (resumeCommand) loads none of it either;
    // the next turn clears it again whatever happened here. The turn's tool files go with it (the
    // secret's own file goes with the broker): the next turn's home is rebuilt without them anyway.
    cleanup: () => {
      try {
        clearGeminiMemory(home);
      } catch {
        // Cleared again before the next turn, where a failure stops it.
      }
      if (toolsDir) fs.rmSync(toolsDir, { recursive: true, force: true });
    },
  };
}

/**
 * Relay's tools for a Gemini agent. In the untrusted folder relay runs Gemini in, 0.64.0 connects no
 * MCP server, relay's bridge included (McpClientManager.startConfiguredMcpServers returns at once,
 * packages/core/src/tools/mcp-client-manager.ts:576, and :461 for each server). Its command-based
 * tool discovery has no such check (packages/core/src/tools/tool-registry.ts:376-540, run when each
 * session's config is initialized, core config.ts:4126): `tools.discoveryCommand` prints the tools
 * as function declarations, and `tools.callCommand <name>` runs one, its arguments as JSON on stdin,
 * its stdout the result, a non-zero exit or any stderr a failure (:76-180). Both come from relay's
 * own settings in its read-only home, never from the repository's, which an untrusted folder does
 * not load. The model calls each as `discovered_tool_<name>` (targets/gemini.ts toolDiscovery).
 *
 * Both are one shim in `<home>/relay-tools`, read-only to the agent: `call` runs the helper
 * (confine/gemini-tools.ts, through its own entry point GEMINI_TOOLS_MAIN) on relay's Node with an
 * empty environment and --no-warnings. With --list it prints the
 * turn's tools from `tools.json`, which relay wrote before Gemini started: static, so a broker that
 * is gone cannot fail Gemini's session setup, which a failed discovery would; and it leaves a mark,
 * which relay checks before the prompt (geminiDiscoveryCheck). Relay offers them whatever Gemini's
 * version: their safety rests on relay's sandbox and broker. That check shows only that Gemini ran
 * relay's discovery command for the session, not that every call will work. With a tool's name it
 * calls that tool through the turn's broker, as the bridge would: the same socket, the same secret,
 * the same checks of the peer's process tree and the turn (confine/broker.ts). Nothing in
 * `<home>/relay-tools` is secret: `bridge.json` names the socket and the secret's file, which is the
 * broker's own (Broker.secretFile), in the turn's private broker directory inside relay's sockets
 * directory. Every confined turn's profile denies that directory, and only this turn's allows reading
 * that one file (ConfinementPolicy.bridgeSecret), so the secret is readable only inside its turn, as
 * the bridge's secret is in the bridge's environment. It is never on a command line or in an
 * environment, since Gemini shows both command strings to its model in every tool's description.
 * The agent's own commands can read it, as they can read the bridge's (kern.procargs2): the broker
 * serves only the turn's own process tree, and only while the turn is live. The file goes with the
 * broker's directory, and `cleanup` removes `<home>/relay-tools`, when the turn ends.
 */
export const geminiToolsDir = (spec: Pick<TurnSpec, "markers">): string => path.join(geminiHome(spec), "relay-tools");

/** Gemini's settings for relay's tools: the shim, with --list to discover them and alone to call one (it is spawned without a shell, so a path alone). */
export function geminiToolCommands(shim: string): { discoveryCommand: string; callCommand: string } {
  return { discoveryCommand: `${shellQuote(shim)} --list`, callCommand: shim };
}

/**
 * The helper's own entry point (confine/gemini-tools-main.ts), which imports confine/gemini-tools.js
 * alone, and that only node:fs, node:net and node:path: not cli.js, whose import graph reaches
 * node:sqlite, whose ExperimentalWarning before Node 24.15 put something on stderr on every call,
 * which Gemini 0.64.0 reads as a failed call. `--no-warnings` as well, should a warning come anyway.
 */
export const GEMINI_TOOLS_MAIN = path.resolve(import.meta.dirname, "..", "confine", "gemini-tools-main.js");

/** Writes the shim Gemini runs for relay's tools (geminiTools). It holds paths only, nothing secret. */
function writeGeminiShim(dir: string): string {
  fs.mkdirSync(dir, { mode: 0o700 });
  const shim = path.join(dir, "call");
  fs.writeFileSync(shim, [
    "#!/bin/sh",
    "# Relay's tools for this Gemini turn (relay backends/gemini.ts geminiTools): --list prints them, a tool's name calls it.",
    `exec /usr/bin/env -i ${shellQuote(process.execPath)} --no-warnings ${shellQuote(GEMINI_TOOLS_MAIN)} ${shellQuote(dir)} "$@"`,
    "",
  ].join("\n"), { mode: 0o700 });
  return shim;
}

/** Tools relay's policy denies by name (geminiPolicy); no tool of relay's may be discovered under one. */
export const GEMINI_DENIED_TOOLS: readonly string[] = ["save_memory", "invoke_agent", "google_web_search", "web_fetch"];

/**
 * Once the turn's broker is open (PreparedState.bridgeReady): the tools a bridge connection is
 * offered, exactly as the broker lists them (name, description, input schema), as Gemini's function
 * declarations (`tools.json`); and where the broker's socket and the secret's file are, and where
 * the helper's --list leaves its mark (`bridge.json`, paths only). The mark goes in the turn's private
 * temporary directory, which the turn may write and which goes with it (relay's Gemini home is
 * read-only to the agent). Each tool must be one Gemini can name with its prefix and that no rule
 * of relay's policy denies under that name. Returns where the mark goes.
 */
export async function writeGeminiToolFiles(dir: string, bridge: { socketPath: string; secretFile: string; listTools(): Promise<Tool[]>; tmpDir: string }): Promise<string> {
  const prefix = targetDef("gemini").toolDiscovery!.prefix;
  const declarations = (await bridge.listTools()).map((t) => {
    const named = `${prefix}${t.name}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.name) || named.length > 64) throw new Error(`relay cannot offer its tool ${JSON.stringify(t.name)} through Gemini's tool discovery: Gemini could not name it`);
    if (GEMINI_DENIED_TOOLS.includes(named)) throw new Error(`relay's tool ${JSON.stringify(t.name)} would be discovered as ${named}, which relay's policy for Gemini denies`);
    return { name: t.name, description: t.description ?? "", parametersJsonSchema: t.inputSchema };
  });
  fs.writeFileSync(path.join(dir, "tools.json"), JSON.stringify(declarations), { mode: 0o600 });
  const listed = path.join(bridge.tmpDir, GEMINI_DISCOVERY_MARK);
  fs.rmSync(listed, { force: true });
  fs.writeFileSync(path.join(dir, "bridge.json"), JSON.stringify({ socket: bridge.socketPath, secret: bridge.secretFile, listed }), { mode: 0o600 });
  return listed;
}

/** The file the helper's --list writes when Gemini runs relay's discovery command (confine/gemini-tools.ts). */
export const GEMINI_DISCOVERY_MARK = ".relay-tools-listed";

/**
 * Removes the mark the helper's --list left while Gemini answered initialize (geminiDiscoveryCheck), so
 * that only the session's own setup can leave it (PreparedState.afterInitialize). The turn's temporary
 * directory is the turn's to write: anything but a file or a link there is left as it is, and counts
 * as no mark.
 */
export function geminiClearMark(listed: string | null): void {
  if (!listed) return;
  const st = fs.lstatSync(listed, { throwIfNoEntry: false });
  if (st?.isFile() || st?.isSymbolicLink()) fs.rmSync(listed, { force: true });
}

/** What relay's prompt tells a Gemini agent whose session did not run relay's tool discovery, before anything else it reads. */
export const NO_DISCOVERED_TOOLS = "[relay] Before you start: relay's tools are not available to you in this turn after all. Gemini did not run relay's tool discovery when it set up this session, so you have no discovered_tool_ tools: do not try to delegate or reach other agents through relay; do the work yourself.";

/**
 * Before the prompt (PreparedState.beforePrompt): whether Gemini ran relay's discovery command when
 * it set up this turn's session, from the mark the helper's --list leaves. 0.64.0 and 0.65.0 run it
 * twice per process: while they answer ACP initialize, for their start-up config
 * (acpRpcDispatcher.ts:81 awaits config.initialize(); the discovery command comes from the same user
 * settings, cli config.ts:985), and again while each session's config is initialized, before they
 * answer session/new or session/load (acpSessionManager.ts newSession and loadSession await
 * config.initialize()). Each initialize builds the tool registry (core config.ts:1508, :1510 in
 * 0.65.0), which runs discovery (:4126, :4132). So the mark from initialize is removed before the
 * session is asked for (geminiClearMark, PreparedState.afterInitialize), and only the session's own
 * setup can leave it again. Where it did not, the agent is told before its prompt and the turn says
 * so; the turn goes on without relay's tools. The mark shows that Gemini ran relay's discovery
 * command for the session, not that every call will work. On a version relay's tools were not
 * verified live on (toolDiscovery.versions), where it ran, the turn gets a short note saying so.
 * `listed`: where the mark goes, or null where none was set up.
 */
export function geminiDiscoveryCheck(listed: string | null, agentVersion: string | null): { promptPrefix?: string; notes?: string[] } | undefined {
  if (!listed) return undefined;
  const def = targetDef("gemini");
  const verified = def.toolDiscovery!.versions.join(", ");
  const version = fullVersionOf(agentVersion);
  const which = version ? `${def.product} ${version}` : `${def.product} (its version not reported)`;
  if (!fs.lstatSync(listed, { throwIfNoEntry: false })?.isFile()) {
    return {
      promptPrefix: NO_DISCOVERED_TOOLS,
      notes: [`${which} did not run relay's tool discovery when it set up this turn's session, so its agent had no relay tools; relay told it so before its prompt, and the turn went on without them. Relay checks this at every launch; relay's tools were checked on ${def.product} ${verified}.`],
    };
  }
  if (!discoveryVerified(def, version)) return { notes: [`${which} is not a version relay's tools were checked on (${verified}); it ran relay's discovery command for this turn's session.`] };
  return undefined;
}

/**
 * Variables removed from Gemini's environment beyond credentials: every one of Gemini's own and
 * of OpenTelemetry's (relay sets the ones it means), Google's credentials, project and gcloud
 * settings (under child_auth "any" a target's own credentials would otherwise pass through; the
 * key is relay's to hand over), the sandbox and debug switches. The endpoint variables are not
 * removed: relay refuses to launch with one (the target's endpointEnv), as it does for every target.
 */
const SCRUB = /^(GEMINI_|OTEL_|CLOUDSDK_|OAUTH_CALLBACK_|GOOGLE_CLOUD_|GOOGLE_GENAI_USE_)|^(GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|CLOUD_SHELL|SANDBOX|SEATBELT_PROFILE|BUILD_SANDBOX|DEBUG|DEBUG_MODE|NO_BROWSER)$/;

/**
 * Why relay may not hand Gemini a key this turn, or null: only with the person's opt-in by name,
 * targets.gemini.child_auth "any" (the global child_auth does not count). The profile's refuse()
 * says it before anything starts, and geminiState checks it again before it opens the key file.
 */
function optInProblem(spec: Pick<TurnSpec, "config">): string | null {
  if (spec.config.targets.gemini?.child_auth === "any") return null;
  let file: string;
  try {
    file = apiKeyFile("gemini");
  } catch {
    file = "your key file";
  }
  return `Gemini CLI signs in only with an API key (Google no longer serves its account login to Gemini CLI), and relay hands one to it only when you ask for that by name: set targets.gemini.child_auth to "any" in relay's config (the global child_auth does not count). Relay then reads the key from ${file} and gives it to Gemini alone.`;
}

/** Whether there are administrator policies, which outrank relay's (a file in their directory). */
function adminPolicies(): boolean {
  try {
    return fs.readdirSync(adminPoliciesDir).some((n) => n.endsWith(".toml"));
  } catch {
    return false;
  }
}

/**
 * What one of Gemini's approval requests asks for, in relay's terms. Gemini 0.64.0 sends no
 * rawInput with a tool call (acpSession.ts, runTool): a shell command's call has kind "execute", the
 * command itself as its title (ShellToolInvocation.getDisplayTitle is params.command), and as its
 * one text content where it runs and why ("[in <dir_path>] (<description>)", or "[current working
 * directory <cwd>] ..."). Its edits carry their paths in locations and their diff, which the
 * generic reading takes. Whatever is approved, relay's sandbox stays on, and the request says so.
 */
export function geminiApproval(call: ToolCallState, spec: Pick<TurnSpec, "cwd">): ApprovalAsk | null {
  const text = (call.content ?? [])
    .map((c) => (c as { type?: unknown; content?: { type?: unknown; text?: unknown } } | null))
    .map((c) => (c?.type === "content" && c.content?.type === "text" && typeof c.content.text === "string" ? c.content.text.trim() : ""))
    .find(Boolean) ?? "";
  const where = /^\[(?:in|current working directory) (.+?)\](?: \((.*)\))?(?: \[background\])?$/s.exec(text);
  let ask = genericApproval(call);
  const title = typeof call.title === "string" && call.title.trim() ? call.title : undefined;
  if (!ask && call.kind === "execute" && title) ask = { kind: "command", summary: title, ...(where?.[2] ? { reason: where[2] } : {}), detail: { tool_call: call.toolCallId } };
  if (!ask) return null;
  const detail = (ask.detail ?? {}) as Record<string, unknown>;
  const cwd = path.resolve(spec.cwd, where?.[1] ?? (typeof detail.cwd === "string" ? detail.cwd : "."));
  const paths = ask.paths?.map((p) => path.resolve(spec.cwd, p));
  return { ...ask, ...(paths ? { paths } : {}), detail: { ...detail, ...(ask.kind === "command" ? { cwd } : {}), confined: true } };
}

/**
 * Gemini's model aliases (0.64.0 packages/core/src/config/models.ts: GEMINI_MODEL_ALIAS_* and the
 * deprecated PREVIEW_GEMINI_MODEL_AUTO, DEFAULT_GEMINI_MODEL_AUTO): what it is configured with, never
 * what serves a request, which is always a model id they resolve to.
 */
export const GEMINI_ALIASES: ReadonlySet<string> = new Set(["auto", "pro", "flash", "flash-lite", "auto-gemini-3", "auto-gemini-2.5"]);

/**
 * The models that answered a Gemini prompt, from its response's `_meta.quota.model_usage` (the
 * driver's promptModels), less the entries that name no served model. It names the model Gemini
 * selected for each round, not the one that served it: an availability fallback taken inside a
 * round (GeminiChat's retry, packages/core/src/core/geminiChat.ts:1018-1030 and :1191-1194;
 * fallback/handler.ts processIntent, config.ts activateFallbackMode) is listed under the model that
 * failed for that round, and only from the next round under its own name (config.getModel() after
 * setModel), so a one-round prompt's fallback is not in it at all. In 0.64.0 that list counts the
 * main loop only, one entry per model, in order of first use (packages/cli/src/acp/acpSession.ts:
 * modelUsageMap, filled at 576-584 from the Finished events of geminiClient.sendMessageStream alone).
 * Each round of the loop is keyed by `config.getModel()`, the configured id (:427), until the stream
 * says which model it routed to (ModelInfo, :494-495). The stream says so only in the prompt's first
 * round: ModelInfo is yielded while no model is fixed for the prompt (core/client.ts:825-828), which
 * is reset only for a new prompt id (:953-958), and ACP keeps one prompt id for every round of a
 * prompt (acpSession.ts:326, :434-437). So every round after a tool call is keyed by the configured
 * id although the routed model answered it: "auto" (or another alias) with no pinned model, the pin
 * itself where Gemini resolved it to another id (gemini-3.5-flash to gemini-3.8-flash, say,
 * config/models.ts:311-317). Dropped here: an alias anywhere, and the model the session reported
 * (`reported`, its configured id) after the first entry. What remains is what was routed to, or what
 * an availability fallback within Google switched to. Gemini's helper calls, Flash-Lite among them,
 * are never in the list: the map takes only the Finished events of the main chat's stream (turn.run
 * with LlmRole.MAIN, core/client.ts:833-836), and the helpers go through BaseLlmClient, whose calls
 * yield no event into it: the router's classifier (routing/strategies/classifierStrategy.ts:171-178,
 * UTILITY_ROUTER), the next-speaker check (utils/nextSpeakerChecker.ts:113-119), loop detection
 * (services/loopDetectionService.ts:704-712), chat compression (context/chatCompressionService.ts:
 * 595-639); nor do the web tools' own calls (geminiClient.generateContent, tools/web-search.ts:95,
 * tools/web-fetch.ts:475, :806).
 */
export function geminiServedModels(response: unknown, reported?: string): string[] {
  return promptModels(response).filter((m, i) => !GEMINI_ALIASES.has(m) && !(i > 0 && m === reported));
}

/**
 * The directories granted to a write turn (grant.write_paths) that Gemini's own file tools may write
 * in. They write only inside its workspace (write_file and edit check config.validatePathAccess,
 * 0.64.0 packages/core/src/config/config.ts:3379-3438), which is the working directory and the
 * directories `--include-directories` names, read from the process's arguments for every ACP session
 * (packages/cli/src/acp/acpSessionManager.ts newSessionConfig, `loadCliConfig(…, this.argv, …)`;
 * cli/src/config/config.ts:637-640), in an untrusted folder too (core config.ts:1459-1461 adds them
 * with no trust check). Without them only shell commands could use a grant, and Gemini would ask
 * about each one with a directory outside the workspace. Gemini splits the flag's value at commas and
 * trims each part (coerceCommaSeparated, cli config.ts:119-129), so a granted directory whose path
 * has a comma, or starts or ends with a space, is left out: relay's sandbox still lets its shell
 * commands write there. Relay's sandbox is the boundary either way; this only lets Gemini's tools
 * use what the sandbox allows.
 */
export function geminiIncludeDirectories(spec: Pick<TurnSpec, "access" | "grant">): string[] {
  if (spec.access !== "write") return [];
  return (spec.grant?.write_paths ?? []).filter((d) => path.isAbsolute(d) && !d.includes(",") && d === d.trim());
}

/**
 * The prompt as relay sends it to Gemini. 0.64.0 joins a prompt's text, trims it, and runs one that
 * starts with "/" or "$" as one of its ACP commands when its first word names one (memory,
 * extensions, init, restore, about, help): the model never sees it, and the turn ends with the
 * command's output and an empty model_usage (packages/cli/src/acp/acpSession.ts:347-371,
 * acpCommandHandler.ts:25-30, 98-103). A resume message or follow-up goes to Gemini as the caller
 * wrote it, so one that starts so gets a line in front that is no command.
 */
export function geminiPromptText(prompt: string): string {
  const t = prompt.trimStart();
  return t.startsWith("/") || t.startsWith("$") ? `The message below is for you; it is not a Gemini CLI command.\n\n${prompt}` : prompt;
}

export const geminiProfile: AcpProfile = {
  // The model applies to every session of this process; the session's reported model is checked
  // against it. Gemini has no reasoning-effort flag, so effort is not applied. Relay's tool policy
  // is handed over here, not left in Gemini's home (geminiPolicy); a write turn's granted directories
  // join its workspace (geminiIncludeDirectories).
  args: (spec, model) => [
    "--acp", "--policy", geminiPolicyFile(spec),
    ...geminiIncludeDirectories(spec).flatMap((d) => ["--include-directories", d]),
    ...(model ? ["--model", model] : []),
  ],
  promptText: geminiPromptText,
  scrub: (k) => SCRUB.test(k),
  prepareState: geminiState,
  login: {
    how: "Gemini CLI signs in with an API key only. Relay reads it from your key file and hands it to Gemini alone (in ACP authenticate), when targets.gemini.child_auth is \"any\".",
  },
  // Its approval mode in an untrusted folder; read back before the prompt.
  mode: () => "default",
  normalizeApproval: geminiApproval,
  // Only the prompt's response says which models answered (_meta.quota.model_usage); the session
  // reports what was asked for, or "auto". Recorded as served, as every model report is, less the
  // entries that stand for the configured id (geminiServedModels).
  servedModels: geminiServedModels,
  // Its session lists a menu (auto, 2.5 Pro, its default Flash and Flash-Lite, previews), while
  // --model takes any id (buildAvailableModels, 0.64.0): a model the menu leaves out is not refused.
  acceptsUnlistedModels: true,
  // 0.64.0 answers session/load and then streams the conversation, without waiting for it
  // (packages/cli/src/acp/acpSessionManager.ts:284, `session.streamHistory(messages)` not awaited,
  // then `return response` at :294), each update awaited in turn (acpSession.ts:249-315). So relay
  // lets the replay end before it prompts. The replay writes local history, a few milliseconds' work
  // even for a long session; the prompt's first words wait on a round trip to Google.
  replaysAfterLoad: { quietMs: 300, maxMs: 30_000 },
  refuse(spec) {
    const optIn = optInProblem(spec);
    if (optIn) return optIn;
    if (adminPolicies()) {
      return `this Mac has Gemini CLI administrator policies (${adminPoliciesDir}), which outrank relay's own and which no setting moves, so relay cannot tell what Gemini would be allowed to do. It does not run Gemini here.`;
    }
    return null;
  },
};

export const geminiBackend = acpBackend(geminiProfile);
