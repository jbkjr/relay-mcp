// What install, uninstall and doctor share, whichever host they are working on: deciding whose an
// entry is, the record of what a run changed, running a host's CLI, writing its files, and its
// plugin kit. Each host's own part is in src/hosts/.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, configPath, loadConfig, type RelayConfig } from "../core/config.js";
import { findExecutable, spawnFound } from "../core/executables.js";
import { installRecordPath, installBackupsPath as savedDir } from "../core/protected-config.js";
import { isTable, sameData } from "../core/toml.js";
import type { HostId } from "../hosts/types.js";
import { targetDef, type Target } from "../targets/index.js";
import { probeVersion } from "../backends/cli-version.js";

const SELF = fileURLToPath(import.meta.url);
export const ROOT = path.resolve(path.dirname(SELF), "..", "..");
/** Hosts register the launcher script, which finds a suitable Node at start, not a pinned Node path. */
export const LAUNCHER = path.join(ROOT, "bin", "relay");

// ---- install, uninstall, doctor ----------------------------------------------------------------
//
// These three edit or inspect other programs' configuration, so they follow one rule throughout:
// find out what is there, decide whether it is relay's, and refuse when unsure. Nothing called
// "relay" is replaced or removed unless it is relay's own or the user passes --force, what is
// replaced is saved first where it will never be overwritten, and a failed step stops the run.

export const MARKETPLACE = "relay-local";
export const PLUGIN = `relay@${MARKETPLACE}`;

/** A refusal or a failed step. The message is for the user, and nothing further is attempted. */
export class Stop extends Error {}

export const say = (text: string) => console.log(text);
export const sh = (argv: string[]) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
/** Whether `dir` is on PATH. */
export const onPath = (dir: string): boolean => (process.env.PATH ?? "").split(path.delimiter).some((d) => d && canonical(d) === canonical(dir));
/** The command that installs or uninstalls relay for a host from this checkout, as relay tells the user to run it. */
export const reinstallCommand = (verb: "install" | "uninstall", host: string): string => sh([LAUNCHER, verb, host, "--write"]);
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
export const errCode = (err: unknown) => (err as NodeJS.ErrnoException).code;
export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** The first line of a command's output. */
export const first = (text: string) => text.trim().split(/\r?\n/)[0] ?? "";

export const linkPath = () => path.join(os.homedir(), ".local", "bin", "relay");
/** What install changed, per host. It sits beside relay's config, and so does everything install saves. */
export const recordFile = installRecordPath;


export { usageError } from "./basics.js";

// What is there, and whose is it

/**
 * relay's package names: "@jbkjr/relay", its npm name since the first public release, and
 * "relay", which a checkout from before then still carries.
 */
const RELAY_PACKAGE_NAMES: readonly string[] = ["@jbkjr/relay", "relay"];

/** Whether a path is bin/relay inside a relay checkout or npm install, going by its package.json. */
export function isRelayLauncher(file: string): boolean {
  if (!file.endsWith("/bin/relay")) return false;
  try {
    return RELAY_PACKAGE_NAMES.includes(JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(file)), "package.json"), "utf8")).name);
  } catch {
    return false;
  }
}

/** The launchers relay's installation record says it registered, for any host. */
function recordedLaunchers(): string[] {
  try { return Object.values(loadRecord().hosts).flatMap((h) => (h ? [h.launcher] : [])); } catch { return []; }
}

/**
 * Whose an MCP entry's command is. Relay's own entry runs a relay launcher as a server,
 * `<relay>/bin/relay mcp …`; the shape alone does not make it relay's, since another program can
 * have a bin/relay too. "relay": this launcher, a launcher in a relay package (its package.json,
 * as the link check goes by), or one relay's installation record says it registered.
 * "ambiguous": the shape, with none of that (a checkout since deleted, say): treated as not
 * relay's, so replacing or removing it takes --force. "foreign": anything else.
 */
export function relayCommandIdentity(command: unknown, args: unknown): "relay" | "ambiguous" | "foreign" {
  if (typeof command !== "string" || !command.endsWith("/bin/relay") || !Array.isArray(args) || args[0] !== "mcp") return "foreign";
  return command === LAUNCHER || isRelayLauncher(command) || recordedLaunchers().includes(command) ? "relay" : "ambiguous";
}
/** Why an entry of relay's shape is not taken as relay's (relayCommandIdentity "ambiguous"). */
export const ambiguousNote = (command: unknown) =>
  `it runs ${String(command)} mcp, which has the shape of relay's entry, but relay cannot confirm it is relay's: there is no relay package there, and relay's installation record does not name it`;
