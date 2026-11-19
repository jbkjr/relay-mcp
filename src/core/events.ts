// Events: what a root session should hear about in its runs (an item settled, an approval request
// was handed to it, a discussion reply arrived), each recorded once with an id. They reach the
// session at least once: in the `events` field of its next relay tool result, and, in Claude Code,
// as a notice posted to the session's inbox socket when no call of the session is waiting on them.
// A notice is a pointer (the item, what happened, what to call); never the other agent's words.
import net from "node:net";
import path from "node:path";
import { relayHome } from "./config.js";
import { db, getNode, now, type NodeRow } from "./db.js";
import { deciderOf, type Decider } from "./approvals.js";
import { personOnly } from "./extensions.js";
import { clipped } from "./shown.js";
import { appendLog } from "./storage.js";

export interface EventRow {
  id: number;
  run_id: string;
  /** What makes the event unique, so that it is recorded once however often it is seen. */
  key: string;
  kind: "settled" | "approval" | "decided" | "late";
  /** The item to call about. */
  item_id: string;
  /** The item or request the event is about (an approval request's id for kind "approval"). */
  subject: string;
  /** What happened and what to call, without the event's id (see noticeText). */
  text: string;
  created_at: number;
  noticed_at: number | null;
  seen_at: number | null;
}

/** Statuses that end an item on its own: "blocked" finished too, refused something on the way (db.ts NodeStatus). */
const ENDED = ["done", "blocked", "refused", "failed", "timeout", "lost"];

interface Pointer { key: string; item: NodeRow; text: string }

/**
 * The root-level discussion a turn of this session was written for, when the session was borrowed
 * for it (it existed before the discussion, so the discussion is not its parent); otherwise undefined.
 */
function borrowedFor(n: NodeRow, source: string): NodeRow | undefined {
  if (!source.startsWith("discussion:")) return undefined;
  const from = getNode(source.slice("discussion:".length));
  return from?.kind === "discussion" && !from.parent_id && from.id !== n.parent_id ? from : undefined;
}

/**
 * What the root session is to hear when a node settles, each with the key it is recorded under:
 * its own jobs and threads finishing; the reviewer of its review; the participant of its discussion
 * (a reply). What jobs start themselves is theirs to follow. Cancelled items are left out: a cancel
 * comes from the session or the terminal, which know.
 *
 * What settled is read from the session's executed turns (done or failed), latest first by when
 * they ended, not from its newest turn row: that may be a queued turn cancelled since, which never ran.
 */
function pointersOf(n: NodeRow, executed: { id: number; source: string }[]): Pointer[] {
  if (!ENDED.includes(n.status)) return [];
  // Keyed on the executed turn the event is about, so that a session settling again without a new
  // turn (one requeued for a turn cancelled before it ran) records nothing twice. Only a session
  // with no executed turn at all is keyed on when it ended.
  const keyOf = (t: { id: number } | undefined) => (t ? `settled:${n.id}:turn:${t.id}` : `settled:${n.id}:${n.ended_at}`);
  const nodeKey = keyOf(executed[0]);
  const rootSession = !n.parent_id && (n.kind === "job" || n.kind === "thread");
  // Each executed turn with the root-level discussion it was written for, when the session was
  // borrowed for one (looked up once per source).
  const lent = new Map<string, NodeRow | undefined>();
  const turns = executed.map((t) => {
    if (!lent.has(t.source)) lent.set(t.source, borrowedFor(n, t.source));
    return { t, from: lent.get(t.source) };
  });
  // A root-level job or thread finishing its own work is keyed on its own latest turn, so that it
  // is announced once whether or not a discussion turn followed before the session settled.
  const own = turns.find((x) => !x.from)?.t;
  // Blocked is the case where the session most needs to act (resume with a grant), so it says why.
  const why = n.status === "blocked" ? ": its agent was refused something it tried" : "";
  const finished = (key: string): Pointer => ({ key, item: n, text: `${n.kind} ${n.id} finished (${n.status})${why}. Call result ${n.id}.` });
  // A session the root session borrowed for a discussion settles after each reply it writes there:
  // that is the discussion's news (while it is open), keyed on the latest turn it wrote there. Not
  // only when that turn is its newest: its own queued turn may have run at once after the reply, so
  // that no look saw the session settled with the reply alone. Its own work, settled with it or
  // after it, is announced too. (A review's reconciliation is the review's news, below.)
  const replies: Pointer[] = [];
  const answered = new Set<string>();
  for (const { t, from } of turns) {
    if (!from || answered.has(from.id)) continue;
    answered.add(from.id);
    if (from.status === "open") replies.push({ key: keyOf(t), item: from, text: `discussion ${from.id} has a reply. Call status ${from.id}.` });
  }
  if (turns[0]?.from) return rootSession && own ? [...replies, finished(keyOf(own))] : replies;
  if (!n.parent_id) return rootSession ? [...replies, finished(keyOf(own))] : replies;
  const parent = getNode(n.parent_id);
  if (!parent || parent.parent_id) return replies;
  if (parent.kind === "review" && n.kind === "job") {
    // Once the review is being reconciled, the reviewer's turns are its replies in that discussion.
    const d = (JSON.parse(parent.params_json ?? "{}") as { discussion?: string }).discussion;
    if (d && d !== "opening") return [...replies, { key: nodeKey, item: parent, text: `review ${parent.id} has a reply in its discussion ${d}. Call status ${d}.` }];
    return [...replies, { key: nodeKey, item: parent, text: `the reviewer of review ${parent.id} finished (${n.status}). Call status ${parent.id}.` }];
  }
  if (parent.kind === "discussion" && parent.status === "open") return [...replies, { key: nodeKey, item: parent, text: `discussion ${parent.id} has a reply. Call status ${parent.id}.` }];
  return replies;
}

