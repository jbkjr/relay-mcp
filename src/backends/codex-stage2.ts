import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TurnSpec } from "./types.js";
import type { CodexPermissions } from "./codex-app.js";
import type { Stage2Network } from "../confine/seatbelt-stage2.js";
import { localModeInterlock, rawNetworkConsentProblem, stage2Enabled } from "../core/raw-network.js";
import { loopbackAliasProblem } from "../confine/ports.js";
import { canonical, escalationEnabled, networkOn, type RelayConfig } from "../core/config.js";
import { mediatedBaseline, mediatedNetworkProblem } from "../core/mediated-network-provider.js";
import { setParam } from "../core/db.js";
import { codexVersion } from "./codex-daybreak.js";
import { codexPinVersion } from "./codex-pin.js";
import { ensurePrivateRoot, privateStateRoot } from "../confine/private-root.js";
import { privateTurnTemp } from "../confine/turn.js";
import { spawnFound } from "../core/executables.js";

// Wire names shared with broker-http.ts (§8.4). Kept here too so BC can build before BA lands.
const BROKER_SERVER_NAME = "relay_tools";
const BROKER_TOKEN_ENV = "RELAY_BROKER_TOKEN";

/**
 * Stage 2's admission gates, Codex settings, readback and accounting (docs/codex-confinement-design.md
 * §2.2 steps 1-5 and 10-11, §2.4, §2.5; docs/codex-mcp-broker-design.md §7.1, §8.4). Owner: BC.
 *
 * A stage-2 turn's commands and file edits run in relay's executor, inside relay's Seatbelt; the app
 * server stays outside, unconfined. It runs with CODEX_EXEC_SERVER_URL=none (STAGE2_APP_SERVER_ENV),
 * so Codex registers no environment of its own (`local`) at all: the executor is the only place a
 * command can run, by construction, whatever turn Codex starts (review r_0c11d860 C1+X2). And
 * everything the app server would do on its own is switched off and read back before the prompt:
 * approvals always come to relay (on-request), only relay's authenticated HTTP MCP broker may
 * connect, no plugins, apps, hooks, image generation or skill-dependency installs, and the 1.0.5
 * pins. A setting that does not read back as relay set it refuses the turn; it is never downgraded.
 */

/** The first Codex with environments as relay uses them (environment/add, thread/start.environments; W163). */
export const STAGE2_MIN_CODEX: readonly number[] = [0, 164, 0];

/**
 * What relay adds to a stage-2 app server's environment, its own value (review r_0c11d860 C1+X2):
 * `CODEX_EXEC_SERVER_URL=none` makes Codex register no environment of its own (exec-server
 * environment_provider.rs normalize_exec_server_url: "none" disables, so the snapshot has no `local`
 * and no default). Verified model-free on 0.164.0 (2026-10-28): `environment/status` for `local`
 * answers `unknown`, before and after relay's environment/add; thread/start without environments
 * gives `[]`, and with `local` is refused ("unknown turn environment id `local`"); a resumed thread's
 * environments are `[]`; Codex's user shell command, its one-off command execution ("local
 * environment is not configured") and its file-system calls ("local filesystem is not configured")
 * are refused, should anything call them (relay does not); an enabled stdio MCP server does not
 * start ("local stdio MCP server … requires a local environment"). So a turn Codex starts by itself
 * (a queued or mailbox message, a goal, a source not known yet) and that relay's turn/start then
 * steers into keeps the environments it started with, which hold nothing but relay's executor, if
 * anything: there is nowhere unconfined for its commands to run.
 *
 * No stdio MCP server can run on a stage-2 turn. relay's tools instead use the authenticated HTTP
 * broker, which needs no `local` environment (codex-mcp-broker-design.md §2.1). Admission refuses the
 * person's own CODEX_EXEC_SERVER_* variables (stage2SettingsProblems): this value is relay's alone.
 */
export const STAGE2_APP_SERVER_ENV: Readonly<Record<string, string>> = Object.freeze({ CODEX_EXEC_SERVER_URL: "none" });

/** The environment a stage-2 app server runs with: `checked` (what admission checked) and STAGE2_APP_SERVER_ENV over it, frozen. */
export function stage2AppServerEnv(checked: Readonly<NodeJS.ProcessEnv>): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze({ ...checked, ...STAGE2_APP_SERVER_ENV });
}

/**
 * Features pinned off and read back on stage-2 sessions (§2.5). Each one, when on, lets the app
 * server act on this Mac itself, outside relay's Seatbelt, or widens what an approval does:
 * image generation saves under CODEX_HOME (D7); apps, plugins and their sync, remote plugins and
 * sharing, MCP apps, browser and computer use, tool suggestions; hooks and plugin hooks; installs
 * of a skill's MCP dependencies; Codex's network proxy and the request_permissions tool, and
 * per-command permission additions (exec_permission_approvals): the 1.0.5 pins; the JavaScript
 * REPL; memories, their import from other agents and Chronicle's screen context; the standalone
 * (extension-run) web search; goals (below). `respect_system_proxy` stays off for the broker's
 * HTTP client (§5.8); BB also merges loopback into NO_PROXY/no_proxy in the app server's environment.
 *
 * `goals` is pinned off because a goal starts turns by itself: an active goal of the thread (set by
 * the model's create_goal in an earlier turn, or by another client) makes Codex start a
 * continuation turn as soon as `thread/resume` leaves the thread idle, before relay's `turn/start`
 * can bind the turn to its executor. With Codex's own `local` registered, that turn ran with the
 * resumed thread's environments `[local, relay]`, and its commands in `local`, unconfined (WP-C,
 * 2026-10-28, on 0.164.0; with `features.goals=false` no turn started). Since the app server has no
 * `local` (STAGE2_APP_SERVER_ENV), such a turn has no environment and cannot run a command; the pin
 * stays as defence in depth, with the turn guard (Stage2TurnGuard).
 *
 * `code_mode` is pinned off too, but that changes nothing for the models relay runs: every gpt-6.x
 * and gpt-5.6 entry of Codex 0.164.0's catalog is `tool_mode: "code_mode_only"`, which overrides the
 * feature, so those models get code mode's `exec` anyway (STAGE2_TOOLS). It is kept off for a model
 * in direct mode, where the feature alone would add `exec`.
 *
 * `deferred_tool_world_state` is different: it adds no host action. At rust-v0.167.0 its feature
 * description reads "Describe deferred tool namespaces in the model-visible world state"
 * (features/src/lib.rs); when on, core session/world_state.rs adds a section naming the deferred
 * tool namespaces, and core tools/spec_plan.rs drops the source listing from tool_search's own
 * description. 0.164.0 and 0.166.0 list it under development, default off; 0.167.0 makes it
 * stable and on by default. Every version stage 2 admits (STAGE2_MIN_CODEX) lists it, so it is in
 * this base list rather than version-gated. It is pinned off as defence in depth and to keep the
 * model-visible context of the qualified 0.166.0.
 */
export const STAGE2_FEATURES_OFF: readonly string[] = [
  "image_generation", "apps", "plugins", "remote_plugin", "plugin_sharing", "enable_mcp_apps", "browser_use", "computer_use", "tool_suggest",
  "hooks", "plugin_hooks", "skill_mcp_dependency_install", "network_proxy", "request_permissions_tool",
  "exec_permission_approvals", "js_repl", "code_mode", "memories", "external_agent_memory_import", "chronicle",
  "standalone_web_search", "goals", "respect_system_proxy", "deferred_tool_world_state",
];

/** 0.166.0 adds these keys; older binaries must not be required to list them. Source at
 * rust-v0.166.0: app-server message_processor.rs and core-plugins manager.rs start host-side
 * discovery prefetch (also gated by plugins=false); core session/mod.rs preserves parent tool
 * declarations only in MCP-disabled prediction/sample forks, APIs relay never calls. Both stay
 * off as defence in depth.
 *
 * 0.167.2 adds `incremental_tools_legacy_gcp`, stable and on by default ("Publish incremental tool
 * declarations on regular GCP Responses", features/src/lib.rs); 0.167.0 and 0.167.1 do not list it.
 * Core session/step_context.rs selects it only when the turn's model provider is `gcp`, so it
 * changes nothing on relay's OpenAI-provider turns and adds no tool or host action. It is pinned
 * off as defence in depth and to keep the qualified 0.167.0's behaviour, rather than admitted.
 *
 * 0.170.0 turns on by default seven features older versions list off or not at all
 * (STAGE2_FEATURES_OFF_0170). None adds a tool or a host action, and each is pinned off to keep
 * the qualified 0.167.2's behaviour rather than admitted. 0.170.0 also marks
 * `plugin_discovery_prefetch` removed: config ignores it and the list reports it off, so its pin
 * still reads back. */
