// Host-side fixture wiring only: no sandbox-exec, harness or relay worker is started here.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import "./helpers.ts";
import { boundaryProbe, setBoundaryProbeForTests } from "../dist/confine/turn-probe.js";

test("ACP fixture: the slow probe reaches only the test worker and aborts before wrapping a harness", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-slow-fixture-")));
  const controls = { STUB_TEMP_ROOT: root, SLOW_PROBE_MARKER: path.join(root, "marker.json"), SLOW_PROBE_MS: "20000" };
  const saved = Object.fromEntries(Object.keys(controls).map((name) => [name, process.env[name]]));
  const originalSpawn = childProcess.spawn;
  const calls: { command: string; args: string[]; options: childProcess.SpawnOptions }[] = [];
  childProcess.spawn = ((command, args, options) => { calls.push({ command, args, options }); return {}; }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  Object.assign(process.env, controls);
  try {
    await import("./fixtures/slow-boundary-probes.mjs");
    const cli = path.resolve(import.meta.dirname, "../dist/cli.js");
    const runtime = { PATH: process.env.PATH, RELAY_ENV_SOCKET: "/synthetic/root-socket" };
    childProcess.spawn(process.execPath, [cli, "worker", "synthetic-node"], { env: runtime });
    assert.deepEqual(calls[0].options.env, { ...runtime, ...controls, STUB_TEMP_ROOT: root + path.sep,
      NODE_OPTIONS: `--import=${new URL("./fixtures/slow-boundary-probes.mjs", import.meta.url).href}` });
    for (const args of [[cli, "mcp"], ["/synthetic/other-cli", "worker"]]) {
      childProcess.spawn(process.execPath, args, { env: runtime });
      assert.deepEqual(calls.at(-1)!.options.env, runtime, "other children keep the runtime-only environment");
    }
    const command = path.join(root, "harness");
    fs.writeFileSync(command, "scratch");
    const controller = new AbortController();
    const probing = boundaryProbe()!({ wrap: () => { throw new Error("must not launch"); } } as never,
      { tmpDir: root, bridgeSocket: path.join(root, "bridge") } as never, command, [], controller.signal, runtime);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(JSON.parse(fs.readFileSync(controls.SLOW_PROBE_MARKER, "utf8")),
      { tmpDir: root, bridgeSocket: path.join(root, "bridge"), worker: process.pid });
    controller.abort();
    await assert.rejects(probing, { name: "AbortError" });
    assert.equal(calls.length, 3, "aborting the probe started no process");
  } finally {
    setBoundaryProbeForTests(null);
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
