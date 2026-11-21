import { hostVar, scratchOnly } from "./helpers.ts";
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { newInstance, type Instance } from "../dist/core/caller.js";
import { closeDbForTests, db } from "../dist/core/db.js";
import { callIdentity, roomIdentityEvidence } from "../dist/core/identity.js";
import { ROOM_INVITE_SHAPE, ROOM_REFUSALS } from "../dist/core/room-types.js";
import { diagnosticTail } from "../dist/core/redact.js";
import { recognizedSecretShape, redact, redactor, roomCredentialInText } from "../dist/core/secrets.js";
import { roomClientName, roomText, shown } from "../dist/core/shown.js";
import { hostProfile, roomEligibility } from "../dist/mcp/host.js";

const turn = { thread_id: "root-thread", thread_source: "user", sandbox_mode: "workspace-write", auto_review_enabled: false, approval_policy: "on-request", originator: "codex_cli_rs" };
const meta = (fields: Record<string, unknown> = turn) => ({ "x-codex-turn-metadata": fields });

const recordedCli = { session_id: "session", thread_id: "thread", reasoning_effort: "high", turn_id: "turn", model: "gpt-6-astra", thread_source: "user", turn_trigger: "user", sandbox: "seatbelt", sandbox_mode: "workspace-write", auto_review_enabled: true, node_repl_auto_review_required: true, node_repl_disabled: false, workspaces: {} };
const recordedApp = { session_id: "session", thread_id: "thread", workspace_kind: "projectless", turn_id: "turn", source: "codex", thread_source: "user", turn_trigger: "composer", sandbox: "seatbelt", sandbox_mode: "workspace-write", auto_review_enabled: true, node_repl_auto_review_required: true, node_repl_disabled: false, turn_started_at_unix_ms: 1794416400000, client_type: "desktop_app", model: "gpt-6-astra", reasoning_effort: "high", codex_version: "0.162.0-alpha.17.2" };
const recordedChild = { ...recordedCli, thread_source: "subagent", subagent_kind: "thread_spawn", parent_thread_id: "parent", forked_from_thread_id: "parent" };
const recordedExec = { session_id: "session", thread_id: "thread", reasoning_effort: "high", turn_id: "turn", model: "gpt-6.1-sol", thread_source: "user", turn_trigger: "exec", sandbox: "seatbelt", sandbox_mode: "read-only", auto_review_enabled: true, node_repl_auto_review_required: true, node_repl_disabled: false, turn_started_at_unix_ms: 1794416400000, codex_version: "0.167.0" };

