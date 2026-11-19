// The environment a launched agent gets: relay's own variables set afresh, credentials removed as
// the target signs in, the host session's own variables kept out, and an endpoint that would send
// the CLI elsewhere refused. Built once per turn, checked, in the backend's prepare (agentEnv).
import { authFor, relayHome, worktreesHome, type RelayConfig, type Target } from "../core/config.js";
import { CREDENTIALS, TARGETS, targetDef, targetLabel } from "../targets/index.js";
import type { TurnSpec } from "./types.js";
import { backendEnvironmentRoots, capturedRootEnvironment, effectiveChildEnv, mandatoryEnvironmentReason, selectEnvironment } from "../core/env-policy.js";
import { registerReleasedEnvironment } from "../core/secrets.js";

/**
 * The credential variables removed from a target's environment, or null for none.
 *  - Signing in with its login (child_auth "login", the default): every vendor's credentials,
 *    its own included, so that the CLI uses its stored login and no agent is handed another
 *    vendor's keys.
 *  - child_auth "any", global or target-local: every other vendor's credentials; only its own
 *    may pass, and still require selection by child_env. The old global exception ended in 1.0.
 */
export function scrubbedCredentials(target: Target, config: RelayConfig): RegExp | null {
  const own = config.targets[target]?.child_auth;
  if ((own ?? config.child_auth) === "login") return CREDENTIALS;
  // Another family's target, or one whose family is per model (not this target's own family either way).
  const def = targetDef(target);
  const others = TARGETS.filter((t) => t.id !== target && (t.vendor === null || def.vendor === null || t.vendor !== def.vendor));
  return others.length ? new RegExp(others.map((t) => `(?:${t.credentialEnv.source})`).join("|")) : null;
}

/**
 * What Claude Code's desktop app and other Agent SDK hosts put in the environment of the MCP
 * servers they start, relay's included: markers that say such a host is running, and the endpoint
 * of the host's own session (ANTHROPIC_BASE_URL), which is the host's connection, not the user's
 * choice of endpoint for agents relay launches (experiments/answers.md, Claude desktop app).
 */
const HOST_SESSION_MARKERS = ["CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_AGENT_SDK_VERSION"] as const;
/** Whether relay runs under the Claude desktop app or another Agent SDK host (an empty marker does not count). */
export const hostSession = (env: NodeJS.ProcessEnv = capturedRootEnvironment): boolean => HOST_SESSION_MARKERS.some((m) => Boolean(env[m]));
/**
 * Whether `key` belongs to the host session relay runs in and is kept from every launched agent:
 * the markers always, and Anthropic's endpoint variables when relay runs under such a host and
 * Claude signs in with its login ("child_auth" "login" for Claude). Under that setting the
 * credentials that go with an endpoint are removed too, so the agent goes to Anthropic on its own
 * login, which the init check verifies along with the model. Where Claude may sign in with a key,
 * removing the endpoint would send the key meant for it to Anthropic (or to a nested agent that
 * would), so the endpoint stays and Claude's endpoint check refuses it, as it does without a host:
 * there the person set the variable, and relay does not quietly undo that.
 */
function hostSessionVariable(key: string, config: RelayConfig, env: NodeJS.ProcessEnv = capturedRootEnvironment): boolean {
  // Codex lets an embedding app override clientInfo's originator with this variable. A relay
  // child must identify as relay, not inherit the root's T3 identity (or another app's).
  if (key === "CODEX_INTERNAL_ORIGINATOR_OVERRIDE") return true;
  if ((HOST_SESSION_MARKERS as readonly string[]).includes(key)) return true;
  return hostSession(env) && authFor(config, "claude") === "login" && targetDef("claude").endpointEnv.test(key);
}

/** The released names each environment childEnv built actually carries, by that environment. */
const releasedNames = new WeakMap<NodeJS.ProcessEnv, readonly string[]>();
/**
 * The names relay released to a turn (a standing child_env.pass, a person-approved grant.env) that
 * the agent environment childEnv (or agentEnv) built for it carries, sorted: names only. Empty for
 * an environment childEnv did not build. A backend reads it straight after building the
 * environment, for a note about what the harness then does with those names (codex-shell-policy.ts).
 */
export function releasedIn(env: NodeJS.ProcessEnv): readonly string[] {
  return releasedNames.get(env) ?? [];
}

/**
 * Environment for the agent process. Credentials are removed as scrubbedCredentials says, and the
 * host session's own variables as hostSessionVariable says; the backend removes what identifies
 * the parent session. Relay's own variables are set afresh.
 */
