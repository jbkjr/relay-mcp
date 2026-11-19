// Upgrading from relay 0.2.0 and from 0.9.1: this version opens the registry an earlier relay left
// behind, keeps what is in it readable (finished items, and an active run's queued work and pending
// request), and backs the file up before it changes its schema, so that going back means restoring
// that backup. Everything runs against a scratch HOME and RELAY_HOME; each registry is built from a
// fixture that the earlier version's own code wrote (test/fixtures/relay-0.2.0.sql, relay-0.9.1.sql).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CLI, hostVar } from "./helpers.ts";
import { copyBuild, describeBuild } from "../dist/core/build-identity.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "relay-0.2.0.sql");
const DIST = path.join(ROOT, "dist");

interface Box { tmp: string; home: string; state: string; dbFile: string; env: Record<string, string>; close(): void }

function box(): Box {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-upgrade-")));
  const home = path.join(tmp, "home");
  const state = path.join(tmp, "state");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  assert.notEqual(home, os.homedir());
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !hostVar(k) && !/^(RELAY_|CODEX_|CLAUDE|XDG_)/.test(k)) env[k] = v;
  Object.assign(env, { HOME: home, RELAY_HOME: state, PATH: "/usr/bin:/bin" });
  return { tmp, home, state, dbFile: path.join(state, "relay.db"), env, close: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** A registry exactly as 0.2.0 left it. */
function oldRegistry(file: string): void {
  const d = new DatabaseSync(file);
  d.exec(fs.readFileSync(FIXTURE, "utf8"));
  d.exec("PRAGMA journal_mode = WAL;");
  d.close();
}

/** Runs a module script with this version's code against the box's registry, and returns what it printed as JSON. */
function withNext(b: Box, body: string): { status: number | null; out: any; stderr: string } {
  const script = `
    import * as dbm from ${JSON.stringify(path.join(DIST, "core", "db.js"))};
    import * as approvals from ${JSON.stringify(path.join(DIST, "core", "approvals.js"))};
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: b.env, encoding: "utf8" });
  let out: any = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // Left null; the caller's assertion reports stderr.
  }
  return { status: r.status, out, stderr: r.stderr };
}

const backups = (b: Box) => fs.readdirSync(b.state).filter((f) => f.startsWith("relay.db.backup-")).sort();
const userVersion = (file: string) => {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    d.close();
  }
};
const tables = (file: string) => {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  } finally {
    d.close();
  }
};

function boxed(name: string, body: (b: Box) => void): void {
  test(name, () => {
    const b = box();
    try {
      body(b);
    } finally {
      b.close();
    }
  });
}

boxed("upgrade: a 0.2.0 registry opens, and its runs, items, turns and approval requests stay readable", (b) => {
  oldRegistry(b.dbFile);
  const r = withNext(b, `
    const run = dbm.latestRun();
    const cfg = dbm.runConfig(run.id);
    return {
      run: run.id, status: run.status,
      nodes: dbm.runNodes(run.id).map((n) => ({ id: n.id, kind: n.kind, target: n.target, status: n.status, session: n.session_id, head: n.head_sha })),
      turns: dbm.nodeTurns("j_0200aaaa").map((t) => ({ status: t.status, reply: t.reply, activity: t.activity, usage: t.usage_json })),
      queued: dbm.nextQueuedTurn("j_0200cccc")?.body ?? null,
      pending: approvals.pendingRequests(run.id).map((q) => q.id),
      decided: approvals.getRequest("q_0200dddd")?.scope ?? null,
      model: cfg.targets.codex.default_model ?? null, codexBin: cfg.targets.codex.bin, jobTimeout: cfg.job_timeout_s,
      events: dbm.db().prepare("SELECT count(*) AS n FROM events").get().n,
    };
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.nodes, [
    { id: "j_0200aaaa", kind: "job", target: "codex", status: "done", session: "019a-codex-thread", head: "fedcba9876543210fedcba9876543210fedcba98" },
    { id: "j_0200cccc", kind: "job", target: "codex", status: "queued", session: null, head: null },
    { id: "t_0200bbbb", kind: "thread", target: "codex", status: "done", session: "019a-codex-thread-2", head: null },
  ]);
  assert.equal(r.out.run, "run_475ecd79");
  assert.equal(r.out.status, "active");
  // Columns added since 0.2.0 read as empty on its rows.
  assert.deepEqual(r.out.turns, [{ status: "done", reply: "Fixed it.", activity: null, usage: null }]);
  assert.equal(r.out.queued, "Still queued");
  assert.deepEqual(r.out.pending, ["q_0200eeee"]);
  assert.equal(r.out.decided, "job");
  // The run keeps the configuration it was started with, in 0.2.0's form, read through the legacy keys.
  assert.equal(r.out.model, "gpt-6.1-sol");
  assert.equal(r.out.codexBin, "codex");
  assert.equal(r.out.jobTimeout, 1800);
  assert.equal(r.out.events, 0);

  // And the command line shows the run.
  const tree = spawnSync(process.execPath, [CLI, "tree"], { env: b.env, encoding: "utf8" });
  assert.equal(tree.status, 0, tree.stderr);
  for (const id of ["j_0200aaaa", "t_0200bbbb", "j_0200cccc"]) assert.match(tree.stdout, new RegExp(id));
});

