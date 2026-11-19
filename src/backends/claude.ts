import crypto from "node:crypto";
import { assertNeverAdapter } from "./never-admission.js";
import { neverFloorApplies } from "../core/never-coverage.js";
import { neverProfileInputs } from "../core/never-policy.js";
import type { NeverPolicy } from "../core/never-policy.js";
import { anthropicRefusal } from "../core/refusal.js";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { privateStateRoot } from "../confine/private-root.js";
import { relaySocketsDir } from "../confine/sockets.js";
import { HARNESS_CONFIG } from "../confine/seatbelt.js";
import { nativeTemp } from "./native-temp.js";
import { configProtection, relayWriteProtected, relayCredentialProtected, relayCodexProtected } from "../core/protected-config.js";
import { keyAuthority, keyPathsToDeny } from "../core/api-keys.js";
import { managedNetworkProblem, managedSettings, managedSettingsRefusal, settingsEnvProblem } from "../core/claude-settings.js";
import { git } from "../core/git.js";
import { authFor, canonical, relayHome } from "../core/config.js";
import { claudeSkillNames, mcpFileNames, SKILLS_PLUGIN } from "../core/extensions.js";
import { CONTEXT_DIR } from "../core/context.js";
import { writing } from "../core/storage.js";
import { agentEnv, hostSession } from "./env.js";
import { afterTurn, streamTurn } from "./stream.js";
import { openTurnProxy } from "../confine/turn.js";
import type { TurnProxy } from "../confine/proxy.js";
import { activityOf, usageFrom, relayServerCommand, turnPolicy, type Backend, type Invocation, type StreamState, type TurnSpec, type Usage } from "./types.js";
import { installedVersion } from "./cli-version.js";
import { VERIFIED } from "../targets/verified.js";

/** Explicit disables, also used by the scratch native-skill probe. See the version evidence below. */
export const CLAUDE_BUILTIN_PLUGINS = [
  "cc-plugin-agents-md", "cc-plugin-claude-test", "cc-plugin-diff", "cc-plugin-easel",
  "cc-plugin-mermaid", "cc-plugin-mods-guide", "cc-plugin-plugin-authoring", "cc-plugin-privacy",
  "cc-plugin-responsive-mode", "cc-plugin-sec-default", "cc-plugin-telemetry", "cc-plugin-tips",
  "cc-plugin-you-should-know", "claude-platform",
] as const;

/**
 * The one built-in relay leaves on (decided 2026-11-16): a deny-only tool.check hook that refuses a
 * call putting the signed-in account's email into a client's identity (a User-Agent, a From header,
 * git's user.email, an SEC EDGAR identity), which an interactive Claude Code session has and relay
 * has no equivalent of. It stays in CLAUDE_BUILTIN_PLUGINS, so the release watcher keeps comparing it.
 * Kept only on the versions in VERIFIED.claudePrivacyPlugin, whose copy of it relay has read: a hook
 * module with the fs.list, fs.read and session.identity calls whose tool.check hook decides only
 * "deny", from 2.1.326 also a session.identity hook that only refuses or withholds the identity it is
 * asked for, and no skills, MCP servers, agents, commands or tools (docs/research/claude-builtin-plugins.md).
 * On any other version, or one relay cannot read, it is disabled as before.
 */
export const CLAUDE_KEPT_BUILTIN = "cc-plugin-privacy";

/** Whether relay leaves CLAUDE_KEPT_BUILTIN on for Claude Code `version` (null: unreadable, so no). */
export function keepsPrivacyPlugin(version: readonly number[] | string | null | undefined): boolean {
  const v = typeof version === "string" ? version : version?.join(".");
  return typeof v === "string" && (VERIFIED.claudePrivacyPlugin as readonly string[]).includes(v);
}

/**
 * Shared by real launches and doctor's init-only probe; unfamiliar plugins still fail closed.
 * `version` is the Claude Code version the launch will run (installedVersion), which decides only
 * whether CLAUDE_KEPT_BUILTIN is left on; the init report is checked against its own version.
 */
export function claudeSkillIsolation(cwd: string, env: NodeJS.ProcessEnv, version: readonly number[] | null = null) {
  const keep = keepsPrivacyPlugin(version);
  return {
    disableBundledSkills: true,
    // The built-in registry of the versions in VERIFIED.claudeBuiltinPlugins (targets/verified.ts;
    // 2.1.303's Tce, 2.1.308's Lpe: the same twelve; 2.1.325's pRe: those twelve, cc-plugin-privacy
    // and claude-platform, the one name without the cc-plugin- prefix); older versions accept the
    // extra false entries. cc-plugin-privacy is a deny-only tool.check hook; it takes its enabled
    // state from trusted settings only, flagSettings (this file) among them, so this false holds
    // unless managed settings enable it. On a version in VERIFIED.claudePrivacyPlugin it is left out
    // of this list, so its own default (on) applies, as in an interactive session: the person's or an
    // organisation's settings can still turn it off. docs/research/claude-builtin-plugins.md.
    enabledPlugins: Object.fromEntries(CLAUDE_BUILTIN_PLUGINS.filter((name) => !(keep && name === CLAUDE_KEPT_BUILTIN))
      .map((name) => [`${name}@builtin`, false])),
    skillOverrides: Object.fromEntries([...claudeSkillNames(cwd, env), "doctor", "plugin-authoring"].map((name) => [name, "off"])),
  };
}

/** Native shell and file tools consume the same final floor. Settings variants are gated above. */
export function applyClaudeNeverPolicy(policy: NeverPolicy, sandbox: Record<string, unknown>, denyRules: string[]): void {
  const floor = neverProfileInputs(policy);
  const filesystem = sandbox.filesystem as Record<string, unknown>;
  const writes = [...floor.denyAll, ...floor.denyWrite];
  filesystem.denyRead = [...new Set([...((filesystem.denyRead as string[] | undefined) ?? []), ...floor.denyAll])];
  filesystem.denyWrite = [...new Set([...((filesystem.denyWrite as string[] | undefined) ?? []), ...writes])];
  sandbox.allowUnsandboxedCommands = false;
  for (const [tool, paths] of [["Read", floor.denyAll], ["Edit", writes]] as const) for (const p of paths) {
    const escaped = p.replace(/([*?[\]{}!\\])/g, "\\$1");
    denyRules.push(`${tool}(/${escaped})`, `${tool}(/${escaped}/**)`);
  }
  if (policy.hosts.length) denyRules.push("WebSearch", "WebFetch");
}

/**
 * How the parent session identifies and configures itself; a launched agent is its own session.
 * CLAUDE_AUTO_BACKGROUND_TASKS too: under claude -p it moves an MCP call still running after two
 * minutes to the background, and -p then ends the turn without its result and stops the call
 * (Claude Code 2.1.302, experiments/answers.md), which would drop the agent's own waits on relay.
 */
const AUTH = /^CLAUDE_CODE_(USE_|OAUTH_TOKEN|SKIP_)/;
const scrub = (k: string) =>
  k === "CLAUDECODE" || k === "CLAUDE_AGENT_SDK_VERSION" || k === "CLAUDE_AUTO_BACKGROUND_TASKS" || (k.startsWith("CLAUDE_CODE_") && !AUTH.test(k));

