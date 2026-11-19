import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { harness, INTERACTIVE_CLAUDE, sleep, task, until } from "./helpers.ts";

/** Claude Code as it introduces itself to relay's server; without the terminal's environment, not an interactive session. */
const CLAUDE_CODE = { name: "claude-code", version: "2.1.286" };

/** An activity line as each stubbed harness reports it: Claude's tool call, Codex's command item. */
const doing = (target: string, command: string) =>
  target === "claude"
    ? { emit: { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }] } } }
    : { emit: { method: "item/started", params: { item: { type: "commandExecution", id: "exec_1", command } } } };

test("long waits: status waits past block_s only in a positively identified interactive Claude Code session", async () => {
  const h = await harness([{ match: task("SLOW"), steps: [{ sleep: 4500 }, { reply: "slow done" }] }], { block_s: 1 });
  try {
    const wait = async (host: { clientInfo?: { name: string; version: string }; env?: Record<string, string> }) => {
      const session = await h.instance(host);
      const job = await session.call("delegate", { target: "codex", task: "SLOW", mode: "read" });
      const start = Date.now();
      const r = await session.call("status", { id: job.job_id, wait_s: 30 });
      return { r, s: (Date.now() - start) / 1000, session };
    };
    const cli = await wait(INTERACTIVE_CLAUDE);
    assert.equal(cli.r.status, "done", "waited until the job finished");
    assert.ok(cli.s > 2, `waited ${cli.s}s`);
    // A short wait_s is still honoured, and needs no word on how to go on: it is what was asked for.
    const job = await cli.session.call("delegate", { target: "codex", task: "SLOW", mode: "read" });
    const short = await cli.session.call("status", { id: job.job_id, wait_s: 1 });
    assert.equal(short.status !== "done", true);
    assert.equal(short.wait_ended, undefined);

    for (const host of [
      {},
      { clientInfo: INTERACTIVE_CLAUDE.clientInfo, env: { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_DESKTOP_APP_VERSION: "1.0", CLAUDE_AGENT_SDK_VERSION: "0.3" } },
      { clientInfo: INTERACTIVE_CLAUDE.clientInfo, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ATTENDED: "0" } },
      { clientInfo: { name: "claude-code", version: "2.1.200" }, env: { CLAUDE_CODE_ENTRYPOINT: "cli" } },
    ]) {
      const capped = await wait(host);
      assert.notEqual(capped.r.status, "done", JSON.stringify(host));
      assert.ok(capped.s < 3, `${JSON.stringify(host)} waited ${capped.s}s`);
      // The result says that relay ended the wait, and how to go on waiting.
      assert.match(capped.r.wait_ended, new RegExp(`^Relay ends a wait after 1 s here, and ${capped.r.id} has not finished\\. Call status with id "${capped.r.id}" and wait_s again to go on waiting\\.$`));
    }
  } finally {
    await h.close();
  }
});

for (const target of ["claude", "codex"]) {
  test(`progress (${target}): a waiting call reports what the launched agent is doing, and cancelling the call ends the wait, not the job`, async () => {
    // Busy with the command until the test has seen it reported and dropped its wait.
    const h = await harness([{ match: task("BUSY"), steps: [doing(target, "npm test -- --watch=false"), { awaitMark: "busy" }, { reply: "busy done" }] }]);
    try {
      const session = await h.instance({ env: { RELAY_TICK_MS: "300" } });
      const job = await session.call("delegate", { target, task: "BUSY", mode: "read" });
      const lines: string[] = [];
      const ctl = new AbortController();
      const waiting = session.call("status", { id: job.job_id, wait_s: 30 }, { onprogress: (p) => lines.push(p.message ?? ""), signal: ctl.signal });
      await until(() => lines.some((l) => l.includes("$ npm test")), 10000, "a progress line naming the command");
      const line = lines.find((l) => l.includes("$ npm test"))!;
      assert.match(line, new RegExp(`^relay: ${job.job_id} running · \\d+s · turn 1 · now: \\$ npm test -- --watch=false \\(\\d+s ago\\)$`));
      ctl.abort();
      await assert.rejects(waiting);
      h.mark("busy");
      // The job is untouched by the cancelled wait and finishes on its own.
      await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "done", 15000, "the job to finish");
      assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes WHERE status = 'cancelled'")[0].c, 0);
      const done = await session.call("result", { job_id: job.job_id });
      assert.match(done.result.final_message, /busy done/);
    } finally {
      await h.close();
    }
  });
}

