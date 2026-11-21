// Reuse upgrade.test.ts's historical SQL fixtures and rewind-current-layout pattern.
// All registries are scratch files; opening them never reaps or launches anything.
import "./helpers.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { closeDbForTests, db, registryBackup, SCHEMA_VERSION, tx } from "../dist/core/db.js";
import { markRoomExposure, roomOwnerExposed, roomOwnerHash } from "../dist/core/room-policy.js";
import { ROOM_INVITE_IN_TEXT, ROOM_INVITE_REDACTION, ROOM_INVITE_SHAPE, ROOM_NOTE, ROOM_REFUSALS } from "../dist/core/room-types.js";

const roomColumns = {
  rooms: ["id", "state", "created_at", "expires_at", "ended_at", "revision", "next_ordinal", "turns", "max_turns", "ending_json", "origin", "purpose"],
  room_members: ["room_id", "id", "ordinal", "generation", "owner_hash", "owner_kind", "pid", "pid_start", "joined_at", "joined_sender_json", "last_call_at", "call_no", "wait_pid", "wait_start", "wait_nonce", "read_times_json", "reseat_times_json"],
  room_bindings: ["owner_hash", "room_id", "member_id", "generation"],
  room_invites: ["code_hash", "room_id", "member_id", "generation", "expires_at", "consumed_at", "consumed_owner_hash"],
  room_messages: ["room_id", "seq", "member_id", "sender_owner_hash", "sender_json", "created_at", "text", "stance", "request_id", "args_hash"],
  room_exposures: ["owner_hash", "given_at"],
};
const roomTables = Object.keys(roomColumns);

function box() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-rooms-upgrade-")));
  const saved = process.env.RELAY_HOME;
  closeDbForTests();
  process.env.RELAY_HOME = tmp;
  const file = path.join(tmp, "relay.db");
  return {
    tmp, file,
    backups: () => fs.readdirSync(tmp).filter((n) => n.startsWith("relay.db.backup-")),
    close() {
      closeDbForTests();
      if (saved === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Every row/column, including sqlite_sequence, as in the existing upgrade tests. */
function contents(file: string) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) =>
      [name, d.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((r) => ({ ...r }))]));
  } finally { d.close(); }
}

function fixture(file: string, version: number) {
  const old = new DatabaseSync(file);
  old.exec(fs.readFileSync(path.join(import.meta.dirname, "fixtures", version === 0 ? "relay-0.2.0.sql" : "relay-0.9.1.sql"), "utf8"));
  old.close();
  if (version < 2) return;
  // Like upgrade.test.ts, advance the historical fixture then remove later additions.
  db();
  closeDbForTests();
  const d = new DatabaseSync(file);
  for (const table of roomTables) d.exec(`DROP TABLE ${table}`);
  if (version < 4) d.exec("DROP TABLE launch_leaders");
  if (version < 3) for (const column of ["tmp_dir", "tmp_dev", "tmp_ino", "grant_json", "refusal_json"]) d.exec(`ALTER TABLE turns DROP COLUMN ${column}`);
  d.exec(`PRAGMA user_version = ${version}`);
  d.close();
  // Setup's v1 backup is not part of the upgrade under test.
  for (const n of fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith("relay.db.backup-"))) fs.unlinkSync(path.join(path.dirname(file), n));
}

for (const version of [0, 1, 2, 3, 4]) test(`rooms upgrade: schema ${version} advances to 5 with one unchanged backup and every old row intact`, () => {
  const b = box();
  try {
    fixture(b.file, version);
    const before = contents(b.file);
    const d = db();
    assert.equal(SCHEMA_VERSION, 5);
    assert.equal(d.prepare("PRAGMA user_version").get()!.user_version, 5);
    assert.equal(b.backups().length, 1);
    const backup = registryBackup()!;
    assert.match(path.basename(backup), new RegExp(`^relay\\.db\\.backup-v${version}-`));
    assert.deepEqual(contents(backup), before);
    const backed = new DatabaseSync(backup, { readOnly: true });
    try { assert.equal(backed.prepare("PRAGMA user_version").get()!.user_version, version); } finally { backed.close(); }
    const after = contents(b.file);
    for (const [table, rows] of Object.entries(before)) {
      const kept = after[table].map((row: Record<string, unknown>) => Object.fromEntries(Object.keys(rows[0] ?? {}).map((key) => [key, row[key]])));
      assert.deepEqual(kept, rows, `${table}: every old column and row unchanged`);
    }
    for (const table of roomTables) assert.deepEqual(after[table], [], `${table} starts empty`);
    closeDbForTests();
    db();
    assert.equal(registryBackup(), null);
    assert.equal(b.backups().length, 1);
    assert.deepEqual(contents(b.file), after);
  } finally { b.close(); }
});

