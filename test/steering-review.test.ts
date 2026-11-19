import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { adoptRun, harness, alive, until, CLI } from "./helpers.ts";
import { withDefaults } from "../dist/core/config.js";
import * as steering from "../dist/core/steering.js";
import { hostProfile, hostFamilyDoubt, registrationAgrees } from "../dist/mcp/host.js";
import { resolveTarget } from "../dist/targets/index.js";
import { execFileSync } from "node:child_process";

test("review steering: unresolved choices contain only other-family targets; strict unknown mapping and brief", () => {
  const off = steering.targetText("claude", withDefaults({ targets: { codex: { enabled: false } } }));
  assert.match(off, /agents of another family \(none is switched on\)/);
  const several = steering.targetText("claude", withDefaults({ targets: { copilot: { enabled: true, default_model: "gemini-3.8-flash" } } }));
  const lead = several.split("; relay cannot choose")[0];
  assert.doesNotMatch(lead, /claude \(Anthropic\)/);
  assert.match(lead, /codex.*copilot/);
  assert.equal(steering.reachDescription(null, withDefaults({ same_family: "refuse" })), "Codex from Claude, Claude from Codex");
  assert.doesNotMatch(steering.idsText(withDefaults({ targets: { copilot: { enabled: true } } })), /\) \(/);
  for (const own of [null, "claude", "codex"] as const) for (const target of [undefined, "claude", "codex", "copilot"] as const) {
    // Design §6.5: the default surface must not claim strict family admission.
    assert.doesNotMatch(JSON.stringify([resolveTarget(own, target, {}), steering.instructions(own, withDefaults({})), steering.targetText(own, withDefaults({})), steering.unknownRefusal(withDefaults({}))]), /only reaches (?:the )?other famil/);
  }
});

test("review smoke: the one-shot roots identify as the host whose default routing they exercise", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }], { same_family: "refuse" });
  try {
    for (const host of ["claude", "codex"]) {
      const result = JSON.parse(execFileSync(process.execPath, [new URL("../smoke/call.mjs", import.meta.url).pathname, "ask", JSON.stringify({ message: "which family?" })], { cwd: h.repo, env: { ...h.env, RELAY_SMOKE_HOST: host }, encoding: "utf8", timeout: 30000 }));
      assert.equal(result.families.caller, host === "claude" ? "anthropic" : "openai");
      assert.equal(result.families.relation, "cross-family");
    }
  } finally { await h.close(); }
});

