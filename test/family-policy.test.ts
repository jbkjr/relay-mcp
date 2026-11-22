import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { adoptRun, alive, harness, until } from "./helpers.ts";
import { resolveTarget, TARGETS, VENDOR_NAMES, vendorFor } from "../dist/targets/index.js";
import { withDefaults, validateConfig } from "../dist/core/config.js";

test("family policy: default allow, strict compatibility and unknown default validation", () => {
  assert.equal(withDefaults({}).same_family, "allow");
  assert.equal(withDefaults({ same_family: "refuse" }).same_family, "refuse");
  assert.deepEqual(validateConfig({ default_target: { unknown: "codex" } }, "test"), { default_target: { unknown: "codex" } });
  assert.doesNotThrow(() => validateConfig({ default_target: { unknown: "claude" } }, "test"));
  for (const cfg of [{ default_target: { unknown: "bogus" } }, { default_target: { bogus: "codex" } }]) assert.throws(() => validateConfig(cfg, "test"));
  for (const same_family of ["allow", "refuse"] as const) assert.throws(() => validateConfig({ same_family, default_target: { claude: "claude" } }, "test"));
  assert.deepEqual(resolveTarget("claude", "claude", {}), { target: "claude" });
  assert.deepEqual(resolveTarget(null, "codex", {}), { target: "codex" });
  assert.deepEqual(resolveTarget(null, undefined, { default_target: { unknown: "codex" } } as any), { target: "codex" });
  assert.match((resolveTarget(null, undefined, {}) as any).reason, /cannot tell which family of model/);
  assert.match((resolveTarget(null, undefined, { default_target: { unknown: "copilot" } } as any) as any).reason, /default_target.unknown.*switched off/);
  for (const model of [undefined, "auto", "unlisted"]) assert.ok("target" in resolveTarget("claude", "copilot", { targets: { copilot: { enabled: true } } }, { model }));
});

test("family policy: exhaustive omitted-target invariant under both settings", () => {
  // Every subset of the registry switched on, and each target whose family is its model's given each
  // default model independently of the others (all their combinations), so that several of them can be known at once.
  const MODELS = [undefined, "auto", "missing", "gpt-6.1-sol", "claude-sonnet-5.5", "grok-4.6"];
  const perModel = TARGETS.filter((t) => t.vendor === null);
  const combos = perModel.reduce<(string | undefined)[][]>((acc) => acc.flatMap((c) => MODELS.map((m) => [...c, m])), [[]]);
  assert.equal(combos.length, MODELS.length ** perModel.length);
  for (const same_family of ["allow", "refuse"] as const) for (let enabled = 0; enabled < 1 << TARGETS.length; enabled++) for (const combo of combos) {
    const targets = Object.fromEntries(TARGETS.map((t, i) => [t.id, { enabled: Boolean(enabled & (1 << i)), ...(t.vendor === null ? { default_model: combo[perModel.indexOf(t)] } : {}) }]));
    for (const caller of TARGETS) for (const family of Object.keys(VENDOR_NAMES)) for (const preset of [undefined, ...TARGETS.map((t) => t.id)]) {
      const cfg: any = { same_family, targets, ...(preset ? { default_target: { [caller.id]: preset } } : {}) };
      const r = resolveTarget(caller.id, undefined, cfg, { callerVendor: family as any });
      if ("target" in r) {
        const reached = TARGETS.find((t) => t.id === r.target)!;
        const actual = vendorFor(reached, r.model);
        assert.ok(actual && actual !== family, JSON.stringify({ caller, family, cfg, r }));
      }
    }
  }
  for (const same_family of ["allow", "refuse"] as const) for (const caller of [null, ...TARGETS.map(t => t.id)]) for (const preset of [undefined, ...TARGETS.map(t => t.id)]) {
    // Every target switched on, so that a preset is never refused for being off.
    const cfg: any = { same_family, targets: Object.fromEntries(TARGETS.map((t) => [t.id, { enabled: true }])), default_target: preset ? { unknown: preset } : {} };
    const r = resolveTarget(caller, undefined, cfg, { callerVendor: null });
    if (same_family === "refuse" || !preset) assert.ok("reason" in r, JSON.stringify({ cfg, caller, r }));
    else assert.equal((r as any).target, preset, "unknown routing uses only the explicit unknown default");
  }
});

