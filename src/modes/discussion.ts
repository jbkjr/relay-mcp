// A discussion: the calling agent and one agent of the other family. Relay launches only the other
// side, passes each message verbatim, keeps the transcript, and says when it is over. A review's
// reconciliation is a discussion with its reviewer (modes/review.ts), which it ends.
import fs from "node:fs";
import { refusalNote, type VendorRefusal } from "../core/refusal.js";
import { recordStart, addContribution, callerLabel, familiesOf } from "../core/families.js";
import { describeSide } from "../core/steering.js";
import path from "node:path";
import type { Grant } from "../backends/types.js";
import {
  admitExisting, admitNew, admitSpeed, admitWork, authority, callerSide, changeSpeed, familyOf, grantOf, knownCaller, refused,
  type Caller, type Instance, type Json, type ToolCall,
} from "../core/caller.js";
import { noteCall } from "../core/calls.js";
import { holdsServers } from "../core/extensions.js";
import { persistentGrant } from "../core/caller.js";
import { recordEnvironmentRequest } from "../core/env-broker.js";
import { runDir, type Speed, type Target } from "../core/config.js";
import { ACTIVE, busy, db, getNode, getTurn, insertNode, newId, now, runConfig, setParam, speedAfter, tx, turnSettled, updateNode, workerLive, type NodeRow } from "../core/db.js";
import { dispatch, queueTurn } from "../core/dispatch.js";
import { discussionParams, reviewParams, type DiscussionParams } from "../core/params.js";
import { contextBlock, discussionOpening, HUMAN_LABEL, parseMarker, ROLE_PRESETS, type Marker } from "../core/prompts.js";
import { denialsOf, recordOwnOutcome } from "../core/outcome.js";
import { CALLER_LABEL, targetDef, targetLabel } from "../targets/index.js";
import { keepRecord } from "../core/storage.js";
import { notesView, pendingHandle, runRecovery, speedView } from "../core/views.js";
import { waitOpts, waitUntil } from "../core/wait.js";
import { finishReview, openReviewOf, reviewOnly } from "./review.js";

/**
 * A discussion or review recorded by the first relay, which launched both sides itself: it has no
 * target and none of the fields this version keeps (the participant or reviewer, the side labels).
 * It is shown as stored and never continued.
 */
export function legacyTwoSided(n: NodeRow): boolean {
  if (n.kind !== "discussion" && n.kind !== "review") return false;
  let p: { participant?: unknown; reviewer?: unknown; state?: unknown } | null;
  try {
    p = JSON.parse(n.params_json ?? "null");
  } catch {
    return true;
  }
  return n.kind === "discussion" ? typeof p?.participant !== "string" || !p?.state : typeof p?.reviewer !== "string";
}
export const LEGACY_NOTE = "This item was recorded by an earlier relay that launched both sides itself; it is shown as stored and cannot be continued.";
export const legacyRefusal = (n: NodeRow) => ({ error: `${n.id} was recorded by an earlier relay that launched both sides itself, so it cannot be continued. Start a new ${n.kind} instead.` });

export interface DiscussArgs {
  message: string; topic?: string; discussion_id?: string; target?: Target;
  /** An existing session of the other family (a job or thread) to hold the discussion with, keeping what it knows. */
  with?: string;
  context?: string[]; role?: string; max_turns?: number; model?: string; effort?: string;
  /** The speed of the other side's session: the one this call starts, or, given, the speed it goes on at (caller.ts admitSpeed). */
  speed?: Speed;
  allow_delegation?: boolean; cwd?: string; grant?: Grant;
  /** Names a call that starts a discussion (see calls.ts). Not used when continuing one. */
  request_id?: string;
}

/** The participant's side label. In an older row it is the participant session's target. */
export const otherSide = (p: DiscussionParams): string => p.other ?? getNode(p.participant)?.target ?? CALLER_LABEL;
/** Marks a message as taken while its turn is being queued. */
const RESERVED = -1;
const cruxOf = (m?: Marker) => (m?.kind === "CRUX" ? m.text : null);
/** A side's last marker as it wrote it ("AGREE: …", "CRUX: …", "CONTINUE"), or null for none. */
const positionOf = (m?: Marker) => (!m || m.kind === "NONE" ? null : m.kind === "CONTINUE" ? "CONTINUE" : `${m.kind}: ${m.text}`);
const DISCUSS_NEXT =
  "Answer with discuss (discussion_id and message). End each message with CONTINUE, AGREE: <the conclusion>, or CRUX: <what you cannot agree on>, on its own line. " +
  "It ends when you both write AGREE in a row, or when you write CRUX and the other has answered.";