export function stage2FeaturesOff(version: readonly number[]): readonly string[] {
  let off = atLeast(version, [0, 166, 0])
    ? [...STAGE2_FEATURES_OFF, "plugin_discovery_prefetch", "prediction_preserve_parent_tools"]
    : STAGE2_FEATURES_OFF;
  if (atLeast(version, [0, 167, 2])) off = [...off, "incremental_tools_legacy_gcp"];
  return atLeast(version, [0, 170, 0]) ? [...off, ...STAGE2_FEATURES_OFF_0170] : off;
}

/**
 * Features Codex 0.170.0 turns on by default, pinned off from 0.170.0 (source at rust-v0.170.0):
 * - `code_mode_host_grpc`: core thread_manager.rs picks the gRPC code-mode host over the
 *   process-owned one. Both run the same unsandboxed `codex-code-mode-host` child over its stdio
 *   (core code_mode_host.rs, `--listen grpc+stdio://`, no listener) in a process group of its
 *   own, as the process-owned one already was (code-mode remote_session/connection.rs, 0.167.2).
 *   Relay's teardown stops it either way as a recorded descendant of the app server (watchProcess),
 *   and both hosts exited within 0.25 s of the app server's death with a busy cell running
 *   (2026-11-18, docs/qualification/codex-0.170.0.md). Only the wire protocol and session recovery
 *   differ: no confinement reason to refuse it, pinned off for parity with 0.167.2 until a
 *   qualification runs with it on.
 * - `code_mode_host_output_truncation`: wraps the code-mode provider to truncate `exec` output in
 *   the host instead of the client (thread_manager.rs); what the model sees, nothing else.
 * - `guardian_include_additional_context`: adds additional-context tool outputs to Guardian's
 *   review history (context_manager/history.rs). Relay answers approvals itself.
 * - `incremental_tools_legacy`: read only for the Amazon Bedrock providers (session/step_context.rs),
 *   as `incremental_tools_legacy_gcp` is for `gcp`; inert on relay's OpenAI-provider turns.
 * - `retain_client_tool_outputs`: keeps client tool outputs across remote compaction
 *   (compact_remote_v2.rs, compact_remote_history.rs, session/mod.rs).
 * - `unified_image_budget`: one image budget for prepared images (image_preparation.rs).
 * - `untrusted_as_tool_output`: renders untrusted additional context, a turn's `additionalContext`
 *   or a goal's objective, as a tool output (namespace `agent`) rather than a user fragment
 *   (session/turn_input.rs, state/additional_context.rs). Relay sends no additional context and
 *   pins goals off, so it is inert on relay's turns.
 * 0.170.0 lists each; older versions are not required to.
 */
export const STAGE2_FEATURES_OFF_0170: readonly string[] = [
  "code_mode_host_grpc", "code_mode_host_output_truncation", "guardian_include_additional_context", "incremental_tools_legacy",
  "retain_client_tool_outputs", "unified_image_budget", "untrusted_as_tool_output",
];

// Admission probes the selected executable, not the mutable pin link. Retain its checked version
// for this turn (including explicit unpinned executables); planning never probes `current` again.
const admittedVersions = new WeakMap<TurnSpec, readonly number[]>();

/**
 * The features a stage-2 session may run with on, on the Codex versions qualified (0.164.0): what
 * experimentalFeature/list reported enabled with relay's stage-2 settings and a scratch CODEX_HOME,
 * model-free (WP-D readback probe, 2026-10-28). Any other feature on refuses the turn: a feature a
 * new Codex adds, or one a layer of the person's turns on, may add a tool or an action of the app
 * server's own, and waits until it is qualified (§2.5, the per-release allowlist).
 */
export const STAGE2_FEATURES_ALLOWED_ON: readonly string[] = [
  // core/session/reasoning_effort.rs and core/client.rs (rust-v0.166.0): trusted
  // configuration_update items carry effort changes; no tool or host-side action is added.
  "reasoning_effort_override",
  // Stable, on by default. Shell snapshots are not taken for a remote environment such as relay's
  // executor (core shell_snapshot.rs); daemon_auto_start acts only for the TUI and remote control;
  // workspace_dependencies is read nowhere in 0.164.0; code_mode_host runs `exec`'s V8 isolate.
  "api_key_cyber_access_programs", "api_key_model_discovery", "auth_elicitation", "bedrock_setup_wizard", "cli_daybreak",
  "code_mode_host", "code_mode_interrupt", "compaction_image_budget", "content_item_kinds", "daemon_auto_start",
  "enable_request_compression", "fast_mode", "guardian_approval", "guardian_reuse_parent_compaction",
  "incremental_tools", "instant_interrupt", "mcp_oauth_refresh_coordination", "mentions_v2", "multi_agent", "shell_snapshot",
  "shell_tool", "skill_search", "sleep_tool", "system_proxy_fallback", "tool_call_mcp_elicitation", "ultrafast_mode",
  "unbounded_connection_retries", "unified_exec", "unified_exec_tty", "view_image", "workspace_dependencies", "write_stdin_approval",
  // Gates the desktop apps read from requirements, not the app server.
  "browser_annotation_api", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser", "in_app_chat",
  "in_app_dictation", "in_app_local_automation", "in_app_updates", "in_app_voice",
  // Removed in 0.164.0, listed as on: no-ops.
  "collaboration_modes", "item_ids", "realtime_conversation", "resize_all_images", "sqlite", "steer", "terminal_resize_reflow",
  "tool_search_always_defer_mcp_tools", "tui_app_server", "worktrees",
];

/** relayServer's child tools; per-turn listings use broker.listTools(), which may be narrower. */
const BROKER_TOOL_NAMES = ["escalate", "delegate", "status", "result", "resume", "cancel", "merge", "ask", "brief", "discuss", "review"] as const;
const brokerToolSurfaces = (names: readonly string[]): string[] => ["mcp__relay_tools", ...names, ...names.map((name) => `mcp__relay_tools__${name}`)];
const BROKER_TOOL_SURFACES = brokerToolSurfaces(BROKER_TOOL_NAMES);

/**
 * The tools a stage-2 session may offer the model on the Codex versions qualified (§2.5, §9.3): an
 * allowlist the advertised set must be a subset of (stage2ToolsProblem). Not an exact list: the set
 * varies by model. WP-F's qualification (§7.2 item 10) checks it per release with the fake model.
 * Relay cannot check it per turn: the tool list goes from the app server to OpenAI over TLS, and the
 * app server reports it nowhere relay can read. The per-turn guard is the config and feature
 * readback (stage2Readback, STAGE2_FEATURES_ALLOWED_ON).
 *
 * Seen on 0.164.0 with relay's stage-2 flags, a scratch CODEX_HOME and the fake Responses server
 * (WP-D probe, every catalog model, all `code_mode_only`): the model gets an `additional_tools`
 * input item, not `body.tools`, with namespace `functions` (`exec`, `wait`, `request_user_input`,
 * and on 6.x `request_user_input_async`), on 6.x `clock` (`sleep`; `curr_time`, inside `exec` as
 * `clock__curr_time`) and `collaboration` (`spawn_agent`, `wait_agent`, `send_message`,
 * `followup_task`, `interrupt_agent`, `list_agents`); inside `exec`: `apply_patch`, `exec_command`,
 * `write_stdin`, `view_image`, the goal tools (gone since `goals` is pinned off) and the MCP
 * resource tools. A model in direct mode
 * (gpt-5.5, WP-F) gets the classic list and `tool_search`. MCP tools are confined to
 * `mcp__relay_tools` and the broker's own names (broker design §8.6).
 *
 * Where each runs: `exec_command`, `write_stdin`, `apply_patch` and `view_image` in relay's
 * executor; `web_search` at OpenAI; subagents inherit the turn's environments, which relay binds
 * to its executor (stage2TurnParams); the plan, clock, user-input, tool-search and MCP-resource
 * tools in the app server, touching no file or network of this Mac's themselves. `exec` runs model-written JavaScript in a V8 isolate in
 * `codex-code-mode-host`, an unsandboxed child of the app server (core code_mode_host.rs
 * HostConnection::spawn), with no Node, file system or network bindings; its nested tools go through
 * Codex's router to the thread's environment, relay's executor. The same host runs today for every
 * Codex turn under relay 1.0.5, so stage 2 does not widen it. Residual: an escape from the isolate
 * would run as the app server, unconfined (§8).
 * `request_user_input` is refused by Codex itself in default collaboration mode ("unavailable in
 * Default mode", WP-D probe); were it asked, relay answers item/tool/requestUserInput with an error
 * (codex-app.ts onServerRequest), so it fails closed.
 */
