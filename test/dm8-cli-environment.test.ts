import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { CLI, harness } from "./helpers.ts";

test("DM8 terminal: approve, cancel and adopt refuse each launched-agent marker, even empty", async () => {
  const h = await harness();
  try {
    for (const command of ["approve", "cancel", "adopt"]) {
      for (const marker of ["RELAY_RUN_ID", "RELAY_NODE_ID"]) for (const value of ["launched", ""]) {
        const r = spawnSync(process.execPath, [CLI, command, "missing", "--to", "a".repeat(24)], { env: { ...h.env, [marker]: value }, cwd: h.repo, encoding: "utf8" });
        assert.equal(r.status, 2, `${command} ${marker}: ${r.stdout} ${r.stderr}`);
        assert.match(r.stderr, /person's own terminal/, `${command} ${marker}`);
      }
    }
    const own = spawnSync(process.execPath, [CLI, "approve", "missing"], { env: h.env, cwd: h.repo, encoding: "utf8" });
    assert.doesNotMatch(own.stderr, /person's own terminal/);
    assert.match(own.stdout, /unknown request/);
    assert.equal(own.status, 1, "an error result exits 1");
  } finally { await h.close(); }
});