export function childEnv(spec: TurnSpec, scrub: (key: string) => boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  /** What the loop below copied from the selection: a released name is delivered only if it was. */
  const copied = new Set<string>();
  const selected = spec.environment !== undefined ? { env: spec.environment, releasedNames: spec.environmentReleased ?? effectiveChildEnv(spec.config, spec.target.id).pass } : selectEnvironment(spec.target.id, spec.config, capturedRootEnvironment);
  const credentials = scrubbedCredentials(spec.target.id, spec.config);
  // What else would take the place of this target's stored login, when it signs in with that login.
  const login = authFor(spec.config, spec.target.id) === "login" ? spec.target.loginEnv : undefined;
  for (const [k, v] of Object.entries(selected.env)) {
    if (v === undefined) continue;
    if (mandatoryEnvironmentReason(spec.target.id, spec.config, k, capturedRootEnvironment)) continue;
    if (k.startsWith("RELAY_") && k !== "RELAY_CONFIG") continue;
    if (credentials?.test(k)) continue;
    if (hostSessionVariable(k, spec.config)) continue;
    // Another family's CLI needs none of Claude's session/launch variables. Keep its config
    // directory (nested Claude turns need the user's deny rules), but no parent identity or mode.
    // Claude's own backend handles its auth/provider exceptions when Claude is the child.
    if (spec.target.id !== "claude" && (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_"))) continue;
    // The root session's inbox, so that an agent does not find it by inheritance. Not a gate: on
    // macOS the token is optional, and a session that prompts for permissions takes an unverified
    // message from any process of the user's that reaches the socket (answers.md P-d).
    if (k === "CLAUDE_CODE_MESSAGING_SOCKET" || k === "CLAUDE_CODE_MESSAGING_TOKEN") continue;
    if (login?.test(k)) continue;
    if (scrub(k)) continue;
    env[k] = v;
    copied.add(k);
  }
  registerReleasedEnvironment(env, selected.releasedNames);
  // Relay's own variables, set below, are backend-owned and never released (mandatoryEnvironmentReason).
  releasedNames.set(env, [...new Set(selected.releasedNames)].filter((n) => copied.has(n)).sort());
  Object.assign(env, backendEnvironmentRoots(spec.target.id, spec.environment ?? capturedRootEnvironment));
  // pnpm hard-links packages from its store into node_modules; relay refuses a write turn whose
  // worktree holds a file linked to one outside it (src/confine/hardlinks.ts), so it copies instead.
  // This is pnpm's own variable (pnpm_config_<kebab setting>), which pnpm reads from version 11 on;
  // an older pnpm ignores it and keeps hard-linking, and its job's next write turn may then be refused
  // by the hard-link check (pnpm 10 users can set package-import-method=copy in their own pnpm
  // config). The npm_config_ form is npm's, which has no such setting.
  env.pnpm_config_package_import_method = "copy";
  env.RELAY_HOME = relayHome();
  // Passed down so that a nested job's worktree lands where the root's does.
  env.RELAY_WORKTREES = worktreesHome();
  env.RELAY_RUN_ID = spec.markers.runId;
  env.RELAY_NODE_ID = spec.markers.nodeId;
  env.RELAY_DEPTH = String(spec.markers.depth);
  return env;
}

/**
 * Why a target must not be launched with this environment, or null: it carries a variable that
 * points the CLI at another endpoint, so that relay could not tell which model family answers.
 */
export function endpointProblem(target: Target, env: NodeJS.ProcessEnv): string | null {
  const def = targetDef(target);
  const set = Object.keys(env).filter((k) => def.endpointEnv.test(k)).sort();
  if (!set.length) return null;
  return `the environment relay would give ${targetLabel(def)} sets ${set.join(", ")}, which sends ${def.product} to another endpoint than its vendor's, where relay cannot tell which family of model answers. ` +
    "Relay reaches other families only, so it does not launch it this way. Unset it in the environment relay runs in";
}

/**
 * The agent's environment for a turn (childEnv), checked: it throws the endpoint problem, with
 * `hint` after it, rather than return an environment relay must not launch with. A backend builds
 * it once, first thing in its prepare, before its other refusals (review C6), and uses that one.
 */
export function agentEnv(spec: TurnSpec, scrub: (key: string) => boolean, hint = ""): NodeJS.ProcessEnv {
  const env = childEnv(spec, scrub);
  const endpoint = endpointProblem(spec.target.id, env);
  if (endpoint) throw new Error(`${endpoint}.${hint}`);
  return env;
}
