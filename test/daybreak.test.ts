import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { harness, until, type Harness } from "./helpers.ts";
import { validateConfig, withDefaults } from "../dist/core/config.js";
import { daybreakCatalog, daybreakDecision, daybreakDoctor } from "../dist/backends/codex-daybreak.js";
import { codexFlags } from "../dist/backends/codex.js";
import { RELAY_CODEX_HOME_MARKER } from "../dist/backends/codex-pin.js";
import { targetDef } from "../dist/targets/index.js";

const model = (slug: string, cyber: string[] = ["standard", "daybreak_blue"]) => ({ slug, available_access_programs: { cyber } });
const putCatalog = (h: Harness, models = [model("gpt-eligible"), model("gpt-ineligible", ["standard"])]) => {
  const dir = path.join(h.env.HOME, ".local/share/relay-codex-home");
  fs.mkdirSync(dir, { recursive: true });
  // Relay's own home (as install makes it), where Codex keeps its model cache.
  fs.writeFileSync(path.join(dir, RELAY_CODEX_HOME_MARKER), "");
  fs.writeFileSync(path.join(dir, "models_cache.json"), JSON.stringify({ models }));
};
const codexStarts = (h: Harness) => h.starts().filter((s) => s.target === "codex");
const skipped = /Daybreak was requested, but .*without Daybreak/;

test("Daybreak: only targets.codex.daybreak accepts a boolean in config; unset preserves native policy", () => {
  assert.equal(withDefaults({}).targets.codex.daybreak, undefined);
  for (const daybreak of [true, false]) assert.equal(withDefaults(validateConfig({ targets: { codex: { daybreak } } }, "test")).targets.codex.daybreak, daybreak);
  for (const raw of [{ daybreak: true }, { targets: { claude: { daybreak: true } } }, { targets: { codex: { daybreak: "true" } } }, { targets: { codex: { daybreak: { enabled: true } } } }]) {
    assert.throws(() => validateConfig(raw, "test"), /daybreak/);
  }
});

