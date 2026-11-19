// Claude's private temp under a long home: relay hands Claude its turn directory in ~/.rn through a
// short, checked link (docs/research/claude-temp-limit.md). Every link and directory these tests
// make is under their own scratch (a fresh /tmp/XXXXXX, kept short on purpose); none uses the real
// /Users/Shared link, and no real Claude runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { CLI, harness, hostVar, nonTempScratch } from "./helpers.ts";
import { CLAUDE_TEMP_LIMIT, claudeTempFits, nativeTempAlias, setNativeTempAliasParentForTests } from "../dist/confine/private-root.js";
import { CLAUDE_TEMP_LINK_VERIFIED_THROUGH, claudeTempPath, linkVersionProblem, nativeTemp } from "../dist/backends/native-temp.js";
import { setVersionClockForTests, VERSION_TTL_MS } from "../dist/backends/cli-version.js";
import { englishList, VERIFIED } from "../dist/targets/verified.js";
import { overlapsEntryAnyCase, withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun, getTurn, insertNode, insertTurn, updateTurn } from "../dist/core/db.js";
import { newInstance } from "../dist/core/caller.js";
import { sweepTemps, turnTempProblems } from "../dist/core/retention.js";
import { selectEnvironment } from "../dist/core/env-policy.js";
import { withTurnSecrets } from "../dist/core/secrets.js";
import { claudeBackend } from "../dist/backends/claude.js";
import { launchTurn, untested } from "../dist/backends/run.js";
import { targetDef } from "../dist/targets/index.js";
import type { TurnSpec } from "../dist/backends/types.js";

const UID = process.getuid?.() ?? 0;
const SUFFIX = `/claude-${UID}`;
const LONG_ACCOUNT = "a-account-name-well-over-fifteen-bytes";

