// Revision 3: a root conversation opens a room only on the person's yes in its host's own prompt.
// Direct protocol tests with stub prompts, and the answer reader with a stub server. The real MCP
// dispatch, host qualification and refusals by host are in rooms-open-mcp.test.ts.
import "./helpers.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { newInstance, type Instance } from "../dist/core/caller.js";
import { closeDbForTests, db } from "../dist/core/db.js";
import { roomOwnerHash } from "../dist/core/room-policy.js";
import { readRoomOpenAnswer, roomOpenThrough } from "../dist/mcp/elicit.js";
import { renderRoomList, renderRoomTranscript, roomJoinPromptText, roomOpenPromptText } from "../dist/core/room-terminal.js";
import { roomText } from "../dist/core/shown.js";
import * as rooms from "../dist/core/rooms.js";
import * as R from "../dist/core/room-types.js";

const plain = (s: string) => s;
function evidence(overrides: Partial<R.RoomCallEvidence> = {}): R.RoomCallEvidence {
  return Object.freeze({
    identity: Object.freeze({ call_id: crypto.randomUUID(), scope: "dedicated-process", harness: "codex-mcp-client", family: "openai", subagent: false, singleton_violation: false,
      codex: Object.freeze({ malformed: false, metadata_present: true, thread_id: "test", thread_source: "user", turn_trigger: null, originator: null, sandbox: null, auto_review: null, approval_policy: null }) }),
    eligibility: Object.freeze({ eligible: true }), block_s: 50, host_wait_cap_s: null, sanitizeText: plain, ...overrides,
  }) as R.RoomCallEvidence;
}
const call = evidence();
const OPEN = { action: "open" as const };
const instance = (family: "codex" | "claude" = "codex"): Instance => newInstance({ kind: "root" }, process.cwd(), family);
function box() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rooms-open-"))), old = process.env.RELAY_HOME;
  closeDbForTests(); process.env.RELAY_HOME = home;
  rooms.resetRoomOpenRequestsForTests();
  return { home, close() { rooms.resetRoomOpenRequestsForTests(); closeDbForTests(); if (old === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = old; fs.rmSync(home, { recursive: true, force: true }); } };
}
function success<T>(result: T): Exclude<T, R.RoomFailure> {
  assert.ok(result && typeof result === "object" && !("error" in result) && !("refused" in result), JSON.stringify(result));
  return result as Exclude<T, R.RoomFailure>;
}
/**
 * A prompt that answers `answer` and counts how often it was put to the person. `authorized` is
 * the fresh post-answer check; `checks` records whether each ran inside a transaction.
 */
