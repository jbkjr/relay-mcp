import assert from "node:assert/strict";
import childProcess, { spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ConfinementRefused, prepareLaunch, type Confinement, type ConfinementPolicy } from "../dist/confine/index.js";
import { probeBoundary, startDecoySemaphores } from "../dist/confine/probe.js";
import { openProxy } from "../dist/confine/proxy.js";
import { dirIdentity, seatbelt, SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
// Also for its side effect: the test process gets a scratch HOME (see helpers.ts), so the real home
// comes from there (the user database), not from os.homedir().
import { REAL_HOME, scratchOnly, until } from "./helpers.ts";

const macOS = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
/** The installed Node which, like the real home, no probe in these tests may aim at (review r_faba9d17 C3). */
const NODE_DIR = path.dirname(fs.realpathSync(process.execPath));
const STUB_HARNESS = path.resolve(import.meta.dirname, "stubs", "confined-harness.mjs");

/**
 * prepareLaunch and probeBoundary, with the harness command checked first: a probe that escapes
 * writes beside the harness binary (write-harness-bin-dir), so it must be a scratch file, never an
 * installed program such as the Node running the tests.
 */
const launchProbed = (m: Confinement, policy: ConfinementPolicy, harness: string, args: string[]) => prepareLaunch(m, policy, scratchOnly(harness, "harness"), args);
const probeWrapped = (policy: ConfinementPolicy, harness: string) => probeBoundary(seatbelt.wrap(policy, scratchOnly(harness, "harness"), []), policy, { harness });

/** A run directory as relay lays it out: this turn's worktree and a sibling job's, a control dir, a private temp dir. */
function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-probe-test-")));
  const run = path.join(root, "worktrees", "r_1");
  const wt = path.join(run, "j_this");
  const sibling = path.join(run, "j_sibling");
  const control = path.join(root, "control");
  const tmp = path.join(root, "turn-tmp");
  for (const d of [wt, sibling, control, tmp]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  fs.writeFileSync(path.join(control, "relay.db"), "secret\n");
  // The probes must never touch the live control directory, the real home or an installed binary's
  // directory, even when they escape: a scratch control dir, home and harness.
  process.env.RELAY_HOME = control;
  const realHomeVar = process.env.HOME;
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  process.env.HOME = home;
  // The harness command: a scratch script that runs the tests' Node, so that a probe that escapes
  // writes beside it and not beside the real Node binary.
  const harness = path.join(root, "bin", "harness");
  fs.mkdirSync(path.dirname(harness));
  fs.writeFileSync(harness, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  return {
    root, wt, sibling, control, tmp, home, harness,
    done: () => {
      process.env.HOME = realHomeVar;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const policyFor = (s: ReturnType<typeof scratch>, extra: Partial<ConfinementPolicy> = {}): ConfinementPolicy => ({
  worktree: s.wt, worktreeWritable: true, tmpDir: s.tmp, denied: [s.control],
  network: { mode: "off-except-proxy", proxyPort: 9, proxyToken: "p".repeat(32) }, ...extra,
});

/** Every probe aimed at scratch or system targets: nothing under the real home or the installed Node. */
function assertTargets(report: { results: { name: string; target?: string }[] }) {
  for (const r of report.results) {
    if (!r.target) continue;
    assert.ok(!r.target.includes(REAL_HOME + "/") && !r.target.endsWith(REAL_HOME), `${r.name} aimed at the real home: ${r.target}`);
    assert.ok(!r.target.includes(NODE_DIR + "/"), `${r.name} aimed at the installed Node: ${r.target}`);
  }
}

/** No probe leaves anything behind, inside or out. */
function assertClean(s: ReturnType<typeof scratch>) {
  for (const d of [s.wt, s.sibling, path.dirname(s.wt), s.control, s.tmp]) {
    assert.deepEqual(fs.readdirSync(d).filter((n) => n.startsWith(".relay-probe-")), [], `nothing left in ${d}`);
  }
  assert.equal(fs.readFileSync(path.join(s.wt, ".git"), "utf8"), "gitdir: /nowhere\n");
}

test("DM8 config probes: protected files in a writable temp directory are probed without treating them as directories", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  const before = process.env.RELAY_CONFIG;
  const proxy = await openProxy({ allow: ["api.vendor.test"] });
  try {
    const file = path.join(s.tmp, "config.json");
    const contents = '{"max_depth":3}\n';
    fs.writeFileSync(file, contents);
    fs.writeFileSync(path.join(s.tmp, "unrelated"), "broad directory\n");
    const link = path.join(s.tmp, "config-link.json"); fs.symlinkSync(file, link);
    process.env.RELAY_CONFIG = link;
    const { probes } = await launchProbed(seatbelt, policyFor(s, { network: proxy.network }), s.harness, [STUB_HARNESS, "{}"]);
    assert.ok(probes.ok);
    for (const p of [file, link]) {
      const tested = probes.results.filter((r) => r.target === p);
      assert.equal(tested.length, 3, p);
      assert.ok(tested.every((r) => r.got === "EPERM"), JSON.stringify(tested));
    }
    assert.equal(fs.readFileSync(file, "utf8"), contents);
  } finally {
    if (before === undefined) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = before;
    await proxy.close(); s.done();
  }
});

test("probes: a write turn under the real profile passes every probe, fast, and leaves nothing behind", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  const proxy = await openProxy({ allow: ["api.vendor.test"] });
  try {
    const policy = policyFor(s, { network: proxy.network, worktreePin: dirIdentity(s.wt) });
    const times: number[] = [];
    let report;
    for (let i = 0; i < 5; i++) {
      ({ probes: report } = await launchProbed(seatbelt, policy, s.harness, [STUB_HARNESS, "{}"]));
      times.push(report.ms);
    }
    assert.ok(report!.ok, JSON.stringify(report!.results.filter((r) => !r.ok)));
    assertTargets(report!);
    // The person's own paths (home, login store, harness binary) are not live-probed; a relay-owned
    // decoy outside the writable roots stands in (write-decoy-outside), and generator tests cover the rules.
    assert.equal(by_(report!)["write-decoy-outside"].got, "EPERM");
    const by = Object.fromEntries(report!.results.map((r) => [r.name, r]));
    for (const name of ["write-worktree", "write-tmpdir", "read-worktree", "proxy-port", "exec-system"]) assert.equal(by[name].got, "allowed", name);
    assert.equal(by["exec-outside-list"].got, "EPERM");
    // Whether a name exists in relay's control directory: refused too, not only reading it (seatbelt.ts, rule precedence).
    assert.equal(by["exists-control-dir"].got, "EPERM");
    assert.equal(by["exists-control-dir"].target, path.join(s.control, "relay.db"));
    for (const name of ["write-outside", "write-decoy-outside", "write-beside-worktree", "write-sibling-worktree", "write-git-pointer", "read-control-dir", "write-control-dir",
      "hardlink-to-outside", "symlink-escape", "tcp-loopback", "tcp-direct", "unix-socket", "listen-loopback", "listen-any", "foreign-pty-read", "foreign-pty-write",
      "fcntl-makecompressed", "fcntl-transferextents"]) {
      assert.equal(by[name].got, "EPERM", `${name}: ${by[name].got}`);
    }
    assert.equal(by["dns-resolver-socket"].got, "EPERM");
    assert.equal(by["dns-udp"].got, "EPERM");
    assert.match(by["dns-lookup"].got, /^E[A-Z]+$/);
    assert.match(by["open-app"].got, /kLS|LSOpen|-10\d{3}|cannot be opened/);
    assert.equal(by["signal-outside"].got, "EPERM");
    assert.match(by["apple-events"].got, /^exit [1-9]\d*: .*execution error/);
    assert.match(by["launchctl-submit"].got, /^exit [1-9]/);
    assert.match(by["open-app"].got, /^exit [1-9]/);
    assertClean(s);
    const sorted = [...times].sort((a, b) => a - b);
    console.log(`boundary probes: ${times.join(", ")} ms (median ${sorted[2]} ms)`);
    assert.ok(sorted[2] < 1000, `median ${sorted[2]} ms`);
  } finally {
    await proxy.close();
    s.done();
  }
});

test("probes: a read turn must not write its worktree; with the network on, DNS and direct connects are not probed but loopback still is", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const read = await probeWrapped(policyFor(s, { worktreeWritable: false }), s.harness);
    assert.ok(read.ok, JSON.stringify(read.results.filter((r) => !r.ok)));
    // A read turn in the person's own checkout (no pin): the worktree write is not live-probed, a
    // generator test covers that it is unwritable (review C6/X4).
    const w = read.results.find((r) => r.name === "write-worktree")!;
    assert.match(w.got, /^skipped: .*person's own checkout/, JSON.stringify(w));
    // A read turn on a worktree relay created is still probed live (relay owns it).
    const ownRead = await probeWrapped(policyFor(s, { worktreeWritable: false, worktreePin: dirIdentity(s.wt) }), s.harness);
    assert.equal(ownRead.results.find((r) => r.name === "write-worktree")!.got, "EPERM");
    assertTargets(read);

    const on = policyFor(s, { network: { mode: "on" }, bridgeSocket: path.join(s.root, "absent.sock") });
    const r = await probeWrapped(on, s.harness);
    assertTargets(r);
    const by = Object.fromEntries(r.results.map((x) => [x.name, x]));
    assert.match(by["dns-lookup"].got, /^skipped/);
    assert.match(by["dns-udp"].got, /^skipped/);
    assert.match(by["tcp-direct"].got, /^skipped/);
    assert.equal(by["tcp-loopback"].got, "EPERM", "loopback stays closed with the network on");
    // Loopback by its other names (core audit: 127.0.0.2 was not probed): lo0's link-local address in
    // both modes, 127.0.0.2 with the network off (with it on, only configured aliases are reachable).
    assert.equal(by["tcp-loopback-link-local"].got, "EPERM");
    assert.match(by["tcp-loopback-127-0-0-2"].got, /^skipped: with the network on/);
    const offBy = Object.fromEntries(read.results.map((x) => [x.name, x]));
    assert.equal(offBy["tcp-loopback-127-0-0-2"].got, "EPERM", "any 127/8 address is refused with the network off");
    assert.equal(offBy["tcp-loopback-link-local"].got, "EPERM");
    const { loopbackAliases } = await import("../dist/confine/probe.js");
    const lo = (...addresses: string[]) => ({ lo0: addresses.map((address) => ({ address, family: address.includes(":") ? "IPv6" : "IPv4" })) }) as never;
    assert.deepEqual(loopbackAliases(lo("127.0.0.1", "::1", "fe80::1%lo0")), [], "macOS's defaults are covered by the profile's loopback rule");
    assert.deepEqual(loopbackAliases(lo("127.0.0.1", "127.0.0.2", "::1", "fe80::1%lo0", "10.200.0.1")), ["127.0.0.2", "10.200.0.1"], "an alias someone added is probed");
    // Every other address of this Mac's own, in both modes, IPv4-mapped and -compatible spellings
    // included (review R1: ::ffff:0.0.0.0 and ::ffff:<LAN address> got past the network-on rule).
    const { localAddressSpellings } = await import("../dist/confine/probe.js");
    const v4 = Object.values(os.networkInterfaces()).flat().filter((a) => a?.family === "IPv4").map((a) => a!.address);
    for (const [mode, results] of [["on", r.results], ["off", read.results]] as const) {
      const local = results.filter((x) => x.name.startsWith("tcp-local@"));
      for (const host of ["0.0.0.0", "::", "::ffff:0.0.0.0", "0:0:0:0:0:ffff:0:0", "::ffff:127.0.0.1", "::127.0.0.1", ...v4.filter((a) => a !== "127.0.0.1"), ...v4.flatMap((a) => [`::ffff:${a}`, `::${a}`])]) {
        assert.ok(local.some((x) => x.name === `tcp-local@${host}`), `${mode}: ${host} is probed`);
      }
      for (const x of local) assert.equal(x.got, "EPERM", `${mode} ${x.name}`);
    }
    const ifs = { lo0: [{ address: "127.0.0.1", family: "IPv4" }, { address: "::1", family: "IPv6" }, { address: "fe80::1%lo0", family: "IPv6" }],
      en0: [{ address: "192.168.1.5", family: "IPv4" }, { address: "fe80::aa%en0", family: "IPv6" }, { address: "fd00::5", family: "IPv6" }] } as never;
    assert.deepEqual(localAddressSpellings(ifs), ["127.0.0.1", "::1", "0.0.0.0", "::", "fe80::1%lo0", "192.168.1.5", "fe80::aa%en0", "fd00::5",
      "::ffff:127.0.0.1", "::127.0.0.1", "::ffff:0.0.0.0", "0:0:0:0:0:ffff:0:0", "::ffff:192.168.1.5", "::192.168.1.5"]);
    assert.equal(by["unix-socket"].got, "EPERM");
    // The bridge is the positive control for sockets: here nothing listens on it, which is not the sandbox refusing.
    assert.equal(by["bridge-socket"].got, "ENOENT");
    assert.equal(by["bridge-socket"].ok, false, "a bridge the harness could not reach fails the turn");
    assertClean(s);
  } finally {
    s.done();
  }
});

test("probes: an escape refuses the launch, naming the probe", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  const harness = s.harness;
  try {
    /** Seatbelt with one rule added at the end, where it wins: what a profile bug would look like. */
    const weakened = (rule: string): Confinement => ({
      ...seatbelt,
      wrap(policy, command, args) {
        const l = seatbelt.wrap(policy, command, args);
        const fix = (a: string[]) => a.map((x, i) => (i === 1 && a[0] === "-p" ? `${x}${rule}\n` : x));
        return { ...l, args: fix(l.args), rewrap: (c, a) => ({ ...l.rewrap(c, a), args: fix(l.rewrap(c, a).args) }) };
      },
    });
    await assert.rejects(launchProbed(weakened("(allow file-write*)"), policyFor(s, { worktreePin: dirIdentity(s.wt) }), harness, []), (err: ConfinementRefused) => {
      assert.ok(err instanceof ConfinementRefused);
      assert.equal(err.check, "write-outside");
      assert.match(err.message, /boundary probe write-outside escaped/);
      const escaped = err.report!.results.filter((r) => r.expect === "deny" && r.got === "allowed").map((r) => r.name).sort();
      // (An unfiltered allow does not override the filtered hard denies, so the control dir and .git hold
      // here; and a hard link may not give its new name more rights than the old one has, which the
      // temp dir's exec permission would, so that holds too. The person's home, login store and harness
      // binary are no longer live-probed, so the decoy outside the roots stands in their place.)
      assert.deepEqual(escaped, ["symlink-escape", "write-beside-worktree", "write-decoy-outside", "write-outside", "write-sibling-worktree"]);
      return true;
    });
    assertClean(s);

    await assert.rejects(launchProbed(weakened("(allow network-outbound)"), policyFor(s), s.harness, []), (err: ConfinementRefused) => {
      assert.ok(["tcp-loopback", "unix-socket"].includes(err.check), err.check);
      return true;
    });
    // Signals to processes outside the sandbox (review r_faba9d17 C10).
    await assert.rejects(launchProbed(weakened("(allow signal)"), policyFor(s), harness, []), (err: ConfinementRefused) => {
      assert.equal(err.check, "signal-outside");
      return true;
    });
    // The control directory opened to reads (and existence tests, which a file-read* rule alone would
    // not reopen, the deny naming them: seatbelt.ts, rule precedence).
    await assert.rejects(launchProbed(weakened("(allow file-read* file-test-existence (subpath (param \"DENIED_0\")))"), policyFor(s), s.harness, []), (err: ConfinementRefused) => {
      assert.equal(err.check, "read-control-dir");
      return true;
    });
    await assert.rejects(launchProbed(weakened("(allow file-test-existence (subpath (param \"DENIED_0\")))"), policyFor(s), s.harness, []), (err: ConfinementRefused) => {
      assert.equal(err.check, "exists-control-dir");
      return true;
    });
    // A positive control failing is a refusal too: a temp dir the harness cannot write.
    await assert.rejects(launchProbed(weakened("(deny file-write* (subpath (param \"WRITABLE_1\")))"), policyFor(s), s.harness, []), (err: ConfinementRefused) => {
      assert.equal(err.check, "write-tmpdir");
      assert.match(err.message, /was refused \(EPERM\); expected allow/);
      return true;
    });
    // A canary that cannot run at all.
    const broken: Confinement = { ...seatbelt, wrap: (p, c, a) => ({ ...seatbelt.wrap(p, c, a), rewrap: () => ({ command: "/usr/bin/false", args: [] }) }) };
    await assert.rejects(launchProbed(broken, policyFor(s), s.harness, []), (err: ConfinementRefused) => err.check === "canary");
    assertClean(s);
  } finally {
    s.done();
  }
});

test("probes: a temp dir that would contain the outside target is refused before anything runs", async () => {
  const s = scratch();
  const before = process.env.TMPDIR;
  try {
    // Use an owned synthetic system temp directory: the real /tmp is refused
    // earlier by the writable-root ownership check on a normal macOS host.
    process.env.TMPDIR = s.tmp;
    const policy = policyFor(s, { tmpDir: os.tmpdir() });
    let ran = false;
    const spy: Confinement = { ...seatbelt, wrap: (p, c, a) => ({ command: c, args: a, env: {}, rewrap: () => ((ran = true), { command: "/usr/bin/true", args: [] }) }) };
    await assert.rejects(launchProbed(spy, policy, s.harness, []), (err: ConfinementRefused) => err.check === "outside-target");
    assert.equal(ran, false);
  } finally {
    if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    s.done();
  }
});

test("probes: in a real git worktree, the worktree's git directory and the repository's shared one are probed unwritable, even under a grant of the repository", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const repo = path.join(s.root, "repo");
    const wt = path.join(s.root, "worktrees", "r_2", "j_git");
    fs.mkdirSync(repo);
    const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    assert.equal(git("worktree", "add", "-q", "-b", "relay/j_git", wt).status, 0);
    const policy = policyFor(s, { worktree: wt, writable: [repo], network: { mode: "on" }, worktreePin: dirIdentity(wt) });
    const r = await probeWrapped(policy, s.harness);
    assertTargets(r);
    const by = Object.fromEntries(r.results.map((x) => [x.name, x.got]));
    assert.equal(by["write-git-dir"], "EPERM");
    assert.equal(by["write-git-common-dir"], "EPERM");
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
    assert.deepEqual(fs.readdirSync(path.join(repo, ".git")).filter((n) => n.startsWith(".relay-probe-")), []);
  } finally {
    s.done();
  }
});

