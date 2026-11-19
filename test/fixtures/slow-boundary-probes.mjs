// Test-only preload (node --import): relay's real per-turn boundary probes, stood in as in
// boundary-probes.mjs, but first recording what the turn's launch has made (its temp dir and bridge
// socket) in $SLOW_PROBE_MARKER and waiting $SLOW_PROBE_MS, or until the worker's stop aborts it.
// For the test of a stop while an ACP turn is starting (consolidation-confine.md E18).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { prepareLaunch } from "../../dist/confine/index.js";
import { setBoundaryProbeForTests } from "../../dist/confine/turn-probe.js";

const TMP = fs.realpathSync(process.env.STUB_TEMP_ROOT ?? os.tmpdir()) + path.sep;

// W9 intentionally gives workers no NODE_OPTIONS or standing environment passes. Install this
// test's probe in its worker explicitly, only from this host-side preload; production keeps that
// boundary. The scratch marker/timing controls belong to the fixture, never the harness.
const spawn = childProcess.spawn;
const cli = path.resolve(import.meta.dirname, "../../dist/cli.js");
childProcess.spawn = function (command, args, options) {
  if (command === process.execPath && args?.[0] === cli && args[1] === "worker") {
    options = { ...options, env: { ...options?.env,
      NODE_OPTIONS: `--import=${import.meta.url}`, STUB_TEMP_ROOT: TMP,
      SLOW_PROBE_MARKER: process.env.SLOW_PROBE_MARKER, SLOW_PROBE_MS: process.env.SLOW_PROBE_MS,
    } };
  }
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();

setBoundaryProbeForTests(async (mechanism, policy, command, args, signal, environment) => {
  if (!fs.realpathSync(command).startsWith(TMP)) throw new Error(`test guard: the harness ${command} is not a scratch file, and the boundary probes would aim beside it`);
  fs.writeFileSync(process.env.SLOW_PROBE_MARKER, JSON.stringify({ tmpDir: policy.tmpDir, bridgeSocket: policy.bridgeSocket ?? null, worker: process.pid }));
  await sleep(Number(process.env.SLOW_PROBE_MS ?? 20000), undefined, signal ? { signal } : undefined);
  return prepareLaunch(mechanism, policy, command, args, signal, environment);
});
