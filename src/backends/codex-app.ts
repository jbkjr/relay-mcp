import { spawn } from "node:child_process";
import { openaiRefusal, refusalError } from "../core/refusal.js";
import { canonical, inside, type RelayConfig } from "../core/config.js";
import { overlapsPart, relayCodexProtected } from "../core/protected-config.js";
import { executable } from "../core/executables.js";
import readline from "node:readline";
import path from "node:path";
import { activityOf, openAgentLog, usageFrom, watchProcess, type ApprovalAnswer, type ApprovalAsk, type TurnHandle, type TurnResult, type TurnSpec } from "./types.js";
import { drainGroup, isGroupSignalRefusal, killProcs, procStart, sendGroupSignal, stopProcs, type Watch } from "../core/procs.js";
import { clipped } from "../core/shown.js";
import { diagnosticTail } from "../core/redact.js";
import { speedRank, type Speed } from "../targets/index.js";
import { skipDaybreak } from "./codex-daybreak.js";
import { codexShellPolicyNote } from "./codex-shell-policy.js";
import { codexLoginStored, STORED_LOGIN_REJECTED } from "./codex-pin.js";
import { CodexSubagents } from "./codex-subagents.js";
import type { Stage2Session } from "./codex-env.js";
import { stage2BrokerConfigProblem, type Stage2BrokerConfig } from "./codex-stage2.js";
import { BROKER_SERVER_NAME } from "../confine/broker-names.js";
import { assertOverlayLaunch, markOverlayLaunched } from "../core/restart-overlay.js";
import { canaryProblem, CANARY_SCRIPT, codexRuleFolders, networkRuleFiles, openCanaryTargets, ownPublicAddress, type CodexNetworkMode } from "./codex-network.js";

type Msg = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: { message?: string } };

/** Streaming deltas are not needed; the completed items carry the same text. */
const OPT_OUT = [
  "item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta", "item/commandExecution/outputDelta",
];

/**
 * A command or file change the agent was refused (an approval declined), described in a line, or
 * null. Takes a completed item in either dialect: the app server's (commandExecution, fileChange)
 * or `codex exec`'s (command_execution, file_change). A command that failed inside the sandbox is
 * not a refusal Codex reports as such, and is not counted. Nor is a file change under `codex exec`,
 * which reports a declined change as failed (upstream test file_change_declined_maps_to_failed_status,
 * rust-v0.160.1), the same as one that did not apply: counting failures would report ordinary
 * retried patches as refusals. `codex exec` has no approval requests, so only its sandbox refuses.
 */
export function declinedItem(item: unknown): string | null {
  const i = (item ?? {}) as { type?: unknown; status?: unknown; command?: unknown; changes?: unknown };
  if (i.status !== "declined") return null;
  if (i.type !== "commandExecution" && i.type !== "command_execution" && i.type !== "fileChange" && i.type !== "file_change") return null;
  return activityOf(i.type, i as Record<string, unknown>);
}

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));

/** A path entry of Codex's FileSystemPath (app-server v2) in words, the agent's own text quoted; null for one relay does not know. */
function permissionPlace(p: unknown): string | null {
  // A key relay does not know could narrow or widen what the entry means, so the entry is unread.
  if (!isTable(p)) return null;
  if (p.type === "path" && onlyKeys(p, ["type", "path"]) && typeof p.path === "string") return JSON.stringify(p.path);
  if (p.type === "glob_pattern" && onlyKeys(p, ["type", "pattern"]) && typeof p.pattern === "string") return `files matching ${JSON.stringify(p.pattern)}`;
  if (p.type !== "special" || !onlyKeys(p, ["type", "value"]) || !isTable(p.value)) return null;
  const v = p.value;
  if (v.kind === "project_roots" && onlyKeys(v, ["kind", "subpath"])) {
    return v.subpath == null ? "its workspace roots" : typeof v.subpath === "string" ? `${JSON.stringify(v.subpath)} in each of its workspace roots` : null;
  }
  if (!onlyKeys(v, ["kind"])) return null;
  if (v.kind === "root") return "the whole filesystem";
  if (v.kind === "minimal") return "Codex's minimal system paths";
  if (v.kind === "tmpdir") return "its temporary directory (TMPDIR)";
  if (v.kind === "slash_tmp") return "/tmp";
  return null;
}

/**
 * What a command approval request asks to have added to the agent's sandbox for that one command
 * (its `additionalPermissions`: AdditionalPermissionProfile of Codex 0.164.0's experimental API,
 * which relay turns on), in plain words, or null where it asks for nothing. `complete` is false
 * where relay could not read all of it (a key, shape or kind of path it does not know): `words` is
 * then the request's own JSON, and relay vouches for nothing narrower than full access (commandAsk).
 */
