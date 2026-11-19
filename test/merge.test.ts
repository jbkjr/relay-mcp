// What merge takes is what the job's result showed: the commit its diff summary is of (the result's
// `commit`). A process a job started can outlive its turn and go on writing to the worktree, so merge
// takes nothing while the worktree, or once that is gone the branch, holds more, unless the root
// session passes include_changes_since_result. Every repository these tests touch is scratch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { harness, task, until, type Harness, type Rec, type Rule } from "./helpers.ts";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const WRITE: Rule = { match: task("WRITE"), steps: [{ write: "feature.txt", content: "v1\n" }, { reply: "done" }] };

/** A write job that has finished its turn: its worktree, and the commit its result showed. */
async function finished(h: Harness, name = "WRITE") {
  const job = await h.call("delegate", { target: "codex", task: name, mode: "write", background: false });
  assert.equal(job.status, "done", JSON.stringify(job));
  const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree as string;
  return { job, wt, shown: job.result.commit as string };
}

test("merge: a change in a job's worktree after its turn, as a process it left running could make, is not merged, and the refusal lists it", async () => {
  const h = await harness([WRITE]);
  try {
    const { job, wt, shown } = await finished(h);
    assert.match(shown, /^[0-9a-f]{40}$/, "the result names the commit its diff summary is of");
    assert.equal(gitIn(wt, "rev-parse", "HEAD"), shown);
    const before = gitIn(h.repo, "rev-parse", "HEAD");

    // After the turn: a new file, and a change to one the result showed.
    fs.writeFileSync(path.join(wt, "late.txt"), "written after the turn\n");
    fs.writeFileSync(path.join(wt, "feature.txt"), "v1, changed after the turn\n");
    const m = await h.call("merge", { job_id: job.job_id });
    assert.equal(m.refused, true, JSON.stringify(m));
    assert.ok(m.reason.startsWith(
      `Refused: nothing was merged, because ${job.job_id}'s worktree has changed since the end of the turn its result is from: ` +
      `that result's diff summary is of commit ${shown}, and the worktree has uncommitted changes. ` +
      "A process the job started may still be running there, or a later turn of the job may have been stopped before it ended. " +
      `Changed since that commit: feature.txt, late.txt. Look at them in ${wt}; `), m.reason);
    assert.match(m.reason, /resume the job, whose next turn commits them and ends with a result that shows them; or, if the user wants them merged as they are, call merge again with include_changes_since_result: true/);
    assert.deepEqual(m.changed_files, ["feature.txt", "late.txt"]);
    assert.match(m.diff_stat, /feature\.txt/);
    assert.equal(m.result_commit, shown);
    assert.equal(m.uncommitted, true);

    // Nothing was merged, and nothing committed: not in the caller's checkout, not on the job's branch.
    assert.equal(gitIn(h.repo, "rev-parse", "HEAD"), before);
    assert.ok(!fs.existsSync(path.join(h.repo, "feature.txt")));
    assert.equal(gitIn(h.repo, "rev-parse", job.branch), shown, "no checkpoint commit on the job's branch");
    assert.match(gitIn(wt, "status", "--porcelain"), /\?\? late\.txt/, "the change is still uncommitted in the worktree");

    // Committed there after the turn, it is refused the same way.
    gitIn(wt, "add", "-A");
    gitIn(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "after the turn");
    const again = await h.call("merge", { job_id: job.job_id });
    assert.equal(again.refused, true, JSON.stringify(again));
    assert.match(again.reason, new RegExp(`and the worktree is now at commit ${gitIn(wt, "rev-parse", "HEAD")}\\. A process`));
    assert.equal(again.uncommitted, false);
    assert.deepEqual(again.changed_files, ["feature.txt", "late.txt"]);
    assert.equal(gitIn(h.repo, "rev-parse", "HEAD"), before);
  } finally {
    await h.close();
  }
});

