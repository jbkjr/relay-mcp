// Codex: relay is an [mcp_servers.relay] table relay writes into Codex's config.toml, and its
// skills come as a plugin from a local marketplace pointing at adapters/codex.
import { codexOwn, reportFamilies } from "../core/steering.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnFound } from "../core/executables.js";
import { editCodexConfig, isTable, readToml, relayServer, type TomlData } from "../core/toml.js";
import {
  config, entriesState, errText, first, installKind, isRelayEntry, jsonText as json, judge, LAUNCHER, MARKETPLACE, NO_SERVER, note, objection, PLUGIN, planKit, readText, reinstallCommand, removable, removeFile, requireCli, say, sh, versionDir, writeFile,
  type Found, type KitFormat, type Plan, type Run,
} from "../install/common.js";
import { otherFamilies, otherTargets, TARGETS, targetDef } from "../targets/index.js";
import { briefSkill, type AdapterContext, type HostDef } from "./types.js";
import { hostWaitCapS } from "../mcp/host.js";
import { CODEX_MCP_ENV_VARS, codexToolTimeoutS } from "../targets/codex.js";
import { DEFAULT_CONFIG, relayCodexHome } from "../core/config.js";
import { codexHomeProblem, codexLoginCommand } from "../backends/codex-pin.js";

/** A plugin skill as Codex names it: $relay-delegate. */
const skillRef = (skill: string) => `$relay-${skill}`;

/** Codex's plugin: skills are invoked as $relay-<name>, plus a snippet for AGENTS.md. */
function writeAdapter({ out, version, description, skills, write }: AdapterContext): void {
  write(path.join(out, ".agents", "plugins", "marketplace.json"), json({
    name: MARKETPLACE, interface: { displayName: "relay (local)" },
    plugins: [{ name: "relay", source: { source: "local", path: "./relay" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }],
  }));
  write(path.join(out, "relay", ".codex-plugin", "plugin.json"), json({ name: "relay", version, description, skills: "./skills/" }));
  for (const [name, s] of Object.entries(skills)) {
    // A reference skill is for the agent to load itself, so it is not kept to the user's asking.
    const description = s.reference ? s.description : `${s.description} Use only when the user asks for it by name.`;
    const request = s.reference ? "" : `The user's request follows the skill name (usage: \`${skillRef(name)} ${s.hint}\`).\n\n`;
    write(
      path.join(out, "relay", "skills", `relay-${name}`, "SKILL.md"),
      `---\nname: relay-${name}\ndescription: ${description}\n---\n\n${request}${s.body}\n\nThe relay tools are the tools of the \`relay\` MCP server.\n`,
    );
  }
  const briefs = otherTargets("codex").map((t) => `\`${skillRef(briefSkill(t.id))}\``).join(", ");
  write(
    path.join(out, "AGENTS.snippet.md"),
    `## relay\n\nThe \`relay\` MCP server reaches coding agents of other families from here (${otherFamilies("codex")}): it fills the gaps between families. ${codexOwn} \`delegate\` a well-defined chunk of work (then \`status\`, \`resume\`, \`result\`, \`merge\`), \`ask\` a question mid-task (pass \`thread_id\` to follow up), \`discuss\` a question turn by turn with you as one side, or get an independent \`review\` to set against your own. ${reportFamilies} Leave \`target\` out unless the user names an agent; relay uses your default, or asks you to name one. Use your own judgment about when any of these is worth it. Before you write the other agent a task or question, read relay's brief on writing for it: the plugin's skill (${briefs}), or relay's \`brief\` tool without the plugin. A refusal from relay explains why; carry on yourself.\n\nWhen the user writes \`relay delegate|ask|discuss|review|tree|chat …\`, do that with the matching tool (for \`tree\`, call \`status\` with no id; for \`chat\`, run \`relay chat <id> --print\` or \`--say\`).\n`,
  );
}

export const codexConfigFile = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");

/** Codex's default tool timeout also applies when its registration omits the field. */
export const CODEX_DEFAULT_TOOL_TIMEOUT_S = 60;

/** Read the root's registration, never the timeout of an unrelated launched child's host. */
export function registeredCodexToolTimeoutS(): number {
  try {
    const parsed = readToml(fs.readFileSync(codexConfigFile(), "utf8"));
    const entry = parsed.ok ? relayServer(parsed.data) : undefined;
    const timeout = isTable(entry) ? entry.tool_timeout_sec : undefined;
    if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) return timeout;
  } catch {
    // Missing/unreadable config: end waits below Codex's default instead of guessing a long cap.
  }
  return CODEX_DEFAULT_TOOL_TIMEOUT_S;
}

