// xAI's Grok Build CLI over ACP (`grok agent stdio`): its profile for the generic driver (acp.ts).
// What this says about Grok comes from the 1.0.62 package, run without a login and without a model
// call (its help, initialize, authMethods, `grok inspect --json`, `grok models`), its user guide as
// that binary ships it, and its public source at 1.0.45 (xai-org/grok-build@2bdd1d6a), which lags the
// binary. What only a signed-in run can show is marked "unverified" where it matters, and the
// qualification run must confirm it (docs/research/grok-1.0.62.md, "Still open"; the earlier
// research is docs/research/acp-google-grok.md §2 and §5).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authFor, harnessHome, networkOn } from "../core/config.js";
import { GROK_LOGIN_STORE, GROK_MODELS } from "../targets/grok.js";
import { acpBackend, genericApproval, type AcpProfile, type PreparedState } from "./acp.js";
import { targetLabel } from "../targets/index.js";
import type { TurnSpec } from "./types.js";

/**
 * Where the user's own Grok login is, as Grok itself finds it, from the worker's environment
 * (relay replaces every Grok variable in Grok's): GROK_AUTH_PATH, else auth.json in GROK_HOME, else
 * in ~/.grok. An empty variable counts as unset, as it does for Grok.
 */
export function grokUserAuthPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (env.GROK_AUTH_PATH) return env.GROK_AUTH_PATH;
  return path.join(env.GROK_HOME || path.join(home, ".grok"), "auth.json");
}

/** The login relay runs Grok on: auth.json in Grok's login directory, the target's login store (~/.grok). */
export const grokLoginPath = (home = os.homedir()): string => path.join(home, GROK_LOGIN_STORE.dir, GROK_LOGIN_STORE.files[0]);

/**
 * Why relay does not run Grok (`name`, its label) on this worker's login, or null. Relay runs it on
 * the login in ~/.grok only, the one directory where its sandbox lets a turn refresh it (the
 * target's login store, D10): a GROK_AUTH_PATH or GROK_HOME in relay's environment that puts the
 * login elsewhere is refused rather than replaced by another login, or by none; so is a machine
 * with no ~/.grok, where Grok has never been signed in.
 */
export function grokLoginRefusal(name: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  const login = grokLoginPath(home);
  const theirs = path.resolve(grokUserAuthPath(env, home));
  if (theirs !== login) {
    const which = env.GROK_AUTH_PATH ? "GROK_AUTH_PATH" : "GROK_HOME";
    return `${which} in relay's environment puts Grok's login at ${theirs}, but relay runs ${name} only on the login in ${login}, the one place its sandbox lets a turn refresh it. Unset ${which} in the environment relay runs in, so that \`grok login\` keeps the login there.`;
  }
  if (!fs.lstatSync(path.dirname(login), { throwIfNoEntry: false })) return `${name} has no login on this machine (${path.dirname(login)} does not exist). Sign in with \`grok login\`.`;
  return null;
}

/**
 * Configuration layers outside the home relay gives Grok, which no setting of relay's outranks:
 * the system's managed defaults and requirements (pinned keys there beat the environment and the
 * command line), and the requirements macOS device management installs for the `ai.x.grok` domain
 * (from 1.0.62's binary and its configuration reference). Relay does not run Grok where one exists.
 */
export const GROK_SYSTEM_LAYERS: readonly string[] = Object.freeze([
  "/etc/grok/managed_config.toml",
  "/etc/grok/requirements.toml",
  "/Library/Managed Preferences/ai.x.grok.plist",
]);

/** The first of `paths` that exists (as anything, a link included), or null. */
export function systemLayer(paths: readonly string[]): string | null {
  return paths.find((p) => fs.lstatSync(p, { throwIfNoEntry: false })) ?? null;
}

let layersStandIn: readonly string[] | null = null;

/**
 * Test-only seam: the system layers relay checks for in this process (scratch files a test makes),
 * or null for the real ones. Nothing in relay calls this; only test code does.
 */
