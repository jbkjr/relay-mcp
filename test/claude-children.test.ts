// What a launched Claude takes from the person's own setup, and from the host relay runs in: the
// deny rules in their user settings, and nothing else; and, under the desktop app or another Agent
// SDK host, not that host's endpoint. Every home here is a scratch directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { userDenyRules } from "../dist/backends/claude.js";
import { HARNESS_CONFIG } from "../dist/confine/seatbelt.js";
import { harness, claudeFloorDeny, claudeReadDeny, type Harness } from "./helpers.ts";

const settingsOf = (start: { argv: string[] }) => JSON.parse(fs.readFileSync(start.argv[start.argv.indexOf("--settings") + 1], "utf8"));
const writeUserSettings = (dir: string, content: unknown) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), typeof content === "string" ? content : JSON.stringify(content));
};
const claudeDir = (h: Harness) => path.join(h.env.HOME, ".claude");
// Relay's own deny rules, after the user's: on a write turn the edit tools are kept off the worktree's
// `.git` file, relay's identity directory and the harness configuration at its top (HARNESS_CONFIG),
// as the sandbox keeps the shell off them.
// And on every turn, Claude's file tools are kept from the API key relay hands a key-only target
// and from relay's sockets directory (claudeReadDeny), as the sandbox keeps the shell from them;
// then, last, the never floor's rules (claudeFloorDeny), which every Claude turn gets.
const relayDeny = (start: { access: string; cwd: string }, h: Pick<Harness, "env" | "sql">) => [
  `Edit(/${path.join(h.env.HOME, ".relay-t")})`, `Edit(/${path.join(h.env.HOME, ".relay-t")}/**)`,
  ...(start.access === "write" ? [".git", ".relay", ...HARNESS_CONFIG].flatMap((p) => [`Edit(/${path.join(start.cwd, p)})`, `Edit(/${path.join(start.cwd, p)}/**)`]) : []),
  ...claudeReadDeny(h.env.HOME).rules,
  ...claudeFloorDeny(h),
];
const NEVER_INHERIT = /^never: inherited Claude settings, hooks or MCP tools can bypass the checked sandbox\/tool route/;

test("claude children: the deny rules in the user's settings reach a launched Claude, and nothing else from that file does", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    writeUserSettings(claudeDir(h), {
      permissions: {
        allow: ["Bash(*)", "Edit(//**)"], ask: ["Bash(git push *)"], additionalDirectories: ["/"], defaultMode: "bypassPermissions",
        deny: ["Bash(rm *)", "WebFetch", "Read(/secrets/**)", "Edit(/notes/**)", "Read(//etc/hosts)", "Read(~/private/**)", "Read(./.env)", "Bash(/usr/bin/curl *)"],
      },
      env: { ANTHROPIC_API_KEY: "sk-ant-not-to-be-copied" },
      apiKeyHelper: "echo sk-ant-helper",
      sandbox: { filesystem: { allowWrite: ["/"] } },
    });
    for (const mode of ["write", "read"] as const) {
      const job = await h.call("delegate", { target: "claude", task: "x", mode, background: false });
      assert.equal(job.status, "done", JSON.stringify(job));
    }
    const dir = claudeDir(h);
    for (const start of h.starts()) {
      const file = start.argv[start.argv.indexOf("--settings") + 1];
      const settings = settingsOf(start);
      const codexHome = path.join(h.env.HOME, ".local/share/relay-codex-home");
      const pinStore = path.join(h.env.HOME, ".local/share/relay-codex-pins");
      assert.ok(settings.sandbox.filesystem.denyRead.includes(codexHome));
      assert.ok(settings.sandbox.filesystem.denyWrite.includes(codexHome));
      assert.ok(settings.sandbox.filesystem.denyWrite.includes(pinStore));
      assert.deepEqual(settings.permissions.deny, [
        "Bash(rm *)", "WebFetch",
        // One leading slash is relative to the file the rule was in, so it is anchored there.
        `Read(/${dir}/secrets/**)`, `Edit(/${dir}/notes/**)`,
        "Read(//etc/hosts)", "Read(~/private/**)", "Read(./.env)", "Bash(/usr/bin/curl *)",
        ...relayDeny(start, h),
      ], start.access);
      // The floor's built-in credential stores under the job's HOME are among them, for both kinds of tool, and in the sandbox for the shell.
      for (const p of [path.join(h.env.HOME, ".ssh"), path.join(h.env.HOME, ".aws"), "/Library/Keychains"]) {
        for (const tool of ["Read", "Edit"]) assert.ok(settings.permissions.deny.includes(`${tool}(/${p})`) && settings.permissions.deny.includes(`${tool}(/${p}/**)`), `${tool} ${p}`);
        assert.ok(settings.sandbox.filesystem.denyRead.includes(p) && settings.sandbox.filesystem.denyWrite.includes(p), p);
      }
      assert.equal(settings.sandbox.allowUnsandboxedCommands, false, "no unsandboxed retry under the floor");
      // Relay's own ask rules (escalation's "Bash") may be there; none of the user's allow or ask rules, directories or mode are.
      assert.deepEqual(Object.keys(settings.permissions).filter((k) => k !== "ask"), ["deny"]);
      assert.ok(!(settings.permissions.ask ?? []).includes("Bash(git push *)"));
      assert.deepEqual(settings.env, { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0", TMPDIR: start.env.tmpdir, CLAUDE_CODE_TMPDIR: start.env.tmpdir, CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1", CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1" }, "relay's own variables only, none of the user's");
      assert.equal(settings.apiKeyHelper, undefined);
      assert.deepEqual(settings.sandbox.filesystem.allowWrite, [start.env.tmpdir]);
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /sk-ant/, "no credential from the file reaches relay's settings");
      assert.equal(start.argv[start.argv.indexOf("--setting-sources") + 1], "", "the user's settings file itself is still not loaded");
    }
  } finally {
    await h.close();
  }
});

