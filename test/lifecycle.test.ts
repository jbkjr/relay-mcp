import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptRun, alive, CLI, harness, sleep, task, until, type Harness, type Rec, UNAVAILABLE_REPLY } from "./helpers.ts";

// Lifecycle edges: approval requests that outlive their turn, events that settle while no root
// session is alive, and review participants reached outside the review.

/** A finished Claude job to hang test turns on, and a launched agent's relay connection for a fresh running turn of it. */
async function claudeTurn(h: Harness) {
  const job = await h.call("delegate", { target: "claude", task: "IDLE", mode: "write", background: false });
  assert.equal(job.status, "done");
  const child = await h.childOf(job.job_id, { may_ask: true, may_delegate: false });
  const agent = await h.instance({ args: child.args, env: child.env });
  return { jobId: job.job_id as string, turnId: child.turnId, agent };
}

/** What the worker does when a turn ends: the turn and its session are over, and what it asked is closed. */
function endTurn(h: Harness, jobId: string, turnId: number) {
  h.sql("UPDATE turns SET status = 'done', ended_at = ? WHERE id = ?", Date.now(), turnId);
  h.sql("UPDATE nodes SET status = 'done', ended_at = ? WHERE id = ?", Date.now(), jobId);
  h.sql("UPDATE requests SET status = 'expired', decided_at = ? WHERE node_id = ? AND status = 'pending'", Date.now(), jobId);
}

const fetch = (url: string) => ({ tool_name: "WebFetch", input: { url } });
const webOn = (h: Harness, jobId: string) => Boolean(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", jobId)[0].params_json ?? "{}").grant?.network);

/**
 * What a blocking call came to, in a harness whose block_s is 1 s so that a later call is left
 * pending. A call meant to finish within it can outlast that second on a loaded machine (as on
 * GitHub's runners) and return a pending handle instead; it is then followed with status until it
 * settles, and the view status gives is merged over the call's own answer.
 */
async function settledCall(via: { call: Harness["call"] }, first: Rec): Promise<Rec> {
  if (!first.pending) return first;
  let view: Rec = {};
  await until(async () => {
    view = await via.call("status", { id: first.id, wait_s: 1 });
    return typeof view.status === "string" && !["queued", "running"].includes(view.status);
  }, 60000, `${first.id} to settle`);
  return { ...first, ...view, pending: undefined };
}

test("approvals: two requests queued in one turn both end with it; the one behind never files a request after the turn is over", async () => {
  const h = await harness([{ match: task("IDLE"), steps: [{ reply: "idle" }] }], { approval_timeout_s: 20 });
  try {
    const { jobId, turnId, agent } = await claudeTurn(h);
    const a = agent.call("permission_prompt", fetch("https://a.example"));
    const b = agent.call("permission_prompt", fetch("https://b.example"));
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 10000, "the first request");
    await sleep(600);
    endTurn(h, jobId, turnId);
    const started = Date.now();
    const [ra, rb] = await Promise.all([a, b]);
    assert.ok(Date.now() - started < 5000, "both answered once the turn ended, not when the approval timeout ran out");
    assert.equal(ra.behavior, "deny");
    assert.equal(rb.behavior, "deny");
    await sleep(500);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests")[0].c, 1, "the request behind the first was never filed");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c, 0);
    assert.equal(webOn(h, jobId), false);
    await agent.close();
  } finally {
    await h.close();
  }
});

test("approvals: a request records the turn that asked, and a decision after that turn has ended allows nothing, even once the job runs again", async () => {
  const h = await harness([{ match: task("IDLE"), steps: [{ reply: "idle" }] }], { approval_timeout_s: 20 });
  try {
    const { jobId, turnId, agent } = await claudeTurn(h);
    const asked = agent.call("permission_prompt", fetch("https://stale.example"));
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 10000, "the request");
    const req = h.sql("SELECT id, turn_id FROM requests")[0];
    assert.equal(req.turn_id, turnId, "the asking turn is recorded with the request");
    // The turn ends without the request being closed (the worker had not got to it), and the job goes on to a new turn.
    h.sql("UPDATE turns SET status = 'done', ended_at = ? WHERE id = ?", Date.now(), turnId);
    assert.equal((await asked).behavior, "deny", "the asking call learns its turn is over");
    h.sql("UPDATE requests SET status = 'pending', decided_at = NULL WHERE id = ?", req.id);
    const next = await h.childOf(jobId, { may_ask: true, may_delegate: false });
    assert.notEqual(next.turnId, turnId);
    const res = await h.call("approve", { request_id: req.id, decision: "allow", scope: "job" });
    assert.match(String(res.error ?? res.reason), /turn .* has ended/);
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", req.id)[0].status, "expired");
    assert.equal(webOn(h, jobId), false, "a stale rest-of-job approval did not turn the web on for the job");
    await agent.close();
  } finally {
    await h.close();
  }
});

