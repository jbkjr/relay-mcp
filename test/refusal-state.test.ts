// Registry-level settlement checks: no subprocesses, sockets or /Users/Shared harness required.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
// Loaded for the scratch HOME every test file runs with (test guard); no harness is started.
import "./helpers.ts";
import { newInstance } from "../dist/core/caller.js";
import { runDir, withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun, db, getNode, getTurn, insertNode, insertTurn, nodeTurns, updateNode, updateTurn } from "../dist/core/db.js";
import { recordEvents } from "../dist/core/events.js";
import { finishTurn, settleIdle } from "../dist/core/outcome.js";
import { openaiRefusal, refusalError } from "../dist/core/refusal.js";
import { review, reviewView } from "../dist/modes/review.js";
import { discussionView, settleDiscussion } from "../dist/modes/discussion.js";
import { nodeView } from "../dist/core/views.js";

const events = JSON.parse(fs.readFileSync(new URL("./fixtures/refusals/openai-app-cyberPolicy.json", import.meta.url), "utf8"));
const refusal = openaiRefusal(events[0].params.error)!;
const outcome = { status: "refused" as const, refusal, error: refusalError(refusal), finalMessage: "partial work", exitCode: 1, warnings: [], finalPath: null };
const own = "```json\n" + JSON.stringify({ verdict: "pass", coverage: { complete: true }, items: [] }) + "\n```";

function snapshot(name: string, value: unknown) {
  const file = path.join(import.meta.dirname, "fixtures/stable-surfaces", name);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (process.env.RELAY_UPDATE_SNAPSHOTS === "1") fs.writeFileSync(file, text);
  assert.equal(text, fs.readFileSync(file, "utf8"));
}