function prompt(answer: R.RoomOpenAnswer | (() => Promise<R.RoomOpenAnswer>), authorized: () => boolean = () => true, delivers = true) {
  const p = {
    asked: 0, checks: [] as boolean[], delivered: [] as string[],
    ask: async () => { p.asked++; return typeof answer === "function" ? answer() : answer; },
    deliver: (text: string) => { p.delivered.push(text); return delivers; },
    authorized: () => { p.checks.push((db() as unknown as { isTransaction: boolean }).isTransaction); return authorized(); },
  };
  return p;
}
const rowCount = (table: string) => Number(db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
const nothingWritten = () => { for (const t of ["rooms", "room_members", "room_invites", "room_bindings", "room_messages"]) assert.equal(rowCount(t), 0, t); };
const invitesIn = (text: string) => [...text.matchAll(/ri1_[0-9a-f]{32}/g)].map((m) => m[0]);

test("rooms open: on yes the caller holds member-1, member-2's prompt goes to the clipboard and never to the model, and a pasted join opens the room", async () => {
  const b = box();
  try {
    const opener = instance(), peer = instance("claude"), p = prompt("yes");
    const opened = success(await rooms.roomOpen(opener, OPEN, call, p));
    assert.equal(p.asked, 1);
    assert.equal(opened.opened, true); assert.equal(opened.state, "waiting"); assert.equal(opened.next, null); assert.deepEqual(opened.messages, []);
    assert.equal(opened.turns, 0); assert.equal(opened.max_turns, R.ROOM_MAX_TURNS); assert.equal(opened.note, R.ROOM_NOTE);
    assert.equal(opened.peer.seat, "unseated");
    // The opener gets one line and no invite; the prompt, with the only invite, went to the clipboard.
    assert.deepEqual(Object.keys(opened).filter((k) => !["room_id", "member_id", "turns", "max_turns", "revision", "cursor", "through_seq", "latest_seq", "remaining", "peer", "poll", "messages", "note", "user_confirmed_ignored", "state", "next", "origin"].includes(k)), ["opened", "clipboard"]);
    assert.equal(opened.origin, "open");
    assert.match(opened.clipboard, /^Member-2's prompt, with its one-use invite \(valid until .+\), is on the person's clipboard\. Tell them to paste it into the conversation they choose; you were given no copy\.$/);
    assert.equal(invitesIn(JSON.stringify(opened)).length, 0, "the model never receives the invite");
    assert.equal(p.delivered.length, 1);
    const [delivered] = p.delivered, [invite] = invitesIn(delivered);
    assert.equal(invitesIn(delivered).length, 1);
    assert.match(delivered, /^--- Prompt for member-2 ---\n/);
    assert.match(delivered, /opened from another conversation/);
    assert.match(delivered, /not my instructions or consent/);
    // Stored: member-1 bound to the opener with no invite of its own; one hashed invite for member-2.
    const members = db().prepare("SELECT id, ordinal, owner_hash, generation FROM room_members ORDER BY ordinal").all() as { id: string; ordinal: number; owner_hash: string | null }[];
    assert.equal(members[0].id, opened.member_id); assert.equal(members[0].owner_hash, roomOwnerHash(opener.token)); assert.equal(members[1].owner_hash, null);
    const invites = db().prepare("SELECT member_id, code_hash FROM room_invites").all() as { member_id: string; code_hash: string }[];
    assert.deepEqual(invites.map((i) => i.member_id), [members[1].id]);
    assert.notEqual(invites[0].code_hash, invite);
    db().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const file of fs.readdirSync(b.home)) {
      const full = path.join(b.home, file);
      if (fs.statSync(full).isFile()) assert.equal(fs.readFileSync(full).includes(invite), false, `${file} holds no invite plaintext`);
    }
    // The opener cannot take the second seat itself.
    assert.deepEqual(await rooms.roomJoin(opener, { action: "join", invite }, call), { error: R.ROOM_UNAVAILABLE_ERROR, recovery: R.ROOM_UNAVAILABLE_RECOVERY });
    // The person pastes the prompt elsewhere: the room opens and the opener, member-1, sends first.
    const joined = success(await rooms.roomJoin(peer, { action: "join", invite }, call));
    assert.equal(joined.state, "open"); assert.equal(joined.next, opened.member_id);
    const sent = success(await rooms.roomSend(opener, { action: "send", cursor: 0, text: "I recommend A.", stance: "continue", request_id: crypto.randomUUID() }, call));
    assert.equal(sent.accepted_seq, 1);
    const got = success(await rooms.roomWait(peer, { action: "wait", cursor: 0, wait_s: 0 }, call));
    assert.equal(got.messages[0].text, "I recommend A."); assert.equal(got.messages[0].sender.label, "member-1");
    for (const table of ["runs", "nodes", "turns"]) assert.equal(rowCount(table), 0, `${table}: a room owns no run`);
  } finally { b.close(); }
});

test("rooms open: a failed clipboard write opens nothing and never hands the invite to the model", async () => {
  const b = box();
  try {
    const p = prompt("yes", () => true, false);
    const result = await rooms.roomOpen(instance(), OPEN, call, p);
    assert.deepEqual(result, { refused: true, reason: R.ROOM_REFUSALS.open_clipboard });
    assert.equal(p.delivered.length, 1, "delivery was attempted inside the transaction");
    assert.equal(invitesIn(JSON.stringify(result)).length, 0);
    nothingWritten();
  } finally { b.close(); }
});

