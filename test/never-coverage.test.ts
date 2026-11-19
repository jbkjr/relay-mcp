// Which targets the never floor binds (core/never-coverage.ts): the one predicate the backends,
// approvals and doctor share, checked against what each of those actually does.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { harness } from "./helpers.ts";
import { NEVER_FLOOR_WHEN, neverFloorApplies, neverFloorCoverage, neverFloorReport, neverKeychainIpc } from "../dist/core/never-coverage.js";
import { blockedAdvice, consultHeader, delegationPreamble } from "../dist/core/prompts.js";
import { closeDbForTests, createRun, runConfig } from "../dist/core/db.js";
import { checkpointNever, readNeverFloor } from "../dist/core/never-checkpoint.js";
import { applyClaudeNeverPolicy } from "../dist/backends/claude.js";
import { managedSettingsProblem, managedSettingsRefusal } from "../dist/core/claude-settings.js";
import { neverAdapterProblem } from "../dist/backends/never-admission.js";
import { resolveNeverPolicy } from "../dist/core/never-policy.js";
import { STAGE2_FLAG_ENV } from "../dist/core/stage2-switch.js";
import { withDefaults } from "../dist/core/config.js";
import { TARGET_IDS, TARGETS, targetDef, targetLabel } from "../dist/targets/index.js";
import { turnPolicy } from "../dist/confine/turn.js";
import type { TurnSpec } from "../dist/backends/types.js";

const OFF = {} as NodeJS.ProcessEnv;
const cfgFor = (stage2: boolean, extra: Record<string, unknown> = {}) => withDefaults({ ...extra, targets: { codex: { stage2 } } } as never);

function withoutFlag<T>(fn: () => T): T {
  const saved = process.env[STAGE2_FLAG_ENV];
  delete process.env[STAGE2_FLAG_ENV];
  try { return fn(); } finally { if (saved === undefined) delete process.env[STAGE2_FLAG_ENV]; else process.env[STAGE2_FLAG_ENV] = saved; }
}

test("never coverage: every target has a rule; Codex and Claude always, the rest only with stage 2 on, by config or by the environment switch", () => {
  assert.deepEqual(Object.keys(NEVER_FLOOR_WHEN).sort(), [...TARGET_IDS].sort());
  for (const id of TARGET_IDS) {
    assert.equal(neverFloorApplies(id, cfgFor(false), OFF), id === "codex" || id === "claude", `${id}, stage 2 off`);
    assert.equal(neverFloorApplies(id, cfgFor(true), OFF), true, `${id}, stage 2 on`);
    assert.equal(neverFloorApplies(id, cfgFor(false), { [STAGE2_FLAG_ENV]: "1" }), true, `${id}, environment switch`);
  }
  assert.equal(neverFloorApplies("unknown-target", undefined, OFF), true, "an id the table does not know gets the floor");
  assert.equal(neverFloorCoverage("copilot", cfgFor(true), OFF), "refused");
  assert.equal(neverFloorCoverage("grok", cfgFor(true), OFF), "refused");
  assert.equal(neverFloorCoverage("gemini", cfgFor(true), OFF), "enforced");
  assert.equal(neverFloorCoverage("claude", cfgFor(false), OFF), "enforced");
  assert.equal(neverFloorCoverage("gemini", cfgFor(false), OFF), "not enforced");
});

test("never coverage: the admission gates and relay-owned profiles follow the predicate, for every target and either stage-2 state", () => withoutFlag(() => {
  const policy = resolveNeverPolicy({ builtins: false });
  for (const stage2 of [false, true]) for (const id of TARGET_IDS) {
    const coverage = neverFloorCoverage(id, cfgFor(stage2));
    const spec = (extra: Record<string, unknown> = {}) => ({ target: targetDef(id), config: cfgFor(stage2, extra), access: "write", neverPolicy: policy } as TurnSpec);
    const plain = neverAdapterProblem(spec());
    assert.equal(plain !== null, coverage === "refused", `${id}, stage 2 ${stage2}: ${plain}`);
    if (id === "claude") {
      // Claude's variant gates hold exactly where its floor does.
      for (const variant of [{ allow_dangerous: true }, { child_hooks: true }, { child_settings: "inherit" }, { child_mcp: "inherit" }]) {
        const problem = neverAdapterProblem(spec(variant));
        assert.equal(problem !== null, coverage === "enforced", `claude ${JSON.stringify(variant)}, stage 2 ${stage2}: ${problem}`);
      }
    }
    if (id !== "claude") {
      // The relay-owned outer profile (ACP targets, and Codex's stage-2 executor) carries the floor where it applies.
      const outer = turnPolicy({ cwd: "/decoy/work", access: "read", target: targetDef(id), neverPolicy: policy, config: cfgFor(stage2) }, { stateDirs: [], keychain: false }, "/decoy/tmp", { mode: "on" }, "/decoy/home", id);
      assert.equal(outer.neverPolicy !== undefined, neverFloorApplies(id, cfgFor(stage2)), `${id} profile, stage 2 ${stage2}`);
    }
  }
}));