export const isRelayCommand = (command: unknown, args: unknown): boolean => relayCommandIdentity(command, args) === "relay";
/** A host's server entry (a table with command and args) that runs relay (isRelayCommand). */
export const isRelayEntry = (entry: unknown): boolean => isTable(entry) && isRelayCommand(entry.command, entry.args);
/** Whether relay is registered through these entries, as `registered()` says it: an ambiguous one is "unknown". */
export function entriesState(...entries: unknown[]): "registered" | "none" | "unknown" {
  const ids = entries.filter(isTable).map((e) => relayCommandIdentity(e.command, e.args));
  return ids.includes("relay") ? "registered" : ids.includes("ambiguous") ? "unknown" : "none";
}
/** JSON as relay writes the files it generates: indented, with a final newline. */
export const jsonText = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

export type Found =
  /** Nothing called relay, or exactly what this checkout would write (settings the user added beside it are left alone). */
  | { state: "absent" | "identical" }
  /** Relay's, from another checkout or in an older form: replaced without asking. */
  | { state: "own"; note: string }
  /** Relay's, but replacing it would lose settings the user added to it or changed in it. */
  | { state: "customised"; extras: string[] }
  /** Called relay, not relay's. */
  | { state: "foreign"; note: string }
  /** Cannot be read or edited safely. --force does not help; the note says what the user has to do. */
  | { state: "blocked"; note: string };

/** The part of an existing entry that relay itself writes. */
function managed(existing: unknown, intended: unknown): unknown {
  if (!isTable(existing) || !isTable(intended)) return existing;
  return Object.fromEntries(Object.keys(intended).filter((k) => Object.hasOwn(existing, k)).map((k) => [k, managed(existing[k], intended[k])]));
}

/** What relay rewrites as a matter of course: where the launcher is, how it is started, and the desktop entry's PATH. */
const REWRITTEN = new Set(["command", "args", "env.PATH"]);

/**
 * What replacing an existing entry would lose, as dotted names: settings relay does not write,
 * and settings it does write that have been given another value (a timeout, an approval mode).
 */
function extras(existing: unknown, intended: unknown, prefix = ""): string[] {
  if (!isTable(existing)) return [];
  return Object.keys(existing).flatMap((k) => {
    const name = prefix ? `${prefix}.${k}` : k;
    const known = isTable(intended) && Object.hasOwn(intended, k);
    const want = known ? (intended as Record<string, unknown>)[k] : undefined;
    if (isTable(existing[k]) && (!known || isTable(want))) return extras(existing[k], want, name);
    if (!known) return [name];
    return REWRITTEN.has(name) || sameData(existing[k], want) ? [] : [`${name} changed`];
  });
}

export const ownNote = (command: unknown, older: boolean) =>
  command === LAUNCHER ? (older ? "an earlier form of relay's entry" : "relay's entry with other settings") : `relay registered from another checkout, ${command}`;

/** Judges an entry held as data: Codex's table or the desktop app's JSON entry. */
export function judge(existing: unknown, intended: Record<string, unknown>): Found {
  if (existing === undefined) return { state: "absent" };
  if (!isTable(existing) || !isRelayCommand(existing.command, existing.args)) {
    if (isTable(existing) && relayCommandIdentity(existing.command, existing.args) === "ambiguous") return { state: "foreign", note: ambiguousNote(existing.command) };
    return { state: "foreign", note: isTable(existing) && typeof existing.command === "string" ? `its command is ${existing.command}` : "it does not run a relay launcher" };
  }
  if (sameData(managed(existing, intended), intended)) return { state: "identical" };
  const added = extras(existing, intended);
  if (added.length) return { state: "customised", extras: added };
  return { state: "own", note: ownNote(existing.command, !(existing.args as unknown[]).includes("--host")) };
}

