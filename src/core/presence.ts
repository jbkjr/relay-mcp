// Whether a person is at this terminal: the structural check behind `relay approve` (and the other
// commands that act with the person's authority). It does not read the command that started
// relay, so how a shell spelt it does not matter. Design and residual risks: docs/approve-boundary.md.
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import readline from "node:readline";
import { db, launchLeaders } from "./db.js";

const normal = (start: string) => start.replace(/\s+/g, " ").trim();

/** The environment variables relay sets on every launched agent (backends/env.ts, backends/types.ts relayServerCommand). */
export const LAUNCH_MARKERS = ["RELAY_RUN_ID", "RELAY_NODE_ID", "RELAY_DEPTH", "RELAY_INJECTED"] as const;

export function launchMarker(env: NodeJS.ProcessEnv = process.env): string | null {
  return LAUNCH_MARKERS.find((k) => env[k] !== undefined) ?? null;
}

export interface Row { pid: number; parent: number; pgid: number; start: string }

/**
 * How launchedTree reads this machine's live process data. Real on this host; tests pass a snapshot
 * and a chosen session id so the ancestry, group, session and fail-closed paths can be exercised
 * without launching processes. `self` is the pid whose ancestry is walked (process.pid in production).
 */
export interface PresenceProbe { table: () => Map<number, Row> | null; sid: () => number | null; self?: number }

/** One process-table snapshot: pid, parent, process group and start time. Null where ps cannot say. */
function processTable(): Map<number, Row> | null {
  const r = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" } });
  if (r.status !== 0 || !r.stdout) return null;
  const table = new Map<number, Row>();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { pid: Number(m[1]), parent: Number(m[2]), pgid: Number(m[3]), start: normal(m[4]) });
  }
  return table.size ? table : null;
}

/**
 * This process's session id. Node has no getsid and macOS ps does not print one, so the system
 * Perl (which relay already relies on, confine/peer.ts) asks the kernel: Darwin's SYS_getsid is 310.
 * The Perl child is in this process's session. Null where it cannot say.
 */
