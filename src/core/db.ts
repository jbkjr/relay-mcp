import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { canonical, configPath, inside, relayHome, withDefaults, worktreesHome, type Mode, type RelayConfig, type Target } from "./config.js";
import { resolveNeverPolicy } from "./never-policy.js";
import { groupAlive, isGroupSignalRefusal, killGroupNow, pidAlive, processGone, procStart, sameProcess, type Proc } from "./procs.js";
import { queuedSpeeds, speedOf } from "./params.js";
import { executorRecords, nodeHasLiveExecutor, quarantineRecordedExecutor, stoppedNote, stopRecordedExecutorNow, stopNodeExecutorsNow } from "./stage2-executors.js";
import { overlayOwnerAlive, overlayTurnProblem, reapOverlays, reapLaunchReservations, stopNodeLaunchReservations } from "./restart-overlay.js";
import type { Speed } from "../targets/types.js";

export type NodeKind = "job" | "thread" | "participant" | "discussion" | "review";
/**
 * "open": a discussion or review that is waiting for its caller's next step. Nothing is running for it.
 * "blocked": the last turn finished, but the agent was refused something it tried (TurnResult.denials).
 * "refused": the vendor's safety system stopped the turn; its work is unfinished.
 */
export type NodeStatus = "queued" | "running" | "open" | "done" | "blocked" | "refused" | "failed" | "cancelled" | "timeout" | "lost";
export const ACTIVE: NodeStatus[] = ["queued", "running"];

export interface RunRow {
  id: string;
  created_at: number;
  /** The relay server process of the root session that owns the run, with a token only that instance knows. */
  root_pid: number | null;
  root_start: string | null;
  root_token: string | null;
  root_cwd: string;
  config_json: string;
  status: "active" | "cancelled";
}

