// Direct protocol tests: scratch registries and existing root owners, no server or agent.
import "./helpers.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { newInstance, type Instance } from "../dist/core/caller.js";
import { closeDbForTests, db } from "../dist/core/db.js";
import { procStart } from "../dist/core/procs.js";
import { roomOwnerExposed, roomOwnerHash } from "../dist/core/room-policy.js";
import { roomClientName, roomText } from "../dist/core/shown.js";
import * as rooms from "../dist/core/rooms.js";
import * as R from "../dist/core/room-types.js";

const api: R.RoomsApi = rooms;
const UNAVAILABLE = { error: R.ROOM_UNAVAILABLE_ERROR, recovery: R.ROOM_UNAVAILABLE_RECOVERY };
const plain = (s: string) => s;
function evidence(overrides: Partial<R.RoomCallEvidence> = {}): R.RoomCallEvidence {
  return Object.freeze({
    identity: Object.freeze({ call_id: crypto.randomUUID(), scope: "dedicated-process", harness: "test root", family: "openai", subagent: false, singleton_violation: false,
      codex: Object.freeze({ malformed: false, metadata_present: true, thread_id: "test", thread_source: "user", turn_trigger: null, originator: null, sandbox: null, auto_review: null, approval_policy: null }) }),
    eligibility: Object.freeze({ eligible: true }), block_s: 50, host_wait_cap_s: null, sanitizeText: plain, ...overrides,
  }) as R.RoomCallEvidence;
}
const call = evidence();
function instance(shared = false, family: "codex" | "claude" = "codex"): Instance {
  const i = newInstance({ kind: "root" }, process.cwd(), family);
  if (shared) i.carried = true;
  return i;
}
function box() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rooms-"))), old = process.env.RELAY_HOME;
  closeDbForTests(); process.env.RELAY_HOME = home;
  return { home, close() { closeDbForTests(); if (old === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = old; fs.rmSync(home, { recursive: true, force: true }); } };
}
function success<T>(result: T): Exclude<T, R.RoomFailure> {
  assert.ok(result && typeof result === "object" && !("error" in result) && !("refused" in result), JSON.stringify(result));
  return result as Exclude<T, R.RoomFailure>;
}
function create() { return success(api.roomCreate()) as R.RoomCreateResult; }
const join = (i: Instance, invite: string, c = call) => api.roomJoin(i, { action: "join", invite }, c);
const sendInput = (cursor: number, stance: R.RoomStance = "continue", text = "recommendation") => ({ action: "send" as const, cursor, stance, text, request_id: crypto.randomUUID() });
const send = (i: Instance, cursor: number, stance: R.RoomStance = "continue", text = "recommendation", c = call) => api.roomSend(i, sendInput(cursor, stance, text), c);
const read = (i: Instance, cursor: number, c = call) => api.roomTranscript(i, { action: "transcript", cursor }, c);
const wait = (i: Instance, cursor: number, wait_s = 0, c = call) => api.roomWait(i, { action: "wait", cursor, wait_s }, c);
function backdate(id: R.RoomId) {
  db().prepare("UPDATE room_messages SET created_at = created_at - 1001 WHERE room_id = ?").run(id);
  db().prepare("UPDATE room_members SET read_times_json = '[]' WHERE room_id = ?").run(id);
}
async function pair(shared = false) {
  const r = create(), a = instance(), b = instance(shared, "claude");
  const ja = success(await join(a, r.invites[0].invite)); assert.equal(ja.state, "waiting");
  const jb = success(await join(b, r.invites[1].invite)); assert.equal(jb.state, "open");
  return { r, a, b, aid: ja.member_id, bid: jb.member_id };
}
function rowCount(table: string) { return Number(db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n); }
function noAuthority(...owners: Instance[]) {
  for (const table of ["runs", "nodes", "turns", "slots", "requests", "relay_procs"]) assert.equal(rowCount(table), 0, table);
  for (const i of owners) { assert.equal(i.runId, null); assert.equal(i.waiting.size, 0); }
}

for (const shared of [true, false]) test(`rooms trace: ${shared ? "Codex and shared desktop" : "two dedicated roots"} reach agreement without run authority`, async () => {
  const box_ = box();
  try {
    const { r, a, b, aid, bid } = await pair(shared);
    assert.equal((await send(b, 0) as R.RoomRefusal).reason, R.ROOM_REFUSALS.turn);
    if (shared) {
      const first = success(await send(a, 0, "continue", "I recommend A."));
      assert.equal(first.accepted_seq, 1); assert.equal(first.next, bid);
      const got = success(await wait(b, 0, 45));
      assert.equal(got.messages[0].text, "I recommend A."); assert.equal(got.through_seq, 1);
      assert.equal(success(await wait(b, 0, 45)).messages[0].seq, 1);
      success(await send(b, 1, "agree", "A with a small scope."));
      const second = success(await wait(a, 1, 45)); assert.equal(second.through_seq, 2);
      backdate(r.room_id);
      const last = success(await send(a, 2, "agree", "Use A with that scope."));
      assert.equal(last.state, "ended"); assert.equal(last.ending?.conclusion_seq, 3); assert.equal(last.revision, 6);
      assert.equal(success(await wait(b, 2, 45)).ending?.reason, "agreement");
    } else {
      const pendingB = wait(b, 0, 45);
      assert.equal(api.roomMaintenanceBusy(), true);
      success(await send(a, 0, "agree", "I recommend A."));
      assert.equal(success(await pendingB).messages[0].seq, 1);
      const pendingA = wait(a, 1, 45);
      const last = success(await send(b, 1, "agree", "Use A."));
      assert.equal(last.state, "ended"); assert.equal(last.ending?.conclusion_seq, 2); assert.equal(last.revision, 5);
      assert.equal(success(await pendingA).ending?.reason, "agreement");
    }
    const printed = success(api.roomPrint(r.room_id));
    assert.equal(printed.note, R.ROOM_NOTE); assert.equal(printed.seats[0].member_id, aid);
    assert.equal(api.roomMaintenanceBusy(), false); noAuthority(a, b);
  } finally { box_.close(); }
});

test("rooms invites: hashes only, atomic one-winner join, lost-join replay and identical unavailable cases", async () => {
  const b = box();
  try {
    const r = create(), a = instance(), other = instance(), peer = instance();
    assert.notEqual(r.invites[0].invite, r.invites[1].invite);
    for (const inv of r.invites) assert.match(inv.invite, R.ROOM_INVITE_SHAPE);
    const [one, two] = await Promise.all([join(a, r.invites[0].invite), join(other, r.invites[0].invite)]);
    assert.equal(success(one).repeated, false); assert.deepEqual(two, UNAVAILABLE);
    assert.equal(success(await join(a, r.invites[0].invite)).repeated, true);
    assert.deepEqual(await join(a, r.invites[1].invite), UNAVAILABLE, "self-pairing");
    assert.deepEqual(await join(other, "ri1_" + "0".repeat(32)), UNAVAILABLE);
    assert.deepEqual(await join(other, "bad"), UNAVAILABLE);
    const next = create();
    assert.deepEqual(await join(a, next.invites[0].invite), UNAVAILABLE, "one live room per owner");
    success(await join(peer, r.invites[1].invite));
    db().prepare("UPDATE room_invites SET expires_at = ? WHERE room_id = ?").run(Date.now() - 1, r.room_id);
    assert.equal(success(await join(a, r.invites[0].invite)).repeated, true, "consumed replay before expiry");
    db().prepare("UPDATE room_invites SET expires_at = ? WHERE room_id = ?").run(Date.now() - 1, next.room_id);
    assert.deepEqual(await join(other, next.invites[0].invite), UNAVAILABLE, "expired");
    assert.equal(success(api.roomPrint(next.room_id)).ending?.reason, "expired");
    const reseated = success(api.roomReseat(r.room_id, r.invites[0].member_id, 1));
    assert.deepEqual(await join(a, r.invites[0].invite), UNAVAILABLE, "revoked replay");
    assert.deepEqual(await read(a, 0), UNAVAILABLE); assert.deepEqual(await read(instance(), 0), UNAVAILABLE, "restart");
    success(await join(other, reseated.invite.invite));
    for (const name of fs.readdirSync(b.home).filter((n) => n.startsWith("relay.db"))) {
      const bytes = fs.readFileSync(path.join(b.home, name));
      for (const inv of [...r.invites, ...next.invites, reseated.invite]) assert.equal(bytes.includes(Buffer.from(inv.invite)), false, name);
      assert.equal(bytes.includes(Buffer.from(a.token)), false);
    }
    assert.equal(rowCount("room_bindings"), 2);
  } finally { b.close(); }
});

