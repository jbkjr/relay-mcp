// relay qualify-codex: one run of the Codex qualifier (CODEX_QUALIFIER), as its LaunchAgent runs it.
// It calls the qualifier's own runQualifier with nothing but relay's package root (a built git
// checkout or an npm install; the pin names its build identity, src/core/build-identity.ts), relay's pin store
// and the person's --version/--force: every check of a scheduled run stays in force (npm's SRI,
// Apple's signature and OpenAI's Team ID, the exact version, the source tag, the full stage-2
// qualification judged against the current schema, the Aqua login session, the lock and the
// promotion journal). Afterwards it asks relay itself (freezeCodexConfig) which Codex it would run,
// so what it prints is what relay will do, not what the qualifier says it did.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CODEX_QUALIFIER, CODEX_SHIPPED_PIN, codexPinInfo, describeCodexPin, freezeCodexConfig } from "../backends/codex-pin.js";
import type { ShippedPin } from "../core/shipped-pin.js";
import { buildIdentity, describeBuild, isBuildRecord } from "../core/build-identity.js";
import { loadConfig, relayCodexPinStore, type RelayConfig } from "../core/config.js";
import { launchedTree } from "../core/presence.js";
import { relayPackageRoot } from "../core/protected-config.js";

export const QUALIFY_CODEX_USAGE = "usage: relay qualify-codex [--version X.Y.Z] [--force] | --shipped";
const QUALIFY_CODEX_HELP = [
  "Qualifies a Codex release for relay and makes it the pin relay runs Codex from: downloads it from npm",
  "and its source from GitHub, verifies both, and runs relay's model-free stage-2 qualification against it",
  "(about an hour and a half; needs this Mac's desktop login session and the network).",
  "  --version X.Y.Z   qualify this release (default: npm's latest)",
  "  --force           retry a release whose qualification already failed with this relay build",
  "  --shipped         instead, put this release's shipped pin in place (the maintainer's qualification of the",
  "                    Codex it names; a download of a few minutes), replacing a pin qualified here",
].join("\n");

type QualifierResult = { state?: string; [key: string]: unknown };
export interface QualifierModule {
  runQualifier(input: { repo: string; store: string }, options: { version?: string; force: boolean }): Promise<QualifierResult>;
}
export interface ShippedPinModule {
  installShippedPin(input: { store: string; packageRoot: string; replaceLocal: boolean }): Promise<QualifierResult>;
}

/** What the command reaches outside itself. Tests pass their own; the CLI passes none. */
export interface QualifyCodexDeps {
  /** Relay's own package root (a built checkout or an npm install): the build the qualifier runs relay's stage-2 path from. */
  root: string;
  config: () => RelayConfig;
  launched: () => string | null;
  load: (file: string) => Promise<QualifierModule>;
  loadShipped: (file: string) => Promise<ShippedPinModule>;
  out: (line: string) => void;
}

/** The command's own reach: relay's package, the person's config and the qualifier file there. */
export const qualifyCodexDefaults = (): QualifyCodexDeps => ({
  root: relayPackageRoot(),
  config: () => loadConfig(),
  launched: () => launchedTree(),
  load: async (file) => (await import(pathToFileURL(file).href)) as QualifierModule,
  loadShipped: async (file) => (await import(pathToFileURL(file).href)) as ShippedPinModule,
  out: (line) => console.log(line),
});

const firstLine = (value: unknown) => String(value ?? "").split("\n")[0];

/** Which Codex relay runs now, by relay's own selection. Returns whether that is a qualified pin. */
export function relayVerdict(cfg: RelayConfig, out: (line: string) => void): boolean {
  try {
    const frozen = freezeCodexConfig(cfg);
    if (!frozen.targets.codex.pinned) {
      out(`relay runs Codex unpinned: targets.codex.pinned is false in your config, so relay runs ${frozen.targets.codex.bin} and does not use this pin store.`);
      return false;
    }
    const info = codexPinInfo(frozen);
    out(`relay will run Codex from the qualified pin ${frozen.targets.codex.bin}${info ? ` (${describeCodexPin(info)})` : ""}.`);
    return true;
  } catch (err) {
    out((err as Error).message);
    return false;
  }
}

