import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { alive, harness, release, sleep, STUB_TARGETS, task, until, type Rec, type Rule } from "./helpers.ts";
import { buildConsensus, parseReview, reconciledVerdict } from "../dist/modes/review.js";
import { parseMarker, parseReport, reviewerPrompt } from "../dist/core/prompts.js";
import { sendGroupSignal } from "../dist/core/procs.js";

test("ask: a follow-up with thread_id continues the same session, in both directions", async () => {
  const h = await harness();
  try {
    for (const target of STUB_TARGETS) {
      const first = await h.call("ask", { target, message: "first question", context: ["README.md"] });
      assert.ok(first.thread_id);
      assert.match(first.reply, new RegExp(`stub ${target} reply \\(turn 1\\)`));
      const second = await h.call("ask", { target, message: "follow-up", thread_id: first.thread_id });
      assert.equal(second.thread_id, first.thread_id);
      assert.match(second.reply, /turn 2/, "the stub's session saw a second turn");
      const [a, b] = h.starts().filter((s) => s.target === target);
      assert.equal(a.resumed, false);
      assert.equal(b.resumed, true);
      assert.equal(b.sessionId, a.sessionId, "same underlying session id");
      assert.equal(a.access, "read");
      assert.equal(b.access, "read");
      // A consulted agent cannot delegate by default, but it can ask for approval.
      if (target === "claude") assert.equal(a.promptTool, "mcp__relay__permission_prompt");
      else assert.equal(a.thread.approvalPolicy, "on-request");
      assert.match(a.prompt, /You may not delegate/);
      assert.match(a.prompt, /you may ask for approval/);
      assert.match(a.prompt, /is consulting you/);
      assert.match(a.prompt, /- README\.md/);
      assert.doesNotMatch(b.prompt, /is consulting you/, "the header is sent once");
    }
    const wrong = await h.call("ask", { target: "claude", message: "x", thread_id: h.sql("SELECT id FROM nodes WHERE target = 'codex'")[0].id });
    assert.match(wrong.error, /codex thread/);
  } finally {
    await h.close();
  }
});

test("discuss: the caller is one side; messages pass verbatim; two AGREEs in a row end it", async () => {
  const h = await harness([
    { target: "codex", turn: 1, steps: [{ reply: "The README supports A, I grant.\nCONTINUE" }] },
    { target: "codex", turn: 2, steps: [{ reply: "Persuaded by the README evidence.\nAGREE: use option A" }] },
  ]);
  try {
    // A root that says which host it is in: a Claude session.
    const claude = await h.instance({ args: ["--host", "claude"] });
    const first = await claude.call("discuss", { topic: "A or B?", message: "I propose option A because of README.md:1.\nCONTINUE", context: ["README.md"] });
    assert.equal(first.status, "open");
    assert.equal(first.with, "codex", "the other side is the other family, without being named");
    assert.equal(first.reply, "The README supports A, I grant.\nCONTINUE");
    assert.equal(first.marker, "CONTINUE");
    assert.equal(first.marker_note, undefined, "a marker on its own line gets no note");
    assert.equal(first.turns, 2);
    const second = await claude.call("discuss", { discussion_id: first.discussion_id, message: "Then we agree.\nAGREE: use option A" });
    assert.equal(second.status, "done");
    assert.equal(second.outcome, "agree");
    assert.equal(second.conclusion, "use option A");
    assert.equal(second.closed_by, "codex", "the second AGREE, written after reading the first, closes it");
    assert.equal(second.turns, 4);

    const starts = h.starts();
    assert.deepEqual(starts.map((s) => s.target), ["codex", "codex"], "relay launched only the other family");
    assert.match(starts[0].prompt, /You are the critic/);
    assert.match(starts[0].prompt, /The other participant is a Claude agent/);
    assert.match(starts[0].prompt, /Context files to read first:\n- README\.md/);
    assert.match(starts[0].prompt, /exactly one of/);
    assert.ok(starts[0].prompt.includes("[claude's message, verbatim]\nI propose option A because of README.md:1.\nCONTINUE"));
    assert.ok(starts[1].prompt.includes("[claude's message, verbatim]\nThen we agree.\nAGREE: use option A"));
    assert.doesNotMatch(starts[1].prompt, /You are the critic/, "the rules are given once");
    assert.ok(starts.every((s) => s.access === "read" && !s.hasRelay), "the other side is read-only and cannot delegate");
    assert.equal(starts[1].sessionId, starts[0].sessionId, "one session for the whole discussion");
    const transcript = fs.readFileSync(second.transcript_path, "utf8");
    assert.match(transcript, /## Turn 1 — claude\n\nI propose option A/);
    assert.match(transcript, /## Turn 2 — codex/);
    assert.match(transcript, /## Outcome\n\nAGREE: use option A/);

    const late = await claude.call("discuss", { discussion_id: first.discussion_id, message: "One more thing.\nCONTINUE" });
    assert.match(late.note, /has ended, so your message was not sent/);
    assert.equal(h.starts().length, 2);
  } finally {
    await h.close();
  }
});

test("discuss: the caller's own AGREE closes it when the other has already agreed", async () => {
  const h = await harness([{ target: "codex", steps: [{ reply: "Nothing to add.\nAGREE: keep the cache" }] }]);
  try {
    const first = await h.call("discuss", { target: "codex", topic: "cache?", message: "Keep it?\nCONTINUE" });
    assert.equal(first.status, "open", "one AGREE is not agreement");
    const second = await h.call("discuss", { discussion_id: first.discussion_id, message: "AGREE: keep the cache" });
    assert.equal(second.outcome, "agree");
    assert.equal(second.closed_by, "claude", "the caller's own AGREE, from a Claude session");
    assert.equal(h.starts().length, 1, "no further turn was needed");
    // Nothing came back after it, so there is no reply, rather than the other side's earlier message again.
    assert.equal(second.reply, null);
    assert.match(second.reply_note, /Your AGREE closed the discussion, so codex has not replied to it/);
    assert.equal(second.marker, undefined);
    assert.equal((await h.call("status", { id: first.discussion_id })).reply, null);
  } finally {
    await h.close();
  }
});

test("discuss: a message without a marker on its own line is taken as CONTINUE and the caller is told; an unambiguous one at the end of the line counts", async () => {
  const h = await harness([
    { target: "codex", turn: 1, steps: [{ reply: "Fine by me.\nAGREE: ship it" }] },
    { target: "codex", turn: 2, steps: [{ reply: "Still agreed.\nAGREE: ship it" }] },
  ]);
  try {
    const first = await h.call("discuss", { target: "codex", topic: "ship?", message: "I think we should ship, AGREE: ship it." });
    assert.match(first.marker_note, /relay found no CONTINUE, AGREE: or CRUX: on a line of its own in your message, so it was taken as CONTINUE/);
    assert.equal(first.status, "open");
    const second = await h.call("discuss", { discussion_id: first.discussion_id, message: "Then we are done. AGREE: ship it" });
    assert.equal(second.outcome, "agree", JSON.stringify(second));
    assert.equal(second.conclusion, "ship it");
    assert.match(second.marker_note, /relay read your AGREE: from the end of your last line/);
  } finally {
    await h.close();
  }
});

test("discuss: a discussion recorded before side labels were stored is still read and carried on", async () => {
  const h = await harness([{ target: "codex", steps: [{ reply: "Nothing to add.\nAGREE: keep it" }] }]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const first = await claude.call("discuss", { topic: "keep?", message: "Keep it?\nCONTINUE" });
    // As an older relay wrote it: the caller's label only.
    const [row] = h.sql("SELECT params_json FROM nodes WHERE id = ?", first.discussion_id);
    const params = JSON.parse(row.params_json);
    assert.equal(params.other, "codex");
    delete params.other;
    h.sql("UPDATE nodes SET params_json = ? WHERE id = ?", JSON.stringify(params), first.discussion_id);
    const second = await claude.call("discuss", { discussion_id: first.discussion_id, message: "AGREE: keep it" });
    assert.equal(second.with, "codex");
    assert.equal(second.outcome, "agree");
    assert.equal(second.closed_by, "claude");
  } finally {
    await h.close();
  }
});

test("discuss: a CRUX from the caller gets one answer; otherwise the turns run out", async () => {
  const h = await harness([
    { target: "codex", match: "PROBE_AGREE", steps: [{ reply: "Fair enough.\nAGREE: go with B, revisit at 10k QPS" }] },
    { target: "codex", turn: 1, steps: [{ reply: "B.\nCRUX: whether latency matters more than cost" }] },
    { target: "codex", turn: 2, steps: [{ reply: "Still B.\nCRUX: whether latency matters more than cost at p99" }] },
    { target: "claude", steps: [{ reply: "Hm.\nCONTINUE" }] },
  ]);
  try {
    const role = "Argue for B as a staff engineer would.";
    const first = await h.call("discuss", { target: "codex", topic: "A or B?", message: "A.\nCONTINUE", role });
    assert.equal(first.status, "open", "the other's crux alone does not end it");
    assert.equal(first.marker, "CRUX");
    const second = await h.call("discuss", { discussion_id: first.discussion_id, message: "Still A.\nCRUX: whether the cache is safe to share" });
    assert.equal(second.outcome, "no_agreement");
    assert.deepEqual(second.cruxes, { claude: "whether the cache is safe to share", codex: "whether latency matters more than cost at p99" });
    const starts = h.starts();
    assert.match(starts[0].prompt, /Your role: Argue for B as a staff engineer would\./, "free-text role");
    assert.match(starts[1].prompt, /is ending the discussion with this message/);

    // With no crux, the limit ends it: the other is told when its turn is the last.
    const a = await h.call("discuss", { target: "claude", topic: "t", message: "one\nCONTINUE", max_turns: 4, role: "peer" });
    const b = await h.call("discuss", { discussion_id: a.discussion_id, message: "three\nCONTINUE" });
    assert.equal(b.outcome, "no_agreement");
    assert.equal(b.turns, 4);
    const [x, y] = h.starts().slice(2);
    assert.match(x.prompt, /You are a peer\. Defend or revise your own points/, "peer preset");
    assert.doesNotMatch(x.prompt, /final turn/);
    assert.match(y.prompt, /final turn/);

    // A CRUX answered with AGREE: it still ends without agreement, and the answer's conclusion is kept.
    const c = await h.call("discuss", { target: "codex", topic: "c", message: "PROBE_AGREE: B is costly.\nCRUX: whether B is cheap enough" });
    assert.equal(c.outcome, "no_agreement");
    assert.deepEqual(c.cruxes, { claude: "whether B is cheap enough", codex: null });
    assert.deepEqual(c.final_positions, { claude: "CRUX: whether B is cheap enough", codex: "AGREE: go with B, revisit at 10k QPS" });
    assert.match(fs.readFileSync(c.transcript_path, "utf8"), /codex's final position: AGREE: go with B, revisit at 10k QPS/);
  } finally {
    await h.close();
  }
});

test("discuss: a human message reaches the other agent on its next turn and the caller on its next call", async () => {
  const h = await harness([{ steps: [{ reply: "thinking\nCONTINUE" }] }]);
  try {
    const d = await h.call("discuss", { target: "codex", topic: "slow topic", message: "start\nCONTINUE" });
    const said = JSON.parse(h.cli("chat", d.discussion_id, "--say", "Please also consider rollback cost."));
    assert.equal(said.injected, true);
    const next = await h.call("discuss", { discussion_id: d.discussion_id, message: "go on\nCONTINUE" });
    assert.deepEqual(next.human_messages, ["Please also consider rollback cost."]);
    const marked = "[Message from the human user, not from the other participant]\nPlease also consider rollback cost.";
    assert.equal(h.starts().filter((s) => s.prompt.includes(marked)).length, 1, "the other agent sees it exactly once");
    assert.equal((await h.call("status", { id: d.discussion_id })).human_messages, undefined, "and the caller is told once");
    assert.match(h.cli("chat", d.discussion_id, "--print"), /## Turn 1 — claude/);

    await h.call("cancel", { id: d.discussion_id });
    assert.equal((await h.call("status", { id: d.discussion_id })).status, "cancelled");
    assert.match(JSON.parse(h.cli("chat", d.discussion_id, "--say", "too late")).error, /has ended/);
  } finally {
    await h.close();
  }
});

test("discuss: with an existing session of the other family, which keeps its context and stays read-only for it", async () => {
  const h = await harness([
    { match: task("BUILD"), steps: [{ write: "feature.txt", content: "new\n" }, { reply: "built\n## RELAY REPORT\nSummary: built it\nFiles changed: feature.txt\nBranch: x\nTests run: none\nOpen issues: none" }] },
    { match: "ship\\?", steps: [{ write: "sneaky.txt", content: "x\n" }, { reply: "AGREE: ship it" }] },
    { match: "CONTINUE THE JOB", steps: [{ reply: "continued" }] },
  ]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const w = await claude.call("delegate", { task: "BUILD", mode: "write", background: false });
    assert.equal(w.target, "codex", "with no target named, a Claude session reaches Codex");
    const r = await claude.call("discuss", { topic: "ship?", message: "I think it can ship.\nAGREE: ship it", with: w.job_id });
    assert.equal(r.outcome, "agree");
    assert.equal(r.participant, w.job_id);
    const [build, talk] = h.starts();
    assert.equal(build.access, "write");
    assert.equal(talk.resumed, true);
    assert.equal(talk.sessionId, build.sessionId, "the discussion is held with the job's own session");
    assert.equal(talk.access, "read", "a discussion turn is read-only even on a write job's session");
    assert.equal(talk.cwd, build.cwd);
    assert.match(talk.prompt, /new phase of your existing session/);
    assert.match(talk.prompt, /You are a peer/, "an existing session is a peer by default");
    assert.deepEqual(h.sql("SELECT kind FROM nodes ORDER BY created_at").map((n) => n.kind), ["job", "discussion"], "no session was made for it");
    // The job is still a job: it can be resumed and merged afterwards. The discussion's reply comes
    // before its turn on the job's session has wound down; once it has, the job is idle again (resumed
    // earlier, the message would queue behind it).
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", w.job_id)[0].status === "done", 60000, "the discussion's turn on the job to end");
    assert.equal((await claude.call("resume", { job_id: w.job_id, message: "CONTINUE THE JOB" })).status, "queued");
    assert.equal((await claude.call("status", { id: w.job_id, wait_s: 20 })).status, "done");
    assert.equal(h.starts()[2].access, "write");
  } finally {
    await h.close();
  }
});

test("relay reaches the other family only: one's own is refused, from a session and from a launched agent", async () => {
  const h = await harness([
    { match: task("OUTER"), steps: [
      { call: "delegate", args: { target: "codex", task: "SAME", mode: "read" }, as: "same" },
      { call: "ask", args: { message: "INNER QUESTION" }, as: "crossed" },
      { reply: "same: {{same}} crossed: {{crossed}}" },
    ] },
    { match: "INNER QUESTION", steps: [{ reply: "inner answer" }] },
    { steps: [{ reply: "ok" }] },
  ], { same_family: "refuse" });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    for (const [tool, args] of [
      ["delegate", { target: "claude", task: "x", mode: "read" }],
      ["ask", { target: "claude", message: "x" }],
      ["discuss", { target: "claude", topic: "t", message: "m" }],
      ["review", { reviewer: "claude", target: "README.md" }],
    ] as const) {
      const r = await claude.call(tool, args);
      assert.match(r.reason, /reaches only the other family.*You are a Claude agent.*use your own subagents/, `${tool} to one's own family`);
    }
    assert.equal(h.starts().length, 0);
    assert.equal(fs.existsSync(path.join(h.home, "runs")), false, "nothing was created by the refused calls");
    assert.equal((await claude.call("ask", { message: "hello" })).reply, "ok");
    assert.equal(h.starts()[0].target, "codex");

    // A session whose host is unknown reaches nothing, even naming a target: the rule cannot be checked for it.
    const unknown = await h.instance({ host: null });
    for (const args of [{ message: "hello" }, { target: "codex", message: "hello" }, { target: "claude", message: "hello" }]) {
      assert.match((await unknown.call("ask", args)).reason, /cannot tell which agent it is running inside/);
    }
    assert.match((await unknown.call("delegate", { target: "codex", task: "x", mode: "read" })).reason, /cannot tell which agent/);
    assert.equal(h.starts().length, 1, "nothing was launched for it");

    // A launched Codex agent: Codex again is refused, and with no target it crosses back to Claude.
    const outer = await (await h.instance({ args: ["--host", "claude"] })).call("delegate", { task: "OUTER", mode: "read", background: false });
    assert.match(outer.result.final_message, /same: .*reaches only the other family.*You are a Codex agent/);
    assert.match(outer.result.final_message, /crossed: .*inner answer/);
    const inner = h.starts().find((s) => s.prompt.includes("INNER QUESTION"))!;
    assert.equal(inner.target, "claude");
  } finally {
    await h.close();
  }
});

const items = (n: number, extra = "") => "```json\n" + JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ n: i + 1, severity: "major", location: `a.ts:${i + 1}`, summary: `issue ${i + 1}${extra}`, evidence: "e", fix: "f" })) }) + "\n```";
const consensus = (entries: unknown[]) => "```json\n" + JSON.stringify({ consensus: entries }) + "\n```";

