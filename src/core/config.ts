import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SPEEDS, TARGET_IDS, targetDef, type Speed, type Target } from "../targets/index.js";
import { backendOwnedEnvironmentName, effectiveChildEnv, ENVIRONMENT_NAME, mandatoryEnvironmentReason, type ChildEnvSettings } from "./env-policy.js";
import { NEVER_RETIRED_BUILTIN_IDS, NeverConfigSchema, type NeverConfig } from "./never-schema.js";

/** Whether a session's turns have the network: a grant gives it, and so does child_network for every launched agent. */
export const networkOn = (cfg: Pick<RelayConfig, "child_network">, grant: { network?: boolean } | null | undefined): boolean => Boolean(grant?.network || cfg.child_network);

/** relay's own CLI as built (dist/cli.js), which relay runs to start its workers and launched agents' relay servers. */
export const RELAY_CLI = path.resolve(import.meta.dirname, "..", "cli.js");

/**
 * `p` with a leading `~` (alone, or followed by `/`) replaced by the home folder. Nothing else:
 * each caller resolves the result, or checks that it is absolute, in its own way (review C1).
 */
export const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, os.homedir());

/** Relay's version, from package.json. */
export const VERSION: string = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8")).version);
  } catch {
    return "unknown";
  }
})();

export type { Speed, Target };
export type Mode = "read" | "write";

