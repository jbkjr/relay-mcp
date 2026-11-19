import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { alive, CLI, conversationOn, DESKTOP_CHATS, harness, INTERACTIVE_CLAUDE, task, terminalAdoption, until } from "./helpers.ts";

export const unavailable = {
  error: "Item unavailable.",
  recovery: "If this is your own work from before a restart or reconnect, ask the person to adopt it: adopt with this id (they confirm), or relay adopt <id> --to <fingerprint> in a terminal.",
};

test("D9 recovery 1: every start reports its run", async () => {
  const h = await harness();
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    for (const [tool, args, field] of [
      ["delegate", { target: "claude", task: "recover", mode: "read", background: false }, "job_id"],
      ["ask", { target: "claude", message: "recover" }, "thread_id"],
      ["discuss", { target: "claude", topic: "recover", message: "hello\nCONTINUE" }, "discussion_id"],
      ["review", { reviewer: "claude", target: "README.md" }, "review_id"],
    ] as const) {
      const reply = await a.call(tool, args);
      const run = h.sql("SELECT run_id FROM nodes WHERE id = ?", reply[field])[0].run_id;
      assert.equal(reply.run_id, run, tool);
      assert.deepEqual(reply.adoption, { in_directory: h.repo, item_count: h.sql("SELECT COUNT(*) AS c FROM nodes WHERE run_id = ?", run)[0].c }, tool);
    }
  } finally { await h.close(); }
});

test("D9 recovery 3: piped CLI confirmation cannot authorize adoption", async () => {
  const h = await harness();
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const job = await a.call("delegate", { target: "claude", task: "recover", mode: "read", background: false });
    const run = job.run_id;
    const pid = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid;
    await a.close(); await until(() => !alive(pid));
    const b = await h.instance({ args: ["--host", "codex"] });
    const to = (await b.call("status")).session.fingerprint;
    const terminal = spawnSync(process.execPath, [CLI, "adopt", run, "--to", to], {
      cwd: h.repo, env: h.env, input: `adopt ${run} into ${to}\n`, encoding: "utf8",
    });
    assert.notEqual(terminal.status, 0, "an exact answer from a pipe is not a person's authorization");
    assert.match(terminal.stderr, /TTY/);
    assert.equal(fs.existsSync(path.join(h.home, "adoptions", `${run}-${to}.json`)), false);
  } finally { await h.close(); }
});

test("D9 recovery 2: prompted adoption needs the reported directory and item count and hides liveness", async () => {
  const h = await harness();
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const job = await a.call("delegate", { target: "claude", task: "recover", mode: "read", background: false });
    const run = h.sql("SELECT run_id FROM nodes WHERE id = ?", job.job_id)[0].run_id;
    const pid = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid;
    const b = await h.instance({ args: ["--host", "claude"], ...INTERACTIVE_CLAUDE });
    const into_session = (await b.call("status")).session.fingerprint;
    const exact = { into_session, in_directory: h.repo, item_count: 1 };
    const missing = await b.call("adopt", { run_id: "j_00000000", ...exact });
    assert.deepEqual(missing, unavailable);
    assert.deepEqual(await b.call("adopt", { run_id: job.job_id, ...exact }), missing, "live owners reveal nothing");
    await a.close(); await until(() => !alive(pid));
    for (const wrong of [{ in_directory: "/wrong" }, { item_count: 2 }, { in_directory: undefined, item_count: undefined }]) {
      assert.deepEqual(await b.call("adopt", { run_id: job.job_id, ...exact, ...wrong }), missing, "orphaned but mismatched reveals nothing");
    }
    assert.equal(h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid, pid);
    assert.equal((await b.call("adopt", { run_id: job.job_id, ...exact })).adopted, true);
  } finally { await h.close(); }
});

test("D9 recovery 2: owner replies report exact adoption descriptions", async () => {
  const h = await harness();
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const job = await a.call("delegate", { target: "claude", task: "recover", mode: "read", background: false });
    assert.deepEqual(job.adoption, { in_directory: h.repo, item_count: 1 });
    const thread = await a.call("ask", { target: "claude", message: "recover" });
    assert.deepEqual(thread.adoption, { in_directory: h.repo, item_count: 2 });
    const status = await a.call("status", { id: job.run_id });
    assert.deepEqual(status.adoption, { in_directory: h.repo, item_count: 2 });
  } finally { await h.close(); }
});

test("D9 recovery 2: a waiting start reports items created while it waited", async () => {
  const h = await harness([{ match: task("parent count"), steps: [
    { call: "delegate", args: { target: "codex", task: "count child", mode: "read", background: false } },
    { reply: "done" },
  ] }]);
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const args = { target: "claude", task: "parent count", mode: "read", background: false, request_id: "parent" };
    const job = await a.call("delegate", args);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes WHERE run_id = ?", job.run_id)[0].c, 2);
    assert.deepEqual(job.adoption, { in_directory: h.repo, item_count: 2 });
    const replay = await a.call("delegate", args);
    assert.deepEqual(replay.adoption, job.adoption);
  } finally { await h.close(); }
});

