import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scan } from "../scripts/js-canon.mjs";
import "./helpers.ts";
import * as P from "../scripts/codex-qualify/codex-pin-store.mjs";
import { acquire, liveServices, NOTIFICATION_SCRIPT, runQualifier, runRollback, validateConfig, verifyIntegrity } from "../scripts/codex-qualify/codex-qualifier.mjs";
import { parseProcessTable, processTable, ProcessSupervisor } from "../scripts/codex-qualify/codex-qualifier-process.mjs";
import { defaultLabel, installQualifier, isQualifierAgent, renderPlist, validLabel } from "../scripts/codex-qualify/install-codex-qualifier.mjs";
import { scratchEnv } from "../scripts/codex-qualify/scratch-env.mjs";
import { stageQualificationPin } from "../scripts/codex-qualify/codex-stage2-pin.mjs";
import { freezeCodexConfig } from "../dist/backends/codex-pin.js";
import { withDefaults } from "../dist/core/config.js";
import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { isGroupSignalRefusal, sendGroupSignal } from "../dist/core/procs.js";
import { buildIdentity } from "../dist/core/build-identity.js";
import { fakeRelayBuild } from "./fake-build.ts";

const scripts = path.resolve(import.meta.dirname, "../scripts/codex-qualify");
const integrity = "sha512-" + crypto.createHash("sha512").update("fixture tarball").digest("base64");
const commit = "a".repeat(40);
const pass = (version = "0.164.0", verdictSchema = P.CURRENT_VERDICT_SCHEMA) => ({
  ok: true, state: "passed", relayPath: "present", version, verdictSchema,
  items: Object.fromEntries(Object.entries(P.VERDICT_SCHEMAS[verdictSchema]).map(([id, names]) => [id, { state: "passed", parts: Object.fromEntries(names.map((name: string) => [name, { state: "passed", why: [] }])) }])),
});
function legacyPass(version = "0.164.0") {
  const v: any = pass(version, P.LEGACY_VERDICT_SCHEMA);
  delete v.verdictSchema;
  return v;
}
function writable(dir: string) {
  fs.chmodSync(dir, 0o700);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) writable(path.join(dir, entry.name));
}
function scratch(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rq-")));
  t.after(() => { writable(root); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function tree(root: string, version = "0.164.0") {
  const vendor = fs.mkdtempSync(path.join(root, "vendor-"));
  fs.mkdirSync(path.join(vendor, "bin"));
  fs.mkdirSync(path.join(vendor, "codex-resources"));
  fs.writeFileSync(path.join(vendor, "bin/codex"), `fixture binary ${version}`, { mode: 0o755 });
  fs.writeFileSync(path.join(vendor, "codex-resources/catalog.json"), "fixture resource");
  fs.writeFileSync(path.join(vendor, "codex-package.json"), JSON.stringify({ version, entrypoint: "bin/codex" }));
  const verdictPath = path.join(root, `${version}-verdict.json`);
  P.atomicJson(verdictPath, pass(version));
  const manifest = { version, binarySha256: P.sha256(path.join(vendor, "bin/codex")), npmIntegrity: integrity, codesign: { teamId: P.TEAM_ID, identity: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)" }, sourceCommit: commit, qualifiedAt: new Date().toISOString(), verdictPath, verdictSchema: P.CURRENT_VERDICT_SCHEMA, verdictSha256: P.sha256(verdictPath) };
  return { vendor, manifest };
}
function pin(root: string, store: string, version: string) {
  const { vendor, manifest } = tree(root, version);
  return P.publishTree(store, vendor, manifest);
}
// Reproduce a pre-schema publication without passing through today's publication checks.
function legacyPin(root: string, store: string, version = "0.164.0") {
  const { vendor, manifest } = tree(root, version);
  const { verdictSchema: _schema, verdictSha256: _digest, ...legacyManifest } = manifest;
  P.atomicJson(manifest.verdictPath, legacyPass(version));
  const target = `versions/${version}-${manifest.binarySha256.slice(0, 12)}`;
  const dest = path.join(store, target);
  fs.cpSync(vendor, dest, { recursive: true });
  P.atomicJson(path.join(dest, "manifest.json"), legacyManifest);
  const seal = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) seal(file);
      else fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o555 : 0o444);
    }
    fs.chmodSync(dir, 0o555);
  };
  seal(dest);
  return target;
}

test("pinned Codex: historical schemas are fixed frozen requirements, independent of the live driver", () => {
  // Literal snapshot of the 1.1.0 requirements at 237bd74, including escalation parts.
  assert.deepEqual(P.VERDICT_SCHEMAS[P.LEGACY_VERDICT_SCHEMA], {
    1: ["codex", "control", "relay"], 2: ["codex"], 3: ["outside", "settings", "relay"],
    4: ["codex", "relay"], 5: ["codex"], 6: ["codex", "relay"], 7: ["codex", "relay"],
    8: ["relay"], 9: ["relay"], 10: ["tools", "isolate", "relay"],
    11: ["subagent", "resume", "unbound", "control", "selfStart", "noLocal", "goalControl", "relay"],
    12: ["control", "codex"], 13: ["codex", "relay"],
    14: ["direct", "code_mode_only", "long", "relay"], 15: ["startup", "credentials", "midTurn"],
    16: ["coexist", "admission"], 17: ["codex", "control"], 18: ["reconnect", "eof"],
    19: ["sessions", "retry"], 20: ["relay"], 21: ["disarmed"], 22: ["v1", "v2"],
    23: ["unit", "surfaces", "freshResume", "overlay"],
    24: ["unit", "worker", "cancel", "http", "code", "mismatch"],
    25: ["unit"], 26: ["unit", "hostRoots", "crash"],
    27: ["unit", "planner", "kernel", "profiles"],
    28: ["unit", "addresses", "worker", "public", "crossJobCrash"],
    29: ["unit", "decisions", "local", "nativeProfiles"], 30: ["long"],
    31: ["unit", "executor", "live"], 32: ["unit", "accounting", "planner", "kernel", "worker"],
  });
  assert.equal(Object.isFrozen(P.VERDICT_SCHEMAS), true);
  for (const parts of Object.values(P.VERDICT_SCHEMAS)) {
    assert.equal(Object.isFrozen(parts), true);
    for (const names of Object.values(parts)) assert.equal(Object.isFrozen(names), true);
  }
  assert.ok(P.EXPECTED_PARTS[10].includes("effort"));
});

test("pinned Codex: exact complete verdict passes; every incomplete state fails", () => {
  assert.equal(P.judgeVerdict(pass(), "0.164.0").ok, true);
  for (const mutate of [
    (v: any) => { v.ok = false; }, (v: any) => { v.state = "not run"; },
    (v: any) => { v.version = "0.165.0"; }, (v: any) => { v.relayPath = "pending integration"; },
    (v: any) => { delete v.items[30]; }, (v: any) => { v.items[31] = v.items[1]; },
    (v: any) => { v.items = []; }, (v: any) => { v.items[1].parts = {}; },
    (v: any) => { v.items[1].parts = []; }, (v: any) => { v.items[1].parts = null; },
    (v: any) => { v.items[1].state = "failed"; }, (v: any) => { v.items[1].parts.codex = null; },
    (v: any) => { delete v.items[1].parts.control; }, (v: any) => { delete v.items[13].parts.relay; },
    (v: any) => { v.items[1].parts.control = { state: "not run" }; },
    (v: any) => { v.items[1].parts.relay.state = "pending integration"; },
    (v: any) => { delete v.items[15].parts.midTurn; },
    (v: any) => { v.items[20].parts.relay.state = "not run"; },
    (v: any) => { delete v.items[22].parts.v2; },
    (v: any) => { delete v.items[10].parts.effort; },
    (v: any) => { v.verdictSchema = "unknown"; },
  ]) { const v = pass(); mutate(v); assert.equal(P.judgeVerdict(v, "0.164.0").ok, false); }
  assert.equal(P.judgeVerdict(null, "0.164.0").ok, false);
});

test("pinned Codex: an unversioned 1.1.0 receipt validates only under its complete passing baseline", (t) => {
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  const target = legacyPin(root, store);
  const manifest = P.validateTarget(store, target);
  const v = JSON.parse(fs.readFileSync(manifest.verdictPath, "utf8"));
  assert.equal(manifest.verdictSchema, undefined);
  assert.equal(manifest.verdictSha256, undefined);
  assert.equal(v.verdictSchema, undefined);
  assert.equal(v.items[10].parts.effort, undefined);
  assert.equal(P.judgeVerdict(v, manifest.version, P.LEGACY_VERDICT_SCHEMA).ok, true);
  assert.match(P.judgeVerdict(v, manifest.version).why.join(), /10.effort evidence missing/);
  for (const mutate of [
    (v: any) => { delete v.items[1].parts.control; },
    (v: any) => { delete v.items[13].parts.relay; },
    (v: any) => { delete v.items[30]; },
    (v: any) => { v.items[10].parts.tools.state = "not run"; },
    (v: any) => { v.items[10].parts.extra = { state: "failed" }; },
  ]) {
    const incomplete = structuredClone(v); mutate(incomplete);
    P.atomicJson(manifest.verdictPath, incomplete);
    assert.throws(() => P.validateTarget(store, target), /pin verdict invalid/);
  }
});

test("pinned Codex: unknown schemas and receipt/manifest schema disagreements fail closed", (t) => {
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  const target = legacyPin(root, store), manifest = P.validateTarget(store, target);
  for (const verdictSchema of ["stage2-v0", "unknown", "__proto__", "constructor", null, {}]) {
    P.atomicJson(manifest.verdictPath, { ...legacyPass(), verdictSchema });
    assert.throws(() => P.validateTarget(store, target), /unknown verdict schema/);
    assert.equal(P.judgeVerdict(pass(), "0.164.0", verdictSchema).ok, false);
  }
  P.atomicJson(manifest.verdictPath, pass());
  // A current verdict carries item 33, which v1 lacks, so the v1 item set already refuses it.
  assert.throws(() => P.validateTarget(store, target), /schema disagrees with manifest|expected exactly items 1,[\d,]*,32\b/, "a mutable verdict cannot change an unversioned manifest's v1 baseline");
  const fresh = tree(root, "0.165.0");
  assert.throws(() => P.validateManifest({ ...fresh.manifest, verdictSchema: "unknown" }), /unknown verdict schema/);
  assert.throws(() => P.validateManifest({ ...fresh.manifest, verdictSha256: undefined }), /schema\/digest/);
  assert.throws(() => P.validateManifest({ ...fresh.manifest, verdictSchema: undefined }), /unknown verdict schema/);
  const oldClaim = { ...pass("0.165.0"), verdictSchema: P.LEGACY_VERDICT_SCHEMA };
  P.atomicJson(fresh.manifest.verdictPath, oldClaim);
  P.atomicJson(path.join(fresh.vendor, "manifest.json"), { ...fresh.manifest, verdictSha256: P.sha256(fresh.manifest.verdictPath) });
  assert.throws(() => P.readManifest(fresh.vendor), /schema disagrees with manifest/);
});

