// Every program relay runs outside a sandbox is run by an absolute path (review r_0c11d860 X1
// follow-up): macOS's own tools by their fixed paths in the sealed system volume (/bin, /sbin,
// /usr/bin, /usr/sbin, which SIP protects), everything else (git, the target CLIs) found on PATH
// here and run by the absolute name found. Nothing is left to a lookup when the program starts.
// What is found is protected: no grant may cover the name, the file it leads to or its
// installation (protected-config.ts relayInstallation), nor a directory on relay's PATH, either way
// round (relayPathDirs); relay's sandboxes deny writing all of them; and a turn whose own PATH
// leads a target CLI into a granted directory is refused (targetLaunchProblem).
// test/executables.test.ts fails on a spawn of a bare name in src/, bin/relay or the build scripts.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const runnable = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** What relay says when a program it would run is not there. */
export const notFound = (bin: string): string => `\`${bin}\` was not found${bin.includes("/") ? "" : " on PATH"}, or is not runnable`;

/**
 * The absolute path relay runs `bin` by: a path as given (resolved), a bare name the first runnable
 * match in `searchPath`'s absolute directories (relative entries are skipped). It is the name found
 * there, on purpose not the file a link leads to: Claude Code updates itself by repointing its
 * link, and the next start must follow it. The name, the file it leads to and the installation
 * holding it are all protected alike (protected-config.ts executableParts). Null when there is none.
 */
export function findExecutable(bin: string, searchPath: string = process.env.PATH ?? ""): string | null {
  if (!bin) return null;
  if (bin.includes("/")) return runnable(path.resolve(bin)) ? path.resolve(bin) : null;
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir && path.isAbsolute(dir) && runnable(path.join(dir, bin))) return path.join(dir, bin);
  }
  return null;
}

/**
 * The path a spawn of `bin` is given: a path as given, resolved (absolute, so nothing is looked up,
 * and a missing or unrunnable file fails at the spawn itself, with the spawn's own error, as
 * before); a bare name as findExecutable finds it on `searchPath`, or, when there is none, an error
 * with code ENOENT and notFound's message, for a start that cannot go on without it.
 */
export function executable(bin: string, searchPath: string = process.env.PATH ?? ""): string {
  if (bin.includes("/")) return path.resolve(bin);
  const found = findExecutable(bin, searchPath);
  if (!found) throw Object.assign(new Error(notFound(bin)), { code: "ENOENT" });
  return found;
}

/**
 * Runs `bin` by its absolute path (executable's), synchronously. A path as given is run as it is,
 * so a missing one gives the spawn's own result (spawnSync … ENOENT); a bare name not found on
 * `searchPath` gives the same shape (error ENOENT, with notFound's message), so callers handle both alike.
 */
export function spawnFound(bin: string, args: string[], options: SpawnSyncOptionsWithStringEncoding, searchPath: string = process.env.PATH ?? ""): SpawnSyncReturns<string> {
  const exe = bin.includes("/") ? path.resolve(bin) : findExecutable(bin, searchPath);
  if (exe) return spawnSync(exe, args, options);
  const error = Object.assign(new Error(notFound(bin)), { code: "ENOENT" });
  return { pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null, error };
}

/**
 * Whether relay is running inside its own test suite: Node's test runner sets NODE_TEST_CONTEXT in
 * each test file's process, and the processes it starts inherit it. Nothing that starts relay for
 * real (a host, the launcher, a terminal) sets it, and a job cannot set relay's environment.
 */
const underNodeTest = (): boolean => typeof process.env.NODE_TEST_CONTEXT === "string" && process.env.NODE_TEST_CONTEXT.startsWith("child");

/**
 * The directory of stand-ins the tests of the terminal commands (install, uninstall, doctor) give
 * for macOS tools, or null. Those tests run relay as a separate process, so an in-process setter
 * cannot reach it. Honoured only inside relay's own test suite (underNodeTest), for a directory of
 * this user's under a system temp directory; elsewhere it is ignored, and the fixed path is run.
 */
export function testSystemTools(): string | null {
  const dir = process.env.RELAY_TEST_SYSTEM_TOOLS;
  if (!dir || !path.isAbsolute(dir) || !underNodeTest()) return null;
  try {
    const real = fs.realpathSync(dir);
    // The system's temp directories (a test may give relay a TMPDIR of its own beside the stand-ins).
    const temps = [...new Set([fs.realpathSync(os.tmpdir()), "/private/tmp", "/private/var/folders"])];
    const st = fs.statSync(real);
    if (!temps.some((t) => real.startsWith(t + path.sep)) || !st.isDirectory() || (process.getuid && st.uid !== process.getuid())) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * One of macOS's own tools, by its fixed path, as the terminal commands (install, uninstall, doctor)
 * run it; a test's stand-in only inside relay's own test suite (testSystemTools). Relay's server and
 * workers never take a stand-in: they name the fixed path directly.
 */
export function systemTool(fixed: string): string {
  const dir = testSystemTools();
  if (dir && runnable(path.join(dir, path.basename(fixed)))) return path.join(dir, path.basename(fixed));
  return fixed;
}

let git: { path: string | null } | null = null;
/**
 * The git relay runs, found on PATH once per process and kept: every git command relay runs, in
 * this process, runs that one file by its absolute name (findExecutable's, a link's name). Null
 * when there is none.
 */
export function gitExecutable(): string | null {
  git ??= { path: findExecutable("git") };
  return git.path;
}

/** /usr/bin/git and the developer tools' other entry points are xcrun shims: they run the active developer directory's tools. */
export const XCRUN_SHIMS = new Set(["/usr/bin/git"]);

let developer: { dirs: string[] } | null = null;
/**
 * The developer directories a shim may run git from: DEVELOPER_DIR when set, and the one
 * `xcode-select -s` chose, read from its link without running it (once per process). Usually
 * /Applications/Xcode.app/Contents/Developer or /Library/Developer/CommandLineTools, both root's,
 * but a DEVELOPER_DIR or `xcode-select -s` may point anywhere.
 */
export function developerDirs(): string[] {
  if (developer) return developer.dirs;
  const dirs: string[] = [];
  if (process.env.DEVELOPER_DIR && path.isAbsolute(process.env.DEVELOPER_DIR)) dirs.push(process.env.DEVELOPER_DIR);
  try {
    // A plain read of what xcode-select records, without running it: its link in /var/db.
    const link = "/var/db/xcode_select_link";
    if (fs.existsSync(link)) dirs.push(fs.realpathSync(link));
    else if (fs.existsSync("/Library/Developer/CommandLineTools")) dirs.push("/Library/Developer/CommandLineTools");
  } catch {
    // None recorded.
  }
  developer = { dirs: [...new Set(dirs)] };
  return developer.dirs;
}