// Before 1.0, builds of relay wrote a Codex subagent role for each target of another family,
// agents/relay-<target>.toml beside config.toml (the proxy role), which handed its task to relay and
// waited. No release shipped it and relay writes none now. Install and uninstall take out the ones
// relay wrote, saved first, and leave alone any file of that name relay did not write, as
// `install claude-desktop` does with relay's entry under its earlier name.
const ROLE_MARKER = "# Written by relay from ";
const ROLE_DEFAULTS = "# relay role defaults: ";
const roleFile = (id: string) => path.join(path.dirname(codexConfigFile()), "agents", `relay-${id}.toml`);

/** A field's value as relay's role files recorded it: tables with their keys sorted, so that the order they are written in does not count. */
const roleHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_, v) =>
  typeof v === "bigint" ? `${v}n` : isTable(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v)).digest("hex");

/**
 * Whose a file at a role's path is. Relay's carries its marker on the first line and, on the second,
 * a hash of each field as relay wrote it: relay's as written (own), relay's with fields changed
 * since (customised), or not relay's (foreign).
 */
function oldRole(text: string): Found {
  const [marker, defaults] = text.split(/\r?\n/);
  if (!marker.startsWith(ROLE_MARKER)) return { state: "foreign", note: "no relay ownership marker" };
  const parsed = readToml(text);
  if (!parsed.ok) return { state: "customised", extras: [`it no longer parses as TOML (${parsed.error})`] };
  let baseline: unknown = null;
  try {
    if (defaults?.startsWith(ROLE_DEFAULTS)) baseline = JSON.parse(defaults.slice(ROLE_DEFAULTS.length));
  } catch {
    // Read as changed, below.
  }
  if (!isTable(baseline)) return { state: "customised", extras: ["relay ownership comments changed"] };
  const keys = new Set([...Object.keys(parsed.data), ...Object.keys(baseline)]);
  const changed = [...keys].filter((key) => (Object.hasOwn(parsed.data, key) ? roleHash(parsed.data[key]) : null) !== (baseline[key] ?? null));
  return changed.length ? { state: "customised", extras: changed } : { state: "own", note: "relay's proxy role from before 1.0" };
}

/**
 * Takes out the proxy roles relay wrote before 1.0: one per target of another family beside this
 * config.toml, and any the installation record lists elsewhere (CODEX_HOME may have moved). A role
 * someone changed is removed by install only with --force, as replacing it would be; uninstall
 * removes it either way. Each is saved first. A file relay did not write is left alone, --force or not.
 */
function planOldRoles(run: Run): Plan {
  const recorded = Object.entries(run.record.hosts.codex?.resources ?? {})
    .filter(([key, c]) => /^role:[a-z0-9-]+$/.test(key) && c.action !== "removed" && c.file)
    .map(([key, c]) => [path.resolve(c.file!), key] as const);
  const files = new Map<string, string>([...TARGETS.filter((t) => t.vendor !== targetDef("codex").vendor).map((t) => [roleFile(t.id), `role:${t.id}`] as const), ...recorded]);
  const problems: string[] = [];
  const steps: (() => void)[] = [];
  for (const [file, resource] of files) {
    let before: ReturnType<typeof readText>;
    try {
      before = readText(file);
    } catch (err) {
      steps.push(() => say(`# left alone: ${errText(err)}`));
      continue;
    }
    if (!before) continue;
    const found = oldRole(before.text);
    if (found.state === "foreign") {
      steps.push(() => say(`# left alone: ${file} is not a role relay wrote (${found.note})`));
      continue;
    }
    if (run.verb === "install" && found.state === "customised" && !run.force) {
      problems.push(
        `${file} is relay's Codex proxy role from before 1.0, which relay no longer installs, but it has changes relay did not make (${found.extras.join(", ")}). ` +
          "Run this again with --force to remove it anyway (it is saved first), or remove it yourself.",
      );
      continue;
    }
    steps.push(() => {
      say(`# remove relay's Codex proxy role ${file}: relay no longer installs one`);
      removeFile(run, file, before, resource, { action: "removed", what: `removed relay's Codex proxy role ${file}, which relay no longer installs`, undo: null });
    });
  }
  return { problems, apply() { for (const step of steps) step(); } };
}