test("pinned Codex: new publications seal verdict bytes and schema in their manifest", (t) => {
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  const target = pin(root, store, "0.164.0"), manifest = P.validateTarget(store, target);
  assert.equal(manifest.verdictSchema, P.CURRENT_VERDICT_SCHEMA);
  assert.equal(manifest.verdictSha256, P.sha256(manifest.verdictPath));
  assert.equal(fs.statSync(path.join(store, target, "manifest.json")).mode & 0o222, 0);
  for (const mutate of [
    (v: any) => { v.verdictSchema = P.LEGACY_VERDICT_SCHEMA; delete v.items[10].parts.effort; },
    (v: any) => { delete v.verdictSchema; delete v.items[10].parts.effort; },
    (v: any) => { v.items[10].parts.tools.state = "failed"; },
  ]) {
    const v = pass(); mutate(v); P.atomicJson(manifest.verdictPath, v);
    assert.throws(() => P.validateTarget(store, target), /pin verdict digest mismatch/);
    assert.throws(() => P.promote(store, target), /pin verdict digest mismatch/);
  }
  const fresh = tree(root, "0.165.0");
  assert.throws(() => P.publishTree(store, fresh.vendor, { ...fresh.manifest, verdictSchema: P.LEGACY_VERDICT_SCHEMA }), /current verdict schema/);
});

test("pinned Codex: a stage2-v2 receipt without prefetch validates as stored, while a new verdict needs prefetch", (t) => {
  assert.equal(P.CURRENT_VERDICT_SCHEMA, "stage2-v4");
  assert.deepEqual(P.VERDICT_SCHEMAS["stage2-v4"][33], ["codex"], "item 33: the keychain under the never floor, Codex only (its Claude side adds no pin dependency)");
  assert.deepEqual(P.VERDICT_SCHEMAS["stage2-v4"][12], P.VERDICT_SCHEMAS["stage2-v3"][12]);
  assert.equal(P.VERDICT_SCHEMAS["stage2-v3"][33], undefined, "a stored stage2-v3 pin stays valid without item 33");
  assert.deepEqual(P.VERDICT_SCHEMAS["stage2-v1"][12], ["control", "codex"]);
  assert.deepEqual(P.VERDICT_SCHEMAS["stage2-v2"][12], ["control", "codex"]);
  assert.deepEqual(P.VERDICT_SCHEMAS["stage2-v3"][12], ["control", "codex", "prefetch"]);
  assert.deepEqual(P.VERDICT_SCHEMAS["stage2-v3"][10], P.VERDICT_SCHEMAS["stage2-v2"][10]);
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  // Reproduce a 1.1.1 publication (schema stage2-v2, digest sealed) without today's publication checks.
  const { vendor, manifest } = tree(root, "0.164.0");
  const v2 = pass("0.164.0", "stage2-v2");
  assert.equal(v2.items[12].parts.prefetch, undefined);
  P.atomicJson(manifest.verdictPath, v2);
  const target = `versions/0.164.0-${manifest.binarySha256.slice(0, 12)}`;
  const dest = path.join(store, target);
  fs.cpSync(vendor, dest, { recursive: true });
  P.atomicJson(path.join(dest, "manifest.json"), { ...manifest, verdictSchema: "stage2-v2", verdictSha256: P.sha256(manifest.verdictPath) });
  const seal = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) seal(file);
      else fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o555 : 0o444);
    }
    fs.chmodSync(dir, 0o555);
  };
  seal(dest);
  const stored = P.validateTarget(store, target);
  assert.equal(stored.version, "0.164.0");
  assert.equal(stored.verdictSchema, "stage2-v2");
  assert.equal(P.judgeVerdict(v2, "0.164.0", "stage2-v2").ok, true);
  const judged = P.judgeVerdict(v2, "0.164.0");
  assert.equal(judged.ok, false);
  assert.ok(judged.why.includes("item 12.prefetch evidence missing"));
  assert.equal(P.judgeVerdict(pass("0.164.0"), "0.164.0").ok, true);
});

test("pinned Codex: SRI fixture detects tampering and rejects non-sha512 metadata", () => {
  verifyIntegrity(Buffer.from("fixture tarball"), integrity);
  assert.throws(() => verifyIntegrity(Buffer.from("changed"), integrity), /SRI mismatch/);
  assert.throws(() => verifyIntegrity(Buffer.from("fixture tarball"), "sha256-abc"), /sha512/);
});

test("pinned Codex: manifests require integrity, identity, source and evidence", (t) => {
  const root = scratch(t), { vendor, manifest } = tree(root);
  P.atomicJson(path.join(vendor, "manifest.json"), manifest);
  assert.deepEqual(P.readManifest(vendor), manifest);
  for (const patch of [{ codesign: { teamId: "evil", identity: "evil" } }, { verdictPath: "relative" }, { binarySha256: "no" }, { npmIntegrity: "sha256-abc" }, { sourceCommit: "tag" }, { qualifiedAt: "never" }]) assert.throws(() => P.validateManifest({ ...manifest, ...patch }), /manifest/);
  fs.writeFileSync(path.join(vendor, "bin/codex"), "tampered");
  assert.throws(() => P.readManifest(vendor), /digest mismatch/);
});

test("pinned Codex: publish retains full tree, seals it, and reuses immutable identical pins", (t) => {
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  const { vendor, manifest } = tree(root);
  const target = P.publishTree(store, vendor, manifest);
  assert.match(target, /^versions\/0\.164\.0-[a-f0-9]{12}$/);
  assert.equal(fs.readFileSync(path.join(store, target, "codex-resources/catalog.json"), "utf8"), "fixture resource");
  assert.equal(fs.statSync(path.join(store, target, "bin/codex")).mode & 0o777, 0o555);
  assert.equal(fs.statSync(path.join(store, target)).mode & 0o222, 0);
  assert.equal(P.publishTree(store, vendor, manifest), target);
  assert.throws(() => P.validateTarget(store, "../outside"), /relative/);
  fs.chmodSync(path.join(store, target), 0o755); // Interrupted between publication rename and seal.
  assert.throws(() => P.promote(store, target), /not sealed/);
  assert.equal(P.pointer(store, "current"), null);
});

test("pinned Codex: vendor symlinks cannot escape immutable store", (t) => {
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  const { vendor, manifest } = tree(root);
  fs.symlinkSync(root, path.join(vendor, "outside"));
  assert.throws(() => P.publishTree(store, vendor, manifest), /symlinks/);
  assert.equal(P.pointer(store, "current"), null);
});

test("pinned Codex: bootstrap, promotion and binary-only rollback atomically replace pointers", (t) => {
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  const a = pin(root, store, "0.164.0"), b = pin(root, store, "0.165.0");
  P.promote(store, a);
  assert.equal(P.pointer(store, "previous"), null);
  assert.equal(P.promote(store, a), null);
  P.promote(store, b, "promote", () => { assert.equal(P.pointer(store, "previous"), a); assert.equal(P.pointer(store, "current"), a); });
  const home = path.join(root, "relay-codex-home"); fs.mkdirSync(home); fs.writeFileSync(path.join(home, "state.sqlite"), "upgraded database fixture");
  assert.equal(P.rollback(store)?.to, a);
  assert.equal(P.pointer(store, "current"), a);
  assert.equal(P.pointer(store, "previous"), b);
  assert.equal(fs.readFileSync(path.join(home, "state.sqlite"), "utf8"), "upgraded database fixture");
  assert.deepEqual(P.readJournal(store).map((r: any) => r.action), ["promote", "promote", "rollback"]);
  assert.equal(P.rollback(store)?.to, b);
  assert.equal(fs.readdirSync(store).some((f) => f.startsWith(".current-") || f.startsWith(".previous-")), false);
});

test("pinned Codex: interrupted promotion before current swap restores previous", (t) => {
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  const a = pin(root, store, "0.164.0"), b = pin(root, store, "0.165.0"), c = pin(root, store, "0.166.0");
  P.promote(store, a); P.promote(store, b);
  assert.throws(() => P.promote(store, c, "promote", () => { throw new Error("logout"); }), /logout/);
  assert.equal(P.pointer(store, "current"), b);
  P.recoverTransaction(store);
  assert.equal(P.pointer(store, "previous"), a);
  assert.equal(P.readJournal(store).length, 2);
});

test("pinned Codex: interrupted journal append is recovered once after current commit", (t) => {
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  const a = pin(root, store, "0.164.0"), b = pin(root, store, "0.165.0"); P.promote(store, a);
  const tx = { id: "interrupted", action: "promote", at: new Date().toISOString(), from: a, to: b, previousBefore: null };
  P.atomicJson(path.join(store, "pending.json"), tx); P.swapPointer(store, "previous", a); P.swapPointer(store, "current", b);
  P.recoverTransaction(store); P.recoverTransaction(store);
  assert.equal(P.readJournal(store).length, 2);
  assert.equal(P.readJournal(store)[1].id, "interrupted");
});

test("pinned Codex: malformed journals and unrecorded rollback targets fail closed", (t) => {
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  assert.throws(() => P.rollback(store), /no previous/);
  const a = pin(root, store, "0.164.0"), b = pin(root, store, "0.165.0"); P.promote(store, a); P.promote(store, b);
  P.swapPointer(store, "previous", b);
  assert.throws(() => P.rollback(store), /recorded/);
  fs.appendFileSync(path.join(store, "journal.jsonl"), '{"torn":');
  assert.throws(() => P.readJournal(store), /truncated/);
  assert.throws(() => P.promote(store, a), /truncated/);
  assert.equal(P.pointer(store, "current"), b);
});

test("pinned Codex: single updater lock excludes rollback and never steals a live owner", (t) => {
  const root = scratch(t); P.initStore(root);
  const release = P.acquireLock(root)!;
  assert.equal(P.acquireLock(root, { staleMs: 0 }), null);
  assert.throws(() => runRollback({ repo: root, store: root, scratchRoot: root }), /running/);
  release();
  const next = P.acquireLock(root)!; next();
  assert.equal(fs.existsSync(path.join(root, "lock")), false);
});

test("pinned Codex: stale dead and abandoned partial locks recover; recent ones stay busy", (t) => {
  const root = scratch(t); P.initStore(root);
  const lock = path.join(root, "lock"); fs.mkdirSync(lock);
  assert.equal(P.acquireLock(root), null);
  fs.utimesSync(lock, 1, 1);
  const release = P.acquireLock(root, { alive: () => false })!; assert.equal(typeof release, "function"); release();
  fs.mkdirSync(lock); P.atomicJson(path.join(lock, "owner.json"), { pid: 123, token: "dead" }); fs.utimesSync(lock, 1, 1);
  const again = P.acquireLock(root, { alive: () => false })!; again();
  assert.equal(fs.readdirSync(path.join(root, "staging")).filter((n) => n.startsWith("stale-lock-")).length, 2);
});

