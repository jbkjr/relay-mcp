// The root server's regular look at its runs, while it lives: approval requests are put to the
// user where the host can ask, events are recorded, and each event that no call of the session is
// waiting on gets a notice where the host takes notices. A tool result carries the events the
// session has not been given (pendingEvents).
import { claimElicitation, decide, elicitationState, endElicitation, getRequest, logElicitation, ownedPending } from "./approvals.js";
import { ownsRun, type ElicitAnswer, type Instance, type Json } from "./caller.js";
import { db, getNode, now, reap, registryMark, sameMark, type RegistryMark } from "./db.js";
import { REPORTED_COMPLETION, type ReportedCompletion } from "./reported.js";
import { claimNotice, noticeText, recordEvents, recordLateAnswer, unseenEvents } from "./events.js";
import { signedNotice } from "./notices.js";
import { escalationDecisionAuthentication } from "./escalation-authority.js";
import { refreshEscalationPersonPath } from "./escalation-contract.js";

// Asking the user

/**
 * Puts every pending approval request in this root session's runs to the user through the host,
 * as soon as it is filed, and withdraws questions decided elsewhere meanwhile. Called by the root
 * server on a timer while it lives, and by every wait. Each request is asked once: a question the
 * user closed is not asked again, by this server or by one started after it.
 */
export function watchRequests(inst: Instance, o: { beat?: boolean } = {}): void {
  if (inst.singletonViolation) return;
  // Every run this session owns, its default or one taken over, is in since.
  if (inst.ctx.kind !== "root" || !inst.since.size) return;
  if (o.beat !== false) beat(inst);
  for (const [id, ctl] of inst.asking) if (getRequest(id)?.status !== "pending") ctl.abort();
  for (const r of ownedPending(inst.token)) {
    if (inst.asking.has(r.id)) continue;
    if (!inst.host.elicit) {
      if (!inst.noted.has(r.id)) {
        inst.noted.add(r.id);
        logElicitation({ request: r.id, action: "not asked", reading: inst.host.noElicit ?? "the host has not finished starting" });
      }
      continue;
    }
    if (!claimElicitation(r.id, inst.token)) continue;
    const ctl = new AbortController();
    inst.asking.set(r.id, ctl);
    void inst.host.elicit(r, ctl.signal)
      .catch((err: Error): ElicitAnswer => ({ reading: "error", outcome: String(err?.message ?? err).slice(0, 120) }))
      .then((a) => {
        inst.asking.delete(r.id);
        if (inst.singletonViolation || !ownsRun(inst, r.run_id)) return endElicitation(r.id, inst.token, `late after ownership changed: ${a.outcome}`, "withdrawn");
        if (a.reading !== "decided") return endElicitation(r.id, inst.token, a.outcome, a.reading);
        if (!("error" in decide(r.id, a.allow, "user", a.note, a.forJob ? "job" : "once", escalationDecisionAuthentication(r, "person-dialog", inst)))) return endElicitation(r.id, inst.token, a.outcome, a.reading);
        // Decided elsewhere (or closed) in the moment before relay would have withdrawn the
        // question: the answer came too late to decide anything, and is reported as such.
        const said = a.outcome === "decline" ? "decline" : !a.allow ? "deny" : a.forJob ? "allow for the rest of this job" : "allow";
        endElicitation(r.id, inst.token, `late: ${said}`, "withdrawn");
        logElicitation({ request: r.id, action: "late", reading: `${said} crossed a decision made elsewhere: changed nothing` });
        lateAnswer(r.id, said, "user");
      })
      .catch(() => {
        // The registry may be gone (a test cleaning up); nothing is waiting on this.
      });
  }
}

/**
 * A question was answered after the request was decided elsewhere (a host that keeps a withdrawn
 * form, see HostView.formStays, or an answer crossing a decision made elsewhere): nothing changes,
 * and the root agent is told whose answer it was (see recordLateAnswer).
 */
export function lateAnswer(requestId: string, said: string, by: "user" | "host"): void {
  const r = getRequest(requestId);
  if (r && r.status !== "pending") recordLateAnswer(r, said, by);
}

// Events

/** How often a root server's watch looks for jobs whose worker has died. */
const REAP_EVERY_MS = 5000;
/**
 * How often the watch renews the person route's heartbeat, which lasts 5 s
 * (escalation-person-path.ts): about once a second, whatever the watch's own tick (mcp/server.ts).
 */