export const STAGE2_TOOLS: readonly string[] = [
  // Namespaces (code mode).
  "functions", "clock", "collaboration",
  // Code mode's own.
  "exec", "wait", "request_user_input", "request_user_input_async", "sleep", "curr_time", "clock__curr_time",
  // Collaboration (multi-agent v2), and multi-agent v1 in direct mode.
  "spawn_agent", "wait_agent", "send_message", "followup_task", "interrupt_agent", "list_agents", "send_input", "resume_agent", "close_agent",
  // Classic, and nested inside `exec`.
  "exec_command", "write_stdin", "apply_patch", "view_image", "web_search", "update_plan", "tool_search",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  // ext/web-search's standalone search (namespace `web`, tool `run`; `web__run` inside `exec`), offered
  // to code-mode models whenever the provider is OpenAI's and web search is on (relay sets "live" for
  // a network grant; the `standalone_web_search` pin does not remove it; WP-F item 10). It runs in the
  // app server but only POSTs the model's search commands, open_page URLs included, to the provider's
  // search endpoint (codex-api endpoint/search.rs SEARCH_ENDPOINT, ext/web-search tool.rs): the
  // provider fetches pages, not this Mac. Same trust as model traffic and hosted web_search; the
  // prompt-injection residual of search results is 1.0.5's (X6).
  "web", "run", "web__run",
  // Codex 0.170.0's catalog lists it in a model's `experimental_supported_tools`, which offers it
  // whatever the feature `send_message_to_user_async` says (core tools/spec_plan.rs), to root
  // turns only. Its handler (tools/handlers/send_message_to_user_async.rs) emits an agent message
  // item and returns `{"accepted":true}`: no file, process or network of this Mac's.
  "send_message_to_user_async",
  ...BROKER_TOOL_SURFACES,
];

/**
 * Which advertised tools are not on the allowlist, for the per-release qualification (WP-F, §7.2
 * item 10): each name as the request carries it, a namespace by its own name and its members, and
 * `exec`'s nested tools. Pass the actual broker tool names to narrow the qualified child-tool union
 * for a turn whose policy disables delegation. What is not allowed, or null.
 */
export function stage2ToolsProblem(advertised: readonly string[], brokerTools: readonly string[] = BROKER_TOOL_NAMES): string | null {
  const qualified = brokerTools.filter((t) => (BROKER_TOOL_NAMES as readonly string[]).includes(t));
  const allowed = new Set([...STAGE2_TOOLS.filter((t) => !BROKER_TOOL_SURFACES.includes(t)), ...brokerToolSurfaces(qualified)]);
  const extra = [...new Set(advertised.filter((t) => !allowed.has(t)))].sort();
  return extra.length ? `Codex offers the model tools relay has not qualified for stage 2: ${extra.join(", ")}` : null;
}

/** The session-params key that records a turn's enforcement (no registry schema change): `codex_confinement` (params.ts). */
export const CONFINEMENT_PARAM = "codex_confinement";

/** Codex's own permission profile without its sandbox; on a stage-2 turn relay's Seatbelt around the executor confines instead. */
const FULL_ACCESS = ":danger-full-access";

/** Network grants always require stage 2 when enabled, even if qualification must refuse.
 * Network-disabled origins use it when they can request a restart. */
export function stage2Wanted(spec: Pick<TurnSpec, "config" | "target" | "grant" | "overlay">): boolean {
  if (!stage2Enabled(process.env, spec.config) || spec.target.id !== "codex") return false;
  if (networkOn(spec.config, spec.grant)) return true;
  return spec.config.codex_backend !== "exec" && (spec.grant?.raw_network === true
    || spec.overlay?.state === "running" || (escalationEnabled(spec.config) && !spec.config.allow_dangerous));
}

/** Which confinement a turn runs under: relay's (stage 2) or Codex's own, verified (§2.4). */
export function turnConfinement(spec: Pick<TurnSpec, "config" | "target" | "grant" | "overlay">): "verified" | "relay-enforced" {
  return stage2Wanted(spec) ? "relay-enforced" : "verified";
}

/** Where Codex keeps its home for `env`: CODEX_HOME, else ~/.codex (as Codex resolves it). */
function codexHomeOf(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
}

/** Whether version `v` is `min` or later. */
function atLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = v[i] ?? 0;
    if (a !== min[i]) return a > min[i];
  }
  return true;
}

/**
 * The settings of relay's and of Codex's that stage 2 needs, read without starting anything: what
 * is wrong, each as a phrase. Admission refuses on any; doctor reports them.
 */
export function stage2SettingsProblems(cfg: Pick<RelayConfig, "child_mcp" | "child_hooks" | "codex_backend">, env: NodeJS.ProcessEnv, version: readonly number[] | null): string[] {
  const wrong: string[] = [];
  if (cfg.codex_backend === "exec") wrong.push('codex_backend is "exec", and stage 2 runs only through Codex\'s app server');
  if (!version) wrong.push("relay could not read Codex's version");
  else if (!atLeast(version, STAGE2_MIN_CODEX)) wrong.push(`Codex is ${version.join(".")}, and stage 2 needs ${STAGE2_MIN_CODEX.join(".")} or later (its execution environments)`);
  // Codex takes CODEX_HOME/environments.toml over environment/add and over CODEX_EXEC_SERVER_URL
  // (exec-server environment.rs from_codex_home), and the Noise variables over both: any of them
  // decides which environments the app server has, `local` included. relay sets
  // CODEX_EXEC_SERVER_URL=none itself (STAGE2_APP_SERVER_ENV), so a value of the person's, or any
  // other executor variable, is refused, never merged.
  const toml = path.join(codexHomeOf(env), "environments.toml");
  if (fs.existsSync(toml)) wrong.push(`${toml} exists, and Codex would take its environments from it rather than from relay`);
  const routed = Object.keys(env).filter((k) => k.startsWith("CODEX_EXEC_SERVER_")).sort();
  if (routed.length) wrong.push(`the agent's environment sets ${routed.join(", ")}, which route Codex's commands to another executor`);
  if (Object.hasOwn(env, BROKER_TOKEN_ENV)) wrong.push(`the person's environment sets ${BROKER_TOKEN_ENV}, which relay reserves for its per-turn broker credential`);
  // Review C1, C6: an MCP server or hook would run in the app server, outside relay's Seatbelt. Without
  // `local` no stdio server can start, but a streamable-HTTP one still can (codex-mcp runtime.rs
  // resolve_server_environment: local HTTP uses the app server's own client), so the person's servers
  // are still switched off by name (child_mcp "relay-only") and plugins with them, and read back.
  if (cfg.child_mcp !== "relay-only") wrong.push('child_mcp is not "relay-only", and the person\'s MCP servers would run outside relay\'s sandbox');
  if (cfg.child_hooks) wrong.push("child_hooks is on, and Codex's hooks would run outside relay's sandbox");
  return wrong;
}

/** What admission reads beyond the turn itself; tests replace them, nothing else does. */
export interface AdmissionProbes {
  consent(spec: TurnSpec): string | null;
  version(bin: string, env: NodeJS.ProcessEnv): number[] | null;
  /** All person-defined servers, including disabled entries: their fields would still merge. */
  mcpServers(bin: string, env: NodeJS.ProcessEnv, cwd: string): string[];
  interlock(): string | null;
  aliases(): string | null;
}
const PROBES: AdmissionProbes = {
  consent: (spec) => rawNetworkConsentProblem(spec.markers?.nodeId, spec.grant),
  version: (bin, env) => codexVersion(bin, env),
  mcpServers: (bin, env, cwd) => {
    const r = spawnFound(bin, ["--disable", "plugins", "mcp", "list", "--json"], { encoding: "utf8", timeout: 20000, env, cwd }, env.PATH ?? "");
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`codex mcp list exited with ${r.status}`);
    let list: unknown;
    try { list = JSON.parse(r.stdout); } catch { throw new Error("codex mcp list did not return JSON"); }
    if (!Array.isArray(list) || list.some((s) => typeof s?.name !== "string")) throw new Error("codex mcp list did not return named servers");
    return list.map((s) => s.name);
  },
  interlock: () => localModeInterlock("stage2"),
  aliases: () => loopbackAliasProblem(),
};

