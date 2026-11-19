import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Outside every harness's shared temp allowance. Keep names short: Darwin's sockaddr_un
// accommodates only 103 pathname bytes. Grants may cover neither these roots nor an ancestor.
export const privateStateRoot = (): string => path.join(fs.realpathSync(os.homedir()), ".relay-t");
// Claude falls back to shared /tmp/claude-<uid> if its own subdir exceeds 44 bytes (CLAUDE_TEMP_LIMIT).
// This root plus a six-character turn name leaves room for that suffix under a short home; under
// a longer one, Claude is given the turn through nativeTempAlias instead.
export const nativeTempRoot = (): string => path.join(fs.realpathSync(os.homedir()), ".rn");

export function ensurePrivateRoot(dir: string): string {
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) {
    throw new Error(`relay's private directory ${dir} must be a plain directory owned by this user`);
  }
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * Claude Code's own limit (in every version of VERIFIED.claudeTempLink, targets/verified.ts):
 * `path.join(CLAUDE_CODE_TMPDIR, "claude-<uid>")`, measured as given, links unresolved. Past it,
 * its sandboxed commands get the shared /tmp/claude-<uid> instead
 * (docs/research/claude-temp-limit.md).
 */
export const CLAUDE_TEMP_LIMIT = 44;
const uid = (): number => process.getuid?.() ?? 0;
/** Whether Claude keeps `dir` as its CLAUDE_CODE_TMPDIR rather than fall back to shared temp. */
export const claudeTempFits = (dir: string): boolean => Buffer.byteLength(path.join(dir, `claude-${uid()}`)) <= CLAUDE_TEMP_LIMIT;

const ALIAS_PARENT = "/Users/Shared";
let aliasParent = ALIAS_PARENT;
/** Tests only: another directory for the short link, or null for the real one. Nothing in relay calls this. */
export function setNativeTempAliasParentForTests(dir: string | null): void {
  aliasParent = dir ?? ALIAS_PARENT;
}

/**
 * The short name of `~/.rn` that relay hands Claude when `~/.rn` is too long for it: a link of this
 * user's in /Users/Shared, which is sticky (only an entry's owner or root can rename or remove it)
 * and which no agent's sandbox writes by default. The turns' files stay in `~/.rn`.
 */
export const nativeTempAlias = (): string => path.join(aliasParent, `.rn-${uid()}`);

/**
 * Throws unless every directory on the way to `dir` and `dir` itself is owned by root or this user
 * and writable by no one else unless sticky, and every link on the way is owned by root or this
 * user. Then no other user can replace an entry of this user's in `dir`, or anything on the way to
 * it. The walk takes each name in the order the kernel does: a link's target from the directory
 * holding the link (or from / when absolute), and `..` from the directory the walk has reached, so
 * it checks the directories the path really passes. (ACLs are not read: one granting others
 * that is an administrator's, like root.)
 */
function checkAncestry(dir: string, me: number): void {
  const names = (p: string) => p.split(path.sep).filter((n) => n !== "" && n !== ".");
  const owned = (p: string, st: fs.Stats) => {
    if (st.uid !== 0 && st.uid !== me) throw new Error(`${p} is owned by uid ${st.uid}, neither root nor this user`);
  };
  const safeDir = (p: string, st: fs.Stats) => {
    owned(p, st);
    if (!st.isDirectory()) throw new Error(`${p} is not a directory`);
    if ((st.mode & 0o022) && !(st.mode & 0o1000)) throw new Error(`${p} can be written by other users and is not sticky, so they could replace what is in it`);
  };
  if (!path.isAbsolute(dir)) throw new Error(`${dir} is not an absolute path`);
  let rest = names(dir);
  // Always a real directory already checked: the names walked so far, with every link followed.
  let cur: string = path.sep;
  safeDir(cur, fs.lstatSync(cur));
  let links = 0;
  for (let name = rest.shift(); name !== undefined; name = rest.shift()) {
    if (name === "..") { cur = path.dirname(cur); continue; }
    const next = path.join(cur, name);
    const st = fs.lstatSync(next);
    if (st.isSymbolicLink()) {
      owned(next, st);
      if (++links > 16) throw new Error(`there are too many links on the way to ${dir}`);
      const to = fs.readlinkSync(next);
      rest = [...names(to), ...rest];
      if (path.isAbsolute(to)) cur = path.sep;
      continue;
    }
    safeDir(next, st);
    cur = next;
  }
}

/**
 * Recognize a deleted private root by the owned link's canonical absolute `.rn` name. There is no
 * inode left to check. Walk only plain, trusted ancestors, stopping at the first missing entry;
 * never follow an old root or a link on its way, and never remove anything at the old destination.
 */
