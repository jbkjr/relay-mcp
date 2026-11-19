// The API key of a key-only target (Gemini CLI, which has no account login relay can use):
// where the person keeps it, which local, never-synced config may move it, and how relay reads it.
// docs/gemini.md §2 is the design; this is the one place relay reads a vendor credential.
//
// Relay never writes, copies, logs or prints a key. It reads the file in the worker that launches
// the turn, after every other refusal has passed, hands the value to that target's process only
// (backends/gemini.ts), and redacts it from everything it reads back (backends/acp.ts redactor).
// Every refusal names the file and what is wrong with it, never what it holds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { TARGETS, type Target } from "../targets/index.js";
import { configPath, expandHome, harnessHome, inside, relayHome, underTemp, worktreesHome } from "./config.js";
import { git } from "./git.js";
import { localConfigPath } from "./protected-config.js";

export { localConfigPath };

/** The targets that sign in with an API key only (capabilities.login "key-only"). */
export const keyOnlyTargets = (): Target[] => TARGETS.filter((t) => t.capabilities.login === "key-only").map((t) => t.id);

/**
 * Where the person keeps relay's API keys by default: `~/.config/relay-keys`, a directory of its
 * own (mode 0700) beside relay's config directory, never inside it: `~/.config/relay/config.json`
 * may be a link into a synced directory, and nothing that syncs or backs up that one carries this.
 */
export const defaultKeyDir = (): string => path.join(os.homedir(), ".config", "relay-keys");
/** The default key file of a target: `~/.config/relay-keys/<target>-api-key`. */
export const defaultKeyFile = (target: Target): string => path.join(defaultKeyDir(), `${target}-api-key`);

// Relay's local config (localConfigPath, protected-config.ts, where relay's other files are named):
// machine-local settings that must never be synced, read by the worker that needs them (never
// snapshotted into the registry as config.json is). `~/.config/relay/local.json`.

export interface LocalConfig {
  targets?: Partial<Record<Target, { api_key_file?: string }>>;
}

/** A path the person wrote: absolute, or starting with `~/`; no line breaks or NUL. */
const keyPath = z.string().min(1).refine((p) => (p.startsWith("/") || p.startsWith("~/")) && !/[\0\r\n]/.test(p), "must be an absolute path (or start with ~/)");

function localSchema() {
  const keyOnly = keyOnlyTargets();
  return z.object({
    targets: z.object(Object.fromEntries(keyOnly.map((id) => [id, z.object({ api_key_file: keyPath }).partial().strict()]))).partial().strict(),
  }).partial().strict();
}

/** Mode bits that let anyone but the owner write. */
const OTHERS_WRITE = 0o022;
/** Mode bits that give the group or others any access. */
const OTHERS_ANY = 0o077;
const uid = (): number => (typeof process.getuid === "function" ? process.getuid() : -1);
const octal = (mode: number): string => (mode & 0o7777).toString(8).padStart(4, "0");

/** Whether `dir` is or holds the home folder or relay's state, worktrees or confined agents' homes: too broad to treat as one thing. */
const broad = (dir: string): boolean => [os.homedir(), relayHome(), worktreesHome(), harnessHome()].some((d) => inside(d, dir));

/**
 * The real directories relay's config is shared through: where config.json leads when it, or the
 * directory it is in, is a link (as when the person syncs their config from another folder), and
 * the git work tree that directory is in, which is what a sync job commits and pushes (for
 * example a dotfiles repository holding ~/.config/relay). A work tree that is or holds the home folder or
 * relay's own directories is left out: refusing all of it would refuse every place a key could be.
 * A file relay reads a secret from, or the local config that names it, must not be in one. Relay
 * knows only these; any other synced folder is the person's to avoid.
 */
