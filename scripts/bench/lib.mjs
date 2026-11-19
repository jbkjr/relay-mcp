// The benchmark's plumbing: an isolated relay per trial (its own control directory, HOME, config,
// TMPDIR and repository, with the stub agents as its targets), a minimal MCP client over stdio,
// registry seeding, and the cleanup that makes sure nothing a trial started outlives it. Plain
// Node, no dependencies: relay's MCP SDK is not used on the client side, so that what is timed is
// relay's work (request written -> response fully read), not a client library's.
//
// Isolation follows test/helpers.ts harness(): nothing of the session running the bench reaches
// relay (RELAY_*, host-identity and endpoint variables, home-like variables are dropped), HOME is a
// scratch directory, and the worker's daily housekeeping is marked done, so that no trial sweeps a
// shared temporary directory. The real control directory, config and agent CLIs are never used.
//
// The relay under test is a checkout directory (`relayAt`): its dist/ and bin/relay. The stubs and
// fixtures always come from this script's own checkout, so that two builds can be compared on
// exactly the same agents and repositories (run.mjs --ab).
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

/** This checkout: the stubs and fixtures the bench uses, whichever relay it drives. */
export const HARNESS_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const STUBS = path.join(HARNESS_ROOT, "test", "stubs");
const PS = "/bin/ps";

/** A relay build to drive: a checkout with dist/ built. */
export function relayAt(root) {
  const r = fs.realpathSync(root);
  const cli = path.join(r, "dist", "cli.js");
  if (!fs.existsSync(cli)) throw new Error(`no relay build at ${r} (dist/cli.js is missing: run npm run build there)`);
  let commit = null;
  try { commit = JSON.parse(fs.readFileSync(path.join(r, "dist", "build-info.json"), "utf8")).commit ?? null; } catch {}
  return { root: r, cli, launcher: path.join(r, "bin", "relay"), commit };
}

/** The bench's own temporary root: TMPDIR, which must be short (a Unix socket's path may not exceed 103 bytes). */
export function benchTmp() {
  const t = process.env.TMPDIR;
  if (!t || /^\/var\/folders\//.test(t) || t.length > 40) {
    throw new Error(`TMPDIR must be a short directory (e.g. TMPDIR=/tmp/rwk-bench); got ${JSON.stringify(t)}. macOS's /var/folders/... is too long for relay's sockets.`);
  }
  fs.mkdirSync(t, { recursive: true });
  return fs.realpathSync(t);
}

const HOME_VARS = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME", "GROK_HOME", "GROK_AUTH_PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "RELAY_HOME", "RELAY_WORKTREES", "RELAY_CONFIG"];
// As test/host-env.ts hostVar, with the targets' endpoint variables (src/targets/*: endpointEnv).
const hostVar = (k) => k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("CLAUDE_AGENT_SDK_") || k === "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"
  || /^ANTHROPIC_(\w+_)?BASE_URL$/.test(k) || k === "OPENAI_BASE_URL" || /^ANTHROPIC_(MODEL|DEFAULT_(OPUS|SONNET|HAIKU)_MODEL)$/.test(k)
  || /^(CODE_ASSIST_ENDPOINT|CODE_ASSIST_API_VERSION|GOOGLE_GEMINI_BASE_URL|GOOGLE_VERTEX_BASE_URL|GOOGLE_GENAI_API_VERSION|GCE_METADATA_(HOST|IP))$/.test(k);

/** The absolute path of a program on PATH (the bench, like relay, runs nothing by a bare name). */
export function which(name) {
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(d)) continue;
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  throw new Error(`${name} not found on PATH`);
}
const GIT = which("git");

