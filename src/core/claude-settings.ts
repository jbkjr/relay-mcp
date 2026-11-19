// What relay reads from Claude Code's settings to tell whether a person's answer can be established
// in a Claude Code session: `permissions.defaultMode`, and the matchers of the
// hook groups of the events whose hooks can answer for the person (PreToolUse and PermissionRequest
// for relay's confirm tool, Elicitation and ElicitationResult for its approval dialog). Nothing else
// is read or kept: not the hooks' commands, and not the rest of the file. The values are taken out
// of each settings file by key path with macOS's plutil, so relay's process never holds the rest
// (a settings file's `env`, in particular, can carry credentials). Subagent definitions are checked
// separately by a conservative scan of their leading frontmatter block, without reading the body.
// Plugin JSON and skill frontmatter are checked as additional hook sources below.
// Doctor also extracts just crossSessionInbound to report observed inbox controls and their sources.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "./git.js";
import type { RelayConfig } from "./config.js";

/** Where an organisation's managed Claude Code settings live. Relay cannot see settings delivered from the claude.ai console. */
export function managedSettingsPaths(): string[] {
  const user = os.userInfo().username;
  return [
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/Library/Application Support/ClaudeCode/managed-settings.d",
    "/Library/Managed Preferences/com.anthropic.claudecode.plist",
    `/Library/Managed Preferences/${user}/com.anthropic.claudecode.plist`,
    "/etc/claude-code/managed-settings.json",
    "/etc/claude-code/managed-settings.d",
  ];
}

/** The first managed settings location present on disk, or null. */
export function managedSettings(): string | null {
  return managedSettingsPaths().find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Doctor's reason relay refuses every Claude launch on a machine with organisation-managed
 * settings. `floored`: the never floor binds Claude's jobs (core/never-coverage.ts; always, since
 * 1.1.4), and then claude_managed_settings changes nothing (backends/claude.ts prepare refuses).
 * Otherwise only its "refuse" refuses, and "accept" launches only what the floor does not bind.
 */
export function managedSettingsProblem(managed: string, floored: boolean): string {
  return floored
    ? `this machine has organisation-managed Claude Code settings (${managed}), which can override the never floor Claude jobs get, whatever claude_managed_settings says ("accept" does not permit them)`
    : `this machine has organisation-managed Claude Code settings (${managed}), and claude_managed_settings is "refuse"; "accept" would launch only Claude work the never floor does not bind`;
}

/**
 * The backend's refusal under claude_managed_settings "refuse", reached only by a launch without
 * relay's never floor (one with no never policy: registry launches always carry it, and are refused
 * before this whatever the setting says), so its advice to accept is conditional.
 */
export function managedSettingsRefusal(managed: string): string {
  return `this machine has organisation-managed Claude Code settings (${managed}). They outrank the settings relay passes, so relay cannot tell whether its confinement holds, and it does not launch Claude. ` +
    '"claude_managed_settings": "accept" launches only on a route without relay\'s never floor; relay\'s own Claude jobs carry the floor and are refused on this machine whatever that setting says.';
}

/**
 * Why Claude must not be launched because settings relay does not vet would load, or null. A
 * settings file's `env` sets variables for the session after relay has checked the environment it
 * passes, so such a file can point Claude at another endpoint (ANTHROPIC_BASE_URL) where relay's
 * endpoint check never sees it, and relay does not read those files (they may hold credentials).
 * With only relay's own settings (child_settings "isolated", no managed settings on disk) nothing
 * can; otherwise relay refuses unless claude_settings_env is "accept", which leaves the reported
 * model as the only evidence of which family answers.
 */
export function settingsEnvProblem(cfg: Pick<RelayConfig, "child_settings" | "claude_settings_env">, managed: string | null): string | null {
  if (cfg.claude_settings_env === "accept") return null;
  const sources = [
    ...(cfg.child_settings === "inherit" ? ['your user, project and local Claude Code settings (child_settings "inherit")'] : []),
    ...(managed ? [`organisation-managed settings (${managed})`] : []),
  ];
  if (!sources.length) return null;
  return `a launched Claude agent would load ${sources.join(" and ")}, whose env can point Claude Code at another endpoint than Anthropic's after relay has checked its environment, so relay could not tell which family of model answers. ` +
    'Relay reaches other families only, so it does not launch Claude this way. Use child_settings "isolated", or set "claude_settings_env": "accept" in relay\'s config to launch anyway, relying on the model Claude reports.';
}

/**
 * The name relay's installer registers its server under in Claude Code (`claude mcp add relay`), and
 * so the names hooks see: Elicitation hooks match on the server's name, tool hooks on the tool's.
 */
export const RELAY_SERVER = "relay";
export const CONFIRM_TOOL = `mcp__${RELAY_SERVER}__confirm`;
export const ADOPT_TOOL = `mcp__${RELAY_SERVER}__adopt`;

/**
 * Hook events whose hooks can answer for the person, and the name each event's matcher is tested
 * against for relay (Claude Code's hooks documentation): a PreToolUse hook can allow a tool call
 * without the permission prompt and a PermissionRequest hook can answer that prompt, so either,
 * where it matches relay's confirm tool, can let confirm through without the person. An
 * Elicitation hook can answer an MCP elicitation before any dialog is shown, and an
 * ElicitationResult hook can change the answer the person gave; both match on the server's name.
 */
export const ANSWERING_HOOKS = {
  confirm: [["PreToolUse", CONFIRM_TOOL], ["PermissionRequest", CONFIRM_TOOL], ["PreToolUse", ADOPT_TOOL], ["PermissionRequest", ADOPT_TOOL]],
  dialog: [["Elicitation", RELAY_SERVER], ["ElicitationResult", RELAY_SERVER]],
} as const;

