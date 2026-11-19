import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { withDefaults, ConfigSchema } from "../dist/core/config.js";
import { freezeCodexConfig, prepareCodexHome, codexHomeProblem, codexHomeStatus, setCodexHomeConfigForTests, RELAY_CODEX_CONFIG, RELAY_CODEX_HOME_MARKER } from "../dist/backends/codex-pin.js";
import { relayCodexProtected, relayCredentialProtected, relayWriteProtected } from "../dist/core/protected-config.js";
import { codexBackend, codexPermissions } from "../dist/backends/codex.js";
import { buildSkillPackage, resolveExtensions } from "../dist/core/extensions.js";
import { configProblem, codexRuntimeApprovalProblem, startCodexAppTurn } from "../dist/backends/codex-app.js";
import { offLimits } from "../dist/core/approvals.js";
import { seatbeltProfile } from "../dist/confine/seatbelt.js";
import { dirIdentity } from "../dist/confine/index.js";
import { executorPolicy, openStage2, setStage2DepsForTests } from "../dist/backends/codex-env.js";
import { selectEnvironment } from "../dist/core/env-policy.js";
import { targetDef } from "../dist/targets/index.js";
import { launchTurn } from "../dist/backends/run.js";
import { admitWork } from "../dist/core/caller.js";
import { createRun, closeDbForTests } from "../dist/core/db.js";
import { CLI } from "./helpers.ts";
import { withTurnSecrets } from "../dist/core/secrets.js";

function scratch(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-pin-test-")));
  t.after(() => {
    const unseal = (dir: string) => { fs.chmodSync(dir, 0o700); for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unseal(path.join(dir, e.name)); };
    unseal(root); fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, "home"), store = path.join(root, "pins");
  const cfg = withDefaults({ targets: { codex: { home, pin_store: store, pinned: true } } });
  return { root, home, store, cfg };
}
function pin(store: string, version = "0.164.0", bytes = `#!/bin/sh\necho codex-cli ${version}\n`) {
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = `versions/${version}-${hash.slice(0, 12)}`;
  const dir = path.join(store, target);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin/codex"), bytes, { mode: 0o555 });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version, binarySha256: hash,
    npmIntegrity: `sha512-${"A".repeat(86)}==`, codesign: { teamId: "2DC432GLL2", identity: "OpenAI" },
    qualifiedAt: new Date().toISOString(), verdictPath: path.join(store, "verdict.json"), sourceCommit: "a".repeat(40) }), { mode: 0o444 });
  fs.chmodSync(path.join(dir, "bin"), 0o555);
  fs.chmodSync(dir, 0o555);
  return { target, dir, bin: path.join(dir, "bin/codex") };
}

