import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import net from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfigSchema, configDeprecations, loadConfig, withDefaults } from "../dist/core/config.js";
import { newInstance } from "../dist/core/caller.js";
import { relayServer } from "../dist/mcp/server.js";
import { closeDbForTests, createRun, db, getNode, insertNode, SCHEMA_VERSION } from "../dist/core/db.js";
import { nodeView } from "../dist/core/views.js";
import { postNotice } from "../dist/core/events.js";
import { signedNotice } from "../dist/core/notices.js";
import { pendingEvents } from "../dist/core/watch.js";
import { TESTED_MACOS, testedMacOS } from "../dist/install/doctor.js";
import { targetDef } from "../dist/targets/index.js";
import { CLI } from "./helpers.ts";
import { createHash } from "node:crypto";
import * as rooms from "../dist/core/rooms.js";
import * as R from "../dist/core/room-types.js";
import { roomText } from "../dist/core/shown.js";

const fixtures = path.join(import.meta.dirname, "fixtures", "stable-surfaces");
function snapshot(name: string, value: unknown) {
  const file = path.join(fixtures, name);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
  if (process.env.RELAY_UPDATE_SNAPSHOTS === "1") {
    fs.mkdirSync(fixtures, { recursive: true });
    fs.writeFileSync(file, text);
  }
  assert.ok(fs.existsSync(file), `record ${name} with RELAY_UPDATE_SNAPSHOTS=1`);
  assert.equal(text, fs.readFileSync(file, "utf8"));
}

