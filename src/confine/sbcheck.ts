import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Asks the kernel whether a process's sandbox allows an operation on a path: sandbox_check with a
 * path filter (docs/codex-confinement-design.md §2.2 step 15, §9.1). Owner: WP-C.
 *
 * sandbox_check is variadic, so osascript's JavaScript bridge cannot pass the path (it returned -1).
 * relay builds a small helper instead, native/sbcheck.c, compiled by `npm run build`
 * (scripts/build-sbcheck.mjs) into dist/native/relay-sbcheck where the developer tools are present.
 * Before relay trusts it, it runs a known-answer test once per process: a sleep under a profile
 * that denies writing one directory and allows another must read as sandboxed, allowed and denied
 * in that order, and relay's own process as not sandboxed. Without the helper, or when the test
 * fails, sandboxCheckUnavailable says why and the caller falls back to process-tree tracking.
 *
 * Measured on macOS 27 (Darwin 27.0.0, arm64), 2026-10-28: the answer is exact for paths that
 * exist; for a path that does not exist the kernel answers "deny" whatever the profile says, for
 * sandboxed and unsandboxed processes alike. Ask only about existing paths.
 */

/** "allow", "deny", or "error: …" when the kernel could not be asked. */
export type SandboxAnswer = "allow" | "deny" | `error: ${string}`;

/** One process's answers: whether it runs sandboxed, and the operation's answer for each path asked, in order. */
export interface SandboxReport {
  sandboxed: boolean | `error: ${string}`;
  answers: SandboxAnswer[];
}

const OPERATIONS = ["file-write-data", "file-write-create", "file-read-data"] as const;
type Operation = (typeof OPERATIONS)[number];

let helperOverride: string | null = null;
let selfTest: { helper: string; problem: string | null } | null = null;

/** Relay's own package, as protected-config.ts relayPackageRoot finds it (this module is dist/confine/sbcheck.js). */
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");
/** Where `npm run build` puts the helper: dist/native/relay-sbcheck, beside dist/confine, in relay's own package. */
const BUILT_HELPER = path.join(PACKAGE_ROOT, "dist", "native", "relay-sbcheck");

/**
 * The helper as relay found it: its file's identity and the sha256 of its contents, or why it could
 * not be read. Relay runs the helper outside any sandbox, so before each run it must still be this
 * file with these contents (review r_0c11d860 X1): a job granted a directory holding relay's package
 * could otherwise have replaced it during the turn whose teardown runs it. No grant may cover the
 * package now, and every profile relay writes denies writing it; this check is the second layer.
 */
interface HelperRecord { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; sha256: string }
const digest = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function recordHelper(helper: string): HelperRecord | string {
  try {
    const st = fs.lstatSync(helper);
    if (!st.isFile()) return `relay's sandbox_check helper ${helper} was not a regular file when relay started`;
    return { path: helper, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, sha256: digest(helper) };
  } catch {
    return `relay's sandbox_check helper ${helper} was not there when relay started (it is built by \`npm run build\` where the developer tools are installed)`;
  }
}
/** Recorded when relay's process loads this module, at its start: the helper it may run, and nothing else. */
let recorded: HelperRecord | string = recordHelper(BUILT_HELPER);

/** Test-only seam: use another helper binary (or a missing path), recorded now, and forget the cached self-test. */
export function setSandboxCheckHelperForTests(helper: string | null): void {
  helperOverride = helper;
  recorded = recordHelper(helper ?? BUILT_HELPER);
  selfTest = null;
}

/** The helper relay runs: dist/native/relay-sbcheck in its own package. */
export function sandboxCheckHelper(): string {
  return helperOverride ?? BUILT_HELPER;
}

/**
 * Why the helper may not be run: missing, not a regular file, not this user's, writable by others,
 * not relay's own package's, or not the file, with the contents, relay recorded at its start.
 */
function helperProblem(helper: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(helper);
  } catch {
    return `relay's sandbox_check helper ${helper} is not there (it is built by \`npm run build\` where the developer tools are installed)`;
  }
  if (!st.isFile()) return `relay's sandbox_check helper ${helper} is not a regular file`;
  if (process.getuid && st.uid !== process.getuid()) return `relay's sandbox_check helper ${helper} is not owned by this user`;
  if (st.mode & 0o022) return `relay's sandbox_check helper ${helper} is writable by others`;
  if (!(st.mode & 0o100)) return `relay's sandbox_check helper ${helper} is not executable`;
  // Only from relay's own package, reached through real directories (no link on the way), and
  // only the file relay recorded at its start, unchanged: same identity, same contents.
  if (helperOverride === null) {
    let real: string;
    try { real = fs.realpathSync.native(helper); } catch { return `relay's sandbox_check helper ${helper} cannot be resolved`; }
    let root: string;
    try { root = fs.realpathSync.native(PACKAGE_ROOT); } catch { return `relay's own package ${PACKAGE_ROOT} cannot be resolved`; }
    if (real !== path.join(root, "dist", "native", "relay-sbcheck")) return `relay's sandbox_check helper ${helper} resolves to ${real}, not into relay's own package (${root}), so relay does not run it`;
  }
  if (typeof recorded === "string") return recorded;
  if (recorded.path !== helper) return `relay's sandbox_check helper ${helper} is not the one relay recorded at its start (${recorded.path})`;
  if (st.dev !== recorded.dev || st.ino !== recorded.ino || st.size !== recorded.size || st.mtimeMs !== recorded.mtimeMs || st.ctimeMs !== recorded.ctimeMs) {
    return `relay's sandbox_check helper ${helper} has been replaced or changed since relay started, so relay does not run it (restart relay after rebuilding it)`;
  }
  let now: string;
  try { now = digest(helper); } catch (err) { return `relay cannot read its sandbox_check helper ${helper}: ${(err as Error).message}`; }
  if (now !== recorded.sha256) return `relay's sandbox_check helper ${helper} no longer has the contents relay recorded at its start (sha256 ${recorded.sha256.slice(0, 12)}…, now ${now.slice(0, 12)}…), so relay does not run it`;
  return null;
}