const KIT: KitFormat = {
  dir: "codex", hostName: "Codex", verbs: { add: "add", remove: "remove" }, manifestDir: ".codex-plugin",
  marketplaces: (listed) => (isTable(listed) ? listed.marketplaces : undefined),
  localSource: (raw) => (isTable(raw.marketplaceSource) && raw.marketplaceSource.sourceType === "local" ? raw.marketplaceSource.source : undefined),
  plugins: (listed) => (isTable(listed) ? listed.installed : undefined),
  isRelayPlugin: (p) => p.pluginId === PLUGIN && p.installed !== false,
  // Codex's list does not name its copy; `codex plugin add` puts it at $CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version> (codex-cli 0.162.1).
  copyOf: (p) => {
    const v = versionDir(p.version);
    return v ? path.join(path.dirname(codexConfigFile()), "plugins", "cache", MARKETPLACE, "relay", v) : null;
  },
};

export const codexBlock = () => [
  "[mcp_servers.relay]",
  `command = ${JSON.stringify(LAUNCHER)}`,
  'args = ["mcp", "--host", "codex"]',
  `env_vars = ${JSON.stringify(CODEX_MCP_ENV_VARS)}`,
  `tool_timeout_sec = ${codexToolTimeoutS(DEFAULT_CONFIG.approval_timeout_s)}`,
  "startup_timeout_sec = 30",
  'default_tools_approval_mode = "approve"',
  "",
  "# Deciding a launched agent's approval request is the one relay call Codex should confirm with you.",
  "[mcp_servers.relay.tools.approve]",
  'approval_mode = "prompt"',
  "",
].join("\n");

/** 3600 was relay's previous shipped default, so its upgrade is a managed change. Other
 * custom timeouts and every other customization still require the installer's usual review. */
function judgeCodex(existing: unknown, intended: Record<string, unknown>): Found {
  const knownDefault = isTable(existing) && existing.tool_timeout_sec === 3600;
  const found = judge(knownDefault ? { ...existing, tool_timeout_sec: intended.tool_timeout_sec } : existing, intended);
  return knownDefault && found.state === "identical" ? { state: "own", note: "relay's previous MCP timeout" } : found;
}