test("claude children: deny rules sit beside relay's own ask rules, and come from CLAUDE_CONFIG_DIR where it is set", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }], { child_web: "ask" });
  try {
    writeUserSettings(claudeDir(h), { permissions: { deny: ["Bash(from-home *)"] } });
    const other = path.join(h.env.HOME, "elsewhere", "claude-config");
    writeUserSettings(other, { permissions: { deny: ["Bash(from-config-dir *)", "Edit(/x)"] } });
    const root = await h.instance({ env: { CLAUDE_CONFIG_DIR: other } });
    assert.equal((await root.call("delegate", { target: "claude", task: "x", mode: "read", background: false })).status, "done");
    const { permissions } = settingsOf(h.starts()[0]);
    assert.deepEqual(permissions.deny, ["Bash(from-config-dir *)", `Edit(/${other}/x)`, ...relayDeny(h.starts()[0], h)]);
    assert.deepEqual(permissions.ask, ["Bash", "WebSearch", "WebFetch"]);
  } finally {
    await h.close();
  }
});

test("claude children: no user settings means no deny rules of theirs, and inherit, where Claude would load them itself, is refused under the never floor", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  // Even with claude_settings_env "accept" (the settings' env is not vetted), the never floor refuses inherit first.
  const inheriting = await harness([{ steps: [{ reply: "ok" }] }], { child_settings: "inherit", claude_settings_env: "accept" });
  try {
    assert.equal((await h.call("delegate", { target: "claude", task: "x", mode: "write", background: false })).status, "done");
    assert.deepEqual(settingsOf(h.starts()[0]).permissions?.deny, relayDeny(h.starts()[0], h));
    // A file with no deny list adds nothing either.
    writeUserSettings(claudeDir(h), { permissions: { allow: ["Bash(*)"] }, model: "opus" });
    assert.equal((await h.call("delegate", { target: "claude", task: "x", mode: "write", background: false })).status, "done");
    assert.deepEqual(settingsOf(h.starts()[1]).permissions?.deny, relayDeny(h.starts()[1], h));

    // Inherited settings could bypass the floor's checked sandbox and tool route, so no Claude is launched.
    writeUserSettings(claudeDir(inheriting), { permissions: { deny: ["Bash(rm *)"] } });
    const refused = await inheriting.call("delegate", { target: "claude", task: "x", mode: "write", background: false });
    assert.equal(refused.status, "failed", JSON.stringify(refused));
    assert.match(refused.error, NEVER_INHERIT);
    assert.equal(inheriting.starts().length, 0);
  } finally {
    await h.close();
    await inheriting.close();
  }
});