const field = (s: string): 0 | 1 | `error: ${string}` => {
  if (s === "0") return 0;
  if (s === "1") return 1;
  const m = /^-1:(\d+)$/.exec(s);
  return `error: sandbox_check failed${m ? ` (errno ${m[1]})` : ` (${JSON.stringify(s)})`}`;
};

/**
 * Asks about many processes at once: for each pid, whether it is sandboxed and whether its sandbox
 * allows `operation` on each path (which must exist). A string when the helper could not be run.
 * Does not run the self-test; callers that act on the answer check sandboxCheckUnavailable first.
 */
export function sandboxReports(operation: Operation, paths: string[], pids: number[]): Map<number, SandboxReport> | string {
  if (!OPERATIONS.includes(operation)) return `unknown operation ${operation}`;
  if (!paths.length || paths.some((p) => !path.isAbsolute(p) || /[\0\n]/.test(p))) return "each path must be absolute";
  const helper = sandboxCheckHelper();
  const bad = helperProblem(helper);
  if (bad) return bad;
  const out = new Map<number, SandboxReport>();
  const wanted = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  // In slices, to keep each command line well under ARG_MAX however many processes there are.
  for (let i = 0; i < wanted.length; i += 512) {
    const slice = wanted.slice(i, i + 512);
    // Checked again right before every run, not once per call: it runs outside any sandbox.
    const changed = i > 0 ? helperProblem(helper) : null;
    if (changed) return changed;
    const r = spawnSync(helper, [operation, ...paths, "--", ...slice.map(String)], { encoding: "utf8", timeout: 20000, env: { PATH: "/usr/bin:/bin" } });
    if (r.error || r.status !== 0) return `relay's sandbox_check helper failed: ${r.error?.message ?? `exit ${r.status}: ${(r.stderr ?? "").trim()}`}`;
    for (const line of r.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== paths.length + 2 || !/^\d+$/.test(parts[0])) continue;
      const s = field(parts[1]);
      out.set(Number(parts[0]), {
        sandboxed: typeof s === "string" ? s : s === 1,
        answers: parts.slice(2).map((a) => {
          const v = field(a);
          return typeof v === "string" ? v : v === 0 ? "allow" : "deny";
        }),
      });
    }
  }
  return out;
}

export function sandboxAllows(pid: number, operation: "file-write-data" | "file-write-create", target: string): SandboxAnswer {
  const reports = sandboxReports(operation, [target], [pid]);
  if (typeof reports === "string") return `error: ${reports}`;
  return reports.get(pid)?.answers[0] ?? "error: the helper gave no answer for this process";
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The known-answer test, run once per process (and helper). */
function runSelfTest(helper: string): string | null {
  const bad = helperProblem(helper);
  if (bad) return bad;
  if (process.platform !== "darwin") return "sandbox_check exists only on macOS";
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-sbcheck-")));
  const allowed = path.join(base, "a"), denied = path.join(base, "d");
  fs.mkdirSync(allowed);
  fs.mkdirSync(denied);
  const child = spawn("/usr/bin/sandbox-exec", ["-p", '(version 1)(allow default)(deny file-write* (subpath (param "D")))', "-D", `D=${denied}`, "/bin/sleep", "30"], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  const pid = child.pid ?? -1;
  try {
    if (pid <= 0) return "relay could not start the sandbox_check helper's control process";
    let report: SandboxReport | undefined;
    for (let i = 0; i < 40; i++) {
      const r = sandboxReports("file-write-data", [allowed, denied], [pid, process.pid]);
      if (typeof r === "string") return r;
      report = r.get(pid);
      const self = r.get(process.pid);
      if (self?.sandboxed !== false) return `relay's sandbox_check helper misreads relay's own process (${JSON.stringify(self)})`;
      if (report?.sandboxed === true) break;
      pause(50);
    }
    if (report?.sandboxed !== true) return `relay's sandbox_check helper did not see its control process as sandboxed (${JSON.stringify(report)})`;
    if (report.answers[0] !== "allow" || report.answers[1] !== "deny") return `relay's sandbox_check helper gave the wrong answers for its control process: ${JSON.stringify(report.answers)} where allow, deny was expected`;
    return null;
  } finally {
    try {
      if (pid > 0) process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    child.unref();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** Whether this machine can ask (the helper is present and answers a known control). Null when it can. */
export function sandboxCheckUnavailable(): string | null {
  const helper = sandboxCheckHelper();
  if (selfTest?.helper !== helper) selfTest = { helper, problem: runSelfTest(helper) };
  // The self-test runs once; the helper's identity and contents are checked on every ask, so a
  // helper changed since then reads as unavailable (and the caller reports it) rather than as an empty sweep.
  return selfTest.problem ?? helperProblem(helper);
}
