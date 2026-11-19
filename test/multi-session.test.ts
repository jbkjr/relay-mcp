import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationOn, harness, INTERACTIVE_CLAUDE, task, terminalAdoption, until, UNAVAILABLE_REPLY } from "./helpers.ts";

test("D9: foreign and unknown item entry points have the same unavailable response", async () => {
  // A web search: Claude's command requests are refused under the never floor before they are filed.
  const h = await harness([{ match: task("PRIVATE"), steps: [{ request: { web: "private-query" } }, { reply: "ok" }] }]);
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const b = await h.instance({ args: ["--host", "codex"] });
    const job = await a.call("delegate", { target: "claude", task: "PRIVATE", mode: "write" });
    const waiting = await a.call("status", { id: job.job_id, wait_s: 20 });
    const request = waiting.needs_approval[0].request_id;
    const run = h.sql("SELECT run_id FROM nodes WHERE id = ?", job.job_id)[0].run_id;
    const thread = await a.call("ask", { target: "claude", message: "private thread" });
    const discussion = await a.call("discuss", { target: "claude", topic: "private", message: "hello\nCONTINUE" });
    const review = await a.call("review", { reviewer: "claude", target: "README.md" });
    for (const [tool, field, id, rest] of [
      ["status", "id", job.job_id, {}], ["status", "id", run, {}],
      ["result", "job_id", job.job_id, {}], ["resume", "job_id", job.job_id, { message: "continue" }],
      ["cancel", "id", job.job_id, {}], ["cancel", "id", run, {}],
      ["merge", "job_id", job.job_id, {}],
      ["approve", "request_id", request, { decision: "allow", user_confirmed: true }],
      ["approve", "request_id", request, { decision: "deny" }],
      ["ask", "thread_id", thread.thread_id, { message: "continue" }],
      ["discuss", "discussion_id", discussion.discussion_id, { message: "continue\nCONTINUE" }],
      ["discuss", "with", job.job_id, { topic: "borrow", message: "hello\nCONTINUE" }],
      ["review", "review_id", review.review_id, { own_review: "private" }],
      ["status", "id", review.reviewer_job, {}],
    ] as const) {
      assert.ok(id, `${tool}.${field}: fixture exists`);
      const foreign = await b.call(tool, { ...rest, [field]: id });
      const unknown = await b.call(tool, { ...rest, [field]: "j_00000000" });
      assert.deepEqual(foreign, UNAVAILABLE_REPLY, `${tool}.${field}`);
      assert.deepEqual(foreign, unknown, `${tool}.${field}: no existence oracle`);
    }
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", request)[0].status, "pending");
    assert.match(h.cli("tree", run), /PRIVATE/);
  } finally { await h.close(); }
});

test("D9: owner death does not adopt; a qualified host confirmation explicitly adopts", async () => {
  const h = await harness();
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const job = await a.call("delegate", { target: "claude", task: "recover", mode: "read", background: false });
    const run = h.sql("SELECT run_id FROM nodes WHERE id = ?", job.job_id)[0].run_id;
    const owner = h.sql("SELECT * FROM runs WHERE id = ?", run)[0];
    await a.close();
    await until(() => { try { process.kill(owner.root_pid, 0); return false; } catch { return true; } });
    const b = await h.instance({ args: ["--host", "claude"], ...INTERACTIVE_CLAUDE });
    assert.deepEqual(await b.call("status", { id: job.job_id }), UNAVAILABLE_REPLY);
    assert.deepEqual(await b.call("resume", { job_id: job.job_id, message: "go" }), UNAVAILABLE_REPLY);
    assert.equal(h.sql("SELECT root_token FROM runs WHERE id = ?", run)[0].root_token, owner.root_token);
    const session = (await b.call("status")).session.fingerprint;
    const adopted = await b.call("adopt", { run_id: run, into_session: session, in_directory: h.repo, item_count: 1 });
    assert.equal(adopted.adopted, true, JSON.stringify(adopted));
    const recovered = await b.call("result", { job_id: job.job_id });
    assert.equal(recovered.status, "done");
    assert.equal(recovered.families.caller, "openai", "adoption alone is not a contribution");
    assert.equal((await b.call("resume", { job_id: job.job_id, message: "go" })).status, "queued");
    const continued = await b.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(continued.status, "done");
    assert.equal(continued.families.caller, "unknown", "a cross-family continuation accumulates its caller");
  } finally { await h.close(); }
});

