// The directories projectless consults are asked in (caller.ts newConsultDir): what a file request
// or a harness's path check may reach there (approvals.ts offLimits, review r_f1c46bd4).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers.ts";

test("consult directories: a thread's own is its own to reach; the parent all of them share, and every other thread's, no approval reaches", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-consult-")));
  const saved = process.env.RELAY_HOME;
  process.env.RELAY_HOME = path.join(tmp, "home");
  fs.mkdirSync(process.env.RELAY_HOME);
  try {
    const { offLimits } = await import("../dist/core/approvals.js");
    const { consultHome } = await import("../dist/core/config.js");
    const own = path.join(consultHome(), "c-aaaaaa");
    const thread = { cwd: own, worktree: null };
    for (const what of ["reach", "change"] as const) assert.equal(offLimits(thread, [path.join(own, "notes.md")], what), null, what);
    // A sibling, also one named as this one in another case (a different directory on a disk that tells case apart).
    for (const p of [path.join(consultHome(), "c-bbbbbb", "AGENTS.md"), path.join(consultHome(), "c-AAAAAA", "AGENTS.md"), path.join(consultHome(), "CLAUDE.md")]) {
      for (const what of ["reach", "change"] as const) assert.match(String(offLimits(thread, [p], what)), /is inside relay's own directories/, `${what} ${p}`);
    }
    // A thread recorded at the parent itself has no directory of its own there.
    assert.match(String(offLimits({ cwd: consultHome(), worktree: null }, [path.join(consultHome(), "CLAUDE.md")], "change")), /is inside relay's own directories/);
    // Nor has a job anywhere else.
    assert.match(String(offLimits({ cwd: tmp, worktree: null }, [path.join(own, "x")], "change")), /is inside relay's own directories/);
    // The parent itself, which holds every thread's directory, is refused to a path check.
    assert.match(String(offLimits(thread, [consultHome()], "reach")), /is inside relay's own directories/);
  } finally {
    if (saved === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
