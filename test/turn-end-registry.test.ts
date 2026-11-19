// How a turn's end is recorded for its session, checked in the registry itself: no subprocesses.
// The worker's writes are made here, in the order a worker makes them, and another connection reads
// the registry between them, as a waiting call or another process would.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
// Loaded for the scratch HOME every test file runs with (test guard); no harness is started.
import { sleep, until } from "./helpers.ts";
import { newInstance } from "../dist/core/caller.js";
import { withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun, db, getNode, getTurn, insertNode, insertTurn, reap, runConfig, turnSettled, updateNode, updateTurn, workerLive } from "../dist/core/db.js";
import { recordEvents } from "../dist/core/events.js";
import { finishTurn } from "../dist/core/outcome.js";
import { ask } from "../dist/core/ops.js";
import { procStart } from "../dist/core/procs.js";
import { waitUntil } from "../dist/core/wait.js";

async function scratch(fn: (s: { inst: ReturnType<typeof newInstance>; run: string; tmp: string; file: string }) => Promise<void> | void) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "turnend-")));
  const previous = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  try {
    process.env.RELAY_HOME = path.join(tmp, "state");
    process.env.RELAY_CONFIG = path.join(tmp, "config.json");
    fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ allow_temp_home: true }));
    const inst = newInstance({ kind: "root" }, tmp, "claude");
    const run = createRun(tmp, withDefaults({ allow_temp_home: true }), inst.token);
    inst.runId = run;
    await fn({ inst, run, tmp, file: path.join(process.env.RELAY_HOME, "relay.db") });
  } finally {
    closeDbForTests();
    for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Another process's connection to the registry. */
function connection(file: string): DatabaseSync {
  const other = new DatabaseSync(file);
  other.exec("PRAGMA busy_timeout = 10000");
  return other;
}

const failed = { status: "failed" as const, error: "the agent failed", finalMessage: "", exitCode: 1, timedOut: false, warnings: [], finalPath: null };

for (const started of [true, false]) test(`turn end: another connection finds a ${started ? "" : "never-started "}turn's end, its session's result and status, and the queued turns it drops all at once, or none of them`, () => scratch(({ run, tmp, file }) => {
  const job = insertNode({ id: "j_window", run_id: run, kind: "job", target: "codex", mode: "read", depth: 1, task: "t", cwd: tmp, status: started ? "running" : "queued" });
  const turn = insertTurn(job.id, "delegate", "prompt", "read");
  const behind = insertTurn(job.id, "resume", "queued behind it", "read");
  const outcome = { ...failed };
  // A turn whose agent ran was recorded as over as its agent ended (runSessionTurn); one that never
  // started is recorded as over by the worker, with its session (TurnOutcome.close).
  if (started) updateTurn(turn, { status: "failed", error: failed.error, started_at: 1, ended_at: 2 });
  else Object.assign(outcome, { close: () => updateTurn(turn, { status: "failed", error: failed.error, ended_at: 2 }) });
  const other = connection(file);
  try {
    const look = () => {
      const n = other.prepare("SELECT status, result_json, ended_at, json_extract(params_json, '$.own.status') AS own FROM nodes WHERE id = ?").get(job.id) as { status: string; result_json: string | null; ended_at: number | null; own: string | null };
      const of = (id: number) => (other.prepare("SELECT status FROM turns WHERE id = ?").get(id) as { status: string }).status;
      return JSON.stringify({ node: n.status, result: n.result_json !== null, ended: n.ended_at !== null, own: n.own, turn: of(turn), behind: of(behind) });
    };
    const before = look();
    // At every write the worker makes while it records the turn's end, another connection reads.
    const seen = new Set<string>();
    db().function("observe", () => (seen.add(look()), null));
    db().exec("CREATE TEMP TRIGGER observe_nodes AFTER UPDATE ON nodes BEGIN SELECT observe(); END; CREATE TEMP TRIGGER observe_turns AFTER UPDATE ON turns BEGIN SELECT observe(); END;");
    finishTurn(getNode(job.id)!, getTurn(turn)!, outcome, withDefaults({}));
    const after = look();
    assert.deepEqual(JSON.parse(after), { node: "failed", result: true, ended: true, own: "failed", turn: "failed", behind: "cancelled" });
    assert.ok(seen.size > 0, "the reads were made");
    for (const s of seen) assert.ok(s === before || s === after, `another connection read ${s}, between ${before} and ${after}`);
  } finally {
    other.close();
  }
}));

test("turn end: ask returns a turn's end only once its thread has settled with it, so a follow-up sent at once is not taken with the turn", () => scratch(async ({ inst, run, tmp, file }) => {
  // A thread whose worker is this process, so that no worker is started for it: the test makes the worker's writes.
  const thread = insertNode({ id: "t_window", run_id: run, kind: "thread", target: "codex", mode: "read", depth: 1, task: "consult", cwd: tmp, status: "done" });
  db().prepare("UPDATE nodes SET worker_pid = ?, worker_start = ? WHERE id = ?").run(process.pid, procStart(process.pid), thread.id);
  const worker = connection(file);
  let returned = false;
  try {
    const asking = ask(inst, { thread_id: thread.id, message: "first question" }).then((r) => ((returned = true), r));
    let turnId = 0;
    await until(() => Boolean(turnId = (worker.prepare("SELECT id FROM turns WHERE node_id = ? AND status = 'queued'").get(thread.id) as { id: number } | undefined)?.id ?? 0), 10000, "the question to be queued");
    const turn = getTurn(turnId)!;
    worker.prepare("UPDATE turns SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), turnId);
    worker.prepare("UPDATE nodes SET status = 'running' WHERE id = ?").run(thread.id);
    // As runSessionTurn records the turn as over once its agent has ended: the thread is still running.
    worker.prepare("UPDATE turns SET status = 'failed', error = ?, ended_at = ? WHERE id = ?").run(failed.error, Date.now(), turnId);
    // Several of the waiting call's looks, each woken by that commit or by its own interval.
    await sleep(1000);
    assert.equal(returned, false, "ask returned the turn's end while its thread was still running");
    finishTurn(getNode(thread.id)!, turn, failed, runConfig(run));
    const first = await asking;
    assert.match(String(first.error), /the agent failed/, JSON.stringify(first));
    assert.equal(getNode(thread.id)!.status, "failed");
    // A follow-up sent at once puts the settled thread back in the queue; it is not queued behind the
    // failed turn, which would have dropped it.
    const stop = new AbortController();
    const following = ask(inst, { thread_id: thread.id, message: "follow-up" }, { signal: stop.signal });
    await until(() => db().prepare("SELECT COUNT(*) AS c FROM turns WHERE node_id = ?").get(thread.id)!.c === 2, 10000, "the follow-up to be queued");
    assert.equal(getNode(thread.id)!.status, "queued");
    assert.equal(db().prepare("SELECT status FROM turns WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(thread.id)!.status, "queued");
    stop.abort();
    await following;
  } finally {
    worker.close();
  }
}));

test("turn end: a worker whose start time ps cannot read for a moment is not taken for gone, so ask still waits for the turn's end to be recorded", (t) => scratch(async ({ inst, run, tmp, file }) => {
  const thread = insertNode({ id: "t_unreadable", run_id: run, kind: "thread", target: "codex", mode: "read", depth: 1, task: "consult", cwd: tmp, status: "done" });
  db().prepare("UPDATE nodes SET worker_pid = ?, worker_start = ? WHERE id = ?").run(process.pid, procStart(process.pid, { fresh: true }), thread.id);
  // ps fails to read a start time while this is set (a fork that fails with EAGAIN on a loaded machine, say).
  let unreadable = false;
  const original = childProcess.spawnSync;
  const failing = t.mock.method(childProcess, "spawnSync", ((command, args, opts) => unreadable && command === "/bin/ps" && args[1] === "lstart="
    ? { status: null, stdout: "", stderr: "", pid: 0, output: [], signal: null, error: Object.assign(new Error("spawnSync /bin/ps EAGAIN"), { code: "EAGAIN" }) }
    : original(command, args, opts)) as typeof original);
  syncBuiltinESMExports();
  const worker = connection(file);
  let returned = false;
  try {
    const asking = ask(inst, { thread_id: thread.id, message: "first question" }).then((r) => ((returned = true), r));
    let turnId = 0;
    await until(() => Boolean(turnId = (worker.prepare("SELECT id FROM turns WHERE node_id = ? AND status = 'queued'").get(thread.id) as { id: number } | undefined)?.id ?? 0), 10000, "the question to be queued");
    const turn = getTurn(turnId)!;
    worker.prepare("UPDATE turns SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), turnId);
    worker.prepare("UPDATE nodes SET status = 'running' WHERE id = ?").run(thread.id);
    worker.prepare("UPDATE turns SET status = 'failed', error = ?, ended_at = ? WHERE id = ?").run(failed.error, Date.now(), turnId);
    // While the worker records the turn's end, ps cannot say when the worker started, and nothing
    // read before is cached: relay's ordinary check cannot vouch for a worker that is still there.
    unreadable = true;
    assert.equal(procStart(process.pid, { fresh: true }), null);
    assert.equal(workerLive(getNode(thread.id)!), false);
    await sleep(1000);
    assert.equal(returned, false, "ask returned the turn's end while its thread was still running, its worker taken for gone");
    finishTurn(getNode(thread.id)!, turn, failed, runConfig(run));
    const first = await asking;
    assert.match(String(first.error), /the agent failed/, JSON.stringify(first));
    assert.equal(getNode(thread.id)!.status, "failed");
    // So a follow-up sent at once is not dropped with the failed turn.
    const stop = new AbortController();
    const following = ask(inst, { thread_id: thread.id, message: "follow-up" }, { signal: stop.signal });
    await until(() => db().prepare("SELECT COUNT(*) AS c FROM turns WHERE node_id = ?").get(thread.id)!.c === 2, 10000, "the follow-up to be queued");
    assert.equal(db().prepare("SELECT status FROM turns WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(thread.id)!.status, "queued");
    stop.abort();
    await following;
  } finally {
    worker.close();
    failing.mock.restore();
    syncBuiltinESMExports();
    procStart(process.pid, { fresh: true });
  }
}));

test("turn end: a turn whose end has been recorded stays settled for its waiters through every state of the session's next turn", () => scratch(async ({ run, tmp }) => {
  const thread = insertNode({ id: "t_next", run_id: run, kind: "thread", target: "codex", mode: "read", depth: 1, task: "consult", cwd: tmp, status: "running" });
  db().prepare("UPDATE nodes SET worker_pid = ?, worker_start = ? WHERE id = ?").run(process.pid, procStart(process.pid, { fresh: true }), thread.id);
  const ok = { status: "ok" as const, finalMessage: "", exitCode: 0, timedOut: false, warnings: [], finalPath: null };
  // A runs; B is queued behind it meanwhile; A's agent ends.
  const a = insertTurn(thread.id, "ask", "A", "read");
  updateTurn(a, { status: "running", started_at: Date.now() - 50 });
  const b = insertTurn(thread.id, "ask", "B", "read");
  updateTurn(a, { status: "done", reply: "A's reply", ended_at: Date.now() });
  assert.equal(turnSettled(getTurn(a)), false, "not before the worker has recorded A's end");
  // A wait on A ends at once in each state; one that did not would run to its limit and say false.
  const settled = async (state: string) => {
    assert.equal(turnSettled(getTurn(a)), true, `A settled while B is ${state}`);
    assert.equal(await waitUntil(() => turnSettled(getTurn(a)), { ms: 2000, lender: null }), true, `a wait on A while B is ${state}`);
  };
  finishTurn(getNode(thread.id)!, getTurn(a)!, { ...ok, finalMessage: "A's reply" }, runConfig(run));
  await settled("queued");
  // The worker takes B: the session shows as queued until B holds a slot (worker.ts), then running (runSessionTurn).
  db().prepare("UPDATE nodes SET status = 'queued', ended_at = NULL WHERE id = ? AND status != 'cancelled'").run(thread.id);
  await settled("waiting for a slot");
  updateTurn(b, { status: "running", started_at: Date.now() });
  updateNode(thread.id, { status: "running" });
  await settled("running");
  updateTurn(b, { status: "done", reply: "B's reply", ended_at: Date.now() });
  assert.equal(turnSettled(getTurn(b)), false, "B is not settled before its own end is recorded");
  await settled("over, its end not yet recorded");
  finishTurn(getNode(thread.id)!, getTurn(b)!, { ...ok, finalMessage: "B's reply" }, runConfig(run));
  await settled("recorded");
  assert.equal(getNode(thread.id)!.status, "done");
}));

test("turn end: reap records a lost session and its turn's end together, so another server records its event once", () => scratch(async ({ run, tmp }) => {
  // A session whose worker was claimed and never started: reap writes it off.
  const thread = insertNode({ id: "t_lost", run_id: run, kind: "thread", target: "codex", mode: "read", depth: 1, task: "consult", cwd: tmp, status: "running" });
  const turn = insertTurn(thread.id, "ask", "question", "read");
  updateTurn(turn, { status: "running", started_at: Date.now() });
  db().prepare("UPDATE nodes SET worker_pid = -1, worker_claimed_at = 0 WHERE id = ?").run(thread.id);
  // Another root server, in a process of its own, records events while reap writes: it is ready
  // (its registry open) before reap starts, and records once it is told to.
  const signals = path.join(tmp, "observer");
  fs.mkdirSync(signals);
  const [ready, go, seen] = ["ready", "go", "seen"].map((f) => path.join(signals, f));
  const dist = (m: string) => new URL(`../dist/core/${m}.js`, import.meta.url).href;
  const observer = childProcess.spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    const { db } = await import(${JSON.stringify(dist("db"))});
    const { recordEvents } = await import(${JSON.stringify(dist("events"))});
    db();
    fs.writeFileSync(${JSON.stringify(ready)}, "");
    while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 5));
    recordEvents(new Map([[${JSON.stringify(run)}, 0]]), () => false);
    const node = db().prepare("SELECT status FROM nodes WHERE id = ?").get(${JSON.stringify(thread.id)}).status;
    const turn = db().prepare("SELECT status FROM turns WHERE id = ?").get(${turn}).status;
    fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ node, turn }));
  `], { env: process.env, stdio: ["ignore", "ignore", "inherit"] });
  const exited = new Promise((r) => observer.on("exit", r));
  try {
    await until(() => fs.existsSync(ready), 20000, "the other server to open the registry");
    // Just after reap's write of the lost session returns, the other server records events.
    const d = db();
    const prepare = d.prepare.bind(d);
    let observed = false;
    d.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (!sql.startsWith("UPDATE nodes SET status = 'lost'")) return statement;
      const run_ = statement.run.bind(statement);
      statement.run = ((...args: unknown[]) => {
        const r = run_(...(args as never[]));
        fs.writeFileSync(go, "");
        const until_ = Date.now() + 20000;
        while (!fs.existsSync(seen) && Date.now() < until_) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        observed = true;
        return r;
      }) as typeof statement.run;
      return statement;
    }) as typeof d.prepare;
    try {
      reap(run);
    } finally {
      d.prepare = prepare;
    }
    assert.equal(observed, true, "reap wrote the session off");
    const between = JSON.parse(fs.readFileSync(seen, "utf8"));
    assert.ok(["running/running", "lost/failed"].includes(`${between.node}/${between.turn}`), `the other server read the session ${between.node} with its turn ${between.turn}`);
    assert.equal(getNode(thread.id)!.status, "lost");
    assert.equal(getTurn(turn)!.status, "failed");
    recordEvents(new Map([[run, 0]]), () => false);
    const events = db().prepare("SELECT key FROM events WHERE subject = ?").all(thread.id) as { key: string }[];
    assert.deepEqual(events.map((e) => e.key), [`settled:${thread.id}:turn:${turn}`]);
  } finally {
    await exited;
  }
}));
