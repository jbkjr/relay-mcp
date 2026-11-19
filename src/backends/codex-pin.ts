// Selection is per turn, never cached by the mutable `current` name. Published trees are sealed
// by the qualifier and the entire store is write-denied to every launched agent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { canonical, relayCodexHome, relayCodexPinStore, type RelayConfig } from "../core/config.js";
import { buildIdentity, dependencyDrift, describeBuild, sameBuild, type BuildIdentity } from "../core/build-identity.js";
import { relayPackageRoot } from "../core/protected-config.js";
import { readShippedPin, type ShippedPin } from "../core/shipped-pin.js";

const frozen = new WeakSet<RelayConfig>();
const versions = new WeakMap<RelayConfig, readonly number[]>();
const pins = new WeakMap<RelayConfig, CodexPinInfo>();
/** Version from the validated, selected manifest; never follows `current` again. */
export function codexPinVersion(cfg: RelayConfig): readonly number[] | undefined { return versions.get(cfg); }
export const CODEX_QUALIFIER = "scripts/codex-qualify/codex-qualifier.mjs";
/** The module that puts a release's shipped pin in place (`relay install codex`, `relay qualify-codex --shipped`). */
export const CODEX_SHIPPED_PIN = "scripts/codex-qualify/codex-shipped-pin.mjs";

/**
 * Which pin a frozen config runs, for doctor and qualify-codex. `local`: qualified on this Mac
 * (versions/), with its own stage-2 evidence. `shipped`: this release's shipped pin (shipped/),
 * qualified by the maintainer and bound to this relay build.
 */
export type CodexPinInfo =
  | { kind: "local"; version: string; target: string; qualifiedAt: string; verdictSchema?: string }
  | { kind: "shipped"; version: string; target: string; npmIntegrity: string; shipped: ShippedPin };
export function codexPinInfo(cfg: RelayConfig): CodexPinInfo | undefined { return pins.get(cfg); }
/** One line for people: which pin is in force, and for what. */
export function describeCodexPin(info: CodexPinInfo): string {
  return info.kind === "local"
    ? `local: Codex ${info.version}, qualified on this Mac at ${info.qualifiedAt} (${info.verdictSchema ?? "stage2-v1"})`
    : `shipped: Codex ${info.version} (npm ${info.npmIntegrity.slice(0, 23)}…), this release's pin, qualified by the maintainer with ${describeBuild(info.shipped.relay)}`;
}

let packageRootOverride: string | null = null;
/** Code-only seam: the relay package whose shipped pin and build a test's shipped tree is checked against. Production always uses relay's own. */
export function setRelayPackageRootForTests(root: string | null): void { packageRootOverride = root; }
/** Relay's own package (or a test's, through the seam above): where its shipped pin and build are read. */
export const shippedPinPackageRoot = (): string => packageRootOverride ?? relayPackageRoot();
const packageRoot = shippedPinPackageRoot;

/**
 * The build this process loaded (review r_96c6b786 X1). A worker or server keeps the modules it
 * loaded at start; after relay is upgraded in place, the disk holds the next release's build and
 * its shipped pin, which match each other but not the code still running here. Relay's own is
 * taken when this module loads, which is at process start (the worker and the servers import it
 * through backends/run.ts and backends/codex.ts). A test package's is taken on first use.
 */
const loadedBuilds = new Map<string, BuildIdentity | Error>();
function loadedBuild(root: string): BuildIdentity | Error {
  if (!loadedBuilds.has(root)) {
    try { loadedBuilds.set(root, buildIdentity(root)); }
    catch (err) { loadedBuilds.set(root, err as Error); }
  }
  return loadedBuilds.get(root)!;
}
/**
 * Whether the dependencies this process loaded were the locked ones (dependencyDrift as it stood
 * when the build was first identified), like loadedBuild: a repair on disk afterwards does not
 * change the modules already loaded. Taken with the build, at process start for relay's own.
 */
