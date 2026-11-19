import { shellQuote } from "../core/shell.js";
import path from "node:path";
import type { TargetDef, TokenStoreGrant, Vendor } from "./types.js";

/**
 * The models relay lets Grok Build run, all xAI's. Grok runs only xAI's models while relay owns its
 * configuration (backends/grok.ts: its own home, no `[model.*]` or `[endpoints]` of the user's, every
 * Grok variable relay's), but its format allows any model behind any endpoint, so the family is
 * still judged per model, from this reviewed list. Relay runs Grok on no other (listedModelsOnly:
 * its settings allow only these, and the ACP driver refuses a turn that names another before Grok
 * starts), so only a turn that names none runs labelled family unknown, and under same_family
 * "refuse" a call must name one. A listed model the session does not offer is refused before the
 * prompt. From the 1.0.62 binary's built-in catalog (grok-4.6, its default, and grok-4.5, which
 * `grok models` lists without a login), first, since they are the ones seen offered, and its user
 * guide (grok-4.7), not from a signed-in `grok models`. Left out: `grok-build`, which is also the
 * name of Grok's default agent, and whose report back as the session's model is unverified; the
 * per-tier forms (`grok-4.7-high-fast`, `grok-4.7[fast=true]`). Adding one is a reviewed change to
 * this list.
 */
export const GROK_MODELS: Readonly<Record<string, Vendor>> = Object.freeze({
  "grok-4.6": "xai",
  "grok-4.5": "xai",
  "grok-4.7": "xai",
});

/**
 * The hosts Grok Build needs, signed in with an xAI account (docs.x.ai, Grok Build enterprise
 * guide, "Network requirements", read 2026-10-17): `cli-chat-proxy.grok.com`, its inference proxy,
 * settings and model catalog, and `auth.x.ai`, its OAuth/OIDC issuer (discovery and token refresh).
 * Left out, and so refused: `code.grok.com` (remote session sync and sharing), `assets.grok.com`,
 * `api.mixpanel.com` (product analytics), `x.ai` and `storage.googleapis.com` (installer and update
 * binaries, trace uploads), `registry.npmjs.org` (its npm auto-updater), and `api.x.ai`, which only
 * the API-key path uses. Not yet confirmed by the proxy's own decisions in a signed-in run.
 */
export const GROK_API_HOSTS: readonly string[] = Object.freeze(["cli-chat-proxy.grok.com", "auth.x.ai"]);

/**
 * Grok's login directory, where `grok login` keeps the login (`~/.grok/auth.json`) and where Grok
 * refreshes it: it takes `auth.json.lock` (an flock, never removed), spends the single-use refresh
 * token with xAI, writes the new login to `.{pid}.{counter}.tmp` (decimal; created new with mode
 * 0600, synced and chmodded again), renames that onto `auth.json` and chmods the result (grok-build
 * 2bdd1d6, fs_atomic.rs and manager/lock.rs; refresh_chain.rs never refreshes without the lock).
 * A confined Grok turn may do exactly that there and nothing else (decision D10, 2026-10-17,
 * "Exact-name renames"; the grant and its checks are the sandbox layer's: docs/design-token-store.md).
 * Relay always points Grok at this login (backends/grok.ts), whatever GROK_HOME the turn is given.
 */
export const GROK_LOGIN_STORE: TokenStoreGrant = Object.freeze({
  name: "Grok's login directory",
  dir: ".grok",
  files: Object.freeze(["auth.json"]),
  locks: Object.freeze(["auth.json.lock"]),
  tempName: String.raw`^\.[0-9]+\.[0-9]+\.tmp$`,
});

