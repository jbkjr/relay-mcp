// Safe before synthetic root capture: only the temporary root changes, never HOME or
// host identity. Tests and their children use os.tmpdir(), so normalize TMPDIR once.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const inherited = fs.realpathSync(os.tmpdir());
// The deepest fixture socket: macOS allows 103 bytes, excluding the terminating NUL.
const socketExample = path.join(inherited, "relay-probe-test-XXXXXX", "home/.relay-t/s/relay-probe-XXXXXXXXXXXX/relay.sock");
export const TEST_TEMP_ROOT = Buffer.byteLength(socketExample) <= 103 ? inherited : fs.realpathSync("/tmp");
process.env.TMPDIR = TEST_TEMP_ROOT;