test("review: the other family reviews blind while the caller writes its own; then the two reconcile", async () => {
  const agreed = [
    { ids: ["C1", "X1"], severity: "major", status: "agreed", summary: "merged issue" },
    { ids: ["C2"], severity: "minor", status: "dropped", summary: "not real" },
    { ids: ["X2"], severity: "blocker", status: "agreed", summary: "codex-only issue" },
  ];
  const h = await harness([
    { target: "codex", match: "independent code reviewer", steps: [{ sleep: 400 }, { reply: `CODEX-SECRET-FINDING\n${items(2)}` }] },
    { target: "codex", turn: 2, steps: [{ reply: "C1 and X1 are the same finding. I would drop C2.\nCONTINUE" }] },
    { target: "codex", turn: 3, steps: [{ reply: `Same.\n${consensus(agreed)}\nAGREE: list above` }] },
  ]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { target: "src/a.ts", focus: "error handling" });
    assert.equal(started.phase, "waiting for your own review");
    assert.equal(started.reviewer, "codex");

    // The other review exists before the caller has written its own, and is not shown.
    const peek = await claude.call("status", { id: started.reviewer_job, wait_s: 20 });
    assert.equal(peek.status, "done");
    assert.equal(peek.result, undefined);
    assert.equal(peek.log_path, undefined, "nor is the way to its log");
    assert.match(peek.note, /withheld until you hand in your own review/);
    assert.match(started.next, /keeps it out of its replies until yours is saved/);
    assert.match(started.next, /Host transcripts[\s\S]*safeguard for normal use, not a guarantee of independence/);
    assert.doesNotMatch(JSON.stringify(await claude.call("result", { job_id: started.reviewer_job })), /SECRET-FINDING/);
    assert.equal((await claude.call("review", { review_id: started.review_id })).phase, "waiting for your own review");

    const mine = `CLAUDE-SECRET-FINDING\n${items(2)}`;
    const handed = await claude.call("review", { review_id: started.review_id, own_review: mine });
    assert.equal(handed.phase, "reconciling");
    assert.deepEqual([handed.their_items, handed.your_items], [2, 2]);
    assert.ok(fs.readFileSync(handed.their_review, "utf8").includes("CODEX-SECRET-FINDING"));
    assert.equal(handed.reply, "C1 and X1 are the same finding. I would drop C2.\nCONTINUE");
    assert.match(handed.rules, /consensus/);
    const closed = await claude.call("discuss", { discussion_id: handed.discussion_id, message: `Agreed.\n${consensus(agreed)}\nAGREE: list above` });
    assert.equal(closed.outcome, "agree");

    const r = await claude.call("result", { job_id: started.review_id });
    assert.equal(r.status, "done");
    assert.equal(r.outcome, "agree");
    assert.deepEqual(r.consensus.map((c: any) => [c.ids.join("+"), c.status, c.raised_by.join("+")]), [
      ["C1+X1", "agreed", "claude+codex"], ["C2", "dropped", "claude"], ["X2", "agreed", "codex"],
    ]);
    assert.ok(fs.readFileSync(r.reviews.claude, "utf8").includes("CLAUDE-SECRET-FINDING"));
    assert.ok(fs.readFileSync(r.reviews.codex, "utf8").includes("CODEX-SECRET-FINDING"));
    assert.ok(fs.existsSync(r.transcript_path));

    const starts = h.starts();
    assert.deepEqual(starts.map((s) => s.target), ["codex", "codex", "codex"], "relay launched only the other family's reviewer");
    // The reviewer's instructions are built from target and focus alone, and it works read-only.
    assert.equal(starts[0].prompt, reviewerPrompt("src/a.ts", "error handling"));
    assert.equal(starts[0].access, "read");
    // Reconciliation is held with the reviewer's own session, as a peer, and gives it the caller's review.
    assert.equal(starts[1].sessionId, starts[0].sessionId);
    assert.match(starts[1].prompt, /You are a peer/);
    assert.match(starts[1].prompt, /----- claude review -----[\s\S]*CLAUDE-SECRET-FINDING/);
    assert.match(starts[1].prompt, /its items are C<n>/);
    assert.doesNotMatch(starts[1].prompt, /CODEX-SECRET-FINDING/, "its own review is already in its session");
    const kinds = h.sql("SELECT kind, parent_id, depth FROM nodes ORDER BY created_at");
    assert.deepEqual(kinds.map((k) => k.kind), ["review", "job", "discussion"]);
    assert.ok(kinds.slice(1).every((k) => k.parent_id === started.review_id && k.depth === 1));
  } finally {
    await h.close();
  }
});

test("review: with no review of one's own, or a reviewer that fails, the result says what it is", async () => {
  const h = await harness([
    { match: "REVIEW-OK", steps: [{ reply: `fine\n${items(1)}` }] },
    { match: "REVIEW-BAD", steps: [{ fail: "model unavailable" }] },
  ]);
  try {
    const a = await h.call("review", { reviewer: "codex", target: "REVIEW-OK" });
    const skipped = await h.call("review", { review_id: a.review_id, skip_own: true });
    assert.equal(skipped.outcome, "partial");
    assert.match(skipped.note, /no review of your own/);
    assert.deepEqual(skipped.consensus.map((c: any) => [c.ids[0], c.status]), [["X1", "unresolved"]]);

    const b = await h.call("review", { reviewer: "codex", target: "REVIEW-BAD" });
    const failed = await h.call("review", { review_id: b.review_id, own_review: `mine\n${items(1)}` });
    assert.equal(failed.outcome, "partial");
    assert.match(failed.errors.codex, /model unavailable/);
    assert.deepEqual(failed.consensus.map((c: any) => [c.ids[0], c.status]), [["C1", "unresolved"]], "the caller's own review stands alone");
    assert.equal(failed.status, "done");
    assert.equal(failed.verdict, "unknown", "no independent review, no verdict");
    assert.match(failed.verdict_note, /no independent review was obtained/);

    // The caller's own pass is not the review's verdict when the other reviewer failed; it is kept under sides.
    // A review of one's own that raised nothing does not make the review a success: it fails with the reviewer's error, as before.
    const c = await h.call("review", { reviewer: "codex", target: "REVIEW-BAD-AGAIN" });
    const empty = await h.call("review", { review_id: c.review_id, own_review: `nothing found\n\`\`\`json\n${JSON.stringify({ verdict: "pass", coverage: { complete: true }, items: [] })}\n\`\`\`` });
    assert.equal(empty.status, "failed");
    assert.equal(empty.outcome, "error");
    assert.match(empty.error, /model unavailable/);
    assert.equal(empty.verdict, "unknown");
    assert.deepEqual(empty.sides.claude, { verdict: "pass", declared_verdict: "pass", coverage: { complete: true }, items: 0 });
    assert.deepEqual(empty.consensus, []);
    const none = await h.call("review", { reviewer: "codex", target: "REVIEW-BAD-ONCE-MORE" });
    const noBlock = await h.call("review", { review_id: none.review_id, own_review: "I looked and wrote no block" });
    assert.equal(noBlock.status, "failed", "a review of one's own with nothing parseable does not turn a failed review into a done one");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'discussion'")[0].c, 0);
  } finally {
    await h.close();
  }
});

test("discuss: with no max_turns a discussion has no length limit; it ends on AGREE in a row or CRUX (C29)", async () => {
  const h = await harness([{ target: "codex", steps: [{ reply: "Not yet.\nCONTINUE" }] }]);
  try {
    let r = await h.call("discuss", { target: "codex", topic: "long one", message: "1\nCONTINUE" });
    for (let i = 0; r.turns < 10; i++) {
      assert.equal(r.status, "open", `still open after ${r.turns} messages`);
      r = await h.call("discuss", { discussion_id: r.discussion_id, message: `${i}\nCONTINUE` });
    }
    assert.equal(r.turns, 10);
    assert.equal(r.status, "open", "past 8 messages, with no max_turns set, it goes on");
    assert.ok(h.starts().every((s) => !/final turn/.test(s.prompt)), "nobody is told a turn is the last");
    const end = await h.call("discuss", { discussion_id: r.discussion_id, message: "Enough.\nCRUX: we differ" });
    assert.equal(end.outcome, "no_agreement");
  } finally {
    await h.close();
  }
});

