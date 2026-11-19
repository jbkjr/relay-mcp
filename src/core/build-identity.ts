// Relay's build identity: what a Codex qualification says it qualified. A pin used to record the git
// commit of the checkout it ran from, which an npm install does not have. It now records relay's
// version and one sha256 over the installed build that a qualification exercises (QUALIFIED_BUILD):
// relay's compiled code, the qualifier, and the files its stage-2 run loads. The same bytes give the
// same identity in a git checkout and in an npm install, hashed the same way every time
// (BUILD_SCHEME): every regular file under those paths, sorted by its relative path, each as
// `<path>\0<sha256 of its bytes>\n` after the line `relay-build-v2\n`. Names npm never packs
// (dotfiles, node_modules, *.orig and the like) are left out the same way on both sides; a symlink or
// a special file is refused rather than followed. package.json is not hashed: its version is the
// identity's own field, and npm may rewrite the rest of the file when it packs.
//
// relay-build-v2 adds npm-shrinkwrap.json, the lock npm installs relay's dependencies from (exact
// versions and sha512 integrities, which npm checks on install), so that an identity, and a pin that
// names one, also fixes relay's dependency tree. relay-build-v1, written by the builds before it, hashed the same paths
// without it. A v1 identity is still read as a record of what a local pin ran with
// (isBuildRecord), but it never equals a v2 one, so it cannot stand for a build of today's relay.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUILD_SCHEME = "relay-build-v2";
/** Schemes an earlier relay wrote into local pins and failure records; read as records, never matched to a build. */
export const LEGACY_BUILD_SCHEMES: readonly string[] = Object.freeze(["relay-build-v1"]);

/**
 * The stage-2 test files a qualification runs (scripts/codex-qualify/stage2-escalation-cases.mjs
 * names them; codex-stage2.mjs runs them from relay's tree) and the modules they import. A test
 * holds this list to that file and to their imports, so a new one cannot be missed.
 */
export const STAGE2_TEST_FILES = Object.freeze([
  "codex-permissions", "mediated-network", "mediated-proxy", "never-policy", "never-tools", "proxy",
  "restart-overlay", "restart-overlay-live", "restart-overlay-profile", "stable-surfaces",
  "stage2-escalation", "stage2-escalation-live", "stage2-escalation-qualification", "stage2-executor",
  "stage2-grant", "stage2-native-live", "stage2-network-decisions", "stage2-probe", "stage2-standing-live",
  "wp4-adapters", "wp4-interlock",
].map((name) => `test/${name}.test.ts`));

/** What a qualification exercises, relative to relay's package root. A trailing slash is a directory, taken whole. */
export const QUALIFIED_BUILD = Object.freeze([
  "dist/",
  // The dependency lock (relay-build-v2): npm installs relay's dependencies from it, by integrity.
  "npm-shrinkwrap.json",
  "scripts/codex-qualify/",
  ...STAGE2_TEST_FILES,
  ...["helpers", "host-env", "keychain-decoy", "live-scope", "native-temp-alias", "process-home", "temp-root"].map((name) => `test/${name}.ts`),
  "test/fixtures/",
  "test/stubs/",
  // The red-team runner's oracles, which test/stage2-escalation-qualification.test.ts imports.
  "experiments/stage2-redteam/lib/oracles.mjs",
  "experiments/stage2-redteam/lib/report.mjs",
]);

export interface BuildIdentity { scheme: typeof BUILD_SCHEME; version: string; sha256: string }
/** A build identity as an earlier relay may have recorded it: this scheme or a legacy one. */
export interface BuildRecord { scheme: string; version: string; sha256: string }

/** What npm never puts in a package, whatever `files` says; left out of the hash on both sides alike. */
const unpacked = (name: string) => name.startsWith(".") || name.endsWith(".orig") ||
  ["node_modules", "CVS", "npm-debug.log", "config.gypi", "package-lock.json"].includes(name);

const sha256 = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");