export interface NodeRow {
  id: string;
  run_id: string;
  parent_id: string | null;
  kind: NodeKind;
  target: Target | null;
  mode: Mode;
  depth: number;
  allow_delegation: number;
  status: NodeStatus;
  task: string;
  params_json: string | null;
  session_id: string | null;
  cwd: string;
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  base_sha: string | null;
  /** The job branch's tip after its latest turn, so the branch can be put back exactly if it is cleaned up and the job resumed. */
  head_sha: string | null;
  model: string | null;
  effort: string | null;
  worker_pid: number | null;
  worker_start: string | null;
  worker_claimed_at: number | null;
  agent_pid: number | null;
  agent_pgid: number | null;
  agent_start: string | null;
  /** No longer used. Discussions once ran turns on sessions from a worker of their own, and recorded themselves here. */
  owner_id: string | null;
  log_path: string | null;
  transcript_path: string | null;
  result_json: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface TurnRow {
  id: number;
  node_id: string;
  source: string;
  body: string;
  access: Mode;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | "refused";
  /** VendorRefusal JSON, only for a vendor safety stop. */
  refusal_json: string | null;
  reply: string | null;
  error: string | null;
  /** JSON list of what the agent was refused in this turn, or null. */
  denials: string | null;
  prompt_path: string | null;
  /** Private temp directory recorded before confinement starts; identity prevents sweeping a replacement. */
  tmp_dir: string | null;
  tmp_dev: number | null;
  tmp_ino: number | null;
  /** Immutable effective grant of this turn, recorded when it is claimed for launch. */
  grant_json: string | null;
  /** What the agent was last seen starting (a command, a tool, a file) during this turn, and when. */
  activity: string | null;
  activity_at: number | null;
  /** The turn's token usage as its agent last reported it (JSON, backends/types.ts Usage). */
  usage_json: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

/** The launch_leaders table, under a name (a rebuild of a pre-release copy uses a scratch name). */
const LAUNCH_LEADERS_DDL = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
  run_id TEXT NOT NULL, leader_pid INTEGER NOT NULL, kind TEXT NOT NULL, node_id TEXT,
  start TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY (run_id, leader_pid, start)
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, root_cwd TEXT NOT NULL,
  config_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL,
  target TEXT, mode TEXT NOT NULL, depth INTEGER NOT NULL, allow_delegation INTEGER NOT NULL,
  status TEXT NOT NULL, task TEXT NOT NULL, params_json TEXT, session_id TEXT,
  cwd TEXT NOT NULL, repo TEXT, worktree TEXT, branch TEXT, base_sha TEXT, model TEXT, effort TEXT,
  worker_pid INTEGER, worker_claimed_at INTEGER, agent_pid INTEGER, agent_pgid INTEGER,
  log_path TEXT, transcript_path TEXT, result_json TEXT, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS nodes_run ON nodes(run_id);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
-- One row per turn sent to a session. Queued rows are the session's inbox.
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, source TEXT NOT NULL,
  body TEXT NOT NULL, access TEXT NOT NULL, status TEXT NOT NULL, reply TEXT, error TEXT,
  prompt_path TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS turns_node ON turns(node_id);
-- Human messages injected into a live discussion.
CREATE TABLE IF NOT EXISTS injections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, discussion_id TEXT NOT NULL, body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Approval requests from launched agents. status: pending | allowed | denied | expired.
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL,
  summary TEXT NOT NULL, reason TEXT, detail_json TEXT, status TEXT NOT NULL,
  decided_by TEXT, note TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS requests_run ON requests(run_id, status);
-- Approval requests put to the user through a root session's host (MCP elicitation), one row per
-- request: which relay server asked, and how it ended. outcome is null while the question is open;
-- reading is how relay took the answer: decided, dismissed (undecided), error or withdrawn.
CREATE TABLE IF NOT EXISTS elicitations (
  request_id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, pid_start TEXT,
  asked_at INTEGER NOT NULL, outcome TEXT, reading TEXT, ended_at INTEGER
);
-- What root sessions should hear about in their runs, each recorded once (key). noticed_at: a
-- notice was posted to the session's inbox; seen_at: it was returned in a tool result.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  item_id TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
  noticed_at INTEGER, seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seen_at);
-- Relay's own server and worker processes, so that cleanup of an agent's processes can tell them apart.
CREATE TABLE IF NOT EXISTS relay_procs (
  pid INTEGER NOT NULL, start TEXT NOT NULL, kind TEXT NOT NULL, node_id TEXT, created_at INTEGER NOT NULL
);
-- Process-group / session leaders relay has launched (workers and agents, each started detached, so
-- leader pid == pgid == sid). Kept for the run's lifetime, never cleared when the leader dies: an
-- orphan left in a dead leader's group or session is still placed inside the launched tree
-- (src/core/presence.ts). The start column is the leader's start time as ps prints it (empty when
-- relay could not read it), part of the key so a pid reused within a run keeps every leader it led;
-- a live process at that pid whose start matches none of them means its old group/session is gone.
${LAUNCH_LEADERS_DDL("launch_leaders")}
-- Calls that named a request_id, and what each started (src/core/calls.ts). scope: the caller.
-- claim, owner_pid, owner_start: the call holding it while it starts (node_id '').
CREATE TABLE IF NOT EXISTS calls (
  scope TEXT NOT NULL, request_id TEXT NOT NULL, tool TEXT NOT NULL, args_hash TEXT NOT NULL,
  node_id TEXT NOT NULL, turn_id INTEGER, claim TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_start TEXT,
  created_at INTEGER NOT NULL, PRIMARY KEY (scope, request_id)
);
-- Concurrency slots. state: waiting | held | lent.
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, holder TEXT NOT NULL,
  pid INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL
);
-- Terminal-authorized rooms own no run; exposures outlive transcript retention.
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('waiting','open','ended')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1, next_ordinal INTEGER NOT NULL DEFAULT 1,
  turns INTEGER NOT NULL DEFAULT 0, max_turns INTEGER NOT NULL DEFAULT 24, ending_json TEXT,
  origin TEXT NOT NULL DEFAULT 'unknown' CHECK(origin IN ('terminal','open','unknown')), purpose TEXT
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1, owner_hash TEXT, owner_kind TEXT,
  pid INTEGER, pid_start TEXT, joined_at INTEGER, joined_sender_json TEXT,
  last_call_at INTEGER, call_no INTEGER NOT NULL DEFAULT 0,
  wait_pid INTEGER, wait_start TEXT, wait_nonce TEXT,
  read_times_json TEXT NOT NULL DEFAULT '[]', reseat_times_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(room_id,id), UNIQUE(room_id,ordinal)
);
CREATE TABLE IF NOT EXISTS room_bindings (
  owner_hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, member_id TEXT NOT NULL,
  generation INTEGER NOT NULL, UNIQUE(room_id,member_id)
);
CREATE TABLE IF NOT EXISTS room_invites (
  code_hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, member_id TEXT NOT NULL,
  generation INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, consumed_owner_hash TEXT, UNIQUE(room_id,member_id,generation)
);
CREATE TABLE IF NOT EXISTS room_messages (
  room_id TEXT NOT NULL, seq INTEGER NOT NULL, member_id TEXT, sender_owner_hash TEXT,
  sender_json TEXT NOT NULL, created_at INTEGER NOT NULL, text TEXT NOT NULL,
  stance TEXT CHECK(stance IN ('continue','agree','crux')), request_id TEXT, args_hash TEXT,
  PRIMARY KEY(room_id,seq), UNIQUE(room_id,member_id,request_id)
);
CREATE TABLE IF NOT EXISTS room_exposures (
  owner_hash TEXT PRIMARY KEY, given_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_retention ON rooms(state,ended_at);
`;

/**
 * The registry's schema version, kept in the file's PRAGMA user_version (0.2.0 never set it, so
 * its files read 0). Bump it with every change to SCHEMA or to migrate() below: the first open by
 * a relay with a higher version backs the file up before changing it (see docs/UPGRADING.md), and
 * a relay with a lower version refuses the file rather than work on a schema it does not know.
 */
export const SCHEMA_VERSION = 5;

let handle: DatabaseSync | null = null;
let backupMade: string | null = null;

/** Where this process backed up the registry before migrating it, or null if it did not need to. */
export const registryBackup = (): string | null => backupMade;

/** The registry file and its schema version, read without changing anything; null when there is none yet. */
export function registryVersion(): { file: string; version: number } | null {
  const file = path.join(relayHome(), "relay.db");
  if (!fs.existsSync(file)) return null;
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    d.exec("PRAGMA busy_timeout = 10000;");
    return { file, version: (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version };
  } finally {
    d.close();
  }
}

/**
 * Refuses a registry from a newer relay. Before a registry from an earlier relay is migrated, a
 * consistent copy of it is written next to it (relay.db.backup-v<its version>-<time>-<pid>); if
 * that copy cannot be made, the file is left as it is and relay stops, since going back to the
 * earlier relay depends on it. Returns the version the file had.
 */
function guardVersion(d: DatabaseSync, file: string, home: string): number {
  const found = (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (found > SCHEMA_VERSION) {
    throw new Error(`relay's registry ${file} was written by a newer relay (schema version ${found}; this relay knows up to ${SCHEMA_VERSION}), so this relay will not use it. Run the newer relay, or restore the backup that relay made when it upgraded the file (relay.db.backup-v${SCHEMA_VERSION}-… in ${home}); see docs/UPGRADING.md.`);
  }
  const existing = (d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get() as { n: number }).n > 0;
  if (existing && found < SCHEMA_VERSION && !backupMade) {
    const backup = path.join(home, `relay.db.backup-v${found}-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
    try {
      d.prepare("VACUUM INTO ?").run(backup);
    } catch (err) {
      if (/locked|busy/i.test((err as Error).message)) throw err;
      throw new Error(`relay's registry ${file} is from an earlier relay (schema version ${found}) and needs migrating, but relay could not back it up first to ${backup} (${(err as Error).message}), so it has left the file as it is.`);
    }
    backupMade = backup;
  }
  return found;
}

