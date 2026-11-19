import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { worktreeDir } from "./config.js";
import { CONTEXT_DIR, readRegularFile } from "./context.js";
import { gitExecutable, notFound } from "./executables.js";
import { sendGroupSignal } from "./procs.js";

interface GitResult {
  ok: boolean;
  /** Standard output, trimmed. */
  out: string;
  /** Standard output as git wrote it, for NUL-separated names, where trimming would cut spaces from a name. */
  raw: string;
  err: string;
  /** The exit status, or null when git did not run to completion. */
  code: number | null;
}

/**
 * Settings for every git command relay runs. Relay's git runs outside any sandbox, with the user's
 * access, in trees an agent has just written to, so nothing in such a tree may get code run
 * through it:
 * - Hooks are off. A relative core.hooksPath (Husky sets one) points inside the worktree, and
 *   --no-verify skips only some hooks.
 * - The fsmonitor hook is off, and git does not look inside nested repositories, whose own
 *   config an agent can write (see untrustedNestedRepos for the one command this does not cover).
 * This also means the user's own hooks do not run for relay's commits, merges and checkouts.
 * Content filters and merge drivers are refused before any command that could run them
 * (filterRefusal); diff drivers and an external diff are left alone, since relay's own diffs pass
 * --no-ext-diff --no-textconv. A job's worktree is never located through its own `.git` file (jobTree).
 */
const SAFE = [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "diff.ignoreSubmodules=dirty",
  // Signing can stop to ask for a passphrase, with nobody there. Relay's own commits are unsigned.
  "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
];
const GIT_TIMEOUT_MS = 300_000;

/**
 * For relay's own checkouts and merges: Git LFS leaves its pointer files in place instead of
 * fetching the objects. Its smudge filter downloads from the server the repository's settings name,
 * with your credentials and outside any sandbox, and `.lfsconfig`, a file in the tree an agent
 * wrote, can name another server. Objects already stored locally are not affected by this; files
 * left as pointers are filled in with `git lfs checkout` (or `git lfs pull`).
 */
const NO_LFS_FETCH = { GIT_LFS_SKIP_SMUDGE: "1" };
/**
 * For relay's `git worktree add`: write the files with four processes when there are at least 400
 * to write. On a 3,000-file tree this took the checkout from about 200 ms to 130; below about 400
 * files starting the workers costs more than it saves. The workers are git's own
 * (`git checkout--worker`, git 2.32 and later), started by git, in its process group and with its
 * settings; an older git ignores keys it does not know. A file that needs a filter (Git LFS's,
 * whose downloads are skipped all the same) is still written by git itself.
 */
const PARALLEL_CHECKOUT = ["-c", "checkout.workers=4", "-c", "checkout.thresholdForParallelism=400"];
/** For relay's commands that name files: every name is that one file, never a pathspec pattern or magic. */
const LITERAL_PATHS = { GIT_LITERAL_PATHSPECS: "1" };

/**
 * A job's worktree, as relay runs git for it. The worktree's `.git` file is the agent's to rewrite,
 * and git takes the repository (its config, and so its hooks, filters and drivers) from wherever
 * that file points. Relay therefore finds the worktree's git directory in the repository's own
 * records (see jobTree) and passes it, and the worktree, to git explicitly.
 */
export interface JobTree {
  /** The worktree, its real path. */
  worktree: string;
  /** Its administrative git directory in the repository, `<common>/worktrees/<name>`. */
  gitDir: string;
  /** The repository's common git directory. */
  commonDir: string;
  /** What every git command relay runs for the worktree is given. */
  env: { GIT_DIR: string; GIT_WORK_TREE: string };
}
/**
 * Where relay runs git: a checkout whose git metadata no job can write (the user's own, or the main
 * one of a repository), given as a directory in it; or a job's worktree.
 */
type GitAt = string | JobTree;

export function git(at: GitAt, args: string[], env: Record<string, string> = {}): GitResult {
  return gitWithin(GIT_TIMEOUT_MS, at, args, env);
}