for (const custom of [false, true]) for (const setting of [["alpha"], "user"] as const) {
  test(`Codex skill sources stay personal while pinned launches use the owned home (custom=${custom}, skills=${setting})`, async (t) => {
    const { root, home, store, cfg } = scratch(t);
    const personHome = path.join(root, "person");
    const personCodex = custom ? path.join(root, "personal-codex") : path.join(personHome, ".codex");
    const source = path.join(personCodex, "skills", "alpha");
    const writeSkill = (dir: string, text: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${path.basename(dir)}\ndescription: ${text}\nallowed-tools: Bash\n---\n${text}\n`);
    };
    // Consent sources come from the person's roots, independently of targets.codex.home.
    writeSkill(source, "personal source");
    writeSkill(path.join(personHome, ".agents", "skills", "alpha"), "second-root duplicate");
    writeSkill(path.join(personHome, ".agents", "skills", "other"), "second-root source");
    const person = { HOME: personHome, ...(custom ? { CODEX_HOME: personCodex } : {}) };
    cfg.targets.codex.skills = setting === "user" ? "user" : [...setting];
    const extensions = resolveExtensions(cfg, "codex", person);
    assert.ok(!("reason" in extensions), JSON.stringify(extensions));
    if ("reason" in extensions) return;
    const names = setting === "user" ? ["alpha", "other"] : ["alpha"];
    assert.deepEqual(extensions.skills, names.map((name) => ({ name, source: name === "alpha" ? source : path.join(personHome, ".agents", "skills", name) })));
    assert.equal(extensions.consent, null, "discovery precedes consent and pin launch");
    assert.equal(fs.existsSync(store), false, "discovery does not need or select an interactive binary");

    prepareCodexHome(cfg); // relay's own home, as install makes it, before the decoys land in it
    writeSkill(path.join(home, "skills", "alpha"), "runtime duplicate must never be the source");
    writeSkill(path.join(home, "skills", "runtime-only"), "runtime-only decoy");
    const packageDir = path.join(root, "package");
    buildSkillPackage(packageDir, extensions.skills, { plugin: false });
    const fixture = path.join(import.meta.dirname, "stubs", "stub-codex");
    const capture = path.join(root, "launches.jsonl");
    const selected = pin(store, "0.164.0", `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ bin: process.argv[1], home: process.env.CODEX_HOME }) + '\\n');\nawait import(${JSON.stringify(fixture)});\n`);
    fs.symlinkSync(selected.target, path.join(store, "current"));
    cfg.child_auth = "any";
    cfg.child_env.pass = ["STUB_DIR", "STUB_SCENARIO"];
    const scenario = path.join(root, "scenario.json");
    fs.writeFileSync(scenario, JSON.stringify({ rules: [{ steps: [{ reply: "skill test done" }] }] }));
    const work = path.join(root, "work"); fs.mkdirSync(work);
    const env = selectEnvironment("codex", cfg, { ...person, PATH: "/usr/bin:/bin", STUB_DIR: root, STUB_SCENARIO: scenario }).env;
    assert.equal(env.CODEX_HOME, home);
    let handle: any;
    t.after(async () => { await handle?.cancel(); });
    const run = (environment: NodeJS.ProcessEnv, log: string) => withTurnSecrets(async () => {
      handle = await launchTurn(targetDef("codex"), {
        target: targetDef("codex"), config: cfg, environment, access: "read", cwd: work, dir: root,
        prompt: "test", logPath: path.join(root, log), relay: null,
        markers: { runId: "r_skills", nodeId: "j_skills", depth: 1 }, skills: { dir: packageDir, names },
      } as any, codexBackend);
      return await handle.done;
    });
    const result = await run(env, "agent.log");
    assert.equal(result.status, "ok", JSON.stringify(result));
    const records = () => fs.readFileSync(path.join(root, "log.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const listed = records().filter((r: any) => r.event === "skills-list").at(-1);
    assert.deepEqual(listed.enabled.sort(), [...names].sort(), "only the person's copied skills load");
    assert.match(listed.copies.alpha, /personal source/);
    assert.doesNotMatch(listed.copies.alpha, /runtime duplicate|second-root duplicate|allowed-tools/);
    assert.ok(listed.found.includes("runtime-only"), "the runtime decoy is discovered and disabled");
    assert.equal(fs.existsSync(path.join(personCodex, "config.toml")), false, "no runtime config written to the person's home");
    assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), RELAY_CODEX_CONFIG);

    // The corrected source must also let launch-time negative controls reach skills/list,
    // where Relay refuses a missing copy or an extra skill before starting the thread.
    const negative = setting === "user" ? { STUB_CODEX_DROP_ROOTS: "1" } : {
      STUB_CODEX_SKILLS: JSON.stringify([{ name: "stray", scope: "admin", path: path.join(root, "stray", "SKILL.md") }]),
    };
    cfg.child_env.pass.push(...Object.keys(negative));
    const blocked = await run({ ...env, ...negative }, "blocked.log");
    assert.equal(blocked.status, "failed", JSON.stringify(blocked));
    assert.match(blocked.error, setting === "user" ? /did not load the skills relay gave it/ : /skills relay did not give it.*stray/);
    assert.equal(records().filter((r: any) => r.event === "start").length, 1, "the negative control never starts a turn");
    const launches = fs.readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(launches.length >= 4, "version, MCP, app server and archive use the pinned executable");
    for (const launch of launches) assert.deepEqual(launch, { bin: selected.bin, home });
  });
}

test("pin selection fails closed and names the qualifier; never uses configured interactive bin", (t) => {
  const { cfg, store } = scratch(t);
  assert.throws(() => freezeCodexConfig(cfg), /codex-qualifier/);
  const p = pin(store);
  fs.symlinkSync(p.target, path.join(store, "current"));
  const frozen = freezeCodexConfig(cfg);
  assert.equal(frozen.targets.codex.bin, p.bin);
  const next = pin(store, "0.165.0");
  fs.unlinkSync(path.join(store, "current"));
  fs.symlinkSync(next.target, path.join(store, "current"));
  assert.equal(freezeCodexConfig(frozen).targets.codex.bin, p.bin);
  assert.equal(freezeCodexConfig(cfg).targets.codex.bin, next.bin);
});

test("configuration: Codex-only strict paths and booleans, pins required before bootstrap, explicit opt-out", (t) => {
  const { cfg, store } = scratch(t);
  for (const bad of [{ targets: { codex: { home: "relative" } } }, { targets: { codex: { pinned: "false" } } }, { targets: { claude: { pin_store: store } } }]) assert.equal(ConfigSchema.safeParse(bad).success, false);
  assert.equal(withDefaults({}).targets.codex.home, "~/.local/share/relay-codex-home");
  assert.equal(withDefaults({}).targets.codex.pin_store, "~/.local/share/relay-codex-pins");
  const auto = withDefaults({ targets: { codex: { home: cfg.targets.codex.home, pin_store: store, bin: "/configured/codex" } } });
  assert.equal(withDefaults({}).targets.codex.pinned, true);
  assert.throws(() => freezeCodexConfig(auto), /qualifier/, "missing stores must never fall back to the configured CLI");
  fs.mkdirSync(store);
  assert.throws(() => freezeCodexConfig(auto), /qualifier/);
  assert.equal(freezeCodexConfig(withDefaults({ targets: { codex: { pin_store: store, pinned: false, bin: "/explicit/codex" } } })).targets.codex.bin, "/explicit/codex");
  fs.rmdirSync(store); fs.symlinkSync(path.join(store, "missing"), store);
  assert.throws(() => freezeCodexConfig(auto), /qualifier/, "a broken store symlink never falls back to PATH");
});

test("saved runs keep their homes and stores protected after machine config changes", (t) => {
  const { root, home, store, cfg } = scratch(t);
  const currentHome = path.join(root, "current-home"), currentStore = path.join(root, "current-pins");
  for (const dir of [home, store, currentHome, currentStore]) fs.mkdirSync(dir);
  const file = path.join(root, "relay-config.json");
  fs.writeFileSync(file, JSON.stringify({ targets: { codex: { home: currentHome, pin_store: currentStore, pinned: true } } }));
  const savedConfig = process.env.RELAY_CONFIG, savedHome = process.env.RELAY_HOME;
  process.env.RELAY_CONFIG = file; process.env.RELAY_HOME = path.join(root, "control");
  t.after(() => {
    closeDbForTests();
    if (savedConfig === undefined) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = savedConfig;
    if (savedHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = savedHome;
  });
  const runId = createRun(root, cfg, "saved-pin-test");
  const caller = { runId, node: null, depth: 0, cwd: root, access: "write" as const };
  const parts = relayCodexProtected(cfg);
  for (const dir of [home, currentHome]) assert.ok(parts.homes.some((p) => p.path === dir), dir);
  for (const dir of [store, currentStore]) assert.ok(parts.stores.some((p) => p.path === dir), dir);
  const permissions = codexPermissions({ access: "write", config: cfg }, { dangerous: false, network: false, roots: [root], codexHome: home });
  for (const dir of [home, currentHome]) assert.equal(permissions.profile!.filesystem[dir], "deny", dir);
  for (const dir of [store, currentStore]) assert.equal(permissions.profile!.filesystem[dir], "read", dir);
  for (const dir of [home, store, currentHome, currentStore]) {
    const alias = path.join(root, `alias-${path.basename(dir)}`); fs.symlinkSync(dir, alias);
    for (const p of [dir, path.join(dir, "child"), alias, path.join(alias, "child"), root]) {
      for (const mode of ["change", "reach"] as const) assert.ok(offLimits({ cwd: root, worktree: null, run_id: runId }, [p], mode), `${mode}: ${p}`);
    }
    for (const held of [false, true]) {
      const grant = { write_paths: [dir] };
      const result = admitWork(caller, "codex", { mode: "write", continues: held, ...(held ? { kept: grant } : { grant }) }, {});
      assert.ok("reason" in result, dir);
      assert.match((result as { reason: string }).reason, /Codex (credential home|pin store)/, dir);
    }
  }
});

test("launch interface freezes the version-checked executable for every consumer of the turn", async (t) => {
  const { cfg, store } = scratch(t), first = pin(store);
  fs.symlinkSync(first.target, path.join(store, "current"));
  const next = pin(store, "0.165.0");
  const config = { ...cfg, allow_untested: process.platform !== "darwin" };
  let selected = "";
  await launchTurn(targetDef("codex"), { config, access: "read" } as any, {
    async start(spec: any) {
      selected = spec.config.targets.codex.bin;
      fs.unlinkSync(path.join(store, "current")); fs.symlinkSync(next.target, path.join(store, "current"));
      spec.checkEnvironment(selectEnvironment("codex", spec.config, { PATH: "/usr/bin:/bin" }).env);
      assert.equal(freezeCodexConfig(spec.config).targets.codex.bin, first.bin);
      return { done: Promise.resolve({ status: "done" }), cancel: async () => {} } as any;
    },
  });
  assert.equal(selected, first.bin);
});

for (const pinned of [true, false]) test(`app-server interface uses the frozen binary and owned home, and preserves store protections (pinned=${pinned})`, async (t) => {
  const { root, store, home, cfg } = scratch(t);
  const fixture = path.join(import.meta.dirname, "fixtures/pinned-codex-app-server.mjs");
  const first = pin(store, "0.164.0", `#!${process.execPath}\nawait import(${JSON.stringify(fixture)});\n`);
  fs.symlinkSync(first.target, path.join(store, "current"));
  if (!pinned) Object.assign(cfg.targets.codex, { pinned: false, bin: first.bin });
  const frozen = freezeCodexConfig(cfg);
  const next = pin(store, "0.165.0");
  fs.unlinkSync(path.join(store, "current")); fs.symlinkSync(next.target, path.join(store, "current"));
  prepareCodexHome(frozen);
  const permissions = codexPermissions({ access: "read", config: frozen }, { dangerous: false, network: false, roots: [], codexHome: home });
  const config = { approvals_reviewer: "user", default_permissions: permissions.id, permissions: { relay: permissions.profile } };
  const capture = path.join(root, "app-capture");
  const handle = startCodexAppTurn({ target: targetDef("codex"), config: frozen, access: "read", cwd: root, dir: root, prompt: "test", logPath: path.join(root, "agent.log"), relay: null,
    markers: { runId: "r_test", nodeId: "j_test", depth: 1 }, onApproval: async () => { assert.fail("must not ask a supervisor to discard pin-store protection"); },
  } as any, { off: [], c: [], expect: { permissions, relay: null, relayOnly: false, accountLogin: false } },
  { HOME: root, CODEX_HOME: home, PATH: "/usr/bin:/bin", PC_APP_CAPTURE: capture, PC_APP_CONFIG: JSON.stringify(config) });
  t.after(async () => { await handle.cancel(); });
  const result = await handle.done;
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.denials?.length, 1);
  assert.match(JSON.stringify(result), /pin-store write protection/);
  const [started, answer] = fs.readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(started, { bin: first.bin, home });
  assert.equal(answer.decision, "decline");
});