/** Why relay will not go ahead, or null. An uninstall never objects to something foreign: it leaves it where it is. */
export function objection(what: string, found: Found, force: boolean, verb: "replace" | "remove"): string | null {
  if (found.state === "blocked") return found.note;
  if (verb === "remove" || force) return null;
  if (found.state === "foreign") {
    return `${what} is not relay's (${found.note}), so relay will not replace it. If it should go, run this again with --force: what is there now is saved first.`;
  }
  if (found.state === "customised") {
    return `${what} is relay's, but it carries settings relay did not write (${found.extras.join(", ")}), and replacing it would put relay's own in their place. `
      + "Run this again with --force to replace it anyway (what is there now is saved first), then make those changes again.";
  }
  return null;
}

/**
 * Whether uninstall may take an entry out. Where install left a record, an entry that still runs
 * the launcher the record names is the one relay put there. Otherwise, and for installations made
 * before there was a record, the ownership test decides. Anything else stays unless --force is given.
 */
export function removable(run: Run, found: Found, command: unknown): boolean {
  if (found.state === "absent" || found.state === "blocked") return false;
  if (found.state !== "foreign" || run.force) return true;
  return typeof command === "string" && command === run.record.hosts[run.host]?.launcher;
}

// Running things and writing files

export interface Change {
  action: "added" | "replaced" | "kept" | "removed";
  at: string;
  /** What was done, in words. */
  what: string;
  /** The file that was edited, for a change made in a config file. */
  file?: string;
  /** Where what was there before is saved. Relay never overwrites one of these and never copies one back. */
  backup: string | null;
  /** The exact command that reverses the change. */
  undo: string | null;
}
export interface HostRecord { launcher: string; complete: boolean; at: string; resources: Record<string, Change> }
export interface InstallRecord { version: 1; hosts: Partial<Record<HostId, HostRecord>>; link?: Change & { path: string; target: string } }
/** `made` is what the run changed, or in a dry run what it would change. `recorded` says whether the record on disk has all of it. */
export interface Run { verb: "install" | "uninstall"; host: HostId; write: boolean; force: boolean; record: InstallRecord; made: Change[]; recorded?: boolean }
/** Facts are gathered and objections raised for every part of a run before any part of it is applied. */
export interface Plan { problems: string[]; apply(): void }

export function readText(file: string): { bytes: Buffer; text: string } | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw new Stop(`${file} cannot be read (${errText(err)}).`);
  }
  try {
    // Kept exactly: a file that is not UTF-8 would not survive being read and written back.
    return { bytes, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    throw new Stop(`${file} is not valid UTF-8, so relay will not edit it.`);
  }
}

/**
 * Replaces a file in one step: a temporary file beside it, then a rename. A symlinked config
 * (a dotfiles checkout, say) is written through, not replaced, and the file keeps its mode. If
 * the file no longer holds what relay read, it is left alone.
 */
