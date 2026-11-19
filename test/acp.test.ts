import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { awaitConfined, callPaths, genericApproval, mergeToolCall, permissionOptions, permissionOutcome } from "../dist/backends/acp.js";
import { ConfinementRefused, prepareLaunch } from "../dist/confine/index.js";
import { sandboxed, SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
import { setBoundaryProbeForTests, type BoundaryProbe } from "../dist/confine/turn-probe.js";
import { selectEnvironment } from "../dist/core/env-policy.js";
import type { TurnSpec } from "../dist/backends/types.js";
import { pathToFileURL } from "node:url";
import { adoptRun, alive, harness, terminalApprove, INTERACTIVE_CLAUDE, nonTempScratch, scratchOnly, task, until, type Harness, type Rec, type Rule } from "./helpers.ts";

/**
 * The real per-turn boundary probes: a scratch guard through the setter in this process and a
 * preload in root servers. Workers use the production probe (W9 strips their NODE_OPTIONS).
 * A probe that escapes writes beside the harness binary, so it must be a scratch file (STUB_ACP).
 */
const REAL_PROBES: BoundaryProbe = (mechanism, policy, command, args, signal, environment) => prepareLaunch(mechanism, policy, scratchOnly(command, "harness"), args, signal, environment);
const REAL_PROBES_PRELOAD = `--import=${pathToFileURL(path.resolve(import.meta.dirname, "fixtures", "boundary-probes.mjs")).href}`;
const SLOW_PROBES_PRELOAD = `--import=${pathToFileURL(path.resolve(import.meta.dirname, "fixtures", "slow-boundary-probes.mjs")).href}`;

/** Direct backend calls have no root broker: select their synthetic controls explicitly, as
 * helpers.ts does for server tests. Never restore ambient inheritance or pass credential canaries. */
function stubEnvironment(spec: { target: Pick<TurnSpec["target"], "id">; config: TurnSpec["config"] }, rootEnv = process.env) {
  const config = { ...spec.config, child_env: { ...spec.config.child_env,
    pass: [...(spec.config.child_env?.pass ?? []), "STUB_SCENARIO", "STUB_ACP_IGNORE_TERM"],
  } };
  const selected = selectEnvironment(spec.target.id, config, rootEnv);
  return { config, environment: selected.env, environmentReleased: selected.releasedNames };
}

/** The ACP stub agent, as a scratch copy of test/stubs/stub-acp, so that no probe aims beside the checkout's files. */
const STUB_ACP = (() => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-stub-")));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const stubs = path.resolve(import.meta.dirname, "stubs");
  const href = (p: string) => JSON.stringify(pathToFileURL(path.join(stubs, p)).href);
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  const bin = path.join(dir, "stub-acp");
  fs.writeFileSync(bin, `#!/usr/bin/env node\nimport { main } from ${href("stub-agent.mjs")};\nimport acp from ${href("targets/acp.mjs")};\nawait main(acp);\n`, { mode: 0o755 });
  return scratchOnly(bin, "harness");
})();

const OFFERED = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

test("acp: direct fixtures select their controls and scratch home without ambient credentials", async () => {
  const { withDefaults } = await import("../dist/core/config.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const fixture = stubEnvironment({ target: targetDef("codex"), config: withDefaults({}) }, {
    PATH: process.env.PATH, HOME: os.tmpdir(), STUB_SCENARIO: "/synthetic/scenario.json",
    STUB_ACP_IGNORE_TERM: "ignore-termination", NPM_TOKEN: "must-not-pass", NEUTRAL_ALIAS: "must-not-pass-either",
  });
  assert.equal(fixture.environment.HOME, os.tmpdir());
  assert.equal(fixture.environment.STUB_SCENARIO, "/synthetic/scenario.json");
  assert.equal(fixture.environment.STUB_ACP_IGNORE_TERM, "ignore-termination");
  assert.equal(fixture.environment.NPM_TOKEN, undefined);
  assert.equal(fixture.environment.NEUTRAL_ALIAS, undefined);
  assert.deepEqual(fixture.environmentReleased.sort(), ["STUB_ACP_IGNORE_TERM", "STUB_SCENARIO"]);
});

test("acp: answers to approval requests use only offered options, and never allow_always", () => {
  assert.deepEqual(permissionOutcome(OFFERED, true), { outcome: "selected", optionId: "once" });
  assert.deepEqual(permissionOutcome(OFFERED, false), { outcome: "selected", optionId: "no" });
  // Allowed, but the agent offers only "always": relay will not answer with it, so it refuses.
  const noOnce = OFFERED.filter((o) => o.kind !== "allow_once");
  assert.deepEqual(permissionOutcome(noOnce, true), { outcome: "selected", optionId: "no" });
  // Nothing to refuse with but "always" options: cancelled, which every agent must accept.
  assert.deepEqual(permissionOutcome([{ optionId: "a", kind: "allow_always" }, { optionId: "r", kind: "reject_always" }], false), { outcome: "cancelled" });
  assert.deepEqual(permissionOutcome([], true), { outcome: "cancelled" });
  assert.deepEqual(permissionOptions([...OFFERED, null, { optionId: 3, kind: "allow_once" }, { kind: "allow_once" }, "x"]), OFFERED, "malformed options are dropped");
  assert.deepEqual(permissionOptions(undefined), []);
});

test("acp: an approval request is read from the tool call it refers to, and refused when what it would do is unclear", () => {
  // A request names a tool call announced earlier; what it would do is in that announcement.
  const announced = mergeToolCall(undefined, { toolCallId: "c1", title: "Run shell command", kind: "execute", status: "pending", rawInput: { command: "make test", description: "run the tests" } });
  const joined = mergeToolCall(announced, { toolCallId: "c1", status: "in_progress", title: null });
  assert.equal(joined.title, "Run shell command", "fields not sent are kept");
  assert.equal(joined.status, "in_progress");
  assert.deepEqual(genericApproval(joined), { kind: "command", summary: "make test", reason: "run the tests", detail: { tool_call: "c1" } });
  assert.deepEqual(genericApproval({ toolCallId: "c2", kind: "execute", rawInput: { command: ["git", "status"], cwd: "/w" } })?.summary, "git status");

  const edit = { toolCallId: "c3", kind: "edit", title: "Editing", locations: [{ path: "/w/a.ts" }], content: [{ type: "diff", path: "/w/b.ts" }], rawInput: { file_path: "/w/a.ts" } };
  assert.deepEqual(callPaths(edit), ["/w/a.ts", "/w/b.ts"]);
  assert.deepEqual(genericApproval(edit), { kind: "file", summary: "edit /w/a.ts, /w/b.ts", reason: "Editing", paths: ["/w/a.ts", "/w/b.ts"], detail: { tool_call: "c3" } });
  assert.equal(genericApproval({ toolCallId: "c4", kind: "fetch", rawInput: { url: "https://example.com" } })?.summary, "fetch https://example.com");
  assert.deepEqual(genericApproval({ toolCallId: "c6", kind: "execute", rawInput: { command: ["rm", "-rf", "a b"] } })?.detail, { argv: ["rm", "-rf", "a b"], tool_call: "c6" });
  // Kinds without a reviewed reading are refused, whatever input they carry.
  for (const kind of ["read", "search", "think", "switch_mode", "other", undefined]) {
    assert.equal(genericApproval({ toolCallId: "c5", kind, title: "Reading", rawInput: { path: "x", query: "y" } }), null, String(kind));
  }

  // Sparse or unknown requests: nothing to show anyone, so they are refused without asking.
  for (const call of [
    { toolCallId: "s1", title: "Do something" },
    { toolCallId: "s2", kind: "execute", title: "Run", rawInput: {} },
    { toolCallId: "s3", kind: "execute", rawInput: { command: "  " } },
    { toolCallId: "s4", kind: "edit", title: "Editing", rawInput: { text: "x" } },
    { toolCallId: "s5", kind: "fetch", rawInput: {} },
    { toolCallId: "s6", kind: "other", rawInput: [] },
    { toolCallId: "s7", kind: "think" },
  ]) assert.equal(genericApproval(call), null, call.toolCallId);
});

test("acp: Copilot's check of a path outside its trusted directories is a path request, its access read from the call it announced", async () => {
  const { copilotProfile } = await import("../dist/backends/copilot.js");
  const { askableReadOnly } = await import("../dist/backends/types.js");
  const spec = { cwd: "/w/job" } as never;
  // Exactly as Copilot 1.0.98 sent it in a signed-in run (j_a7963b11; docs/qualification/copilot-1.0.98.md, 7):
  // an apply_patch announced as an edit, then a request of kind "read" for the file it would add.
  const p = "/private/tmp/rq-B8eZ/outside/escape.txt";
  const announced = mergeToolCall(undefined, { toolCallId: "custom_call_w0", title: "apply_patch", kind: "edit", status: "pending", rawInput: `*** Begin Patch\n*** Add File: ${p}\n+hi\n*** End Patch\n` });
  const request = { toolCallId: "custom_call_w0", title: "Access paths outside trusted directories", kind: "read", status: "pending", rawInput: { path: p }, locations: [{ path: p }] };
  const asked = copilotProfile.normalizeApproval(mergeToolCall(announced, request), spec, announced);
  assert.deepEqual(asked, {
    kind: "path", summary: `write ${p}`, reason: "Copilot's own check of paths outside its trusted directories, for its tool call: apply_patch (edit)",
    paths: [p], detail: { cwd: p, path_access: "write", tool_call: "custom_call_w0", announced_kind: "edit", confined: true },
  });
  // Its file viewer reads; a command, or a call never announced, could do either, and relay cannot tell.
  const view = mergeToolCall(undefined, { toolCallId: "v", title: `Viewing ${p}`, kind: "read", status: "pending", rawInput: { path: p } });
  assert.equal(copilotProfile.normalizeApproval(mergeToolCall(view, { ...request, toolCallId: "v" }), spec, view)?.summary, `read ${p}`);
  const cmd = mergeToolCall(undefined, { toolCallId: "c", title: "Copy the file", kind: "execute", rawInput: { command: `cp ${p} .`, description: "Copy the file" } });
  const viaCommand = copilotProfile.normalizeApproval(mergeToolCall(cmd, { ...request, toolCallId: "c" }), spec, cmd);
  assert.equal(viaCommand?.summary, `read or write ${p}`);
  assert.equal(viaCommand?.reason, `Copilot's own check of paths outside its trusted directories, for its command: cp ${p} .`);
  const unannounced = copilotProfile.normalizeApproval({ ...request, toolCallId: "n" }, spec, undefined);
  assert.equal(unannounced?.summary, `read or write ${p}`);
  assert.equal(unannounced?.reason, "Copilot's own check of paths outside its trusted directories, for a tool call it did not describe");
  // Relative paths against the agent's directory; for several, in_directory is the directory holding them all.
  const several = copilotProfile.normalizeApproval({ ...request, rawInput: { path: "../a/x" }, locations: [{ path: "/w/b/y" }] }, spec, undefined);
  assert.deepEqual(several?.paths, ["/w/a/x", "/w/b/y"]);
  assert.equal((several?.detail as { cwd: string }).cwd, "/w");
  // Naming no path, it is refused without asking; under another title it is read as any other request (kind "read": refused).
  assert.equal(copilotProfile.normalizeApproval({ ...request, rawInput: {}, locations: [] }, spec, announced), null);
  assert.equal(copilotProfile.normalizeApproval({ ...request, title: "Access other things" }, spec, announced), null);
  // A read-only turn may ask past the check only for a path the agent would read.
  assert.deepEqual([asked, viaCommand, unannounced, copilotProfile.normalizeApproval(mergeToolCall(view, { ...request, toolCallId: "v" }), spec, view)].map((a) => askableReadOnly(a!)), [false, false, false, true]);
  assert.equal(askableReadOnly({ kind: "file", detail: { path_access: "read" } }), false, "a change of files never is");
});

test("acp: the launched harness counts as confined only on the kernel's yes about its own pid, asked again within milliseconds of an early no, and is refused once the wait is over", async () => {
  // No three times (sandbox-exec still applying the profile), then yes: four asks, each about the
  // launched pid, done well within the 300 ms that a fixed 100 ms pause after each no took.
  const asked: number[] = [];
  let t0 = Date.now();
  assert.equal(await awaitConfined((pid) => (asked.push(pid), asked.length > 3), 4242), true);
  assert.deepEqual(asked, [4242, 4242, 4242, 4242]);
  assert.ok(Date.now() - t0 < 250, `the asks after an early no came within ${Date.now() - t0} ms`);
  // Never yes: not confined once the wait is over, however often it was asked.
  let asks = 0;
  t0 = Date.now();
  assert.equal(await awaitConfined(() => (asks++, false), 4242, 300), false);
  assert.ok(Date.now() - t0 >= 300, "the whole wait was given");
  assert.ok(asks > 2 && asks < 30, `asked ${asks} times in 300 ms`);
});

