import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { alive, killGroup, scratchOnly, until } from "./helpers.ts";

test("procs: authentication bypasses cached start times when a pid has been reused", async (t) => {
  const { procStart, sameProcess } = await import("../dist/core/procs.js");
  const start = procStart(process.pid);
  assert.ok(start);
  const original = childProcess.spawnSync;
  const replacement = t.mock.method(childProcess, "spawnSync", ((command, args, opts) => {
    if (command === "/bin/ps" && args[1] === "lstart=") return { status: 0, stdout: "Sun Oct 18 00:00:00 1998\n" };
    return original(command, args, opts);
  }) as typeof original);
  syncBuiltinESMExports();
  try {
    assert.equal(sameProcess(process.pid, start), true, "the ordinary cache still contains the earlier process identity");
    assert.equal(sameProcess(process.pid, start, { fresh: true }), false, "the authentication read sees the pid's replacement");
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
    procStart(process.pid, { fresh: true });
  }
});

test("procs: broker ancestry requires the pinned live harness and peer identities, rejecting pid reuse", async () => {
  const { inProcessTree, procStart } = await import("../dist/core/procs.js");
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  try {
    const root = { pid: process.pid, start: procStart(process.pid) };
    const peer = { pid: child.pid!, start: procStart(child.pid) };
    assert.ok(root.start && peer.start);
    assert.equal(inProcessTree(root, peer), true, "a live child belongs to the pinned harness");
    assert.equal(inProcessTree(root, root), true, "the launched harness itself can connect");
    assert.equal(inProcessTree({ ...root, start: "an earlier occupant of this pid" }, peer), false, "a reused harness pid cannot authorize its new children");
    assert.equal(inProcessTree(root, { ...peer, start: "an earlier occupant of this pid" }), false, "a reused connecting pid is refused");
    assert.equal(inProcessTree({ ...root, start: "" }, peer), false, "unknown start times do not fall back to pid-only identity");
  } finally {
    child.stdin!.end();
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
});

// What an agent started is found by parentage and stopped when its turn ends, except relay's own
// servers and workers, which belong to jobs of their own: they are spared because they are listed in
// the registry (relay_procs), read afresh at every look, with a command-line test as a second net.
// This pins the registry half on its own, so that moving the process helpers out of the registry
// (consolidation design R6, review C5) cannot quietly leave only the command-line net.

test("procs: a descendant registered as relay's own is spared because it is registered, also when it registers after the watch began", async () => {
  const home = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-procs-"))));
  process.env.RELAY_HOME = home;
  // The registry-aware ones: what spares relay's own processes is the registry, read at each look.
  const { db, relayProcs } = await import("../dist/core/db.js");
  const { watchProcess } = await import("../dist/backends/types.js");
  const { procStart, procTree, stopProcs } = await import("../dist/core/procs.js");
  const descendantProcs = (pid: number) => procTree(pid, relayProcs).procs;
  // An agent with two children of one command, which the command-line net does not match.
  const code = "const {spawn}=require('node:child_process'); for (let i = 0; i < 2; i++) spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'relay-procs-test-child'], { stdio: 'ignore' }); setInterval(()=>{},1000);";
  const agent = spawn(process.execPath, ["-e", code], { stdio: "ignore", detached: true });
  let children: number[] = [];
  try {
    await until(() => descendantProcs(agent.pid!).length === 2, 30000, "the agent's two children");
    const [kept, other] = descendantProcs(agent.pid!);
    children = [kept.pid, other.pid];
    const pids = (ps: { pid: number }[]) => ps.map((p) => p.pid).sort((a, b) => a - b);
    const register = (pid: number) => db().prepare("INSERT INTO relay_procs (pid, start, kind, node_id, created_at) VALUES (?, ?, 'worker', NULL, ?)").run(pid, procStart(pid), Date.now());

    // Neither is registered: both are the agent's.
    assert.deepEqual(pids(descendantProcs(agent.pid!)), pids([kept, other]));
    // The watch begins, and only then does one of them register: the watch's next look spares it.
    const watch = watchProcess(agent.pid!);
    register(kept.pid);
    assert.equal(watch.look(), true, "the agent is alive");
    watch.stop();
    assert.deepEqual(pids(watch.procs()), [other.pid], "the registered child is not among what the watch saw");
    assert.deepEqual(pids(descendantProcs(agent.pid!)), [other.pid], "nor among the agent's descendants now");

    // Stopping what the watch saw stops the other child only.
    assert.deepEqual(await stopProcs(watch.procs()), []);
    await until(() => !alive(other.pid), 20000, "the unregistered child to be stopped");
    assert.equal(alive(kept.pid), true, "the registered child is left alone");
  } finally {
    for (const pid of [...children, agent.pid!]) try { process.kill(pid, "SIGKILL"); } catch {}
    killGroup(agent.pid);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("procs: a group signal never reaches the group of relay or of a process that started it, and still reaches an agent's own group", async (t) => {
  const { sendGroupSignal } = await import("../dist/core/procs.js");
  const groupOf = (pid: number) => Number(childProcess.spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
  const written: string[] = [];
  const write = t.mock.method(process.stderr, "write", ((chunk: string) => (written.push(String(chunk)), true)) as typeof process.stderr.write);
  try {
    // This process's own group (the test runner's, and the shell's that started it): refused, and said so with the caller's stack.
    assert.throws(() => sendGroupSignal(groupOf(process.pid), "SIGKILL"), (e: NodeJS.ErrnoException) => e.code === "EPROTECTEDPGID" && /holds relay/.test(e.message));
    assert.match(written.join(""), /relay refused process group \d+[\s\S]*procs\.test\.ts/);
    // Numbers that cannot be a group relay started are refused quietly.
    for (const n of [0, 1, -5, Number.NaN]) assert.throws(() => sendGroupSignal(n, "SIGKILL"), (e: NodeJS.ErrnoException) => e.code === "EPROTECTEDPGID");
  } finally {
    write.mock.restore();
  }
  // A process in a group of its own (as relay's workers run) refuses the group of the process that started it.
  const procs = path.resolve("dist/core/procs.js");
  const probe = spawn(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(procs)}).then(({ sendGroupSignal }) => { try { sendGroupSignal(${groupOf(process.pid)}, "SIGTERM"); console.log("sent"); } catch (e) { console.log(e.code); } })`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  probe.stdout!.on("data", (b) => (out += b));
  await new Promise((r) => probe.on("exit", r));
  assert.equal(out.trim(), "EPROTECTEDPGID", "a detached worker refuses its starter's group");
  // An agent's own group (detached, as relay starts agents) is signalled.
  const agent = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  try {
    await until(() => alive(agent.pid), 5000, "the agent to start");
    const exited = new Promise((r) => agent.on("exit", (_code, sig) => r(sig)));
    sendGroupSignal(agent.pid!, "SIGKILL");
    assert.equal(await exited, "SIGKILL");
  } finally {
    killGroup(agent.pid);
  }
});

// drainGroup and stopProcs look often and soon rather than every 50 ms; they must still return only
// once every member is gone, a member that outlives the leader and a leader not yet reaped included.
test("procs: drainGroup returns only once the whole group is gone, and stopProcs once the noted processes are", async () => {
  const { drainGroup, groupAlive, procTree, stopProcs } = await import("../dist/core/procs.js");
  // A leader of its own group whose child stays in that group, and a detached grandchild that leaves it.
  const code = "const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\",()=>{}); setInterval(()=>{},1000)'], { stdio: 'ignore' }); spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true }); setInterval(()=>{},1000);";
  const leader = spawn(process.execPath, ["-e", code], { stdio: "ignore", detached: true });
  let tree: { pid: number; start: string }[] = [];
  try {
    await until(() => procTree(leader.pid!, () => new Map()).procs.length === 2, 30000, "the leader's two children");
    tree = procTree(leader.pid!, () => new Map()).procs;
    assert.equal(await drainGroup(leader.pid!), true);
    assert.equal(groupAlive(leader.pid), false, "no member of the group is left, the leader's child included");
    const outside = tree.filter((p) => alive(p.pid));
    assert.equal(outside.length, 1, "the detached grandchild is outside the group and still running");
    assert.deepEqual(await stopProcs(outside), []);
    assert.equal(alive(outside[0].pid), false, "stopProcs returned once the noted process was gone");
  } finally {
    for (const p of tree) try { process.kill(p.pid, "SIGKILL"); } catch {}
    killGroup(leader.pid);
  }
});

// procTree reads the table without command lines and then the command lines of the unregistered
// descendants alone. On a live tree it must find exactly what one full read finds: relay's own
// spared, by registration or by command line, with what they started, and everything else kept.
test("procs: procTree finds what one full read of the table, command lines included, finds", async () => {
  const { procTree } = await import("../dist/core/procs.js");
  // The look as it was: one read of the whole table, command lines included.
  const reference = (pid: number, own: Map<number, string>, net = true) => {
    const r = childProcess.spawnSync("/bin/ps", ["-axo", "pid=,ppid=,stat=,lstart=,command="], { encoding: "utf8", maxBuffer: 32 << 20, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
    const kids = new Map<number, { pid: number; start: string; command: string }[]>();
    for (const line of r.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
      if (m) kids.set(Number(m[2]), [...(kids.get(Number(m[2])) ?? []), { pid: Number(m[1]), start: m[4].replace(/\s+/g, " "), command: m[5] }]);
    }
    const procs: { pid: number; start: string }[] = [];
    const stack = [pid];
    while (stack.length) for (const k of kids.get(stack.pop()!) ?? []) {
      if (own.get(k.pid) === k.start || (net && /\/(cli\.js|bin\/relay) (mcp|worker)\b/.test(k.command))) continue;
      procs.push({ pid: k.pid, start: k.start });
      stack.push(k.pid);
    }
    return procs;
  };
  const dir = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-proctree-"))));
  // A relay worker by its command line alone (not registered), with a child of its own; a shell
  // with two children; and a child that will be registered.
  const cli = path.join(dir, "cli.js");
  fs.writeFileSync(cli, "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'under-relay'], { stdio: 'ignore' }); setInterval(()=>{},1000);");
  const code = `const {spawn}=require('node:child_process');
    spawn(process.execPath, [${JSON.stringify(cli)}, 'worker', 'n_1'], { stdio: 'ignore' });
    spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30; wait'], { stdio: 'ignore' });
    spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'to-register'], { stdio: 'ignore' });
    setInterval(()=>{},1000);`;
  const agent = spawn(process.execPath, ["-e", code], { stdio: "ignore", detached: true });
  let all: { pid: number; start: string }[] = [];
  try {
    await until(() => (all = reference(agent.pid!, new Map(), false)).length === 6, 30000, "the agent's six descendants");
    const commandOf = (pid: number) => childProcess.spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    const registered = all.find((p) => commandOf(p.pid).includes("to-register"))!;
    const own = new Map([[registered.pid, registered.start]]);
    const key = (ps: { pid: number; start: string }[]) => ps.map((p) => `${p.pid} ${p.start}`).sort();
    const tree = procTree(agent.pid!, () => own);
    assert.equal(tree.alive, true);
    assert.deepEqual(key(tree.procs), key(reference(agent.pid!, own)));
    assert.deepEqual(tree.procs.map((p) => commandOf(p.pid).trim().split(" ")[0]).sort(), ["/bin/sh", "sleep", "sleep"], "the shell and its two children; not relay's worker, what it started, or the registered child");
  } finally {
    for (const p of all) try { process.kill(p.pid, "SIGKILL"); } catch {}
    killGroup(agent.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("procs: a command line read after the table spares only the process the table showed", async (t) => {
  const { procTree } = await import("../dist/core/procs.js");
  const root = 62001, start = "Thu Jan 1 00:00:00 1970", later = "Fri Jan 2 00:00:00 1970";
  let table = "", detail = "", full: string | null = null, detailReads = 0, fullReads = 0, fail = false;
  t.mock.method(childProcess, "spawnSync", ((_command, args) => {
    if (args[1] === "pid=,ppid=,stat=,lstart=") return { status: 0, stdout: table };
    if (args[1] === "pid=,ppid=,stat=,lstart=,command=") {
      fullReads++;
      return full === null ? { status: null, error: new Error("spawnSync /bin/ps EAGAIN"), stdout: "" } : { status: 0, stdout: full };
    }
    if (args[1] !== "pid=,lstart=,command=") throw new Error(`unexpected ps ${args.join(" ")}`);
    detailReads++;
    if (fail) return { status: null, error: new Error("spawnSync /bin/ps EAGAIN"), stdout: "" };
    const want = new Set(args[3].split(","));
    const out = detail.split("\n").filter((l) => want.has(l.split(" ")[0])).join("\n");
    // As ps: status 1 and nothing printed when none of the pids is there.
    return out ? { status: 0, stdout: `${out}\n` } : { status: 1, stdout: "" };
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    const pids = () => procTree(root, () => new Map()).procs.map((p) => p.pid).sort();
    table = `${root} 1 S ${start}\n62002 ${root} S ${start}\n62003 62002 S ${start}\n`;
    // Still the process the table showed, and relay's worker by its command line: spared, with what it started.
    detail = `62002 ${start} node /x/dist/cli.js worker n_1\n62003 ${start} node -e child`;
    assert.deepEqual(pids(), []);
    // Its pid since given to a process of relay's: the one the table showed is not spared for it.
    detail = `62002 ${later} node /x/dist/cli.js worker n_1\n62003 ${start} node -e child`;
    assert.deepEqual(pids(), [62002, 62003]);
    // Gone before its command line was read: nothing spares it, as ps shows no command line for it.
    detail = `62003 ${start} node -e child`;
    assert.deepEqual(pids(), [62002, 62003]);
    // No descendant left to ask about: no read at all.
    detailReads = 0;
    table = `${root} 1 S ${start}\n`;
    assert.deepEqual(procTree(root, () => new Map()), { alive: true, procs: [] });
    assert.equal(detailReads, 0);
    // Many descendants are read in one list, with the same rule.
    table = `${root} 1 S ${start}\n${[...Array(8)].map((_, i) => `${62010 + i} ${root} S ${start}`).join("\n")}\n`;
    detail = [...Array(8)].map((_, i) => `${62010 + i} ${start} ${i === 3 ? "node /x/bin/relay mcp" : "sleep 30"}`).join("\n");
    assert.deepEqual(pids(), [62010, 62011, 62012, 62014, 62015, 62016, 62017]);
    assert.equal(detailReads, 1);
    assert.equal(fullReads, 0, "the whole table is read again only when the command lines cannot be read");
    // Command lines that cannot be read: the whole table is read once more, command lines included.
    // It gives command lines to what the first table showed, matched by pid and start time, and adds
    // what has been started under the agent since; it takes nothing away from what the first showed.
    fail = true;
    table = [
      `${root} 1 S ${start}`,
      `62030 ${root} S ${start}`, // still there, not relay's
      `62031 ${root} S ${start}`, // relay's worker, by the command line the second read gives it
      `62032 62031 S ${start}`, // what that worker started
      `62033 ${root} S ${start}`, // gone by the second read: its command line cannot be told, so it is kept
      `62034 ${root} S ${start}`, // its pid since given to a process of relay's: not spared for it
      `62036 ${root} S ${start}`, // cut loose by the second read, handed to launchd
      `62037 62036 S ${start}`, // and what it started
      `62038 ${root} S ${start}`, // registered between the two reads
    ].join("\n");
    full = [
      `${root} 1 S ${start} agent`,
      `62030 ${root} S ${start} sleep 30`,
      `62031 ${root} S ${start} node /x/dist/cli.js worker n_1`,
      `62032 62031 S ${start} child of relay's`,
      `62040 62031 S ${start} started by relay's since`,
      `62034 ${root} S ${later} node /x/bin/relay mcp`,
      `62036 1 S ${start} detached`,
      `62037 62036 S ${start} its child`,
      `62038 ${root} S ${start} node script`,
      `62041 ${root} S ${start} started since`,
    ].join("\n");
    let looks = 0;
    const registered = () => new Map(looks++ ? [[62038, start]] : []);
    const tree = procTree(root, registered);
    assert.equal(fullReads, 1);
    assert.equal(looks, 2, "relay's registered processes are read after each table");
    assert.equal(tree.alive, true);
    assert.deepEqual(tree.procs.map((p) => `${p.pid} ${p.start}`).sort(), [62030, 62033, 62034, 62036, 62037, 62041].map((p) => `${p} ${start}`));
    // And when that cannot be read either: nothing learned, as when the first table cannot be read.
    // Relay's own may be among the descendants with only the command-line net to spare them (one
    // that could not read its own start time could not register), so they are not all kept blind.
    full = null;
    assert.deepEqual(procTree(root, () => new Map()), { alive: false, procs: [] });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("procs: a descendant the first table showed is kept when its command line cannot be read and it has been handed to launchd by the second read", async (t) => {
  const { procTree } = await import("../dist/core/procs.js");
  const root = 62001, child = 62010, start = "Thu Jan 1 00:00:00 1970";
  const reads: string[] = [];
  t.mock.method(childProcess, "spawnSync", ((_command, args) => {
    reads.push(args[1]);
    if (args[1] === "pid=,ppid=,stat=,lstart=") return { status: 0, stdout: `${root} 1 S ${start}\n${child} ${root} S ${start}\n` };
    if (args[1] === "pid=,lstart=,command=") return { status: null, error: Object.assign(new Error("spawnSync /bin/ps EAGAIN"), { code: "EAGAIN" }), stdout: "" };
    // Between the reads the child's parent let go of it (a detached child whose shell exited).
    if (args[1] === "pid=,ppid=,stat=,lstart=,command=") return { status: 0, stdout: `${root} 1 S ${start} agent\n${child} 1 S ${start} detached-child\n` };
    throw new Error(`unexpected ps ${args.join(" ")}`);
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(procTree(root, () => new Map()), { alive: true, procs: [{ pid: child, start }] });
    assert.deepEqual(reads, ["pid=,ppid=,stat=,lstart=", "pid=,lstart=,command=", "pid=,ppid=,stat=,lstart=,command="]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("procs: when the descendants' command lines cannot be read, one full read of the table still finds a descendant outside the agent's group", async (t) => {
  const { procTree } = await import("../dist/core/procs.js");
  // An agent leading its own group, and a child it started detached, in a group of its own: one
  // that a kill of the agent's group misses, so only this look records it.
  const agent = spawn(process.execPath, ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'detached-descendant'], { stdio: 'ignore', detached: true }); console.log(c.pid); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  let child = 0;
  agent.stdout!.on("data", (b: Buffer) => { child ||= Number(String(b).trim()); });
  const real = childProcess.spawnSync;
  try {
    await until(() => child > 0, 30000, "the agent's detached child");
    const pgid = (pid: number) => Number(real("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
    assert.notEqual(pgid(child), pgid(agent.pid!), "the child is outside the agent's group");
    let detailReads = 0, fullReads = 0;
    t.mock.method(childProcess, "spawnSync", ((command, args, opts) => {
      if (command === "/bin/ps" && args[1] === "pid=,lstart=,command=") {
        detailReads++;
        return { status: null, error: Object.assign(new Error("spawnSync /bin/ps EAGAIN"), { code: "EAGAIN" }), stdout: "" };
      }
      if (command === "/bin/ps" && args[1] === "pid=,ppid=,stat=,lstart=,command=") fullReads++;
      return real(command, args, opts);
    }) as typeof real);
    syncBuiltinESMExports();
    let tree: { alive: boolean; procs: { pid: number }[] };
    try {
      tree = procTree(agent.pid!, () => new Map());
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual([detailReads, fullReads], [1, 1], "the command lines failed once, and the whole table was read once more");
    assert.equal(tree.alive, true);
    assert.deepEqual(tree.procs.map((p) => p.pid), [child]);
  } finally {
    if (child) try { process.kill(child, "SIGKILL"); } catch {}
    killGroup(agent.pid);
  }
});

// Mock every signal, including pid kills: a regression must fail an assertion, never kill the runner.
for (const caller of ["killGroupNow", "stopSupervised"] as const) {
  test(`procs: ${caller} rechecks an ancestor leader fresh immediately before signalling`, async (t) => {
    const { killGroupNow, stopSupervised } = await import("../dist/core/procs.js");
    const start = "Thu Jan 1 00:00:00 1970", pgid = 61001;
    let reads = 0;
    const signals: number[] = [];
    t.mock.method(process, "kill", ((pid, sig) => { if (sig !== 0) signals.push(pid); return true; }) as typeof process.kill);
    const inspect = t.mock.method(childProcess, "spawnSync", ((_command, args) => {
      if (args[1] === "pid=,ppid=,pgid=") return { status: 0, stdout: `${process.pid} ${pgid} 61003\n${pgid} 1 ${pgid}\n` };
      if (args.includes("lstart=")) return { status: 0, stdout: ++reads === 1 ? start : "Fri Jan 2 00:00:00 1970" };
      return { status: 0, stdout: `61002 ${pgid} S ${start} fake-child\n` };
    }) as typeof childProcess.spawnSync);
    t.mock.method(process.stderr, "write", (() => true) as typeof process.stderr.write);
    syncBuiltinESMExports();
    try {
      const refusal = (e: NodeJS.ErrnoException) => e.code === "EPROTECTEDPGID";
      if (caller === "killGroupNow") assert.throws(() => killGroupNow(pgid, () => new Map(), { pid: pgid, start }), refusal);
      else {
        const stopped = await stopSupervised({ workers: new Map(), groups: new Map([[pgid, start]]), unsupervised: new Set([pgid]), graceMs: 0, spared: () => new Map() });
        assert.match(stopped.refused.get(pgid)!, /without a verified leader/);
        assert.equal(stopped.stillOurs(pgid), true, "a refused target keeps its records");
      }
      assert.equal(reads, 2, "both the preflight and the signal must bypass procStart's cache");
      assert.deepEqual(signals, []);
    } finally { inspect.mock.restore(); syncBuiltinESMExports(); }
  });

  for (const phase of caller === "stopSupervised" ? ["preflight", "SIGINT", "SIGKILL"] : ["preflight", "SIGKILL"]) test(`procs: ${caller} abandons a refused target's descendant cleanup (${phase} refusal)`, async (t) => {
    const { killGroupNow, stopSupervised, isGroupSignalRefusal } = await import("../dist/core/procs.js");
    const start = "Thu Jan 1 00:00:00 1970", pgid = 61001, child = 61002;
    let ancestryReads = 0;
    let clock = 0;
    t.mock.method(Date, "now", () => clock += 2000); // Skip stopSupervised's grace period.
    const signals: [number, string | number][] = [];
    t.mock.method(process, "kill", ((pid, sig) => { if (sig !== 0) signals.push([pid, sig]); return true; }) as typeof process.kill);
    const inspect = t.mock.method(childProcess, "spawnSync", ((_command, args) => {
      if (args[1] === "pid=,ppid=,pgid=") {
        const protectedNow = phase === "preflight" || ++ancestryReads > 1;
        return { status: 0, stdout: `${process.pid} ${protectedNow ? pgid : 1} 61003\n${pgid} 1 ${pgid}\n` };
      }
      if (args.includes("lstart=")) return { status: 0, stdout: start };
      return { status: 0, stdout: `${pgid} 1 S ${start} fake-agent\n${child} ${pgid} S ${start} fake-child\n` };
    }) as typeof childProcess.spawnSync);
    t.mock.method(process.stderr, "write", (() => true) as typeof process.stderr.write);
    syncBuiltinESMExports();
    try {
      if (caller === "killGroupNow") assert.throws(() => killGroupNow(pgid, () => new Map()), isGroupSignalRefusal);
      else {
        const stopped = await stopSupervised({ workers: phase === "preflight" ? new Map([[61004, null]]) : new Map(), groupWorkers: new Map([[pgid, 61004]]), groups: new Map([[pgid, null]]), unsupervised: new Set(phase === "SIGKILL" ? [] : [pgid]), graceMs: 0, spared: () => new Map() });
        assert.match(stopped.refused.get(pgid)!, /without a verified leader/);
        assert.equal(stopped.stillOurs(pgid), true);
      }
      assert.deepEqual(signals, [], "neither group signals nor derived pid kills may follow refusal");
    } finally {
      inspect.mock.restore();
      syncBuiltinESMExports();
    }
  });

  test(`procs: ${caller} still kills detached descendants when the group is merely gone`, async (t) => {
    const { killGroupNow, stopSupervised } = await import("../dist/core/procs.js");
    const start = "Thu Jan 1 00:00:00 1970", pgid = 61001, child = 61002;
    const signals: [number, string | number][] = [];
    t.mock.method(process, "kill", ((pid, sig) => {
      if (sig !== 0) signals.push([pid, sig]);
      if (pid === -pgid) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    }) as typeof process.kill);
    const inspect = t.mock.method(childProcess, "spawnSync", ((_command, args) => {
      if (args[1] === "pid=,ppid=,pgid=") return { status: 0, stdout: `${process.pid} 1 61003\n` };
      if (args.includes("lstart=")) return { status: 0, stdout: start };
      return { status: 0, stdout: `${child} ${pgid} S ${start} fake-detached-child\n` };
    }) as typeof childProcess.spawnSync);
    syncBuiltinESMExports();
    try {
      if (caller === "killGroupNow") assert.equal(killGroupNow(pgid, () => new Map()), true);
      else await stopSupervised({ workers: new Map(), groups: new Map([[pgid, null]]), unsupervised: new Set([pgid]), graceMs: 0, spared: () => new Map() });
      assert.ok(signals.some(([pid, sig]) => pid === child && sig === "SIGKILL"));
    } finally { inspect.mock.restore(); syncBuiltinESMExports(); }
  });
}

test("procs: a failed ancestry ps is reported once and cleanup remains best effort", async (t) => {
  // Separate module instance gives this test its own once-per-process warning state.
  const { killGroupNow } = await import("../dist/core/procs.js?failed-ancestry-read");
  const written: string[] = [], signals: [number, string | number][] = [];
  t.mock.method(process.stderr, "write", ((s) => (written.push(String(s)), true)) as typeof process.stderr.write);
  t.mock.method(process, "kill", ((pid, sig) => {
    if (sig === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    signals.push([pid, sig]); return true;
  }) as typeof process.kill);
  const inspect = t.mock.method(childProcess, "spawnSync", (() => ({ status: 1, stdout: "", stderr: "ps denied" })) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    assert.equal(killGroupNow(61001, () => new Map()), true);
    assert.equal(killGroupNow(61001, () => new Map()), true);
    assert.deepEqual(signals, [[-61001, "SIGKILL"], [-61001, "SIGKILL"]]);
    assert.equal(written.length, 1);
    assert.match(written[0], /could not read process ancestry.*continuing without ancestry protection: ps denied/);
  } finally { inspect.mock.restore(); syncBuiltinESMExports(); }
});
