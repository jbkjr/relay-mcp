import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { adoptRun, harness, task } from "./helpers.ts";

test("host identity under default allow: ambiguous caller is admitted unknown, invalid host stays invalid", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    const root = await h.instance({ host: null, clientInfo: { name: "claude-codex-bridge", version: "1" } });
    const r = await root.call("ask", { target: "codex", message: "hello" });
    assert.equal(r.reply, "ok"); assert.equal(r.families.caller, "unknown");
    const bad = await h.instance({ args: ["--host", "bogus"], clientInfo: { name: "claude-code", version: "2.1.286" } });
    assert.match((await bad.call("ask", { target: "codex", message: "bad" })).error, /--host.*not a host relay knows/);
  } finally { await h.close(); }
});

test("host identity: an invalid explicit --host is refused, never guessed; client names infer a family only when exactly one target matches", async () => {
  const h = await harness([], { same_family: "refuse" });
  try {
    // A registration that names a host relay does not know (or none after the flag) is refused,
    // even from a client whose name would otherwise say who it is.
    for (const args of [["--host", "bogus"], ["--host"]]) {
      const bad = await h.instance({ args, clientInfo: { name: "claude-code", version: "2.1.286" } });
      const r = await bad.call("ask", { target: "codex", message: "hello" });
      assert.match(r.error, /--host.*not a host relay knows/, `${args.join(" ")}: ${JSON.stringify(r)}`);
      await bad.close();
    }
    assert.equal(h.starts().length, 0, "nothing was launched for an invalid --host");

    // No --host (an older registration): the client's name says who it is when one target matches.
    const legacy = await h.instance({ host: null, clientInfo: { name: "claude-code", version: "2.1.286" } });
    assert.match((await legacy.call("ask", { target: "claude", message: "x" })).reason, /You are a Claude agent/);

    // A name that matches more than one target is no evidence: the session is refused as unknown.
    const ambiguous = await h.instance({ host: null, clientInfo: { name: "claude-codex-bridge", version: "1" } });
    assert.match((await ambiguous.call("ask", { target: "codex", message: "x" })).reason, /cannot tell which agent it is running inside/);
    assert.equal(h.starts().length, 0);
  } finally {
    await h.close();
  }
});

test("Codex thread identity: when a model was asked for, the thread must report it and OpenAI's provider; a missing field is refused", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    for (const [thread, expected] of [
      [{ model: null }, /thread does not report its model, so relay cannot tell that the "gpt-6.1-sol" it asked for answers/],
      [{ modelProvider: null }, /thread does not report its model provider/],
      [{ model: null, modelProvider: null }, /thread does not report its model provider/],
      [{ model: "gpt-6.1-sol-mini" }, /reports the model "gpt-6.1-sol-mini", not the "gpt-6.1-sol" relay asked for/],
    ] as const) {
      const root = await h.instance({ env: { STUB_CODEX_THREAD: JSON.stringify(thread) } });
      const r = await root.call("ask", { target: "codex", message: "x", model: "gpt-6.1-sol" });
      assert.match(r.error ?? "", expected, JSON.stringify(thread));
    }
    assert.equal(h.ends().length, 0, "no agent got as far as a turn");
    // Exactly what was asked for passes; with no model asked for, fields the server leaves out are not judged.
    assert.equal((await h.call("ask", { target: "codex", message: "x", model: "gpt-6.1-sol" })).reply, "ok");
    const quiet = await h.instance({ env: { STUB_CODEX_THREAD: JSON.stringify({ model: null, modelProvider: null }) } });
    assert.equal((await quiet.call("ask", { target: "codex", message: "x" })).reply, "ok");
  } finally {
    await h.close();
  }
});

