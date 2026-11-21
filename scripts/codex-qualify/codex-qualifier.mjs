#!/usr/bin/env node
// Based on docs/research/pinned-codex-probes/qualifier.draft.mjs (feasibility job).
// No login or model traffic: only the existing model-free stage2 driver is invoked.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { scratchEnv } from "./scratch-env.mjs";
import { ProcessSupervisor } from "./codex-qualifier-process.mjs";
import {
  CURRENT_VERDICT_SCHEMA, OLD_VERSION, TEAM_ID, acquireLock, atomicJson, initStore, isShippedTarget, judgeVerdict, pointer,
  promote, publishTree, recoverTransaction, rollback, sha256, validateTarget,
} from "./codex-pin-store.mjs";
import { isMain } from "./main-module.mjs";
import { buildIdentity, copyBuild, describeBuild, sameBuild } from "../../dist/core/build-identity.js";

export const NOTIFICATION_SCRIPT = 'on run argv\ndisplay notification (item 1 of argv) with title "Relay Codex qualification"\nend run';

// The longest socket path the driver's relay turns make, below a scratch root. macOS allows 103 bytes.
const LONGEST_SOCKET = "/run-XXXXXX/stage2/home/.relay-t/s/relay-probe-XXXXXX/relay.sock";
// The parallel run (stage2-parallel.mjs) puts each driver one level deeper, the longest at stage2/main.
const LONGEST_PARALLEL_SOCKET = LONGEST_SOCKET.replace("/stage2/", "/stage2/main/");

/** `parallel`: whether stage 2 runs as two drivers at once (stage2-parallel.mjs), which nests its scratch one level deeper. */
export function validateConfig(input, { parallel = false } = {}) {
  const cfg = { store: path.join(os.homedir(), ".local/share/relay-codex-pins"), scratchRoot: path.join(os.homedir(), ".rsm/q"), timeoutMs: 2 * 60 * 60_000, ...input };
  for (const key of ["repo", "store", "scratchRoot"]) if (!path.isAbsolute(cfg[key] ?? "")) throw new Error(`${key} must be absolute`);
  if (Buffer.byteLength(cfg.scratchRoot + (parallel ? LONGEST_PARALLEL_SOCKET : LONGEST_SOCKET)) > 103) throw new Error(`scratchRoot ${cfg.scratchRoot} is too long: relay's unix sockets below it would pass macOS's 103-byte limit`);
  if (cfg.oldBin !== undefined && !path.isAbsolute(cfg.oldBin)) throw new Error("oldBin must be absolute");
  if (!Number.isSafeInteger(cfg.timeoutMs) || cfg.timeoutMs < 1000 || cfg.timeoutMs > 2 * 60 * 60_000) throw new Error("timeoutMs must be 1000..7200000");
  return cfg;
}

export function verifyIntegrity(bytes, integrity) {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity ?? "")) throw new Error("npm must supply a single sha512 SRI");
  const actual = "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64");
  if (actual !== integrity) throw new Error("npm SRI mismatch");
}

/** Acquisition and child execution seams allow the whole orchestration to run on local fixtures. */
export function liveServices(root, supervisor) {
  const command = (bin, args, options = {}) => supervisor.run(bin, args, { env: scratchEnv(root), ...options });
  const get = async (url, file) => {
    const args = ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--retry", "2", "--max-time", "300", url];
    if (file) args.push("--output", file);
    return command("/usr/bin/curl", args, { timeoutMs: 330_000 });
  };
  return {
    command,
    json: async (url) => JSON.parse(await get(url)),
    download: async (url, file) => { await get(url, file); },
    // `members`: only these, so links elsewhere in the archive are never written. Paths are checked for the whole archive.
    unpack: async (archive, dest, members = []) => {
      const names = await command("/usr/bin/tar", ["-tzf", archive]);
      if (!names.trim() || names.split("\n").some((n) => n.startsWith("/") || n.split("/").includes(".."))) throw new Error("unsafe archive member path");
      const types = await command("/usr/bin/tar", ["-tvzf", archive, ...members]);
      if (types.trimEnd().split("\n").some((line) => !/^[d-]/.test(line))) throw new Error("archive links and special files are forbidden");
      fs.mkdirSync(dest, { mode: 0o700 });
      await command("/usr/bin/tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", dest, ...members]);
    },
    notify: async (text) => { await command("/usr/bin/osascript", ["-e", NOTIFICATION_SCRIPT, text], { timeoutMs: 10_000 }); },
  };
}

