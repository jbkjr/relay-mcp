import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { codexBlock } from "../dist/hosts/codex.js";
import { adoptRun, harness, claudeFloor, claudeReadDeny, passed, task, until, type Harness, type Rec, type Rule } from "./helpers.ts";

const SECRET = "CALLER-PRIVATE-REVIEW";
const REVIEWER_SECRET = "REVIEWER-SECRET-FINDING";
const own = `${SECRET}\n\`\`\`json\n${JSON.stringify({ verdict: "fail", coverage: { complete: true }, items: [{ n: 1, severity: "major", summary: SECRET }] })}\n\`\`\``;
const theirs = `${REVIEWER_SECRET}\n\`\`\`json\n{"verdict":"pass","coverage":{"complete":true},"items":[]}\n\`\`\``;
const rules = (probe = false): Rule[] => [
  { match: "independent code reviewer", steps: [
    { mark: "reviewing" }, { awaitMark: "inspect" },
    ...(probe ? [{ run: "node probe-review.cjs", mark: "inspected" }] : []),
    { awaitMark: "finish-review" }, { reply: theirs },
  ] },
  { steps: [{ reply: "Let us reconcile.\nCONTINUE" }] },
];
const params = (h: Harness, r: Rec) => JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", r.review_id)[0].params_json);
const dirOf = (h: Harness, r: Rec) => path.join(h.home, "runs", h.sql("SELECT run_id FROM nodes WHERE id = ?", r.review_id)[0].run_id, "reviews", r.review_id);
const finished = (h: Harness, r: Rec) => until(() => h.sql("SELECT status FROM nodes WHERE id = ?", r.reviewer_job)[0].status === "done", 10000, "the independent review to finish");
/**
 * Under the never floor a Claude reviewer that would inherit the person's settings is refused before
 * it starts (backends/never-admission.ts), so the inherit variants of the hardening below are
 * unreachable for Claude: the review's Claude side fails with the never reason and nothing launches.
 */
async function inheritRefused(h: Harness): Promise<void> {
  const reviewer = () => h.sql("SELECT status, error FROM nodes WHERE kind = 'job' AND target = 'claude'")[0];
  await until(() => reviewer()?.status === "failed", 10000, "the Claude reviewer to be refused");
  assert.match(reviewer().error, /^never: inherited Claude settings, hooks or MCP tools can bypass the checked sandbox\/tool route/);
  assert.equal(h.starts().filter((s) => s.target === "claude").length, 0, "no Claude reviewer was launched");
}
function notAccepted(h: Harness, r: Rec): void {
  assert.equal(params(h, r).own, false, "withholding cannot be released by an unsaved submission");
  assert.equal(fs.existsSync(path.join(dirOf(h, r), `${params(h, r).caller}.md`)), false);
  assert.equal(fs.existsSync(path.join(dirOf(h, r), `${params(h, r).caller}.json`)), false);
  assert.equal(h.sql("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'discussion'")[0].n, 0);
}
async function withheld(h: Harness, via: Pick<Harness, "call">, r: Rec): Promise<void> {
  // Give both diagnostic pointers real values, so omitting them cannot pass vacuously.
  h.sql("UPDATE nodes SET transcript_path = log_path WHERE id = ?", r.reviewer_job);
  assert.ok(h.sql("SELECT log_path FROM nodes WHERE id = ?", r.reviewer_job)[0].log_path);
  for (const tool of ["status", "result"]) {
    const out = await via.call(tool, tool === "status" ? { id: r.reviewer_job } : { job_id: r.reviewer_job });
    assert.equal(out.result, undefined, tool);
    assert.equal(out.log_path, undefined, tool);
    assert.equal(out.transcript_path, undefined, tool);
    assert.match(out.note, /withheld|Not finished yet/);
    assert.doesNotMatch(JSON.stringify(out), new RegExp(REVIEWER_SECRET));
  }
}
function installProbe(h: Harness): void {
  // The reviewer runs this read through its own shell. Scan all relay state, including SQLite,
  // to catch moving the disclosure from review files into registry rows or a queued discussion.
  fs.writeFileSync(path.join(h.repo, "probe-review.cjs"), `const fs = require('node:fs'), path = require('node:path');
const found = [];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.isFile() && fs.readFileSync(file).includes(${JSON.stringify(SECRET)})) found.push(file);
  }
}
scan(process.env.RELAY_HOME);
fs.writeFileSync(path.join(process.env.STUB_DIR, 'exposed.json'), JSON.stringify(found));`);
}