/** Who decided a request, in words for the root agent, when it was a person and not the root agent itself. */
const BY_PERSON: Partial<Record<Decider, string>> = {
  "user-dialog": "by the user in relay's approval dialog",
  "user-confirm": "by the user in your host's permission prompt (confirm)",
  // Whoever ran the command: relay cannot tell.
  terminal: "from a terminal (relay approve or relay deny)",
};
const byPerson = (decidedBy: string | null): string | null => BY_PERSON[deciderOf(decidedBy)] ?? null;

/**
 * Records the events of the runs this root session owns, from `since[run]` on (each run's
 * creation, also for a run taken over, so that what settled while no session owned it is not
 * lost): settled items, approval requests that are pending and not being put to the user directly
 * (`asking`), and requests a person decided rather than the root agent. Each is recorded once,
 * keyed on what it is about, so looking again over the same span records nothing twice.
 */
export function recordEvents(since: Map<string, number>, asking: (requestId: string) => boolean): void {
  // Most looks find nothing new, and an ignored insert would still use up an id of the AUTOINCREMENT
  // key. So nothing is inserted where the key is there already, and event ids stay dense.
  const add = db().prepare(
    "INSERT INTO events (run_id, key, kind, item_id, subject, text, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE key = ?)",
  );
  // An insert takes the registry's write lock even when it inserts nothing, and every tool result
  // looks again at everything since each run began: an event already recorded is found by a read
  // first. The insert keeps its own condition, so two looks at once still record it once.
  const recorded = db().prepare("SELECT 1 FROM events WHERE key = ?");
  const insert = { run: (runId: string, key: string, kind: string, item: string, subject: string, text: string, at: number) => recorded.get(key) ? undefined : add.run(runId, key, kind, item, subject, text, at, key) };
  for (const [runId, from] of since) {
    const nodes = db().prepare("SELECT * FROM nodes WHERE run_id = ? AND ended_at >= ?").all(runId, from) as unknown as NodeRow[];
    // Each node's executed turns, latest first by when they ended (pointersOf), read for all of them
    // at once, for exactly the nodes just read, by id. Asking again which nodes have ended would
    // leave out one whose next turn another process started in between, and with it the turns that
    // say what it settled with. An executed turn's status is final, so this read finds every turn
    // that had executed when its node was read, as a read per node would.
    const executed = new Map<string, { id: number; source: string }[]>();
    const ids = JSON.stringify(nodes.map((n) => n.id));
    for (const t of db().prepare("SELECT node_id, id, source FROM turns WHERE status IN ('done', 'failed', 'refused') AND node_id IN (SELECT value FROM json_each(?)) ORDER BY ended_at DESC, id DESC").all(ids) as { node_id: string; id: number; source: string }[]) {
      const list = executed.get(t.node_id);
      if (list) list.push({ id: t.id, source: t.source });
      else executed.set(t.node_id, [{ id: t.id, source: t.source }]);
    }
    for (const n of nodes) {
      for (const p of pointersOf(n, executed.get(n.id) ?? [])) insert.run(runId, p.key, "settled", p.item.id, n.id, p.text, now());
    }
    const requests = db().prepare("SELECT id, node_id, kind, detail_json FROM requests WHERE run_id = ? AND status = 'pending' AND created_at >= ?").all(runId, from) as { id: string; node_id: string; kind: string; detail_json: string | null }[];
    for (const r of requests) {
      if (asking(r.id)) continue;
      const n = getNode(r.node_id);
      // What it wants is the launched agent's own text, so it stays in tool results and out of the
      // session's turn: the notice says only who asks and where to look. A request only the person
      // may allow (docs/extensions.md) is said to be one.
      const text = personOnly(r)
        ? `${n?.kind ?? "item"} ${r.node_id} needs approval ${r.id}, which only the user can allow. Call status ${r.node_id}, then leave it to them (relay's question, or confirm where you have it) or deny it.`
        : `${n?.kind ?? "item"} ${r.node_id} needs approval ${r.id}. Call status ${r.node_id}, then approve or deny it.`;
      insert.run(runId, `approval:${r.id}`, "approval", r.node_id, r.id, text, now());
    }
    // A person's decision, so that the root agent knows one was made and by whom. What the request
    // wanted is the launched agent's text; these events go only into tool results, never notices.
    const decided = db().prepare("SELECT id, node_id, status, summary, decided_by FROM requests WHERE run_id = ? AND status IN ('allowed', 'denied') AND decided_at >= ?")
      .all(runId, from) as { id: string; node_id: string; status: string; summary: string; decided_by: string | null }[];
    for (const r of decided) {
      const how = byPerson(r.decided_by);
      if (!how) continue;
      const n = getNode(r.node_id);
      const text = `approval ${r.id} (${n?.kind ?? "item"} ${r.node_id}: ${clipped(r.summary, 120)}) was ${r.status} ${how}. Nothing to call.`;
      insert.run(runId, `decided:${r.id}`, "decided", r.node_id, r.id, text, now());
    }
  }
}

