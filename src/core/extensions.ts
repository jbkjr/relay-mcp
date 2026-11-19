// Extensions for launched agents (docs/extensions.md): the skills and MCP servers a job or thread
// is given when the root session asks for them and the person consents. Here: what the config
// allows resolved into what one session holds, relay's own definitions of the servers (mcp.json),
// the filtered package of skills a turn gets, the consent text, and what an extension counts for
// in authority. The gateway that serves the servers' tools is src/mcp/gateway.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { canonical, configPath, expandHome, hasExtensions, inside, insideAnyCase, serverOf, type McpServerSetting, type RelayConfig, type Target } from "./config.js";
import { getNode, type NodeRow } from "./db.js";
import { mcpFile } from "./protected-config.js";
import { sessionParams } from "./params.js";
import { targetDef } from "../targets/index.js";

/** What a session holds, kept with it (SessionParams.extensions) from the call that started it. */
export interface SessionExtensions {
  /** Each skill by the name it goes to the agent under, and the directory it is copied from (its real path). */
  skills: { name: string; source: string }[];
  /** Each MCP server by its name in relay's mcp.json, with the tools that run without asking. */
  mcp_servers: { name: string; allow_tools: string[] }[];
  /** Set once the person has consented: who (in relay's words for the agent) and when. */
  consent?: { by: string; at: number } | null;
}

/** The plugin a Claude agent's skills come in, so that they are relay-skills:<name>. */
export const SKILLS_PLUGIN = "relay-skills";

/** The extensions a session holds, or undefined for none. */
export const extensionsOf = (n: Pick<NodeRow, "params_json"> | undefined): SessionExtensions | undefined => (n ? sessionParams(n).extensions ?? undefined : undefined);
/** Whether a session holds MCP servers: then it has no network, and only the person can allow its requests. */
export const holdsServers = (n: Pick<NodeRow, "params_json"> | undefined): boolean => Boolean(extensionsOf(n)?.mcp_servers.length);

// Relay's own definitions of the servers.

/** Where relay's MCP definitions are: mcp.json beside config.json (not synced; it may hold credentials). */
export { mcpFile };

/**
 * Relay's own config files, config.json and mcp.json, which say what launched agents may be given
 * and which servers run outside their sandboxes: each where relay looks for it and, if that is a
 * link, where the link leads (config.json is often a link into a synced repository).
 */
export function configFiles(): string[] {
  const out = new Set<string>();
  for (const f of [configPath(), mcpFile()]) {
    const at = path.resolve(expandHome(f));
    out.add(path.join(canonical(path.dirname(at)), path.basename(at)));
    out.add(canonical(at));
  }
  return [...out];
}

/**
 * The config file of relay's that changing `p` could change, or undefined: `p` is one of them (by
 * either name, and on macOS in any case), or a directory holding one. No grant may cover one, and
 * no file request change one.
 */
export function touchesConfig(p: string): string | undefined {
  return configFiles().find((f) => insideAnyCase(f, p));
}

/**
 * Every name relay's mcp.json has, if it exists: where relay looks for it and, if that is a link,
 * where the link leads. It may hold credentials, so launched Claude agents are denied reading it
 * (backends/claude.ts). Relay's Codex profile denies no reads (a profile could, with `deny`
 * entries), so a Codex agent can read it.
 */
export function mcpFileNames(): string[] {
  const at = path.resolve(expandHome(mcpFile()));
  if (!fs.existsSync(at)) return [];
  return [...new Set([at, path.join(canonical(path.dirname(at)), path.basename(at)), canonical(at)])];
}

const ServerDef = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().refine((p) => path.isAbsolute(expandHome(p)), "cwd must be an absolute path").optional(),
}).strict();
const McpFile = z.object({ mcpServers: z.record(z.string(), ServerDef) }).strict();
export type ServerDefinition = z.infer<typeof ServerDef>;