test("rooms eligibility and invalid fields refuse without lookup, text or invite consumption", async () => {
  const b = box();
  try {
    const r = create(), a = instance();
    const ineligible = evidence({ eligibility: Object.freeze({ eligible: false, refused: true, reason: R.ROOM_REFUSALS.ineligible }) });
    const before = JSON.stringify(db().prepare("SELECT * FROM room_invites").all());
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function () { throw new Error("lookup forbidden"); };
    try {
      for (const [fn, input] of [
        [api.roomJoin, { action: "join", invite: r.invites[0].invite }], [api.roomSend, sendInput(0)],
        [api.roomWait, { action: "wait", cursor: 0 }], [api.roomTranscript, { action: "transcript", cursor: 0 }], [api.roomClose, { action: "close", cursor: 0 }],
      ] as const) assert.deepEqual(await (fn as Function)(a, input, ineligible), { refused: true, reason: R.ROOM_REFUSALS.ineligible });
    } finally { DatabaseSync.prototype.prepare = prepare; }
    assert.equal(JSON.stringify(db().prepare("SELECT * FROM room_invites").all()), before);
    assert.deepEqual(await join(a, "x".repeat(257)), { refused: true, reason: R.ROOM_REFUSALS.arguments });
    success(await join(a, r.invites[0].invite));
    for (const cursor of [-1, 1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.deepEqual(await read(a, cursor), { refused: true, reason: R.ROOM_REFUSALS.arguments });
    assert.deepEqual(await api.roomWait(a, { action: "wait", cursor: 0, wait_s: 21601 }, call), { refused: true, reason: R.ROOM_REFUSALS.arguments });
    assert.deepEqual(await api.roomTranscript(a, { action: "transcript", cursor: 0, room_id: r.room_id } as never, call), { refused: true, reason: R.ROOM_REFUSALS.arguments });
    noAuthority(a);
  } finally { b.close(); }
});

test("rooms owners: shared owner survives instance eviction, foreign and fresh owners cannot read", async () => {
  const b = box();
  try {
    const { r, a, b: peer } = await pair(true);
    success(await send(a, 0));
    assert.deepEqual(await read(instance(true), 0), UNAVAILABLE);
    const restored = instance(true); restored.token = peer.token;
    assert.equal(success(await read(restored, 0)).messages[0].seq, 1);
    assert.equal(success(await join(restored, r.invites[1].invite)).repeated, true);
    assert.equal(rowCount("room_bindings"), 2);
  } finally { b.close(); }
});

test("rooms re-seat preserves turns, next, rows, dedup and rates; old generation cannot send or finish a wait", async () => {
  const b = box();
  try {
    const { r, a, b: peer, aid, bid } = await pair();
    const original = sendInput(0, "agree"); success(await api.roomSend(a, original, call));
    const pending = wait(a, 1, 45);
    const old = success(api.roomPrint(r.room_id));
    const replaced = success(api.roomReseat(r.room_id, aid, 1));
    assert.deepEqual(await pending, UNAVAILABLE, "wait cannot deliver after revocation");
    assert.deepEqual(await read(a, 0), UNAVAILABLE);
    assert.deepEqual(await api.roomSend(a, original, call), UNAVAILABLE, "retry cannot bypass revocation");
    assert.deepEqual(api.roomReseat(r.room_id, aid, 1), UNAVAILABLE, "reviewed generation");
    const replacement = instance();
    const paused = success(await read(peer, 0)); assert.equal(paused.state, "waiting"); assert.deepEqual(paused.messages, []);
    const open = success(await join(replacement, replaced.invite.invite));
    assert.equal(open.turns, 1); assert.equal(open.next, bid); assert.equal(open.messages[0].seq, 1);
    assert.equal(open.user_confirmed_ignored, true, "earlier owner's row is external");
    assert.equal(roomOwnerExposed(roomOwnerHash(replacement.token)), true);
    const repeated = success(await api.roomSend(replacement, original, evidence({ sanitizeText: () => { throw new Error("retry must not sanitize"); } })));
    assert.equal(repeated.repeated, true); assert.equal(repeated.accepted_seq, 1);
    assert.equal(success(api.roomPrint(r.room_id)).messages.length, old.messages.length);
    const final = success(await send(peer, 1, "agree")); assert.equal(final.ending?.reason, "agreement", "pending agreement survives re-seat");
    assert.equal(success(api.roomPrint(r.room_id)).turns, 2);
    assert.equal(api.roomMaintenanceBusy(), false);
  } finally { b.close(); }
});

test("rooms in-flight sanitizer re-seat revokes the captured generation before insertion", async () => {
  const b = box();
  try {
    const { r, a, aid } = await pair();
    const result = await send(a, 0, "continue", "old", evidence({ sanitizeText(text) { success(api.roomReseat(r.room_id, aid, 1)); return text; } }));
    assert.deepEqual(result, UNAVAILABLE); assert.equal(rowCount("room_messages"), 0);
    assert.equal(success(api.roomPrint(r.room_id)).turns, 0);
  } finally { b.close(); }
});

test("rooms cursors: nondestructive replay, oldest external page, stale send includes unread rows and terminal race writes nothing", async () => {
  const b = box();
  try {
    const { r, a, b: peer } = await pair();
    success(await send(a, 0));
    success(api.roomAddLine(r.room_id, "terminal one", plain)); success(api.roomAddLine(r.room_id, "terminal two", plain));
    const first = success(await wait(peer, 0)); assert.equal(first.through_seq, 1); assert.equal(first.remaining, 2);
    assert.deepEqual(success(await wait(peer, 0)).messages, first.messages, "lost result replay");
    const stale = await send(peer, 1);
    assert.equal((stale as R.RoomRefusalView).reason, R.ROOM_REFUSALS.stale);
    assert.equal((stale as R.RoomRefusalView).messages[0].seq, 2); assert.equal(rowCount("room_messages"), 3);
    const last = success(await wait(peer, 2)); assert.equal(last.messages[0].seq, 3); assert.equal(last.remaining, 0);
    success(await send(peer, 3)); backdate(r.room_id);
    const ownSkip = success(await wait(a, 0)); assert.equal(ownSkip.messages[0].seq, 2); assert.equal(ownSkip.through_seq, 2); assert.equal(ownSkip.remaining, 2);
    const own = success(await read(a, 0)); assert.equal(own.messages[0].seq, 1); assert.equal(own.through_seq, 1);
    const racing = await send(a, 4, "continue", "new", evidence({ sanitizeText(text) { success(api.roomAddLine(r.room_id, "racing line", plain)); return text; } }));
    assert.equal((racing as R.RoomRefusalView).reason, R.ROOM_REFUSALS.stale);
    assert.equal((racing as R.RoomRefusalView).messages[0].seq, 5); assert.equal(rowCount("room_messages"), 5);
    assert.equal(success(api.roomPrint(r.room_id)).turns, 2);
  } finally { b.close(); }
});

test("rooms text: exact original hash, sanitation once, all budgets and credential shapes, no truncation", async () => {
  const b = box();
  try {
    const { r, a, b: peer } = await pair(); let sanitizations = 0;
    // Each refusal says which rule the text broke.
    for (const [text, why] of [["", "text_empty"], [" \n ", "text_empty"], ["x".repeat(4001), "text_long"], ["😀".repeat(2001), "text_long"],
      ["before RI1_" + "AB".repeat(16), "text_secret"], ["x RS1_" + "AB".repeat(28), "text_secret"]] as const) {
      assert.deepEqual(await send(a, 0, "continue", text), { refused: true, reason: R.ROOM_REFUSALS[why] }, why);
    }
    assert.match(R.ROOM_REFUSALS.text_long, /longer than 4000 characters/);
    for (const [clean, why] of [["x".repeat(12001), "text"], ['"'.repeat(8000), "text"], ["RI1_" + "AB".repeat(16), "text_secret"], [" ", "text_empty"]] as const) {
      assert.deepEqual(await send(a, 0, "continue", "original", evidence({ sanitizeText: () => clean })), { refused: true, reason: R.ROOM_REFUSALS[why] }, why);
    }
    assert.equal(rowCount("room_messages"), 0);
    const input = sendInput(0, "continue", "original\ud800");
    success(await api.roomSend(a, input, evidence({ sanitizeText(s) { sanitizations++; assert.equal(s, "original�"); return "sanitized once"; } })));
    const row = db().prepare("SELECT * FROM room_messages").get()!;
    assert.equal(row.text, "sanitized once");
    assert.equal(row.args_hash, crypto.createHash("sha256").update(R.ROOM_SEND_DOMAIN + JSON.stringify([input.text, input.stance])).digest("hex"));
    assert.equal(sanitizations, 1);
    const large = "é".repeat(4000);
    const accepted = success(await send(peer, 1, "continue", large));
    assert.equal(accepted.accepted_seq, 2); assert.equal(success(await wait(a, 1)).messages[0].text, large);
    for (const row of success(api.roomPrint(r.room_id)).messages) assert.ok(Buffer.byteLength(JSON.stringify(row, null, 2)) <= R.ROOM_ROW_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(await read(a, 1), null, 2)) <= R.ROOM_RESULT_BYTES);
  } finally { b.close(); }
});

test("rooms text: recognized credentials in member messages and terminal lines are redacted before they are stored, and escaping still marks the line", async () => {
  const b = box();
  try {
    const key = "sk-ant-api03-" + "Ab1".repeat(30);
    const { r, a, b: peer } = await pair();
    // Any sanitizer the host injects sees the text already cut; the shared one escapes after that.
    const seen: string[] = [];
    success(await send(a, 0, "continue", `use ${key} here`, evidence({ sanitizeText(s) { seen.push(s); return roomText(s); } })));
    assert.deepEqual(seen, ["use [redacted] here"]);
    success(api.roomAddLine(r.room_id, `terminal ${key}‮`, roomText));
    const stored = (db().prepare("SELECT text FROM room_messages WHERE room_id = ? ORDER BY seq").all(r.room_id) as { text: string }[]).map((row) => row.text);
    assert.deepEqual(stored, ["use [redacted] here", "(1 line, shown escaped) terminal [redacted]\\u{202E}"]);
    const views = JSON.stringify([success(api.roomPrint(r.room_id)), success(await read(peer, 0))]);
    assert.ok(!views.includes(key) && !views.includes("Ab1Ab1"), "no copy of the key in any view");
    // Invites and session tokens still refuse rather than redact.
    assert.deepEqual(await send(peer, 2, "continue", `x ri1_${"a".repeat(32)}`), { refused: true, reason: R.ROOM_REFUSALS.text_secret });
    assert.equal((api.roomAddLine(r.room_id, `rs1_${"a".repeat(56)}`, roomText) as R.RoomRefusal).reason, R.ROOM_REFUSALS.text_secret);
  } finally { b.close(); }
});

for (const ending of ["agreement", "crux", "turn_limit", "closed", "terminal", "expired"] as const) test(`rooms ending: ${ending} is immutable and accepted requests still replay`, async () => {
  const b = box();
  try {
    const { r, a, b: peer } = await pair();
    const input = sendInput(0, ending === "agreement" ? "agree" : ending === "crux" ? "crux" : "continue");
    success(await api.roomSend(a, input, call));
    if (ending === "agreement" || ending === "crux") success(await send(peer, 1, "agree"));
    if (ending === "turn_limit") {
      for (let n = 2; n <= 24; n++) { backdate(r.room_id); success(await send(n % 2 ? a : peer, n - 1, n === 24 ? "crux" : "continue")); }
    }
    if (ending === "closed") success(await api.roomClose(peer, { action: "close", cursor: 1 }, call));
    if (ending === "terminal") success(api.roomCloseAtTerminal(r.room_id));
    if (ending === "expired") { db().prepare("UPDATE rooms SET expires_at = ? WHERE id = ?").run(Date.now() - 1, r.room_id); success(await read(a, 0)); }
    const before = success(api.roomPrint(r.room_id));
    assert.equal(before.ending?.reason, ending === "terminal" ? "closed" : ending);
    assert.equal(before.ending?.closed_by, ending === "terminal" ? "terminal" : ending === "closed" ? r.invites[1].member_id : null);
    assert.equal(before.ending?.conclusion_seq, ending === "agreement" ? 2 : null);
    assert.equal(success(await api.roomSend(a, input, evidence({ sanitizeText: () => { throw new Error("retry"); } }))).repeated, true);
    assert.equal((await api.roomSend(a, { ...input, text: input.text + "changed" }, call) as R.RoomRefusalView).reason, R.ROOM_REFUSALS.changed_retry);
    assert.equal((await send(a, before.messages.length) as R.RoomRefusalView).reason, R.ROOM_REFUSALS.not_open);
    backdate(r.room_id);
    success(api.roomCloseAtTerminal(r.room_id)); success(await api.roomClose(a, { action: "close", cursor: 0 }, call));
    const after = success(api.roomPrint(r.room_id));
    assert.deepEqual(after.ending, before.ending); assert.equal(after.ended_at, before.ended_at); assert.equal(after.revision, before.revision);
    assert.equal((api.roomReseat(r.room_id, r.invites[0].member_id, 1) as R.RoomRefusal).reason, R.ROOM_REFUSALS.not_open);
  } finally { b.close(); }
});

test("rooms endings: terminal invalidates agreement, agreement beats cap, cap beats CRUX response", async () => {
  const b = box();
  try {
    const { r, a, b: peer } = await pair();
    success(await send(a, 0, "agree")); success(api.roomAddLine(r.room_id, "reconsider", plain));
    const next = success(await send(peer, 2, "agree")); assert.equal(next.state, "open"); assert.equal(next.turns, 2);
    backdate(r.room_id);
    const last = success(await send(a, 3, "agree")); assert.equal(last.ending?.reason, "agreement"); assert.equal(last.ending?.conclusion_seq, 4);
    const second = await pair();
    for (let n = 1; n <= 24; n++) { backdate(second.r.room_id); const v = success(await send(n % 2 ? second.a : second.b, n - 1, n >= 23 ? "agree" : "continue")); if (n === 24) assert.equal(v.ending?.reason, "agreement"); }
    const third = await pair();
    for (let n = 1; n <= 24; n++) { backdate(third.r.room_id); const v = success(await send(n % 2 ? third.a : third.b, n - 1, n === 23 ? "crux" : "continue")); if (n === 24) assert.equal(v.ending?.reason, "turn_limit"); }
  } finally { b.close(); }
});

test("rooms retries and competing writers cannot exceed turns, send rate or terminal capacity", async () => {
  const b = box();
  try {
    const { r, a, b: peer } = await pair();
    const input = sendInput(0);
    const both = await Promise.all([api.roomSend(a, input, call), api.roomSend(a, input, call)]);
    assert.equal(success(both[0]).accepted_seq, 1); assert.equal(success(both[1]).accepted_seq, 1);
    assert.equal(success(both[1]).repeated, true); assert.equal(rowCount("room_messages"), 1);
    success(await send(peer, 1));
    const rate = await Promise.all([send(a, 2), send(a, 2)]);
    assert.ok(rate.every((r) => (r as R.RoomRefusalView).reason.startsWith("Refused: room limit reached: ROOM_SEND_INTERVAL_MS")));
    backdate(r.room_id);
    const writers = await Promise.all([send(a, 2), send(a, 2)]);
    assert.equal(writers.filter((r) => "accepted_seq" in r).length, 1);
    assert.equal(success(api.roomPrint(r.room_id)).turns, 3);
    for (let n = 0; n < R.ROOM_TERMINAL_ROWS; n++) success(api.roomAddLine(r.room_id, `terminal ${n}`, plain));
    assert.equal((api.roomAddLine(r.room_id, "over capacity", plain) as R.RoomRefusal).reason, "Refused: room limit reached: ROOM_TERMINAL_ROWS.");
    assert.equal(success(api.roomPrint(r.room_id)).messages.length, 27);
    assert.equal(success(await api.roomSend(a, input, call)).repeated, true, "retry ignores stale cursor, turn and rates");
  } finally { b.close(); }
});

test("rooms exposure: own pages do not mark, external pages do; hashes survive end, re-seat and deletion", async () => {
  const b = box();
  try {
    const { r, a, b: peer, aid } = await pair();
    success(await send(a, 0));
    assert.equal(success(await read(a, 0)).user_confirmed_ignored, false);
    assert.equal(roomOwnerExposed(roomOwnerHash(a.token)), false);
    success(api.roomPrint(r.room_id)); assert.equal(rowCount("room_exposures"), 0, "terminal reads have no owner exposure");
    const v = success(await read(peer, 0)); assert.equal(v.user_confirmed_ignored, true);
    const oldTime = db().prepare("SELECT given_at FROM room_exposures").get()!.given_at;
    success(await read(peer, 0)); assert.equal(db().prepare("SELECT given_at FROM room_exposures").get()!.given_at, oldTime);
    success(api.roomAddLine(r.room_id, "terminal", plain)); success(await wait(a, 1)); assert.equal(roomOwnerExposed(roomOwnerHash(a.token)), true);
    success(api.roomReseat(r.room_id, aid, 1));
    success(api.roomCloseAtTerminal(r.room_id));
    const sweep = api.roomSweep({ at: Date.now() + 1, keep_records_days: 0 }); assert.deepEqual(sweep.deleted, [r.room_id]);
    assert.equal(rowCount("room_exposures"), 2); assert.equal(roomOwnerExposed(roomOwnerHash(peer.token)), true);
    for (const table of ["rooms", "room_members", "room_invites", "room_bindings", "room_messages"]) assert.equal(rowCount(table), 0, table);
    noAuthority(a, peer);
  } finally { b.close(); }
});

test("rooms wait: cancellation, live lease exclusion, dead lease recovery, only room changes wake", async () => {
  const b = box();
  try {
    const { r, b: a, a: peer, bid: aid } = await pair();
    const controller = new AbortController();
    const pending = wait(a, 0, 45, evidence({ signal: controller.signal }));
    assert.equal(api.roomMaintenanceBusy(), true);
    assert.equal((await wait(a, 0, 45) as R.RoomRefusalView).reason, R.ROOM_REFUSALS.duplicate_wait);
    controller.abort(); const result = success(await pending);
    assert.equal(result.wait_ended, false); assert.equal(api.roomMaintenanceBusy(), false);
    assert.equal(db().prepare("SELECT wait_nonce FROM room_members WHERE id = ?").get(aid)!.wait_nonce, null);
    db().prepare("UPDATE room_members SET wait_pid = 2147483647, wait_start = 'dead', wait_nonce = 'old' WHERE id = ?").run(aid);
    assert.equal(api.roomMaintenanceBusy(), false);
    const pending2 = wait(a, 0, 45);
    // A bare peer call does not wake a wait (two waiters would otherwise spin); a room change does.
    success(await read(peer, 0));
    assert.equal(await Promise.race([pending2.then(() => "woke"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 500))]), "waiting");
    success(api.roomAddLine(r.room_id, "terminal wake", plain));
    const woke = success(await pending2); assert.equal(woke.wait_ended, false); assert.equal(woke.messages[0]?.text, "terminal wake");
    db().prepare("UPDATE room_members SET read_times_json = '[]', wait_pid = ?, wait_start = NULL, wait_nonce = 'unknown' WHERE id = ?").run(process.pid, aid);
    assert.equal(api.roomMaintenanceBusy(), true, "unreadable identity cannot clear a lease");
    assert.equal((await wait(a, 1) as R.RoomRefusalView).reason, R.ROOM_REFUSALS.duplicate_wait);
    db().prepare("UPDATE room_members SET wait_nonce = NULL WHERE id = ?").run(aid);
    noAuthority(a, peer);
  } finally { b.close(); }
});