/** Tests that use several scratch registries in one process must release the cached connection. */
export function closeDbForTests(): void {
  handle?.close();
  handle = null;
  backupMade = null;
}

export function db(): DatabaseSync {
  if (handle) return handle;
  const home = relayHome();
  // Prompts, logs and transcripts live here and can hold anything an agent read. Private to the
  // user, including a directory made before relay set this.
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if ((fs.statSync(home).mode & 0o077) !== 0) {
    try {
      fs.chmodSync(home, 0o700);
    } catch {
      // Reported below.
    }
    if ((fs.statSync(home).mode & 0o077) !== 0) throw new Error(`relay's control directory ${home} is open to other users and relay could not make it private (mode 700). Fix its owner or mode, or set RELAY_HOME elsewhere.`);
  }
  const file = path.join(home, "relay.db");
  const d = new DatabaseSync(file);
  // The busy timeout comes first: switching to WAL and creating the schema take a write lock, and
  // several relay processes can open a fresh database at the same moment.
  d.exec("PRAGMA busy_timeout = 10000;");
  const migrate = () => {
    // Columns added after a table first shipped.
    const add = (table: string, column: string, type: string) => {
      const cols = (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      if (cols.includes(column)) return;
      try {
        d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch (err) {
        // Another process starting at the same moment added it first.
        if (!/duplicate column/i.test((err as Error).message)) throw err;
      }
    };
    add("requests", "scope", "TEXT");
    add("requests", "turn_id", "INTEGER");
    add("runs", "root_pid", "INTEGER");
    add("runs", "root_start", "TEXT");
    add("runs", "root_token", "TEXT");
    add("nodes", "worker_start", "TEXT");
    add("nodes", "agent_start", "TEXT");
    add("nodes", "owner_id", "TEXT");
    add("nodes", "head_sha", "TEXT");
    add("turns", "denials", "TEXT");
    add("turns", "activity", "TEXT");
    add("turns", "activity_at", "INTEGER");
    add("turns", "usage_json", "TEXT");
    add("turns", "tmp_dir", "TEXT");
    // Schema 5 is unreleased (1.2.x ships schema 4). Rooms gained how they were created and an
    // opener's purpose line after earlier builds of this branch wrote schema-5 files; their rooms
    // read as origin 'unknown' (decided 2026-11-16, Q2).
    add("rooms", "origin", "TEXT NOT NULL DEFAULT 'unknown' CHECK(origin IN ('terminal','open','unknown'))");
    add("rooms", "purpose", "TEXT");
    add("turns", "tmp_dev", "INTEGER");
    add("turns", "tmp_ino", "INTEGER");
    add("turns", "grant_json", "TEXT");
    add("turns", "refusal_json", "TEXT");
    add("launch_leaders", "start", "TEXT");
    rekeyLaunchLeaders();
  };
  // A schema-4 file written by an unreleased build of this branch keyed launch_leaders on
  // (run_id, leader_pid) alone, keeping only the first start time a reused pid had. Rebuild it under
  // the current key, carrying every row over (an unknown start becomes ''). This compatibility
  // repair is independent of the schema-5 room additions.
  const rekeyLaunchLeaders = () => {
    const keyed = () => (d.prepare("PRAGMA table_info(launch_leaders)").all() as { name: string; pk: number }[]).some((c) => c.name === "start" && c.pk > 0);
    if (keyed()) return;
    d.exec("BEGIN IMMEDIATE");
    try {
      if (!keyed()) {
        d.exec("DROP TABLE IF EXISTS launch_leaders_rekey");
        d.exec(LAUNCH_LEADERS_DDL("launch_leaders_rekey"));
        d.exec("INSERT OR IGNORE INTO launch_leaders_rekey (run_id, leader_pid, kind, node_id, start, created_at) SELECT run_id, leader_pid, kind, node_id, COALESCE(start, ''), created_at FROM launch_leaders");
        d.exec("DROP TABLE launch_leaders");
        d.exec("ALTER TABLE launch_leaders_rekey RENAME TO launch_leaders");
      }
      d.exec("COMMIT");
    } catch (err) {
      try { d.exec("ROLLBACK"); } catch { /* nothing open */ }
      throw err;
    }
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const found = guardVersion(d, file, home);
      d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      d.exec(SCHEMA);
      migrate();
      if (found < SCHEMA_VERSION) d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      break;
    } catch (err) {
      if (attempt >= 20 || !/locked|busy/i.test((err as Error).message)) {
        d.close();
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  handle = d;
  return d;
}

/**
 * Statements prepared on this process's connection, by their SQL text, for the reads relay makes
 * over and over (status reads every item of a run several ways). node:sqlite resets a statement
 * after each get, all and run, so a kept statement holds no snapshot or lock between uses and every
 * use sees what has been committed since; SQLite prepares it again by itself after a schema change.
 * Kept with the connection they were prepared on, which finalizes them when it closes.
 */
const prepared = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function stmt(sql: string): StatementSync {
  const d = db();
  let mine = prepared.get(d);
  if (!mine) prepared.set(d, (mine = new Map()));
  let s = mine.get(sql);
  if (!s) mine.set(sql, (s = d.prepare(sql)));
  return s;
}

/**
 * Where the registry stands, as this process's connection sees it: `others` moves whenever another
 * connection commits (PRAGMA data_version), `own` whenever this one changes a row (total_changes()).
 * Two marks that are the same (sameMark) mean nothing in the registry has changed in between; marks
 * of different connections never are, so a closed and reopened registry never matches.
 */
export interface RegistryMark { conn: DatabaseSync; others: number; own: number }
export function registryMark(): RegistryMark {
  const r = stmt("SELECT data_version AS others, total_changes() AS own FROM pragma_data_version()").get() as { others: number; own: number };
  return { conn: db(), others: r.others, own: r.own };
}
export const sameMark = (a: RegistryMark, b: RegistryMark): boolean => a.conn === b.conn && a.others === b.others && a.own === b.own;

export const now = () => Date.now();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PREFIX: Record<NodeKind | "run" | "request", string> = {
  run: "run", job: "j", thread: "t", participant: "p", discussion: "d", review: "r", request: "q",
};
export function newId(kind: NodeKind | "run" | "request"): string {
  return `${PREFIX[kind]}_${crypto.randomBytes(4).toString("hex")}`;
}

/** Runs fn inside BEGIN IMMEDIATE so read-then-write sequences are atomic across processes. */
export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

export function getRun(id: string): RunRow | undefined {
  return stmt("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
}
/**
 * Runs' config_json as last parsed in this process, by run id, each with the exact text it was
 * parsed from. A run's private params share that column and other processes rewrite them, so the
 * text is read afresh whenever the registry has changed at all since it was last read (its mark),
 * and a parse is reused only for identical text: the cache can never answer for a row that has
 * changed, in this registry or another one. Parsing the column (it carries the run's never policy,
 * tens of kilobytes) was most of what status cost.
 */
interface ParsedRun {
  text: string;
  /** The registry's mark (registryMark) as it stood just before `text` was last read. */
  mark: RegistryMark;
  /** Shared and frozen, so it is handed out only as a copy (runConfig); null when it is not valid. */
  config: Readonly<RelayConfig> | null;
  /** Whether the run's private params hold restart overlays, and launch reservations (restart-overlay.ts). */
  overlays: boolean;
  reservations: boolean;
}
const parsedRuns = new Map<string, ParsedRun>();
/** Runs kept parsed at most; a process looks at one or a few runs at a time. */
const PARSED_RUNS_MAX = 32;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/** The run's config_json, parsed (see ParsedRun); undefined for a run not in the registry. Throws where the text is not JSON. */
function parsedRun(runId: string): ParsedRun | undefined {
  const mark = registryMark();
  const hit = parsedRuns.get(runId);
  // Nothing in the registry has changed since the text was read, so it is still the run's.
  if (hit && sameMark(hit.mark, mark)) return hit;
  const row = stmt("SELECT config_json FROM runs WHERE id = ?").get(runId) as { config_json: string } | undefined;
  if (!row) return undefined;
  if (hit && hit.text === row.config_json) {
    hit.mark = mark;
    return hit;
  }
  // runs has no params column in schema 4. Private run params share its existing JSON envelope,
  // and must never leak into the effective configuration or its authorization fingerprints.
  const { params_json: params, ...config } = JSON.parse(row.config_json);
  let parsed: Readonly<RelayConfig> | null = null;
  try {
    // A copy, so that freezing it cannot freeze anything withDefaults shares with its defaults.
    parsed = deepFreeze(structuredClone(withDefaults(config as Partial<RelayConfig>)));
  } catch {
    // Not valid: runConfig refuses it afresh every time it is asked.
  }
  const entry = { text: row.config_json, mark, config: parsed, overlays: params?.overlays !== undefined, reservations: params?.launch_reservations !== undefined };
  if (!hit && parsedRuns.size >= PARSED_RUNS_MAX) parsedRuns.delete(parsedRuns.keys().next().value!);
  parsedRuns.set(runId, entry);
  return entry;
}
/** The run's configuration, a copy of its own for each caller: some change what they are given (env-broker.ts). */
export function runConfig(runId: string): RelayConfig {
  const run = parsedRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  if (run.config) return structuredClone(run.config) as RelayConfig;
  const { params_json: _params, ...config } = JSON.parse(run.text);
  return withDefaults(config as Partial<RelayConfig>);
}
export function createRun(rootCwd: string, config: RelayConfig, token: string): string {
  const id = newId("run");
  const d = db();
  // Capture trusted expansions before any child can start. Checkpoints keep these identities
  // even if paths disappear or the person's next config selects another destination.
  const policy = resolveNeverPolicy({ never: config.never, codexHome: (config.targets.codex as { home?: string }).home });
  const snapshot = { ...config, params_json: { never_floor: { policy, configRequired: fs.existsSync(configPath()) } } };
  d.prepare("INSERT INTO runs (id, created_at, root_cwd, config_json, root_pid, root_start, root_token) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, now(), rootCwd, JSON.stringify(snapshot), process.pid, procStart(process.pid), token);
  return id;
}
export function latestRun(): RunRow | undefined {
  // Prefer the latest run that actually started something.
  return (db().prepare("SELECT * FROM runs WHERE id IN (SELECT run_id FROM nodes) ORDER BY created_at DESC LIMIT 1").get()
    ?? db().prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 1").get()) as RunRow | undefined;
}

export function getNode(id: string): NodeRow | undefined {
  return stmt("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
}
export function runNodes(runId: string): NodeRow[] {
  return stmt("SELECT * FROM nodes WHERE run_id = ? ORDER BY created_at, id").all(runId) as unknown as NodeRow[];
}
/**
 * The job whose worktree holds `dir`: relay runs git for such a directory with the git directory the
 * repository records for that worktree (git.ts jobTree), never through the worktree's `.git` file,
 * which the job's agent can rewrite. "unknown" for a directory inside relay's worktree directory
 * that no job's worktree holds; null for any other directory.
 */
export function worktreeHolder(dir: string): NodeRow | "unknown" | null {
  // By relay's own records first, without going through the filesystem: a path recorded inside a
  // job's worktree belongs to that job even if a component of it is now a link to somewhere else.
  const lexical = lexicalHolder(dir);
  if (lexical) return lexical;
  const real = canonical(dir);
  const holder = worktreeRows().find((n) => inside(real, n.worktree!));
  if (holder) return holder;
  return inside(real, worktreesHome()) ? "unknown" : null;
}
const worktreeRows = () => db().prepare("SELECT * FROM nodes WHERE worktree IS NOT NULL ORDER BY created_at DESC").all() as unknown as NodeRow[];
/** The job whose recorded worktree holds `dir` as a path, compared as strings, never resolved. */
function lexicalHolder(dir: string): NodeRow | undefined {
  const p = path.resolve(dir);
  // Only rows whose worktree begins `dir` can hold it, which SQLite finds without handing every
  // worktree in the registry's history to JavaScript; the comparison that decides is the same.
  const rows = stmt("SELECT * FROM nodes WHERE worktree IS NOT NULL AND instr(?, worktree) = 1 ORDER BY created_at DESC").all(p) as unknown as NodeRow[];
  return rows.find((n) => p === n.worktree || p.startsWith(n.worktree!.endsWith(path.sep) ? n.worktree! : n.worktree + path.sep));
}

/**
 * The directory relay works in for a node, wherever it reads one (a launch, a resumed child, a nested
 * delegate, native resume, approval details). A write job's own is its worktree root, whatever an
 * earlier relay recorded: before the root launch it recorded the caller's subdirectory, which a
 * process the agent left running can swap for a link. A node recorded inside a job's worktree (an
 * in-place child) gets that worktree's root the same way. Matched against relay's own records,
 * never through the filesystem. Any other node's directory is its own.
 */
export function workCwd(n: Pick<NodeRow, "cwd" | "worktree">): string {
  if (n.worktree) return n.worktree;
  return lexicalHolder(n.cwd)?.worktree ?? n.cwd;
}

/**
 * Rewrites a write job recorded with a subdirectory cwd (by a relay before the root launch) to its
 * worktree root, keeping where the caller was, as the path recorded (never resolved), in params_json
 * subdir. Returns the row as it is now.
 */
export function normaliseWorkCwd(n: NodeRow): NodeRow {
  if (!n.worktree || n.cwd === n.worktree) return n;
  const rel = path.relative(n.worktree, n.cwd);
  const within = rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  // One statement, setting subdir only where none is recorded: nothing else in params_json is
  // written back from the row read earlier (review C11).
  db().prepare(
    "UPDATE nodes SET cwd = ?, params_json = CASE WHEN ? IS NULL OR json_type(COALESCE(params_json, '{}'), '$.subdir') = 'text' THEN params_json ELSE json_set(COALESCE(params_json, '{}'), '$.subdir', ?) END WHERE id = ?",
  ).run(n.worktree, within ? 1 : null, rel.split(path.sep).join("/"), n.id);
  return getNode(n.id)!;
}

/**
 * Sets one key of a node's params_json, in one statement, leaving every other key as it is in the
 * row now (review C11). params_json is written by several processes (the worker re-pinning a
 * restored worktree, a root session granting more): a whole object written back from a copy read
 * earlier would undo whatever another wrote in between.
 */
export function setParam(nodeId: string, key: string, value: unknown): void {
  if (!/^[a-z_]+$/.test(key)) throw new Error(`not a params_json key: ${key}`);
  db().prepare("UPDATE nodes SET params_json = json_set(COALESCE(params_json, '{}'), ?, json(?)) WHERE id = ?").run(`$.${key}`, JSON.stringify(value ?? null), nodeId);
}
function childrenOf(id: string): NodeRow[] {
  return stmt("SELECT * FROM nodes WHERE parent_id = ? ORDER BY created_at, id").all(id) as unknown as NodeRow[];
}
export function descendants(id: string): NodeRow[] {
  const out: NodeRow[] = [];
  const stack = [id];
  while (stack.length) {
    for (const child of childrenOf(stack.pop()!)) {
      out.push(child);
      stack.push(child.id);
    }
  }
  return out;
}

/**
 * The node's ancestors, its parent first, as far up as the registry has them (a parent that is
 * not there ends the walk); with `self`, the node itself comes first.
 */
export function ancestors(n: NodeRow, o: { self?: boolean } = {}): NodeRow[] {
  const out = o.self ? [n] : [];
  for (let cur = n.parent_id ? getNode(n.parent_id) : undefined; cur; cur = cur.parent_id ? getNode(cur.parent_id) : undefined) out.push(cur);
  return out;
}

/**
 * True when the node's run, or one of its ancestors, has been cancelled; with `self`, the node
 * itself counts too. A caller that has no node in hand decides for itself what a missing one means.
 */
export function cancelledAbove(n: NodeRow, o: { self?: boolean } = {}): boolean {
  if (getRun(n.run_id)?.status === "cancelled") return true;
  return ancestors(n, o).some((a) => a.status === "cancelled");
}

/**
 * Why a turn is no longer one a launched agent's relay connection can act for, or null: it must be
 * in the registry as the node's, running, and so must the node's session.
 */
export function turnEnded(nodeId: string, turnId: number): string | null {
  const t = getTurn(turnId);
  if (!t || t.node_id !== nodeId) return `turn ${turnId} of ${nodeId} is not in the registry`;
  if (t.status !== "running") return `turn ${turnId} of ${nodeId} has ended (${t.status})`;
  const n = getNode(nodeId);
  // The turn's own record is not enough: the session must still be running.
  if (!n || n.status !== "running") return `turn ${turnId} of ${nodeId} has ended (its session is ${n?.status ?? "gone"})`;
  return overlayTurnProblem(nodeId, turnId);
}

export function insertNode(n: Partial<NodeRow> & Pick<NodeRow, "id" | "run_id" | "kind" | "mode" | "depth" | "task" | "cwd">): NodeRow {
  const row = {
    parent_id: null, target: null, allow_delegation: 0, status: "queued", params_json: null,
    repo: null, worktree: null, branch: null, base_sha: null, model: null, effort: null,
    created_at: now(), ...n,
  };
  db().prepare(
    `INSERT INTO nodes (id, run_id, parent_id, kind, target, mode, depth, allow_delegation, status, task,
       params_json, cwd, repo, worktree, branch, base_sha, model, effort, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.run_id, row.parent_id, row.kind, row.target, row.mode, row.depth, row.allow_delegation,
    row.status, row.task, row.params_json, row.cwd, row.repo, row.worktree, row.branch, row.base_sha,
    row.model, row.effort, row.created_at);
  return getNode(row.id)!;
}

export function updateNode(id: string, fields: Partial<NodeRow>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE nodes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
  db().prepare(sql).run(...keys.map((k) => (fields as Record<string, unknown>)[k] as never), id);
}

export function insertTurn(nodeId: string, source: string, body: string, access: Mode, status: TurnRow["status"] = "queued"): number {
  const r = db().prepare("INSERT INTO turns (node_id, source, body, access, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(nodeId, source, body, access, status, now());
  return Number(r.lastInsertRowid);
}
export function getTurn(id: number): TurnRow | undefined {
  return stmt("SELECT * FROM turns WHERE id = ?").get(id) as TurnRow | undefined;
}
export function updateTurn(id: number, fields: Partial<TurnRow>): void {
  const keys = Object.keys(fields);
  const sql = `UPDATE turns SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
  db().prepare(sql).run(...keys.map((k) => (fields as Record<string, unknown>)[k] as never), id);
}
export function nextQueuedTurn(nodeId: string): TurnRow | undefined {
  return stmt("SELECT * FROM turns WHERE node_id = ? AND status = 'queued' ORDER BY id LIMIT 1").get(nodeId) as TurnRow | undefined;
}
/**
 * The speed a session goes on at: that of the last of its queued turns a call was admitted at
 * (params.ts queuedSpeeds; caller.ts changeSpeed), else that of its turn now running or last
 * started. What a call that continues the session and names no speed runs at, and what admits it.
 * A speed kept for a turn that ended without starting (cancelled while queued) counts for nothing.
 */
export function speedAfter(n: NodeRow): Speed {
  const queued = queuedSpeeds(n);
  if (!queued.length) return speedOf(n);
  const live = queuedTurnIds(n.id);
  return queued.filter(([t]) => live.has(t)).at(-1)?.[1] ?? speedOf(n);
}
/** The ids of a node's turns still queued. */
export const queuedTurnIds = (nodeId: string): Set<number> =>
  new Set((stmt("SELECT id FROM turns WHERE node_id = ? AND status = 'queued'").all(nodeId) as { id: number }[]).map((r) => r.id));
export function nodeTurns(nodeId: string): TurnRow[] {
  return stmt("SELECT * FROM turns WHERE node_id = ? ORDER BY id").all(nodeId) as unknown as TurnRow[];
}
/** A node's turns, in order, with only what an item's view reports of them (views.ts): not the prompts and replies. */
export function turnReports(nodeId: string): Pick<TurnRow, "status" | "usage_json">[] {
  return stmt("SELECT status, usage_json FROM turns WHERE node_id = ? ORDER BY id").all(nodeId) as unknown as Pick<TurnRow, "status" | "usage_json">[];
}

/**
 * Relay's own servers and workers announce themselves here. Cleanup of what an agent started must
 * leave them alone: a launched agent's relay server starts workers for jobs that are meant to
 * outlive the agent's turn.
 */
export function registerSelf(kind: "server" | "worker", nodeId: string | null): void {
  const start = procStart(process.pid);
  if (!start) return;
  db().prepare("INSERT INTO relay_procs (pid, start, kind, node_id, created_at) VALUES (?, ?, ?, ?, ?)").run(process.pid, start, kind, nodeId, now());
}

/**
 * Relay's own registered processes (relay_procs), by pid, each with its start time as ps prints it:
 * what the process helpers in procs.ts spare, read afresh at each look.
 */
export const relayProcs = (): Map<number, string> =>
  new Map((stmt("SELECT pid, start FROM relay_procs").all() as unknown as Proc[]).map((p) => [p.pid, p.start.replace(/\s+/g, " ")]));

/**
 * Records a process-group / session leader relay launched (a worker or an agent, started detached,
 * so its pid is its pgid and sid). Kept for the run's lifetime; the presence check matches a
 * current process's group or session against these numeric ids even after the leader has died
 * (src/core/presence.ts). Idempotent per (run, pid).
 */
export function recordLaunchLeader(runId: string, leaderPid: number | null | undefined, kind: "worker" | "agent", nodeId: string | null): void {
  if (!leaderPid || leaderPid <= 1) return;
  // The leader is alive at this point, so its start time is readable; it pins the pid against reuse.
  const start = procStart(leaderPid);
  // Keyed on the start too, so a pid that leads again later in the run adds a row rather than being ignored.
  db().prepare("INSERT OR IGNORE INTO launch_leaders (run_id, leader_pid, kind, node_id, start, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(runId, leaderPid, kind, nodeId, start ?? "", now());
}

/** Every launched leader id relay has recorded, across runs, each with what it is and its start time, for the presence check. */
export const launchLeaders = (): { leader_pid: number; kind: string; node_id: string | null; start: string | null }[] =>
  (db().prepare("SELECT leader_pid, kind, node_id, start FROM launch_leaders ORDER BY created_at, rowid").all() as { leader_pid: number; kind: string; node_id: string | null; start: string | null }[])
    .map((l) => ({ ...l, start: l.start ? l.start : null })); // '' (unknown) reads as null

const CLAIM_GRACE_MS = 15000;

/** True while some worker process owns the node (or was claimed moments ago and is still starting). */
export function workerLive(n: NodeRow): boolean {
  if (n.worker_pid === null) return false;
  if (n.worker_pid === -1) return now() - (n.worker_claimed_at ?? 0) < CLAIM_GRACE_MS;
  return sameProcess(n.worker_pid, n.worker_start);
}

/** The one answer to "is this item in use right now": it is queued or running. Waits, views, merge, cleanup and cancel all go by this. */
export function busy(n: NodeRow): boolean {
  return ACTIVE.includes(n.status);
}

/**
 * Whether a session is done with one of its turns, which is what a call waiting on the turn (ask,
 * a discussion's reply) waits for: the turn is over, and its session has recorded that with its
 * own end, or has no worker left that could. A turn that started is recorded as over as soon as
 * its agent has ended, since the turn's authority ends with it; the session records the turn's end
 * after relay's work on it (a job's commit), settling, or showing as queued for its next turn, in
 * one transaction (outcome.ts finishTurn); until then the session shows as running with no turn
 * running. Once recorded, it stays so for every later state of the session: a later turn that has
 * started (running, or over since, its own end perhaps not yet recorded) means the worker had
 * recorded this one, since it records each turn's end before it starts another. Later is by id
 * and by start time both: a turn that jumped ahead of this one (an overlay's restart) started
 * before it. A turn that never started is recorded as over in that transaction, or by a cancel or
 * reap that ends its session first. A worker is taken for gone only once it is known to be
 * (processGone): one whose start time ps cannot read at the moment may still be recording the
 * turn's end. The wait stays bounded by the call's own limit, and by reap.
 */
export function turnSettled(t: TurnRow | undefined): boolean {
  if (!t) return true;
  if (t.status === "queued" || t.status === "running") return false;
  if (t.started_at === null) return true;
  const n = getNode(t.node_id);
  if (!n || n.status !== "running") return true;
  if (stmt("SELECT 1 FROM turns WHERE node_id = ? AND id > ? AND started_at >= ? LIMIT 1").get(n.id, t.id, t.started_at)) return true;
  // No worker recorded, or a claim of one that never started (workerLive), is none.
  if (n.worker_pid === null || n.worker_pid === -1) return !workerLive(n);
  return processGone(n.worker_pid, n.worker_start);
}

/** Ends every turn of a node that is still marked running or queued. */
export function closeTurns(nodeId: string, status: "failed" | "cancelled", error: string): void {
  stopNodeLaunchReservations(nodeId);
  db().prepare("UPDATE turns SET status = ?, error = COALESCE(error, ?), ended_at = ? WHERE node_id = ? AND status IN ('running', 'queued')").run(status, error, now(), nodeId);
}

type OrphanStop =
  | { outcome: "none" | "stopped" | "unconfirmed"; note: string; quarantine?: undefined }
  | { outcome: "refused"; note: string; quarantine: string };

/**
 * Deals with an agent whose supervising process has gone. If the recorded group is still the one
 * relay started, it is killed. Keeps the agent identity when cleanup is unconfirmed or refused;
 * refusal also carries a persistent executor quarantine, since its sandbox cannot prove the
 * absence of a live app server that could reconnect to a reused executor port.
 */
function stopOrphan(n: NodeRow): OrphanStop {
  const clear = () => updateNode(n.id, { agent_pid: null, agent_pgid: null, agent_start: null });
  if (!n.agent_pgid) return { outcome: "none", note: "" };
  if (!groupAlive(n.agent_pgid)) {
    clear();
    return { outcome: "none", note: "" };
  }
  // A live leader with a different start time means the number now belongs to something else.
  if (pidAlive(n.agent_pid) && n.agent_start && !sameProcess(n.agent_pid, n.agent_start, { fresh: true })) {
    clear();
    return { outcome: "none", note: "" };
  }
  // There is no supervisor left to ask the agent to stop cleanly, so everything it started goes with it.
  try {
    // Only the recorded group leader can authorize reaping an ancestor (an agent may have
    // started the MCP server doing this reap). killGroupNow checks this identity fresh again.
    const leader = n.agent_pid === n.agent_pgid && n.agent_start ? { pid: n.agent_pid, start: n.agent_start } : undefined;
    if (!killGroupNow(n.agent_pgid, relayProcs, leader)) return { outcome: "unconfirmed", note: ` An agent process (group ${n.agent_pgid}) may still be running.` };
  } catch (err) {
    if (!isGroupSignalRefusal(err)) throw err;
    const note = ` Agent cleanup refused for group ${n.agent_pgid}: ${err.message}.`;
    return { outcome: "refused", note, quarantine: `untraceable app-server cleanup:${note}` };
  }
  clear();
  return { outcome: "stopped", note: "" };
}

/**
 * Marks active nodes whose worker has died as lost, stops agents left without a supervisor,
 * releases sessions whose moderator has died, and drops slots held by dead processes. Called from
 * status and from slot acquisition so stale state never blocks a run.
 */
export function reap(runId: string): void {
  // Overlays and launch reservations are kept in the run's params; a run that holds none (most)
  // has nothing for either to reap, and they are not parsed. Looked at again after the first,
  // which rewrites those params. Where the run cannot be read, each is left to say why.
  const holds = (which: "overlays" | "reservations"): boolean => {
    try {
      return parsedRun(runId)?.[which] ?? true;
    } catch {
      return true;
    }
  };
  if (holds("reservations")) reapLaunchReservations(runId, (r) => {
    const n = getNode(r.nodeId);
    const app = n ? stopOrphan(n) : undefined;
    const appProblem = app?.note ?? "node unavailable";
    const current = executorRecords();
    const owned = current.records.filter(x => x.record.nodeId === r.nodeId && x.record.turnId === r.turnId);
    const stopped = owned.map(rec => app?.outcome === "refused" ? quarantineRecordedExecutor(rec, app.quarantine) : stopRecordedExecutorNow(rec, appProblem || undefined));
    // An absent native leader cannot prove detached cleanup. An executor sweep proves only its
    // own sandbox; retain any uncertainty the worker recorded about the unconfined app server.
    const clean = r.launchClass === "stage2" && owned.length > 0 && !appProblem && !current.problems.length && r.cleanup?.appClean === true && stopped.every(x => !x.tainted);
    return { clean, ...(!clean ? { problem: appProblem || "detached/native cleanup is unproven; quarantine retained" } : {}) };
  });
  if (holds("overlays")) reapOverlays(runId, { ownerAlive: overlayOwnerAlive, stop: (r) => {
    const n = getNode(r.nodeId);
    const app = n ? stopOrphan(n) : undefined;
    const appProblem = app?.note ?? "";
    const current = executorRecords();
    // Deadline enforcement cannot defer to a still-live but stalled worker. Only this overlay's
    // recorded turn is stopped; no later turn can start before this record is released.
    const owned = current.records.filter(x => x.record.nodeId === r.nodeId && x.record.turnId === (r.destinationTurn ?? r.originTurn));
    const executorProblem = stoppedNote(owned.map(rec => app?.outcome === "refused" ? quarantineRecordedExecutor(rec, app.quarantine) : stopRecordedExecutorNow(rec, appProblem || undefined)));
    const nativeUncertain = r.state === "tainted" && r.consumedAt === undefined && r.request.originConfinement === "native" && !owned.length && r.cleanup?.clean === false;
    const clean = !appProblem && !current.problems.length && !nativeUncertain && !nodeHasLiveExecutor(r.nodeId);
    return { clean, ...(!clean ? { problem: appProblem + executorProblem || "executor cleanup could not be confirmed" } : {}) };
  } });
  // Only items that are queued or running and have (or had) a worker can have lost it.
  const active = stmt("SELECT * FROM nodes WHERE run_id = ? AND status IN ('queued', 'running') AND worker_pid IS NOT NULL ORDER BY created_at, id").all(runId) as unknown as NodeRow[];
  for (const n of active) {
    if (!workerLive(n)) {
      // The app server first, so that it cannot reconnect to whatever later holds its executor's port; then the executor (stage 2).
      // An app server that may still run (unconfirmed) keeps the executor's lease quarantined, as
      // on the reservation and overlay paths, though the executor itself is still stopped.
      const app = stopOrphan(n);
      const note = app.note + stopNodeExecutorsNow(n.id, app.quarantine, app.outcome === "unconfirmed" ? `untraceable app-server cleanup:${app.note}` : undefined);
      // The node lost and its turns over in one transaction (the processes stopped above, outside
      // it), so that no reader, another server recording events say, finds the one without the
      // other, as a turn's end is recorded with its session's (outcome.ts finishTurn).
      tx(() => {
        // Conditional on the worker it was judged by, so a worker claimed in the meantime is not
        // written off, and a reap by another process that came first leaves this one nothing to write.
        const lost = db().prepare("UPDATE nodes SET status = 'lost', ended_at = ?, worker_pid = NULL, worker_start = NULL, error = ? WHERE id = ? AND worker_pid IS ? AND status IN ('queued', 'running')")
          .run(now(), `worker process died.${note}`, n.id, n.worker_pid);
        // Its turn is over too. A relay server left behind by that turn must find it so, or it would keep the turn's authority.
        if (Number(lost.changes) === 1) closeTurns(n.id, "failed", "worker process died");
      });
    }
  }
  // The write lock is taken only when there is something to write. What is found here is looked at
  // again inside the transaction, which alone decides: a reap by another process in between finds
  // the same, and whichever comes second writes nothing.
  const expirable = stmt("SELECT 1 FROM requests WHERE run_id = ? AND status = 'pending' AND node_id IN (SELECT id FROM nodes WHERE run_id = ? AND status NOT IN ('queued', 'running')) LIMIT 1").get(runId, runId);
  const deadSlot = () => (stmt("SELECT pid FROM slots WHERE run_id = ?").all(runId) as { pid: number }[]).some((s) => !pidAlive(s.pid));
  const deadProc = () => (stmt("SELECT pid, start FROM relay_procs").all() as unknown as Proc[]).some((p) => !sameProcess(p.pid, p.start));
  if (!expirable && !deadSlot() && !deadProc()) return;
  tx(() => {
    // A request whose job is no longer running can never be answered usefully.
    db().prepare(
      "UPDATE requests SET status = 'expired', decided_at = ? WHERE run_id = ? AND status = 'pending' AND node_id IN (SELECT id FROM nodes WHERE run_id = ? AND status NOT IN ('queued', 'running'))",
    ).run(now(), runId, runId);
    const slots = db().prepare("SELECT id, pid FROM slots WHERE run_id = ?").all(runId) as { id: number; pid: number }[];
    for (const s of slots) if (!pidAlive(s.pid)) db().prepare("DELETE FROM slots WHERE id = ?").run(s.id);
    for (const p of stmt("SELECT pid, start FROM relay_procs").all() as unknown as Proc[]) {
      if (!sameProcess(p.pid, p.start)) db().prepare("DELETE FROM relay_procs WHERE pid = ? AND start = ?").run(p.pid, p.start);
    }
  });
}