export function addedPermissions(raw: unknown): { words: string; complete: boolean } | null {
  if (raw === undefined || raw === null) return null;
  const places = { write: [] as string[], read: [] as string[], deny: [] as string[] };
  let network = false;
  let complete = isTable(raw) && onlyKeys(raw, ["network", "fileSystem"]);
  if (isTable(raw)) {
    const { network: net, fileSystem: files } = raw;
    if (isTable(net) && onlyKeys(net, ["enabled"]) && [true, false, null, undefined].includes(net.enabled as never)) network = net.enabled === true;
    else if (net != null) complete = false;
    if (isTable(files) && onlyKeys(files, ["read", "write", "entries", "globScanMaxDepth"])) {
      // Codex goes by `entries` where they are given (its TryFrom<AdditionalFileSystemPermissions>);
      // read and write are the legacy spelling of the same, sent beside them where they can say it.
      if (Array.isArray(files.entries)) {
        for (const e of files.entries) {
          const at = isTable(e) && onlyKeys(e, ["path", "access"]) ? permissionPlace(e.path) : null;
          const how = isTable(e) && (e.access === "read" || e.access === "write" || e.access === "deny") ? e.access : null;
          if (at && how) places[how].push(at);
          else complete = false;
        }
      } else if (files.entries != null) complete = false;
      else for (const how of ["write", "read"] as const) {
        const list = files[how];
        if (Array.isArray(list) && list.every((p) => typeof p === "string")) places[how].push(...list.map((p) => JSON.stringify(p)));
        else if (list != null) complete = false;
      }
    } else if (files != null) complete = false;
  }
  if (!complete) {
    // Shown escaped where it is shown (shown.ts), like the rest of the agent's request.
    const json = JSON.stringify(raw) ?? String(raw);
    return { words: json.length > 600 ? `${json.slice(0, 600)}…` : json, complete };
  }
  const words = [
    places.write.length ? `write access to ${places.write.join(", ")}` : "",
    places.read.length ? `read access to ${places.read.join(", ")}` : "",
    network ? "network access" : "",
    places.deny.length ? `no access to ${places.deny.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return words ? { words, complete } : null;
}

/** Native Codex's for_approved_command preserves denied reads, but widens read-only paths to
 * writable. The readable pin store therefore cannot survive a broad outside-sandbox approval.
 * Stage 2 does not use this path: its executor's hard denies survive approvals. */
export function codexRuntimeApprovalProblem(p: Record<string, any>, cfg: RelayConfig): string | null {
  if (p.kind === "writeStdin") return null; // Input to an already authorised terminal adds no authority.
  const added = addedPermissions(p.additionalPermissions);
  if (!added?.complete || p.approvalId != null || p.networkApprovalContext != null ||
      (p.kind != null && p.kind !== "command")) {
    return "native Codex would grant write access across the filesystem without preserving relay's pin-store write protection; relay cannot approve that request. Use a stage-2 turn, whose executor keeps the hard denials, or work within the current sandbox";
  }
  const files = p.additionalPermissions.fileSystem;
  const paths: string[] = [];
  if (files) {
    if (Array.isArray(files.entries)) {
      for (const e of files.entries) {
        if (e.access === "deny") continue;
        if (e.path.type !== "path" || !path.isAbsolute(e.path.path)) return "relay cannot prove that this native Codex permission addition leaves its credential home and pin store protected; only explicit absolute paths may be added";
        paths.push(e.path.path);
      }
    } else {
      for (const at of [...(files.read ?? []), ...(files.write ?? [])]) {
        if (!path.isAbsolute(at)) return "relay cannot prove that this native Codex permission addition leaves its credential home and pin store protected; only explicit absolute paths may be added";
        paths.push(at);
      }
    }
  }
  const protectedPaths = relayCodexProtected(cfg);
  for (const at of paths) {
    const denied = [...protectedPaths.homes, ...protectedPaths.stores].find((d) => overlapsPart(at, d.path));
    if (denied) return `${at} overlaps ${denied.what} (${denied.path}), which no approval may cover`;
  }
  return null;
}

/**
 * The ask for a command approval request (item/commandExecution/requestApproval): the command, and
 * what it asks to have added to its sandbox for it, if anything (addedPermissions). What allowing it
 * does, as Codex 0.164.0 does it:
 * Runtime-root policy declines broad and unknown confined requests before this function is used;
 * their effect descriptions remain here for historical requests and the explicit sandbox waiver.
 *
 * - a request with additionalPermissions comes from a command the agent asked to run inside its
 *   sandbox with that access added ("with_additional_permissions", which needs Codex's
 *   exec_permission_approvals feature, off by default, and the on-request approval policy relay
 *   sets: core tools/handlers/mod.rs normalize_and_validate_additional_permissions). Allowed, it
 *   runs in the turn's sandbox (tools/sandboxing.rs sandbox_override_for_first_attempt: no
 *   override) with exactly that added to relay's profile for this command (sandboxing
 *   policy_transforms.rs effective_permission_profile: entries appended, the network on if asked).
 *   Should the sandbox still refuse it, Codex does not run it again outside the sandbox on that
 *   allow: an exec tool asks nothing more under on-request and the command fails, and a retry for a
 *   blocked host asks again, as a request of its own without additionalPermissions
 *   (tools/orchestrator.rs). The ask's detail says so (adds_to_sandbox), and the request's effect
 *   follows (core/approvals.ts);
 * - a plain request to run the command outside the sandbox, without additions, on a confined turn
 *   (relay 1.0.5): relay's profile denies reads of credential stores, and while it does Codex lets no
 *   command leave the sandbox. Allowed, the command runs sandboxed with write access to the whole
 *   disk, still without those credential stores, and with the turn's own network: not full access,
 *   but writing anywhere in the home directory still acts with the person's authority. The ask's
 *   detail says so (escalates_restricted), and the request's effect follows (core/approvals.ts);
 * - any other request is taken to run the command outside the sandbox with full access: relay keeps
 *   that effect wherever it cannot vouch for a narrower one: additions it cannot read in full, a
 *   request of a kind or shape relay has not checked (one with an approvalId, or a kind other than a
 *   plain command), or a turn without a sandbox (allow_dangerous). A retry for a blocked host
 *   (networkApprovalContext) relay declines itself (autoDenial).
 *
 * A request with additionalPermissions is allowed once only (once_only), never for the rest of the
 * job: Codex offers only accept and cancel for one (protocol approvals.rs default_available_decisions),
 * and Codex 0.163.0, which relay still supports, asks its blocked-host retry under the same approval
 * cache key (tools/orchestrator.rs keeps the action; tools/approvals.rs cache_keys), so an allow held
 * for the session would let that retry run outside the sandbox without asking. 0.164.0 asks the
 * retry as a request of its own.
 *
 * Input for a terminal already running (kind "writeStdin") is left as it was: its
 * additionalPermissions are those the terminal kept from its launch, not something added, and
 * Codex's own reason names them.
 */
export function commandAsk(p: Record<string, any>, permissions: CodexPermissions): ApprovalAsk {
  const command = String(p.command ?? "(command not given)");
  const cwd = typeof p.cwd === "string" ? { cwd: p.cwd } : {};
  const added = p.kind === "writeStdin" ? null : addedPermissions(p.additionalPermissions);
  // A plain request to run the command outside the sandbox, on a confined turn: relay's profile
  // denies reads (codex.ts deniedCredentials), so Codex runs it in a sandbox with write access to
  // the whole disk, the denials kept and the turn's own network (core tools/sandboxing.rs
  // sandbox_override_for_first_attempt: EscalatedSandboxWithRestrictions; protocol
  // permissions/target.rs for_approved_command). The ask's detail says so (escalates_restricted).
  const plainKind = (p.kind === undefined || p.kind === null || p.kind === "command") && p.approvalId == null;
  if (!added) {
    const restricted = plainKind && permissions.profile !== null && p.networkApprovalContext == null && p.additionalPermissions == null;
    // escalates_restricted names the network the command keeps (the turn's): none, strict or local.
    return { kind: "command", summary: command, reason: p.reason ?? undefined, detail: { ...cwd, ...(restricted ? { escalates_restricted: permissions.proxy ?? "none" } : {}) } };
  }
  // The plain command request is the only kind whose additions Codex 0.164.0 sends (core
  // tools/approvals.rs request_command_approval: ExecApprovalKind::Command, approval_id None).
  const stays = plainKind && added.complete && permissions.profile !== null && !p.networkApprovalContext;
  return {
    kind: "command",
    summary: `${command} (asks to add for this command${added.complete ? `: ${added.words}` : `, in terms relay cannot read in full: ${added.words}`})`,
    reason: p.reason ?? undefined,
    // The command alone, for what reads the request as one (core/relay-command.ts): the summary is not.
    detail: { ...cwd, command, once_only: true, ...(stays ? { adds_to_sandbox: true } : {}) },
  };
}

/**
 * Whether a command approval request's additionalPermissions ask for the network: a network entry
 * that is anything but off, or additions relay cannot read at all.
 */
export function addsNetwork(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (!isTable(raw)) return true;
  const net = raw.network;
  if (net === undefined || net === null) return false;
  return !(isTable(net) && onlyKeys(net, ["enabled"]) && (net.enabled === false || net.enabled === null || net.enabled === undefined));
}

/**
 * Why relay declines a command approval request itself, before anyone is asked, or null:
 *
 * - network added to one command (additionalPermissions.network) on a confined session whose shell
 *   has no proxy. Codex starts its proxy only for a profile with the network on (core
 *   config/network_config.rs), so the command would get Seatbelt's open network policy: every
 *   outbound connection, all of loopback and Unix sockets anywhere (sandboxing/src/seatbelt.rs
 *   dynamic_network_policy_for_network, its no-proxy branch). On a proxied session the command keeps
 *   the proxy, and the request goes on as before;
 * - a blocked host (networkApprovalContext), on any confined session. On a proxied one, with every
 *   public host allowed, Codex asks only for a host that is not on the allowlist, which relay's leaves
 *   none, and never for loopback or private addresses (network-proxy/src/network_policy.rs
 *   evaluate_host_policy): relay has no case in which to allow one. Without the proxy Codex sends
 *   none (core tools/orchestrator.rs builds the context only with a managed network), and if one came,
 *   allowing it could not give the network: with relay's denied reads (codex.ts deniedCredentials) an
 *   approved retry stays in the sandbox with the turn's own network, which has none.
 */
export function autoDenial(p: Record<string, any>, permissions: CodexPermissions): string | null {
  if (permissions.profile === null) return null;
  if (!permissions.proxy && p.kind !== "writeStdin" && addsNetwork(p.additionalPermissions)) {
    return "it asked to add network access to one command, and this session's shell has no network proxy: Codex would give that command every outbound connection, this Mac's loopback and its Unix sockets";
  }
  if (p.networkApprovalContext != null) {
    return permissions.proxy
      ? "it asked to reach a host Codex's network proxy refused, which relay never allows: the proxy already allows every public host, and refuses only this Mac's own and private addresses"
      : "it asked for network access, and this job has no shell network, which no approval can give it; ask the caller for a network grant";
  }
  return null;
}

/** The name of the permission profile relay defines, for this server only, for every Codex turn it confines (codex.ts codexPermissions). */
export const CODEX_PROFILE = "relay";

/** One filesystem entry of a Codex permission profile: an access, or a table of subpaths and their access. */
export type ProfileEntry = "read" | "write" | "deny" | { [subpath: string]: "read" | "write" };

/** The shell network relay asks for (codex-network.ts): its mode, and for a write turn the directories whose Unix sockets it may use. */
export interface CodexNetwork { mode: CodexNetworkMode; sockets?: string[] }

/**
 * The network table of relay's profile (`[permissions.relay.network]`): off, or on through Codex's
 * network proxy (features.network_proxy), every public host allowed, loopback and private
 * addresses refused unless allow_local_binding, no upstream proxy, and Unix sockets only under
 * the directories named.
 */
export interface CodexProfileNetwork {
  enabled: boolean;
  domains?: Record<string, "allow">;
  allow_local_binding?: boolean;
  allow_upstream_proxy?: boolean;
  unix_sockets?: Record<string, "allow">;
}

/**
 * The permissions a Codex turn runs with (codex.ts codexPermissions), as relay sets them and as
 * Codex must report them back.
 */
export interface CodexPermissions {
  /** The profile Codex must select (default_permissions) and report as active: relay's own, or Codex's built-in one for allow_dangerous. */
  id: string;
  /** Relay's profile as config/read must report it once Codex's unset keys are left out; null for a built-in profile. */
  profile: { workspace_roots?: Record<string, true>; filesystem: Record<string, ProfileEntry>; network: CodexProfileNetwork } | null;
  /** What Codex's legacy description of the thread's sandbox (thread/start's `sandbox`) must say: its kind, and for a confined turn whether it has the network. */
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  network: boolean;
  /** The shell's network goes through Codex's proxy: strict, or local (loopback and the LAN open). Null: no shell network, or no sandbox. */
  proxy: "strict" | "local" | null;
  /** Who confines the turn's commands: Codex's own sandbox (unset or "codex"), or relay's Seatbelt around the executor ("relay", stage 2, codex-stage2.ts). A null profile with "relay" is not full access. */
  enforcement?: "codex" | "relay";
}

/** The effective settings relay requires before it lets a Codex agent run. */
export interface Expected {
  /** The exact authenticated HTTP entry of a stage-2 turn. Contains no credential. */
  broker?: Stage2BrokerConfig;
  /** Person-owned Daybreak decision, pinned on both new and resumed threads. */
  daybreak?: boolean;
  /** The permission profile the turn runs under (codex.ts codexPermissions). */
  permissions: CodexPermissions;
  /** Features relay set, by Codex's key, as experimentalFeature/list must report them where it lists them (network_proxy must be listed). */
  features?: Record<string, boolean>;
  /** Relay's own MCP server as injected for this turn, or null when the turn gets none. */
  relay: { command: string; args: string[]; env: Record<string, string> } | null;
  /** Whether every other MCP server, and plugins, must be off. */
  relayOnly: boolean;
  /** Whether Codex must be signed in with a ChatGPT account, not an API key. */
  accountLogin: boolean;
  /** Relay's Codex home, and how to sign it in once or again (codex-pin.ts codexSignIn), for a refusal to say. */
  signIn?: { home: string; once: string; again: string };
  /** The model relay asked for, when it asked for one: the thread must report that it is using it. */
  model?: string;
  /** Set under codex_endpoint_override "accept": an endpoint Codex's own config sets for OpenAI's provider is not judged. */
  endpointOverride?: boolean;
  /**
   * Every launched turn: relay's package of skills, or null, and exactly the names it may load.
   */
  skills?: { root: string | null; names: string[] };
  /** Set where relay switched Codex's web search off (child_web "ask", a turn given MCP servers): it must be off in effect. */
  webSearch?: "disabled";
  /** The speed relay asked for, and the service tier it set for it (codex.ts codexFlags): the account's catalog must offer it, and the thread report it. */
  speed?: { name: Speed; tier: string };
}

/** Asks the server how it is signed in. Costs no model request. Returns what is wrong, or null. */
async function loginProblem(rpc: { request(method: string, params: unknown): Promise<any> }, expect: Expected): Promise<string | null> {
  if (!expect.accountLogin) return null;
  let type: unknown;
  try {
    type = (await rpc.request("account/read", { refreshToken: false }))?.account?.type;
  } catch (err) {
    return `relay could not find out how Codex is signed in (${(err as Error).message}), and it is set not to run on API keys ("child_auth": "any" skips this check)`;
  }
  if (type === "chatgpt") return null;
  const how = expect.signIn;
  // No account, though relay's Codex home holds a login: one Codex no longer accepts.
  if (!type && how && codexLoginStored(how.home)) return `Codex is not signed in: relay's Codex home ${how.home} holds a login, but ${STORED_LOGIN_REJECTED}. ${how.again}`;
  return `Codex is ${type ? `signed in with ${type === "apiKey" ? "an API key" : String(type)}` : "not signed in"}, not with a ChatGPT account, and relay is set not to run on API keys ("child_auth": "any" allows it)${how ? `. ${how.once}` : ""}`;
}

/** Codex's own default for chatgpt_base_url (codex-rs core config): leaving it so redirects nothing. */
const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/";

/**
 * Compares Codex's effective configuration for the child's directory with what relay set. The
 * app server reports the outcome of every layer (packaged, system, managed, user, project,
 * session flags), so this checks the result rather than guessing at the sources. Returns what is
 * wrong, or null.
 */
export function configProblem(eff: Record<string, any>, expect: Expected): string | null {
  const wrong: string[] = [];
  // A profile named in the config can set the provider and endpoint in place of the top level.
  // Only these keys are read: never auth or anything else a provider entry may carry. (Seen with
  // Codex 0.162.1's config/read: `profile` in config.toml and a [model_providers.openai] table are
  // hard errors there, and profiles.<name>.openai_base_url is ignored. The checks stay, harmless,
  // for other versions.)
  const profileName = typeof eff.profile === "string" ? eff.profile : null;
  const profile = profileName ? (eff.profiles?.[profileName] ?? {}) : {};
  const fromProfile = profile.model_provider != null;
  if (expect.daybreak !== undefined) {
    if (eff.daybreak !== undefined && eff.daybreak !== expect.daybreak) wrong.push(`daybreak is ${JSON.stringify(eff.daybreak)} where relay set ${expect.daybreak}`);
    if (profile.daybreak != null && profile.daybreak !== expect.daybreak) wrong.push(`profiles.${profileName}.daybreak differs from relay's setting`);
  }
  const provider = fromProfile ? profile.model_provider : eff.model_provider;
  // Which family answers: Codex's own provider (OpenAI) only. Unset means that default.
  if (provider != null && provider !== "openai") {
    wrong.push(`model_provider is ${JSON.stringify(provider)}${fromProfile ? ` (profile ${profileName})` : ""}, not OpenAI's, so relay cannot tell which family of model would answer`);
  } else if (!expect.endpointOverride) {
    // OpenAI's provider sent to another endpoint is no longer known to answer with OpenAI's models.
    const redirected = ([
      ["openai_base_url", eff.openai_base_url],
      ...(profileName ? [[`profiles.${profileName}.openai_base_url`, profile.openai_base_url]] : []),
      ["model_providers.openai.base_url", eff.model_providers?.openai?.base_url],
      // Under a ChatGPT login, the ChatGPT backend and the realtime endpoints can be sent elsewhere
      // too; Codex's own default for the backend is no redirect.
      ["chatgpt_base_url", eff.chatgpt_base_url === CHATGPT_BASE_URL ? null : eff.chatgpt_base_url],
      ...Object.keys(eff).filter((k) => /^experimental_realtime_\w*base_url$/.test(k)).sort().map((k) => [k, eff[k]]),
    ] as [string, unknown][]).filter(([, v]) => v != null);
    if (redirected.length) {
      wrong.push(`${redirected.map(([key, v]) => `${key} is set (${JSON.stringify(v)})`).join(", ")}, which sends Codex to another endpoint than OpenAI's, where relay cannot tell which family of model answers ("codex_endpoint_override": "accept" in relay's config launches it anyway)`);
    }
  }
  // The sandbox: relay's permission profile, selected and exactly as relay defined it. Relay's flags
  // (Codex's session flags, precedence 30) outrank the person's own configuration key by key, but
  // a lower layer can still add keys to a table relay sets (a person's own [permissions.relay] could
  // add a writable path), and Codex's legacy managed layers (managed_config.toml and its MDM form,
  // precedences 40 and 50; config/src/config_layer_source.rs) outrank the flags outright. So the
  // effective profile must be exactly relay's, no key added or changed, whichever layer did it. A
  // legacy sandbox_mode elsewhere does not count: selecting a profile in relay's flags makes Codex
  // ignore it (core/src/config/mod.rs resolve_permission_config_syntax).
  const p = expect.permissions;
  if (eff.default_permissions !== p.id) wrong.push(`default_permissions is ${JSON.stringify(eff.default_permissions ?? null)} where relay set ${JSON.stringify(p.id)}`);
  if (p.profile) {
    const got = withoutNulls(eff.permissions?.[CODEX_PROFILE]);
    if (canonicalJson(got) !== canonicalJson(p.profile)) wrong.push(`the permission profile ${JSON.stringify(CODEX_PROFILE)} is ${JSON.stringify(got ?? null)} where relay set ${JSON.stringify(p.profile)}`);
  }
  // The network proxy, as a boolean: a table there ([features.network_proxy] from a layer relay's flag
  // did not replace) carries settings of its own that Codex applies over the profile's.
  if (p.proxy && eff.features?.network_proxy !== true) wrong.push(`features.network_proxy is ${JSON.stringify(eff.features?.network_proxy ?? null)} where relay set true, so the agent's commands would not go through Codex's network proxy as relay set it`);
  for (const name of ["request_permissions_tool", "exec_permission_approvals"]) {
    if (expect.features?.[name] === false && eff.features?.[name] === true) wrong.push(`features.${name} is true where relay set false`);
  }
  // The speed: what a turn costs. A server that does not report the key is judged by its thread's report instead (startCodexAppTurn).
  if (expect.speed) {
    const tier = expect.speed.tier;
    if (eff.service_tier !== undefined && eff.service_tier !== tier) wrong.push(`service_tier is ${JSON.stringify(eff.service_tier)} where relay set ${JSON.stringify(tier)}`);
    if (profile.service_tier != null && profile.service_tier !== tier) wrong.push(`profiles.${profileName}.service_tier is ${JSON.stringify(profile.service_tier)} where relay set ${JSON.stringify(tier)}`);
    // Standard turns fast mode on for the "default" pin to hold (codex.ts codexFlags); a faster speed with it off is refused by fastModeProblem.
    if (expect.speed.name === "standard" && eff.features?.fast_mode === false) wrong.push(`features.fast_mode is false where relay set true, so Codex would drop the "default" service tier relay pins for standard speed`);
  }
  if (eff.approvals_reviewer !== "user") wrong.push(`approvals_reviewer is ${JSON.stringify(eff.approvals_reviewer)} where relay set "user"`);
  // A search could carry what the agent read (a credential, for a turn given MCP servers) past relay's gate.
  if (expect.webSearch && eff.web_search !== expect.webSearch) wrong.push(`web_search is ${JSON.stringify(eff.web_search ?? null)} where relay set ${JSON.stringify(expect.webSearch)}`);
  const servers = (eff.mcp_servers ?? {}) as Record<string, { enabled?: boolean; command?: string; args?: string[]; env?: Record<string, string> }>;
  const r = servers.relay;
  if (expect.relay) {
    // The server the agent will get must be the one carrying this turn's identity, not some other entry named relay.
    if (!r || r.enabled === false) wrong.push("relay's own MCP server is missing or off where it should be on");
    else {
      if (r.command !== expect.relay.command || JSON.stringify(r.args ?? []) !== JSON.stringify(expect.relay.args)) wrong.push("relay's MCP server entry is not the command relay injected");
      const envOff = Object.entries(expect.relay.env).filter(([k, v]) => r.env?.[k] !== v).map(([k]) => k);
      if (envOff.length) wrong.push(`relay's MCP server entry does not carry the identity relay injected (${envOff.join(", ")})`);
    }
  } else if (r && r.enabled !== false) {
    wrong.push("a relay MCP server is on where this turn should have none");
  }
  if (expect.broker) {
    const problem = stage2BrokerConfigProblem(servers[BROKER_SERVER_NAME], expect.broker);
    if (problem) wrong.push(problem);
  }
  if (expect.relayOnly) {
    const on = Object.entries(servers).filter(([name, s]) => name !== "relay" && !(expect.broker && name === BROKER_SERVER_NAME) && s?.enabled !== false).map(([name]) => name);
    if (on.length) wrong.push(`other MCP servers are still enabled (${on.join(", ")})`);
    if (eff.features?.plugins !== false) wrong.push("plugins are still enabled");
  }
  if (expect.skills && eff.features?.skill_mcp_dependency_install !== false) wrong.push("skills could still install MCP servers they depend on (skill_mcp_dependency_install)");
  return wrong.length ? `relay will not start a Codex agent, because Codex's effective configuration is not what relay set: ${wrong.join("; ")}.` : null;
}

/** A value with every null and undefined left out, at any depth: how Codex reports a key nothing set (config/read). */
function withoutNulls(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return v.map(withoutNulls);
  if (typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const kept = withoutNulls(x);
    if (kept !== undefined) out[k] = kept;
  }
  return out;
}

/** JSON with every object's keys sorted, for comparing two values whatever their key order. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/**
 * Whether an administrator's requirements (requirements.toml, managed preferences) let Codex use
 * relay's profile, or null. Where they list the profiles allowed and relay's is not one, Codex
 * falls back to the one they require and only warns (core/src/config/mod.rs
 * resolve_default_permissions); where they list the sandbox modes allowed, a profile whose mode is
 * not one is not used either. Relay refuses the turn rather than run it in a sandbox it did not
 * set. Asked of the server (configRequirements/read): the `codex exec` fallback has no thread to
 * read the active profile from.
 */
export async function requirementsProblem(rpc: Pick<Rpc, "request">, p: CodexPermissions): Promise<string | null> {
  const refuse = (why: string) => `relay will not start a Codex agent, because ${why}.`;
  let req: { allowedPermissionProfiles?: Record<string, boolean> | null; allowedSandboxModes?: string[] | null } | null | undefined;
  try {
    req = (await rpc.request("configRequirements/read", {}))?.requirements;
  } catch (err) {
    return refuse(`relay could not read the requirements an administrator may have set for Codex (${(err as Error).message}), which decide whether Codex uses relay's sandbox`);
  }
  const allowed = req?.allowedPermissionProfiles;
  if (allowed && allowed[p.id] !== true) return refuse(`an administrator's requirements for Codex allow only the permission profiles ${Object.keys(allowed).filter((k) => allowed[k] === true).map((k) => JSON.stringify(k)).join(", ") || "(none)"}, not relay's ${JSON.stringify(p.id)}, so Codex would run the agent in another sandbox than relay's`);
  const modes = req?.allowedSandboxModes;
  if (Array.isArray(modes) && !modes.includes(p.sandbox)) return refuse(`an administrator's requirements for Codex allow only the sandbox modes ${modes.map((m) => JSON.stringify(m)).join(", ")}, not the ${JSON.stringify(p.sandbox)} of relay's sandbox`);
  return null;
}

/**
 * What is wrong with the features Codex reports it runs with (experimentalFeature/list, every page),
 * against those relay set (Expected.features), or null. The feature list is the server's own: a key
 * Codex does not know is absent from it, where config/read would echo any key it was given. So the
 * network proxy must be listed and on; any other feature relay set must, where it is listed, be as
 * relay set it (a Codex that does not list it does not have it).
 */
export async function featuresProblem(rpc: Pick<Rpc, "request">, expect: Pick<Expected, "features">): Promise<string | null> {
  const want = expect.features;
  if (!want || !Object.keys(want).length) return null;
  const listed = new Map<string, unknown>();
  try {
    let cursor: string | null | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await rpc.request("experimentalFeature/list", { limit: 500, ...(cursor ? { cursor } : {}) });
      for (const f of (r?.data ?? []) as { name?: unknown; enabled?: unknown }[]) if (typeof f?.name === "string") listed.set(f.name, f.enabled);
      cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : null;
      if (!cursor) break;
    }
  } catch (err) {
    return `relay could not read the features Codex runs with (experimentalFeature/list: ${(err as Error).message})`;
  }
  const wrong: string[] = [];
  for (const [name, on] of Object.entries(want)) {
    if (!listed.has(name)) {
      if (name === "network_proxy") wrong.push("Codex does not list its network_proxy feature, so this Codex has no network proxy relay can rely on");
    } else if (listed.get(name) !== on) wrong.push(`Codex reports its ${name} feature ${listed.get(name) === true ? "on" : "off"} where relay set it ${on ? "on" : "off"}`);
  }
  return wrong.length ? wrong.join("; ") : null;
}

