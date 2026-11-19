import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import "./helpers.ts";

test("D9 upgrade 7: upgrade notes explicitly disclose native Codex subagent read-access loss", () => {
  const notes = fs.readFileSync(path.resolve(import.meta.dirname, "../docs/UPGRADING.md"), "utf8");
  assert.match(notes, /Native Codex subagents.*lose read access to their parent.s items/);
  assert.match(notes, /parent.*status.*result/);
});
