// Version probes run outside any sandbox, so they must not run where a project's configuration
// would be read: every `--version` relay runs happens in the file system's root, and Gemini's is
// told its folder is untrusted. The stand-in CLIs here record the directory they ran in and the
// trust variable they were given; no real CLI runs. The tests after those check what a read is kept for.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import "./helpers.ts";
import { installedVersion, probeVersion, setVersionClockForTests, VERSION_TTL_MS } from "../dist/backends/cli-version.js";
import { spawnFound } from "../dist/core/executables.js";
import { codexVersion } from "../dist/backends/codex-daybreak.js";
import { untested } from "../dist/backends/run.js";
import { withDefaults } from "../dist/core/config.js";
import { requireCli } from "../dist/install/common.js";

/**
 * A scratch HOME and a scratch repository holding Gemini configuration, made relay's working
 * directory as when the MCP server runs in the person's checkout. Both restored after.
 */
function box(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-version-probe-")));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const bins = path.join(root, "bins");
  for (const d of [home, path.join(repo, ".gemini"), bins]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, ".gemini", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(repo, ".gemini", ".env"), "GOOGLE_GEMINI_BASE_URL=https://example.invalid\n");
  const saved = { HOME: process.env.HOME, cwd: process.cwd() };
  process.env.HOME = home;
  process.chdir(repo);
  t.after(() => {
    process.chdir(saved.cwd);
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    fs.rmSync(root, { recursive: true, force: true });
  });
  /** A CLI that prints `version` and appends where it ran and its trust variable to <bin>.runs. */
  const stub = (name: string, version: string) => {
    const bin = path.join(bins, name);
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s|%s\\n' "$(pwd -P)" "\${GEMINI_CLI_TRUST_WORKSPACE-unset}" >> "${bin}.runs"\necho "${version}"\n`, { mode: 0o755 });
    return bin;
  };
  const runs = (bin: string) => fs.existsSync(`${bin}.runs`)
    ? fs.readFileSync(`${bin}.runs`, "utf8").split("\n").filter(Boolean).map((l) => { const [cwd, trust] = l.split("|"); return { cwd, trust }; })
    : [];
  return { home, repo, stub, runs };
}

const env = (extra: Record<string, string> = {}) => ({ PATH: "/usr/bin:/bin", ...extra });

