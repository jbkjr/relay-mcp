// Waking a poll early. Relay's processes share nothing but the registry, so a call that waits on
// another process's work polls it, and between looks it naps. A nap ends early once another
// process has committed to the registry since the poll last looked: SQLite appends every commit
// to the write-ahead log, a file watch on the log (kqueue) reports the write at once, and
// PRAGMA data_version, which changes only when another connection has committed, confirms it.
// The wake is only a hint to look now. What the poll waits for is still read from the registry,
// and the poll's own interval still bounds every nap: a commit of this process's own, state kept
// outside the registry (a process that died, a signal), or a watch that could not be set up are
// seen no later than before.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { relayHome } from "./config.js";
import { db, now } from "./db.js";

/**
 * Early wakes a poll may take in a burst, and how fast it earns them back: a registry that other
 * processes write to without pause (an agent streaming activity) wakes each poll at most once per
 * WAKE_GAP_MS, so a poll's own look never runs more often than that for long.
 */
const WAKE_BURST = 3;
const WAKE_GAP_MS = 10;
/** A watch event can arrive a moment before the commit that caused it is visible: one more look after this long. */
const RELOOK_MS = 1;
/**
 * The watch is kept this long after the last nap has ended, so that a poll does not set it up again
 * on every look; and a log that could not be watched is tried again no sooner, since a watch that
 * fails costs more than the naps it would shorten.
 */
const LINGER_MS = 1000;

const versions = new WeakMap<DatabaseSync, StatementSync>();

/** Changes whenever another connection has committed to the registry since this one last asked; never for this connection's own commits. */
function dataVersion(): number {
  const d = db();
  let s = versions.get(d);
  if (!s) versions.set(d, (s = d.prepare("PRAGMA data_version")));
  return (s.get() as { data_version: number }).data_version;
}

interface Napper {
  since: number;
  wake: () => void;
}

const nappers = new Set<Napper>();
let watched: { file: string; watcher: fs.FSWatcher; dev: number; ino: number } | null = null;
let relook: NodeJS.Timeout | null = null;
let linger: NodeJS.Timeout | null = null;
let lastNapEnd = 0;
let watchFailed: { file: string; at: number } | null = null;

/** On a write to the log: wakes every nap whose poll has not seen the registry as it is now. */
function look(again: boolean): void {
  if (!nappers.size) return;
  let v: number;
  try {
    v = dataVersion();
  } catch {
    // Unreadable now: each poll looks when its nap ends.
    return;
  }
  let missed = false;
  for (const n of [...nappers]) {
    if (v !== n.since) n.wake();
    else missed = true;
  }
  if (missed && again && !relook) {
    relook = setTimeout(() => {
      relook = null;
      look(false);
    }, RELOOK_MS);
    relook.unref();
  }
}

function watch(): void {
  const file = path.join(relayHome(), "relay.db-wal");
  if (watched?.file === file || (watchFailed?.file === file && now() - watchFailed.at < LINGER_MS)) return;
  unwatch();
  let watcher: fs.FSWatcher | undefined;
  try {
    // Not persistent: a nap's own timer is what keeps a process waiting, never the watch.
    watcher = fs.watch(file, { persistent: false }, (event) => {
      // On macOS a write that does not extend the file is reported as a rename too, and so is
      // every commit once the log has started over after a checkpoint. Only a log that is gone or
      // replaced ends this watch, which would see no more writes; the next nap sets up another.
      const w = watched;
      if (event === "rename" && w && w.watcher === watcher) {
        const st = fs.statSync(file, { throwIfNoEntry: false });
        if (!st || st.dev !== w.dev || st.ino !== w.ino) unwatch();
      }
      look(true);
    });
    const own = watcher;
    own.on("error", () => {
      if (watched?.watcher === own) unwatch();
    });
    const st = fs.statSync(file);
    watched = { file, watcher: own, dev: st.dev, ino: st.ino };
  } catch {
    // No log to watch (yet): naps run their full length, as polls always did.
    if (watcher && watched?.watcher !== watcher) watcher.close();
    watchFailed = { file, at: now() };
  }
}

/** The last nap has ended: the watch goes once no nap has been on for LINGER_MS. One timer a second at most, however often a poll looks. */
function released(): void {
  lastNapEnd = now();
  if (!linger && watched) {
    linger = setTimeout(lingered, LINGER_MS);
    linger.unref();
  }
}

function lingered(): void {
  linger = null;
  // A nap is on: its end arms this again.
  if (nappers.size) return;
  const quiet = now() - lastNapEnd;
  if (quiet >= LINGER_MS) return unwatch();
  linger = setTimeout(lingered, LINGER_MS - quiet);
  linger.unref();
}

function unwatch(): void {
  if (linger) {
    clearTimeout(linger);
    linger = null;
  }
  const w = watched;
  watched = null;
  try {
    w?.watcher.close();
  } catch {
    // Already closed.
  }
}

/**
 * A poll on the registry. Look first, then nap(ms) until the next look: the nap ends after ms, or
 * sooner once another process has committed to the registry since the previous nap ended (or since
 * the poll was made, before the first), or when the signal aborts. Resolves true when a commit
 * ended it early.
 */
export function registryPoll(): { nap: (ms: number, signal?: AbortSignal) => Promise<boolean> } {
  const version = (): number => {
    try {
      return dataVersion();
    } catch {
      return NaN;
    }
  };
  let since = version();
  let credit = WAKE_BURST;
  let creditAt = now();
  /** How long this early wake waits for the poll's allowance. */
  const spend = (): number => {
    const t = now();
    credit = Math.min(WAKE_BURST, credit + (t - creditAt) / WAKE_GAP_MS) - 1;
    creditAt = t;
    return credit >= 0 ? 0 : -credit * WAKE_GAP_MS;
  };
  const nap = (ms: number, signal?: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      let over = false;
      let timer: NodeJS.Timeout | undefined;
      let held: NodeJS.Timeout | undefined;
      const end = (early: boolean) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        clearTimeout(held);
        signal?.removeEventListener("abort", onAbort);
        nappers.delete(napper);
        if (!nappers.size) released();
        // The next nap wakes for commits after this moment; the caller looks at the registry next.
        since = version();
        resolve(early);
      };
      const onAbort = () => end(false);
      const napper: Napper = {
        since,
        wake: () => {
          if (over || held) return;
          const wait = spend();
          if (wait > 0) held = setTimeout(() => end(true), wait);
          else end(true);
        },
      };
      if (ms <= 0 || signal?.aborted) return end(false);
      timer = setTimeout(() => end(false), ms);
      signal?.addEventListener("abort", onAbort, { once: true });
      nappers.add(napper);
      watch();
      // A commit between the last look and this nap's watch.
      const v = version();
      if (!Number.isNaN(v) && v !== since) napper.wake();
    });
  return { nap };
}