/** A word for a POSIX shell, single-quoted. */
const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * xAI's Grok Build CLI (`grok`, npm @xai-official/grok), driven over ACP (`grok agent stdio`;
 * backends/grok.ts). All its models are xAI's while relay owns its configuration, but relay judges
 * its family per model all the same (GROK_MODELS): a call with no model is labelled family unknown,
 * and refused under same_family "refuse"; one naming a model relay does not list is refused under
 * either setting. Relay confines it with its own sandbox (Grok's would nest inside, and fails open).
 * Switched off by default, and experimental (targets.grok.experimental) until a signed-in
 * qualification run.
 */
export const grok: TargetDef = {
  id: "grok",
  vendor: null,
  models: GROK_MODELS,
  listedModelsOnly: true,
  enabledByDefault: false,
  defaultBin: "grok",
  name: "Grok",
  product: "Grok Build",
  reviewPrefix: "K",
  // Never taken for a root session's host: relay does not run as a root inside Grok.
  clientNames: /(?!)/,
  tested: [1, 0, 62],
  // xAI's API keys and Grok's inline and deployment credentials, which would take the place of its
  // stored login: 1.0.62's own lists, from the binary, and GROK_EXTRA_AUTH_KEY, from the 1.0.45
  // source but not in that binary, kept as a precaution. GROK_AUTH_PATH, which only says where the
  // stored login is, is relay's to set, like every other Grok variable (its profile's scrub).
  credentialEnv: /^(XAI_API_KEY|GROK_CODE_XAI_API_KEY|GROK_AUTH|GROK_EXTRA_AUTH_KEY|GROK_DEPLOYMENT_KEY|GROK_ALPHA_TEST_KEY)$/,
  // Its profile removes every GROK_*, XAI_* and OTEL_* variable and SENTRY_DSN from its environment
  // and sets its own, so no variable can point it elsewhere; there is nothing left here to refuse.
  endpointEnv: /(?!)/,
  approvals: { channel: "in-band" },
  capabilities: {
    // Its subagents, which can run other models, are switched off (backends/grok.ts GROK_ENV and its config file).
    subagents: "never",
    confinement: "relay-enforced",
    readOnly: true,
    // Without a network grant it reaches only GROK_API_HOSTS, through relay's per-turn proxy, plus what
    // the system's certificate-trust daemons fetch for it past the proxy (its profile takes that
    // downgrade: backends/grok.ts).
    networkOff: true,
    writeRoots: true,
    approvals: "acp",
    // relayTools left at its default (true): Grok advertises only HTTP and SSE MCP servers, but its
    // source (1.0.45, admit_client_mcp_servers) admits every server a client passes, relay's stdio
    // bridge included. Unverified until a signed-in session; Copilot turned out to drop it.
    escalation: false,
    // session/resume, which Grok advertises (1.0.62), with session/load as the fallback.
    resume: true,
    // Its `cached_token` check, under the oidc pin relay writes, fails at once without a stored
    // login (seen with 1.0.62), but whether the stored login is an account's (it can hold a saved
    // API key) is not reported, so relay can only remove the alternatives.
    login: "scrubbed",
  },
  apiHosts: GROK_API_HOSTS,
  // A stated downgrade: its turns may refresh the login in ~/.grok, through its token, lock and temp names only.
  tokenStore: GROK_LOGIN_STORE,
  qualified: false,
  // Its sessions live in the home relay prepared for the item (backends/grok.ts), not in the
  // user's ~/.grok; its login is the one relay's turns use, in ~/.grok (GROK_LOGIN_STORE). The
  // ACP session id is the one Grok keeps the session under on disk (1.0.62); `--resume <id>` is
  // from its documentation, unverified here. Relay does not show this command (nativeResumeWithheld):
  // it is what the qualification run checks, and what relay would show once that is settled.
  resumeCommand: (sessionId, at) =>
    `GROK_AUTH_PATH="$HOME/.grok/auth.json" GROK_HOME=${shq(path.join(at.harnessState, "grok"))} grok --resume ${shellQuote(sessionId)}`,
  // The session store is writable to everything in a Grok turn, read jobs included (its bash tool,
  // the repository's MCP servers), and `grok --resume` restores the session from it, outside relay's
  // sandbox: its history (updates.jsonl), and in summary.json a persisted agent profile, whose
  // agent can declare MCP servers (1.0.62's user guide, 17-sessions.md and 16-subagents.md). It
  // would run on relay's Grok home, so with relay's settings, not the user's, and with the sandbox
  // profile the session was started with, Grok's own sandbox off, which a resume cannot change
  // (18-sandbox.md). What a resume then starts without asking is unverified.
  nativeResumeWithheld: "Relay shows no command to open a Grok session in your own grok. Its session files are in relay's Grok home for this item, which anything in its turns could write, read jobs included, and `grok --resume` there would restore them outside relay's sandbox: with relay's Grok settings rather than yours, with Grok's own sandbox off for the life of the session (a resume cannot turn it on), and with whatever the job left in them, such as an agent profile that declares MCP servers. Continue it with relay's resume, which runs it inside relay's sandbox.",
  text: {
    blockedHow: () => "say exactly what you were blocked from doing in your final message; relay's sandbox cannot be lifted from inside a turn",
  },
};