const BEAT_EVERY_MS = 900;
const beaten = new WeakMap<Instance, { at: number; confirm: boolean; dialog: boolean }>();
const qualified = (inst: Instance) => ({ confirm: inst.host.confirmTool === true, dialog: inst.host.personDialog === true && !!inst.host.elicit });

/** Renews the person route's heartbeat for this root session (escalation-person-path.ts). */
function beat(inst: Instance): void {
  const q = qualified(inst);
  beaten.set(inst, { at: now(), ...q });
  refreshEscalationPersonPath(inst.token, q);
}
/** Due once a second, and at once when what the host is qualified for has changed (a demotion withdraws the heartbeat). */
function beatDue(inst: Instance): boolean {
  const last = beaten.get(inst), q = qualified(inst);
  return !last || now() - last.at >= BEAT_EVERY_MS || last.confirm !== q.confirm || last.dialog !== q.dialog;
}

/**
 * What each root session's last full look went by: the registry's change mark (registryMark: other
 * connections' commits as they stood when the look began, this connection's own changes as they
 * stood when it ended), the host view, and the session's own state that the look reads. While all of
 * them are the same, nothing the look reads has changed, and a look would find nothing to record,
 * ask or post.
 */
const looked = new WeakMap<Instance, { mark: RegistryMark; host: Instance["host"]; state: string; open: boolean }>();

/** What of a root session's own state (not in the registry) its look reads. handedOff only grows. */
const sessionState = (inst: Instance): string =>
  JSON.stringify([[...inst.since], [...inst.asking.keys()], [...inst.waiting].map(([k, w]) => [k, w.runId, [...w.items]]), inst.handedOff.size]);

/**
 * True while nothing a look at this session's runs reads has changed since its last one. A question
 * still open on a pending request of these runs counts as a change: whether its asker is alive (and
 * so whether it is asked again, or handed to the agent) is not written anywhere when it dies.
 */
function unchanged(inst: Instance): boolean {
  const last = looked.get(inst);
  return Boolean(last && !last.open && last.host === inst.host && sameMark(last.mark, registryMark()) && last.state === sessionState(inst));
}

/** Whether a question is open on a pending request of this session's runs (written in the registry, so known for as long as its mark holds). */
function openQuestion(inst: Instance): boolean {
  const runs = [...inst.since.keys()];
  return runs.length > 0 && Boolean(db().prepare(`SELECT 1 FROM elicitations e JOIN requests r ON r.id = e.request_id WHERE e.outcome IS NULL AND r.status = 'pending' AND r.run_id IN (${runs.map(() => "?").join(", ")}) LIMIT 1`).get(...runs));
}

/**
 * The root server's regular look at its runs, on a timer while it lives: approval requests are put
 * to the user, events are recorded, and each event no call of this session is waiting on gets a
 * notice, once, where the host takes notices. A tick that finds nothing changed since the last look
 * (unchanged) does only what goes by the clock: the person route's heartbeat (beat) and the reap of
 * jobs whose worker has died; and looks after all if that reap changed anything.
 */
export function watch(inst: Instance): void {
  if (inst.singletonViolation) return;
  if (unchanged(inst)) {
    if (inst.ctx.kind !== "root" || !inst.since.size) return;
    if (beatDue(inst)) beat(inst);
    reapDue(inst);
    if (unchanged(inst)) return;
  }
  const begun = registryMark();
  look(inst);
  looked.set(inst, { mark: { ...begun, own: registryMark().own }, host: inst.host, state: sessionState(inst), open: openQuestion(inst) });
}

/** Every few seconds, the jobs of the session's runs whose worker has died are marked lost (reap). */
function reapDue(inst: Instance): void {
  // A job whose worker died settles (as lost) only when someone looks: look every few seconds, so
  // that it becomes an event whether or not any call asks about it.
  if (now() - (inst.reapedAt ?? 0) >= REAP_EVERY_MS) {
    inst.reapedAt = now();
    for (const runId of inst.since.keys()) reap(runId);
  }
}

