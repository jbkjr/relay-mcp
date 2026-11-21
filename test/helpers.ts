import { HOME_VARS } from "./process-home.ts";
import { removeTestNativeTempAlias } from "./native-temp-alias.ts";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CancelledNotificationSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { canonical } from "../dist/core/config.js";
import { neverProfileInputs, type NeverPolicy } from "../dist/core/never-policy.js";
import { sendGroupSignal } from "../dist/core/procs.js";
import { TARGET_IDS, TARGETS, type Target } from "../dist/targets/index.js";
import { hostVar } from "./host-env.ts";
export { hostVar };

const ROOT = path.resolve(import.meta.dirname, "..");
export const CLI = path.join(ROOT, "dist", "cli.js");
export const UNAVAILABLE_REPLY = {
  error: "Item unavailable.",
  recovery: "If this is your own work from before a restart or reconnect, ask the person to adopt it: adopt with this id (they confirm), or relay adopt <id> --to <fingerprint> in a terminal.",
};

/** Kills a process group a test started, through relay's guard (sendGroupSignal), so a stale or wrong number never reaches the test runner's own group or the shell's. */
export function killGroup(pgid: number | null | undefined): void {
  try { sendGroupSignal(pgid ?? 0, "SIGKILL"); } catch { /* gone, or refused and reported */ }
}

/** The reply to any call carrying a session token relay did not issue under this relay home's key. */
export const SESSION_UNAVAILABLE_REPLY = {
  error: "Session unavailable.",
  recovery: "Pass session_token exactly as relay gave it to this conversation (new_session.token). If this conversation has none, call without session_token to get one: a new token has none of the earlier work. " +
    "To move that work to it, the person quits and reopens the app, then runs relay adopt from a terminal (relay cancel there stops it instead).",
};
/** The Claude desktop app's shared entry, as its chat process connects (docs/d9-isolation-plan.md). */
export const DESKTOP_CHATS = { args: ["--desktop", "--host", "claude"], clientInfo: { name: "claude.ai", version: "2.42304.0" }, cwd: "/" };

/**
 * One conversation on a shared relay connection: the token relay issued it on a plain status, its
 * fingerprint, and calls that carry the token. Several can share one connection, as desktop chats do.
 */
export async function conversationOn(shared: { call: (tool: string, args?: Record<string, unknown>, opts?: CallOpts) => Promise<Rec> }) {
  const fresh = await shared.call("status");
  const token = fresh.new_session?.token as string | undefined;
  if (!token) throw new Error(`no session token was issued: ${JSON.stringify(fresh)}`);
  return {
    token, fingerprint: fresh.session.fingerprint as string,
    call: (tool: string, args: Record<string, unknown> = {}, opts: CallOpts = {}) => shared.call(tool, { ...args, session_token: token }, opts),
  };
}

const stubBin = (target: string) => path.join(ROOT, "test", "stubs", `stub-${target}`);
/** The targets in relay's registry that the stub agent emulates, in registry order. */
export const STUB_TARGETS: readonly Target[] = TARGET_IDS.filter((t) => fs.existsSync(stubBin(t)));
/** Declares the same tests once for each stubbed target. */
export const forEachTarget = (fn: (target: Target) => void) => STUB_TARGETS.forEach((t) => fn(t));

const vendorOf = (t: string) => TARGETS.find((d) => d.id === t)?.vendor;
/** The host a root session reaching `target` runs in: the first stubbed target of another vendor. */
export const hostFor = (target: string): Target => STUB_TARGETS.find((t) => vendorOf(t) !== vendorOf(target))!;

export type Rule = { target?: string; match?: string; turn?: number; steps: Record<string, unknown>[] };
export type Rec = Record<string, any>;

export interface Harness {
  home: string;
  repo: string;
  env: Record<string, string>;
  call(tool: string, args?: Record<string, unknown>, opts?: CallOpts): Promise<Rec>;
  /**
   * Another relay MCP instance. With --context in args it is a launched agent's; with --host, a
   * root session in that host; with host: null, a root session whose host relay cannot tell.
   * Otherwise it is a root session whose host is chosen per call, as call's is (see harness).
   */
  instance(opts: InstanceOpts): Promise<{ call: Harness["call"]; tools(): Promise<string[]>; toolDefinitions(): Promise<Rec[]>; close(): Promise<void> }>;
  log(): Rec[];
  starts(): Rec[];
  ends(): Rec[];
  /** Broker address from this node's actual native relay launcher, as a real child receives it. */
  environmentSocket(nodeId: string): string | undefined;
  sql(query: string, ...params: unknown[]): Rec[];
  /**
   * What relay would hand a launched agent's relay server for a turn of this node: a context file
   * carrying the turn's policy, the matching env, and a turn that is running in the registry.
   * It waits first for the node's own worker to be gone: a worker still winding down its last turn
   * would close this one too.
   */
  childOf(nodeId: string, policy?: { access?: "read" | "write"; may_delegate?: boolean; may_ask?: boolean; running?: boolean }): Promise<{ args: string[]; env: Record<string, string>; turnId: number }>;
  /** Runs the relay CLI against this harness's control directory, with a private TMPDIR unless the test gave one (see harness). */
  cli(...args: string[]): string;
  /** As cli, with extra environment (a worker run by hand needs its root's RELAY_ENV_SOCKET, as relay gives one). */
  cliEnv(extra: Record<string, string>, ...args: string[]): string;
  /** Sets a mark a stub step waits on (`awaitMark`), instead of the stub sleeping and the test racing it. */
  mark(name: string): void;
  /** True once a stub step (`mark`) or the test has set this mark. */
  marked(name: string): boolean;
  /**
   * A fake Claude Code inbox socket: pass its env to an instance, and read what relay posted, one
   * entry per connection (the auth token sent, and the user message's text).
   */
  inbox(): Promise<{ env: Record<string, string>; posts(): { token?: string; text: string }[] }>;
  /**
   * The stand-in clipboard every relay process of this harness uses (pbcopy and pbpaste through
   * RELAY_TEST_SYSTEM_TOOLS, executables.ts systemTool): what it holds now, and every copy made, in
   * order. No test reaches the person's own clipboard. `failCopies` makes pbcopy exit 1.
   */
  clipboard(): { held: string; copies: string[]; failCopies(fail: boolean): void };
  close(): Promise<void>;
}