/** git() under another time limit, so that a test can make git overrun; relay itself goes through git(). */
export function gitWithin(timeoutMs: number, at: GitAt, args: string[], env: Record<string, string> = {}): GitResult {
  const cwd = typeof at === "string" ? at : at.worktree;
  // The git found on PATH when this process first ran one, by its absolute name (executables.ts).
  const bin = gitExecutable();
  if (!bin) return { ok: false, out: "", raw: "", err: notFound("git"), code: null };
  const options = {
    cwd,
    encoding: "utf8" as const,
    timeout: timeoutMs,
    killSignal: "SIGKILL" as const,
    // Git starts as the leader of a new session, and so of its own process group, so that a git that
    // overruns is stopped together with whatever it started (a filter or credential helper, say),
    // not just git itself. Node's synchronous spawn applies this as its asynchronous one does
    // (spawn_sync.cc), though its types leave it out; test/git-safety.test.ts holds it to that. It
    // replaced a perl wrapper that called setpgrp, a process start on every call.
    detached: true,
    // The C locale, because relay reads some of git's messages.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C", ...(typeof at === "string" ? {} : at.env), ...env },
  };
  const r = spawnSync(bin, [...SAFE, ...args], options);
  if (r.error) {
    const timedOut = (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    if (timedOut && r.pid) {
      try {
        sendGroupSignal(r.pid, "SIGKILL");
      } catch {
        // Nothing of it is left.
      }
    }
    return { ok: false, out: "", raw: "", err: timedOut ? `git ${args[0]} did not finish within ${timeoutMs / 1000}s` : r.error.message, code: null };
  }
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), raw: r.stdout ?? "", err: (r.stderr ?? "").trim(), code: r.status };
}

/** NUL-separated names from git's -z output. */
const names = (r: GitResult) => r.raw.split("\0").filter(Boolean);

/** A repository's common git directory, its real path, asked of a checkout relay trusts; null when git cannot say. */
function commonDirOf(at: GitAt): string | null {
  const r = git(at, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!r.ok || !r.out) return null;
  try {
    return fs.realpathSync(r.out);
  } catch {
    return null;
  }
}

/** A `.git` file or `gitdir` record as git writes one is a line or two; anything bigger is not git's. */
const RECORD_MAX_BYTES = 8192;
const readRecord = (file: string): string | null => {
  try {
    return readRegularFile(file, RECORD_MAX_BYTES);
  } catch {
    return null;
  }
};
const realOrNull = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * The job worktree `worktree` of the repository whose main checkout is `repo`, with the git
 * directory the repository itself records for it, or why relay will not run git there.
 *
 * The record is found from the repository's side, which no job can write: each linked worktree has
 * a directory `<common>/worktrees/<name>` whose `gitdir` file names the worktree's `.git`. The
 * worktree's own `.git` file must still be the regular file pointing back at that directory. A job's
 * agent can rewrite it, and git would then take its config, and the commands it names, from
 * wherever the file points; relay refuses rather than run git for that worktree at all. Call it
 * before every operation: nothing about a worktree an agent can write stays true between two.
 */
export function jobTree(repo: string, worktree: string): JobTree | { error: string } {
  const wt = realOrNull(worktree);
  if (!wt) return { error: `the worktree ${worktree} no longer exists` };
  const common = commonDirOf(repo);
  if (!common) return { error: `git could not find the git directory of ${repo}, so relay cannot tell which git directory the worktree ${wt} belongs to` };
  const records = path.join(common, "worktrees");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(records);
  } catch {
    // No linked worktrees at all.
  }
  const matches = entries.map((name) => path.join(records, name)).filter((admin) => {
    const back = readRecord(path.join(admin, "gitdir"));
    if (back === null) return false;
    // Absolute as git writes it by default; relative to the record with worktree.useRelativePaths.
    const target = path.resolve(admin, back.trim());
    return path.basename(target) === ".git" && realOrNull(path.dirname(target)) === wt;
  });
  if (matches.length === 0) return { error: `the repository ${repo} has no record of the worktree ${wt} (in ${records}), so relay will not run git there` };
  if (matches.length > 1) return { error: `the repository ${repo} records the worktree ${wt} more than once (${matches.join(", ")}), so relay cannot tell which git directory is its own. \`git -C ${repo} worktree prune\` removes stale records` };
  const gitDir = realOrNull(matches[0]);
  if (!gitDir) return { error: `the git directory ${matches[0]} of the worktree ${wt} is gone` };

  const dotGit = path.join(wt, ".git");
  const changed = {
    error: `${dotGit} is no longer the file git made for this worktree, pointing at ${gitDir}: the job's agent, which can write there, changed it. ` +
      `Relay will not run git for this worktree while it is so. Look at what the agent did; if the change is not wanted, delete whatever is at ${dotGit} ` +
      `(\`rm -r\`, which does not follow a link; git's own repair would write through one) and run \`git -C ${repo} worktree repair ${wt}\` to put the file back`,
  };
  const text = readRecord(dotGit);
  const m = text === null ? null : /^gitdir: ([^\n]+)\n?$/.exec(text);
  if (!m) return changed;
  if (realOrNull(path.resolve(wt, m[1].trim())) !== gitDir) return changed;
  return { worktree: wt, gitDir, commonDir: common, env: { GIT_DIR: gitDir, GIT_WORK_TREE: wt } };
}

