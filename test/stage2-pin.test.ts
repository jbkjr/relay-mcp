// Pure staging/driver fixtures: no listeners, subprocesses, sandbox-exec or real Codex.
import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stageQualificationPin } from "../scripts/codex-qualify/codex-stage2-pin.mjs";
import { sha256, validateManifest, readManifest } from "../scripts/codex-qualify/codex-pin-store.mjs";
import { internal } from "../scripts/codex-qualify/codex-stage2.mjs";
import { withDefaults } from "../dist/core/config.js";
import * as pinModule from "../dist/backends/codex-pin.js";
import { stage2Admission, stage2Plan } from "../dist/backends/codex-stage2.js";
import { targetDef } from "../dist/targets/index.js";

function scratch(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-stage2-pin-")));
  t.after(() => {
    const unseal = (dir: string) => {
      fs.chmodSync(dir, 0o700);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unseal(path.join(dir, e.name));
    };
    unseal(root); fs.rmSync(root, { recursive: true, force: true });
  });
  const bin = path.join(root, "candidate");
  fs.writeFileSync(bin, "candidate bytes", { mode: 0o755 });
  return { root, bin };
}

test("stage2 pin: fresh candidate is copied, sealed and selected without an existing pin or verdict", (t) => {
  const { root, bin } = scratch(t);
  const pin = stageQualificationPin({ scratch: root, bin, version: "0.164.0" });
  const hash = sha256(bin), dir = path.dirname(path.dirname(pin.bin));
  assert.equal(pin.pin_store, path.join(root, "home/.local/share/relay-codex-pins"));
  assert.equal(pin.home, path.join(root, "home/.local/share/relay-codex-home"));
  assert.equal(fs.readlinkSync(path.join(pin.pin_store, "current")), `versions/0.164.0-${hash.slice(0, 12)}`);
  assert.equal(fs.realpathSync(pin.bin), pin.bin);
  assert.equal(sha256(pin.bin), hash);
  assert.notEqual(fs.statSync(pin.bin).ino, fs.statSync(bin).ino, "copy, not a hard link to mutable input");
  for (const p of [dir, path.join(dir, "bin"), pin.bin, path.join(dir, "manifest.json")]) assert.equal(fs.statSync(p).mode & 0o222, 0, p);
  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")));
  assert.equal(manifest.qualificationFixture, true);
  assert.equal(manifest.binarySha256, hash);
  assert.equal(fs.existsSync(manifest.verdictPath), false, "no fabricated passing verdict");
  assert.throws(() => readManifest(dir), /ENOENT/, "scratch fixture cannot be promoted as a qualified publication");
  const cfg = pinModule.freezeCodexConfig(withDefaults({ targets: { codex: pin } }));
  assert.equal(cfg.targets.codex.bin, pin.bin);
  assert.equal(cfg.targets.codex.pinned, true);
  fs.writeFileSync(bin, "changed input");
  assert.equal(sha256(pin.bin), hash, "qualification uses the staged bytes");
});

test("stage2 pin: launcher symlink resolves to candidate and its adjacent code-mode host", (t) => {
  const { root, bin } = scratch(t);
  const host = path.join(root, "codex-code-mode-host");
  fs.writeFileSync(host, "candidate host", { mode: 0o755 });
  const launchers = path.join(root, "launchers"); fs.mkdirSync(launchers);
  const link = path.join(launchers, "codex"); fs.symlinkSync(bin, link);
  fs.writeFileSync(path.join(launchers, "codex-code-mode-host"), "wrong host");
  const pin = stageQualificationPin({ scratch: root, bin: link, version: "0.164.0" });
  const copied = path.join(path.dirname(pin.bin), "codex-code-mode-host");
  assert.equal(fs.readFileSync(copied, "utf8"), "candidate host");
  assert.equal(fs.lstatSync(copied).isFile(), true);
  assert.equal(fs.statSync(copied).mode & 0o777, 0o555);
  assert.equal(fs.statSync(host).mode & 0o777, 0o755, "input stays untouched");
});