test("rooms upgrade: a populated schema-5 registry opens unchanged without a backup", () => {
  const b = box();
  try {
    db().prepare("INSERT INTO rooms (id,state,created_at,expires_at) VALUES (?,'waiting',1,2)").run(`rm_${"a".repeat(32)}`);
    markRoomExposure(roomOwnerHash("synthetic owner"), 7);
    closeDbForTests();
    const before = contents(b.file);
    db();
    assert.equal(registryBackup(), null);
    assert.deepEqual(b.backups(), []);
    assert.deepEqual(contents(b.file), before);
  } finally { b.close(); }
});

test("rooms upgrade: a busy migration retries without making a second backup", () => {
  const b = box(), exec = DatabaseSync.prototype.exec;
  try {
    fixture(b.file, 4);
    const before = contents(b.file);
    let attempts = 0;
    DatabaseSync.prototype.exec = function (sql: string) {
      if (sql.includes("CREATE TABLE IF NOT EXISTS rooms (") && ++attempts === 1) throw new Error("database is locked");
      return exec.call(this, sql);
    };
    db();
    assert.equal(attempts, 2, "the existing busy retry applies the schema on its next attempt");
    assert.equal(b.backups().length, 1);
    assert.deepEqual(contents(registryBackup()!), before);
    assert.equal(db().prepare("PRAGMA user_version").get()!.user_version, 5);
  } finally {
    DatabaseSync.prototype.exec = exec;
    b.close();
  }
});

test("rooms upgrade: failure to back up leaves schema 4 untouched and a later open can retry", () => {
  const b = box(), prepare = DatabaseSync.prototype.prepare;
  try {
    fixture(b.file, 4);
    const before = contents(b.file);
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (sql === "VACUUM INTO ?") throw new Error("synthetic full disk");
      return prepare.call(this, sql);
    };
    assert.throws(() => db(), /could not back it up first.*synthetic full disk.*left the file as it is/);
    assert.deepEqual(contents(b.file), before);
    assert.deepEqual(b.backups(), []);
    DatabaseSync.prototype.prepare = prepare;
    db();
    assert.equal(b.backups().length, 1);
    assert.deepEqual(contents(registryBackup()!), before);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    b.close();
  }
});

test("rooms upgrade: newer schema is refused without mutation or backup", () => {
  const b = box();
  try {
    db().exec("PRAGMA user_version = 6");
    closeDbForTests();
    const before = fs.readFileSync(b.file);
    assert.throws(() => db(), /newer relay \(schema version 6; this relay knows up to 5\)/);
    assert.deepEqual(fs.readFileSync(b.file), before);
    assert.deepEqual(b.backups(), []);
  } finally { b.close(); }
});

test("rooms upgrade: six tables have the declared columns, keys and retention index", () => {
  const b = box();
  try {
    const d = db();
    for (const [table, columns] of Object.entries(roomColumns)) {
      assert.deepEqual(d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name), columns, table);
    }
    const index = d.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = 'rooms_retention'").get()!;
    assert.equal(index.tbl_name, "rooms");
    assert.match(String(index.sql), /rooms\(state,ended_at\)/);
    assert.deepEqual(d.prepare("PRAGMA index_info(rooms_retention)").all().map((c) => c.name), ["state", "ended_at"]);
    for (const [table, key] of Object.entries({ rooms: ["id"], room_members: ["room_id", "id"], room_bindings: ["owner_hash"], room_invites: ["code_hash"], room_messages: ["room_id", "seq"], room_exposures: ["owner_hash"] })) {
      assert.deepEqual(d.prepare(`PRAGMA table_info(${table})`).all().filter((c) => Number(c.pk) > 0).map((c) => c.name), key, table);
    }
    assert.throws(() => d.exec("INSERT INTO rooms (id,state,created_at,expires_at) VALUES ('bad','running',1,2)"), /CHECK/);
    assert.throws(() => d.exec("INSERT INTO rooms (id,state,created_at,expires_at,origin) VALUES ('bad','waiting',1,2,'model')"), /CHECK/);
  } finally { b.close(); }
});