test("Daybreak: unset flags make no version spawn or policy override on either backend, initial or resume", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rdb-"));
  const bin = path.join(tmp, "codex-version");
  const calls = path.join(tmp, "calls.json");
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+"\\n"); console.log("codex-cli 0.163.0");\n`, { mode: 0o755 });
  try {
    for (const backend of ["app-server", "exec"] as const) for (const sessionId of [undefined, "saved-thread"]) {
      const config = withDefaults({ codex_backend: backend, targets: { codex: { bin } } });
      const spec = { config, target: targetDef("codex"), prompt: "p", cwd: tmp, dir: tmp, logPath: path.join(tmp, "log"), access: "read", relay: null, markers: { runId: "r", nodeId: "j", depth: 1 }, sessionId, model: "gpt-eligible" };
      const env = { HOME: tmp, CODEX_HOME: path.join(tmp, "codex") };
      const unset = codexFlags(spec as never, [], env);
      assert.equal(fs.existsSync(calls), false, "unset must not spawn --version");
      assert.equal(unset.expect.daybreak, undefined);
      assert.equal(unset.note, undefined);
      assert.ok(unset.c.every((v: string) => !v.includes("daybreak") && !v.startsWith("model=")));
    }
    const spec = { config: withDefaults({ targets: { codex: { bin, daybreak: false } } }), target: targetDef("codex"), prompt: "p", cwd: tmp, dir: tmp, logPath: path.join(tmp, "log"), access: "read", relay: null, markers: { runId: "r", nodeId: "j", depth: 1 } };
    const off = codexFlags(spec as never, [], { HOME: tmp, CODEX_HOME: path.join(tmp, "codex") });
    assert.equal(fs.readFileSync(calls, "utf8"), '["--version"]\n', "an explicit setting reads the version once");
    assert.equal(off.expect.daybreak, false);
    assert.ok(off.c.includes("daybreak=false"));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("Daybreak: exact catalog metadata, missing or malformed files, duplicates, unknown models and version gates", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rdb-"));
  const env = { CODEX_HOME: tmp };
  try {
    assert.deepEqual(daybreakCatalog(env).models, []);
    assert.match(daybreakCatalog(env).problem!, /missing or unreadable/);
    fs.writeFileSync(path.join(tmp, "models_cache.json"), "not json");
    assert.deepEqual(daybreakCatalog(env).models, []);
    fs.writeFileSync(path.join(tmp, "models_cache.json"), JSON.stringify({ models: [model("a"), model("b", ["standard"]), model("red", ["daybreak_red"]), { slug: "unknown" }, model("duplicate"), model("duplicate", ["standard"]), null] }));
    const catalog = daybreakCatalog(env);
    assert.deepEqual(daybreakDecision(undefined, "a", [0, 163, 0], catalog), { enabled: false, explicit: false });
    assert.deepEqual(catalog.models, ["a"]);
    assert.equal(daybreakDecision(true, "a", [0, 163, 0], catalog).enabled, true);
    assert.equal(daybreakDecision(true, "a", [1, 0, 0], catalog).enabled, true);
    for (const m of [undefined, "b", "a-latest", "unknown", "red", "duplicate"]) {
      const d = daybreakDecision(true, m, [0, 163, 0], catalog);
      assert.equal(d.enabled, false);
      assert.match(d.note!, skipped);
    }
    assert.equal(daybreakDecision(false, "a", [0, 163, 0], catalog).note, undefined);
    const old = daybreakDecision(true, "a", [0, 162, 1], catalog);
    assert.equal(old.explicit, false);
    assert.match(old.note!, /automatically.*no effect/);
    assert.equal(daybreakDecision(true, "a", null, catalog).explicit, false);
    assert.match(daybreakDoctor(true, [0, 163, 0], env), /daybreak on; Codex 0\.163\.0; eligible models: a /);
    assert.match(daybreakDoctor(false, [0, 163, 0], env), /daybreak off/);
    assert.equal(daybreakDoctor(undefined, [0, 163, 0], env), "targets.codex.daybreak not set: Codex's own configuration decides");
    assert.match(daybreakDoctor(true, [0, 162, 1], env), /automatic.*key has no effect/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

for (const backend of ["app-server", "exec"]) {
  test(`Daybreak: ${backend} flags and per-turn selection on initial/resumed turns, catalog re-read and safe skip`, async () => {
    const h = await harness([], { codex_backend: backend, targets: { codex: { daybreak: true, default_model: "gpt-eligible" } } });
    try {
      putCatalog(h);
      const a = await h.call("ask", { target: "codex", message: "first" });
      assert.ok(a.reply, JSON.stringify(a));
      const b = await h.call("ask", { thread_id: a.thread_id, message: "resume" });
      assert.ok(b.reply, JSON.stringify(b));
      const starts = codexStarts(h);
      assert.equal(starts.length, 2);
      for (const s of starts) {
        assert.ok(s.argv.includes("daybreak=true"), s.argv.join(" "));
        assert.ok(s.argv.includes("features.cli_daybreak=true"));
        assert.ok(s.argv.includes('model="gpt-eligible"'), "server config pins the eligible model before thread/start");
        if (backend === "app-server") {
          assert.equal(s.cyberAccessProgram, "daybreakBlue");
          assert.equal(s.thread.config.daybreak, true);
        }
      }
      assert.equal(starts[0].resumed, false);
      assert.equal(starts[1].resumed, true);
      putCatalog(h, [model("gpt-eligible", ["standard"])]);
      const c = await h.call("ask", { thread_id: a.thread_id, message: "resume without eligibility" });
      assert.ok(c.reply, JSON.stringify(c));
      assert.ok(c.notes.some((n: string) => skipped.test(n)), JSON.stringify(c));
      assert.equal(c.warning, undefined, "a plain note does not become a process warning or an error");
      const last = codexStarts(h).at(-1)!;
      assert.ok(last.argv.includes("daybreak=false"));
      if (backend === "app-server") assert.equal(last.cyberAccessProgram, "standard");
      const status = await h.call("status", { id: a.thread_id });
      assert.deepEqual(status.notes, c.notes);
      assert.deepEqual((await h.call("result", { job_id: a.thread_id })).notes, c.notes);
    } finally { await h.close(); }
  });

  test(`Daybreak: ${backend} unknown model and missing catalog skip; explicit false pins off`, async () => {
    const h = await harness([], { codex_backend: backend, targets: { codex: { daybreak: true } } });
    try {
      putCatalog(h);
      const unknown = await h.call("ask", { target: "codex", message: "CLI chooses" });
      assert.ok(unknown.reply, JSON.stringify(unknown));
      assert.match(unknown.notes[0], /cannot determine the turn's model/);
      fs.unlinkSync(path.join(h.env.HOME, ".local/share/relay-codex-home", "models_cache.json"));
      const missing = await h.call("ask", { target: "codex", model: "gpt-eligible", message: "no cache" });
      assert.match(missing.notes[0], /missing or unreadable/);
      assert.ok(codexStarts(h).every((s) => s.argv.includes("daybreak=false")));
    } finally { await h.close(); }
    const off = await harness([], { codex_backend: backend, targets: { codex: { daybreak: false } } });
    try {
      putCatalog(off);
      await off.call("ask", { target: "codex", message: "off", model: "gpt-eligible" });
      const s = codexStarts(off)[0];
      assert.ok(s.argv.includes("daybreak=false"));
      if (backend === "app-server") assert.equal(s.cyberAccessProgram, "standard");
    } finally { await off.close(); }
  });
}

test("Daybreak: old CLI gets no new flags or per-turn field, even with allow_untested", async () => {
  for (const backend of ["app-server", "exec"]) {
    const h = await harness([], { codex_backend: backend, allow_untested: true, targets: { codex: { daybreak: true } } }, { STUB_VERSION: "codex-cli 0.162.1" });
    try {
      const r = await h.call("ask", { target: "codex", message: "old" });
      assert.ok(r.reply, JSON.stringify(r));
      assert.match(r.notes[0], /automatically.*no effect/);
      assert.ok(codexStarts(h)[0].argv.every((a: string) => !a.includes("daybreak")));
      assert.ok(codexStarts(h)[0].cyberAccessProgram == null);
    } finally { await h.close(); }
  }
});

test("Daybreak: a stale cache never overrides the current server's ineligible, absent or unavailable catalog", async () => {
  for (const backend of ["app-server", "exec"]) for (const live of [
    { STUB_CODEX_MODELS: JSON.stringify([{ id: "gpt-eligible", model: "gpt-eligible", availableAccessPrograms: { cyber: ["standard"] } }]) },
    { STUB_CODEX_MODELS: "[]" },
    { STUB_CODEX_MODEL_LIST_ERROR: "discovery unavailable" },
  ]) {
    const h = await harness([], { codex_backend: backend, targets: { codex: { daybreak: true, default_model: "gpt-eligible" } } }, live);
    try {
      putCatalog(h);
      const r = await h.call("ask", { target: "codex", message: "stale cache" });
      assert.ok(r.reply, JSON.stringify(r));
      assert.match(r.notes[0], /current catalog does not confirm/);
      const s = codexStarts(h)[0];
      if (backend === "exec") assert.ok(s.argv.includes("daybreak=false"));
      else {
        assert.equal(s.thread.config.daybreak, false);
        assert.equal(s.cyberAccessProgram, "standard");
      }
    } finally { await h.close(); }
  }
});

test("Daybreak: delegate, discuss and review expose skips as plain notes", async () => {
  const h = await harness([], { targets: { codex: { daybreak: true, default_model: "gpt-ineligible" } } });
  try {
    putCatalog(h);
    const job = await h.call("delegate", { target: "codex", task: "read", mode: "read", background: false });
    assert.match(job.result.notes[0], skipped);
    assert.equal(job.result.warnings, undefined);
    const discussion = await h.call("discuss", { target: "codex", topic: "a topic", message: "a message" });
    assert.match(discussion.notes[0], skipped);
    const review = await h.call("review", { reviewer: "codex", target: "README.md" });
    await until(async () => !["queued", "running"].includes((await h.call("status", { id: review.reviewer_job })).status));
    const status = await h.call("status", { id: review.review_id });
    assert.match(status.notes[0], skipped);
    const done = await h.call("review", { review_id: review.review_id, skip_own: true });
    assert.match(done.notes[0], skipped);
  } finally { await h.close(); }
});

test("Daybreak: tool arguments and grants cannot change the person's policy, including from a launched agent", async () => {
  const h = await harness();
  try {
    for (const extra of [{ daybreak: true }, { daybreak: false }, { grant: { daybreak: true } }]) {
      const r = await h.call("ask", { target: "codex", message: "injection", ...extra });
      assert.ok(r.reply, JSON.stringify(r));
      assert.equal(r.notes, undefined);
      const start = codexStarts(h).at(-1)!;
      assert.ok(start.argv.every((a: string) => !a.includes("daybreak")));
      assert.equal(start.cyberAccessProgram, null);
      assert.equal(start.thread.config, undefined);
    }
    const parent = await h.call("delegate", { target: "claude", task: "parent", mode: "read", background: false });
    const child = await h.instance(await h.childOf(parent.job_id));
    const r = await child.call("ask", { target: "codex", message: "injection", daybreak: true });
    assert.ok(r.reply, JSON.stringify(r));
    assert.ok(codexStarts(h).at(-1)!.argv.every((a: string) => !a.includes("daybreak")));
  } finally { await h.close(); }
});