/**
 * Whether an administrator's requirements decide Codex's network instead of relay's profile, or
 * null: managed network settings (requirements.toml [experimental_network], reported as
 * requirements.network) can enable the proxy with their own allowlist and allow_local_binding, and a
 * feature requirement can hold the proxy off.
 */
async function networkRequirementsProblem(rpc: Pick<Rpc, "request">): Promise<string | null> {
  let req: { network?: unknown; featureRequirements?: Record<string, unknown> | null } | null | undefined;
  try {
    req = (await rpc.request("configRequirements/read", {}))?.requirements;
  } catch (err) {
    return `relay could not read the requirements an administrator may have set for Codex (${(err as Error).message})`;
  }
  if (req?.network != null) return "an administrator's requirements for Codex set its network policy (requirements.network), which relay's profile does not decide";
  if (req?.featureRequirements?.network_proxy === false) return "an administrator's requirements for Codex hold its network proxy off";
  return null;
}

/**
 * Has Codex itself run a short check in the turn's sandbox, before any agent runs: a command started
 * with relay's profile (command/exec), whose network Codex sets up as it would for the agent's
 * commands, tries a loopback port and a Unix socket of relay's own, and loopback through the proxy
 * (CANARY_SCRIPT). Returns what is wrong for `mode`, or null.
 */