function missingNativeTempRoot(target: string, me: number): boolean {
  if (!path.isAbsolute(target) || path.normalize(target) !== target || path.basename(target) !== ".rn") return false;
  let cur: string = path.sep;
  const names = target.split(path.sep).filter(Boolean);
  for (const [i, name] of names.entries()) {
    cur = path.join(cur, name);
    const st = fs.lstatSync(cur, { throwIfNoEntry: false });
    if (!st) return true;
    if (i === names.length - 1 || !st.isDirectory() || st.isSymbolicLink()) return false;
    if (st.uid !== 0 && st.uid !== me) return false;
    if ((st.mode & 0o022) && !(st.mode & 0o1000)) return false;
  }
  return false;
}

/** The short link as it stands: usable, absent, safely replaceable after an earlier home vanished, or refused. */
export type NativeTempAliasState = { state: "ok" } | { state: "missing" }
  | { state: "stale"; target: string; dev: number; ino: number }
  | { state: "refused"; problem: string };

/**
 * Checks the short link to `target` (the real `~/.rn`) and the way to it, making nothing. Each check
 * reads the entry itself (no follow) until the last, which compares where it leads with `target`
 * when `target` exists (relay makes `~/.rn` before it uses the link). Doctor reports this; turns use
 * ensureNativeTempAlias, which makes a missing link or repoints a stale one and checks it again.
 */
export function checkNativeTempAlias(target: string): NativeTempAliasState {
  const me = uid();
  const alias = nativeTempAlias();
  const refused = (problem: string): NativeTempAliasState => ({ state: "refused", problem: `relay's short link ${alias} to ${target} cannot be used: ${problem}` });
  try {
    checkAncestry(path.dirname(alias), me);
    const st = fs.lstatSync(alias, { throwIfNoEntry: false });
    if (!st) return { state: "missing" };
    if (!st.isSymbolicLink()) return refused("something that is not a link is already there. Relay does not remove it; once it is gone, relay makes its link");
    if (st.uid !== me) return refused(`it is owned by uid ${st.uid}, not this user (${me}): another user may have made it first. Relay does not use or remove it; an administrator can`);
    const to = fs.readlinkSync(alias);
    if (to !== target) {
      if (missingNativeTempRoot(to, me)) return { state: "stale", target: to, dev: st.dev, ino: st.ino };
      return refused(`it points to ${to}. Relay only replaces an owned link to a missing private .rn directory through trusted ancestors; remove this link yourself if it is no longer needed`);
    }
    const t = fs.lstatSync(target, { throwIfNoEntry: false });
    if (t) {
      const a = fs.statSync(alias);
      if (a.dev !== t.dev || a.ino !== t.ino) return refused("it does not lead to that directory");
    }
    return { state: "ok" };
  } catch (err) { return refused((err as Error).message); }
}

/**
 * Makes the short link to `target` (the real `~/.rn`, already checked) if missing, or atomically
 * repoints an owned link whose former private root is gone. The staged link is inside a fresh
 * private directory in the same parent; rename replaces only the alias entry, never its target.
 * Other destinations, foreign owners, non-links and unsafe ancestry still refuse.
 */
export function ensureNativeTempAlias(target: string): string {
  const alias = nativeTempAlias();
  let found = checkNativeTempAlias(target);
  if (found.state === "missing") {
    try { fs.symlinkSync(target, alias); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`relay's short link ${alias} to ${target} cannot be made: ${(err as Error).message}`); }
    found = checkNativeTempAlias(target);
  }
  if (found.state === "stale") {
    const previous = found;
    const staging = fs.mkdtempSync(path.join(path.dirname(alias), ".rn-swap-"));
    try {
      fs.chmodSync(staging, 0o700);
      const staged = path.join(staging, "link");
      fs.symlinkSync(target, staged);
      // Another relay may have repaired it already. Never overwrite an entry that changed since
      // the check; the sticky parent protects our link against replacement by another uid.
      const current = checkNativeTempAlias(target);
      if (current.state === "stale" && current.dev === previous.dev && current.ino === previous.ino && current.target === previous.target) {
        fs.renameSync(staged, alias);
      } else if (current.state !== "ok") {
        throw new Error(`relay's short link ${alias} changed while relay was preparing its replacement; retry this turn`);
      }
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    found = checkNativeTempAlias(target);
  }
  if (found.state === "refused") throw new Error(found.problem);
  if (found.state === "missing") throw new Error(`relay's short link ${alias} to ${target} is not there after relay made it`);
  if (found.state === "stale") throw new Error(`relay's short link ${alias} still points to a missing earlier private directory after relay replaced it`);
  return alias;
}