boxed("upgrade: opening an older registry backs it up first, unchanged, and marks the migrated file with its schema version", (b) => {
  oldRegistry(b.dbFile);
  const before = tables(b.dbFile);
  assert.equal(userVersion(b.dbFile), 0);
  const r = withNext(b, "return { version: dbm.SCHEMA_VERSION, backup: dbm.db() && dbm.registryBackup() };");
  assert.equal(r.status, 0, r.stderr);
  const made = backups(b);
  assert.equal(made.length, 1, `one backup: ${made.join(", ")}`);
  assert.match(made[0], /^relay\.db\.backup-v0-/);
  assert.equal(r.out.backup, path.join(b.state, made[0]));
  const backup = path.join(b.state, made[0]);
  // The backup is the registry as 0.2.0 left it: same tables, same rows, schema version 0.
  assert.deepEqual(tables(backup), before);
  assert.equal(userVersion(backup), 0);
  const d = new DatabaseSync(backup, { readOnly: true });
  assert.equal((d.prepare("SELECT count(*) AS n FROM nodes").get() as { n: number }).n, 3);
  d.close();
  // The live file is migrated and says so.
  assert.equal(userVersion(b.dbFile), r.out.version);
  assert.ok(r.out.version >= 1);
  assert.ok(tables(b.dbFile).includes("events"));

  // Opened again, it is current: no second backup.
  const again = withNext(b, "return { backup: dbm.db() && dbm.registryBackup() };");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.out.backup, null);
  assert.equal(backups(b).length, 1);
});

boxed("upgrade: a new registry is made at the current schema version, with no backup", (b) => {
  const r = withNext(b, "dbm.db(); return { version: dbm.SCHEMA_VERSION, backup: dbm.registryBackup() };");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.backup, null);
  assert.deepEqual(backups(b), []);
  assert.equal(userVersion(b.dbFile), r.out.version);
});

