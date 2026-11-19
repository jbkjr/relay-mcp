import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { alive, until } from "./helpers.ts";
import { withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun, getNode, getTurn, insertNode, insertTurn } from "../dist/core/db.js";
import { ensureWorker } from "../dist/core/dispatch.js";
import { turnEnvironment, workerEnvironment } from "../dist/core/env-broker.js";

for (const failure of ["missing", "unreachable"] as const) test(`tool env broker: ${failure} address starts a worker and settles its queued turn as failed`, async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "env-failure-")));
  const saved = { ...process.env };
  const unknownRootValue = "unvouched-root-value-81x";
  Object.assign(process.env, { RELAY_HOME: dir, RELAY_CONFIG: path.join(dir, `${unknownRootValue}.json`) });
  if (failure === "missing") delete process.env.RELAY_ENV_SOCKET;
  else process.env.RELAY_ENV_SOCKET = path.join(dir, "absent.sock");
  const cfg = withDefaults({ allow_temp_home: true });
  fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify(cfg));
  fs.writeFileSync(path.join(dir, "housekeeping"), "fixture: no shared-temp sweep");
  const run = createRun(dir, cfg, "synthetic-absent-root");
  const node = "t_00000001";
  insertNode({ id: node, run_id: run, kind: "thread", target: "codex", mode: "read", depth: 1, task: "must never launch", cwd: dir });
  const turn = insertTurn(node, "caller", `must never launch ${unknownRootValue}`, "read");
  // After the startup claim fails, housekeeping will report this invalid file's path. The
  // worker cannot know its root's values, so the whole diagnostic must be withheld.
  fs.writeFileSync(process.env.RELAY_CONFIG!, "{");
  t.after(() => {
    const pid = getNode(node)?.worker_pid;
    if (pid && pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    closeDbForTests();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(workerEnvironment(run).RELAY_ENV_SOCKET, process.env.RELAY_ENV_SOCKET);
  assert.doesNotThrow(() => ensureWorker(node), "broker absence must reach the worker's recorded failure path");
  await until(() => getNode(node)?.status === "failed" && getNode(node)?.worker_pid === null, undefined, "unavailable-broker worker to settle");
  assert.equal(getTurn(turn)?.status, "failed");
  assert.match(getTurn(turn)?.error ?? "", /owning root.*environment broker/);
  assert.match(getNode(node)?.error ?? "", /restart the root/);
  assert.equal(getNode(node)?.session_id, null, "no harness reached a session");
  assert.equal(getTurn(turn)?.prompt_path, null, "no prompt copy is written before startup redaction succeeds");
  const log = path.join(dir, "runs", run, "nodes", node, "worker.log");
  await until(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("diagnostic withheld"), undefined, "unvouched housekeeping diagnostics to be withheld");
  assert.equal(fs.readFileSync(log, "utf8").includes(unknownRootValue), false);
});

for (const failure of ["missing", "connect-error", "closed", "unresponsive", "malformed"] as const) {
  test(`tool env broker: ${failure} cannot leave an environment claim pending`, async (t) => {
    const saved = process.env.RELAY_ENV_SOCKET;
    t.after(() => { if (saved === undefined) delete process.env.RELAY_ENV_SOCKET; else process.env.RELAY_ENV_SOCKET = saved; });
    if (failure === "missing") delete process.env.RELAY_ENV_SOCKET;
    else process.env.RELAY_ENV_SOCKET = "/synthetic/root.sock";
    const sock = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    t.mock.method(net, "connect", () => {
      queueMicrotask(() => {
        if (failure === "connect-error") sock.emit("error", new Error("synthetic connection refused"));
        else if (failure === "closed") sock.destroy();
        else { sock.emit("connect"); if (failure === "malformed") sock.push("not JSON\n"); }
      });
      return sock;
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const rejected = assert.rejects(turnEnvironment(123), /owning root.*broker.*restart the root/);
    if (failure === "unresponsive") t.mock.timers.tick(10_000);
    await rejected;
    sock.destroy();
  });
}

test("tool env broker: pending person consent outlives the transport deadline and still releases only a final selection", async (t) => {
  const saved = process.env.RELAY_ENV_SOCKET;
  process.env.RELAY_ENV_SOCKET = "/synthetic/root.sock";
  t.after(() => { if (saved === undefined) delete process.env.RELAY_ENV_SOCKET; else process.env.RELAY_ENV_SOCKET = saved; });
  const sock = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  t.mock.method(net, "connect", () => sock);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const release = turnEnvironment(123).finally(() => { settled = true; });
  // Fragmented acknowledgement and a later final frame exercise streaming, not one data event.
  sock.emit("data", '{"pending":'); sock.emit("data", 'true,"timeoutMs":120000}\n');
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(settled, false);
  const response = { selection: { env: { JAVA_HOME: "/synthetic/java" }, releasedNames: ["JAVA_HOME"] }, config: withDefaults({}) };
  sock.emit("data", JSON.stringify({ ...response, redactionValues: [] }) + "\n");
  assert.deepEqual(await release, response);
});

test("tool env broker: an acknowledged consent claim still fails if its owner stops answering", async (t) => {
  const saved = process.env.RELAY_ENV_SOCKET;
  process.env.RELAY_ENV_SOCKET = "/synthetic/root.sock";
  t.after(() => { if (saved === undefined) delete process.env.RELAY_ENV_SOCKET; else process.env.RELAY_ENV_SOCKET = saved; });
  const sock = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  t.mock.method(net, "connect", () => sock);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(turnEnvironment(123), /broker is unavailable, unresponsive or closed/);
  sock.emit("data", '{"pending":true,"timeoutMs":120000}\n');
  t.mock.timers.tick(120_000);
  await rejected;
});