test("discuss and review of one's own target (same_family allow): the two sides keep separate markers, files and item ids (C16/X3)", async () => {
  const h = await harness([
    { target: "claude", match: "independent code reviewer", steps: [{ reply: `THEIR-REVIEW\n${items(1, " (theirs)")}` }] },
    { target: "claude", match: "Reconcile two independent reviews", steps: [{ reply: "R1 and C1 differ.\nCONTINUE" }] },
    { target: "claude", steps: [{ reply: "I agree with you.\nAGREE: use A" }] },
  ], { same_family: "allow" });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const d = await claude.call("discuss", { target: "claude", topic: "A or B?", message: "I propose A.\nCONTINUE" });
    assert.equal(d.reply, "I agree with you.\nAGREE: use A");
    assert.equal(d.status, "open", "the other side's AGREE is not taken for the caller's: the caller wrote CONTINUE");
    assert.equal(d.with, "claude");
    const t = fs.readFileSync(d.transcript_path, "utf8");
    assert.match(t, /## Turn 1 — caller\n\nI propose A/, "the caller's side is named apart from the participant's");
    assert.match(t, /## Turn 2 — claude\n/);
    const closed = await claude.call("discuss", { discussion_id: d.discussion_id, message: "Then we agree.\nAGREE: use A" });
    assert.equal(closed.outcome, "agree");
    assert.equal(closed.closed_by, "caller");

    const started = await claude.call("review", { reviewer: "claude", target: "src/a.ts" });
    assert.equal(started.reviewer, "claude");
    const handed = await claude.call("review", { review_id: started.review_id, own_review: `MY-REVIEW\n${items(1, " (mine)")}` });
    assert.equal(handed.phase, "reconciling");
    const dir = path.dirname(handed.their_review);
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ["caller.json", "caller.md", "claude.json", "claude.md"], "one file per side, not one overwritten by the other");
    assert.match(fs.readFileSync(path.join(dir, "caller.md"), "utf8"), /MY-REVIEW/);
    assert.match(fs.readFileSync(handed.their_review, "utf8"), /THEIR-REVIEW/);
    const ids = [...JSON.parse(fs.readFileSync(path.join(dir, "caller.json"), "utf8")).items, ...JSON.parse(fs.readFileSync(path.join(dir, "claude.json"), "utf8")).items].map((i: any) => i.id);
    assert.deepEqual(ids.sort(), ["C1", "R1"], "item ids carry distinct prefixes");
    assert.match(handed.rules, /C<n> came from the Claude reviewer, R<n> from the calling reviewer/);
  } finally {
    await h.close();
  }
});

test("review consensus is a join on item ids", () => {
  const original = [{ id: "C1", severity: "major", summary: "c1" }, { id: "C2", severity: "minor", summary: "c2" }, { id: "X1", severity: "nit", summary: "x1" }, { id: "X2", severity: "major", summary: "x2" }];
  const out = buildConsensus(original, {
    claude: [{ ids: ["C1", "X1"], status: "agreed", severity: "major" }, { ids: ["C2"], status: "agreed" }, { ids: ["X2"], status: "dropped" }],
    codex: [{ ids: ["C1", "X1"], status: "agreed", severity: "major" }, { ids: ["C2"], status: "dropped" }],
  }) as any[];
  assert.deepEqual(out.map((c) => [c.ids.join("+"), c.status]), [["C1+X1", "agreed"], ["C2", "unresolved"], ["X2", "unresolved"]]);
  assert.deepEqual(out[1].positions, { claude: { status: "agreed" }, codex: { status: "dropped" } });
  assert.deepEqual(out[2].positions, { claude: { status: "dropped" }, codex: { status: "not stated" } });
});

test("review consensus: an item is agreed or dropped only where both closing blocks give it the same status and severity (C2/C3/X2)", () => {
  const original = [
    { id: "C1", severity: "major", summary: "c1" }, { id: "C2", severity: "minor", summary: "c2" }, { id: "C3", severity: "nit", summary: "c3" }, { id: "C4", severity: "minor", summary: "c4" },
    { id: "X1", severity: "major", summary: "x1" }, { id: "X2", severity: "major", summary: "x2" }, { id: "X3", severity: "minor", summary: "x3", fix: "the original fix" }, { id: "X4", severity: "major", summary: "x4" },
  ];
  const closer = [
    { ids: ["C1", "X1"], status: "agreed", severity: "major" },
    { ids: ["C2"], status: "agree" },
    { ids: ["C3"], status: "dropped", severity: "nit" },
    { ids: ["C4"], status: true },
    { ids: ["X2"], status: "agreed", severity: "minor" },
    { ids: ["X3"], status: "agreed", summary: "a style point", fix: "nothing to do" },
    { ids: ["X4"], status: "dropped" },
  ];
  const other = [
    { ids: ["X1", "C1"], status: "agreed", severity: "major" },
    { ids: ["C2"], status: "agree" },
    { ids: ["C3"], status: "dropped" },
    { ids: ["C4"], status: "agreed" },
    { ids: ["X2"], status: "agreed", severity: "major" },
    { ids: ["X3"], status: "agreed", fix: "nothing to do" },
    { ids: ["X4"], status: "dropped", severity: "nit" },
  ];
  const out = buildConsensus(original, { claude: closer, codex: other } as any) as any[];
  assert.deepEqual(out.map((c) => [c.ids.join("+"), c.status]), [
    ["C1+X1", "agreed"], ["C2", "unresolved"], ["C3", "dropped"], ["C4", "unresolved"], ["X2", "unresolved"], ["X3", "agreed"], ["X4", "unresolved"],
  ]);
  const at = (id: string) => out.find((c) => c.ids.includes(id));
  // A malformed status is unresolved, never agreed, and each side's position is kept as written.
  assert.deepEqual(at("C2").positions, { claude: { status: "agree" }, codex: { status: "agree" } });
  assert.deepEqual(at("C4").positions, { claude: { status: "true" }, codex: { status: "agreed" } });
  // The same status at different severities is unresolved, with both severities.
  assert.deepEqual(at("X2").positions, { claude: { status: "agreed", severity: "minor" }, codex: { status: "agreed", severity: "major" } });
  assert.equal(at("X2").severity, "major", "the item keeps its original severity");
  // A block that gives no severity holds the item's own: nit and C3's nit agree, nit and X4's major do not.
  assert.equal(at("C3").severity, "nit");
  assert.deepEqual(at("X4").positions, { claude: { status: "dropped" }, codex: { status: "dropped", severity: "nit" } });
  // A field one block alone rewrites does not replace the original item's; one both give does.
  assert.deepEqual([at("X3").summary, at("X3").fix], ["x3", "nothing to do"]);

  // One side's block never settles anything alone, however complete it is.
  const alone = buildConsensus(original, { claude: closer, codex: null } as any) as any[];
  assert.ok(alone.every((c) => c.status === "unresolved" && c.positions.codex.status === "not stated"));
  assert.deepEqual(alone.map((c) => c.ids.join("+")), ["C1", "C2", "C3", "C4", "X1", "X2", "X3", "X4"], "every item is still listed");
  assert.deepEqual(alone[0].positions.claude, { status: "agreed", severity: "major", ids: ["C1", "X1"] }, "a merge the other side did not make is kept in the position");
});

test("review: a reconciliation that ends in agreement still joins both closing blocks (C2/C3/X2)", async () => {
  // The caller closes with a list that agrees C1+X1 at a lower severity and gives C2 a status that is not one; the reviewer's own AGREE block differs on both.
  const theirClose = { verdict: "fail", coverage: { complete: true }, consensus: [{ ids: ["C1", "X1"], status: "agreed", severity: "major" }, { ids: ["C2"], status: "dropped" }, { ids: ["X2"], status: "dropped" }] };
  const myClose = { verdict: "fail", coverage: { complete: true }, consensus: [{ ids: ["C1", "X1"], status: "agreed", severity: "minor" }, { ids: ["C2"], status: "yes" }, { ids: ["X2"], status: "dropped" }] };
  const h = await harness([
    { target: "codex", match: "independent code reviewer", steps: [{ reply: `review\n${items(2)}` }] },
    { target: "codex", turn: 2, steps: [{ reply: `${block(theirClose)}\nAGREE: the list above` }] },
  ]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { target: "src/a.ts" });
    const handed = await claude.call("review", { review_id: started.review_id, own_review: `mine\n${items(2)}` });
    assert.match(handed.rules, /agreed or dropped only where both your closing blocks give it that status and the same severity/);
    const closed = await claude.call("discuss", { discussion_id: handed.discussion_id, message: `${block(myClose)}\nAGREE: the list above` });
    assert.equal(closed.outcome, "agree");
    assert.equal(closed.closed_by, "claude");
    const r = await claude.call("result", { job_id: started.review_id });
    assert.equal(r.outcome, "agree");
    assert.deepEqual(r.consensus.map((c: any) => [c.ids.join("+"), c.status]), [["C1+X1", "unresolved"], ["C2", "unresolved"], ["X2", "dropped"]], "the closer's list alone settles nothing");
    assert.deepEqual(r.consensus[0].positions, { claude: { status: "agreed", severity: "minor" }, codex: { status: "agreed", severity: "major" } });
    assert.deepEqual(r.consensus[1].positions, { claude: { status: "yes" }, codex: { status: "dropped" } });
  } finally {
    await h.close();
  }
});

