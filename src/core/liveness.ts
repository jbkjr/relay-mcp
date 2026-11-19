// What a running item is doing, for status: when its agent last did anything, how long it has
// been quiet, what it last started, and for a write job the files changed so far. Report-only:
// nothing here stops or limits anything (no timeouts by default; decided 2026-10-15).
import fs from "node:fs";
import path from "node:path";
import { nodeDir } from "./config.js";
import { db, now, runConfig, type NodeRow, type TurnRow } from "./db.js";
import { filterRefusal, git, jobTree } from "./git.js";

/** Files listed at most; the rest are counted. */
const MAX_FILES = 50;

/** Paths changed in a write job's worktree since its base: committed, uncommitted and new. */
function filesTouched(n: NodeRow): string[] | null {
  if (!n.worktree || !n.repo || !n.base_sha || !fs.existsSync(n.worktree)) return null;
  // The agent is running in the worktree and can write its `.git` file: git is given the git
  // directory the repository records for it (jobTree), and nothing is said where that fails.
  const tree = jobTree(n.repo, n.worktree);
  if ("error" in tree) return null;
  // Comparing the worktree with a commit can run the clean filter on files git is unsure of.
  if (filterRefusal(tree, runConfig(n.run_id).trust_git_filters)) return null;
  // --no-optional-locks: relay must not take the index lock while the agent may be running git itself.
  const changed = git(tree, ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", n.base_sha]);
  const created = git(tree, ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"]);
  if (!changed.ok || !created.ok) return null;
  return [...new Set([...changed.raw.split("\0"), ...created.raw.split("\0")].filter(Boolean))].sort();
}

/**
 * Liveness of a running item, or null when it has no turn running. What the agent last started
 * (a command, a tool, a file) is the running turn's own record, which every backend keeps as it
 * goes (session.ts onActivity); it is left out when the backend has recorded nothing yet, and when
 * `activity: false` (a reviewer whose result is withheld).
 */
export function liveness(n: NodeRow, opts: { activity?: boolean } = {}): Record<string, unknown> | null {
  if (n.status !== "running") return null;
  const turn = db().prepare("SELECT * FROM turns WHERE node_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(n.id) as TurnRow | undefined;
  if (!turn?.started_at) return null;
  let last = Math.max(turn.started_at, turn.activity_at ?? 0);
  try {
    // Anything the agent's harness writes counts, not only the tool calls it starts.
    last = Math.max(last, Math.round(fs.statSync(n.log_path ?? path.join(nodeDir(n.run_id, n.id), "agent.log")).mtimeMs));
  } catch {
    // No log yet: the agent is still starting.
  }
  const out: Record<string, unknown> = {
    last_activity_at: new Date(last).toISOString(),
    quiet_s: Math.max(0, Math.round((now() - last) / 1000)),
  };
  if (opts.activity !== false && turn.activity) {
    out.activity = turn.activity;
    if (turn.activity_at) out.activity_at = new Date(turn.activity_at).toISOString();
  }
  if (n.kind === "job" && n.mode === "write" && turn.access === "write") {
    const files = filesTouched(n);
    if (files) {
      out.files_touched = files.slice(0, MAX_FILES);
      if (files.length > MAX_FILES) out.files_touched_more = files.length - MAX_FILES;
    }
  }
  return out;
}
