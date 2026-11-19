import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { scratchOnly, until } from "./helpers.ts";
import { withDefaults } from "../dist/core/config.js";
import { createRun, db, insertNode, insertTurn } from "../dist/core/db.js";
import { newInstance } from "../dist/core/caller.js";
import { relayServer } from "../dist/mcp/server.js";
import { hostProfile } from "../dist/mcp/host.js";
import { codexToolTimeoutS } from "../dist/targets/codex.js";
import { waitOpts } from "../dist/core/wait.js";
import { PassThrough, Writable } from "node:stream";
import { RelayStdioTransport } from "../dist/mcp/stdio.js";

const home = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-event-delivery-"))));
process.env.RELAY_HOME = home;
process.env.RELAY_CONFIG = path.join(home, "config.json");
process.env.CODEX_HOME = path.join(home, "codex");
fs.mkdirSync(process.env.CODEX_HOME);
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const CODEX = { name: "codex-mcp-client", version: "0.163.0" };
const CLAUDE = { name: "claude-code", version: "2.1.302" };
let n = 0;

type WriteGate = { entered: boolean; finished: boolean; release: Promise<void>; fail: boolean };

async function session(o: { gate?: WriteGate; timeout?: number; blockS?: number; child?: boolean; env?: Record<string, string>; client?: typeof CODEX } = {}) {
  const oldEnv = { ...process.env };
  Object.assign(process.env, o.env);
  const cfg = withDefaults({ block_s: o.blockS ?? 4000, approval_timeout_s: 60 });
  fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify(cfg));
  fs.writeFileSync(path.join(process.env.CODEX_HOME!, "config.toml"), `[mcp_servers.relay]\n${o.timeout === undefined ? "" : `tool_timeout_sec = ${o.timeout}\n`}`);
  const inst = newInstance({ kind: "root" }, home, o.client?.name === "claude-code" ? "claude" : "codex");
  const run = createRun(home, cfg, inst.token);
  inst.runId = run;
  inst.since.set(run, 0);
  const slow = `j_ed${String(++n).padStart(6, "0")}`;
  insertNode({ id: slow, run_id: run, kind: "job", target: "codex", mode: "read", task: "pending", depth: 1, cwd: home, status: "running" });
  const turnId = insertTurn(slow, "test", "pending", "read", "running");
  if (o.child) {
    inst.ctx = { kind: "child", runId: run, nodeId: slow, turnId, depth: 1, access: "read", mayDelegate: true, mayAsk: true };
  }
  const event = Number(db().prepare("INSERT INTO events (run_id, key, kind, item_id, subject, text, created_at) VALUES (?, ?, 'late', ?, ?, 'pending news', ?)").run(run, `test-${n}`, slow, slow, Date.now()).lastInsertRowid);
  const server = relayServer(inst);
  const [wire, clientWire] = InMemoryTransport.createLinkedPair();
  const send = wire.send.bind(wire);
  wire.send = async (message, options) => {
    if (o.gate && "result" in message && "content" in message.result) {
      o.gate.entered = true;
      await o.gate.release;
      try {
        if (o.gate.fail) throw new Error("write failed");
        await send(message, options);
      } finally { o.gate.finished = true; }
    } else await send(message, options);
  };
  const client = new Client(o.client ?? CODEX);
  await Promise.all([server.connect(wire), client.connect(clientWire)]);
  // The host profile is built before the server answers anything after initialize (a Codex
  // client's waits come from its registration, read once that module is loaded): one round trip.
  await client.ping();
  const seen = () => db().prepare("SELECT seen_at FROM events WHERE id = ?").get(event)!.seen_at;
  const call = async (wait_s = 0, signal?: AbortSignal) => {
    const r = await client.callTool({ name: "status", arguments: { id: slow, wait_s } }, undefined, { signal, timeout: 10000 });
    return JSON.parse((r.content as { text: string }[])[0].text);
  };
  return { inst, run, slow, event, wire, clientWire, client, seen, call, async close() {
    await client.close();
    await server.close();
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  } };
}

test("Codex root: a 60 s registration caps the whole call below 60 s and returns its events", async (t) => {
  const s = await session({ timeout: 60 });
  try {
    assert.equal(s.inst.host.waitCapS, 50);
    t.mock.timers.enable({ apis: ["Date"] });
    const result = s.call(300);
    await until(() => s.inst.waiting.size > 0, 1000, "the status wait");
    t.mock.timers.tick(50_000);
    const r = await result;
    assert.match(r.wait_ended, /after 50 s/);
    assert.deepEqual(r.events.map((e: { event_id: number }) => e.event_id), [s.event]);
    await until(() => s.seen() !== null, 1000, "transport acknowledgement");
    assert.equal((await s.call()).events, undefined);
  } finally { t.mock.timers.reset(); await s.close(); }
});

test("launched Codex: its own registration, rather than the root's file, caps waits below its approval and overlay timeout", async () => {
  const s = await session({ timeout: 60, blockS: 8000, child: true });
  try {
    const registrationS = codexToolTimeoutS(60);
    assert.equal(registrationS, 7500);
    assert.equal(s.inst.host.waitCapS, 7490);
    assert.ok(s.inst.host.waitCapS! < registrationS, "a launched agent's wait stays below its own MCP registration");
    assert.equal(waitOpts(s.inst, s.run, {}, { seconds: 8000 }).ms, 7490_000);
  } finally { await s.close(); }
});