for (const cap of ["default", "maximum", "block", "host", "deadline", "expiry", "idle"] as const) test(`rooms wait cap: ${cap}`, async (t) => {
  const b = box(), realNow = Date.now;
  try {
    const { r, b: a, a: peer, aid: bid } = await pair();
    const base = realNow(); let at = base;
    t.mock.method(Date, "now", () => at);
    const expected = { default: 45000, maximum: 50000, block: 12000, host: 18000, deadline: 23000, expiry: 28000, idle: 33000 }[cap];
    const c = evidence({ block_s: cap === "block" ? 12 : 80, host_wait_cap_s: cap === "host" ? 18 : null, deadline: cap === "deadline" ? base + expected : undefined });
    if (cap === "expiry") db().prepare("UPDATE rooms SET expires_at = ? WHERE id = ?").run(base + expected, r.room_id);
    // Silence caps a wait only where the peer's process is unknown: here a shared seat.
    if (cap === "idle") db().prepare("UPDATE room_members SET owner_kind = 'shared', pid = NULL, pid_start = NULL, last_call_at = ? WHERE id = ?").run(base - R.ROOM_PEER_SILENCE_S * 1000 + expected, bid);
    const pending = api.roomWait(a, { action: "wait", cursor: 0, ...(cap === "default" ? {} : { wait_s: 50 }) }, c);
    at += expected - 1;
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(api.roomMaintenanceBusy(), true, "still waiting just below cap");
    at++;
    const settled = await pending;
    if (cap === "idle") {
      // Cut at the silence fallback with nothing to read: the refusal itself, not a plain view.
      const refused = settled as R.RoomRefusalView;
      assert.equal(refused.reason, R.ROOM_REFUSALS.idle_peer); assert.equal(refused.poll.stopped, true);
    } else {
      const result = success(settled);
      assert.equal(result.wait_ended, cap !== "expiry", "expiry is a state change, other caps elapse");
      if (cap === "expiry") assert.equal(result.ending?.reason, "expired");
    }
    assert.equal(api.roomMaintenanceBusy(), false); noAuthority(a, peer);
  } finally { t.mock.restoreAll(); b.close(); }
});