test("merge: include_changes_since_result commits what is in the worktree and merges the branch as it then is", async () => {
  const h = await harness([WRITE]);
  try {
    const { job, wt, shown } = await finished(h);
    fs.writeFileSync(path.join(wt, "late.txt"), "written after the turn\n");
    assert.equal((await h.call("merge", { job_id: job.job_id })).refused, true);
    const m = await h.call("merge", { job_id: job.job_id, include_changes_since_result: true });
    assert.equal(m.status, "merged", JSON.stringify(m));
    assert.match(m.note, new RegExp(`^With include_changes_since_result, relay committed anything left in ${job.job_id}'s worktree to ${job.branch}`));
    assert.equal(fs.readFileSync(path.join(h.repo, "late.txt"), "utf8"), "written after the turn\n");
    assert.equal(fs.readFileSync(path.join(h.repo, "feature.txt"), "utf8"), "v1\n");
    // Committed to the job's branch first, on top of the commit the result showed.
    assert.equal(gitIn(h.repo, "rev-parse", `${job.branch}~1`), shown);
    assert.match(gitIn(h.repo, "log", "-1", "--format=%s", job.branch), /^relay: checkpoint /);
  } finally {
    await h.close();
  }
});

test("merge: with nothing changed since the result, merge takes exactly the commit it showed and commits nothing, worktree or no worktree", async () => {
  const h = await harness([WRITE, { match: task("OTHER"), steps: [{ write: "other.txt", content: "other\n" }, { reply: "done" }] }]);
  try {
    const { job, shown } = await finished(h);
    const m = await h.call("merge", { job_id: job.job_id });
    assert.equal(m.status, "merged", JSON.stringify(m));
    assert.equal(m.note, undefined);
    assert.equal(gitIn(h.repo, "rev-parse", "HEAD^2"), shown, "the merge's second parent is the commit the result showed");
    assert.equal(gitIn(h.repo, "rev-parse", job.branch), shown, "no checkpoint commit was made on the branch");
    assert.equal(gitIn(h.repo, "log", "-1", "--format=%s"), `Merge branch '${job.branch}' at ${shown}`);
    assert.equal(m.worktree_removed, true);

    // Its worktree removed by relay clean, which found nothing to commit there: the branch is still at the commit, and that is merged.
    const other = await finished(h, "OTHER");
    assert.equal(JSON.parse(h.cli("clean")).worktrees_removed, 1);
    assert.ok(!fs.existsSync(other.wt));
    const o = await h.call("merge", { job_id: other.job.job_id });
    assert.equal(o.status, "merged", JSON.stringify(o));
    assert.equal(gitIn(h.repo, "rev-parse", "HEAD^2"), other.shown);
  } finally {
    await h.close();
  }
});

test("merge: a job's branch that moved after its result, with its worktree gone, is not merged", async () => {
  const h = await harness([WRITE]);
  try {
    const { job, wt, shown } = await finished(h);
    fs.writeFileSync(path.join(wt, "late.txt"), "written after the turn\n");
    // relay clean commits what it finds in a finished job's worktree to its branch, then removes the worktree.
    assert.equal(JSON.parse(h.cli("clean")).worktrees_removed, 1);
    assert.ok(!fs.existsSync(wt));
    const tip = gitIn(h.repo, "rev-parse", job.branch);
    assert.notEqual(tip, shown);
    const before = gitIn(h.repo, "rev-parse", "HEAD");

    const m = await h.call("merge", { job_id: job.job_id });
    assert.equal(m.refused, true, JSON.stringify(m));
    assert.ok(m.reason.startsWith(
      `Refused: nothing was merged, because ${job.job_id}'s branch ${job.branch} has moved since the end of the turn its result is from: ` +
      `that result's diff summary is of commit ${shown}, and the branch is now at ${tip}. ` +
      "Something was committed to it after that turn: relay clean commits what it finds in a worktree before removing it, which may be the work of a process the job started. " +
      `Changed since that commit: late.txt. Look at them with git diff ${shown} ${tip}; `), m.reason);
    assert.match(m.reason, new RegExp(`call merge again with include_changes_since_result: true, which merges ${job.branch} as it is\\.$`));
    assert.deepEqual(m.changed_files, ["late.txt"]);
    assert.equal(m.now_at, tip);
    assert.equal(gitIn(h.repo, "rev-parse", "HEAD"), before, "nothing was merged");
    assert.equal(gitIn(h.repo, "rev-parse", job.branch), tip);

    const ok = await h.call("merge", { job_id: job.job_id, include_changes_since_result: true });
    assert.equal(ok.status, "merged", JSON.stringify(ok));
    assert.equal(gitIn(h.repo, "rev-parse", "HEAD^2"), tip);
  } finally {
    await h.close();
  }
});

