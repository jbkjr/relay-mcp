// A release's shipped Codex pin (decision 18): its format admits nothing machine-specific; relay
// runs a shipped/ tree only for exactly the Codex release and relay build the running package's
// pin names; relay's download is checked against it; the maintainer's manifest is written only
// from a passing qualification on the maintainer's Mac of exactly the build being released; and
// doctor says which pin is in force.
import "./helpers.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { withDefaults } from "../dist/core/config.js";
import { buildIdentity, copyBuild } from "../dist/core/build-identity.js";
import { SHIPPED_PIN_FILE, SHIPPED_PIN_FORMAT, parseShippedPin, readShippedPin } from "../dist/core/shipped-pin.js";
import { codexPinInfo, describeCodexPin, freezeCodexConfig, setRelayPackageRootForTests } from "../dist/backends/codex-pin.js";
import { qualifyCodex, QUALIFY_CODEX_USAGE } from "../dist/install/qualify-codex.js";
import * as P from "../scripts/codex-qualify/codex-pin-store.mjs";
import { checkTarball, installShippedPin, writeShippedPin } from "../scripts/codex-qualify/codex-shipped-pin.mjs";
import { runQualifier } from "../scripts/codex-qualify/codex-qualifier.mjs";
import { CLI } from "./helpers.ts";
import { fakeRelayBuild } from "./fake-build.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const TARBALL = "fixture codex tarball";
const INTEGRITY = "sha512-" + crypto.createHash("sha512").update(TARBALL).digest("base64");
const OTHER_INTEGRITY = "sha512-" + crypto.createHash("sha512").update("another tarball").digest("base64");
const commit = "a".repeat(40);