export interface RelayConfig {
  /** Additive never policy. Only person-edited config can override eligible built-ins. */
  never: NeverConfig;
  max_depth: number;
  max_concurrent: number;
  /** Seconds a blocking tool call waits before returning a pending handle. */
  block_s: number;
  /**
   * Wall-clock limits on one turn of a job, and of a consult or discussion turn, after which relay
   * cancels it. null (the default): none; a turn runs until it ends, is cancelled, or its agent
   * dies. These are cancellations, unlike block_s, which only ends a call's wait.
   */
  job_timeout_s: number | null;
  turn_timeout_s: number | null;
  cancel_grace_ms: number;
  child_mcp: "relay-only" | "inherit";
  child_hooks: boolean;
  child_network: boolean;
  child_git: "relay" | "native";
  allow_dangerous: boolean;
  /** Let a write job ask for approval to act outside its sandbox. The request goes to the root session. */
  escalation: boolean | { enabled?: boolean; port0_authority?: "supervisor" | "person" };
  approval_timeout_s: number;
  /**
   * Show a macOS desktop notification when an agent files an approval request. Off by default: it
   * cannot link anywhere, and the request reaches the session as an approval dialog or a notice.
   */
  desktop_notifications: boolean;
  /**
   * Whether a root session puts approval requests to the user directly through its host (MCP
   * elicitation). "auto": only hosts positively known to show the question (src/mcp/host.ts).
   * "always": still requires a host qualified to show approval dialogs (as does "auto").
   * "never": not at all. A cancel never decides a request.
   */
  ask_user: "auto" | "always" | "never";
  /**
   * Host web tools in launched agents (Claude's WebSearch and WebFetch, Codex's web search) when no
   * network grant applies. "inherit": the user's own host settings decide. "ask": Claude's ask
   * for approval and Codex's search is off. Shell network access is off either way.
   */
  child_web: "inherit" | "ask";
  /**
   * How Codex is run. "app-server" (default): every turn, with approval requests and a check of
   * the effective configuration on the server about to be used. "exec": `codex exec`, with no
   * approval requests and the same check made through a short-lived app server first.
   */
  codex_backend: "app-server" | "exec";
  /** Allow relay's control directory to live under a temp directory. For tests only: a job's sandbox can write there. */
  allow_temp_home: boolean;
  /**
   * Which of the user's own Claude Code settings a launched Claude agent loads. "isolated"
   * (default): none of the user, project or local settings files, so their allow rules, extra
   * directories and allowed domains cannot widen a job, and a job cannot widen itself by writing
   * a settings file into its worktree. Their deny rules do not apply either. "inherit": all of
   * them load, with both effects.
   */
  child_settings: "isolated" | "inherit";
  /**
   * How launched agents sign in. "login" (default): credentials are removed from their
   * environment, and relay checks that each CLI is using an account login (Claude subscription,
   * ChatGPT account), refusing to run a turn that would bill an API key. "any": the environment
   * accepts whatever the CLI signs in with (API keys, Bedrock, Vertex). Its own supported auth
   * inputs still need selection by child_env, and every other vendor's credentials are removed.
   * The global spelling remains accepted with a warning; its cross-vendor exception ended in 1.0.
   * Prefer targets.<id>.child_auth for a target-specific auth ceiling.
   */
  child_auth: "login" | "any";
  /** Exact inherited-variable policy, selected by the person. */
  child_env: ChildEnvSettings;
  /**
   * Whether the repository's own content filters (filter.<name>.clean and the like, other than
   * Git LFS) and merge drivers may stand when relay commits, checks out or merges a job's files.
   * They run outside the sandbox on files an agent wrote (its .gitattributes chooses which), and a
   * command that runs a script or an interpreter can be redirected by those files. false (default):
   * relay refuses such a repository for write jobs, and runs no git there that could start one.
   * Diff drivers (textconv, command) and an external diff are not covered: relay's own diffs pass
   * --no-ext-diff --no-textconv and nothing else it runs uses them, so they never run on a job's files.
   */
  trust_git_filters: boolean;
  /**
   * Organisation-managed Claude Code settings outrank the settings relay passes, so relay cannot
   * tell whether its confinement holds under them. "refuse" (default): do not launch Claude on a
   * machine that has them. "accept": launch anyway.
   */
  claude_managed_settings: "refuse" | "accept";
  /**
   * Whether to launch Claude when settings relay does not vet would load: the user's, project and
   * local settings (child_settings "inherit"), or managed settings found on disk and accepted. Their
   * env can redirect Claude to another endpoint after relay's environment check. "refuse" (default):
   * do not launch. "accept": launch anyway; which family answers then rests on the model Claude reports.
   */
  claude_settings_env: "refuse" | "accept";
  /**
   * Whether to launch Codex when its own configuration (config.toml, or a profile it selects) sends
   * OpenAI's provider to another endpoint: openai_base_url, or a base_url for the provider (or
   * ChatGPT-login traffic: chatgpt_base_url, experimental_realtime_*_base_url). "refuse"
   * (default): do not launch, since relay cannot tell which family of model answers there. "accept":
   * launch anyway. OPENAI_BASE_URL in the environment is refused either way.
   */
  codex_endpoint_override: "refuse" | "accept";
  /** Run on a platform or CLI version relay has not been tested with. Confinement there is unverified. Does not switch on an experimental target (targets.<id>.experimental does). */
  allow_untested: boolean;
  /**
   * "allow" (default): explicit own-family and unknown-caller work is admitted and labelled;
   * native subagents are the first choice for one's own family. "refuse": strict admission,
   * including unknown callers and multi-family models. Omitted targets never pick the caller's
   * routing family under either setting; labels may still be unknown (for example a waiver).
   */
  same_family: "refuse" | "allow";
  /**
   * Days without activity after which a finished run's records are forgotten: its prompts,
   * agents' logs, transcripts and final messages under runs/<id>, its harness state, and its rows
   * in the registry. Applied by `relay clean`, and by a worker at most once a day. A run is kept
   * while anything in it is active (queued or running, a live worker or agent, an open discussion,
   * a pending request), while its session is still open, and while a job of it has a worktree or a
   * branch left, or a branch relay cannot look for. null (the default): records are kept until
   * you delete them.
   */
  keep_records_days: number | null;
  /**
   * Size in megabytes at which these logs are rotated: each agent's log and worker log,
   * proxy.jsonl, elicitation.log and notices.log. Each
   * is moved to <name>.1, replacing an earlier one, so that about twice this is kept per log, the
   * newest part. null (the default): logs grow without limit.
   */
  log_max_mb: number | null;
  /** Per target: whether relay may launch it, where its CLI is, and its defaults. Every target in the registry has an entry. */
  targets: Record<Target, TargetConfig>;
  /**
   * The target a call reaches when it names none, by the caller's target. Needed only when more
   * than one target of another family is switched on.
   */
  default_target: Partial<Record<Target | "unknown", Target>>;
}