/**
 * Whether a hook matcher can match `name`, as Claude Code evaluates matchers: absent, empty or "*"
 * matches everything; one made only of letters, digits, "_", "-", spaces, "," and "|" is a list of
 * exact names separated by "|" or ","; anything else is an unanchored JavaScript regular
 * expression. A matcher that is not text, or a regular expression that does not compile, counts as
 * matching: relay fails closed.
 */
export function matcherMatches(matcher: string | null | undefined, name: string): boolean {
  if (matcher === null || matcher === undefined || matcher === "" || matcher === "*") return true;
  if (/^[A-Za-z0-9_\- ,|]*$/.test(matcher)) return matcher.split(/[|,]/).map((m) => m.trim()).includes(name);
  try {
    return new RegExp(matcher).test(name);
  } catch {
    return true;
  }
}

/**
 * Why a session with some settings cannot take an answer as the person's, for each of the two ways
 * relay asks: `dialog`, its approval dialog (MCP elicitation); `confirm`, its confirm tool (the
 * host's permission prompt). Null where nothing found stands in the way.
 */
export interface Consent {
  dialog: string | null;
  confirm: string | null;
}

/**
 * Permission modes under which Claude Code still puts a tool marked for user interaction to the
 * person, or refuses it. bypassPermissions skips the prompt; any other value relay does not know
 * is treated the same way.
 */
const PROMPTING_MODES: ReadonlySet<string> = new Set(["default", "acceptEdits", "plan", "auto", "dontAsk"]);

const PLUTIL = "/usr/bin/plutil";

/** A settings source: a file, or JSON given inline on a command line. */
export type SettingsSource = { file: string } | { inline: string; label: string };

const labelOf = (s: SettingsSource) => ("file" in s ? s.file : s.label);

/**
 * One key path's value from a source, as plutil prints it raw (an array prints its length). With
 * `expect`, a value of another type is "unreadable".
 */
function extract(src: SettingsSource, keyPath: string, expect?: "array" | "string"): { value: string } | "absent" | "unreadable" {
  const r = spawnSync(PLUTIL, ["-extract", keyPath, "raw", ...(expect ? ["-expect", expect] : []), "-o", "-", "file" in src ? src.file : "-"], {
    input: "inline" in src ? src.inline : undefined,
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
  });
  if (r.status === 0) return { value: r.stdout.replace(/\n$/, "") };
  if (r.status === 1 && /No value at that key path/.test(r.stderr ?? "")) return "absent";
  return "unreadable";
}

/**
 * Why answers in a session with these settings may not be the person's, for the dialog and for
 * confirm (see Consent): the default mode skips permission prompts (or is not one relay knows),
 * which stands in the way of both; or a hook that can answer for the person matches relay (see
 * ANSWERING_HOOKS). A hook that matches only other tools or servers (a PreToolUse hook on an email
 * tool, say) is no obstacle. Whatever relay cannot read is taken to stand in the way: it fails closed.
 */
export function answeredWithoutPerson(src: SettingsSource): Consent {
  const label = labelOf(src);
  const unreadable = `relay could not read the Claude Code settings in ${label}`;
  const mode = extract(src, "permissions.defaultMode");
  if (mode === "unreadable") return { dialog: unreadable, confirm: unreadable };
  if (mode !== "absent" && !PROMPTING_MODES.has(mode.value)) {
    const why = `the Claude Code settings in ${label} set permissions.defaultMode ${JSON.stringify(mode.value.slice(0, 40))}, which skips permission prompts or is not a mode relay knows`;
    return { dialog: why, confirm: why };
  }
  const hooked = (events: readonly (readonly [string, string])[]): string | null => {
    for (const [event, name] of events) {
      const groups = extract(src, `hooks.${event}`, "array");
      if (groups === "unreadable") return unreadable;
      if (groups === "absent") continue;
      for (let i = 0; i < Number(groups.value); i++) {
        const m = extract(src, `hooks.${event}.${i}.matcher`, "string");
        if (m === "unreadable") return `the Claude Code settings in ${label} have ${event} hooks whose matcher relay could not read, which may answer for you`;
        const matcher = m === "absent" ? null : m.value;
        if (matcherMatches(matcher, name)) {
          return `the Claude Code settings in ${label} have ${event} hooks ${matcher === null || matcher === "" || matcher === "*" ? "for everything" : `matching ${JSON.stringify(matcher.slice(0, 60))}`}, which can answer for you ${name === RELAY_SERVER ? `in relay's approval dialog` : `in the permission prompt for relay's ${name === ADOPT_TOOL ? "adopt" : "confirm"}`}`;
        }
      }
    }
    return null;
  };
  return { dialog: hooked(ANSWERING_HOOKS.dialog), confirm: hooked(ANSWERING_HOOKS.confirm) };
}

/**
 * The directories whose `.claude/settings.local.json` Claude Code may read for a session started in
 * `cwd`: since 2.1.211 it keeps that file at the git repository's root, and in a linked worktree at
 * the main checkout's root, and it still reads a copy an earlier version left in the starting
 * directory (https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository).
 * Relay reads all of them, whichever Claude Code would pick (it keeps the file in the starting
 * directory under some ownership and home-directory conditions). Where git cannot say, the
 * starting directory only, as before.
 */
export function localSettingsDirs(cwd: string): string[] {
  const dirs = [cwd];
  // Both answers from one git where it gives both, one line each; otherwise (outside a work tree,
  // a name with a line break in it) each asked on its own, as git answers it alone.
  const both = git(cwd, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"]);
  const lines = both.ok ? both.raw.split("\n") : [];
  const [top, common] = lines.length === 3 && !lines[2] && lines[0].trim() && lines[1].trim()
    ? [lines[0].trim(), lines[1].trim()]
    : [git(cwd, ["rev-parse", "--show-toplevel"]), git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])].map((r) => (r.ok ? r.out : ""));
  if (top) dirs.push(top);
  if (common) dirs.push(path.dirname(common));
  return [...new Set(dirs)];
}