test("rooms wait: a long-wait host may wait for hours in one call; elsewhere 50 s and block_s still cap it", async (t) => {
  for (const long of [true, false]) {
    const b = box(), realNow = Date.now;
    try {
      const { b: a, a: peer } = await pair();
      const base = realNow(); let at = base;
      t.mock.method(Date, "now", () => at);
      const expected = long ? 3_600_000 : 12_000;
      const pending = api.roomWait(a, { action: "wait", cursor: 0, wait_s: 3600 }, evidence({ block_s: 12, long_waits: long }));
      at += expected - 1;
      await new Promise((resolve) => setTimeout(resolve, 220));
      assert.equal(api.roomMaintenanceBusy(), true, `${long}: still waiting just below ${expected} ms`);
      at++;
      const result = success(await pending);
      assert.equal(result.wait_ended, true);
      assert.equal(api.roomMaintenanceBusy(), false); noAuthority(a, peer);
    } finally { t.mock.restoreAll(); b.close(); }
  }
  // Without long waits the 50 s maximum applies even with a larger block_s.
  const b = box(), realNow = Date.now;
  try {
    const { b: a } = await pair();
    const base = realNow(); let at = base;
    t.mock.method(Date, "now", () => at);
    const pending = api.roomWait(a, { action: "wait", cursor: 0, wait_s: 3600 }, evidence({ block_s: 600 }));
    at += 50_000;
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(success(await pending).wait_ended, true);
  } finally { t.mock.restoreAll(); b.close(); }
});