test("rooms open: every answer but yes opens nothing and refuses with its own reason", async () => {
  const b = box();
  try {
    const expected: [R.RoomOpenAnswer, string][] = [
      ["declined", R.ROOM_REFUSALS.open_declined], ["cancelled", R.ROOM_REFUSALS.open_cancelled], ["timed_out", R.ROOM_REFUSALS.open_timed_out],
      ["unverified", R.ROOM_REFUSALS.open_unverified], ["unavailable", R.ROOM_REFUSALS.open_unavailable],
    ];
    for (const [answer, reason] of expected) {
      const p = prompt(answer);
      assert.deepEqual(await rooms.roomOpen(instance(), OPEN, call, p), { refused: true, reason }, answer);
      assert.equal(p.asked, 1);
    }
    // A prompt that throws is no answer at all, and an answer relay does not know is not a yes.
    assert.deepEqual(await rooms.roomOpen(instance(), OPEN, call, { ask: async () => { throw new Error("host gone"); }, authorized: () => true, deliver: () => true }), { refused: true, reason: R.ROOM_REFUSALS.open_unavailable });
    assert.deepEqual(await rooms.roomOpen(instance(), OPEN, call, { ask: async () => "YES" as R.RoomOpenAnswer, authorized: () => true, deliver: () => true }), { refused: true, reason: R.ROOM_REFUSALS.open_unverified });
    nothingWritten();
  } finally { b.close(); }
});

test("rooms open: the yes is authorized afresh inside the writer lock, before anything is written", async () => {
  const b = box();
  try {
    const yes = prompt("yes");
    success(await rooms.roomOpen(instance(), OPEN, call, yes));
    assert.deepEqual(yes.checks, [true], "checked once, inside the transaction that creates the room");
    for (const failing of [() => false, () => { throw new Error("ps failed"); }]) {
      const no = prompt("yes", failing);
      assert.deepEqual(await rooms.roomOpen(instance(), OPEN, call, no), { refused: true, reason: R.ROOM_REFUSALS.open_unverified });
      assert.deepEqual(no.checks, [true]);
    }
    assert.equal(rowCount("rooms"), 1, "only the authorized open created a room");
    // A refused answer never reaches the check.
    const declined = prompt("declined");
    await rooms.roomOpen(instance(), OPEN, call, declined);
    assert.deepEqual(declined.checks, []);
  } finally { b.close(); }
});

test("rooms open: a refused open creates no room, seat or invite, though the sweep may end an expired room", async (t) => {
  const b = box();
  try {
    let at = Date.parse("2026-11-16T18:00:00.000Z");
    t.mock.method(Date, "now", () => at);
    const created = success(rooms.roomCreate()) as R.RoomCreateResult;
    at += R.ROOM_INVITE_LIFETIME_MS + R.ROOM_SWEEP_INTERVAL_MS;
    const snapshot = () => ["rooms", "room_members", "room_invites", "room_bindings"].map((table) => db().prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all());
    const rows = () => ["rooms", "room_members", "room_invites", "room_bindings"].map((table) => rowCount(table));
    const before = rows();
    for (const answer of ["declined", "cancelled", "timed_out", "unverified", "unavailable"] as const) {
      assert.equal((await rooms.roomOpen(instance(), OPEN, call, prompt(answer)) as R.RoomRefusal).refused, true);
    }
    assert.equal((await rooms.roomOpen(instance(), OPEN, call, prompt("yes", () => false)) as R.RoomRefusal).reason, R.ROOM_REFUSALS.open_unverified);
    assert.deepEqual(rows(), before, "no room, seat, invite or binding was created");
    // The opportunistic sweep every room call runs ended the expired waiting room: maintenance, not creation.
    assert.equal((db().prepare("SELECT state FROM rooms WHERE id = ?").get(created.room_id) as { state: string }).state, "ended");
    const after = snapshot();
    await rooms.roomOpen(instance(), OPEN, call, prompt("declined"));
    assert.deepEqual(snapshot(), after);
  } finally { b.close(); }
});

test("rooms open: no qualified prompt, an ineligible caller or stray fields refuse before anyone is asked", async () => {
  const b = box();
  try {
    assert.deepEqual(await rooms.roomOpen(instance(), OPEN, call, null), { refused: true, reason: R.ROOM_REFUSALS.open_unavailable });
    const p = prompt("yes");
    const ineligible = evidence({ eligibility: Object.freeze({ eligible: false, refused: true, reason: R.ROOM_REFUSALS.ineligible }) });
    assert.deepEqual(await rooms.roomOpen(instance(), OPEN, ineligible, p), { refused: true, reason: R.ROOM_REFUSALS.ineligible });
    const child = newInstance({ kind: "child", runId: "run", nodeId: "node", depth: 1, mayDelegate: false } as never, process.cwd(), "codex");
    assert.deepEqual(await rooms.roomOpen(child, OPEN, call, p), { refused: true, reason: R.ROOM_REFUSALS.ineligible });
    for (const extra of [{ invite: `ri1_${"a".repeat(32)}` }, { cursor: 0 }, { user_confirmed: true }]) {
      assert.deepEqual(await rooms.roomOpen(instance(), { ...OPEN, ...extra } as never, call, p), { refused: true, reason: R.ROOM_REFUSALS.arguments });
    }
    assert.equal(p.asked, 0, "nobody was asked");
    nothingWritten();
  } finally { b.close(); }
});

