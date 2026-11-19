// Polls woken by the registry (src/core/wake.ts): a nap ends early when another process commits,
// never for this process's own commits, and only as often as its allowance; waits and slot
// requests built on it keep their order, their limits and their handoffs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { scratchOnly, sleep, until } from "./helpers.ts";
import { withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun, db, insertNode } from "../dist/core/db.js";
import { newInstance } from "../dist/core/caller.js";
import { acquireSlot } from "../dist/core/slots.js";
import { registryPoll } from "../dist/core/wake.js";
import { settled, waitUntil } from "../dist/core/wait.js";

function fixture(config = {}) {
  closeDbForTests();
  const home = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-wake-"))));
  const previous = { ...process.env };
  process.env.RELAY_HOME = home;
  process.env.RELAY_CONFIG = path.join(home, "config.json");
  const cfg = withDefaults({ ask_user: "never", allow_temp_home: true, ...config });
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
  const inst = newInstance({ kind: "root" }, home, "codex");
  const run = createRun(home, cfg, inst.token);
  inst.runId = run;
  inst.since.set(run, 0);
  let seq = 0;
  const node = (values = {}) => insertNode({ id: `j_${(++seq).toString(16).padStart(8, "0")}`, run_id: run, kind: "job", target: "claude", mode: "read", depth: 1, task: "test", cwd: home, status: "done", ...values });
  // A second connection stands in for another relay process: its commits change PRAGMA data_version for db().
  const other = new DatabaseSync(path.join(home, "relay.db"));
  other.exec("PRAGMA busy_timeout = 10000;");
  /** A commit by "another process". It changes a value: SQLite writes nothing for an update that leaves a row as it was. */
  const poke = () => other.prepare("UPDATE runs SET created_at = created_at + 1000 WHERE id = ?").run(run);
  return { home, inst, run, node, other, poke, close() {
    other.close();
    closeDbForTests();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    fs.rmSync(home, { recursive: true, force: true });
  } };
}

test("registry poll: another process's commit ends a nap early; this process's own commits and silence do not", async () => {
  const f = fixture();
  try {
    const poll = registryPoll();
    let t = Date.now();
    setTimeout(f.poke, 50);
    assert.equal(await poll.nap(5000), true, "woken by another connection's commit");
    assert.ok(Date.now() - t < 2500, `woke after ${Date.now() - t} ms, not at its 5 s limit`);

    t = Date.now();
    setTimeout(() => db().prepare("UPDATE runs SET created_at = created_at + 1 WHERE id = ?").run(f.run), 50);
    assert.equal(await poll.nap(400), false, "a commit of this connection's own is no reason to wake");
    assert.ok(Date.now() - t >= 390, "the nap ran its length");

    // A commit between two naps (while the poll was looking) ends the next nap at once.
    f.poke();
    t = Date.now();
    assert.equal(await poll.nap(5000), true);
    assert.ok(Date.now() - t < 2500);

    // Once the log starts over after a checkpoint, commits overwrite it in place (which macOS
    // reports as a rename): each still wakes the poll.
    f.other.exec("PRAGMA wal_checkpoint(PASSIVE)");
    for (let i = 0; i < 3; i++) {
      t = Date.now();
      setTimeout(f.poke, 30);
      assert.equal(await poll.nap(5000), true, `commit ${i + 1} after the checkpoint`);
      assert.ok(Date.now() - t < 2500, `woke after ${Date.now() - t} ms`);
    }

    const ctl = new AbortController();
    t = Date.now();
    setTimeout(() => ctl.abort(), 50);
    assert.equal(await poll.nap(5000, ctl.signal), false, "an abort ends the nap, not as a wake");
    assert.ok(Date.now() - t < 2500);
  } finally { f.close(); }
});

test("registry poll: a registry written without pause wakes a poll about once per 10 ms at most", async () => {
  const f = fixture();
  try {
    const poll = registryPoll();
    const writer = setInterval(f.poke, 1);
    let wakes = 0;
    const end = Date.now() + 500;
    try {
      while (Date.now() < end) if (await poll.nap(Math.max(1, end - Date.now()))) wakes++;
    } finally { clearInterval(writer); }
    // 3 at once, then one per 10 ms: about 53 in 500 ms.
    assert.ok(wakes <= 65, `${wakes} wakes in 500 ms`);
    assert.ok(wakes >= 5, `${wakes} wakes in 500 ms: the writes woke the poll`);
  } finally { f.close(); }
});

test("wait: its own commits never make it look more than every 200 ms; another process's settle ends it at once", async () => {
  const f = fixture();
  try {
    const n = f.node({ status: "running" });
    // A predicate that writes through this process's connection on every look (as settling a discussion can).
    let looks = 0;
    const writes = () => {
      looks++;
      db().prepare("UPDATE nodes SET task = ? WHERE id = ?").run(`look ${looks}`, n.id);
      return false;
    };
    let t = Date.now();
    assert.equal(await waitUntil(writes, { ms: 1000, lender: null }), false);
    assert.ok(Date.now() - t >= 1000, "a wait that is not done uses its whole limit");
    assert.ok(Date.now() - t < 2000, "and stops at it");
    assert.ok(looks <= 10, `${looks} looks in 1 s`);

    t = Date.now();
    setTimeout(() => f.other.prepare("UPDATE nodes SET status = 'done' WHERE id = ?").run(n.id), 100);
    assert.equal(await waitUntil(() => settled(n.id), { ms: 10_000, lender: null }), true);
    assert.ok(Date.now() - t < 3000, `returned ${Date.now() - t} ms after the call`);
  } finally { f.close(); }
});