for (const caller of ["claude", "codex"]) test(`review logs: a launched ${caller} caller's tool arguments and structured reply stay out of relay state while its reviewer runs`, async () => {
  const args = { review_id: "r_probe", own_review: own };
  const event = caller === "claude"
    ? { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__relay__review", input: args }] } }
    : { method: "item/started", params: { item: { type: "mcpToolCall", server: "relay", tool: "review", arguments: args } } };
  const h = await harness([
    { match: task("LAUNCHED-CALLER"), steps: [
      { call: "review", args: { target: "README.md" }, as: "r" },
      { emit: event },
      { call: "review", args: { review_id: "{{r.review_id}}", own_review: own } },
      { reply: JSON.stringify({ type: "mcpToolCall", server: "relay", tool: "review", arguments: args }) },
    ] },
    ...rules(true),
  ], { block_s: 1 }, { RELAY_TICK_MS: "50" });
  try {
    installProbe(h);
    const launched = await h.call("delegate", { target: caller, task: "LAUNCHED-CALLER", mode: "read", background: false });
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", launched.job_id)[0].status === "done", 20000, "the launched caller to finish while its reviewer stays held");
    const r = { review_id: h.sql("SELECT id FROM nodes WHERE kind = 'review'")[0].id };
    notAccepted(h, r);
    h.mark("inspect");
    await until(() => h.marked("inspected"), 10000, "the reviewer to inspect the caller's log, saved reply and relay registry");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.env.STUB_DIR, "exposed.json"), "utf8")), []);
    const log = fs.readFileSync(h.sql("SELECT log_path FROM nodes WHERE id = ?", launched.job_id)[0].log_path, "utf8");
    assert.ok(log.includes(`[own_review: ${own.length} chars, withheld]`));
    const reply = h.sql("SELECT reply FROM turns WHERE node_id = ? ORDER BY id DESC", launched.job_id)[0].reply;
    assert.ok(reply.includes(`[own_review: ${own.length} chars, withheld]`));
  } finally { await h.close(); }
});

test("review redaction: a review quoting own_review code retains its prose, items and verdict", async () => {
  const text = 'The save uses `{"own_review": a.own_review}` and `{"partial_json": 42}`.\n```json\n{"verdict":"fail","coverage":{"complete":true},"items":[{"n":1,"severity":"major","summary":"Keep the actual review"}]}\n```';
  const h = await harness([{ match: "independent code reviewer", steps: [{ reply: text }] }, { steps: [{ reply: "CONTINUE" }] }]);
  try {
    const r = await h.call("review", { reviewer: "codex", target: "README.md" });
    await finished(h, r);
    assert.equal(h.sql("SELECT reply FROM turns WHERE node_id = ?", r.reviewer_job)[0].reply, text);
    const handed = await h.call("review", { review_id: r.review_id, own_review: own });
    assert.equal(handed.their_items, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirOf(h, r), "codex.json"), "utf8")).verdict, "fail");
  } finally { await h.close(); }
});

test("review redaction: an ordinary delegate reply mentioning own_review and partial_json remains intact", async () => {
  const text = 'A delegate can quote `{ "own_review": text }` and `{ "partial_json": 42 }` without losing its reply.';
  const h = await harness([{ steps: [{ reply: text }] }]);
  try {
    const r = await h.call("delegate", { target: "codex", task: "Preserve prose", mode: "read", background: false });
    assert.equal((await h.call("result", { job_id: r.job_id })).result.final_message, text);
  } finally { await h.close(); }
});

for (const backend of ["claude", "app-server", "exec"]) test(`review redaction: ${backend} stderr reaches saved errors with only the review argument hidden`, async () => {
  const secret = "PRIVATE-SUBMISSION".repeat(300);
  const stderr = `diagnostic ${JSON.stringify({ type: "mcpToolCall", server: "relay", tool: "review", arguments: { own_review: secret, keep: "unrelated" } })}`;
  const h = await harness([{ steps: [{ stderr }, { crash: 1 }] }], backend === "claude" ? {} : { codex_backend: backend });
  try {
    const r = await h.call("delegate", { target: backend === "claude" ? "claude" : "codex", task: "stderr probe", mode: "read", background: false });
    assert.equal(r.status, "failed");
    for (const text of [r.error, h.sql("SELECT error FROM turns WHERE node_id = ?", r.job_id)[0].error, h.sql("SELECT error FROM nodes WHERE id = ?", r.job_id)[0].error]) {
      assert.doesNotMatch(text, /PRIVATE-SUBMISSION/);
      assert.ok(text.includes(`[own_review: ${secret.length} chars, withheld]`));
      assert.match(text, /unrelated/);
    }
  } finally { await h.close(); }
});