/** Every file of the qualified build under `root`, as sorted relative paths with "/" separators. Throws on a missing entry, a symlink or a special file. */
export function buildFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    const st = fs.lstatSync(path.join(root, rel));
    if (st.isSymbolicLink()) throw new Error(`relay's build holds a symlink, which its identity does not follow: ${rel}`);
    if (st.isFile()) { out.push(rel); return; }
    if (!st.isDirectory()) throw new Error(`relay's build holds a special file: ${rel}`);
    for (const name of fs.readdirSync(path.join(root, rel))) if (!unpacked(name)) visit(`${rel}/${name}`);
  };
  for (const entry of QUALIFIED_BUILD) {
    const rel = entry.replace(/\/$/, "");
    try { visit(rel); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`relay's build at ${root} is incomplete: ${rel} is missing (an npm install ships it; a git checkout must be built with npm run build)`);
      throw err;
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The version in relay's package.json under `root`. */
export function packageVersion(root: string): string {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`relay's package.json under ${root} has no valid version`);
  return version;
}

/** Relay's build identity under `root` (relay's package root: a git checkout or an npm install). */
export function buildIdentity(root: string): BuildIdentity {
  const hash = crypto.createHash("sha256").update(`${BUILD_SCHEME}\n`);
  for (const rel of buildFiles(root)) hash.update(`${rel}\0${sha256(fs.readFileSync(path.join(root, rel)))}\n`);
  return { scheme: BUILD_SCHEME, version: packageVersion(root), sha256: hash.digest("hex") };
}

const wellFormed = (v: BuildRecord | null): boolean =>
  !!v && typeof v === "object" && typeof v.scheme === "string" && typeof v.version === "string" &&
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v.version) && typeof v.sha256 === "string" && /^[a-f0-9]{64}$/.test(v.sha256);

/** Whether `value` is a well-formed build identity of the current scheme, the only kind a build can be matched to. */
export function isBuildIdentity(value: unknown): value is BuildIdentity {
  return wellFormed(value as BuildRecord) && (value as BuildRecord).scheme === BUILD_SCHEME;
}

/** Whether `value` is a well-formed record of a build: the current scheme or a legacy one (LEGACY_BUILD_SCHEMES). */
export function isBuildRecord(value: unknown): value is BuildRecord {
  return wellFormed(value as BuildRecord) && (isBuildIdentity(value) || LEGACY_BUILD_SCHEMES.includes((value as BuildRecord).scheme));
}

/** Whether two identities name the same build. A legacy record never equals a current one: the schemes hash different files. */
export const sameBuild = (a: BuildRecord, b: BuildRecord): boolean =>
  a.scheme === b.scheme && a.version === b.version && a.sha256 === b.sha256;

/** One line for people: "relay 1.2.0, build 0123456789abcdef", naming the scheme when it is a legacy one. */
export const describeBuild = (b: BuildRecord): string =>
  `relay ${b.version}, build ${b.sha256.slice(0, 16)}${b.scheme === BUILD_SCHEME ? "" : ` (${b.scheme})`}`;

type LockEntry = { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

/**
 * relay's lock (npm-shrinkwrap.json) under `root`, checked to be the lock of this package and version.
 * Throws when it is missing, or names another package or version than package.json.
 */
function readLock(root: string): { packages: Record<string, LockEntry> } {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "npm-shrinkwrap.json"), "utf8"));
  if (lock?.name !== pkg.name || lock?.version !== pkg.version || lock?.packages?.[""]?.version !== pkg.version) {
    throw new Error(`relay's npm-shrinkwrap.json under ${root} is not the lock of ${pkg.name} ${pkg.version}: regenerate it with npm install`);
  }
  return lock;
}

/** The lock's entry a package at lock key `from` gets for `name`: the nearest node_modules/<name> at or above it, as npm lays the tree out. */
function lockResolve(packages: Record<string, LockEntry>, from: string, name: string): string | null {
  for (let at = from; ; at = at.includes("/node_modules/") ? at.slice(0, at.lastIndexOf("/node_modules/")) : "") {
    const key = `${at ? `${at}/` : ""}node_modules/${name}`;
    if (packages[key]) return key;
    if (!at) return null;
  }
}

/**
 * Whether the dependencies relay would load from `root` are the versions its lock names: null when
 * they are, else what differs. The build identity covers the lock (npm-shrinkwrap.json), not
 * node_modules, so this is what ties the dependencies that run to it. It walks relay's runtime
 * dependency graph from package.json's dependencies: each dependency is found on disk as Node
 * finds it (from the real directory of the package that requires it, upward), and in the lock as
 * npm lays it out (the nearest entry at or above the requiring one), and the two versions must
 * agree, transitive dependencies included. So a hoisted project install, or a tree of links to the
 * real packages, is judged by what Node would load. Dev-only entries are never reached; an optional
 * or peer dependency that is absent is fine. package.json also names each direct dependency at
 * exactly its locked version, since npm reads a dependency's shrinkwrap only for a registry install
 * of a package that ships one.
 */
