import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { closeDbForTests, closeTurns, createRun, db, insertNode, insertTurn, updateNode, updateTurn, getRun } from "../dist/core/db.js";
import { withDefaults } from "../dist/core/config.js";
import { finishLaunchExecutor, finishLaunchReservation, launchExecutorQuarantine, launchReservationProblem, launchReservationState, overlayInterlock, reapLaunchReservations, reserveLaunch, setOverlayClockForTests } from "../dist/core/restart-overlay.js";
import { localModeRetired } from "../dist/core/raw-network.js";
import { forgetExecutor, taintExecutor } from "../dist/core/stage2-executors.js";

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wp4-")));
  const saved = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG, RELAY_EXPERIMENTAL_CODEX_STAGE2: process.env.RELAY_EXPERIMENTAL_CODEX_STAGE2 };
  process.env.RELAY_HOME = path.join(home, "registry"); process.env.RELAY_CONFIG = path.join(home, "config.json"); delete process.env.RELAY_EXPERIMENTAL_CODEX_STAGE2;
  const cfg = withDefaults({}); fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
  const run = createRun(home, cfg, "wp4");
  setOverlayClockForTests({ wall: Date.now, mono: () => 1000, boot: () => "unit", owner: () => ({ pid: process.pid, start: "unit-start" }) });
  const turn = (id: string, grant: object = { network: true, raw_network: true }) => {
    insertNode({ id, run_id: run, kind: "job", target: "codex", cwd: home, mode: "write", depth: 1, status: "running", task: "unit" });
    const turn = insertTurn(id, "initial", "unit", "write"); updateTurn(turn, { grant_json: JSON.stringify(grant) }); return turn;
  };
  return { home, run, turn, close() { setOverlayClockForTests(null); closeDbForTests(); for (const [k,v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; fs.rmSync(home, { recursive: true, force: true }); } };
}

for (const mode of ["local", "stage2"] as const) test(`WP4: ${mode} reservation blocks opposite starts through every lifecycle state`, () => {
  const f = fixture(); try {
    const id = f.turn("j_first", { network: true, [mode === "local" ? "local_network" : "raw_network"]: true }), other = mode === "local" ? "stage2" : "local";
    reserveLaunch("j_first", id, mode);
    for (const state of ["starting", "running", "stopping", "tainted"] as const) {
      if (state === "running" || state === "stopping") launchReservationState(f.run, id, state);
      if (state === "tainted") finishLaunchReservation(f.run, id, { clean: false, problem: "detached survivor; sweep uncertain" });
      assert.equal(overlayInterlock(mode), null);
      const why = overlayInterlock(other)!;
      assert.match(why, new RegExp(`reservation ${id} of j_first ${state}`));
      assert.match(why, /reap\/cancel and verify cleanup/);
      const blockedNode = `j_${state}`, blockedTurn = f.turn(blockedNode, { network: true, [other === "local" ? "local_network" : "raw_network"]: true });
      assert.throws(() => reserveLaunch(blockedNode, blockedTurn, other), /launch reservation/);
    }
    assert.match(launchReservationProblem(f.run)!, /tainted/);
    finishLaunchReservation(f.run, id, { clean: true });
    assert.equal(overlayInterlock(other), null);
    assert.equal(launchReservationProblem(f.run), null);
    assert.equal((db().prepare("PRAGMA user_version").get() as any).user_version, 5);
  } finally { f.close(); }
});

test("WP4: malformed captured grants fail both directions closed, regardless of flags/node grants", () => {
  const f = fixture(); try {
    const id = f.turn("j_bad"); updateTurn(id, { status: "running" });
    for (const bad of ["{bad", "null", "[]", '"local"', '{"local_network":"yes"}']) {
      updateTurn(id, { grant_json: bad });
      for (const mode of ["local", "stage2"] as const) assert.match(overlayInterlock(mode)!, /j_bad.*state running.*reap\/cancel/);
    }
    updateTurn(id, { grant_json: '{"network":true,"raw_network":true}' });
    assert.match(localModeRetired(withDefaults({}))!, /j_bad.*raw network/);
    updateTurn(id, { grant_json: '{"network":true,"local_network":true}' });
    assert.match(overlayInterlock("stage2")!, /j_bad.*local network mode/);
    updateTurn(id, { status: "done" }); assert.equal(overlayInterlock("stage2"), null);
    updateNode("j_bad", { agent_pgid: 2147483000 });
    assert.match(overlayInterlock("stage2")!, /j_bad.*tainted; terminal turn retains agent group/);
  } finally { f.close(); }
});

test("WP4: malformed reservations retain quarantine; dead executor records block until teardown, including flag-off leftovers", () => {
  const f = fixture(); try {
    db().prepare("UPDATE runs SET config_json=json_set(config_json,'$.params_json.launch_reservations',json(?)) WHERE id=?").run('{"bad":{}}', f.run);
    for (const mode of ["local", "stage2"] as const) assert.match(overlayInterlock(mode)!, /malformed launch reservation bad.*reap\/cancel/);
    db().prepare("UPDATE runs SET config_json=json_remove(config_json,'$.params_json.launch_reservations') WHERE id=?").run(f.run);
    const dir = path.join(process.env.RELAY_HOME!, "executors"); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "ex-2147483000-abcdef12.json");
    fs.writeFileSync(file, JSON.stringify({ v: 1, pid: 2147483000, pgid: 2147483000, start: "dead", owner: { pid: 2147483000, start: "dead" }, runId: f.run, nodeId: "j_survivor", turnId: null, ports: { exec: 61001, block: [61002] }, tmpDir: f.home, descendants: [], createdAt: 1 }));
    try {
      assert.match(overlayInterlock("local")!, /executor .*j_survivor.*awaiting verified teardown.*reap\/cancel/);
      taintExecutor(file, "sweep uncertain", []);
      assert.match(localModeRetired(withDefaults({}))!, /j_survivor.*tainted.*reap\/cancel/);
    } finally { forgetExecutor(file); }
    // Corrupt records are never an empty executor set.
    fs.writeFileSync(path.join(dir, "ex-999-abcdef12.json"), "{bad");
    assert.match(overlayInterlock("local")!, /unreadable.*record|record.*unreadable/);
  } finally { f.close(); }
});