test("version probe: every target's runs in the file system's root, not relay's working directory; Gemini's is told its folder is untrusted", (t) => {
  const b = box(t);
  assert.equal(fs.realpathSync(process.cwd()), b.repo, "relay is running in the repository");
  const gemini = b.stub("gemini", "0.64.0");
  // A trust the person's environment grants is overridden for the probe.
  assert.deepEqual(installedVersion("gemini", gemini, env({ GEMINI_CLI_TRUST_WORKSPACE: "true" })), [0, 64, 0]);
  assert.deepEqual(b.runs(gemini), [{ cwd: "/", trust: "false" }]);
  // Read once per binary path within the minute (the cache is unchanged).
  installedVersion("gemini", gemini, env());
  assert.equal(b.runs(gemini).length, 1);
  // Other targets: the same directory, their environment as given (no Gemini variable added).
  for (const target of ["claude", "codex", "copilot", "grok"] as const) {
    const bin = b.stub(target, "9.9.9");
    assert.deepEqual(installedVersion(target, bin, env()), [9, 9, 9], target);
    assert.deepEqual(b.runs(bin), [{ cwd: "/", trust: "unset" }], target);
  }
  // Nothing is made for a probe: the installer's promise that a missing CLI changes nothing holds.
  assert.equal((probeVersion("codex", path.join(b.home, "missing-codex"), env()).error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
  assert.deepEqual(fs.readdirSync(b.home), []);
});

test("version probe: the launch gate, Codex's Daybreak check and the installer's check all probe from the file system's root", { skip: process.platform !== "darwin" && "the gate reads versions on macOS only" }, (t) => {
  const b = box(t);
  const gemini = b.stub("gemini-gate", "0.64.0");
  const config = withDefaults({ targets: { gemini: { enabled: true, experimental: true, bin: gemini } } });
  assert.equal(untested("gemini", config, env()), null);
  assert.deepEqual(b.runs(gemini), [{ cwd: "/", trust: "false" }]);
  const codex = b.stub("codex-daybreak", "codex-cli 0.163.0");
  assert.deepEqual(codexVersion(codex, env()), [0, 163, 0]);
  assert.deepEqual(b.runs(codex), [{ cwd: "/", trust: "unset" }]);
  const claude = b.stub("claude-install", "2.1.303 (Claude Code)");
  assert.equal(requireCli("claude", claude), "2.1.303 (Claude Code)");
  assert.deepEqual(b.runs(claude), [{ cwd: "/", trust: "unset" }]);
  // A bin the config names relative to relay's working directory still means that file.
  const rel = b.stub("relative-gemini", "0.64.0");
  fs.copyFileSync(rel, path.join(b.repo, "gemini-local"));
  fs.chmodSync(path.join(b.repo, "gemini-local"), 0o755);
  assert.equal(probeVersion("gemini", "./gemini-local", env()).stdout.trim(), "0.64.0");
});

// A read is kept only for the executable a launch would run (review 2026-11-09, F8): the target,
// the launcher's absolute name (found as a launch finds it), the file it leads to and that file's
// metadata. The stand-ins below print a constant version and record each run; links are repointed
// and files replaced atomically, as an updater does. The clock is the module's test clock.
// The two limits are asserted as limits: a change after the last check (the last test here), and an
// unchanged wrapper (claude-temp-link.test.ts, where a turn meets it).

/** Stand-in CLIs in a scratch directory, each run recorded as `cwd|trust|version`, and a test clock. */
function fakes(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-version-identity-")));
  const log = path.join(root, "runs");
  fs.mkdirSync(log);
  let clock = 5_000_000;
  setVersionClockForTests(() => clock);
  t.after(() => {
    setVersionClockForTests(null);
    for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) fs.chmodSync(path.join(root, d.name), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  let n = 0;
  /** Where a stand-in's runs are recorded: one file per stand-in, named after its path under root. */
  const record = (file: string) => path.join(log, path.relative(root, path.resolve(root, file)).replaceAll("/", "_"));
  const script = (name: string, version: string | null, extra: string) =>
    `#!/bin/sh\nprintf '%s|%s|%s\\n' "$(pwd -P)" "\${GEMINI_CLI_TRUST_WORKSPACE-unset}" "${version ?? "unread"}" >> "${record(name)}"\n${extra}${version ? `echo "${version}"` : "exit 1"}\n`;
  /** Writes the stand-in `name` (a path under root), replacing any file there atomically (a new inode). */
  const cli = (name: string, version: string | null, extra = "") => {
    const at = path.join(root, name);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    const tmp = `${at}.new-${n++}`;
    fs.writeFileSync(tmp, script(name, version, extra), { mode: 0o755 });
    fs.renameSync(tmp, at);
    return at;
  };
  /** The runs of the stand-in at `file` (its path, or its name under root). */
  const runs = (file: string) => {
    const f = record(file);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { const [cwd, trust, version] = l.split("|"); return { cwd, trust, version }; }) : [];
  };
  /** Points `link` at `target` atomically: a new link renamed over the old one. */
  const repoint = (link: string, target: string) => {
    const tmp = `${link}.new-${n++}`;
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, link);
  };
  /** Shell that repoints `link` at `target` while the stand-in runs (an update during `--version`). */
  const repointing = (link: string, target: string, when = "") =>
    `${when ? `if [ -e "${when}" ]; then ` : ""}/bin/ln -s "${target}" "${link}.mid" && /bin/mv -f "${link}.mid" "${link}"${when ? "; fi" : ""}\n`;
  return { root, cli, runs, repoint, repointing, advance: (ms: number) => { clock += ms; } };
}

test("version identity: an unchanged launcher is read once, its checks share the read until the minute ends", (t) => {
  const f = fakes(t);
  const v1 = f.cli("claude-2.1.308", "2.1.308 (Claude Code)");
  const link = path.join(f.root, "claude");
  f.repoint(link, v1);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 308]);
  // The other checks of the turn, and turns queued behind it, within the minute.
  f.advance(1_000);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 308]);
  f.advance(VERSION_TTL_MS - 1_001);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 308]);
  assert.equal(f.runs(v1).length, 1, "one spawn");
  // Once the minute is over, read again.
  f.advance(1);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 308]);
  assert.equal(f.runs(v1).length, 2);
});

test("version identity: a launcher link repointed within the minute is read again", (t) => {
  const f = fakes(t);
  const v1 = f.cli("claude-2.1.308", "2.1.308 (Claude Code)");
  const v2 = f.cli("claude-2.1.309", "2.1.309 (Claude Code)");
  const link = path.join(f.root, "claude");
  f.repoint(link, v1);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 308]);
  f.advance(1_000);
  f.repoint(link, v2);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 309], "the file the link now leads to");
  assert.equal(f.runs(v2).length, 1);
  // Back to the first, still within its first read's minute: read again too (its entry was replaced).
  f.repoint(link, v1);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 308]);
  assert.equal(f.runs(v1).length, 2);
});

