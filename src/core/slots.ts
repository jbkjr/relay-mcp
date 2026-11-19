import { db, now, reap, runConfig, tx } from "./db.js";
import { registryPoll } from "./wake.js";

/** The longest a slot request goes without looking. It looks sooner when another process commits to the registry, as one does that frees a slot. */
const LOOK_MS = 150;
/** How often a waiting request drops the slots of processes that have died. */
const REAP_MS = 3000;

/**
 * Slots this request may not take: those held, and one for each request that came before it and
 * is still waiting. One statement, so both counts are from the same moment.
 */
const taken = (runId: string, id: number): number =>
  (db().prepare("SELECT (SELECT COUNT(*) FROM slots WHERE run_id = ? AND state = 'held') + (SELECT COUNT(*) FROM slots WHERE run_id = ? AND state = 'waiting' AND id < ?) AS c")
    .get(runId, runId, id) as { c: number }).c;

/**
 * Concurrency limit: at most max_concurrent slots in state 'held' per run. Requests are granted in
 * arrival order: a request takes a slot only while there is one for it and for every request that
 * came before it, so the requests that get the free slots are the earliest ones, and each takes its
 * own without waiting for those ahead of it to take theirs. A slot whose holder is blocked inside a
 * relay call is 'lent' and does not count, so agents waiting on their own children cannot starve
 * those children of capacity.
 */
export async function acquireSlot(runId: string, holder: string, shouldAbort: () => boolean): Promise<number | null> {
  const max = runConfig(runId).max_concurrent;
  const r = db().prepare("INSERT INTO slots (run_id, holder, pid, state, created_at) VALUES (?, ?, ?, 'waiting', ?)")
    .run(runId, holder, process.pid, now());
  const id = Number(r.lastInsertRowid);
  const poll = registryPoll();
  let reaped = -Infinity;
  for (;;) {
    if (shouldAbort()) {
      releaseSlot(id);
      return null;
    }
    if (now() - reaped >= REAP_MS) {
      reap(runId);
      reaped = now();
    }
    // Read first, and take the write lock only when there is room: requests waiting in many
    // processes look each time the registry changes.
    if (taken(runId, id) < max) {
      const granted = tx(() => {
        if (taken(runId, id) >= max) return false;
        db().prepare("UPDATE slots SET state = 'held' WHERE id = ?").run(id);
        return true;
      });
      if (granted) return id;
    }
    await poll.nap(LOOK_MS);
  }
}

export function releaseSlot(id: number): void {
  db().prepare("DELETE FROM slots WHERE id = ?").run(id);
}

/** Lends the caller's slot for the duration of a blocking relay call. Returns an undo function. */
export function lendSlot(holder: string | null): () => void {
  if (!holder) return () => {};
  const r = db().prepare("UPDATE slots SET state = 'lent' WHERE holder = ? AND state = 'held'").run(holder);
  if (!r.changes) return () => {};
  // Reclaimed immediately on return: the caller is already running, so making it wait for a free
  // slot would only delay a tool result. New work still starts only while held < max.
  return () => {
    db().prepare("UPDATE slots SET state = 'held' WHERE holder = ? AND state = 'lent'").run(holder);
  };
}