test("WP4: recovery cannot release an uncertain launch; a proven pre-launch stop or teardown releases it", () => {
  const f = fixture(); try {
    const id = f.turn("j_reap", { network: true, local_network: true }); reserveLaunch("j_reap", id, "local");
    const orphan = () => {
      const config = JSON.parse(getRun(f.run)!.config_json); config.params_json.launch_reservations[String(id)].owner = { pid: 2147483000, start: "dead" };
      db().prepare("UPDATE runs SET config_json=? WHERE id=?").run(JSON.stringify(config), f.run);
    };
    launchReservationState(f.run, id, "running"); orphan();
    reapLaunchReservations(f.run, () => ({ clean: false, problem: "native detached sweep unproven" }));
    assert.match(overlayInterlock("stage2")!, /tainted/);
    reapLaunchReservations(f.run, () => ({ clean: true })); assert.equal(overlayInterlock("stage2"), null);
    reserveLaunch("j_reap", id, "local"); orphan();
    reapLaunchReservations(f.run, () => { throw new Error("no backend was entered"); });
    assert.equal(overlayInterlock("stage2"), null);
  } finally { f.close(); }
});

test("WP4: two processes racing opposite starts cannot both reserve", async () => {
  const f = fixture(); const children: ReturnType<typeof spawn>[] = [];
  try {
    const a = f.turn("j_local", { network: true, local_network: true }), b = f.turn("j_stage2");
    const module = new URL("../dist/core/restart-overlay.js", import.meta.url).href;
    const child = (node: string, turn: number, mode: string) => {
      const code = `import {reserveLaunch,setOverlayClockForTests} from ${JSON.stringify(module)}; setOverlayClockForTests({wall:Date.now,mono:()=>1000,boot:()=>"unit",owner:()=>({pid:process.pid,start:"unit-start"})}); process.stdout.write("ready\\n"); process.stdin.once("data",()=>{try {reserveLaunch(${JSON.stringify(node)},${turn},${JSON.stringify(mode)});process.stdout.write("reserved\\n")}catch(e){process.stdout.write("blocked: "+e.message+"\\n")}process.stdin.pause()});`;
      const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: ["pipe", "pipe", "pipe"] }); children.push(p);
      let output = "", errors = ""; p.stdout!.on("data", x => output += x); p.stderr!.on("data", x => errors += x);
      const ready = new Promise<void>((resolve, reject) => { p.stdout!.on("data", () => { if (output.includes("ready\n")) resolve(); }); p.once("error", reject); p.once("exit", c => { if (!output.includes("ready\n")) reject(new Error(errors || `child exited ${c}`)); }); });
      const done = new Promise<string>((resolve, reject) => { p.once("error", reject); p.once("exit", c => c === 0 ? resolve(output) : reject(new Error(errors))); });
      return { p, ready, done };
    };
    const one = child("j_local", a, "local"), two = child("j_stage2", b, "stage2");
    await Promise.all([one.ready, two.ready]); one.p.stdin!.end("go"); two.p.stdin!.end("go");
    const outputs = await Promise.all([one.done, two.done]);
    assert.equal(outputs.filter(x => x.includes("reserved\n")).length, 1, outputs.join("\n"));
    assert.equal(outputs.filter(x => x.includes("blocked: launch reservation")).length, 1, outputs.join("\n"));
  } finally { for (const p of children) if (p.exitCode === null) p.kill("SIGKILL"); f.close(); }
});

test("WP4: cancel persists stopping; executor sweeps cannot release a lease without verified app-server cleanup", () => {
  const f = fixture(); try {
    const id = f.turn("j_cancel"); reserveLaunch("j_cancel", id, "stage2"); launchReservationState(f.run, id, "running");
    closeTurns("j_cancel", "cancelled", "unit cancellation");
    assert.match(overlayInterlock("local")!, /j_cancel stopping/);
    assert.throws(() => launchReservationState(f.run, id, "running"), /stopping/);
    assert.match(launchExecutorQuarantine(f.run, id)!, /untraceable app-server cleanup.*quarantine retained/);
    finishLaunchExecutor(f.run, id); assert.match(overlayInterlock("local")!, /stopping/);
    finishLaunchReservation(f.run, id, { clean: false, appClean: true, problem: "executor sweep uncertain" });
    assert.equal(launchExecutorQuarantine(f.run, id), undefined);
    finishLaunchExecutor(f.run, id); assert.equal(overlayInterlock("local"), null);
  } finally { f.close(); }
});