test("stage-2 interface resolves and launches the same frozen version after promotion", async (t) => {
  const { root, store, home, cfg } = scratch(t), first = pin(store);
  fs.symlinkSync(first.target, path.join(store, "current"));
  const frozen = freezeCodexConfig(cfg), next = pin(store, "0.165.0");
  fs.unlinkSync(path.join(store, "current")); fs.symlinkSync(next.target, path.join(store, "current"));
  let launched = false, stopped = false, released = false;
  setStage2DepsForTests({
    admission: () => null, sweepProblem: () => null,
    confinement: () => ({ mechanism: {} }),
    resolveBin: (bin: string) => { assert.equal(bin, first.bin); return fs.realpathSync(bin); },
    probe: () => async (_mechanism: unknown, _policy: unknown, bin: string) => { assert.equal(bin, first.bin); return { launch: {}, probes: {} }; },
    lease: () => ({ exec: 50000, broker: 50001, block: [50002], range: [50000, 50001, 50002], release: () => { released = true; } }),
    deniedTcp: () => [], interfaces: () => [], policy: () => ({}), plan: () => ({ c: [], off: [], features: {} }),
    launch: async (o: any) => { assert.equal(o.bin, first.bin); launched = true; return { exited: new Promise(() => {}) }; },
    stop: async () => { stopped = true; return { survivors: [] }; },
  } as any);
  t.after(() => setStage2DepsForTests(null));
  await withTurnSecrets(async () => {
    const opened = await openStage2({ target: targetDef("codex"), config: frozen, access: "write", cwd: root, relay: null } as any,
      { env: { HOME: root, CODEX_HOME: home, PATH: "/usr/bin:/bin" }, servers: [] }, root);
    assert.equal(opened.session.env.CODEX_HOME, home);
    await opened.abort("test complete");
  });
  assert.ok(launched && stopped && released);
});

