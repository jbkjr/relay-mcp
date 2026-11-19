import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { killGroup, scratchOnly } from "./helpers.ts";
import { relayHome, withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun, db, getNode, insertNode, insertTurn, reap, updateNode } from "../dist/core/db.js";
import {
  executorGroupOurs, executorRecords, executorsDir, forgetExecutor, liveExecutorRecords, nodeHasLiveExecutor, noteDescendants, noteSkillAssets, ownerMayLive, recordExecutor, stopNodeExecutorsNow, stopRecordedExecutorNow,
  sweepSurvivorsNow, taintExecutor, type ExecutorRecord,
} from "../dist/core/stage2-executors.js";
import { leaseTurnPorts, portHeld, rangePorts, releaseLeasesOf } from "../dist/confine/ports.js";
import { ensurePrivateRoot, privateStateRoot } from "../dist/confine/private-root.js";
import { privateTurnTemp } from "../dist/confine/turn.js";
import { procStart, type Proc } from "../dist/core/procs.js";
import { setSandboxCheckHelperForTests } from "../dist/confine/sbcheck.js";
import { newInstance } from "../dist/core/caller.js";
import { cancel } from "../dist/core/ops.js";
import { sweepTemps } from "../dist/core/retention.js";
import { sessionParams } from "../dist/core/params.js";
import { neverDigest } from "../dist/core/never-policy.js";

// The follow-up to WP-C (docs/codex-confinement-design.md §2.2 steps 14-15): an executor whose relay
// process died or was killed mid-turn is stopped by reap, cancel or the retention sweep, from its
// record in <relay home>/executors, and its ports are given back. Stand-in "executors" are plain
// sleeps in process groups of their own; the live cases with Codex are in stage2-executor-live.test.ts.

const darwin = process.platform === "darwin";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
};
const until = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 25) await sleep(25);
  return cond();
};
/** A pid nothing has now (a process that has exited and been reaped). */
const deadPid = () => {
  const r = spawnSync("/usr/bin/true");
  return r.pid!;
};
const DEAD_START = "Thu Jan 1 00:00:00 1970";

