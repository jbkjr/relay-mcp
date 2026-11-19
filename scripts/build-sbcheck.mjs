// Run by `npm run build` after the compiler: builds relay's sandbox_check helper (native/sbcheck.c)
// into dist/native/relay-sbcheck, for stage 2's survivor sweep (src/confine/sbcheck.ts). macOS only.
// Never fails the build: without the helper, relay says so (`sandboxCheckUnavailable`) and the sweep
// falls back to process-tree tracking, with the residual stated in the turn's result.
//
//   node scripts/build-sbcheck.mjs [<checkout>]     (default: the checkout this script is in)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = fs.realpathSync(path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "..")));
const source = path.join(root, "native", "sbcheck.c");
const out = path.join(root, "dist", "native", "relay-sbcheck");
const skip = (why) => {
  fs.rmSync(out, { force: true });
  console.log(`relay: not building the sandbox_check helper (${why}); stage 2's survivor sweep falls back to process-tree tracking`);
  process.exit(0);
};

if (process.platform !== "darwin") skip("not macOS");
// /usr/bin/cc without the developer tools opens the system's install dialog: ask xcode-select first.
if (spawnSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" }).status !== 0) skip("no developer tools (xcode-select -p failed)");
fs.mkdirSync(path.dirname(out), { recursive: true });
// Linked as relay-sbcheck in a directory of its own beside the output: the linker's ad-hoc signature
// takes the output's file name as its identifier, so a name with the pid in it would make every build
// of the same source differ, and the helper is part of relay's build identity (src/core/build-identity.ts).
const work = fs.mkdtempSync(path.join(path.dirname(out), ".build-"));
const tmp = path.join(work, "relay-sbcheck");
const r = spawnSync("/usr/bin/cc", ["-O2", "-Wall", "-Werror", "-o", tmp, source], { encoding: "utf8" });
if (r.status !== 0) {
  fs.rmSync(work, { recursive: true, force: true });
  skip(`cc failed: ${(r.stderr || r.error?.message || "").trim().split("\n").pop()}`);
}
fs.chmodSync(tmp, 0o755);
fs.renameSync(tmp, out);
fs.rmSync(work, { recursive: true, force: true });
