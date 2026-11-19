import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { conversationOn, harness } from "./helpers.ts";
import { hostFamilyDoubt, registrationAgrees } from "../dist/mcp/host.js";
import { withDefaults } from "../dist/core/config.js";
import { targetDef } from "../dist/targets/index.js";

test("r4 desktop identity: known other families contradict; unknown desktop clients retain compatibility", async () => {
  for (const name of ["codex-mcp-client", "codex-app-server", "gemini-cli-mcp-client"]) assert.equal(registrationAgrees("claude", name, true), false, name);
  assert.equal(registrationAgrees("codex", "claude-code", true), false);
  for (const name of ["claude-code", "Claude", "claude-ai", "Cowork", "local-agent-mode-relay", "unobserved-desktop-chat", ""]) assert.equal(registrationAgrees("claude", name, true), true, name);
  for (const same_family of ["allow", "refuse"]) {
    const h = await harness([], { same_family });
    try {
      const shared = await h.instance({ args: ["--host", "claude", "--desktop"], clientInfo: { name: "codex-mcp-client", version: "0.163.0" } });
      // The desktop entry is shared: each conversation carries its session token.
      const conversation = await conversationOn(shared);
      const r = await conversation.call("ask", { message: "An omitted target must never pick this Codex caller's family" });
      assert.match(r.reason, /cannot tell which (?:family|agent)/, JSON.stringify(r));
      assert.equal(h.starts().length, 0);
      assert.equal((await shared.call("brief")).error, "Name the agent you are writing for as target.");
    } finally { await h.close(); }
  }
});

test("r4 multi-model names: VS Code branded/OSS and Continue's wire name contradict desktop registrations", () => {
  for (const name of ["Visual Studio Code", "Visual Studio Code - Insiders", "Code - OSS", "continue-client", "opencode", "cursor", "grok"]) assert.equal(registrationAgrees("claude", name, true), false, name);
});

test("r4 Claude models: geographic prefixes and provisioned context retain Claude evidence", () => {
  for (const prefix of ["jp", "au", "ca", "future-region", "global", "apac", "us-gov"]) for (const suffix of ["-v1:0", "-v1:0:200k"]) {
    const model = `${prefix}.anthropic.claude-sonnet-4-5-20250929${suffix}`;
    assert.equal(hostFamilyDoubt({ ANTHROPIC_MODEL: model }, "anthropic"), null, model);
  }
  for (const model of ["jp.anthropic.claude-qwen3-coder-v1:0:200k", "claude-qwen3-coder", "a.b.anthropic.claude-sonnet-4-5-v1:0", "bad--region.anthropic.claude-sonnet-4-5-v1:0"]) assert.equal(hostFamilyDoubt({ ANTHROPIC_MODEL: model }, "anthropic"), "ANTHROPIC_MODEL", model);
});

test("r4 tools list: initialize and profile changes are silent before first list; later changes coalesce", async () => {
  const h = await harness();
  const before = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  try {
    process.env.RELAY_HOME = h.home; process.env.RELAY_CONFIG = `${h.home}/config.json`;
    const { relayServer } = await import("../dist/mcp/server.js");
    const { newInstance } = await import("../dist/core/caller.js");
    for (const name of ["claude-code", "opencode"]) for (const earlyList of [false, true]) {
      const server = relayServer(newInstance({ kind: "root" }, h.repo, "claude"));
      const [a, b] = InMemoryTransport.createLinkedPair();
      const messages: any[] = [];
      const sendA = a.send.bind(a); a.send = async (m, o) => { messages.push(m); await sendA(m, o); };
      const sendB = b.send.bind(b); b.send = async (m, o) => { if (!("method" in m && m.method === "notifications/initialized")) await sendB(m, o); };
      const client = new Client({ name, version: "2.1.299" });
      const changed = () => messages.filter(m => m.method === "notifications/tools/list_changed").length;
      try {
        await Promise.all([server.connect(a), client.connect(b)]);
        await new Promise<void>(r => setImmediate(r));
        assert.equal(changed(), 0, "identity changed before tools were listed");
        if (earlyList) await client.listTools();
        await sendB({ jsonrpc: "2.0", method: "notifications/initialized" });
        await client.listTools(); // orders both profile updates, as well as identity's four
        await new Promise<void>(r => setImmediate(r));
        assert.equal(changed(), earlyList ? 1 : 0, "both profile updates form one change, only after a list was served");
        const at = changed();
        const tool = server.registerTool("late", { description: "first" }, async () => ({ content: [] }));
        tool.update({ description: "second" }); tool.update({ description: "third" });
        await new Promise<void>(r => setImmediate(r));
        assert.equal(changed() - at, 1, "one notification for the whole change");
        assert.equal((await client.listTools()).tools.find(t => t.name === "late")!.description, "third");
      } finally { await client.close(); await server.close(); }
    }
  } finally {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await h.close();
  }
});

test("r4 strict unknown advice: restart the actual host; multi-model callers name a target", async () => {
  const s = await import("../dist/core/steering.js");
  for (const text of [s.unknownStrict, s.instructions(null, withDefaults({ same_family: "refuse" }))]) {
    assert.match(text, /(?:start|restart).*session.*again|restart.*session/i);
    assert.match(text, /multi-model.*name.*target/i);
    assert.match(text, /same_family "allow"/, "strict advice must not claim a named target bypasses refuse");
  }
});

test("r4 child environment: Claude session identity never reaches Codex or Copilot, target auth remains usable", async () => {
  const { childEnv } = await import("../dist/backends/env.js");
  const { selectEnvironment } = await import("../dist/core/env-policy.js");
  const vars = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_SESSION_ATTENDED: "0", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CODE_DESKTOP_APP_VERSION: "2.42304.0", CLAUDE_AGENT_SDK_VERSION: "0.3", CLAUDE_CODE_OAUTH_TOKEN: "test-token", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_SKIP_PROMPT: "1", CLAUDE_CONFIG_DIR: "/test/config", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code" };
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    const spec = (id: "claude" | "codex" | "copilot", config: ReturnType<typeof withDefaults>) => ({
      target: targetDef(id), config, environment: selectEnvironment(id, config, vars).env,
      markers: { runId: "r", nodeId: "n", depth: 1 },
    }) as any;
    for (const id of ["codex", "copilot"] as const) for (const child_auth of ["any", "login"] as const) {
      const env = childEnv(spec(id, withDefaults({ child_auth })), () => false);
      for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SKIP_PROMPT", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]) assert.equal(env[k], undefined, `${id}/${child_auth}/${k}`);
      assert.equal(env.CLAUDE_CONFIG_DIR, vars.CLAUDE_CONFIG_DIR, "nested Claude turns need the user's config location");
    }
    const names = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SKIP_PROMPT"];
    const unlisted = childEnv(spec("claude", withDefaults({ child_auth: "any" })), () => false);
    for (const k of names) assert.equal(unlisted[k], undefined, `${k} needs an explicit pass`);
    const own = childEnv(spec("claude", withDefaults({ targets: { claude: { child_auth: "any", child_env: { pass: names } } } })), () => false);
    for (const k of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SKIP_PROMPT", "CLAUDE_CONFIG_DIR"]) assert.equal(own[k], vars[k as keyof typeof vars]);
  } finally { for (const [k,v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