export function writeAtomic(file: string, text: string, before: Buffer | null): void {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw new Stop(`${file} cannot be resolved (${errText(err)}).`);
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Stop(`${file} is a symbolic link to a file that does not exist; relay will not write through it.`);
  }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.relay-${process.pid}-${Date.now().toString(36)}.tmp`);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = before ? fs.statSync(target).mode & 0o7777 : 0o600;
    const fd = fs.openSync(tmp, "wx", mode);
    try {
      fs.writeFileSync(fd, text);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const now = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (before ? !now?.equals(before) : now !== null) throw new Stop(`${file} changed while relay was working on it, so it was left as it is. Run this again.`);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err instanceof Stop ? err : new Stop(`${file} could not be written (${errText(err)}); it was left as it is.`);
  }
}

/** A name beside `base` that nothing has yet: base itself the first time, timestamped after that. */
export function unusedName(base: string, attempt: number): string {
  return attempt === 0 ? base : `${base}-${stamp()}${attempt > 1 ? `-${attempt}` : ""}`;
}

/**
 * Saves a file as relay read it to <file>.bak-relay, or to a timestamped name if that exists.
 * An existing backup is never overwritten: the file is created only if nothing has the name.
 */
export function backupFile(file: string, bytes: Buffer): string {
  for (let n = 0; ; n++) {
    const dest = unusedName(`${file}.bak-relay`, n);
    try {
      const mode = fs.statSync(file).mode & 0o7777;
      fs.writeFileSync(dest, bytes, { flag: "wx", mode });
      fs.chmodSync(dest, mode);
      return dest;
    } catch (err) {
      if (errCode(err) !== "EEXIST" || n > 50) throw new Stop(`${file} could not be backed up (${errText(err)}), so it was not changed.`);
    }
  }
}

/** Saves a description of something that is not a file (a registration, a marketplace entry) before relay replaces or removes it. */
export function saveJson(run: Run, name: string, data: Record<string, unknown>): string | null {
  if (!run.write) return null;
  const dir = savedDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let n = 1; ; n++) {
      const file = path.join(dir, `${name}-${stamp()}${n > 1 ? `-${n}` : ""}.json`);
      try {
        // It can hold another server's environment, so it is readable by the user only.
        fs.writeFileSync(file, JSON.stringify({ saved_at: new Date().toISOString(), ...data }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        return file;
      } catch (err) {
        if (errCode(err) !== "EEXIST" || n > 50) throw err;
      }
    }
  } catch (err) {
    throw new Stop(`could not save what is there now under ${dir} (${errText(err)}), so it was not touched.`);
  }
}

export function loadRecord(): InstallRecord {
  const file = recordFile();
  if (!fs.existsSync(file)) return { version: 1, hosts: {} };
  try {
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isTable(rec) || rec.version !== 1 || !isTable(rec.hosts)) throw new Error("it is not a version 1 record");
    for (const [host, h] of Object.entries(rec.hosts)) {
      if (!isTable(h) || typeof h.launcher !== "string" || typeof h.at !== "string" || !isTable(h.resources)) throw new Error(`its entry for ${host} is incomplete`);
    }
    if (rec.link !== undefined && (!isTable(rec.link) || typeof rec.link.target !== "string")) throw new Error("its entry for the link is incomplete");
    return rec as unknown as InstallRecord;
  } catch (err) {
    throw new Stop(`relay's installation record at ${file} cannot be used (${errText(err)}). Move it aside and run this again; relay then goes by what it finds installed.`);
  }
}

export function saveRecord(rec: InstallRecord): void {
  const file = recordFile();
  if (!Object.keys(rec.hosts).length && !rec.link) return void fs.rmSync(file, { force: true });
  const text = jsonText(rec);
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (before?.toString() !== text) writeAtomic(file, text, before);
}

/** Records one change on disk at once, so that a run that dies half-way still leaves a true account of what it did. */
export function note(run: Run, resource: string, c: Omit<Change, "at">): void {
  const change: Change = { ...c, at: new Date().toISOString() };
  if (c.action !== "kept") run.made.push(change);
  if (!run.write) return;
  if (resource === "link") {
    if (c.action === "removed") delete run.record.link;
    else if (c.action !== "kept" || !run.record.link) run.record.link = { ...change, path: linkPath(), target: LAUNCHER };
  } else {
    const host = run.record.hosts[run.host];
    if (host && c.action !== "kept") host.complete = false;
    // Something already in place keeps the account of the run that put it there. A removal stays
    // on record, with what it saved, until something takes its place or the host is uninstalled.
    if (host && (c.action !== "kept" || !host.resources[resource] || host.resources[resource].action === "removed")) host.resources[resource] = change;
  }
  if (c.action === "kept") return;
  run.recorded = false;
  saveRecord(run.record);
  run.recorded = Boolean(run.record.hosts[run.host]) || resource === "link";
}

/** The record has to be writable before anything else is changed: it is what a run that stops half-way leaves to go by. */
export function requireRecord(create: boolean): void {
  const dir = path.dirname(recordFile());
  if (!create && !fs.existsSync(recordFile())) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    throw new Stop(`relay could not prepare its installation record at ${recordFile()} (${errText(err)}).`);
  }
}

/** Runs one command of a host's CLI. It is printed either way, run only with --write, and a failure ends the run. */
export function step(run: Run, argv: string[], resource: string, change: Omit<Change, "at">): void {
  say(`$ ${sh(argv)}`);
  if (!run.write) return void note(run, resource, change);
  const r = spawnFound(argv[0], argv.slice(1), { stdio: "inherit", encoding: "utf8" });
  if (r.error || r.status !== 0) throw new Stop(`\`${sh(argv)}\` failed (${r.error ? errText(r.error) : r.signal ? `stopped by ${r.signal}` : `exit ${r.status}`}).`);
  note(run, resource, change);
}

