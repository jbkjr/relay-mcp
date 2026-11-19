import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers.ts";

test("caller snapshots store a compact reason code while live diagnostics retain their explanation", async () => {
  const { newInstance } = await import("../dist/core/caller.js");
  const { callIdentity } = await import("../dist/core/identity.js");
  for (const [clientName, desktopEntry, singletonViolation, expected] of [
    ["claude-code", false, false, "dedicated-process"],
    ["claude.ai", true, false, "shared-process"],
    ["unknown", false, false, "unqualified-process"],
    ["claude-code", false, true, "singleton-violation"],
  ] as const) {
    const inst = newInstance({ kind: "root" }, "/", "claude");
    Object.assign(inst, { clientName, desktopEntry, singletonViolation });
    const identity = callIdentity(inst, undefined, "2025-11-25");
    assert.equal(Object.hasOwn(identity.snapshot.session, "reason"), false, "snapshots must not repeat diagnostic prose");
    assert.equal(identity.snapshot.session.reason_code, expected);
    assert.ok(identity.session.reason.length > 50, "the diagnostic shown to the caller remains descriptive");
  }
});

test("caller snapshot history keeps the first and most recent twenty on every contribution recipient", async () => {
  const { newInstance } = await import("../dist/core/caller.js");
  const { callIdentity } = await import("../dist/core/identity.js");
  const { addContribution } = await import("../dist/core/families.js");
  const { createRun, insertNode, getNode, closeDbForTests } = await import("../dist/core/db.js");
  const { withDefaults } = await import("../dist/core/config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-snapshots-"));
  const oldHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = dir;
  try {
    const run = createRun(dir, withDefaults({}), "snapshot-root");
    for (const [id, kind, params] of [
      ["snapshot-job", "job", {}],
      ["snapshot-review", "review", {}],
      ["snapshot-discussion", "discussion", { borrowed: true, participant: "snapshot-job", review_id: "snapshot-review" }],
    ] as const) insertNode({ id, run_id: run, kind, mode: "read", depth: 1, task: "snapshots", cwd: dir, params_json: JSON.stringify(params) });
    const inst = newInstance({ kind: "root" }, dir, "claude");
    inst.clientName = "claude-code";
    const contributions = Array.from({ length: 35 }, () => callIdentity(inst, undefined, "2025-11-25").contribution);
    for (const contribution of contributions) addContribution("snapshot-discussion", contribution);
    const expected = [contributions[0], ...contributions.slice(-20)].map((c) => c.snapshot!.call_id);
    const histories = () => ["snapshot-job", "snapshot-review", "snapshot-discussion"].map((id) => JSON.parse(getNode(id)!.params_json!).caller_snapshots);
    for (const history of histories()) assert.deepEqual(history.map((s: any) => s.call_id), expected, "keep the origin plus latest twenty, including propagated contributions");
    addContribution("snapshot-discussion", contributions.at(-1)!);
    for (const history of histories()) assert.equal(history.length, 21, "repeated delivery does not duplicate a retained snapshot");
  } finally {
    closeDbForTests();
    if (oldHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
