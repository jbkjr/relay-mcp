import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareLaunch, type ConfinementPolicy, type HarnessState } from "../dist/confine/index.js";
import { seatbelt, seatbeltLaunch, seatbeltProfile, SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
import { scratchEnv, scratchOnly } from "./helpers.ts";

const macOS = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);

/**
 * A turn and a stand-in for a harness's real login store outside it: a token file, its
 * configuration, a hooks directory and the harness's own binary, all of which outlive the turn.
 */
function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-")));
  const wt = path.join(root, "wt");
  const tmp = path.join(root, "turn-tmp");
  const control = path.join(root, "control");
  const store = path.join(root, "real-home", ".grok");
  for (const d of [wt, tmp, control, path.join(store, "hooks"), path.join(store, "bin")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  fs.writeFileSync(path.join(store, "auth.json"), '{"token":"dummy"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(store, "config.toml"), "model = 'x'\n");
  fs.writeFileSync(path.join(store, "bin", "grok"), "#!/bin/sh\necho grok\n", { mode: 0o755 });
  process.env.RELAY_HOME = control;
  // A scratch home and harness: no test here aims at the real home or an installed binary (review r_faba9d17 C3).
  const realHomeVar = process.env.HOME;
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  process.env.HOME = home;
  const harness = path.join(root, "bin", "harness");
  fs.mkdirSync(path.dirname(harness));
  fs.writeFileSync(harness, "#!/bin/sh\n", { mode: 0o755 });
  return {
    root, wt, tmp, control, store, home, harness,
    done: () => {
      process.env.HOME = realHomeVar;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** prepareLaunch with the harness checked first: an escaping probe writes beside the harness binary, so it must be a scratch file, never an installed program. */
const launchProbed = (policy: ConfinementPolicy, harness: string, args: string[]) => prepareLaunch(seatbelt, policy, scratchOnly(harness, "harness"), args);

const policyFor = (s: ReturnType<typeof scratch>, state?: HarnessState, extra: Partial<ConfinementPolicy> = {}): ConfinementPolicy => ({
  worktree: s.wt, worktreeWritable: true, tmpDir: s.tmp, denied: [s.control], network: { mode: "on" }, ...(state ? { state } : {}), ...extra,
});

test("state: a temporary home by default, inside the turn's temp dir, with the XDG directories in it", () => {
  const s = scratch();
  try {
    const env = seatbeltLaunch(policyFor(s), "/bin/sh", []).env;
    const home = path.join(s.tmp, "home");
    assert.equal(env.HOME, home);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.equal(env.XDG_CONFIG_HOME, path.join(home, ".config"));
    assert.equal(env.XDG_DATA_HOME, path.join(home, ".local", "share"));
    assert.equal(env.XDG_STATE_HOME, path.join(home, ".local", "state"));
    assert.equal(env.XDG_CACHE_HOME, path.join(home, ".cache"));
    assert.equal(env.TMPDIR, s.tmp);
  } finally {
    s.done();
  }
});

test("state: home variables, links to token files (never copies), token files writable by exact name, the harness's own environment", () => {
  const s = scratch();
  try {
    const auth = path.join(s.store, "auth.json");
    const state: HarnessState = {
      home: "temp", homeVars: { GROK_HOME: ".grok" }, links: { ".grok/auth.json": auth }, tokenFiles: [auth],
      env: { GROK_DISABLE_AUTOUPDATER: "1" },
    };
    const l = seatbeltLaunch(policyFor(s, state), "/bin/sh", []);
    const grokHome = path.join(s.tmp, "home", ".grok");
    assert.equal(l.env.GROK_HOME, grokHome);
    assert.equal(l.env.GROK_DISABLE_AUTOUPDATER, "1");
    assert.equal(fs.readlinkSync(path.join(grokHome, "auth.json")), auth, "a link to the real token file");
    // Making the launch twice (the probes, then the harness) is fine.
    seatbeltLaunch(policyFor(s, state), "/bin/sh", []);

    const { profile, params } = seatbeltProfile(policyFor(s, state));
    assert.deepEqual(params.filter(([k]) => k.startsWith("TOKEN_FILE_")), [["TOKEN_FILE_0", auth]]);
    assert.match(profile, /\(allow file-write-data\n {2}\(literal \(param "TOKEN_FILE_0"\)\)\)/);
    assert.ok(profile.indexOf("TOKEN_FILE_0") < profile.indexOf("(deny file-read* file-write*"), "denied directories still win");
    assert.ok(!params.some(([, v]) => v === s.store), "the store itself is not writable");

    // Real home: nothing changes HOME; links and home variables are refused.
    const real = seatbeltLaunch(policyFor(s, { home: "real", tokenFiles: [auth] }), "/bin/sh", []).env;
    assert.equal(real.HOME, undefined);
    assert.equal(real.XDG_CONFIG_HOME, undefined);
    assert.throws(() => seatbeltLaunch(policyFor(s, { home: "real", links: { a: auth } }), "/bin/sh", []), /only to a temporary home/);
  } finally {
    s.done();
  }
});

test("state: refused shapes (directories, executables or denied paths as token files; reserved variables; paths out of the home; state dirs outside the turn)", () => {
  const s = scratch();
  try {
    const bad: [HarnessState | Partial<ConfinementPolicy>, RegExp][] = [
      [{ home: "real", tokenFiles: [s.store] }, /not a regular file/],
      [{ home: "real", tokenFiles: [path.join(s.store, "bin", "grok")] }, /executable/],
      [{ home: "real", tokenFiles: [(fs.writeFileSync(path.join(s.control, "token"), "t"), path.join(s.control, "token"))] }, /inside denied directory/],
      [{ home: "real", tokenFiles: ["relative/auth.json"] }, /not absolute/],
      [{ home: "temp", homeVars: { HOME: "." } }, /cannot set HOME/],
      [{ home: "temp", homeVars: { PATH: "bin" } }, /cannot set PATH/],
      [{ home: "temp", homeVars: { GROK_HOME: "../escape" } }, /inside the temporary home/],
      [{ home: "temp", homeVars: { GROK_HOME: "/abs" } }, /inside the temporary home/],
      [{ home: "temp", links: { "../../x": path.join(s.store, "auth.json") } }, /inside the temporary home/],
      [{ home: "temp", env: { TMPDIR: "/tmp" } }, /cannot set TMPDIR/],
      [{ home: "temp", env: { HTTPS_PROXY: "http://evil" } }, /cannot set HTTPS_PROXY/],
      [{ home: "temp", env: { NODE_OPTIONS: "--require x" } }, /cannot set NODE_OPTIONS/],
      [{ home: "temp", env: { DYLD_INSERT_LIBRARIES: "x" } }, /cannot set DYLD_INSERT_LIBRARIES/],
      [{ home: "temp", homeVars: { GROK_HOME: ".grok" }, env: { GROK_HOME: "/x" } }, /cannot set GROK_HOME/],
      [{ home: "elsewhere" } as unknown as HarnessState, /unknown state.home/],
      [{ stateDirs: [path.join(s.store)] }, /not inside the turn's temporary directory/],
    ];
    for (const [shape, re] of bad) {
      const p = "home" in shape ? policyFor(s, shape as HarnessState) : policyFor(s, undefined, shape as Partial<ConfinementPolicy>);
      assert.throws(() => seatbeltLaunch(p, "/bin/sh", []), re, JSON.stringify(shape));
    }
  } finally {
    s.done();
  }
});

test("state e2e: inside the sandbox the harness reads its login through the link and refreshes the token file, and cannot change its configuration, hooks, binary or the real home", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  // A scratch home, outside every root the profile allows.
  const marker = scratchOnly(path.join(s.home, `.relay-state-e2e-${process.pid}`), "probe");
  try {
    const auth = path.join(s.store, "auth.json");
    const state: HarnessState = { home: "temp", homeVars: { GROK_HOME: ".grok" }, links: { ".grok/auth.json": auth }, tokenFiles: [auth], env: { GROK_DISABLE_AUTOUPDATER: "1" } };
    const policy = policyFor(s, state);
    // The probes pass for this shape, the token file's positive control and the store's denial among them.
    const { launch, probes } = await launchProbed(policy, s.harness, []);
    const by = Object.fromEntries(probes.results.map((r) => [r.name, r.got]));
    // The person's login store, home and harness binary are not live-probed (hardening 9); a decoy
    // outside the roots stands in, and the live e2e below writes the real scratch store and home.
    assert.equal(by["write-decoy-outside"], "EPERM");
    assert.equal(fs.readFileSync(auth, "utf8"), '{"token":"dummy"}\n', "the probes left the login untouched");

    const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    const sh = (script: string) => {
      const l = launch.rewrap("/bin/sh", ["-c", script]);
      return spawnSync(l.command, l.args, { cwd: s.wt, env: scratchEnv({ PATH: "/usr/bin:/bin", HOME: s.home, ...launch.env }), encoding: "utf8" });
    };
    const ok = (script: string) => sh(script).status === 0;
    assert.equal(sh('printf %s "$HOME"').stdout, path.join(s.tmp, "home"));
    assert.ok(ok('grep -q dummy "$GROK_HOME/auth.json"'), "reads its login through the link");
    assert.ok(ok(`printf '{"token":"refreshed"}\\n' > "$GROK_HOME/auth.json"`), "refreshes the token through the link");
    assert.equal(fs.readFileSync(auth, "utf8"), '{"token":"refreshed"}\n');
    assert.ok(ok('echo x > "$HOME/scratch" && echo y > "$XDG_CONFIG_HOME.x"'), "the temporary home is writable");
    assert.ok(!ok(`echo "model = 'evil'" > ${q(path.join(s.store, "config.toml"))}`), "configuration");
    assert.ok(!ok(`echo x > ${q(path.join(s.store, "hooks", "pre"))}`), "hooks");
    assert.ok(!ok(`echo x >> ${q(path.join(s.store, "bin", "grok"))}`), "binary");
    assert.ok(!ok(`echo x > ${q(path.join(s.store, "auth.json.new"))}`), "a new file beside the token file");
    assert.ok(!ok(`mv ${q(auth)} ${q(path.join(s.store, "moved"))}`), "moving the token file away");
    assert.ok(!ok(`echo x > ${q(marker)}`), "the real home");
    assert.equal(fs.readFileSync(path.join(s.store, "config.toml"), "utf8"), "model = 'x'\n");
    assert.ok(!fs.existsSync(marker) && !fs.existsSync(path.join(s.store, "hooks", "pre")));
  } finally {
    fs.rmSync(marker, { force: true });
    s.done();
  }
});

/** A relay-owned harness home kept across turns: relay's settings file, a link to the person's config, and the session directory. */
function persistentHome(s: ReturnType<typeof scratch>) {
  const home = path.join(s.root, "harness", "copilot");
  fs.mkdirSync(path.join(home, "session-state"), { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.writeFileSync(path.join(home, "settings.json"), '{"sandbox":{"enabled":false}}\n', { mode: 0o600 });
  // Stands for the link to the person's own config: it points into the scratch store, never a real home file.
  fs.symlinkSync(path.join(s.store, "config.toml"), path.join(home, "config.json"));
  return home;
}

test("state: relay-owned persistent state is read-only except its writable subdirectories, which must be real directories every turn", () => {
  const s = scratch();
  try {
    const home = persistentHome(s);
    const policy = policyFor(s, { home: "real", persistent: { root: home, writable: ["session-state", "turn/logs"] } });
    const { params } = seatbeltProfile(policy);
    const writable = params.filter(([k]) => k.startsWith("WRITABLE_")).map(([, v]) => v);
    assert.deepEqual(writable, [s.wt, path.join(home, "session-state"), path.join(home, "turn", "logs"), s.tmp], "the subdirectories, not the home");
    assert.ok(fs.lstatSync(path.join(home, "turn", "logs")).isDirectory(), "a missing writable subdirectory is created");

    // Swapped for a link (the agent can delete and replace a writable subdirectory): refused.
    fs.rmSync(path.join(home, "session-state"), { recursive: true });
    fs.symlinkSync(s.store, path.join(home, "session-state"));
    assert.throws(() => seatbeltLaunch(policy, "/bin/sh", []), /replaced by something other than a directory/);
    fs.rmSync(path.join(home, "session-state"));
    fs.writeFileSync(path.join(home, "session-state"), "file");
    assert.throws(() => seatbeltLaunch(policy, "/bin/sh", []), /replaced by something other than a directory/);
    fs.rmSync(path.join(home, "session-state"));
    // A link on the way to a deeper writable subdirectory is refused as well.
    fs.rmSync(path.join(home, "turn"), { recursive: true });
    fs.symlinkSync(s.store, path.join(home, "turn"));
    assert.throws(() => seatbeltLaunch(policy, "/bin/sh", []), /replaced by something other than a directory/);
    fs.rmSync(path.join(home, "turn"));

    const bad: [{ root: string; writable: string[] }, RegExp][] = [
      [{ root: "relative", writable: [] }, /absolute root/],
      [{ root: path.join(s.root, "missing"), writable: [] }, /missing/],
      [{ root: home, writable: ["../escape"] }, /plain relative path/],
      [{ root: home, writable: ["/abs"] }, /plain relative path/],
      [{ root: home, writable: ["a/./b"] }, /plain relative path/],
      [{ root: home, writable: [""] }, /plain relative path/],
      [{ root: s.tmp, writable: [] }, /overlaps/],
      [{ root: s.wt, writable: [] }, /overlaps/],
    ];
    for (const [persistent, re] of bad) assert.throws(() => seatbeltLaunch(policyFor(s, { home: "real", persistent }), "/bin/sh", []), re, JSON.stringify(persistent));
    // The root itself as a link, or writable by others: refused.
    fs.symlinkSync(home, path.join(s.root, "home-link"));
    assert.throws(() => seatbeltLaunch(policyFor(s, { home: "real", persistent: { root: path.join(s.root, "home-link"), writable: [] } }), "/bin/sh", []), /not a plain directory/);
    fs.chmodSync(home, 0o777);
    assert.throws(() => seatbeltLaunch(policy, "/bin/sh", []), /writable by others/);
    fs.chmodSync(home, 0o700);
    assert.throws(() => seatbeltLaunch(policyFor(s, { home: "real", persistent: { root: s.control, writable: [] } }), "/bin/sh", []), /inside denied directory/);
  } finally {
    s.done();
  }
});

test("state e2e: in relay-owned persistent state the agent writes its session directory and nothing else; relay's settings stay as written", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const home = persistentHome(s);
    const policy = policyFor(s, { home: "real", persistent: { root: home, writable: ["session-state", "turn"] } });
    const { launch, probes } = await launchProbed(policy, s.harness, []);
    const by = Object.fromEntries(probes.results.map((r) => [r.name, r.got]));
    assert.equal(by["write-persistent-0"], "allowed");
    assert.equal(by["write-persistent-1"], "allowed");
    assert.equal(by["write-persistent-root"], "EPERM");
    assert.equal(by["modify-persistent:settings.json"], "EPERM", "the settings file cannot be modified");
    assert.equal(by["modify-persistent:config.json"], undefined, "a link is never probed (it may lead to the person's own files)");
    assert.equal(fs.readFileSync(path.join(home, "settings.json"), "utf8"), '{"sandbox":{"enabled":false}}\n');
    assert.deepEqual(fs.readdirSync(path.join(home, "session-state")), [], "the probes left nothing");

    const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    const ok = (script: string) => {
      const l = launch.rewrap("/bin/sh", ["-c", script]);
      return spawnSync(l.command, l.args, { cwd: s.wt, env: { PATH: "/usr/bin:/bin", ...launch.env }, encoding: "utf8" }).status === 0;
    };
    assert.ok(ok(`echo ok > ${q(path.join(home, "session-state", "s.json"))}`), "the session directory is writable");
    assert.ok(ok(`mkdir -p ${q(path.join(home, "turn", "logs"))} && echo l > ${q(path.join(home, "turn", "logs", "x"))}`));
    assert.ok(!ok(`echo '{"sandbox":{"enabled":true}}' > ${q(path.join(home, "settings.json"))}`), "settings");
    assert.ok(!ok(`echo x > ${q(path.join(home, "planted"))}`), "adding to the home");
    assert.ok(!ok(`echo x > ${q(path.join(home, "config.json"))}`), "writing through the link to the config");
    assert.ok(!ok(`rm -f ${q(path.join(home, "settings.json"))}`), "removing relay's settings");
    assert.equal(fs.readFileSync(path.join(home, "settings.json"), "utf8"), '{"sandbox":{"enabled":false}}\n');
    assert.equal(fs.readFileSync(path.join(s.store, "config.toml"), "utf8"), "model = 'x'\n");
    // The agent cannot replace its session directory with a link (review r_11c43840 C1)...
    assert.ok(!ok(`rm -rf ${q(path.join(home, "session-state"))} && ln -s ${q(s.store)} ${q(path.join(home, "session-state"))}`));
    assert.ok(fs.lstatSync(path.join(home, "session-state")).isDirectory());
    // ...and should one be swapped anyway, the next turn is refused before anything runs.
    fs.rmSync(path.join(home, "session-state"), { recursive: true });
    fs.symlinkSync(s.store, path.join(home, "session-state"));
    await assert.rejects(launchProbed(policy, s.harness, []), /replaced by something other than a directory/);
  } finally {
    s.done();
  }
});

test("token files: the agent cannot swap one for a link, and a swapped, linked, foreign or replaced token file refuses the next turn (review r_faba9d17 C1/X1)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const auth = path.join(s.store, "auth.json");
    const victim = path.join(s.root, "outside-victim");
    fs.writeFileSync(victim, "original\n");
    const { tokenFileIdentity } = await import("../dist/confine/seatbelt.js");
    const pin = tokenFileIdentity(auth);
    const policy = policyFor(s, { home: "real", tokenFiles: [pin] });
    const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    const turn = (script: string) => {
      const l = seatbeltLaunch(policy, "/bin/sh", ["-c", script]);
      return spawnSync(l.command, l.args, { cwd: s.wt, env: { PATH: "/usr/bin:/bin", ...l.env }, encoding: "utf8" });
    };
    // Turn 1: in-place refresh works (truncate and append); swapping the file for a link does not.
    assert.equal(turn(`printf '{"token":"new"}\\n' > ${q(auth)}`).status, 0, "rewriting the token in place");
    assert.notEqual(turn(`rm -f ${q(auth)} && ln -s ${q(victim)} ${q(auth)}`).status, 0, "replacing it with a link");
    assert.notEqual(turn(`mv ${q(auth)} ${q(auth + ".old")}`).status, 0, "renaming it away");
    assert.notEqual(turn(`chmod 755 ${q(auth)}`).status, 0, "making it executable");
    assert.ok(!fs.lstatSync(auth).isSymbolicLink());
    // Turn 2 (GPT's reproduction): had a link got there, the next turn would have been granted the victim. Refused instead.
    fs.renameSync(auth, auth + ".saved");
    fs.symlinkSync(victim, auth);
    assert.throws(() => seatbeltLaunch(policy, "/bin/sh", []), /is a symbolic link/);
    assert.throws(() => seatbeltLaunch(policyFor(s, { home: "real", tokenFiles: [auth] }), "/bin/sh", []), /is a symbolic link/, "unpinned too");
    fs.rmSync(auth);
    // A hard link (the victim aliased as the token file).
    fs.linkSync(victim, auth);
    assert.throws(() => seatbeltLaunch(policyFor(s, { home: "real", tokenFiles: [auth] }), "/bin/sh", []), /hard links/);
    fs.rmSync(auth);
    // Replaced by another file: not the one relay pinned at setup.
    fs.writeFileSync(auth, '{"token":"other"}\n');
    assert.throws(() => seatbeltLaunch(policy, "/bin/sh", []), /not the file relay set up/);
    fs.rmSync(auth);
    // Missing: file-write-data cannot create it, and relay will not guess.
    assert.throws(() => seatbeltLaunch(policyFor(s, { home: "real", tokenFiles: [auth] }), "/bin/sh", []), /missing/);
    fs.renameSync(auth + ".saved", auth);
    assert.equal(fs.readFileSync(victim, "utf8"), "original\n", "the outside file was never written");
    const { profile } = seatbeltProfile(policy);
    assert.match(profile, /\(allow file-write-data\n {2}\(literal \(param "TOKEN_FILE_0"\)\)\)/, "data writes only: no unlink, rename, create or mode change");
  } finally {
    s.done();
  }
});
