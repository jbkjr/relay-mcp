// Test-only preload (node --import, through NODE_OPTIONS in a test harness's environment): stands
// in relay's real per-turn boundary probes (prepareLaunch). Production relay never loads this file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareLaunch } from "../../dist/confine/index.js";
import { setBoundaryProbeForTests } from "../../dist/confine/turn-probe.js";

// Relay's trusted servers use their own stable TMPDIR; the fixture binaries still live
// under the test runner's scratch temp root, including when a grandchild is resumed.
const TMP = fs.realpathSync(process.env.STUB_TEMP_ROOT ?? os.tmpdir()) + path.sep;

setBoundaryProbeForTests(async (mechanism, policy, command, args, signal, environment) => {
  // A probe that escapes writes beside the harness binary: tests launch only scratch copies of their stubs.
  if (!fs.realpathSync(command).startsWith(TMP)) throw new Error(`test guard: the harness ${command} is not a scratch file, and the boundary probes would aim beside it`);
  return prepareLaunch(mechanism, policy, command, args, signal, environment);
});