test("version identity: a file replaced at the same path, or rewritten in place, is read again", (t) => {
  const f = fakes(t);
  const bin = f.cli("claude", "2.1.308 (Claude Code)");
  const link = path.join(f.root, "claude-link");
  f.repoint(link, bin);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 308]);
  // Replaced by rename: same path, same real path, a new inode.
  const ino = fs.statSync(bin).ino;
  f.cli("claude", "2.1.309 (Claude Code)");
  assert.notEqual(fs.statSync(bin).ino, ino);
  // A whole-second mtime, so the fixture can put it back exactly.
  const second = 1_800_000_000;
  fs.utimesSync(bin, second, second);
  f.advance(1_000);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 309]);
  assert.equal(f.runs(bin).length, 2);

  // Rewritten in place (same inode). The fixture does not rely on the file system's timestamp
  // resolution: first a rewrite that changes the size, with the old mtime put back; then one of the
  // same size whose mtime is set ten seconds apart.
  const before = fs.statSync(bin);
  fs.writeFileSync(bin, fs.readFileSync(bin, "utf8").replaceAll("2.1.309", "2.1.310") + "# padding\n");
  fs.utimesSync(bin, second, second);
  const sized = fs.statSync(bin);
  assert.equal(sized.ino, before.ino);
  assert.notEqual(sized.size, before.size);
  assert.equal(sized.mtimeMs, before.mtimeMs);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 310]);
  fs.writeFileSync(bin, fs.readFileSync(bin, "utf8").replaceAll("2.1.310", "2.1.311"));
  fs.utimesSync(bin, second, second + 10);
  const timed = fs.statSync(bin);
  assert.equal(timed.ino, before.ino);
  assert.equal(timed.size, sized.size);
  assert.notEqual(timed.mtimeMs, sized.mtimeMs);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 311]);
  assert.equal(f.runs(bin).length, 4);
  // Unchanged since: kept.
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 311]);
  assert.equal(f.runs(bin).length, 4);
});

test("version identity: no read is shared across another PATH, working directory or target", (t) => {
  const f = fakes(t);
  // The same bare name, found on two PATHs.
  const a = f.cli("a/claude", "2.1.308 (Claude Code)");
  const b = f.cli("b/claude", "2.1.309 (Claude Code)");
  const onPath = (dir: string) => ({ PATH: `${path.join(f.root, dir)}:/usr/bin:/bin` });
  assert.deepEqual(installedVersion("claude", "claude", onPath("a")), [2, 1, 308]);
  assert.deepEqual(installedVersion("claude", "claude", onPath("b")), [2, 1, 309]);
  // A relative PATH entry is skipped, as at launch: not found, so no version.
  const saved = process.cwd();
  t.after(() => process.chdir(saved));
  process.chdir(f.root);
  assert.equal(installedVersion("claude", "claude", { PATH: "a:/usr/bin:/bin" }), null);
  // A configured relative path means that path from relay's working directory.
  process.chdir(path.join(f.root, "a"));
  assert.deepEqual(installedVersion("claude", "./claude", env()), [2, 1, 308]);
  process.chdir(path.join(f.root, "b"));
  assert.deepEqual(installedVersion("claude", "./claude", env()), [2, 1, 309]);
  process.chdir(saved);
  // One file, two targets (each probes as its target does): two reads, each then kept.
  const shared = f.cli("shared", "9.9.9");
  assert.deepEqual(installedVersion("claude", shared, env()), [9, 9, 9]);
  assert.deepEqual(installedVersion("codex", shared, env()), [9, 9, 9]);
  assert.deepEqual(installedVersion("claude", shared, env()), [9, 9, 9]);
  assert.equal(f.runs(shared).length, 2);
});

// The environment a probe runs with is part of what a read describes (review 2026-11-09, item
// I2): one unchanged launcher can report another version under another environment, a wrapper
// running a helper it finds later on PATH, or one choosing an installation by a variable.