function syncedDirs(): string[] {
  const out = new Set<string>();
  for (const cfg of new Set([configPath(), path.join(os.homedir(), ".config", "relay", "config.json")])) {
    let dir: string;
    try {
      if (!fs.lstatSync(cfg, { throwIfNoEntry: false })) continue;
      if (fs.lstatSync(cfg).isSymbolicLink()) dir = path.dirname(fs.realpathSync(cfg));
      else if (fs.lstatSync(path.dirname(cfg)).isSymbolicLink()) dir = fs.realpathSync(path.dirname(cfg));
      else continue;
    } catch {
      // A config that cannot be followed shares nothing relay can find.
      continue;
    }
    out.add(dir);
    const top = git(dir, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || !top.out) continue;
    try {
      const tree = fs.realpathSync(top.out);
      if (!broad(tree)) out.add(tree);
    } catch {
      // A work tree git names but relay cannot follow: the directory itself is still refused.
    }
  }
  return [...out];
}
/** The synced directory `dir` lies in, or null. */
function inSynced(dir: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return null;
  }
  return syncedDirs().find((s) => real === s || real.startsWith(s.endsWith(path.sep) ? s : s + path.sep)) ?? null;
}

/**
 * Where agents relay launches write without any grant, for a key file's directory, or null: a temp
 * directory (os.tmpdir(), /tmp, /var/tmp), which Claude's and Codex's own sandboxes leave writable
 * (core/config.ts underTemp), and relay's own state, worktrees and confined harnesses' homes. Ownership
 * and mode do not stop those agents, which run as the person. A directory under the person's home is
 * not one of them however the home is placed (the grant check keeps jobs from it, caller.ts), so the
 * check applies to a temp directory outside the home.
 */
function agentWritable(dir: string): string | null {
  for (const [what, d] of [["relay's state directory", relayHome()], ["the directory of relay's job worktrees", worktreesHome()], ["the directory of confined agents' state", harnessHome()]] as const) {
    if (inside(dir, d)) return `${what} (${d}), which agents relay launches write in`;
  }
  if (underTemp(dir) && !inside(dir, os.homedir())) return "a temporary directory, which Claude's and Codex's own sandboxes leave writable";
  return null;
}

/** The status fields the checks below read (an lstat, or an open file's fstat). */
export interface KeyStat {
  uid: number;
  mode: number;
  nlink: number;
  isFile(): boolean;
  isDirectory?(): boolean;
  isSymbolicLink?(): boolean;
}

/** Why the local config is refused when it is a link (an lstat's, or an open that would not follow one). */
const LOCAL_LINK = "is a link; relay reads it only as a file of its own there, since it says which private file relay reads a key from";

/**
 * What is wrong with the local config at `file`, from its status (the open file's, as
 * loadLocalConfig reads it), or null: a regular file with one name, the person's own, that no one
 * else can write.
 */
export function localConfigStatProblem(st: KeyStat, file: string, me: number = uid()): string | null {
  if (st.isSymbolicLink?.()) return LOCAL_LINK;
  if (!st.isFile()) return "is not a regular file";
  if (st.uid !== me) return "is not owned by you";
  if (st.mode & OTHERS_WRITE) return `can be changed by group or others (mode ${octal(st.mode)}); make it yours alone: chmod 600 ${file}`;
  if (st.nlink !== 1) return "has more than one name (a hard link), so a write to another file could change it";
  return null;
}

/** What is wrong with the key file directory `dir`, from its lstat, or null: a real directory of the person's own that no one else can write (who could swap the key). */
export function keyDirStatProblem(st: KeyStat, dir: string, me: number = uid()): string | null {
  if (st.isSymbolicLink?.()) return "is a link; keep the key in a real directory of your own";
  if (!st.isDirectory?.()) return "is not a directory";
  if (st.uid !== me) return "is not owned by you";
  if (st.mode & OTHERS_WRITE) return `can be changed by group or others (mode ${octal(st.mode)}), who could swap the key; make it yours alone: chmod 700 ${dir}`;
  return null;
}

/**
 * Relay's local config, or {} when there is none. It decides which private file relay reads and
 * sends to a vendor, so it is held to the key file's standard: a regular file with one name, the
 * person's own, not a link, writable by no one else, and not in a synced directory. It is opened
 * as the key file is (never through a link, a FIFO not waited on) and checked and read through that
 * one descriptor, so that what is checked is what is read. Throws naming every problem.
 */