const loadedDrift = new Map<string, string | null>();
function loadedDependencyDrift(root: string): string | null {
  if (!loadedDrift.has(root)) {
    try { loadedDrift.set(root, dependencyDrift(root)); }
    catch (err) { loadedDrift.set(root, (err as Error).message); }
  }
  return loadedDrift.get(root)!;
}
loadedBuild(relayPackageRoot());
loadedDependencyDrift(relayPackageRoot());

const exactKeys = (value: unknown, keys: string[]) =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/**
 * A shipped/ tree is run only for the release that ships its pin: the package relay runs from must
 * ship a pin (codex-pin.json) naming exactly this tree's Codex (version and npm integrity, which
 * relay verified the download against), and that pin's relay build must be the build running now.
 */
function checkShippedTree(m: Record<string, any>, version: string): ShippedPin {
  if (!exactKeys(m, ["version", "binarySha256", "npmIntegrity", "codesign", "installedAt"]) || m.version !== version ||
      !/^[a-f0-9]{64}$/.test(m.binarySha256 ?? "") || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(m.npmIntegrity ?? "") ||
      m.codesign?.teamId !== "2DC432GLL2" || typeof m.codesign.identity !== "string" || !m.codesign.identity ||
      typeof m.installedAt !== "string" || !Number.isFinite(Date.parse(m.installedAt))) throw new Error("invalid shipped pin tree manifest");
  const root = packageRoot();
  const shipped = readShippedPin(root);
  if (!shipped) throw new Error("current is a release's shipped pin, and the relay running now ships none");
  if (shipped.codex.version !== m.version || shipped.codex.npmIntegrity !== m.npmIntegrity) {
    throw new Error(`current is the shipped pin for Codex ${m.version} (${m.npmIntegrity.slice(0, 23)}…), and this release ships Codex ${shipped.codex.version} (${shipped.codex.npmIntegrity.slice(0, 23)}…)`);
  }
  const build = buildIdentity(root);
  if (!sameBuild(build, shipped.relay)) throw new Error(`this release's shipped pin was qualified with ${describeBuild(shipped.relay)}, and the relay running now is ${describeBuild(build)}`);
  // The pin's identity covers relay's dependency lock; the dependencies that run must be the locked ones.
  // At start (what this process loaded) and now (what the disk holds).
  const atStart = loadedDependencyDrift(root);
  if (atStart) throw new Error(`when this process started, ${atStart}, so this release's shipped pin does not cover the code running here. Reinstall relay (npm install -g @jbkjr/relay@${build.version}) and restart the session, or qualify a Codex here with relay qualify-codex`);
  const drift = dependencyDrift(root);
  if (drift) throw new Error(`${drift}, so this release's shipped pin does not cover them. Reinstall relay (npm install -g @jbkjr/relay@${build.version}), or qualify a Codex here with relay qualify-codex`);
  // The pin and the build on disk match; the code this process runs must be that build too.
  const loaded = loadedBuild(root);
  if (loaded instanceof Error) throw new Error(`relay could not identify the build this process started from (${loaded.message}), so it cannot match a shipped pin to it`);
  if (!sameBuild(loaded, build)) throw new Error(`relay was changed on disk after this process started: it runs ${describeBuild(loaded)}, and the disk now holds ${describeBuild(build)}, whose shipped pin does not cover the code running here. Restart the session (its relay server and workers)`);
  return shipped;
}