/** A long home (over Claude's limit) and a short link parent, both scratch; HOME is restored after. */
function longHome(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-long-home-")));
  const home = path.join(root, LONG_ACCOUNT);
  fs.mkdirSync(home);
  // Unresolved on purpose: /tmp is root's link to private/tmp, which the ancestry check follows.
  const parent = fs.mkdtempSync("/tmp/");
  fs.chmodSync(parent, 0o700);
  const saved = process.env.HOME;
  process.env.HOME = home;
  setNativeTempAliasParentForTests(parent);
  t.after(() => {
    setNativeTempAliasParentForTests(null);
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const rn = path.join(home, ".rn");
  return { root, home, parent, rn, link: path.join(parent, `.rn-${UID}`) };
}

const handle = () => ({ pid: 0, pgid: 0, startedAt: null, done: Promise.resolve({ status: "ok" }), cancel: async () => {} }) as never;

/** Stand-in Claude binaries that report one version each (unread: exit 1) and log every run. */
const BINS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-versions-")));
process.on("exit", () => fs.rmSync(BINS, { recursive: true, force: true }));
const CEILING = CLAUDE_TEMP_LINK_VERIFIED_THROUGH.join(".");
// Versions past the ceiling, whatever it is now (targets/verified.ts), so raising it keeps these tests.
const past = (n: number) => [...CLAUDE_TEMP_LINK_VERIFIED_THROUGH.slice(0, 2), CLAUDE_TEMP_LINK_VERIFIED_THROUGH[2] + n].join(".");
const NEWER = past(1);
const NEWER2 = past(2);
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fakeClaude = (version: string | null): string => {
  const bin = path.join(BINS, `claude-${version ?? "unread"}`);
  if (!fs.existsSync(bin)) fs.writeFileSync(bin, `#!/bin/sh\necho run >> "${bin}.runs"\n${version ? `echo "${version} (Claude Code)"` : "exit 1"}\n`, { mode: 0o755 });
  return bin;
};
const runs = (bin: string) => fs.existsSync(`${bin}.runs`) ? fs.readFileSync(`${bin}.runs`, "utf8").split("\n").filter(Boolean).length : 0;
/** A native turn's spec: Claude Code at the verified ceiling unless a test says otherwise. */
const spec = (target = "claude", o: { version?: string | null; allowUntested?: boolean; extra?: Record<string, unknown> } = {}) => ({
  target: { id: target }, environment: { PATH: process.env.PATH },
  config: withDefaults({ allow_untested: o.allowUntested ?? false, targets: { claude: { bin: fakeClaude(o.version === undefined ? CEILING : o.version) } } }),
  ...o.extra,
}) as never;
const claudeSpec = spec();

test("Claude temp: the limit is 44 bytes of the path as given, with /claude-<uid>", () => {
  assert.equal(CLAUDE_TEMP_LIMIT, 44);
  const at = (n: number) => "/" + "a".repeat(n - 1);
  const room = CLAUDE_TEMP_LIMIT - Buffer.byteLength(SUFFIX);
  assert.equal(claudeTempFits(at(room)), true, "exactly 44 bytes fits");
  assert.equal(claudeTempFits(at(room + 1)), false, "45 bytes does not");
  // Bytes, not characters: one two-byte character in place of an ASCII one goes over.
  assert.equal(claudeTempFits(at(room - 1) + "é"), false);
  assert.equal(claudeTempFits(at(room - 2) + "é"), true);
  // The 1.0 layout: home/.rn/<six>/claude-<uid> fits for a home of up to 22 bytes at uid 501.
  const homeRoom = room - Buffer.byteLength("/.rn/Ab12Cd");
  assert.equal(claudeTempFits(path.join(at(homeRoom), ".rn", "Ab12Cd")), true);
  assert.equal(claudeTempFits(path.join(at(homeRoom + 1), ".rn", "Ab12Cd")), false);
});

test("Claude temp: a directory that fits is handed over as it is, with no link made", (t) => {
  const f = longHome(t);
  const dir = path.join(f.parent, "Ab12Cd");
  fs.mkdirSync(dir);
  assert.equal(claudeTempPath(dir, () => { throw new Error("the version is not asked when the directory fits"); }), dir);
  assert.deepEqual(fs.readdirSync(f.parent), ["Ab12Cd"], "nothing else was made");
});

test("Claude temp: a long home's Claude turn launches with a short private temp through a checked link to ~/.rn", async (t) => {
  const f = longHome(t);
  const seen: { dir: string; agentDir: string }[] = [];
  for (const target of ["claude", "claude", "codex"]) {
    const h = await nativeTemp(spec(target), async (dir, agentDir) => {
      seen.push({ dir, agentDir });
      assert.equal(path.dirname(dir), fs.realpathSync(f.rn), "the files stay in ~/.rn");
      assert.equal(claudeTempFits(dir), false, "the real path is too long for Claude");
      if (target === "codex") {
        assert.equal(agentDir, dir, "Codex has no such limit and keeps the real path");
        return handle();
      }
      assert.equal(agentDir, path.join(f.link, path.basename(dir)));
      assert.ok(Buffer.byteLength(agentDir + SUFFIX) <= CLAUDE_TEMP_LIMIT, agentDir);
      // What Claude does with it: mkdir -p, then open the last component without following links.
      fs.mkdirSync(agentDir + SUFFIX, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(agentDir + SUFFIX, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { assert.equal(fs.fstatSync(fd).uid, UID); } finally { fs.closeSync(fd); }
      fs.writeFileSync(path.join(agentDir, "made-through-the-link"), "x");
      assert.equal(fs.readFileSync(path.join(dir, "made-through-the-link"), "utf8"), "x");
      assert.equal(fs.realpathSync(agentDir), dir, "the sandbox's resolved path is the private directory");
      return handle();
    });
    await (h as { done: Promise<unknown> }).done;
  }
  assert.equal(seen.length, 3);
  assert.notEqual(seen[0].dir, seen[1].dir, "each turn has its own directory");
  for (const { dir } of seen) assert.equal(fs.existsSync(dir), false, "removed when its turn ends");
  assert.deepEqual(fs.readdirSync(f.rn), []);
  const st = fs.lstatSync(f.link);
  assert.ok(st.isSymbolicLink());
  assert.equal(st.uid, UID);
  assert.equal(fs.readlinkSync(f.link), fs.realpathSync(f.rn), "the link stays, and leads to ~/.rn");
});

test("Claude temp: the registry records the real directory, which doctor matches and the sweep removes", async (t) => {
  const f = longHome(t);
  closeDbForTests();
  const saved = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = path.join(f.root, "control");
  process.env.RELAY_CONFIG = path.join(f.root, "config.json");
  fs.mkdirSync(process.env.RELAY_HOME);
  t.after(() => {
    closeDbForTests();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const cfg = withDefaults({ allow_temp_home: true });
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
  const inst = newInstance({ kind: "root" }, f.root, "codex");
  const run = createRun(f.root, cfg, inst.token);
  const node = insertNode({ id: "j_0000temp", run_id: run, kind: "job", target: "claude", mode: "write", depth: 1, task: "temp", cwd: f.root, status: "running" });
  const turn = insertTurn(node.id, "test", "temp", "write", "running");
  let left = "";
  const rm = fs.rmSync;
  const h = await nativeTemp(spec("claude", { extra: { turnId: turn, markers: { nodeId: node.id } } }), async (dir, agentDir) => {
    assert.notEqual(agentDir, dir);
    const row = getTurn(turn)!;
    assert.equal(row.tmp_dir, dir, "the real path in ~/.rn, never the short name");
    assert.equal(row.tmp_ino, fs.lstatSync(dir).ino);
    assert.deepEqual(turnTempProblems(), [], "doctor matches the directory to its turn");
    left = dir;
    // A crash: the directory outlives its turn.
    t.mock.method(fs, "rmSync", (p: fs.PathLike, o?: fs.RmOptions) => String(p) === dir ? undefined : rm.call(fs, p, o));
    return handle();
  });
  await (h as { done: Promise<unknown> }).done;
  t.mock.restoreAll();
  assert.ok(fs.existsSync(left));
  updateTurn(turn, { status: "done" });
  const swept = await sweepTemps();
  assert.ok(swept.removed.includes(left), JSON.stringify(swept));
  assert.equal(fs.existsSync(left), false);
  assert.ok(fs.lstatSync(f.link).isSymbolicLink(), "the link is not swept");
});

test("Claude temp: refuses a short name another user made first, a non-link, or a link elsewhere, and leaves each alone", async (t) => {
  const f = longHome(t);
  const refused = async (pattern: RegExp) => {
    let started = false;
    await assert.rejects(nativeTemp(claudeSpec, async () => { started = true; return handle(); }), pattern);
    assert.equal(started, false);
    assert.deepEqual(fs.readdirSync(f.rn), [], "the turn's directory was removed");
  };

  // A directory where the link goes.
  fs.mkdirSync(f.link);
  await refused(/44-byte limit.*short link .* not a link/);
  assert.ok(fs.lstatSync(f.link).isDirectory(), "left alone");
  fs.rmdirSync(f.link);

  // A link of this user's to somewhere else.
  const elsewhere = fs.mkdtempSync(path.join(f.root, "elsewhere-"));
  fs.symlinkSync(elsewhere, f.link);
  await refused(/points to/);
  assert.equal(fs.readlinkSync(f.link), elsewhere, "left alone");
  fs.unlinkSync(f.link);

  // The right link, but another user's: no unprivileged test can make one, so lstat reports it so.
  fs.symlinkSync(fs.realpathSync(f.rn), f.link);
  const lstat = fs.lstatSync;
  const foreign = t.mock.method(fs, "lstatSync", function (this: unknown, p: fs.PathLike, o?: fs.StatSyncOptions) {
    const st = lstat.call(fs, p, o as never) as fs.Stats;
    return String(p) === f.link ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: UID + 1 }) : st;
  });
  await refused(new RegExp(`owned by uid ${UID + 1}, not this user`));
  foreign.mock.restore();
  assert.ok(lstat(f.link).isSymbolicLink(), "left alone");

  // With nothing wrong, the same link is used.
  const h = await nativeTemp(claudeSpec, async (_dir, agentDir) => { assert.ok(agentDir.startsWith(f.link + path.sep)); return handle(); });
  await (h as { done: Promise<unknown> }).done;
});

test("Claude temp: refuses a way to the link that others could change", async (t) => {
  const f = longHome(t);
  const refused = (pattern: RegExp) => assert.rejects(nativeTemp(claudeSpec, async () => handle()), pattern);

  // The link's directory writable by others: only sticky stops them replacing the link.
  fs.chmodSync(f.parent, 0o777);
  await refused(/can be written by other users and is not sticky/);
  assert.deepEqual(fs.readdirSync(f.parent), [], "nothing was made");
  fs.chmodSync(f.parent, 0o1777);
  const ok = await nativeTemp(claudeSpec, async () => handle());
  await (ok as { done: Promise<unknown> }).done;
  assert.ok(fs.lstatSync(f.link).isSymbolicLink(), "a sticky shared directory, like /Users/Shared, is accepted");
  fs.unlinkSync(f.link);
  fs.chmodSync(f.parent, 0o700);

  // Reached through a link of ours into an open directory: the target's directory is checked too.
  const open = path.join(f.parent, "o");
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o777);
  fs.symlinkSync(open, path.join(f.parent, "l"));
  setNativeTempAliasParentForTests(path.join(f.parent, "l"));
  await refused(new RegExp(`${open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} can be written by other users`));
  assert.deepEqual(fs.readdirSync(open), []);

  // `..` in a link's target is taken where the kernel takes it, after the link before it is
  // followed: rl -> bl/../real with bl -> a/b leads to a/real (open), not to real (private).
  fs.mkdirSync(path.join(f.parent, "a", "b"), { recursive: true });
  for (const [d, mode] of [["real", 0o700], ["a/real", 0o777]] as const) {
    fs.mkdirSync(path.join(f.parent, d));
    fs.chmodSync(path.join(f.parent, d), mode);
  }
  fs.symlinkSync("a/b", path.join(f.parent, "bl"));
  fs.symlinkSync("bl/../real", path.join(f.parent, "rl"));
  assert.equal(fs.realpathSync.native(path.join(f.parent, "rl")), fs.realpathSync.native(path.join(f.parent, "a", "real")), "the kernel's reading");
  setNativeTempAliasParentForTests(path.join(f.parent, "rl"));
  await refused(/\/a\/real can be written by other users and is not sticky/);
  assert.deepEqual(fs.readdirSync(path.join(f.parent, "a", "real")), []);
  assert.deepEqual(fs.readdirSync(path.join(f.parent, "real")), []);

  // A directory on the way owned by another user (reported so; see above).
  setNativeTempAliasParentForTests(f.parent);
  const lstat = fs.lstatSync;
  const real = fs.realpathSync(f.parent);
  t.mock.method(fs, "lstatSync", function (this: unknown, p: fs.PathLike, o?: fs.StatSyncOptions) {
    const st = lstat.call(fs, p, o as never) as fs.Stats;
    return String(p) === real ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: UID + 1 }) : st;
  });
  await refused(new RegExp(`owned by uid ${UID + 1}, neither root nor this user`));
  t.mock.restoreAll();
  assert.equal(fs.existsSync(f.link), false);
});

test("Claude temp: a short name that still would not fit is refused before anything is made", async (t) => {
  const f = longHome(t);
  const deep = path.join(f.parent, "x".repeat(12));
  fs.mkdirSync(deep);
  setNativeTempAliasParentForTests(deep);
  assert.ok(!claudeTempFits(path.join(nativeTempAlias(), "Ab12Cd")));
  await assert.rejects(nativeTemp(claudeSpec, async () => handle()), /44-byte limit.*, even through relay's short link/);
  assert.deepEqual(fs.readdirSync(deep), []);
  assert.deepEqual(fs.readdirSync(f.rn), []);
});

test("Claude temp: the link is used only with a Claude Code whose temp code relay has read, unless allow_untested", async (t) => {
  const f = longHome(t);
  assert.deepEqual(CLAUDE_TEMP_LINK_VERIFIED_THROUGH, VERIFIED.claudeTempLink.at(-1)!.split(".").map(Number), "the ceiling is the newest version read");
  const newer = NEWER;
  const refused = async (s: never, pattern: RegExp) => {
    await assert.rejects(nativeTemp(s, async () => handle()), pattern);
    assert.deepEqual(fs.readdirSync(f.parent), [], "no link is made for it");
    assert.deepEqual(fs.readdirSync(f.rn), []);
  };
  await refused(spec("claude", { version: newer }), new RegExp(`44-byte limit.*does not use its short link.*Claude Code ${newer.replace(/\./g, "\\.")}, newer than ${CEILING.replace(/\./g, "\\.")}, the newest version whose temporary-directory code relay has read\\. This is the check on relay's long-home workaround.*Pin Claude Code to ${CEILING.replace(/\./g, "\\.")} or older.*"allow_untested": true`));
  await refused(spec("claude", { version: null }), /relay could not read a version from `.*claude-unread --version`.*long-home workaround/);
  assert.equal(runs(fakeClaude(newer)), 1, "the version is read once per binary and then cached");
  await refused(spec("claude", { version: newer }), /newer than/);
  assert.equal(runs(fakeClaude(newer)), 1);
  // allow_untested lets a newer one through, unverified, without reading its version.
  const allowed = fakeClaude(NEWER2);
  // The ceiling and every other version read (the oldest is relay's floor).
  for (const s of [spec("claude", { version: NEWER2, allowUntested: true }), spec("claude", { version: CEILING }), ...VERIFIED.claudeTempLink.map((version: string) => spec("claude", { version }))]) {
    const h = await nativeTemp(s, async (_dir, agentDir) => { assert.ok(agentDir.startsWith(f.link + path.sep), agentDir); return handle(); });
    await (h as { done: Promise<unknown> }).done;
  }
  assert.equal(runs(allowed), 0);
  for (const v of VERIFIED.claudeTempLink) assert.equal(linkVersionProblem(v.split(".").map(Number), "claude", false), null, v);
  assert.match(linkVersionProblem(NEWER.split(".").map(Number), "claude", false)!, new RegExp(`Claude Code ${reEsc(NEWER)}, newer than ${reEsc(CEILING)}, .*as ${reEsc(englishList(VERIFIED.claudeTempLink))} do\\. .*Pin Claude Code to ${reEsc(CEILING)} or older`));
  assert.equal(linkVersionProblem([2, 2, 0], "claude", true), null);
  assert.match(linkVersionProblem([3, 0, 0], "claude", false)!, new RegExp(`Claude Code 3\\.0\\.0, newer than ${reEsc(CEILING)}`));
});

/**
 * Claude Code's own layout in scratch: version-named files and a launcher link into them, repointed
 * atomically (a new link renamed over the old) when it updates itself; each file logs its runs.
 */
function claudeLauncher(t: TestContext, ...versions: string[]) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-launcher-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = Object.fromEntries(versions.map((v) => {
    const bin = path.join(dir, v);
    fs.writeFileSync(bin, `#!/bin/sh\necho run >> "${bin}.runs"\necho "${v} (Claude Code)"\n`, { mode: 0o755 });
    return [v, bin];
  }));
  const launcher = path.join(dir, "claude");
  const repoint = (v: string) => { fs.symlinkSync(files[v], `${launcher}.new`); fs.renameSync(`${launcher}.new`, launcher); };
  repoint(versions[0]);
  const config = (allowUntested = false) => withDefaults({ allow_untested: allowUntested, targets: { claude: { bin: launcher } } });
  const s = (allowUntested = false) => ({ target: { id: "claude" }, environment: { PATH: process.env.PATH }, config: config(allowUntested) }) as never;
  return { files, launcher, repoint, config, s };
}

test("Claude temp: an unchanged launcher's version is read once for the link check, a check with the same environment and the turns of the minute", async (t) => {
  const f = longHome(t);
  let clock = 2_000_000;
  setVersionClockForTests(() => clock);
  t.after(() => setVersionClockForTests(null));
  const c = claudeLauncher(t, CEILING);
  const turn = async () => {
    const h = await nativeTemp(c.s(), async (_dir, agentDir) => { assert.ok(agentDir.startsWith(f.link + path.sep), agentDir); return handle(); });
    await (h as { done: Promise<unknown> }).done;
    // The version gate's floor (run.ts untested) reads the same entry when given the same
    // environment, as here. A real launch gives it Claude's own environment, read on its own
    // (the launch-environment test below).
    if (process.platform === "darwin") assert.equal(untested("claude", c.config(), { PATH: process.env.PATH }), null);
  };
  await turn();
  assert.equal(runs(c.files[CEILING]), 1, "the link check and a check with the same environment share one read");
  // Turns queued behind it, within the minute.
  clock += VERSION_TTL_MS / 2;
  await turn();
  clock += VERSION_TTL_MS / 2 - 1;
  await turn();
  assert.equal(runs(c.files[CEILING]), 1);
  // Once the minute is over, read again.
  clock += 1;
  await turn();
  assert.equal(runs(c.files[CEILING]), 2);
});

test("Claude temp: a launcher repointed past the ceiling within the minute is refused before the turn starts, unless allow_untested", async (t) => {
  const f = longHome(t);
  let clock = 3_000_000;
  setVersionClockForTests(() => clock);
  t.after(() => setVersionClockForTests(null));
  const c = claudeLauncher(t, CEILING, NEWER);
  const h = await nativeTemp(c.s(), async (_dir, agentDir) => { assert.ok(agentDir.startsWith(f.link + path.sep), agentDir); return handle(); });
  await (h as { done: Promise<unknown> }).done;
  assert.equal(runs(c.files[CEILING]), 1);
  // Claude Code updates itself between two queued turns, a second apart.
  clock += 1_000;
  c.repoint(NEWER);
  let started = false;
  await assert.rejects(nativeTemp(c.s(), async () => { started = true; return handle(); }),
    new RegExp(`does not use its short link.*Claude Code ${reEsc(NEWER)}, newer than ${reEsc(CEILING)}.*long-home workaround`));
  assert.equal(started, false, "nothing of the turn ran");
  assert.equal(runs(c.files[NEWER]), 1, "the new file's version was read");
  assert.deepEqual(fs.readdirSync(f.rn), []);
  // allow_untested remains the explicit waiver: the turn goes ahead through the link, unverified.
  const waived = await nativeTemp(c.s(true), async (_dir, agentDir) => { assert.ok(agentDir.startsWith(f.link + path.sep), agentDir); return handle(); });
  await (waived as { done: Promise<unknown> }).done;
  if (process.platform === "darwin") assert.equal(untested("claude", c.config(true), { PATH: process.env.PATH }), null);
  assert.equal(runs(c.files[NEWER]), 1, "without reading the version again");
});

test("Claude temp: the same launcher under another PATH, running a newer Claude found later on it, is refused by the ceiling within the minute", async (t) => {
  const f = longHome(t);
  let clock = 4_000_000;
  setVersionClockForTests(() => clock);
  t.after(() => setVersionClockForTests(null));
  // One unchanged wrapper, first on both PATHs, running the helper each PATH finds after it.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-dispatch-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shared = path.join(dir, "shared");
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, "claude"), `#!/bin/sh\nexec claude-helper "$@"\n`, { mode: 0o755 });
  const helper = (name: string, version: string) => {
    fs.mkdirSync(path.join(dir, name));
    const bin = path.join(dir, name, "claude-helper");
    fs.writeFileSync(bin, `#!/bin/sh\necho run >> "${bin}.runs"\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
    return bin;
  };
  const a = helper("a", CEILING);
  const b = helper("b", NEWER);
  const s = (helpers: string) => ({
    target: { id: "claude" }, environment: { PATH: `${shared}:${path.join(dir, helpers)}:/usr/bin:/bin` },
    config: withDefaults({ targets: { claude: { bin: "claude" } } }),
  }) as never;
  const h = await nativeTemp(s("a"), async (_dir, agentDir) => { assert.ok(agentDir.startsWith(f.link + path.sep), agentDir); return handle(); });
  await (h as { done: Promise<unknown> }).done;
  assert.equal(runs(a), 1);
  clock += 1_000;
  let started = false;
  await assert.rejects(nativeTemp(s("b"), async () => { started = true; return handle(); }),
    new RegExp(`does not use its short link.*Claude Code ${reEsc(NEWER)}, newer than ${reEsc(CEILING)}.*long-home workaround`));
  assert.equal(started, false, "nothing of the turn ran");
  assert.equal(runs(b), 1, "read under the turn's PATH, not the earlier PATH's read");
  assert.deepEqual(fs.readdirSync(f.rn), []);
});

/**
 * A backend that does what Claude's does with its environments (claude.ts): the version gate and
 * the link are checked in nativeTemp with the turn's selected environment; Claude's own environment
 * then names the private temp (TMPDIR, CLAUDE_CODE_TMPDIR) and is checked twice, in preparation and
 * immediately before the spawn. `started` says the process would have been spawned.
 */
const claudeLike = (seen: { started: boolean }) => ({
  start: (s: TurnSpec) => nativeTemp(s, async (_dir, agentDir) => {
    const env = { ...s.environment, TMPDIR: agentDir, CLAUDE_CODE_TMPDIR: agentDir };
    s.checkEnvironment!(env);
    s.checkEnvironment!(env);
    seen.started = true;
    return handle();
  }),
});

test("Claude temp: a turn's launch is checked against the environment Claude runs with, the ceiling with the gate, sharing that read", { skip: process.platform !== "darwin" && "the gate reads versions on macOS only" }, async (t) => {
  const f = longHome(t);
  let clock = 6_000_000;
  setVersionClockForTests(() => clock);
  t.after(() => setVersionClockForTests(null));
  // A launcher that reports a newer Claude only with the environment relay launches Claude with,
  // which names its private temp: the selected environment's read does not describe that launch.
  const bin = path.join(BINS, "claude-by-launch-env");
  fs.writeFileSync(bin, `#!/bin/sh\necho run >> "${bin}.runs"\nif [ -n "$CLAUDE_CODE_TMPDIR" ]; then echo "${NEWER} (Claude Code)"; else echo "${CEILING} (Claude Code)"; fi\n`, { mode: 0o755 });
  const s = (b: string, allowUntested = false) => ({
    target: { id: "claude" }, environment: { PATH: process.env.PATH }, access: "read",
    config: withDefaults({ allow_untested: allowUntested, targets: { claude: { bin: b } } }),
  }) as never;
  const seen = { started: false };
  await assert.rejects(launchTurn(targetDef("claude"), s(bin), claudeLike(seen) as never),
    new RegExp(`Claude Code ${reEsc(NEWER)}, newer than ${reEsc(CEILING)}.*long-home workaround`));
  assert.equal(seen.started, false, "refused before the spawn");
  assert.equal(runs(bin), 2, "the selected environment's read, then the launch environment's");
  // allow_untested remains the waiver.
  const waived = await launchTurn(targetDef("claude"), s(bin, true), claudeLike(seen) as never);
  await (waived as { done: Promise<unknown> }).done;
  assert.equal(seen.started, true);

  // An unchanged launcher reporting one version: the gate and the ceiling, at both launch checks,
  // share the launch environment's read. The link check before the link is made reads with the
  // selected environment, so a turn reads twice; each turn's environment names its own temp, so
  // turns within the minute read again (one entry per launcher, replaced).
  const c = claudeLauncher(t, CEILING);
  const turn = async () => {
    const done = { started: false };
    const h = await launchTurn(targetDef("claude"), s(c.launcher), claudeLike(done) as never);
    await (h as { done: Promise<unknown> }).done;
    assert.equal(done.started, true);
  };
  await turn();
  assert.equal(runs(c.files[CEILING]), 2);
  clock += 1_000;
  await turn();
  assert.equal(runs(c.files[CEILING]), 4);
});

test("Claude temp, limit: an unchanged wrapper whose installation changes keeps its version read until the minute ends", async (t) => {
  const f = longHome(t);
  let clock = 1_000_000;
  setVersionClockForTests(() => clock);
  t.after(() => setVersionClockForTests(null));
  // A documented limit (cli-version.ts), not a guarantee: a wrapper script whose own file never
  // changes, running whatever installation its data names. Relay sees the same executable, so only
  // the minute catches the change. A repointed launcher or a replaced file is read again at once
  // (the tests before this one, and cli-version.test.ts).
  const reports = path.join(BINS, "updating-version");
  const bin = path.join(BINS, "claude-updating");
  fs.writeFileSync(reports, `${CEILING} (Claude Code)\n`);
  fs.writeFileSync(bin, `#!/bin/sh\necho run >> "${bin}.runs"\ncat "${reports}"\n`, { mode: 0o755 });
  const s = { target: { id: "claude" }, environment: { PATH: process.env.PATH }, config: withDefaults({ targets: { claude: { bin } } }) } as never;
  const turn = async () => {
    const h = await nativeTemp(s, async (_dir, agentDir) => { assert.ok(agentDir.startsWith(f.link + path.sep)); return handle(); });
    await (h as { done: Promise<unknown> }).done;
  };
  await turn();
  assert.equal(runs(bin), 1);
  fs.writeFileSync(reports, `${NEWER} (Claude Code)\n`);
  // Within the entry's minute, the wrapper's old read stands.
  clock += VERSION_TTL_MS - 1;
  await turn();
  assert.equal(runs(bin), 1, "the same read, not a second spawn");
  // A turn after that reads the version again and meets the ceiling.
  clock += 1;
  await assert.rejects(nativeTemp(s, async () => handle()), new RegExp(`Claude Code ${reEsc(NEWER)}, newer than ${reEsc(CEILING)}.*long-home workaround`));
  assert.equal(runs(bin), 2);
  assert.deepEqual(fs.readdirSync(f.rn), []);
});

test("Claude temp: a short home ignores the ceiling and never reads the version", async (t) => {
  const home = fs.mkdtempSync("/tmp/");
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; fs.rmSync(home, { recursive: true, force: true }); });
  const bin = fakeClaude("9.9.9");
  const h = await nativeTemp(spec("claude", { version: "9.9.9" }), async (dir, agentDir) => {
    assert.equal(agentDir, dir, "the real path fits");
    assert.ok(claudeTempFits(dir));
    return handle();
  });
  await (h as { done: Promise<unknown> }).done;
  assert.equal(runs(bin), 0);
});

