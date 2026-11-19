import { openaiRefusal } from "../core/refusal.js";
import { assertNeverAdapter } from "./never-admission.js";
import { codexSignIn, freezeCodexConfig, prepareCodexHome } from "./codex-pin.js";
import { relayCodexProtected } from "../core/protected-config.js";
import { neverGrantProblem, neverProfileInputs, resolveNeverPolicy } from "../core/never-policy.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeTemp } from "./native-temp.js";
import { codexVersion, daybreakCatalog, daybreakDecision, skipDaybreak } from "./codex-daybreak.js";
import { authFor, canonical, RELAY_CLI, relayCodexHome, type Mode, type RelayConfig } from "../core/config.js";
import { spawnFound } from "../core/executables.js";
import { codexSkillFiles } from "../core/extensions.js";
import { targetDef } from "../targets/index.js";
import { archiveCodexThread, CODEX_PROFILE, codexNetworkPreflight, codexPreflight, declinedItem, startCodexAppTurn, type CodexNetwork, type CodexPermissions, type CodexProfileNetwork, type Expected } from "./codex-app.js";
import { NETWORK_MODE_TEXT, type CodexNetworkMode } from "./codex-network.js";
import { MEDIATED_NETWORK_EFFECT, mediatedBaseline } from "../core/mediated-network-provider.js";
import { openStage2 } from "./codex-env.js";
import { stage2Wanted, type Stage2Plan } from "./codex-stage2.js";
import { localModeInterlock, localModeRetired, RAW_NETWORK_TURN_NOTE } from "../core/raw-network.js";
import { HARNESS_CONFIG } from "../confine/seatbelt.js";
import { BROKER_SERVER_NAME, BROKER_TOKEN_ENV } from "../confine/broker-names.js";
import { agentEnv, releasedIn } from "./env.js";
import { CODEX_MCP_ENV_VARS, codexToolTimeoutS, codexWriteRootProblem } from "../targets/codex.js";
import { afterTurn, streamTurn } from "./stream.js";
import { CodexSubagents } from "./codex-subagents.js";
import { activityOf, usageFrom, relayServerCommand, turnPolicy, type Backend, type Invocation, type StreamState, type TurnHandle, type TurnResult, type TurnSpec } from "./types.js";

const scrub = () => false;

/**
 * A string, or an array of strings, as a TOML value for a `-c` override. A TOML basic string takes
 * the escapes JSON.stringify writes, but differs from a JSON string in two places: it may not hold
 * DEL (U+007F) as it is, which JSON leaves unescaped, so it is escaped here; and it is UTF-8, so a
 * lone UTF-16 surrogate, which JSON writes as a \uD8xx escape, is no Unicode scalar value TOML can
 * hold in any form. Such a value is refused: Codex would refuse the whole override, with an error
 * about TOML that names nothing relay set. (A granted directory never holds one: relay takes its
 * name from the disk, which gives none.)
 */
export function toml(v: string | string[]): string {
  for (const s of typeof v === "string" ? [v] : v) {
    if (/\p{Cs}/u.test(s)) throw new Error(`relay cannot give Codex ${JSON.stringify(s)}: it holds a lone UTF-16 surrogate, which no TOML string can hold, so relay does not start the agent.`);
  }
  return JSON.stringify(v).replaceAll("\x7f", "\\u007f");
}

/**
 * Codex. Every turn normally runs through `codex app-server` (see codex-app.ts), which is where
 * approval requests arrive and where the effective configuration can be checked before anything
 * runs. `codex exec` is kept as a configured fallback (`codex_backend: "exec"`): one process per
 * turn, prompt on stdin, `codex exec resume <thread_id>` for continuity, and no approval requests.
 */
/**
 * What a Codex turn's preparation settled: the user's MCP servers to switch off for the agent
 * (relay-only), the agent's environment, and the released names it carries (names only).
 */
interface CodexPrep { servers: string[]; env: NodeJS.ProcessEnv; released: readonly string[] }

