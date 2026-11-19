import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ConfinementPolicy } from "../dist/confine/index.js";
import { canonical, seatbeltLaunch, seatbeltProfile, SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
// For its side effect: the test process gets a scratch HOME (see helpers.ts).
import "./helpers.ts";

const macOS = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
const STUB_HARNESS = path.resolve(import.meta.dirname, "stubs", "confined-harness.mjs");

function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-exec-")));
  const wt = path.join(root, "wt");
  const tmp = path.join(root, "turn-tmp");
  const elsewhere = path.join(root, "elsewhere");
  const tools = path.join(root, "toolchain", "bin");
  for (const d of [wt, tmp, elsewhere, tools]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  const script = (p: string, body = "echo ran") => (fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }), p);
  return { root, wt, tmp, elsewhere, tools, script, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const policyFor = (s: ReturnType<typeof scratch>, extra: Partial<ConfinementPolicy> = {}): ConfinementPolicy => ({
  worktree: s.wt, worktreeWritable: true, tmpDir: s.tmp, denied: [], network: { mode: "on" }, ...extra,
});

test("exec list: the profile names what may run instead of allowing every executable", () => {
  const s = scratch();
  try {
    const harness = s.script(path.join(s.tools, "harness"));
    const { profile, params } = seatbeltProfile(policyFor(s, { execPaths: [s.tools, path.join(s.elsewhere, "one-tool")] }), harness);
    assert.ok(!/\(allow process-exec[\s)]*\)|\(allow process-exec process-fork\)/.test(profile), "no unfiltered process-exec");
    assert.match(profile, /\(allow process-fork\)/);
    const values = Object.fromEntries(params);
    assert.equal(values.HARNESS, harness);
    assert.equal(values.INTERPRETER, "/bin/sh", "a script's interpreter, named on its #! line");
    assert.equal(values.RELAY_NODE, canonical(process.execPath));
    assert.equal(values.EXEC_0, s.tools);
    assert.match(profile, /\(subpath \(param "EXEC_0"\)\)/, "a directory with everything in it");
    assert.match(profile, /\(literal \(param "EXEC_1"\)\)/, "a file (or a path not there yet) by name");
    assert.match(profile, /\(literal \(param "HARNESS"\)\)/);
    const exec = profile.slice(profile.indexOf("(allow process-exec"), profile.indexOf("(allow file-write*"));
    for (const p of ['"/bin"', '"/usr/bin"', '"/opt/homebrew"', '"/Library/Developer/CommandLineTools"', "Xcode"]) assert.ok(exec.includes(p), p);
    assert.ok(exec.includes('(subpath (param "WRITABLE_0"))') && exec.includes('(subpath (param "WRITABLE_1"))'), "the worktree and temp dir: what the agent builds can run");
    // A harness run through env names no interpreter; the driver lists it in execPaths.
    const viaEnv = path.join(s.tools, "env-harness");
    fs.writeFileSync(viaEnv, "#!/usr/bin/env node\n", { mode: 0o755 });
    assert.equal(Object.fromEntries(seatbeltProfile(policyFor(s), viaEnv).params).INTERPRETER, undefined);
    assert.throws(() => seatbeltProfile(policyFor(s, { execPaths: ["relative/bin"] }), harness), /execPaths\[0\]/);
  } finally {
    s.done();
  }
});

test("exec list e2e: the stub harness, system tools, git and what the agent builds run; executables elsewhere do not", { skip: !macOS && "macOS only" }, () => {
  const s = scratch();
  try {
    const outside = s.script(path.join(s.elsewhere, "tool"), "echo escaped");
    const listed = s.script(path.join(s.tools, "tool"), "echo listed");
    const built = s.script(path.join(s.wt, "build.sh"), "echo built");
    fs.writeFileSync(path.join(s.wt, "node-script"), "#!/usr/bin/env node\nconsole.log('node script')\n", { mode: 0o755 });

    // The stub harness itself starts and answers under the profile built for it.
    const harness = seatbeltLaunch(policyFor(s), process.execPath, [STUB_HARNESS, JSON.stringify({ bridge: { command: "/usr/bin/true", args: [] } })]);
    const h = spawnSync(harness.command, harness.args, { cwd: s.wt, env: { PATH: process.env.PATH!, ...harness.env }, encoding: "utf8", input: "" });
    assert.match(h.stdout + h.stderr, /ready|could not start the bridge/, `the stub harness ran: ${h.stderr}`);

    const run = (script: string, extra: Partial<ConfinementPolicy> = {}) => {
      const l = seatbeltLaunch(policyFor(s, extra), "/bin/sh", ["-c", script]);
      return spawnSync(l.command, l.args, { cwd: s.wt, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...l.env }, encoding: "utf8" });
    };
    const r = run(`/usr/bin/true && echo sys; git --version >/dev/null && echo git; ${built}; ./node-script; ${outside}; echo "outside=$?"; ${listed}; echo "listed=$?"`);
    assert.match(r.stdout, /^sys$/m);
    assert.match(r.stdout, /^git$/m, `git runs: ${r.stderr}`);
    assert.match(r.stdout, /^built$/m, "a script the agent made in the worktree runs");
    assert.match(r.stdout, /^node script$/m, "an env-node script runs: relay's Node is listed");
    assert.match(r.stdout, /^outside=126$/m);
    assert.ok(!/escaped/.test(r.stdout));
    assert.match(r.stderr, /Operation not permitted/);
    assert.match(r.stdout, /^listed=126$/m, "not listed unless the policy says so");
    assert.match(run(listed, { execPaths: [s.tools] }).stdout, /^listed$/m);
    // A copy of a listed executable placed elsewhere is not listed.
    fs.copyFileSync(listed, path.join(s.elsewhere, "copy"));
    fs.chmodSync(path.join(s.elsewhere, "copy"), 0o755);
    assert.notEqual(run(path.join(s.elsewhere, "copy"), { execPaths: [s.tools] }).status, 0);
  } finally {
    s.done();
  }
});
