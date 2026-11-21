#!/usr/bin/env node
// Stage 2 in parallel (opt-in: codex-qualifier.mjs --parallel). Item 30's hour-long call runs in a
// driver process of its own while a second driver process runs every other item, so a full run takes
// about an hour instead of about 85 minutes. Same arguments as codex-stage2.mjs, without --items.
//
// The two drivers share nothing: each is a separate `node codex-stage2.mjs` process with its own
// scratch directory (<dir>/i30 and <dir>/main, neither a prefix of the other, so neither driver's
// `pgrep -f <dir>` sweep or exec-server cwd sweep reaches the other's processes), and so its own
// HOME, CODEX_HOME, TMPDIR, relay home, registry, config and log. Each runs under its own
// ProcessSupervisor rooted at its directory, the containment the qualifier uses for the serial
// driver. Item 30's driver runs only item 30, so no other item's process-global test seam (item 14's
// stage-2 dependencies, item 15's process.kill) is ever installed in it.
//
// Item 30's driver starts first. The other driver starts only once item 30's broker has received
// the long call (the driver writes ITEM30_IN_FLIGHT then): its fake model, broker, executor and app
// server are all listening by then, so the second driver's port probes cannot race their startup.
//
// The coordinator joins both, checks that each produced a verdict for exactly the items it was
// given, and judges all items once with codex-stage2.mjs's verdictOf. It writes
// <dir>/stage2-verdict.json (mode "parallel") only when both drivers wrote such a verdict. A driver
// that fails (non-zero exit, a signal, a timeout, descendants left behind, a cleanup failure) makes
// the coordinator exit non-zero, as a failed serial driver makes the qualifier fail; a driver that
// fails before its verdict, a verdict for the wrong items, and an interruption leave no verdict at
// all, so the qualifier never records them as a rejected candidate. SIGTERM, SIGINT and SIGHUP
// cancel both drivers' supervisors, which freeze and kill everything under their directories before
// the coordinator exits; the qualifier's own watchdog sees every process here by its scratch root.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessSupervisor } from "./codex-qualifier-process.mjs";
import { ITEMS, ITEM30_IN_FLIGHT, parseArgs, verdictOf } from "./codex-stage2.mjs";
import { CURRENT_VERDICT_SCHEMA } from "./codex-pin-store.mjs";
import { isMain } from "./main-module.mjs";

export const DRIVER = path.join(import.meta.dirname, "codex-stage2.mjs");
const NOT_SELECTED = "not selected (--items)";
/** The scratch variables each driver's supervisor sets below its own directory. */
const SCRATCH_KEYS = ["HOME", "CODEX_HOME", "TMPDIR", "RELAY_HOME", "RELAY_CONFIG"];

/** The two drivers: item 30 alone, and every other item. */
export const ROLES = Object.freeze({
  i30: Object.freeze({ dir: "i30", items: Object.freeze(["30"]), what: "item 30's driver" }),
  main: Object.freeze({ dir: "main", items: Object.freeze(Object.keys(ITEMS).filter((id) => id !== "30")), what: "the driver of the other items" }),
});

/**
 * What is wrong with a driver's verdict for its role: missing, for another version, binary or
 * schema, an item of its own not run or missing, an item of the other driver's run, or processes
 * its own sweep could not stop. Empty when it is that role's complete verdict.
 */
export function childProblems(verdict, { items, version, bin, what = "the driver" }) {
  if (!verdict || typeof verdict !== "object") return [`${what} wrote no verdict`];
  const p = [];
  if (verdict.version !== version) p.push(`${what}'s verdict is for version ${verdict.version}, not ${version}`);
  if (verdict.bin !== bin) p.push(`${what}'s verdict is for ${verdict.bin}, not ${bin}`);
  if (verdict.verdictSchema !== CURRENT_VERDICT_SCHEMA) p.push(`${what}'s verdict has schema ${verdict.verdictSchema}, not ${CURRENT_VERDICT_SCHEMA}`);
  for (const id of Object.keys(ITEMS)) {
    const it = verdict.items?.[id];
    const unselected = it?.state === "not run" && Object.keys(it.parts ?? {}).length === 1 && it.parts.run?.why?.length === 1 && it.parts.run.why[0] === NOT_SELECTED;
    if (items.includes(id)) {
      if (!it) p.push(`${what} recorded no result for item ${id}`);
      else if (unselected) p.push(`${what} did not run item ${id}`);
    } else if (!unselected) p.push(`${what} ran item ${id}, which is not its own`);
  }
  return p;
}