/** Relay's server definitions, read and checked strictly. Throws, saying what is wrong, never quoting a value (an env may hold a key). */
export function readMcpFile(file = mcpFile()): Record<string, ServerDefinition> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === "ENOENT" ? `relay's MCP definitions file ${file} does not exist` : `relay could not read its MCP definitions file ${file} (${code ?? "error"})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`relay's MCP definitions file ${file} is not valid JSON`);
  }
  const r = McpFile.safeParse(raw);
  if (!r.success) throw new Error(`relay's MCP definitions file ${file} is not valid: ${r.error.issues.map((i) => `${i.path.join(".") || "(top level)"}: ${i.message}`).join("; ")}. Each server is { "command", "args", "env", "cwd" } under "mcpServers" (stdio servers only)`);
  return r.data.mcpServers;
}

// Skills.

/** Where the person's own user skills are, in lookup order. `env` is the root relay
 * process's environment, before selectEnvironment replaces Codex's runtime CODEX_HOME. */
export function skillRoots(target: Target, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || os.homedir();
  if (target === "claude") return [path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "skills")];
  if (target === "codex") return [path.join(env.CODEX_HOME || path.join(home, ".codex"), "skills"), path.join(home, ".agents", "skills")];
  return [];
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
/** Whether a directory is a skill directory: it holds a SKILL.md, whether relay can give it or not (checkSkill says). */
const hasSkill = (dir: string) => {
  try {
    return isDir(dir) && Boolean(fs.lstatSync(path.join(dir, "SKILL.md")));
  } catch {
    return false;
  }
};
/** Whether a file name is SKILL.md's in any case: on a case-insensitive disk (macOS's, by default) a harness opening SKILL.md opens it. */
const isSkillFile = (name: string) => name.toLowerCase() === "skill.md";

/**
 * How many levels below a root Codex finds a skill directory: codex-cli 0.163.0 (observed) looked
 * six deep, inside skill directories too, never in a dot-directory, and only for a file named
 * exactly SKILL.md. Relay looks as deep (codexSkillFiles, userSkillDirs).
 */
const CODEX_DEPTH = 6;

/**
 * The skill directories of one root of the person's, by the name each goes under, as the target's
 * CLI finds them: Claude Code takes each directory directly in the root (as it does a plugin's
 * skills/); Codex also looks inside a directory that is not a skill itself (a group), as deep as
 * CODEX_DEPTH. Dot-directories are left out ($CODEX_HOME/skills/.system).
 */
function userSkillDirs(root: string, target: Target): { name: string; dir: string }[] {
  const out: { name: string; dir: string }[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      const real = fs.realpathSync(dir);
      if (seen.has(real)) return;
      seen.add(real);
      entries = fs.readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
    } catch {
      return;
    }
    for (const n of entries) {
      const sub = path.join(dir, n);
      if (hasSkill(sub)) out.push({ name: n, dir: sub });
      else if (target === "codex" && depth + 1 < CODEX_DEPTH && isDir(sub)) walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Why a skill directory cannot go into a package, or that it is a person's slash command only
 * (its front matter sets disable-model-invocation to anything but a plain false: the model may
 * never load it, so a launched agent, where nobody types slash commands, could not use it).
 */
function checkSkill(dir: string): { problem: string } | { userOnly: true } | null {
  const file = path.join(dir, "SKILL.md");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { problem: `${dir} holds no SKILL.md` };
  }
  // Read through a link, a SKILL.md would be checked here and then left out of the copy (which takes regular files only).
  if (st.isSymbolicLink()) return { problem: `${file} is a symbolic link, and relay copies only a skill's regular files, so the skill would reach the agent without it` };
  if (!st.isFile()) return { problem: `${file} is not a regular file` };
  const named = fs.readdirSync(dir).filter(isSkillFile);
  if (!named.includes("SKILL.md")) return { problem: `${dir} names its SKILL.md ${named.join(", ")}: relay reads only a file named exactly SKILL.md` };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { problem: `relay could not read ${file}` };
  }
  const split = splitSkill(text);
  if (typeof split === "string") return { problem: `${file}: ${split}` };
  if (!split.blocks.some((b) => b.key === "description")) return { problem: `${file} has no description` };
  if (modelBarred(split.blocks)) return { userOnly: true };
  // A skill larger than the package takes cannot reach the agent whole: refused now, not after the person consents.
  try {
    eachPackaged(dir, path.basename(dir), () => {});
  } catch (err) {
    return { problem: (err as Error).message };
  }
  return null;
}