/**
 * The deny rules in the person's own Claude Code settings, which a launched agent that loads none
 * of their settings would otherwise go without. Only permissions.deny is taken from the file:
 * allow and ask rules, directories, env, apiKeyHelper and the rest are neither kept nor passed on.
 * A deny rule can only take something away from a job. A file relay cannot read, or whose deny
 * list it cannot make sense of, stops the launch: the person expects those rules to hold.
 */
export function userDenyRules(env: NodeJS.ProcessEnv = process.env): string[] {
  // Where Claude Code looks for user settings; the launched agent gets the same CLAUDE_CONFIG_DIR.
  const dir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  const file = path.join(dir, "settings.json");
  const cannot = (why: string) => new Error(
    `relay carries the deny rules in your Claude Code settings (${file}) to every Claude it launches, and ${why}, so it does not launch Claude. Fix the file, or move it aside`,
  );
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cannot(`could not read the file (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's own message quotes the file, which may hold a key.
    throw cannot("the file is not valid JSON");
  }
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!obj(parsed)) throw cannot("the file does not hold a JSON object");
  const permissions = parsed.permissions;
  if (permissions === undefined) return [];
  if (!obj(permissions)) throw cannot('its "permissions" is not an object');
  const deny = permissions.deny;
  if (deny === undefined) return [];
  if (!Array.isArray(deny) || deny.some((r) => typeof r !== "string")) throw cannot('its "permissions.deny" is not a list of strings');
  // A Read or Edit path with one leading slash is relative to the file that holds the rule: in user
  // settings that is their directory, in relay's settings file the turn's. Anchored absolutely, it
  // means what it meant where it was written. The directory goes into a gitignore-style pattern, so
  // one whose name would read as pattern syntax cannot be put there faithfully.
  const anchored = /^(Read|Edit)\(\/(?!\/)/;
  if (/[*?[\]{}!\\\r\n]/.test(dir) && (deny as string[]).some((r) => anchored.test(r))) {
    throw cannot(`a Read or Edit rule there is relative to ${dir}, whose name holds characters a rule would read as a pattern, so relay cannot anchor it there`);
  }
  return (deny as string[]).map((r) => r.replace(anchored, (_, tool: string) => `${tool}(/${dir}/`));
}

/** Built-in tools of a read-only turn: no editing tools at all. */
const READ_TOOLS = ["Read", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"];
/**
 * Built-in tools of a write turn: what working on code takes, including Claude's own subagents.
 * Left out on purpose are the tools that reach beyond the job: scheduling, remote triggers,
 * messages to the user's other sessions, notifications.
 */
const WRITE_TOOLS = [
  ...READ_TOOLS, "Edit", "Write", "NotebookEdit", "LSP", "Monitor", "Skill", "ToolSearch",
  "Task", "TaskCreate", "TaskGet", "TaskList", "TaskStop", "TaskUpdate",
];

// Kept as a public backend export for callers of the existing preflight helper.
export { settingsEnvProblem } from "../core/claude-settings.js";

/** A Claude model id as Claude Code reports it: claude-…, or through Bedrock (us.anthropic.claude-…) or Vertex (claude-…@date). */
const CLAUDE_MODEL = /^(?:[a-z]+\.)?(?:anthropic\.)?claude-[\w.:@[\]-]+$/i;

/**
 * What Claude reports about itself as it starts, checked against what relay asked for. This is
 * the nearest thing to reading back the effective configuration: settings relay does not control
 * (an organisation's, say) can change any of it.
 */
function initProblem(event: Record<string, unknown>, spec: TurnSpec): string | null {
  const cfg = spec.config;
  // Which family answers is checked whatever else is: relay reaches other families only.
  if (typeof event.model !== "string" || !CLAUDE_MODEL.test(event.model)) {
    return typeof event.model === "string" ? `Claude reported the model ${JSON.stringify(event.model)}, which is not a Claude model` : "Claude did not report its model, so relay cannot tell which family of model would answer";
  }
  // So is what every turn loaded: the plugins and skills Claude reports do not
  // depend on its permission mode, so a write turn under allow_dangerous is checked too.
  const skillProblem = claudeSkillsProblem(event, spec.skills);
  if (skillProblem) return skillProblem;
  const { dangerous, ask } = turnPolicy(spec);
  if (dangerous) return null;
  // Each field must be there and be what relay asked for. Something Claude did not report is not something relay can rely on.
  const mode = spec.access === "write" ? "acceptEdits" : ask ? "default" : "dontAsk";
  if (event.permissionMode !== mode) return `Claude reported permission mode ${JSON.stringify(event.permissionMode ?? null)}, not the ${mode} relay asked for`;
  if (!Array.isArray(event.tools) || event.tools.some((t) => typeof t !== "string")) return "Claude did not report its tools as relay expects";
  const allowed = new Set(toolsFor(spec));
  // Relay's own tools may be listed with the built-in ones.
  const extra = (event.tools as string[]).filter((t) => !allowed.has(t) && !t.startsWith("mcp__relay__"));
  if (extra.length) return `Claude started with tools relay did not give it (${extra.join(", ")})`;
  if (!Array.isArray(event.mcp_servers)) return "Claude did not report its MCP servers as relay expects";
  if (cfg.child_mcp === "relay-only") {
    const servers = (event.mcp_servers as { name?: unknown }[]).map((m) => m?.name).filter((n) => n !== "relay");
    if (servers.length) return `Claude started with MCP servers relay did not give it (${servers.map(String).join(", ")})`;
  }
  // "none" is what Claude reports when it is signed in with an account and no key is in play.
  if (authFor(cfg, "claude") === "login" && event.apiKeySource !== "none") {
    return typeof event.apiKeySource === "string"
      ? `Claude is signing in with an API key (${event.apiKeySource}), not an account login, and relay is set not to run on API keys ("child_auth": "any" allows it)`
      : 'Claude did not report how it is signed in, so relay cannot tell that it is not an API key ("child_auth": "any" skips this check)';
  }
  return null;
}

/** The built-in tools a turn gets: a read turn given skills also gets Skill, to load them. */
const toolsFor = (spec: TurnSpec): string[] => (spec.access === "write" ? WRITE_TOOLS : spec.skills ? [...READ_TOOLS, "Skill"] : READ_TOOLS);

/** The init report's lists a plugin could add to, besides its own entry in `plugins`. */
const PLUGIN_CONTRIBUTIONS = ["skills", "slash_commands", "agents", "mcp_servers", "tools"] as const;

/**
 * Whether `p`, an entry of `event`'s plugins, is CLAUDE_KEPT_BUILTIN as relay read it: the init
 * report of a version in VERIFIED.claudePrivacyPlugin, the entry exactly the built-in's (name, path
 * "builtin", source `<name>@builtin`, nothing else), and nothing of it among the skills, commands,
 * agents, MCP servers or tools, each of which the report must list. Anything else is not admitted,
 * and claudeSkillsProblem refuses it as it refuses any other plugin relay did not give.
 */
function keptBuiltin(event: Record<string, unknown>, p: unknown): boolean {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  const entry = p as Record<string, unknown>;
  if (Object.keys(entry).sort().join() !== "name,path,source") return false;
  if (entry.name !== CLAUDE_KEPT_BUILTIN || entry.path !== "builtin" || entry.source !== `${CLAUDE_KEPT_BUILTIN}@builtin`) return false;
  if (typeof event.claude_code_version !== "string" || !keepsPrivacyPlugin(event.claude_code_version)) return false;
  return PLUGIN_CONTRIBUTIONS.every((k) => Array.isArray(event[k]) && !JSON.stringify(event[k]).includes(CLAUDE_KEPT_BUILTIN));
}

/**
 * Every turn's init report must name exactly relay's package and its skills, or empty lists
 * when it was given none. Bundled skills/plugins are disabled too: no name-only ambiguity. The one
 * exception is CLAUDE_KEPT_BUILTIN, admitted only as keptBuiltin describes, at most once.
 */
export function claudeSkillsProblem(event: Record<string, unknown>, skills: TurnSpec["skills"]): string | null {
  const reported = event.plugins as { name?: unknown; path?: unknown; source?: unknown }[] | undefined;
  const listed = event.skills as unknown[] | undefined;
  if (!Array.isArray(reported) || !Array.isArray(listed) || listed.some((x) => typeof x !== "string")) {
    return "Claude did not report its skills and plugins, so relay cannot confirm that it loaded only the skills relay gave it";
  }
  const kept = reported.filter((p) => keptBuiltin(event, p));
  if (kept.length > 1) return "Claude reported duplicate skills or plugins relay did not give it";
  const plugins = reported.filter((p) => !keptBuiltin(event, p));
  const pkg = skills ? canonical(skills.dir) : null;
  const foreign = plugins.filter((p) => !(pkg && p?.name === SKILLS_PLUGIN && typeof p.path === "string" && canonical(p.path) === pkg));
  if (foreign.length) {
    const builtin = (p: typeof foreign[number]) => typeof p?.source === "string" && p.source.endsWith("@builtin");
    const bundled = foreign.filter(builtin).map((p) => String(p?.name));
    const other = foreign.filter((p) => !builtin(p)).map((p) => String(p?.name));
    return [
      ...(other.length ? [`Claude started with plugins relay did not give it (${other.join(", ")})`] : []),
      ...(bundled.length ? [`Claude started with plugins bundled with this Claude Code version that relay does not yet disable (${bundled.join(", ")}). Update relay or pin Claude Code to a tested version`] : []),
    ].join(". ");
  }
  if (pkg && plugins.length === 0) return "Claude did not report relay's skills plugin at its package path";
  if (new Set(listed).size !== listed.length || plugins.length > (pkg ? 1 : 0)) return "Claude reported duplicate skills or plugins relay did not give it";
  const want = (skills?.names ?? []).map((n) => `${SKILLS_PLUGIN}:${n}`);
  const missing = want.filter((w) => !listed.includes(w));
  if (missing.length) return `Claude did not load the skills relay gave it (${missing.join(", ")})`;
  const stray = (listed as string[]).filter((x) => !want.includes(x));
  if (stray.length) return `Claude started with skills relay did not give it (${stray.join(", ")})`;
  return null;
}

/**
 * The notice Claude Code puts on a headless session's stream when it refused a fast request and
 * retried it at standard speed: usage credits run out, an organisation's spend cap reached
 * (2.1.302: a system notification with this key, once per turn; code.claude.com/docs/en/fast-mode,
 * 2026-10-17). Its result then still says fast mode is on, and need not say the speed it ran at.
 */
const OVERAGE_NOTICE = "fast-mode-overage-rejected";

/**
 * What Claude's result says about fast mode (Claude Code 2.1.302: fast_mode_state,
 * fast_mode_disabled_reason, usage.speed), with the turn's fast-mode notice from its stream, or
 * null when it says nothing.
 */
function speedReport(event: Record<string, unknown>, notices: string[] = []): NonNullable<Usage["speed_report"]> | null {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const r = {
    fast_mode_state: str(event.fast_mode_state), fast_mode_disabled_reason: str(event.fast_mode_disabled_reason),
    speed: str((event.usage as { speed?: unknown } | undefined)?.speed),
    notice: notices.length ? [...new Set(notices)].join("; ") : undefined,
  };
  for (const k of Object.keys(r) as (keyof typeof r)[]) if (r[k] === undefined) delete r[k];
  return Object.keys(r).length ? r : null;
}

/** Claude's fast_mode_disabled_reason values (Claude Code 2.1.302), in words, for the warning that says a fast turn ran slower. */
const FAST_MODE_REASONS: Record<string, string> = {
  extra_usage_disabled: "usage credits are off for this account, and fast mode is billed to them",
  // 2.1.302: Opus, which fast mode runs, is not among the organisation's allowed models (and the model
  // that ran is not an allowed fast one either), or the API refused fast mode for the model.
  model_not_allowed: "fast mode is not allowed for this model here: Opus is not among the organisation's allowed models, or Claude's API refused fast mode for the model",
  free: "fast mode needs a paid plan",
  preference: "fast mode is turned off for this organisation",
  network_error: "Claude could not check fast mode's availability",
  not_first_party: "fast mode needs Anthropic's own API",
  disabled_by_env: "fast mode is turned off in its environment",
  sdk_opt_in_required: "this session did not opt in to fast mode",
  pending: "Claude was still checking whether fast mode is available",
  unknown: "fast mode is unavailable",
};

/**
 * What to tell the caller when a turn asked for fast mode and Claude says it ran at standard
 * speed, in part or throughout, or null when it ran fast. Only Claude knows, once it has run (its
 * account's usage credits, a rate limit's cooldown), so this is said with the result, with
 * Claude's own reason, or its notice where it gave no reason (usage credits run out, which leaves
 * fast mode on in its result). Claude saying nothing is said too: relay cannot tell the turn ran fast.
 */
function ranSlower(report: Usage["speed_report"] | null): string | null {
  if (!report) return "fast was asked for, but Claude did not report the speed this turn ran at, so relay cannot tell that it ran fast.";
  const reason = report.fast_mode_disabled_reason;
  const said = [
    reason ? `Claude's reason: ${reason}, ${FAST_MODE_REASONS[reason] ?? "not one relay knows"}` : "",
    report.notice ? `Claude's notice: ${JSON.stringify(report.notice)}` : "",
  ].filter(Boolean);
  const why = said.length ? ` (${said.join("; ")})` : "";
  const cooldown = report.fast_mode_state === "cooldown";
  if (report.speed === "fast" || (report.speed === undefined && report.fast_mode_state === "on")) {
    // The notice says Claude refused a fast request and retried it at standard, whatever its result says.
    if (report.notice) return `fast was asked for, but Claude refused fast mode for this turn's requests and ran them at standard speed${report.speed === "fast" ? ", in part at least" : ""}${why}.`;
    return cooldown ? `fast was asked for, and Claude's fast mode went into cooldown after a rate limit, so part of this turn may have run at standard speed${why}.` : null;
  }
  return `fast was asked for, but Claude ran this turn at standard speed${cooldown ? ", its fast mode cooling down after a rate limit" : ""}${why}.`;
}

/**
 * What a Claude turn's preparation settled: the session id relay picked, the user's deny rules relay
 * copies in, the agent's environment, and the turn's private directory as it is on disk (`tmpDir`,
 * for the sandbox's rules; the environment may name it through relay's short link, native-temp.ts).
 */
interface ClaudePrep {
  newSessionId: string | undefined; deny: string[]; env: NodeJS.ProcessEnv; tmpDir: string;
  /** The Claude Code version this launch runs, as `--version` reports it (null: unreadable), for claudeSkillIsolation. */
  version?: readonly number[] | null;
  /** The turn's public-mode proxy, for a turn with the network (relay's own sandbox network for Claude, networkProxy). */
  proxy?: { port: number; token: string };
}

/**
 * Headless Claude Code: one `claude -p` process per turn, stream-json out, prompt on stdin.
 * Continuity comes from --session-id on the first turn and --resume afterwards.
 */
const claude = {
  prepare(spec: TurnSpec, tmpDir: string, agentTmp = tmpDir): ClaudePrep {
    assertNeverAdapter(spec);
    // The agent's environment, built and checked first (review C6): its endpoint is refused before anything else is.
    const env = agentEnv(spec, scrub, hostSession() ? ' Under the desktop app or another Agent SDK host, relay removes it itself where Claude signs in with its login ("child_auth": "login").' : "");
    // 2.1.302's Jj and fl gates: no silent fallback or same-model refusal retry.
    env.CLAUDE_CODE_DISABLE_REFUSAL_RETRY = "1";
    env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK = "1";
    // Claude measures CLAUDE_CODE_TMPDIR as given and resolves it only for its sandbox's allow list.
    env.TMPDIR = agentTmp;
    env.CLAUDE_CODE_TMPDIR = agentTmp;
    spec.checkEnvironment?.(env);
    const managed = managedSettings();
    if (managed && spec.neverPolicy && neverFloorApplies("claude", spec.config)) throw new Error("never: managed Claude settings can override the checked floor; this settings variant is unavailable. Use a qualified isolated settings route.");
    // Kept for a launch without a never policy (never-admission.ts screens nothing then); a floored
    // one was refused just above, whatever claude_managed_settings says.
    if (managed && spec.config.claude_managed_settings === "refuse") throw new Error(managedSettingsRefusal(managed));
    const unvetted = settingsEnvProblem(spec.config, managed);
    if (unvetted) throw new Error(unvetted);
    if (spec.config.claude_settings_env === "accept" && settingsEnvProblem({ ...spec.config, claude_settings_env: "refuse" }, managed)) spec.onWaived?.("claude_settings_env");
    // Under "inherit" Claude loads the user's settings, deny rules and all, by itself.
    const deny = spec.config.child_settings === "isolated" ? userDenyRules(env) : [];
    // The version gate's read (cli-version.ts), with the environment Claude is launched with. It
    // decides only whether relay leaves CLAUDE_KEPT_BUILTIN on; the init report is checked by its own.
    // A read that fails in any way counts as unreadable: the plugin is then disabled, the launch not refused here.
    let version: number[] | null = null;
    try { version = installedVersion("claude", spec.config.targets.claude.bin, env); } catch { version = null; }
    // Relay picks the session id up front so it is known before the process reports anything.
    return { newSessionId: spec.sessionId ? undefined : crypto.randomUUID(), deny, env, tmpDir, version };
  },

  invocation(spec: TurnSpec, prepared: ClaudePrep): Invocation {
    const cfg = spec.config;
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (spec.sessionId) args.push("--resume", spec.sessionId);
    else args.push("--session-id", prepared.newSessionId!);

    // MCP: the injected entry is named "relay", which replaces a user-level entry of that name.
    const server = spec.relay ? relayServerCommand(spec.relay) : null;
    const mcpFile = path.join(spec.dir, "claude-mcp.json");
    // A launch file that cannot be written refuses the turn, said as the write it was (storage.ts writing).
    writing(() => fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: server ? { relay: { type: "stdio", ...server } } : {} }, null, 2)));
    args.push("--mcp-config", mcpFile);
    if (cfg.child_mcp === "relay-only") args.push("--strict-mcp-config");

    // Only relay's own settings file (and any managed settings) applies, unless the user chose
    // otherwise. Claude merges allow rules, extra directories and allowed domains from every
    // settings file it loads into the sandbox, and reloads them while it runs, so a loaded file
    // is a way to widen a job: the user's by accident, or one the job writes into its worktree.
    if (cfg.child_settings === "isolated") args.push("--setting-sources", "");
    // The skills this turn was given come as a plugin of relay's own, for this session only, and
    // the init report is checked against it (claudeSkillsProblem). Nothing goes into the person's ~/.claude.
    if (spec.skills) args.push("--plugin-dir", spec.skills.dir);
    else args.push("--disable-slash-commands");
    // MCP auto-backgrounding off: a settings file's env (the user's under "inherit", an
    // organisation's) can set CLAUDE_AUTO_BACKGROUND_TASKS, which the environment scrub above does
    // not reach, and under -p it drops the agent's relay calls that run past two minutes (P-a). Zero
    // turns it off, by Claude Code's documentation (code.claude.com/docs/en/mcp, 2026-10-17; not
    // run), and this file outranks user, project and local settings; managed settings can still set it.
    const settings: Record<string, unknown> = { env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0", TMPDIR: prepared.env.TMPDIR, CLAUDE_CODE_TMPDIR: prepared.env.TMPDIR, CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1", CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1" } };
    // 2.1.302: bundled skills and the built-in plugins are separate. In inherited settings,
    // skillOverrides also hides user/repository skills without touching their source files.
    // The init report must contain exactly our package; new/managed/hidden roots fail closed.
    Object.assign(settings, claudeSkillIsolation(spec.cwd, prepared.env, prepared.version ?? null));
    if (!cfg.child_hooks) settings.disableAllHooks = true;
    // Speed, pinned on every turn: fast mode on only when asked for (relay's settings file is
    // Claude Code's flag settings, which outrank any settings of the person's that load, and a
    // fastMode there is also the opt-in a headless session needs), off otherwise.
    settings.fastMode = spec.speed === "fast";

    // With escalation, anything that would prompt is sent to relay's permission tool, which asks
    // the root session. Without it, such actions are denied on the spot.
    const { dangerous, ask, network, writePaths: extra } = turnPolicy(spec);
    const allowed: string[] = server ? ["mcp__relay"] : [];
    if (network) allowed.push("WebSearch", "WebFetch");
    // failIfUnavailable: without it, a sandbox that cannot start means commands run unsandboxed.
    const never = spec.neverPolicy && neverFloorApplies("claude", cfg) ? spec.neverPolicy : undefined;
    const sandbox: Record<string, unknown> = { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: never ? false : ask };
    // Without a grant, the sandbox's own network question would go nowhere: under -p Claude Code
    // answers it "user denied" at once and never sends it to the permission prompt tool (checked in
    // Claude Code 2.1.301). strictAllowlist has the sandbox refuse by itself, saying the host is not
    // on the allow list, so the agent is not told that a person refused.
    // With the network, every connection the sandbox's commands make goes to relay's proxy for the
    // turn (public mode, confine/proxy.ts), which reaches public addresses only: Claude Code's own
    // proxy, under allowedDomains ["*"], dials loopback and LAN addresses for them, and its deny
    // list cannot express a private range (relay 1.0.5; smoke/claude-network-probe.mjs checks it).
    // Both ports are relay's, or Claude Code starts its own proxy for the one left out. Local binding
    // and Unix sockets stay closed whatever other settings say (these outrank user settings under
    // child_settings "inherit"; a merged allowUnixSockets list is the residual).
    const closed = { allowLocalBinding: false, allowAllUnixSockets: false };
    if (network && !dangerous && !prepared.proxy) throw new Error("relay gives a Claude turn the network only through its own proxy, and none was opened for this turn");
    sandbox.network = network && prepared.proxy
      // strictAllowlist too: a Claude Code that ignored the external ports and started a proxy of its
      // own would then refuse every host by itself (no allowedDomains), not ask, which -p answers "denied".
      ? { httpProxyPort: prepared.proxy.port, socksProxyPort: prepared.proxy.port, strictAllowlist: true, ...closed }
      : { strictAllowlist: true, ...closed };
    if (network && prepared.proxy) {
      // The Claude process itself (its WebFetch, which runs outside the sandbox, and its model
      // requests) is pointed at the same proxy, with the turn's token. NO_PROXY is empty here and in
      // relay's settings, which outrank a user's settings env, but console-delivered settings relay
      // cannot see can still exempt hosts; the runtime check (claudeBackend.start) proves only that
      // some token request reached the model host through the proxy, not that every one did. SRT_DEBUG makes the
      // sandbox report the proxy ports it uses, which relay checks (claudeProxyReport).
      Object.assign(prepared.env, claudeProxyEnv(prepared.proxy));
      // The start of each response as it streams (message_start), where relay checks the proxy before a tool can run.
      args.push("--include-partial-messages");
      Object.assign(settings.env as Record<string, string>, { NO_PROXY: "", no_proxy: "" });
    }
    // Ask rules outrank the user's own allow rules. Sandboxed commands are unaffected.
    const askRules: string[] = [];
    if (ask) {
      args.push("--permission-prompt-tool", "mcp__relay__permission_prompt");
      // Without this, an allow rule in the user's settings (say Bash(git fetch:*)) would let a
      // matching command run outside the sandbox with no request.
      askRules.push("Bash");
    }
    // child_web "ask": the host's web tools need a grant or an approval, whatever the user's own
    // rules allow. (Where nothing can be asked, an ask rule amounts to a refusal.) So they do for a
    // turn given MCP servers, whose requests only the person can allow (docs/extensions.md).
    if ((cfg.child_web === "ask" || spec.extensionServers?.length) && !network) askRules.push("WebSearch", "WebFetch");
    // The user's deny rules outrank every allow and ask rule, relay's included.
    const userDeny = prepared.deny;
    // Relay's own deny rules for this turn: the edit tools' side of what the sandbox denies below.
    const denyRules: string[] = [];
    // Relay's control directory decides who may do what, and its config and the directories that
    // decide which API key relay hands a key-only target (core/api-keys.ts keyAuthority) whose
    // account that target runs on. No job may write there, whatever else it is given: a grant
    // the session keeps from before relay refused one over them included.
    const keyDirs = keyAuthority().dirs.flatMap(([, d]) => (fs.existsSync(d) ? [d, fs.realpathSync(d)] : [d]));
    // And what relay runs outside any sandbox, and its PATH (protected-config.ts relayWriteProtected; review r_0c11d860 X1).
    const codexPaths = relayCodexProtected(spec.config);
    const protectedDirs = [...new Set([fs.realpathSync(relayHome()), privateStateRoot(), ...configProtection().paths, ...keyDirs, ...relayWriteProtected().map((x) => x.path), ...codexPaths.homes.map((x) => x.path), ...codexPaths.stores.map((x) => x.path)])];
    const privatePattern = privateStateRoot().replace(/([*?[\]{}!\\])/g, "\\$1");
    denyRules.push(`Edit(/${privatePattern})`, `Edit(/${privatePattern}/**)`);
    // A path git reports for the turn's directory: in a job's worktree with the git directory the
    // repository records for it (spec.gitEnv), never through the worktree's own `.git` file.
    const gitPath = (flag: string): string | null => {
      const r = git(spec.cwd, ["rev-parse", flag], spec.gitEnv);
      if (!r.ok || !r.out) return null;
      try {
        return fs.realpathSync(path.resolve(spec.cwd, r.out));
      } catch {
        return null;
      }
    };

    if (dangerous) {
      args.push("--dangerously-skip-permissions");
    } else if (spec.access === "write") {
      // Edits are auto-approved inside cwd (the worktree); Bash runs inside the OS sandbox.
      args.push("--permission-mode", "acceptEdits", "--tools", toolsFor(spec).join(","));
      if (!ask) args.push("--permission-prompts", "none");
      // In the worktree itself, its `.git` file (which tells git where the repository is) and relay's
      // identity directory: nothing in the job's work changes either, and relay reads both.
      const top = spec.gitEnv?.GIT_WORK_TREE ?? gitPath("--show-toplevel");
      // And the harness and developer-tool configuration that relay's own sandbox denies at the top
      // of each writable root (confine/seatbelt.ts HARNESS_CONFIG): here the worktree and each granted
      // directory, only at their top, as there. Claude Code 2.1.303 protects its own `.claude`
      // settings, `.mcp.json` and git's internals by itself, but not `.codex`, `.agents`, `.gemini` or
      // `.aws`, nor `.envrc` from the shell; a job's branch would carry what it planted there into the
      // person's own agents once merged. On macOS each plain denyWrite path becomes
      // `(deny file-write* (subpath P))`, which refuses creating a missing P too.
      const configRoots = [top ?? fs.realpathSync(spec.cwd), ...extra];
      const guarded = [...new Set([
        ...(top ? [path.join(top, ".git"), path.join(top, CONTEXT_DIR)] : []),
        ...configRoots.flatMap((root) => HARNESS_CONFIG.map((name) => path.join(root, name))),
      ])];
      sandbox.filesystem = { denyWrite: [...protectedDirs, ...guarded], allowWrite: [prepared.tmpDir, ...extra] };
      // The sandbox governs the shell; the edit tools follow permission rules ("//" starts an absolute
      // path; a directory's name is escaped, so a granted one with `[` in it matches only itself).
      for (const p of guarded) {
        const escaped = p.replace(/([*?[\]{}!\\])/g, "\\$1");
        denyRules.push(`Edit(/${escaped})`, `Edit(/${escaped}/**)`);
      }
      // The sandbox governs shell writes; --add-dir extends where the edit tools are auto-approved.
      if (extra.length) args.push("--add-dir", ...extra);
      settings.sandbox = sandbox;
    } else {
      // Read-only: the editing tools are absent. Bash runs in the OS sandbox with writes to the
      // working directory and the repository's git directories denied, so the agent can run tests
      // and inspect history without changing anything. The web tools are present; whether a given
      // search or fetch runs is decided by the user's own rules, a network grant, or a request.
      args.push("--permission-mode", ask ? "manual" : "dontAsk", "--tools", toolsFor(spec).join(","));
      const deny = new Set([fs.realpathSync(spec.cwd), ...protectedDirs]);
      for (const flag of ["--show-toplevel", "--git-common-dir", "--git-dir"]) {
        const p = gitPath(flag);
        if (p) deny.add(p);
      }
      sandbox.filesystem = { denyWrite: [...deny], allowWrite: [prepared.tmpDir] };
      settings.sandbox = sandbox;
    }
    if (spec.reviewReadDeny?.length && spec.access === "read" && !dangerous) {
      // Both layers are needed: denyRead restricts Bash's subprocesses; Read deny rules cover
      // Claude's built-in file tools. Only the independent review turn gets these extra denies.
      // https://code.claude.com/docs/en/sandboxing#configure-sandboxing
      // https://code.claude.com/docs/en/permissions#read-and-edit
      const configHome = path.resolve(prepared.env.CLAUDE_CONFIG_DIR || path.join(prepared.env.HOME || os.homedir(), ".claude"));
      const real = (dir: string) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
      const homes = spec.reviewReadDeny;
      // Same-family reviewers share their caller's config home. Keep their own tool results,
      // shell snapshots, skills, plugins and memory readable while denying conversation stores.
      // JSONL globs include subagent transcripts and orphaned/superseded session copies.
      // https://code.claude.com/docs/en/claude-directory#application-data
      const conversation = ["projects/**/*.jsonl*", "projects/**/sessions-index.json", "history.jsonl", "debug", "paste-cache", "feedback-bundles", "feedback/drafts", "usage-data"];
      const readDenies = homes.flatMap((home) => {
        // Permission paths use // for absolute paths and gitignore patterns, unlike denyRead.
        const escaped = home.replace(/([*?[\]{}!\\])/g, "\\$1");
        const suffixes = real(home) === real(configHome) ? conversation : [""];
        for (const suffix of suffixes) {
          const pattern = path.join(escaped, suffix);
          denyRules.push(`Read(/${pattern})`, `Read(/${pattern}/**)`);
        }
        return suffixes.map((suffix) => path.join(home, suffix));
      });
      (sandbox.filesystem as Record<string, unknown>).denyRead = readDenies;
    }
    if (!dangerous) {
      // Nor may a Claude turn read the API key relay hands a key-only target: the default key
      // directory and a key file the local config moves elsewhere (core/api-keys.ts keyPathsToDeny,
      // which relay's own sandbox denies to every agent it confines). Both layers, as above: the
      // sandbox for the shell, Read deny rules for Claude's file tools. Relay does not hand Claude
      // the key; this keeps a turn steered by what it reads from taking it. Relay's Codex permission
      // profile reads everything, so a Codex turn still can (docs/gemini.md §2.6).
      const keyReads = [...new Set(keyPathsToDeny().flatMap((p) => (fs.existsSync(p) ? [p, fs.realpathSync(p)] : [p])))];
      // Nor relay's sockets directory (confine/sockets.ts), where a confined turn's broker keeps the
      // file its own tool helper reads the turn's secret from (Gemini's tool discovery, Broker.secretFile);
      // relay's sandbox denies the directory to every other turn. The secret alone gets nothing: the
      // broker serves only its turn's own process tree. Only the sockets directory, not all of relay's
      // private root, whose temp directories Claude's own turns use.
      const sockets = relaySocketsDir();
      const reads = [...keyReads, sockets, ...relayCredentialProtected(spec.config).map((p) => p.path)];
      const filesystem = sandbox.filesystem as Record<string, unknown>;
      filesystem.denyRead = [...new Set([...((filesystem.denyRead as string[] | undefined) ?? []), ...reads])];
      for (const p of reads) {
        const escaped = p.replace(/([*?[\]{}!\\])/g, "\\$1");
        denyRules.push(`Read(/${escaped})`, `Read(/${escaped}/**)`);
      }
    }
    // Relay's MCP definitions may hold credentials, which an agent with the network could use past
    // relay's gate: no launched Claude agent reads them, by any name of the file (docs/extensions.md).
    // Both layers again: the sandbox for Bash, a Read rule for Claude's own file tools.
    const secrets = dangerous ? [] : mcpFileNames();
    if (secrets.length) {
      for (const f of secrets) denyRules.push(`Read(/${f.replace(/([*?[\]{}!\\])/g, "\\$1")})`);
      const filesystem = sandbox.filesystem as Record<string, unknown>;
      filesystem.denyRead = [...((filesystem.denyRead as string[] | undefined) ?? []), ...secrets];
    }
    if (never) applyClaudeNeverPolicy(never, sandbox, denyRules);
    const allDeny = [...userDeny, ...denyRules];
    if (askRules.length || allDeny.length) settings.permissions = { ...(allDeny.length ? { deny: allDeny } : {}), ...(askRules.length ? { ask: askRules } : {}) };
    if (allowed.length && !dangerous) args.push("--allowedTools", ...allowed);

    const settingsFile = path.join(spec.dir, "claude-settings.json");
    writing(() => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)));
    args.push("--settings", settingsFile);

    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("--effort", spec.effort);
    return { command: cfg.targets.claude.bin, args, env: prepared.env };
  },

  onEvent(event: Record<string, unknown>, state: StreamState, spec: TurnSpec): void {
    if (event.type === "system" && event.subtype === "notification") {
      // Kept for the turn's speed report: the result does not say that Claude refused fast mode and ran at standard.
      if (event.key === OVERAGE_NOTICE && typeof event.text === "string" && event.text) state.speedNotices = [...(state.speedNotices ?? []), event.text.slice(0, 200)];
    } else if (event.type === "system" && event.subtype === "init") {
      if (typeof event.session_id === "string") state.sessionId = event.session_id;
      const problem = initProblem(event, spec);
      if (problem) state.refuse = `${problem}. Relay stopped it before it did anything.`;
    } else if (event.type === "assistant") {
      const refusal = anthropicRefusal(event);
      if (refusal) {
        state.refusal = refusal;
        state.ended = true;
        return;
      }
      // What it is doing now: its latest tool call.
      const content = (event.message as { content?: unknown } | undefined)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        const text = activityOf(block.name, (block.input ?? {}) as Record<string, unknown>);
        if (text) spec.onActivity?.(text);
      }
    } else if (event.type === "result") {
      // Claude 2.1.303 print mode with closed stdin holds normal results while local_agent
      // tasks run (bundled ig.route/Kk); shell tasks can outlive a result, but streamTurn
      // already waits for CLI exit and its native wind-down. Do not infer unfinished agents
      // from the result alone. Source/event details: docs/research/native-subagent-lifecycle.md.
      state.ended = true;
      // Source-evidenced in Claude Code 2.1.302's Kte/common result builders and SDK
      // result schemas; NOT observed in a live refusal. subtype success/is_error alone is
      // insufficient: a safety stop is a normal API response with stop_reason refusal.
      const refusal = anthropicRefusal(event);
      if (refusal) state.refusal = { ...refusal, message: refusal.message || state.refusal?.message || "" };
      const report = speedReport(event, state.speedNotices);
      const usage = usageFrom(event.usage, {
        ...(typeof event.total_cost_usd === "number" ? { cost_usd: event.total_cost_usd } : {}),
        ...(typeof event.num_turns === "number" ? { agent_steps: event.num_turns } : {}),
        // With the speed relay asked for, so that status pairs a report with the request it answers (views.ts speedView).
        ...(report ? { speed_report: report, speed_requested: spec.speed ?? "standard" } : {}),
      });
      const slower = spec.speed === "fast" ? ranSlower(report) : null;
      if (slower) state.speedWarnings = [...(state.speedWarnings ?? []), slower];
      if (usage) spec.onUsage?.(usage);
      if (typeof event.session_id === "string") state.sessionId = event.session_id;
      // Every permission Claude was refused in the turn, by a rule, its permission mode, or relay's answer to its prompt.
      if (Array.isArray(event.permission_denials) && event.permission_denials.length) {
        state.denials = (event.permission_denials as { tool_name?: unknown; tool_input?: unknown }[]).map((d) => {
          const tool = String(d?.tool_name ?? "a tool");
          return activityOf(tool, (d?.tool_input ?? {}) as Record<string, unknown>) ?? tool;
        });
      }
      if (event.is_error || event.subtype !== "success") {
        const errors = Array.isArray(event.errors) ? event.errors.join("; ") : "";
        state.failed = `claude reported ${String(event.subtype)}${errors ? `: ${errors}` : ""}${typeof event.result === "string" ? `: ${event.result}` : ""}`;
      } else {
        state.finalMessage = typeof event.result === "string" ? event.result : "";
        state.completed = true;
      }
    }
  },
};
/** The proxy variables a network turn's Claude process gets: everything pointed at the turn's proxy, with its token, nothing exempt in these variables (settings relay cannot see may still exempt hosts), and the sandbox's report of its proxy ports on stderr. */
export function claudeProxyEnv(proxy: { port: number; token: string }): Record<string, string> {
  const url = `http://relay:${proxy.token}@127.0.0.1:${proxy.port}`;
  const env: Record<string, string> = { NO_PROXY: "", no_proxy: "", SRT_DEBUG: "1" };
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) env[k] = env[k.toLowerCase()] = url;
  return env;
}