export function dependencyDrift(root: string): string | null {
  let packages: Record<string, LockEntry>;
  try { packages = readLock(root).packages; } catch (err) { return (err as Error).message; }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const off: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ key: string; dir: string; deps: Array<[string, "required" | "optional" | "peer"]> }> = [{
    key: "", dir: fs.realpathSync(root),
    deps: [...Object.keys(pkg.dependencies ?? {}).map((n) => [n, "required"] as [string, "required"]), ...Object.keys(pkg.optionalDependencies ?? {}).map((n) => [n, "optional"] as [string, "optional"])],
  }];
  while (queue.length) {
    const { key, dir, deps } = queue.shift()!;
    for (const [name, kind] of deps) {
      const lockKey = lockResolve(packages, key, name);
      const found = dependencyDir(dir, name);
      const label = (lockKey ?? `node_modules/${name}`).slice("node_modules/".length);
      if (!found) {
        if (kind === "required") off.push(`${label} is not installed, and the lock names ${lockKey ? packages[lockKey].version : "no version"}`);
        continue;
      }
      if (!lockKey) { off.push(`${label} is installed at ${found}, and the lock has no entry for it`); continue; }
      let installed: string | undefined;
      try { installed = JSON.parse(fs.readFileSync(path.join(found, "package.json"), "utf8"))?.version; } catch { installed = undefined; }
      if (installed !== packages[lockKey].version) { off.push(`${label} is ${installed ?? "unreadable"} at ${found}, and the lock names ${packages[lockKey].version}`); continue; }
      if (seen.has(`${lockKey}\0${found}`)) continue;
      seen.add(`${lockKey}\0${found}`);
      const e = packages[lockKey];
      queue.push({ key: lockKey, dir: found, deps: [
        ...Object.keys(e.dependencies ?? {}).map((n) => [n, "required"] as [string, "required"]),
        ...Object.keys(e.optionalDependencies ?? {}).map((n) => [n, "optional"] as [string, "optional"]),
        ...Object.keys(e.peerDependencies ?? {}).map((n) => [n, "peer"] as [string, "peer"]),
      ] });
    }
  }
  return off.length ? `relay's dependencies are not the ones its lock (npm-shrinkwrap.json) names: ${off.join("; ")}` : null;
}

/**
 * Where node would find `name` from relay's package root: its own node_modules, or a parent's when
 * npm hoisted it (a project install). Null when it is not installed.
 */
function dependencyDir(root: string, name: string): string | null {
  for (let dir = fs.realpathSync(root); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Copies relay's qualified build from `root` to `dest` (which must not exist), with package.json
 * and a node_modules of links to the dependencies `root` resolves, and returns the copy's identity,
 * which must equal the source's. Node strips TypeScript types only outside node_modules, so a
 * qualification of an npm install runs its stage-2 tests from such a copy; a checkout's runs from
 * one too, so that both run the same way and an edit to the checkout cannot reach a running qualification.
 */
export function copyBuild(root: string, dest: string): BuildIdentity {
  const source = buildIdentity(root);
  fs.mkdirSync(dest, { mode: 0o700 });
  for (const rel of [...buildFiles(root), "package.json"]) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(root, rel), to, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, fs.statSync(path.join(root, rel)).mode & 0o111 ? 0o755 : 0o644);
  }
  const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).dependencies ?? {});
  for (const name of deps) if (!dependencyDir(root, name)) throw new Error(`relay's dependency ${name} is not installed beside ${root}`);
  // The identity fixes the lock, not node_modules: a qualification runs only with the dependency
  // versions the lock names.
  const drift = dependencyDrift(root);
  if (drift) throw new Error(`${drift}: run npm ci`);
  for (const name of deps) {
    const found = dependencyDir(root, name)!;
    const link = path.join(dest, "node_modules", name);
    fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
    fs.symlinkSync(found, link);
  }
  const copy = buildIdentity(dest);
  if (!sameBuild(copy, source)) throw new Error(`the copy of relay's build at ${dest} does not match its source ${root}`);
  return copy;
}