boxed("upgrade: schema 2 is backed up before adding private turn temp identities, with legacy turns left unmapped", (b) => {
  oldRegistry(b.dbFile);
  assert.equal(withNext(b, "dbm.db(); return {};").status, 0);
  const previous = new DatabaseSync(b.dbFile);
  for (const column of ["tmp_dir", "tmp_dev", "tmp_ino", "grant_json", "refusal_json"]) previous.exec(`ALTER TABLE turns DROP COLUMN ${column}`);
  previous.exec("PRAGMA user_version = 2");
  previous.close();
  const migrated = withNext(b, 'return { turn: dbm.nodeTurns("j_0200aaaa")[0], backup: dbm.registryBackup() };');
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(userVersion(b.dbFile), 4);
  assert.deepEqual([migrated.out.turn.tmp_dir, migrated.out.turn.tmp_dev, migrated.out.turn.tmp_ino], [null, null, null]);
  assert.equal(migrated.out.turn.grant_json, null);
  assert.equal(migrated.out.turn.refusal_json, null);
  assert.match(migrated.out.backup, /relay\.db\.backup-v2-/);
  const backup = new DatabaseSync(migrated.out.backup, { readOnly: true });
  try {
    assert.equal((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    assert.ok(!(backup.prepare("PRAGMA table_info(turns)").all() as { name: string }[]).some((c) => c.name === "tmp_dir"));
  } finally { backup.close(); }
});

boxed("upgrade: a real schema-3 registry gains launch_leaders, backed up first, with every row unchanged (X5)", (b) => {
  // Build a genuine schema-3 layout: migrate a 0.2.0 fixture to the current schema with this build,
  // then drop the one table schema 4 adds and mark the file v3. Schema 4 adds only launch_leaders,
  // so what remains is exactly what a released schema-3 relay wrote, with real migrated rows.
  oldRegistry(b.dbFile);
  assert.equal(withNext(b, "dbm.db(); return {};").status, 0);
  const rewind = new DatabaseSync(b.dbFile);
  rewind.exec("DROP TABLE launch_leaders");
  rewind.exec("PRAGMA user_version = 3");
  rewind.close();
  const before = contents(b.dbFile);
  assert.equal(userVersion(b.dbFile), 3);
  assert.ok(!("launch_leaders" in before), "the schema-3 layout has no launch_leaders table");

  const migrated = withNext(b, "return { version: dbm.SCHEMA_VERSION, backup: dbm.db() && dbm.registryBackup() };");
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(migrated.out.version, 4);
  assert.equal(userVersion(b.dbFile), 4, "one open advances schema 3 to 4");

  // The v3 file is backed up unchanged before migration (the earlier open left a v0 backup too).
  const v3 = backups(b).filter((f) => f.startsWith("relay.db.backup-v3-"));
  assert.equal(v3.length, 1, `one schema-3 backup: ${backups(b).join(", ")}`);
  assert.equal(migrated.out.backup, path.join(b.state, v3[0]));
  assert.equal(userVersion(path.join(b.state, v3[0])), 3);
  assert.deepEqual(contents(path.join(b.state, v3[0])), before, "the backup is the schema-3 registry, unchanged");

  // launch_leaders is added and empty; no other table or row changed.
  const after = contents(b.dbFile);
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), "launch_leaders"].sort(), "exactly one table added");
  assert.deepEqual(after.launch_leaders, [], "the new table is empty: leaders are recorded only as relay launches");
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(after[table], rows, `${table}: every row unchanged`);

  // Opened again it is current: no further backup, nothing changes.
  const again = withNext(b, "return { backup: dbm.db() && dbm.registryBackup() };");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.out.backup, null);
  assert.equal(backups(b).filter((f) => f.startsWith("relay.db.backup-v3-")).length, 1);
});