async function networkCanary(rpc: Pick<Rpc, "request">, cwd: string, mode: "strict" | "local"): Promise<string | null> {
  let targets;
  try {
    targets = await openCanaryTargets();
  } catch (err) {
    return `relay could not open its own test listener (${(err as Error).message})`;
  }
  try {
    const r = await rpc.request("command/exec", { command: [process.execPath, "-e", CANARY_SCRIPT, String(targets.port), targets.sock], cwd, permissionProfile: CODEX_PROFILE, timeoutMs: 20_000 });
    // Connections that reached relay's listeners are counted as the event loop takes them.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (r?.exitCode !== 0) return `its sandbox check exited with ${JSON.stringify(r?.exitCode ?? null)} (${String(r?.stderr ?? "").trim().split("\n").pop() ?? ""})`;
    return canaryProblem(String(r?.stdout ?? ""), mode, targets.hits());
  } catch (err) {
    return `Codex could not run relay's sandbox check (command/exec: ${(err as Error).message})`;
  } finally {
    targets.close();
  }
}

/**
 * The checks of a turn's features and, where its shell network goes through Codex's proxy, of that
 * network, on a given server: the preflight's (codexNetworkPreflight) and again the one that will
 * run the turn (startCodexAppTurn; codexPreflight for the exec fallback, whose turn has no server to
 * ask). The features (featuresProblem); for a proxied turn no administrator's network requirements
 * (networkRequirementsProblem); for a strict one no public address of this Mac's own
 * (ownPublicAddress) and no network_rule in the rules files Codex loads (networkRuleFiles, from
 * the layers config/read reported); then Codex's own run of the sandbox check (networkCanary).
 * Returns what is wrong, or null.
 */
async function proxiedProblem(rpc: Pick<Rpc, "request">, o: { cwd: string; expect: Expected; env: NodeJS.ProcessEnv; layers?: unknown; interfaces?: Parameters<typeof ownPublicAddress>[0] }): Promise<string | null> {
  const features = await featuresProblem(rpc, o.expect);
  if (features) return features;
  const mode = o.expect.permissions.proxy;
  if (!mode) return null;
  const required = await networkRequirementsProblem(rpc);
  if (required) return required;
  if (mode === "strict") {
    const own = ownPublicAddress(o.interfaces);
    if (own) return own.why;
    const rules = networkRuleFiles(codexRuleFolders({ layers: o.layers, env: o.env, cwd: o.cwd }));
    if ("error" in rules) return rules.error;
    if (rules.files.length) return `Codex's exec-policy rules hold network_rule (${rules.files.join(", ")}), which can open a host of this Mac's own to the proxy`;
  }
  return networkCanary(rpc, o.cwd, mode);
}

/**
 * Before a turn whose shell network would go through Codex's proxy: a short-lived app server,
 * started with exactly the turn's settings and the agent's environment, asked whether that is what
 * Codex will do (codex.ts chooseNetwork). Returns why relay cannot verify it, or null. Where it
 * cannot, the turn gets Codex's hosted web search and no shell network.
 *
 * - strict mode only: no address of this Mac's own that the proxy would treat as public
 *   (ownPublicAddress), and no `network_rule` in any rules file Codex would load (networkRuleFiles);
 * - the effective configuration exactly as relay set it (configProblem) and the profile Codex
 *   uses (requirementsProblem), no administrator's network requirements;
 * - the features (featuresProblem) and Codex's own run of relay's sandbox check (networkCanary).
 */
export async function codexNetworkPreflight(o: {
  bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; expect: Expected; mode: "strict" | "local"; signal?: AbortSignal;
  interfaces?: Parameters<typeof ownPublicAddress>[0];
}): Promise<string | null> {
  if (o.mode === "strict") {
    const own = ownPublicAddress(o.interfaces);
    if (own) return own.why;
  }
  if (o.signal?.aborted) return "the turn was stopped";
  const rpc = connect(o.bin, o.args, o.cwd, o.env, () => {});
  const stderrTail = diagnosticTail(600);
  rpc.child.stderr!.on("data", (d: Buffer) => stderrTail.write(d.toString()));
  const unprefixed = (problem: string) => problem.replace(/^relay will not start a Codex agent, because /, "").replace(/\.$/, "");
  const check = async (): Promise<string | null> => {
    try {
      await rpc.request("initialize", HELLO);
      rpc.send({ method: "initialized" });
      const read = await rpc.request("config/read", { cwd: o.cwd, includeLayers: true });
      const problem = configProblem(read?.config ?? {}, o.expect) ?? (await requirementsProblem(rpc, o.expect.permissions));
      if (problem) return unprefixed(problem);
      return await proxiedProblem(rpc, { cwd: o.cwd, expect: o.expect, env: o.env, layers: read?.layers, interfaces: o.interfaces });
    } catch (err) {
      const stderr = stderrTail.text().trim();
      return `relay could not ask Codex (${(err as Error).message}${stderr ? `: ${stderr.split("\n").pop()}` : ""})`;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const cut = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("Codex did not answer in time"), PREFLIGHT_MS);
    onAbort = () => resolve("the turn was stopped");
    o.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([check(), cut]);
  } finally {
    clearTimeout(timer);
    if (onAbort) o.signal?.removeEventListener("abort", onAbort);
    rpc.child.stdin!.end();
    if (!await drainGroup(rpc.pid)) process.stderr.write(`relay could not clean up Codex network preflight: cleanup refused for process group ${rpc.pid}\n`);
  }
}

/** The kind of sandbox Codex reports for a thread (its legacy SandboxPolicy, thread/start `sandbox`), for each kind relay asks for. */
const SANDBOX_TYPE = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" } as const;

/**
 * What is wrong with the permissions a started or resumed thread reports it runs with, or null:
 * the active profile must be relay's (an administrator's requirements can make Codex fall back to
 * another, with only a warning), and Codex's description of the sandbox must be of the kind relay
 * set, with the network as relay set it and only the turn's TMPDIR of the temporary directories.
 * That description cannot show relay's read-only names; config/read has checked the profile that
 * holds them.
 *
 * Its workspace roots must be the turn's directory alone, and the directories it may write only
 * that and the profile's own roots: relay's profile makes every workspace root writable
 * (`:workspace_roots`), and a resumed thread restores the roots it stored unless the thread is told
 * others (app-server thread_processor.rs, thread/resume). One started under relay's earlier
 * settings stored its grants among them, so without this a grant taken away on resume would stay
 * writable. Relay names the roots on every start and resume (runtimeWorkspaceRoots), and checks
 * here that Codex took them.
 */
export function threadPermissionsProblem(t: { activePermissionProfile?: { id?: unknown } | null; sandbox?: Record<string, unknown> | null; runtimeWorkspaceRoots?: unknown } | null | undefined, p: CodexPermissions, cwd: string): string | null {
  const refuse = (why: string) => `relay will not start a Codex agent, because its thread ${why}.`;
  const active = t?.activePermissionProfile?.id;
  if (active !== p.id) return refuse(active === undefined || active === null ? `does not report which permission profile it runs with, so relay cannot tell that it is relay's ${JSON.stringify(p.id)}` : `runs with the permission profile ${JSON.stringify(active)}, not relay's ${JSON.stringify(p.id)} (an administrator's requirements can make Codex replace it)`);
  const s = t?.sandbox ?? {};
  if (s.type !== SANDBOX_TYPE[p.sandbox]) return refuse(`reports a ${JSON.stringify(s.type ?? null)} sandbox where relay set ${JSON.stringify(SANDBOX_TYPE[p.sandbox])}`);
  // Stage 2 (enforcement "relay", codex-stage2.ts): Codex's sandbox is off because relay's Seatbelt
  // around the executor confines. The thread's roots and environments are checked by
  // stage2ThreadProblem, which knows a resumed thread: on an app server without Codex's `local`
  // environment it reports no environment and so no roots until relay's turn binds it. Allow_dangerous
  // is not confined, and nothing more is read.
  if (p.sandbox === "danger-full-access") return null;
  if (s.networkAccess !== p.network) return refuse(`reports network access ${JSON.stringify(s.networkAccess ?? null)} where relay set ${p.network}`);
  if (p.sandbox === "workspace-write" && (s.excludeSlashTmp !== true || s.excludeTmpdirEnvVar !== false)) return refuse(`reports temporary directories other than the turn's own as writable (excludeSlashTmp ${JSON.stringify(s.excludeSlashTmp ?? null)}, excludeTmpdirEnvVar ${JSON.stringify(s.excludeTmpdirEnvVar ?? null)})`);
  const here = canonical(cwd);
  const roots = t?.runtimeWorkspaceRoots;
  if (!Array.isArray(roots) || roots.length !== 1 || typeof roots[0] !== "string" || canonical(roots[0]) !== here) {
    return refuse(`reports the workspace roots ${JSON.stringify(roots ?? null)} where relay set only the turn's directory ${JSON.stringify(cwd)}, and every workspace root is writable under relay's profile`);
  }
  const allowed = new Set([here, ...Object.keys(p.profile?.workspace_roots ?? {}).map((r) => canonical(r))]);
  const writable = Array.isArray(s.writableRoots) ? s.writableRoots : [];
  const extra = writable.filter((r) => typeof r !== "string" || !allowed.has(canonical(r)));
  if (extra.length) return refuse(`reports ${JSON.stringify(extra)} as writable, which relay did not grant this turn`);
  return null;
}

/**
 * What is wrong with the model a started or resumed thread reports, or null. A provider other than
 * OpenAI's is refused whenever it is reported. When relay asked for a model, the thread's identity
 * is what proves that model answers, so both fields must be reported and match: a server that
 * leaves either out is refused, not trusted. When no model was asked for, config/read has checked
 * the provider and any model the thread names is accepted.
 */
function threadProblem(t: { model?: unknown; modelProvider?: unknown } | null | undefined, expect: Expected): string | null {
  const refuse = (why: string) => `relay will not start a Codex agent, because its thread ${why}.`;
  if (typeof t?.modelProvider === "string" && t.modelProvider !== "openai") {
    return refuse(`reports the model provider ${JSON.stringify(t.modelProvider)}, not OpenAI's, so relay cannot tell which family of model would answer`);
  }
  if (!expect.model) return null;
  if (typeof t?.modelProvider !== "string") return refuse(`does not report its model provider, so relay cannot tell that OpenAI's ${JSON.stringify(expect.model)} answers`);
  if (typeof t?.model !== "string") return refuse(`does not report its model, so relay cannot tell that the ${JSON.stringify(expect.model)} it asked for answers`);
  if (t.model !== expect.model) return refuse(`reports the model ${JSON.stringify(t.model)}, not the ${JSON.stringify(expect.model)} relay asked for`);
  return null;
}

/** A model as the account's catalog lists it (model/list; ModelListResponse in Codex 0.163.0), with only what relay reads. */
export interface CatalogModel { id?: string; model?: string; isDefault?: boolean; serviceTiers?: { id?: string; name?: string }[]; availableAccessPrograms?: { cyber?: string[] } | null }

/** The account's model catalog, every page, hidden models included (one a person configured may be hidden). Costs no model request. */
async function readCatalog(rpc: Pick<Rpc, "request">): Promise<CatalogModel[]> {
  const out: CatalogModel[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const r = (await rpc.request("model/list", { includeHidden: true, ...(cursor ? { cursor } : {}) })) as { data?: CatalogModel[]; nextCursor?: string | null } | null;
    out.push(...(Array.isArray(r?.data) ? r.data : []));
    cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : null;
    if (!cursor) break;
  }
  return out;
}