/** Synthetic process evidence and scratch settings only; never inspect a real host's settings. */
function fixture(t: TestContext) {
  const root = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-rooms-host-"))));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (hostVar(key) || /^(RELAY_(RUN_ID|NODE_ID|DEPTH|INJECTED)|CODEX_THREAD_ID|CODEX_SANDBOX)$/.test(key)) delete process.env[key];
  Object.assign(process.env, { HOME: root, RELAY_HOME: path.join(root, "relay"), CLAUDE_CONFIG_DIR: path.join(root, "config") });
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  const realSpawn = cp.spawnSync;
  const realExists = fs.existsSync;
  let command = "claude", unreadable = false, unreadableCommands = false, parent = 1;
  const start = "Wed Nov 11 10:00:00 2026";
  const processMock = t.mock.method(cp, "spawnSync", ((file: string, args: string[], opts: unknown) => {
    const result = (stdout: string, status = 0) => ({ stdout, stderr: "", status, signal: null, pid: 123, output: [null, stdout, ""] });
    if (file === "/bin/ps" && args.includes("-axo")) return result(unreadable ? "" : `${process.pid} ${parent} 123 ${start}\n${parent} 1 123 ${start}\n`, unreadable ? 1 : 0);
    if (file === "/bin/ps" && args.includes("-ww")) return result(unreadableCommands ? "" : `0 ${command}\n`, unreadableCommands ? 1 : 0);
    if (file === "/usr/bin/perl") return result("123");
    return realSpawn(file, args, opts as never);
  }) as typeof cp.spawnSync);
  const existsMock = t.mock.method(fs, "existsSync", ((file: fs.PathLike) => {
    if (String(file).startsWith("/Library/") || String(file).startsWith("/etc/claude-code/")) return false;
    return realExists(file);
  }) as typeof fs.existsSync);
  syncBuiltinESMExports();
  t.after(() => {
    closeDbForTests();
    processMock.mock.restore(); existsMock.mock.restore(); syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const inst = (name = "claude-code") => {
    const i = newInstance({ kind: "root" }, cwd, name === "codex-mcp-client" ? "codex" : "claude");
    i.clientName = name;
    return i;
  };
  const evidence = (i: Instance, m: Record<string, unknown> | undefined = undefined) => roomIdentityEvidence(i, callIdentity(i, m, "2025-11-25"));
  return { root, cwd, inst, evidence, start, command: (v: string) => { command = v; }, unreadable: () => { unreadable = true; }, unreadableCommands: () => { unreadableCommands = true; }, parent: (v: number) => { parent = v; } };
}

test("rooms: eligibility follows every host-table row and refusal, without requiring confirm", (t) => {
  const f = fixture(t);
  type Case = { name: string; client?: string; env?: NodeJS.ProcessEnv; change?: (i: Instance) => void; metadata?: Record<string, unknown>; command?: string; eligible: boolean };
  const cases: Case[] = [
    { name: "interactive Claude Code", env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, eligible: true },
    { name: "Codex sandboxed root", client: "codex-mcp-client", metadata: meta(), eligible: true },
    { name: "Codex read-only root", client: "codex-mcp-client", metadata: meta({ ...turn, sandbox_mode: "read-only" }), eligible: true },
    { name: "Codex permission evidence unknown", client: "codex-mcp-client", metadata: meta({ thread_id: "root", thread_source: "user" }), eligible: true },
    { name: "dedicated desktop Code tab", env: { CLAUDE_CODE_DESKTOP_APP_VERSION: "1", CLAUDE_AGENT_SDK_VERSION: "1" }, eligible: true },
    { name: "desktop chat token view", client: "claude.ai", change: (i) => { i.desktopEntry = true; i.carried = true; }, eligible: true },
    { name: "Cowork bridge token view", client: "local-agent-mode-relay", change: (i) => { i.carried = true; }, eligible: true },
    { name: "child, even mayDelegate", change: (i) => { i.ctx = { kind: "child", runId: "r", nodeId: "n", turnId: 1, depth: 1, access: "read", mayDelegate: true, mayAsk: true }; }, eligible: false },
    { name: "poisoned context", change: (i) => { i.ctx = { kind: "poisoned", reason: "bad context" }; }, eligible: false },
    { name: "Codex subagent", client: "codex-mcp-client", metadata: meta({ ...turn, thread_source: "subagent" }), eligible: false },
    { name: "Codex no turn metadata", client: "codex-mcp-client", eligible: false },
    { name: "Codex no source", client: "codex-mcp-client", metadata: meta({ thread_id: "root" }), eligible: false },
    { name: "Codex no nested thread id", client: "codex-mcp-client", metadata: { threadId: "top", ...meta({ thread_source: "user" }) }, eligible: false },
    { name: "Codex unknown source", client: "codex-mcp-client", metadata: meta({ ...turn, thread_source: "wrapper" }), eligible: false },
    { name: "Codex exec is unattended", client: "codex-mcp-client", metadata: meta({ ...turn, thread_source: "exec" }), eligible: false },
    { name: "Codex MCP host is unattended", client: "codex-mcp-client", metadata: meta({ ...turn, thread_source: "mcp" }), eligible: false },
    { name: "Codex full access", client: "codex-mcp-client", metadata: meta({ ...turn, sandbox_mode: "danger-full-access" }), eligible: false },
    { name: "Codex unknown sandbox mode", client: "codex-mcp-client", metadata: meta({ ...turn, sandbox_mode: "external-sandbox" }), eligible: true },
    { name: "Codex auto review", client: "codex-mcp-client", metadata: meta({ ...turn, auto_review_enabled: true }), eligible: true },
    { name: "Codex never approvals", client: "codex-mcp-client", metadata: meta({ ...turn, approval_policy: "never" }), eligible: false },
    { name: "Codex unknown approval mode", client: "codex-mcp-client", metadata: meta({ ...turn, approval_policy: "future" }), eligible: true },
    { name: "Codex custom originator", client: "codex-mcp-client", metadata: meta({ ...turn, originator: "custom" }), eligible: false },
    { name: "Codex T3 metadata originator", client: "codex-mcp-client", metadata: meta({ ...turn, originator: "t3-code" }), eligible: false },
    { name: "Codex T3 environment originator", client: "codex-mcp-client", metadata: meta(), env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "t3-code" }, eligible: false },
    { name: "Codex custom environment originator", client: "codex-mcp-client", metadata: meta(), env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "custom" }, eligible: false },
    { name: "claude -p", env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, eligible: false },
    { name: "attended 0", env: { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "0" }, eligible: false },
    { name: "Agent SDK outside desktop", env: { CLAUDE_AGENT_SDK_VERSION: "1" }, eligible: false },
    { name: "bypass flag", env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, command: "claude --dangerously-skip-permissions", eligible: false },
    { name: "can switch to bypass", env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, command: "claude --allow-dangerously-skip-permissions", eligible: false },
    { name: "bypass mode argument", env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, command: "claude --permission-mode=bypassPermissions", eligible: false },
    { name: "child marker", env: { CLAUDE_CODE_DESKTOP_APP_VERSION: "1", CLAUDE_CODE_CHILD_SESSION: "1" }, eligible: false },
    { name: "nonzero child marker", env: { CLAUDE_CODE_DESKTOP_APP_VERSION: "1", CLAUDE_CODE_CHILD_SESSION: "yes" }, eligible: false },
    { name: "zero child marker", env: { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_CHILD_SESSION: "0" }, eligible: true },
    { name: "different host/session ids", env: { CLAUDE_CODE_DESKTOP_APP_VERSION: "1", CLAUDE_CODE_HOST_SESSION_ID: "parent", CLAUDE_CODE_SESSION_ID: "child" }, eligible: false },
    { name: "same host/session ids", env: { CLAUDE_CODE_DESKTOP_APP_VERSION: "1", CLAUDE_CODE_HOST_SESSION_ID: "root", CLAUDE_CODE_SESSION_ID: "root" }, eligible: true },
    { name: "unknown Claude surface", eligible: false },
    { name: "unknown client", client: "wrapper", eligible: false },
    { name: "T3 Code", client: "T3 Code", eligible: false },
    { name: "OpenCode", client: "opencode", eligible: false },
    { name: "copied desktop registration in Cursor", client: "cursor", change: (i) => { i.desktopEntry = true; i.carried = true; }, eligible: false },
    { name: "shared process without token", client: "claude.ai", change: (i) => { i.desktopEntry = true; }, eligible: false },
    { name: "shared unattended", client: "claude.ai", change: (i) => { i.desktopEntry = true; i.carried = true; }, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, eligible: false },
    { name: "host-key view", client: "opencode", change: (i) => { i.hostKey = "opencode-session"; i.keyed = true; }, eligible: false },
    { name: "singleton violation", env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, change: (i) => { i.singletonViolation = true; }, eligible: false },
    { name: "contradicted registration", change: (i) => { i.registration = { host: "claude", client: "codex-mcp-client" }; }, eligible: false },
    ...["RELAY_RUN_ID", "RELAY_NODE_ID", "RELAY_DEPTH", "RELAY_INJECTED"].map((key) => ({ name: `launch marker ${key}`, env: { CLAUDE_CODE_ENTRYPOINT: "cli", [key]: "" }, eligible: false })),
  ];
  for (const c of cases) {
    for (const key of Object.keys(process.env)) if (hostVar(key) || /^RELAY_(RUN_ID|NODE_ID|DEPTH|INJECTED)$/.test(key)) delete process.env[key];
    Object.assign(process.env, c.env);
    f.command(c.command ?? "claude");
    const i = f.inst(c.client); c.change?.(i);
    const result = roomEligibility(i, f.evidence(i, c.metadata));
    assert.deepEqual(result, c.eligible ? { eligible: true } : { eligible: false, refused: true, reason: ROOM_REFUSALS.ineligible }, c.name);
    assert.ok(Object.isFrozen(result), c.name);
  }
});

