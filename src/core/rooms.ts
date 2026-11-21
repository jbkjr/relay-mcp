// Rooms bind existing owners to two seats. All delivery and mutation share the registry writer
// lock; no room owns a run, and transcript text is never interpreted as an instruction.
import crypto from "node:crypto";
import { db, now, tx } from "./db.js";
import { relayHome } from "./config.js";
import type { Instance } from "./caller.js";
import { pidAlive, procStart } from "./procs.js";
import { markRoomExposure, roomOwnerExposed, roomOwnerHash } from "./room-policy.js";
import { redact, roomCredentialInText } from "./secrets.js";
import { roomClientName } from "./shown.js";
import { waitUntil } from "./wait.js";
import { invitePrompt } from "./room-terminal.js";
import * as R from "./room-types.js";

const hex = () => crypto.randomBytes(R.ROOM_RANDOM_BYTES).toString("hex");
export const newRoomId = (): R.RoomId => `rm_${hex()}`;
export const newRoomMemberId = (): R.RoomMemberId => `m_${hex()}`;
export const newRoomInvite = (): R.RoomInvite => `ri1_${hex()}`;
const hash = (domain: string, value: string) => crypto.createHash("sha256").update(domain).update(value).digest("hex");
const wellFormed = (text: string) => (text as string & { toWellFormed(): string }).toWellFormed();
const iso = (at: number) => new Date(at).toISOString();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
const unavailable = (): R.RoomUnavailable => ({ error: R.ROOM_UNAVAILABLE_ERROR, recovery: R.ROOM_UNAVAILABLE_RECOVERY });
const refusal = (reason: R.RoomRefusalReason): R.RoomRefusal => ({ refused: true, reason });
const limit = (name: R.RoomLimit, retry?: number): R.RoomLimitReason =>
  retry === undefined ? `Refused: room limit reached: ${name}.` : `Refused: room limit reached: ${name}; retry after ${iso(retry)}.`;
