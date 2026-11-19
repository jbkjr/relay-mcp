// Same ordering as the live file: helpers must isolate HOME before relay captures it.
import "./helpers.ts";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { capturedRootEnvironment, runtimeEnvironment, selectEnvironment } from "../dist/core/env-policy.js";
import { relayHome, withDefaults } from "../dist/core/config.js";
import { LiveScope } from "./live-scope.ts";

test("live root authority, worker and registry share the scratch home captured at import", () => {
  assert.equal(capturedRootEnvironment.HOME, os.homedir());
  const worker = runtimeEnvironment(capturedRootEnvironment);
  assert.equal(worker.HOME, process.env.HOME);
  assert.equal(worker.RELAY_HOME ?? path.join(worker.HOME!, ".local/state/relay"), relayHome());
  const child = selectEnvironment("claude", withDefaults({}), capturedRootEnvironment, []);
  assert.equal(child.env.HOME, process.env.HOME);
});

test("live cleanup interrupts a hung turn, stops it before listeners and runs every closer on failure", async () => {
  const scope = new LiveScope(), order: string[] = [];
  // The turn is registered before startup has finished acquiring its broker.
  const turn = scope.defer(() => { order.push("turn"); }, 10);
  const model = scope.defer(() => { order.push("model"); }, -20);
  scope.defer(() => { order.push("broker"); throw new Error("fixture close failure"); }, -10);
  const hung = scope.wait(new Promise(() => {}));
  const rejected = assert.rejects(hung, /live test ended/);
  await assert.rejects(scope.close(), /cleanup failed/);
  await rejected;
  assert.deepEqual(order, ["turn", "broker", "model"]);
  await turn(); await model();
  assert.equal(order.length, 3, "normal finally and timeout cleanup share one stop");
});

test("a resource finishing allocation after cancellation is still stopped", async () => {
  const scope = new LiveScope();
  await scope.close();
  let stopped = false;
  await scope.defer(() => { stopped = true; })();
  assert.ok(stopped);
});