function sessionId(): number | null {
  if (process.platform !== "darwin") return null;
  const r = spawnSync("/usr/bin/perl", ["-e", "my $s = syscall(310, 0); print $s"], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
  const sid = Number(r.stdout);
  return r.status === 0 && Number.isInteger(sid) && sid > 0 ? sid : null;
}

/**
 * The processes relay launched or runs for launched agents, from the registry this command would
 * decide in: each node's worker and agent while recorded, and the registered workers and child
 * relay servers (relay_procs). Identified by pid and start time, so a number the system has given
 * to another process since is not mistaken for one of them.
 */
function launchedProcesses(): Map<number, { start: string | null; what: string }> {
  const out = new Map<number, { start: string | null; what: string }>();
  const add = (pid: number | null, start: string | null, what: string) => { if (pid && pid > 1) out.set(pid, { start: start ? normal(start) : null, what }); };
  for (const n of db().prepare("SELECT id, worker_pid, worker_start, agent_pid, agent_start FROM nodes WHERE worker_pid > 1 OR agent_pid > 1").all() as { id: string; worker_pid: number | null; worker_start: string | null; agent_pid: number | null; agent_start: string | null }[]) {
    add(n.worker_pid, n.worker_start, `relay's worker for ${n.id}`);
    add(n.agent_pid, n.agent_start, `the agent of ${n.id}`);
  }
  for (const p of db().prepare("SELECT pid, start, kind, node_id FROM relay_procs WHERE kind = 'worker' OR node_id IS NOT NULL").all() as { pid: number; start: string; kind: string; node_id: string | null }[]) {
    add(p.pid, p.start, p.kind === "worker" ? `relay's worker${p.node_id ? ` for ${p.node_id}` : ""}` : `the relay server of ${p.node_id}`);
  }
  return out;
}

/**
 * The process-group / session leaders relay launched, by leader pid, each with what it is and the
 * leader's start time when recorded. Kept for the run's lifetime (db.ts launch_leaders), so these
 * match even after the leader has died.
 */
function leaders(): Map<number, { what: string; start: string | null }[]> {
  // Every recorded leader at each pid, across runs and within one: a pid can have led more than once.
  const out = new Map<number, { what: string; start: string | null }[]>();
  for (const l of launchLeaders()) {
    if (l.leader_pid <= 1) continue;
    const entry = { what: l.kind === "worker" ? `relay's worker${l.node_id ? ` for ${l.node_id}` : ""}` : `the agent of ${l.node_id ?? "a launched job"}`, start: l.start ? normal(l.start) : null };
    out.set(l.leader_pid, [...(out.get(l.leader_pid) ?? []), entry]);
  }
  return out;
}

/**
 * Why this process is (or may be) inside a relay-launched agent's process tree, or null. Checked
 * against what relay recorded, whichever of these holds:
 * - an environment marker relay sets on launched agents;
 * - an ancestor, by parentage, is a process relay launched (launchedProcesses), matched by pid and
 *   start time while it is alive;
 * - this process's group or session is one relay launched (launch_leaders, kept for the run's
 *   lifetime). Workers and agents are started detached, each leading its own session and group,
 *   which their descendants keep even once the leader has died and they are reparented to launchd.
 *   The group/session id is a bare number, so it matches the recorded leader id even when the
 *   leader is gone — unless a live process now holds that pid with a start time matching none of
 *   those recorded for it (and none is unknown), which means the old group/session is gone and the
 *   pid was reused: XNU never allocates a pid that is
 *   still in use as a process-group or session id (bsd/kern/kern_fork.c `forkproc`, the
 *   "Find an unused PID" loop skips a candidate when `pghash_exists_locked(pid)` or
 *   `session_find_locked(pid)` holds), so a reallocated pid proves the leader's group/session ended.
 * An unreadable process table or session id counts as inside: what relay cannot inspect is not
 * taken for the person's own terminal.
 */
const realProbe: PresenceProbe = { table: processTable, sid: sessionId };

export function launchedTree(env: NodeJS.ProcessEnv = process.env, probe: PresenceProbe = realProbe): string | null {
  const marker = launchMarker(env);
  if (marker) return `its environment carries ${marker}, which relay sets on the agents it launches`;
  const table = probe.table();
  if (!table) return "relay could not read the process table to tell whether it runs inside a launched agent's process tree";
  const sid = probe.sid();
  if (sid === null) return "relay could not read its session id to tell whether it runs inside a launched agent's process tree";
  const self = probe.self ?? process.pid;
  const launched = launchedProcesses();
  const recordedLeaders = leaders();
  if (!launched.size && !recordedLeaders.size) return null;
  // Ancestry: a live launched process, matched by pid and start time.
  const liveAncestor = (pid: number) => {
    const known = launched.get(pid), row = table.get(pid);
    return known && row && (!known.start || known.start === row.start) ? known.what : null;
  };
  const seen = new Set<number>();
  for (let pid = table.get(self)?.parent ?? process.ppid; pid > 1 && !seen.has(pid); pid = table.get(pid)?.parent ?? 0) {
    seen.add(pid);
    const what = liveAncestor(pid);
    if (what) return `it was started inside the process tree of ${what} (pid ${pid})`;
  }
  // Group and session: a recorded leader id. A live process at that pid whose start matches no
  // recorded start means the pid was reused and the old group/session is gone (XNU note above).
  // It matches when nothing is alive at that pid, when the live process's start equals any start
  // recorded for the pid, or when any recorded start is unknown — so no recorded launched leader
  // that is still alive can be missed.
  const byLeader = (id: number) => {
    const entries = recordedLeaders.get(id);
    if (!entries?.length) return null;
    const row = table.get(id);
    if (!row) return entries[0].what;
    return entries.find((e) => e.start === null || e.start === row.start)?.what ?? null;
  };
  const group = table.get(self)?.pgid;
  const byGroup = group ? byLeader(group) : null;
  if (byGroup) return `it is in the process group of ${byGroup} (leader pid ${group})`;
  const bySession = byLeader(sid);
  if (bySession) return `it is in the session of ${bySession} (leader pid ${sid})`;
  return null;
}

// No 0/O or 1/I/L: the person reads it off the screen and types it.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function oneTimeCode(length = 6): string {
  return Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

/** Null when stdin and stdout are both an interactive terminal; otherwise why not. */
export function terminalProblem(): string | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return `standard ${!process.stdin.isTTY ? "input" : "output"} is not an interactive terminal`;
  }
  return null;
}

/**
 * Shows `review`, prints a fresh code for this one request and waits for one line. True only when
 * the line is that code (case and surrounding spaces aside). The code lives in this process alone,
 * for this request: it cannot be reused for another request or another run of the command.
 */
export async function personTypesCode(requestId: string, review: string[], code = oneTimeCode()): Promise<boolean> {
  for (const line of review) process.stdout.write(`${line}\n`);
  process.stdout.write(`To allow ${requestId}, type the code ${code} and press Return. Anything else leaves it pending: `);
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  let answer: string | null = null;
  for await (const line of input) { answer = line; break; }
  input.close();
  process.stdout.write("\n");
  return answer !== null && answer.trim().toUpperCase() === code;
}