for (const version of ["0.164.0", "0.166.0", "0.167.0", "0.167.2", "0.170.0"]) test(`stage2 pin: ${version} feature policy stays with the validated executable after current changes`, (t) => {
  const { root, bin } = scratch(t);
  const pin = stageQualificationPin({ scratch: root, bin, version });
  const config = pinModule.freezeCodexConfig(withDefaults({ targets: { codex: pin } }));
  assert.deepEqual(pinModule.codexPinVersion(config), version.split(".").map(Number));
  assert.ok(Object.isFrozen(pinModule.codexPinVersion(config)));
  const current = path.join(pin.pin_store, "current");
  fs.unlinkSync(current); fs.symlinkSync("versions/missing", current);
  assert.equal(pinModule.freezeCodexConfig(config), config);
  const plan = stage2Plan({ config } as any, {} as any);
  for (const f of ["plugin_discovery_prefetch", "prediction_preserve_parent_tools"]) {
    assert.equal(Object.hasOwn(plan.features, f), version !== "0.164.0");
    assert.equal(plan.c.includes(`features.${f}=false`), version !== "0.164.0");
  }
  // Listed by every admitted version: pinned off on each.
  assert.equal(plan.features.deferred_tool_world_state, false);
  assert.ok(plan.c.includes("features.deferred_tool_world_state=false"));
  // Listed from 0.167.2: pinned off there, never required of an older version.
  const from = (min: string) => version.localeCompare(min, undefined, { numeric: true }) >= 0;
  assert.equal(Object.hasOwn(plan.features, "incremental_tools_legacy_gcp"), from("0.167.2"));
  assert.equal(plan.c.includes("features.incremental_tools_legacy_gcp=false"), from("0.167.2"));
  // Default on from 0.170.0: pinned off there, never required of an older version.
  for (const f of ["code_mode_host_grpc", "untrusted_as_tool_output", "incremental_tools_legacy"]) {
    assert.equal(Object.hasOwn(plan.features, f), from("0.170.0"), `${version} ${f}`);
    assert.equal(plan.c.includes(`features.${f}=false`), from("0.170.0"), `${version} ${f}`);
  }
  assert.throws(() => pinModule.freezeCodexConfig(withDefaults({ targets: { codex: pin } })), /no valid qualified pin/);
});

test("stage2 pin: old control passes pin validation then fails admission's version gate", (t) => {
  const { root, bin } = scratch(t);
  const candidate = stageQualificationPin({ scratch: root, bin, version: "0.164.0" });
  const controlRoot = path.join(root, "control"); fs.mkdirSync(controlRoot);
  const oldBin = path.join(root, "old"); fs.writeFileSync(oldBin, "old bytes");
  const control = stageQualificationPin({ scratch: controlRoot, bin: oldBin, version: "0.163.0" });
  const check = (pin: any, version: number[]) => {
    const config = pinModule.freezeCodexConfig(withDefaults({ child_mcp: "relay-only", child_hooks: false, targets: { codex: { ...pin, stage2: true } } }));
    return stage2Admission({ config, target: targetDef("codex"), access: "write", cwd: root, relay: null, grant: { network: true, raw_network: true } } as any,
      { HOME: path.join(root, "home"), CODEX_HOME: pin.home }, {
        version: (selected) => { assert.equal(selected, pin.bin); return version; },
        mcpServers: () => [], consent: () => null, interlock: () => null, aliases: () => null,
      });
  };
  assert.match(check(control, [0, 163, 0]) ?? "", /Codex is 0\.163\.0, and stage 2 needs 0\.164\.0 or later/);
  assert.equal(check(candidate, [0, 164, 0]), null);
  assert.equal(pinModule.freezeCodexConfig(withDefaults({ targets: { codex: candidate } })).targets.codex.bin, candidate.bin);
});

test("stage2 pin: refuses reuse and leaves the already selected candidate intact", (t) => {
  const { root, bin } = scratch(t);
  const pin = stageQualificationPin({ scratch: root, bin, version: "0.164.0" });
  const target = fs.readlinkSync(path.join(pin.pin_store, "current"));
  assert.throws(() => stageQualificationPin({ scratch: root, bin, version: "0.165.0" }), /EEXIST/);
  assert.equal(fs.readlinkSync(path.join(pin.pin_store, "current")), target);
});