test("probes: only positive evidence of denial passes; timeouts, other failures, missing results and failed discovery refuse (review r_faba9d17 C4)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    // A canary whose real results are overridden: what an inconclusive environment would report.
    const wrapper = path.join(s.root, "override-canary.mjs");
    fs.writeFileSync(wrapper, `
      import { spawnSync } from "node:child_process";
      const [overrides, canary, plan] = process.argv.slice(2);
      const got = JSON.parse(spawnSync(process.execPath, [canary, plan], { encoding: "utf8" }).stdout);
      for (const [k, v] of Object.entries(JSON.parse(overrides))) if (v === null) delete got[k]; else got[k] = v;
      console.log(JSON.stringify(got));
    `);
    const overriding = (overrides: Record<string, string | null>): Confinement => ({
      ...seatbelt,
      wrap(policy, command, args) {
        const l = seatbelt.wrap(policy, command, args);
        return { ...l, rewrap: (c, a) => l.rewrap(c, [wrapper, JSON.stringify(overrides), ...a]) };
      },
    });
    const policy = policyFor(s, { worktreePin: dirIdentity(s.wt) });
    // The wrapper itself changes nothing: the real results pass.
    await launchProbed(overriding({}), policy, s.harness, []);
    for (const [name, value] of [
      ["dns-lookup", "timeout"], ["dns-udp", "ENETUNREACH"], ["dns-resolver-socket", "ENOENT"], ["tcp-direct", "timeout"],
      ["open-app", "exit 1: some other failure"], ["launchctl-submit", "timeout"], ["write-outside", "ENOENT"], ["write-outside", null], ["unix-socket", "ECONNREFUSED"],
    ] as const) {
      await assert.rejects(launchProbed(overriding({ [name]: value }), policy, s.harness, []), (err: ConfinementRefused) => {
        assert.equal(err.check, name, `${name}=${value}: ${err.message}`);
        return true;
      });
    }
    // An escape outranks an earlier inconclusive probe: the refusal names what got out, not what stalled.
    await assert.rejects(launchProbed(overriding({ "write-outside": "timeout", "tcp-loopback": "allowed" }), policy, s.harness, []), (err: ConfinementRefused) => {
      assert.equal(err.check, "tcp-loopback", err.message);
      assert.match(err.message, /boundary probe tcp-loopback escaped/);
      assert.equal(err.report!.results.find((r) => r.name === "write-outside")!.got, "timeout", "the stalled probe stays in the report");
      return true;
    });
    // Discovery that fails (the worktree's parent cannot be listed) refuses; it is not taken for absence.
    const beside = path.dirname(s.wt);
    fs.chmodSync(beside, 0o300);
    try {
      await assert.rejects(launchProbed(seatbelt, policy, s.harness, []), (err: ConfinementRefused) => err.check === "probe-setup" && /EACCES/.test(err.message));
    } finally {
      fs.chmodSync(beside, 0o755);
    }
    assertClean(s);
  } finally {
    s.done();
  }
});

