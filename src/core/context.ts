import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Mode } from "./config.js";
import { ancestors, getNode, getRun, type NodeRow } from "./db.js";
import { writing } from "./storage.js";

/** What a relay MCP instance knows about where it sits. */
export type Context =
  | { kind: "root" }
  | {
      kind: "child"; runId: string; nodeId: string; depth: number;
      /** What this one turn may do. Authority comes from here, never from how the session was first created. */
      turnId: number; access: Mode; mayDelegate: boolean; mayAsk: boolean;
      /** The turn's gateway manifest, when it was given MCP servers (src/mcp/gateway.ts). */
      extensions?: string;
    }
  | { kind: "poisoned"; reason: string };

export interface ContextFile {
  run_id: string;
  node_id: string;
  depth: number;
  /** Present in the per-turn file relay passes as --context; absent from a worktree's identity file. */
  turn_id?: number;
  access?: Mode;
  may_delegate?: boolean;
  may_ask?: boolean;
  /** The turn's gateway manifest, in relay's control directory, when the turn was given MCP servers. */
  extensions?: string;
}

export const CONTEXT_DIR = ".relay";
export const CONTEXT_FILE = "context.json";
/** Far more than a context file ever holds. A bigger one is not relay's. */
const CONTEXT_MAX_BYTES = 4096;

/**
 * The contents of a small regular file, read without following a link at its name and without
 * blocking on a FIFO or device left in its place: relay reads some files from directories an agent
 * can write (a worktree's `.relay/context.json` and `.git`). Throws, saying why, for anything that
 * is not a regular file of at most `maxBytes` bytes. Checked before opening and again on the open
 * file, so a swap in between is caught too.
 */