const codex = {
  prepare(spec: TurnSpec, tmpDir: string): CodexPrep {
    // The agent's environment, built and checked first (review C6): its endpoint is refused before Codex is asked anything.
    const env = agentEnv(spec, scrub);
    env.CODEX_HOME = prepareCodexHome(spec.config);
    const released = releasedIn(env);
    env.TMPDIR = tmpDir;
    spec.checkEnvironment?.(env);
    if (spec.config.child_mcp !== "relay-only") return { servers: [], env, released };
    // Names of the MCP servers defined in the user's config, so they can be switched off for the
    // child. Plugin-provided servers are excluded here: a -c override cannot disable those (it
    // would create a second, broken entry), so they are dropped with `--disable plugins` instead.
    const r = spawnFound(spec.config.targets.codex.bin, ["--disable", "plugins", "mcp", "list", "--json"], { encoding: "utf8", timeout: 20000, env }, env.PATH ?? "");
    // The agent is not launched unless its other MCP servers can be named and switched off:
    // they run outside its sandbox, with whatever access the user gave them.
    const refuse = (why: string) => new Error(`relay could not list Codex's MCP servers (${why}), so it cannot switch them off for a launched agent and will not start one.`);
    if (r.error) throw refuse(r.error.message);
    if (r.status !== 0) throw refuse(`codex mcp list exited with ${r.status}: ${(r.stderr ?? "").trim().split("\n").pop() ?? ""}`);
    let list: unknown;
    try {
      list = JSON.parse(r.stdout);
    } catch {
      throw refuse("its output was not JSON");
    }
    if (!Array.isArray(list) || list.some((s) => !s || typeof (s as { name?: unknown }).name !== "string")) throw refuse("its output was not a list of named servers");
    return { servers: (list as { name: string; enabled?: boolean }[]).filter((s) => s.enabled !== false).map((s) => s.name), env, released };
  },

  /** `model`: the model the preflight checked a faster speed against where the turn names none (a continued thread's own). */
  invocation(spec: TurnSpec, prepared: CodexPrep, flags: CodexFlags, model?: string): Invocation {
    const cfg = spec.config;
    const off = flags.off;
    const c = [...flags.c];
    if (spec.model ?? model) c.push("-m", (spec.model ?? model)!);
    if (spec.effort) c.push("-c", `model_reasoning_effort=${toml(spec.effort)}`);
    const common = ["--json", "--skip-git-repo-check", ...off, ...c];
    const args = spec.sessionId ? ["exec", "resume", ...common, spec.sessionId, "-"] : ["exec", ...common, "-"];
    return { command: cfg.targets.codex.bin, args, env: prepared.env };
  },

  /**
   * The `codex exec` fallback's check, first, through a short-lived app server: the fallback cannot
   * ask the server it is about to use. If that cannot be done, the agent is not started. Run in the
   * worker itself, with the agent's environment, so that a stop can end it (spec.signal).
   */
  async preflight(spec: TurnSpec, flags: CodexFlags, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    let checked: string | undefined;
    const problem = await codexPreflight({
      bin: spec.config.targets.codex.bin, args: ["app-server", ...flags.off, ...flags.c], cwd: spec.cwd, env, expect: flags.expect, sessionId: spec.sessionId, model: spec.model, signal: spec.signal, onWaived: spec.onWaived,
      onModel: (m) => (checked = m),
      onDaybreakSkipped: (note) => skipDaybreak(flags, spec.onNote, note),
      released: flags.released, onShellPolicyNote: (note) => spec.onNote?.(note),
    });
    if (problem) throw new Error(problem.trim());
    return checked;
  },

  /** Archives a durable thread once the turn's processes have stopped: ephemeral threads cannot survive relay's per-turn processes, and a fresh server also handles crashes and the exec fallback. */
  async finish(spec: TurnSpec, flags: CodexFlags, env: NodeJS.ProcessEnv, result: TurnResult): Promise<TurnResult> {
    const threadId = result.sessionId ?? spec.sessionId;
    if (!threadId) return result;
    // The turn's app server and broker have already stopped. The separate archive client must
    // neither reconnect to the released port nor inherit a dead turn's credential (§6).
    const archiveEnv = flags.expect.broker ? { ...env } : env;
    if (flags.expect.broker) delete archiveEnv[BROKER_TOKEN_ENV];
    const archiveFlags = flags.expect.broker ? [...flags.c, "-c", `mcp_servers.${BROKER_SERVER_NAME}.enabled=false`] : flags.c;
    const warning = await archiveCodexThread({
      bin: spec.config.targets.codex.bin, args: ["app-server", ...flags.off, ...archiveFlags],
      cwd: spec.cwd, env: archiveEnv, threadId,
    });
    return warning ? { ...result, warnings: [...(result.warnings ?? []), warning] } : result;
  },

  onEvent(event: Record<string, unknown>, state: StreamState, spec: TurnSpec): void {
    const item = event.item as { type?: string; text?: string } | undefined;
    if (!state.ended && ["item.started", "item.updated", "item.completed"].includes(String(event.type)) && item?.type === "collab_tool_call") {
      const subagents = state.codexSubagents ??= new CodexSubagents();
      subagents.collab(item, state.sessionId);
      const warning = subagents.warning();
      state.warnings = warning ? [warning] : [];
    }
    switch (event.type) {
      case "item.started": {
        const text = item?.type ? activityOf(item.type, item as Record<string, unknown>) : null;
        if (text) spec.onActivity?.(text);
        break;
      }
      case "thread.started":
        if (typeof event.thread_id === "string") state.sessionId = event.thread_id;
        break;
      case "item.completed": {
        // The final answer is the last agent_message. Items of type "error" are warnings, not failure.
        if (item?.type === "agent_message" && typeof item.text === "string") state.finalMessage = item.text;
        const refused = declinedItem(event.item);
        if (refused) state.denials = [...(state.denials ?? []), refused];
        break;
      }
      case "turn.completed": {
        const usage = usageFrom(event.usage);
        if (usage) spec.onUsage?.(usage);
        // An earlier "error" event can be a retried, non-fatal one; a completed turn supersedes it.
        state.completed = true;
        state.failed = undefined;
        state.ended = true;
        break;
      }
      case "turn.failed":
        state.refusal ??= openaiRefusal(event.error);
        state.failed = `codex turn failed: ${(event.error as { message?: string } | undefined)?.message ?? "unknown error"}`;
        state.ended = true;
        break;
      case "error":
        state.refusal ??= openaiRefusal({ message: event.message });
        state.failed = `codex error: ${String(event.message ?? "unknown error")}`;
        break;
    }
  },
};
export const codexBackend: Backend = {
  start: async (spec) => nativeTemp(spec, async (tmpDir) => {
    assertNeverAdapter(spec);
    spec = { ...spec, config: freezeCodexConfig(spec.config) };
    // Relay's config refuses this combination; a run's stored config is checked again here.
    if ((spec.skills || spec.extensionServers?.length) && spec.config.codex_backend === "exec") {
      throw new Error('extensions for Codex need codex_backend "app-server": codex exec has no way for relay to give skills or to check which skills it loads, so relay does not start the agent.');
    }
    const prepared = codex.prepare(spec, tmpDir);
    if (spec.overlay && !stage2Wanted(spec)) throw new Error("capability_unavailable: a consumed overlay requires the qualified stage2 executor; no baseline fallback");
    // Stage 2 (docs/codex-confinement-design.md): the executor in relay's Seatbelt. Never taken with the switch off.
    const stage2 = stage2Wanted(spec) ? await openStage2(spec, prepared, tmpDir) : undefined;
    try {
      const chosen = stage2 ? undefined : await chooseNetwork(spec, prepared, tmpDir);
      const flags = codexFlags(spec, prepared.servers, prepared.env, prepared.released, chosen?.net, stage2?.plan);
      if (flags.note) spec.onNote?.(flags.note);
      if (chosen) spec.onNote?.(chosen.note);
      // What the shell's network is this turn, in front of the turn's input: the preamble said only
      // that the job has network.
      // A stage-2 turn skips chooseNetwork, so its own note (raw network, PORT/PORTS, binding limited
      // to the block, git writes fail and relay commits) goes in front instead.
      const prefix = chosen?.prefix ?? (stage2 ? stage2InputPrefix(spec) : undefined);
      const turn: TurnSpec = prefix ? { ...spec, prompt: `${prefix}\n\n${spec.prompt}` } : spec;
      // A stage-2 app server gets exactly the environment its admission checked, with relay's own
      // CODEX_EXEC_SERVER_URL=none over it (Stage2Session.env): Codex then has no `local` environment.
      const env = stage2 ? (stage2.session.env as NodeJS.ProcessEnv) : prepared.env;
      let handle: TurnHandle;
      if (spec.config.codex_backend !== "exec") {
        turnPolicy(spec); // Last check after config/skill discovery, immediately before spawn.
        handle = startCodexAppTurn(turn, flags, env, stage2?.session);
      }
      else {
        const checked = await codex.preflight(spec, flags, env);
        turnPolicy(spec); // Recheck grant identities after the asynchronous preflight.
        handle = streamTurn(turn, { invocation: codex.invocation(turn, prepared, flags, checked), onEvent: codex.onEvent });
      }
      return afterTurn(handle, (result) => codex.finish(spec, flags, env, result));
    } catch (err) {
      // Before startCodexAppTurn owns the executor, a failure stops it here.
      await stage2?.abort((err as Error).message);
      throw err;
    }
  }),
};

