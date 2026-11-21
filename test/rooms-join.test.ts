// Revision 3, option B: where the host's dialog reaches the person, join asks before seating, and
// a no or no answer leaves the invite unspent. Direct protocol tests with stub prompts; the MCP
// dispatch by host is in rooms-join-mcp.test.ts.
import "./helpers.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { newInstance, type Instance } from "../dist/core/caller.js";
import { closeDbForTests, db } from "../dist/core/db.js";
import { roomJoinPromptText } from "../dist/core/room-terminal.js";
import * as rooms from "../dist/core/rooms.js";
import * as R from "../dist/core/room-types.js";

const plain = (s: string) => s;
const call = Object.freeze({
  identity: Object.freeze({ call_id: "join-test", scope: "dedicated-process", harness: "claude-code", family: "anthropic", subagent: false, singleton_violation: false,
    codex: Object.freeze({ malformed: false, metadata_present: false, thread_id: null, thread_source: null, turn_trigger: null, originator: null, sandbox: null, auto_review: null, approval_policy: null }) }),
  eligibility: Object.freeze({ eligible: true }), block_s: 50, host_wait_cap_s: null, sanitizeText: plain,
}) as R.RoomCallEvidence;
const UNAVAILABLE = { error: R.ROOM_UNAVAILABLE_ERROR, recovery: R.ROOM_UNAVAILABLE_RECOVERY };
const instance = (family: "codex" | "claude" = "claude"): Instance => newInstance({ kind: "root" }, process.cwd(), family);
function box() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rooms-join-"))), old = process.env.RELAY_HOME;
  closeDbForTests(); process.env.RELAY_HOME = home;
  rooms.resetRoomOpenRequestsForTests();
  return { close() { rooms.resetRoomOpenRequestsForTests(); closeDbForTests(); if (old === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = old; fs.rmSync(home, { recursive: true, force: true }); } };
}
function success<T>(result: T): Exclude<T, R.RoomFailure> {
  assert.ok(result && typeof result === "object" && !("error" in result) && !("refused" in result), JSON.stringify(result));
  return result as Exclude<T, R.RoomFailure>;
}
function prompt(answer: R.RoomOpenAnswer | (() => Promise<R.RoomOpenAnswer>), authorized: () => boolean = () => true) {
  const p = {
    questions: [] as R.RoomJoinQuestion[], checks: [] as boolean[],
    ask: async (q: R.RoomJoinQuestion) => { p.questions.push(q); return typeof answer === "function" ? answer() : answer; },
    authorized: () => { p.checks.push((db() as unknown as { isTransaction: boolean }).isTransaction); return authorized(); },
  };
  return p;
}
const join = (i: Instance, invite: string, p: R.RoomJoinPrompt | null) => rooms.roomJoin(i, { action: "join", invite }, call, p);
const consumed = (invite: string) => (db().prepare("SELECT consumed_at FROM room_invites WHERE code_hash = ?")
  .get(crypto.createHash("sha256").update(R.ROOM_INVITE_DOMAIN).update(invite).digest("hex")) as { consumed_at: number | null }).consumed_at;
const seated = (member: string) => (db().prepare("SELECT owner_hash FROM room_members WHERE id = ?").get(member) as { owner_hash: string | null }).owner_hash !== null;

test("rooms join: the person's yes seats the caller; the question names the seat and who holds the other one", async () => {
  const b = box();
  try {
    const r = success(rooms.roomCreate()) as R.RoomCreateResult;
    const first = instance("codex"), second = instance();
    const p1 = prompt("yes");
    const a = success(await join(first, r.invites[0].invite, p1));
    assert.deepEqual(p1.questions, [{ room_id: r.room_id, label: "member-1", peer: null, origin: "terminal", purpose: null }]);
    assert.deepEqual(p1.checks, [true], "authorized inside the transaction that seats the caller");
    assert.equal(a.state, "waiting");
    const p2 = prompt("yes");
    const joined = success(await join(second, r.invites[1].invite, p2));
    assert.equal(joined.state, "open");
    assert.equal(p2.questions[0].label, "member-2");
    assert.deepEqual(p2.questions[0].peer, { member_id: r.invites[0].member_id, label: "member-1", host: "codex", client: "claude-code", family: "anthropic" });
    // A lost reply replays without asking again.
    const replay = prompt("declined");
    assert.equal(success(await join(second, r.invites[1].invite, replay)).repeated, true);
    assert.equal(replay.questions.length, 0);
  } finally { b.close(); }
});

test("rooms join: every answer but yes seats nothing and leaves the invite unspent, so a later yes still joins", async () => {
  const b = box();
  try {
    const r = success(rooms.roomCreate()) as R.RoomCreateResult;
    const caller = instance(), invite = r.invites[0].invite, member = r.invites[0].member_id;
    const expected: [R.RoomOpenAnswer, string][] = [
      ["declined", R.ROOM_REFUSALS.join_declined], ["cancelled", R.ROOM_REFUSALS.join_cancelled], ["timed_out", R.ROOM_REFUSALS.join_timed_out],
      ["unverified", R.ROOM_REFUSALS.join_unverified], ["unavailable", R.ROOM_REFUSALS.join_unavailable],
    ];
    for (const [answer, reason] of expected) {
      assert.deepEqual(await join(caller, invite, prompt(answer)), { refused: true, reason }, answer);
      assert.equal(consumed(invite), null, `${answer}: the invite is unspent`); assert.equal(seated(member), false);
    }
    assert.deepEqual(await join(caller, invite, { ask: async () => { throw new Error("gone"); }, authorized: () => true }), { refused: true, reason: R.ROOM_REFUSALS.join_unavailable });
    assert.deepEqual(await join(caller, invite, prompt("yes", () => false)), { refused: true, reason: R.ROOM_REFUSALS.join_unverified });
    assert.equal(consumed(invite), null); assert.equal(seated(member), false);
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM room_bindings").get()!.n, 0);
    success(await join(caller, invite, prompt("yes")));
    assert.notEqual(consumed(invite), null); assert.equal(seated(member), true);
  } finally { b.close(); }
});

