// doctor: checks this machine against what relay needs (Node, the CLIs at the versions relay's
// confinement was verified with, their logins, each host's registration), and says what to fix.
import { codexRulesDoctor } from "../backends/codex-network.js";
import { spawnSync } from "node:child_process";
import { discoveryVerified, fullVersionOf } from "../backends/tool-discovery.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configProtection } from "../core/protected-config.js";
import { settingsEnvProblem } from "../backends/claude.js";
import { codexLaunchCheck } from "../backends/codex.js";
import { codexConfigFile as userCodexConfigFile } from "../hosts/codex.js";
import { codexVersion, daybreakDoctor } from "../backends/codex-daybreak.js";
import { stage2SettingsProblems } from "../backends/codex-stage2.js";
import { stage2Enabled } from "../core/raw-network.js";
import { sandboxCheckUnavailable } from "../confine/sbcheck.js";
import { loginStore } from "../backends/acp.js";
import { grokLoginRefusal, grokSystemRefusal } from "../backends/grok.js";
import { confinementSummary, tokenStoreProblem } from "../confine/index.js";
import { inboundSettings, managedSettings, managedSettingsProblem, settingsAnswerForPerson } from "../core/claude-settings.js";
import { authFor, canonical, configPath, DEFAULT_CONFIG, hasExtensions, loadConfig, relayHome, serverOf, type RelayConfig } from "../core/config.js";
import { mcpFile, readMcpFile, resolveSkills } from "../core/extensions.js";
import { controlDirUsage, storageReport } from "../core/storage.js";
import { gitExecutable, systemTool } from "../core/executables.js";
import { turnTempProblems } from "../core/retention.js";
import { hostDef, HOSTS, type DoctorReport, type HostId } from "../hosts/index.js";
import { relayVersion } from "./basics.js";
import { ambiguousNote, first, isRelayCommand, LAUNCHER, relayCommandIdentity, linkPath, locate, npmInstallName, onPath, reinstallCommand, relativePathEntryBefore, relayCommandKind, ROOT, say, sh, errText, type Run } from "./common.js";
import { defaultKeyDir, keyFileStatus } from "../core/api-keys.js";
import { loadBriefs, notesBehind } from "../targets/briefs.js";
import { doctorRule } from "../core/steering.js";
import { isTarget, olderVersion, TARGETS, targetDef, targetLabel, versionOf, type Target } from "../targets/index.js";
import { DIALOG_QUALIFICATIONS } from "../mcp/host.js";
import { capturedRootEnvironment, selectEnvironment } from "../core/env-policy.js";
import { redact, registerReleasedEnvironment, withTurnSecrets } from "../core/secrets.js";
import { claudeInitProblem } from "./claude-init.js";
import { claudeLinkDoctor, linkVersionProblem } from "../backends/native-temp.js";
import { probeVersion } from "../backends/cli-version.js";
import { codexHomeStatus, codexPinInfo, describeCodexPin, freezeCodexConfig, RELAY_CODEX_CONFIG, shippedPinPackageRoot } from "../backends/codex-pin.js";
import { buildIdentity, describeBuild } from "../core/build-identity.js";
import { readShippedPin } from "../core/shipped-pin.js";
import { relayCodexHome, relayCodexPinStore } from "../core/config.js";
import { resolveNeverPolicy } from "../core/never-policy.js";
import { claudeFloorVariants, neverFloorApplies, neverFloorReport } from "../core/never-coverage.js";
import { QUALIFIED_NEVER_TOOL_ADAPTERS } from "../core/never-tools.js";
import { nativeCodexNeverNetworkEntry } from "../backends/never-admission.js";


/** package.json engines and bin/relay's check: Node 24.15 is the first Node 24 whose node:sqlite, which the registry uses, prints no ExperimentalWarning. */
const MIN_NODE = [24, 15];
// Recorded runs: docs/qualification/copilot-1.0.98.md and docs/research/seatbelt-prototype.md (27.0,
// 27.0.1); 27.2: Codex 0.167.0 qualified 32/32 on two Macs (2026-11-07) and the release checks,
// items 1-33, passed at f67f622 (2026-11-08); 27.2.1: the full release gate chain
// (suite, items 1-33, live rounds, red team, claude-floor) passed at b9f1eaa (2026-11-16).
export const TESTED_MACOS = ["27.0", "27.0.1", "27.2", "27.2.1"] as const;
export const testedMacOS = (version: string): boolean => TESTED_MACOS.some((v) => v === version);


