import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { TurnResult, TurnSpec } from "../dist/backends/types.js";

// Keep this file's own disposable HOME as well as helpers' process-wide isolation. Set it
// before loading the backend; each cleanup fixture temporarily replaces it with another home.
const processHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-cleanup-home-")));
for (const name of ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME", "GROK_HOME", "GROK_AUTH_PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "RELAY_HOME", "RELAY_WORKTREES", "RELAY_CONFIG"]) delete process.env[name];
process.env.HOME = processHome;
process.on("exit", () => fs.rmSync(processHome, { recursive: true, force: true }));
const { nativeTemp } = await import("../dist/backends/native-temp.js");
const { withDefaults } = await import("../dist/core/config.js");

const result: TurnResult = { status: "ok", finalMessage: "finished", exitCode: 0 };

function fixture(t: TestContext) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-native-temp-")));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    t.mock.restoreAll();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const logPath = path.join(home, "agent.log");
  const spec = { target: { id: "codex" }, config: withDefaults({}), logPath } as TurnSpec;
  const handle = (done = Promise.resolve(result)) => ({ pid: 0, pgid: 0, startedAt: null, done, cancel: async () => {} });
  const blockCleanup = (dir: string) => {
    const rm = fs.rmSync;
    return t.mock.method(fs, "rmSync", (p: fs.PathLike, options?: fs.RmOptions) => {
      if (String(p) !== dir) return rm(p, options);
      assert.deepEqual(options, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      throw Object.assign(new Error("Directory not empty"), { code: "ENOTEMPTY" });
    });
  };
  return { home, spec, logPath, handle, blockCleanup };
}

test("native temp cleanup recursively removes nested files and never follows an escaping symlink", async (t) => {
  const f = fixture(t);
  const outside = path.join(f.home, "outside");
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "untouched");
  let temp = "";
  const h = await nativeTemp(f.spec, async (dir) => {
    temp = dir;
    fs.mkdirSync(path.join(dir, "nested", "deeper"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nested", "deeper", "file"), "x");
    fs.symlinkSync(outside, path.join(dir, "escape"));
    return f.handle();
  });
  assert.deepEqual(await h.done, result);
  assert.equal(fs.existsSync(temp), false);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "untouched");
});

test("native temp cleanup asks for bounded retries", async (t) => {
  const f = fixture(t), rm = fs.rmSync;
  let removed = false;
  const h = await nativeTemp(f.spec, async (dir) => {
    t.mock.method(fs, "rmSync", (p: fs.PathLike, options?: fs.RmOptions) => {
      if (String(p) === dir) {
        assert.deepEqual(options, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        removed = true;
      }
      return rm(p, options);
    });
    return f.handle();
  });
  assert.deepEqual(await h.done, result);
  assert.ok(removed);
});

for (const status of ["ok", "failed", "interrupted"] as const) {
  test(`native temp cleanup failure preserves the ${status} outcome and reports the leftover in result and log`, async (t) => {
    const f = fixture(t);
    let temp = "";
    const original = { ...result, status, warnings: ["earlier warning"] };
    const h = await nativeTemp(f.spec, async (dir) => {
      temp = dir; f.blockCleanup(dir);
      return f.handle(Promise.resolve(original));
    });
    const done = await h.done;
    assert.equal(done.status, status);
    assert.equal(done.finalMessage, original.finalMessage);
    assert.equal(done.warnings?.[0], "earlier warning");
    assert.ok(done.warnings?.[1].includes(temp));
    assert.match(done.warnings![1], /could not remove.*Directory not empty/);
    assert.ok(fs.existsSync(temp));
    assert.ok(fs.readFileSync(f.logPath, "utf8").includes(done.warnings![1]));
    await assert.doesNotReject(h.cancel());
  });
}

test("native temp cleanup cannot mask a launch failure", async (t) => {
  const f = fixture(t);
  await assert.rejects(nativeTemp(f.spec, async (dir) => {
    f.blockCleanup(dir);
    throw new Error("launch failed");
  }), /launch failed.*could not remove native turn's private temporary directory/);
  assert.match(fs.readFileSync(f.logPath, "utf8"), /could not remove/);
});

test("native temp cleanup cannot mask a rejected backend result", async (t) => {
  const f = fixture(t);
  const h = await nativeTemp(f.spec, async (dir) => {
    f.blockCleanup(dir);
    return f.handle(Promise.reject(new Error("backend failed")));
  });
  await assert.rejects(h.done, /backend failed.*could not remove native turn's private temporary directory/);
});

test("native temp cleanup reports a log write failure without rejecting the turn", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.logPath);
  const h = await nativeTemp(f.spec, async (dir) => { f.blockCleanup(dir); return f.handle(); });
  const done = await h.done;
  assert.equal(done.status, "ok");
  assert.equal(done.warnings?.length, 2);
  assert.match(done.warnings![1], /agent\.log/);
});
