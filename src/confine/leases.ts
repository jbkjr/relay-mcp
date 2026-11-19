import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { relayHome } from "../core/config.js";
import { procStart, sameProcess } from "../core/procs.js";

// Stage 2's port leases as files (ports.ts leaseTurnPorts): what a lease file says, who holds it, and
// how a port changes hands. A leaf of ports.ts with light imports, so that the registry's reap
// (core/db.ts, through core/stage2-executors.ts) can give back an orphaned executor's leases without
// loading the rest of the confinement code.
//
// A port's lease is a numbered file, `<port>.<generation>`; the newest generation is the lease. A
// port is taken by creating the generation after the one judged free, with O_EXCL: of the relay
// processes that judged the same lease free, exactly one creates the next file, and one that judged
// an older generation creates a file that is not the newest and backs off. The newest file is never
// removed (a release marks it released), so a generation is never made twice. Older ones are removed
// by whoever finds them. (Before, a lease judged stale was removed and the port claimed under one
// name: a process that judged it stale, then removed it after another had already taken it back,
// removed that one's fresh lease, and both held the port. Review R6.)

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const norm = (start: string) => start.replace(/\s+/g, " ");

/**
 * A lease file: the leasing process on the first line (its pid and start time; a lease from before
 * start times has the pid alone), or `released`; then one line per other holder (`hold`): its pid and
 * start time, so that a pid given to another process since never keeps it; and `record <path>` for
 * the executor's record (core/stage2-executors.ts), which holds the lease while the file is there:
 * a record kept because its executor's teardown was not sure everything stopped quarantines the
 * ports until a later clean sweep removes it.
 */
export interface LeaseFile {
  leaser: { pid: number; start: string | null } | null;
  holders: { pid: number; start: string }[];
  records: string[];
}

export function parseLease(text: string): LeaseFile {
  const [first, ...rest] = text.split("\n");
  const holders: { pid: number; start: string }[] = [];
  const records: string[] = [];
  for (const line of rest) {
    const r = /^record (\/.+)$/.exec(line.trim());
    if (r) {
      records.push(r[1]);
      continue;
    }
    const m = /^(\d+) (.+)$/.exec(line.trim());
    if (m) holders.push({ pid: Number(m[1]), start: m[2] });
  }
  const m = /^(\d+)(?: (.+))?$/.exec(first.trim());
  return { leaser: m ? { pid: Number(m[1]), start: m[2] ?? null } : null, holders, records };
}

/**
 * Whether anyone still holds a lease: its leasing process is still that process, a holder (but
 * `but`) is, or an executor record it names is still there. A released lease keeps its holder and
 * record lines, so a record still quarantines it. Unreadable leases are held by no one.
 */
export const leaseHeld = (l: LeaseFile, but?: { pid: number; start: string }): boolean =>
  Boolean(l.leaser && l.leaser.pid > 0 && (l.leaser.start ? sameProcess(l.leaser.pid, l.leaser.start) : alive(l.leaser.pid)))
  || l.holders.some((h) => !(but && h.pid === but.pid && h.start === but.start) && sameProcess(h.pid, h.start))
  || l.records.some((f) => fs.existsSync(f));

/** A port's lease file name: `<port>.<generation>`; `<port>` alone, from before generations, is generation 0. */
const NAME = /^(\d+)(?:\.(\d+))?$/;
export const leaseFile = (dir: string, port: number, gen: number) => path.join(dir, gen ? `${port}.${gen}` : String(port));

/** Each port's newest lease generation, and the older files beside it. */
function generations(dir: string): Map<number, { gen: number; older: number[] }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const out = new Map<number, { gen: number; older: number[] }>();
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    const port = Number(m[1]), gen = Number(m[2] ?? 0);
    const cur = out.get(port);
    if (!cur) out.set(port, { gen, older: [] });
    else if (gen > cur.gen) out.set(port, { gen, older: [...cur.older, cur.gen] });
    else cur.older.push(gen);
  }
  return out;
}

