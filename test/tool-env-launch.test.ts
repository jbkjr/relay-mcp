import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import "./helpers.ts";
import { withDefaults } from "../dist/core/config.js";
import { selectEnvironment } from "../dist/core/env-policy.js";
import { withTurnSecrets } from "../dist/core/secrets.js";
import { claudeBackend } from "../dist/backends/claude.js";
import { codexBackend } from "../dist/backends/codex.js";
import { launchTurn } from "../dist/backends/run.js";
import { targetDef } from "../dist/targets/index.js";
import { startAcpTurn, genericApproval } from "../dist/backends/acp.js";
import type { TurnSpec } from "../dist/backends/types.js";

/** These tests need neither /Users/Shared nor a signed-in CLI. The executable records its
 * complete *incoming* environment before adding any stub controls. Only synthetic values are
 * recorded, inside this test's scratch directory, which is deleted even on assertion failure. */
function fixture(t: TestContext, target: "claude" | "codex" | "copilot") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-env-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  for (const dir of [home, cwd]) fs.mkdirSync(dir);
  const saved = process.env.HOME;
  const savedRelay = process.env.RELAY_HOME;
  process.env.HOME = home;
  process.env.RELAY_HOME = path.join(root, "control");
  fs.mkdirSync(process.env.RELAY_HOME);
  t.after(() => { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; if (savedRelay === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = savedRelay; });
  // Production refuses long Claude paths because the real CLI falls back to shared temp.
  // The fake CLI has no socket-path limit. Stand in only this unrelated length check, keeping
  // the real private-dir creation, backend, process spawn, env and cleanup paths under test.
  if (target === "claude") {
    const length = Buffer.byteLength;
    t.mock.method(Buffer, "byteLength", (value: string, encoding?: BufferEncoding) =>
      typeof value === "string" && value.startsWith(path.join(home, ".rn") + path.sep) && /\/claude-\d+$/.test(value)
        ? 0 : length(value, encoding));
  }
  const captures = path.join(root, "exec-env.jsonl");
  const bin = path.join(root, "harness");
  const stubs = path.resolve(import.meta.dirname, "stubs");
  const href = (file: string) => JSON.stringify(pathToFileURL(path.join(stubs, file)).href);
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from 'node:fs';
const argv=process.argv.slice(2);
const settings=argv.includes('--settings') ? JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings')+1],'utf8')) : undefined;
fs.appendFileSync(${JSON.stringify(captures)}, JSON.stringify({argv,env:process.env,settings})+'\\n');
process.env.STUB_DIR=${JSON.stringify(root)};
const {main}=await import(${href("stub-agent.mjs")});
const {default:target}=await import(${href(`targets/${target === "copilot" ? "acp" : target}.mjs`)});
await main(target);
`, { mode: 0o755 });
  const records = (): { argv: string[]; env: Record<string, string>; settings?: Record<string, unknown> }[] =>
    fs.existsSync(captures) ? fs.readFileSync(captures, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)) : [];
  return { root, home, cwd, bin, records };
}

test("tool env: ACP real boundary probes and resumed launch receive only the selected environment", { skip: process.platform !== "darwin" }, async (t) => {
  // This is a capability check, not a confinement stand-in. Restricted CI/relay sandboxes
  // cannot always apply another Seatbelt profile. Keep that missing gate explicit.
  const check = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", process.execPath, "-e", ""], { encoding: "utf8" });
  if (check.status !== 0 && /Operation not permitted|sandbox_apply.*failed/i.test(check.stderr ?? "")) {
    t.skip("outer sandbox prevents applying ACP's real Seatbelt profile; coordinator must run this gate outside it");
    return;
  }
  assert.equal(check.status, 0, check.stderr);
  const f = fixture(t, "copilot");
  const state = path.join(f.root, "state");
  const captures = path.join(state, "records", "env.jsonl");
  fs.mkdirSync(state, { mode: 0o700 });
  // Capture beneath the prepared harness's writable state, including probe invocations.
  fs.writeFileSync(f.bin, fs.readFileSync(f.bin, "utf8").replace(JSON.stringify(path.join(f.root, "exec-env.jsonl")), JSON.stringify(captures)));
  const config = withDefaults({
    allow_untested: true, allow_temp_home: true, child_network: true,
    child_env: { pass: ["JAVA_HOME"], request: ["NPM_TOKEN"] },
    targets: { copilot: { enabled: true, experimental: true, bin: f.bin } },
  });
  const rootEnv = { PATH: process.env.PATH, HOME: f.home, JAVA_HOME: "/synthetic/java", ...CANARIES };
  const profile = {
    args: () => ["--acp"], scrub: () => false, login: { how: "synthetic login", verify: () => null }, normalizeApproval: genericApproval,
    prepareState: () => ({ stateDirs: [], keychain: false, persistent: { root: state, writable: ["records", "session-state"] }, env: { COPILOT_HOME: state } }),
  };
  let sessionId: string | undefined;
  let firstCount = 0;
  for (const requested of [["NPM_TOKEN"], []]) {
    const selected = selectEnvironment("copilot", config, rootEnv, requested);
    const spec = {
      target: targetDef("copilot"), prompt: "synthetic environment", cwd: f.cwd, access: "read", relay: null,
      dir: f.root, logPath: path.join(f.root, "agent.log"), config, sessionId,
      model: "gpt-6.1-sol", markers: { runId: "synthetic-run", nodeId: "synthetic-node", depth: 1 },
      environment: selected.env, environmentReleased: selected.releasedNames,
    } as TurnSpec;
    const result = await (await startAcpTurn(spec, profile)).done;
    assert.equal(result.status, "ok", `${result.error ?? ""}\n${fs.readFileSync(spec.logPath, "utf8")}`);
    assert.ok(result.sessionId);
    sessionId = result.sessionId;
    if (requested.length) firstCount = fs.readFileSync(captures, "utf8").trim().split("\n").length;
  }
  const records = fs.readFileSync(captures, "utf8").trim().split("\n").map((s) => JSON.parse(s));
  assert.ok(records.length >= 2, "initial and resumed harnesses were spawned");
  for (const [index, record] of records.entries()) {
    const e = record.env;
    assert.equal(e.JAVA_HOME, rootEnv.JAVA_HOME);
    assert.equal(e.NPM_TOKEN, index < firstCount ? CANARIES.NPM_TOKEN : undefined);
    for (const name of Object.keys(CANARIES).filter((name) => name !== "NPM_TOKEN")) assert.equal(e[name], undefined, name);
    assert.equal(e.COPILOT_HOME, state, "backend-owned harness state won");
  }
});

const CANARIES = {
  AWS_SECRET_ACCESS_KEY: "synthetic-cloud-731948",
  NPM_TOKEN: "synthetic-registry-731948",
  GH_TOKEN: "synthetic-vcs-731948",
  CI_JOB_TOKEN: "synthetic-ci-731948",
  DATABASE_URL: "postgres://synthetic:canary@invalid.example/db",
  SSH_AUTH_SOCK: "/synthetic/ssh-agent.sock",
  NEUTRAL_ALIAS: "unrecognizableOpaque731948Qx",
};

for (const harness of ["claude", "codex-app", "codex-exec"] as const) for (const mode of ["read", "write", "full-access"] as const) for (const network of [false, true]) {
  test(`tool env: ${harness}/${mode}/network-${network} launches, preflights and resumes use only their checked turn selection`, async (t) => {
    const target = harness === "claude" ? "claude" : "codex";
    const f = fixture(t, target);
    const ownedCodex = { pinned: false, home: path.join(f.home, "owned-codex"), pin_store: path.join(f.root, "codex-pins") };
    const config = withDefaults({
      allow_untested: process.platform !== "darwin",
      allow_dangerous: mode === "full-access",
      codex_backend: harness === "codex-exec" ? "exec" : "app-server",
      child_env: { pass: ["JAVA_HOME", "NPM_TOKEN"] },
      targets: {
        codex: ownedCodex,
        [target]: { ...(target === "codex" ? ownedCodex : {}), bin: f.bin, child_env: { request: ["GH_TOKEN"] } },
      },
    });
    const capturedRoot = {
      PATH: process.env.PATH, LANG: "C", HOME: f.home,
      CODEX_HOME: path.join(f.home, ".codex"), CLAUDE_CONFIG_DIR: path.join(f.home, ".claude"),
      JAVA_HOME: "/synthetic/java", ...CANARIES,
      ANTHROPIC_API_KEY: "synthetic-foreign-auth-731948",
      OPENAI_API_KEY: "synthetic-foreign-auth-842059",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "parent-app", CLAUDE_CODE_DESKTOP_APP_VERSION: "synthetic-host",
      RELAY_NODE_ID: "parent-node", RELAY_DEPTH: "99",
    };
    // A late change is deliberately outside the root's captured environment.
    const oldAlias = process.env.LATE_ROOT_ALIAS;
    process.env.LATE_ROOT_ALIAS = "synthetic-late-secret-842059";
    t.after(() => { if (oldAlias === undefined) delete process.env.LATE_ROOT_ALIAS; else process.env.LATE_ROOT_ALIAS = oldAlias; });
    const backend = target === "claude" ? claudeBackend : codexBackend;
    let sessionId: string | undefined;
    const boundaries: number[] = [];
    // First turn has consent for GH_TOKEN. A resumed turn receives freshly selected policy,
    // without that request. No old one-turn token may survive via the session or preflight.
    for (const requested of [["GH_TOKEN"], []]) {
      const selected = selectEnvironment(target, config, capturedRoot, requested);
      const spec = {
        target: targetDef(target), prompt: "Inspect only this synthetic environment", cwd: f.cwd,
        access: mode === "read" ? "read" : "write", relay: null, dir: f.root, logPath: path.join(f.root, "agent.log"),
        config, markers: { runId: "synthetic-run", nodeId: "synthetic-node", depth: 1 },
        environment: selected.env, environmentReleased: selected.releasedNames, sessionId,
        grant: { network, env: requested },
      } as TurnSpec;
      const result = await withTurnSecrets(async () => (await launchTurn(targetDef(target), spec, backend)).done);
      assert.equal(result.status, "ok", `${result.error ?? ""}\n${fs.readFileSync(spec.logPath, "utf8")}`);
      assert.ok(result.sessionId, "the fake CLI supplied a resumable session");
      sessionId = result.sessionId;
      boundaries.push(f.records().length);
    }
    const records = f.records();
    assert.ok(records.length >= (harness === "codex-exec" ? 6 : harness === "codex-app" ? 4 : 2));
    for (const [index, record] of records.entries()) {
      const e = record.env;
      if (target === "claude" && record.argv.includes("-p")) {
        const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/native-skill-isolation.json"), "utf8"));
        assert.deepEqual(record.settings?.enabledPlugins, fixture.claude.find((c: any) => c.settings.disableBundledSkills).settings.enabledPlugins,
          "initial and resumed Claude launches disable every bundled plugin");
        if (mode !== "full-access") {
          const settings = record.settings as any;
          const home = config.targets.codex.home!, store = config.targets.codex.pin_store!;
          assert.ok(settings.sandbox.filesystem.denyRead.includes(home));
          for (const p of [home, store]) assert.ok(settings.sandbox.filesystem.denyWrite.includes(p));
          assert.ok(settings.permissions.deny.includes(`Read(/${home}/**)`));
          assert.ok(!settings.sandbox.filesystem.denyRead.includes(store), "pin store stays readable");
        }
      }
      assert.equal(e.PATH, capturedRoot.PATH);
      assert.equal(e.JAVA_HOME, capturedRoot.JAVA_HOME);
      assert.equal(e.GH_TOKEN, index < boundaries[0] ? CANARIES.GH_TOKEN : undefined, record.argv.join(" "));
      assert.equal(e.NPM_TOKEN, CANARIES.NPM_TOKEN, "standing pass persists across turns without one-turn consent");
      for (const name of [...Object.keys(CANARIES).filter((k) => k !== "GH_TOKEN" && k !== "NPM_TOKEN"), "LATE_ROOT_ALIAS", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CLAUDE_CODE_DESKTOP_APP_VERSION"])
        assert.equal(e[name], undefined, `${harness}: ${name} reached ${record.argv.join(" ")}`);
      assert.equal(e.RELAY_NODE_ID, "synthetic-node");
      assert.equal(e.RELAY_DEPTH, "1");
      assert.equal(e.HOME, f.home);
      if (target === "codex") assert.equal(e.CODEX_HOME, config.targets.codex.home, "every launch uses the owned home");
      if (e.TMPDIR) assert.ok(e.TMPDIR.startsWith(path.join(f.home, ".rn") + path.sep));
    }
    if (target === "codex") {
      assert.equal(records.filter((r) => r.argv.includes("list")).length, 2, "MCP-list preflight on both turns");
      if (harness === "codex-exec") {
        // A write turn with the network also has a network-proxy preflight server (codex.ts chooseNetwork);
        // a read turn under exec has hosted search only, and full access no sandbox to check.
        assert.equal(records.filter((r) => r.argv[0] === "app-server").length, mode === "write" && network ? 6 : 4, "effective-config preflight and archive app-server on both turns, and the network preflight where there is one");
        assert.equal(records.filter((r) => r.argv[0] === "exec").length, 2, "exec launch and resume");
      }
    } else {
      assert.equal(records.filter((r) => r.argv.includes("-p")).length, 2, "both Claude turns had their plugin settings checked");
    }
    assert.equal(fs.readdirSync(path.join(f.home, ".rn")).length, 0, "every private turn temp was removed");
  });
}

test("tool env: ACP driver, stubbed confinement probe and actual resumed harness share one checked environment", { skip: process.platform !== "darwin" }, async (t) => {
  const { seatbelt, seatbeltLaunch } = await import("../dist/confine/seatbelt.js");
  const { setBoundaryProbeForTests } = await import("../dist/confine/turn-probe.js");
  const f = fixture(t, "copilot"), state = path.join(f.root, "state"); fs.mkdirSync(state, { mode: 0o700 });
  // Stand in confinement, never claim it passed: this test verifies actual spawn environments.
  // The separate real-profile test above is the confinement gate and remains blocked here.
  t.mock.method(seatbelt, "wrap", (policy, command, args) => ({ ...seatbeltLaunch(policy, command, args), command, args, diagnosticTag: "", rewrap: (command, args) => ({ command, args }) }));
  t.mock.method(seatbelt, "confined", () => true);
  const probeRecords: NodeJS.ProcessEnv[] = [];
  setBoundaryProbeForTests(async (mechanism, policy, command, args, _signal, environment) => {
    const launch = mechanism.wrap(policy, command, args);
    const file = path.join(f.root, `probe-${probeRecords.length}.json`);
    const probe = spawnSync(process.execPath, ["-e", `require('fs').writeFileSync(process.argv[1],JSON.stringify(process.env))`, file], { env: { ...environment, ...launch.env } });
    assert.equal(probe.status, 0); probeRecords.push(JSON.parse(fs.readFileSync(file, "utf8")));
    return { launch, probes: { results: [], ms: 0, profile: launch.fingerprint, relay: "test stand-in", os: "test stand-in" } };
  });
  t.after(() => setBoundaryProbeForTests(null));
  const config = withDefaults({ allow_temp_home: true, allow_untested: true, child_network: true, child_env: { pass: ["JAVA_HOME"], request: ["NPM_TOKEN"] }, targets: { copilot: { enabled: true, experimental: true, bin: f.bin } } });
  const root = { PATH: process.env.PATH, HOME: f.home, JAVA_HOME: "/synthetic/java", ...CANARIES };
  const profile = { args: () => ["--acp"], scrub: () => false, normalizeApproval: genericApproval, login: { how: "synthetic", verify: () => null }, prepareState: () => ({ stateDirs: [], keychain: false, persistent: { root: state, writable: ["session-state"] }, env: { COPILOT_HOME: state } }) };
  let sessionId: string | undefined;
  for (const names of [["NPM_TOKEN"], []]) {
    const selected = selectEnvironment("copilot", config, root, names);
    const result = await (await startAcpTurn({ target: targetDef("copilot"), config, environment: selected.env, environmentReleased: selected.releasedNames, sessionId, prompt: "synthetic", cwd: f.cwd, access: "read", relay: null, dir: f.root, logPath: path.join(f.root, "agent.log"), model: "gpt-6.1-sol", markers: { runId: "r", nodeId: "n", depth: 1 } }, profile)).done;
    assert.equal(result.status, "ok", result.error); sessionId = result.sessionId;
  }
  assert.equal(probeRecords.length, 2); assert.equal(f.records().length, 2);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(f.records()[i].env, probeRecords[i]);
    assert.equal(probeRecords[i].NPM_TOKEN, i === 0 ? CANARIES.NPM_TOKEN : undefined);
    assert.equal(probeRecords[i].JAVA_HOME, root.JAVA_HOME);
    assert.equal(probeRecords[i].NEUTRAL_ALIAS, undefined);
    assert.equal(probeRecords[i].COPILOT_HOME, state);
  }
});
