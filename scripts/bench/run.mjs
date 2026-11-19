#!/usr/bin/env node
// relay's performance benchmark: the board of cells in scenarios.mjs, run against a built relay.
//
//   TMPDIR=/tmp/rwk-bench node scripts/bench/run.mjs [--runs N] [--only <cell|scenario,...>] [--json <file>]
//        [--compare <baseline.json> [--current <file.json>]] [--target 20]
//        [--ab <other checkout>] [--relay <checkout>] [--diag] [--list]
//   node scripts/bench/run.mjs --merge <run.json> <run.json>... --json <file>
//
// --runs N sets the samples per cell (default: each scenario's own, chosen for its noise). Each cell
// is the median of its samples, every sample from fresh, isolated relay processes (see
// scenarios.mjs for what each measures and how polls are dithered). It prints one row per cell
// (value, median, p25, p75, p95, min, n, MAD/median) and writes the same as JSON (--json, default
// $TMPDIR/relay-bench-last.json). A cell's value is its median, except the poll-dominated cells,
// whose value is their mean (scenarios.mjs explains why).
//
// --compare <baseline.json>: per-cell change of the value against a saved run, PASS when it is at
//   least --target percent faster, a flag when it is slower by more than max(5%, 10 ms), and the
//   equal-weight geometric mean of the ratios per family and overall. With --current, compares two
//   saved runs without running anything.
// --ab <dir>: interleaved A/B. A is the relay checkout at <dir> (the baseline), B is --relay (default:
//   this checkout). Trials alternate A,B / B,A on the same fixtures and dither phases; each cell
//   reports the ratio of values B/A with a paired bootstrap 95% interval.
// --merge: pools the samples of several saved runs of the same build into one (each cell's
//   statistics recomputed), for a baseline steadier than any one run. Runs nothing.
// --relay <dir>: the relay checkout to drive (default: the one this script is in). Stubs and
//   fixtures always come from this script's checkout.
//
// Only one bench runs at a time on this machine (a lock in /tmp); another waits and says so.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as L from "./lib.mjs";
import { CELLS, SCENARIOS } from "./scenarios.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);
const known = new Set(["--runs", "--only", "--json", "--compare", "--current", "--target", "--ab", "--relay", "--diag", "--list", "--merge"]);
for (const a of args) if (a.startsWith("--") && !known.has(a)) { console.error(`unknown option ${a}`); process.exit(2); }
const TARGET = Number(opt("--target") ?? 20);

if (flag("--list")) {
  for (const [id, c] of Object.entries(CELLS)) console.log(`${id.padEnd(26)} ${c.family.padEnd(16)} ${c.what}`);
  process.exit(0);
}

// ---------- statistics ----------
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const quantile = (xs, q) => { const s = sorted(xs); if (!s.length) return NaN; const p = (s.length - 1) * q; const lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };
const median = (xs) => quantile(xs, 0.5);
function summary(xs) {
  const m = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - m)));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { median: m, mean, p25: quantile(xs, 0.25), p75: quantile(xs, 0.75), p95: quantile(xs, 0.95), min: Math.min(...xs), max: Math.max(...xs), n: xs.length, mad, mad_pct: (mad / m) * 100 };
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
/** A fixed shuffle of 0..n-1 for a scenario: the order in which its dither phases are used, the same in every run. */
function permutation(n, seed) { const r = rng(seed), p = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } return p; }
/**
 * 95% interval of B/A from paired samples: sample i of A and of B ran in the same trial slot with
 * the same dither phase, so their difference cancels the deliberate phase spread. Bootstraps the
 * cell's estimator (median or mean) of the paired differences, as a ratio to A's value.
 */
function bootstrapRatio(a, b, seed, est = median) {
  const r = rng(seed), n = Math.min(a.length, b.length), out = [];
  const diffs = Array.from({ length: n }, (_, i) => b[i] - a[i]);
  const base = est(a);
  for (let k = 0; k < 2000; k++) {
    const d = [];
    for (let i = 0; i < n; i++) d.push(diffs[Math.floor(r() * n)]);
    out.push(1 + est(d) / base);
  }
  return [quantile(out, 0.025), quantile(out, 0.975)];
}
const geomean = (xs) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const pct = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const regressed = (base, cur) => cur - base > Math.max(0.05 * base, 10);
const FAMILIES = ["start/continue", "supervise", "cli/maintenance", "diagnostic"];
/** A cell's value in a saved run: `value` (median, or mean for the poll cells), or the median in files written before it existed. */
const val = (c) => c.value ?? c.median;