test("merge: a result written before 0.9.1, which names no commit, is merged as before, with a note saying so", async () => {
  const h = await harness([WRITE]);
  try {
    const { job, wt } = await finished(h);
    // As 0.9.0 wrote it.
    const res = JSON.parse(h.sql("SELECT result_json FROM nodes WHERE id = ?", job.job_id)[0].result_json);
    delete res.commit;
    h.sql("UPDATE nodes SET result_json = ? WHERE id = ?", JSON.stringify(res), job.job_id);
    fs.writeFileSync(path.join(wt, "late.txt"), "written after the turn\n");
    const m = await h.call("merge", { job_id: job.job_id });
    assert.equal(m.status, "merged", JSON.stringify(m));
    assert.equal(m.note,
      `${job.job_id}'s result was written by a relay older than 0.9.1, which did not record the commit a result's diff summary is of, so relay could not check that the branch holds only what the result showed. ` +
      `As before, it committed anything left in ${job.job_id}'s worktree to ${job.branch} and took the branch as it then was.`);
    assert.equal(fs.readFileSync(path.join(h.repo, "late.txt"), "utf8"), "written after the turn\n", "what was left in the worktree was committed and merged, as before");
  } finally {
    await h.close();
  }
});

test("merge: work relay could not commit when the turn ended, so that no result showed it, is not merged unseen", async () => {
  // The agent leaves a nested repository, which relay will not run git in, so the turn's commit fails.
  const h = await harness([{ match: task("NESTED"), steps: [{ write: "work.txt", content: "w\n" }, { run: "git init -q nested" }, { reply: "done" }] }]);
  try {
    const job = await h.call("delegate", { target: "codex", task: "NESTED", mode: "write", background: false });
    assert.match(job.result.checkpoint_error, /nested git repository \(nested\)/, JSON.stringify(job));
    const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree as string;
    // Gone by the time of the merge, so committing the work then would succeed.
    fs.rmSync(path.join(wt, "nested"), { recursive: true, force: true });
    const before = gitIn(h.repo, "rev-parse", "HEAD");

    const m = await h.call("merge", { job_id: job.job_id });
    assert.equal(m.refused, true, JSON.stringify(m));
    assert.equal(m.reason,
      `Refused: nothing was merged, because relay could not commit ${job.job_id}'s work when the turn its result is from ended (${job.result.checkpoint_error}), ` +
      "so that result's diff summary does not show the work, and merging now would commit it and merge it unseen. " +
      `Look at it in ${wt}; resume the job, whose next turn commits it and ends with a result that shows it; ` +
      `or, if the user wants it merged as it is, call merge again with include_changes_since_result: true, which commits what is in the worktree to ${job.branch} and merges the branch as it then is.`);
    assert.equal(gitIn(h.repo, "rev-parse", "HEAD"), before, "nothing was merged");
    assert.equal(gitIn(h.repo, "rev-parse", job.branch), job.base_sha, "nothing was committed on the job's branch");

    const ok = await h.call("merge", { job_id: job.job_id, include_changes_since_result: true });
    assert.equal(ok.status, "merged", JSON.stringify(ok));
    assert.equal(fs.readFileSync(path.join(h.repo, "work.txt"), "utf8"), "w\n");
  } finally {
    await h.close();
  }
});

