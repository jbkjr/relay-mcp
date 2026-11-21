// A question put to the user stays theirs while ps cannot be run: a failed ps (a fork refused on a
// loaded machine) neither hands the request to the agent as unasked nor lets another server ask it
// again. Checked in the registry itself, with ps made to fail; no subprocesses.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
// Loaded for the scratch HOME every test file runs with (test guard); no harness is started.
import "./helpers.ts";
import { claimElicitation, elicitationState } from "../dist/core/approvals.js";
import { newInstance } from "../dist/core/caller.js";
import { closeDbForTests, db } from "../dist/core/db.js";
import { procStart } from "../dist/core/procs.js";

function scratch(t: TestContext): string {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "elicit-ps-")));
  const previous = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = path.join(tmp, "state");
  process.env.RELAY_CONFIG = path.join(tmp, "config.json");
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ allow_temp_home: true }));
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    closeDbForTests();
    procStart(process.pid, { fresh: true });
    for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return newInstance({ kind: "root" }, tmp, "claude").token;
}

/** From here on ps cannot be run, as when the machine refuses a fork. */
function psFails(t: TestContext): () => number {
  let calls = 0;
  const real = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", ((file: string, ...rest: unknown[]) => {
    if (file !== "/bin/ps") return (real as (...a: unknown[]) => unknown)(file, ...rest);
    calls++;
    return { pid: 0, status: null, signal: null, stdout: "", stderr: "", output: [], error: Object.assign(new Error("spawnSync /bin/ps EAGAIN"), { code: "EAGAIN" }) };
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  return () => calls;
}

test("elicitation: a question this server is asking stays asking while ps fails, so a waiting call does not hand it to the agent as unasked", (t) => {
  const token = scratch(t);
  assert.equal(claimElicitation("q_00000001", token), true);
  assert.notEqual(db().prepare("SELECT pid_start FROM elicitations").get()?.pid_start, null, "the asker's start time is recorded");
  assert.equal(elicitationState("q_00000001"), "asking");
  psFails(t);
  // Nothing read before is cached: relay's ordinary check cannot vouch for the asker now.
  assert.equal(procStart(process.pid, { fresh: true }), null);
  assert.equal(elicitationState("q_00000001"), "asking", "the question on the user's screen is still theirs");
  assert.equal(claimElicitation("q_00000001", token), false, "and is not asked again");
});

test("elicitation: another live server's question is neither handed over nor asked again while ps fails, and a dead one's is", (t) => {
  const token = scratch(t);
  // The test runner that started this file stands in for another relay server, alive throughout.
  const other = process.ppid;
  const start = procStart(other, { fresh: true });
  assert.ok(start, "the other server's start time is readable before ps fails");
  const insert = db().prepare("INSERT INTO elicitations (request_id, token, pid, pid_start, asked_at) VALUES (?, ?, ?, ?, ?)");
  insert.run("q_00000002", "other-token", other, start, Date.now());
  const calls = psFails(t);
  procStart(other, { fresh: true });
  assert.ok(calls() > 0, "ps was tried, and failed");
  assert.equal(elicitationState("q_00000002"), "asking", "a server not known to be gone is still asking");
  assert.equal(claimElicitation("q_00000002", token), false, "the user is not asked the same question twice");
  // A server whose pid is gone is known gone without ps: its question may be asked again.
  insert.run("q_00000003", "other-token", 2 ** 22 + 12345, start, Date.now());
  assert.equal(elicitationState("q_00000003"), null);
  assert.equal(claimElicitation("q_00000003", token), true);
});