/** Runs git in `cwd` with a scratch HOME, no hooks, signing or system config, at a fixed date; returns stdout. */
export function git(home, cwd, ...args) {
  const r = spawnSync(GIT, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", maxBuffer: 64 << 20,
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z", LC_ALL: "C" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

let sandboxes = 0;
const live = new Set();

/**
 * A fresh, isolated relay for one trial. `rules` is the stub scenario; `config` is merged into
 * relay's config.json (targets point at the stubs); `stubEnv` adds STUB_* controls (passed to the
 * agents through child_env). Returns paths and the environment every relay process gets.
 */
export function sandbox(relay, { rules = [], config = {}, stubEnv = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(benchTmp(), `rb${++sandboxes % 100}-`)));
  live.add(dir);
  const sb = {
    dir, relay, clients: [],
    home: path.join(dir, "h"), // RELAY_HOME; worktrees go beside it, in h-worktrees
    userHome: path.join(dir, "u"), // HOME
    stub: path.join(dir, "s"), // STUB_DIR
    repo: path.join(dir, "r"),
    tmp: path.join(dir, "t"), // TMPDIR for every process of the trial
    scenario: path.join(dir, "scenario.json"),
    procs: [],
  };
  for (const d of [sb.home, sb.userHome, sb.stub, sb.repo, sb.tmp]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(sb.stub, "log.jsonl"), "");
  setRules(sb, rules);
  const stubControls = ["STUB_DIR", "STUB_SCENARIO", "STUB_TEMP_ROOT", "STUB_LINGER_MS", ...Object.keys(stubEnv)];
  fs.writeFileSync(path.join(sb.home, "config.json"), JSON.stringify({
    // The control directory lives under the temporary directory, which production refuses.
    allow_temp_home: true,
    ...config,
    targets: {
      codex: { bin: path.join(STUBS, "stub-codex"), pinned: false },
      claude: { bin: path.join(STUBS, "stub-claude") },
      ...(config.targets ?? {}),
    },
    child_env: { ...(config.child_env ?? {}), pass: [...new Set([...stubControls, ...((config.child_env?.pass) ?? [])])] },
  }));
  // Daily housekeeping is done (as in the tests): a trial must not sweep the shared temp directory,
  // and a fresh control directory would otherwise pay that once-a-day cost on every trial.
  fs.writeFileSync(path.join(sb.home, "housekeeping"), "marked done by the benchmark\n");
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("RELAY_") && !k.startsWith("STUB_") && !hostVar(k) && !HOME_VARS.includes(k)) env[k] = v;
  delete env.NODE_OPTIONS;
  // The bench's Node first on PATH, so that bin/relay's own lookup finds it.
  const nodeDir = path.dirname(process.execPath);
  env.PATH = [nodeDir, ...(process.env.PATH ?? "").split(path.delimiter).filter((d) => d && d !== nodeDir)].join(path.delimiter);
  Object.assign(env, {
    HOME: sb.userHome, TMPDIR: sb.tmp, RELAY_HOME: sb.home,
    STUB_DIR: sb.stub, STUB_SCENARIO: sb.scenario, STUB_TEMP_ROOT: sb.tmp,
    // The stub agents' shutdown linger (test/stubs/stub-agent.mjs) is the stub's, not relay's.
    STUB_LINGER_MS: "0",
    ...stubEnv,
  });
  sb.env = env;
  return sb;
}

/** Replaces the stub scenario (read by each agent process as it starts a turn). */
export function setRules(sb, rules) {
  fs.writeFileSync(sb.scenario, JSON.stringify({ rules }));
}

/** A one-commit repository (README), as the tests' harness makes. */
export function smallRepo(sb) {
  git(sb.userHome, sb.repo, "init", "-q", "-b", "main");
  git(sb.userHome, sb.repo, "config", "user.name", "bench");
  git(sb.userHome, sb.repo, "config", "user.email", "bench@example.invalid");
  fs.writeFileSync(path.join(sb.repo, "README.md"), "sample\n");
  git(sb.userHome, sb.repo, "add", "-A");
  git(sb.userHome, sb.repo, "commit", "-q", "-m", "init");
}

export const LARGE_REPO = { files: 3000, commits: 20 };

/**
 * A repository of realistic size, the same every time (a fixed generator): LARGE_REPO.files files
 * of 20-80 lines across 7 x 41 directories, LARGE_REPO.commits commits of history (40 files changed
 * per commit), packed. Built once into a template under the bench's temp root, then copied (clonefile) into
 * each trial.
 */