/** Where relay runs git for a caller in `dir`: the git target, the top of that checkout, and the repository's main checkout. */
export interface Checkout { at: GitAt; top: string; repo: string }
/**
 * The checkout `dir` is in. `holder`: the job whose worktree holds `dir`, from relay's registry,
 * when it is a job's (a launched agent delegating from its own worktree, say). Its git directory
 * then comes from the repository's records (jobTree) and its main checkout from the registry,
 * never from the worktree's `.git` file. Null when `dir` is not in a git repository.
 */
export function checkoutOf(dir: string, holder?: { repo: string | null; worktree: string | null }): Checkout | { error: string } | null {
  if (holder) {
    if (!holder.repo || !holder.worktree) return { error: `${dir} is in a job's worktree whose repository relay did not record` };
    const tree = jobTree(holder.repo, holder.worktree);
    if ("error" in tree) return tree;
    return { at: tree, top: tree.worktree, repo: holder.repo };
  }
  const top = repoRoot(dir);
  if (!top) return null;
  return { at: top, top, repo: mainWorktree(top) ?? top };
}

/**
 * Configured commands git can run on files in the tree, that relay will not run: content filters
 * (clean, smudge, process) other than Git LFS's, and merge drivers. Git runs these when it stages,
 * checks out or merges a file that names them in its attributes, and relay's git is not sandboxed.
 * Diff drivers (textconv, command) and an external diff are left alone: relay's own diffs and greps
 * pass --no-ext-diff and --no-textconv, and nothing else relay runs uses them, so refusing them would
 * only stop people who have difftastic or the like configured. A command that is a script in the
 * repository, or an interpreter that looks for its modules in the current directory, would run
 * whatever the agent left there. Git LFS is a compiled program that takes nothing of the kind.
 */
/** Git LFS's filter commands exactly as `git lfs install` writes them, and nothing appended. */
const LFS = /^git[- ]lfs (?:(?:clean|smudge)(?: --skip)? -- %f|filter-process(?: --skip)?)$/;
const COMMAND_KEYS = "^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver)$";
function configuredCommands(at: GitAt): { key: string; command: string }[] | { error: string } {
  // NUL-terminated entries of "key\nvalue": a value can itself span lines, and each line must not be read as an entry of its own.
  const r = git(at, ["config", "-z", "--get-regexp", COMMAND_KEYS]);
  // Exit status 1 with nothing printed is git's way of saying there are none. Anything else is not knowing, which counts against.
  if (r.code === 1 && !r.out && !r.err) return [];
  if (!r.ok) return { error: r.err || `exit ${r.code}` };
  return r.raw.split("\0").filter(Boolean).map((entry) => {
    const nl = entry.indexOf("\n");
    return { key: nl < 0 ? entry : entry.slice(0, nl), command: nl < 0 ? "" : entry.slice(nl + 1) };
  }).filter((f) => f.command && !(f.key.startsWith("filter.") && LFS.test(f.command)));
}
const kindOf = (key: string) => (key.startsWith("filter.") ? "a content filter" : "a merge driver");
/**
 * Why relay will not run git here, or null: the admission check before every relay git command
 * that can run a content filter or a driver (staging, checking out, merging, and `git status`,
 * which runs the clean filter on files whose timestamps leave it unsure).
 */
export function filterRefusal(at: GitAt, trust: boolean): string | null {
  if (trust) return null;
  const found = configuredCommands(at);
  if ("error" in found) {
    return `relay could not read this repository's filter and driver settings (${found.error}), so it cannot tell what git would run outside the sandbox on files an agent wrote`;
  }
  if (!found.length) return null;
  const kinds = [...new Set(found.map((f) => kindOf(f.key)))];
  return `this repository runs ${kinds.join(" and ")} (${found.map((f) => `${f.key} = ${JSON.stringify(f.command)}`).join("; ")}) that relay would have to run outside the sandbox on files an agent wrote. ` +
    `Set "trust_git_filters": true in relay's config if ${found.length > 1 ? "these commands" : "that command"} cannot be redirected by files in the repository`;
}