export function doctor(): Promise<void> {
  return withTurnSecrets(() => doctorScoped());
}
async function doctorScoped(): Promise<void> {
  let failed = 0;
  let warned = 0;
  const line = (label: string, text: string) => say(redact(`${label.padEnd(Math.max(15, label.length + 1))}${text}`));
  const fail = (label: string, text: string) => (failed++, line(label, `FAIL: ${text}`));
  const warn = (label: string, text: string) => (warned++, line(label, `WARNING: ${text}`));
  const mine = (command: unknown) => typeof command === "string" && canonical(command) === canonical(LAUNCHER);

  line("relay", `${relayVersion()} at ${ROOT}`);
  if (process.platform === "darwin") {
    const mac = spawnSync(systemTool("/usr/bin/sw_vers"), ["-productVersion"], { encoding: "utf8" });
    const version = mac.status === 0 ? mac.stdout.trim() : "unknown";
    line("platform", `macOS ${version} (Darwin ${os.release()}, ${process.arch}); tested on macOS ${TESTED_MACOS.join(", ")}`);
    if (!testedMacOS(version)) warn("platform", `macOS ${version} has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.`);
  }
  else fail("platform", `${process.platform} is not supported: relay relies on macOS process handling and on each CLI's macOS sandbox`);

  const node = process.versions.node.split(".").map(Number);
  const nodeLine = `${process.version} at ${process.execPath}`;
  if (olderVersion(node.slice(0, 2), MIN_NODE)) fail("node", `${nodeLine}; relay needs ${MIN_NODE.join(".")} or newer`);
  else line("node", `${nodeLine} (needs ${MIN_NODE.join(".")} or newer)`);
  line("", `the launcher bin/relay picks Node: RELAY_NODE (${process.env.RELAY_NODE ? `set to ${process.env.RELAY_NODE}` : "not set"}), then PATH, then the version managers`);

  let cfg = DEFAULT_CONFIG;
  let cfgProblem = "";
  try {
    cfg = loadConfig((message) => warn("config", message));
  } catch (err) {
    cfgProblem = errText(err);
  }
  line("family", doctorRule(cfg));
  if (!cfgProblem) {
    try {
      const never = resolveNeverPolicy({ never: cfg.never, codexHome: (cfg.targets.codex as { home?: string }).home });
      line("never policy", `v${never.version} ${never.hash}; ${never.paths.length} protected path entries, ${never.ports.length} port entries, ${never.hosts.length} host entries. Each run retains a durable cumulative floor.`);
      const [heading, ...perTarget] = neverFloorReport(TARGETS.map((t) => ({ id: t.id, label: targetLabel(t, t.id), enabled: cfg.targets[t.id].enabled })), cfg);
      line("never enforced", heading);
      for (const text of perTarget) line("", text);
      for (const removed of never.removed) warn("never override", `${removed.acknowledge}: ${removed.reason}. New runs only; existing floors cannot shrink.`);
      if (never.hosts.length) line("never hosts", 'raw network unavailable; hosted search and web__run require web_search="disabled" effective readback');
      const nativeNetworkEntry = nativeCodexNeverNetworkEntry(never, "strict");
      const openNetworkEntry = nativeCodexNeverNetworkEntry(never, "local");
      if (nativeNetworkEntry) line("never Codex", `${nativeNetworkEntry}: native shell-network turns refuse before launch, including resumed/kept grants. With stage 2 on, standing network grants and child_network use the mediated route, which enforces hosts and ports; with stage 2 off these entries require shell network off.`);
      else if (openNetworkEntry) line("never Codex", `${openNetworkEntry}: native strict shell network enforces it (it reaches none of this Mac's addresses); native turns with grant.local_network${cfg.allow_dangerous ? " and allow_dangerous write turns" : ""}, which reach this Mac's addresses, refuse before launch, including resumed/kept grants. With stage 2 on, relay's own sandbox and proxy enforce it.`);
      line("extension tools", `${QUALIFIED_NEVER_TOOL_ADAPTERS.length} qualified effects adapters; other tools withheld before launch regardless of person consent`);
    } catch (err) { fail("never policy", (err as Error).message); }
  }
  for (const { directory, reason } of configProtection().fileOnly) warn("config paths", `only relay's config and install files are protected in ${directory}: ${reason}; a process allowed to write that directory could replace them by renaming it.`);
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (raw.same_family === "allow") line("", 'In 1.0, "allow" also covers sessions of unknown family, Copilot with "auto", no model or an unlisted model, and Grok with no model.');
  } catch { /* Invalid config is reported below. */ }
  line("", "A --host registration is believed only while clientInfo agrees. A copied registration in opencode or another multi-model host makes the caller unknown; relay logs that mismatch once per session and names it in families.note. Doctor cannot see another session's clientInfo.");
  line("session", "Configuration only: qualified Claude Code and Codex registrations assume one conversation per process; --desktop and local-agent-mode-* are shared; OpenCode 2 (client opencode, seen on 2.1.4) is shared, and relay scopes each call by the session OpenCode stamps on it; other deployments are unqualified. status.session reports this call's scope, source and topology without host ids or tokens. No last-observed call is persisted, and static configuration is not a verified two-conversation host test.");
  line("", "On a shared relay each conversation carries a session token relay issued it (session_token), which keeps its jobs, approval requests and events apart from the other conversations'. It is a bearer key the model holds in plain text: it separates conversations that use relay honestly, and anyone who sees it can act as that conversation. Relay stores only its hash. Deleting session.key in relay's home revokes every token at once; to move their runs to new tokens, quit and reopen the app, then run relay adopt from a terminal (relay cancel there stops the work instead).");
  for (const q of Object.values(DIALOG_QUALIFICATIONS)) {
    const idle = q.idleSince ? `qualified from ${q.idleSince.join(".")}` : "unqualified";
    const busy = q.busySince ? `qualified from ${q.busySince.join(".")}` : "unqualified";
    const offer = q.idleSince && q.busySince
      ? `offered only when both version floors, host markers and consent checks pass${cfg.ask_user === "never" ? '; withheld by ask_user "never"' : ""}`
      : `withheld: ${q.withheld}`;
    line("dialog surface", `${q.label}: idle ${idle}; busy ${busy}; ${offer}`);
  }
  line("", "Dialog qualification is per surface, not vendor; ask_user always does not override it. Doctor describes qualification, not a live connection. status.approval_dialogs reports that session's offer and reason. Withheld requests stay pending and arrive in the next call's events; confirm remains available only where its permission prompt is qualified, or use relay approvals in a terminal.");
  line("", "Foreign MCP items are unavailable. Recover an orphan explicitly with adopt through a qualified permission prompt, or relay adopt <run_id> --to <status-session-fingerprint> in a terminal; review and confirm the whole-run transfer. Owner death, cwd and family never grant access.");

  // The model notes in the prompting briefs go stale as the CLIs move on; doctor says when they have.
  let briefs: ReturnType<typeof loadBriefs> = {};
  try {
    briefs = loadBriefs();
  } catch (err) {
    warn("briefs", `relay's prompting briefs do not load (${errText(err)})`);
  }

  const present: Partial<Record<Target, boolean>> = {};
  const codexState = codexHomeStatus(cfg);
  line("codex home", `${codexState.home}: ${codexState.present ? "present" : "missing"}; login ${codexState.login} (auth.json metadata only; requires mode 0600)`);
  // A configured home that is not relay's: reported, never repaired (prepareCodexHome refuses it before any write).
  if (codexState.problem) (cfg.targets.codex.enabled ? fail : line)("codex home", `${codexState.problem}${cfg.targets.codex.enabled ? "" : " (the codex target is disabled, so no job uses it now)"}`);
  let codexPinProblem = "";
  // The pin matters only to a Codex target relay launches. Before any pin is in place (a fresh
  // install, before `relay install codex --write`), that is the next step, not a broken one.
  const noPinYet = () => { try { fs.lstatSync(path.join(relayCodexPinStore(cfg), "current")); return false; } catch { return true; } };
  if (!cfg.targets.codex.enabled) line("codex pin", "not checked: the codex target is disabled");
  else try {
    cfg = freezeCodexConfig(cfg);
    const pin = codexPinInfo(cfg);
    line("codex pin", cfg.targets.codex.pinned ? `${pin ? describeCodexPin(pin) : "qualified"}; binary ${cfg.targets.codex.bin}` : "off (targets.codex.pinned is explicitly false)");
    // A release's shipped pin that is not the one in force: say so, and how to switch.
    let shipped = null;
    try { shipped = readShippedPin(shippedPinPackageRoot()); } catch (err) { warn("codex shipped pin", `this relay's codex-pin.json is not valid (${errText(err)})`); }
    if (shipped && cfg.targets.codex.pinned && pin?.kind === "local") {
      line("codex shipped pin", `this release also ships a pin for Codex ${shipped.codex.version}, qualified by the maintainer with ${describeBuild(shipped.relay)}; \`relay qualify-codex --shipped\` switches to it`);
    }
  } catch (err) { codexPinProblem = errText(err); (cfg.targets.codex.pinned !== false && noPinYet() ? warn : fail)("codex pin", codexPinProblem); }
  const codexConfigFile = () => path.join(relayCodexHome(cfg), "config.toml");
  let claudeVersion: number[] | null = null;
  // How the codex launch check's app server said relay's Codex home is signed in, for the codex login line.
  const codexLaunch: { account?: string | null } = {};
  for (const t of TARGETS.filter((t) => cfg.targets[t.id].enabled)) {
    const cli = t.id;
    if (cli === "codex" && codexPinProblem) continue;
    const label = targetLabel(t, cli);
    const bin = cfg.targets[cli].bin;
    // `bin` in the config says where each target's CLI is. It has nothing to do with which Node runs relay.
    const onPath = bin === DEFAULT_CONFIG.targets[cli].bin;
    const from = cli === "codex" && cfg.targets.codex.pinned ? "resolved qualified pin" : onPath ? "found on PATH" : `set by targets.${cli}.bin in the config`;
    // An experimental target not switched on is refused whatever is installed: its CLI is no requirement.
    const refused = !t.qualified && !cfg.targets[cli].experimental;
    let selection: ReturnType<typeof selectEnvironment>;
    try { selection = selectEnvironment(t.id, cfg, capturedRootEnvironment); }
    catch (err) { fail(label, errText(err)); continue; }
    registerReleasedEnvironment(selection.env, selection.releasedNames);
    const r = probeVersion(cli, bin, selection.env);
    present[cli] = !r.error && r.status === 0;
    if (cli === "codex") line("codex daybreak", daybreakDoctor(cfg.targets.codex.daybreak, present[cli] ? versionOf(r.stdout) : null, selection.env));
    if (!present[cli]) {
      const missing = `not found or not runnable (\`${bin}\`, ${onPath ? "looked up on PATH" : from})`;
      if (refused) line(label, `${missing}; relay refuses it anyway until targets.${cli}.experimental is true`);
      else fail(label, `${missing}. Install ${t.product}, or set targets.${cli}.bin in ${configPath()} to its full path`);
      continue;
    }
    if (cli === "codex" && codexState.login === "unsafe permissions") warn("codex login", `${path.join(codexState.home, "auth.json")} is not a private regular file (mode 0600); sign in again with CODEX_HOME=${JSON.stringify(codexState.home)} codex login`);
    const v = versionOf(r.stdout);
    if (cli === "claude") claudeVersion = v;
    const tested = t.tested.join(".");
    const where = `${first(r.stdout)} at ${locate(bin) ?? bin} (${from})`;
    // Launching refuses a CLI older than the version its confinement was verified with, or one whose
    // version cannot be read, unless allow_untested is set (backends/run.ts untested). Doctor says the same.
    const why = !v ? `relay could not read the version (its confinement was verified with ${tested})` : olderVersion(v, t.tested) ? `older than the ${tested} relay's confinement was verified with` : null;
    if (!why) line(label, `${where}; tested with ${[t.tested, ...(t.checked ?? [])].map((x) => x.join(".")).join(", ")}`);
    else if (cfg.allow_untested) warn(label, `${where}; ${why}. allow_untested is set, so relay launches it anyway, unverified`);
    else fail(label, `${where}; ${why}, so relay refuses to launch it. Update ${t.product}, or set "allow_untested": true in relay's config to run it unverified`);
    const c = t.capabilities;
    const confined = c.confinement === "verified" ? "verified confinement (its own sandbox, configured and checked by relay)" : c.confinement === "relay-enforced" ? "relay-enforced confinement (relay's own sandbox around the whole harness)" : "no confinement (relay does not launch it)";
    line("", `${label}: ${confined}; network off ${c.networkOff ? "enforced" : "not available (needs a network grant)"}; approval requests ${c.approvals}; login ${c.login}${t.qualified ? "" : refused ? `; experimental, not qualified (needs targets.${cli}.experimental)` : `; experimental, not qualified (switched on by targets.${cli}.experimental)`}`);
    // A target that signs in with an API key only (Gemini): its own opt-in, and its key file, said
    // without reading the key out (core/api-keys.ts). Without the opt-in no turn would read the file,
    // and neither does doctor: it looks only at where the file is and at its status.
    if (c.login === "key-only") {
      const optedIn = cfg.targets[cli].child_auth === "any";
      if (!optedIn) (refused ? line : fail)(`${label} key`, `relay hands ${t.name} an API key, and so launches it, only with targets.${cli}.child_auth "any" (the global child_auth does not count)`);
      const k = keyFileStatus(cli, { content: optedIn });
      if (k.problem) (refused ? line : fail)(`${label} key`, k.problem);
      else line(`${label} key`, `${k.file}: in place and private${optedIn ? "" : " (its content not read, without the opt-in)"}; read before each of its turns and handed to its process alone. ${k.denied === "directory" ? "Relay's sandbox denies its directory to every agent it confines" : `It is outside ${defaultKeyDir()}: relay's sandbox denies the file itself to every agent it confines, its directory staying readable to them`}. Claude's turns may not read it either; Codex's can, as they can read your other files`);
    }
    // A target that takes relay's tools through its own tool discovery (Gemini): offered on every
    // version, checked at each launch; whether this one is among those it was verified on live.
    if (t.toolDiscovery) {
      const full = fullVersionOf(r.stdout);
      const verified = t.toolDiscovery.versions.join(", ");
      line(`${label} tools`, `relay's tools through ${t.product}'s own tool discovery (named ${t.toolDiscovery.prefix}<tool>): ${discoveryVerified(t, full) ? `checked on this version, ${full}` : `not checked on ${full ?? "this version"}`}; checked on ${verified} (docs/install.md says how). Every launch checks that discovery ran, on any version: where it did not, the agent is told it has no relay tools, and the turn says so`);
    }
    const behind = v && briefs[cli] ? notesBehind(t, briefs[cli].models, v) : null;
    if (behind) (behind.stale ? warn : line)(`${label} brief`, behind.text);
  }

  if (!cfg.targets.codex.enabled) line("codex daybreak", daybreakDoctor(cfg.targets.codex.daybreak, null, { ...process.env, CODEX_HOME: relayCodexHome(cfg) }) + (cfg.targets.codex.daybreak === undefined ? "" : "; target disabled, CLI version not checked"));

  // What makes relay refuse every turn of an enabled target relay confines itself, before it starts,
  // from the same checks the launch makes: Grok's system configuration layers and where its login is
  // (backends/grok.ts refuse), and a target's login store as the sandbox layer checks it (confine
  // tokenStore). An experimental target not opted into is refused anyway, as its line above says.
  for (const t of TARGETS.filter((t) => cfg.targets[t.id].enabled && present[t.id] && (t.qualified || cfg.targets[t.id].experimental))) {
    const name = targetLabel(t);
    const problem = (t.id === "grok" ? grokSystemRefusal(name) ?? grokLoginRefusal(name) : null)
      ?? (t.tokenStore ? tokenStoreProblem(loginStore(t.tokenStore, os.homedir())) : null);
    if (problem) warn(`${t.id} launch`, `relay refuses every ${name} turn here: ${problem}`);
  }

  // Settings relay does not vet make it refuse every Claude launch (backends/claude.ts prepare).
  if (cfg.targets.claude.enabled && present.claude) {
    // Under a long home, Claude's private temp goes through relay's short link (backends/native-temp.ts).
    const { bin } = cfg.targets.claude;
    const link = claudeLinkDoctor(claudeVersion, bin, cfg.allow_untested);
    if (link) (link.level === "warn" ? warn : line)("claude temp", link.text);
    const managed = managedSettings();
    // The never floor's gates (backends/never-admission.ts, claude.ts prepare), from the same predicate.
    const floored = neverFloorApplies("claude", cfg);
    const variants = floored ? claudeFloorVariants({ ...cfg, allow_dangerous: false }) : [];
    // floored is always true for Claude today (NEVER_FLOOR_WHEN), so the "refuse" alternative is
    // reached only if that changes; both texts say what "accept" would and would not launch.
    const problem = managed && (floored || cfg.claude_managed_settings === "refuse")
      ? managedSettingsProblem(managed, floored)
      : variants.length ? `${variants.join(", ")} can take a job around the never floor's checked sandbox; use child_settings "isolated", child_hooks false and child_mcp "relay-only"`
      : settingsEnvProblem(cfg, managed);
    if (!problem && floored && cfg.allow_dangerous) warn("claude launch", "relay refuses Claude write jobs here: allow_dangerous would run them unsandboxed, around the never floor");
    if (problem) warn("claude launch", `relay refuses every Claude launch here: ${problem}`);
    else if (link && !link.usable) line("claude init", "not run: Claude's private temp here needs relay's short link usable (see claude temp), and doctor never makes the link");
    else {
      try {
        const selection = selectEnvironment("claude", cfg, capturedRootEnvironment);
        registerReleasedEnvironment(selection.env, selection.releasedNames);
        const initProblem = await claudeInitProblem(bin, selection.env, () => linkVersionProblem(claudeVersion, bin, cfg.allow_untested));
        if (initProblem) warn("claude init", initProblem);
        else line("claude init", "isolated skills and plugins checked; stopped at init, process ended without a result event (no model turn)");
      } catch {
        warn("claude init", "could not prepare Claude's init-only probe");
      }
    }
  }

  // Codex settings relay does not set make it refuse Codex launches (backends/codex-app.ts
  // configProblem), and Codex's own shell_environment_policy may keep names relay releases from its
  // commands. Both are judged by the check a job's turn makes before it runs (codexLaunchCheck): the
  // effective configuration a Codex app server reports for a job started in this directory, every
  // layer merged (system, managed, this directory's project layers, and relay's Codex home, whose
  // config.toml relay writes on every turn), for a read job and a write job without grants.
  if (cfg.targets.codex.enabled && present.codex) {
    const cwd = process.cwd();
    if (codexState.problem) line("codex launch", `not checked: relay will not use ${codexState.home} as its Codex home (see the codex home line), and doctor changes nothing there`);
    else if (!codexState.present) line("codex launch", `not checked: relay's Codex home ${codexState.home} does not exist yet (\`relay install codex --write\` makes it; see the codex login line)`);
    else {
      let held: string | null = null;
      try { held = fs.readFileSync(codexConfigFile(), "utf8"); } catch { /* absent: the turn writes it */ }
      if (held !== null && held !== RELAY_CODEX_CONFIG) line("codex home", `${codexConfigFile()} held changes of its own; relay replaces that file on every turn, so they never apply to a job, and the check below put relay's back first, as a turn does`);
      const checks: { access: "read" | "write"; problem: string | null; unchecked: string | null; note: string | null; released: readonly string[]; stage2: boolean }[] = [];
      for (const access of ["read", "write"] as const) {
        const { account, ...check } = await codexLaunchCheck(cfg, cwd, access);
        checks.push({ access, ...check });
        if (account !== undefined && codexLaunch.account === undefined) codexLaunch.account = account;
      }
      const unchecked = checks.find((c) => c.unchecked);
      const judged = checks.filter((c) => !c.stage2 && !c.unchecked);
      const refused = judged.filter((c) => c.problem);
      const where = `started in ${cwd}`;
      const which = `the configured default job (default model and speed, relay's tools, no grants)`;
      if (unchecked) line("codex launch", `not checked: ${unchecked.unchecked}. This says nothing about a job relay starts; run relay doctor in your own terminal`);
      else if (refused.length) {
        const same = refused.length === 2 && refused[0].problem === refused[1].problem;
        for (const c of same ? [refused[0]] : refused) warn("codex launch", `relay refuses Codex ${same ? "read and write" : c.access} jobs ${where}, by the checks each turn makes before it starts (${which}): ${c.problem}`);
      } else if (judged.length) line("codex launch", `Codex ${judged.map((c) => c.access).join(" and ")} jobs ${where} pass the checks each turn makes before it starts, on Codex's effective configuration with every layer (system, managed, this directory's project layers, relay's Codex home), for ${which}`);
      if (checks.some((c) => c.stage2)) line("", `Codex ${checks.filter((c) => c.stage2).map((c) => c.access).join(" and ")} jobs run under stage 2 here: see the codex stage 2 line`);
      // What Codex's own shell_environment_policy does with the names relay releases, as the turn says it in a note.
      const env = judged.find((c) => !c.problem);
      if (env?.note) warn("codex env", `for a Codex job ${where}: ${env.note}`);
      else if (env?.released.length) line("codex env", `for a Codex job ${where}, Codex passes the names relay releases to it (${env.released.join(", ")}) to the commands it runs, going by its effective configuration`);
    }
    // The person's own Codex home: their Codex sessions' (relay's registration there is the codex mcp line), not a layer of relay's jobs.
    line("your codex", `${path.dirname(userCodexConfigFile())}: your own Codex's home, for your Codex sessions. Relay's Codex jobs do not read it: they run with relay's Codex home (${relayCodexHome(cfg)}), so its config.toml, rules, skills, AGENTS.md and login do not apply to them`);
    // Exec-policy rules: what an allow rule does under relay's profile, and the network fallback.
    const codexEnv = { ...process.env, CODEX_HOME: relayCodexHome(cfg) };
    line("codex rules", codexRulesDoctor(codexEnv));
    // Stage 2 (raw network, backends/codex-stage2.ts), only while switched on: the settings its
    // admission needs, read as admission reads them. Codex's sandbox is off on those turns and relay's
    // own confines their commands, so the profile judged above does not apply to them.
    if (stage2Enabled(process.env, cfg)) {
      const wrong = stage2SettingsProblems(cfg, codexEnv, codexVersion(cfg.targets.codex.bin, codexEnv));
      if (wrong.length) warn("codex stage 2", `relay refuses Codex stage-2 jobs here: ${wrong.join("; ")}; no native strict or raw fallback`);
      else line("codex stage 2", "switched on: standing network grants (including child_network and kept grants on resume) use relay's executor and mediated proxy each turn; raw grants use raw egress. Codex's sandbox is off, relay confines commands and reads settings back. No Go/Swift TLS until Release B; tools ignoring proxy variables fail closed. Hosted search remains at OpenAI, disabled with never.hosts");
      // Each turn's teardown asks the kernel which processes are the turn's (the survivor sweep); without the helper, every turn is refused.
      const noSweep = sandboxCheckUnavailable();
      if (noSweep) warn("codex stage 2 sweep", `relay refuses Codex stage-2 jobs here: ${noSweep}. Rebuild relay where Xcode's command line tools are installed (\`npm run build\`), then restart it`);
    }
  }

  // Write jobs run in git worktrees. On a Mac without the developer tools /usr/bin/git is a stub
  // that opens an installer window, so it is not run unless the tools are there.
  const git = gitExecutable();
  const stub = git === "/usr/bin/git" && process.platform === "darwin" && spawnSync(systemTool("/usr/bin/xcode-select"), ["-p"], { encoding: "utf8" }).status !== 0;
  const gitVersion = git && !stub ? spawnSync(git, ["--version"], { encoding: "utf8" }) : null;
  if (!gitVersion || gitVersion.error || gitVersion.status !== 0) fail("git", `not found on PATH, or it does not run. Relay needs git${stub ? "; install Apple's command line tools with `xcode-select --install`" : ""}`);
  else line("git", `${first(gitVersion.stdout)} at ${git}`);

  // Which commit dist/ was built from, against the commit the checkout is at now. A pull or a
  // sync job's fast-forward changes the sources without rebuilding, which leaves the old code running.
  // An npm install has no checkout: its build is named by relay's build identity (the version and the
  // hash a shipped Codex pin names, core/build-identity.ts), with the commit its stamp records.
  const stamp = buildInfo();
  const npmName = npmInstallName();
  const rebuild = `cd ${sh([ROOT])} && npm ci && npm run build, then relay install <host> --write and restart the host's sessions`;
  if (npmName) {
    const from = stamp?.commit ? `; built from ${stamp.commit}${stamp.dirty ? " with uncommitted changes" : ""}${stamp.built_at ? ` on ${stamp.built_at}` : ""}` : "";
    let id: string | null = null;
    try { id = describeBuild(buildIdentity(ROOT)); } catch (err) {
      warn("build", `an npm install of ${npmName} (no git checkout), but relay could not take its build identity: ${errText(err)}. Reinstall it: npm install -g ${npmName}@${relayVersion()}`);
    }
    if (id) line("build", `an npm install of ${npmName} (no git checkout): ${id}${from}`);
  }
  else if (!stamp) warn("build", `no build stamp (${path.join("dist", "build-info.json")}), so relay cannot tell which commit dist/ was built from. Rebuild: ${rebuild}`);
  else if (!stamp.commit) line("build", "built outside a git checkout, so relay cannot tell which commit it was built from");
  else {
    const top = gitVersion?.status === 0 ? spawnSync(git!, ["-C", ROOT, "rev-parse", "--show-toplevel"], { encoding: "utf8" }) : null;
    const head = top?.status === 0 && canonical(top.stdout.trim()) === canonical(ROOT) ? spawnSync(git!, ["-C", ROOT, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8" }) : null;
    const at = head?.status === 0 ? head.stdout.trim() : null;
    const built = `built from ${stamp.commit}${stamp.dirty ? " with uncommitted changes" : ""}${stamp.built_at ? ` on ${stamp.built_at}` : ""}`;
    if (!at && !fs.existsSync(path.join(ROOT, ".git"))) line("build", `${built}; ${ROOT} is not a git checkout or an npm install, so there is no checkout's HEAD to compare it with`);
    else if (!at) line("build", `${built}; relay could not read the checkout's HEAD`);
    else if (at === stamp.commit) line("build", `${built}, the checkout's HEAD`);
    else warn("build", `${built}, but the checkout is now at ${at}, so the code running is not what the checkout holds. Rebuild: ${rebuild}`);
  }

  /** One line on whether a host's registration runs this checkout's launcher, in the current form. */
  const here = npmName ? "npm install" : "checkout";
  const registration = (label: string, host: HostId, command: unknown, args: unknown, extra = "", name = "relay") => {
    const again = reinstallCommand("install", host);
    if (relayCommandIdentity(command, args) === "ambiguous") return warn(label, `a server named ${name} is registered, but ${ambiguousNote(command)}. If it is an old relay of yours: ${again} --force (what is there is saved first)`);
    if (!isRelayCommand(command, args)) return warn(label, `a server named ${name} is registered, but it is not relay's (command ${String(command)})`);
    if (!mine(command)) return warn(label, `relay is registered from another checkout or install: ${String(command)}. To use this one: ${again}`);
    const list = args as unknown[];
    if (!list.includes("--host")) return warn(label, `relay is registered from this ${here} in an earlier form (no --host). Update it: ${again}`);
    // --host is the family relay serves the host's sessions as, so it must name a known target and
    // be this host's: relay refuses every call under an unknown one, and under another family's it
    // would judge the cross-family rule for the wrong family.
    const value = list[list.indexOf("--host") + 1];
    const own = hostDef(host).target;
    if (!isTarget(value)) {
      return fail(label, `relay is registered with --host ${value === undefined ? "and no value" : JSON.stringify(value)}, which is not a host relay knows (${TARGETS.map((t) => targetLabel(t, t.id)).join(", ")}), so relay refuses every call there. Fix it: ${again}`);
    }
    if (value !== own) {
      return fail(label, `relay is registered with --host ${value}, but ${hostDef(host).name}'s sessions are ${targetLabel(targetDef(own))} (--host ${own}), so relay would judge their calls as the wrong family. Fix it: ${again}`);
    }
    line(label, `relay registered, from this ${here}${extra}`);
  };
  const report: DoctorReport = { line, warn, fail, registration };

  // Each CLI's own login command. Relay runs each CLI under whatever login it reports here.
  for (const h of HOSTS) if (h.doctorLogin && present[h.target]) h.doctorLogin(cfg, report, h.target === "codex" ? codexLaunch : undefined);

  const bin = path.dirname(linkPath());
  const found = locate("relay");
  // Which `relay` a shell runs: this relay's launcher (the link install makes) or npm's global
  // command for this installed package are both this relay; anything else is not (relayCommandKind).
  const kind = found ? relayCommandKind(found) : null;
  if (onPath(bin)) line("PATH", `${bin} is on PATH`);
  else if (kind === "npm") line("PATH", `${bin} is not on PATH; not needed, since npm's command for this relay is`);
  else warn("PATH", `${bin} is not on PATH, so the link relay install makes there will not be found`);
  if (!found) warn("relay on PATH", `none. Run ${reinstallCommand("install", "<host>")}, or use ${LAUNCHER} directly`);
  else if (!kind) warn("relay on PATH", `${found} is not this relay (${ROOT}): it leads to ${canonical(found)}`);
  else {
    const what = `${found} (${kind === "launcher" ? "this relay's launcher" : "npm's global command for this relay"})`;
    // npm's command starts with `#!/usr/bin/env node`: the first node on PATH, where the launcher
    // chooses a Node of its own. Only the Node running this doctor is known to run relay. A relative
    // entry ahead of either directory lets a shell's current directory supply the command or its node.
    const node = kind === "npm" ? locate("node") : null;
    const relative = relativePathEntryBefore(path.dirname(found)) ?? (node ? relativePathEntryBefore(path.dirname(node)) : null);
    if (relative) warn("relay on PATH", `${what}, but PATH has the relative entry ${JSON.stringify(relative)} ahead of it${kind === "npm" ? " or of its node" : ""}, so in some directories a shell runs another \`relay\`${kind === "npm" ? " or \`node\`" : ""} instead`);
    else if (kind === "npm" && (!node || canonical(node) !== canonical(process.execPath))) {
      warn("relay on PATH", `${what}, but it runs the first node on PATH, ${node ?? "of which there is none"}, not the Node running this doctor (${process.execPath}), so relay cannot tell that it runs relay (Node ${MIN_NODE.join(".")} or newer). Run relay doctor through it, or use ${LAUNCHER}`);
    } else line("relay on PATH", what);
  }

  line("state dir", relayHome());
  if (cfgProblem) fail("config", cfgProblem);
  else line("config", `${configPath()}${fs.existsSync(configPath()) ? "" : " (not present; defaults in use)"}`);
  // What relay keeps (docs/security-model.md, "What is kept"), and whether the disk has room for more.
  const stored = storageReport(controlDirUsage(relayHome()), cfg);
  stored.lines.forEach((l, i) => line(i ? "" : "records", l));
  if (stored.warning) warn("disk", stored.warning);
  for (const problem of turnTempProblems()) warn("temp dirs", problem);
  line("limits", `max_depth=${cfg.max_depth} max_concurrent=${cfg.max_concurrent} block_s=${cfg.block_s}`);
  const dflt = (t: Target) => `${cfg.targets[t].default_model ?? "(CLI default)"} / ${cfg.targets[t].default_effort ?? "(CLI default)"}` +
    (cfg.targets[t].speed && cfg.targets[t].speed !== "standard" ? ` / ${cfg.targets[t].speed} speed` : "");
  line("defaults", TARGETS.filter((t) => cfg.targets[t.id].enabled).map((t) => `${targetLabel(t, t.id)}: ${dflt(t.id)}`).join("   "));
  // Authentication is a ceiling; exact environment selection is separately required.
  const enabled = TARGETS.filter((t) => cfg.targets[t.id].enabled);
  line("credentials", enabled.map((t) => `${targetLabel(t, t.id)}: ${t.capabilities.login === "key-only" ? "every inherited API key removed; only the key from its key file" : authFor(cfg, t.id) === "any" ? "only its own selected authentication inputs eligible; every other vendor's removed" : "every vendor's API keys removed"}`).join("; "));
  for (const t of TARGETS) {
    let preview: ReturnType<typeof selectEnvironment>;
    try { preview = selectEnvironment(t.id, cfg, capturedRootEnvironment); }
    catch (err) { line("environment", `${t.id}: refused: ${errText(err)}`); continue; }
    line("environment", `${t.id}: ${preview.policy.policy}; standing pass names: ${preview.policy.pass.join(", ") || "none"}; request-eligible names: ${preview.policy.request.join(", ") || "none"}`);
    // One line per outcome and reason, naming every variable it covers (included first): a line
    // per variable made this section as long as the environment, for each target.
    const outcomes = new Map<string, string[]>();
    for (const d of [...preview.diagnostics].sort((a, b) => Number(b.included) - Number(a.included))) {
      const what = `${d.included ? "included" : "dropped"} (${d.reason})`;
      outcomes.set(what, [...(outcomes.get(what) ?? []), d.name]);
    }
    for (const [what, names] of outcomes) line("", `${t.id}: ${what}, ${names.length} name${names.length === 1 ? "" : "s"}: ${names.join(", ")}`);
    line("", `${t.id}: HOME${t.id === "codex" ? ", CODEX_HOME" : ""}, and CLAUDE_CONFIG_DIR only when relay's environment sets it: supplied as trusted backend roots; relay identities, temp and confinement controls supplied by backend`);
  }

  doctorExtensions(cfg, line, warn);

  // Relay-enforced confinement: reported, never a failure here, since only harnesses that need it are refused.
  const confined = confinementSummary();
  line("confinement", confined.status);
  for (const e of confined.enforces) line("", `${confined.enabled ? "enforces" : "once enabled, enforces"}: ${e}`);
  for (const d of confined.doesNot) line("", `does not: ${d}`);

  for (const h of HOSTS) h.doctorRegistration(cfg, present, report);

  // Whether relay may take an answer in a Claude Code session as the person's, from the settings
  // files that apply in this directory (src/core/claude-settings.ts): the approval dialog and
  // confirm are each withheld where the mode or a hook could answer in the person's place.
  let consent: { dialog: string | null; confirm: string | null };
  try {
    consent = settingsAnswerForPerson(process.env, process.cwd(), []);
  } catch (err) {
    const why = `relay could not read Claude Code's settings (${errText(err).slice(0, 80)})`;
    consent = { dialog: why, confirm: why };
  }
  line("claude consent", `Claude Code sessions started in ${process.cwd()} (local settings read there, at its repository root and at its main checkout's root): approval dialog ${consent.dialog ? `withheld (${consent.dialog})` : "can be shown"}; confirm ${consent.confirm ? `withheld (${consent.confirm})` : "can be offered"}`);
  line("", "judged again when each session starts relay, with its settings, installed plugin hooks and manifest declarations, skill/subagent frontmatter, and command line (--dangerously-skip-permissions, --permission-mode, --settings); unreadable or uninspectable hook sources withhold consent routes. Command-line-only agent definitions, changes after startup and settings from the claude.ai console remain outside these checks");
  try {
    const inbound = inboundSettings(process.env, process.cwd());
    for (const setting of inbound) line("claude inbox", `crossSessionInbound ${setting.value} in ${setting.source}`);
    if (!inbound.length) line("claude inbox", "crossSessionInbound: no value found in readable settings files for this directory (Claude Code's per-message defaults may apply)");
  } catch {
    warn("claude inbox", "crossSessionInbound: unable to inspect the settings files for this directory");
  }
  line("", "Inbox values above are observed sources, not verified effective session settings: command-line overrides, settings-source selection, console-managed settings and runtime changes are not visible to doctor. hold withholds messages and refuse drops them, including relay notices; events still arrive with the next tool result. Every inbox pointer must pass status notice verification before action.");

  say(`\n${failed ? `${failed} requirement${failed === 1 ? "" : "s"} not met` : "requirements met"}${warned ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""}`);
  if (failed) process.exitCode = 1;
}

/**
 * Extensions (docs/extensions.md): what each target's launched agents may be given, whether the
 * skills and relay's MCP definitions are there, and that the definitions file, which may hold
 * credentials, is private. Then the legacy settings that waive relay's isolation of launched
 * agents (review C17), which no extension can be combined with.
 */
function doctorExtensions(cfg: RelayConfig, line: (l: string, t: string) => void, warn: (l: string, t: string) => void): void {
  const given = TARGETS.filter((t) => cfg.targets[t.id].enabled && hasExtensions(cfg.targets[t.id]));
  if (!given.length) line("extensions", "none allowed (targets.<id>.skills, targets.<id>.mcp_servers); launched agents get relay's isolation only");
  let defs: Record<string, unknown> | null = null;
  let defsProblem: string | null = null;
  if (given.some((t) => cfg.targets[t.id].mcp_servers?.length)) {
    try {
      defs = readMcpFile();
      const mode = fs.statSync(mcpFile()).mode;
      if (mode & 0o077) warn("mcp.json", `${mcpFile()} can be read by other users (mode ${(mode & 0o777).toString(8)}); it may hold credentials. chmod 600 it`);
    } catch (err) {
      defsProblem = errText(err);
    }
  }
  for (const t of given) {
    const e = cfg.targets[t.id];
    const label = "extensions";
    const skills = resolveSkills(e.skills, t.id);
    if ("reason" in skills) warn(label, `${t.id}: skills: ${skills.reason}; a call asking for extensions is refused until that is fixed`);
    else if (skills.length) line(label, `${t.id}: skills ${skills.map((s) => s.name).join(", ")} (copied for each turn: each skill's regular files, without hooks, MCP servers, agent definitions or pre-approved tools)`);
    const servers = e.mcp_servers ?? [];
    if (!servers.length) continue;
    const missing = defs ? servers.map(serverOf).filter((n) => !Object.hasOwn(defs!, n)) : [];
    if (defsProblem) warn(label, `${t.id}: MCP servers ${servers.map(serverOf).join(", ")}: ${defsProblem}; a call asking for extensions is refused until that is fixed`);
    else if (missing.length) warn(label, `${t.id}: MCP servers ${missing.join(", ")} are not defined in ${mcpFile()}; a call asking for extensions is refused until they are`);
    else {
      const shown = servers.map((x) => (typeof x === "string" || !x.allow_tools?.length ? serverOf(x) : `${x.name} (${x.allow_tools.join(", ")} without asking)`));
      line(label, `${t.id}: MCP servers ${shown.join(", ")}, defined in ${mcpFile()}`);
    }
    line("", "each runs outside the agent's sandbox as your own process, through relay; every other tool call asks you, and a job given them gets no network and no write paths outside its worktree, and may not start or steer other relay agents");
  }
  // child_settings concerns Claude Code's settings files alone, so only Claude's extensions conflict with it.
  for (const [key, on, what, whose] of [
    ["child_mcp", cfg.child_mcp === "inherit", "every MCP server of yours loads in launched agents, ungated", "Extensions"],
    ["child_hooks", cfg.child_hooks, "your hooks run in launched agents", "Extensions"],
    ["child_settings", cfg.child_settings === "inherit", "launched Claude agents load your settings, plugins and skills among them", "Extensions for Claude agents"],
  ] as const) {
    if (on) warn("isolation", `${key} waives relay's isolation of launched agents: ${what}. ${whose} cannot be combined with it; the per-target allowlists (targets.<id>.skills, targets.<id>.mcp_servers) are the gated way`);
  }
}

/** What `npm run build` recorded about the build (scripts/stamp-build.mjs), or null without a readable stamp. */
function buildInfo(): { commit: string | null; dirty: boolean | null; built_at?: string } | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "build-info.json"), "utf8"));
    if (info === null || typeof info !== "object" || (info.commit !== null && typeof info.commit !== "string")) return null;
    return { commit: info.commit, dirty: typeof info.dirty === "boolean" ? info.dirty : null, built_at: typeof info.built_at === "string" ? info.built_at : undefined };
  } catch {
    return null;
  }
}

export { relayVersion };