test("review hosts: real SDK inbox profile and marker, endpoint rules, desktop mismatch, T3 preserves UX", async () => {
  const client = { name: "claude-code", version: "2.1.299" };
  assert.equal(hostProfile({ CLAUDE_AGENT_SDK_VERSION: "0.3" }, client, true).inbox, false);
  assert.equal(hostProfile({ RELAY_HOST_INBOX: "off" }, client, true).inbox, false);
  assert.equal(hostProfile({ RELAY_HOST_INBOX: "on", CLAUDE_AGENT_SDK_VERSION: "0.3" }, client, true).inbox, true);
  assert.equal(registrationAgrees("claude", "grok", true), false);
  for (const key of ["ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL"]) assert.equal(hostFamilyDoubt({ [key]: "https://api.anthropic.com" }, "anthropic"), key);
  assert.ok(hostFamilyDoubt({ ANTHROPIC_MODEL: "openrouter/not-claude-qwen" }, "anthropic"));
  const codex = { name: "codex-mcp-client", version: "0.163.0" };
  const base = hostProfile({}, codex, true);
  const t3 = hostProfile({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code" }, codex, true);
  assert.equal(t3.elicit, "no");
  for (const key of ["waits", "formNote", "withdraws", "inbox"] as const) assert.equal(t3[key], base[key]);
  assert.deepEqual(hostProfile({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code" }, client, true), hostProfile({}, client, true));
  // Inspect the actual dry-run registration, whether its list is literal or built from
  // CODEX_MCP_ENV_VARS. Other entries (CODEX_HOME, for example) must not break this guard.
  const h = await harness();
  try {
    const bin = `${h.home}/installer-codex`;
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${new URL("./stubs/fake-host-cli.mjs", import.meta.url).pathname}" codex "$@"\n`, { mode: 0o755 });
    const cfg = JSON.parse(fs.readFileSync(`${h.home}/config.json`, "utf8"));
    cfg.targets.codex.bin = bin;
    fs.writeFileSync(`${h.home}/config.json`, JSON.stringify(cfg));
    const output = execFileSync(process.execPath, [CLI, "install", "codex"], { cwd: h.repo, env: { ...h.env, FAKE_DIR: h.home }, encoding: "utf8" });
    const vars = JSON.parse(output.match(/^env_vars = (\[.*\])$/m)![1]) as string[];
    assert.ok(vars.includes("CODEX_INTERNAL_ORIGINATOR_OVERRIDE"));
  } finally { await h.close(); }
});

test("review handshake: contradictory registration changes initialize instructions and tools even without initialized", async () => {
  const h = await harness();
  const before = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  try {
    process.env.RELAY_HOME = h.home;
    process.env.RELAY_CONFIG = `${h.home}/config.json`;
    const { relayServer } = await import("../dist/mcp/server.js");
    const { newInstance } = await import("../dist/core/caller.js");
    for (const dropInitialized of [false, true]) {
      const inst = newInstance({ kind: "root" }, h.repo, "claude");
      const server = relayServer(inst);
      const [a, b] = InMemoryTransport.createLinkedPair();
      if (dropInitialized) {
        const send = b.send.bind(b);
        b.send = async (m, ...rest) => { if (!("method" in m && m.method === "notifications/initialized")) await send(m, ...rest); };
      }
      const client = new Client({ name: "opencode", version: "2.0.32" });
      try {
        await Promise.all([server.connect(a), client.connect(b)]);
        assert.match(client.getInstructions()!, /cannot tell which family/);
        const tools = (await client.listTools()).tools;
        for (const [name, key] of [["delegate", "target"], ["review", "reviewer"]]) assert.match((tools.find(t => t.name === name)!.inputSchema.properties![key] as any).description, /cannot tell your family/);
        assert.match(tools.find(t => t.name === "ask")!.description!, /the agent you name with target/);
        const res: any = await client.callTool({ name: "ask", arguments: { message: "which?" }, _meta: { "ai.opencode/sessionID": "ses_review" } });
        assert.match(JSON.parse(res.content[0].text).reason, /cannot tell which family/);
        assert.equal(inst.family, null);
        assert.equal(inst.clientName, "opencode");
      } finally { await client.close(); await server.close(); }
    }
  } finally {
    for (const [k,v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await h.close();
  }
});

test("review labels: a fresh discussion participant follows takeover, and disk metadata is attributed", async () => {
  const h = await harness([{ steps: [{ reply: "continue\nCONTINUE" }] }]);
  try {
    const a = await h.instance({ args: ["--host", "claude"] });
    const d = await a.call("discuss", { target: "codex", topic: "fresh", message: "hello\nCONTINUE" });
    const row = h.sql("SELECT params_json, run_id FROM nodes WHERE id = ?", d.discussion_id)[0];
    const participant = JSON.parse(row.params_json).participant;
    const pid = h.sql("SELECT root_pid FROM runs WHERE id = ?", row.run_id)[0].root_pid;
    await a.close(); await until(() => !alive(pid));
    const b = await h.instance({ args: ["--host", "codex"] });
    await adoptRun(h, b, d.discussion_id);
    const end = await b.call("discuss", { discussion_id: d.discussion_id, message: "end\nCRUX: done" });
    assert.equal((await b.call("status", { id: participant })).families.caller, "unknown");
    const view = await b.call("status", { id: d.discussion_id });
    assert.equal(view.children.find((n: any) => n.id === participant).families.relation, "unknown");
    assert.match((await b.call("status")).tree, /thread:codex \[family unknown\]/);
    assert.match(fs.readFileSync(end.transcript_path, "utf8"), /\(relay\) Families: Family unknown:/);
  } finally { await h.close(); }
});

test("review start labels: accepted waivers are unknown before backend preflight and in review next", async () => {
  for (const target of ["codex", "claude"]) {
    const h = await harness([{ steps: [{ reply: "ok" }] }], { codex_endpoint_override: "accept", claude_settings_env: "accept", child_settings: "inherit" });
    try {
      const root = await h.instance({ args: ["--host", target === "codex" ? "claude" : "codex"] });
      const d = await root.call("delegate", { target, task: "waiver", mode: "read" });
      assert.equal(d.families.launched, "unknown", JSON.stringify(d));
      const r = await root.call("review", { target: "README.md", reviewer: target });
      assert.equal(r.families.launched, "unknown", JSON.stringify(r));
      assert.match(r.next, /Report it as family unknown/);
      await root.call("review", { review_id: r.review_id, skip_own: true });
    } finally { await h.close(); }
  }
});

test("review brief: unknown strict callers can read a named brief without admission instructions", async () => {
  const h = await harness([], { same_family: "refuse" });
  try {
    const root = await h.instance({ host: null });
    assert.equal((await root.call("brief")).error, "Name the agent you are writing for as target.");
    assert.equal((await root.call("brief", { target: "codex" })).target, "codex");
  } finally { await h.close(); }
});