/**
 * The settings files Claude Code reads for a session started in `cwd`: the user's (in
 * CLAUDE_CONFIG_DIR when set, and in ~/.claude), the project's and the local ones (see
 * localSettingsDirs), and the managed ones given (a managed-settings.d directory contributes its
 * JSON files). Only those present.
 */
export function settingsFiles(env: NodeJS.ProcessEnv, cwd: string, managed: readonly string[], localDirs: readonly string[] = localSettingsDirs(cwd)): string[] {
  const home = env.HOME || os.homedir();
  const candidates = [
    ...(env.CLAUDE_CONFIG_DIR ? [path.join(env.CLAUDE_CONFIG_DIR, "settings.json")] : []),
    path.join(home, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    ...localDirs.map((d) => path.join(d, ".claude", "settings.local.json")),
  ];
  candidates.push(...managedFiles(managed));
  return [...new Set(candidates)].filter((p) => fs.existsSync(p));
}

/**
 * The managed settings files among `managed` that are on disk: a managed-settings.d directory
 * contributes its JSON files, and one relay cannot list counts as a file, so that reading it fails.
 */
export function managedFiles(managed: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of managed) {
    let dir = false;
    try {
      dir = fs.statSync(m).isDirectory();
    } catch {
      continue;
    }
    if (dir) {
      try {
        out.push(...fs.readdirSync(m).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(m, f)));
      } catch {
        // An unreadable directory: a source relay cannot read, so it counts as answering.
        out.push(m);
      }
    } else out.push(m);
  }
  return out;
}

/**
 * Managed settings that would take a Claude job with the network around relay's proxy. Managed
 * settings outrank the settings relay passes: a proxy port of their own replaces relay's, local
 * binding or Unix sockets open this machine to the sandbox directly, and a proxy variable in their
 * env can point the Claude process (its WebFetch) elsewhere. Each key path, and what of it counts.
 */
const MANAGED_NETWORK_KEYS: readonly (readonly [string, "any" | "true" | "list"])[] = [
  ["sandbox.network.httpProxyPort", "any"], ["sandbox.network.socksProxyPort", "any"],
  ["sandbox.network.allowLocalBinding", "true"], ["sandbox.network.allowAllUnixSockets", "true"], ["sandbox.network.allowUnixSockets", "list"],
  ...["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"].map((n) => [`env.${n}`, "any"] as const),
];

/**
 * Why relay does not give a Claude job the network on this machine, from its managed settings on
 * disk (MANAGED_NETWORK_KEYS), or null. What relay cannot read refuses too. Settings delivered from
 * the claude.ai console are not on disk; relay's checks of the sandbox's report and of Claude's own traffic
 * (backends/claude.ts) catch their effect instead.
 */
export function managedNetworkProblem(managed: readonly string[] = managedSettingsPaths()): string | null {
  for (const file of managedFiles(managed)) {
    for (const [key, counts] of MANAGED_NETWORK_KEYS) {
      const read = extract({ file }, key, counts === "list" ? "array" : undefined);
      if (read === "absent") continue;
      const set = read === "unreadable" || counts === "any" || (counts === "true" ? read.value === "true" : read.value !== "0");
      if (!set) continue;
      return `${read === "unreadable" ? `relay could not read ${key} in the organisation-managed Claude Code settings ${file}` : `the organisation-managed Claude Code settings ${file} set ${key}`}, ` +
        "and managed settings outrank relay's own, so a Claude job with the network could reach this machine or its local network around relay's proxy. Relay does not give Claude jobs the network on this machine";
    }
  }
  return null;
}

/** The JSON object that starts at `text[start]` ("{"), by brace depth outside strings; null if it never closes. */
function jsonAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * The `--settings` arguments on these command lines (as ps prints them: arguments joined by
 * spaces), as sources: inline JSON, or a file (relative to `cwd`). An argument relay cannot make
 * out is returned as an unreadable source, so that it counts as answering for the person.
 */
export function settingsArguments(commandLines: readonly string[], cwd: string): SettingsSource[] {
  const out: SettingsSource[] = [];
  for (const line of commandLines) {
    const flag = /(?:^|\s)--settings(?:=|\s+)/g;
    for (let m = flag.exec(line); m; m = flag.exec(line)) {
      const at = m.index + m[0].length;
      if (line[at] === "{") {
        const json = jsonAt(line, at);
        out.push(json ? { inline: json, label: "a --settings argument" } : { file: "(an unterminated --settings argument)" });
      } else {
        const token = /^\S+/.exec(line.slice(at))?.[0] ?? "";
        out.push({ file: path.resolve(cwd, token) });
      }
    }
  }
  return out;
}

/**
 * Observed inbound controls, with provenance, not a claim about another process's effective
 * settings: console-managed settings, --setting-sources, runtime changes and unseen --settings
 * may change those. Extract only this key; never load a settings file's credentials into relay.
 */
export function inboundSettings(env: NodeJS.ProcessEnv, cwd: string, commandLines: readonly string[] = [], managed: readonly string[] = managedSettingsPaths()): { source: string; value: string }[] {
  const sources: SettingsSource[] = [...settingsFiles(env, cwd, managed).map((file) => ({ file })), ...settingsArguments(commandLines, cwd)];
  return sources.flatMap((src) => {
    const read = extract(src, "crossSessionInbound", "string");
    if (read === "absent") return [];
    const value = read === "unreadable" ? "unreadable" : ["accept", "hold", "refuse"].includes(read.value) ? read.value : "invalid";
    return [{ source: labelOf(src), value }];
  });
}