type Ending = { outcome: "agree"; conclusion: string; closer: string } | { outcome: "no_agreement" } | { outcome: "error"; error: string } | { outcome: "refused"; error: string; refusal: VendorRefusal };

/**
 * Adds to a discussion's transcript. The discussion itself is in the registry, so a transcript that
 * cannot be written (a full disk, say) does not stop it: the first failure is a warning in its
 * result, and relay goes on trying for later turns.
 */
function transcribe(file: string, p: DiscussionParams, text: string, o: { start?: boolean } = {}): void {
  const problem = keepRecord(file, text, { append: !o.start, consequence: "the transcript is incomplete, though the discussion itself is in the registry" });
  if (problem && !p.state.warnings.some((w) => w.startsWith(`relay could not write ${file} `))) p.state.warnings.push(`${problem}.`);
}

function closeDiscussion(id: string, p: DiscussionParams, end: Ending): void {
  const d = getNode(id)!;
  const other = otherSide(p);
  const cruxes = { [p.caller]: cruxOf(p.state.markers[p.caller]), [other]: cruxOf(p.state.markers[other]) };
  // Each side's final position, so that an AGREE answering the other's CRUX keeps its conclusion.
  const final_positions = { [p.caller]: positionOf(p.state.markers[p.caller]), [other]: positionOf(p.state.markers[other]) };
  const agreedAtEnd = [p.caller, other].filter((side) => p.state.markers[side]?.kind === "AGREE");
  if (d.transcript_path) {
    transcribe(d.transcript_path, p, `\n(relay) Families: ${familiesOf(d).summary}\n`);
    transcribe(d.transcript_path, p, end.outcome === "agree" ? `\n## Outcome\n\nAGREE: ${end.conclusion}\n`
      : end.outcome === "no_agreement" ? `\n## Outcome\n\nNo agreement after ${p.state.turns} turns.\n\n${p.caller}'s crux: ${cruxes[p.caller] ?? "(none stated)"}\n\n${other}'s crux: ${cruxes[other] ?? "(none stated)"}\n${agreedAtEnd.map((side) => `\n${side}'s final position: ${final_positions[side]}\n`).join("")}`
      : `\n## Ended early\n\n${end.error}\n`);
  }
  const base = { families: familiesOf(d), transcript_path: d.transcript_path, turns: p.state.turns, participant: p.participant, ...(p.state.warnings.length ? { warnings: p.state.warnings } : {}) };
  const result: Json =
    end.outcome === "agree" ? { outcome: "agree", conclusion: end.conclusion, closed_by: end.closer, ...base }
    : end.outcome === "no_agreement" ? { outcome: "no_agreement", cruxes, final_positions, ...base }
    : { outcome: end.outcome, error: end.error, ...(end.outcome === "refused" ? { refusal: end.refusal, note: refusalNote(end.refusal), unfinished: true } : {}), cruxes, final_positions, ...base };
  updateNode(id, { result_json: JSON.stringify(result), error: end.outcome === "error" || end.outcome === "refused" ? end.error : null, ended_at: now() });
  db().prepare("UPDATE nodes SET status = ? WHERE id = ? AND status = 'open'").run(end.outcome === "refused" ? "refused" : end.outcome === "error" ? "failed" : "done", id);
  if (p.review_id) finishReview(p.review_id, id);
}

/**
 * Folds the participant's finished reply into the discussion: the transcript, its marker, and
 * whether that ends it. Returns false while the reply is still being written, or its session is
 * still recording the turn's end (db.ts turnSettled). Safe to call from anywhere, any number of times.
 */