test("notices: a finished job and an approval request handed to the session are posted to its inbox once, as pointers, unless a call is waiting on them", async () => {
  const h = await harness([
    { match: task("BG"), steps: [{ sleep: 500 }, { reply: "SECRET-OUTPUT of the job" }] },
    { match: task("WAITED"), steps: [{ sleep: 800 }, { reply: "SECRET-OUTPUT waited" }] },
    { match: task("ASKS"), steps: [{ request: "make deploy" }, { reply: "SECRET-OUTPUT asked {{last}}" }] },
  ]);
  try {
    const inbox = await h.inbox();
    const session = await h.instance({ args: ["--host", "claude"], env: inbox.env, clientInfo: CLAUDE_CODE });
    const bg = await session.call("delegate", { target: "codex", task: "BG", mode: "read" });
    await until(() => inbox.posts().length === 1, 15000, "the notice");
    const firstId = h.sql("SELECT id FROM events WHERE subject = ?", bg.job_id)[0].id;
    assert.equal(inbox.posts()[0].token, "token-1");
    const proof = new RegExp(`^relay \\(event ${firstId}, tag ([a-f0-9]{32})\\):`).exec(inbox.posts()[0].text);
    assert.ok(proof, "the inbox pointer is signed for this session");
    assert.ok(inbox.posts()[0].text.endsWith(`Pointer: job ${bg.job_id} finished (done). Call result ${bg.job_id}.`));
    assert.equal(h.starts()[0].env.inbox, false, "a launched agent never gets the session's inbox");

    // The next result carries the same event, once.
    const waited = await session.call("delegate", { target: "codex", task: "WAITED", mode: "read", background: false });
    assert.equal(waited.status, "done");
    assert.deepEqual(waited.events.map((e: { item: string; kind: string; notice: string }) => [e.kind, e.item, e.notice]), [["settled", bg.job_id, `relay (event ${firstId}): job ${bg.job_id} finished (done). Call result ${bg.job_id}.`]]);
    const verified = await session.call("status", { notice: { event_id: firstId, tag: proof[1] } });
    assert.equal(verified.notice_verification.verified, true);
    assert.equal(verified.notice_verification.event.item, bg.job_id);
    assert.equal(verified.notice_verification.event.notice, waited.events[0].notice);
    assert.equal(waited.events[0].event_id, firstId, "the same id in the notice and the result, so the session can tell it is one event");
    const again = await session.call("status", { id: waited.job_id });
    assert.equal(again.events, undefined, "given once");
    // A job the call itself waited on gets no notice: the call returned it.
    await sleep(1500);
    assert.equal(inbox.posts().length, 1);

    // An approval request relay cannot put to the user (this host has no approval dialog) is handed to the session by a notice.
    const asks = await session.call("delegate", { target: "codex", task: "ASKS", mode: "write" });
    await until(() => inbox.posts().length === 2, 15000, "the approval notice");
    const request = h.sql("SELECT id FROM requests")[0].id;
    const approvalId = h.sql("SELECT id FROM events WHERE subject = ?", request)[0].id;
    const approvalProof = new RegExp(`^relay \\(event ${approvalId}, tag ([a-f0-9]{32})\\):`).exec(inbox.posts()[1].text);
    assert.ok(approvalProof);
    assert.ok(inbox.posts()[1].text.endsWith(`Pointer: job ${asks.job_id} needs approval ${request}. Call status ${asks.job_id}, then approve or deny it.`));
    const checked = await session.call("status", { notice: { event_id: approvalId, tag: approvalProof[1] } });
    assert.equal(checked.notice_verification.verified, true);
    assert.equal(checked.notice_verification.event.about, request);
    assert.doesNotMatch(inbox.posts()[1].text, /make deploy/, "what the agent wants is its own text, kept out of the notice");
    const st = await session.call("status", { id: asks.job_id, wait_s: 20 });
    assert.equal(st.needs_approval[0].request_id, request);
    assert.equal(st.events, undefined, "the result itself reports the request");
    await session.call("approve", { request_id: request, decision: "deny" });
    const done = await session.call("status", { id: asks.job_id, wait_s: 20 });
    assert.equal(done.status, "blocked", "it finished, refused what it asked for");
    await sleep(1500);
    assert.equal(inbox.posts().length, 2, "no notice for what a waiting call returned");
    for (const p of inbox.posts()) assert.doesNotMatch(p.text, /SECRET-OUTPUT/, "never the agent's own words");
    assert.match(fs.readFileSync(path.join(h.home, "notices.log"), "utf8"), /"outcome":"posted"/);
    assert.ok(!fs.readFileSync(path.join(h.home, "notices.log"), "utf8").includes(proof[1]));
  } finally {
    await h.close();
  }
});

