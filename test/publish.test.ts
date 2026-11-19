// Regression tests for what the publication review found: things that hold on the author's
// machine and would not on someone else's.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptRun, alive, harness, release, STUB_TARGETS, task, until, type Harness, type Rec } from "./helpers.ts";

const outside = (name: string) => path.join(fs.realpathSync(os.tmpdir()), `relay-pub-${name}-${process.pid}-${Date.now()}`);

test("publication: relay's own git runs no hook, whatever the repository configures", async () => {
  const marker = outside("hook");
  const h = await harness([{ match: task("HOOKED"), steps: [{ write: "work.txt", content: "w\n" }, { reply: "done" }] }]);
  try {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: h.repo, encoding: "utf8" });
    // Hooks kept in the repository itself, as Husky keeps them: a job can rewrite these files.
    fs.mkdirSync(path.join(h.repo, ".githooks"));
    for (const name of ["post-commit", "prepare-commit-msg", "post-checkout", "post-merge", "pre-commit"]) {
      fs.writeFileSync(path.join(h.repo, ".githooks", name), `#!/bin/sh\necho ${name} >> ${marker}\n`, { mode: 0o755 });
    }
    g("config", "core.hooksPath", ".githooks");
    g("add", "-A");
    g("commit", "-q", "-m", "hooks");
    assert.ok(fs.existsSync(marker), "the hooks do run for an ordinary commit");
    fs.rmSync(marker);

    // Worktree creation, relay's commit of the job's work, and the merge into the caller's tree.
    const job = await h.call("delegate", { target: "codex", task: "HOOKED", mode: "write", background: false });
    assert.equal(job.status, "done");
    assert.deepEqual(job.result.files_changed_git, ["work.txt"]);
    assert.equal((await h.call("merge", { job_id: job.job_id })).status, "merged");
    assert.equal(fs.existsSync(marker), false, `no hook ran${fs.existsSync(marker) ? `, but these did: ${fs.readFileSync(marker, "utf8")}` : ""}`);
  } finally {
    fs.rmSync(marker, { force: true });
    await h.close();
  }
});

test("publication: relay does not run git inside a repository the agent made, and keeps the work", async () => {
  const marker = outside("nested");
  const script = outside("fsmonitor.sh");
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
  // A nested repository whose own config names a program for git to run.
  const nest = `mkdir sub && cd sub && git init -q && git -c user.name=a -c user.email=a@a.a commit -q --allow-empty -m s && echo x > f && git config core.fsmonitor ${script}`;
  const h = await harness([{ match: task("NESTED"), steps: [{ run: nest }, { write: "work.txt", content: "w\n" }, { reply: "done" }] }]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "NESTED", mode: "write", background: false });
    assert.match(job.result.checkpoint_error, /nested git repository \(sub\)/);
    const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree;
    // The work is neither committed half-way nor thrown away.
    assert.ok(fs.existsSync(path.join(wt, "work.txt")));
    const cleaned = JSON.parse(h.cli("clean"));
    assert.equal(cleaned.worktrees_removed, 0);
    assert.ok(fs.existsSync(path.join(wt, "sub", "f")));
    assert.equal(fs.existsSync(marker), false, "the nested repository's program never ran");
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(script, { force: true });
    await h.close();
  }
});

test("publication: a repository with a content filter relay cannot vouch for is refused for write jobs, unless trusted", async () => {
  const h = await harness([{ steps: [{ write: "a.txt", content: "a\n" }, { reply: "done" }] }]);
  const trusting = await harness([{ steps: [{ write: "a.txt", content: "a\n" }, { reply: "done" }] }], { trust_git_filters: true });
  try {
    for (const x of [h, trusting]) {
      // Git LFS's own filter is fine; a filter that runs an interpreter is not.
      execFileSync("git", ["config", "filter.lfs.clean", "git-lfs clean -- %f"], { cwd: x.repo });
      execFileSync("git", ["config", "filter.strip.clean", "python3 strip.py"], { cwd: x.repo });
    }
    const no = await h.call("delegate", { target: "codex", task: "x", mode: "write", background: false });
    assert.match(no.reason ?? no.error, /content filter \(filter\.strip\.clean = "python3 strip\.py"\)/);
    assert.doesNotMatch(no.reason ?? no.error, /lfs/);
    assert.equal(h.starts().length, 0);
    // Read-only work never has relay staging files, so it is unaffected.
    assert.equal((await h.call("delegate", { target: "codex", task: "x", mode: "read", background: false })).status, "done");
    assert.equal((await trusting.call("delegate", { target: "codex", task: "x", mode: "write", background: false })).status, "done");
  } finally {
    await h.close();
    await trusting.close();
  }
});