test("acp: a harness relay confines itself is refused, before it starts, where that confinement cannot be applied", async () => {
  const { startAcpTurn, genericApproval: normalizeApproval } = await import("../dist/backends/acp.js");
  const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const base = targetDef("codex");
  const target = { ...base, name: "Probe", capabilities: { ...base.capabilities, confinement: "relay-enforced", networkOff: false } };
  const stub = STUB_ACP;
  const spec = (config: Record<string, unknown>) => ({
    target, prompt: "x", cwd: os.tmpdir(), access: "read", relay: null, dir: os.tmpdir(), logPath: path.join(os.tmpdir(), "relay-acp-probe.log"),
    config: { ...DEFAULT_CONFIG, ...config, targets: { ...DEFAULT_CONFIG.targets, codex: { enabled: true, bin: stub } } }, markers: { runId: "r", nodeId: "n", depth: 1 },
  });
  const profile = { args: () => ["--acp"], scrub: () => false, login: { how: "", verify: () => null }, normalizeApproval };
  // A harness relay has no way to check the login of is not launched on a login-only setup.
  const { loginStrategyProblem } = await import("../dist/backends/acp.js");
  const noWay = { args: () => [], scrub: () => false, login: { how: "" }, normalizeApproval };
  await assert.rejects(startAcpTurn(spec({ child_network: true }) as never, noWay), /no way to check that Probe is signed in with an account/);
  assert.equal(loginStrategyProblem(noWay, spec({ child_auth: "any" }) as never), null, "with child_auth any, nothing to check");
  assert.equal(loginStrategyProblem({ login: { how: "", reuse: ["x"] } }, spec({}) as never), null);
  // A boundary probe that fails refuses the launch, whatever else holds: nothing is started.
  setBoundaryProbeForTests(async () => {
    throw new ConfinementRefused("stand-in", "relay will not launch the harness: boundary probe stand-in allowed; expected deny");
  });
  await assert.rejects(startAcpTurn(spec({ child_network: true, allow_temp_home: true }) as never, profile), process.platform === "darwin" ? /boundary probe stand-in allowed; expected deny/ : /runs only inside relay's own sandbox/);
  // The real probes, on a scratch copy of the stub: the checks after them are reached.
  setBoundaryProbeForTests(REAL_PROBES);
  // No network access, and no API hosts declared for the proxy to admit: refused, never run on the open network.
  if (process.platform === "darwin") await assert.rejects(startAcpTurn(spec({ allow_temp_home: true }) as never, profile), /cannot keep Probe off the network: relay does not know which hosts it needs/);
  setBoundaryProbeForTests(null);
  // A harness's own sandbox is not taken on its word over ACP: there is no verifier for it yet.
  const verified = { ...target, capabilities: { ...target.capabilities, confinement: "verified" } };
  await assert.rejects(startAcpTurn({ ...spec({ child_network: true }), target: verified } as never, profile), /no way yet to verify Probe's own sandbox/);
  if (process.platform !== "darwin") {
    await assert.rejects(startAcpTurn(spec({ child_network: true }) as never, profile), /runs only inside relay's own sandbox/);
  }
  const none = { ...target, capabilities: { ...target.capabilities, confinement: "none" } };
  await assert.rejects(startAcpTurn({ ...spec({ child_network: true }), target: none } as never, profile), /no confinement relay can enforce or verify/);
});

test("acp: relay's own sandbox goes around the whole harness: confirmed by the kernel, writes only where the policy allows", { skip: process.platform !== "darwin" }, async () => {
  const { startAcpTurn, genericApproval: normalizeApproval } = await import("../dist/backends/acp.js");
  const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-confined-")));
  const [wt, outside, state] = ["wt", "outside", "state"].map((d) => path.join(root, d));
  for (const d of [wt, outside, state]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify({ rules: [{ steps: [
    { run: `echo x > ${JSON.stringify(path.join(outside, "escaped.txt"))}; echo y > "$TMPDIR/scratch.txt"` },
    { write: "inside.txt" },
    { reply: "confined reply" },
  ] }] }));
  const saved = process.env.STUB_SCENARIO;
  const savedHome = process.env.HOME;
  process.env.STUB_SCENARIO = path.join(root, "scenario.json");
  try {
    const base = targetDef("codex");
    const target = { ...base, name: "Probe", capabilities: { ...base.capabilities, confinement: "relay-enforced" } };
    // The real boundary probes run in this process, stood in as only a test can: a scratch home and harness, never the real ones.
    setBoundaryProbeForTests(REAL_PROBES);
    process.env.HOME = path.join(root, "home");
    fs.mkdirSync(process.env.HOME);
    const spec = {
      target, prompt: "go", cwd: wt, access: "write", relay: null, dir: root, logPath: path.join(root, "agent.log"),
      config: { ...DEFAULT_CONFIG, child_network: true, allow_temp_home: true, targets: { ...DEFAULT_CONFIG.targets, codex: { enabled: true, bin: STUB_ACP } } },
      markers: { runId: "r", nodeId: "n", depth: 1 },
    };
    const profile = {
      args: () => ["--acp"], scrub: () => false, login: { how: "", verify: () => null }, normalizeApproval,
      prepareState: () => (fs.chmodSync(state, 0o700), { stateDirs: [], persistent: { root: state, writable: ["session-state"] }, env: { COPILOT_HOME: state }, keychain: false }),
    };
    Object.assign(spec, stubEnvironment(spec));
    const handle = await startAcpTurn(spec as never, profile);
    const r = await handle.done;
    assert.equal(r.status, "ok", `${r.error}\n${fs.readFileSync(spec.logPath, "utf8")}`);
    assert.equal(r.finalMessage, "confined reply");
    assert.ok(fs.existsSync(path.join(wt, "inside.txt")), "the worktree of a write turn is writable");
    assert.ok(!fs.existsSync(path.join(outside, "escaped.txt")), "nothing outside it is");
    assert.ok(fs.existsSync(path.join(state, "session-state")) || fs.readdirSync(state).length > 0, "the harness's state directory is writable");
    const log = fs.readFileSync(spec.logPath, "utf8");
    assert.match(log, /\/usr\/bin\/sandbox-exec/, "launched under sandbox-exec");
    assert.match(log, /# relay boundary probes: \d+ passed in \d+ ms( \(\d+ not applicable this turn: [\w, -]+\))?; profile [0-9a-f]{64}/, "after the real boundary probes passed");
    assert.match(log, /STUB-RECORD .*"event":"start"/);
    // These callbacks are authorization-relevant records, unlike best-effort progress. A write
    // failure must fail the turn, and must never bypass the stricter model-switch stop. That stop is
    // for a switch to another family, so the stand-in runs several families' models here: a
    // single-family harness's switch stays within its family and goes on.
    const multi = { ...target, vendor: null, models: { "gpt-6.1-sol": "openai", "claude-sonnet-5.5": "anthropic" } };
    for (const same_family of ["allow", "refuse"]) {
      fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify({ rules: [{ steps: [
        { hook: { switchModel: "claude-sonnet-5.5", currentModelUpdate: true } }, { reply: "must not succeed" },
      ] }] }));
      let records = 0;
      const broken = await startAcpTurn({ ...spec, target: multi, model: "gpt-6.1-sol", config: { ...spec.config, same_family }, onServed: () => { if (++records === 2) throw new Error("simulated database write failure"); } } as never, profile);
      const failed = await broken.done;
      assert.equal(failed.status, "failed");
      assert.match(failed.error!, same_family === "allow" ? /could not record the model.*stopped/ : /changed its model mid-turn.*stopped/);
      assert.equal(records, 2, "the update was processed without an uncaught callback exception");
    }
  } finally {
    setBoundaryProbeForTests(null);
    process.env.HOME = savedHome;
    if (saved === undefined) delete process.env.STUB_SCENARIO;
    else process.env.STUB_SCENARIO = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("acp: a target's login-store grant reaches the sandbox: in the real login directory a refresh by temp file and rename works, and nothing else does (D10)", { skip: process.platform !== "darwin" }, async (t) => {
  const { startAcpTurn, genericApproval: normalizeApproval, loginStore } = await import("../dist/backends/acp.js");
  const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-store-")));
  const [wt, home] = ["wt", "home"].map((d) => path.join(root, d));
  // A decoy of the person's login directory, in a scratch HOME: never the real one.
  const store = path.join(home, ".probe");
  for (const d of [wt, store]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(store, "auth.json"), "decoy-token\n", { mode: 0o600 });
  fs.writeFileSync(path.join(store, "config.toml"), "decoy-config\n", { mode: 0o600 });
  const S = JSON.stringify(store);
  fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify({ rules: [{ steps: [
    { run: `printf refreshed > ${S}/.71.0.tmp && chmod 600 ${S}/.71.0.tmp && mv ${S}/.71.0.tmp ${S}/auth.json && echo ok > refresh.txt; (echo x >> ${S}/config.toml) 2>/dev/null || echo refused > config.txt; (echo x > ${S}/other.txt) 2>/dev/null || echo refused > other.txt; ln -s /etc/hosts ${S}/.72.0.tmp 2>/dev/null || echo refused > link.txt` },
    { reply: "store reply" },
  ] }] }));
  const saved = { scenario: process.env.STUB_SCENARIO, home: process.env.HOME, relayHome: process.env.RELAY_HOME };
  process.env.STUB_SCENARIO = path.join(root, "scenario.json");
  try {
    const grant = { name: "Probe's login directory", dir: ".probe", files: ["auth.json"], locks: ["auth.json.lock"], tempName: String.raw`^\.[0-9]+\.[0-9]+\.tmp$` };
    // The grant is the target's, its directory relative to the person's home.
    assert.deepEqual(loginStore(grant, home), { ...grant, dir: store });
    for (const dir of ["", ".", "..", "../x", "a/../b", "/abs", "a//b", "a\nb"]) assert.throws(() => loginStore({ ...grant, dir }, home), /relative to the home folder/, JSON.stringify(dir));
    const base = targetDef("codex");
    const target = { ...base, name: "Probe", capabilities: { ...base.capabilities, confinement: "relay-enforced" }, tokenStore: grant };
    setBoundaryProbeForTests(REAL_PROBES);
    process.env.HOME = home;
    process.env.RELAY_HOME = path.join(root, "control");
    const spec = {
      target, prompt: "go", cwd: wt, access: "write", relay: null, dir: root, logPath: path.join(root, "agent.log"),
      config: { ...DEFAULT_CONFIG, child_network: true, allow_temp_home: true, targets: { ...DEFAULT_CONFIG.targets, codex: { enabled: true, bin: STUB_ACP } } },
      markers: { runId: "r", nodeId: "n", depth: 1 },
    };
    const profile = { args: () => ["--acp"], scrub: () => false, login: { how: "Run `grok login` again before using Grok.", verify: () => fs.existsSync(path.join(store, "auth.json")) ? null : "Not signed in; run grok login" }, normalizeApproval, prepareState: () => ({ stateDirs: [], keychain: false, home: "temp" }) };
    Object.assign(spec, stubEnvironment(spec));
    const r = await (await startAcpTurn(spec as never, profile)).done;
    const log = fs.readFileSync(spec.logPath, "utf8");
    assert.equal(r.status, "ok", `${r.error}\n${log}`);
    const read = (f: string) => fs.readFileSync(path.join(wt, f), "utf8").trim();
    assert.equal(read("refresh.txt"), "ok");
    assert.equal(fs.readFileSync(path.join(store, "auth.json"), "utf8"), "refreshed", "the token, replaced by the refresh");
    for (const f of ["config.txt", "other.txt", "link.txt"]) assert.equal(read(f), "refused", f);
    assert.deepEqual(fs.readdirSync(store).sort(), ["auth.json", "config.toml"]);
    assert.equal(fs.readFileSync(path.join(store, "config.toml"), "utf8"), "decoy-config\n");
    assert.match(log, /# relay login store: Probe's login directory \(.*\.probe\): its token, lock and temp names only/);
    assert.match(log, /# relay boundary probes: \d+ passed/, "with the store's decoy probes among them");
    // An exchange (renamex_np RENAME_SWAP) can put a symbolic link at the token's name, which no rule
    // can tell from a rename: relay checks the store as soon as the turn is over, fails the turn and
    // says so, and the next turn is refused (review r_75bf1f48).
    const victim = path.join(root, "victim");
    fs.writeFileSync(victim, "decoy-victim\n");
    const swapJs = path.join(root, "swap.cjs");
    fs.writeFileSync(swapJs, `const [a, b] = process.argv.slice(2); require("fs").symlinkSync(${JSON.stringify(victim)}, a); const r = require("child_process").spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'ObjC.bindFunction("renamex_np",["int",["char *","char *","unsigned int"]]);String($.renamex_np(' + JSON.stringify(a) + ',' + JSON.stringify(b) + ',2))'], { encoding: "utf8" }); require("fs").writeFileSync("swap.txt", r.stdout.trim());\n`);
    fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify({ rules: [{ steps: [
      { run: `${JSON.stringify(process.execPath)} ${JSON.stringify(swapJs)} "$TMPDIR/l" ${S}/auth.json` },
      { reply: "swapped" },
    ] }] }));
    const readFile = fs.readFileSync.bind(fs);
    const reads = t.mock.method(fs, "readFileSync", (file: fs.PathOrFileDescriptor, ...args: any[]) => {
      assert.notEqual(file, victim, "relay must not read the exchanged link's target");
      return Reflect.apply(readFile, fs, [file, ...args]);
    });
    const swapped = await (await startAcpTurn(spec as never, profile)).done;
    reads.mock.restore();
    assert.equal(read("swap.txt"), "0", "the exchange got through, as measured");
    assert.equal(swapped.status, "failed", JSON.stringify(swapped));
    assert.match(swapped.error ?? "", /Probe's login directory is not as relay left it: .*auth\.json is a symbolic link/);
    assert.match(swapped.error ?? "", /quarantined.*auth\.json.*control\/quarantine\/r\/n\//);
    assert.match(swapped.error ?? "", /grok login.*again before using Grok/);
    assert.match(swapped.error ?? "", /Relay refuses this harness's turns until the store passes its check/);
    assert.equal(fs.lstatSync(path.join(store, "auth.json"), { throwIfNoEntry: false }), undefined);
    const quarantine = path.join(root, "control", "quarantine", "r", "n");
    const moved = path.join(quarantine, fs.readdirSync(quarantine)[0], "auth.json");
    assert.ok(fs.lstatSync(moved).isSymbolicLink());
    assert.equal(fs.readlinkSync(moved), victim);
    await assert.rejects(async () => {
      const next = await (await startAcpTurn(spec as never, profile)).done;
      if (next.status !== "ok") throw new Error(next.error);
    }, /Not signed in; run grok login/, "and the next turn gets the login refusal");
    assert.equal(fs.readFileSync(victim, "utf8"), "decoy-victim\n");
  } finally {
    setBoundaryProbeForTests(null);
    process.env.HOME = saved.home;
    if (saved.relayHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = saved.relayHome;
    if (saved.scenario === undefined) delete process.env.STUB_SCENARIO;
    else process.env.STUB_SCENARIO = saved.scenario;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("acp: without network access, the harness reaches only its target's API hosts, through a proxy relay starts for the turn and closes with it (redteam.md, known gap)", { skip: process.platform !== "darwin" }, async () => {
  const { startAcpTurn, genericApproval: normalizeApproval } = await import("../dist/backends/acp.js");
  const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-proxy-")));
  const [wt, run] = ["wt", "run"].map((d) => path.join(root, d));
  for (const d of [wt, run]) fs.mkdirSync(d);
  // A listed host that never resolves (.invalid), so nothing leaves the machine: the proxy's own
  // reason then shows the name passed its allowlist (the positive control), where an unlisted one
  // is refused for not being on it. Through curl, which takes the proxy from HTTPS_PROXY.
  const listed = "relay-probe.invalid";
  const curl = (host: string) => `/usr/bin/curl -s -m 5 -o /dev/null https://${host}/ || true`;
  fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify({ rules: [{ steps: [
    { run: `${curl("unlisted.example")}; ${curl(listed)}; printf %s "$HTTPS_PROXY" | /usr/bin/sed -E 's/:[^:@]*@/:@/' > proxy-url.txt` },
    { reply: "offline reply" },
  ] }] }));
  const saved = { scenario: process.env.STUB_SCENARIO, home: process.env.HOME };
  process.env.STUB_SCENARIO = path.join(root, "scenario.json");
  try {
    const base = targetDef("codex");
    const target = { ...base, name: "Probe", apiHosts: [listed], capabilities: { ...base.capabilities, confinement: "relay-enforced", networkOff: true } };
    setBoundaryProbeForTests(REAL_PROBES);
    process.env.HOME = path.join(root, "home");
    fs.mkdirSync(process.env.HOME);
    const spec = {
      target, prompt: "go", cwd: wt, access: "write", relay: null, dir: run, logPath: path.join(run, "agent.log"),
      config: { ...DEFAULT_CONFIG, child_network: false, allow_temp_home: true, targets: { ...DEFAULT_CONFIG.targets, codex: { enabled: true, bin: STUB_ACP } } },
      markers: { runId: "r", nodeId: "n", depth: 1 },
    };
    const profile = { args: () => ["--acp"], scrub: () => false, login: { how: "", verify: () => null }, normalizeApproval };
    Object.assign(spec, stubEnvironment(spec));
    const r = await (await startAcpTurn(spec as never, profile)).done;
    const log = fs.readFileSync(spec.logPath, "utf8");
    assert.equal(r.status, "ok", `${r.error}\n${log}`);
    assert.equal(r.finalMessage, "offline reply");
    assert.match(log, new RegExp(`# relay network: off, except relay's proxy to ${listed.replace(/\./g, "\\.")} \\(decisions in ${path.join(run, "proxy.jsonl").replace(/[.\\/]/g, "\\$&")}\\)`));
    const decisions = fs.readFileSync(path.join(run, "proxy.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const of = (host: string) => decisions.find((d) => d.target === `${host}:443`);
    assert.equal(of("unlisted.example")?.reason, "host-not-allowlisted", JSON.stringify(decisions));
    // Listed: past the allowlist; refused only because the name does not resolve.
    assert.match(of(listed)?.reason ?? "", /^unresolved: /, JSON.stringify(decisions));
    assert.ok(decisions.every((d) => d.turn === "n/-"), "each decision names the turn");
    assert.match(log, /\[proxy\] deny unlisted\.example:443 \(host-not-allowlisted\)/, "and the turn's own log says what was refused");
    // The harness was pointed at the turn's proxy on loopback, with a token (the stub saved it with the token cut out).
    const url = /^http:\/\/relay:@127\.0\.0\.1:(\d+)$/.exec(fs.readFileSync(path.join(wt, "proxy-url.txt"), "utf8"));
    assert.ok(url, "HTTPS_PROXY points at relay's proxy");
    // Closed with the turn: nothing listens on its port any more.
    const closed = await new Promise<string>((resolve) => {
      const s = net.connect(Number(url![1]), "127.0.0.1");
      s.once("connect", () => (s.destroy(), resolve("connected")));
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
    });
    assert.equal(closed, "ECONNREFUSED", "the turn's proxy is gone once the turn is");
    // Declaring no API hosts, a target cannot be run off the network at all.
    const none = { ...target, apiHosts: undefined };
    await assert.rejects(startAcpTurn({ ...spec, target: none } as never, profile), /cannot keep Probe off the network: relay does not know which hosts it needs/);
  } finally {
    setBoundaryProbeForTests(null);
    process.env.HOME = saved.home;
    if (saved.scenario === undefined) delete process.env.STUB_SCENARIO;
    else process.env.STUB_SCENARIO = saved.scenario;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("acp: a cancelled turn loses its network at once, while an agent that ignores the cancel is still alive (review r_7feaed80 C3)", { skip: process.platform !== "darwin" }, async () => {
  const { startAcpTurn, genericApproval: normalizeApproval } = await import("../dist/backends/acp.js");
  const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-revoke-")));
  const wt = path.join(root, "wt");
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify({ rules: [{ steps: [
    { run: `printf %s "$HTTPS_PROXY" | /usr/bin/sed -E 's/:[^:@]*@/:@/' > proxy-url.txt` },
    { hook: { awaitCancel: true } },
    { run: "sleep 20" },
    { reply: "too late" },
  ] }] }));
  const saved = { scenario: process.env.STUB_SCENARIO, home: process.env.HOME, ignore: process.env.STUB_ACP_IGNORE_TERM };
  process.env.STUB_SCENARIO = path.join(root, "scenario.json");
  process.env.STUB_ACP_IGNORE_TERM = "ignore-termination";
  try {
    const base = targetDef("codex");
    const target = { ...base, name: "Probe", apiHosts: ["relay-probe.invalid"], capabilities: { ...base.capabilities, confinement: "relay-enforced", networkOff: true } };
    setBoundaryProbeForTests(REAL_PROBES);
    process.env.HOME = path.join(root, "home");
    fs.mkdirSync(process.env.HOME);
    const spec = {
      target, prompt: "go", cwd: wt, access: "write", relay: null, dir: root, logPath: path.join(root, "agent.log"),
      config: { ...DEFAULT_CONFIG, child_network: false, allow_temp_home: true, cancel_grace_ms: 4000, targets: { ...DEFAULT_CONFIG.targets, codex: { enabled: true, bin: STUB_ACP } } },
      markers: { runId: "r", nodeId: "n", depth: 1 },
    };
    const profile = { args: () => ["--acp"], scrub: () => false, login: { how: "", verify: () => null }, normalizeApproval };
    Object.assign(spec, stubEnvironment(spec));
    const handle = await startAcpTurn(spec as never, profile);
    await until(() => fs.existsSync(path.join(wt, "proxy-url.txt")) && fs.readFileSync(path.join(wt, "proxy-url.txt"), "utf8").length > 0, 15000, "the agent started its prompt");
    const port = Number(/:(\d+)$/.exec(fs.readFileSync(path.join(wt, "proxy-url.txt"), "utf8"))![1]);
    const connect = () => new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => (s.destroy(), resolve("connected")));
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
    });
    assert.equal(await connect(), "connected", "the positive control: the turn's proxy is up while the turn runs");
    const cancelling = handle.cancel();
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alive(handle.pid), "the agent ignores the cancel and is still running");
    assert.equal(await connect(), "ECONNREFUSED", "but its proxy is already closed");
    await cancelling;
    assert.equal((await handle.done).status, "interrupted");
  } finally {
    setBoundaryProbeForTests(null);
    process.env.HOME = saved.home;
    for (const [k, v] of [["STUB_SCENARIO", saved.scenario], ["STUB_ACP_IGNORE_TERM", saved.ignore]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("acp: a profile's harness state reaches the sandbox whole: a temporary home with the harness's variables, links to login files, token files and extra executables (E8); its environment cannot replace relay's, nor point the harness elsewhere (E10)", { skip: process.platform !== "darwin" }, async () => {
  const { startAcpTurn, genericApproval: normalizeApproval } = await import("../dist/backends/acp.js");
  const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-state-")));
  // A stand-in login store and tool directory of the harness's own, outside every writable root.
  const [wt, store, tools] = ["wt", "store", "tools"].map((d) => path.join(root, d));
  for (const d of [wt, store, tools]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(store, "creds.json"), "decoy-login\n", { mode: 0o600 });
  const token = path.join(store, "token.json");
  fs.writeFileSync(token, "decoy-token\n", { mode: 0o600 });
  fs.writeFileSync(path.join(tools, "helper.sh"), "#!/bin/sh\necho helper-ran\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify({ rules: [{ steps: [
    { run: `printf %s "$PROBE_HOME" > home-var.txt; printf %s "$HOME" > home.txt; cat "$PROBE_HOME/creds.json" > creds-seen.txt; echo refreshed >> ${JSON.stringify(token)}; ${JSON.stringify(path.join(tools, "helper.sh"))} > helper-out.txt` },
    { reply: "state reply" },
  ] }] }));
  const saved = { scenario: process.env.STUB_SCENARIO, home: process.env.HOME };
  process.env.STUB_SCENARIO = path.join(root, "scenario.json");
  try {
    const base = targetDef("codex");
    const target = { ...base, name: "Probe", capabilities: { ...base.capabilities, confinement: "relay-enforced" } };
    setBoundaryProbeForTests(REAL_PROBES);
    process.env.HOME = path.join(root, "home");
    fs.mkdirSync(process.env.HOME);
    const spec = {
      target, prompt: "go", cwd: wt, access: "write", relay: null, dir: root, logPath: path.join(root, "agent.log"),
      config: { ...DEFAULT_CONFIG, child_network: true, allow_temp_home: true, targets: { ...DEFAULT_CONFIG.targets, codex: { enabled: true, bin: STUB_ACP } } },
      markers: { runId: "r", nodeId: "n", depth: 1 },
    };
    const state = (extra: Record<string, unknown> = {}) => ({
      stateDirs: [], keychain: false, home: "temp", homeVars: { PROBE_HOME: "probe" }, links: { "probe/creds.json": path.join(store, "creds.json") },
      tokenFiles: [token], execPaths: [path.join(tools, "helper.sh")], env: { PROBE_FLAG: "1" }, ...extra,
    });
    const profile = (extra: Record<string, unknown> = {}) => ({ args: () => ["--acp"], scrub: () => false, login: { how: "", verify: () => null }, normalizeApproval, prepareState: () => state(extra) });
    Object.assign(spec, stubEnvironment(spec));
    const r = await (await startAcpTurn(spec as never, profile())).done;
    const log = fs.readFileSync(spec.logPath, "utf8");
    assert.equal(r.status, "ok", `${r.error}\n${log}`);
    const read = (f: string) => fs.readFileSync(path.join(wt, f), "utf8").trim();
    const home = read("home.txt");
    assert.ok(home.endsWith("/home") && home.includes("/.relay-t/relay-tmp-"), `a temporary home of the turn's own, under relay's protected root (${home})`);
    assert.equal(read("home-var.txt"), path.join(home, "probe"), "the harness's own home variable, inside it");
    assert.equal(read("creds-seen.txt"), "decoy-login", "the login file, read through the link");
    assert.equal(fs.readFileSync(token, "utf8"), "decoy-token\nrefreshed\n", "the token file, rewritten in place");
    assert.equal(read("helper-out.txt"), "helper-ran", "an executable the profile named, outside relay's fixed list");
    // Relay's own variables are not the profile's to set, and a variable pointing the harness at another endpoint is refused.
    await assert.rejects(startAcpTurn(spec as never, profile({ env: { NODE_OPTIONS: "--require=/tmp/x.js" } })), /state\.env cannot set NODE_OPTIONS/);
    await assert.rejects(startAcpTurn(spec as never, profile({ env: { OPENAI_BASE_URL: "https://elsewhere.example" } })), /OPENAI_BASE_URL/);
  } finally {
    setBoundaryProbeForTests(null);
    process.env.HOME = saved.home;
    if (saved.scenario === undefined) delete process.env.STUB_SCENARIO;
    else process.env.STUB_SCENARIO = saved.scenario;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Conformance: Copilot's target, driven over ACP by the stub agent (test/stubs/targets/acp.mjs),
// under relay's own sandbox on macOS. The stub writes its records to stderr, which relay keeps in
// the agent's log, since a confined harness cannot write where the other stubs keep theirs.

const macOS = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
const onMac = macOS ? test : test.skip;
/** Copilot switched on, pointed at the stub, experimental use allowed, and the network on (relay's proxy does not exist yet). */
const COPILOT = (extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  same_family: "refuse", child_network: true, ...top, targets: { copilot: { enabled: true, bin: STUB_ACP, experimental: true, ...extra } },
});
const GPT = "gpt-6.1-sol";
/**
 * A test harness whose relay-enforced launches run the real per-turn boundary probes, with its
 * scratch HOME (helpers.ts) and scratch stub, so no probe aims at the real home or checkout.
 */
const acpHarness = (rules: Rule[], config: Record<string, unknown>, env: Record<string, string> = {}) => harness(rules, config, { NODE_OPTIONS: REAL_PROBES_PRELOAD, ...env });

/**
 * A root session in Claude Code for each harness, the run owner for Copilot calls: tests reach
 * Copilot from a Claude caller unless they say otherwise.
 */
const roots = new Map<Harness, Awaited<ReturnType<Harness["instance"]>>>();

for (const fail of [false, true]) onMac(`acp: bare per-turn proxy and bridge secrets are cut from logs, results and errors (${fail ? "failure" : "success"})`, async () => {
  const h = await acpHarness([{ target: "copilot", steps: [{ bareTurnSecrets: true, fail }] }], COPILOT({}, { child_network: false }));
  try {
    const r = await root(h).call("delegate", { target: "copilot", model: GPT, task: "print turn credentials", mode: "write", background: false });
    const n = h.sql("SELECT * FROM nodes WHERE id = ?", r.job_id)[0];
    const values = JSON.parse(fs.readFileSync(path.join(n.worktree, "turn-secrets.json"), "utf8")) as string[];
    assert.equal(values.length, 2);
    assert.ok(values.every((v) => typeof v === "string" && v.length >= 22));
    const log = fs.readFileSync(n.log_path, "utf8");
    const turns = JSON.stringify(h.sql("SELECT reply, error, activity FROM turns WHERE node_id = ?", n.id));
    for (const text of [log, JSON.stringify(r), turns]) {
      for (const value of values) assert.ok(!text.includes(value), "bare generated secret was cut");
      assert.match(text, /\[redacted: proxy token\]/);
      assert.match(text, /\[redacted: bridge secret\]/);
    }
    const turn = h.sql("SELECT * FROM turns WHERE node_id = ?", n.id)[0];
    assert.ok(turn.tmp_dir && turn.tmp_dev !== null && turn.tmp_ino !== null, "the actual launch recorded its private directory identity");
    assert.equal(fs.existsSync(turn.tmp_dir), false, "ordinary turn cleanup removed its private directory");
    if (fail) assert.match(turn.error, /\[redacted: bridge secret\]/);
    else assert.match(fs.readFileSync(path.join(path.dirname(n.log_path), `final-${turn.id}.md`), "utf8"), /\[redacted: proxy token\]/);
  } finally { await h.close(); }
});
for (const kind of ["environment", "proxy", "bridge"]) onMac(`X3: ${kind} credentials split across actual ACP chunks cannot be reconstructed from the log`, async () => {
  const step = kind === "environment" ? { bareEnvironmentSecret: "NPM_TOKEN" } : { bareTurnSecrets: kind };
  const h = await acpHarness([{ target: "copilot", steps: [step] }], COPILOT({}, { child_network: false, child_env: { pass: kind === "environment" ? ["NPM_TOKEN"] : [] } }), { NPM_TOKEN: "opaque-credential-aB79xQ42" });
  try {
    const r = await root(h).call("delegate", { target: "copilot", model: GPT, task: "split secret", mode: "write", background: false });
    assert.equal(r.status, "done", JSON.stringify(r));
    const logPath = h.sql("SELECT log_path FROM nodes WHERE id = ?", r.job_id)[0].log_path;
    const text = fs.readFileSync(logPath, "utf8").split("\n").filter((line) => line.includes('"agent_message_chunk"')).map((line) => JSON.parse(line).params.update.content.text).join("");
    assert.equal(text, "Let me look. [redacted]", `${kind}: the pieces as well as the complete value must be cut`);
  } finally { await h.close(); }
});
const pendingRoots = new Map<Harness, Promise<Awaited<ReturnType<Harness["instance"]>>>>();
function root(h: Harness) {
  return {
    call: async (tool: string, args: Record<string, unknown> = {}) => {
      if (!roots.has(h)) {
        if (!pendingRoots.has(h)) pendingRoots.set(h, h.instance({ args: ["--host", "claude"] }));
        roots.set(h, await pendingRoots.get(h)!);
      }
      return roots.get(h)!.call(tool, args);
    },
  };
}

/** Everything the stub ACP agents of this harness recorded, from the agents' logs, in order. */
function acpRecords(h: Harness): Rec[] {
  const out: Rec[] = [];
  for (const { log_path } of h.sql("SELECT DISTINCT log_path FROM nodes WHERE target = 'copilot' AND log_path IS NOT NULL")) {
    if (!fs.existsSync(log_path)) continue;
    for (const line of fs.readFileSync(log_path, "utf8").split("\n")) {
      const m = /^\[stderr\] STUB-RECORD (.*)$/.exec(line);
      if (m) out.push(JSON.parse(m[1]));
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
const acpStarts = (h: Harness) => acpRecords(h).filter((r) => r.event === "start");
const agentLog = (h: Harness, id: string) => fs.readFileSync(h.sql("SELECT log_path FROM nodes WHERE id = ?", id)[0].log_path, "utf8");

onMac("family allow ACP: auto, no model, unlisted, same family, switches and pinned mismatch", async () => {
  for (const model of ["auto", undefined, "unlisted-model", "claude-sonnet-5.5"]) {
    const h = await acpHarness([{ target: "copilot", steps: [{ reply: "ok" }] }], COPILOT({}, { same_family: "allow" }));
    try {
      const r = await root(h).call("delegate", { target: "copilot", ...(model ? { model } : {}), task: "family", mode: "read", background: false });
      assert.equal(r.status, "done", JSON.stringify(r));
      assert.equal(r.families.launched, model === "claude-sonnet-5.5" ? "anthropic" : "unknown");
      if (model === "claude-sonnet-5.5") assert.equal(r.families.relation, "same-family");
      if (!model) assert.equal(acpStarts(h)[0].argv.includes("--model"), false);
      assert.ok(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", r.job_id)[0].params_json).served_models.length);
    } finally { await h.close(); }
  }
  for (const switched of ["claude-sonnet-5.5", "unlisted-model"]) {
    const h = await acpHarness([{ target: "copilot", steps: [
      { hook: { switchModel: switched, awaitModel: true } },
      { call: "ask", args: { message: "after switch" }, as: "nested" }, { reply: "finished" },
    ] }], COPILOT({}, { same_family: "allow" }));
    try {
      const r = await root(h).call("delegate", { target: "copilot", model: GPT, task: "switch", mode: "read" });
      const done = await root(h).call("status", { id: r.job_id, wait_s: 60 });
      assert.equal(done.status, "done", JSON.stringify(done));
      assert.equal(done.families.launched, "unknown");
      assert.ok(done.result.warnings.length);
      const children = h.sql("SELECT target FROM nodes WHERE parent_id = ?", r.job_id);
      if (switched === "claude-sonnet-5.5") assert.equal(children[0].target, "codex");
      else assert.equal(children.length, 0, "explicit unknown never falls back to pinned GPT routing");
    } finally { await h.close(); }
  }
  for (const same_family of ["allow", "refuse"]) {
    const h = await acpHarness([], COPILOT({}, { same_family }), { STUB_ACP_REPORT: JSON.stringify({ model: "claude-sonnet-5.5", pinModel: true }) });
    try {
      const r = await root(h).call("delegate", { target: "copilot", model: GPT, task: "mismatch", mode: "read", background: false });
      assert.equal(r.status, "failed");
      assert.match(r.error, /not the.*relay asked for/);
      assert.equal(acpStarts(h).length, 0);
    } finally { await h.close(); }
  }
  const policy = await acpHarness([{ target: "copilot", steps: [{ reply: "automatic choice" }] }], COPILOT({}, { same_family: "allow" }), { STUB_ACP_REPORT: JSON.stringify({ model: GPT, pinModel: true }) });
  try {
    fs.mkdirSync(path.join(policy.repo, ".github"));
    fs.writeFileSync(path.join(policy.repo, ".github/allowed_models.txt"), "claude-sonnet-5.5\n");
    const pinned = await root(policy).call("delegate", { target: "copilot", model: GPT, task: "pinned policy", mode: "read", background: false });
    assert.equal(pinned.status, "failed");
    assert.match(pinned.error, /allowed_models.txt/);
    for (const model of ["auto", undefined]) {
      const r = await root(policy).call("delegate", { target: "copilot", ...(model ? { model } : {}), task: "automatic policy", mode: "read", background: false });
      assert.equal(r.status, "done", JSON.stringify(r));
      assert.equal(r.families.launched, "unknown", "auto remains unknown even when the harness reports a listed GPT model");
    }
  } finally { await policy.close(); }
});

onMac("review ACP: current_model_update is authoritative under both policies, including a missing id", async () => {
  for (const same_family of ["allow", "refuse"]) for (const missingModel of [false, true]) {
    const h = await acpHarness([{ target: "copilot", steps: [
      { hook: { switchModel: "claude-sonnet-5.5", currentModelUpdate: true, missingModel, awaitModel: same_family === "allow", awaitCancel: same_family === "refuse" } },
      { reply: "carried on" },
    ] }], COPILOT({}, { same_family }));
    try {
      const r = await root(h).call("delegate", { target: "copilot", model: GPT, task: "current model", mode: "read", background: false });
      assert.equal(r.status, same_family === "allow" ? "done" : "failed", JSON.stringify(r));
      if (same_family === "allow") {
        assert.equal(r.families.launched, "unknown");
        assert.match(r.result.warnings.join(" "), missingModel ? /to null/ : /claude-sonnet/);
      } else assert.match(r.error, /changed its model mid-turn.*stopped it/);
      const p = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", r.job_id)[0].params_json);
      assert.equal(p.served_model, missingModel ? null : "claude-sonnet-5.5");
    } finally { await h.close(); }
  }
});

onMac("acp: a read job runs confined over ACP v1, with login, mode and model read back before the prompt, and only Copilot loses GitHub tokens", async () => {
  const rules: Rule[] = [{ target: "copilot", match: task("READ1"), steps: [{ run: "echo x > blocked.txt; echo y > \"$TMPDIR/ok.txt\"" }, { reply: "read reply" }] }];
  // The user's own Copilot home, with a config.json nobody may read: relay only links to it.
  const userCopilot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-user-copilot-")));
  fs.writeFileSync(path.join(userCopilot, "config.json"), '{"token":"plaintext-secret"}', { mode: 0o000 });
  const h = await acpHarness(rules, COPILOT(), { COPILOT_HOME: userCopilot, GH_TOKEN: "gh-secret", GITHUB_TOKEN: "gh-secret-2", COPILOT_GITHUB_TOKEN: "cp-secret", COPILOT_ALLOW_ALL: "true", ANTHROPIC_API_KEY: "sk-ant" });
  try {
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "READ1", mode: "read", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.equal(job.result.final_message, "read reply", "the reply is what came after the last tool call, nothing replayed or said before it");
    assert.ok(!fs.existsSync(path.join(h.repo, "blocked.txt")), "a read job cannot write the checkout it reads");
    const node = h.sql("SELECT * FROM nodes WHERE id = ?", job.job_id)[0];
    assert.equal(node.model, GPT, "the model the family was judged by is kept with the session");
    // Progress and usage, as the native backends report them.
    assert.equal(h.sql("SELECT activity FROM turns WHERE node_id = ?", job.job_id)[0].activity, "Reading README.md");
    assert.deepEqual(
      [job.usage.input_tokens, job.usage.output_tokens, job.usage.total_tokens, job.usage.cached_input_tokens, job.usage.cost_usd],
      [120, 30, 150, 10, 0.0123], JSON.stringify(job.usage),
    );
    assert.match(job.resume_natively.command, new RegExp(`COPILOT_HOME='[^']*${job.job_id}/copilot' copilot --resume='${acpStarts(h)[0].sessionId}'`), JSON.stringify(job.resume_natively));

    const recs = acpRecords(h);
    const init = recs.find((r) => r.event === "initialize")!;
    assert.equal(init.protocolVersion, 1);
    assert.deepEqual(init.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, "relay offers the agent no file system or terminal");
    const logins = recs.filter((r) => r.event === "authenticate");
    assert.deepEqual(logins.map((r) => [r.methodId, r.session]), [["copilot-login", false], ["copilot-login", true]], "the login is checked with the login-reuse method only, before the session and again once it exists");
    const session = recs.find((r) => r.event === "session")!;
    assert.equal(session.method, "session/new");
    assert.equal(session.cwd, h.repo);
    assert.deepEqual(session.mcpServers, ["relay"], "the turn's relay server, through the bridge");
    const start = acpStarts(h)[0];
    assert.equal(start.model, GPT);
    assert.equal(start.mode, "https://agentclientprotocol.com/protocol/session-modes#agent");
    for (const f of ["--acp", "--no-auto-update", "--allow-all-tools", "--disable-builtin-mcps"]) assert.ok(start.argv.includes(f), f);
    // Every tool a signed-in 1.0.98 session listed that starts or drives a subagent, which runs a model of its own choosing.
    const excluded = start.argv.find((a: string) => a.startsWith("--excluded-tools="))?.slice("--excluded-tools=".length).split(",");
    assert.deepEqual(excluded, ["task", "search_code_subagent", "run_dynamic_workflow", "dynamic_workflows_manage", "read_agent", "list_agents", "write_agent"]);
    assert.equal(start.argv[start.argv.indexOf("--model") + 1], GPT);
    assert.deepEqual(start.clientMethods, { fs: -32601, terminal: -32601 }, "client methods relay never offered are refused at once");
    // Credentials: Copilot's own token and the GitHub tokens that would replace its stored login are gone; so is everything else of Copilot's.
    assert.deepEqual([start.env.copilotToken, start.env.ghToken, start.env.githubToken, start.env.anthropicKey, start.env.allowAll], [false, false, false, false, null]);
    assert.equal(start.env.autoUpdate, "false");
    const home = start.env.copilotHome;
    assert.ok(home.startsWith(`${h.home}-harness/`) && home.includes(job.job_id), `a Copilot home of relay's own per session, outside its control directory (${home})`);
    // The login: a link to the user's own config.json, which relay never opens (it is unreadable here).
    assert.equal(fs.readlinkSync(path.join(home, "config.json")), path.join(userCopilot, "config.json"));
    assert.ok(!fs.existsSync(path.join(home, "turn")), "the turn's own logs and caches are gone with it");
    const settings = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
    assert.equal(settings.sandbox.enabled, false, "Copilot's own sandbox is off: it would nest inside relay's");
    assert.equal(settings.disableAllHooks, true);
    // By absolute path: Copilot 1.0.98 ignores relative entries (a signed-in skill listing still showed .claude/skills with them).
    for (const d of [".claude/skills", ".claude/agents", ".claude/commands"]) assert.ok(settings.ignoredSkillsLocations.includes(path.join(h.repo, d)), `Claude Code's ${d} in the repository are not imported`);
    assert.ok(settings.ignoredSkillsLocations.every((p: string) => path.isAbsolute(p)), JSON.stringify(settings.ignoredSkillsLocations));
    assert.ok(settings.subagents.disabledSubagents.includes("rubber-duck"), "no subagent of another model");
    assert.ok(start.env.tmpdir && !fs.existsSync(start.env.tmpdir), "the turn's private temp directory is removed with the turn");

    // GH_TOKEN is Copilot's to lose only: passed by the person (child_env.pass), other agents get
    // it, for gh; Copilot's login guard still keeps it from Copilot, and no other agent gets
    // Copilot's own token even when it is listed. Unpassed, the allowlist gives it to nobody.
    const { childEnv } = await import("../dist/backends/env.js");
    const { withDefaults } = await import("../dist/core/config.js");
    const { targetDef } = await import("../dist/targets/index.js");
    const { selectEnvironment } = await import("../dist/core/env-policy.js");
    const rootEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: "gh", GITHUB_TOKEN: "gh2", COPILOT_GITHUB_TOKEN: "cp" };
    const passAll = { child_env: { pass: ["GH_TOKEN", "GITHUB_TOKEN"] } };
    const env = (t: string, cfg: Record<string, unknown> = passAll) => {
      const config = withDefaults(cfg);
      const selected = selectEnvironment(t as never, config, rootEnv);
      return childEnv({ target: targetDef(t), config, environment: selected.env, environmentReleased: selected.releasedNames, markers: { runId: "r", nodeId: "n", depth: 1 } } as never, () => false);
    };
    for (const t of ["claude", "codex"]) {
      assert.equal(env(t).GH_TOKEN, "gh", `${t} gets a passed GH_TOKEN`);
      assert.equal(env(t).GITHUB_TOKEN, "gh2", `${t} gets a passed GITHUB_TOKEN`);
      assert.equal(env(t).COPILOT_GITHUB_TOKEN, undefined, `${t} is not handed Copilot's token`);
      assert.equal(env(t, {}).GH_TOKEN, undefined, `${t} gets no GH_TOKEN under the default allowlist`);
    }
    assert.deepEqual([env("copilot").GH_TOKEN, env("copilot").GITHUB_TOKEN, env("copilot").COPILOT_GITHUB_TOKEN], [undefined, undefined, undefined]);
    // Copilot set to sign in with anything keeps its own tokens, when they are passed.
    const any = env("copilot", { ...passAll, targets: { copilot: { child_auth: "any", child_env: { pass: ["COPILOT_GITHUB_TOKEN"] } } } });
    assert.deepEqual([any.GH_TOKEN, any.COPILOT_GITHUB_TOKEN], ["gh", "cp"]);
  } finally {
    await h.close();
    fs.rmSync(userCopilot, { recursive: true, force: true });
  }
});

onMac("acp: Copilot's home is relay's: the agent cannot change its settings or add to it, and a swapped session directory stops the next turn", async () => {
  const userCopilot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-user-copilot-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-outside-")));
  const rules: Rule[] = [{
    target: "copilot", turn: 1, match: task("TAMPER"), steps: [
      { run: 'echo \'{"sandbox":{"enabled":true}}\' > "$COPILOT_HOME/settings.json"; touch "$COPILOT_HOME/planted" "$COPILOT_HOME/mcp-config.json"; echo ok > "$COPILOT_HOME/session-state/mine.txt"' },
      { run: `rm -rf "$COPILOT_HOME/session-state" && ln -s ${JSON.stringify(outside)} "$COPILOT_HOME/session-state"` },
      { reply: "tampered" },
    ],
  }];
  const h = await acpHarness(rules, COPILOT(), { COPILOT_HOME: userCopilot });
  try {
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "TAMPER", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const home = acpStarts(h)[0].env.copilotHome;
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).sandbox.enabled, false, "relay's settings are read-only to the agent");
    assert.ok(!fs.existsSync(path.join(home, "planted")) && !fs.existsSync(path.join(home, "mcp-config.json")), "nothing can be added to the home");
    // The session directory is writable, but cannot itself be swapped for a link (review r_11c43840 C1)...
    assert.ok(fs.lstatSync(path.join(home, "session-state")).isDirectory(), "the agent could not swap it");
    assert.deepEqual(fs.readdirSync(outside), []);
    // ...and should one be swapped anyway, between turns, the next turn will not run on it.
    fs.rmSync(path.join(home, "session-state"), { recursive: true });
    fs.symlinkSync(outside, path.join(home, "session-state"));
    await root(h).call("resume", { job_id: job.job_id, message: "again" });
    await until(() => ["failed", "done"].includes(h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status) && h.sql("SELECT COUNT(*) AS c FROM turns WHERE node_id = ?", job.job_id)[0].c === 2 && h.sql("SELECT status FROM turns WHERE node_id = ? ORDER BY id DESC", job.job_id)[0].status === "failed", 30000, "second turn refused");
    assert.match(h.sql("SELECT error FROM turns WHERE node_id = ? ORDER BY id DESC", job.job_id)[0].error, /replaced by something other than a directory/);
    assert.equal(acpStarts(h).length, 1, "no second turn ran");
    assert.deepEqual(fs.readdirSync(outside), [], "and nothing was written through the link");
  } finally {
    await h.close();
    for (const d of [userCopilot, outside]) fs.rmSync(d, { recursive: true, force: true });
  }
});

onMac("acp: a write job writes only its worktree, is merged, and resumes the same session", async () => {
  const rules: Rule[] = [
    { target: "copilot", turn: 1, match: task("WRITE1"), steps: [{ write: "out.txt", content: "from copilot\n" }, { run: "echo x > ../../../repo/escaped.txt" }, { reply: "wrote it" }] },
    { target: "copilot", turn: 2, steps: [{ reply: "second turn" }] },
  ];
  const h = await acpHarness(rules, COPILOT());
  try {
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, effort: "high", task: "WRITE1", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const node = h.sql("SELECT * FROM nodes WHERE id = ?", job.job_id)[0];
    assert.equal(fs.readFileSync(path.join(node.worktree, "out.txt"), "utf8"), "from copilot\n");
    assert.ok(!fs.existsSync(path.join(h.repo, "escaped.txt")), "nothing outside the worktree");
    const merged = await root(h).call("merge", { job_id: job.job_id });
    assert.ok(merged.merged || merged.status === "merged" || !merged.error, JSON.stringify(merged));
    assert.equal(fs.readFileSync(path.join(h.repo, "out.txt"), "utf8"), "from copilot\n");

    await root(h).call("resume", { job_id: job.job_id, message: "carry on" });
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "done" && acpStarts(h).length === 2, 30000, "second turn");
    const [first, second] = acpStarts(h);
    assert.equal(second.sessionId, first.sessionId, "the same Copilot session");
    assert.equal(second.resumed, true);
    assert.equal(second.turn, 2);
    for (const s of [first, second]) assert.equal(s.argv[s.argv.indexOf("--reasoning-effort") + 1], "high", "the effort reaches new and resumed sessions alike");
    assert.equal(acpRecords(h).filter((r) => r.event === "session")[1].method, "session/load");
    assert.equal(acpRecords(h).filter((r) => r.event === "authenticate" && r.session).length, 2, "the loaded session's login is checked too, as the new one's was");
    const res = await root(h).call("result", { job_id: job.job_id });
    assert.equal(res.result.final_message, "second turn", "what the load replayed is not the reply");
  } finally {
    await h.close();
  }
});

onMac("acp: a write job's worktree is pinned when relay makes it, and a turn on a worktree replaced since is refused (review r_11c43840 C1)", async () => {
  const rules: Rule[] = [
    { target: "copilot", turn: 1, match: task("PIN1"), steps: [{ write: "out.txt", content: "one\n" }, { reply: "first" }] },
    { target: "copilot", turn: 2, steps: [{ reply: "second" }] },
  ];
  const h = await acpHarness(rules, COPILOT());
  try {
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "PIN1", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const node = h.sql("SELECT * FROM nodes WHERE id = ?", job.job_id)[0];
    const pin = JSON.parse(node.params_json).worktree_pin;
    const st = fs.statSync(node.worktree);
    assert.deepEqual(pin, { path: fs.realpathSync(node.worktree), dev: st.dev, ino: st.ino });
    // Replaced, between turns, by a copy at the same path: only the pin tells them apart.
    fs.renameSync(node.worktree, `${node.worktree}-old`);
    fs.cpSync(`${node.worktree}-old`, node.worktree, { recursive: true });
    await root(h).call("resume", { job_id: job.job_id, message: "carry on" });
    await until(() => ["failed", "done"].includes(h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status) && h.sql("SELECT status FROM turns WHERE node_id = ? ORDER BY id", job.job_id).length === 2 && h.sql("SELECT status FROM turns WHERE node_id = ? ORDER BY id", job.job_id)[1].status !== "running" && h.sql("SELECT status FROM turns WHERE node_id = ? ORDER BY id", job.job_id)[1].status !== "queued", 30000, "second turn settled");
    const turns = h.sql("SELECT status, error FROM turns WHERE node_id = ? ORDER BY id", job.job_id);
    assert.equal(turns[1].status, "failed", JSON.stringify(turns));
    assert.match(turns[1].error, /not the directory relay created for this job/);
    assert.equal(acpStarts(h).length, 1, "the harness never started for the second turn");
  } finally {
    await h.close();
  }
});

onMac("DM8 CLI request (ACP): argv keeps its word boundaries through the target's own request", async () => {
  const argv = ["env", "X=a b", "relay", "approve", "q_1"];
  const h = await acpHarness([{ target: "copilot", match: task("DM8-ARGV"), steps: [{ request: { command: argv } }, { reply: "{{last}}" }] }], COPILOT());
  try {
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "DM8-ARGV", mode: "write" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1);
    const req = h.sql("SELECT * FROM requests WHERE status = 'pending'")[0];
    assert.deepEqual(JSON.parse(req.detail_json).argv, argv);
    for (const user_confirmed of [false, true]) {
      const r = await root(h).call("approve", { request_id: req.id, decision: "allow", user_confirmed });
      assert.equal(r.refused, true, JSON.stringify(r));
      assert.match(r.reason, /relay's CLI/);
    }
    assert.equal((await root(h).call("approve", { request_id: req.id, decision: "deny" })).decision, "denied");
    await root(h).call("status", { id: job.job_id, wait_s: 20 });
  } finally { await h.close(); }
});

onMac("acp: approvals are read from the tool call, answered allow-once only, held by relay for the job, and refused when unclear", async () => {
  const rules: Rule[] = [
    {
      target: "copilot", turn: 1, match: task("ASK1"), steps: [
        { request: "make deploy" },
        { request: "make deploy" },
        { request: { command: "make deploy", cwd: "sub" } },
        { request: { sparse: true } },
        { request: { command: "make release", noAllowOnce: true } },
        { request: "rm -rf build" },
        { reply: "{{last}}" },
      ],
    },
    { target: "copilot", turn: 2, steps: [{ request: "make deploy" }, { request: { web: "https://example.com/x" } }, { reply: "turn two" }] },
  ];
  const h = await acpHarness(rules, COPILOT());
  try {
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "ASK1", mode: "write" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 30000, "first request");
    const first = h.sql("SELECT * FROM requests WHERE status = 'pending'")[0];
    assert.equal(first.kind, "command");
    assert.equal(first.summary, "make deploy", "the command comes from the tool call the request refers to");
    assert.equal(JSON.parse(first.detail_json).confined, true);
    const pending = await root(h).call("status", { id: job.job_id });
    assert.match(JSON.stringify(pending), /inside relay's sandbox, which stays on/);
    assert.equal(JSON.parse(first.detail_json).cwd, h.sql("SELECT cwd FROM nodes WHERE id = ?", job.job_id)[0].cwd, "a command that names no directory runs in the agent's own");
    await root(h).call("approve", { request_id: first.id, decision: "allow", scope: "job" });
    // The same command in another directory is another request: it reaches the root.
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 30000, "same command elsewhere");
    const elsewhere = h.sql("SELECT * FROM requests WHERE status = 'pending'")[0];
    assert.equal(elsewhere.summary, "make deploy");
    assert.equal(JSON.parse(elsewhere.detail_json).cwd, path.join(h.sql("SELECT cwd FROM nodes WHERE id = ?", job.job_id)[0].cwd, "sub"), "its own directory is kept, not replaced");
    await root(h).call("approve", { request_id: elsewhere.id, decision: "deny" });
    // The next request the root sees is the different command: the repeat, the sparse one and the one without allow-once never reach it.
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 30000, "second request");
    const second = h.sql("SELECT * FROM requests WHERE status = 'pending'")[0];
    assert.equal(second.summary, "rm -rf build");
    await root(h).call("approve", { request_id: second.id, decision: "deny", note: "no" });
    // A turn relay refused things in ends blocked, not done, and the denials are recorded (review ACP C1).
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "blocked", 30000, "job blocked");
    const recorded = JSON.parse(h.sql("SELECT denials FROM turns WHERE node_id = ? ORDER BY id", job.job_id)[0].denials) as string[];
    assert.ok(recorded.includes("make deploy") && recorded.includes("rm -rf build"), JSON.stringify(recorded));
    assert.ok(recorded.some((d) => /could not read/.test(d)), "the unclear request is recorded as a denial too");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests WHERE node_id = ?", job.job_id)[0].c, 3, "only three requests reached the root");

    const end = acpRecords(h).find((r) => r.event === "end")!;
    const answers = end.calls.map((c: Rec) => c.result.optionKind);
    assert.deepEqual(answers, ["allow_once", "allow_once", "reject_once", "reject_once", "reject_once", "reject_once"], "allowed for the job is still answered allow-once; never allow_always");
    const log = agentLog(h, job.job_id);
    assert.match(log, /could not be established/);
    assert.match(log, /offered no allow-once option/);
    assert.match(log, /allowed earlier for the rest of the job/);

    // The job scope outlives the turn: relay holds it, not the agent.
    await root(h).call("resume", { job_id: job.job_id, message: "again" });
    // A web request allowed for the rest of the job does not turn the job's network on: relay holds the approval instead.
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 30000, "web request");
    const web = h.sql("SELECT * FROM requests WHERE status = 'pending'")[0];
    assert.equal(web.kind, "web");
    await root(h).call("approve", { request_id: web.id, decision: "allow", scope: "job" });
    await until(() => acpRecords(h).filter((r) => r.event === "end").length === 2, 30000, "second turn");
    const again = acpRecords(h).filter((r) => r.event === "end")[1];
    assert.deepEqual(again.calls.map((c: Rec) => c.result.optionKind), ["allow_once", "allow_once"]);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests WHERE node_id = ?", job.job_id)[0].c, 4, "the held command asked nobody again");
    assert.equal(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json).grant, null, "the job's grant is as it was");
  } finally {
    await h.close();
  }
});

/** What allowing a Copilot path check does, as the person is shown it: a write, a read. */
const WRITE_EFFECT = "lets Copilot proceed to write the path it names; relay's sandbox still decides what it can touch, and allowing this does not widen it: a write outside the job's worktree, its granted directories and its temporary directory still fails";
const READ_EFFECT = "lets Copilot proceed to read the path it names; relay's sandbox allows reads everywhere except relay's own directories, its config and install files, and its API key files, so the read succeeds anywhere else, and allowing this does not widen the sandbox";

onMac("acp: Copilot's path checks reach the root as approvals; allowing one leaves relay's sandbox deciding, and protected paths ask nobody", async () => {
  // Outside the worktree and every writable root of the turn (the shared temp directory is not one).
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-outside-")));
  const [escape, refused, confirmed, terminal] = ["escape.txt", "refused.txt", "confirmed.txt", "terminal.txt"].map((f) => path.join(outside, f));
  fs.writeFileSync(terminal, "readable\n");
  // The worktrees' directory in a tree of its own, so that a directory holding it holds nothing else of relay's.
  const worktreesRoot = nonTempScratch("rw");
  const worktrees = path.join(worktreesRoot, "worktrees");
  const otherJob = path.join(worktrees, "run_other", "j_other");
  fs.mkdirSync(otherJob, { recursive: true });
  fs.writeFileSync(path.join(otherJob, "x.txt"), "another job's\n");
  const h = await acpHarness([], COPILOT(), { RELAY_WORKTREES: worktrees });
  // Relay's config, a file in its control directory, a file in another job's worktree, a directory
  // holding relay's control directory (and its config), and one holding the worktrees' directory,
  // and so another job's worktree (review r_a74ec0a8 C2).
  const protectedPaths = [path.join(h.home, "config.json"), path.join(h.home, "runs", "planted.txt"), path.join(otherJob, "x.txt"), path.dirname(h.home), worktreesRoot];
  fs.writeFileSync(h.env.STUB_SCENARIO, JSON.stringify({ rules: [{ target: "copilot", match: task("PATHS-W"), steps: [
    { request: { path: escape, tool: "edit" } },
    { request: { path: refused, tool: "edit" } },
    ...protectedPaths.map((p, i) => ({ request: { path: p, tool: i ? "read" : "edit" } })),
    { request: { path: confirmed, tool: "edit" } },
    { request: { path: terminal, tool: "read" } },
    { request: { path: "", tool: "edit" } },
    { reply: "{{last}}" },
  ] }] }));
  // The person, in relay's approval dialog: allows the first, refuses the second, and closes the rest unanswered.
  const messages: string[] = [];
  const host = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"], elicit: (m: string) => {
    messages.push(m);
    return m.includes(escape) ? { action: "accept", content: { decision: "allow" } } : m.includes(refused) ? { action: "accept", content: { decision: "deny" } } : { action: "cancel" };
  } });
  try {
    const job = await host.call("delegate", { target: "copilot", model: GPT, task: "PATHS-W", mode: "write" });
    const pendingFor = (p: string) => h.sql("SELECT * FROM requests WHERE status = 'pending' AND summary LIKE ?", `%${p}`)[0];
    /** Until the request for this path is pending and its dialog was closed unanswered. */
    const dismissed = (p: string) => until(() => Boolean(pendingFor(p)) && h.sql("SELECT COUNT(*) AS c FROM elicitations WHERE request_id = ? AND outcome IS NOT NULL", pendingFor(p).id)[0].c === 1, 30000, `${path.basename(p)} request, dismissed`);
    // Closed in the dialog: the root puts it to the user with confirm, exactly as needs_approval shows it.
    await dismissed(confirmed);
    const shown = (await host.call("status", { id: job.job_id })).needs_approval[0];
    assert.equal(shown.kind, "path");
    assert.equal(shown.wants, `write ${confirmed}`);
    assert.equal(shown.in_directory, confirmed, "the path itself is where it would act");
    assert.equal(shown.effect, WRITE_EFFECT);
    assert.match(shown.reason, /^Copilot's own check of paths outside its trusted directories, for its tool call: apply_patch \(edit\)$/);
    assert.equal(shown.user_dismissed_prompt, true);
    const { request_id, from, wants, kind, effect, in_directory } = shown;
    assert.equal((await host.call("confirm", { request_id, from, wants, kind, effect, in_directory })).decision, "allowed");
    // And from a terminal, with relay approve.
    await dismissed(terminal);
    assert.equal(terminalApprove(h, pendingFor(terminal).id).json.decision, "allowed");
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "blocked", 30000, "job blocked");

    // What the person saw in the dialog: who asks, inside relay's sandbox, the effect, the path and the access.
    const first = messages.find((m) => m.includes(escape))!;
    assert.ok(first.includes(`asks for approval to go ahead inside relay's sandbox. Effect: ${WRITE_EFFECT}.\n`), first);
    assert.ok(first.includes(`Wants: write ${escape}\n`) && first.includes(`In: ${escape}\n`), first);
    // Four requests reached the root; the protected paths and the one naming no path asked nobody.
    const rows = h.sql("SELECT summary, kind, status, decided_by, detail_json FROM requests WHERE node_id = ? ORDER BY created_at", job.job_id);
    assert.deepEqual(rows.map((r) => [r.kind, r.summary, r.status]), [
      ["path", `write ${escape}`, "allowed"], ["path", `write ${refused}`, "denied"], ["path", `write ${confirmed}`, "allowed"], ["path", `read ${terminal}`, "allowed"],
    ]);
    assert.deepEqual(rows.map((r) => r.decided_by.replace(/,.*/, "")), ["user", "user", "user", "terminal"]);
    for (const r of rows) assert.equal(JSON.parse(r.detail_json).confined, true);
    assert.equal(messages.length, 4, "the dialog was shown only for the requests that reached the root");

    // Allow-once and reject-once reached Copilot, never allow_always.
    const end = acpRecords(h).find((r) => r.event === "end")!;
    const calls = end.calls.map((c: Rec) => c.result);
    assert.deepEqual(calls.map((c: Rec) => c.optionKind), ["allow_once", "reject_once", ...protectedPaths.map(() => "reject_once"), "allow_once", "allow_once", "reject_once"]);
    // Allowed past its own check, Copilot went on to write outside the worktree, and relay's sandbox still refused it.
    const at = (p: string) => calls[end.calls.findIndex((c: Rec) => c.args.path === p)];
    assert.deepEqual(at(escape).attempt, { op: "write", ok: false, code: "EPERM" });
    assert.deepEqual(at(confirmed).attempt, { op: "write", ok: false, code: "EPERM" });
    assert.ok(!fs.existsSync(escape) && !fs.existsSync(confirmed), "nothing was written outside the worktree");
    // An allowed read outside relay's own places happens: reads are broad in relay's sandbox, as the effect says.
    assert.deepEqual(at(terminal).attempt, { op: "read", ok: true });
    const turn = h.sql("SELECT denials FROM turns WHERE node_id = ? ORDER BY id", job.job_id)[0];
    const denials = JSON.parse(turn.denials) as string[];
    assert.ok(denials.includes(`write ${refused}`) && denials.includes(`write ${protectedPaths[0]}`) && denials.includes(`read ${protectedPaths[1]}`), JSON.stringify(denials));
    const log = agentLog(h, job.job_id);
    assert.ok(log.includes(`(refused: ${protectedPaths[0]} is relay's own config file `) && log.includes("which no approval lets a job reach)"), log);
    assert.ok(log.includes(`(refused: ${protectedPaths[2]} is inside relay's own directories, which no approval lets a job reach)`), log);
    assert.ok(log.includes(`(refused: ${protectedPaths[3]} holds relay's own config file ${protectedPaths[0]}, which no approval lets a job reach)`), log);
    assert.ok(log.includes(`(refused: ${worktreesRoot} holds relay's own directories (${worktrees}), which no approval lets a job reach)`), log);
    assert.ok(protectedPaths.every((p, i) => denials.includes(`${i ? "read" : "write"} ${p}`)), JSON.stringify(denials));
    assert.match(log, /what it would do could not be established/);
    assert.equal(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json).grant, null, "nothing allowed widened the job's grant");
  } finally {
    await host.close();
    await h.close();
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(worktreesRoot, { recursive: true, force: true });
  }
});

onMac("acp: in a read job, Copilot's path check reaches the root only for a path it would read", async () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-outside-")));
  const [write, either, read] = ["write.txt", "either.txt", "read.txt"].map((f) => path.join(outside, f));
  fs.writeFileSync(read, "readable\n");
  const h = await acpHarness([{ target: "copilot", match: task("PATHS-R"), steps: [
    { request: { path: write, tool: "edit" } },
    { request: { path: either, tool: "execute" } },
    { request: { path: read, tool: "read" } },
    { reply: "{{last}}" },
  ] }], COPILOT());
  try {
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "PATHS-R", mode: "read" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 30000, "read request");
    const shown = (await root(h).call("status", { id: job.job_id })).needs_approval[0];
    assert.deepEqual([shown.kind, shown.wants, shown.in_directory, shown.session], ["path", `read ${read}`, read, "read"]);
    assert.equal(shown.effect, READ_EFFECT);
    assert.equal((await root(h).call("approve", { request_id: shown.request_id, decision: "allow" })).decision, "allowed");
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "blocked", 30000, "job blocked");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests WHERE node_id = ?", job.job_id)[0].c, 1, "the write and the either-way requests asked nobody");
    const end = acpRecords(h).find((r) => r.event === "end")!;
    assert.deepEqual(end.calls.map((c: Rec) => c.result.optionKind), ["reject_once", "reject_once", "allow_once"]);
    // The allowed read happened: relay's sandbox allows reads outside its own places, as the effect says (review r_a74ec0a8 C1).
    assert.deepEqual(end.calls[2].result.attempt, { op: "read", ok: true });
    const denials = JSON.parse(h.sql("SELECT denials FROM turns WHERE node_id = ?", job.job_id)[0].denials) as string[];
    assert.deepEqual(denials, [`write ${write}`, `read or write ${either}`]);
    assert.equal((agentLog(h, job.job_id).match(/answered \{"outcome":"selected","optionId":"reject_once"\} \(this turn is read-only\)/g) ?? []).length, 2);
  } finally {
    await h.close();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

onMac("acp: cancel goes to the agent as session/cancel, and the turn ends cancelled with nothing left running", async () => {
  // The graceful path (session/cancel) is what this test checks: give the worker production's
  // grace (5 s) before relay escalates to killing it, not the harness's 300 ms, which a loaded
  // machine can miss, and then relay rightly stops the agent without asking.
  const h = await acpHarness([{ target: "copilot", match: task("SLOW"), steps: [{ sleep: 60000 }, { reply: "never" }] }], COPILOT({}, { cancel_grace_ms: 5000 }));
  try {
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "SLOW", mode: "read" });
    // A cold runner's boundary probes can take well over 30 s before the agent starts.
    await until(() => acpStarts(h).length === 1, 120000, "turn started");
    const pid = acpStarts(h)[0].pid;
    await root(h).call("cancel", { id: job.job_id });
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "cancelled" && !alive(pid), 60000, "cancelled");
    assert.ok(acpRecords(h).some((r) => r.event === "cancel"), "the agent was asked to stop");
  } finally {
    await h.close();
  }
});

onMac("acp: the harness runs sandboxed, and its relay calls go through the bridge with its own model's family", async () => {
  const rules: Rule[] = [
    {
      target: "copilot", match: task("OUTER"), steps: [
        { call: "delegate", args: { target: "codex", task: "SAME", mode: "read" }, as: "same" },
        { call: "delegate", args: { target: "claude", task: "GRAND", mode: "read", background: false }, as: "grand" },
        { sleep: 4000 },
        { reply: "{{same.reason}} | {{grand.result.final_message}}" },
      ],
    },
    { target: "claude", match: task("GRAND"), steps: [{ reply: "grandchild here" }] },
  ];
  const h = await acpHarness(rules, COPILOT());
  try {
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "OUTER", mode: "read" });
    // While the agent waits out its last step, after the grandchild it started has finished.
    await until(() => h.sql("SELECT status FROM nodes WHERE target = 'claude'")[0]?.status === "done", 60000, "grandchild done");
    // The stub records its start only once its two probe requests to relay are answered, which a
    // loaded machine can delay past the grandchild's end.
    await until(() => acpStarts(h).length >= 1, 60000, "the harness's start record");
    const start = acpStarts(h)[0];
    assert.ok(alive(start.pid), "the harness is still running");
    assert.equal(sandboxed(start.pid), true, "the kernel reports the harness's process sandboxed");
    // The real worker's log receives broker refusals, rather than losing them on the stdio bridge.
    const socket = /"BRIDGE_SOCKET=([^"\n]+)"/.exec(agentLog(h, job.job_id))?.[1];
    assert.ok(socket, "the logged launch identifies its scratch bridge socket");
    scratchOnly(socket);
    await new Promise<void>((resolve, reject) => {
      const peer = net.connect(socket);
      peer.setTimeout(3000, () => { peer.destroy(); reject(new Error("broker did not refuse the outsider")); });
      peer.on("error", reject);
      peer.on("close", () => resolve());
    });
    await until(() => agentLog(h, job.job_id).includes(`[broker] refused: kernel peer pid ${process.pid} is outside the live launched harness process tree`), 3000, "broker refusal in the turn's log");
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "done", 30000, "outer done");
    // Copilot drops relay's bridge (1.0.98: stdio MCP over ACP is rejected), so its prompt offers no
    // relay tools (review r_7feaed80 C7); the stub here still takes the bridge, which relay passes.
    assert.match(start.prompt, /Relay's tools are not available to you in this harness, so you cannot delegate/);
    assert.doesNotMatch(start.prompt, /You may delegate further using the relay tools/);
    const reply = (await root(h).call("result", { job_id: job.job_id })).result.final_message;
    assert.match(reply, /You are a Copilot \(experimental\) agent.*\| grandchild here$/, "a GPT Copilot agent may not reach Codex, and reaches Claude through the bridge");
    const grand = h.sql("SELECT * FROM nodes WHERE target = 'claude'")[0];
    assert.equal(grand.parent_id, job.job_id);
  } finally {
    await h.close();
  }
});

