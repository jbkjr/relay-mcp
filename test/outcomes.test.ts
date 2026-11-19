// How a turn's outcome is reported: a write job that changed nothing, a turn whose agent was
// refused something, a call repeated with the same request_id, and what a running item is doing.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI, harness, nonTempScratch, passed, task, until, type Harness, type Rec } from "./helpers.ts";

/** A root session in the given host whose calls can be given their own timeout, as a host's MCP client gives up on a slow call. */
async function session(h: Harness, host: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--host", host], env: h.env, cwd: h.repo }));
  const call = async (tool: string, args: Record<string, unknown>, timeout = 120000): Promise<Rec> => {
    const res = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout })) as Rec;
    return res.isError ? { tool_error: res.content[0].text } : JSON.parse(res.content[0].text);
  };
  return { call, close: () => client.close() };
}

/** Waits until nothing in the registry is queued or running, so that closing the harness does not race a worker still writing. */
const quiet = (h: Harness) => until(() => h.sql("SELECT COUNT(*) AS c FROM nodes WHERE status IN ('queued', 'running')")[0].c === 0, 20000, "every item to settle");

/** Calls that the client gave up on: the MCP request timed out, whatever relay went on to do. */
const timesOut = (p: Promise<unknown>) => assert.rejects(p, /timed out/i);

test("no_changes: a write job that changed nothing says so in status, the tree and merge, also while its worktree is kept", async () => {
  const h = await harness([
    { match: task("LOOK"), steps: [{ call: "delegate", args: { target: "codex", task: "CHILD", mode: "read", background: true } }, { reply: "looked, changed nothing" }] },
    { match: task("CHILD"), steps: [{ sleep: 1500 }, { reply: "child done" }] },
  ]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "LOOK", mode: "write", background: false });
    assert.equal(job.status, "done");
    assert.equal(job.outcome, "no_changes");
    assert.equal(job.result.no_changes, true);
    // Its child still works inside the worktree, so the worktree and branch stay, and are still advertised.
    assert.equal(job.branch, `relay/${job.job_id}`);
    const all = await h.call("status");
    const row = all.nodes.find((n: { id: string }) => n.id === job.job_id);
    assert.equal(row.outcome, "no_changes", "the run's listing says it too, without the result");
    assert.match(all.tree, new RegExp(`${job.job_id} .* done \\(no_changes\\)`));
    const m = await h.call("merge", { job_id: job.job_id });
    assert.equal(m.status, "up_to_date", "merging an unchanged branch that is still there merges nothing");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM nodes WHERE status = 'done'")[0].c === 2, 10000, "the child to finish");
  } finally {
    await h.close();
  }
});

test("no_changes: a kept worktree that changed after the turn ended (something the agent started kept running) is no longer reported unchanged", async () => {
  const h = await harness([{ match: task("VANISH"), steps: [{ sleep: 700 }, { orphan: true }, { reply: "done", vanish: true }] }]);
  let left = 0;
  try {
    const gone = await h.call("delegate", { target: "claude", task: "VANISH", mode: "write" });
    const st = await h.call("status", { id: gone.job_id, wait_s: 20 });
    left = Number(fs.readFileSync(`${h.env.STUB_DIR}/orphan.pid`, "utf8"));
    assert.match(st.result.warnings[0], /may still be running/);
    assert.equal(st.outcome, "no_changes", "nothing has changed yet");
    // What the survivor would do: write into the kept worktree after relay's verdict.
    fs.writeFileSync(`${h.sql("SELECT worktree FROM nodes WHERE id = ?", gone.job_id)[0].worktree}/late.txt`, "written after the turn\n");
    const later = await h.call("status", { id: gone.job_id });
    assert.equal(later.outcome, undefined);
    assert.equal(later.result.no_changes, undefined);
    assert.match(later.result.warnings.at(-1), /worktree has changed since/);
    assert.doesNotMatch(String(later.outcome_note ?? ""), /nothing to merge/);
    assert.doesNotMatch((await h.call("status")).tree, /no_changes/);
  } finally {
    if (left) try { process.kill(left, "SIGKILL"); } catch {}
    await h.close();
  }
});

test("no_changes: a finished turn whose work relay could not commit is not reported as having changed nothing", async () => {
  // A nested repository in the worktree: relay will not run git in it, so the checkpoint fails and the branch stays at its base.
  const nest = "mkdir sub && cd sub && git init -q && git -c user.name=a -c user.email=a@a.a commit -q --allow-empty -m s && echo x > f";
  const h = await harness([{ match: task("NEST"), steps: [{ run: nest }, { reply: "made a nested repository" }] }]);
  try {
    const job = await h.call("delegate", { target: "codex", task: "NEST", mode: "write", background: false });
    assert.equal(job.status, "done");
    assert.match(job.result.checkpoint_error, /nested git repository \(sub\)/);
    assert.equal(job.result.files_changed_git.length, 0, "nothing was committed to the branch");
    assert.equal(job.outcome, undefined);
    assert.equal(job.result.no_changes, undefined);
    assert.equal(JSON.parse(h.sql("SELECT result_json FROM nodes WHERE id = ?", job.job_id)[0].result_json).no_changes, undefined, "nor recorded so");
    assert.equal(job.branch, `relay/${job.job_id}`);
    assert.ok(fs.existsSync(`${h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree}/sub/f`), "the uncommitted work is kept");
  } finally {
    await h.close();
  }
});