test("claude children: user settings relay cannot make sense of stop the launch, without quoting the file", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    for (const [content, expected] of [
      ['{ "env": { "ANTHROPIC_API_KEY": "sk-ant-secret" }, ', /is not valid JSON/],
      ["[]", /does not hold a JSON object/],
      [{ permissions: ["Bash(rm *)"] }, /"permissions" is not an object/],
      [{ permissions: { deny: "Bash(rm *)" } }, /"permissions.deny" is not a list of strings/],
      [{ permissions: { deny: ["Bash(rm *)", 7] } }, /"permissions.deny" is not a list of strings/],
    ] as const) {
      writeUserSettings(claudeDir(h), content);
      const job = await h.call("delegate", { target: "claude", task: "x", mode: "read", background: false });
      assert.equal(job.status, "failed", JSON.stringify(content));
      assert.match(job.error, expected);
      assert.match(job.error, /does not launch Claude/);
      assert.doesNotMatch(job.error, /sk-ant/);
    }
    // A settings path relay cannot read is refused too, not skipped.
    fs.rmSync(claudeDir(h), { recursive: true });
    fs.mkdirSync(path.join(claudeDir(h), "settings.json"), { recursive: true });
    const job = await h.call("delegate", { target: "claude", task: "x", mode: "read", background: false });
    assert.match(job.error, /could not read the file \(EISDIR\)/);
    assert.equal(h.starts().length, 0, "no agent was started");
  } finally {
    await h.close();
  }
});