export function loadLocalConfig(): LocalConfig {
  const file = localConfigPath();
  const where = `relay's local config at ${file}`;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    if (code === "ELOOP" || code === "EMLINK") throw new Error(`${where} ${LOCAL_LINK}`);
    throw new Error(`relay could not open ${where} (${code ?? (err as Error).message})`);
  }
  let text: string;
  try {
    const problem = localConfigStatProblem(fs.fstatSync(fd), file);
    if (problem) throw new Error(`${where} ${problem}`);
    const synced = inSynced(path.dirname(file));
    if (synced) throw new Error(`${where} is beside relay's synced config (in ${synced}), so it would be synced; keep it in a directory of this machine's own`);
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${where} is not valid JSON: ${(err as Error).message}`);
  }
  const r = localSchema().safeParse(raw);
  if (!r.success) {
    const problems = r.error.issues.map((i) => `${i.path.join(".") || "(top level)"}: ${i.message}`).join("; ");
    throw new Error(`${where} is not valid, so relay does not read an API key with it. It may hold only targets.<id>.api_key_file, for ${keyOnlyTargets().join(", ") || "no target"}. ${problems}`);
  }
  return r.data as LocalConfig;
}

/** The file relay reads `target`'s API key from: the local config's targets.<id>.api_key_file, else the default. Throws on a bad local config. */
export function apiKeyFile(target: Target): string {
  const set = loadLocalConfig().targets?.[target]?.api_key_file;
  return set ? path.resolve(expandHome(set)) : defaultKeyFile(target);
}

/**
 * What relay's own sandbox denies to every agent it confines (src/confine, as
 * ConfinementPolicy.denied, with relay's control directory), whatever its target: no read, no test
 * for a name, no write. The default key directory, whole, so that a confined agent can neither
 * read a key there nor list the directory; and each key-only target's key file where the local
 * config moves it elsewhere, that file alone, since its directory may hold anything else of the
 * person's (a denied directory above a worktree would leave a turn nothing to work in). The
 * denied list takes a single file as it takes relay's config files (src/confine/probe.ts probes
 * one with a read, a test for its name and an open for writing that writes nothing). When the
 * local config cannot be loaded, the files it names are denied as best relay can (namedKeyFiles);
 * a Gemini turn is refused then anyway. A path that is or holds the home folder or relay's own
 * directories is left out: relay never reads a key there (checkKeyFile), and denying it would
 * refuse every confined turn, whose worktree would lie inside it.
 */
export function keyPathsToDeny(): string[] {
  let named: (readonly [string, string])[];
  try {
    named = keyOnlyTargets().map((t) => [t, apiKeyFile(t)] as const);
  } catch {
    named = namedKeyFiles();
  }
  return [...new Set([defaultKeyDir(), ...named.map(([, file]) => file).filter((file) => !inDefaultDir(file) && !broad(file))])];
}

/**
 * The directories that decide which API key relay hands a key-only target, and so whose account
 * it runs on, which no job may be given or change: relay's config directory, whose local config
 * names each key file; the default key directory; and each key-only target's key file directory
 * where the local config moves it (unless that is too broad to hold a key, which relay refuses:
 * the home folder or one holding relay's own directories). Shared, as relay's config protection
 * is (protected-config.ts), by the grant check and the check of a grant a session keeps
 * (caller.ts), file approvals (approvals.ts) and Claude's write denials (backends/claude.ts).
 * Reading the key is another matter: agents relay confines are denied the default key directory
 * and a moved key file outright, and Claude's turns may read neither (keyPathsToDeny).
 *
 * `problem` says why a local config that is there cannot be loaded. Relay then cannot be sure
 * where it would move a key: the key files it names are read from it as best relay can, and no job
 * is given a write path, or a file outside its own worktree, until it is fixed (caller.ts,
 * approvals.ts): either would outlast the fix.
 */
export function keyAuthority(): { dirs: (readonly [string, string])[]; problem: string | null } {
  const dirs: (readonly [string, string])[] = [
    ["relay's config directory, whose local config says which API key file relay reads", path.dirname(localConfigPath())],
    ["the directory of relay's API keys", defaultKeyDir()],
  ];
  let problem: string | null = null;
  let moved: (readonly [string, string])[];
  try {
    moved = keyOnlyTargets().map((t) => [t, apiKeyFile(t)] as const);
  } catch (err) {
    problem = (err as Error).message;
    moved = namedKeyFiles();
  }
  for (const [t, file] of moved) {
    const dir = path.dirname(file);
    if (dir !== defaultKeyDir() && !broad(dir)) dirs.push([`the directory of ${t}'s API key file`, dir]);
  }
  return { dirs, problem };
}