export interface TargetConfig {
  /** Codex only: Relay-owned state and qualified binary store. Pins are required unless explicitly disabled. */
  home?: string;
  pin_store?: string;
  pinned?: boolean;
  /**
   * Codex only: stage 2, Codex's commands in relay's own Seatbelt, which grant.raw_network needs
   * (docs/codex-confinement-design.md; core/raw-network.ts). Off unless true.
   */
  stage2?: boolean;
  /** Codex only, for the account holder's own use: true requests Daybreak for eligible models, false pins off, unset leaves Codex's own configuration. Person-set in relay's config only. */
  daybreak?: boolean;
  /** Whether relay may launch it. claude and codex are on unless switched off; targets added later are off until switched on. */
  enabled: boolean;
  /** Its CLI: a name looked up on PATH, or a full path. */
  bin: string;
  /** Used when a call names no model or effort. Unset: the CLI's own default. */
  default_model?: string;
  default_effort?: string;
  /**
   * The speed of new work (a job, thread, discussion or review) a root session starts with this
   * target without naming one (see Speed). Unset: standard. A call that carries on a session and
   * names none keeps that session's speed, and work a launched agent starts runs at its own speed.
   */
  speed?: Speed;
  /**
   * How this target signs in, where it differs from the global child_auth. "any" for one target
   * passes that target's own credentials through and accepts whatever it signs in with, while
   * every other vendor's credentials are still removed from its environment.
   */
  child_auth?: "login" | "any";
  child_env?: ChildEnvSettings;
  /**
   * Lets relay launch this target although relay has not qualified it with a signed-in run (it is
   * experimental). Off unless set; allow_untested does not stand in for it. Accepted, and without
   * effect, on a qualified target, so that a config written while it was experimental still loads.
   */
  experimental?: boolean;
  /**
   * Skills a job or thread of this target may be given as an extension (docs/extensions.md), when
   * the root session asks for them and the person consents: "none" (the default, also when unset),
   * "user" (the person's own user skills for this target's CLI), or a list of skill names in those
   * directories and paths of skill directories. 1.0 only: keep it out of a config file a 0.9 relay reads.
   */
  skills?: SkillsSetting;
  /**
   * MCP servers a job or thread of this target may be given as an extension, by their names in
   * relay's own mcp.json, each optionally with the tools that run without asking the person
   * (allow_tools). Every other call of their tools asks the person. 1.0 only, as skills.
   */
  mcp_servers?: McpServerSetting[];
}

/** targets.<id>.skills. */
export type SkillsSetting = "none" | "user" | string[];
/** One entry of targets.<id>.mcp_servers: a server's name in relay's mcp.json, or the name with the tools that run without asking. */
export type McpServerSetting = string | { name: string; allow_tools?: string[] };

/**
 * What a config file may hold: the settings above, with targets given in part, plus the
 * per-target keys of earlier versions (bin, default_model and default_effort keyed by target),
 * which stay valid. Setting the same thing both ways is an error.
 */
export type ConfigFile = Partial<Omit<RelayConfig, "targets">> & {
  targets?: Partial<Record<Target, Partial<TargetConfig>>>;
  /** The earlier name of desktop_notifications. */
  notify?: boolean;
  bin?: Partial<Record<Target, string>>;
  default_model?: Partial<Record<Target, string>>;
  default_effort?: Partial<Record<Target, string>>;
};
const vendorOf = (id: Target) => targetDef(id).vendor;
/** A target's entry when the config says nothing about it. */
const targetDefaults = (id: Target): TargetConfig => ({ enabled: targetDef(id).enabledByDefault, bin: targetDef(id).defaultBin,
  ...(id === "codex" ? { home: "~/.local/share/relay-codex-home", pin_store: "~/.local/share/relay-codex-pins", pinned: true } : {}) });

export const relayCodexHome = (cfg: Pick<RelayConfig, "targets">): string => path.resolve(expandHome(cfg.targets.codex.home ?? "~/.local/share/relay-codex-home"));
export const relayCodexPinStore = (cfg: Pick<RelayConfig, "targets">): string => path.resolve(expandHome(cfg.targets.codex.pin_store ?? "~/.local/share/relay-codex-pins"));

/** The earlier per-target keys, and the field of targets.<id> each one sets. */
const LEGACY = { bin: "bin", default_model: "default_model", default_effort: "default_effort" } as const;

export const DEFAULT_CONFIG: RelayConfig = {
  never: { paths: [], ports: [], hosts: [], override_builtin: [] },
  max_depth: 3,
  max_concurrent: 4,
  block_s: 240,
  job_timeout_s: null,
  turn_timeout_s: null,
  cancel_grace_ms: 5000,
  child_mcp: "relay-only",
  child_hooks: false,
  child_network: false,
  child_git: "relay",
  allow_dangerous: false,
  escalation: true,
  approval_timeout_s: 3600,
  desktop_notifications: false,
  ask_user: "auto",
  child_web: "inherit",
  codex_backend: "app-server",
  allow_temp_home: false,
  child_settings: "isolated",
  child_auth: "login",
  child_env: { policy: "allowlist", pass: [], drop: [], request: [] },
  trust_git_filters: false,
  claude_managed_settings: "refuse",
  claude_settings_env: "refuse",
  codex_endpoint_override: "refuse",
  allow_untested: false,
  same_family: "allow",
  keep_records_days: null,
  log_max_mb: null,
  // Every target's entry, from the registry, read when first used (the registry may still be loading when this module is).
  get targets() {
    return Object.fromEntries(TARGET_IDS.map((id) => [id, targetDefaults(id)])) as Record<Target, TargetConfig>;
  },
  default_target: {},
};