export function settleDiscussion(id: string): boolean {
  return tx(() => {
    const d = getNode(id);
    if (!d || d.kind !== "discussion" || d.status !== "open") return true;
    const p = discussionParams(d);
    if (p.state.pending === undefined) return true;
    if (p.state.pending === RESERVED) return false;
    const t = getTurn(p.state.pending);
    const part = getNode(p.participant);
    const inFlight = Boolean(t && ["queued", "running"].includes(t.status));
    // Still coming, unless nothing is left that could produce it.
    if (inFlight && part && (workerLive(part) || ACTIVE.includes(part.status))) return false;
    // Written, but its session has not yet recorded the turn's end: the reply is taken with the
    // session settled with it (or gone on to its next turn), so that whoever reads it finds the
    // session as the reply left it.
    if (!inFlight && !turnSettled(t)) return false;
    const other = otherSide(p);
    delete p.state.pending;
    if (!t || t.status !== "done") {
      updateNode(id, { params_json: JSON.stringify(p) });
      if (t?.status === "refused" && t.refusal_json) {
        closeDiscussion(id, p, { outcome: "refused", error: t.error ?? "vendor refusal", refusal: JSON.parse(t.refusal_json) as VendorRefusal });
        return true;
      }
      closeDiscussion(id, p, { outcome: "error", error: `${other}'s turn ${!t ? "was lost" : t.status === "failed" && t.error ? `failed: ${t.error}` : `ended as ${t.status}`}` });
      return true;
    }
    const reply = t.reply ?? "";
    const marker = parseMarker(reply);
    p.state.turns++;
    p.state.last[other] = reply;
    p.state.markers[other] = marker;
    // A reply can come with a warning about processes its agent left behind.
    if (t.error) p.state.warnings.push(`${other}, turn ${p.state.turns}: ${t.error}`);
    if (t.denials) p.state.warnings.push(`${other}, turn ${p.state.turns}: was refused ${denialsOf(t).join("; ")}`);
    if (d.transcript_path) transcribe(d.transcript_path, p, `\n## Turn ${p.state.turns} — ${other}\n\n${reply.trim()}\n${marker.kind === "NONE" ? "\n(relay: no final marker found; treated as CONTINUE)\n" : ""}`);
    updateNode(id, { params_json: JSON.stringify(p) });
    const mine = p.state.markers[p.caller];
    // The second AGREE was written after reading the first, so whether the two conclusions are compatible is that side's own judgment.
    if (mine?.kind === "AGREE" && marker.kind === "AGREE") closeDiscussion(id, p, { outcome: "agree", conclusion: marker.text, closer: other });
    else if (mine?.kind === "CRUX" || (p.max_turns !== undefined && p.state.turns >= p.max_turns)) closeDiscussion(id, p, { outcome: "no_agreement" });
    return true;
  });
}

export function discussionView(id: string): Json {
  const d = getNode(id)!;
  const p = discussionParams(d);
  const other = otherSide(p);
  // Anything the user said since the caller last looked. The participant gets the same on its next turn.
  const fresh = tx(() => {
    const now_ = discussionParams(getNode(id)!);
    const rows = db().prepare("SELECT id, body FROM injections WHERE discussion_id = ? AND id > ? ORDER BY id").all(id, now_.state.shown) as { id: number; body: string }[];
    if (rows.length) {
      now_.state.shown = rows[rows.length - 1].id;
      updateNode(id, { params_json: JSON.stringify(now_) });
    }
    return rows.map((r) => r.body);
  });
  const reply = p.state.last[other];
  const result = d.result_json ? (JSON.parse(d.result_json) as Json) : {};
  // Closed by the caller's own AGREE: the other side wrote nothing after it, so there is no reply.
  // Its last message (the AGREE the caller answered) is in the transcript.
  const closedByCaller = result.outcome === "agree" && result.closed_by === p.caller;
  // The other side's speed where it is not standard, as status gives it for its session (views.ts speedView).
  const part = getNode(p.participant);
  const speed = part ? speedView(part) : null;
  return {
    discussion_id: id, ...runRecovery(d.run_id), status: d.status, with: other, participant: p.participant, ...(speed ? { speed } : {}), turns: p.state.turns,
    ...(d.target && !targetDef(d.target).qualified ? { target_label: targetLabel(targetDef(d.target)) } : {}),
    ...(closedByCaller ? { reply: null, reply_note: `Your AGREE closed the discussion, so ${other} has not replied to it. Its last message, the AGREE you answered, is in the transcript.` }
      : reply !== undefined ? { reply, marker: p.state.markers[other]?.kind ?? "NONE" } : {}),
    ...(fresh.length ? { human_messages: fresh } : {}),
    transcript_path: d.transcript_path, chat: `relay chat ${id}`,
    ...result,
    families: familiesOf(d, "discussion"),
    ...notesView(d),
    ...(d.status === "open" && p.state.pending === undefined ? { next: DISCUSS_NEXT } : {}),
  };
}