test("canary: a step still running at the canary's deadline is reported as a timeout, and the steps that settled are still reported", () => {
  // A stalled step (here a command with a long limit of its own) used to hold the whole run until
  // relay's 30 s limit, which refused the launch as "canary" with no results: an escape elsewhere
  // went unnamed (GitHub's macOS runners, 2026-11-21).
  const canary = path.resolve(import.meta.dirname, "..", "dist", "confine", "canary.js");
  const plan = {
    stalled: { kind: "exec", command: "/bin/sleep", args: ["5"], timeoutMs: 60_000 },
    settled: { kind: "exists", path: os.tmpdir() },
  };
  const started = Date.now();
  const r = spawnSync(process.execPath, [canary, JSON.stringify(plan), "500"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 4000, `the deadline ends the run (${Date.now() - started} ms)`);
  assert.deepEqual(JSON.parse(r.stdout), { stalled: "timeout", settled: "allowed" });
  // Without a deadline, as before, the run waits for every step.
  const quick = { settled: plan.settled };
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, [canary, JSON.stringify(quick)], { encoding: "utf8", timeout: 15_000 }).stdout), { settled: "allowed" });
});

const by_ = (r: { results: { name: string; target?: string }[] }) => Object.fromEntries(r.results.map((x) => [x.name, x]));

test("probes: the report is bound to the exact profile and parameters, relay's version and the OS build (review r_faba9d17 C12)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const policy = policyFor(s, { network: { mode: "on" } });
    const launch = seatbelt.wrap(policy, s.harness, []);
    const r = await probeBoundary(launch, policy, { harness: s.harness });
    assert.match(r.profile, /^[0-9a-f]{64}$/);
    assert.equal(r.profile, launch.fingerprint, "the hash of the profile text and every -D parameter");
    const other = seatbelt.wrap({ ...policy, writable: [s.home] }, s.harness, []);
    assert.notEqual(other.fingerprint, launch.fingerprint, "another parameter, another hash");
    assert.equal(r.relay, JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8")).version);
    assert.equal(r.os, `${os.release()} (${spawnSync("/usr/sbin/sysctl", ["-n", "kern.osversion"], { encoding: "utf8" }).stdout.trim()})`);
  } finally {
    s.done();
  }
});

test("probes: a read turn in a checkout whose .git is a directory probes a new file in it (found when the probes were wired into ACP launches)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    fs.rmSync(path.join(s.wt, ".git"));
    fs.mkdirSync(path.join(s.wt, ".git"));
    const policy = policyFor(s, { worktreeWritable: false, network: { mode: "on" } });
    const r = await probeWrapped(policy, s.harness);
    const p = r.results.find((x) => x.name === "write-git-pointer")!;
    // A read turn's checkout is the person's own, so neither its .git nor the worktree write is
    // live-probed; the git deny rules and the read-turn worktree are generator-tested (review C6/X4).
    assert.match(p.got, /^skipped: .*person's own checkout/, JSON.stringify(p));
    assert.match(r.results.find((x) => x.name === "write-worktree")!.got, /^skipped: .*person's own checkout/);
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
    assert.deepEqual(fs.readdirSync(path.join(s.wt, ".git")), [], "nothing left in it");
  } finally {
    s.done();
  }
});

test("probes: moving relay's own roots or a protected path's ancestor inside them, and IPv6 loopback and direct connects, are probed; the person's granted directories are never renamed (review r_11c43840 C1, C2)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  const proxy = await openProxy({ allow: ["api.vendor.test"] });
  try {
    const { dirIdentity } = await import("../dist/confine/seatbelt.js");
    // A grant (the person's own directory) holding a denied directory, a denied directory inside the
    // turn's temp dir, a state directory there, and relay-owned persistent state.
    const grant = path.join(s.root, "grant");
    const grantSecret = path.join(grant, "a", "secret");
    const tmpSecret = path.join(s.tmp, "b", "secret");
    const stateDir = path.join(s.tmp, "state");
    const harnessHome = path.join(s.root, "harness");
    for (const d of [grantSecret, tmpSecret, stateDir, harnessHome]) fs.mkdirSync(d, { recursive: true });
    fs.chmodSync(harnessHome, 0o700);
    fs.writeFileSync(path.join(grant, "keep.txt"), "keep\n");
    const grantIno = [grant, path.join(grant, "a")].map((d) => fs.statSync(d).ino);
    const policy = policyFor(s, {
      worktreePin: dirIdentity(s.wt), writable: [grant], stateDirs: [stateDir], denied: [s.control, grantSecret, tmpSecret], network: proxy.network,
      state: { home: "temp", persistent: { root: harnessHome, writable: ["session-state"] } },
    });
    const { probes: r } = await launchProbed(seatbelt, policy, s.harness, []);
    assertTargets(r);
    const by = by_(r) as Record<string, { got: string; target?: string }>;
    for (const name of ["rename-worktree-root", "rename-tmpdir-root", "rename-state-root-0", "rename-state-root-1", "move-protected-ancestor-0", "tcp-loopback-v6", "tcp-direct-v6"]) {
      assert.ok(by[name], `${name} is probed: ${Object.keys(by).join(", ")}`);
      assert.equal(by[name].got, "EPERM", `${name}: ${JSON.stringify(by[name])}`);
    }
    assert.deepEqual([by["rename-state-root-0"], by["rename-state-root-1"]].map((x) => x.target!.split(" -> ")[0]).sort(), [stateDir, path.join(harnessHome, "session-state")].sort());
    assert.equal(by["move-protected-ancestor-0"].target!.split(" -> ")[0], path.join(s.tmp, "b"));
    // Nothing under the grant is the source or the destination of a rename, and it is untouched.
    for (const x of r.results.filter((x) => x.target?.includes(" -> "))) {
      for (const end of x.target!.split(" -> ")) assert.ok(!(end === grant || end.startsWith(`${grant}/`)), `${x.name} aimed at the grant: ${x.target}`);
    }
    assert.ok(!Object.keys(by).some((n) => n.startsWith("rename-writable-root")), "no rename probe for granted directories");
    assert.deepEqual([grant, path.join(grant, "a")].map((d) => fs.statSync(d).ino), grantIno);
    assert.equal(fs.readFileSync(path.join(grant, "keep.txt"), "utf8"), "keep\n");
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
    assertClean(s);
    // A worktree relay did not pin (not one it created) is not renamed either; with the network on, loopback over IPv6 is still probed.
    const on = policyFor(s, { network: { mode: "on" } });
    const r2 = await probeWrapped(on, s.harness);
    assert.match(by_(r2)["rename-worktree-root"].got!, /^skipped/);
    assert.equal(by_(r2)["tcp-loopback-v6"].target!.startsWith("::1:"), true);
    assert.equal((by_(r2)["tcp-loopback-v6"] as { got?: string }).got, "EPERM");
    assert.ok(r2.ok, JSON.stringify(r2.results.filter((x) => !x.ok)));
  } finally {
    await proxy.close();
    s.done();
  }
});