/** Who decided a request, in words for the root agent, whoever it was. */
export function decidedBy(r: { status: string; decided_by: string | null }): string {
  if (r.status === "expired") return "closed without an answer (its turn ended, the asking agent stopped waiting, or nobody answered in time)";
  const who = deciderOf(r.decided_by);
  const how = BY_PERSON[who];
  if (how) return `${r.status} ${how}`;
  if (who === "root" || who === "root-confirmed") return `${r.status} by you (the root session${who === "root-confirmed" ? ", stating that the user confirmed" : ""})`;
  return `${r.status} by ${r.decided_by ?? "someone else"}`;
}

/**
 * Records that a question about a request was answered after it had been decided elsewhere: a
 * host that keeps a withdrawn form on screen (Codex) lets the person answer it, and an answer can
 * also cross a decision made elsewhere in the moment before relay withdraws the form. The answer
 * changes nothing; the event is so that the root agent can tell them so. `by` says whose answer it
 * is: "user" for one the form lets only a person give, "host" for one relay cannot attribute to
 * the user (a Codex decline). Once per request.
 */
export function recordLateAnswer(r: { id: string; run_id: string; node_id: string; status: string; decided_by: string | null }, said: string, by: "user" | "host"): void {
  const text = by === "user"
    ? `the user answered approval ${r.id} ("${said}") in relay's approval form after it had already been ${decidedBy(r)}. Their answer changed nothing; tell them so.`
    : `relay's approval form for approval ${r.id} was answered ("${said}") by the host after it had already been ${decidedBy(r)}; relay cannot tell whether the user gave it or the host answered on its own. It changed nothing; if the user did answer, tell them so.`;
  db().prepare("INSERT INTO events (run_id, key, kind, item_id, subject, text, created_at) SELECT ?, ?, 'late', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE key = ?)")
    .run(r.run_id, `late:${r.id}`, r.node_id, r.id, text, now(), `late:${r.id}`);
}

/**
 * The unsigned pointer in tool-result events and verified-event replies. Inbox notices add a
 * live-server tag (notices.ts); the event id still identifies one event across both channels.
 */
export const noticeText = (e: Pick<EventRow, "id" | "text">): string => `relay (event ${e.id}): ${e.text}`;

/** Events of these runs the session has not been given yet, oldest first. */
export function unseenEvents(runIds: string[]): EventRow[] {
  if (!runIds.length) return [];
  return db().prepare(`SELECT * FROM events WHERE seen_at IS NULL AND run_id IN (${runIds.map(() => "?").join(", ")}) ORDER BY id`).all(...runIds) as unknown as EventRow[];
}

export function markSeen(ids: number[]): void {
  const stmt = db().prepare("UPDATE events SET seen_at = ? WHERE id = ? AND seen_at IS NULL");
  for (const id of ids) stmt.run(now(), id);
}

/** Claims the posting of an event's notice; false when it has been posted already. */
export function claimNotice(id: number): boolean {
  return Number(db().prepare("UPDATE events SET noticed_at = ? WHERE id = ? AND noticed_at IS NULL").run(now(), id).changes) === 1;
}

/**
 * Posts a notice to the Claude Code session whose inbox socket this is: an auth line with its
 * token, then the message as a user turn. Claude Code labels it as a message from another session
 * that cannot approve anything; it starts a turn in an idle session, and in a busy one is read when
 * the current tool call returns. Resolves when written or failed; the outcome goes to notices.log.
 */
export function postNotice(socket: string, token: string | undefined, text: string, eventId: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: string) => {
      if (done) return;
      done = true;
      // Diagnostics only: a failed write is not the notice's failure. Rotated at log_max_mb.
      appendLog(path.join(relayHome(), "notices.log"), JSON.stringify({ at: new Date().toISOString(), event: eventId, outcome }) + "\n");
      resolve();
    };
    const c = net.createConnection(socket, () => {
      const lines = [...(token ? [JSON.stringify({ type: "auth", token })] : []), JSON.stringify({ type: "user", message: { role: "user", content: text } })];
      c.end(lines.join("\n") + "\n", () => finish("posted"));
    });
    c.setTimeout(5000, () => {
      c.destroy();
      finish("timed out");
    });
    c.on("error", (err) => finish(`error: ${err.message}`));
  });
}
