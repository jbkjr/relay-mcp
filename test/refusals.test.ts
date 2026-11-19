import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { harness, task, until, type Rec } from "./helpers.ts";
import { anthropicRefusal, openaiRefusal } from "../dist/core/refusal.js";

const fixture = (name: string): any => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/refusals", `${name}.json`), "utf8"));
const app = fixture("openai-app-cyberPolicy");
const message = app[0].params.error.message;
const stopped = (events: Rec[]) => [...events.map((emit) => ({ emit })), { awaitMark: "never-retry" }];
const runners = [
  { name: "exec Sol", target: "codex", config: { codex_backend: "exec" }, events: fixture("openai-gpt-6.1-sol-xhigh") },
  { name: "exec Astra", target: "codex", config: { codex_backend: "exec" }, events: fixture("openai-gpt-6-astra-max") },
  { name: "app notification", target: "codex", config: {}, events: app },
  { name: "app terminal turn", target: "codex", config: {}, events: app.slice(1) },
  { name: "Claude source-derived result (not live-observed)", target: "claude", config: {}, events: [fixture("claude-source-result")] },
];

test("refusal fixtures: observed OpenAI exec and app-server signatures agree; capacity is distinct", () => {
  for (const name of ["openai-gpt-6.1-sol-xhigh", "openai-gpt-6-astra-max"]) {
    for (const e of fixture(name)) assert.deepEqual(openaiRefusal(e.error ?? { message: e.message }), { vendor: "openai", code: "cyberPolicy", message });
  }
  for (const e of app) assert.deepEqual(openaiRefusal(e.params.error ?? e.params.turn.error), { vendor: "openai", code: "cyberPolicy", message });
  for (const e of fixture("openai-app-capacity")) assert.equal(openaiRefusal(e.params.error ?? e.params.turn.error), undefined);
  for (const e of fixture("openai-review-capacity")) assert.equal(openaiRefusal(e.params.error ?? e.params.turn.error), undefined);
  for (const e of [{ message: "unauthorized" }, { message: "connection closed" }, { message: "an agent discusses a safety classifier" }, { message, codexErrorInfo: "serverOverloaded" }]) assert.equal(openaiRefusal(e), undefined);
});

test("refusal fixtures: Claude source-derived result and assistant require an explicit stop reason", () => {
  assert.deepEqual(anthropicRefusal(fixture("claude-source-result")), { vendor: "anthropic", code: "refusal", message: "fixture refusal message" });
  const assistant = { type: "assistant", message: { stop_reason: "refusal", content: [{ type: "text", text: "verbatim" }, { type: "tool_use", name: "Bash", input: {} }] } };
  assert.deepEqual(anthropicRefusal(assistant), { vendor: "anthropic", code: "refusal", message: "verbatim" });
  for (const e of [{ type: "result", is_error: true, errors: ["capacity"] }, { type: "result", stop_reason: "end_turn", result: "refusal" }, { type: "assistant", message: { content: [{ type: "text", text: "refusal" }] } }]) assert.equal(anthropicRefusal(e), undefined);
});