for (const backend of ["claude", "exec"]) test(`review redaction: ${backend} stream backend buffers split stderr lines and flushes the remainder`, async () => {
  const secret = "SPLIT-STDERR-SECRET";
  const line = JSON.stringify({ type: "tool_use", name: "mcp__relay__review", input: { review_id: "r_probe", own_review: secret, keep: "unrelated" } });
  const split = line.indexOf("own_review") + 10;
  const h = await harness([{ steps: [
    { stderr: line.slice(0, split), checkpoint: "first-stderr-chunk" },
    { stderr: line.slice(split) + "\n" + line, reply: "done" },
  ] }], backend === "claude" ? {} : { codex_backend: "exec" });
  try {
    const r = await h.call("delegate", { target: backend === "claude" ? "claude" : "codex", task: "split stderr probe", mode: "read", background: true });
    await passed(h, r.job_id, "first-stderr-chunk");
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", r.job_id)[0].status === "done", 20000, "the stream turn to finish and flush stderr");
    const log = fs.readFileSync(h.sql("SELECT log_path FROM nodes WHERE id = ?", r.job_id)[0].log_path, "utf8");
    assert.doesNotMatch(log, new RegExp(secret));
    const stderr = log.split("\n").filter((line) => line.startsWith("[stderr] "));
    assert.equal(stderr.length, 2, log);
    const expected = { type: "tool_use", name: "mcp__relay__review", input: { review_id: "r_probe", own_review: `[own_review: ${secret.length} chars, withheld]`, keep: "unrelated" } };
    for (const line of stderr) assert.deepEqual(JSON.parse(line.slice("[stderr] ".length)), expected);
  } finally { await h.close(); }
});

for (const reviewer of ["claude", "codex"]) test(`review acceptance: waits for ${reviewer} without storing the caller's text or releasing withholding`, async () => {
  const h = await harness(rules(true), {}, { RELAY_TICK_MS: "50" });
  try {
    installProbe(h);
    const r = await h.call("review", { reviewer, target: "README.md" });
    assert.doesNotMatch(r.next, /send it again|resend|submission call still waiting/);
    await until(() => h.marked("reviewing"), 10000, "the reviewer to start");
    let progress = false, answered = false;
    const handing = h.call("review", { review_id: r.review_id, own_review: own }, { onprogress: () => { progress = true; } }).then((out) => { answered = true; return out; });
    void handing.catch(() => {}); // Cleanup may close the connection after an assertion fails.
    await until(() => progress, 10000, "the submission call to wait on the running reviewer");
    assert.equal(answered, false);
    notAccepted(h, r);
    assert.match((await h.call("review", { review_id: r.review_id })).next, /A submission call still waiting will be accepted then; one that returned pending was not/);
    await withheld(h, h, r);
    h.mark("inspect");
    await until(() => h.marked("inspected"), 10000, "the reviewer to scan relay's files");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.env.STUB_DIR, "exposed.json"), "utf8")), []);
    h.mark("finish-review");
    const out = await handing;
    assert.equal(out.phase, "reconciling");
    assert.equal(params(h, r).own, true);
    assert.match(fs.readFileSync(path.join(dirOf(h, r), `${params(h, r).caller}.md`), "utf8"), new RegExp(SECRET));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirOf(h, r), `${params(h, r).caller}.json`), "utf8")).items[0].summary, SECRET);
    assert.match(h.starts()[1].prompt, new RegExp(SECRET));
  } finally { await h.close(); }
});

test("review acceptance: a host deadline stores nothing and asks for own_review again; request_id replay stays withheld", async () => {
  const h = await harness(rules());
  try {
    const s = await h.instance({ args: ["--host", "claude"], env: { RELAY_WAIT_CAP_MS: "500" } });
    const start = { target: "README.md", request_id: "blind-review" };
    const r = await s.call("review", start);
    await until(() => h.marked("reviewing"), 10000, "the reviewer to start");
    const out = await s.call("review", { review_id: r.review_id, own_review: own });
    assert.equal(out.pending, true);
    assert.match(out.next, /reviewer is still working[\s\S]*review_id[\s\S]*own_review again/);
    assert.match(out.next, /status[\s\S]*wait_s/);
    notAccepted(h, r);
    const replay = await s.call("review", start);
    assert.equal(replay.repeated, true);
    assert.equal(replay.review_id, r.review_id);
    assert.equal(replay.phase, "waiting for your own review");
    assert.equal(replay.error, undefined);
    assert.match(replay.next, /one that returned pending was not, so resend it/);
    h.mark("inspect"); h.mark("finish-review");
    await finished(h, r);
    await withheld(h, s, r);
    await s.call("review", { review_id: r.review_id, own_review: own });
    const after = await s.call("review", start);
    assert.equal(after.repeated, true);
    assert.equal(after.phase, "reconciling");
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'job'")[0].n, 1);
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'discussion'")[0].n, 1);
  } finally { await h.close(); }
});

