import "./helpers.ts";
import "./process-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkNativeTempAlias, ensureNativeTempAlias, setNativeTempAliasParentForTests } from "../dist/confine/private-root.js";
import { removeTestNativeTempAlias } from "./native-temp-alias.ts";

const UID = process.getuid?.() ?? 0;

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-alias-")));
  const parent = path.join(root, "aliases"); // never the real /Users/Shared link
  fs.mkdirSync(parent);
  fs.chmodSync(parent, 0o700);
  const home = path.join(root, "long-current-home-for-native-turn-temp");
  const target = path.join(home, ".rn");
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const oldHome = path.join(root, "previous-home");
  fs.mkdirSync(oldHome, { mode: 0o700 });
  const oldTarget = path.join(oldHome, ".rn");
  const alias = path.join(parent, `.rn-${UID}`);
  const saved = process.env.HOME;
  process.env.HOME = home;
  setNativeTempAliasParentForTests(parent);
  t.after(() => {
    t.mock.restoreAll();
    setNativeTempAliasParentForTests(null);
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, parent, home, target, oldHome, oldTarget, alias };
}

test("native temp alias atomically repoints a stale owned .rn link, including when the old home is gone", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.oldTarget, { mode: 0o700 });
  fs.symlinkSync(f.oldTarget, f.alias);
  fs.rmSync(f.oldHome, { recursive: true });
  assert.equal(checkNativeTempAlias(f.target).state, "stale");
  const rename = fs.renameSync;
  let swaps = 0;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === f.alias) {
      swaps++;
      assert.equal(fs.readlinkSync(f.alias), f.oldTarget, "old alias remains until the atomic rename");
      assert.equal(fs.readlinkSync(from), f.target);
    }
    return rename(from, to);
  });
  for (let turn = 0; turn < 2; turn++) {
    const alias = ensureNativeTempAlias(f.target);
    const temp = fs.mkdtempSync(f.target + path.sep);
    const agentDir = path.join(alias, path.basename(temp));
    assert.equal(fs.realpathSync(agentDir), temp);
    fs.writeFileSync(path.join(agentDir, "file"), "private");
    assert.equal(fs.readFileSync(path.join(temp, "file"), "utf8"), "private");
    fs.rmSync(temp, { recursive: true });
  }
  assert.equal(swaps, 1);
  assert.deepEqual(checkNativeTempAlias(f.target), { state: "ok" });
  assert.equal(fs.existsSync(f.oldHome), false, "the old destination is never recreated");
  assert.deepEqual(fs.readdirSync(f.parent), [path.basename(f.alias)], "no staging entries left");
});

test("native temp alias read-only checks describe a stale link without changing it", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.oldTarget, f.alias);
  const found = checkNativeTempAlias(f.target);
  assert.equal(found.state, "stale");
  assert.equal(found.state === "stale" && found.target, f.oldTarget);
  assert.equal(fs.readlinkSync(f.alias), f.oldTarget);
  assert.equal(fs.existsSync(f.oldTarget), false);
});

test("native temp alias refuses existing old roots, unrelated dangling destinations, relative paths and non-links", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.oldTarget);
  for (const target of [f.oldTarget, path.join(f.oldHome, "unrelated"), "../previous-home/.rn", `${f.oldHome}/a/../.rn`]) {
    fs.symlinkSync(target, f.alias);
    assert.throws(() => ensureNativeTempAlias(f.target), /points to/);
    assert.equal(fs.readlinkSync(f.alias), target);
    fs.unlinkSync(f.alias);
  }
  fs.writeFileSync(f.alias, "leave alone");
  assert.throws(() => ensureNativeTempAlias(f.target), /not a link/);
  assert.equal(fs.readFileSync(f.alias, "utf8"), "leave alone");
});

test("native temp alias refuses old .rn symlinks without following them or altering their contents", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "untouched");
  fs.symlinkSync(outside, f.oldTarget);
  fs.symlinkSync(f.oldTarget, f.alias);
  assert.throws(() => ensureNativeTempAlias(f.target), /points to/);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "untouched");
  fs.unlinkSync(f.oldTarget);
  fs.symlinkSync(path.join(f.root, "missing"), f.oldTarget);
  assert.throws(() => ensureNativeTempAlias(f.target), /points to/);
  assert.equal(fs.readlinkSync(f.alias), f.oldTarget);
});

