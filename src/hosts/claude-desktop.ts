// The Claude desktop app (and Cowork): relay is mcpServers.relay-desktop in the app's own config
// file, with a PATH, since the app does not inherit the shell's. A host of the claude family.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RelayConfig } from "../core/config.js";
import { systemTool } from "../core/executables.js";
import type { Target } from "../targets/index.js";
import { isTable, sameData, type Edit } from "../core/toml.js";
import {
  config, entriesState, errText, installKind, isRelayEntry, judge, LAUNCHER, locate, note, objection, readText, reinstallCommand, removable, say, Stop, writeFile,
  type Found, type Plan, type Run,
} from "../install/common.js";
import { DESKTOP_ENTRY, DESKTOP_OLD_ENTRY as OLD_ENTRY, DESKTOP_SHARED as SHARED } from "./desktop-shared.js";
import type { HostDef } from "./types.js";

export const desktopConfigFile = () => path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
const SYSTEM_DIRS = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function squeeze(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inString) {
      out += c;
      if (c === "\\") out += json[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (!/\s/.test(c)) out += c;
  }
  return out;
}

/**
 * Sets (an entry) or removes (null) the named entries under mcpServers in the desktop app's config,
 * keeping the file's indentation and line endings. `servers` is mcpServers as the file had it.
 */
function editDesktop(text: string, changes: Record<string, Record<string, unknown> | null>): Edit & { servers?: Record<string, unknown> } {
  let cfg: unknown;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `it does not parse as JSON (${errText(err)})` };
  }
  if (!isTable(cfg) || (cfg.mcpServers !== undefined && !isTable(cfg.mcpServers))) return { ok: false, reason: "it is not the shape relay expects (an object, with mcpServers an object if present)" };
  // Rewriting goes through JSON.stringify. A file that would not come back the same (a duplicate
  // key, a number or an escape written unusually) is one relay would be changing beyond its own entry.
  if (squeeze(text) !== JSON.stringify(cfg)) return { ok: false, reason: "it holds something that would not survive being rewritten (a duplicate key, or a number or escape written in an unusual way)" };
  const before = (cfg.mcpServers ?? {}) as Record<string, unknown>;
  const servers = { ...before };
  for (const [name, entry] of Object.entries(changes)) {
    delete servers[name];
    if (entry) servers[name] = entry;
  }
  const next = { ...cfg, mcpServers: servers };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // A file written on one line stays on one line.
  const indent = text.trim().includes("\n") ? (text.match(/^([ \t]+)\S/m)?.[1] ?? "  ") : "";
  const out = JSON.stringify(next, null, indent).replace(/\n/g, eol) + (/\n$/.test(text) ? eol : "");
  if (!sameData(JSON.parse(out), next)) return { ok: false, reason: "relay's edit would not leave the file as intended, so it was not made" };
  return { ok: true, text: out, servers: before };
}

/** PATH for the desktop entry: where the executables relay needs are on this machine now, then the system directories. */
function desktopEnvPath(targets: RelayConfig["targets"]): { value: string; missing: string[] } {
  // The directory as it really is: a version manager's per-shell directory is gone when the shell is.
  const dirOf = (file: string) => {
    try {
      return fs.realpathSync(path.dirname(file));
    } catch {
      return path.dirname(file);
    }
  };
  // The desktop root launches every switched-on target's CLI, and git.
  const wanted = { ...Object.fromEntries(Object.entries(targets).filter(([, t]) => t.enabled).map(([id, t]) => [id, t.bin])), git: "git" };
  const dirs = [path.dirname(process.execPath)];
  const missing: string[] = [];
  for (const [name, bin] of Object.entries(wanted)) {
    const at = locate(bin);
    if (at) dirs.push(dirOf(at));
    else missing.push(name);
  }
  return { value: [...new Set([...dirs, ...SYSTEM_DIRS])].join(":"), missing };
}

function desktopRunning(): boolean {
  // -a: macOS pgrep leaves out its own ancestors otherwise, and the app is one when this runs in its Code tab.
  const r = spawnSync(systemTool("/usr/bin/pgrep"), ["-a", "-x", "Claude"], { encoding: "utf8" });
  // pgrep exits 0 for a match and 1 for none. Anything else is not an answer.
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    throw new Stop(`relay could not check whether the Claude desktop app is running (pgrep: ${r.error ? errText(r.error) : `exit ${r.status}`}), so it will not edit its config.`);
  }
  return r.status === 0 && Boolean(r.stdout.trim());
}