test("approvals: a launched agent's relay server whose host goes away (stdin closed) withdraws the request it was waiting on, files none for the prompt behind it, and exits", async () => {
  // The request's own deadline is an hour away, well past any wait here: if it ends, the host
  // going away ended it (relay mcp closes its transport on stdin's end, the SDK aborts the
  // handler, permission_prompt passes the abort on; test/disconnect.test.ts has the rest).
  const h = await harness([{ match: task("IDLE"), steps: [{ reply: "idle" }] }], { approval_timeout_s: 3600 });
  const { spawn } = await import("node:child_process");
  let proc: ReturnType<typeof spawn> | undefined;
  try {
    const job = await h.call("delegate", { target: "claude", task: "IDLE", mode: "write", background: false });
    const child = await h.childOf(job.job_id, { may_ask: true, may_delegate: false });
    proc = spawn(process.execPath, [CLI, "mcp", ...child.args], { env: { ...h.env, ...child.env }, cwd: h.repo, stdio: ["pipe", "pipe", "ignore"] });
    const exited = new Promise<void>((resolve) => proc!.once("exit", () => resolve()));
    const send = (m: object) => proc!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stub-claude", version: "0" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: "permission_prompt", arguments: fetch("https://gone.example") } });
    // A second prompt of the same turn, waiting behind the first.
    send({ id: 3, method: "tools/call", params: { name: "permission_prompt", arguments: fetch("https://behind.example") } });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 10000, "the request");
    proc.stdin!.end();
    await until(() => h.sql("SELECT status FROM requests")[0].status === "expired", 5000, "the request to be withdrawn");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([exited, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the server did not exit once its host went away")), 60000)))]);
    clearTimeout(timer);
    // Withdrawn, not decided; the prompt behind it filed nothing; the turn itself goes on.
    assert.deepEqual(h.sql("SELECT status, decided_by, note FROM requests").map((r) => ({ ...r })), [{ status: "expired", decided_by: null, note: null }]);
    assert.equal(h.sql("SELECT status FROM turns WHERE id = ?", child.turnId)[0].status, "running");
  } finally {
    proc?.kill("SIGKILL");
    await h.close();
  }
});

test("events: what settles while no root session is alive reaches the session that takes the run over, with what the gone session was never given", async () => {
  const h = await harness([
    { match: task("EARLY"), steps: [{ reply: "early" }] },
    { match: task("ANCHOR"), steps: [{ reply: "anchor" }] },
    { match: task("LATE"), steps: [{ sleep: 2500 }, { reply: "late" }] },
    { match: "again", steps: [{ reply: "again" }] },
  ]);
  try {
    const first = await h.instance({ args: ["--host", "codex"] });
    const early = await first.call("delegate", { target: "claude", task: "EARLY", mode: "read" });
    const anchor = await first.call("delegate", { target: "claude", task: "ANCHOR", mode: "read" });
    const late = await first.call("delegate", { target: "claude", task: "LATE", mode: "read" });
    // The first session's server records the early job's event, but the session is never given it.
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events WHERE subject = ?", early.job_id)[0].c === 1, 10000, "the early job's event");
    const rootPid = h.sql("SELECT root_pid FROM runs WHERE id = (SELECT run_id FROM nodes WHERE id = ?)", late.job_id)[0].root_pid;
    await first.close();
    await until(() => !alive(rootPid), 5000, "the first session's relay server to exit");
    assert.notEqual(h.sql("SELECT status FROM nodes WHERE id = ?", late.job_id)[0].status, "done", "the late job settles only once no session is alive");
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", late.job_id)[0].status === "done", 15000, "the late job");

    // A new session explicitly takes over before continuing an item.
    const second = await h.instance({ args: ["--host", "codex"] });
    const recovered = await adoptRun(h, second, anchor.job_id);
    const r = await second.call("resume", { job_id: anchor.job_id, message: "again" });
    assert.equal(r.status, "queued");
    assert.deepEqual((recovered.events ?? []).map((e: { item: string }) => e.item).filter((id: string) => id !== anchor.job_id).sort(), [early.job_id, late.job_id].sort());
    const again = await second.call("status", { id: anchor.job_id, wait_s: 20 });
    assert.deepEqual((again.events ?? []).map((e: { item: string }) => e.item), [], "each given once");
  } finally {
    await h.close();
  }
});

test("events: a job whose worker dies becomes an event without anyone asking about it", async () => {
  const h = await harness([{ match: task("HANGS"), steps: [{ sleep: 60000 }, { reply: "never" }] }]);
  try {
    const session = await h.instance({ args: ["--host", "codex"] });
    const job = await session.call("delegate", { target: "claude", task: "HANGS", mode: "read" });
    await until(() => h.sql("SELECT worker_pid, agent_pid FROM nodes WHERE id = ?", job.job_id).some((n) => n.worker_pid > 0 && n.agent_pid > 0), 10000, "the job to start");
    process.kill(h.sql("SELECT worker_pid FROM nodes WHERE id = ?", job.job_id)[0].worker_pid, "SIGKILL");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events WHERE subject = ?", job.job_id)[0].c === 1, 15000, "an event for the lost job");
    assert.equal(h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status, "lost");
    // Unavailable replies do not drain events; an authorized unrelated reply carries it.
    assert.deepEqual(await session.call("result", { job_id: "j_00000000" }), UNAVAILABLE_REPLY);
    const r = await session.call("brief", { target: "claude" });
    assert.deepEqual(r.events.map((e: { item: string; notice: string }) => e.item), [job.job_id]);
    assert.match(r.events[0].notice, /finished \(lost\)/);
  } finally {
    await h.close();
  }
});

const items = (n: number) => "```json\n" + JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ n: i + 1, severity: "major", location: `a.ts:${i + 1}`, summary: `issue ${i + 1}`, evidence: "e", fix: "f" })) }) + "\n```";
const consensus = "```json\n" + JSON.stringify({ consensus: [{ ids: ["C1", "X1"], severity: "major", status: "agreed", summary: "same" }] }) + "\n```";

