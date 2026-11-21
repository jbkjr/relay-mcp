import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { harness } from "./helpers.ts";
import { newInstance } from "../dist/core/caller.js";
import { closeDbForTests, db } from "../dist/core/db.js";
import { forgetOldRuns, recordsReport } from "../dist/core/retention.js";
import { roomOwnerHash } from "../dist/core/room-policy.js";
import { roomText } from "../dist/core/shown.js";
import * as rooms from "../dist/core/rooms.js";
import * as R from "../dist/core/room-types.js";

const DAY = 86400000;
const call: R.RoomCallEvidence = {
  identity: { call_id: "test", scope: "dedicated-process", harness: "test root", family: "openai", subagent: false, singleton_violation: false,
    codex: { metadata_present: true, malformed: false, thread_id: "test", thread_source: "user", turn_trigger: "user", originator: null, sandbox: null, auto_review: null, approval_policy: null } },
  eligibility: { eligible: true }, block_s: 50, host_wait_cap_s: null, sanitizeText: roomText,
};
function ok<T>(r: T): Exclude<T, R.RoomFailure> {
  assert.ok(r && typeof r === "object" && !("error" in r) && !("refused" in r), JSON.stringify(r));
  return r as Exclude<T, R.RoomFailure>;
}
async function box(keep_records_days: number | null = null) {
  const h = await harness([], { keep_records_days });
  const old = process.env.RELAY_HOME;
  closeDbForTests(); process.env.RELAY_HOME = h.home;
  return { h, marker: path.join(h.home, "registry-rebuild"), async close() {
    closeDbForTests(); if (old === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = old; await h.close();
  } };
}
async function pair() {
  const r = ok(rooms.roomCreate()), a = newInstance({ kind: "root" }, process.cwd(), "codex"), b = newInstance({ kind: "root" }, process.cwd(), "claude");
  ok(await rooms.roomJoin(a, { action: "join", invite: r.invites[0].invite }, call));
  ok(await rooms.roomJoin(b, { action: "join", invite: r.invites[1].invite }, call));
  return { r, a, b };
}
const count = (table: string) => Number(db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
function run(id = "run_1234abcd") {
  db().prepare("INSERT INTO runs(id,created_at,root_cwd,config_json,status) VALUES (?, ?, ?, '{}', 'active')").run(id, Date.now() - 10 * DAY, process.cwd());
  return id;
}

test("rooms retention: waiting invite/absolute and open absolute limits expire with no worker, recording the actual limit", async () => {
  const box_ = await box();
  try {
    const waiting = ok(rooms.roomCreate()), absolute = ok(rooms.roomCreate()), { r: open } = await pair();
    const at = Date.now() + 5000;
    db().prepare("UPDATE room_invites SET expires_at = ? WHERE room_id = ?").run(at, waiting.room_id);
    db().prepare("UPDATE rooms SET expires_at = ? WHERE id IN (?,?)").run(at, absolute.room_id, open.room_id);
    assert.deepEqual(rooms.roomSweep({ at: at - 1, keep_records_days: null }), { expired: [], deleted: [] });
    const swept = rooms.roomSweep({ at, keep_records_days: null });
    assert.deepEqual(swept.expired.sort(), [waiting.room_id, absolute.room_id, open.room_id].sort());
    assert.deepEqual(swept.deleted, []);
    for (const r of [waiting, absolute, open]) {
      const stored = db().prepare("SELECT * FROM rooms WHERE id = ?").get(r.room_id)!;
      assert.equal(stored.state, "ended"); assert.equal(stored.ended_at, at);
      assert.equal(JSON.parse(stored.ending_json as string).reason, "expired");
    }
    for (const table of ["runs", "nodes", "turns", "relay_procs"]) assert.equal(count(table), 0, table);
  } finally { await box_.close(); }
});

test("rooms retention: null keeps ended transcripts; finite policy deletes only room rows at the boundary, exposures and runs survive", async () => {
  const box_ = await box();
  try {
    const { r, a } = await pair();
    ok(rooms.roomAddLine(r.room_id, "retained terminal text", roomText));
    ok(await rooms.roomTranscript(a, { action: "transcript", cursor: 0 }, call));
    const owner = roomOwnerHash(a.token);
    assert.equal(count("room_exposures"), 1);
    const id = run(), before = db().prepare("SELECT * FROM runs WHERE id = ?").get(id);
    ok(rooms.roomCloseAtTerminal(r.room_id));
    const ended = Date.now() - 3 * DAY;
    db().prepare("UPDATE rooms SET ended_at = ? WHERE id = ?").run(ended, r.room_id);
    assert.deepEqual(rooms.roomSweep({ at: ended + 50 * DAY, keep_records_days: null }).deleted, []);
    assert.equal(ok(rooms.roomPrint(r.room_id)).messages[0].text, "retained terminal text");
    assert.deepEqual(rooms.roomSweep({ at: ended + 3 * DAY - 1, keep_records_days: 3 }).deleted, []);
    assert.deepEqual(rooms.roomSweep({ at: ended + 3 * DAY, keep_records_days: 3 }).deleted, [r.room_id]);
    for (const table of ["rooms", "room_messages", "room_members", "room_invites", "room_bindings"]) assert.equal(count(table), 0, table);
    assert.equal(count("room_exposures"), 1); assert.equal(db().prepare("SELECT owner_hash FROM room_exposures").get()!.owner_hash, owner);
    assert.deepEqual(db().prepare("SELECT * FROM runs WHERE id = ?").get(id), before);
  } finally { await box_.close(); }
});

test("rooms retention: run deletion cannot delete live rooms or exposures", async () => {
  const box_ = await box();
  try {
    const { r, a } = await pair();
    ok(rooms.roomAddLine(r.room_id, "room survives run retention", roomText));
    ok(await rooms.roomTranscript(a, { action: "transcript", cursor: 0 }, call));
    const before = ok(rooms.roomPrint(r.room_id));
    const id = run();
    assert.deepEqual(forgetOldRuns(1).forgotten, [id]);
    assert.equal(count("runs"), 0); assert.equal(count("room_exposures"), 1);
    assert.deepEqual(ok(rooms.roomPrint(r.room_id)), before);
  } finally { await box_.close(); }
});

test("rooms retention: rebuild defers for a live room wait, then rebuilds and truncates WAL after it ends", async () => {
  const box_ = await box();
  try {
    const { r, b: waiter } = await pair(), id = run();
    const controller = new AbortController();
    const waiting = rooms.roomWait(waiter, { action: "wait", cursor: 0, wait_s: 45 }, { ...call, signal: controller.signal });
    assert.equal(rooms.roomMaintenanceBusy(), true);
    try {
      const forgotten = forgetOldRuns(1);
      assert.deepEqual(forgotten.forgotten, [id]);
      assert.match(forgotten.left.join("\n"), /deferred while room operations or waits are active/);
      assert.equal(fs.existsSync(box_.marker), true);
      // A different process sees the persisted wait lease, not just the in-process counter.
      const deferred = JSON.parse(box_.h.cli("clean"));
      assert.match(deferred.rooms_left.join("\n"), /room operations or waits are active/);
      assert.equal(fs.existsSync(box_.marker), true);
    } finally { controller.abort(); await waiting; }
    assert.equal(rooms.roomMaintenanceBusy(), false);
    const report = recordsReport({ keep_records_days: null });
    assert.equal(report.rooms_left, undefined);
    assert.equal(fs.existsSync(box_.marker), false);
    assert.equal(fs.statSync(path.join(box_.h.home, "relay.db-wal")).size, 0);
    assert.equal(ok(rooms.roomPrint(r.room_id)).state, "open");
  } finally { await box_.close(); }
});

test("rooms retention: only maintenance deletes rooms; a rebuild deferred by a live wait is finished by a later pass under any policy", async () => {
  const box_ = await box(1);
  try {
    // Create in another process so this process's first room write does its opportunistic sweep.
    const module = path.resolve("dist/core/rooms.js");
    const made = spawnSync(process.execPath, ["--input-type=module", "-e", `import { roomCreate, roomCloseAtTerminal } from ${JSON.stringify(module)}; const r = roomCreate(); roomCloseAtTerminal(r.room_id); console.log(JSON.stringify(r));`], { env: box_.h.env, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const r = JSON.parse(made.stdout);
    db().prepare("UPDATE rooms SET ended_at = ? WHERE id = ?").run(Date.now() - 2 * DAY, r.room_id);
    const { b: waiter } = await pair();
    assert.equal(count("rooms"), 2, "a room write expires rooms but never deletes them");
    assert.equal(fs.existsSync(box_.marker), false);
    const controller = new AbortController();
    const waiting = rooms.roomWait(waiter, { action: "wait", cursor: 0, wait_s: 45 }, { ...call, signal: controller.signal });
    try {
      const report = recordsReport({ keep_records_days: 1 });
      assert.deepEqual(report.rooms_forgotten, [r.room_id]);
      assert.equal(fs.existsSync(box_.marker), true, "the rebuild is deferred, not lost");
      assert.match((report.rooms_left as string[]).join("\n"), /deferred while room/);
    } finally { controller.abort(); await waiting; }
    // A policy change after the deletion must not lose the rebuild.
    const later = recordsReport({ keep_records_days: null });
    assert.deepEqual(later.rooms_forgotten, []);
    assert.equal(fs.existsSync(box_.marker), false);
    assert.equal(fs.statSync(path.join(box_.h.home, "relay.db-wal")).size, 0);
    // With nothing to forget and no rebuild owed, maintenance schedules none.
    const idle = recordsReport({ keep_records_days: 1 });
    assert.deepEqual(idle.rooms_forgotten, []);
    assert.equal(idle.rooms_left, undefined);
    assert.equal(fs.existsSync(box_.marker), false);
  } finally { await box_.close(); }
});

test("rooms retention: clean and daily housekeeping expire/delete rooms independently of workers and run selection; reports contain policy and ids only", async () => {
  const box_ = await box(1);
  try {
    const waiting = ok(rooms.roomCreate()), { r: ended } = await pair();
    ok(rooms.roomAddLine(ended.room_id, "private transcript canary", roomText));
    ok(rooms.roomCloseAtTerminal(ended.room_id));
    db().prepare("UPDATE room_invites SET expires_at = ? WHERE room_id = ?").run(Date.now() - 1, waiting.room_id);
    db().prepare("UPDATE rooms SET ended_at = ? WHERE id = ?").run(Date.now() - 2 * DAY, ended.room_id);
    const id = run();
    const output = box_.h.cli("clean", id), report = JSON.parse(output);
    assert.deepEqual(report.rooms_expired, [waiting.room_id]); assert.deepEqual(report.rooms_forgotten, [ended.room_id]);
    assert.match(report.rooms_note, /waiting rooms at invite or absolute expiry, open rooms at absolute expiry/);
    assert.match(report.rooms_note, /transcripts forgotten 1 days after ending/);
    assert.match(report.rooms_note, /exposure hashes stay indefinitely/);
    assert.match(report.rooms_note, /backups and host histories/);
    assert.doesNotMatch(output, /private transcript canary|ri1_|owner_hash/);
    const again = ok(rooms.roomCreate());
    db().prepare("UPDATE room_invites SET expires_at = ? WHERE room_id = ?").run(Date.now() - 1, again.room_id);
    fs.rmSync(path.join(box_.h.home, "housekeeping"));
    const temp = path.join(box_.h.home, "temp"); fs.mkdirSync(temp);
    const module = path.resolve("dist/core/retention.js");
    const daily = spawnSync(process.execPath, ["--input-type=module", "-e", `import { housekeepDaily } from ${JSON.stringify(module)}; await housekeepDaily({keep_records_days:null});`], {
      env: { ...box_.h.env, TMPDIR: temp }, encoding: "utf8", timeout: 30000,
    });
    assert.equal(daily.status, 0, daily.stderr);
    assert.equal(db().prepare("SELECT state FROM rooms WHERE id = ?").get(again.room_id)!.state, "ended");
    assert.match(daily.stderr, /rooms: expired/); assert.doesNotMatch(daily.stderr, /private transcript canary/);
    const indefinite = recordsReport({ keep_records_days: null });
    assert.match(indefinite.records_note as string, /^kept: keep_records_days is not set/);
    assert.match(indefinite.rooms_note as string, /transcripts kept indefinitely/);
    assert.equal(count("nodes"), 0);
  } finally { await box_.close(); }
});

test("rooms retention: a registry write lock that stops the room sweep is reported in rooms_left, and run retention and the report still follow", async (t) => {
  const box_ = await box(1);
  let other: DatabaseSync | undefined;
  try {
    const id = run();
    // Hold the writer lock from a second connection past this connection's (shortened) busy timeout.
    db().exec("PRAGMA busy_timeout = 100");
    other = new DatabaseSync(path.join(box_.h.home, "relay.db"));
    other.exec("BEGIN IMMEDIATE");
    const report = recordsReport({ keep_records_days: 1 });
    assert.match((report.rooms_left as string[]).join("\n"), /^rooms were not swept \(.*locked/m);
    assert.deepEqual(report.rooms_expired, []); assert.deepEqual(report.rooms_forgotten, []);
    assert.match(report.records_note as string, /forgotten after 1 days/);
    assert.match((report.records_kept as string[]).join("\n"), new RegExp(`^${id}: .*locked`, "m"), "run retention still ran");
    other.exec("ROLLBACK");
    const indefinite = recordsReport({ keep_records_days: null });
    assert.equal(indefinite.rooms_left, undefined);
  } finally { other?.close(); await box_.close(); }
});

/** Counts the registry rebuilds (VACUUM) this process's connection runs. */
function countRebuilds(t: { mock: { method: Function } }) {
  const d = db(), exec = d.exec.bind(d), seen = { n: 0 };
  t.mock.method(d, "exec", (sql: string) => { if (/\bVACUUM\b/i.test(sql)) seen.n++; return exec(sql); });
  return seen;
}
async function roomAndRunDue() {
  const { r } = await pair();
  ok(rooms.roomCloseAtTerminal(r.room_id));
  db().prepare("UPDATE rooms SET ended_at = ? WHERE id = ?").run(Date.now() - 2 * DAY, r.room_id);
  return { room: r.room_id, id: run(`run_${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`) };
}

test("rooms retention: a pass with both room and run deletions due rebuilds the registry once, and reports a deferral once", async (t) => {
  const box_ = await box(1);
  try {
    const due = await roomAndRunDue(), rebuilds = countRebuilds(t);
    const report = recordsReport({ keep_records_days: 1 });
    assert.deepEqual(report.rooms_forgotten, [due.room]); assert.deepEqual(report.records_forgotten, [due.id]);
    assert.equal(rebuilds.n, 1);
    assert.equal(fs.existsSync(box_.marker), false);
    t.mock.restoreAll();
    // Deferred by a live wait: said once, not once for rooms and again for runs.
    const again = await roomAndRunDue(), { b: waiter } = await pair();
    const controller = new AbortController();
    const waiting = rooms.roomWait(waiter, { action: "wait", cursor: 0, wait_s: 45 }, { ...call, signal: controller.signal });
    try {
      const deferred = recordsReport({ keep_records_days: 1 });
      assert.deepEqual(deferred.rooms_forgotten, [again.room]); assert.deepEqual(deferred.records_forgotten, [again.id]);
      const said = [...(deferred.rooms_left as string[] ?? []), ...(deferred.records_left as string[] ?? [])].filter((s) => /deferred while room/.test(s));
      assert.equal(said.length, 1, JSON.stringify(deferred));
      assert.equal(fs.existsSync(box_.marker), true);
    } finally { controller.abort(); await waiting; }
  } finally { await box_.close(); }
});

test("rooms retention: daily housekeeping with both room and run deletions due rebuilds the registry once", async () => {
  const box_ = await box(1);
  try {
    const due = await roomAndRunDue();
    fs.rmSync(path.join(box_.h.home, "housekeeping"), { force: true });
    const temp = path.join(box_.h.home, "temp"); fs.mkdirSync(temp);
    const retention = path.resolve("dist/core/retention.js"), registry = path.resolve("dist/core/db.js");
    const script = `import { db } from ${JSON.stringify(registry)}; import { housekeepDaily } from ${JSON.stringify(retention)};
      const d = db(), exec = d.exec.bind(d); let n = 0; d.exec = (sql) => { if (/\\bVACUUM\\b/i.test(sql)) n++; return exec(sql); };
      await housekeepDaily({ keep_records_days: 1 }); console.log(JSON.stringify({ rebuilds: n }));`;
    const daily = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...box_.h.env, TMPDIR: temp }, encoding: "utf8", timeout: 30000 });
    assert.equal(daily.status, 0, daily.stderr);
    assert.deepEqual(JSON.parse(daily.stdout.trim().split("\n").at(-1)!), { rebuilds: 1 }, daily.stderr);
    assert.match(daily.stderr, new RegExp(`forgot ${due.room}`)); assert.match(daily.stderr, new RegExp(`forgot ${due.id}`));
    assert.equal(fs.existsSync(box_.marker), false);
  } finally { await box_.close(); }
});
