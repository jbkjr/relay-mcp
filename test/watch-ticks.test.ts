// The root server's watch skips its look at the registry on a tick when nothing it reads has
// changed. Each kind of change must still be noticed on the next tick: another process's write,
// this process's own, the session's own state (a wait ending, a new host view), and a question
// whose asker has died, which is written nowhere.
import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { closeDbForTests, createRun, db, insertNode, insertTurn, newId } from "../dist/core/db.js";
import { withDefaults } from "../dist/core/config.js";
import { newInstance } from "../dist/core/caller.js";
import { watch } from "../dist/core/watch.js";
import { procStart } from "../dist/core/procs.js";

test("watch: a quiet tick skips the look, and the next change is noticed once, whoever made it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ticks-"));
  const old = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = path.join(dir, "registry");
  process.env.RELAY_CONFIG = path.join(dir, "config.json");
  t.after(() => {
    closeDbForTests();
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const inst = newInstance({ kind: "root" } as never, dir, "claude");
  const run = createRun(dir, withDefaults({ allow_temp_home: true }), inst.token);
  inst.runId = run;
  inst.since.set(run, 0);
  const posted: string[] = [];
  const noticing = { recognised: true, notice: (text: string) => void posted.push(text) };
  inst.host = noticing as never;
  const other = new DatabaseSync(path.join(process.env.RELAY_HOME, "relay.db"));
  t.after(() => other.close());
  other.exec("PRAGMA busy_timeout = 10000;");
  const job = (task: string) => {
    const n = insertNode({ id: newId("job"), run_id: run, kind: "job", mode: "read", depth: 1, task, cwd: dir, status: "running" });
    insertTurn(n.id, "root", task, "read", "running");
    return n.id;
  };
  const settle = (d: DatabaseSync, id: string) => {
    d.prepare("UPDATE turns SET status = 'done', ended_at = ? WHERE node_id = ?").run(Date.now(), id);
    d.prepare("UPDATE nodes SET status = 'done', ended_at = ? WHERE id = ?").run(Date.now(), id);
  };
  const about = (id: string) => posted.filter((p) => p.includes(`job ${id} finished`)).length;
  const a = job("a"), b = job("b"), c = job("c"), e = job("e");
  watch(inst);
  watch(inst);
  assert.deepEqual(posted, []);

  // Another process settles a job.
  settle(other, a);
  watch(inst);
  assert.equal(about(a), 1);
  watch(inst);
  watch(inst);
  assert.equal(about(a), 1, "posted once");

  // This process settles one, through its own connection.
  settle(db(), b);
  watch(inst);
  assert.equal(about(b), 1);

  // A call of the session waits on c: c's news goes into that call's result, not a notice. When the
  // wait ends without its result being delivered, nothing in the registry changes, and the notice
  // goes out on the next tick.
  inst.waiting.set(1, { runId: run, items: new Set([c]) });
  settle(other, c);
  watch(inst);
  assert.equal(about(c), 0);
  inst.waiting.delete(1);
  watch(inst);
  assert.equal(about(c), 1);

  // The host view is replaced (a host profile read after start): a notice withheld for want of a
  // way to post it goes out once there is one.
  inst.host = { recognised: true } as never;
  settle(other, e);
  watch(inst);
  assert.equal(about(e), 0);
  inst.host = noticing as never;
  watch(inst);
  assert.equal(about(e), 1);

  // A pending request of the run is being asked by another relay server: no approval event while
  // it lives. When it dies, which nothing writes down, the request is handed to the agent.
  const asker = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { asker.kill("SIGKILL"); } catch { /* gone */ } });
  const start = await (async () => {
    for (let i = 0; i < 100; i++) {
      const s = procStart(asker.pid!, { fresh: true });
      if (s) return s;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("no start time for the asker");
  })();
  const asked = job("asking");
  other.prepare("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES ('q_0000000a', ?, ?, 'path', 'wants', 'pending', ?)").run(run, asked, Date.now());
  other.prepare("INSERT INTO elicitations (request_id, token, pid, pid_start, asked_at) VALUES ('q_0000000a', 'other-server', ?, ?, ?)").run(asker.pid, start, Date.now());
  watch(inst);
  watch(inst);
  const approval = () => posted.filter((p) => p.includes("needs approval q_0000000a")).length;
  assert.equal(approval(), 0, "not handed over while its asker lives");
  const gone = new Promise((r) => asker.once("exit", r));
  asker.kill("SIGKILL");
  await gone;
  // procStart keeps a start time for 2 s; the asker's death shows by its pid at once.
  watch(inst);
  assert.equal(approval(), 1, "handed to the agent once its asker is gone");
  watch(inst);
  assert.equal(approval(), 1);
});

test("watch: the person route's heartbeat is renewed about once a second whatever the tick, and withdrawn at once on a demotion", async (t) => {
  const { owningRootBinding } = await import("../dist/core/escalation-policy.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-beat-"));
  const old = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  const realNow = Date.now;
  process.env.RELAY_HOME = path.join(dir, "registry");
  process.env.RELAY_CONFIG = path.join(dir, "config.json");
  t.after(() => {
    Date.now = realNow;
    closeDbForTests();
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const inst = newInstance({ kind: "root" } as never, dir, "claude");
  const run = createRun(dir, withDefaults({ allow_temp_home: true }), inst.token);
  inst.runId = run;
  inst.since.set(run, 0);
  inst.host = { recognised: true, confirmTool: true } as never;
  const file = path.join(process.env.RELAY_HOME, "person-paths", `${owningRootBinding("", inst.token).session_identity}.json`);
  const expires = () => (JSON.parse(fs.readFileSync(file, "utf8")) as { expires_at: number }).expires_at;
  let clock = realNow();
  Date.now = () => clock;
  watch(inst);
  assert.equal(expires(), clock + 5000);
  const first = expires();
  // Ticks a third of a second apart, nothing changed: renewed once about a second has passed.
  for (const step of [333, 333]) {
    clock += step;
    watch(inst);
    assert.equal(expires(), first, "not rewritten on every tick");
  }
  clock += 334;
  watch(inst);
  assert.equal(expires(), clock + 5000, "renewed after a second");
  // The host's view changes: what it is qualified for no longer includes the person route.
  clock += 100;
  inst.host = { recognised: true, confirmTool: false } as never;
  watch(inst);
  assert.equal(fs.existsSync(file), false, "a demotion withdraws the heartbeat on the next tick");
});