test("reviews: while a review is open its reviewer is reached only through the review; resuming it or borrowing it for a discussion waits until the review has ended", async () => {
  const h = await harness([
    { target: "codex", match: "independent code reviewer", steps: [{ reply: `REVIEWER-FINDING\n${items(1)}` }] },
    { target: "codex", turn: 2, steps: [{ reply: "C1 and X1 are the same.\nCONTINUE" }] },
    { target: "codex", turn: 3, steps: [{ reply: `Same.\n${consensus}\nAGREE: list above` }] },
    { target: "codex", steps: [{ reply: "later\nCONTINUE" }] },
  ]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { target: "src/a.ts" });
    const reviewer = started.reviewer_job as string;
    assert.equal((await claude.call("status", { id: reviewer, wait_s: 20 })).status, "done");
    const turns = () => h.sql("SELECT COUNT(*) AS c FROM turns WHERE node_id = ?", reviewer)[0].c;
    const tryReach = async () => {
      const resumed = await claude.call("resume", { job_id: reviewer, message: "what did you find?" });
      assert.match(resumed.reason, new RegExp(`reviewer of review ${started.review_id}, which is still open`));
      const borrowed = await claude.call("discuss", { topic: "t", message: "what did you find?\nCONTINUE", with: reviewer });
      assert.match(borrowed.reason, /reached only through the review/);
    };

    // Blind phase: nothing reaches the reviewer's session, so nothing of its result can come out.
    await tryReach();
    assert.equal(turns(), 1);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'discussion'")[0].c, 0);

    // Reconciliation: the review's own discussion is held with it; nothing else is.
    const handed = await claude.call("review", { review_id: started.review_id, own_review: `MINE\n${items(1)}` });
    assert.equal(handed.phase, "reconciling");
    await tryReach();
    assert.equal(turns(), 2);
    const closed = await claude.call("discuss", { discussion_id: handed.discussion_id, message: `Agreed.\n${consensus}\nAGREE: list above` });
    assert.equal(closed.outcome, "agree");
    assert.equal((await claude.call("result", { job_id: started.review_id })).status, "done");

    // Once the review has ended, continuing its reviewer is open as for any job.
    assert.equal((await claude.call("resume", { job_id: reviewer, message: "one more thing" })).status, "queued");
  } finally {
    await h.close();
  }
});

test("ownership: status and result refuse orphaned runs until explicit recovery (D9/C23)", async () => {
  const h = await harness([{ match: task("SLOW"), steps: [{ sleep: 60000 }, { reply: "never" }] }]);
  try {
    const owners = [] as { job: string; run: string; pid: number }[];
    for (let i = 0; i < 2; i++) {
      const first = await h.instance({ args: ["--host", "codex"] });
      const job = await first.call("delegate", { target: "claude", task: "SLOW", mode: "read" });
      const run = h.sql("SELECT run_id FROM nodes WHERE id = ?", job.job_id)[0].run_id;
      const pid = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid;
      owners.push({ job: job.job_id, run, pid });
      await first.close();
      await until(() => !alive(pid), 5000, "the first session's relay server to exit");
    }
    const second = await h.instance({ args: ["--host", "codex"] });
    const ownerOf = (run: string) => h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid as number;
    assert.deepEqual(await second.call("status", { id: owners[0].job }), UNAVAILABLE_REPLY);
    assert.deepEqual(await second.call("result", { job_id: owners[1].job }), UNAVAILABLE_REPLY);
    for (const o of owners) { assert.equal(ownerOf(o.run), o.pid); await adoptRun(h, second, o.job); }
    assert.equal((await second.call("status", { id: owners[0].job })).id, owners[0].job);
    assert.equal((await second.call("result", { job_id: owners[1].job })).id, owners[1].job);
    for (const o of owners) {
      assert.notEqual(ownerOf(o.run), o.pid);
      assert.ok(alive(ownerOf(o.run)), "the run now belongs to the live session");
    }
    // A run whose owner is alive is left alone.
    const third = await h.instance({ args: ["--host", "codex"] });
    const before = ownerOf(owners[0].run);
    await third.call("status", { id: owners[0].job });
    assert.equal(ownerOf(owners[0].run), before);
  } finally {
    await h.close();
  }
});