test("publication: new files are committed even where git is configured not to show untracked files", async () => {
  const h = await harness([{ match: task("NEWFILE"), steps: [{ write: "brand-new.txt", content: "n\n" }, { reply: "done" }] }]);
  try {
    execFileSync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: h.repo });
    const job = await h.call("delegate", { target: "codex", task: "NEWFILE", mode: "write", background: false });
    assert.equal(job.result.no_changes, undefined, "a job that only added a file did not change nothing");
    assert.deepEqual(job.result.files_changed_git, ["brand-new.txt"]);
    assert.equal(execFileSync("git", ["show", `${job.result.branch}:brand-new.txt`], { cwd: h.repo, encoding: "utf8" }), "n\n");
  } finally {
    await h.close();
  }
});

test("publication: processes are still identified and stopped under a locale that prints dates differently", async () => {
  const h = await harness();
  const before = { home: process.env.RELAY_HOME, lc: process.env.LC_ALL };
  process.env.RELAY_HOME = h.home;
  process.env.LC_ALL = "ko_KR.UTF-8";
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const { procStart, procTree, killProcs } = await import("../dist/core/procs.js");
    const { relayProcs } = await import("../dist/core/db.js");
    assert.equal(procStart(child.pid)!.trim().split(/\s+/).length, 5, "the start time is read as five fields");
    const found = procTree(process.pid, relayProcs).procs.filter((p: { pid: number }) => p.pid === child.pid);
    assert.equal(found.length, 1, "the child is found among this process's descendants");
    killProcs(found);
    await until(() => !alive(child.pid!), 20000, "the child to be killed");
  } finally {
    child.kill("SIGKILL");
    if (before.home === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = before.home;
    if (before.lc === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = before.lc;
    await h.close();
  }
});

test("publication: a config with a wrong type or an unknown setting stops relay; it is not read loosely", async () => {
  const { validateConfig } = await import("../dist/core/config.js");
  assert.throws(() => validateConfig({ allow_dangerous: "false" }, "x"), /allow_dangerous/);
  assert.throws(() => validateConfig({ child_mcp: "everything" }, "x"), /child_mcp/);
  assert.throws(() => validateConfig({ alow_dangerous: false }, "x"), /alow_dangerous/);
  assert.deepEqual(validateConfig({ max_depth: 2, default_model: { codex: "m" } }, "x"), { max_depth: 2, default_model: { codex: "m" } });
  // A quoted "false" is a string, and a non-empty string used to count as true: full access.
  const h = await harness([{ steps: [{ reply: "ran" }] }], { allow_dangerous: "false" });
  try {
    const r = await h.call("delegate", { target: "codex", task: "x", mode: "write", background: false });
    assert.match(JSON.stringify(r), /not valid, so relay will not start/);
    assert.equal(h.starts().length, 0);
  } finally {
    await h.close();
  }
});

test("config: targets.<id> and default_target, with the earlier per-target keys still valid and moved into them", async () => {
  const { validateConfig, withDefaults } = await import("../dist/core/config.js");
  // The shape of the live config relay is used with today: earlier keys only.
  const live = { default_model: { claude: "opus", codex: "gpt-6.1-sol" }, default_effort: { claude: "high", codex: "high" } };
  assert.deepEqual(validateConfig(live, "x"), live);
  const cfg = withDefaults(validateConfig(live, "x"));
  assert.deepEqual(cfg.targets, {
    claude: { enabled: true, bin: "claude", default_model: "opus", default_effort: "high" },
    codex: { enabled: true, bin: "codex", home: "~/.local/share/relay-codex-home", pin_store: "~/.local/share/relay-codex-pins", pinned: true, default_model: "gpt-6.1-sol", default_effort: "high" },
    // A target added after claude and codex is in every config, switched off.
    copilot: { enabled: false, bin: "copilot" },
    gemini: { enabled: false, bin: "gemini" },
    grok: { enabled: false, bin: "grok" },
  });
  assert.deepEqual(cfg.default_target, {});
  for (const k of ["bin", "default_model", "default_effort"]) assert.equal(k in cfg, false, `${k} is moved into targets`);
  // Desktop notifications are off unless switched on; the earlier name still works, and setting both is an error.
  assert.equal(cfg.desktop_notifications, false);
  assert.equal("notify" in cfg, false);
  assert.equal(withDefaults(validateConfig({ notify: true }, "x")).desktop_notifications, true);
  assert.equal(withDefaults(validateConfig({ desktop_notifications: true }, "x")).desktop_notifications, true);
  assert.throws(() => validateConfig({ notify: true, desktop_notifications: false }, "x"), /notify: set both here and as desktop_notifications/);
  // A run's stored config from before targets existed is read the same way.
  const old = withDefaults({ max_depth: 3, bin: { claude: "/opt/claude", codex: "codex" }, default_model: {}, default_effort: { codex: "low" } });
  assert.equal(old.targets.claude.bin, "/opt/claude");
  assert.equal(old.targets.codex.default_effort, "low");
  // And a stored config in the new form comes back as it was.
  assert.deepEqual(withDefaults(JSON.parse(JSON.stringify(cfg))), cfg);

  const both = { targets: { codex: { enabled: false, bin: "/opt/codex", default_model: "m" } }, default_target: { claude: "codex" } };
  assert.deepEqual(validateConfig(both, "x"), both);
  assert.equal(withDefaults(both).targets.codex.enabled, false);
  // The same thing set both ways is an error, not a merge.
  assert.throws(() => validateConfig({ bin: { claude: "a" }, targets: { claude: { bin: "b" } } }, "x"), /bin\.claude: set both here and as targets\.claude\.bin/);
  assert.throws(() => validateConfig({ default_model: { codex: "a" }, targets: { codex: { default_model: "b" } } }, "x"), /default_model\.codex/);
  assert.throws(() => withDefaults({ default_effort: { codex: "a" }, targets: { codex: { default_effort: "b" } } }), /keep one/);
  assert.deepEqual(validateConfig({ bin: { claude: "a" }, targets: { codex: { bin: "b" } } }, "x").bin, { claude: "a" }, "different targets do not conflict");
  // Unknown targets and fields, and a default of the caller's own family, are refused.
  assert.throws(() => validateConfig({ targets: { nonesuch: { enabled: true } } }, "x"), /targets/);
  assert.throws(() => validateConfig({ targets: { codex: { enable: true } } }, "x"), /enable/);
  assert.throws(() => validateConfig({ default_target: { claude: "claude" } }, "x"), /default_target\.claude: claude is the same family as claude/);
  assert.throws(() => validateConfig({ default_target: { claude: "cursor" } }, "x"), /default_target/);
});

test("config: no time limit on jobs or turns unless one is set; block_s stays a wait, not a cancel", async () => {
  const { validateConfig, withDefaults, DEFAULT_CONFIG } = await import("../dist/core/config.js");
  assert.equal(DEFAULT_CONFIG.job_timeout_s, null);
  assert.equal(DEFAULT_CONFIG.turn_timeout_s, null);
  assert.equal(withDefaults({}).job_timeout_s, null);
  assert.deepEqual(validateConfig({ job_timeout_s: 60, turn_timeout_s: null }, "x"), { job_timeout_s: 60, turn_timeout_s: null });
  assert.throws(() => validateConfig({ job_timeout_s: 0 }, "x"), /job_timeout_s/);
  assert.throws(() => validateConfig({ block_s: null }, "x"), /block_s/);
  // A run started under the earlier defaults keeps the limits it was started with.
  assert.equal(withDefaults({ job_timeout_s: 1800, turn_timeout_s: 600 }).job_timeout_s, 1800);

  // A turn longer than block_s: the call returns a pending handle, and the work carries on to the end.
  // Held until the call has returned its handle, so the turn certainly outlasts block_s.
  const h = await harness([{ match: task("LONGER"), steps: [{ await: "longer-may-finish" }, { reply: "finished" }] }], { block_s: 1 });
  try {
    const r = await h.call("delegate", { target: "claude", task: "LONGER", mode: "read", background: false });
    assert.equal(r.pending, true);
    // Each status call waits at most block_s too; the job is not stopped by any of them.
    const mid = await h.call("status", { id: r.job_id, wait_s: 1 });
    assert.ok(["queued", "running"].includes(mid.status), JSON.stringify(mid));
    release(h, "longer-may-finish");
    await until(async () => (await h.call("status", { id: r.job_id, wait_s: 1 })).status === "done", 20000, "the job to finish");
    assert.equal(h.ends()[0].reply, "finished");
  } finally {
    await h.close();
  }
});

test("config: the live config's defaults reach the agents, and a target switched off is not launched", async () => {
  const h = await harness([], { default_model: { claude: "opus", codex: "gpt-6.1-sol" }, default_effort: { claude: "high", codex: "high" } });
  const off = await harness([], { targets: { codex: { enabled: false } } });
  try {
    await h.call("ask", { target: "claude", message: "a" });
    await h.call("ask", { target: "codex", message: "b" });
    const [a, b] = h.starts();
    assert.match(a.argv.join(" "), /--model opus --effort high/);
    assert.deepEqual([b.model, b.effort], ["gpt-6.1-sol", "high"]);

    // A target switched off can still be named (to continue what it has started), and starting something new with it is refused with the reason.
    const offered = await off.call("ask", { target: "codex", message: "x" });
    assert.match(offered.reason, /switched off/);
    const claude = await off.instance({ args: ["--host", "claude"] });
    assert.match((await claude.call("ask", { message: "x" })).reason, /no agent of another family is switched on/);
    assert.equal(off.starts().length, 0);
  } finally {
    await h.close();
    await off.close();
  }
});

test("credentials: each target loses every vendor's keys, unless it alone is set to sign in with any", async () => {
  const { scrubbedCredentials } = await import("../dist/backends/env.js");
  const { withDefaults } = await import("../dist/core/config.js");
  const keys = (re: RegExp | null) => ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "GH_TOKEN"].filter((k) => re?.test(k));
  const all = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"];
  // Login scrubs every vendor; the global "any" now keeps the same foreign-vendor guards
  // as per-target "any". Selection by child_env is a separate requirement.
  for (const t of ["claude", "codex"]) {
    assert.deepEqual(keys(scrubbedCredentials(t, withDefaults({}))), all);
    assert.deepEqual(keys(scrubbedCredentials(t, withDefaults({ child_auth: "any" }))), t === "claude"
      ? ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"] : ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  }
  // One target's own "any": its own key passes, the other vendor's still does not, and the others are unaffected.
  const one = withDefaults({ targets: { codex: { child_auth: "any" } } });
  assert.deepEqual(keys(scrubbedCredentials("codex", one)), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.deepEqual(keys(scrubbedCredentials("claude", one)), all);
  // A target set to login under the global "any" is scrubbed.
  assert.deepEqual(keys(scrubbedCredentials("claude", withDefaults({ child_auth: "any", targets: { claude: { child_auth: "login" } } }))), all);
});

test("publication: a Claude job loads only relay's settings and refuses to run unsandboxed", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  const inheriting = await harness([{ steps: [{ reply: "ok" }] }], { child_settings: "inherit", claude_settings_env: "accept" });
  try {
    await h.call("delegate", { target: "claude", task: "x", mode: "write", background: false });
    const argv: string[] = h.starts()[0].argv;
    assert.equal(argv[argv.indexOf("--setting-sources") + 1], "", "no user, project or local settings file is loaded");
    const settings = JSON.parse(fs.readFileSync(argv[argv.indexOf("--settings") + 1], "utf8"));
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false, "under the never floor no command retries outside the sandbox");
    const tools = argv[argv.indexOf("--tools") + 1].split(",");
    assert.ok(tools.includes("Edit") && tools.includes("Task"));
    for (const beyond of ["SendMessage", "CronCreate", "RemoteTrigger", "PushNotification"]) assert.ok(!tools.includes(beyond), `${beyond} is not offered to a job`);

    await h.call("delegate", { target: "claude", task: "x", mode: "read", background: false });
    const read: string[] = h.starts()[1].argv;
    assert.equal(read[read.indexOf("--setting-sources") + 1], "");
    const readSandbox = JSON.parse(fs.readFileSync(read[read.indexOf("--settings") + 1], "utf8")).sandbox;
    assert.equal(readSandbox.failIfUnavailable, true);
    assert.equal(readSandbox.allowUnsandboxedCommands, false);

    // Loading the person's own settings could bypass the never floor, so such a Claude is not launched at all.
    const refused = await inheriting.call("delegate", { target: "claude", task: "x", mode: "write", background: false });
    assert.equal(refused.status, "failed", JSON.stringify(refused));
    assert.match(refused.error, /^never: inherited Claude settings, hooks or MCP tools can bypass the checked sandbox\/tool route/);
    assert.equal(inheriting.starts().length, 0);
  } finally {
    await h.close();
    await inheriting.close();
  }
});

test("publication: a Claude that reports more than relay gave it is stopped before it does anything", async () => {
  // The agent's first step waits for the test's go-ahead, given only to the agents that should run:
  // one relay failed to stop would wait in vain and fail with the wrong error, never race the check.
  const h = await harness([{ steps: [{ awaitMark: "proceed" }, { write: "done-anyway.txt", content: "x\n" }, { reply: "ok" }] }]);
  try {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ tools: ["Bash", "SendMessage"] }, /tools relay did not give it \(SendMessage\)/],
      [{ mcp_servers: [{ name: "relay" }, { name: "gmail" }] }, /MCP servers relay did not give it \(gmail\)/],
      [{ permissionMode: "bypassPermissions" }, /permission mode "bypassPermissions", not the acceptEdits relay asked for/],
      [{ permissionMode: "auto" }, /permission mode "auto"/],
      [{ apiKeySource: "ANTHROPIC_API_KEY" }, /signing in with an API key/],
      // What Claude leaves out is not taken on trust either.
      [{ apiKeySource: null }, /did not report how it is signed in/],
      [{ tools: null }, /did not report its tools/],
      [{ mcp_servers: null }, /did not report its MCP servers/],
      [{ permissionMode: null }, /permission mode null/],
      // Which family answers is part of the report: a Claude model, and said.
      [{ model: "gpt-6.1-sol" }, /reported the model "gpt-6.1-sol", which is not a Claude model/],
      [{ model: null }, /did not report its model/],
    ];
    for (const [init, expected] of cases) {
      const root = await h.instance({ env: { STUB_INIT: JSON.stringify(init) } });
      const job = await root.call("delegate", { target: "claude", task: "STOPPED", mode: "write", background: false });
      assert.equal(job.status, "failed");
      assert.match(job.error, expected);
      const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree;
      assert.equal(fs.existsSync(path.join(wt, "done-anyway.txt")), false, "it was stopped before its first step");
      assert.doesNotMatch(job.error, /gone before relay could take a last look/, "relay stopped it; it was not lost");
    }
    // A full-access write turn (allow_dangerous), where the model check would be all there is, is
    // refused under the never floor before any Claude starts; a read turn's model is still checked.
    const anyAccess = await harness([{ steps: [{ reply: "ok" }] }], { allow_dangerous: true });
    try {
      const root = await anyAccess.instance({ env: { STUB_INIT: JSON.stringify({ model: "qwen3-coder" }) } });
      const job = await root.call("delegate", { target: "claude", task: "x", mode: "write", background: false });
      assert.match(job.error, /^never: Claude's unsandboxed full-access variant bypasses the floor/);
      assert.equal(anyAccess.starts().length, 0);
      assert.match((await root.call("delegate", { target: "claude", task: "x", mode: "read", background: false })).error, /not a Claude model/);
    } finally {
      await anyAccess.close();
    }
    h.mark("proceed");
    for (const model of ["claude-opus-5-5", "us.anthropic.claude-sonnet-5-v1:0", "claude-opus-4@20250514", "claude-sonnet-4-5[1m]"]) {
      const ok = await (await h.instance({ env: { STUB_INIT: JSON.stringify({ model }) } })).call("delegate", { target: "claude", task: "x", mode: "write", background: false });
      assert.equal(ok.status, "done", model);
    }
    // Relay's own tools may appear among the tools Claude reports.
    const fine = await (await h.instance({ env: { STUB_INIT: JSON.stringify({ tools: ["Read", "mcp__relay__status"] }) } })).call("delegate", { target: "claude", task: "x", mode: "write", background: false });
    assert.equal(fine.status, "done");
  } finally {
    await h.close();
  }
});