export async function verifyBinary(bin, version, services) {
  await services.command("/usr/bin/codesign", ["--verify", "--strict", "-R=anchor apple generic and certificate leaf[subject.OU] = \"2DC432GLL2\"", bin]);
  const identityText = await services.command("/usr/bin/codesign", ["-dv", "--verbose=4", bin], { combineOutput: true });
  const team = /^TeamIdentifier=(.+)$/m.exec(identityText)?.[1]?.trim();
  const identity = /^Authority=(.+)$/m.exec(identityText)?.[1]?.trim();
  if (team !== TEAM_ID || !identity) throw new Error("unexpected codesign identity");
  const said = (await services.command(bin, ["--version"], { timeoutMs: 30_000 })).trim();
  if (said !== `codex-cli ${version}`) throw new Error(`binary version mismatch: expected ${version}, got ${said}`);
  return { teamId: team, identity };
}

/** `integrity`: the sha512 SRI the package must have (a release's shipped pin); npm's metadata is refused before any download when it names another. */
export async function acquire(version, root, services, { integrity } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("candidate must be stable semver");
  const meta = await services.json(`https://registry.npmjs.org/@openai/codex/${version}-darwin-arm64`);
  if (meta.version !== `${version}-darwin-arm64`) throw new Error("npm metadata version mismatch");
  if (integrity !== undefined && meta.dist?.integrity !== integrity) throw new Error(`npm's integrity for @openai/codex@${version}-darwin-arm64 is not the one relay's shipped pin names`);
  const url = new URL(meta.dist.tarball);
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") throw new Error("unexpected npm tarball origin");
  const archive = path.join(root, `codex-${version}.tgz`);
  await services.download(url.href, archive);
  verifyIntegrity(fs.readFileSync(archive), meta.dist.integrity);
  const extracted = path.join(root, `package-${version}`);
  await services.unpack(archive, extracted);
  const vendor = path.join(extracted, "package/vendor/aarch64-apple-darwin");
  const pkg = JSON.parse(fs.readFileSync(path.join(vendor, "codex-package.json"), "utf8"));
  if (pkg.version !== version || pkg.entrypoint !== "bin/codex") throw new Error("unreviewed Codex vendor layout");
  const bin = path.join(vendor, "bin/codex");
  const codesign = await verifyBinary(bin, version, services);
  return { vendor, bin, npmIntegrity: meta.dist.integrity, binarySha256: sha256(bin), codesign };
}

async function sourceFor(version, root, services) {
  let ref = (await services.json(`https://api.github.com/repos/openai/codex/git/ref/tags/rust-v${version}`)).object;
  for (let n = 0; ref?.type === "tag" && n < 5; n++) {
    if (!/^[a-f0-9]{40}$/.test(ref.sha)) throw new Error("invalid annotated tag");
    ref = (await services.json(`https://api.github.com/repos/openai/codex/git/tags/${ref.sha}`)).object;
  }
  if (ref?.type !== "commit" || !/^[a-f0-9]{40}$/.test(ref.sha)) throw new Error("cannot resolve source tag to commit");
  const archive = path.join(root, "source.tar.gz");
  await services.download(`https://codeload.github.com/openai/codex/tar.gz/${ref.sha}`, archive);
  const extracted = path.join(root, "source");
  // The driver reads only the model catalog. The tree holds links (rust-v0.164.0: vendor/bubblewrap/LICENSE), which unpack refuses.
  await services.unpack(archive, extracted, [`codex-${ref.sha}/codex-rs/models-manager/models.json`]);
  const source = path.join(extracted, `codex-${ref.sha}`, "codex-rs");
  if (!fs.statSync(source).isDirectory()) throw new Error("source archive lacks codex-rs");
  return { source, sourceCommit: ref.sha, sourceArchiveSha256: sha256(archive) };
}