// ---------- comparison output ----------
function compareTables(base, cur, { ci } = {}) {
  const lines = [];
  const ratios = {};
  lines.push(`${"cell".padEnd(26)} ${"base".padStart(9)} ${"current".padStart(9)} ${"delta".padStart(8)}${ci ? "  95% CI of delta  " : ""}  verdict`);
  for (const fam of FAMILIES) {
    const ids = Object.keys(cur).filter((id) => cur[id].family === fam && base[id]);
    if (!ids.length) continue;
    lines.push(`-- ${fam}`);
    for (const id of ids) {
      const b = val(base[id]), c = val(cur[id]), ratio = c / b;
      if (fam !== "diagnostic") (ratios[fam] ??= []).push(ratio);
      const pass = ratio <= 1 - TARGET / 100;
      const flags = [pass ? "PASS" : "FAIL"];
      if (regressed(b, c)) flags.push("REGRESSED");
      const interval = ci?.[id] ? `  [${pct((ci[id][0] - 1) * 100)}, ${pct((ci[id][1] - 1) * 100)}]`.padEnd(20) : ci ? " ".repeat(20) : "";
      lines.push(`${id.padEnd(26)} ${f1(b).padStart(9)} ${f1(c).padStart(9)} ${pct((ratio - 1) * 100).padStart(8)}${interval}  ${fam === "diagnostic" ? "(diagnostic)" : flags.join(" ")}`);
    }
  }
  const all = Object.values(ratios).flat();
  lines.push("-- geometric mean of current/base (equal weight per cell)");
  for (const [fam, rs] of Object.entries(ratios)) lines.push(`${fam.padEnd(26)} ${pct((geomean(rs) - 1) * 100).padStart(8)}  (${rs.length} cells)`);
  if (all.length) lines.push(`${"overall".padEnd(26)} ${pct((geomean(all) - 1) * 100).padStart(8)}  (${all.length} cells; stop predicate: every cell PASS, i.e. <= -${TARGET}%)`);
  const failing = Object.entries(cur).filter(([id, c]) => c.family !== "diagnostic" && base[id] && val(c) / val(base[id]) > 1 - TARGET / 100).map(([id]) => id);
  lines.push(failing.length ? `NOT MET: ${failing.length} cell(s) short of -${TARGET}%: ${failing.join(", ")}` : `MET: every compared cell is at least ${TARGET}% faster`);
  return lines.join("\n");
}

if (flag("--merge")) {
  const files = args.slice(args.indexOf("--merge") + 1).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--json");
  const runs = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  const commits = [...new Set(runs.map((r) => r.meta.relay.commit))];
  if (commits.length !== 1) { console.error(`--merge: the runs are of different builds (${commits.join(", ")})`); process.exit(2); }
  const cells = {};
  for (const id of Object.keys(runs[0].cells)) {
    const xs = runs.flatMap((r) => r.cells[id]?.samples ?? []);
    const c = runs[0].cells[id], est = c.estimator ?? CELLS[id]?.estimator ?? "median", st = summary(xs);
    cells[id] = { family: c.family, unit: c.unit, what: c.what, estimator: est, value: est === "mean" ? st.mean : st.median, ...st, samples: xs };
  }
  const merged = { meta: { ...runs[0].meta, merged_from: files.map((f, i) => ({ file: path.basename(f), date: runs[i].meta.date, loadavg_1m: runs[i].meta.loadavg_1m, duration_s: runs[i].meta.duration_s, warnings: runs[i].meta.warnings })) }, cells };
  const out = opt("--json");
  if (!out) { console.error("--merge needs --json <file>"); process.exit(2); }
  fs.writeFileSync(out, JSON.stringify(merged, null, 2) + "\n");
  console.log(`merged ${files.length} runs of ${commits[0]} into ${out}`);
  process.exit(0);
}

if (opt("--compare") && opt("--current")) {
  const base = JSON.parse(fs.readFileSync(opt("--compare"), "utf8")).cells;
  const cur = JSON.parse(fs.readFileSync(opt("--current"), "utf8")).cells;
  console.log(compareTables(base, cur));
  process.exit(0);
}