test("rooms idle-peer stop: a live peer may be silent for hours; only a gone peer stops waits", async () => {
  const b = box();
  try {
    const { r, a, b: peer, aid, bid } = await pair();
    success(await send(a, 0));
    // The peer (this process, a dedicated seat) has been quiet for three hours: waits go on.
    db().prepare("UPDATE room_members SET last_call_at = ? WHERE id = ?").run(Date.now() - 3 * 3600 * 1000, bid);
    success(await read(a, 0));
    const quiet = success(await wait(a, 1));
    assert.equal(quiet.wait_ended, true); assert.equal(quiet.poll.stopped, false); assert.equal(quiet.poll.stop_after_s, null);
    assert.equal(quiet.peer.process, "alive");
    // Its server exits: the seat is detached and reads as gone; waits stop at once.
    db().prepare("UPDATE room_members SET pid = ?, pid_start = ? WHERE id = ?").run(999_999, "Mon Jan  1 00:00:00 2001", bid);
    db().prepare("UPDATE room_members SET read_times_json = '[]' WHERE room_id = ?").run(r.room_id);
    const gone = await wait(a, 1, 45) as R.RoomRefusalView;
    assert.equal(gone.reason, R.ROOM_REFUSALS.idle_peer); assert.equal(gone.poll.stopped, true);
    assert.equal(gone.peer.process, "gone"); assert.equal(gone.peer.seat, "unseated");
    assert.equal(api.roomMaintenanceBusy(), false);
    assert.equal(success(api.roomPrint(r.room_id)).turns, 1);
    noAuthority(a, peer); void aid;
  } finally { b.close(); }
});

test("rooms idle-peer stop: where the peer's process is unknown, two hours of silence stop waits; own calls never reset it", async () => {
  const b = box();
  try {
    const { r, a, b: peer, bid } = await pair();
    success(await send(a, 0));
    const old = Date.now() - (R.ROOM_PEER_SILENCE_S * 1000 + 1);
    db().prepare("UPDATE room_members SET owner_kind = 'shared', pid = NULL, pid_start = NULL, last_call_at = ? WHERE id = ?").run(old, bid);
    success(await read(a, 0));
    const stopped = await wait(a, 1, 45) as R.RoomRefusalView;
    assert.equal(stopped.reason, R.ROOM_REFUSALS.idle_peer); assert.equal(stopped.poll.stopped, true);
    assert.equal(stopped.poll.stop_after_s, R.ROOM_PEER_SILENCE_S); assert.equal(stopped.peer.process, "unknown");
    assert.equal(stopped.peer.last_call_at, new Date(old).toISOString());
    assert.equal(api.roomMaintenanceBusy(), false); assert.equal(stopped.messages.length, 0);
    assert.equal((await wait(a, 1, 45) as R.RoomRefusalView).reason, R.ROOM_REFUSALS.idle_peer);
    success(await read(peer, 0));
    const resumed = success(await wait(a, 1)); assert.equal(resumed.poll.stopped, false); assert.equal(resumed.wait_ended, true);
    assert.equal(success(api.roomPrint(r.room_id)).turns, 1);
  } finally { b.close(); }
});