test("the version gate reads the selected pin, a new tree after promotion, and never the configured interactive Codex", { skip: process.platform !== "darwin" && "the gate reads versions on macOS only" }, async (t) => {
  const { root, store, cfg } = scratch(t);
  const record = path.join(root, "version-runs");
  const interactive = path.join(root, "interactive-codex");
  fs.writeFileSync(interactive, `#!/bin/sh\necho interactive >> "${record}"\necho codex-cli 0.199.0\n`, { mode: 0o755 });
  cfg.targets.codex.bin = interactive;
  const bytes = (v: string) => `#!/bin/sh\necho ${v} >> "${record}"\necho codex-cli ${v}\n`;
  const first = pin(store, "0.164.0", bytes("0.164.0"));
  const current = path.join(store, "current");
  fs.symlinkSync(first.target, current);
  const next = pin(store, "0.165.0", bytes("0.165.0"));
  const env = selectEnvironment("codex", cfg, { PATH: "/usr/bin:/bin" }).env;
  const turn = async () => {
    let selected = "";
    await launchTurn(targetDef("codex"), { config: cfg, access: "read" } as any, {
      async start(spec: any) {
        selected = spec.config.targets.codex.bin;
        spec.checkEnvironment(env);
        return { done: Promise.resolve({ status: "done" }), cancel: async () => {} } as any;
      },
    });
    return selected;
  };
  assert.equal(await turn(), first.bin);
  fs.unlinkSync(current); fs.symlinkSync(next.target, current);
  assert.equal(await turn(), next.bin, "a different concrete tree");
  assert.deepEqual(fs.readFileSync(record, "utf8").trim().split("\n"), ["0.164.0", "0.165.0"], "each pin's version read once; the interactive binary never ran");
});