test("family policy: every start mode admits and labels own family; strict refuses before creation", async () => {
  for (const same_family of ["allow", "refuse"]) {
    const h = await harness([{ steps: [{ reply: "ok\nAGREE: done" }] }], { same_family });
    try {
      const root = await h.instance({ args: ["--host", "claude"] });
      for (const [tool, args] of [["delegate", { task: "same", mode: "read", background: false }], ["ask", { message: "same" }], ["discuss", { topic: "same", message: "AGREE: done" }], ["review", { target: "README.md", reviewer: "claude" }]] as const) {
        const claudeStarts = () => h.starts().filter((s) => s.target === "claude");
        const before = claudeStarts().length;
        const r = await root.call(tool, { ...(tool === "review" ? {} : { target: "claude" }), ...args });
        if (same_family === "refuse") { assert.equal(r.refused, true, JSON.stringify(r)); continue; }
        assert.equal(r.families.relation, "same-family", JSON.stringify(r));
        assert.ok(r.families.note);
        // discuss can answer before its other side's start is logged: wait for that start, then read it.
        if (tool === "discuss") {
          await until(() => claudeStarts().length > before, 10_000, "discuss's start");
          assert.match(claudeStarts()[before].prompt, /another Claude agent, of your own family \(Anthropic\)/);
        }
        if (tool === "review") { assert.match(r.next, /same-family review/); await root.call("review", { review_id: r.review_id, skip_own: true }); }
      }
      if (same_family === "refuse") assert.equal(h.starts().length, 0);
      else assert.match((await root.call("status")).tree, /\[same-family\]/);
    } finally { await h.close(); }
  }
});