test("identity: neither agent is launched pointed at another endpoint, and Codex must report OpenAI's models", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    for (const [target, env, expected] of [
      ["claude", { ANTHROPIC_BASE_URL: "https://proxy.example" }, /sets ANTHROPIC_BASE_URL, which sends Claude Code to another endpoint/],
      ["claude", { ANTHROPIC_BEDROCK_BASE_URL: "https://proxy.example" }, /sets ANTHROPIC_BEDROCK_BASE_URL/],
      ["codex", { OPENAI_BASE_URL: "https://openrouter.example" }, /sets OPENAI_BASE_URL, which sends codex-cli to another endpoint/],
      ["codex", { STUB_CODEX_EFFECTIVE: JSON.stringify({ model_provider: "openrouter" }) }, /model_provider is "openrouter", not OpenAI's/],
      ["codex", { STUB_CODEX_THREAD: JSON.stringify({ modelProvider: "anthropic" }) }, /thread reports the model provider "anthropic"/],
    ] as const) {
      const root = await h.instance({ env: env as Record<string, string> });
      const job = await root.call("delegate", { target, task: "x", mode: "read", background: false });
      assert.equal(job.status, "failed", JSON.stringify(env));
      assert.match(job.error, expected);
    }
    // The model asked for is the one the thread must report.
    const swapped = await (await h.instance({ env: { STUB_CODEX_THREAD: JSON.stringify({ model: "gpt-mini" }) } })).call("ask", { target: "codex", message: "x", model: "gpt-6.1-sol" });
    assert.match(swapped.error, /reports the model "gpt-mini", not the "gpt-6.1-sol" relay asked for/);
    assert.equal(h.ends().length, 0, "no agent got as far as a turn");
    // An explicit OpenAI provider is fine, as is a model when none was asked for.
    const fine = await (await h.instance({ env: { STUB_CODEX_EFFECTIVE: JSON.stringify({ model_provider: "openai" }), STUB_CODEX_THREAD: JSON.stringify({ model: "gpt-anything" }) } })).call("ask", { target: "codex", message: "x" });
    assert.equal(fine.reply, "ok");
  } finally {
    await h.close();
  }
  // The exec fallback checks the provider through its preflight.
  const ex = await harness([{ steps: [{ reply: "ok" }] }], { codex_backend: "exec" });
  try {
    const job = await (await ex.instance({ env: { STUB_CODEX_EFFECTIVE: JSON.stringify({ model_provider: "ollama" }) } })).call("delegate", { target: "codex", task: "x", mode: "read", background: false });
    assert.match(job.error, /model_provider is "ollama"/);
  } finally {
    await ex.close();
  }
});