function describePin(store: string, target: string, out: (line: string) => void): void {
  const m = JSON.parse(fs.readFileSync(path.join(store, target, "manifest.json"), "utf8"));
  out("What was checked:");
  out(`  - npm package @openai/codex@${m.version}-darwin-arm64: its bytes match npm's sha512 integrity (${String(m.npmIntegrity).slice(0, 23)}…)`);
  out(`  - code signature: valid and Apple-issued, Team ID ${m.codesign?.teamId} (${m.codesign?.identity})`);
  out(`  - the binary reports exactly codex-cli ${m.version}; its sha256 is ${m.binarySha256}`);
  out(`  - Codex's source: tag rust-v${m.version} at commit ${m.sourceCommit}`);
  out(`  - relay's stage-2 qualification (model-free, scratch homes, no login): every item and part of ${m.verdictSchema} passed (verdict ${m.verdictPath})`);
  // Pins from before build identities name the relay commit they ran from instead.
  const ran = isBuildRecord(m.relayBuild) ? `${describeBuild(m.relayBuild)} (sha256 ${m.relayBuild.sha256})` : `relay commit ${m.relayCommit}`;
  out(`  - run from ${ran}, Node ${m.nodeVersion}`);
  out(`Pin: ${path.join(store, "current")} -> ${target}`);
}

/** Returns the exit code. Refuses, without starting the qualifier, wherever a scheduled run would not be the person's own. */
export async function qualifyCodex(args: string[], supplied: Partial<QualifyCodexDeps> = {}): Promise<number> {
  const deps = { ...qualifyCodexDefaults(), ...supplied };
  const { out } = deps;
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    out(`${QUALIFY_CODEX_USAGE}\n${QUALIFY_CODEX_HELP}`);
    return 0;
  }
  let values: { version?: string; force: boolean; shipped: boolean };
  try {
    ({ values } = parseArgs({ args, strict: true, allowPositionals: false, options: { version: { type: "string" }, force: { type: "boolean", default: false }, shipped: { type: "boolean", default: false } } }) as { values: { version?: string; force: boolean; shipped: boolean } });
    if (values.version !== undefined && !/^\d+\.\d+\.\d+$/.test(values.version)) throw new Error("--version must be a stable X.Y.Z");
    if (values.shipped && (values.version !== undefined || values.force)) throw new Error("--shipped takes no --version or --force: it is this release's pin");
  } catch (err) {
    out(`relay qualify-codex: ${firstLine((err as Error).message)}\n${QUALIFY_CODEX_USAGE}`);
    return 2;
  }
  const launched = deps.launched();
  if (launched) {
    out(`relay qualify-codex refused: it runs only from your own terminal, not in a launched agent's environment or process tree (${launched}). Nothing ran.`);
    return 1;
  }
  const root = deps.root;
  const runner = path.join(root, CODEX_QUALIFIER);
  if (!fs.existsSync(runner) || !fs.existsSync(path.join(root, "dist", "backends", "codex.js"))) {
    out(`relay qualify-codex refused: the qualifier runs from a built relay (an npm install, or a git checkout after npm run build), and ${root} is not one (no ${CODEX_QUALIFIER} or dist/). Nothing ran.`);
    return 1;
  }
  // The pin names the build that ran by its content (src/core/build-identity.ts), so a checkout with
  // local changes is qualified as what it is. An incomplete build is refused before anything runs.
  let build;
  try { build = buildIdentity(root); }
  catch (err) { out(`relay qualify-codex refused: ${firstLine((err as Error).message)}. Nothing ran.`); return 1; }
  if (values.shipped) {
    const placed = await placeShippedPin(deps, { replaceLocal: true });
    return relayVerdict(deps.config(), out) && (placed === "installed" || placed === "unchanged") ? 0 : 1;
  }
  const cfg = deps.config();
  const store = relayCodexPinStore(cfg);
  out(`Qualifying ${values.version ? `Codex ${values.version}` : "npm's latest Codex"} for ${describeBuild(build)} at ${root}, into the pin store ${store}.`);
  out("It downloads Codex from npm and its source from GitHub, verifies them, and runs relay's model-free stage-2 qualification against it: about an hour and a half. It needs this Mac's desktop (Aqua) login session and the network. Your own Codex, its login and ~/.codex are not used.");
  if (values.force) out("--force: a failure recorded for these exact inputs is retried; every check still runs.");
  const qualifier = await deps.load(runner);
  const previousUmask = process.umask(0o077);
  let result: QualifierResult;
  try { result = await qualifier.runQualifier({ repo: root, store }, { version: values.version, force: values.force }); }
  catch (err) { result = { state: "error", error: (err as Error)?.message ?? String(err) }; }
  finally { process.umask(previousUmask); }
  out("");
  let ok = false;
  switch (result?.state) {
    case "promoted":
      out(`Qualified Codex ${result.version} and made it relay's pin.`);
      try { describePin(store, String(result.target), out); ok = true; }
      catch (err) { out(`relay could not read the new pin's manifest in ${path.join(store, String(result.target))}: ${firstLine((err as Error).message)}`); }
      break;
    case "error":
      out(`The qualifier stopped with an error before it could record a result: ${firstLine(result.error)}`);
      break;
    case "unchanged":
      out(`Codex ${result.version} is already relay's qualified pin (${result.target}). Nothing changed.`);
      ok = true;
      break;
    case "skipped":
      out(`Not run: Codex ${result.version} (binary sha256 ${result.binarySha256}) already failed qualification with ${isBuildRecord(result.relayBuild) ? describeBuild(result.relayBuild) : "this relay build"} on ${result.failedAt}. Verdict: ${result.verdictPath}. Run again with --force to retry it.`);
      break;
    case "busy":
      out(`Not run: another qualifier run holds the lock on ${store}. Wait for it to finish, then run this again.`);
      break;
    case "failed":
      out(`Qualification of Codex ${result.version} failed: ${firstLine(result.error)}`);
      out(`Evidence: ${result.runDir} (runner.log, stage2.log, failure.json).`);
      break;
    default:
      out(`The qualifier returned no result relay knows (${JSON.stringify(result?.state)}).`);
  }
  // Relay's own answer, whatever the qualifier reported.
  const pinned = relayVerdict(deps.config(), out);
  return ok && pinned ? 0 : 1;
}

