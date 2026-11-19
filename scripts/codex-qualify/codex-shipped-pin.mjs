#!/usr/bin/env node
// A release's shipped Codex pin (decision 18; format in src/core/shipped-pin.ts).
//
// - writeShippedPin: the maintainer's side, and the only code that writes codex-pin.json. It writes
//   one only from the pin store's current pin when that is a qualification on this Mac (versions/),
//   re-judged now against the current verdict schema with its verdict bound by digest, and when
//   that qualification ran exactly the build being released.
// - installShippedPin: the user's side (`relay install codex --write`, `relay qualify-codex
//   --shipped`). It downloads the Codex release the package's shipped pin names, refuses unless
//   npm's integrity is the pinned one (before downloading) and the bytes match it, checks Apple's
//   signature, OpenAI's Team ID and the exact version as the qualifier does, and publishes the tree
//   under shipped/. Relay then runs it only while the running build is the one the pin names
//   (src/backends/codex-pin.ts). It never replaces a local pin unless asked to.
// - checkTarball: a packed release carries a valid shipped pin for exactly its own build.
//
//   node scripts/codex-qualify/codex-shipped-pin.mjs --write --store /abs/pin-store [--package /abs/relay]
//   node scripts/codex-qualify/codex-shipped-pin.mjs --check-tarball relay-X.Y.Z.tgz
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { acquire, liveServices } from "./codex-qualifier.mjs";
import { ProcessSupervisor } from "./codex-qualifier-process.mjs";
import {
  CURRENT_VERDICT_SCHEMA, acquireLock, atomicJson, initStore, isShippedTarget, pointer, promote,
  publishShippedTree, recoverTransaction, sha256, validateTarget,
} from "./codex-pin-store.mjs";
import { isMain } from "./main-module.mjs";
import { buildIdentity, describeBuild, sameBuild } from "../../dist/core/build-identity.js";
import { SHIPPED_PIN_FILE, SHIPPED_PIN_FORMAT, parseShippedPin, readShippedPin, sameShippedPin } from "../../dist/core/shipped-pin.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * The shipped pin a passing local qualification in `store` supports for the relay build at
 * `packageRoot`, written to <packageRoot>/codex-pin.json. Throws, writing nothing, unless every
 * condition holds; holds the store's lock so that current cannot move underneath.
 */
export function writeShippedPin({ store, packageRoot = PACKAGE_ROOT }) {
  if (!path.isAbsolute(store ?? "") || !path.isAbsolute(packageRoot ?? "")) throw new Error("store and package must be absolute");
  const release = acquireLock(store);
  if (!release) throw new Error(`the pin store ${store} is locked by a running qualifier; wait for it`);
  try {
    recoverTransaction(store);
    const current = pointer(store, "current");
    if (!current) throw new Error(`${store} has no current pin: qualify the release's Codex first`);
    if (isShippedTarget(current)) throw new Error(`current (${current}) is a release's shipped pin, not a qualification on this Mac`);
    // validateTarget re-reads the sealed manifest and the binary's digest, and re-judges the
    // verdict file, bound to the manifest by its sha256, against the manifest's schema.
    const m = validateTarget(store, current);
    if (m.qualificationFixture) throw new Error("current is a stage-2 fixture pin, not a qualification");
    if (m.verdictSchema !== CURRENT_VERDICT_SCHEMA || !m.verdictSha256) {
      throw new Error(`current was qualified under ${m.verdictSchema ?? "the unversioned stage2-v1 schema"}; a shipped pin needs a qualification under ${CURRENT_VERDICT_SCHEMA}`);
    }
    if (sha256(m.verdictPath) !== m.verdictSha256) throw new Error("the qualification's verdict changed since it was judged");
    const build = buildIdentity(packageRoot);
    if (!m.relayBuild) throw new Error("current was qualified before relay had build identities (it names a relay commit); qualify again with this build");
    if (m.relayBuild.scheme !== build.scheme) throw new Error(`current was qualified under ${m.relayBuild.scheme}, which does not cover relay's dependency lock; qualify again with this build (${build.scheme})`);
    if (!sameBuild(m.relayBuild, build)) throw new Error(`current was qualified with ${describeBuild(m.relayBuild)}, not ${describeBuild(build)}, the build being released`);
    const pin = parseShippedPin({
      format: SHIPPED_PIN_FORMAT,
      codex: { version: m.version, npmIntegrity: m.npmIntegrity },
      relay: { scheme: build.scheme, version: build.version, sha256: build.sha256 },
    });
    atomicJson(path.join(packageRoot, SHIPPED_PIN_FILE), pin);
    fs.chmodSync(path.join(packageRoot, SHIPPED_PIN_FILE), 0o644);
    return { pin, from: current, verdictPath: m.verdictPath };
  } finally {
    release();
  }
}