function planCodex(run: Run): Plan {
  const cfg = config();
  const bin = cfg.targets.codex.bin;
  requireCli("codex", bin);
  const file = codexConfigFile();
  const block = codexBlock();
  const intended = relayServer((readToml(block) as { data: TomlData }).data) as Record<string, unknown>;
  const removing = run.verb === "uninstall";
  if (!removing) say(`# relay's block in ${file}:\n${block}`);

  const before = readText(file);
  let found: Found = { state: "absent" };
  let existing: unknown;
  if (before) {
    const parsed = readToml(before.text);
    if (parsed.ok) existing = relayServer(parsed.data);
    found = parsed.ok ? judgeCodex(existing, intended) : { state: "blocked", note: `${file} does not parse as TOML (${parsed.error}). Relay does not edit a file it cannot read: fix it first${removing ? "" : ", or add the block above by hand"}.` };
  }
  const what = `[mcp_servers.relay] in ${file}`;
  let no = objection(what, found, run.force, removing ? "remove" : "replace");
  // The record says which file relay was installed into. If Codex's home has moved since, this run would look in the wrong one.
  const recorded = run.record.hosts.codex?.resources.config?.file;
  if (removing && !no && recorded && path.resolve(recorded) !== path.resolve(file) && fs.existsSync(recorded)) {
    no = `The installation record says relay was put into ${recorded}, but this run looks at ${file}: CODEX_HOME is not what it was. Run this again with CODEX_HOME=${sh([path.dirname(recorded)])}, so that relay is removed from where it was installed.`;
  }
  const foreign = found.state === "foreign" ? found.note : "";
  const leave = removing && found.state === "foreign" && !removable(run, found, isTable(existing) ? existing.command : undefined);
  // The edit is made and proved here, before anything is changed anywhere.
  let next: string | null = null;
  if (!no && !leave && found.state !== (removing ? "absent" : "identical")) {
    const edit = editCodexConfig(before?.text ?? "", removing ? null : block);
    if (edit.ok) next = edit.text;
    else no = `${file}: ${edit.reason}`;
  }
  const oldRoles = planOldRoles(run);
  const plugin = planKit(run, KIT, bin);
  const reverse = reinstallCommand(removing ? "install" : "uninstall", "codex");

  return {
    problems: [...(no ? [no] : []), ...oldRoles.problems, ...plugin.problems],
    apply() {
      // The config is edited before Codex's own commands run: they rewrite the same file.
      if (leave) say(`# left alone: ${what} is not relay's (${foreign}). --force removes it.`);
      else if (next === null) say(removing ? `# ${file} has no [mcp_servers.relay]` : `# ${file} already has relay's block for this ${installKind()}`);
      else {
        say(removing ? `# remove relay's [mcp_servers.relay] tables from ${file}` : `# ${found.state === "absent" ? "add the block to" : "replace relay's block in"} ${file}`);
        writeFile(run, file, before, next, "config", {
          action: removing ? "removed" : found.state === "absent" ? "added" : "replaced",
          what: removing ? `removed relay's [mcp_servers.relay] tables from ${file}` : `${found.state === "absent" ? "added relay's block to" : "replaced the [mcp_servers.relay] tables in"} ${file}`,
          undo: `${reverse}${removing ? "" : " (takes out relay's tables only)"}`,
        });
      }
      if (!removing && next === null) note(run, "config", { action: "kept", what: `${file} already had relay's block`, backup: null, undo: reverse });
      oldRoles.apply();
      plugin.apply();
    },
  };
}


