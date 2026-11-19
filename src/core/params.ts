// What relay keeps in a node's params_json, read in one place. A leaf module: core and modes both
// read a node's params through it, and it imports nothing but types, so that neither has to import
// the other to know what a job's review is or what grant a session holds.
import type { Grant } from "../backends/types.js";
import type { DirPin } from "../confine/index.js";
import type { NodeRow, NodeStatus } from "./db.js";
import type { SessionExtensions } from "./extensions.js";
import type { Marker } from "./prompts.js";
import type { FamilyId, Speed } from "../targets/types.js";
import type { CallerSnapshot } from "./identity.js";

export interface FamilyDoubt { side: "caller" | "launched"; code: string; detail?: string }
export interface FamilyParams {
  caller_snapshots?: CallerSnapshot[];
  caller_families?: FamilyId[];
  family_doubts?: FamilyDoubt[];
}

/**
 * A session's params (a job's or a thread's), as relay writes them. Each reader keeps its own
 * default for what is missing, and its own check of a value it does not trust the type of.
 */
interface SessionParams extends FamilyParams {
  /** Plain policy notes from turns, kept apart from errors and process warnings. */
  notes?: string[];
  launched_family?: FamilyId;
  served_models?: string[];
  /** Presence distinguishes an explicit missing/unlisted report from no report yet. */
  served_model?: string | null;
  /** What the root granted beyond the session's sandbox, with each write path's identity pin. */
  grant?: Grant | null;
  /**
   * The speed of the session's turn now running or last started (session.ts startSpeed); before its
   * first turn, the one it was started at (caller.ts admitSpeed). Absent: standard.
   */
  speed?: Speed;
  /**
   * The speed each turn that a call continuing the session queued was admitted at (caller.ts
   * changeSpeed), by turn id, until that turn starts and its speed becomes `speed`. A turn without
   * one (a session's first, say) runs at the speed of the turn before it. One of a turn that ended
   * without starting (cancelled while queued) is never applied.
   */
  speed_queued?: Record<string, Speed> | null;
  /**
   * The raise of `speed` that the turn `turn` started with, and the speeds before and after. Kept
   * until that turn ends; if it never reaches the model (refused by the account's catalog, say),
   * the session goes back to `from` (session.ts settleSpeedChange).
   */
  speed_change?: { turn: number; from: Speed; to: Speed } | null;
  scope?: string[] | null;
  /** Where in its checkout the caller was, for a write job's prompt. */
  subdir?: unknown;
  /** The job's worktree as relay made it, which a relay-enforced turn checks it still is. */
  worktree_pin?: DirPin;
  /** The review a reviewer job belongs to. */
  review_id?: string;
  /** A session's own outcome, apart from the turns it ran for a discussion it was borrowed for (outcome.ts OwnOutcome). */
  own?: { status: NodeStatus; error: string | null };
  /**
   * The person's consent to a Codex write job's local network (grant.local_network), for the grant
   * it was given under (session.ts localNetworkKey): a grant that changes is asked about again.
   */
  local_network_consent?: { grant: string; by: string; at: number } | null;
  /**
   * Stage 2: each running turn's copy of its skill package (codex-stage2.ts stage2SkillAssets, a
   * `relay-ext-*` directory in relay's private root), by turn id, until the turn removes it. After a
   * crash, the retention sweep removes a listed one once its turn is over (stage2-executors.ts).
   */
  ext_assets?: Record<string, string> | null;
  /** The person's consent to a Codex job's raw network (grant.raw_network, stage 2), bound to the grant like local_network_consent (core/raw-network.ts rawNetworkKey). */
  raw_network_consent?: { grant: string; by: string; at: number } | null;
  /**
   * The confinement the session's latest Codex turn ran under (stage 2, docs/codex-confinement-design.md §2.4):
   * "relay" for a turn in relay's Seatbelt, "codex" for Codex's own sandbox. Kept here, in the node's params,
   * so the registry's schema does not change (backends/codex-stage2.ts recordEnforcement).
   */
  codex_confinement?: { turn: number; enforcement: "codex" | "relay" } | null;
  /** The skills and MCP servers the session was given when it started, and the person's consent (docs/extensions.md). */
  extensions?: SessionExtensions | null;
}