test("events: a late discussion reply from a borrowed root-level job is announced as the discussion's, and leaves the job's own result alone (C26)", async () => {
  const h = await harness([
    { match: task("BUILD"), steps: [{ reply: "JOB-OWN-RESULT" }] },
    { match: "slow topic", steps: [{ awaitMark: "reply" }, { reply: "late reply\nCONTINUE" }] },
  ], { block_s: 1 });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const job = await claude.call("delegate", { task: "BUILD", mode: "read", background: false });
    // block_s is deliberately short to make the discussion pending; the initial job can exceed it too.
    await until(() => !["queued", "running"].includes(nodeStatus(h, job.job_id)), 60000, "the job's own result to settle");
    assert.equal((await claude.call("status", { id: job.job_id })).result.final_message, "JOB-OWN-RESULT");
    const d = await claude.call("discuss", { topic: "slow topic", message: "go\nCONTINUE", with: job.job_id });
    assert.equal(d.pending, true, "the reply is late: the call returned before it");
    const settledEvents = () => h.sql("SELECT text FROM events WHERE subject = ? ORDER BY id", job.job_id).map((e) => e.text as string);
    const replyEvent = () => settledEvents().find((text) => text.includes(`discussion ${d.discussion_id} has a reply.`));
    h.mark("reply");
    await until(() => replyEvent() !== undefined, 60000, "the discussion reply's event");
    const text = replyEvent()!;
    assert.match(text, new RegExp(`discussion ${d.discussion_id} has a reply\\. Call status ${d.discussion_id}\\.`));
    assert.doesNotMatch(text, /finished \(done\)\. Call result/);
    const row = h.sql("SELECT result_json FROM nodes WHERE id = ?", job.job_id)[0];
    assert.equal(JSON.parse(row.result_json).final_message, "JOB-OWN-RESULT", "the job's result is still its own");
    assert.equal((await claude.call("status", { id: d.discussion_id })).reply, "late reply\nCONTINUE");
  } finally {
    await h.close();
  }
});

test("cancel: a discussion queued on a borrowed session cancels only its own queued turn, not the session's unrelated running turn (C27)", async () => {
  const h = await harness([
    { match: task("BUILD"), steps: [{ awaitMark: "free" }, { reply: "BUILT" }] },
    { match: "queued topic", steps: [{ reply: "never\nCONTINUE" }] },
  ], { block_s: 1 });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const job = await claude.call("delegate", { task: "BUILD", mode: "read" });
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "running" && h.starts().length === 1, 30000, "the job's own turn to run");
    const d = await claude.call("discuss", { topic: "queued topic", message: "hello\nCONTINUE", with: job.job_id });
    assert.equal(d.pending, true);
    const c = await claude.call("cancel", { id: d.discussion_id });
    assert.deepEqual(c.cancelled, [d.discussion_id], "only the discussion");
    const turns = () => h.sql("SELECT source, status FROM turns WHERE node_id = ? ORDER BY id", job.job_id);
    assert.deepEqual(turns().map((t) => [t.source.split(":")[0], t.status]), [["caller", "running"], ["discussion", "cancelled"]]);
    assert.equal(h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status, "running", "the job's own turn goes on");
    h.mark("free");
    const done = await claude.call("status", { id: job.job_id, wait_s: 30 });
    assert.equal(done.status, "done");
    assert.equal(done.result.final_message, "BUILT");
    assert.equal(h.starts().length, 1, "the discussion's turn never started");
  } finally {
    await h.close();
  }
});

const settledTexts = (h: Harness, id: string) => h.sql("SELECT text FROM events WHERE subject = ? ORDER BY id", id).map((e) => e.text as string);
const jobRunning = (h: Harness, id: string) => h.sql("SELECT status FROM nodes WHERE id = ?", id)[0].status === "running" && h.starts().length >= 1;