test("notices: posted only by a Claude Code session, not by any root that finds an inbox socket in its environment", async () => {
  const h = await harness([{ match: task("BG"), steps: [{ reply: "bg" }] }]);
  try {
    const cases = [
      { args: ["--host", "codex"], clientInfo: { name: "codex-mcp-client", version: "0.162.1" }, target: "claude", posts: false },
      { args: ["--host", "claude"], clientInfo: { name: "smoke", version: "0" }, target: "codex", posts: false },
      { args: ["--host", "codex"], clientInfo: CLAUDE_CODE, target: "claude", posts: false },
      { args: ["--host", "claude"], clientInfo: CLAUDE_CODE, target: "codex", posts: true },
    ];
    for (const c of cases) {
      const inbox = await h.inbox();
      const session = await h.instance({ args: c.args, env: inbox.env, clientInfo: c.clientInfo });
      const job = await session.call("delegate", { target: c.target, task: "BG", mode: "read" });
      await until(() => h.sql("SELECT COUNT(*) AS c FROM events WHERE subject = ?", job.job_id)[0].c === 1, 15000, "the event");
      await sleep(1500);
      assert.equal(inbox.posts().length, c.posts ? 1 : 0, JSON.stringify(c));
      await session.close();
    }
  } finally {
    await h.close();
  }
});