/** Best effort, for a local config relay cannot load: each targets.<id>.api_key_file in it that is a path, whatever else is wrong with it. */
function namedKeyFiles(): (readonly [string, string])[] {
  let fd: number;
  try {
    // As the key file is opened: never through a link, and a FIFO in its place is not waited on.
    fd = fs.openSync(localConfigPath(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return [];
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return [];
    const raw = JSON.parse(fs.readFileSync(fd, "utf8")) as { targets?: Record<string, { api_key_file?: unknown } | null> } | null;
    return Object.entries(raw?.targets ?? {}).flatMap(([t, v]) => {
      const file = v?.api_key_file;
      return typeof file === "string" && keyPath.safeParse(file).success ? [[t, path.resolve(expandHome(file))] as const] : [];
    });
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

/** How the person saves a key at `file`: one line, typed at a hidden prompt, in a directory and file of their own. */
export function keySetup(file: string): string {
  const dir = path.dirname(file);
  const q = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
  return `Save the key there as one line, typed at a hidden prompt: mkdir -p ${q(dir)} && chmod 700 ${q(dir)} && (umask 077; printf 'API key: '; IFS= read -rs KEY; echo; printf '%s\\n' "$KEY" > ${q(file)}; unset KEY)`;
}

/** What is wrong with an open key file's status, or null: it must be a regular file with one name, the person's own, readable and writable by no one else. */
export function keyStatProblem(st: KeyStat, me: number = uid()): string | null {
  if (!st.isFile()) return "is not a regular file";
  if (st.uid !== me) return "is not owned by you";
  if (st.mode & OTHERS_ANY) return `can be read or written by group or others (mode ${octal(st.mode)}); make it yours alone: chmod 600`;
  if (st.nlink !== 1) return "has more than one name (a hard link), so another file could be it";
  return null;
}

/** A key's content: one line of 20 to 512 of the characters API keys are made of (Google's are 39). */
const KEY_TEXT = /^[A-Za-z0-9._~-]{20,512}$/;
/**
 * Other vendors' one-line secrets, which KEY_TEXT alone would take: a local config pointed at one of
 * these files would have relay send it to Google. Refused by their published prefixes. Not a barrier
 * against every secret of that alphabet (what is, is that only the person can write the local
 * config); it catches the likeliest mistake. Google's own keys begin "AIza".
 */
const OTHER_VENDORS: readonly [RegExp, string][] = [
  [/^sk-ant-/, "Anthropic's"],
  [/^sk-/, "OpenAI's (or another sk- key)"],
  [/^(gh[pousr]_|github_pat_)/, "GitHub's"],
  [/^xai-/, "xAI's"],
  [/^glpat-/, "GitLab's"],
  [/^xox[abeprs]-/, "Slack's"],
  [/^(AKIA|ASIA)[A-Z0-9]{16}$/, "AWS's"],
];
/** More than a key and a line break could ever take. */
const MAX_BYTES = 1024;

/**
 * Reads the API key in `file`, after checking that nobody but the person could have put it there
 * or can read it: its directory is a real directory of theirs that no one else can write; the file
 * itself, checked on the descriptor relay reads (opened without following a link, so nothing can be
 * swapped in between the check and the read), is a regular file with one name, theirs, readable by
 * no one else; and it holds exactly one key and one optional line break. Anything else (a JSON
 * credential, a key with a variable name in front, two lines) is refused, not sent. Errors name
 * the file and the problem, never the content.
 */
export function readKeyFile(file: string): string {
  return checkKeyFile(file, { content: true })!;
}

/**
 * readKeyFile's checks, with `content` false stopping before the file's content is read: the
 * directory's and the open file's status only (doctor, where the person has not opted in). Returns
 * the key when `content` is true, else null; throws as readKeyFile does.
 */
export function checkKeyFile(file: string, { content }: { content: boolean }): string | null {
  const where = `the API key file ${file}`;
  const dir = path.dirname(file);
  const dst = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!dst) throw new Error(`there is no API key file at ${file}. ${keySetup(file)}`);
  const dirProblem = keyDirStatProblem(dst, dir);
  if (dirProblem) throw new Error(`the directory of ${where} (${dir}) ${dirProblem}`);
  const synced = inSynced(dir);
  if (synced) throw new Error(`${where} is in relay's synced config directory (${synced}), so it would be synced; keep it in a directory of this machine's own, such as ${defaultKeyDir()}`);
  if (broad(dir)) throw new Error(`${where} is in ${dir}, which is or holds your home folder or relay's own directories, so relay cannot keep jobs from writing beside it; keep the key in a directory of its own, such as ${defaultKeyDir()}`);
  const open = agentWritable(dir);
  if (open) throw new Error(`${where} is in ${open}, so an agent relay launches could swap in a key of another account; keep it in a directory of your own, such as ${defaultKeyDir()}`);
  let fd: number;
  try {
    // O_NONBLOCK: a FIFO in its place opens at once (and is then refused) instead of waiting for a writer.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`there is no API key file at ${file}. ${keySetup(file)}`);
    if (code === "ELOOP" || code === "EMLINK") throw new Error(`${where} is a link; relay reads a key only from a file of your own at that path`);
    throw new Error(`relay could not open ${where} (${code ?? (err as Error).message})`);
  }
  try {
    const problem = keyStatProblem(fs.fstatSync(fd));
    if (problem) throw new Error(`${where} ${problem}`);
    if (!content) return null;
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let n = 0;
    for (let got; n < buf.length && (got = fs.readSync(fd, buf, n, buf.length - n, null)) > 0;) n += got;
    if (n > MAX_BYTES) throw new Error(`${where} is too large to hold one API key`);
    const text = buf.subarray(0, n).toString("utf8").replace(/\r?\n$/, "");
    if (!KEY_TEXT.test(text)) throw new Error(`${where} does not hold one API key: it must be one line of 20 to 512 letters, digits and . _ ~ - (Google's keys are 39), with nothing before or after it`);
    const other = OTHER_VENDORS.find(([shape]) => shape.test(text));
    if (other) throw new Error(`${where} holds what looks like ${other[1]} secret, not a Google API key, so relay does not send it to Google`);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/** `target`'s API key, from its key file (apiKeyFile), checked as readKeyFile says. */
export const readApiKey = (target: Target): string => readKeyFile(apiKeyFile(target));

/** Whether `file` lies in the default key directory, which relay's sandbox denies whole to confined agents (keyPathsToDeny). */
const inDefaultDir = (file: string): boolean => path.resolve(file).startsWith(defaultKeyDir() + path.sep);

/**
 * For doctor: where `target`'s key file is and whether relay would read it, never what it holds.
 * `problem` is why relay would refuse it (as a turn would), or null; `denied` how relay's sandbox
 * keeps confined agents from it (keyPathsToDeny): its whole directory where it is in the default
 * one, the file itself where the local config moves it, null where relay cannot tell which file it
 * is. With `content` false (the person has not opted in, so no turn would read it), the file's
 * content is not read: only where it is and its status.
 */
export function keyFileStatus(target: Target, { content }: { content: boolean }): { file: string | null; problem: string | null; denied: "directory" | "file" | null } {
  let file: string;
  try {
    file = apiKeyFile(target);
  } catch (err) {
    return { file: null, problem: (err as Error).message, denied: null };
  }
  const denied = inDefaultDir(file) ? "directory" : "file";
  try {
    checkKeyFile(file, { content });
  } catch (err) {
    return { file, problem: (err as Error).message, denied };
  }
  return { file, problem: null, denied };
}