boxed("upgrade: a pre-release schema-4 launch_leaders keyed without start is rebuilt in place, every row kept (C2)", (b) => {
  // An unreleased build of this branch wrote launch_leaders keyed on (run_id, leader_pid), with a
  // nullable start. Opening it with this build rebuilds the table under the current key.
  oldRegistry(b.dbFile);
  assert.equal(withNext(b, "dbm.db(); return {};").status, 0);
  const d = new DatabaseSync(b.dbFile);
  d.exec("DROP TABLE launch_leaders");
  d.exec("CREATE TABLE launch_leaders (\n  run_id TEXT NOT NULL, leader_pid INTEGER NOT NULL, kind TEXT NOT NULL, node_id TEXT,\n  start TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (run_id, leader_pid)\n)");
  d.prepare("INSERT INTO launch_leaders VALUES ('run_x', 3000, 'agent', 'j_1', 'Mon Oct 27 10:00:00 2026', 5)").run();
  d.prepare("INSERT INTO launch_leaders VALUES ('run_x', 4000, 'worker', 'j_2', NULL, 6)").run();
  d.close();
  const backupsBefore = backups(b).length;

  const r = withNext(b, `
    dbm.db();
    return {
      key: dbm.db().prepare("PRAGMA table_info(launch_leaders)").all().filter((c) => c.pk > 0).map((c) => c.name),
      rows: dbm.db().prepare("SELECT run_id, leader_pid, kind, node_id, start, created_at FROM launch_leaders ORDER BY leader_pid").all().map((row) => ({ ...row })),
      leaders: dbm.launchLeaders(),
    };
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.key, ["run_id", "leader_pid", "start"], "start is part of the key now");
  assert.deepEqual(r.out.rows, [
    { run_id: "run_x", leader_pid: 3000, kind: "agent", node_id: "j_1", start: "Mon Oct 27 10:00:00 2026", created_at: 5 },
    { run_id: "run_x", leader_pid: 4000, kind: "worker", node_id: "j_2", start: "", created_at: 6 },
  ], "every row carried over; an unknown start becomes ''");
  assert.equal(r.out.leaders.find((l) => l.leader_pid === 4000).start, null, "'' reads back as an unknown start");
  assert.equal(userVersion(b.dbFile), 4, "still schema 4");
  assert.equal(backups(b).length, backupsBefore, "same schema version: no new backup");
  assert.ok(!tables(b.dbFile).includes("launch_leaders_rekey"), "no scratch table left behind");
});

boxed("upgrade: a registry written by a newer relay is refused and left as it is", (b) => {
  oldRegistry(b.dbFile);
  const d = new DatabaseSync(b.dbFile);
  d.exec("PRAGMA user_version = 999;");
  d.close();
  const before = tables(b.dbFile);
  const r = withNext(b, "dbm.db(); return {};");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /newer relay/);
  assert.match(r.stderr, /backup/);
  assert.deepEqual(tables(b.dbFile), before, "no table was added");
  assert.equal(userVersion(b.dbFile), 999);
  assert.deepEqual(backups(b), []);
});

// Upgrading from relay 0.9.1 (schema version 1) to this version (plan-1.0, 1.0 gate 4: "migration
// tested from 0.9"). The fixture was written by 0.9.1's own code, driven through its MCP server,
// workers and stub agents (test/fixtures/relay-0.9.1.gen.mjs): two runs, one finished, the other
// active, with a job waiting on a pending request and a turn queued behind it. The ids below are
// the fixture's; regenerating it means updating them.

const FIXTURE_091 = path.join(ROOT, "test", "fixtures", "relay-0.9.1.sql");
const RUN_091 = "run_426b36e2";
const ACTIVE_RUN_091 = "run_e6d0a226";

/** A registry exactly as 0.9.1 left it, at schema version 1. */
function registry091(file: string): void {
  const d = new DatabaseSync(file);
  d.exec(fs.readFileSync(FIXTURE_091, "utf8"));
  d.exec("PRAGMA journal_mode = WAL;");
  d.close();
}

type Rows = Record<string, Record<string, unknown>[]>;
/** Every row of every table, by table, in rowid order. */
const contents = (file: string): Rows => {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const names = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    return Object.fromEntries(names.map((n) => [n, (d.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all() as Record<string, unknown>[]).map((r) => ({ ...r }))]));
  } finally {
    d.close();
  }
};

// 0.9.1 recorded real process ids: each run's root session, the running job's worker and agent
// group, relay's own processes, a slot's holder, a dialog's asker. This version acts on them: the
// `relay tree` below reaps the active run, finds its job's worker gone, and kills the agent's group
// if that group still has members. On the machine running the tests those numbers could be anyone's,
// so the fixture holds none: the generator moves every recorded id above any pid range (macOS's
// 99999, Linux's PID_MAX_LIMIT of 2^22), where reap finds nothing and signals nothing.
boxed("upgrade from 0.9.1: no process id the fixture records can name a process on the machine running the tests", (b) => {
  registry091(b.dbFile);
  const ids = Object.entries(contents(b.dbFile)).flatMap(([table, rows]) => rows.flatMap((row) =>
    Object.entries(row).filter(([col, v]) => /(^|_)pg?id$/.test(col) && v !== null).map(([col, v]) => [`${table}.${col}`, v] as const)));
  assert.deepEqual([...new Set(ids.map(([where]) => where))].sort(), [
    "elicitations.pid", "nodes.agent_pgid", "nodes.agent_pid", "nodes.worker_pid", "relay_procs.pid", "runs.root_pid", "slots.pid",
  ], "the fixture records a process id in each place 0.9.1 keeps one");
  for (const [where, v] of ids) assert.ok(typeof v === "number" && v > 2 ** 22 && v < 2 ** 31, `${where} = ${v} could be a live process's id`);
});

boxed("upgrade from 0.9.1: one open applies schemas 2, 3 and 4 with one unchanged schema-1 backup and keeps every run, node, turn and request", (b) => {
  registry091(b.dbFile);
  assert.equal(userVersion(b.dbFile), 1, "the fixture is a 0.9.1 registry");
  const before = contents(b.dbFile);
  // What the fixture holds, so that one regenerated without something does not pass unnoticed.
  assert.deepEqual(Object.fromEntries(Object.entries(before).map(([t, rows]) => [t, rows.length])), {
    elicitations: 2, events: 13, injections: 1, nodes: 12, relay_procs: 3, requests: 4, runs: 2, slots: 1, sqlite_sequence: 4, turns: 14,
  });
  assert.ok(!("calls" in before) && !before.turns.some((t) => "denials" in t), "nothing of schema 2 is there yet");

  const r = withNext(b, "return { version: dbm.SCHEMA_VERSION, backup: dbm.db() && dbm.registryBackup() };");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.version, 4);
  assert.equal(userVersion(b.dbFile), 4, "one open applies all intervening migrations");

  // One backup, named for the version it holds: the 0.9.1 registry, unchanged.
  const made = backups(b);
  assert.equal(made.length, 1, `one backup: ${made.join(", ")}`);
  assert.match(made[0], /^relay\.db\.backup-v1-/);
  assert.equal(r.out.backup, path.join(b.state, made[0]));
  assert.equal(userVersion(path.join(b.state, made[0])), 1);
  assert.deepEqual(contents(path.join(b.state, made[0])), before);

  // Every old column is unchanged. Schema 2 adds calls/denials, schema 3 adds temp identities and
  // schema 4 adds launch_leaders (empty: leaders are recorded only as relay launches them);
  // legacy turns are left unmapped rather than guessing their private temp directories.
  const after = contents(b.dbFile);
  for (const turn of after.turns) assert.deepEqual([turn.tmp_dir, turn.tmp_dev, turn.tmp_ino], [null, null, null]);
  for (const turn of after.turns) assert.equal(turn.grant_json, null);
  for (const turn of after.turns) assert.equal(turn.refusal_json, null);
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), "calls", "launch_leaders"].sort(), "no table lost, two added");
  for (const [table, rows] of Object.entries(before)) {
    const kept = after[table].map((row) => Object.fromEntries(Object.keys(rows[0] ?? {}).map((k) => [k, row[k]])));
    assert.deepEqual(kept, rows, `${table}: every row kept as it was`);
  }
  assert.deepEqual(after.calls, []);
  assert.deepEqual(after.launch_leaders, []);
  assert.deepEqual(after.turns.map((t) => t.denials), before.turns.map(() => null));

  // Opened again, it is current: no second backup, and nothing changes.
  const again = withNext(b, "return { backup: dbm.db() && dbm.registryBackup() };");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.out.backup, null);
  assert.equal(backups(b).length, 1);
  assert.deepEqual(contents(b.dbFile), after);
});