export function largeRepo(sb) {
  const { files, commits } = LARGE_REPO;
  const tpl = path.join(benchTmp(), `repo-tpl-v2-${files}-${commits}`);
  if (!fs.existsSync(path.join(tpl, ".done"))) {
    fs.rmSync(tpl, { recursive: true, force: true });
    const work = path.join(tpl, "w");
    fs.mkdirSync(work, { recursive: true });
    const home = path.join(tpl, "home");
    fs.mkdirSync(home, { recursive: true });
    git(home, work, "init", "-q", "-b", "main");
    git(home, work, "config", "user.name", "bench");
    git(home, work, "config", "user.email", "bench@example.invalid");
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const fileAt = (i) => path.join(work, "src", `m${i % 7}`, `d${i % 41}`, `f${i}.ts`);
    const body = (i, rev) => `// file ${i} rev ${rev}\n` + Array.from({ length: 20 + (i % 60) }, (_, l) => `export const v${l} = ${Math.floor(rand() * 1e6)}; // ${"x".repeat(i % 40)}`).join("\n") + "\n";
    for (let c = 0; c < commits; c++) {
      if (c === 0) {
        for (let i = 0; i < files; i++) { fs.mkdirSync(path.dirname(fileAt(i)), { recursive: true }); fs.writeFileSync(fileAt(i), body(i, 0)); }
        fs.writeFileSync(path.join(work, "README.md"), "large sample\n");
        fs.writeFileSync(path.join(work, ".gitignore"), "node_modules/\n");
      } else for (let k = 0; k < 40; k++) { const i = Math.floor(rand() * files); fs.writeFileSync(fileAt(i), body(i, c)); }
      git(home, work, "add", "-A");
      git(home, work, "commit", "-q", "-m", `commit ${c}`);
    }
    // Packed, as a cloned repository is.
    git(home, work, "repack", "-a", "-d", "-q");
    git(home, work, "prune");
    fs.writeFileSync(path.join(tpl, ".done"), "");
  }
  fs.rmSync(sb.repo, { recursive: true, force: true });
  // A copy-on-write clone of the whole checkout (APFS clonefile): every file is its own inode, as in a real clone.
  const r = spawnSync("/bin/cp", ["-c", "-R", path.join(tpl, "w"), sb.repo], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`copying the template repository failed: ${r.stderr}`);
  // New inodes: refresh the index's stat data now, as a real checkout's index already is, so that
  // relay's first git command does not pay for rehashing every file.
  spawnSync(GIT, ["update-index", "-q", "--refresh"], { cwd: sb.repo, env: { PATH: process.env.PATH, HOME: sb.userHome, GIT_CONFIG_NOSYSTEM: "1" } });
}

/** The clientInfo and environment a root session's server sees from each host, as installed relay is registered (--host). */
export const HOSTS = {
  // Interactive Claude Code in a terminal (test/helpers.ts INTERACTIVE_CLAUDE), at the version the stubs emulate.
  claude: { args: ["--host", "claude"], clientInfo: { name: "claude-code", version: "2.1.302" }, env: { CLAUDE_CODE_ENTRYPOINT: "cli" } },
  codex: { args: ["--host", "codex"], clientInfo: { name: "codex-mcp-client", version: "0.167.1" }, env: {} },
};

/**
 * The command that starts a root server with an ancestry the bench owns. A root server reads the
 * command lines of the three processes above it (src/core/procs.ts ancestorCommandLines(3)) and,
 * for a Claude Code client, reads any `--settings` it finds there with plutil. Started straight
 * from the bench, those would be the bench, its shell and whatever started that (an agent's own
 * Claude Code, say), so the cost would depend on where the bench was run from. Two /bin/sh levels
 * (neither execs: each runs the next and then exits with its status) make all three the bench's.
 */
const owned = (argv) => ["/bin/sh", "-c", `/bin/sh -c '"$0" "$@"; exit $?' "$0" "$@"; exit $?`, ...argv];

/** The pid of the process two levels below `pid` (the server under the two shells of `owned`), or null. */
function grandchild(pid) {
  const rows = spawnSync(PS, ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 16 << 20 }).stdout.split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const child = rows.find((r) => r[1] === pid)?.[0];
  return child ? rows.find((r) => r[1] === child)?.[0] ?? null : null;
}

/**
 * Starts `relay mcp` for a root session of `host` and returns a minimal JSON-RPC client.
 * `launcher`: start it through bin/relay, as hosts do (the installer registers that file).
 * `prefix`: a command that execs the rest (/usr/sbin/taskpolicy, for the idle cell).
 */