/**
 * Puts the shipped pin of the relay at `packageRoot` in place in `store` and makes it current.
 * Returns { state }: "none" (this relay ships no pin), "unchanged", "local-kept" (current is a
 * qualification on this Mac and `replaceLocal` is false), "installed", "busy" or "failed".
 */
export async function installShippedPin({ store, packageRoot = PACKAGE_ROOT, replaceLocal = false, services: supplied, supervisor: suppliedSupervisor } = {}) {
  if (!path.isAbsolute(store ?? "")) throw new Error("store must be absolute");
  const shipped = readShippedPin(packageRoot);
  if (!shipped) return { state: "none" };
  const build = buildIdentity(packageRoot);
  if (!sameBuild(build, shipped.relay)) {
    return { state: "failed", error: `this relay's shipped pin was qualified with ${describeBuild(shipped.relay)}, and this package is ${describeBuild(build)}: the package was changed after it was released. Reinstall relay, or qualify a Codex here with relay qualify-codex.` };
  }
  initStore(store);
  const release = acquireLock(store);
  if (!release) return { state: "busy" };
  let scratch;
  try {
    recoverTransaction(store);
    const current = pointer(store, "current");
    if (current) {
      const m = validateTarget(store, current);
      if (isShippedTarget(current) && m.version === shipped.codex.version && m.npmIntegrity === shipped.codex.npmIntegrity) return { state: "unchanged", target: current, shipped };
      if (!isShippedTarget(current) && !replaceLocal) return { state: "local-kept", target: current, version: m.version, shipped };
    }
    scratch = fs.mkdtempSync(path.join(store, "staging", "shipped-"));
    const supervisor = suppliedSupervisor ?? new ProcessSupervisor(scratch);
    const services = supplied ?? liveServices(scratch, supervisor);
    const candidate = await acquire(shipped.codex.version, scratch, services, { integrity: shipped.codex.npmIntegrity });
    if (candidate.npmIntegrity !== shipped.codex.npmIntegrity) throw new Error("downloaded Codex does not match the shipped pin's integrity");
    const manifest = {
      version: shipped.codex.version, binarySha256: candidate.binarySha256, npmIntegrity: candidate.npmIntegrity,
      codesign: candidate.codesign, installedAt: new Date().toISOString(),
    };
    const target = publishShippedTree(store, candidate.vendor, manifest);
    const transaction = promote(store, target, "promote");
    atomicJson(path.join(store, "last-result.json"), { state: "shipped", version: manifest.version, target, transaction, relay: shipped.relay });
    return { state: "installed", target, shipped, previous: current };
  } catch (err) {
    let recoveryError;
    try { recoverTransaction(store); } catch (e) { recoveryError = e.message; }
    return { state: "failed", error: err.message, ...(recoveryError ? { recoveryError } : {}) };
  } finally {
    if (scratch) {
      const unseal = (dir) => { try { fs.chmodSync(dir, 0o700); for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unseal(path.join(dir, e.name)); } catch { /* gone */ } };
      unseal(scratch);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    release();
  }
}

/** A packed release (npm pack's .tgz): its codex-pin.json must be valid and name exactly the build it packs. */
export function checkTarball(tarball) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tarball-"));
  try {
    const r = spawnSync("/usr/bin/tar", ["-xzf", tarball, "-C", dir], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`cannot unpack ${tarball}: ${r.stderr.trim()}`);
    const root = path.join(dir, "package");
    const pin = readShippedPin(root);
    if (!pin) throw new Error(`${tarball} carries no ${SHIPPED_PIN_FILE}`);
    const build = buildIdentity(root);
    if (!sameBuild(build, pin.relay)) throw new Error(`${tarball}'s shipped pin names ${describeBuild(pin.relay)}, and it packs ${describeBuild(build)}`);
    return { pin, build };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export { sameShippedPin };

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { write: { type: "boolean" }, store: { type: "string" }, package: { type: "string" }, "check-tarball": { type: "string" } } });
    if (values.write && values.store && !values["check-tarball"]) {
      const { pin, from, verdictPath } = writeShippedPin({ store: values.store, packageRoot: values.package ?? PACKAGE_ROOT });
      console.log(`Wrote ${path.join(values.package ?? PACKAGE_ROOT, SHIPPED_PIN_FILE)} from ${from} (verdict ${verdictPath}):\n${JSON.stringify(pin, null, 2)}`);
    } else if (values["check-tarball"] && !values.write) {
      const { pin, build } = checkTarball(path.resolve(values["check-tarball"]));
      console.log(`${values["check-tarball"]}: shipped pin for Codex ${pin.codex.version}, qualified with ${describeBuild(build)}: matches the build it packs.`);
    } else {
      throw new Error("usage: codex-shipped-pin.mjs --write --store /abs/pin-store [--package /abs/relay] | --check-tarball relay.tgz");
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