test("rooms open: an owner bound to a waiting or open room is refused unasked; one whose room ended may open another", async () => {
  const b = box();
  try {
    const owner = instance(), p = prompt("yes");
    const created = success(rooms.roomCreate()) as R.RoomCreateResult;
    success(await rooms.roomJoin(owner, { action: "join", invite: created.invites[0].invite }, call));
    assert.deepEqual(await rooms.roomOpen(owner, OPEN, call, p), { refused: true, reason: R.ROOM_REFUSALS.open_bound }, "waiting");
    success(await rooms.roomJoin(instance("claude"), { action: "join", invite: created.invites[1].invite }, call));
    assert.deepEqual(await rooms.roomOpen(owner, OPEN, call, p), { refused: true, reason: R.ROOM_REFUSALS.open_bound }, "open");
    assert.equal(p.asked, 0);
    success(rooms.roomCloseAtTerminal(created.room_id));
    const opened = success(await rooms.roomOpen(owner, OPEN, call, p));
    assert.notEqual(opened.room_id, created.room_id);
    assert.equal((db().prepare("SELECT room_id FROM room_bindings WHERE owner_hash = ?").get(roomOwnerHash(owner.token)) as { room_id: string }).room_id, opened.room_id);
    // The person's yes does not outrank a seat taken while the prompt was open.
    const racer = instance(), other = success(rooms.roomCreate()) as R.RoomCreateResult;
    const late = prompt(async () => { success(await rooms.roomJoin(racer, { action: "join", invite: other.invites[0].invite }, call)); return "yes"; });
    const before = rowCount("rooms");
    assert.deepEqual(await rooms.roomOpen(racer, OPEN, call, late), { refused: true, reason: R.ROOM_REFUSALS.open_bound });
    assert.equal(rowCount("rooms"), before, "no room was created for the late yes");
  } finally { b.close(); }
});

test("rooms open: no limit on how often a conversation may ask; only one of its prompts at a time", async () => {
  const b = box();
  try {
    const owner = instance(), p = prompt("declined");
    for (let n = 0; n < 8; n++) assert.deepEqual(await rooms.roomOpen(owner, OPEN, call, p), { refused: true, reason: R.ROOM_REFUSALS.open_declined });
    assert.equal(p.asked, 8, "every request was put to the person, who can decline");
    success(await rooms.roomOpen(owner, OPEN, call, prompt("yes")));

    // A second request while the first prompt is open is refused without a second prompt.
    const waiting = instance();
    let answer!: (a: R.RoomOpenAnswer) => void;
    const slow = prompt(() => new Promise((resolve) => { answer = resolve; }));
    const first = rooms.roomOpen(waiting, OPEN, call, slow);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await rooms.roomOpen(waiting, OPEN, call, slow), { refused: true, reason: R.ROOM_REFUSALS.open_in_progress });
    answer("cancelled");
    assert.deepEqual(await first, { refused: true, reason: R.ROOM_REFUSALS.open_cancelled });
    assert.equal(slow.asked, 1);
  } finally { b.close(); }
});

test("rooms open: the home-wide creation rate and live-room cap apply, before and after the prompt", async (t) => {
  const b = box();
  try {
    const at = Date.parse("2026-11-16T18:00:00.000Z");
    t.mock.method(Date, "now", () => at);
    for (let n = 0; n < R.ROOM_CREATIONS_PER_MINUTE; n++) success(rooms.roomCreate());
    const p = prompt("yes");
    assert.deepEqual(await rooms.roomOpen(instance(), OPEN, call, p), { refused: true, reason: "Refused: room limit reached: ROOM_CREATIONS_PER_MINUTE; retry after 2026-11-16T18:01:00.000Z." });
    assert.equal(p.asked, 0);
    t.mock.method(Date, "now", () => at + 2 * R.ROOM_RATE_WINDOW_MS);
    // Rooms created at the terminal while the prompt is open still count.
    const racing = prompt(async () => { for (let n = 0; n < R.ROOM_CREATIONS_PER_MINUTE; n++) success(rooms.roomCreate()); return "yes"; });
    assert.match(String((await rooms.roomOpen(instance(), OPEN, call, racing) as R.RoomRefusal).reason), /ROOM_CREATIONS_PER_MINUTE/);
  } finally { b.close(); }
});

