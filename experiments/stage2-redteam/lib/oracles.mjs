// Oracles the probes share: process-tree walks (survivor checks), a passive look at relay's reserved
// range, and best-effort scans for the executor token and for marker files outside the roots.
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const RELAY_RANGE = [47200, 47263];

/** Read a node row from MY scratch registry: its params_json (codex_confinement) and worktree. */
export function readNode(relayHome, nodeId) {
  const d = new DatabaseSync(path.join(relayHome, "relay.db"));
  try {
    const row = d.prepare("SELECT id, cwd, worktree, params_json, status FROM nodes WHERE id = ?").get(nodeId);
    if (!row) return null;
    let params = {};
    try { params = JSON.parse(row.params_json ?? "{}"); } catch { /* keep {} */ }
    return { ...row, params };
  } finally {
    d.close();
  }
}

/** True if dir is the top of a git worktree right now. */
export function isGitWorktree(dir) {
  if (!dir) return false;
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return r.status === 0 && /true/.test(r.stdout);
}

/** A file's size, or null when it is not there. */
export const fileSize = (file) => { try { return file ? fs.statSync(file).size : null; } catch { return null; } };

/**
 * Whether a file a probe's process kept writing stopped growing after teardown, from two sizes read
 * apart. Only a file that was written counts (the writer ran: the positive control); a missing or
 * empty one, 0 = 0, shows nothing and does not pass.
 */
export const frozenAfter = (size1, size2) => Number.isInteger(size1) && size1 > 0 && size1 === size2;

/**
 * The positive control for a turn's refused nc connects, reach-denied-port's: the job binds its own
 * block port ($PORT, which it may use) and connects to it with the same nc, printing self_block=<rc>.
 * Run it in the same command as the connects it vouches for. The listener lives until the turn
 * ends; its stdio goes to /dev/null so the exec does not wait on its open output until Codex yields.
 */
export const NC_SELF_CONTROL = [
  `/usr/bin/perl -MIO::Socket::INET -e 'my $s=IO::Socket::INET->new(LocalAddr=>"127.0.0.1",LocalPort=>$ENV{PORT},Listen=>5,ReuseAddr=>1) or exit 9; fork and exit 0; while(my $c=$s->accept){close $c}' >/dev/null 2>&1 </dev/null &`,
  "sleep 0.4",
  `/usr/bin/nc -z -G1 -w1 127.0.0.1 $PORT >/dev/null 2>&1; echo "self_block=$?"`,
];

/**
 * Whether `out` shows the nc connect it printed as `<tag>=<rc>` refused (rc not 0) beside a working
 * control (self_block=0, NC_SELF_CONTROL): without the control, a non-zero code may only mean that
 * nc never ran.
 */
export function refusedBesideControl(out, tag) {
  const rc = (t) => new RegExp(`\\b${t}=(\\d+)`).exec(out ?? "")?.[1];
  return rc("self_block") === "0" && rc(tag) !== undefined && rc(tag) !== "0";
}

/** True once pid is gone. */
export const gone = (pid) => {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; }
};

/**
 * The whole process table as {pid, ppid, command}. Throws when ps fails or lists nothing: an empty
 * table would pass every survivor check that reads it.
 */
