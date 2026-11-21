// A stand-in for codex-stage2.mjs in the parallel coordinator's tests: the same command line, and
// a verdict of the real shape, with what it does per role read from <dir>/../../behavior.json:
// { i30: {...}, main: {...} }, each { inFlightAfterMs, runMs, exit, state, skip: [ids], extra: [ids],
// noVerdict, hang, orphan, still, crash }. It records when it started in <dir>/../<role>-started.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ITEMS, ITEM30_IN_FLIGHT, item, part, verdictOf } from "../../../scripts/codex-qualify/codex-stage2.mjs";
import { EXPECTED_PARTS } from "../../../scripts/codex-qualify/codex-pin-store.mjs";

const [, dir, version, bin, ...rest] = process.argv.slice(2);
const only = rest[rest.indexOf("--items") + 1].split(",");
const role = only.includes("30") ? "i30" : "main";
const b = JSON.parse(fs.readFileSync(path.join(dir, "..", "..", "behavior.json"), "utf8"))[role] ?? {};
fs.writeFileSync(path.join(dir, "..", `${role}-started`), String(Date.now()));
fs.writeFileSync(path.join(dir, "..", `${role}-argv.json`), JSON.stringify(process.argv.slice(2)));
// A detached descendant in its own group, as the driver's executors are: only the environment's scratch paths name it.
if (b.orphan) spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" }).unref();
if (b.inFlightAfterMs !== undefined) setTimeout(() => fs.writeFileSync(path.join(dir, ITEM30_IN_FLIGHT), "{}\n"), b.inFlightAfterMs);
if (b.crash) { await delay(b.crash); process.exit(b.exit ?? 3); }
if (b.hang) setInterval(() => {}, 1000);
else {
  await delay(b.runMs ?? 0);
  const ran = new Set([...only.filter((id) => !(b.skip ?? []).includes(id)), ...(b.extra ?? [])]);
  const items = Object.fromEntries(Object.keys(ITEMS).map((id) => [id, ran.has(id)
    ? item(Object.fromEntries(EXPECTED_PARTS[id].map((n) => [n, part(id === "30" && b.state ? b.state : "passed", id === "30" && b.state === "failed" ? "fixture failure" : [])])))
    : item({ run: part("not run", "not selected (--items)") })]));
  const v = verdictOf(items);
  const still = b.still ? ["fixture survivor 1"] : [];
  if (still.length) { v.state = "failed"; v.ok = false; }
  if (!b.noVerdict) fs.writeFileSync(path.join(dir, "stage2-verdict.json"), JSON.stringify({ ...v, mode: "serial", sweep: { left: [], still }, version, bin, oldBin: null, model: "fixture-model", relayPath: role === "main" ? "present" : "not tried", items: v.items }));
  process.exit(b.exit ?? 0);
}