test("rooms wait: a peer server that exits during a long wait ends it, and the view says the peer is gone", async () => {
  const b = box();
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    const { r, a, bid } = await pair();
    success(await send(a, 0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const start = procStart(child.pid!, { fresh: true });
    assert.ok(start, "the stand-in peer server's start time is readable");
    db().prepare("UPDATE room_members SET pid = ?, pid_start = ? WHERE id = ?").run(child.pid, start, bid);
    success(await read(a, 0));
    const began = Date.now();
    const pending = wait(a, 1, 45);
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill("SIGKILL");
    const result = await pending as R.RoomRefusalView;
    assert.ok(Date.now() - began < 10_000, "woken by the exit, not the wait's length");
    // The woken wait carries the refusal and its stop-and-report text, as the next wait would.
    assert.equal(result.refused, true); assert.equal(result.reason, R.ROOM_REFUSALS.idle_peer);
    assert.match(result.reason, /Stop waiting and report/);
    assert.equal(result.peer.process, "gone"); assert.equal(result.poll.stopped, true);
    assert.equal("wait_ended" in result, false);
    db().prepare("UPDATE room_members SET read_times_json = '[]'").run();
    assert.equal((await wait(a, 1, 45) as R.RoomRefusalView).reason, result.reason, "the next wait refuses the same way");
    void r;
  } finally { child.kill("SIGKILL"); b.close(); }
});
test("rooms read rates are transactional, backdated bounded timestamps permit later calls", async () => {
  const b = box();
  try {
    const { a, aid } = await pair();
    const results = await Promise.all(Array.from({ length: 6 }, () => read(a, 0)));
    assert.equal(results.filter((r) => !("refused" in r)).length, R.ROOM_READS_PER_SECOND);
    assert.ok(results.slice(4).every((r) => (r as R.RoomRefusalView).reason.startsWith("Refused: room limit reached: ROOM_READS_PER_SECOND")));
    assert.equal(JSON.parse(String(db().prepare("SELECT read_times_json FROM room_members WHERE id = ?").get(aid)!.read_times_json)).length, 4);
    db().prepare("UPDATE room_members SET read_times_json = ? WHERE id = ?").run(JSON.stringify([Date.now() - 1001]), aid);
    success(await read(a, 0));
    assert.equal(JSON.parse(String(db().prepare("SELECT read_times_json FROM room_members WHERE id = ?").get(aid)!.read_times_json)).length, 1);
  } finally { b.close(); }
});

test("rooms sweep: invite and absolute expiry, detached waiting expiry, retention by ended_at and read-only inventory", async () => {
  const b = box();
  try {
    const first = await pair(), second = create(), third = await pair();
    const at = Date.now();
    db().prepare("UPDATE rooms SET expires_at = ? WHERE id = ?").run(at - 5000, first.r.room_id);
    db().prepare("UPDATE room_invites SET expires_at = ? WHERE room_id = ?").run(at - 3000, second.room_id);
    db().prepare("UPDATE room_members SET pid = 2147483647, pid_start = 'dead' WHERE id = ?").run(third.aid);
    const before = JSON.stringify(db().prepare("SELECT * FROM rooms ORDER BY id").all());
    api.roomList(); api.roomPrint(first.r.room_id);
    assert.equal(JSON.stringify(db().prepare("SELECT * FROM rooms ORDER BY id").all()), before, "list/print never sweep");
    const sweep = api.roomSweep({ at, keep_records_days: null });
    assert.deepEqual(new Set(sweep.expired), new Set([first.r.room_id, second.room_id])); assert.deepEqual(sweep.deleted, []);
    const detached = success(api.roomPrint(third.r.room_id)); assert.equal(detached.state, "waiting"); assert.equal(detached.seats[0].seat, "unseated");
    assert.deepEqual(await read(third.a, 0), UNAVAILABLE);
    assert.equal(success(api.roomPrint(first.r.room_id)).ended_at, new Date(at - 5000).toISOString());
    const deleted = api.roomSweep({ at: at + 86400000 - 4000, keep_records_days: 1 });
    assert.deepEqual(deleted.deleted, [first.r.room_id]); assert.equal(success(api.roomPrint(second.room_id)).state, "ended");
    db().prepare("UPDATE rooms SET expires_at = ? WHERE id = ?").run(at + 2 * 86400000, third.r.room_id);
    const detachedSweep = api.roomSweep({ at: at + 600000, keep_records_days: null });
    assert.deepEqual(detachedSweep.expired, [], "consumed invites do not expire a detached seat");
    assert.equal(success(api.roomPrint(third.r.room_id)).state, "waiting");
    noAuthority(first.a, first.b, third.a, third.b);
  } finally { b.close(); }
});

/** Separate SQLite connections/processes exercise the writer lock, without launching agents. */
function processCall(home: string, operation: string, token: string): Promise<Record<string, any>> {
  const entry = new URL("../dist/core/rooms.js", import.meta.url).href, caller = new URL("../dist/core/caller.js", import.meta.url).href;
  const script = `import * as api from ${JSON.stringify(entry)}; import {newInstance} from ${JSON.stringify(caller)};
    const inst = newInstance({kind:'root'},process.cwd(),'codex'); inst.carried=true; inst.token=${JSON.stringify(token)};
    const call=${JSON.stringify(call)}; call.sanitizeText=s=>s; const result=await (${operation}); process.stdout.write(JSON.stringify(result));`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, RELAY_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject); p.on("close", (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
}

test("rooms SQLite competition: cross-process invite winner, last turn, creation cap and row rate", async () => {
  const b = box();
  try {
    const r = create();
    const op = `api.roomJoin(inst,{action:'join',invite:${JSON.stringify(r.invites[0].invite)}},call)`;
    const joined = await Promise.all([processCall(b.home, op, "contender 1"), processCall(b.home, op, "contender 2")]);
    assert.equal(joined.filter((v) => v.joined).length, 1); assert.deepEqual(joined.find((v) => !v.joined), UNAVAILABLE);
    const owner = instance(true); owner.token = joined[0].joined ? "contender 1" : "contender 2";
    const peer = instance(true); success(await join(peer, r.invites[1].invite));
    for (let n = 1; n <= 23; n++) { backdate(r.room_id); success(await send(n % 2 ? owner : peer, n - 1)); }
    backdate(r.room_id);
    const sendOp = (id: string) => `api.roomSend(inst,${JSON.stringify({ ...sendInput(23), request_id: id })},call)`;
    const sent = await Promise.all([processCall(b.home, sendOp(crypto.randomUUID()), peer.token), processCall(b.home, sendOp(crypto.randomUUID()), peer.token)]);
    assert.equal(sent.filter((v) => v.accepted_seq).length, 1); assert.equal(success(api.roomPrint(r.room_id)).turns, 24);
    const creates = await Promise.all(Array.from({ length: 6 }, (_, i) => processCall(b.home, "api.roomCreate()", `unused ${i}`)));
    assert.equal(creates.filter((v) => v.invites).length, 3, "four creations including original");
    const live = creates.find((v) => v.invites)!;
    const x = instance(true), y = instance(true); success(await join(x, live.invites[0].invite)); success(await join(y, live.invites[1].invite));
    // 24 terminal + six alternating sends fill the shared row/minute budget.
    for (let n = 0; n < 24; n++) success(api.roomAddLine(live.room_id, `terminal ${n}`, plain));
    for (let n = 1; n <= 6; n++) { backdate(live.room_id); success(await send(n % 2 ? x : y, 23 + n)); }
    const rates = await Promise.all([processCall(b.home, `api.roomSend(inst,${JSON.stringify(sendInput(30))},call)`, x.token), processCall(b.home, `api.roomSend(inst,${JSON.stringify(sendInput(30))},call)`, x.token)]);
    assert.ok(rates.every((v) => v.reason.includes("ROOM_ROWS_PER_MINUTE")));
    assert.equal(success(api.roomPrint(live.room_id)).messages.length, 30); noAuthority(owner, peer, x, y);
  } finally { b.close(); }
});

test("rooms storage failure rolls back invite consumption and a send's transcript, turn and ending", async () => {
  const b = box(), prepare = DatabaseSync.prototype.prepare;
  try {
    const r = create(), a = instance(), peer = instance();
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (sql.startsWith("INSERT INTO room_bindings")) throw new Error("synthetic full disk");
      return prepare.call(this, sql);
    };
    await assert.rejects(join(a, r.invites[0].invite), /synthetic full disk/);
    DatabaseSync.prototype.prepare = prepare;
    assert.equal(rowCount("room_bindings"), 0);
    assert.equal(db().prepare("SELECT consumed_at FROM room_invites WHERE member_id = ?").get(r.invites[0].member_id)!.consumed_at, null);
    success(await join(a, r.invites[0].invite)); success(await join(peer, r.invites[1].invite));
    const before = success(api.roomPrint(r.room_id));
    const presence = db().prepare("SELECT last_call_at,call_no FROM room_members ORDER BY id").all();
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (sql.startsWith("UPDATE rooms SET turns")) throw new Error("synthetic full disk");
      return prepare.call(this, sql);
    };
    await assert.rejects(send(a, 0), /synthetic full disk/);
    DatabaseSync.prototype.prepare = prepare;
    const after = success(api.roomPrint(r.room_id)); assert.equal(after.turns, before.turns); assert.equal(after.revision, before.revision); assert.deepEqual(after.messages, []);
    assert.deepEqual(db().prepare("SELECT last_call_at,call_no FROM room_members ORDER BY id").all(), presence);
    assert.equal(rowCount("room_exposures"), 0);
  } finally { DatabaseSync.prototype.prepare = prepare; b.close(); }
});