function readLease(file: string): LeaseFile | null {
  try {
    return parseLease(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** What a look at the leases found: for each port, the generation to take it from, or that it is held. */
export interface LeaseLook {
  held: Set<number>;
  /** For each port not held: the newest generation, which a claim must follow (0: none yet). */
  free: Map<number, number>;
}

/** Looks at the leases of these ports, removing the older generations it finds (never the newest). */
export function lookLeases(dir: string, ports: number[]): LeaseLook {
  const gens = generations(dir);
  const held = new Set<number>();
  const free = new Map<number, number>();
  for (const p of ports) {
    const g = gens.get(p);
    if (!g) {
      free.set(p, 0);
      continue;
    }
    for (const old of g.older) fs.rmSync(leaseFile(dir, p, old), { force: true });
    const lease = readLease(leaseFile(dir, p, g.gen));
    // A lease that vanished under the look was an older generation by now: look again next time.
    if (!lease) held.add(p);
    else if (leaseHeld(lease)) held.add(p);
    else free.set(p, g.gen);
  }
  return { held, free };
}

/** This process, as a lease names its leaser. */
function me(): string {
  const start = procStart(process.pid);
  return start ? `${process.pid} ${norm(start)}` : String(process.pid);
}

/**
 * Takes `port`, judged free at generation `gen`: creates generation gen + 1 with O_EXCL, then checks
 * it is the newest. Returns its file, or null when another process took the port first.
 */
export function takePort(dir: string, port: number, gen: number): string | null {
  const file = leaseFile(dir, port, gen + 1);
  // Made whole beside it and linked into place (link fails if the name exists): no look ever reads
  // the new generation empty, and so free.
  const tmp = path.join(dir, `.${port}.${gen + 1}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, `${me()}\n`, { flag: "wx", mode: 0o600 });
    fs.linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  // Judged from a generation since superseded (its successor removed as older): not the lease.
  const now = generations(dir).get(port);
  if (now?.gen !== gen + 1) {
    fs.rmSync(file, { force: true });
    return null;
  }
  for (const old of now.older) fs.rmSync(leaseFile(dir, port, old), { force: true });
  return file;
}

/** Rewrites a lease file whole (a temp file beside it, renamed into place). */
function rewrite(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** The lines after the leaser's: holders and records, kept by a release. */
const holderLines = (l: LeaseFile) => [...l.holders.map((h) => `${h.pid} ${h.start}\n`), ...l.records.map((f) => `record ${f}\n`)].join("");

/**
 * Marks a lease this process took released, if it is still this process's. The file stays, as the
 * port's newest generation, and so do its holder and record lines: a holder still running, or a
 * record still there, keeps the port from being leased again.
 */
export function releaseOwn(file: string): void {
  try {
    const l = readLease(file);
    if (l?.leaser?.pid === process.pid) rewrite(file, `released\n${holderLines(l)}`);
  } catch {
    // Already gone, or unreadable: it holds nothing.
  }
}

/** Names another process (pid and start time), and optionally its record, as holding a lease this process took. */
export function addHolder(file: string, pid: number, start: string, record?: string): void {
  fs.appendFileSync(file, `${pid} ${norm(start)}\n${record && path.isAbsolute(record) && !/\n/.test(record) ? `record ${record}\n` : ""}`);
}

const leaseDir = (o: { dir?: string }) => o.dir ?? path.join(relayHome(), "ports");

/**
 * Gives back the leases `holder` (an executor, by pid and start time) was named on (PortLease.hold)
 * once nobody else holds them: for a relay process cleaning up after an executor whose own relay
 * process died (core/stage2-executors.ts), once the holder has stopped: nothing is given back while
 * it still runs, nor while its record is still there (remove the record first). A lease whose
 * leasing process still runs is left for that process to release. Returns the ports given back.
 */
export function releaseLeasesOf(holder: { pid: number; start: string }, o: { dir?: string } = {}): number[] {
  const dir = leaseDir(o);
  const want = { pid: holder.pid, start: norm(holder.start) };
  // Still running: not to be given back, whatever the caller thought.
  if (sameProcess(want.pid, want.start, { fresh: true })) return [];
  const out: number[] = [];
  for (const [port, g] of generations(dir)) {
    const file = leaseFile(dir, port, g.gen);
    const lease = readLease(file);
    if (!lease?.leaser || !lease.holders.some((h) => h.pid === want.pid && h.start === want.start)) continue;
    if (leaseHeld(lease, want)) continue;
    rewrite(file, `released\n${holderLines(lease)}`);
    out.push(port);
  }
  return out.sort((a, b) => a - b);
}

/** Whether a port's lease is held now (for tests and diagnostics). */
export function portHeld(port: number, o: { dir?: string } = {}): boolean {
  return lookLeases(leaseDir(o), [port]).held.has(port);
}