const rows = TARGETS.map((t) => ({ id: t.id, label: targetLabel(t, t.id), enabled: t.id === "claude" || t.id === "codex" }));
const CLAUDE = "claude, enabled: path entries enforced, whatever stage 2 says; keychain IPC open; no inherited settings, hooks or MCP, managed settings, allow_dangerous writes or unsandboxed-command approvals";
const NOT_ENFORCED = "not enforced: that sandbox does not apply the floor's denies, so the agent can read the credential paths (~/.ssh, ~/.aws, CLI logins), keychain files and any never.paths of yours; relay's own config, install and key files stay protected there regardless.";
const KEYCHAIN_OPEN = "keychain IPC open: the agent's own sandbox lets its commands reach the security daemons. Items in file-based keychains (the login keychain, where gh's keyring token and git's osxkeychain credentials live) still stay out of reach, since reading one also needs its keychain file, which the floor denies (checked each release: qualification item 33 for Codex, release check claude-floor for Claude). What the daemons serve without that file, such as data-protection keychain items, is not covered, nor is a copy of a keychain file kept outside the denied directories. Only relay's own Seatbelt keeps the daemons closed.";
const PROXY = "for every agent, relay's network proxy, where a turn uses one (a Claude network grant, the ACP network-off route), still screens never hosts and ports.";
const heading = (on: boolean) => `the floor in each agent's sandbox, with stage 2 ${on ? "on" : "off"} (targets.codex.stage2): its path entries (never.paths and the built-ins, keychain files among them), and keychain IPC (the security daemons) separately:`;

test("never coverage: keychain IPC per target and network state: Claude's sandbox always open, Codex's open on network-on turns with stage 2 off, relay's Seatbelt closed", () => {
  assert.deepEqual(neverKeychainIpc("claude", cfgFor(false), OFF), { networkOff: "open", networkOn: "open" });
  assert.deepEqual(neverKeychainIpc("claude", cfgFor(true), OFF), { networkOff: "open", networkOn: "open" });
  assert.deepEqual(neverKeychainIpc("codex", cfgFor(false), OFF), { networkOff: "closed", networkOn: "open" });
  assert.deepEqual(neverKeychainIpc("codex", cfgFor(true), OFF), { networkOff: "closed", networkOn: "closed" }, "network turns run in relay's executor");
  assert.equal(neverKeychainIpc("gemini", cfgFor(false), OFF), null, "no floor, nothing to say");
  assert.deepEqual(neverKeychainIpc("gemini", cfgFor(true), OFF), { networkOff: "closed", networkOn: "closed" });
  for (const id of ["copilot", "grok"] as const) for (const on of [false, true]) assert.equal(neverKeychainIpc(id, cfgFor(on), OFF), null);
});

test("never coverage: doctor's report names each target, enabled or not, with stage 2 off", () => {
  assert.deepEqual(neverFloorReport(rows, cfgFor(false), OFF), [
    heading(false),
    CLAUDE,
    "codex, enabled: path entries enforced in every sandboxed turn's profile; keychain IPC closed on network-off turns, open on network-on turns",
    "copilot (experimental), not enabled: not enforced; refused with stage 2 on (its login route conflicts with the floor)",
    "gemini, not enabled: not enforced; enforced only with stage 2 on",
    "grok (experimental), not enabled: not enforced; refused with stage 2 on (its login route conflicts with the floor)",
    NOT_ENFORCED,
    KEYCHAIN_OPEN,
    PROXY,
  ]);
  const dangerous = neverFloorReport(rows, cfgFor(false, { allow_dangerous: true }), OFF);
  assert.equal(dangerous[1], "claude, enabled: path entries enforced, whatever stage 2 says; keychain IPC open; this config's allow_dangerous (write jobs) refuses its jobs");
  assert.equal(dangerous[2], "codex, enabled: path entries enforced in every sandboxed turn's profile; keychain IPC closed on network-off turns, open on network-on turns; not in allow_dangerous write turns, which run without a sandbox");
  assert.equal(neverFloorReport(rows, cfgFor(false, { child_settings: "inherit", child_hooks: true, child_mcp: "inherit" }), OFF)[1], 'claude, enabled: path entries enforced, whatever stage 2 says; keychain IPC open; this config\'s child_settings "inherit", child_hooks true, child_mcp "inherit" refuses its jobs');
});