/**
 * What doctor says about a new Codex job started in `cwd` with no grants, by the checks that job's
 * turn makes before it starts: the never floor a new run captures (resolveNeverPolicy, as
 * checkpointNever does for a run's first launch) and its admission (assertNeverAdapter,
 * neverGrantProblem), the turn's own preparation (codex.prepare: the agent's environment, relay's
 * Codex home and the config.toml relay writes there each turn, the user MCP servers it switches
 * off), its flags (codexFlags), and the effective-configuration check (codexPreflight), in which a
 * short-lived app server reports every layer merged: system, managed, this directory's project
 * layers, relay's Codex home and relay's flags. The job is the configured default: its default
 * model, effort and speed, and relay's own MCP server, which a job that may delegate is given. That
 * server's command is an inert one of the real shape (relayServerCommand reads the run's registry,
 * which doctor must not open); the app server is asked only for its configuration, so it never
 * starts. No thread is started and no model is asked.
 *
 * - `problem`: why relay would refuse the job, or null.
 * - `unchecked`: why the check could not be made here (relay's Codex home could not be prepared,
 *   say, as inside a launched agent whose sandbox denies it), which says nothing of a real turn.
 * - `note`: what Codex's shell_environment_policy does with the names relay releases, when the turn would say so.
 * - `released`: those names.
 * - `stage2`: the job would run under stage 2 instead, which this does not judge (doctor's "codex stage 2" line does).
 * - `account`: how the app server says relay's Codex home is signed in (account/read's account type,
 *   null for no account), read before any check; absent when it was not asked or did not say.
 */