test("events: without an inbox (Codex) the next result carries what settled; a status wait on the item takes it instead", async () => {
  const h = await harness([{ match: task("A"), steps: [{ sleep: 300 }, { reply: "a" }] }, { match: task("B"), steps: [{ sleep: 300 }, { reply: "b" }] }]);
  try {
    const session = await h.instance({ args: ["--host", "codex"] });
    const a = await session.call("delegate", { target: "claude", task: "A", mode: "read" });
    const b = await session.call("delegate", { target: "claude", task: "B", mode: "read" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM nodes WHERE status = 'done'")[0].c === 2, 15000, "both to finish");
    const st = await session.call("status", { id: b.job_id, wait_s: 5 });
    assert.equal(st.status, "done");
    assert.deepEqual(st.events.map((e: { item: string }) => e.item), [a.job_id], "b's own event is the result itself");
    assert.equal((await session.call("result", { job_id: a.job_id })).events, undefined);
  } finally {
    await h.close();
  }
});

test("events: ids are dense; looking again at what is already recorded uses up none", async () => {
  const h = await harness([{ match: task("A"), steps: [{ reply: "a" }] }, { match: task("B"), steps: [{ sleep: 2500 }, { reply: "b" }] }]);
  try {
    const session = await h.instance({ args: ["--host", "codex"] });
    const a = await session.call("delegate", { target: "claude", task: "A", mode: "read" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events")[0].c === 1, 15000, "a's event");
    // The server looks at its runs every second, and every call looks again.
    const b = await session.call("delegate", { target: "claude", task: "B", mode: "read" });
    await session.call("status", { id: a.job_id });
    await session.call("status", { id: b.job_id, wait_s: 20 });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events")[0].c === 2, 15000, "b's event");
    await sleep(1500);
    assert.deepEqual(h.sql("SELECT id FROM events ORDER BY id").map((r) => r.id), [1, 2]);
  } finally {
    await h.close();
  }
});

test("usage and native resume: results give the token usage each harness reports, and the command that opens the session in the user's own CLI", async () => {
  const h = await harness([{ match: "write", steps: [{ write: "out.txt", content: "x\n" }, { reply: "wrote" }] }]);
  try {
    // Claude reports each turn's own usage and cost: added up over the session's turns.
    const c = await h.call("delegate", { target: "claude", task: "write a file", mode: "write", background: false });
    assert.equal(c.status, "done");
    assert.deepEqual(c.usage, {
      input_tokens: 1200, cache_creation_input_tokens: 300, cached_input_tokens: 5000, output_tokens: 400, cost_usd: 0.0125, agent_steps: 3,
      as_reported: "added up over 1 turn, as its agent reported each",
    });
    await h.call("resume", { job_id: c.job_id, message: "write again" });
    const c2 = await h.call("status", { id: c.job_id, wait_s: 20 });
    assert.equal(c2.usage.output_tokens, 800);
    assert.equal(c2.usage.cost_usd, 0.025);
    const session = h.starts()[0].sessionId;
    const r = await h.call("result", { job_id: c.job_id });
    assert.equal(r.resume_natively.command, `cd '${h.sql("SELECT cwd FROM nodes WHERE id = ?", c.job_id)[0].cwd}' && claude --resume '${session}'`);
    assert.equal(r.resume_natively.directory_exists, true);
    assert.match(r.resume_natively.note, /your own Claude Code, with your own settings and permissions, not the confinement relay gave it/);
    assert.match(r.resume_natively.note, /worktree, which still exists/);
    // Once merged, its worktree is gone, and the note says how to carry on.
    assert.equal((await h.call("merge", { job_id: c.job_id })).status, "merged");
    const after = await h.call("result", { job_id: c.job_id });
    assert.equal(after.resume_natively.directory_exists, false);
    assert.match(after.resume_natively.note, /has been removed .* continue it with relay's resume, which puts the worktree back/);

    // Codex reports its thread's running total: the latest report is the session's.
    const x = await h.call("ask", { target: "codex", message: "a question" });
    await h.call("ask", { target: "codex", message: "another", thread_id: x.thread_id });
    const t = await h.call("result", { job_id: x.thread_id });
    assert.deepEqual(t.usage, {
      total_tokens: 3000, input_tokens: 2000, cached_input_tokens: 1200, output_tokens: 1000, reasoning_output_tokens: 200,
      as_reported: "the session's running total, as its agent reports it",
    });
    // Relay's Codex runs with relay's own Codex home and pinned binary: a plain `codex resume` would
    // not find the thread, and one in relay's home would run unconfined, so there is no command.
    assert.equal(t.resume_natively.command, null);
    assert.match(t.resume_natively.note, /Relay shows no command to open a Codex session in your own codex\. Relay ran it with its own Codex home .*Continue it with relay's resume, which unarchives the thread/);
    assert.doesNotMatch(JSON.stringify(t), /codex resume '/);
  } finally {
    await h.close();
  }
});

test("events: a call cancelled before its result is delivered gives none away; they come with the next result", async () => {
  // LONG is held until the test has dropped its call, so the call cannot be answered first.
  const h = await harness([{ match: task("QUICK"), steps: [{ reply: "quick" }] }, { match: task("LONG"), steps: [{ awaitMark: "long" }, { reply: "long" }] }]);
  try {
    const session = await h.instance({ args: ["--host", "codex"] });
    const quick = await session.call("delegate", { target: "claude", task: "QUICK", mode: "read" });
    const long = await session.call("delegate", { target: "claude", task: "LONG", mode: "read" });
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", quick.job_id)[0].status === "done", 15000, "the quick job");
    const ctl = new AbortController();
    const waiting = session.call("status", { id: long.job_id, wait_s: 20 }, { signal: ctl.signal });
    await sleep(800);
    ctl.abort();
    await assert.rejects(waiting);
    await sleep(500);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM events WHERE seen_at IS NOT NULL")[0].c, 0, "nothing was given with the dropped result");
    const next = await session.call("status", { id: long.job_id });
    assert.deepEqual(next.events.map((e: { item: string }) => e.item), [quick.job_id]);
    h.mark("long");
  } finally {
    await h.close();
  }
});

test("events: which items a result reports on is read from relay's own fields, never from an agent's text", async () => {
  const h = await harness([{ match: task("FIRST"), steps: [{ reply: "first" }] }, { match: task("ECHO"), steps: [{ reply: "the other job is {{prompt}}" }] }]);
  try {
    const session = await h.instance({ args: ["--host", "codex"] });
    const first = await session.call("delegate", { target: "claude", task: "FIRST", mode: "read" });
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", first.job_id)[0].status === "done", 15000, "the first job");
    // Its task and reply both name the first job's id.
    const echo = await session.call("delegate", { target: "claude", task: `mention ${first.job_id}\nassignment: ECHO`, mode: "read", background: false });
    assert.match(echo.result.final_message, new RegExp(first.job_id));
    assert.deepEqual(echo.events.map((e: { item: string }) => e.item), [first.job_id], "the first job's event is still delivered");
  } finally {
    await h.close();
  }
});