test("publication: relay does not run on API keys unless told to, and hands neither agent the other's keys", async () => {
  const keys = { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test" };
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  const any = await harness([{ steps: [{ reply: "ok" }] }], {
    child_auth: "any", child_env: { pass: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] },
  });
  try {
    const root = await h.instance({ env: keys });
    for (const target of STUB_TARGETS) assert.equal((await root.call("delegate", { target, task: "x", mode: "read", background: false })).status, "done");
    for (const s of h.starts()) assert.deepEqual([s.env.anthropicKey, s.env.openaiKey], [false, false], `${s.target} was handed no key`);

    // Codex signed in with a stored API key: nothing in the environment, but not an account login either.
    const keyed = await h.instance({ env: { STUB_ACCOUNT: "apiKey" } });
    const refused = await keyed.call("delegate", { target: "codex", task: "x", mode: "read", background: false });
    assert.equal(refused.status, "failed");
    assert.match(refused.error, /signed in with an API key, not with a ChatGPT account/);

    // No account at all: relay's Codex home holds no login, and the refusal says how to sign it in.
    const codexHome = path.join(h.env.HOME, ".local", "share", "relay-codex-home");
    const signedOut = await h.instance({ env: { STUB_ACCOUNT: "none" } });
    const never = await signedOut.call("delegate", { target: "codex", task: "x", mode: "read", background: false });
    assert.equal(never.status, "failed");
    assert.match(never.error, /Codex is not signed in, not with a ChatGPT account, and relay is set not to run on API keys \("child_auth": "any" allows it\)\. Sign in once with CODEX_HOME=".*relay-codex-home" ".*" login \(on a remote or headless Mac, add --device-auth, which needs device code sign-in switched on in ChatGPT's Security settings\)/);
    // A login stored there that Codex no longer accepts (a private PR: a revoked refresh token): said as such, with how to sign in again.
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    const dead = await signedOut.call("delegate", { target: "codex", task: "x", mode: "read", background: false });
    assert.equal(dead.status, "failed");
    assert.match(dead.error, /Codex is not signed in: relay's Codex home .*relay-codex-home holds a login, but Codex no longer accepts it, most likely because it expired and Codex could not refresh it \(its refresh token revoked, for one\)\. Sign in again with CODEX_HOME=".*relay-codex-home" ".*" login \(on a remote or headless Mac, add --device-auth/);
    fs.rmSync(path.join(codexHome, "auth.json"));

    const anyRoot = await any.instance({ env: { ...keys, STUB_ACCOUNT: "apiKey", STUB_INIT: JSON.stringify({ apiKeySource: "ANTHROPIC_API_KEY" }) } });
    for (const target of STUB_TARGETS) assert.equal((await anyRoot.call("delegate", { target, task: "x", mode: "read", background: false })).status, "done");
    for (const s of any.starts()) assert.deepEqual([s.env.anthropicKey, s.env.openaiKey], [s.target === "claude", s.target === "codex"], `${s.target} receives only its own selected key`);
  } finally {
    await h.close();
    await any.close();
  }
});

test("publication: an untested CLI version or platform is refused unless allowed", async () => {
  const { untested } = await import("../dist/backends/run.js");
  const { TESTED } = await import("../dist/targets/index.js");
  const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  const allowing = await harness([{ steps: [{ reply: "ok" }] }], { allow_untested: true });
  try {
    const old = { STUB_VERSION: "2.1.100 (stub Claude Code)" };
    const job = await (await h.instance({ env: old })).call("delegate", { target: "claude", task: "x", mode: "read", background: false });
    assert.equal(job.status, "failed");
    assert.match(job.error, new RegExp(`is 2\\.1\\.100, older than the ${TESTED.claude.join("\\.")}`));
    assert.equal(h.starts().length, 0);
    assert.equal((await (await allowing.instance({ env: old })).call("delegate", { target: "claude", task: "x", mode: "read", background: false })).status, "done");

    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      assert.match(untested("codex", DEFAULT_CONFIG), /only been verified on macOS, and this is linux/);
      assert.equal(untested("codex", { ...DEFAULT_CONFIG, allow_untested: true }), null);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  } finally {
    await h.close();
    await allowing.close();
  }
});

test("publication: a nested job's worktree lands where the root's does, and relay's own directories are never approvable", async () => {
  const elsewhere = outside("worktrees");
  const h = await harness([
    { match: task("OUTER"), steps: [
      { call: "delegate", args: { target: "codex", task: "INNER", mode: "write", background: false } },
      { request: { edit: "$RELAY_HOME/relay.db" } },
      { reply: "{{last}}" },
    ] },
    { match: task("INNER"), steps: [{ write: "inner.txt", content: "i\n" }, { reply: "inner done" }] },
  ]);
  try {
    const root = await h.instance({ env: { RELAY_WORKTREES: elsewhere } });
    const outer = await root.call("delegate", { target: "claude", task: "OUTER", mode: "write", background: false });
    assert.equal(outer.status, "blocked", "the agent was refused the edit");
    const [a, b] = h.starts();
    assert.ok(a.cwd.startsWith(elsewhere) && b.cwd.startsWith(elsewhere), `both worktrees are under the root's directory: ${a.cwd}, ${b.cwd}`);
    assert.equal(b.env.worktrees, elsewhere);
    // The edit was refused on the spot: nobody was asked, so nobody could say yes.
    assert.match(outer.result.final_message, /inside relay's own directories/);
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM requests")[0].n, 0);
    assert.equal(fs.statSync(h.home).mode & 0o077, 0, "the control directory is private to the user");
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
    await h.close();
  }
});

test("publication: a filter that only starts like Git LFS's is not Git LFS's", async () => {
  const { filterRefusal } = await import("../dist/core/git.js");
  const refusal = (cmd: string) => `this repository runs a content filter (${cmd}) that relay would have to run outside the sandbox on files an agent wrote. Set "trust_git_filters": true in relay's config if that command cannot be redirected by files in the repository`;
  const h = await harness();
  try {
    const set = (k: string, v: string) => execFileSync("git", ["config", k, v], { cwd: h.repo });
    set("filter.lfs.clean", "git-lfs clean -- %f");
    set("filter.lfs.smudge", "git-lfs smudge --skip -- %f");
    set("filter.lfs.process", "git-lfs filter-process");
    assert.equal(filterRefusal(h.repo, false), null, "Git LFS as `git lfs install` writes it");
    set("filter.sneaky.clean", "git-lfs clean -- %f ; sh ./helper.sh");
    assert.equal(filterRefusal(h.repo, false), refusal('filter.sneaky.clean = "git-lfs clean -- %f ; sh ./helper.sh"'));
    // A command over two lines is one command, not an LFS line and a line of something else.
    execFileSync("git", ["config", "--unset", "filter.sneaky.clean"], { cwd: h.repo });
    set("filter.split.clean", "git-lfs clean -- %f\n./helper.sh");
    assert.equal(filterRefusal(h.repo, false), refusal('filter.split.clean = "git-lfs clean -- %f\\n./helper.sh"'));
  } finally {
    await h.close();
  }
});

test("publication: a nested repository with a space in its name is found too", async () => {
  const nest = "mkdir 'sub dir' && cd 'sub dir' && git init -q && git -c user.name=a -c user.email=a@a.a commit -q --allow-empty -m s && echo x > f";
  const h = await harness([{ match: task("SPACED"), steps: [{ run: nest }, { write: "work.txt", content: "w\n" }, { reply: "done" }] }]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "SPACED", mode: "write", background: false });
    assert.match(job.result.checkpoint_error, /nested git repository \(sub dir\)/);
  } finally {
    await h.close();
  }
});

test("publication: two calls at once cannot both send a message, or both open a review's reconciliation", async () => {
  const items = "```json\n" + JSON.stringify({ items: [{ n: 1, severity: "minor", location: "a", summary: "s" }] }) + "\n```";
  const h = await harness([
    { match: "independent code reviewer", steps: [{ reply: items }] },
    // The discussion's second turn is held until the test has seen the other call turned away.
    { match: "two|three", turn: 2, steps: [{ awaitMark: "reply" }, { reply: "go on\nCONTINUE" }] },
    { steps: [{ reply: "go on\nCONTINUE" }] },
  ]);
  try {
    const d = await h.call("discuss", { target: "codex", topic: "t", message: "one\nCONTINUE" });
    const calls = [
      h.call("discuss", { discussion_id: d.discussion_id, message: "two\nCONTINUE" }),
      h.call("discuss", { discussion_id: d.discussion_id, message: "three\nCONTINUE" }),
    ];
    let answered = 0;
    for (const c of calls) void c.then(() => answered++, () => answered++);
    await until(() => answered === 1 && h.starts().length === 2, 60000, "one message sent and the other turned away");
    h.mark("reply");
    const both = await Promise.all(calls);
    assert.equal(both.filter((r) => r.reply).length, 1, "one was sent");
    assert.match(both.find((r) => !r.reply)!.not_sent, /still writing its reply/, "the other was told why not");
    assert.equal(h.starts().length, 2);

    const r = await h.call("review", { reviewer: "codex", target: "x" });
    await h.call("status", { id: r.reviewer_job, wait_s: 20 });
    await Promise.all([
      h.call("review", { review_id: r.review_id, own_review: items }),
      h.call("review", { review_id: r.review_id, own_review: items }),
    ]);
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'discussion' AND parent_id = ?", r.review_id)[0].n, 1);
  } finally {
    await h.close();
  }
});

test("publication: a session borrowed for a discussion is checked again on every message, and stopped only by those who could stop it", async () => {
  const h = await harness([
    { match: task("PARTICIPANT"), steps: [{ reply: "ready" }] },
    // Still writing its reply until the test is done with it.
    { match: "SLOW", steps: [{ awaitMark: "slow" }, { reply: "slow answer\nCONTINUE" }] },
    { steps: [{ reply: "noted\nCONTINUE" }] },
  ], { block_s: 1 });
  try {
    // block_s is one second, for the reply still being written below. Anything else may take longer
    // than that on a loaded machine, so each of those calls is followed to its end.
    type Caller = { call: Harness["call"] };
    const settled = async (via: Caller, first: Rec) => {
      let r = first;
      while (r.pending || r.status === "running") r = await via.call("status", { id: first.id, wait_s: 1 });
      return { ...first, ...r, pending: undefined };
    };
    // A reply can arrive while the turn that wrote it is still closing; a session is used again only
    // once that turn and its worker are gone, or what follows would queue behind it.
    const finished = (id: string) => until(() => h.sql("SELECT status, worker_pid FROM nodes WHERE id = ?", id).some((n) => n.status === "done" && !(n.worker_pid > 0 && alive(n.worker_pid))), 60000, `${id} to finish`);
    const a = await h.call("delegate", { target: "claude", task: "PARENT", mode: "read", background: false });
    const child = await h.instance(await h.childOf(a.job_id, { access: "read" }));
    const b = await settled(child, await child.call("delegate", { target: "codex", task: "PARTICIPANT", mode: "read", background: false }));
    await finished(b.job_id);
    const d = await settled(child, await child.call("discuss", { topic: "t", message: "FIRST\nCONTINUE", with: b.job_id }));
    assert.equal(d.status, "open", JSON.stringify(d));
    await finished(b.job_id);
    // The root gives the participant more than the agent that borrowed it has.
    await settled(h, await h.call("resume", { job_id: b.job_id, message: "an update", grant: { network: true } }));
    await finished(b.job_id);
    const next = await child.call("discuss", { discussion_id: d.discussion_id, message: "MORE\nCONTINUE" });
    assert.match(next.reason, /more access than your current turn/);

    // A discussion whose reply is still being written, closed by an agent that may not stop the session writing it.
    const e = await settled(child, await child.call("delegate", { target: "codex", task: "PARTICIPANT", mode: "read", background: false }));
    await finished(e.job_id);
    const slow = await child.call("discuss", { topic: "t2", message: "SLOW\nCONTINUE", with: e.job_id });
    assert.equal(slow.pending, true);
    await h.call("resume", { job_id: e.job_id, message: "an update", grant: { network: true } });
    const cancelled = await child.call("cancel", { id: slow.discussion_id });
    assert.deepEqual(cancelled.cancelled, [slow.discussion_id], "the discussion is closed");
    assert.notEqual(h.sql("SELECT status FROM nodes WHERE id = ?", e.job_id)[0].status, "cancelled", "the session it borrowed is not stopped");
    h.mark("slow");
  } finally {
    await h.close();
  }
});

test("publication: a discussion turn on a write job's session is read-only, approvals included", async () => {
  const h = await harness([
    { match: task("BUILD"), steps: [{ write: "a.txt", content: "a\n" }, { reply: "built" }] },
    { match: "EDIT ELSEWHERE", steps: [{ request: { edit: "/tmp/relay-should-not-be-asked.txt" } }, { reply: "{{last}}\nCONTINUE" }] },
  ]);
  try {
    const w = await h.call("delegate", { target: "claude", task: "BUILD", mode: "write", background: false });
    const d = await h.call("discuss", { target: "claude", topic: "t", message: "EDIT ELSEWHERE\nCONTINUE", with: w.job_id });
    assert.match(d.reply, /read-only/);
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM requests")[0].n, 0, "nothing was put to anyone");
  } finally {
    await h.close();
  }
});

test("publication: git state relay cannot read counts against, not for", async () => {
  const { filterRefusal, untrustedNestedRepos } = await import("../dist/core/git.js");
  const gone = path.join(os.tmpdir(), `relay-no-such-dir-${process.pid}`);
  assert.match(filterRefusal(gone, false)!, /^relay could not read this repository's filter and driver settings \(/);
  assert.equal(untrustedNestedRepos(gone), null);
});

test("publication: a review whose session went away while opening the reconciliation can be picked up again", async () => {
  const items = "```json\n" + JSON.stringify({ items: [{ n: 1, severity: "minor", location: "a", summary: "s" }] }) + "\n```";
  const h = await harness([
    { match: "independent code reviewer", steps: [{ reply: items }] },
    // The reconciliation's first turn is held until a new session has picked the review up.
    { steps: [{ awaitMark: "thoughts" }, { reply: "first thoughts\nCONTINUE" }] },
  ]);
  try {
    const first = await h.instance({ args: ["--host", "claude"] });
    const r = await first.call("review", { target: "x" });
    await first.call("status", { id: r.reviewer_job, wait_s: 20 });
    const handing = first.call("review", { review_id: r.review_id, own_review: items }).catch(() => null);
    await until(() => h.starts().length === 2, 10000, "the reconciliation's first turn");
    await first.close();
    await handing;
    // A new session names the review and finds the reconciliation that was opened.
    const second = await h.instance({ args: ["--host", "claude"] });
    await adoptRun(h, second, r.review_id);
    const again = await second.call("review", { review_id: r.review_id });
    assert.match(again.discussion_id, /^d_/);
    h.mark("thoughts");
    const d = await second.call("status", { id: again.discussion_id, wait_s: 20 });
    assert.equal(d.reply, "first thoughts\nCONTINUE");
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'discussion'")[0].n, 1);
  } finally {
    await h.close();
  }
});