const block = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```";

test("review items, verdicts and coverage are read as declared, and a pass over partial coverage stands as unknown", () => {
  const r = parseReview("codex", block({
    verdict: "PASS", coverage: { complete: true, examined: ["a.ts"], not_examined: [] },
    items: [
      { n: 1, severity: "major", confidence: "high", file: "a.ts", lines: [3, 7], location: "f", summary: "s", evidence: "e", fix: "x" },
      { n: 2, lines: [9, 2], file: 5 },
      { n: 3, lines: 4 },
    ],
  }));
  assert.equal(r.verdict, "pass");
  assert.equal(r.declared, "PASS");
  assert.deepEqual(r.coverage, { complete: true, examined: ["a.ts"], not_examined: [] });
  assert.deepEqual(r.items[0], { id: "X1", severity: "major", confidence: "high", file: "a.ts", lines: [3, 7], location: "f", summary: "s", evidence: "e", fix: "x" });
  assert.deepEqual(r.items[1], { id: "X2" }, "a backwards range and a file that is not a string are left out, not guessed at");
  assert.deepEqual(r.items[2].lines, [4, 4]);

  const v = (verdict: unknown, coverage: unknown) => parseReview("claude", block({ verdict, coverage, items: [] }));
  assert.equal(v("pass", { complete: false, examined: ["a.ts"] }).verdict, "unknown");
  assert.match(v("pass", { complete: false }).note!, /pass over coverage not declared full stands as unknown/);
  assert.equal(v("pass", undefined).verdict, "unknown", "no coverage statement is not full coverage");
  assert.equal(v("pass", { complete: true, not_examined: ["the tests"] }).verdict, "unknown", "complete, but with something not examined, is partial");
  assert.equal(v("pass", { complete: true, not_examined: "the tests" }).verdict, "unknown");
  assert.equal(v("pass", { complete: "yes" }).verdict, "unknown", "only complete: true counts");
  // Whatever is listed as not examined keeps the coverage partial, whatever its type: nothing declared is dropped.
  const odd = v("pass", { complete: true, not_examined: [{ section: "security" }] });
  assert.equal(odd.verdict, "unknown");
  assert.deepEqual(odd.coverage!.not_examined, ['{"section":"security"}']);
  assert.equal(v("pass", { complete: true, not_examined: { section: "security" } }).verdict, "unknown");
  assert.equal(v("pass", { complete: true, not_examined: [7] }).verdict, "unknown");
  assert.equal(v("pass", { complete: true, not_examined: null }).verdict, "pass", "null is nothing listed");
  assert.equal(v("fail", { complete: false }).verdict, "fail", "a fail over partial coverage is still a fail");
  assert.equal(v("unknown", { complete: true }).verdict, "unknown");
  assert.equal(v("lgtm", { complete: true }).verdict, null);
  assert.match(v("lgtm", { complete: true }).note!, /not a verdict/);
  // A closing block without an items array still carries its verdict and coverage, and says what was missing.
  const bare = parseReview("claude", block({ verdict: "fail", coverage: { complete: false } }));
  assert.deepEqual([bare.declared, bare.verdict, bare.coverage, bare.items], ["fail", "fail", { complete: false }, []]);
  assert.match(bare.note!, /no items array/);
  const notArray = parseReview("claude", block({ verdict: "pass", coverage: { complete: false }, items: { n: 1 } }));
  assert.equal(notArray.verdict, "unknown");
  assert.match(notArray.note!, /items is not an array.*; a pass over coverage not declared full stands as unknown/);
  assert.equal(parseReview("claude", `${block({ verdict: "fail", items: [] })}\nlater: ${block({ unrelated: true })}`).verdict, "fail", "a block that is not a review is passed over");
  assert.equal(parseReview("claude", "no block at all").verdict, null);
  assert.equal(parseReview("claude", block({ items: [] })).declared, null);

  // The review as a whole, by the same rule, from both sides' closing blocks: a verdict both reach stands, anything else is unresolved.
  const both = (a: unknown, b: unknown) => reconciledVerdict({ claude: a as any, codex: b as any });
  const full = { complete: true };
  assert.equal(both({ consensus: [], verdict: "pass", coverage: full }, { consensus: [], verdict: "pass", coverage: full }).verdict, "pass");
  assert.equal(both({ consensus: [], verdict: "pass", coverage: { complete: false, not_examined: ["b.ts"] } }, { consensus: [], verdict: "pass", coverage: { complete: false, not_examined: ["b.ts"] } }).verdict, "unknown");
  assert.equal(both({ consensus: [] }, { consensus: [] }).verdict, "not stated");
  assert.equal(both({ consensus: [], verdict: "pass", coverage: { complete: true, not_examined: [false] } }, { consensus: [], verdict: "pass", coverage: full }).verdict, "unresolved");
  assert.equal(both({ consensus: [], verdict: "fail" }, { consensus: [], verdict: "fail" }).verdict, "fail");
  assert.deepEqual(both({ consensus: [], verdict: "pass", coverage: full }, { consensus: [], verdict: "pass" }).verdict_positions, { claude: "pass", codex: "unknown" });
  assert.deepEqual(both(null, { consensus: [], verdict: "fail" }).verdict_positions, { claude: "not stated", codex: "fail" });
  // One side's block never settles it alone: the closer's pass does not stand over the other side's fail, or over its silence.
  assert.deepEqual(both({ consensus: [], verdict: "pass", coverage: full }, { consensus: [], verdict: "fail", coverage: full }).verdict_positions, { claude: "pass", codex: "fail" });
  assert.equal(both({ consensus: [], verdict: "pass", coverage: full }, { consensus: [] }).verdict, "unresolved");
  // What both independent reviews declared not examined was examined by neither: a closing pass over it stands as unknown unless the block lists it as examined.
  const gap = [{ complete: false, not_examined: ["the tests", "docs"] }, { complete: false, examined: ["docs"], not_examined: [" The Tests "] }];
  const closingPass = { consensus: [], verdict: "pass", coverage: { complete: true, examined: ["src"] } };
  const laundered = reconciledVerdict({ claude: closingPass, codex: closingPass }, gap);
  assert.equal(laundered.verdict, "unknown");
  assert.match(laundered.closing.claude.note, /both reviews declared "the tests" not examined/);
  assert.doesNotMatch(laundered.closing.claude.note, /docs/, "one review examined docs");
  const checked = { consensus: [], verdict: "pass", coverage: { complete: true, examined: ["src", "THE TESTS"] } };
  assert.equal(reconciledVerdict({ claude: checked, codex: checked }, gap).verdict, "pass", "listed as examined in the closing block, it no longer counts against it");
  assert.equal(reconciledVerdict({ claude: closingPass, codex: closingPass }, [gap[0], { complete: false, not_examined: ["src"] }]).verdict, "pass", "two partial reviews that covered different things can pass together");
  assert.equal(reconciledVerdict({ claude: closingPass, codex: closingPass }, [gap[0], null]).verdict, "pass");
  assert.equal(reconciledVerdict({ claude: { ...closingPass, verdict: "fail" }, codex: { ...closingPass, verdict: "fail" } }, gap).verdict, "fail", "a fail is not affected");
  // Each side's closing declaration is kept, as declared and as it stands, matching or not.
  const kept = both({ consensus: [], verdict: "PASS", coverage: { complete: false, not_examined: ["the tests"] } }, { consensus: [], verdict: "fail", coverage: full });
  assert.deepEqual(kept.closing, {
    claude: { verdict: "unknown", declared_verdict: "PASS", coverage: { complete: false, not_examined: ["the tests"] }, note: "a pass over coverage not declared full stands as unknown" },
    codex: { verdict: "fail", declared_verdict: "fail", coverage: full },
  });
  assert.deepEqual(both(null, { consensus: [], verdict: "fail" }).closing.claude, null);
  assert.deepEqual(both({ consensus: [], verdict: "pass", coverage: full }, { consensus: [], verdict: "pass", coverage: full }).closing.codex, { verdict: "pass", declared_verdict: "pass", coverage: full });
});

test("consensus entries carry the items' confidence, file, lines and evidence", () => {
  const original = [
    { id: "C1", severity: "major", confidence: "high", file: "a.ts", lines: [3, 4] as [number, number], summary: "c1", evidence: "seen" },
    { id: "X1", severity: "minor", confidence: "low", file: "a.ts", lines: [3, 3] as [number, number], summary: "x1" },
  ];
  const entry = [{ ids: ["C1", "X1"], status: "agreed", severity: "major" }];
  const agreed = buildConsensus(original, { claude: entry, codex: entry }) as any[];
  assert.deepEqual(agreed[0], { ids: ["C1", "X1"], raised_by: ["claude", "codex"], status: "agreed", severity: "major", confidence: "high", summary: "c1", file: "a.ts", lines: [3, 4], location: undefined, evidence: "seen", fix: undefined });
  const joined = buildConsensus(original, {
    claude: [{ ids: ["C1", "X1"], status: "agreed", severity: "major", confidence: "high" }],
    codex: [{ ids: ["C1", "X1"], status: "agreed", severity: "major", confidence: "medium" }],
  }) as any[];
  assert.equal(joined[0].confidence, "high (claude) / medium (codex)");
  assert.equal(joined[0].severity, "major");
  assert.deepEqual([joined[0].file, joined[0].lines, joined[0].evidence], ["a.ts", [3, 4], "seen"]);
});

test("consensus entry fields are checked as items' are, so a malformed value cannot replace the item's", () => {
  const original = [{ id: "X1", severity: "major", confidence: "high", file: "a.ts", lines: [3, 4] as [number, number], summary: "x1", fix: "f" }];
  const bad = { ids: ["X1", 5], lines: "oops", file: 7, confidence: { x: 1 }, severity: "", summary: ["s"], fix: null };
  // Both closing blocks give the same entry.
  const both = (es: unknown[]) => buildConsensus(original, { claude: es, codex: es } as any) as any[];
  assert.deepEqual(both([{ ...bad, status: "agreed" }])[0], { ids: ["X1"], raised_by: ["codex"], status: "agreed", severity: "major", confidence: "high", summary: "x1", file: "a.ts", lines: [3, 4], location: undefined, evidence: undefined, fix: "f" });
  assert.deepEqual(both([{ ids: ["X1"], status: "agreed", lines: [14, 10] }])[0].lines, [3, 4], "a backwards range is left out");
  assert.deepEqual(both([{ ids: ["X1"], status: "agreed", lines: [5, 9], file: "b.ts" }])[0].lines, [5, 9], "a valid value both entries give still wins");
});

test("review of a plan: from a file or as text, with prompts that expect no code, and refused when unclear", async () => {
  const h = await harness([{ target: "codex", match: "independent plan reviewer", steps: [{ reply: block({ verdict: "fail", coverage: { complete: true }, items: [] }) }] }]);
  try {
    fs.mkdirSync(path.join(h.repo, "docs"));
    fs.writeFileSync(path.join(h.repo, "docs", "plan.md"), "PLAN-FILE-BODY\n1. add retries\n");
    const claude = await h.instance({ args: ["--host", "claude"] });

    const fromFile = await claude.call("review", { plan: "docs/plan.md", focus: "ordering" });
    assert.equal(fromFile.phase, "waiting for your own review");
    assert.equal(fs.realpathSync(fromFile.plan), fs.realpathSync(path.join(h.repo, "docs", "plan.md")));
    assert.match(fromFile.next, /work not yet done/);
    assert.match(fromFile.next, /"coverage"/);
    const text = "Step 1: add retries to fetch.\nStep 2: PLAN-TEXT-BODY";
    const asText = await claude.call("review", { plan: text });
    assert.equal(fs.readFileSync(asText.plan, "utf8"), `${text}\n`, "a plan given as text is kept with the review");
    assert.ok(asText.plan.startsWith(h.home), "in relay's own directory");
    const oneLine = await claude.call("review", { plan: "Add retries to the fetch layer" });
    assert.ok(oneLine.review_id, "one line that is not a file is the plan's text");

    await until(() => h.starts().length === 3, 10000, "three reviewers");
    const prompt = (re: RegExp) => h.starts().find((s) => re.test(s.prompt))!.prompt as string;
    const filePrompt = prompt(/is in the file/);
    assert.match(filePrompt, /^\[relay\] You are an independent plan reviewer/);
    assert.ok(filePrompt.includes(`The plan to review is in the file ${fromFile.plan}.`));
    assert.match(filePrompt, /Focus: ordering/);
    assert.match(filePrompt, /has not been done yet\. Do not expect the code, files or changes it proposes to exist/);
    assert.doesNotMatch(filePrompt, /PLAN-FILE-BODY/, "relay passes the path and does not read the file");
    assert.doesNotMatch(filePrompt, /Review target:/);
    assert.match(prompt(/PLAN-TEXT-BODY/), /----- plan -----\nStep 1: add retries to fetch\.\nStep 2: PLAN-TEXT-BODY\n----- end of plan -----/);
    assert.match(prompt(/Add retries to the fetch layer/), /independent plan reviewer/);
    assert.ok(h.starts().every((s) => s.access === "read"));
    const tasks = h.sql("SELECT task FROM nodes WHERE kind = 'review' ORDER BY created_at").map((n) => n.task);
    assert.deepEqual(tasks, [`review: the plan in ${fromFile.plan}`, "review: the plan given as text", "review: the plan given as text"]);

    assert.match((await claude.call("review", { plan: "docs/nope.md" })).error, /plan "docs\/nope\.md" is not a file in .*Give the path of the plan's file, or the plan's full text/);
    assert.match((await claude.call("review", { plan: "docs" })).error, /is not a file/, "a directory is not a plan");
    assert.match((await claude.call("review", { plan: "  " })).error, /plan is empty/);
    assert.match((await claude.call("review", { target: "src/a.ts", plan: text })).error, /not both/);
    assert.match((await claude.call("review", {})).error, /say what to review: target .* or plan/);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'review'")[0].c, 3, "nothing was started for a refused call");
  } finally {
    await h.close();
  }
});

test("review of a plan from a launched agent: only a file inside its own directory, and no word on whether one elsewhere exists", async () => {
  const h = await harness([
    { match: task("SEED"), steps: [{ reply: "seeded" }] },
    { target: "codex", match: "independent plan reviewer", steps: [{ reply: block({ verdict: "fail", coverage: { complete: true }, items: [] }) }] },
  ]);
  try {
    const outside = path.join(path.dirname(h.repo), "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "plan.md"), "1. an outside plan\n");
    fs.writeFileSync(path.join(h.repo, "plan.md"), "1. an inside plan\n");
    fs.symlinkSync(path.join(outside, "plan.md"), path.join(h.repo, "link.md"));
    const seed = await h.call("delegate", { target: "claude", task: "SEED", mode: "read", background: false });
    const child = await h.instance(await h.childOf(seed.job_id, { access: "read" }));
    const asked = async (plan: string) => (await child.call("review", { plan })).error?.replace(plan, "<plan>");
    const existing = await asked(path.join(outside, "plan.md"));
    assert.match(existing, /^plan "<plan>" is not a file in /);
    assert.equal(await asked(path.join(outside, "missing.md")), existing, "a file outside that exists and one that does not get the same reply");
    assert.equal(await asked("../outside/plan.md"), existing);
    assert.equal(await asked("link.md"), existing, "a link inside that leads outside is outside");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'review'")[0].c, 0);
    const inside = await child.call("review", { plan: "plan.md" });
    assert.equal(fs.realpathSync(inside.plan), fs.realpathSync(path.join(h.repo, "plan.md")));
    // The root session is not confined by relay, and names files where it likes.
    const root = await h.instance({ args: ["--host", "claude"] });
    assert.equal((await root.call("review", { plan: path.join(outside, "plan.md") })).plan, path.join(outside, "plan.md"));
  } finally {
    await h.close();
  }
});

test("review: each side's verdict and coverage reach the result, and the reconciled verdict is the one both closing blocks reach", async () => {
  const theirs = block({
    verdict: "pass", coverage: { complete: false, examined: ["steps 1-2"], not_examined: ["step 3"] },
    items: [{ n: 1, severity: "minor", confidence: "medium", location: "step 2", summary: "no backoff", evidence: "step 2 retries at once", fix: "add backoff" }],
  });
  const mine = block({
    verdict: "fail", coverage: { complete: true, examined: ["the whole plan", "src/fetch.ts"] },
    items: [{ n: 1, severity: "major", confidence: "high", file: "src/fetch.ts", lines: [10, 14], summary: "retries are not idempotent", evidence: "POST is retried", fix: "retry GET only" }],
  });
  const agreed = { verdict: "pass", coverage: { complete: true, examined: ["the whole plan"] }, consensus: [{ ids: ["C1", "X1"], status: "agreed", severity: "major" }] };
  const h = await harness([
    { target: "codex", match: "independent plan reviewer", steps: [{ reply: `review\n${theirs}` }] },
    { target: "codex", turn: 2, steps: [{ reply: "C1 and X1 are one finding.\nCONTINUE" }] },
    { target: "codex", turn: 3, steps: [{ reply: `Same.\n${block(agreed)}\nAGREE: list above` }] },
  ]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { plan: "1. retry failed requests\n2. retry at once\n3. ship" });
    const handed = await claude.call("review", { review_id: started.review_id, own_review: `mine\n${mine}` });
    assert.equal(handed.phase, "reconciling");
    assert.match(h.starts()[1].prompt, /what verdict and coverage the two reviews reach between them/);
    await claude.call("discuss", { discussion_id: handed.discussion_id, message: `Agreed.\n${block(agreed)}\nAGREE: list above` });
    const r = await claude.call("result", { job_id: started.review_id });
    assert.equal(r.outcome, "agree");
    assert.equal(r.verdict, "pass", "both closing blocks declare a pass over complete coverage");
    assert.deepEqual(r.closing.codex, { verdict: "pass", declared_verdict: "pass", coverage: { complete: true, examined: ["the whole plan"] } });
    assert.deepEqual(r.closing.claude, r.closing.codex);
    assert.equal(r.plan, started.plan);
    assert.deepEqual(r.sides.codex, {
      verdict: "unknown", declared_verdict: "pass", coverage: { complete: false, examined: ["steps 1-2"], not_examined: ["step 3"] }, items: 1,
      note: "a pass over coverage not declared full stands as unknown",
    });
    assert.deepEqual(r.sides.claude, { verdict: "fail", declared_verdict: "fail", coverage: { complete: true, examined: ["the whole plan", "src/fetch.ts"] }, items: 1 });
    assert.deepEqual(r.consensus[0], {
      ids: ["C1", "X1"], raised_by: ["claude", "codex"], status: "agreed", severity: "major", confidence: "high", summary: "retries are not idempotent",
      file: "src/fetch.ts", lines: [10, 14], evidence: "POST is retried", fix: "retry GET only",
    });
    const recorded = JSON.parse(fs.readFileSync(r.reviews.codex.replace(/\.md$/, ".json"), "utf8"));
    assert.equal(recorded.verdict, "unknown");
    assert.equal(recorded.items[0].location, "step 2");

    // With no review of one's own the verdict is the other review's, by the same rule.
    const h2 = await claude.call("review", { plan: "do the thing in two steps" });
    const skipped = await claude.call("review", { review_id: h2.review_id, skip_own: true });
    assert.equal(skipped.outcome, "partial");
    assert.equal(skipped.verdict, "unknown");
    assert.deepEqual(Object.keys(skipped.sides), ["codex"]);
  } finally {
    await h.close();
  }
});

test("review: the side that closes the reconciliation cannot set the verdict over the other side's", async () => {
  const theirAgree = { verdict: "fail", coverage: { complete: true }, consensus: [{ ids: ["C1", "X1"], status: "agreed", severity: "major" }] };
  const myAgree = { verdict: "pass", coverage: { complete: true }, consensus: [{ ids: ["C1", "X1"], status: "agreed", severity: "minor" }] };
  const h = await harness([
    { target: "codex", match: "independent code reviewer", steps: [{ reply: `review\n${items(1)}` }] },
    { target: "codex", turn: 2, steps: [{ reply: `One finding.\n${block(theirAgree)}\nAGREE: one finding, and it holds the work back` }] },
  ]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { target: "src/a.ts" });
    const handed = await claude.call("review", { review_id: started.review_id, own_review: `mine\n${items(1)}` });
    const closed = await claude.call("discuss", { discussion_id: handed.discussion_id, message: `Fine.\n${block(myAgree)}\nAGREE: one finding` });
    assert.equal(closed.outcome, "agree");
    const r = await claude.call("result", { job_id: started.review_id });
    assert.equal(r.outcome, "agree");
    assert.equal(r.verdict, "unresolved", "the caller closed with a pass, but the reviewer's AGREE said fail");
    assert.deepEqual(r.verdict_positions, { claude: "pass", codex: "fail" });
    assert.equal(r.closing.codex.declared_verdict, "fail");
    assert.equal(r.consensus[0].status, "unresolved", "nor the item's severity: the closer said minor, the reviewer major");
    assert.deepEqual(r.consensus[0].positions, { claude: { status: "agreed", severity: "minor" }, codex: { status: "agreed", severity: "major" } });
  } finally {
    await h.close();
  }
});

test("review: two reviews that both left something out cannot reach a pass that says nothing was left out", async () => {
  const review = (n: number) => block({ verdict: "pass", coverage: { complete: false, examined: ["src/a.ts"], not_examined: ["the tests"] }, items: Array.from({ length: n }, (_, i) => ({ n: i + 1, severity: "nit", summary: `s${i}` })) });
  const close = { verdict: "pass", coverage: { complete: true, examined: ["src/a.ts"] }, consensus: [{ ids: ["C1", "X1"], status: "dropped" }] };
  const h = await harness([
    { target: "codex", match: "independent code reviewer", steps: [{ reply: review(1) }] },
    { target: "codex", turn: 2, steps: [{ reply: `${block(close)}\nAGREE: nothing holds it back` }] },
  ]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { target: "src/a.ts" });
    const handed = await claude.call("review", { review_id: started.review_id, own_review: review(1) });
    await claude.call("discuss", { discussion_id: handed.discussion_id, message: `${block(close)}\nAGREE: nothing holds it back` });
    const r = await claude.call("result", { job_id: started.review_id });
    assert.equal(r.outcome, "agree");
    assert.equal(r.verdict, "unknown");
    assert.match(r.closing.codex.note, /both reviews declared "the tests" not examined/);
  } finally {
    await h.close();
  }
});

test("review items with an n missing, not a positive whole number, or used before get ids of their own, and the side's note says which (C4)", () => {
  const r = parseReview("codex", block({
    verdict: "fail",
    items: [{ n: 2, summary: "a" }, { n: 2, summary: "b" }, { summary: "c" }, { n: 1, summary: "d" }, { n: "3", summary: "e" }, { n: 1.5, summary: "f" }, "a finding as a string", { n: 7, summary: "g" }],
  }));
  assert.deepEqual(r.items.map((i) => [i.id, i.summary]), [["X2", "a"], ["X8", "b"], ["X9", "c"], ["X1", "d"], ["X10", "e"], ["X11", "f"], ["X7", "g"]], "each keeps its own n where it can, and the rest go above every n given");
  assert.deepEqual(r.renumbered, [
    "entry 2 of items (n 2, used before) is X8", "entry 3 of items (no n) is X9", 'entry 5 of items (n "3", not a positive whole number) is X10', "entry 6 of items (n 1.5, not a positive whole number) is X11",
  ]);
  assert.match(r.note!, /relay gave its own ids to items whose n was missing, not a positive whole number, or used before: entry 2 of items \(n 2, used before\) is X8, /);
  assert.match(r.note!, /entry 7 of items is not an object and was left out/, "nothing is dropped without a word");
  // Every item reaches the consensus list.
  assert.equal(buildConsensus(r.items, { claude: null, codex: null }).length, 7);
  // Numbered as asked, nothing is said.
  const plain = parseReview("codex", block({ items: [{ n: 1 }, { n: 2 }] }));
  assert.deepEqual([plain.items.map((i) => i.id), plain.renumbered, plain.note], [["X1", "X2"], undefined, undefined]);
});

test("review: items with colliding numbers are all reconciled, and both sides are told their ids (C4)", async () => {
  const theirs = block({ verdict: "fail", coverage: { complete: true }, items: [{ n: 1, severity: "major", summary: "first" }, { n: 1, severity: "minor", summary: "second, numbered 1 again" }] });
  const close = { verdict: "fail", coverage: { complete: true }, consensus: [{ ids: ["C1", "X1"], status: "agreed", severity: "major" }, { ids: ["X2"], status: "dropped" }] };
  const h = await harness([
    { target: "codex", match: "independent code reviewer", steps: [{ reply: `review\n${theirs}` }] },
    { target: "codex", turn: 2, steps: [{ reply: `${block(close)}\nAGREE: the list above` }] },
  ]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { target: "src/a.ts" });
    const handed = await claude.call("review", { review_id: started.review_id, own_review: `mine\n${items(1)}` });
    assert.equal(handed.their_items, 2);
    const said = "entry 2 of items (n 1, used before) is X2";
    assert.ok(handed.ids_note.includes(`the codex review: ${said}`), "the caller is told");
    assert.ok(fs.readFileSync(handed.their_review, "utf8").includes(said), "and so is anyone reading the review's file");
    assert.ok(h.starts()[1].prompt.includes(said), "and so is the reviewer, whose own numbering it was");
    await claude.call("discuss", { discussion_id: handed.discussion_id, message: `${block(close)}\nAGREE: the list above` });
    const r = await claude.call("result", { job_id: started.review_id });
    assert.deepEqual(r.consensus.map((c: any) => [c.ids.join("+"), c.status, c.summary]), [["C1+X1", "agreed", "issue 1"], ["X2", "dropped", "second, numbered 1 again"]]);
    assert.ok(r.sides.codex.note.includes(said));
  } finally {
    await h.close();
  }
});

test("review: the verdict \"not stated\" is in the documented vocabulary, in docs/usage.md, the glossary and both review skills (C21)", () => {
  // Relay returns it where no verdict was declared: for a side, and for the review when neither closing block declares one.
  assert.equal(reconciledVerdict({ claude: { consensus: [] }, codex: { consensus: [] } }).verdict, "not stated");
  assert.deepEqual(reconciledVerdict({ claude: { consensus: [] }, codex: { consensus: [], verdict: "fail" } }).verdict_positions, { claude: "not stated", codex: "fail" });
  const root = path.resolve(import.meta.dirname, "..");
  for (const f of ["docs/usage.md", "GLOSSARY.md", "adapters/claude/relay/skills/review/SKILL.md", "adapters/codex/relay/skills/relay-review/SKILL.md"]) {
    const sentences = fs.readFileSync(path.join(root, f), "utf8").split(/(?<=\.)\s/);
    assert.ok(sentences.some((s) => /not stated/.test(s) && /verdict/.test(s)), `${f} says what the verdict "not stated" means`);
  }
});

test("review: a verdict that is not a string is reported, not run, and does not strand the review before reconciling", async () => {
  // A parsed object's toString is data: String() on {"toString": "pass"} throws.
  const odd = parseReview("codex", block({ verdict: { toString: "pass" }, coverage: { complete: true }, items: [] }));
  assert.equal(odd.verdict, null);
  assert.equal(odd.declared, '{"toString":"pass"}');
  assert.match(odd.note!, /^\{"toString":"pass"\} is not a verdict/);
  assert.equal(parseReview("codex", block({ verdict: 7, items: [] })).declared, "7");

  const h = await harness([
    { target: "codex", match: "independent code reviewer", steps: [{ reply: `odd\n${block({ verdict: { toString: "pass" }, coverage: { complete: true }, items: [] })}` }] },
    { target: "codex", turn: 2, steps: [{ reply: "nothing to reconcile\nCONTINUE" }] },
  ]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { target: "src/a.ts" });
    const handed = await claude.call("review", { review_id: started.review_id, own_review: `mine\n${items(1)}` });
    assert.equal(handed.tool_error, undefined);
    assert.equal(handed.phase, "reconciling");
    assert.equal(typeof handed.discussion_id, "string");
    const recorded = JSON.parse(fs.readFileSync(handed.their_review.replace(/\.md$/, ".json"), "utf8"));
    assert.equal(recorded.verdict, null);
  } finally {
    await h.close();
  }
});

test("parsers: final report and discussion markers", () => {
  const r = parseReport("did things\n\n## RELAY REPORT\nSummary: added x\nand y\n**Files changed:** a.ts, b.ts\nBranch: relay/j_1\nTests run: npm test (12 pass)\nOpen issues: none");
  assert.deepEqual(r, { summary: "added x\nand y", files_changed: "a.ts, b.ts", branch: "relay/j_1", tests_run: "npm test (12 pass)", open_issues: "none", report_parsed: true });
  assert.equal(parseReport("no report here").report_parsed, false);
  assert.deepEqual(parseMarker("text\nAGREE: do X\nwith detail"), { kind: "AGREE", text: "do X\nwith detail" });
  assert.deepEqual(parseMarker("text\n**CRUX:** who owns retries"), { kind: "CRUX", text: "who owns retries" });
  assert.deepEqual(parseMarker("I would continue this, but\nCONTINUE"), { kind: "CONTINUE" });
  assert.deepEqual(parseMarker("We agree: mostly."), { kind: "NONE" });
  // A marker at the end of the last line, after a sentence, is read when it is the only one in the message.
  assert.deepEqual(parseMarker("Point 2 persuaded me. AGREE: use option A"), { kind: "AGREE", text: "use option A", inline: true });
  assert.deepEqual(parseMarker("We still differ.\nI cannot accept that. CRUX: who owns retries"), { kind: "CRUX", text: "who owns retries", inline: true });
  assert.deepEqual(parseMarker("More to say on point 3. CONTINUE"), { kind: "CONTINUE", inline: true });
  // Anything less clear is not read: a marker inside a sentence, two of them, or a quoted last line.
  assert.deepEqual(parseMarker("I will not write AGREE: yet"), { kind: "NONE" });
  assert.deepEqual(parseMarker("You said CRUX: retries.\nFine. AGREE: use A"), { kind: "NONE" });
  assert.deepEqual(parseMarker("> Done. AGREE: use A"), { kind: "NONE" });
  // Nor one quoted mid-line, one followed by more sentences or by another marker, or a CONTINUE after a quotation mark.
  assert.deepEqual(parseMarker('You wrote "Done. AGREE: use A" earlier'), { kind: "NONE" });
  assert.deepEqual(parseMarker("You wrote “Done. CRUX: retries”"), { kind: "NONE" });
  assert.deepEqual(parseMarker("The log says `ok. AGREE: ship it`"), { kind: "NONE" });
  assert.deepEqual(parseMarker("Fine. AGREE: use A. CONTINUE"), { kind: "NONE" });
  assert.deepEqual(parseMarker("Fine. AGREE: use A. But I want to check B first."), { kind: "NONE" });
  assert.deepEqual(parseMarker("Fine. AGREE: use A CRUX: retries"), { kind: "NONE" });
  assert.deepEqual(parseMarker("Its last words were 'stop. CONTINUE"), { kind: "NONE" });
  // An apostrophe inside a word is not a quotation mark, and a conclusion may end with a full stop.
  assert.deepEqual(parseMarker("I don't mind. AGREE: use option A."), { kind: "AGREE", text: "use option A.", inline: true });
  assert.deepEqual(parseMarker("There's more on point 3. CONTINUE"), { kind: "CONTINUE", inline: true });
});

test("supervise: write jobs get a worktree, a checkpoint commit, a parsed report, resume and merge", async () => {
  const rules: Rule[] = [
    { match: task("WRITE"), turn: 1, steps: [{ write: "feature.txt", content: "v1\n" }, { reply: "ok\n## RELAY REPORT\nSummary: wrote feature\nFiles changed: feature.txt\nBranch: mine\nTests run: none\nOpen issues: none" }] },
    { match: "make it v2", steps: [{ write: "feature.txt", content: "v2\n" }, { reply: "updated" }] },
  ];
  const h = await harness(rules);
  try {
    fs.writeFileSync(path.join(h.repo, "dirty.txt"), "uncommitted\n");
    const started = await h.call("delegate", { target: "codex", task: "WRITE", mode: "write", scope: ["src/"] });
    assert.match(started.branch, /^relay\/j_/);
    assert.match(started.note, /uncommitted changes are not visible/);
    const done = await h.call("status", { id: started.job_id, wait_s: 20 });
    assert.equal(done.status, "done");

    const s = h.starts()[0];
    assert.notEqual(s.cwd, h.repo, "runs in its own worktree");
    assert.equal(s.access, "write");
    assert.match(s.prompt, /Your scope: src\//);
    assert.ok(!fs.existsSync(path.join(s.cwd, "dirty.txt")));
    const ctx = JSON.parse(fs.readFileSync(path.join(s.cwd, ".relay", "context.json"), "utf8"));
    assert.deepEqual(ctx, { run_id: h.sql("SELECT run_id FROM nodes")[0].run_id, node_id: started.job_id, depth: 1 });

    const res = await h.call("result", { job_id: started.job_id });
    assert.equal(res.result.summary, "wrote feature");
    assert.equal(res.result.report_parsed, true);
    assert.deepEqual(res.result.files_changed_git, ["feature.txt"], "relay committed the work and .relay/ stayed out of it");
    assert.equal(res.result.branch, started.branch);

    // resume continues the same session; the message is delivered as the next turn.
    const again = await h.call("resume", { job_id: started.job_id, message: "make it v2" });
    assert.equal(again.status, "queued");
    await h.call("status", { id: started.job_id, wait_s: 20 });
    const second = h.starts()[1];
    assert.equal(second.resumed, true);
    assert.equal(second.sessionId, s.sessionId);

    const merged = await h.call("merge", { job_id: started.job_id });
    assert.equal(merged.status, "merged");
    assert.equal(fs.readFileSync(path.join(h.repo, "feature.txt"), "utf8"), "v2\n");

    // The worktree goes once the branch is merged, and comes back if the job is resumed.
    assert.equal(merged.worktree_removed, true);
    assert.ok(!fs.existsSync(s.cwd), "worktree removed after merge");
    await h.call("resume", { job_id: started.job_id, message: "one more look" });
    assert.equal((await h.call("status", { id: started.job_id, wait_s: 20 })).status, "done");
    const third = h.starts()[2];
    assert.equal(third.cwd, s.cwd, "the resumed turn ran in the restored worktree");
    assert.equal(fs.readFileSync(path.join(s.cwd, "feature.txt"), "utf8"), "v2\n");

    // clean removes leftovers, deletes merged branches, and keeps unmerged work.
    const other = await h.call("delegate", { target: "codex", task: "WRITE", mode: "write", background: false });
    const cleaned = JSON.parse(h.cli("clean"));
    assert.equal(cleaned.worktrees_removed, 2);
    assert.deepEqual(cleaned.branches_deleted, [started.branch]);
    assert.equal(cleaned.unmerged_branches_kept.length, 1);
    assert.ok(cleaned.unmerged_branches_kept[0].startsWith(other.branch));
    assert.ok(!fs.existsSync(s.cwd));

    const outside = await h.instance({ cwd: h.home });
    const noRepo = await outside.call("delegate", { target: "claude", task: "X", mode: "write" });
    assert.equal(noRepo.refused, true);
    assert.match(noRepo.reason, /not inside a git repository/);

    const tree = h.cli("tree");
    assert.match(tree, /job:codex\s+write\s+d1\s+done/);
  } finally {
    await h.close();
  }
});

test("supervise: pending handles, queued resume, timeout, and lost workers", async () => {
  const h = await harness(
    [
      // Held until the follow-up has been queued behind it.
      { match: task("LONG"), turn: 1, steps: [{ await: "long-may-finish" }, { reply: "long done" }] },
      { match: task("HANG"), steps: [{ sleep: 60000 }, { reply: "never" }] },
      // Held until the call has returned its handle.
      { match: "QSLOW", steps: [{ await: "qslow-may-finish" }, { reply: "slow answer" }] },
    ],
    { block_s: 1 },
  );
  // The timeout has a harness of its own, so that no other job here runs against the clock.
  const timed = await harness([{ match: task("HANG"), steps: [{ sleep: 60000 }, { reply: "never" }] }], { job_timeout_s: 2 });
  try {
    // A blocking call that outlasts block_s returns a handle instead of timing out the host.
    const p = await h.call("ask", { target: "codex", message: "QSLOW" });
    assert.equal(p.pending, true);
    assert.equal(p.id, p.thread_id);
    release(h, "qslow-may-finish");
    let st = await h.call("status", { id: p.id, wait_s: 1 });
    while (st.status !== "done") st = await h.call("status", { id: p.id, wait_s: 1 });
    assert.equal(st.result.reply, "slow answer");

    // resume on a running job queues the message behind the current turn.
    const long = await h.call("delegate", { target: "claude", task: "LONG", mode: "read" });
    await until(() => h.starts().some((s) => /LONG$/.test(s.prompt)), 10000, "LONG to start");
    const q = await h.call("resume", { job_id: long.job_id, message: "and then this" });
    assert.equal(q.status, "queued_behind_current_turn");
    release(h, "long-may-finish");
    await until(() => h.starts().some((s) => s.prompt === "and then this"), 15000, "the queued message to be delivered");
    const follow = h.starts().find((s) => s.prompt === "and then this")!;
    assert.equal(follow.resumed, true);

    // Per-job wall-clock timeout.
    const hang = await timed.call("delegate", { target: "codex", task: "HANG", mode: "read" });
    await until(() => timed.sql("SELECT status FROM nodes WHERE id = ?", hang.job_id)[0].status === "timeout", 30000, "the job to time out");
    assert.match(timed.sql("SELECT error FROM nodes WHERE id = ?", hang.job_id)[0].error, /timed out after 2s/);

    // A worker that dies is reported as lost rather than running forever.
    const lost = await h.call("delegate", { target: "claude", task: "HANG", mode: "read" });
    await until(() => h.sql("SELECT agent_pgid FROM nodes WHERE id = ?", lost.job_id)[0].agent_pgid > 0, 10000, "agent to start");
    const row = h.sql("SELECT worker_pid, agent_pgid FROM nodes WHERE id = ?", lost.job_id)[0];
    process.kill(row.worker_pid, "SIGKILL");
    // The root session's watch reaps every few seconds: finding the worker dead, it kills the
    // agent's group itself (stopOrphan) and then marks the job lost. Its tick can fall before this
    // signal, which first reads the whole process table (the group-signal guard), longer under
    // load: the group is then gone already, which is what this signal is for. Gone is ESRCH once its
    // processes have been reaped, and EPERM while they are still zombies (macOS answers a signal to
    // a group holding only zombies with EPERM): the agent, its worker dead, waits for launchd to reap it.
    try {
      sendGroupSignal(row.agent_pgid, "SIGKILL");
    } catch (err) {
      if (!["ESRCH", "EPERM"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
    }
    await until(() => !alive(row.worker_pid), 30000, "the worker to be gone");
    assert.equal((await h.call("status", { id: lost.job_id })).status, "lost");
  } finally {
    await h.close();
    await timed.close();
  }
});

test("parsers: quoted markers and tagged code fences do not mislead", async () => {
  const { lastJsonBlock } = await import("../dist/core/prompts.js");
  // A quoted copy of the other side's AGREE is not this turn's marker.
  assert.deepEqual(parseMarker("> AGREE: use X\nI disagree, see point 2.\nCONTINUE — see point 2"), { kind: "CONTINUE" });
  assert.deepEqual(parseMarker("> AGREE: use X\nNo marker of my own."), { kind: "NONE" });
  const msg = "Look at this:\n```ts\nconst a = 1;\n```\nand\n```bash\nnpm test\n```\n```json\n{\"items\": [{\"n\": 1}]}\n```\n";
  assert.deepEqual(lastJsonBlock(msg, (v: any) => v.items ?? null), [{ n: 1 }]);
});

