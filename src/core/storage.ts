// How relay writes what it keeps in its control directory: logs rotated at log_max_mb, the secrets
// relay knows the shape of cut out (secrets.ts), and a write that fails (a full disk, a directory
// that is not writable) said in words a person can act on, never thrown at a worker that has a turn
// to finish; and what doctor says of the directory's size and the room left. Retention of whole
// runs is retention.ts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, relayHome, type RelayConfig } from "./config.js";
import { redact } from "./secrets.js";

const MB = 1024 * 1024;

/** The storage policy set for this process (useStoragePolicy): a worker's, its run's config. */
let policy: { logMaxBytes: number | null } | null = null;
/** Without one, the size the user's config gave when it last loaded: none until it has. */
let lastLoaded: number | null = null;

/** The size in bytes at which a config's logs are rotated, or null for none. */
export const logBytes = (cfg: Pick<RelayConfig, "log_max_mb">): number | null =>
  cfg.log_max_mb === null || cfg.log_max_mb === undefined ? null : Math.max(1, Math.round(cfg.log_max_mb * MB));

/** Sets the storage policy this process works under: a worker's, its run's config. */
export function useStoragePolicy(cfg: Pick<RelayConfig, "log_max_mb">): void {
  policy = { logMaxBytes: logBytes(cfg) };
}

/**
 * The size at which this process rotates the logs it writes, or null for none: the policy set for
 * it (useStoragePolicy), or else the user's config as it is now, read at each call as relay reads
 * its config for every call it serves (a relay server's diagnostic logs). A config that does not
 * load keeps the size it last gave.
 */
export function logMaxBytes(): number | null {
  if (policy) return policy.logMaxBytes;
  try {
    lastLoaded = logBytes(loadConfig());
  } catch {
    // Kept as it last loaded: an edit in progress does not turn rotation off.
  }
  return lastLoaded;
}

/** How long a rotation's lock (below) can be held before it counts as left by a process that was killed. */
const LOCK_STALE_MS = 10_000;

/**
 * Moves `file` to `file.1`, replacing an earlier one, when `incoming` more bytes would take it past
 * `max` (a file that is empty, or missing, stays). Returns what went wrong when the move failed;
 * never throws. Several relay processes append to the same diagnostic logs (notices.log,
 * elicitation.log), so one rotates at a time (a lock beside the file, `<file>.rotating`) and looks
 * at the file again once it holds it: a file another process has just rotated is not rotated
 * again, which would move its fresh file over the part it moved aside. A process that finds the
 * lock held leaves the rotation to its holder.
 */
export function rotateLog(file: string, max: number | null, incoming = 0): string | null {
  if (max === null) return null;
  const over = () => {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    return st !== undefined && st.size > 0 && st.size + incoming > max;
  };
  const lock = `${file}.rotating`;
  let locked = false;
  try {
    if (!over()) return null;
    try {
      fs.mkdirSync(lock);
      locked = true;
    } catch (err) {
      // Otherwise a directory that cannot be written: the move below says why, in its own words.
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const held = fs.statSync(lock, { throwIfNoEntry: false });
        if (held && Date.now() - held.mtimeMs < LOCK_STALE_MS) return null;
        // Left by a process killed while it rotated: taken over.
        locked = true;
      }
    }
    if (locked && !over()) return null;
    fs.renameSync(file, `${file}.1`);
    return null;
  } catch (err) {
    // Rotated by another process between the look and the move.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return (err as Error).message;
  } finally {
    if (locked) {
      try {
        fs.rmdirSync(lock);
      } catch {
        // Taken over once it is stale.
      }
    }
  }
}