test("blocked: a turn whose own stream says it was refused something is blocked, not done, and a later clean turn is done again", async () => {
  // `codex exec` reports a refused command as an item that ended declined.
  const declined = { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "git push origin main", status: "declined" } };
  const h = await harness([
    { match: task("PUSH"), steps: [{ emit: declined }, { reply: "could not push" }] },
    { match: "try again", steps: [{ reply: "nothing needed this time" }] },
  ], { codex_backend: "exec" });
  try {
    const job = await h.call("delegate", { target: "codex", task: "PUSH", mode: "read", background: false });
    assert.equal(job.status, "blocked");
    assert.deepEqual(job.blocked, ["$ git push origin main"]);
    assert.deepEqual(job.result.blocked, job.blocked);
    assert.match(job.outcome_note, /resume it with a grant/);
    assert.match((await h.call("status")).tree, new RegExp(`${job.job_id} .* blocked`));
    assert.equal(h.sql("SELECT denials FROM turns WHERE node_id = ?", job.job_id)[0].denials, JSON.stringify(job.blocked));

    await h.call("resume", { job_id: job.job_id, message: "try again" });
    const again = await h.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(again.status, "done");
    assert.equal(again.blocked, undefined);
    assert.equal(again.result.blocked, undefined);
  } finally {
    await h.close();
  }
});