test("merge: a conflict is resolved in two steps and unrelated work stays out of the merge commit", async () => {
  const h = await harness([{ match: task("EDIT"), steps: [{ write: "README.md", content: "from the job\n" }, { reply: "done" }] }]);
  try {
    const { execFileSync } = await import("node:child_process");
    const g = (...a: string[]) => execFileSync("git", a, { cwd: h.repo, encoding: "utf8" });
    const job = await h.call("delegate", { target: "codex", task: "EDIT", mode: "write", background: false });
    fs.writeFileSync(path.join(h.repo, "README.md"), "from the root\n");
    g("commit", "-qam", "root edit");
    fs.writeFileSync(path.join(h.repo, "wip.txt"), "unrelated work in progress\n");

    assert.equal((await h.call("merge", { job_id: job.job_id, continue: true })).error, "no merge is in progress here");
    const first = await h.call("merge", { job_id: job.job_id });
    assert.equal(first.status, "conflict");
    assert.deepEqual(first.files, ["README.md"]);
    const stillMarked = await h.call("merge", { job_id: job.job_id, continue: true });
    assert.equal(stillMarked.status, "conflict");
    fs.writeFileSync(path.join(h.repo, "README.md"), "resolved\n");
    const done = await h.call("merge", { job_id: job.job_id, continue: true });
    assert.equal(done.status, "merged");
    assert.match(g("status", "--porcelain"), /\?\? wip\.txt/, "the untracked file was not swept into the merge commit");
    assert.doesNotMatch(g("show", "--stat", "HEAD"), /wip\.txt/);
  } finally {
    await h.close();
  }
});

