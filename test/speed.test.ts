import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { harness, task, until, type Rec } from "./helpers.ts";

// Speed modes (the maintainer, 2026-10-16): a `speed` on delegate, ask, discuss and review, and
// targets.<id>.speed. Standard unless asked, pinned on every turn; Claude's fast is fastMode in its
// settings (Opus 5.5, 5 and 4.8 only); Codex's speeds are its catalog's service tiers (priority,
// ultrafast), refused before the turn when the account's catalog does not offer them; only the root
// session raises speed, and launched agents' work runs at their own job's.

/** A catalog (model/list) whose one model offers both of Codex's faster tiers. */
const BOTH_TIERS = JSON.stringify([{
  id: "gpt-stub", model: "gpt-stub", displayName: "GPT-Stub", hidden: false, isDefault: true, defaultServiceTier: null,
  serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed" }, { id: "ultrafast", name: "Ultrafast", description: "8x speed" }],
}]);
const starts = (h: { starts(): Rec[] }, target: string) => h.starts().filter((s) => s.target === target);
/** The service tier a Codex app-server turn ran with: as its thread was started or resumed, and as the turn was. */
const tiers = (s: Rec) => [s.thread?.serviceTier ?? null, s.serviceTier ?? null];

test("speed: the config takes targets.<id>.speed, standard, fast or ultrafast, and nothing else", async () => {
  const { validateConfig, withDefaults } = await import("../dist/core/config.js");
  for (const speed of ["standard", "fast", "ultrafast"]) {
    const cfg = withDefaults(validateConfig({ targets: { codex: { speed } } }, "test"));
    assert.equal(cfg.targets.codex.speed, speed);
  }
  assert.equal(withDefaults({}).targets.claude.speed, undefined, "unset means standard");
  assert.throws(() => validateConfig({ targets: { codex: { speed: "turbo" } } }, "test"), /targets\.codex\.speed/);
});

test("speed: standard is pinned on every turn, Codex's service tier \"default\" and Claude's fast mode off", async () => {
  const h = await harness();
  try {
    await h.call("ask", { target: "codex", message: "a" });
    await h.call("ask", { target: "claude", message: "b" });
    const [cx] = starts(h, "codex");
    // A catalog may give a model a faster default tier (gpt-6-sol's is priority), so standard is said, not left out.
    assert.deepEqual(tiers(cx), ["default", "default"]);
    assert.ok(cx.argv.includes('service_tier="default"'), cx.argv.join(" "));
    const [cl] = starts(h, "claude");
    assert.equal(cl.settings.fastMode, false, "fast mode off in relay's own settings, whatever settings of the person's load");
    assert.equal(h.log().filter((e) => e.event === "model-list").length, 0, "standard needs no catalog");
  } finally {
    await h.close();
  }
  // So a standard turn runs where the catalog cannot be read at all.
  const unlisted = await harness([], {}, { STUB_CODEX_MODEL_LIST_ERROR: "model/list is not available" });
  try {
    assert.ok((await unlisted.call("ask", { target: "codex", message: "s" })).reply);
    assert.deepEqual(tiers(starts(unlisted, "codex")[0]), ["default", "default"]);
  } finally {
    await unlisted.close();
  }
});

