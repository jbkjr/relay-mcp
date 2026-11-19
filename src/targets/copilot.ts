import { shellQuote } from "../core/shell.js";
import path from "node:path";
import type { TargetDef, Vendor } from "./types.js";

/**
 * The models relay lets Copilot run, with each one's family: the family a call to Copilot reaches.
 * From GitHub's documented model list for Copilot CLI 1.0.98 (docs.github.com, Copilot CLI
 * reference, 2026-10-15), not from a signed-in `copilot` run. "auto" (Copilot picks, and may pick
 * the caller's own family) is deliberately absent, as is any id whose family relay cannot name.
 * Under same_family "allow", unlisted models are accepted with an unknown family label; strict
 * admission requires a listed model with a known family. Adding one is a reviewed change.
 */
export const COPILOT_MODELS: Readonly<Record<string, Vendor>> = Object.freeze({
  "claude-sonnet-5.5": "anthropic",
  "claude-opus-5.5": "anthropic",
  "claude-haiku-5.5": "anthropic",
  "claude-haiku-4.5": "anthropic",
  "gpt-6.1-sol": "openai",
  "gpt-6-astra": "openai",
  "gpt-6-luna": "openai",
  "gpt-5.4": "openai",
  "gpt-5.4-mini": "openai",
  "gpt-5.3-codex": "openai",
  "gemini-3.8-flash": "google",
  "gemini-3.7-flash": "google",
});

/**
 * The hosts Copilot CLI 1.0.98 needs, signed in with an individual account: `api.github.com` for its
 * login check and account (`/copilot_internal/user`, which names the model endpoint), and the model
 * endpoint GitHub assigns individual accounts (Free, Pro), `api.individual.githubcopilot.com`. Found
 * from the proxy's own decisions in signed-in runs on 2026-10-17 (relay's proxy admitting only these
 * hosts, Copilot answered), and matching GitHub's allowlist reference
 * (docs.github.com/en/copilot/reference/copilot-allowlist-reference). Left out, and so refused:
 * its telemetry (`telemetry.individual.githubcopilot.com`), which it drops without complaint, and
 * update checks (off anyway). Business and enterprise accounts are given other model endpoints
 * (`api.business.githubcopilot.com`, `api.enterprise.githubcopilot.com`), which relay has not seen
 * work; a turn there is refused by the proxy, and says so in its log.
 */
export const COPILOT_API_HOSTS: readonly string[] = Object.freeze(["api.github.com", "api.individual.githubcopilot.com"]);

/**
 * GitHub Copilot CLI, driven over ACP (`copilot --acp`; backends/copilot.ts). A harness, not a
 * family: on one Copilot subscription it runs Anthropic's, OpenAI's and Google's models, so the
 * family a call reaches is the model's, and labels use COPILOT_MODELS, with unknown for automatic or unlisted models. Relay
 * confines it with its own sandbox (Copilot's own sandbox would nest inside, which fails).
 * Switched off by default, and experimental (targets.copilot.experimental) until a signed-in
 * qualification run.
 */
export const copilot: TargetDef = {
  id: "copilot",
  vendor: null,
  autoModel: "auto",
  models: COPILOT_MODELS,
  enabledByDefault: false,
  defaultBin: "copilot",
  name: "Copilot",
  product: "GitHub Copilot CLI",
  reviewPrefix: "G",
  // Never taken for a root session's host: a Copilot session's family is its model's, which relay
  // cannot tell from the outside, so such a root names targets as an unknown caller.
  clientNames: /(?!)/,
  tested: [1, 0, 98],
  // Copilot's own token. GH_TOKEN and GITHUB_TOKEN also override its stored login, and GH_HOST
  // chooses which host's stored login it uses (a GitHub Enterprise one, say), but other tools (gh)
  // use them too, so they are removed from Copilot's environment only (loginEnv).
  credentialEnv: /^COPILOT_GITHUB_TOKEN$/,
  loginEnv: /^(GH_TOKEN|GITHUB_TOKEN|GH_HOST)$/,
  // Its profile removes every COPILOT_* and GITHUB_COPILOT_* variable from its environment and sets
  // its own, so no variable can point it elsewhere; there is nothing left here to refuse.
  endpointEnv: /(?!)/,
  approvals: { channel: "in-band" },
  capabilities: { subagents: "never",
    confinement: "relay-enforced",
    readOnly: true,
    // Without a network grant it reaches only COPILOT_API_HOSTS, through relay's per-turn proxy, plus
    // what the system's certificate-trust daemons fetch for it past the proxy (its profile takes
    // that downgrade; backends/copilot.ts).
    networkOff: true,
    writeRoots: true,
    approvals: "acp",
    // 1.0.98 drops relay's bridge (stdio MCP) when relay hands it over ACP, so its agents cannot
    // delegate or reach relay, and are not told they can. Relay still passes the bridge.
    relayTools: false,
    escalation: false,
    resume: true,
    login: "scrubbed",
  },
  apiHosts: COPILOT_API_HOSTS,
  qualified: false,
  // Its sessions live in the home relay prepared for the item (backends/copilot.ts), not in the
  // user's ~/.copilot. The --resume=<id> form is from Copilot's documentation; unverified here.
  resumeCommand: (sessionId, at) => `COPILOT_HOME='${path.join(at.harnessState, "copilot").replace(/'/g, "'\\''")}' copilot --resume=${shellQuote(sessionId)}`,
  text: {
    blockedHow: () => "say exactly what you were blocked from doing in your final message; relay's sandbox cannot be lifted from inside a turn",
  },
};