test("stable surfaces: room views, caller cursors, endings and refusals", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-room-surface-"));
  const saved = process.env.RELAY_HOME;
  const at = Date.parse("2026-11-11T18:00:00.000Z");
  const roomId = `rm_${"0".repeat(32)}`;
  const members = [`m_${"1".repeat(32)}`, `m_${"2".repeat(32)}`];
  const invites = [`ri1_${"3".repeat(32)}`, `ri1_${"4".repeat(32)}`];
  const call: R.RoomCallEvidence = {
    identity: { call_id: "fixture-call", scope: "conversation-token", harness: "fixture-host", family: "openai", subagent: false, singleton_violation: false,
      codex: { malformed: false, metadata_present: false, thread_id: null, thread_source: null, turn_trigger: null, originator: null, sandbox: null, auto_review: null, approval_policy: null } },
    eligibility: { eligible: true }, block_s: 50, host_wait_cap_s: null, sanitizeText: roomText,
  };
  const success = <T,>(value: T): Exclude<T, R.RoomFailure> => {
    assert.ok(value && typeof value === "object" && !("error" in value) && !("refused" in value), JSON.stringify(value));
    return value as Exclude<T, R.RoomFailure>;
  };
  try {
    closeDbForTests();
    process.env.RELAY_HOME = tmp;
    t.mock.method(Date, "now", () => at);
    const a = newInstance({ kind: "root" }, tmp, "codex"), b = newInstance({ kind: "root" }, tmp, "claude");
    // Shared owners keep process-table details out of the fixture. Protocol admission is
    // supplied explicitly; host eligibility has its own table-driven tests.
    a.carried = b.carried = true;
    const seed = () => {
      for (const table of ["room_messages", "room_invites", "room_bindings", "room_members", "rooms", "room_exposures"]) db().prepare(`DELETE FROM ${table}`).run();
      db().prepare("INSERT INTO rooms (id,state,created_at,expires_at,max_turns,origin) VALUES (?,'waiting',?,?,24,'terminal')").run(roomId, at, at + R.ROOM_LIFETIME_MS);
      members.forEach((id, i) => {
        db().prepare("INSERT INTO room_members (room_id,id,ordinal) VALUES (?,?,?)").run(roomId, id, i + 1);
        const hash = createHash("sha256").update(R.ROOM_INVITE_DOMAIN).update(invites[i]).digest("hex");
        db().prepare("INSERT INTO room_invites (code_hash,room_id,member_id,generation,expires_at) VALUES (?,?,?,1,?)").run(hash, roomId, id, at + R.ROOM_INVITE_LIFETIME_MS);
      });
    };
    const join = (owner: typeof a, invite: string) => rooms.roomJoin(owner, { action: "join", invite }, call);
    const pair = async () => { seed(); success(await join(a, invites[0])); success(await join(b, invites[1])); };
    const send = (owner: typeof a, cursor: number, stance: R.RoomStance, n: number) => rooms.roomSend(owner, {
      action: "send", cursor, text: "A bounded recommendation.", stance, request_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    }, call);
    const wait = (owner: typeof a, cursor: number) => rooms.roomWait(owner, { action: "wait", cursor, wait_s: 0 }, call);
    const results: Record<string, unknown> = {};
    seed();
    results.waiting = success(await join(a, invites[0]));
    results.repeated_join = success(await join(a, invites[0]));
    results.open = success(await join(b, invites[1]));
    results.empty_wait = success(await wait(b, 0));
    results.send = success(await send(a, 0, "continue", 1));
    results.repeated_send = success(await send(a, 0, "continue", 1));
    const message = success(await wait(b, 0));
    assert.equal(message.user_confirmed_ignored, true);
    assert.equal(message.messages[0].sender.member_id, members[0]);
    results.member_message = message;
    success(rooms.roomAddLine(roomId as R.RoomId, "A line from a terminal.", roomText));
    const terminal = success(await wait(b, 1));
    assert.equal(terminal.messages[0].sender.member_id, null);
    results.terminal_line = terminal;
    const page = success(await rooms.roomTranscript(a, { action: "transcript", cursor: 0 }, call));
    assert.equal(page.remaining, 1);
    assert.equal(page.through_seq, 1);
    results.transcript_page = page;
    const refused = await send(b, 0, "continue", 2);
    assert.ok("refused" in refused && "messages" in refused);
    results.refusal_with_view = refused;
    results.refusal = await rooms.roomWait(b, { action: "wait", cursor: -1 }, call);
    results.unavailable = await join(a, `ri1_${"f".repeat(32)}`);
    assert.deepEqual(results.unavailable, { error: R.ROOM_UNAVAILABLE_ERROR, recovery: R.ROOM_UNAVAILABLE_RECOVERY });

    await pair();
    success(await send(a, 0, "agree", 1));
    results.agreement = success(await send(b, 1, "agree", 2));
    await pair();
    success(await send(a, 0, "crux", 1));
    results.crux = success(await send(b, 1, "continue", 2));
    await pair();
    db().prepare("UPDATE rooms SET turns = 23 WHERE id = ?").run(roomId);
    results.turn_limit = success(await send(a, 0, "continue", 1));
    await pair();
    results.member_close = success(await rooms.roomClose(a, { action: "close", cursor: 0 }, call));
    await pair();
    results.terminal_close = success(rooms.roomCloseAtTerminal(roomId as R.RoomId));
    results.terminal_closed_view = success(await wait(b, 0));
    await pair();
    db().prepare("UPDATE rooms SET expires_at = ? WHERE id = ?").run(at, roomId);
    results.expired = success(await wait(b, 0));
    for (const [key, reason] of [["agreement", "agreement"], ["crux", "crux"], ["turn_limit", "turn_limit"], ["member_close", "closed"], ["terminal_closed_view", "closed"], ["expired", "expired"]]) {
      const ended = results[key] as R.RoomCloseResult;
      assert.equal(ended.state, "ended"); assert.equal(ended.next, null); assert.equal(ended.ending.reason, reason);
    }
    await pair();
    results.wait_turn_refusal = await wait(a, 0);
    assert.ok("refused" in results.wait_turn_refusal && "messages" in results.wait_turn_refusal);
    for (let n = 1; n < R.ROOM_READS_PER_SECOND; n++) success(await rooms.roomTranscript(a, { action: "transcript", cursor: 0 }, call));
    results.read_rate_refusal = await wait(a, 0);
    assert.deepEqual(results.read_rate_refusal, { refused: true, reason: "Refused: room limit reached: ROOM_READS_PER_SECOND; retry after 2026-11-11T18:00:01.000Z." });
    // Revision 3: a conversation's open, on the person's yes in its host's prompt. Random ids and
    // the invite are replaced by placeholders; the shape and every word around them are pinned.
    for (const table of ["room_messages", "room_invites", "room_bindings", "room_members", "rooms"]) db().prepare(`DELETE FROM ${table}`).run();
    rooms.resetRoomOpenRequestsForTests();
    const opener = newInstance({ kind: "root" }, tmp, "codex");
    const opened = success(await rooms.roomOpen(opener, { action: "open" }, call, { ask: async () => "yes", authorized: () => true, deliver: () => true }));
    const placeholders = (text: string) => text
      .replace(new RegExp(opened.room_id, "g"), "rm_<room>").replace(new RegExp(opened.member_id, "g"), "m_<member-1>")
      .replace(new RegExp(opened.peer.member_id, "g"), "m_<member-2>").replace(/ri1_[0-9a-f]{32}/g, "ri1_<invite>");
    results.opened = JSON.parse(placeholders(JSON.stringify(opened)));
    const refusedOpen: Record<string, unknown> = {};
    for (const answer of ["declined", "cancelled", "timed_out", "unverified", "unavailable"] as const) {
      refusedOpen[answer] = await rooms.roomOpen(newInstance({ kind: "root" }, tmp, "codex"), { action: "open" }, call, { ask: async () => answer, authorized: () => true, deliver: () => true });
    }
    refusedOpen.no_prompt = await rooms.roomOpen(opener, { action: "open" }, call, null);
    refusedOpen.clipboard_failed = await rooms.roomOpen(newInstance({ kind: "root" }, tmp, "codex"), { action: "open" }, call, { ask: async () => "yes", authorized: () => true, deliver: () => false });
    refusedOpen.bound = await rooms.roomOpen(opener, { action: "open" }, call, { ask: async () => "yes", authorized: () => true, deliver: () => true });
    results.open_refusals = refusedOpen;
    snapshot("room.json", results);
  } finally {
    t.mock.restoreAll();
    closeDbForTests();
    if (saved === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("stable surfaces: Gemini jobs and threads withhold native resume and explain the confined continuation", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resume-surface-"));
  const saved = process.env.RELAY_HOME;
  try {
    process.env.RELAY_HOME = tmp;
    const runId = createRun(tmp, withDefaults({}), "surface-root");
    for (const [id, kind] of [["j_00000001", "job"], ["t_00000001", "thread"]] as const) {
      insertNode({ id, run_id: runId, kind, target: "gemini", mode: "read", depth: 1, task: "surface", cwd: tmp });
      db().prepare("UPDATE nodes SET status = 'done', session_id = 'gemini-session' WHERE id = ?").run(id);
      const native = nodeView(getNode(id)!).resume_natively;
      assert.deepEqual(native, { command: null, note: targetDef("gemini").nativeResumeWithheld });
      snapshot("gemini-native-resume.json", native);
    }
  } finally {
    closeDbForTests();
    if (saved === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Descriptions are prose, not the wire contract. Retain names, types, required lists,
// nested objects, enums and constraints; do not lose the keys of a properties map.
function contract(value: any): any {
  if (Array.isArray(value)) return value.map(contract);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "description" && k !== "$schema").map(([k, v]) => [k,
    k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([name, schema]) => [name, contract(schema)])) : contract(v),
  ]));
}

test("stable surfaces: registered MCP tools (including conditional tools) and config schemas", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-surface-"));
  const old = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  const register = McpServer.prototype.registerTool;
  const tools: Record<string, unknown> = {};
  // The shared desktop entry's root tools take session_token as well (docs/d9-isolation-plan.md).
  const desktopTools: Record<string, unknown> = {};
  let into = tools;
  // Capture the exact schemas supplied to the SDK, including confirm, whose visibility is
  // qualified at connection time. No host permission checks are bypassed in production.
  McpServer.prototype.registerTool = function (name: string, config: any, cb: any) {
    into[name] = contract(z.toJSONSchema(config.inputSchema instanceof z.ZodObject ? config.inputSchema : z.object(config.inputSchema), { io: "input" }));
    return register.call(this, name, config, cb);
  } as typeof register;
  try {
    process.env.RELAY_HOME = tmp;
    process.env.RELAY_CONFIG = path.join(tmp, "config.json");
    fs.writeFileSync(process.env.RELAY_CONFIG, "{}");
    const root = relayServer(newInstance({ kind: "root" }, tmp));
    await root.close();
    const runId = createRun(tmp, withDefaults({}), "surface-root");
    insertNode({ id: "j_00000001", run_id: runId, kind: "job", target: "claude", mode: "read", depth: 1, task: "surface", cwd: tmp });
    const child = relayServer(newInstance({ kind: "child", runId, nodeId: "j_00000001", turnId: 1, depth: 1, access: "read", mayDelegate: false, mayAsk: true }, tmp));
    await child.close();
    // Escalation is conditional on the qualified stage-2 Codex lifecycle, while
    // Claude's released child transport above contributes permission_prompt.
    const stage2Run = createRun(tmp, withDefaults({ targets: { codex: { stage2: true } } }), "surface-stage2");
    insertNode({ id: "j_00000002", run_id: stage2Run, kind: "job", target: "codex", mode: "read", depth: 1, task: "surface", cwd: tmp });
    const stage2 = relayServer(newInstance({ kind: "child", runId: stage2Run, nodeId: "j_00000002", turnId: 2, depth: 1, access: "read", mayDelegate: false, mayAsk: true }, tmp));
    await stage2.close();
    into = desktopTools;
    const desktop = relayServer(newInstance({ kind: "root" }, tmp, "claude"), { desktop: true });
    await desktop.close();
    snapshot("tools.json", Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b))));
    snapshot("tools-desktop.json", Object.fromEntries(Object.entries(desktopTools).sort(([a], [b]) => a.localeCompare(b))));
    // The desktop entry differs from a dedicated root only by the optional session_token; tools.json
    // also holds permission_prompt, a launched agent's tool.
    assert.deepEqual(Object.keys(desktopTools).sort(), Object.keys(tools).filter((n) => !["permission_prompt", "escalate"].includes(n)).sort());
    for (const [name, schema] of Object.entries(desktopTools) as [string, any][]) {
      const { session_token, ...rest } = schema.properties ?? {};
      assert.equal(Boolean(session_token), name !== "brief", name);
      assert.deepEqual({ ...schema, properties: rest }, tools[name], name);
    }
    snapshot("config.json", contract(z.toJSONSchema(ConfigSchema, { io: "input" })));
    snapshot("registry.json", {
      version: SCHEMA_VERSION,
      tables: db().prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    });
  } finally {
    McpServer.prototype.registerTool = register;
    closeDbForTests();
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("stable surfaces: CLI usage, version aliases and misuse status", () => {
  const usage = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(usage.status, 0);
  assert.equal(usage.stderr, "");
  snapshot("usage.txt", usage.stdout);
  for (const alias of ["help", "-h"]) {
    const r = spawnSync(process.execPath, [CLI, alias], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, usage.stdout);
  }
  for (const alias of ["--version", "-v", "version"]) {
    const r = spawnSync(process.execPath, [CLI, alias], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "relay 1.3.0\n");
  }
  const bad = spawnSync(process.execPath, [CLI, "unknown-command"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown command unknown-command/);
  // relay mcp's flags, as install registers it, are in the help.
  assert.match(usage.stdout, /relay mcp \[--host <target>\] \[--desktop\] \[--context <file>\]/);
});

test("stable surfaces: CLI errors are messages, not stack traces, and an error result exits 1", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-errors-"));
  try {
    const config = path.join(tmp, "config.json");
    fs.writeFileSync(config, JSON.stringify({ max_depth: "three" }));
    const env: NodeJS.ProcessEnv = { ...process.env, RELAY_HOME: path.join(tmp, "state"), RELAY_CONFIG: config };
    delete env.RELAY_DEBUG;
    for (const k of ["RELAY_RUN_ID", "RELAY_NODE_ID", "RELAY_DEPTH", "RELAY_INJECTED"]) delete env[k];
    const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...env, ...extra } });
    // A config typo: one line saying what is wrong, no stack, unless RELAY_DEBUG asks for one.
    const typo = run(["qualify-codex", "--shipped"]);
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /^relay: relay config at .* is not valid, so relay will not start with it\. max_depth: /);
    assert.doesNotMatch(typo.stderr, /\n\s+at /, "no stack trace");
    assert.match(run(["qualify-codex", "--shipped"], { RELAY_DEBUG: "1" }).stderr, /\n\s+at /, "RELAY_DEBUG shows it");
    // Unknown ids: the error result, and exit 1.
    fs.writeFileSync(config, "{}");
    for (const args of [["approve", "r_nope"], ["deny", "r_nope"], ["cancel", "j_nope"]]) {
      const r = run(args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.match(JSON.parse(r.stdout).error, /unknown (request|id)/);
    }
  } finally {
    closeDbForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("compatibility: 0.2.0 keys load with warnings, preserve values, and reject conflicting spellings", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-legacy-"));
  const old = process.env.RELAY_CONFIG;
  const legacy = { bin: { claude: "/legacy/claude" }, default_model: { codex: "gpt-6.1-sol" }, default_effort: { codex: "high" }, notify: true };
  try {
    process.env.RELAY_CONFIG = path.join(tmp, "config.json");
    fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(legacy));
    const warnings: string[] = [];
    const cfg = loadConfig((m) => warnings.push(m));
    assert.equal(cfg.targets.claude.bin, legacy.bin.claude);
    assert.equal(cfg.targets.codex.default_model, legacy.default_model.codex);
    assert.equal(cfg.targets.codex.default_effort, "high");
    assert.equal(cfg.desktop_notifications, true);
    assert.equal(warnings.length, 4);
    for (const key of Object.keys(legacy)) assert.ok(warnings.some((w) => w.includes(`key ${key} is deprecated`) && w.includes("throughout relay 1.x")));
    assert.deepEqual(configDeprecations({}), []);
    assert.equal(withDefaults({ notify: false }).desktop_notifications, false);
    for (const key of ["bin", "default_model", "default_effort"]) {
      assert.equal(ConfigSchema.safeParse({ [key]: { claude: "x" }, targets: { claude: { [key]: "y" } } }).success, false);
    }
    assert.equal(ConfigSchema.safeParse({ notify: false, desktop_notifications: false }).success, false);
    // Exercise the default stderr diagnostic in a new process, rather than just its callback.
    const script = `import {loadConfig} from ${JSON.stringify(new URL("../dist/core/config.js", import.meta.url).href)}; loadConfig();`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    for (const key of Object.keys(legacy)) assert.match(r.stderr, new RegExp(`WARNING: config key ${key} is deprecated`));
  } finally {
    if (old === undefined) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = old;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("supported versions: speed-tested floors and exact recorded macOS releases", () => {
  assert.deepEqual(targetDef("claude").tested, [2, 1, 302]);
  assert.deepEqual(targetDef("codex").tested, [0, 163, 0]);
  assert.deepEqual(TESTED_MACOS, ["27.0", "27.0.1", "27.2", "27.2.1"]);
  for (const v of TESTED_MACOS) assert.equal(testedMacOS(v), true);
  for (const v of ["unknown", "26.0", "27.0.2", "27.1", "27.2.2", "28.0"]) assert.equal(testedMacOS(v), false);
});

test("stable surfaces: event fields and notice text and inbox wire format", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-wire-")));
  const old = process.env.RELAY_HOME;
  const inbox = net.createServer();
  try {
    process.env.RELAY_HOME = tmp;
    const inst = newInstance({ kind: "root" }, tmp);
    const runId = createRun(tmp, withDefaults({}), inst.token);
    inst.since.set(runId, 0);
    const text = "job j_00000001 finished (done). Call result j_00000001.";
    // Pin all four kinds through the real pendingEvents projection, including the approval
    // request check. No timestamps, run tokens or other private registry fields go on the wire.
    insertNode({ id: "j_00000001", run_id: runId, kind: "job", target: "codex", mode: "read", depth: 1, task: "wire", cwd: tmp });
    db().prepare("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES (?, ?, ?, 'web', 'fetch', 'pending', 1)").run("q_00000001", runId, "j_00000001");
    for (const kind of ["settled", "approval", "decided", "late"]) {
      db().prepare("INSERT INTO events (run_id, key, kind, item_id, subject, text, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)")
        .run(runId, `wire:${kind}`, kind, "j_00000001", "q_00000001", text);
    }
    snapshot("events.json", pendingEvents(inst, {}).events);
    const notice = signedNotice(inst, db().prepare("SELECT * FROM events WHERE id = 1").get());
    // The format is stable; the authenticator is deliberately fresh for each live server.
    const normalize = (text: string) => text.replace(/[a-f0-9]{32}/g, "<notice-tag>");
    snapshot("notice.txt", normalize(notice) + "\n");
    const socket = path.join(tmp, "i.sock");
    const received = new Promise<string>((resolve) => inbox.once("connection", (c) => {
      let data = "";
      c.setEncoding("utf8");
      c.on("data", (part) => data += part);
      c.on("end", () => resolve(data));
    }));
    await new Promise<void>((resolve, reject) => { inbox.once("error", reject); inbox.listen(socket, resolve); });
    await postNotice(socket, "fixture-token", notice, 1);
    snapshot("inbox.jsonl", normalize(await received));
  } finally {
    if (inbox.listening) await new Promise<void>((resolve, reject) => inbox.close((err) => err ? reject(err) : resolve()));
    closeDbForTests();
    if (old === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = old;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
