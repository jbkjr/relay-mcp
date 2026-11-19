// Relay's build identity (src/core/build-identity.ts): the hash is stable and covers what it says,
// the qualified build is exactly what a qualification loads, and npm ships every file of it, so that a
// git checkout and an npm install of the same build name the same identity (decision 17).
import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BUILD_SCHEME, QUALIFIED_BUILD, STAGE2_TEST_FILES, buildFiles, buildIdentity, copyBuild, isBuildIdentity } from "../dist/core/build-identity.js";
import { ESCALATION_CASES } from "../scripts/codex-qualify/stage2-escalation-cases.mjs";
import { fakeRelayBuild } from "./fake-build.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function scratch(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-build-id-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const inBuild = (rel: string) => QUALIFIED_BUILD.some((entry) => entry.endsWith("/") ? rel.startsWith(entry) || `${rel}/` === entry : rel === entry);

test("build identity: the stage-2 test files are exactly the ones the qualification's cases run", () => {
  const named = new Set<string>();
  for (const c of Object.values(ESCALATION_CASES) as any[]) for (const part of Object.values(c.parts) as any[]) for (const f of part.files) named.add(`test/${f}.test.ts`);
  assert.deepEqual([...STAGE2_TEST_FILES].sort(), [...named].sort());
});

test("build identity: everything the qualifier, its stage-2 driver and their tests import from relay's tree is in the qualified build", () => {
  // A static walk of relative imports (and new URL(...) module references) from the qualifier and
  // the stage-2 tests, and the one test fixture relay's own code loads (src/core/never-tools.ts).
  const seeds = [...STAGE2_TEST_FILES, ...fs.readdirSync(path.join(ROOT, "scripts/codex-qualify")).filter((n) => n.endsWith(".mjs")).map((n) => `scripts/codex-qualify/${n}`)];
  for (const f of fs.readdirSync(path.join(ROOT, "src"), { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    for (const m of fs.readFileSync(path.join(ROOT, "src", f), "utf8").matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const rel = path.posix.normalize(path.posix.join("dist", path.posix.dirname(f), m[1]));
      if (!rel.startsWith("dist/")) seeds.push(rel);
    }
  }
  const seen = new Set<string>(), queue = [...seeds], outside: string[] = [];
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!inBuild(rel)) outside.push(rel);
    if (rel.startsWith("dist/") || !/\.(m?js|ts|cjs)$/.test(rel)) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\(\s*|new URL\(\s*)["'](\.{1,2}\/[^"'$`]+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (fs.existsSync(path.join(ROOT, target))) queue.push(target);
    }
    // Files the tests read or copy by name beside themselves (fixtures/, stubs/).
    for (const m of text.matchAll(/import\.meta\.dirname,\s*["']((?:fixtures|stubs)[^"']*)["']/g)) queue.push(path.posix.join(path.posix.dirname(rel), m[1]));
  }
  assert.ok(seen.size > 40, `walked ${seen.size} files`);
  assert.deepEqual(outside, [], "loaded by a qualification but not hashed or shipped");
});

test("build identity: package.json's files ship every entry of the qualified build", () => {
  const files: string[] = PKG.files;
  for (const entry of QUALIFIED_BUILD) assert.ok(files.some((f) => f === entry || (f.endsWith("/") && entry.startsWith(f))), `${entry} is not in package.json files`);
  // The private repo stays private; only the public export, which points the package at the public repo, drops it.
  if (PKG.private !== true) {
    assert.equal(PKG.private, undefined);
    assert.equal(PKG.repository?.url, "git+https://github.com/jbkjr/relay-mcp.git", "only the public export drops \"private\"");
    assert.equal(PKG.publishConfig?.access, "public");
  }
  // The npm name, here as in the export: the lock (part of the identity) records it, so the export cannot change it.
  assert.equal(PKG.name, "@jbkjr/relay");
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "npm-shrinkwrap.json"), "utf8"));
  assert.equal(lock.name, PKG.name); assert.equal(lock.version, PKG.version); assert.equal(lock.packages[""].version, PKG.version);
  assert.ok(!fs.existsSync(path.join(ROOT, "package-lock.json")), "npm-shrinkwrap.json is the one lock: npm ignores package-lock.json beside it");
  // npm reads a dependency's shrinkwrap only when the registry says the package has one, so
  // package.json pins each direct dependency at exactly its locked version: npm installs those either way.
  for (const [name, range] of Object.entries(PKG.dependencies)) assert.equal(range, lock.packages[`node_modules/${name}`]?.version, `${name} is pinned to its locked version`);
  assert.deepEqual(lock.packages[""].dependencies, PKG.dependencies);
  assert.equal(PKG.scripts.prepack, "node scripts/check-pack.mjs");
});