/**
 * Whether front matter keeps the model from loading a skill: disable-model-invocation given as
 * anything but a plain false (Claude Code reads true, "yes", "on", "1"… as true). Fail-closed: a
 * value relay cannot read for certain as false counts as true. The key is not copied either way.
 */
function modelBarred(blocks: { key: string; lines: string[] }[]): boolean {
  const b = blocks.find((x) => x.key === "disable-model-invocation");
  if (!b) return false;
  const more = b.lines.slice(1).some((l) => l.trim() && !l.trimStart().startsWith("#"));
  const value = b.lines[0].slice(b.lines[0].indexOf(":") + 1).replace(/[ \t]+#.*$/, "").trim();
  return more || !/^(["']?)(?:false|no|off|0)\1$/i.test(value);
}

/** The skills targets.<id>.skills selects, by name and real source directory, or why it cannot be given. */
export function resolveSkills(setting: RelayConfig["targets"][Target]["skills"], target: Target, env: NodeJS.ProcessEnv = process.env): SessionExtensions["skills"] | { reason: string } {
  if (setting === undefined || setting === "none") return [];
  const roots = skillRoots(target, env);
  const found: SessionExtensions["skills"] = [];
  const add = (name: string, dir: string): string | null => {
    if (!SKILL_NAME.test(name)) return `the skill directory ${dir} has a name relay cannot give a skill (letters, digits, '.', '_', '-')`;
    if (found.some((s) => s.name === name)) return `two skills would both be called ${name}`;
    found.push({ name, source: fs.realpathSync(dir) });
    return null;
  };
  if (setting === "user") {
    // Every skill the CLI would find in the person's roots; for a name found twice, the first (in
    // root order, then by path). A slash command only a person can use is left out.
    for (const root of roots) {
      for (const { name, dir } of userSkillDirs(root, target)) {
        if (found.some((s) => s.name === name)) continue;
        const check = checkSkill(dir);
        if (check && "userOnly" in check) continue;
        const why = check ? check.problem : add(name, dir);
        if (why) return { reason: `${why}, so relay cannot give your user skills` };
      }
    }
    if (!found.length) return { reason: `targets.${target}.skills is "user", but there are no skills in ${roots.join(" or ")} that a launched agent could load` };
    return found;
  }
  for (const ref of setting) {
    const isPath = ref.startsWith("/") || ref.startsWith("~/");
    // A name is a skill the CLI itself would find under that name, as under "user" (for Codex, one in a group directory too).
    const dir = isPath ? path.resolve(expandHome(ref)) : roots.map((r) => userSkillDirs(r, target).find((s) => s.name === ref)?.dir).find(Boolean);
    if (!dir || !hasSkill(dir)) {
      return { reason: isPath ? `the skill ${ref} in targets.${target}.skills is not a directory holding a SKILL.md` : `the skill ${ref} in targets.${target}.skills is not in ${roots.join(" or ")}` };
    }
    const check = checkSkill(dir);
    if (check && "userOnly" in check) {
      return { reason: `the skill ${ref} in targets.${target}.skills sets disable-model-invocation, so only a person typing its slash command can use it, and a launched agent could never load it` };
    }
    const why = check ? check.problem : add(path.basename(dir), dir);
    if (why) return { reason: why };
  }
  return found;
}

/**
 * The front-matter keys a skill keeps in the package. Anything else (allowed-tools, hooks, model,
 * context, agent…) could pre-approve tools, run hooks or start other agents. user-invocable is
 * dropped too: Claude Code 2.1.302 leaves a skill with user-invocable false out of its init
 * report, where relay checks that every given skill loaded, and a launched agent has nobody
 * typing slash commands. disable-model-invocation is read first (checkSkill), then dropped.
 */
const KEPT_KEYS = new Set(["name", "description", "license", "metadata", "argument-hint"]);

/** A top-level key's line, as a YAML reader takes one: a bare key at the start of the line, then a colon and a space or the end of the line. */
const KEY_LINE = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]|$)/;
/** An item of a block sequence written at the start of the line, under the key above it. */
const ITEM_LINE = /^-(?:[ \t]|$)/;

/**
 * A SKILL.md split into its front-matter blocks (a key's line and the lines that continue it) and
 * its body, or why relay will not read it. It fails closed: a line that starts at the left margin
 * must be a bare key (KEY_LINE), an item of the sequence above it, a comment or blank; indented
 * lines continue the block above. Anything else at the margin (a quoted key, a `?` or `<<` key, a
 * flow collection, an anchor, a tag, a tab, a document marker) is refused, since a YAML reader
 * could take it for a key relay did not see; so are a key given twice and line breaks other than
 * \n, which a reader may split lines at where relay does not.
 */
function splitSkill(text: string): { blocks: { key: string; lines: string[] }[]; body: string } | string {
  const lf = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(lf);
  if (!m) return "it has no front matter (--- … ---) relay can read";
  if (/[\r\u0085\u2028\u2029]/.test(m[1])) return "its front matter has a line break other than \\n, which relay does not read";
  const blocks: { key: string; lines: string[] }[] = [];
  for (const [i, line] of m[1].split("\n").entries()) {
    const key = KEY_LINE.exec(line)?.[1];
    if (key) {
      if (blocks.some((b) => b.key === key)) return `its front matter gives ${key} twice`;
      blocks.push({ key, lines: [line] });
    } else if (!line.trim() || line.startsWith("#") || (line.startsWith(" ") && line.trim().length)) {
      if (blocks.length) blocks.at(-1)!.lines.push(line);
      else if (line.trim() && !line.trimStart().startsWith("#")) return "its front matter starts with an indented line, which relay does not read";
    } else if (ITEM_LINE.test(line) && blocks.length) blocks.at(-1)!.lines.push(line);
    else return `line ${i + 2} of its front matter is not a plain key (key: value), an indented line, a list item or a comment, so relay cannot tell which keys it holds`;
  }
  return { blocks, body: lf.slice(m[0].length) };
}

/** A SKILL.md as it goes into the package: its front matter cut to KEPT_KEYS, named `name`, its body unchanged. */
export function filteredSkill(text: string, name: string): string {
  const split = splitSkill(text);
  if (typeof split === "string") throw new Error(split);
  const kept = split.blocks.filter((b) => KEPT_KEYS.has(b.key) && b.key !== "name").flatMap((b) => b.lines);
  return ["---", `name: ${name}`, ...kept, "---", split.body].join("\n");
}

/** The most a package copies of one skill: beyond it the skill is refused, not cut. */
const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;
/** Harness metadata at a skill's top (Codex reads MCP dependencies from these), in lower case: left out by any case of the name, which a disk that ignores case (macOS's, by default) opens as the same. */
const METADATA = new Set(["agents", "skill.json"]);

/**
 * Walks what a skill's package takes from `dir`, in order: each directory, then what it holds, and
 * each regular file, by its path relative to `dir`, with its stats. Left out are dot-files, harness
 * metadata at the top (agents/, SKILL.json, in any case), every SKILL.md in any case but the top
 * one by exactly that name (Codex would load one below the top as a skill of its own, unfiltered),
 * and symlinks and anything else that is not a regular file or a directory (a link could lead
 * anywhere). Throws, naming the skill, when it holds more than relay copies: it is refused, not cut.
 */
function eachPackaged(dir: string, name: string, visit: (rel: string, st: fs.Stats) => void): void {
  let files = 0;
  let bytes = 0;
  const walk = (rel: string, top: boolean) => {
    for (const entry of fs.readdirSync(path.join(dir, rel)).sort()) {
      if (entry.startsWith(".") || (top && METADATA.has(entry.toLowerCase()))) continue;
      if (isSkillFile(entry) && !(top && entry === "SKILL.md")) continue;
      const r = path.join(rel, entry);
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory()) {
        visit(r, st);
        walk(r, false);
      } else if (st.isFile()) {
        if (++files > MAX_FILES || (bytes += st.size) > MAX_BYTES) throw new Error(`the skill ${name} (${dir}) is larger than relay copies (${MAX_FILES} files, ${MAX_BYTES / 1024 / 1024} MB)`);
        visit(r, st);
      }
    }
  };
  walk("", true);
}