export const codexHost: HostDef = {
  id: "codex",
  target: "codex",
  name: "Codex",
  plan: planCodex,
  adapter: { dir: "codex", ref: skillRef, write: writeAdapter },
  registered() {
    try {
      const file = codexConfigFile();
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      if (text === null) return "none";
      const parsed = readToml(text);
      if (!parsed.ok) throw new Error(parsed.error);
      const entry = relayServer(parsed.data);
      return entriesState(entry);
    } catch {
      return "unknown";
    }
  },
  // The command is the CLI's own, documented under `codex login`. It reads stored credentials and
  // makes no model request. Relay prints only the method: no account, no key. Asked of relay's Codex
  // home, the login relay's Codex jobs run under (since 1.1.0), not of ~/.codex, which is the
  // person's own Codex sessions' and is not read by relay's jobs.
  doctorLogin(cfg, { line, warn, fail }) {
    const home = relayCodexHome(cfg);
    // A home that is not relay's is reported on the codex home line; its login is not relay's either.
    if (codexHomeProblem(cfg)) return line("codex login", `not checked: relay will not use ${home} as its Codex home (see the codex home line)`);
    const signIn = fs.existsSync(home) ? codexLoginCommand(cfg) : `relay install codex --write (which makes it), then ${codexLoginCommand(cfg)}`;
    // Codex refuses a CODEX_HOME that does not exist, with a message that names no login.
    if (!fs.existsSync(home)) return fail("codex login", `relay's Codex home ${home} does not exist yet, so relay's Codex jobs have no login. Run ${signIn}`);
    const r = spawnFound(cfg.targets.codex.bin, ["login", "status"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: home } });
    // Kept to the method: a key login is printed by Codex with part of the key.
    const said = first(`${r.stdout ?? ""}${r.stderr ?? ""}`).replace(/\s+-\s+.*$/, "").replace(/\bsk-\S+/g, "sk-…");
    if (/not logged in/i.test(said)) fail("codex login", `relay's Codex home ${home} is not signed in, according to \`codex login status\` there. Sign in once with ${signIn}`);
    else if (!r.error && r.status === 0 && said) line("codex login", `${said}, in relay's Codex home ${home} (as \`codex login status\` reports it there)`);
    else warn("codex login", `\`codex login status\` did not say; relay cannot tell whether its Codex home ${home} is signed in (${signIn})`);
  },
  doctorRegistration(cfg, present, { line, warn, registration }) {
    /** What doctor says of relay's registration, from Codex's own report or from its config.toml. */
    const inspect = (transport: Record<string, unknown>, rawTimeout: unknown, extra = "") => {
      const timeout = typeof rawTimeout === "bigint" ? Number(rawTimeout) : rawTimeout;
      registration("codex mcp", "codex", transport.command, transport.args, `${timeout ? `, tool_timeout_sec=${timeout}` : ""}${extra}`);
      for (const name of CODEX_MCP_ENV_VARS) if (!Array.isArray(transport.env_vars) || !transport.env_vars.includes(name)) {
        const why = name === "CODEX_HOME" ? "review withholding needs it to locate the caller's transcripts" : "T3 detection cannot work";
        warn("codex mcp", `missing env_vars entry for ${name}: ${why}. Update it: ${reinstallCommand("install", "codex")}`);
      }
      if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
        warn("", "no valid tool_timeout_sec: relay caps waits below Codex's 60 s default (50 s per call). Set an explicit positive timeout in config.toml for longer waits; restart the session after changing it");
      } else if (hostWaitCapS(timeout) < 2 * cfg.block_s) {
        warn("", `tool_timeout_sec=${timeout}: relay enforces a shared wait cap of ${hostWaitCapS(timeout)} s per call, including nested waits. Long waits return early (status says wait_ended), with pending events. Raise tool_timeout_sec in config.toml and restart the session if longer waits are needed`);
      }
    };
    // No Codex relay checked as a target (the target is disabled, or its pin is not in place):
    // relay runs no codex binary for it, so the registration is read from Codex's config.toml itself.
    if (!present.codex) {
      const file = codexConfigFile();
      let text: string;
      try { text = fs.readFileSync(file, "utf8"); } catch { return; } // no Codex configuration: nothing registered to inspect
      const parsed = readToml(text);
      if (!parsed.ok) return warn("codex mcp", `relay could not read ${file} (${parsed.error})`);
      const entry = relayServer(parsed.data);
      if (entry === undefined) return line("codex mcp", `relay NOT registered in ${file} (${reinstallCommand("install", "codex")})`);
      if (!isTable(entry)) return warn("codex mcp", `a server named relay is in ${file}, but not as a table relay can read`);
      return inspect(entry, entry.tool_timeout_sec, `; read from ${file}, without running Codex`);
    }
    const r = spawnFound(cfg.targets.codex.bin, ["mcp", "get", "relay", "--json"], { encoding: "utf8" });
    if (r.status !== 0 && NO_SERVER.test(`${r.stdout ?? ""}${r.stderr ?? ""}`)) line("codex mcp", `relay NOT registered (${reinstallCommand("install", "codex")})`);
    else if (r.status !== 0) warn("codex mcp", `\`codex mcp get relay --json\` failed: ${first(r.stderr ?? "") || `exit ${r.status}`}`);
    else {
      let got: unknown;
      try {
        got = JSON.parse(r.stdout);
      } catch {
        // Older output format; reported below.
      }
      const transport = isTable(got) && isTable(got.transport) ? got.transport : null;
      if (!transport) warn("codex mcp", "a server named relay is registered, but relay could not read what `codex mcp get relay --json` printed");
      else inspect(transport, (got as Record<string, unknown>).tool_timeout_sec);
    }
  },
};