boxed("upgrade from 0.9.1: its runs, items, turns, approval requests and stored configuration read through this version's code", (b) => {
  registry091(b.dbFile);
  const r = withNext(b, `
    const views = await import(${JSON.stringify(path.join(DIST, "core", "views.js"))});
    const review = await import(${JSON.stringify(path.join(DIST, "modes", "review.js"))});
    const runs = dbm.db().prepare("SELECT id FROM runs ORDER BY created_at").all().map((r) => r.id);
    const nodes = runs.flatMap((id) => dbm.runNodes(id));
    return {
      runs,
      configs: runs.map((id) => { const c = dbm.runConfig(id); return { model: c.targets.codex.default_model, effort: c.targets.codex.default_effort, codexBin: c.targets.codex.bin, jobTimeout: c.job_timeout_s, notify: c.desktop_notifications }; }),
      nodes: nodes.map((n) => [n.id, n.kind, n.target, n.status, n.parent_id]),
      views: nodes.map((n) => views.nodeView(n)).map((v) => [v.id, v.status, v.result !== undefined && Object.keys(v.result).length > 0]),
      fixTurns: dbm.nodeTurns("j_dd57b2ea").map((t) => [t.status, t.reply, t.denials, JSON.parse(t.usage_json).total_tokens]),
      queued: dbm.nextQueuedTurn("j_565805ff")?.body ?? null,
      pending: approvals.pendingRequests(${JSON.stringify(ACTIVE_RUN_091)}).map((q) => [q.id, q.kind, q.turn_id]),
      decided: ["q_d41297af", "q_31750c36", "q_f211a6d1"].map((id) => { const q = approvals.getRequest(id); return [q.status, q.decided_by, q.note, q.turn_id]; }),
      review: (({ status, phase, outcome, consensus }) => ({ status, phase, outcome, agreed: consensus.map((c) => c.ids.join("+")) }))(review.reviewView("r_2d9948c2")),
      discussion: views.nodeView(dbm.getNode("d_1bd2b403")).result.outcome,
      unseen: dbm.db().prepare("SELECT count(*) AS n FROM events WHERE seen_at IS NULL").get().n,
    };
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.runs, [RUN_091, ACTIVE_RUN_091]);
  // Each run keeps the configuration it was started with, in 0.9.1's form.
  for (const c of r.out.configs) {
    assert.deepEqual({ ...c, codexBin: path.basename(c.codexBin) }, { model: "gpt-6.1-sol", effort: "high", codexBin: "stub-codex", jobTimeout: null, notify: false });
  }
  const byId = (rows: unknown[][]) => [...rows].sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  assert.deepEqual(byId(r.out.nodes), byId([
    ["j_dd57b2ea", "job", "codex", "done", null],
    ["t_665b0a35", "thread", "codex", "done", null],
    ["d_1bd2b403", "discussion", "codex", "done", null],
    ["t_d70f530b", "thread", "codex", "done", "d_1bd2b403"],
    ["r_2d9948c2", "review", "codex", "done", null],
    ["j_9aa5ae67", "job", "codex", "done", "r_2d9948c2"],
    ["d_da9fb63a", "discussion", "codex", "done", "r_2d9948c2"],
    ["j_e2169620", "job", "codex", "failed", null],
    ["j_8862a542", "job", "codex", "cancelled", null],
    ["j_0710a86b", "job", "codex", "done", null],
    ["j_97d4cd69", "job", "claude", "done", null],
    ["j_565805ff", "job", "claude", "running", null],
  ]));
  // Every item's view: the finished ones with their result, the running one without.
  for (const [id, status, result] of r.out.views) assert.equal(result, status !== "running", `${id} (${status}) shows a result exactly when it has finished`);
  assert.deepEqual(r.out.fixTurns, [["done", "Fixed the parser.\n\n## Open issues\nnone", null, 1500], ["done", "Added tests.", null, 3000]]);
  assert.equal(r.out.queued, "QUEUED-NEXT: then summarise it");
  // The pending request and the decided ones, each still bound to the turn that asked.
  assert.deepEqual(r.out.pending, [["q_f917294a", "web", 13]]);
  assert.deepEqual(r.out.decided, [
    ["allowed", "user", "fine for this job", 1],
    ["denied", "root session", "not needed", 11],
    ["denied", "terminal", "not on this machine", 12],
  ]);
  assert.deepEqual(r.out.review, { status: "done", phase: "finished", outcome: "agree", agreed: ["C1+X1"] });
  assert.equal(r.out.discussion, "agree");
  assert.equal(r.out.unseen, 0, "what 0.9.1 gave its sessions stays given");

  // The command line shows the request still waiting, and both runs. `relay approvals` does not
  // reap and `relay tree` does, so the request is looked at first, while it is still pending.
  const waiting = spawnSync(process.execPath, [CLI, "approvals"], { env: b.env, encoding: "utf8" });
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.match(waiting.stdout, /q_f917294a/);
  for (const [run, ids] of [[RUN_091, ["j_dd57b2ea", "t_665b0a35", "d_1bd2b403", "r_2d9948c2", "j_8862a542"]], [ACTIVE_RUN_091, ["j_97d4cd69", "j_565805ff"]]] as const) {
    const tree = spawnSync(process.execPath, [CLI, "tree", run], { env: b.env, encoding: "utf8" });
    assert.equal(tree.status, 0, tree.stderr);
    for (const id of ids) assert.match(tree.stdout, new RegExp(id));
  }
  // That reap found the running job's worker gone (it ran on the machine that wrote the fixture) and
  // went through its orphan path: the agent group it recorded is let go, there being no such group
  // here (the fixture's process ids are out of every pid range), the job is lost, its turns are
  // ended, and the request it was waiting on is closed.
  const reaped = withNext(b, `
    const { status, agent_pid, agent_pgid, worker_pid, error } = dbm.getNode("j_565805ff");
    return { node: { status, agent_pid, agent_pgid, worker_pid, error }, turns: dbm.nodeTurns("j_565805ff").map((t) => t.status), request: approvals.getRequest("q_f917294a").status };
  `);
  assert.equal(reaped.status, 0, reaped.stderr);
  assert.deepEqual(reaped.out, {
    node: { status: "lost", agent_pid: null, agent_pgid: null, worker_pid: null, error: "worker process died." },
    turns: ["failed", "failed"],
    request: "expired",
  });
});

boxed("upgrade from 0.9.1: a registry of the next schema version is refused and left exactly as it is", (b) => {
  const current = withNext(b, "return { version: dbm.SCHEMA_VERSION };");
  assert.equal(current.status, 0, current.stderr);
  const next = current.out.version + 1;
  registry091(b.dbFile);
  const d = new DatabaseSync(b.dbFile);
  d.exec(`PRAGMA user_version = ${next};`);
  d.close();
  const before = contents(b.dbFile);
  const r = withNext(b, "dbm.db(); return {};");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`was written by a newer relay \\(schema version ${next}; this relay knows up to ${next - 1}\\)`));
  assert.match(r.stderr, /restore the backup/);
  assert.equal(userVersion(b.dbFile), next);
  assert.deepEqual(contents(b.dbFile), before, "not a row or a column changed");
  assert.deepEqual(backups(b), []);
});

// The build stamp: which commit dist/ was built from, so that doctor can tell when the checkout has
// moved on without a rebuild (a pull, or a sync job's fast-forward). Checked on a scratch copy of
// this checkout's build, made a git repository of its own, so commits can be added under it.

test("build stamp: npm run build records the commit it built", () => {
  const top = spawnSync("git", ["-C", ROOT, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(ROOT)) return;
  const info = JSON.parse(fs.readFileSync(path.join(DIST, "build-info.json"), "utf8"));
  assert.equal(info.commit, spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim());
  assert.equal(typeof info.dirty, "boolean");
  assert.ok(!Number.isNaN(Date.parse(info.built_at)));
});

boxed("build stamp: doctor reports the commit dist/ was built from, and warns when the checkout's HEAD differs or there is no stamp", (b) => {
  const co = path.join(b.tmp, "checkout");
  for (const d of ["dist", "adapters", "bin", "scripts"]) fs.cpSync(path.join(ROOT, d), path.join(co, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(co, "package.json"));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(co, "node_modules"));
  fs.writeFileSync(path.join(co, ".gitignore"), "dist/\nnode_modules\n");
  const env = { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", co, ...args], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "built");
  const built = git("rev-parse", "HEAD");
  const stamp = () => spawnSync(process.execPath, [path.join(co, "scripts", "stamp-build.mjs")], { env, encoding: "utf8" });
  const doctor = () => spawnSync(process.execPath, [path.join(co, "dist", "cli.js"), "doctor"], { env, encoding: "utf8" }).stdout;
  assert.equal(stamp().status, 0);
  const info = JSON.parse(fs.readFileSync(path.join(co, "dist", "build-info.json"), "utf8"));
  assert.equal(info.commit, built);
  assert.equal(info.dirty, false);
  assert.match(doctor(), new RegExp(`build\\s+built from ${built} on \\S+, the checkout's HEAD\\n`));

  // The checkout moves on (a pull, a fast-forward) and dist/ is not rebuilt.
  fs.writeFileSync(path.join(co, "NEW"), "x");
  git("add", "NEW");
  git("commit", "-q", "-m", "moved on");
  const head = git("rev-parse", "HEAD");
  assert.match(doctor(), new RegExp(`build\\s+WARNING: built from ${built} on \\S+, but the checkout is now at ${head}, so the code running is not what the checkout holds\\. Rebuild: cd .*checkout && npm ci && npm run build`));

  // Built from a tree with changes not in the commit: said so.
  fs.writeFileSync(path.join(co, "NEW"), "y");
  assert.equal(stamp().status, 0);
  assert.match(doctor(), new RegExp(`build\\s+built from ${head} with uncommitted changes on \\S+, the checkout's HEAD`));

  // A build from before stamps (0.2.0's, say), or one that lost it.
  fs.rmSync(path.join(co, "dist", "build-info.json"));
  assert.match(doctor(), /build\s+WARNING: no build stamp \(dist\/build-info\.json\), so relay cannot tell which commit dist\/ was built from/);

  // Unpacked inside another repository, the build is not that repository's commit.
  fs.rmSync(path.join(co, ".git"), { recursive: true });
  spawnSync("git", ["-C", b.tmp, "init", "-q"], { env });
  assert.equal(stamp().status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(co, "dist", "build-info.json"), "utf8")).commit, null);
  assert.match(doctor(), /build\s+built outside a git checkout/);
});