/**
 * Admission (§2.2 steps 1-5): for a raw-network grant, the person's consent stored for the very
 * grant this turn launches with (raw-network.ts rawNetworkConsentProblem; review R2), Codex 0.164 or later, no ~/.codex/environments.toml, no
 * CODEX_EXEC_SERVER_URL or Noise variables in `env` (the person's environment, before relay adds its
 * own STAGE2_APP_SERVER_ENV), no person's broker-token variable or relay_tools config entry,
 * child_mcp relay-only, child_hooks off, no extension servers (unsupported on stage-2 jobs),
 * the interlock (raw-network.ts), no lo0 aliases (ports.ts). The reason it cannot run, or null. A
 * check that cannot be made refuses. `probes`: tests only.
 */
export function stage2Admission(spec: TurnSpec, env: NodeJS.ProcessEnv, probes: Partial<AdmissionProbes> = {}): string | null {
  admittedVersions.delete(spec);
  const p = { ...PROBES, ...probes };
  const refuse = (why: string) => `relay cannot run this Codex job under stage 2: ${why}. It does not start the agent; there is no native strict or raw fallback.`;
  if (!stage2Wanted(spec)) return refuse("this turn does not select stage 2");
  const baseline = mediatedBaseline(spec.grant, spec.config);
  if (baseline?.network && !baseline.raw_network) {
    if (!spec.neverPolicy) return refuse("mediated launch has no checked never policy");
    const unavailable = mediatedNetworkProblem({ capabilities: spec.overlay?.request.capabilities ?? [], baseline, policy: spec.neverPolicy });
    if (unavailable) return refuse(unavailable);
  }
  if (spec.grant?.raw_network && spec.access !== "write" && !spec.overlay) return refuse("raw network is for write jobs");
  // caller.ts refuses network with extension servers already (NO_NETWORK_WITH_SERVERS); a stored run is checked again here.
  if (spec.extensionServers?.length) return refuse("stage-2 jobs do not support extension servers");
  let unconsented: string | null;
  try {
    // A consumed overlay carries its separately authenticated one-turn authority. It cannot mint
    // standing raw consent, and the launch gate verifies its destination and immutable digest.
    unconsented = !spec.grant?.raw_network ? null : p.consent(spec);
  } catch (err) {
    unconsented = `relay could not read the person's consent (${(err as Error).message})`;
  }
  if (unconsented) return refuse(unconsented);
  let version: number[] | null = null;
  try { version = p.version(spec.config.targets.codex.bin, env); } catch { version = null; }
  const wrong = stage2SettingsProblems(spec.config, env, version);
  if (wrong.length) return refuse(wrong.join("; "));
  try {
    if (p.mcpServers(spec.config.targets.codex.bin, env, spec.cwd).includes(BROKER_SERVER_NAME)) {
      return refuse(`the person's Codex config defines ${BROKER_SERVER_NAME}; remove or rename it, because Codex's recursive merge would retain inherited fields in relay's broker entry`);
    }
  } catch (err) {
    return refuse(`relay could not read the person's MCP server names (${(err as Error).message}), so it cannot rule out a ${BROKER_SERVER_NAME} entry`);
  }
  for (const [what, check] of [["whether a relay local-network job runs", p.interlock], ["this Mac's loopback addresses", p.aliases]] as const) {
    let problem: string | null;
    try {
      problem = check();
    } catch (err) {
      problem = `relay could not check ${what} (${(err as Error).message})`;
    }
    if (problem) return refuse(problem);
  }
  admittedVersions.set(spec, Object.freeze([...version!]));
  return null;
}

/** The non-secret settings BB passes to codexFlags/configProblem and the stage-2 readback. */
export interface Stage2BrokerConfig {
  url: string;
  /** codexToolTimeoutS(spec.config.approval_timeout_s), never taken from the config being checked. */
  toolTimeoutS: number;
}

/**
 * BA's HttpBroker structurally supplies url, listTools and sessionsServed (§8.4). BB adds the
 * expected timeout; no token value crosses this interface. The counter includes only authenticated,
 * peer-verified sessions and is monotonic, including sessions already closed by a listing.
 */
export interface Stage2BrokerReadback extends Stage2BrokerConfig {
  listTools(): Promise<readonly { name: string }[]>;
  sessionsServed(): number;
}

/** The exact HTTP entry (§7.1). Unexpected keys are named, never printed: they may hold a secret. */
export function stage2BrokerConfigProblem(entry: unknown, expected: Stage2BrokerConfig): string | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `Codex does not report relay's ${BROKER_SERVER_NAME} MCP entry`;
  const server = entry as Record<string, unknown>;
  const required: Record<string, unknown> = {
    url: expected.url, bearer_token_env_var: BROKER_TOKEN_ENV, environment_id: "local",
    enabled: true, required: true, default_tools_approval_mode: "approve",
    startup_timeout_sec: 30, tool_timeout_sec: expected.toolTimeoutS,
  };
  for (const [key, value] of Object.entries(required)) {
    if (server[key] !== value) return `Codex's ${BROKER_SERVER_NAME} MCP entry does not have the ${key} relay set`;
  }
  if (Object.hasOwn(server, "startup_readiness") && server.startup_readiness !== "connection") return `Codex's ${BROKER_SERVER_NAME} MCP entry does not have startup_readiness "connection" (or the absent default)`;
  const extra = Object.keys(server).filter((key) => !Object.hasOwn(required, key) && key !== "startup_readiness").sort();
  return extra.length ? `Codex's ${BROKER_SERVER_NAME} MCP entry has unexpected keys (${extra.join(", ")}); relay permits no other auth or tool-filter settings` : null;
}

/** What codexFlags uses for a stage-2 turn: the permissions, extra `-c` overrides, extra `--disable` switches, and the features to read back. */
export interface Stage2Plan {
  permissions: CodexPermissions;
  c: string[];
  off: string[];
  features: Record<string, boolean>;
  /** BB attaches this only when the turn has a relay context and BA opened its broker. */
  broker?: Stage2BrokerConfig;
}

/**
 * The plan for a turn's network (§2.4: `:danger-full-access`, enforcement "relay"; §2.5: features
 * off). Every feature is pinned with `-c features.<name>=false`, not `--disable`: a `--disable` of a
 * feature a Codex version does not know stops its server, and the readback decides instead.
 * Approval policy on-request (review C1) is set here for config/read and on the thread
 * (stage2ThreadParams). `net` decides nothing of Codex's: relay's profile around the executor
 * carries it (WP-A, WP-C).
 */
export function stage2Plan(_spec: TurnSpec, _net: Stage2Network): Stage2Plan {
  const off = stage2FeaturesOff(admittedVersions.get(_spec) ?? codexPinVersion(_spec.config) ?? STAGE2_MIN_CODEX);
  const features = Object.fromEntries(off.map((f) => [f, false]));
  const c = ["-c", 'approval_policy="on-request"',
    // Codex 0.164 has one key here: `agents.max_threads` is a legacy alias of
    // `agents.max_concurrent_threads_per_session` (config key_aliases.rs). It is v1's limit (default 6);
    // v2 takes `features.multi_agent_v2.max_concurrent_threads_per_session`, else this value + 1
    // (core config resolve_multi_agent_v2_config). Pinned at v1's default: at most 6 subagents either way,
    // so with the root thread at most 7 broker sessions, inside the broker's cap of 8.
    "-c", "agents.max_concurrent_threads_per_session=6",
    ...off.flatMap((f) => ["-c", `features.${f}=false`])];
  return { permissions: stage2Permissions(true), c, off: [], features };
}

/** The permissions a stage-2 turn runs with and must read back (§2.4). */
export function stage2Permissions(network: boolean): CodexPermissions {
  return { id: FULL_ACCESS, profile: null, sandbox: "danger-full-access", network, proxy: null, enforcement: "relay" };
}

/**
 * Overlaid on thread/start and thread/resume (codex-env.ts Stage2Session.threadParams): the
 * executor as the thread's only environment, at the turn's directory, and approvals always
 * on-request (review C1), whatever the turn's escalation. Codex 0.164's thread/resume takes no
 * `environments` (it ignores the key), so a resumed thread gets Codex's defaults instead: with
 * Codex's own `local` registered, every environment the server knows, `local` first; on a stage-2
 * app server, which has none (STAGE2_APP_SERVER_ENV), no environment at all (`[]`, verified on
 * 0.164.0). The turn's own binding (stage2TurnParams) then gives it relay's executor.
 */