test("probes: a profile that lets the worktree be renamed is refused, and the worktree is put back (review r_11c43840 C1)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const weakened = (rule: string): Confinement => ({
      ...seatbelt,
      wrap(policy, command, args) {
        const l = seatbelt.wrap(policy, command, args);
        const fix = (a: string[]) => a.map((x, i) => (i === 1 && a[0] === "-p" ? `${x}${rule}\n` : x));
        return { ...l, args: fix(l.args), rewrap: (c, a) => ({ ...l.rewrap(c, a), args: fix(l.rewrap(c, a).args) }) };
      },
    });
    fs.writeFileSync(path.join(s.wt, "keep.txt"), "keep\n");
    const ino = fs.statSync(s.wt).ino;
    const { dirIdentity } = await import("../dist/confine/seatbelt.js");
    await assert.rejects(launchProbed(weakened('(allow file-write-unlink file-write-create (literal (param "WRITABLE_0")))'), policyFor(s, { worktreePin: dirIdentity(s.wt) }), s.harness, []), (err: ConfinementRefused) => {
      assert.equal(err.check, "rename-worktree-root", err.message);
      return true;
    });
    assert.equal(fs.statSync(s.wt).ino, ino, "the worktree is back where it was");
    assert.equal(fs.readFileSync(path.join(s.wt, "keep.txt"), "utf8"), "keep\n");
    assert.deepEqual(fs.readdirSync(s.tmp).filter((n) => n.startsWith(".relay-probe-")), []);
    assertClean(s);
  } finally {
    s.done();
  }
});

test("probes: launched from a repository subdirectory, the git directories above it are probed (review r_11c43840, Codex finding 2)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const repo = path.join(s.root, "repo");
    const wt = path.join(s.root, "worktrees", "r_3", "j_sub");
    fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
    const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "sub", "a.txt"), "a\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    assert.equal(git("worktree", "add", "-q", "-b", "relay/j_sub", wt).status, 0);
    const sub = path.join(wt, "sub");
    const policy = policyFor(s, { worktree: sub, writable: [repo], network: { mode: "on" }, worktreePin: dirIdentity(wt) });
    const r = await probeWrapped(policy, s.harness);
    const by = by_(r) as Record<string, { got: string; target?: string }>;
    assert.equal(by["write-git-common-dir"]?.got, "EPERM", JSON.stringify(by["write-git-common-dir"]));
    assert.equal(path.dirname(by["write-git-common-dir"].target!), path.join(repo, ".git"));
    assert.equal(by["write-git-dir"]?.got, "EPERM");
    assert.equal(by["write-git-pointer"].target, path.join(wt, ".git"));
    assert.equal(by["write-nested-git-pointer-0"]?.got, "EPERM", JSON.stringify(by["write-nested-git-pointer-0"]));
    assert.equal(by["write-nested-git-pointer-0"].target, path.join(sub, ".git"));
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
    assert.ok(!fs.existsSync(path.join(sub, ".git")));
    assert.deepEqual(fs.readdirSync(path.join(repo, ".git")).filter((n) => n.startsWith(".relay-probe-")), []);
  } finally {
    s.done();
  }
});

test("probes: EACCES and an Apple-event refusal by privacy controls are not the sandbox's evidence (review r_11c43840 C3)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const wrapper = path.join(s.root, "override-canary.mjs");
    fs.writeFileSync(wrapper, `
      import { spawnSync } from "node:child_process";
      const [overrides, canary, plan] = process.argv.slice(2);
      const got = JSON.parse(spawnSync(process.execPath, [canary, plan], { encoding: "utf8" }).stdout);
      for (const [k, v] of Object.entries(JSON.parse(overrides))) got[k] = v;
      console.log(JSON.stringify(got));
    `);
    const overriding = (overrides: Record<string, string>): Confinement => ({
      ...seatbelt,
      wrap(policy, command, args) {
        const l = seatbelt.wrap(policy, command, args);
        return { ...l, rewrap: (c, a) => l.rewrap(c, [wrapper, JSON.stringify(overrides), ...a]) };
      },
    });
    const policy = policyFor(s, { network: { mode: "on" } });
    await launchProbed(overriding({}), policy, s.harness, []);
    for (const [name, value] of [
      ["write-outside", "EACCES"],
      ["apple-events", "exit 1: 0:44: execution error: Not authorized to send Apple events to Finder. (-1743)"],
      ["apple-events", "exit 1: 0:44: execution error: Finder got an error: some other failure. (-10000)"],
    ] as const) {
      await assert.rejects(launchProbed(overriding({ [name]: value }), policy, s.harness, []), (err: ConfinementRefused) => {
        assert.equal(err.check, name, `${name}=${value}: ${err.message}`);
        return true;
      });
    }
  } finally {
    s.done();
  }
});

test("probes: the fingerprint covers the environment relay sets for the launch (review r_11c43840 N2)", async () => {
  const s = scratch();
  try {
    const a = seatbelt.wrap(policyFor(s, { network: { mode: "off-except-proxy", proxyPort: 9, proxyToken: "p".repeat(32) } }), s.harness, []);
    const b = seatbelt.wrap(policyFor(s, { network: { mode: "off-except-proxy", proxyPort: 9, proxyToken: "q".repeat(32) } }), s.harness, []);
    assert.deepEqual(a.args, b.args, "the same profile and parameters");
    assert.notEqual(a.fingerprint, b.fingerprint, "another proxy token in the environment, another fingerprint");
  } finally {
    s.done();
  }
});

test("probes: the IPv6 probes refuse the launch unless they show the sandbox refusing (review r_11c43840 C2)", { skip: !macOS && "macOS only" }, async () => {
  // Seatbelt's ip6 filter cannot open IPv6 alone (it matches IPv4 loopback too), so these results are overridden.
  const s = scratch();
  const proxy = await openProxy({ allow: ["api.vendor.test"] });
  try {
    const wrapper = path.join(s.root, "override-canary.mjs");
    fs.writeFileSync(wrapper, `
      import { spawnSync } from "node:child_process";
      const [overrides, canary, plan] = process.argv.slice(2);
      const got = JSON.parse(spawnSync(process.execPath, [canary, plan], { encoding: "utf8" }).stdout);
      for (const [k, v] of Object.entries(JSON.parse(overrides))) got[k] = v;
      console.log(JSON.stringify(got));
    `);
    const overriding = (overrides: Record<string, string>): Confinement => ({
      ...seatbelt,
      wrap(policy, command, args) {
        const l = seatbelt.wrap(policy, command, args);
        return { ...l, rewrap: (c, a) => l.rewrap(c, [wrapper, JSON.stringify(overrides), ...a]) };
      },
    });
    const policy = policyFor(s, { network: proxy.network });
    await launchProbed(overriding({}), policy, s.harness, []);
    for (const [name, value] of [["tcp-loopback-v6", "allowed"], ["tcp-loopback-v6", "ECONNREFUSED"], ["tcp-direct-v6", "allowed"], ["tcp-direct-v6", "EHOSTUNREACH"], ["tcp-direct-v6", "timeout"],
      // The IPv4-mapped spellings that got past the network-on rule through 1.0.5 (review R1).
      ["tcp-local@::ffff:0.0.0.0", "allowed"], ["tcp-local@0:0:0:0:0:ffff:0:0", "ECONNREFUSED"]] as const) {
      await assert.rejects(launchProbed(overriding({ [name]: value }), policy, s.harness, []), (err: ConfinementRefused) => {
        assert.equal(err.check, name, `${name}=${value}: ${err.message}`);
        return true;
      });
    }
  } finally {
    await proxy.close();
    s.done();
  }
});

