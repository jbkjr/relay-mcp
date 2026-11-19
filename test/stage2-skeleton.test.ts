import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.ts";
import { localModeInterlock, rawNetworkGrantProblem, stage2Enabled, STAGE2_FLAG_ENV } from "../dist/core/raw-network.js";
import { stage2Wanted, turnConfinement } from "../dist/backends/codex-stage2.js";
import { withDefaults } from "../dist/core/config.js";
import { targetDef } from "../dist/targets/index.js";

// The stage-2 skeleton (docs/codex-confinement-design.md §13): switched off, nothing changes. Each
// work package replaces or extends these checks as it fills in its module.

test("stage 2 skeleton: off unless the switch is set, and inert while off", () => {
  assert.equal(stage2Enabled({}), false);
  assert.equal(stage2Enabled({ [STAGE2_FLAG_ENV]: "0" }), false);
  assert.equal(stage2Enabled({ [STAGE2_FLAG_ENV]: "1" }), true);
  const saved = process.env[STAGE2_FLAG_ENV];
  delete process.env[STAGE2_FLAG_ENV];
  try {
    const spec = { config: withDefaults({}), target: targetDef("codex"), grant: { network: true, raw_network: true } };
    assert.equal(stage2Wanted(spec as never), false);
    assert.equal(turnConfinement(spec as never), "verified");
    assert.equal(localModeInterlock("local"), null);
    assert.equal(rawNetworkGrantProblem({ network: true }, "write", "codex"), null);
    assert.match(rawNetworkGrantProblem({ network: true, raw_network: true }, "write", "codex") ?? "", /not available/);
  } finally {
    if (saved !== undefined) process.env[STAGE2_FLAG_ENV] = saved;
  }
});
