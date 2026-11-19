// Calls that name a request_id. A caller whose call timed out cannot tell whether it started
// anything, so it calls again with the same request_id; relay then hands back what the first call
// started instead of starting it twice. Only the same caller's calls are matched: a root
// session's relay server, one conversation of a shared one (by its session token's owner hash),
// or one launched agent (whose relay connections may be several processes). See caller.ts callScope.
import crypto from "node:crypto";
import { canReadItem, UNAVAILABLE, callScope, refused, type Instance, type Json, type ToolCall } from "./caller.js";
import { db, now, sleep, tx } from "./db.js";
import { procStart, sameProcess } from "./procs.js";

export interface CallRow {
  scope: string;
  request_id: string;
  tool: string;
  args_hash: string;
  node_id: string;
  turn_id: number | null;
  /** Held by the call that is starting it, while node_id is "". */
  claim: string;
  owner_pid: number;
  owner_start: string | null;
  created_at: number;
}

/**
 * Arguments that may differ between a call and its repeat: the request_id itself, and whether to
 * wait. A session token is a credential, never part of what was asked; the scope already carries it.
 */
const NOT_COMPARED = new Set(["request_id", "background", "session_token"]);

/** A digest of what the call asked for, independent of key order. */
function argsHash(args: Record<string, unknown>): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
    : v;
  const kept = Object.fromEntries(Object.entries(args).filter(([k, v]) => !NOT_COMPARED.has(k) && v !== undefined));
  return crypto.createHash("sha256").update(JSON.stringify(canon(kept))).digest("hex");
}

/**
 * Claims a request_id for a call about to start something. { claimed }: this call is the first;
 * it must bind what it starts, or release the claim, with the token it gets. Otherwise the earlier
 * call's row: bound (node_id set), still starting (node_id ""), or a mismatch when it was used for
 * something else. The claim is one INSERT, so of two calls with one request_id, from any number of
 * processes, one wins. A claim is taken over only when the process that holds it has gone, never
 * because it is slow: starting can take as long as git does.
 */
export function claimCall(scope: string, tool: string, requestId: string, args: Record<string, unknown>): { claimed: string } | { call: CallRow } | { starting: CallRow } | { mismatch: CallRow } {
  const hash = argsHash(args);
  const token = crypto.randomBytes(12).toString("hex");
  return tx(() => {
    const held = db().prepare("SELECT * FROM calls WHERE scope = ? AND request_id = ? AND node_id = ''").get(scope, requestId) as CallRow | undefined;
    if (held && !sameProcess(held.owner_pid, held.owner_start)) db().prepare("DELETE FROM calls WHERE scope = ? AND request_id = ? AND claim = ?").run(scope, requestId, held.claim);
    const won = db().prepare("INSERT OR IGNORE INTO calls (scope, request_id, tool, args_hash, node_id, turn_id, claim, owner_pid, owner_start, created_at) VALUES (?, ?, ?, ?, '', NULL, ?, ?, ?, ?)")
      .run(scope, requestId, tool, hash, token, process.pid, procStart(process.pid), now());
    if (Number(won.changes) === 1) return { claimed: token };
    const row = db().prepare("SELECT * FROM calls WHERE scope = ? AND request_id = ?").get(scope, requestId) as unknown as CallRow;
    if (row.tool !== tool || row.args_hash !== hash) return { mismatch: row };
    return row.node_id ? { call: row } : { starting: row };
  });
}

/** Records what the claiming call started, as soon as it exists, so that a repeat arriving while the first call still waits finds it. Only the claim's holder can. */
export function bindCall(scope: string, requestId: string, claim: string, nodeId: string, turnId: number | null = null): void {
  db().prepare("UPDATE calls SET node_id = ?, turn_id = ? WHERE scope = ? AND request_id = ? AND claim = ? AND node_id = ''").run(nodeId, turnId, scope, requestId, claim);
}

/** Gives up a claim that started nothing (the call was refused or failed), so that a repeat may try again. */
export function releaseCall(scope: string, requestId: string, claim: string): void {
  db().prepare("DELETE FROM calls WHERE scope = ? AND request_id = ? AND claim = ? AND node_id = ''").run(scope, requestId, claim);
}

/** Calls that hold the claim on their request_id and are now starting their work, with the claim's token. */
const claimed = new WeakMap<object, string>();

/**
 * For a call that names a request_id: claims it and runs the call (start), or, when an earlier
 * call from the same caller holds it, answers from what that call started (replay, which the tool's
 * module gives, since only it knows its views). null means go ahead: the call names no request_id,
 * or it is the claiming call itself, run by start.
 */
export async function once(
  inst: Instance, tool: string, a: { request_id?: string; background?: boolean }, w: ToolCall, start: () => Promise<Json>, replay: (call: CallRow) => Promise<Json>,
): Promise<Json | null> {
  const scope = a.request_id ? callScope(inst) : null;
  if (!scope || claimed.has(a)) return null;
  const requestId = a.request_id!;
  // A call still starting is waited for, a while; its worktree may take long to create. Never past
  // the tool call's one shared deadline, where the host times calls out (ToolCall.deadline).
  for (const until_ = Math.min(now() + 30_000, w.deadline ?? Infinity); ;) {
    const c = claimCall(scope, tool, requestId, a as Json);
    if ("claimed" in c) {
      claimed.set(a, c.claimed);
      try {
        return await start();
      } finally {
        claimed.delete(a);
        releaseCall(scope, requestId, c.claimed);
      }
    }
    const bound = "call" in c ? c.call : "mismatch" in c ? c.mismatch : null;
    if (bound?.node_id && !canReadItem(inst, bound.node_id)) return UNAVAILABLE();
    if ("mismatch" in c) {
      return refused(`request_id "${requestId}" was already used by an earlier ${c.mismatch.tool} call of yours that asked for something else${c.mismatch.node_id ? ` (it started ${c.mismatch.node_id})` : ""}. Use a new request_id for a new call.`);
    }
    if ("call" in c) return replay(c.call);
    if (now() >= until_) return refused(`an earlier call with request_id "${requestId}" is still starting. Call again in a moment.`);
    await sleep(100);
  }
}

/** Records what the claiming call started, as soon as it exists. */
export function noteCall(inst: Instance, a: { request_id?: string }, nodeId: string, turnId: number | null = null): void {
  const claim = claimed.get(a);
  const scope = a.request_id && claim ? callScope(inst) : null;
  if (scope) bindCall(scope, a.request_id!, claim!, nodeId, turnId);
}