test("acp: a Copilot call needs a model of another family than the caller's, and what Copilot cannot honour is refused up front", async () => {
  const h = await acpHarness([{ target: "copilot", steps: [{ reply: "ok" }] }], COPILOT());
  const off = await acpHarness([], { targets: { copilot: { bin: STUB_ACP } } });
  const unqualified = await acpHarness([], COPILOT({ experimental: false }, { allow_untested: true }));
  const offline = await acpHarness([], COPILOT({}, { child_network: false }));
  try {
    // A Claude caller.
    assert.match((await root(h).call("delegate", { target: "copilot", task: "x", mode: "read" })).reason, /runs models of several families.*name it with model \(for example gpt-6\.1-sol/);
    assert.match((await root(h).call("delegate", { target: "copilot", model: "claude-sonnet-5.5", task: "x", mode: "read" })).reason, /"claude-sonnet-5\.5" is Anthropic's, your own family/);
    assert.match((await root(h).call("ask", { target: "copilot", model: "auto", message: "x" })).reason, /does not know which family the model "auto" is/);
    assert.match((await root(h).call("delegate", { target: "copilot", model: "gpt-9-imaginary", task: "x", mode: "read" })).reason, /does not know which family/);
    // A Codex caller: GPT is its own family on Copilot too; Claude is not.
    const codexRoot = await h.instance({ args: ["--host", "codex"] });
    try {
      assert.match((await codexRoot.call("delegate", { target: "copilot", model: GPT, task: "x", mode: "read" })).reason, /"gpt-6\.1-sol" is OpenAI's, your own family/);
      if (macOS) {
        const ok = await codexRoot.call("delegate", { target: "copilot", model: "claude-sonnet-5.5", task: "x", mode: "read", background: false });
        assert.equal(ok.status, "done", JSON.stringify(ok));
      }
    } finally {
      await codexRoot.close();
    }
    if (macOS) {
      const ok = await root(h).call("ask", { target: "copilot", model: GPT, message: "hello" });
      assert.equal(ok.reply, "ok", JSON.stringify(ok));
    }
    // Admission: switched off, and experimental.
    // Switched off, it is not among the tools' choices at all.
    const offered = await root(off).call("delegate", { target: "copilot", model: GPT, task: "x", mode: "read" });
    assert.match(offered.tool_error ?? offered.reason, /expected one of "claude"\|"codex" at target|switched off/);
    assert.match((await root(unqualified).call("delegate", { target: "copilot", model: GPT, task: "x", mode: "read" })).reason, /experimental.*targets\.copilot\.experimental/, "allow_untested does not stand in for the target's own opt-in");
    if (macOS) {
      // Off the network (no grant): launched, reaching only Copilot's API hosts through relay's proxy.
      const offNet = await root(offline).call("delegate", { target: "copilot", model: GPT, task: "x", mode: "read", background: false });
      assert.equal(offNet.status, "done", JSON.stringify(offNet));
      const log = fs.readFileSync(offline.sql("SELECT log_path FROM nodes WHERE id = ?", offNet.job_id)[0].log_path, "utf8");
      assert.match(log, /# relay network: off, except relay's proxy to api\.github\.com, api\.individual\.githubcopilot\.com, and what the certificate-trust daemons fetch for it, past the proxy \(a stated downgrade\) \(decisions in /, "Copilot takes the trust downgrade, and its log says what that leaves open");
      const granted = await root(offline).call("delegate", { target: "copilot", model: GPT, task: "x", mode: "read", grant: { network: true }, background: false });
      assert.equal(granted.status, "done", JSON.stringify(granted));
      assert.match(fs.readFileSync(offline.sql("SELECT log_path FROM nodes WHERE id = ?", granted.job_id)[0].log_path, "utf8"), /# relay network: on \(granted\)/);
    }
  } finally {
    for (const x of [h, off, unqualified, offline]) await x.close();
  }
});

onMac("acp: a stop while the turn is starting (during its boundary probes) launches no agent, cleans up what the start made, and lets the worker exit by itself (consolidation-confine.md E18)", async () => {
  const marker = path.join(fs.realpathSync(os.tmpdir()), `relay-slow-probe-${process.pid}-${Date.now()}.json`);
  const h = await harness([{ target: "copilot", steps: [{ reply: "should not run" }] }], COPILOT(), { NODE_OPTIONS: SLOW_PROBES_PRELOAD, SLOW_PROBE_MARKER: marker, SLOW_PROBE_MS: "20000" });
  try {
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "x", mode: "read" });
    assert.ok(job.job_id, JSON.stringify(job));
    // The preload writes the marker in one write, but not atomically: wait until it reads whole.
    const whole = () => { try { return JSON.parse(fs.readFileSync(marker, "utf8")); } catch { return null; } };
    await until(() => whole() !== null, 120000, "the start reached its boundary probes");
    const made = whole();
    assert.ok(fs.existsSync(made.tmpDir) && made.bridgeSocket && fs.existsSync(made.bridgeSocket), "the start had made its temp dir and broker");
    const started = Date.now();
    const cancelled = await root(h).call("cancel", { id: job.job_id });
    assert.deepEqual(cancelled.cancelled, [job.job_id], JSON.stringify(cancelled));
    assert.ok(!cancelled.warning, `the worker exited by itself within cancel's grace (${JSON.stringify(cancelled)})`);
    await until(() => !alive(made.worker), 10000, "worker gone");
    assert.ok(Date.now() - started < 10000);
    assert.ok(!fs.existsSync(made.tmpDir), "the turn's temp dir is gone");
    assert.ok(!fs.existsSync(path.dirname(made.bridgeSocket)), "the broker and its directory are gone");
    assert.equal(acpRecords(h).length, 0, "no agent was launched");
    const turn = h.sql("SELECT status FROM turns WHERE node_id = ? ORDER BY id DESC", job.job_id)[0];
    assert.equal(turn.status, "cancelled");
  } finally {
    fs.rmSync(marker, { force: true });
    await h.close();
  }
});

onMac("acp: a notice the harness sends as a message chunk of its own is kept out of the reply (Copilot 1.0.98, signed in: \"Info: Disabled tools: task\")", async () => {
  const h = await acpHarness([{ target: "copilot", steps: [{ reply: "the answer" }] }], COPILOT(), { STUB_ACP_NOTICE: "Info: Disabled tools: task" });
  try {
    const r = await root(h).call("delegate", { target: "copilot", model: GPT, task: "x", mode: "read", background: false });
    assert.equal(r.status, "done", JSON.stringify(r));
    assert.equal(r.result.final_message, "the answer");
    const log = fs.readFileSync(h.sql("SELECT log_path FROM nodes WHERE id = ?", r.job_id)[0].log_path, "utf8");
    const chunks = log.split("\n").filter((line) => line.includes('"agent_message_chunk"')).map((line) => JSON.parse(line).params.update.content.text);
    assert.ok(chunks.includes("[redacted]"), "the notice stays in the log, redacted as an explicitly released environment value");
    assert.doesNotMatch(log, /Info: Disabled tools: task/);
  } finally {
    await h.close();
  }
  const { copilotProfile } = await import("../dist/backends/copilot.js");
  assert.equal(copilotProfile.notice!("Info: Disabled tools: task, web_fetch"), true);
  for (const t of ["Info: Disabled tools: task\nok", "Info: something else", "ok", " Info: Disabled tools: task"]) assert.equal(copilotProfile.notice!(t), false, t);
});

onMac("acp: a model the harness does not offer this account is refused plainly, before relay asks for it (Copilot Free offers only auto)", async () => {
  // gpt-5.4-mini is a model relay knows the family of, and one the stub does not offer.
  const h = await acpHarness([{ target: "copilot", steps: [{ reply: "should not run" }] }], COPILOT());
  try {
    const r = await root(h).call("delegate", { target: "copilot", model: "gpt-5.4-mini", task: "x", mode: "read", background: false });
    assert.equal(r.status, "failed", JSON.stringify(r));
    assert.match(r.error, /Copilot \(experimental\) does not offer the model "gpt-5\.4-mini" to this account \(it offers "auto", "claude-sonnet-5\.5", .*"gpt-6\.1-sol".*\), so relay stopped it before it did anything/);
    assert.ok(!acpRecords(h).some((x) => x.event === "set_config_option"), "nothing was asked of it");
    assert.equal(acpStarts(h).length, 0, "no prompt was sent");
  } finally {
    await h.close();
  }
});

onMac("acp: a harness that exits before relay can check its login says how to sign in (Copilot 1.0.98 without a stored login)", async () => {
  const h = await acpHarness([{ target: "copilot", steps: [{ reply: "should not run" }] }], COPILOT(), { STUB_ACP_EXIT_AT_START: "exit-before-login" });
  try {
    const r = await root(h).call("delegate", { target: "copilot", model: GPT, task: "x", mode: "read", background: false });
    assert.equal(r.status, "failed", JSON.stringify(r));
    assert.match(r.error, /Copilot \(experimental\) exited \(code 1\) before the turn finished, before relay could check its login.*Sign in with `copilot login`.*no stored login/s);
  } finally {
    await h.close();
  }
});

onMac("acp: the agent is stopped before its prompt when what it reports is not what relay asked for", async () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ STUB_ACP_REPORT: JSON.stringify({ model: "claude-sonnet-5.5" }) }, /reports the model "claude-sonnet-5\.5", not the "gpt-6\.1-sol" relay asked for/],
    [{ STUB_ACP_REPORT: JSON.stringify({ noModel: true }) }, /does not report which model/],
    // Explicitly passed values are redacted, including a bare "1" or "2". The controls must not
    // collide with the protocol/exit/model diagnostics whose exact content this test checks.
    [{ STUB_ACP_PROTOCOL: "2.0" }, /speaks ACP version 2, and relay speaks only version 1/],
    [{ STUB_LOGIN: "none" }, /Copilot \(experimental\) is not signed in.*copilot login/],
    [{ STUB_ACP_NO_AUTH_METHOD: "omit-login-method" }, /does not offer the login check relay knows/],
    [{ STUB_LOGIN: "lost-after-session" }, /Copilot \(experimental\) is not signed in/],
  ];
  for (const [env, why] of cases) {
    const h = await acpHarness([{ target: "copilot", steps: [{ reply: "should not run" }] }], COPILOT(), env);
    try {
      const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "x", mode: "read", background: false });
      assert.equal(job.status, "failed", JSON.stringify(env));
      assert.match(job.error, why);
      assert.equal(acpStarts(h).length, 0, `no prompt was sent (${JSON.stringify(env)})`);
    } finally {
      await h.close();
    }
  }
});

