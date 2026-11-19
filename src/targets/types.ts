// What relay knows about each agent it can launch. The entries are in claude.ts and codex.ts; the
// registry, and what is derived from it, in index.ts.
import type { ZodRawShape } from "zod";
import type { ApprovalAsk } from "../backends/types.js";
import type { Mode } from "../core/config.js";

/**
 * Every target relay knows, in registry order. A target is what callers name and what a node
 * records (nodes.target, review files, transcripts), so an id, once shipped, is never renamed.
 */
export const TARGET_IDS = ["claude", "codex", "copilot", "gemini", "grok"] as const;
export type Target = (typeof TARGET_IDS)[number];

/**
 * The family behind a target (the code spells it vendor): what the cross-family rule is about. A
 * harness is not a family: Copilot, say, runs several families' models, and the family is the model's.
 */
export type Vendor = "anthropic" | "openai" | "google" | "xai" | "moonshot" | "microsoft";
export type FamilyId = Vendor | "unknown";

/** How families are named in messages. */
export const VENDOR_NAMES: Record<Vendor, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", xai: "xAI", moonshot: "Moonshot", microsoft: "Microsoft",
};

/**
 * How fast a launched agent's model answers, in relay's names, slowest first. Standard is every
 * harness's own default, and what relay asks for unless told otherwise; the faster speeds cost the
 * person money or allowance (Claude's fast mode is billed to usage credits; Codex's faster service
 * tiers use more of the plan).
 */
export const SPEEDS = ["standard", "fast", "ultrafast"] as const;
export type Speed = (typeof SPEEDS)[number];
/** How a speed compares with another: its place in SPEEDS. */
export const speedRank = (s: Speed): number => SPEEDS.indexOf(s);

/** A speed above standard as one harness offers it. */
export interface SpeedOption {
  /** The harness's own name for it: Codex's service tier id in its model catalog; for Claude, the setting that turns it on. */
  id: string;
  /**
   * For a harness that offers it for some models only and says which in its documentation
   * (Claude): whether `model` has it, true or false, or null when relay cannot tell from the name
   * (an alias such as "default"); and the models, named for messages. Unset where the account's
   * own catalog says, when the turn starts (Codex).
   */
  models?: { names: string; has(model: string): boolean | null };
}

/** A permission-prompt tool on relay's own MCP server, which the agent's CLI calls when it wants to act outside its sandbox. */
export interface PermissionTool {
  /** What the CLI sends for one permission prompt. */
  inputSchema: ZodRawShape;
  /** What the prompt asks for, in relay's terms. */
  toAsk(call: Record<string, unknown>): ApprovalAsk;
  /** The answer in the CLI's shape: let the call go ahead as made, or refuse it with a message to the agent. */
  reply(call: Record<string, unknown>, decision: { allow: true } | { allow: false; message: string }): unknown;
}

/**
 * What relay can promise for a target, and so what it may be asked to do. Admission control
 * (targets/index.ts `incapable`) refuses a call that needs something its target cannot honour.
 */
export interface Capabilities {
  /** Native helpers available in a launched turn. Unqualified tool names remain never. */
  subagents: "write" | "always" | "never";
  /**
   * Who confines the agent. "verified": its own sandbox, which relay configures and then checks
   * took (Claude, Codex). "relay-enforced": relay's own operating-system sandbox around the whole
   * harness process (src/confine), with the harness's own sandbox off. "none": nothing does, so
   * relay never launches it.
   */
  confinement: "verified" | "relay-enforced" | "none";
  /** Read turns are enforced read-only (not merely asked to be). */
  readOnly: boolean;
  /** Turns without a network grant are enforced off the network. */
  networkOff: boolean;
  /** Directories the root grants (grant.write_paths) can be made writable. */
  writeRoots: boolean;
  /** How it asks for permission: its own native channel, ACP session/request_permission, or not at all. */
  approvals: "native" | "acp" | "none";
  /**
   * Whether an approved request can take the agent past its boundary (an unsandboxed command).
   * False for relay-enforced harnesses: relay's sandbox stays on whatever is approved, so a
   * request is for something inside it, and anything outside is reported, not approved.
   */
  escalation: boolean;
  /** Whether a session can be continued in a later turn (resume, follow-ups, discussions). */
  resume: boolean;
  /**
   * Whether a launched agent of this target can be given relay's own tools (delegate, ask, status,
   * …) at all. False for a harness that will not load relay's bridge, a stdio MCP server: Copilot
   * 1.0.98 takes only HTTP and SSE MCP servers from an ACP client ("Rejecting non-http/sse MCP
   * server"). Its prompts then offer no relay tools. Absent means true. A target that takes them
   * through its own tool discovery instead (TargetDef.toolDiscovery) has them on every version
   * relay's version gate lets run, and each launch checks that discovery ran.
   */
  relayTools?: boolean;
  /**
   * How relay knows it signs in with the user's account. "account-verified": the harness reports
   * its login method and relay checks it. "scrubbed": relay removes every credential override from
   * its environment, so only a stored login is left, but the harness does not report which it used.
   * "key-only": it needs an API key. "unknown".
   */
  login: "account-verified" | "scrubbed" | "key-only" | "unknown";
  /**
   * Whether its launched agents can be given extensions (skills and MCP servers the person allows,
   * docs/extensions.md): only where relay can check what the harness loads and the agent's own
   * relay server runs outside its sandbox, so that relay's gateway sits between the agent and the
   * servers. Absent: none, as for a harness inside relay's own sandbox (ACP), where a server
   * outside would be a way out that 1.0 does not qualify.
   */
  extensions?: boolean;
}