test("D9 recovery 2: adoption tool describes relay-desktop as terminal-only", async () => {
  const h = await harness();
  try {
    const desktop = await h.instance(DESKTOP_CHATS);
    const tool = (await desktop.toolDefinitions()).find((t) => t.name === "adopt")!;
    assert.match(tool.description, /relay-desktop adoption is terminal-only/);
    assert.ok(tool.inputSchema.properties.in_directory);
    assert.ok(tool.inputSchema.properties.item_count);
    assert.ok(tool.inputSchema.properties.session_token, "a shared relay adopts into the calling conversation");
    const conversation = await conversationOn(desktop);
    assert.deepEqual(await conversation.call("adopt", { run_id: "run_00000000", into_session: conversation.fingerprint }), unavailable);
  } finally { await h.close(); }
});

test("D9 recovery 2: ticketless terminal-only callers cannot probe runs either", async () => {
  const h = await harness();
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const job = await a.call("delegate", { target: "claude", task: "recover", mode: "read", background: false });
    const pid = h.sql("SELECT root_pid FROM runs WHERE id = ?", job.run_id)[0].root_pid;
    for (const opts of [{ args: ["--host", "codex"] }, DESKTOP_CHATS]) {
      const instance = await h.instance(opts);
      // On the shared desktop entry the caller is one conversation, by its session token.
      const b = opts === DESKTOP_CHATS ? await conversationOn(instance) : { call: instance.call, fingerprint: (await instance.call("status")).session.fingerprint };
      const args = { into_session: b.fingerprint, in_directory: h.repo, item_count: 1, user_confirmed: true };
      assert.deepEqual(await b.call("adopt", { run_id: "j_00000000", ...args }), unavailable);
      assert.deepEqual(await b.call("adopt", { run_id: job.job_id, ...args }), unavailable, "a live owner without a terminal ticket is not disclosed");
    }
    await a.close(); await until(() => !alive(pid));
    const b = await h.instance({ args: ["--host", "codex"] });
    const into_session = (await b.call("status")).session.fingerprint;
    assert.deepEqual(await b.call("adopt", { run_id: job.job_id, into_session }), unavailable, "an orphan without a terminal ticket is not disclosed");
  } finally { await h.close(); }
});

test("D9 recovery 1: missing and foreign items return the same fixed recovery hint", async () => {
  const h = await harness();
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const b = await h.instance({ args: ["--host", "codex"] });
    const job = await a.call("delegate", { target: "claude", task: "recover", mode: "read", background: false });
    for (const id of [job.job_id, "j_00000000"]) assert.deepEqual(await b.call("status", { id }), unavailable);
  } finally { await h.close(); }
});

test("D9 recovery 1: any item kind resolves its run inside adoption", async () => {
  const h = await harness();
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const job = await a.call("delegate", { target: "claude", task: "recover", mode: "read", background: false });
    const thread = await a.call("ask", { target: "claude", message: "recover" });
    const discussion = await a.call("discuss", { target: "claude", topic: "recover", message: "hello\nCONTINUE" });
    const review = await a.call("review", { reviewer: "claude", target: "README.md" });
    const run = h.sql("SELECT run_id FROM nodes WHERE id = ?", job.job_id)[0].run_id;
    const count = h.sql("SELECT COUNT(*) AS c FROM nodes WHERE run_id = ?", run)[0].c;
    const pid = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid;
    await a.close(); await until(() => !alive(pid));
    for (const id of [job.job_id, thread.thread_id, discussion.discussion_id, review.review_id, run]) {
      const b = await h.instance({ args: ["--host", "claude"], ...INTERACTIVE_CLAUDE });
      const to = (await b.call("status")).session.fingerprint;
      // These descriptions become required by finding 2; they are deliberately supplied now.
      const result = await b.call("adopt", { run_id: id, into_session: to, in_directory: h.repo, item_count: count });
      assert.equal(result.adopted, true, JSON.stringify(result));
      assert.equal(result.run_id, run);
      const owner = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid;
      await b.close(); await until(() => !alive(owner));
    }
    const to = "a".repeat(24);
    for (const id of [job.job_id, thread.thread_id, discussion.discussion_id, review.review_id, run]) {
      // Mismatched text must reach confirmation, proving CLI item resolution without authorizing.
      const terminal = terminalAdoption(h, id, to, "no");
      assert.match(terminal.stdout, new RegExp(`Take over run ${run}`), id);
      assert.notEqual(terminal.status, 0);
    }
  } finally { await h.close(); }
});
