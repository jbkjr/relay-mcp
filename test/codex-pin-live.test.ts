// Person-run only. All credential/store fixtures are scratch; no login or model is used.
import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { withDefaults } from "../dist/core/config.js";
import { dirIdentity } from "../dist/confine/index.js";
import { seatbeltLaunch } from "../dist/confine/seatbelt.js";
import { codexPermissions, permissionFlags } from "../dist/backends/codex.js";

const enabled = process.env.RELAY_PC_LIVE === "1";
const program = `
const fs = require('node:fs'), cp = require('node:child_process');
const [home, store, root] = process.argv.slice(1);
const attempt = f => { try { f(); return true; } catch { return false; } };
console.log(JSON.stringify([
  attempt(() => fs.readFileSync(home + '/auth.json')),
  attempt(() => fs.readFileSync(home + '/config.toml')),
  attempt(() => fs.readdirSync(home)),
  attempt(() => fs.writeFileSync(home + '/new-secret', 'bad')),
  attempt(() => fs.writeFileSync(home + '/auth.json', 'bad')),
  attempt(() => fs.renameSync(home, root + '/stolen-home')),
  attempt(() => fs.readFileSync(store + '/manifest.json')),
  attempt(() => cp.execFileSync(store + '/bin/codex')),
  attempt(() => fs.writeFileSync(store + '/manifest.json', 'bad')),
  attempt(() => fs.writeFileSync(store + '/staging/injected', 'bad')),
  attempt(() => fs.symlinkSync(root, store + '/staging/injected-link')),
  attempt(() => fs.unlinkSync(store + '/current')),
  attempt(() => fs.renameSync(root + '/replacement-pointer', store + '/current')),
  attempt(() => fs.renameSync(store, root + '/stolen-store')),
  attempt(() => fs.writeFileSync(root + '/control-write', 'ok')),
]));`;

test("PC live: home denied and pin store readable/executable but never writable in ACP and stage-2 profiles and native Codex", { skip: !enabled }, () => {
  assert.equal(process.platform, "darwin");
  const codex = process.env.RELAY_PC_CODEX_BIN;
  assert.ok(codex && path.isAbsolute(codex), "supply RELAY_PC_CODEX_BIN pointing at a separately staged qualified binary, outside real credential/pin stores");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-pc-live-")));
  const saved = process.env.RELAY_CONFIG;
  try {
    const home = path.join(root, "home"), store = path.join(root, "pins"), wt = path.join(root, "wt"), tmp = path.join(root, "tmp");
    for (const dir of [home, path.join(store, "bin"), path.join(store, "staging"), wt, tmp]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
    fs.writeFileSync(path.join(home, "auth.json"), "scratch credential", { mode: 0o600 });
    fs.writeFileSync(path.join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    fs.writeFileSync(path.join(store, "manifest.json"), "readable fixture");
    fs.writeFileSync(path.join(store, "bin/codex"), "#!/bin/sh\necho readable-executable\n", { mode: 0o755 });
    fs.symlinkSync("bin/codex", path.join(store, "current"));
    fs.symlinkSync("bin/codex", path.join(root, "replacement-pointer"));
    const cfg = withDefaults({ targets: { codex: { home, pin_store: store, pinned: false } } });
    process.env.RELAY_CONFIG = path.join(root, "relay.json");
    fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ targets: { codex: cfg.targets.codex } }));
    const env = { HOME: root, CODEX_HOME: home, TMPDIR: tmp, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const args = ["-e", program, home, store, root];
    const expected = [false, false, false, false, false, false, true, true, false, false, false, false, false, false, true];
    const check = (command: string, argv: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
      const r = spawnSync(command, argv, { cwd: wt, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60000 });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), expected);
      assert.equal(fs.readFileSync(path.join(home, "auth.json"), "utf8"), "scratch credential");
    };
    const stage2 = { mode: "stage2" as const, deniedTcp: [22], deniedUdp: [1900], relayRange: [50000], execPort: 50000, bindPorts: [50001], worktreeSockets: false };
    for (const network of [{ mode: "on" as const }, { mode: "off-except-proxy" as const, proxyPort: 40000, proxyToken: "a".repeat(32) }, stage2]) {
      const launch = seatbeltLaunch({ worktree: wt, worktreePin: dirIdentity(wt), worktreeWritable: true, writable: [root], tmpDir: tmp, denied: [], network }, process.execPath, args);
      check(launch.command, launch.args, launch.env);
    }
    const permissions = codexPermissions({ access: "write", config: cfg }, { dangerous: false, network: false, roots: [root], codexHome: home });
    check(codex, ["sandbox", ...permissionFlags(permissions), "--", process.execPath, ...args]);
  } finally {
    if (saved === undefined) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