/** The proxy variables that point a process at another proxy (NO_PROXY alone does not). */
const UPSTREAM_PROXY = /^(https?|all)_proxy$/i;

/**
 * What Claude Code's sandbox reports, under SRT_DEBUG, about the proxy it uses: with external ports,
 * one line for each, as it starts its sandbox (Claude Code 2.1.309, which does so after reading its
 * prompt and before its first model request). `seen` takes each stderr line and answers "other" when
 * a port named is not relay's (settings relay does not control replaced it), which stops the turn at
 * once; `confirmed` is true once both ports named are relay's, which must be so by Claude's first
 * message, or the turn is stopped then (claudeBackend). A Claude Code that no longer reports this
 * fails closed the same way.
 */
export function claudeProxyReport(port: number): { seen(line: string): "other" | null; confirmed(): boolean } {
  const seen = { HTTP: false, SOCKS: false };
  return {
    seen(line) {
      const m = /^\[SandboxDebug\] Using external (HTTP|SOCKS) proxy on port (\d+)$/.exec(line.trim());
      if (!m) return null;
      if (Number(m[2]) !== port) return "other";
      seen[m[1] as "HTTP" | "SOCKS"] = true;
      return null;
    },
    confirmed: () => seen.HTTP && seen.SOCKS,
  };
}

