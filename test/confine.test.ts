import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { confinement, confinementSummary } from "../dist/confine/index.js";
import { scratchEnv, until } from "./helpers.ts";
import { canonical, sandboxed, seatbeltLaunch, seatbeltProfile, SANDBOX_EXEC } from "../dist/confine/seatbelt.js";

const macOS = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);

/** A scratch tree: a worktree with a .git pointer, a denied control dir holding a secret, an outside dir, a turn temp dir, a HOME. */
function scratch(worktreeName = "wt") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-confine-")));
  const wt = path.join(root, worktreeName);
  const control = path.join(root, "control");
  const outside = path.join(root, "outside");
  const tmp = path.join(root, "turn-tmp");
  const home = path.join(root, "home");
  for (const d of [wt, control, outside, tmp, home]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  fs.writeFileSync(path.join(control, "relay.db"), "secret\n");
  return { root, wt, control, outside, tmp, home, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
const TOKEN = "a".repeat(32);
const policy = (s: ReturnType<typeof scratch>, extra: Record<string, unknown> = {}) => ({
  worktree: s.wt, worktreeWritable: true, tmpDir: s.tmp, denied: [s.control],
  network: { mode: "off-except-proxy" as const, proxyPort: 18877, proxyToken: TOKEN }, ...extra,
});

const HOSTILE = [
  `wt "quoted"`,
  `wt (parens) and 'single'`,
  `wt") (allow file-write* (subpath "`,
  `wt;=equals=;#|\\back`,
];

test("seatbelt profile: no path is ever written into the profile; every one is a parameter", () => {
  for (const name of HOSTILE) {
    const s = scratch(name);
    try {
      fs.mkdirSync(path.join(s.tmp, "state (x)"));
      const { profile, params } = seatbeltProfile(policy(s, { writable: [s.outside], stateDirs: [path.join(s.tmp, "state (x)")], bridgeSocket: path.join(s.root, "b.sock") }));
      assert.ok(!profile.includes(s.root), `no path in the profile (${name})`);
      assert.ok(!profile.includes(name), `nothing of the hostile name in the profile (${name})`);
      const values = Object.fromEntries(params);
      assert.equal(values.WRITABLE_0, s.wt, "the worktree is carried verbatim");
      assert.equal(values.GIT_POINTER, path.join(s.wt, ".git"));
      const denied = params.filter(([k]) => k.startsWith("DENIED_")).map(([, v]) => v);
      assert.ok(denied.includes(s.control));
      assert.ok(denied.includes(canonical(process.env.RELAY_HOME || path.join(os.homedir(), ".local", "state", "relay"))), "relay's control directory is always denied");
      assert.equal(values.BRIDGE_SOCKET, path.join(s.root, "b.sock"));
      // Every parameter the profile names is supplied, and nothing else.
      const named = [...profile.matchAll(/\(param "([A-Z_0-9]+)"\)/g)].map((m) => m[1]);
      assert.deepEqual([...new Set(named)].sort(), Object.keys(values).sort());
    } finally {
      s.done();
    }
  }
});

test("seatbelt profile: paths with NUL or line breaks, and relative paths, are refused", () => {
  const s = scratch();
  try {
    for (const bad of [`${s.wt}\nx`, `${s.wt}\r`, `${s.wt}\0x`, "relative/dir", ""]) {
      for (const field of ["worktree", "tmpDir"]) {
        assert.throws(() => seatbeltProfile(policy(s, { [field]: bad })), /NUL or line break|not absolute|empty/, `${field}=${JSON.stringify(bad)}`);
      }
      assert.throws(() => seatbeltProfile(policy(s, { writable: [bad] })), /writable\[0\]/);
      assert.throws(() => seatbeltProfile(policy(s, { denied: [bad] })), /denied\[0\]/);
      assert.throws(() => seatbeltProfile(policy(s, { bridgeSocket: bad })), /bridgeSocket/);
    }
    // A symlink whose target has a line break in its name is refused once resolved.
    const odd = path.join(s.root, "odd\nname");
    fs.mkdirSync(odd);
    fs.symlinkSync(odd, path.join(s.root, "link"));
    assert.throws(() => canonical(path.join(s.root, "link")), /line break/);
    assert.throws(() => seatbeltLaunch(policy(s), "node", []), /absolute/);
  } finally {
    s.done();
  }
});

test("seatbelt profile: shape, ordering and the network modes", () => {
  const s = scratch();
  try {
    // Paths resolve through symlinks (Seatbelt matches resolved paths); nonexistent tails are kept.
    fs.symlinkSync(s.wt, path.join(s.root, "via-link"));
    assert.equal(canonical(path.join(s.root, "via-link", "new", "file")), path.join(s.wt, "new", "file"));

    const off = seatbeltProfile(policy(s)).profile;
    assert.match(off, /^\(version 1\)\n\(deny default \(with message \(param "DIAG_TAG"\)\)\)/);
    assert.match(off, /\(remote tcp "localhost:18877"\)/);
    assert.ok(!/mDNSResponder/.test(off), "no DNS with the network off");
    // Without a bridge, the only Unix sockets the turn may reach are its own, under its temp dir.
    assert.deepEqual([...off.matchAll(/\(allow network-outbound \(remote unix-socket ([^\n]*)\)\)/g)].map((m) => m[1]), ['(subpath (param "TMPDIR"))'], "no Unix socket without a bridge but the turn's own");
    assert.ok(off.lastIndexOf("(allow file-write*") < off.indexOf("(deny file-read* file-write*"), "denies come after the write allowlist");
    assert.ok(off.indexOf("(deny file-write* (literal (param \"GIT_POINTER\"))") > off.lastIndexOf("(allow file-write*"));

    const on = seatbeltProfile(policy(s, { network: { mode: "on" }, bridgeSocket: path.join(s.root, "b.sock") })).profile;
    assert.match(on, /\(allow network-outbound \(remote ip4 "\*:\*"\)\)\n\(deny network-outbound \(remote ip4 "localhost:\*"\) \(with message \(param "DIAG_TAG"\)\)\)/, "this Mac's own addresses stay closed with the network on");
    // IPv4 only, and no "ip" rule: an "ip" rule beside an ip4 or ip6 one matched other addresses, and
    // IPv6 cannot be opened without the IPv4-mapped spellings of this Mac's addresses (review R1).
    const onCode = on.replace(/^;.*$/gm, "");
    assert.ok(!/\((remote|local) (ip|ip6|tcp6|udp6) /.test(onCode), "no IPv6 and no family-less ip rule with the network on");
    assert.match(on, /\(remote unix-socket \(path-literal \(param "BRIDGE_SOCKET"\)\)\)/);
    assert.ok(on.indexOf("BRIDGE_SOCKET") > on.indexOf('(deny network-outbound (remote ip4 "localhost:*") (with message'));

    const read = seatbeltProfile(policy(s, { worktreeWritable: false })).params;
    assert.deepEqual(read.filter(([k]) => k.startsWith("WRITABLE_")).map(([, v]) => v), [s.tmp], "a read turn writes only its temp dir");

    for (const port of [0, 70000, 1.5, Number.NaN]) assert.throws(() => seatbeltProfile(policy(s, { network: { mode: "off-except-proxy", proxyPort: port, proxyToken: TOKEN } })), /not a port/);
    assert.throws(() => seatbeltProfile(policy(s, { tmpDir: path.join(s.control, "tmp") })), /inside denied directory/);
    assert.ok(!seatbeltProfile(policy(s)).profile.includes("SecurityServer"));
    assert.ok(seatbeltProfile(policy(s, { keychain: true })).profile.includes("SecurityServer"));

    const launch = seatbeltLaunch(policy(s), "/bin/sh", ["-c", "true"]);
    assert.equal(launch.command, SANDBOX_EXEC);
    assert.deepEqual(launch.args.slice(-3), ["/bin/sh", "-c", "true"]);
    assert.equal(launch.env.TMPDIR, s.tmp);
    assert.equal(launch.env.HTTPS_PROXY, `http://relay:${TOKEN}@127.0.0.1:18877`, "with the network off the launch points at the turn's proxy");
    assert.equal(launch.env.NODE_USE_ENV_PROXY, "1");
    assert.equal(launch.env.NO_PROXY, "");
    assert.equal(seatbeltLaunch(policy(s, { network: { mode: "on" } }), "/bin/sh", []).env.HTTPS_PROXY, undefined, "no proxy with the network on");
    for (const proxyToken of [undefined, "", "short", "has space and is long enough!!"]) {
      assert.throws(() => seatbeltProfile(policy(s, { network: { mode: "off-except-proxy", proxyPort: 18877, proxyToken } })), /proxy token/);
    }
  } finally {
    s.done();
  }
});

test("seatbelt: enforced on macOS, with hostile directory names", { skip: !macOS && "macOS only" }, () => {
  const found = confinement();
  assert.ok("mechanism" in found, "Seatbelt is available");
  const mech = found.mechanism;
  for (const name of HOSTILE) {
    const s = scratch(name);
    try {
      const run = (script: string, extra: Record<string, unknown> = {}) => {
        const l = mech.wrap(policy(s, extra), "/bin/sh", ["-c", script]);
        return spawnSync(l.command, l.args, { cwd: s.wt, env: scratchEnv({ PATH: "/usr/bin:/bin", HOME: s.home, ...l.env }), encoding: "utf8" });
      };
      const ok = (script: string, extra?: Record<string, unknown>) => run(script, extra).status === 0;
      const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
      assert.ok(ok(`echo x > ${q(path.join(s.wt, "inside"))}`), `write inside the worktree (${name})`);
      assert.ok(!ok(`echo x > ${q(path.join(s.outside, "c"))}`), `write outside denied (${name})`);
      assert.ok(!ok(`echo x > ${q(path.join(s.root, "sibling"))}`), `write beside the worktree denied (${name})`);
      assert.ok(!ok(`cat ${q(path.join(s.control, "relay.db"))}`), `control dir unreadable (${name})`);
      assert.ok(!ok(`echo x > ${q(path.join(s.control, "x"))}`), `control dir unwritable (${name})`);
      assert.ok(!ok(`: >> ${q(path.join(s.wt, ".git"))}`), `.git pointer unwritable (${name})`);
      assert.ok(ok(`echo x > "$TMPDIR/t"`), `turn temp writable (${name})`);
      assert.ok(!ok(`echo x > ${q(path.join(s.wt, "ro"))}`, { worktreeWritable: false }), `read turn cannot write the worktree (${name})`);
      assert.ok(!ok(`echo x > ${q(path.join(s.home, "h"))}`), `HOME unwritable (${name})`);
      assert.ok(!fs.existsSync(path.join(s.outside, "c")) && !fs.existsSync(path.join(s.root, "sibling")) && !fs.existsSync(path.join(s.home, "h")));
    } finally {
      s.done();
    }
  }
});

test("seatbelt: sandbox_check tells a confined process from an unconfined one", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    // Killed at the end; it only has to outlive the wait below, however slow the machine.
    const l = seatbeltLaunch(policy(s), "/bin/sleep", ["120"]);
    const { spawn } = await import("node:child_process");
    const child = spawn(l.command, l.args, { stdio: "ignore" });
    try {
      await until(() => sandboxed(child.pid!), 30000, "the confined child to be sandboxed");
      assert.equal(sandboxed(process.pid), false, "the test process is not");
      assert.equal(sandboxed(-1), false);
    } finally {
      child.kill("SIGKILL");
    }
  } finally {
    s.done();
  }
});

test("this build runs the real per-turn boundary probes; no environment or config turns them off or stands another in: only a test's own code can, through the module's setter (C31, X2)", async () => {
  const { boundaryProbe, setBoundaryProbeForTests, PROBES_ENABLED } = await import("../dist/confine/turn-probe.js");
  const { prepareLaunch, confinementSummary } = await import("../dist/confine/index.js");
  const saved = { home: process.env.RELAY_HOME, probe: process.env.TEST_RELAY_PASSING_PROBE };
  try {
    // Enabled after the battery passed under Copilot's exact profiles (2026-10-17).
    assert.equal(PROBES_ENABLED, true);
    assert.equal(confinementSummary().enabled, true);
    if (macOS) assert.match(confinementSummary().status, /^relay-enforced confinement available/);
    // What once turned a stand-in on: allow_temp_home, a control directory under the temp dir, and the
    // variable. boundaryProbe takes no config at all, so only the environment is left to try.
    process.env.TEST_RELAY_PASSING_PROBE = "1";
    process.env.RELAY_HOME = path.join(os.tmpdir(), "relay-x2-test-home");
    assert.equal(boundaryProbe(), prepareLaunch, "the real probes, whatever the environment says");
    const standIn = async () => ({}) as never;
    setBoundaryProbeForTests(standIn);
    assert.equal(boundaryProbe(), standIn, "the probe a test stood in");
    setBoundaryProbeForTests(null);
    assert.equal(boundaryProbe(), prepareLaunch, "and back to the real ones");
  } finally {
    setBoundaryProbeForTests?.(null);
    for (const [k, v] of [["RELAY_HOME", saved.home], ["TEST_RELAY_PASSING_PROBE", saved.probe]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("seatbelt: the git directories denied are the ones relay's git env names, not wherever the worktree's .git now points (merge c0f2ae1 follow-up)", { skip: !macOS && "macOS only" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-confine-gitenv-")));
  try {
    const repo = path.join(root, "repo");
    const wt = path.join(root, "worktrees", "j_1");
    const tmp = path.join(root, "tmp");
    const decoy = path.join(root, "decoy");
    fs.mkdirSync(repo);
    fs.mkdirSync(tmp);
    fs.mkdirSync(decoy);
    const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    assert.equal(git("worktree", "add", "-q", "-b", "relay/j_1", wt).status, 0);
    const gitDir = path.join(repo, ".git", "worktrees", "j_1");
    // What an agent that had the run of the worktree could leave: a .git pointing at a directory of its own.
    fs.writeFileSync(path.join(decoy, "commondir"), ".\n");
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${decoy}\n`);
    const values = Object.fromEntries(seatbeltProfile({
      worktree: wt, worktreeWritable: true, tmpDir: tmp, denied: [], network: { mode: "on" }, gitEnv: { GIT_DIR: gitDir, GIT_WORK_TREE: wt },
    } as never).params);
    assert.equal(values.GIT_DIR, gitDir, "the worktree's git directory as the repository records it");
    assert.equal(values.GIT_COMMON_DIR, path.join(repo, ".git"));
    assert.equal(values.GIT_POINTER, path.join(wt, ".git"), "and the pointer itself, whatever it says");
    assert.ok(!Object.values(values).includes(decoy), "nothing of the decoy is taken for the repository");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seatbelt: the repository's git directories stay unwritable even when a grant covers the repository (review r_faba9d17 C6)", { skip: !macOS && "macOS only" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-confine-git-")));
  try {
    const repo = path.join(root, "repo");
    const wt = path.join(root, "worktrees", "j_1");
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(repo);
    fs.mkdirSync(tmp);
    const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    assert.equal(git("worktree", "add", "-q", "-b", "relay/j_1", wt).status, 0);
    const { profile, params } = seatbeltProfile({ worktree: wt, worktreeWritable: true, writable: [repo], tmpDir: tmp, denied: [], network: { mode: "on" } });
    const values = Object.fromEntries(params);
    assert.equal(values.GIT_COMMON_DIR, path.join(repo, ".git"));
    assert.equal(values.GIT_DIR, path.join(repo, ".git", "worktrees", "j_1"));
    assert.ok(profile.lastIndexOf("GIT_COMMON_DIR") > profile.lastIndexOf("(allow file-write*"), "after every allow");
    const l = seatbeltLaunch({ worktree: wt, worktreeWritable: true, writable: [repo], tmpDir: tmp, denied: [], network: { mode: "on" } }, "/bin/sh", ["-c", [
      `echo x > ${JSON.stringify(path.join(wt, "inside"))} && echo wt-ok`,
      `echo x > ${JSON.stringify(path.join(repo, "granted"))} && echo grant-ok`,
      `echo '[core]' >> ${JSON.stringify(path.join(repo, ".git", "config"))} && echo CONFIG-ESCAPED`,
      `mkdir -p ${JSON.stringify(path.join(repo, ".git", "hooks"))} && echo x > ${JSON.stringify(path.join(repo, ".git", "hooks", "pre-commit"))} && echo HOOK-ESCAPED`,
      `echo x > ${JSON.stringify(path.join(repo, ".git", "worktrees", "j_1", "HEAD"))} && echo GITDIR-ESCAPED`,
      "true",
    ].join("; ")]);
    const r = spawnSync(l.command, l.args, { cwd: wt, env: { PATH: "/usr/bin:/bin", ...l.env }, encoding: "utf8" });
    assert.match(r.stdout, /wt-ok/);
    assert.match(r.stdout, /grant-ok/);
    assert.doesNotMatch(r.stdout, /ESCAPED/, r.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seatbelt: a confined process cannot open another session's terminal by path (review r_faba9d17 C2)", { skip: !macOS && "macOS only" }, async () => {
  const { foreignPty } = await import("../dist/confine/probe.js");
  // A pseudo-terminal of our own, made through script(1): never one of the person's terminals.
  const pty = await foreignPty();
  const s = scratch();
  try {
    assert.match(pty.path, /^\/dev\/ttys\d+$/);
    const l = seatbeltLaunch(policy(s, { network: { mode: "on" } }), process.execPath, ["-e", `
      const fs = require("node:fs");
      const out = {};
      for (const [k, f] of [["read", fs.constants.O_RDONLY], ["write", fs.constants.O_WRONLY]]) {
        try { fs.closeSync(fs.openSync(${JSON.stringify(pty.path)}, f | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK)); out[k] = "allowed"; } catch (e) { out[k] = e.code; }
      }
      console.log(JSON.stringify(out));
    `]);
    const r = spawnSync(l.command, l.args, { cwd: s.wt, env: { PATH: "/usr/bin:/bin", ...l.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], detached: true } as never);
    assert.deepEqual(JSON.parse(r.stdout), { read: "EPERM", write: "EPERM" }, r.stderr);
    // No allow for terminals by pattern, but for those the kernel marked as the turn's own (hardening 5).
    const ttyAllows = seatbeltProfile(policy(s)).profile.split("\n").filter((l) => /^\(allow/.test(l) && /ttys/.test(l));
    assert.deepEqual(ttyAllows, ['(allow file-read* file-write* file-ioctl (require-all (regex #"^/dev/ttys[0-9]+$") (extension "com.apple.sandbox.pty")))']);
    // The turn's own terminal, when it has one, is allowed by name.
    const own = seatbeltProfile(policy(s, { tty: pty.path }));
    assert.equal(Object.fromEntries(own.params).TTY, pty.path);
    assert.throws(() => seatbeltProfile(policy(s, { tty: path.join(s.root, "not-a-tty") })), /tty must be/);
  } finally {
    pty.close();
    s.done();
  }
});

test("seatbelt: no listening sockets, with the network on or off (review r_faba9d17 C7)", { skip: !macOS && "macOS only" }, () => {
  const s = scratch();
  try {
    for (const network of [{ mode: "on" as const }, { mode: "off-except-proxy" as const, proxyPort: 18877, proxyToken: TOKEN }]) {
      const l = seatbeltLaunch(policy(s, { network }), process.execPath, ["-e", `
        const net = require("node:net");
        const out = {};
        const tryListen = (host) => new Promise((r) => { const srv = net.createServer(); srv.once("error", (e) => r(e.code)); srv.listen(0, host, () => { srv.close(); r("allowed"); }); });
        (async () => { out.loopback = await tryListen("127.0.0.1"); out.any = await tryListen("0.0.0.0"); console.log(JSON.stringify(out)); })();
      `]);
      const r = spawnSync(l.command, l.args, { cwd: s.wt, env: { PATH: "/usr/bin:/bin", ...l.env }, encoding: "utf8" });
      assert.deepEqual(JSON.parse(r.stdout), { loopback: "EPERM", any: "EPERM" }, `${network.mode}: ${r.stderr}`);
    }
    // The one thing that may be bound is a Unix socket under the turn's temp dir; nothing inbound.
    const code = seatbeltProfile(policy(s, { network: { mode: "on" } })).profile.replace(/^;.*$/gm, "");
    assert.deepEqual([...code.matchAll(/\(allow network-bind[^\n]*/g)].map((m) => m[0]), ['(allow network-bind (local unix-socket (subpath (param "TMPDIR"))))']);
    assert.ok(!/network-inbound/.test(code));
  } finally {
    s.done();
  }
});

test("seatbelt: with the network on, no address of this Mac's own is reachable, IPv4-mapped and -compatible spellings included; IPv4 elsewhere is, IPv6 is not (review R1)", { skip: !macOS && "macOS only" }, async () => {
  const { localAddressSpellings } = await import("../dist/confine/probe.js");
  const net = await import("node:net");
  const { spawn } = await import("node:child_process");
  const s = scratch();
  // A decoy of the test's own on a random port, at every address of this Mac (the dual-stack wildcard).
  const accepted: string[] = [];
  const decoy = net.createServer((c) => (accepted.push(String(c.remoteAddress)), c.destroy()));
  await new Promise<void>((r) => decoy.listen({ port: 0, host: "::", ipv6Only: false }, r));
  try {
    const port = (decoy.address() as { port: number }).port;
    const hosts = ["localhost", ...localAddressSpellings()];
    const l = seatbeltLaunch(policy(s, { network: { mode: "on" } }), process.execPath, ["-e", `
      const net = require("node:net");
      const [port, hosts] = JSON.parse(process.argv[1]);
      const tcp = (host, p) => new Promise((res) => { const c = net.connect({ host, port: p, autoSelectFamily: false }); const t = setTimeout(() => { c.destroy(); res("timeout"); }, 1500);
        c.on("connect", () => { clearTimeout(t); c.destroy(); res("connected"); }); c.on("error", (e) => { clearTimeout(t); res(e.code); }); });
      (async () => {
        const out = {};
        for (const h of hosts) out[h] = await tcp(h, port);
        // Not this Mac: TEST-NET-1 and the IPv6 documentation prefix, never routed anywhere real.
        out.v4 = await tcp("192.0.2.1", 443); out.v6 = await tcp("2001:db8::1", 443);
        console.log(JSON.stringify(out));
      })();`, JSON.stringify([port, hosts])]);
    const stdout = await new Promise<string>((res, rej) => {
      const c = spawn(l.command, l.args, { cwd: s.wt, env: { PATH: "/usr/bin:/bin", ...l.env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("exit", (code) => (code === 0 ? res(out) : rej(new Error(`exit ${code}: ${err}`))));
    });
    const got = JSON.parse(stdout);
    for (const h of ["::ffff:0.0.0.0", "0:0:0:0:0:ffff:0:0", "::ffff:127.0.0.1"]) assert.ok(hosts.includes(h), h);
    for (const h of hosts) assert.equal(got[h], "EPERM", `${h}: ${JSON.stringify(got)}`);
    assert.deepEqual(accepted, [], "the decoy saw no connection");
    assert.notEqual(got.v4, "EPERM", "IPv4 to another host is allowed (no reply needed)");
    assert.equal(got.v6, "EPERM", "no IPv6 with the network on");
  } finally {
    decoy.close();
    s.done();
  }
});

/** A real git repository with a job worktree beside it, as relay lays them out, in scratch. */
function gitScratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-confine-mv-")));
  const repo = path.join(root, "repo");
  const wt = path.join(root, "worktrees", "j_1");
  const tmp = path.join(root, "tmp");
  const outside = path.join(root, "outside");
  for (const d of [repo, tmp, outside]) fs.mkdirSync(d, { recursive: true });
  const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(repo, "sub"));
  fs.writeFileSync(path.join(repo, "sub", "a.txt"), "a\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
  assert.equal(git("worktree", "add", "-q", "-b", "relay/j_1", wt).status, 0);
  return { root, repo, wt, tmp, outside, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const sh = (p: Record<string, unknown>, script: string, cwd: string) => {
  const l = seatbeltLaunch(p as never, "/bin/sh", ["-c", script]);
  return spawnSync(l.command, l.args, { cwd, env: { PATH: "/usr/bin:/bin", ...l.env }, encoding: "utf8" });
};

test("seatbelt: a turn cannot move a writable root, or a protected path's ancestor, out from under its rules (review r_11c43840 C1)", { skip: !macOS && "macOS only" }, () => {
  const q = JSON.stringify;
  type S = ReturnType<typeof gitScratch> & { grant: string; secretDir: string };
  // Each attack in a fresh scratch tree, so that one's effect cannot mask another's.
  const attacks: [string, (s: S) => string][] = [
    // (a) the worktree renamed away and a link left in its place
    ["root-link", (s) => `mv ${q(s.wt)} ${q(path.join(s.tmp, "moved"))} && ln -s ${q(s.outside)} ${q(s.wt)}`],
    // (b) the worktree moved out, its .git pointer rewritten there, and moved back
    ["pointer", (s) => `mv ${q(s.wt)} ${q(path.join(s.tmp, "m2"))} && echo 'gitdir: /elsewhere' > ${q(path.join(s.tmp, "m2", ".git"))} && mv ${q(path.join(s.tmp, "m2"))} ${q(s.wt)}`],
    // (b) a granted repository moved out, its .git/config edited, and moved back
    ["config", (s) => `mv ${q(s.repo)} ${q(path.join(s.tmp, "r2"))} && echo '[core]' >> ${q(path.join(s.tmp, "r2", ".git", "config"))} && mv ${q(path.join(s.tmp, "r2"))} ${q(s.repo)}`],
    // the turn's temp dir and a grant renamed away
    ["tmp", (s) => `mv ${q(s.tmp)} ${q(path.join(s.wt, "t2"))}`],
    ["grant", (s) => `mv ${q(s.grant)} ${q(path.join(s.tmp, "g2"))}`],
    // a denied directory's ancestor inside a grant renamed, then the secret read at its new path
    ["ancestor", (s) => `mv ${q(path.join(s.grant, "a"))} ${q(path.join(s.grant, "b"))} && cat ${q(path.join(s.grant, "b", "secret", "s.txt"))}`],
    // the root emptied and removed, then made again as a link
    ["rmdir", (s) => `rm -rf ${q(s.tmp)} && ln -s ${q(s.outside)} ${q(s.tmp)}`],
  ];
  // renamex_np(RENAME_SWAP) exchanges two paths in one call: the worktree for a directory of the agent's.
  const helperDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-swap-")));
  const swap = path.join(helperDir, "swap");
  fs.writeFileSync(`${swap}.c`, `#include <stdio.h>\nint renamex_np(const char *, const char *, unsigned int);\nint main(int c, char **v) { return renamex_np(v[1], v[2], 2) ? 1 : 0; }\n`);
  const compiled = spawnSync("cc", ["-o", swap, `${swap}.c`], { encoding: "utf8" }).status === 0;
  if (compiled) attacks.push(["swap", (s) => `mkdir ${q(path.join(s.tmp, "decoy"))} && cp ${q(swap)} ${q(path.join(s.tmp, "swap"))} && ${q(path.join(s.tmp, "swap"))} ${q(s.wt)} ${q(path.join(s.tmp, "decoy"))}`]);
  const escaped: string[] = [];
  for (const [name, attack] of attacks) {
    const g = gitScratch();
    const s: S = { ...g, grant: path.join(g.root, "grant"), secretDir: path.join(g.root, "grant", "a", "secret") };
    try {
      fs.mkdirSync(s.secretDir, { recursive: true });
      fs.writeFileSync(path.join(s.secretDir, "s.txt"), "secret\n");
      const pointerBefore = fs.readFileSync(path.join(s.wt, ".git"), "utf8");
      const configBefore = fs.readFileSync(path.join(s.repo, ".git", "config"), "utf8");
      const p = { worktree: s.wt, worktreeWritable: true, writable: [s.grant, s.repo], tmpDir: s.tmp, denied: [s.secretDir], network: { mode: "on" } };
      const r = sh(p, `${attack(s)} && echo ESCAPED`, s.root);
      const intact = !fs.lstatSync(s.wt).isSymbolicLink() && fs.readFileSync(path.join(s.wt, ".git"), "utf8") === pointerBefore &&
        fs.readFileSync(path.join(s.repo, ".git", "config"), "utf8") === configBefore && fs.lstatSync(s.grant, { throwIfNoEntry: false })?.isDirectory() && fs.lstatSync(s.tmp, { throwIfNoEntry: false })?.isDirectory();
      if (/ESCAPED/.test(r.stdout) || !intact) escaped.push(name);
    } finally {
      s.done();
    }
  }
  fs.rmSync(helperDir, { recursive: true, force: true });
  assert.deepEqual(escaped, []);
  // Ordinary work inside the roots is untouched by these rules.
  const s = gitScratch();
  try {
    const grant = path.join(s.root, "grant");
    fs.mkdirSync(grant);
    const p = { worktree: s.wt, worktreeWritable: true, writable: [grant], tmpDir: s.tmp, denied: [], network: { mode: "on" } };
    const ok = sh(p, [
      `mkdir -p ${q(path.join(s.wt, "d1"))} && mv ${q(path.join(s.wt, "d1"))} ${q(path.join(s.wt, "d2"))} && rmdir ${q(path.join(s.wt, "d2"))} && echo WT-OK`,
      `mkdir -p ${q(s.wt)} && echo MKDIR-P-OK`,
      `echo x > ${q(path.join(grant, "f"))} && mv ${q(path.join(grant, "f"))} ${q(path.join(s.tmp, "f"))} && echo GRANT-OK`,
    ].join("; "), s.tmp);
    assert.match(ok.stdout, /WT-OK/, ok.stderr);
    assert.match(ok.stdout, /MKDIR-P-OK/, ok.stderr);
    assert.match(ok.stdout, /GRANT-OK/, ok.stderr);
  } finally {
    s.done();
  }
});

test("seatbelt: launched from a repository subdirectory, the repository's git directories are found by walking up and stay unwritable (review r_11c43840, Codex finding 2)", { skip: !macOS && "macOS only" }, () => {
  const s = gitScratch();
  const q = JSON.stringify;
  try {
    // A job's worktree entered at a subdirectory, with a grant over the main checkout.
    const sub = path.join(s.wt, "sub");
    const p = { worktree: sub, worktreeWritable: true, writable: [s.repo], tmpDir: s.tmp, denied: [], network: { mode: "on" } };
    const values = Object.fromEntries(seatbeltProfile(p as never).params);
    assert.equal(values.GIT_POINTER, path.join(s.wt, ".git"), "the pointer found above the subdirectory");
    assert.equal(values.GIT_COMMON_DIR, path.join(s.repo, ".git"));
    const r = sh(p, [
      `echo '[core]' >> ${q(path.join(s.repo, ".git", "config"))} && echo CONFIG-ESCAPED`,
      `echo x > ${q(path.join(s.repo, ".git", "worktrees", "j_1", "HEAD"))} && echo GITDIR-ESCAPED`,
      `echo x > ${q(path.join(s.repo, "granted"))} && echo grant-ok`,
      // a .git of its own in the subdirectory would hide the real one from the next turn's discovery
      `echo 'gitdir: /elsewhere' > ${q(path.join(sub, ".git"))} && echo NESTED-ESCAPED`,
    ].join("; "), sub);
    assert.match(r.stdout, /grant-ok/, r.stderr);
    assert.doesNotMatch(r.stdout, /ESCAPED/, r.stdout);
    // A read turn in the main checkout's subdirectory, with the checkout writable by grant.
    const main = { worktree: path.join(s.repo, "sub"), worktreeWritable: false, writable: [s.repo], tmpDir: s.tmp, denied: [], network: { mode: "on" } };
    const m = sh(main, `echo '[core]' >> ${q(path.join(s.repo, ".git", "config"))} && echo MAIN-CONFIG-ESCAPED; echo 'gitdir: /x' > ${q(path.join(s.repo, "sub", ".git"))} && echo MAIN-NESTED-ESCAPED; true`, path.join(s.repo, "sub"));
    assert.doesNotMatch(m.stdout, /ESCAPED/, m.stdout);
  } finally {
    s.done();
  }
});

test("seatbelt: before every turn, the worktree and each writable root must still be the real directory relay pinned (review r_11c43840 C1)", async () => {
  const { dirIdentity } = await import("../dist/confine/seatbelt.js");
  const s = gitScratch();
  try {
    const pin = dirIdentity(s.wt);
    assert.deepEqual(Object.keys(pin).sort(), ["dev", "ino", "path"]);
    const base = { worktree: s.wt, worktreePin: pin, worktreeWritable: true, tmpDir: s.tmp, denied: [], network: { mode: "on" } };
    seatbeltProfile(base as never);
    // From a subdirectory of the pinned worktree, too.
    seatbeltProfile({ ...base, worktree: path.join(s.wt, "sub") } as never);
    // Renamed away with a link left in its place: refused, pinned or not.
    fs.renameSync(s.wt, path.join(s.tmp, "moved"));
    fs.symlinkSync(path.join(s.tmp, "moved"), s.wt);
    assert.throws(() => seatbeltProfile(base as never), /link/);
    assert.throws(() => seatbeltProfile({ ...base, worktreePin: undefined } as never), /link/);
    // A link at an intermediate component of the pinned path: refused.
    fs.unlinkSync(s.wt);
    fs.renameSync(path.join(s.tmp, "moved"), s.wt);
    const wtParent = path.dirname(s.wt);
    fs.renameSync(wtParent, path.join(s.root, "worktrees-real"));
    fs.symlinkSync(path.join(s.root, "worktrees-real"), wtParent);
    assert.throws(() => seatbeltProfile(base as never), /link/);
    fs.unlinkSync(wtParent);
    fs.renameSync(path.join(s.root, "worktrees-real"), wtParent);
    seatbeltProfile(base as never);
    // Replaced by another directory at the same path: refused by the pin.
    fs.renameSync(s.wt, path.join(s.root, "old-wt"));
    fs.mkdirSync(s.wt);
    assert.throws(() => seatbeltProfile(base as never), /not the directory relay (created|pinned)/);
    fs.rmdirSync(s.wt);
    fs.renameSync(path.join(s.root, "old-wt"), s.wt);
    // A worktree outside the pinned one: refused.
    assert.throws(() => seatbeltProfile({ ...base, worktree: s.outside } as never), /pinned/);
    // A writable root (a grant, the temp dir) replaced by a link: refused.
    fs.renameSync(s.outside, path.join(s.root, "outside-real"));
    fs.symlinkSync(path.join(s.root, "outside-real"), s.outside);
    assert.throws(() => seatbeltProfile({ ...base, writable: [s.outside] } as never), /link/);
    const tmpLink = path.join(s.root, "tmp-link");
    fs.symlinkSync(s.tmp, tmpLink);
    assert.throws(() => seatbeltProfile({ ...base, tmpDir: tmpLink } as never), /link/);
    // A writable root that does not exist could be created by the agent as a link: refused.
    assert.throws(() => seatbeltProfile({ ...base, writable: [path.join(s.root, "absent")] } as never), /missing|does not exist/);
  } finally {
    s.done();
  }
});

test("confinement summary: names both network modes, and that network off means the target's declared hosts through the turn's proxy (review r_11c43840 N1)", async () => {
  const { confinementSummary } = await import("../dist/confine/index.js");
  const s = confinementSummary();
  assert.ok(s.enforces.some((l: string) => /^network on \(granted\): IPv4 to anything but this Mac's own addresses .*no IPv6 at all/.test(l)), s.enforces.join("\n"));
  assert.ok(s.enforces.some((l: string) => /^network off: only relay's proxy for the turn/.test(l) && /api\.individual\.githubcopilot\.com/.test(l) && !/refused until/.test(l)), s.enforces.join("\n"));
});

test("confinement summary: all registered targets, key read denials, Gemini runtime and same-sandbox environment access agree with the profile", async () => {
  const { TARGETS, targetDef } = await import("../dist/targets/index.js");
  const { turnPolicy } = await import("../dist/confine/turn.js");
  const { keyPathsToDeny } = await import("../dist/core/api-keys.js");
  const s = scratch();
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = s.home;
    const local = path.join(s.home, ".config", "relay");
    const moved = path.join(s.home, "keys", "gemini-api-key");
    fs.mkdirSync(local, { recursive: true });
    fs.mkdirSync(path.dirname(moved));
    fs.writeFileSync(path.join(local, "local.json"), JSON.stringify({ targets: { gemini: { api_key_file: moved } } }), { mode: 0o600 });
    const home = path.join(s.root, "gemini");
    fs.mkdirSync(path.join(home, ".cache"), { recursive: true });
    const p = turnPolicy({ cwd: s.wt, access: "read", target: targetDef("gemini") }, { stateDirs: [], keychain: false, persistent: { root: home, writable: [".cache"] } }, s.tmp, policy(s).network, s.home, "Gemini");
    // The relay-owned Codex login home is also private to the launcher, for every target.
    assert.deepEqual(p.denied, [...keyPathsToDeny(), path.join(s.home, ".local", "share", "relay-codex-home")]);
    assert.deepEqual(p.denied, [path.join(s.home, ".config", "relay-keys"), moved, path.join(s.home, ".local", "share", "relay-codex-home")]);
    const { profile, params } = seatbeltProfile(p);
    for (const denied of p.denied) {
      const key = params.find(([, value]) => value === denied)![0];
      assert.match(profile, new RegExp(`\\(deny file-read\\* file-write\\* file-test-existence[\\s\\S]*?\\(subpath \\(param "${key}"\\)\\)`));
    }
    assert.ok(params.some(([, value]) => value === path.join(home, ".cache")), "Gemini's runtime root is writable");
    const code = profile.replace(/;[^\n]*/g, "");
    assert.match(code, /\(deny process-info\* /);
    assert.match(code, /\(allow process-info\* \(target same-sandbox\)\)/);
    assert.doesNotMatch(code, /kern\.procargs2/);
    const summary = confinementSummary();
    const enforces = summary.enforces.join("\n");
    for (const target of TARGETS.filter((t) => t.capabilities.confinement === "relay-enforced")) {
      assert.ok(enforces.includes(target.name), target.id);
      for (const host of target.apiHosts!) assert.ok(enforces.includes(host), host);
    }
    assert.match(enforces, /Copilot: session-state and turn; Grok: sessions and turn; Gemini: \.cache, containing its runtime directory \.cache\/\.gemini/);
    assert.match(enforces, /no reads.*default API key directory.*moved elsewhere.*moved file alone, not its directory/);
    assert.match(enforces, /no reads.*relay's Codex home.*~\/\.local\/share\/relay-codex-home/);
    assert.match(summary.doesNot.join("\n"), /except.*relay's Codex home/);
    assert.match(enforces, /process-info and sysctl kern\.procargs2 permit inspection of same-sandbox/);
    assert.match(summary.doesNot.join("\n"), /own processes can read each other's start-up environment, including its proxy token.*other relay-enforced profiles cannot inspect it/);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    s.done();
  }
});

test("seatbelt: the generated profile denies removing, renaming or re-creating a granted directory and its protected ancestors; the probes leave grants alone, so this is their check (review r_11c43840 C1)", { skip: !macOS && "macOS only" }, () => {
  const s = gitScratch();
  const q = JSON.stringify;
  try {
    // A grant (the person's own directory, here scratch) holding a denied directory two levels down,
    // and a granted repository whose .git is protected.
    const grant = path.join(s.root, "grant");
    const secret = path.join(grant, "a", "b", "secret");
    fs.mkdirSync(secret, { recursive: true });
    fs.writeFileSync(path.join(secret, "s.txt"), "secret\n");
    const p = { worktree: s.wt, worktreeWritable: true, writable: [grant, s.repo], tmpDir: s.tmp, denied: [secret], network: { mode: "on" } };
    const { profile, params } = seatbeltProfile(p as never);
    const fixed = params.filter(([k]) => k.startsWith("FIXED_")).map(([, v]) => v);
    for (const f of [grant, path.join(grant, "a"), path.join(grant, "a", "b"), s.repo, s.wt, s.tmp]) assert.ok(fixed.includes(f), `${f} is fixed: ${fixed.join(", ")}`);
    assert.ok(!fixed.some((f) => f === s.root || f === path.dirname(s.wt)), "nothing outside a writable root");
    const rule = profile.indexOf("(deny file-write-unlink file-write-create");
    assert.ok(rule > profile.lastIndexOf("(allow file-write*"), "a final rule, after every allow");
    for (const [k] of params.filter(([k]) => k.startsWith("FIXED_"))) assert.ok(profile.indexOf(`(literal (param "${k}"))`) > rule);
    // And live: none of them can be removed, renamed or replaced; work inside the grant goes on.
    const before = [grant, path.join(grant, "a"), path.join(grant, "a", "b"), s.repo].map((d) => fs.statSync(d).ino);
    const r = sh(p, [
      `mv ${q(grant)} ${q(path.join(s.tmp, "g"))} && echo ESCAPED-GRANT`,
      `mv ${q(path.join(grant, "a"))} ${q(path.join(grant, "z"))} && echo ESCAPED-A`,
      `mv ${q(path.join(grant, "a", "b"))} ${q(path.join(s.tmp, "b"))} && echo ESCAPED-B`,
      `mv ${q(s.repo)} ${q(path.join(s.tmp, "r"))} && echo ESCAPED-REPO`,
      `rmdir ${q(path.join(grant, "a", "b"))} 2>/dev/null && echo ESCAPED-RMDIR`,
      `echo x > ${q(path.join(grant, "work.txt"))} && mkdir ${q(path.join(grant, "c"))} && mv ${q(path.join(grant, "c"))} ${q(path.join(grant, "d"))} && echo GRANT-WORK-OK`,
    ].join("; "), s.root);
    assert.doesNotMatch(r.stdout, /ESCAPED/, r.stdout);
    assert.match(r.stdout, /GRANT-WORK-OK/, r.stderr);
    assert.deepEqual([grant, path.join(grant, "a"), path.join(grant, "a", "b"), s.repo].map((d) => fs.statSync(d).ino), before);
    // Swapped anyway, from outside, between turns: the pre-turn check refuses the grant.
    fs.renameSync(grant, path.join(s.root, "grant-real"));
    fs.symlinkSync(path.join(s.root, "grant-real"), grant);
    assert.throws(() => seatbeltProfile(p as never), /writable\[0\] is a symbolic link/);
  } finally {
    s.done();
  }
});

test("seatbelt profile: fcntl commands that change a file through a read-only descriptor are denied by a final rule (hardening 1)", () => {
  const s = scratch();
  try {
    for (const network of [{ mode: "on" as const }, policy(s).network]) {
      const { profile } = seatbeltProfile(policy(s, { network, writable: [s.outside], bridgeSocket: path.join(s.root, "b.sock") }));
      const rule = profile.indexOf("(deny system-fcntl (fcntl-command 80 110) ");
      assert.ok(rule > 0, "the rule is there");
      assert.ok(rule > profile.lastIndexOf("(allow "), "after every allow");
      assert.ok(!/\(allow system-fcntl/.test(profile), "and nothing allows fcntl commands");
    }
  } finally {
    s.done();
  }
});

test("seatbelt launch: the only per-turn secret in the harness's environment is the proxy token, in the proxy variables, which the protocol needs; the bridge is handed none (hardening 2)", () => {
  const s = scratch();
  try {
    const l = seatbeltLaunch(policy(s, { bridgeSocket: path.join(s.root, "b.sock") }), "/bin/sh", []);
    const carrying = Object.entries(l.env).filter(([, v]) => v.includes(TOKEN)).map(([k]) => k).sort();
    assert.deepEqual(carrying, ["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "all_proxy", "http_proxy", "https_proxy"]);
    assert.ok(!l.args.some((a) => a.includes(TOKEN)), "nor on the command line");
    assert.ok(!seatbeltLaunch(policy(s, { network: { mode: "on" } }), "/bin/sh", []).args.some((a) => a.includes(TOKEN)));
    assert.ok(confinementSummary().doesNot.some((d: string) => /proxy credentials/.test(d) && /HTTPS_PROXY/.test(d)), "the limit is stated");
    assert.ok(confinementSummary().enforces.some((d: string) => /no inspection of processes outside the sandbox/.test(d)));
  } finally {
    s.done();
  }
});

test("seatbelt profile: Unix sockets only under the turn's temp dir and the bridge; relay's sockets directory and the denied directories closed by final rules; socket domains not opened wholesale (hardening 3)", async () => {
  const { relaySocketsDir } = await import("../dist/confine/sockets.js");
  const s = scratch();
  try {
    const bridge = path.join(relaySocketsDir(), "relay-turn-x", "relay.sock");
    for (const network of [{ mode: "on" as const }, policy(s).network]) {
      const { profile, params } = seatbeltProfile(policy(s, { network, bridgeSocket: bridge }));
      const values = Object.fromEntries(params);
      const code = profile.replace(/^;.*$/gm, "");
      assert.ok(!/socket-domain AF_(UNIX|INET6?)\b/.test(code), "socket creation for these domains is not gated, so no rule names them");
      if (network.mode === "on") assert.match(code, /\(allow system-socket \(require-all \(socket-domain AF_SYSTEM\) \(socket-protocol 2\)\)\)/);
      assert.ok(!/\(allow system-socket\)/.test(code), "never every domain");
      assert.equal(values.TMPDIR, s.tmp);
      const own = code.indexOf('(allow network-bind (local unix-socket (subpath (param "TMPDIR"))))');
      assert.ok(own > 0 && code.indexOf('(allow network-outbound (remote unix-socket (subpath (param "TMPDIR"))))') > 0);
      const socketsKey = Object.entries(values).find(([, v]) => v === relaySocketsDir())![0];
      const closed = code.indexOf(`(deny network-outbound (remote unix-socket (subpath (param "${socketsKey}")))`);
      assert.ok(closed > own, "relay's sockets directory is closed after the turn's own sockets are opened");
      assert.ok(code.indexOf(`(deny file-read* file-write* file-test-existence (subpath (param "${socketsKey}"))`) > own);
      assert.ok(code.indexOf('(remote unix-socket (path-literal (param "BRIDGE_SOCKET")))') > closed, "and the bridge allowed after that");
      assert.ok(code.indexOf('(deny network-outbound (remote unix-socket (subpath (param "DENIED_0")))') > 0, "nor a socket in the control directory");
      // Nothing above the sockets directory can be removed or renamed.
      const ancestors = params.filter(([k]) => k.startsWith("RELAY_ANCESTOR_")).map(([, v]) => v);
      assert.ok(ancestors.includes(path.dirname(relaySocketsDir())), ancestors.join(", "));
    }
    // A writable directory inside relay's sockets directory is a mistake, refused.
    assert.throws(() => seatbeltProfile(policy(s, { writable: [relaySocketsDir()] })), /inside denied directory/);
  } finally {
    s.done();
  }
});

test("seatbelt profile: Mach lookups only by listed global name, XPC services closed by a final rule; trust daemons only with the downgrade (hardening 4)", () => {
  const s = scratch();
  try {
    for (const network of [{ mode: "on" as const }, policy(s).network]) {
      for (const extra of [{}, { keychain: true }, { certificateTrust: true }]) {
        const code = seatbeltProfile(policy(s, { network, ...extra })).profile.replace(/^;.*$/gm, "");
        const xpc = code.indexOf('(deny mach-lookup (xpc-service-name-prefix "") ');
        assert.ok(xpc > 0 && xpc > code.lastIndexOf("(allow mach-lookup"), "XPC services closed after every Mach allow");
        assert.ok(!/\(allow mach-lookup\)/.test(code) && !/\(allow mach-lookup[^)]*(global-name-prefix|xpc-service-name)/.test(code), "nothing allowed by prefix or as an XPC service");
        const trust = /"com\.apple\.(trustd|trustd\.agent|ocspd)"/.test(code);
        assert.equal(trust, "certificateTrust" in extra, `trust daemons ${JSON.stringify(extra)}`);
        assert.ok(!/secinitd|PowerManagement\.control|pasteboard/.test(code), "nor services no harness was shown to need");
        assert.ok(code.indexOf("com.apple.coreservices.launchservicesd") > code.lastIndexOf("(allow mach-lookup"), "LaunchServices and Apple events stay denied");
      }
    }
  } finally {
    s.done();
  }
});

test("seatbelt profile: harness configuration at the top of each writable root is denied by a final rule, in the worktree and grants but not relay's own directories (hardening 6)", async () => {
  const { HARNESS_CONFIG } = await import("../dist/confine/seatbelt.js");
  const s = scratch();
  const grant = path.join(s.root, "grant");
  fs.mkdirSync(grant);
  try {
    const { profile, params } = seatbeltProfile(policy(s, { writable: [grant] }));
    const values = Object.fromEntries(params);
    const configParams = params.filter(([k]) => k.startsWith("CONFIG_")).map(([, v]) => v);
    for (const root of [s.wt, grant]) for (const name of HARNESS_CONFIG) {
      assert.ok(configParams.includes(path.join(root, name)), `${path.join(root, name)}`);
    }
    // Nothing in the turn's temp dir (its home) or in relay's directories.
    assert.ok(!configParams.some((c: string) => within(c, s.tmp) || within(c, s.control)), "only the agent's own roots");
    const rule = profile.indexOf("(deny file-write*\n  (literal (param \"CONFIG_0\")");
    assert.ok(rule > profile.lastIndexOf("(allow file-write*"), "a final rule, after the write allowlist");
    // A read turn's worktree is not writable, so its configuration is not separately denied.
    const read = seatbeltProfile(policy(s, { worktreeWritable: false })).params.filter(([k]) => k.startsWith("CONFIG_"));
    assert.deepEqual(read, []);
    // .git is not among them (its own rule covers it).
    assert.ok(!configParams.includes(path.join(s.wt, ".git")));
  } finally {
    s.done();
  }
});

test("seatbelt: Gemini's .gemini at the top of the worktree can be neither created nor written, absent or present, while a lookalike name can (hardening 6)", { skip: !macOS && "macOS only" }, () => {
  const q = JSON.stringify;
  const s = scratch();
  try {
    const p = policy(s);
    const dir = path.join(s.wt, ".gemini");
    const settings = path.join(dir, "settings.json");
    // On a volume that ignores case, .GEMINI is the same directory to Gemini, so it is refused too.
    const foldsCase = fs.existsSync(s.wt.toUpperCase());
    const r = sh(p, [
      `mkdir ${q(dir)} && echo MKDIR-ESCAPED`,
      ...(foldsCase ? [`mkdir ${q(path.join(s.wt, ".GEMINI"))} && echo CASE-ESCAPED`] : []),
      `mkdir -p ${q(dir)}; echo '{}' > ${q(settings)} && echo SETTINGS-ESCAPED`,
      `mkdir ${q(path.join(s.wt, ".geminix"))} && echo '{}' > ${q(path.join(s.wt, ".geminix", "settings.json"))} && echo lookalike-ok`,
      "true",
    ].join("; "), s.wt);
    assert.match(r.stdout, /lookalike-ok/, r.stderr);
    assert.doesNotMatch(r.stdout, /ESCAPED/, r.stdout);
    assert.ok(!fs.existsSync(dir), "no .gemini was made");
    // A project's own .gemini: still readable, but its settings cannot be rewritten or removed, no
    // .env can be added beside them (one line of it could send the key elsewhere), and it cannot be moved.
    fs.mkdirSync(dir);
    fs.writeFileSync(settings, '{"keep":true}\n');
    const r2 = sh(p, [
      `cat ${q(settings)}`,
      `echo '{}' > ${q(settings)} && echo OVERWRITE-ESCAPED`,
      `echo 'GOOGLE_GEMINI_BASE_URL=https://example.invalid' > ${q(path.join(dir, ".env"))} && echo ENV-ESCAPED`,
      `rm ${q(settings)} && echo UNLINK-ESCAPED`,
      `mv ${q(dir)} ${q(path.join(s.wt, "moved"))} && echo RENAME-ESCAPED`,
      "true",
    ].join("; "), s.wt);
    assert.match(r2.stdout, /"keep":true/, r2.stderr);
    assert.doesNotMatch(r2.stdout, /ESCAPED/, r2.stdout);
    assert.equal(fs.readFileSync(settings, "utf8"), '{"keep":true}\n');
    assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
  } finally {
    s.done();
  }
});

test("diagnostics: the deny-default rule carries the turn's tag, and a kernel denial line is parsed into its operation (hardening 8)", async () => {
  const { parseDenial } = await import("../dist/confine/diagnostics.js");
  const { diagnosticTag } = await import("../dist/confine/seatbelt.js");
  const s = scratch();
  try {
    // Deterministic from the temp dir: wrapping twice gives one tag and one profile.
    const tag = diagnosticTag(policy(s) as never);
    assert.equal(tag, diagnosticTag(policy(s) as never));
    assert.equal(Object.fromEntries(seatbeltProfile(policy(s)).params).DIAG_TAG, tag);
    // A readable label from the caller is used as given.
    assert.equal(diagnosticTag(policy(s, { tag: "r_1/n_2/3" }) as never), "relay-sandbox r_1/n_2/3");
    assert.throws(() => diagnosticTag(policy(s, { tag: "x\n(allow default)" }) as never), /short and plain/);
    // A real kernel line (as `log stream` prints it) carrying the tag is parsed; another tag's is ignored.
    const line = JSON.stringify({ eventMessage: `Sandbox: node(123) deny(1) file-write-create /private/etc/x\n${tag}` });
    assert.deepEqual(parseDenial(line, tag), { process: "node(123)", operation: "file-write-create /private/etc/x" });
    assert.equal(parseDenial(line, "relay-sandbox other"), null);
    const dup = JSON.stringify({ eventMessage: `3 duplicate reports for Sandbox: curl(9) deny(1) mach-lookup com.apple.x\n${tag}` });
    assert.deepEqual(parseDenial(dup, tag), { process: "curl(9)", operation: "mach-lookup com.apple.x" });
    assert.equal(parseDenial(JSON.stringify({ eventMessage: "not a denial" }), tag), null);
    // The denials every process raises at startup are filtered out, tagged or not (review C4).
    for (const op of ["sysctl-read security.mac.lockdown_mode_state", "sysctl-read kern.bootargs"]) {
      assert.equal(parseDenial(JSON.stringify({ eventMessage: `Sandbox: python(1) deny(1) ${op}\n${tag}` }), tag), null, op);
    }
    // Every deny carries the tag, so a harness stopped by any rule (e.g. writing .git) is streamed, not
    // just one hitting the default deny (review C4). Count denies against tagged messages in both modes.
    for (const network of [{ mode: "on" as const }, policy(s).network]) {
      const code = seatbeltProfile(policy(s, { network, keychain: true, bridgeSocket: path.join(s.root, "b.sock") })).profile;
      const denies = (code.match(/\(deny /g) ?? []).length;
      const tagged = (code.match(/\(with message \(param "DIAG_TAG"\)\)/g) ?? []).length;
      assert.ok(denies > 3 && denies === tagged, `${network.mode}: ${denies} denies, ${tagged} tagged`);
    }
  } finally {
    s.done();
  }
});

test("diagnostics e2e: a turn's own sandbox denials are streamed into its log (hardening 8)", { skip: !macOS && "macOS only" }, async () => {
  const { streamSandboxDenials } = await import("../dist/confine/diagnostics.js");
  const { diagnosticTag } = await import("../dist/confine/seatbelt.js");
  const s = scratch();
  try {
    const p = policy(s, { network: { mode: "on" } });
    const tag = diagnosticTag(p as never);
    const denials: string[] = [];
    const stream = streamSandboxDenials(tag, (d) => denials.push(d.operation));
    try {
      // log stream takes a moment to attach; give it one, then make the harness attempt a denied write.
      await until(async () => {
        const l = seatbeltLaunch(p, "/bin/sh", ["-c", `: > ${JSON.stringify(path.join(s.outside, "nope"))} 2>/dev/null; true`]);
        spawnSync(l.command, l.args, { cwd: s.wt, env: { PATH: "/usr/bin:/bin", ...l.env }, encoding: "utf8" });
        return denials.some((o) => o.includes("file-write") && o.includes(path.join(s.outside, "nope")));
      }, 30000, "the denied write to appear in the stream");
    } finally {
      stream.close();
    }
    assert.ok(denials.some((o) => o.includes(path.join(s.outside, "nope"))), denials.join("; "));
    assert.ok(!fs.existsSync(path.join(s.outside, "nope")));
  } finally {
    s.done();
  }
});

test("seatbelt profile: the person's own paths outside a writable root are never writable, so a live probe need not aim at them (hardening 9 / review C3)", async () => {
  const { dirIdentity } = await import("../dist/confine/seatbelt.js");
  // A layout like a person's checkout: a worktree with a sibling project, a home, a harness binary,
  // and a login store with a token file. None is relay's; the generated profile must leave all but
  // the worktree/grant/token-file/temp unwritable, which is what the live probes used to check.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-c3-")));
  const [wt, sibling, home, bin, store, tmp] = ["checkout", "sibling", "home", "bin", "store", "tmp"].map((d) => path.join(root, d));
  for (const d of [wt, sibling, home, bin, store, tmp]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  const token = path.join(store, "auth.json");
  fs.writeFileSync(token, "{}\n", { mode: 0o600 });
  const inside = (c: string, parent: string) => c === parent || c.startsWith(parent.endsWith("/") ? parent : parent + "/");
  const writableRoots = (params: [string, string][]) => params.filter(([k]) => k.startsWith("WRITABLE_")).map(([, v]) => v);
  try {
    // A read turn in the checkout: its parent, sibling and .git are the person's; home, bin, store too.
    const read = seatbeltProfile({ worktree: wt, worktreeWritable: false, tmpDir: tmp, denied: [], network: { mode: "on" } } as never);
    const rw = writableRoots(read.params);
    assert.deepEqual(rw, [tmp], "a read turn writes only its temp dir");
    for (const person of [wt, root, sibling, home, bin, store, path.join(wt, ".git")]) {
      assert.ok(!rw.some((w) => inside(person, w)), person + " is not writable on a read turn");
    }
    // A write turn relay created, with a grant and a token file: the worktree, the grant and the token
    // file are writable; the store directory, the home, the sibling-outside and the harness bin dir are not.
    const write = seatbeltProfile({ worktree: wt, worktreePin: dirIdentity(wt), worktreeWritable: true, writable: [sibling], tmpDir: tmp, denied: [], network: { mode: "on" }, state: { home: "real", tokenFiles: [token] } } as never);
    const ww = writableRoots(write.params);
    const vals = Object.fromEntries(write.params);
    assert.equal(vals.TOKEN_FILE_0, token, "only the token file itself is writable (data writes), not its directory");
    assert.ok(!ww.some((w) => inside(token, w)), "the login store is not a writable subpath");
    for (const person of [home, bin, store]) assert.ok(!ww.some((w) => inside(person, w)), person + " is not writable on a write turn");
    assert.ok(ww.some((w) => inside(wt, w)) && ww.some((w) => inside(sibling, w)), "the worktree and the grant are writable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seatbelt profile: a granted directory is pinned, so an intermediate symlink or a swap of the directory refuses the turn (hardening 10 / review C4/X2)", async () => {
  const { dirIdentity } = await import("../dist/confine/seatbelt.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-c4-")));
  const wt = path.join(root, "wt"), tmp = path.join(root, "tmp");
  // A grant two levels down: /root/outer/inner, with outer the ancestor an agent might be able to change.
  const outer = path.join(root, "outer"), grant = path.join(outer, "inner");
  for (const d of [wt, tmp, grant]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  try {
    const pin = dirIdentity(grant);
    const base = { worktree: wt, worktreeWritable: true, writable: [grant], writablePins: [pin], tmpDir: tmp, denied: [], network: { mode: "on" as const } };
    // Unchanged: the profile builds, and the grant is writable.
    const values = Object.fromEntries(seatbeltProfile(base as never).params);
    assert.ok(Object.values(values).includes(grant));
    // The intermediate component becomes a symlink to a sibling: the grant now resolves elsewhere; refused.
    const elsewhere = path.join(root, "elsewhere", "inner");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.renameSync(outer, path.join(root, "outer-real"));
    fs.symlinkSync(path.join(root, "elsewhere"), outer);
    assert.throws(() => seatbeltProfile(base as never), /writable\[0\] now resolves to|is a symbolic link/);
    // Restore the real ancestor; the grant directory itself swapped for another refuses by dev/inode.
    fs.unlinkSync(outer);
    fs.renameSync(path.join(root, "outer-real"), outer);
    seatbeltProfile(base as never);
    fs.renameSync(grant, path.join(outer, "inner-real"));
    fs.mkdirSync(grant);
    assert.throws(() => seatbeltProfile(base as never), /not the directory relay granted/);
    // Without a pin, the old behaviour (final-component check only) still applies: a link at the grant itself is caught, but this proves the pin is what catches an intermediate swap.
    fs.rmdirSync(grant);
    fs.renameSync(path.join(outer, "inner-real"), grant);
    assert.doesNotThrow(() => seatbeltProfile({ ...base, writablePins: undefined } as never));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seatbelt profile: no mutating fsctl, named semaphores only under /mp-, and keychain shared memory is read-only (hardening 11, 12, 13, 14)", () => {
  const s = scratch();
  try {
    const base = seatbeltProfile(policy(s)).profile.replace(/^;.*$/gm, "");
    // 11: FSIOC_CAS_BSDFLAGS removed, so system-fsctl is deny-default.
    assert.ok(!/\(allow system-fsctl/.test(base), "no system-fsctl allow");
    assert.ok(!/FSIOC_CAS_BSDFLAGS/.test(base));
    // 12: named POSIX semaphores only under /mp- (Python's multiprocessing; the maintainer, 2026-10-16), never by blanket.
    assert.deepEqual([...base.matchAll(/\(allow ipc-posix-sem[^\n]*/g)].map((m) => m[0]), ['(allow ipc-posix-sem (ipc-posix-name-prefix "/mp-"))'], "only the /mp- prefix");
    // 14: no IOKit user client, the power-domain one included.
    assert.ok(!/\(allow iokit-open/.test(base), "no iokit-open allow");
    assert.ok(!/RootDomainUserClient/.test(base));
    // 13: with the keychain downgrade, the change-notification segment is readable but not writable.
    const kc = seatbeltProfile(policy(s, { keychain: true })).profile.replace(/^;.*$/gm, "");
    assert.match(kc, /\(allow ipc-posix-shm-read\* \(ipc-posix-name "com\.apple\.AppleDatabaseChanged"\)\)/);
    assert.ok(!/ipc-posix-shm-write-data/.test(kc), "no shm write in the keychain block");
  } finally {
    s.done();
  }
});

test("seatbelt profile: the read-only sysconf limits runtimes need are allowed, and no process-naming sysctl is (review C2)", () => {
  const s = scratch();
  try {
    const code = seatbeltProfile(policy(s)).profile.replace(/^;.*$/gm, "");
    for (const name of ['(sysctl-name-prefix "kern.sysv.")', '(sysctl-name "kern.aiomax")', '(sysctl-name "kern.saved_ids")', '(sysctl-name "kern.posix1version")']) {
      assert.ok(code.includes(name), `${name} is allowed`);
    }
    // Still no kern.proc / kern.procargs by prefix or name: process inspection stays closed.
    assert.ok(!/sysctl-name-prefix "kern\."|sysctl-name "kern\.proc|kern\.procargs/.test(code), "no process-naming sysctl");
  } finally {
    s.done();
  }
});

test("seatbelt: a granted repository's own .git is not writable, present or not (review C3)", { skip: !macOS && "macOS only" }, () => {
  const g = gitScratch();
  const q = JSON.stringify;
  try {
    // A second repository beside the job, granted for writing: its .git must stay unwritable.
    const grant = path.join(g.root, "lib");
    fs.mkdirSync(grant);
    const git = (...a: string[]) => spawnSync("git", a, { cwd: grant, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(grant, "a.txt"), "a\n");
    git("add", "a.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    const p = { worktree: g.wt, worktreeWritable: true, writable: [grant], tmpDir: g.tmp, denied: [], network: { mode: "on" } };
    const { profile, params } = seatbeltProfile(p as never);
    const grantGit = params.filter(([k]) => k.startsWith("GRANT_GIT_")).map(([, v]) => v);
    assert.ok(grantGit.includes(path.join(grant, ".git")), `the grant's .git is denied: ${grantGit.join(", ")}`);
    assert.ok(profile.indexOf('(param "GRANT_GIT_0")') > profile.lastIndexOf("(allow file-write*"), "after every allow");
    const configBefore = fs.readFileSync(path.join(grant, ".git", "config"), "utf8");
    const r = sh(p, [
      `echo x > ${q(path.join(grant, "lib.txt"))} && echo grant-ok`,
      `echo '[core]' >> ${q(path.join(grant, ".git", "config"))} && echo CONFIG-ESCAPED`,
      `mkdir -p ${q(path.join(grant, ".git", "hooks"))} && echo x > ${q(path.join(grant, ".git", "hooks", "pre-commit"))} && echo HOOK-ESCAPED`,
      "true",
    ].join("; "), g.root);
    assert.match(r.stdout, /grant-ok/, r.stderr);
    assert.doesNotMatch(r.stdout, /ESCAPED/, r.stdout);
    assert.equal(fs.readFileSync(path.join(grant, ".git", "config"), "utf8"), configBefore);
    // Denied even when the grant is not a repository yet: the agent cannot create a .git there.
    const plain = path.join(g.root, "plain");
    fs.mkdirSync(plain);
    const p2 = { worktree: g.wt, worktreeWritable: true, writable: [plain], tmpDir: g.tmp, denied: [], network: { mode: "on" } };
    const r2 = sh(p2, `mkdir ${q(path.join(plain, ".git"))} && echo NESTED-ESCAPED; echo 'gitdir: /x' > ${q(path.join(plain, ".git"))} 2>/dev/null && echo POINTER-ESCAPED; echo x > ${q(path.join(plain, "ok.txt"))} && echo plain-ok; true`, g.root);
    assert.match(r2.stdout, /plain-ok/, r2.stderr);
    assert.doesNotMatch(r2.stdout, /ESCAPED/, r2.stdout);
  } finally {
    g.done();
  }
});

test("seatbelt profile: a writable grant must carry exactly one valid pin; a missing, extra or malformed pin fails the turn closed (review X2)", async () => {
  const { dirIdentity } = await import("../dist/confine/seatbelt.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-x2-")));
  const wt = path.join(root, "wt"), tmp = path.join(root, "tmp"), g1 = path.join(root, "g1"), g2 = path.join(root, "g2");
  for (const d of [wt, tmp, g1, g2]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  try {
    const base = { worktree: wt, worktreeWritable: true, writable: [g1, g2], tmpDir: tmp, denied: [], network: { mode: "on" as const } };
    // One valid pin per grant: fine.
    seatbeltProfile({ ...base, writablePins: [dirIdentity(g1), dirIdentity(g2)] } as never);
    // A legacy grant: pins omitted entirely. Still generated (pins not supplied at all), but acp refuses
    // such a turn (tested separately); when pins ARE supplied they must match one-for-one.
    seatbeltProfile(base as never);
    // Too few, too many, or a malformed pin: refused.
    assert.throws(() => seatbeltProfile({ ...base, writablePins: [dirIdentity(g1)] } as never), /exactly one pin per granted directory/);
    assert.throws(() => seatbeltProfile({ ...base, writablePins: [dirIdentity(g1), dirIdentity(g2), dirIdentity(g1)] } as never), /exactly one pin/);
    assert.throws(() => seatbeltProfile({ ...base, writablePins: [dirIdentity(g1), undefined] } as never), /not a pinned directory/);
    assert.throws(() => seatbeltProfile({ ...base, writablePins: [dirIdentity(g1), { path: g2, dev: 1, ino: 2 }] } as never), /not the directory relay granted/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostics: a denial stream dies with the process that started it, and on close, leaving no log stream behind (review C4 follow-up)", { skip: !macOS && "macOS only" }, async () => {
  const { spawn, execFileSync } = await import("node:child_process");
  const crypto = await import("node:crypto");
  const streams = (tag: string) => {
    try {
      return execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes("log stream") && l.includes(tag));
    } catch {
      return [];
    }
  };
  // The host is SIGKILLed (as a test harness or a crash kills a relay worker): its stream must not be orphaned.
  const tag = `relay-sandbox test-${crypto.randomBytes(6).toString("hex")}`;
  const host = spawn(process.execPath, [path.resolve(import.meta.dirname, "fixtures", "denial-stream-host.mjs"), tag], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve) => host.stdout.on("data", (d) => String(d).includes("ready") && resolve()));
  assert.ok(streams(tag).length >= 1, "the stream is running while its host is alive");
  host.kill("SIGKILL");
  await until(() => streams(tag).length === 0, 15000, "the stream to exit after its host was killed");
  // And close() leaves nothing either.
  const { streamSandboxDenials } = await import("../dist/confine/diagnostics.js");
  const tag2 = `relay-sandbox test-${crypto.randomBytes(6).toString("hex")}`;
  const s = streamSandboxDenials(tag2, () => {});
  await s.ready;
  assert.ok(streams(tag2).length >= 1);
  s.close();
  await until(() => streams(tag2).length === 0, 15000, "the stream to exit after close()");
});

/** A python3 that can run without side effects: one on PATH that is not the Xcode stub, else /usr/bin/python3 only when the developer tools are installed (the stub would offer to install them). */
function findPython(): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, "python3");
    if (dir && p !== "/usr/bin/python3" && fs.existsSync(p)) return fs.realpathSync(p);
  }
  if (fs.existsSync("/usr/bin/python3") && spawnSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" }).status === 0) return "/usr/bin/python3";
  return null;
}
const PYTHON = macOS ? findPython() : null;

test("tool battery: Python multiprocessing (a Lock and a small ProcessPoolExecutor) works inside the profile (the maintainer's C2 decision: /mp- semaphores)", { skip: !macOS ? "macOS only" : !PYTHON && "no python3 here (none on PATH, and /usr/bin/python3 is the Xcode stub without the developer tools)" }, () => {
  const s = scratch();
  try {
    const script = [
      "import multiprocessing as m",
      "from concurrent.futures import ProcessPoolExecutor",
      "l = m.Lock(); l.acquire(); l.release()",
      "with ProcessPoolExecutor(max_workers=2) as e: total = sum(e.map(abs, [-1, -2, -3]))",
      "print('ok', total)",
    ].join("\n");
    const p = policy(s, { network: { mode: "on" }, execPaths: [path.dirname(PYTHON!)] });
    const l = seatbeltLaunch(p, PYTHON!, ["-c", script]);
    const r = spawnSync(l.command, l.args, { cwd: s.wt, env: { PATH: "/usr/bin:/bin", ...l.env }, encoding: "utf8", timeout: 60000 });
    assert.equal(r.stdout.trim(), "ok 6", `${r.stdout}\n${r.stderr.split("\n").slice(-6).join("\n")}`);
  } finally {
    s.done();
  }
});

test("licences: the Seatbelt rule copied from Codex ships with its Apache-2.0 licence and Codex's NOTICE (confine-hardening.md; 1.0 audit)", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(path.join(root, "src", "confine", "seatbelt.ts"), "utf8");
  assert.match(src, /This rule is from OpenAI Codex \(codex-rs\/sandboxing\/src\/seatbelt\.rs at 0e67502\), Copyright 2025\s+\/\/ OpenAI, licensed under the Apache License, Version 2\.0; copied unchanged\./);
  assert.match(fs.readFileSync(path.join(root, "LICENSES", "Apache-2.0.txt"), "utf8"), /Apache License\s+Version 2\.0, January 2004/);
  assert.match(fs.readFileSync(path.join(root, "LICENSES", "codex-NOTICE.txt"), "utf8"), /^OpenAI Codex\nCopyright\s2025\sOpenAI\n/);
  const index = fs.readFileSync(path.join(root, "LICENSES", "README.md"), "utf8");
  for (const s of ["src/confine/seatbelt.ts", "0e67502123b4c6952b9fa5d672d2907fe4059f56", "Apache-2.0.txt", "codex-NOTICE.txt"]) assert.ok(index.includes(s), s);
});

/** The profile's top-level rules, in order: action, operations, and what their filters cover (params resolved). */
function profileRules(profile: string, params: [string, string][]) {
  const value = new Map(params);
  const forms: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < profile.length; i++) {
    const ch = profile[i];
    if (ch === '"') {
      for (i++; i < profile.length && profile[i] !== '"'; i++) if (profile[i] === "\\") i++;
      continue;
    }
    if (ch === ";") {
      const nl = profile.indexOf("\n", i);
      i = nl < 0 ? profile.length : nl;
      continue;
    }
    if (ch === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ")" && --depth === 0) forms.push(profile.slice(start, i + 1));
  }
  return forms.map((f, index) => {
    const head = /^\((allow|deny)((?:\s+[a-z*-]+)+)/.exec(f);
    if (!head) return null;
    const ops = head[2].trim().split(/\s+/);
    let rest = f.slice(head[0].length, -1).replace(/\(with message \(param "DIAG_TAG"\)\)/, "");
    const paths: { kind: "literal" | "subpath"; path: string }[] = [];
    for (const m of rest.matchAll(/\((literal|subpath) \(param "([A-Z0-9_]+)"\)\)/g)) paths.push({ kind: m[1] as "literal", path: value.get(m[2])! });
    for (const m of rest.matchAll(/\((literal|subpath) "([^"]+)"\)/g)) paths.push({ kind: m[1] as "literal", path: m[2] });
    const regexes = [...rest.matchAll(/\(regex #"((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1].replace(/\\\\/g, "\\"));
    // What is left once the filters understood here are taken out: anything else (require-all, extension, …) is not analysed.
    rest = rest.replace(/\((literal|subpath) \(param "[A-Z0-9_]+"\)\)/g, "").replace(/\((literal|subpath) "[^"]+"\)/g, "").replace(/\(regex #"(?:[^"\\]|\\.)*"\)/g, "");
    const unanalysed = rest.trim().length > 0;
    return { index, text: f, action: head[1], ops, paths, regexes, unanalysed, everything: !paths.length && !regexes.length && !unanalysed };
  }).filter((r): r is NonNullable<typeof r> => r !== null);
}

type Rule = ReturnType<typeof profileRules>[number];
const TERMINALS = "^/dev/ttys[0-9]+$";
/**
 * Operation-specific allows whose filters the check below cannot analyse, each reviewed: why no deny
 * that must beat it is missing. Keyed by an exact substring of the rule.
 */
const REVIEWED: Record<string, string> = {
  '(regex #"^/dev/fd/[0-9]+$")': "the process's own descriptors by number; no relay deny covers /dev/fd",
  '(require-all (subpath (param "TOKEN_STORE")) (regex #"': "a login store's temp names: inside the store, which boundaryPaths keeps clear of every path the profile writes or protects",
};

/** Operation-specific allows meant to beat a deny of the same operation that comes before them, each reviewed. */
const OVERRIDES: Record<string, string> = {
  '(literal (param "TTY"))': "the turn's own terminal, through the deny of other terminals",
  '(literal (param "BRIDGE_SOCKET"))': "the turn's own bridge socket, whose name connecting looks up, through the deny of relay's sockets directory",
  '(literal (param "BRIDGE_SECRET_FILE"))': "the turn's own bridge secret's file, read by name beside its socket, through the deny of relay's sockets directory",
};

/** Where the profile's operation-specific allows are not overridden as relay means them to be: the violations, as text. */
function precedenceViolations(rules: Rule[]): string[] {
  const family = (op: string) => (op.startsWith("file-write-") ? "file-write*" : op.startsWith("file-read-") || op === "file-test-existence" ? "file-read*" : null);
  const covers = (deny: Rule, allow: Rule) => {
    if (allow.everything || deny.everything) return true;
    for (const a of allow.paths) {
      for (const d of deny.paths) if (within(a.path, d.path) || (a.kind === "subpath" && within(d.path, a.path))) return true;
      if (deny.regexes.some((r) => new RegExp(r).test(a.path))) return true;
    }
    return false;
  };
  const reviewed = (allow: Rule, list: Record<string, string>) => Object.keys(list).some((k) => allow.text.includes(k));
  const out: string[] = [];
  for (const allow of rules.filter((r) => r.action === "allow")) {
    const specific = allow.ops.filter((o) => family(o));
    if (!specific.length || reviewed(allow, OVERRIDES)) continue;
    if ((allow.unanalysed || allow.regexes.length) && !reviewed(allow, REVIEWED)) {
      out.push(`unanalysed operation-specific allow: ${allow.text.slice(0, 100)}`);
      continue;
    }
    for (const op of specific) {
      // Every deny covering it, on the operation or its family, needs a deny naming the operation, covering
      // as much, after the allow: a wildcard deny does not override it, and between rules on one operation the last wins.
      for (const deny of rules.filter((r) => r.action === "deny" && (r.ops.includes(op) || r.ops.includes(family(op)!)) && covers(r, allow))) {
        // The one deliberate exception: existence tests of terminals stay allowed (no secret; openpty needs them).
        if (op === "file-test-existence" && !deny.ops.includes(op) && deny.regexes.length === 1 && !deny.paths.length && deny.regexes[0] === TERMINALS) continue;
        const later = rules.some((r) => r.action === "deny" && r.ops.includes(op) && r.index > allow.index && (!deny.everything || r.everything) && deny.paths.every((p) => r.paths.some((q) => q.path === p.path)) && deny.regexes.every((x) => r.regexes.includes(x)));
        if (!later) out.push(`${op} in ${allow.text.slice(0, 80)} is not overridden by ${deny.text.slice(0, 80)}`);
      }
    }
  }
  return out;
}

test("seatbelt profile: the bridge secret's file is the turn's own: read by name beside its socket, after the sockets directory's deny, never written; refused anywhere else, and named by no other profile", async () => {
  const { relaySocketsDir } = await import("../dist/confine/sockets.js");
  const s = scratch();
  try {
    const dir = path.join(relaySocketsDir(), "relay-turn-x");
    const bridgeSocket = path.join(dir, "relay.sock");
    const bridgeSecret = path.join(dir, "bridge-secret");
    for (const network of [{ mode: "on" as const }, policy(s).network]) {
      const { profile, params } = seatbeltProfile(policy(s, { network, bridgeSocket, bridgeSecret }));
      const values = Object.fromEntries(params);
      assert.equal(values.BRIDGE_SECRET_FILE, canonical(bridgeSecret));
      const code = profile.replace(/^;.*$/gm, "");
      const rule = '(allow file-read-data file-read-metadata file-test-existence (literal (param "BRIDGE_SECRET_FILE")))';
      assert.equal(code.split(rule).length - 1, 1, "one rule, by name");
      assert.equal(code.split('(param "BRIDGE_SECRET_FILE")').length - 1, 1, "and no other rule names it: nothing written");
      const socketsKey = Object.entries(values).find(([, v]) => v === canonical(relaySocketsDir()))![0];
      assert.ok(code.indexOf(rule) > code.indexOf(`(deny file-read* file-write* file-test-existence (subpath (param "${socketsKey}"))`), "after the sockets directory's deny, which it names operations of");
      assert.deepEqual(precedenceViolations(profileRules(profile, params)), [], "a reviewed override");
    }
    assert.ok(!seatbeltProfile(policy(s, { bridgeSocket })).profile.includes("BRIDGE_SECRET_FILE"), "a profile without it names no such file: relay's sockets directory stays denied whole");
    assert.throws(() => seatbeltProfile(policy(s, { bridgeSecret })), /bridgeSecret needs bridgeSocket/);
    assert.throws(() => seatbeltProfile(policy(s, { bridgeSocket, bridgeSecret: path.join(relaySocketsDir(), "relay-turn-y", "bridge-secret") })), /beside the turn's bridge socket/, "another turn's broker directory");
    assert.throws(() => seatbeltProfile(policy(s, { bridgeSocket, bridgeSecret: bridgeSocket })), /beside the turn's bridge socket/, "the socket itself");
    assert.throws(() => seatbeltProfile(policy(s, { bridgeSocket: path.join(s.root, "b.sock"), bridgeSecret: path.join(s.root, "b.secret") })), /in relay's sockets directory/, "a place other turns may read");
  } finally {
    s.done();
  }
});

test("seatbelt profile: rule precedence: every deny that must beat an operation-specific allow names that operation and comes after it, since a file-write* or file-read* deny does not override it (measured on macOS 27.0.1; design-token-store.md; review r_64e5a9ce)", () => {
  const s = scratch();
  try {
    const store = path.join(s.home, ".store");
    fs.mkdirSync(store);
    const token = path.join(store, "token.json");
    fs.writeFileSync(token, "decoy\n", { mode: 0o600 });
    // A policy with every kind of rule the generator writes: grants, state, token files, a terminal, the bridge, both downgrades.
    const full = policy(s, {
      writable: [s.outside], stateDirs: [path.join(s.tmp, "state")], bridgeSocket: path.join(s.root, "b.sock"), tty: "/dev/ttys042",
      keychain: true, certificateTrust: true, state: { home: "real", tokenFiles: [token], tokenStore: decoyStore(s).store },
    });
    fs.mkdirSync(path.join(s.tmp, "state"));
    for (const network of [full.network, { mode: "on" as const }]) {
      const { profile, params } = seatbeltProfile({ ...full, network });
      const rules = profileRules(profile, params);
      assert.deepEqual(precedenceViolations(rules), [], precedenceViolations(rules).join("\n"));
      // The rules the check rests on are there: the unfiltered existence-test allow, and the denied directories naming it after it.
      assert.ok(rules.some((r) => r.action === "allow" && r.ops.includes("file-test-existence") && r.everything));
      assert.ok(rules.some((r) => r.action === "deny" && r.ops.includes("file-test-existence") && r.paths.some((p) => p.path === canonical(s.control))));
      // The check itself catches what it is for (review r_64e5a9ce X2): the denied directories' existence
      // denies moved before the global allow, the profile as it was before them, and a regex-only
      // operation-specific allow for terminals.
      const denials = profile.split("\n").filter((l) => l.startsWith("(deny file-read* file-write* file-test-existence (subpath (param \"DENIED_"));
      assert.ok(denials.length >= 2);
      const moved = denials.join("\n") + "\n" + profile.split("\n").filter((l) => !denials.includes(l)).join("\n");
      assert.match(precedenceViolations(profileRules(moved, params)).join("\n"), /file-test-existence in \(allow file-test-existence\) is not overridden/);
      const before = profile.replaceAll("(deny file-read* file-write* file-test-existence (subpath (param \"DENIED_", "(deny file-read* file-write* (subpath (param \"DENIED_");
      assert.match(precedenceViolations(profileRules(before, params)).join("\n"), /file-test-existence in \(allow file-test-existence\) is not overridden by \(deny file-read\* file-write\* \(subpath \(param "DENIED_/);
      const widened = profile + `(allow file-write-data (regex #"${TERMINALS}"))\n`;
      assert.match(precedenceViolations(profileRules(widened, params)).join("\n"), /unanalysed operation-specific allow: \(allow file-write-data \(regex/);
    }
    // A token file inside a path the profile protects would be writable there (file-write-data beats file-write*): refused.
    fs.mkdirSync(path.join(s.wt, ".claude"));
    const planted = path.join(s.wt, ".claude", "token.json");
    fs.writeFileSync(planted, "decoy\n", { mode: 0o600 });
    assert.throws(() => seatbeltProfile(policy(s, { state: { home: "real", tokenFiles: [planted] } })), /lies inside .*\.claude, which the sandbox protects/);
  } finally {
    s.done();
  }
});

/** A decoy login store of relay's own, laid out as a harness that refreshes by rename keeps it (Grok's ~/.grok): never the real one. */
function decoyStore(s: ReturnType<typeof scratch>) {
  const dir = path.join(s.home, ".grok");
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, "auth.json"), "decoy-token\n", { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "config.toml"), "decoy-config\n", { mode: 0o600 });
  const victim = path.join(s.outside, "victim-rc");
  fs.writeFileSync(victim, "decoy-rc\n", { mode: 0o600 });
  // Grok's temp names: `.{pid}.{counter}.tmp` (grok-build 2bdd1d6, fs_atomic.rs write_via_temp_with).
  return { store: { name: "Grok's login directory", dir, files: ["auth.json"], locks: ["auth.json.lock"], tempName: String.raw`^\.[0-9]+\.[0-9]+\.tmp$` }, dir, victim };
}

test("token store: quarantine renames every unsafe allowed entry without opening it, and leaves a good store alone", async (t) => {
  const { quarantineTokenStore, tokenStoreProblem } = await import("../dist/confine/seatbelt.js");
  for (const kind of ["symlink", "directory", "hardlink", "alias", "lock", "temp", "executable", "owner", "fifo", "good"]) {
    await t.test(kind, (t) => {
      const s = scratch();
      try {
        const { store, dir, victim } = decoyStore(s);
        const name = kind === "alias" ? "AUTH.json" : kind === "lock" ? "auth.json.lock" : kind === "temp" ? ".71.0.tmp" : "auth.json";
        const source = path.join(dir, name);
        if (!["lock", "temp", "good", "owner", "executable"].includes(kind)) fs.unlinkSync(path.join(dir, "auth.json"));
        if (["symlink", "lock", "temp"].includes(kind)) fs.symlinkSync(victim, source);
        if (kind === "directory") fs.mkdirSync(source);
        if (kind === "fifo") assert.equal(spawnSync("mkfifo", [source]).status, 0);
        if (kind === "hardlink") fs.linkSync(victim, source);
        if (kind === "alias") fs.writeFileSync(source, "alias", { mode: 0o600 });
        if (kind === "executable") fs.chmodSync(source, 0o700);
        if (kind === "owner") {
          const lstat = fs.lstatSync.bind(fs);
          t.mock.method(fs, "lstatSync", (p: fs.PathLike, options: any) => {
            const st = lstat(p, options);
            if (String(p).endsWith("/auth.json") && st) st.uid = (process.getuid?.() ?? 0) + 1;
            return st;
          });
        }
        const reads: string[] = [];
        t.mock.method(fs, "readFileSync", (p: fs.PathOrFileDescriptor) => { reads.push(String(p)); throw new Error("quarantine must not read files"); });
        const destination = path.join(s.control, "quarantine", "run", "node", "turn");
        const result = quarantineTokenStore(store, destination, "turn");
        assert.deepEqual(reads, []);
        assert.deepEqual(result.errors, []);
        if (kind === "good") {
          assert.equal(result.problem, null);
          assert.deepEqual(result.moved, []);
          assert.equal(fs.existsSync(destination), false);
          assert.ok(fs.lstatSync(source).isFile());
        } else {
          assert.ok(result.problem);
          assert.ok(result.moved.some((m: { name: string; to: string }) => m.name === name && m.to === path.join(destination, name)));
          assert.equal(fs.lstatSync(source, { throwIfNoEntry: false }), undefined);
          assert.equal(fs.lstatSync(path.join(dir, "auth.json"), { throwIfNoEntry: false }), undefined, "even an unsafe lock or temp file requires a fresh login");
          assert.ok(fs.lstatSync(path.join(destination, name)), "the entry itself was kept");
          assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
          if (kind !== "owner") assert.equal(tokenStoreProblem(store), null, "quarantined entries do not poison the next metadata check");
        }
        t.mock.restoreAll();
        assert.equal(fs.readFileSync(victim, "utf8"), "decoy-rc\n", "the link target was untouched");
      } finally { t.mock.restoreAll(); s.done(); }
    });
  }
});

test("token store: an EXDEV fallback collision preserves both entries and reports the name and cause", async (t) => {
  const { quarantineTokenStore } = await import("../dist/confine/seatbelt.js");
  const s = scratch();
  try {
    const { store, dir, victim } = decoyStore(s);
    const token = path.join(dir, "auth.json");
    fs.unlinkSync(token);
    fs.symlinkSync(victim, token);
    const fallback = path.join(dir, ".relay-quarantine.turn.auth.json");
    fs.writeFileSync(fallback, "prior evidence");
    t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("different volume"), { code: "EXDEV" }); });
    const result = quarantineTokenStore(store, path.join(s.control, "quarantine", "turn"), "turn");
    assert.deepEqual(result.moved, []);
    assert.match(result.errors[0], /QUARANTINE FAILED.*auth\.json.*fallback already exists/);
    assert.equal(fs.readFileSync(fallback, "utf8"), "prior evidence");
    assert.ok(fs.lstatSync(token).isSymbolicLink());
  } finally { s.done(); }
});

test("token store: a case alias and a distinct token on a case-sensitive volume are both quarantined", async (t) => {
  const { quarantineTokenStore } = await import("../dist/confine/seatbelt.js");
  const s = scratch();
  try {
    const { store, dir } = decoyStore(s);
    const alias = path.join(dir, "AUTH.json");
    if (fs.existsSync(alias)) return t.skip("requires a case-sensitive volume");
    fs.writeFileSync(alias, "alias", { mode: 0o600 });
    const result = quarantineTokenStore(store, path.join(s.control, "quarantine", "turn"), "turn");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.moved.map((m: { name: string }) => m.name).sort(), ["AUTH.json", "auth.json"]);
    for (const name of ["AUTH.json", "auth.json"]) assert.equal(fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false }), undefined);
  } finally { s.done(); }
});

test("token store: EXDEV quarantines by rename to a dot-name in the store; the next check ignores it", async (t) => {
  const { quarantineTokenStore, tokenStoreProblem } = await import("../dist/confine/seatbelt.js");
  const s = scratch();
  try {
    const { store, dir, victim } = decoyStore(s);
    const token = path.join(dir, "auth.json");
    fs.unlinkSync(token);
    fs.symlinkSync(victim, token);
    const rename = fs.renameSync.bind(fs);
    const calls: string[][] = [];
    t.mock.method(fs, "renameSync", (from: string, to: string) => {
      calls.push([from, to]);
      if (calls.length === 1) throw Object.assign(new Error("different volume"), { code: "EXDEV" });
      rename(from, to);
    });
    const result = quarantineTokenStore(store, path.join(s.control, "quarantine", "turn"), "turn");
    const fallback = path.join(dir, ".relay-quarantine.turn.auth.json");
    assert.deepEqual(result.moved, [{ name: "auth.json", to: fallback }]);
    assert.deepEqual(result.errors, []);
    assert.equal(calls.length, 2);
    assert.ok(fs.lstatSync(fallback).isSymbolicLink());
    assert.equal(fs.lstatSync(token, { throwIfNoEntry: false }), undefined);
    assert.equal(tokenStoreProblem(store), null);
    assert.equal(fs.readFileSync(victim, "utf8"), "decoy-rc\n");
  } finally { s.done(); }
});

test("token store: quarantine reports each failed rename loudly and checks the moved inode with lstat", async (t) => {
  const { quarantineTokenStore } = await import("../dist/confine/seatbelt.js");
  for (const failure of ["EACCES", "identity"]) await t.test(failure, (t) => {
    const s = scratch();
    try {
      const { store, dir, victim } = decoyStore(s);
      for (const name of ["auth.json", "auth.json.lock"]) {
        fs.rmSync(path.join(dir, name), { force: true });
        fs.symlinkSync(victim, path.join(dir, name));
      }
      const rename = fs.renameSync.bind(fs);
      t.mock.method(fs, "renameSync", (from: string, to: string) => {
        if (failure === "EACCES") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        rename(from, to);
        fs.unlinkSync(to);
        fs.writeFileSync(to, "replacement");
      });
      const result = quarantineTokenStore(store, path.join(s.control, "quarantine", "turn"), "turn");
      for (const name of ["auth.json", "auth.json.lock"]) assert.ok(result.errors.some((e: string) => e.includes(name) && (failure === "EACCES" ? e.includes("EACCES") : e.includes("identity"))), JSON.stringify(result));
      assert.equal(result.errors.length, 2);
    } finally { s.done(); }
  });
});

test("token store: in its login directory a turn may save its login as Grok does (temp file, sync, chmod, rename, chmod) and take and rewrite its lock; links, directories, other names, subdirectories and other files' modes stay refused (D10, decoys)", { skip: !macOS && "macOS only" }, () => {
  const s = scratch();
  try {
    const { store, dir, victim } = decoyStore(s);
    const p = policy(s, { network: { mode: "on" }, state: { home: "real", tokenStore: store } });
    const auth = path.join(dir, "auth.json");
    const T = (n: number) => path.join(dir, `.4242.${n}.tmp`);
    const q = JSON.stringify;
    /** JavaScript that exchanges two names (renamex_np RENAME_SWAP, through osascript), throwing the errno's code. */
    const swap = (a: string, b: string) => `const r = require("child_process").spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", ${q(`ObjC.bindFunction("__error",["int *",[]]);ObjC.bindFunction("renamex_np",["int",["char *","char *","unsigned int"]]);var x=$.renamex_np(${q(a)},${q(b)},2);x===0?"0":String($.__error()[0])`)}], { encoding: "utf8" }); const o = r.stdout.trim(); if (o !== "0") throw Object.assign(new Error(o), { code: o === "1" ? "EPERM" : "errno " + o });`;
    const xattr = (f: string) => `const r = require("child_process").spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", ${q(`ObjC.bindFunction("__error",["int *",[]]);ObjC.bindFunction("setxattr",["int",["char *","char *","char *","long","unsigned int","int"]]);var x=$.setxattr(${q(f)},"com.relay.probe","v",1,0,1);x===0?"0":String($.__error()[0])`)}], { encoding: "utf8" }); const o = r.stdout.trim(); if (o !== "0") throw Object.assign(new Error(o), { code: o === "1" ? "EPERM" : "errno " + o });`;
    const t = (n: string) => path.join(s.tmp, n);
    const lock = path.join(dir, "auth.json.lock");
    /** Runs `code` in Node under the profile; "allowed" or the error code. */
    const run = (code: string) => {
      const l = seatbeltLaunch(p as never, process.execPath, ["-e", `const fs=require("fs");try{${code};console.log("allowed")}catch(e){console.log(e.code||e.message)}`]);
      const r = spawnSync(l.command, l.args, { cwd: s.wt, env: { PATH: "/usr/bin:/bin", ...l.env }, encoding: "utf8" });
      return r.stdout.trim() || r.stderr.trim().split("\n").pop();
    };
    const fresh = () => {
      for (const n of fs.readdirSync(s.tmp)) fs.rmSync(path.join(s.tmp, n), { recursive: true, force: true });
      if (!fs.lstatSync(path.join(dir, "sessions"), { throwIfNoEntry: false })?.isDirectory()) {
        fs.rmSync(path.join(dir, "sessions"), { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, "sessions"));
      }
      for (const n of fs.readdirSync(dir)) if (!["auth.json", "config.toml", "sessions"].includes(n)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
      if (!fs.lstatSync(path.join(dir, "config.toml"), { throwIfNoEntry: false })?.isFile()) fs.rmSync(path.join(dir, "config.toml"), { recursive: true, force: true });
      if (!fs.existsSync(path.join(dir, "config.toml"))) fs.writeFileSync(path.join(dir, "config.toml"), "decoy-config\n", { mode: 0o600 });
      for (const n of fs.readdirSync(path.join(dir, "sessions"))) fs.rmSync(path.join(dir, "sessions", n), { force: true });
      if (!fs.lstatSync(auth, { throwIfNoEntry: false })?.isFile()) fs.rmSync(auth, { recursive: true, force: true });
      if (!fs.existsSync(auth)) fs.writeFileSync(auth, "decoy-token\n", { mode: 0o600 });
      fs.chmodSync(auth, 0o600);
    };
    const allowed: Record<string, string> = {
      // Grok's save, exactly (grok-build 1.0.45 fs_atomic.rs; relay's Grok research): the
      // temp file made new with mode 600, written and synced, its mode set again, renamed over the token,
      // and the token made owner-only.
      refresh: `const fd = fs.openSync(${q(T(1))}, "wx", 0o600); fs.writeSync(fd, "refreshed\\n"); fs.fsyncSync(fd); fs.closeSync(fd); fs.chmodSync(${q(T(1))}, 0o600); fs.renameSync(${q(T(1))}, ${q(auth)}); fs.chmodSync(${q(auth)}, 0o600)`,
      // What Grok also does on every read of the token.
      "the token made owner-only": `fs.chmodSync(${q(auth)}, 0o600)`,
      "rewrite the token": `fs.appendFileSync(${q(auth)}, "x")`,
      // Grok's lock: made the first time, its holder line truncated and rewritten; never removed.
      "lock made and rewritten": `const fd = fs.openSync(${q(lock)}, "a+", 0o600); fs.ftruncateSync(fd, 0); fs.writeSync(fd, "1:2\\n"); fs.closeSync(fd)`,
      "an ordinary file of the turn's renamed onto a temp name": `fs.writeFileSync(${q(t("r"))}, "x"); fs.renameSync(${q(t("r"))}, ${q(T(11))})`,
      "a temp file renamed out to the turn's temp dir": `fs.writeFileSync(${q(T(12))}, "x"); fs.renameSync(${q(T(12))}, ${q(t("out"))})`,
      "control: an xattr in the turn's temp dir": `fs.writeFileSync(${q(t("xa"))}, "x"); ${xattr(t("xa"))}`,
      "control: an exchange in the turn's temp dir": `fs.writeFileSync(${q(t("x"))}, "x"); fs.writeFileSync(${q(t("y"))}, "y"); ${swap(t("x"), t("y"))}`,
      "a stale temp file removed": `fs.writeFileSync(${q(T(2))}, "x"); fs.unlinkSync(${q(T(2))})`,
      "control: a symbolic link in the turn's temp dir": `fs.symlinkSync(${q(victim)}, ${q(path.join(s.tmp, "ctl-link"))})`,
      "control: a hard link inside the worktree": `fs.writeFileSync(${q(path.join(s.wt, "ctl"))}, "x"); fs.linkSync(${q(path.join(s.wt, "ctl"))}, ${q(path.join(s.wt, "ctl2"))})`,
    };
    const refused: Record<string, string> = {
      "another name": `fs.writeFileSync(${q(path.join(dir, "other.txt"))}, "x")`,
      "the store's other files": `fs.appendFileSync(${q(path.join(dir, "config.toml"))}, "x")`,
      "a name like a temp name but not one": `fs.writeFileSync(${q(path.join(dir, ".4242.abc.tmp"))}, "x")`,
      "a symbolic link at a temp name": `fs.symlinkSync(${q(victim)}, ${q(T(3))})`,
      "a symbolic link made outside and renamed onto the token": `fs.symlinkSync(${q(victim)}, ${q(path.join(s.tmp, "l"))}); fs.renameSync(${q(path.join(s.tmp, "l"))}, ${q(auth)})`,
      "a hard link of an outside file at a temp name": `fs.linkSync(${q(victim)}, ${q(T(4))})`,
      "a hard link of a worktree file at a temp name": `fs.writeFileSync(${q(path.join(s.wt, "mine"))}, "x"); fs.linkSync(${q(path.join(s.wt, "mine"))}, ${q(T(5))})`,
      "a directory at a temp name": `fs.mkdirSync(${q(T(6))})`,
      "the token renamed away and a directory put in its place": `fs.renameSync(${q(auth)}, ${q(T(7))}); fs.mkdirSync(${q(auth)})`,
      "the token hard-linked out into the worktree": `fs.linkSync(${q(auth)}, ${q(path.join(s.wt, "tok"))})`,
      "the token hard-linked out into the turn's temp dir": `fs.linkSync(${q(auth)}, ${q(path.join(s.tmp, "tok"))})`,
      "a temp name inside a subdirectory of the store": `fs.writeFileSync(${q(path.join(dir, "sessions", ".4242.8.tmp"))}, "x")`,
      "the store's other file's mode": `fs.chmodSync(${q(path.join(dir, "config.toml"))}, 0o644)`,
      // Review r_75bf1f48 C2, X2, C6: other file types brought in, hard-link pairs, exchanges, renames, dots, xattrs.
      "a directory renamed in onto a temp name": `fs.mkdirSync(${q(t("d"))}); fs.renameSync(${q(t("d"))}, ${q(T(13))})`,
      "a FIFO renamed in onto a temp name": `require("child_process").execFileSync("/usr/bin/mkfifo", [${q(t("f"))}]); fs.renameSync(${q(t("f"))}, ${q(T(14))})`,
      "a FIFO made at a temp name": `try { require("child_process").execFileSync("/usr/bin/mkfifo", [${q(T(15))}], { stdio: "pipe" }) } catch (e) { throw Object.assign(e, { code: /Operation not permitted/.test(String(e.stderr)) ? "EPERM" : "other" }) }`,
      "one of a hard-link pair renamed onto a temp name": `fs.writeFileSync(${q(t("a"))}, "x"); fs.linkSync(${q(t("a"))}, ${q(t("b"))}); fs.renameSync(${q(t("b"))}, ${q(T(16))})`,
      "one of a hard-link pair renamed onto the token": `fs.writeFileSync(${q(t("a"))}, "x"); fs.linkSync(${q(t("a"))}, ${q(t("b"))}); fs.renameSync(${q(t("b"))}, ${q(auth)})`,
      "a symbolic link exchanged with the lock": `fs.writeFileSync(${q(lock)}, "1:2\\n"); fs.symlinkSync(${q(victim)}, ${q(t("l"))}); ${swap(t("l"), lock)}`,
      "a directory exchanged with the lock": `fs.writeFileSync(${q(lock)}, "1:2\\n"); fs.mkdirSync(${q(t("d"))}); ${swap(t("d"), lock)}`,
      "the lock removed": `fs.writeFileSync(${q(lock)}, "1:2\\n"); fs.unlinkSync(${q(lock)})`,
      "a directory exchanged with the store's subdirectory": `fs.mkdirSync(${q(t("d"))}); ${swap(t("d"), path.join(dir, "sessions"))}`,
      "a file exchanged with the store's other file": `fs.writeFileSync(${q(t("x"))}, "x"); ${swap(t("x"), path.join(dir, "config.toml"))}`,
      "an ordinary file of the turn's renamed onto another name": `fs.writeFileSync(${q(t("r"))}, "x"); fs.renameSync(${q(t("r"))}, ${q(path.join(dir, "other"))})`,
      "a temp file renamed onto another name": `fs.writeFileSync(${q(T(17))}, "x"); fs.renameSync(${q(T(17))}, ${q(path.join(dir, "other"))})`,
      "the token renamed onto another name": `fs.renameSync(${q(auth)}, ${q(path.join(dir, "other"))})`,
      "the store's other file renamed onto a temp name": `fs.renameSync(${q(path.join(dir, "config.toml"))}, ${q(T(18))})`,
      "a name the pattern's escaped dots do not match (x4242.1.tmp)": `fs.writeFileSync(${q(path.join(dir, "x4242.1.tmp"))}, "x")`,
      "a name the pattern's escaped dots do not match (.4242x1.tmp)": `fs.writeFileSync(${q(path.join(dir, ".4242x1.tmp"))}, "x")`,
      "an xattr on the token": xattr(auth),
      "an xattr on a temp file": `fs.writeFileSync(${q(T(19))}, "x"); ${xattr(T(19))}`,
      "the lock's mode": `fs.writeFileSync(${q(path.join(dir, "auth.json.lock"))}, "x"); fs.chmodSync(${q(path.join(dir, "auth.json.lock"))}, 0o644)`,
    };
    for (const [name, code] of Object.entries(allowed)) {
      fresh();
      assert.equal(run(code), "allowed", name);
    }
    assert.equal(fs.readFileSync(auth, "utf8"), "refreshed\nx", "the refresh replaced the token, then the rewrite reached the new one");
    for (const [name, code] of Object.entries(refused)) {
      fresh();
      assert.equal(run(code), "EPERM", name);
    }
    assert.equal(fs.readFileSync(victim, "utf8"), "decoy-rc\n", "nothing outside changed");
    // The measured limit (review r_75bf1f48): an exchange is checked as a create and an unlink at the
    // store's name, with the name's own file seen there, so a link or a directory can be exchanged onto
    // the token (which a rename onto it needs both for) or a temp name. The check relay runs after the
    // turn, and before the next, finds it.
    for (const [name, code] of [
      ["a symbolic link exchanged with the token", `fs.symlinkSync(${q(victim)}, ${q(t("l"))}); ${swap(t("l"), auth)}`],
      ["a directory exchanged with a temp file", `fs.writeFileSync(${q(T(20))}, "x"); fs.mkdirSync(${q(t("d"))}); ${swap(t("d"), T(20))}`],
    ]) {
      fresh();
      assert.equal(run(code), "allowed", name);
      assert.throws(() => seatbeltProfile(p as never), /symbolic link|not a regular file/, name);
    }
    fresh();
    const after = fs.lstatSync(auth);
    assert.ok(after.isFile() && after.nlink === 1 && (after.mode & 0o777) === 0o600, "the token is a regular file of one name, mode 600");
    assert.equal(fs.readFileSync(path.join(dir, "config.toml"), "utf8"), "decoy-config\n");
  } finally {
    s.done();
  }
});

test("token store: before every turn each name relay would make writable must be a regular file of one name, the person's own and not executable; the store a plain directory clear of every protected path; the grant of a reviewed form (D10; review r_64e5a9ce X1)", () => {
  const s = scratch();
  try {
    const { store, dir, victim } = decoyStore(s);
    const gen = (st: Record<string, unknown>, extra: Record<string, unknown> = {}) => () => seatbeltProfile(policy(s, { state: { home: "real", tokenStore: st }, ...extra }) as never);
    // The positive control: stale lock and temp files of the ordinary kind are left alone, and pass.
    fs.writeFileSync(path.join(dir, "auth.json.lock"), "pid 1\n", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, ".77.0.tmp"), "half\n", { mode: 0o600 });
    const ok = gen(store)();
    assert.ok(ok.params.some(([k, v]) => k === "TOKEN_STORE" && v === dir));
    assert.ok(ok.params.some(([k, v]) => k === "TOKEN_STORE_SUBDIR_0" && v === path.join(dir, "sessions")));
    assert.doesNotMatch(ok.profile, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no path in the profile");
    // An alias planted before the turn, at a lock or a temp name: the writes would reach the outside file.
    for (const name of ["auth.json.lock", ".77.0.tmp"]) {
      fs.rmSync(path.join(dir, name));
      fs.linkSync(victim, path.join(dir, name));
      assert.throws(gen(store), new RegExp(`${name.replace(/\./g, "\\.")} has 2 hard links`), name);
      fs.rmSync(path.join(dir, name));
      fs.symlinkSync(victim, path.join(dir, name));
      assert.throws(gen(store), /is a symbolic link/, name);
      fs.rmSync(path.join(dir, name));
      fs.mkdirSync(path.join(dir, name));
      assert.throws(gen(store), /is not a regular file/, name);
      fs.rmSync(path.join(dir, name), { recursive: true });
    }
    // On a volume where names differ only in case (the default on macOS), AUTH.json is what auth.json
    // reaches: a planted alias of either kind, under a name not exactly relay's, is refused (review
    // r_75bf1f48 C1, measured: writes through auth.json reached an outside file).
    const probeCase = path.join(s.home, "case-probe");
    fs.writeFileSync(probeCase, "");
    const caseless = fs.existsSync(path.join(s.home, "CASE-PROBE"));
    fs.rmSync(probeCase);
    if (caseless) {
      const token = fs.readFileSync(path.join(dir, "auth.json"));
      fs.rmSync(path.join(dir, "auth.json"));
      fs.linkSync(victim, path.join(dir, "AUTH.json"));
      assert.throws(gen(store), /AUTH\.json/, "a hard link under the name in other case");
      fs.rmSync(path.join(dir, "AUTH.json"));
      fs.symlinkSync(victim, path.join(dir, "Auth.Json"));
      assert.throws(gen(store), /Auth\.Json/, "a symbolic link under it");
      fs.rmSync(path.join(dir, "Auth.Json"));
      fs.writeFileSync(path.join(dir, "auth.json"), token, { mode: 0o600 });
      for (const alias of ["auth.json.LOCK", ".77.1.TMP"]) {
        fs.linkSync(victim, path.join(dir, alias));
        assert.throws(gen(store), new RegExp(alias.replace(/\./g, "\\.")), alias);
        fs.rmSync(path.join(dir, alias));
      }
    }
    fs.linkSync(path.join(dir, "auth.json"), path.join(s.outside, "second-name"));
    assert.throws(gen(store), /auth\.json has 2 hard links/);
    fs.rmSync(path.join(s.outside, "second-name"));
    fs.chmodSync(path.join(dir, "auth.json"), 0o700);
    assert.throws(gen(store), /auth\.json is executable/);
    fs.chmodSync(path.join(dir, "auth.json"), 0o600);
    // The store itself.
    fs.chmodSync(dir, 0o770);
    assert.throws(gen(store), /writable by others/);
    fs.chmodSync(dir, 0o700);
    fs.symlinkSync(dir, path.join(s.home, "grok-link"));
    assert.throws(gen({ ...store, dir: path.join(s.home, "grok-link") }), /not a plain directory/);
    assert.throws(gen({ ...store, dir: path.join(s.home, "missing") }), /missing/);
    // Clear of every path the profile writes or protects: its allows name operations a file-write* deny would not override.
    const inWt = path.join(s.wt, "store");
    fs.mkdirSync(inWt, { mode: 0o700 });
    fs.writeFileSync(path.join(inWt, "auth.json"), "x\n", { mode: 0o600 });
    assert.throws(gen({ ...store, dir: inWt }), /overlaps/);
    assert.throws(gen({ ...store, dir: s.root }), /overlaps/, "a store holding relay's control directory");
    // A read turn's worktree is not writable, so holding the store is no clash (a read job from the home folder).
    gen(store, { worktree: s.home, worktreeWritable: false })();
    // A store whose own name a temp name could match would let the store itself be removed.
    const odd = path.join(s.home, ".5.5.tmp");
    fs.mkdirSync(odd, { mode: 0o700 });
    assert.throws(gen({ ...store, dir: odd }), /the store's own name/);
    // The grant's form.
    for (const tempName of [String.raw`^x[--9]+$`, String.raw`^\.[0-9]\.tmp$`, "^.+$", String.raw`^a"b+$`, "^[0-9]+", "[0-9]+$", String.raw`^\d+$`, String.raw`^a/b+$`, String.raw`^auth\.json[0-9]*$`]) {
      assert.throws(gen({ ...store, tempName }), /tempName/, tempName);
    }
    for (const files of [[], ["../x"], ["a/b"], [""], ["."], ["auth.json", "auth.json"]]) assert.throws(gen({ ...store, files }), /files|twice|no file/, JSON.stringify(files));
    assert.throws(gen({ ...store, locks: ["auth.json"] }), /twice/);
    assert.throws(gen({ ...store, name: "two\nlines" }), /name/);
  } finally {
    s.done();
  }
});

test("seatbelt: relay's own installation and the Node it runs on are readable but never written, created or removed by a turn, whatever it may write (review r_0c11d860 X1)", { skip: !macOS && "macOS only" }, async () => {
  const { relayPackageRoot } = await import("../dist/core/protected-config.js");
  const root = canonical(relayPackageRoot());
  const node = canonical(process.execPath);
  const s = scratch();
  try {
    const { profile, params } = seatbeltProfile(policy(s, { writable: [s.outside] }));
    const values = params.filter(([k]) => k.startsWith("INSTALL_")).map(([, v]) => v);
    assert.ok(values.includes(root), `the package root is denied: ${JSON.stringify(values)}`);
    assert.ok(values.includes(node), "the Node binary is denied");
    const { gitExecutable } = await import("../dist/core/executables.js");
    const git = gitExecutable();
    if (git) assert.ok(values.some((v) => canonical(git) === v || within(canonical(git), v)), `the git relay runs is denied: ${git}`);
    assert.ok(profile.indexOf("(param \"INSTALL_0\")") > profile.lastIndexOf("(allow file-write*"), "after every allow");
    // A writable root inside the package would be silently unusable, and is a caller's mistake.
    const inside = path.join(root, "dist");
    assert.throws(() => seatbeltProfile(policy(s, { writable: [inside] })), /lies inside denied directory/);
    // A directory on relay's PATH, and every target CLI found on it, are denied too; one made writable is refused.
    const pathDir = path.join(s.root, "path-bin");
    fs.mkdirSync(pathDir);
    const saved = process.env.PATH;
    process.env.PATH = `${pathDir}:${saved}`;
    try {
      const withPath = seatbeltProfile(policy(s)).params.filter(([k]) => k.startsWith("INSTALL_")).map(([, v]) => v);
      assert.ok(withPath.includes(canonical(pathDir)), "a PATH directory is write-denied");
      const { findExecutable } = await import("../dist/core/executables.js");
      for (const cli of ["claude", "codex"]) {
        const found = findExecutable(cli);
        if (found) assert.ok(withPath.includes(canonical(found)) || withPath.some((v) => within(canonical(found), v)), `${cli} (${found}) is write-denied`);
      }
      assert.throws(() => seatbeltProfile(policy(s, { writable: [pathDir] })), /lies inside denied directory/);
    } finally { process.env.PATH = saved; }
    const probe = path.join(root, `.relay-x1-probe-${process.pid}`);
    const l = seatbeltLaunch(policy(s, { network: { mode: "on" } }), "/bin/sh", ["-c", [
      `cat ${JSON.stringify(path.join(root, "package.json"))} >/dev/null && echo read-ok`,
      `echo x > ${JSON.stringify(path.join(s.wt, "inside"))} && echo wt-ok`,
      `: >> ${JSON.stringify(path.join(root, "package.json"))} && echo PACKAGE-ESCAPED`,
      `echo x > ${JSON.stringify(probe)} && echo CREATE-ESCAPED`,
      `ln ${JSON.stringify(path.join(root, "package.json"))} ${JSON.stringify(path.join(s.wt, "linked"))} && echo LINK-ESCAPED`,
      "true",
    ].join("; ")]);
    const r = spawnSync(l.command, l.args, { cwd: s.wt, env: scratchEnv({ PATH: "/usr/bin:/bin", HOME: s.home, ...l.env }), encoding: "utf8" });
    try {
      assert.match(r.stdout, /read-ok/);
      assert.match(r.stdout, /wt-ok/);
      assert.doesNotMatch(r.stdout, /ESCAPED/, r.stdout);
    } finally { fs.rmSync(probe, { force: true }); }
  } finally {
    s.done();
  }
});

test("diagnostics: close() does not signal a denial stream's process group once its leader has exited and been reaped (its id may be another group's by then)", { skip: !macOS && "macOS only" }, async (t) => {
  const { execFileSync } = await import("node:child_process");
  const crypto = await import("node:crypto");
  const { streamSandboxDenials } = await import("../dist/confine/diagnostics.js");
  const tag = `relay-sandbox test-${crypto.randomBytes(6).toString("hex")}`;
  const s = streamSandboxDenials(tag, () => {});
  await s.ready;
  // The watchdog shell leads the stream's group: the group of the log stream carrying this tag.
  // Waited for, not asserted, so that where macOS refuses `log stream` (an account that is not an
  // administrator, as on the release-watch runner) this times out as the other denial-stream tests do.
  let line: string | undefined;
  await until(() => Boolean(line = execFileSync("/bin/ps", ["-axo", "pgid=,command="], { encoding: "utf8" }).split("\n").find((l) => l.includes("log stream") && l.includes(tag))), 5000, "the denial stream to be running");
  assert.ok(line);
  const pgid = Number(line.trim().split(/\s+/)[0]);
  assert.ok(pgid > 1);
  // The whole group exits (log stream failed, say), and Node reaps its leader: from then on the id is free for reuse.
  process.kill(-pgid, "SIGKILL");
  const gone = () => { try { process.kill(pgid, 0); return false; } catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH"; } };
  await until(gone, 15000, "the stream's leader to be gone and reaped");
  const signals: unknown[][] = [];
  const kill = t.mock.method(process, "kill", (...args: unknown[]) => { signals.push(args); throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }); });
  try { s.close(); } finally { kill.mock.restore(); }
  assert.deepEqual(signals.filter(([pid]) => Number(pid) < 0), [], "close() signalled a process group whose leader relay had already reaped");
});