function fixture() {
  closeDbForTests();
  const home = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2x-"))));
  const previous = { ...process.env };
  process.env.RELAY_HOME = home;
  process.env.RELAY_CONFIG = path.join(home, "config.json");
  const cfg = withDefaults({ ask_user: "never", allow_temp_home: true, cancel_grace_ms: 200 });
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
  const inst = newInstance({ kind: "root" }, home, "codex");
  const run = createRun(home, cfg, inst.token);
  inst.runId = run;
  inst.since.set(run, 0);
  const procs: ChildProcess[] = [];
  const pids: number[] = [];
  const groups: number[] = [];
  return {
    home, inst, run, procs, pids, groups,
    node: (id: string, values: Record<string, unknown> = {}) => {
      const { worker_pid, worker_start, ...rest } = values;
      insertNode({ id, run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "s2", cwd: home, status: "running", ...rest });
      if (worker_pid !== undefined) updateNode(id, { worker_pid: worker_pid as number, worker_start: (worker_start ?? null) as string | null });
    },
    close() {
      for (const g of groups) killGroup(g);
      for (const p of [...procs.map((c) => c.pid!), ...pids]) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
      closeDbForTests();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * A stand-in executor, orphaned as one whose relay process died is (its parent launchd, which reaps
 * it at once): a session and group leader (sleep) with one member of its group (another sleep).
 */
async function standInExecutor(f: ReturnType<typeof fixture>): Promise<{ pid: number; start: string; member: number }> {
  const file = path.join(f.home, `ex-${Math.random().toString(16).slice(2)}`);
  spawnSync("/usr/bin/perl", ["-MPOSIX", "-e", "exit 0 if fork; POSIX::setsid(); exec '/bin/sh', '-c', 'echo $$ > $0.l; /bin/sleep 4401 & echo $! > $0.m; exec /bin/sleep 4400', $ARGV[0]", file], { stdio: "ignore" });
  await until(() => fs.existsSync(`${file}.m`) && fs.readFileSync(`${file}.m`, "utf8").endsWith("\n"));
  const pid = Number(fs.readFileSync(`${file}.l`, "utf8")), member = Number(fs.readFileSync(`${file}.m`, "utf8"));
  f.groups.push(pid);
  f.pids.push(pid, member);
  await sleep(50);
  return { pid, start: procStart(pid, { fresh: true })!, member };
}

/** A process detached from everything (double fork, setsid), optionally under a sandbox profile; returns its pid. */
function detached(dir: string, tag: string, prefix: string[] = []): number {
  const pidFile = path.join(dir, `${tag}.pid`);
  spawnSync("/usr/bin/perl", ["-MPOSIX", "-e", "exit 0 if fork; POSIX::setsid(); open(F, '>', shift @ARGV); print F $$; close F; exec @ARGV", pidFile, ...prefix, "/bin/sleep", "4402"], { stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) execFileSync("/bin/sleep", ["0.05"]);
  return Number(fs.readFileSync(pidFile, "utf8"));
}

const forge = (file: string, patch: Partial<ExecutorRecord>) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...patch }));
const record = (f: ReturnType<typeof fixture>, ex: { pid: number; start: string }, o: { nodeId: string; tmpDir?: string; exec?: number; block?: number[] }) =>
  recordExecutor({ pid: ex.pid, start: ex.start, runId: f.run, nodeId: o.nodeId, turnId: 7, ports: { exec: o.exec ?? 61001, block: o.block ?? [61002, 61003] }, tmpDir: o.tmpDir ?? f.home });

/** A dead worker, a protected app group and a separate executor; all process inspection is simulated. `stubborn` pids survive SIGKILL. */
function refusedExecutorFixture(t: TestContext, o: { stubborn?: number[] } = {}) {
  closeDbForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reap-executor-refusal-"));
  const saved = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = home; process.env.RELAY_CONFIG = path.join(home, "config.json");
  const start = "Thu Jan 1 00:00:00 1970", app = 61001, executor = 62001, descendant = 62002, dead = 63999;
  const living = new Set([process.pid, app, app + 1, executor, descendant]);
  const signals: [number, string | number][] = [];
  let protectedGroup = app;
  const stubborn = new Set(o.stubborn ?? []);
  t.mock.method(process, "kill", ((pid, sig) => {
    if (!living.has(Math.abs(pid))) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (sig !== 0) { signals.push([pid, sig]); if (sig === "SIGKILL" && !stubborn.has(Math.abs(pid))) living.delete(Math.abs(pid)); }
    return true;
  }) as typeof process.kill);
  t.mock.method(childProcess, "spawnSync", ((_cmd, args) => {
    if (args[1] === "pid=,ppid=,pgid=") return { status: 0, stdout: `${process.pid} ${protectedGroup} 61003\n${protectedGroup} 1 ${protectedGroup}\n` };
    if (args.includes("lstart=")) return living.has(Number(args.at(-1))) ? { status: 0, stdout: start } : { status: 1, stdout: "" };
    const pids = [app, app + 1, executor, descendant].filter(pid => living.has(pid));
    if (args.includes("pid=,stat=,lstart=")) return { status: 0, stdout: pids.map(pid => `${pid} S ${start}`).join("\n") };
    return { status: 0, stdout: pids.map(pid => `${pid} ${pid === descendant ? executor : pid === app + 1 ? app : 1} S ${start} fake-process`).join("\n") };
  }) as typeof childProcess.spawnSync);
  t.mock.method(process.stderr, "write", (() => true) as typeof process.stderr.write);
  syncBuiltinESMExports();
  procStart(process.pid, { fresh: true });
  const run = "run_refused_executor", node = "j_refused_executor";
  db().prepare("INSERT INTO runs (id, created_at, root_cwd, config_json) VALUES (?, ?, ?, ?)").run(run, Date.now(), home, JSON.stringify(withDefaults({ allow_temp_home: true })));
  insertNode({ id: node, run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "refusal", cwd: home, status: "running" });
  updateNode(node, { worker_pid: dead, worker_start: start, agent_pid: app, agent_pgid: app, agent_start: null });
  const turn = insertTurn(node, "test", "refusal", "write", "running");
  const ports = [61501, 61502, 61503];
  const file = recordExecutor({ pid: executor, start, runId: run, nodeId: node, turnId: turn, tmpDir: home, ports: { exec: ports[0], block: ports.slice(1) }, descendants: [{ pid: descendant, start }] });
  forge(file, { owner: { pid: dead, start } });
  fs.mkdirSync(path.join(home, "ports"));
  const lease = (recordFile: string) => {
    for (const port of ports) fs.writeFileSync(path.join(home, "ports", `${port}.1`), `${dead} ${start}\n${executor} ${start}\nrecord ${recordFile}\n`);
  };
  lease(file);
  return {
    home, start, app, executor, descendant, dead, run, node, turn, ports, file, living, signals, lease,
    protect(group: number) { protectedGroup = group; },
    close() {
      t.mock.restoreAll(); syncBuiltinESMExports(); procStart(process.pid, { fresh: true }); closeDbForTests();
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("records: one file per executor, mode 0600 in a 0700 directory, written whole; descendants added; unreadable files left alone and said", () => {
  const f = fixture();
  try {
    const file = recordExecutor({ pid: 4242, start: "Wed Oct 28 10:00:00  2026", runId: f.run, nodeId: "j_rec", turnId: 3, ports: { exec: 61001, block: [61002] }, tmpDir: f.home });
    assert.equal(path.dirname(file), executorsDir());
    assert.equal(executorsDir(), path.join(relayHome(), "executors"));
    assert.equal(fs.statSync(executorsDir()).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(executorsDir()), [path.basename(file)], "no temp file left beside it");
    const [r] = executorRecords().records;
    assert.equal(r.file, file);
    assert.deepEqual({ ...r.record, createdAt: 0 }, {
      v: 1, pid: 4242, start: "Wed Oct 28 10:00:00 2026", pgid: 4242, owner: { pid: process.pid, start: procStart(process.pid)!.replace(/\s+/g, " ") },
      runId: f.run, nodeId: "j_rec", turnId: 3, ports: { exec: 61001, block: [61002] }, tmpDir: f.home, descendants: [], createdAt: 0,
    });
    noteDescendants(file, [{ pid: 5001, start: "a  b" }]);
    noteDescendants(file, [{ pid: 5001, start: "a b" }, { pid: 5002, start: "c" }]);
    assert.deepEqual(executorRecords().records[0].record.descendants, [{ pid: 5001, start: "a b" }, { pid: 5002, start: "c" }]);
    fs.writeFileSync(path.join(executorsDir(), "ex-1-0000abcd.json"), "{not json");
    fs.writeFileSync(path.join(executorsDir(), "unrelated.txt"), "x");
    const all = executorRecords();
    assert.equal(all.records.length, 1);
    assert.deepEqual(all.problems, [`${path.join(executorsDir(), "ex-1-0000abcd.json")} is not a readable executor record; left alone`]);
    forgetExecutor(file);
    noteDescendants(file, [{ pid: 5003, start: "d" }]);
    assert.ok(!fs.existsSync(file), "a record removed by teardown is not brought back");
  } finally {
    f.close();
  }
});

test("identity: the owner and the executor's group are judged by pid and start time; a reused pid is not theirs", { skip: !darwin }, async () => {
  const f = fixture();
  try {
    const ex = await standInExecutor(f);
    const file = record(f, ex, { nodeId: "j_id" });
    const r = () => executorRecords().records.find((x) => x.file === file)!.record;
    assert.equal(ownerMayLive(r()), true, "this process owns it");
    assert.equal(executorGroupOurs(r()), true);
    forge(file, { owner: { pid: deadPid(), start: DEAD_START } });
    assert.equal(ownerMayLive(r()), false, "an owner that has gone");
    forge(file, { owner: { pid: process.ppid, start: DEAD_START } });
    assert.equal(ownerMayLive(r()), false, "a live pid with another start time is not the owner");
    forge(file, { start: DEAD_START });
    assert.equal(executorGroupOurs(r()), false, "a live leader with another start time: the number was reused");
    forge(file, { start: ex.start });
    process.kill(ex.pid, "SIGKILL");
    assert.ok(await until(() => gone(ex.pid)));
    assert.equal(executorGroupOurs(r()), true, "leader gone, a member left: the group is still the executor's");
    process.kill(ex.member, "SIGKILL");
    assert.ok(await until(() => gone(ex.member)));
    assert.equal(executorGroupOurs(r()), false);
  } finally {
    f.close();
  }
});

test("ports: six-port leases quarantine the broker with the executor and release the whole lease after its record is gone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2-six-ports-"));
  const record = path.join(dir, "executor-record");
  const o = { range: { first: 61100, count: 12 }, dir, busy: () => new Set<number>() };
  // Deliberately dead identities; the record is what holds the lease. No process-info or listener is needed.
  const holder = { pid: 2147483646, start: "fixture-dead-executor" };
  const ports = (l: ReturnType<typeof leaseTurnPorts>) => [l.exec, l.broker, ...l.block];
  try {
    fs.writeFileSync(record, "quarantined executor\n");
    const a = leaseTurnPorts(o);
    a.hold!(holder.pid, holder.start, record);
    for (const p of ports(a)) {
      const file = path.join(dir, `${p}.1`);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^[^\n]+/, "2147483647"));
    }
    assert.deepEqual(releaseLeasesOf(holder, { dir }), [], "the executor record retains all six ports");
    const b = leaseTurnPorts(o);
    assert.ok(ports(b).every((p) => !ports(a).includes(p)));
    assert.throws(() => leaseTurnPorts(o), /no room/);
    fs.rmSync(record);
    assert.deepEqual(releaseLeasesOf(holder, { dir }), ports(a).sort((x, y) => x - y));
    for (const p of ports(a)) assert.ok(!portHeld(p, { dir }));
    for (const p of ports(b)) assert.ok(portHeld(p, { dir }), "the other six-port lease stays held");
    const c = leaseTurnPorts(o);
    assert.deepEqual(ports(c), ports(a), "the full released lease can be reused");
    c.release(); b.release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ports: an executor named on a lease keeps it after the leasing process dies; releaseLeasesOf gives it back once nobody holds it", { skip: !darwin }, async () => {
  const f = fixture();
  const dir = path.join(f.home, "ports");
  const range = { first: 61100, count: 12 };
  const o = { range, dir, busy: () => new Set<number>(), blockSize: 4 };
  try {
    const holder = spawn("/bin/sleep", ["4403"], { stdio: "ignore" });
    f.procs.push(holder);
    await sleep(50);
    const start = procStart(holder.pid!, { fresh: true })!;
    const a = leaseTurnPorts(o);
    a.hold!(holder.pid!, start);
    const mine = [a.exec, a.broker, ...a.block];
    const own = `${process.pid} ${procStart(process.pid)!.replace(/\s+/g, " ")}`;
    for (const p of mine) assert.equal(fs.readFileSync(path.join(dir, `${p}.1`), "utf8"), `${own}\n${holder.pid} ${start.replace(/\s+/g, " ")}\n`);
    // The leasing process dies: its line now names a dead pid.
    const dead = deadPid();
    for (const p of mine) fs.writeFileSync(path.join(dir, `${p}.1`), fs.readFileSync(path.join(dir, `${p}.1`), "utf8").replace(own, String(dead)));
    assert.deepEqual(releaseLeasesOf({ pid: holder.pid!, start: DEAD_START }, { dir }), [], "a holder named with another start time releases nothing");
    const b = leaseTurnPorts(o);
    assert.ok([b.exec, b.broker, ...b.block].every((p) => !mine.includes(p)), "the executor's and broker's ports are not leased again while it lives");
    assert.throws(() => leaseTurnPorts(o), /no room/);
    assert.deepEqual(releaseLeasesOf({ pid: holder.pid!, start }, { dir }), [], "nothing is given back while the holder still runs");
    holder.kill("SIGKILL");
    assert.ok(await until(() => gone(holder.pid!)));
    assert.deepEqual(releaseLeasesOf({ pid: holder.pid!, start }, { dir }), [...mine].sort((x, y) => x - y));
    for (const p of mine) assert.ok(!portHeld(p, { dir }), `${p} given back`);
    for (const p of [b.exec, b.broker, ...b.block]) assert.ok(portHeld(p, { dir }), "another lease is untouched");
    // A lease whose leasing process is alive stays that process's to release.
    const c = leaseTurnPorts(o);
    c.hold!(4, "x");
    assert.deepEqual(releaseLeasesOf({ pid: 4, start: "x" }, { dir }), []);
    c.release();
    b.release();
    for (const p of rangePorts(range)) assert.ok(!portHeld(p, { dir }));
  } finally {
    f.close();
  }
});

