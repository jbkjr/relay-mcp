import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startCodexAppTurn } from "../dist/backends/codex-app.js";
import { codexPermissions } from "../dist/backends/codex.js";
import { prepareCodexHome } from "../dist/backends/codex-pin.js";
import { withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun, db } from "../dist/core/db.js";
import { assertNeverLaunchCurrent, checkpointNever, readNeverFloor } from "../dist/core/never-checkpoint.js";
import { targetDef } from "../dist/targets/index.js";
import type { TurnHandle, TurnSpec } from "../dist/backends/types.js";

for (const change of ["interface", "floor", "link-local", "none"] as const) {
  test(`non-overlay Codex app-server rechecks the never floor after preparation (${change})`, async (t) => {
    closeDbForTests();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-launch-")));
    const registry = path.join(root, "registry");
    const old = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
    process.env.RELAY_HOME = registry;
    process.env.RELAY_CONFIG = path.join(root, "config.json");
    let handle: TurnHandle | undefined;
    t.after(async () => {
      // cancel() can read the registry through watch.look(), even after handle.done. Keep this
      // case's env and DB alive until cancellation finishes, then close before restoring env.
      try {
        try { await handle?.cancel(); }
        finally { await handle?.done; }
      } finally {
        closeDbForTests();
        for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    const address = change === "link-local" ? "fe80::2:3:4:5" : "203.0.113.9";
    const iface = { address, family: address.includes(":") ? "IPv6" : "IPv4", netmask: "", mac: "00:00:00:00:00:00", internal: false, cidr: null };
    const prepared = path.join(root, "prepared");
    const requests = path.join(root, "requests.jsonl");
    const bin = path.join(root, "codex");
    // Model-free stdio fixture. config/read is asynchronous preparation before the final gate.
    // A sibling checkpoint can also retain an address that is gone by that gate (floor case).
    fs.writeFileSync(bin, `#!${process.execPath}
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(m.method) + "\\n");
  let result = {};
  if (m.method === "config/read") {
    assert.equal(process.env.RELAY_HOME, ${JSON.stringify(registry)}, "fixture uses this case's RELAY_HOME");
    const { db, getRun } = await import(${JSON.stringify(new URL("../dist/core/db.js", import.meta.url).href)});
    assert.equal(db().prepare("PRAGMA database_list").get().file, ${JSON.stringify(path.join(registry, "relay.db"))}, "fixture opens this case's registry");
    assert.ok(getRun(process.env.LAUNCH_RUN), "fixture sees the run createRun stored in this registry");
    if (${JSON.stringify(change)} === "floor") {
      const real = os.networkInterfaces;
      os.networkInterfaces = () => ({ en9: [${JSON.stringify(iface)}] });
      const { checkpointNever } = await import(${JSON.stringify(new URL("../dist/core/never-checkpoint.js", import.meta.url).href)});
      checkpointNever(process.env.LAUNCH_RUN, "launch");
      os.networkInterfaces = real;
    }
    fs.writeFileSync(${JSON.stringify(prepared)}, "");
    result = { config: JSON.parse(process.env.LAUNCH_CONFIG) };
  }
  if (m.method === "configRequirements/read") result = { requirements: null };
  if (m.method === "thread/start") result = { thread: { id: "thread" }, activePermissionProfile: { id: "relay" }, runtimeWorkspaceRoots: [m.params.cwd], sandbox: { type: "readOnly", networkAccess: false } };
  if (m.method === "turn/start") result = { turn: { id: "turn" } };
  send({ id: m.id, result });
  if (m.method === "turn/start") send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
}
`, { mode: 0o755 });
    const config = withDefaults({
      targets: { codex: { bin, pinned: false, home: path.join(root, "codex-home") } },
      // These network gate fixtures never access a keychain, including its protected metadata.
      never: { override_builtin: [{ id: "credentials.keychain", acknowledge: "REMOVE BUILT-IN NEVER credentials.keychain", reason: "model-free network launch fixture" }] },
    });
    fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(config));
    prepareCodexHome(config);
    t.mock.method(os, "networkInterfaces", () =>
      fs.existsSync(prepared) && (change === "interface" || change === "link-local") ? { en9: [iface] } : {});
    assert.equal(db().prepare("PRAGMA database_list").get()!.file, path.join(registry, "relay.db"), "createRun must use this case's RELAY_HOME");
    const run = createRun(root, config, "test-root");
    const neverPolicy = checkpointNever(run, "launch");
    assert.ok(!neverPolicy.localAddresses.includes(address));
    let checks = 0;
    const checkEnvironment = () => {
      checks++;
      checkpointNever(run, "launch");
      assertNeverLaunchCurrent(run, neverPolicy);
    };
    // The backend's early environment check passes; the change happens after it.
    checkEnvironment();
    const permissions = codexPermissions({ access: "read", config, neverPolicy }, { dangerous: false, network: false, roots: [], codexHome: config.targets.codex.home });
    const spec = {
      target: targetDef("codex"), config, access: "read", cwd: root, dir: root, prompt: "test",
      logPath: path.join(root, "agent.log"), relay: null, markers: { runId: run, nodeId: "j_test", depth: 1 }, neverPolicy, checkEnvironment,
    } as TurnSpec;
    assert.equal(spec.overlay, undefined);
    handle = startCodexAppTurn(spec, { off: [], c: [], expect: { permissions, relay: null, relayOnly: false, accountLogin: false } }, {
      HOME: os.homedir(), PATH: process.env.PATH, RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG,
      LAUNCH_RUN: run, LAUNCH_CONFIG: JSON.stringify({ approvals_reviewer: "user", default_permissions: permissions.id, permissions: { relay: permissions.profile } }),
    });
    const result = await handle.done;
    assert.throws(() => process.kill(handle.pid, 0), /ESRCH/, "the existing cleanup stopped the app server");
    // config/read writes this after its sibling checkpoint, before replying. X2 needs that
    // preparation happened and turn/start was withheld, not an intermediate thread/start.
    assert.ok(fs.existsSync(prepared), "config/read preparation completed before the launch check");
    const methods = fs.readFileSync(requests, "utf8").trim().split("\n").map(s => JSON.parse(s));
    if (change === "interface") assert.ok(methods.includes("thread/start"), "the fresh interface observation runs at the final gate");
    assert.equal(checks, 2, "the final check runs without an overlay");
    if (change === "interface" || change === "floor") {
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.match(result.error!, /this Mac gained 203\.0\.113\.9 after the launch plan was built, so nothing was started; send the turn again/);
      assert.equal(result.delivered, false);
      assert.ok(!methods.includes("turn/start"), "the prompt never reached agent work");
      assert.ok(readNeverFloor(run)!.localAddresses.includes(address), "the observed addition remains durable");
    } else {
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.ok(methods.includes("turn/start"));
      if (change === "link-local") assert.ok(readNeverFloor(run)!.localAddresses.includes(address));
    }
    assert.equal(readNeverFloor(run)!.hash, neverPolicy.hash, "addresses remain outside the policy hash");
    assert.equal(result.survivors, undefined);
  });
}