for (const r of runners) test(`vendor refusal: ${r.name} is terminal, retained, reported, and resumes only on request`, async () => {
  const h = await harness([
    { target: r.target, turn: 1, steps: [{ write: "unfinished.txt", content: "work before the stop\n" }, ...stopped(r.events)] },
    { target: r.target, turn: 2, steps: [{ reply: "continued explicitly" }] },
  ], r.config);
  try {
    const j = await h.call("delegate", { target: r.target, task: "original request", mode: "write", background: false });
    assert.equal(j.status, "refused", JSON.stringify(j));
    assert.equal(j.outcome, "refused");
    assert.equal(j.result.unfinished, true);
    assert.equal(j.result.refusal.message, r.target === "claude" ? "fixture refusal message" : message);
    assert.match(j.error, /Stopped by (OpenAI|Anthropic)'s safety system/);
    assert.match(j.result.note, /neither retried nor rephrased/);
    assert.equal(j.result.no_changes, undefined);
    assert.ok(j.result.files_changed_git.includes("unfinished.txt"));
    const row = h.sql("SELECT * FROM nodes WHERE id = ?", j.job_id)[0];
    assert.ok(fs.existsSync(row.worktree));
    assert.equal(fs.readFileSync(path.join(row.worktree, "unfinished.txt"), "utf8"), "work before the stop\n");
    assert.equal(j.branch, row.branch);
    assert.equal(h.cli("tree").includes("refused"), true);
    const t = h.sql("SELECT status, refusal_json FROM turns WHERE node_id = ?", j.job_id)[0];
    assert.equal(t.status, "refused");
    assert.deepEqual(JSON.parse(t.refusal_json), j.result.refusal);
    const view = await h.call("status", { id: j.job_id });
    assert.equal(view.status, "refused");
    assert.deepEqual((await h.call("result", { job_id: j.job_id })).result.refusal, j.result.refusal);
    assert.equal(h.starts().length, 1, "no automatic retry, rephrasing, model switch or fallback");
    assert.ok(h.starts()[0].prompt.endsWith("original request"));
    // Relay's original branch remains at its original tip: no auto-merge.
    assert.notEqual(row.head_sha, row.base_sha);
    if (r.target === "claude") {
      assert.equal(h.starts()[0].settings.env.CLAUDE_CODE_DISABLE_REFUSAL_RETRY, "1");
      assert.equal(h.starts()[0].settings.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK, "1");
    }
    await h.call("resume", { job_id: j.job_id, message: "continue explicitly" });
    const after = await h.call("status", { id: j.job_id, wait_s: 30 });
    assert.equal(after.status, "done", JSON.stringify(after));
    assert.equal(after.result.refusal, undefined);
    assert.equal(h.starts().length, 2);
    assert.equal(h.starts()[1].resumed, true);
  } finally { await h.close(); }
});

test("vendor refusal: real capacity errors, authentication, crashes and quoted prose stay separate", async () => {
  const capacity = fixture("openai-app-capacity");
  assert.equal(openaiRefusal(capacity[0].params.error), undefined);
  for (const e of [{ message: "unauthorized" }, { message: "connection closed" }, { message: "agent discusses a safety classifier" }, { message, codexErrorInfo: "serverOverloaded" }]) assert.equal(openaiRefusal(e), undefined);
  const h = await harness([{ target: "codex", steps: stopped(capacity) }]);
  try {
    const j = await h.call("delegate", { target: "codex", task: "capacity", mode: "read", background: false });
    assert.equal(j.status, "failed");
    assert.equal(j.result.refusal, undefined);
    assert.match(j.error, /Selected model is at capacity/);
  } finally { await h.close(); }
});

for (const r of [runners[0], runners[2], runners[4]]) test(`vendor refusal: ${r.name} consult and discussion settle without a completed reply`, async () => {
  const h = await harness([{ target: r.target, turn: 1, steps: stopped(r.events) }, { target: r.target, turn: 2, steps: [{ reply: "explicit followup" }] }], r.config);
  try {
    const a = await h.call("ask", { target: r.target, message: "question" });
    assert.equal(a.status, "refused", JSON.stringify(a));
    assert.equal(a.outcome, "refused");
    assert.ok(a.refusal.message);
    assert.equal((await h.call("status", { id: a.thread_id })).status, "refused");
    const followup = await h.call("ask", { target: r.target, thread_id: a.thread_id, message: "explicit followup" });
    assert.equal(followup.reply, "explicit followup", JSON.stringify(followup));
    assert.equal((await h.call("status", { id: a.thread_id })).status, "done");
    const d = await h.call("discuss", { target: r.target, topic: "topic", message: "opening\nCONTINUE" });
    assert.equal(d.status, "refused", JSON.stringify(d));
    assert.equal(d.outcome, "refused");
    assert.equal(d.reply, undefined);
    assert.match(d.note, /neither retried nor rephrased/);
    assert.equal((await h.call("result", { job_id: d.discussion_id })).outcome, "refused");
    assert.equal(h.starts().length, 3);
  } finally { await h.close(); }
});

const own = (items: Rec[] = []) => "```json\n" + JSON.stringify({ verdict: items.length ? "fail" : "pass", coverage: { complete: true }, items }) + "\n```";
const finding = { id: "C1", severity: "major", summary: "my finding", location: "a.ts:1", evidence: "evidence", fix: "fix" };

for (const timing of ["pending", "late", "skip"] as const) test(`vendor refusal: review settles and preserves ${timing} own_review exactly once`, async () => {
  const h = await harness([{ target: "codex", steps: [{ awaitMark: "release-refusal" }, ...stopped(app)] }]);
  try {
    const started = await h.call("review", { target: "HEAD", reviewer: "codex" });
    let out: Rec;
    if (timing === "pending") {
      const pending = h.call("review", { review_id: started.review_id, own_review: own([finding]) });
      await until(() => JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", started.review_id)[0].params_json).submission_tried, 10000, "own review waiting in memory");
      assert.equal(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", started.review_id)[0].params_json).own, false);
      h.mark("release-refusal");
      out = await pending;
    } else {
      h.mark("release-refusal");
      const settled = await h.call("status", { id: started.review_id, wait_s: 30 });
      assert.equal(settled.status, "refused", JSON.stringify(settled));
      assert.equal(settled.verdict, "unknown");
      out = await h.call("review", { review_id: started.review_id, ...(timing === "skip" ? { skip_own: true } : { own_review: own() }) });
    }
    assert.equal(out.status, "refused", JSON.stringify(out));
    assert.equal(out.outcome, "refused");
    assert.equal(out.refusal.message, message);
    assert.equal(out.verdict, "unknown");
    assert.match(out.note, /produced no completed review/);
    assert.match(out.note, /neither retried nor rephrased/);
    assert.equal(out.discussion_id, undefined);
    if (timing !== "skip") {
      assert.equal(out.sides.claude.items, timing === "pending" ? 1 : 0);
      assert.equal(out.sides.claude.declared_verdict, timing === "pending" ? "fail" : "pass");
      assert.ok(out.reviews.claude);
    }
    const again = await h.call("review", { review_id: started.review_id, own_review: own([finding]) });
    assert.ok(again.submission_note);
    assert.equal(again.sides.claude?.items, out.sides.claude?.items);
    assert.equal(h.starts().length, 1);
  } finally { await h.close(); }
});

for (const safety of [true, false]) test(`vendor refusal: review reconciliation distinguishes ${safety ? "refusal" : "real capacity failure"}, with original reviews preserved`, async () => {
  const h = await harness([
    { target: "codex", turn: 1, steps: [{ reply: own() }] },
    { target: "codex", turn: 2, steps: stopped(safety ? app : fixture("openai-review-capacity")) },
  ]);
  try {
    const start = await h.call("review", { target: "HEAD", reviewer: "codex" });
    const end = await h.call("review", { review_id: start.review_id, own_review: own() });
    assert.equal(end.status, safety ? "refused" : "failed", JSON.stringify(end));
    assert.equal(end.outcome, safety ? "refused" : "error");
    if (safety) assert.equal(end.refusal.message, message);
    else assert.equal(end.refusal, undefined);
    assert.ok(end.reviews.claude && end.reviews.codex);
    assert.notEqual(end.verdict, "pass");
    assert.equal(h.starts().length, 2);
  } finally { await h.close(); }
});