export const sessionParams = (n: Pick<NodeRow, "params_json">): SessionParams => JSON.parse(n.params_json ?? "{}") as SessionParams;

const asSpeed = (s: unknown): Speed => (s === "fast" || s === "ultrafast" ? s : "standard");

/**
 * The speed of a session's turn now running or last started (SessionParams.speed), or standard
 * (rows from before speeds, and anything relay did not write). What a launched agent's own turn
 * runs at. The speed a call continuing the session goes on at is db.ts speedAfter.
 */
export function speedOf(n: Pick<NodeRow, "params_json">): Speed {
  return asSpeed(sessionParams(n).speed);
}

/** The speeds of a session's queued turns that calls were admitted at (SessionParams.speed_queued), by turn id, in turn order. */
export function queuedSpeeds(n: Pick<NodeRow, "params_json">): [number, Speed][] {
  const q = sessionParams(n).speed_queued;
  if (!q || typeof q !== "object") return [];
  return Object.entries(q).map(([t, s]): [number, Speed] => [Number(t), asSpeed(s)]).filter(([t]) => Number.isInteger(t)).sort((a, b) => a[0] - b[0]);
}

/** The change to a session's speed that waits on the turn `turnId` reaching the model (SessionParams.speed_change), or null. */
export function speedChange(n: Pick<NodeRow, "params_json">, turnId: number): { from: Speed; to: Speed } | null {
  const c = sessionParams(n).speed_change;
  return c && c.turn === turnId ? { from: c.from, to: c.to } : null;
}

export interface DiscussionParams extends FamilyParams {
  /** max_turns: the most messages across both sides, only where the caller set one; otherwise there is no limit. */
  topic: string; role: string; max_turns?: number;
  /** The other family's session, and whether it existed before this discussion. */
  participant: string; borrowed: boolean;
  /** The two sides' labels: the calling agent's (see callerSide) and the participant's. Rows from before labels were stored have no `other`. */
  caller: string; other?: string;
  extra_rules?: string; review_id?: string;
  state: {
    /** Messages so far, from both sides. */
    turns: number; opened: boolean;
    /** Human messages: the last one passed to the participant, and the last one shown to the caller. */
    seen: number; shown: number;
    /** The participant's turn whose reply has not been folded in yet. */
    pending?: number;
    last: Record<string, string>; markers: Record<string, Marker>; warnings: string[];
  };
}
export const discussionParams = (n: NodeRow) => JSON.parse(n.params_json!) as DiscussionParams;

export interface ReviewParams extends FamilyParams {
  /** caller and other are the two sides' labels, as in a discussion; rows from before labels were stored have no `other`. */
  target: string; focus: string | null; caller: string; other?: string;
  /** For a plan review, the plan's file: the caller's own, or plan.md in the review's directory for a plan given as text. */
  plan?: string;
  /** The other family's reviewer job. */
  reviewer: string;
  /** The caller's whole host state directory, resolved when it starts the review, denied for the independent turn. */
  caller_transcripts?: string[];
  /** A submission has been tried. Only guidance: never releases withholding or stores its text. */
  submission_tried?: boolean;
  /** Whether the caller's review has been saved, or explicitly skipped, after the reviewer settles. Until then the reviewer's is withheld. */
  own: boolean; skipped?: boolean; discussion?: string;
  /** What the reviewer's job warned of when its review came in. Its later reconciliation turns replace its result. */
  reviewer_warnings?: string[];
  /**
   * The speed a call carrying on the review gave for the reviewer, before its reconciliation was
   * opened: the reconciliation's first turn runs at it (review.ts, passed to discuss), and until then
   * the reviewer's own turn keeps the speed it runs at.
   */
  reviewer_speed?: Speed;
}
export const reviewParams = (n: NodeRow) => JSON.parse(n.params_json!) as ReviewParams;


/**
 * What a consent to local network is bound to: the parts of the grant that decide what the job's
 * shell can reach or write (session.ts localNetworkConsent). A grant that changes any of them is
 * asked about again.
 */
export function localNetworkKey(grant: Grant): string {
  return JSON.stringify({ network: grant.network === true, local_network: grant.local_network === true, write_paths: [...(grant.write_paths ?? [])].sort() });
}
