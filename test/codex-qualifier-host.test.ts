// Lead runs outside the delegated sandbox. No Codex, network, model, keychain or LaunchAgent.
// RELAY_QUALIFIER_HOST_CHECKS=1 node --test --test-timeout=60000 test/codex-qualifier-host.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import "./helpers.ts";
import { processTable, ProcessSupervisor } from "../scripts/codex-qualify/codex-qualifier-process.mjs";

const enabled = process.env.RELAY_QUALIFIER_HOST_CHECKS === "1";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (const mode of ["timeout", "SIGTERM"]) test(`qualifier host watchdog: ${mode} stops detached groups and orphaned grandchildren`, { skip: !enabled }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qualifier-host-")));
  const pidsFile = path.join(root, "pids.json"), worker = path.join(root, "worker.mjs");
  const helper = pathToFileURL(path.resolve(import.meta.dirname, "../scripts/codex-qualify/scratch-env.mjs")).href;
  fs.writeFileSync(worker, `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { scratchEnv } from ${JSON.stringify(helper)};
const root = ${JSON.stringify(root)};
const env = scratchEnv(root);
const orphanCode = ${JSON.stringify("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")};
const middleCode = \`import fs from 'node:fs'; import {spawn} from 'node:child_process';
  const grand = spawn(process.execPath,['-e',\${JSON.stringify(orphanCode)}],{env:\${JSON.stringify(env)},detached:true,stdio:'ignore'});
  fs.writeFileSync(\${JSON.stringify(root + "/grand.json")},JSON.stringify(grand.pid));grand.unref();\`;
const detached = spawn(process.execPath,['-e',orphanCode],{env:scratchEnv(root),detached:true,stdio:'ignore'});
const middle = spawn(process.execPath,['--input-type=module','-e',middleCode],{env:scratchEnv(root),detached:true,stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify([process.pid,detached.pid,middle.pid]));
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`);
  const supervisor = new ProcessSupervisor(root, { graceMs: 2000, pollMs: 20 });
  const identities = new Map<number, string>();
  const recordedPids = () => [
    ...(fs.existsSync(pidsFile) ? JSON.parse(fs.readFileSync(pidsFile, "utf8")) : []),
    ...(fs.existsSync(path.join(root, "grand.json")) ? [JSON.parse(fs.readFileSync(path.join(root, "grand.json"), "utf8"))] : []),
  ];
  const fixtureRows = () => {
    const pids = new Set(recordedPids());
    const rows = processTable(root).filter((row: any) => pids.has(row.pid));
    for (const row of rows) if (!identities.has(row.pid)) identities.set(row.pid, row.start);
    return rows;
  };
  t.after(async () => {
    // A broken watchdog must not also break the test's fixture cleanup. Independently kill the
    // recorded fixture identities/groups, even when the sweep or an assertion has failed.
    try { await supervisor.terminate(); }
    finally {
      for (const row of fixtureRows()) if (row.start === identities.get(row.pid) && !row.stat.startsWith("Z")) {
        for (const pid of row.pid === row.pgid ? [-row.pid, row.pid] : [row.pid]) {
          try { process.kill(pid, "SIGKILL"); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
        }
      }
      const end = Date.now() + 2000;
      while (recordedPids().some(alive) && Date.now() < end) await delay(20);
      assert.equal(recordedPids().some(alive), false, "fixture cleanup left a recorded PID alive; scratch evidence retained");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const completed = assert.rejects(supervisor.run(process.execPath, [worker], { inspect: true, timeoutMs: mode === "timeout" ? 3000 : 15_000 }), mode === "timeout" ? /timeout/ : /SIGTERM/);
  completed.catch(() => {}); // Attach immediately while readiness assertions inspect the orphan.
  try {
    const end = Date.now() + 10_000;
    let orphan;
    while (!orphan) {
      const rows = fixtureRows();
      const grand = fs.existsSync(path.join(root, "grand.json")) ? JSON.parse(fs.readFileSync(path.join(root, "grand.json"), "utf8")) : null;
      orphan = rows.find((row: any) => row.pid === grand && row.ppid === 1);
      if (Date.now() > end) throw new Error("fixture grandchild did not become an orphan");
      if (!orphan) await delay(20);
    }
    assert.equal(orphan.pgid, orphan.pid, "the orphan must have its own session/group");
    assert.ok(orphan.command.includes(`CODEX_HOME=${root}/codex-home`), "macOS inventory must include the orphan's scratch environment");
    assert.ok(supervisor.scan().some((row: any) => row.pid === orphan.pid), "watchdog must discover the orphan independently of its former parent");
    if (mode === "SIGTERM") supervisor.cancel("SIGTERM/logout");
    await completed;
  } finally { supervisor.cancel("SIGTERM: fixture cleanup"); await completed; }
  assert.ok(fs.existsSync(path.join(root, "grand.json")), "the orphan control actually ran");
  const pids = recordedPids(), end = Date.now() + 2000;
  while (pids.some(alive) && Date.now() < end) await delay(20); // Allow launchd to reap exited orphans.
  for (const pid of pids) assert.equal(alive(pid), false, `fixture PID ${pid} survived`);
  assert.deepEqual(supervisor.scan(), []);
});