test("probes: the 1.0.5 network-on rule, which IPv4-mapped spellings got past, refuses the launch (review R1)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    // The profile with 1.0.5's two network-on rules in place of the IPv4-only ones.
    const old: Confinement = {
      ...seatbelt,
      wrap(policy, command, args) {
        const l = seatbelt.wrap(policy, command, args);
        const fix = (a: string[]) => a.map((x, i) => (i === 1 && a[0] === "-p" ? x.replace('(allow network-outbound (remote ip4 "*:*"))', '(allow network-outbound (remote ip "*:*"))').replace('(remote ip4 "localhost:*")', '(remote ip "localhost:*")') : x));
        return { ...l, args: fix(l.args), rewrap: (c, a) => ({ ...l.rewrap(c, a), args: fix(l.rewrap(c, a).args) }) };
      },
    };
    const on = policyFor(s, { network: { mode: "on" } });
    assert.match(old.wrap(on, s.harness, []).args[1], /\(allow network-outbound \(remote ip "\*:\*"\)\)\n\(deny network-outbound \(remote ip "localhost:\*"\)/, "the 1.0.5 rules are in place");
    await assert.rejects(launchProbed(old, on, s.harness, []), (err: ConfinementRefused) => {
      assert.match(err.check, /^tcp-local@(::ffff:|0:0:0:0:0:ffff:)/, err.message);
      const got = by_(err.report!) as Record<string, { got: string }>;
      assert.notEqual(got["tcp-local@::ffff:0.0.0.0"].got, "EPERM", "::ffff:0.0.0.0 got past the 1.0.5 rule");
      assert.equal(got["tcp-loopback"].got, "EPERM", "127.0.0.1 did not");
      return true;
    });
    assertClean(s);
  } finally {
    s.done();
  }
});

/** Seatbelt with rules added at the end of the profile, where they win: what a profile bug would look like. */
const weakenedBy = (rule: string): Confinement => ({
  ...seatbelt,
  wrap(policy, command, args) {
    const l = seatbelt.wrap(policy, command, args);
    const fix = (a: string[]) => a.map((x, i) => (i === 1 && a[0] === "-p" ? `${x}${rule}\n` : x));
    return { ...l, args: fix(l.args), rewrap: (c, a) => ({ ...l.rewrap(c, a), args: fix(l.rewrap(c, a).args) }) };
  },
});

test("probes: fcntl commands that change a file through a read-only descriptor are refused on relay's decoy; a profile that allows them refuses the launch (hardening 1)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const policy = policyFor(s, { network: { mode: "on" } });
    const r = await probeWrapped(policy, s.harness);
    const by = by_(r) as Record<string, { got: string; target?: string }>;
    for (const name of ["fcntl-makecompressed", "fcntl-transferextents"]) {
      assert.equal(by[name]?.got, "EPERM", `${name}: ${JSON.stringify(by[name])}`);
      assert.match(by[name].target!, /fcntl-decoy$/, "aimed at relay's own decoy");
    }
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
    // Positive control: with the commands allowed, the same calls reach the file system (another
    // error, or success on the decoy), so the probe refuses the launch.
    await assert.rejects(launchProbed(weakenedBy("(allow system-fcntl (fcntl-command 80 110))"), policy, s.harness, []), (err: ConfinementRefused) => {
      assert.equal(err.check, "fcntl-makecompressed", err.message);
      const got = by_(err.report!) as Record<string, { got: string }>;
      assert.notEqual(got["fcntl-makecompressed"].got, "EPERM");
      assert.notEqual(got["fcntl-transferextents"].got, "EPERM");
      return true;
    });
    assertClean(s);
  } finally {
    s.done();
  }
});

test("probes: processes outside the sandbox cannot be inspected or listed, their command line and environment included; the turn's own process can (hardening 2)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const policy = policyFor(s, { network: { mode: "on" } });
    const r = await probeWrapped(policy, s.harness);
    const by = by_(r) as Record<string, { got: string; target?: string }>;
    for (const name of ["proc-pidpath-outside", "proc-pidinfo-outside", "proc-listpids", "sysctl-proc-all", "sysctl-proc-pid-outside", "sysctl-procargs-outside"]) {
      assert.equal(by[name]?.got, "EPERM", `${name}: ${JSON.stringify(by[name])}`);
    }
    assert.equal(by["proc-pidpath-self"].got, "allowed", "positive control: the turn's own process");
    assert.equal(by["sysctl-read-hw"].got, "allowed", "positive control: a hardware sysctl");
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
    // A profile that lets process information through, or kern.* sysctls by prefix, is refused.
    for (const [rule, check] of [["(allow process-info*)", "proc-pidpath-outside"], ['(allow sysctl-read (sysctl-name-prefix "kern."))', "sysctl-proc-all"]] as const) {
      await assert.rejects(launchProbed(weakenedBy(rule), policy, s.harness, []), (err: ConfinementRefused) => {
        assert.equal(err.check, check, `${rule}: ${err.message}`);
        return true;
      });
    }
    assertClean(s);
  } finally {
    s.done();
  }
});

test("probes: Unix sockets of the turn's own under its temp dir only; no other turn's broker, not even listed; no routing sockets; the system log's socket is reached without writing to it (hardening 3)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  const proxy = await openProxy({ allow: ["api.vendor.test"] });
  try {
    for (const network of [{ mode: "on" as const }, proxy.network]) {
      const policy = policyFor(s, { network });
      const r = await probeWrapped(policy, s.harness);
      const by = by_(r) as Record<string, { got: string; target?: string }>;
      assert.equal(by["unix-listen-tmpdir"].got, "allowed", `${network.mode}: positive control`);
      for (const name of ["unix-listen-worktree", "relay-socket-other-turn", "read-relay-sockets", "socket-route"]) {
        assert.equal(by[name]?.got, "EPERM", `${network.mode} ${name}: ${JSON.stringify(by[name])}`);
      }
      assert.equal(by["syslog-socket"].got, "allowed");
      assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
      assertClean(s);
    }
    // A profile that let the worktree hold sockets, or opened every socket domain, is refused.
    const on = policyFor(s, { network: { mode: "on" } });
    for (const [rule, check] of [['(allow network-bind (local unix-socket (subpath (param "WRITABLE_0"))))', "unix-listen-worktree"], ["(allow system-socket)", "socket-route"]] as const) {
      await assert.rejects(launchProbed(weakenedBy(rule), on, s.harness, []), (err: ConfinementRefused) => {
        assert.equal(err.check, check, `${rule}: ${err.message}`);
        return true;
      });
    }
  } finally {
    await proxy.close();
    s.done();
  }
});

test("probes: Mach services outside the list are refused by the sandbox, not just absent; the certificate trust daemons only as a stated downgrade (hardening 4)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const policy = policyFor(s, { network: { mode: "on" } });
    const r = await probeWrapped(policy, s.harness);
    const by = by_(r) as Record<string, { got: string; target?: string }>;
    assert.equal(by["mach-allowed"].got, "allowed", "positive control");
    for (const name of ["mach-pasteboard", "mach-unlisted", "mach-trustd"]) assert.equal(by[name]?.got, "kr 44c", `${name}: ${JSON.stringify(by[name])}`);
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
    // With the downgrade the trust daemon must answer: a real positive control that it is granted (review X6).
    const trusted = await probeWrapped({ ...policy, certificateTrust: true }, s.harness);
    assert.equal(by_(trusted)["mach-trustd"].got, "allowed", "trustd answers when the downgrade is on");
    assert.ok(trusted.ok, JSON.stringify(trusted.results.filter((x) => !x.ok)));
    // A profile without the trust block refuses the launch: trustd no longer answers (the positive control is controlled).
    const noTrust = (rule: string): Confinement => ({ ...seatbelt, wrap: (p, c, a) => { const l = seatbelt.wrap({ ...p, certificateTrust: true } as never, c, a); const strip = (arr: string[]) => arr.map((x, i) => (i === 1 && arr[0] === "-p" ? x.replace(rule, "") : x)); return { ...l, args: strip(l.args), rewrap: (cc, aa) => ({ ...l.rewrap(cc, aa), args: strip(l.rewrap(cc, aa).args) }) }; } });
    await assert.rejects(launchProbed(noTrust('(allow mach-lookup (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.ocspd"))'), { ...policy, certificateTrust: true }, s.harness, []), (err: ConfinementRefused) => {
      assert.equal(err.check, "mach-trustd", err.message);
      return true;
    });
    // The allowed-service positive control is itself controlled: strip its allow and it is denied (kr 44c), so it cannot pass for the wrong reason.
    const noNotify = (): Confinement => ({ ...seatbelt, wrap: (p, c, a) => { const l = seatbelt.wrap(p, c, a); const strip = (arr: string[]) => arr.map((x, i) => (i === 1 && arr[0] === "-p" ? x.replace('(global-name "com.apple.system.notification_center")', "") : x)); return { ...l, args: strip(l.args), rewrap: (cc, aa) => ({ ...l.rewrap(cc, aa), args: strip(l.rewrap(cc, aa).args) }) }; } });
    await assert.rejects(launchProbed(noNotify(), policy, s.harness, []), (err: ConfinementRefused) => {
      assert.equal(err.check, "mach-allowed", err.message);
      assert.equal(by_(err.report!)["mach-allowed"].got, "kr 44c", "the allowed service is denied once its allow is removed");
      return true;
    });
    // A profile that reaches the pasteboard is refused; an absent name the profile allowed is not the sandbox's refusal either.
    await assert.rejects(launchProbed(weakenedBy('(allow mach-lookup (global-name "com.apple.pasteboard.1"))'), policy, s.harness, []), (err: ConfinementRefused) => err.check === "mach-pasteboard");
    await assert.rejects(launchProbed(weakenedBy('(allow mach-lookup (global-name-prefix "me.jbkjr.relay.probe."))'), policy, s.harness, []), (err: ConfinementRefused) => {
      assert.equal(err.check, "mach-unlisted");
      assert.equal(by_(err.report!)["mach-unlisted"].got, "kr 44e", "unknown service, which proves nothing");
      return true;
    });
  } finally {
    s.done();
  }
});