export interface InstanceOpts {
  args?: string[]; env?: Record<string, string>; cwd?: string; host?: null;
  /**
   * Makes the client a host that can put relay's questions to the user, answering with this. `signal` is aborted if relay withdraws
   * the question; `params` is the whole request (its requestedSchema, say).
   */
  elicit?: (message: string, signal: AbortSignal, params: Rec) => Rec | Promise<Rec>;
  /** The client's name and version in initialize. Default test 0, a host relay does not recognise. */
  clientInfo?: { name: string; version: string };
  /** Desktop MCP UI marker observed in the Codex app (answers.md XA-a). */
  desktopUi?: boolean;
  /** The relay CLI the server runs, and with it the workers it starts. Default this checkout's dist/cli.js. */
  cli?: string;
}

/** What an interactive Claude Code session in a terminal looks like to relay's server: its client info and environment. */
export const INTERACTIVE_CLAUDE = { clientInfo: { name: "claude-code", version: "2.1.286" }, env: { CLAUDE_CODE_ENTRYPOINT: "cli" } };

/** Per call: progress notifications as they arrive, and a signal that cancels the call. */
/** meta is sent as the request's _meta, as a host attaches it. */
export interface CallOpts { onprogress?: (p: { progress: number; message?: string }) => void; signal?: AbortSignal; meta?: Record<string, unknown> }

/**
 * The home folder of the user running the tests, from the user database rather than HOME, which a
 * test may already have pointed somewhere else. Tests never probe, write or delete anything in it.
 */
export const REAL_HOME = fs.realpathSync(os.userInfo().homedir);

/**
 * What relay adds to every Claude turn that is not dangerous, so that it cannot read the API key
 * relay hands a key-only target (backends/claude.ts; core/api-keys.ts keyPathsToDeny), nor relay's
 * sockets directory, where a confined turn's broker keeps its bridge secret's file (confine/sockets.ts):
 * with no local config and no key saved, the default key directory under `home`, then
 * `<home>/.relay-t/s`, in the sandbox's denyRead and as Read deny rules for its file tools, after
 * relay's other deny rules.
 */
export const claudeReadDeny = (home: string): { paths: string[]; rules: string[] } => {
  const keys = path.join(home, ".config", "relay-keys");
  const sockets = path.join(fs.realpathSync(home), ".relay-t", "s");
  const codex = path.join(home, ".local", "share", "relay-codex-home");
  return { paths: [keys, sockets, codex], rules: [keys, sockets, codex].flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]) };
};
/**
 * The never floor relay adds last to every Claude turn (core/never-coverage.ts: Claude always gets
 * the floor; backends/claude.ts applyClaudeNeverPolicy), from the run's durable floor
 * (runs.config_json params_json.never_floor). `read` and `write` are the names the sandbox's denyRead
 * and denyWrite gain (each list keeps a name only once); `rules`, the deny rules for Claude's own
 * tools: Read rules for each name of an all-access entry, Edit rules for those and then for the
 * write-only entries, and with never.hosts WebSearch and WebFetch. `run` picks the run; without it
 * every run in the registry must hold the same floor.
 */