test("blocked: a consult's reply says what the agent was refused; a discussion and a review keep it as a warning", async () => {
  const review = 'looked\n```json\n{"items": [{"n": 1, "severity": "minor", "location": "a.ts", "summary": "s", "evidence": "e", "fix": "f"}]}\n```';
  const h = await harness([
    { match: "LOOKUP", steps: [{ request: { fetch: "https://example.com/spec" } }, { reply: "answered without the spec" }] },
    { match: "A or B", steps: [{ request: { web: "a vs b" } }, { reply: "A.\nCONTINUE" }] },
    { match: "REVIEW-ME", steps: [{ request: { web: "background" } }, { reply: review }] },
  ], { escalation: false });
  try {
    const a = await h.call("ask", { target: "claude", message: "LOOKUP" });
    assert.equal(a.reply, "answered without the spec");
    assert.deepEqual(a.blocked, ["fetching https://example.com/spec"]);
    assert.match(a.note, /refused something it tried/);

    const d = await h.call("discuss", { target: "claude", topic: "A or B?", message: "B.\nCONTINUE" });
    assert.equal(d.status, "open");
    const st = await h.call("status", { id: d.discussion_id });
    assert.equal(st.status, "open");
    await h.call("cancel", { id: d.discussion_id });
    assert.match(String(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", d.discussion_id)[0].params_json).state.warnings), /claude, turn 2: was refused web search: a vs b/);

    const r = await h.call("review", { reviewer: "claude", target: "REVIEW-ME" });
    const held = await h.call("status", { id: r.reviewer_job, wait_s: 20 });
    assert.equal(held.status, "blocked");
    assert.equal(held.blocked, undefined, "what a withheld reviewer was refused would show where it looked, so it is held back too");
    assert.doesNotMatch(JSON.stringify(held), /background/);
    const done = await h.call("review", { review_id: r.review_id, skip_own: true });
    assert.equal(done.outcome, "partial", "a reviewer that was refused something still handed in its review");
    assert.equal(done.consensus.length, 1);
    assert.match(done.warnings[0], /^claude reviewer: was refused web search: background/);
  } finally {
    await h.close();
  }
});

test("blocked: the root session hears that a blocked job finished, and that a discussion whose participant was refused something has a reply", async () => {
  const h = await harness([
    { match: task("NEEDS WEB"), steps: [{ request: { web: "relay protocol" } }, { reply: "could not search" }] },
    { match: task("PLAIN"), steps: [{ sleep: 300 }, { reply: "plain" }] },
    { match: "A or B", steps: [{ request: { web: "a vs b" } }, { reply: "A.\nCONTINUE" }] },
  ], { escalation: false });
  try {
    const session = await h.instance({ args: ["--host", "codex"] });
    const blocked = await session.call("delegate", { target: "claude", task: "NEEDS WEB", mode: "read" });
    const plain = await session.call("delegate", { target: "claude", task: "PLAIN", mode: "read" });
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", blocked.job_id)[0].status === "blocked", 15000, "the job to end blocked");
    const st = await session.call("status", { id: plain.job_id, wait_s: 20 });
    assert.deepEqual((st.events ?? []).map((e: { item: string; notice: string }) => [e.item, e.notice.replace(/^relay \(event \d+\): /, "")]), [
      [blocked.job_id, `job ${blocked.job_id} finished (blocked): its agent was refused something it tried. Call result ${blocked.job_id}.`],
    ]);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM events WHERE subject = ?", blocked.job_id)[0].c, 1, "recorded once");

    // A discussion reply from a participant that was refused something is a reply all the same.
    const d = await session.call("discuss", { target: "claude", topic: "A or B?", message: "B.\nCONTINUE" });
    assert.equal(d.status, "open");
    const participant = h.sql("SELECT id, status FROM nodes WHERE parent_id = ? AND kind = 'thread'", d.discussion_id)[0];
    assert.equal(participant.status, "blocked");
    assert.deepEqual(h.sql("SELECT text FROM events WHERE subject = ?", participant.id).map((e) => e.text), [`discussion ${d.discussion_id} has a reply. Call status ${d.discussion_id}.`]);
    await session.call("cancel", { id: d.discussion_id });
  } finally {
    await h.close();
  }
});

test("request_id: an ask repeated after the client timed out gets the first call's reply, and nothing is asked twice", async () => {
  const h = await harness([{ match: "SLOW QUESTION", steps: [{ sleep: 2500 }, { reply: "the answer" }] }]);
  const s = await session(h, "claude");
  try {
    const args = { target: "codex", message: "SLOW QUESTION", request_id: "q-1" };
    await timesOut(s.call("ask", args, 800));
    const again = await s.call("ask", args);
    assert.equal(again.reply, "the answer");
    assert.equal(again.repeated, true);
    assert.match(again.repeated_note, /already started t_/);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes")[0].c, 1, "one thread");
    assert.equal(h.starts().length, 1, "the question was put once");
    // A follow-up names its own request_id; repeating that one does not ask the follow-up twice either.
    const more = { target: "codex", message: "and then?", thread_id: again.thread_id, request_id: "q-2" };
    const first = await s.call("ask", more);
    const second = await s.call("ask", more);
    assert.equal(second.reply, first.reply);
    assert.equal(second.repeated, true);
    assert.equal(h.starts().length, 2);
  } finally {
    await s.close();
    await h.close();
  }
});

test("request_id: a delegate repeated after a timeout, or at the same moment, returns the one job; a reused id for other work is refused", async () => {
  const h = await harness([{ match: task("BUILD IT"), steps: [{ sleep: 2000 }, { write: "built.txt" }, { reply: "built" }] }]);
  const s = await session(h, "claude");
  const other = await session(h, "claude");
  try {
    const args = { target: "codex", task: "BUILD IT", mode: "write", background: false, request_id: "job-1" };
    await timesOut(s.call("delegate", args, 800));
    // Repeated without waiting this time: background is not part of what is compared.
    const again = await s.call("delegate", { ...args, background: true });
    assert.equal(again.repeated, true);
    assert.equal(again.branch, `relay/${again.job_id}`);
    const done = await s.call("status", { id: again.job_id, wait_s: 20 });
    assert.equal(done.status, "done");
    assert.deepEqual(done.result.files_changed_git, ["built.txt"]);
    // After it finished, a repeat that waits returns the finished job at once.
    const finished = await s.call("delegate", args);
    assert.equal(finished.job_id, again.job_id);
    assert.equal(finished.status, "done");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes")[0].c, 1);

    const reused = await s.call("delegate", { ...args, task: "SOMETHING ELSE" });
    assert.equal(reused.refused, true);
    assert.match(reused.reason, /already used by an earlier delegate call .* Use a new request_id/);

    // Two calls with one request_id at the same moment start one job.
    const [x, y] = await Promise.all([1, 2].map(() => s.call("delegate", { target: "codex", task: "BUILD IT", mode: "read", request_id: "job-2" })));
    assert.equal(x.job_id, y.job_id);
    assert.equal([x, y].filter((r) => r.repeated).length, 1);

    // Another session's request_ids are its own.
    const theirs = await other.call("delegate", { target: "codex", task: "BUILD IT", mode: "read", request_id: "job-2" });
    assert.notEqual(theirs.job_id, x.job_id);
    assert.equal(theirs.repeated, undefined);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes")[0].c, 3);
    await quiet(h);
  } finally {
    await s.close();
    await other.close();
    await h.close();
  }
});

test("request_id: starting a discussion or a review twice with one request_id starts it once", async () => {
  const h = await harness([
    { match: "SLOW OPENING", steps: [{ sleep: 2500 }, { reply: "my view\nCONTINUE" }] },
    { match: "REVIEW TARGET", steps: [{ reply: "fine" }] },
  ]);
  const s = await session(h, "claude");
  try {
    const args = { target: "codex", topic: "which design?", message: "SLOW OPENING\nCONTINUE", request_id: "d-1" };
    await timesOut(s.call("discuss", args, 800));
    const again = await s.call("discuss", args);
    assert.equal(again.repeated, true);
    assert.equal(again.reply, "my view\nCONTINUE");
    assert.equal(again.turns, 2, "the opening message was sent once");
    const r1 = await s.call("review", { reviewer: "codex", target: "REVIEW TARGET", request_id: "r-1" });
    const r2 = await s.call("review", { reviewer: "codex", target: "REVIEW TARGET", request_id: "r-1" });
    assert.equal(r2.review_id, r1.review_id);
    assert.equal(r2.repeated, true);
    assert.deepEqual(h.sql("SELECT kind, COUNT(*) AS c FROM nodes GROUP BY kind ORDER BY kind").map((r) => [r.kind, r.c]), [["discussion", 1], ["job", 1], ["review", 1], ["thread", 1]]);
    await quiet(h);
  } finally {
    await s.close();
    await h.close();
  }
});

test("request_id: a discussion's request_id is bound only once its opening message is on its way, so a repeat never sees it half made", async () => {
  const h = await harness([{ match: "OPENING", steps: [{ reply: "my view\nCONTINUE" }] }]);
  const s = await session(h, "claude");
  try {
    await s.call("status", {});
    // What a repeat from another relay process would find, at the moment the request_id is bound.
    h.sql("CREATE TABLE seen_at_bind (node_id TEXT, params_json TEXT)");
    h.sql(`CREATE TRIGGER record_bind AFTER UPDATE OF node_id ON calls WHEN NEW.node_id != '' BEGIN
      INSERT INTO seen_at_bind SELECT id, params_json FROM nodes WHERE id = NEW.node_id; END`);
    const d = await s.call("discuss", { target: "codex", topic: "which design?", message: "OPENING\nCONTINUE", request_id: "d-bind" });
    assert.equal(d.turns, 2);
    const [seen] = h.sql("SELECT * FROM seen_at_bind");
    assert.equal(seen.node_id, d.discussion_id);
    assert.ok(seen.params_json, "the discussion's parameters were recorded");
    const state = JSON.parse(seen.params_json).state;
    assert.equal(state.turns, 1, "the opening message was taken");
    assert.notEqual(state.pending, undefined, "and its reply is awaited, so a repeat waits for it rather than being told to send");
  } finally {
    await s.close();
    await h.close();
  }
});

test("request_id: a launched agent's repeated delegate returns the job it already started", async () => {
  const kid = { target: "codex", task: "KID", mode: "read", request_id: "kid-1" };
  const h = await harness([
    { match: task("PARENT"), steps: [{ call: "delegate", args: kid, as: "first" }, { call: "delegate", args: kid, as: "second" }, { reply: "{{first.job_id}} {{second.job_id}} {{second.repeated}}" }] },
  ]);
  try {
    const parent = await h.call("delegate", { target: "claude", task: "PARENT", mode: "read", background: false });
    const [first, second, repeated] = parent.result.final_message.split(" ");
    assert.match(first, /^j_/);
    assert.equal(second, first);
    assert.equal(repeated, "true");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM nodes WHERE status = 'done'")[0].c === 2, 10000, "the one child to finish");
    assert.equal(h.starts().filter((st) => /assignment:\s+KID$/.test(st.prompt)).length, 1);
  } finally {
    await h.close();
  }
});

test("request_id: one agent's calls through two relay processes at the same moment start one job", async () => {
  // The parent changes a file, so that its worktree stays for the children to branch from.
  const h = await harness([{ match: task("PARENT"), steps: [{ write: "p.txt" }, { reply: "parent" }] }, { match: task("SOLO"), steps: [{ reply: "solo" }] }]);
  try {
    const parent = await h.call("delegate", { target: "claude", task: "PARENT", mode: "write", background: false });
    // Two connections for the same turn of the same agent: separate processes sharing its request_ids.
    const ctx = await h.childOf(parent.job_id, { access: "write" });
    const [one, two] = await Promise.all([h.instance(ctx), h.instance(ctx)]);
    // Write jobs, whose worktree takes a moment to create: the window in which a check-then-record would let both start.
    const args = { target: "codex", task: "SOLO", mode: "write", request_id: "solo-1" };
    const results = await Promise.all([...Array(3)].flatMap(() => [one.call("delegate", args), two.call("delegate", args)]));
    assert.equal(new Set(results.map((r) => r.job_id)).size, 1, `one job: ${JSON.stringify(results.map((r) => r.job_id ?? r))}`);
    assert.equal(results.filter((r) => !r.repeated).length, 1, `exactly one call started it: ${JSON.stringify(results)}`);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes WHERE parent_id = ?", parent.job_id)[0].c, 1);
    // The parent's turn here is the test's own and never ends; its child must.
    await until(() => h.sql("SELECT COUNT(*) AS c FROM nodes WHERE parent_id = ? AND status IN ('queued', 'running')", parent.job_id)[0].c === 0, 20000, "the child to settle");
  } finally {
    await h.close();
  }
});

test("liveness: status says when a running job last did anything, what it last started, and which files it has changed", async () => {
  const bash = { type: "assistant", message: { content: [{ type: "text", text: "running the tests" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] } };
  // Names that begin with whitespace come first in git's listing, where trimming its output would cut them.
  const h = await harness([{ match: task("WORK"), steps: [{ write: "a.txt" }, { write: "b.txt" }, { write: " lead.txt" }, { write: "\ttab.txt" }, { emit: bash }, { sleep: 4000 }, { reply: "done" }] }]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "WORK", mode: "write" });
    let st: Rec = {};
    await until(async () => (st = await h.call("status", { id: job.job_id })).liveness?.activity === "$ npm test", 10000, "the tool call to show");
    assert.deepEqual(st.liveness.files_touched, ["\ttab.txt", " lead.txt", "a.txt", "b.txt"]);
    assert.ok(Date.parse(st.liveness.activity_at) <= Date.parse(st.liveness.last_activity_at));
    assert.ok(Date.parse(st.liveness.last_activity_at) <= Date.now());
    await until(async () => (st = await h.call("status", { id: job.job_id })).liveness?.quiet_s >= 2, 10000, "quiet time to grow");
    assert.equal(st.status, "running", "a quiet agent is only reported, never stopped");
    const tree = (await h.call("status")).tree;
    assert.match(tree, /· \$ npm test, quiet \d+s, 4 files changed/);
    const done = await h.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(done.status, "done");
    assert.equal(done.liveness, undefined, "a finished job has no liveness");
  } finally {
    await h.close();
  }
});

test("liveness: what Codex last started is shown in either dialect, and a withheld reviewer's is not", async () => {
  const started = { method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: "cargo build" } } };
  const completed = { method: "item/completed", params: { item: { type: "commandExecution", id: "c1", command: "cargo build", status: "completed" } } };
  const execStarted = { type: "item.started", item: { id: "item_3", type: "mcp_tool_call", server: "docs", tool: "search" } };
  const h = await harness([
    { match: task("APP"), steps: [{ emit: started }, { sleep: 2500 }, { emit: completed }, { sleep: 2500 }, { reply: "built" }] },
    { match: "REVIEW SLOWLY", steps: [{ emit: started }, { sleep: 3000 }, { reply: "fine" }] },
  ]);
  const exec = await harness([{ match: task("EXEC"), steps: [{ emit: execStarted }, { sleep: 3000 }, { reply: "searched" }] }], { codex_backend: "exec" });
  try {
    const job = await h.call("delegate", { target: "codex", task: "APP", mode: "read" });
    let st: Rec = {};
    await until(async () => (st = await h.call("status", { id: job.job_id })).liveness?.activity === "$ cargo build", 10000, "the command to show");
    assert.equal(st.liveness.files_touched, undefined, "a read job changes no files");

    const r = await h.call("review", { reviewer: "codex", target: "REVIEW SLOWLY" });
    await until(async () => (st = await h.call("status", { id: r.reviewer_job })).liveness !== undefined, 10000, "the reviewer to run");
    assert.equal(st.liveness.activity, undefined, "what a withheld reviewer is doing stays out of view, as its log does");
    assert.equal(typeof st.liveness.quiet_s, "number");

    const ej = await exec.call("delegate", { target: "codex", task: "EXEC", mode: "read" });
    await until(async () => (st = await exec.call("status", { id: ej.job_id })).liveness?.activity === "tool docs.search", 10000, "the exec tool call to show");
    await quiet(h);
    await quiet(exec);
  } finally {
    await h.close();
    await exec.close();
  }
});