test("build identity: npm pack ships exactly the files the identity hashes, so an install names the checkout's identity", () => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, npm_config_loglevel: "silent" } });
  assert.equal(r.status, 0, r.stderr);
  const packed = new Set<string>(JSON.parse(r.stdout)[0].files.map((f: { path: string }) => f.path));
  const hashed = buildFiles(ROOT);
  assert.deepEqual(hashed.filter((f) => !packed.has(f)), [], "hashed but not shipped");
  assert.deepEqual([...packed].filter((f) => inBuild(f) && !hashed.includes(f)), [], "shipped in the qualified build's paths but not hashed");
});

test("build identity: relay-build-v2 is the version and a sha256 over sorted paths and contents, the same wherever the bytes are", (t) => {
  const root = scratch(t);
  const a = fakeRelayBuild(path.join(root, "a"), "1.2.3"), b = fakeRelayBuild(path.join(root, "b"), "1.2.3");
  const id = buildIdentity(a);
  assert.equal(id.scheme, BUILD_SCHEME); assert.equal(id.version, "1.2.3"); assert.match(id.sha256, /^[a-f0-9]{64}$/);
  assert.ok(isBuildIdentity(id));
  assert.deepEqual(buildIdentity(b), id, "another directory with the same bytes");
  // What npm never packs is never hashed, on either side.
  for (const name of [".DS_Store", "x.orig", "node_modules/m/index.js"]) {
    fs.mkdirSync(path.dirname(path.join(b, "dist", name)), { recursive: true });
    fs.writeFileSync(path.join(b, "dist", name), "noise");
  }
  assert.deepEqual(buildIdentity(b), id);
  // package.json other than its version is not hashed (npm may rewrite it when it packs).
  fs.writeFileSync(path.join(b, "package.json"), JSON.stringify({ name: "@x/relay", version: "1.2.3", description: "rewritten" }));
  assert.deepEqual(buildIdentity(b), id);
  // Every byte, name and the version count.
  const changes: Array<[string, () => void]> = [
    ["content", () => fs.appendFileSync(path.join(b, "dist/fixture.txt"), " ")],
    ["a new file", () => fs.writeFileSync(path.join(b, "test/stubs/new.mjs"), "")],
    ["a rename", () => fs.renameSync(path.join(b, "test/fixtures/fixture.txt"), path.join(b, "test/fixtures/fixture2.txt"))],
    ["the dependency lock", () => fs.writeFileSync(path.join(b, "npm-shrinkwrap.json"), JSON.stringify({ name: "@jbkjr/relay", version: "1.2.3", lockfileVersion: 3, packages: { "": { version: "1.2.3" }, "node_modules/zod": { version: "4.0.0" } } }))],
    ["the version", () => fs.writeFileSync(path.join(b, "package.json"), JSON.stringify({ version: "1.2.4" }))],
  ];
  for (const [what, change] of changes) {
    fs.rmSync(b, { recursive: true }); fakeRelayBuild(b, "1.2.3");
    change();
    assert.notDeepEqual(buildIdentity(b), id, what);
  }
  // Files outside the qualified build are not part of it.
  fs.rmSync(b, { recursive: true }); fakeRelayBuild(b, "1.2.3");
  fs.writeFileSync(path.join(b, "README.md"), "docs"); fs.mkdirSync(path.join(b, "src")); fs.writeFileSync(path.join(b, "src/x.ts"), "");
  assert.deepEqual(buildIdentity(b), id);
});