test("review acceptance: after a server restart all reviewer artifacts stay withheld until the caller's review is saved", async () => {
  const h = await harness(rules());
  try {
    const first = await h.instance({ args: ["--host", "claude"], env: { RELAY_WAIT_CAP_MS: "500" } });
    const r = await first.call("review", { target: "README.md" });
    await until(() => h.marked("reviewing"), 10000, "the reviewer to start");
    assert.equal((await first.call("review", { review_id: r.review_id, own_review: own })).pending, true);
    await first.close();
    h.mark("inspect"); h.mark("finish-review"); await finished(h, r);
    const second = await h.instance({ args: ["--host", "claude"] });
    await adoptRun(h, second, r.review_id);
    await withheld(h, second, r);
    for (const [tool, args] of [["review", { review_id: r.review_id }], ["status", { id: r.review_id, wait_s: 1 }], ["result", { job_id: r.review_id }]] as const) {
      const out = await second.call(tool, args);
      assert.equal(out.phase, "waiting for your own review");
      assert.equal(out.error, undefined);
      assert.doesNotMatch(JSON.stringify(out), new RegExp(REVIEWER_SECRET));
    }
    notAccepted(h, r);
    await second.call("review", { review_id: r.review_id, own_review: own });
    assert.ok((await second.call("result", { job_id: r.reviewer_job })).log_path);
    assert.match(fs.readFileSync(path.join(dirOf(h, r), "claude.md"), "utf8"), new RegExp(SECRET));
  } finally { await h.close(); }
});

test("review acceptance: another connection can wait and continue without an error or an accepted submission to overwrite", async () => {
  const h = await harness(rules(), { block_s: 1 }, { RELAY_TICK_MS: "50" });
  try {
    const parent = await h.call("delegate", { target: "claude", task: "PARENT", mode: "read", background: false });
    const context = await h.childOf(parent.job_id, { access: "read", may_delegate: true });
    const first = await h.instance({ ...context, env: { ...context.env, RELAY_WAIT_CAP_MS: "500" } });
    const second = await h.instance(context);
    const r = await first.call("review", { target: "README.md" });
    await until(() => h.marked("reviewing"), 10000, "the reviewer to start");
    assert.equal((await first.call("review", { review_id: r.review_id, own_review: own })).pending, true);
    const status = await second.call("status", { id: r.review_id, wait_s: 0.1 });
    assert.equal(status.error, undefined);
    assert.equal(status.phase, "waiting for your own review");
    notAccepted(h, r); await withheld(h, second, r);
    h.mark("inspect"); h.mark("finish-review"); await finished(h, r);
    await withheld(h, second, r);
    const opened = await second.call("review", { review_id: r.review_id, own_review: own });
    assert.equal(opened.phase, "reconciling");
    assert.equal((await first.call("review", { review_id: r.review_id, skip_own: true })).discussion_id, opened.discussion_id);
    assert.match(fs.readFileSync(path.join(dirOf(h, r), "claude.md"), "utf8"), new RegExp(SECRET));
  } finally { await h.close(); }
});

test("review acceptance: skip_own waits without acceptance, then returns the other review unreconciled", async () => {
  const h = await harness(rules(), { block_s: 1 });
  try {
    const r = await h.call("review", { reviewer: "codex", target: "README.md" });
    await until(() => h.marked("reviewing"), 10000, "the reviewer to start");
    const out = await h.call("review", { review_id: r.review_id, skip_own: true });
    assert.equal(out.pending, true); assert.match(out.next, /skip_own/); notAccepted(h, r);
    h.mark("inspect"); h.mark("finish-review"); await finished(h, r);
    await withheld(h, h, r);
    const skipped = await h.call("review", { review_id: r.review_id, skip_own: true });
    assert.equal(skipped.outcome, "partial"); assert.match(skipped.note, /no review of your own/);
    assert.equal(params(h, r).skipped, true);
    assert.equal(fs.existsSync(path.join(dirOf(h, r), "claude.md")), false);
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'discussion'")[0].n, 0);
  } finally { await h.close(); }
});