/**
 * The run's verdict from both drivers' verdicts (each already checked by childProblems): every item
 * from the driver that ran it, judged once by verdictOf, failed where either driver's own sweep left
 * processes running (as the serial driver's verdict is), with `mode: "parallel"` and each driver's
 * timings and failure. `drivers` is { i30, main }, each { verdict, elapsedMs, error, ... }.
 */
export function mergeVerdicts({ version, bin, oldBin, drivers }) {
  const items = {};
  for (const [role, { items: ids }] of Object.entries(ROLES)) for (const id of ids) items[id] = drivers[role].verdict.items[id];
  const v = verdictOf(items);
  const why = [...v.why];
  let failed = false;
  for (const [role, d] of Object.entries(drivers)) {
    const what = ROLES[role].what;
    const sweep = d.verdict.sweep ?? {};
    if (sweep.left?.length) why.push(`${what}: left running after the items, stopped by the sweep: ${sweep.left.join(", ")}`);
    if (sweep.still?.length) { failed = true; why.push(`${what}: still running after the sweep: ${sweep.still.join(", ")}`); }
    if (d.error) why.push(`${what} failed: ${d.error}`);
  }
  if (drivers.i30.verdict.model !== drivers.main.verdict.model) { failed = true; why.push(`the drivers ran different models (${drivers.i30.verdict.model}, ${drivers.main.verdict.model})`); }
  const state = failed ? "failed" : v.state;
  return {
    ok: state === "passed", state, why, verdictSchema: v.verdictSchema, mode: "parallel", version, bin, oldBin,
    model: drivers.main.verdict.model, relayPath: drivers.main.verdict.relayPath,
    drivers: Object.fromEntries(Object.entries(drivers).map(([role, { verdict, ...d }]) => [role, d])),
    items: v.items,
  };
}

const readVerdict = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const message = (e) => String(e?.message ?? e).slice(0, 2000);

/**
 * Runs both drivers and writes the run's verdict. `o`: parseArgs's options (no `only`). `opts`:
 * `driver` (the item driver to run, codex-stage2.mjs), `timeoutMs` (each driver's watchdog),
 * `inFlightTimeoutMs` (how long item 30's call may take to reach its broker), `pollMs` (the
 * supervisors' look), `signals` (whether SIGTERM, SIGINT and SIGHUP cancel), `log`.
 * Returns { code, verdict, report }: code 0 only when both drivers ran cleanly and a verdict exists.
 */
