// Revision 3, part A: the clipboard flow with a fake clipboard and scripted answers. The real CLI
// over a PTY, with stub pbcopy and pbpaste, is in room-cli.test.ts.
import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLEAR_FAILED, clearInvites, clipboardFlow, clipboardOffered, type Clipboard } from "../dist/core/room-clipboard.js";

const INVITES = [`ri1_${"1".repeat(32)}`, `ri1_${"2".repeat(32)}`];
const PROMPTS = [{ label: "member-1", text: `prompt one ${INVITES[0]}` }, { label: "member-2", text: `prompt two ${INVITES[1]}` }];

function fake(initial = "mine", opts: { readable?: boolean; failCopy?: boolean } = {}) {
  const c = { held: initial, copies: [] as string[] };
  const clip: Clipboard = {
    copy: (text) => { if (opts.failCopy) return false; c.copies.push(text); c.held = text; return true; },
    read: () => (opts.readable === false ? null : c.held),
  };
  return { c, clip };
}
/** Answers each question in turn; `during` runs just before the answer at that index is given. */
function io(answers: (string | null)[], during: Record<number, () => void> = {}) {
  const asked: string[] = [], said: string[] = [];
  return { asked, said, io: { ask: async (q: string) => { asked.push(q); during[asked.length - 1]?.(); return answers[asked.length - 1] ?? null; }, say: (l: string) => { said.push(l); } } };
}

test("room clipboard: offered only on macOS with an interactive terminal at both ends", () => {
  assert.equal(clipboardOffered("darwin", true, true), true);
  assert.equal(clipboardOffered("linux", true, true), false);
  assert.equal(clipboardOffered("darwin", false, true), false);
  assert.equal(clipboardOffered("darwin", true, false), false);
});