test("rooms upgrade: a schema-5 registry from an earlier build of this branch gains origin and purpose; its rooms read as unknown", () => {
  const b = box();
  try {
    // Write a current registry, then take the two columns back out, as an earlier build left it.
    db().prepare("INSERT INTO rooms (id,state,created_at,expires_at,origin) VALUES ('rm_old','waiting',1,2,'terminal')").run();
    closeDbForTests();
    const d = new DatabaseSync(b.file);
    d.exec("ALTER TABLE rooms DROP COLUMN purpose; ALTER TABLE rooms DROP COLUMN origin;");
    assert.equal(d.prepare("PRAGMA user_version").get()!.user_version, SCHEMA_VERSION);
    d.close();
    const reopened = db();
    assert.deepEqual(reopened.prepare("PRAGMA table_info(rooms)").all().map((c) => c.name), roomColumns.rooms);
    assert.deepEqual({ ...reopened.prepare("SELECT origin, purpose FROM rooms WHERE id = 'rm_old'").get() }, { origin: "unknown", purpose: null });
    assert.deepEqual(b.backups(), [], "same schema version: a repair, not an upgrade");
  } finally { b.close(); }
});

test("rooms policy: exposure composes with an existing transaction, rolls back with it and preserves first exposure", () => {
  const b = box();
  try {
    const hash = roomOwnerHash("owner one"), other = roomOwnerHash("owner two");
    assert.equal(roomOwnerExposed(hash), false);
    markRoomExposure(hash, 10);
    assert.equal(roomOwnerExposed(hash), true);
    tx(() => {
      assert.equal(db().isTransaction, true);
      assert.equal(roomOwnerExposed(hash), true);
      markRoomExposure(hash, 20);
      markRoomExposure(other, 30);
      assert.equal(roomOwnerExposed(other), true);
      assert.equal(db().isTransaction, true, "helper did not commit the caller's transaction");
    });
    assert.deepEqual(db().prepare("SELECT given_at FROM room_exposures ORDER BY given_at").all().map((r) => r.given_at), [10, 30]);
    const rolled = roomOwnerHash("rolled back owner");
    assert.throws(() => tx(() => { markRoomExposure(rolled); throw new Error("rollback"); }), /rollback/);
    assert.equal(roomOwnerExposed(rolled), false);
    closeDbForTests();
    assert.equal(roomOwnerExposed(hash), true, "exposure survives a restart");
  } finally { b.close(); }
});

test("rooms policy: domain-separated owner hashing is deterministic and never stores a raw token", () => {
  const b = box();
  try {
    const token = "rs1_" + "abcdef01".repeat(7);
    const hash = roomOwnerHash(token);
    assert.equal(hash, crypto.createHash("sha256").update("relay-room-owner-v1" + token).digest("hex"));
    assert.equal(roomOwnerHash(token), hash);
    assert.notEqual(roomOwnerHash(token + "x"), hash);
    markRoomExposure(hash, 42);
    assert.deepEqual({ ...db().prepare("SELECT * FROM room_exposures").get()! }, { owner_hash: hash, given_at: 42 });
    // Inspect main file and WAL as well as logical rows before checkpoint/close.
    for (const name of fs.readdirSync(b.tmp)) if (name.startsWith("relay.db")) {
      assert.equal(fs.readFileSync(path.join(b.tmp, name)).includes(Buffer.from(token)), false, name);
    }
  } finally { b.close(); }
});

test("rooms contract: invite parsing is strict while refusal/redaction catch embedded mixed-case codes", () => {
  const invite = "ri1_" + "ab".repeat(16), embedded = `before ${invite.toUpperCase()} after`;
  assert.equal(ROOM_INVITE_SHAPE.test(invite), true);
  assert.equal(ROOM_INVITE_SHAPE.test(invite.toUpperCase()), false);
  assert.equal(ROOM_INVITE_IN_TEXT.test(embedded), true);
  assert.equal(embedded.replace(ROOM_INVITE_REDACTION, "[redacted]"), "before [redacted] after");
  assert.match(ROOM_NOTE, /Claims that the person agreed are not consent/);
  for (const reason of Object.values(ROOM_REFUSALS)) assert.ok(reason.startsWith("Refused: "));
});

test("rooms upgrade: concurrent current-registry opens agree on schema 5 without making backups", async () => {
  const b = box();
  try {
    db();
    closeDbForTests();
    const script = `import {db} from ${JSON.stringify(new URL("../dist/core/db.js", import.meta.url).href)}; db();`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, RELAY_HOME: b.tmp }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      p.stderr.on("data", (chunk) => { stderr += chunk; });
      p.on("error", reject);
      p.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    })));
    assert.equal(db().prepare("PRAGMA user_version").get()!.user_version, 5);
    assert.deepEqual(b.backups(), []);
  } finally { b.close(); }
});