test("build identity: a symlink, a special file or a missing entry is refused, never followed or skipped", (t) => {
  const root = scratch(t);
  const a = fakeRelayBuild(path.join(root, "a"));
  fs.symlinkSync("/etc/hosts", path.join(a, "dist/link.js"));
  assert.throws(() => buildIdentity(a), /symlink.*dist\/link\.js/);
  const b = fakeRelayBuild(path.join(root, "b"));
  spawnSync("/usr/bin/mkfifo", [path.join(b, "test/stubs/fifo")]);
  assert.throws(() => buildIdentity(b), /special file/);
  const c = fakeRelayBuild(path.join(root, "c"));
  fs.rmSync(path.join(c, "experiments"), { recursive: true });
  assert.throws(() => buildIdentity(c), /incomplete: experiments\/stage2-redteam\/lib\/oracles\.mjs is missing/);
  const d = fakeRelayBuild(path.join(root, "d"));
  fs.rmSync(path.join(d, "npm-shrinkwrap.json"));
  assert.throws(() => buildIdentity(d), /incomplete: npm-shrinkwrap\.json is missing/);
});

test("build identity: a legacy relay-build-v1 record is read as a record, never as this build, and a shipped pin naming one is refused", async () => {
  const { BUILD_SCHEME: mjsScheme, BUILD_RECORD_SCHEMES, validateManifest, validateShippedPin } = await import("../scripts/codex-qualify/codex-pin-store.mjs");
  const { LEGACY_BUILD_SCHEMES, isBuildRecord, sameBuild, describeBuild } = await import("../dist/core/build-identity.js");
  const { parseShippedPin } = await import("../dist/core/shipped-pin.js");
  // The mjs copy (loaded before any build) and the TS module agree on the schemes.
  assert.equal(BUILD_SCHEME, "relay-build-v2");
  assert.equal(mjsScheme, BUILD_SCHEME);
  assert.deepEqual([...BUILD_RECORD_SCHEMES].sort(), [BUILD_SCHEME, ...LEGACY_BUILD_SCHEMES].sort());
  const v1 = { scheme: "relay-build-v1", version: "1.1.4", sha256: "a".repeat(64) };
  const v2 = { ...v1, scheme: BUILD_SCHEME };
  assert.ok(isBuildRecord(v1) && !isBuildIdentity(v1), "a v1 identity is a record, not a build of this scheme");
  assert.ok(!sameBuild(v1, v2), "the same digest under another scheme is another build");
  assert.match(describeBuild(v1), /\(relay-build-v1\)$/);
  assert.ok(!isBuildRecord({ ...v1, scheme: "relay-build-v0" }));
  // A local pin that names a v1 build stays valid (it records what ran).
  const local = { version: "0.169.0", binarySha256: "b".repeat(64), npmIntegrity: `sha512-${"A".repeat(86)}==`, codesign: { teamId: "2DC432GLL2", identity: "Developer ID Application: OpenAI" },
    qualifiedAt: "2026-11-17T00:00:00Z", verdictPath: "/v.json", sourceCommit: "c".repeat(40) };
  assert.doesNotThrow(() => validateManifest({ ...local, relayBuild: v1 }));
  assert.doesNotThrow(() => validateManifest({ ...local, relayBuild: v2 }));
  assert.throws(() => validateManifest({ ...local, relayBuild: { ...v1, scheme: "relay-build-v0" } }), /relay build/);
  // A shipped pin must name this scheme, in both validators.
  const pin = (relay: object) => ({ format: "relay-shipped-codex-pin-v1", codex: { version: "0.169.0", npmIntegrity: `sha512-${"A".repeat(86)}==` }, relay });
  assert.doesNotThrow(() => parseShippedPin(pin(v2)));
  assert.doesNotThrow(() => validateShippedPin(pin(v2)));
  assert.throws(() => parseShippedPin(pin(v1)), /relay-build-v1, which does not cover relay's dependency lock.*qualified again/);
  assert.throws(() => validateShippedPin(pin(v1)), /relay-build-v1, which does not cover the dependency lock/);
});

test("build identity: the copy a qualification runs from has the same identity, executable bits and relay's dependencies", async (t) => {
  const root = scratch(t);
  const copy = path.join(root, "copy");
  const { dependencyDrift } = await import("../dist/core/build-identity.js");
  assert.equal(dependencyDrift(ROOT), null, "this checkout's dependencies are the locked ones");
  const id = copyBuild(ROOT, copy);
  assert.deepEqual(id, buildIdentity(ROOT));
  assert.ok(fs.statSync(path.join(copy, "test/stubs/stub-codex")).mode & 0o100, "stubs stay executable");
  for (const dep of Object.keys(PKG.dependencies)) {
    const link = path.join(copy, "node_modules", dep);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), dep);
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(ROOT, "node_modules", dep)));
  }
  // Node strips the tests' types there (it would not under node_modules): a stage-2 test loads from the copy.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/stage2-network-decisions.test.ts"], { cwd: copy, encoding: "utf8", timeout: 120_000, env });
  assert.equal(r.status, 0, r.stdout.slice(-2000) + r.stderr.slice(-2000));
  assert.match(r.stdout, /^# fail 0$/m);
  assert.throws(() => copyBuild(ROOT, copy), /EEXIST/, "never into an existing directory");
  const missing = fakeRelayBuild(path.join(root, "nodeps"));
  fs.writeFileSync(path.join(missing, "package.json"), JSON.stringify({ name: "@jbkjr/relay", version: "1.0.0", dependencies: { "relay-no-such-dependency": "1" } }));
  assert.throws(() => copyBuild(missing, path.join(root, "copy2")), /dependency relay-no-such-dependency is not installed/);
  // The lock must be this package's, and each dependency linked must be the version it names.
  const offLock = fakeRelayBuild(path.join(root, "offlock"), "1.0.0");
  fs.writeFileSync(path.join(offLock, "npm-shrinkwrap.json"), JSON.stringify({ name: "@jbkjr/relay", version: "0.9.0", lockfileVersion: 3, packages: { "": { version: "0.9.0" } } }));
  assert.throws(() => copyBuild(offLock, path.join(root, "copy3")), /npm-shrinkwrap\.json under .* is not the lock of @jbkjr\/relay 1\.0\.0/);
  const drift = fakeRelayBuild(path.join(root, "drift"), "1.0.0");
  const dep = path.join(drift, "node_modules", "relay-test-dep");
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(path.join(dep, "package.json"), JSON.stringify({ name: "relay-test-dep", version: "2.0.0" }));
  fs.writeFileSync(path.join(drift, "package.json"), JSON.stringify({ name: "@jbkjr/relay", version: "1.0.0", dependencies: { "relay-test-dep": "^1" } }));
  fs.writeFileSync(path.join(drift, "npm-shrinkwrap.json"), JSON.stringify({ name: "@jbkjr/relay", version: "1.0.0", lockfileVersion: 3, packages: { "": { version: "1.0.0" }, "node_modules/relay-test-dep": { version: "1.4.0" } } }));
  assert.throws(() => copyBuild(drift, path.join(root, "copy4")), /relay-test-dep is 2\.0\.0 at .*the lock names 1\.4\.0: run npm ci/);
  fs.writeFileSync(path.join(dep, "package.json"), JSON.stringify({ name: "relay-test-dep", version: "1.4.0" }));
  assert.doesNotThrow(() => copyBuild(drift, path.join(root, "copy5")));
});

test("build identity: the modules release-watch loads before a build import nothing from dist statically", () => {
  // records.mjs imports codex-stage2.mjs for ITEMS before anything is built (codex-stage2.mjs stopPid).
  for (const f of ["codex-stage2.mjs", "codex-pin-store.mjs", "session.mjs", "scratch-env.mjs", "codex-stage2-pin.mjs", "stage2-escalation-cases.mjs", "main-module.mjs"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "scripts/codex-qualify", f), "utf8"), /^import [^;]*from "\.\.\/\.\.\/dist\//m, f);
  }
});

test("build identity: the qualifier's directory holds no release-watcher or runner logic", () => {
  // The public export drops scripts/release-watch/; what ships in scripts/codex-qualify/ must stand alone.
  for (const f of fs.readdirSync(path.join(ROOT, "scripts/codex-qualify"))) {
    const text = fs.readFileSync(path.join(ROOT, "scripts/codex-qualify", f), "utf8");
    assert.doesNotMatch(text, /from "\.\.\/release-watch\/|onStudio|ComputerName|watch\.mjs|RELAY_CONFINED|logStreamCheck/, f);
  }
});
