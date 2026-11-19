// Explicit recovery for process-scoped 1.0 runs. This is an administrative handoff,
// not a conversation-key adapter or a durable logical-session membership system.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { relayHome } from "./config.js";
import { db, getNode, getRun, runNodes, tx, type RunRow } from "./db.js";
import { ownsRun, refused, UNAVAILABLE, type Instance, type Json, type ToolCall } from "./caller.js";
import { fingerprint } from "./identity.js";
import { pidAlive, procStart, sameProcess } from "./procs.js";
import { writeProblem } from "./storage.js";

const digest = (s: string | null) => crypto.createHash("sha256").update(s ?? "unassigned").digest("hex");
const valid = (run: string, to: string) => /^run_[0-9a-f]{8}$/.test(run) && /^[0-9a-f]{24}$/.test(to);
const ticketPath = (run: string, to: string) => path.join(relayHome(), "adoptions", `${run}-${to}.json`);
interface Ticket { run: string; to: string; previous_owner: string; approved_at: number }
// An unreadable start time is not evidence that a live owner died. A different known start
// time is PID reuse; legacy owners without a token still count as owners while alive.
export const ownerOpen = (run: RunRow) => pidAlive(run.root_pid) && (!run.root_start || !procStart(run.root_pid) || sameProcess(run.root_pid, run.root_start));

/** Recovery lookup belongs to the explicit authorization path, never normal item access. */
export const adoptionRun = (id: string): RunRow | undefined =>
  getRun(id.startsWith("run_") ? id : getNode(id)?.run_id ?? "") ?? undefined;

/** Called only by the administrative CLI after the person types the printed exact transfer. */
export function authorizeAdoption(id: string, to: string): Json {
  const run = adoptionRun(id);
  if (!run) return UNAVAILABLE();
  const runId = run.id;
  if (!valid(runId, to)) return UNAVAILABLE();
  if (ownerOpen(run)) return refused("the run's owning connection is still open. Close it before transferring its authority.");
  const file = ticketPath(runId, to);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ run: runId, to, previous_owner: digest(run.root_token), approved_at: Date.now() } satisfies Ticket), { mode: 0o600 });
  } catch (err) {
    // A full disk, or a control directory that is not writable: said, with what to do, not thrown at the terminal.
    return { authorized: false, error: `${writeProblem(file, err, "no transfer was authorized")}.` };
  }
  return { authorized: true, run_id: runId, into_session: to, note: "Call adopt from that connection within ten minutes. No authority changes until it consumes this one-use authorization." };
}

export function adopt(inst: Instance, id: string, to: string, call: ToolCall = {}, description?: { in_directory?: string; item_count?: number }): Json {
  if (inst.ctx.kind !== "root" || call.codexSubagent) return refused("only a person's root connection can take over a run.");
  if (to !== fingerprint(inst)) return UNAVAILABLE();
  const run = adoptionRun(id);
  if (!run) return UNAVAILABLE();
  const runId = run.id;
  if (!valid(runId, to)) return UNAVAILABLE();
  const file = ticketPath(runId, to);
  let ticket: Ticket | undefined;
  try { ticket = JSON.parse(fs.readFileSync(file, "utf8")) as Ticket; } catch { /* Qualified permission prompt may authorize instead. */ }
  const prompted = inst.host.confirmTool === true;
  return tx(() => {
    const current = getRun(runId);
    if (!current) return UNAVAILABLE();
    if (ownsRun(inst, runId)) return { adopted: true, run_id: runId, into_session: to };
    // A concurrent winner, including one committed before our first read, takes precedence
    // over a stale ticket's refusal. All ownership and authorization checks share this lock.
    const changed = current.root_token !== run.root_token;
    const open = ownerOpen(current);
    const issued = ticket?.run === runId && ticket.to === to
      && typeof ticket.approved_at === "number" && Number.isFinite(ticket.approved_at)
      && ticket.approved_at <= Date.now() && Date.now() - ticket.approved_at < 600_000;
    if (changed || open) {
      // A person-issued ticket can explain a competing transfer. Ticketless callers and
      // permission prompts must not distinguish a live/changed run from an unknown one.
      if (prompted || !issued) return UNAVAILABLE();
      return refused(changed ? "the run's ownership changed during adoption. Close its owning connection before trying again."
        : "the run's owning connection is still open. Close it before transferring its authority.");
    }
    const authorized = issued && ticket!.previous_owner === digest(current.root_token);
    // Never disclose expected descriptions: unknown, live and mismatched orphaned runs
    // all return the same reply on the permission-prompt path.
    if (prompted && !authorized && (description?.in_directory !== current.root_cwd || description?.item_count !== runNodes(runId).length)) return UNAVAILABLE();
    if (!prompted && !authorized) return UNAVAILABLE();
    const won = db().prepare("UPDATE runs SET root_token = ?, root_pid = ?, root_start = ? WHERE id = ? AND root_token IS ?")
      .run(inst.token, process.pid, procStart(process.pid), runId, current.root_token);
    if (Number(won.changes) !== 1) return UNAVAILABLE();
    if (!ownsRun(inst, inst.runId) || getRun(inst.runId!)?.status === "cancelled") inst.runId = runId;
    inst.since.set(runId, current.created_at);
    if (authorized) fs.renameSync(file, `${file}.used`);
    return { adopted: true, run_id: runId, into_session: to, rights: "supervision", effect: "Took over this run's jobs, approval requests and events.", confirmed_by: authorized ? "terminal" : "host permission prompt" };
  });
}

/**
 * The transfer authorizations `relay adopt` wrote for a run, taken up (`.used`) or not, which go
 * with its records when keep_records_days forgets it (retention.ts); and whether one is still
 * waiting to be taken up, written less than ten minutes ago as adopt takes them, which keeps the
 * run. A directory of them that cannot be read is thrown, so that the run is kept.
 */
export function adoptionTickets(runId: string): { files: string[]; waiting: boolean } {
  const dir = path.join(relayHome(), "adoptions");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { files: [], waiting: false };
    throw new Error(`relay could not look for transfers of it that relay adopt authorized in ${dir} (${(err as Error).message})`);
  }
  const files = names.filter((n) => n.startsWith(`${runId}-`) && /\.json(?:\.used)?$/.test(n)).map((n) => path.join(dir, n));
  const waiting = files.some((f) => {
    if (f.endsWith(".used")) return false;
    const st = fs.statSync(f, { throwIfNoEntry: false });
    return st !== undefined && Date.now() - st.mtimeMs < 600_000;
  });
  return { files, waiting };
}