export function stage2ThreadParams(cwd: string, environmentId: string): Record<string, unknown> {
  return { environments: [{ environmentId, cwd }], approvalPolicy: "on-request" };
}

/**
 * Overlaid on every stage-2 turn/start, fresh or resumed (codex-env.ts Stage2Session.turnParams):
 * the executor as the turn's only environment, at the turn's directory. Codex 0.164 applies
 * `turn/start.environments` to this turn and every later one of the thread (app-server-protocol
 * v2/turn.rs TurnStartParams), in the same request that carries the prompt, before the turn starts
 * (turn_processor.rs builds the thread settings, then start_or_steer_turn). A resumed thread has no
 * environment until then (`[]`: the app server has no `local`, STAGE2_APP_SERVER_ENV), so without
 * this binding its commands would fail rather than run; with Codex's own `local` registered they ran
 * there, unconfined (WP-F item 11; WP-C, 2026-10-28). Subagents a bound turn spawns, and earlier
 * turns' subagents it reaches again (followup_task, send_message; v1 resume_agent, send_input),
 * take the parent's live environments, so they are bound too (core agent/control/spawn.rs; verified
 * live, v1 and v2).
 *
 * The binding does not reach a turn Codex started by itself before relay's turn/start: turn/start
 * then steers into that turn, which keeps the environments it started with (turn_processor.rs maps
 * Started and Steered to the same reply; turn_input.rs apply_steered changes the sticky settings
 * only). That turn has no environment, since the app server has none of its own, so it cannot run a
 * command; Stage2TurnGuard fails it as well.
 */
export function stage2TurnParams(cwd: string, environmentId: string): Record<string, unknown> {
  return { environments: [{ environmentId, cwd }] };
}

/** A minimal JSON-RPC handle, as codex-app.ts passes it. */
export interface RpcLike { request(method: string, params: unknown): Promise<any> }

/** Every feature the server reports (experimentalFeature/list, every page): name to enabled. */
async function listedFeatures(rpc: RpcLike): Promise<Map<string, unknown>> {
  const listed = new Map<string, unknown>();
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const r = await rpc.request("experimentalFeature/list", { limit: 500, ...(cursor ? { cursor } : {}) });
    for (const f of (r?.data ?? []) as { name?: unknown; enabled?: unknown }[]) if (typeof f?.name === "string") listed.set(f.name, f.enabled);
    cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : null;
    if (!cursor) return listed;
  }
  throw new Error("it gave more than 50 pages");
}

/**
 * The MCP servers Codex reports (mcpServerStatus/list, every page), as Codex 0.164.0 replies:
 * `data` of `{ name, runtimeStatus, pluginId, ... }`, `nextCursor` a string or null.
 */
type McpStatus = { name?: unknown; runtimeStatus?: unknown; pluginId?: unknown; httpOrigin?: unknown; authStatus?: unknown; toolsError?: unknown; tools?: unknown };

async function listedMcpServers(rpc: RpcLike, threadId?: string): Promise<McpStatus[]> {
  const listed: McpStatus[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const r = await rpc.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly", ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(r?.data)) throw new Error("its reply has no list of servers");
    listed.push(...r.data);
    cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : null;
    if (!cursor) return listed;
  }
  throw new Error("it gave more than 50 pages");
}

/**
 * What is wrong with the MCP servers Codex lists for this app server (§2.2 step 11, §2.5), or null:
 * only the broker, when expected, and servers config/read reports as `enabled: false` (the stdio
 * `relay` entry and the person's relay-only servers), from no plugin. The broker must list exactly
 * its own tools, HTTP origin and bearer auth; a per-thread listing must also say connected.
 * Codex's catalog includes plugin and app servers absent from config/read. A threadless listing
 * reports no running state; an off server with any state other than "disabled" is refused.
 */
function mcpListProblem(listed: McpStatus[], configured: Record<string, { enabled?: unknown } | null>, broker?: { url: string; tools: readonly string[] }, thread = false): string | null {
  const on: string[] = [];
  let found = false;
  const names = new Set<string>();
  for (const s of listed) {
    if (typeof s?.name !== "string") return "Codex listed an MCP server without a name (mcpServerStatus/list), so relay cannot tell which servers it would run";
    if (names.has(s.name)) return `Codex listed the MCP server ${s.name} more than once (mcpServerStatus/list)`;
    names.add(s.name);
    if (broker && s.name === BROKER_SERVER_NAME) {
      found = true;
      if (s.pluginId != null) return `Codex lists ${BROKER_SERVER_NAME} from a plugin, not relay's broker`;
      if (s.httpOrigin !== new URL(broker.url).origin) return `Codex does not list ${BROKER_SERVER_NAME} at relay's expected httpOrigin`;
      if (s.authStatus !== "bearerToken") return `Codex does not list ${BROKER_SERVER_NAME} with bearerToken auth`;
      if (s.toolsError != null) return `Codex reports a toolsError for ${BROKER_SERVER_NAME}`;
      if (thread ? s.runtimeStatus !== "connected" : s.runtimeStatus != null && s.runtimeStatus !== "connected") return `Codex does not list ${BROKER_SERVER_NAME} as connected${thread ? " on this thread" : " (or without a threadless running state)"}`;
      const tools = s.tools;
      if (!tools || typeof tools !== "object" || Array.isArray(tools)) return `Codex did not list the tools of ${BROKER_SERVER_NAME}`;
      const entries = Object.entries(tools);
      const expected = new Set(broker.tools);
      if (entries.length !== expected.size || entries.some(([name, tool]) => !expected.has(name) || tool?.name !== name)) return `Codex lists tools for ${BROKER_SERVER_NAME} that do not match the broker's own tool names`;
      continue;
    }
    const plugin = s.pluginId != null;
    const off = configured[s.name]?.enabled === false && !plugin && (s.runtimeStatus == null || s.runtimeStatus === "disabled");
    if (!off) on.push(plugin ? `${s.name} (from the plugin ${JSON.stringify(s.pluginId)})` : s.name);
  }
  if (on.length) return `Codex lists MCP servers it would run (${on.sort().join(", ")}; mcpServerStatus/list), where a stage-2 turn runs ${broker ? `only ${BROKER_SERVER_NAME}` : "none"}: they would run outside relay's sandbox`;
  return broker && !found ? `Codex did not list relay's ${BROKER_SERVER_NAME} MCP broker (mcpServerStatus/list)` : null;
}

/** A trustworthy counter, not merely a truthy count (NaN/Infinity must not pass the evidence gate). */
function brokerSessions(broker: Stage2BrokerReadback): number {
  const n = broker.sessionsServed();
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("the broker did not report a valid authenticated session count");
  return n;
}

/** Read relay's own expected names before asking Codex to connect to any MCP server. */
async function brokerTools(broker: Stage2BrokerReadback): Promise<string[]> {
  const tools = await broker.listTools();
  if (!Array.isArray(tools) || tools.some((t) => typeof t?.name !== "string" || !t.name) || new Set(tools.map((t) => t.name)).size !== tools.length) throw new Error("the broker did not report distinct tool names");
  return tools.map((t) => t.name);
}

/**
 * After thread/start or thread/resume (§7.1). BB takes `sessionsBeforeThread` after the successful
 * threadless readback and before starting/resuming the thread. A thread connects during startup,
 * before this listing, so a delta taken at the beginning of this function would be too late.
 */
export async function stage2ThreadMcpProblem(rpc: RpcLike, eff: Record<string, any>, threadId: string, broker?: Stage2BrokerReadback, sessionsBeforeThread?: number): Promise<string | null> {
  if (!threadId) return stopped("Codex did not name the thread whose MCP connection relay must read back");
  try {
    if (broker) {
      const problem = stage2BrokerConfigProblem(eff?.mcp_servers?.[BROKER_SERVER_NAME], broker);
      if (problem) return stopped(problem);
      if (!Number.isSafeInteger(sessionsBeforeThread) || sessionsBeforeThread! < 1) return stopped("relay has no valid broker session checkpoint from before starting the thread");
    }
    const tools = broker ? await brokerTools(broker) : [];
    const problem = mcpListProblem(await listedMcpServers(rpc, threadId), eff?.mcp_servers ?? {}, broker ? { url: broker.url, tools } : undefined, true);
    if (problem) return stopped(problem);
    if (broker && brokerSessions(broker) <= sessionsBeforeThread!) return stopped("the broker recorded no authenticated, peer-verified thread session after relay's threadless listing");
    return null;
  } catch (err) {
    return stopped(`relay could not read back the thread's MCP connection (mcpServerStatus/list: ${(err as Error).message})`);
  }
}