const room = (id: string) => db().prepare("SELECT * FROM rooms WHERE id = ?").get(id) as R.RoomRow | undefined;
const seats = (id: string) => db().prepare("SELECT * FROM room_members WHERE room_id = ? ORDER BY ordinal").all(id) as unknown as R.RoomMemberRow[];
const messages = (id: string) => db().prepare("SELECT * FROM room_messages WHERE room_id = ? ORDER BY seq").all(id) as R.RoomMessageRow[];
const binding = (owner: string) => db().prepare("SELECT * FROM room_bindings WHERE owner_hash = ?").get(owner) as R.RoomBindingRow | undefined;
const latest = (id: string) => Number(db().prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM room_messages WHERE room_id = ?").get(id)!.seq);
const label = (m: R.RoomMemberRow): "member-1" | "member-2" => m.ordinal === 1 ? "member-1" : "member-2";
const terminalSender: R.RoomTerminalSender = { member_id: null, label: "terminal", host: "terminal", client: null, family: "unknown" };
const wire = (m: R.RoomMessageRow): R.RoomMessage => ({ seq: m.seq, sender: JSON.parse(m.sender_json), at: iso(m.created_at), text: m.text, stance: m.stance });
let operations = 0;
const sweptAt = new Map<string, number>();

function writing<T>(fn: () => T): T {
  operations++;
  try { return tx(fn); } finally { operations--; }
}

/** A failed process-table read is unknown, never evidence to revoke a seat or lease. */
function liveness(pid: number | null, start: string | null, fresh = false): "alive" | "dead" | "unknown" {
  if (!pid) return "unknown";
  if (!pidAlive(pid)) return "dead";
  // Authenticated room calls use procStart's short cache; terminal seat reviews read afresh.
  const actual = procStart(pid, { fresh });
  if (!actual || !start) return "unknown";
  return actual.replace(/\s+/g, " ") === start.replace(/\s+/g, " ") ? "alive" : "dead";
}

function end(r: R.RoomRow, ending: R.RoomEnding, at: number, bumpRevision = true) {
  if (r.state === "ended") return;
  db().prepare("UPDATE rooms SET state = 'ended', ended_at = ?, ending_json = ?, revision = revision + ? WHERE id = ?")
    .run(at, JSON.stringify(ending), bumpRevision ? 1 : 0, r.id);
}
const noAgreement = (reason: "closed" | "expired" | "crux" | "turn_limit", closed_by: R.RoomMemberId | "terminal" | null = null): R.RoomEnding =>
  ({ outcome: "no_agreement", reason, conclusion_seq: null, closed_by });

function expiry(r: R.RoomRow): number {
  if (r.state !== "waiting") return r.expires_at;
  const pending = db().prepare(`SELECT MIN(i.expires_at) AS at FROM room_invites i JOIN room_members m
    ON m.room_id = i.room_id AND m.id = i.member_id AND m.generation = i.generation
    WHERE i.room_id = ? AND i.consumed_at IS NULL`).get(r.id)!.at as number | null;
  return Math.min(r.expires_at, pending ?? Infinity);
}

function refresh(r: R.RoomRow, at: number): R.RoomRow {
  // Expiry is independent of access; record its actual boundary, not the later sweep time.
  if (r.state !== "ended" && expiry(r) <= at) end(r, noAgreement("expired"), expiry(r));
  r = room(r.id)!;
  if (r.state !== "ended") for (const m of seats(r.id)) {
    if (m.owner_kind === "dedicated" && m.owner_hash && liveness(m.pid, m.pid_start) === "dead") {
      db().prepare("DELETE FROM room_bindings WHERE room_id = ? AND member_id = ?").run(r.id, m.id);
      db().prepare(`UPDATE room_members SET owner_hash = NULL, owner_kind = NULL, pid = NULL, pid_start = NULL,
        wait_pid = NULL, wait_start = NULL, wait_nonce = NULL WHERE room_id = ? AND id = ?`).run(r.id, m.id);
      db().prepare("UPDATE rooms SET state = 'waiting', revision = revision + 1 WHERE id = ?").run(r.id);
    }
  }
  return room(r.id)!;
}

function sweep(options: R.RoomSweepOptions): R.RoomSweepResult {
  const at = options.at ?? now(), expired: R.RoomId[] = [], deleted: R.RoomId[] = [];
  for (const r of db().prepare("SELECT * FROM rooms WHERE state != 'ended'").all() as unknown as R.RoomRow[]) {
    if (refresh(r, at).state === "ended") expired.push(r.id);
  }
  if (options.keep_records_days !== null && Number.isFinite(options.keep_records_days) && options.keep_records_days >= 0) {
    const cutoff = at - options.keep_records_days * 86400000;
    const old = db().prepare("SELECT id FROM rooms WHERE state = 'ended' AND ended_at <= ?").all(cutoff) as { id: R.RoomId }[];
    if (old.length) {
      const secure = Number(db().prepare("PRAGMA secure_delete").get()!.secure_delete);
      db().exec("PRAGMA secure_delete = ON");
      try {
        for (const { id } of old) {
          for (const table of ["room_messages", "room_invites", "room_bindings", "room_members"]) db().prepare(`DELETE FROM ${table} WHERE room_id = ?`).run(id);
          db().prepare("DELETE FROM rooms WHERE id = ?").run(id);
          deleted.push(id);
        }
      } finally { db().exec(`PRAGMA secure_delete = ${secure}`); }
    }
  }
  return { expired, deleted };
}

function opportunistic(at: number) {
  const home = relayHome();
  if (at - (sweptAt.get(home) ?? -Infinity) < R.ROOM_SWEEP_INTERVAL_MS) return;
  // Expire only. Deleting transcripts is maintenance's (retention.ts), which records the registry
  // rebuild before rows go; a deletion here would leave nothing to say a rebuild is owed.
  sweep({ at, keep_records_days: null });
  // Advancing this hint before a caller's rollback is harmless: access still refreshes its room.
  sweptAt.set(home, at);
}

export function roomSweep(options: R.RoomSweepOptions): R.RoomSweepResult {
  return writing(() => sweep(options));
}

export function roomMaintenanceBusy(): boolean {
  if (operations) return true;
  return (db().prepare("SELECT wait_pid, wait_start FROM room_members WHERE wait_nonce IS NOT NULL").all() as { wait_pid: number | null; wait_start: string | null }[])
    .some((m) => liveness(m.wait_pid, m.wait_start) !== "dead");
}

type Auth = { r: R.RoomRow; m: R.RoomMemberRow; owner: string };
function authenticate(owner: string, expected?: R.RoomBindingRow): Auth | undefined {
  const b = binding(owner);
  if (!b || (expected && (b.room_id !== expected.room_id || b.member_id !== expected.member_id || b.generation !== expected.generation))) return;
  const found = room(b.room_id);
  if (!found) return;
  const r = refresh(found, now());
  const m = seats(r.id).find((m) => m.id === b.member_id);
  if (!m || m.owner_hash !== owner || m.generation !== b.generation || !binding(owner)) return;
  return { r, m, owner };
}
function touch(a: Auth, at: number) {
  db().prepare("UPDATE room_members SET last_call_at = ?, call_no = call_no + 1 WHERE room_id = ? AND id = ?").run(at, a.r.id, a.m.id);
}
const stamp = (a: Auth): R.RoomBindingRow => ({ owner_hash: a.owner, room_id: a.r.id, member_id: a.m.id, generation: a.m.generation });
const cursorOK = (a: Auth, cursor: number) => Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= latest(a.r.id);
function fields(input: R.RoomInput, action: R.RoomInput["action"]): boolean {
  const allowed = { open: ["action", "purpose"], join: ["action", "invite"], send: ["action", "cursor", "text", "stance", "request_id"], wait: ["action", "cursor", "wait_s"], transcript: ["action", "cursor"], close: ["action", "cursor"] }[action];
  if (!input || input.action !== action || Object.keys(input).some((key) => !allowed.includes(key))) return false;
  if (input.action === "open") return input.purpose === undefined || (typeof input.purpose === "string" && input.purpose.length <= R.ROOM_PURPOSE_INPUT_UNITS);
  if (input.action === "join") return typeof input.invite === "string" && input.invite.length <= R.ROOM_INVITE_INPUT_UNITS;
  if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) return false;
  if (input.action === "send") return typeof input.text === "string" && ["continue", "agree", "crux"].includes(input.stance)
    && typeof input.request_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.request_id);
  return input.action !== "wait" || input.wait_s === undefined || (Number.isInteger(input.wait_s) && input.wait_s >= 0 && input.wait_s <= R.ROOM_LONG_WAIT_S);
}
function preflight(inst: Instance, input: R.RoomInput, action: R.RoomInput["action"], call: R.RoomCallEvidence): R.RoomRefusal | undefined {
  if (!call.eligibility.eligible || inst.ctx.kind !== "root") return refusal(R.ROOM_REFUSALS.ineligible);
  if (!fields(input, action)) return refusal(R.ROOM_REFUSALS.arguments);
}

/**
 * Whether the peer's conversation is still there, as far as relay can prove: a dedicated seat's
 * recorded server process, alive or gone. A seat detached when its server exited (refresh) keeps
 * its join time and last call, so it reads as gone until it is re-seated. A shared seat, a seat
 * never joined or re-seated, or an unreadable process table is unknown.
 */
function peerProcess(peer: R.RoomMemberRow): R.RoomPeer["process"] {
  if (!peer.owner_hash) return peer.joined_at !== null && peer.last_call_at !== null ? "gone" : "unknown";
  if (peer.owner_kind !== "dedicated") return "unknown";
  const l = liveness(peer.pid, peer.pid_start);
  return l === "dead" ? "gone" : l;
}
/** Waits stop when the peer is gone, or, only where its process is unknown, after ROOM_PEER_SILENCE_S of silence. */
function peerStop(peer: R.RoomMemberRow, at: number): { process: R.RoomPeer["process"]; stopped: boolean; until: number } {
  const process = peerProcess(peer);
  if (process === "gone") return { process, stopped: true, until: at };
  if (process === "alive" || peer.last_call_at === null) return { process, stopped: false, until: Infinity };
  const until = peer.last_call_at + R.ROOM_PEER_SILENCE_S * 1000;
  return { process, stopped: at >= until, until };
}