test("invalid manifests, digests and external pointers are refused", (t) => {
  const { cfg, store } = scratch(t), p = pin(store);
  fs.symlinkSync(p.target, path.join(store, "current"));
  const file = path.join(p.dir, "manifest.json"), original = fs.readFileSync(file, "utf8");
  const replace = (text: string) => { fs.chmodSync(file, 0o644); fs.writeFileSync(file, text); fs.chmodSync(file, 0o444); };
  for (const changes of [{ version: "0.165.0" }, { binarySha256: "0".repeat(64) }, { codesign: { teamId: "OTHER" } }, { npmIntegrity: "unchecked" }, { qualifiedAt: "never" }, { sourceCommit: "unknown" }, { verdictPath: "relative" }]) {
    replace(JSON.stringify({ ...JSON.parse(original), ...changes }));
    assert.throws(() => freezeCodexConfig(cfg), /manifest/);
  }
  replace(original);
  fs.chmodSync(p.bin, 0o755); fs.writeFileSync(p.bin, "tampered"); fs.chmodSync(p.bin, 0o555);
  assert.throws(() => freezeCodexConfig(cfg), /digest mismatch/);
  fs.unlinkSync(path.join(store, "current"));
  fs.symlinkSync(p.dir, path.join(store, "current"));
  assert.throws(() => freezeCodexConfig(cfg), /relative versions/);
});

test("pin resolution refuses mutable publications, non-executables and symlinked published files", (t) => {
  const { cfg, root, store } = scratch(t), p = pin(store);
  const current = path.join(store, "current"), manifest = path.join(p.dir, "manifest.json");
  fs.writeFileSync(current, p.target);
  assert.throws(() => freezeCodexConfig(cfg), /current must be a symlink/);
  fs.unlinkSync(current); fs.symlinkSync(p.target, current);
  fs.chmodSync(p.dir, 0o755);
  assert.throws(() => freezeCodexConfig(cfg), /not immutable/);
  fs.chmodSync(p.dir, 0o555);
  fs.chmodSync(p.bin, 0o444);
  assert.throws(() => freezeCodexConfig(cfg), /qualifier/);
  fs.chmodSync(p.bin, 0o555);
  fs.chmodSync(p.dir, 0o755);
  const externalManifest = path.join(root, "manifest.json"); fs.renameSync(manifest, externalManifest);
  fs.symlinkSync(externalManifest, manifest); fs.chmodSync(p.dir, 0o555);
  assert.throws(() => freezeCodexConfig(cfg), /pin manifest file/);
  fs.chmodSync(p.dir, 0o755); fs.unlinkSync(manifest); fs.renameSync(externalManifest, manifest); fs.chmodSync(p.dir, 0o555);
  fs.chmodSync(path.dirname(p.bin), 0o755);
  const externalBin = path.join(root, "external-codex"); fs.renameSync(p.bin, externalBin);
  fs.symlinkSync(externalBin, p.bin); fs.chmodSync(path.dirname(p.bin), 0o555);
  assert.throws(() => freezeCodexConfig(cfg), /pin binary is not an immutable regular file/);
});