test("native temp alias refuses missing old roots through symlink, writable, non-directory or foreign ancestors", (t) => {
  const f = fixture(t);
  const linked = path.join(f.root, "linked-home"); fs.symlinkSync(f.oldHome, linked);
  fs.symlinkSync(path.join(linked, ".rn"), f.alias);
  assert.throws(() => ensureNativeTempAlias(f.target), /points to/);
  fs.unlinkSync(f.alias);
  fs.symlinkSync(f.oldTarget, f.alias);
  fs.chmodSync(f.oldHome, 0o777);
  assert.throws(() => ensureNativeTempAlias(f.target), /points to/);
  fs.chmodSync(f.oldHome, 0o700);
  const lstat = fs.lstatSync;
  const foreign = t.mock.method(fs, "lstatSync", (p: fs.PathLike, options?: fs.StatSyncOptions) => {
    const st = lstat(p, options as never) as fs.Stats;
    return String(p) === f.oldHome ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: UID + 1 }) : st;
  });
  assert.throws(() => ensureNativeTempAlias(f.target), /points to/);
  foreign.mock.restore();
  fs.rmdirSync(f.oldHome); fs.writeFileSync(f.oldHome, "file");
  assert.throws(() => ensureNativeTempAlias(f.target), /points to/);
  assert.equal(fs.readlinkSync(f.alias), f.oldTarget);
});

test("native temp alias refuses stale links owned by another user", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.oldTarget, f.alias);
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (p: fs.PathLike, options?: fs.StatSyncOptions) => {
    const st = lstat(p, options as never) as fs.Stats;
    return String(p) === f.alias ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: UID + 1 }) : st;
  });
  assert.throws(() => ensureNativeTempAlias(f.target), /owned by uid/);
  assert.equal(fs.readlinkSync(f.alias), f.oldTarget);
});

test("native temp alias replacement rechecks a changed entry and cleans staging on refusal", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.oldTarget, f.alias);
  const symlink = fs.symlinkSync;
  t.mock.method(fs, "symlinkSync", (target: fs.PathLike, link: fs.PathLike, type?: fs.symlink.Type) => {
    symlink(target, link, type);
    if (String(link) !== f.alias) {
      fs.unlinkSync(f.alias);
      fs.writeFileSync(f.alias, "replacement from elsewhere");
    }
  });
  assert.throws(() => ensureNativeTempAlias(f.target), /changed while relay was preparing/);
  assert.equal(fs.readFileSync(f.alias, "utf8"), "replacement from elsewhere");
  assert.deepEqual(fs.readdirSync(f.parent), [path.basename(f.alias)]);
});

test("native temp alias failed atomic rename leaves the original link and no staging entry", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.oldTarget, f.alias);
  t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("rename denied"), { code: "EACCES" }); });
  assert.throws(() => ensureNativeTempAlias(f.target), /rename denied/);
  assert.equal(fs.readlinkSync(f.alias), f.oldTarget);
  assert.deepEqual(fs.readdirSync(f.parent), [path.basename(f.alias)]);
});

test("native temp alias accepts a repair by another relay while it stages its replacement", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.oldTarget, f.alias);
  const symlink = fs.symlinkSync;
  t.mock.method(fs, "symlinkSync", (target: fs.PathLike, link: fs.PathLike, type?: fs.symlink.Type) => {
    symlink(target, link, type);
    if (String(link) !== f.alias) {
      fs.unlinkSync(f.alias);
      symlink(f.target, f.alias);
    }
  });
  const rename = t.mock.method(fs, "renameSync", () => { assert.fail("a concurrent successful repair must not be replaced"); });
  assert.equal(ensureNativeTempAlias(f.target), f.alias);
  assert.equal(rename.mock.callCount(), 0);
  assert.equal(fs.readlinkSync(f.alias), f.target);
  assert.deepEqual(fs.readdirSync(f.parent), [path.basename(f.alias)]);
});

test("native temp alias refuses stale-link repair when the alias parent is unsafe", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.oldTarget, f.alias);
  fs.chmodSync(f.parent, 0o777);
  assert.throws(() => ensureNativeTempAlias(f.target), /can be written by other users and is not sticky/);
  assert.equal(fs.readlinkSync(f.alias), f.oldTarget);
});

test("test harness alias cleanup removes only its own scratch home's owned link", (t) => {
  const f = fixture(t);
  removeTestNativeTempAlias(f.home, f.parent); // absent
  fs.symlinkSync(f.target, f.alias);
  removeTestNativeTempAlias(f.oldHome, f.parent); // another fixture's link
  assert.equal(fs.readlinkSync(f.alias), f.target);
  const lstat = fs.lstatSync;
  const foreign = t.mock.method(fs, "lstatSync", (p: fs.PathLike, options?: fs.StatSyncOptions) => {
    const st = lstat(p, options as never) as fs.Stats;
    return String(p) === f.alias ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: UID + 1 }) : st;
  });
  removeTestNativeTempAlias(f.home, f.parent);
  assert.equal(fs.readlinkSync(f.alias), f.target, "a foreign-owned link is never removed");
  foreign.mock.restore();
  removeTestNativeTempAlias(f.home, f.parent);
  assert.equal(fs.lstatSync(f.alias, { throwIfNoEntry: false }), undefined);
  fs.mkdirSync(f.alias);
  removeTestNativeTempAlias(f.home, f.parent);
  assert.ok(fs.lstatSync(f.alias).isDirectory());
});