export async function codexLaunchCheck(cfg: RelayConfig, cwd: string, access: Mode): Promise<{ problem: string | null; unchecked: string | null; note: string | null; released: readonly string[]; stage2: boolean; account?: string | null }> {
  const none = { problem: null, unchecked: null, note: null, released: [] as readonly string[], stage2: false };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-doctor-codex-"));
  try {
    const config = freezeCodexConfig(cfg);
    const t = config.targets.codex;
    const spec: TurnSpec = {
      target: targetDef("codex"), prompt: "", cwd, access, config,
      relay: { runId: "doctor", nodeId: "doctor", depth: 1, contextFile: path.join(tmp, "context.json"), mayDelegate: true, mayAsk: false },
      ...(t.default_model ? { model: t.default_model } : {}), ...(t.default_effort ? { effort: t.default_effort } : {}), ...(t.speed ? { speed: t.speed } : {}),
      neverPolicy: resolveNeverPolicy({ never: config.never, codexHome: (t as { home?: string }).home }),
      dir: tmp, logPath: path.join(tmp, "log"), markers: { runId: "doctor", nodeId: "doctor", depth: 1 },
    };
    if (stage2Wanted(spec)) return { ...none, stage2: true };
    try { prepareCodexHome(config); }
    catch (err) { return { ...none, unchecked: `relay could not prepare its Codex home here (${(err as Error).message})` }; }
    const inert = (ctx: NonNullable<TurnSpec["relay"]>) => ({
      command: "/usr/bin/env", args: ["-i", `RELAY_RUN_ID=${ctx.runId}`, `RELAY_NODE_ID=${ctx.nodeId}`, `RELAY_DEPTH=${ctx.depth}`, "RELAY_INJECTED=1", process.execPath, RELAY_CLI, "mcp", "--context", ctx.contextFile], env: {},
    });
    let prepared: CodexPrep;
    let flags: CodexFlags;
    try {
      assertNeverAdapter(spec);
      const grantProblem = neverGrantProblem(spec.neverPolicy!, {}, access === "write" ? [cwd] : []);
      if (grantProblem) throw new Error(grantProblem);
      prepared = codex.prepare(spec, tmp);
      flags = codexFlags(spec, prepared.servers, prepared.env, prepared.released, undefined, undefined, inert);
    } catch (err) {
      return { ...none, problem: (err as Error).message };
    }
    let note: string | null = null;
    let account: string | null | undefined;
    const problem = await codexPreflight({
      bin: t.bin, args: ["app-server", ...flags.off, ...flags.c], cwd, env: prepared.env, expect: flags.expect, model: spec.model,
      released: flags.released, onShellPolicyNote: (n) => (note = n), onAccount: (type) => (account = type),
    });
    return { ...none, problem: problem?.trim() ?? null, note, released: flags.released, ...(account !== undefined ? { account } : {}) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The effective stage-2 shell authority stated at the front of the model input. */
export function stage2InputPrefix(spec: Pick<TurnSpec, "overlay" | "grant" | "config">): string {
  const baseline = mediatedBaseline(spec.grant, spec.config);
  const mediated = Boolean(baseline?.network && !baseline.raw_network
    || spec.overlay?.request.capabilities.some(c => c.kind === "network" && c.mode === "mediated"));
  const mediatedNote = `[relay] This turn uses stage-2 mediated network. ${MEDIATED_NETWORK_EFFECT}`;
  if (spec.overlay) {
    const overlay = `[relay] This new turn has the approved one-turn overlay ${spec.overlay.id}: ${JSON.stringify(spec.overlay.request.capabilities)}. It expires after this turn or its enforced deadline; standing grants are unchanged.`;
    return mediated ? `${overlay}\n${mediatedNote}` : overlay;
  }
  if (spec.grant?.raw_network) return RAW_NETWORK_TURN_NOTE;
  if (mediated) return mediatedNote;
  return "[relay] Commands run in relay's stage-2 sandbox with direct network, UDP and DNS disabled. Ask relay to escalate for public network through a one-turn proxy when the task needs it.";
}

/**
 * The shell network of a Codex turn given network (a grant or child_network; allow_dangerous aside,
 * which has no sandbox): strict through Codex's proxy, or local for a write job whose grant says
 * local_network (the person consented before the turn: session.ts), where a short-lived app server
 * started with exactly those settings proves the proxy is there (codexNetworkPreflight); otherwise
 * Codex's hosted web search only. Undefined for a turn without network. `note` is for the job's
 * notes (so the caller sees which the turn got), `prefix` for the turn's input.
 */
async function chooseNetwork(spec: TurnSpec, prepared: CodexPrep, tmpDir: string): Promise<{ net: CodexNetwork; note: string; prefix: string } | undefined> {
  const { dangerous, network } = turnPolicy(spec);
  if (!network || dangerous) return undefined;
  const write = spec.access === "write";
  const said = (mode: CodexNetworkMode, why?: string) => ({
    net: mode === "hosted" ? { mode } : { mode, sockets: write ? [canonical(tmpDir), ...(ownWorktree(spec) ? [canonical(spec.cwd)] : [])] : [] },
    note: why ? `Codex network: ${NETWORK_MODE_TEXT.hosted}, because ${why}.` : `Codex network: ${NETWORK_MODE_TEXT[mode]}.`,
    prefix: why
      ? `[relay] This turn your shell has no network: ${why}. Codex's hosted web search still works.`
      : `[relay] This turn your shell's network is ${NETWORK_MODE_TEXT[mode]}.`,
  });
  // The exec fallback has never given a read turn shell network (codexPermissions).
  if (!write && spec.config.codex_backend === "exec") return said("hosted");
  const mode = write && spec.grant?.local_network ? "local" : "strict";
  // Stage 2 switched on: no local mode at all (raw-network.ts localModeRetired, decision D2). session.ts
  // has refused such a turn already; this refuses the launch rather than run it with less.
  const retired = mode === "local" ? localModeRetired(spec.config) : null;
  if (retired) throw new Error(`relay does not start the Codex agent: ${retired}.`);
  // Stage 2: no local-mode proxy while a raw-network turn runs (raw-network.ts localModeInterlock,
  // review C2): Codex's proxy has no authentication. Null whenever no such turn runs, as always while
  // stage 2 is switched off. TODO(D2): goes with local mode when stage 2 ships.
  const locked = mode === "local" ? localModeInterlock("local") : null;
  if (locked) return said("hosted", locked);
  const wanted = said(mode);
  const flags = codexFlags(spec, prepared.servers, prepared.env, prepared.released, wanted.net);
  const reason = await codexNetworkPreflight({
    bin: spec.config.targets.codex.bin, args: ["app-server", ...flags.off, ...flags.c], cwd: spec.cwd, env: prepared.env, expect: flags.expect, mode, signal: spec.signal,
  });
  if (spec.signal?.aborted) throw new Error("the turn was stopped while relay checked Codex's network proxy");
  return reason ? said("hosted", `relay could not verify Codex's network proxy (${reason})`) : wanted;
}

/** Whether the turn runs in the job's own worktree as relay created it (its pin), whose Unix sockets a strict or local turn may use. */
function ownWorktree(spec: TurnSpec): boolean {
  if (!spec.worktreePin) return false;
  try {
    return canonical(spec.worktreePin.path) === canonical(spec.cwd);
  } catch {
    return false;
  }
}

/**
 * Config overrides and feature switches shared by both ways of running Codex, plus the effective
 * values relay then expects to find. Every key that could widen a job is set explicitly, granted
 * or not, so that nothing is left to whatever the user's own configuration says. `servers`: the
 * user's own MCP servers, as prepare listed them, each switched off under child_mcp "relay-only".
 * `env`: the agent's environment, where a turn given extensions looks for the skills Codex would find.
 * `released`: the names relay released that `env` carries (prepare), which the effective-configuration
 * check judges against Codex's own shell_environment_policy for a note (codex-shell-policy.ts).
 */
type CodexFlags = { off: string[]; c: string[]; expect: Expected; note?: string; released: readonly string[] };
/** `serverOf`: how relay's own MCP server is started for the turn; doctor's probe passes an inert one of the same shape (codexLaunchCheck), since relayServerCommand reads the run's registry. */
export function codexFlags(spec: TurnSpec, servers: string[], env: NodeJS.ProcessEnv, released: readonly string[] = [], net?: CodexNetwork, stage2?: Stage2Plan, serverOf: typeof relayServerCommand = relayServerCommand): CodexFlags {
  const cfg = spec.config;
  const c: string[] = [];
  const set = (key: string, value: string) => c.push("-c", `${key}=${value}`);
  const setting = cfg.targets.codex.daybreak;
  // Unset preserves the native launch path, including no extra version or catalog lookup.
  const daybreak = setting === undefined ? { enabled: false, explicit: false } : daybreakDecision(setting, spec.model,
    codexVersion(cfg.targets.codex.bin, env), setting ? daybreakCatalog(env) : { models: [] });
  // Only an explicit false (or a skipped true) pins off; older CLIs get neither setting.
  if (daybreak.explicit) set("daybreak", String(daybreak.enabled));
  if (daybreak.enabled) {
    set("features.cli_daybreak", "true");
    // The app server loads config before thread/start supplies its model. Do not validate
    // Daybreak against an unrelated CLI default during that load.
    set("model", toml(spec.model!));
  }

  const { dangerous, network, writePaths } = turnPolicy(spec);
  // Speed, pinned on every turn as a service tier: standard is the catalog's "default", said
  // rather than left out, since a model's catalog entry may carry a faster default tier
  // (defaultServiceTier; gpt-6-sol's is priority in Codex 0.163.0). The app server is also given
  // it on the thread and the turn (codex-app.ts); this key is what `codex exec` goes by.
  const speed = spec.speed ?? "standard";
  const tier = speed === "standard" ? "default" : targetDef("codex").speeds![speed]!.id;
  set("service_tier", toml(tier));
  // With its fast_mode feature off, Codex drops every service tier, "default" included (0.163.0:
  // its thread then reports none), so a standard turn turns it on for the pin to hold; the tier
  // stays "default", so nothing runs faster for it. A faster turn leaves the person's switch as it
  // is and is refused while it is off (codex-app.ts fastModeProblem). Set with -c, since `--enable`
  // of a feature a Codex version does not know stops its server, where an unknown -c key does not.
  if (speed === "standard") set("features.fast_mode", "true");
  const gitRoots = cfg.child_git === "native" ? (spec.gitDirs ?? []) : [];
  const roots = [...gitRoots, ...writePaths];
  // Each directory the turn may write by name, where Codex's sandbox cannot be built for it, refuses
  // the turn before Codex starts (codexWriteRootProblem): a grant is checked when it is given, a
  // repository's git directories and the turn's own directory only here.
  if (spec.access === "write" && !dangerous) {
    for (const [what, dir] of [["the turn's directory", spec.cwd], ...gitRoots.map((d) => ["the repository's git directory", d]), ...writePaths.map((d) => ["the granted directory", d])]) {
      const why = codexWriteRootProblem(dir);
      if (why) throw new Error(`relay does not start the Codex agent: ${what} ${JSON.stringify(dir)} ${why}.`);
    }
  }
  // The sandbox, as a permission profile of relay's own (codexPermissions): the config keys work for
  // `exec` and the app server alike, new and resumed sessions, and the app server is also told to
  // use it on the thread (codex-app.ts), which no session's stored setting outranks.
  // Stage 2 (WP-D): `:danger-full-access` inside relay's Seatbelt, enforcement "relay" (codex-stage2.ts).
  const permissions = stage2?.permissions ?? codexPermissions(spec, { dangerous, network, roots, ...(net ? { net } : {}), codexHome: env.CODEX_HOME });
  c.push(...permissionFlags(permissions));
  // Codex's network proxy, for a turn whose shell network goes through it (codex-network.ts); and,
  // on every turn, no access added to one command's sandbox: neither the request_permissions tool,
  // whose requests (item/permissions/requestApproval) relay does not answer, nor
  // exec_permission_approvals. With the latter on, a command an exec-policy allow rule matches is
  // run without asking (core exec_policy.rs: Skip), with whatever with_additional_permissions it
  // names merged into its sandbox (sandboxing policy_transforms.rs), so no request reaches relay's
  // autoDenial: network on a session without the proxy, Seatbelt's open policy (review r_17565c33
  // X1; reproduced model-free). All read back (configProblem) and from the feature list (featuresProblem).
  if (permissions.proxy) set("features.network_proxy", "true");
  set("features.request_permissions_tool", "false");
  set("features.exec_permission_approvals", "false");
  const features: Record<string, boolean> = { request_permissions_tool: false, exec_permission_approvals: false, ...(permissions.proxy ? { network_proxy: true } : {}) };
  // Pin the reviewer: with any other reviewer exec does not hold its approval policy at `never`,
  // and requests would go to an automatic reviewer instead of to relay.
  set("approvals_reviewer", toml("user"));
  // Codex's own web search tool: live with a network grant, whatever network the shell gets
  // (strict, local, or none where the proxy cannot be verified): the search runs at OpenAI, not on
  // this Mac, and its results still reach the agent's context. Without a grant it keeps the user's
  // setting, or is switched off when child_web is "ask" (Codex has no way to ask per search), and
  // for a turn given MCP servers, where a search could carry a credential past relay's gate.
  // Switched off, it is read back too (configProblem): a layer that outranks relay's flags could turn
  // it back on. "live" is not: it widens nothing the network grant has not, and a layer that keeps
  // the search narrower takes nothing away from the job but the search.
  const webOff = Boolean(spec.neverPolicy?.hosts.length || cfg.never?.hosts?.length) || (!network && (cfg.child_web === "ask" || Boolean(spec.extensionServers?.length)));
  if (webOff) set("web_search", toml("disabled"));
  else if (network) set("web_search", toml("live"));
  // Stage 2 has no local environment for stdio MCP. Its tools use the HTTP broker instead.
  const relay = stage2 ? null : spec.relay;
  if (relay) {
    const server = serverOf(relay);
    // Same name as a user-level entry: -c merges key by key, so these values replace it.
    set("mcp_servers.relay.command", toml(server.command));
    set("mcp_servers.relay.args", toml(server.args));
    set("mcp_servers.relay.env_vars", toml(CODEX_MCP_ENV_VARS));
    for (const [k, v] of Object.entries(server.env)) set(`mcp_servers.relay.env.${k}`, toml(v));
    set("mcp_servers.relay.enabled", "true");
    // Without this, Codex asks for approval of MCP tools that are not marked read-only.
    set("mcp_servers.relay.default_tools_approval_mode", toml("approve"));
    // Longer than an approval request may make a call wait: a call of an extension's tool waits for
    // the person (gateway.ts), first behind an earlier request of the same agent (up to
    // approval_timeout_s), then for the answer (up to approval_timeout_s again). Cut off sooner, the
    // call would fail for the agent while relay still waited, and a later allow could run it.
    set("mcp_servers.relay.tool_timeout_sec", String(codexToolTimeoutS(cfg.approval_timeout_s)));
    set("mcp_servers.relay.startup_timeout_sec", "30");
  } else {
    // Codex filters env for MCP servers, so a user-level relay would not see the child markers
    // and would act as a root. It must never load in a child that may not delegate. This is
    // unconditional (it does not depend on listing the user's servers); the command is given so
    // the entry is well-formed even when the user has no relay entry.
    set("mcp_servers.relay.command", toml("false"));
    set("mcp_servers.relay.args", "[]");
    set("mcp_servers.relay.enabled", "false");
  }
  const relayOnly = cfg.child_mcp === "relay-only";
  if (stage2?.broker) {
    const key = `mcp_servers.${BROKER_SERVER_NAME}`;
    set(`${key}.url`, toml(stage2.broker.url));
    set(`${key}.bearer_token_env_var`, toml(BROKER_TOKEN_ENV));
    set(`${key}.environment_id`, toml("local"));
    set(`${key}.enabled`, "true");
    set(`${key}.required`, "true");
    set(`${key}.startup_readiness`, toml("connection"));
    set(`${key}.default_tools_approval_mode`, toml("approve"));
    set(`${key}.startup_timeout_sec`, "30");
    set(`${key}.tool_timeout_sec`, String(stage2.broker.toolTimeoutS));
  }
  if (relayOnly) {
    for (const name of servers) if (name !== "relay" && !(stage2?.broker && name === BROKER_SERVER_NAME)) set(`mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : toml(name)}.enabled`, "false");
  }
  const off = [...(cfg.child_hooks ? [] : ["--disable", "hooks"]), ...(relayOnly ? ["--disable", "plugins"] : [])];
  // Every launched turn, including one given no extensions:
  // every skill Codex would find by itself, the person's and the repository's, is switched off for
  // this server (a session override, written nowhere), and so is installing a skill's MCP
  // dependencies, which would be a second MCP server beside relay's gateway. Relay's own package,
  // if any, is added as an extra skill root once the server is up, and what Codex will load is
  // checked then (codex-app.ts): the session gets exactly what the person consented to.
  {
    const files = codexSkillFiles(spec.cwd, env);
    set("skills.config", `[${files.map((f) => `{path=${toml(f)},enabled=false}`).join(",")}]`);
    off.push("--disable", "skill_mcp_dependency_install");
  }
  // Stage 2 (WP-D): its settings and the features it pins off, read back like the others (§2.5).
  if (stage2) {
    c.push(...stage2.c);
    off.push(...stage2.off);
    Object.assign(features, stage2.features);
  }
  const expect: Expected = {
    ...(daybreak.explicit ? { daybreak: daybreak.enabled } : {}),
    permissions, features, relay: relay ? serverOf(relay) : null, relayOnly,
    ...(stage2?.broker ? { broker: stage2.broker } : {}),
    ...(webOff ? { webSearch: "disabled" as const } : {}),
    accountLogin: authFor(cfg, "codex") === "login",
    signIn: { home: relayCodexHome(cfg), once: codexSignIn(cfg), again: codexSignIn(cfg, true) },
    ...(spec.model ? { model: spec.model } : {}),
    ...(cfg.codex_endpoint_override === "accept" ? { endpointOverride: true } : {}),
    skills: { root: spec.skills ? path.join(spec.skills.dir, "skills") : null, names: spec.skills?.names ?? [] },
    speed: { name: speed, tier },
  };
  return { off, c, expect, released, ...(daybreak.note ? { note: daybreak.note } : {}) };
}

/**
 * The permissions of a Codex turn, as a permission profile (Codex 0.163.0 `[permissions.<id>]`,
 * selected by `default_permissions`). It describes the same sandbox as the legacy settings relay
 * used before (`sandbox_mode` and `sandbox_workspace_write`), plus one thing they could not say:
 *
 * - a read turn reads everything and writes nothing (`:root` read), with the network only when it
 *   is granted. The `codex exec` fallback has never given a read turn the network (the legacy
 *   read-only mode had no network key, and exec takes no per-turn setting), and still does not;
 * - a write turn reads everything and writes its worktree, each granted directory (and, with
 *   child_git "native", the repository's git directories) and its own TMPDIR, never the rest of
 *   /tmp; the network only when granted. The granted directories are workspace roots of the
 *   profile, as they were of the legacy settings (Codex seeded its workspace roots from
 *   `writable_roots`), so every rule about workspace roots holds for them too;
 * - and, new, at the top of every workspace root, the harness configuration relay's own sandbox
 *   also refuses (HARNESS_CONFIG) is read-only, present or not: a job cannot plant a
 *   `.claude/settings.json`, `.gemini/` or `.mcp.json` that the person's own agent would load once
 *   the work is merged. Codex keeps its own protection of `.git`, `.agents`, `.codex` and `.aws`
 *   on top of this (protocol/src/permissions.rs, default_read_only_subpaths_for_writable_root);
 * - under allow_dangerous, a write turn runs with Codex's built-in `:danger-full-access`;
 * - every confined turn carries the captured never floor's built-in and user paths, including
 *   aliases: all-access denies become `deny`, write-only denies become `read`, with the full
 *   profile checked through the existing exact config/read readback;
 * - every confined turn, read or write, may not read the credential stores of deniedCredentials,
 *   which also keeps every command in the sandbox, approved or allowed by an exec-policy rule;
 * - the network, where a turn has it, only through Codex's network proxy (codex-network.ts): strict
 *   (no loopback or private destinations), or local for a write turn the person consented for;
 *   Unix sockets only under the directories named (`net.sockets`: a write turn's TMPDIR and its
 *   job's worktree; a read turn none). Where the proxy cannot be verified (`net.mode` "hosted"),
 *   none at all: Codex's hosted web search is set apart (codexFlags).
 *
 * Both Codex's shell sandbox and its own file edits (apply_patch) follow the profile. A command or
 * file change a person approves to run outside the sandbox gets write access to the whole disk but
 * still not the denied credential stores, with the turn's own network (deniedCredentials).
 */
/**
 * Credential stores every confined Codex turn may not read (or write), as profile entries Codex
 * keeps under any approval: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc` and Codex's own login
 * (`$CODEX_HOME/auth.json` where CODEX_HOME is set, else `~/.codex/auth.json`). Spelled as
 * config/read echoes them back ("deny"; "none" is its legacy alias), so the exact profile readback
 * confirms them on every turn.
 *
 * They also change what an approval can do. Codex lets no command leave its sandbox while the
 * profile denies a read, since the sandbox is what enforces the denial (core tools/sandboxing.rs
 * unsandboxed_execution_allowed, sandbox_permissions_preserving_denied_reads): a command an
 * exec-policy rule allows runs sandboxed like any other, and a command approved to run outside the
 * sandbox runs in it with write access to `/` and these denials kept (protocol
 * permissions/target.rs for_approved_command), with the turn's own network.
 */
export function deniedCredentials(codexHome: string | undefined, cfg?: RelayConfig): Record<string, "deny"> {
  const auth = codexHome && path.isAbsolute(codexHome) ? path.join(codexHome, "auth.json") : "~/.codex/auth.json";
  return Object.fromEntries(["~/.ssh", "~/.aws", "~/.gnupg", "~/.netrc", "~/.codex/auth.json", auth, ...relayCodexProtected(cfg).homes.map((p) => p.path)].map((p) => [p, "deny" as const]));
}

export function codexPermissions(spec: Pick<TurnSpec, "access" | "config" | "neverPolicy">, o: { dangerous: boolean; network: boolean; roots: string[]; net?: CodexNetwork; codexHome?: string }): CodexPermissions {
  if (o.dangerous) return { id: DANGER_PROFILE, profile: null, sandbox: "danger-full-access", network: true, proxy: null };
  const write = spec.access === "write";
  // The shell's network (codex-network.ts): through Codex's proxy (strict, or local for a write turn
  // the person consented for), or none (hosted search only). The exec fallback has never given a
  // read turn the network, and still does not. Plain `network.enabled = true` without the proxy,
  // which opens loopback and Unix sockets anywhere, is never set.
  const want: CodexNetwork = o.network && (write || spec.config.codex_backend !== "exec") ? (o.net ?? { mode: "strict" }) : { mode: "hosted" };
  const proxy = want.mode === "hosted" ? null : want.mode === "local" && write ? "local" : "strict";
  const sockets = write ? (want.sockets ?? []) : [];
  const network: CodexProfileNetwork = proxy
    ? {
      enabled: true, domains: { "*": "allow" }, allow_local_binding: proxy === "local", allow_upstream_proxy: false,
      ...(sockets.length ? { unix_sockets: Object.fromEntries(sockets.map((d) => [d, "allow" as const])) } : {}),
    }
    : { enabled: false };
  const floor = spec.neverPolicy ? neverProfileInputs(spec.neverPolicy) : undefined;
  const denied = { ...Object.fromEntries(relayCodexProtected(spec.config.targets ? spec.config : undefined).stores.map((p) => [p.path, "read" as const])),
    ...Object.fromEntries((floor?.denyWrite ?? []).map(p => [p, "read" as const])),
    ...deniedCredentials(o.codexHome, spec.config.targets ? spec.config : undefined),
    ...Object.fromEntries((floor?.denyAll ?? []).map(p => [p, "deny" as const])) };
  if (!write) return { id: CODEX_PROFILE, profile: { filesystem: { ":root": "read", ...denied }, network }, sandbox: "read-only", network: network.enabled, proxy };
  const carveOuts = Object.fromEntries(HARNESS_CONFIG.map((name) => [name, "read" as const]));
  return {
    id: CODEX_PROFILE,
    profile: {
      ...(o.roots.length ? { workspace_roots: Object.fromEntries(o.roots.map((r) => [r, true as const])) } : {}),
      filesystem: { ":root": "read", ":tmpdir": "write", ":workspace_roots": { ".": "write", ...carveOuts }, ...denied },
      network,
    },
    sandbox: "workspace-write", network: network.enabled, proxy,
  };
}

/** Codex's built-in profile without a sandbox (allow_dangerous). */
const DANGER_PROFILE = ":danger-full-access";

/**
 * A TOML inline table of `entries`, every key quoted. A name such as `.claude` or a path is a key
 * inside the value, never part of the dotted key of a `-c` override, which Codex splits at every
 * dot (config/src/overrides.rs).
 */
export function tomlInline(entries: Record<string, unknown>): string {
  const value = (v: unknown): string => (typeof v === "string" ? toml(v) : typeof v === "boolean" ? String(v) : tomlInline(v as Record<string, unknown>));
  return `{${Object.entries(entries).map(([k, v]) => `${toml(k)}=${value(v)}`).join(",")}}`;
}

/** The `-c` overrides that define and select a turn's permission profile. */
export function permissionFlags(p: CodexPermissions): string[] {
  const out = ["-c", `default_permissions=${toml(p.id)}`];
  if (!p.profile) return out;
  const key = `permissions.${CODEX_PROFILE}`;
  out.push("-c", `${key}.filesystem=${tomlInline(p.profile.filesystem)}`);
  if (p.profile.workspace_roots) out.push("-c", `${key}.workspace_roots=${tomlInline(p.profile.workspace_roots)}`);
  const n = p.profile.network;
  out.push("-c", `${key}.network.enabled=${n.enabled}`);
  if (n.domains) out.push("-c", `${key}.network.domains=${tomlInline(n.domains)}`);
  if (n.allow_local_binding !== undefined) out.push("-c", `${key}.network.allow_local_binding=${n.allow_local_binding}`);
  if (n.allow_upstream_proxy !== undefined) out.push("-c", `${key}.network.allow_upstream_proxy=${n.allow_upstream_proxy}`);
  if (n.unix_sockets) out.push("-c", `${key}.network.unix_sockets=${tomlInline(n.unix_sockets)}`);
  return out;
}