test("blocked: a reviewer's refusal is still in the review's result once the reconciliation has ended", async () => {
  const items = '```json\n{"items": [{"n": 1, "severity": "minor", "location": "a.ts", "summary": "s", "evidence": "e", "fix": "f"}]}\n```';
  const h = await harness([
    { match: "stated its crux", steps: [{ reply: "CRUX: we differ on C1" }] },
    { match: "Reconcile two independent reviews", steps: [{ reply: "Let us go through them.\nCONTINUE" }] },
    { match: "RECONCILE-ME", steps: [{ request: { web: "prior art" } }, { reply: `looked\n${items}` }] },
  ], { escalation: false });
  try {
    const r = await h.call("review", { reviewer: "claude", target: "RECONCILE-ME" });
    const opened = await h.call("review", { review_id: r.review_id, own_review: `mine\n${items}` });
    assert.equal(opened.phase, "reconciling");
    await h.call("discuss", { discussion_id: opened.discussion_id, message: "CRUX: C1 is not real" });
    const res = await h.call("result", { job_id: r.review_id });
    assert.equal(res.outcome, "no_agreement");
    assert.ok(res.warnings.some((w: string) => /^claude reviewer: was refused web search: prior art/.test(w)), JSON.stringify(res.warnings));
  } finally {
    await h.close();
  }
});