/** State directory: registry, logs, transcripts, worktrees. */
export function relayHome(): string {
  return process.env.RELAY_HOME || path.join(os.homedir(), ".local", "state", "relay");
}

/**
 * Where job worktrees live. Deliberately outside the control directory: agents write in their
 * worktrees, and nothing an agent can write should sit next to the registry.
 */
export function worktreesHome(): string {
  if (process.env.RELAY_WORKTREES) return process.env.RELAY_WORKTREES;
  if (process.env.RELAY_HOME) return `${process.env.RELAY_HOME.replace(/\/+$/, "")}-worktrees`;
  return path.join(os.homedir(), ".local", "share", "relay", "worktrees");
}
/**
 * Where relay keeps the state of harnesses it confines itself (Copilot's home, say), one directory
 * per session, so that their sessions carry from turn to turn. Outside the control directory,
 * which a confined agent may not read, and beside the worktrees, as theirs is agents' state.
 */
export function harnessHome(): string {
  if (process.env.RELAY_HOME) return `${process.env.RELAY_HOME.replace(/\/+$/, "")}-harness`;
  return path.join(os.homedir(), ".local", "share", "relay", "harness");
}
/**
 * Where consults work when their root session names no directory and relay was started outside any
 * project (the desktop app): each new thread in a new, empty directory of its own under this one
 * (caller.ts newConsultDir), so that a question needs no project and the consulted agent is not
 * pointed at your home. Outside the control directory; no job may be granted it.
 */
export function consultHome(): string {
  if (process.env.RELAY_HOME) return `${process.env.RELAY_HOME.replace(/\/+$/, "")}-consult`;
  return path.join(os.homedir(), ".local", "share", "relay", "consult");
}
export function worktreeDir(runId: string, jobId: string): string {
  return path.join(worktreesHome(), runId, jobId);
}

/**
 * The real path, for a path that may not exist yet: its nearest existing ancestor is resolved and
 * the rest appended. On macOS /tmp and /var are aliases, and a directory about to be created
 * under one of them must compare equal to its resolved form. The existing part is resolved by the
 * system (realpath(3)), which also gives each name its case on disk: on macOS's default disks,
 * which ignore case, `~/.CONFIG` is `~/.config`, and Node's own realpathSync keeps the case it was given.
 */
export function canonical(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...rest);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
const under = (c: string, p: string) => c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
/** True when child is parent or lies under it. Correct for a filesystem root, which already ends in a separator. */
export const inside = (child: string, parent: string) => under(canonical(child), canonical(parent));

/**
 * A canonical path as a check that keeps paths out compares it (relay's own directories and config
 * files): on macOS, whose default disks ignore case and Unicode normalisation, without either,
 * and under the short name of a directory the data volume firmlinks into / (/Users for
 * /System/Volumes/Data/Users). canonical() gives the part of a path that exists its name on disk,
 * but not a part that does not exist yet, and a file made there under another case of a name is the
 * file of that name.
 */
export const foldedPath = (p: string): string => {
  if (process.platform !== "darwin") return canonical(p);
  const folded = canonical(p).normalize("NFC").toLowerCase();
  // The data volume's own name for a firmlinked directory: /System/Volumes/Data/Users is /Users, and
  // realpath(3) leaves each name as it is given. Folded to the short name, so that neither names a
  // kept-out path past the check. A name with no firmlink behind it is folded too: that can only keep
  // more out.
  if (folded === DATA_VOLUME) return "/";
  return folded.startsWith(`${DATA_VOLUME}/`) ? folded.slice(DATA_VOLUME.length) : folded;
};
/** Where macOS mounts the data volume, whose top-level directories are firmlinked into / (lower case, as foldedPath compares). */
const DATA_VOLUME = "/system/volumes/data";
/**
 * inside(), for a check that keeps a path out: on macOS a name in another case, or under the data
 * volume's name, counts as the same. Never for a check that lets a path in, where a disk that does
 * tell case apart would make two names one.
 */
export const insideAnyCase = (child: string, parent: string) => under(foldedPath(child), foldedPath(parent));
/**
 * insideAnyCase in either direction for an entry that is (or will be) a link, compared by its own
 * name: its directory is resolved, the entry is not. True for a path that covers the link (and so
 * could replace it) or names it. A path through a link that exists resolves to where the link leads
 * and is not caught here: a check of that place (the grant check's of ~/.rn) has to catch it.
 */
