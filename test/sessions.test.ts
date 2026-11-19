import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { adoptRun, alive, forEachTarget, harness, task, until } from "./helpers.ts";

forEachTarget((target) => {
  test(`a ${target} session whose first launch failed receives its original prompt on retry`, async () => {
    const h = await harness();
    try {
      const bad = await h.instance({ env: { STUB_VERSION: "0.0.1" } });
      const job = await bad.call("delegate", { target, task: "original assignment", mode: "read", scope: ["README.md"], background: false });
      assert.equal(job.status, "failed");
      assert.equal((await bad.call("status", { id: job.job_id })).session.scope, "dedicated-process", "failed work still has a session diagnostic");
      assert.equal(h.sql("SELECT session_id FROM nodes WHERE id = ?", job.job_id)[0].session_id, null);
      const firstPrompt = h.sql("SELECT body FROM turns WHERE node_id = ?", job.job_id)[0].body;
      const consult = await bad.call("ask", { target, message: "original question", context: ["README.md"] });
      assert.match(consult.error, /older than/);
      assert.equal(h.starts().length, 0);
      await bad.close();

      await adoptRun(h, h, job.job_id);
      await h.call("resume", { job_id: job.job_id, message: "retry with this detail" });
      assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
      assert.equal(h.starts()[0].prompt, `${firstPrompt}\n\n[relay] Follow-up message:\n\nretry with this detail`);
      assert.equal(h.starts()[0].resumed, false);

      await adoptRun(h, h, consult.thread_id);
      const retry = await h.call("ask", { thread_id: consult.thread_id, message: "question follow-up" });
      assert.match(retry.reply, /turn 1/);
      assert.match(h.starts()[1].prompt, /is consulting you/);
      assert.match(h.starts()[1].prompt, /README\.md/);
      assert.match(h.starts()[1].prompt, /original question\n\n\[relay\] Follow-up message:\n\nquestion follow-up$/);

      await h.call("resume", { job_id: job.job_id, message: "normal follow-up" });
      assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
      assert.equal(h.starts()[2].prompt, "normal follow-up", "once a session exists, previous prompts are not replayed");
      assert.equal(h.starts()[2].resumed, true);
    } finally {
      await h.close();
    }
  });
});

for (const backend of ["app-server", "exec"]) {
  test(`Codex ${backend} archives finished threads and unarchives them for follow-ups`, async () => {
    const h = await harness([], { codex_backend: backend });
    try {
      const first = await h.call("ask", { target: "codex", message: "first question" });
      const id = h.starts()[0].sessionId;
      const archived = path.join(h.env.STUB_DIR, "sessions", `codex-${id}.archived`);
      assert.ok(fs.existsSync(archived), "the tool waits for archival before returning");
      const second = await h.call("ask", { thread_id: first.thread_id, message: "follow-up" });
      assert.match(second.reply, /turn 2/);
      assert.equal(h.starts()[1].sessionId, id);
      assert.ok(fs.existsSync(archived));
      // Every turn also reads Codex's feature list (codex-app.ts featuresProblem: request_permissions_tool off).
      assert.deepEqual(h.log().map((r) => r.event).filter((e) => e !== "codex-initialize"), ["skills-list", "feature-list", "start", "end", "thread/archive", "skills-list", "feature-list", "thread/unarchive", "start", "end", "thread/archive"]);
      assert.ok(h.starts().every((s) => !s.thread?.ephemeral), "sessions remain durable across server processes");
    } finally {
      await h.close();
    }
  });

  test(`Codex ${backend} archives failed and cancelled turns too`, async () => {
    const h = await harness([
      { match: task("FAIL"), steps: [{ fail: "deliberate failure" }] },
      { match: task("SLOW"), steps: [{ sleep: 60000 }] },
    ], { codex_backend: backend });
    try {
      const failed = await h.call("delegate", { target: "codex", task: "FAIL", mode: "read", background: false });
      assert.equal(failed.status, "failed");
      assert.equal(h.log().at(-1)!.event, "thread/archive");
      const slow = await h.call("delegate", { target: "codex", task: "SLOW", mode: "read" });
      await until(() => h.starts().length === 2);
      const id = h.starts()[1].sessionId;
      await h.call("cancel", { id: slow.job_id });
      assert.ok(h.log().some((r) => r.event === "thread/archive" && r.sessionId === id));
    } finally {
      await h.close();
    }
  });
}

// A worker told to stop exits by itself once the work is done rather than on a fixed delay: the
// records it writes then must all be written before it goes. A SIGTERM straight to the worker,
// unlike a cancel, leaves those records to the worker alone.
test("a worker stopped by a signal has recorded its turn cancelled, its session settled and its thread archived by the time it exits", async () => {
  const h = await harness([{ match: task("STOPPED"), steps: [{ sleep: 60000 }] }], { codex_backend: "app-server" });
  try {
    const job = await h.call("delegate", { target: "codex", task: "STOPPED", mode: "read" });
    await until(() => h.starts().length === 1 && h.sql("SELECT status FROM turns WHERE node_id = ?", job.job_id)[0]?.status === "running", 20000, "the turn to be running");
    const worker = h.sql("SELECT worker_pid FROM nodes WHERE id = ?", job.job_id)[0].worker_pid as number;
    assert.ok(worker > 1);
    process.kill(worker, "SIGTERM");
    await until(() => !alive(worker), 20000, "the worker to exit");
    assert.deepEqual(h.sql("SELECT status FROM turns WHERE node_id = ?", job.job_id).map((t) => t.status), ["cancelled"]);
    const node = h.sql("SELECT status, worker_pid, agent_pgid FROM nodes WHERE id = ?", job.job_id)[0];
    assert.deepEqual({ ...node }, { status: "cancelled", worker_pid: null, agent_pgid: null });
    assert.ok(h.log().some((r) => r.event === "thread/archive" && r.sessionId === h.starts()[0].sessionId), "the thread was archived before the worker exited");
  } finally {
    await h.close();
  }
});

