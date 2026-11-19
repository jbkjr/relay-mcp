// Waiting: how long one call may wait, and the wait itself, which lends the caller's slot, reports
// progress, and returns early for a root session when an approval request needs its agent.
import { elicitationState, pendingRequests } from "./approvals.js";
import { ownsRun, type Instance, type Json, type ToolCall } from "./caller.js";
import { busy, getNode, now, runConfig } from "./db.js";
import { lendSlot } from "./slots.js";
import { progressLine } from "./views.js";
import { registryPoll } from "./wake.js";
import { watchRequests } from "./watch.js";

/** The longest a status call waits where the host moves long calls to the background (HostView.longWaits, in Instance.host). */
export const LONG_WAIT_S = 6 * 3600;

interface WaitOpts {
  /** Set for a root session: new approval requests in this run interrupt the wait. */
  root?: { inst: Instance; runId: string };
  ms: number;
  /** Node whose slot is lent while this call blocks. */
  lender: string | null;
  onTick?: ToolCall["onTick"];
  signal?: AbortSignal;
  /** The item whose progress the ticks describe. */
  progressOf?: string;
  /** The items this call waits on: their events are delivered by its result rather than by a notice. */
  awaits?: string[];
}

/** How often a waiting call reports progress. RELAY_TICK_MS shortens it for tests. */
const tickMs = () => Number(process.env.RELAY_TICK_MS) || 15000;

/**
 * How often a waiting call looks at everything: the item, approval requests (putting new ones to
 * the user), its limit and its progress. Between these looks, a commit by another process to the
 * registry (registryPoll) brings a quick look at what could end the wait now: the item settling,
 * or a request newly filed.
 */
const LOOK_MS = 200;

let waitIds = 0;

export async function waitUntil(done: () => boolean, opts: WaitOpts): Promise<boolean> {
  const giveBack = lendSlot(opts.lender);
  const start = now();
  let lastTick = start;
  const poll = registryPoll();
  const me = ++waitIds;
  // A launched agent is asking to act outside its sandbox. The user is asked directly where the
  // host allows it; anything they are not being asked about now goes to the calling agent, by
  // returning early, once per request.
  const unasked = (root: NonNullable<WaitOpts["root"]>) =>
    pendingRequests(root.runId).filter((r) => !root.inst.handedOff.has(r.id) && !root.inst.asking.has(r.id) && elicitationState(r.id) !== "asking");
  if (opts.root) opts.root.inst.waiting.set(me, { runId: opts.root.runId, items: new Set([...(opts.awaits ?? []), ...(opts.progressOf ? [opts.progressOf] : [])]) });
  try {
    for (;;) {
      if (done()) return true;
      if (now() - start >= opts.ms) return false;
      // The caller no longer wants the answer. Only the wait ends: nothing it was waiting for is touched.
      if (opts.signal?.aborted) return false;
      if (opts.root) {
        watchRequests(opts.root.inst);
        // The transport commits the handoff only after this result reaches the caller.
        if (unasked(opts.root).length) return false;
      }
      if (opts.onTick && now() - lastTick >= tickMs()) {
        lastTick = now();
        let line: string | undefined;
        try {
          line = opts.progressOf ? progressLine(opts.progressOf) : undefined;
        } catch {
          // Progress only.
        }
        opts.onTick(now() - start, line);
      }
      // Never past the call's limit: a wait that has used it up looks once more and returns.
      const next = Math.min(start + opts.ms, now() + LOOK_MS);
      while (await poll.nap(next - now(), opts.signal)) {
        if (done()) return true;
        // A request not yet put to the user: the full look puts it to them first, where the host can ask.
        if (opts.root && unasked(opts.root).length) break;
      }
    }
  } finally {
    opts.root?.inst.waiting.delete(me);
    giveBack();
  }
}

/** Finished: neither queued nor running a turn. */
export const settled = (id: string) => {
  const n = getNode(id);
  return !n || !busy(n);
};

/**
 * How long one call waits, in seconds: `seconds` (block_s if not given), capped at block_s, or for a
 * status wait (`long`) in a host that moves long calls to the background, at LONG_WAIT_S; and never
 * past the host's own cap (`capS`, HostProfile.waitCapS), whatever else allows.
 */
export function waitLimitS(block: number, seconds: number | undefined, o: { long?: boolean; longWaits?: boolean; capS?: number | null } = {}): number {
  const cap = o.long && o.longWaits ? Math.max(block, LONG_WAIT_S) : block;
  return Math.min(seconds ?? block, cap, o.capS ?? Infinity);
}

/** A call's wait, as waitLimitS says, and never past the tool call's one shared deadline (w.deadline). */
export function waitOpts(inst: Instance, runId: string, w: ToolCall, o: { seconds?: number; long?: boolean; progressOf?: string; awaits?: string[] } = {}): WaitOpts {
  const root = inst.ctx.kind === "root";
  const limit = waitLimitS(runConfig(runId).block_s, o.seconds, { long: o.long, longWaits: root && inst.host.longWaits, capS: inst.host.waitCapS });
  // One deadline for the whole tool call: nested waits share it, so together they stay under the
  // host's tool-call timeout. A wait that reaches it gets no time, and the caller returns a pending handle.
  const ms = w.deadline !== undefined ? Math.min(limit * 1000, Math.max(0, w.deadline - now())) : limit * 1000;
  return {
    ms, lender: inst.ctx.kind === "child" ? inst.ctx.nodeId : null, onTick: w.onTick, signal: w.signal,
    progressOf: o.progressOf, awaits: o.awaits, root: inst.ctx.kind === "root" && ownsRun(inst, runId) ? { inst, runId } : undefined,
  };
}

/**
 * A status wait. If relay ended it at its limit, short of the wait_s asked for and before the item
 * finished, the result says so, and how to go on waiting (wait_ended).
 */
export async function waitFor(id: string, seconds: number, done: () => boolean, opts: WaitOpts): Promise<Json> {
  const start = now();
  if (await waitUntil(done, opts)) return {};
  if (seconds * 1000 <= opts.ms || now() - start < opts.ms) return {};
  // Whole seconds: a wait clamped to the call's shared deadline can end at any fraction of one.
  return { wait_ended: `Relay ends a wait after ${Math.ceil(opts.ms / 1000)} s here, and ${id} has not finished. Call status with id "${id}" and wait_s again to go on waiting.` };
}
