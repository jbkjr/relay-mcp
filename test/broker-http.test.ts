import "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { tcpPeerLookup } from "../dist/confine/peer.js";
import { openHttpBroker, BROKER_TOKEN_ENV, BROKER_SESSION_CAP } from "../dist/confine/broker-http.js";
import { db, insertNode, insertTurn, newId, closeDbForTests, updateTurn } from "../dist/core/db.js";
import { withDefaults } from "../dist/core/config.js";
import { withTurnSecrets, redactor } from "../dist/core/secrets.js";

const app = { pid: process.pid === 23456 ? 23457 : 23456, start: "pinned" };
const endpoints = { localPort: 54321, remotePort: 54322 };
const ownEnd = `p${process.pid}\nn127.0.0.1:54321->127.0.0.1:54322\n`;
const appEnd = `p${app.pid}\nn127.0.0.1:54322->127.0.0.1:54321\n`;

test("HTTP peer: both exact ends, fixed command, scrubbed environment and timeout", async () => {
  let calls = 0;
  const result = await tcpPeerLookup(app, endpoints, { exec: (file, args, options, done) => {
    calls++;
    assert.equal(file, "/usr/sbin/lsof");
    // Selecting a PID with no matching socket makes Darwin lsof exit 1, even if relay's
    // positive-control end is printed. Select only the connection; inspect owners below.
    assert.deepEqual(args, ["-nP", "-iTCP@127.0.0.1:54322", "-F", "pn"]);
    assert.deepEqual(options.env, { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C" });
    assert.equal(options.timeout, 2000);
    done(null, ownEnd + appEnd);
  } });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("HTTP peer: a valid foreign or invisible client is nonfatal", async () => {
  for (const out of [ownEnd, ownEnd + appEnd.replace(`p${app.pid}`, "p34567")]) {
    assert.equal(await tcpPeerLookup(app, endpoints, { exec: (_f, _a, _o, done) => done(null, out) }), "foreign");
  }
});

test("HTTP peer: recorded Darwin field format preserves owners across command and descriptor records", async () => {
  // The maintainer's macOS 27 sample is p<pid>, c<command>, n<local>-><remote>. Substitute the
  // fixture pids/ports and include f records (also permitted in lsof field output).
  const relay = [`p${process.pid}`, "cnode", "f24", "n127.0.0.1:54321->127.0.0.1:54322"];
  const client = [`p${app.pid}`, "ccodex", "f17", "n127.0.0.1:54322->127.0.0.1:54321"];
  const lookup = (lines) => tcpPeerLookup(app, endpoints, { exec: (_f, args, _o, done) => {
    assert.ok(!args.includes("-p") && !args.includes("-a"), "the socket selector must work even when the pinned app has no matching end");
    done(null, lines.join("\n") + "\n");
  } });
  assert.equal(await lookup([...relay, ...client]), "ok");
  assert.equal(await lookup([...client, ...relay]), "ok");
  assert.equal(await lookup([...relay, "p34567", ...client.slice(1)]), "foreign");
  assert.equal(await lookup(relay), "foreign", "the client may be invisible or the app may have no matching socket");
  assert.equal(await lookup([...relay, `p${app.pid}`, "ccodex", "n127.0.0.1:54321->127.0.0.1:54322"]), "foreign", "the app must own the client direction");
  assert.equal(typeof await lookup(client), "object", "the app end cannot replace relay's positive control");
  assert.equal(typeof await lookup(["p34567", ...relay.slice(1), ...client]), "object", "a foreign process cannot own the positive control");
});

test("HTTP peer: exit status, timeout and spawn failure remain distinguishable even with valid partial output", async () => {
  for (const [properties, diagnostic] of [
    [{ code: 1 }, /exited.*1/],
    [{ killed: true, signal: "SIGTERM", code: null }, /timed out/],
    [{ code: "ENOENT" }, /ENOENT/],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/],
  ]) {
    const error = Object.assign(new Error("fixture"), properties);
    const result = await tcpPeerLookup(app, endpoints, { exec: (_f, _a, _o, done) => done(error, ownEnd + appEnd) });
    assert.equal(typeof result, "object");
    assert.match(result.error, diagnostic);
  }
});

test("HTTP peer: absent positive control and ANY execFile error fail operationally, including partial success", async () => {
  for (const [error, out] of [[null, appEnd], [new Error("timeout"), ownEnd + appEnd], [new Error("exit 1"), ownEnd], [new Error("ENOENT"), ""]] as const) {
    const result = await tcpPeerLookup(app, endpoints, { exec: (_f, _a, _o, done) => done(error, out) });
    assert.equal(typeof result, "object");
    assert.ok(result.error);
  }
});

test("HTTP peer: empty exit 1 after client close/end is a nonfatal drop; real failures stay operational", async () => {
  for (const state of ["destroyed", "readableEnded", "writableEnded"]) {
    const socket = { ...endpoints, [state]: false };
    const result = await tcpPeerLookup(app, socket, { exec: (_f, _a, _o, done) => {
      socket[state] = true;
      done(Object.assign(new Error("no files"), { code: 1 }), "", "");
    } });
    assert.equal(result, "foreign");
    for (const [properties, stdout, stderr] of [
      [{ code: 1 }, ownEnd + appEnd, ""], [{ code: 1 }, "", "lsof warning"],
      [{ code: 2 }, "", ""], [{ code: 1, killed: true, signal: "SIGTERM" }, "", ""],
    ]) {
      const failure = await tcpPeerLookup(app, socket, { exec: (_f, _a, _o, done) => done(Object.assign(new Error("fixture"), properties), stdout, stderr) });
      assert.equal(typeof failure, "object", "a closed client cannot rescue partial output or real checker failures");
    }
  }
  assert.equal(typeof await tcpPeerLookup(app, endpoints, { exec: (_f, _a, _o, done) => done(Object.assign(new Error("empty"), { code: 1 }), "") }), "object");
});

test("HTTP peer: diagnostics retain exit code, signal and a bounded redacted stderr excerpt", async () => {
  await withTurnSecrets(async () => {
    const { registerTurnSecret } = await import("../dist/core/secrets.js");
    const secret = "fixture-broker-secret-83c721";
    registerTurnSecret(secret, "broker token");
    const result = await tcpPeerLookup(app, endpoints, { exec: (_f, _a, _o, done) => done(
      Object.assign(new Error("fixture"), { code: 2, signal: "SIGTERM" }), ownEnd + appEnd,
      `lsof: ${secret}\nAuthorization: Bearer abcdefgh12345678\n${"x".repeat(1000)}`,
    ) });
    assert.equal(typeof result, "object");
    assert.match(result.error, /code=2, signal=SIGTERM, stderr="lsof:/);
    assert.match(result.error, /\[redacted: broker token\]/);
    assert.doesNotMatch(result.error, /fixture-broker-secret|abcdefgh12345678/);
    assert.ok(result.error.length < 400);
    assert.doesNotMatch(result.error, /\n/);
  });
});

// Exercise Node's real HTTP parser, MCP transport and relay server over memory sockets. No
// loopback permission, real process, or model is needed for these tests.
class MemorySocket extends Duplex {
  constructor() { super({ allowHalfOpen: false }); }
  other!: MemorySocket;
  localAddress = "127.0.0.1";
  remoteAddress = "127.0.0.1";
  localPort = 54321;
  remotePort = 54322;
  _read() {}
  _write(chunk, _encoding, done) { if (!this.other.destroyed) this.other.push(Buffer.from(chunk)); done(); }
  _final(done) { this.other.push(null); done(); }
  _destroy(error, done) { if (!this.other.destroyed) this.other.destroy(); done(error); }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}
class FakeServer extends EventEmitter {
  listening = false;
  options;
  listen(options, done) { this.options = options; this.listening = true; queueMicrotask(done); return this; }
  close(done) { this.listening = false; queueMicrotask(() => { this.emit("close"); done?.(); }); return this; }
}
class MemoryNetwork {
  servers: FakeServer[] = [];
  sockets: MemorySocket[] = [];
  nextPort = 54322;
  createServer = (_opts, accept) => {
    const s = new FakeServer(); s.on("connection", accept); this.servers.push(s); return s;
  };
  connect = (_port, _host) => {
    const client = new MemorySocket(), server = new MemorySocket();
    server.remotePort = this.nextPort++;
    client.localPort = server.remotePort;
    client.remotePort = server.localPort;
    client.other = server; server.other = client;
    this.sockets.push(client, server);
    client.on("error", () => {});
    queueMicrotask(() => { this.servers[0].emit("connection", server); client.emit("connect"); });
    return client;
  };
}
class Clock {
  now = 0;
  jobs = new Map<object, { at: number; run: () => void }>();
  setTimeout = (run, ms) => { const id = {}; this.jobs.set(id, { at: this.now + ms, run }); return id; };
  clearTimeout = (id) => { this.jobs.delete(id); };
  advance(ms) { this.now += ms; for (const [id, job] of [...this.jobs]) if (job.at <= this.now) { this.jobs.delete(id); job.run(); } }
}
// The delegated sandbox supplies a private TMPDIR under the user's home. Only this newly
// created directory is accessed; helpers still replace HOME before any relay work.
const turnHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-http-unit-"));
process.env.RELAY_HOME = turnHome;
fs.writeFileSync(path.join(turnHome, "config.json"), JSON.stringify({ allow_temp_home: true }));
after(() => { closeDbForTests(); fs.rmSync(turnHome, { recursive: true, force: true }); });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function turn() {
  const runId = newId("run");
  // Seed the registry directly: createRun reads a real process's start time via ps.
  db().prepare("INSERT INTO runs (id, created_at, root_cwd, config_json, root_pid, root_start, root_token) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(runId, Date.now(), turnHome, JSON.stringify(withDefaults({ allow_temp_home: true })), process.pid, "unit-root", "fixture-root");
  const nodeId = newId("job");
  insertNode({ id: nodeId, run_id: runId, kind: "job", mode: "write", target: "codex", depth: 1, task: "fixture", cwd: turnHome, status: "running" });
  return { nodeId, turnId: insertTurn(nodeId, "test", "", "write", "running"), mayDelegate: true, mayAsk: false };
}
async function fixture(options = {}) {
  const { bind = true, ...brokerOptions } = options;
  const network = new MemoryNetwork(), clock = new Clock();
  const refusals: string[] = [], fatals: string[] = [];
  const t = turn();
  let broker, cut;
  await withTurnSecrets(async () => {
    broker = await openHttpBroker(t, 54321, { network, clock, processMatches: () => true, peer: async () => "ok", onRefusal: (r) => refusals.push(r), ...brokerOptions });
    cut = redactor();
  });
  broker.onFatal((r) => fatals.push(r));
  if (bind) broker.bindAppServer(app);
  return { broker, network, clock, refusals, fatals, turn: t, cut };
}
function head(f, extra = "", token = f.broker.env[BROKER_TOKEN_ENV]) {
  return `GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:54321\r\nAuthorization: Bearer ${token}\r\n${extra}\r\n`;
}
function raw(f, request?: string) {
  const sock = f.network.connect(54321, "127.0.0.1");
  let reply = "";
  sock.on("data", (d) => reply += d.toString());
  if (request) sock.once("connect", () => sock.write(request));
  return { sock, reply: () => reply };
}

test("HTTP front: 300 idle connections hold at most 16 slots, expire at 2 s, and spawn zero lookups", async () => {
  let spawns = 0;
  const f = await fixture({ peer: async () => { spawns++; return "ok"; } });
  spawns = 0; // Open's mandatory self-check is separate from unauthenticated traffic.
  try {
    const clients = Array.from({ length: 300 }, () => raw(f));
    await flush();
    assert.equal(clients.filter((c) => !c.sock.destroyed).length, 16);
    f.clock.advance(1999); await flush();
    assert.equal(clients.filter((c) => !c.sock.destroyed).length, 16);
    f.clock.advance(1); await flush();
    assert.ok(clients.every((c) => c.sock.destroyed));
    assert.equal(spawns, 0);
  } finally { await f.broker.close(); }
});

test("HTTP front: 300 wrong-token requests spawn zero lookups", async () => {
  let spawns = 0;
  const f = await fixture({ peer: async () => { spawns++; return "ok"; } });
  spawns = 0;
  try {
    for (let i = 0; i < 300; i++) {
      const c = raw(f, head(f, "", "wrong")); await flush();
      assert.match(c.reply(), /HTTP\/1.1 401/);
    }
    assert.equal(spawns, 0);
  } finally { await f.broker.close(); }
});

test("HTTP front: Host, Origin, duplicate headers and the 8 KiB head cap precede lookup", async () => {
  let spawns = 0;
  const f = await fixture({ peer: async () => { spawns++; return "ok"; } });
  spawns = 0;
  try {
    for (const [request, status] of [
      [head(f).replace("Host: 127.0.0.1:54321", "Host: localhost:54321"), 421],
      [head(f, "Origin: null\r\n"), 403],
      [head(f, "Host: 127.0.0.1:54321\r\n"), 421],
      [head(f, `Authorization: Bearer ${f.broker.env[BROKER_TOKEN_ENV]}\r\n`), 401],
      [head(f, "X-Test: a\r\nX-Test: b\r\n"), 400],
      [head(f, `X-Test: ${"a".repeat(8192)}\r\n`), 431],
      ["GET /mcp HTTP/1.1\r\nX: " + "a".repeat(8192), 431],
    ]) {
      const c = raw(f, request); await flush();
      assert.match(c.reply(), new RegExp(`HTTP/1.1 ${status}`));
    }
    assert.equal(spawns, 0);
    assert.equal(f.cut(f.broker.env[BROKER_TOKEN_ENV]), "[redacted: broker token]");
    assert.match(f.broker.env[BROKER_TOKEN_ENV], /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(f.broker.env), [BROKER_TOKEN_ENV]);
    assert.ok(Object.isFrozen(f.broker.env));
  } finally { await f.broker.close(); }
});

test("HTTP front: token-holder flood is bounded to 16 pending and two concurrent lookups", async () => {
  const releases: (() => void)[] = [];
  let spawns = 0, active = 0, peak = 0;
  const f = await fixture({ peer: async (p) => {
    if (p.pid === process.pid) return "ok";
    spawns++; active++; peak = Math.max(peak, active);
    await new Promise<void>((r) => releases.push(r)); active--; return "foreign";
  } });
  try {
    const clients = Array.from({ length: 300 }, () => raw(f, head(f)));
    await flush();
    assert.equal(spawns, 2); assert.equal(peak, 2);
    for (let i = 0; i < 8; i++) { releases.splice(0).forEach((r) => r()); await flush(); }
    assert.equal(spawns, 16); assert.equal(peak, 2);
    assert.equal(clients.filter((c) => /403/.test(c.reply())).length, 16);
    assert.equal(f.fatals.length, 0);
  } finally { releases.splice(0).forEach((r) => r()); await f.broker.close(); }
});

test("HTTP front: foreign is 403; operational error or timeout is 503 and latched fatal", async () => {
  for (const mode of ["foreign", "error", "throw", "slow"]) {
    const f = await fixture({ peer: async (p) => {
      if (p.pid === process.pid) return "ok";
      if (mode === "throw") throw new Error("fixture");
      if (mode === "slow") return new Promise(() => {});
      return mode === "error" ? { error: "checker broken" } : "foreign";
    } });
    try {
      const c = raw(f, head(f)); await flush();
      if (mode === "slow") {
        f.clock.advance(2250); await flush();
        assert.equal(f.fatals.length, 0, "the first timeout permits one retry");
        f.clock.advance(2250); await flush();
      }
      assert.match(c.reply(), mode === "foreign" ? /403/ : /503/);
      assert.equal(f.fatals.length, mode === "foreign" ? 0 : 1);
      if (mode !== "foreign") { const late: string[] = []; f.broker.onFatal((r) => late.push(r)); assert.equal(late.length, 1); }
    } finally { await f.broker.close(); }
  }
});

test("HTTP front: checker operational failure retries once, then success is dispatched without a fatal", async () => {
  for (const failure of ["error", "throw", "timeout"]) {
    let calls = 0;
    const f = await fixture({ peer: async (p) => {
      if (p.pid === process.pid) return "ok";
      if (++calls > 1) return "ok";
      if (failure === "throw") throw new Error("spawn failed");
      if (failure === "timeout") return new Promise(() => {});
      return { error: "TCP peer helper exited 2 (code=2, signal=none, stderr=\"fixture\")" };
    } });
    try {
      const c = raw(f, head(f)); await flush();
      if (failure === "timeout") { f.clock.advance(2250); await flush(); }
      assert.equal(calls, 2);
      assert.match(c.reply(), /HTTP\/1.1 405/, "the GET without a session reached HTTP dispatch");
      assert.deepEqual(f.fatals, []);
    } finally { await f.broker.close(); }
  }
});

test("HTTP front: two failures are fatal once and preserve redacted diagnostics", async () => {
  let calls = 0, token;
  const f = await fixture({ peer: async (p) => {
    if (p.pid === process.pid) return "ok";
    calls++;
    return { error: `TCP peer helper exited ${calls} (code=${calls}, signal=SIGTERM, stderr=\"${token} fixture\")` };
  } });
  token = f.broker.env[BROKER_TOKEN_ENV];
  try {
    const c = raw(f, head(f)); await flush();
    assert.equal(calls, 2); assert.match(c.reply(), /503/);
    assert.equal(f.fatals.length, 1);
    assert.match(f.fatals[0], /after 2 attempts/);
    assert.match(f.fatals[0], /code=1, signal=SIGTERM/);
    assert.match(f.fatals[0], /code=2, signal=SIGTERM/);
    assert.match(f.fatals[0], /stderr="\[redacted: broker token\] fixture"/);
    assert.ok(!f.fatals[0].includes(token));
    raw(f, head(f)); await flush();
    assert.equal(calls, 2); assert.equal(f.fatals.length, 1);
  } finally { await f.broker.close(); }
});

test("HTTP front: retry shares an absolute 4.5 s deadline, including delayed timeout delivery", async () => {
  let calls = 0, late;
  const f = await fixture({ peer: async (p) => {
    if (p.pid === process.pid) return "ok";
    calls++;
    return new Promise((resolve) => { late = resolve; });
  } });
  try {
    const c = raw(f, head(f)); await flush();
    f.clock.advance(4499); await flush();
    assert.equal(calls, 2); assert.equal(f.fatals.length, 0);
    f.clock.advance(1); await flush();
    assert.match(c.reply(), /503/); assert.equal(f.fatals.length, 1);
    assert.match(f.fatals[0], /total deadline exceeded/);
    late("ok"); await flush();
    assert.equal(f.fatals.length, 1, "a late successful lookup cannot undo the failure");
  } finally { await f.broker.close(); }
});

test("HTTP front: closed-client empty lsof race drops the connection without retry or fatal", async () => {
  let done, calls = 0;
  const f = await fixture({ peer: (p, s) => {
    if (p.pid === process.pid) return Promise.resolve("ok");
    calls++;
    return tcpPeerLookup(p, s, { exec: (_f, _a, _o, cb) => { done = cb; } });
  } });
  try {
    const c = raw(f, head(f)); await flush(); c.sock.destroy(); await flush();
    done(Object.assign(new Error("no files"), { code: 1 }), "", ""); await flush();
    assert.equal(calls, 1); assert.deepEqual(f.fatals, []);
    assert.ok(c.sock.destroyed);
  } finally { await f.broker.close(); }
});

function agentFor(f) {
  const agent = new http.Agent({ keepAlive: true });
  agent.createConnection = () => f.network.connect(54321, "127.0.0.1");
  return agent;
}
function request(f, body?, sid?, options = {}) {
  const agent = options.agent ?? agentFor(f);
  return new Promise<any>((resolve, reject) => {
    const req = http.request(f.broker.url, { agent, method: options.method ?? "POST", headers: {
      authorization: `Bearer ${f.broker.env[BROKER_TOKEN_ENV]}`,
      accept: "application/json, text/event-stream", "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18", ...(sid ? { "mcp-session-id": sid } : {}),
      ...options.headers,
    } }, (res) => {
      let text = "";
      res.on("data", (chunk) => text += chunk.toString());
      res.on("error", reject);
      res.on("end", () => {
        clearTimeout(deadline);
        if (!options.agent) agent.destroy();
        let rpc;
        if (text.startsWith("{")) rpc = JSON.parse(text);
        else {
          const data = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
          rpc = data.length === 1 ? data[0] : data;
        }
        resolve({ status: res.statusCode, sid: res.headers["mcp-session-id"], type: res.headers["content-type"], rpc, text });
      });
    });
    const deadline = setTimeout(() => { req.destroy(new Error("memory HTTP request timed out")); }, 5000);
    req.on("error", (err) => { clearTimeout(deadline); if (!options.agent) agent.destroy(); reject(err); });
    req.end(options.rawBody ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "broker-unit", version: "1" } } };
const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status", arguments: {} } };
async function initialized(f) {
  const r = await request(f, init);
  assert.equal(r.status, 200); assert.ok(r.sid); assert.ok(r.rpc.result.serverInfo);
  await request(f, { jsonrpc: "2.0", method: "notifications/initialized" }, r.sid);
  return r.sid;
}

// Codex 0.164.0 and 0.166.0's HTTP adapter accepts JSON-RPC errors even on HTTP
// 4xx. rmcp's service drops id:null errors, leaving await_response pending. An
// HTTP rejection without application/json instead fails the transport send.
// Model just those decisions here; the real broker, Node parser and SDK run above.
function codexFailure(r, id) {
  if (r.status >= 400 && !(r.type?.startsWith("application/json") && r.rpc?.error)) return "HTTP failure";
  if (r.rpc?.error && r.rpc.id === id) return "RPC failure";
  return null;
}

test("HTTP failures: SDK validation errors cannot leave Codex waiting for an id-less response", async () => {
  const f = await fixture();
  try {
    const sid = await initialized(f);
    for (const [headers, status] of [
      [{ "mcp-protocol-version": "unsupported" }, 400],
      [{ accept: "application/json" }, 406],
      [{ "content-type": "text/plain" }, 415],
    ]) {
      const r = await request(f, call, sid, { headers });
      assert.equal(r.status, status);
      assert.ok(r.rpc.error);
      assert.ok(codexFailure(r, call.id), "id:null JSON-RPC errors are dropped by Codex, even on HTTP 4xx");
    }
    assert.ok((await request(f, list, sid)).rpc.result.tools);
  } finally { await f.broker.close(); }
});

test("HTTP failures: unreadable JSON and oversized input fail the outstanding POST without its id", async () => {
  const f = await fixture();
  try {
    for (const options of [{ rawBody: '{"jsonrpc":"2.0","id":3' }, { headers: { "content-length": 9 * 1024 * 1024 } }]) {
      const sid = await initialized(f);
      const r = await request(f, call, sid, options);
      assert.ok(r.rpc.error);
      assert.ok(codexFailure(r, call.id), "an uncorrelatable refusal must fail the HTTP request");
      assert.equal((await request(f, list, sid)).rpc.error.code, -32001);
    }
  } finally { await f.broker.close(); }
});

test("HTTP failures: dispatch exceptions preserve the outstanding tool call's id", async () => {
  const f = await fixture();
  const original = StreamableHTTPServerTransport.prototype.handleRequest;
  StreamableHTTPServerTransport.prototype.handleRequest = function (req, res, body) {
    if (body?.method === "tools/call") throw new Error("fixture dispatch failure");
    return original.call(this, req, res, body);
  };
  try {
    const sid = await initialized(f);
    f.broker.arm();
    const r = await request(f, call, sid);
    assert.equal(r.rpc.id, call.id);
    assert.equal(codexFailure(r, call.id), "RPC failure");
    assert.equal((await request(f, list, sid)).rpc.error.code, -32001);
    assert.deepEqual(f.fatals, []);
  } finally { StreamableHTTPServerTransport.prototype.handleRequest = original; await f.broker.close(); }
});

test("HTTP parser: a malformed request on a reused socket gets a bounded failure and logs its code", async () => {
  const f = await fixture();
  try {
    const c = raw(f, head(f)); await flush();
    assert.match(c.reply(), /HTTP\/1.1 405/);
    c.sock.write("GET /mcp HTTP/1.1\r\nBroken Header\r\n\r\n"); await flush();
    assert.match(c.reply(), /HTTP\/1.1 400 Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n$/);
    assert.ok(f.refusals.some((why) => /HTTP 400.*HPE_INVALID_HEADER_TOKEN/.test(why)));
    f.clock.advance(50); await flush();
    assert.ok(c.sock.destroyed);
    assert.deepEqual(f.fatals, []);
  } finally { await f.broker.close(); }
});

test("HTTP parser: a parse error during an outstanding SSE POST closes it without injecting HTTP headers", async () => {
  let release;
  const waiting = new Promise<void>((resolve) => release = resolve);
  const f = await fixture({ toolHandler: async () => { await waiting; return { content: [{ type: "text", text: "{}" }] }; } });
  try {
    const sid = await initialized(f), body = JSON.stringify(call);
    f.broker.arm();
    const c = raw(f, `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:54321\r\nAuthorization: Bearer ${f.broker.env[BROKER_TOKEN_ENV]}\r\nMcp-Session-Id: ${sid}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await flush();
    assert.match(c.reply(), /HTTP\/1.1 200/);
    assert.match(c.reply(), /content-type: text\/event-stream/i);
    c.sock.write("INVALID\r\n\r\n"); await flush();
    assert.doesNotMatch(c.reply(), /HTTP\/1.1 400/, "a second status line would corrupt the in-flight chunked response");
    assert.ok(c.sock.destroyed, "rmcp fails a POST stream that closes before its final response");
    assert.ok(f.refusals.some((why) => /HPE_INVALID_METHOD/.test(why)));
    assert.equal((await request(f, list, sid)).rpc.error.code, -32001);
    assert.deepEqual(f.fatals, []);
  } finally { release(); await f.broker.close(); }
});

test("HTTP deadlines: handed-off keep-alive sockets enforce the header deadline", { timeout: 6500 }, async () => {
  let release;
  const waiting = new Promise<void>((resolve) => release = resolve);
  const f = await fixture({ toolHandler: async () => { await waiting; return { content: [{ type: "text", text: "{}" }] }; } });
  let timeout, pending;
  try {
    const sid = await initialized(f);
    f.broker.arm();
    pending = request(f, call, sid);
    const c = raw(f, head(f)); await flush();
    assert.match(c.reply(), /HTTP\/1.1 405/);
    const closed = new Promise<void>((resolve, reject) => {
      c.sock.once("close", resolve);
      timeout = setTimeout(() => reject(new Error("headersTimeout did not close the handed-off socket")), 5500);
    });
    c.sock.write("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:54321\r\n");
    await closed;
    assert.match(c.reply(), /HTTP\/1.1 400/);
    assert.ok(f.refusals.some((why) => /ERR_HTTP_REQUEST_TIMEOUT/.test(why)));
    release();
    assert.ok((await pending).rpc.result, "completed headers must allow tools to run beyond the head deadline");
    assert.deepEqual(f.fatals, []);
  } finally { clearTimeout(timeout); release(); await pending?.catch(() => {}); await f.broker.close(); }
});

test("HTTP sessions: initialize/list before arm, calls only while armed, same relay tool definitions", async () => {
  let calls = 0;
  const f = await fixture({ toolHandler: async () => { calls++; return { content: [{ type: "text", text: '{"fixture":true}' }] }; } });
  try {
    const sid = await initialized(f);
    const tools = (await request(f, list, sid)).rpc.result.tools;
    assert.deepEqual(tools, JSON.parse(JSON.stringify(await f.broker.listTools())));
    assert.ok(tools.some((t) => t.name === "delegate"));
    assert.ok(!tools.some((t) => t.name === "approve"));
    assert.equal((await request(f, call, sid)).rpc.error.code, -32001);
    assert.equal(calls, 0);
    f.broker.arm();
    assert.equal(JSON.parse((await request(f, call, sid)).rpc.result.content[0].text).fixture, true);
    assert.equal(calls, 1);
    f.broker.disarm();
    assert.equal((await request(f, call, sid)).rpc.error.code, -32001);
    assert.equal(calls, 1);
    assert.equal(f.broker.sessionsServed(), 1);
    updateTurn(f.turn.turnId, { status: "done" });
    f.broker.arm();
    assert.equal((await request(f, list, sid)).rpc.error.code, -32001);
    await assert.rejects(f.broker.listTools(), /ended/);
  } finally { await f.broker.close(); }
});

test("HTTP sessions: status and a blocking delegate survive another session's readback and DELETE", async () => {
  let release, entered;
  const child = new Promise((r) => release = r), started = new Promise((r) => entered = r);
  const f = await fixture({ toolHandler: async (name) => {
    if (name === "delegate") { entered(); await child; }
    return { content: [{ type: "text", text: JSON.stringify({ message: name === "delegate" ? "stub child done" : "status served" }) }] };
  } });
  let pending;
  try {
    const sid = await initialized(f);
    f.broker.arm();
    assert.equal(JSON.parse((await request(f, call, sid)).rpc.result.content[0].text).message, "status served");
    pending = request(f, { ...call, id: 4, params: { name: "delegate", arguments: {
      target: "claude", mode: "read", task: "fixture child", background: false,
    } } }, sid);
    await started;
    // Readback has its own MCP instance. Closing it must not abort the thread's waiting call.
    const readback = await initialized(f);
    assert.ok((await request(f, list, readback)).rpc.result.tools);
    await request(f, undefined, readback, { method: "DELETE" });
    assert.equal(JSON.parse((await request(f, { ...call, id: 5 }, sid)).rpc.result.content[0].text).message, "status served");
    release();
    assert.equal(JSON.parse((await pending).rpc.result.content[0].text).message, "stub child done");
    assert.ok((await request(f, list, sid)).rpc.result.tools);
    assert.equal(f.broker.sessionsServed(), 2);
    assert.deepEqual(f.fatals, []);
  } finally { release(); try { await pending; } finally { await f.broker.close(); } }
});

test("HTTP sessions: live cap refuses concurrent initialize without eviction; DELETE leaves permanent tombstones", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: BROKER_SESSION_CAP + 4 }, () => request(f, init)));
    const accepted = results.filter((r) => r.sid), refused = results.filter((r) => !r.sid);
    assert.equal(accepted.length, 8); assert.equal(refused.length, 4);
    assert.ok(refused.every((r) => r.status === 200 && r.rpc.error.code === -32001));
    assert.equal((await request(f, list, accepted[0].sid)).rpc.result.tools.length > 0, true);
    const deleted = await request(f, undefined, accepted[0].sid, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    for (const sid of [accepted[0].sid, "never-issued"]) {
      for (const method of ["POST", "GET", "DELETE"]) {
        const r = await request(f, method === "POST" ? call : undefined, sid, { method });
        assert.equal(r.status, 200); assert.equal(r.rpc.error.code, -32001);
      }
    }
    const next = await initialized(f);
    assert.ok(!accepted.some((r) => r.sid === next));
    assert.equal(f.broker.sessionsServed(), 9);
    assert.equal((await request(f, call, accepted[0].sid)).rpc.error.code, -32001);
  } finally { await f.broker.close(); }
});

test("HTTP sessions: an aborted in-flight request retires the id; ordinary connection closure does not", async () => {
  const f = await fixture();
  try {
    const sid = await initialized(f);
    // Prior requests have already closed their TCP connections. The MCP session spans them.
    assert.ok((await request(f, list, sid)).rpc.result.tools);
    const c = raw(f, `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:54321\r\nAuthorization: Bearer ${f.broker.env[BROKER_TOKEN_ENV]}\r\nMcp-Session-Id: ${sid}\r\nContent-Type: application/json\r\nContent-Length: 10000\r\n\r\n{`);
    await flush(); c.sock.destroy(); await flush();
    const replay = await request(f, call, sid);
    assert.equal(replay.status, 200); assert.equal(replay.rpc.error.code, -32001);
    assert.ok((await initialized(f)) !== sid);
  } finally { await f.broker.close(); }
});

test("HTTP sessions: ending the GET stream releases capacity and tombstones only that session", async () => {
  const events = [];
  const f = await fixture({ onSession: (event) => events.push(event) });
  // Exercise both socket shutdown and the SDK adapter finishing its response before close.
  // Capture only GET responses; all transport parsing and server dispatch still run normally.
  const original = StreamableHTTPServerTransport.prototype.handleRequest;
  let response;
  StreamableHTTPServerTransport.prototype.handleRequest = function (req, res, body) {
    if (req.method === "GET") response = res;
    return original.call(this, req, res, body);
  };
  try {
    const parent = await initialized(f);
    for (let i = 0; i < BROKER_SESSION_CAP + 2; i++) {
      const sid = await initialized(f);
      const c = raw(f, head(f, `Mcp-Session-Id: ${sid}\r\nAccept: text/event-stream\r\nMcp-Protocol-Version: 2025-06-18\r\n`));
      await flush();
      assert.equal(response.statusCode, 200);
      assert.match(c.reply(), /Content-Type: text\/event-stream/i);
      if (i % 3 === 0) { await new Promise<void>((resolve) => response.end(resolve)); assert.ok(response.writableFinished); }
      else if (i % 3 === 1) c.sock.end();
      else c.sock.destroy();
      await flush(); await flush();
      assert.equal(events.filter((e) => e.id === sid && e.state === "closed").length, 1);
      assert.equal(events.at(-1).live, 1);
      for (const method of ["GET", "POST", "DELETE"]) {
        const replay = await request(f, method === "POST" ? list : undefined, sid, { method });
        assert.equal(replay.status, 200); assert.equal(replay.rpc.error.code, -32001);
      }
      assert.ok((await request(f, list, parent)).rpc.result.tools);
    }
    assert.equal(f.broker.sessionsServed(), BROKER_SESSION_CAP + 3);
    assert.deepEqual(f.fatals, []);
  } finally {
    StreamableHTTPServerTransport.prototype.handleRequest = original;
    await f.broker.close();
  }
});

test("HTTP sessions: rejected GET requests do not retire an existing session", async () => {
  const f = await fixture();
  try {
    const sid = await initialized(f);
    const denied = await request(f, undefined, sid, { method: "GET", headers: { accept: "application/json" } });
    assert.equal(denied.status, 406);
    assert.ok((await request(f, list, sid)).rpc.result.tools);
  } finally { await f.broker.close(); }
});

test("HTTP sessions: oversized input tombstones the id and never answers 404", async () => {
  const f = await fixture();
  try {
    for (const knownLength of [true, false]) {
      const sid = await initialized(f);
      const body = { ...call, params: { ...call.params, arguments: { pad: "x".repeat(8 * 1024 * 1024) } } };
      const r = await request(f, body, sid, { headers: knownLength ? { "content-length": Buffer.byteLength(JSON.stringify(body)) } : {} });
      assert.equal(r.status, 400); assert.equal(r.rpc.error.code, -32001);
      assert.ok(codexFailure(r, call.id));
      const replay = await request(f, call, sid);
      assert.equal(replay.status, 200); assert.equal(replay.rpc.error.code, -32001);
    }
  } finally { await f.broker.close(); }
});

test("HTTP requests: keep-alive repeats Host, Origin, bearer and duplicate-header checks without another lookup", async () => {
  let checks = 0;
  const f = await fixture({ peer: async () => { checks++; return "ok"; } });
  const agent = agentFor(f);
  try {
    checks = 0;
    const first = await request(f, init, undefined, { agent });
    assert.ok(first.sid); assert.equal(checks, 1);
    assert.ok((await request(f, list, first.sid, { agent })).rpc.result.tools);
    assert.equal(checks, 1);
    const bad = await request(f, list, first.sid, { agent, headers: { authorization: "Bearer wrong" } });
    assert.equal(bad.status, 401); assert.equal(checks, 1);
    for (const [headers, status] of [[{ host: "localhost:54321" }, 421], [{ origin: "null" }, 403], [{ authorization: ["Bearer wrong", "Bearer wrong"] }, 401], [{ "x-duplicate": ["a", "b"] }, 400]]) {
      const a = agentFor(f);
      try {
        assert.ok((await request(f, list, first.sid, { agent: a })).rpc.result.tools);
        const n = checks;
        assert.equal((await request(f, list, first.sid, { agent: a, headers })).status, status);
        assert.equal(checks, n);
      } finally { a.destroy(); }
    }
  } finally { agent.destroy(); await f.broker.close(); }
});

test("HTTP sessions: batch calls and calls disarmed while the body arrives cannot bypass arming", async () => {
  let calls = 0;
  const f = await fixture({ toolHandler: async () => { calls++; return { content: [{ type: "text", text: "{}" }] }; } });
  try {
    const sid = await initialized(f);
    const batch = await request(f, [list, call], sid);
    assert.equal(batch.status, 200);
    assert.ok(batch.rpc.find((r) => r.id === list.id).result.tools);
    assert.equal(batch.rpc.find((r) => r.id === call.id).error.code, -32001);
    f.broker.arm();
    const body = JSON.stringify(call);
    const c = raw(f, `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:54321\r\nAuthorization: Bearer ${f.broker.env[BROKER_TOKEN_ENV]}\r\nMcp-Session-Id: ${sid}\r\nMcp-Protocol-Version: 2025-06-18\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, -1)}`);
    await flush(); f.broker.disarm(); c.sock.write(body.slice(-1)); await flush();
    assert.match(c.reply(), /"code":-32001/);
    assert.equal(calls, 0);
  } finally { await f.broker.close(); }
});

test("HTTP sessions: DELETE while a call body arrives answers a tombstone error with its id, never 404", async () => {
  const f = await fixture();
  try {
    const sid = await initialized(f), body = JSON.stringify(call);
    const c = raw(f, `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:54321\r\nAuthorization: Bearer ${f.broker.env[BROKER_TOKEN_ENV]}\r\nMcp-Session-Id: ${sid}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, -1)}`);
    await flush(); await request(f, undefined, sid, { method: "DELETE" });
    c.sock.write(body.slice(-1)); await flush();
    assert.match(c.reply(), /HTTP\/1.1 200/);
    assert.match(c.reply(), /"id":3,"error":\{"code":-32001/);
    assert.doesNotMatch(c.reply(), /HTTP\/1.1 404/);
  } finally { await f.broker.close(); }
});

test("HTTP front: an operational result is fatal even when the token holder disconnects during lookup", async () => {
  let release, calls = 0;
  const failure = { error: "partial output plus exit 1" };
  const f = await fixture({ peer: async (p) => {
    if (p.pid === process.pid) return "ok";
    if (++calls === 1) return new Promise((r) => release = r);
    return failure;
  } });
  try {
    const c = raw(f, head(f)); await flush(); c.sock.destroy(); await flush();
    release(failure); await flush();
    assert.equal(calls, 2);
    assert.equal(f.fatals.length, 1);
  } finally { await f.broker.close(); }
});

test("HTTP holders: all three exact exclusive listener shapes, wildcard destruction and unexpected loss is fatal", async () => {
  for (const lost of [0, 1, 2]) {
    const f = await fixture();
    try {
      assert.deepEqual(f.network.servers.map((s) => s.options), [
        { host: "127.0.0.1", port: 54321, exclusive: true, reusePort: false },
        { host: "0.0.0.0", port: 54321, exclusive: true, reusePort: false },
        { host: "::", port: 54321, exclusive: true, reusePort: false, ipv6Only: false },
      ]);
      for (const holder of f.network.servers.slice(1)) {
        const c = new MemorySocket(), s = new MemorySocket(); c.other = s; s.other = c;
        holder.emit("connection", s); assert.ok(s.destroyed);
      }
      f.network.servers[lost].emit("close");
      assert.equal(f.fatals.length, 1);
      f.network.servers[lost].emit("error", new Error("lost"));
      assert.equal(f.fatals.length, 1);
    } finally { await f.broker.close(); }
    assert.ok(f.network.servers.every((s) => !s.listening));
    assert.equal(f.clock.jobs.size, 0);
    assert.equal(f.fatals.length, 1);
    await f.broker.close();
  }
});

test("HTTP opening: every listener bind and the peer self-check must succeed, with cleanup on failure", async () => {
  for (const bad of [0, 1, 2, "self"]) {
    const network = new MemoryNetwork(), clock = new Clock();
    if (typeof bad === "number") {
      const create = network.createServer;
      network.createServer = (opts, accept) => {
        const s = create(opts, accept);
        if (network.servers.length - 1 === bad) s.listen = () => { queueMicrotask(() => s.emit("error", new Error("bind failed"))); return s; };
        return s;
      };
    }
    await assert.rejects(withTurnSecrets(() => openHttpBroker(turn(), 54321, {
      network, clock, onRefusal() {}, processMatches: () => true,
      peer: async () => bad === "self" ? { error: "broken self check" } : "ok",
    })), /bind failed|self-check failed/);
    assert.ok(network.servers.every((s) => !s.listening));
    assert.equal(clock.jobs.size, 0);
  }
});

test("HTTP identity: binding is once-only and copied; identity is fresh after every lookup", async () => {
  let valid = true;
  let observed;
  const f = await fixture({ bind: false, processMatches: (p) => valid && p.pid === app.pid && p.start === app.start,
    peer: async (p) => { if (p.pid !== process.pid) observed = p; return "ok"; } });
  try {
    const unbound = raw(f, head(f)); await flush(); assert.match(unbound.reply(), /403/);
    assert.throws(() => f.broker.bindAppServer({ ...app, start: "stale" }), /cannot bind/);
    const mutable = { ...app };
    f.broker.bindAppServer(mutable);
    mutable.pid++; mutable.start = "changed";
    assert.throws(() => f.broker.bindAppServer(app), /already bound/);
    valid = false;
    const c = raw(f, head(f)); await flush();
    assert.match(c.reply(), /403/);
    assert.deepEqual(observed, app);
    assert.equal(f.fatals.length, 0);
  } finally { await f.broker.close(); }
});

test("HTTP front: non-127.0.0.1 arrivals are destroyed without lookup", async () => {
  let checks = 0;
  const f = await fixture({ peer: async () => { checks++; return "ok"; } });
  try {
    checks = 0;
    const c = raw(f, head(f)); f.network.sockets.at(-1).localAddress = "::ffff:127.0.0.1";
    await flush(); assert.ok(c.sock.destroyed); assert.equal(checks, 0);
  } finally { await f.broker.close(); }
});

/** Integration tests use only a fresh ephemeral port. Skip only the sandbox's bind denial. */
async function loopbackPort(t) {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as net.AddressInfo).port;
    assert.ok(port > 20000, "an ephemeral port, never a service port");
    return port;
  } catch (err) {
    if (["EPERM", "EACCES"].includes(err.code)) { t.skip(`loopback bind unavailable: ${err.code}`); return null; }
    throw err;
  } finally { if (server.listening) await new Promise<void>((r) => server.close(() => r())); }
}

// Node's reusePort:true requests libuv's load-balancing variant, unsupported on Darwin.
// It returns ENOTSUP before bind(), which proves nothing about the holders. Use native
// SO_REUSEADDR/SO_REUSEPORT as the design's independent B6 probe did. Distinguish option,
// bind and listen failures; only EADDRINUSE from bind proves the desired exclusion.
const NATIVE_BIND = String.raw`
import errno, json, socket, sys
family, host, port, reuse_addr, reuse_port, v6_only = sys.argv[1:]
s = socket.socket(socket.AF_INET6 if family == "6" else socket.AF_INET, socket.SOCK_STREAM)
stage = "options"
try:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, int(reuse_addr))
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, int(reuse_port))
    if family == "6":
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, int(v6_only))
    stage = "bind"
    s.bind((host, int(port)))
    stage = "listen"
    s.listen(1)
    print(json.dumps({"stage": stage, "bound": True}))
except OSError as e:
    print(json.dumps({"stage": stage, "error": errno.errorcode.get(e.errno, str(e.errno))}))
finally:
    s.close()
`;
const squatterShapes = [[4, "127.0.0.1", false], [4, "0.0.0.0", false], [6, "::", false], [6, "::", true], [6, "::ffff:127.0.0.1", false]] as const;
const squatterCases = squatterShapes.flatMap(([family, host, ipv6Only]) =>
  [false, true].flatMap((reuseAddr) => [false, true].map((reusePort) => ({ family, host, ipv6Only, reuseAddr, reusePort }))));
async function nativeBind(c: typeof squatterCases[number], port: number) {
  const args = [String(c.family), c.host, String(port), String(Number(c.reuseAddr)), String(Number(c.reusePort)), String(Number(c.ipv6Only))];
  const out = await new Promise<string>((resolve, reject) => {
    // The timeout only stops a hung probe. /usr/bin/python3 is the developer-tools shim, and its
    // first start on a fresh machine (xcrun finding the toolchain, Python loading cold) took over
    // 5 s on a GitHub macOS runner, killing the very first positive control before it ran.
    execFile("/usr/bin/python3", ["-I", "-c", NATIVE_BIND, ...args], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 60_000, maxBuffer: 8192, encoding: "utf8",
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  return JSON.parse(out);
}

test("HTTP holders integration: real wildcard holders prevent squatters and destroy IPv6 arrivals", { skip: process.platform !== "darwin" && "Darwin listener semantics" }, async (t) => {
  const port = await loopbackPort(t); if (port === null) return;
  // Each of the 20 socket configurations must really work on a free ephemeral port.
  // ENOTSUP, a missing interpreter or a broken probe cannot masquerade as holder evidence.
  for (const c of squatterCases) {
    assert.deepEqual(await nativeBind(c, 0), { stage: "listen", bound: true }, `free-port positive control ${JSON.stringify(c)}`);
  }
  const broker = await withTurnSecrets(() => openHttpBroker(turn(), port, { onRefusal() {} }));
  try {
    for (const c of squatterCases) {
      assert.deepEqual(await nativeBind(c, port), { stage: "bind", error: "EADDRINUSE" }, `holders must exclude ${JSON.stringify(c)}`);
    }
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(port, "::1"); let received = false;
      const deadline = setTimeout(() => { s.destroy(); reject(new Error("wildcard holder did not close")); }, 3000);
      s.on("data", () => received = true);
      s.on("error", (err) => { if (err.code !== "ECONNRESET") reject(err); });
      s.once("close", () => { clearTimeout(deadline); assert.equal(received, false); resolve(); });
    });
  } finally { await broker.close(); }
});

test("HTTP peer integration: real lsof sees both ends, classifies foreign, and requires its own end", { skip: process.platform !== "darwin" && "Darwin lsof" }, async (t) => {
  const port = await loopbackPort(t); if (port === null) return;
  let accepted: net.Socket;
  const server = net.createServer();
  const connection = new Promise<net.Socket>((r) => server.once("connection", r));
  await new Promise<void>((r, j) => { server.once("error", j); server.listen(port, "127.0.0.1", r); });
  const client = net.connect(port, "127.0.0.1");
  client.on("error", () => {});
  try {
    accepted = await connection;
    assert.equal(await tcpPeerLookup({ pid: process.pid, start: "self" }, accepted), "ok");
    assert.equal(await tcpPeerLookup(app, accepted), "foreign");
    const missing = await tcpPeerLookup({ pid: process.pid, start: "self" }, { localPort: port + 1, remotePort: accepted.remotePort });
    assert.equal(typeof missing, "object");
  } finally { client.destroy(); accepted?.destroy(); await new Promise<void>((r) => server.close(() => r())); }
});