/** The refusal when the sandbox reports a proxy port other than relay's. */
export const CLAUDE_OTHER_PROXY =
  "Claude Code's sandbox reported a proxy port other than relay's for this turn: settings relay does not control replaced relay's sandbox network settings. " +
  "Relay gives a Claude job the network only through its own proxy, so it stopped the job";
/** The refusal when the sandbox has not confirmed relay's ports by Claude's first message. */
export const CLAUDE_UNCONFIRMED =
  "Claude Code did not confirm that its sandbox sends every connection through relay's proxy for this turn (it reports its proxy ports as it starts its sandbox, when SRT_DEBUG is set). " +
  "Settings relay does not control may have replaced relay's sandbox network settings, or this Claude Code version reports them differently. Relay gives a Claude job the network only through that proxy, " +
  "so it stopped the job at its first message. Run the job without the network, or check this Claude Code version with smoke/claude-network-probe.mjs (README, Development)";

/** The refusal when Claude's model traffic did not reach the turn's proxy by its first response. */
export const CLAUDE_UNPROXIED =
  "Claude Code's model requests did not go through relay's proxy for this turn (no request carrying the turn's token named the model endpoint before Claude's first response): settings relay does not control may have replaced its HTTPS_PROXY or NO_PROXY. " +
  "With the network granted, WebFetch, which goes the same way, could then reach this machine and its local network, so relay stopped the job";