boxed("build stamp: on an npm install, doctor names the build by relay's build identity and says it is an npm install, not a checkout", (b) => {
  // Where npm puts a global install: <prefix>/lib/node_modules/@jbkjr/relay, a copy of the package (no .git).
  const pkg = path.join(b.tmp, "prefix", "lib", "node_modules", "@jbkjr", "relay");
  fs.mkdirSync(path.dirname(pkg), { recursive: true });
  const id = copyBuild(ROOT, pkg);
  const doctor = () => spawnSync(process.execPath, [path.join(pkg, "dist", "cli.js"), "doctor"], { env: b.env, cwd: b.tmp, encoding: "utf8" }).stdout;
  const info = JSON.parse(fs.readFileSync(path.join(pkg, "dist", "build-info.json"), "utf8"));
  const out = doctor();
  assert.match(out, new RegExp(`\\nbuild\\s+an npm install of @jbkjr/relay \\(no git checkout\\): ${describeBuild(id).replace(/\./g, "\\.")}; built from ${info.commit}( with uncommitted changes)? on \\S+\\n`));
  assert.equal(describeBuild(id), `relay ${id.version}, build ${id.sha256.slice(0, 16)}`);
  assert.doesNotMatch(out, /checkout's HEAD|built outside a git checkout/);
  // A checkout that happens to sit at node_modules/@jbkjr/relay (its own .git) is a checkout: its HEAD is what is compared.
  fs.mkdirSync(path.join(pkg, ".git"));
  assert.match(doctor(), /\nbuild\s+built from \S+.*; relay could not read the checkout's HEAD\n/);
  fs.rmSync(path.join(pkg, ".git"), { recursive: true });
  // An install missing a file of its build: said, with how to reinstall, not passed over.
  fs.rmSync(path.join(pkg, "npm-shrinkwrap.json"));
  assert.match(doctor(), new RegExp(`\\nbuild\\s+WARNING: an npm install of @jbkjr/relay \\(no git checkout\\), but relay could not take its build identity: relay's build at .* is incomplete: npm-shrinkwrap\\.json is missing.*Reinstall it: npm install -g @jbkjr/relay@${id.version}\\n`));
  // The same files anywhere else are not called an npm install, nor a checkout.
  const elsewhere = path.join(b.tmp, "copy");
  copyBuildLoose(pkg, elsewhere);
  const plain = spawnSync(process.execPath, [path.join(elsewhere, "dist", "cli.js"), "doctor"], { env: b.env, cwd: b.tmp, encoding: "utf8" }).stdout;
  assert.doesNotMatch(plain, /\nbuild\s+an npm install/);
  assert.match(plain, /\nbuild\s+built from \S+.*; .*\/copy is not a git checkout or an npm install, so there is no checkout's HEAD to compare it with\n/);
});

/** dist/, package.json and the dependency links of `from`, copied to `to`: enough for doctor to run. */
function copyBuildLoose(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(path.join(from, "dist"), path.join(to, "dist"), { recursive: true });
  fs.copyFileSync(path.join(from, "package.json"), path.join(to, "package.json"));
  fs.cpSync(path.join(from, "node_modules"), path.join(to, "node_modules"), { recursive: true, verbatimSymlinks: true });
}

// Smoke tools start relay against RELAY_HOME. Pointed at the default state directory, a prerelease
// build would migrate the live registry, so they refuse to start without a scratch one.

boxed("smoke tools refuse to start without RELAY_HOME, or with relay's default state directory", (b) => {
  const live = path.join(b.home, ".local", "state", "relay");
  const env = { ...b.env, RELAY_SMOKE_HOST: "claude" } as Record<string, string>;
  delete env.RELAY_HOME;
  const run = (args: string[], extra: Record<string, string>) => spawnSync(process.execPath, args, { env: { ...env, ...extra }, cwd: b.tmp, encoding: "utf8", timeout: 20_000 });
  for (const args of [[path.join(ROOT, "smoke", "root.mjs"), "serve"], [path.join(ROOT, "smoke", "call.mjs"), "status", "{}"]]) {
    const unset = run(args, {});
    assert.equal(unset.status, 2, unset.stderr);
    assert.match(unset.stderr, /RELAY_HOME is not set\. Smoke tools run only against a scratch state directory/);
    const dflt = run(args, { RELAY_HOME: live });
    assert.equal(dflt.status, 2, dflt.stderr);
    assert.match(dflt.stderr, /RELAY_HOME is relay's default state directory/);
    assert.ok(!fs.existsSync(live), "nothing is made in the default state directory");
  }
});