test("wait: a request another process files is put to the user before the waiting call is ever handed it", async () => {
  const f = fixture();
  try {
    const n = f.node({ status: "running" });
    const asked: string[] = [];
    f.inst.host.elicit = (r, signal) => {
      asked.push(r.id);
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ reading: "withdrawn", outcome: "test" }), { once: true }));
    };
    const waiting = waitUntil(() => settled(n.id), { ms: 10_000, lender: null, root: { inst: f.inst, runId: f.run } });
    await sleep(50);
    f.other.prepare("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES ('q_0000000a', ?, ?, 'command', 'test', 'pending', ?)").run(f.run, n.id, Date.now());
    await until(() => asked.length === 1, 5000, "the request to be put to the user");
    await sleep(300);
    f.other.prepare("UPDATE nodes SET status = 'done' WHERE id = ?").run(n.id);
    assert.equal(await waiting, true, "the wait went on while the user was being asked, and ended with the item");
    assert.deepEqual(asked, ["q_0000000a"]);
    assert.equal(f.inst.handedOff.size, 0);
    for (const [, ctl] of f.inst.asking) ctl.abort();
    await until(() => f.inst.asking.size === 0, 5000, "the question to be withdrawn");

    // Where the host cannot ask, the same request ends the wait so that the calling agent has it.
    delete f.inst.host.elicit;
    const m = f.node({ status: "running" });
    const t = Date.now();
    const handoff = waitUntil(() => settled(m.id), { ms: 10_000, lender: null, root: { inst: f.inst, runId: f.run } });
    await sleep(50);
    f.other.prepare("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES ('q_0000000b', ?, ?, 'command', 'test', 'pending', ?)").run(f.run, m.id, Date.now());
    assert.equal(await handoff, false, "handed to the caller");
    assert.ok(Date.now() - t < 3000);
  } finally { f.close(); }
});

/** A slot request still waiting in some other process (it never looks while the test runs). */
const elsewhere = (run: string, holder: string, state = "waiting") =>
  db().prepare("INSERT INTO slots (run_id, holder, pid, state, created_at) VALUES (?, ?, ?, ?, ?)").run(run, holder, process.pid, state, Date.now()).lastInsertRowid;
const resolvedWithin = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

test("slots: a request takes a free slot without waiting for an earlier request to take its own", async () => {
  const f = fixture({ max_concurrent: 2 });
  try {
    elsewhere(f.run, "earlier");
    const mine = acquireSlot(f.run, "mine", () => false);
    assert.equal(await resolvedWithin(mine, 2000), true, "two slots free: one for the earlier request, one for this");
    assert.deepEqual(db().prepare("SELECT holder, state FROM slots WHERE run_id = ? ORDER BY id").all(f.run).map((r) => `${r.holder}:${r.state}`), ["earlier:waiting", "mine:held"]);
  } finally { f.close(); }
});

test("slots: a free slot goes to the earliest request, never past it", async () => {
  const f = fixture({ max_concurrent: 1 });
  try {
    const earlier = elsewhere(f.run, "earlier");
    const mine = acquireSlot(f.run, "mine", () => false);
    assert.equal(await resolvedWithin(mine, 500), false, "the one free slot is the earlier request's");
    f.other.prepare("DELETE FROM slots WHERE id = ?").run(earlier);
    assert.equal(await resolvedWithin(mine, 5000), true, "and this one's once the earlier request has gone");
  } finally { f.close(); }
});

test("slots: requests are granted in arrival order and never more than max_concurrent are held", async () => {
  const f = fixture({ max_concurrent: 2 });
  try {
    const x = elsewhere(f.run, "x", "held");
    const y = elsewhere(f.run, "y", "held");
    // A lent slot does not count: its holder is blocked inside a relay call.
    elsewhere(f.run, "lender", "lent");
    const order: string[] = [];
    const ids: Record<string, number> = {};
    const names = ["a1", "a2", "a3", "a4", "a5"];
    const all = names.map((h) => acquireSlot(f.run, h, () => false).then((id) => { order.push(h); ids[h] = id!; }));
    const held = () => (db().prepare("SELECT COUNT(*) AS c FROM slots WHERE run_id = ? AND state = 'held'").get(f.run) as { c: number }).c;
    await sleep(300);
    assert.deepEqual(order, [], "both slots are held");
    // Each slot is freed by "another process"; the earliest request still waiting takes it.
    const frees = [x, y];
    for (let i = 0; i < names.length; i++) {
      f.other.prepare("DELETE FROM slots WHERE id = ?").run(frees[i]);
      await until(() => order.length === i + 1, 5000, `${names[i]} to take the slot freed`);
      await sleep(30);
      assert.deepEqual(order, names.slice(0, i + 1));
      assert.ok(held() <= 2, `${held()} slots held`);
      frees.push(ids[names[i]]);
    }
    await Promise.all(all);
  } finally { f.close(); }
});

test("slots: a request whose caller gives up leaves without a slot", async () => {
  const f = fixture({ max_concurrent: 1 });
  try {
    elsewhere(f.run, "x", "held");
    let stop = false;
    const mine = acquireSlot(f.run, "mine", () => stop);
    await sleep(200);
    stop = true;
    assert.equal(await mine, null);
    assert.equal((db().prepare("SELECT COUNT(*) AS c FROM slots WHERE holder = 'mine'").get() as { c: number }).c, 0);
  } finally { f.close(); }
});