export const claudeFloor = (h: { sql: (query: string, ...params: unknown[]) => Rec[] }, run?: string): { read: string[]; write: string[]; rules: string[] } => {
  const rows = h.sql(`SELECT json_extract(config_json, '$.params_json.never_floor.policy') AS policy FROM runs${run ? " WHERE id = ?" : ""}`, ...(run ? [run] : []));
  const floorOf = (policy: NeverPolicy) => {
    const floor = neverProfileInputs(policy);
    const write = [...floor.denyAll, ...floor.denyWrite];
    const rule = (tool: string) => (p: string) => {
      const escaped = p.replace(/([*?[\]{}!\\])/g, "\\$1");
      return [`${tool}(/${escaped})`, `${tool}(/${escaped}/**)`];
    };
    return { read: floor.denyAll, write, rules: [...floor.denyAll.flatMap(rule("Read")), ...write.flatMap(rule("Edit")), ...(policy.hosts.length ? ["WebSearch", "WebFetch"] : [])] };
  };
  const floors = [...new Set(rows.filter((r) => r.policy).map((r) => JSON.stringify(floorOf(JSON.parse(r.policy as string)))))];
  if (floors.length !== 1) throw new Error(`expected one never floor across ${run ?? "the registry's runs"}, found ${floors.length}`);
  return JSON.parse(floors[0]);
};
/** The floor's deny rules for Claude's own tools (claudeFloor). */
export const claudeFloorDeny = (h: { sql: (query: string, ...params: unknown[]) => Rec[] }, run?: string): string[] => claudeFloor(h, run).rules;
/** Where installed programs live, the Node running the tests first. Tests never probe them either. */
const INSTALLED_DIRS = [...new Set([
  path.dirname(process.execPath), path.dirname(fs.realpathSync(process.execPath)),
  "/opt/homebrew", "/usr", "/bin", "/sbin", "/Applications", "/System", "/Library", "/nix",
  ...(process.env.PATH ?? "").split(path.delimiter),
].filter((d) => path.isAbsolute(d) && d !== path.sep).map((d) => canonical(d)))];
const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Returns `p` if it is a scratch path, and fails the test if it resolves (through any symlinks)
 * under the real home folder or an installed program's directory. Every path a test probes,
 * writes, deletes or hands out as HOME goes through this first.
 */
export function scratchOnly(p: string, what = "path"): string {
  const c = canonical(p);
  const bin = INSTALLED_DIRS.find((d) => under(c, d));
  if (bin) throw new Error(`test guard: ${what} ${p} resolves under an installed program directory (${bin}); tests use scratch paths only`);
  if (under(c, REAL_HOME)) throw new Error(`test guard: ${what} ${p} resolves under the real home folder (${REAL_HOME}); tests use scratch paths only`);
  return p;
}

/**
 * Each nonTempScratch tree's owner, beside it as `<dir>.owner` (the creating process's pid), so a
 * later run can tell a dead run's leftover from a live one's tree. Removed with the tree on exit.
 */
const ownerFile = (dir: string) => `${dir}.owner`;

/** Whether process `pid` may still exist: only ESRCH proves it gone (EPERM is someone else's). */
function mayLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/**
 * Removes nonTempScratch trees under `root` whose run is over: a SIGKILLed run skips the exit
 * handler that removes them. Only `relay-…-XXXXXX` directories (real directories, not links) owned
 * by this user, with an owner file beside them (a regular file of this user's, not a link) naming
 * a process that no longer exists. A tree with no owner file (made before 1.1.3) or whose owner may
 * still live is left alone, as is anything of another user's (a CI account's). Removal errors leave it
 * for the next run. RELAY_TEST_KEEP_SCRATCH=1 turns the start-up sweep off.
 */
export function sweepStaleScratch(root: string, o: { uid?: number; alive?: (pid: number) => boolean } = {}): string[] {
  const uid = o.uid ?? process.getuid?.(), alive = o.alive ?? mayLive;
  const removed: string[] = [];
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return removed; }
  for (const name of names) {
    if (!/^relay-[a-z0-9-]+-[A-Za-z0-9]{6}$/.test(name)) continue;
    const dir = path.join(root, name), owner = ownerFile(dir);
    let st: fs.Stats, ost: fs.Stats, pid: number;
    try { st = fs.lstatSync(dir); ost = fs.lstatSync(owner); pid = Number(fs.readFileSync(owner, "utf8").trim()); } catch { continue; }
    if (!st.isDirectory() || !ost.isFile() || uid === undefined || st.uid !== uid || ost.uid !== uid) continue;
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(owner, { force: true }); removed.push(dir); } catch { /* the next run, or by hand */ }
  }
  return removed;
}

/** Disposable fixtures for write grants, which production refuses under shared temp. */
const nonTempTrees = new Set<string>();
process.on("exit", () => { for (const dir of nonTempTrees) { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(ownerFile(dir), { force: true }); } });
let staleSwept = false;
export function nonTempScratch(prefix: string): string {
  if (!staleSwept && process.platform === "darwin" && process.env.RELAY_TEST_KEEP_SCRATCH !== "1") { staleSwept = true; sweepStaleScratch("/Users/Shared"); }
  const dir = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "darwin" ? "/Users/Shared" : os.tmpdir(), prefix))));
  fs.writeFileSync(ownerFile(dir), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  nonTempTrees.add(dir);
  return dir;
}

/**
 * The real Codex a test runs for its own sandbox (`codex sandbox`): the absolute path in
 * RELAY_TEST_CODEX, which release gates set to the pinned binary (the qualification and red team
 * take the same variable); otherwise `fallback()`, the test's own lookup. Under
 * RELAY_REQUIRE_REAL_CODEX=1, as at gates, nothing stands in for the named binary: without one,
 * `bin` is null and `required` makes that a failure, never a skip or another Codex (PATH's or
 * Homebrew's, which update by themselves). `why` says what is missing.
 */