/** Fallback identity so checkpoints work in repos with no user configured. */
function identityArgs(at: GitAt): string[] {
  const name = git(at, ["config", "user.name"]).out;
  const email = git(at, ["config", "user.email"]).out;
  const args: string[] = [];
  if (!name) args.push("-c", "user.name=relay");
  if (!email) args.push("-c", "user.email=relay@localhost");
  return args;
}

/** For a directory in a checkout relay trusts; a job's worktree is located with jobTree instead. */
export function repoRoot(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out : null;
}

/**
 * The repository's main worktree. Git operations that manage worktrees and branches run from
 * here, because a job's own worktree (where a nested job is started from) can be removed later.
 * For a directory in a checkout relay trusts; for a job's worktree the registry records it.
 */
function mainWorktree(cwd: string): string | null {
  const r = git(cwd, ["worktree", "list", "--porcelain"]);
  const first = r.ok ? r.out.split("\n").find((l) => l.startsWith("worktree ")) : undefined;
  return first ? first.slice("worktree ".length) : null;
}

/**
 * "unknown" when git could not tell: a failed status query must never be read as clean. `git status`
 * can run the clean filter, so the caller runs filterRefusal first.
 */
export function treeState(at: GitAt, env: Record<string, string> = {}): "clean" | "dirty" | "unknown" {
  if (!fs.existsSync(typeof at === "string" ? at : at.worktree)) return "unknown";
  // Untracked files are asked for explicitly: status.showUntrackedFiles=no would hide new files,
  // and a tree that only looks clean gets removed.
  const r = git(at, ["status", "--porcelain", "--untracked-files=all"], env);
  if (!r.ok) return "unknown";
  return r.out.length > 0 ? "dirty" : "clean";
}

/**
 * Nested repositories in a worktree whose git directory is not part of the repository itself.
 * An agent can write such a repository's config (filters, for one), and `git add` runs git inside
 * it, so relay does not stage a tree that contains one. A submodule checked out the usual way
 * keeps its git directory inside the main repository's, where a job cannot write, and is fine.
 */