test("Codex app-server resumes a thread without its past turns, which relay does not read, so Codex sends no deprecation notice", async () => {
  const h = await harness([], { codex_backend: "app-server" });
  try {
    const job = await h.call("delegate", { target: "codex", task: "FIRST", mode: "read", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    await h.call("resume", { job_id: job.job_id, message: "SECOND" });
    assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
    const [first, second] = h.starts();
    assert.equal(first.thread.excludeTurns, undefined, "thread/start has no turns to leave out");
    assert.equal(second.resumed, true);
    assert.equal(second.thread.excludeTurns, true);
    const log = fs.readFileSync(h.sql("SELECT log_path FROM nodes WHERE id = ?", job.job_id)[0].log_path, "utf8");
    assert.doesNotMatch(log, /deprecationNotice|Full-history hydration/);
  } finally {
    await h.close();
  }
});

test("a Codex archival failure preserves the answer and reports that history may remain visible", async () => {
  const h = await harness();
  try {
    // A short control isn't registered as a secret; the stub supplies the full error message.
    const root = await h.instance({ env: { STUB_CODEX_ARCHIVE_ERROR: "ENOSPC" } });
    const first = await root.call("delegate", { target: "codex", task: "answer", mode: "read", background: false });
    assert.equal(first.status, "done");
    assert.match(first.result.final_message, /stub codex reply/);
    assert.match(first.result.warnings[0], /Could not archive Codex thread .*may remain in your Codex history: disk full/);
    // An unarchived session (also how older relay jobs were stored) can still be resumed.
    await root.call("resume", { job_id: first.job_id, message: "again" });
    assert.equal((await root.call("status", { id: first.job_id, wait_s: 20 })).status, "done");
    assert.equal(h.starts()[1].resumed, true);
  } finally {
    await h.close();
  }
});

test("a first turn refused after its session was created but before the prompt reached the agent keeps no session id, so the retry replays the original task (C24)", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    for (const [target, env] of [
      ["codex", { STUB_CODEX_THREAD: JSON.stringify({ modelProvider: "elsewhere" }) }],
      ["claude", { STUB_INIT: JSON.stringify({ model: "gpt-other" }) }],
    ] as const) {
      const bad = await h.instance({ args: ["--host", target === "codex" ? "claude" : "codex"], env });
      const job = await bad.call("delegate", { target, task: `ORIGINAL-${target}`, mode: "read", background: false });
      assert.equal(job.status, "failed", JSON.stringify(job));
      assert.equal(h.sql("SELECT session_id FROM nodes WHERE id = ?", job.job_id)[0].session_id, null, `${target}: the refused session is not kept`);
      const pid = h.sql("SELECT root_pid FROM runs WHERE id = (SELECT run_id FROM nodes WHERE id = ?)", job.job_id)[0].root_pid;
      await bad.close();
      await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000, "the first session to exit");
      const good = await h.instance({ args: ["--host", target === "codex" ? "claude" : "codex"] });
      await adoptRun(h, good, job.job_id);
      assert.equal((await good.call("resume", { job_id: job.job_id, message: "retry" })).status, "queued");
      assert.equal((await good.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
      const last = h.starts().filter((s) => s.target === target).at(-1)!;
      assert.match(last.prompt, new RegExp(`ORIGINAL-${target}[\\s\\S]*\\[relay\\] Follow-up message:\\n\\nretry$`), `${target}: the original task is replayed`);
      assert.equal(last.resumed, false);
      await good.close();
    }
  } finally {
    await h.close();
  }
});

test("a turn whose agent log cannot be written still runs, and says so in its result instead of failing silently (C12/X10)", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    for (const target of ["claude", "codex"]) {
      const job = await h.call("delegate", { target, task: `LOGGED-${target}`, mode: "read", background: false });
      assert.equal(job.status, "done");
      assert.equal(job.result.warnings, undefined);
      // The log's path is now a directory: the next turn cannot open it.
      const log = h.sql("SELECT log_path FROM nodes WHERE id = ?", job.job_id)[0].log_path;
      fs.rmSync(log);
      fs.mkdirSync(log);
      await h.call("resume", { job_id: job.job_id, message: "again" });
      const r = await h.call("status", { id: job.job_id, wait_s: 30 });
      assert.equal(r.status, "done", `${target}: ${JSON.stringify(r)}`);
      assert.match((r.result.warnings ?? []).join(" "), /relay could not write the agent's log .*agent\.log.*EISDIR/, target);
    }
  } finally {
    await h.close();
  }
});