/**
 * Builds a turn's package of skills under `root`, a directory of relay's own (in the node's
 * directory, which no agent can write): root/skills/<name>/ for each skill and, for Claude
 * (`plugin`), root/.claude-plugin/plugin.json, which makes the package a plugin. Codex gets no
 * manifest: with one, codex-cli 0.163.0 names every skill under the root <plugin>:<name>.
 * Copied is what eachPackaged walks: the skill's regular files only, without symlinks, dot-files,
 * harness metadata or a SKILL.md below its top. SKILL.md's front matter is filtered
 * (filteredSkill). Throws, naming the skill, for one it cannot copy whole.
 */
export function buildSkillPackage(root: string, skills: SessionExtensions["skills"], o: { plugin: boolean }): void {
  fs.mkdirSync(path.join(root, "skills"), { recursive: true, mode: 0o700 });
  if (o.plugin) {
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: SKILLS_PLUGIN, version: "1.0.0", description: "Skills relay gave this agent: each skill's regular files, without hooks, MCP servers, agent definitions or pre-approved tools." }, null, 2));
  }
  for (const s of skills) {
    const dest = path.join(root, "skills", s.name);
    try {
      // Checked again, size included: the skill may have changed since the call.
      const check = checkSkill(s.source);
      if (check) throw new Error("problem" in check ? check.problem : "it now sets disable-model-invocation, so the agent could not load it");
      fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
      eachPackaged(s.source, s.name, (rel, st) => {
        const from = path.join(s.source, rel);
        const to = path.join(dest, rel);
        if (st.isDirectory()) fs.mkdirSync(to, { recursive: true, mode: 0o700 });
        else if (rel === "SKILL.md") fs.writeFileSync(to, filteredSkill(fs.readFileSync(from, "utf8"), s.name));
        else fs.copyFileSync(from, to);
      });
      if (!fs.lstatSync(path.join(dest, "SKILL.md")).isFile()) throw new Error("its SKILL.md was not copied");
    } catch (err) {
      throw new Error(`relay could not package the skill ${s.name} from ${s.source}: ${(err as Error).message}`);
    }
  }
}