/** The desktop app's mcpServers, or null without a config file. Throws on a file that does not parse. */
function desktopServers(): Record<string, unknown> | null {
  const file = desktopConfigFile();
  if (!fs.existsSync(file)) return null;
  const servers = JSON.parse(fs.readFileSync(file, "utf8"))?.mcpServers;
  return isTable(servers) ? servers : {};
}


/**
 * Whether relay's own entry is still under its earlier name, `relay`, where in Code tab sessions it
 * hides the relay Claude Code starts from its own registration. False where that cannot be told.
 */
export function desktopEntryUnderOldName(): boolean {
  try {
    return isRelayEntry(desktopServers()?.[OLD_ENTRY]);
  } catch {
    return false;
  }
}

function planDesktop(run: Run): Plan {
  // The Claude desktop app (and Cowork) reads local MCP servers from its own file, not from
  // Claude Code's config. A running app rewrites that file from memory, so it must be quit first.
  const file = desktopConfigFile();
  const removing = run.verb === "uninstall";
  const env = desktopEnvPath(config().targets);
  // The app does not inherit the shell PATH; relay needs node, git, claude and codex on it.
  // --desktop tells the server it is this entry (src/mcp/server.ts hostFromArgs).
  const entry = { command: LAUNCHER, args: ["mcp", "--host", "claude", "--desktop"], env: { PATH: env.value } };
  const at = `mcpServers.${DESKTOP_ENTRY} in ${file}`;
  const oldAt = `mcpServers.${OLD_ENTRY} in ${file}`;
  const problems: string[] = [];
  if (!removing) {
    say(`# ${at}:\n${JSON.stringify(entry, null, 2)}`);
    say(`# ${SHARED}`);
    for (const name of env.missing) {
      say(`WARNING: ${name} was not found${name === "git" ? " on PATH" : ` (looked for \`${config().targets[name as Target].bin}\`)`}, so the PATH above does not lead to it and relay started by the desktop app will not find it. Install it and run this again.`);
    }
  }

  const before = readText(file);
  // Relay's entry, and what is under the name relay's entry had before (0.2.0 and the 0.9 release candidates).
  let found: Found = { state: "absent" };
  let old: Found = { state: "absent" };
  let servers: Record<string, unknown> = {};
  if (!before) {
    if (!removing) problems.push(`${file} does not exist; open the Claude desktop app once first.`);
  } else {
    const probe = editDesktop(before.text, {});
    if (!probe.ok) found = { state: "blocked", note: `${file}: ${probe.reason}. Relay will not edit it${removing ? "" : "; add the entry above under mcpServers by hand"}.` };
    else {
      servers = probe.servers!;
      found = judge(servers[DESKTOP_ENTRY], entry);
      old = judge(servers[OLD_ENTRY], entry);
    }
    const no = objection(at, found, run.force, removing ? "remove" : "replace");
    if (no) problems.push(no);
    // Install moves relay's entry from the old name, which would lose settings added to it; that takes --force, as replacing it would.
    if (!removing && old.state === "customised") {
      const lost = objection(`${oldAt} (relay's entry under its earlier name, which this install replaces with ${DESKTOP_ENTRY})`, old, run.force, "replace");
      if (lost) problems.push(lost);
    }
  }
  const command = (name: string) => (isTable(servers[name]) ? servers[name].command : undefined);
  const leftAlone: string[] = [];
  const changes: Record<string, Record<string, unknown> | null> = {};
  if (removing) {
    if (removable(run, found, command(DESKTOP_ENTRY))) changes[DESKTOP_ENTRY] = null;
    else if (found.state === "foreign") leftAlone.push(`# left alone: ${at} is not relay's (${found.note}). --force removes it.`);
  } else if (found.state !== "identical" && found.state !== "blocked") changes[DESKTOP_ENTRY] = entry;
  // Under the old name only relay's own entry is relay's to take out, --force or not: the name is no longer relay's there.
  if (old.state !== "absent" && old.state !== "blocked" && removable({ ...run, force: false }, old, command(OLD_ENTRY))) changes[OLD_ENTRY] = null;
  else if (old.state === "foreign" && found.state !== "blocked") leftAlone.push(`# left alone: ${oldAt} is not relay's (${old.note})`);
  const moving = !removing && OLD_ENTRY in changes;
  const edit = before && Object.keys(changes).length ? editDesktop(before.text, changes) : null;
  if (edit && !edit.ok) problems.push(`${file}: ${edit.reason}. Relay will not edit it.`);
  const next = edit?.ok ? edit.text : null;
  const running = next !== null && desktopRunning();
  if (running && run.write) problems.push("The Claude desktop app is running and would overwrite this change. Quit it first, then run this again.");
  const reverse = reinstallCommand(removing ? "install" : "uninstall", "claude-desktop");

  return {
    problems,
    apply() {
      for (const line of leftAlone) say(line);
      if (next === null && removing) return void (leftAlone.length || say(`# ${before ? `${file} has no entry of relay's` : `${file} does not exist`}`));
      if (next === null) {
        say(`# ${file} already has relay's entry for this ${installKind()}`);
        return void note(run, "entry", { action: "kept", what: `${file} already had relay's entry`, backup: null, undo: reverse });
      }
      if (running) say("# The Claude desktop app is running. Quit it before running this with --write: a running app overwrites the file.");
      const removed = Object.keys(changes).map((name) => `mcpServers.${name}`).join(" and ");
      if (removing) say(`# remove ${removed} from ${file}`);
      else {
        if (DESKTOP_ENTRY in changes) say(`# ${found.state === "absent" ? "add the entry to" : "replace relay's entry in"} ${file}`);
        if (moving) say(`# remove relay's entry under its earlier name, mcpServers.${OLD_ENTRY}: in Code tab sessions that name hides the relay Claude Code starts from its own registration`);
      }
      const what = removing ? `removed ${removed} from ${file}`
        : [DESKTOP_ENTRY in changes ? `${found.state === "absent" ? "added" : "replaced"} mcpServers.${DESKTOP_ENTRY}` : "", moving ? `removed mcpServers.${OLD_ENTRY} (relay's entry under its earlier name)` : ""].filter(Boolean).join(" and ") + ` in ${file}`;
      writeFile(run, file, before, next, "entry", {
        action: removing ? "removed" : found.state === "absent" && !moving ? "added" : "replaced",
        what,
        undo: `${reverse} (with the app quit)`,
      });
    },
  };
}

export const claudeDesktopHost: HostDef = {
  id: "claude-desktop",
  target: "claude",
  name: "the Claude desktop app",
  plan: planDesktop,
  afterChange: "Start the app again: open -a Claude",
  registered() {
    try {
      const servers = desktopServers();
      return servers ? entriesState(servers[DESKTOP_ENTRY], servers[OLD_ENTRY]) : "none";
    } catch {
      return "unknown";
    }
  },
  doctorRegistration(_cfg, _present, { line, warn, registration }) {
    const desktop = desktopConfigFile();
    if (!fs.existsSync(desktop)) return line("desktop app", `no config at ${desktop} (the Claude desktop app is not installed, or has not been opened)`);
    let servers: Record<string, unknown> | null = null;
    try {
      servers = desktopServers();
    } catch (err) {
      return warn("desktop app", `${desktop} does not parse as JSON (${errText(err)})`);
    }
    const entry = servers?.[DESKTOP_ENTRY];
    const install = reinstallCommand("install", "claude-desktop");
    const underOld = isRelayEntry(servers?.[OLD_ENTRY]);
    if (entry === undefined && !underOld) line("desktop app", `relay NOT registered (quit the app, then ${install})`);
    if (entry !== undefined) {
      registration("desktop app", "claude-desktop", isTable(entry) ? entry.command : undefined, isTable(entry) ? entry.args : undefined, "", DESKTOP_ENTRY);
      if (isRelayEntry(entry)) line("", SHARED);
    }
    if (underOld) {
      warn(entry === undefined ? "desktop app" : "", `relay's entry is under its earlier name, ${OLD_ENTRY}, which in Code tab sessions hides the relay Claude Code starts from its own registration. Rename it to ${DESKTOP_ENTRY}: quit the app, then ${install}`);
    }
    // The --desktop marker is what makes relay treat the app's chats as a shared relay, whose
    // conversations it keeps apart by session tokens (docs/d9-isolation-plan.md). Cowork's
    // connection is also recognised by its client name; how the chats' connection names itself
    // has not been observed, so without the marker they may share one unisolated scope.
    for (const [name, found] of [[DESKTOP_ENTRY, entry], [OLD_ENTRY, underOld ? servers?.[OLD_ENTRY] : undefined]] as const) {
      if (!isRelayEntry(found) || !isTable(found) || (Array.isArray(found.args) && found.args.includes("--desktop"))) continue;
      warn("", `relay's entry mcpServers.${name} lacks --desktop, so relay may not treat the app's desktop chats as a shared relay: their conversations would not be kept apart by session tokens (unverified for the chats' connection; Cowork's is recognised by name). Quit the app, then ${install}`);
    }
  },
};