test("D9: terminal adoption is explicit and bound to the destination connection", async () => {
  const h = await harness();
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const job = await a.call("delegate", { target: "claude", task: "terminal recovery", mode: "read", background: false });
    const run = h.sql("SELECT run_id FROM nodes WHERE id = ?", job.job_id)[0].run_id;
    const owner = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0];
    await a.close();
    await until(() => { try { process.kill(owner.root_pid, 0); return false; } catch { return true; } });
    const b = await h.instance({ args: ["--host", "codex"] });
    const c = await h.instance({ args: ["--host", "codex"] });
    const session = (await b.call("status")).session.fingerprint;
    assert.deepEqual(await b.call("adopt", { run_id: run, into_session: session, user_confirmed: true }), UNAVAILABLE_REPLY);
    const terminal = terminalAdoption(h, job.job_id, session);
    assert.equal(terminal.status, 0, `${terminal.stdout}\n${terminal.stderr}`);
    assert.match(terminal.stdout, /jobs, approval requests and events/);
    assert.deepEqual(await c.call("adopt", { run_id: run, into_session: (await c.call("status")).session.fingerprint }), UNAVAILABLE_REPLY);
    assert.equal((await b.call("adopt", { run_id: run, into_session: session })).adopted, true);
    assert.equal((await b.call("result", { job_id: job.job_id })).status, "done");
  } finally { await h.close(); }
});

test("D9: shared desktop stays usable per conversation token, describes both shared processes, and requires cwd but for a question", async () => {
  const h = await harness();
  try {
    for (const client of ["claude.ai", "local-agent-mode-relay-desktop"]) {
      const shared = await h.instance({ args: ["--desktop", "--host", "claude"], clientInfo: { name: client, version: "2.42304.0" }, cwd: "/" });
      const conversation = await conversationOn(shared);
      const status = await conversation.call("status");
      assert.equal(status.session.topology, "shared");
      assert.match(status.session.reason, /desktop chats share one.*Cowork.*another/);
      assert.equal(status.session.scope, "conversation-token");
      assert.match((await conversation.call("delegate", { target: "codex", task: "cwd", mode: "read" })).reason, /Pass cwd/);
      assert.ok((await conversation.call("ask", { target: "codex", message: "no project" })).thread_id, "a question needs no cwd");
      const job = await conversation.call("delegate", { target: "codex", task: "works", mode: "read", cwd: h.repo, background: false });
      assert.equal(job.status, "done");
    }
  } finally { await h.close(); }
});

test("D9: per-call snapshots redact keys, preserve labels, and reject malformed metadata before claims", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    const root = await h.instance({ args: ["--host", "codex"] });
    for (const meta of [{ threadId: {} }, { sessionId: "" }, { threadId: "x".repeat(4097) }, { "x-codex-turn-metadata": "bad" }, { threadId: "a", "x-codex-turn-metadata": { thread_id: "b" } }]) {
      const r = await root.call("ask", { target: "claude", message: "bad", request_id: "malformed" }, { meta });
      assert.equal(r.refused, true, JSON.stringify(r));
      assert.match(r.reason, /session metadata/);
      assert.equal(r.events, undefined);
    }
    const first = await root.call("ask", { target: "claude", message: "first", request_id: "good" }, { meta: { threadId: "secret-host-id", "x-codex-turn-metadata": { model: "gpt-6.1-sol" } } });
    await root.call("ask", { thread_id: first.thread_id, message: "second" }, { meta: { "x-codex-turn-metadata": { model: "qwen3-coder" } } });
    const params = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", first.thread_id)[0].params_json);
    assert.equal(params.caller_snapshots.length, 2);
    assert.deepEqual(params.caller_snapshots.map((s: any) => s.family_label), ["openai", "unknown"]);
    assert.equal(JSON.stringify(params.caller_snapshots).includes("secret-host-id"), false);
    assert.equal((await root.call("status", { id: first.thread_id })).families.caller, "unknown");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM calls WHERE request_id = 'malformed'")[0].c, 0);
  } finally { await h.close(); }
});

test("D9: a dedicated singleton revokes item access when distinct host thread stamps appear", async () => {
  const h = await harness();
  try {
    const root = await h.instance({ args: ["--host", "codex"] });
    const first = await root.call("ask", { target: "claude", message: "one" }, { meta: { threadId: "a" } });
    assert.ok(first.thread_id);
    const conflict = await root.call("status", { id: first.thread_id }, { meta: { threadId: "b" } });
    assert.equal(conflict.refused, true, JSON.stringify(conflict));
    assert.match(conflict.reason, /multiple conversations/);
    assert.equal((await root.call("result", { job_id: first.thread_id })).refused, true, "an unstamped call cannot restore the assumption");
    assert.match((await root.call("status")).session.reason, /multiple conversations/);
  } finally { await h.close(); }
});

