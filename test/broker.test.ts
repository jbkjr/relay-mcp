import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { confinement } from "../dist/confine/index.js";
import { sandboxed, SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
import { procStart } from "../dist/core/procs.js";
import { harness, hostFor, scratchEnv, scratchOnly, STUB_TARGETS, task, until, type Harness, type Rec, type Rule } from "./helpers.ts";

const macOS = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
const STUBS = path.resolve(import.meta.dirname, "stubs");

/** A child process that speaks one JSON object per line. Its HOME and the like must be scratch. */
function lineProc(command: string, args: string[], opts: SpawnOptions) {
  if (opts.env) scratchEnv(opts.env);
  const child = spawn(command, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
  const queue: Rec[] = [];
  const waiters: ((r: Rec) => void)[] = [];
  let buf = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const r = JSON.parse(buf.slice(0, i)) as Rec;
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(r);
      else queue.push(r);
    }
  });
  child.stderr!.on("data", (d) => (stderr += d));
  const next = (ms = 90000): Promise<Rec> =>
    queue.length
      ? Promise.resolve(queue.shift()!)
      : new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no reply within ${ms} ms; stderr: ${stderr}`)), ms);
        waiters.push((r) => {
          clearTimeout(t);
          resolve(r);
        });
      });
  return {
    child,
    next,
    ask: (cmd: Rec | string) => {
      child.stdin!.write(typeof cmd === "string" ? `${cmd}\n` : `${JSON.stringify(cmd)}\n`);
      return next();
    },
    end: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.stdin!.end();
    }),
  };
}

const outer = STUB_TARGETS.find((t) => t === "codex") ?? STUB_TARGETS[0];
const grand = hostFor(outer);
const rules: Rule[] = [
  { match: task("OUTER"), steps: [{ write: "outer.txt" }, { reply: "outer done" }] },
  { match: task("GRAND"), steps: [{ write: "grand.txt" }, { reply: "grand done" }] },
];

/** A finished write job of `outer`'s family with a worktree, and a new turn of it running: the turn a worker would confine. */
async function confinedTurn(h: Harness) {
  const job = await h.call("delegate", { target: outer, task: "OUTER", mode: "write" });
  await until(() => h.sql("SELECT status, worker_pid FROM nodes WHERE id = ?", job.job_id).some((n) => n.status === "done" && !n.worker_pid), 30000, "outer job done");
  const node = h.sql("SELECT * FROM nodes WHERE id = ?", job.job_id)[0];
  assert.ok(node.worktree && fs.existsSync(node.worktree), "the outer job kept its worktree");
  return { node, turnId: (await h.childOf(job.job_id, { access: "write" })).turnId };
}

function brokerHost(h: Harness, turn: Rec, opts: Rec = {}) {
  const p = lineProc(process.execPath, [path.join(STUBS, "broker-host.mjs"), JSON.stringify(turn), JSON.stringify(opts)], { env: { ...h.env, RELAY_ENV_SOCKET: h.environmentSocket(turn.nodeId) }, cwd: h.repo });
  return { ...p, ready: p.next() };
}

/** Match the worker's ordering: spawn, pin the harness identity, then let it start its bridge. */
async function boundAgent(host: ReturnType<typeof brokerHost>, command: string, args: string[], opts: SpawnOptions) {
  const agent = lineProc(command, args, opts);
  try {
    assert.equal((await host.ask({ bind: { pid: agent.child.pid, start: procStart(agent.child.pid) } })).bound, true);
    assert.equal((await agent.ask({ op: "start" })).ready, true);
    return agent;
  } catch (err) {
    await agent.end();
    throw err;
  }
}

/** Probes for the confined harness, each aimed at a scratch path (see scratchOnly). */
const scratchProbes = (probes: Record<string, [string, string]>) => {
  for (const [name, [, p]] of Object.entries(probes)) scratchOnly(p, `probe ${name}`);
  return probes;
};

/** A raw connection to a broker socket, sending `first` (if any) and then an MCP initialize: what it got back, and whether the broker closed it. */
const rawTry = (socketPath: string, first?: string) => new Promise<{ data: string; closed: boolean }>((resolve) => {
  const s = net.connect(socketPath);
  let data = "";
  const t = setTimeout(() => (s.destroy(), resolve({ data, closed: false })), 4000);
  s.on("connect", () => {
    if (first !== undefined) s.write(first + "\n");
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "outsider", version: "0" } } }) + "\n");
  });
  s.on("data", (d) => {
    data += d;
    // Answered: enough to show the connection was served.
    if (data.includes("\n")) (clearTimeout(t), s.destroy(), resolve({ data, closed: false }));
  });
  s.on("close", () => (clearTimeout(t), resolve({ data, closed: true })));
  s.on("error", () => {});
});

const endTurn = (h: Harness, turnId: number) => h.sql("UPDATE turns SET status = 'done', ended_at = ? WHERE id = ?", Date.now(), turnId);

test("broker: a launched agent reaches relay through the bridge, with the live turn's authority and no longer", async () => {
  // This test asserts the configured own-family refusal through the bridge; 1.0 defaults to allow.
  const h = await harness(rules, { same_family: "refuse" });
  const hosts: { end(): Promise<void> }[] = [];
  try {
    const { node, turnId } = await confinedTurn(h);
    const host = brokerHost(h, { nodeId: node.id, turnId, mayDelegate: true, mayAsk: false });
    hosts.push(host);
    const b = await host.ready;
    assert.ok(b.socketPath && !b.error, JSON.stringify(b));
    assert.equal(fs.statSync(b.dir).mode & 0o777, 0o700, "the turn's directory is private");
    assert.deepEqual(b.bridge.args.slice(-2), ["bridge", b.socketPath]);
    // The bridge is handed one thing: the turn's secret, which its connection must present first (core review C21).
    assert.deepEqual(Object.keys(b.bridge.env), ["RELAY_BRIDGE_SECRET"], "the bridge is handed no registry or context, only the turn's secret");
    assert.match(b.bridge.env.RELAY_BRIDGE_SECRET, /^[A-Za-z0-9_-]{32}$/);
    // Anything else that finds the socket (another agent's sandbox may list relay's sockets directory) gets nothing.
    // ...including a first line longer than any secret line, refused unread (review r_f0fce42b C2).
    for (const first of [undefined, JSON.stringify({ relay_bridge_secret: "x".repeat(32) }), JSON.stringify({ relay_bridge_secret: "" }), JSON.stringify({ relay_bridge_secret: b.bridge.env.RELAY_BRIDGE_SECRET, pad: "p".repeat(600) })]) {
      const outsider = await rawTry(b.socketPath, first);
      assert.deepEqual(outsider, { data: "", closed: true }, `a connection presenting ${first ?? "nothing"} is closed unanswered`);
    }
    // Even an outsider holding the exact secret is refused (C21: a bearer secret is insufficient).
    const own = await rawTry(b.socketPath, JSON.stringify({ relay_bridge_secret: b.bridge.env.RELAY_BRIDGE_SECRET }));
    assert.deepEqual(own, { data: "", closed: true });

    // Unconfined here: what the bridge and broker do, whatever sandbox is around them.
    const agent = await boundAgent(host, process.execPath, [path.join(STUBS, "confined-harness.mjs"), JSON.stringify({ bridge: b.bridge, waitForStart: true })], { cwd: node.worktree, env: { PATH: process.env.PATH! } });
    hosts.push(agent);
    const outsider = await rawTry(b.socketPath, JSON.stringify({ relay_bridge_secret: b.bridge.env.RELAY_BRIDGE_SECRET }));
    assert.deepEqual(outsider, { data: "", closed: true }, "a live bound harness does not authorize a sibling holding its secret");
    const { tools } = await agent.ask({ op: "tools" });
    assert.ok(tools.includes("delegate") && tools.includes("status"));
    assert.ok(!tools.includes("approve"), "a launched agent never gets the root's tools");

    const res = await agent.ask({ op: "call", tool: "delegate", args: { target: grand, task: "GRAND", mode: "write", background: false } });
    assert.ok(res.job_id, JSON.stringify(res));
    const child = h.sql("SELECT * FROM nodes WHERE id = ?", res.job_id)[0];
    assert.equal(child.parent_id, node.id, "the grandchild is the confined agent's own");
    assert.equal(child.depth, node.depth + 1);
    assert.equal(child.target, grand);
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", res.job_id)[0]?.status === "done", 30000, "grandchild done");
    assert.equal(fs.readFileSync(path.join(child.worktree, "grand.txt"), "utf8"), "stub\n");
    // The caller's own family is refused through the broker as through `relay mcp`.
    const same = await agent.ask({ op: "call", tool: "delegate", args: { target: outer, task: "SAME", mode: "read" } });
    assert.match(String(same.reason ?? same.error ?? JSON.stringify(same)), /own family|same family|your own/i);

    // The turn ends in the registry while the socket is still open: refused per request.
    endTurn(h, turnId);
    const late = await agent.ask({ op: "call", tool: "status", args: {} });
    assert.equal(late.code, -32001, JSON.stringify(late));
    assert.match(late.rpc_error, /turn this agent was started for has ended \(done\)/);

    // The worker closes the broker: the open connection and any new bridge are refused at once.
    assert.equal((await host.ask("close")).closed, true);
    assert.ok(!fs.existsSync(b.dir), "the socket and its directory are gone");
    const closed = await agent.ask({ op: "call", tool: "status", args: {} });
    assert.equal(closed.code, -32002, JSON.stringify(closed));
    assert.match(closed.rpc_error, /not reachable/);
    const fresh = await agent.ask({ op: "fresh", tool: "status", args: {} });
    assert.ok(fresh.rpc_error, JSON.stringify(fresh));

    // No broker for a turn that is not running.
    const refusedHost = brokerHost(h, { nodeId: node.id, turnId, mayDelegate: true, mayAsk: false });
    hosts.push(refusedHost);
    assert.match((await refusedHost.ready).error, /not live/);
  } finally {
    for (const p of hosts) await p.end();
    await h.close();
  }
});

test("broker: a turn that may not delegate gets no tools that start agents", async () => {
  const h = await harness(rules);
  const hosts: { end(): Promise<void> }[] = [];
  try {
    const { node, turnId } = await confinedTurn(h);
    const host = brokerHost(h, { nodeId: node.id, turnId, mayDelegate: false, mayAsk: false });
    hosts.push(host);
    const b = await host.ready;
    const agent = await boundAgent(host, process.execPath, [path.join(STUBS, "confined-harness.mjs"), JSON.stringify({ bridge: b.bridge, waitForStart: true })], { cwd: node.worktree, env: { PATH: process.env.PATH! } });
    hosts.push(agent);
    const res = await agent.ask({ op: "call", tool: "delegate", args: { target: grand, task: "GRAND", mode: "read" } });
    assert.ok(!res.job_id, JSON.stringify(res));
    assert.equal(h.sql("SELECT count(*) AS n FROM nodes WHERE parent_id = ?", node.id)[0].n, 0, "nothing was started");
  } finally {
    for (const p of hosts) await p.end();
    await h.close();
  }
});

test("broker: its tool list (for a harness that discovers relay's tools) is exactly what a bridge connection is offered, none for a turn that may not delegate, and refused once the turn is over", async () => {
  const h = await harness(rules);
  const hosts: { end(): Promise<void> }[] = [];
  try {
    const { node, turnId } = await confinedTurn(h);
    const host = brokerHost(h, { nodeId: node.id, turnId, mayDelegate: true, mayAsk: false });
    hosts.push(host);
    const b = await host.ready;
    const listed = (await host.ask({ list: true })).tools as { name: string; description?: string; inputSchema?: { type?: string } }[];
    const agent = await boundAgent(host, process.execPath, [path.join(STUBS, "confined-harness.mjs"), JSON.stringify({ bridge: b.bridge, waitForStart: true })], { cwd: node.worktree, env: { PATH: process.env.PATH! } });
    hosts.push(agent);
    const { tools } = await agent.ask({ op: "tools" });
    assert.deepEqual(listed.map((t) => t.name).sort(), tools, "the same server, made the same way");
    assert.ok(tools.includes("delegate") && !tools.includes("approve"));
    assert.ok(listed.every((t) => typeof t.description === "string" && t.description && t.inputSchema?.type === "object"), "descriptions and input schemas as tools/list gives them");
    const none = brokerHost(h, { nodeId: node.id, turnId, mayDelegate: false, mayAsk: false });
    hosts.push(none);
    await none.ready;
    assert.deepEqual((await none.ask({ list: true })).tools, [], "a turn that may not delegate is offered nothing (its harness asks in-band)");
    endTurn(h, turnId);
    assert.match((await host.ask({ list: true })).error, /^relay cannot list this turn's tools: the relay turn this agent was started for has ended \(done\)/);
  } finally {
    for (const p of hosts) await p.end();
    await h.close();
  }
});

test("broker: the secret's file is written once, private, beside the socket, and goes with the broker", async () => {
  const h = await harness(rules);
  const hosts: { end(): Promise<void> }[] = [];
  try {
    const { node, turnId } = await confinedTurn(h);
    const host = brokerHost(h, { nodeId: node.id, turnId, mayDelegate: true, mayAsk: false });
    hosts.push(host);
    const b = await host.ready;
    const { file } = await host.ask({ secretFile: true });
    assert.equal(file, path.join(b.dir, "bridge-secret"));
    assert.equal(fs.readFileSync(file, "utf8"), b.bridge.env.RELAY_BRIDGE_SECRET);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal((await host.ask({ secretFile: true })).file, file, "the same file on a second call");
    assert.deepEqual(fs.readdirSync(b.dir).sort(), ["bridge-secret", "relay.sock"]);
    assert.equal((await host.ask("close")).closed, true);
    assert.ok(!fs.existsSync(file) && !fs.existsSync(b.dir), "gone with the broker's directory");
  } finally {
    for (const p of hosts) await p.end();
    await h.close();
  }
});

test("broker: a lower-authority native-sandboxed outsider holding the secret is refused", { skip: !macOS && "macOS only" }, async () => {
  const h = await harness(rules);
  const hosts: { end(): Promise<void> }[] = [];
  try {
    const { node, turnId } = await confinedTurn(h);
    const host = brokerHost(h, { nodeId: node.id, turnId, mayDelegate: false, mayAsk: false });
    hosts.push(host);
    const b = await host.ready;
    const agent = await boundAgent(host, process.execPath, [path.join(STUBS, "confined-harness.mjs"), JSON.stringify({ bridge: b.bridge, waitForStart: true })], { cwd: node.worktree, env: { PATH: process.env.PATH! } });
    hosts.push(agent);
    // A native Seatbelt sandbox separate from relay's launched tree, with only this socket open.
    const profile = `(version 1) (deny default) (allow process* file-read* sysctl-read mach-lookup)
      (allow network-outbound (remote unix-socket (literal ${JSON.stringify(b.socketPath)})))`;
    const peer = lineProc(SANDBOX_EXEC, ["-p", profile, process.execPath, path.join(STUBS, "broker-peer.mjs"), b.socketPath, b.bridge.env.RELAY_BRIDGE_SECRET], { cwd: h.repo, env: h.env });
    hosts.push(peer);
    const ready = await peer.next();
    assert.equal(ready.pid, peer.child.pid);
    assert.equal(sandboxed(peer.child.pid!), true, "negative control really runs under a native sandbox");
    const result = await peer.ask("go");
    assert.equal(result.connected, true, JSON.stringify(result));
    assert.equal(result.data, "", "the broker must not serve a sandboxed outsider that knows the secret");
    const { refusals } = await host.ask({ refusals: true });
    assert.match(refusals.join("\n"), /outside.*harness.*tree/i);
  } finally {
    for (const p of hosts) await p.end();
    await h.close();
  }
});

test("broker: an undeterminable kernel peer is refused and the reason is logged", async () => {
  const h = await harness(rules);
  const hosts: { end(): Promise<void> }[] = [];
  try {
    const { node, turnId } = await confinedTurn(h);
    const host = brokerHost(h, { nodeId: node.id, turnId, mayDelegate: false, mayAsk: false }, { unknownPeer: true });
    hosts.push(host);
    const b = await host.ready;
    assert.equal((await host.ask({ bind: { pid: process.pid, start: procStart(process.pid) } })).bound, true);
    const result = await rawTry(b.socketPath, JSON.stringify({ relay_bridge_secret: b.bridge.env.RELAY_BRIDGE_SECRET }));
    assert.deepEqual(result, { data: "", closed: true });
    assert.match((await host.ask({ refusals: true })).refusals.join("\n"), /peer pid unavailable/);
  } finally {
    for (const p of hosts) await p.end();
    await h.close();
  }
});

test("broker: an authorized process still needs the exact secret, and a wrong uid or stale peer identity is refused", async () => {
  const h = await harness(rules);
  const hosts: { end(): Promise<void> }[] = [];
  try {
    const { node, turnId } = await confinedTurn(h);
    const turn = { nodeId: node.id, turnId, mayDelegate: false, mayAsk: false };
    const host = brokerHost(h, turn);
    hosts.push(host);
    const b = await host.ready;
    assert.equal((await host.ask({ bind: { pid: process.pid, start: procStart(process.pid) } })).bound, true);
    for (const first of [undefined, JSON.stringify({ relay_bridge_secret: "x".repeat(32) }), JSON.stringify({ relay_bridge_secret: "" }), JSON.stringify({ relay_bridge_secret: b.bridge.env.RELAY_BRIDGE_SECRET, pad: "p".repeat(600) })]) {
      assert.deepEqual(await rawTry(b.socketPath, first), { data: "", closed: true });
    }
    assert.match((await rawTry(b.socketPath, JSON.stringify({ relay_bridge_secret: b.bridge.env.RELAY_BRIDGE_SECRET }))).data, /"result":\{.*"serverInfo"/);
    assert.equal((await host.ask({ bind: { pid: process.pid, start: procStart(process.pid) } })).bound, false, "the turn cannot be rebound");
    for (const mode of ["wrongUid", "stalePeer"]) {
      const badHost = brokerHost(h, turn, { [mode]: true });
      hosts.push(badHost);
      const bad = await badHost.ready;
      assert.equal((await badHost.ask({ bind: { pid: process.pid, start: "an earlier occupant of this pid" } })).bound, false);
      assert.equal((await badHost.ask({ bind: { pid: process.pid, start: procStart(process.pid) } })).bound, true);
      assert.deepEqual(await rawTry(bad.socketPath, JSON.stringify({ relay_bridge_secret: bad.bridge.env.RELAY_BRIDGE_SECRET })), { data: "", closed: true });
      assert.match((await badHost.ask({ refusals: true })).refusals.join("\n"), mode === "wrongUid" ? /uid/ : /process identity changed/);
    }
  } finally {
    for (const p of hosts) await p.end();
    await h.close();
  }
});

test("broker e2e: a harness under relay's Seatbelt profile delegates through the bridge and can touch nothing else", { skip: !macOS && "macOS only" }, async () => {
  const found = confinement();
  assert.ok("mechanism" in found, "reason" in found ? found.reason : "");
  const mech = found.mechanism;
  const h = await harness(rules);
  const hosts: { end(): Promise<void> }[] = [];
  // The harness's HOME is scratch and outside every root the profile allows: writing there is an escape.
  const homeMarker = path.join(h.env.HOME, ".relay-confine-e2e");
  try {
    const { node, turnId } = await confinedTurn(h);
    const host = brokerHost(h, { nodeId: node.id, turnId, mayDelegate: true, mayAsk: false });
    hosts.push(host);
    const b = await host.ready;
    // Another turn's broker, which this sandbox must not reach.
    const other = brokerHost(h, { nodeId: node.id, turnId: (await h.childOf(node.id, { access: "write" })).turnId, mayDelegate: true, mayAsk: false });
    hosts.push(other);
    const ob = await other.ready;

    const tmpDir = path.join(path.dirname(h.home), "turn-tmp");
    fs.mkdirSync(tmpDir, { mode: 0o700 });
    const launch = mech.wrap({
      worktree: node.worktree, worktreeWritable: true, tmpDir, denied: [h.home], bridgeSocket: b.socketPath,
      network: { mode: "off-except-proxy", proxyPort: 9, proxyToken: "t".repeat(32) },
    }, process.execPath, [path.join(STUBS, "confined-harness.mjs"), JSON.stringify({ bridge: b.bridge, waitForStart: true })]);
    const agent = await boundAgent(host, launch.command, launch.args, { cwd: node.worktree, env: { PATH: process.env.PATH!, HOME: h.env.HOME, ...launch.env } });
    hosts.push(agent);
    assert.equal(mech.confined(agent.child.pid!), true, "the kernel reports the harness as sandboxed");
    assert.equal(sandboxed(process.pid), false, "and the test process as not");

    // (a) relay works from inside: a grandchild of another family is started outside and completes.
    const res = await agent.ask({ op: "call", tool: "delegate", args: { target: grand, task: "GRAND", mode: "write", background: false } });
    assert.ok(res.job_id, JSON.stringify(res));
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", res.job_id)[0]?.status === "done", 30000, "grandchild done");
    const child = h.sql("SELECT * FROM nodes WHERE id = ?", res.job_id)[0];
    assert.equal(child.parent_id, node.id);
    assert.equal(fs.readFileSync(path.join(child.worktree, "grand.txt"), "utf8"), "stub\n");
    const st = await agent.ask({ op: "call", tool: "status", args: { id: res.job_id } });
    assert.equal(st.status, "done", JSON.stringify(st));

    // (b) relay's registry and control directory, (d) another turn's socket, (e) writes outside the worktree.
    const db = path.join(h.home, "relay.db");
    const p = await agent.ask({
      op: "probe",
      probes: scratchProbes({
        writeDb: ["write", db], readDb: ["read", db], openDb: ["sqlite", db], listControl: ["list", h.home],
        writeControl: ["write", path.join(h.home, "forged.json")],
        ownSocket: ["connect", b.socketPath], otherSocket: ["connect", ob.socketPath],
        writeInside: ["write", path.join(node.worktree, "inside.txt")], writeTmp: ["write", path.join(tmpDir, "t")],
        writeMainRepo: ["write", path.join(h.repo, "escape.txt")], writeGitPointer: ["write", path.join(node.worktree, ".git")],
        writeOtherWorktree: ["write", path.join(child.worktree, "escape.txt")], writeHome: ["write", homeMarker],
      }),
    });
    assert.equal(p.writeDb, "EPERM");
    assert.equal(p.readDb, "EPERM");
    assert.notEqual(p.openDb, "allowed");
    assert.equal(p.listControl, "EPERM");
    assert.equal(p.writeControl, "EPERM");
    assert.equal(p.ownSocket, "allowed", "the turn's own socket is the positive control");
    assert.equal(p.otherSocket, "EPERM");
    assert.equal(p.writeInside, "allowed");
    assert.equal(p.writeTmp, "allowed");
    for (const k of ["writeMainRepo", "writeGitPointer", "writeOtherWorktree", "writeHome"]) assert.equal(p[k], "EPERM", k);
    assert.ok(!fs.existsSync(path.join(h.repo, "escape.txt")) && !fs.existsSync(homeMarker) && !fs.existsSync(path.join(h.home, "forged.json")));

    // (c) after the turn ends: refused while the socket is open, and once the broker has closed it.
    endTurn(h, turnId);
    const late = await agent.ask({ op: "call", tool: "delegate", args: { target: grand, task: "GRAND", mode: "read" } });
    assert.equal(late.code, -32001, JSON.stringify(late));
    assert.equal((await host.ask("close")).closed, true);
    const closed = await agent.ask({ op: "call", tool: "status", args: {} });
    assert.equal(closed.code, -32002, JSON.stringify(closed));
    const fresh = await agent.ask({ op: "fresh", tool: "status", args: {} });
    assert.ok(fresh.rpc_error, JSON.stringify(fresh));
    assert.equal(h.sql("SELECT count(*) AS n FROM nodes WHERE parent_id = ?", node.id)[0].n, 1, "nothing started after the turn ended");
  } finally {
    for (const p of hosts) await p.end();
    await h.close();
  }
});