function writable(dir: string) {
  try { fs.chmodSync(dir, 0o700); } catch { return; }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) writable(path.join(dir, e.name));
}
function scratch(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rsp-")));
  t.after(() => { setRelayPackageRootForTests(null); writable(root); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
const pinFor = (pkg: string, version = "0.169.0", npmIntegrity = INTEGRITY) => ({ format: SHIPPED_PIN_FORMAT, codex: { version, npmIntegrity }, relay: buildIdentity(pkg) });
function shipPackage(root: string, pin: unknown = undefined) {
  const pkg = fakeRelayBuild(path.join(root, "relay"), "1.2.0", { "dist/backends/codex.js": "", "scripts/codex-qualify/codex-qualifier.mjs": "" });
  fs.writeFileSync(path.join(pkg, SHIPPED_PIN_FILE), JSON.stringify(pin ?? pinFor(pkg)));
  return pkg;
}
function vendor(root: string, version = "0.169.0") {
  const dir = fs.mkdtempSync(path.join(root, "vendor-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin/codex"), `#!/bin/sh\necho codex-cli ${version}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "codex-package.json"), JSON.stringify({ version, entrypoint: "bin/codex" }));
  return dir;
}
const codesign = { teamId: P.TEAM_ID, identity: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)" };
function shippedTree(root: string, store: string, version = "0.169.0", npmIntegrity = INTEGRITY) {
  P.initStore(store);
  const v = vendor(root, version);
  const target = P.publishShippedTree(store, v, { version, binarySha256: P.sha256(path.join(v, "bin/codex")), npmIntegrity, codesign, installedAt: new Date().toISOString() });
  P.promote(store, target);
  return target;
}
const pass = (version: string) => ({
  ok: true, state: "passed", relayPath: "present", version, verdictSchema: P.CURRENT_VERDICT_SCHEMA,
  items: Object.fromEntries(Object.entries(P.EXPECTED_PARTS).map(([id, names]) => [id, { state: "passed", parts: Object.fromEntries((names as string[]).map((n) => [n, { state: "passed" }])) }])),
});
/** A local qualification's tree, written directly (sealed as publishTree seals) so a test can choose what it records. */
function localTree(root: string, store: string, { version = "0.169.0", verdict = pass(version) as any, extra = {} as Record<string, unknown>, schema = true } = {}) {
  P.initStore(store);
  const v = vendor(root, version);
  const verdictPath = path.join(root, `verdict-${crypto.randomUUID()}.json`);
  P.atomicJson(verdictPath, verdict);
  const manifest: any = { version, binarySha256: P.sha256(path.join(v, "bin/codex")), npmIntegrity: INTEGRITY, codesign, qualifiedAt: new Date().toISOString(), verdictPath, sourceCommit: commit, ...extra };
  if (schema) Object.assign(manifest, { verdictSchema: P.CURRENT_VERDICT_SCHEMA, verdictSha256: P.sha256(verdictPath) });
  const target = `versions/${version}-${manifest.binarySha256.slice(0, 12)}`;
  const dest = path.join(store, target);
  fs.cpSync(v, dest, { recursive: true });
  P.atomicJson(path.join(dest, "manifest.json"), manifest);
  const seal = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) seal(f); else fs.chmodSync(f, fs.statSync(f).mode & 0o111 ? 0o555 : 0o444); } fs.chmodSync(dir, 0o555); };
  seal(dest);
  fs.symlinkSync(target, path.join(store, "current"));
  return { target, verdictPath };
}
const cfgFor = (root: string, store: string) => withDefaults({ targets: { codex: { pin_store: store, home: path.join(root, "codex-home"), pinned: true } } });

/** Acquisition stand-ins, as test/codex-qualifier.test.ts uses them. */
function services(root: string, { integrity = INTEGRITY, bytes = TARBALL } = {}) {
  const calls: string[] = [];
  return { calls, services: {
    json: async (url: string) => { calls.push(`json ${url}`); const version = url.split("/").at(-1)!; return { version, dist: { tarball: `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`, integrity } }; },
    download: async (url: string, dest: string) => { calls.push(`download ${url}`); fs.writeFileSync(dest, bytes); },
    unpack: async (_archive: string, dest: string) => { fs.mkdirSync(dest); fs.cpSync(vendor(root, path.basename(dest).replace("package-", "")), path.join(dest, "package/vendor/aarch64-apple-darwin"), { recursive: true }); },
    command: async (bin: string, args: string[]) => {
      calls.push(`command ${bin} ${args[0]}`);
      if (bin === "/usr/bin/codesign") return args[0] === "-dv" ? `Authority=${codesign.identity}\nTeamIdentifier=2DC432GLL2\n` : "";
      if (args[0] === "--version") return `codex-cli ${/package-(\d+\.\d+\.\d+)/.exec(bin)![1]}\n`;
      throw new Error(`unexpected command ${bin}`);
    },
    notify: async () => {},
  } };
}

test("shipped pin: the format is exactly the Codex release and relay's build, and refuses anything else, machine-specific or not", () => {
  const good = { format: SHIPPED_PIN_FORMAT, codex: { version: "0.169.0", npmIntegrity: INTEGRITY }, relay: { scheme: "relay-build-v2", version: "1.2.0", sha256: "b".repeat(64) } };
  assert.deepEqual(parseShippedPin(good), good);
  assert.equal(P.validateShippedPin(good), good);
  const bad: Array<[string, any]> = [
    ["a path", { ...good, verdictPath: "/Users/maintainer/.local/share/relay-codex-pins/runs/x/stage2-verdict.json" }],
    ["a host", { ...good, host: "maintainer-studio" }],
    ["a uid", { ...good, uid: 501 }],
    ["a time", { ...good, qualifiedAt: "2026-11-17T00:00:00Z" }],
    ["a binary hash", { ...good, codex: { ...good.codex, binarySha256: "c".repeat(64) } }],
    ["a commit", { ...good, relay: { ...good.relay, commit } }],
    ["another format", { ...good, format: "relay-shipped-codex-pin-v2" }],
    ["a prerelease Codex", { ...good, codex: { ...good.codex, version: "0.169.0-alpha.1" } }],
    ["a sha1 integrity", { ...good, codex: { ...good.codex, npmIntegrity: "sha1-abc" } }],
    ["no relay", { format: good.format, codex: good.codex }],
    ["a malformed build", { ...good, relay: { ...good.relay, sha256: "B".repeat(64) } }],
    ["another scheme", { ...good, relay: { ...good.relay, scheme: "relay-build-v0" } }],
    ["the legacy scheme, without the dependency lock", { ...good, relay: { ...good.relay, scheme: "relay-build-v1" } }],
    ["an array", [good]], ["null", null],
  ];
  for (const [what, value] of bad) {
    assert.throws(() => parseShippedPin(value), /shipped Codex pin/, `relay's runtime refuses ${what}`);
    assert.throws(() => P.validateShippedPin(value), /shipped Codex pin/, `the pin store refuses ${what}`);
  }
});

test("shipped pin: relay runs a shipped tree only for the Codex and the relay build the running package's pin names", async (t) => {
  const root = scratch(t), store = path.join(root, "store"), pkg = shipPackage(root);
  const target = shippedTree(root, store);
  const cfg = cfgFor(root, store);
  setRelayPackageRootForTests(pkg);
  const frozen = freezeCodexConfig(cfg);
  assert.equal(frozen.targets.codex.bin, path.join(fs.realpathSync(store), target, "bin/codex"));
  const info = codexPinInfo(frozen)!;
  assert.equal(info.kind, "shipped");
  assert.match(describeCodexPin(info), /^shipped: Codex 0\.169\.0 \(npm sha512-.*this release's pin, qualified by the maintainer with relay 1\.2\.0, build /);
  const refuse = (what: string, re: RegExp) => assert.throws(() => freezeCodexConfig(cfg), (e: Error) => /relay refuses Codex: no valid qualified pin/.test(e.message) && re.test(e.message), what);
  // A mismatched Codex version, integrity or relay build; no pin; an invalid pin; extra fields.
  const pinFile = path.join(pkg, SHIPPED_PIN_FILE), original = fs.readFileSync(pinFile, "utf8");
  const cases: Array<[string, () => void, RegExp]> = [
    ["another Codex version", () => fs.writeFileSync(pinFile, JSON.stringify(pinFor(pkg, "0.170.0"))), /this release ships Codex 0\.170\.0/],
    ["another integrity", () => fs.writeFileSync(pinFile, JSON.stringify(pinFor(pkg, "0.169.0", OTHER_INTEGRITY))), /this release ships Codex 0\.169\.0 \(sha512-/],
    ["another relay build", () => fs.appendFileSync(path.join(pkg, "dist/fixture.txt"), "rebuilt"), /qualified with relay 1\.2\.0, build .* and the relay running now is relay 1\.2\.0, build /],
    ["no pin", () => fs.rmSync(pinFile), /ships none/],
    ["a pin that is not JSON", () => fs.writeFileSync(pinFile, "{"), /JSON/],
    ["a pin with a machine-specific field", () => fs.writeFileSync(pinFile, JSON.stringify({ ...JSON.parse(original), host: "studio" })), /exactly format, codex and relay/],
  ];
  const fixture = fs.readFileSync(path.join(pkg, "dist/fixture.txt"), "utf8");
  for (const [what, change, re] of cases) {
    change();
    refuse(what, re);
    fs.writeFileSync(pinFile, original); fs.writeFileSync(path.join(pkg, "dist/fixture.txt"), fixture);
    assert.equal(freezeCodexConfig(cfg).targets.codex.bin, frozen.targets.codex.bin, `restored after ${what}`);
  }
  // The refusal names the way back for a release that ships a pin.
  fs.writeFileSync(pinFile, JSON.stringify(pinFor(pkg, "0.170.0")));
  refuse("hint", /relay install codex --write/);
});

/** A package whose lock (hashed into the pin's build) names relay-test-dep 1.4.0 and its own relay-test-sub 2.0.0, both installed as locked. */
function lockedPackage(root: string, name = "relay") {
  const pkg = fakeRelayBuild(path.join(root, name), "1.2.0", {
    "dist/backends/codex.js": "", "scripts/codex-qualify/codex-qualifier.mjs": "",
    "package.json": JSON.stringify({ name: "@jbkjr/relay", version: "1.2.0", dependencies: { "relay-test-dep": "1.4.0" } }),
    "npm-shrinkwrap.json": JSON.stringify({ name: "@jbkjr/relay", version: "1.2.0", lockfileVersion: 3, packages: {
      "": { name: "@jbkjr/relay", version: "1.2.0" },
      "node_modules/relay-test-dep": { version: "1.4.0", dependencies: { "relay-test-sub": "2.0.0" } },
      "node_modules/relay-test-dep/node_modules/relay-test-sub": { version: "2.0.0" },
      "node_modules/relay-test-devonly": { version: "9.9.9", dev: true },
      "node_modules/relay-test-optional": { version: "1.0.0", optional: true },
    } }),
    "node_modules/relay-test-dep/package.json": JSON.stringify({ name: "relay-test-dep", version: "1.4.0" }),
    "node_modules/relay-test-dep/node_modules/relay-test-sub/package.json": JSON.stringify({ name: "relay-test-sub", version: "2.0.0" }),
  });
  fs.writeFileSync(path.join(pkg, SHIPPED_PIN_FILE), JSON.stringify(pinFor(pkg)));
  return pkg;
}

test("shipped pin: relay runs it only with the dependency versions the pin's lock names, transitive ones included", async (t) => {
  const root = scratch(t), store = path.join(root, "store"), pkg = lockedPackage(root);
  const target = shippedTree(root, store);
  const cfg = cfgFor(root, store);
  setRelayPackageRootForTests(pkg);
  // Dev-only entries are not runtime dependencies, and an absent optional one is fine.
  assert.equal(freezeCodexConfig(cfg).targets.codex.bin, path.join(fs.realpathSync(store), target, "bin/codex"));
  const refused = (re: RegExp, what: string) => assert.throws(() => freezeCodexConfig(cfgFor(root, store)), (e: Error) => /relay refuses Codex: no valid qualified pin/.test(e.message) && re.test(e.message), what);
  // A direct dependency npm put at another version (a lock it did not honour, an override): the identity is unchanged, the dependency is not.
  const dep = path.join(pkg, "node_modules/relay-test-dep/package.json");
  fs.writeFileSync(dep, JSON.stringify({ name: "relay-test-dep", version: "1.4.1" }));
  refused(/relay-test-dep is 1\.4\.1 at .*the lock names 1\.4\.0.*shipped pin does not cover them.*npm install -g @jbkjr\/relay@1\.2\.0/s, "direct");
  fs.writeFileSync(dep, JSON.stringify({ name: "relay-test-dep", version: "1.4.0" }));
  // A transitive one changed while every direct dependency stays as locked (review r_b3167592 X1).
  const sub = path.join(pkg, "node_modules/relay-test-dep/node_modules/relay-test-sub/package.json");
  fs.writeFileSync(sub, JSON.stringify({ name: "relay-test-sub", version: "2.0.1" }));
  refused(/relay-test-dep\/node_modules\/relay-test-sub is 2\.0\.1 at .*the lock names 2\.0\.0/, "transitive");
  // Hoisted, as a project install places it: judged by what Node would load from its dependent.
  fs.rmSync(path.dirname(sub), { recursive: true });
  refused(/relay-test-sub is not installed, and the lock names 2\.0\.0/, "missing transitive");
  fs.mkdirSync(path.join(pkg, "node_modules/relay-test-sub"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "node_modules/relay-test-sub/package.json"), JSON.stringify({ name: "relay-test-sub", version: "2.0.0" }));
  assert.equal(freezeCodexConfig(cfgFor(root, store)).targets.codex.bin, path.join(fs.realpathSync(store), target, "bin/codex"), "a hoisted copy at the locked version");
  fs.rmSync(path.dirname(dep), { recursive: true });
  refused(/relay-test-dep is not installed/, "missing direct");
});

test("shipped pin: dependencies that drifted when the process started are refused even after the disk is repaired (review r_b3167592 C3)", async (t) => {
  const root = scratch(t), store = path.join(root, "store"), pkg = lockedPackage(root, "relay-started-drifted");
  shippedTree(root, store);
  const sub = path.join(pkg, "node_modules/relay-test-dep/node_modules/relay-test-sub/package.json");
  fs.writeFileSync(sub, JSON.stringify({ name: "relay-test-sub", version: "2.0.1" }));
  setRelayPackageRootForTests(pkg);
  // The first use takes this process's snapshot (relay's own is taken at process start).
  assert.throws(() => freezeCodexConfig(cfgFor(root, store)), /when this process started, relay's dependencies are not the ones its lock.*relay-test-sub is 2\.0\.1.*restart the session/s);
  fs.writeFileSync(sub, JSON.stringify({ name: "relay-test-sub", version: "2.0.0" }));
  assert.throws(() => freezeCodexConfig(cfgFor(root, store)), /when this process started/, "a repair on disk does not change what was loaded");
});

test("shipped pin: a shipped tree's manifest never passes as a local qualification, nor the reverse", async (t) => {
  const root = scratch(t), pkg = shipPackage(root);
  setRelayPackageRootForTests(pkg);
  // A shipped tree moved under versions/: no verdict, so relay and the store refuse it.
  const s1 = path.join(root, "s1"), shipped = shippedTree(root, s1);
  const moved = shipped.replace(/^shipped\//, "versions/");
  const move = (store: string, from: string, to: string) => {
    // macOS needs a directory moved between parents writable ('..' changes); seal it again after.
    for (const d of [path.dirname(path.join(store, from)), path.join(store, from)]) fs.chmodSync(d, 0o700);
    fs.renameSync(path.join(store, from), path.join(store, to));
    fs.chmodSync(path.join(store, to), 0o555);
  };
  move(s1, shipped, moved);
  fs.rmSync(path.join(s1, "current")); fs.symlinkSync(moved, path.join(s1, "current"));
  assert.throws(() => freezeCodexConfig(cfgFor(root, s1)), /invalid pin manifest/);
  assert.throws(() => P.validateTarget(s1, moved), /invalid pin manifest/);
  // A local qualification moved under shipped/: refused by relay and the store alike.
  const s2 = path.join(root, "s2"), local = localTree(root, s2).target;
  const as = local.replace(/^versions\//, "shipped/");
  move(s2, local, as);
  fs.rmSync(path.join(s2, "current")); fs.symlinkSync(as, path.join(s2, "current"));
  assert.throws(() => freezeCodexConfig(cfgFor(root, s2)), /invalid shipped pin tree manifest/);
  assert.throws(() => P.validateTarget(s2, as), /invalid shipped pin tree manifest/);
  assert.throws(() => P.validateManifest({ version: "0.169.0", binarySha256: "c".repeat(64), npmIntegrity: INTEGRITY, codesign, installedAt: new Date().toISOString() }), /invalid pin manifest/);
});

test("shipped pin: relay's download is refused before it starts when npm names another integrity, and after when the bytes differ", async (t) => {
  for (const [what, opts, re, downloaded] of [
    ["npm's metadata", { integrity: OTHER_INTEGRITY }, /not the one relay's shipped pin names/, false],
    ["the bytes", { bytes: "tampered tarball" }, /SRI mismatch/, true],
  ] as const) {
    const root = scratch(t), store = path.join(root, "store"), pkg = shipPackage(root);
    const s = services(root, opts as any);
    const r = await installShippedPin({ store, packageRoot: pkg, services: s.services as any, supervisor: { check() {}, cancel() {} } as any });
    assert.equal(r.state, "failed", what); assert.match(r.error, re, what);
    assert.equal(s.calls.some((c) => c.startsWith("download")), downloaded, what);
    assert.equal(s.calls.some((c) => c.startsWith("command")), false, `${what}: nothing ran`);
    assert.equal(P.pointer(store, "current"), null);
    assert.deepEqual(fs.readdirSync(path.join(store, "shipped")), []);
  }
});

test("shipped pin: installing it verifies, publishes under shipped/ and makes it current; a local pin stays unless replaced", async (t) => {
  const root = scratch(t), store = path.join(root, "store"), pkg = shipPackage(root);
  const run = (replaceLocal = false) => installShippedPin({ store, packageRoot: pkg, replaceLocal, services: services(root).services as any, supervisor: { check() {}, cancel() {} } as any });
  // A pin qualified on this Mac is current: install leaves it; --shipped replaces it, and rollback restores it.
  const { target: local } = localTree(root, store, { extra: { relayBuild: buildIdentity(pkg) } });
  const kept = await run();
  assert.equal(kept.state, "local-kept"); assert.equal(P.pointer(store, "current"), local);
  const r = await run(true);
  assert.equal(r.state, "installed", r.error);
  assert.match(r.target, /^shipped\/0\.169\.0-[a-f0-9]{12}$/);
  assert.equal(P.pointer(store, "current"), r.target); assert.equal(P.pointer(store, "previous"), local);
  const m = P.validateTarget(store, r.target);
  assert.deepEqual(Object.keys(m).sort(), ["binarySha256", "codesign", "installedAt", "npmIntegrity", "version"]);
  assert.equal(m.npmIntegrity, INTEGRITY);
  setRelayPackageRootForTests(pkg);
  assert.equal(codexPinInfo(freezeCodexConfig(cfgFor(root, store)))!.kind, "shipped");
  assert.equal((await run()).state, "unchanged");
  assert.equal(fs.readdirSync(path.join(store, "staging")).filter((n) => n.startsWith("shipped-")).length, 0, "scratch removed");
  // A package changed after release is refused before the store is touched.
  fs.appendFileSync(path.join(pkg, "dist/fixture.txt"), "edited");
  const edited = await run(true);
  assert.equal(edited.state, "failed"); assert.match(edited.error, /changed after it was released/);
  // No pin, nothing done.
  const plain = fakeRelayBuild(path.join(root, "plain"));
  assert.equal((await installShippedPin({ store: path.join(root, "store2"), packageRoot: plain })).state, "none");
  assert.equal(fs.existsSync(path.join(root, "store2")), false);
});

test("shipped pin: the qualifier qualifies here even when the shipped pin names the same version", async (t) => {
  const root = scratch(t), store = path.join(root, "store");
  shippedTree(root, store, "0.164.0");
  const repo = fakeRelayBuild(path.join(root, "repo"), "1.0.0", { "dist/backends/codex.js": "", "scripts/codex-qualify/codex-stage2.mjs": "" });
  const s = services(root);
  const svc = { ...s.services, json: async (url: string) => (url.endsWith("/latest") ? { version: "0.164.0" } : s.services.json(url)),
    command: async (bin: string, args: string[]) => {
      if (bin === "/bin/launchctl") return "Aqua\n";
      return s.services.command(bin, args);
    } };
  const r = await runQualifier({ repo, store, scratchRoot: path.join(root, "q"), timeoutMs: 1000 }, { services: svc, supervisor: { check() {}, cancel() {} }, signals: false, oldBin: undefined } as any);
  assert.notEqual(r.state, "unchanged", "the shipped pin naming 0.164.0 does not stop a qualification here");
  assert.ok(s.calls.includes("download https://registry.npmjs.org/@openai/codex/-/codex-0.164.0-darwin-arm64.tgz"), "it acquired the candidate to qualify it");
  assert.equal(r.state, "failed", "the stand-ins stop it before stage 2");
});

test("shipped pin: the maintainer's manifest is written only from a passing qualification here of exactly the build released", async (t) => {
  const root = scratch(t);
  const pkg = fakeRelayBuild(path.join(root, "relay"), "1.2.0");
  const build = buildIdentity(pkg);
  const out = path.join(pkg, SHIPPED_PIN_FILE);
  const refused = (store: string, re: RegExp, what: string) => {
    assert.throws(() => writeShippedPin({ store, packageRoot: pkg }), re, what);
    assert.equal(fs.existsSync(out), false, `${what}: nothing written`);
  };
  let n = 0;
  const store = () => path.join(root, `store-${n++}`);
  // No current pin.
  const empty = store(); P.initStore(empty); refused(empty, /no current pin/, "no current");
  // A release's shipped pin is not a qualification here.
  const sh = store(); shippedTree(root, sh); refused(sh, /shipped pin, not a qualification/, "shipped current");
  // Qualified before build identities (a relay commit), or with another build.
  const old = store(); localTree(root, old, { extra: { relayCommit: commit } }); refused(old, /before relay had build identities/, "relayCommit pin");
  const other = store(); localTree(root, other, { extra: { relayBuild: { ...build, sha256: "d".repeat(64) } } }); refused(other, /not relay 1\.2\.0, build/, "another build");
  // An unversioned (stage2-v1) qualification.
  const legacy = store(); const lv: any = pass("0.169.0"); delete lv.verdictSchema;
  localTree(root, legacy, { verdict: lv, schema: false, extra: { relayBuild: build } }); refused(legacy, /pin verdict invalid|needs a qualification under/, "legacy schema");
  // A verdict that did not pass, sealed with its digest.
  const failing = store(); const fv: any = pass("0.169.0"); fv.items[13].parts.relay.state = "failed";
  localTree(root, failing, { verdict: fv, extra: { relayBuild: build } }); refused(failing, /pin verdict invalid/, "failing verdict");
  // A verdict changed after it was judged.
  const tampered = store(); const tv = localTree(root, tampered, { extra: { relayBuild: build } });
  P.atomicJson(tv.verdictPath, { ...pass("0.169.0"), note: "edited" }); refused(tampered, /verdict digest mismatch/, "tampered verdict");
  // A stage-2 fixture pin.
  const fixture = store(); localTree(root, fixture, { extra: { relayBuild: build, qualificationFixture: true } }); refused(fixture, /fixture/, "fixture pin");
  // The one way: a passing current-schema qualification of this exact build.
  const good = store(); localTree(root, good, { extra: { relayBuild: build } });
  const { pin } = writeShippedPin({ store: good, packageRoot: pkg });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), { format: SHIPPED_PIN_FORMAT, codex: { version: "0.169.0", npmIntegrity: INTEGRITY }, relay: build });
  assert.deepEqual(readShippedPin(pkg), pin);
  assert.doesNotMatch(fs.readFileSync(out, "utf8"), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no path of this machine");
});

test("shipped pin: no code path writes the shipped manifest but writeShippedPin", () => {
  const files: string[] = [];
  for (const dir of ["src", "scripts", "bin", "adapters"]) {
    for (const f of fs.readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]) {
      if (/\.(ts|mjs|js|cjs|sh)$/.test(f) || dir === "bin") files.push(path.join(dir, f));
    }
  }
  const mention = /codex-pin\.json|SHIPPED_PIN_FILE/;
  const mentions = files.filter((f) => fs.statSync(path.join(ROOT, f)).isFile() && mention.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
  // Readers (and messages naming it): relay's runtime check, doctor, the pack guard and the format module.
  assert.deepEqual(mentions.sort(), ["scripts/check-pack.mjs", "scripts/codex-qualify/codex-shipped-pin.mjs", "src/backends/codex-pin.ts", "src/core/shipped-pin.ts", "src/install/doctor.ts"].sort());
  const writes = /writeFileSync|atomicJson|appendFileSync|copyFileSync|renameSync|createWriteStream|cpSync|symlinkSync/;
  for (const f of ["scripts/check-pack.mjs", "src/core/shipped-pin.ts"]) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), writes, `${f} only reads it`);
  for (const f of ["src/backends/codex-pin.ts", "src/install/doctor.ts"]) {
    for (const line of fs.readFileSync(path.join(ROOT, f), "utf8").split("\n")) if (mention.test(line)) assert.doesNotMatch(line, writes, `${f}: ${line.trim()}`);
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), /SHIPPED_PIN_FILE/, `${f} does not even name the file's constant`);
  }
  // In the shipped-pin module, the manifest's name is written in writeShippedPin and nowhere else.
  const source = fs.readFileSync(path.join(ROOT, "scripts/codex-qualify/codex-shipped-pin.mjs"), "utf8");
  const fn = /export function writeShippedPin\([\s\S]*?\n}\n/.exec(source)![0];
  const lines = source.split("\n").filter((l) => /SHIPPED_PIN_FILE/.test(l) && writes.test(l));
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.ok(fn.includes(l), `writes the manifest outside writeShippedPin: ${l.trim()}`);
  // writeShippedPin's evidence: it re-judges the sealed qualification (validateTarget) and binds the build.
  for (const needed of ["validateTarget(store, current)", "isShippedTarget(current)", "CURRENT_VERDICT_SCHEMA", "sameBuild(m.relayBuild, build)", "qualificationFixture"]) assert.ok(fn.includes(needed), needed);
});

test("shipped pin: a pack, and a packed release, carry a shipped pin only for exactly their own build", (t) => {
  const root = scratch(t);
  // npm's prepack (scripts/check-pack.mjs) run in a copy of this build.
  const copy = path.join(root, "relay");
  copyBuild(ROOT, copy);
  fs.mkdirSync(path.join(copy, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "scripts/check-pack.mjs"), path.join(copy, "scripts/check-pack.mjs"));
  const prepack = () => spawnSync(process.execPath, [path.join(copy, "scripts/check-pack.mjs")], { encoding: "utf8", timeout: 60_000 });
  let r = prepack();
  assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /without a shipped Codex pin/);
  fs.writeFileSync(path.join(copy, SHIPPED_PIN_FILE), JSON.stringify(pinFor(copy)));
  r = prepack();
  assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /with its shipped Codex pin, Codex 0\.169\.0/);
  fs.writeFileSync(path.join(copy, SHIPPED_PIN_FILE), JSON.stringify({ ...pinFor(copy), relay: { ...buildIdentity(copy), sha256: "e".repeat(64) } }));
  r = prepack();
  assert.equal(r.status, 1); assert.match(r.stderr, /refusing to pack: codex-pin\.json was qualified with relay .*not this build/);
  // A packed release (npm's package/ layout).
  const pkgRoot = path.join(root, "t", "package");
  fakeRelayBuild(pkgRoot, "1.2.0");
  fs.writeFileSync(path.join(pkgRoot, SHIPPED_PIN_FILE), JSON.stringify(pinFor(pkgRoot)));
  const tgz = path.join(root, "relay.tgz");
  const pack = () => assert.equal(spawnSync("/usr/bin/tar", ["-czf", tgz, "-C", path.dirname(pkgRoot), "package"]).status, 0);
  pack();
  assert.equal(checkTarball(tgz).pin.codex.version, "0.169.0");
  fs.appendFileSync(path.join(pkgRoot, "dist/fixture.txt"), "rebuilt after qualifying");
  pack();
  assert.throws(() => checkTarball(tgz), /shipped pin names relay 1\.2\.0, build .* and it packs relay 1\.2\.0, build /);
});

test("shipped pin: doctor says which pin is in force, run from a package that ships one", (t) => {
  const root = scratch(t), store = path.join(root, "store");
  const copy = path.join(root, "relay");
  copyBuild(ROOT, copy);
  for (const dir of ["adapters", "bin"]) fs.cpSync(path.join(ROOT, dir), path.join(copy, dir), { recursive: true });
  fs.writeFileSync(path.join(copy, SHIPPED_PIN_FILE), JSON.stringify(pinFor(copy)));
  // The installer tests' stand-in for the codex CLI (test/stubs/fake-host-cli.mjs), so that neither
  // doctor nor install codex depends on a Codex installed here (a CI runner has none).
  const codexCli = path.join(root, "codex-cli");
  fs.writeFileSync(codexCli, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "test/stubs/fake-host-cli.mjs")}" codex "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(root, "fake-cli"));
  const config = path.join(root, "relay.json");
  fs.writeFileSync(config, JSON.stringify({ targets: { codex: { bin: codexCli, pin_store: store, home: path.join(root, "codex-home") } } }));
  const env = { ...process.env, HOME: root, RELAY_HOME: path.join(root, "control"), RELAY_CONFIG: config, FAKE_DIR: path.join(root, "fake-cli") };
  const doctor = () => spawnSync(process.execPath, [path.join(copy, "dist/cli.js"), "doctor"], { encoding: "utf8", timeout: 60_000, env }).stdout;
  assert.match(doctor(), /codex pin.*relay install codex --write/, "no pin yet: names the step that puts the shipped one in place");
  shippedTree(root, store);
  assert.match(doctor(), /codex pin\s+shipped: Codex 0\.169\.0 \(npm sha512-.*qualified by the maintainer with relay \d+\.\d+\.\d+, build [a-f0-9]{16}; binary /);
  // A pin qualified here is in force: doctor says so, and that the release ships another.
  fs.rmSync(path.join(store, "current"));
  const local = localTree(root, store, { version: "0.168.0", extra: { relayBuild: buildIdentity(copy) } });
  assert.ok(local.target);
  const out = doctor();
  assert.match(out, /codex pin\s+local: Codex 0\.168\.0, qualified on this Mac at .*\(stage2-v4\)/);
  assert.match(out, /codex shipped pin\s+this release also ships a pin for Codex 0\.169\.0.*relay qualify-codex --shipped/);
  // install codex's dry run says what --write would do about the pin.
  const dry = spawnSync(process.execPath, [path.join(copy, "dist/cli.js"), "install", "codex"], { encoding: "utf8", timeout: 60_000, env });
  assert.match(dry.stdout + dry.stderr, /with --write, it would also put this release's shipped Codex pin in place \(Codex 0\.169\.0/);
});

test("shipped pin: install codex --write registers, then ends with an error when its shipped pin cannot be put in place", (t) => {
  const root = scratch(t), store = path.join(root, "store");
  const copy = path.join(root, "relay");
  copyBuild(ROOT, copy);
  for (const dir of ["adapters", "bin", "scripts"]) fs.cpSync(path.join(ROOT, dir), path.join(copy, dir), { recursive: true });
  // A pin for another build of relay: refused before any download, as a package changed after its release is.
  fs.writeFileSync(path.join(copy, SHIPPED_PIN_FILE), JSON.stringify({ ...pinFor(copy), relay: { ...buildIdentity(copy), sha256: "e".repeat(64) } }));
  const home = path.join(root, "home"), bin = path.join(root, "bin"), fake = path.join(root, "fake");
  for (const d of [home, bin, fake]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "test", "stubs", "fake-host-cli.mjs")}" codex "$@"\n`, { mode: 0o755 });
  const config = path.join(root, "relay.json");
  fs.writeFileSync(config, JSON.stringify({ targets: { codex: { pin_store: store, home: path.join(root, "codex-home") } } }));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(RELAY_|CODEX_|FAKE_)/.test(k)) env[k] = v;
  Object.assign(env, { HOME: home, CODEX_HOME: path.join(home, ".codex"), PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: fake, RELAY_HOME: path.join(root, "control"), RELAY_CONFIG: config });
  const r = spawnSync(process.execPath, [path.join(copy, "dist/cli.js"), "install", "codex", "--write", "--no-link"], { encoding: "utf8", timeout: 120_000, env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Putting the shipped Codex pin in place failed: this relay's shipped pin was qualified with relay/);
  assert.match(r.stderr, /relay install codex: registered, but Codex is not ready: this release's shipped Codex pin was not put in place \(see Codex pin above\)/);
  assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.relay\]/, "the registration is in place");
});

test("shipped pin: relay qualify-codex --shipped replaces a local pin, takes no other flag, and ends with relay's own answer", async (t) => {
  const root = scratch(t), store = path.join(root, "store"), pkg = shipPackage(root);
  const lines: string[] = [], calls: any[] = [];
  const deps = {
    root: pkg, config: () => cfgFor(root, store), launched: () => null, out: (l: string) => lines.push(l),
    load: async () => { throw new Error("the qualifier must not load"); },
    loadShipped: async () => ({ installShippedPin: async (input: any) => { calls.push(input); return installShippedPin({ ...input, services: services(root).services, supervisor: { check() {}, cancel() {} } }); } }),
  };
  setRelayPackageRootForTests(pkg);
  for (const args of [["--shipped", "--version", "0.169.0"], ["--shipped", "--force"]]) {
    const before = lines.length;
    assert.equal(await qualifyCodex(args, deps as any), 2);
    assert.match(lines.slice(before).join("\n"), /--shipped takes no --version or --force/);
  }
  assert.match(QUALIFY_CODEX_USAGE, /\| --shipped/);
  localTree(root, store, { extra: { relayBuild: buildIdentity(pkg) } });
  const code = await qualifyCodex(["--shipped"], deps as any);
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(calls, [{ store, packageRoot: pkg, replaceLocal: true }]);
  const text = lines.join("\n");
  assert.match(text, /Put this release's shipped Codex pin in place: Codex 0\.169\.0 .*the stage-2 qualification is the maintainer's/);
  assert.match(text, /relay will run Codex from the qualified pin .*\(shipped: Codex 0\.169\.0/);
});

test("shipped pin: relay upgraded in place under a running process refuses the new release's pin (review r_96c6b786 X1)", (t) => {
  const root = scratch(t), store = path.join(root, "store"), pkg = shipPackage(root);
  shippedTree(root, store);
  setRelayPackageRootForTests(pkg);
  // This process "loads" release A: its first freeze takes A's build identity.
  assert.equal(codexPinInfo(freezeCodexConfig(cfgFor(root, store)))!.kind, "shipped");
  // An in-place upgrade to B: new code and B's own pin, matching each other, same Codex.
  fs.writeFileSync(path.join(pkg, "dist/fixture.txt"), "release B");
  fs.writeFileSync(path.join(pkg, SHIPPED_PIN_FILE), JSON.stringify(pinFor(pkg)));
  assert.notEqual(readShippedPin(pkg)!.relay.sha256, undefined);
  // A fresh config, so that no frozen shortcut applies: the pin and the disk agree, the process does not.
  assert.throws(() => freezeCodexConfig(cfgFor(root, store)), /relay was changed on disk after this process started: it runs relay 1\.2\.0, build [a-f0-9]{16}, and the disk now holds relay 1\.2\.0, build [a-f0-9]{16}.*Restart the session/);
  // A local pin is not bound to the running build, so the same upgrade leaves one usable.
  const s2 = path.join(root, "store2");
  localTree(root, s2);
  assert.equal(codexPinInfo(freezeCodexConfig(cfgFor(root, s2)))!.kind, "local");
});

test("shipped pin: a shipped-pin module that fails to load is the pin step's failure, not the install's (review r_96c6b786 C2)", async (t) => {
  const root = scratch(t), store = path.join(root, "store"), pkg = shipPackage(root);
  const lines: string[] = [];
  const deps = {
    root: pkg, config: () => cfgFor(root, store), launched: () => null, out: (l: string) => lines.push(l),
    load: async () => { throw new Error("the qualifier must not load"); },
    loadShipped: async () => { throw new Error("Cannot find module codex-shipped-pin.mjs"); },
  };
  setRelayPackageRootForTests(pkg);
  assert.equal(await qualifyCodex(["--shipped"], deps as any), 1);
  assert.match(lines.join("\n"), /Putting the shipped Codex pin in place failed: Cannot find module/);
  assert.match(lines.join("\n"), /relay refuses Codex: no valid qualified pin/);
});