/**
 * The SKILL.md files runtime Codex would find for a turn in `cwd` (codex-cli 0.163.0, observed):
 * its own runtime CODEX_HOME/skills including .system, the shared ~/.agents/skills, the repository's
 * (.agents/skills and .codex/skills in every directory from cwd up to the repository's top) and the
 * machine's (/etc/codex/skills). Each by the path found and its real path. Relay switches them off
 * for every turn, and then checks what Codex will load, so a place missed here stops the
 * turn rather than letting a skill through. Unlike skillRoots, `env` is the selected child
 * environment: the person's original CODEX_HOME is only a consent/copy source.
 */
export function codexSkillFiles(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || os.homedir();
  const roots = [path.join(env.CODEX_HOME || path.join(home, ".codex"), "skills"), path.join(home, ".agents", "skills"), "/etc/codex/skills"];
  const system = path.join(roots[0], ".system");
  roots.push(system);
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    roots.push(path.join(dir, ".agents", "skills"), path.join(dir, ".codex", "skills"));
    if (fs.existsSync(path.join(dir, ".git")) || dir === home || path.dirname(dir) === dir) break;
  }
  const out = new Set<string>();
  // 0.163.0 installs these bundled skills on its first start, including under a fresh HOME.
  // Disable their future paths too; an upstream addition still refuses at skills/list.
  for (const name of ["imagegen", "openai-docs", "review-agent", "skill-creator", "skill-installer"]) {
    out.add(path.join(system, name, "SKILL.md"));
    out.add(path.join(canonical(system), name, "SKILL.md"));
  }
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real) || depth > CODEX_DEPTH) return;
    seen.add(real);
    const md = path.join(dir, "SKILL.md");
    if (fs.existsSync(md)) {
      out.add(md);
      out.add(path.join(real, "SKILL.md"));
    }
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries.sort()) if (!e.startsWith(".") && isDir(path.join(dir, e))) walk(path.join(dir, e), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return [...out];
}