/**
 * Why relay cannot establish that an answer in this Claude Code session is the person's, from its
 * settings, for the dialog and for confirm (see Consent): the user's, project, local and managed
 * settings files, and any `--settings` argument on the command lines of the processes that started
 * relay's server. For each, the first source that stands in the way.
 */
export function settingsAnswerForPerson(env: NodeJS.ProcessEnv, cwd: string, commandLines: readonly string[], managed: readonly string[] = managedSettingsPaths()): Consent {
  // Where the session's repository is, asked of git once for the settings files and the subagent
  // definitions alike: between the two only files are read.
  const localDirs = localSettingsDirs(cwd);
  const sources: SettingsSource[] = [...settingsFiles(env, cwd, managed, localDirs).map((file) => ({ file })), ...settingsArguments(commandLines, cwd)];
  const out: Consent = { dialog: null, confirm: null };
  for (const src of sources) {
    const missing = "file" in src && !fs.existsSync(src.file) ? `relay could not read the Claude Code settings in ${src.file}` : null;
    const why = missing ? { dialog: missing, confirm: missing } : answeredWithoutPerson(src);
    out.dialog ??= why.dialog;
    out.confirm ??= why.confirm;
    if (out.dialog && out.confirm) break;
  }
  // Subagent definitions have their own hooks, independent of settings.json. For 1.0 use a
  // conservative frontmatter check rather than adding a YAML runtime: any hooks key withholds
  // the permission-prompt paths, even an empty or unrelated hook. Ambiguous YAML fails closed.
  out.confirm ??= subagentHooksProblem(env, cwd, localDirs);
  const extensions = extensionHooksProblem(env, cwd, commandLines);
  out.confirm ??= extensions.confirm;
  out.dialog ??= extensions.dialog;
  return out;
}

/**
 * Plugin hooks merge hooks/hooks.json with manifest hooks (inline maps or file paths).
 * Skills can register hooks for the rest of the session. See Claude Code's hooks and plugin
 * manifest/loading references, linked in docs/extensions.md. Scan even disabled/cached copies:
 * the running session can have an older plugin or an already-invoked skill still registered.
 */