onMac("acp: a model switch in the middle of a turn stops the agent, fails the turn and takes its relay tools away at once", async () => {
  // The agent is connected to relay, switches its model, ignores the request to stop, and calls relay
  // again on the same connection as soon as that request arrives: only taking its relay tools away,
  // in the same step as asking it to stop, refuses that call.
  const rules: Rule[] = [{
    target: "copilot", match: task("SWITCH"),
    steps: [{ call: "status", args: {} }, { hook: { switchModel: "claude-sonnet-5.5", awaitCancel: true } }, { call: "status", args: {} }, { reply: "{{last}}" }],
  }];
  const h = await acpHarness(rules, COPILOT({}, { cancel_grace_ms: 4000 }), { STUB_ACP_IGNORE_TERM: "ignore-termination" });
  try {
    const started = Date.now();
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "SWITCH", mode: "read", background: false });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, /changed its model mid-turn to "claude-sonnet-5\.5", from the "gpt-6\.1-sol" relay asked for/);
    assert.ok(Date.now() - started < 30000, "stopped at once");
    await until(() => acpRecords(h).some((r) => r.event === "end" || r.event === "steps-error"), 10000, "the agent's relay call");
    const after = acpRecords(h).find((r) => r.event === "end" || r.event === "steps-error")!;
    const res = after.event === "end" ? JSON.stringify(after.calls[1].result) : after.error;
    assert.doesNotMatch(res, /run_id/, "its relay call after the switch got nothing");
    assert.match(res, /not reachable|has ended|closed|Refused/);
  } finally {
    await h.close();
  }
});