export function mcp(sb, { host = "claude", launcher = true, extraEnv = {}, cwd, prefix = [] } = {}) {
  const h = HOSTS[host];
  const argv = owned([...prefix, ...(launcher ? [sb.relay.launcher, "mcp", ...h.args] : [process.execPath, sb.relay.cli, "mcp", ...h.args])]);
  const child = spawn(argv[0], argv.slice(1), { cwd: cwd ?? sb.repo, env: { ...sb.env, ...h.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  sb.procs.push(child);
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 1 << 20) stderr = stderr.slice(-(1 << 19)); });
  const pending = new Map();
  let nextId = 1;
  let exited = null;
  const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  child.on("exit", (code, sig) => { exited = { code, sig }; failAll(new Error(`relay mcp exited (${code ?? sig}) with requests pending\n--- relay mcp stderr ---\n${stderr}`)); });
  child.on("error", (e) => failAll(e));
  child.stdin.on("error", () => {});
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method === undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method} failed: ${JSON.stringify(m.error)}\n--- relay mcp stderr ---\n${stderr}`));
      else p.resolve(m.result);
    } else if (m.id !== undefined && m.method) {
      // A request from the server (elicitation, roots): this client offers none of them.
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported by the benchmark client" } });
    }
  });
  const request = (method, params = {}, timeoutMs = 120_000) => new Promise((resolve, reject) => {
    if (exited) return reject(new Error(`relay mcp already exited (${exited.code ?? exited.sig})\n--- relay mcp stderr ---\n${stderr}`));
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms\n--- relay mcp stderr ---\n${stderr}`)); }, timeoutMs);
    pending.set(id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    send({ jsonrpc: "2.0", id, method, params });
  });
  let serverPid = null;
  const client = {
    child, get stderr() { return stderr; },
    /** The relay server's own pid (below the two shells), once it has answered initialize. */
    get pid() { return serverPid; },
    request,
    async initialize() {
      const r = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: h.clientInfo });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      // A root server starts its 1 s watch loop on this notification (src/mcp/server.ts): its ticks
      // fall near initializedAt + k * 1000 ms, which the notice cell aligns its phases to.
      client.initializedAt = Date.now();
      return r;
    },
    /** Finds the server's pid (outside any timed span: a ps of the whole table). */
    resolvePid() {
      serverPid = grandchild(child.pid);
      if (!serverPid) throw new Error(`could not find the relay server under its launch shells (pid ${child.pid})`);
      return serverPid;
    },
    /** Calls a relay tool and returns its parsed JSON reply; a tool error fails the trial. */
    async call(tool, args = {}, { timeoutMs = 120_000 } = {}) {
      const r = await request("tools/call", { name: tool, arguments: args }, timeoutMs);
      const text = r?.content?.[0]?.text ?? "";
      if (r.isError) throw new Error(`${tool} returned a tool error: ${text}`);
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`${tool} replied with something other than JSON: ${text.slice(0, 500)}`); }
      if (json && typeof json === "object" && (json.error || json.refused)) throw new Error(`${tool} was refused: ${text.slice(0, 2000)}`);
      return json;
    },
    async close() {
      if (exited) return;
      const gone = new Promise((r) => child.once("exit", r));
      child.stdin.end();
      const t = setTimeout(() => { for (const p of [serverPid, child.pid]) if (p) try { process.kill(p, "SIGKILL"); } catch {} }, 3000);
      await gone;
      clearTimeout(t);
    },
  };
  sb.clients.push(client);
  return client;
}

/** A root session started, initialized and with its tool list read: what a host has before its first call. */
export async function rootSession(sb, opts = {}) {
  const c = mcp(sb, opts);
  await c.initialize();
  await c.request("tools/list");
  c.resolvePid();
  return c;
}