/** Recheck the cached opt-in against this server's current catalog before submitting a turn.
 * A stale cache, revoked access or unavailable discovery downgrades to standard, never a model
 * eligibility rejection from Codex. The catalog cannot enable what the person did not enable.
 */
async function daybreakSkip(rpc: Pick<Rpc, "request">, model: string | undefined): Promise<string | null> {
  try {
    const matches = (await readCatalog(rpc)).filter((m) => (m.model ?? m.id) === model);
    if (model && matches.length === 1 && matches[0].availableAccessPrograms?.cyber?.includes("daybreakBlue")) return null;
  } catch { /* An unavailable catalog also runs standard. */ }
  return `Daybreak was requested, but Codex's current catalog does not confirm daybreak_blue for ${JSON.stringify(model ?? "unknown model")}; this turn runs without Daybreak.`;
}

/**
 * For a faster speed on a turn that carries on a thread and names no model: the thread's own model
 * (thread/read, metadata only: it runs nothing and costs no model request), which Codex resumes it
 * on (rather than whatever its default is now). Undefined otherwise, or when it cannot be read,
 * and then the configured or catalog default is checked; on the app server the thread's reported
 * model is checked again after it resumes.
 */
async function continuedModel(rpc: Pick<Rpc, "request">, expect: Expected, sessionId: string | undefined): Promise<string | undefined> {
  if (!sessionId || !expect.speed || expect.speed.name === "standard") return undefined;
  try {
    const model = (await rpc.request("thread/read", { threadId: sessionId, includeTurns: false }))?.thread?.model;
    return typeof model === "string" && model ? model : undefined;
  } catch {
    return undefined;
  }
}

/** Relay's name for each of Codex's service tiers that relay asks for (targets/codex.ts), for messages. */
const SPEED_OF_TIER: Record<string, string> = { priority: "fast", ultrafast: "ultrafast" };

/** Codex plan types (account/read planType) as OpenAI names the plans, where the research of 2026-10-16 named them; for messages only, never to decide. */
const PLAN_NAMES: Record<string, string> = { prolite: "Pro $100", promax: "Pro $500" };

/**
 * Why the account's catalog does not offer the speed relay asked for, with the model the thread
 * would run, or null. Decided from the catalog alone (model/list serviceTiers), never from the
 * plan (decided 2026-10-16): the plan is named only to explain a refusal. Standard needs no catalog.
 * `model`: the one relay asked for, or Codex's configured one; else the catalog's default. The
 * remedy names a speed to pass, never leaving speed out: the speed may not be the call's own (a
 * session's, a launched agent's inherited one, targets.<id>.speed), and then leaving it out gets it
 * again. `continues`: the turn carries on a session, whose model a call cannot change.
 */
export function tierProblem(catalog: CatalogModel[], model: string | null | undefined, speed: { name: Speed; tier: string }, o: { plan?: string | null; continues?: boolean } = {}): string | null {
  if (speed.name === "standard") return null;
  const refuse = (why: string) => `relay will not start a Codex agent at ${speed.name} speed, because ${why}`;
  const named = (m: CatalogModel) => m.model ?? m.id;
  const entry = model ? catalog.find((m) => named(m) === model || m.id === model) : catalog.find((m) => m.isDefault);
  if (!entry) {
    const remedy = (naming: string) => (o.continues ? 'Pass speed: "standard".' : `${naming}, or pass speed: "standard".`);
    return refuse(model
      ? `${JSON.stringify(model)} is not in this account's Codex catalog (model/list), so relay cannot tell whether it is offered ${speed.name} there. ${remedy("Name a model the catalog lists")}`
      : `this account's Codex catalog (model/list) names no default model, so relay cannot tell which model would run or whether it is offered that speed. ${remedy("Name the model")}`);
  }
  const tiers = (entry.serviceTiers ?? []).map((t) => t?.id).filter((t): t is string => typeof t === "string");
  if (tiers.includes(speed.tier)) return null;
  const offers = tiers.map((t) => SPEED_OF_TIER[t] ?? t);
  const elsewhere = catalog.filter((m) => m !== entry && (m.serviceTiers ?? []).some((t) => t?.id === speed.tier)).map(named).filter(Boolean);
  const planText = o.plan ? `Codex plan: ${PLAN_NAMES[o.plan] ? `${PLAN_NAMES[o.plan]} (${o.plan})` : o.plan}` : "";
  const where = speed.name === "ultrafast" ? "OpenAI offers ultrafast on Pro $500 and eligible Enterprise and Edu plans, for GPT-6 Astra and GPT-6.1 Sol" : "";
  // The slower speeds relay can ask for that the catalog offers for this model, fastest first, and
  // standard: a refusal never points at a speed that costs more than the one refused.
  const passable = [...(["ultrafast", "fast"] as const).filter((s) => offers.includes(s) && speedRank(s) < speedRank(speed.name)), "standard"];
  return refuse(
    `${speed.name} isn't offered to this account for ${named(entry)}${planText || where ? ` (${[planText, where].filter(Boolean).join("; ")})` : ""}: ` +
    `the account's catalog offers ${offers.length ? `${offers.join(" and ")} for it` : "no faster speed for it"}${elsewhere.length ? `, and ${speed.name} for ${elsewhere.join(", ")}` : ""}. ` +
    `Pass speed: ${passable.map((s) => JSON.stringify(s)).join(" or ")}${elsewhere.length && !o.continues ? ", or name one of those models" : ""}.`,
  );
}

/**
 * Why a faster speed cannot be served while fast mode is turned off in Codex's own configuration
 * (features.fast_mode = false: Codex 0.163.0 then drops every service tier), or null. Relay leaves
 * that switch as the person set it for a faster turn, so the turn is refused, before any thread
 * exists, rather than run at standard while billed as asked for fast.
 */
export function fastModeProblem(eff: Record<string, any> | null | undefined, expect: Expected): string | null {
  if (!expect.speed || expect.speed.name === "standard" || eff?.features?.fast_mode !== false) return null;
  return `relay will not start a Codex agent at ${expect.speed.name} speed, because fast mode is turned off in Codex's own configuration (features.fast_mode = false), and Codex then drops every service tier, the ${JSON.stringify(expect.speed.tier)} relay would ask for included. Relay's own Codex home does not set it, so a configuration layer relay does not write does (an administrator's /etc/codex or managed configuration, say): turn it back on there, or pass speed: "standard".`;
}

/** The account's plan type (account/read), for a refusal's message; null when it cannot be read. */
async function planOf(rpc: Pick<Rpc, "request">): Promise<string | null> {
  try {
    const plan = (await rpc.request("account/read", { refreshToken: false }))?.account?.planType;
    return typeof plan === "string" ? plan : null;
  } catch {
    return null;
  }
}

/** tierProblem against the account's catalog, read from the server, with the plan named in a refusal. Null without reading anything for standard. */
async function catalogProblem(rpc: Pick<Rpc, "request">, expect: Expected, model: string | null | undefined, o: { catalog?: CatalogModel[]; continues: boolean }): Promise<string | null> {
  if (!expect.speed || expect.speed.name === "standard") return null;
  const listed = o.catalog ?? (await readCatalog(rpc));
  if (!tierProblem(listed, model, expect.speed)) return null;
  return tierProblem(listed, model, expect.speed, { plan: await planOf(rpc), continues: o.continues });
}

/**
 * What is wrong with the service tier a started or resumed thread reports (ThreadStartResponse
 * serviceTier), or null. It must be the tier relay asked for, standard's "default" included: Codex
 * 0.163.0 reports null both for a tier it dropped (one the account does not have) and for none, and
 * with none a model's catalog default applies (priority, for some). A server that leaves the key
 * out is judged by its effective configuration alone (configProblem).
 */
function threadTierProblem(t: { serviceTier?: unknown } | null | undefined, expect: Expected): string | null {
  if (!expect.speed || !t || !("serviceTier" in t)) return null;
  const { tier, name } = expect.speed;
  return t.serviceTier === tier ? null : `relay will not start a Codex agent, because its thread reports the service tier ${JSON.stringify(t.serviceTier)}, not the ${JSON.stringify(tier)} (${name} speed) relay asked for.`;
}

interface Rpc {
  child: ReturnType<typeof spawn>;
  pid: number;
  send: (m: Msg) => void;
  request: (method: string, params: Record<string, unknown>) => Promise<any>;
  nextId: () => number;
  disconnect(): void;
}