/** Backs a config file up and replaces it. */
export function writeFile(run: Run, file: string, before: { bytes: Buffer } | null, text: string, resource: string, change: Omit<Change, "at" | "backup">): void {
  if (!run.write) return void note(run, resource, { ...change, file, backup: null });
  const backup = before ? backupFile(file, before.bytes) : null;
  try {
    writeAtomic(file, text, before?.bytes ?? null);
  } catch (err) {
    // Nothing was written, so the copy just made records no change. It is this run's own and goes again.
    if (backup) fs.rmSync(backup, { force: true });
    throw err;
  }
  say(`  written${backup ? `; the file as it was is at ${backup}` : ""}`);
  note(run, resource, { ...change, file, backup });
}

/** Removes a whole file relay installed, saving it first and refusing if it changed since planning. */
export function removeFile(run: Run, file: string, before: { bytes: Buffer }, resource: string, change: Omit<Change, "at" | "backup">): void {
  if (!run.write) return void note(run, resource, { ...change, file, backup: null });
  const backup = backupFile(file, before.bytes);
  try {
    if (!fs.readFileSync(file).equals(before.bytes)) throw new Stop(`${file} changed while relay was working on it, so it was left as it is. Run this again.`);
    fs.unlinkSync(file);
  } catch (err) {
    fs.rmSync(backup, { force: true });
    throw err instanceof Stop ? err : new Stop(`${file} could not be removed (${errText(err)}).`);
  }
  say(`  removed; the file as it was is at ${backup}`);
  note(run, resource, { ...change, file, backup });
}

// The CLIs

export function config(): RelayConfig {
  try {
    return loadConfig();
  } catch (err) {
    throw new Stop(`${errText(err)}. Fix or remove it first.`);
  }
}

/** The absolute path of an executable, as relay would run it (executables.ts findExecutable). */
export function locate(bin: string): string | null {
  return findExecutable(bin);
}

/**
 * Whose `relay` command `found` (a path on PATH) is, from where it leads and where it sits, never
 * from its name: "launcher" when it resolves to `<root>/bin/relay` (the link install makes, or the
 * launcher itself); "npm" when it is npm's global command for the package installed at `root`,
 * that is, it sits in `<prefix>/bin`, resolves to the package's own `bin.relay` entry inside
 * `root`, and `<prefix>/lib/node_modules/<package name>` is `root` (npm's layout for every prefix
 * on macOS: /opt/homebrew, /usr/local, a custom one such as ~/.npm-global, a version manager's);
 * null for anything else, including another checkout, another npm install, an entry that leads out
 * of `root`, and a manifest relay cannot read.
 */
export function relayCommandKind(found: string, root: string = ROOT): "launcher" | "npm" | null {
  const home = canonical(root);
  const real = canonical(found);
  // A file of this install, reached without leaving it: its real path is the install's own path
  // joined with the name, so a link inside the install that leads elsewhere does not count.
  const inside = (rel: string) => !path.isAbsolute(rel) && path.join(home, path.normalize(rel)).startsWith(home + path.sep) &&
    canonical(path.join(home, rel)) === path.join(home, path.normalize(rel));
  if (inside(path.join("bin", "relay")) && real === path.join(home, "bin", "relay")) return "launcher";
  let pkg: unknown;
  try { pkg = JSON.parse(fs.readFileSync(path.join(home, "package.json"), "utf8")); } catch { return null; }
  if (!isTable(pkg)) return null;
  const entry = typeof pkg.bin === "string" ? pkg.bin : isTable(pkg.bin) ? pkg.bin.relay : undefined;
  if (typeof pkg.name !== "string" || !/^(?:@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/.test(pkg.name) || typeof entry !== "string") return null;
  if (!inside(entry) || real !== path.join(home, path.normalize(entry))) return null;
  const binDir = canonical(path.dirname(found));
  if (path.basename(binDir) !== "bin") return null;
  return canonical(path.join(path.dirname(binDir), "lib", "node_modules", ...pkg.name.split("/"))) === home ? "npm" : null;
}

/**
 * The package name when relay's package root sits where npm installs a package, at
 * `node_modules/<name>` (a global install's `<prefix>/lib/node_modules/@jbkjr/relay`, or a project's
 * own node_modules), going by its package.json; null otherwise: a git checkout (one with its own .git,
 * wherever it sits), `npm link`ed or not
 * (Node runs a linked package from its real path), or a copy elsewhere.
 */
export function npmInstallName(root: string = ROOT): string | null {
  let pkg: unknown;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); } catch { return null; }
  if (!isTable(pkg) || typeof pkg.name !== "string" || !/^(?:@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/.test(pkg.name)) return null;
  // A checkout (or worktree, whose .git is a file) wherever it sits is a checkout: its HEAD is compared.
  if (fs.existsSync(path.join(root, ".git"))) return null;
  const parts = canonical(root).split(path.sep);
  const want = ["node_modules", ...pkg.name.split("/")];
  return parts.slice(-want.length).join("/") === want.join("/") ? pkg.name : null;
}
/** What relay runs from, for messages that name it: "npm install" or "checkout". */
export const installKind = (): "npm install" | "checkout" => (npmInstallName() ? "npm install" : "checkout");

