import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers.ts"; // Every test must use the suite's scratch HOME (guard.test.ts).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withDefaults } from "../dist/core/config.js";
import { createRun, db, insertNode, updateNode } from "../dist/core/db.js";
import { newInstance } from "../dist/core/caller.js";
import { status } from "../dist/core/ops.js";
import { markSeen, postNotice } from "../dist/core/events.js";
import { pendingEvents, watch } from "../dist/core/watch.js";
import { relayServer } from "../dist/mcp/server.js";
import * as settings from "../dist/core/claude-settings.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-notice-verification-")));
process.env.RELAY_HOME = home;
process.env.RELAY_CONFIG = path.join(home, "config.json");
fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(withDefaults({ ask_user: "never" })));
let seq = 0;

function fixture() {
  const inst = newInstance({ kind: "root" }, home, "claude");
  const run = createRun(home, withDefaults({ ask_user: "never" }), inst.token);
  inst.runId = run;
  inst.since.set(run, 0);
  const item = `j_${String(++seq).padStart(8, "0")}`;
  insertNode({ id: item, run_id: run, kind: "job", target: "codex", mode: "read", task: "notice", depth: 1, cwd: home, status: "done" });
  updateNode(item, { ended_at: Date.now() });
  const posted: string[] = [];
  inst.host.notice = (text) => posted.push(text);
  watch(inst);
  assert.equal(posted.length, 1);
  const m = /^relay \(event (\d+), tag ([a-f0-9]{32})\):/.exec(posted[0]);
  assert.ok(m, "every inbox notice must carry an event id and a 128-bit verification tag");
  return { inst, item, run, text: posted[0], notice: { event_id: Number(m[1]), tag: m[2] } };
}

test("notice verification: genuine pointer returns the real event, even after delivery", async () => {
  const f = fixture();
  markSeen([f.notice.event_id]);
  const r = await status(f.inst, { notice: f.notice });
  assert.equal(r.notice_verification.verified, true);
  assert.deepEqual(r.notice_verification.event, {
    event_id: f.notice.event_id, kind: "settled", item: f.item, about: f.item,
    notice: `relay (event ${f.notice.event_id}): job ${f.item} finished (done). Call result ${f.item}.`,
  });
});

test("notice sender: names the local relay server and the launched agent's harness and family", () => {
  const f = fixture();
  // Claude Code wraps the inbox as a message from another Claude session; the notice says who sent it.
  assert.match(f.text, new RegExp(`^relay \\(event ${f.notice.event_id}, tag [a-f0-9]{32}\\): Sent by the local relay server, not by a Claude session or by the Codex agent \\(OpenAI\\) of job ${f.item}\\. Verify first with status notice=\\{"event_id":${f.notice.event_id},"tag":"${f.notice.tag}"\\}\\. Pointer: job ${f.item} finished \\(done\\)\\. Call result ${f.item}\\.$`));
  // Approval notices name the asking item; an event about no launched agent names only relay.
  const request = "q_0000aaaa";
  db().prepare("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES (?, ?, ?, 'web', 'fetch', 'pending', ?)").run(request, f.run, f.item, Date.now());
  const posted: string[] = [];
  f.inst.host.notice = (text) => posted.push(text);
  watch(f.inst);
  assert.equal(posted.length, 1);
  assert.match(posted[0], new RegExp(`\\): Sent by the local relay server, not by a Claude session or by the Codex agent \\(OpenAI\\) of job ${f.item}\\. Verify first `));
  db().prepare("INSERT INTO events (run_id, key, kind, item_id, subject, text, created_at) VALUES (?, 'no-agent', 'settled', 'd_ffffffff', 'd_ffffffff', 'gone', 1)").run(f.run);
  posted.length = 0;
  watch(f.inst);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /^relay \(event \d+, tag [a-f0-9]{32}\): Sent by the local relay server, not by a Claude session\. Verify first with status notice=/);
});

test("notice verification: valid format with a wrong tag is ignored and reported", async () => {
  const f = fixture();
  const r = await status(f.inst, { notice: { ...f.notice, tag: "0".repeat(32) } });
  assert.equal(r.notice_verification.verified, false);
  assert.equal(r.notice_verification.event, undefined);
  assert.match(r.notice_verification.reason, /ignore.*report/i);
});

