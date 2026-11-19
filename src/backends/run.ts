// Running one turn of a target's CLI: the version gate, then the target's backend, which runs it
// through streamTurn (stream.ts: one JSON event per line from the agent's stdout) or by itself.
import type { RelayConfig, Target } from "../core/config.js";
import { olderVersion, targetDef, type TargetDef } from "../targets/index.js";
import { installedVersion } from "./cli-version.js";
import { linkLaunchProblem } from "./native-temp.js";
import { BACKENDS } from "./index.js";
import { type Backend, type TurnHandle, type TurnSpec } from "./types.js";
import { capturedRootEnvironment, selectEnvironment } from "../core/env-policy.js";
import { targetLaunchProblem } from "../core/protected-config.js";
import { endpointProblem } from "./env.js";
import { withTurnSecrets } from "../core/secrets.js";
import { freezeCodexConfig } from "./codex-pin.js";
import { assertNeverAdapter } from "./never-admission.js";

/**
 * Why this machine cannot run the target with the confinement relay describes, or null. What
 * relay asks of each CLI's sandbox was verified on macOS with particular CLI versions; anywhere
 * else it is a guess, and relay does not launch an agent on a guess unless told to.
 */
export function untested(target: Target, config: RelayConfig, environment?: NodeJS.ProcessEnv, checkVersion = true): string | null {
  // An experimental target needs its own opt-in; allow_untested is about platforms and versions.
  const def = targetDef(target);
  if (!def.qualified && !config.targets[target]?.experimental) {
    return `${def.name} is experimental: relay has not qualified it with a signed-in run, so its login, model selection and protocol behaviour are unverified. Set targets.${target}.experimental to true in relay's config to run it anyway.`;
  }
  if (config.allow_untested) return null;
  const off = 'Set "allow_untested": true in relay\'s config to run anyway, unverified.';
  if (process.platform !== "darwin") return `relay's confinement has only been verified on macOS, and this is ${process.platform}. ${off}`;
  if (!checkVersion) return null;
  const env = environment ?? selectEnvironment(target, config, capturedRootEnvironment).env;
  const endpoint = endpointProblem(target, env);
  if (endpoint) return endpoint;
  const bin = config.targets[target].bin;
  const have = installedVersion(target, bin, env);
  const min = targetDef(target).tested;
  const problem = !have ? `relay could not read a version from \`${bin} --version\``
    : olderVersion(have, min) ? `${bin} is ${have.join(".")}, older than the ${min.join(".")} relay's confinement was verified with` : null;
  return problem ? `${problem}. Update it, or: ${off}` : null;
}

/**
 * Starts one turn of `target`'s CLI, refusing, by rejecting, a version or platform its confinement
 * was not verified on, and whatever its backend refuses. `backend` is the target's own, unless a
 * test passes another.
 */
export async function launchTurn(target: TargetDef, spec: TurnSpec, backend: Backend = BACKENDS[target.id]): Promise<TurnHandle> {
  assertNeverAdapter(spec);
  if (target.id === "codex") spec = { ...spec, config: freezeCodexConfig(spec.config) };
  const refusal = untested(target.id, spec.config, undefined, false);
  if (refusal) throw new Error(refusal);
  return withTurnSecrets(() => backend.start({ ...spec, checkEnvironment: (env) => {
    const problem = untested(target.id, spec.config, env);
    if (problem) throw new Error(problem);
    // Claude's long-home link ceiling, on the read of the environment Claude is launched with (native-temp.ts).
    const link = target.id === "claude" ? linkLaunchProblem(spec.config, env) : null;
    if (link) throw new Error(link);
    // The CLI as this turn's PATH finds it, which is what its launch runs: not in a write path (review r_0c11d860 X1).
    const writes = spec.access === "write" ? spec.grant?.write_paths ?? [] : [];
    const launch = targetLaunchProblem(`the ${target.id} target's CLI`, spec.config.targets[target.id].bin, env.PATH ?? "", writes);
    if (launch) throw new Error(launch);
    spec.checkEnvironment?.(env);
  } }), { reuse: true });
}