export async function coordinate(o, { driver = DRIVER, timeoutMs = 2 * 60 * 60_000, inFlightTimeoutMs = 15 * 60_000, pollMs = 1000, signals = true, log = (m) => console.log(m) } = {}) {
  if (o.only?.length) throw new Error("the parallel run runs every item: it takes no --items");
  const started = Date.now();
  fs.rmSync(o.dir, { recursive: true, force: true });
  fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const dir = fs.realpathSync(o.dir);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRATCH_KEYS.includes(k)));
  const drivers = {};
  for (const [role, r] of Object.entries(ROLES)) {
    const own = path.join(dir, r.dir);
    fs.mkdirSync(own, { mode: 0o700 });
    drivers[role] = { role, what: r.what, dir: own, log: path.join(dir, `${r.dir}.log`), sup: new ProcessSupervisor(own, { pollMs }), done: false, error: null };
  }
  let interrupted = null;
  const interrupt = (why) => { interrupted ??= why; for (const d of Object.values(drivers)) d.sup.cancel(why); };
  const handlers = { SIGTERM: () => interrupt("the coordinator was interrupted by SIGTERM"), SIGINT: () => interrupt("the coordinator was interrupted by SIGINT"), SIGHUP: () => interrupt("the coordinator was interrupted by SIGHUP") };
  if (signals) for (const [s, f] of Object.entries(handlers)) process.on(s, f);
  const start = (d, extra) => {
    d.startedAt = Date.now();
    const fd = fs.openSync(d.log, "wx", 0o600);
    const args = [driver, o.checkout, d.dir, o.version, o.bin, ...(o.source ? ["--source", o.source] : []), ...extra, "--items", ROLES[d.role].items.join(",")];
    d.run = d.sup.run(process.execPath, args, { cwd: o.checkout, env, timeoutMs, logFd: fd, inspect: true })
      .then(() => {}, (e) => { d.error = message(e); })
      .finally(() => { fs.closeSync(fd); d.done = true; d.elapsedMs = Date.now() - d.startedAt; });
    log(`stage2 parallel: started ${d.what} (items ${ROLES[d.role].items.join(",")}) in ${d.dir}`);
  };
  try {
    const { i30, main } = drivers;
    start(i30, []);
    const marker = path.join(i30.dir, ITEM30_IN_FLIGHT);
    const deadline = Date.now() + inFlightTimeoutMs;
    while (!fs.existsSync(marker) && !i30.done && !interrupted && Date.now() < deadline) await delay(Math.min(250, pollMs));
    if (fs.existsSync(marker)) { i30.inFlightAfterMs = Date.now() - i30.startedAt; log(`stage2 parallel: item 30's call reached its broker after ${Math.round(i30.inFlightAfterMs / 1000)} s`); }
    else if (!i30.done && !interrupted) { i30.sup.cancel(`item 30's long call did not reach its broker within ${Math.round(inFlightTimeoutMs / 1000)} s`); await i30.run; }
    // Item 30's driver may also have finished first, with item 30 failed early: its verdict counts.
    if (!interrupted && !(i30.done && i30.error)) start(main, o.oldBin ? ["--old-bin", o.oldBin] : []);
    // A driver that fails stops the other: the run cannot pass, and an hour need not be spent.
    const running = Object.values(drivers).filter((d) => d.run);
    await Promise.all(running.map((d) => d.run.then(() => { if (d.error) for (const x of running) if (x !== d) x.sup.cancel(`${d.what} failed: ${d.error}`); })));
    // Each supervisor checked its own tree; one last look covers anything named by either directory.
    const all = new ProcessSupervisor(dir, { pollMs });
    let left = [];
    try { left = all.scan(); if (left.length) await all.terminate(); }
    catch (e) { left.push({ pid: `(${message(e)})` }); }
    const report = {
      mode: "parallel", dir, elapsedMs: Date.now() - started, interrupted,
      leftAfterDrivers: left.map((r) => r.pid),
      drivers: Object.fromEntries(Object.entries(drivers).map(([role, d]) => [role, { started: Boolean(d.run), elapsedMs: d.elapsedMs ?? null, inFlightAfterMs: d.inFlightAfterMs ?? null, error: d.error, log: d.log }])),
    };
    for (const d of Object.values(drivers)) {
      if (!d.run) continue;
      d.verdict = readVerdict(path.join(d.dir, "stage2-verdict.json"));
      d.problems = childProblems(d.verdict, { items: ROLES[d.role].items, version: o.version, bin: o.bin, what: d.what });
      report.drivers[d.role].problems = d.problems;
    }
    const complete = !interrupted && Object.values(drivers).every((d) => d.run && !d.problems.length);
    const failures = [
      ...(interrupted ? [interrupted] : []),
      ...Object.values(drivers).filter((d) => !d.run).map((d) => `${d.what} was not started`),
      ...Object.values(drivers).flatMap((d) => [...(d.error ? [`${d.what} failed: ${d.error}`] : []), ...(d.problems ?? [])]),
      ...(left.length ? [`left running after both drivers: ${left.map((r) => r.pid).join(", ")}`] : []),
    ];
    report.failures = failures;
    fs.writeFileSync(path.join(dir, "parallel-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    let verdict = null;
    if (complete) {
      verdict = mergeVerdicts({
        version: o.version, bin: o.bin, oldBin: o.oldBin,
        drivers: Object.fromEntries(Object.entries(drivers).map(([role, d]) => [role, { verdict: d.verdict, elapsedMs: d.elapsedMs, inFlightAfterMs: d.inFlightAfterMs ?? null, error: d.error }])),
      });
      verdict.elapsedMs = report.elapsedMs;
      if (left.length) verdict.why.push(`left running after both drivers, stopped: ${left.map((r) => r.pid).join(", ")}`);
      fs.writeFileSync(path.join(dir, "stage2-verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
    }
    for (const d of Object.values(drivers)) {
      if (!d.run) continue;
      let text = ""; try { text = fs.readFileSync(d.log, "utf8"); } catch {}
      log(`----- ${d.what} (${d.log}) -----\n${text.trimEnd()}`);
    }
    for (const f of failures) process.stderr.write(`stage2 parallel: ${f}\n`);
    return { code: complete && !failures.length ? 0 : 1, verdict, report };
  } finally {
    if (signals) for (const [s, f] of Object.entries(handlers)) process.off(s, f);
  }
}

if (isMain(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); if (o.only.length) throw new Error("the parallel run runs every item: it takes no --items"); }
  catch (err) { console.error(err.message); process.exit(2); }
  const { code, verdict } = await coordinate(o);
  if (verdict) console.log(JSON.stringify({ state: verdict.state, mode: verdict.mode, relayPath: verdict.relayPath, items: Object.fromEntries(Object.entries(verdict.items).map(([k, i]) => [k, i.state])), why: verdict.why }, null, 2));
  process.exit(code);
}