/**
 * The first relative or empty PATH entry ahead of `dir`, or null. A shell searches such an entry
 * from its current directory, so a `relay` there runs first in some directories; relay's own
 * lookup (findExecutable) skips them, so doctor names them instead.
 */
export function relativePathEntryBefore(dir: string, searchPath: string = process.env.PATH ?? ""): string | null {
  for (const d of searchPath.split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) return d || "(an empty entry)";
    if (canonical(d) === canonical(dir)) return null;
  }
  return null;
}

/** Checks that a host's CLI exists and runs, before anything is changed, and returns what it says its version is. */
export function requireCli(cli: Target, bin: string): string {
  const r = probeVersion(cli, bin, process.env);
  if (!r.error && r.status === 0) return r.stdout.trim();
  const why = r.error ? (errCode(r.error) === "ENOENT" ? `\`${bin}\` was not found` : `\`${bin}\` could not be started (${errText(r.error)})`) : `\`${bin} --version\` failed (exit ${r.status})`;
  throw new Stop(`This needs the ${cli} CLI, and ${why}. Install ${targetDef(cli).product} and make sure \`${cli}\` is on PATH, or set \`targets.${cli}.bin\` in ${configPath()} to its full path.`);
}

/** Asks a CLI for something in JSON. These calls only read. */
export function queryJson(argv: string[]): unknown {
  const r = spawnFound(argv[0], argv.slice(1), { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Stop(`relay could not see what is installed: \`${sh(argv)}\` failed (${r.error ? errText(r.error) : `exit ${r.status}`})${r.stderr?.trim() ? `: ${r.stderr.trim()}` : ""}.`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Stop(`relay could not see what is installed: \`${sh(argv)}\` did not print JSON.`);
  }
}

/** How both CLIs say that no server has the name. Any other failure is not an answer, and is not read as one. */
export const NO_SERVER = /no mcp server (named|found)/i;

/**
 * How a host's CLI keeps plugins: its commands, the JSON its list commands print, and the
 * directory of this checkout's adapter for it (adapters/<dir>).
 */
export interface KitFormat {
  /** adapters/<dir>, and the name saved copies of the marketplace entry are filed under. */
  dir: string;
  /** The host as the user knows it: "Claude Code". */
  hostName: string;
  verbs: { add: string; remove: string };
  /** The list printed by `plugin marketplace list --json`. */
  marketplaces(listed: unknown): unknown;
  /** Where a marketplace entry points, for a local directory; anything else is not relay's. */
  localSource(raw: Record<string, unknown>): unknown;
  /** The list printed by `plugin list --json`. */
  plugins(listed: unknown): unknown;
  /** Whether a listed plugin is relay's, installed at user scope. */
  isRelayPlugin(p: Record<string, unknown>): boolean;
  /** Where the host keeps its own copy of the listed plugin, or null if it cannot be told. */
  copyOf(p: Record<string, unknown>): string | null;
  /** The directory of the plugin's manifest inside the adapter: .claude-plugin. */
  manifestDir: string;
}

const kit = (format: KitFormat, bin: string) => ({
  marketAdd: (dir: string) => [bin, "plugin", "marketplace", "add", dir],
  marketRemove: [bin, "plugin", "marketplace", "remove", MARKETPLACE],
  pluginAdd: [bin, "plugin", format.verbs.add, PLUGIN],
  pluginRemove: [bin, "plugin", format.verbs.remove, PLUGIN],
});

interface Market { state: "absent" | "identical" | "own" | "foreign"; source: string; raw: unknown }

/** The plugin marketplace named relay-local, if the CLI has one, and whether it is one of relay's adapter directories. */
export function marketState(format: KitFormat, bin: string): Market {
  const argv = [bin, "plugin", "marketplace", "list", "--json"];
  const all = format.marketplaces(queryJson(argv));
  if (!Array.isArray(all)) throw new Stop(`relay could not see what is installed: \`${sh(argv)}\` printed something relay does not understand.`);
  const raw = all.find((m) => isTable(m) && m.name === MARKETPLACE) as Record<string, unknown> | undefined;
  if (!raw) return { state: "absent", source: "", raw: null };
  const from = format.localSource(raw);
  if (typeof from !== "string") return { state: "foreign", source: JSON.stringify(raw), raw };
  const source = from.replace(/\/+$/, "");
  if (canonical(source) === canonical(path.join(ROOT, "adapters", format.dir))) return { state: "identical", source, raw };
  return { state: source.endsWith(`/adapters/${format.dir}`) ? "own" : "foreign", source, raw };
}

/** The plugin as the host has it: whether it is installed, at which version if the host says, and where the host keeps its copy. */
export function pluginInstalled(format: KitFormat, bin: string): { installed: boolean; version: string | null; copy: string | null } {
  const argv = [bin, "plugin", "list", "--json"];
  const all = format.plugins(queryJson(argv));
  if (!Array.isArray(all)) throw new Stop(`relay could not see what is installed: \`${sh(argv)}\` printed something relay does not understand.`);
  // Relay installs at user scope; a copy someone enabled for one project is theirs.
  const found = all.find((p) => isTable(p) && format.isRelayPlugin(p));
  return {
    installed: Boolean(found),
    version: isTable(found) && typeof found.version === "string" ? found.version : null,
    copy: isTable(found) ? format.copyOf(found) : null,
  };
}

/** A version as a host names a plugin's directory after it: one path component, nothing that climbs. */
export const versionDir = (v: unknown): string | null => (typeof v === "string" && /^[\w.+-]+$/.test(v) && v !== "." && v !== ".." ? v : null);

/**
 * A digest of what a plugin directory holds: each file's path inside it and its bytes, and each
 * symbolic link's path and target, in a fixed order (directories themselves, modes and times do
 * not count, nor Finder's .DS_Store). Null if the directory is not there or cannot be read.
 */
function treeDigest(dir: string | null): string | null {
  if (!dir) return null;
  const h = createHash("sha256");
  const walk = (rel: string): void => {
    const names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).filter((e) => e.name !== ".DS_Store");
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of names) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isSymbolicLink()) h.update(`link ${r}\0${fs.readlinkSync(path.join(dir, r))}\0`);
      else if (e.isFile()) {
        const bytes = fs.readFileSync(path.join(dir, r));
        h.update(`file ${r}\0${bytes.length}\0`);
        h.update(bytes);
      } else h.update(`other ${r}\0`);
    }
  };
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
    walk("");
    return h.digest("hex");
  } catch {
    return null;
  }
}