test("version identity: the same launcher under another PATH is read again when what it runs is found later on that PATH", (t) => {
  const f = fakes(t);
  // One unchanged wrapper, first on both PATHs, running whichever helper each PATH finds after it.
  const wrapper = f.cli("shared/claude", "wrapper", `exec claude-helper "$@"\n`);
  const a = f.cli("helpers-a/claude-helper", "2.1.308 (Claude Code)");
  const b = f.cli("helpers-b/claude-helper", "2.1.309 (Claude Code)");
  const onPath = (helpers: string) => ({ PATH: `${path.dirname(wrapper)}:${path.join(f.root, helpers)}:/usr/bin:/bin` });
  assert.deepEqual(installedVersion("claude", "claude", onPath("helpers-a")), [2, 1, 308]);
  f.advance(1_000);
  assert.deepEqual(installedVersion("claude", "claude", onPath("helpers-b")), [2, 1, 309], "read under the new PATH, not the first PATH's read");
  assert.equal(f.runs(b).length, 1);
  // Unchanged since: kept.
  assert.deepEqual(installedVersion("claude", "claude", onPath("helpers-b")), [2, 1, 309]);
  assert.equal(f.runs(b).length, 1);
  // One entry for the launcher, replaced: the first PATH again, within its first read's minute, is read again.
  assert.deepEqual(installedVersion("claude", "claude", onPath("helpers-a")), [2, 1, 308]);
  assert.equal(f.runs(a).length, 2);
  assert.equal(f.runs(wrapper).length, 3);
});

test("version identity: the same launcher under another value of any variable is read again; the same environment shares its read", (t) => {
  const f = fakes(t);
  // A launcher that picks its installation by a variable, as a version manager does.
  const bin = f.cli("claude", "wrapper", `if [ "$FAKE_CLAUDE_CHANNEL" = next ]; then echo "2.1.309 (Claude Code)"; else echo "2.1.308 (Claude Code)"; fi\nexit 0\n`);
  assert.deepEqual(installedVersion("claude", bin, env()), [2, 1, 308]);
  f.advance(1_000);
  assert.deepEqual(installedVersion("claude", bin, env({ FAKE_CLAUDE_CHANNEL: "next" })), [2, 1, 309]);
  assert.equal(f.runs(bin).length, 2);
  // The same names and values, in another object and order: the same environment, so the same read.
  assert.deepEqual(installedVersion("claude", bin, { FAKE_CLAUDE_CHANNEL: "next", PATH: "/usr/bin:/bin" }), [2, 1, 309]);
  // A name whose value is unset is not in the environment a probe gets.
  assert.deepEqual(installedVersion("claude", bin, { ...env({ FAKE_CLAUDE_CHANNEL: "next" }), UNSET_HERE: undefined }), [2, 1, 309]);
  assert.equal(f.runs(bin).length, 2, "no regression for identical lookups");
});

test("version identity: a bare name that cannot be found drops its kept read, so once it is found again it is read again", (t) => {
  const f = fakes(t);
  // A wrapper found on PATH by its bare name, reporting what its installation says.
  const backing = path.join(f.root, "backing-version");
  fs.writeFileSync(backing, "2.1.308 (Claude Code)\n");
  const bin = f.cli("on-path/claude", "wrapper", `/bin/cat "${backing}"\nexit 0\n`);
  const searched = { PATH: `${path.dirname(bin)}:/usr/bin:/bin` };
  assert.deepEqual(installedVersion("claude", "claude", searched), [2, 1, 308]);
  // Its directory cannot be searched: the name is not found, so no version.
  fs.chmodSync(path.dirname(bin), 0o000);
  assert.equal(installedVersion("claude", "claude", searched), null);
  // Searchable again within the minute: read again, not served from before the failure.
  fs.chmodSync(path.dirname(bin), 0o755);
  assert.deepEqual(installedVersion("claude", "claude", searched), [2, 1, 308]);
  assert.equal(f.runs(bin).length, 2);
  // The same, with the installation updated while the name could not be found.
  fs.chmodSync(path.dirname(bin), 0o000);
  assert.equal(installedVersion("claude", "claude", searched), null);
  fs.writeFileSync(backing, "2.1.309 (Claude Code)\n");
  fs.chmodSync(path.dirname(bin), 0o755);
  assert.deepEqual(installedVersion("claude", "claude", searched), [2, 1, 309]);
  assert.equal(f.runs(bin).length, 3);
});