async function scratch(fn: (s: { inst: ReturnType<typeof newInstance>; run: string; tmp: string }) => Promise<void> | void) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "refusal-")));
  const previous = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  try {
    process.env.RELAY_HOME = path.join(tmp, "state");
    process.env.RELAY_CONFIG = path.join(tmp, "config.json");
    fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ allow_temp_home: true }));
    const inst = newInstance({ kind: "root" }, tmp, "claude");
    const run = createRun(tmp, withDefaults({ allow_temp_home: true }), inst.token);
    inst.runId = run;
    await fn({ inst, run, tmp });
  } finally {
    closeDbForTests();
    for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("refusal state: item outcome, status, events and idle restoration remain distinct from failure", async () => scratch(({ run, tmp }) => {
  const job = insertNode({ id: "j_refusal", run_id: run, kind: "job", target: "codex", mode: "read", depth: 1, task: "fixture", cwd: tmp });
  const turn = insertTurn(job.id, "delegate", "prompt", "read");
  updateTurn(turn, { status: "refused", error: outcome.error, refusal_json: JSON.stringify(refusal), ended_at: 1 });
  const queued = insertTurn(job.id, "resume", "queued before the stop", "read");
  finishTurn(job, getTurn(turn)!, outcome, withDefaults({}));
  assert.equal(getNode(job.id)!.status, "refused");
  assert.equal(getTurn(queued)!.status, "cancelled", "does not automatically run a queued followup after a safety stop");
  const view = nodeView(getNode(job.id)!);
  assert.equal(view.outcome, "refused");
  assert.deepEqual(view.refusal, refusal);
  assert.deepEqual((view.result as any).refusal, refusal);
  snapshot("refusal-item.json", { status: view.status, outcome: view.outcome, refusal: view.refusal, unfinished: view.unfinished, outcome_note: view.outcome_note, result: view.result });
  recordEvents(new Map([[run, 0]]), () => false);
  const event = db().prepare("SELECT * FROM events WHERE subject = ?").get(job.id) as any;
  assert.match(event.text, /finished \(refused\)/);
  assert.ok(event.key.endsWith(`turn:${turn}`));
  // A cancelled borrowed turn may requeue the job without running; recover its own refusal.
  updateNode(job.id, { status: "queued" });
  settleIdle(job.id);
  assert.equal(getNode(job.id)!.status, "refused");
}));

test("refusal state: refusal metadata preserves denials, process warnings, usage and speed", async () => scratch(({ run, tmp }) => {
  const job = insertNode({ id: "j_refusal_details", run_id: run, kind: "job", target: "codex", mode: "read", depth: 1, task: "fixture", cwd: tmp, params_json: JSON.stringify({ speed: "fast" }) });
  const t = insertTurn(job.id, "delegate", "prompt", "read");
  const warnings = ["A process the agent started may still be running."];
  const denials = ["$ denied-command"];
  updateTurn(t, { status: "refused", refusal_json: JSON.stringify(refusal), usage_json: JSON.stringify({ input_tokens: 100, output_tokens: 10 }) });
  const details = { ...outcome, warnings, denials };
  finishTurn(job, getTurn(t)!, details, withDefaults({}));
  const view = nodeView(getNode(job.id)!);
  assert.equal(view.outcome, "refused");
  assert.deepEqual(view.refusal, refusal);
  assert.deepEqual(view.blocked, denials);
  assert.deepEqual((view.result as any).warnings, warnings);
  assert.deepEqual((view.result as any).blocked, denials);
  assert.equal((view.usage as any).input_tokens, 100);
  assert.equal((view.speed as any).requested, "fast");
  assert.match(String(view.outcome_note), /also refused actions listed in blocked/);
}));

for (const skipped of [false, true]) test(`refusal state: review settles before submission and accepts ${skipped ? "skip" : "an empty own review"} once`, async () => scratch(async ({ run, tmp, inst }) => {
  const r = insertNode({ id: "r_refusal", run_id: run, kind: "review", target: "codex", mode: "read", depth: 1, task: "review", cwd: tmp, status: "open", params_json: JSON.stringify({ target: "HEAD", focus: null, caller: "claude", other: "codex", reviewer: "j_reviewer", own: false }) });
  fs.mkdirSync(path.join(runDir(run), "reviews", r.id), { recursive: true });
  const job = insertNode({ id: "j_reviewer", run_id: run, parent_id: r.id, kind: "job", target: "codex", mode: "read", depth: 1, task: "review", cwd: tmp });
  const turn = insertTurn(job.id, `review:${r.id}`, "prompt", "read");
  updateTurn(turn, { status: "refused", error: outcome.error, refusal_json: JSON.stringify(refusal) });
  finishTurn(job, getTurn(turn)!, outcome, withDefaults({}));
  assert.equal(reviewView(r.id).status, "refused");
  const result = await review(inst, { review_id: r.id, ...(skipped ? { skip_own: true } : { own_review: own }) });
  assert.equal(result.outcome, "refused", JSON.stringify(result));
  assert.equal(result.status, "refused");
  assert.equal(result.verdict, "unknown");
  assert.deepEqual(result.refusal, refusal);
  assert.equal(result.discussion_id, undefined);
  if (!skipped) assert.equal((result.sides as any).claude.items, 0);
  if (!skipped) snapshot("refusal-review.json", { status: result.status, outcome: result.outcome, refusal: result.refusal, verdict: result.verdict, unfinished: result.unfinished, note: result.note, sides: result.sides, consensus: result.consensus });
  assert.equal(JSON.parse(getNode(r.id)!.params_json!).own, true);
  const again = await review(inst, { review_id: r.id, own_review: "replacement" });
  assert.ok(again.submission_note);
  assert.deepEqual(again.sides, result.sides);
  assert.equal(nodeTurns(job.id).length, 1, "no reconciliation or retry");
}));

test("refusal state: borrowed discussion stops, preserving its session's own work outcome", async () => scratch(({ run, tmp }) => {
  const part = insertNode({ id: "t_borrowed", run_id: run, kind: "thread", target: "codex", mode: "read", depth: 1, task: "own work", cwd: tmp, params_json: JSON.stringify({ own: { status: "done", error: null } }) });
  updateNode(part.id, { result_json: JSON.stringify({ reply: "own answer" }) });
  const t = insertTurn(part.id, "discussion:d_refusal", "prompt", "read");
  updateTurn(t, { status: "refused", error: outcome.error, refusal_json: JSON.stringify(refusal) });
  const d = insertNode({ id: "d_refusal", run_id: run, kind: "discussion", target: "codex", mode: "read", depth: 1, task: "discuss", cwd: tmp, status: "open", params_json: JSON.stringify({ topic: "topic", role: "peer", participant: part.id, borrowed: true, caller: "claude", other: "codex", state: { turns: 1, opened: true, seen: 0, shown: 0, pending: t, last: { claude: "CONTINUE" }, markers: {}, warnings: [] } }) });
  finishTurn(part, getTurn(t)!, outcome, withDefaults({}));
  assert.equal(settleDiscussion(d.id), true);
  assert.equal(discussionView(d.id).outcome, "refused");
  assert.deepEqual(discussionView(d.id).refusal, refusal);
  assert.equal(getNode(part.id)!.status, "done");
  assert.deepEqual(JSON.parse(getNode(part.id)!.result_json!), { reply: "own answer" });
}));

test("refusal state: a pending own_review survives another reader settling the refusal", async () => scratch(async ({ run, tmp, inst }) => {
  const r = insertNode({ id: "r_pending", run_id: run, kind: "review", target: "codex", mode: "read", depth: 1, task: "review", cwd: tmp, status: "open", params_json: JSON.stringify({ target: "HEAD", focus: null, caller: "claude", other: "codex", reviewer: "j_pending", own: false }) });
  const dir = path.join(runDir(run), "reviews", r.id);
  fs.mkdirSync(dir, { recursive: true });
  const job = insertNode({ id: "j_pending", run_id: run, parent_id: r.id, kind: "job", target: "codex", mode: "read", depth: 1, task: "review", cwd: tmp, status: "running" });
  const t = insertTurn(job.id, `review:${r.id}`, "prompt", "read", "running");
  const mine = "```json\n" + JSON.stringify({ verdict: "fail", coverage: { complete: true }, items: [{ id: "C1", severity: "major", summary: "my finding" }] }) + "\n```";
  const waiting = review(inst, { review_id: r.id, own_review: mine });
  const heldInMemory = !JSON.parse(getNode(r.id)!.params_json!).own && !fs.existsSync(path.join(dir, "claude.md"));
  updateTurn(t, { status: "refused", error: outcome.error, refusal_json: JSON.stringify(refusal) });
  finishTurn(job, getTurn(t)!, outcome, withDefaults({}));
  const seen = reviewView(r.id);
  const result = await waiting;
  assert.equal(heldInMemory, true, "unsettled reviewer never receives a stored own_review");
  assert.equal(seen.status, "refused");
  assert.equal(result.status, "refused", JSON.stringify(result));
  assert.equal((result.sides as any).claude.items, 1);
  assert.equal((result.consensus as any[])[0].status, "unresolved");
  assert.equal(result.verdict, "unknown");
  assert.equal(nodeTurns(job.id).length, 1);
}));