const FULL = new Set(["ENOSPC", "EDQUOT"]);
/** A refusal that a write gets from a file or directory it may not change, and a read from one it may not look at: a write's only where relay knows it was writing. */
const DENIED = new Set(["EACCES", "EPERM"]);
/** The calls Node names in an error (err.syscall) that only a write makes. An open is a read's or a write's, so it counts only inside writing(). */
const WRITE_SYSCALLS = new Set(["mkdir", "mkdtemp", "rename", "unlink", "rmdir", "rm", "write", "ftruncate", "link", "symlink", "chmod", "fchmod", "chown", "fchown", "copyfile", "utime", "futime", "fsync", "fdatasync"]);
/** SQLite's own result codes (node:sqlite gives them as errcode, extended codes in the high bits): SQLITE_FULL, SQLITE_READONLY. */
const SQLITE_FULL = 13;
const SQLITE_READONLY = 8;
/** Errors thrown from inside writing(): relay was writing when it got them. */
const fromWrites = new WeakSet<object>();

/**
 * Runs `write`, a write of relay's (a file it launches an agent with, say), so that what it throws
 * is known to be a write's (storageProblem): its error is thrown on unchanged.
 */
export function writing<T>(write: () => T): T {
  try {
    return write();
  } catch (err) {
    if (err && typeof err === "object") fromWrites.add(err);
    throw err;
  }
}

/**
 * What a failed write ran into: a full disk, something not writable, or neither that relay can
 * tell. `written`: relay knows it was writing (writeProblem); otherwise a refusal (EACCES, EPERM)
 * counts only from a call that writes (WRITE_SYSCALLS, writing()), as a read's is no write problem.
 */
function kindOf(err: unknown, written: boolean): "full" | "not writable" | null {
  const e = err as (NodeJS.ErrnoException & { errcode?: unknown }) | null;
  if (e?.code === "ERR_SQLITE_ERROR" && typeof e.errcode === "number") {
    const primary = e.errcode & 0xff;
    return primary === SQLITE_FULL ? "full" : primary === SQLITE_READONLY ? "not writable" : null;
  }
  if (!e?.code) return null;
  if (FULL.has(e.code)) return "full";
  if (e.code === "EROFS") return "not writable";
  const write = written || (e.syscall !== undefined && WRITE_SYSCALLS.has(e.syscall)) || fromWrites.has(e);
  return DENIED.has(e.code) && write ? "not writable" : null;
}

/** True for the errors a write gets from a full disk or a file or directory that cannot be written, relay's registry included; a refusal only where it was a write's (kindOf). */
export const isStorageError = (err: unknown): boolean => kindOf(err, false) !== null;

/** What a person can do about a failed write (relay knows it was writing), or null when relay cannot tell: a full disk, a file or directory that is not writable. */
export function remedy(err: unknown): string | null {
  const kind = kindOf(err, true);
  return kind === "full" ? "the disk it is on is full; free space there"
    : kind === "not writable" ? "it, or the directory it is in, is not writable; make it writable again"
    : null;
}

/**
 * What a failed write of `file` means, in words a person can act on: what was refused, then what
 * that cost (`consequence`, from where relay was writing), then what to do about it.
 */
export function writeProblem(file: string, err: unknown, consequence?: string): string {
  const hint = remedy(err);
  return `relay could not write ${file} (${(err as Error | null)?.message ?? String(err)})${consequence ? `, so ${consequence}` : ""}${hint ? `: ${hint}` : ""}`;
}

/** What a failed read of `file` means: what was refused, then what that cost. */
export function readProblem(file: string, err: unknown, consequence?: string): string {
  return `relay could not read ${file} (${(err as Error | null)?.message ?? String(err)})${consequence ? `, so ${consequence}` : ""}`;
}

/**
 * The storage problem behind an error from the filesystem or the registry, or null when it is not
 * one (isStorageError), for a catch that holds reads as well as writes: a refusal is one only from
 * a write (kindOf). `consequence` as for writeProblem.
 */
export function storageProblem(err: unknown, consequence?: string): string | null {
  if (!isStorageError(err)) return null;
  const e = err as NodeJS.ErrnoException;
  const file = e.code === "ERR_SQLITE_ERROR" ? `its registry ${path.join(relayHome(), "relay.db")}` : e.path ?? "a file in its control directory";
  return writeProblem(file, err, consequence);
}

/**
 * What this process could not write to its own diagnostic logs (elicitation.log, notices.log,
 * worker.log): the first failure of each, not yet said. A diagnostic log that fails takes nothing
 * else down, but it is not silent either: a relay server says it with its next tool result, and a
 * worker with its next turn's warnings (takeDiagnosticProblems).
 */