test("doctor reports private auth metadata and a missing pin without probing the interactive CLI", (t) => {
  const { root, home, cfg } = scratch(t);
  fs.mkdirSync(home); fs.writeFileSync(path.join(home, "auth.json"), "deliberately not JSON", { mode: 0o600 });
  const marker = path.join(root, "interactive-probed"), sentinel = path.join(root, "interactive-codex");
  fs.writeFileSync(sentinel, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const targets = Object.fromEntries(Object.keys(cfg.targets).map((id) => [id, { enabled: false }]));
  targets.codex = { ...cfg.targets.codex, bin: sentinel } as any;
  const config = path.join(root, "relay.json"); fs.writeFileSync(config, JSON.stringify({ targets }));
  const r = spawnSync(process.execPath, [CLI, "doctor"], { encoding: "utf8", timeout: 20000,
    env: { ...process.env, HOME: root, CODEX_HOME: path.join(root, "interactive-home"), RELAY_HOME: path.join(root, "control"), RELAY_CONFIG: config } });
  assert.equal(r.error, undefined);
  assert.match(r.stdout, /login present \(auth.json metadata only/);
  assert.match(r.stdout, /codex pin.*no valid qualified pin/);
  assert.match(r.stdout, /codex-qualifier\.mjs/);
  assert.match(r.stdout, /codex pin.*Run `relay qualify-codex` once/, "doctor names the command that makes a pin");
  assert.equal(fs.existsSync(marker), false);
});

test("owned home replaces config idempotently and preserves AGENTS symlink; doctor stats auth only", (t) => {
  const { root, home, cfg } = scratch(t);
  fs.mkdirSync(home);
  prepareCodexHome(cfg);
  const instructions = path.join(root, "instructions.md");
  fs.writeFileSync(instructions, "instructions");
  fs.symlinkSync(instructions, path.join(home, "AGENTS.md"));
  // Relay's own home (its marker file), whose config.toml someone rewrote: replaced.
  fs.writeFileSync(path.join(home, "config.toml"), "untrusted = true\n");
  prepareCodexHome(cfg);
  const first = fs.statSync(path.join(home, "config.toml"));
  prepareCodexHome(cfg);
  assert.equal(fs.statSync(path.join(home, "config.toml")).mtimeMs, first.mtimeMs);
  assert.equal(fs.readlinkSync(path.join(home, "AGENTS.md")), instructions);
  assert.doesNotMatch(fs.readFileSync(path.join(home, "config.toml"), "utf8"), /untrusted/);
  assert.equal(codexHomeStatus(cfg).login, "missing");
  const auth = path.join(home, "auth.json");
  fs.writeFileSync(auth, "not JSON: must never be read", { mode: 0o600 });
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: any[]) => {
    assert.notEqual(args[0], auth, "login detection must never read credential contents");
    return Reflect.apply(read, fs, args);
  });
  assert.equal(codexHomeStatus(cfg).login, "present");
  fs.chmodSync(auth, 0o644);
  assert.equal(codexHomeStatus(cfg).login, "unsafe permissions");
  fs.unlinkSync(auth); fs.symlinkSync(instructions, auth);
  assert.equal(codexHomeStatus(cfg).login, "unsafe permissions", "symlinked auth is never a private login");
});

test("a configured Codex home relay does not own is refused before any write: ~/.codex, CODEX_HOME, foreign contents", (t) => {
  const { root, home, store } = scratch(t);
  const at = (dir: string) => withDefaults({ targets: { codex: { home: dir, pin_store: store, pinned: true } } });
  const savedCodexHome = process.env.CODEX_HOME;
  t.after(() => { if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome; });
  const untouched = (dir: string, files: Record<string, string>, mode: number) => {
    assert.equal(fs.statSync(dir).mode & 0o777, mode, `${dir} keeps its mode`);
    for (const [name, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), text, `${name} kept`);
    assert.equal(fs.existsSync(path.join(dir, RELAY_CODEX_HOME_MARKER)), false, "no marker written");
  };

  // The person's own Codex home, ~/.codex: refused, existing or not, and named so.
  const own = path.join(os.homedir(), ".codex");
  t.after(() => fs.rmSync(own, { recursive: true, force: true }));
  assert.match(codexHomeProblem(at(own))!, /your own Codex's home \(~\/\.codex\)/);
  assert.throws(() => prepareCodexHome(at(own)), /your own Codex's home/);
  assert.equal(fs.existsSync(own), false, "not made");
  fs.mkdirSync(own, { mode: 0o755 }); fs.chmodSync(own, 0o755);
  fs.writeFileSync(path.join(own, "config.toml"), 'model = "mine"\n');
  assert.throws(() => prepareCodexHome(at(own)), /your own Codex's home/);
  untouched(own, { "config.toml": 'model = "mine"\n' }, 0o755);
  // Through another name for it (a symlinked parent), compared canonically.
  fs.symlinkSync(os.homedir(), path.join(root, "home-link"));
  assert.throws(() => prepareCodexHome(at(path.join(root, "home-link", ".codex"))), /your own Codex's home/);

  // The CODEX_HOME the environment names, even new or empty: refused.
  const named = path.join(root, "named-codex-home");
  process.env.CODEX_HOME = named;
  assert.throws(() => prepareCodexHome(at(named)), /the Codex home your environment names \(CODEX_HOME\)/);
  assert.equal(fs.existsSync(named), false);
  // ...unless it already is relay's own home (a nested relay, given relay's home by a launched Codex agent).
  delete process.env.CODEX_HOME;
  prepareCodexHome(at(named));
  process.env.CODEX_HOME = named;
  assert.equal(codexHomeProblem(at(named)), null);
  prepareCodexHome(at(named));
  delete process.env.CODEX_HOME;

  // An existing directory with a config.toml relay did not write, or other files: refused, kept as it was.
  const foreign = path.join(root, "foreign");
  fs.mkdirSync(foreign, { mode: 0o755 }); fs.chmodSync(foreign, 0o755);
  fs.writeFileSync(path.join(foreign, "config.toml"), 'model = "theirs"\n');
  assert.throws(() => prepareCodexHome(at(foreign)), /holds a config\.toml relay did not write, so relay will not take it as its Codex home/);
  untouched(foreign, { "config.toml": 'model = "theirs"\n' }, 0o755);
  assert.match(codexHomeStatus(at(foreign)).problem!, /config\.toml relay did not write/);
  const loggedIn = path.join(root, "logged-in");
  fs.mkdirSync(loggedIn, { mode: 0o755 }); fs.chmodSync(loggedIn, 0o755);
  fs.writeFileSync(path.join(loggedIn, "auth.json"), "{}");
  assert.throws(() => prepareCodexHome(at(loggedIn)), /holds files relay did not put there \(auth\.json\)/);
  untouched(loggedIn, { "auth.json": "{}" }, 0o755);
  // A file or a symlink is never a home.
  fs.symlinkSync(foreign, path.join(root, "link-home"));
  assert.throws(() => prepareCodexHome(at(path.join(root, "link-home"))), /must be a directory, not a symlink/);

  // Relay's: a new directory, an empty one, and one an earlier relay made (its managed config.toml, no marker file).
  prepareCodexHome(at(home));
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.ok(fs.statSync(path.join(home, RELAY_CODEX_HOME_MARKER)).isFile());
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  prepareCodexHome(at(empty));
  assert.equal(fs.readFileSync(path.join(empty, "config.toml"), "utf8"), RELAY_CODEX_CONFIG);
  const earlier = path.join(root, "earlier");
  fs.mkdirSync(earlier);
  fs.writeFileSync(path.join(earlier, "config.toml"), RELAY_CODEX_CONFIG);
  fs.writeFileSync(path.join(earlier, "auth.json"), "{}", { mode: 0o600 });
  assert.equal(codexHomeStatus(at(earlier)).problem, null);
  prepareCodexHome(at(earlier));
  assert.ok(fs.existsSync(path.join(earlier, RELAY_CODEX_HOME_MARKER)), "adopted: the marker keeps it relay's whatever config.toml later holds");
  fs.writeFileSync(path.join(earlier, "config.toml"), "edited = true\n");
  prepareCodexHome(at(earlier));
  assert.equal(fs.readFileSync(path.join(earlier, "config.toml"), "utf8"), RELAY_CODEX_CONFIG);
});

test("qualification's code-only fixture seam is home-specific and resets to generated production config", (t) => {
  const { home, cfg } = scratch(t);
  t.after(() => setCodexHomeConfigForTests(null));
  const synthetic = 'cli_auth_credentials_store = "file"\nmodel = "fake-model"\n';
  setCodexHomeConfigForTests((at) => at === home ? synthetic : undefined);
  prepareCodexHome(cfg);
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), synthetic);
  setCodexHomeConfigForTests(null);
  prepareCodexHome(cfg);
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), RELAY_CODEX_CONFIG);
});

