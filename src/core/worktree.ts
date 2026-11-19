// A job worktree's life, above git.ts's safe git commands: made for a write job (and dropped again
// if the job is never recorded), put back and checked before each turn, committed and looked at
// when a turn ends, and retired after a merge or by relay clean. Relay runs git unsandboxed in trees
// an agent wrote, so its rules are here in one place: a worktree's `.git` file is never trusted (git
// runs with the git directory the repository records, jobTree), the worktree is pinned by identity,
// relay's identity file is written by relay, and filters are refused unless trusted.
import fs from "node:fs";
import path from "node:path";
import type { Grant } from "../backends/types.js";
import type { Json } from "./caller.js";
import { CONTEXT_DIR, writeWorktreeContext } from "./context.js";
import type { Mode, RelayConfig } from "./config.js";
import { busy, descendants, nextQueuedTurn, runConfig, setParam, updateNode, workCwd, worktreeHolder, type NodeRow, type TurnRow } from "./db.js";
import {
  checkoutOf, checkpoint, createWorktree, diffSummary, discardUnchanged, git, jobTree, removeWorktree, restoreWorktree, unchanged,
  type Checkout, type JobTree, type Worktree,
} from "./git.js";
import { hardLinksOutside } from "../confine/hardlinks.js";
import { HARNESS_CONFIG } from "../confine/harness-config.js";
import { dirIdentity } from "../confine/index.js";
import { targetDef } from "../targets/index.js";

/**
 * Makes a new write job's worktree and branch, from where the caller is: a caller inside a job's
 * worktree (a launched agent in its own) branches from that worktree, found through relay's
 * registry and the repository's records, not through its `.git` file. Returns why not, worded for
 * the caller, when relay will not.
 */
export function openJobWorktree(callerCwd: string, runId: string, jobId: string, trustFilters: boolean): Worktree | { refusal: string } {
  const holder = worktreeHolder(callerCwd);
  if (holder === "unknown") return { refusal: `${callerCwd} is inside relay's worktree directory but in no job's worktree relay knows of, so relay will not run git there. Do this part yourself, or delegate it in read mode.` };
  const wt = createWorktree(callerCwd, runId, jobId, trustFilters, holder ?? undefined);
  if ("error" in wt) return { refusal: `${wt.error}. Do this part yourself, or delegate it in read mode.` };
  return wt;
}

/**
 * A worktree and branch made for a job that was then never recorded belong to nothing: they are
 * removed where git can do so cleanly (nothing has been written in them but relay's identity file).
 */
export function discardJobWorktree(wt: Worktree, trustFilters: boolean): void {
  try {
    if (!removeWorktree(wt.repo, wt.worktree, trustFilters)) git(wt.repo, ["branch", "-D", wt.branch]);
  } catch {
    // Left as they are; relay clean lists them.
  }
}

/**
 * Puts a job's worktree back before a turn, if it was removed after its branch was merged (or by
 * clean), re-pins it if it was made again, and writes the turn's identity file. Returns why the turn
 * must not start, or null. A session without a worktree of its own has nothing to prepare.
 */
export function prepareTurnTree(node: NodeRow, cfg: RelayConfig): string | null {
  if (!node.worktree || !node.repo || !node.branch) return null;
  const absent = !fs.lstatSync(node.worktree, { throwIfNoEntry: false });
  const problem = restoreWorktree(node.repo, node.worktree, node.branch, node.head_sha ?? node.base_sha, cfg.trust_git_filters);
  if (problem) return problem;
  // Made again here, so pinned again: the directory a relay-enforced turn checks it still is.
  // Only the pin is set: a grant written meanwhile (restoring can take a while) is kept (review C11).
  if (absent) setParam(node.id, "worktree_pin", dirIdentity(node.worktree));
  // The identity file. A write that cannot be made safely settles the turn failed rather than throwing.
  try {
    writeWorktreeContext(node.worktree, { run_id: node.run_id, node_id: node.id, depth: node.depth });
  } catch (err) {
    return `relay could not write this turn's identity file in ${node.worktree}: ${(err as Error).message}`;
  }
  return null;
}