export function freezeCodexConfig(cfg: RelayConfig): RelayConfig {
  if (frozen.has(cfg)) return cfg;
  const store = relayCodexPinStore(cfg);
  // Missing stores and older saved configurations fail closed too. Only an explicit opt-out
  // selects targets.codex.bin; filesystem state must never silently select interactive Codex.
  const pinned = cfg.targets.codex.pinned !== false;
  let bin = cfg.targets.codex.bin;
  let version: readonly number[] | undefined;
  let info: CodexPinInfo | undefined;
  if (pinned) {
    try {
      const current = path.join(store, "current");
      if (!fs.lstatSync(current).isSymbolicLink()) throw new Error("current must be a symlink");
      const target = fs.readlinkSync(current);
      const match = /^(versions|shipped)\/(\d+\.\d+\.\d+)-([a-f0-9]{12})$/.exec(target);
      if (!match) throw new Error("current must name a relative versions/<version>-<sha12> or shipped/<version>-<sha12> tree");
      const dir = path.join(fs.realpathSync(store), target);
      if (fs.realpathSync(dir) !== dir || (fs.statSync(dir).mode & 0o222)) throw new Error("pin tree is not immutable (symlink or unsealed directory)");
      const manifestPath = path.join(dir, "manifest.json");
      const manifestStat = fs.lstatSync(manifestPath);
      if (!manifestStat.isFile() || (manifestStat.mode & 0o222)) throw new Error("invalid or unsealed pin manifest file");
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (match[1] === "shipped") {
        const shipped = checkShippedTree(m, match[2]);
        if (m.binarySha256.slice(0, 12) !== match[3]) throw new Error("invalid shipped pin tree manifest");
        info = { kind: "shipped", version: m.version, target, npmIntegrity: m.npmIntegrity, shipped };
      } else {
        if (m?.version !== match[2] || !/^[a-f0-9]{64}$/.test(m.binarySha256 ?? "") ||
            m.binarySha256.slice(0, 12) !== match[3] || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(m.npmIntegrity ?? "") ||
            m.codesign?.teamId !== "2DC432GLL2" || typeof m.codesign.identity !== "string" || !m.codesign.identity ||
            typeof m.qualifiedAt !== "string" || !Number.isFinite(Date.parse(m.qualifiedAt)) ||
            typeof m.verdictPath !== "string" || !path.isAbsolute(m.verdictPath) || !/^[a-f0-9]{40}$/.test(m.sourceCommit ?? "") ||
            Object.hasOwn(m, "installedAt")) throw new Error("invalid pin manifest");
        info = { kind: "local", version: m.version, target, qualifiedAt: m.qualifiedAt, verdictSchema: m.verdictSchema };
      }
      bin = path.join(dir, "bin", "codex");
      if (fs.realpathSync(bin) !== bin || (fs.statSync(path.dirname(bin)).mode & 0o222) || !fs.statSync(bin).isFile() || (fs.statSync(bin).mode & 0o222)) throw new Error("pin binary is not an immutable regular file");
      fs.accessSync(bin, fs.constants.X_OK);
      if (crypto.createHash("sha256").update(fs.readFileSync(bin)).digest("hex") !== m.binarySha256) throw new Error("pin binary digest mismatch");
      version = Object.freeze(m.version.split(".").map(Number));
    } catch (err) {
      let ships = false;
      try { ships = readShippedPin(packageRoot()) !== null; } catch { /* an invalid one: the qualify-codex route */ }
      const fix = ships
        ? "Run `relay install codex --write` (or `relay qualify-codex --shipped`) to put this release's shipped pin in place, a download of a few minutes, or `relay qualify-codex` to qualify a Codex here (about an hour and a half)"
        : `Run \`relay qualify-codex\` once from your own terminal (it runs the qualifier, ${CODEX_QUALIFIER}, and takes about an hour and a half)`;
      throw new Error(`relay refuses Codex: no valid qualified pin in ${store}: ${(err as Error).message}. ${fix}; relay will not fall back to interactive Codex.`);
    }
  }
  const resolved = { ...cfg, targets: { ...cfg.targets, codex: { ...cfg.targets.codex, bin, pinned } } };
  frozen.add(resolved);
  if (version) versions.set(resolved, version);
  if (info) pins.set(resolved, info);
  return resolved;
}

// Deliberately independent of ~/.codex and the inherited CODEX_HOME. Per-turn flags still set
// model, permissions, endpoints, MCP and feature policy and read them back from the app server.
export const RELAY_CODEX_CONFIG = '# Managed by relay. Changes are replaced on the next turn.\ncli_auth_credentials_store = "file"\n';
let fixtureConfig: ((home: string) => string | undefined) | null = null;
/** Code-only fixture seam for model-free qualification's synthetic endpoints/catalogs. No
 * environment variable or person-set config enables it; production always generates its own file. */