for (const outcome of ["written", "cancelled", "failed", "closed"] as const) {
  test(`event acknowledgement waits for the transport: ${outcome}`, async () => {
    let resume!: () => void;
    const gate: WriteGate = { entered: false, finished: false, release: new Promise<void>(resolve => { resume = resolve; }), fail: false };
    // Interpose below relay's transport wrapper: the handler has returned, but the response has
    // not been written. This catches marking in reply(), including its cancellation race.
    const s = await session({ timeout: 60, gate });
    const ctl = new AbortController();
    const answer = s.call(0, ctl.signal).then(r => r, () => null);
    try {
      await until(() => gate.entered, 1000, "the prepared response");
      assert.equal(s.seen(), null, "preparing a reply does not give away its events");
      if (outcome === "cancelled") {
        ctl.abort();
        await answer;
        // Let the server receive the cancellation before the write finishes.
        await new Promise<void>(r => setImmediate(r));
      }
      if (outcome === "closed") await s.client.close();
      if (outcome === "failed") gate.fail = true;
      resume();
      await until(() => gate.finished, 1000, "the write to settle");
      if (outcome === "written") {
        assert.deepEqual((await answer).events.map((e: { event_id: number }) => e.event_id), [s.event]);
        await until(() => s.seen() !== null, 1000, "the events to be acknowledged");
        assert.equal((await s.call()).events, undefined);
      } else {
        assert.equal(s.seen(), null);
        gate.fail = false;
        if (outcome === "failed") ctl.abort();
        if (outcome !== "closed") assert.equal((await s.call()).events[0].event_id, s.event);
      }
    } finally { resume(); ctl.abort(); await answer; await s.close(); }
  });
}

for (const outcome of ["written", "cancelled", "failed", "closed"] as const) {
  test(`C5: approval handoff waits for transport delivery: ${outcome}`, async () => {
    let resume!: () => void;
    const gate: WriteGate = { entered: false, finished: false, release: new Promise<void>(resolve => { resume = resolve; }), fail: false };
    const s = await session({ timeout: 60, gate });
    const approval = `q_${s.run.slice(4)}`;
    db().prepare("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES (?, ?, ?, 'command', 'pending command', 'pending', ?)").run(approval, s.run, s.slow, Date.now());
    const ctl = new AbortController();
    const answer = s.call(300, ctl.signal).then(r => r, () => null);
    try {
      await until(() => gate.entered, 1000, "the prepared approval response");
      assert.equal(s.inst.handedOff.has(approval), false);
      if (outcome === "cancelled") {
        ctl.abort();
        await answer;
        await new Promise<void>(r => setImmediate(r));
      }
      if (outcome === "closed") await s.client.close();
      if (outcome === "failed") gate.fail = true;
      resume();
      await until(() => gate.finished, 1000, "the approval write to settle");
      if (outcome === "written") {
        assert.equal((await answer).needs_approval[0].request_id, approval);
        await until(() => s.inst.handedOff.has(approval), 1000, "the successful handoff");
      } else {
        assert.equal(s.inst.handedOff.has(approval), false);
        gate.fail = false;
        if (outcome === "failed") ctl.abort();
        if (outcome !== "closed") assert.equal((await s.call(300)).needs_approval[0].request_id, approval, "the replacement wait returns for the undelivered request");
      }
    } finally { resume(); ctl.abort(); await answer; await s.close(); }
  });
}

test("unattended Claude auto-background: cap below the documented default and custom threshold", () => {
  for (const entry of [{ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { CLAUDE_CODE_SESSION_ATTENDED: "0" }]) {
    const env = { ...entry, CLAUDE_AUTO_BACKGROUND_TASKS: "1" };
    assert.equal(hostProfile(env, CLAUDE, false).waitCapS, 110);
    assert.equal(hostProfile({ ...env, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "30000" }, CLAUDE, false).waitCapS, 25);
  }
});

test("unattended Claude: the capped result arrives with its events before auto-backgrounding", async (t) => {
  const s = await session({ client: CLAUDE, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_AUTO_BACKGROUND_TASKS: "1" } });
  try {
    assert.equal(s.inst.host.waitCapS, 110);
    t.mock.timers.enable({ apis: ["Date"] });
    const result = s.call(300);
    await until(() => s.inst.waiting.size > 0, 1000, "the status wait");
    t.mock.timers.tick(110_000);
    const r = await result;
    assert.match(r.wait_ended, /after 110 s/);
    assert.equal(r.events[0].event_id, s.event);
  } finally { t.mock.timers.reset(); await s.close(); }
});

test("hosts without the hazardous mode, and disabled auto-backgrounding, retain their waits", () => {
  for (const env of [
    {}, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
    { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_AUTO_BACKGROUND_TASKS: "1" },
    { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_AUTO_BACKGROUND_TASKS: "0" },
    { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_AUTO_BACKGROUND_TASKS: "1", CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" },
    { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_AUTO_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
  ]) assert.equal(hostProfile(env, CLAUDE, false).waitCapS, null, JSON.stringify(env));
  assert.equal(hostProfile({ CLAUDE_AUTO_BACKGROUND_TASKS: "1" }, { name: "other", version: "1" }, false).waitCapS, null);
});

test("stdio send resolves after the write callback, and rejects a failed write", async () => {
  let written!: (error?: Error | null) => void;
  const stdout = new Writable({ write(_chunk, _encoding, callback) { written = callback; } });
  const transport = new RelayStdioTransport(new PassThrough(), stdout);
  let acknowledged = false;
  const sent = transport.send({ jsonrpc: "2.0", id: 1, result: {} }).then(() => { acknowledged = true; });
  await new Promise<void>(r => setImmediate(r));
  assert.equal(acknowledged, false, "buffer acceptance is not a completed write");
  written();
  await sent;
  const failed = transport.send({ jsonrpc: "2.0", id: 2, result: {} });
  written(new Error("broken output"));
  await assert.rejects(failed, /broken output/);
  await transport.close();
});