/** One consistent page. Skipped own rows cover sequence space, never an omitted external row. */
function view(a: Auth, cursor: number, transcript = false): R.RoomView {
  const r = room(a.r.id)!, members = seats(r.id), peer = members.find((m) => m.id !== a.m.id)!;
  const rows = messages(r.id), pending = r.state === "waiting" ? [] : rows.filter((row) => row.seq > cursor && (transcript || row.sender_owner_hash !== a.owner));
  const page = pending.slice(0, R.ROOM_PAGE_ROWS), omitted = pending[R.ROOM_PAGE_ROWS];
  const through = r.state === "waiting" ? cursor : omitted ? omitted.seq - 1 : rows.at(-1)?.seq ?? cursor;
  if (page.some((row) => row.sender_owner_hash !== a.owner)) markRoomExposure(a.owner);
  const idle = peer.last_call_at === null ? null : Math.max(0, (now() - peer.last_call_at) / 1000);
  const stop = peerStop(peer, now());
  const common = {
    room_id: r.id, origin: r.origin, member_id: a.m.id, turns: r.turns, max_turns: r.max_turns, revision: r.revision,
    cursor, through_seq: through, latest_seq: rows.at(-1)?.seq ?? 0, remaining: Math.max(0, pending.length - page.length),
    peer: { member_id: peer.id, seat: peer.owner_hash ? "joined" as const : "unseated" as const, last_call_at: peer.last_call_at === null ? null : iso(peer.last_call_at), process: stop.process },
    poll: { peer_idle_s: idle, stop_after_s: stop.process === "unknown" ? R.ROOM_PEER_SILENCE_S : null, stopped: stop.stopped },
    messages: page.map(wire), note: R.ROOM_NOTE as typeof R.ROOM_NOTE, user_confirmed_ignored: roomOwnerExposed(a.owner),
  };
  if (r.state === "waiting") return { ...common, state: "waiting", next: null, messages: [] };
  if (r.state === "ended") return { ...common, state: "ended", next: null, ending: JSON.parse(r.ending_json!) };
  return { ...common, state: "open", next: members.find((m) => m.ordinal === r.next_ordinal)!.id };
}
function refusedView(a: Auth, cursor: number, reason: R.RoomViewRefusalReason): R.RoomRefusalView {
  return { ...view(a, cursor), refused: true, reason };
}

/**
 * Room text hygiene, shared by member messages, terminal lines and an opener's purpose line (with
 * its own, smaller cap). Invites and session tokens refuse the text outright; any other credential
 * relay recognizes (redact) is cut before the display sanitizer escapes what is left, so the
 * escaped marker and line count describe the stored text. The author's limits are measured on the
 * text as written, so whether a text fits never depends on what redaction finds in it; the stored
 * bound is measured after redaction and escaping, since a cut can lengthen text (a short
 * registered value becomes "[redacted: …]").
 */
function prepareText(text: string, sanitize: R.RoomTextSanitizer, codePoints: number = R.ROOM_TEXT_CODE_POINTS): { clean: string } | { reason: R.RoomTextRefusalReason } {
  if (!text.trim()) return { reason: R.ROOM_REFUSALS.text_empty };
  if ([...text].length > codePoints || Buffer.byteLength(text, "utf8") > R.ROOM_TEXT_BYTES) return { reason: R.ROOM_REFUSALS.text_long };
  if (roomCredentialInText(text)) return { reason: R.ROOM_REFUSALS.text_secret };
  const clean = sanitize(redact(wellFormed(text)));
  if (!clean.trim()) return { reason: R.ROOM_REFUSALS.text_empty };
  if (roomCredentialInText(clean)) return { reason: R.ROOM_REFUSALS.text_secret };
  if (clean.length > Math.min(R.ROOM_SANITIZED_UNITS, codePoints * 3)) return { reason: R.ROOM_REFUSALS.text };
  return { clean };
}
function fits(row: R.RoomMessage): boolean {
  // A full wire row, plus space for indentation, the longest refusal, ending and presence.
  // P3 reserves any wrapper additions within the same whole-result budget.
  return bytes(row) <= R.ROOM_ROW_BYTES && bytes(row) + 2000 <= R.ROOM_RESULT_BYTES;
}
function sender(inst: Instance, m: R.RoomMemberRow, call: R.RoomCallEvidence): R.RoomMemberSender {
  const client = call.identity.harness === null ? null : roomClientName(call.identity.harness);
  return { member_id: m.id, label: label(m), host: inst.family, client, family: call.identity.family };
}
function issue(r: R.RoomId, m: R.RoomMemberRow, at: number): R.RoomIssuedInvite {
  const invite = newRoomInvite(), until = at + R.ROOM_INVITE_LIFETIME_MS;
  db().prepare("INSERT INTO room_invites (code_hash, room_id, member_id, generation, expires_at) VALUES (?,?,?,?,?)")
    .run(hash(R.ROOM_INVITE_DOMAIN, invite), r, m.id, m.generation, until);
  return { member_id: m.id, label: label(m), invite, expires_at: iso(until) };
}