export function setCodexHomeConfigForTests(factory: typeof fixtureConfig): void { fixtureConfig = factory; }

/**
 * The file relay puts in a Codex home it made or adopted, so that it can tell later that the
 * directory is its own even after someone rewrote config.toml without relay's first line.
 */
export const RELAY_CODEX_HOME_MARKER = ".relay-codex-home";
const MARKER_TEXT = "This directory is relay's own Codex home (targets.codex.home). Relay rewrites its config.toml on every Codex turn.\n";
const MANAGED_LINE = RELAY_CODEX_CONFIG.split("\n")[0];

/**
 * Why relay must not use `targets.codex.home` as its Codex home, or null. Read-only: doctor reports
 * it, and prepareCodexHome refuses before its first write. A configured home is any absolute path,
 * so it could name the person's own Codex home or a directory of theirs: relay makes its home
 * private (0700) and replaces its config.toml, which would clobber theirs.
 *  - Never the person's interactive Codex home: ~/.codex, or the CODEX_HOME this process was given
 *    (compared by canonical path). A CODEX_HOME that already carries relay's evidence below is
 *    relay's own home handed down to a nested relay (a launched Codex agent's relay tools), not theirs.
 *  - An existing directory only with evidence that relay owns it: the marker file relay writes, or a
 *    config.toml that starts with relay's managed line (a home made by an earlier relay), or nothing
 *    in it at all. Anything else (a config.toml of someone else's, a login, sessions) is not relay's.
 */
export function codexHomeProblem(cfg: RelayConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = relayCodexHome(cfg);
  const at = canonical(home);
  const named = (p: string | undefined) => !!p && path.isAbsolute(p) && canonical(p) === at;
  const fix = "Set targets.codex.home in relay's config to a directory of relay's own (the default is ~/.local/share/relay-codex-home), then run `relay install codex --write`";
  if (named(path.join(os.homedir(), ".codex"))) return `targets.codex.home is ${home}, your own Codex's home (~/.codex), which relay never uses for its jobs: it would replace your config.toml there. ${fix}`;
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(home, { throwIfNoEntry: false }); }
  catch (err) { return `relay cannot examine its Codex home ${home} (${(err as Error).message})`; }
  if (st && !st.isDirectory()) return `relay's Codex home must be a directory, not ${st.isSymbolicLink() ? "a symlink" : "a file"}: ${home}`;
  if (fixtureConfig?.(home) !== undefined) return null;
  const evidence = st ? ownershipEvidence(home) : null;
  if (named(env.CODEX_HOME) && !evidence) return `targets.codex.home is ${home}, the Codex home your environment names (CODEX_HOME), which relay never uses for its jobs: it would replace the config.toml your own Codex reads there. ${fix}`;
  if (!st || evidence) return null;
  let entries: string[];
  try { entries = fs.readdirSync(home); }
  catch (err) { return `relay cannot read its Codex home ${home} (${(err as Error).message})`; }
  if (!entries.length) return null;
  const what = entries.includes("config.toml") ? "a config.toml relay did not write" : `files relay did not put there (${entries.slice(0, 3).join(", ")}${entries.length > 3 ? ", …" : ""})`;
  return `${home} (targets.codex.home) holds ${what}, so relay will not take it as its Codex home: it would make it private and replace its config.toml. Relay uses only a new or empty directory, or one it made. ${fix}, or move that directory's contents away`;
}

/** What shows that an existing directory is relay's Codex home: its marker file, or relay's managed config.toml. */
function ownershipEvidence(home: string): "marker" | "config" | null {
  try { if (fs.lstatSync(path.join(home, RELAY_CODEX_HOME_MARKER)).isFile()) return "marker"; } catch { /* absent */ }
  try {
    const config = path.join(home, "config.toml");
    if (fs.lstatSync(config).isFile() && fs.readFileSync(config, "utf8").split("\n")[0] === MANAGED_LINE) return "config";
  } catch { /* absent */ }
  return null;
}