/** The job worktree a node's turns run in, found as jobTree finds it: its own, or the one it works in place in. */
export function turnTree(node: NodeRow): JobTree | { error: string } | undefined {
  const holder = node.worktree ? node : worktreeHolder(workCwd(node));
  if (holder === null) return undefined;
  if (holder === "unknown") return { error: `its working directory ${node.cwd} is inside relay's worktree directory but in no job's worktree relay knows of, so relay will not start it there` };
  if (!holder.repo || !holder.worktree) return { error: `relay did not record the repository of the worktree ${node.cwd} is in` };
  return jobTree(holder.repo, holder.worktree);
}

/**
 * Why a write turn of a target with verified confinement (Claude's, Codex's own sandbox) must not
 * start, or null: a file in the job's worktree or a granted write path that is a hard link to a file
 * outside them. The sandbox decides by path, so a write to such a file goes through to the other
 * name. Names in each root's `.git` and in the worktree's `.relay` count as outside: the sandboxes
 * keep the agent from writing there (Claude's denies both in the worktree, Codex's a writable
 * root's `.git`), and a second name elsewhere would let it. Relay-enforced launches make the same
 * check in confine/index.ts (prepareLaunch), against the paths their profile hard-denies. `grant`
 * is the turn's (session.ts grantFor): its write paths are roots too. `confinement`: the turn's own
 * (backends/codex-stage2.ts turnConfinement): a stage-2 Codex turn of a verified target is
 * relay-enforced, and its executor's launch makes the check.
 */
export function hardLinkProblem(node: NodeRow, access: Mode, dangerous: boolean, tree: JobTree | null, grant: Grant | undefined, confinement: "verified" | "relay-enforced" = "verified"): string | null {
  if (access !== "write" || dangerous || confinement !== "verified" || targetDef(node.target!).capabilities.confinement !== "verified") return null;
  const worktree = path.resolve(tree?.worktree ?? workCwd(node));
  const roots = [worktree, ...(grant?.write_paths ?? []).map((p) => path.resolve(p))];
  const denied = [...roots.flatMap((root) => [path.join(root, ".git"), ...HARNESS_CONFIG.map(name => path.join(root, name))]), path.join(worktree, CONTEXT_DIR)];
  let linked: string[];
  try {
    linked = hardLinksOutside(roots, { denied }).linked;
  } catch (err) {
    return `relay could not check the worktree for hard links (${(err as Error).message}), so it did not start the turn`;
  }
  if (!linked.length) return null;
  return `relay will not launch a write turn here: ${linked[0]} is a hard link to a file outside the job's worktree${roots.length > 1 ? " and granted write paths" : ""}, and the sandbox, which decides by path, would let writes through to it. Replace it with a copy (pnpm: use a copying package-import method) and try again.`;
}

/**
 * The git half of a job's result when a turn ends: relay commits what a write turn left (Codex's
 * sandbox does not let the agent write .git), records the branch's tip, and summarises the change
 * from the base up to that tip, which the result names (`commit`: what merge takes). A turn that
 * finished with the branch still at its base, nothing uncommitted or untracked, has no changes to
 * merge (no_changes; files git ignores are not looked at), whether or not the worktree can then be
 * dropped. Returns the fields for the result, in the order it has them, or nothing for a job
 * without a worktree.
 */