test("cwd: a root started outside the project names the directory, but for a question; a child cannot", async () => {
  const h = await harness([{ match: task("WHERE"), steps: [{ call: "delegate", args: { target: "codex", task: "X", mode: "read", cwd: "/tmp" } }, { reply: "{{last}}" }] }]);
  try {
    const app = await h.instance({ cwd: "/" });
    const lost = await app.call("delegate", { target: "claude", task: "WHERE", mode: "read" });
    assert.equal(lost.refused, true);
    assert.match(lost.reason, /Pass cwd/);
    assert.match((await app.call("ask", { target: "claude", message: "hi", cwd: path.join(h.repo, "missing") })).reason, /not an existing directory/);

    const job = await app.call("delegate", { target: "claude", task: "WHERE", mode: "write", cwd: h.repo, background: false });
    assert.equal(job.status, "done");
    assert.match(job.base_sha, /^[0-9a-f]{40}$/, "the worktree was made from the named repository");
    const child = h.ends()[0];
    assert.equal(child.calls[0].result.refused, true, "a launched agent cannot choose another directory");
    assert.match(child.calls[0].result.reason, /only be set by the root session/);
    // A question that needs no project goes on without cwd, not in /, but in a new, empty directory
    // of its own under relay's consult directory (review r_f1c46bd4 C1+X2); its follow-up goes on there.
    const asked = await app.call("ask", { target: "claude", message: "hi" });
    assert.equal(asked.refused, undefined, JSON.stringify(asked));
    const consult = `${h.home.replace(/\/+$/, "")}-consult`;
    const own = h.sql("SELECT cwd FROM nodes WHERE id = ?", asked.thread_id)[0].cwd as string;
    assert.equal(path.dirname(own), consult);
    assert.match(path.basename(own), /^c-/);
    assert.equal(h.starts().at(-1)!.cwd, fs.realpathSync(own), "the agent ran there");
    for (const d of [consult, own]) assert.equal((fs.statSync(d).mode & 0o777), 0o700, d);
    assert.deepEqual(fs.readdirSync(own), []);
    const again = await app.call("ask", { target: "claude", message: "another" });
    assert.notEqual(h.sql("SELECT cwd FROM nodes WHERE id = ?", again.thread_id)[0].cwd, own, "each thread has its own");
    const followed = await app.call("ask", { thread_id: asked.thread_id, message: "more" });
    assert.equal(followed.refused, undefined, JSON.stringify(followed));
    assert.equal(h.starts().at(-1)!.cwd, fs.realpathSync(own), "the follow-up went on where the thread began");
    // A new discussion or review still needs a project.
    assert.match((await app.call("discuss", { target: "codex", topic: "t", message: "m" })).reason, /Pass cwd/);
    assert.match((await app.call("review", { reviewer: "codex", target: "README.md" })).reason, /Pass cwd/);
    assert.equal((await app.call("merge", { job_id: job.job_id, cwd: h.repo })).status, "up_to_date");
  } finally {
    await h.close();
  }
});