test("acp: this build runs the real per-turn boundary probes itself, with nothing stood in: a relay-enforced target launches once they pass, and the turn's log records them; elsewhere than macOS it is refused", async () => {
  // No preload: the relay process runs exactly what production runs (PROBES_ENABLED), on the scratch stub.
  const h = await harness([{ target: "copilot", turn: 1, match: task("PROBED"), steps: [{ reply: "probed" }] }], COPILOT());
  try {
    const r = await root(h).call("delegate", { target: "copilot", model: GPT, task: "PROBED", mode: "read", background: false });
    if (process.platform !== "darwin") return assert.match(r.reason, /runs only inside relay's own sandbox/);
    assert.equal(r.status, "done", JSON.stringify(r));
    assert.doesNotMatch(JSON.stringify(r), /probe its sandbox/);
    const log = fs.readFileSync(h.sql("SELECT log_path FROM nodes WHERE id = ?", r.job_id)[0].log_path, "utf8");
    assert.match(log, /# relay boundary probes: \d+ passed in \d+ ms/);
    // The header, written in the same step as the harness's spawn, comes first, before anything the
    // harness or relay's streams sent: the command line, the probes, the network.
    const lines = log.split("\n").filter(Boolean);
    assert.match(lines[0], /^# \d{4}-\d\d-\d\dT\S+ \/usr\/bin\/sandbox-exec /, lines[0].slice(0, 200));
    assert.match(lines[1], /^# relay boundary probes: /);
    assert.match(lines[2], /^# relay network: /);
    const harnessLine = lines.findIndex((l) => l.startsWith("{") || l.startsWith("[stderr]") || l.startsWith("[sandbox]"));
    assert.ok(harnessLine > 2, `the harness's first line comes after the header: ${lines.slice(0, 5).map((l) => l.slice(0, 80)).join(" | ")}`);
  } finally {
    await h.close();
  }
});

onMac("acp: continuing an item is open to whoever has authority over it, whatever its family; outside one's own subtree it is not", async () => {
  const rules: Rule[] = [
    // A, Copilot running GPT, starts B (Claude), which starts C (Copilot running GPT); A then resumes C, its own grandchild.
    {
      target: "copilot", match: task("A-TASK"), steps: [
        { call: "delegate", args: { target: "claude", task: "B-TASK", mode: "read", background: false }, as: "b" },
        { call: "resume", args: { job_id: "{{b.result.final_message}}", message: "more" }, as: "again" },
        { reply: "{{again.status}}" },
      ],
    },
    { target: "claude", match: task("B-TASK"), steps: [{ call: "delegate", args: { target: "copilot", model: GPT, task: "C-TASK", mode: "read", background: false }, as: "c" }, { reply: "{{c.job_id}}" }] },
    // C tries to resume A, the first item of the run, which it did not start.
    { target: "copilot", match: task("C-TASK"), steps: [{ call: "status", args: {}, as: "run" }, { call: "resume", args: { job_id: "{{run.nodes.0.id}}", message: "x" }, as: "up" }, { reply: "{{up.reason}}" }] },
  ];
  const h = await acpHarness(rules, COPILOT());
  try {
    const a = await root(h).call("delegate", { target: "copilot", model: GPT, task: "A-TASK", mode: "read", background: false });
    assert.equal(a.status, "done", JSON.stringify(a));
    assert.match(a.result.final_message, /^queued/, "a GPT agent may resume its GPT grandchild");
    const b = h.sql("SELECT * FROM nodes WHERE target = 'claude'")[0];
    const c = h.sql("SELECT * FROM nodes WHERE target = 'copilot' AND parent_id = ?", b.id)[0];
    await until(() => h.sql("SELECT COUNT(*) AS n FROM turns WHERE node_id = ? AND status = 'done'", c.id)[0].n === 2, 30000, "C resumed");
    assert.match(h.sql("SELECT reply FROM turns WHERE node_id = ? ORDER BY id", c.id)[0].reply, /only work that you started/, "but nothing outside its own subtree");

    // A root taking over the run may continue any of its items, its own family's included.
    await roots.get(h)!.close();
    roots.delete(h);
    pendingRoots.delete(h);
    const codexRoot = await h.instance({ args: ["--host", "codex"] });
    try {
      await adoptRun(h, codexRoot, a.job_id);
      assert.match((await codexRoot.call("resume", { job_id: a.job_id, message: "from codex" })).status, /queued/, "a GPT Copilot session, from a Codex root");
      await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", a.job_id)[0].status === "done", 30000, "A resumed");
    } finally {
      await codexRoot.close();
    }
  } finally {
    await h.close();
  }
});

test("family: with same_family allow, a caller may name its own family; left out, the target is never its own", async () => {
  const rules: Rule[] = [{ target: "claude", steps: [{ reply: "a Claude helper" }] }, { target: "copilot", steps: [{ reply: "Copilot running Claude" }] }];
  const refuse = await acpHarness(rules, COPILOT());
  const allow = await acpHarness(rules, COPILOT({}, { same_family: "allow" }));
  try {
    assert.match((await root(refuse).call("delegate", { target: "claude", task: "x", mode: "read" })).reason, /use your own subagents.*"same_family": "allow"/);
    assert.match((await root(refuse).call("ask", { target: "copilot", model: "claude-sonnet-5.5", message: "x" })).reason, /your own family.*"same_family": "allow"/);
    const own = await root(allow).call("ask", { target: "claude", message: "hello" });
    assert.equal(own.reply, "a Claude helper", JSON.stringify(own));
    if (macOS) {
      const viaCopilot = await root(allow).call("ask", { target: "copilot", model: "claude-sonnet-5.5", message: "hello" });
      assert.equal(viaCopilot.reply, "Copilot running Claude", JSON.stringify(viaCopilot));
    }
    // Left out, relay still picks another family, here the only one switched on.
    const left = await root(allow).call("ask", { message: "who?", target: undefined });
    assert.ok(left.reply || left.thread_id, JSON.stringify(left));
    assert.equal(allow.sql("SELECT target FROM nodes ORDER BY created_at DESC LIMIT 1")[0].target, "codex");
  } finally {
    await refuse.close();
    await allow.close();
  }
});

onMac("acp: with same_family allow, every model switch continues with a warning and an unknown label", async () => {
  const rules: Rule[] = [
    { target: "copilot", match: task("SWITCH-OWN"), steps: [{ hook: { switchModel: "claude-sonnet-5.5" } }, { reply: "carried on" }] },
    { target: "copilot", match: task("SWITCH-UNKNOWN"), steps: [{ hook: { switchModel: "mystery-model" } }, { reply: "continued" }] },
  ];
  const h = await acpHarness(rules, COPILOT({}, { same_family: "allow" }));
  try {
    const own = await root(h).call("delegate", { target: "copilot", model: GPT, task: "SWITCH-OWN", mode: "read", background: false });
    assert.equal(own.status, "done", JSON.stringify(own));
    assert.equal(own.result.final_message, "carried on");
    assert.match(own.result.warnings.join(" "), /changed its model in the middle of the turn to "claude-sonnet-5\.5" \(Anthropic's\).*same_family is "allow"/);
    const unknown = await root(h).call("delegate", { target: "copilot", model: GPT, task: "SWITCH-UNKNOWN", mode: "read", background: false });
    assert.equal(unknown.status, "done", JSON.stringify(unknown));
    assert.equal(unknown.families.launched, "unknown");
    assert.match(unknown.result.warnings.join(" "), /changed its model.*"mystery-model".*family unknown/);
  } finally {
    await h.close();
  }
});

onMac("acp: a running Copilot job's liveness says what its agent last started, from the turn's own record", async () => {
  const h = await acpHarness([{ target: "copilot", match: task("LIVE"), steps: [{ sleep: 4000 }, { reply: "ok" }] }], COPILOT());
  try {
    const job = await root(h).call("delegate", { target: "copilot", model: GPT, task: "LIVE", mode: "read" });
    let st: Rec = {};
    await until(async () => (st = await root(h).call("status", { id: job.job_id })).liveness?.activity !== undefined, 15000, "the activity to show");
    assert.equal(st.liveness.activity, "Reading README.md", JSON.stringify(st.liveness));
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status !== "running", 20000, "the job to finish");
  } finally {
    await h.close();
  }
});

test("acp: a write grant without the per-directory pins relay records is refused, with a re-grant message (review X2)", async () => {
  const { startAcpTurn, genericApproval: normalizeApproval } = await import("../dist/backends/acp.js");
  const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const base = targetDef("codex");
  const target = { ...base, name: "Probe", capabilities: { ...base.capabilities, confinement: "relay-enforced" } };
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-x2-acp-")));
  const grant = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-x2-grant-")));
  // A probe is stood in so the launch reaches the grant check; the grant check throws before it runs.
  setBoundaryProbeForTests(async () => { throw new Error("the probe should not run: the grant check comes first"); });
  const profile = { args: () => ["--acp"], scrub: () => false, login: { how: "", verify: () => null }, normalizeApproval };
  const spec = (grantObj: Record<string, unknown>) => ({
    target, prompt: "x", cwd: wt, access: "write", relay: null, dir: wt, logPath: path.join(wt, "agent.log"), grant: grantObj,
    config: { ...DEFAULT_CONFIG, child_network: true, allow_temp_home: true, targets: { ...DEFAULT_CONFIG.targets, codex: { enabled: true, bin: STUB_ACP } } },
    markers: { runId: "r", nodeId: "n", depth: 1 },
  });
  try {
    if (process.platform === "darwin") {
      await assert.rejects(startAcpTurn(spec({ network: false, write_paths: [grant] }) as never, profile), /granted write paths without the per-directory pins.*grant those write paths again/s);
    }
  } finally {
    setBoundaryProbeForTests(null);
    for (const d of [wt, grant]) fs.rmSync(d, { recursive: true, force: true });
  }
});
