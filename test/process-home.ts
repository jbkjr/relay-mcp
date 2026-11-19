// Import before relay modules: env-policy snapshots process.env at module evaluation time.
// Keeping this independent of relay lets in-process root authorities and their workers use the
// same disposable home as the test registry, even when helpers.ts imports relay itself.
import fs from "node:fs";
import path from "node:path";
import { removeTestNativeTempAlias } from "./native-temp-alias.ts";
import { TEST_TEMP_ROOT } from "./temp-root.ts";

export const HOME_VARS = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME", "GROK_HOME", "GROK_AUTH_PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "RELAY_HOME", "RELAY_WORKTREES", "RELAY_CONFIG"];
// Keep HOME and every fixture under the shared socket-safe temporary root.
export const TEST_HOME_PARENT = TEST_TEMP_ROOT;
const home = fs.realpathSync(fs.mkdtempSync(path.join(TEST_HOME_PARENT, "rth-")));
for (const k of HOME_VARS) delete process.env[k];
process.env.HOME = home;
process.on("exit", () => {
  removeTestNativeTempAlias(home);
  fs.rmSync(home, { recursive: true, force: true });
});