export function extensionHooksProblem(env: NodeJS.ProcessEnv, cwd: string, commandLines: readonly string[] = []): Consent {
  const home = env.HOME || os.homedir();
  const configs = [...new Set([path.join(home, ".claude"), ...(env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : [])])];
  const out: Consent = { confirm: null, dialog: null };
  const blocked = (why: string) => { out.confirm ??= why; out.dialog ??= why; };
  const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  const read = (file: string): unknown => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > 1024 * 1024) throw new Error("not a bounded regular JSON file");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(fd)));
    } finally { fs.closeSync(fd); }
  };
  const present = (file: string) => {
    try { fs.lstatSync(file); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  };
  const hookMap = (value: unknown, label: string) => {
    if (!object(value)) { blocked(`relay could not read the Claude Code plugin hooks in ${label}`); return; }
    // JavaScript hook modules can register arbitrary handlers; matchers are not inspectable.
    if ("modules" in value) blocked(`the Claude Code plugin hooks in ${label} contain a module whose matchers relay cannot inspect`);
    for (const route of ["confirm", "dialog"] as const) for (const [event, name] of ANSWERING_HOOKS[route]) {
      if (!(event in value)) continue;
      const groups = value[event];
      if (!Array.isArray(groups)) { blocked(`relay could not read the Claude Code plugin hooks in ${label}`); continue; }
      for (const group of groups) {
        if (!object(group) || (group.matcher !== undefined && typeof group.matcher !== "string") || matcherMatches(group.matcher as string | undefined, name)) {
          out[route] ??= `the Claude Code plugin hooks in ${label} have ${event} hooks which may answer for you (${name})`;
        }
      }
    }
  };
  const hooksFile = (file: string) => {
    try {
      const raw = read(file);
      // Claude Code takes `hooks` (the matchers), `modules` (hooks modules), or both.
      if (!object(raw) || !("hooks" in raw || "modules" in raw)) throw new Error("missing hooks map and hook modules");
      // A hooks module is code that can register any handler; its matchers are not inspectable.
      if ("modules" in raw) blocked(`the Claude Code plugin hooks in ${file} load a hooks module whose handlers relay cannot inspect`);
      if ("hooks" in raw) hookMap(raw.hooks, file);
    } catch { blocked(`relay could not read the Claude Code plugin hooks in ${file}`); }
  };
  const seen = new Set<string>();
  const definition = (file: string, kind: "skill" | "subagent" | "command") => {
    // Claude can load a directory in its skills root as a plugin too.
    if (path.basename(file) === "plugin.json" && path.basename(path.dirname(file)) === ".claude-plugin") plugin(path.dirname(path.dirname(file)));
    if (!(kind === "skill" ? path.basename(file).toLowerCase() === "skill.md" : file.endsWith(".md"))) return;
    // Reuse DM8's bounded frontmatter reader and conservative YAML rules. A hook key is
    // enough: interpreting arbitrary YAML to prove a matcher harmless would fail open.
    try {
      const front = subagentFrontmatter(file);
      if (hookedFrontmatter(front)) blocked(`the Claude Code ${kind} definition ${file} has hooks or frontmatter relay cannot rule out as hooked`);
    } catch { blocked(`relay could not read the Claude Code ${kind} frontmatter in ${file}`); }
  };
  const definitions = (dir: string, kind: "skill" | "subagent" | "command") => walk(dir, (file) => definition(file, kind));
  const walk = (dir: string, file: (p: string) => void, visited = new Set<string>(), depth = 0, skip = new Set<string>()) => {
    try {
      if (!present(dir)) return;
      const real = fs.realpathSync(dir);
      if (visited.has(real)) return;
      visited.add(real);
      if (depth > 32) throw new Error("directory nesting exceeds scan bound");
      if (!fs.statSync(dir).isDirectory()) { file(dir); return; }
      for (const entry of fs.readdirSync(dir).sort()) {
        if (skip.has(entry)) continue;
        const at = path.join(dir, entry);
        if (fs.statSync(at).isDirectory()) walk(at, file, visited, depth + 1, skip);
        else file(at);
      }
    } catch { blocked(`relay could not read the Claude Code extension definitions in ${dir}`); }
  };
  const plugin = (root: string) => {
    let real: string;
    try { real = fs.realpathSync(root); } catch { blocked(`relay could not read the Claude Code plugin in ${root}`); return; }
    if (seen.has(real)) return;
    seen.add(real);
    const manifest = path.join(root, ".claude-plugin/plugin.json");
    try {
      const raw = present(manifest) ? read(manifest) : {};
      if (!object(raw)) throw new Error("invalid manifest");
      const declared = raw.hooks === undefined ? [] : Array.isArray(raw.hooks) ? raw.hooks : [raw.hooks];
      for (const hook of declared) {
        if (typeof hook === "string") hooksFile(path.resolve(root, hook));
        else hookMap(hook, manifest);
      }
      const standard = path.join(root, "hooks/hooks.json");
      if (present(standard)) hooksFile(standard);
      definitions(path.join(root, "skills"), "skill");
      definitions(path.join(root, "agents"), "subagent");
      definitions(path.join(root, "commands"), "command");
      if (present(path.join(root, "SKILL.md"))) definitions(path.join(root, "SKILL.md"), "skill");
      for (const [key, kind] of [["skills", "skill"], ["agents", "subagent"], ["commands", "command"]] as const) {
        if (raw[key] === undefined) continue;
        const paths = Array.isArray(raw[key]) ? raw[key] : [raw[key]];
        for (const component of paths) {
          if (typeof component !== "string") throw new Error("uninspectable component declaration");
          definitions(path.resolve(root, component), kind);
        }
      }
    } catch { blocked(`relay could not read the Claude Code plugin manifest in ${manifest}`); }
  };
  // Skills declared by marketplace entries, checked once every plugin cache and install path is known.
  const declaredSkills: { manifest: string; home: string; metadata: unknown; entry: Record<string, unknown> }[] = [];
  const marketplaces = new Set<string>();
  const marketplace = (file: string) => {
    // Marketplace entries may supplement or replace a manifest, including custom hooks paths.
    // Without the running loader's effective entry, do not assume its on-disk manifest is all.
    // Declared hooks, agents and commands still withhold. Declared skills are read instead
    // (marketplaceSkills): a skill can carry hooks only in its SKILL.md frontmatter.
    try {
      const real = fs.realpathSync(file);
      if (marketplaces.has(real)) return;
      marketplaces.add(real);
      const raw = read(file);
      if (!object(raw) || !Array.isArray(raw.plugins) || raw.plugins.some((p) => !object(p))) throw new Error("invalid marketplace manifest");
      for (const entry of raw.plugins as Record<string, unknown>[]) {
        if (["hooks", "agents", "commands"].some((k) => k in entry)) blocked(`the Claude Code marketplace manifest in ${file} declares extension components whose effective hook sources relay cannot establish`);
        else if ("skills" in entry) declaredSkills.push({ manifest: file, home: path.dirname(path.dirname(file)), metadata: raw.metadata, entry });
      }
    } catch { blocked(`relay could not read the Claude Code marketplace manifest in ${file}`); }
  };
  // Every recorded install path, by plugin name (the part of `name@marketplace` before the "@").
  const installs = new Map<string, string[]>();
  const inside = (root: string, at: string) => at === root || at.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  /**
   * An entry's declared skill paths resolve against its plugin root, which is wherever a copy of
   * the plugin is on disk: under the marketplace for a relative `source` ("./x", or "x" under
   * `metadata.pluginRoot`), and every cached version (`plugins/cache/<marketplace>/<plugin>/<v>`,
   * under any marketplace, since a renamed one would still load) or recorded install path. A
   * remote plugin that was never installed has no copy, and nothing of it can load. Each SKILL.md
   * under a declared path gets the same frontmatter check as any other skill; one that cannot be
   * read, or that resolves outside its plugin root (a link out, or `..`), withholds.
   */
  const marketplaceSkills = ({ manifest, home, metadata, entry }: (typeof declaredSkills)[number]) => {
    const fail = (why: string) => blocked(`the Claude Code marketplace manifest in ${manifest} declares skills ${why}`);
    const name = entry.name;
    const paths = Array.isArray(entry.skills) ? entry.skills : [entry.skills];
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return fail("for a plugin whose name relay cannot place in the plugin cache");
    if (!paths.length || paths.some((p) => typeof p !== "string")) return fail(`for ${name} that relay cannot inspect`);
    const roots: string[] = [];
    if (typeof entry.source === "string") {
      const base = object(metadata) ? metadata.pluginRoot : undefined;
      if (base !== undefined && typeof base !== "string") return fail(`for ${name} under a plugin root relay cannot read`);
      for (const at of [path.resolve(home, entry.source), ...(base === undefined ? [] : [path.resolve(home, base, entry.source)])]) {
        if (!inside(home, at)) return fail(`for ${name} from a source outside the marketplace`);
        roots.push(at);
      }
    } else if (!object(entry.source)) return fail(`for ${name} from a source relay cannot read`);
    for (const config of configs) {
      const cache = path.join(config, "plugins", "cache");
      try {
        for (const market of present(cache) ? fs.readdirSync(cache).sort() : []) {
          const dir = path.join(cache, market, name);
          if (!present(dir)) continue;
          for (const version of fs.readdirSync(dir).sort()) {
            const at = path.join(dir, version);
            if (fs.statSync(at).isDirectory()) roots.push(at);
            // A zipped cache entry cannot be inspected without unpacking it.
            else if (version.endsWith(".zip")) fail(`for ${name}, which has a zipped copy in ${dir} relay cannot inspect`);
          }
        }
      } catch { fail(`for ${name}, and relay could not read the Claude Code plugin cache in ${cache}`); }
    }
    roots.push(...(installs.get(name) ?? []));
    for (const root of new Set(roots)) {
      let real: string;
      try { real = fs.realpathSync(root); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") fail(`for ${name} in ${root}, which relay could not read`); continue; }
      // The copy's default components load alongside the declared skills, manifest or not.
      plugin(root);
      for (const declared of paths as string[]) {
        const at = path.resolve(root, declared);
        if (!inside(path.resolve(root), at)) { fail(`for ${name} at ${declared}, outside its plugin directory ${root}`); continue; }
        // Claude loads nothing from a declared path that is not there.
        walk(at, (file) => {
          let target: string;
          try { target = fs.realpathSync(file); } catch { fail(`for ${name}, and relay could not read ${file}`); return; }
          if (!inside(real, target)) { fail(`for ${name}, and ${file} leads outside its plugin directory ${root}`); return; }
          definition(file, "skill");
        });
      }
    }
  };
  const pluginTree = (root: string) => walk(root, (file) => {
    if (path.basename(file) === "plugin.json" && path.basename(path.dirname(file)) === ".claude-plugin") plugin(path.dirname(path.dirname(file)));
    if (path.basename(file) === "hooks.json" && path.basename(path.dirname(file)) === "hooks") hooksFile(file);
    if (path.basename(file) === "marketplace.json" && path.basename(path.dirname(file)) === ".claude-plugin") marketplace(file);
  }, new Set(), 0, new Set([".git", "node_modules"]));
  for (const config of configs) {
    const plugins = path.join(config, "plugins");
    // Include all on-disk versions, plus local/in-place installs outside the cache.
    pluginTree(plugins);
    // Every cached version is a plugin root, with or without a plugin.json: a marketplace entry
    // can stand in for the manifest, and Claude still loads the default skills/, agents/,
    // commands/ and hooks/hooks.json of the copy. Older versions stay loaded in running sessions.
    const cache = path.join(plugins, "cache");
    try {
      for (const market of present(cache) ? fs.readdirSync(cache).sort() : []) {
        if (!fs.statSync(path.join(cache, market)).isDirectory()) continue;
        for (const name of fs.readdirSync(path.join(cache, market)).sort()) {
          const dir = path.join(cache, market, name);
          if (!fs.statSync(dir).isDirectory()) continue;
          for (const version of fs.readdirSync(dir).sort()) {
            if (fs.statSync(path.join(dir, version)).isDirectory()) plugin(path.join(dir, version));
          }
        }
      }
    } catch { blocked(`relay could not read the Claude Code plugin cache in ${cache}`); }
    for (const name of ["known_marketplaces.json", "known_marketplaces_claudeai.json"]) {
      const registry = path.join(plugins, name);
      try {
        if (!present(registry)) continue;
        const raw = read(registry);
        if (!object(raw)) throw new Error("invalid marketplace registry");
        for (const row of Object.values(raw)) {
          if (!object(row) || typeof row.installLocation !== "string" || !path.isAbsolute(row.installLocation)) throw new Error("missing marketplace location");
          pluginTree(row.installLocation);
          const manifest = path.join(row.installLocation, ".claude-plugin/marketplace.json");
          if (!present(manifest)) throw new Error("missing marketplace manifest");
        }
      } catch { blocked(`relay could not read the Claude Code marketplace registry in ${registry}`); }
    }
    const installed = path.join(plugins, "installed_plugins.json");
    try {
      if (present(installed)) {
        const raw = read(installed);
        if (!object(raw) || !object(raw.plugins)) throw new Error("invalid plugin registry");
        for (const [key, rows] of Object.entries(raw.plugins)) {
          if (!Array.isArray(rows)) throw new Error("invalid plugin installs");
          for (const row of rows) {
            if (!object(row) || typeof row.installPath !== "string" || !path.isAbsolute(row.installPath)) throw new Error("missing install path");
            plugin(row.installPath);
            const name = key.split("@")[0];
            installs.set(name, [...(installs.get(name) ?? []), row.installPath]);
          }
        }
      }
    } catch { blocked(`relay could not read the Claude Code installed plugin manifest in ${installed}`); }
    definitions(path.join(config, "skills"), "skill");
    definitions(path.join(config, "commands"), "command");
  }
  for (const declared of declaredSkills) marketplaceSkills(declared);
  // Personal and repository skill roots are independent of the settings hook files.
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    definitions(path.join(dir, ".claude/skills"), "skill");
    definitions(path.join(dir, ".claude/commands"), "command");
    if (dir === home || fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) break;
  }
  // Claude lazily discovers nested .claude/skills when it reads files in that subtree. Those
  // hooks can already exist when this server starts even though no init report names them yet.
  const nested = (dir: string, visited = new Set<string>(), depth = 0) => {
    try {
      const real = fs.realpathSync(dir);
      if (visited.has(real)) return;
      visited.add(real);
      if (depth > 32) throw new Error("directory nesting exceeds scan bound");
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".git") continue; // Git metadata is never a project skill root.
        const at = path.join(dir, entry.name);
        if (!entry.isDirectory() && !(entry.isSymbolicLink() && fs.statSync(at).isDirectory())) continue;
        if (entry.name === ".claude") {
          definitions(path.join(at, "skills"), "skill");
          definitions(path.join(at, "commands"), "command");
        } else nested(at, visited, depth + 1);
      }
    } catch { blocked(`relay could not inspect nested Claude Code skill roots in ${dir}`); }
  };
  // A home-directory session has no bounded project tree to inspect safely: its own roots were
  // checked above, but nested roots cannot be ruled out without scanning the person's home.
  if (path.resolve(cwd) === path.resolve(home)) blocked("relay cannot rule out nested Claude Code skill hooks for a session started in the home directory");
  else nested(path.resolve(cwd));
  for (const line of commandLines) {
    // ps joins argv with spaces. Quoting/archives/URLs cannot be established as an inspectable
    // directory; fail closed rather than mistaking a partial argument for the plugin root.
    // ps has lost argv boundaries: a valid directory prefix cannot prove the full argument.
    // Withhold for any CLI-only plugin rather than trusting a possibly truncated path.
    if (/(?:^|\s)--plugin-dir(?:=|\s|$)/.test(line)) blocked("relay could not inspect a Claude Code --plugin-dir argument with certainty from its command line");
    if (/(?:^|\s)--plugin-url(?:=|\s)/.test(line)) blocked("relay could not inspect a Claude Code --plugin-url argument");
  }
  if (env.CLAUDE_CODE_PLUGIN_DIRS) {
    // The CLI's environment form has varied between releases; do not guess its delimiter.
    blocked("relay could not inspect Claude Code plugins supplied by CLAUDE_CODE_PLUGIN_DIRS");
  }
  // Both move plugin files out of the plugins directories scanned above: CLAUDE_CODE_PLUGIN_CACHE_DIR
  // relocates the whole plugins root (cache, registries, marketplaces), and a seed directory
  // supplies pre-installed plugins.
  for (const name of ["CLAUDE_CODE_PLUGIN_CACHE_DIR", "CLAUDE_CODE_PLUGIN_SEED_DIR"]) {
    if (env[name]) blocked(`relay could not inspect Claude Code plugins under ${name}`);
  }
  return out;
}