test("liveness: before the agent has started anything, no activity is reported, rather than a guess", async () => {
  const h = await harness([{ match: task("THINK"), steps: [{ sleep: 3000 }, { reply: "thought" }] }]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "THINK", mode: "read" });
    let st: Rec = {};
    await until(async () => (st = await h.call("status", { id: job.job_id })).liveness !== undefined, 10000, "the job to run");
    assert.equal(st.liveness.activity, undefined);
    assert.equal(st.liveness.activity_at, undefined);
    assert.equal(typeof st.liveness.quiet_s, "number");
    await quiet(h);
  } finally {
    await h.close();
  }
});

test("request_id: a claim is taken over only from a process that has gone, and only its holder can bind or release it", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-calls-"));
  const before = process.env.RELAY_HOME;
  process.env.RELAY_HOME = home;
  try {
    const { claimCall, bindCall, releaseCall } = await import("../dist/core/calls.js");
    const { db } = await import("../dist/core/db.js");
    const args = { task: "t" };
    const a = claimCall("node:x", "delegate", "r", args);
    assert.ok("claimed" in a);
    // However long ago: its holder (this process) is alive, so it is still starting, not abandoned.
    db().prepare("UPDATE calls SET created_at = 0").run();
    assert.ok("starting" in claimCall("node:x", "delegate", "r", args));
    // Someone else's token neither binds nor releases it.
    bindCall("node:x", "r", "not-the-claim", "j_other");
    releaseCall("node:x", "r", "not-the-claim");
    assert.ok("starting" in claimCall("node:x", "delegate", "r", args));
    // Its holder gone, the claim can be taken; the old token can then touch nothing.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    db().prepare("UPDATE calls SET owner_pid = ?, owner_start = 'Thu Jan  1 00:00:00 1970'").run(dead);
    const b = claimCall("node:x", "delegate", "r", args);
    assert.ok("claimed" in b);
    bindCall("node:x", "r", (a as { claimed: string }).claimed, "j_stale");
    bindCall("node:x", "r", (b as { claimed: string }).claimed, "j_new");
    const bound = claimCall("node:x", "delegate", "r", args);
    assert.equal("call" in bound && bound.call.node_id, "j_new");
  } finally {
    if (before === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = before;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("request_id: a replayed delegate returns the same caller-visible grant as the first, without the internal pins (review C7/X5)", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const grant = nonTempScratch("relay-c7-grant-");
  const h = await harness([{ match: task("WORK"), steps: [{ write: "out.txt" }, { reply: "done" }] }]);
  try {
    const args = { target: "codex", task: "WORK", mode: "write", background: false, request_id: "c7-1", grant: { network: true, write_paths: [grant] } };
    const first = await h.call("delegate", args);
    assert.deepEqual(first.grant, { network: true, write_paths: [grant] }, "no write_path_pins in the response");
    // Replayed with the same request_id: the grant in the reply matches the first exactly.
    const again = await h.call("delegate", { ...args, background: true });
    assert.equal(again.repeated, true);
    assert.deepEqual(again.grant, first.grant, "the replayed grant matches the first");
    assert.equal((again.grant as Rec).write_path_pins, undefined);
    // The pins are kept internally, in params_json, for the confine layer.
    const stored = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", first.job_id)[0].params_json).grant;
    assert.equal(stored.write_path_pins.length, 1, "pins are stored internally");
    await h.call("status", { id: first.job_id, wait_s: 20 });
  } finally {
    fs.rmSync(grant, { recursive: true, force: true });
    await h.close();
  }
});

test("request_id: a delegate or ask that fails part-way leaves nothing half made, so its repeat starts it afresh and once (review X1)", async () => {
  const h = await harness([{ match: task("ATOMIC"), steps: [{ reply: "done" }] }, { match: "ATOMIC QUESTION", steps: [{ reply: "the answer" }] }]);
  const s = await session(h, "claude");
  try {
    await s.call("status", {});
    // The first turn cannot be recorded: the job must not exist, bound to the request_id, without it.
    h.sql("CREATE TRIGGER fail_turn BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'injected: no turn'); END");
    const job = { target: "codex", task: "ATOMIC", mode: "write", background: false, request_id: "x1-job" };
    assert.match(String((await s.call("delegate", job)).error), /injected: no turn/);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes")[0].c, 0, "no job without its first turn");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM calls")[0].c, 0, "and no request_id bound to one");
    h.sql("DROP TRIGGER fail_turn");
    // The request_id cannot be bound: the question must not be left queued, to be asked again by the repeat.
    h.sql("CREATE TRIGGER fail_bind BEFORE UPDATE OF node_id ON calls WHEN NEW.node_id != '' BEGIN SELECT RAISE(ABORT, 'injected: no bind'); END");
    const question = { target: "codex", message: "ATOMIC QUESTION", request_id: "x1-ask" };
    assert.match(String((await s.call("ask", question)).error), /injected: no bind/);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM turns")[0].c, 0, "no question left queued");
    h.sql("DROP TRIGGER fail_bind");

    const done = await s.call("delegate", job);
    assert.equal(done.repeated, undefined, "nothing had been started");
    assert.equal(done.status, "done");
    const answer = await s.call("ask", question);
    assert.equal(answer.reply, "the answer");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM turns")[0].c, 2, "one turn each");
    assert.equal(h.starts().length, 2, "each was put to an agent once");
  } finally {
    await s.close();
    await h.close();
  }
});