export function realCodexBin(fallback: () => string | null, env: NodeJS.ProcessEnv = process.env): { bin: string | null; required: boolean; why: string } {
  const required = env.RELAY_REQUIRE_REAL_CODEX === "1";
  const named = env.RELAY_TEST_CODEX;
  if (named) return path.isAbsolute(named) ? { bin: named, required, why: "" } : { bin: null, required, why: `RELAY_TEST_CODEX must be an absolute path, not ${JSON.stringify(named)}` };
  if (required) return { bin: null, required, why: "RELAY_REQUIRE_REAL_CODEX=1, and RELAY_TEST_CODEX names no Codex: at a gate, set it to the pinned binary" };
  return { bin: fallback(), required, why: "no Codex found (RELAY_TEST_CODEX names one; RELAY_REQUIRE_REAL_CODEX=1 makes its absence a failure)" };
}

/** The variables that say where a program keeps its user files: in a test, each must be scratch. */
/** Returns `env` after checking that none of its home-like variables point at real files (see scratchOnly). */
export function scratchEnv<T extends Record<string, string | undefined>>(env: T): T {
  for (const k of HOME_VARS) if (env[k]) scratchOnly(env[k]!, k);
  return env;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The least time `until` gives a condition. A deadline only bounds how long a failing test takes:
 * what a test asserts is what happened, never how fast a loaded machine got there, so no test
 * waits less than this however short the deadline it names.
 */
const UNTIL_FLOOR_MS = 60_000;

/** Polls `fn` until it is true; fails the test if it is not within max(ms, UNTIL_FLOOR_MS). */
export async function until(fn: () => boolean | Promise<boolean>, ms = UNTIL_FLOOR_MS, label = "condition"): Promise<void> {
  const end = Date.now() + Math.max(ms, UNTIL_FLOOR_MS);
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      // Not ready yet (for example the registry has not been created).
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Lets stub agents held at an `await` step of that name go on. Tests synchronize with the stubs
 * this way rather than by sleeping: a loaded machine can stretch any sleep past what it was for.
 */
export const release = (h: Pick<Harness, "env">, name: string) => fs.writeFileSync(path.join(h.env.STUB_DIR, name), "");
/** True once a stub agent has passed a `signal` step of that name. */
export const reached = (h: Pick<Harness, "env">, name: string) => fs.existsSync(path.join(h.env.STUB_DIR, name));

/**
 * Waits until relay has read the `checkpoint` of that name from the item's agent, then lets the
 * agent go on. Relay deals with an agent's output a line at a time, each line completely before
 * the next, so by then it has dealt with everything the agent said before the checkpoint, while the
 * agent was still there, held at it.
 */
export async function passed(h: Pick<Harness, "env" | "sql">, id: string, name: string): Promise<void> {
  const said = `"checkpoint":${JSON.stringify(name)}`;
  await until(() => {
    const file = h.sql("SELECT log_path FROM nodes WHERE id = ?", id)[0]?.log_path;
    return Boolean(file) && fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(said);
  }, 20000, `relay to read the agent's checkpoint "${name}"`);
  release(h, name);
}

/**
 * Steps after which relay has certainly looked at what the agent had started before them (see
 * looked). Relay looks at least once a second while an agent runs. Once it has read the first
 * checkpoint its next look is due within a second; the second checkpoint comes later than that,
 * and relay reads the third only in a later turn of its event loop, which runs due timers first.
 */
export const lookSteps = (name: string) => [{ checkpoint: `${name}-1` }, { sleep: 1100 }, { checkpoint: `${name}-2` }, { checkpoint: `${name}-3` }];
/** Lets a stub agent through its lookSteps, returning once relay has looked at it while it was held there. */
export async function looked(h: Pick<Harness, "env" | "sql">, id: string, name: string): Promise<void> {
  for (const n of [1, 2, 3]) await passed(h, id, `${name}-${n}`);
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Exercise the real CLI's interactive boundary using a child PTY, never a CLI bypass flag. */
export function terminalAdoption(h: Pick<Harness, "repo" | "env" | "sql">, id: string, to: string, answer?: string) {
  const run = id.startsWith("run_") ? id : h.sql("SELECT run_id FROM nodes WHERE id = ?", id)[0].run_id as string;
  // macOS script(1) rejects Node's socketpair stdin and sends EOF ahead of confirmation
  // with file stdin. A PTY driver waits for the actual prompt before typing the answer.
  const driver = `import os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:-1])
output = b""
sent = False
deadline = time.monotonic() + 12
try:
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        output += chunk
        if not sent and b"Type exactly " in output:
            os.write(fd, (sys.argv[-1] + "\\n").encode())
            sent = True
    else:
        os.kill(pid, signal.SIGKILL)
finally:
    os.close(fd)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
  return spawnSync("python3", ["-c", driver, process.execPath, CLI, "adopt", id, "--to", to, answer ?? `adopt ${run} into ${to}`], {
    cwd: h.repo, env: h.env, encoding: "utf8", timeout: 15000,
  });
}

/**
 * Allow a request through the real `relay approve`, over a child PTY: wait for the one-time code
 * relay prints, type it back (or `answer`, to exercise a refusal), as a person at a terminal does.
 * Never a bypass flag. Returns the final JSON object relay printed and the exit code.
 */
export function terminalApprove(
  h: Pick<Harness, "repo" | "env">,
  id: string,
  opts: { job?: boolean; answer?: string; env?: Record<string, string> } = {},
): { json: Record<string, unknown>; status: number | null; output: string } {
  const driver = `import os, pty, re, select, signal, sys, time
argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(argv[0], argv)
override = os.environ.get("APPROVE_ANSWER")
output = b""
sent = False
deadline = time.monotonic() + 12
try:
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        if not sent:
            m = re.search(rb"type the code ([A-Z0-9]+)", output)
            if m:
                reply = override if override is not None else m.group(1).decode()
                os.write(fd, (reply + "\\n").encode())
                sent = True
    else:
        os.kill(pid, signal.SIGKILL)
finally:
    os.close(fd)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.stdout.buffer.flush()
sys.exit(os.waitstatus_to_exitcode(status))
`;
  const args = [CLI, "approve", id, ...(opts.job ? ["--job"] : [])];
  const env = { ...h.env, ...(opts.answer !== undefined ? { APPROVE_ANSWER: opts.answer } : {}), ...(opts.env ?? {}) };
  const r = spawnSync("python3", ["-c", driver, process.execPath, ...args], { cwd: h.repo, env, encoding: "utf8", timeout: 15000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // relay prints its result as the last JSON object; the prompt lines precede it.
  const match = output.match(/\{[\s\S]*\}\s*$/);
  let json: Record<string, unknown> = {};
  try { if (match) json = JSON.parse(match[0]); } catch { /* left empty: the caller asserts on output */ }
  return { json, status: r.status, output };
}

/** Explicit person-controlled recovery in scratch state. No test relies on silent adoption. */
export async function authorizeRun(h: Harness, client: Pick<Harness, "call">, id: string): Promise<{ run: string; to: string; owned?: boolean }> {
  const run = id.startsWith("run_") ? id : h.sql("SELECT run_id FROM nodes WHERE id = ?", id)[0].run_id as string;
  const visible = await client.call("status", { id });
  if (visible.id === id || visible.run_id === run) return { run, to: (await client.call("status")).session.fingerprint, owned: true };
  const pid = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid;
  await until(() => !alive(pid), undefined, "the old owning connection to exit before explicit recovery");
  // Select the routed harness's host for this item without gaining any access.
  const to = (await client.call("status")).session.fingerprint as string;
  const terminal = terminalAdoption(h, id, to);
  if (terminal.status !== 0) throw new Error(`terminal adoption failed: ${terminal.stdout}\n${terminal.stderr}`);
  return { run, to };
}
export async function adoptRun(h: Harness, client: Pick<Harness, "call">, id: string): Promise<Rec> {
  const { run, to, owned } = await authorizeRun(h, client, id);
  if (owned) return { adopted: true, run_id: run, into_session: to };
  const r = await client.call("adopt", { run_id: run, into_session: to });
  if (!r.adopted) throw new Error(`confirmed adoption failed: ${JSON.stringify(r)}`);
  return r;
}

/**
 * Stops the detached children a stub agent's `orphan` steps started, as listed in its directory's
 * `orphans`. They are in process groups of their own, so killing the agent's group misses them, and
 * a test that fails before reading their pids cannot. A pid is killed only while its command line is
 * still the orphan's, naming this stub directory: by now the pid may belong to another process.
 */
function killOrphans(stubDir: string): void {
  let pids: number[];
  try {
    pids = fs.readFileSync(path.join(stubDir, "orphans"), "utf8").split("\n").filter(Boolean).map(Number).filter((p) => p > 1);
  } catch {
    return; // No orphan was started.
  }
  for (const pid of pids) {
    const r = spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    const command = r.status === 0 ? r.stdout.trim() : "";
    if (command.endsWith(` relay-stub-orphan ${stubDir}`)) try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

/** The task text ends the delegation prompt, so rules anchor on it to avoid matching the preamble. */
export const task = (name: string) => `assignment:\\s+${name}$`;

/** `env`: variables added to the environment of every relay process the harness starts, and so of the agents. */
export async function harness(rules: Rule[] = [], config: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}): Promise<Harness> {
  // Write grants must not live under shared temp. A disposable tree outside it also keeps
  // native sandboxes' default temp allowances from weakening the fixtures' fake homes.
  const tmp = config.allow_temp_home === false
    ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-")))
    : nonTempScratch("relay-test-");
  const home = path.join(tmp, "home");
  const stub = path.join(tmp, "stub");
  const repo = path.join(tmp, "repo");
  // HOME for relay, its agents and git: a scratch one, never the real home folder.
  // Short enough for Claude's private-temp limit (44 bytes including /claude-<uid>).
  const userHome = nonTempScratch("rh");
  for (const d of [home, stub, repo, userHome]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(stub, "log.jsonl"), "");
  fs.writeFileSync(path.join(tmp, "scenario.json"), JSON.stringify({ rules }));
  // Each stubbed target's CLI is its stub; a test's own targets settings are added to that.
  const targets: Record<string, Record<string, unknown>> = Object.fromEntries(STUB_TARGETS.map((t) => [t, { bin: stubBin(t), ...(t === "codex" ? { pinned: false } : {}) }]));
  for (const [t, v] of Object.entries((config.targets ?? {}) as Record<string, Record<string, unknown>>)) targets[t] = { ...targets[t], ...v };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    // Test homes live under the temp directory, which production refuses.
    cancel_grace_ms: 300, block_s: 30, allow_temp_home: true, ...config, targets,
    // The fixture deliberately discloses only its synthetic stub controls. Production's default
    // allowlist must apply in tests too; never automatically pass credential canaries in extraEnv.
    child_env: {
      ...((config.child_env ?? {}) as Record<string, unknown>),
      // The stubs' controls: the three this harness sets below (the stub agent reads its rules from
      // STUB_SCENARIO), and any STUB_* a test sets in its own environment or in extraEnv.
      pass: [...new Set(["STUB_DIR", "STUB_SCENARIO", "STUB_TEMP_ROOT", ...[...Object.keys(process.env), ...Object.keys(extraEnv)].filter((name) => name.startsWith("STUB_")), ...(((config.child_env as { pass?: string[] } | undefined)?.pass) ?? [])])],
    },
  }));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe", env: { PATH: process.env.PATH, HOME: userHome } });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "test");
  g("config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, "README.md"), "sample\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  // The machine's temporary directory is shared with every other relay on it, the live install's
  // among them: no test may sweep it (core/retention.ts sweepTemps). So a worker's daily
  // housekeeping, which sweeps it, is marked done already (a test that wants it removes
  // <home>/housekeeping and gives relay a TMPDIR of its own), and relay clean, which sweeps whatever
  // the config, runs with a private one, unless the test gives its own. Short, so that relay's
  // socket names fit in it: a Unix socket's path may not exceed 103 bytes.
  fs.writeFileSync(path.join(home, "housekeeping"), "marked done by the test harness\n");
  // Claude network turns: the stub Claude's model endpoint, which the turn's proxy serves from this
  // tiny server (RELAY_DEV_MODEL_STUB, set below), so that its model request needs no network.
  const modelStub = net.createServer((c) => {
    c.on("error", () => {});
    c.once("data", () => c.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"));
  });
  await new Promise<void>((r) => modelStub.listen(0, "127.0.0.1", r));
  modelStub.unref();
  fs.mkdirSync(path.join(home, "dev"), { recursive: true });
  fs.writeFileSync(path.join(home, "dev", "claude-model-stub.json"), JSON.stringify({ host: "model.relay-test.invalid", port: (modelStub.address() as net.AddressInfo).port }));
  const cliTmp = fs.realpathSync(fs.mkdtempSync("/tmp/rh-"));

  const env: Record<string, string> = {};
  // Nothing of the session running the tests: relay reads its host from these (and would post to its
  // inbox), and an endpoint it set (the Claude desktop app sets one for the MCP servers it starts)
  // would send agents elsewhere, and relay rightly refuses to pass it on (tests that need one set it
  // through extraEnv).
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("RELAY_") && !hostVar(k) && !HOME_VARS.includes(k)) env[k] = v;
  // Stand-ins for pbcopy and pbpaste, under the system temp directory as testSystemTools requires:
  // relay's room open puts a prompt on the clipboard, and no test may touch the person's own.
  const clipDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-clip-")));
  const clipFile = path.join(clipDir, "clipboard"), clipLog = path.join(clipDir, "copies.jsonl"), clipFail = path.join(clipDir, "fail");
  fs.writeFileSync(clipFile, "");
  fs.writeFileSync(path.join(clipDir, "pbcopy"), `#!/bin/sh\n[ -e "${clipFail}" ] && exit 1\ncat > "${clipFile}"\n/usr/bin/python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()))' "${clipFile}" >> "${clipLog}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(clipDir, "pbpaste"), `#!/bin/sh\ncat "${clipFile}"\n`, { mode: 0o755 });
  Object.assign(env, { HOME: userHome, STUB_TEMP_ROOT: fs.realpathSync(os.tmpdir()), RELAY_TEST_SYSTEM_TOOLS: clipDir }, extraEnv, { RELAY_HOME: home, RELAY_DEV_MODEL_STUB: "1", STUB_DIR: stub, STUB_SCENARIO: path.join(tmp, "scenario.json") });
  scratchEnv(env);

  const clients: Client[] = [];
  const connect = async (o: InstanceOpts) => {
    // Instance-specific stub controls need the same explicit fixture passes as extraEnv. Never
    // pass arbitrary instance variables: endpoint and credential tests must keep real guards.
    const controls = Object.keys(o.env ?? {}).filter((name) => name.startsWith("STUB_"));
    if (controls.length) {
      const file = path.join(home, "config.json"), cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      cfg.child_env ??= {};
      cfg.child_env.pass = [...new Set([...(cfg.child_env.pass ?? []), ...controls])];
      fs.writeFileSync(file, JSON.stringify(cfg));
    }
    // With `elicit`, the client behaves like a host that can put relay's questions to the user.
    const client = new Client(o.clientInfo ?? { name: o.args?.includes("--host") ? (o.args[o.args.indexOf("--host") + 1] === "claude" ? "claude-code" : "codex-mcp-client") : "test", version: "0" }, { capabilities: { ...(o.elicit ? { elicitation: {} } : {}), ...(o.desktopUi ? { extensions: { "io.modelcontextprotocol/ui": {} } } : {}) } });
    if (o.elicit) {
      // Withdrawn questions are tracked here: the SDK's client ignores a cancellation of request id 0, the first a server sends.
      const open = new Map<string | number, AbortController>();
      client.setNotificationHandler(CancelledNotificationSchema, (n) => open.get(n.params.requestId!)?.abort());
      client.setRequestHandler(ElicitRequestSchema, async (req, extra) => {
        const ctl = new AbortController();
        open.set(extra.requestId, ctl);
        try {
          return (await o.elicit!(req.params.message, ctl.signal, req.params as Rec)) as never;
        } finally {
          open.delete(extra.requestId);
        }
      });
    }
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [o.cli ?? CLI, "mcp", ...(o.args ?? [])], env: scratchEnv({ ...env, ...(o.env ?? {}) }), cwd: o.cwd ?? repo }));
    clients.push(client);
    const call = async (tool: string, args: Record<string, unknown> = {}, opts: CallOpts = {}) => {
      const { meta, ...request } = opts;
      const res = (await client.callTool({ name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, { timeout: 120000, ...request })) as Rec;
      if (res.isError) return { tool_error: res.content[0].text } as Rec;
      return JSON.parse(res.content[0].text) as Rec;
    };
    const tools = async () => (await client.listTools()).tools.map((t) => t.name).sort();
    return { call, tools, toolDefinitions: async () => (await client.listTools()).tools, close: () => client.close() };
  };
  const sql = (query: string, ...params: unknown[]) => {
    const d = new DatabaseSync(path.join(home, "relay.db"));
    d.exec("PRAGMA busy_timeout = 10000;");
    try {
      return d.prepare(query).all(...(params as never[])) as Rec[];
    } finally {
      d.close();
    }
  };

  /**
   * A root session whose host is chosen per call. Relay refuses to reach anything from a root
   * session whose host it cannot tell, and refuses a target of the caller's own family, so the
   * tests' sessions declare a host, as an installed relay does. One session per host is opened as
   * needed: a call naming a target goes to a host of another family; a call naming existing items
   * goes to the session whose run they are in; anything else goes to the host used last.
   */
  const routed = async (o: InstanceOpts) => {
    const sessions = new Map<Target, Awaited<ReturnType<typeof connect>>>();
    const runHost = new Map<string, Target>();
    let last: Target = hostFor(STUB_TARGETS[0]);
    const session = async (host: Target) => {
      if (!sessions.has(host)) sessions.set(host, await connect({ ...o, args: [...(o.args ?? []), "--host", host] }));
      return sessions.get(host)!;
    };
    /** The run an item is in, and the target of the agent it concerns. */
    const whereIs = (id: string): { run?: string; target?: string } => {
      try {
        if (id.startsWith("run_")) return { run: id };
        const row = sql("SELECT run_id, target FROM nodes WHERE id = ?", id)[0]
          ?? sql("SELECT r.run_id, n.target FROM requests r JOIN nodes n ON n.id = r.node_id WHERE r.id = ?", id)[0];
        return { run: row?.run_id, target: row?.target ?? undefined };
      } catch {
        return {}; // No registry yet.
      }
    };
    const ids = (v: unknown, out: string[] = []): string[] => {
      if (typeof v === "string" && /^(run|[jtpdrq])_[0-9a-f]{8}$/.test(v)) out.push(v);
      else if (v && typeof v === "object") for (const x of Object.values(v)) ids(x, out);
      return out;
    };
    const call = async (tool: string, args: Record<string, unknown> = {}, opts: CallOpts = {}) => {
      const named = ["thread_id", "job_id", "id", "discussion_id", "review_id", "with", "request_id"].map((k) => args[k]).filter((v): v is string => typeof v === "string");
      // The session whose run it is; for a run no session of this instance has used yet, a host that may reach its agent.
      const found = named.map(whereIs);
      const owner = found.map((f) => (f.run ? runHost.get(f.run) : undefined)).find(Boolean)
        ?? found.map((f) => (f.target && STUB_TARGETS.includes(f.target as Target) ? hostFor(f.target) : undefined)).find(Boolean);
      // review's target is what to review; its agent is the reviewer.
      const wanted = (tool === "review" ? args.reviewer : args.target) as string | undefined;
      const host = owner ?? (wanted && STUB_TARGETS.includes(wanted as Target) ? hostFor(wanted) : last);
      last = host;
      const res = await (await session(host)).call(tool, args, opts);
      for (const id of ids(res)) {
        const run = whereIs(id).run;
        if (run && !runHost.has(run)) runHost.set(run, host);
      }
      return res;
    };
    return {
      call,
      tools: async () => (await session(last)).tools(),
      toolDefinitions: async () => (await session(last)).toolDefinitions(),
      close: async () => {
        for (const s of sessions.values()) await s.close();
      },
    };
  };
  const instance = (o: InstanceOpts) => {
    // childOf is asynchronous: given its promise, the instance would quietly be a root session.
    if (typeof (o as { then?: unknown }).then === "function") throw new Error("instance() was given a promise: await childOf first");
    return o.host === null ? connect(o) : o.args?.includes("--context") || o.args?.includes("--host") ? connect(o) : routed(o);
  };
  const root = await routed({});

  const log = () => fs.readFileSync(path.join(stub, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
  const environmentSocket = (nodeId: string): string | undefined => {
    const node = sql("SELECT run_id FROM nodes WHERE id = ?", nodeId)[0];
    const file = path.join(home, "runs", node.run_id, "nodes", nodeId, "claude-mcp.json");
    const claudeArgs: string[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).mcpServers?.relay?.args ?? [] : [];
    // Codex's launcher is in its actual -c flags, rather than a file. Both use env -i.
    const codexArgs: string[] | undefined = log().filter((r) => r.event === "start").flatMap((r) => r.argv ?? [])
      .filter((arg: string) => arg.startsWith("mcp_servers.relay.args="))
      .map((arg: string) => JSON.parse(arg.slice("mcp_servers.relay.args=".length)))
      .findLast((args: string[]) => args.includes(`RELAY_NODE_ID=${nodeId}`));
    const args = codexArgs ?? claudeArgs;
    return args.find((arg) => arg.startsWith("RELAY_ENV_SOCKET="))?.slice("RELAY_ENV_SOCKET=".length);
  };
  const servers: net.Server[] = [];
  let inboxes = 0;
  const inbox = async () => {
    const socket = path.join(tmp, `inbox-${++inboxes}.sock`);
    const posts: { token?: string; text: string }[] = [];
    const server = net.createServer((c) => {
      let buf = "";
      c.on("data", (d) => (buf += d.toString("utf8")));
      c.on("end", () => {
        const lines = buf.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
        posts.push({ token: lines.find((l) => l.type === "auth")?.token, text: lines.find((l) => l.type === "user")?.message?.content });
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
    servers.push(server);
    return { env: { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: `token-${inboxes}` }, posts: () => posts };
  };
  return {
    home, repo, env,
    clipboard: () => ({
      held: fs.readFileSync(clipFile, "utf8"),
      copies: fs.existsSync(clipLog) ? fs.readFileSync(clipLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string) : [],
      failCopies: (fail: boolean) => { if (fail) fs.writeFileSync(clipFail, ""); else fs.rmSync(clipFail, { force: true }); },
    }),
    call: root.call,
    instance,
    log,
    starts: () => log().filter((r) => r.event === "start"),
    ends: () => log().filter((r) => r.event === "end"),
    environmentSocket,
    sql,
    childOf: async (nodeId, policy = {}) => {
      await until(() => {
        const pid = sql("SELECT worker_pid FROM nodes WHERE id = ?", nodeId)[0]?.worker_pid;
        return !(pid > 0 && alive(pid));
      }, undefined, `the worker of ${nodeId} to be gone`);
      const d = new DatabaseSync(path.join(home, "relay.db"));
      d.exec("PRAGMA busy_timeout = 10000;");
      const node = d.prepare("SELECT run_id, depth, params_json FROM nodes WHERE id = ?").get(nodeId) as Rec;
      const turnId = Number(d.prepare("INSERT INTO turns (node_id, source, body, access, status, created_at, grant_json) VALUES (?, 'test', '', ?, ?, ?, ?)")
        .run(nodeId, policy.access ?? "write", policy.running === false ? "done" : "running", Date.now(), JSON.stringify(JSON.parse(node.params_json).grant ?? {})).lastInsertRowid);
      // A turn in progress means a session in progress.
      if (policy.running !== false) d.prepare("UPDATE nodes SET status = 'running', ended_at = NULL WHERE id = ?").run(nodeId);
      d.close();
      const file = path.join(home, `ctx-${nodeId}-${turnId}.json`);
      fs.writeFileSync(file, JSON.stringify({
        run_id: node.run_id, node_id: nodeId, depth: node.depth, turn_id: turnId,
        access: policy.access ?? "write", may_delegate: policy.may_delegate ?? true, may_ask: policy.may_ask ?? false,
      }));
      const socket = environmentSocket(nodeId);
      return { args: ["--context", file], env: { RELAY_RUN_ID: node.run_id, RELAY_NODE_ID: nodeId, RELAY_DEPTH: String(node.depth), RELAY_INJECTED: "1", ...(socket ? { RELAY_ENV_SOCKET: socket } : {}) }, turnId };
    },
    cli: (...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...env, TMPDIR: extraEnv.TMPDIR ?? cliTmp }, cwd: repo, encoding: "utf8" }).stdout,
    cliEnv: (extra, ...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...env, TMPDIR: extraEnv.TMPDIR ?? cliTmp, ...extra }, cwd: repo, encoding: "utf8" }).stdout,
    mark: (name) => fs.writeFileSync(path.join(stub, `mark-${name}`), String(Date.now())),
    marked: (name) => fs.existsSync(path.join(stub, `mark-${name}`)),
    inbox,
    close: async () => {
      for (const c of clients) await c.close().catch(() => {});
      fs.rmSync(clipDir, { recursive: true, force: true });
      for (const s of servers) s.close();
      modelStub.close();
      // Leave nothing running if a test failed part-way.
      try {
        const d = new DatabaseSync(path.join(home, "relay.db"));
        d.exec("PRAGMA busy_timeout = 10000;");
        const rows = d.prepare("SELECT worker_pid, agent_pgid FROM nodes").all() as Rec[];
        d.close();
        for (const r of rows) {
          if (r.agent_pgid) killGroup(r.agent_pgid);
          if (r.worker_pid > 0) try { process.kill(r.worker_pid, "SIGKILL"); } catch {}
        }
      } catch {}
      killOrphans(stub);
      removeTestNativeTempAlias(userHome, extraEnv.STUB_LINK_PARENT);
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(userHome, { recursive: true, force: true });
      fs.rmSync(cliTmp, { recursive: true, force: true });
    },
  };
}
