import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRecordedCancellation, processWarnings } from "../dist/core/session.js";
import type { TurnResult } from "../dist/backends/types.js";

const failed = (error = "app-server transport failed during teardown"): TurnResult => ({
  status: "failed", finalMessage: "", error, exitCode: 1,
});

test("a cancel recorded before backend teardown finishes remains cancelled", () => {
  const quarantine = "Codex login is not as relay left it: token path changed. QUARANTINE FAILED: permission denied. Do not use Codex yourself until these names are put right.";
  const result = applyRecordedCancellation({
    ...failed(quarantine), warnings: ["cleanup warning"],
    refusal: { family: "openai", category: "safety", message: "vendor safety refusal" },
  }, "cancelled");
  assert.equal(result.status, "interrupted");
  assert.equal(result.error, "cancelled");
  assert.equal(result.refusal, undefined);
  assert.deepEqual(result.warnings, ["cleanup warning", quarantine, "vendor safety refusal"]);
  assert.deepEqual(processWarnings(result), result.warnings, "the normal warning/redaction pipeline carries both reports");
});

test("a real backend failure is preserved when no cancel was recorded first", () => {
  const result = failed("failure before cancel");
  assert.equal(applyRecordedCancellation(result, "running"), result);
  assert.equal(applyRecordedCancellation(result, "failed"), result);
});