test("never coverage: doctor's report with stage 2 on", () => {
  const on = [
    heading(true),
    CLAUDE,
    "codex, enabled: path entries enforced in every sandboxed turn's profile, and in relay's stage-2 executor; keychain IPC closed",
    "copilot (experimental), not enabled: refused: its login route conflicts with the floor",
    "gemini, not enabled: path entries enforced, only while stage 2 is on; keychain IPC closed",
    "grok (experimental), not enabled: refused: its login route conflicts with the floor",
    KEYCHAIN_OPEN,
    PROXY,
  ];
  assert.deepEqual(neverFloorReport(rows, cfgFor(true), OFF), on);
  assert.deepEqual(neverFloorReport(rows, cfgFor(false), { [STAGE2_FLAG_ENV]: "1" }), on);
  assert.equal(neverFloorReport(rows, cfgFor(true, { allow_dangerous: true }), OFF)[2], "codex, enabled: path entries enforced in every sandboxed turn's profile, and in relay's stage-2 executor; keychain IPC closed; allow_dangerous write jobs refused outside the stage-2 route");
});

test("never coverage: Claude's prompt never offers a command a way out of the sandbox (the floor refuses it)", () => {
  for (const mode of ["write", "read"] as const) for (const canAsk of [false, true]) for (const network of [false, true]) {
    const advice = blockedAdvice("claude", mode, canAsk, network);
    assert.doesNotMatch(advice, /retry that one command with the sandbox disabled|ask by retrying/, `${mode} canAsk=${canAsk} network=${network}`);
    if (canAsk && !network) assert.match(advice, /do not retry it with the sandbox disabled \(that is refused\)/);
  }
  assert.match(blockedAdvice("claude", "write", true, false), /A command the sandbox blocks cannot be approved to run outside it: report it under Open issues/);
});

