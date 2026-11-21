// Stage 2's opt-in parallel run (scripts/codex-qualify/stage2-parallel.mjs): how it checks each
// driver's verdict and merges them, and, with a fake driver (test/fixtures/stage2-parallel), that it
// starts the other items only once item 30's call is in flight, passes on every driver failure, and
// leaves no process of either driver behind on a failure, a timeout, SIGTERM or the qualifier's watchdog.
import "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as Q from "../scripts/codex-qualify/codex-stage2.mjs";
import { ROLES, childProblems, coordinate, mergeVerdicts } from "../scripts/codex-qualify/stage2-parallel.mjs";
import { CURRENT_VERDICT_SCHEMA, EXPECTED_PARTS, judgeVerdict } from "../scripts/codex-qualify/codex-pin-store.mjs";
import { ProcessSupervisor, processTable } from "../scripts/codex-qualify/codex-qualifier-process.mjs";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "stage2-parallel");
const FAKE = path.join(FIXTURES, "fake-driver.mjs");
const HARNESS = path.join(FIXTURES, "harness.mjs");

function scratch(t: any) {
  // Short: the coordinator's supervisors and fake drivers put scratch homes below it.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2p-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const opts = (root: string) => ({ checkout: root, dir: path.join(root, "out"), version: "0.170.0", bin: "/fixture/codex", oldBin: "/fixture/old", source: "/fixture/src", only: [] as string[] });
const behave = (root: string, b: object) => fs.writeFileSync(path.join(root, "behavior.json"), JSON.stringify(b));
/** Every process whose command or environment names `dir` (ps -E), other than this one. */
const survivors = (dir: string) => processTable(dir).filter((r: any) => r.command.includes(dir) && r.pid !== process.pid);
const quiet = { log: () => {}, signals: false, pollMs: 50 };

/** A driver verdict as codex-stage2.mjs writes it, for these items, every part as `state`. */
function driverVerdict(ids: readonly string[], { state = "passed", still = [] as string[] } = {}) {
  const items = Object.fromEntries(Object.keys(Q.ITEMS).map((id) => [id, ids.includes(id)
    ? Q.item(Object.fromEntries(EXPECTED_PARTS[id].map((n: string) => [n, Q.part(state)])))
    : Q.item({ run: Q.part("not run", "not selected (--items)") })]));
  const v = Q.verdictOf(items);
  return { ...v, mode: "serial", sweep: { left: [], still }, version: "0.170.0", bin: "/fixture/codex", oldBin: null, model: "m", relayPath: ids.includes("1") ? "present" : "not tried", items: v.items };
}

test("stage-2 parallel: the two drivers split every item between them, item 30 alone in its own", () => {
  assert.deepEqual(ROLES.i30.items, ["30"]);
  assert.deepEqual([...ROLES.main.items, ...ROLES.i30.items].sort((a, b) => +a - +b), Object.keys(Q.ITEMS));
  assert.equal(ROLES.main.items.includes("30"), false);
  assert.notEqual(ROLES.i30.dir, ROLES.main.dir);
  // Neither driver's directory names the other's: each driver's pgrep -f sweep is a substring match.
  assert.equal(ROLES.i30.dir.includes(ROLES.main.dir) || ROLES.main.dir.includes(ROLES.i30.dir), false);
});

test("stage-2 parallel: a driver's verdict must hold exactly its own items, for this version, binary and schema", () => {
  const want = { items: ROLES.main.items, version: "0.170.0", bin: "/fixture/codex", what: "main" };
  assert.deepEqual(childProblems(driverVerdict(ROLES.main.items), want), []);
  assert.deepEqual(childProblems(null, want), ["main wrote no verdict"]);
  // A partial driver records unselected items "not run" and exits 0: an item of its own left out is caught.
  assert.deepEqual(childProblems(driverVerdict(ROLES.main.items.filter((id) => id !== "12")), want), ["main did not run item 12"]);
  const lost = driverVerdict(ROLES.main.items); delete (lost.items as any)["7"];
  assert.deepEqual(childProblems(lost, want), ["main recorded no result for item 7"]);
  assert.deepEqual(childProblems(driverVerdict([...ROLES.main.items, "30"]), want), ["main ran item 30, which is not its own"]);
  assert.deepEqual(childProblems(driverVerdict(["30"]), { ...want, items: ROLES.i30.items }), []);
  assert.match(childProblems({ ...driverVerdict(ROLES.main.items), version: "0.169.0" }, want).join(), /version 0\.169\.0, not 0\.170\.0/);
  assert.match(childProblems({ ...driverVerdict(ROLES.main.items), bin: "/other" }, want).join(), /\/other, not \/fixture\/codex/);
  assert.match(childProblems({ ...driverVerdict(ROLES.main.items), verdictSchema: "stage2-v1" }, want).join(), /schema stage2-v1/);
  // An item that failed or did not run for another reason is the driver's result, not a driver problem.
  const failed = driverVerdict(ROLES.main.items); (failed.items as any)["5"] = Q.item({ codex: Q.part("failed", "x") });
  assert.deepEqual(childProblems(failed, want), []);
});

test("stage-2 parallel: the merged verdict judges all items once, records the mode, and keeps each driver's sweep failure", () => {
  const drivers = (i30: any, main: any) => ({ i30: { verdict: i30, elapsedMs: 1, error: null }, main: { verdict: main, elapsedMs: 2, error: null } });
  const v = mergeVerdicts({ version: "0.170.0", bin: "/fixture/codex", oldBin: "/fixture/old", drivers: drivers(driverVerdict(["30"]), driverVerdict(ROLES.main.items)) });
  assert.equal(v.state, "passed"); assert.equal(v.mode, "parallel"); assert.equal(v.relayPath, "present"); assert.equal(v.verdictSchema, CURRENT_VERDICT_SCHEMA);
  assert.deepEqual(Object.keys(v.items), Object.keys(Q.ITEMS));
  assert.deepEqual(judgeVerdict(v, "0.170.0").why, []);
  assert.deepEqual(Object.keys(v.drivers), ["i30", "main"]);
  const bad = mergeVerdicts({ version: "0.170.0", bin: "/fixture/codex", oldBin: null, drivers: drivers(driverVerdict(["30"], { state: "failed" }), driverVerdict(ROLES.main.items)) });
  assert.equal(bad.state, "failed"); assert.match(bad.why.join(), /item 30 failed/);
  // A driver whose own sweep could not stop a process fails the run, as the serial driver's verdict does.
  const still = mergeVerdicts({ version: "0.170.0", bin: "/fixture/codex", oldBin: null, drivers: drivers(driverVerdict(["30"]), driverVerdict(ROLES.main.items, { still: ["executor 123"] })) });
  assert.equal(still.state, "failed"); assert.equal(still.ok, false); assert.match(still.why.join(), /still running after the sweep: executor 123/);
  assert.equal(judgeVerdict(still, "0.170.0").ok, false);
  const models = mergeVerdicts({ version: "0.170.0", bin: "/fixture/codex", oldBin: null, drivers: drivers({ ...driverVerdict(["30"]), model: "other" }, driverVerdict(ROLES.main.items)) });
  assert.equal(models.state, "failed"); assert.match(models.why.join(), /different models/);
});

test("stage-2 parallel: the other items start only once item 30's call is in flight, and a clean run merges to a passing verdict", async (t) => {
  const root = scratch(t);
  behave(root, { i30: { inFlightAfterMs: 800, runMs: 1500 }, main: { runMs: 200 } });
  const r = await coordinate(opts(root), { ...quiet, driver: FAKE });
  assert.equal(r.code, 0, JSON.stringify(r.report.failures));
  const out = path.join(root, "out");
  const started = (role: string) => Number(fs.readFileSync(path.join(out, `${role}-started`), "utf8"));
  const inFlight = fs.statSync(path.join(out, "i30", Q.ITEM30_IN_FLIGHT)).mtimeMs;
  assert.ok(started("main") >= inFlight, "the other items waited for item 30's call");
  assert.ok(started("main") - started("i30") >= 700);
  const v = JSON.parse(fs.readFileSync(path.join(out, "stage2-verdict.json"), "utf8"));
  assert.deepEqual(v, r.verdict);
  assert.equal(v.mode, "parallel"); assert.equal(v.state, "passed");
  assert.deepEqual(judgeVerdict(v, "0.170.0").why, []);
  assert.ok(v.drivers.i30.inFlightAfterMs >= 700);
  // Each driver: its own directory, its own items; only the other items' driver takes the older Codex.
  const argv = (role: string) => JSON.parse(fs.readFileSync(path.join(out, `${role}-argv.json`), "utf8"));
  assert.deepEqual(argv("i30").slice(1), [path.join(out, "i30"), "0.170.0", "/fixture/codex", "--source", "/fixture/src", "--items", "30"]);
  assert.deepEqual(argv("main").slice(1), [path.join(out, "main"), "0.170.0", "/fixture/codex", "--source", "/fixture/src", "--old-bin", "/fixture/old", "--items", ROLES.main.items.join(",")]);
  assert.deepEqual(survivors(out), []);
});

test("stage-2 parallel: item 30 failing before its call still lets the other items run, and the verdict fails on item 30", async (t) => {
  const root = scratch(t);
  behave(root, { i30: { state: "failed" }, main: { runMs: 100 } });
  const r = await coordinate(opts(root), { ...quiet, driver: FAKE });
  assert.equal(r.code, 0, "the drivers ran cleanly: item 30's failure is in the verdict");
  assert.equal(r.verdict.state, "failed"); assert.equal(r.verdict.items["30"].state, "failed"); assert.equal(r.verdict.items["1"].state, "passed");
  assert.equal(judgeVerdict(r.verdict, "0.170.0").ok, false);
});

test("stage-2 parallel: a driver that fails stops the other, writes no verdict and leaves no process", async (t) => {
  const root = scratch(t);
  behave(root, { i30: { inFlightAfterMs: 100, hang: true, orphan: true }, main: { crash: 300, exit: 3 } });
  const at = Date.now();
  const r = await coordinate(opts(root), { ...quiet, driver: FAKE });
  assert.ok(Date.now() - at < 30_000, "item 30's driver did not run on after the other failed");
  assert.equal(r.code, 1); assert.equal(r.verdict, null);
  assert.equal(fs.existsSync(path.join(root, "out", "stage2-verdict.json")), false, "no verdict, so the qualifier can retry it");
  assert.match(r.report.failures.join("\n"), /the driver of the other items failed: .*exited 3/);
  assert.match(r.report.failures.join("\n"), /item 30's driver failed: the driver of the other items failed/);
  assert.deepEqual(survivors(path.join(root, "out")), []);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, "out", "parallel-report.json"), "utf8")).failures.length >= 2);
});