const diagnostics = { pending: [] as { problem: string; owner: string | null }[], said: new Set<string>() };

/**
 * Notes a diagnostic log's failure, once per file and process. `owner`: the root token of the run
 * whose work the log belongs to (a worker.log), whose text names that run's paths, so that on a
 * shared process only the conversation owning the run hears it. Null for relay's own logs
 * (elicitation.log, notices.log), whose text names no item.
 */
export function noteDiagnosticProblem(file: string, problem: string, owner: string | null = null): void {
  if (diagnostics.said.has(file)) return;
  diagnostics.said.add(file);
  diagnostics.pending.push({ problem, owner });
}

/**
 * The diagnostic logs' failures not yet said, which are then counted as said. Without `owner`, all
 * of them (a process serving one scope). With it, relay's own and that owner's only, the rest kept
 * for their own conversation; null takes relay's own only.
 */
export function takeDiagnosticProblems(owner?: string | null): string[] {
  const taken: string[] = [];
  diagnostics.pending = diagnostics.pending.filter((d) => {
    const mine = owner === undefined || d.owner === null || d.owner === owner;
    if (mine) taken.push(d.problem);
    return !mine;
  });
  return taken;
}

/**
 * Appends to one of relay's own logs in the control directory (elicitation.log, notices.log),
 * rotating it first, with the secrets relay knows the shape of cut out (core/secrets.ts).
 * Diagnostics: what went wrong is returned, never thrown, and noted to be said (noteDiagnosticProblem).
 */
export function appendLog(file: string, text: string, o: { maxBytes?: number | null } = {}): string | null {
  let problem: string | null = null;
  try {
    const kept = redact(text);
    const unrotated = rotateLog(file, o.maxBytes === undefined ? logMaxBytes() : o.maxBytes, Buffer.byteLength(kept));
    if (unrotated) problem = `relay could not rotate ${file} at log_max_mb (${unrotated}), so it grows past that size`;
    fs.appendFileSync(file, kept);
  } catch (err) {
    problem = writeProblem(file, err, "an entry of that diagnostic log is missing, and nothing else is affected");
  }
  if (problem) noteDiagnosticProblem(file, problem);
  return problem;
}

/**
 * Writes or appends to a record relay keeps for a person to read (a prompt's copy, a final message,
 * a transcript), with the secrets relay knows the shape of cut out (core/secrets.ts): what was
 * sent is in the registry as sent. The work it records goes on without it, so what went wrong is
 * returned, not thrown: with `consequence`, what not having it costs (writeProblem). A whole file
 * is written beside it first and then renamed into place, so that a record rewritten (a review's
 * file marked with the families) keeps what it held when the new text cannot be written whole.
 */
export function keepRecord(file: string, text: string, o: { append?: boolean; consequence?: string } = {}): string | null {
  try {
    const kept = redact(text);
    if (o.append) fs.appendFileSync(file, kept);
    else replaceFile(file, kept);
    return null;
  } catch (err) {
    return writeProblem(file, err, o.consequence);
  }
}

/**
 * Writes `file` whole or not at all: to a new file beside it, then renamed over it. What fails is
 * thrown, the new file removed. A file there already that may not be written is not replaced
 * either, as writing it in place would not have: the refusal is thrown.
 */
function replaceFile(file: string, text: string): void {
  try {
    fs.accessSync(file, fs.constants.W_OK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, text, { flag: "wx" });
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Left beside the record, in a directory relay could not change; a run's forgetting takes it.
    }
    throw err;
  }
}

/** What relay's control directory holds, and the room left on its disk. */
export interface ControlDirUsage {
  dir: string;
  /** Bytes in it, every file counted once (links not followed). */
  bytes: number;
  /** Runs with records in it (runs/run_*). */
  runs: number;
  /** Bytes free on its disk for this user, or null when relay could not tell. */
  free: number | null;
  /** The copies of the registry relay made before upgrading it (registryBackups). */
  backups: string[];
  /** What could not be looked at. */
  problem?: string;
}

