// Relay's configuration decides authority just as its registry does. Keep this list shared by
// admission, file approvals and both sandbox policies. Do not turn a broad config directory into
// a protected tree: RELAY_CONFIG and symlinks may put a single file in a project or the home folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonical, configPath, inside, insideAnyCase, loadConfig, overlapsEntryAnyCase, relayHome, worktreesHome, DEFAULT_CONFIG, relayCodexHome, relayCodexPinStore, type RelayConfig } from "./config.js";
import { developerDirs, findExecutable, gitExecutable, testSystemTools, XCRUN_SHIMS } from "./executables.js";
import { git } from "./git.js";
import { TARGET_IDS, targetDef } from "../targets/index.js";

export const installRecordPath = () => path.join(path.dirname(configPath()), "install.json");
export const installBackupsPath = () => path.join(path.dirname(configPath()), "install-backups");
/**
 * Relay's local config: machine-local settings that must never be synced (api-keys.ts reads it),
 * which say which API key file relay reads for a key-only target, and so whose account that target
 * runs on. `~/.config/relay/local.json`, wherever RELAY_HOME or RELAY_CONFIG put the config, so
 * every relay process on the machine reads the same one. One of relay's own files: protected with
 * them, and no reason to protect its directory less.
 */
export const localConfigPath = (): string => path.join(os.homedir(), ".config", "relay", "local.json");
/** Relay's MCP server definitions (docs/extensions.md): beside config.json, machine-local, never synced. */
export const mcpFile = (): string => path.join(path.dirname(configPath()), "mcp.json");

const under = (p: string, d: string) => p === d || p.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
/** Include the name of a symlink as well as its destination, including missing tails. */
export const pathOverlaps = (a: string, b: string): boolean =>
  under(path.resolve(a), path.resolve(b)) || under(path.resolve(b), path.resolve(a)) || inside(a, b) || inside(b, a);

export function configProtection(): { paths: string[]; directories: string[]; fileOnly: { directory: string; reason: string }[] } {
  const configured = path.resolve(configPath());
  // mcp.json says which servers run outside launched agents' sandboxes, so it is protected like
  // config.json, also while it does not exist: a job that wrote one would define what they run.
  const originals = [configured, mcpFile(), installRecordPath(), installBackupsPath()].map((p) => path.resolve(p));
  // A missing config is valid: keep its configured name without realpathSync on a missing file.
  const named = (p: string) => fs.existsSync(p) ? [p, fs.realpathSync(p)] : [p];
  const files = [...new Set(originals.flatMap(named))];
  // The local config is protected as relay's file wherever it is, and counts as relay's in the
  // directory test below; only the config's own directories are judged for whole protection.
  const local = named(path.resolve(localConfigPath()));
  const directories: string[] = [];
  const fileOnly: { directory: string; reason: string }[] = [];
  for (const directory of new Set(files.map((p) => path.dirname(p)))) {
    let reason: string | null = null;
    if ([os.homedir(), relayHome(), worktreesHome()].some((p) => inside(p, directory))) {
      reason = "it is or contains the home, control or worktrees directory";
    } else {
      const repo = git(directory, ["rev-parse", "--show-toplevel"]);
      if (repo.ok && repo.out && inside(repo.out, directory)) reason = "it is or contains a git work tree";
    }
    if (!reason) {
      try {
        const names = new Set([...files, ...local].filter((p) => path.dirname(p) === directory).map((p) => path.basename(p)));
        if (fs.readdirSync(directory).some((n) => !names.has(n))) reason = "it holds files other than relay's config and install files";
      } catch { reason = "relay cannot read the directory to establish that it is dedicated to relay"; }
    }
    if (reason) {
      // The control directory already has whole-tree protection, independently of this list.
      if (!inside(directory, relayHome())) fileOnly.push({ directory, reason });
    } else directories.push(directory);
  }
  return { paths: [...new Set([...files, ...local, ...directories])], directories, fileOnly };
}

/**
 * Relay's own installation: the package the running code was loaded from, which holds dist/ (this
 * module is dist/core/protected-config.js), package.json and relay's native helper. Relay runs that
 * code outside every sandbox: at its next start (dist/*.js) and, while it runs, dist/native's
 * sandbox_check helper. So no job may write there (review r_0c11d860 X1). Always the running copy,
 * never a configured one: a test or a development checkout protects itself.
 */
export const relayPackageRoot = (): string => path.resolve(import.meta.dirname, "..", "..");