test("rooms: recorded Codex CLI, desktop, native child and exec metadata", (t) => {
  const f = fixture(t);
  const { thread_source: _source, ...noSource } = recordedCli;
  const { turn_trigger: _trigger, ...noTrigger } = recordedCli;
  const { sandbox_mode: _sandbox, ...noSandbox } = recordedCli;
  const cases = [
    ["recorded CLI", recordedCli, true], ["recorded desktop", recordedApp, true],
    ["recorded native child", recordedChild, false], ["recorded exec", recordedExec, false],
    ["missing source", noSource, false], ["unknown source", { ...recordedCli, thread_source: "other" }, false],
    ["full access", { ...recordedCli, sandbox_mode: "danger-full-access" }, false],
    ["never", { ...recordedCli, approval_policy: "never" }, false],
    ["no trigger", noTrigger, true], ["other trigger", { ...recordedCli, turn_trigger: "other" }, true],
    ["no sandbox", noSandbox, true], ["unknown sandbox", { ...recordedCli, sandbox_mode: "future" }, true],
    ["auto review off", { ...recordedCli, auto_review_enabled: false }, true],
  ] as const;
  for (const [name, fields, eligible] of cases) {
    const i = f.inst("codex-mcp-client");
    const identity = callIdentity(i, meta(fields), "2025-11-25", { name: "codex-mcp-client", version: "0.167.0" });
    assert.equal(roomEligibility(i, roomIdentityEvidence(i, identity)).eligible, eligible, name);
  }
});