/** Home-wide creation rate and live-room cap, shared by terminal creation and revision 3's open. */
function creationLimit(at: number): R.RoomLimitReason | undefined {
  const recent = db().prepare("SELECT created_at FROM rooms WHERE created_at > ? ORDER BY created_at").all(at - R.ROOM_RATE_WINDOW_MS) as { created_at: number }[];
  if (recent.length >= R.ROOM_CREATIONS_PER_MINUTE) return limit("ROOM_CREATIONS_PER_MINUTE", recent[0].created_at + R.ROOM_RATE_WINDOW_MS);
  if (Number(db().prepare("SELECT COUNT(*) AS n FROM rooms WHERE state != 'ended'").get()!.n) >= R.ROOM_LIVE_PER_HOME) return limit("ROOM_LIVE_PER_HOME");
}
function insertRoom(at: number, origin: "terminal" | "open", purpose: string | null = null): R.RoomId {
  const id = newRoomId();
  db().prepare("INSERT INTO rooms (id,state,created_at,expires_at,max_turns,origin,purpose) VALUES (?,'waiting',?,?,?,?,?)").run(id, at, at + R.ROOM_LIFETIME_MS, R.ROOM_MAX_TURNS, origin, purpose);
  for (let ordinal = 1; ordinal <= R.ROOM_MEMBERS; ordinal++) db().prepare("INSERT INTO room_members (room_id,id,ordinal) VALUES (?,?,?)").run(id, newRoomMemberId(), ordinal);
  return id;
}
/** Bind an owner to a seat, replacing its binding to an ended room (join's rule). */
function seat(inst: Instance, owner: string, r: R.RoomId, m: R.RoomMemberRow, call: R.RoomCallEvidence, at: number) {
  const previous = binding(owner);
  if (previous) {
    db().prepare("DELETE FROM room_bindings WHERE owner_hash = ?").run(owner);
    db().prepare("UPDATE room_members SET owner_hash = NULL, owner_kind = NULL, pid = NULL, pid_start = NULL WHERE room_id = ? AND id = ? AND owner_hash = ?")
      .run(previous.room_id, previous.member_id, owner);
  }
  const shared = !!inst.carried;
  db().prepare(`UPDATE room_members SET owner_hash = ?, owner_kind = ?, pid = ?, pid_start = ?, joined_at = ?,
    joined_sender_json = ?, last_call_at = ?, call_no = call_no + 1 WHERE room_id = ? AND id = ?`)
    .run(owner, shared ? "shared" : "dedicated", shared ? null : process.pid, shared ? null : procStart(process.pid), at, JSON.stringify(sender(inst, m, call)), at, r, m.id);
  db().prepare("INSERT INTO room_bindings (owner_hash,room_id,member_id,generation) VALUES (?,?,?,?)").run(owner, r, m.id, m.generation);
}

export function roomCreate(): R.RoomCreateResult | R.RoomTerminalFailure {
  return writing(() => {
    const at = now(); opportunistic(at);
    const capacity = creationLimit(at); if (capacity) return refusal(capacity);
    const id = insertRoom(at, "terminal");
    const members = seats(id);
    return { room_id: id, state: "waiting", expires_at: iso(at + R.ROOM_LIFETIME_MS), invites: [issue(id, members[0], at), issue(id, members[1], at)] };
  });
}

// Revision 3: a room prompt open now, by relay home and owner, so that one conversation never has
// two of its prompts on the person's screen at once. Every owner that can reach a prompt is a
// dedicated process (host.ts roomOpenDialog admits no shared or keyed entry), so its own server
// holds this exactly. There is no rate limit (decided 2026-11-16): the person can decline.
const opening = new Set<string>();
const OPEN_ANSWER_REFUSAL: Record<Exclude<R.RoomOpenAnswer, "yes">, R.RoomRefusalReason> = {
  declined: R.ROOM_REFUSALS.open_declined, cancelled: R.ROOM_REFUSALS.open_cancelled, timed_out: R.ROOM_REFUSALS.open_timed_out,
  unverified: R.ROOM_REFUSALS.open_unverified, unavailable: R.ROOM_REFUSALS.open_unavailable,
};
const liveSeat = (owner: string) => {
  const a = authenticate(owner);
  return a !== undefined && a.r.state !== "ended";
};

/**
 * Revision 3: a root conversation asks the person, through its host's own prompt, to open a room.
 * Only `prompt.ask` resolving "yes" opens one; the caller then holds member-1 and gets member-2's
 * prompt to show the person. No invite or room exists before the yes, and a refused open creates
 * no room, seat or invite; like every room call it still runs the opportunistic expiry sweep.
 */
export async function roomOpen(inst: Instance, input: Extract<R.RoomInput, { action: "open" }>, call: R.RoomCallEvidence, prompt: R.RoomOpenPrompt | null): Promise<R.RoomOpenResult | R.RoomFailure> {
  const bad = preflight(inst, input, "open", call); if (bad) return bad;
  // The opener's purpose line (Q7): the model's own words, one line, sanitized like room text and
  // shown to the person only labelled as such. A bad one refuses before anyone is asked.
  let purpose: string | null = null;
  if (input.purpose !== undefined) {
    const prepared = /[\r\n\v\f\u0085\u2028\u2029]/u.test(input.purpose) ? undefined : prepareText(input.purpose, call.sanitizeText, R.ROOM_PURPOSE_CODE_POINTS);
    const line = prepared && "clean" in prepared ? prepared.clean : undefined;
    if (line === undefined || /[\r\n\v\f\u0085\u2028\u2029]/u.test(line)) return refusal(R.ROOM_REFUSALS.purpose);
    purpose = line;
  }
  if (!prompt) return refusal(R.ROOM_REFUSALS.open_unavailable);
  const owner = roomOwnerHash(inst.token), key = `${relayHome()}\0${owner}`;
  const before = writing(() => {
    const at = now(); opportunistic(at);
    if (liveSeat(owner)) return refusal(R.ROOM_REFUSALS.open_bound);
    const capacity = creationLimit(at); if (capacity) return refusal(capacity);
  });
  if (before) return before;
  if (opening.has(key)) return refusal(R.ROOM_REFUSALS.open_in_progress);
  opening.add(key);
  let answer: R.RoomOpenAnswer;
  try {
    answer = await prompt.ask({ signal: call.signal, purpose });
  } catch {
    answer = "unavailable";
  } finally { opening.delete(key); }
  if (answer !== "yes") return refusal(OPEN_ANSWER_REFUSAL[answer] ?? R.ROOM_REFUSALS.open_unverified);
  try {
    return writing(() => {
      // The yes counts only if the host's prompt still qualifies and the caller is still eligible
      // now, under the writer lock and before anything is written: evidence read between the answer
      // and the lock (a bypass mode switched on meanwhile) cannot open a room.
      let authorized = false;
      try { authorized = prompt.authorized(); } catch { authorized = false; }
      if (!authorized) return refusal(R.ROOM_REFUSALS.open_unverified);
      const at = now(); opportunistic(at);
      // Rechecked under the writer lock: the person's yes does not outrank a seat taken meanwhile or a full home.
      if (liveSeat(owner)) return refusal(R.ROOM_REFUSALS.open_bound);
      const capacity = creationLimit(at); if (capacity) return refusal(capacity);
      const id = insertRoom(at, "open", purpose), [first, second] = seats(id);
      seat(inst, owner, id, first, call, at);
      db().prepare("UPDATE rooms SET revision = revision + 1 WHERE id = ?").run(id);
      const issued = issue(id, second, at);
      // Member-2's prompt goes to the person's clipboard, never to the model (decided 2026-11-16). If
      // that fails, the throw rolls back the room, seat and invite: nothing is opened.
      if (!prompt.deliver(invitePrompt(issued, "opened", purpose))) throw new ClipboardFailed();
      const v = view(authenticate(owner)!, 0) as Extract<R.RoomView, { state: "waiting" }>;
      return {
        ...v, opened: true,
        clipboard: `Member-2's prompt, with its one-use invite (valid until ${issued.expires_at}), is on the person's clipboard. Tell them to paste it into the conversation they choose; you were given no copy.`,
      };
    });
  } catch (err) {
    if (err instanceof ClipboardFailed) return refusal(R.ROOM_REFUSALS.open_clipboard);
    throw err;
  }
}
class ClipboardFailed extends Error {}