test("rooms re-seat keeps per-seat read and send budgets, issuance rates and pending CRUX", async () => {
  const b = box();
  try {
    const { r, a, b: peer, aid } = await pair();
    const original = sendInput(0, "crux"); success(await api.roomSend(a, original, call));
    for (let n = 0; n < R.ROOM_READS_PER_SECOND; n++) success(await read(a, 1));
    const replacement = instance();
    const invite = success(api.roomReseat(r.room_id, aid, 1)); success(await join(replacement, invite.invite.invite));
    assert.ok((await read(replacement, 1) as R.RoomRefusalView).reason.includes("ROOM_READS_PER_SECOND"));
    const last = success(await send(peer, 1)); assert.equal(last.ending?.reason, "crux");
    const second = await pair();
    success(await send(second.a, 0));
    const changed = success(api.roomReseat(second.r.room_id, second.aid, 1));
    const newOwner = instance(); success(await join(newOwner, changed.invite.invite)); success(await send(second.b, 1));
    assert.ok((await send(newOwner, 2) as R.RoomRefusalView).reason.includes("ROOM_SEND_INTERVAL_MS"));
    backdate(second.r.room_id); success(await send(newOwner, 2));
    for (let generation = 2; generation <= 4; generation++) success(api.roomReseat(second.r.room_id, second.aid, generation));
    assert.ok((api.roomReseat(second.r.room_id, second.aid, 5) as R.RoomRefusal).reason.includes("ROOM_RESEATS_PER_MINUTE"));
    db().prepare("UPDATE room_members SET reseat_times_json = ? WHERE id = ?").run(JSON.stringify([Date.now() - 60001]), second.aid);
    success(api.roomReseat(second.r.room_id, second.aid, 5));
    assert.equal(success(api.roomPrint(second.r.room_id)).turns, 3);
  } finally { b.close(); }
});

test("rooms global live capacity cannot be oversubscribed by SQLite creators", async () => {
  const b = box();
  try {
    const at = Date.now();
    for (let n = 0; n < R.ROOM_LIVE_PER_HOME - 1; n++) db().prepare("INSERT INTO rooms (id,state,created_at,expires_at) VALUES (?,'waiting',?,?)")
      .run(api.newRoomId(), at - 120000, at + R.ROOM_LIFETIME_MS);
    const results = await Promise.all([processCall(b.home, "api.roomCreate()", "creator a"), processCall(b.home, "api.roomCreate()", "creator b")]);
    assert.equal(results.filter((v) => v.invites).length, 1); assert.equal(rowCount("rooms"), R.ROOM_LIVE_PER_HOME);
    assert.equal(results.find((v) => v.refused)!.reason, "Refused: room limit reached: ROOM_LIVE_PER_HOME.");
    noAuthority();
  } finally { b.close(); }
});

test("rooms replaced ended bindings and presence on join calls", async () => {
  const b = box();
  try {
    const { r, a, b: peer, aid, bid } = await pair();
    success(await send(a, 0));
    success(api.roomCloseAtTerminal(r.room_id));
    const next = create(); success(await join(a, next.invites[0].invite));
    assert.deepEqual(await join(a, r.invites[0].invite), UNAVAILABLE);
    assert.equal(success(api.roomPrint(r.room_id)).seats.find((m) => m.member_id === aid)!.seat, "unseated");
    db().prepare("UPDATE room_members SET last_call_at = ? WHERE id = ?").run(Date.now() - 600001, bid);
    assert.deepEqual(await join(peer, "unknown invite"), UNAVAILABLE);
    assert.equal(success(await wait(peer, 1)).state, "ended");
    assert.equal(success(api.roomPrint(r.room_id)).seats[1].seat, "joined");
  } finally { b.close(); }
});

test("rooms exposure is committed under the writer lock even when a caller discards its result", async () => {
  const b = box();
  try {
    const { a, b: peer } = await pair(); success(await send(a, 0));
    const prepare = DatabaseSync.prototype.prepare; let seen = false;
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (sql.startsWith("INSERT OR IGNORE INTO room_exposures")) { assert.equal(db().isTransaction, true); seen = true; }
      return prepare.call(this, sql);
    };
    try { await read(peer, 0); } finally { DatabaseSync.prototype.prepare = prepare; }
    assert.equal(seen, true); assert.equal(roomOwnerExposed(roomOwnerHash(peer.token)), true);
    closeDbForTests(); assert.equal(roomOwnerExposed(roomOwnerHash(peer.token)), true, "durable before any transport");
  } finally { b.close(); }
});

test("rooms access sweeps opportunistically each minute: it expires rooms and never deletes them", async (t) => {
  const b = box();
  try {
    fs.writeFileSync(path.join(b.home, "config.json"), JSON.stringify({ keep_records_days: 1 }));
    const first = await pair(), live = await pair();
    success(await send(first.a, 0)); success(await read(first.b, 0)); success(api.roomCloseAtTerminal(first.r.room_id));
    const base = Date.now();
    db().prepare("UPDATE rooms SET ended_at = ? WHERE id = ?").run(base - 86400000 - 1, first.r.room_id);
    const third = create();
    db().prepare("UPDATE room_invites SET expires_at = ? WHERE room_id = ?").run(base - 1, third.room_id);
    db().exec("PRAGMA secure_delete = OFF");
    t.mock.method(Date, "now", () => base + R.ROOM_SWEEP_INTERVAL_MS + 1);
    success(await read(live.a, 0));
    assert.equal(success(api.roomPrint(first.r.room_id)).state, "ended", "past retention, but only maintenance deletes");
    assert.equal(success(api.roomPrint(third.room_id)).ending?.reason, "expired");
    assert.equal(roomOwnerExposed(roomOwnerHash(first.b.token)), true);
    assert.equal(db().prepare("PRAGMA secure_delete").get()!.secure_delete, 0);
  } finally { t.mock.restoreAll(); b.close(); }
});

test("rooms serialized row/result boundaries reserve room for refusal and ending metadata", async () => {
  const b = box();
  try {
    const { r, a, b: peer } = await pair();
    const input = sendInput(0, "agree", "original");
    success(await api.roomSend(a, input, evidence({ sanitizeText: () => '"'.repeat(6800) })));
    const page = success(await read(peer, 0));
    assert.ok(Buffer.byteLength(JSON.stringify(page.messages[0], null, 2)) > 13800);
    assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) <= R.ROOM_RESULT_BYTES);
    const stale = await send(peer, 0, "agree") as R.RoomRefusalView;
    assert.equal(stale.reason, R.ROOM_REFUSALS.stale);
    assert.ok(Buffer.byteLength(JSON.stringify(stale, null, 2)) <= R.ROOM_RESULT_BYTES);
    const ended = success(await send(peer, 1, "agree")); assert.equal(ended.ending?.reason, "agreement");
    const repeated = success(await api.roomSend(a, input, call));
    assert.equal(repeated.repeated, true); assert.ok(Buffer.byteLength(JSON.stringify(repeated, null, 2)) <= R.ROOM_RESULT_BYTES);
    assert.deepEqual(await api.roomSend(a, { ...input, cursor: 99 }, call), { refused: true, reason: R.ROOM_REFUSALS.arguments });
    assert.equal(success(api.roomPrint(r.room_id)).messages.length, 2);
  } finally { b.close(); }
});