test("rooms: environment, command lines and readable settings are refreshed for each action", (t) => {
  const f = fixture(t), i = f.inst();
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
  const e = f.evidence(i);
  const check = (eligible: boolean) => assert.equal(roomEligibility(i, e).eligible, eligible);
  check(true);
  process.env.CLAUDE_CODE_SESSION_ATTENDED = "0"; check(false);
  delete process.env.CLAUDE_CODE_SESSION_ATTENDED; check(true);
  f.command("claude --permission-mode bypassPermissions"); check(false);
  f.command("claude"); check(true);
  const settings = path.join(f.cwd, ".claude/settings.json");
  const write = (value: unknown) => fs.writeFileSync(settings, JSON.stringify(value));
  write({ permissions: { defaultMode: "bypassPermissions" } }); check(false);
  write({ permissions: { defaultMode: "default" } }); check(true);
  // Unrelated confirm hooks do not require a confirm capability for terminal enrollment.
  write({ hooks: { PreToolUse: [{ matcher: "*", hooks: [] }] } }); check(true);
  assert.equal(hostProfile(process.env, { name: "claude-code", version: "2.1.286" }, false, [], { dialog: null, confirm: "hook" }).confirm, false);
  const localSettings = path.join(f.cwd, ".claude/settings.local.json");
  fs.writeFileSync(localSettings, JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
  check(false);
  const shared = f.inst("claude.ai"); shared.desktopEntry = true; shared.carried = true;
  assert.equal(roomEligibility(shared, f.evidence(shared)).eligible, false, "shared desktop also checks readable bypass settings");
  fs.rmSync(localSettings); check(true);
  fs.writeFileSync(settings, "unreadable JSON"); check(true);
  fs.rmSync(settings);
  f.command('claude --settings {"permissions":{"defaultMode":"bypassPermissions"}}'); check(false);
  f.command("claude");
  // No command-line evidence is not positive evidence of bypass; the terminal supplies opt-in.
  f.unreadableCommands(); check(true);
  const codex = f.inst("codex-mcp-client"), ce = f.evidence(codex, meta());
  assert.equal(roomEligibility(codex, ce).eligible, true);
  process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "t3-code";
  assert.equal(roomEligibility(codex, ce).eligible, false);
  delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  assert.equal(roomEligibility(codex, ce).eligible, true);
});

test("rooms: launched ancestry and unreadable launch evidence preserve the existing guard", (t) => {
  const f = fixture(t), i = f.inst();
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
  const e = f.evidence(i);
  assert.equal(roomEligibility(i, e).eligible, true);
  db().prepare("INSERT INTO relay_procs (pid, start, kind, node_id, created_at) VALUES (?, ?, 'worker', NULL, ?)").run(424242, f.start, Date.now());
  f.parent(424242);
  assert.equal(roomEligibility(i, e).eligible, false);
  db().prepare("DELETE FROM relay_procs").run();
  f.parent(1);
  assert.equal(roomEligibility(i, e).eligible, true);
  f.unreadable();
  assert.equal(roomEligibility(i, e).eligible, false);
});

test("rooms: validated immutable identity evidence leaves CallerSnapshot unchanged", (t) => {
  const f = fixture(t), i = f.inst("codex-mcp-client");
  const base = { thread_id: "root-thread", thread_source: "user", model: "gpt-6.1-sol" };
  const plain = callIdentity(i, meta(base), "2025-11-25");
  const fields = { ...base, ...turn, turn_trigger: "composer", sandbox: "seatbelt" };
  const rich = callIdentity(i, meta(fields), "2025-11-25");
  const withoutId = ({ call_id: _id, ...rest }: typeof plain.snapshot) => rest;
  assert.deepEqual(withoutId(rich.snapshot), withoutId(plain.snapshot));
  const e = roomIdentityEvidence(i, rich);
  assert.deepEqual(e.codex, { malformed: false, metadata_present: true, thread_id: "root-thread", thread_source: "user", turn_trigger: "composer", originator: "codex_cli_rs", sandbox: "workspace-write", auto_review: false, approval_policy: "on-request" });
  for (const value of [rich, rich.codex, rich.snapshot, rich.snapshot.session, e, e.codex]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { (e.codex as { sandbox: string }).sandbox = "danger-full-access"; }, TypeError);
  fields.sandbox_mode = "danger-full-access";
  fields.turn_trigger = "exec";
  assert.equal(e.codex.turn_trigger, "composer");
  assert.equal(e.codex.sandbox, "workspace-write", "does not retain mutable metadata");
  assert.equal(JSON.stringify(e).includes(i.token), false);
  assert.equal(JSON.stringify(rich.snapshot).includes("root-thread"), false);
  const absent = roomIdentityEvidence(i, callIdentity(i, undefined, "p"));
  assert.deepEqual(absent.codex, { malformed: false, metadata_present: false, thread_id: null, thread_source: null, turn_trigger: null, originator: null, sandbox: null, auto_review: null, approval_policy: null });
  assert.deepEqual(roomIdentityEvidence(i, callIdentity(i, meta({}), "p")).codex, { ...absent.codex, metadata_present: true });
  // A later singleton violation cannot be hidden by reusing an older call identity.
  callIdentity(i, meta({ ...base, thread_id: "another-thread" }), "p");
  assert.equal(roomIdentityEvidence(i, rich).singleton_violation, true);
  assert.equal(roomEligibility(i, e).eligible, false);
});

test("rooms: malformed room-only metadata is evidence, while pre-room fields stay strict", (t) => {
  const f = fixture(t);
  for (const key of ["turn_trigger", "client_type", "originator", "sandbox_mode", "sandbox", "approval_policy", "auto_review_enabled"]) {
    const badValues = key === "auto_review_enabled" ? [null, undefined, "true", 0, 1, {}, []] : [null, undefined, true, 1, {}, [], "", " ", "x".repeat(4097)];
    for (const bad of badValues) {
      const i = f.inst("codex-mcp-client");
      const identity = callIdentity(i, meta({ ...turn, [key]: bad }), "p");
      assert.equal(identity.codex.malformed, true, key);
      const value = { turn_trigger: "turn_trigger", client_type: "originator", originator: "originator", sandbox_mode: "sandbox", approval_policy: "approval_policy", auto_review_enabled: "auto_review" }[key];
      if (value && key !== "client_type") assert.equal(identity.codex[value], null, key);
      assert.equal(roomEligibility(i, roomIdentityEvidence(i, identity)).eligible, false, key);
    }
  }
  for (const key of ["thread_id", "session_id", "model", "thread_source"]) {
    for (const bad of [null, undefined, true, 1, {}, [], "", " ", "x".repeat(4097)])
      assert.throws(() => callIdentity(f.inst(), meta({ ...turn, [key]: bad }), "p"), /malformed session metadata/, key);
  }
  for (const key of ["threadId", "sessionId", "windowId", "anthropic/conversationUuid", "ai.opencode/sessionID"]) {
    for (const bad of [null, undefined, true, 1, {}, [], "", " ", "x".repeat(4097)])
      assert.throws(() => callIdentity(f.inst(), { [key]: bad }, "p"), /malformed session metadata/, key);
  }
  for (const bad of [null, "{}", [], true]) assert.throws(() => callIdentity(f.inst(), { "x-codex-turn-metadata": bad }, "p"), /malformed session metadata/);
  assert.throws(() => callIdentity(f.inst(), { threadId: "top", ...meta() }, "p"), /conflicting session metadata/);
});

test("rooms: Codex ancestor flags refuse bypass and ordinary CLI command lines admit", (t) => {
  const f = fixture(t), i = f.inst("codex-mcp-client"), e = f.evidence(i, meta(recordedCli));
  const flags = ["--dangerously-bypass-approvals-and-sandbox",
    ...["--ask-for-approval", "-a"].flatMap((flag) => [`${flag} never`, `${flag}=never`]),
    ...["--sandbox", "-s"].flatMap((flag) => [`${flag} danger-full-access`, `${flag}=danger-full-access`]),
    ...["--config", "-c"].flatMap((flag) => ["approval_policy=never", 'approval_policy="never"', "sandbox_mode=danger-full-access", 'sandbox_mode="danger-full-access"']
      .flatMap((value) => [`${flag} ${value}`, `${flag}=${value}`, `${flag} '${value}'`]))];
  for (const flag of flags) {
    f.command(`codex ${flag}`);
    assert.equal(roomEligibility(i, e).eligible, false, flag);
  }
  for (const command of ["codex", "codex resume", "codex app-server", "codex -a on-request", "codex --sandbox workspace-write", 'codex -c approval_policy="on-request"']) {
    f.command(command);
    assert.equal(roomEligibility(i, e).eligible, true, command);
  }
});

test("rooms: shown defaults are unchanged; room text escapes C1 and makes surrogates well formed", () => {
  const oldShown = (text: string) => {
    if (!/[\u0000-\u001f\u007f]/.test(text) && !/[\p{Cf}\u2028\u2029]/u.test(text)) return text;
    const lines = text.split(/\r\n|\r|\n/).length;
    const escaped = text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
      .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .replace(/[\p{Cf}\u2028\u2029]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`);
    return `(${lines} line${lines === 1 ? "" : "s"}, shown escaped) ${escaped}`;
  };
  const inputs = ["", "plain", "🙂", "a\\b", "a\r\nb\rc\nd", "\ud800", "\udfff", "\u2028\u2029", "\u{E0001}", ...Array.from({ length: 160 }, (_, cp) => `\\${String.fromCodePoint(cp)}x`), "\u202E", "\u200B", "\uFEFF", "\u00AD"];
  for (const text of inputs) {
    assert.equal(shown(text), oldShown(text));
    assert.equal(shown(text, { escapeC1: false }), oldShown(text));
  }
  for (let cp = 0x80; cp <= 0x9f; cp++) {
    assert.equal(roomText(`a${String.fromCodePoint(cp)}b`), `(1 line, shown escaped) a\\u${cp.toString(16).padStart(4, "0")}b`);
    assert.equal(shown(`a${String.fromCodePoint(cp)}b`, { escapeC1: true }), roomText(`a${String.fromCodePoint(cp)}b`));
  }
  assert.equal(roomText("a\\b\t\r\n\u0085\u202E\u200B\u{E0001}"), "(2 lines, shown escaped) a\\\\b\\t\\r\\n\\u0085\\u{202E}\\u{200B}\\u{E0001}");
  assert.equal(roomText("\ud800x\udfff"), "�x�");
  assert.equal(roomText("🙂"), "🙂");
  assert.equal(roomClientName("🙂".repeat(256) + "dropped\u202E"), "🙂".repeat(256));
  assert.equal(roomClientName("\ud800\u0085\u202E"), "(1 line, shown escaped) �\\u0085\\u{202E}");
  assert.equal(roomClientName(`client ri1_${"a".repeat(32)}`), "client [redacted]");
  assert.equal(roomClientName(`client RS1_${"A".repeat(56)}`), "client [redacted]");
});

test("rooms: invite and session-token shapes are detected and redacted in every letter case", () => {
  const invite = `ri1_${"a1b2".repeat(8)}`, token = `rs1_${"c3d4".repeat(14)}`;
  assert.equal(ROOM_INVITE_SHAPE.test(invite), true);
  for (const shape of [invite, token]) for (const value of [shape, shape.toUpperCase(), shape.replace(/[a-z]/g, (c, i) => i % 2 ? c : c.toUpperCase())]) {
    const text = `before (${value}) after`;
    // Repeated tests must not acquire a RegExp lastIndex cursor.
    for (let n = 0; n < 3; n++) {
      assert.equal(roomCredentialInText(text), true);
      assert.equal(recognizedSecretShape(text), true);
      assert.equal(redact(text), "before ([redacted]) after");
      assert.equal(redactor({})(text), "before ([redacted]) after");
      const tail = diagnosticTail(); tail.write(text);
      assert.equal(tail.text(), "before ([redacted]) after");
    }
  }
  assert.equal(redact(`${invite} ${token} ${invite.toUpperCase()}`), "[redacted] [redacted] [redacted]");
  for (const value of [invite.slice(0, -1), token.slice(0, -1), invite.replace("ri1_", "ri2_"), token.replace("rs1_", "rs2_"), `ri1_${"g".repeat(32)}`, `rs1_${"z".repeat(56)}`]) {
    assert.equal(roomCredentialInText(value), false, value);
    assert.equal(recognizedSecretShape(value), false, value);
    assert.equal(redact(value), value);
  }
});