/**
 * A login directory a target's harness refreshes its login in by temp file and rename (Grok:
 * ~/.grok, auth.json, its lock, and `.{pid}.{counter}.tmp`). In a confined turn only these names,
 * and names matching `tempName`, may be written, created as regular files, removed and renamed onto
 * there; nothing else in the directory (docs/design-token-store.md; decision D10, 2026-10-17,
 * "Exact-name renames"). Relay's sandbox layer checks it before every turn (confine TokenStore).
 */
export interface TokenStoreGrant {
  /** How doctor and the turn's log name it: "Grok's login directory". */
  name: string;
  /** The directory, relative to the person's home folder: ".grok". */
  dir: string;
  /** Files whose data the turn may rewrite and which a rename may replace: ["auth.json"]. */
  files: readonly string[];
  /** Names the turn may create and rewrite, not remove: ["auth.json.lock"]. */
  locks: readonly string[];
  /** The temp-name pattern, for one name: anchored; literals, `\.` and character classes, one at least repeated. */
  tempName: string;
}

export interface TargetDef {
  /**
   * Automatic model choice. Never a pin, so a model the harness reports choosing under it is no
   * switch (backends/acp.ts). For a multi-model harness (vendor null), also no known family, even
   * if the harness reports a model; a fixed-vendor target's family is its vendor's either way.
   */
  autoModel?: string;
  /** Model ids and aliases of this target's own family; used only to lower labels. */
  ownModels?: RegExp;
  id: Target;
  /**
   * The single family this target runs, or null for a multi-model harness. Omitted-target
   * routing compares families; explicit targets are admitted and labelled unless strict.
   */
  vendor: Vendor | null;
  /**
   * Reviewed model-to-family map for a multi-model harness. Unlisted or automatic choices
   * are labelled unknown; strict admission and omitted-target routing require a listed model.
   */
  models?: Readonly<Record<string, Vendor>>;
  /**
   * For a target judged per model: true where relay's own settings for its harness let it run only
   * the models in `models` (Grok's `allowed_models`). The ACP driver then refuses a turn that names
   * another before the harness starts, so only a turn that names none runs labelled family unknown.
   */
  listedModelsOnly?: boolean;
  /** Whether relay may launch this target when the config does not say. Targets added after claude and codex are off until switched on. */
  enabledByDefault: boolean;
  /** The CLI's name, looked up on PATH unless targets.<id>.bin says otherwise. */
  defaultBin: string;
  /** Used in messages to agents: "You are a Claude agent". */
  name: string;
  /** What the user installs, as the installer and doctor name it. */
  product: string;
  /** Prefix of this side's item ids in a review (C1, X2). Unique across the registry, and persisted in review files. */
  reviewPrefix: string;
  /** Matched against the MCP client's name, to tell which family a root session's host is when it was registered without --host. */
  clientNames: RegExp;
  /** The CLI version relay's confinement was checked against by hand, as the floor. Older ones are refused. */
  tested: readonly [number, number, number];
  /** Later CLI versions relay was also checked with by hand, which doctor names with `tested`. They move no floor. */
  checked?: readonly (readonly [number, number, number])[];
  /** This family's credentials, as its harness would take them from the environment in place of its stored login. Removed from every launched agent's environment. */
  credentialEnv: RegExp;
  /**
   * Variables that would also take the place of this harness's stored login but are not a family's
   * own credentials (a GitHub token that other tools use as well): removed from this target's own
   * environment only, when it signs in with its login, and left for every other launched agent.
   */
  loginEnv?: RegExp;
  /**
   * Variables that point the CLI at another endpoint than its vendor's, where any model could
   * answer. Relay does not launch the target with one of them in its environment: it could no
   * longer tell which family it was reaching.
   */
  endpointEnv: RegExp;
  /**
   * How a launched agent asks for approval to act outside its sandbox. "relay-tool": through a
   * tool on relay's MCP server, which the agent then needs even when it may not delegate.
   * "in-band": through the backend's own connection to the agent. "none": it cannot ask.
   */
  approvals: { channel: "relay-tool"; tool: PermissionTool } | { channel: "in-band" } | { channel: "none" };
  /**
   * The command that opens one of this target's sessions in the user's own CLI, by session id.
   * `harnessState`: the item's directory under relay's harness directory, for a harness whose
   * sessions live in the per-session state relay prepared for it (Copilot's home) rather than in
   * the user's own.
   */
  resumeCommand(sessionId: string, at: { harnessState: string }): string;
  /**
   * Why relay shows no command that opens this target's sessions in the user's own CLI, where that
   * would run the harness outside relay's sandbox on session state the confined agent could write
   * (Grok's, in relay's harness home for the item). `resume_natively` then carries this note and no
   * command. Absent: relay shows resumeCommand's.
   */
  nativeResumeWithheld?: string;
  /** What relay can promise for it: see Capabilities. */
  capabilities: Capabilities;
  /**
   * For a harness that takes relay's tools through its own command-based tool discovery rather than
   * relay's MCP bridge (Gemini CLI, which connects no MCP server in the untrusted folder relay runs
   * it in): the prefix the harness puts on each discovered tool's name, which relay's prompts tell
   * the agent, and the harness versions relay's tools were verified on live. Informational: the tools
   * are offered on every version relay's version gate lets run, since what keeps them safe is relay's
   * sandbox and broker; each launch checks that discovery ran and tells the agent where it did not
   * (backends/gemini.ts geminiDiscoveryCheck). Doctor says whether the installed version is listed,
   * and a turn on an unlisted one gets a short note.
   */
  toolDiscovery?: { prefix: string; versions: readonly string[] };
  /** The speeds above standard relay can ask it for (see Speed). Unset: standard only. */
  speeds?: Partial<Record<Exclude<Speed, "standard">, SpeedOption>>;
  /**
   * For a relay-enforced target: the exact host names its harness must reach on port 443 to work
   * (its model API, token exchange, and nothing it can work without), lower case, no wildcards. A
   * turn without network access reaches these and nothing else, through relay's per-turn proxy
   * (src/confine/proxy.ts); its telemetry and update checks are left out, so they are refused.
   * Reviewed as code, never read from config. `capabilities.networkOff` may be true only when this
   * is set; relay refuses a network-off turn of a target that declares none.
   */
  apiHosts?: readonly string[];
  /**
   * A login directory in the person's home where a confined turn may refresh the harness's login by
   * writing a temp file and renaming it into place, as Grok does (~/.grok). A stated downgrade,
   * reviewed as code, never read from config: see TokenStoreGrant.
   */
  tokenStore?: TokenStoreGrant;
  /**
   * False until relay has qualified it end to end with a signed-in run (login, model selection,
   * protocol behaviour, confinement probes). An unqualified target is experimental, and runs only
   * with targets.<id>.experimental set; on a qualified one that setting is accepted and changes nothing.
   */
  qualified: boolean;
  text: {
    /** How this agent asks for approval when its sandbox stops it, as an instruction to it. */
    blockedHow(mode: Mode): string;
    /**
     * Where only some of what a sandbox blocks can be asked for: what this turn can ask for, named
     * as the blocked things are (core/prompts.ts blockedAdvice), or null when it can ask for nothing,
     * and is told to finish and report instead. `webDenied`: the run's captured never.hosts withholds
     * the host's own web tools (false does not mean they are allowed: see core/prompts.ts
     * webWithheld). Without it, everything blocked can be asked for, through blockedHow.
     */
    blockedAsks?(mode: Mode, turn: { network: boolean; webDenied: boolean }): string | null;
    /**
     * What this agent is told about its shell's network when it has no network grant, where that
     * differs from what blockedHow implies (its sandbox refuses connections without asking relay).
     * `canAsk`: whether its web tools may be able to ask for approval on this turn (policy can still
     * deny them, so the text must not promise a prompt).
     */
    shellNetwork?(canAsk: boolean): string;
  };
}