/** A part of what relay runs outside any sandbox: why it matters, and a path naming it. */
export interface InstalledPart { what: string; path: string }

/** Defaults, machine config and a run's saved config stay protected together. */
export function relayCodexProtected(cfg?: RelayConfig): { homes: InstalledPart[]; stores: InstalledPart[] } {
  const configs = [DEFAULT_CONFIG, loadConfig(() => {}), ...(cfg ? [cfg] : [])];
  const parts = (paths: string[], what: string) => [...new Set(paths)].flatMap((p) => {
    // Resolve existing ancestors as well: the root need not have been bootstrapped yet.
    return [...new Set([p, canonical(p)])].map((path) => ({ what, path }));
  });
  return {
    homes: parts(configs.map(relayCodexHome), "relay's Codex credential home"),
    stores: parts(configs.map(relayCodexPinStore), "relay's qualified Codex pin store"),
  };
}
export const relayCredentialProtected = (cfg?: RelayConfig): InstalledPart[] => relayCodexProtected(cfg).homes;

const realOf = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};
/** Prefixes many installations share: an executable's directory there is no package of its own. */
const SHARED_PREFIXES = new Set(["/", "/usr", "/usr/local", "/opt/homebrew", "/opt/local", os.homedir()]);
/**
 * The directory an executable was installed as a whole with, when relay can tell: a Homebrew keg
 * (Cellar/<name>/<version>, Caskroom/<name>/<version>), the npm package that holds it (the nearest
 * directory with a package.json below a node_modules), or a Node distribution's prefix (bin/node
 * beside include/node, as fnm, nvm and the official tarballs lay it out). Writing anywhere in it
 * could change what the executable loads, not only the file itself. Null when none is found.
 */
export function installDirOf(real: string): string | null {
  const keg = /^(.*\/(?:Cellar|Caskroom)\/[^/]+\/[^/]+)(?:\/|$)/.exec(real);
  if (keg) return keg[1];
  if (real.split(path.sep).includes("node_modules")) {
    for (let dir = path.dirname(real); path.basename(dir) !== "node_modules" && path.dirname(dir) !== dir; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    }
  }
  const bin = path.dirname(real);
  const prefix = path.dirname(bin);
  if (path.basename(bin) === "bin" && path.basename(real).startsWith("node") && !SHARED_PREFIXES.has(prefix) && fs.existsSync(path.join(prefix, "include", "node"))) return prefix;
  return null;
}

/**
 * One executable's parts: the name relay starts (findExecutable's: a link's own name, on purpose),
 * the file it leads to, and the installation holding that. All three are protected alike.
 */
function executableParts(what: string, named: string): InstalledPart[] {
  const real = realOf(named);
  const dir = real ? installDirOf(real) : null;
  return [
    { what, path: named },
    ...(real && real !== named ? [{ what, path: real }] : []),
    ...(dir ? [{ what: `the installation of ${what}`, path: dir }] : []),
  ];
}

/**
 * What relay itself runs on and from: its package (relayPackageRoot), by its name and real path,
 * the Node binary running it (with its installation), and the git it runs (executables.ts
 * gitExecutable: the name on PATH, the file it leads to and its Homebrew keg; for the xcrun shim
 * /usr/bin/git, the developer directories whose git the shim runs). Every Seatbelt profile relay
 * writes denies writing these, and so does Claude's sandbox; no grant may cover them.
 */
export function relayRuntime(): InstalledPart[] {
  const root = relayPackageRoot();
  const real = realOf(root);
  const gitBin = gitExecutable();
  const gitReal = gitBin ? realOf(gitBin) : null;
  return [
    { what: "relay's own installation", path: root },
    ...(real && real !== root ? [{ what: "relay's own installation", path: real }] : []),
    ...executableParts("the Node binary relay runs on", process.execPath),
    ...(gitBin ? executableParts("the git relay runs", gitBin) : []),
    ...(gitReal && XCRUN_SHIMS.has(gitReal) ? developerDirs().map((d) => ({ what: "the developer tools whose git /usr/bin/git runs", path: d })) : []),
  ];
}

/**
 * The directories on relay's PATH: where relay found the programs it runs, and where a program put
 * by a job would be found before them by a later lookup (a new process of relay's, your own shell).
 * No grant may cover one (caller.ts grantPathProblem), and no file request may write in one.
 */
export function relayPathDirs(searchPath: string = process.env.PATH ?? ""): string[] {
  // With the stand-ins' directory of a test of the terminal commands, where honoured (executables.ts testSystemTools).
  const dirs = [...searchPath.split(path.delimiter), testSystemTools() ?? ""];
  return [...new Set(dirs.filter((d) => d && path.isAbsolute(d)).map((d) => path.resolve(d)))];
}