/** Tests only: forget prompts in progress, as a fresh server process would. */
export function resetRoomOpenRequestsForTests(): void {
  opening.clear();
}

type JoinQuestion = { question: R.RoomJoinQuestion };
/**
 * The join itself, under the writer lock. With `confirm`, it stops just before the first write
 * that would seat the caller or spend the invite, and returns the question to put to the person;
 * a replay of the caller's own spent invite needs no question and completes as before.
 */
function joinIn(inst: Instance, input: Extract<R.RoomInput, { action: "join" }>, call: R.RoomCallEvidence, owner: string, confirm: boolean): R.RoomJoinResult | R.RoomFailure | JoinQuestion {
  const at = now(); opportunistic(at);
  const current = authenticate(owner);
  if (current) touch(current, at);
  if (!R.ROOM_INVITE_SHAPE.test(input.invite)) return unavailable();
  const invite = db().prepare("SELECT * FROM room_invites WHERE code_hash = ?").get(hash(R.ROOM_INVITE_DOMAIN, input.invite)) as R.RoomInviteRow | undefined;
  if (!invite) return unavailable();
  const found = room(invite.room_id);
  if (!found) return unavailable();
  const r = refresh(found, at), m = seats(r.id).find((m) => m.id === invite.member_id)!;
  if (m.generation !== invite.generation) return unavailable();
  if (invite.consumed_at !== null) {
    const a = authenticate(owner);
    if (invite.consumed_owner_hash !== owner || !a || a.r.id !== r.id || a.m.id !== m.id || a.m.generation !== invite.generation) return unavailable();
    const rate = readRate(a, at); if (rate) return refusal(rate);
    return { ...view(a, 0), joined: true, repeated: true };
  }
  if (r.state === "ended" || invite.expires_at <= at || m.owner_hash || seats(r.id).some((s) => s.owner_hash === owner)) return unavailable();
  const previous = binding(owner);
  if (previous) {
    const old = room(previous.room_id);
    if (old && refresh(old, at).state !== "ended") return unavailable();
  }
  if (confirm) {
    const other = seats(r.id).find((s) => s.id !== m.id)!;
    return { question: { room_id: r.id, label: label(m), peer: other.owner_hash && other.joined_sender_json ? JSON.parse(other.joined_sender_json) : null, origin: r.origin, purpose: r.purpose } };
  }
  seat(inst, owner, r.id, m, call, at);
  db().prepare("UPDATE room_invites SET consumed_at = ?, consumed_owner_hash = ? WHERE code_hash = ?").run(at, owner, invite.code_hash);
  db().prepare("UPDATE rooms SET state = ?, revision = revision + 1 WHERE id = ?").run(seats(r.id).every((s) => s.owner_hash) ? "open" : "waiting", r.id);
  return { ...view(authenticate(owner)!, 0), joined: true, repeated: false };
}

const JOIN_ANSWER_REFUSAL: Record<Exclude<R.RoomOpenAnswer, "yes">, R.RoomRefusalReason> = {
  declined: R.ROOM_REFUSALS.join_declined, cancelled: R.ROOM_REFUSALS.join_cancelled, timed_out: R.ROOM_REFUSALS.join_timed_out,
  unverified: R.ROOM_REFUSALS.join_unverified, unavailable: R.ROOM_REFUSALS.join_unavailable,
};

/**
 * Join with a person-pasted invite. Where the server supplies `prompt` (the host's dialog is
 * qualified to reach the person: revision 3, option B), relay first checks the invite without
 * spending it, then asks the person; only their explicit yes, still authorized under the writer
 * lock, seats the caller. A no, or no answer, seats nothing and leaves the invite unspent.
 */
export async function roomJoin(inst: Instance, input: Extract<R.RoomInput, { action: "join" }>, call: R.RoomCallEvidence, prompt: R.RoomJoinPrompt | null = null): Promise<R.RoomJoinResult | R.RoomFailure> {
  const bad = preflight(inst, input, "join", call); if (bad) return bad;
  const owner = roomOwnerHash(inst.token);
  if (!prompt) return writing(() => joinIn(inst, input, call, owner, false) as R.RoomJoinResult | R.RoomFailure);
  const first = writing(() => joinIn(inst, input, call, owner, true));
  if (!("question" in first)) return first;
  const key = `${relayHome()}\0${owner}`;
  if (opening.has(key)) return refusal(R.ROOM_REFUSALS.join_in_progress);
  opening.add(key);
  let answer: R.RoomOpenAnswer;
  try {
    answer = await prompt.ask(first.question, { signal: call.signal });
  } catch {
    answer = "unavailable";
  } finally { opening.delete(key); }
  if (answer !== "yes") return refusal(JOIN_ANSWER_REFUSAL[answer] ?? R.ROOM_REFUSALS.join_unverified);
  return writing(() => {
    let authorized = false;
    try { authorized = prompt.authorized(); } catch { authorized = false; }
    if (!authorized) return refusal(R.ROOM_REFUSALS.join_unverified);
    // Everything is checked again: the invite may have been spent, the seat taken or the room ended meanwhile.
    return joinIn(inst, input, call, owner, false) as R.RoomJoinResult | R.RoomFailure;
  });
}