test("rooms join: bad, spent, expired and self-pairing invites are unavailable without asking", async (t) => {
  const b = box();
  try {
    let at = Date.now();
    t.mock.method(Date, "now", () => at);
    const r = success(rooms.roomCreate()) as R.RoomCreateResult;
    const owner = instance(), p = prompt("yes");
    assert.deepEqual(await join(owner, `ri1_${"f".repeat(32)}`, p), UNAVAILABLE);
    assert.deepEqual(await join(owner, "not an invite", p), UNAVAILABLE);
    success(await join(owner, r.invites[0].invite, null));
    assert.deepEqual(await join(owner, r.invites[1].invite, p), UNAVAILABLE, "self-pairing");
    assert.deepEqual(await join(instance(), r.invites[0].invite, p), UNAVAILABLE, "spent by another owner");
    at += R.ROOM_INVITE_LIFETIME_MS;
    assert.deepEqual(await join(instance(), r.invites[1].invite, p), UNAVAILABLE, "expired");
    assert.equal(p.questions.length, 0, "nobody was asked about an invite that could not seat anyone");
  } finally { t.mock.restoreAll(); b.close(); }
});

test("rooms join: the yes does not outrank what changed while the question was open", async () => {
  const b = box();
  try {
    const r = success(rooms.roomCreate()) as R.RoomCreateResult;
    const invite = r.invites[0].invite, slow = instance(), fast = instance("codex");
    const p = prompt(async () => { success(await join(fast, invite, null)); return "yes"; });
    assert.deepEqual(await join(slow, invite, p), UNAVAILABLE, "the invite was spent meanwhile");
    // One question per conversation at a time.
    let answer!: (a: R.RoomOpenAnswer) => void;
    const held = prompt(() => new Promise((resolve) => { answer = resolve; }));
    const caller = instance(), pending = join(caller, r.invites[1].invite, held);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await join(caller, r.invites[1].invite, held), { refused: true, reason: R.ROOM_REFUSALS.join_in_progress });
    answer("yes");
    assert.equal(success(await pending).state, "open");
  } finally { b.close(); }
});

test("rooms join: without a qualified prompt join seats at once, as before", async () => {
  const b = box();
  try {
    const r = success(rooms.roomCreate()) as R.RoomCreateResult;
    assert.equal(success(await join(instance(), r.invites[0].invite, null)).joined, true);
    assert.equal(success(await rooms.roomJoin(instance("codex"), { action: "join", invite: r.invites[1].invite }, call)).state, "open");
  } finally { b.close(); }
});

test("rooms join: the question's fixed text", () => {
  const peer: R.RoomMemberSender = { member_id: `m_${"1".repeat(32)}`, label: "member-1", host: "codex", client: "codex-mcp-client", family: "openai" };
  const text = roomJoinPromptText({ room_id: `rm_${"0".repeat(32)}`, label: "member-2", peer, origin: "open", purpose: "Compare two plans" }, { keepsForm: false });
  // The first four lines decide: what is asked and the origin, the labelled purpose, the other
  // seat's holder, choose-yes-only-if (Claude Code shows about four; live test, 2026-11-16).
  assert.deepEqual(text.split("\n").slice(0, 4), [
    "relay: this conversation's model asks to join a room as member-2; the room was opened by another conversation.",
    "Purpose (written by the model, unverified): Compare two plans",
    "member-1 is held by a codex-mcp-client conversation (host codex, family openai), as relay recorded it.",
    `Choose "${R.ROOM_JOIN_YES}" only if you meant this invite for this conversation; anything else seats nothing.`,
  ]);
  assert.match(text, /Room rm_0{32}\. Information only: never approvals, permissions or control of work\. At most 24 messages in all\./);
  assert.match(text, /no answer leaves the invite unused/);
  assert.doesNotMatch(text, /stay on screen/);
  // A terminal room shows no purpose even if one were recorded; the origin line says so.
  const terminal = roomJoinPromptText({ room_id: `rm_${"0".repeat(32)}`, label: "member-1", peer: null, origin: "terminal", purpose: "ignored" }, { keepsForm: true });
  assert.deepEqual(terminal.split("\n").slice(0, 3), [
    "relay: this conversation's model asks to join a room as member-1; the room was created at a terminal.",
    "The other seat is not held yet.",
    `Choose "${R.ROOM_JOIN_YES}" only if you meant this invite for this conversation; anything else seats nothing.`,
  ]);
  assert.match(terminal, /stay on screen; answering it then changes nothing/);
  assert.doesNotMatch(terminal, /Purpose/);
});