test("stopNodeExecutorsNow: an orphan's group, recorded descendants and detached processes in its sandbox stop; its lease goes; owned, other-node and reused-pid records are left", { skip: !darwin }, async () => {
  const f = fixture();
  try {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(f.home, "turn-")));
    const ex = await standInExecutor(f);
    const recorded = detached(f.home, "rec");
    const inSandbox = detached(f.home, "sbx", ["/usr/bin/sandbox-exec", "-p", `(version 1)(allow default)(deny file-write* (subpath "${f.home}"))(allow file-write* (subpath "${tmpDir}"))`]);
    const outside = detached(f.home, "out");
    f.pids.push(recorded, inSandbox, outside);
    const file = record(f, ex, { nodeId: "j_orphan", tmpDir, exec: 61201, block: [61202, 61203] });
    noteDescendants(file, [{ pid: recorded, start: procStart(recorded, { fresh: true })! }]);
    forge(file, { owner: { pid: deadPid(), start: DEAD_START } });
    // Its lease, from a relay process that has died, naming the executor.
    const ports = path.join(relayHome(), "ports");
    fs.mkdirSync(ports, { recursive: true });
    for (const p of [61201, 61202, 61203]) fs.writeFileSync(path.join(ports, `${p}.1`), `${deadPid()} ${DEAD_START}\n${ex.pid} ${ex.start}\n`);
    fs.writeFileSync(path.join(ports, "61204.1"), `${process.pid} ${procStart(process.pid)}\n`);
    for (const p of [61201, 61202, 61203, 61204]) assert.ok(portHeld(p), `${p} held before`);
    // Left alone: an executor this process still owns, one of another node, and a record whose pid now belongs to something else.
    const owned = await standInExecutor(f);
    const ownedFile = record(f, owned, { nodeId: "j_orphan" });
    const other = await standInExecutor(f);
    const otherFile = record(f, other, { nodeId: "j_other" });
    forge(otherFile, { owner: { pid: deadPid(), start: DEAD_START } });
    const reused = await standInExecutor(f);
    const reusedFile = record(f, reused, { nodeId: "j_orphan" });
    forge(reusedFile, { start: DEAD_START, owner: { pid: deadPid(), start: DEAD_START } });
    assert.equal(nodeHasLiveExecutor("j_orphan"), true);

    assert.equal(stopNodeExecutorsNow("j_orphan"), "");
    for (const p of [ex.pid, ex.member, recorded, inSandbox]) assert.ok(await until(() => gone(p)), `pid ${p} stopped`);
    assert.ok(!gone(outside), "a detached process outside the turn's sandbox is not the turn's");
    assert.ok(!fs.existsSync(file), "the orphan's record is removed");
    for (const p of [61201, 61202, 61203]) assert.ok(!portHeld(p), `its lease of ${p} is given back`);
    assert.ok(portHeld(61204), "nothing else");
    assert.ok(!gone(owned.pid) && !gone(owned.member) && fs.existsSync(ownedFile), "an executor whose owner lives is its owner's");
    assert.ok(!gone(other.pid) && fs.existsSync(otherFile), "another node's is not touched");
    assert.ok(!gone(reused.pid) && !gone(reused.member), "a pid with another start time is never signalled");
    assert.ok(!fs.existsSync(reusedFile), "its record is dropped: nothing of it is left to stop");
    assert.equal(nodeHasLiveExecutor("j_orphan"), true, "the owned one still runs");
    assert.equal(nodeHasLiveExecutor("j_nothing"), false);
  } finally {
    f.close();
  }
});

test("liveExecutorRecords: executors, or survivors teardown left, that still run; not a stopped one or a reused pid", { skip: !darwin }, async () => {
  const f = fixture();
  try {
    const running = await standInExecutor(f);
    record(f, running, { nodeId: "j_live1" });
    // Teardown left a survivor: the executor is gone, the record kept with what would not stop.
    const survivor = detached(f.home, "surv");
    f.pids.push(survivor);
    const left = recordExecutor({ pid: deadPid(), start: DEAD_START, runId: f.run, nodeId: "j_live2", turnId: 8, ports: { exec: 61301, block: [61302] }, tmpDir: f.home });
    noteDescendants(left, [{ pid: survivor, start: procStart(survivor, { fresh: true })! }]);
    // Nothing left: an executor and descendants that are gone, or whose pids now name other processes.
    recordExecutor({ pid: deadPid(), start: DEAD_START, runId: f.run, nodeId: "j_gone", turnId: 9, ports: { exec: 61401, block: [61402] }, tmpDir: f.home, descendants: [{ pid: process.pid, start: DEAD_START }] });
    assert.deepEqual(liveExecutorRecords().map((r) => r.nodeId).sort(), ["j_live1", "j_live2"]);
    process.kill(survivor, "SIGKILL");
    assert.ok(await until(() => gone(survivor)));
    assert.deepEqual(liveExecutorRecords().map((r) => r.nodeId), ["j_live1"]);
  } finally {
    f.close();
  }
});