test("claude children: userDenyRules reads only the file under CLAUDE_CONFIG_DIR it is given", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-deny-")));
  try {
    assert.deepEqual(userDenyRules({ CLAUDE_CONFIG_DIR: tmp }), []);
    writeUserSettings(tmp, { permissions: { deny: ["Read(/a)", "Read(//b)", "Edit(/c/d)", "Bash(/e)", "Read(!/f)"] } });
    assert.deepEqual(userDenyRules({ CLAUDE_CONFIG_DIR: tmp }), [`Read(/${tmp}/a)`, "Read(//b)", `Edit(/${tmp}/c/d)`, "Bash(/e)", "Read(!/f)"]);
    // A trailing slash in the variable does not double the separator.
    assert.deepEqual(userDenyRules({ CLAUDE_CONFIG_DIR: `${tmp}/` })[0], `Read(/${tmp}/a)`);
    // A directory whose name would read as pattern syntax cannot anchor a rule faithfully: refused,
    // but only when a rule needs anchoring there.
    for (const name of ["claude[work]", "c*", "c?", "c{a,b}", "c\\d", "c!", "c\nd"]) {
      const odd = path.join(tmp, name);
      writeUserSettings(odd, { permissions: { deny: ["Bash(rm *)", "Read(//abs)"] } });
      assert.deepEqual(userDenyRules({ CLAUDE_CONFIG_DIR: odd }), ["Bash(rm *)", "Read(//abs)"], name);
      writeUserSettings(odd, { permissions: { deny: ["Read(/secrets/**)"] } });
      assert.throws(() => userDenyRules({ CLAUDE_CONFIG_DIR: odd }), /would read as a pattern, so relay cannot anchor it there/, name);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude children: under the desktop app or an Agent SDK host, its endpoint is removed from a launched Claude instead of refused", async () => {
  // Select the endpoints to exercise the older host/login guard as well as the allowlist.
  const h = await harness([{ steps: [{ reply: "ok" }] }], { child_env: { pass: ["ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "OPENAI_BASE_URL", "STUB_INIT"] } });
  try {
    const hostEnv = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/host-proxy", ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example" };
    for (const hostVar of ["CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_AGENT_SDK_VERSION"]) {
      const before = h.starts().length;
      const root = await h.instance({ env: { ...hostEnv, [hostVar]: "1.2.3" } });
      const job = await root.call("delegate", { target: "claude", task: "x", mode: "read", background: false });
      assert.equal(job.status, "done", `${hostVar}: ${JSON.stringify(job)}`);
      const start = h.starts()[before];
      assert.deepEqual(start.env.baseUrls, [], `${hostVar}: no endpoint variable reaches the agent`);
      assert.deepEqual(start.env.hostVars, [], `${hostVar}: nor the variables that mark the host`);
    }
    // The child's login and model are still checked there.
    for (const [init, expected] of [
      [{ apiKeySource: "ANTHROPIC_API_KEY" }, /signing in with an API key/],
      [{ model: "kimi-k2" }, /not a Claude model/],
    ] as const) {
      const root = await h.instance({ env: { ...hostEnv, CLAUDE_CODE_DESKTOP_APP_VERSION: "1.2.3", STUB_INIT: JSON.stringify(init) } });
      const job = await root.call("delegate", { target: "claude", task: "x", mode: "read", background: false });
      assert.equal(job.status, "failed");
      assert.match(job.error, expected);
    }
    // Without those host variables the person set the endpoint on purpose: refused, as before.
    for (const env of [hostEnv, { ...hostEnv, CLAUDE_CODE_DESKTOP_APP_VERSION: "" }]) {
      const job = await (await h.instance({ env })).call("delegate", { target: "claude", task: "x", mode: "read", background: false });
      assert.equal(job.status, "failed");
      assert.match(job.error, /sets ANTHROPIC_BASE_URL, ANTHROPIC_BEDROCK_BASE_URL, which sends Claude Code to another endpoint/);
    }
    // The host variables speak only for Anthropic's endpoint variables: Codex is refused with its own as before.
    const codex = await (await h.instance({ env: { OPENAI_BASE_URL: "https://openrouter.example", CLAUDE_CODE_DESKTOP_APP_VERSION: "1.2.3" } }))
      .call("delegate", { target: "codex", task: "x", mode: "read", background: false });
    assert.match(codex.error, /sets OPENAI_BASE_URL/);
  } finally {
    await h.close();
  }
});

test("claude children: under such a host, a Claude that may sign in with a key is refused with the endpoint, not sent to Anthropic with it", async () => {
  const hostEnv = { ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_AUTH_TOKEN: "gateway-token", ANTHROPIC_API_KEY: "sk-ant-test", CLAUDE_AGENT_SDK_VERSION: "1.2.3" };
  const harnesses: Harness[] = [];
  try {
    // Wherever "any" applies to Claude, its endpoint intent is preserved even if no endpoint is
    // selected. Explicitly selected keys (or a key in Claude's store) must not go to Anthropic.
    for (const config of [{ child_auth: "any" }, { targets: { claude: { child_auth: "any" } } }]) for (const pass of [[], ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]]) {
      const h = await harness([{ steps: [{ reply: "ok" }] }], { ...config, child_env: { pass } });
      harnesses.push(h);
      const job = await (await h.instance({ env: hostEnv })).call("delegate", { target: "claude", task: "x", mode: "read", background: false });
      assert.equal(job.status, "failed", JSON.stringify({ config, pass }));
      assert.match(job.error, /sets ANTHROPIC_BASE_URL, which sends Claude Code to another endpoint/);
      assert.match(job.error, /"child_auth": "login"/);
      assert.equal(h.starts().length, 0, "no agent was started");
    }
    // Where Claude itself signs in with its login, the endpoint is the host's and is removed, with
    // the credential: "any" for Codex alone, or a login set for Claude over a global "any".
    for (const config of [{ targets: { codex: { child_auth: "any" } } }, { child_auth: "any", targets: { claude: { child_auth: "login" } } }]) {
      const h = await harness([{ steps: [{ reply: "ok" }] }], { ...config, child_env: { pass: ["ANTHROPIC_BASE_URL"] } });
      harnesses.push(h);
      const job = await (await h.instance({ env: hostEnv }))
        .call("delegate", { target: "claude", task: "x", mode: "read", background: false });
      assert.equal(job.status, "done", `${JSON.stringify(config)}: ${JSON.stringify(job)}`);
      assert.deepEqual(h.starts()[0].env.baseUrls, []);
      assert.equal(h.starts()[0].env.anthropicKey, false);
    }
  } finally {
    for (const h of harnesses) await h.close();
  }
});

test("claude children: a tool that a carried-over deny rule removes may be missing at start, and the turn runs", async () => {
  // Per-instance stub controls are not part of the harness's default synthetic passes.
  const h = await harness([{ steps: [{ reply: "ok" }] }], { child_env: { pass: ["STUB_INIT"] } });
  try {
    writeUserSettings(claudeDir(h), { permissions: { deny: ["WebFetch", "Bash"] } });
    // What Claude reports when those rules take the tools out of its context.
    const tools = ["Read", "Grep", "Glob", "WebSearch", "Edit", "Write"];
    const root = await h.instance({ env: { STUB_INIT: JSON.stringify({ tools }) } });
    const job = await root.call("delegate", { target: "claude", task: "x", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.deepEqual(settingsOf(h.starts()[0]).permissions.deny, ["WebFetch", "Bash", ...relayDeny(h.starts()[0], h)]);
    // A tool relay did not give is still refused.
    const extra = await (await h.instance({ env: { STUB_INIT: JSON.stringify({ tools: [...tools, "CronCreate"] }) } }))
      .call("delegate", { target: "claude", task: "x", mode: "write", background: false });
    assert.equal(extra.status, "failed", JSON.stringify(extra));
    assert.match(extra.error, /tools relay did not give it \(CronCreate\)/);
  } finally {
    await h.close();
  }
});

test("claude children: CLAUDE_AUTO_BACKGROUND_TASKS in relay's environment does not reach a launched Claude, where it would drop the agent's own relay calls that run past two minutes", async () => {
  // Seen with claude -p, Claude Code 2.1.302 (experiments/answers.md P-a):
  // with the variable set, an MCP call still running after 120 s is moved to the background, the
  // turn ends without its result, and -p stops the call as it exits. A launched Claude is claude -p.
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    const root = await h.instance({ env: { CLAUDE_AUTO_BACKGROUND_TASKS: "1" } });
    for (const target of ["claude", "codex"]) {
      const job = await root.call("delegate", { target, task: "x", mode: "read", background: false });
      assert.equal(job.status, "done", `${target}: ${JSON.stringify(job)}`);
    }
    const [claude, codex] = ["claude", "codex"].map((t) => h.starts().find((s) => s.target === t)!);
    assert.equal(claude.env.autoBackground, null, "not in a launched Claude's environment");
    assert.equal(codex.env.autoBackground, null, "the default allowlist excludes it from Codex too");
    // Select it for Codex so the Claude guard's nested-launch property is still exercised.
    const config = JSON.parse(fs.readFileSync(path.join(h.home, "config.json"), "utf8"));
    config.child_env.pass.push("CLAUDE_AUTO_BACKGROUND_TASKS");
    fs.writeFileSync(path.join(h.home, "config.json"), JSON.stringify(config));
    for (const target of ["claude", "codex"]) {
      const before = h.starts().length;
      const job = await root.call("delegate", { target, task: "x", mode: "read", background: false });
      assert.equal(job.status, "done", `${target}: ${JSON.stringify(job)}`);
      assert.equal(h.starts()[before].env.autoBackground, target === "claude" ? null : "1");
    }
  } finally {
    await h.close();
  }
});

test("claude children: relay's own settings for a launched Claude turn MCP auto-backgrounding off, and inherit, under which a settings file that sets CLAUDE_AUTO_BACKGROUND_TASKS would reach Claude, is refused under the never floor", async () => {
  // A settings file's env applies however claude is launched, so the environment scrub above does
  // not reach it; under child_settings "inherit" Claude would load the user's own, which the never
  // floor now refuses (backends/never-admission.ts). Claude Code's
  // documentation (code.claude.com/docs/en/mcp, "Automatic backgrounding of long tool calls",
  // fetched 2026-10-17): CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS set to 0 turns it off, and the
  // --settings file relay passes outranks user, project and local settings. Not run with a real Claude.
  // Claude's own refusal retry and fallback are off too (A17).
  const off = { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0", CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1", CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1" };
  const isolated = await harness([{ steps: [{ reply: "ok" }] }]);
  const inheriting = await harness([{ steps: [{ reply: "ok" }] }], { child_settings: "inherit", claude_settings_env: "accept" });
  try {
    writeUserSettings(claudeDir(inheriting), { env: { CLAUDE_AUTO_BACKGROUND_TASKS: "1" } });
    for (const mode of ["write", "read"] as const) {
      assert.equal((await isolated.call("delegate", { target: "claude", task: "x", mode, background: false })).status, "done");
      const refused = await inheriting.call("delegate", { target: "claude", task: "x", mode, background: false });
      assert.equal(refused.status, "failed", JSON.stringify(refused));
      assert.match(refused.error, NEVER_INHERIT);
    }
    for (const start of isolated.starts()) assert.deepEqual(settingsOf(start).env, { ...off, TMPDIR: start.env.tmpdir, CLAUDE_CODE_TMPDIR: start.env.tmpdir }, start.access);
    assert.equal(inheriting.starts().length, 0);
  } finally {
    await isolated.close();
    await inheriting.close();
  }
});