test("events: a borrowed job's own completion is announced when its newest turn row is a cancelled queued discussion turn (C9)", async () => {
  const h = await harness([
    { match: task("BUILD"), steps: [{ awaitMark: "free" }, { reply: "BUILT" }] },
    { match: "queued topic", steps: [{ reply: "never\nCONTINUE" }] },
  ], { block_s: 1 });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const job = await claude.call("delegate", { task: "BUILD", mode: "read" });
    await until(() => jobRunning(h, job.job_id), 30000, "the job's own turn to run");
    const d = await claude.call("discuss", { topic: "queued topic", message: "hello\nCONTINUE", with: job.job_id });
    assert.equal(d.pending, true);
    assert.deepEqual((await claude.call("cancel", { id: d.discussion_id })).cancelled, [d.discussion_id]);
    h.mark("free");
    await until(() => settledTexts(h, job.job_id).some((t) => t.includes(`job ${job.job_id} finished (done)`)), 30000, "the job's own completion event");
  } finally {
    await h.close();
  }
});

test("events: a borrowed job's own completion is announced as well as the discussion reply that followed it at once (C9)", async () => {
  const h = await harness([
    { match: task("BUILD"), steps: [{ awaitMark: "free" }, { reply: "BUILT" }] },
    { match: "next topic", steps: [{ reply: "my reply\nCONTINUE" }] },
  ], { block_s: 1 });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const job = await claude.call("delegate", { task: "BUILD", mode: "read" });
    await until(() => jobRunning(h, job.job_id), 30000, "the job's own turn to run");
    const d = await claude.call("discuss", { topic: "next topic", message: "hello\nCONTINUE", with: job.job_id });
    assert.equal(d.pending, true);
    h.mark("free");
    const has = (re: RegExp) => settledTexts(h, job.job_id).some((t) => re.test(t));
    await until(() => has(new RegExp(`discussion ${d.discussion_id} has a reply`)), 30000, "the discussion reply's event");
    await until(() => has(new RegExp(`job ${job.job_id} finished \\(done\\)\\. Call result ${job.job_id}\\.`)), 30000, "the job's own completion event");
    assert.equal(settledTexts(h, job.job_id).filter((t) => t.includes("finished (done)")).length, 1, "announced once");
  } finally {
    await h.close();
  }
});

test("borrowed jobs: a failed discussion turn neither sets the job's status nor drops a caller turn queued behind it (C12)", async () => {
  const h = await harness([
    { match: task("BUILD"), steps: [{ reply: "BUILT" }] },
    { match: task("SLOWBUILD"), steps: [{ awaitMark: "free" }, { reply: "SLOW BUILT" }] },
    { match: "failing topic", steps: [{ fail: "boom" }] },
    { match: "MORE-PLEASE", steps: [{ reply: "MORE DONE" }] },
  ], { block_s: 1 });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    // The job's own work is done; a discussion it is borrowed for fails afterwards.
    const job = await settledCall(claude, await claude.call("delegate", { task: "BUILD", mode: "read", background: false }));
    assert.equal(job.result.final_message, "BUILT");
    const d = await claude.call("discuss", { topic: "failing topic", message: "go\nCONTINUE", with: job.job_id });
    await until(async () => (await claude.call("status", { id: d.discussion_id })).status === "failed", 30000, "the discussion to fail");
    await until(() => !["queued", "running"].includes(h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status), 30000, "the job to settle");
    const row = h.sql("SELECT status, error, result_json FROM nodes WHERE id = ?", job.job_id)[0];
    assert.equal(row.status, "done", "the job's own outcome, not the discussion turn's");
    assert.equal(row.error, null);
    assert.equal(JSON.parse(row.result_json).final_message, "BUILT");

    // A caller turn queued behind a failing discussion turn still runs.
    const slow = await claude.call("delegate", { task: "SLOWBUILD", mode: "read" });
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", slow.job_id)[0].status === "running", 30000, "the slow job's own turn to run");
    const d2 = await claude.call("discuss", { topic: "failing topic", message: "go\nCONTINUE", with: slow.job_id });
    assert.equal(d2.pending, true);
    assert.equal((await claude.call("resume", { job_id: slow.job_id, message: "MORE-PLEASE" })).status, "queued_behind_current_turn");
    h.mark("free");
    // This harness's block_s is 1, which caps each status wait: one call can end its wait (wait_ended)
    // before the queued turn has finished, so the status is asked again until the job is done.
    let done: any = {};
    await until(async () => (done = await claude.call("status", { id: slow.job_id, wait_s: 60 })).status === "done", 60000, "the queued caller turn to finish");
    const turns = h.sql("SELECT source, status FROM turns WHERE node_id = ? ORDER BY id", slow.job_id).map((t) => [t.source.split(":")[0], t.status]);
    assert.deepEqual(turns, [["caller", "done"], ["discussion", "failed"], ["caller", "done"]]);
    assert.equal(done.status, "done");
    assert.equal(done.result.final_message, "MORE DONE");
  } finally {
    await h.close();
  }
});