/**
 * Puts this release's shipped Codex pin in place (scripts/codex-qualify/codex-shipped-pin.mjs
 * installShippedPin), for `relay qualify-codex --shipped` (replaceLocal) and `relay install codex
 * --write` (which never replaces a pin qualified on this Mac). Says what happened and returns it:
 * "installed" and "unchanged" mean the shipped pin is now current. The caller asks relay itself what it will run.
 */
export type ShippedPinOutcome = "installed" | "unchanged" | "local-kept" | "none" | "busy" | "failed";
export async function placeShippedPin(deps: QualifyCodexDeps, { replaceLocal }: { replaceLocal: boolean }): Promise<ShippedPinOutcome> {
  const { out } = deps;
  const store = relayCodexPinStore(deps.config());
  const previousUmask = process.umask(0o077);
  let result: QualifierResult;
  // Loading the module is part of the pin step: its failure is the pin's, not the host install's (r_96c6b786 C2).
  try { result = await (await deps.loadShipped(path.join(deps.root, CODEX_SHIPPED_PIN))).installShippedPin({ store, packageRoot: deps.root, replaceLocal }); }
  catch (err) { result = { state: "failed", error: (err as Error)?.message ?? String(err) }; }
  finally { process.umask(previousUmask); }
  const shipped = result.shipped as ShippedPin | undefined;
  const what = shipped ? `Codex ${shipped.codex.version} (npm ${shipped.codex.npmIntegrity.slice(0, 23)}…), qualified by the maintainer with ${describeBuild(shipped.relay)}` : "";
  switch (result.state) {
    case "installed":
      out(`Put this release's shipped Codex pin in place: ${what}. Relay downloaded it and checked npm's integrity, Apple's signature, OpenAI's Team ID and the exact version; the stage-2 qualification is the maintainer's (${path.join(store, "current")} -> ${result.target}).`);
      return "installed";
    case "unchanged":
      out(`This release's shipped Codex pin is already in place: ${what}.`);
      return "unchanged";
    case "local-kept":
      out(`Your own qualified Codex pin (Codex ${result.version}, ${result.target}) stays in force; this release ships a pin for ${what}. \`relay qualify-codex --shipped\` switches to it.`);
      return "local-kept";
    case "none":
      out("This relay ships no Codex pin (a git checkout never does): run `relay qualify-codex` once from your own terminal to qualify one here (about an hour and a half).");
      return "none";
    case "busy":
      out(`Not done: a qualifier run holds the lock on ${store}. Wait for it to finish, then run this again.`);
      return "busy";
    default:
      out(`Putting the shipped Codex pin in place failed: ${firstLine(result.error)}`);
      return "failed";
  }
}
