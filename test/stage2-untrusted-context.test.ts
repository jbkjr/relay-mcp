// Tripwire for the untrusted_as_tool_output decision (Codex 0.170.0, docs/codex-confinement-design.md §2.5).
// Relay pins that feature off on the grounds that it is inert on relay's turns: it changes only how
// untrusted additional context (a turn's or thread's `additionalContext`, a goal's objective) reaches
// the model, relay sends none, and goals stay pinned off (the readback enforces that). If relay ever
// sends additionalContext, this fails: reconsider the pin then. With the feature on, Codex renders
// untrusted context as a tool output rather than user-role text, the safer form, so the likely
// answer is to admit it (STAGE2_FEATURES_ALLOWED_ON) instead of keeping it in STAGE2_FEATURES_OFF_0170.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./helpers.ts";

const S2 = await import("../dist/backends/codex-stage2.js");
const WHY = "relay now sends additionalContext: revisit the untrusted_as_tool_output pin (codex-stage2.ts STAGE2_FEATURES_OFF_0170)";
const hasContext = (keys: readonly string[]) => keys.some((k) => /^additional_?context$/i.test(k));

test("stage 2 tripwire: relay sends no additionalContext on thread/start, thread/resume or turn/start", async () => {
  assert.ok(S2.STAGE2_FEATURES_OFF_0170.includes("untrusted_as_tool_output"), "the pin this guards");
  // Stage 2's own overlays on the thread and every turn.
  assert.ok(!hasContext(Object.keys(S2.stage2ThreadParams("/w", "relay"))), WHY);
  assert.ok(!hasContext(Object.keys(S2.stage2TurnParams("/w", "relay"))), WHY);
  // What relay's app-server path actually sends, fresh and resumed.
  const h = await harness();
  try {
    const first = await h.call("ask", { target: "codex", message: "first question" });
    assert.ok(first.thread_id);
    await h.call("ask", { target: "codex", message: "follow-up", thread_id: first.thread_id });
    const starts = h.starts().filter((s) => s.target === "codex");
    assert.equal(starts.length, 2);
    assert.deepEqual(starts.map((s) => s.resumed), [false, true]);
    for (const s of starts) {
      assert.equal(s.via, "app-server");
      assert.ok(Array.isArray(s.turnKeys) && s.turnKeys.includes("input"), "the stub recorded turn/start's keys");
      assert.ok(!hasContext(Object.keys(s.thread)), WHY);
      assert.ok(!hasContext(s.turnKeys), WHY);
    }
  } finally {
    await h.close();
  }
});