test("D9: replay and event delivery recheck ownership without adding contributions", async () => {
  const h = await harness();
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const b = await h.instance({ args: ["--host", "codex"] });
    const args = { target: "claude", task: "replay", mode: "read", background: false, request_id: "one" };
    const job = await a.call("delegate", args);
    const repeated = await a.call("delegate", args, { meta: { "x-codex-turn-metadata": { model: "qwen3-coder" } } });
    assert.equal(repeated.job_id, job.job_id);
    assert.equal(repeated.families.caller, "openai", "retry is not a new contribution");
    assert.equal(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json).caller_snapshots.length, 1);
    const seed = await b.call("ask", { target: "claude", message: "seed" });
    const run = h.sql("SELECT run_id FROM nodes WHERE id = ?", job.job_id)[0].run_id;
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events WHERE run_id = ?", run)[0].c > 0);
    // Administrative transfer simulates revocation while an old request_id binding survives.
    h.sql("UPDATE runs SET root_token = (SELECT root_token FROM runs WHERE id = (SELECT run_id FROM nodes WHERE id = ?)) WHERE id = ?", seed.thread_id, run);
    h.sql("UPDATE events SET seen_at = NULL WHERE run_id = ?", run);
    assert.deepEqual(await a.call("delegate", args), UNAVAILABLE_REPLY);
    assert.equal((await a.call("brief", { target: "claude" })).events, undefined);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM events WHERE run_id = ? AND seen_at IS NOT NULL", run)[0].c, 0);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes")[0].c, 2);
  } finally { await h.close(); }
});

test("D9: child read allowlist is its injected run and metadata cannot widen it", async () => {
  const h = await harness();
  try {
    const a = await h.instance({ args: ["--host", "codex"] });
    const b = await h.instance({ args: ["--host", "codex"] });
    const mine = await a.call("delegate", { target: "claude", task: "mine", mode: "read", background: false });
    const foreign = await b.call("delegate", { target: "claude", task: "foreign", mode: "read", background: false });
    const child = await h.instance(await h.childOf(mine.job_id));
    assert.equal((await child.call("status", { id: mine.job_id })).id, mine.job_id);
    const meta = { threadId: "forged-root-key", "anthropic/conversationUuid": "forged" };
    assert.deepEqual(await child.call("result", { job_id: foreign.job_id }, { meta }), UNAVAILABLE_REPLY);
    assert.deepEqual(await child.call("resume", { job_id: foreign.job_id, message: "go" }, { meta }), UNAVAILABLE_REPLY);
  } finally { await h.close(); }
});

test("D9: identity is immutable and overlapping requests retain their own caller snapshot", async () => {
  const { newInstance } = await import("../dist/core/caller.js");
  const { callIdentity } = await import("../dist/core/identity.js");
  const inst = newInstance({ kind: "root" }, "/", "codex");
  inst.clientName = "codex-mcp-client";
  const meta = { threadId: "opaque-secret", "x-codex-turn-metadata": { model: "gpt-6.1-sol" } };
  const identity = callIdentity(inst, meta, "2025-11-25");
  assert.ok(Object.isFrozen(identity));
  assert.ok(Object.isFrozen(identity.snapshot.session.evidence));
  assert.ok(Object.isFrozen(identity.contribution));
  assert.equal(JSON.stringify(identity).includes("opaque-secret"), false);
  meta["x-codex-turn-metadata"].model = "changed";
  assert.equal(identity.snapshot.model, "gpt-6.1-sol");

  const h = await harness();
  try {
    const root = await h.instance({ args: ["--host", "codex"] });
    const replies = await Promise.all(["gpt-6.1-sol", "qwen3-coder"].map((model) => root.call("ask", { target: "claude", message: model }, { meta: { "x-codex-turn-metadata": { model } } })));
    assert.deepEqual(replies.map((r) => r.families.caller), ["openai", "unknown"]);
    const snapshots = replies.map((r) => JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", r.thread_id)[0].params_json).caller_snapshots[0]);
    assert.deepEqual(snapshots.map((s) => s.model), ["gpt-6.1-sol", "qwen3-coder"]);
    assert.notEqual(snapshots[0].call_id, snapshots[1].call_id);
  } finally { await h.close(); }
});