/** The version of the plugin this checkout would install. */
export function pluginVersion(format: KitFormat): string | null {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, "adapters", format.dir, "relay", format.manifestDir, "plugin.json"), "utf8")).version);
  } catch {
    return null;
  }
}

// The pieces of an installation

/** The plugin (skills and slash commands) and the marketplace entry that points at this checkout's adapters. */
export function planKit(run: Run, format: KitFormat, bin: string): Plan {
  const c = kit(format, bin);
  const dir = path.join(ROOT, "adapters", format.dir);
  const market = marketState(format, bin);
  const has = pluginInstalled(format, bin);
  let installed = has.installed;
  // A host keeps its own copy of the plugin. After an update of this checkout that copy is the
  // old skills, so a plugin whose version is not this checkout's is put in again; and so is one at
  // this version whose copy holds anything but this checkout's adapter (a release candidate respun
  // at the same version), or whose copy relay cannot find or read to tell.
  const mine = pluginVersion(format);
  const source = path.join(dir, "relay");
  const otherVersion = installed && has.version !== null && mine !== null && has.version !== mine;
  const ours = otherVersion || !installed || market.state !== "identical" ? null : treeDigest(source);
  const theirs = ours === null ? null : treeDigest(has.copy);
  const otherContent = ours !== null && theirs !== ours;
  const stale = otherVersion || otherContent;
  const copyNote = !otherContent ? null : theirs === null
    ? `relay could not ${has.copy ? `read ${format.hostName}'s copy of the plugin (${has.copy})` : `find ${format.hostName}'s copy of the plugin`} to compare it with this checkout's adapters/${format.dir}/relay`
    : `${format.hostName}'s copy of the plugin (${has.copy}) is not this checkout's adapters/${format.dir}/relay (the same version, other content)`;
  const what = `${format.hostName}'s plugin marketplace "${MARKETPLACE}"`;
  if (run.verb === "uninstall") {
    const leave = market.state === "foreign" && !run.force;
    return {
      problems: [],
      apply() {
        if (leave) return void say(`# left alone: ${what} is not relay's (its source is ${market.source}), nor is the plugin from it. --force removes them.`);
        if (installed) step(run, c.pluginRemove, "plugin", { action: "removed", what: `uninstalled the plugin ${PLUGIN} from ${format.hostName}`, backup: null, undo: sh(c.pluginAdd) });
        if (market.state === "absent") return;
        const backup = market.state === "foreign" ? saveJson(run, `${format.dir}-marketplace`, { what: `${what}, as it was before relay removed it`, entry: market.raw }) : null;
        step(run, c.marketRemove, "marketplace", { action: "removed", what: `removed ${what} (${market.source})`, backup, undo: market.state === "foreign" ? null : sh(c.marketAdd(market.source)) });
      },
    };
  }
  return {
    problems: market.state === "foreign" && !run.force ? [`${what} is not relay's (its source is ${market.source}), so relay will not replace it. If it should go, run this again with --force: what is there now is saved first.`] : [],
    apply() {
      if (market.state === "identical" && stale) {
        if (copyNote) say(`# ${copyNote}, so it is put in again`);
        const why = copyNote ? `: ${copyNote}` : ` at version ${has.version}, to put in ${mine}`;
        step(run, c.pluginRemove, "plugin", { action: "removed", what: `uninstalled the plugin ${PLUGIN}${why}`, backup: null, undo: sh(c.pluginAdd) });
        step(run, c.marketRemove, "marketplace", { action: "removed", what: `removed ${what} so that the host reads it afresh`, backup: null, undo: sh(c.marketAdd(dir)) });
        step(run, c.marketAdd(dir), "marketplace", { action: "replaced", what: `added ${what} (${dir})`, backup: null, undo: sh(c.marketRemove) });
        installed = false;
      } else if (market.state === "identical") {
        note(run, "marketplace", { action: "kept", what: `${what} already points at ${dir}`, backup: null, undo: sh(c.marketRemove) });
      } else {
        let backup: string | null = null;
        if (market.state !== "absent") {
          // Another checkout's marketplace, or with --force someone else's: the plugin that came from it goes with it.
          backup = saveJson(run, `${format.dir}-marketplace`, { what: `${what}, as it was before relay replaced it`, entry: market.raw });
          if (installed) step(run, c.pluginRemove, "plugin", { action: "removed", what: `uninstalled the plugin ${PLUGIN} that came from ${market.source}`, backup: null, undo: sh(c.pluginAdd) });
          step(run, c.marketRemove, "marketplace", { action: "removed", what: `removed ${what} (${market.source})`, backup, undo: market.state === "own" ? sh(c.marketAdd(market.source)) : null });
          installed = false;
        }
        step(run, c.marketAdd(dir), "marketplace", { action: market.state === "absent" ? "added" : "replaced", what: `added ${what} (${dir})`, backup, undo: sh(c.marketRemove) });
      }
      if (installed) note(run, "plugin", { action: "kept", what: `the plugin ${PLUGIN} was already installed in ${format.hostName}`, backup: null, undo: sh(c.pluginRemove) });
      else step(run, c.pluginAdd, "plugin", { action: "added", what: `installed the plugin ${PLUGIN} in ${format.hostName}`, backup: null, undo: sh(c.pluginRemove) });
    },
  };
}