/**
 * The names of the skills Claude Code would load by itself for a turn in `cwd`, were relay's
 * settings not isolating it: the person's ($CLAUDE_CONFIG_DIR/skills or ~/.claude/skills) and the
 * repository's (.claude/skills in every directory from cwd up to the repository's top). Under
 * `--setting-sources ""` none of them loads (observed with Claude Code 2.1.302). Under inherited
 * settings these names receive skillOverrides "off" too; every turn's init report is checked.
 */
export function claudeSkillNames(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || os.homedir();
  const roots = skillRoots("claude", env);
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    roots.push(path.join(dir, ".claude", "skills"));
    if (fs.existsSync(path.join(dir, ".git")) || dir === home || path.dirname(dir) === dir) break;
  }
  return [...new Set(roots.flatMap((r) => userSkillDirs(r, "claude").map((s) => s.name)))];
}

// What a session is given, from the call.

/** The tools of a server entry that run without asking. */
const allowTools = (e: McpServerSetting): string[] => (typeof e === "string" ? [] : [...(e.allow_tools ?? [])]);

/** Why a target takes no extensions, or null: an ACP harness runs inside relay's own sandbox, which a skill or server from outside would cross. */
export function takesNone(target: Target): string | null {
  const def = targetDef(target);
  return def.capabilities.extensions ? null : `relay gives extensions only to Claude and Codex agents; ${def.name} runs inside relay's own sandbox and takes none. Omit extensions.`;
}

/**
 * The extensions the config allows for `target`, resolved for one session: the skills found now,
 * and the servers, each checked against relay's mcp.json. Or why none can be given.
 */
