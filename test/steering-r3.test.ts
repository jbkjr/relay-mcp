import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { conversationOn, harness, until } from "./helpers.ts";
import { hostProfile, registrationAgrees, hostFamilyDoubt } from "../dist/mcp/host.js";
import { withDefaults } from "../dist/core/config.js";
import { targetDef } from "../dist/targets/index.js";
import { selectEnvironment } from "../dist/core/env-policy.js";

const codeTab = { CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_DESKTOP_APP_VERSION: "2.42304.0", CLAUDE_AGENT_SDK_VERSION: "0.3.299" };
const claude = { name: "claude-code", version: "2.1.299" };
const codex = { name: "codex-mcp-client", version: "0.163.0" };
const t3 = { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code" };

test("r3 desktop inbox: Code tab stays on, bare SDK and T3 off, explicit override wins", async () => {
  assert.equal(hostProfile(codeTab, claude, true).inbox, true);
  assert.equal(hostProfile({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_AGENT_SDK_VERSION: "0.3" }, claude, true).inbox, true);
  assert.equal(hostProfile({ CLAUDE_AGENT_SDK_VERSION: "0.3" }, claude, true).inbox, false);
  assert.equal(hostProfile(t3, codex, true).inbox, false);
  assert.equal(hostProfile({ ...codeTab, RELAY_HOST_INBOX: "off" }, claude, true).inbox, false);
  assert.equal(hostProfile({ CLAUDE_AGENT_SDK_VERSION: "0.3", RELAY_HOST_INBOX: "on" }, claude, true).inbox, true);
  const h = await harness([{ steps: [{ reply: "done" }] }]);
  try {
    const inbox = await h.inbox();
    const root = await h.instance({ args: ["--host", "claude"], clientInfo: claude, env: { ...codeTab, ...inbox.env } });
    await root.call("delegate", { target: "codex", task: "desktop notice", mode: "read" });
    await until(() => inbox.posts().length === 1, 15000, "the Code tab's completion notice");
  } finally { await h.close(); }
});

test("r3 desktop registration: unobserved names retain family; known multi-model clients contradict", async () => {
  for (const name of ["desktop chat", "Cowork", "claude-ai", "Claude", "local-agent-mode-relay", "unobserved-name", ""]) assert.equal(registrationAgrees("claude", name, true), true, name);
  for (const name of ["opencode", "grok", "cursor", "cli", "t3-code"]) assert.equal(registrationAgrees("claude", name, true), false, name);
  assert.equal(registrationAgrees("claude", "grok", false), false);
  for (const same_family of ["allow", "refuse"]) {
    const h = await harness([{ steps: [{ reply: "ok" }] }], { same_family });
    try {
      const shared = await h.instance({ args: ["--host", "claude", "--desktop"], clientInfo: { name: "unobserved-desktop-chat", version: "0" } });
      // The desktop entry is shared: each conversation carries its session token.
      const conversation = await conversationOn(shared);
      const r = await conversation.call("ask", { message: "default routing" });
      assert.equal(r.reply, "ok", JSON.stringify(r));
      assert.equal(r.families.relation, "cross-family");
      assert.equal((await shared.call("brief")).target, "codex");
      if (same_family === "allow") {
        const own = await conversation.call("ask", { target: "claude", message: "W5: another Claude" });
        assert.equal(own.families.relation, "same-family");
      }
    } finally { await h.close(); }
  }
});

test("r3 host environment: no launched target inherits T3 originator markers", async () => {
  const { childEnv } = await import("../dist/backends/env.js");
  for (const id of ["claude", "codex", "copilot"] as const) for (const child_auth of ["any", "login"] as const) {
      const config = withDefaults({ child_auth });
      const selected = selectEnvironment(id, config, t3);
      const env = childEnv({ target: targetDef(id), config, environment: selected.env, environmentReleased: selected.releasedNames, markers: { runId: "r", nodeId: "n", depth: 1 } } as any, () => false);
      assert.equal(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined, id);
  }
});

test("r3 handshake: no identity updates for matching clients, no list changes before initialize result", async () => {
  const h = await harness();
  const before = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  try {
    process.env.RELAY_HOME = h.home; process.env.RELAY_CONFIG = `${h.home}/config.json`;
    const { relayServer } = await import("../dist/mcp/server.js");
    const { newInstance } = await import("../dist/core/caller.js");
    for (const name of ["claude-code", "opencode"]) {
      const server = relayServer(newInstance({ kind: "root" }, h.repo, "claude"));
      const [a, b] = InMemoryTransport.createLinkedPair();
      const messages: any[] = [];
      const sendA = a.send.bind(a); a.send = async (m, o) => { messages.push(m); await sendA(m, o); };
      const sendB = b.send.bind(b); b.send = async (m, o) => { if (!("method" in m && m.method === "notifications/initialized")) await sendB(m, o); };
      const client = new Client({ name, version: "0" });
      try {
        await Promise.all([server.connect(a), client.connect(b)]);
        const init = messages.findIndex(m => m.result?.protocolVersion);
        assert.ok(init >= 0);
        assert.equal(messages.slice(0, init).filter(m => m.method === "notifications/tools/list_changed").length, 0);
        assert.equal(messages.filter(m => m.method === "notifications/tools/list_changed").length, 0, "nothing has been listed yet");
        if (name === "opencode") assert.match(client.getInstructions()!, /cannot tell which family/);
      } finally { await client.close(); await server.close(); }
    }
  } finally {
    for (const [k,v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await h.close();
  }
});

test("r3 models: Claude Bedrock regions, model-carrying ARNs, Vertex and aliases; impostors stay unknown", () => {
  for (const prefix of ["global", "apac", "eu", "us", "us-gov"]) {
    const model = `${prefix}.anthropic.claude-sonnet-4-5-20250929-v1:0`;
    assert.equal(hostFamilyDoubt({ ANTHROPIC_MODEL: model }, "anthropic"), null, model);
    for (const kind of ["foundation-model", "inference-profile", "application-inference-profile"]) assert.equal(hostFamilyDoubt({ ANTHROPIC_MODEL: `arn:aws:bedrock:us-west-2:123456789012:${kind}/${model}` }, "anthropic"), null, kind);
  }
  for (const model of ["claude-3-7-sonnet@20250219", "claude-3-5-sonnet-v2@20241022", "claude-sonnet-4-5@20250929", "anthropic.claude-v2:1", "anthropic.claude-instant-v1", "arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/anthropic.claude-3-7-sonnet-20250219-v1:0", "claude-opus-5.5", "opus[1m]", "sonnet", "haiku"]) assert.equal(hostFamilyDoubt({ ANTHROPIC_MODEL: model }, "anthropic"), null, model);
  for (const model of ["claude-qwen3-coder", "openrouter/not-claude-qwen", "claude-sonnet-qwen", "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/opaque-id"]) assert.equal(hostFamilyDoubt({ ANTHROPIC_MODEL: model }, "anthropic"), "ANTHROPIC_MODEL", model);
});

test("r3 T3 approvals: auto and always leave every decision to root/terminal", async () => {
  for (const ask_user of ["auto", "always"]) {
    // A web search: Claude's command requests are refused under the never floor before they are filed.
    const h = await harness([{ steps: [{ request: { web: "needs approval" } }, { reply: "done" }] }], { ask_user });
    let asked = 0;
    try {
      const root = await h.instance({ args: ["--host", "codex"], clientInfo: codex, env: t3, elicit: () => { asked++; return { action: "accept", content: { decision: "allow" } }; } });
      const r = await root.call("delegate", { target: "claude", task: "approval", mode: "write" });
      const pending = await root.call("status", { id: r.job_id, wait_s: 30 });
      assert.equal(asked, 0, ask_user);
      assert.ok(pending.needs_approval?.length, JSON.stringify(pending));
      await root.call("approve", { request_id: pending.needs_approval[0].request_id, decision: "allow" });
      assert.equal((await root.call("status", { id: r.job_id, wait_s: 30 })).status, "done");
    } finally { await h.close(); }
  }
});

test("r3 waiver labels: isolated Claude is known; inherited settings are unknown; Codex config note is explicit", async () => {
  for (const child_settings of ["isolated", "inherit"]) {
    const h = await harness([{ steps: [{ reply: "ok" }] }], { child_settings, claude_settings_env: "accept" });
    try {
      const root = await h.instance({ args: ["--host", "codex"] });
      const r = await root.call("delegate", { target: "claude", task: "waiver", mode: "read" });
      assert.equal(r.families.launched, child_settings === "isolated" ? "anthropic" : "unknown");
      await root.call("status", { id: r.job_id, wait_s: 30 });
    } finally { await h.close(); }
  }
  const h = await harness([{ steps: [{ reply: "ok" }] }], { codex_endpoint_override: "accept" });
  try {
    const r = await h.call("delegate", { target: "codex", task: "config accepts override", mode: "read", background: false });
    assert.match(r.families.note, /conservatively.*even when no redirect/);
    assert.doesNotMatch(r.families.note, /launched Codex with an endpoint/);
  } finally { await h.close(); }
});

test("r3 strict unknown advice names the install command and the copied-registration caveat", async () => {
  const s = await import("../dist/core/steering.js");
  for (const text of [s.unknownStrict, s.instructions(null, withDefaults({ same_family: "refuse" }))]) {
    assert.match(text, /relay install <host>/);
    assert.match(text, /cop(?:y|ied).*single-family/i);
  }
});
