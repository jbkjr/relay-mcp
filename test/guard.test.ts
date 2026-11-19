import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { TEST_HOME_PARENT } from "./process-home.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { harness, REAL_HOME, scratchEnv, scratchOnly } from "./helpers.ts";

// Tests never aim at real files on the machine running them: not the home folder, not installed
// programs. The guard below is what the confinement and broker tests run their probes and HOME through.

test("test guard: a path under the real home folder or an installed program's directory is refused", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-guard-")));
  try {
    assert.equal(REAL_HOME, fs.realpathSync(os.userInfo().homedir), "the real home comes from the user database, not HOME");
    assert.throws(() => scratchOnly(REAL_HOME, "HOME"), /real home folder/);
    assert.throws(() => scratchOnly(path.join(REAL_HOME, ".relay-probe"), "probe"), /real home folder/);
    assert.throws(() => scratchOnly(process.execPath, "probe"), /installed program/);
    assert.throws(() => scratchOnly(fs.realpathSync(process.execPath), "probe"), /installed program/);
    assert.throws(() => scratchOnly("/usr/bin/env", "probe"), /installed program/);
    // A scratch path that leads somewhere real through a symlink is judged by where it leads.
    fs.symlinkSync(path.dirname(process.execPath), path.join(tmp, "bin-link"));
    assert.throws(() => scratchOnly(path.join(tmp, "bin-link", "node"), "probe"), /installed program/);
    fs.symlinkSync(REAL_HOME, path.join(tmp, "home-link"));
    assert.throws(() => scratchOnly(path.join(tmp, "home-link", "not-yet"), "probe"), /real home folder/);
    // Scratch paths pass, existing or not.
    assert.equal(scratchOnly(path.join(tmp, "a", "b"), "probe"), path.join(tmp, "a", "b"));
    assert.throws(() => scratchEnv({ HOME: REAL_HOME }), /HOME/);
    assert.throws(() => scratchEnv({ HOME: path.join(tmp, "h"), CODEX_HOME: path.join(REAL_HOME, ".codex") }), /CODEX_HOME/);
    assert.throws(() => scratchEnv({ HOME: path.join(tmp, "h"), XDG_CONFIG_HOME: path.join(REAL_HOME, ".config") }), /XDG_CONFIG_HOME/);
    assert.doesNotThrow(() => scratchEnv({ HOME: path.join(tmp, "h"), PATH: process.env.PATH! }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("test guard: the test process itself has a scratch HOME, so nothing it runs sees the real one", () => {
  assert.notEqual(os.homedir(), REAL_HOME);
  assert.equal(process.env.HOME, os.homedir());
  assert.ok(os.homedir().startsWith(TEST_HOME_PARENT + path.sep), "a disposable temporary directory short enough for Unix sockets");
  assert.doesNotThrow(() => scratchEnv(process.env));
});

test("test guard: a long inherited TMPDIR is shortened for fixtures and children before socket setup", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-temp-test-")));
  const long = path.join(root, "default-macos-temp-root-with-a-long-sockaddr-un-prefix", "T");
  fs.mkdirSync(long, { recursive: true });
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import ${JSON.stringify(new URL("./process-home.ts", import.meta.url).href)};
      import fs from "node:fs";
      import net from "node:net";
      import os from "node:os";
      import path from "node:path";
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-probe-test-"));
      try {
        const dir = path.join(root, "home/.relay-t/s/relay-probe-0123456789ab");
        fs.mkdirSync(dir, { recursive: true });
        const socket = path.join(dir, "relay.sock");
        const server = net.createServer();
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
        await new Promise(resolve => server.close(resolve));
        console.log(JSON.stringify({ temp: os.tmpdir(), bytes: Buffer.byteLength(socket), inherited: process.env.TMPDIR }));
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    `], { env: { ...process.env, TMPDIR: long }, encoding: "utf8", timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const got = JSON.parse(result.stdout);
    assert.equal(got.temp, fs.realpathSync("/tmp"));
    assert.equal(got.inherited, got.temp, "spawned fixture children inherit the short root too");
    assert.ok(got.bytes <= 103, `socket path is ${got.bytes} bytes`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("test guard: a harness runs relay and its agents with a scratch HOME, and nothing of the real one", async () => {
  const h = await harness();
  try {
    const home = h.env.HOME;
    assert.ok(home && fs.statSync(home).isDirectory(), "the scratch HOME exists");
    assert.ok(home.startsWith(process.platform === "darwin" ? "/Users/Shared/rh" : fs.realpathSync(os.tmpdir()) + path.sep), "and is a disposable fixture outside the shared temp write allowance");
    assert.notEqual(home, h.home, "and is not relay's state directory");
    assert.doesNotThrow(() => scratchEnv(h.env));
    for (const k of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
      assert.ok(!h.env[k] || !h.env[k].startsWith(REAL_HOME), `${k} does not point into the real home`);
    }
    // What a launched agent sees.
    await h.call("ask", { target: "codex", message: "where is home?" });
    const start = h.starts()[0];
    assert.ok(start, "the agent ran");
    assert.equal(start.env.home, home, "the launched agent's HOME is the scratch one");
  } finally {
    await h.close();
  }
});

test("test guard: every test file loads the helpers, so that each runs with the scratch HOME", () => {
  const dir = import.meta.dirname;
  // The environment-authority fixture must capture its synthetic root before loading any relay
  // module (helpers imports config). It creates/restores HOME itself before dynamic imports.
  const missing = fs.readdirSync(dir).filter((f) => f.endsWith(".test.ts") && f !== "tool-env-consent.test.ts" && !/from "\.\/helpers\.ts"|import "\.\/helpers\.ts"/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(missing, []);
});

test("guard: the scratch sweep removes only a dead run's trees of this user's, never a live run's or a link's target", async (t) => {
  const { sweepStaleScratch } = await import("./helpers.ts");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-sweep-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const DEAD = 999_001, LIVE = 999_002;
  const alive = (pid: number) => pid === LIVE;
  const make = (name: string, owner?: number | string) => {
    const d = path.join(root, name); fs.mkdirSync(path.join(d, "home"), { recursive: true }); fs.writeFileSync(path.join(d, "home", "f"), "x");
    if (owner !== undefined) fs.writeFileSync(`${d}.owner`, `${owner}\n`);
    return d;
  };
  const dead = make("relay-test-AAAAAA", DEAD);
  const deadOther = make("relay-x1-path-EEEEEE", DEAD);
  const live = make("relay-test-BBBBBB", LIVE);
  const legacy = make("relay-test-CCCCCC");
  const mine = make("relay-test-FFFFFF", process.pid);
  const junk = make("relay-test-GGGGGG", "not-a-pid");
  const target = make("kept-target", DEAD);
  fs.symlinkSync(target, path.join(root, "relay-test-DDDDDD")); fs.writeFileSync(path.join(root, "relay-test-DDDDDD.owner"), `${DEAD}\n`);
  const linkedOwner = make("relay-test-HHHHHH");
  fs.writeFileSync(path.join(root, "owner-elsewhere"), `${DEAD}\n`); fs.symlinkSync(path.join(root, "owner-elsewhere"), `${linkedOwner}.owner`);
  assert.deepEqual(sweepStaleScratch(root, { uid: process.getuid!() + 1, alive }), [], "another user's trees stay");
  assert.deepEqual(sweepStaleScratch(root, { alive }).sort(), [dead, deadOther].sort());
  assert.ok(!fs.existsSync(`${dead}.owner`));
  for (const d of [live, legacy, mine, junk, target, path.join(target, "home", "f"), linkedOwner]) assert.ok(fs.existsSync(d), d);
  assert.ok(fs.lstatSync(path.join(root, "relay-test-DDDDDD")).isSymbolicLink());
  assert.deepEqual(sweepStaleScratch(path.join(root, "missing"), { alive }), []);
});