test("merge: a launched agent cannot pass include_changes_since_result, and merges a job of its own as the root does", async () => {
  const h = await harness([
    { match: task("OUTER"), steps: [
      { call: "delegate", args: { target: "codex", task: "INNER", mode: "write", background: false }, as: "inner" },
      { call: "merge", args: { job_id: "{{inner.job_id}}", include_changes_since_result: true } },
      { call: "merge", args: { job_id: "{{inner.job_id}}" } },
      { call: "delegate", args: { target: "codex", task: "UNSHOWN", mode: "write", background: false }, as: "unshown" },
      { call: "merge", args: { job_id: "{{unshown.job_id}}" } },
      { reply: "done" },
    ] },
    { match: task("INNER"), steps: [{ write: "inner.txt", content: "inner\n" }, { reply: "done" }] },
    // A nested repository, so that relay cannot commit this job's work when its turn ends.
    { match: task("UNSHOWN"), steps: [{ write: "unshown.txt", content: "u\n" }, { run: "git init -q nested" }, { reply: "done" }] },
  ]);
  try {
    const outer = await h.call("delegate", { target: "claude", task: "OUTER", mode: "write", background: false });
    assert.equal(outer.status, "done", JSON.stringify(outer));
    const calls = h.ends().find((e: Rec) => e.target === "claude")!.calls;
    const inner = calls[0].result;
    assert.equal(calls[1].result.refused, true, JSON.stringify(calls[1].result));
    assert.match(calls[1].result.reason, /^Refused: include_changes_since_result can only be set by the root session\. Resume the job/);
    assert.equal(calls[2].result.status, "merged", JSON.stringify(calls[2].result));
    const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", outer.job_id)[0].worktree as string;
    assert.equal(gitIn(wt, "rev-parse", "HEAD^2"), inner.result.commit, "the inner job's result commit was merged into the outer job's worktree");
    // Work no result showed is refused to it as to the root, with what it can do instead.
    assert.match(calls[3].result.result.checkpoint_error, /nested git repository/);
    assert.equal(calls[4].result.refused, true, JSON.stringify(calls[4].result));
    assert.match(calls[4].result.reason, /; or report this to whoever started you: only the root session can merge it as it is\.$/);
    assert.doesNotMatch(calls[4].result.reason, /include_changes_since_result/);
  } finally {
    await h.close();
  }
});

test("merge: what merge takes follows the job's own turns (resume), not a discussion's turn on its session", async () => {
  const h = await harness([
    WRITE,
    // A discussion's turn is read-only; this stub writes all the same, as something left running could.
    { match: "ship\\?", steps: [{ write: "during.txt", content: "written during the discussion\n" }, { reply: "AGREE: ship it" }] },
    { match: "make it v2", steps: [{ write: "feature.txt", content: "v2\n" }, { reply: "updated" }] },
  ]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const job = await claude.call("delegate", { task: "WRITE", mode: "write", background: false });
    const first = job.result.commit as string;
    assert.match(first, /^[0-9a-f]{40}$/);
    const d = await claude.call("discuss", { topic: "ship?", message: "Ship it?\nAGREE: ship it", with: job.job_id });
    assert.equal(d.outcome, "agree", JSON.stringify(d));
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "done", 60000, "the discussion's turn on the job to end");

    // The discussion's turn is the discussion's: the job's result, and so what merge takes, are as they were.
    assert.equal((await claude.call("result", { job_id: job.job_id })).result.commit, first);
    const m = await claude.call("merge", { job_id: job.job_id });
    assert.equal(m.refused, true, JSON.stringify(m));
    assert.equal(m.result_commit, first);
    assert.deepEqual(m.changed_files, ["during.txt"]);

    // A turn of the job's own ends with a new result, and that is what merge takes.
    assert.equal((await claude.call("resume", { job_id: job.job_id, message: "make it v2" })).status, "queued");
    const second = (await claude.call("status", { id: job.job_id, wait_s: 30 })).result;
    assert.notEqual(second.commit, first);
    assert.deepEqual(second.files_changed_git.sort(), ["during.txt", "feature.txt"]);
    const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree as string;
    assert.equal(second.commit, gitIn(wt, "rev-parse", "HEAD"));
    const ok = await claude.call("merge", { job_id: job.job_id });
    assert.equal(ok.status, "merged", JSON.stringify(ok));
    assert.equal(gitIn(h.repo, "rev-parse", "HEAD^2"), second.commit);
    assert.equal(fs.readFileSync(path.join(h.repo, "feature.txt"), "utf8"), "v2\n");
  } finally {
    await h.close();
  }
});
