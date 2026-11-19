import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { startAcpTurn, genericApproval } from "../dist/backends/acp.js";
import { prepareCodexHome } from "../dist/backends/codex-pin.js";
import { streamTurn } from "../dist/backends/stream.js";
import type { TurnSpec } from "../dist/backends/types.js";
import { seatbelt } from "../dist/confine/seatbelt.js";
import { setBoundaryProbeForTests } from "../dist/confine/turn-probe.js";
import { withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun } from "../dist/core/db.js";
import { assertNeverLaunchCurrent, checkpointNever, readNeverFloor } from "../dist/core/never-checkpoint.js";
import { targetDef } from "../dist/targets/index.js";

type Change = "interface" | "floor" | "link-local" | "none";
const stale = /this Mac gained 203\.0\.113\.9 after the launch plan was built, so nothing was started; send the turn again/;

function fixture(t: TestContext, target: "claude" | "codex" | "gemini", change: Change) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-launch-")));
  const old = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = path.join(root, "registry");
  process.env.RELAY_CONFIG = path.join(root, "config.json");
  t.after(() => {
    closeDbForTests();
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const requests = path.join(root, "requests.jsonl"), bin = path.join(root, "harness");
  // No model, login, tools or listeners: stream fixtures record spawn; ACP records each request.
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
const record = method => fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(method) + "\\n");
if (process.argv.includes("--acp")) {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    record(m.method);
    let result = {};
    if (m.method === "initialize") result = { protocolVersion: 1 };
    if (m.method === "session/new") result = { sessionId: "session", models: { currentModelId: "gemini-test-model" } };
    if (m.method === "session/prompt") result = { stopReason: "end_turn" };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
} else {
  record("spawn");
  for await (const _ of process.stdin) {}
  process.stdout.write(JSON.stringify({ type: "done" }) + "\\n");
}
`, { mode: 0o755 });
  const config = withDefaults({
    child_network: true,
    codex_backend: "exec",
    targets: {
      codex: { pinned: false, home: path.join(root, "codex-home"), ...(target === "codex" ? { bin } : {}) },
      ...(target !== "codex" ? { [target]: { bin } } : {}),
    },
    // Network gate fixtures need no access to Keychain metadata, including on restricted hosts.
    never: { override_builtin: [{ id: "credentials.keychain", acknowledge: "REMOVE BUILT-IN NEVER credentials.keychain", reason: "model-free network launch fixture" }] },
  });
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(config));
  prepareCodexHome(config);
  const address = change === "link-local" ? "fe80::2:3:4:5" : "203.0.113.9";
  let observed = false;
  t.mock.method(os, "networkInterfaces", () => observed ? { en9: [{ address, family: address.includes(":") ? "IPv6" : "IPv4", netmask: "", mac: "00:00:00:00:00:00", internal: false, cidr: null }] } : {});
  const run = createRun(root, config, "test-root");
  const neverPolicy = checkpointNever(run, "launch");
  let checks = 0;
  const checkEnvironment = () => {
    checks++;
    checkpointNever(run, "launch");
    assertNeverLaunchCurrent(run, neverPolicy);
  };
  const prepare = () => {
    observed = change !== "none";
    if (change === "floor") {
      checkpointNever(run, "launch"); // Another observer keeps the address while preparing.
      observed = false; // Gone from current interfaces, but still denied by the durable floor.
    }
  };
  const spec = {
    target: targetDef(target), config, access: "read", cwd: root, dir: root, prompt: "test",
    logPath: path.join(root, "agent.log"), relay: null, markers: { runId: run, nodeId: "j_test", depth: 1 },
    neverPolicy, checkEnvironment, environment: { HOME: os.homedir(), PATH: process.env.PATH },
  } as TurnSpec;
  return {
    root, bin, spec, checkEnvironment, prepare, refused: change === "interface" || change === "floor",
    methods: (): string[] => fs.existsSync(requests) ? fs.readFileSync(requests, "utf8").trim().split("\n").map(s => JSON.parse(s)) : [],
    checked() {
      assert.equal(checks, 2, "the launch gate repeats the early check after preparation");
      const floor = readNeverFloor(run)!;
      assert.equal(floor.hash, neverPolicy.hash, "address observations remain outside the hash");
      if (change !== "none") assert.ok(floor.localAddresses.includes(address));
    },
  };
}

for (const target of ["claude", "codex"] as const) for (const change of ["interface", "floor", "link-local", "none"] as const) {
  test(`${target} stream launch rechecks the never floor before spawn (${change})`, async (t) => {
    const f = fixture(t, target, change);
    f.checkEnvironment();
    await Promise.resolve().then(f.prepare); // Asynchronous backend preparation after capture.
    let logFd: number | undefined;
    const open = fs.openSync;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args);
      if (args[0] === f.spec.logPath) logFd = fd;
      return fd;
    });
    const launch = () => streamTurn(f.spec, {
      invocation: { command: f.bin, args: [], env: f.spec.environment! },
      onEvent: (event, state) => { if (event.type === "done") state.completed = true; },
    });
    if (f.refused) {
      assert.throws(launch, stale);
      assert.deepEqual(f.methods(), [], "the rejected plan spawned no agent");
    } else {
      const handle = launch();
      t.after(async () => { await handle.cancel(); });
      const result = await handle.done;
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.deepEqual(f.methods(), ["spawn"]);
      assert.throws(() => process.kill(handle.pid, 0), /ESRCH/);
      assert.equal(result.survivors, undefined);
    }
    assert.notEqual(logFd, undefined);
    assert.throws(() => fs.fstatSync(logFd!), /EBADF/, "the agent log closes even when the final gate refuses");
    f.checked();
  });
}

for (const change of ["interface", "floor", "link-local", "none"] as const) {
  test(`ACP rechecks the never floor before session/prompt (${change})`, { skip: process.platform !== "darwin" }, async (t) => {
    const f = fixture(t, "gemini", change);
    // Host-side protocol test: replace confinement through the existing probe seam. No real
    // harness, sandbox-exec or boundary probe runs; keep the actual launch gate and cleanup.
    t.mock.method(seatbelt, "unavailable", () => null);
    t.mock.method(seatbelt, "confined", () => true);
    t.mock.method(seatbelt, "wrap", (_policy, command, args) => ({ command, args, env: {} }));
    let tmpDir: string | undefined;
    setBoundaryProbeForTests(async (mechanism, policy, command, args) => {
      tmpDir = policy.tmpDir;
      return { launch: mechanism.wrap(policy, command, args), probes: { results: [], ms: 0, profile: "fixture", relay: "fixture", os: "fixture" } };
    });
    t.after(() => setBoundaryProbeForTests(null));
    let cleaned = 0;
    const handle = await startAcpTurn(f.spec, {
      args: () => ["--acp"], scrub: () => false,
      login: { how: "model-free fixture", verify: () => null }, normalizeApproval: genericApproval,
      prepareState: () => ({ stateDirs: [], keychain: false, beforePrompt: () => { f.prepare(); }, cleanup: () => { cleaned++; } }),
    });
    t.after(async () => { await handle.cancel(); });
    const result = await handle.done;
    assert.ok(f.methods().includes("session/new"), "session preparation completed before the gate");
    if (f.refused) {
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.match(result.error!, stale);
      assert.equal(result.delivered, false);
      assert.ok(!f.methods().includes("session/prompt"), "no agent work was sent");
    } else {
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.ok(f.methods().includes("session/prompt"));
    }
    f.checked();
    assert.equal(cleaned, 1, "the existing prepared-state cleanup ran once");
    assert.ok(tmpDir && !fs.existsSync(tmpDir), "the launch's private directory was removed");
    assert.throws(() => process.kill(handle.pid, 0), /ESRCH/, "the existing cleanup stopped the ACP server");
    assert.equal(result.survivors, undefined);
  });
}