test("whole home and store are protected; native readback rejects lost or widened protections", (t) => {
  const { root, home, store, cfg } = scratch(t);
  const file = path.join(root, "relay-config.json");
  fs.writeFileSync(file, JSON.stringify({ targets: { codex: cfg.targets.codex } }));
  const saved = process.env.RELAY_CONFIG; process.env.RELAY_CONFIG = file;
  t.after(() => { if (saved === undefined) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = saved; });
  assert.ok(relayCredentialProtected(cfg).some((p) => p.path === home));
  assert.ok(relayWriteProtected().some((p) => p.path === store));
  for (const p of [home, path.join(home, "auth.json"), store, path.join(store, "staging"), root]) {
    for (const mode of ["change", "reach"] as const) assert.ok(offLimits({ cwd: root, worktree: null }, [p], mode), `${mode}: ${p}`);
  }
  const permissions = codexPermissions({ access: "write", config: cfg }, { dangerous: false, network: false, roots: [root], codexHome: home });
  assert.equal(permissions.profile!.filesystem[home], "deny");
  assert.equal(permissions.profile!.filesystem[store], "read");
  for (const p of [home, store]) for (const access of [undefined, "read", "write"]) {
    if (access === permissions.profile!.filesystem[p]) continue;
    const eff = { approvals_reviewer: "user", default_permissions: permissions.id, permissions: { relay: structuredClone(permissions.profile) } };
    if (access === undefined) delete eff.permissions.relay!.filesystem[p];
    else (eff.permissions.relay!.filesystem as any)[p] = access;
    assert.ok(configProblem(eff, { permissions, relay: null, relayOnly: false, accountLogin: false }), `${p}: ${access}`);
  }
});