/** Whether `p` and a protected `part` overlap: either holds the other, by any case or data-volume name, or `p` covers or names a link `part` by its own name. */
export const overlapsPart = (p: string, part: string): boolean => insideAnyCase(p, part) || insideAnyCase(part, p) || overlapsEntryAnyCase(p, part);

/**
 * relayRuntime, and every target CLI relay could start outside any sandbox (codex app-server,
 * claude, gemini and the others, and their version probes): for each target, enabled or not (one
 * enabled later would run what a grant given now let a job write), its configured `bin` and its
 * default name, each as found on PATH now, the file it leads to, and that file's installation
 * (installDirOf). What no grant may overlap, new or kept (caller.ts grantPathProblem). A grant's
 * paths are checked against this when given and on every later turn that keeps them.
 * This deliberately includes interactive Codex even when launches use the sealed pin: the
 * configured/default CLI remains a possible executable (including an explicit pin opt-out).
 * Protect its resolved installation too, not only the stable symlink: a write through another
 * name in that installation could change what the CLI loads. Package-manager replacements
 * therefore invalidate a captured identity checkpoint. A later checkpoint can absorb ordinary
 * CLI/runtime replacements; only sealed Codex pin-store replacements require a fresh run.
 */
export function relayInstallation(): InstalledPart[] {
  let bins: Record<string, string> = {};
  try {
    const cfg = loadConfig(() => {});
    bins = Object.fromEntries(TARGET_IDS.map((id) => [id, cfg.targets[id]?.bin ?? targetDef(id).defaultBin]));
  } catch {
    // A config relay cannot load refuses the call elsewhere; the default names are still protected.
  }
  const parts = relayRuntime();
  // The Node relay's launcher (bin/relay) would choose at its next start, where it can be told now:
  // RELAY_NODE, then the first node on PATH. Not the version managers' fallbacks it tries after them.
  for (const node of [process.env.RELAY_NODE, "node"]) {
    const named = node ? findExecutable(node) : null;
    if (named) parts.push(...executableParts("the Node relay's launcher starts relay on", named));
  }
  for (const id of TARGET_IDS) {
    for (const bin of new Set([bins[id], targetDef(id).defaultBin].filter((b): b is string => Boolean(b)))) {
      const named = findExecutable(bin);
      if (named) parts.push(...executableParts(`the ${id} target's CLI (${targetDef(id).product})`, named));
    }
  }
  const seen = new Set<string>();
  return parts.filter((p) => !seen.has(p.path) && Boolean(seen.add(p.path)));
}

/**
 * What every sandbox relay sets up denies writing (seatbelt.ts boundaryPaths, Claude's denyWrite):
 * relayInstallation, and each directory on relay's PATH.
 */
export function relayWriteProtected(): InstalledPart[] {
  const codex = relayCodexProtected();
  return [...relayInstallation(), ...codex.homes, ...codex.stores, ...relayPathDirs().map((d) => ({ what: "a directory on relay's PATH", path: d }))];
}

/**
 * Why a turn may not start a target's CLI, as found on the PATH its launch uses (`searchPath`), or
 * null: when that CLI, the file it leads to or its installation overlaps one of the turn's write
 * paths, or one of the turn's write paths covers or lies in a directory of that PATH. Admission
 * judged grants against relay's own PATH and config (caller.ts grantPathProblem); this judges them
 * against the turn's, so the two cannot disagree.
 */
export function targetLaunchProblem(what: string, bin: string, searchPath: string, writePaths: readonly string[]): string | null {
  if (!writePaths.length) return null;
  const named = findExecutable(bin, searchPath);
  const parts = named ? executableParts(what, named) : [];
  for (const p of writePaths) {
    const part = parts.find((x) => overlapsPart(p, x.path));
    if (part) return `relay will not start ${what} for this turn: it is ${named}, and its ${part.path === named ? "name" : part.what === what ? "file" : "installation"} (${part.path}) overlaps the job's write path ${p}, which a job could change. Grant a directory outside it.`;
    const dir = relayPathDirs(searchPath).find((d) => insideAnyCase(p, d) || insideAnyCase(d, p));
    if (dir) return `relay will not start ${what} for this turn: the job's write path ${p} overlaps ${dir}, a directory on the PATH the turn would start it from, where a job could put a program found first. Grant a directory outside it.`;
  }
  return null;
}