/** Runs relay's CLI in the sandbox (through bin/relay unless launcher is false); returns its elapsed ms, failing on a non-zero exit. */
export function cli(sb, args, { launcher = true } = {}) {
  const argv = launcher ? [sb.relay.launcher, ...args] : [process.execPath, sb.relay.cli, ...args];
  const t0 = performance.now();
  const r = spawnSync(argv[0], argv.slice(1), { cwd: sb.repo, env: sb.env, encoding: "utf8", maxBuffer: 64 << 20 });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`relay ${args.join(" ")} exited ${r.status ?? r.signal}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  return { ms, stdout: r.stdout };
}

/** Live processes (other than this one) whose command line or environment names the sandbox. */
function sandboxPids(dir) {
  const r = spawnSync(PS, ["-axww", "-E", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
  const out = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.includes(dir)) continue;
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (pid > 1 && pid !== process.pid) out.push({ pid, line: line.trim().slice(0, 160) });
  }
  return out;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Opens the trial's registry (WAL: safe beside the live relay processes). */
export function registry(sb) {
  const d = new DatabaseSync(path.join(sb.home, "relay.db"));
  d.exec("PRAGMA busy_timeout = 10000;");
  return d;
}
export function sql(sb, query, ...params) {
  const d = registry(sb);
  try { return d.prepare(query).all(...params); } finally { d.close(); }
}

/** Polls `fn` every `everyMs` until true; fails after `ms` with `what`. */
export async function until(fn, what, ms = 60_000, everyMs = 5) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

/**
 * Brings the trial to rest between measured calls: no item queued or running, no worker owning a
 * session, no agent process group alive; then ends what is left of finished workers (a worker that
 * has let go of its session lingers about a second on an un-cancelled timer before it exits) so
 * that no leftover process competes with the next measurement. The root sessions are kept.
 */
export async function quiesce(sb, { ms = 60_000 } = {}) {
  await until(() => {
    let rows;
    try { rows = sql(sb, "SELECT status, worker_pid, agent_pgid FROM nodes"); } catch { return true; }
    return rows.every((r) => !["queued", "running"].includes(r.status) && !(r.worker_pid > 0 && alive(r.worker_pid)) && !(r.agent_pgid > 0 && groupAlive(r.agent_pgid)));
  }, "the trial's items to settle and their workers and agents to stop", ms, 10);
  const keep = new Set(sb.clients.map((c) => c.pid).filter(Boolean));
  for (const { pid } of sandboxPids(sb.dir)) if (!keep.has(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await until(() => sandboxPids(sb.dir).every((p) => keep.has(p.pid)), "killed leftovers to exit", 5000, 20);
}
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/**
 * Ends a trial: closes its clients, waits briefly for every process naming the sandbox to exit,
 * kills what is left, and removes the sandbox (unless `keep`). Returns what had to be killed.
 */
export async function closeSandbox(sb, { graceMs = 1500, keep = false } = {}) {
  for (const s of sb.servers ?? []) s.close();
  for (const c of sb.clients) await c.close().catch(() => {});
  for (const p of sb.procs) if (p.exitCode === null && p.signalCode === null) { try { p.kill("SIGKILL"); } catch {} }
  const end = Date.now() + graceMs;
  let left = sandboxPids(sb.dir);
  while (left.length && Date.now() < end) {
    await sleep(50);
    left = sandboxPids(sb.dir);
  }
  for (const { pid } of left) { try { process.kill(pid, "SIGKILL"); } catch {} }
  if (left.length) await until(() => sandboxPids(sb.dir).length === 0, "the sandbox's processes to exit after SIGKILL", 5000, 20);
  if (!keep) {
    for (let i = 0; ; i++) {
      try { fs.rmSync(sb.dir, { recursive: true, force: true }); break; } catch (e) { if (i >= 10) throw e; await sleep(100); }
    }
    live.delete(sb.dir);
  }
  return left;
}

/** What a failed trial left behind: the root servers' stderr and the tail of every log in the control directory. */
export function diagnostics(sb) {
  const out = [`sandbox kept for inspection: ${sb.dir}`];
  for (const c of sb.clients) out.push(`--- relay mcp (pid ${c.pid ?? "unresolved"}) stderr ---\n${c.stderr.slice(-4000)}`);
  const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); } catch { return []; } };
  for (const f of walk(sb.home).filter((f) => /\.(log)$/.test(f))) {
    const text = fs.readFileSync(f, "utf8");
    out.push(`--- ${path.relative(sb.dir, f)} (last 3000 bytes) ---\n${text.slice(-3000)}`);
  }
  try { out.push(`--- stub log (last 3000 bytes) ---\n${fs.readFileSync(path.join(sb.stub, "log.jsonl"), "utf8").slice(-3000)}`); } catch {}
  return out.join("\n");
}

/** On an interrupted run: kill whatever the live sandboxes started and remove them. */
export function emergencyCleanup() {
  for (const dir of live) {
    for (const { pid } of sandboxPids(dir)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  live.clear();
}

/**
 * A fake Claude Code inbox (CLAUDE_CODE_MESSAGING_SOCKET), as test/helpers.ts inbox(): each
 * connection is one notice; `posts` holds them with the time (Date.now) each arrived complete.
 */
export async function inbox(sb) {
  const socket = path.join(sb.dir, "in.sock");
  const posts = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => (buf += d.toString("utf8")));
    c.on("end", () => posts.push({ t: Date.now(), text: buf }));
    c.on("error", () => {});
  });
  await new Promise((r) => server.listen(socket, r));
  (sb.servers ??= []).push(server);
  return { env: { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: "bench-token" }, posts };
}

/**
 * Seeds the registry with copies of real rows, so that a large registry has exactly the shape
 * relay writes: `sources` are settled nodes relay created in this trial. Into `runId`, `nodes`
 * copies (round-robin over the sources), each with `turns` turns and its settled event (seen);
 * then `runs` extra runs of `nodesPerRun` copies each, owned by a session that has ended.
 * Ids are deterministic. Returns the ids made in runId.
 */
export function seed(sb, { runId, sources, nodes = 0, turns = 1, runs = 0, nodesPerRun = 0 }) {
  const d = registry(sb);
  try {
    const src = sources.map((id) => d.prepare("SELECT * FROM nodes WHERE id = ?").get(id));
    const srcTurn = new Map(sources.map((id) => [id, d.prepare("SELECT * FROM turns WHERE node_id = ? ORDER BY id LIMIT 1").get(id)]));
    const srcEvent = new Map(sources.map((id) => [id, d.prepare("SELECT * FROM events WHERE item_id = ? ORDER BY id LIMIT 1").get(id)]));
    const run = d.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    const insert = (table, row) => {
      const cols = Object.keys(row);
      d.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
    };
    const swap = (v, from, to) => (typeof v === "string" ? v.split(from).join(to) : v);
    const made = [];
    let counter = 0;
    const copyNode = (into, i, ageMs) => {
      const s = src[i % src.length];
      const id = `${s.id.slice(0, 2)}${crypto.createHash("sha256").update(`${into}:${counter++}`).digest("hex").slice(0, 8)}`;
      const row = {};
      for (const [k, v] of Object.entries(s)) row[k] = swap(swap(v, s.id, id), s.run_id, into);
      Object.assign(row, { id, run_id: into, task: `seeded ${counter}: ${s.task}`, worker_pid: null, worker_claimed_at: null, agent_pid: null, agent_pgid: null, created_at: s.created_at - ageMs, started_at: s.started_at - ageMs, ended_at: s.ended_at - ageMs });
      insert("nodes", row);
      const t0 = srcTurn.get(s.id);
      let lastTurn = null;
      for (let k = 0; k < turns; k++) {
        const { id: _drop, ...t } = t0;
        const tr = {};
        for (const [kk, v] of Object.entries(t)) tr[kk] = swap(v, s.id, id);
        Object.assign(tr, { node_id: id, created_at: t0.created_at - ageMs + k, started_at: t0.started_at - ageMs + k, ended_at: t0.ended_at - ageMs + k });
        insert("turns", tr);
        lastTurn = Number(d.prepare("SELECT last_insert_rowid() AS id").get().id);
      }
      const ev = srcEvent.get(s.id);
      if (ev) {
        const { id: _e, ...e } = ev;
        insert("events", { ...e, run_id: into, key: `settled:${id}:turn:${lastTurn}`, item_id: id, subject: id, text: swap(e.text, s.id, id), created_at: e.created_at - ageMs, noticed_at: null, seen_at: e.created_at - ageMs });
      }
      return id;
    };
    d.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < nodes; i++) made.push(copyNode(runId, i, (nodes - i) * 1000));
      for (let r = 0; r < runs; r++) {
        const id = `run_${crypto.createHash("sha256").update(`run:${r}`).digest("hex").slice(0, 8)}`;
        const age = (runs - r + 1) * 3_600_000;
        insert("runs", { ...run, id, created_at: run.created_at - age, root_pid: 1, root_start: "Thu Jan  1 00:00:00 2026", root_token: `seeded-ended-session-${r}` });
        for (let i = 0; i < nodesPerRun; i++) copyNode(id, i, age - i * 1000);
      }
      d.exec("COMMIT");
    } catch (e) { d.exec("ROLLBACK"); throw e; }
    return made;
  } finally {
    d.close();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();