test("review acceptance: cancelling a review while own_review waits saves nothing and starts no reconciliation", async () => {
  const h = await harness(rules(), {}, { RELAY_TICK_MS: "50" });
  try {
    const r = await h.call("review", { reviewer: "codex", target: "README.md" });
    await until(() => h.marked("reviewing"), 10000, "the reviewer to start");
    let progress = false;
    const handing = h.call("review", { review_id: r.review_id, own_review: own }, { onprogress: () => { progress = true; } });
    void handing.catch(() => {});
    await until(() => progress, 10000, "the submission call to wait");
    await h.call("cancel", { id: r.review_id });
    const out = await handing;
    assert.equal(out.status, "cancelled");
    notAccepted(h, r);
  } finally { await h.close(); }
});

test("review acceptance: cancelling just the waiting tool call keeps the reviewer running and its result withheld", async () => {
  const h = await harness(rules(), {}, { RELAY_TICK_MS: "50" });
  try {
    const r = await h.call("review", { reviewer: "codex", target: "README.md" });
    await until(() => h.marked("reviewing"), 10000, "the reviewer to start");
    const controller = new AbortController();
    let progress = false;
    const handing = h.call("review", { review_id: r.review_id, own_review: own }, { signal: controller.signal, onprogress: () => { progress = true; } });
    void handing.catch(() => {});
    await until(() => progress, 10000, "the tool call to wait");
    controller.abort(); await handing.catch(() => {});
    assert.equal(h.sql("SELECT status FROM nodes WHERE id = ?", r.reviewer_job)[0].status, "running");
    h.mark("inspect"); h.mark("finish-review"); await finished(h, r);
    notAccepted(h, r); await withheld(h, h, r);
    await h.call("review", { review_id: r.review_id, own_review: own });
    assert.equal(params(h, r).own, true);
  } finally { await h.close(); }
});

test("review acceptance: a launched caller whose turn ends while waiting cannot accept its submission later", async () => {
  const h = await harness(rules(), {}, { RELAY_TICK_MS: "50" });
  try {
    const parent = await h.call("delegate", { target: "claude", task: "PARENT", mode: "read", background: false });
    const context = await h.childOf(parent.job_id, { access: "read", may_delegate: true });
    const caller = await h.instance(context);
    const r = await caller.call("review", { target: "README.md" });
    await until(() => h.marked("reviewing"), 10000, "the reviewer to start");
    let progress = false;
    const handing = caller.call("review", { review_id: r.review_id, own_review: own }, { onprogress: () => { progress = true; } });
    void handing.catch(() => {});
    await until(() => progress, 10000, "the launched caller's tool call to wait");
    h.sql("UPDATE turns SET status = 'done' WHERE id = ?", context.turnId);
    h.mark("inspect"); h.mark("finish-review"); await finished(h, r);
    const out = await handing;
    assert.equal(out.refused, true);
    assert.match(out.reason, /turn.*ended/);
    notAccepted(h, r); await withheld(h, h, r);
  } finally { await h.close(); }
});