/**
 * The hosts Claude's model requests go to, by the provider in the environment relay passes:
 * Anthropic's API, unless CLAUDE_CODE_USE_BEDROCK or CLAUDE_CODE_USE_VERTEX picks Amazon Bedrock or
 * Google Vertex AI. Relay refuses another endpoint (ANTHROPIC_BASE_URL and the like) before this. A
 * provider relay does not know (another CLAUDE_CODE_USE_*) leaves it unable to check the model
 * traffic, and so refuses the network: `{ problem }`.
 */
export function claudeModelHosts(env: NodeJS.ProcessEnv): { name: string; test(host: string): boolean } | { problem: string } {
  const on = (k: string) => Boolean(env[k]) && !/^(0|false|no|off)$/i.test(env[k]!.trim());
  const providers = Object.keys(env).filter((k) => /^CLAUDE_CODE_USE_/.test(k) && on(k)).sort();
  if (!providers.length) return { name: "api.anthropic.com", test: (h) => h === "api.anthropic.com" };
  if (providers.length === 1 && providers[0] === "CLAUDE_CODE_USE_BEDROCK") return { name: "Amazon Bedrock's runtime endpoint", test: (h) => /^bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/.test(h) };
  if (providers.length === 1 && providers[0] === "CLAUDE_CODE_USE_VERTEX") return { name: "Google Vertex AI's endpoint", test: (h) => /^([a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(h) };
  return { problem: `the environment relay passes to Claude sets ${providers.join(", ")}, a model provider whose endpoint relay does not know, so it could not check that Claude's model traffic, and its WebFetch with it, goes through relay's proxy. Relay does not give this job the network` };
}

/**
 * Development only: the stub model relay's own smoke probe and tests serve Claude's model requests
 * from, through the turn's proxy (ProxyOptions.modelStub), so that they pass relay's check of the
 * model traffic like real ones. Off unless relay's own environment sets RELAY_DEV_MODEL_STUB=1, which
 * relay's smoke and test launchers do and a launched job cannot (it sets nothing in the root's or the
 * worker's environment); with the flag, read from dev/claude-model-stub.json ({ "host", "port" }) in
 * a relay home that is not relay's default. With the flag set, a file that is malformed, or names a
 * port nothing listens on (left from an earlier run), refuses the turn; without it the file is ignored.
 */
export async function devModelStub(): Promise<{ host: string; port: number } | undefined> {
  if (process.env.RELAY_DEV_MODEL_STUB !== "1") return undefined;
  const home = relayHome();
  if (!process.env.RELAY_HOME || path.resolve(home) === path.join(os.homedir(), ".local", "state", "relay")) {
    throw new Error("RELAY_DEV_MODEL_STUB is set, but relay runs in its default state directory: the development model stub is for a scratch RELAY_HOME only");
  }
  const file = path.join(home, "dev", "claude-model-stub.json");
  if (!fs.existsSync(file)) return undefined;
  let v: { host?: unknown; port?: unknown };
  try {
    v = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`RELAY_DEV_MODEL_STUB: ${file} could not be read as JSON (${(e as Error).message})`);
  }
  if (typeof v.host !== "string" || !/^[a-z0-9.-]+$/.test(v.host) || !Number.isInteger(v.port)) throw new Error(`RELAY_DEV_MODEL_STUB: ${file} must hold { "host": "<host name>", "port": <number> }`);
  const port = v.port as number;
  const live = await new Promise<boolean>((resolve) => {
    const c = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => (c.destroy(), resolve(ok));
    c.setTimeout(2000, () => done(false));
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
  });
  if (!live) throw new Error(`RELAY_DEV_MODEL_STUB: nothing listens on 127.0.0.1:${port}, the stub ${file} names (left from an earlier run?)`);
  return { host: v.host, port };
}

/**
 * A network turn's proxy (public mode), opened before the turn starts, with the test for the hosts
 * Claude's model requests go to, or null for a turn without the network or with full access (whose
 * sandbox is off). Refused here: a proxy in the environment relay passes to Claude (relay's proxy
 * would have to go through it, which would resolve names where relay cannot check them), a model
 * provider relay does not know, and managed settings on disk that would take the job around
 * relay's proxy.
 */
export async function networkProxy(spec: TurnSpec, env: NodeJS.ProcessEnv): Promise<{ proxy: TurnProxy; model: { name: string; test(host: string): boolean } } | null> {
  const { dangerous, network } = turnPolicy(spec);
  if (!network || dangerous) return null;
  const upstream = Object.keys(env).filter((k) => UPSTREAM_PROXY.test(k) && env[k]).sort();
  if (upstream.length) {
    throw new Error(
      `the environment relay passes to Claude sets ${upstream.join(", ")}. A Claude job with the network reaches the web only through relay's own proxy, which checks every address it connects to; ` +
        "behind another proxy, that proxy would resolve the names relay checks, so relay does not give this job the network. Run it without the network, or leave the proxy out of the environment relay passes to Claude (child_env)",
    );
  }
  const stub = await devModelStub();
  const model = stub ? { name: stub.host, test: (h: string) => h === stub.host } : claudeModelHosts(env);
  if ("problem" in model) throw new Error(model.problem);
  const managed = managedNetworkProblem();
  if (managed) throw new Error(managed);
  const proxy = await openTurnProxy({ neverPolicy: spec.neverPolicy, mode: "public", allow: [], logFile: path.join(spec.dir, "proxy.jsonl"), label: `${spec.markers.nodeId}/${spec.relay?.turnId ?? spec.turnId ?? "-"}`, ...(stub ? { modelStub: stub } : {}) });
  return { proxy, model };
}

export const claudeBackend: Backend = {
  start: async (spec) => nativeTemp(spec, async (tmpDir, agentTmp) => {
    const prepared = claude.prepare(spec, tmpDir, agentTmp);
    const net = await networkProxy(spec, prepared.env);
    const proxy = net?.proxy;
    try {
      if (proxy) prepared.proxy = { port: proxy.port, token: proxy.token };
      const invocation = claude.invocation(spec, prepared);
      turnPolicy(spec); // Last check, after settings and git discovery, immediately before spawn.
      if (!net || !proxy) return streamTurn(spec, { invocation, onEvent: claude.onEvent });
      // At the start of Claude's first response (message_start, from --include-partial-messages),
      // before any tool in it can run, relay requires that the sandbox has reported relay's proxy
      // ports, and that the Claude process has sent at least one request carrying the turn's token to
      // the model host through relay's proxy; else the turn is stopped. The first assistant message
      // is the backstop for a Claude Code that does not stream partial messages.
      // What this proves: the Claude process uses relay's proxy variables, and NO_PROXY does not
      // cover the model host. What it does not prove: that the model requests themselves, or
      // WebFetch, went through the proxy. Claude also sends other requests to the model host at
      // start, and a request is not visible inside TLS (smoke --control collision shows the case).
      // Settings relay cannot see (delivered from the claude.ai console: a managed ANTHROPIC_BASE_URL
      // with a NO_PROXY for its host, a NO_PROXY listing local ranges) can send model requests or
      // WebFetch around the proxy while other traffic stays on it; they are outside what relay
      // guarantees (docs/known-limits.md). Managed settings on disk are refused above.
      const report = claudeProxyReport(proxy.port);
      let checked = false;
      const check = (state: StreamState) => {
        checked = true;
        if (!report.confirmed()) state.stop ??= `${CLAUDE_UNCONFIRMED}.`;
        else if (![...proxy.tokenHosts()].some(net.model.test)) state.stop ??= `${CLAUDE_UNPROXIED} (expected a request to ${net.model.name}).`;
      };
      const onEvent: typeof claude.onEvent = (event, state, s) => {
        const first = event.type === "assistant" || (event.type === "stream_event" && (event.event as { type?: unknown } | undefined)?.type === "message_start");
        if (!checked && first) {
          check(state);
          if (state.stop) return;
        }
        claude.onEvent(event, state, s);
      };
      const onStderr = (line: string, state: StreamState) => {
        if (report.seen(line) === "other") state.stop ??= `${CLAUDE_OTHER_PROXY}.`;
      };
      // The partial messages' token deltas stay out of the agent log; their message_start is kept.
      const unlogged = (event: Record<string, unknown>) => event.type === "stream_event" && (event.event as { type?: unknown } | undefined)?.type !== "message_start";
      const handle = streamTurn(spec, { invocation, onEvent, onStderr, unlogged });
      return afterTurn(handle, async (result) => (await proxy.close(), result));
    } catch (error) {
      await proxy?.close();
      throw error;
    }
  }),
};