test("grant admission refuses new and retained grants covering either root, descendants or ancestors", (t) => {
  const { root, home, store, cfg } = scratch(t);
  for (const dir of [path.join(home, "child"), path.join(store, "staging")]) fs.mkdirSync(dir, { recursive: true });
  const config = path.join(root, "relay-config.json"); fs.writeFileSync(config, JSON.stringify({ targets: { codex: cfg.targets.codex } }));
  const savedConfig = process.env.RELAY_CONFIG, savedHome = process.env.RELAY_HOME;
  process.env.RELAY_CONFIG = config; process.env.RELAY_HOME = path.join(root, "control");
  t.after(() => {
    closeDbForTests();
    if (savedConfig === undefined) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = savedConfig;
    if (savedHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = savedHome;
  });
  const runId = createRun(root, cfg, "pin-test-root");
  const caller = { runId, node: null, depth: 0, cwd: root, access: "write" as const };
  for (const p of [home, store, path.join(home, "child"), path.join(store, "staging"), root]) {
    for (const held of [false, true]) {
      const grant = { write_paths: [p] };
      const result = admitWork(caller, "codex", { mode: "write", continues: held, ...(held ? { kept: grant } : { grant }) }, {});
      assert.ok("reason" in result, `${held ? "retained" : "new"} ${p}`);
      assert.match((result as { reason: string }).reason, /overlaps/);
    }
  }
});

test("native command approvals cannot discard runtime write denials or add access over protected roots", (t) => {
  const { root, home, store, cfg } = scratch(t);
  assert.match(codexRuntimeApprovalProblem({ command: "npm test" }, cfg) ?? "", /write access across/);
  assert.equal(codexRuntimeApprovalProblem({ kind: "writeStdin" }, cfg), null);
  assert.equal(codexRuntimeApprovalProblem({ additionalPermissions: { network: { enabled: true } } }, cfg), null);
  for (const p of [home, store, root, path.join(store, "staging")]) {
    for (const access of ["read", "write"]) {
      assert.ok(codexRuntimeApprovalProblem({ additionalPermissions: { fileSystem: { entries: [{ path: { type: "path", path: p }, access }] } } }, cfg));
    }
    assert.ok(codexRuntimeApprovalProblem({ additionalPermissions: { fileSystem: { write: [p] } } }, cfg));
  }
  assert.equal(codexRuntimeApprovalProblem({ additionalPermissions: { fileSystem: { write: [path.join(root, "safe")] } } }, cfg), null);
  assert.ok(codexRuntimeApprovalProblem({ additionalPermissions: { fileSystem: { entries: [{ path: { type: "special", value: { kind: "root" } }, access: "write" }] } } }, cfg));
  assert.ok(codexRuntimeApprovalProblem({ additionalPermissions: { future: true } }, cfg));
});

test("all Seatbelt shapes deny the entire home and hard-deny writes throughout the readable pin store", (t) => {
  const { root, home, store, cfg } = scratch(t);
  const config = path.join(root, "relay-config.json");
  fs.writeFileSync(config, JSON.stringify({ targets: { codex: cfg.targets.codex } }));
  const saved = process.env.RELAY_CONFIG; process.env.RELAY_CONFIG = config;
  t.after(() => { if (saved === undefined) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = saved; });
  const wt = path.join(root, "wt"), tmp = path.join(root, "tmp");
  fs.mkdirSync(wt); fs.mkdirSync(tmp); fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  const stage2 = { mode: "stage2" as const, deniedTcp: [22], deniedUdp: [1900], relayRange: [50000], execPort: 50000, bindPorts: [50001, 50002, 50003, 50004], worktreeSockets: false };
  for (const network of [{ mode: "on" as const }, { mode: "off-except-proxy" as const, proxyPort: 40000, proxyToken: "a".repeat(32) }, stage2]) {
    const policy = { worktree: wt, worktreePin: dirIdentity(wt), worktreeWritable: true, tmpDir: tmp, denied: [], network };
    const { profile, params } = seatbeltProfile(policy);
    const key = params.find(([k, v]) => k.startsWith("DENIED_") && v === home)?.[0];
    assert.ok(key);
    assert.ok(profile.includes(`(deny file-read* file-write* file-test-existence (subpath (param "${key}"))`));
    const storeKey = params.find(([k, v]) => k.startsWith("INSTALL_") && v === store)?.[0];
    assert.ok(storeKey);
    assert.ok(profile.includes(`(literal (param "${storeKey}")) (subpath (param "${storeKey}"))`));
    assert.match(profile, /deny file-write\* file-write-data file-write-create file-write-unlink file-write-mode file-link/);
    assert.ok(!params.some(([k, v]) => k.startsWith("DENIED_") && v === store), "store stays readable/executable");
  }
  const spec = { target: targetDef("codex"), config: cfg, access: "write", cwd: wt, worktreePin: dirIdentity(wt), relay: null } as any;
  assert.ok(executorPolicy(spec, tmp, stage2).denied.includes(home));
  assert.equal(selectEnvironment("codex", cfg, { HOME: root, CODEX_HOME: path.join(root, "interactive") }).env.CODEX_HOME, home);
});