test("request_id: work recorded but whose worker could not be started is started by the call's repeat (review X1)", async () => {
  const h = await harness([{ match: task("DISPATCH"), steps: [{ reply: "done" }] }, { match: "DISPATCH QUESTION", steps: [{ reply: "the answer" }] }]);
  const s = await session(h, "claude");
  try {
    await s.call("status", {});
    // The worker's claim fails after the work and its request_id are committed.
    h.sql("CREATE TRIGGER fail_worker BEFORE UPDATE OF worker_pid ON nodes WHEN NEW.worker_pid = -1 BEGIN SELECT RAISE(ABORT, 'injected: no worker'); END");
    const job = { target: "codex", task: "DISPATCH", mode: "read", background: false, request_id: "x1-dispatch" };
    const first = await s.call("delegate", job);
    assert.match(first.job_id, /^j_/, `the job exists and the caller is told its id: ${JSON.stringify(first)}`);
    assert.match(String(first.warning), /could not start the worker of .*injected: no worker/);
    const question = { target: "codex", message: "DISPATCH QUESTION", request_id: "x1-dispatch-ask" };
    const asked = await s.call("ask", question);
    assert.match(asked.thread_id, /^t_/);
    assert.match(String(asked.warning), /could not start the worker of .*injected: no worker/);
    h.sql("DROP TRIGGER fail_worker");

    const again = await s.call("delegate", job);
    assert.equal(again.repeated, true);
    assert.equal(again.job_id, first.job_id);
    assert.equal(again.status, "done", "the repeat started its worker");
    const answer = await s.call("ask", question);
    assert.equal(answer.repeated, true);
    assert.equal(answer.reply, "the answer");
    assert.equal(h.starts().length, 2);

    // Without a request_id, the session's status call on the item starts it.
    h.sql("CREATE TRIGGER fail_worker BEFORE UPDATE OF worker_pid ON nodes WHEN NEW.worker_pid = -1 BEGIN SELECT RAISE(ABORT, 'injected: no worker'); END");
    const plain = await s.call("delegate", { target: "codex", task: "DISPATCH", mode: "read" });
    assert.match(String(plain.warning), /could not start the worker of .*injected: no worker/);
    h.sql("DROP TRIGGER fail_worker");
    assert.equal((await s.call("status", { id: plain.job_id, wait_s: 20 })).status, "done");
    assert.equal(h.starts().length, 3);
  } finally {
    await s.close();
    await h.close();
  }
});