test("pinned Codex: concurrent stale-lock recoverers admit exactly one updater", async (t) => {
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  fs.mkdirSync(path.join(store, "lock")); fs.utimesSync(path.join(store, "lock"), 1, 1);
  const modulePath = path.join(scripts, "codex-pin-store.mjs");
  const worker = `import fs from 'node:fs';import {acquireLock} from ${JSON.stringify(modulePath)};
    const [root,store,id]=process.argv.slice(1);
    const wait=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
    fs.writeFileSync(root+'/ready-'+id,'');while(!fs.existsSync(root+'/go'))wait();
    const release=acquireLock(store);fs.writeFileSync(root+'/result-'+id,release?'owned':'busy');
    if(release){while(!fs.existsSync(root+'/finish'))wait();release();}`;
  const supervisors = [new ProcessSupervisor(root), new ProcessSupervisor(root)];
  const jobs = supervisors.map((s, i) => s.run(process.execPath, ["--input-type=module", "-e", worker, root, store, String(i)], { timeoutMs: 10_000 }));
  const untilFiles = async (prefix: string) => {
    const deadline = Date.now() + 5000;
    while (![0, 1].every((i) => fs.existsSync(path.join(root, prefix + i)))) {
      if (Date.now() > deadline) throw new Error(`workers did not reach ${prefix}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  try {
    await untilFiles("ready-"); fs.writeFileSync(path.join(root, "go"), "");
    await untilFiles("result-");
    const results = [0, 1].map((i) => fs.readFileSync(path.join(root, `result-${i}`), "utf8"));
    assert.deepEqual(results.sort(), ["busy", "owned"]);
  } finally { fs.writeFileSync(path.join(root, "finish"), ""); await Promise.all(jobs); }
});

test("pinned Codex: scratch environments reject missing roots, external homes and symlink aliases", (t) => {
  const root = scratch(t), outside = scratch(t);
  assert.throws(() => scratchEnv(undefined), /root/);
  assert.throws(() => scratchEnv(root, { CODEX_HOME: outside }), /escapes/);
  assert.throws(() => scratchEnv(root, { HOME: undefined }), /absolute/);
  fs.symlinkSync(outside, path.join(root, "alias"));
  assert.throws(() => scratchEnv(root, { HOME: path.join(root, "alias/future") }), /escapes/);
  const env = scratchEnv(root); assert.equal(env.HOME, path.join(root, "home")); assert.equal(env.CODEX_HOME, path.join(root, "codex-home"));
  assert.equal("OPENAI_API_KEY" in env, false);
});

/** A token audit catches multiline/aliased calls, including diagnostic children and --version. */
function envViolations(file: string, text: string) {
  const tokens = scan(text).map((t: any) => t.v), calls = new Set<string>(), failures: string[] = [];
  function fields(parts: string[]) {
    const result: string[][] = []; let field: string[] = [], depth = 0;
    for (const token of parts) {
      if (token === "," && depth === 0) { result.push(field); field = []; continue; }
      field.push(token);
      if (["(", "{", "["].includes(token)) depth++;
      if ([")", "}", "]"].includes(token)) depth--;
    }
    if (field.length) result.push(field);
    return result;
  }
  for (let i = 0; i < tokens.length; i++) if (/^['"](?:node:)?child_process['"]$/.test(tokens[i])) {
    let start = i - 1; while (start >= 0 && tokens[start] !== "import" && tokens[start] !== ";") start--;
    const declaration = tokens.slice(start, i);
    if (declaration[0] !== "import" || declaration[1] !== "{" || declaration.at(-2) !== "}" || declaration.at(-1) !== "from") { failures.push("unsupported child_process import"); continue; }
    for (const field of fields(declaration.slice(2, -2))) calls.add(field.at(-1)!);
  }
  // Native process calls can be supplied through a defaulted test seam (inspect = spawnSync).
  for (let i = 0; i < tokens.length - 3; i++) if (tokens[i + 1] === "=" && calls.has(tokens[i + 2]) && tokens[i + 3] !== "(") calls.add(tokens[i]);
  for (let i = 0; i < tokens.length; i++) if (calls.has(tokens[i]) && tokens[i + 1] === "(") {
    let end = i + 2, depth = 1;
    for (; end < tokens.length && depth; end++) { if (tokens[end] === "(") depth++; if (tokens[end] === ")") depth--; }
    const options = fields(tokens.slice(i + 2, end - 1))[2];
    const properties = options?.[0] === "{" && options?.at(-1) === "}" ? fields(options.slice(1, -1)) : [];
    const env = properties.filter((p) => p[0] === "env");
    if (env.length !== 1 || env[0][1] !== ":" || !["stageChildEnv", "scratchEnv"].includes(env[0][2]) || env[0][3] !== "(") failures.push(`${file}: ${tokens[i]} lacks explicit scratch env`);
    if (properties.some((p) => p[0] === "...")) failures.push("options spread can override env");
  }
  return failures;
}

test("pinned Codex: every stage2 and qualifier native spawn explicitly validates scratch HOME/CODEX_HOME/TMPDIR", () => {
  for (const file of ["codex-stage2.mjs", "codex-qualifier.mjs", "codex-qualifier-process.mjs", "install-codex-qualifier.mjs", "codex-pin-store.mjs", "scratch-env.mjs"]) {
    assert.deepEqual(envViolations(file, fs.readFileSync(path.join(scripts, file), "utf8")), [], file);
  }
  assert.equal(envViolations("regression", 'import { execFileSync as run } from "node:child_process"; run(bin, ["--version"], { env: { PATH: SYSTEM_PATH } });').length, 1);
  assert.equal(envViolations("regression", 'import { spawn } from "node:child_process"; spawn(bin, args);').length, 1);
  assert.equal(envViolations("regression", 'import { spawnSync } from "node:child_process"; function look(inspect = spawnSync) { inspect(bin, args, {}); }').length, 1);
});

test("pinned Codex: watchdog tracks detached groups and reparented descendants and kills all on cancellation", async (t) => {
  const root = scratch(t);
  let rows = [
    { pid: 60001, ppid: 1, pgid: 60001, start: "one", command: `executor HOME=${root}/home` },
    { pid: 60002, ppid: 60001, pgid: 60001, start: "two", command: "tool child" },
    { pid: 60003, ppid: 1, pgid: 60003, start: "three", command: `detached TMPDIR=${root}/tmp` },
    { pid: 60004, ppid: 1, pgid: 60004, start: "other", command: "unrelated process" },
  ];
  const killed: [number, string][] = [];
  const supervisor = new ProcessSupervisor(root, { table: () => rows, graceMs: 1, kill: (pid: number, signal: string) => { killed.push([pid, signal]); if (signal === "SIGKILL") rows = rows.filter((r) => pid < 0 ? r.pgid !== -pid : r.pid !== pid); } });
  assert.equal(supervisor.scan().length, 3);
  rows[1].ppid = 1; // Known child survives reparenting even if its argv omits the scratch marker.
  supervisor.cancel("logout"); assert.throws(() => supervisor.check(), /logout/);
  await supervisor.terminate();
  assert.deepEqual(rows.map((r) => r.pid), [60004]);
  assert.ok(killed.some(([pid, sig]) => pid === 60003 && sig === "SIGKILL"));
  assert.ok(killed.some(([pid, sig]) => pid === 60002 && sig === "SIGKILL"));
});

test("pinned Codex: watchdog refuses qualification when process inventory is unavailable", async (t) => {
  const root = scratch(t), supervisor = new ProcessSupervisor(root, { table: () => { throw new Error("ps denied"); } });
  await assert.rejects(supervisor.run("/does/not/run", [], { inspect: true }), /ps denied/);
});

test("pinned Codex: a failed cleanup group kill keeps the error that started cleanup", async (t) => {
  const root = scratch(t);
  const eperm = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  // The group still shows a live member, so the EPERM is a real refusal and must surface.
  let group = 0;
  const supervisor = new ProcessSupervisor(root, {
    table: () => group ? [{ pid: group, ppid: 1, pgid: group, stat: "S", start: "one", command: "still running" }] : [],
    kill: (pid: number) => { if (pid < 0) { group = -pid; throw eperm(); } },
  });
  await assert.rejects(supervisor.run("/bin/sh", ["-c", "exit 3"], {}), (err: any) => {
    assert.ok(err instanceof AggregateError, String(err));
    assert.match(err.message, /qualification failed \(\/bin\/sh exited 3/);
    assert.match(err.message, /group kill failed: kill EPERM/);
    return true;
  });
});

test("pinned Codex: a group kill answered with EPERM counts as done only when the group holds just zombies", (t) => {
  const root = scratch(t);
  const pgid = 62001, eperm = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  const member = (stat: string) => ({ pid: 62002, ppid: 1, pgid, stat, start: "two", command: "member" });
  const make = (table: () => any[]) => new ProcessSupervisor(root, { table, kill: (pid: number) => { if (pid < 0) throw eperm(); } });
  assert.doesNotThrow(() => make(() => [member("Z")]).signal(-pgid, "SIGKILL"), "zombie-only group is gone");
  assert.doesNotThrow(() => make(() => []).signal(-pgid, "SIGKILL"), "empty group is gone");
  assert.throws(() => make(() => [member("Z"), { ...member("S"), pid: 62003 }]).signal(-pgid, "SIGKILL"), /kill EPERM/);
  assert.throws(() => make(() => { throw new Error("ps timed out"); }).signal(-pgid, "SIGKILL"), /kill EPERM/);
  // A pid (not group) EPERM is never reinterpreted.
  assert.throws(() => new ProcessSupervisor(root, { table: () => [], kill: () => { throw eperm(); } }).signal(62002, "SIGKILL"), /kill EPERM/);
});

test("pinned Codex: watchdog group kills, pid cleanup and non-inspecting fallback refuse ancestor targets", async (t) => {
  const root = scratch(t), pgid = 61001, start = "Thu Jan 1 00:00:00 1970";
  const signals: [number, string][] = [];
  const inspect = t.mock.method(childProcess, "spawnSync", (() => ({ status: 0, stdout: `${process.pid} ${pgid} 61003\n${pgid} 1 ${pgid}\n` })) as typeof childProcess.spawnSync);
  t.mock.method(process.stderr, "write", (() => true) as typeof process.stderr.write);
  syncBuiltinESMExports();
  try {
    const rows = [{ pid: pgid, ppid: 1, pgid, start, command: `HOME=${root}/home` }, { pid: 61002, ppid: pgid, pgid: 61002, start, command: "detached child" }];
    const make = () => new ProcessSupervisor(root, { table: () => rows, kill: (pid: number, sig: string) => signals.push([pid, sig]) });
    const group = make(); group.leaders.add(pgid);
    assert.throws(() => group.killGroups(), isGroupSignalRefusal);
    const cleanup = make(); cleanup.leaders.add(pgid);
    await assert.rejects(cleanup.terminate(), /without a verified leader/);
    // This is the run(inspect=false) failure path too: all negative-pid signals use signal().
    assert.throws(() => make().signal(-pgid, "SIGKILL"), isGroupSignalRefusal);
    assert.deepEqual(signals, [], "no group or derived pid signal reaches a protected target");
  } finally { inspect.mock.restore(); syncBuiltinESMExports(); }
});

test("pinned Codex: watchdog stops independently owned pids sharing an ancestor's group, including after another group is refused", async (t) => {
  const root = scratch(t), ancestor = 61001, shared = 61003, start = "Thu Jan 1 00:00:00 1970";
  let rows = [
    { pid: ancestor, ppid: 1, pgid: ancestor, start, command: "wrong group target" },
    { pid: 61002, ppid: ancestor, pgid: 61002, start, command: "detached child of wrong target" },
    { pid: 62001, ppid: process.pid, pgid: shared, start, command: `owned TMPDIR=${root}/tmp` },
    { pid: 62002, ppid: 62001, pgid: shared, start, command: "non-detached owned child" },
  ];
  const signals: [number, string][] = [];
  const inspect = t.mock.method(childProcess, "spawnSync", (() => ({ status: 0, stdout: `${process.pid} ${ancestor} ${shared}\n${ancestor} 1 ${ancestor}\n` })) as typeof childProcess.spawnSync);
  t.mock.method(process.stderr, "write", (() => true) as typeof process.stderr.write);
  syncBuiltinESMExports();
  const make = () => new ProcessSupervisor(root, { table: () => rows, graceMs: 0, kill: (pid: number, sig: string) => {
    signals.push([pid, sig]);
    if (sig === "SIGKILL") rows = rows.filter(r => r.pid !== pid);
  } });
  try {
    const independent = make();
    assert.deepEqual(independent.scan().map((r: any) => r.pid), [62001, 62002]);
    await independent.terminate();
    assert.deepEqual(signals, [[62001, "SIGSTOP"], [62002, "SIGSTOP"], [62001, "SIGKILL"], [62002, "SIGKILL"]]);
    assert.equal(independent.refusedGroups.size, 0, "membership alone is no group-signal request");

    rows.push({ pid: 62001, ppid: process.pid, pgid: shared, start, command: `owned TMPDIR=${root}/tmp` });
    signals.length = 0;
    const mixed = make(); mixed.leaders.add(ancestor);
    await assert.rejects(mixed.terminate(), /without a verified leader/);
    assert.deepEqual(signals, [[62001, "SIGSTOP"], [62001, "SIGKILL"]], "the refused target's detached descendants are skipped, while independent pid cleanup proceeds");
    assert.deepEqual(rows.map(r => r.pid), [ancestor, 61002]);
  } finally { inspect.mock.restore(); syncBuiltinESMExports(); }
});

test("pinned Codex: process inventory parses macOS identity and excludes ps's own scratch marker", () => {
  const text = " 123 1 123 Ss Thu Oct 29 09:01:02 2026 codex app-server HOME=/scratch/home\n 124 1 124 R Thu Oct 29 09:01:03 2026 /bin/ps HOME=/scratch/home\n";
  assert.deepEqual(parseProcessTable(text, 124), [{ pid: 123, ppid: 1, pgid: 123, stat: "Ss", start: "Thu Oct 29 09:01:02 2026", command: "codex app-server HOME=/scratch/home" }]);
});

test("pinned Codex: macOS inventory requests uppercase -E so orphaned setsid children retain their scratch marker", (t) => {
  const root = scratch(t), seen: any[] = [];
  const rows = processTable(root, (bin: string, args: string[], options: any) => {
    seen.push({ bin, args, options });
    const environment = args[0].includes("E") ? ` HOME=${root}/home CODEX_HOME=${root}/codex-home` : "";
    return { status: 0, pid: 124, stdout: `123 1 123 Ss Thu Oct 29 09:01:02 2026 node -e setInterval(()=>{},1000)${environment}\n` };
  });
  assert.equal(seen[0].bin, "/bin/ps"); assert.equal(seen[0].args[0], "-axEww");
  assert.equal(seen[0].options.env.CODEX_HOME, path.join(root, "codex-home"));
  const supervisor = new ProcessSupervisor(root, { table: () => rows });
  assert.equal(supervisor.scan()[0]?.pid, 123, "no parent/group leader or argv marker exists; discovery needs the environment");
});

test("pinned Codex: process inventory waits up to 30 s, reports a slow one, and still fails on a timeout", (t) => {
  const root = scratch(t), slow: number[] = [];
  const clock = (...times: number[]) => () => times.shift()!;
  const row = "123 1 123 Ss Thu Oct 29 09:01:02 2026 codex\n";
  let timeout = 0;
  processTable(root, (_bin: string, _args: string[], options: any) => { timeout = options.timeout; return { status: 0, pid: 9, stdout: row }; }, { onSlow: (ms: number) => slow.push(ms), now: clock(0, 60) });
  assert.equal(timeout, 30_000);
  assert.deepEqual(slow, [], "a fast inventory is not reported");
  processTable(root, () => ({ status: 0, pid: 9, stdout: row }), { onSlow: (ms: number) => slow.push(ms), now: clock(0, 7_400) });
  assert.deepEqual(slow, [7_400]);
  const timedOut = Object.assign(new Error("spawnSync /bin/ps ETIMEDOUT"), { code: "ETIMEDOUT" });
  assert.throws(() => processTable(root, () => ({ status: null, pid: 9, stdout: "", error: timedOut }), { onSlow: (ms: number) => slow.push(ms), now: clock(0, 30_010) }),
    /watchdog cannot inspect processes after 30010 ms: spawnSync \/bin\/ps ETIMEDOUT/);
  assert.deepEqual(slow, [7_400, 30_010]);
});

test("pinned Codex: a slow-inventory logger that throws never replaces the inventory's own error, and never fails a good inventory", (t) => {
  const root = scratch(t);
  const clock = (...times: number[]) => () => times.shift()!;
  const row = "123 1 123 Ss Thu Oct 29 09:01:02 2026 codex\n";
  const LOG_FAILED = Object.assign(new Error("LOG_FAILED: runner.log is not writable"), { code: "LOG_FAILED" });
  const failingLog = () => { throw LOG_FAILED; };
  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { stderr.push(String(chunk)); return true; });
  // A timed-out inventory: its ETIMEDOUT is what is thrown, with the logging failure beside it.
  const timedOut = Object.assign(new Error("spawnSync /bin/ps ETIMEDOUT"), { code: "ETIMEDOUT" });
  assert.throws(() => processTable(root, () => ({ status: null, pid: 9, stdout: "", error: timedOut }), { onSlow: failingLog, now: clock(0, 30_010) }), (err: any) => {
    assert.notEqual(err, LOG_FAILED, "the logger's error does not stand in for the inventory's");
    assert.match(err.message, /^watchdog cannot inspect processes after 30010 ms: spawnSync \/bin\/ps ETIMEDOUT/);
    assert.match(err.message, /reporting the slow inventory also failed: LOG_FAILED: runner\.log is not writable/);
    assert.equal(err.cause, timedOut);
    assert.equal(err.loggingError, LOG_FAILED);
    return true;
  });
  // A failed ps (non-zero exit, no spawn error) likewise.
  assert.throws(() => processTable(root, () => ({ status: 1, pid: 9, stdout: "", stderr: "ps: broken" }), { onSlow: failingLog, now: clock(0, 6_000) }),
    /^Error: watchdog cannot inspect processes after 6000 ms: ps: broken; reporting the slow inventory also failed: LOG_FAILED/);
  // A good but slow inventory: the rows are returned, and the logging failure is reported on stderr.
  const rows = processTable(root, () => ({ status: 0, pid: 9, stdout: row }), { onSlow: failingLog, now: clock(0, 7_400) });
  assert.deepEqual(rows.map((r: any) => r.pid), [123]);
  assert.ok(stderr.some((line) => /watchdog: process inventory took 7400 ms \(could not log it: LOG_FAILED: runner\.log is not writable\)/.test(line)), JSON.stringify(stderr));
});

test("pinned Codex: watchdog freezes until discovery converges, including more than two generations of setsid children", async (t) => {
  const root = scratch(t), stopped: number[] = [], killed: number[] = [];
  let rows = [{ pid: 60001, ppid: 1, pgid: 60001, start: "one", command: `HOME=${root}/home` }];
  const supervisor = new ProcessSupervisor(root, { table: () => rows, graceMs: 1, kill: (pid: number, sig: string) => {
    if (sig === "SIGSTOP") {
      stopped.push(pid);
      if (pid < 60004) rows.push({ pid: pid + 1, ppid: 1, pgid: pid + 1, start: String(pid + 1), command: `TMPDIR=${root}/tmp` });
    }
    if (sig === "SIGKILL") {
      assert.deepEqual(stopped, [60001, 60002, 60003, 60004], "all generations must be frozen before killing any parent");
      killed.push(pid); rows = rows.filter((row) => row.pid !== pid);
    }
    assert.notEqual(sig, "SIGCONT", "do not let frozen children fork again before killing them");
  } });
  await supervisor.terminate(); assert.deepEqual(killed, [60001, 60002, 60003, 60004]);
  assert.deepEqual(rows, []);
});

test("pinned Codex: watchdog looks again after killing and kills a newly visible reparented session", async (t) => {
  const root = scratch(t), killed: number[] = [];
  let rows = [{ pid: 60001, ppid: 1, pgid: 60001, start: "one", command: `HOME=${root}/home` }];
  let finalLook = false;
  const supervisor = new ProcessSupervisor(root, { table: () => { if (killed.includes(60002)) finalLook = true; return rows; }, graceMs: 10, kill: (pid: number, sig: string) => {
    if (sig !== "SIGKILL") return;
    killed.push(pid); rows = rows.filter((row) => row.pid !== pid);
    if (pid === 60001) rows.push({ pid: 60002, ppid: 1, pgid: 60002, start: "orphan", command: `HOME=${root}/home` });
  } });
  await supervisor.terminate(); assert.deepEqual(killed, [60001, 60002]); assert.equal(finalLook, true);
});

test("pinned Codex: remembered groups survive leader exit; remembered identities survive reparenting but not PID reuse", async (t) => {
  const root = scratch(t), signals: [number, string][] = [];
  let rows = [{ pid: 60001, ppid: 1, pgid: 60001, stat: "S", start: "one", command: `HOME=${root}/home` }];
  const supervisor = new ProcessSupervisor(root, { table: () => rows, graceMs: 1, kill: (pid: number, sig: string) => {
    signals.push([pid, sig]);
    if (sig === "SIGKILL") rows = rows.filter((row) => row.pid !== pid);
  } });
  supervisor.scan();
  rows = [{ pid: 60002, ppid: 1, pgid: 60001, stat: "S", start: "two", command: "unmarked group member" }];
  assert.equal(supervisor.scan()[0]?.pid, 60002);
  rows.push({ pid: 60001, ppid: 1, pgid: 60001, stat: "S", start: "reused", command: "unrelated replacement leader" });
  assert.equal(supervisor.signalSame({ pid: 60001, start: "one" }, "SIGKILL"), false);
  await supervisor.terminate();
  assert.deepEqual(rows.map((row) => row.pid), [60001]);
  assert.ok(signals.some(([pid, sig]) => pid === 60002 && sig === "SIGKILL"));
  assert.equal(signals.some(([pid]) => pid === 60001 || pid === -60001), false);
});

test("pinned Codex: failed or nonconvergent discovery still kills frozen identities and reports failure", async (t) => {
  for (const mode of ["failed", "nonconvergent"]) {
    const root = scratch(t), killed: number[] = [];
    let rows = [{ pid: 60001, ppid: 1, pgid: 60001, start: "one", command: `HOME=${root}/home` }], failNext = false;
    const supervisor = new ProcessSupervisor(root, { sweepCap: 3, graceMs: 1, table: () => {
      if (failNext) { failNext = false; throw new Error("inventory lost"); } return rows;
    }, kill: (pid: number, sig: string) => {
      if (sig === "SIGSTOP") {
        if (mode === "failed" && pid === 60001) failNext = true;
        if (mode === "nonconvergent") rows.push({ pid: pid + 1, ppid: 1, pgid: pid + 1, start: String(pid + 1), command: `HOME=${root}/home` });
      }
      if (sig === "SIGKILL") { killed.push(pid); rows = rows.filter((row) => pid < 0 ? row.pgid !== -pid : row.pid !== pid); }
    } });
    await assert.rejects(supervisor.terminate(), mode === "failed" ? /inventory lost/ : /did not converge/);
    assert.ok(killed.includes(60001));
  }
});

test("pinned Codex: zombies are exited processes, not live watchdog survivors", async (t) => {
  const root = scratch(t), row = { pid: 60001, ppid: 1, pgid: 60001, stat: "Z", start: "one", command: `HOME=${root}/home` };
  const supervisor = new ProcessSupervisor(root, { table: () => [row], kill: () => { assert.fail("must not signal a zombie"); } });
  await supervisor.terminate(); assert.deepEqual(supervisor.scan(), []);
});

test("pinned Codex: bounded child receives scratch env and timeout kills its process group", async (t) => {
  const root = scratch(t), supervisor = new ProcessSupervisor(root, { pollMs: 5 });
  const output = await supervisor.run(process.execPath, ["-e", "console.log(JSON.stringify({HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,TMPDIR:process.env.TMPDIR}))"]);
  const env = JSON.parse(output); for (const v of Object.values(env) as string[]) assert.ok(v.startsWith(root + path.sep));
  await assert.rejects(supervisor.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 30 }), /timeout/);
});

function fixtureServices(root: string, verdict: any = pass()) {
  const commands: any[] = [], notifications: string[] = [], supervisor = { cancelled: null as string | null, cancel(s: string) { this.cancelled = s; }, check() { if (this.cancelled) throw new Error(this.cancelled); } };
  const inputs = { version: "0.164.0", binarySuffix: "", binaryContent: null as string | null };
  const services = {
    json: async (url: string) => {
      if (url.endsWith("/latest")) return { version: inputs.version };
      if (url.includes("/git/ref/")) return { object: { type: "tag", sha: "b".repeat(40) } };
      if (url.includes("/git/tags/")) return { object: { type: "commit", sha: commit } };
      const version = url.split("/").at(-1)!;
      return { version, dist: { tarball: `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`, integrity } };
    },
    download: async (_url: string, dest: string) => { fs.writeFileSync(dest, "fixture tarball"); },
    unpack: async (_archive: string, dest: string) => {
      fs.mkdirSync(dest);
      if (path.basename(dest) === "source") fs.mkdirSync(path.join(dest, `codex-${commit}`, "codex-rs"), { recursive: true });
      else {
        const version = path.basename(dest).replace("package-", "");
        const { vendor } = tree(root, version);
        if (inputs.binaryContent !== null) fs.writeFileSync(path.join(vendor, "bin/codex"), inputs.binaryContent);
        else fs.appendFileSync(path.join(vendor, "bin/codex"), inputs.binarySuffix);
        fs.cpSync(vendor, path.join(dest, "package/vendor/aarch64-apple-darwin"), { recursive: true });
      }
    },
    command: async (bin: string, args: string[], opts: any = {}) => {
      commands.push({ bin, args, opts }); supervisor.check();
      if (bin === "/bin/launchctl") return "Aqua\n";
      if (bin === "/usr/bin/codesign") return args[0] === "-dv" ? "Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)\nTeamIdentifier=2DC432GLL2\n" : "";
      if (args[0] === "--version") return `codex-cli ${/package-(\d+\.\d+\.\d+)/.exec(bin)?.[1] ?? "bad-version"}\n`;
      if (args[0]?.endsWith("codex-stage2.mjs")) { fs.mkdirSync(args[2]); P.atomicJson(path.join(args[2], "stage2-verdict.json"), verdict); return ""; }
      throw new Error(`unexpected fixture command ${bin}`);
    },
    notify: async (text: string) => { notifications.push(text); },
  };
  // A built relay with no .git, as an npm install is.
  const repo = fakeRelayBuild(path.join(root, "repo"), "1.0.0", {
    "dist/backends/codex.js": "fixture built checkout", "scripts/codex-qualify/codex-stage2.mjs": "fixture reviewed driver",
    "scripts/codex-qualify/codex-qualifier.mjs": "fixture runner",
  });
  return { services, supervisor, commands, notifications, inputs, cfg: { repo, store: path.join(root, "store"), scratchRoot: path.join(root, "q"), timeoutMs: 1000 } };
}

function qualificationFailures(store: string) {
  const dir = path.join(store, "failed-qualifications");
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))) : [];
}

test("pinned Codex: fixture acquisition verifies SRI before extraction or execution", async (t) => {
  const root = scratch(t), f = fixtureServices(root);
  let unpacked = false;
  f.services.download = async (_url, dest) => { fs.writeFileSync(dest, "tampered tarball"); };
  f.services.unpack = async () => { unpacked = true; };
  await assert.rejects(acquire("0.164.0", root, f.services), /SRI mismatch/);
  assert.equal(unpacked, false); assert.equal(f.commands.length, 0);
});

test("pinned Codex: network outage preserves qualified current and leaves durable failure", async (t) => {
  const root = scratch(t), f = fixtureServices(root); P.initStore(f.cfg.store);
  const previous = pin(root, f.cfg.store, "0.162.0"); P.promote(f.cfg.store, previous);
  f.services.json = async () => { throw new Error("fixture npm outage"); };
  const result = await runQualifier(f.cfg, { ...f, signals: false });
  assert.equal(result.state, "failed"); assert.equal(P.pointer(f.cfg.store, "current"), previous);
  assert.match(fs.readFileSync(path.join(f.cfg.store, "last-failure.json"), "utf8"), /npm outage/);
  assert.equal(f.notifications.length, 1);
});

test("pinned Codex: fixture end-to-end promotes full pass and uses fixed 0.163.0 control and committed source", async (t) => {
  const root = scratch(t), f = fixtureServices(root);
  const result = await runQualifier(f.cfg, { ...f, signals: false });
  assert.equal(result.state, "promoted");
  const invocation = f.commands.find((c) => c.args[0]?.endsWith("codex-stage2.mjs"));
  // Stage 2 runs from a verified copy of the build in scratch, never from the package itself.
  const tree = invocation.args[1];
  assert.notEqual(tree, f.cfg.repo); assert.ok(tree.startsWith(f.cfg.scratchRoot + path.sep));
  assert.equal(invocation.args[0], path.join(tree, "scripts/codex-qualify/codex-stage2.mjs")); assert.equal(invocation.opts.cwd, tree);
  assert.deepEqual(buildIdentity(tree), buildIdentity(f.cfg.repo));
  assert.deepEqual(P.validateTarget(f.cfg.store, result.target).relayBuild, buildIdentity(f.cfg.repo), "the pin names the build that ran");
  assert.equal(P.validateTarget(f.cfg.store, result.target).relayCommit, undefined);
  assert.equal(invocation.args[3], "0.164.0");
  assert.deepEqual(invocation.args.slice(5, 6), ["--source"]);
  assert.ok(invocation.args[6].includes(commit)); assert.equal(invocation.args[7], "--old-bin");
  assert.match(invocation.args[8], /package-0\.163\.0/);
  assert.equal(invocation.opts.inspect, true); assert.equal(invocation.opts.timeoutMs, 1000);
  assert.deepEqual(invocation.opts.env, { RELAY_TEST_PUBLIC_NET: "1", RELAY_TEST_ESCALATION_LONG: "1" }, "without these, items 28 and 30 record not run and no version can be promoted");
  assert.equal(P.readJournal(f.cfg.store).length, 1); assert.equal(f.notifications.length, 0);
  assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "unchanged");
  assert.equal(fs.existsSync(path.join(f.cfg.store, "lock")), false);
});

test("pinned Codex: an old unversioned pin supports unchanged, upgrade and rollback under its own schema", async (t) => {
  const root = scratch(t), f = fixtureServices(root, pass("0.165.0")); P.initStore(f.cfg.store);
  const old = legacyPin(root, f.cfg.store); P.promote(f.cfg.store, old);
  assert.equal((await runQualifier(f.cfg, { ...f, version: "0.164.0", signals: false })).state, "unchanged");
  assert.equal(f.commands.some((c) => c.args[0]?.endsWith("codex-stage2.mjs")), false);
  const upgraded = await runQualifier(f.cfg, { ...f, version: "0.165.0", signals: false });
  assert.equal(upgraded.state, "promoted");
  assert.equal(P.pointer(f.cfg.store, "previous"), old);
  const manifest = P.validateTarget(f.cfg.store, upgraded.target);
  assert.equal(manifest.verdictSchema, P.CURRENT_VERDICT_SCHEMA);
  assert.equal(manifest.verdictSha256, P.sha256(manifest.verdictPath));
  assert.equal(runRollback(f.cfg)?.to, old);
  assert.equal(P.pointer(f.cfg.store, "current"), old);
  assert.equal(P.pointer(f.cfg.store, "previous"), upgraded.target);
  assert.equal(P.validateTarget(f.cfg.store, old).verdictSchema, undefined);
  assert.deepEqual(P.readJournal(f.cfg.store).map((r: any) => r.action), ["promote", "promote", "rollback"]);
});

test("pinned Codex: new qualifications missing current parts never promote, regardless of their schema claim", async (t) => {
  for (const verdictSchema of [undefined, P.LEGACY_VERDICT_SCHEMA, P.CURRENT_VERDICT_SCHEMA]) {
    const root = scratch(t), verdict = legacyPass("0.165.0");
    if (verdictSchema !== undefined) verdict.verdictSchema = verdictSchema;
    const f = fixtureServices(root, verdict); P.initStore(f.cfg.store);
    const old = legacyPin(root, f.cfg.store); P.promote(f.cfg.store, old);
    const result = await runQualifier(f.cfg, { ...f, version: "0.165.0", signals: false });
    assert.equal(result.state, "failed");
    assert.match(result.error, /10.effort evidence missing/);
    assert.equal(P.pointer(f.cfg.store, "current"), old);
    assert.equal(P.pointer(f.cfg.store, "previous"), null);
    assert.equal(P.readJournal(f.cfg.store).length, 1);
    assert.deepEqual(fs.readdirSync(path.join(f.cfg.store, "versions")), [old.split("/")[1]]);
    assert.equal(f.notifications.length, 1);
  }
});

test("pinned Codex: a new complete qualification records the current schema actually enforced", async (t) => {
  const root = scratch(t), verdict = pass(); verdict.verdictSchema = P.LEGACY_VERDICT_SCHEMA;
  const f = fixtureServices(root, verdict);
  const result = await runQualifier(f.cfg, { ...f, signals: false });
  assert.equal(result.state, "promoted");
  const manifest = P.validateTarget(f.cfg.store, result.target);
  const recorded = JSON.parse(fs.readFileSync(manifest.verdictPath, "utf8"));
  assert.equal(recorded.verdictSchema, P.CURRENT_VERDICT_SCHEMA);
  assert.equal(manifest.verdictSchema, recorded.verdictSchema);
  assert.equal(P.judgeVerdict(recorded, manifest.version, P.CURRENT_VERDICT_SCHEMA).ok, true);
});

test("pinned Codex: qualification stages the candidate before any real publication exists", async (t) => {
  const root = scratch(t), f = fixtureServices(root);
  const command = f.services.command;
  let staged = false;
  f.services.command = async (bin, args, opts) => {
    if (!args[0]?.endsWith("codex-stage2.mjs")) return command(bin, args, opts);
    assert.equal(P.pointer(f.cfg.store, "current"), null);
    assert.deepEqual(fs.readdirSync(path.join(f.cfg.store, "versions")), []);
    fs.mkdirSync(args[2]);
    const pin = stageQualificationPin({ scratch: args[2], bin: args[4], version: args[3] });
    assert.ok(pin.pin_store.startsWith(args[2] + path.sep));
    assert.equal(freezeCodexConfig(withDefaults({ targets: { codex: pin } })).targets.codex.bin, pin.bin);
    assert.equal(P.sha256(pin.bin), P.sha256(args[4]));
    assert.equal(fs.existsSync(path.join(args[2], "stage2-verdict.json")), false);
    staged = true;
    P.atomicJson(path.join(args[2], "stage2-verdict.json"), pass(args[3]));
    return "";
  };
  const result = await runQualifier(f.cfg, { ...f, signals: false });
  assert.equal(staged, true);
  assert.equal(result.state, "promoted");
  assert.equal(P.validateTarget(f.cfg.store, result.target).version, "0.164.0");
});

test("pinned Codex: a zero-exit not-run verdict retains current and records and notifies failure", async (t) => {
  const root = scratch(t), v = pass(); v.items[13].parts.relay.state = "not run";
  const f = fixtureServices(root, v); P.initStore(f.cfg.store);
  const previous = pin(root, f.cfg.store, "0.162.0"); P.promote(f.cfg.store, previous);
  const result = await runQualifier(f.cfg, { ...f, signals: false });
  assert.equal(result.state, "failed"); assert.equal(P.pointer(f.cfg.store, "current"), previous);
  assert.equal(P.readJournal(f.cfg.store).length, 1); assert.equal(f.notifications.length, 1);
  assert.ok(fs.existsSync(path.join(f.cfg.store, "last-failure.json")));
  assert.match(fs.readFileSync(path.join(result.runDir, "runner.log"), "utf8"), /13.relay/);
});

test("pinned Codex: recorded failed inputs skip qualification without notifying or changing pins", async (t) => {
  const root = scratch(t), v = pass(); v.items[13].parts.relay.state = "not run";
  const f = fixtureServices(root, v); P.initStore(f.cfg.store);
  const previous = pin(root, f.cfg.store, "0.162.0"); P.promote(f.cfg.store, previous);
  const first = await runQualifier(f.cfg, { ...f, signals: false });
  assert.equal(first.state, "failed");
  const stage2 = f.commands.filter((c) => c.args[0]?.endsWith("codex-stage2.mjs"));
  const [record] = qualificationFailures(f.cfg.store);
  assert.deepEqual(record, {
    version: "0.164.0", binarySha256: P.sha256(stage2[0].args[4]), relayBuild: buildIdentity(f.cfg.repo),
    at: record.at, verdictPath: path.join(first.runDir, "stage2-verdict.json"),
  });
  assert.ok(Number.isFinite(Date.parse(record.at)));
  assert.equal(fs.existsSync(record.verdictPath), true);
  const failure = fs.readFileSync(path.join(f.cfg.store, "last-failure.json"), "utf8");
  const json = f.services.json;
  f.services.json = async (url) => { assert.ok(!url.includes("api.github.com"), "skip precedes source acquisition"); return json(url); };
  f.services.notify = async () => { assert.fail("a skip must not notify"); };
  const skipped = await runQualifier(f.cfg, { ...f, signals: false });
  assert.equal(skipped.state, "skipped"); assert.equal(skipped.verdictPath, record.verdictPath);
  assert.equal(f.commands.filter((c) => c.args[0]?.endsWith("codex-stage2.mjs")).length, 1);
  assert.equal(f.notifications.length, 1);
  assert.equal(P.pointer(f.cfg.store, "current"), previous); assert.equal(P.readJournal(f.cfg.store).length, 1);
  assert.equal(fs.readFileSync(path.join(f.cfg.store, "last-failure.json"), "utf8"), failure);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.cfg.store, "last-result.json"), "utf8")).state, "skipped");
  const log = fs.readFileSync(path.join(skipped.runDir, "runner.log"), "utf8");
  assert.equal(log.split("\n").filter((line) => line.includes("Skipped Codex")).length, 1);
  assert.ok(log.includes(record.relayBuild.sha256.slice(0, 16))); assert.ok(log.includes(record.binarySha256)); assert.ok(log.includes(record.verdictPath));
});

test("pinned Codex: a changed relay build, binary SHA or version retries; older failures remain remembered", async (t) => {
  for (const changed of ["relayBuild", "binarySuffix", "version"] as const) await t.test(changed, async (t) => {
    const root = scratch(t), v = pass(); v.ok = false;
    const f = fixtureServices(root, v);
    const built = path.join(f.cfg.repo, "dist/backends/codex.js"), originalBuild = fs.readFileSync(built, "utf8");
    if (changed === "version") f.inputs.binaryContent = "same fixture bytes for different version metadata";
    assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "failed");
    const set = (on: boolean) => {
      if (changed === "relayBuild") fs.writeFileSync(built, on ? "a rebuilt relay" : originalBuild);
      else (f.inputs as any)[changed] = on ? { binarySuffix: " changed binary", version: "0.165.0" }[changed] : { binarySuffix: "", version: "0.164.0" }[changed];
    };
    set(true);
    v.version = f.inputs.version;
    assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "failed");
    assert.equal(f.commands.filter((c) => c.args[0]?.endsWith("codex-stage2.mjs")).length, 2);
    const records = qualificationFailures(f.cfg.store);
    assert.equal(records.length, 2);
    const field = { relayBuild: "relayBuild", binarySuffix: "binarySha256", version: "version" }[changed];
    for (const key of ["version", "binarySha256", "relayBuild"]) {
      if (key === field) assert.notDeepEqual(records[0][key], records[1][key]);
      else assert.deepEqual(records[0][key], records[1][key], "only the selected input changed");
    }
    set(false);
    v.version = f.inputs.version;
    assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "skipped");
  });
});

test("pinned Codex: a failure recorded under a relay commit (before build identities) matches no build and is qualified again", async (t) => {
  const root = scratch(t), v = pass(); v.ok = false;
  const f = fixtureServices(root, v);
  assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "failed");
  const dir = path.join(f.cfg.store, "failed-qualifications");
  const [name] = fs.readdirSync(dir);
  const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  delete record.relayBuild; record.relayCommit = commit;
  P.atomicJson(path.join(dir, name), record);
  assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "failed", "run again, not skipped");
  assert.equal(f.commands.filter((c) => c.args[0]?.endsWith("codex-stage2.mjs")).length, 2);
});

test("pinned Codex: a build changed during qualification, in the package or in the copy that ran, is never promoted", async (t) => {
  for (const where of ["package", "copy"] as const) await t.test(where, async (t) => {
    const root = scratch(t), f = fixtureServices(root), command = f.services.command;
    f.services.command = async (bin, args, opts) => {
      const out = await command(bin, args, opts);
      if (args[0]?.endsWith("codex-stage2.mjs")) fs.appendFileSync(path.join(where === "package" ? f.cfg.repo : args[1], "test/fixtures/fixture.txt"), "edited mid-run");
      return out;
    };
    const result = await runQualifier(f.cfg, { ...f, signals: false });
    assert.equal(result.state, "failed");
    assert.match(result.error, /qualification inputs changed during run/);
    assert.equal(P.pointer(f.cfg.store, "current"), null);
  });
});

test("pinned Codex: an incomplete build is refused before anything is downloaded", async (t) => {
  const root = scratch(t), f = fixtureServices(root);
  fs.rmSync(path.join(f.cfg.repo, "test/stage2-grant.test.ts"));
  const result = await runQualifier(f.cfg, { ...f, signals: false });
  assert.equal(result.state, "failed");
  assert.match(result.error, /incomplete: test\/stage2-grant\.test\.ts is missing/);
  assert.deepEqual(f.commands.map((c) => c.bin), ["/bin/launchctl"], "nothing downloaded or run");
});

test("pinned Codex: force retries recorded failure and a full pass still promotes normally", async (t) => {
  const root = scratch(t), v = pass(); v.ok = false;
  const f = fixtureServices(root, v);
  assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "failed");
  v.ok = true;
  assert.equal((await runQualifier(f.cfg, { ...f, signals: false, force: true })).state, "promoted");
  assert.equal(f.commands.filter((c) => c.args[0]?.endsWith("codex-stage2.mjs")).length, 2);
  assert.equal(P.validateTarget(f.cfg.store, P.pointer(f.cfg.store, "current")).version, "0.164.0");
  assert.equal(P.readJournal(f.cfg.store).length, 1);
  assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "unchanged", "current-pin check precedes failure lookup");
});

test("pinned Codex: no-verdict and malformed-verdict runs are never remembered and are retried", async (t) => {
  for (const mode of ["missing", "crashed", "malformed"]) await t.test(mode, async (t) => {
    const root = scratch(t), f = fixtureServices(root), command = f.services.command;
    let attempts = 0;
    f.services.command = async (bin, args, opts) => {
      if (!args[0]?.endsWith("codex-stage2.mjs")) return command(bin, args, opts);
      attempts++;
      if (mode === "crashed") throw new Error("fixture driver crashed without a verdict");
      if (mode === "malformed") { fs.mkdirSync(args[2]); fs.writeFileSync(path.join(args[2], "stage2-verdict.json"), '{"partial":'); }
      return "";
    };
    for (let i = 0; i < 2; i++) {
      assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "failed");
      assert.deepEqual(qualificationFailures(f.cfg.store), []);
    }
    assert.equal(attempts, 2); assert.equal(f.notifications.length, 2);
    assert.equal(P.pointer(f.cfg.store, "current"), null);
  });
});

test("pinned Codex: a rejected verdict is remembered even if the driver exits nonzero", async (t) => {
  const root = scratch(t), v = pass(); v.ok = false;
  const f = fixtureServices(root, v), command = f.services.command;
  f.services.command = async (bin, args, opts) => {
    const result = await command(bin, args, opts);
    if (args[0]?.endsWith("codex-stage2.mjs")) throw new Error("fixture driver exited 1");
    return result;
  };
  assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "failed");
  assert.equal(qualificationFailures(f.cfg.store).length, 1);
  assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "skipped");
});

test("pinned Codex: passing verdicts with driver or promotion errors remain retryable", async (t) => {
  for (const mode of ["driver", "promotion"]) await t.test(mode, async (t) => {
    const root = scratch(t), v = pass(); v.ok = false;
    const f = fixtureServices(root, v), command = f.services.command;
    assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "failed");
    assert.equal(qualificationFailures(f.cfg.store).length, 1);
    v.ok = true;
    let fail = true;
    const check = f.supervisor.check.bind(f.supervisor);
    f.supervisor.check = () => {
      check();
      if (fail && mode === "promotion" && fs.existsSync(path.join(f.cfg.store, "pending.json"))) throw new Error("fixture interrupted promotion");
    };
    f.services.command = async (bin, args, opts) => {
      const result = await command(bin, args, opts);
      if (fail && mode === "driver" && args[0]?.endsWith("codex-stage2.mjs")) throw new Error("fixture driver exited after passing verdict");
      return result;
    };
    assert.equal((await runQualifier(f.cfg, { ...f, signals: false, force: true })).state, "failed");
    assert.deepEqual(qualificationFailures(f.cfg.store), []);
    assert.equal(P.pointer(f.cfg.store, "current"), null);
    assert.equal(fs.existsSync(path.join(f.cfg.store, "pending.json")), false);
    if (mode === "promotion") assert.equal(fs.readdirSync(path.join(f.cfg.store, "versions")).length, 1, "publication succeeded before promotion was interrupted");
    fail = false;
    assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "promoted");
    assert.equal(f.commands.filter((c) => c.args[0]?.endsWith("codex-stage2.mjs")).length, 3);
  });
});

test("pinned Codex: CLI accepts --force with latest or either --version ordering and rejects rollback flags", (t) => {
  const root = scratch(t), missingConfig = path.join(root, "missing.json"), runner = path.join(scripts, "codex-qualifier.mjs");
  for (const flags of [["--force"], ["--force", "--version", "0.164.0"], ["--version", "0.164.0", "--force"], ["--parallel"], ["--version", "0.164.0", "--parallel", "--force"]]) {
    const result = spawnSync(process.execPath, [runner, missingConfig, "--run", ...flags], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /ENOENT/); assert.doesNotMatch(result.stderr, /Usage:/);
  }
  const result = spawnSync(process.execPath, [runner, missingConfig, "--rollback", "--force"], { encoding: "utf8" });
  assert.equal(result.status, 2); assert.match(result.stderr, /Usage:/);
});

test("pinned Codex: missing verdict and fixed-control version mismatch cannot promote", async (t) => {
  for (const mode of ["missing-verdict", "wrong-old-bin"]) {
    const root = scratch(t), f = fixtureServices(root);
    const original = f.services.command;
    f.services.command = async (bin, args, opts) => {
      if (mode === "missing-verdict" && args[0]?.endsWith("codex-stage2.mjs")) return "";
      if (mode === "wrong-old-bin" && args[0] === "--version" && bin.includes("package-0.163.0")) return "codex-cli 0.164.0";
      return original(bin, args, opts);
    };
    assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "failed");
    assert.equal(P.pointer(f.cfg.store, "current"), null);
  }
});

test("pinned Codex: outside the Aqua session, or when launchd cannot say, nothing is acquired, qualified or published", async (t) => {
  for (const session of ["Background\n", "StandardIO\n", "", null]) {
    const root = scratch(t), f = fixtureServices(root), original = f.services.command;
    f.services.command = async (bin, args, opts) => {
      if (bin === "/bin/launchctl") { f.commands.push({ bin, args, opts }); if (session === null) throw new Error("launchctl failed"); return session; }
      return original(bin, args, opts);
    };
    const result = await runQualifier(f.cfg, f);
    assert.equal(result.state, "failed", String(session));
    assert.match(result.error, session === null ? /launchctl failed/ : /Aqua/, String(session));
    assert.deepEqual(f.commands.map((c) => c.bin), ["/bin/launchctl"], "nothing after the session check");
    assert.equal(P.pointer(f.cfg.store, "current"), null);
    assert.equal(fs.existsSync(path.join(f.cfg.store, "versions")) && fs.readdirSync(path.join(f.cfg.store, "versions")).length, 0);
    assert.deepEqual(qualificationFailures(f.cfg.store), [], "a session refusal is not a recorded qualification failure");
    // Review r_3a408af1 X3: the refusal releases the store's lock, so the next run is not "busy".
    assert.equal(fs.existsSync(path.join(f.cfg.store, "lock")), false, `${String(session)}: lock released`);
    const release = P.acquireLock(f.cfg.store);
    assert.equal(typeof release, "function", `${String(session)}: the next run takes the lock`);
    release();
  }
});

test("pinned Codex: SIGTERM cancellation is durable and does not publish", async (t) => {
  const root = scratch(t), f = fixtureServices(root), original = f.services.command;
  f.services.command = async (bin, args, opts) => {
    if (args[0]?.endsWith("codex-stage2.mjs")) { process.emit("SIGTERM"); f.supervisor.check(); }
    return original(bin, args, opts);
  };
  const result = await runQualifier(f.cfg, f);
  assert.equal(result.state, "failed"); assert.match(result.error, /SIGTERM/);
  assert.equal(P.pointer(f.cfg.store, "current"), null);
  assert.equal(fs.existsSync(path.join(f.cfg.store, "lock")), false);
  assert.deepEqual(qualificationFailures(f.cfg.store), []);
  f.supervisor.cancelled = null; f.services.command = original;
  assert.equal((await runQualifier(f.cfg, { ...f, signals: false })).state, "promoted");
});

test("pinned Codex: installer dry run writes nothing; install writes plist without loading", (t) => {
  const root = scratch(t), f = fixtureServices(root), home = path.join(root, "home"), config = path.join(root, "qualifier.json");
  P.atomicJson(config, f.cfg);
  const result = installQualifier({ config, node: process.execPath, home });
  assert.equal(result.installed, false); assert.equal(fs.existsSync(home), false); assert.equal(fs.existsSync(f.cfg.store), false);
  assert.ok(!result.node.includes("fnm_multishells"));
  assert.match(result.content, /<key>LimitLoadToSessionType<\/key><string>Aqua/);
  assert.equal((result.content.match(/<key>Hour<\/key>/g) ?? []).length, 6);
  assert.match(result.content, /<key>Umask<\/key><integer>63/);
  const installed = installQualifier({ config, node: process.execPath, home, install: true });
  assert.equal(fs.readFileSync(installed.plist, "utf8"), installed.content);
  assert.equal(fs.statSync(installed.plist).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(home, "Library/Logs/relay-codex-qualifier")), true);
});

test("pinned Codex: the installer has no UID check and takes its launchd label from the user or --label", (t) => {
  const root = scratch(t), f = fixtureServices(root), home = path.join(root, "home"), config = path.join(root, "qualifier.json");
  P.atomicJson(config, f.cfg);
  const source = fs.readFileSync(path.join(scripts, "install-codex-qualifier.mjs"), "utf8");
  assert.doesNotMatch(source, /getuid\(\)\s*[!=]==?|uid !== |\b501\b/, "no user is singled out by UID");
  assert.doesNotMatch(fs.readFileSync(path.join(scripts, "relay-codex-qualifier.plist"), "utf8"), /jb[k]jr/);
  assert.doesNotMatch(fs.readFileSync(path.join(scripts, "codex-qualifier.example.json"), "utf8"), /jb[k]jr/);
  // The default label is the user's, and names the plist.
  assert.equal(defaultLabel("Ada Lovelace"), "local.ada-lovelace.relay-codex-qualifier");
  assert.equal(defaultLabel("..."), "local.user.relay-codex-qualifier");
  const own = installQualifier({ config, node: process.execPath, home, install: true });
  assert.equal(own.label, defaultLabel());
  assert.equal(own.plist, path.join(home, "Library/LaunchAgents", `${defaultLabel()}.plist`));
  assert.match(own.content, new RegExp(`<key>Label</key><string>${defaultLabel().replaceAll(".", "\\.")}</string>`));
  assert.doesNotMatch(own.content, /me\.jb[k]jr|__LABEL__/);
  const named = installQualifier({ config, node: process.execPath, home, label: "com.example.relay-q", install: true });
  assert.equal(named.plist, path.join(home, "Library/LaunchAgents/com.example.relay-q.plist"));
  assert.match(named.content, /<key>Label<\/key><string>com\.example\.relay-q<\/string>/);
  // A label names a file: no slash, no dot-dot, nothing to escape, at least two words.
  for (const bad of ["../evil.x", "a/b.c", "single", "a..b", ".a.b", "a.b.", "a.b c", "a.<b>", ""]) {
    assert.throws(() => validLabel(bad), /launchd label/, bad);
    assert.throws(() => installQualifier({ config, node: process.execPath, home: path.join(root, "other"), label: bad, install: true }), /launchd label/, bad);
  }
  assert.equal(fs.existsSync(path.join(root, "other")), false, "a refused label writes nothing");
});

test("pinned Codex: the installer replaces only a qualifier agent's plist under its label (review r_3a408af1, X1)", (t) => {
  const root = scratch(t), f = fixtureServices(root), home = path.join(root, "home"), config = path.join(root, "qualifier.json");
  P.atomicJson(config, f.cfg);
  const agents = path.join(home, "Library/LaunchAgents"); fs.mkdirSync(agents, { recursive: true });
  // Someone else's agent under the chosen label: refused in a dry run and an install, and left as it was.
  const other = path.join(agents, "com.example.backup.plist"), otherText = "<plist><dict><key>Label</key><string>com.example.backup</string></dict></plist>";
  fs.writeFileSync(other, otherText);
  for (const install of [false, true]) assert.throws(() => installQualifier({ config, node: process.execPath, home, label: "com.example.backup", install }), /not a relay Codex qualifier agent/);
  assert.equal(fs.readFileSync(other, "utf8"), otherText);
  // A symlink in its place is refused too, whatever it points to.
  const linked = path.join(agents, "com.example.link.plist"); fs.symlinkSync(other, linked);
  assert.throws(() => installQualifier({ config, node: process.execPath, home, label: "com.example.link", install: true }), /not a relay Codex qualifier agent/);
  // A qualifier agent, from before the move (release-watch) or after it, is replaced.
  const old = path.join(agents, "me.example.relay-codex-qualifier.plist");
  fs.writeFileSync(old, renderPlist({ node: "/stable/node", runner: "/r/scripts/release-watch/codex-qualifier.mjs", config: "/c.json", repo: "/r", logs: "/l", label: "me.example.relay-codex-qualifier" }));
  assert.equal(isQualifierAgent(fs.readFileSync(old, "utf8")), true);
  const replaced = installQualifier({ config, node: process.execPath, home, label: "me.example.relay-codex-qualifier", install: true });
  assert.equal(fs.readFileSync(old, "utf8"), replaced.content);
  assert.match(replaced.content, /scripts\/codex-qualify\/codex-qualifier\.mjs/);
  assert.equal(installQualifier({ config, node: process.execPath, home, label: "me.example.relay-codex-qualifier", install: true }).installed, true, "and again");
  assert.equal(isQualifierAgent(otherText), false);
  assert.equal(isQualifierAgent("<string>/r/scripts/codex-qualify/codex-qualifier.mjs</string><string>/c.json</string><string>--rollback</string>"), false);
});

test("pinned Codex: plist escapes paths and notification text is an argument to constant AppleScript", () => {
  const plist = renderPlist({ node: "/stable/node", runner: "/repo/a&b.mjs", config: '/config/"example".json', repo: "/repo", logs: "/logs" });
  assert.match(plist, /a&amp;b/); assert.match(plist, /&quot;example&quot;/);
  assert.match(plist, /<key>ProcessType<\/key><string>Standard<\/string>/, "Background starves the watchdog's ps on a busy Mac");
  assert.throws(() => renderPlist({ node: "/fnm_multishells/x/node", runner: "/r", config: "/c", repo: "/repo", logs: "/logs" }), /stable/);
  assert.match(NOTIFICATION_SCRIPT, /item 1 of argv/);
  assert.equal(NOTIFICATION_SCRIPT.includes("version"), false);
  assert.throws(() => validateConfig({ repo: "relative" }), /absolute/);
  assert.throws(() => validateConfig({ repo: "/r", scratchRoot: `/${"a".repeat(60)}` }), /too long/, "a run would otherwise spend over an hour failing every relay item");
});

test("pinned Codex: notification injection text stays a literal argv value", async (t) => {
  const root = scratch(t), calls: any[] = [];
  const services = liveServices(root, { run: async (...args: any[]) => { calls.push(args); return ""; } });
  const text = '\"); do shell script "unexpected" -- $()';
  await services.notify(text);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.deepEqual(calls[0][1], ["-e", NOTIFICATION_SCRIPT, text]);
  assert.equal(calls[0][2].env.HOME, path.join(root, "home"));
  assert.equal(calls[0][2].env.CODEX_HOME, path.join(root, "codex-home"));
});

test("live unpack: named members come out alone, links elsewhere are not written, and a whole archive with a link is refused", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qual-unpack-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, "src", "codex-abc", "codex-rs");
  fs.mkdirSync(path.join(src, "models-manager"), { recursive: true });
  fs.writeFileSync(path.join(src, "models-manager", "models.json"), "{}");
  fs.writeFileSync(path.join(src, "COPYING"), "x");
  fs.symlinkSync("COPYING", path.join(src, "LICENSE"));
  const archive = path.join(root, "a.tgz");
  assert.equal(spawnSync("/usr/bin/tar", ["-czf", archive, "-C", path.join(root, "src"), "codex-abc"]).status, 0);
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch);
  const services = liveServices(scratch, new ProcessSupervisor(scratch));
  const member = "codex-abc/codex-rs/models-manager/models.json";
  const dest = path.join(root, "only");
  await services.unpack(archive, dest, [member]);
  assert.equal(fs.readFileSync(path.join(dest, member), "utf8"), "{}");
  assert.deepEqual(fs.readdirSync(path.join(dest, "codex-abc", "codex-rs")), ["models-manager"]);
  await assert.rejects(services.unpack(archive, path.join(root, "all")), /links and special files are forbidden/);
});


test("pinned Codex: pins from before build identities (a relayCommit) keep working; a new pin's relayBuild must be well formed", async (t) => {
  const root = scratch(t), store = path.join(root, "store"); P.initStore(store);
  // A pin as the qualifier published it before relay-build-v1: it names a relay commit.
  const { vendor, manifest } = tree(root, "0.164.0");
  const target = P.publishTree(store, vendor, { ...manifest, relayCommit: commit, stage2Sha256: "d".repeat(64) });
  P.promote(store, target);
  assert.equal(P.validateTarget(store, target).relayCommit, commit);
  const cfg = withDefaults({ targets: { codex: { pin_store: store, home: path.join(root, "home"), pinned: true } } });
  assert.equal(freezeCodexConfig(cfg).targets.codex.bin, path.join(fs.realpathSync(store), target, "bin/codex"), "relay still runs it");
  const good = { scheme: "relay-build-v2", version: "1.0.0", sha256: "e".repeat(64) };
  assert.equal(P.validateManifest({ ...manifest, relayBuild: good }).relayBuild, good);
  // Pins from builds before the dependency lock name relay-build-v1: still a valid record of what ran.
  const v1 = { ...good, scheme: "relay-build-v1" };
  assert.equal(P.validateManifest({ ...manifest, relayBuild: v1 }).relayBuild, v1);
  for (const bad of [null, "e".repeat(64), { ...good, scheme: "relay-build-v0" }, { ...good, sha256: "E".repeat(64) }, { ...good, version: "" }]) {
    assert.throws(() => P.validateManifest({ ...manifest, relayBuild: bad }), /relay build/, JSON.stringify(bad));
  }
});

test("pinned Codex: --parallel runs the stage-2 coordinator as the one supervised command and records the mode", async (t) => {
  for (const parallel of [false, true]) {
    const root = scratch(t), f = fixtureServices(root);
    fs.writeFileSync(path.join(f.cfg.repo, "scripts/codex-qualify/stage2-parallel.mjs"), "fixture coordinator");
    const command = f.services.command;
    f.services.command = async (bin: string, args: string[], opts: any = {}) => {
      if (!args[0]?.endsWith("stage2-parallel.mjs")) return command(bin, args, opts);
      f.commands.push({ bin, args, opts });
      fs.mkdirSync(args[2]); P.atomicJson(path.join(args[2], "stage2-verdict.json"), { ...pass(), mode: "parallel" });
      return "";
    };
    const result = await runQualifier(f.cfg, { ...f, signals: false, parallel });
    assert.equal(result.state, "promoted");
    const stage2 = f.commands.filter((c) => /(codex-stage2|stage2-parallel)\.mjs$/.test(c.args[0] ?? ""));
    assert.equal(stage2.length, 1, "one supervised stage-2 command either way");
    const [invocation] = stage2, tree = invocation.args[1];
    assert.equal(invocation.args[0], path.join(tree, `scripts/codex-qualify/${parallel ? "stage2-parallel" : "codex-stage2"}.mjs`));
    assert.deepEqual(invocation.args.slice(2, 3), [path.join(path.dirname(tree), "stage2")], "the same output directory: the coordinator writes its verdict there");
    assert.equal(invocation.opts.inspect, true); assert.equal(invocation.opts.timeoutMs, 1000);
    assert.deepEqual(invocation.opts.env, { RELAY_TEST_PUBLIC_NET: "1", RELAY_TEST_ESCALATION_LONG: "1" });
    const manifest = P.validateTarget(f.cfg.store, result.target);
    assert.equal(manifest.stage2Mode, parallel ? "parallel" : "serial");
    assert.equal(manifest.stage2Sha256, P.sha256(path.join(tree, "scripts/codex-qualify/codex-stage2.mjs")), "the item driver's digest in both modes");
    assert.equal(manifest.stage2ParallelSha256, parallel ? P.sha256(path.join(tree, "scripts/codex-qualify/stage2-parallel.mjs")) : undefined);
    assert.match(fs.readFileSync(path.join(result.runDir, "runner.log"), "utf8"), new RegExp(`Running stage 2 \\(${parallel ? "parallel" : "serial"}\\)`));
  }
});

test("pinned Codex: a parallel run whose verdict is not the coordinator's never promotes and stays retryable", async (t) => {
  const root = scratch(t), f = fixtureServices(root);
  fs.writeFileSync(path.join(f.cfg.repo, "scripts/codex-qualify/stage2-parallel.mjs"), "fixture coordinator");
  const command = f.services.command;
  f.services.command = async (bin: string, args: string[], opts: any = {}) => {
    if (!args[0]?.endsWith("stage2-parallel.mjs")) return command(bin, args, opts);
    fs.mkdirSync(args[2]); P.atomicJson(path.join(args[2], "stage2-verdict.json"), { ...pass(), mode: "serial" });
    return "";
  };
  const result = await runQualifier(f.cfg, { ...f, signals: false, parallel: true });
  assert.equal(result.state, "failed"); assert.match(result.error, /ran in parallel but its verdict says mode serial/);
  assert.deepEqual(qualificationFailures(f.cfg.store), [], "not a rejected candidate");
  assert.equal(P.pointer(f.cfg.store, "current"), null);
});

test("pinned Codex: the parallel run's deeper scratch must also fit macOS's socket path limit", () => {
  // The serial layout's longest socket below the root is 64 bytes; the parallel one's, at stage2/main, 69.
  const fits = (n: number, parallel: boolean) => { try { validateConfig({ repo: "/r", scratchRoot: `/${"a".repeat(n)}` }, { parallel }); return true; } catch { return false; } };
  assert.equal(fits(38, false), true); assert.equal(fits(39, false), false);
  assert.equal(fits(33, true), true); assert.equal(fits(34, true), false);
  assert.equal(fits(38, true), false, "a root that fits the serial run is refused for the parallel one");
});