/** Starts `codex app-server` and speaks its JSON-RPC over stdio. onMessage sees everything that is not a reply. */
export function connect(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onMessage: (m: Msg, line: string) => void): Rpc {
  const child = spawn(executable(bin, env.PATH), args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.on("error", () => {});
  let id = 1;
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const send = (m: Msg) => void child.stdin!.write(JSON.stringify(m) + "\n");
  readline.createInterface({ input: child.stdout! }).on("line", (line) => {
    let m: Msg;
    try {
      m = JSON.parse(line) as Msg;
    } catch {
      return;
    }
    if (m.id !== undefined && m.method === undefined) {
      const w = waiting.get(m.id as number);
      waiting.delete(m.id as number);
      if (m.error) w?.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
      else w?.resolve(m.result);
      return;
    }
    onMessage(m, line);
  });
  // Once the server is gone, a request can never be answered: it is refused at once rather than
  // left waiting (a preflight that went on after its server exited would never settle, nor release
  // what it held, the canary's listeners among them).
  let closed: Error | null = null;
  const rejectPending = (err: Error) => {
    closed ??= err;
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  child.on("error", rejectPending);
  child.on("close", () => rejectPending(new Error("codex app-server exited")));
  return {
    child, pid: child.pid ?? -1, send, nextId: () => id++,
    disconnect: () => rejectPending(new Error("relay disconnected the Codex app server after cleanup was refused")),
    request: (method, params) => new Promise((resolve, reject) => {
      if (closed) return reject(closed);
      const n = id++;
      waiting.set(n, { resolve, reject });
      send({ id: n, method, params });
    }),
  };
}

/**
 * Codex's experimental API is on for every server relay starts: a thread is told to use relay's
 * permission profile (thread/start and thread/resume `permissions`), Daybreak is pinned per turn,
 * and the thread reports its active profile, all of which 0.163.0 gates behind it.
 *
 * Do not advertise `requiredHumanApproval` here until relay enforces person-only, one-time
 * decisions for such requests. From 0.167.0 a managed `prompt_user` exec-policy rule asks for a
 * human-only approval (ExecApprovalKind::HumanCommand, core/src/exec_policy.rs
 * NeedsHumanApproval), which Codex sends only to a client that advertises that capability;
 * without it Codex turns the request into a denial. Relay's approval paths let the root agent,
 * a standing grant or a session-wide answer decide, so advertising it would let something other
 * than a fresh human decision answer a request Codex reserves for one
 * (test/codex-network.test.ts; docs/qualification/codex-0.167.0-hand-checks.md).
 */
const HELLO ={ clientInfo: { name: "relay", title: "relay", version: "0.1.0" }, capabilities: { experimentalApi: true, optOutNotificationMethods: OPT_OUT } };

/**
 * For every launched turn: adds relay's package of
 * skills, if the turn has one, as an extra skill root of this server only, then asks the server,
 * re-scanning, which skills it will load in the turn's directory. Every enabled skill must be
 * one of relay's copies, by exactly the name relay gave it at
 * <root>/<name>/SKILL.md (a skill elsewhere under the root, or under another name there, was not
 * what the person consented to), and every copy must be there and enabled. A turn given
 * no skills has no copies: none may be enabled. Returns what is wrong, or null.
 */
export async function skillsProblem(rpc: Pick<Rpc, "request">, cwd: string, skills: NonNullable<Expected["skills"]>): Promise<string | null> {
  const refuse = (why: string) => `relay will not start a Codex agent, because ${why}.`;
  let listed: { data?: { cwd?: string; skills?: { name?: unknown; path?: unknown; scope?: unknown; enabled?: unknown }[]; errors?: { path?: unknown; message?: unknown }[] }[] };
  try {
    if (skills.root) await rpc.request("skills/extraRoots/set", { extraRoots: [skills.root] });
    listed = await rpc.request("skills/list", { cwds: [cwd], forceReload: true });
  } catch (err) {
    return refuse(`relay could not give it its skills or read which skills it would load (${(err as Error).message})`);
  }
  const entry = listed?.data?.[0];
  if (listed?.data?.length !== 1 || !entry || typeof entry.cwd !== "string" || canonical(entry.cwd) !== canonical(cwd) || !Array.isArray(entry.skills)) return refuse("it did not say which skills it would load in the turn's directory");
  if (!Array.isArray(entry.errors) || entry.errors.length) return refuse("it reported errors reading its skills, so relay cannot establish exactly what it would load");
  const mine = skills.root ? canonical(skills.root) : null;
  const at = new Map(mine ? skills.names.map((n) => [n, path.join(mine, n, "SKILL.md")]) : []);
  const given = new Set<string>();
  const stray: string[] = [];
  const unnamed: string[] = [];
  for (const s of entry.skills) {
    if (typeof s?.enabled !== "boolean" || typeof s?.name !== "string" || typeof s?.path !== "string") return refuse("it reported a skill without its name, path or enabled state");
    const file = typeof s?.path === "string" ? s.path : "";
    const ours = mine !== null && file !== "" && inside(file, mine);
    if (s?.enabled === false) continue;
    const name = String(s?.name);
    if (!ours) stray.push(`${name} (${file || "no path given"})`);
    else if (at.get(name) === canonical(file) && !given.has(name)) given.add(name);
    else unnamed.push(`${name} (${file})`);
  }
  if (stray.length) return refuse(`it would also load skills relay did not give it and could not switch off: ${stray.join(", ")}. Check Codex's skill configuration and version`);
  if (unnamed.length) return refuse(`it would load skills from relay's package other than the ones relay gave it, each by its own name at <package>/<name>/SKILL.md: ${unnamed.join(", ")}`);
  const missing = skills.names.filter((n) => !given.has(n));
  if (missing.length) {
    const errors = (entry.errors ?? []).filter((e) => mine !== null && typeof e?.path === "string" && inside(e.path, mine)).map((e) => String(e.message));
    return refuse(`it did not load the skills relay gave it (${missing.join(", ")})${errors.length ? `: ${errors.join("; ")}` : ""}`);
  }
  return null;
}

/** Older relay sessions may still be active. Codex's unarchive call is not idempotent. */
async function unarchiveThread(rpc: Pick<Rpc, "request">, threadId: string): Promise<void> {
  try {
    await rpc.request("thread/unarchive", { threadId });
  } catch (err) {
    if (!(err as Error).message.includes(`no archived rollout found for thread id ${threadId}`)) throw err;
  }
}

/** Token-free cleanup, also used after exec or a crashed server. No login material is read by relay. */
export async function archiveCodexThread(o: { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; threadId: string }): Promise<string | null> {
  const rpc = connect(o.bin, o.args, o.cwd, o.env, () => {});
  rpc.child.stderr!.resume();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        await rpc.request("initialize", HELLO);
        rpc.send({ method: "initialized" });
        await rpc.request("thread/archive", { threadId: o.threadId });
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("archive timed out")), 10000); }),
    ]);
    return null;
  } catch (err) {
    return `Could not archive Codex thread ${o.threadId}; it may remain in your Codex history: ${(err as Error).message}`;
  } finally {
    clearTimeout(timer);
    rpc.child.stdin!.end();
    if (!await drainGroup(rpc.pid)) process.stderr.write(`relay could not clean up Codex thread archive: cleanup refused for process group ${rpc.pid}\n`);
  }
}

/** How long the `codex exec` fallback's configuration check may take, as when it ran as a subprocess. */
const PREFLIGHT_MS = 30_000;

/**
 * Used by the `codex exec` fallback: asks a short-lived app server, started with the agent's own
 * environment, for the effective configuration and checks it. Returns the problem, or null. At its
 * deadline (PREFLIGHT_MS) it gives up with what the turn has always said then, and an aborted
 * `signal` (the worker is stopping) ends it at once. Either way its app server is stopped before
 * it returns.
 */
export async function codexPreflight(o: {
  bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; expect: Expected; sessionId?: string; model?: string; signal?: AbortSignal;
  onWaived?: TurnSpec["onWaived"];
  /** Given the thread's own model when relay checked a faster speed against it (continuedModel), for the turn to name. */
  onModel?: (model: string) => void;
  onDaybreakSkipped?: (note: string) => void;
  /** The names relay released that the agent's environment carries, judged against Codex's shell_environment_policy. */
  released?: readonly string[];
  /** Given a note naming released names Codex keeps from its commands, or that relay cannot tell (codex-shell-policy.ts). */
  onShellPolicyNote?: (note: string) => void;
  /** Doctor: given how Codex reports it is signed in (account/read's account type, null for none), read first, before any check can refuse. */
  onAccount?: (type: string | null) => void;
}): Promise<string | null> {
  if (o.signal?.aborted) return "the turn was stopped before relay checked Codex's effective configuration";
  const rpc = connect(o.bin, o.args, o.cwd, o.env, () => {});
  // Cut of secrets a line at a time before it is clipped (diagnosticTail): what it says is quoted in a refusal.
  const stderrTail = diagnosticTail(600);
  rpc.child.stderr!.on("data", (d: Buffer) => stderrTail.write(d.toString()));
  const check = async (): Promise<string | null> => {
    try {
      await rpc.request("initialize", HELLO);
      rpc.send({ method: "initialized" });
      if (o.onAccount) {
        let account: unknown;
        try { account = (await rpc.request("account/read", { refreshToken: false }))?.account; } catch { /* unknown: loginProblem says so, where a turn checks it */ }
        if (account !== undefined) o.onAccount(account && typeof (account as { type?: unknown }).type === "string" ? (account as { type: string }).type : null);
      }
      const read = await rpc.request("config/read", { cwd: o.cwd, includeLayers: true });
      const eff = read.config;
      const problem = configProblem(eff, o.expect) ?? (await requirementsProblem(rpc, o.expect.permissions)) ?? (await loginProblem(rpc, o.expect)) ?? fastModeProblem(eff, o.expect)
        ?? (o.expect.skills ? await skillsProblem(rpc, o.cwd, o.expect.skills) : null);
      if (problem) return problem;
      // The features relay set and, for a proxied turn, Codex's own run of the sandbox check: as
      // codexNetworkPreflight found them, or the configuration changed since, and the turn is refused.
      const unproved = await proxiedProblem(rpc, { cwd: o.cwd, expect: o.expect, env: o.env, layers: read.layers });
      if (unproved) return `relay will not start a Codex agent, because ${unproved}.`;
      if (o.expect.endpointOverride && configProblem(eff, { ...o.expect, endpointOverride: false })) o.onWaived?.("codex_endpoint_override");
      const policyNote = codexShellPolicyNote(eff?.shell_environment_policy, o.released ?? []);
      if (policyNote) o.onShellPolicyNote?.(policyNote);
      if (o.expect.daybreak) {
        const note = await daybreakSkip(rpc, o.model);
        if (note) o.onDaybreakSkipped?.(note);
      }
      if (o.sessionId) await unarchiveThread(rpc, o.sessionId);
      const model = o.model ?? (await continuedModel(rpc, o.expect, o.sessionId));
      const unoffered = await catalogProblem(rpc, o.expect, model ?? eff.model, { continues: Boolean(o.sessionId) });
      if (unoffered) {
        // No turn follows to archive the thread again (codex.ts finish), so it is put back here.
        if (o.sessionId) await rpc.request("thread/archive", { threadId: o.sessionId }).catch(() => {});
        return unoffered;
      }
      // The model checked is the one exec is to run: a thread's own, which relay then names (codex.ts invocation).
      if (!o.model && model) o.onModel?.(model);
      return null;
    } catch (err) {
      const stderr = stderrTail.text().trim();
      return `relay could not read Codex's effective configuration (${(err as Error).message}${stderr ? `: ${stderr.split("\n").pop()}` : ""}), so it will not start a Codex agent.`;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const cut = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("relay could not check Codex's effective configuration"), PREFLIGHT_MS);
    onAbort = () => resolve("the turn was stopped while relay checked Codex's effective configuration");
    o.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([check(), cut]);
  } finally {
    clearTimeout(timer);
    if (onAbort) o.signal?.removeEventListener("abort", onAbort);
    rpc.child.stdin!.end();
    if (!await drainGroup(rpc.pid)) process.stderr.write(`relay could not clean up Codex configuration check: cleanup refused for process group ${rpc.pid}\n`);
  }
}

/**
 * Runs one Codex turn through `codex app-server` (JSON-RPC over stdio). The app server is the only
 * Codex entry point that sends approval requests to its client, and the only one that reports the
 * effective configuration. One server process per turn, so there is no long-lived broker to go
 * stale; sessions are the same threads `codex exec` uses.
 */