test("speed: Claude's fast is fastMode in its settings, for Opus 5.5, 5 and 4.8 only; another model or speed is refused before launching", async () => {
  const h = await harness();
  try {
    for (const model of ["opus", "opus[1m]", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) {
      const r = await h.call("ask", { target: "claude", message: `fast ${model}`, model, speed: "fast" });
      assert.ok(r.reply, JSON.stringify(r));
      assert.equal(starts(h, "claude").at(-1)!.settings.fastMode, true, model);
    }
    const launched = starts(h, "claude").length;
    for (const model of ["haiku", "sonnet", "sonnet[1m]", "claude-sonnet-5-5", "claude-opus-4-7"]) {
      const r = await h.call("ask", { target: "claude", message: "x", model, speed: "fast" });
      assert.equal(r.refused, true, JSON.stringify(r));
      assert.match(r.reason, /Opus 5\.5, Opus 5 and Opus 4\.8/);
    }
    const ultra = await h.call("delegate", { target: "claude", task: "x", mode: "read", model: "opus", speed: "ultrafast" });
    assert.equal(ultra.refused, true, JSON.stringify(ultra));
    assert.match(ultra.reason, /Claude has no ultrafast/);
    assert.equal(starts(h, "claude").length, launched, "nothing refused was launched");
    // An alias relay cannot place ("default", "opusplan") is Claude's to judge: launched fast, and Claude's report says how it ran.
    for (const model of ["default", "opusplan"]) {
      assert.ok((await h.call("ask", { target: "claude", message: `alias ${model}`, model, speed: "fast" })).reply, model);
      assert.equal(starts(h, "claude").at(-1)!.settings.fastMode, true, model);
    }
  } finally {
    await h.close();
  }
});

test("speed: a fast Claude turn that ran at standard says so, with Claude's reason, and status shows what was requested and what Claude reported", async () => {
  const h = await harness([], {}, { STUB_RESULT: JSON.stringify({ fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled", usage: { speed: "standard" } }) });
  try {
    const r = await h.call("ask", { target: "claude", message: "q", model: "opus", speed: "fast" });
    assert.ok(r.reply, JSON.stringify(r));
    assert.match(r.warning, /fast was asked for, but Claude ran this turn at standard speed/);
    assert.match(r.warning, /extra_usage_disabled/);
    const s = await h.call("status", { id: r.thread_id });
    assert.deepEqual(s.speed, { requested: "fast", reported: { fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled", speed: "standard" } });
    const job = await h.call("delegate", { target: "claude", task: "j", mode: "read", model: "opus", speed: "fast", background: false });
    assert.ok(job.result.warnings.some((w: string) => /standard speed/.test(w) && /extra_usage_disabled/.test(w)), JSON.stringify(job.result));
  } finally {
    await h.close();
  }
});

test("speed: a fast Claude turn that ran fast carries no warning, and Codex's status says only what was requested", async () => {
  const h = await harness();
  try {
    const r = await h.call("ask", { target: "claude", message: "q", model: "opus", speed: "fast" });
    assert.equal(r.warning, undefined, JSON.stringify(r));
    assert.deepEqual((await h.call("status", { id: r.thread_id })).speed, { requested: "fast", reported: { fast_mode_state: "on", speed: "fast" } });
    const c = await h.call("ask", { target: "codex", message: "q", speed: "fast" });
    // Codex does not report the tier that served the turn.
    assert.deepEqual((await h.call("status", { id: c.thread_id })).speed, { requested: "fast" });
    assert.equal((await h.call("status", { id: (await h.call("ask", { target: "codex", message: "plain" })).thread_id })).speed, undefined, "standard is not shown");
  } finally {
    await h.close();
  }
});

test("speed: Codex's fast and ultrafast are its catalog's service tiers, on the thread and on every turn; a follow-up keeps or changes it", async () => {
  const h = await harness([], {}, { STUB_CODEX_MODELS: BOTH_TIERS });
  try {
    const first = await h.call("ask", { target: "codex", message: "a", speed: "fast" });
    assert.ok(first.reply, JSON.stringify(first));
    await h.call("ask", { target: "codex", message: "a2", thread_id: first.thread_id });
    await h.call("ask", { target: "codex", message: "a3", thread_id: first.thread_id, speed: "standard" });
    await h.call("ask", { target: "codex", message: "b", speed: "ultrafast" });
    const [a, a2, a3, b] = starts(h, "codex");
    assert.deepEqual(tiers(a), ["priority", "priority"]);
    assert.ok(a.argv.includes('service_tier="priority"'), a.argv.join(" "));
    assert.deepEqual(tiers(a2), ["priority", "priority"], "a follow-up that names no speed keeps the thread's");
    assert.deepEqual(tiers(a3), ["default", "default"], "a follow-up's speed applies from its turn on");
    assert.deepEqual(tiers(b), ["ultrafast", "ultrafast"]);
  } finally {
    await h.close();
  }
});

test("speed: relay refuses a speed the account's Codex catalog does not offer, before the turn starts, and decides from the catalog, not the plan", async () => {
  const h = await harness([], {}, { STUB_CODEX_PLAN: "prolite" });
  try {
    const ultra = await h.call("ask", { target: "codex", message: "u", speed: "ultrafast" });
    assert.match(ultra.error, /ultrafast isn't offered to this account for gpt-stub/, JSON.stringify(ultra));
    assert.match(ultra.error, /Codex plan: Pro \$100/);
    assert.match(ultra.error, /catalog offers fast for it/);
    assert.match(ultra.error, /Pass speed: "fast" or "standard"\./, "the remedy names a speed to pass, not leaving speed out");
    const unknown = await h.call("ask", { target: "codex", message: "m", model: "gpt-x", speed: "fast" });
    assert.match(unknown.error, /"gpt-x" is not in this account's Codex catalog/, JSON.stringify(unknown));
    assert.equal(starts(h, "codex").length, 0, "no turn started");
    assert.ok(h.log().some((r) => r.event === "model-list"), "the catalog was asked");
    // Standard needs no catalog, and fast where the catalog offers it runs.
    assert.ok((await h.call("ask", { target: "codex", message: "f", speed: "fast" })).reply);
    assert.equal(starts(h, "codex").length, 1);
  } finally {
    await h.close();
  }
  // A plan that a table would say cannot have ultrafast, with a catalog that offers it: the catalog decides.
  const free = await harness([], {}, { STUB_CODEX_PLAN: "free", STUB_CODEX_MODELS: BOTH_TIERS });
  try {
    assert.ok((await free.call("ask", { target: "codex", message: "u", speed: "ultrafast" })).reply);
    assert.deepEqual(tiers(starts(free, "codex")[0]), ["ultrafast", "ultrafast"]);
  } finally {
    await free.close();
  }
  // And a plan a table would say has ultrafast, with a catalog that does not offer it: refused, the plan named only to explain.
  const promax = await harness([], {}, { STUB_CODEX_PLAN: "promax" });
  try {
    const u = await promax.call("ask", { target: "codex", message: "u", speed: "ultrafast" });
    assert.match(u.error ?? "", /ultrafast isn't offered to this account for gpt-stub \(Codex plan: Pro \$500 \(promax\)/, JSON.stringify(u));
    assert.equal(starts(promax, "codex").length, 0);
  } finally {
    await promax.close();
  }
});

test("speed: targets.<id>.speed is the root's default, and a call's speed overrides it", async () => {
  const h = await harness([], { targets: { codex: { speed: "fast" }, claude: { speed: "fast", default_model: "opus" } } });
  try {
    await h.call("ask", { target: "codex", message: "a" });
    await h.call("ask", { target: "codex", message: "b", speed: "standard" });
    await h.call("ask", { target: "claude", message: "c" });
    const [a, b] = starts(h, "codex");
    assert.deepEqual(tiers(a), ["priority", "priority"]);
    assert.deepEqual(tiers(b), ["default", "default"]);
    assert.equal(starts(h, "claude")[0].settings.fastMode, true);
  } finally {
    await h.close();
  }
});

test("speed: only the root raises speed; a launched agent's work runs at its own job's speed, or lower", async () => {
  const h = await harness([
    { match: task("FASTPARENT"), steps: [
      { call: "delegate", args: { task: "INHERITS", mode: "read", model: "opus", background: false } },
      { call: "delegate", args: { task: "LOWER", mode: "read", model: "opus", speed: "standard", background: false } },
      { reply: "done" },
    ] },
    { match: task("PLAINPARENT"), steps: [
      { call: "delegate", args: { task: "RAISES", mode: "read", model: "opus", speed: "fast" } },
      { call: "ask", args: { message: "RAISES TOO", model: "opus", speed: "fast" } },
      { reply: "done" },
    ] },
  ]);
  try {
    const fast = await h.call("delegate", { target: "codex", task: "FASTPARENT", mode: "read", speed: "fast", background: false });
    assert.equal(fast.status, "done", JSON.stringify(fast));
    const child = (name: string) => starts(h, "claude").find((s) => new RegExp(task(name), "m").test(s.prompt))!;
    assert.equal(child("INHERITS").settings.fastMode, true, "inherited from its job");
    assert.equal(child("LOWER").settings.fastMode, false, "a launched agent may go lower");

    const plain = await h.call("delegate", { target: "codex", task: "PLAINPARENT", mode: "read", background: false });
    assert.equal(plain.status, "done", JSON.stringify(plain));
    const calls = h.ends().find((e) => e.target === "codex" && e.calls?.some((c: Rec) => c.args?.task === "RAISES"))!.calls;
    for (const c of calls) {
      assert.equal(c.result.refused, true, JSON.stringify(c.result));
      assert.match(c.result.reason, /only the root session can raise speed/);
      assert.match(c.result.reason, /you run at standard/);
    }
    assert.ok(!starts(h, "claude").some((s) => /RAISES/.test(s.prompt)), "nothing was launched faster");
  } finally {
    await h.close();
  }
});

test("speed: a Codex subagent thread cannot raise speed above what the person configured", async () => {
  const subagent = { "x-codex-turn-metadata": { thread_source: "subagent", session_id: "s", thread_id: "t" } };
  const h = await harness();
  try {
    const host = await h.instance({ args: ["--host", "codex"] });
    const r = await host.call("ask", { target: "claude", message: "x", model: "opus", speed: "fast" }, { meta: subagent });
    assert.equal(r.refused, true, JSON.stringify(r));
    assert.match(r.reason, /Codex subagent thread/);
    assert.match(r.reason, /raise speed/);
    // Standard, or what the person configured, it may ask for; the person's own thread may raise it.
    assert.ok((await host.call("ask", { target: "claude", message: "y", speed: "standard" }, { meta: subagent })).reply);
    const T = (await host.call("ask", { target: "claude", message: "z", model: "opus", speed: "fast" })).thread_id;
    assert.ok(T);
    // A thread the person raised, a subagent thread may carry on at its speed, and no faster.
    assert.ok((await host.call("ask", { thread_id: T, message: "go on", speed: "fast" }, { meta: subagent })).reply);
    assert.equal(starts(h, "claude").at(-1)!.settings.fastMode, true);
    const up = await host.call("ask", { thread_id: T, message: "faster", speed: "ultrafast" }, { meta: subagent });
    assert.match(up.reason ?? "", /Codex subagent thread, .*above what the user set up \(fast for Claude\)/, JSON.stringify(up));
  } finally {
    await h.close();
  }
});

test("speed: discuss and review take a speed for the session they start", async () => {
  const h = await harness([{ steps: [{ reply: "AGREE: fine" }] }], {}, { STUB_CODEX_MODELS: BOTH_TIERS });
  try {
    await h.call("discuss", { target: "codex", topic: "t", message: "m\nCONTINUE", speed: "fast" });
    assert.deepEqual(tiers(starts(h, "codex")[0]), ["priority", "priority"]);
    await h.call("review", { reviewer: "claude", target: "README.md", model: "opus", speed: "fast" });
    await until(() => starts(h, "claude").length === 1, 10000, "the reviewer");
    assert.equal(starts(h, "claude")[0].settings.fastMode, true);
  } finally {
    await h.close();
  }
});

test("speed (codex exec): the fallback sets service_tier, and its preflight refuses a tier the catalog does not offer", async () => {
  const h = await harness([], { codex_backend: "exec" });
  try {
    assert.ok((await h.call("ask", { target: "codex", message: "f", speed: "fast" })).reply);
    const [f] = starts(h, "codex");
    assert.ok(f.argv.includes('service_tier="priority"'), f.argv.join(" "));
    const ultra = await h.call("ask", { target: "codex", message: "u", speed: "ultrafast" });
    assert.match(ultra.error, /ultrafast isn't offered to this account/, JSON.stringify(ultra));
    assert.equal(starts(h, "codex").length, 1, "the refused turn never ran");
  } finally {
    await h.close();
  }
});

// Review of the speed work, round 1 (2026-10-17): what it found untested, and the defects.

/** Sets a session's speed as relay keeps it, for a state no call of the root's makes directly. */
const setSpeed = (h: { sql(q: string, ...p: unknown[]): Rec[] }, id: string, speed: string) =>
  h.sql("UPDATE nodes SET params_json = json_set(COALESCE(params_json, '{}'), '$.speed', ?) WHERE id = ?", speed, id);

test("speed: a fast Claude write job that changed nothing and ran at standard still leaves no worktree or branch; the speed warning stays in its result", async () => {
  const h = await harness([], {}, { STUB_RESULT: JSON.stringify({ fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled", usage: { speed: "standard" } }) });
  try {
    const job = await h.call("delegate", { target: "claude", task: "look only", mode: "write", model: "opus", speed: "fast", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.equal(job.result.no_changes, true);
    // A speed warning says nothing about what the agent may have left running, so it keeps nothing.
    assert.equal(job.result.branch, null, JSON.stringify(job.result));
    assert.equal(execFileSync("git", ["branch", "--list", "relay/*"], { cwd: h.repo, encoding: "utf8" }).trim(), "", "no relay branch is left");
    assert.ok(!fs.existsSync(starts(h, "claude")[0].cwd), "no worktree is left");
    assert.ok(job.result.warnings.some((w: string) => /ran this turn at standard speed/.test(w)), JSON.stringify(job.result));
  } finally {
    await h.close();
  }
});

test("speed: a fast Claude turn says so when Claude does not report its speed, and when its fast mode went into cooldown", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ fast_mode_state: null, usage: { speed: null } }, /fast was asked for, but Claude did not report the speed this turn ran at, so relay cannot tell that it ran fast\./],
    [{ fast_mode_state: "cooldown" }, /fast was asked for, and Claude's fast mode went into cooldown after a rate limit, so part of this turn may have run at standard speed\./],
    [{ fast_mode_state: "cooldown", usage: { speed: "standard" } }, /fast was asked for, but Claude ran this turn at standard speed, its fast mode cooling down after a rate limit\./],
  ];
  for (const [result, warning] of cases) {
    const h = await harness([], {}, { STUB_RESULT: JSON.stringify(result) });
    try {
      const r = await h.call("ask", { target: "claude", message: "q", model: "opus", speed: "fast" });
      assert.ok(r.reply, JSON.stringify(r));
      assert.match(r.warning ?? "", warning, JSON.stringify(result));
    } finally {
      await h.close();
    }
  }
  // Fast mode on, and no usage.speed (Claude's usage leaves it out for some turns): that is a fast turn, with nothing to warn of.
  const on = await harness([], {}, { STUB_RESULT: JSON.stringify({ fast_mode_state: "on", usage: { speed: null } }) });
  try {
    const r = await on.call("ask", { target: "claude", message: "q", model: "opus", speed: "fast" });
    assert.ok(r.reply, JSON.stringify(r));
    assert.equal(r.warning, undefined, JSON.stringify(r));
  } finally {
    await on.close();
  }
});

test("speed: status shows what Claude reported only with the speed its turn asked for", async () => {
  const h = await harness();
  try {
    // A report from a turn at standard says nothing about fast, once the session has been raised.
    const T = (await h.call("ask", { target: "claude", message: "q", model: "opus" })).thread_id;
    setSpeed(h, T, "fast");
    assert.deepEqual((await h.call("status", { id: T })).speed, { requested: "fast" });
  } finally {
    await h.close();
  }
});

/** The speed a session's params hold, as relay wrote them. */
const storedSpeed = (h: { sql(q: string, ...p: unknown[]): Rec[] }, id: string) => JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", id)[0].params_json ?? "{}").speed ?? "standard";
/** A catalog of two models: the default offers fast, the other no faster tier at all. */
const TWO_MODELS = JSON.stringify([
  { id: "gpt-stub", model: "gpt-stub", displayName: "GPT-Stub", hidden: false, isDefault: true, defaultServiceTier: null, serviceTiers: [{ id: "priority", name: "Fast" }] },
  { id: "gpt-other", model: "gpt-other", displayName: "GPT-Other", hidden: false, isDefault: false, defaultServiceTier: null, serviceTiers: [] },
]);
test("speed: Codex's effective config, its profile and its thread must not run another tier than relay set, and the catalog is asked about the model that will run", async () => {
  const cases: [Record<string, string>, Record<string, unknown>, RegExp][] = [
    [{ STUB_CODEX_EFFECTIVE: JSON.stringify({ service_tier: "priority" }) }, {}, /service_tier is "priority" where relay set "default"/],
    [{ STUB_CODEX_EFFECTIVE: JSON.stringify({ profile: "p", profiles: { p: { service_tier: "priority" } } }) }, {}, /profiles\.p\.service_tier is "priority" where relay set "default"/],
    [{ STUB_CODEX_THREAD: JSON.stringify({ serviceTier: null }) }, { speed: "fast" }, /its thread reports the service tier null, not the "priority" \(fast speed\) relay asked for/],
    [{ STUB_CODEX_THREAD: JSON.stringify({ serviceTier: "priority" }) }, {}, /its thread reports the service tier "priority", not the "default" \(standard speed\) relay asked for/],
    // Codex 0.163.0 reports null for a tier it dropped and for none, and with none a model's catalog default tier (priority, for some) applies: standard fails closed.
    [{ STUB_CODEX_THREAD: JSON.stringify({ serviceTier: null }) }, {}, /its thread reports the service tier null, not the "default" \(standard speed\) relay asked for/],
    // The thread runs another model than the one checked: that one is checked too.
    [{ STUB_CODEX_THREAD: JSON.stringify({ model: "gpt-other" }), STUB_CODEX_MODELS: TWO_MODELS }, { speed: "fast" }, /fast isn't offered to this account for gpt-other/],
    // No model named: Codex's own configured model is the one checked, not the catalog's default.
    [{ STUB_CODEX_EFFECTIVE: JSON.stringify({ model: "gpt-x" }) }, { speed: "fast" }, /"gpt-x" is not in this account's Codex catalog/],
  ];
  for (const [env, args, error] of cases) {
    const h = await harness([], {}, env);
    try {
      const r = await h.call("ask", { target: "codex", message: "x", ...args });
      assert.match(r.error ?? "", error, `${JSON.stringify(env)}: ${JSON.stringify(r)}`);
      assert.equal(starts(h, "codex").length, 0, "no turn started");
    } finally {
      await h.close();
    }
  }
  // A server that does not report a tier at all is judged by its effective config alone.
  const quiet = await harness([], {}, { STUB_CODEX_THREAD_OMIT: JSON.stringify(["serviceTier"]) });
  try {
    assert.ok((await quiet.call("ask", { target: "codex", message: "s" })).reply);
  } finally {
    await quiet.close();
  }
});

test("speed: the Codex catalog is read whole, every page and hidden models too", async () => {
  const hidden = { id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false, defaultServiceTier: null, serviceTiers: [{ id: "ultrafast", name: "Ultrafast" }] };
  const first = JSON.parse(BOTH_TIERS).map((m: Rec) => ({ ...m, serviceTiers: [{ id: "priority", name: "Fast" }] }));
  const h = await harness([], {}, { STUB_CODEX_MODEL_PAGES: JSON.stringify([first, [hidden]]) });
  try {
    const r = await h.call("ask", { target: "codex", message: "x", model: "gpt-hidden", speed: "ultrafast" });
    assert.ok(r.reply, JSON.stringify(r));
    assert.deepEqual(tiers(starts(h, "codex")[0]), ["ultrafast", "ultrafast"]);
    assert.deepEqual(h.log().filter((e) => e.event === "model-list").map((e) => e.params), [{ includeHidden: true }, { includeHidden: true, cursor: "1" }]);
  } finally {
    await h.close();
  }
});

test("speed: a raise the Codex catalog refuses leaves the session at its speed before, so the next call is not refused the same way; resume takes a speed", async () => {
  const h = await harness();
  try {
    // A thread at standard; a follow-up asks for a speed the catalog (fast only) does not offer.
    const T = (await h.call("ask", { target: "codex", message: "a" })).thread_id;
    const raised = await h.call("ask", { thread_id: T, message: "b", speed: "ultrafast" });
    assert.match(raised.error ?? "", /ultrafast isn't offered to this account for gpt-stub/, JSON.stringify(raised));
    assert.match(raised.error, /Pass speed: "fast" or "standard"\./, "the remedy names a speed to pass");
    assert.equal(storedSpeed(h, T), "standard", "the raise is undone");
    assert.ok((await h.call("ask", { thread_id: T, message: "c" })).reply, "a follow-up that names no speed runs");
    assert.deepEqual(starts(h, "codex").map(tiers), [["default", "default"], ["default", "default"]]);

    // A job the same way, through resume's speed.
    const J = (await h.call("delegate", { target: "codex", task: "j", mode: "read", background: false })).job_id;
    await h.call("resume", { job_id: J, message: "faster", speed: "ultrafast" });
    const failed = await h.call("status", { id: J, wait_s: 20 });
    assert.equal(failed.status, "failed", JSON.stringify(failed));
    assert.match(failed.error, /ultrafast isn't offered/);
    assert.equal(storedSpeed(h, J), "standard");
    await h.call("resume", { job_id: J, message: "again" });
    assert.equal((await h.call("status", { id: J, wait_s: 20 })).status, "done");

    // Started at a speed the catalog refuses, a job keeps it; resume with a speed carries it on at another.
    const U = await h.call("delegate", { target: "codex", task: "u", mode: "read", speed: "ultrafast", background: false });
    assert.equal(U.status, "failed", JSON.stringify(U));
    await h.call("resume", { job_id: U.job_id, message: "standard then", speed: "standard" });
    assert.equal((await h.call("status", { id: U.job_id, wait_s: 20 })).status, "done");
    assert.deepEqual(tiers(starts(h, "codex").at(-1)!), ["default", "default"]);
  } finally {
    await h.close();
  }
});

test("speed: a slower speed a call asks for stays, even when its turn never reaches the model", async () => {
  // Every thread reports priority: a fast turn runs, a standard one is refused before the model is asked.
  const h = await harness([], {}, { STUB_CODEX_THREAD: JSON.stringify({ serviceTier: "priority" }) });
  try {
    const T = (await h.call("ask", { target: "codex", message: "a", speed: "fast" })).thread_id;
    const slower = await h.call("ask", { thread_id: T, message: "b", speed: "standard" });
    assert.match(slower.error ?? "", /reports the service tier "priority", not the "default"/, JSON.stringify(slower));
    assert.equal(storedSpeed(h, T), "standard", "the cheaper speed is kept");
  } finally {
    await h.close();
  }
});

test("speed: carrying on a discussion or a review changes the other side's speed from the turn it queues; a call that sends nothing changes nothing", async () => {
  const h = await harness([
    { target: "codex", match: "HOLD", steps: [{ awaitMark: "go" }, { reply: "held\nCONTINUE" }] },
    { target: "codex", steps: [{ reply: "go on\nCONTINUE" }] },
  ], {}, { STUB_CODEX_MODELS: BOTH_TIERS });
  try {
    const D = (await h.call("discuss", { target: "codex", topic: "t", message: "m\nCONTINUE" })).discussion_id;
    const P = (await h.call("status", { id: D })).participant ?? h.sql("SELECT id FROM nodes WHERE parent_id = ?", D)[0].id;
    assert.ok((await h.call("discuss", { discussion_id: D, message: "faster\nCONTINUE", speed: "fast" })).reply);
    assert.ok((await h.call("discuss", { discussion_id: D, message: "kept\nCONTINUE" })).reply);
    assert.deepEqual(starts(h, "codex").map(tiers), [["default", "default"], ["priority", "priority"], ["priority", "priority"]]);

    // Busy: the other side is still writing, so the message is not sent, and the speed stays.
    const held = new AbortController();
    const holding = h.call("discuss", { discussion_id: D, message: "HOLD\nCONTINUE" }, { signal: held.signal }).catch(() => null);
    await until(() => starts(h, "codex").length === 4, 20000, "the held turn to start");
    held.abort();
    await holding;
    const busy = await h.call("discuss", { discussion_id: D, message: "more\nCONTINUE", speed: "ultrafast" });
    assert.match(busy.not_sent ?? "", /still writing its reply/, JSON.stringify(busy));
    assert.equal(storedSpeed(h, P), "fast");
    h.mark("go");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM turns WHERE node_id = ? AND status IN ('queued', 'running')", P)[0].c === 0, 20000, "the held reply");

    // A thread borrowed with `with` goes on at its own speed, or at the one the call gives.
    const T = (await h.call("ask", { target: "codex", message: "q" })).thread_id;
    const W = (await h.call("discuss", { with: T, topic: "w", message: "m\nCONTINUE", speed: "fast" })).discussion_id;
    assert.deepEqual(tiers(starts(h, "codex").at(-1)!), ["priority", "priority"]);
    assert.equal(storedSpeed(h, T), "fast");
    // Ended: the message is not sent, and the borrowed thread keeps its speed for its own later turns.
    await h.call("cancel", { id: W });
    const ended = await h.call("discuss", { discussion_id: W, message: "more\nCONTINUE", speed: "standard" });
    assert.match(ended.note ?? "", /has ended, so your message was not sent/, JSON.stringify(ended));
    assert.equal(storedSpeed(h, T), "fast");
  } finally {
    await h.close();
  }
  // A review's reconciliation, carried on with review_id and a speed, runs its turns at it.
  const items = "```json\n" + JSON.stringify({ items: [{ n: 1, severity: "minor", location: "README.md:1", summary: "s", evidence: "e", fix: "f" }] }) + "\n```";
  const r = await harness([
    { target: "codex", match: "independent code reviewer", steps: [{ reply: `review\n${items}` }] },
    { target: "codex", turn: 2, steps: [{ reply: "go on\nCONTINUE" }] },
  ], {}, { STUB_CODEX_MODELS: BOTH_TIERS });
  try {
    const claude = await r.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { target: "README.md" });
    // Once the reviewer has written its review, so that the speed is its next turn's: the reconciliation's.
    assert.equal((await claude.call("status", { id: started.reviewer_job, wait_s: 20 })).status, "done");
    const handed = await claude.call("review", { review_id: started.review_id, own_review: `mine\n${items}`, speed: "fast" });
    assert.ok(handed.discussion_id, JSON.stringify(handed));
    assert.deepEqual(starts(r, "codex").map(tiers), [["default", "default"], ["priority", "priority"]]);
    await claude.call("cancel", { id: started.review_id });
    await claude.call("review", { review_id: started.review_id, speed: "standard" });
    assert.equal(storedSpeed(r, started.reviewer_job), "fast", "a review that has ended changes nothing");
  } finally {
    await r.close();
  }
});

test("speed: a launched agent carries on the work it started no faster than it now runs itself, whether or not it names a speed", async () => {
  const h = await harness([], {}, { STUB_CODEX_MODELS: BOTH_TIERS });
  try {
    const J = (await h.call("delegate", { target: "codex", task: "PARENT", mode: "read", speed: "fast", background: false })).job_id;
    // As J, running fast: a job and a thread on Claude, which inherit fast.
    const fast = await h.childOf(J, { access: "read" });
    const asFast = await h.instance(fast);
    const K = (await asFast.call("delegate", { target: "claude", task: "CHILD", mode: "read", model: "opus", background: false })).job_id;
    const T = (await asFast.call("ask", { target: "claude", message: "Q", model: "opus" })).thread_id;
    const R = await asFast.call("review", { reviewer: "claude", target: "README.md", model: "opus" });
    assert.ok(R.review_id, JSON.stringify(R));
    await asFast.close();
    assert.equal((await h.call("status", { id: R.reviewer_job, wait_s: 20 })).status, "done");
    assert.deepEqual(starts(h, "claude").map((s) => s.settings.fastMode), [true, true, true]);
    // The root slows J down (as resume or discuss with a speed does), and J takes another turn.
    h.sql("UPDATE turns SET status = 'done', ended_at = ? WHERE id = ?", Date.now(), fast.turnId);
    setSpeed(h, J, "standard");
    const asSlow = await h.instance(await h.childOf(J, { access: "read" }));
    for (const [tool, args] of [
      ["resume", { job_id: K, message: "go on" }],
      ["ask", { thread_id: T, message: "go on" }],
      ["discuss", { with: K, topic: "t", message: "m\nCONTINUE" }],
      ["review", { review_id: R.review_id, own_review: "mine" }],
    ] as const) {
      const r = await asSlow.call(tool, args);
      assert.equal(r.reason, 'Refused: only the root session can raise speed, since a faster speed costs the user money or allowance: the session this call carries on runs at fast, and you run at standard, so the work you start or carry on runs at standard. Pass speed: "standard" instead; if the work needs to be faster, say so in your report.', `${tool}: ${JSON.stringify(r)}`);
      const named = await asSlow.call(tool, { ...args, speed: "fast" });
      assert.match(named.reason ?? "", /only the root session can raise speed, .*: you asked for fast, and you run at standard/, `${tool}: ${JSON.stringify(named)}`);
    }
    assert.equal(starts(h, "claude").length, 3, "nothing carried on faster");
    // At its own speed it may carry them on.
    assert.ok((await asSlow.call("ask", { thread_id: T, message: "slower", speed: "standard" })).reply);
    assert.equal(starts(h, "claude").at(-1)!.settings.fastMode, false);
    assert.equal(storedSpeed(h, T), "standard");
    await asSlow.close();
  } finally {
    await h.close();
  }
});

test("speed: a launched agent's speed is refused where the target has not got it; targets.<id>.speed is the root's, and a Codex subagent thread may ask up to it", async () => {
  const h = await harness([
    { target: "codex", match: task("ULTRA"), steps: [{ call: "delegate", args: { target: "claude", task: "C", mode: "read", model: "opus" } }, { reply: "{{last}}" }] },
    { target: "codex", match: task("PLAIN"), steps: [{ call: "delegate", args: { target: "claude", task: "PLAINCHILD", mode: "read", model: "opus", background: false } }, { reply: "done" }] },
  ], { targets: { claude: { speed: "fast", default_model: "opus" } } }, { STUB_CODEX_MODELS: BOTH_TIERS });
  try {
    const ultra = await h.call("delegate", { target: "codex", task: "ULTRA", mode: "read", speed: "ultrafast", background: false });
    assert.equal(ultra.status, "done", JSON.stringify(ultra));
    const [c] = h.ends().find((e) => e.target === "codex" && e.calls?.length)!.calls;
    assert.equal(c.result.reason, 'Refused: Claude has no ultrafast speed in relay: it runs at standard or fast. Your own session runs at ultrafast, and the work you start runs at your speed unless you pass a slower one. Pass speed: "fast" or "standard" instead.');

    // A standard Codex job's Claude child runs at standard: targets.claude.speed is a root session's default.
    assert.equal((await h.call("delegate", { target: "codex", task: "PLAIN", mode: "read", background: false })).status, "done");
    const child = starts(h, "claude").find((s) => new RegExp(task("PLAINCHILD"), "m").test(s.prompt))!;
    assert.equal(child.settings.fastMode, false);

    // A Codex subagent thread may ask for what the person configured, and no more.
    const subagent = { "x-codex-turn-metadata": { thread_source: "subagent", session_id: "s", thread_id: "t" } };
    const host = await h.instance({ args: ["--host", "codex"] });
    assert.ok((await host.call("ask", { target: "claude", message: "y", speed: "fast" }, { meta: subagent })).reply);
    assert.equal(starts(h, "claude").at(-1)!.settings.fastMode, true);
    const up = await host.call("ask", { target: "claude", message: "z", speed: "ultrafast" }, { meta: subagent });
    assert.match(up.reason ?? "", /Codex subagent thread, .*above what the user set up \(fast for Claude\)/, JSON.stringify(up));
    await host.close();
  } finally {
    await h.close();
  }
});

test("speed: the config refuses a targets.<id>.speed its target cannot run; a refusal says where a speed came from and names one to pass", async () => {
  const { validateConfig } = await import("../dist/core/config.js");
  assert.throws(() => validateConfig({ targets: { claude: { speed: "ultrafast" } } }, "test"), /targets\.claude\.speed: Claude has no ultrafast speed in relay; it runs at standard or fast/);
  assert.throws(() => validateConfig({ targets: { copilot: { speed: "fast" } } }, "test"), /targets\.copilot\.speed: Copilot has no fast speed in relay; it runs at standard/);
  assert.throws(() => validateConfig({ targets: { claude: { speed: "fast", default_model: "sonnet" } } }, "test"), /targets\.claude\.speed: Claude's fast speed is for Opus 5\.5, Opus 5 and Opus 4\.8 only, and its default model is "sonnet"/);
  assert.throws(() => validateConfig({ default_model: { claude: "sonnet" }, targets: { claude: { speed: "fast" } } }, "test"), /targets\.claude\.speed: .*its default model is "sonnet"/);
  // What it can run loads; so does fast with no default model, which Claude reports on after the turn.
  validateConfig({ targets: { claude: { speed: "fast", default_model: "opus" }, codex: { speed: "ultrafast" }, copilot: { speed: "standard" } } }, "test");
  validateConfig({ targets: { claude: { speed: "fast" } } }, "test");

  const h = await harness([], { targets: { claude: { speed: "fast", default_model: "opus" } } });
  try {
    // Configured: the refusal names the key, and passing a speed gets past it.
    assert.equal((await h.call("ask", { target: "claude", message: "x", model: "sonnet" })).reason,
      'Refused: Claude\'s fast speed is for Opus 5.5, Opus 5 and Opus 4.8 only, and this call would run "sonnet". Relay\'s config sets targets.claude.speed to fast, the speed of a call that names none. Name one of those with model, or pass speed: "standard", or change targets.claude.speed.');
    assert.ok((await h.call("ask", { target: "claude", message: "y", model: "sonnet", speed: "standard" })).reply);
    // A session's own speed, which a follow-up that names none goes on at; its model cannot change.
    const S = (await h.call("ask", { target: "claude", message: "s", model: "sonnet", speed: "standard" })).thread_id;
    setSpeed(h, S, "fast");
    assert.equal((await h.call("ask", { thread_id: S, message: "again" })).reason,
      'Refused: Claude\'s fast speed is for Opus 5.5, Opus 5 and Opus 4.8 only, and this call would run "sonnet". The session this call carries on runs at fast. Pass speed: "standard".');
    setSpeed(h, S, "ultrafast");
    assert.equal((await h.call("ask", { thread_id: S, message: "again" })).reason,
      'Refused: Claude has no ultrafast speed in relay: it runs at standard or fast. The session this call carries on runs at ultrafast. Pass speed: "fast" or "standard" instead.');
    assert.ok((await h.call("ask", { thread_id: S, message: "again", speed: "standard" })).reply);
  } finally {
    await h.close();
  }
});

test("speed: delegate says the speed it started a job at, as status does, and so does a repeated request_id", async () => {
  const h = await harness();
  try {
    const fast = await h.call("delegate", { target: "codex", task: "f", mode: "read", speed: "fast", request_id: "speed-1" });
    assert.deepEqual(fast.speed, { requested: "fast" }, JSON.stringify(fast));
    assert.deepEqual((await h.call("delegate", { target: "codex", task: "f", mode: "read", speed: "fast", request_id: "speed-1" })).speed, { requested: "fast" });
    const plain = await h.call("delegate", { target: "codex", task: "p", mode: "read" });
    assert.equal("speed" in plain, false, JSON.stringify(plain));
    assert.deepEqual((await h.call("status", { id: fast.job_id, wait_s: 20 })).speed, { requested: "fast" });
    await h.call("status", { id: plain.job_id, wait_s: 20 });
  } finally {
    await h.close();
  }
});

test("speed: a Codex catalog refusal names only slower speeds to pass, never a costlier one", async () => {
  const { tierProblem } = await import("../dist/backends/codex-app.js");
  // A catalog that offers ultrafast and not priority: fast is refused, and ultrafast is not suggested.
  const ultraOnly = [{ id: "gpt-stub", model: "gpt-stub", isDefault: true, serviceTiers: [{ id: "ultrafast" }] }];
  const fast = tierProblem(ultraOnly, null, { name: "fast", tier: "priority" });
  assert.match(fast ?? "", /fast isn't offered to this account for gpt-stub: the account's catalog offers ultrafast for it\. Pass speed: "standard"\.$/, fast ?? "");
  const ultra = tierProblem([{ ...ultraOnly[0], serviceTiers: [{ id: "priority" }] }], null, { name: "ultrafast", tier: "ultrafast" });
  assert.match(ultra ?? "", /Pass speed: "fast" or "standard"\.$/, ultra ?? "");
});

// Review of the speed work, round 2 (2026-10-18): a speed belongs to the turn its call queued, and the
// session takes it only as that turn starts.

/** A session's turns, oldest first, as [status, the stub's tiers for it] once they have ended. */
const turnStatuses = (h: { sql(q: string, ...p: unknown[]): Rec[] }, id: string) => h.sql("SELECT status FROM turns WHERE node_id = ? ORDER BY id", id).map((t) => t.status);
const settledTurns = (h: { sql(q: string, ...p: unknown[]): Rec[] }, id: string) => h.sql("SELECT COUNT(*) AS c FROM turns WHERE node_id = ? AND status IN ('queued', 'running')", id)[0].c === 0;

test("speed: a raise whose turn never starts changes nothing: one queued behind a turn that fails, and one a cancel drops", async () => {
  const h = await harness([
    { target: "codex", match: task("HOLDFAIL"), steps: [{ awaitMark: "fail" }, { fail: "held, then failed" }] },
    { target: "codex", match: task("HOLDRUN"), steps: [{ awaitMark: "never" }, { reply: "held" }] },
  ]);
  try {
    // Behind a turn that fails, which takes the turns queued behind it with it.
    const J = (await h.call("delegate", { target: "codex", task: "HOLDFAIL", mode: "read" })).job_id;
    await until(() => starts(h, "codex").length === 1, 20000, "the held turn to start");
    const raised = await h.call("resume", { job_id: J, message: "faster", speed: "ultrafast" });
    assert.equal(raised.status, "queued_behind_current_turn", JSON.stringify(raised));
    assert.equal(storedSpeed(h, J), "standard", "the turn running now keeps its speed");
    assert.deepEqual((await h.call("status", { id: J })).speed, { requested: "standard", next: "ultrafast" });
    h.mark("fail");
    assert.equal((await h.call("status", { id: J, wait_s: 20 })).status, "failed");
    await until(() => settledTurns(h, J), 20000, "J's turns to end");
    assert.deepEqual(turnStatuses(h, J), ["failed", "cancelled"]);
    assert.equal(storedSpeed(h, J), "standard", "the dropped raise changed nothing");
    assert.equal((await h.call("status", { id: J })).speed, undefined);
    await h.call("resume", { job_id: J, message: "plain" });
    assert.equal((await h.call("status", { id: J, wait_s: 20 })).status, "done", "a resume naming no speed runs");
    assert.deepEqual(tiers(starts(h, "codex").at(-1)!), ["default", "default"]);

    // Dropped by a cancel, the documented way to redirect a job (cancel, then resume).
    const K = (await h.call("delegate", { target: "codex", task: "HOLDRUN", mode: "read" })).job_id;
    await until(() => starts(h, "codex").length === 3, 20000, "K's held turn to start");
    assert.equal((await h.call("resume", { job_id: K, message: "faster", speed: "ultrafast" })).status, "queued_behind_current_turn");
    await h.call("cancel", { id: K });
    await until(() => settledTurns(h, K), 20000, "K's turns to end");
    assert.equal(storedSpeed(h, K), "standard");
    let again: Rec = {};
    await until(async () => !(again = await h.call("resume", { job_id: K, message: "redirected" })).refused, 20000, "K to finish stopping");
    assert.equal((await h.call("status", { id: K, wait_s: 20 })).status, "done", JSON.stringify(again));
    assert.deepEqual(tiers(starts(h, "codex").at(-1)!), ["default", "default"]);
  } finally {
    await h.close();
  }
});

test("speed: a raise cancelled while its turn waits for a slot changes nothing", async () => {
  const h = await harness([{ target: "codex", match: task("SLOT"), steps: [{ awaitMark: "slot" }, { reply: "held" }] }], { max_concurrent: 1 });
  try {
    const J = (await h.call("delegate", { target: "codex", task: "j", mode: "read", background: false })).job_id;
    const X = (await h.call("delegate", { target: "codex", task: "SLOT", mode: "read" })).job_id;
    await until(() => starts(h, "codex").length === 2, 20000, "X to hold the one slot");
    await h.call("resume", { job_id: J, message: "faster", speed: "fast" });
    assert.equal(storedSpeed(h, J), "standard");
    await h.call("cancel", { id: J });
    await until(() => settledTurns(h, J), 20000, "J's queued turn to end");
    h.mark("slot");
    assert.equal((await h.call("status", { id: X, wait_s: 20 })).status, "done");
    assert.equal(storedSpeed(h, J), "standard");
    assert.equal(starts(h, "codex").length, 2, "J's raised turn never started");
    let again: Rec = {};
    await until(async () => !(again = await h.call("resume", { job_id: J, message: "plain" })).refused, 20000, "J to finish stopping");
    assert.equal((await h.call("status", { id: J, wait_s: 20 })).status, "done", JSON.stringify(again));
    assert.deepEqual(tiers(starts(h, "codex").at(-1)!), ["default", "default"]);
  } finally {
    await h.close();
  }
});

test("speed: each queued turn runs at the speed its own call was admitted at, not a later call's", async () => {
  const h = await harness([{ target: "codex", match: task("HOLD"), steps: [{ awaitMark: "go" }, { reply: "held" }] }]);
  try {
    const J = (await h.call("delegate", { target: "codex", task: "HOLD", mode: "read" })).job_id;
    await until(() => starts(h, "codex").length === 1, 20000, "the held turn to start");
    // Kept, raised, then slowed again: each from its own turn on.
    for (const [message, speed] of [["second, kept", undefined], ["third, fast", "fast"], ["fourth, standard", "standard"], ["fifth, kept", undefined]] as const) {
      const r = await h.call("resume", { job_id: J, message, ...(speed ? { speed } : {}) });
      assert.equal(r.status, "queued_behind_current_turn", JSON.stringify(r));
    }
    h.mark("go");
    await until(() => settledTurns(h, J), 30000, "J's turns");
    assert.deepEqual(turnStatuses(h, J), ["done", "done", "done", "done", "done"]);
    assert.deepEqual(starts(h, "codex").map((s) => [s.prompt.split("\n")[0].slice(0, 16), ...tiers(s)]).slice(1), [
      ["second, kept", "default", "default"], ["third, fast", "priority", "priority"], ["fourth, standard", "default", "default"], ["fifth, kept", "default", "default"],
    ]);
    assert.equal(storedSpeed(h, J), "standard");
  } finally {
    await h.close();
  }
});

test("speed: a launched agent's turn keeps its own speed while a raise waits behind it, so what it starts then is not raised", async () => {
  const h = await harness([
    { target: "codex", match: task("PARENTHOLD"), steps: [{ awaitMark: "go" }, { call: "delegate", args: { target: "claude", task: "KID", mode: "read", model: "opus", background: false } }, { reply: "{{last}}" }] },
  ]);
  try {
    const J = (await h.call("delegate", { target: "codex", task: "PARENTHOLD", mode: "read" })).job_id;
    await until(() => starts(h, "codex").length === 1, 20000, "J's held turn to start");
    assert.equal((await h.call("resume", { job_id: J, message: "faster", speed: "fast" })).status, "queued_behind_current_turn");
    h.mark("go");
    await until(() => settledTurns(h, J), 30000, "J's turns");
    const [kid] = starts(h, "claude");
    assert.equal(kid.settings.fastMode, false, "started by J's standard turn, so at standard");
    const K = h.sql("SELECT id FROM nodes WHERE parent_id = ? AND kind = 'job'", J)[0].id;
    assert.equal(storedSpeed(h, K), "standard");
    assert.deepEqual(starts(h, "codex").map(tiers), [["default", "default"], ["priority", "priority"]], "J's next turn ran at the raise");
    assert.equal(storedSpeed(h, J), "fast");
  } finally {
    await h.close();
  }
});

test("speed (codex exec): a raise the preflight refuses is undone, so a follow-up naming no speed runs", async () => {
  const h = await harness([], { codex_backend: "exec" });
  try {
    const T = (await h.call("ask", { target: "codex", message: "a" })).thread_id;
    const raised = await h.call("ask", { thread_id: T, message: "b", speed: "ultrafast" });
    assert.match(raised.error ?? "", /ultrafast isn't offered to this account for gpt-stub/, JSON.stringify(raised));
    assert.equal(storedSpeed(h, T), "standard", "the raise is undone");
    assert.ok((await h.call("ask", { thread_id: T, message: "c" })).reply, "a follow-up that names no speed runs");
    assert.equal(starts(h, "codex").length, 2);
    assert.ok(starts(h, "codex").at(-1)!.argv.includes('service_tier="default"'), starts(h, "codex").at(-1)!.argv.join(" "));
  } finally {
    await h.close();
  }
});

test("speed: a review carried on with review_id keeps the reviewer's speed, or takes the one given from the reconciliation's first turn", async () => {
  const items = "```json\n" + JSON.stringify({ items: [{ n: 1, severity: "minor", location: "README.md:1", summary: "s", evidence: "e", fix: "f" }] }) + "\n```";
  const h = await harness([
    { target: "codex", match: "HELDREVIEW", steps: [{ awaitMark: "reviewed" }, { reply: `review\n${items}` }] },
    { target: "codex", match: "independent code reviewer", steps: [{ reply: `review\n${items}` }] },
    { target: "codex", turn: 2, steps: [{ reply: "go on\nCONTINUE" }] },
  ], {}, { STUB_CODEX_MODELS: BOTH_TIERS });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    // Started fast, carried on naming no speed: the reconciliation runs fast too.
    const fast = await claude.call("review", { target: "README.md", speed: "fast" });
    assert.equal((await claude.call("status", { id: fast.reviewer_job, wait_s: 20 })).status, "done");
    const handed = await claude.call("review", { review_id: fast.review_id, own_review: `mine\n${items}` });
    assert.ok(handed.discussion_id, JSON.stringify(handed));
    assert.deepEqual(starts(h, "codex").map(tiers), [["priority", "priority"], ["priority", "priority"]]);
    assert.equal(storedSpeed(h, fast.reviewer_job), "fast");
    // Once the reconciliation is open, a speed given here is said not to apply: discuss takes it.
    const late = await claude.call("review", { review_id: fast.review_id, speed: "standard" });
    assert.match(late.speed_note ?? "", /reconciliation is already open, so this call changed no speed: pass speed to discuss with discussion_id/, JSON.stringify(late));
    assert.equal(storedSpeed(h, fast.reviewer_job), "fast");
    await claude.call("cancel", { id: fast.review_id });

    // A speed given while the reviewer still works is kept for the reconciliation: the reviewer's own turn keeps its speed.
    const slow = await claude.call("review", { target: "README.md", focus: "HELDREVIEW" });
    await until(() => starts(h, "codex").length === 3, 20000, "the held reviewer");
    const early = await claude.call("review", { review_id: slow.review_id, speed: "fast" });
    assert.equal(early.phase, "waiting for your own review", JSON.stringify(early));
    assert.equal(storedSpeed(h, slow.reviewer_job), "standard");
    h.mark("reviewed");
    assert.equal((await claude.call("status", { id: slow.reviewer_job, wait_s: 20 })).status, "done");
    assert.ok((await claude.call("review", { review_id: slow.review_id, own_review: `mine\n${items}` })).discussion_id);
    assert.deepEqual(starts(h, "codex").slice(2).map(tiers), [["default", "default"], ["priority", "priority"]]);
    assert.equal(storedSpeed(h, slow.reviewer_job), "fast");
    await claude.close();
  } finally {
    await h.close();
  }
});

test("speed: Claude's notice that it refused fast mode (usage credits run out) is a turn that ran at standard, with the notice as its reason", async () => {
  const notice = { type: "system", subtype: "notification", key: "fast-mode-overage-rejected", text: "Fast mode disabled · usage credits exhausted", priority: "immediate", color: "error" };
  // As Claude Code 2.1.302 leaves it: fast mode still on in the result, and usage.speed absent or standard.
  for (const usage of [{ speed: null }, { speed: "standard" }]) {
    const h = await harness([{ target: "claude", steps: [{ emit: notice }, { reply: "answered" }] }], {}, { STUB_RESULT: JSON.stringify({ fast_mode_state: "on", usage }) });
    try {
      const r = await h.call("ask", { target: "claude", message: "q", model: "opus", speed: "fast" });
      assert.ok(r.reply, JSON.stringify(r));
      assert.match(r.warning ?? "", /fast was asked for, but Claude (ran this turn|refused fast mode for this turn's requests and ran them) at standard speed/, JSON.stringify(r));
      assert.match(r.warning, /Claude's notice: "Fast mode disabled · usage credits exhausted"/);
      assert.equal((await h.call("status", { id: r.thread_id })).speed.reported.notice, "Fast mode disabled · usage credits exhausted");
    } finally {
      await h.close();
    }
  }
});

// Review r_c03a282e of the speed work (2026-10-18): X2, X1 and C4.

test("speed: with Codex's fast mode switched off in the person's config, standard still runs, pinned, and a faster speed is refused before the thread, saying why", async () => {
  // features.fast_mode = false makes Codex 0.163.0 drop every service tier, "default" included: its thread then reports none.
  const off = { STUB_CODEX_FEATURES: JSON.stringify({ fast_mode: false }), STUB_CODEX_MODELS: BOTH_TIERS };
  for (const backend of ["app-server", "exec"]) {
    const h = await harness([], backend === "exec" ? { codex_backend: "exec" } : {}, off);
    try {
      const s = await h.call("ask", { target: "codex", message: "s" });
      assert.ok(s.reply, `${backend}: ${JSON.stringify(s)}`);
      const [st] = starts(h, "codex");
      assert.ok(st.argv.includes("features.fast_mode=true"), `${backend}: ${st.argv.join(" ")}`);
      if (backend === "app-server") assert.deepEqual(tiers(st), ["default", "default"]);
      for (const speed of ["fast", "ultrafast"]) {
        const f = await h.call("ask", { target: "codex", message: "f", speed });
        assert.match(f.error ?? "", new RegExp(`at ${speed} speed, because fast mode is turned off in Codex's own configuration \\(features\\.fast_mode = false\\)`), `${backend}: ${JSON.stringify(f)}`);
        assert.match(f.error, /pass speed: "standard"/);
      }
      assert.equal(starts(h, "codex").length, 1, "no faster turn started");
      assert.ok(!starts(h, "codex")[0].argv.join(" ").includes("features.fast_mode=false"));
    } finally {
      await h.close();
    }
  }
  // A layer that outranks relay's flags keeps it off: standard is refused with the reason, not run without its pin.
  const above = await harness([], {}, { STUB_CODEX_EFFECTIVE: JSON.stringify({ features: { plugins: false, hooks: false, fast_mode: false } }) });
  try {
    const r = await above.call("ask", { target: "codex", message: "s" });
    assert.match(r.error ?? "", /features\.fast_mode is false where relay set true/, JSON.stringify(r));
    assert.equal(starts(above, "codex").length, 0);
  } finally {
    await above.close();
  }
});

test("speed: a Codex turn that carries on a thread and names no model is checked against the thread's own model, which then runs", async () => {
  // The thread was started on gpt-old, Codex's default then; the catalog's default is now gpt-stub. Codex resumes a thread on its own model.
  const catalog = (oldTiers: Rec[], newTiers: Rec[]) => JSON.stringify([
    { id: "gpt-stub", model: "gpt-stub", displayName: "GPT-Stub", hidden: false, isDefault: true, defaultServiceTier: null, serviceTiers: newTiers },
    { id: "gpt-old", model: "gpt-old", displayName: "GPT-Old", hidden: false, isDefault: false, defaultServiceTier: null, serviceTiers: oldTiers },
  ]);
  const fast = [{ id: "priority", name: "Fast" }];
  for (const backend of ["app-server", "exec"]) {
    const h = await harness([], backend === "exec" ? { codex_backend: "exec" } : {}, { STUB_CODEX_MODELS: catalog(fast, []), STUB_CODEX_NEW_THREAD_MODEL: "gpt-old" });
    try {
      const T = (await h.call("ask", { target: "codex", message: "a" })).thread_id;
      const r = await h.call("ask", { thread_id: T, message: "b", speed: "fast" });
      assert.ok(r.reply, `${backend}: ${JSON.stringify(r)}`);
      const b = starts(h, "codex")[1];
      if (backend === "app-server") assert.deepEqual(tiers(b), ["priority", "priority"]);
      else assert.ok(b.argv.join(" ").includes("-m gpt-old"), `the exec fallback runs the model relay checked: ${b.argv.join(" ")}`);
      assert.ok(h.log().some((e) => e.event === "thread-read" && e.params?.threadId === starts(h, "codex")[0].sessionId), "the thread's model was read");
    } finally {
      await h.close();
    }
  }
  // The other way round: the thread's own model lacks the tier the default has. Refused before the turn, naming the thread's model.
  for (const backend of ["app-server", "exec"]) {
    const h = await harness([], backend === "exec" ? { codex_backend: "exec" } : {}, { STUB_CODEX_MODELS: catalog([], fast), STUB_CODEX_NEW_THREAD_MODEL: "gpt-old" });
    try {
      const T = (await h.call("ask", { target: "codex", message: "a" })).thread_id;
      const r = await h.call("ask", { thread_id: T, message: "b", speed: "fast" });
      assert.match(r.error ?? "", /fast isn't offered to this account for gpt-old/, `${backend}: ${JSON.stringify(r)}`);
      assert.equal(starts(h, "codex").length, 1, "the fast turn never started");
    } finally {
      await h.close();
    }
  }
});

test("speed: a discussion's and a review's replies and status say the speed asked for the other side, and the one a review keeps for its reconciliation", async () => {
  const h = await harness([{ target: "codex", match: "HELDREVIEW", steps: [{ awaitMark: "reviewed" }, { reply: "review" }] }], {}, { STUB_CODEX_MODELS: BOTH_TIERS });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const d = await claude.call("discuss", { topic: "t", message: "m\nCONTINUE", speed: "fast" });
    assert.deepEqual(d.speed, { requested: "fast" }, JSON.stringify(d));
    assert.deepEqual((await claude.call("status", { id: d.discussion_id })).speed, { requested: "fast" });
    const plain = await claude.call("discuss", { topic: "t2", message: "m\nCONTINUE" });
    assert.equal(plain.speed, undefined, `standard is not shown: ${JSON.stringify(plain)}`);

    const r = await claude.call("review", { target: "README.md", focus: "HELDREVIEW", speed: "fast" });
    assert.deepEqual(r.speed, { requested: "fast" }, JSON.stringify(r));
    // A speed given while the reviewer still works waits for the reconciliation's first turn: shown as next.
    const early = await claude.call("review", { review_id: r.review_id, speed: "ultrafast" });
    assert.deepEqual(early.speed, { requested: "fast", next: "ultrafast" }, JSON.stringify(early));
    assert.deepEqual((await claude.call("status", { id: r.review_id })).speed, { requested: "fast", next: "ultrafast" });
    const plainReview = await claude.call("review", { target: "README.md", focus: "HELDREVIEW" });
    assert.equal(plainReview.speed, undefined, JSON.stringify(plainReview));
    const slower = await claude.call("review", { review_id: plainReview.review_id, speed: "fast" });
    assert.deepEqual(slower.speed, { requested: "standard", next: "fast" }, JSON.stringify(slower));
    await claude.call("cancel", { id: r.review_id });
    await claude.call("cancel", { id: plainReview.review_id });
    h.mark("reviewed");
    await claude.close();
  } finally {
    await h.close();
  }
});