export function untrustedNestedRepos(at: GitAt): string[] | null {
  const worktree = typeof at === "string" ? at : at.worktree;
  const common = typeof at === "string" ? commonDirOf(at) : at.commonDir;
  // NUL-separated output, so that a name with spaces or quotes is read as it is, not as git quotes it.
  const links = git(at, ["ls-files", "-s", "-z"]);
  // git does not list the files of an untracked nested repository, only its directory.
  const status = git(at, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  // Not knowing is not the same as finding none.
  if (!common || !links.ok || !status.ok) return null;
  const gitlinks = names(links).filter((l) => l.startsWith("160000 ")).map((l) => l.slice(l.indexOf("\t") + 1));
  const untracked = names(status).filter((l) => l.startsWith("?? ") && l.endsWith("/")).map((l) => l.slice(3, -1));
  return [...new Set([...gitlinks, ...untracked])].filter((rel) => {
    const entry = path.join(worktree, rel, ".git");
    let st: fs.Stats;
    try {
      st = fs.lstatSync(entry);
    } catch {
      return false;
    }
    if (!st.isFile()) return true;
    const text = readRecord(entry);
    const m = text === null ? null : /^gitdir:\s*(.+)\s*$/m.exec(text);
    if (!m) return true;
    const target = realOrNull(path.resolve(path.dirname(entry), m[1]));
    if (!target) return true;
    return !(target === common || target.startsWith(common + path.sep));
  });
}

export interface Worktree {
  repo: string;
  /**
   * The worktree's root, which is also where the job's agent is launched: a path below it could be
   * swapped for a link by something the agent left running, so the caller's position is passed as `subdir`.
   */
  worktree: string;
  /** The caller's position inside the repository, relative and "/"-separated ("" at its root), for the prompt. */
  subdir: string;
  branch: string;
  baseSha: string;
  callerDirty: boolean;
}

/**
 * Adds relay's context directory to the repository's `info/exclude`, so that the agent's commits
 * leave it out. `common` is the repository's git directory as its main checkout gives it, never as
 * a job's worktree does. Relay appends outside any sandbox, so it follows no link: a link at
 * `info` or `info/exclude`, or a file with a second name elsewhere, would carry the write to
 * another file. Returns why it would not, or null.
 */
function excludeContextDir(common: string): string | null {
  const info = path.join(common, "info");
  const exclude = path.join(info, "exclude");
  const line = `${CONTEXT_DIR}/`;
  try {
    if (!fs.existsSync(info) && !isLink(info)) fs.mkdirSync(info);
    if (!fs.lstatSync(info).isDirectory()) return `${info} is not a directory, and relay does not write through links there`;
    let fd: number;
    try {
      fd = fs.openSync(exclude, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOOP") return `${exclude} is a symbolic link, and relay does not write through links there`;
      throw err;
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return `${exclude} is not a regular file`;
      if (st.nlink !== 1) return `${exclude} has ${st.nlink} names (hard links), so writing to it would change another file too`;
      const current = fs.readFileSync(fd, "utf8");
      if (!current.split("\n").includes(line)) fs.writeSync(fd, `${current.endsWith("\n") || !current ? "" : "\n"}${line}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return `relay could not add ${line} to ${exclude}: ${(err as Error).message}`;
  }
  return null;
}
const isLink = (p: string) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * A new worktree and branch for a write job, branched from the caller's HEAD. `holder`: the job
 * whose worktree the caller is in (see checkoutOf), from relay's registry.
 */
export function createWorktree(
  callerCwd: string, runId: string, jobId: string, trustFilters = false, holder?: { repo: string | null; worktree: string | null },
): Worktree | { error: string } {
  const from = checkoutOf(callerCwd, holder);
  if (!from) return { error: `${callerCwd} is not inside a git repository, and write jobs need one for their worktree` };
  if ("error" in from) return from;
  const filters = filterRefusal(from.at, trustFilters);
  if (filters) return { error: filters };
  const head = git(from.at, ["rev-parse", "HEAD"]);
  if (!head.ok) return { error: "the repository has no commits yet, so there is nothing to branch a worktree from" };
  // Branch from the caller's HEAD, but manage the worktree from the main one, which outlives jobs.
  const repo = from.repo;
  const common = commonDirOf(repo);
  if (!common) return { error: `git could not find the git directory of ${repo}` };
  // Keep relay's context file out of the agent's commits.
  const excluded = excludeContextDir(common);
  if (excluded) return { error: excluded };

  // `git worktree add` runs in the main worktree (repo), whose per-worktree config
  // (extensions.worktreeConfig, config.worktree) can name a filter the caller's own context does
  // not show; the checkout of the new worktree runs it. Admit that exact context too, not just the
  // caller's, before adding.
  const mainFilters = filterRefusal(repo, trustFilters);
  if (mainFilters) return { error: mainFilters };

  const branch = `relay/${jobId}`;
  const worktree = worktreeDir(runId, jobId);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const add = git(repo, [...PARALLEL_CHECKOUT, "worktree", "add", "-b", branch, worktree, head.out], NO_LFS_FETCH);
  if (!add.ok) return { error: `git worktree add failed: ${add.err}` };
  const tree = jobTree(repo, worktree);
  if ("error" in tree) return { error: `relay could not find the git directory of the worktree it made: ${tree.error}` };

  // The caller's position in its checkout, told to the agent rather than used as its directory. Only
  // a path that leaves the checkout is dropped: a directory merely named "..something" is inside it.
  const rel = path.relative(fs.realpathSync(from.top), fs.realpathSync(callerCwd));
  const outside = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  const subdir = outside ? "" : rel.split(path.sep).join("/");
  return { repo, worktree, subdir, branch, baseSha: head.out, callerDirty: treeState(from.at) !== "clean" };
}

/** The files still in conflict, from the index alone, NUL-separated; null when git cannot say. */
function unmergedFiles(at: GitAt): string[] | null {
  const r = git(at, ["ls-files", "-u", "-z"]);
  if (!r.ok) return null;
  // One entry per stage: "<mode> <object> <stage>\t<name>".
  return [...new Set(names(r).map((e) => e.slice(e.indexOf("\t") + 1)))];
}
const mergeInProgress = (at: GitAt) => git(at, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok;

/**
 * Commits anything uncommitted in the worktree. Refuses while a merge is unfinished, so conflict
 * markers are never committed on the agent's behalf. A failure is reported, not swallowed.
 */
export function checkpoint(at: JobTree, label: string, trustFilters = false): { sha: string | null; error?: string } {
  const filters = filterRefusal(at, trustFilters);
  if (filters) return { sha: null, error: `relay did not commit the work, because ${filters}; the work is still in the worktree` };
  const unmerged = unmergedFiles(at);
  if (unmerged === null) return { sha: null, error: "git could not report whether the worktree has an unfinished merge, so relay did not commit it; any work is still in the worktree" };
  if (mergeInProgress(at) || unmerged.length) {
    return { sha: null, error: "the worktree has an unfinished merge, so relay did not commit it; the work is still in the worktree" };
  }
  const state = treeState(at);
  if (state === "unknown") return { sha: null, error: "git could not report the worktree's state, so relay did not commit it; any work is still in the worktree" };
  if (state === "clean") return { sha: null };
  const nested = untrustedNestedRepos(at);
  if (nested === null) return { sha: null, error: "git could not report what is in the worktree, so relay did not commit it; the work is still in the worktree" };
  if (nested.length) {
    return { sha: null, error: `the worktree contains a nested git repository (${nested.join(", ")}), which relay will not run git in, so relay did not commit the work; it is still in the worktree` };
  }
  const add = git(at, ["add", "-A"]);
  if (!add.ok) return { sha: null, error: `relay could not stage the work (${add.err || add.out}); it is still uncommitted in the worktree` };
  const c = git(at, [...identityArgs(at), "commit", "--no-verify", "-m", `relay: checkpoint ${label}`]);
  if (!c.ok) return { sha: null, error: `relay could not commit the work (${c.err || c.out}); it is still uncommitted in the worktree` };
  return { sha: git(at, ["rev-parse", "HEAD"]).out };
}

const DIFF = ["diff", "--no-ext-diff", "--no-textconv"];

/**
 * Between two commits, so no file in the worktree is read; external diffs and textconv are off all
 * the same. `tip`: the commit the summary is of, read once by the caller, so that the summary and
 * the commit it names cannot differ.
 */
export function diffSummary(at: JobTree, baseSha: string, tip = "HEAD"): { stat: string; files: string[] } {
  // A commit differs from itself in nothing.
  if (tip === baseSha) return { stat: "", files: [] };
  return {
    stat: git(at, [...DIFF, "--stat", `${baseSha}..${tip}`]).out,
    files: names(git(at, [...DIFF, "--name-only", "-z", `${baseSha}..${tip}`])),
  };
}

/** What differs between `commit` and where a job's work is now, for merge to show. */
export interface Changes {
  /** The worktree's HEAD, or the branch's tip when the worktree is gone. */
  now: string;
  /** The worktree has uncommitted changes or untracked files. */
  uncommitted: boolean;
  /** Every file that differs from `commit`, untracked ones included, sorted. */
  files: string[];
  /** `git diff --stat` from `commit` (to the worktree, or to the branch's tip); untracked files are not in it. */
  stat: string;
}

/**
 * What a job's worktree holds that `commit` does not: commits since, uncommitted changes, untracked
 * files. Null when the worktree is at `commit` with nothing else in it. `git status` and a diff
 * against the worktree can run the clean filter, so the caller runs filterRefusal first.
 */
export function worktreeChanges(at: JobTree, commit: string): Changes | null | { error: string } {
  const head = git(at, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (!head.ok) return { error: `git could not read the commit ${at.worktree} is at${head.err ? ` (${head.err})` : ""}` };
  // Untracked files are asked for explicitly, as in treeState.
  const status = git(at, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (!status.ok) return { error: `git could not report the state of ${at.worktree}${status.err ? ` (${status.err})` : ""}` };
  const uncommitted = status.raw.length > 0;
  if (head.out === commit && !uncommitted) return null;
  // From the commit to the files in the worktree, so that committed and uncommitted changes are one list.
  const tracked = git(at, [...DIFF, "--name-only", "-z", commit, "--"]);
  const untracked = git(at, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const stat = git(at, [...DIFF, "--stat", commit, "--"]);
  const failed = [tracked, untracked, stat].find((r) => !r.ok);
  if (failed) return { error: `git could not list what changed in ${at.worktree} since ${commit}${failed.err ? ` (${failed.err})` : ""}` };
  return { now: head.out, uncommitted, files: [...new Set([...names(tracked), ...names(untracked)])].sort(), stat: stat.out };
}

/** What a job's branch holds that `commit` does not, between the two commits, or null when the branch is still at it. */
export function branchChanges(at: GitAt, branch: string, commit: string): Changes | null | { error: string } {
  const tip = git(at, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]);
  if (!tip.ok) return { error: `the branch ${branch} is no longer in the repository` };
  if (tip.out === commit) return null;
  const files = git(at, [...DIFF, "--name-only", "-z", commit, tip.out, "--"]);
  const stat = git(at, [...DIFF, "--stat", commit, tip.out, "--"]);
  const failed = [files, stat].find((r) => !r.ok);
  if (failed) return { error: `git could not list what changed on ${branch} since ${commit}${failed.err ? ` (${failed.err})` : ""}` };
  return { now: tip.out, uncommitted: false, files: names(files).sort(), stat: stat.out };
}

type MergeResult =
  | { status: "merged"; commit: string }
  | { status: "up_to_date" }
  | { status: "conflict"; files: string[]; hint: string }
  | { status: "error"; error: string };

/**
 * Merges a job's branch into `at`. `commit`: merge exactly that commit of the branch (the one the
 * job's result showed), not wherever the branch is by the time git reads it; the merge commit's
 * message still names the branch.
 */
export function mergeBranch(at: GitAt, branch: string, trustFilters = false, commit?: string): MergeResult {
  const filters = filterRefusal(at, trustFilters);
  if (filters) return { status: "error", error: `nothing was merged, because ${filters}. Or merge ${branch} yourself with git` };
  const what = commit ? ["-m", `Merge branch '${branch}' at ${commit}`, commit] : [branch];
  const m = git(at, [...identityArgs(at), "merge", "--no-ff", "--no-edit", "--no-verify", ...what], NO_LFS_FETCH);
  if (m.ok) {
    if (/Already up to date/i.test(m.out)) return { status: "up_to_date" };
    return { status: "merged", commit: git(at, ["rev-parse", "HEAD"]).out };
  }
  const conflicted = unmergedFiles(at);
  if (conflicted?.length) {
    return {
      status: "conflict",
      files: conflicted,
      hint: "Resolve the conflict markers in these files, then call merge again with continue = true.",
    };
  }
  return { status: "error", error: m.err || m.out };
}

export function continueMerge(at: GitAt, trustFilters = false): MergeResult {
  // Staging the resolved files runs the clean filter, and `git status`-like checks can too.
  const filters = filterRefusal(at, trustFilters);
  if (filters) return { status: "error", error: `relay did not finish the merge, because ${filters}. Or finish it yourself with git` };
  if (!mergeInProgress(at)) return { status: "error", error: "no merge is in progress here" };
  const unmerged = unmergedFiles(at);
  if (unmerged === null) return { status: "error", error: "git could not list the files still in conflict, so relay did not finish the merge" };
  // The names as the index holds them, each taken literally: a file named like a pathspec (`*`, `:(glob)…`) is only itself.
  let remaining: string[] = [];
  if (unmerged.length) {
    const g = git(at, ["grep", "-l", "-z", "--no-textconv", "-E", "^(<<<<<<<|>>>>>>>) ", "--", ...unmerged], LITERAL_PATHS);
    // Exit status 1 is grep finding nothing.
    if (!g.ok && !(g.code === 1 && !g.err)) return { status: "error", error: `git could not look for conflict markers (${g.err || `exit ${g.code}`}), so relay did not finish the merge` };
    remaining = names(g);
  }
  if (remaining.length) return { status: "conflict", files: remaining, hint: "These files still contain conflict markers." };
  // Stage only the files that were in conflict; unrelated work in the tree stays out of the merge commit.
  if (unmerged.length) {
    const add = git(at, ["add", "--", ...unmerged], LITERAL_PATHS);
    if (!add.ok) return { status: "error", error: `relay could not stage the resolved files (${add.err || add.out})` };
  }
  const c = git(at, [...identityArgs(at), "commit", "--no-edit", "--no-verify"]);
  if (!c.ok) return { status: "error", error: c.err || c.out };
  return { status: "merged", commit: git(at, ["rev-parse", "HEAD"]).out };
}

/**
 * Removes a job's worktree directory, but only when everything in it is committed. The branch is
 * left alone, so the work stays reachable. Returns why the worktree was kept, or null once it is gone.
 */
export function removeWorktree(repo: string, worktree: string, trustFilters = false): string | null {
  if (fs.existsSync(worktree)) {
    const tree = jobTree(repo, worktree);
    if ("error" in tree) return tree.error;
    if (mergeInProgress(tree)) return "it has an unfinished merge";
    const filters = filterRefusal(tree, trustFilters);
    if (filters) return `relay will not ask git whether it holds uncommitted work, because ${filters}`;
    const state = treeState(tree);
    if (state === "dirty") return "it has uncommitted changes";
    if (state === "unknown") return "git could not report its state";
    // --force only so that ignored files (relay's own context file among them) do not block removal.
    const r = git(repo, ["worktree", "remove", "--force", tree.worktree]);
    if (!r.ok) return `git could not remove it (${r.err})`;
  }
  git(repo, ["worktree", "prune"]);
  return null;
}

/** Puts a removed worktree back from its branch, for a job that is resumed after cleanup. */
export function restoreWorktree(repo: string, worktree: string, branch: string, tipSha: string | null, trustFilters = false): string | null {
  if (fs.existsSync(worktree)) return null;
  const filters = filterRefusal(repo, trustFilters);
  if (filters) return `could not restore the worktree for ${branch}: ${filters}`;
  git(repo, ["worktree", "prune"]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  // The branch is gone if the job changed nothing, or if it was merged and then cleaned up. It is
  // recreated at the job's own last commit, so the resumed job finds its earlier work in place.
  const exists = git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`]).ok;
  if (!exists && tipSha && !git(repo, ["cat-file", "-e", `${tipSha}^{commit}`]).ok) return `could not restore the worktree for ${branch}: its last commit ${tipSha} is no longer in the repository`;
  const add = exists || !tipSha
    ? git(repo, [...PARALLEL_CHECKOUT, "worktree", "add", worktree, branch], NO_LFS_FETCH)
    : git(repo, [...PARALLEL_CHECKOUT, "worktree", "add", "-b", branch, worktree, tipSha], NO_LFS_FETCH);
  return add.ok ? null : `could not restore the worktree for ${branch}: ${add.err}`;
}

/** For git that only looks (a view): no optional locks, so `git status` does not take the index lock to refresh the index and write it. */
const LOOK_ONLY = { GIT_OPTIONAL_LOCKS: "0" };

/**
 * True when a job's worktree is exactly where the job started: the branch has no commits beyond
 * its base and nothing is uncommitted or untracked. Anything git cannot answer counts as changed,
 * and so does a repository whose filters or drivers relay will not run (`git status` can run the
 * clean filter). `lookOnly`, for a view asking again of a worktree that is kept while something
 * the job started may still be running git in it: git takes no optional locks (review C20).
 */
export function unchanged(at: JobTree, baseSha: string, trustFilters = false, lookOnly = false): boolean {
  if (filterRefusal(at, trustFilters)) return false;
  const env = lookOnly ? LOOK_ONLY : {};
  const head = git(at, ["rev-parse", "HEAD"], env);
  if (!head.ok || head.out !== baseSha || treeState(at, env) !== "clean") return false;
  // Asked a second way, since what can follow is deleting someone's new files.
  const others = git(at, ["ls-files", "--others", "--exclude-standard"], env);
  return others.ok && !others.out;
}

/**
 * Removes the worktree and branch of a job with no changes to merge, so an empty branch is not left
 * behind. Every question is asked of git again, however recently the caller asked it: relay does
 * not hold git's inputs to itself between two of its calls (another job's agent can write a config
 * the repository includes; a root's merge can move this job's HEAD), and what follows deletes.
 */
export function discardUnchanged(repo: string, at: JobTree, branch: string, baseSha: string, trustFilters = false): boolean {
  if (!unchanged(at, baseSha, trustFilters)) return false;
  if (removeWorktree(repo, at.worktree, trustFilters) !== null) return false;
  git(repo, ["branch", "-D", branch]);
  return true;
}

/** Deletes a relay branch if its commits are already contained in the repository's current branch. */
export function deleteBranchIfMerged(repo: string, branch: string): "deleted" | "unmerged" | "absent" {
  if (!git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`]).ok) return "absent";
  if (!git(repo, ["merge-base", "--is-ancestor", branch, "HEAD"]).ok) return "unmerged";
  return git(repo, ["branch", "-D", branch]).ok ? "deleted" : "unmerged";
}
