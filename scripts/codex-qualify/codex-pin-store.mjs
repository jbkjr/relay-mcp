import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const OLD_VERSION = "0.163.0";
export const TEAM_ID = "2DC432GLL2";
const stable = /^\d+\.\d+\.\d+$/;
const digest = /^[a-f0-9]{64}$/;
// versions/: qualified on this Mac (manifest with its stage-2 verdict). shipped/: a release's
// shipped pin (decision 18), downloaded and verified against it (manifest with `shipped`, no verdict).
// The two never share a tree: a kind is fixed by the directory and checked against the manifest.
const targetPattern = /^(versions|shipped)\/(\d+\.\d+\.\d+)-([a-f0-9]{12})$/;
export const SHIPPED_PIN_FORMAT = "relay-shipped-codex-pin-v1";
export const LEGACY_VERDICT_SCHEMA = "stage2-v1";
export const CURRENT_VERDICT_SCHEMA = "stage2-v4";
const freezeParts = (parts) => Object.freeze(Object.fromEntries(Object.entries(parts).map(([id, names]) => [id, Object.freeze([...names])])));
// Fixed snapshot of EXPECTED_PARTS at 237bd74 (Relay 1.1.0), including escalation parts.
// Never derive a historical schema from the live driver or edit it when requirements grow.
const schemaV1 = freezeParts({
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
// Item 10 gains the effort evidence (Relay 1.1.1).
const schemaV2 = freezeParts({ ...schemaV1, 10: [...schemaV1[10], "effort"] });
// New requirements get a new fixed entry and advance CURRENT_VERDICT_SCHEMA; retain old entries.
export const VERDICT_SCHEMAS = Object.freeze({
  [LEGACY_VERDICT_SCHEMA]: schemaV1,
  "stage2-v2": schemaV2,
  // Item 12 gains the discovery-prefetch positive control.
  "stage2-v3": freezeParts({ ...schemaV2, 12: [...schemaV2[12], "prefetch"] }),
  // Item 33: the keychain under the never floor from native Codex turns (a floored decoy keychain and its control).
  "stage2-v4": freezeParts({ ...schemaV2, 12: [...schemaV2[12], "prefetch"], 33: ["codex"] }),
});
export const EXPECTED_PARTS = VERDICT_SCHEMAS[CURRENT_VERDICT_SCHEMA];
const knownSchema = (id) => typeof id === "string" && Object.hasOwn(VERDICT_SCHEMAS, id);
export const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Exit status alone is never a qualification verdict. Unknown/empty parts fail closed too. */
export function judgeVerdict(v, version, schemaId = CURRENT_VERDICT_SCHEMA) {
  const why = [];
  if (!knownSchema(schemaId)) return { ok: false, why: [`unknown verdict schema: ${schemaId}`] };
  if (v?.verdictSchema !== undefined && !knownSchema(v.verdictSchema)) why.push(`unknown verdict schema: ${v.verdictSchema}`);
  const expected = VERDICT_SCHEMAS[schemaId];
  if (v?.ok !== true || v?.state !== "passed") why.push("verdict did not pass");
  if (v?.version !== version) why.push("verdict version mismatch");
  if (v?.relayPath !== "present") why.push("relay path missing");
  const items = v?.items;
  const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (!object(items) || Object.keys(items).sort((a, b) => +a - +b).join(",") !== Object.keys(expected).join(",")) why.push(`expected exactly items ${Object.keys(expected).join(",")}`);
  for (const [id, item] of Object.entries(object(items) ? items : {})) {
    if (item?.state !== "passed" || !object(item.parts) || !Object.keys(item.parts).length) { why.push(`item ${id} lacks passed evidence`); continue; }
    for (const name of expected[id] ?? []) if (!Object.hasOwn(item.parts, name)) why.push(`item ${id}.${name} evidence missing`);
    for (const [name, part] of Object.entries(item.parts)) if (part?.state !== "passed") why.push(`item ${id}.${name} did not pass`);
  }
  return { ok: why.length === 0, why };
}

export function atomicJson(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
}

export function validateManifest(m) {
  if (!m || !stable.test(m.version) || !digest.test(m.binarySha256) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(m.npmIntegrity ?? "") ||
      m.codesign?.teamId !== TEAM_ID || typeof m.codesign?.identity !== "string" || !m.codesign.identity ||
      !Number.isFinite(Date.parse(m.qualifiedAt)) || !path.isAbsolute(m.verdictPath ?? "") ||
      !/^[a-f0-9]{40}$/.test(m.sourceCommit ?? "")) throw new Error("invalid pin manifest");
  const hasSchema = Object.hasOwn(m, "verdictSchema"), hasDigest = Object.hasOwn(m, "verdictSha256");
  if (hasSchema && !knownSchema(m.verdictSchema)) throw new Error(`unknown verdict schema: ${m.verdictSchema}`);
  if (hasSchema !== hasDigest || (hasDigest && !digest.test(m.verdictSha256))) throw new Error("invalid pin manifest verdict schema/digest");
  // New pins name relay's build (relay-build-v2, src/core/build-identity.ts; earlier builds wrote
  // relay-build-v1, without the dependency lock); earlier ones name a relay commit (relayCommit).
  // Each is a record of what ran, and none binds a local pin to the relay running now.
  // The shape of src/core/build-identity.ts isBuildIdentity, kept here because release-watch's
  // detect job imports this module (through codex-stage2.mjs) before anything is built.
  const b = m.relayBuild;
  if (Object.hasOwn(m, "relayBuild") && !isBuild(b, BUILD_RECORD_SCHEMES)) throw new Error("invalid pin manifest relay build");
  // A shipped tree's manifest (validateShippedTreeManifest) has no verdict, source commit or
  // qualification time, so it can never pass here, and a local one has keys a shipped one refuses.
  return m;
}

// src/core/build-identity.ts BUILD_SCHEME, and the schemes it reads as records (LEGACY_BUILD_SCHEMES);
// test/codex-shipped-pin.test.ts holds these to that module.
export const BUILD_SCHEME = "relay-build-v2";
export const BUILD_RECORD_SCHEMES = Object.freeze([BUILD_SCHEME, "relay-build-v1"]);
const isBuild = (b, schemes = [BUILD_SCHEME]) => !!b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).sort().join(",") === "scheme,sha256,version" &&
  schemes.includes(b.scheme) && typeof b.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(b.version) &&
  typeof b.sha256 === "string" && /^[a-f0-9]{64}$/.test(b.sha256);
const keysAre = (v, keys) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");

/**
 * A release's shipped pin, exactly as src/core/shipped-pin.ts parseShippedPin takes it (kept here
 * because this module loads before any build; test/codex-shipped-pin.test.ts holds the two to the
 * same answers). Only format, codex {version, npmIntegrity} and relay's build identity: any other
 * field, machine-specific or not, is refused.
 */
export function validateShippedPin(v) {
  if (!keysAre(v, ["format", "codex", "relay"]) || v.format !== SHIPPED_PIN_FORMAT) throw new Error("invalid shipped Codex pin: exactly format, codex and relay, in the known format");
  if (!keysAre(v.codex, ["version", "npmIntegrity"]) || !stable.test(v.codex.version ?? "") || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(v.codex.npmIntegrity ?? "")) throw new Error("invalid shipped Codex pin: codex is exactly a stable version and npm's sha512 integrity");
  if (isBuild(v.relay, BUILD_RECORD_SCHEMES) && v.relay.scheme !== BUILD_SCHEME) throw new Error(`invalid shipped Codex pin: relay's build is named under ${v.relay.scheme}, which does not cover the dependency lock; a shipped pin needs ${BUILD_SCHEME}`);
  if (!isBuild(v.relay)) throw new Error("invalid shipped Codex pin: relay is exactly relay's build identity");
  return v;
}

/**
 * The manifest of a shipped/ tree: a Codex release as relay downloaded and verified it here against
 * a release's shipped pin (npm's sha512 integrity, Apple's signature and OpenAI's Team ID, the exact
 * version). No verdict: that evidence is the maintainer's. The tree is not bound to one relay
 * build, so releases that ship the same Codex share it; relay binds it at every turn instead, to
 * the shipped pin in the package it runs from (src/backends/codex-pin.ts).
 */
export function validateShippedTreeManifest(m) {
  if (!keysAre(m, ["version", "binarySha256", "npmIntegrity", "codesign", "installedAt"]) || !stable.test(m.version ?? "") ||
      !digest.test(m.binarySha256 ?? "") || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(m.npmIntegrity ?? "") ||
      m.codesign?.teamId !== TEAM_ID || typeof m.codesign?.identity !== "string" || !m.codesign.identity ||
      !Number.isFinite(Date.parse(m.installedAt))) throw new Error("invalid shipped pin tree manifest");
  return m;
}

export function readManifest(dir) {
  const m = validateManifest(json(path.join(dir, "manifest.json")));
  if (sha256(path.join(dir, "bin/codex")) !== m.binarySha256) throw new Error("pin binary digest mismatch");
  // The external run file stays available for diagnosis. Bind new receipts to its exact bytes
  // and schema in the sealed manifest; unversioned manifests always mean the fixed v1 baseline.
  const bytes = fs.readFileSync(m.verdictPath);
  if (m.verdictSha256 && crypto.createHash("sha256").update(bytes).digest("hex") !== m.verdictSha256) throw new Error("pin verdict digest mismatch");
  const v = JSON.parse(bytes.toString("utf8"));
  const schemaId = m.verdictSchema ?? LEGACY_VERDICT_SCHEMA;
  const verdict = judgeVerdict(v, m.version, schemaId);
  if (!verdict.ok) throw new Error(`pin verdict invalid: ${verdict.why.join("; ")}`);
  if ((v.verdictSchema ?? LEGACY_VERDICT_SCHEMA) !== schemaId) throw new Error("pin verdict schema disagrees with manifest");
  return m;
}

export function initStore(store) {
  for (const d of [store, path.join(store, "versions"), path.join(store, "shipped"), path.join(store, "staging"), path.join(store, "runs")]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

/** The store is trusted, but reject accidental external pointers and mutable directory aliases. */
export function validateTarget(store, target) {
  const match = targetPattern.exec(target ?? "");
  if (!match) throw new Error("pin target must be a relative versions/ or shipped/<version>-<digest12> path");
  const dir = path.join(store, target);
  if (fs.realpathSync(dir) !== path.join(fs.realpathSync(store), target)) throw new Error("pin target traverses a symlink");
  if (fs.statSync(dir).mode & 0o222) throw new Error("pin publication was not sealed; inspect the unreferenced tree");
  const m = match[1] === "shipped" ? readShippedTree(dir) : readManifest(dir);
  if (m.version !== match[2] || m.binarySha256.slice(0, 12) !== match[3]) throw new Error("pin target disagrees with manifest");
  return m;
}

export function readShippedTree(dir) {
  const m = validateShippedTreeManifest(json(path.join(dir, "manifest.json")));
  if (sha256(path.join(dir, "bin/codex")) !== m.binarySha256) throw new Error("pin binary digest mismatch");
  return m;
}

/** Whether a target names a shipped pin's tree (shipped/) rather than a local qualification's (versions/). */
export const isShippedTarget = (target) => targetPattern.exec(target ?? "")?.[1] === "shipped";

export function pointer(store, name) {
  const file = path.join(store, name);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (!st.isSymbolicLink()) throw new Error(`${name} must be a symlink`);
  const target = fs.readlinkSync(file);
  validateTarget(store, target);
  return target;
}

export function swapPointer(store, name, target) {
  validateTarget(store, target);
  const tmp = path.join(store, `.${name}-${crypto.randomUUID()}`);
  try { fs.symlinkSync(target, tmp); fs.renameSync(tmp, path.join(store, name)); }
  finally { fs.rmSync(tmp, { force: true }); }
}

export function readJournal(store) {
  let text;
  try { text = fs.readFileSync(path.join(store, "journal.jsonl"), "utf8"); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  // A torn write is not silently ignored: recover the pending transaction before editing history.
  if (text && !text.endsWith("\n")) throw new Error("truncated promotion journal");
  return text.trim() ? text.trimEnd().split("\n").map((line) => {
    return validateJournalRecord(JSON.parse(line));
  }) : [];
}

function validateJournalRecord(r) {
  if (!["promote", "rollback"].includes(r?.action) || typeof r.id !== "string" || !r.id || !Number.isFinite(Date.parse(r.at)) ||
      (r.from !== null && !targetPattern.test(r.from)) || !targetPattern.test(r.to)) throw new Error("invalid promotion journal entry");
  return r;
}

function appendJournal(store, record) {
  validateJournalRecord(record);
  const records = readJournal(store);
  if (records.some((r) => r.id === record.id)) return;
  const fd = fs.openSync(path.join(store, "journal.jsonl"), "a", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

/** Repair an interruption between pointer swaps and journal append. Never guess after corruption. */
export function recoverTransaction(store) {
  const file = path.join(store, "pending.json");
  if (!fs.existsSync(file)) { readJournal(store); return; }
  const tx = validateJournalRecord(json(file));
  validateTarget(store, tx.to);
  if (tx.from !== null) validateTarget(store, tx.from);
  if (tx.previousBefore !== null) validateTarget(store, tx.previousBefore);
  const current = pointer(store, "current");
  if (current === tx.to) appendJournal(store, tx);
  else if (current === tx.from) {
    if (tx.previousBefore !== null) swapPointer(store, "previous", tx.previousBefore);
    else fs.rmSync(path.join(store, "previous"), { force: true });
  } else throw new Error("pending promotion disagrees with current; manual recovery required");
  fs.rmSync(file);
}

/** Caller holds the store lock. Each symlink replacement is atomic; current is the commit point. */
export function promote(store, target, action = "promote", beforeCurrent = () => {}) {
  recoverTransaction(store);
  validateTarget(store, target);
  const from = pointer(store, "current"), previousBefore = pointer(store, "previous");
  if (from === target) return null;
  const tx = { id: crypto.randomUUID(), action, at: new Date().toISOString(), from, to: target, previousBefore };
  atomicJson(path.join(store, "pending.json"), tx);
  // Bootstrap has no old binary: previous is absent until the second successful promotion.
  if (from !== null) swapPointer(store, "previous", from);
  beforeCurrent();
  swapPointer(store, "current", target);
  appendJournal(store, tx);
  fs.rmSync(path.join(store, "pending.json"));
  return tx;
}

export function rollback(store) {
  recoverTransaction(store);
  const target = pointer(store, "previous");
  if (!target) throw new Error("no previous qualified pin to roll back to");
  const history = readJournal(store);
  const last = history.at(-1);
  if (!last || last.to !== pointer(store, "current") || last.from !== target) throw new Error("previous does not match the recorded promotion journal");
  return promote(store, target, "rollback");
}

/** Complete tree staged on the store filesystem, never rewritten after publication. */
export function publishTree(store, vendor, manifest) {
  validateManifest(manifest);
  if (manifest.verdictSchema !== CURRENT_VERDICT_SCHEMA) throw new Error("new pin publication requires the current verdict schema");
  return publishSealed(store, `versions/${manifest.version}-${manifest.binarySha256.slice(0, 12)}`, vendor, manifest, readManifest);
}

/**
 * A release's shipped pin, as relay downloaded and verified it here (codex-shipped-pin.mjs
 * installShippedPin is the only caller). Its tree goes under shipped/, never versions/, so it can
 * never be taken for a local qualification, nor a local qualification of the same binary for it.
 */
export function publishShippedTree(store, vendor, manifest) {
  validateShippedTreeManifest(manifest);
  return publishSealed(store, `shipped/${manifest.version}-${manifest.binarySha256.slice(0, 12)}`, vendor, manifest, readShippedTree);
}

function publishSealed(store, target, vendor, manifest, read) {
  const dest = path.join(store, target);
  if (fs.existsSync(dest)) {
    validateTarget(store, target);
    if (read(dest).binarySha256 !== manifest.binarySha256) throw new Error("pin digest prefix collision");
    return target;
  }
  const staging = fs.mkdtempSync(path.join(store, "staging", "publish-"));
  try {
    for (const name of fs.readdirSync(vendor)) fs.cpSync(path.join(vendor, name), path.join(staging, name), { recursive: true, force: false, errorOnExist: true });
    atomicJson(path.join(staging, "manifest.json"), manifest);
    read(staging);
    const seal = (dir, top = false) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error("vendor symlinks are not allowed");
        if (entry.isDirectory()) seal(file);
        else if (entry.isFile()) fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o555 : 0o444);
        else throw new Error("special vendor file is not allowed");
      }
      // macOS requires write permission on a directory moved between parents (its '..' changes).
      // Seal the root immediately after the rename, before any current/previous pointer exists.
      if (!top) fs.chmodSync(dir, 0o555);
    };
    seal(staging, true);
    fs.renameSync(staging, dest);
    fs.chmodSync(dest, 0o555);
  } catch (e) {
    // Preserve a failed, possibly sealed staging tree for diagnosis.
    throw new Error(`publishing ${staging}: ${e.message}`, { cause: e });
  }
  return target;
}

/** Empty/recent locks are busy until staleMs. Never take a lock held by a living PID. */
export function acquireLock(store, { pid = process.pid, alive = pidAlive, staleMs = 30_000, now = Date.now() } = {}) {
  const file = path.join(store, "lock");
  const ownerFile = path.join(file, "owner.json");
  const owner = { pid, token: crypto.randomUUID(), createdAt: now };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(file, { mode: 0o700 });
      atomicJson(ownerFile, owner);
      return () => {
        if (json(ownerFile).token === owner.token) fs.rmSync(file, { recursive: true });
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let stat;
      try { stat = fs.statSync(file); } catch (statError) { if (statError.code === "ENOENT") continue; throw statError; }
      let old;
      try { old = json(ownerFile); } catch { /* a writer may still be publishing its owner */ }
      if (old && Number.isInteger(old.pid) && old.pid > 0 && alive(old.pid)) return null;
      if (now - stat.mtimeMs < staleMs) return null;
      // Keep the nonempty tombstone: two stale-lock reclaimers cannot rename a new owner's lock
      // over the same nonempty directory. This closes the stat/unlink ABA race across processes.
      try {
        const next = fs.statSync(file);
        if (stat.ino !== next.ino || stat.mtimeMs !== next.mtimeMs) continue;
        fs.writeFileSync(path.join(file, "stale"), "reclaimed\n", { flag: "a", mode: 0o600 });
        const tombstone = path.join(store, "staging", `stale-lock-${stat.dev}-${stat.ino}`);
        fs.renameSync(file, tombstone);
      } catch (renameError) { if (!["EEXIST", "ENOTEMPTY", "ENOENT"].includes(renameError.code)) throw renameError; }
    }
  }
  return null; // Another updater won recovery; leave it to finish.
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === "EPERM") return true; if (e.code === "ESRCH") return false; throw e; }
}