test("room clipboard: each prompt replaces the last only after Enter, and the clipboard is cleared at the end", async () => {
  const { c, clip } = fake();
  const t = io(["", "", ""], { 1: () => assert.equal(c.held, PROMPTS[0].text, "member-1's prompt stays until Enter") });
  let armed = 0;
  assert.equal(await clipboardFlow(PROMPTS, INVITES, t.io, clip, () => armed++), "done");
  assert.deepEqual(c.copies, [PROMPTS[0].text, PROMPTS[1].text, ""]);
  assert.equal(c.held, "");
  assert.equal(armed, 2);
  assert.equal(t.asked.length, 3);
  assert.match(t.asked[0], /Press Enter to copy member-1's prompt, or type n to skip\./);
  assert.match(t.asked[1], /member-1's prompt is on the clipboard\. Paste it into the first conversation, then press Enter to copy member-2's prompt/);
  assert.match(t.asked[2], /member-2's prompt is on the clipboard\. Paste it into the second conversation, then press Enter to clear the clipboard\./);
  assert.deepEqual(t.said, ["Clipboard cleared."]);
  for (const line of [...t.asked, ...t.said]) for (const invite of INVITES) assert.equal(line.includes(invite), false, "questions never show an invite");
});

test("room clipboard: skip leaves the clipboard alone; stop and end of input clear it", async () => {
  for (const answers of [["n"], ["No thanks"], [null]] as (string | null)[][]) {
    const { c, clip } = fake();
    assert.equal(await clipboardFlow(PROMPTS, INVITES, io(answers).io, clip), "skipped");
    assert.deepEqual(c.copies, []); assert.equal(c.held, "mine");
  }
  for (const second of ["n", null]) {
    const { c, clip } = fake();
    assert.equal(await clipboardFlow(PROMPTS, INVITES, io(["", second]).io, clip), "stopped");
    assert.equal(c.held, "");
  }
});

test("room clipboard: what the person copied meanwhile is left alone; an unreadable clipboard is cleared", async () => {
  {
    const { c, clip } = fake();
    const t = io(["", "", ""], { 2: () => { c.held = "the person's own text"; } });
    await clipboardFlow(PROMPTS, INVITES, t.io, clip);
    assert.equal(c.held, "the person's own text");
    assert.deepEqual(t.said, ["The clipboard no longer holds an invite; left it as it is."]);
  }
  {
    const { c, clip } = fake();
    const t = io(["", "", ""], { 2: () => { c.held = `copied again: ${INVITES[0]}`; } });
    await clipboardFlow(PROMPTS, INVITES, t.io, clip);
    assert.equal(c.held, "", "text holding either invite is cleared");
  }
  {
    const { c, clip } = fake("mine", { readable: false });
    await clipboardFlow(PROMPTS, INVITES, io(["", "", ""]).io, clip);
    assert.equal(c.held, "", "cleared when relay cannot tell");
  }
  const { c, clip } = fake(`x ${INVITES[1]}`);
  assert.equal(clearInvites(clip, INVITES), "cleared"); assert.equal(c.held, "");
  c.held = "other";
  assert.equal(clearInvites(clip, INVITES), "left"); assert.equal(c.held, "other");
});

test("room clipboard: a failing copy says to paste the printed prompts and leaves no invite behind", async () => {
  {
    const { c, clip } = fake("mine", { failCopy: true });
    const t = io([""]);
    assert.equal(await clipboardFlow(PROMPTS, INVITES, t.io, clip), "failed");
    assert.deepEqual(t.said, ["relay could not use the clipboard; paste the prompts printed above instead."]);
    assert.equal(c.held, "mine");
  }
  // The second copy fails after the first succeeded: the first invite is cleared.
  const c = { held: "mine", n: 0 };
  const clip: Clipboard = { copy: (text) => { if (++c.n === 2) return false; c.held = text; return true; }, read: () => c.held };
  assert.equal(await clipboardFlow(PROMPTS, INVITES, io(["", ""]).io, clip), "failed");
  assert.equal(c.held, "");
});

test("room clipboard: a single re-seat prompt names the intended conversation", async () => {
  const { c, clip } = fake();
  const t = io(["", ""]);
  await clipboardFlow([PROMPTS[1]], [INVITES[1]], t.io, clip);
  assert.match(t.asked[0], /^Copy this prompt to the clipboard\? Press Enter to copy member-2's prompt/);
  assert.match(t.asked[1], /Paste it into the intended conversation, then press Enter to clear the clipboard\./);
  assert.equal(c.held, "");
});

test("room clipboard: a clear that fails is reported, never claimed", async () => {
  // pbcopy fails when asked to clear: the invite stays, and the person is told to replace it.
  {
    const c = { held: "mine", n: 0 };
    const clip: Clipboard = { copy: (text) => { if (text === "") return false; c.held = text; return true; }, read: () => c.held };
    const t = io(["", "", ""]);
    await clipboardFlow(PROMPTS, INVITES, t.io, clip);
    assert.ok(c.held.includes(INVITES[1]));
    assert.deepEqual(t.said, [CLEAR_FAILED]);
    assert.doesNotMatch(t.said.join("\n"), /Clipboard cleared/);
    assert.equal(clearInvites(clip, INVITES), "failed");
  }
  // pbcopy reports success but the invite is still there when read back.
  {
    const c = { held: `x ${INVITES[0]}` };
    const clip: Clipboard = { copy: () => true, read: () => c.held };
    assert.equal(clearInvites(clip, INVITES), "failed");
  }
  // Unreadable and unclearable: failed, since relay cannot tell.
  assert.equal(clearInvites({ copy: () => false, read: () => null }, INVITES), "failed");
});

test("room clipboard: after a failed first copy relay still tries to clear what pbcopy may have left", async () => {
  // A pbcopy that exits nonzero after writing the prompt: the clear removes it.
  {
    const c = { held: "mine", n: 0 };
    const clip: Clipboard = { copy: (text) => { c.held = text; return ++c.n > 1; }, read: () => c.held };
    const t = io([""]);
    let armed = 0;
    assert.equal(await clipboardFlow(PROMPTS, INVITES, t.io, clip, () => armed++), "failed");
    assert.equal(c.held, "");
    assert.equal(armed, 1, "signal handlers were armed before the copy was attempted");
    assert.deepEqual(t.said, ["relay could not use the clipboard; paste the prompts printed above instead.", "Clipboard cleared."]);
  }
  // A failed copy that changed nothing: the person's clipboard is left alone, with nothing more said.
  {
    const c = { held: "mine" };
    const clip: Clipboard = { copy: () => false, read: () => c.held };
    const t = io([""]);
    await clipboardFlow(PROMPTS, INVITES, t.io, clip);
    assert.equal(c.held, "mine");
    assert.deepEqual(t.said, ["relay could not use the clipboard; paste the prompts printed above instead."]);
  }
  // Failed and unreadable: relay tries to clear, and says so when that fails too.
  {
    const t = io([""]);
    await clipboardFlow(PROMPTS, INVITES, t.io, { copy: () => false, read: () => null });
    assert.deepEqual(t.said, ["relay could not use the clipboard; paste the prompts printed above instead.", CLEAR_FAILED]);
  }
});