test("probes: the turn opens pseudo-terminals of its own; another session's stays closed (hardening 5)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const policy = policyFor(s, { network: { mode: "on" } });
    const r = await probeWrapped(policy, s.harness);
    const by = by_(r) as Record<string, { got: string; target?: string }>;
    assert.equal(by["pty-own"].got, "allowed", JSON.stringify(by["pty-own"]));
    assert.equal(by["foreign-pty-read"].got, "EPERM");
    assert.equal(by["foreign-pty-write"].got, "EPERM");
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
    // Positive control for the foreign probes: a profile that opens every terminal is refused.
    await assert.rejects(launchProbed(weakenedBy('(allow file-read* file-write* file-ioctl (regex #"^/dev/ttys[0-9]+$"))'), policy, s.harness, []), (err: ConfinementRefused) => err.check === "foreign-pty-read");
  } finally {
    s.done();
  }
});

test("probes: harness and tool configuration cannot be planted at the top of a writable root; a lookalike name can (hardening 6)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  const grant = path.join(s.root, "grant");
  fs.mkdirSync(grant);
  try {
    const policy = policyFor(s, { writable: [grant], network: { mode: "on" } });
    const r = await probeWrapped(policy, s.harness);
    const by = by_(r) as Record<string, { got: string; target?: string }>;
    const configProbes = Object.keys(by).filter((n) => n.startsWith("write-config-") && n !== "write-config-lookalike");
    assert.ok(configProbes.length >= 10, `the worktree's config names are probed: ${configProbes.length}`);
    const targets = configProbes.map((n) => by[n].target!);
    // Only the worktree's config is live-probed; the grant's is covered by a generator test (C1/X1).
    for (const name of [".claude", ".gemini", ".mcp.json", ".envrc", ".gitconfig", ".vscode", ".zshrc"]) {
      assert.ok(targets.includes(path.join(s.wt, name)), `${path.join(s.wt, name)} is probed`);
    }
    assert.ok(!targets.some((t) => t.startsWith(`${grant}/`)), "the grant's config is not live-written");
    for (const n of configProbes) assert.equal(by[n].got, "EPERM", `${n} (${by[n].target}): ${by[n].got}`);
    assert.equal(by["write-config-lookalike"].got, "allowed", "a name not on the list is writable");
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
    assertClean(s);
    // The .git pointer is covered by its own rule, not duplicated here, and stays denied.
    assert.ok(!targets.includes(path.join(s.wt, ".git")));
  } finally {
    s.done();
  }
});

test("probes: config names already present in the worktree are checked non-destructively — never written, deleted, or taken as a reason to refuse (review C1/X1)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    // A project's own config already checked out: a file and a directory with contents.
    fs.writeFileSync(path.join(s.wt, ".mcp.json"), '{"mcpServers":{}}\n');
    fs.writeFileSync(path.join(s.wt, ".envrc"), "export FOO=bar\n");
    fs.mkdirSync(path.join(s.wt, ".claude"));
    fs.writeFileSync(path.join(s.wt, ".claude", "settings.json"), '{"keep":true}\n');
    const before = {
      mcp: fs.readFileSync(path.join(s.wt, ".mcp.json"), "utf8"),
      envrc: fs.readFileSync(path.join(s.wt, ".envrc"), "utf8"),
      claude: fs.readdirSync(path.join(s.wt, ".claude")),
    };
    const r = await probeWrapped(policyFor(s, { worktreePin: (await import("../dist/confine/seatbelt.js")).dirIdentity(s.wt), network: { mode: "on" } }), s.harness);
    const by = by_(r) as Record<string, { got: string; target?: string }>;
    // Each present name is still shown unwritable, by a non-destructive check.
    const present = Object.values(by).filter((x) => x.target && [".mcp.json", ".envrc", ".claude"].some((n) => x.target === path.join(s.wt, n) || x.target!.startsWith(path.join(s.wt, n) + "/")));
    assert.ok(present.length >= 3, JSON.stringify(by));
    for (const x of present) assert.equal(x.got, "EPERM", JSON.stringify(x));
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)), "an existing .claude/ directory does not refuse the launch");
    // The project's own files are exactly as they were: not written, not deleted.
    assert.equal(fs.readFileSync(path.join(s.wt, ".mcp.json"), "utf8"), before.mcp);
    assert.equal(fs.readFileSync(path.join(s.wt, ".envrc"), "utf8"), before.envrc);
    assert.deepEqual(fs.readdirSync(path.join(s.wt, ".claude")), before.claude, "nothing added to or removed from .claude/");
  } finally {
    s.done();
  }
});

test("probes: cleanup removes only the regular files and links the probes made; a .git directory at a cleanup path is never recursively deleted (hardening 10 / review C2)", async () => {
  const { removeProbeArtifact } = await import("../dist/confine/probe.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-c2-")));
  try {
    // A regular file the probe made: removed.
    const file = path.join(root, "x");
    fs.writeFileSync(file, "x");
    removeProbeArtifact(file);
    assert.ok(!fs.existsSync(file));
    // A symlink: unlinked, never followed.
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep"), "keep");
    const link = path.join(root, "link");
    fs.symlinkSync(target, link);
    removeProbeArtifact(link);
    assert.ok(!fs.existsSync(link, ) && fs.existsSync(path.join(target, "keep")), "the link is gone, its target intact");
    // A .git directory with contents (the probe did not create it): left untouched, not recursed into.
    const git = path.join(root, ".git");
    fs.mkdirSync(git);
    fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n");
    removeProbeArtifact(git);
    assert.ok(fs.existsSync(path.join(git, "HEAD")), "repository metadata survives cleanup");
    // An empty directory the probe made: removed, non-recursively.
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    removeProbeArtifact(empty);
    assert.ok(!fs.existsSync(empty));
    // Missing: nothing to do.
    removeProbeArtifact(path.join(root, "absent"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probes: the Mach, IOKit and sysctl-write surfaces are probed, with positive controls (hardening 10 / review C6)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const r = await probeWrapped(policyFor(s, { network: { mode: "on" } }), s.harness);
    const by = by_(r) as Record<string, { got: string }>;
    // Mach (hardening 4), IOKit and sysctl-write all covered now.
    assert.equal(by["mach-pasteboard"].got, "kr 44c");
    assert.equal(by["iokit-foreign"].got, "kr e00002e2", JSON.stringify(by["iokit-foreign"]));
    assert.equal(by["iokit-rootdomain"].got, "kr e00002e2", "no IOKit user client is reachable, the power-domain one included (hardening 14)");
    assert.equal(by["sysctl-write-foreign"].got, "EPERM", JSON.stringify(by["sysctl-write-foreign"]));
    assert.notEqual(by["sysctl-write-allowed"].got, "EPERM", "positive control: the one allowed sysctl write reaches the kernel");
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
    // Profiles that open these are refused.
    for (const [rule, check] of [
      ['(allow iokit-open (iokit-registry-entry-class "IOSurfaceRootUserClient"))', "iokit-foreign"],
      ['(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))', "iokit-rootdomain"],
      ['(allow sysctl-write (sysctl-name "kern.threadname"))', "sysctl-write-foreign"],
    ] as const) {
      await assert.rejects(launchProbed(weakenedBy(rule), policyFor(s, { network: { mode: "on" } }), s.harness, []), (err: ConfinementRefused) => {
        assert.equal(err.check, check, `${rule}: ${err.message}`);
        return true;
      });
    }
  } finally {
    s.done();
  }
});