test("never coverage: no managed-settings text says claude_managed_settings \"accept\" launches relay's Claude jobs, which carry the floor", () => {
  const managed = "/Library/Application Support/ClaudeCode/managed-settings.json";
  assert.equal(neverFloorApplies("claude", cfgFor(false), OFF), true, "the floor binds Claude jobs in both stage-2 states");
  // Doctor, where the floor binds Claude (always, today): refused whatever the setting says.
  const floored = managedSettingsProblem(managed, true);
  assert.match(floored, /organisation-managed Claude Code settings \(\/Library\/Application Support\/ClaudeCode\/managed-settings\.json\), which can override the never floor Claude jobs get, whatever claude_managed_settings says/);
  assert.match(floored, /"accept" does not permit them/);
  // Doctor's alternative, reached only where the floor does not bind Claude: "accept" would launch only such a launch.
  const unfloored = managedSettingsProblem(managed, false);
  assert.match(unfloored, /claude_managed_settings is "refuse"/);
  assert.match(unfloored, /"accept" would launch only Claude work the never floor does not bind/);
  // The backend's refusal on a route without the floor (no never policy): conditional, never a blanket "launch anyway".
  const refusal = managedSettingsRefusal(managed);
  assert.match(refusal, /does not launch Claude/);
  assert.match(refusal, /"claude_managed_settings": "accept" launches only on a route without relay's never floor/);
  assert.match(refusal, /relay's own Claude jobs carry the floor and are refused on this machine whatever that setting says/);
  for (const text of [floored, unfloored, refusal]) assert.doesNotMatch(text, /to launch anyway\.$/);
});

// Whether a prompt promises Claude's web tools an approval prompt. The prompt cannot know that they
// are denied: the run's durable floor can gain a never host after its config was captured
// (core/never-checkpoint.ts), and the person's own deny rules are copied in (backends/claude.ts). So
// wherever it sends the agent to WebSearch or WebFetch, every sentence that says they ask for
// approval also says policy may allow or deny them outright, and the text says what to do after a
// policy denial (finish and report, no retry, no second request).
const sentences = (s: string) => s.split(/(?<=[.])\s+/);
const WEB_OFFER = /Web(?:Search|Fetch)/;
const WEB_CONDITIONAL = /depending on permission policy, may already be allowed, may ask for approval, or may be denied outright/;
const AFTER_POLICY_DENIAL = /If policy denies them, do not retry them or ask again: finish what you can and report what you needed\./;
function promisesWebApproval(text: string): boolean {
  if (!WEB_OFFER.test(text)) return false;
  return !AFTER_POLICY_DENIAL.test(text) ||
    sentences(text).some((s) => WEB_OFFER.test(s) && /ask(?:s)? for approval/.test(s) && !WEB_CONDITIONAL.test(s));
}

test("never coverage: no rendered blocked-advice offers an approval route the turn cannot use (target × mode × network × never.hosts × asking)", () => {
  const invitesApproval = /you may ask for approval/;
  for (const target of TARGET_IDS) for (const mode of ["write", "read"] as const) for (const network of [false, true]) for (const webDenied of [false, true]) for (const canAsk of [false, true]) {
    const label = `${target} ${mode} network=${network} never.hosts=${webDenied} canAsk=${canAsk}`;
    const advice = blockedAdvice(target, mode, canAsk, network, webDenied);
    // Never "a blocked command cannot be approved" alongside an invitation to ask approval for one.
    if (/cannot be approved/.test(advice)) {
      for (const s of sentences(advice).filter((x) => invitesApproval.test(x))) assert.doesNotMatch(s, /command/, `${label}: ${advice}`);
    }
    if (target !== "claude") {
      // never.hosts changes nothing in other targets' advice.
      assert.equal(advice, blockedAdvice(target, mode, canAsk, network, false), label);
      continue;
    }
    // A network-granted read turn has nothing it can ask for: its web tools are allowed outright (or,
    // with never.hosts, denied outright) and a blocked command cannot be approved. Finish and report.
    if (mode === "read" && network) {
      assert.doesNotMatch(advice, invitesApproval, `${label}: ${advice}`);
      assert.match(advice, /do not work around it\. Finish what you can and say exactly what you needed/, label);
    }
    // Web tools already allowed (network) or denied (never.hosts) are never said to ask for approval.
    if (network || webDenied) assert.doesNotMatch(advice, /Web(?:Search|Fetch)[^.]*ask for approval/, `${label}: ${advice}`);
    // With never.hosts, Claude's web tools are denied: they are not offered at all.
    if (webDenied) assert.doesNotMatch(advice, /use Web(?:Search|Fetch)/, `${label}: ${advice}`);
    // A read turn with nothing granted and the web tools available may still ask, for the web only.
    if (mode === "read" && !network && !webDenied && canAsk) assert.match(advice, /\(web access\), you may ask for approval: use WebSearch or WebFetch/, `${label}: ${advice}`);
    // Even where the captured never.hosts is empty, the turn's effective policy may deny the web
    // tools (a durable-floor host added later, a copied user deny rule): no rendering promises them
    // an approval prompt, and wherever they are offered the agent is told what a policy denial means.
    assert.equal(promisesWebApproval(advice), false, `${label}: ${advice}`);
    if (!network && !webDenied && canAsk) {
      assert.match(advice, WEB_CONDITIONAL, label);
      assert.match(advice, AFTER_POLICY_DENIAL, label);
    }
  }
  // Codex's advice, which asks by escalating a command, is unchanged.
  assert.equal(blockedAdvice("codex", "read", true, true, true), "If you genuinely need something your sandbox blocks (a command the read-only sandbox blocks), you may ask for approval: request escalated permissions for that one command. The request goes to the user and may take a while. If it is denied, do not work around it; finish what you can and say what you needed. You cannot ask to change files; this session stays read-only.");
  assert.equal(blockedAdvice("codex", "write", true, false), "If you genuinely need something your sandbox blocks (the network, or a path outside your worktree), you may ask for approval: request escalated permissions for that one command. The request goes to the user and may take a while. If it is denied, do not work around it; finish what you can and say what you needed.");
  assert.equal(blockedAdvice("codex", "read", false, false), "If you need something your sandbox blocks (web access, or a command the read-only sandbox blocks), do not work around it. Finish what you can and say exactly what you needed, so it can be granted.");
});

test("never coverage: a Claude consult header and preambles promise no web approval when the run's durable floor gained a never host after its config was captured", () => {
  closeDbForTests();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-web-floor-")));
  const saved = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = path.join(root, "registry");
  process.env.RELAY_CONFIG = path.join(root, "config.json");
  try {
    // Model-free: nothing here touches a keychain or starts an agent.
    const base = {
      targets: { codex: { home: path.join(root, "codex-home") } },
      never: { override_builtin: [{ id: "credentials.keychain", acknowledge: "REMOVE BUILT-IN NEVER credentials.keychain", reason: "model-free prompt fixture" }] },
    };
    const run = createRun(root, withDefaults(base as never), "web-floor-root");
    // Between turns the person adds a never host; the grant checkpoint folds it into the durable floor.
    fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(withDefaults({ ...base, never: { ...base.never, hosts: ["review.example"] } } as never)));
    checkpointNever(run, "grant");
    const cfg = runConfig(run);
    const floor = readNeverFloor(run)!;
    assert.deepEqual(cfg.never?.hosts ?? [], [], "the captured config still lists no host");
    assert.ok(floor.hosts.some((h: { host: string }) => h.host === "review.example"), "the durable floor holds the added host");
    const denyRules: string[] = [];
    applyClaudeNeverPolicy(floor, { filesystem: {} }, denyRules);
    assert.ok(denyRules.includes("WebSearch") && denyRules.includes("WebFetch"), "so the run's next Claude turn denies both web tools outright");
    const node = (mode: "read" | "write") => ({ id: `j_${mode}`, run_id: run, target: "claude", mode, depth: 1, allow_delegation: 0, branch: "relay/j_write", params_json: "{}" }) as never;
    const rendered = {
      consult: consultHeader("the root session", "claude", false, { canAsk: true, network: false, cfg }),
      "read preamble": delegationPreamble(node("read"), cfg, "root task", "parent task", undefined, undefined, true),
      "write preamble": delegationPreamble(node("write"), cfg, "root task", "parent task", undefined, undefined, true),
    };
    for (const [what, text] of Object.entries(rendered)) {
      // Rendered from the captured config, the text still sends the agent to its web tools...
      assert.match(text, WEB_OFFER, what);
      // ...but never as a promised approval prompt, and it says what to do when policy denies them.
      assert.equal(promisesWebApproval(text), false, `${what}: ${text}`);
      assert.doesNotMatch(text, /which ask for approval unless this turn already allows them/, what);
    }
  } finally {
    closeDbForTests();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("never coverage: a launched Claude's settings carry the floor with stage 2 off and on: denyRead/denyWrite, Read/Edit rules, no unsandboxed commands", async () => {
  for (const stage2 of [false, true]) {
    const h = await harness([{ steps: [{ reply: "ok" }] }], { targets: { codex: { stage2 } } }, { [STAGE2_FLAG_ENV]: "" });
    try {
      const job = await h.call("delegate", { target: "claude", task: "x", mode: "write", background: false });
      assert.equal(job.status, "done", JSON.stringify(job));
      const start = h.starts()[0];
      const settings = JSON.parse(fs.readFileSync(start.argv[start.argv.indexOf("--settings") + 1], "utf8"));
      const ssh = path.join(h.env.HOME, ".ssh");
      const floored = neverFloorApplies("claude", cfgFor(stage2), OFF);
      assert.equal(floored, true, "Claude gets the floor with stage 2 off too");
      assert.equal(settings.sandbox.filesystem.denyRead.includes(ssh), floored, `denyRead ~/.ssh, stage 2 ${stage2}`);
      assert.equal(settings.sandbox.filesystem.denyWrite.includes(ssh), floored, `denyWrite ~/.ssh, stage 2 ${stage2}`);
      assert.equal(settings.permissions.deny.includes(`Read(/${ssh})`), floored, `Read rule, stage 2 ${stage2}`);
      assert.equal(settings.permissions.deny.includes(`Edit(/${ssh}/**)`), floored, `Edit rule, stage 2 ${stage2}`);
      assert.equal(settings.sandbox.allowUnsandboxedCommands, false, "no command runs outside the sandbox");
    } finally {
      await h.close();
    }
  }
});