function look(inst: Instance): void {
  for (const id of inst.since.keys()) if (!ownsRun(inst, id)) inst.since.delete(id);
  watchRequests(inst, { beat: beatDue(inst) });
  if (inst.ctx.kind !== "root" || !inst.since.size) return;
  reapDue(inst);
  recordEvents(inst.since, (id) => inst.asking.has(id) || elicitationState(id) === "asking");
  if (!inst.host.notice) return;
  const waits = [...inst.waiting.values()];
  for (const e of unseenEvents([...inst.since.keys()])) {
    // A person's decision is for the agent's next result; the person knows already.
    if (e.noticed_at || e.kind === "decided") continue;
    // A call waiting on the item gets the news in its result; one waiting anywhere in the run is
    // handed a new approval request when it returns.
    const covered = waits.some((w) => w.runId === e.run_id && (e.kind === "approval"
      ? !inst.handedOff.has(e.subject) : w.items.has(e.item_id) || w.items.has(e.subject)));
    if (covered) continue;
    if (e.kind === "approval" && getRequest(e.subject)?.status !== "pending") continue;
    if (claimNotice(e.id)) inst.host.notice(signedNotice(inst, e), e.id);
  }
}

const ID = /^[jtpdrq]_[0-9a-f]{8}$/;
/** Fields of relay's own results that name the items and requests a result reports on. */
const ITEM_FIELDS = ["id", "job_id", "thread_id", "discussion_id", "review_id", "reviewer_job", "participant", "request_id"];

/**
 * The items and requests a result reports on, read only from the fields relay itself fills (ids
 * of the item, its children and the run's items, and requests in needs_approval), never from text
 * that came from an agent (its result, reply or task), which could name any id.
 */
function reportedIn(result: Json): Set<string> {
  const out = new Set<string>();
  const take = (v: unknown) => {
    if (typeof v === "string" && ID.test(v)) out.add(v);
  };
  for (const k of ITEM_FIELDS) take(result[k]);
  for (const list of ["nodes", "children"]) {
    for (const n of Array.isArray(result[list]) ? (result[list] as Json[]) : []) take(n?.id);
  }
  for (const r of Array.isArray(result.needs_approval) ? (result.needs_approval as Json[]) : []) take(r?.request_id);
  for (const id of Array.isArray(result.cancelled) ? result.cancelled : []) take(id);
  return out;
}

/**
 * The events a root session's tool result is to carry: every event of its runs it has not been
 * given yet, except those about items the result itself reports on, and approval requests no longer
 * pending. `given` is every event the result settles, to be marked seen once the result is delivered.
 */
export function pendingEvents(inst: Instance, result: Json): { events: Json[]; given: number[] } {
  if (inst.singletonViolation) return { events: [], given: [] };
  for (const id of inst.since.keys()) if (!ownsRun(inst, id)) inst.since.delete(id);
  if (inst.ctx.kind !== "root" || !inst.since.size) return { events: [], given: [] };
  recordEvents(inst.since, (id) => inst.asking.has(id) || elicitationState(id) === "asking");
  const named = reportedIn(result);
  const views = [result, ...["nodes", "children"].flatMap((k) => Array.isArray(result[k]) ? result[k] as Json[] : [])];
  const completed = views.map((v) => (v as Json & { [REPORTED_COMPLETION]?: ReportedCompletion })[REPORTED_COMPLETION]);
  const events: Json[] = [];
  const unseen = unseenEvents([...inst.since.keys()]);
  for (const e of unseen) {
    // A person's decision is reported only by a result that names the request: one about the job
    // that asked does not say who decided.
    // A late answer is news whatever the result is about.
    if (e.kind === "settled") {
      // Reply events name the discussion/review and its participant separately. Generic node
      // listings convey no reply, so keep that news explicit even if both ids are in the result.
      // For ordinary completions the delivered snapshot must show the same settled state.
      const node = getNode(e.subject);
      if (e.item_id === e.subject && completed.some((v) => v?.id === e.subject && v.status === node?.status && v.endedAt === node?.ended_at)) continue;
    } else if (e.kind !== "late" && named.has(e.subject)) continue;
    if (e.kind === "approval" && getRequest(e.subject)?.status !== "pending") continue;
    events.push({ event_id: e.id, kind: e.kind, item: e.item_id, about: e.subject, notice: noticeText(e) });
  }
  return { events, given: unseen.map((e) => e.id) };
}