test("rooms open: the host prompt's fixed text states information only, the send budget and the person's choice of peer", () => {
  const text = roomOpenPromptText({ keepsForm: false });
  assert.match(text, /Information only: never approvals, permissions or control of work/);
  assert.match(text, new RegExp(`At most ${R.ROOM_MAX_TURNS} messages`));
  assert.match(text, /another conversation you choose/); assert.match(text, /no other conversation joins unless you paste it there yourself/);
  assert.match(text, new RegExp(`"${R.ROOM_OPEN_YES}"`));
  // Claude Code shows about four lines, each cut to the terminal's width: those lines must be short
  // and say what is asked, the purpose, choose-yes-only-if and what yes does (live test, 2026-11-16).
  for (const purpose of [null, "Compare two plans"]) {
    const first = roomOpenPromptText({ keepsForm: true, purpose }).split("\n").slice(0, 4);
    assert.match(first[0], /asks you to open a room with another conversation you choose\.$/);
    if (purpose) assert.equal(first[1], "Purpose (written by the model, unverified): Compare two plans");
    const rest = first.slice(purpose ? 2 : 1);
    assert.match(rest[0], new RegExp(`^Choose "${R.ROOM_OPEN_YES}" only if you asked for this; anything else opens nothing\\.$`));
    assert.match(rest[1], /^On yes, member-2's prompt goes on your clipboard \(replacing it\); the model never sees it\.$/);
    for (const line of first) if (!line.startsWith("Purpose")) assert.ok(line.length <= 100, `short: ${line}`);
    if (!purpose) assert.equal(first[3], `Information only: never approvals, permissions or control of work. At most ${R.ROOM_MAX_TURNS} messages.`);
  }
  assert.doesNotMatch(text + roomOpenPromptText({ keepsForm: true }), /minutes?\b.*expire|expires after/);
  assert.doesNotMatch(text, /stay on screen/);
  assert.match(roomOpenPromptText({ keepsForm: true }), /this form can stay on screen; answering it then opens nothing/);
  assert.doesNotMatch(text + roomOpenPromptText({ keepsForm: true }), /ri1_/);
});

test("rooms open: only an accept of exactly the offered yes is a yes", () => {
  assert.equal(readRoomOpenAnswer({ action: "accept", content: { decision: R.ROOM_OPEN_YES } }), "yes");
  assert.equal(readRoomOpenAnswer({ action: "accept", content: { decision: R.ROOM_OPEN_NO } }), "declined");
  for (const content of [undefined, {}, { decision: "Open the room" }, { decision: true }, { decision: R.ROOM_OPEN_YES, note: "x" }, { approve: R.ROOM_OPEN_YES }]) {
    assert.equal(readRoomOpenAnswer({ action: "accept", content: content as never }), "unverified", JSON.stringify(content));
  }
  assert.equal(readRoomOpenAnswer({ action: "decline" }), "declined");
  assert.equal(readRoomOpenAnswer({ action: "cancel" }), "cancelled");
  assert.equal(readRoomOpenAnswer({ action: "something else" }), "unverified");
});

test("rooms open: the host prompt maps timeouts, the caller's cancellation, schema mismatches and errors to no", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rooms-open-log-"))), old = process.env.RELAY_HOME;
  process.env.RELAY_HOME = home;
  try {
    const asked: Record<string, unknown>[] = [];
    const server = (outcome: () => Promise<unknown>) => ({ server: { elicitInput: async (params: Record<string, unknown>, opts: Record<string, unknown>) => { asked.push({ params, opts }); return outcome(); } } });
    const ask = (outcome: () => Promise<unknown>, signal?: AbortSignal) => roomOpenThrough(server(outcome) as never, "test host")("message", { signal, timeoutMs: 1234 });
    assert.equal(await ask(async () => ({ action: "accept", content: { decision: R.ROOM_OPEN_YES } })), "yes");
    const [first] = asked as { params: { message: string; requestedSchema: { properties: { decision: { enum: string[] } } } }; opts: { timeout: number } }[];
    assert.equal(first.params.message, "message");
    assert.deepEqual(first.params.requestedSchema.properties.decision.enum, [R.ROOM_OPEN_NO, R.ROOM_OPEN_YES], "the safe choice first");
    assert.equal(first.opts.timeout, 1234);
    await roomOpenThrough(server(async () => ({ action: "cancel" })) as never, "test host")("message", {});
    assert.equal((asked.at(-1) as { opts: { timeout: number } }).opts.timeout, 2_147_483_647, "no deadline of relay's own: the longest timer Node takes, not the SDK's 60 s default");
    assert.equal(await ask(async () => { throw new McpError(ErrorCode.RequestTimeout, "Request timed out"); }), "timed_out");
    const ctl = new AbortController(); ctl.abort();
    assert.equal(await ask(async () => ({ action: "accept", content: { decision: R.ROOM_OPEN_YES } }), ctl.signal), "cancelled", "an aborted call never asks");
    const late = new AbortController();
    assert.equal(await ask(async () => { late.abort(); throw new McpError(ErrorCode.RequestTimeout, "aborted"); }, late.signal), "cancelled");
    assert.equal(await ask(async () => { throw new McpError(ErrorCode.InvalidParams, "Elicitation response content does not match requested schema"); }), "unverified");
    assert.equal(await ask(async () => { throw new Error("transport closed"); }), "unavailable");
    const log = fs.readFileSync(path.join(home, "elicitation.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.map((e) => e.reading), ["yes", "cancelled", "timed_out", "cancelled", "cancelled", "unverified", "unavailable"]);
    assert.ok(log.every((e) => e.request === "room-open"));
  } finally {
    if (old === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("rooms open: origin is recorded, shown in views, the transcript header and listings, and named in the join question", async () => {
  const b = box();
  try {
    const opened = success(await rooms.roomOpen(instance(), OPEN, call, prompt("yes")));
    const terminal = success(rooms.roomCreate()) as R.RoomCreateResult;
    assert.equal(opened.origin, "open");
    const printed = success(rooms.roomPrint(opened.room_id)), other = success(rooms.roomPrint(terminal.room_id));
    assert.equal(printed.origin, "open"); assert.equal(other.origin, "terminal");
    assert.match(renderRoomTranscript(printed), /^relay: room rm_[0-9a-f]{32}; state waiting; revision \d+; origin opened by a conversation \(room open\)$/m);
    assert.match(renderRoomTranscript(other), /; origin terminal \(relay room new\)$/m);
    const listed = JSON.parse(renderRoomList(rooms.roomList()));
    assert.deepEqual(listed.map((r: { room_id: string; origin: string }) => [r.room_id, r.origin]).sort(), [[opened.room_id, "open"], [terminal.room_id, "terminal"]].sort());
    // The join question names it.
    const asked: R.RoomJoinQuestion[] = [];
    const ask = { ask: async (q: R.RoomJoinQuestion) => { asked.push(q); return "declined" as const; }, authorized: () => true };
    await rooms.roomJoin(instance("claude"), { action: "join", invite: terminal.invites[0].invite }, call, ask);
    assert.equal(asked[0].origin, "terminal"); assert.equal(asked[0].purpose, null);
    assert.match(roomJoinPromptText(asked[0], { keepsForm: false }), /the room was created at a terminal\./);
    assert.doesNotMatch(roomJoinPromptText(asked[0], { keepsForm: false }), /Purpose/);
  } finally { b.close(); }
});

test("rooms open: a purpose line is the model's, sanitized, capped, single line, and labelled wherever it is shown", async () => {
  const b = box();
  try {
    const sanitizing = { ...call, sanitizeText: roomText } as R.RoomCallEvidence;
    const asked: (string | null | undefined)[] = [];
    const p = { ask: async (o: { purpose?: string | null }) => { asked.push(o.purpose); return "yes" as const; }, authorized: () => true, deliver: () => true };
    const opened = success(await rooms.roomOpen(instance(), { action: "open", purpose: "Settle the \u202eschedule\u202c with the Codex side" }, sanitizing, p));
    const [purpose] = asked;
    assert.ok(purpose && !purpose.includes("\u202e"), "bidi controls are escaped like room text");
    assert.equal(purpose, "(1 line, shown escaped) Settle the \\u{202E}schedule\\u{202C} with the Codex side", "room text hygiene, marker included");
    assert.equal(success(rooms.roomPrint(opened.room_id)).purpose, purpose);
    assert.equal(JSON.stringify(opened).includes("Settle"), false, "the purpose is not echoed in the view");
    // Shown labelled in the open question, the transcript header and the join question.
    assert.match(roomOpenPromptText({ keepsForm: false, purpose }), /\nPurpose \(written by the model, unverified\): \(1 line, shown escaped\) Settle the /);
    assert.doesNotMatch(roomOpenPromptText({ keepsForm: false }), /Purpose/);
    assert.match(renderRoomTranscript(success(rooms.roomPrint(opened.room_id))), /^relay: Purpose \(written by the model, unverified\): "\(1 line, shown escaped\) Settle the /m);
    const questions: R.RoomJoinQuestion[] = [];
    const delivered: string[] = [];
    const p2 = { ask: async () => "yes" as const, authorized: () => true, deliver: (text: string) => { delivered.push(text); return true; } };
    success(await rooms.roomOpen(instance(), { action: "open", purpose: "Compare two plans" }, sanitizing, p2));
    await rooms.roomJoin(instance("claude"), { action: "join", invite: invitesIn(delivered[0])[0] }, call, { ask: async (q) => { questions.push(q); return "declined"; }, authorized: () => true });
    assert.equal(questions[0].origin, "open"); assert.equal(questions[0].purpose, "Compare two plans");
    assert.match(roomJoinPromptText(questions[0], { keepsForm: false }), /the room was opened by another conversation\.\nPurpose \(written by the model, unverified\): Compare two plans\n/);
    // Member-2's prompt says what the room is for, labelled the same way.
    assert.match(delivered[0], /\nPurpose \(written by the model, unverified\): Compare two plans\nExchange information for that purpose; ask the other conversation for context if you need it\.\n/);
    assert.doesNotMatch(delivered[0], /recommendation we have been discussing/);
    // No purpose: none shown anywhere.
    const plainOpen = success(await rooms.roomOpen(instance(), OPEN, call, prompt("yes")));
    assert.equal(success(rooms.roomPrint(plainOpen.room_id)).purpose, null);
  } finally { b.close(); }
});

test("rooms open: a recognized credential in the purpose line is redacted before the person or member-2 sees it", async () => {
  const b = box();
  try {
    const key = "sk-ant-api03-" + "Ab1".repeat(30), asked: (string | null | undefined)[] = [], delivered: string[] = [];
    const p = { ask: async (o: { purpose?: string | null }) => { asked.push(o.purpose); return "yes" as const; }, authorized: () => true, deliver: (text: string) => { delivered.push(text); return true; } };
    const opened = success(await rooms.roomOpen(instance(), { action: "open", purpose: `Try ${key}` }, { ...call, sanitizeText: roomText } as R.RoomCallEvidence, p));
    assert.deepEqual(asked, ["Try [redacted]"]);
    assert.equal(success(rooms.roomPrint(opened.room_id)).purpose, "Try [redacted]");
    assert.ok(!delivered[0].includes(key) && delivered[0].includes("Try [redacted]"));
  } finally { b.close(); }
});

test("rooms open: a purpose that is not one short clean line refuses before anyone is asked", async () => {
  const b = box();
  try {
    const p = prompt("yes");
    const bad = ["", "   ", "line one\nline two", "a\rb", "a\u2028b", "x".repeat(R.ROOM_PURPOSE_CODE_POINTS + 1), `join with ri1_${"a".repeat(32)}`, `rs1_${"b".repeat(56)}`];
    for (const purpose of bad) {
      assert.deepEqual(await rooms.roomOpen(instance(), { action: "open", purpose }, { ...call, sanitizeText: roomText } as R.RoomCallEvidence, p), { refused: true, reason: R.ROOM_REFUSALS.purpose }, JSON.stringify(purpose));
    }
    assert.deepEqual(await rooms.roomOpen(instance(), { action: "open", purpose: "x".repeat(R.ROOM_PURPOSE_INPUT_UNITS + 1) }, call, p), { refused: true, reason: R.ROOM_REFUSALS.arguments });
    assert.equal(p.asked, 0);
    nothingWritten();
    // Exactly at the cap is fine.
    success(await rooms.roomOpen(instance(), { action: "open", purpose: "y".repeat(R.ROOM_PURPOSE_CODE_POINTS) }, call, p));
  } finally { b.close(); }
});