function retry(a: Auth, input: Extract<R.RoomInput, { action: "send" }>, argsHash: string): R.RoomSendResult | R.RoomFailure | undefined {
  const old = db().prepare("SELECT seq,args_hash FROM room_messages WHERE room_id = ? AND member_id = ? AND request_id = ?")
    .get(a.r.id, a.m.id, input.request_id) as { seq: number; args_hash: string } | undefined;
  if (!old) return;
  // Look up the request first, but malformed cursors still disclose no transcript.
  if (!cursorOK(a, input.cursor)) return refusal(R.ROOM_REFUSALS.arguments);
  const cursor = input.cursor;
  const rate = readRate(a, now()); if (rate) return refusal(rate);
  if (old.args_hash !== argsHash) return refusedView(a, cursor, R.ROOM_REFUSALS.changed_retry);
  return { ...view(a, cursor), accepted_seq: old.seq, repeated: true };
}

function rowRate(id: string, at: number): R.RoomLimitReason | undefined {
  const recent = db().prepare("SELECT created_at FROM room_messages WHERE room_id = ? AND created_at > ? ORDER BY created_at").all(id, at - R.ROOM_RATE_WINDOW_MS) as { created_at: number }[];
  if (recent.length >= R.ROOM_ROWS_PER_MINUTE) return limit("ROOM_ROWS_PER_MINUTE", recent[0].created_at + R.ROOM_RATE_WINDOW_MS);
}