// ---------- the machine-wide lock ----------
const LOCK = "/tmp/relay-bench.lock";
const procStart = (pid) => spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
async function lock() {
  const me = JSON.stringify({ pid: process.pid, start: procStart(process.pid), cwd: process.cwd(), argv: process.argv.slice(1) });
  let said = 0;
  for (;;) {
    try {
      fs.writeFileSync(LOCK, me, { flag: "wx", mode: 0o644 });
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch {}
    const stale = !holder || !holder.pid || procStart(holder.pid) !== holder.start;
    if (stale) {
      // The holder is gone (or its pid now belongs to another process): take the lock over.
      try { fs.rmSync(LOCK); } catch {}
      continue;
    }
    if (Date.now() - said > 15_000) {
      console.error(`waiting: another bench run holds ${LOCK} (pid ${holder.pid}, ${holder.cwd}, ${(holder.argv ?? []).join(" ")})`);
      said = Date.now();
    }
    await L.sleep(1000);
  }
}
const unlock = () => { try { const h = JSON.parse(fs.readFileSync(LOCK, "utf8")); if (h.pid === process.pid) fs.rmSync(LOCK); } catch {} };

/** Other processes using a lot of CPU right now (ps %cpu, a decaying average): what may contaminate the timings. */
function heavyProcesses() {
  const r = spawnSync("/bin/ps", ["-axo", "pid=,pcpu=,user=,comm="], { encoding: "utf8", maxBuffer: 16 << 20 });
  const mine = new Set([process.pid]);
  return r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 4 && Number(f[1]) >= 25 && !mine.has(Number(f[0])))
    .map((f) => `${path.basename(f.slice(3).join(" "))} (${f[2]}, ${f[1]}%)`);
}

// ---------- the run ----------
const sides = [];
const candidate = L.relayAt(opt("--relay") ?? L.HARNESS_ROOT);
if (opt("--ab")) sides.push({ name: "A", relay: L.relayAt(opt("--ab")) }, { name: "B", relay: candidate });
else sides.push({ name: "B", relay: candidate });
L.benchTmp();

const only = opt("--only")?.split(",").filter(Boolean);
if (only) for (const o of only) if (!CELLS[o] && !SCENARIOS.some((s) => s.id === o)) { console.error(`unknown cell or scenario ${o} (see --list)`); process.exit(2); }
const chosen = SCENARIOS.filter((s) => (only ? only.includes(s.id) || Object.keys(s.cells).some((c) => only.includes(c)) : flag("--diag") || !Object.values(s.cells).every((c) => c.family === "diagnostic")));
const runsOverride = opt("--runs") ? Number(opt("--runs")) : undefined;

let interrupted = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { interrupted = true; L.emergencyCleanup(); unlock(); process.exit(130); });
process.on("exit", unlock);

await lock();
const load0 = os.loadavg()[0];
const cores = os.cpus().length;
const busy = (l) => l > Math.max(2, 0.15 * cores);
console.log(`relay bench: ${sides.map((s) => `${s.name}=${s.relay.root} (${s.relay.commit?.slice(0, 10) ?? "no build stamp"})`).join(", ")}`);
console.log(`node ${process.version}, ${os.cpus()[0].model} x${cores}, load average (1 min) at start ${load0.toFixed(2)}${busy(load0) ? "  WARNING: the machine is busy; timings may be contaminated" : ""}`);
const heavy0 = heavyProcesses();
if (heavy0.length) console.log(`WARNING: other processes are using CPU: ${heavy0.join(", ")}`);

const samples = Object.fromEntries(sides.map((s) => [s.name, {}]));
const warnings = [];
const scenarioLoad = {};
const started = Date.now();

async function runTrial(scn, side, t, perTrial, total, perm, discard) {
  const made = [];
  const ctx = {
    relay: side.relay, perTrial, trialIndex: t,
    phase: (j) => (perm[(t * perTrial + j) % total] + 0.5) / total,
    record: (cell, v) => { if (!discard) (samples[side.name][cell] ??= []).push(v); },
    sandbox: (o) => { const sb = L.sandbox(side.relay, o); made.push(sb); return sb; },
  };
  try {
    await scn.trial(ctx);
  } catch (err) {
    console.error(`\nFAILED: scenario ${scn.id}, trial ${t}${sides.length > 1 ? ` (side ${side.name}: ${side.relay.root})` : ""}\n${err.stack ?? err}`);
    for (const sb of made) console.error(L.diagnostics(sb));
    for (const sb of made) await L.closeSandbox(sb, { keep: true }).catch(() => {});
    unlock();
    process.exit(1);
  }
  for (const sb of made) {
    const left = await L.closeSandbox(sb);
    if (left.length) warnings.push(`${scn.id} trial ${t}: killed ${left.length} process(es) still running at the end: ${left.map((p) => p.line).join(" | ")}`);
  }
}

for (const scn of chosen) {
  const perTrial = scn.perTrial;
  const trials = runsOverride ? Math.max(1, Math.ceil(runsOverride / perTrial)) : scn.trials;
  const total = trials * perTrial;
  const perm = permutation(total, hash(scn.id));
  const t0 = Date.now();
  const loadAt = os.loadavg()[0];
  process.stdout.write(`${scn.id.padEnd(22)} ${trials} trial(s) x ${perTrial}${sides.length > 1 ? " x 2 sides" : ""} (load ${loadAt.toFixed(1)}) ...`);
  for (let w = 0; w < (scn.warmup ?? 0); w++) for (const side of sides) await runTrial(scn, side, 0, perTrial, total, perm, true);
  for (let t = 0; t < trials; t++) {
    const order = t % 2 === 0 ? sides : [...sides].reverse();
    for (const side of order) await runTrial(scn, side, t, perTrial, total, perm, false);
    if (interrupted) break;
  }
  const heavy = heavyProcesses();
  scenarioLoad[scn.id] = { start: loadAt, end: os.loadavg()[0], heavy };
  console.log(` ${((Date.now() - t0) / 1000).toFixed(1)} s${heavy.length ? `  (busy: ${heavy.join(", ")})` : ""}`);
}
const load1 = os.loadavg()[0];

