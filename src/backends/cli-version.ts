// The version a target's CLI reports, read again whenever the executable a launch would run, or the
// environment it would run with, is not the one last read, and at least once a minute. The version
// gate (run.ts untested) and the long-home check on Claude's temp link (native-temp.ts) use it;
// checks given the same environment share one `--version` spawn. Claude Code updates itself in
// place: the `claude` path stays the same while its launcher link is repointed at a newer binary,
// and the link's version ceiling exists to catch exactly that. So a read is kept only for the
// executable it describes: the target, the absolute name a launch finds (a configured path resolved
// from relay's working directory, or a bare name found on the launch environment's PATH, as
// executables.ts does), the file that name leads to, and that file's device, inode, size, mode and
// change times. Any change to those, a repoint or a file replaced or rewritten, means a new read
// before the next check (review 2026-11-09, F8). So does any change to the environment the probe
// runs with, every name and value of it (Gemini's trust variable as the probe sets it), compared as
// a digest, never kept or logged as values: one unchanged launcher can run something else under
// another environment, a wrapper running a helper found later on PATH or a version manager choosing
// by a variable (review 2026-11-09, item I2). There is still one entry per target and launcher,
// replaced when its file or environment changes, not one per environment. A name that cannot be
// resolved has no version, never a previous one: a bare name not found drops every read kept for
// its target (review item I3), so that a read from before the failure is not served once it is found
// again. An unreadable version is not kept. A read during which the executable changed is not kept
// under either identity: relay reads once more, and refuses (no version) if it changes again.
//
// Two limits remain, by design; neither is solved here:
// - A wrapper whose own file and environment are unchanged (a script that runs another
//   installation, a version manager's shim) looks the same when what it runs changes on disk.
//   Only the minute catches that.
// - The executable can still change after the last check and before the launch runs it: nothing
//   here binds the file read to the process later started by name.
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findExecutable, spawnFound } from "../core/executables.js";
import { versionOf, type Target } from "../targets/index.js";

/** The longest a version read is reused for an executable and environment that have not changed (see above). */
export const VERSION_TTL_MS = 60_000;

/** One read per target and launcher name: replaced, not added to, when that name's file or the probe's environment changes. */
const versions = new Map<string, { identity: string; environment: string; version: number[]; at: number }>();
let now = (): number => Date.now();

/** Tests only: the clock entries are aged by, or null for the real one. Nothing in relay calls this. */
export function setVersionClockForTests(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

/**
 * The directory every version probe runs in: the root of the file system, which this user cannot
 * write (on macOS it is the sealed system volume), so it holds no project configuration and nothing
 * a job or the person's own tools could put there, and which needs nothing made first (a probe that
 * finds no CLI leaves the home folder untouched). Never relay's own working directory, which is
 * usually the person's repository.
 */
export const VERSION_PROBE_DIR = "/";

/**
 * Runs `bin --version` for a target's CLI, outside any sandbox, as every version check in relay
 * does (this gate, doctor, the installer, Codex's Daybreak check), in VERSION_PROBE_DIR. Some CLIs
 * read a project's configuration before they handle `--version`: Gemini CLI 0.64.0 reads
 * `.gemini/settings.json` and `.gemini/.env` from its working directory first (gemini.tsx:
 * `loadSettings` before `parseArguments`), and in a trusted folder that `.env` may set any
 * variable. Gemini is also told its folder is untrusted (GEMINI_CLI_TRUST_WORKSPACE=false, as for
 * its turns), so it loads neither wherever it runs.
 */
export function probeVersion(target: Target, bin: string, env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  // A path the config gives relative to where relay runs (doctor shows it so) still means that path.
  // By its absolute name, found on the PATH it is given (executables.ts spawnFound).
  return spawnFound(bin, ["--version"], {
    encoding: "utf8", timeout: 20_000, cwd: VERSION_PROBE_DIR, env: probeEnvironment(target, env),
  }, env.PATH ?? "");
}

/** The environment a version probe of `target` runs with: `env`, Gemini told its folder is untrusted (probeVersion). */
function probeEnvironment(target: Target, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return target === "gemini" ? { ...env, GEMINI_CLI_TRUST_WORKSPACE: "false" } : env;
}

/**
 * A digest of every name and value the probe of `target` runs with (probeEnvironment), sorted by
 * name, unset names left out as a spawn leaves them out. Equal for equal environments, whatever
 * their order; the values themselves are never kept.
 */
function environmentDigest(target: Target, env: NodeJS.ProcessEnv): string {
  const entries = Object.entries(probeEnvironment(target, env)).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/**
 * The name a launch with `env` runs `bin` by (stream.ts and acp.ts spawn `executable(bin,
 * env.PATH)`): a path resolved from relay's working directory, or a bare name as findExecutable
 * finds it on that PATH, relative entries skipped. With it, what identifies the file it leads to,
 * or null when that cannot be read (missing, a dangling link, no permission, not a regular file).
 */
function launched(bin: string, env: NodeJS.ProcessEnv): { launcher: string | null; identity: string | null } {
  const launcher = bin.includes("/") ? path.resolve(bin) : findExecutable(bin, env.PATH);
  if (!launcher) return { launcher, identity: null };
  try {
    const real = fs.realpathSync(launcher);
    const st = fs.statSync(real, { bigint: true });
    if (!st.isFile()) return { launcher, identity: null };
    return { launcher, identity: [real, st.dev, st.ino, st.size, st.mode, st.mtimeNs, st.ctimeNs].join("\0") };
  } catch {
    return { launcher, identity: null };
  }
}

/**
 * What `bin --version` reports for the executable a launch with `env` would run, or null when relay
 * cannot read one. A read is reused for VERSION_TTL_MS only while that executable and the
 * environment its probe gets are unchanged (see the top of this file, and its two limits).
 */
export function installedVersion(target: Target, bin: string, env: NodeJS.ProcessEnv): number[] | null {
  const environment = environmentDigest(target, env);
  // A second try only when the executable changed while its version was being read.
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = launched(bin, env);
    if (!before.launcher) {
      // A bare name not found: which entry it last led to is not known, so none of its target's is kept.
      for (const k of versions.keys()) if (k.startsWith(`${target}\0`)) versions.delete(k);
      return null;
    }
    const key = `${target}\0${before.launcher}`;
    if (!before.identity) {
      versions.delete(key);
      return null;
    }
    const kept = versions.get(key);
    const at = now();
    if (kept && kept.identity === before.identity && kept.environment === environment && at - kept.at < VERSION_TTL_MS) return kept.version;
    versions.delete(key);
    // By the name found, so the probe runs what the identity describes, with the launch's environment.
    const r = probeVersion(target, before.launcher, env);
    const version = r.status === 0 ? versionOf(r.stdout) : null;
    const after = launched(bin, env);
    if (after.launcher !== before.launcher || after.identity !== before.identity) continue;
    if (version) versions.set(key, { identity: before.identity, environment, version, at });
    return version;
  }
  return null;
}
