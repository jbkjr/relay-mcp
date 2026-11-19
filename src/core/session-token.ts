// Conversation scopes on a shared relay process (docs/d9-isolation-plan.md). The Claude desktop
// app runs one relay for many conversations and forwards no per-conversation key, so relay issues
// each conversation a token its model carries on every call (the design's capability fallback).
// The token is a bearer capability: it separates conversations that use relay honestly, and
// whoever presents it acts as its conversation. Relay keeps only its owner hash, which stands
// where a process token stood before (runs.root_token, request_id scopes, the env broker).
// OpenCode 2 runs one relay for all the sessions of its background service, and stamps every call
// with the session it comes from: there the stamp, not a token, picks the view (hostSessionOwner).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { relayHome } from "./config.js";
import { db, type RunRow } from "./db.js";
import { procStart } from "./procs.js";
import { ownerOpen } from "./adoption.js";
import { SESSION_TOKEN_SHAPE } from "./secrets.js";
import type { Instance } from "./caller.js";

const PREFIX = "rs1_";
const NONCE = 16, TAG = 12;
/** A token-shaped string in any case, wherever it appears: never forwarded to another agent (server.ts), cut from agents' output (secrets.ts). */
export const TOKEN_SHAPE = SESSION_TOKEN_SHAPE;
/** What relay issues and accepts: lowercase only. */
const TOKEN = new RegExp(`^${TOKEN_SHAPE.source}$`);

/**
 * The relay home's session key, created on first need. Written to a temporary name and linked
 * into place, so that processes starting together agree on one key and none reads a partial one.
 * It lets its holder mint new, empty sessions; it reveals no existing token. Read on every use,
 * so that deleting it revokes every token at once, in running processes too.
 */
function sessionKey(): Buffer {
  const file = path.join(relayHome(), "session.key");
  const read = (): Buffer | null => {
    try {
      const k = fs.readFileSync(file);
      if (k.length !== 32) throw new Error(`relay's session key ${file} is damaged; remove it to revoke every session token and start over`);
      return k;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };
  let key = read();
  if (!key) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, crypto.randomBytes(32), { mode: 0o600, flag: "wx" });
    try { fs.linkSync(tmp, file); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; } finally { fs.rmSync(tmp, { force: true }); }
    key = read();
    if (!key) throw new Error(`relay could not create its session key ${file}`);
  }
  return key;
}

const tag = (nonce: Buffer) => crypto.createHmac("sha256", sessionKey()).update("relay-session-v1").update(nonce).digest().subarray(0, TAG);

/** A new conversation token. Nothing is recorded: a token exists by its valid tag alone. */
export function issueSessionToken(): string {
  const nonce = crypto.randomBytes(NONCE);
  return PREFIX + Buffer.concat([nonce, tag(nonce)]).toString("hex");
}

/** The owner hash a valid token stands for, or null for anything relay did not issue under this home's key. */
export function sessionOwner(raw: unknown): string | null {
  if (typeof raw !== "string" || !TOKEN.test(raw)) return null;
  const bytes = Buffer.from(raw.slice(PREFIX.length), "hex");
  if (!crypto.timingSafeEqual(bytes.subarray(NONCE), tag(bytes.subarray(0, NONCE)))) return null;
  return crypto.createHash("sha256").update("relay-session-owner-v1").update(raw).digest("hex");
}

/**
 * One conversation's view of a shared root instance: its own owner token, default run and
 * delivery state; the process's context, client and host profile read through. Assigning a
 * read-through field on a view throws, so per-conversation code cannot change the process.
 * via says what chose it: a session token its model carries, or the host's own session key.
 */