/**
 * Starts a discussion or carries one on: the calling agent's message goes to the other side, and
 * the reply comes back. ops.ts discuss, the tool, answers a repeated request_id first; a review's
 * reconciliation (`within`) calls this directly.
 */
export async function discuss(inst: Instance, a: DiscussArgs, w: ToolCall = {}, within?: { extraRules: string; reviewId: string; caller: string }): Promise<Json> {
  let id: string;
  let caller: Caller;
  /** The speed an existing session goes on at, set only once the message is taken and its turn queued (changeSpeed). */
  let respeed: Speed | undefined;
  let turnGrant: Grant | undefined;
  if (a.discussion_id) {
    const d = getNode(a.discussion_id);
    if (!d || d.kind !== "discussion") return { error: `${a.discussion_id} is not a discussion` };
    if (legacyTwoSided(d)) return legacyRefusal(d);
    const c = admitExisting(inst, d, "continue", a.cwd);
    if ("reason" in c) return refused(c.reason);
    caller = c;
    // A session borrowed for the discussion is checked again each time: it may since have been
    // given more access than the caller has.
    const dp = discussionParams(d);
    const borrowed = dp.borrowed ? getNode(dp.participant) : undefined;
    const noPart = borrowed ? authority(caller, borrowed, "carry on a discussion with") : null;
    if (noPart) return refused(noPart);
    const unknown = knownCaller(inst);
    if (unknown) return refused(unknown);
    // A speed given here is the other side's from the turn this message queues. Asked whether or not
    // the call names one: a launched agent may not carry on a session faster than itself.
    const part = getNode(dp.participant);
    if (part?.target) {
      const g = admitWork(caller, part.target, { mode: "read", grant: a.grant, kept: grantOf(part), continues: true, servers: holdsServers(part) }, w);
      if ("reason" in g) return refused(g.reason);
      turnGrant = g.grant;
      const sp = admitSpeed(caller, part.target, { speed: a.speed, current: speedAfter(part), model: part.model }, w);
      if ("reason" in sp) return refused(sp.reason);
      respeed = sp.speed;
    }
    id = d.id;
  } else {
    if (!a.topic) return { error: "a new discussion needs a topic" };
    let session: NodeRow | null = null;
    if (a.with) {
      session = getNode(a.with) ?? null;
      if (!session || !["job", "thread"].includes(session.kind) || !session.target) return { error: `${a.with} is not a job or thread id` };
    }
    const admitted = admitNew(inst, { target: a.target, model: a.model, cwd: a.cwd, existing: session });
    if ("reason" in admitted) return refused(admitted.reason);
    caller = admitted.caller;
    const to = admitted.to;
    if (session) {
      const review = openReviewOf(session);
      if (review && within?.reviewId !== review.id) return refused(reviewOnly(session, review, "bring into a discussion"));
      if (session.status === "cancelled") return refused(`${session.id} was cancelled. Resume it first, or start the discussion without it.`);
    }
    // A discussion is several turns of one session.
    const g = admitWork(caller, to.target, { mode: "read", grant: a.grant, kept: session ? grantOf(session) : undefined, continues: true, servers: holdsServers(session ?? undefined) }, w);
    if ("reason" in g) return refused(g.reason);
    turnGrant = g.grant;
    // An existing session goes on at its own speed, unless the call gives one.
    const sp = admitSpeed(caller, to.target, { speed: a.speed, current: session ? speedAfter(session) : undefined, model: session ? session.model : (to.model ?? a.model) }, w);
    if ("reason" in sp) return refused(sp.reason);
    const role = a.role ?? (session ? "peer" : "critic");
    const node = insertNode({
      id: newId("discussion"), run_id: caller.runId, parent_id: within?.reviewId ?? caller.node?.id ?? null, kind: "discussion", target: to.target, mode: "read",
      depth: caller.depth + 1, allow_delegation: a.allow_delegation ? 1 : 0, task: a.topic, cwd: caller.cwd, status: "open",
    });
    const participant = session ?? insertNode({
      id: newId("thread"), run_id: caller.runId, parent_id: node.id, kind: "thread", target: to.target, mode: "read",
      depth: caller.depth + 1, allow_delegation: a.allow_delegation ? 1 : 0, task: `discussion with ${familyOf(inst) ?? "the caller"}: ${a.topic}`, cwd: caller.cwd,
      // A session made for the discussion stays idle until its first message arrives.
      status: "done", model: to.model ?? a.model ?? null, effort: a.effort ?? null, params_json: JSON.stringify({ grant: persistentGrant(g.grant), speed: sp.speed }),
    });
    if (!session) recordStart(participant.id, inst, w, to.target, participant.model, runConfig(caller.runId));
    // Only the grant is set now, never the session's other keys from the row read above (review C11);
    // the speed, with the first message's turn.
    if (session && g.grant) setParam(session.id, "grant", persistentGrant(g.grant));
    if (session) respeed = sp.speed;
    const transcript = path.join(runDir(node.run_id), "discussions", `${node.id}.md`);
    const p: DiscussionParams = {
      topic: a.topic, role, ...(a.max_turns !== undefined ? { max_turns: a.max_turns } : {}), participant: participant.id, borrowed: Boolean(session),
      caller: within?.caller ?? callerSide(inst, to.target), other: to.target, ...(within ? { extra_rules: within.extraRules, review_id: within.reviewId } : {}),
      state: { turns: 0, opened: false, seen: 0, shown: 0, last: {}, markers: {}, warnings: [] },
    };
    try {
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
    } catch {
      // Said by the write below.
    }
    transcribe(transcript, p, `# Discussion ${node.id}\n\nTopic: ${a.topic}\n\n${targetLabel(targetDef(to.target), to.target)}: ${session ? `existing session ${session.id}` : `new session ${participant.id}`}\n`, { start: true });
    updateNode(node.id, { params_json: JSON.stringify(p), transcript_path: transcript, started_at: now() });
    recordStart(node.id, inst, w, to.target, participant.model, runConfig(caller.runId));
    // A review learns its reconciliation's id now, before anything is awaited, so that it can be
    // picked up again if the session that opened it goes away.
    if (within) {
      const r = getNode(within.reviewId);
      if (r) updateNode(r.id, { params_json: JSON.stringify({ ...reviewParams(r), discussion: node.id }) });
    }
    id = node.id;
  }

  settleDiscussion(id);
  const mine = parseMarker(a.message);
  // A marker relay could not find, or found only at the end of a line, is said, so that a closing
  // the caller meant is not passed off silently as CONTINUE.
  const markerNote = mine.kind === "NONE"
    ? "relay found no CONTINUE, AGREE: or CRUX: on a line of its own in your message, so it was taken as CONTINUE. To agree or state a crux, put the marker on its own line at the end of your next message."
    : mine.inline ? `relay read your ${mine.kind}${mine.kind === "CONTINUE" ? "" : ":"} from the end of your last line. Put the marker on its own line at the end next time.` : null;
  const noted = (out: Json): Json => (markerNote ? { ...out, marker_note: markerNote } : out);
  // The message is taken in one transaction, so two calls at once cannot both send.
  const taken = tx(() => {
    const now_ = getNode(id)!;
    if (now_.status !== "open") return "ended" as const;
    let q = discussionParams(now_);
    if (q.state.pending !== undefined) return "busy" as const;
    addContribution(id, callerLabel(inst, w));
    q = discussionParams(getNode(id)!);
    q.state.turns++;
    q.state.last[q.caller] = a.message;
    q.state.markers[q.caller] = mine;
    q.state.pending = RESERVED;
    transcribe(now_.transcript_path!, q, `\n## Turn ${q.state.turns} — ${q.caller}\n\n${a.message.trim()}\n`);
    updateNode(id, { params_json: JSON.stringify(q) });
    // A new discussion's request_id is bound here, with its opening message: a repeat (perhaps from
    // another relay process of the same agent) then finds a reply on its way and waits for it.
    noteCall(inst, a, id);
    return q;
  });
  if (taken === "ended") return { ...discussionView(id), note: "This discussion has ended, so your message was not sent." };
  if (taken === "busy") {
    return { ...pendingHandle(id, { discussion_id: id }, inst), not_sent: `The other side is still writing its reply to your last message, so this one was not sent. Call status with id "${id}" and wait_s, then send it.` };
  }
  const p = taken;
  const d = getNode(id)!;
  const other = otherSide(p);
  if (mine.kind === "AGREE" && p.state.markers[other]?.kind === "AGREE") {
    delete p.state.pending;
    updateNode(id, { params_json: JSON.stringify(p) });
    closeDiscussion(id, p, { outcome: "agree", conclusion: mine.text, closer: p.caller });
    return noted(discussionView(id));
  }

  const part = getNode(p.participant)!;
  const cfg = runConfig(d.run_id);
  const parts: string[] = [];
  if (!p.state.opened) {
    parts.push(discussionOpening({
      topic: p.topic, context: a.context, role: ROLE_PRESETS[p.role] ?? p.role, other: describeSide(familiesOf(d).caller, familiesOf(d).launched), resumed: p.borrowed,
      extraRules: p.extra_rules, mayDelegate: part.allow_delegation === 1 && part.depth < cfg.max_depth, target: part.target!, model: part.model, cfg,
    }));
  } else if (a.context?.length) parts.push(contextBlock(a.context).trimEnd());
  const injected = db().prepare("SELECT id, body FROM injections WHERE discussion_id = ? AND id > ? ORDER BY id").all(id, p.state.seen) as { id: number; body: string }[];
  for (const m of injected) {
    parts.push(`${HUMAN_LABEL}\n${m.body}`);
    p.state.seen = m.id;
  }
  parts.push(`[${p.caller}'s message, verbatim]\n${a.message}`);
  if (mine.kind === "CRUX") parts.push("The other participant has stated its crux and is ending the discussion with this message. Answer once: AGREE: if you can accept a conclusion, otherwise CRUX: with yours.");
  else if (p.max_turns !== undefined && p.state.turns + 1 >= p.max_turns) parts.push("This is your final turn in this discussion. End with AGREE: or CRUX:, not CONTINUE.");
  // A discussion turn is read-only, whatever the session did before. It is queued only while the
  // discussion is still open, in one transaction, so a cancel cannot slip in between.
  const turnId = tx(() => {
    if (getNode(id)?.status !== "open") return null;
    const { turnId: t } = queueTurn(part.id, `discussion:${id}`, parts.join("\n\n"), "read", {
      // A borrowed session settles with its own outcome again after this turn (requeue clears its error).
      idle: (session) => {
        if (p.borrowed && (session.kind === "job" || session.kind === "thread")) recordOwnOutcome(session.id, { status: session.status, error: session.error });
      },
    });
    if (respeed) changeSpeed(part.id, t, respeed);
    if (turnGrant) setParam(part.id, "grant", persistentGrant(turnGrant));
    recordEnvironmentRequest(t, turnGrant?.env);
    p.state.opened = true;
    p.state.pending = t;
    updateNode(id, { params_json: JSON.stringify(p) });
    return t;
  });
  if (turnId === null) return noted({ ...discussionView(id), note: "This discussion has ended, so your message was not sent." });
  const notStarted = dispatch(part.id);
  if (notStarted) return noted({ ...pendingHandle(id, { discussion_id: id }, inst), warning: notStarted });

  const done = await waitUntil(() => settleDiscussion(id), waitOpts(inst, d.run_id, w, { progressOf: part.id, awaits: [id, ...(d.parent_id ? [d.parent_id] : [])] }));
  if (!done) return noted(pendingHandle(id, { discussion_id: id }, inst));
  return noted(discussionView(id));
}