test("stage-2 parallel: a driver that exits 0 without one of its items, or with another's, fails without a verdict", async (t) => {
  for (const b of [{ main: { skip: ["12"] } }, { i30: { extra: ["1"] } }, { main: { noVerdict: true } }]) {
    const root = scratch(t);
    behave(root, { i30: { inFlightAfterMs: 50, runMs: 300, ...(b as any).i30 }, main: { ...(b as any).main } });
    const r = await coordinate(opts(root), { ...quiet, driver: FAKE });
    assert.equal(r.code, 1, JSON.stringify(b)); assert.equal(r.verdict, null);
    assert.match(r.report.failures.join("\n"), /did not run item 12|ran item 1, which is not its own|wrote no verdict/);
  }
});

test("stage-2 parallel: a driver that leaves a descendant after its verdict fails the run, with the verdict kept", async (t) => {
  const root = scratch(t);
  behave(root, { i30: { inFlightAfterMs: 50, runMs: 100 }, main: { runMs: 600, orphan: true } });
  const r = await coordinate(opts(root), { ...quiet, driver: FAKE });
  assert.equal(r.code, 1, "passed on to the qualifier, which then never promotes");
  assert.match(r.report.failures.join("\n"), /the driver of the other items failed: qualification left descendants/);
  // Both verdicts were complete: the run's verdict records the failure beside the items, as the
  // serial qualifier keeps a verdict whose driver left descendants.
  assert.equal(r.verdict.state, "passed"); assert.match(r.verdict.why.join(), /the driver of the other items failed: qualification left descendants/);
  assert.deepEqual(survivors(path.join(root, "out")), []);
});

