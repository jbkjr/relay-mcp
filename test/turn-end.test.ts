// How a turn's end reaches whoever waits on it. A turn's own record says it is over as soon as its
// agent has ended; its session records that end after relay's work on it (a job's git half), and
// settles or goes on in the same transaction. A call waiting on the turn returns only once the
// session has done so: never with the reply in hand and the session still running, which would
// make a resume sent at once queue behind a turn that has already ended.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { harness, scratchOnly, sleep, task, until, type Harness } from "./helpers.ts";

/**
 * A git on PATH that runs the real one and, once armed, holds the first read of the tip a job's
 * turn ended at (endJobTurn's `rev-parse --verify HEAD^{commit}`, which only relay's turn end runs)
 * until released. The job's worker is then held after the turn's own record of its end and before
 * the session records it, for as long as the test needs to look.
 */
function gitHoldingTurnEnd(dir: string): { PATH: string; arm: () => void; held: () => boolean; release: () => void } {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  const [arm, held, go] = ["arm", "held", "go"].map((f) => path.join(dir, f));
  fs.writeFileSync(path.join(bin, "git"), [
    "#!/bin/sh",
    // At most a minute, so that a test that fails before releasing it does not hold the worker for ever.
    `case "$*" in *"rev-parse --verify HEAD^{commit}") if [ -e '${arm}' ] && mkdir '${held}' 2>/dev/null; then i=0; while [ ! -e '${go}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done; fi ;; esac`,
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    arm: () => fs.writeFileSync(arm, ""),
    held: () => fs.existsSync(held),
    release: () => fs.writeFileSync(go, ""),
  };
}

const statusOf = (h: Harness, id: string) => h.sql("SELECT status FROM nodes WHERE id = ?", id)[0].status as string;
/** Long enough for a waiting call to have looked at the registry several times (wait.ts looks every 200 ms at the latest). */
const SEVERAL_LOOKS_MS = 1000;

test("turn end: a discussion's reply is taken only once its session has settled with it, so the session can be resumed at once", async () => {
  const dir = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-turnend-"))));
  const hold = gitHoldingTurnEnd(dir);
  const h = await harness([
    { match: task("BUILD"), steps: [{ write: "built.txt" }, { reply: "built" }] },
    { match: "A or B", steps: [{ reply: "A.\nCONTINUE" }] },
    { match: "one more", steps: [{ reply: "more" }] },
  ], {}, { PATH: hold.PATH });
  try {
    const s = await h.instance({ args: ["--host", "codex"] });
    const job = await s.call("delegate", { target: "claude", task: "BUILD", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    hold.arm();
    let returned = false;
    const discussing = s.call("discuss", { with: job.job_id, topic: "A or B?", message: "B.\nCONTINUE" }).then((r) => ((returned = true), r));
    await until(hold.held, 20000, "the job's worker to be held at its turn's end");
    // The window, held open: the reply is in the turn's own record, and the job is still running.
    const turn = h.sql("SELECT status, reply FROM turns WHERE node_id = ? AND source LIKE 'discussion:%'", job.job_id)[0];
    assert.equal(turn.status, "done");
    assert.match(turn.reply, /^A\./);
    assert.equal(statusOf(h, job.job_id), "running");
    // Neither another reader nor the waiting call takes the reply yet.
    const discussionId = h.sql("SELECT id FROM nodes WHERE kind = 'discussion'")[0].id as string;
    const seen = await s.call("status", { id: discussionId });
    assert.equal(seen.reply, undefined, JSON.stringify(seen));
    assert.equal(seen.turns, 1);
    await sleep(SEVERAL_LOOKS_MS);
    assert.equal(returned, false, "discuss returned while the job had not yet recorded its turn's end");

    hold.release();
    const d = await discussing;
    // Read before anything else can change it: the job had settled when the reply came back.
    assert.equal(statusOf(h, job.job_id), "done");
    assert.match(d.reply, /^A\./, JSON.stringify(d));
    // The root session hears of the reply with it, not afterwards in a notice of its own.
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM events WHERE subject = ? AND text LIKE '%has a reply%'", job.job_id)[0].c, 1);
    const resumed = await s.call("resume", { job_id: job.job_id, message: "one more" });
    assert.equal(resumed.status, "queued", JSON.stringify(resumed));
    assert.equal((await s.call("status", { id: job.job_id, wait_s: 30 })).status, "done");
    await s.call("cancel", { id: discussionId });
  } finally {
    hold.release();
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("turn end: a discussion turn that fails before it starts is reported only once its session has settled", async () => {
  const dir = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-turnend-"))));
  const hold = gitHoldingTurnEnd(dir);
  const h = await harness([
    { match: task("BUILD"), steps: [{ write: "built.txt" }, { reply: "built" }] },
    { match: "A or B", steps: [{ reply: "never asked" }] },
    { match: "one more", steps: [{ reply: "more" }] },
  ], {}, { PATH: hold.PATH });
  let locked: string | null = null;
  try {
    const s = await h.instance({ args: ["--host", "codex"] });
    const job = await s.call("delegate", { target: "claude", task: "BUILD", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    // The job's next turn cannot start: relay cannot replace the identity file in its worktree.
    const worktree = h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree as string;
    locked = path.join(worktree, ".relay", "locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "kept"), "");
    fs.chmodSync(locked, 0);
    hold.arm();
    let returned = false;
    const discussing = s.call("discuss", { with: job.job_id, topic: "A or B?", message: "B.\nCONTINUE" }).then((r) => ((returned = true), r));
    await until(hold.held, 20000, "the job's worker to be held at its turn's end");
    // The window, held open: the turn never started, and the job has not yet recorded its end.
    assert.equal(statusOf(h, job.job_id), "queued");
    const discussionId = h.sql("SELECT id FROM nodes WHERE kind = 'discussion'")[0].id as string;
    const seen = await s.call("status", { id: discussionId });
    assert.equal(seen.status, "open", JSON.stringify(seen));
    await sleep(SEVERAL_LOOKS_MS);
    assert.equal(returned, false, "discuss returned while the job had not yet recorded its turn's end");

    hold.release();
    const d = await discussing;
    assert.equal(statusOf(h, job.job_id), "done");
    assert.equal(d.outcome, "error", JSON.stringify(d));
    assert.match(d.error, /identity file/);
    assert.equal(h.starts().length, 1, "the discussion's turn never started an agent");
    fs.chmodSync(locked, 0o700);
    const resumed = await s.call("resume", { job_id: job.job_id, message: "one more" });
    assert.equal(resumed.status, "queued", JSON.stringify(resumed));
    assert.equal((await s.call("status", { id: job.job_id, wait_s: 30 })).status, "done");
  } finally {
    hold.release();
    if (locked && fs.existsSync(locked)) fs.chmodSync(locked, 0o700);
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("turn end: a turn's authority ends as its agent exits, before relay writes the final message to a file", async () => {
  // A long reply, so that writing it takes a measurable time: before the fix the file was written
  // whole while the turn still read as running, and its relay connection could still act for it.
  // A background job, so that the reply is not sent back whole over MCP.
  const reply = "x".repeat(16 * 1024 * 1024);
  const h = await harness([{ match: task("LONG"), steps: [{ reply }] }]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "LONG", mode: "read", background: true });
    assert.ok(job.job_id, JSON.stringify(job));
    await until(() => statusOf(h, job.job_id) === "done", 60000, "the job to finish");
    const node = h.sql("SELECT log_path FROM nodes WHERE id = ?", job.job_id)[0];
    const turn = h.sql("SELECT id, ended_at, length(reply) AS n FROM turns WHERE node_id = ?", job.job_id)[0];
    assert.equal(turn.n, reply.length);
    const final = path.join(path.dirname(node.log_path as string), `final-${turn.id}.md`);
    const st = fs.statSync(final);
    assert.equal(st.size, reply.length);
    // The final file is made (as a temporary beside it, then renamed) only after the turn is recorded as over.
    assert.ok(st.birthtimeMs >= (turn.ended_at as number), `the final message's file was made at ${st.birthtimeMs}, before the turn ended at ${turn.ended_at}`);
  } finally {
    await h.close();
  }
});
