import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { alive, harness, reached, task, until } from "./helpers.ts";

const STUB = path.join(import.meta.dirname, "stubs", "stub-claude");

const started: number[] = [];
/** Starts the stub Claude Code on its own, outside relay, playing one rule; resolves with its exit code. */
function stub(dir: string, steps: Record<string, unknown>[], env: Record<string, string> = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const scenario = path.join(path.dirname(dir), "scenario.json");
  fs.writeFileSync(scenario, JSON.stringify({ rules: [{ steps }] }));
  const child = spawn(process.execPath, [STUB, "-p"], { env: { ...process.env, STUB_DIR: dir, STUB_SCENARIO: scenario, ...env }, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end("prompt");
  started.push(child.pid!);
  return new Promise<number | null>((resolve) => child.on("exit", resolve));
}
/** What p settles to, or "still waiting" if it has not after a generous while. */
const within = (p: Promise<unknown>) => Promise.race([p, new Promise((r) => setTimeout(() => r("still waiting"), 20000).unref())]);

test("stub agents: one held for a test that will never let it go gives up rather than waiting for good", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-")));
  try {
    // Its test is gone: the stub's directory has been removed, as the harness does when it closes.
    const orphaned = path.join(tmp, "a", "stub");
    const a = stub(orphaned, [{ signal: "holding" }, { await: "never" }, { reply: "never" }]);
    await until(() => fs.existsSync(path.join(orphaned, "holding")), 20000, "the stub to be held");
    fs.rmSync(orphaned, { recursive: true, force: true });
    assert.equal(await within(a), 1, "it gives up once its directory is gone, and says it failed");

    // Its test is still there but never lets it go: the stub gives up at its deadline.
    const forgotten = path.join(tmp, "b", "stub");
    const b = stub(forgotten, [{ await: "never" }, { reply: "never" }], { STUB_HOLD_MS: "500" });
    assert.equal(await within(b), 1);
  } finally {
    for (const pid of started) try { process.kill(pid, "SIGKILL"); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("stub agents: a vanishing stub's last words follow its death at once, however slowly programs start", async () => {
  // Relay gives an agent's output one second after the agent exits (a detached child may hold it
  // open for good). The vanishing stub's last words are written by a helper after the stub is gone,
  // so nothing the helper still has to start may stand between the death and the words. Here
  // starting a program takes two seconds, as it can on a loaded machine.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-")));
  try {
    const slow = path.join(tmp, "slow-bin");
    fs.mkdirSync(slow);
    for (const name of ["cat", "kill", "printf"]) {
      fs.writeFileSync(path.join(slow, name), `#!/bin/sh\n/bin/sleep 2\nPATH=/usr/bin:/bin exec ${name} "$@"\n`, { mode: 0o755 });
    }
    const dir = path.join(tmp, "stub");
    fs.mkdirSync(dir);
    const scenario = path.join(tmp, "scenario.json");
    fs.writeFileSync(scenario, JSON.stringify({ rules: [{ steps: [{ reply: "the last words", vanish: true }] }] }));
    const child = spawn(process.execPath, [STUB, "-p"], {
      env: { ...process.env, PATH: `${slow}:${process.env.PATH}`, STUB_DIR: dir, STUB_SCENARIO: scenario }, stdio: ["pipe", "pipe", "ignore"],
    });
    started.push(child.pid!);
    child.stdin.end("prompt");
    let out = "";
    let saidAt = 0;
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (!saidAt && out.includes('"result":"the last words"')) saidAt = Date.now();
    });
    const closed = once(child.stdout, "close");
    const [, signal] = await once(child, "exit");
    const exitAt = Date.now();
    await within(closed);
    assert.equal(signal, "SIGKILL", "the stub vanished: killed, with no shutdown");
    assert.ok(saidAt, `its last words came out: ${out}`);
    assert.ok(saidAt - exitAt < 1000, `its last words came ${saidAt - exitAt} ms after it exited`);
  } finally {
    for (const pid of started) try { process.kill(pid, "SIGKILL"); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("stub agents: the harness's close stops the stub's detached orphan, and nothing that is not it", async () => {
  const h = await harness([{ match: task("ORPHAN"), steps: [{ orphan: true }, { signal: "orphaned" }, { await: "never" }] }]);
  let closed = false;
  let orphan = 0;
  let decoy: ChildProcess | undefined;
  try {
    // The stub's turn is still running, so relay has not stopped what it started. A test that
    // failed now, before it had read the orphan's pid to kill it, would leave the orphan to close.
    await h.call("delegate", { target: "claude", task: "ORPHAN", mode: "read" });
    await until(() => reached(h, "orphaned"), 20000, "the stub to start its orphan");
    orphan = Number(fs.readFileSync(path.join(h.env.STUB_DIR, "orphan.pid"), "utf8"));
    assert.ok(alive(orphan));
    // A recorded pid that is no longer the orphan's (the pid reused by another process) is left alone.
    decoy = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    fs.appendFileSync(path.join(h.env.STUB_DIR, "orphans"), `${decoy.pid}\n`);
    closed = true;
    await h.close();
    await until(() => !alive(orphan), 10000, "the orphan to be stopped");
    assert.ok(alive(decoy.pid!), "a process that is not the stub's orphan is not stopped");
  } finally {
    if (orphan) try { process.kill(orphan, "SIGKILL"); } catch {}
    decoy?.kill("SIGKILL");
    if (!closed) await h.close();
  }
});