test("cwd: relay's consult directory must be a plain directory of this user's, and no grant or file approval reaches it", async () => {
  const h = await harness([{ match: task("PLANT"), steps: [{ request: { edit: "$RELAY_HOME-consult/c-x/AGENTS.md" } }, { reply: "done" }] }]);
  try {
    const app = await h.instance({ cwd: "/" });
    const consult = `${h.home.replace(/\/+$/, "")}-consult`;
    // A link there is refused, saying why, and nothing is made where it leads (review r_f1c46bd4 C3+X1).
    const elsewhere = path.join(path.dirname(h.home), "consult-elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, consult);
    const refused = await app.call("ask", { target: "claude", message: "hi" });
    assert.equal(refused.refused, true, JSON.stringify(refused));
    assert.match(refused.reason, /could not make a directory to ask in without a project: relay's private directory .* must be a plain directory owned by this user\. Pass cwd/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    // A directory others can read is made private.
    fs.unlinkSync(consult);
    fs.mkdirSync(consult);
    fs.chmodSync(consult, 0o755);
    const asked = await app.call("ask", { target: "claude", message: "hi" });
    assert.equal(asked.refused, undefined, JSON.stringify(asked));
    assert.equal(fs.statSync(consult).mode & 0o777, 0o700);
    // It holds only the directories relay made there: anything else, which an agent asking below it
    // could load as instructions from a parent directory, refuses the ask until it is removed.
    for (const [name, make] of [["CLAUDE.md", (p: string) => fs.writeFileSync(p, "x")], [".claude", (p: string) => fs.mkdirSync(p)], ["c-linked", (p: string) => fs.symlinkSync(elsewhere, p)]] as const) {
      const stray = path.join(consult, name);
      make(stray);
      const no = await app.call("ask", { target: "claude", message: "hi" });
      assert.equal(no.refused, true, `${name}: ${JSON.stringify(no)}`);
      assert.match(no.reason, new RegExp(`holds "${name.replace(".", "\\.")}", which relay did not put there, and which an agent asking below it could load\\. Remove it`), name);
      fs.rmSync(stray, { recursive: true, force: true });
    }
    assert.equal((await app.call("ask", { target: "claude", message: "hi" })).refused, undefined);
    // No job may be granted it, nor be given a file change there (review r_f1c46bd4 X2).
    const granted = await h.call("delegate", { target: "codex", task: "GRANT", mode: "write", grant: { write_paths: [consult] } });
    assert.equal(granted.refused, true, JSON.stringify(granted));
    assert.match(granted.reason, /overlaps the directory questions without a project are asked in/);
    const job = await h.call("delegate", { target: "claude", task: "PLANT", mode: "write", background: false });
    assert.ok(job.job_id, JSON.stringify(job));
    const results = (h.ends().at(-1)!.calls as Rec[]).filter((c) => c.tool === "(approval request)").map((c) => JSON.stringify(c.result));
    assert.equal(results.length, 1);
    assert.match(results[0], /consult\/c-x\/AGENTS\.md is inside relay's own directories, which no job may change/);
    assert.equal(h.sql("SELECT count(*) AS n FROM requests")[0].n, 0, "nobody was asked");
    assert.equal(fs.existsSync(path.join(consult, "c-x")), false);
  } finally {
    await h.close();
  }
});

test("model and effort reach the other family's CLI for discuss and review", async () => {
  const h = await harness([
    { match: "independent code reviewer", steps: [{ reply: items(1) }] },
    { steps: [{ reply: "AGREE: fine" }] },
  ]);
  try {
    const flags = (s: { argv: string[] }) => s.argv.join(" ");
    // Codex turns that go through the app server carry model and effort as parameters, not flags.
    const cxModel = (s: any) => (s.via ? s.model : (/ -m (\S+)/.exec(flags(s))?.[1] ?? null));
    const cxEffort = (s: any) => (s.via ? s.effort : (/model_reasoning_effort="(\w+)"/.exec(flags(s))?.[1] ?? null));
    await h.call("discuss", { target: "claude", topic: "t", message: "m\nCONTINUE", model: "opus", effort: "low" });
    await h.call("discuss", { target: "codex", topic: "t", message: "m\nCONTINUE", model: "gpt-x" });
    const [dc, dx] = h.starts();
    assert.match(flags(dc), /--model opus --effort low/);
    assert.equal(cxModel(dx), "gpt-x");
    assert.equal(cxEffort(dx), null, "an unset effort uses the CLI default");

    await h.call("review", { reviewer: "claude", target: "README.md", model: "haiku" });
    await h.call("review", { reviewer: "codex", target: "README.md", effort: "high" });
    await until(() => h.starts().length === 4, 10000, "both reviewers");
    // The two reviews start concurrently: pick each reviewer's start by its target, not by order.
    const reviews = h.starts().slice(2);
    const rc = reviews.find((s) => s.target === "claude")!, rx = reviews.find((s) => s.target === "codex")!;
    assert.ok(rc && rx, JSON.stringify(reviews.map((s) => s.target)));
    assert.match(flags(rc), /--model haiku/);
    assert.doesNotMatch(flags(rc), /--effort/);
    assert.equal(cxEffort(rx), "high");
    assert.equal(cxModel(rx), null);
    assert.equal(rc.prompt, rx.prompt, "model choice does not leak into the reviewers' instructions");
  } finally {
    await h.close();
  }
});

test("configured default model and effort apply when a call names none, and a call can override them", async () => {
  const h = await harness([], { default_model: { claude: "opus", codex: "gpt-default" }, default_effort: { claude: "high", codex: "high" } });
  try {
    const flags = (s: { argv: string[] }) => s.argv.join(" ");
    await h.call("ask", { target: "claude", message: "a" });
    await h.call("ask", { target: "codex", message: "b" });
    await h.call("ask", { target: "codex", message: "c", model: "gpt-other", effort: "low" });
    const [a, b, c] = h.starts();
    assert.match(flags(a), /--model opus --effort high/);
    assert.deepEqual([b.model, b.effort], ["gpt-default", "high"]);
    assert.deepEqual([c.model, c.effort], ["gpt-other", "low"]);
  } finally {
    await h.close();
  }
});

test("grant: only the root can widen a write job, on delegate or on resume", async () => {
  const h = await harness([
    { match: task("PARENT"), steps: [{ call: "delegate", args: { target: "codex", task: "X", mode: "write", grant: { network: true } } }, { reply: "{{last}}" }] },
  ]);
  try {
    const extra = path.join(path.dirname(h.home), "shared");
    fs.mkdirSync(extra);
    // Relay's own state, and the place job worktrees live, can never be granted.
    assert.match((await h.call("delegate", { target: "codex", task: "A", mode: "write", grant: { write_paths: [h.home] } })).reason, /overlaps relay's control directory/);
    assert.match((await h.call("delegate", { target: "codex", task: "A", mode: "write", grant: { write_paths: [path.dirname(h.home)] } })).reason, /overlaps/);
    const flags = (s: { argv: string[] }) => s.argv.join(" ");
    const cx = await h.call("delegate", { target: "codex", task: "A", mode: "write", grant: { network: true, write_paths: [extra] }, background: false });
    assert.deepEqual(cx.grant, { network: true, write_paths: [extra] });
    const a = h.starts()[0];
    assert.ok(flags(a).includes("permissions.relay.network.enabled=true"));
    // The granted directory is a workspace root of relay's profile: writable, with harness configuration at its top read-only.
    assert.ok(flags(a).includes(`permissions.relay.workspace_roots={${JSON.stringify(extra)}=true}`));
    assert.match(a.prompt, new RegExp(`Granted beyond your sandbox: network and web access; write access to ${extra}`));

    const plain = await h.call("delegate", { target: "claude", task: "B", mode: "write", background: false });
    const b = h.starts()[1];
    assert.doesNotMatch(flags(b), /--add-dir/);
    // Claude jobs run under the never floor: no command can be approved out of the sandbox, so the prompt never offers it.
    assert.match(b.prompt, /you may ask for approval: make the edit with your file tools.*cannot be approved to run outside it: report it under Open issues/);
    assert.doesNotMatch(b.prompt, /retry (?:that one command|it) with the sandbox disabled(?! \(that is refused\))/);
    await h.call("resume", { job_id: plain.job_id, message: "try again", grant: { write_paths: [extra] } });
    await h.call("status", { id: plain.job_id, wait_s: 20 });
    const b2 = h.starts()[2];
    assert.ok(flags(b2).includes(`--add-dir ${extra}`), "the grant applies from the next turn");
    assert.match(b2.prompt, /You have now been granted: write access to/);
    const settings = JSON.parse(fs.readFileSync(b2.argv[b2.argv.indexOf("--settings") + 1], "utf8"));
    assert.deepEqual(settings.sandbox.filesystem.allowWrite, [b2.env.tmpdir, extra]);
    assert.deepEqual(settings.sandbox.network, { strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false }, "no network: the sandbox refuses by itself");

    assert.match((await h.call("delegate", { target: "claude", task: "C", mode: "read", grant: { write_paths: [extra] } })).reason, /not write paths/);
    assert.match((await h.call("delegate", { target: "claude", task: "C", mode: "write", grant: { write_paths: ["relative/dir"] } })).reason, /absolute/);
    const parent = await h.call("delegate", { target: "claude", task: "PARENT", mode: "write", background: false });
    assert.equal(parent.status, "done");
    const call = h.ends().find((e) => e.calls.length)!.calls[0];
    assert.equal(call.result.refused, true);
    assert.match(call.result.reason, /only the root session can grant/);
  } finally {
    await h.close();
  }
});

test("shell network (claude): without a grant the sandbox refuses on its own and says so, and the agent is told what does work", async () => {
  const h = await harness();
  const noAsking = await harness([], { escalation: false });
  try {
    const settingsOf = (s: { argv: string[] }) => JSON.parse(fs.readFileSync(s.argv[s.argv.indexOf("--settings") + 1], "utf8"));
    for (const mode of ["read", "write"] as const) {
      await h.call("delegate", { target: "claude", task: `PLAIN ${mode}`, mode, background: false });
      const plain = h.starts().at(-1)!;
      // Claude Code under -p answers the sandbox's network question with "user denied" and never asks relay;
      // strictAllowlist makes the sandbox refuse by itself, as "not on the allow list".
      assert.deepEqual(settingsOf(plain).sandbox.network, { strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false }, mode);
      assert.deepEqual([plain.env.proxies, plain.env.srtDebug], [{}, null], `${mode}: no proxy without the network`);
      assert.match(plain.prompt, /Your shell commands have no network access: the sandbox refuses connections by itself, and nobody is asked/, mode);
      // The advice must not promise an approval prompt: the permission policy decides.
      assert.match(plain.prompt, /use WebSearch or WebFetch, which, depending on permission policy, may already be allowed, may ask for approval, or may be denied outright/, mode);
      assert.doesNotMatch(plain.prompt, /WebFetch or WebSearch, which ask for approval|WebSearch or WebFetch, which ask for approval/, mode);
      assert.match(plain.prompt, /network grant/, mode);

      await h.call("delegate", { target: "claude", task: `GRANTED ${mode}`, mode, grant: { network: true }, background: false });
      const granted = h.starts().at(-1)!;
      // Relay's own proxy for the turn, for the sandbox (both its ports) and the Claude process alike (relay 1.0.5).
      const network = settingsOf(granted).sandbox.network;
      assert.ok(Number.isInteger(network.httpProxyPort) && network.httpProxyPort > 0, mode);
      assert.deepEqual(network, { httpProxyPort: network.httpProxyPort, socksProxyPort: network.httpProxyPort, strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false }, mode);
      assert.deepEqual([settingsOf(granted).env.NO_PROXY, settingsOf(granted).env.no_proxy], ["", ""], `${mode}: nothing exempt, whatever a user's settings env says`);
      assert.ok(!JSON.stringify(settingsOf(granted)).includes("relay:"), `${mode}: the proxy's token is not written to the settings file`);
      const url = `http://***@127.0.0.1:${network.httpProxyPort}`;
      assert.deepEqual(granted.env.proxies, { ALL_PROXY: url, HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: "", all_proxy: url, http_proxy: url, https_proxy: url, no_proxy: "" }, mode);
      assert.equal(granted.env.srtDebug, "1", mode);
      assert.doesNotMatch(granted.prompt, /no network access/, mode);
    }
    // Codex's sandbox asks relay itself, so its agents are not told this.
    await h.call("delegate", { target: "codex", task: "PLAIN codex", mode: "read", background: false });
    assert.doesNotMatch(h.starts().at(-1)!.prompt, /no network access/);
    // Where nothing can be asked, the web tools cannot ask either.
    await noAsking.call("delegate", { target: "claude", task: "PLAIN", mode: "read", background: false });
    const quiet = noAsking.starts().at(-1)!.prompt;
    assert.match(quiet, /Your shell commands have no network access/);
    assert.doesNotMatch(quiet, /which ask for approval/);
  } finally {
    await h.close();
    await noAsking.close();
  }
});

test("shell network (claude): a network turn stops unless Claude's sandbox confirms relay's proxy and Claude's own traffic uses it", async () => {
  const h = await harness();
  try {
    const granted = { target: "claude", task: "GATED", mode: "read", grant: { network: true }, background: false };
    // Claude reports both ports as relay's (the stub does when SRT_DEBUG is set), and its first message
    // comes after a request through the proxy with the token: the turn runs.
    const ok = await (await h.instance({ env: { STUB_ASSISTANT: "1" } })).call("delegate", granted);
    assert.equal(ok.status, "done", JSON.stringify(ok));
    const log = fs.readFileSync(path.join(h.home, "runs", ok.run_id, "nodes", ok.job_id, "agent.log"), "utf8");
    assert.match(log, /\[stderr\] \[SandboxDebug\] Using external HTTP proxy on port \d+/, "the sandbox's report is kept in the agent log");
    const proxyLog = fs.readFileSync(path.join(h.home, "runs", ok.run_id, "nodes", ok.job_id, "proxy.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // Its model request reached the model endpoint (the test home's stub, a closed port) through the proxy, with the token.
    assert.deepEqual(proxyLog.map((d) => [d.event, d.via, d.target, d.token, d.stub]), [["allow", "POST", "model.relay-test.invalid:80", true, true]], JSON.stringify(proxyLog));
    assert.match(log, /"type":"stream_event".*"message_start"/, "Claude streams the start of its response (--include-partial-messages), and relay checks there");

    // The sandbox reports another port (settings relay does not control replaced relay's): stopped at once.
    const other = await (await h.instance({ env: { STUB_SRT_PORT: "1" } })).call("delegate", granted);
    assert.equal(other.status, "failed", JSON.stringify(other));
    assert.match(other.error, /reported a proxy port other than relay's/);
    assert.doesNotMatch(other.error, /SandboxDebug/, "the debug output stays out of the result");
    // It reports nothing by Claude's first message (a version that no longer does): stopped then.
    const silent = await (await h.instance({ env: { STUB_SRT_SILENT: "1", STUB_ASSISTANT: "1" } })).call("delegate", granted);
    assert.equal(silent.status, "failed", JSON.stringify(silent));
    assert.match(silent.error, /did not confirm that its sandbox sends every connection through relay's proxy/);

    // Claude's own requests did not reach the proxy by its first message (its HTTPS_PROXY replaced): stopped there.
    const bypass = await (await h.instance({ env: { STUB_UNPROXIED: "1", STUB_ASSISTANT: "1" } })).call("delegate", granted);
    assert.equal(bypass.status, "failed");
    assert.match(bypass.error, /model requests did not go through relay's proxy for this turn/);
    // Some request carried the token, but none to the model endpoint (its model traffic exempted from the proxy): stopped too.
    const elsewhere = await (await h.instance({ env: { STUB_PROXY_HOST: "telemetry.relay-test.invalid", STUB_ASSISTANT: "1" } })).call("delegate", granted);
    assert.equal(elsewhere.status, "failed", JSON.stringify(elsewhere));
    assert.match(elsewhere.error, /model requests did not go through relay's proxy for this turn .*expected a request to model\.relay-test\.invalid/);

    // A turn without the network has no proxy, and nothing is checked of Claude's own traffic.
    const plain = await (await h.instance({ env: { STUB_UNPROXIED: "1", STUB_ASSISTANT: "1" } })).call("delegate", { ...granted, grant: undefined });
    assert.equal(plain.status, "done", JSON.stringify(plain));
  } finally {
    await h.close();
  }
});

test("shell network (claude): a proxy in the environment relay passes refuses the network, not the job without it", async () => {
  const h = await harness([], {}, { HTTPS_PROXY: "http://127.0.0.1:9" });
  try {
    const job = await h.call("delegate", { target: "claude", task: "UP", mode: "read", grant: { network: true }, background: false });
    assert.equal(job.status, "failed");
    assert.match(job.error, /environment relay passes to Claude sets HTTPS_PROXY/);
    const plain = await h.call("delegate", { target: "claude", task: "UP", mode: "read", background: false });
    assert.equal(plain.status, "done", JSON.stringify(plain));
    assert.equal(h.starts().at(-1)!.env.proxies.HTTPS_PROXY, "http://127.0.0.1:9", "without the network, the person's proxy passes as before");
  } finally {
    await h.close();
  }
});

test("the tools' target choices are every registered target; their descriptions come from the switched-on targets and the caller's family", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const h = await harness();
  const off = await harness([], { targets: { codex: { enabled: false } } });
  const strict = await harness([], { same_family: "refuse" });
  const look = async (env: Record<string, string>, args: string[], clientInfo = { name: args.includes("--host") ? (args[args.indexOf("--host") + 1] === "claude" ? "claude-code" : "codex-mcp-client") : "test", version: "0" }) => {
    const client = new Client(clientInfo);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve(import.meta.dirname, "..", "dist", "cli.js"), "mcp", ...args], env, cwd: h.repo }));
    try {
      const tools = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
      return { tools, instructions: client.getInstructions() ?? "" };
    } finally {
      await client.close();
    }
  };
  try {
    const claude = await look(h.env, ["--host", "claude"]);
    const target = claude.tools.delegate.inputSchema.properties!.target as { enum: string[]; description: string };
    assert.deepEqual(target.enum, ["claude", "codex", "copilot", "gemini", "grok"], "every registered target is a choice (Copilot, Gemini and Grok switched off included), so that naming one gets a reason or continues its items");
    assert.match(target.description, /Leave it out to reach Codex\./);
    assert.match(claude.tools.delegate.description!, /an agent of another family \(Codex\)/);
    assert.deepEqual((claude.tools.review.inputSchema.properties!.reviewer as { enum: string[] }).enum, ["claude", "codex", "copilot", "gemini", "grok"]);
    assert.match(claude.instructions, /from this Claude session, Codex/);
    // Waiting: status and result change nothing and say so, so that hosts run them in parallel; each host family is taught its own pattern.
    for (const name of ["status", "result"]) assert.deepEqual(claude.tools[name].annotations, { readOnlyHint: true }, name);
    for (const name of ["delegate", "ask", "approve", "cancel"]) assert.equal(claude.tools[name].annotations?.readOnlyHint, undefined, name);
    assert.match(claude.tools.status.description!, /cancelling the call only stops the waiting/);
    // Only a host that backgrounds long calls is taught the long wait.
    assert.doesNotMatch(claude.tools.status.description!, /background/);
    const cli = await look({ ...h.env, CLAUDE_CODE_ENTRYPOINT: "cli" }, ["--host", "claude"], { name: "claude-code", version: "2.1.286" });
    assert.match(cli.tools.status.description!, /moves to the background after about two minutes and you are notified when it completes/);
    assert.match(cli.tools.delegate.description!, /delegate returns at once\. To be told when the job finishes, call status/);
    const desktop = await look({ ...h.env, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_DESKTOP_APP_VERSION: "1.2" }, ["--host", "claude"], { name: "claude-code", version: "2.1.299" });
    assert.doesNotMatch(desktop.tools.status.description!, /background/);
    assert.match(desktop.tools.status.description!, /relay ends a wait after 30 s/);

    const codex = await look(h.env, ["--host", "codex"], { name: "codex-mcp-client", version: "0.162.1" });
    assert.match((codex.tools.ask.inputSchema.properties!.target as { description: string }).description, /Leave it out to reach Claude\./);
    assert.match(codex.tools.ask.description!, /\(Claude\)/);
    assert.deepEqual(codex.tools.status.annotations, { readOnlyHint: true });
    assert.doesNotMatch(codex.tools.status.description!, /background/);
    assert.match(codex.tools.status.description!, /several can run in parallel/);

    const unknown = await look(h.env, []);
    assert.match(unknown.tools.discuss.description!, /\(the agent you name with target\)/);
    const unknownStrict = await look(strict.env, []);
    for (const name of ["delegate", "ask", "discuss", "review"]) assert.match(unknownStrict.tools[name].description!, /\(Codex from Claude, Claude from Codex\)/);

    // Codex switched off: from Claude there is nothing new to reach. Every registered target stays a
    // choice, so that one switched off can still be named to continue its items, and naming it to start gets the reason.
    const lone = await look(off.env, ["--host", "claude"]);
    assert.deepEqual((lone.tools.delegate.inputSchema.properties!.target as { enum: string[] }).enum, ["claude", "codex", "copilot", "gemini", "grok"]);
    assert.match(lone.tools.delegate.description!, /none of another family is switched on/);
    const fromCodex = await look(off.env, ["--host", "codex"]);
    assert.deepEqual((fromCodex.tools.delegate.inputSchema.properties!.target as { enum: string[] }).enum, ["claude", "codex", "copilot", "gemini", "grok"]);
  } finally {
    await h.close();
    await off.close();
    await strict.close();
  }
});

test("legacy two-sided discussions and reviews (relay launched both sides, no target) stay readable through status and result", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const first = await claude.call("ask", { target: "codex", message: "anchor" });
    const { run_id: run, cwd } = h.sql("SELECT run_id, cwd FROM nodes WHERE id = ?", first.thread_id)[0];
    const at = Date.now();
    const row = (id: string, kind: string, params: unknown, result: unknown) =>
      h.sql("INSERT INTO nodes (id, run_id, parent_id, kind, target, mode, depth, allow_delegation, status, task, params_json, cwd, result_json, created_at, started_at, ended_at) VALUES (?, ?, NULL, ?, NULL, 'read', 1, 0, 'done', ?, ?, ?, ?, ?, ?, ?)",
        id, run, kind, `old ${kind}`, JSON.stringify(params), cwd, JSON.stringify(result), at, at, at);
    // As the first relay wrote them: both participants launched by relay, and no side labels.
    row("d_0ld0d150", "discussion", { topic: "A or B?", participants: {}, max_turns: 6 }, { outcome: "agree", conclusion: "A", turns: 4 });
    row("r_0ld0e510", "review", { target: "src/a.ts", focus: null, max_turns: 6 }, { outcome: "agree", consensus: [] });
    for (const [id, expected] of [["d_0ld0d150", "A"], ["r_0ld0e510", undefined]] as const) {
      for (const r of [await claude.call("status", { id }), await claude.call("result", { job_id: id })]) {
        assert.equal(r.tool_error, undefined, r.tool_error);
        assert.equal(r.error, undefined, `${id}: ${r.error}`);
        assert.equal(r.status, "done");
        assert.equal(r.result.outcome, "agree", JSON.stringify(r));
        assert.equal(r.result.conclusion, expected);
        assert.match(r.note, /recorded by an earlier relay/);
      }
    }
    assert.match((await claude.call("discuss", { discussion_id: "d_0ld0d150", message: "more\nCONTINUE" })).error, /recorded by an earlier relay.*cannot be continued/);
    assert.match((await claude.call("review", { review_id: "r_0ld0e510", skip_own: true })).error, /recorded by an earlier relay.*cannot be continued/);
  } finally {
    await h.close();
  }
});