export async function roomSend(inst: Instance, input: Extract<R.RoomInput, { action: "send" }>, call: R.RoomCallEvidence): Promise<R.RoomSendResult | R.RoomFailure> {
  const bad = preflight(inst, input, "send", call); if (bad) return bad;
  const owner = roomOwnerHash(inst.token), argsHash = hash(R.ROOM_SEND_DOMAIN, JSON.stringify([input.text, input.stance]));
  const start = writing(() => {
    opportunistic(now());
    const a = authenticate(owner); if (!a) return unavailable();
    const repeated = retry(a, input, argsHash);
    if (repeated) { touch(a, now()); return repeated; }
    return stamp(a);
  });
  if (!("owner_hash" in start)) return start;
  // Sanitize outside the lock: a re-entrant adapter cannot smuggle an old generation's write.
  operations++;
  try {
    const prepared = prepareText(input.text, call.sanitizeText);
    return writing(() => {
      const a = authenticate(owner, start); if (!a) return unavailable();
      touch(a, now());
      const repeated = retry(a, input, argsHash); if (repeated) return repeated;
      if (!cursorOK(a, input.cursor)) return refusal(R.ROOM_REFUSALS.arguments);
      if ("reason" in prepared) return refusal(prepared.reason);
      const { clean } = prepared, { r, m } = a, at = now();
      if (r.state !== "open") return refusedSendView(a, input.cursor, R.ROOM_REFUSALS.not_open);
      const rows = messages(r.id);
      if (rows.some((row) => row.seq > input.cursor && row.sender_owner_hash !== owner)) return refusedSendView(a, input.cursor, R.ROOM_REFUSALS.stale);
      if (m.ordinal !== r.next_ordinal) return refusedSendView(a, input.cursor, R.ROOM_REFUSALS.turn);
      if (r.turns >= r.max_turns) return refusedSendView(a, input.cursor, limit("ROOM_MAX_TURNS"));
      const last = rows.filter((row) => row.member_id === m.id).at(-1);
      if (last && at - last.created_at < R.ROOM_SEND_INTERVAL_MS) return refusedSendView(a, input.cursor, limit("ROOM_SEND_INTERVAL_MS", last.created_at + R.ROOM_SEND_INTERVAL_MS));
      const rate = rowRate(r.id, at); if (rate) return refusedSendView(a, input.cursor, rate);
      const seq = latest(r.id) + 1;
      const row: R.RoomMessageRow = { room_id: r.id, seq, member_id: m.id, sender_owner_hash: owner, sender_json: m.joined_sender_json!, created_at: at, text: clean, stance: input.stance, request_id: input.request_id, args_hash: argsHash };
      if (!fits(wire(row))) return refusal(R.ROOM_REFUSALS.text);
      db().prepare(`INSERT INTO room_messages (room_id,seq,member_id,sender_owner_hash,sender_json,created_at,text,stance,request_id,args_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(r.id, seq, m.id, owner, row.sender_json, at, clean, input.stance, input.request_id, argsHash);
      db().prepare("UPDATE rooms SET turns = turns + 1, next_ordinal = ?, revision = revision + 1 WHERE id = ?").run(m.ordinal === 1 ? 2 : 1, r.id);
      const prior = rows.at(-1), previousMember = rows.filter((row) => row.member_id !== null).at(-1);
      if (input.stance === "agree" && prior?.stance === "agree") end(r, { outcome: "agree", reason: "agreement", conclusion_seq: seq, closed_by: null }, at, false);
      else if (r.turns + 1 >= r.max_turns) end(r, noAgreement("turn_limit"), at, false);
      else if (previousMember?.stance === "crux") end(r, noAgreement("crux"), at, false);
      return { ...view(a, input.cursor), accepted_seq: seq, repeated: false };
    });
  } finally { operations--; }
}

function readRate(a: Auth, at: number): R.RoomLimitReason | undefined {
  const times = (JSON.parse(a.m.read_times_json) as number[]).filter((t) => t > at - R.ROOM_READ_WINDOW_MS);
  if (times.length >= R.ROOM_READS_PER_SECOND) return limit("ROOM_READS_PER_SECOND", times[0] + R.ROOM_READ_WINDOW_MS);
  db().prepare("UPDATE room_members SET read_times_json = ? WHERE room_id = ? AND id = ?").run(JSON.stringify([...times, at]), a.r.id, a.m.id);
}

function refusedSendView(a: Auth, cursor: number, reason: R.RoomViewRefusalReason): R.RoomRefusalView | R.RoomRefusal {
  const rate = readRate(a, now());
  return rate ? refusal(rate) : refusedView(a, cursor, reason);
}

export async function roomTranscript(inst: Instance, input: Extract<R.RoomInput, { action: "transcript" }>, call: R.RoomCallEvidence): Promise<R.RoomTranscriptResult | R.RoomFailure> {
  const bad = preflight(inst, input, "transcript", call); if (bad) return bad;
  return writing(() => {
    const at = now(); opportunistic(at);
    const a = authenticate(roomOwnerHash(inst.token)); if (!a) return unavailable();
    touch(a, at);
    if (!cursorOK(a, input.cursor)) return refusal(R.ROOM_REFUSALS.arguments);
    const rate = readRate(a, at); if (rate) return refusal(rate);
    return view(a, input.cursor, true);
  });
}

export async function roomClose(inst: Instance, input: Extract<R.RoomInput, { action: "close" }>, call: R.RoomCallEvidence): Promise<R.RoomCloseResult | R.RoomFailure> {
  const bad = preflight(inst, input, "close", call); if (bad) return bad;
  return writing(() => {
    const at = now(); opportunistic(at);
    const a = authenticate(roomOwnerHash(inst.token)); if (!a) return unavailable();
    touch(a, at);
    if (!cursorOK(a, input.cursor)) return refusal(R.ROOM_REFUSALS.arguments);
    const rate = readRate(a, at); if (rate) return refusal(rate);
    end(a.r, noAgreement("closed", a.m.id), at);
    return view(a, input.cursor) as R.RoomCloseResult;
  });
}

export async function roomWait(inst: Instance, input: Extract<R.RoomInput, { action: "wait" }>, call: R.RoomCallEvidence): Promise<R.RoomWaitResult | R.RoomFailure> {
  const bad = preflight(inst, input, "wait", call); if (bad) return bad;
  const owner = roomOwnerHash(inst.token), nonce = hex();
  const start = writing<R.RoomWaitResult | R.RoomFailure | { expected: R.RoomBindingRow; revision: number; ms: number; peerPid: number | null }>(() => {
    const at = now(); opportunistic(at);
    const a = authenticate(owner); if (!a) return unavailable();
    if (!cursorOK(a, input.cursor)) return refusal(R.ROOM_REFUSALS.arguments);
    const rate = readRate(a, at); if (rate) return refusal(rate);
    const peer = seats(a.r.id).find((m) => m.id !== a.m.id)!;
    // Unread text and an ending are a normal result however long the peer has been silent.
    const v = view(a, input.cursor);
    if (v.messages.length || v.state === "ended") { touch(a, at); return { ...v, wait_ended: false }; }
    if (a.r.state === "open" && a.m.ordinal === a.r.next_ordinal) return { ...v, refused: true, reason: R.ROOM_REFUSALS.wait_turn };
    touch(a, at);
    if (a.m.wait_nonce && liveness(a.m.wait_pid, a.m.wait_start) !== "dead") return refusedView(a, input.cursor, R.ROOM_REFUSALS.duplicate_wait);
    const stop = peerStop(peer, at);
    if (stop.stopped) return refusedView(a, input.cursor, R.ROOM_REFUSALS.idle_peer);
    // A long-wait host (its call moves to the background) may wait for hours in one call, as its
    // status waits do; elsewhere the 50 s maximum and block_s apply.
    const ms = Math.max(0, Math.min((input.wait_s ?? R.ROOM_WAIT_DEFAULT_S) * 1000,
      call.long_waits ? R.ROOM_LONG_WAIT_S * 1000 : Math.min(R.ROOM_WAIT_MAX_S, call.block_s) * 1000, (call.host_wait_cap_s ?? Infinity) * 1000, (call.deadline ?? Infinity) - at,
      expiry(a.r) - at, stop.until - at));
    db().prepare("UPDATE room_members SET wait_pid = ?, wait_start = ?, wait_nonce = ? WHERE room_id = ? AND id = ?")
      .run(process.pid, procStart(process.pid), nonce, a.r.id, a.m.id);
    return { expected: stamp(a), revision: a.r.revision, ms, peerPid: peer.owner_kind === "dedicated" ? peer.pid : null };
  });
  if (!("expected" in start)) return start;
  operations++;
  const began = now();
  try {
    const changed = await waitUntil(() => reading(() => {
      // Wake on a room change (join, re-seat, send, terminal line, ending), never on a bare peer
      // call: two members waiting at once would otherwise wake each other with empty results,
      // each wake costing a model continuation, for as long as both kept polling.
      const b = binding(owner), expected = start.expected;
      return !b || b.room_id !== expected.room_id || b.member_id !== expected.member_id || b.generation !== expected.generation
        || room(expected.room_id)?.revision !== start.revision
        // The peer's server exiting ends the wait too (a cheap signal-0 check): the view that
        // follows detaches its seat and says it is gone, rather than waiting on for hours.
        || (start.peerPid !== null && !pidAlive(start.peerPid));
    }), { ms: start.ms, lender: null, signal: call.signal, onTick: call.onTick });
    return writing(() => {
      const a = authenticate(owner, start.expected); if (!a) return unavailable();
      const v = view(a, input.cursor);
      // Woken by the peer's server exiting (or cut at the silence fallback) with nothing to read:
      // the same refusal, and its stop-and-report text, that the next wait would get at once.
      if (!v.messages.length && v.state !== "ended" && v.poll.stopped) return { ...v, refused: true as const, reason: R.ROOM_REFUSALS.idle_peer };
      return { ...v, wait_ended: a.r.state !== "ended" && !changed && !call.signal?.aborted && now() - began >= start.ms };
    });
  } finally {
    try {
      writing(() => db().prepare("UPDATE room_members SET wait_pid = NULL, wait_start = NULL, wait_nonce = NULL WHERE room_id = ? AND id = ? AND generation = ? AND wait_nonce = ?")
        .run(start.expected.room_id, start.expected.member_id, start.expected.generation, nonce));
    } finally { operations--; }
  }
}

export function roomReseat(roomId: R.RoomId, memberId: R.RoomMemberId, expectedGeneration: number): R.RoomReseatResult | R.RoomTerminalFailure {
  return writing(() => {
    const at = now(); opportunistic(at);
    const found = room(roomId); if (!found) return unavailable();
    const r = refresh(found, at), m = seats(roomId).find((m) => m.id === memberId);
    if (!m || m.generation !== expectedGeneration) return unavailable();
    if (r.state === "ended") return refusal(R.ROOM_REFUSALS.not_open);
    const times = (JSON.parse(m.reseat_times_json) as number[]).filter((t) => t > at - R.ROOM_RATE_WINDOW_MS);
    if (times.length >= R.ROOM_RESEATS_PER_MINUTE) return refusal(limit("ROOM_RESEATS_PER_MINUTE", times[0] + R.ROOM_RATE_WINDOW_MS));
    db().prepare("DELETE FROM room_bindings WHERE room_id = ? AND member_id = ?").run(roomId, memberId);
    db().prepare("DELETE FROM room_invites WHERE room_id = ? AND member_id = ?").run(roomId, memberId);
    db().prepare(`UPDATE room_members SET generation = generation + 1, owner_hash = NULL, owner_kind = NULL, pid = NULL, pid_start = NULL,
      joined_at = NULL, joined_sender_json = NULL, last_call_at = NULL, wait_pid = NULL, wait_start = NULL, wait_nonce = NULL,
      reseat_times_json = ? WHERE room_id = ? AND id = ?`).run(JSON.stringify([...times, at]), roomId, memberId);
    db().prepare("UPDATE rooms SET state = 'waiting', revision = revision + 1 WHERE id = ?").run(roomId);
    return { room_id: roomId, member_id: memberId, state: "waiting", origin: r.origin, purpose: r.purpose, invite: issue(roomId, seats(roomId).find((m) => m.id === memberId)!, at) };
  });
}

export function roomList(): R.RoomListEntry[] {
  return reading(() => db().prepare("SELECT * FROM rooms ORDER BY created_at,id").all().map((row) => {
    const r = row as unknown as R.RoomRow;
    return { room_id: r.id, origin: r.origin, state: r.state, created_at: iso(r.created_at), expires_at: iso(r.expires_at), seats: seats(r.id).map((m) => ({ member_id: m.id, label: label(m), host: m.joined_sender_json ? JSON.parse(m.joined_sender_json).host : null })) };
  }));
}

/** Administrative reads never acquire the writer lock or perform opportunistic maintenance. */
function reading<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN");
  operations++;
  try { return fn(); } finally {
    try { d.exec("ROLLBACK"); } finally { operations--; }
  }
}

export function roomPrint(roomId: R.RoomId): R.RoomTerminalTranscript | R.RoomUnavailable {
  return reading(() => {
    const r = room(roomId); if (!r) return unavailable();
    const members = seats(roomId);
    return {
      room_id: r.id, origin: r.origin, purpose: r.purpose, state: r.state, created_at: iso(r.created_at), expires_at: iso(r.expires_at), ended_at: r.ended_at === null ? null : iso(r.ended_at),
      revision: r.revision, turns: r.turns, max_turns: r.max_turns, next: r.state === "open" ? members.find((m) => m.ordinal === r.next_ordinal)!.id : null,
      seats: members.map((m) => {
        const s: R.RoomMemberSender | null = m.joined_sender_json ? JSON.parse(m.joined_sender_json) : null;
        return { member_id: m.id, label: label(m), host: s?.host ?? null, ordinal: m.ordinal, generation: m.generation,
          seat: m.owner_hash ? "joined" : "unseated", client: s?.client ?? null, family: s?.family ?? "unknown", owner_fingerprint: m.owner_hash?.slice(0, 24) ?? null,
          owner_kind: m.owner_kind, pid: m.pid, pid_start: m.pid_start, liveness: m.owner_kind === "dedicated" ? liveness(m.pid, m.pid_start, true) : "unknown" };
      }), messages: messages(roomId).map(wire), ending: r.ending_json ? JSON.parse(r.ending_json) : null, note: R.ROOM_NOTE,
    };
  });
}

export function roomAddLine(roomId: R.RoomId, text: string, sanitizeText: R.RoomTextSanitizer): R.RoomTerminalLineResult | R.RoomTerminalFailure {
  operations++;
  try {
    const prepared = prepareText(text, sanitizeText);
    return writing(() => {
      const at = now(); opportunistic(at);
      const found = room(roomId); if (!found) return unavailable();
      const r = refresh(found, at);
      if (r.state !== "open") return refusal(R.ROOM_REFUSALS.not_open);
      if ("reason" in prepared) return refusal(prepared.reason);
      const { clean } = prepared;
      const count = Number(db().prepare("SELECT COUNT(*) AS n FROM room_messages WHERE room_id = ? AND member_id IS NULL").get(roomId)!.n);
      if (count >= R.ROOM_TERMINAL_ROWS) return refusal(limit("ROOM_TERMINAL_ROWS"));
      const rate = rowRate(roomId, at); if (rate) return refusal(rate);
      const seq = latest(roomId) + 1;
      if (!fits({ seq, sender: terminalSender, at: iso(at), text: clean, stance: null })) return refusal(R.ROOM_REFUSALS.text);
      db().prepare("INSERT INTO room_messages (room_id,seq,sender_json,created_at,text) VALUES (?,?,?,?,?)").run(roomId, seq, JSON.stringify(terminalSender), at, clean);
      db().prepare("UPDATE rooms SET revision = revision + 1 WHERE id = ?").run(roomId);
      return { injected: true, room_id: roomId, seq };
    });
  } finally { operations--; }
}

export function roomCloseAtTerminal(roomId: R.RoomId): R.RoomTerminalCloseResult | R.RoomTerminalFailure {
  return writing(() => {
    const at = now(); opportunistic(at);
    const found = room(roomId); if (!found) return unavailable();
    const r = refresh(found, at);
    end(r, noAgreement("closed", "terminal"), at);
    return { room_id: roomId, state: "ended", ending: JSON.parse(room(roomId)!.ending_json!) };
  });
}