export function prepareCodexHome(cfg: RelayConfig): string {
  const home = relayCodexHome(cfg);
  // Before the first write: never a home that is not relay's (codexHomeProblem).
  const problem = codexHomeProblem(cfg);
  if (problem) throw new Error(problem);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(home).isDirectory()) throw new Error(`relay's Codex home must be a directory, not a symlink: ${home}`);
  fs.chmodSync(home, 0o700);
  const marker = path.join(home, RELAY_CODEX_HOME_MARKER);
  try { fs.writeFileSync(marker, MARKER_TEXT, { flag: "wx", mode: 0o600 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  const config = path.join(home, "config.toml");
  const contents = fixtureConfig?.(home) ?? RELAY_CODEX_CONFIG;
  let same = false;
  try { same = fs.lstatSync(config).isFile() && fs.readFileSync(config, "utf8") === contents; } catch { /* create below */ }
  if (!same) {
    const tmp = path.join(home, `.config-${crypto.randomUUID()}.toml`);
    try { fs.writeFileSync(tmp, contents, { flag: "wx", mode: 0o600 }); fs.renameSync(tmp, config); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  // AGENTS.md belongs to the person. Never read, replace or unlink it.
  return home;
}

/**
 * The one-time sign-in of relay's Codex home: Codex's own `login`, run with that home, from the pin
 * store's current Codex when relay runs pinned (else the configured binary). The home must exist
 * first (Codex refuses a CODEX_HOME that does not), with relay's config.toml in it (prepareCodexHome),
 * so that the login goes to the file store relay's turns read; `relay install codex --write` makes it.
 */
export function codexLoginCommand(cfg: RelayConfig): string {
  const bin = cfg.targets.codex.pinned === false ? cfg.targets.codex.bin : path.join(relayCodexPinStore(cfg), "current", "bin", "codex");
  return `CODEX_HOME=${JSON.stringify(relayCodexHome(cfg))} ${JSON.stringify(bin)} login`;
}

/** Where relay's Codex home cannot open a browser (a remote or headless Mac), Codex signs in with a device code instead. */
export const DEVICE_AUTH_NOTE = "on a remote or headless Mac, add --device-auth, which needs device code sign-in switched on in ChatGPT's Security settings";

/** How to sign relay's Codex home in (`again`: a login is stored there that Codex no longer accepts). */
export function codexSignIn(cfg: RelayConfig, again = false): string {
  return `${again ? "Sign in again" : "Sign in once"} with ${codexLoginCommand(cfg)} (${DEVICE_AUTH_NOTE})`;
}

/**
 * Whether relay's Codex home holds a stored login: auth.json is there, as a regular file. Metadata
 * only, like codexHomeStatus: the file is never opened.
 */
export function codexLoginStored(home: string): boolean {
  try { return fs.lstatSync(path.join(home, "auth.json")).isFile(); } catch { return false; }
}

/**
 * Codex reports no account (account/read) though relay's Codex home holds a login: the stored login
 * is one Codex no longer accepts. Seen on 2026-11-18 with an access token that had expired and a
 * refresh token that had been revoked: Codex tries the refresh when its app server starts, and when
 * that fails it reports no account. (An expired token whose refresh still works recovers by itself.)
 */
export const STORED_LOGIN_REJECTED = "Codex no longer accepts it, most likely because it expired and Codex could not refresh it (its refresh token revoked, for one)";

/**
 * Metadata only: never open or parse the credential file. Symlinks are not private credentials.
 * `problem`: why relay will not use this home (codexHomeProblem); doctor reports it and changes nothing.
 */
export function codexHomeStatus(cfg: RelayConfig): { home: string; present: boolean; login: string; problem: string | null } {
  const home = relayCodexHome(cfg);
  let present = false, login = "missing";
  try { present = fs.lstatSync(home).isDirectory(); } catch { /* absent */ }
  try {
    const st = fs.lstatSync(path.join(home, "auth.json"));
    login = st.isFile() && (st.mode & 0o777) === 0o600 ? "present" : "unsafe permissions";
  } catch { /* absent */ }
  return { home, present, login, problem: codexHomeProblem(cfg) };
}