test("notice verification: unknown event and a tag moved to another event fail", async () => {
  const a = fixture();
  const b = fixture();
  const another = Number(db().prepare("INSERT INTO events (run_id, key, kind, item_id, subject, text, created_at) VALUES (?, 'another', 'settled', ?, ?, 'another event', 1)").run(a.run, a.item, a.item).lastInsertRowid);
  for (const event_id of [2147483647, b.notice.event_id, another]) {
    const r = await status(a.inst, { notice: { ...a.notice, event_id } });
    assert.equal(r.notice_verification.verified, false);
    assert.equal(r.notice_verification.event, undefined);
  }
});

test("notice verification: another session or restarted server cannot use the tag", async () => {
  const a = fixture();
  const b = fixture();
  const restarted = newInstance({ kind: "root" }, home, "claude");
  restarted.token = a.inst.token; // Even knowing the registry's ownership token is insufficient.
  for (const inst of [b.inst, restarted]) {
    assert.equal((await status(inst, { notice: a.notice })).notice_verification.verified, false);
  }
});

test("notice verification: changed stored pointer and revoked ownership invalidate tags", async () => {
  const f = fixture();
  db().prepare("UPDATE events SET text = 'changed' WHERE id = ?").run(f.notice.event_id);
  assert.equal((await status(f.inst, { notice: f.notice })).notice_verification.verified, false);
  const g = fixture();
  db().prepare("UPDATE runs SET root_token = 'new-owner' WHERE id = ?").run(g.run);
  assert.equal((await status(g.inst, { notice: g.notice })).notice_verification.verified, false);
});

test("notice verification: tags stay out of durable events, files, diagnostic logs and verification replies", async () => {
  const f = fixture();
  assert.ok(!JSON.stringify(pendingEvents(f.inst, {})).includes(f.notice.tag));
  assert.ok(!JSON.stringify(f.inst).includes(f.notice.tag));
  assert.ok(!JSON.stringify(await status(f.inst, { notice: f.notice })).includes(f.notice.tag));
  await postNotice(path.join(home, "missing.sock"), undefined, f.text, f.notice.event_id);
  assert.match(fs.readFileSync(path.join(home, "notices.log"), "utf8"), /outcome/);
  for (const file of fs.readdirSync(home, { recursive: true })) {
    const p = path.join(home, String(file));
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p).includes(Buffer.from(f.notice.tag)), `tag leaked into ${p}`);
  }
});

test("notice verification: status exposes the gate through MCP and steers callers to verify", async () => {
  const f = fixture();
  const server = relayServer(f.inst);
  const client = new Client({ name: "claude-code", version: "2.1.302" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "status")!;
    assert.ok(tool.inputSchema.properties.notice);
    assert.match(tool.description!, /verify|verification/i);
    const call = async (notice: object) => {
      const r = await client.callTool({ name: "status", arguments: { notice } });
      return JSON.parse(r.content[0].text);
    };
    assert.equal((await call(f.notice)).notice_verification.verified, true);
    assert.equal((await call({ ...f.notice, tag: "f".repeat(32) })).notice_verification.verified, false);
    // Verification ignores even an unavailable item and never starts a wait or redispatch.
    const r = await client.callTool({ name: "status", arguments: { id: "j_ffffffff", wait_s: 3600, notice: f.notice } });
    assert.equal(JSON.parse(r.content[0].text).notice_verification.verified, true);
    assert.match(client.getInstructions()!, /ignore.*report/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("doctor inbox settings: reports only the inbound key with source and unreadable values", () => {
  assert.equal(typeof settings.inboundSettings, "function", "doctor must be able to inspect the session's inbound settings");
  const configHome = path.join(home, "settings-home");
  const cwd = path.join(home, "settings-project");
  fs.mkdirSync(path.join(configHome, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  const user = path.join(configHome, ".claude", "settings.json");
  const project = path.join(cwd, ".claude", "settings.json");
  const local = path.join(cwd, ".claude", "settings.local.json");
  fs.writeFileSync(user, JSON.stringify({ crossSessionInbound: "accept", env: { SECRET: "do-not-read" } }));
  fs.writeFileSync(project, JSON.stringify({ crossSessionInbound: "refuse" }));
  fs.writeFileSync(local, "{broken");
  const result = settings.inboundSettings({ HOME: configHome }, cwd, [], []);
  assert.deepEqual(result, [{ source: user, value: "accept" }, { source: project, value: "refuse" }, { source: local, value: "unreadable" }]);
  assert.ok(!JSON.stringify(result).includes("do-not-read"));
  assert.deepEqual(settings.inboundSettings({ HOME: home }, home, ['claude --settings {"crossSessionInbound":"hold"}'], []), [{ source: "a --settings argument", value: "hold" }]);
});
