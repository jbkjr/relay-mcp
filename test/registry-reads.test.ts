// What relay keeps in a process between reads of the registry, so that status stays cheap on a
// large run, must never answer for a row that has changed: another process's write, the same
// process's own, or another registry opened after the first was closed.
import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { closeDbForTests, createRun, db, runConfig } from "../dist/core/db.js";
import { withDefaults } from "../dist/core/config.js";

function scratchRegistry(t: { after: (fn: () => void) => void }): { home: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reads-"));
  const old = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  const home = path.join(dir, "registry");
  process.env.RELAY_HOME = home;
  process.env.RELAY_CONFIG = path.join(dir, "config.json");
  t.after(() => {
    closeDbForTests();
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { home, file: path.join(home, "relay.db") };
}

test("runConfig: each caller gets a copy of its own, and a rewrite of the run's row by another connection is read", (t) => {
  const { file } = scratchRegistry(t);
  const run = createRun(os.tmpdir(), withDefaults({ allow_temp_home: true, max_concurrent: 3 }), "reads-root");
  const first = runConfig(run);
  assert.equal(first.max_concurrent, 3);
  // A caller that changes what it was given (env-broker.ts environmentConfig) changes only its copy.
  first.max_concurrent = 99;
  first.targets.codex.child_auth = "any";
  first.child_env.pass.push("CHANGED");
  const second = runConfig(run);
  assert.equal(second.max_concurrent, 3);
  assert.notEqual(second.targets.codex.child_auth, "any");
  assert.ok(!second.child_env.pass.includes("CHANGED"));
  assert.notEqual(first, second);
  // Another process rewrites the row: the configuration itself, and the private params beside it.
  const other = new DatabaseSync(file);
  try {
    other.exec("PRAGMA busy_timeout = 10000;");
    other.prepare("UPDATE runs SET config_json = json_set(config_json, '$.max_concurrent', 5) WHERE id = ?").run(run);
    assert.equal(runConfig(run).max_concurrent, 5);
    other.prepare("UPDATE runs SET config_json = json_set(config_json, '$.params_json.overlays', json('[]')) WHERE id = ?").run(run);
    assert.equal(runConfig(run).max_concurrent, 5);
    assert.equal((runConfig(run) as unknown as Record<string, unknown>).params_json, undefined, "the run's private params never reach its configuration");
    // An invalid configuration is refused every time it is read, never answered from an earlier parse.
    other.prepare("UPDATE runs SET config_json = json_set(config_json, '$.notify', json('true'), '$.desktop_notifications', json('true')) WHERE id = ?").run(run);
    assert.throws(() => runConfig(run), /relay config is not valid/);
    assert.throws(() => runConfig(run), /relay config is not valid/);
  } finally { other.close(); }
  // This process's own write, too.
  db().prepare("UPDATE runs SET config_json = json_remove(json_set(config_json, '$.max_concurrent', 7), '$.notify') WHERE id = ?").run(run);
  assert.equal(runConfig(run).max_concurrent, 7);
  assert.throws(() => runConfig("run_00000000"), /unknown run/);
});

test("runConfig: a run of the same id in another registry, opened after the first was closed, is read from that registry", (t) => {
  const { file } = scratchRegistry(t);
  const run = createRun(os.tmpdir(), withDefaults({ allow_temp_home: true, max_concurrent: 2 }), "reads-root");
  assert.equal(runConfig(run).max_concurrent, 2);
  const config = (db().prepare("SELECT config_json FROM runs WHERE id = ?").get(run) as { config_json: string }).config_json;
  closeDbForTests();
  // A second registry holding a run of that id with another configuration (as tests and the
  // benchmark make, with ids of their own choosing).
  const home2 = path.join(path.dirname(path.dirname(file)), "registry2");
  process.env.RELAY_HOME = home2;
  createRun(os.tmpdir(), withDefaults({ allow_temp_home: true }), "reads-root-2");
  db().prepare("INSERT INTO runs (id, created_at, root_cwd, config_json) VALUES (?, ?, ?, ?)").run(run, Date.now(), os.tmpdir(), JSON.stringify({ ...JSON.parse(config), max_concurrent: 6 }));
  assert.equal(runConfig(run).max_concurrent, 6);
});

test("workCwd: a directory is matched to the worktree that holds it as a path, across the registry's history", async (t) => {
  scratchRegistry(t);
  const { insertNode, newId, workCwd } = await import("../dist/core/db.js");
  const run = createRun(os.tmpdir(), withDefaults({ allow_temp_home: true }), "reads-root");
  const base = path.join(os.tmpdir(), "relay-reads-wt");
  const job = (worktree: string | null, cwd: string, created_at: number) =>
    insertNode({ id: newId("job"), run_id: run, kind: "job", mode: "write", depth: 1, task: "t", cwd, worktree, created_at });
  // Many runs' worth of other jobs' worktrees.
  for (let i = 0; i < 50; i++) job(path.join(base, `old${i}`), path.join(base, `old${i}`), 1000 + i);
  job(path.join(base, "a"), path.join(base, "a"), 2000);
  job(path.join(base, "a", "inner"), path.join(base, "a", "inner"), 3000);
  job(path.join(base, "slash") + path.sep, path.join(base, "slash"), 2500);
  job("", "/", 900);
  const at = (cwd: string) => workCwd({ cwd, worktree: null });
  assert.equal(at(path.join(base, "a", "sub", "dir")), path.join(base, "a"));
  assert.equal(at(path.join(base, "a")), path.join(base, "a"));
  // The most recent job whose worktree holds it, as before.
  assert.equal(at(path.join(base, "a", "inner", "x")), path.join(base, "a", "inner"));
  assert.equal(at(path.join(base, "slash", "x")), path.join(base, "slash") + path.sep);
  assert.equal(at(path.join(base, "old7", "deep")), path.join(base, "old7"));
  // A sibling whose name begins with a worktree's is not inside it; an empty worktree, recorded by
  // nothing relay writes, holds every absolute path, as it always has.
  assert.equal(at(path.join(base, "ab")), "");
  assert.equal(at(path.join(base, "old7x", "y")), "");
  // A worktree of its own is its own.
  assert.equal(workCwd({ cwd: "/elsewhere", worktree: "/w" }), "/w");
});

test("reap: what is reapable is reaped, and a reap that finds nothing takes no write lock", async (t) => {
  const { file } = scratchRegistry(t);
  const { insertNode, insertTurn, newId, reap, getNode } = await import("../dist/core/db.js");
  const { procStart } = await import("../dist/core/procs.js");
  const { spawnSync } = await import("node:child_process");
  const run = createRun(os.tmpdir(), withDefaults({ allow_temp_home: true }), "reads-root");
  // A pid that has exited (the shell below), and this live process.
  const dead = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
  const node = (status: string, worker_pid: number | null) => {
    const n = insertNode({ id: newId("job"), run_id: run, kind: "job", mode: "read", depth: 1, task: "t", cwd: os.tmpdir(), status: status as never });
    db().prepare("UPDATE nodes SET worker_pid = ?, worker_start = ? WHERE id = ?").run(worker_pid, worker_pid === process.pid ? procStart(process.pid) : "Thu Jan  1 00:00:00 2026", n.id);
    insertTurn(n.id, "root", "go", "read", status === "running" ? "running" : status === "queued" ? "queued" : "done");
    return n.id;
  };
  const orphaned = node("running", Number(dead));
  const live = node("running", process.pid);
  const settled = node("done", null);
  const neverClaimed = node("queued", null);
  db().prepare("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES ('q_00000001', ?, ?, 'path', 's', 'pending', ?)").run(run, settled, Date.now());
  db().prepare("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES ('q_00000002', ?, ?, 'path', 's', 'pending', ?)").run(run, live, Date.now());
  db().prepare("INSERT INTO slots (run_id, holder, pid, state, created_at) VALUES (?, 'x', ?, 'held', ?), (?, 'y', ?, 'held', ?)").run(run, Number(dead), Date.now(), run, process.pid, Date.now());
  db().prepare("INSERT INTO relay_procs (pid, start, kind, created_at) VALUES (?, 'Thu Jan  1 00:00:00 2026', 'worker', ?), (?, ?, 'server', ?)").run(Number(dead), Date.now(), process.pid, procStart(process.pid), Date.now());
  reap(run);
  assert.equal(getNode(orphaned)!.status, "lost");
  assert.equal((db().prepare("SELECT status FROM turns WHERE node_id = ?").get(orphaned) as { status: string }).status, "failed");
  assert.equal(getNode(live)!.status, "running");
  assert.equal(getNode(neverClaimed)!.status, "queued");
  assert.deepEqual((db().prepare("SELECT id, status FROM requests ORDER BY id").all() as { id: string; status: string }[]).map((r) => `${r.id} ${r.status}`), ["q_00000001 expired", "q_00000002 pending"]);
  assert.deepEqual((db().prepare("SELECT pid FROM slots").all() as { pid: number }[]).map((s) => s.pid), [process.pid]);
  assert.deepEqual((db().prepare("SELECT pid FROM relay_procs").all() as { pid: number }[]).map((s) => s.pid), [process.pid]);
  // Nothing is left to reap: another connection holding the write lock does not hold reap up.
  const other = new DatabaseSync(file);
  try {
    other.exec("BEGIN IMMEDIATE");
    const t0 = Date.now();
    reap(run);
    assert.ok(Date.now() - t0 < 2000, `reap waited ${Date.now() - t0} ms for a write lock it did not need`);
    other.exec("ROLLBACK");
  } finally { other.close(); }
  // Something to reap again: a request of an item that has since settled.
  db().prepare("UPDATE nodes SET status = 'done' WHERE id = ?").run(live);
  reap(run);
  assert.equal((db().prepare("SELECT status FROM requests WHERE id = 'q_00000002'").get() as { status: string }).status, "expired");
});

test("recordEvents: a session whose next turn another process starts just after its row is read still has its discussion reply recorded, and nothing else", async (t) => {
  const { file } = scratchRegistry(t);
  const { insertNode, insertTurn, updateNode, updateTurn } = await import("../dist/core/db.js");
  const { recordEvents } = await import("../dist/core/events.js");
  const run = createRun(os.tmpdir(), withDefaults({ allow_temp_home: true }), "reads-root");
  const fields = { run_id: run, mode: "read" as const, depth: 1, task: "t", cwd: os.tmpdir() };
  // A root session's job, borrowed for its discussion: its last executed turn is the discussion's reply.
  const discussion = insertNode({ ...fields, id: "d_00000001", kind: "discussion", status: "open" });
  const job = insertNode({ ...fields, id: "j_00000001", kind: "job", target: "claude", status: "done" });
  updateNode(job.id, { ended_at: 100 });
  const reply = insertTurn(job.id, `discussion:${discussion.id}`, "reply", "read", "done");
  updateTurn(reply, { ended_at: 100 });
  const next = insertTurn(job.id, "root", "followup", "read", "queued");
  const events = () => (db().prepare("SELECT key, item_id FROM events ORDER BY id").all() as { key: string; item_id: string }[]).map((e) => `${e.key} ${e.item_id}`);
  const other = new DatabaseSync(file);
  try {
    other.exec("PRAGMA busy_timeout = 10000;");
    // Another process claims the job's next turn just after this look has read which nodes have
    // ended: the job is running again, and its row no longer says when it ended.
    const d = db();
    let requeued = false;
    const prepare = d.prepare.bind(d);
    Object.defineProperty(d, "prepare", {
      configurable: true,
      value: (sql: string) => {
        const s = prepare(sql);
        if (/FROM nodes WHERE run_id = \? AND ended_at >= \?/.test(sql) && !requeued) {
          const all = s.all.bind(s);
          s.all = (...args: never[]) => {
            const rows = all(...args);
            other.prepare("UPDATE nodes SET status = 'running', ended_at = NULL WHERE id = ?").run(job.id);
            other.prepare("UPDATE turns SET status = 'running' WHERE id = ?").run(next);
            requeued = true;
            return rows;
          };
        }
        return s;
      },
    });
    try {
      recordEvents(new Map([[run, 0]]), () => false);
    } finally {
      delete (d as { prepare?: unknown }).prepare;
    }
    assert.equal(requeued, true, "the job was requeued between the two reads");
    assert.deepEqual(events(), [`settled:${job.id}:turn:${reply} ${discussion.id}`], "the reply, keyed on its turn, and no completion keyed on when the job ended");
    // The follow-up finishes: the job's own completion is recorded once, keyed on that turn.
    other.prepare("UPDATE turns SET status = 'done', ended_at = 200 WHERE id = ?").run(next);
    other.prepare("UPDATE nodes SET status = 'done', ended_at = 200 WHERE id = ?").run(job.id);
    recordEvents(new Map([[run, 0]]), () => false);
    recordEvents(new Map([[run, 0]]), () => false);
    assert.deepEqual(events(), [`settled:${job.id}:turn:${reply} ${discussion.id}`, `settled:${job.id}:turn:${next} ${job.id}`]);
  } finally {
    other.close();
  }
});

test("recordEvents: a discussion reply followed at once by the session's own queued turn is still recorded, with that turn's completion", async (t) => {
  scratchRegistry(t);
  const { insertNode, insertTurn, updateNode, updateTurn } = await import("../dist/core/db.js");
  const { recordEvents } = await import("../dist/core/events.js");
  const run = createRun(os.tmpdir(), withDefaults({ allow_temp_home: true }), "reads-root");
  const fields = { run_id: run, mode: "read" as const, depth: 1, task: "t", cwd: os.tmpdir() };
  // A root session's job, borrowed for its discussion. Its own follow-up was queued behind the
  // discussion's turn and ran at once, so no look saw the job settled with the reply alone.
  const discussion = insertNode({ ...fields, id: "d_00000001", kind: "discussion", status: "open" });
  const job = insertNode({ ...fields, id: "j_00000001", kind: "job", target: "claude", status: "done" });
  const first = insertTurn(job.id, "delegate", "task", "read", "done");
  updateTurn(first, { ended_at: 50 });
  const reply = insertTurn(job.id, `discussion:${discussion.id}`, "reply", "read", "done");
  updateTurn(reply, { ended_at: 100 });
  const own = insertTurn(job.id, "root", "followup", "read", "done");
  updateTurn(own, { ended_at: 200 });
  updateNode(job.id, { ended_at: 200 });
  const events = () => (db().prepare("SELECT key, item_id FROM events ORDER BY id").all() as { key: string; item_id: string }[]).map((e) => `${e.key} ${e.item_id}`).sort();
  recordEvents(new Map([[run, 0]]), () => false);
  recordEvents(new Map([[run, 0]]), () => false);
  assert.deepEqual(events(), [`settled:${job.id}:turn:${own} ${job.id}`, `settled:${job.id}:turn:${reply} ${discussion.id}`].sort());
  // Once the discussion is over, a reply in it is no longer news.
  db().prepare("DELETE FROM events").run();
  db().prepare("UPDATE nodes SET status = 'done' WHERE id = ?").run(discussion.id);
  recordEvents(new Map([[run, 0]]), () => false);
  assert.deepEqual(events(), [`settled:${job.id}:turn:${own} ${job.id}`]);
});