export function resolveExtensions(cfg: RelayConfig, target: Target, env: NodeJS.ProcessEnv = process.env): SessionExtensions | { reason: string } {
  const none = takesNone(target);
  if (none) return { reason: none };
  const t = cfg.targets[target];
  if (!hasExtensions(t)) return { reason: `relay's config allows no extensions for ${target} (targets.${target}.skills or targets.${target}.mcp_servers), so there are none to give. Omit extensions, or ask the user to allow some.` };
  const mcp_servers = (t.mcp_servers ?? []).map((e) => ({ name: serverOf(e), allow_tools: allowTools(e) }));
  if (mcp_servers.length) {
    let defs: Record<string, ServerDefinition>;
    try {
      defs = readMcpFile();
    } catch (err) {
      return { reason: `${(err as Error).message}, so relay cannot give ${target} agents the MCP servers its config names (${mcp_servers.map((s) => s.name).join(", ")}). Omit extensions, or ask the user to define them there.` };
    }
    const missing = mcp_servers.filter((s) => !Object.hasOwn(defs, s.name)).map((s) => s.name);
    if (missing.length) return { reason: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} named in targets.${target}.mcp_servers but not defined in ${mcpFile()}. Omit extensions, or ask the user to define ${missing.length === 1 ? "it" : "them"} there.` };
  }
  const skills = resolveSkills(t.skills, target, env);
  if ("reason" in skills) return { reason: `${skills.reason}. Omit extensions, or ask the user to fix targets.${target}.skills.` };
  return { skills, mcp_servers, consent: null };
}

// What is said about them.

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** A server as the consent text and prompts name it: with the tools that run without asking. */
const serverLine = (s: SessionExtensions["mcp_servers"][number]) =>
  s.allow_tools.length ? `${s.name} (${list(s.allow_tools)} without asking you; every other tool asks you)` : `${s.name} (every tool asks you)`;

/** The text of the request for consent to a session's extensions: every extension, named. */
export function consentText(node: Pick<NodeRow, "target" | "kind">, ext: SessionExtensions): string {
  const parts = [
    ...(ext.skills.length ? [`skills ${ext.skills.map((s) => s.name).join(", ")}`] : []),
    ...(ext.mcp_servers.length ? [`MCP servers ${ext.mcp_servers.map(serverLine).join(", ")}`] : []),
  ];
  return `give this ${node.target ? targetDef(node.target).name : ""} ${node.kind === "thread" ? "thread" : "job"} these extensions for the rest of it: ${parts.join("; ")}`.replace(/\s+/g, " ");
}

/**
 * What allowing that request does, for the person to read (a request's effect): from what the
 * session was given. Only a session given MCP servers has their limits (no network, no write paths,
 * no relay delegating, every request of its the person's alone); skills alone change nothing of
 * what it may do. Relay's limit on delegating is on other relay agents: the harness's own subagents
 * (Claude's Task tool) work inside the same agent, its sandbox and relay's gate.
 */
export function consentEffect(node: Pick<NodeRow, "kind">, ext: SessionExtensions | undefined): string {
  const item = node.kind === "thread" ? "thread" : "job";
  const skills = ext?.skills.length
    ? `copies of these skills (their instruction files and scripts, without hooks, MCP servers, agent definitions or pre-approved tools), which the agent reads and runs through its own sandboxed tools`
    : "";
  if (!ext?.mcp_servers.length) return `gives it ${skills || "these extensions"} for the rest of the ${item}`;
  // A thread is read-only: it has no write paths to be refused.
  const limits = item === "job" ? "no network and no write paths outside its worktree" : "no network";
  return `gives it ${skills ? `${skills}, and ` : ""}these MCP servers for the rest of the ${item}: the servers run outside its sandbox as your own processes, every call of their tools asks you unless named as running without asking, ` +
    `the ${item} gets ${limits}, may not start or steer other relay agents while it has them (its own CLI's subagents work under the same sandbox and gate), and only you can allow its requests`;
}

/** What a session's extensions look like in status, result and a starting call's answer. */
export function extensionsView(ext: SessionExtensions, o: { consent?: boolean } = {}): Record<string, unknown> {
  return {
    skills: ext.skills.map((s) => s.name),
    // allow_tools as relay's config names them: the tools that run without asking the user.
    mcp_servers: ext.mcp_servers.map((s) => ({ name: s.name, allow_tools: s.allow_tools })),
    ...(o.consent === false ? {} : { consent: ext.consent ? `given ${ext.consent.by}` : "not given yet: the user is asked before the agent starts" }),
  };
}

/** One line for relay tree: every extension a session was given, and whether the person has consented. */
export function extensionsSummary(ext: SessionExtensions): string {
  const parts = [
    ...(ext.skills.length ? [`skills ${ext.skills.map((s) => s.name).join(", ")}`] : []),
    ...(ext.mcp_servers.length ? [`MCP servers ${ext.mcp_servers.map((s) => (s.allow_tools.length ? `${s.name} (${s.allow_tools.join(", ")} without asking)` : s.name)).join(", ")}`] : []),
  ];
  return `${parts.join("; ")}; consent ${ext.consent ? `given ${ext.consent.by}` : "not given yet"}`;
}

/** What the agent is told it has, in its preamble. */
export function extensionsLine(target: Target, ext: SessionExtensions): string {
  const parts: string[] = [];
  if (ext.skills.length) {
    const names = ext.skills.map((s) => (target === "claude" ? `${SKILLS_PLUGIN}:${s.name}` : s.name));
    parts.push(`skills ${names.join(", ")} (load one when it applies${target === "claude" ? ", with the Skill tool" : ""})`);
  }
  if (ext.mcp_servers.length) {
    const servers = ext.mcp_servers.map((s) => (s.allow_tools.length ? `${s.name} (${list(s.allow_tools)} run at once; every other tool waits for the user's yes)` : `${s.name} (every tool waits for the user's yes)`));
    parts.push(
      `MCP servers through relay's tools named <server>__<tool>: ${servers.join(", ")}. A call the user refuses comes back as an error: do not try to reach that service another way (you have no network for it); continue without it and say what you needed. ` +
        "A server whose tools you do not have could not be started for this turn (relay's server instructions say why): work without it and say so",
    );
  }
  return `Extensions the user consented to before you started: ${parts.join("; ")}.`;
}

// Authority.

/**
 * What a session's extensions count for in authority (caller.ts authority): each skill by its
 * source, each server, and each tool of one that runs without asking. A launched agent may act on
 * an item only if it holds none of these that the agent's own session does not.
 */
export function extensionKeys(ext: SessionExtensions | undefined): string[] {
  if (!ext) return [];
  return [
    ...ext.skills.map((s) => `skill:${s.source}`),
    ...ext.mcp_servers.flatMap((s) => [`mcp:${s.name}`, ...s.allow_tools.map((t) => `mcp:${s.name}:${t}`)]),
  ];
}

/** Request kinds only the person can allow. */
const PERSON_KINDS = new Set(["extensions", "mcp", "env", "local_network", "raw_network"]);

/**
 * Whether only the person may allow a request: consent to extensions, a call of an extension's
 * tool, release of environment values, consent to a Codex job's local network or raw network, and every request of a session that holds MCP servers (a command outside the sandbox, the
 * web or a file outside the worktree would each be a way round relay's gate).
 */
export function personOnly(r: { kind: string; node_id: string; detail_json?: string | null }): boolean {
  if (r.kind === "escalation") {
    // Read the authoritative row when a notification passes only its kind/node projection.
    const raw = r.detail_json;
    if (raw) {
      try { if (JSON.parse(raw).escalation?.required_decider === "person") return true; } catch { return true; }
    }
  }
  return PERSON_KINDS.has(r.kind) || holdsServers(getNode(r.node_id));
}

/**
 * Where the person can allow a person-only request: relay's question in the root session, where
 * its host is known to show the question to a person, and the host's own permission prompt
 * through confirm. Not a command (`relay approve`): any agent with a shell tool can run one, with
 * a terminal of its own if it wants. Review C2/X1 requires person-only consent and names no route;
 * these two are the lane's choice (plan-1.0.md A6, reading (5)).
 */
export const PERSON_ROUTES = "in relay's question in the root session, where its host shows it to them, or in the host's permission prompt through confirm";

/** Why `relay approve` does not allow this request, or null: only the person may allow it, and a command could be any agent's. */
export function commandRefusal(r: { id: string; kind: string; node_id: string }): string | null {
  if (!personOnly(r)) return null;
  return `only the user can allow ${r.id}, and relay takes that only ${PERSON_ROUTES}, never from a command, which any agent with a shell could run. ` +
    `relay deny ${r.id} denies it.`;
}

// The gateway's per-turn manifest.

/** What a turn's gateway is told (src/mcp/gateway.ts): where the definitions are, which servers, and where to report. */
export interface GatewayManifest {
  /** Written only by the worker; used for durable policy checkpoints before forwarding. */
  run_id?: string;
  mcp_file: string;
  servers: SessionExtensions["mcp_servers"];
  /** Where the gateway writes what it started and what it could not, for the turn's result. */
  report: string;
}

/** Writes a turn's gateway manifest into its extensions directory (relay's own) and returns its path. */
export function writeManifest(dir: string, servers: SessionExtensions["mcp_servers"], runId?: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "gateway.json");
  const manifest: GatewayManifest = { mcp_file: mcpFile(), servers, report: path.join(dir, "gateway-report.json"), ...(runId ? { run_id: runId } : {}) };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return file;
}

/** What the gateway reported for the turn, as warnings for its result. */
export function gatewayWarnings(dir: string): string[] {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, "gateway-report.json"), "utf8")) as { warnings?: unknown };
    return Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}

/** Whether a manifest path is one relay wrote: in relay's control directory. */
export const ownManifest = (file: string, home: string): boolean => inside(file, home);