test("review acceptance: two connections already waiting save one submission and tell the loser while reconciliation is busy", async () => {
  const h = await harness([{ match: task("PARENT"), steps: [{ reply: "Parent ready." }] }, rules()[0], { steps: [{ mark: "reconciling" }, { awaitMark: "finish-reconciliation" }, { reply: "Let us reconcile.\nCONTINUE" }] }], {}, { RELAY_TICK_MS: "50" });
  try {
    const parent = await h.call("delegate", { target: "claude", task: "PARENT", mode: "read", background: false });
    const context = await h.childOf(parent.job_id, { access: "read", may_delegate: true });
    const first = await h.instance(context), second = await h.instance(context);
    const r = await first.call("review", { target: "README.md" });
    await until(() => h.marked("reviewing"), 10000, "the reviewer to start");
    let waiting = 0;
    const completed: Rec[] = [];
    const calls = [first, second].map((via, i) => {
      let noted = false;
      const call = via.call("review", { review_id: r.review_id, own_review: `${own}\nSUBMISSION-${i}` }, { onprogress: () => { if (!noted) { noted = true; waiting++; } } }).then((out) => { completed.push(out); return out; });
      void call.catch(() => {});
      return call;
    });
    await until(() => waiting === 2, 10000, "both connections to wait before the reviewer finishes");
    notAccepted(h, r);
    h.mark("inspect"); h.mark("finish-review");
    await until(() => h.marked("reconciling") && completed.length > 0, 10000, "the losing submission to return while reconciliation is held");
    assert.match(completed[0].submission_note, /submission was already saved.*this call's text was not used/i);
    h.mark("finish-reconciliation");
    const answers = await Promise.all(calls);
    assert.ok(answers.every((out) => out.phase === "reconciling"), JSON.stringify(answers));
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'discussion'")[0].n, 1);
    const file = path.join(dirOf(h, r), "claude.md"), saved = fs.readFileSync(file, "utf8");
    assert.equal((saved.match(/SUBMISSION-[01]/g) ?? []).length, 1);
    assert.match((await first.call("review", { review_id: r.review_id, own_review: "OVERWRITE" })).submission_note, /this call's text was not used/);
    assert.equal(fs.readFileSync(file, "utf8"), saved);
  } finally { await h.close(); }
});

for (const child_settings of ["isolated", "inherit"]) test(`review hardening: ${child_settings === "inherit" ? "an inherit Claude reviewer is refused under the never floor" : `${child_settings} Claude review turns deny Codex transcripts through file tools and Bash only for that turn`}`, async () => {
  const h = await harness(rules(), { child_settings, ...(child_settings === "inherit" ? { claude_settings_env: "accept" } : {}) });
  const settings = (start: Rec) => JSON.parse(fs.readFileSync(start.argv[start.argv.indexOf("--settings") + 1], "utf8"));
  try {
    const r = await h.call("review", { reviewer: "claude", target: "README.md" });
    if (child_settings === "inherit") return await inheritRefused(h);
    await until(() => h.marked("reviewing"), 10000, "the Claude reviewer to start");
    const isolated = settings(h.starts()[0]);
    const dirs = [path.join(h.env.HOME, ".codex")];
    // Beside the API key relay hands a key-only target and relay's sockets directory, which no Claude turn may read (claudeReadDeny),
    // and then the never floor, which every Claude turn gets (claudeFloor).
    const keys = claudeReadDeny(h.env.HOME);
    const floor = claudeFloor(h);
    const withFloor = (paths: string[]) => [...new Set([...paths, ...floor.read])];
    assert.deepEqual(isolated.sandbox.filesystem.denyRead, withFloor([...dirs, ...keys.paths]));
    const privateRoot = path.join(h.env.HOME, ".relay-t");
    assert.deepEqual(isolated.permissions.deny, [`Edit(/${privateRoot})`, `Edit(/${privateRoot}/**)`, ...dirs.flatMap((dir) => [`Read(/${dir})`, `Read(/${dir}/**)`]), ...keys.rules, ...floor.rules]);
    assert.doesNotMatch(h.starts()[0].prompt, /host.s transcripts|drafts/);
    assert.match(h.starts()[0].prompt, /Do not look for the other review outside the target; relay gives it to you after yours is finished\./);
    h.mark("inspect"); h.mark("finish-review"); await finished(h, r);
    await h.call("review", { review_id: r.review_id, own_review: own });
    const reconciliation = settings(h.starts()[1]);
    assert.deepEqual(reconciliation.sandbox.filesystem.denyRead, withFloor(keys.paths), "the key and sockets directories and the floor alone, as on every Claude turn");
    assert.deepEqual(reconciliation.permissions?.deny, [`Edit(/${privateRoot})`, `Edit(/${privateRoot}/**)`, ...keys.rules, ...floor.rules]);
    await h.call("ask", { target: "claude", message: "ordinary read-only work" });
    assert.deepEqual(settings(h.starts()[2]).sandbox.filesystem.denyRead, withFloor(keys.paths));
  } finally { await h.close(); }
});

for (const child_settings of ["isolated", "inherit"]) test(`review hardening: same-family ${child_settings} Claude ${child_settings === "inherit" ? "is refused under the never floor" : "keeps its own tools and memory readable while denying conversation files"}`, async () => {
  const h = await harness(rules(), { same_family: "allow", child_settings, ...(child_settings === "inherit" ? { claude_settings_env: "accept" } : {}) });
  try {
    const home = path.join(h.env.HOME, "relocated claude");
    const s = await h.instance({ args: ["--host", "claude"], env: { CLAUDE_CONFIG_DIR: home } });
    await s.call("review", { reviewer: "claude", target: "README.md" });
    if (child_settings === "inherit") return await inheritRefused(h);
    await until(() => h.marked("reviewing"), 10000, "the Claude reviewer to start");
    const start = h.starts()[0], settings = JSON.parse(fs.readFileSync(start.argv[start.argv.indexOf("--settings") + 1], "utf8"));
    const paths = settings.sandbox.filesystem.denyRead as string[];
    const patterns = settings.permissions.deny.map((rule: string) => rule.slice("Read(/".length, -1));
    const denied = (file: string, rules: string[]) => rules.some((rule) => file === rule || file.startsWith(rule + "/") || path.matchesGlob(file, rule));
    for (const rules of [paths, patterns]) {
      for (const file of [
        "projects/repo/caller.jsonl", "projects/repo/caller.orphaned-123-abc.jsonl", "projects/repo/caller.jsonl.superseded-123",
        "projects/repo/caller/subagents/agent-1.jsonl", "projects/repo/sessions-index.json", "history.jsonl",
        "debug/caller.txt", "paste-cache/paste.txt", "feedback-bundles/caller.zip", "feedback/drafts/caller.json", "usage-data/session-meta/caller.json",
      ]) assert.ok(denied(path.join(home, file), rules), `${file} must be denied`);
      for (const file of [
        "projects/repo/reviewer/tool-results/output.txt", "projects/repo/memory/MEMORY.md", "shell-snapshots/snapshot.sh", "skills/review/SKILL.md", "plugins/cache/plugin.md", "agent-memory/reviewer/MEMORY.md",
      ]) assert.equal(denied(path.join(home, file), rules), false, `${file} must stay readable`);
    }
  } finally { await h.close(); }
});

for (const child_settings of ["isolated", "inherit"]) for (const registration of ["codex", "claude", null]) {
  for (const relocated of registration ? [true] : [false, true]) test(`review hardening: unknown caller with ${registration ?? "no"} registration and ${relocated ? "relocated" : "default"} homes (${child_settings}) ${child_settings === "inherit" ? "records the candidate transcripts, and its Claude reviewer is refused under the never floor" : "withholds candidate transcripts"}`, async () => {
    const h = await harness(rules(), { child_settings, ...(child_settings === "inherit" ? { claude_settings_env: "accept" } : {}) });
    try {
      const codexHome = path.join(h.env.HOME, relocated ? "relocated codex" : ".codex");
      const claudeHome = path.join(h.env.HOME, relocated ? "relocated claude" : ".claude");
      const root = await h.instance({
        ...(registration ? { args: ["--host", registration] } : { host: null }),
        clientInfo: { name: "opencode", version: "1.19.4" },
        env: relocated ? { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome } : {},
      });
      const r = await root.call("review", { reviewer: "claude", target: "README.md" });
      const expected = registration === "codex" ? [codexHome] : registration === "claude" ? [claudeHome] : [codexHome, claudeHome];
      assert.deepEqual(params(h, r).caller_transcripts, expected);
      if (child_settings === "inherit") return await inheritRefused(h);
      await until(() => h.marked("reviewing"), 10000, "the Claude reviewer to start");
      const start = h.starts()[0], settings = JSON.parse(fs.readFileSync(start.argv[start.argv.indexOf("--settings") + 1], "utf8"));
      const paths = settings.sandbox.filesystem.denyRead as string[];
      const patterns = settings.permissions.deny.map((rule: string) => rule.slice("Read(/".length, -1));
      const denied = (file: string, rules: string[]) => rules.some((rule) => file === rule || file.startsWith(rule + "/") || path.matchesGlob(file, rule));
      for (const rules of [paths, patterns]) {
        assert.equal(denied(path.join(codexHome, "sessions/rollout.jsonl"), rules), expected.includes(codexHome));
        assert.equal(denied(path.join(claudeHome, "projects/repo/caller.jsonl"), rules), expected.includes(claudeHome));
        for (const file of ["projects/repo/reviewer/tool-results/output.txt", "projects/repo/memory/MEMORY.md", "skills/review/SKILL.md", "plugins/cache/plugin.md"]) {
          assert.equal(denied(path.join(claudeHome, file), rules), false, `${file} must stay readable`);
        }
      }
    } finally { await h.close(); }
  });
}

test("review hardening: installed Codex registration forwards CODEX_HOME through the host's filtered MCP environment", async () => {
  const h = await harness([{ match: task("ROOT-CODEX"), steps: [
    { call: "review", args: { reviewer: "claude", target: "README.md" } },
    // Keep the owning MCP session (and its environment broker) alive until startup completes.
    { mark: "root-review-queued" }, { awaitMark: "root-can-exit" }, { reply: "Review started." },
  ] }, ...rules()]);
  const home = path.join(h.env.HOME, "relocated codex");
  const registration = (parse(codexBlock()).mcp_servers as Rec).relay;
  const config = { command: registration.command, args: registration.args, env_vars: registration.env_vars };
  const args = Object.entries(config).flatMap(([key, value]) => ["-c", `mcp_servers.relay.${key}=${JSON.stringify(value)}`]);
  // Only the host has CODEX_HOME. Its MCP server receives it solely via the real registration's
  // env_vars list; the sole explicit env override is this test's isolated relay control directory.
  args.push("-c", `mcp_servers.relay.env.RELAY_HOME=${JSON.stringify(h.home)}`);
  const child = spawn(path.join(import.meta.dirname, "stubs", "stub-codex"), ["exec", "--json", ...args], { cwd: h.repo, env: { ...h.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  let exited = false, exitCode: number | null = null, stderr = "";
  child.stdout.resume(); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("exit", (code) => { exited = true; exitCode = code; });
  child.stdin.end("assignment:\nROOT-CODEX");
  try {
    assert.deepEqual(registration.env_vars, ["CODEX_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]);
    assert.equal((codexBlock().match(/^env_vars\s*=/gm) ?? []).length, 1);
    await until(() => exited || h.marked("root-review-queued"), 10000, "the root Codex stub to call review through its installed MCP registration");
    assert.equal(exited, false, stderr);
    assert.equal(h.sql("SELECT id FROM nodes WHERE kind = 'review'").length, 1, `the call did not create a review: ${stderr}`);
    await until(() => h.marked("reviewing") || h.sql("SELECT status FROM nodes WHERE kind = 'job'").some((r) => ["failed", "lost", "refused"].includes(r.status)), 10000, "the Claude reviewer to start or report its launch failure");
    assert.equal(h.marked("reviewing"), true, JSON.stringify(h.sql("SELECT status, error FROM nodes WHERE kind = 'job'")));
    const row = h.sql("SELECT params_json FROM nodes WHERE kind = 'review'")[0];
    assert.deepEqual(JSON.parse(row.params_json).caller_transcripts, [home]);
    const start = h.starts().find((s) => s.target === "claude")!;
    const settings = JSON.parse(fs.readFileSync(start.argv[start.argv.indexOf("--settings") + 1], "utf8"));
    // The never floor last, as on every Claude turn (claudeFloor).
    const floor = claudeFloor(h);
    assert.deepEqual(settings.sandbox.filesystem.denyRead, [...new Set([home, ...claudeReadDeny(h.env.HOME).paths, ...floor.read])]);
    const privateRoot = path.join(h.env.HOME, ".relay-t");
    assert.deepEqual(settings.permissions.deny, [`Edit(/${privateRoot})`, `Edit(/${privateRoot}/**)`, `Read(/${home})`, `Read(/${home}/**)`, ...claudeReadDeny(h.env.HOME).rules, ...floor.rules]);
    h.mark("root-can-exit");
    await until(() => exited, 10000, "the root Codex stub to exit");
    assert.equal(exitCode, 0, stderr);
  } finally {
    if (!exited) child.kill("SIGTERM");
    await until(() => exited, 10000, "the root Codex stub to exit");
    await h.close();
  }
});

test("review hardening: launched Codex forwards its configured home through the child MCP environment", async () => {
  const h = await harness([{ match: task("CHILD-CODEX"), steps: [{ call: "review", args: { reviewer: "claude", target: "README.md" } }, { reply: "Review started." }] }, ...rules()]);
  try {
    const home = path.join(h.env.HOME, "relocated codex");
    h.env.CODEX_HOME = home;
    const caller = await h.call("delegate", { target: "codex", task: "CHILD-CODEX", mode: "read", background: false });
    await until(() => h.marked("reviewing"), 10000, "the Claude reviewer to start through the Codex child's filtered MCP environment");
    const run = h.sql("SELECT run_id FROM nodes WHERE id = ?", caller.job_id)[0].run_id;
    assert.deepEqual(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE kind = 'review'")[0].params_json).caller_transcripts, [
      home, path.join(`${h.home}-harness`, run, caller.job_id), path.join(h.home, "runs", run, "nodes", caller.job_id),
    ]);
  } finally { await h.close(); }
});
