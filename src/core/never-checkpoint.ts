import fs from "node:fs";
import { configPath, validateConfig, withDefaults } from "./config.js";
import { db, getRun, runConfig, tx } from "./db.js";
import { mergeNeverPolicies, neverIdentityProblem, resolveNeverPolicy, validateNeverPolicy, type NeverPolicy } from "./never-policy.js";

interface FloorRecord { policy: NeverPolicy; configRequired: boolean }
function floorOf(runId: string): FloorRecord | null {
  const run = getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const params = JSON.parse(run.config_json).params_json;
  if (params === undefined) return null; // Existing schema-4 runs have no private params.
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("malformed private run params");
  if (!Object.hasOwn(params, "never_floor")) return null;
  const saved = params.never_floor as FloorRecord;
  if (!saved || typeof saved.configRequired !== "boolean") throw new Error("malformed durable never floor");
  return { policy: validateNeverPolicy(saved.policy), configRequired: saved.configRequired };
}
export const readNeverFloor = (runId: string): NeverPolicy | null => floorOf(runId)?.policy ?? null;

/** Recheck under the consumer's transaction / last prelaunch gate, after asynchronous work. */
export function assertNeverCurrent(runId: string, expectedHash: string): NeverPolicy {
  const floor = readNeverFloor(runId);
  if (!floor || floor.hash !== expectedHash) throw new Error("never policy changed after the checkpoint; rebuild the launch plan or request a fresh decision");
  const why = neverIdentityProblem(floor); if (why) throw new Error(why);
  return floor;
}

/**
 * The launch gate. A turn's proxy keeps the addresses it was launched with, so a plan built before
 * the floor gained an address would permit it once it stops being local, which the floor refuses.
 * Link-local addresses are left out: macOS rotates them by itself and proxies never dial them.
 */
export function assertNeverLaunchCurrent(runId: string, captured: NeverPolicy): void {
  const added = assertNeverCurrent(runId, captured.hash).localAddresses.filter(a => !captured.localAddresses.includes(a) && !/^(fe[89ab]|169\.254\.)/i.test(a));
  if (added.length) throw new Error(`this Mac gained ${added.join(", ")} after the launch plan was built, so nothing was started; send the turn again`);
}

/**
 * A checkpoint commits the observed union BEFORE a caller's approval/launch transaction. BEGIN
 * IMMEDIATE serializes processes, including reload, so concurrent observations cannot lose entries.
 * Failures never update the floor. Do not call from inside another registry transaction.
 */
export function checkpointNever(runId: string, _phase: "grant" | "approval" | "decision" | "launch" | "tool"): NeverPolicy {
  return tx(() => {
    const previous = floorOf(runId);
    let configRequired = previous?.configRequired ?? false;
    let current;
    try {
      const text = fs.readFileSync(configPath(), "utf8");
      current = withDefaults(validateConfig(JSON.parse(text), configPath()));
      configRequired = true;
    } catch (err) {
      // A never-created optional config is valid; a disappearing observed config is not.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || configRequired) throw new Error(`never checkpoint cannot load config ${configPath()}: ${(err as Error).message}`);
      current = withDefaults({});
    }
    const observed = resolveNeverPolicy({ never: current.never, codexHome: (current.targets.codex as { home?: string }).home });
    // A run's captured additions count even before its first live checkpoint; edited removals do
    // not replace them. Eligible removals must already be present when the run starts.
    const baseline = previous?.policy ?? (() => {
      const cfg = runConfig(runId);
      return resolveNeverPolicy({ never: cfg.never, codexHome: (cfg.targets.codex as { home?: string }).home });
    })();
    const policy = mergeNeverPolicies(baseline, observed);
    // Only the private params member changes; the captured config and other state stay intact.
    db().prepare("UPDATE runs SET config_json = json_set(config_json, '$.params_json.never_floor', json(?)) WHERE id = ?")
      .run(JSON.stringify({ policy, configRequired }), runId);
    return policy;
  });
}