function failedQualificationPath(store, attempt) {
  // Keyed by relay's build identity, scheme included (relay-build-v2). Records keyed by a relay
  // commit, or by a relay-build-v1 identity, match nothing now, so those inputs are qualified again.
  const key = crypto.createHash("sha256").update(JSON.stringify([attempt.version, attempt.binarySha256, attempt.relayBuild.scheme, attempt.relayBuild.version, attempt.relayBuild.sha256])).digest("hex");
  return path.join(store, "failed-qualifications", `${key}.json`);
}

/**
 * Holds one updater/rollback lock. Durable evidence is retained on every failure. `parallel` runs
 * stage 2 through stage2-parallel.mjs (item 30's hour-long call beside the other items, in two
 * driver processes) instead of codex-stage2.mjs alone; off unless asked for.
 */
export async function runQualifier(input, { services: supplied, supervisor: suppliedSupervisor, version: requested, force = false, signals = true, aqua = true, parallel = false } = {}) {
  const cfg = validateConfig(input, { parallel });
  initStore(cfg.store);
  const release = acquireLock(cfg.store);
  if (!release) return { state: "busy" };
  let runDir, scratch;
  try {
    runDir = fs.mkdtempSync(path.join(cfg.store, "runs", `${new Date().toISOString().replaceAll(":", "-")}-`));
    fs.mkdirSync(cfg.scratchRoot, { recursive: true, mode: 0o700 });
    scratch = fs.mkdtempSync(path.join(cfg.scratchRoot, "run-"));
  } catch (e) { release(); throw e; }
  const supervisor = suppliedSupervisor ?? new ProcessSupervisor(scratch, {
    onSlowInventory: (ms) => fs.appendFileSync(path.join(runDir, "runner.log"), `${new Date().toISOString()} watchdog: process inventory took ${ms} ms\n`, { mode: 0o600 }),
  });
  const services = supplied ?? liveServices(scratch, supervisor);
  let version = requested ?? "unknown";
  const onTerm = () => supervisor.cancel("interrupted by SIGTERM/logout");
  const onInt = () => supervisor.cancel("interrupted by SIGINT");
  if (signals) { process.on("SIGTERM", onTerm); process.on("SIGINT", onInt); }
  const log = (message) => { fs.appendFileSync(path.join(runDir, "runner.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }); console.log(message); };
  try {
    recoverTransaction(cfg.store);
    if (aqua && (await services.command("/bin/launchctl", ["managername"])).trim() !== "Aqua") throw new Error("qualification requires the Aqua (desktop) login session: run it from a terminal in your own desktop login, or from its LaunchAgent");
    if (!fs.existsSync(path.join(cfg.repo, "dist/backends/codex.js"))) throw new Error("repo must be a trusted, built relay: a git checkout after npm run build, or an npm install");
    // What the pin will say was qualified (src/core/build-identity.ts). Computed before anything is
    // downloaded, so an incomplete build fails here and not an hour into stage 2.
    const relayBuild = buildIdentity(cfg.repo);
    if (!requested) version = (await services.json("https://registry.npmjs.org/@openai/codex/latest")).version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("latest must be a stable semver");
    const current = pointer(cfg.store, "current");
    // A release's shipped pin is the maintainer's qualification, not this Mac's: running the
    // qualifier qualifies the version here even when the shipped pin already names it.
    if (current && !isShippedTarget(current) && validateTarget(cfg.store, current).version === version) {
      const result = { state: "unchanged", version, runDir, target: current };
      atomicJson(path.join(cfg.store, "last-result.json"), result);
      log(`Codex ${version} already qualified`);
      return result;
    }
    log(`Acquiring Codex ${version}`);
    const candidate = await acquire(version, scratch, services);
    const attempt = { version, binarySha256: candidate.binarySha256, relayBuild };
    const failedPath = failedQualificationPath(cfg.store, attempt);
    if (!force) {
      let failed;
      try { failed = JSON.parse(fs.readFileSync(failedPath, "utf8")); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      if (failed?.version === version && failed.binarySha256 === attempt.binarySha256 && failed.relayBuild && sameBuild(failed.relayBuild, relayBuild)) {
        const result = { state: "skipped", ...attempt, runDir, failedAt: failed.at, verdictPath: failed.verdictPath };
        atomicJson(path.join(cfg.store, "last-result.json"), result);
        log(`Skipped Codex ${version}: binary SHA-256 ${attempt.binarySha256} already failed with ${describeBuild(relayBuild)} on ${failed.at}; verdict: ${failed.verdictPath}`);
        return result;
      }
    }
    let oldBin = cfg.oldBin;
    if (oldBin) await verifyBinary(oldBin, OLD_VERSION, services);
    else oldBin = (await acquire(OLD_VERSION, scratch, services)).bin;
    const source = await sourceFor(version, scratch, services);
    // Stage 2 runs from a verified copy of the build in scratch: Node strips TypeScript types only
    // outside node_modules, where an npm install lives, and the source cannot change under the run.
    const tree = path.join(scratch, "relay");
    copyBuild(cfg.repo, tree);
    const driver = path.join(tree, "scripts/codex-qualify/codex-stage2.mjs");
    const stage2Sha256 = sha256(driver);
    // The parallel coordinator is the one command the supervisor runs; it runs two drivers below it.
    const coordinator = path.join(tree, "scripts/codex-qualify/stage2-parallel.mjs");
    const mode = parallel ? "parallel" : "serial";
    const out = path.join(scratch, "stage2");
    log(`Running stage 2 (${mode})`);
    const logFd = fs.openSync(path.join(runDir, "stage2.log"), "wx", 0o600);
    let driverError;
    try {
      await services.command(process.execPath, [parallel ? coordinator : driver, tree, out, version, candidate.bin, "--source", source.source, "--old-bin", oldBin], {
        cwd: tree, timeoutMs: cfg.timeoutMs, logFd, inspect: true,
        // Items 28 and 30 stay "not run" without these, and judgeVerdict refuses a verdict with any part not run.
        env: { RELAY_TEST_PUBLIC_NET: "1", RELAY_TEST_ESCALATION_LONG: "1" },
      });
    } catch (e) { driverError = e; }
    finally { fs.closeSync(logFd); }
    const scratchVerdict = path.join(out, "stage2-verdict.json");
    if (driverError && !fs.existsSync(scratchVerdict)) throw driverError;
    const verdict = JSON.parse(fs.readFileSync(scratchVerdict, "utf8"));
    const verdictPath = path.join(runDir, "stage2-verdict.json");
    atomicJson(verdictPath, verdict);
    // A parallel run's verdict is the coordinator's, never one driver's alone.
    if (parallel && verdict.mode !== "parallel") throw driverError ?? new Error(`stage 2 ran in parallel but its verdict says mode ${verdict.mode}`);
    // A candidate cannot opt into a historical schema: judge against the current one.
    const judged = judgeVerdict(verdict, version, CURRENT_VERDICT_SCHEMA);
    if (!judged.ok) {
      // Only a completed, rejected verdict is reusable. Acquisition/driver crashes without
      // a verdict and failures after a passing verdict must remain retryable.
      fs.mkdirSync(path.dirname(failedPath), { recursive: true, mode: 0o700 });
      atomicJson(failedPath, { ...attempt, at: new Date().toISOString(), verdictPath });
      throw driverError ?? new Error(judged.why.join("; "));
    }
    // Stamp the schema actually enforced.
    verdict.verdictSchema = CURRENT_VERDICT_SCHEMA;
    atomicJson(verdictPath, verdict);
    // A forced retry can overturn a prior failure. Do not let that old record suppress
    // retries if this passing qualification encounters a driver/publication/promotion error.
    fs.rmSync(failedPath, { force: true });
    if (driverError) throw driverError;
    supervisor.check();
    // Refuse a build (the source or the copy that ran) or a binary changed while qualification was running.
    if (sha256(candidate.bin) !== candidate.binarySha256 || !sameBuild(buildIdentity(tree), relayBuild) ||
        !sameBuild(buildIdentity(cfg.repo), relayBuild)) throw new Error("qualification inputs changed during run");
    const manifest = {
      version, npmIntegrity: candidate.npmIntegrity, binarySha256: candidate.binarySha256, codesign: candidate.codesign,
      qualifiedAt: new Date().toISOString(), verdictPath, verdictSchema: CURRENT_VERDICT_SCHEMA,
      verdictSha256: sha256(verdictPath), sourceCommit: source.sourceCommit,
      sourceArchiveSha256: source.sourceArchiveSha256, relayBuild, stage2Sha256, nodeVersion: process.version,
      stage2Mode: mode, ...(parallel ? { stage2ParallelSha256: sha256(coordinator) } : {}),
    };
    const target = publishTree(cfg.store, candidate.vendor, manifest);
    const transaction = promote(cfg.store, target, "promote", () => supervisor.check());
    atomicJson(path.join(cfg.store, "last-result.json"), { state: "promoted", version, runDir, target, transaction });
    log(`Promoted Codex ${version} to ${target}`);
    return { state: "promoted", version, target, runDir };
  } catch (err) {
    // Restore previous on an aborted pre-commit swap, or finish the journal after the current
    // commit point. A recovery error remains visible alongside the original failure.
    let recoveryError;
    try { recoverTransaction(cfg.store); } catch (e) { recoveryError = e.stack ?? String(e); }
    const failure = { state: "failed", version, at: new Date().toISOString(), runDir, scratch, error: err.stack ?? String(err) };
    if (recoveryError) failure.recoveryError = recoveryError;
    atomicJson(path.join(runDir, "failure.json"), failure);
    atomicJson(path.join(cfg.store, "last-failure.json"), failure);
    atomicJson(path.join(cfg.store, "last-result.json"), failure);
    log(`FAILED Codex ${version}: ${err.stack ?? err}`);
    // A cancelled supervisor refuses new work. Use a fresh bounded supervisor for notification.
    try { await (supplied?.notify ?? liveServices(scratch, new ProcessSupervisor(scratch)).notify)(`Codex ${version}: qualification/update failed. See ${runDir} and current pin/journal.`); }
    catch (notifyError) { log(`Notification failed: ${notifyError.message}`); }
    return failure;
  } finally {
    if (signals) { process.off("SIGTERM", onTerm); process.off("SIGINT", onInt); }
    // Scratch is deliberately retained: diagnosis and watchdog reproduction use the exact tree.
    release();
  }
}

export function runRollback(input) {
  const cfg = validateConfig(input);
  initStore(cfg.store);
  const release = acquireLock(cfg.store);
  if (!release) throw new Error("qualifier is running; rollback did not run");
  try { return rollback(cfg.store); } finally { release(); }
}

if (isMain(import.meta.url)) {
  process.umask(0o077);
  const [configFile, action, ...rest] = process.argv.slice(2);
  let options;
  try {
    const { values } = parseArgs({ args: rest, options: { version: { type: "string" }, force: { type: "boolean", default: false }, parallel: { type: "boolean", default: false } } });
    if (!configFile || !["--run", "--rollback"].includes(action) || (action === "--rollback" && rest.length) ||
        (values.version !== undefined && !/^\d+\.\d+\.\d+$/.test(values.version))) throw new Error("invalid arguments");
    options = values;
  } catch {
    console.error("Usage: node codex-qualifier.mjs /absolute/qualifier.json --run [--version X.Y.Z] [--force] [--parallel] | --rollback"); process.exitCode = 2;
  }
  if (options) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
      const result = action === "--rollback" ? runRollback(cfg) : await runQualifier(cfg, options);
      console.log(JSON.stringify(result, null, 2));
      if (result?.state === "failed") process.exitCode = 1;
    } catch (e) { console.error(e.stack); process.exitCode = 1; }
  }
}
