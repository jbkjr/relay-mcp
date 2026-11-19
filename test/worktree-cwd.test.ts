// Regressions for where a write job is launched (always its worktree root, the caller's subdirectory
// said in the prompt: X1+C6, X6) and a context-write failure settling the turn failed (C3). Every file touched is scratch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { harness, task, until, type Harness } from "./helpers.ts";

const worktreeOf = (h: Harness, id: string) => h.sql("SELECT worktree FROM nodes WHERE id = ?", id)[0].worktree as string;

/** Commits `dir/keep.txt` in the harness repository, so the job's worktree has the directory too. */
function commitDir(h: Harness, dir: string): void {
  fs.mkdirSync(path.join(h.repo, dir));
  fs.writeFileSync(path.join(h.repo, dir, "keep.txt"), "k\n");
  execFileSync("git", ["add", "-A"], { cwd: h.repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-q", "-m", `add ${dir}`], { cwd: h.repo, stdio: "pipe" });
}

test("X1+C6: a write job started from a subdirectory runs at its worktree root, told where the person was", async () => {
  const h = await harness([
    { match: task("SUBDIR"), steps: [{ write: "made.txt", content: "x\n" }, { reply: "wrote it" }] },
    { match: "again", steps: [{ write: "again.txt", content: "y\n" }, { reply: "again" }] },
  ]);
  try {
    commitDir(h, "sub");
    const job = await h.call("delegate", { target: "claude", task: "SUBDIR", mode: "write", cwd: path.join(h.repo, "sub"), background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const wt = fs.realpathSync(worktreeOf(h, job.job_id));
    const first = h.starts()[0];
    assert.equal(first.cwd, wt, "the agent's working directory is the worktree root");
    assert.match(first.prompt, /The person was working in sub\/ of this repository/);
    assert.ok(fs.existsSync(path.join(wt, "made.txt")), "its relative writes land at the root");

    // Something left running swaps the subdirectory for a link out of the worktree: the next turn
    // still starts at the root, and nothing goes through the link.
    const outside = path.join(h.home, "outside-sub");
    fs.mkdirSync(outside);
    fs.rmSync(path.join(wt, "sub"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(wt, "sub"));
    await h.call("resume", { job_id: job.job_id, message: "again" });
    const after = await h.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(after.status, "done", JSON.stringify(after));
    assert.equal(h.starts()[1].cwd, wt, "the resumed turn starts at the worktree root too");
    assert.ok(fs.existsSync(path.join(wt, "again.txt")));
    assert.deepEqual(fs.readdirSync(outside), [], "nothing was written through the link");
  } finally {
    await h.close();
  }
});

test("X6: a directory merely named ..something is inside the repository, and the prompt names it", async () => {
  const h = await harness([{ match: task("DOTS"), steps: [{ reply: "seen" }] }]);
  try {
    commitDir(h, "..fixtures");
    const job = await h.call("delegate", { target: "claude", task: "DOTS", mode: "write", cwd: path.join(h.repo, "..fixtures"), background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.match(h.starts()[0].prompt, /The person was working in \.\.fixtures\/ of this repository/);
  } finally {
    await h.close();
  }
});

test("C3: a context-write failure settles the turn and node failed, not left queued", async () => {
  const h = await harness([
    { match: task("CTXFAIL"), steps: [{ write: "made.txt", content: "x\n" }, { reply: "wrote it" }] },
    { match: "again", steps: [{ reply: "again" }] },
  ]);
  let wt: string | undefined;
  try {
    const job = await h.call("delegate", { target: "codex", task: "CTXFAIL", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    wt = worktreeOf(h, job.job_id);
    const before = h.starts().length;
    // The worktree is made unwritable, so relay cannot build its identity directory there.
    fs.chmodSync(wt, 0o500);
    await h.call("resume", { job_id: job.job_id, message: "again" });
    const after = await h.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(after.status, "failed", JSON.stringify(after));
    assert.match(after.error, /could not write this turn's identity file/);
    assert.equal(h.starts().length, before, "no agent was launched");
    // The turn is recorded failed, not left queued.
    const queued = h.sql("SELECT COUNT(*) AS n FROM turns WHERE node_id = ? AND status = 'queued'", job.job_id)[0].n;
    assert.equal(queued, 0, "no turn is left queued");
  } finally {
    if (wt) try { fs.chmodSync(wt, 0o700); } catch { /* best effort */ }
    await h.close();
  }
});

test("X1+C2+C3: a write job recorded with a subdirectory cwd (an earlier relay's) is read as its worktree root everywhere", async () => {
  const h = await harness([
    { match: task("OLDREC"), steps: [{ write: "made.txt", content: "x\n" }, { reply: "first" }] },
    // The resumed turn starts a nested write job, as an agent would from its own worktree.
    { match: "again", steps: [{ call: "delegate", args: { target: "codex", task: "INNER", mode: "write", background: false }, as: "inner" }, { write: "again.txt", content: "y\n" }, { reply: "{{inner.job_id}}" }] },
    { match: task("INNER"), steps: [{ write: "inner.txt", content: "z\n" }, { reply: "inner done" }] },
  ]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "OLDREC", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const wt = fs.realpathSync(worktreeOf(h, job.job_id));
    // A second repository, outside the worktree, behind a link where the old record's subdirectory is.
    const other = path.join(h.home, "other-repo");
    fs.mkdirSync(other);
    const g = (...a: string[]) => execFileSync("git", a, { cwd: other, encoding: "utf8", stdio: "pipe" }).trim();
    g("init", "-q", "-b", "main");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "other");
    fs.symlinkSync(other, path.join(wt, "sub"));
    // What a relay before the root launch recorded for a job started from sub/.
    h.sql("UPDATE nodes SET cwd = ? WHERE id = ?", path.join(wt, "sub"), job.job_id);

    // Native resume, read before any further turn, names the root.
    const view = await h.call("status", { id: job.job_id });
    assert.match(view.resume_natively.command, new RegExp(`^cd '${wt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' &&`), view.resume_natively.command);

    await h.call("resume", { job_id: job.job_id, message: "again" });
    const after = await h.call("status", { id: job.job_id, wait_s: 30 });
    assert.equal(after.status, "done", JSON.stringify(after));
    assert.equal(h.starts()[1].cwd, wt, "the resumed turn starts at the worktree root");
    // The nested write job branched from the job's own repository, never the one behind the link.
    const inner = h.sql("SELECT repo, worktree, cwd FROM nodes WHERE parent_id = ?", job.job_id)[0];
    assert.ok(inner, "the nested job was started");
    assert.equal(fs.realpathSync(inner.repo), fs.realpathSync(h.repo));
    assert.equal(inner.cwd, inner.worktree, "and it too starts at its worktree root");
    assert.match(h.starts().find((s) => s.target === "codex")!.prompt, /The person was working in sub\/ of this repository/, "it inherits where the person was");
    // Nothing happened behind the link: no new worktree, branch or file in the other repository.
    assert.equal(g("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
    assert.equal(g("branch", "--format=%(refname:short)"), "main");
    assert.deepEqual(fs.readdirSync(other).filter((n) => n !== ".git"), []);
    // The record itself is now the root, with the subdirectory kept.
    const row = h.sql("SELECT cwd, params_json FROM nodes WHERE id = ?", job.job_id)[0];
    assert.equal(row.cwd, worktreeOf(h, job.job_id));
    assert.equal(JSON.parse(row.params_json).subdir, "sub");
  } finally {
    await h.close();
  }
});

test("C11: re-pinning a restored worktree sets only its pin, keeping a grant written meanwhile by another process", async () => {
  const h = await harness([
    { match: task("FIRST"), steps: [{ write: "one.txt" }, { reply: "first" }] },
    { match: "SECOND", steps: [{ reply: "second" }] },
  ]);
  try {
    const job = await h.call("delegate", { target: "codex", task: "FIRST", mode: "write", background: false });
    assert.equal(job.status, "done");
    const before = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json);
    assert.equal((await h.call("merge", { job_id: job.job_id })).worktree_removed, true);
    // Another process writes the job's grant while the next turn is being set up: after the worker has
    // read the job's row, before it restores and re-pins the worktree.
    // Retried: the registry can be busy a moment (the merge's worker winding down), and the test's own connection does not wait.
    await until(() => {
      h.sql(`CREATE TRIGGER IF NOT EXISTS grant_meanwhile AFTER UPDATE OF prompt_path ON turns WHEN NEW.body LIKE '%SECOND%' BEGIN
        UPDATE nodes SET params_json = json_set(params_json, '$.grant', json('{"network":true}')) WHERE id = NEW.node_id; END`);
      return true;
    }, undefined, "the trigger to be created");
    await h.call("resume", { job_id: job.job_id, message: "SECOND" });
    assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
    const after = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json);
    assert.deepEqual(after.grant, { network: true }, "the grant written meanwhile is kept");
    assert.notDeepEqual(after.worktree_pin, before.worktree_pin, "and the restored worktree is pinned anew");
    assert.equal(after.worktree_pin.path, before.worktree_pin.path);
  } finally {
    await h.close();
  }
});
