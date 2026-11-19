// Regression for the shared per-tool-call wait deadline (C1): one deadline for the whole call, so
// nested waits (a review's reviewer wait, then its reconciliation discuss wait) together stay under
// the host's tool-call timeout. Every file touched is scratch.
import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./helpers.ts";

const ITEMS = '```json\n' + JSON.stringify({ items: [{ n: 1, severity: "minor", location: "a", summary: "s", evidence: "e", fix: "f" }] }) + '\n```';

test("C1: one deadline per tool call — a review's reviewer wait and its reconciliation wait share the cap", async () => {
  // A slow reviewer (its turn settles well inside the cap) and a reply that never arrives in time.
  // With one shared deadline the second review call ends at about the cap; two independent caps
  // would let the reviewer wait and then a fresh reconciliation wait run back to back.
  const h = await harness([
    { target: "codex", turn: 1, steps: [{ sleep: 1000 }, { reply: ITEMS }] },
    { target: "codex", turn: 2, steps: [{ sleep: 5000 }, { reply: "AGREE: fine\n" + ITEMS }] },
  ]);
  try {
    const inst = await h.instance({ args: ["--host", "claude"], env: { RELAY_WAIT_CAP_MS: "2000" } });
    const r = await inst.call("review", { target: "src/thing.ts", reviewer: "codex" });
    assert.match(r.review_id, /^r_/, JSON.stringify(r));
    const t0 = Date.now();
    const out = await inst.call("review", { review_id: r.review_id, own_review: `R1 minor a: s\n${ITEMS}` });
    const elapsed = Date.now() - t0;
    // The whole call stayed within one cap (2000ms) plus slack; without sharing it would run the
    // reviewer wait (~1.3s) and then a fresh reconciliation wait (up to another 2s).
    assert.ok(elapsed < 2600, `the second review call took ${elapsed}ms; it should stay within one shared cap`);
    // It came back before the reconciliation reply did: a pending handle, not a finished consensus.
    assert.equal(out.outcome, undefined, `expected an unfinished reconciliation, got ${JSON.stringify(out)}`);
    assert.equal(out.consensus, undefined);
    await inst.close();
  } finally {
    await h.close();
  }
});


test("C5: a status wait ended at a clamped limit says so in whole seconds", async () => {
  const h = await harness([{ target: "codex", steps: [{ sleep: 6000 }, { reply: "late" }] }]);
  try {
    const inst = await h.instance({ args: ["--host", "claude"], env: { RELAY_WAIT_CAP_MS: "1500" } });
    const job = await inst.call("delegate", { target: "codex", task: "slow", mode: "read" });
    const st = await inst.call("status", { id: job.job_id, wait_s: 10 });
    assert.match(String(st.wait_ended), /^Relay ends a wait after \d+ s here/, String(st.wait_ended));
    await inst.close();
  } finally {
    await h.close();
  }
});