/**
 * Before the prompt (§2.2 step 11; review r_0c11d860 C1+X2): Codex's own environment is absent
 * from this app server. `environment/status` for `local` must answer `unknown` (Codex 0.164.0:
 * `{ status: "unknown", error: "unknown environment id \`local\`" }`, as for any id the server
 * does not know; `ready` when Codex registered it). Any other answer, or an error, refuses: relay
 * cannot tell that the app server has nowhere unconfined to run a command. What is wrong, or null.
 */
export async function stage2LocalProblem(rpc: RpcLike): Promise<string | null> {
  let r: any;
  try {
    r = await rpc.request("environment/status", { environmentId: CODEX_LOCAL_ENVIRONMENT_ID });
  } catch (err) {
    return `relay could not ask Codex whether its own ${JSON.stringify(CODEX_LOCAL_ENVIRONMENT_ID)} environment exists (environment/status: ${(err as Error).message})`;
  }
  if (r?.status === "unknown") return null;
  return `Codex reports its own ${JSON.stringify(CODEX_LOCAL_ENVIRONMENT_ID)} environment as ${JSON.stringify(r?.status ?? null)} (environment/status), where relay started it with none (CODEX_EXEC_SERVER_URL=none), so a command could run there, outside relay's sandbox`;
}

/**
 * Readback after config/read (§2.2 step 11, broker design §7.1): no `local`, pinned features and
 * subagent limits, hooks/list empty, and only the expected broker may connect.
 * What is wrong, or null. `cwd`: the turn's directory, for hooks/list (else the server's own).
 * `off`: the exact version-specific off-list used by the launch plan, retained for the turn.
 *
 * - environment/status: Codex's own `local` environment absent (stage2LocalProblem);
 * - config/read: approval policy on-request; the broker's exact entry, the stdio `relay` entry off,
 *   and every other server off; subagent limits 6 (v1) and 4 including the parent (v2), so BA's
 *   session cap holds; every feature of STAGE2_FEATURES_OFF false (other values count as on);
 * - experimentalFeature/list: every feature of STAGE2_FEATURES_OFF listed and off (a Codex that does
 *   not list one is not the Codex qualified), and nothing on but STAGE2_FEATURES_ALLOWED_ON. The
 *   features are what relay can read per turn of what decides the tools; the tool list itself it
 *   cannot see (STAGE2_TOOLS), and the per-release qualification guards it;
 * - hooks/list: no hook, and no error reading them;
 * - mcpServerStatus/list, last and only when everything above reads back as relay set it: exactly
 *   the expected broker plus switched-off servers (mcpListProblem), with fresh authenticated,
 *   peer-verified evidence from BA. Codex starts every enabled server once to read its tools
 *   (collect_mcp_server_status_snapshot_with_detail); the earlier checks ensure only the broker
 *   can start. Without a broker (spec.relay null), all MCP servers must remain off.
 */
export async function stage2Readback(rpc: RpcLike, eff: Record<string, any>, cwd?: string, broker?: Stage2BrokerReadback, off: readonly string[] = STAGE2_FEATURES_OFF): Promise<string | null> {
  const wrong: string[] = [];
  const local = await stage2LocalProblem(rpc);
  if (local) wrong.push(local);
  if (eff?.approval_policy !== "on-request") wrong.push(`approval_policy is ${JSON.stringify(eff?.approval_policy ?? null)} where relay set "on-request"`);
  const servers = (eff?.mcp_servers ?? {}) as Record<string, { enabled?: unknown } | null>;
  const on = Object.entries(servers).filter(([name, s]) => !(broker && name === BROKER_SERVER_NAME) && s?.enabled !== false).map(([name]) => name);
  if (on.length) wrong.push(`MCP servers are on (${on.join(", ")}), where a stage-2 turn runs ${broker ? `only ${BROKER_SERVER_NAME}` : "none"}`);
  if (broker) {
    if (servers.relay?.enabled !== false) wrong.push("Codex does not report the stdio relay MCP entry switched off");
    const problem = stage2BrokerConfigProblem(servers[BROKER_SERVER_NAME], broker);
    if (problem) wrong.push(problem);
  }
  for (const [key, value] of [["max_concurrent_threads_per_session", 6]] as const) {
    if (eff?.agents?.[key] !== value) wrong.push(`agents.${key} is not ${value} where relay pinned it`);
  }
  const set = (eff?.features ?? {}) as Record<string, unknown>;
  const notOff = off.filter((f) => set[f] !== false);
  if (notOff.length) wrong.push(`the features ${notOff.map((f) => `${f} (${JSON.stringify(set[f] ?? null)})`).join(", ")} are not false where relay set them false`);
  let listed: Map<string, unknown> | null = null;
  try {
    listed = await listedFeatures(rpc);
  } catch (err) {
    wrong.push(`relay could not read the features Codex runs with (experimentalFeature/list: ${(err as Error).message})`);
  }
  if (listed) {
    const unlisted = off.filter((f) => !listed!.has(f));
    if (unlisted.length) wrong.push(`Codex does not list the features ${unlisted.join(", ")}, so it is not a Codex relay has qualified for stage 2`);
    const on = off.filter((f) => listed!.has(f) && listed!.get(f) !== false);
    if (on.length) wrong.push(`Codex reports ${on.join(", ")} on where relay set ${on.length > 1 ? "them" : "it"} off`);
    const unqualified = [...listed].filter(([f, v]) => v !== false && !STAGE2_FEATURES_ALLOWED_ON.includes(f) && !off.includes(f)).map(([f]) => f).sort();
    if (unqualified.length) wrong.push(`Codex reports features on that relay has not qualified for stage 2 (${unqualified.join(", ")}): they may give the agent tools or actions of the app server's own, outside relay's sandbox`);
  }
  try {
    const r = await rpc.request("hooks/list", cwd ? { cwds: [cwd] } : {});
    const entries = Array.isArray(r?.data) ? r.data as { hooks?: unknown; errors?: unknown }[] : null;
    if (!entries) wrong.push("Codex did not say which hooks it would run (hooks/list)");
    else {
      const hooks = entries.flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : e?.hooks == null ? [] : [e.hooks]));
      if (hooks.length) wrong.push(`Codex would run ${hooks.length} hook${hooks.length > 1 ? "s" : ""} (hooks/list), outside relay's sandbox`);
      if (entries.some((e) => (Array.isArray(e?.errors) ? e.errors.length > 0 : e?.errors != null))) wrong.push("Codex reported errors reading its hooks, so relay cannot tell that none would run");
    }
  } catch (err) {
    wrong.push(`relay could not read the hooks Codex would run (hooks/list: ${(err as Error).message})`);
  }
  if (!wrong.length) {
    try {
      const tools = broker ? await brokerTools(broker) : [];
      const before = broker ? brokerSessions(broker) : 0;
      const problem = mcpListProblem(await listedMcpServers(rpc), servers, broker ? { url: broker.url, tools } : undefined);
      if (problem) wrong.push(problem);
      if (broker && brokerSessions(broker) <= before) wrong.push("the broker recorded no new authenticated, peer-verified session during that MCP listing");
    } catch (err) {
      wrong.push(`relay could not read the MCP servers Codex would run (mcpServerStatus/list: ${(err as Error).message})`);
    }
  }
  return wrong.length ? `relay will not start a Codex agent under stage 2, because Codex's settings for it are not what relay set: ${wrong.join("; ")}.` : null;
}

/** Whether `a` names the turn's directory. */
const same = (a: unknown, cwd: string) => typeof a === "string" && canonical(a) === canonical(cwd);

/** Codex's own environment (exec-server environment.rs LOCAL_ENVIRONMENT_ID): commands there run in the app server's process tree, unconfined. A stage-2 app server has none (STAGE2_APP_SERVER_ENV). */
export const CODEX_LOCAL_ENVIRONMENT_ID = "local";

type EnvironmentEntry = { environmentId?: unknown; cwd?: unknown; runtimeWorkspaceRoots?: unknown };

/**
 * What is wrong with a thread's environments, as a phrase after "its thread", or null. Exactly
 * relay's executor at `cwd` with the workspace roots `[cwd]`; or, for a thread/resume reply
 * (`resumed`), that or no environment at all (`[]`: Codex 0.164's thread/resume takes no
 * environments, and the app server has none of its own to default to). Never `local` or any other
 * environment, on a fresh thread or a resumed one (review r_0c11d860 C1+X2): the app server was
 * started without `local`, and one showing it is not the server relay set up.
 */