test("no_changes: a discussion turn on a borrowed write job leaves the worktree and branch its result advertises (review C9)", async () => {
  const h = await harness([
    { match: task("LOOK"), steps: [{ call: "delegate", args: { target: "codex", task: "CHILD", mode: "read", background: true } }, { reply: "looked, changed nothing" }] },
    { match: task("CHILD"), steps: [{ sleep: 1500 }, { reply: "child done" }] },
    { match: "BORROWED TOPIC", steps: [{ reply: "fine\nAGREE: it is fine" }] },
  ]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "LOOK", mode: "write", background: false });
    assert.equal(job.outcome, "no_changes");
    assert.equal(job.branch, `relay/${job.job_id}`, "kept while its child works in it");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM nodes WHERE status = 'done'")[0].c === 2, 20000, "the child to finish");
    const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree;
    const d = await h.call("discuss", { topic: "BORROWED TOPIC", message: "is it fine?\nCONTINUE", with: job.job_id });
    assert.equal(d.marker, "AGREE", JSON.stringify(d));
    assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
    assert.ok(fs.existsSync(wt), "the discussion turn did not remove the job's worktree");
    const { execFileSync } = await import("node:child_process");
    assert.doesNotThrow(() => execFileSync("git", ["rev-parse", "--verify", `refs/heads/relay/${job.job_id}`], { cwd: h.repo, stdio: "pipe" }), "nor its branch");
    const st = await h.call("status", { id: job.job_id });
    assert.equal(st.branch, `relay/${job.job_id}`);
    assert.equal(st.result.branch, `relay/${job.job_id}`, "which its result still names");
    await h.call("cancel", { id: d.discussion_id });
  } finally {
    await h.close();
  }
});