export const overlapsEntryAnyCase = (p: string, entry: string): boolean => {
  const byName = (q: string) => {
    const name = path.basename(path.resolve(q));
    return path.join(foldedPath(path.dirname(path.resolve(q))), process.platform === "darwin" ? name.normalize("NFC").toLowerCase() : name);
  };
  const own = byName(entry);
  // `p` resolved, and `p` by its own last name (the link itself, when `p` names it).
  return [foldedPath(p), byName(p)].some((other) => under(own, other) || under(other, own));
};

/** True when a path is in a directory that both agents' sandboxes leave writable. */
export function underTemp(p: string): boolean {
  return [os.tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"].some((t) => inside(p, t));
}

export function configPath(): string {
  if (process.env.RELAY_CONFIG) return process.env.RELAY_CONFIG;
  if (process.env.RELAY_HOME) return path.join(process.env.RELAY_HOME, "config.json");
  return path.join(os.homedir(), ".config", "relay", "config.json");
}

/** An object keyed by target id, every key optional, no other keys. */
const byTarget = <T extends z.ZodTypeAny>(value: T) => z.object(Object.fromEntries(TARGET_IDS.map((id) => [id, value])) as Record<Target, T>).partial().strict();
const side = byTarget(z.string().min(1));
/**
 * A skill as targets.<id>.skills names it: a skill directory's name (looked up in the target CLI's
 * own user skill directories), or the path of a skill directory, absolute or under ~/.
 */
const skillRef = z.string().refine((v) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) || ((v.startsWith("/") || v.startsWith("~/")) && !v.split("/").includes("..")), {
  message: "a skill is the name of one of your skill directories (letters, digits, '.', '_', '-') or the absolute or ~/ path of a skill directory",
});
/** A server's name in relay's mcp.json. It prefixes its tools' names (<server>__<tool>), so it holds no double underscore. */
export const SERVER_NAME = /^(?!.*__)[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const serverName = z.string().regex(SERVER_NAME, "an MCP server's name is up to 32 letters, digits, '_' or '-', without '__'");
const toolName = z.string().min(1).max(64);
const environmentName = z.string().regex(ENVIRONMENT_NAME, "use an exact environment variable name (letters, digits and underscore; no wildcards)");
const childEnvSchema = z.object({
  policy: z.enum(["allowlist", "legacy"], { error: "child_env.policy must be allowlist or legacy; tool-denylist is not available yet" }).optional(),
  pass: z.array(environmentName).optional(), drop: z.array(environmentName).optional(), request: z.array(environmentName).optional(),
}).strict();
const targetSchema = z.object({
  enabled: z.boolean(), bin: z.string().min(1), default_model: z.string().min(1), default_effort: z.string().min(1),
  speed: z.enum(SPEEDS),
  child_auth: z.enum(["login", "any"]),
  child_env: childEnvSchema,
  experimental: z.boolean(),
  skills: z.union([z.enum(["none", "user"]), z.array(skillRef).min(1)]),
  mcp_servers: z.array(z.union([serverName, z.object({ name: serverName, allow_tools: z.array(toolName).optional() }).strict()])),
}).partial().strict();
const codexTargetSchema = targetSchema.extend({ daybreak: z.boolean().optional(), stage2: z.boolean().optional(),
  home: z.string().min(1).refine((p) => path.isAbsolute(expandHome(p)), "must be absolute or start with ~/").optional(),
  pin_store: z.string().min(1).refine((p) => path.isAbsolute(expandHome(p)), "must be absolute or start with ~/").optional(),
  pinned: z.boolean().optional() });
const seconds = z.number().positive();
/** What a config file may contain. Unknown keys and wrong types are errors, not ignored: a quoted "false" must never read as true. */
export const ConfigSchema = z.object({
  never: NeverConfigSchema,
  max_depth: z.number().int().min(1).max(10),
  max_concurrent: z.number().int().min(1).max(64),
  block_s: seconds, job_timeout_s: seconds.nullable(), turn_timeout_s: seconds.nullable(),
  cancel_grace_ms: z.number().nonnegative(),
  child_mcp: z.enum(["relay-only", "inherit"]),
  child_hooks: z.boolean(), child_network: z.boolean(),
  child_git: z.enum(["relay", "native"]),
  allow_dangerous: z.boolean(), escalation: z.union([z.boolean(), z.strictObject({ enabled: z.boolean().optional(), port0_authority: z.enum(["supervisor", "person"]).optional() })]),
  approval_timeout_s: seconds, desktop_notifications: z.boolean(), notify: z.boolean(),
  ask_user: z.enum(["auto", "always", "never"]),
  child_web: z.enum(["inherit", "ask"]),
  codex_backend: z.enum(["app-server", "exec"]),
  allow_temp_home: z.boolean(),
  child_settings: z.enum(["isolated", "inherit"]),
  child_auth: z.enum(["login", "any"]),
  child_env: childEnvSchema,
  trust_git_filters: z.boolean(),
  claude_managed_settings: z.enum(["refuse", "accept"]),
  claude_settings_env: z.enum(["refuse", "accept"]),
  codex_endpoint_override: z.enum(["refuse", "accept"]),
  allow_untested: z.boolean(),
  same_family: z.enum(["refuse", "allow"]),
  keep_records_days: z.number().positive().nullable(),
  log_max_mb: z.number().positive().nullable(),
  default_model: side, default_effort: side, bin: side,
  targets: z.object({ ...byTarget(targetSchema).shape, codex: codexTargetSchema.optional() }).strict(),
  default_target: z.object({ ...byTarget(z.enum(TARGET_IDS)).shape, unknown: z.enum(TARGET_IDS).optional() }).strict().partial(),
}).strict().partial().superRefine((cfg, ctx) => {
  for (const problem of configConflicts(cfg as ConfigFile)) ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
});

/** What a config sets twice (an earlier per-target key and targets.<id>), or a default target that crosses no family. */
function configConflicts(cfg: ConfigFile): { path: string[]; message: string }[] {
  const out: { path: string[]; message: string }[] = [];
  // Root entries apply to every destination; target entries are checked against that target.
  const guardConfig = { child_auth: cfg.child_auth ?? "login", targets: cfg.targets ?? {} } as RelayConfig;
  const checkEnv = (setting: ChildEnvSettings | undefined, ids: readonly Target[], prefix: string[]) => {
    if (!setting) return;
    for (const key of ["pass", "request"] as const) for (const name of setting[key] ?? []) {
      // A root entry is an error only where no target could ever receive it (GH_TOKEN at the root
      // serves gh in Claude and Codex jobs; Copilot's login guard still keeps it from Copilot, at
      // selection, and doctor names that reason). A target's own entry must be selectable for it.
      const reasons = ids.map((id) => mandatoryEnvironmentReason(id, guardConfig, name));
      if (reasons.every(Boolean)) {
        out.push({ path: [...prefix, key], message: `${name} cannot be selected for ${ids.length === 1 ? ids[0] : "any target"}: ${reasons[0]}` });
      }
    }
    for (const name of setting.drop ?? []) if (backendOwnedEnvironmentName(name)) out.push({ path: [...prefix, "drop"], message: `${name} cannot be dropped: backend-owned control` });
  };
  checkEnv(cfg.child_env, TARGET_IDS, ["child_env"]);
  for (const id of TARGET_IDS) checkEnv(cfg.targets?.[id]?.child_env, [id], ["targets", id, "child_env"]);
  for (const [legacy, field] of Object.entries(LEGACY) as [keyof typeof LEGACY, keyof TargetConfig][]) {
    for (const id of Object.keys(cfg[legacy] ?? {}) as Target[]) {
      if (cfg.targets?.[id]?.[field] !== undefined) out.push({ path: [legacy, id], message: `set both here and as targets.${id}.${field}; keep one` });
    }
  }
  if (cfg.notify !== undefined && cfg.desktop_notifications !== undefined) out.push({ path: ["notify"], message: "set both here and as desktop_notifications, its new name; keep desktop_notifications" });
  for (const [from, to] of Object.entries(cfg.default_target ?? {}) as [Target | "unknown", Target][]) {
    if (from !== "unknown" && vendorOf(from) !== null && vendorOf(from) === vendorOf(to)) out.push({ path: ["default_target", from], message: `${to} is the same family as ${from}, which relay never reaches from it` });
  }
  // A speed the target has not got, or not for its default model, would refuse every call that names neither.
  for (const [id, t] of Object.entries(cfg.targets ?? {}) as [Target, TargetConfig][]) {
    if (!t?.speed || t.speed === "standard" || !TARGET_IDS.includes(id)) continue;
    const def = targetDef(id);
    const option = def.speeds?.[t.speed];
    const model = t.default_model ?? cfg.default_model?.[id];
    if (!option) {
      const has = SPEEDS.filter((s) => s === "standard" || def.speeds?.[s]);
      out.push({ path: ["targets", id, "speed"], message: `${def.name} has no ${t.speed} speed in relay; it runs at ${has.join(" or ")}` });
    } else if (option.models && model && option.models.has(model) === false) {
      out.push({ path: ["targets", id, "speed"], message: `${def.name}'s ${t.speed} speed is for ${option.models.names} only, and its default model is ${JSON.stringify(model)}` });
    }
  }
  out.push(...extensionConflicts(cfg));
  return out;
}

/** The name of an entry of targets.<id>.mcp_servers. */
export const serverOf = (e: McpServerSetting): string => (typeof e === "string" ? e : e.name);
/** Whether a target's entry gives it any extension at all. */
export const hasExtensions = (t: Partial<TargetConfig> | undefined): boolean =>
  Boolean((t?.skills !== undefined && t.skills !== "none") || t?.mcp_servers?.length);

/**
 * What a config cannot hold together with extensions (docs/extensions.md): a target that cannot
 * take them; the legacy inheritance settings, which load the person's own servers, hooks or
 * settings ungated (review C17); for MCP servers, network for every job or full access, which
 * would let an agent use credentials it can read past relay's gate (review C2/X1); any extension
 * without approval requests, which the person's consent is; any extension for Codex under the exec
 * backend, which has no way to give skills or to check which skills it loads (a turn given MCP
 * servers alone is checked for skills too).
 */
function extensionConflicts(cfg: ConfigFile): { path: string[]; message: string }[] {
  const out: { path: string[]; message: string }[] = [];
  const setting = <K extends keyof RelayConfig>(k: K): RelayConfig[K] => (cfg[k as keyof ConfigFile] as RelayConfig[K] | undefined) ?? DEFAULT_CONFIG[k];
  for (const id of Object.keys(cfg.targets ?? {}) as Target[]) {
    const t = cfg.targets![id]!;
    if (!hasExtensions(t)) continue;
    const keys = [...(t.skills !== undefined && t.skills !== "none" ? ["skills"] : []), ...(t.mcp_servers?.length ? ["mcp_servers"] : [])];
    const at = (key: string) => ["targets", id, key];
    if (!targetDef(id).capabilities.extensions) {
      for (const key of keys) out.push({ path: at(key), message: `relay gives extensions only to Claude and Codex agents; ${targetDef(id).name} runs inside relay's own sandbox, which a skill or server from outside would cross. Remove it` });
      continue;
    }
    const first = keys[0];
    // child_settings is about Claude Code's settings files alone, so it waives nothing for a Codex agent.
    for (const [legacy, waives, what] of [
      ["child_mcp", setting("child_mcp") === "inherit", 'child_mcp "inherit" loads every MCP server of yours in every launched agent'],
      ["child_hooks", setting("child_hooks"), "child_hooks true runs your hooks in every launched agent"],
      ["child_settings", id === "claude" && setting("child_settings") === "inherit", 'child_settings "inherit" loads your Claude Code settings, plugins and skills among them, in every launched Claude agent'],
    ] as const) {
      if (waives) out.push({ path: at(first), message: `extensions cannot be combined with ${legacy}: ${what}, ungated, which would make the allowlist meaningless. Use one or the other` });
    }
    if (!escalationEnabled({ escalation: setting("escalation") })) out.push({ path: at(first), message: "extensions need the user's consent, which relay asks for as an approval request, and escalation is false" });
    if (t.mcp_servers?.length) {
      if (setting("child_network")) out.push({ path: at("mcp_servers"), message: "MCP servers cannot be combined with child_network: an agent with the network could use credentials it can read to reach a server's service directly, past relay's gate" });
      if (setting("allow_dangerous")) out.push({ path: at("mcp_servers"), message: "MCP servers cannot be combined with allow_dangerous: a write job with full access could reach a server's service directly, past relay's gate" });
      const seen = new Set<string>();
      for (const e of t.mcp_servers) {
        const name = serverOf(e);
        if (seen.has(name)) out.push({ path: at("mcp_servers"), message: `${name} is named more than once` });
        seen.add(name);
      }
    }
    if (id === "codex" && setting("codex_backend") === "exec") {
      out.push({ path: at(first), message: 'extensions for Codex need codex_backend "app-server": codex exec has no way for relay to give skills or to check which skills it loads, which a session given MCP servers alone is checked for too' });
    }
  }
  return out;
}

/** Checks a parsed config file. Returns the settings it gives, or throws naming every problem. */
export function validateConfig(raw: unknown, where: string): ConfigFile {
  // Without zod's compiled fast path (jitless, its documented switch for that): a config is a small
  // object checked a few times per call, where compiling a parser for its every object, which the
  // first check would do, costs more than it saves. The checks themselves are the same.
  const r = ConfigSchema.safeParse(raw, { jitless: true });
  if (r.success) return r.data as ConfigFile;
  const problems = r.error.issues.map((i) => `${i.path.join(".") || "(top level)"}: ${i.message}`).join("; ");
  throw new Error(`relay config at ${where} is not valid, so relay will not start with it. ${problems}`);
}

/** Deprecated spellings stay readable throughout 1.x. Never include config values in diagnostics. */
export function configDeprecations(user: ConfigFile): string[] {
  const replacements = { bin: "targets.<id>.bin", default_model: "targets.<id>.default_model", default_effort: "targets.<id>.default_effort", notify: "desktop_notifications" } as const;
  const warnings = Object.entries(replacements).filter(([key]) => user[key as keyof ConfigFile] !== undefined)
    .map(([key, replacement]) => `config key ${key} is deprecated; use ${replacement}. ${key} remains accepted throughout relay 1.x.`);
  for (const removal of user.never?.override_builtin ?? []) warnings.push((NEVER_RETIRED_BUILTIN_IDS as readonly string[]).includes(removal.id)
    ? `never.override_builtin names ${removal.id}, which is no longer a built-in never entry (relay 1.2.1), so it removes nothing. Delete it; list any port you want kept from jobs under never.ports with destinations "this-machine". It remains accepted throughout relay 1.x.`
    : `NEVER PROTECTION REMOVED: ${removal.id}. ${removal.acknowledge}. Reason: ${removal.reason}. Removal grants nothing and cannot shrink an existing run's never floor.`);
  if (user.child_auth === "any") warnings.push('global child_auth "any" no longer forwards other vendors\' credentials in relay 1.0; use targets.<id>.child_auth "any" and exact child_env.pass entries for that target\'s own auth inputs');
  const config = { child_env: user.child_env, targets: user.targets ?? {} } as RelayConfig;
  const legacy = TARGET_IDS.filter((id) => effectiveChildEnv(config, id).policy === "legacy");
  if (legacy.length) warnings.push(`child_env.policy legacy inherits unknown environment variables for ${legacy.join(", ")}; use allowlist and exact pass/request names. Legacy never disables mandatory target guards`);
  return warnings;
}

/**
 * Loads the user's config. Only a root instance calls this; the result is snapshotted into the
 * run row so that every process in a run works under the same limits.
 */
export function loadConfig(warn: (message: string) => void = (message) => process.stderr.write(`relay: WARNING: ${message}\n`)): RelayConfig {
  const file = configPath();
  let user: ConfigFile = {};
  if (fs.existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`relay config at ${file} is not valid JSON: ${(err as Error).message}`);
    }
    user = validateConfig(raw, file);
  }
  configDeprecations(user).forEach(warn);
  return withDefaults(user);
}