test("targets: a switched-off target may still be named to continue its existing thread, but not to start one", async () => {
  const h = await harness();
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const first = await claude.call("ask", { target: "codex", message: "first" });
    assert.ok(first.thread_id, JSON.stringify(first));
    await claude.close();
    // Codex is switched off afterwards; a session started now has it in its config.
    const file = path.join(h.home, "config.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...cfg, targets: { ...cfg.targets, codex: { ...cfg.targets.codex, enabled: false } } }));
    const later = await h.instance({ args: ["--host", "claude"] });
    // Naming it on a follow-up is accepted by the tool's schema and continues the thread.
    await adoptRun(h, later, first.thread_id);
    const follow = await later.call("ask", { target: "codex", thread_id: first.thread_id, message: "follow-up" });
    assert.equal(follow.tool_error, undefined, follow.tool_error);
    assert.equal(follow.thread_id, first.thread_id);
    assert.match(follow.reply, /turn 2/);
    // Starting something new with it is refused with a reason, not a schema error.
    const fresh = await later.call("ask", { target: "codex", message: "new" });
    assert.match(fresh.reason, /Codex is switched off in relay's config/);
    // A name relay does not know is still a schema error.
    assert.ok((await later.call("ask", { target: "nonesuch", message: "x" })).tool_error);
  } finally {
    await h.close();
  }
});

test("Claude settings relay does not vet: their env could redirect Claude (settingsEnvProblem), and under the never floor a Claude that would inherit them is refused first, whatever claude_settings_env says", async () => {
  const { settingsEnvProblem } = await import("../dist/backends/claude.js");
  assert.equal(settingsEnvProblem({ child_settings: "isolated", claude_settings_env: "refuse" }, null), null);
  assert.match(settingsEnvProblem({ child_settings: "isolated", claude_settings_env: "refuse" }, "/Library/Application Support/ClaudeCode/managed-settings.json")!,
    /organisation-managed settings \(\/Library\/Application Support\/ClaudeCode\/managed-settings\.json\).*another endpoint.*"claude_settings_env": "accept"/);
  assert.match(settingsEnvProblem({ child_settings: "inherit", claude_settings_env: "refuse" }, null)!, /child_settings "inherit"/);
  assert.equal(settingsEnvProblem({ child_settings: "inherit", claude_settings_env: "accept" }, "/etc/claude-code/managed-settings.json"), null);

  // The never floor's refusal of inherited settings (backends/never-admission.ts) comes before settingsEnvProblem's.
  const neverInherit = /^never: inherited Claude settings, hooks or MCP tools can bypass the checked sandbox\/tool route/;
  const h = await harness([{ steps: [{ reply: "ok" }] }], { child_settings: "inherit" });
  try {
    const job = await h.call("delegate", { target: "claude", task: "x", mode: "read", background: false });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, neverInherit);
    assert.equal(h.starts().length, 0, "Claude was not started");
    // The setting is Claude's own: Codex is launched as before.
    assert.equal((await h.call("ask", { target: "codex", message: "x" })).reply, "ok");
  } finally {
    await h.close();
  }
  const accepted = await harness([{ steps: [{ reply: "ok" }] }], { child_settings: "inherit", claude_settings_env: "accept" });
  try {
    // Accepting the settings' env does not get past the floor either.
    const job = await accepted.call("delegate", { target: "claude", task: "x", mode: "read", background: false });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, neverInherit);
    assert.equal(accepted.starts().length, 0, "Claude was not started");
  } finally {
    await accepted.close();
  }
});

test("desktop host: a desktop or SDK root's own ANTHROPIC_BASE_URL is kept from launched agents, so it can resume a Claude job; nothing of it reaches nested agents", async () => {
  const h = await harness([
    { target: "codex", match: task("OUTER"), steps: [{ call: "delegate", args: { target: "claude", task: "INNER", mode: "read", background: false }, as: "inner" }, { reply: "outer: {{inner.job_id}}" }] },
    { target: "claude", turn: 2, steps: [{ call: "delegate", args: { target: "codex", task: "GRANDCHILD", mode: "read", background: false } }, { reply: "resumed" }] },
  ]);
  try {
    const host = { CLAUDE_CODE_DESKTOP_APP_VERSION: "1.2", CLAUDE_AGENT_SDK_VERSION: "0.3", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };
    const desktop = await h.instance({ args: ["--host", "claude"], clientInfo: { name: "claude-code", version: "2.1.299" }, env: { ...host, ANTHROPIC_BASE_URL: "https://host-session.example" } });
    const outer = await desktop.call("delegate", { target: "codex", task: "OUTER", mode: "read", background: false });
    assert.equal(outer.status, "done", JSON.stringify(outer));
    const inner = /outer: (j_[0-9a-f]{8})/.exec(outer.result.final_message)?.[1];
    assert.ok(inner, outer.result.final_message);

    // The desktop root resumes the Claude job directly: its worker carries the host's variables.
    const resumed = await desktop.call("resume", { job_id: inner, message: "go on" });
    assert.equal(resumed.refused, undefined, JSON.stringify(resumed));
    const done = await desktop.call("status", { id: inner, wait_s: 60 });
    assert.equal(done.status, "done", JSON.stringify(done));
    const turn = h.starts().filter((s) => s.target === "claude").at(-1)!;
    assert.equal(turn.resumed, true);
    assert.equal(turn.env.anthropicBaseUrl, false, "the host's endpoint is not handed to the agent");
    assert.equal(turn.env.hostMarkers, false, "nor are the markers that say a desktop or SDK host is running");
    // The agent that resumed delegated in turn: nothing of the host reached that one either.
    const grandchild = h.starts().find((s) => s.prompt.includes("GRANDCHILD"))!;
    assert.equal(grandchild.env.anthropicBaseUrl, false);
    assert.equal(grandchild.env.hostMarkers, false);
  } finally {
    await h.close();
  }
  // Without a desktop or SDK host's markers the variable is the user's own, and Claude is refused.
  const plain = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    const root = await plain.instance({ env: { ANTHROPIC_BASE_URL: "https://proxy.example" } });
    const job = await root.call("delegate", { target: "claude", task: "x", mode: "read", background: false });
    assert.equal(job.status, "failed");
    assert.match(job.error, /sets ANTHROPIC_BASE_URL/);
  } finally {
    await plain.close();
  }
});

