// Runs the parallel coordinator as its own process for the tests that signal it or supervise it:
// node harness.mjs '<json { o, opts }>'. The coordinator's driver is fake-driver.mjs.
import path from "node:path";
import { coordinate } from "../../../scripts/codex-qualify/stage2-parallel.mjs";

const { o, opts } = JSON.parse(process.argv[2]);
const r = await coordinate(o, { ...opts, driver: path.join(import.meta.dirname, "fake-driver.mjs") });
process.exit(r.code);