export function sessionView(base: Instance, owner: string, via: "token" | "host-key" = "token"): Instance {
  const view = {
    runId: null as string | null, token: owner, ...(via === "token" ? { carried: true as const } : { keyed: true as const }),
    get hostKey() { return base.hostKey; },
    handedOff: new Set<string>(), asking: new Map<string, AbortController>(), noted: new Set<string>(),
    since: new Map<string, number>(), waiting: new Map<number, { runId: string; items: Set<string> }>(), reapedAt: undefined as number | undefined,
    get ctx() { return base.ctx; }, get cwd() { return base.cwd; }, get family() { return base.family; },
    get registration() { return base.registration; }, get clientName() { return base.clientName; },
    get desktopEntry() { return base.desktopEntry; }, get host() { return base.host; },
    get singletonStamps() { return base.singletonStamps; }, get singletonViolation() { return base.singletonViolation; },
  };
  return view as Instance;
}

/**
 * The owner a host session key stands for in this process. The key is no secret (OpenCode keeps it
 * in its logs and database), so it is bound to the process's own random token: it keeps sessions
 * apart within the process, and gives no claim on work after a restart, which stays orphaned until
 * the person adopts it, as for a dedicated session.
 */
export function hostSessionOwner(base: Instance, kind: NonNullable<Instance["hostKey"]>, key: string): string {
  return crypto.createHash("sha256").update("relay-host-session-v1").update(JSON.stringify([base.token, kind, key])).digest("hex");
}

/**
 * A view for a token presented again, after a restart or an eviction: membership is the owner
 * hash, so the conversation keeps its runs. Its events come from each run's creation, it goes on
 * in its latest run that is not cancelled, and it takes over the lease of runs whose recorded
 * process is gone, so that they no longer look orphaned to relay adopt.
 */
export function hydrate(view: Instance): Instance {
  const runs = db().prepare("SELECT * FROM runs WHERE root_token = ? ORDER BY created_at, id").all(view.token) as unknown as RunRow[];
  for (const r of runs) {
    view.since.set(r.id, r.created_at);
    if (r.status !== "cancelled") view.runId = r.id;
    if (!ownerOpen(r)) {
      db().prepare("UPDATE runs SET root_pid = ?, root_start = ? WHERE id = ? AND root_token = ?").run(process.pid, procStart(process.pid), r.id, view.token);
    }
  }
  return view;
}

/**
 * The conversation views of one shared process: a bounded cache. A view is pinned while any call
 * acts as it (acquire to release), and while it has a wait or a question open, and is never
 * evicted then: a conversation never has two views at once.
 */
export class SessionViews {
  private views = new Map<string, Instance>();
  private active = new Map<Instance, number>();
  constructor(private base: Instance, private max = 256) {}
  /** The conversation's view, pinned until release: hydrated from the registry when not cached. */
  acquire(owner: string, via: "token" | "host-key" = "token"): Instance {
    let view = this.views.get(owner);
    if (view) this.views.delete(owner);
    else view = hydrate(sessionView(this.base, owner, via));
    this.views.set(owner, view);
    this.active.set(view, (this.active.get(view) ?? 0) + 1);
    for (const [k, v] of this.views) {
      if (this.views.size <= this.max) break;
      if (!this.active.has(v) && !v.waiting.size && !v.asking.size) this.views.delete(k);
    }
    return view;
  }
  release(view: Instance): void {
    const n = (this.active.get(view) ?? 1) - 1;
    if (n > 0) this.active.set(view, n);
    else this.active.delete(view);
  }
  /** Whether a call acts as this owner now, or its view has a wait or a question open. */
  inUse(owner: string): boolean {
    for (const v of this.active.keys()) if (v.token === owner) return true;
    const view = this.views.get(owner);
    return Boolean(view && (view.waiting.size || view.asking.size));
  }
  all(): Instance[] { return [...this.views.values()]; }
}

/** Whether any work of runs this owner holds is queued or running, so that its environment broker is still wanted. */
export const ownerBusy = (owner: string): boolean =>
  Boolean(db().prepare("SELECT 1 FROM nodes n JOIN runs r ON r.id = n.run_id WHERE r.root_token = ? AND n.status IN ('queued', 'running') LIMIT 1").get(owner));