/** Measures `dir` (relay's control directory). Nothing in it is changed. */
export function controlDirUsage(dir: string): ControlDirUsage {
  const out: ControlDirUsage = { dir, bytes: 0, runs: 0, free: null, backups: registryBackups(dir) };
  if (!fs.existsSync(dir)) return out;
  try {
    const st = fs.statfsSync(dir);
    out.free = st.bavail * st.bsize;
  } catch (err) {
    out.problem = `relay could not tell how much room is left on its disk (${(err as Error).message})`;
  }
  try {
    out.runs = fs.readdirSync(path.join(dir, "runs")).filter((n) => /^run_[0-9a-f]+$/.test(n)).length;
  } catch {
    // No runs yet.
  }
  const stack = [dir];
  let unread = 0;
  while (stack.length) {
    const d = stack.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(d);
    } catch {
      unread++;
      continue;
    }
    for (const name of names) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) stack.push(p);
      else out.bytes += st.size;
    }
  }
  if (unread) out.problem = [out.problem, `${unread} director${unread === 1 ? "y" : "ies"} in it could not be read, so its size is more than shown`].filter(Boolean).join("; ");
  return out;
}

/**
 * The copies of the registry in `dir` that relay made before upgrading it to a new schema
 * (db.ts guardVersion: relay.db.backup-v<version>-<time>-<pid>). Each holds every run the registry
 * held then, prompts included, and nothing removes them: keep_records_days does not apply to them,
 * since going back to the relay that wrote one depends on it.
 */
export function registryBackups(dir: string = relayHome()): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => /^relay\.db\.backup-v/.test(n)).sort().map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Below this much room on the control directory's disk, doctor warns. */
export const LOW_FREE = 1024 ** 3;

/** A size to one decimal, rounded down, so that what is just under a limit never reads as the limit (1023.9 MB, not 1024.0). */
const tenths = (bytes: number, unit: number) => (Math.floor((bytes * 10) / unit) / 10).toFixed(1);
const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${tenths(bytes, 1024 ** 3)} GB` : bytes >= MB ? `${tenths(bytes, MB)} MB` : `${Math.ceil(bytes / 1024)} KB`);

/** What doctor says about relay's records: their size, the room left, and the storage policy; and a warning when the room is short. */
export function storageReport(u: ControlDirUsage, cfg: Pick<RelayConfig, "log_max_mb" | "keep_records_days">): { lines: string[]; warning: string | null } {
  const room = u.free === null ? "" : `; ${size(u.free)} free on its disk`;
  const lines = [
    `${size(u.bytes)} in ${u.dir}, with the records of ${u.runs} run${u.runs === 1 ? "" : "s"}${room}${u.problem ? ` (${u.problem})` : ""}`,
    cfg.log_max_mb === null ? "logs: kept whole (log_max_mb not set)" : `logs: each rotated at ${cfg.log_max_mb} MB to <name>.1, so about twice that is kept of each (log_max_mb)`,
    cfg.keep_records_days === null
      ? "records: kept until you delete them (keep_records_days not set), ended rooms' transcripts too; relay clean and a worker remove only the temporary directories relay left behind"
      : `records: a run's are forgotten after ${cfg.keep_records_days} days without activity, by relay clean and by a worker once a day, never while the run is in use; an ended room's, with its transcript, ${cfg.keep_records_days} days after it ended (keep_records_days)`,
    ...(u.backups.length ? [`registry backups: ${u.backups.length}, made before relay upgraded its registry, each a whole copy of it then, prompts included; relay never removes them, whatever keep_records_days says. Delete them once you will not go back to the relay that wrote them: ${u.backups.join(", ")}`] : []),
  ];
  const warning = u.free !== null && u.free < LOW_FREE
    ? `only ${size(u.free)} free on the disk holding ${u.dir}. Once it is full, relay can keep no copy of a turn's prompt, log or final message and cannot update its registry, so turns fail and what they said may not be recorded. Free space there, or set log_max_mb and keep_records_days`
    : null;
  return { lines, warning };
}