/** Whether a named POSIX semaphore exists, asked from outside any sandbox: sem_open of an existing name, ENOENT (2) when there is none. */
function semaphoreExists(name: string): boolean {
  const js = `ObjC.bindFunction("__error",["int *",[]]); ObjC.bindFunction("sem_open",["long",["char *","int"]]); ObjC.bindFunction("sem_close",["int",["long"]]); function run(a){var s=$.sem_open(a[0],0); if (Number(s) === -1) return String($.__error()[0]); $.sem_close(s); return "open";}`;
  const r = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", js, name], { encoding: "utf8" });
  const out = r.stdout.trim();
  if (out === "open") return true;
  if (out === "2") return false;
  throw new Error(`could not tell whether ${name} exists: ${out} ${r.stderr}`);
}
/** The decoy semaphores a probe run aimed at, by name, from its report. */
const decoySemaphores = (results: { name: string; target?: string }[]): string[] =>
  ["sem-open-outside", "sem-open-mp-prefix"].map((n) => results.find((x) => x.name === n)!.target!.split(" ")[1]);

test("probes: a confined process cannot touch a named POSIX semaphore of a process outside the sandbox (hardening 12)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const policy = policyFor(s, { network: { mode: "on" } });
    const r = await probeWrapped(policy, s.harness);
    const by = by_(r) as Record<string, { got: string }>;
    for (const name of ["sem-open-outside", "sem-post-outside", "sem-unlink-outside"]) {
      assert.equal(by[name]?.got, "EPERM", `${name}: ${JSON.stringify(by[name])}`);
    }
    // The /mp- namespace Python's multiprocessing uses is open (the maintainer, 2026-10-16): a decoy there opens.
    assert.equal(by["sem-open-mp-prefix"]?.got, "allowed", JSON.stringify(by["sem-open-mp-prefix"]));
    assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
    // Made for the canary (the positive control above opened one), and gone once the probes are over.
    for (const name of decoySemaphores(r.results)) assert.equal(semaphoreExists(name), false, `${name} was removed after the probes`);
    // A profile that allows every semaphore name lets the confined process reach the outside one: refused,
    // and the decoy is genuinely reachable then (opened, not EACCES), so the deny probe is a real one.
    await assert.rejects(launchProbed(weakenedBy("(allow ipc-posix-sem)"), policy, s.harness, []), (err: ConfinementRefused) => {
      assert.ok(["sem-open-outside", "sem-post-outside", "sem-unlink-outside"].includes(err.check), err.check);
      assert.equal(by_(err.report!)["sem-open-outside"].got, "allowed", "the decoy itself is openable once allowed");
      // A refused launch's decoys are removed as well.
      for (const name of decoySemaphores(err.report!.results)) assert.equal(semaphoreExists(name), false, `${name} was removed after the refused probes`);
      return true;
    });
    assertClean(s);
  } finally {
    s.done();
  }
});

test("probes: the decoy semaphores prepareLaunch begins before its hard-link walk are removed when the launch is refused before the probes", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const policy = policyFor(s, { network: { mode: "on" } });
    let names: string[] = [];
    /** The command line of this process's decoy-semaphore helper (an osascript child), or "" when there is none. */
    const helperArgs = () => {
      const pid = spawnSync("/usr/bin/pgrep", ["-P", String(process.pid), "-f", "__sem_open"], { encoding: "utf8" }).stdout.trim();
      return pid ? spawnSync("/bin/ps", ["-ww", "-o", "args=", "-p", pid], { encoding: "utf8" }).stdout.trim() : "";
    };
    // Refuses in wrap, after the hard-link walk: the decoys exist by then (waited for), and no probe runs.
    const refusing: Confinement = { ...seatbelt, wrap: () => {
      for (let i = 0; i < 200 && names.length < 2; i++) {
        const found = [...helperArgs().matchAll(/(\/(?:mp-)?rp[0-9a-f]{12})(?=\s|$)/g)].map((m) => m[1]);
        if (found.length === 2 && found.every(semaphoreExists)) names = found;
        else spawnSync("/bin/sleep", ["0.025"]);
      }
      throw new Error("refused in wrap");
    } };
    await assert.rejects(launchProbed(refusing, policy, s.harness, []), /refused in wrap/);
    assert.equal(names.length, 2, "the decoys were made before the refusal");
    for (const name of names) assert.equal(semaphoreExists(name), false, `${name} was removed after the refused launch`);
    assert.equal(helperArgs(), "", "and their helper is gone");
  } finally {
    s.done();
  }
});

/** Makes a named POSIX semaphore from outside any sandbox, as another program would; or removes one, if it is there. */
function semaphore(op: "make" | "remove", name: string): void {
  const js = op === "make"
    ? `ObjC.bindFunction("__sem_open",["long",["char *","int","int","int"]]); ObjC.bindFunction("sem_close",["int",["long"]]); function run(a){var s=$.__sem_open(a[0],512,384,1); if (Number(s) === -1) return "failed"; $.sem_close(s); return "ok";}`
    : `ObjC.bindFunction("sem_unlink",["int",["char *"]]); function run(a){$.sem_unlink(a[0]); return "ok";}`;
  const r = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", js, name], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "ok", `${op} ${name}: ${r.stderr}`);
}

/**
 * Decoy semaphores under names the test chooses, as another program may already have them: the next
 * startDecoySemaphores takes its random id from here. The helpers it spawns are kept, to look at.
 */
function chosenDecoys(t: TestContext) {
  const id = crypto.randomBytes(6);
  const names = { outside: `/rp${id.toString("hex")}`, mp: `/mp-rp${id.toString("hex")}` };
  const randomBytes = crypto.randomBytes.bind(crypto);
  let given = false;
  t.mock.method(crypto, "randomBytes", ((n: number, ...rest: never[]) => (n === 6 && !given ? ((given = true), Buffer.from(id)) : randomBytes(n, ...rest))) as typeof crypto.randomBytes);
  const helpers: ChildProcess[] = [];
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", ((command: string, args: string[], options: never) => {
    const c = spawn(command, args, options);
    if (command === "/usr/bin/osascript" && args.some((a) => a.includes("__sem_open"))) helpers.push(c);
    return c;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  return { names, helpers };
}