test("reap: a node whose worker died loses its app server first and then its executor; cancel stops an executor whose worker it had to stop", { skip: !darwin }, async () => {
  const f = fixture();
  try {
    // reap: the worker is gone.
    const ex = await standInExecutor(f);
    f.node("j_reaped", { worker_pid: deadPid(), worker_start: DEAD_START });
    const file = record(f, ex, { nodeId: "j_reaped" });
    forge(file, { owner: { pid: deadPid(), start: DEAD_START } });
    reap(f.run);
    assert.equal(getNode("j_reaped")!.status, "lost");
    assert.match(getNode("j_reaped")!.error ?? "", /^worker process died\.$/);
    for (const p of [ex.pid, ex.member]) assert.ok(await until(() => gone(p)), `pid ${p} stopped by reap`);
    assert.ok(!fs.existsSync(file));

    // cancel: the worker is alive and owns the executor; cancel stops the worker (it ignores SIGTERM
    // here, as one stuck would), then the executor it left.
    const worker = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    f.procs.push(worker);
    await sleep(200);
    const ex2 = await standInExecutor(f);
    f.node("j_cancelled", { worker_pid: worker.pid, worker_start: procStart(worker.pid!, { fresh: true }) });
    const file2 = record(f, ex2, { nodeId: "j_cancelled" });
    forge(file2, { owner: { pid: worker.pid!, start: procStart(worker.pid!, { fresh: true })!.replace(/\s+/g, " ") } });
    // A turn a resume started meanwhile under a new, live worker is not touched.
    const ex3 = await standInExecutor(f);
    const file3 = record(f, ex3, { nodeId: "j_cancelled" });
    const out = await cancel(f.inst, { id: "j_cancelled" }) as Record<string, unknown>;
    assert.deepEqual(out.cancelled, ["j_cancelled"]);
    assert.equal(out.warning, undefined, JSON.stringify(out));
    assert.ok(gone(worker.pid!), "the worker was stopped");
    for (const p of [ex2.pid, ex2.member]) assert.ok(await until(() => gone(p)), `pid ${p} stopped by cancel`);
    assert.ok(!fs.existsSync(file2));
    assert.ok(!gone(ex3.pid) && fs.existsSync(file3), "an executor whose owner lives is left to it");
  } finally {
    f.close();
  }
});

for (const verified of [false, true]) test(`reap: an agent ancestor of its MCP server is ${verified ? "stopped with a verified leader" : "refused without a recorded leader identity"}`, async () => {
  const f = fixture();
  const resultFile = path.join(f.home, "ancestor-reap.json"), serverFile = path.join(f.home, "server.pid");
  const dbModule = path.resolve("dist/core/db.js"), procsModule = path.resolve("dist/core/procs.js");
  // The server gets a separate group so it can report the outcome after its ancestor is killed.
  // Registering it also tests the production rule that an agent's MCP servers are spared in procTree.
  const server = `
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    fs.writeFileSync(${JSON.stringify(serverFile)}, String(process.pid));
    try {
      const d = await import(${JSON.stringify(dbModule)});
      const p = await import(${JSON.stringify(procsModule)});
      const cfg = JSON.parse(fs.readFileSync(process.env.RELAY_CONFIG, 'utf8'));
      const run = d.createRun(process.env.RELAY_HOME, cfg, 'ancestor-reap-test');
      d.insertNode({ id: 'j_ancestor', run_id: run, kind: 'job', target: 'codex', mode: 'write', depth: 1, task: 'ancestor', cwd: process.env.RELAY_HOME, status: 'running' });
      d.registerSelf('server', 'j_ancestor');
      const agent = process.ppid;
      d.updateNode('j_ancestor', { worker_pid: spawnSync('/usr/bin/true').pid, worker_start: 'dead', agent_pid: agent, agent_pgid: agent, agent_start: ${verified ? "p.procStart(agent, { fresh: true })" : "null"} });
      d.reap(run);
      fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(d.getNode('j_ancestor')));
      d.closeDbForTests();
    } catch (e) { fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ failure: e.stack })); process.exitCode = 1; }
  `;
  const agent = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from 'node:child_process';
    spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(server)}], { detached: true, stdio: 'ignore' }).unref();
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: "ignore" });
  f.groups.push(agent.pid!);
  const agentExited = new Promise((resolve) => agent.once("exit", (_code, signal) => resolve(signal)));
  try {
    assert.ok(await until(() => fs.existsSync(resultFile), 15000), "the descendant server reports its reap");
    const node = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(node.failure, undefined, node.failure);
    assert.equal(node.status, "lost");
    if (verified) {
      assert.equal(await agentExited, "SIGKILL", "reaping reaches the verified ancestor agent's detached group");
      assert.equal(node.agent_pgid, null);
      assert.equal(node.error, "worker process died.");
    } else {
      assert.ok(!gone(agent.pid!), "the unverified ancestor survives");
      assert.equal(node.agent_pgid, agent.pid);
      assert.match(node.error, /cleanup refused.*without a verified leader/);
    }
  } finally {
    if (fs.existsSync(serverFile)) {
      const pid = Number(fs.readFileSync(serverFile, "utf8"));
      killGroup(pid);
      await until(() => gone(pid));
    }
    f.close();
    await agentExited;
  }
});