test("Codex endpoint in its own config: openai_base_url, or a base_url for the provider in use (also through a profile), is refused unless codex_endpoint_override is \"accept\" (X4)", async () => {
  const { configProblem } = await import("../dist/backends/codex-app.js");
  const { codexPermissions } = await import("../dist/backends/codex.js");
  const permissions = codexPermissions({ access: "read", config: { codex_backend: "app-server" } } as never, { dangerous: false, network: false, roots: [] });
  const expect = { permissions, relay: null, relayOnly: false, accountLogin: false };
  const base = { default_permissions: permissions.id, permissions: { [permissions.id]: permissions.profile }, approvals_reviewer: "user" };
  assert.equal(configProblem(base, expect), null);
  for (const [eff, expected] of [
    [{ openai_base_url: "https://proxy.example/v1" }, /openai_base_url is set \("https:\/\/proxy\.example\/v1"\)/],
    [{ model_providers: { openai: { base_url: "https://proxy.example/v1" } } }, /model_providers\.openai\.base_url is set/],
    [{ profile: "work", profiles: { work: { openai_base_url: "https://proxy.example/v1" } } }, /profiles\.work\.openai_base_url is set/],
    // Under a ChatGPT login these can send traffic elsewhere too (Codex 0.162.1's config/read has them).
    [{ chatgpt_base_url: "https://proxy.example/backend-api/" }, /chatgpt_base_url is set \("https:\/\/proxy\.example\/backend-api\/"\)/],
    [{ experimental_realtime_ws_base_url: "wss://proxy.example" }, /experimental_realtime_ws_base_url is set/],
    [{ experimental_realtime_webrtc_call_base_url: "https://proxy.example" }, /experimental_realtime_webrtc_call_base_url is set/],
  ] as const) {
    assert.match(configProblem({ ...base, ...eff }, expect) ?? "", expected, JSON.stringify(eff));
    assert.match(configProblem({ ...base, ...eff }, expect) ?? "", /codex_endpoint_override/, "the refusal names the setting that accepts it");
  }
  // A profile's own provider is judged as the top level's is, accepted or not.
  const proxied = { ...base, profile: "work", profiles: { work: { model_provider: "openai-proxy" } }, model_providers: { "openai-proxy": { base_url: "https://p" } } };
  assert.match(configProblem(proxied, { ...expect, endpointOverride: true }) ?? "", /model_provider is "openai-proxy" \(profile work\), not OpenAI's/);
  // Accepted: the endpoint is not judged (a provider other than OpenAI's still is).
  assert.equal(configProblem({ ...base, openai_base_url: "https://proxy.example/v1", model_providers: { openai: { base_url: "https://p" } } }, { ...expect, endpointOverride: true }), null);
  // Codex's own default for chatgpt_base_url, or the keys present but unset, change nothing.
  assert.equal(configProblem({ ...base, chatgpt_base_url: "https://chatgpt.com/backend-api/", experimental_realtime_ws_base_url: null }, expect), null);
  assert.equal(configProblem({ ...base, chatgpt_base_url: "https://proxy.example/", experimental_realtime_ws_base_url: "wss://p" }, { ...expect, endpointOverride: true }), null);
  // Another provider's base_url, not the one in use, is not relay's business.
  assert.equal(configProblem({ ...base, model_providers: { ollama: { base_url: "http://localhost:11434/v1" } } }, expect), null);

  const redirect = { STUB_CODEX_EFFECTIVE: JSON.stringify({ openai_base_url: "https://proxy.example/v1" }) };
  for (const backend of ["app-server", "exec"]) {
    const h = await harness([{ steps: [{ reply: "ok" }] }], { codex_backend: backend });
    try {
      const root = await h.instance({ env: redirect });
      const r = await root.call("delegate", { target: "codex", task: "x", mode: "read", background: false });
      assert.equal(r.status, "failed", `${backend}: ${JSON.stringify(r)}`);
      assert.match(r.error, /openai_base_url is set/);
      assert.equal(h.starts().length, 0, `${backend}: no turn was started`);
    } finally {
      await h.close();
    }
    const ok = await harness([{ steps: [{ reply: "ok" }] }], { codex_backend: backend, codex_endpoint_override: "accept" });
    try {
      const root = await ok.instance({ env: redirect });
      assert.equal((await root.call("delegate", { target: "codex", task: "x", mode: "read", background: false })).status, "done", backend);
    } finally {
      await ok.close();
    }
  }
});