for (const ownStatus of ["done", "blocked", "failed"]) {
  test(`borrowed threads: a discussion preserves the consult's own ${ownStatus} outcome and reply`, async () => {
    const h = await harness([
      { match: "BASE QUESTION", steps: ownStatus === "failed" ? [{ fail: "consult failed" }] : [
        ...(ownStatus === "blocked" ? [{ request: { web: "the spec" } }] : []), { reply: "OWN ANSWER" },
      ] },
      { match: "discussion topic", steps: ownStatus === "done" ? [{ fail: "discussion failed" }] : [{ reply: "DISCUSSION ANSWER\nCONTINUE" }] },
    ], { escalation: false });
    try {
      const q = await h.call("ask", { target: "claude", message: "BASE QUESTION" });
      await until(() => nodeStatus(h, q.thread_id) === ownStatus, 30000, "the consult to settle");
      // A row from before threads recorded their own outcome must be supported too.
      h.sql("UPDATE nodes SET params_json = json_remove(params_json, '$.own') WHERE id = ?", q.thread_id);
      const before = h.sql("SELECT error, result_json FROM nodes WHERE id = ?", q.thread_id)[0];
      const d = await h.call("discuss", { topic: "discussion topic", message: "go\nCONTINUE", with: q.thread_id });
      assert.equal(d.status, ownStatus === "done" ? "failed" : "open", JSON.stringify(d));
      await until(() => !["queued", "running"].includes(nodeStatus(h, q.thread_id)), 30000, "the borrowed thread to settle");
      const after = h.sql("SELECT status, error, result_json FROM nodes WHERE id = ?", q.thread_id)[0];
      assert.equal(after.status, ownStatus, "the consult keeps its own status, not the discussion turn's");
      assert.equal(after.error, before.error, "the consult keeps its own error");
      assert.equal(after.result_json, before.result_json, "the discussion reply belongs only to its turn");
      assert.deepEqual(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", q.thread_id)[0].params_json).own, { status: ownStatus, error: before.error });
    } finally {
      await h.close();
    }
  });
}

test("borrowed threads: a failing discussion does not cancel a consult follow-up queued behind it", async () => {
  const h = await harness([
    { match: "BASE QUESTION", steps: [{ reply: "OWN ANSWER" }] },
    { match: "held failing topic", steps: [{ mark: "discussion-started" }, { awaitMark: "fail-now" }, { fail: "discussion failed" }] },
    { match: "FOLLOW-UP", steps: [{ reply: "FOLLOW-UP ANSWER" }] },
  ], { block_s: 1 });
  try {
    const q = await h.call("ask", { target: "claude", message: "BASE QUESTION" });
    const d = await h.call("discuss", { topic: "held failing topic", message: "go\nCONTINUE", with: q.thread_id });
    assert.equal(d.pending, true);
    await until(() => h.marked("discussion-started"), 30000, "the discussion to run");
    const follow = await h.call("ask", { thread_id: q.thread_id, message: "FOLLOW-UP" });
    assert.equal(follow.pending, true);
    h.mark("fail-now");
    await until(() => !["queued", "running"].includes(nodeStatus(h, q.thread_id)), 30000, "the follow-up to settle");
    assert.deepEqual(turnsOf(h, q.thread_id), [["caller", "done"], ["discussion", "failed"], ["caller", "done"]]);
    const status = await h.call("status", { id: q.thread_id });
    assert.equal(status.status, "done");
    assert.equal(status.result.reply, "FOLLOW-UP ANSWER");
  } finally {
    await h.close();
  }
});

test("ownership: explicitly taking over a gone session's run keeps this session's own run for its new work; a session with no run yet takes it as its own (C10)", async () => {
  const h = await harness([{ match: task("SLOW"), steps: [{ awaitMark: "never" }, { reply: "never" }] }]);
  try {
    const runOf = (id: string) => h.sql("SELECT run_id FROM nodes WHERE id = ?", id)[0].run_id as string;
    const orphan = async () => {
      const first = await h.instance({ args: ["--host", "codex"] });
      const job = await first.call("delegate", { target: "claude", task: "SLOW", mode: "read" });
      const pid = h.sql("SELECT root_pid FROM runs WHERE id = ?", runOf(job.job_id))[0].root_pid;
      await first.close();
      await until(() => !alive(pid), 5000, "the first session's relay server to exit");
      return job.job_id as string;
    };
    const gone = await orphan();
    const second = await h.instance({ args: ["--host", "codex"] });
    const mine = await second.call("delegate", { target: "claude", task: "MINE", mode: "read", background: false });
    await adoptRun(h, second, gone);
    assert.equal((await second.call("status", { id: gone })).id, gone);
    assert.equal(h.sql("SELECT root_pid FROM runs WHERE id = ?", runOf(gone))[0].root_pid, h.sql("SELECT root_pid FROM runs WHERE id = ?", runOf(mine.job_id))[0].root_pid, "the gone session's run was taken over");
    const next = await second.call("delegate", { target: "claude", task: "NEXT", mode: "read", background: false });
    assert.equal(runOf(next.job_id), runOf(mine.job_id), "new work stays in this session's own run");
    assert.notEqual(runOf(next.job_id), runOf(gone));
    assert.equal((await second.call("status", {})).run_id, runOf(mine.job_id));

    const gone2 = await orphan();
    const fresh = await h.instance({ args: ["--host", "codex"] });
    await adoptRun(h, fresh, gone2);
    await fresh.call("result", { job_id: gone2 });
    const after = await fresh.call("delegate", { target: "claude", task: "AFTER", mode: "read", background: false });
    assert.equal(runOf(after.job_id), runOf(gone2), "a session with no run of its own takes the adopted one as its default");
  } finally {
    h.mark("never");
    await h.close();
  }
});

test("authority: a launched agent cannot resume what it started once that holds a rest-of-job web approval its own turn lacks (C11/X1)", async () => {
  const h = await harness([{ steps: [{ reply: "done" }] }]);
  try {
    const parent = await h.call("delegate", { target: "claude", task: "PARENT", mode: "read", background: false });
    const agent = await h.instance(await h.childOf(parent.job_id, { access: "read" }));
    let b = await agent.call("delegate", { target: "codex", task: "CHILD", mode: "read", background: false });
    while (b.status === "running" || b.status === "queued") b = { ...b, ...(await agent.call("status", { id: b.job_id, wait_s: 1 })) };
    const webForJob = (nodeId: string) => h.sql(
      "INSERT INTO requests (id, run_id, node_id, kind, summary, status, decided_by, scope, created_at, decided_at) SELECT ?, run_id, id, 'web', 'WebFetch https://x.example', 'allowed', 'user', 'job', ?, ? FROM nodes WHERE id = ?",
      `q_${Math.random().toString(16).slice(2, 10)}`, Date.now(), Date.now(), nodeId,
    );
    webForJob(b.job_id);
    const refused = await agent.call("resume", { job_id: b.job_id, message: "more" });
    assert.match(String(refused.reason), /more access than your current turn/);
    // Once the agent's own job holds the same allowance, it may.
    webForJob(parent.job_id);
    const ok = await agent.call("resume", { job_id: b.job_id, message: "more" });
    assert.equal(ok.reason, undefined, JSON.stringify(ok));
  } finally {
    await h.close();
  }
});

const nodeStatus = (h: Harness, id: string) => h.sql("SELECT status FROM nodes WHERE id = ?", id)[0].status as string;
const turnsOf = (h: Harness, id: string) => h.sql("SELECT source, status FROM turns WHERE node_id = ? ORDER BY id", id).map((t) => [String(t.source).split(":")[0], t.status]);

test("cancel: a discussion queued on a borrowed session whose own work is itself still queued (waiting for a slot) cancels only the discussion's turn (X3)", async () => {
  const h = await harness([
    { match: task("HOLD"), steps: [{ awaitMark: "free" }, { reply: "held" }] },
    { match: task("BUILD"), steps: [{ reply: "BUILT" }] },
    { match: "queued topic", steps: [{ reply: "never\nCONTINUE" }] },
  ], { block_s: 1, max_concurrent: 1 });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const hold = await claude.call("delegate", { task: "HOLD", mode: "read" });
    await until(() => nodeStatus(h, hold.job_id) === "running", 30000, "the slot to be taken");
    const job = await claude.call("delegate", { task: "BUILD", mode: "read" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM slots WHERE holder = ? AND state = 'waiting'", job.job_id)[0].c === 1, 30000, "the job to wait for a slot");
    const d = await claude.call("discuss", { topic: "queued topic", message: "hello\nCONTINUE", with: job.job_id });
    assert.equal(d.pending, true);
    const c = await claude.call("cancel", { id: d.discussion_id });
    assert.deepEqual(c.cancelled, [d.discussion_id], "only the discussion");
    assert.deepEqual(turnsOf(h, job.job_id), [["caller", "queued"], ["discussion", "cancelled"]]);
    assert.equal(nodeStatus(h, job.job_id), "queued", "the job's own work still waits for its slot");
    h.mark("free");
    // wait_s is capped by block_s: one status call need not span the queued job's completion.
    await until(() => !["queued", "running"].includes(nodeStatus(h, job.job_id)), 60000, "the job's own queued work to settle");
    const done = await claude.call("status", { id: job.job_id });
    assert.equal(done.status, "done");
    assert.equal(done.result.final_message, "BUILT");
    assert.ok(!h.starts().some((s) => String(s.prompt).includes("queued topic")), "the discussion's turn never started");
  } finally {
    await h.close();
  }
});

test("cancel: a discussion turn its borrowed session's worker has already picked up, but not yet started, is not run after the cancel; the session settles as it was (C13)", async () => {
  const h = await harness([
    { match: task("HOLD"), steps: [{ awaitMark: "free" }, { reply: "held" }] },
    { match: task("BUILD"), steps: [{ reply: "BUILT" }] },
    { match: "queued topic", steps: [{ reply: "never\nCONTINUE" }] },
  ], { block_s: 1, max_concurrent: 1 });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const job = await settledCall(claude, await claude.call("delegate", { task: "BUILD", mode: "read", background: false }));
    assert.equal(job.status, "done");
    const hold = await claude.call("delegate", { task: "HOLD", mode: "read" });
    await until(() => nodeStatus(h, hold.job_id) === "running", 30000, "the slot to be taken");
    const d = await claude.call("discuss", { topic: "queued topic", message: "hello\nCONTINUE", with: job.job_id });
    assert.equal(d.pending, true);
    // The session's worker has taken the discussion's turn and waits for a slot to run it.
    await until(() => h.sql("SELECT COUNT(*) AS c FROM slots WHERE holder = ? AND state = 'waiting'", job.job_id)[0].c === 1, 30000, "the turn to wait for a slot");
    const c = await claude.call("cancel", { id: d.discussion_id });
    assert.deepEqual(c.cancelled, [d.discussion_id], "only the discussion");
    h.mark("free");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM slots WHERE holder = ?", job.job_id)[0].c === 0 && nodeStatus(h, job.job_id) !== "queued", 30000, "the worker to let the turn go");
    await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", job.job_id)[0].worker_pid === null, 30000, "the worker to leave");
    assert.deepEqual(turnsOf(h, job.job_id), [["caller", "done"], ["discussion", "cancelled"]]);
    assert.ok(!h.starts().some((s) => String(s.prompt).includes("queued topic")), "the cancelled turn never started");
    const row = h.sql("SELECT status, error, result_json FROM nodes WHERE id = ?", job.job_id)[0];
    assert.equal(row.status, "done", "the session settles with its own outcome, neither cancelled nor stuck queued");
    assert.equal(JSON.parse(row.result_json).final_message, "BUILT");
  } finally {
    await h.close();
  }
});

test("cancel: a blocked consult borrowed for a discussion whose turn is cancelled before it runs settles blocked again, not done (review C10/X3)", async () => {
  const h = await harness([
    { match: task("HOLD"), steps: [{ awaitMark: "free" }, { reply: "held" }] },
    { match: "REFUSED QUESTION", steps: [{ request: { web: "the spec" } }, { reply: "answered without it" }] },
    { match: "queued topic", steps: [{ reply: "never\nCONTINUE" }] },
  ], { block_s: 1, max_concurrent: 1, escalation: false });
  try {
    const codex = await h.instance({ args: ["--host", "codex"] });
    const q = await settledCall(codex, await codex.call("ask", { message: "REFUSED QUESTION" }));
    assert.deepEqual(q.blocked, ["web search: the spec"]);
    assert.equal(nodeStatus(h, q.thread_id), "blocked");
    const hold = await codex.call("delegate", { task: "HOLD", mode: "read" });
    await until(() => nodeStatus(h, hold.job_id) === "running", 30000, "the slot to be taken");
    const d = await codex.call("discuss", { topic: "queued topic", message: "hello\nCONTINUE", with: q.thread_id });
    assert.equal(d.pending, true);
    await until(() => h.sql("SELECT COUNT(*) AS c FROM slots WHERE holder = ? AND state = 'waiting'", q.thread_id)[0].c === 1, 30000, "the turn to wait for a slot");
    await codex.call("cancel", { id: d.discussion_id });
    h.mark("free");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM slots WHERE holder = ?", q.thread_id)[0].c === 0 && nodeStatus(h, q.thread_id) !== "queued", 30000, "the worker to let the turn go");
    assert.deepEqual(turnsOf(h, q.thread_id), [["caller", "done"], ["discussion", "cancelled"]]);
    assert.equal(nodeStatus(h, q.thread_id), "blocked", "its latest executed turn was refused something, so it is blocked as it was");
    assert.equal((await codex.call("status", { id: q.thread_id })).status, "blocked");
  } finally {
    await h.close();
  }
});