function environmentsProblem(envs: unknown, cwd: string, environmentId: string, resumed: boolean): string | null {
  const only = `only its executor (${JSON.stringify(environmentId)})`;
  if (resumed && Array.isArray(envs) && envs.length === 0) return null;
  if (!Array.isArray(envs) || envs.length !== 1) {
    return `reports the environments ${JSON.stringify(envs ?? null)}${resumed ? " after thread/resume" : ""} where relay set ${only}${resumed ? " or none" : ""}, so its commands could run elsewhere`;
  }
  const e = (envs as EnvironmentEntry[])[0];
  if (e?.environmentId !== environmentId) return `runs in the environment ${JSON.stringify(e?.environmentId ?? null)}, not relay's executor (${JSON.stringify(environmentId)})`;
  if (!same(e.cwd, cwd)) return `runs in its environment at ${JSON.stringify(e.cwd ?? null)}, not at ${JSON.stringify(cwd)}`;
  const roots = e.runtimeWorkspaceRoots;
  if (!Array.isArray(roots) || roots.length !== 1 || !same(roots[0], cwd)) return `reports its environment's workspace roots as ${JSON.stringify(roots ?? null)} where relay set only ${JSON.stringify(cwd)}`;
  return null;
}

/**
 * The thread's reply (§2.2 step 11): profile, sandbox kind, environments. What is wrong, or null.
 * Shape as Codex 0.164.0 replies to thread/start and thread/resume: approvalPolicy,
 * activePermissionProfile, sandbox and runtimeWorkspaceRoots at the top, the environments on
 * `thread` (each with its cwd and runtimeWorkspaceRoots). A thread/start reply must show exactly
 * relay's executor. A thread/resume reply (`resumed`) shows relay's executor or, as Codex 0.164
 * replies, nothing (environmentsProblem), since thread/resume takes no environments and the app
 * server has no `local` to default to; with nothing, it reports no workspace roots either. The turn's
 * binding then gives it relay's executor (stage2TurnParams), read back after turn/start
 * (stage2TurnReadback). `local` is refused on both. The workspace roots are checked here, not by
 * threadPermissionsProblem (codex-app.ts), which leaves a relay-enforced thread's to this check.
 */
export function stage2ThreadProblem(t: unknown, cwd: string, environmentId: string, o: { resumed?: boolean } = {}): string | null {
  const refuse = (why: string) => `relay will not start a Codex agent under stage 2, because its thread ${why}.`;
  const r = (t ?? {}) as { approvalPolicy?: unknown; activePermissionProfile?: { id?: unknown } | null; sandbox?: { type?: unknown } | null; runtimeWorkspaceRoots?: unknown; thread?: { environments?: unknown } | null };
  if (r.approvalPolicy !== "on-request") return refuse(`reports the approval policy ${JSON.stringify(r.approvalPolicy ?? null)} where relay set "on-request", so the app server could approve its own actions`);
  if (r.activePermissionProfile?.id !== FULL_ACCESS) return refuse(`runs with the permission profile ${JSON.stringify(r.activePermissionProfile?.id ?? null)} where relay set ${JSON.stringify(FULL_ACCESS)}`);
  if (r.sandbox?.type !== "dangerFullAccess") return refuse(`reports a ${JSON.stringify(r.sandbox?.type ?? null)} sandbox where relay set "dangerFullAccess"`);
  const wrong = environmentsProblem(r.thread?.environments, cwd, environmentId, Boolean(o.resumed));
  if (wrong) return refuse(wrong);
  // Codex reports the primary environment's workspace roots as the thread's (core session.rs
  // primary_workspace_roots_for), whatever runtimeWorkspaceRoots asked: a resumed thread with no
  // environment reports none (seen on 0.164.0 without `local`), and relay's binding then gives it its
  // executor with the roots [cwd], read back after turn/start (stage2TurnReadback).
  const roots = r.runtimeWorkspaceRoots;
  const unbound = Boolean(o.resumed) && Array.isArray(r.thread?.environments) && (r.thread!.environments as unknown[]).length === 0;
  if (unbound && Array.isArray(roots) && roots.length === 0) return null;
  if (!Array.isArray(roots) || roots.length !== 1 || !same(roots[0], cwd)) return refuse(`reports the workspace roots ${JSON.stringify(roots ?? null)} where relay set only ${JSON.stringify(cwd)}`);
  return null;
}

/**
 * Before thread/resume of a stage-2 session: no message waits in the session's Codex queue. Codex
 * starts a queued message by itself as soon as thread/resume leaves the thread idle (ext/queue
 * on_thread_idle), before relay's turn/start can bind that turn to the executor. With Codex's own
 * `local` registered it ran with `[local, relay]`, its command in `local` (WP-C, 2026-10-28, on
 * 0.164.0, a message queued through thread/queue/add on the stored thread). On a stage-2 app
 * server, which has no `local` (STAGE2_APP_SERVER_ENV), such a turn has no environment and cannot
 * run a command; this check, which a message queued after it passes cannot satisfy anyway, stays as
 * defence in depth, with Stage2TurnGuard. Only a client of the person's CODEX_HOME can queue (relay
 * never does; the executor cannot reach CODEX_HOME, D8). What is wrong, or null; an unreadable
 * queue refuses.
 */
export async function stage2QueueProblem(rpc: RpcLike, threadId: string): Promise<string | null> {
  const refuse = (why: string) => `relay will not resume this Codex session under stage 2, because ${why}.`;
  let r: any;
  try {
    r = await rpc.request("thread/queue/list", { threadId, limit: 1 });
  } catch (err) {
    return refuse(`it could not read the session's queued messages (thread/queue/list: ${(err as Error).message}), and Codex would start one by itself on resume, before relay can bind that turn to its sandboxed executor`);
  }
  if (!Array.isArray(r?.data)) return refuse("Codex did not say whether the session has queued messages (thread/queue/list), and it would start one by itself on resume, before relay can bind that turn to its sandboxed executor");
  if (r.data.length) return refuse("a message is queued for the session in Codex (put there by another Codex client), and Codex would start it by itself on resume, before relay can bind that turn to its sandboxed executor; send or remove it from that client, then resume again");
  return null;
}

/** A stage-2 turn relay stops after the prompt went in: the app server is killed, the turn fails. */
const stopped = (why: string) => `relay stopped the Codex agent under stage 2 and failed the turn, because ${why}.`;

/**
 * thread/read's refusal while a new thread's rollout has no session metadata yet: Codex creates the
 * rollout file at once and writes its first line only after collecting the git information of a git
 * cwd (rollout recorder.rs write_session_meta, git-utils collect_git_info: up to two git commands
 * with a 5 s timeout each), and thread/read of a loaded thread reads that line first (thread_processor.rs
 * read_thread_view, load_persisted_thread_for_read). Measured on 0.164.0: about 20 ms after
 * turn/start's reply in a small repository; never in a plain directory, where no rollout exists
 * yet and the live thread is read instead.
 */
const ROLLOUT_NOT_YET_WRITTEN = /failed to read session metadata .*: rollout at .* is empty/;

/** How long stage2TurnReadback retries that refusal, at most: Codex's own worst case for the git information (two 5 s timeouts). */
export const TURN_READBACK_DEADLINE_MS = 10_000;
const TURN_READBACK_RETRY_MS = 25;

/**
 * After a stage-2 turn/start: the thread's environments, read back (thread/read reports the live
 * thread's, apply_live_thread_settings), must be exactly relay's executor at `cwd`. What is wrong,
 * or null; the caller kills the app server and fails the turn.
 *
 * thread/read is retried only on the refusal of a rollout not written yet
 * (ROLLOUT_NOT_YET_WRITTEN), every TURN_READBACK_RETRY_MS, until `deadlineMs` after the first try;
 * any other error, or the deadline passing, refuses. relay asks for no other read: the
 * environments are on no notification (turn/started's Turn and thread/settings/updated's
 * ThreadSettings carry none), and thread/loaded/list gives ids only.
 *
 * What this proves and what it does not. The binding travels in the same request as the prompt,
 * and Codex applies it before starting the turn (stage2TurnParams), so there is no window between
 * binding and prompt. The readback, once it succeeds, proves that the live thread is bound to relay's
 * executor alone after the prompt went in. It runs after turn/start's reply, while the model may
 * already be answering: it catches a Codex that ignored or reverted `turn/start.environments`, but
 * only after the fact. Were that so on a resumed thread, the turn would have no environment (the
 * app server has no `local`, STAGE2_APP_SERVER_ENV), so its commands would fail, not run elsewhere;
 * the per-release qualification still checks the binding (codex-stage2.mjs item 11, resumed and
 * bound). Nor does it see the environments of a turn Codex started by itself, into which turn/start
 * steered: thread/read reports the thread's sticky settings, which turn/start changed, not that
 * turn's (Stage2TurnGuard fails such a turn; it has no environment either). The retries add no
 * window of their own: a resumed thread's rollout is already written, so they happen only on a fresh
 * thread, whose thread/start reply has already shown relay's executor alone.
 */