for (const redirected of ["home", "home/.local/share"]) test(`stage2 pin: refuses an external scratch ${redirected} symlink before writing there`, (t) => {
  const { root, bin } = scratch(t), outside = scratch(t).root;
  const link = path.join(root, redirected);
  fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(outside, link);
  assert.throws(() => stageQualificationPin({ scratch: root, bin, version: "0.164.0" }), /escapes scratch root/);
  assert.deepEqual(fs.readdirSync(outside), ["candidate"]);
});

test("stage2 pin: rejects malformed versions before creating a store", (t) => {
  const { root, bin } = scratch(t);
  for (const version of ["../escape", "0.164.0-beta", "0.164"]) assert.throws(() => stageQualificationPin({ scratch: root, bin, version }), /stable semver/);
  assert.deepEqual(fs.readdirSync(root), ["candidate"]);
});

for (const fail of [false, true]) test(`stage2 driver: owned home preserves synthetic config and resets fixture seam (launch fails=${fail})`, async (t) => {
  const { root, bin } = scratch(t);
  const pin = stageQualificationPin({ scratch: root, bin, version: "0.164.0" });
  const d: any = { dir: path.join(root, "case") };
  for (const key of ["home", "user", "wt", "apptmp"]) { d[key] = path.join(d.dir, key); fs.mkdirSync(d[key], { recursive: true }); }
  const saved = { HOME: process.env.HOME, RELAY_HOME: process.env.RELAY_HOME };
  Object.assign(process.env, { HOME: path.join(root, "home"), RELAY_HOME: path.join(root, "relay-home") });
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; pinModule.setCodexHomeConfigForTests(null); });
  let closed = false, started = false;
  const dist = {
    pin: pinModule, config: { withDefaults }, targets: { targetDef },
    db: { insertTurn: () => "t_fixture", getNode: () => ({}) },
    approvals: { pendingRequests: () => [{ node_id: "j_fixture", kind: "raw_network", id: "a_fixture" }], decide: () => null },
    rawNetwork: { rawNetworkConsent: async () => null },
    secrets: { withTurnSecrets: (f: any) => f(), redact: (s: string) => s },
    codex: { codexBackend: { start: async (spec: any) => {
      started = true;
      const cfg = pinModule.freezeCodexConfig(spec.config);
      assert.equal(cfg.targets.codex.bin, pin.bin);
      assert.equal(cfg.targets.codex.pin_store, pin.pin_store);
      assert.equal(cfg.targets.codex.home, d.home);
      pinModule.prepareCodexHome(cfg);
      const contents = fs.readFileSync(path.join(d.home, "config.toml"), "utf8");
      assert.match(contents, /cli_auth_credentials_store = "file"/);
      assert.match(contents, /http:\/\/127\.0\.0\.1:54321\/v1/);
      assert.match(contents, /fixture_catalog/);
      assert.match(contents, /mcp_servers\.relay_tools/);
      if (fail) throw new Error("fixture launch failure");
      return { done: Promise.resolve({ status: "ok" }) };
    } } },
  };
  const ctx = { dist, pin, dir: root, model: "fixture-model", catalog: "fixture_catalog", jobs: new Map([[d.dir, { runId: "r_fixture", nodeId: "j_fixture" }]]) };
  const run = internal.relayTurn(ctx, { name: "fixture", dirs: d, model$: { port: 54321, close: async () => { closed = true; } }, extraConfig: () => '[mcp_servers.relay_tools]\ncommand = "/usr/bin/false"' });
  if (fail) await assert.rejects(run, /fixture launch failure/);
  else assert.equal((await run).result.status, "ok");
  assert.equal(started, true); assert.equal(closed, true);
  pinModule.prepareCodexHome(withDefaults({ targets: { codex: { ...pin, home: d.home } } }));
  assert.equal(fs.readFileSync(path.join(d.home, "config.toml"), "utf8"), pinModule.RELAY_CODEX_CONFIG);
});