export function readRegularFile(file: string, maxBytes: number): string {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) throw new Error("it is a symbolic link");
  if (!st.isFile()) throw new Error("it is not a regular file");
  if (st.size > maxBytes) throw new Error(`it is larger than ${maxBytes} bytes`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const open = fs.fstatSync(fd);
    if (!open.isFile() || open.ino !== st.ino || open.dev !== st.dev) throw new Error("it was replaced while relay read it");
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    if (n > maxBytes) throw new Error(`it is larger than ${maxBytes} bytes`);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readContextFile(file: string): ContextFile {
  // In a worktree the agent can write both: a link at `.relay` would have relay read a file elsewhere.
  const dir = fs.lstatSync(path.dirname(file));
  if (!dir.isDirectory()) throw new Error(`${path.dirname(file)} is not a directory`);
  const raw = JSON.parse(readRegularFile(file, CONTEXT_MAX_BYTES)) as ContextFile;
  if (typeof raw?.run_id !== "string" || typeof raw.node_id !== "string" || typeof raw.depth !== "number") {
    throw new Error("missing run_id, node_id or depth");
  }
  return raw;
}

/** Whether anything is at `p`, a dangling link included: something there that is not a context file counts against. */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function findUp(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, CONTEXT_DIR, CONTEXT_FILE);
    if (present(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const isAncestorOrSelf = (ancestorId: string, node: NodeRow): boolean => ancestors(node, { self: true }).some((a) => a.id === ancestorId);

/**
 * Decides whether this instance is a root, a child, or poisoned.
 *
 * Channels: explicit env in the injected server entry, the --context argument, and
 * .relay/context.json found from cwd upward. If no channel is present this is a root. If any is
 * present, everything present must load and agree with the registry; otherwise the instance is
 * poisoned and refuses to start anything. A child can never fall back to being a root.
 */
export function loadContext(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Context {
  const argIdx = argv.indexOf("--context");
  const argFile = argIdx >= 0 ? argv[argIdx + 1] : undefined;
  const envKeys = ["RELAY_RUN_ID", "RELAY_NODE_ID", "RELAY_DEPTH", "RELAY_INJECTED"].filter((k) => env[k] !== undefined);
  const cwdFile = findUp(cwd);

  if (argIdx < 0 && envKeys.length === 0 && !cwdFile) return { kind: "root" };

  const poisoned = (reason: string): Context => ({ kind: "poisoned", reason });
  try {
    if (env.RELAY_INJECTED !== "1") {
      return poisoned("this relay server was not started by relay, but the session is a relay child (duplicate server)");
    }
    if (!argFile) return poisoned("the --context argument is missing");
    for (const k of ["RELAY_RUN_ID", "RELAY_NODE_ID", "RELAY_DEPTH"]) {
      if (!env[k]) return poisoned(`${k} is missing from the environment`);
    }
    let fromArg: ContextFile;
    try {
      fromArg = readContextFile(argFile);
    } catch (err) {
      return poisoned(`context file ${argFile} could not be read: ${(err as Error).message}`);
    }
    const fromEnv: ContextFile = { run_id: env.RELAY_RUN_ID!, node_id: env.RELAY_NODE_ID!, depth: Number(env.RELAY_DEPTH) };
    if (fromArg.run_id !== fromEnv.run_id || fromArg.node_id !== fromEnv.node_id || fromArg.depth !== fromEnv.depth) {
      return poisoned("the environment and the context file disagree");
    }
    const run = getRun(fromArg.run_id);
    const node = getNode(fromArg.node_id);
    if (!run || !node) return poisoned("the run or node is not in the registry");
    if (node.run_id !== run.id || node.depth !== fromArg.depth) return poisoned("the registry disagrees with the context");
    if (cwdFile) {
      // A worktree's file names the job that owns the worktree. An in-place child working inside
      // that worktree is a descendant of that job, so ancestor-or-self is the consistency rule.
      let fromCwd: ContextFile;
      try {
        fromCwd = readContextFile(cwdFile);
      } catch (err) {
        return poisoned(`${cwdFile} could not be read: ${(err as Error).message}`);
      }
      if (fromCwd.run_id !== run.id || !isAncestorOrSelf(fromCwd.node_id, node)) {
        return poisoned(`${cwdFile} belongs to a different agent`);
      }
    }
    if (typeof fromArg.turn_id !== "number" || (fromArg.access !== "read" && fromArg.access !== "write")) {
      return poisoned("the context file carries no turn policy");
    }
    if (fromArg.extensions !== undefined && typeof fromArg.extensions !== "string") return poisoned("the context file's extensions are not a path");
    return {
      kind: "child", runId: run.id, nodeId: node.id, depth: node.depth,
      turnId: fromArg.turn_id, access: fromArg.access, mayDelegate: fromArg.may_delegate === true, mayAsk: fromArg.may_ask === true,
      ...(fromArg.extensions ? { extensions: fromArg.extensions } : {}),
    };
  } catch (err) {
    return poisoned(`context check failed: ${(err as Error).message}`);
  }
}

/** Writes a context file into a directory of relay's own (a node's directory under relay's control directory): what it throws is a write's (storage.ts writing). */
export function writeContextFile(file: string, ctx: ContextFile): void {
  writing(() => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(ctx, null, 2));
  });
}

/** For tests only: called with relay's build directory after it is made and before the file is written. */
export const contextWriteHooks: { afterBuildDir?: (dir: string) => void } = {};

/**
 * Writes a job's identity file into its worktree, which the job's agent can write. Relay writes it
 * outside any sandbox, so nothing the agent left there may steer the write. The file is built in a
 * fresh directory relay makes beside the worktree, in the worktree's parent (relay's own run
 * directory, which no agent can write, on the same filesystem), so nothing the agent does can reach
 * it between its creation and the write. It is then renamed onto `.relay`: rename replaces whatever
 * name is there (a stale directory removed first; a symlink or file overwritten, never followed),
 * so no write goes through a link the agent put there, and nothing is left in the tree. Anything that
 * stops relay's directory landing there (a non-empty directory reappearing, say) makes this throw.
 */
export function writeWorktreeContext(worktree: string, ctx: ContextFile): void {
  const dir = path.join(worktree, CONTEXT_DIR);
  const build = path.join(path.dirname(worktree), `.${path.basename(worktree)}${CONTEXT_DIR}.${crypto.randomBytes(8).toString("hex")}`);
  // mkdirSync (no recursive) fails if the name is taken; the name is random, so it is relay's own.
  fs.mkdirSync(build, { mode: 0o700 });
  try {
    contextWriteHooks.afterBuildDir?.(build);
    fs.writeFileSync(path.join(build, CONTEXT_FILE), JSON.stringify(ctx, null, 2), { flag: "wx" });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(build, dir);
  } catch (err) {
    fs.rmSync(build, { recursive: true, force: true });
    throw err;
  }
}