test("host guards: contradiction is unknown, always excludes opencode and T3, inbox override", async () => {
  const { hostProfile, registrationAgrees, hostFamilyDoubt } = await import("../dist/mcp/host.js");
  for (const client of ["opencode", "grok", "codex-mcp-client"]) assert.equal(registrationAgrees("claude", client, false), false);
  for (const client of ["claude-code", "local-agent-mode-relay", ""]) assert.equal(registrationAgrees("claude", client, false), true);
  assert.equal(registrationAgrees("claude", "opencode", true), false, "a known multi-model client also contradicts a copied desktop registration");
  assert.equal(registrationAgrees("claude", "desktop-chat", true), true);
  for (const marker of [{}, { CLAUDE_AGENT_SDK_VERSION: "0.3", CLAUDE_CODE_DESKTOP_APP_VERSION: "1" }]) {
    assert.ok(hostFamilyDoubt({ ...marker, ANTHROPIC_BASE_URL: "https://proxy.example" }, "anthropic"));
    assert.equal(hostFamilyDoubt({ ...marker, ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, "anthropic"), null);
  }
  for (const model of ["opus", "opus[1m]", "sonnet", "haiku", "opusplan", "claude-opus-5.5", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"]) assert.equal(hostFamilyDoubt({ ANTHROPIC_MODEL: model }, "anthropic"), null);
  assert.ok(hostFamilyDoubt({ ANTHROPIC_MODEL: "glm-4.6" }, "anthropic"));
  assert.ok(hostFamilyDoubt({ ANTHROPIC_MODEL: "opus", ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-4.6" }, "anthropic"));
  assert.equal(hostFamilyDoubt({ OPENAI_BASE_URL: "https://proxy.example" }, "openai"), "OPENAI_BASE_URL");
  const profile = hostProfile({}, { name: "claude-code", version: "2.1.299" }, true, [], null, { inbox: false } as any);
  assert.equal(profile.inbox, false);
  for (const name of ["opencode", "cli", "t3-code"]) assert.equal(hostProfile({}, { name, version: "2.0.32" }, true).elicit, "no");
  const h = await harness([{ steps: [{ reply: "ok" }] }], { ask_user: "always" });
  try {
    const host = await h.instance({ args: ["--host", "claude"], clientInfo: { name: "opencode", version: "2.0.32" } });
    const stamped = { meta: { "ai.opencode/sessionID": "ses_guard" } };
    assert.match((await host.call("ask", { message: "which?" }, stamped)).reason, /cannot tell which family of model/);
    const r = await host.call("ask", { target: "codex", message: "ok" }, stamped);
    assert.equal(r.families.caller, "unknown");
    assert.match(r.families.note, /registered as claude.*opencode/);
  } finally { await h.close(); }
});

test("family policy: unknown roots can follow up, resume and continue borrowed discussions under allow", async () => {
  const h = await harness([{ steps: [{ reply: "ok\nCONTINUE" }] }]);
  try {
    const first = await h.instance({ args: ["--host", "claude"] });
    const thread = await first.call("ask", { target: "codex", message: "first" });
    const job = await first.call("delegate", { target: "codex", task: "job", mode: "read", background: false });
    const d = await first.call("discuss", { with: thread.thread_id, topic: "continuation", message: "hello\nCONTINUE" });
    const pid = h.sql("SELECT root_pid FROM runs WHERE id = (SELECT run_id FROM nodes WHERE id = ?)", job.job_id)[0].root_pid;
    await first.close();
    await until(() => !alive(pid));
    const later = await h.instance({ host: null });
    await adoptRun(h, later, job.job_id);
    const followed = await later.call("ask", { thread_id: thread.thread_id, message: "follow" });
    assert.equal(followed.families.caller, "unknown");
    const resumed = await later.call("resume", { job_id: job.job_id, message: "resume" });
    assert.equal(resumed.families.caller, "unknown");
    const continued = await later.call("discuss", { discussion_id: d.discussion_id, message: "stop\nCRUX: done" });
    assert.equal(continued.families.caller, "unknown");
    assert.equal((await later.call("status", { id: job.job_id, wait_s: 30 })).families.caller, "unknown");
  } finally { await h.close(); }
});

test("host guards: unattributable elicitation is never asked under always; unknown roots retain approval authority", async () => {
  for (const clientInfo of [{ name: "opencode", version: "2.0.32" }, { name: "codex-mcp-client", version: "0.163.0" }]) {
    const h = await harness([{ steps: [{ request: "echo full-access" }, { reply: "finished" }] }], { ask_user: "always" });
    let asked = 0;
    try {
      const connected = await h.instance({ host: null, clientInfo, env: clientInfo.name === "codex-mcp-client" ? { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code" } : {}, elicit: () => { asked++; return { action: "accept", content: { decision: "allow" } }; } });
      // OpenCode 2 stamps every call with its session.
      const root = clientInfo.name === "opencode" ? { call: (tool: string, args: Record<string, unknown> = {}) => connected.call(tool, args, { meta: { "ai.opencode/sessionID": "ses_guard" } }) } : connected;
      const r = await root.call("delegate", { target: "codex", task: "request", mode: "write" });
      const waiting = await root.call("status", { id: r.job_id, wait_s: 30 });
      assert.equal(asked, 0);
      assert.ok(waiting.needs_approval?.length, JSON.stringify(waiting));
      assert.match(waiting.needs_approval[0].effect, /full access/);
      const allowed = await root.call("approve", { request_id: waiting.needs_approval[0].request_id, decision: "allow" });
      assert.equal(allowed.decision, "allowed", JSON.stringify(allowed));
      assert.equal((await root.call("status", { id: r.job_id, wait_s: 30 })).status, "done");
    } finally { await h.close(); }
  }
});

test("family policy: an unknown caller's configured default also resolves the shared brief target", async () => {
  const h = await harness([], { default_target: { unknown: "codex" } });
  try {
    const root = await h.instance({ host: null });
    const r = await root.call("brief");
    assert.equal(r.target, "codex", JSON.stringify(r));
    assert.ok(r.brief);
    assert.equal(h.starts().length, 0, "reading a brief starts no agent");
  } finally { await h.close(); }
});