export function endJobTurn(node: NodeRow, turn: Pick<TurnRow, "access" | "source">, o: { status: string; warnings: string[] }, cfg: RelayConfig): Json {
  // Every git command for the worktree runs with the git directory the repository records for it:
  // the agent has just had the run of the worktree, `.git` file included.
  const tree = node.worktree && node.base_sha ? (node.repo ? jobTree(node.repo, node.worktree) : { error: "relay did not record the job's repository" }) : null;
  if (!tree) return {};
  if ("error" in tree) {
    return { branch: node.branch, base_sha: node.base_sha, checkpoint_error: `relay did not commit or look at the work, because ${tree.error}. The work is still in the worktree` };
  }
  let out: Json = {};
  // Each step below asks git for itself rather than going by what an earlier one found: with this
  // job's agent gone, other writers can still change what git reads between two of relay's calls (an
  // included config another job may write, a root's merge into this worktree).
  const cp = turn.access === "write" ? checkpoint(tree, node.id, cfg.trust_git_filters) : { sha: null };
  if (cp.error) out = { ...out, checkpoint_error: cp.error };
  // The commit the diff summary is of, read once and named in the result (`commit`): merge takes
  // exactly this commit, and nothing while the worktree or branch holds more, since a process the
  // agent started can outlive the turn and go on writing to the worktree (ops.ts merge).
  const tip = git(tree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!tip.ok) {
    // Without the commit there is no summary to show, and nothing to say the turn changed nothing.
    return {
      ...out, branch: node.branch, base_sha: node.base_sha, commit: null,
      checkpoint_error: cp.error ?? `relay could not read the commit the worktree is at (${tip.err || `exit ${tip.code}`}), so it could not show the work. The work is still in the worktree`,
    };
  }
  updateNode(node.id, { head_sha: tip.out });
  const diff = diffSummary(tree, node.base_sha!, tip.out);
  out = { ...out, branch: node.branch, base_sha: node.base_sha, commit: tip.out, files_changed_git: diff.files, diff_stat: diff.stat };
  if (!cp.error && o.status === "ok" && !diff.files.length && unchanged(tree, node.base_sha!, cfg.trust_git_filters)) {
    out = { ...out, no_changes: true };
    // Nothing more is queued: drop the worktree and the empty branch. Both come back if the job is
    // resumed. Not while agents this job started are still running (read jobs and consults work
    // inside its worktree), nor while something the agent started may be (the turn's process
    // warnings). Nor after a discussion turn (review C9): its result is not the job's, which keeps
    // naming the worktree and branch its own turn kept (review X3: these gates are the worker's).
    const discussionTurn = turn.source.startsWith("discussion:");
    const inUse = descendants(node.id).some((d) => busy(d));
    if (!discussionTurn && !inUse && !o.warnings.length && !nextQueuedTurn(node.id) && node.repo && node.branch && discardUnchanged(node.repo, tree, node.branch, node.base_sha!, cfg.trust_git_filters)) {
      out = { ...out, branch: null };
    }
  }
  return out;
}

/**
 * Whether a settled job's kept worktree is still as its turn left it, unchanged: true, or what
 * says otherwise (a change, or why relay cannot look). A worktree that is not there any more has
 * nothing to say against it. Asked through the git directory the repository records for the
 * worktree, never its `.git` file (jobTree); a worktree relay will not run git in cannot be vouched for.
 */
export function stillUnchanged(n: NodeRow): true | { changed: true } | { error: string } {
  if (!n.worktree || !fs.existsSync(n.worktree)) return true;
  const tree = nodeTree(n);
  if ("error" in tree) return tree;
  return unchanged(tree, n.base_sha!, runConfig(n.run_id).trust_git_filters, true) ? true : { changed: true };
}

/** A job's worktree as relay runs git in it (jobTree), or why it cannot. */
export const nodeTree = (n: NodeRow): JobTree | { error: string } => (n.repo ? jobTree(n.repo, n.worktree!) : { error: `relay did not record ${n.id}'s repository` });

/**
 * Where relay runs git for work in `dir`: inside a job's worktree, that worktree with the git
 * directory the repository records for it (never what its `.git` file says); elsewhere, the
 * checkout `dir` is in. Null when `dir` is in no git repository.
 */
export function checkoutAt(dir: string): Checkout | { error: string } | null {
  const holder = worktreeHolder(dir);
  if (holder === "unknown") return { error: `${dir} is inside relay's worktree directory but in no job's worktree relay knows of, so relay will not run git there` };
  return checkoutOf(dir, holder ?? undefined);
}

/**
 * Records where a job's branch stands, before its worktree or branch is removed. Relay can commit
 * in a job's worktree after the job's own turn (before a merge, during clean), so the tip is read
 * at the moment it matters, not only when a turn ends.
 */
function saveTip(n: NodeRow): void {
  if (!n.worktree || !n.repo || !fs.existsSync(n.worktree)) return;
  const tree = jobTree(n.repo, n.worktree);
  // A worktree relay will not run git in is not removed either, so the tip recorded last stands.
  if ("error" in tree) return;
  const tip = git(tree, ["rev-parse", "HEAD"]);
  if (tip.ok) updateNode(n.id, { head_sha: tip.out });
}

/**
 * Retires a job's worktree: records where its branch stands (saveTip), then removes it. Returns why
 * git kept it, or null once it is gone. The branch stays; resuming the job puts the worktree back.
 */
export function retire(n: NodeRow, trustFilters: boolean): string | null {
  saveTip(n);
  return removeWorktree(n.repo!, n.worktree!, trustFilters);
}