export async function stage2TurnReadback(rpc: RpcLike, threadId: string, cwd: string, environmentId: string, o: { deadlineMs?: number; retryMs?: number } = {}): Promise<string | null> {
  const refuse = stopped;
  const until = Date.now() + (o.deadlineMs ?? TURN_READBACK_DEADLINE_MS);
  let r: any;
  for (;;) {
    try {
      r = await rpc.request("thread/read", { threadId, includeTurns: false });
      break;
    } catch (err) {
      const message = (err as Error).message;
      if (!ROLLOUT_NOT_YET_WRITTEN.test(message)) return refuse(`it could not read back the environments of the turn it had bound to its sandboxed executor (thread/read: ${message})`);
      if (Date.now() >= until) return refuse(`it could not read back the environments of the turn it had bound to its sandboxed executor within ${Math.round((o.deadlineMs ?? TURN_READBACK_DEADLINE_MS) / 1000)} s: Codex had not yet written the thread's session (thread/read: ${message})`);
      await new Promise((res) => setTimeout(res, o.retryMs ?? TURN_READBACK_RETRY_MS));
    }
  }
  const wrong = environmentsProblem(r?.thread?.environments, cwd, environmentId, false);
  return wrong ? refuse(`after relay bound the turn to its sandboxed executor, the thread ${wrong}`) : null;
}

/**
 * The turns Codex starts during a stage-2 turn (WP-C). relay binds only the turn it asks for
 * (stage2TurnParams). A turn Codex starts by itself is not bound: a goal continuation or a queued or
 * mailbox message on resume (goals pinned off, stage2QueueProblem before resume), or whatever a later
 * Codex adds. It cannot run a command, since the app server has no environment of its own
 * (STAGE2_APP_SERVER_ENV) and a resumed thread none until relay binds it; with Codex's `local` it ran
 * there (review r_0c11d860 C1+X2). Defence in depth: any turn that starts before relay asks for its
 * own, and any second turn on the session's thread beside relay's, fails the turn;
 * startCodexAppTurn kills the app server first. Subagents' turns (other threads) after relay's
 * request are expected: they take the bound turn's environments.
 *
 * This sees `turn/started`, which Codex sends as the turn begins and before it asks the model, and
 * relay kills the server at once. It is not what keeps such a turn's commands in relay's sandbox
 * (there is nowhere else for them to run); it keeps relay from reporting another turn's work as its own.
 */
export class Stage2TurnGuard {
  #requested = false;
  #own: string | null = null;
  #seen: string | null = null;

  /** relay is about to send its turn/start. */
  request(): void {
    this.#requested = true;
  }

  /** A turn/started notification: the thread it names, the session's thread, the turn's id. What is wrong, or null. */
  started(thread: unknown, sessionThread: string | undefined, turn: unknown): string | null {
    const id = typeof turn === "string" ? turn : null;
    if (!this.#requested) return stopped(`Codex started a turn by itself (${JSON.stringify(id)}) before relay had delivered the prompt and bound the turn to its sandboxed executor`);
    if (typeof thread === "string" && thread !== sessionThread) return null;
    const ours = this.#own ?? this.#seen;
    if (ours !== null && id !== ours) return stopped(`Codex started a second turn (${JSON.stringify(id)}) on the session's thread beside relay's (${JSON.stringify(ours)}), which relay did not bind to its sandboxed executor`);
    this.#seen ??= id;
    return null;
  }

  /** turn/start's reply. What is wrong, or null. */
  replied(turn: unknown): string | null {
    const id = typeof turn === "string" && turn ? turn : null;
    if (!id) return stopped("Codex did not say which turn it started for relay's prompt");
    this.#own = id;
    if (this.#seen !== null && this.#seen !== id) return stopped(`relay's prompt went into turn ${JSON.stringify(id)} while Codex had started turn ${JSON.stringify(this.#seen)} on the session's thread`);
    return null;
  }
}

/**
 * Before relay shows a stage-2 command approval (review R4): Codex names the environment the
 * command will run in (CommandExecutionRequestApprovalParams.environmentId, app-server-protocol
 * v2/item.rs; set for unified exec, write_stdin and network approvals, core tools/approvals.rs).
 * Only relay's executor is acceptable: a command bound anywhere else, or with no environment named,
 * is declined and fails the turn. What is wrong, or null. File-change approvals name no environment
 * (FileChangeRequestApprovalParams), so there is nothing to check here; stage2ApprovalDetail leaves
 * them unmarked.
 */
export function stage2CommandEnvironmentProblem(environmentId: unknown, expected: string): string | null {
  if (environmentId === expected) return null;
  return stopped(`Codex asked to approve a command in the environment ${JSON.stringify(environmentId ?? null)}, not relay's sandboxed executor (${JSON.stringify(expected)}); relay declined it`);
}

/**
 * The detail added to a stage-2 approval (§2.4, C9). A command approval is marked confined: relay
 * shows it only once stage2CommandEnvironmentProblem has found it bound to the executor. A
 * file-change approval is left unmarked: Codex names no environment for it, and neither its item
 * (ThreadItem::FileChange) nor the request carries one relay could check, so it keeps the
 * outside-the-sandbox wording (review R4), although with the turn bound to the executor alone
 * (stage2TurnReadback) its apply_patch runs there. Any other kind (an MCP tool, an extension, a
 * hosted tool) keeps its normal accounting (core/approvals.ts) and is an error here.
 */
export function stage2ApprovalDetail(kind: "command" | "file"): Record<string, unknown> {
  if (kind !== "command" && kind !== "file") throw new Error(`relay does not mark a ${JSON.stringify(kind)} approval as inside its sandbox`);
  return kind === "command" ? { confined: true } : {};
}

/** Records a turn's enforcement in the session's params (CONFINEMENT_PARAM), for status, brief and the approval view. */
export function recordEnforcement(nodeId: string, turnId: number, enforcement: "codex" | "relay"): void {
  if (enforcement !== "codex" && enforcement !== "relay") throw new Error(`not an enforcement: ${JSON.stringify(enforcement)}`);
  setParam(nodeId, CONFINEMENT_PARAM, { turn: turnId, enforcement });
}

/**
 * The per-turn asset directory for relay's skill package, readable by commands and outside every
 * writable root (§2.3, C8). Null when the turn has no package. The package relay built is in its
 * control directory, which relay's profile denies; this copy (directories and regular files only)
 * goes to a fresh `relay-ext-*` under relay's private root (~/.relay-t, mode 0700), which no grant
 * may cover and the profile does not make writable. The caller removes it when the turn ends.
 * Returns the copy's root, laid out as the package (`skills/<name>/…`).
 */
export function stage2SkillAssets(spec: Pick<TurnSpec, "skills">): string | null {
  if (!spec.skills) return null;
  const from = path.join(spec.skills.dir, "skills");
  const root = privateTurnTemp(ensurePrivateRoot(privateStateRoot()), "relay-ext-");
  try {
    const copy = (src: string, dst: string) => {
      fs.mkdirSync(dst, { mode: 0o700 });
      for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, ent.name), d = path.join(dst, ent.name);
        if (ent.isDirectory()) copy(s, d);
        else if (ent.isFile()) fs.copyFileSync(s, d, fs.constants.COPYFILE_EXCL);
        else throw new Error(`${s} is neither a directory nor a regular file`);
      }
    };
    copy(from, path.join(root, "skills"));
    for (const name of spec.skills.names) {
      if (!fs.lstatSync(path.join(root, "skills", name, "SKILL.md")).isFile()) throw new Error(`the skill ${name} has no SKILL.md`);
    }
    return root;
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`relay could not copy the turn's skills where its commands can read them: ${(err as Error).message}`);
  }
}