for (const identity of ["verified", "unknown", "wrong-pid", "reused"] as const) test(`reap: ancestor snapshot with ${identity} leader identity`, async (t) => {
  // A disposable registry with a wholly simulated process table: no real signals or subprocesses.
  // This also exercises the caller on hosts that cannot inspect the live process table.
  closeDbForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reap-guard-"));
  const saved = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = home; process.env.RELAY_CONFIG = path.join(home, "config.json");
  const start = "Thu Jan 1 00:00:00 1970", pgid = 61001, child = 61002, deadWorker = 61999;
  let currentStart = start, killed = false;
  const signals: [number, string | number][] = [];
  t.mock.method(process, "kill", ((pid, sig) => {
    if (sig === 0) {
      if (pid === deadWorker || (Math.abs(pid) === pgid && killed)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    }
    signals.push([pid, sig]); if (pid === -pgid) killed = true; return true;
  }) as typeof process.kill);
  const inspect = t.mock.method(childProcess, "spawnSync", ((_cmd, args) => {
    if (args[1] === "pid=,ppid=,pgid=") return { status: 0, stdout: `${process.pid} ${pgid} 61003\n${pgid} 1 ${pgid}\n` };
    if (args.includes("lstart=")) return { status: 0, stdout: Number(args.at(-1)) === pgid ? currentStart : start };
    return { status: 0, stdout: `${pgid} 1 S ${start} fake-agent\n${child} ${pgid} S ${start} fake-tool\n` };
  }) as typeof childProcess.spawnSync);
  t.mock.method(process.stderr, "write", (() => true) as typeof process.stderr.write);
  syncBuiltinESMExports();
  try {
    // Seed the registry directly: this case tests process cleanup, not host policy capture.
    procStart(process.pid, { fresh: true }); // Discard any unavailable identity cached by live cases.
    const run = "run_guard";
    db().prepare("INSERT INTO runs (id, created_at, root_cwd, config_json) VALUES (?, ?, ?, ?)").run(run, Date.now(), home, JSON.stringify(withDefaults({ allow_temp_home: true })));
    insertNode({ id: "j_guard", run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "guard", cwd: home, status: "running" });
    updateNode("j_guard", { worker_pid: deadWorker, worker_start: "dead", agent_pid: identity === "wrong-pid" ? 61004 : pgid, agent_pgid: pgid, agent_start: identity === "unknown" ? null : start });
    if (identity === "reused") {
      procStart(pgid, { fresh: true }); // Seed the cache with the recorded occupant.
      currentStart = "Fri Jan 2 00:00:00 1970";
    }
    reap(run);
    const node = getNode("j_guard")!;
    assert.equal(node.status, "lost");
    if (identity === "verified") {
      assert.deepEqual(signals, [[-pgid, "SIGKILL"], [child, "SIGKILL"]]);
      assert.equal(node.agent_pgid, null);
    } else {
      assert.deepEqual(signals, [], "an unverified or reused ancestor cannot authorize derived cleanup");
      assert.equal(node.agent_pgid, identity === "reused" ? null : pgid);
      if (identity !== "reused") assert.match(node.error!, /cleanup refused/);
    }
    if (identity === "unknown") {
      const { stopExecutor } = await import("../dist/backends/codex-env.js");
      const live = await stopExecutor({ pid: pgid, start } as import("../dist/backends/codex-env.js").Executor, { tmpDir: home, graceMs: 0 });
      assert.match(live.tainted!, /without a verified leader/);
      const file = recordExecutor({ pid: pgid, start, runId: run, nodeId: node.id, turnId: 1, tmpDir: home, ports: { exec: 61005, block: [61006] }, descendants: [{ pid: child, start }] });
      const stopped = stopRecordedExecutorNow(executorRecords().records[0]);
      assert.match(stopped.tainted!, /without a verified leader/);
      assert.deepEqual(stopped.swept, []);
      assert.deepEqual(stopped.released, []);
      assert.deepEqual(executorRecords().records[0].record.descendants, [{ pid: child, start }]);
      assert.ok(fs.existsSync(file), "refusal retains the executor record and its lease quarantine");
      assert.deepEqual(signals, [], "neither live teardown nor reaping kills descendants after refusal");
    }
  } finally {
    inspect.mock.restore(); syncBuiltinESMExports(); procStart(process.pid, { fresh: true }); closeDbForTests();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const route of ["ordinary", "reservation", "overlay"] as const) test(`reap: ${route} cleanup quarantines the executor and all leases when the app group is refused`, (t) => {
  const f = refusedExecutorFixture(t);
  try {
    if (route === "reservation") {
      const reservation = { v: 1, id: String(f.turn), nodeId: f.node, turnId: f.turn, launchClass: "stage2", state: "running", launching: true, owner: { pid: f.dead, start: f.start } };
      db().prepare("UPDATE runs SET config_json = json_set(config_json, '$.params_json.launch_reservations', json(?)) WHERE id = ?").run(JSON.stringify({ [reservation.id]: reservation }), f.run);
    } else if (route === "overlay") {
      // Recovery reads the captured origin and identity; no approval or launch occurs in this fixture.
      const request = { originConfinement: "relay" };
      const overlay = { v: 1, id: "ov_refused", runId: f.run, nodeId: f.node, originTurn: f.turn, state: "tainted", digest: neverDigest(request), request, budgetMs: 1000, owner: { pid: f.dead, start: f.start } };
      db().prepare("UPDATE runs SET config_json = json_set(config_json, '$.params_json.overlays', json(?)) WHERE id = ?").run(JSON.stringify({ [overlay.id]: overlay }), f.run);
    }
    // Also record an app-group descendant: no derived cleanup may reach a refused group.
    noteDescendants(f.file, [{ pid: f.app + 1, start: f.start }]);
    reap(f.run);
    const node = getNode(f.node)!;
    assert.equal(node.status, "lost");
    assert.equal(node.agent_pgid, f.app, "the refused app identity is retained");
    assert.match(node.error!, new RegExp(`Agent cleanup refused for group ${f.app}`));
    const rec = executorRecords().records[0];
    assert.equal(rec.file, f.file);
    assert.match(rec.record.tainted!, new RegExp(`^untraceable app-server cleanup: Agent cleanup refused for group ${f.app}`));
    assert.deepEqual(rec.record.descendants.map(p => p.pid), [f.descendant, f.app + 1]);
    assert.deepEqual(f.signals, [], "neither the executor nor any derived process is signalled after app refusal");
    for (const pid of [f.executor, f.descendant]) f.living.delete(pid);
    for (const port of f.ports) assert.ok(portHeld(port), `${port} stays quarantined by the record after its process holders disappear`);
    if (route !== "ordinary") {
      const cfg = JSON.parse((db().prepare("SELECT config_json FROM runs WHERE id = ?").get(f.run) as { config_json: string }).config_json);
      const cleanup = route === "reservation" ? cfg.params_json.launch_reservations[String(f.turn)] : cfg.params_json.overlays.ov_refused;
      assert.equal(cleanup.state, "tainted");
      assert.equal(cleanup.cleanup.clean, false);
      assert.match(cleanup.cleanup.problem, new RegExp(`cleanup refused for group ${f.app}`));
    }
  } finally { f.close(); }
});

test("reap: a lost worker's app group that may still run (cleanup unconfirmed) keeps its executor's leases quarantined, through a later clean sweep", (t) => {
  const f = refusedExecutorFixture(t, { stubborn: [61001] });
  try {
    f.protect(f.dead); // The app group is not an ancestor here: relay may signal it, and does, but it does not empty.
    reap(f.run);
    const node = getNode(f.node)!;
    assert.equal(node.status, "lost");
    assert.equal(node.agent_pgid, f.app, "the app identity is kept while it may still run");
    assert.match(node.error!, new RegExp(`An agent process \\(group ${f.app}\\) may still be running`));
    assert.ok(f.signals.some(([pid, sig]) => pid === -f.app && sig === "SIGKILL"), "the app group was signalled");
    assert.ok(f.signals.some(([pid, sig]) => pid === -f.executor && sig === "SIGKILL"), "the executor itself is still stopped, as on the reservation path");
    const rec = executorRecords().records[0];
    assert.equal(rec?.file, f.file, "the executor record is kept");
    assert.match(rec.record.tainted!, new RegExp(`^untraceable app-server cleanup: An agent process \\(group ${f.app}\\) may still be running`));
    // Every recorded holder gone and an executor-only sweep clean: only the app server's
    // uncertainty is left, and it must keep the leases, so that a reused executor port cannot be
    // handed to another turn while that app server may reconnect to it.
    for (const pid of [f.executor, f.descendant]) f.living.delete(pid);
    const retry = stopRecordedExecutorNow(executorRecords().records[0], undefined, () => ({ swept: [], survivors: [] }));
    assert.match(retry.tainted ?? "", /^untraceable app-server cleanup:/);
    assert.deepEqual(retry.released, []);
    assert.ok(fs.existsSync(f.file));
    for (const port of f.ports) assert.ok(portHeld(port), `${port} stays quarantined`);
  } finally { f.close(); }
});

test("cancel: an agent group that did not exit (not refused) keeps its executor's leases quarantined, through a later clean sweep", async (t) => {
  const f = refusedExecutorFixture(t, { stubborn: [61001] });
  try {
    f.protect(f.dead); // Relay may signal the app group, and does; it does not empty.
    // A live worker, so that the cancel's own reap does not write the job off as lost first.
    const worker = 61011;
    f.living.add(worker);
    updateNode(f.node, { worker_pid: worker, worker_start: f.start });
    db().prepare("UPDATE runs SET config_json = json_set(config_json, '$.cancel_grace_ms', 0) WHERE id = ?").run(f.run);
    const out = await cancel(null, { id: f.node }) as Record<string, any>;
    assert.deepEqual(out.cancelled, [f.node]);
    assert.match(out.warning, new RegExp(`process group\\(s\\) ${f.app} did not exit`));
    assert.ok(f.signals.some(([pid, sig]) => pid === -f.app && sig === "SIGKILL"), "the app group was signalled");
    assert.equal(getNode(f.node)!.agent_pgid, f.app, "the app identity is kept while it may still run");
    assert.ok(f.signals.some(([pid, sig]) => pid === -f.executor && sig === "SIGKILL"), "the executor itself is still stopped");
    const rec = executorRecords().records[0];
    assert.equal(rec?.file, f.file, "the executor record is kept");
    assert.equal(rec.record.tainted, `untraceable app-server cleanup: process group ${f.app} did not exit`);
    for (const pid of [f.executor, f.descendant]) f.living.delete(pid);
    const retry = stopRecordedExecutorNow(executorRecords().records[0], undefined, () => ({ swept: [], survivors: [] }));
    assert.match(retry.tainted ?? "", /^untraceable app-server cleanup:/);
    assert.deepEqual(retry.released, []);
    assert.ok(fs.existsSync(f.file));
    for (const port of f.ports) assert.ok(portHeld(port), `${port} stays quarantined`);
  } finally { f.close(); }
});

for (const caller of [false, true]) test(`stopRecordedExecutorNow: refusal keeps ${caller ? "the caller's quarantine over an older reason" : "an existing untraceable app-server marker"} through a later clean sweep`, (t) => {
  const f = refusedExecutorFixture(t);
  try {
    f.protect(f.executor);
    const existing = "untraceable app-server cleanup: app watch gap; leases must remain held";
    const quarantine = caller ? "untraceable app-server cleanup: caller's app group was refused" : undefined;
    const expected = quarantine ?? existing;
    taintExecutor(f.file, existing, []);
    const stopped = stopRecordedExecutorNow(executorRecords().records[0], quarantine);
    assert.equal(stopped.tainted, expected);
    assert.equal(executorRecords().records[0].record.tainted, expected);
    assert.deepEqual(stopped.released, []);
    assert.deepEqual(stopped.swept, []);
    assert.deepEqual(f.signals, []);
    f.living.delete(f.executor); f.living.delete(f.descendant);
    let sweeps = 0;
    const retry = stopRecordedExecutorNow(executorRecords().records[0], undefined, () => { sweeps++; return { swept: [], survivors: [] }; });
    assert.equal(sweeps, 1, "a later executor-only sweep is clean");
    assert.deepEqual(retry.survivors, []);
    assert.equal(retry.sweep, undefined);
    assert.equal(retry.tainted, expected, "a clean executor sweep cannot clear app-server uncertainty");
    assert.deepEqual(retry.released, []);
    assert.equal(executorRecords().records[0].record.tainted, expected);
    for (const port of f.ports) assert.ok(portHeld(port), `${port} remains held with every recorded process holder gone`);
  } finally { f.close(); }
});

test("stopRecordedExecutorNow: an allowed stop and clean sweep still forget the record and release every lease", (t) => {
  const f = refusedExecutorFixture(t);
  try {
    const stopped = stopRecordedExecutorNow(executorRecords().records[0], undefined, () => ({ swept: [], survivors: [] }));
    assert.equal(stopped.killed, true);
    assert.deepEqual(stopped.survivors, []);
    assert.equal(stopped.tainted, undefined);
    assert.deepEqual(stopped.released.sort(), f.ports);
    assert.ok(f.signals.some(([pid, sig]) => pid === -f.executor && sig === "SIGKILL"));
    assert.equal(fs.existsSync(f.file), false);
    for (const port of f.ports) assert.equal(portHeld(port), false);
  } finally { f.close(); }
});

for (const upstream of [false, true]) for (const caller of [false, true]) test(`stopExecutor: ${upstream ? "app-group" : "executor-group"} refusal preserves ${caller ? "the caller's quarantine" : "the record's untraceable app-server marker"}`, async (t) => {
  const f = refusedExecutorFixture(t);
  let unreferenced = 0;
  const child = Object.assign(new EventEmitter(), { pid: f.executor, stdout: new PassThrough(), stderr: new PassThrough(), unref() { unreferenced++; } });
  const { launchExecutor, stopExecutor } = await import("../dist/backends/codex-env.js");
  let ex: Awaited<ReturnType<typeof launchExecutor>> | undefined;
  try {
    forgetExecutor(f.file);
    // With an upstream refusal the executor's own group is safe to signal, but cleanup derived
    // from the refused app group must still leave it and all descendants alone.
    if (!upstream) f.protect(f.executor);
    t.mock.method(childProcess, "spawn", (() => {
      queueMicrotask(() => child.stdout.write(`ws://127.0.0.1:${f.ports[0]}\n`));
      return child;
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    const bin = "/fake/codex", hash = "test-hash";
    ex = await launchExecutor({
      spec: { cwd: f.home, markers: { runId: f.run, nodeId: f.node }, turnId: f.turn } as never,
      bin, hash, launch: { command: bin, args: [bin, "exec-server", "--listen", `ws://127.0.0.1:${f.ports[0]}`, "--ws-auth", "capability-token", "--ws-token-sha256", hash] } as never,
      ports: { exec: f.ports[0], block: f.ports.slice(1), hold: (_pid, _start, file) => f.lease(file!) } as never,
      probes: {} as never, env: {}, tmpDir: f.home, mechanism: { confined: () => true } as never,
    });
    const file = executorRecords().records[0].file;
    const existing = "untraceable app-server cleanup: recorded app watch gap";
    const quarantine = caller ? "untraceable app-server cleanup: caller's app watch gap" : undefined;
    taintExecutor(file, existing, []);
    const stopped = await stopExecutor(ex, { tmpDir: f.home, graceMs: 0, quarantine, ...(upstream ? { refused: `Agent cleanup refused for group ${f.app}`, appDescendants: [{ pid: f.app + 1, start: f.start }] } : {}) });
    ex = undefined; // The refusal path has stopped its watch and persistence timer.
    assert.equal(stopped.tainted, quarantine ?? existing);
    assert.equal(executorRecords().records[0].record.tainted, quarantine ?? existing);
    assert.ok(child.stdout.destroyed && child.stderr.destroyed, "observation pipes close even though refused processes stay alive");
    assert.equal(unreferenced, 1, "a refused executor cannot hold the worker open");
    if (upstream) assert.ok(executorRecords().records[0].record.descendants.some(p => p.pid === f.app + 1), "known app descendants remain recorded without attempting cleanup");
    assert.deepEqual(f.signals, [], "refusal does not fall through to descendant cleanup");
    f.living.delete(f.executor); f.living.delete(f.descendant);
    for (const port of f.ports) assert.ok(portHeld(port));
  } finally {
    if (ex) await stopExecutor(ex, { tmpDir: f.home, graceMs: 0 });
    child.stdout.destroy(); child.stderr.destroy();
    f.close();
  }
});

test("cancel: a refused group keeps its records while another group, its worker and executor are stopped", async (t) => {
  closeDbForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-guard-"));
  const saved = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = home; process.env.RELAY_CONFIG = path.join(home, "config.json");
  const start = "Thu Jan 1 00:00:00 1970", bad = 61001, good = 62001, executor = 63001;
  const badWorker = 61011, goodWorker = 62011;
  const living = new Set([bad, bad + 1, good, good + 1, badWorker, goodWorker, executor, executor + 1, 64001]);
  const signals: [number, string | number][] = [];
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock += 2000);
  t.mock.method(process, "kill", ((pid, sig) => {
    if (sig === 0) {
      if (pid !== process.pid && !living.has(Math.abs(pid))) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    }
    signals.push([pid, sig]);
    if (sig === "SIGKILL" || (pid === goodWorker && sig === "SIGTERM")) living.delete(Math.abs(pid));
    return true;
  }) as typeof process.kill);
  const inspect = t.mock.method(childProcess, "spawnSync", ((_cmd, args) => {
    if (args[1] === "pid=,ppid=,pgid=") return { status: 0, stdout: `${process.pid} ${bad} 61003\n${bad} 1 ${bad}\n` };
    if (args.includes("lstart=")) return { status: 0, stdout: start };
    return { status: 0, stdout: [bad, good, executor].flatMap(pid => [`${pid} 1 S ${start} fake-agent`, `${pid + 1} ${pid} S ${start} fake-child`]).join("\n") };
  }) as typeof childProcess.spawnSync);
  t.mock.method(process.stderr, "write", (() => true) as typeof process.stderr.write);
  syncBuiltinESMExports();
  try {
    procStart(process.pid, { fresh: true });
    const run = "run_mixed_cancel";
    db().prepare("INSERT INTO runs (id, created_at, root_cwd, config_json) VALUES (?, ?, ?, ?)").run(run, Date.now(), home, JSON.stringify(withDefaults({ allow_temp_home: true, cancel_grace_ms: 0 })));
    for (const [id, pgid, worker] of [["j_bad", bad, badWorker], ["j_good", good, goodWorker]] as const) {
      insertNode({ id, run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "cancel", cwd: home, status: "running" });
      updateNode(id, { agent_pid: pgid, agent_pgid: pgid, agent_start: pgid === bad ? null : start, worker_pid: worker, worker_start: start });
      insertTurn(id, "test", "cancel", "write", "running");
    }
    const badFile = recordExecutor({ pid: 64001, start, runId: run, nodeId: "j_bad", turnId: 1, tmpDir: home, ports: { exec: 61101, block: [61102] } });
    forge(badFile, { owner: { pid: 64011, start } });
    const goodFile = recordExecutor({ pid: executor, start, runId: run, nodeId: "j_good", turnId: 2, tmpDir: home, ports: { exec: 61201, block: [61202] }, descendants: [{ pid: executor + 1, start }] });
    forge(goodFile, { owner: { pid: goodWorker, start } });
    setSandboxCheckHelperForTests(path.join(home, "unavailable-sandbox-helper"));
    const out = await cancel(null, { id: run }) as Record<string, any>;
    assert.deepEqual(out.cancelled.sort(), ["j_bad", "j_good"]);
    assert.equal(out.killed_process_groups, 1);
    assert.match(out.warning, /refused process group 61001/);
    assert.ok(signals.some(([pid, sig]) => pid === goodWorker && sig === "SIGTERM"));
    for (const pid of [-good, good + 1, -executor, executor + 1]) assert.ok(signals.some(([p, sig]) => p === pid && sig === "SIGKILL"), `${pid} stopped`);
    assert.equal(signals.some(([pid]) => [-bad, bad, bad + 1, badWorker, -64001, 64001].includes(pid)), false);
    assert.equal(getNode("j_bad")!.agent_pgid, bad);
    assert.equal(getNode("j_bad")!.worker_pid, badWorker);
    assert.equal(getNode("j_good")!.agent_pgid, null);
    assert.equal(getNode("j_good")!.worker_pid, null);
    assert.ok(fs.existsSync(badFile), "refused node's executor record is untouched");
    assert.match(JSON.parse(fs.readFileSync(goodFile, "utf8")).tainted, /sandbox|helper/i, "the unaffected executor's sweep is attempted and its uncertainty retained");
  } finally {
    setSandboxCheckHelperForTests(null);
    inspect.mock.restore(); syncBuiltinESMExports(); procStart(process.pid, { fresh: true }); closeDbForTests();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("retention: an orphaned executor is stopped first; a turn's skill copy goes only once the registry names it for a turn that is over", { skip: !darwin }, async () => {
  const f = fixture();
  try {
    const ex = await standInExecutor(f);
    const file = record(f, ex, { nodeId: "j_crash" });
    forge(file, { owner: { pid: deadPid(), start: DEAD_START } });
    const root = ensurePrivateRoot(privateStateRoot());
    const ext = () => privateTurnTemp(root, "relay-ext-");
    f.node("j_over", { status: "lost" });
    const overTurn = insertTurn("j_over", "test", "x", "write", "failed");
    const over = ext();
    noteSkillAssets("j_over", overTurn, over);
    f.node("j_live", { worker_pid: process.pid, worker_start: procStart(process.pid) });
    const liveTurn = insertTurn("j_live", "test", "x", "write", "running");
    const live = ext();
    noteSkillAssets("j_live", liveTurn, live);
    const stray = ext();
    const r = await sweepTemps();
    for (const p of [ex.pid, ex.member]) assert.ok(await until(() => gone(p)), `pid ${p} stopped by the sweep`);
    assert.ok(r.removed.some((x) => x.startsWith(`the stage-2 executor ${ex.pid} of j_crash turn 7`)), JSON.stringify(r));
    assert.ok(!fs.existsSync(file));
    assert.ok(r.removed.includes(over), JSON.stringify(r));
    assert.ok(!fs.existsSync(over));
    assert.equal(sessionParams(getNode("j_over")!).ext_assets ?? null, null, "forgotten once removed");
    assert.ok(fs.existsSync(live), "a running turn's copy stays");
    assert.deepEqual(sessionParams(getNode("j_live")!).ext_assets, { [String(liveTurn)]: live });
    assert.ok(fs.existsSync(stray), "a copy no registry entry names (another relay home's, say) stays");
    assert.ok(r.problems.includes(`${stray} cannot be matched to a turn in the registry; left alone`), JSON.stringify(r.problems));
    for (const d of [live, stray]) fs.rmSync(d, { recursive: true, force: true });
  } finally {
    f.close();
  }
});

// Review r_0c11d860 C2, C3, C4, C5, C7, X3, X4: a sweep that fails or does not converge never lets
// teardown conclude; uncertainty taints the record and quarantines its lease.

/** A plain sleep of this test's, and its identity. */
async function sleeper(f: ReturnType<typeof fixture>, secs: string): Promise<Proc> {
  const c = spawn("/bin/sleep", [secs], { stdio: "ignore" });
  f.procs.push(c);
  await sleep(50);
  return { pid: c.pid!, start: procStart(c.pid!, { fresh: true })!.replace(/\s+/g, " ") };
}
const stat = (pid: number) => spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

test("sweepSurvivorsNow: each process found is frozen before the next look, all are killed once a look finds nothing new, and a last look must find nothing", { skip: !darwin }, async () => {
  const f = fixture();
  try {
    const a = await sleeper(f, "4501"), b = await sleeper(f, "4502");
    const seen: string[] = [];
    let n = 0;
    const r = sweepSurvivorsNow(f.home, {
      look: () => {
        n++;
        if (n === 2) seen.push(`a:${stat(a.pid)}`);
        if (n === 3) seen.push(`b:${stat(b.pid)}`);
        return n === 1 ? [a] : n <= 3 ? [a, b] : [];
      },
    });
    assert.deepEqual(r, { swept: [a, b], survivors: [] });
    assert.ok(/^T/.test(seen[0].slice(2)) && /^T/.test(seen[1].slice(2)), `stopped before the next look: ${seen}`);
    assert.equal(n, 4, "three looks to converge, then the last look after the kill");
    assert.ok(await until(() => gone(a.pid) && gone(b.pid)));
    // A last look that still finds something: a survivor.
    const c = await sleeper(f, "4503");
    const ghost = { pid: deadPid(), start: DEAD_START };
    let m = 0;
    const r2 = sweepSurvivorsNow(f.home, { look: () => (++m === 1 ? [c] : m === 2 ? [] : [ghost]) });
    assert.deepEqual(r2, { swept: [c], survivors: [ghost] });
  } finally {
    f.close();
  }
});

test("sweepSurvivorsNow: a look that fails, or no convergence within the cap, is a problem, never a clean sweep; what was frozen is still killed", { skip: !darwin }, async () => {
  const f = fixture();
  try {
    const a = await sleeper(f, "4504");
    let n = 0;
    const failed = sweepSurvivorsNow(f.home, { look: () => (++n === 1 ? [a] : "relay's sandbox_check helper failed: exit 1") });
    assert.equal(failed.problem, "relay's sandbox_check helper failed: exit 1");
    assert.deepEqual(failed.swept, [a]);
    assert.ok(await until(() => gone(a.pid)), "frozen, then killed all the same");
    assert.deepEqual(sweepSurvivorsNow(f.home, { look: () => "ps failed: exit 1" }), { swept: [], survivors: [], problem: "ps failed: exit 1" });
    // Something new at every look (a process that keeps forking): the cap is reached.
    let k = 0;
    const endless = sweepSurvivorsNow(f.home, { cap: 6, look: () => [{ pid: 900000 + ++k, start: DEAD_START }] });
    assert.equal(endless.problem, "the survivor sweep still found new processes after 6 looks");
    assert.equal(k, 6, "no last look once the sweep has a problem");
  } finally {
    f.close();
  }
});

test("sweepSurvivorsNow, for real: a turn's detached process is found by its sandbox even once the turn's directory has gone (made again, then removed)", { skip: !darwin }, async () => {
  const f = fixture();
  try {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(f.home, "turn-")));
    const pid = detached(f.home, "gone-dir", ["/usr/bin/sandbox-exec", "-p", `(version 1)(allow default)(deny file-write* (subpath "${f.home}"))(allow file-write* (subpath "${tmpDir}"))`]);
    f.pids.push(pid);
    fs.rmSync(tmpDir, { recursive: true });
    const r = sweepSurvivorsNow(tmpDir);
    assert.equal(r.problem, undefined, JSON.stringify(r));
    assert.deepEqual(r.swept.map((p) => p.pid), [pid]);
    assert.ok(await until(() => gone(pid)));
    assert.ok(!fs.existsSync(tmpDir), "the directory made for the look is removed again");
  } finally {
    f.close();
  }
});

test("stopNodeExecutorsNow without a working helper: the record is kept, tainted, its lease quarantined even with every holder gone; a later clean sweep lets both go", { skip: !darwin }, async () => {
  const f = fixture();
  try {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(f.home, "turn-")));
    const ex = await standInExecutor(f);
    const stray = detached(f.home, "stray", ["/usr/bin/sandbox-exec", "-p", `(version 1)(allow default)(deny file-write* (subpath "${f.home}"))(allow file-write* (subpath "${tmpDir}"))`]);
    f.pids.push(stray);
    const file = record(f, ex, { nodeId: "j_taint", tmpDir, exec: 61501, block: [61502] });
    forge(file, { owner: { pid: deadPid(), start: DEAD_START } });
    const ports = path.join(relayHome(), "ports");
    fs.mkdirSync(ports, { recursive: true });
    // A lease from a relay process that has died, naming the executor and its record.
    for (const p of [61501, 61502]) fs.writeFileSync(path.join(ports, `${p}.1`), `${deadPid()} ${DEAD_START}\n${ex.pid} ${ex.start}\nrecord ${file}\n`);
    setSandboxCheckHelperForTests(path.join(f.home, "no-helper"));
    try {
      assert.match(stopNodeExecutorsNow("j_taint"), /could not confirm that every process of a stage-2 executor stopped \(relay's sandbox_check helper .* is not there/);
    } finally {
      setSandboxCheckHelperForTests(null);
    }
    assert.ok(await until(() => gone(ex.pid) && gone(ex.member)), "the group and what relay recorded are stopped all the same");
    assert.ok(!gone(stray), "the detached process could not be found");
    const kept = executorRecords().records.find((r) => r.file === file)?.record;
    assert.match(kept?.tainted ?? "", /sandbox_check helper/);
    for (const p of [61501, 61502]) assert.ok(portHeld(p), `${p} quarantined: executor and leaser gone, the record holds it`);
    assert.deepEqual(liveExecutorRecords().map((r) => r.nodeId), ["j_taint"], "a tainted record counts as live: local mode stays refused");
    assert.equal(nodeHasLiveExecutor("j_taint"), true, "retention keeps the turn's directory");
    // The helper works again: the next sweep finds the stray, and only then lets the record and the lease go.
    assert.equal(stopNodeExecutorsNow("j_taint"), "");
    assert.ok(await until(() => gone(stray)));
    assert.ok(!fs.existsSync(file));
    for (const p of [61501, 61502]) assert.ok(!portHeld(p), `${p} given back`);
    assert.deepEqual(liveExecutorRecords(), []);
  } finally {
    setSandboxCheckHelperForTests(null);
    f.close();
  }
});

test("liveExecutorRecords and nodeHasLiveExecutor: an unreadable record refuses (throws; counts as live); recorded descendants and taint count", { skip: !darwin }, async () => {
  const f = fixture();
  try {
    const d = await sleeper(f, "4505");
    // The executor gone, a recorded descendant still running.
    const file = recordExecutor({ pid: deadPid(), start: DEAD_START, runId: f.run, nodeId: "j_desc", turnId: 1, ports: { exec: 61601, block: [61602] }, tmpDir: f.home });
    noteDescendants(file, [d]);
    assert.equal(nodeHasLiveExecutor("j_desc"), true, "descendants count (C7)");
    process.kill(d.pid, "SIGKILL");
    assert.ok(await until(() => gone(d.pid)));
    assert.equal(nodeHasLiveExecutor("j_desc"), false);
    taintExecutor(file, "a sweep that did not converge", []);
    assert.equal(nodeHasLiveExecutor("j_desc"), true, "taint counts");
    assert.deepEqual(liveExecutorRecords().map((r) => r.tainted), ["a sweep that did not converge"]);
    fs.writeFileSync(path.join(executorsDir(), "ex-2-0000abcd.json"), "{not a record");
    assert.throws(() => liveExecutorRecords(), /is not a readable executor record/, "local mode refuses on what it cannot read (C4)");
    assert.equal(nodeHasLiveExecutor("j_other"), true, "and retention keeps every turn's directory meanwhile");
  } finally {
    f.close();
  }
});

test("stage-2 executors: the note for an app-server quarantine sends the person to manual recovery, not a later sweep (review r_0372185e X3)", async () => {
  const { stoppedNote } = await import("../dist/core/stage2-executors.js");
  const held = stoppedNote([{ survivors: [], tainted: "untraceable app-server cleanup: process group 123 did not exit" }] as any);
  assert.match(held, /no later sweep releases them/);
  assert.match(held, /remove the record yourself/);
  assert.doesNotMatch(held, /until a later sweep does/);
  const retry = stoppedNote([{ survivors: [], tainted: "relay's sandbox_check helper is not there" }] as any);
  assert.match(retry, /until a later sweep does/);
  assert.doesNotMatch(retry, /remove the record yourself/);
  assert.equal(stoppedNote([{ survivors: [], tainted: undefined }] as any), "");
});