test("Claude temp: grants over the short link, its directory or anything through it are refused", async () => {
  const parent = nonTempScratch("relay-link-parent-");
  const link = path.join(parent, `.rn-${UID}`);
  // Before the link exists, names under it are caught by the link's own name.
  for (const p of [parent, link, path.join(link, "Ab12Cd"), path.dirname(parent), "/"]) assert.equal(overlapsEntryAnyCase(p, link), true, p);
  if (process.platform === "darwin") assert.equal(overlapsEntryAnyCase(parent.toUpperCase(), link), true, "in another case");
  for (const p of [path.join(parent, "sibling"), path.join(parent, `.rn-${UID}0`)]) assert.equal(overlapsEntryAnyCase(p, link), false, p);
  // Through relay's own grant check, in a root server whose link directory is this scratch one.
  const preload = `--import=${pathToFileURL(path.join(import.meta.dirname, "fixtures", "link-parent.mjs")).href}`;
  const h = await harness([], {}, { NODE_OPTIONS: preload, STUB_LINK_PARENT: parent });
  try {
    const grant = (p: string) => h.call("delegate", { target: "codex", mode: "write", task: "no", grant: { write_paths: [p] } });
    const r = await grant(parent);
    assert.equal(r.refused, true, JSON.stringify(r));
    assert.match(r.reason, /short link to native turns' private temporary state/);
    // Once the link exists, a path through it resolves into ~/.rn: the link's own-name check no
    // longer sees it (by design), and the grant check's ~/.rn rule refuses it instead.
    const rn = path.join(fs.realpathSync(h.env.HOME), ".rn");
    fs.mkdirSync(path.join(rn, "Ab12Cd"), { recursive: true, mode: 0o700 });
    fs.symlinkSync(rn, link);
    assert.equal(overlapsEntryAnyCase(path.join(link, "Ab12Cd"), link), false);
    for (const p of [link, path.join(link, "Ab12Cd")]) {
      const through = await grant(p);
      assert.equal(through.refused, true, JSON.stringify(through));
      assert.match(through.reason, new RegExp(`overlaps native turns' private temporary state \\(${rn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`), p);
    }
  } finally { await h.close(); }
});

test("Claude temp: under a long home the Claude backend gives Claude the short name and its sandbox the real directory", async (t) => {
  const f = longHome(t);
  const cwd = path.join(f.root, "work");
  fs.mkdirSync(cwd);
  const savedRelay = process.env.RELAY_HOME;
  process.env.RELAY_HOME = path.join(f.root, "control");
  fs.mkdirSync(process.env.RELAY_HOME);
  t.after(() => { if (savedRelay === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = savedRelay; });
  // A stand-in CLI: records what it was given and what its TMPDIR leads to, then plays the stub agent.
  const captures = path.join(f.root, "records.jsonl");
  const bin = path.join(f.root, "claude");
  const stubs = path.resolve(import.meta.dirname, "stubs");
  const href = (file: string) => JSON.stringify(pathToFileURL(path.join(stubs, file)).href);
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from 'node:fs';
const argv=process.argv.slice(2);
const settings=argv.includes('--settings') ? JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings')+1],'utf8')) : undefined;
const t=process.env.CLAUDE_CODE_TMPDIR;
let real=null; if (t) { fs.writeFileSync(t+'/made-by-claude','x'); real=fs.realpathSync(t); }
fs.appendFileSync(${JSON.stringify(captures)}, JSON.stringify({argv,env:{TMPDIR:process.env.TMPDIR,CLAUDE_CODE_TMPDIR:t},real,settings})+'\\n');
process.env.STUB_DIR=${JSON.stringify(f.root)};
const {main}=await import(${href("stub-agent.mjs")});
const {default:target}=await import(${href("targets/claude.mjs")});
await main(target);
`, { mode: 0o755 });
  const config = withDefaults({ allow_untested: process.platform !== "darwin", targets: { claude: { bin } } });
  const selected = selectEnvironment("claude", config, { PATH: process.env.PATH, LANG: "C", HOME: f.home, CLAUDE_CONFIG_DIR: path.join(f.home, ".claude") }, []);
  for (const access of ["write", "read"] as const) {
    const spec = {
      target: targetDef("claude"), prompt: "temp", cwd, access, relay: null, dir: f.root, logPath: path.join(f.root, `${access}.log`),
      config, markers: { runId: "synthetic-run", nodeId: "synthetic-node", depth: 1 },
      environment: selected.env, environmentReleased: selected.releasedNames, grant: { network: false, env: [] },
    } as TurnSpec;
    const result = await withTurnSecrets(async () => (await launchTurn(targetDef("claude"), spec, claudeBackend)).done);
    assert.equal(result.status, "ok", `${result.error ?? ""}\n${fs.readFileSync(spec.logPath, "utf8")}`);
  }
  const records = fs.readFileSync(captures, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.argv.includes("-p"));
  assert.equal(records.length, 2);
  for (const r of records) {
    const short = r.env.CLAUDE_CODE_TMPDIR as string;
    assert.ok(short.startsWith(f.link + path.sep), short);
    assert.ok(Buffer.byteLength(short + SUFFIX) <= CLAUDE_TEMP_LIMIT, short);
    assert.equal(r.env.TMPDIR, short);
    assert.equal(r.settings.env.TMPDIR, short);
    assert.equal(r.settings.env.CLAUDE_CODE_TMPDIR, short);
    assert.equal(path.dirname(r.real), fs.realpathSync(f.rn), "the short name leads to the turn's directory in ~/.rn");
    assert.ok(r.settings.sandbox.filesystem.allowWrite.includes(r.real), "the sandbox is given the real directory");
    assert.ok(!r.settings.sandbox.filesystem.allowWrite.some((p: string) => p.startsWith(f.parent)), "and not the link");
  }
  assert.deepEqual(fs.readdirSync(f.rn), [], "every private turn temp was removed");
});

/** `relay doctor` in a scratch home (long unless `short`), with the stand-in Claude CLI install tests use. */
function doctorBox(t: TestContext, short = false) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-link-doctor-")));
  const home = short ? fs.mkdtempSync("/tmp/") : path.join(tmp, LONG_ACCOUNT);
  const parent = fs.mkdtempSync("/tmp/");
  const [bin, fake, temp] = ["bin", "fake", "temp"].map((d) => path.join(tmp, d));
  for (const d of [home, bin, fake, temp]) fs.mkdirSync(d, { recursive: true });
  t.after(() => { for (const d of [tmp, parent, home]) fs.rmSync(d, { recursive: true, force: true }); });
  const stub = path.resolve(import.meta.dirname, "stubs", "fake-host-cli.mjs");
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${stub}" claude "$@"\n`, { mode: 0o755 });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !hostVar(k) && !/^(RELAY_|CODEX_|CLAUDE|FAKE_|XDG_|NODE_OPTIONS)/.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: fake, TMPDIR: temp,
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(import.meta.dirname, "fixtures", "link-parent.mjs")).href}`, STUB_LINK_PARENT: parent,
  });
  const rn = path.join(fs.realpathSync(home), ".rn");
  const config = (c: Record<string, unknown>) => {
    fs.mkdirSync(path.join(home, ".config", "relay"), { recursive: true });
    // Doctor reads versions with a launch's selected environment: disclose the fake's controls only.
    fs.writeFileSync(path.join(home, ".config", "relay", "config.json"), JSON.stringify({ targets: { codex: { enabled: false } }, child_env: { pass: ["FAKE_DIR", "FAKE_CLAUDE_VERSION"] }, ...c }));
  };
  config({});
  const run = (extra: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [CLI, "doctor"], { env: { ...env, ...extra }, cwd: tmp, encoding: "utf8" });
    return r.stdout;
  };
  const probe = () => {
    const file = path.join(fake, "claude-probe.json");
    const p = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    fs.rmSync(file, { force: true });
    return p;
  };
  return { home, parent, rn, link: path.join(parent, `.rn-${UID}`), run, probe, config };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("Claude temp: doctor reports the long-home link, making nothing, and runs its init probe through it", (t) => {
  const d = doctorBox(t);
  const ceiling = `checked against Claude Code through ${esc(CEILING)}`;
  // Not there yet: said plainly, the probe not run, and nothing made.
  let out = d.run();
  assert.match(out, new RegExp(`claude temp\\s+${esc(d.rn)} is too long for Claude's 44-byte temporary-directory limit, so Claude gets its private temp through relay's short link ${esc(d.link)}: not there yet; relay makes it on the first Claude turn; ${ceiling}`));
  assert.match(out, /claude init\s+not run: .*doctor never makes the link/);
  assert.equal(d.probe(), null);
  assert.deepEqual(fs.readdirSync(d.parent), []);
  // In place: the probe runs with its private temp named through the link.
  fs.mkdirSync(d.rn, { mode: 0o700, recursive: true });
  fs.symlinkSync(d.rn, d.link);
  out = d.run();
  assert.match(out, new RegExp(`claude temp\\s+.*${esc(d.link)}: in place, yours and leading there; ${ceiling}`));
  assert.match(out, /claude init\s+isolated skills and plugins checked/);
  const p = d.probe();
  const tmp = p.settings.env.CLAUDE_CODE_TMPDIR as string;
  assert.ok(tmp.startsWith(d.link + path.sep) && claudeTempFits(tmp), tmp);
  assert.equal(path.dirname(p.cwd), d.rn, "the probe's directory is in ~/.rn");
  assert.deepEqual(fs.readdirSync(d.rn), [], "and removed after");
  // A newer Claude Code: refused, with the ceiling, and the probe not run.
  out = d.run({ FAKE_CLAUDE_VERSION: `${NEWER} (Claude Code)` });
  assert.match(out, new RegExp(`claude temp\\s+WARNING: relay refuses every Claude turn here: .* is Claude Code ${esc(NEWER)}, newer than ${esc(CEILING)}, the newest version whose temporary-directory code relay has read\\. This is the check on relay's long-home workaround`));
  assert.match(out, /claude init\s+not run/);
  assert.equal(d.probe(), null);
  // allow_untested: a warning, and the probe runs.
  d.config({ allow_untested: true });
  out = d.run({ FAKE_CLAUDE_VERSION: `${NEWER} (Claude Code)` });
  assert.match(out, new RegExp(`claude temp\\s+WARNING: .*in place, yours and leading there\\. .*Claude Code ${esc(NEWER)}, newer than ${esc(CEILING)}.*; allow_untested is set, so relay uses the link anyway, unverified`));
  assert.ok(d.probe(), "the probe ran");
  d.config({});
  // A link elsewhere: refused, named, left alone.
  fs.unlinkSync(d.link);
  fs.symlinkSync(d.home, d.link);
  out = d.run();
  assert.match(out, new RegExp(`claude temp\\s+WARNING: relay refuses every Claude turn here: relay's short link ${esc(d.link)} to ${esc(d.rn)} cannot be used: it points to ${esc(d.home)}`));
  assert.match(out, /claude init\s+not run/);
  assert.equal(fs.readlinkSync(d.link), d.home);
  // Too long even through the link (a long link directory stands in for a wide uid).
  const deep = path.join(d.parent, "x".repeat(12));
  fs.mkdirSync(deep);
  out = d.run({ STUB_LINK_PARENT: deep });
  assert.match(out, new RegExp(`claude temp\\s+WARNING: relay refuses every Claude turn here: .* and so is relay's short link ${esc(path.join(deep, `.rn-${UID}`))} with a uid of ${String(UID).length} digits`));
  assert.deepEqual(fs.readdirSync(deep), []);
});

test("Claude temp: under a short home doctor says nothing of the link, and its probe's temp is in ~/.rn", (t) => {
  const d = doctorBox(t, true);
  const out = d.run({ FAKE_CLAUDE_VERSION: `${NEWER} (Claude Code)` });
  assert.doesNotMatch(out, /claude temp/);
  assert.match(out, /claude init\s+isolated skills and plugins checked/);
  const p = d.probe();
  assert.equal(p.settings.env.CLAUDE_CODE_TMPDIR, p.cwd, "the real directory, short enough");
  assert.equal(path.dirname(p.cwd), d.rn);
  assert.ok(claudeTempFits(p.cwd));
});