export function setGrokSystemLayersForTests(layers: readonly string[] | null): void {
  layersStandIn = layers;
}

/** Every system layer relay checks for: GROK_SYSTEM_LAYERS, and the managed-preferences file device management installs for this user. */
export const grokSystemLayers = (): string[] => layersStandIn ? [...layersStandIn] : [...GROK_SYSTEM_LAYERS, path.join("/Library/Managed Preferences", os.userInfo().username, "ai.x.grok.plist")];

/** Why relay does not run Grok (`name`, its label) on this machine, or null: the first of `layers` that exists. */
export function grokSystemRefusal(name: string, layers: readonly string[] = grokSystemLayers()): string | null {
  const layer = systemLayer(layers);
  if (!layer) return null;
  return `this machine has Grok configuration that relay cannot override (${layer}): its pinned settings outrank everything relay sets, so relay cannot tell which model would answer or keep ${name}'s own sandbox and telemetry off. It does not run ${name} here.`;
}

const COMPAT = ["CLAUDE", "CURSOR", "CODEX"].flatMap((tool) => ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"].map((what) => `GROK_${tool}_${what}_ENABLED`));

/**
 * What relay sets in Grok's environment, beyond its home and login path: the environment outranks
 * Grok's configuration files, the remote settings xAI can push and its rollout switches, so each
 * setting that has a variable is set here as well as in the configuration file. Every name is in the
 * 1.0.62 binary; the compatibility switches were seen to take effect in `grok inspect --json`.
 */
export const GROK_ENV: Readonly<Record<string, string>> = Object.freeze({
  // Grok's own sandbox (whole process), and its per-command sandbox, which xAI can switch on remotely: either would nest inside relay's.
  GROK_SANDBOX: "off",
  GROK_SANDBOX_MODE: "off",
  GROK_DISABLE_AUTOUPDATER: "1",
  GROK_TELEMETRY_ENABLED: "0",
  GROK_TELEMETRY_TRACE_UPLOAD: "0",
  GROK_TELEMETRY_MIXPANEL_ENABLED: "0",
  GROK_ERROR_REPORTING: "0",
  DISABLE_ERROR_REPORTING: "1",
  GROK_EXTERNAL_OTEL: "0",
  GROK_CRASH_HANDLER: "0",
  // Subagents can run other models; memory carries one session's notes into the next.
  GROK_SUBAGENTS: "0",
  GROK_MEMORY: "0",
  // Patches and MCP servers xAI or an organisation can push.
  GROK_CAMPAIGNS: "0",
  GROK_MANAGED_MCPS_ENABLED: "0",
  // Its own session sync with grok.com (no relation to relay).
  GROK_RELAY_SYNC_ENABLED: "0",
  GROK_SESSION_REGISTRY: "0",
  // web_fetch, off by default but a rollout switch, fetches without asking: relay keeps it off, with a network grant too.
  GROK_WEB_FETCH: "0",
  // The skills, rules, agents, MCP servers, hooks and sessions it would import from Claude Code, Cursor and Codex.
  ...Object.fromEntries(COMPAT.map((k) => [k, "0"])),
});

/**
 * Relay's configuration file for Grok, Grok's user layer in the home relay builds (its own
 * `~/.grok/config.toml` is never read). Written before every turn and read-only to the agent.
 * There is no `[model.*]` table (which could put another family's model behind any id) and no
 * `[endpoints]` (which could send Grok elsewhere). No requirements.toml goes beside it: Grok 1.0.62
 * reads `$GROK_HOME/requirements.toml` as a signed cache and applies nothing from one that is not
 * signed (seen: a pinned `models.default` there was ignored), so the pins would be a pretence.
 *
 * `network`: whether the turn has network access (a grant, or child_network). Without it Grok's
 * web_search is dropped: it runs on Grok's own API host (cli-chat-proxy.grok.com), which relay's
 * proxy admits, and never asks, so the model could otherwise send what it chose in its queries and
 * bring the web's content into the turn. `disable_web_search` also drops web_fetch (1.0.62, decoy
 * login: 25 tools in the session, 24 with it; with GROK_WEB_FETCH=1, 26 and still 24). Its
 * server-side ("backend") tools, which run inside the model request on that same host (backend web
 * search, X search, the code interpreter; `features.backend_tools`, on by default), are switched off
 * too (with GROK_BACKEND_SEARCH=0 in its environment: grokState). That a signed-in turn then shows
 * none is unverified: the decoy login never loaded the catalog that would offer them.
 *
 * `keys`: whether an API key may sign Grok in (child_auth "any" for it). Otherwise Grok's own switch
 * `auth.disable_api_key_auth` is set too (and GROK_DISABLE_API_KEY_AUTH=1: grokState). The oidc pin
 * refuses the API-key method, not an API key Grok keeps in auth.json (its `xai::api_key` scope, which
 * 1.0.62 loads: "auth: loaded API key from auth.json"); `cached_token` accepts a stored key unless
 * that switch is set (1.0.45 source, manager.rs `login_policy_error`; the switch is in 1.0.62's
 * configuration reference, "Refuse API-key auth so only the deployment IdP can log in"). That 1.0.62
 * then refuses a stored key, and still accepts an account's login, is for the signed-in run (review
 * r_f887dc06 C2).
 */
export function grokConfig(network = false, keys = false): string {
  const off = (keys: string[]) => keys.map((k) => `${k} = false`).join("\n");
  const surfaces = ["agents", "hooks", "mcps", "rules", "skills", "sessions"];
  return `# Relay's settings for Grok Build, rewritten before every turn; read-only to the agent.
${network ? "" : `
# No network grant this turn: no web_search or web_fetch, which go out through Grok's own API host and never ask.
disable_web_search = true
`}
# The stored login only: \`cached_token\` fails at once without one, rather than falling through to a
# browser sign-in or an API key (seen with 1.0.62).
[auth]
preferred_method = "oidc"
${keys ? "" : `# Nor an API key stored in auth.json: relay runs Grok on an account's login only (child_auth "login").
disable_api_key_auth = true
`}
# Grok's own sandbox would nest inside relay's.
[sandbox]
profile = "off"

[cli]
auto_update = false
use_leader = false
session_registry = false

[features]
telemetry = false
managed_config = false
campaigns = false
web_fetch = false
${network ? "" : `# No network grant this turn: no server-side tools either (backend web search, X search, the code interpreter).
backend_tools = false
`}
[telemetry]
trace_upload = false
otel_enabled = false

[diagnostics]
error_reporting = false
crash_handler = false

# Per-turn snapshots of the workspace and uploads of the codebase.
[harness]
disable_workspace_teleport = true
disable_codebase_upload = true

[relay]
enabled = false

[managed_mcps]
enabled = false

[subagents]
enabled = false

[memory]
enabled = false

[memory_v2]
enabled = false

[session]
load_envrc = false

[compat.claude]
${off(surfaces)}

[compat.cursor]
${off(surfaces)}

[compat.codex]
${off(["hooks", "skills", "sessions"])}

[models]
allowed_models = [${Object.keys(GROK_MODELS).map((m) => JSON.stringify(m)).join(", ")}]

# A marker Grok writes on first launch; written here, it has nothing to write.
[marketplace]
default_skills_installs_purged = true
`;
}

/**
 * The Grok home a session runs with (GROK_HOME): one per relay session, under relay's harness
 * directory, outside its control directory. It is relay's, and read-only to the agent; only two
 * directories in it are writable:
 *
 * - `sessions/`: Grok's sessions (one directory per working directory, then per session id), the
 *   one thing kept from turn to turn, since resuming needs it. Relay refuses to run on it if it is
 *   anything but a plain directory (an agent could otherwise swap in a link that the next turn's
 *   sandbox would follow and open).
 * - `turn/`: this turn's logs (`logs` in the home links there), removed with it.
 *
 * Before every turn relay rebuilds the rest: its own config.toml (grokConfig). Grok 1.0.62 also
 * writes lock files, its extracted user guide and an agent id in its home on start; refused there,
 * it carries on (seen without a login, up to session/new). Nothing of the user's Grok configuration
 * comes along: no MCP servers, hooks, plugins, skills, rules, saved permissions or memory.
 *
 * The stored login stays where `grok login` puts it, ~/.grok/auth.json: GROK_AUTH_PATH points
 * there (grokLoginPath; a worker whose own GROK_AUTH_PATH or GROK_HOME points elsewhere is refused,
 * grokLoginRefusal), and relay never opens the file. Grok refreshes it by locking `auth.json.lock`,
 * spending the single-use refresh token with xAI, and replacing auth.json through a temporary file
 * and a rename; a turn that spent the refresh token and then could not save its successor would
 * sign the user out of Grok everywhere. The target's login store (GROK_LOGIN_STORE, D10) lets a
 * turn do exactly that in ~/.grok, and nothing else there: the sandbox layer checks the directory
 * and every name it makes writable before the turn, and probes the same rules on a decoy store.
 * Everything else in ~/.grok (the user's config.toml, MCP credentials) stays read-only.
 *
 * HOME is a temporary one (the default), which also hides ~/.claude, ~/.claude.json, ~/.cursor,
 * ~/.codex and ~/.agents, whose MCP servers, hooks and skills Grok would otherwise import. Grok
 * checks certificates with rustls-platform-verifier (0.6.2 in the 1.0.62 binary, which calls
 * `SecTrustEvaluateWithError`), so the Security framework's trust daemons evaluate its API
 * connections, and any certificate fetches for them (AIA, OCSP) go past relay's proxy. It gets the
 * trust daemons: a stated downgrade, as for Copilot.
 */
export function grokState(spec: TurnSpec): PreparedState {
  const home = path.join(harnessHome(), spec.markers.runId, spec.markers.nodeId, "grok");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const sessions = path.join(home, "sessions");
  const kept = fs.lstatSync(sessions, { throwIfNoEntry: false });
  if (kept && (kept.isSymbolicLink() || !kept.isDirectory())) {
    throw new Error(`${targetLabel(spec.target)}'s session store for this session (${sessions}) has been replaced by something other than a directory, which relay's sandbox would follow, so relay does not run it on that directory. Start a new job.`);
  }
  for (const name of fs.readdirSync(home)) if (name !== "sessions") fs.rmSync(path.join(home, name), { recursive: true, force: true });
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const turn = path.join(home, "turn");
  fs.mkdirSync(path.join(turn, "logs"), { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.join(turn, "logs"), path.join(home, "logs"));
  const network = networkOn(spec.config, spec.grant);
  // Under child_auth "any" whatever Grok signs in with is accepted, a key stored in auth.json included.
  const keys = authFor(spec.config, spec.target.id) === "any";
  fs.writeFileSync(path.join(home, "config.toml"), grokConfig(network, keys), { mode: 0o600 });
  return {
    stateDirs: [],
    persistent: { root: home, writable: ["sessions", "turn"] },
    home: "temp",
    // Without a network grant, Grok's server-side tools off by the variable too, which outranks its files and the remote settings (grokConfig).
    // Under child_auth "login", an API key stored in auth.json refused by the variable too (grokConfig).
    env: { ...GROK_ENV, ...(network ? {} : { GROK_BACKEND_SEARCH: "0" }), ...(keys ? {} : { GROK_DISABLE_API_KEY_AUTH: "1" }), GROK_HOME: home, GROK_AUTH_PATH: grokLoginPath() },
    keychain: false,
    // Very likely needed (rustls-platform-verifier, above), as Copilot's Rust core needed them (2026-10-17); a signed-in run will tell.
    certificateTrust: true,
    cleanup: () => fs.rmSync(turn, { recursive: true, force: true }),
  };
}

export const grokProfile: AcpProfile = {
  args: (spec, model) => [
    // Runs the version that was launched (a top-level flag Grok accepts but does not list; 1.0.62).
    "--no-auto-update",
    // Without a network grant, no web search (grokConfig): the flag outranks every settings file but a signed requirements pin (seen with 1.0.62's `agent stdio`).
    ...(networkOn(spec.config, spec.grant) ? [] : ["--disable-web-search"]),
    "agent",
    // A leader process started outside relay's sandbox would run the tools unconfined.
    "--no-leader",
    // Relay's sandbox is the boundary, and nothing approved lifts it (no escalation through relay's
    // sandbox in 1.0), so Grok runs without asking, persisting nothing.
    "--always-approve",
    // A process per turn, so a resumed session gets it too; the session's reported model is checked against it.
    ...(model ? ["-m", model] : []),
    ...(spec.effort ? ["--reasoning-effort", spec.effort] : []),
    "stdio",
  ],
  // Every Grok and xAI variable is relay's to set (GROK_MODELS_BASE_URL, GROK_CONFIG, GROK_AUTH_PATH
  // and dozens more reconfigure it, or point it elsewhere), and so are the OpenTelemetry and Sentry
  // sinks it would report to. Its API keys go with them, whatever child_auth says: relay pins Grok to
  // its stored login (the oidc pin refuses the API-key method), so a key would only be handed to the agent.
  scrub: (k) => /^(GROK_|XAI_|OTEL_)/.test(k) || k === "SENTRY_DSN",
  prepareState: grokState,
  // Grok reports the session's effort as its `reasoning_effort` option (category thought_level), and
  // runs an effort its model's menu lacks at "high" without a word (1.0.62, decoy login: grok-4.5
  // offers high, medium and low, grok-4.6 xhigh too; `xhigh` on grok-4.5, `max` and `minimal` ran
  // as "high"), so relay checks it before the prompt.
  effortOption: "thought_level",
  login: {
    // With the oidc pin in relay's config.toml, Grok offers `cached_token` only when a login is
    // stored, and authenticating with it fails at once without one ("preferred_method=oidc but no
    // session is available"), with no browser and no API key (seen with 1.0.62). Unpinned, it falls
    // through to a browser sign-in. It also succeeds with an expired login (seen with a decoy whose
    // refresh could not go through), so an expired login is refreshed, through the login store, at
    // the turn's first request, not before the prompt. That it succeeds with a real stored login,
    // and that the refresh goes through, is unverified. Under child_auth "any" relay skips it, and
    // 1.0.62 then opens a session with a stored login and refuses one without ("Authentication
    // required"; decoy login).
    reuse: ["cached_token"],
    how: "Sign in with `grok login`. Relay uses Grok's stored login in ~/.grok (its turns may refresh it there, through Grok's own lock, temp file and rename, and change nothing else in that directory), and removes XAI_API_KEY and every other Grok variable from its environment.",
  },
  normalizeApproval(call, spec) {
    const ask = genericApproval(call);
    if (!ask) return null;
    // The directory the command would run in, as the agent gave it (relative to its own), else its own.
    const detail = (ask.detail ?? {}) as { cwd?: unknown };
    const cwd = path.resolve(spec.cwd, typeof detail.cwd === "string" ? detail.cwd : ".");
    const paths = ask.paths?.map((p) => path.resolve(cwd, p));
    // Whatever is approved, relay's sandbox stays on: say so to whoever decides.
    return { ...ask, ...(paths ? { paths } : {}), detail: { ...detail, cwd, confined: true } };
  },
  refuse: (spec) => grokSystemRefusal(targetLabel(spec.target)) ?? grokLoginRefusal(targetLabel(spec.target)),
};

export const grokBackend = acpBackend(grokProfile);
