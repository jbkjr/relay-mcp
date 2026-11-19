// Test-only: starts a denial stream with the tag given, prints "ready" once it has attached, and then
// waits forever, so a test can SIGKILL this process and check the stream does not outlive it.
import { streamSandboxDenials } from "../../dist/confine/diagnostics.js";
const s = streamSandboxDenials(process.argv[2], () => {});
await s.ready;
process.stdout.write("ready\n");
setInterval(() => {}, 1 << 30);