test("rooms wait: next sender refusals leave presence stale and cannot sustain peer waits", async (t) => {
  const b = box();
  try {
    const { r, a, b: peer, aid } = await pair();
    let at = Date.now();
    t.mock.method(Date, "now", () => at);
    // Member-1's process unknown (a shared seat), so its silence can stop the peer's waits.
    db().prepare("UPDATE room_members SET last_call_at = ? WHERE room_id = ?").run(at - R.ROOM_PEER_SILENCE_S * 1000 + 100, r.room_id);
    db().prepare("UPDATE room_members SET owner_kind = 'shared', pid = NULL, pid_start = NULL WHERE id = ?").run(aid);
    const presence = () => db().prepare("SELECT last_call_at,call_no FROM room_members WHERE id = ?").get(aid);
    const before = presence();
    for (let n = 0; n < 2; n++) {
      const refused = await wait(a, 0, 45, evidence({ signal: AbortSignal.timeout(300) })) as R.RoomRefusalView;
      assert.equal(refused.reason, "Refused: it is your turn to send, so waiting cannot bring a reply. Send your message, or close the room.");
      assert.deepEqual(refused.messages, []);
      assert.deepEqual(presence(), before);
      assert.equal(api.roomMaintenanceBusy(), false);
      success(await wait(peer, 0));
      at += 50;
    }
    assert.equal((await wait(a, 0, 45, evidence({ signal: AbortSignal.timeout(300) })) as R.RoomRefusalView).reason, R.ROOM_REFUSALS.wait_turn);
    assert.deepEqual(presence(), before);
    assert.equal((await wait(peer, 0, 45) as R.RoomRefusalView).reason, R.ROOM_REFUSALS.idle_peer);
    // Unread text and endings take precedence over the turn refusal.
    success(api.roomAddLine(r.room_id, "read this first", plain));
    assert.equal(success(await wait(a, 0, 45, evidence({ signal: AbortSignal.timeout(300) }))).messages[0].text, "read this first");
    db().prepare("UPDATE room_members SET read_times_json = '[]' WHERE room_id = ?").run(r.room_id);
    success(api.roomCloseAtTerminal(r.room_id));
    assert.equal(success(await wait(a, 1, 45)).state, "ended");
  } finally { t.mock.restoreAll(); b.close(); }
});

test("rooms read rate: every replay and view refusal is bounded without returning messages", async (t) => {
  const b = box();
  try {
    const { r, a, b: peer } = await pair();
    let at = Date.now();
    t.mock.method(Date, "now", () => at);
    const input = sendInput(0);
    success(await api.roomSend(a, input, call));
    const replay = () => api.roomSend(a, input, call);
    const rejoin = () => join(a, r.invites[0].invite);
    const endedClose = () => api.roomClose(a, { action: "close", cursor: 0 }, call);
    const attempts = [replay, rejoin, endedClose, () => wait(a, 0), () => read(a, 0),
      () => api.roomSend(a, { ...input, text: "changed" }, call), () => send(a, 0)];
    for (let n = 0; n < R.ROOM_READS_PER_SECOND; n++) success(await read(a, 0));
    assert.deepEqual(await endedClose(), { refused: true, reason: `Refused: room limit reached: ROOM_READS_PER_SECOND; retry after ${new Date(at + R.ROOM_READ_WINDOW_MS).toISOString()}.` });
    assert.equal(success(api.roomPrint(r.room_id)).state, "open", "a refused close does not mutate the room");
    // First accepted sends remain outside the read budget.
    db().prepare("UPDATE room_members SET read_times_json = ? WHERE room_id = ? AND ordinal = 2")
      .run(JSON.stringify(Array(R.ROOM_READS_PER_SECOND).fill(at)), r.room_id);
    success(await send(peer, 1));
    success(api.roomCloseAtTerminal(r.room_id));
    for (const attempt of attempts) {
      const result = await attempt();
      assert.deepEqual(result, { refused: true, reason: `Refused: room limit reached: ROOM_READS_PER_SECOND; retry after ${new Date(at + R.ROOM_READ_WINDOW_MS).toISOString()}.` });
      assert.equal("messages" in result, false);
    }
    for (const attempt of attempts) {
      at += R.ROOM_READ_WINDOW_MS + 1;
      const result = await attempt();
      assert.ok("messages" in result, JSON.stringify(result));
      assert.ok(!("reason" in result) || !result.reason.includes("ROOM_READS_PER_SECOND"));
    }
  } finally { t.mock.restoreAll(); b.close(); }
});

test("rooms sender: stored client names use the shared escaping and credential redaction", async () => {
  const b = box();
  try {
    const r = create();
    const names = ["\u0080\u0085\u009f", `client ri1_${"a".repeat(32)}`];
    for (const [n, name] of names.entries()) {
      const c = evidence({ identity: { ...call.identity, harness: name } });
      success(await join(instance(), r.invites[n].invite, c));
      const stored = JSON.parse(String(db().prepare("SELECT joined_sender_json FROM room_members WHERE id = ?").get(r.invites[n].member_id)!.joined_sender_json));
      assert.equal(stored.client, roomClientName(name));
      assert.equal(success(api.roomPrint(r.room_id)).seats[n].client, roomClientName(name));
    }
  } finally { b.close(); }
});

test("rooms wait: polling tolerates another writer lock, wakes on a message and rejects re-seating", async () => {
  const b = box();
  let other: DatabaseSync | undefined;
  let pending: ReturnType<typeof wait> | undefined;
  const controller = new AbortController();
  try {
    const { r, a, b: peer, bid } = await pair();
    pending = wait(peer, 0, 45, evidence({ signal: controller.signal }));
    let settled = false;
    // Handle rejection immediately so the regression reports a normal assertion failure.
    const result = pending.then((value) => { settled = true; return value; }, (error) => { settled = true; return { error }; });
    other = new DatabaseSync(path.join(b.home, "relay.db"));
    other.exec("BEGIN IMMEDIATE");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    other.exec("ROLLBACK"); other.close(); other = undefined;
    assert.equal(settled, false, "polling neither waits for nor fails on the writer lock");
    const at = Date.now();
    success(await send(a, 0));
    const woke = success(await result);
    assert.equal(woke.messages[0]?.seq, 1);
    assert.ok(Date.now() - at < 1000, "message wakes wait promptly");
    success(await send(peer, 1));
    pending = wait(peer, 2, 45, evidence({ signal: controller.signal }));
    success(api.roomReseat(r.room_id, bid, 1));
    assert.deepEqual(await pending, UNAVAILABLE);
  } finally {
    if (other) { other.exec("ROLLBACK"); other.close(); }
    controller.abort(); await pending?.catch(() => {}); b.close();
  }
});