test("no_changes: once a merge has committed late writes and removed the kept worktree, the job no longer says it changed nothing (review C8)", async () => {
  const h = await harness([{ match: task("VANISH"), steps: [{ sleep: 700 }, { orphan: true }, { reply: "done", vanish: true }] }]);
  let left = 0;
  try {
    const gone = await h.call("delegate", { target: "claude", task: "VANISH", mode: "write" });
    const st = await h.call("status", { id: gone.job_id, wait_s: 20 });
    left = Number(fs.readFileSync(`${h.env.STUB_DIR}/orphan.pid`, "utf8"));
    assert.equal(st.outcome, "no_changes", "nothing has changed yet");
    const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", gone.job_id)[0].worktree;
    fs.writeFileSync(`${wt}/late.txt`, "written after the turn\n");
    // Relay's own periodic look may have stopped the orphan already (it outlived its agent): only
    // that, ESRCH, is not a failure of this test.
    try {
      process.kill(left, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    left = 0;
    // Merge takes what the result showed and nothing written since, unless told to (0.9.1).
    const unasked = await h.call("merge", { job_id: gone.job_id });
    assert.equal(unasked.refused, true, JSON.stringify(unasked));
    assert.deepEqual(unasked.changed_files, ["late.txt"]);
    const m = await h.call("merge", { job_id: gone.job_id, include_changes_since_result: true });
    assert.equal(m.status, "merged", JSON.stringify(m));
    assert.equal(m.worktree_removed, true);
    assert.ok(fs.existsSync(`${h.repo}/late.txt`), "the late write was committed and merged");
    const later = await h.call("status", { id: gone.job_id });
    assert.equal(later.outcome, undefined, JSON.stringify(later));
    assert.equal(later.result.no_changes, undefined);
    assert.match(later.result.warnings.at(-1), /branch has commits since/);
    assert.doesNotMatch((await h.call("status")).tree, /no_changes/);
  } finally {
    if (left) try { process.kill(left, "SIGKILL"); } catch {}
    await h.close();
  }
});

test("no_changes: looking again at a kept worktree does not write its index, where something the job started may be running git (review C20)", async () => {
  const h = await harness([{ match: task("VANISH"), steps: [{ sleep: 700 }, { orphan: true }, { reply: "done", vanish: true }] }]);
  let left = 0;
  try {
    const gone = await h.call("delegate", { target: "claude", task: "VANISH", mode: "write" });
    assert.equal((await h.call("status", { id: gone.job_id, wait_s: 20 })).outcome, "no_changes");
    left = Number(fs.readFileSync(`${h.env.STUB_DIR}/orphan.pid`, "utf8"));
    const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", gone.job_id)[0].worktree;
    const { execFileSync } = await import("node:child_process");
    const index = execFileSync("git", ["-C", h.repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim() + `/worktrees/${wt.split("/").at(-1)}/index`;
    // A tracked file whose recorded stat no longer matches: a status that may write refreshes the index.
    fs.utimesSync(`${wt}/README.md`, new Date("2001-01-01"), new Date("2001-01-01"));
    const before = fs.statSync(index);
    const st = await h.call("status", { id: gone.job_id });
    assert.equal(st.outcome, "no_changes", "the content is unchanged");
    const after = fs.statSync(index);
    assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs], "the worktree's index was not rewritten");
  } finally {
    if (left) try { process.kill(left, "SIGKILL"); } catch {}
    await h.close();
  }
});

test("liveness: what an agent chose to search for reaches status, progress lines and relay tree escaped, never as terminal control characters (review C12)", async () => {
  const title = "\u001b]0;OWNED\u0007";
  const grep = { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Grep", input: { pattern: `${title}needle` } }] } };
  const h = await harness([{ match: task("SEARCH"), steps: [{ emit: grep }, { checkpoint: "searched" }, { sleep: 1500 }, { reply: "found it" }] }], {}, { RELAY_TICK_MS: "200" });
  try {
    const job = await h.call("delegate", { target: "claude", task: "SEARCH", mode: "read" });
    await passed(h, job.job_id, "searched");
    const raw = /[\u0000-\u0008\u000b-\u001f\u007f]/;
    let st: Rec = {};
    await until(async () => typeof (st = await h.call("status", { id: job.job_id })).liveness?.activity === "string", 10000, "the search to show");
    assert.doesNotMatch(st.liveness.activity, raw);
    assert.match(st.liveness.activity, /grep \(1 line, shown escaped\) \\u001b\]0;OWNED\\u0007needle/);
    const progress: string[] = [];
    await h.call("status", { id: job.job_id, wait_s: 20 }, { onprogress: (p) => progress.push(p.message ?? "") });
    assert.ok(progress.some((m) => /now: grep/.test(m)), `a progress line named the search: ${JSON.stringify(progress)}`);
    for (const m of progress) assert.doesNotMatch(m, raw);
    assert.doesNotMatch(h.cli("tree"), raw);
  } finally {
    await h.close();
  }
});

test("liveness: relay tree shows a task with terminal control characters escaped (review C12)", async () => {
  const h = await harness([{ match: "PAINT", steps: [{ checkpoint: "painting" }, { reply: "done" }] }]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "PAINT \u001b[2J\u001b[31mred", mode: "read" });
    await passed(h, job.job_id, "painting");
    const tree = h.cli("tree");
    assert.match(tree, /PAINT .*\\u001b\[2J/, tree);
    assert.doesNotMatch(tree, /\u001b/);
    await h.call("status", { id: job.job_id, wait_s: 20 });
  } finally {
    await h.close();
  }
});

test("liveness: a waiting call's progress lines leave out what a withheld reviewer is doing, as status does (review C19)", async () => {
  const started = { method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: "cargo build" } } };
  const h = await harness([{ match: "REVIEW SLOWLY", steps: [{ emit: started }, { checkpoint: "reviewing" }, { sleep: 2000 }, { reply: "fine" }] }], {}, { RELAY_TICK_MS: "200" });
  try {
    const r = await h.call("review", { reviewer: "codex", target: "REVIEW SLOWLY" });
    await passed(h, r.reviewer_job, "reviewing");
    const progress: string[] = [];
    const onprogress = (p: { message?: string }) => progress.push(p.message ?? "");
    await h.call("status", { id: r.reviewer_job, wait_s: 20 }, { onprogress });
    assert.ok(progress.some((m) => m.startsWith(`relay: ${r.reviewer_job} `)), `progress lines were sent: ${JSON.stringify(progress)}`);
    for (const m of progress) assert.doesNotMatch(m, /cargo build|now:/, "nothing of what the withheld reviewer is doing");
  } finally {
    await h.close();
  }
});

test("request_id: its description says that ids are matched per relay server, or per session token on a shared relay (review C17)", async () => {
  const h = await harness();
  const client = new Client({ name: "test", version: "0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--host", "claude"], env: h.env, cwd: h.repo }));
    const tools = (await client.listTools()).tools;
    for (const name of ["delegate", "ask", "discuss", "review"]) {
      const said = String((tools.find((t) => t.name === name)!.inputSchema.properties as Rec).request_id.description);
      assert.match(said, /matched per caller: a relay server process, or on a shared relay \(the desktop app's\) a conversation's session_token/, `${name}: ${said}`);
      assert.match(said, /fresh UUID, never a counter or a name/, name);
    }
  } finally {
    await client.close();
    await h.close();
  }
});