test("stage-2 parallel: item 30's call that never reaches its broker stops its driver; the other items never start", async (t) => {
  const root = scratch(t);
  behave(root, { i30: { hang: true, orphan: true } });
  const r = await coordinate(opts(root), { ...quiet, driver: FAKE, inFlightTimeoutMs: 1000 });
  assert.equal(r.code, 1); assert.equal(r.verdict, null);
  assert.match(r.report.failures.join("\n"), /did not reach its broker within 1 s/);
  assert.equal(r.report.drivers.main.started, false);
  assert.equal(fs.existsSync(path.join(root, "out", "main-started")), false);
  assert.deepEqual(survivors(path.join(root, "out")), []);
});

test("stage-2 parallel: a driver's watchdog timeout kills both drivers' trees", async (t) => {
  const root = scratch(t);
  behave(root, { i30: { inFlightAfterMs: 100, hang: true, orphan: true }, main: { hang: true, orphan: true } });
  const r = await coordinate(opts(root), { ...quiet, driver: FAKE, timeoutMs: 2500 });
  assert.equal(r.code, 1); assert.equal(r.verdict, null);
  assert.match(r.report.failures.join("\n"), /timeout after 2500ms/);
  assert.deepEqual(survivors(path.join(root, "out")), []);
});

async function harness(t: any, b: object) {
  const root = scratch(t);
  behave(root, b);
  const child = spawn(process.execPath, [HARNESS, JSON.stringify({ o: opts(root), opts: { pollMs: 50 } })], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = "";
  child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { output += d; });
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} });
  const out = path.join(root, "out");
  for (let i = 0; i < 200 && !fs.existsSync(path.join(out, "main-started")); i++) await delay(50);
  assert.ok(fs.existsSync(path.join(out, "main-started")), `both drivers started: ${output}`);
  await delay(300); // Their orphans too.
  return { root, out, child, exited, output: () => output };
}