/**
 * Whether Claude Code could read a top-level `hooks` key from a definition's frontmatter block, or
 * relay cannot rule one out. Claude Code (2.1.326) ends the block at the first `---` anywhere, not
 * only at a delimiter line, parses it with Bun's YAML parser, and when that throws, parses it once
 * more after double-quoting the value of each `key: value` line at column 0. A definition's hooks
 * are the `hooks` property of the result. In each of those readings a top-level key is an implicit
 * key that starts at column 0, so this check's safety rests on two rules:
 *   1. no `hooks` followed by `:` anywhere in the block, even quoted, folded or nested; and
 *   2. every line that starts at column 0 is a comment, a `- ` entry of the sequence under the key
 *      before it, or a plain `key:` entry whose key is not `hooks`, and none continues a quoted
 *      scalar or flow sequence left open by an earlier line.
 * The rest is margin. Relay withholds for YAML it does not model, rather than reason about how Bun
 * reads it: flow mappings, anchors, aliases, tags, directives, quoted and explicit keys, duplicate
 * top-level keys, nested flow collections, and comments or implicit pairs inside a flow sequence.
 * A `:` not followed by a space, as in `Bash(git add:*)`, is part of a plain scalar, as in YAML.
 */
export function hookedFrontmatter(front: string): boolean {
  if (/(?:^|[^A-Za-z0-9_-])hooks["']?\s*:/im.test(front)) return true;
  const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?: +(.*))?$/;
  const ITEM = /^-(?: |$)/;
  const keys = new Set<string>();
  // A quoted scalar or flow sequence that continues on the next line.
  let open = null as OpenNode | null;
  // Lines indented beyond this continue a plain or block scalar.
  let cont = null as number | null;
  // The last top-level key's value is on the indented lines (or `- ` entries) after it; `node`
  // while the next such line may be that value itself (`description:\n  "text"`).
  let nested = false, node = false;
  const closed = (rest: string) => /^(?: +#.*| *)$/.test(rest);
  /** A value's node: false when relay does not model it. */
  const value = (v: string, parent: number, top = false): boolean => {
    if (!v || v.startsWith("#")) return true;
    if (v[0] === "|" || v[0] === ">") {
      cont = parent;
      return /^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?: +#.*| *)$/.test(v);
    }
    if (v[0] === '"' || v[0] === "'" || v[0] === "[") {
      const r = scanNode(v.slice(1), v[0] === "[" ? { quote: null, flow: true, sep: false } : { quote: v[0], flow: false, sep: false });
      if (r === null) return false;
      // Text after a node that closes on a top-level key line (`argument-hint: [a] [b]`) makes
      // Bun's parse throw, and Claude's retry then quotes the whole value or reads no keys at all.
      if (typeof r === "string") return closed(r) || top;
      open = r;
      return true;
    }
    // A plain scalar. A `: ` in it can at most nest a key under this one (or, in Claude's retry,
    // be quoted), never add a top-level key; a `hooks:` in it is caught above.
    if (/^(?:[\]{}&*!%@`#,]|[?:-](?: |$))/.test(v)) return false;
    cont = parent;
    return true;
  };
  /** A block sequence entry or nested mapping entry. */
  const entry = (text: string, indent: number): boolean => {
    const item = ITEM.test(text);
    const rest = item ? text.replace(/^- */, "") : text;
    const pair = KEY.exec(rest);
    if (pair) return value(pair[2] ?? "", indent);
    return item && !ITEM.test(rest) && value(rest, indent);
  };
  for (const line of front.split(/\r\n|\r|\n/)) {
    const indent = /^ */.exec(line)![0].length;
    const text = line.slice(indent);
    if (open) {
      if (indent === 0 && text) return true;
      const r: OpenNode | string | null = scanNode(text, open);
      if (r === null) return true;
      if (typeof r === "string") { open = null; if (!closed(r)) return true; }
      else open = r;
      continue;
    }
    if (!text) continue;
    if (cont !== null && indent > cont) continue;
    cont = null;
    if (text.startsWith("#")) continue;
    if (indent === 0 && nested && ITEM.test(text)) {
      node = false;
      if (!entry(text, 0)) return true;
      continue;
    }
    if (indent === 0) {
      const pair = KEY.exec(text);
      if (!pair || pair[1].toLowerCase() === "hooks" || keys.has(pair[1])) return true;
      keys.add(pair[1]);
      const v = pair[2] ?? "";
      nested = node = !v || v.startsWith("#");
      if (!value(v, 0, true)) return true;
      continue;
    }
    if (!nested) return true;
    if (node) {
      node = false;
      if (!ITEM.test(text) && !KEY.test(text)) {
        nested = false;
        if (!value(text, 0)) return true;
        continue;
      }
    }
    if (!entry(text, indent)) return true;
  }
  return open !== null;
}

type OpenNode = { quote: '"' | "'" | null; flow: boolean; sep: boolean };

/**
 * Scan a quoted scalar or a flat flow sequence of scalars from just after its opening character,
 * or onward from `from` on a later line. Returns the state when the node runs past the end of the
 * text, the text after it when it closes, or null for anything else (nested collections, anchors,
 * aliases, tags, comments, implicit pairs).
 */
function scanNode(text: string, from: OpenNode): OpenNode | string | null {
  const s = { ...from };
  let i = 0;
  for (;;) {
    if (s.quote) {
      for (; i < text.length; i++) {
        if (s.quote === '"' && text[i] === "\\") i++;
        else if (s.quote === "'" && text[i] === "'" && text[i + 1] === "'") i++;
        else if (text[i] === s.quote) break;
      }
      if (i >= text.length) return s;
      i++;
      s.quote = null;
      if (!s.flow) return text.slice(i);
      s.sep = true;
      continue;
    }
    while (text[i] === " ") i++;
    if (i >= text.length) return s;
    const c = text[i];
    if (s.sep) {
      if (c === ",") { s.sep = false; i++; continue; }
      return c === "]" ? text.slice(i + 1) : null;
    }
    if (c === "]") return text.slice(i + 1);
    if (c === '"' || c === "'") { s.quote = c; i++; continue; }
    if (/[[\]{},&*!|>%@`#]/.test(c) || (/[?:-]/.test(c) && /^[ ,\]]?$/.test(text[i + 1] ?? ""))) return null;
    const plain = /^[^,[\]{}]*/.exec(text.slice(i))![0];
    i += plain.length;
    // In a flow sequence a `:` before a space, `,`, `]` or the line's end would make a pair.
    if (/ #|:(?: |$)/.test(plain.trimEnd()) || (i < text.length && text[i] !== "," && text[i] !== "]")) return null;
    s.sep = true;
  }
}

/** Only the leading frontmatter block, capped at 64 KiB; never parse or retain the agent body. */
function subagentFrontmatter(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("not a regular definition file");
    let bytes = Buffer.alloc(0);
    for (;;) {
      const chunk = Buffer.alloc(4096);
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      bytes = Buffer.concat([bytes, chunk.subarray(0, n)]);
      // Locate ASCII delimiters before decoding, so an odd encoding or malformed UTF-8 fails
      // rather than silently replacing bytes. Decode the frontmatter only, not a chunk of body.
      const raw = bytes.toString("latin1");
      const start = /^---\r?\n/.exec(raw);
      if (!start) throw new Error("missing leading delimiter");
      const end = /(?:^|\n)---(?:\r?\n|$)/g;
      end.lastIndex = start[0].length;
      const close = end.exec(raw);
      if (close) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start[0].length, close.index));
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029\ufeff\t]/.test(text)) throw new Error("odd encoding or tabs");
        return text;
      }
      if (!n || bytes.length >= 65536) throw new Error("unterminated or oversized frontmatter");
    }
  } finally { fs.closeSync(fd); }
}

export function subagentHooksProblem(env: NodeJS.ProcessEnv, cwd: string, localDirs: readonly string[] = localSettingsDirs(cwd)): string | null {
  const home = env.HOME || os.homedir();
  const dirs = [...new Set([
    ...(env.CLAUDE_CONFIG_DIR ? [path.join(env.CLAUDE_CONFIG_DIR, "agents")] : []),
    path.join(home, ".claude", "agents"),
    ...localDirs.map((d) => path.join(d, ".claude", "agents")),
  ])];
  for (const dir of dirs) {
    let files: string[];
    try { files = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return `relay could not read the Claude Code subagent definitions in ${dir}`;
    }
    for (const name of files) {
      const file = path.join(dir, name);
      let front: string;
      try { front = subagentFrontmatter(file); }
      catch { return `relay could not read the Claude Code subagent frontmatter in ${file}`; }
      // A hooks key, or YAML that relay does not model and so cannot rule one out (see hookedFrontmatter).
      if (hookedFrontmatter(front)) {
        return `the Claude Code subagent definition ${file} has hooks or frontmatter relay cannot rule out as hooked; conservatively withholding the confirm and adopt permission prompts`;
      }
    }
  }
  return null;
}