export function psTable() {
  const r = spawnSync("/bin/ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error(`ps failed (${r.error?.message ?? `exit ${r.status}`}): the process table cannot be read, so no survivor check can pass`);
  const table = (r.stdout || "").split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+([\s\S]*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  if (!table.length) throw new Error("ps listed no processes: the process table cannot be read, so no survivor check can pass");
  return table;
}

/** Every descendant pid of root (inclusive), by the current process table. */
export function descendants(rootPid) {
  const table = psTable();
  const byParent = new Map();
  for (const p of table) { if (!byParent.has(p.ppid)) byParent.set(p.ppid, []); byParent.get(p.ppid).push(p); }
  const seen = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    for (const c of byParent.get(pid) ?? []) { seen.push(c); stack.push(c.pid); }
  }
  return seen;
}

/** Processes anywhere that look like a Codex control plane (exec-server / app-server / code-mode). */
export function codexProcesses() {
  return psTable().filter((p) => /\bcodex\b/i.test(p.command) && /(exec-server|app-server|--listen ws:\/\/127\.0\.0\.1:|code-mode-host)/.test(p.command));
}

/**
 * The Codex control-plane processes that are MY run's, discriminated by MY unique scratch root path
 * appearing in the process's argv+environment (ps eww). The executor's CODEX_HOME/TMPDIR and the app
 * server's CODEX_HOME both live under the scratch root, so this reliably includes mine (even when the
 * executor is spawned detached) and reliably excludes sibling stage-2 agents and the user's own
 * ChatGPT.app Codex (different roots) — which are therefore never flagged as survivors or touched.
 */
export function myCodexProcesses(scratchRoot) {
  return codexProcesses().filter((p) => psEnv(p.pid).includes(scratchRoot));
}

/** My run's executor (exec-server), scoped by scratch root. */
export function findExecutorByScratch(scratchRoot) {
  const p = myCodexProcesses(scratchRoot).find((q) => /exec-server --listen ws:\/\/127\.0\.0\.1:\d+/.test(q.command));
  if (!p) return null;
  const e = psEnv(p.pid);
  return {
    pid: p.pid,
    sha: /--ws-token-sha256 ([0-9a-f]{64})/.exec(e)?.[1] ?? null,
    port: Number(/--listen ws:\/\/127\.0\.0\.1:(\d+)/.exec(e)?.[1] ?? 0),
    command: p.command,
  };
}

/** My run's app server pid, scoped by scratch root. */
export function findAppServerByScratch(scratchRoot) {
  return myCodexProcesses(scratchRoot).find((q) => /app-server/.test(q.command))?.pid ?? 0;
}

/** The executor pid and the sha256 in its argv, or null. */
export function findExecutor() {
  const p = psTable().find((q) => /exec-server --listen ws:\/\/127\.0\.0\.1:\d+/.test(q.command));
  if (!p) return null;
  const sha = /--ws-token-sha256 ([0-9a-f]{64})/.exec(p.command)?.[1] ?? null;
  const port = Number(/--listen ws:\/\/127\.0\.0\.1:(\d+)/.exec(p.command)?.[1] ?? 0);
  return { pid: p.pid, sha, port, command: p.command };
}

/** Passive look (lsof, no connect) at what is listening in relay's reserved range. Never a scan/probe. */
export function listeningInRelayRange() {
  const r = spawnSync("/usr/bin/lsof", ["-nP", `-iTCP:${RELAY_RANGE[0]}-${RELAY_RANGE[1]}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return (r.stdout || "").trim();
}

/** `ps eww` for a pid (argv + environment), for token/leak inspection. */
export const psEnv = (pid) => spawnSync("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout || "";

/**
 * Best-effort scan for executor-token leakage across a set of directories, plus given argv/env
 * strings. We do not hold relay's in-memory raw token, so we flag: any `authBearerToken`, any
 * `Bearer <long>`, and any 64-hex string that is NOT the known executor sha (the sha legitimately
 * appears in the executor's own argv). Hits are returned for manual review; [] is clean.
 * The strong, token-aware oracle lives in WP-C's in-process live test (redaction knows the token).
 */
// Trusted fixture assets now include a staged native binary and the copied distribution. Their
// source contains protocol names and public digests, not a turn's future memory-only token.
// Ignore only bytes snapshotted BEFORE launch; changed/missing assets remain a failing oracle.
export function snapshotFixtureAssets(roots) {
  const baseline = new Map();
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.isFile()) baseline.set(file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    }
  };
  for (const root of roots) walk(root);
  return baseline;
}

export function tokenLeakHits({ dirs = [], extraText = [], knownSha = null, baseline = new Map() }) {
  const hits = [];
  const bearer = /Bearer\s+[A-Za-z0-9+/=_-]{16,}/g;
  const hex64 = /\b[0-9a-f]{64}\b/g;
  const scan = (label, text) => {
    if (!text) return;
    if (/authBearerToken/.test(text)) hits.push({ label, why: "authBearerToken literal" });
    for (const m of text.match(bearer) ?? []) hits.push({ label, why: `bearer-like: ${m.slice(0, 24)}…` });
    // A person-path heartbeat is named by the one-way root-token identity it also contains. Exempt
    // only that self-identifying value: a JSON file directly in person-paths whose 64-hex stem is
    // the matched value. Other digests in the same file, nested files and bearer-like strings still
    // hit the oracle.
    const ownPersonPathIdentity = path.basename(path.dirname(label)) === "person-paths"
      && /^[0-9a-f]{64}\.json$/.test(path.basename(label)) ? path.basename(label, ".json") : null;
    // relay.db's session params record the policy's public digest under exactly this key.
    const neverPolicyHash = (m) => path.basename(label) === "relay.db" && text.includes(`"never_policy":{"hash":"${m}"`);
    for (const m of text.match(hex64) ?? []) if (m !== knownSha && m !== ownPersonPathIdentity && !neverPolicyHash(m)) hits.push({ label, why: `64-hex (not the known sha): ${m.slice(0, 12)}…` });
  };
  for (const t of extraText) scan("argv/env", t);
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try {
        const bytes = fs.readFileSync(p);
        if (baseline.has(p)) {
          if (crypto.createHash("sha256").update(bytes).digest("hex") === baseline.get(p)) continue;
          hits.push({ label: p, why: "trusted fixture asset changed after launch" });
        }
        scan(p, bytes.toString("latin1"));
      } catch { /* raced/gone */ } }
    }
  };
  for (const d of dirs) walk(d);
  for (const file of baseline.keys()) if (!fs.existsSync(file)) hits.push({ label: file, why: "trusted fixture asset removed after launch" });
  return hits;
}

/** Kill a pid, waiting briefly. Only used to clean up a survivor a probe detects. */
export function killNow(pid) {
  try { execFileSync("/bin/kill", ["-9", String(pid)]); } catch { /* already gone */ }
}