test("stage-2 parallel: SIGTERM to the coordinator leaves no process of either driver, and no verdict", async (t) => {
  const h = await harness(t, { i30: { inFlightAfterMs: 50, hang: true, orphan: true }, main: { hang: true, orphan: true } });
  assert.ok(survivors(h.out).length >= 4, "two drivers and their orphans run");
  process.kill(h.child.pid!, "SIGTERM");
  const e = await h.exited;
  assert.equal(e.code, 1, h.output());
  assert.match(h.output(), /interrupted by SIGTERM/);
  assert.equal(fs.existsSync(path.join(h.out, "stage2-verdict.json")), false);
  assert.deepEqual(survivors(h.out), []);
});

test("stage-2 parallel: the qualifier's watchdog contains the coordinator and both drivers as one supervised command", async (t) => {
  const root = scratch(t);
  behave(root, { i30: { inFlightAfterMs: 50, hang: true, orphan: true }, main: { hang: true, orphan: true } });
  // As the qualifier runs it: the coordinator under a supervisor rooted at the run's scratch.
  const sup = new ProcessSupervisor(root, { pollMs: 50 });
  await assert.rejects(sup.run(process.execPath, [HARNESS, JSON.stringify({ o: opts(root), opts: { pollMs: 50 } })], { timeoutMs: 3000, inspect: true }), /timeout after 3000ms/);
  assert.ok(fs.existsSync(path.join(root, "out", "main-started")), "both drivers had started");
  assert.deepEqual(survivors(root), []);
});
