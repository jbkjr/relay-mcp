import { shellQuote } from "../core/shell.js";
import path from "node:path";
import type { TargetDef } from "./types.js";
import { VERIFIED } from "./verified.js";

/**
 * The one host Gemini CLI 0.64.0 needs signed in with a Gemini API key: Google's Gemini API
 * (`generativelanguage.googleapis.com`, the Developer API endpoint of the genai SDK it uses). From
 * the 0.64.0 source and package (docs/research/acp-google-grok.md §1.2, docs/gemini.md), not yet
 * from a signed-in run through relay's proxy. Left out, and so refused: its Clearcut telemetry
 * (`play.googleapis.com`, off in relay's settings anyway), the Code Assist and OAuth hosts of the
 * Google-login path (which relay does not use), and the npm registry (its update check runs only
 * in its terminal interface).
 */
export const GEMINI_API_HOSTS: readonly string[] = Object.freeze(["generativelanguage.googleapis.com"]);

/**
 * Where the resume command reads the key from: the default key file (core/api-keys.ts, which this
 * registry may not import). With a local config that moves the file, the person substitutes its path.
 */
const KEY_FILE_HINT = "~/.config/relay-keys/gemini-api-key";

/**
 * Google's Gemini CLI, driven over ACP (`gemini --acp`; backends/gemini.ts). The family is Google:
 * with every endpoint redirection refused (endpointEnv, and relay never uses its ACP `gateway`
 * method), Gemini CLI reaches only Google's Gemini API, whose models are all Google's.
 *
 * It signs in with an API key only (capabilities.login "key-only"): Google refuses Gemini CLI's
 * consumer "Login with Google" since 2026-06-18, and Workspace login needs a Code Assist licence
 * Google no longer sells. That is the one exception to relay's rule that agents run on the
 * person's own account login, and relay makes it only for this target and only when the person
 * asks by name (targets.gemini.child_auth "any"; the global setting does not count). The key comes
 * from a file of the person's own (core/api-keys.ts) and goes to Gemini's process alone, in its ACP
 * authenticate request, never in an environment.
 *
 * Relay confines it with its own sandbox, in an untrusted folder (a repository's `.gemini/.env`
 * could otherwise send the key elsewhere), where Gemini connects no MCP server, relay's bridge
 * included. Its agents get relay's tools through Gemini's command-based tool discovery instead
 * (tools.discoveryCommand and tools.callCommand in relay's own Gemini settings, which 0.64.0 runs in
 * an untrusted folder too), served by the same broker as the bridge (backends/gemini.ts,
 * confine/gemini-tools.ts). Switched off by default (targets.gemini.enabled). Qualified for 1.0 on
 * 2026-10-22, after its agents got relay's tools through discovery, with its documented
 * residuals accepted (docs/gemini.md §8, §9): no targets.gemini.experimental is needed, and one
 * already set is accepted and changes nothing.
 */