/**
 * A config with every setting present, and every target's entry, the earlier per-target keys
 * moved into them. Also used for a run's stored config, which may predate a setting or be in the
 * earlier form.
 */
export function withDefaults(user: ConfigFile): RelayConfig {
  const conflicts = configConflicts(user);
  if (conflicts.length) throw new Error(`relay config is not valid: ${conflicts.map((c) => `${c.path.join(".")}: ${c.message}`).join("; ")}`);
  const { bin, default_model, default_effort, targets, notify, ...rest } = user;
  const legacy = { bin, default_model, default_effort };
  const entries = TARGET_IDS.map((id): [Target, TargetConfig] => {
    const entry: TargetConfig = { ...targetDefaults(id), ...(targets?.[id] ?? {}) };
    for (const [key, field] of Object.entries(LEGACY) as [keyof typeof LEGACY, "bin" | "default_model" | "default_effort"][]) {
      const v = legacy[key]?.[id];
      if (v !== undefined) entry[field] = v;
    }
    return [id, entry];
  });
  return {
    ...DEFAULT_CONFIG, ...rest, ...(notify !== undefined && rest.desktop_notifications === undefined ? { desktop_notifications: notify } : {}), targets: Object.fromEntries(entries) as Record<Target, TargetConfig>, default_target: { ...(user.default_target ?? {}) } };
}

/** Legacy booleans keep their meaning; the object form owns the single port-0 policy key. */
export const escalationEnabled = (cfg: Pick<RelayConfig, "escalation">): boolean =>
  typeof cfg.escalation === "boolean" ? cfg.escalation : cfg.escalation.enabled !== false;

/** How a target signs in: its own child_auth, or the global one. */
export const authFor = (cfg: RelayConfig, id: Target): "login" | "any" => cfg.targets[id]?.child_auth ?? cfg.child_auth;

export function runDir(runId: string): string {
  return path.join(relayHome(), "runs", runId);
}

export function nodeDir(runId: string, nodeId: string): string {
  const dir = path.join(runDir(runId), "nodes", nodeId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