test("probes: decoy semaphores are made only under names nobody has, and only those relay made are removed, by their helper or one by one", { skip: !macOS && "macOS only" }, async (t) => {
  try {
    // The outside name is another program's already; relay's helper makes only the /mp- one.
    const { names, helpers } = chosenDecoys(t);
    semaphore("make", names.outside);
    try {
      const sems = startDecoySemaphores();
      assert.deepEqual(sems.names, names);
      assert.deepEqual([...await sems.made], [names.mp], "only the name nobody had is made");
      const removing = sems.remove();
      assert.equal(sems.remove(), removing, "a second remove is the first");
      await removing;
      assert.equal(helpers[0].exitCode, 0, "the helper removed them and ended");
      assert.equal(semaphoreExists(names.mp), false, "relay's decoy is removed");
      assert.equal(semaphoreExists(names.outside), true, "the other program's semaphore is left");
    } finally {
      semaphore("remove", names.outside);
    }
    t.mock.restoreAll();
    // A helper that dies after it has said what it made: those, and only those, are removed one by one.
    const again = chosenDecoys(t);
    semaphore("make", again.names.outside);
    try {
      const sems = startDecoySemaphores();
      assert.deepEqual([...await sems.made], [again.names.mp]);
      again.helpers[0].kill("SIGKILL");
      await sems.remove();
      assert.equal(semaphoreExists(again.names.mp), false, "relay's decoy is removed one by one");
      assert.equal(semaphoreExists(again.names.outside), true, "the other program's semaphore is left");
    } finally {
      semaphore("remove", again.names.outside);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("probes: a decoy semaphore whose name another program has is not probed: its probes fail, which refuses the launch, and the semaphore is left", { skip: !macOS && "macOS only" }, async (t) => {
  const s = scratch();
  try {
    const { names } = chosenDecoys(t);
    semaphore("make", names.outside);
    try {
      const policy = policyFor(s, { network: { mode: "on" } });
      await assert.rejects(launchProbed(seatbelt, policy, s.harness, []), (err: ConfinementRefused) => {
        assert.ok(["sem-open-outside", "sem-post-outside", "sem-unlink-outside"].includes(err.check), `${err.check}: ${err.message}`);
        const by = by_(err.report!);
        for (const n of ["sem-open-outside", "sem-post-outside", "sem-unlink-outside"]) assert.equal(by[n].ok, false, `${n}: ${JSON.stringify(by[n])}`);
        assert.equal(by["sem-open-mp-prefix"].ok, true, "the /mp- decoy, which relay made, is probed as usual");
        return true;
      });
      assert.equal(semaphoreExists(names.outside), true, "the other program's semaphore is left");
      assert.equal(semaphoreExists(names.mp), false, "relay's own decoy is removed");
    } finally {
      semaphore("remove", names.outside);
    }
    assertClean(s);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    s.done();
  }
});

test("probes: decoy semaphores handed to the probes are removed, and their helper ends, when setting the probes up fails before their own clean-up would begin", { skip: !macOS && "macOS only" }, async (t) => {
  const s = scratch();
  try {
    const policy = policyFor(s, { network: { mode: "on" } });
    const probeScratch = path.join(os.tmpdir(), "relay-probe-");
    const mkdtemp = fs.mkdtempSync.bind(fs);
    for (const caller of ["prepareLaunch", "probeBoundary"] as const) {
      const { names, helpers } = chosenDecoys(t);
      // The probes' scratch directory cannot be made (a full disk), once the decoys exist.
      t.mock.method(fs, "mkdtempSync", ((prefix: string, ...rest: never[]) => {
        if (prefix !== probeScratch) return mkdtemp(prefix, ...rest);
        for (let i = 0; i < 200 && !(semaphoreExists(names.outside) && semaphoreExists(names.mp)); i++) spawnSync("/bin/sleep", ["0.025"]);
        throw Object.assign(new Error("ENOSPC: no space left on device, mkdtemp"), { code: "ENOSPC" });
      }) as typeof fs.mkdtempSync);
      const run = caller === "prepareLaunch"
        ? launchProbed(seatbelt, policy, s.harness, [])
        : probeBoundary(seatbelt.wrap(policy, scratchOnly(s.harness, "harness"), []), policy, { harness: s.harness, semaphores: startDecoySemaphores() });
      await assert.rejects(run, /ENOSPC/, caller);
      assert.equal(helpers.length, 1, `${caller}: one helper`);
      assert.equal(helpers[0].exitCode, 0, `${caller}: the helper was asked to remove the decoys, and ended`);
      for (const name of [names.outside, names.mp]) assert.equal(semaphoreExists(name), false, `${caller}: ${name} was removed`);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    s.done();
  }
});

/** Live (not zombie) processes in a process group, from ps. */
const groupMembers = (pgid: number): number[] =>
  spawnSync("/bin/ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" }).stdout.split("\n").map((l) => l.trim().split(/\s+/))
    .filter(([pid, g, stat]) => Number(pid) && Number(g) === pgid && !stat?.startsWith("Z")).map(([pid]) => Number(pid));
/** The canary of a probe run, found by the turn's temp dir on its command line (its plan and sandbox parameters carry it). */
const canaryPids = (tmp: string): number[] => spawnSync("/usr/bin/pgrep", ["-f", tmp], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).map(Number);

test("probes: a stop that comes before the canary starts none, and one that comes while it runs ends its whole process group, its osascript helper included (review r_f0fce42b X1, X2)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const policy = policyFor(s);
    const probe = (signal: AbortSignal) => probeBoundary(seatbelt.wrap(policy, scratchOnly(s.harness, "harness"), []), policy, { harness: s.harness, signal });
    // Stopped already: the targets are set up and taken down again, but no canary is started.
    const before = new AbortController();
    before.abort();
    let seen = false;
    const poll = setInterval(() => (seen ||= canaryPids(s.tmp).length > 0), 5);
    try {
      await assert.rejects(probe(before.signal), (e: ConfinementRefused) => e.check === "stopped");
    } finally {
      // A setup failure (including a too-long Unix socket path) must not leave the
      // polling timer alive after assert.rejects reports the unexpected refusal.
      clearInterval(poll);
    }
    assert.equal(seen, false, "no canary was started");
    // Stopped while the canary and one of its helpers run: nothing of its process group is left.
    const during = new AbortController();
    const running = probe(during.signal);
    let pgid = 0;
    // Its native checks' osascript helper, which runs longest: the one a stop must not leave behind.
    const helperUp = (leader: number) => groupMembers(leader).some((p) => p !== leader && /osascript/.test(spawnSync("/bin/ps", ["-o", "command=", "-p", String(p)], { encoding: "utf8" }).stdout));
    await until(() => {
      const leader = canaryPids(s.tmp)[0];
      if (leader && helperUp(leader)) pgid = leader;
      return pgid > 0;
    }, 8000, "the canary and its osascript helper running");
    during.abort();
    await assert.rejects(running, (e: ConfinementRefused) => e.check === "stopped");
    // At once: the helpers die with the canary, not some time after it.
    assert.deepEqual(groupMembers(pgid), [], "the canary's helpers went with it");
    assertClean(s);
  } finally {
    s.done();
  }
});

test("probes: a login store is probed on a decoy of relay's own under the same rules: refresh and lock work there; links, directories, other names, subdirectories and the token's mode do not; the store itself is never touched; a weakened store rule refuses the launch (D10)", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    // Stands for the person's ~/.grok: relay must aim nothing at it.
    const dir = path.join(s.root, "home", ".grok");
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(path.join(dir, "auth.json"), "decoy-token\n", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "config.toml"), "decoy-config\n", { mode: 0o600 });
    const snapshot = () => JSON.stringify(fs.readdirSync(dir, { recursive: true }).sort().map((n) => {
      const st = fs.lstatSync(path.join(dir, String(n)));
      return [n, st.ino, st.mode, st.nlink, st.isFile() ? fs.readFileSync(path.join(dir, String(n)), "utf8") : null];
    }));
    const before = snapshot();
    const store = { name: "Grok's login directory", dir, files: ["auth.json"], locks: ["auth.json.lock"], tempName: String.raw`^\.[0-9]+\.[0-9]+\.tmp$` };
    const policy = policyFor(s, { state: { home: "real", tokenStore: store } });
    const { probes } = await launchProbed(seatbelt, policy, s.harness, []);
    const by = by_(probes) as Record<string, { got: string; target?: string }>;
    for (const n of ["store-rewrite-token", "store-refresh", "store-lock", "store-rename-in"]) assert.equal(by[n]?.got, "allowed", `${n}: ${JSON.stringify(by[n])}`);
    const denied = [
      "store-other-name", "store-other-file", "store-symlink-temp", "store-hardlink-temp", "store-hardlink-own-temp", "store-mkdir-temp", "store-symlink-onto-token", "store-token-out-tmp", "store-other-mode", "store-subdir-temp",
      // Review r_75bf1f48.
      "store-dir-rename-in", "store-fifo-rename-in", "store-pair-rename-in", "store-rename-token-away", "store-rename-other-in", "store-lock-unlink", "store-exchange-lock", "store-xattr-token", "store-dot-escape",
    ];
    for (const n of denied) assert.equal(by[n]?.got, "EPERM", `${n}: ${JSON.stringify(by[n])}`);
    for (const n of ["store-rewrite-token", "store-refresh", "store-other-file", "store-subdir-temp"]) assert.match(by[n].target!, /\/decoy-store\//, `${n} aimed at the decoy`);
    assertTargets(probes);
    assert.equal(snapshot(), before, "the store itself was not touched");
    // Each weakening of the store's rules shows in a probe of the decoy, and the launch is refused.
    // The weakenings tried: one for each of these rules (the store's other rules are covered by the
    // decoy probes above, not by a weakening of their own).
    for (const [rule, check] of [
      ['(allow file-link (subpath (param "TOKEN_STORE")))', "store-hardlink-own-temp"],
      ['(allow file-write-create (subpath (param "TOKEN_STORE")))', "store-other-name"],
      ['(allow file-write-mode (subpath (param "TOKEN_STORE")))', "store-other-mode"],
      ['(allow file-write-create file-write-data (subpath (param "TOKEN_STORE_SUBDIR_0")))', "store-subdir-temp"],
      // The vnode-type filter on creation: directories at temp names (review r_75bf1f48).
      ['(allow file-write-create (require-all (subpath (param "TOKEN_STORE")) (vnode-type DIRECTORY)))', "store-mkdir-temp"],
      // The symbolic-link deny.
      ['(allow file-write-create (require-all (subpath (param "TOKEN_STORE")) (vnode-type SYMLINK)))', "store-symlink-temp"],
      // No unlink of the lock, so no exchange onto it.
      ['(allow file-write-unlink (literal (param "TOKEN_STORE_LOCK_0")))', "store-lock-unlink"],
      // No xattr anywhere in the store.
      ['(allow file-write-xattr (subpath (param "TOKEN_STORE")))', "store-xattr-token"],
    ]) {
      await assert.rejects(launchProbed(weakenedBy(rule), policy, s.harness, []), (err: ConfinementRefused) => err.check === check || assert.fail(`${rule}: ${err.check} ${err.message}`));
    }
    // A wildcard allow after them is no weakening: the store's denies name their operations, and a
    // rule naming an operation beats one on its wildcard family whatever the order (measured; seatbelt.ts).
    await launchProbed(weakenedBy('(allow file-write* (subpath (param "TOKEN_STORE_SUBDIR_0")))'), policy, s.harness, []);
    assert.equal(snapshot(), before, "nor by the weakened runs");
    // Without a way to aim the rules at a decoy, relay does not probe the store, and does not launch.
    await assert.rejects(probeWrapped(policy, s.harness), (err: ConfinementRefused) => err.check === "probe-setup" && /without aiming its rules at a decoy/.test(err.message));
  } finally {
    s.done();
  }
});

test("probes: names for a login store's temp pattern are distinct and match it", async () => {
  const { tempNames } = await import("../dist/confine/probe.js");
  assert.deepEqual(tempNames(/^\.[0-9]+\.[0-9]+\.tmp$/, 3), [".0.0.tmp", ".00.0.tmp", ".000.0.tmp"]);
  assert.deepEqual(tempNames(/^tmp-[a-f]*x$/, 2), ["tmp-ax", "tmp-aax"]);
  assert.throws(() => tempNames(/^\.tmp$/, 2), /could not make names/);
});