export const gemini: TargetDef = {
  // Gemini's automatic choice (GEMINI_MODEL_ALIAS_AUTO, 0.64.0 packages/core/src/config/models.ts),
  // which is also what its session reports with no --model: not a pin, so a model it routes to is no
  // switch (acp.ts). The family stays Google's either way (vendor). Its other aliases (pro, flash,
  // flash-lite and the deprecated auto-gemini-3, auto-gemini-2.5) count as pins: the model they
  // resolve to is noted as a switch within Google, which never stops a turn (docs/gemini.md §3.4).
  autoModel: "auto",
  id: "gemini",
  vendor: "google",
  enabledByDefault: false,
  defaultBin: "gemini",
  name: "Gemini",
  product: "Gemini CLI",
  reviewPrefix: "GE",
  // Never taken for a root session's host: relay is not registered with Gemini CLI as a host.
  clientNames: /(?!)/,
  // The oldest version relay runs (the version gate refuses an older one): npm @google/gemini-cli 0.64.0
  // (2026-10-13, commit 4a0749ac). 0.65.0 (2026-10-20) was qualified too (toolDiscovery below).
  // Homebrew's formula is frozen at 0.46.0.
  tested: [0, 64, 0],
  // What would make Gemini CLI, or Google's genai SDK in any agent, sign in with something else
  // than the key relay hands it: Google's API keys, the switches to Vertex AI or Code Assist and an
  // access token for it, compute credentials and Gemini's own auth overrides. Removed from every
  // launched agent; Gemini's profile removes them from its own environment too, under child_auth
  // "any" as well, and hands it the key from the key file over ACP.
  credentialEnv: /^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_(VERTEXAI|GCA)|GOOGLE_CLOUD_ACCESS_TOKEN|GEMINI_CLI_USE_COMPUTE_ADC|GEMINI_CLI_AUTH_OVERRIDE|GEMINI_API_KEY_AUTH_MECHANISM)$/,
  // Endpoints other than Google's Gemini API, where any model (and the key) could go: Code Assist's
  // and Vertex's base URLs, the genai SDK's API version, the metadata server. Refused, not removed.
  endpointEnv: /^(CODE_ASSIST_ENDPOINT|CODE_ASSIST_API_VERSION|GOOGLE_GEMINI_BASE_URL|GOOGLE_VERTEX_BASE_URL|GOOGLE_GENAI_API_VERSION|GCE_METADATA_(HOST|IP))$/,
  approvals: { channel: "in-band" },
  capabilities: {
    // None: relay switches Gemini's subagents off (experimental.enableAgents false, and its policy
    // denies invoke_agent, backends/gemini.ts). They are on by default in 0.64.0 and would run other
    // Google models outside what its prompt response reports.
    subagents: "never",
    confinement: "relay-enforced",
    readOnly: true,
    // Without a network grant it reaches only GEMINI_API_HOSTS, through relay's per-turn proxy.
    networkOff: true,
    writeRoots: true,
    approvals: "acp",
    escalation: false,
    // Over session/load: Gemini has no session/resume.
    resume: true,
    login: "key-only",
    // In the untrusted folder relay runs it in, Gemini starts no MCP server, relay's bridge included;
    // its agents take relay's tools through its tool discovery (toolDiscovery), on every version,
    // with a check at each launch that discovery ran.
    relayTools: true,
  },
  // Gemini registers each discovered tool as `discovered_tool_<name>` (0.64.0 DISCOVERED_TOOL_PREFIX,
  // packages/core/src/tools/tool-names.ts:237; tool-registry.ts:518-526). Discovery and calls read in
  // the 0.64.0 source (tool-registry.ts:76-180, :376-540): no trust check, the call command spawned
  // without a shell, the arguments as JSON on stdin, any stderr a failure (docs/gemini.md §3.8).
  // 0.65.0 (2026-10-20): its tool-registry.ts, tool-names.ts, mcp-client-manager.ts, trustedFolders.ts,
  // acpSessionManager.ts, sessionCleanup.ts and policy-engine.ts are 0.64.0's unchanged, and checks
  // 12-15 passed on the real 0.65.0 binary (docs/qualification/gemini-0.65.0.md). The versions are
  // those verified live (VERIFIED.geminiToolDiscovery, targets/verified.ts), for doctor and a turn's
  // note: the tools are offered on every version, and each launch checks that discovery ran
  // (backends/gemini.ts geminiDiscoveryCheck).
  toolDiscovery: { prefix: "discovered_tool_", versions: VERIFIED.geminiToolDiscovery },
  apiHosts: GEMINI_API_HOSTS,
  // Qualified with a real key on 0.64.0 and 0.65.0 (docs/qualification/gemini-0.64.0.md,
  // gemini-0.65.0.md); checks 7 (free keys) and 11 (a real fallback) stay open, since they depend on Google.
  qualified: true,
  // Its sessions live in the runtime directory of the home relay prepared for the item
  // (backends/gemini.ts: `.cache/.gemini` under GEMINI_CLI_HOME, with SANDBOX=sandbox-exec), and
  // a session is found by the directory it was started in (views.ts puts the `cd` in front). Run
  // untrusted there too, as relay runs it, so that the repository's .gemini/.env cannot redirect it.
  // Withheld (nativeResumeWithheld): outside relay's sandbox this would restore chats a turn could
  // write, using relay's settings. SANDBOX only locates the sessions; it starts no sandbox, though
  // Gemini would tell its model it runs under Seatbelt (docs/gemini.md §3.5).
  resumeCommand: (sessionId, at) =>
    `GEMINI_CLI_HOME='${path.join(at.harnessState, "gemini").replace(/'/g, "'\\''")}' SANDBOX=sandbox-exec GEMINI_CLI_TRUST_WORKSPACE=false GEMINI_API_KEY="$(cat ${KEY_FILE_HINT})" gemini --resume ${shellQuote(sessionId)}`,
  nativeResumeWithheld: "Relay shows no command to open a Gemini session in your own gemini. Its session files are in relay's Gemini home for this item, which anything in its turns could write, read jobs included, and `gemini --resume` there would replay them outside relay's sandbox: with relay's Gemini settings rather than yours and whatever instructions the job left in its chats, with only Gemini's own approval prompts in between. The SANDBOX=sandbox-exec needed to find those sessions starts no sandbox, though Gemini would tell its model it runs under Seatbelt. Continue it with relay's resume, which runs it inside relay's sandbox.",
  text: {
    blockedHow: () => "say exactly what you were blocked from doing in your final message; relay's sandbox cannot be lifted from inside a turn",
  },
};