// ---------- report ----------
const cellsOf = (side) => Object.fromEntries(Object.entries(samples[side]).map(([id, xs]) => {
  const st = summary(xs);
  // The cell's value: its median, or for the poll cells its mean (scenarios.mjs).
  return [id, { family: CELLS[id].family, unit: CELLS[id].unit, what: CELLS[id].what, estimator: CELLS[id].estimator, value: CELLS[id].estimator === "mean" ? st.mean : st.median, ...st, samples: xs.map((x) => Math.round(x * 100) / 100) }];
}));
const result = {
  meta: {
    date: new Date().toISOString(), node: process.version, cpu: os.cpus()[0].model, cores, platform: `${os.platform()} ${os.release()}`,
    harness: L.HARNESS_ROOT, relay: { root: candidate.root, commit: candidate.commit }, ...(opt("--ab") ? { baseline: { root: sides[0].relay.root, commit: sides[0].relay.commit } } : {}),
    loadavg_1m: { start: load0, end: load1, by_scenario: scenarioLoad }, duration_s: (Date.now() - started) / 1000, runs_override: runsOverride ?? null, warnings,
  },
  cells: cellsOf("B"),
  ...(opt("--ab") ? { baseline_cells: cellsOf("A") } : {}),
};

function table(cells) {
  const lines = [`${"cell".padEnd(26)} ${"value".padStart(8)} ${"median".padStart(8)} ${"p25".padStart(8)} ${"p75".padStart(8)} ${"p95".padStart(8)} ${"min".padStart(8)} ${"n".padStart(3)} ${"MAD%".padStart(6)}  unit`];
  for (const fam of FAMILIES) {
    const ids = Object.keys(cells).filter((id) => cells[id].family === fam);
    if (!ids.length) continue;
    lines.push(`-- ${fam}`);
    for (const id of ids) {
      const c = cells[id];
      lines.push(`${id.padEnd(26)} ${f1(c.value).padStart(8)} ${f1(c.median).padStart(8)} ${f1(c.p25).padStart(8)} ${f1(c.p75).padStart(8)} ${f1(c.p95).padStart(8)} ${f1(c.min).padStart(8)} ${String(c.n).padStart(3)} ${f1(c.mad_pct).padStart(6)}  ${c.unit}${c.estimator === "mean" ? " (value: mean)" : ""}`);
    }
  }
  return lines.join("\n");
}

console.log("");
if (opt("--ab")) {
  console.log(`A (baseline) ${sides[0].relay.root}\n${table(result.baseline_cells)}\n`);
  console.log(`B (candidate) ${candidate.root}\n${table(result.cells)}\n`);
  const meanOf = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ci = Object.fromEntries(Object.keys(result.cells).filter((id) => result.baseline_cells[id]).map((id) => [id, bootstrapRatio(samples.A[id], samples.B[id], hash(id), CELLS[id].estimator === "mean" ? meanOf : median)]));
  result.ab = Object.fromEntries(Object.entries(ci).map(([id, [lo, hi]]) => [id, { ratio: val(result.cells[id]) / val(result.baseline_cells[id]), ci95: [lo, hi] }]));
  console.log(`B against A (ratio of values; 95% interval from a bootstrap of the paired differences; target -${TARGET}%)\n${compareTables(result.baseline_cells, result.cells, { ci })}`);
} else {
  console.log(table(result.cells));
}
if (opt("--compare")) {
  const base = JSON.parse(fs.readFileSync(opt("--compare"), "utf8")).cells;
  console.log(`\nagainst ${opt("--compare")} (target -${TARGET}%)\n${compareTables(base, result.cells)}`);
}
console.log(`\nload average (1 min): start ${load0.toFixed(2)}, end ${load1.toFixed(2)}${busy(load1) || busy(load0) ? "  WARNING: the machine was busy; timings may be contaminated" : ""}; ${((Date.now() - started) / 1000).toFixed(0)} s`);
for (const w of warnings) console.log(`warning: ${w}`);
const out = opt("--json") ?? path.join(L.benchTmp(), "relay-bench-last.json");
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
console.log(`wrote ${out}`);