/** `stage2`: the hooks of a stage-2 turn (codex-env.ts), called at the points marked; undefined for every other turn. */
export function startCodexAppTurn(spec: TurnSpec, flags: { off: string[]; c: string[]; expect: Expected; released?: readonly string[] }, env: NodeJS.ProcessEnv, stage2?: Stage2Session): TurnHandle {
  if (spec.overlay) { if (spec.signal?.aborted) throw new Error("overlay deadline expired before app-server launch"); assertOverlayLaunch(spec.overlay, spec.turnId); }
  // Stage 2: the app server runs with exactly the environment admission checked, never another.
  if (stage2 && env !== stage2.env) throw new Error("relay will not start a Codex agent with raw network in an environment other than the one its admission checked.");
  const { log, warnings: logWarnings } = openAgentLog(spec.logPath, { env });
  const args = ["app-server", ...flags.off, ...flags.c];
  log.write(`\n# ${new Date().toISOString()} ${spec.config.targets.codex.bin} ${args.map((a) => JSON.stringify(a)).join(" ")}\n`);

  let threadId: string | undefined = spec.sessionId;
  let turnId: string | undefined;
  let finalMessage = "";
  let cancelled = false;
  /** Whether turn/start handed the prompt to the thread. Until then a thread's id is not the session's. */
  let delivered = false;
  const stderrTail = diagnosticTail();
  /** Set once the turn's result is known; the handle resolves only after the server process has gone. */
  let outcome: Omit<TurnResult, "sessionId" | "finalMessage" | "exitCode"> | null = null;
  let resolveDone!: (r: TurnResult) => void;
  const done = new Promise<TurnResult>((r) => (resolveDone = r));
  /** Files each pending file change would touch, by thread and item, including native children. */
  const fileChanges = new Map<string, string[]>();
  const fileKey = (p: Msg["params"], id: unknown) => JSON.stringify([p?.threadId ?? threadId, String(id)]);
  /** Commands and file changes the agent was refused. */
  const denials: string[] = [];
  const subagents = new CodexSubagents();

  let groupRefused = false;
  let cleanupRefusal: string | undefined;
  const stopTimers: NodeJS.Timeout[] = [];
  const signalGroup = (sig: NodeJS.Signals) => {
    if (groupRefused) return false;
    if (sig === "SIGKILL") stage2?.disarmTools();
    if (rpc.pid <= 1) return false;
    // Every relay-initiated stop needs its last snapshot before signalling: a killed or
    // zombified server can no longer identify descendants, even before its exit event arrives.
    settled = watch.look() || settled;
    try {
      sendGroupSignal(rpc.pid, sig);
    } catch (err) {
      if (isGroupSignalRefusal(err)) {
        groupRefused = true;
        cleanupRefusal = `Agent cleanup refused for group ${rpc.pid}: ${err.message}`;
        // The refused process may never exit. Settle independently, without derived cleanup.
        void Promise.resolve().then(() => settle(null));
        return false;
      }
      // Already gone.
    }
    return true;
  };
  let watch!: Watch;
  /** True once a look has found the server alive after the turn stopped starting things. */
  let settled = false;
  const finish = (r: Omit<TurnResult, "sessionId" | "finalMessage" | "exitCode">) => {
    if (outcome) return;
    stage2?.disarmTools();
    const warning = subagents.warning();
    outcome = warning ? { ...r, warnings: [...(r.warnings ?? []), warning] } : r;
    // The last look, while what the server started can still be traced to it.
    settled = watch.look() || settled;
    rpc.child.stdin!.end();
    // No grace period in which the harness could retry a vendor safety stop.
    if (r.status === "refused") signalGroup("SIGKILL");
    // The server has no reason to outlive its one turn.
    stopTimers.push(setTimeout(() => signalGroup("SIGTERM"), 200).unref());
    stopTimers.push(setTimeout(() => {
      if (signalGroup("SIGKILL")) killProcs(watch.procs());
    }, 200 + spec.config.cancel_grace_ms).unref());
  };

  const onServerRequest = async (m: Msg) => {
    const p = m.params ?? {};
    // Stage 2: before anything is shown or answered, the Mac's addresses held and a command is bound to
    // relay's executor (review R4). Otherwise: declined, the app server killed, the turn failed.
    if (stage2 && (m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval")) {
      const unsafe = stage2.approvalProblem(m.method === "item/fileChange/requestApproval" ? "file" : "command", p.environmentId);
      if (unsafe) {
        rpc.send({ id: m.id, result: { decision: "decline" } });
        signalGroup("SIGKILL");
        return finish({ status: "failed", error: unsafe });
      }
    }
    let ask: ApprovalAsk;
    if (m.method === "item/commandExecution/requestApproval") {
      const refused = autoDenial(p, flags.expect.permissions) ?? (!stage2 && flags.expect.permissions.profile !== null ? codexRuntimeApprovalProblem(p, spec.config) : null);
      if (refused) {
        // Nobody is asked. The request is declined, recorded with the turn's refusals and in its log,
        // and the agent is told why.
        if (outcome) return;
        rpc.send({ id: m.id, result: { decision: "decline" } });
        const what = clipped(String(p.command ?? (p.networkApprovalContext ? `network access to ${p.networkApprovalContext.host ?? "a host"}` : "a command")), 200);
        denials.push(`${what} (declined by relay: ${refused})`);
        if (!log.writableEnded) log.write(`# relay: declined an approval request without asking: ${refused}\n`);
        const requestingThread = p.threadId ?? threadId, requestingTurn = p.turnId ?? turnId;
        if (requestingThread && requestingTurn) {
          const text = `[relay] Your approval request (${what}) was declined by relay without asking anyone: ${refused}. Work without it, or say in your report what you needed.`;
          rpc.request("turn/steer", { threadId: requestingThread, expectedTurnId: requestingTurn, input: [{ type: "text", text, text_elements: [] }] }).catch(() => {});
        }
        return;
      }
      ask = commandAsk(p, flags.expect.permissions);
      // Stage 2: the command runs in relay's executor, so allowing it lifts nothing (C9).
      if (stage2) ask = { ...ask, detail: { ...((ask.detail as Record<string, unknown> | undefined) ?? {}), ...stage2.approvalDetail("command") } };
    } else if (m.method === "item/fileChange/requestApproval") {
      const paths = fileChanges.get(fileKey(p, p.itemId)) ?? [];
      // Nobody can decide a change they cannot see: without the files, the answer is no.
      if (!paths.length) return rpc.send({ id: m.id, result: { decision: "decline" } });
      ask = { kind: "file", summary: `change files: ${paths.join(", ")}`, reason: p.reason ?? undefined, paths };
      if (stage2) ask = { ...ask, detail: { ...((ask.detail as Record<string, unknown> | undefined) ?? {}), ...stage2.approvalDetail("file") } };
    } else if (m.method === "mcpServer/elicitation/request") {
      return rpc.send({ id: m.id, result: { action: "decline" } });
    } else {
      return rpc.send({ id: m.id, error: { message: `relay does not handle ${m.method}` } as never });
    }
    // Anything going wrong while asking counts as a refusal.
    let decision = "decline";
    let note: string | undefined;
    let decider: string | undefined;
    try {
      const answer: ApprovalAnswer = spec.onApproval ? await spec.onApproval(ask, () => outcome !== null) : { allow: false };
      // Relay refuses "for the rest of the job" on a once-only request (core/approvals.ts decide); never sent regardless.
      const onceOnly = (ask.detail as { once_only?: unknown } | undefined)?.once_only === true;
      if (answer.allow) decision = answer.forJob && !onceOnly ? "acceptForSession" : "accept";
      note = answer.deciderNote;
      decider = answer.decider;
    } catch {
      decision = "decline";
    }
    if (outcome) return;
    rpc.send({ id: m.id, result: { decision } });
    // The app server's approval answer carries a decision and nothing else (its
    // CommandExecutionRequestApprovalResponse and FileChangeRequestApprovalResponse, Codex
    // 0.162.1), and Codex tells its agent only that the user rejected or approved. A note from
    // whoever decided reaches the agent as a message steered into its running turn (turn/steer).
    const requestingThread = p.threadId ?? threadId, requestingTurn = p.turnId ?? turnId;
    if (note && requestingThread && requestingTurn) {
      const text = `[relay] Your approval request (${clipped(ask.summary, 200)}) was ${decision === "decline" ? "denied" : "allowed"}${decider ? ` ${decider}` : ""}. The note that came with the decision: ${note}`;
      rpc.request("turn/steer", { threadId: requestingThread, expectedTurnId: requestingTurn, input: [{ type: "text", text, text_elements: [] }] })
        .then(() => log.writableEnded || log.write("# relay: the decision's note was steered into the turn\n"))
        .catch((err: Error) => log.writableEnded || log.write(`# relay: the decision's note could not be steered into the turn: ${err.message}\n`));
    }
  };

  const rpc = connect(spec.config.targets.codex.bin, args, spec.cwd, env, (m, line) => {
    // The server can still emit a line or two after the turn has been reported.
    if (!log.writableEnded && m.method !== "mcpServer/startupStatus/updated" && m.method !== "thread/tokenUsage/updated") log.write(line + "\n");
    if (m.id !== undefined && m.method) return void onServerRequest(m).catch(() => {});
    const p = m.params ?? {};
    // Stage 2: a turn relay did not ask for is not bound to its executor (Stage2TurnGuard): the app server is killed first.
    if (stage2 && !outcome && m.method === "turn/started") {
      const foreign = stage2.guard.started(p.threadId, threadId, p.turn?.id);
      if (foreign) {
        signalGroup("SIGKILL");
        return finish({ status: "failed", error: foreign });
      }
    }
    if (!outcome && (m.method === "item/started" || m.method === "item/completed")) subagents.activity(p.item, threadId);
    // Approval metadata and denials belong to every thread. Keep thread identity in the key:
    // a child's item id must not replace another thread's pending file-change paths.
    if (m.method === "item/started" && p.item?.type === "fileChange" && p.item.id) {
      fileChanges.set(fileKey(p, p.item.id), ((p.item.changes ?? []) as { path?: string }[]).map((c) => c.path).filter((x): x is string => typeof x === "string"));
    }
    if (m.method === "item/completed") {
      // A completed file change may leave its paths out; they were announced when it started.
      const refused = declinedItem(p.item?.type === "fileChange" && !p.item.changes ? { ...p.item, changes: (fileChanges.get(fileKey(p, p.item.id)) ?? []).map((path) => ({ path })) } : p.item);
      if (refused) denials.push(refused);
    }
    if (m.method === "item/started" && typeof p.item?.type === "string") {
      const text = activityOf(p.item.type, p.item);
      if (text) spec.onActivity?.(text);
    }
    // The app server also streams native children's notifications. Their final messages,
    // usage, refusal and turn lifecycle belong to them, not to the parent relay is running.
    if (typeof p.threadId === "string" && p.threadId !== threadId) return;
    const refusal = m.method === "error" ? openaiRefusal(p.error) : undefined;
    if (refusal) return finish({ status: "refused", refusal, error: refusalError(refusal) });
    // The thread's running total, as Codex reports it after each model response.
    if (m.method === "thread/tokenUsage/updated") {
      const usage = usageFrom(p.tokenUsage?.total ?? p.tokenUsage, { cumulative: true });
      if (usage) spec.onUsage?.(usage);
    }
    if (m.method === "item/completed" && p.item?.type === "agentMessage" && typeof p.item.text === "string") finalMessage = p.item.text;
    if (m.method === "turn/started" && p.turn?.id) {
      turnId = p.turn.id;
      delivered = true;
    }
    if (m.method === "turn/completed") {
      stage2?.disarmTools();
      const status = p.turn?.status;
      const refusal = status === "failed" ? openaiRefusal(p.turn?.error) : undefined;
      if (refusal) return finish({ status: "refused", refusal, error: refusalError(refusal) });
      if (status === "completed") finish({ status: "ok" });
      else if (status === "interrupted") finish({ status: "interrupted", error: "cancelled" });
      else finish({ status: "failed", error: `codex turn ${status}: ${p.turn?.error?.message ?? "unknown error"}` });
    }
  });
  rpc.child.stderr!.on("data", (chunk: Buffer) => {
    stderrTail.write(chunk.toString());
  });
  watch = watchProcess(rpc.pid);
  let settling: Promise<void> | undefined;
  const settle = (code: number | null) => settling ??= (async () => {
    for (const timer of stopTimers) clearTimeout(timer);
    const unseenMs = watch.stop();
    if (!outcome) {
      outcome = cancelled
        ? { status: "interrupted", error: "cancelled" }
        : { status: "failed", error: `codex app-server exited (code ${code}) before the turn finished. ${stderrTail.text().trim().split("\n").slice(-3).join(" ")}`.trim() };
      const warning = subagents.warning();
      if (warning) outcome.warnings = [warning];
    }
    log.end();
    // Whatever the server started may be holding its output open. The streams get a moment to
    // drain and are then closed, so that neither the turn nor this worker waits on them.
    rpc.child.stdin!.end();
    if (groupRefused) rpc.disconnect();
    else {
      // Cleared once the streams have closed, so that it does not keep the worker alive for a second after its last turn.
      let drained: NodeJS.Timeout | undefined;
      await Promise.race([new Promise((r) => rpc.child.once("close", r)), new Promise((r) => { drained = setTimeout(r, 1000); })]);
      clearTimeout(drained);
    }
    rpc.child.stdout?.destroy();
    rpc.child.stderr?.destroy();
    // The turn is over only when nothing of the agent is left: children can outlive the server.
    if (!groupRefused && rpc.pid > 1) groupRefused = !await drainGroup(rpc.pid);
    if (groupRefused) {
      cleanupRefusal ??= `Agent cleanup refused for group ${rpc.pid}`;
      rpc.child.unref();
    }
    const appSurvivors = groupRefused ? [rpc.pid, ...watch.procs().map(p => p.pid)] : await stopProcs(watch.procs());
    // Stage 2: the executor and its descendants, after the app server (WP-C).
    const s2 = stage2 ? await stage2.teardown({ survivors: appSurvivors, descendants: watch.procs().filter(p => appSurvivors.includes(p.pid)), uncertain: groupRefused || (!settled && rpc.pid > 1), ...(cleanupRefusal ? { refused: cleanupRefusal } : {}) }).catch((err: Error) => ({ survivors: [], uncertain: true, warnings: [`relay could not tear down the stage-2 executor/provider: ${err.message}`] })) : null;
    const survivors = s2 ? [...appSurvivors, ...s2.survivors] : appSurvivors;
    const warnings = [...(outcome.warnings ?? []), ...logWarnings(), ...(cleanupRefusal ? [cleanupRefusal] : []), ...(s2?.warnings ?? [])];
    resolveDone({
      ...outcome, sessionId: threadId, finalMessage, exitCode: code, ...(denials.length ? { denials } : {}),
      ...(delivered ? {} : { delivered: false }),
      ...(warnings.length ? { warnings } : {}),
      ...(survivors.length ? { survivors } : {}), ...(s2?.uncertain ? { unseenMs: unseenMs ?? 0 } : settled || rpc.pid <= 1 ? {} : { unseenMs }),
    });
  })();
  rpc.child.on("error", (err) => {
    outcome = { status: "failed", error: `could not start ${spec.config.targets.codex.bin}: ${err.message}` };
    if (rpc.pid <= 1) void settle(null);
  });
  // "exit", not "close": something the server started can hold its output open, and the turn must not wait on that.
  rpc.child.on("exit", (code) => void settle(code));

  // Stage 2: the executor's exit or a change of this Mac's addresses fails the turn, the app server killed first (C5, C7).
  stage2?.watch((error) => {
    signalGroup("SIGKILL");
    finish({ status: "failed", error });
  });

  (async () => {
    // Pin the HTTP peer before initialize can cause any MCP connection.
    if (stage2 && rpc.pid > 1) {
      stage2.bindAppServer(rpc.pid);
    }
    if (outcome) return;
    await rpc.request("initialize", HELLO);
    rpc.send({ method: "initialized" });
    // Stage 2: bind the thread's only environment, relay's executor, before anything else (WP-C).
    if (stage2) {
      const unbound = await stage2.bind(rpc);
      if (unbound) return finish({ status: "failed", error: unbound });
    }
    // Before anything runs: is the confinement relay asked for the one Codex will actually apply here?
    const read = await rpc.request("config/read", { cwd: spec.cwd, includeLayers: true });
    const eff = read.config;
    const problem = configProblem(eff, flags.expect) ?? (await requirementsProblem(rpc, flags.expect.permissions)) ?? (await loginProblem(rpc, flags.expect)) ?? fastModeProblem(eff, flags.expect)
      ?? (flags.expect.skills ? await skillsProblem(rpc, spec.cwd, flags.expect.skills) : null);
    if (problem) return finish({ status: "failed", error: problem });
    // Stage 2: the app server's own local actions off, as relay set them (WP-D, review C1, C6).
    const unsafe = stage2 ? await stage2.readback(rpc, eff) : null;
    if (unsafe) return finish({ status: "failed", error: unsafe });
    // The features relay set and, for a proxied turn, Codex's own run of the sandbox check on this
    // very server. The preflight found them so (codex.ts chooseNetwork); a mismatch now means the
    // configuration changed since, and the turn is refused rather than given less.
    const unproved = await proxiedProblem(rpc, { cwd: spec.cwd, expect: flags.expect, env, layers: read.layers });
    if (unproved) return finish({ status: "failed", error: `relay will not start a Codex agent, because ${unproved}.` });
    if (flags.expect.endpointOverride && configProblem(eff, { ...flags.expect, endpointOverride: false })) spec.onWaived?.("codex_endpoint_override");
    // Released names Codex's own shell_environment_policy keeps from its commands: said, never overridden.
    const policyNote = codexShellPolicyNote(eff?.shell_environment_policy, flags.released ?? []);
    if (policyNote) spec.onNote?.(policyNote);
    if (flags.expect.daybreak) {
      const note = await daybreakSkip(rpc, spec.model);
      if (note) skipDaybreak(flags, spec.onNote, note);
    }
    if (spec.sessionId) await unarchiveThread(rpc, spec.sessionId);
    // Stage 2: nothing Codex would start by itself on resume, before the turn is bound (stage2QueueProblem).
    if (stage2 && spec.sessionId) {
      const queued = await stage2.resumeProblem(rpc, spec.sessionId);
      if (queued) return finish({ status: "failed", error: queued });
    }
    // A faster speed only where the account's catalog offers it for the model that would run, before
    // any thread runs: the one asked for, else a continued thread's own, else Codex's configured one.
    const catalog = flags.expect.speed && flags.expect.speed.name !== "standard" ? await readCatalog(rpc) : undefined;
    const checked = spec.model ?? (await continuedModel(rpc, flags.expect, spec.sessionId)) ?? (typeof eff?.model === "string" ? eff.model : undefined);
    const unoffered = await catalogProblem(rpc, flags.expect, checked, { catalog, continues: Boolean(spec.sessionId) });
    if (unoffered) return finish({ status: "failed", error: unoffered });
    // Sandbox, approval policy and speed are set on every turn, so a resumed session never keeps wider access or a faster tier.
    // The sandbox is relay's permission profile, named here so that no profile a resumed thread stored outranks it.
    const tier = flags.expect.speed?.tier;
    const thread = {
      ...(flags.expect.daybreak !== undefined ? { config: { daybreak: flags.expect.daybreak } } : {}),
      // Its workspace roots too: a resumed thread would otherwise restore the ones it stored (threadPermissionsProblem).
      cwd: spec.cwd, runtimeWorkspaceRoots: [spec.cwd], permissions: flags.expect.permissions.id, approvalPolicy: spec.escalate ? "on-request" : "never", approvalsReviewer: "user",
      ...(spec.model ? { model: spec.model } : {}),
      ...(tier ? { serviceTier: tier } : {}),
      // Stage 2: the executor as the thread's only environment, and approvals always on-request (C1).
      ...(stage2 ? stage2.threadParams(spec.cwd) : {}),
    };
    // A resumed thread's past turns are left out of the reply (excludeTurns, not experimental in 0.163.0 or 0.164.0), as
    // `codex exec` resumes: relay reads only the thread's settings from it, and Codex deprecates the full history for paginated threads.
    const checkpoint = stage2?.sessionsServed() ?? 0;
    const t = spec.sessionId ? await rpc.request("thread/resume", { threadId: spec.sessionId, ...thread, excludeTurns: true }) : await rpc.request("thread/start", thread);
    threadId = t?.thread?.id ?? threadId;
    // What the thread says it will use, before the first turn: OpenAI's models, and the one relay asked for.
    const served = threadPermissionsProblem(t, flags.expect.permissions, spec.cwd) ?? threadProblem(t, flags.expect) ?? threadTierProblem(t, flags.expect)
      ?? (stage2 ? stage2.threadProblem(t, spec.cwd, Boolean(spec.sessionId)) : null)
      // The model the thread reports is the one that runs: checked against the catalog too, if it is another.
      ?? (typeof t?.model === "string" && t.model !== checked ? await catalogProblem(rpc, flags.expect, t.model, { catalog, continues: Boolean(spec.sessionId) }) : null);
    if (served) return finish({ status: "failed", error: served });
    if (outcome) return;
    if (stage2) {
      const problem = threadId ? await stage2.threadMcpProblem(rpc, eff, threadId, checkpoint) : "Codex did not name its thread for the MCP readback";
      if (problem) {
        signalGroup("SIGKILL");
        return finish({ status: "failed", error: problem });
      }
    }
    if (outcome) return;
    log.write(`# relay: the thread runs with the permission profile ${JSON.stringify(t?.activePermissionProfile?.id)}, sandbox ${JSON.stringify(t?.sandbox ?? null)}, workspace roots ${JSON.stringify(t?.runtimeWorkspaceRoots ?? null)}\n`);
    // Preparation may have grown the never floor for any turn, including one without an overlay.
    spec.checkEnvironment?.(env);
    stage2?.guard.request();
    const started = await rpc.request("turn/start", {
      // 0.163.0's per-turn selection, distinct from a thread's saved Daybreak preference.
      // Explicit standard also prevents a resumed thread from retaining its old selection.
      ...(flags.expect.daybreak !== undefined ? { cyberAccessProgram: flags.expect.daybreak ? "daybreakBlue" : "standard" } : {}),
      threadId,
      input: [{ type: "text", text: spec.prompt, text_elements: [] }],
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(tier ? { serviceTier: tier } : {}),
      // Stage 2: every turn, fresh or resumed, bound to relay's executor in the request that carries the prompt (stage2TurnParams).
      ...(stage2 ? stage2.turnParams(spec.cwd) : {}),
    });
    turnId = started?.turn?.id ?? turnId;
    delivered = true;
    // Stage 2: relay's prompt started its own turn, and the thread reads back as bound to the executor only.
    if (stage2 && !outcome) {
      const foreign = stage2.guard.replied(started?.turn?.id);
      if (foreign) {
        signalGroup("SIGKILL");
        return finish({ status: "failed", error: foreign });
      }
      // §14: the binding went in turn/start. The model may call tools during this readback's
      // rollout retries, so arm as soon as the reply confirms relay's requested turn.
      stage2.armTools(threadId, turnId);
      if (spec.overlay) markOverlayLaunched(spec.overlay, spec.turnId);
      const unbound = threadId ? await stage2.turnProblem(rpc, threadId, spec.cwd) : "relay stopped the Codex agent with raw network and failed the turn, because Codex did not say which thread it runs.";
      if (unbound && !outcome) {
        signalGroup("SIGKILL");
        return finish({ status: "failed", error: unbound });
      }
    }
  })().catch((err: Error) => finish({ status: "failed", error: `codex app-server: ${err.message}` }));

  const cancel = async () => {
    if (cancelled || rpc.pid <= 1) { await done; return; }
    cancelled = true;
    settled = watch.look() || settled;
    // The clean way to stop a turn is to ask the server, which then stops what it started. A
    // signal is used only when there is no turn to interrupt yet.
    if (threadId && turnId) rpc.send({ id: rpc.nextId(), method: "turn/interrupt", params: { threadId, turnId } });
    else signalGroup("SIGINT");
    const timer = setTimeout(() => {
      watch.look();
      if (signalGroup("SIGKILL")) killProcs(watch.procs());
    }, spec.config.cancel_grace_ms);
    await done;
    clearTimeout(timer);
  };

  return { pid: rpc.pid, pgid: rpc.pid, startedAt: procStart(rpc.pid), done, cancel };
}