test("version identity: a missing, dangling or unreachable CLI has no version, never a kept one, and recovery is read at once", (t) => {
  const f = fakes(t);
  const v1 = f.cli("claude-2.1.308", "2.1.308 (Claude Code)");
  const link = path.join(f.root, "claude");
  f.repoint(link, v1);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 308]);
  // The file the link leads to is gone: no version, and nothing is run.
  fs.rmSync(v1);
  assert.equal(installedVersion("claude", link, env()), null);
  // Recovery within the minute: read at once.
  f.cli("claude-2.1.308", "2.1.308 (Claude Code)");
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 308]);
  assert.equal(f.runs(v1).length, 2);
  // A directory on the way that cannot be searched (no permission): no version, the kept one dropped.
  const locked = path.join(f.root, "locked");
  const inside = f.cli("locked/claude", "2.1.308 (Claude Code)");
  assert.deepEqual(installedVersion("claude", inside, env()), [2, 1, 308]);
  fs.chmodSync(locked, 0o000);
  assert.equal(installedVersion("claude", inside, env()), null);
  fs.chmodSync(locked, 0o755);
  assert.deepEqual(installedVersion("claude", inside, env()), [2, 1, 308]);
  assert.equal(f.runs(inside).length, 2, "read again after the failure, not served from before it");
  // A bare name on no PATH directory: no version.
  assert.equal(installedVersion("claude", "relay-no-such-cli", env()), null);
  // An unreadable version is not kept: once the same, unchanged file reports one, it is read.
  const flag = path.join(f.root, "ready");
  const gemini = f.cli("gemini", "0.64.0", `[ -e "${flag}" ] || exit 1\n`);
  assert.equal(installedVersion("gemini", gemini, env({ GEMINI_CLI_TRUST_WORKSPACE: "true" })), null);
  fs.writeFileSync(flag, "");
  assert.deepEqual(installedVersion("gemini", gemini, env({ GEMINI_CLI_TRUST_WORKSPACE: "true" })), [0, 64, 0]);
  // Both probes ran in the root, Gemini's told its folder is untrusted.
  assert.deepEqual(f.runs(gemini).map((r) => [r.cwd, r.trust]), [["/", "false"], ["/", "false"]]);
});

test("version identity: an update while `--version` runs is not kept under either executable", (t) => {
  const f = fakes(t);
  const link = path.join(f.root, "claude");
  // The first repoints the link to the second while it reports its own version.
  const v2 = f.cli("claude-2.1.309", "2.1.309 (Claude Code)");
  const v1 = f.cli("claude-2.1.308", "2.1.308 (Claude Code)", f.repointing(link, v2));
  f.repoint(link, v1);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 309], "read again, from the one now in place");
  assert.deepEqual([f.runs(v1).length, f.runs(v2).length], [1, 1]);
  // What is kept is the second's read, under the second's identity.
  f.advance(1_000);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 309]);
  assert.deepEqual([f.runs(v1).length, f.runs(v2).length], [1, 1]);
  // Two that keep swapping: no stable read, so no version, and nothing kept.
  const swap = path.join(f.root, "swapping");
  const flag = path.join(f.root, "keep-swapping");
  fs.writeFileSync(flag, "");
  const s2 = path.join(f.root, "swap-b");
  const s1 = f.cli("swap-a", "2.1.300 (Claude Code)", f.repointing(swap, s2, flag));
  f.cli("swap-b", "2.1.301 (Claude Code)", f.repointing(swap, s1, flag));
  f.repoint(swap, s1);
  assert.equal(installedVersion("claude", swap, env()), null);
  assert.deepEqual([f.runs(s1).length, f.runs(s2).length], [1, 1], "one retry, then refused");
  // Once it settles, it is read afresh: nothing from the unstable reads was kept.
  fs.rmSync(flag);
  assert.deepEqual(installedVersion("claude", swap, env()), [2, 1, 300]);
  assert.deepEqual([f.runs(s1).length, f.runs(s2).length], [2, 1]);
});

test("version identity, limit: a launcher changed after the last check runs a version that check did not read", (t) => {
  const f = fakes(t);
  const v1 = f.cli("claude-2.1.308", "2.1.308 (Claude Code)");
  const v2 = f.cli("claude-2.1.309", "2.1.309 (Claude Code)");
  const link = path.join(f.root, "claude");
  f.repoint(link, v1);
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 308], "the last check");
  f.repoint(link, v2);
  // The launch runs the link by name (executables.ts), so it runs what the link leads to now. A
  // limit: nothing binds the file the check read to the process the launch starts.
  const launched = spawnFound(link, ["--version"], { encoding: "utf8", cwd: "/", env: env() });
  assert.equal(launched.stdout.trim(), "2.1.309 (Claude Code)");
  // The next check sees the change.
  assert.deepEqual(installedVersion("claude", link, env()), [2, 1, 309]);
});
