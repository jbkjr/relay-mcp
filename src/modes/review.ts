// A review: the calling agent reviews the target itself (or with its own subagents) while one
// reviewer of the other family does the same, with the reviews withheld through relay's tools;
// host transcripts and drafts can still expose them. Then the two reconcile
// their lists in a discussion (modes/discussion.ts). What a review is made of: each reviewer's
// verdict, declared coverage and numbered items, and the consensus list the two reconcile them into.
import fs from "node:fs";
import { REFUSAL_POLICY, refusalNote, type VendorRefusal } from "../core/refusal.js";
import os from "node:os";
import { recordStart, addContribution, callerLabel, familiesOf } from "../core/families.js";
import { ownReviewFamilyNote } from "../core/steering.js";
import path from "node:path";
import { admitExisting, admitNew, admitSpeed, admitWork, callerSide, familyOf, knownCaller, refused, type Instance, type Json, type ToolCall } from "../core/caller.js";
import { noteCall } from "../core/calls.js";
import { expandHome, harnessHome, inside, nodeDir, runDir, type Speed, type Target } from "../core/config.js";
import { busy, db, getNode, insertNode, insertTurn, newId, nodeTurns, now, runConfig, speedAfter, tx, updateNode, type NodeRow } from "../core/db.js";
import { dispatch } from "../core/dispatch.js";
import { discussionParams, reviewParams, sessionParams, speedOf, type ReviewParams } from "../core/params.js";
import { lastJsonBlock, PASS_RULE, reviewDiscussionRules, reviewerPrompt, reviewJsonShape, type ReviewSubject } from "../core/prompts.js";
import { CALLER_LABEL, inSideOrder, sideName, sideOfItem, sidePrefix, targetDef, targetLabel } from "../targets/index.js";
import { keepRecord, readProblem, writeProblem } from "../core/storage.js";
import { notesView, pendingHandle, runRecovery, speedView } from "../core/views.js";
import { settled, waitOpts, waitUntil } from "../core/wait.js";
import { discuss, legacyRefusal, legacyTwoSided, otherSide } from "./discussion.js";

interface ReviewItem {
  id: string;
  severity?: string;
  confidence?: string;
  /** Where the item is: a file and an inclusive line range where it has one, and free text otherwise (a symbol, a section of a plan). */
  file?: string;
  lines?: [number, number];
  location?: string;
  summary?: string;
  evidence?: string;
  fix?: string;
}

export const VERDICTS = ["pass", "fail", "unknown"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** What a reviewer says it examined. Only `complete: true` with nothing listed as not examined is full coverage. */
export interface Coverage {
  complete?: boolean;
  examined?: string[];
  not_examined?: string[];
}

/** One side's review as relay records it: the verdict it declared, the verdict that stands, its declared coverage and its items. */
interface SideReview {
  declared: string | null;
  verdict: Verdict | null;
  coverage: Coverage | null;
  items: ReviewItem[];
  note?: string;
  /** The items relay gave an id of its own, because their n was missing, not a positive whole number, or used before: "entry 3 of items (no n) is X5". */
  renumbered?: string[];
}

/** A side's closing block in the reconciliation: its consensus entries, and the verdict and coverage it holds the two reviews to reach together. */
export interface ConsensusBlock {
  consensus: Entry[];
  verdict?: unknown;
  coverage?: unknown;
}
interface Entry {
  ids: string[];
  severity?: string;
  confidence?: string;
  status?: string;
  summary?: string;
  file?: string;
  lines?: [number, number];
  location?: string;
  evidence?: string;
  fix?: string;
}

/** The sides that raised the items, by their ids' prefixes. */
const raisedBy = (ids: string[]) => [...new Set(ids.map((i) => sideOfItem(i) ?? "unknown"))];

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
/** A list of strings, from a string or an array. Entries of other types are kept as their JSON rather than dropped, so that nothing declared is lost. */
const strs = (v: unknown): string[] | undefined =>
  v === undefined || v === null ? undefined
  : typeof v === "string" ? (v.trim() ? [v] : [])
  : (Array.isArray(v) ? v : [v]).map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
/** An inclusive line range, from [start, end], [line] or a single line number. Anything else is left out rather than guessed at. */
function lineRange(v: unknown): [number, number] | undefined {
  const ns = typeof v === "number" ? [v] : Array.isArray(v) ? v : null;
  if (!ns || ns.length < 1 || ns.length > 2 || !ns.every((n) => Number.isInteger(n) && n > 0)) return undefined;
  const [a, b = a] = ns as number[];
  return a <= b ? [a, b] : undefined;
}

/**
 * A coverage statement as declared, with its fields' types checked: complete only as a boolean, and
 * the lists as strings (anything listed as not examined, of whatever type, keeps the coverage partial).
 * Not a judgment of what the reviewer actually read.
 */
export function coverageOf(v: unknown): Coverage | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Json;
  const out: Coverage = {};
  if (typeof c.complete === "boolean") out.complete = c.complete;
  const examined = strs(c.examined);
  const notExamined = strs(c.not_examined);
  if (examined) out.examined = examined;
  if (notExamined) out.not_examined = notExamined;
  return out;
}

/** Whether a declared coverage is full: `complete: true`, and nothing listed as not examined. A missing statement is not full. */
export const fullCoverage = (c: Coverage | null | undefined): boolean => c?.complete === true && !c.not_examined?.length;

/**
 * The verdict that stands, applied mechanically from what the reviewer declared: a "pass" over
 * coverage that is not declared full becomes "unknown"; "fail" and "unknown" stand as given; any
 * other value, or none, is no verdict. Relay never judges coverage itself.
 */
export function standingVerdict(declared: unknown, coverage: Coverage | null | undefined): Verdict | null {
  const v = typeof declared === "string" ? declared.trim().toLowerCase() : null;
  if (!VERDICTS.includes(v as Verdict)) return null;
  return v === "pass" && !fullCoverage(coverage) ? "unknown" : (v as Verdict);
}

/** A declared value as text: a string as it is, anything else as its JSON. Never String(), which runs whatever toString a parsed object carries. */
const shown = (v: unknown): string => (typeof v === "string" ? v : (JSON.stringify(v) ?? typeof v));

const verdictNote = (declared: unknown, verdict: Verdict | null): string | undefined =>
  verdict === "unknown" && typeof declared === "string" && declared.trim().toLowerCase() === "pass"
    ? "a pass over coverage not declared full stands as unknown"
    : declared !== undefined && declared !== null && verdict === null ? `${typeof declared === "string" ? `"${declared}"` : shown(declared)} is not a verdict (pass, fail or unknown)` : undefined;

/** A block that is a review's closing block: an object with items, a verdict or a coverage statement. */
const isReviewBlock = (v: unknown): v is Json =>
  !!v && typeof v === "object" && !Array.isArray(v) && ("items" in v || "verdict" in v || "coverage" in v);

/**
 * A side's review from its message: the last fenced JSON block with items, a verdict or a coverage
 * statement, so that a verdict declared without items is not lost. `side` is a side label: a target id, or CALLER_LABEL.
 */
export function parseReview(side: string, message: string): SideReview {
  const block = lastJsonBlock(message, (v) => (isReviewBlock(v) ? v : null));
  const notes: string[] = [];
  if (block && !Array.isArray(block.items)) notes.push(block.items === undefined ? "the block had no items array" : "the block's items is not an array");
  const entries = (Array.isArray(block?.items) ? block.items : []) as unknown[];
  // An item's id carries its own n where that is a positive whole number not used before; any other
  // item gets the next number above every n given, so that no two items share an id, and the note says which.
  const isItem = (it: unknown): it is Json => !!it && typeof it === "object";
  const used = new Set<number>();
  const own = entries.map((it) => {
    const n = isItem(it) ? it.n : undefined;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || used.has(n)) return null;
    used.add(n);
    return n;
  });
  let next = Math.max(0, ...used);
  const renumbered: string[] = [];
  const left: number[] = [];
  const items = entries.flatMap((it, i) => {
    if (!isItem(it)) {
      left.push(i + 1);
      return [];
    }
    const item: ReviewItem = { id: `${sidePrefix(side)}${own[i] ?? ++next}` };
    if (own[i] === null) {
      const why = it.n === undefined ? "no n" : typeof it.n === "number" && Number.isInteger(it.n) && it.n > 0 ? `n ${it.n}, used before` : `n ${JSON.stringify(it.n)}, not a positive whole number`;
      renumbered.push(`entry ${i + 1} of items (${why}) is ${item.id}`);
    }
    const set = <K extends keyof ReviewItem>(k: K, v: ReviewItem[K] | undefined) => {
      if (v !== undefined) item[k] = v;
    };
    set("severity", str(it.severity));
    set("confidence", str(it.confidence));
    set("file", str(it.file));
    set("lines", lineRange(it.lines));
    set("location", str(it.location));
    set("summary", str(it.summary));
    set("evidence", str(it.evidence));
    set("fix", str(it.fix));
    return [item];
  });
  if (left.length) notes.push(`${left.map((n) => `entry ${n}`).join(", ")} of items ${left.length > 1 ? "are not objects and were" : "is not an object and was"} left out`);
  if (renumbered.length) notes.push(`relay gave its own ids to items whose n was missing, not a positive whole number, or used before: ${renumbered.join(", ")}`);
  const coverage = coverageOf(block?.coverage);
  const declared = block && block.verdict !== undefined ? block.verdict : null;
  const verdict = standingVerdict(declared, coverage);
  const vnote = verdictNote(declared, verdict);
  if (vnote) notes.push(vnote);
  const note = notes.join("; ");
  return { declared: declared === null ? null : shown(declared), verdict, coverage, items, ...(note ? { note } : {}), ...(renumbered.length ? { renumbered } : {}) };
}

/** A sentence naming the items of a side's review that relay gave ids of its own, or "" if there are none. */
const renumberedNote = (r: Partial<SideReview> | null | undefined): string =>
  r?.renumbered?.length ? `Relay gave its own ids to items whose n was missing, not a positive whole number, or used before: ${r.renumbered.join(", ")}.` : "";

/** A side's numbered items, with ids carrying the side's prefix. */
export const parseItems = (side: string, message: string): ReviewItem[] => parseReview(side, message).items;

const parseConsensus = (message: string | null): ConsensusBlock | null =>
  message === null
    ? null
    : lastJsonBlock(message, (v) => {
        const b = v as { consensus?: unknown; verdict?: unknown; coverage?: unknown };
        return Array.isArray(b?.consensus)
          ? { consensus: (b.consensus as Entry[]).filter((e) => e && Array.isArray(e.ids)), verdict: b.verdict, coverage: b.coverage }
          : null;
      });

/**
 * Entries with their fields checked as an item's are: text fields as non-empty strings, lines as an
 * inclusive range. A value of any other type is left out, so that the original item's value stands.
 * A status that is not a string is kept as its JSON, so that a side's position shows what it wrote.
 */
const entriesOf = (es: Entry[] | null): Entry[] | null =>
  es?.map((e) => {
    const out: Entry = { ids: e.ids.filter((id) => typeof id === "string") };
    for (const f of ["severity", "confidence", "status", "summary", "file", "location", "evidence", "fix"] as const) {
      const v = str(e[f]);
      if (v !== undefined) out[f] = v;
    }
    if (out.status === undefined && e.status !== undefined && e.status !== null && typeof e.status !== "string") out.status = shown(e.status);
    const lines = lineRange(e.lines);
    if (lines) out.lines = lines;
    return out;
  }) ?? null;

/** The fields an entry carries over from its first original item, or from the entries where both give the same value. */
const FIELDS = ["severity", "confidence", "summary", "file", "lines", "location", "evidence", "fix"] as const;
const pick = (from: Partial<Record<(typeof FIELDS)[number], unknown>> | undefined) => Object.fromEntries(FIELDS.map((f) => [f, from?.[f]]));
/** The two statuses that settle an item, where both closing blocks give it the same one at the same severity. */
const SETTLED = ["agreed", "dropped"];
const sameIds = (x: string[], y: string[]) => [...x].sort().join() === [...y].sort().join();

/**
 * Builds the consensus list: a join of the two sides' closing blocks on item id, whether or not the
 * reconciliation ended in agreement, so that the block of the side that closed it (often the caller,
 * whose work is under review) never settles an item alone. An item is agreed or dropped only where
 * both blocks give it that status and the same severity; a block that gives an entry no severity
 * holds the one its items share in the reviews. Anything else, a missing or malformed status
 * included, is unresolved, with each side's position as its block gave it. A merge both blocks make
 * stands. An entry's other fields replace the original item's only where both blocks give the same
 * value; where they rate confidence differently, both ratings are kept.
 * `sides` holds the two sides' final entries, keyed by side label, in the order they are to be named.
 */
export function buildConsensus(items: ReviewItem[], sidesAs: Record<string, Entry[] | null>): Json[] {
  const sides = Object.fromEntries(Object.entries(sidesAs).map(([l, es]) => [l, entriesOf(es)]));
  const [la, lb] = Object.keys(sides);
  const byId = new Map(items.map((i) => [i.id, i]));
  const find = (side: Entry[] | null, id: string) => side?.find((e) => e.ids.includes(id));
  const severityOf = (e: Entry): string | undefined => {
    if (e.severity !== undefined) return e.severity;
    const held = new Set(e.ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!.severity));
    return held.size === 1 ? [...held][0] : undefined;
  };
  const positionOf = (e: Entry | undefined, ids: string[]): Json =>
    e ? { status: e.status ?? "not stated", ...(e.severity !== undefined ? { severity: e.severity } : {}), ...(sameIds(e.ids, ids) ? {} : { ids: e.ids }) } : { status: "not stated" };
  const out: Json[] = [];
  const covered = new Set<string>();
  for (const item of items) {
    if (covered.has(item.id)) continue;
    const a = find(sides[la], item.id);
    const b = find(sides[lb], item.id);
    // A merge stands where both sides merged the same ids; its ids are listed in the reviews' order.
    const merged = a && b && sameIds(a.ids, b.ids) ? new Set(a.ids) : new Set([item.id]);
    const ids = items.filter((i) => merged.has(i.id) && !covered.has(i.id)).map((i) => i.id);
    ids.forEach((id) => covered.add(id));
    const first = byId.get(ids[0])!;
    if (a && b && a.status === b.status && SETTLED.includes(a.status!) && severityOf(a) === severityOf(b)) {
      const both = (f: (typeof FIELDS)[number]) => (a[f] !== undefined && JSON.stringify(a[f]) === JSON.stringify(b[f]) ? a[f] : first[f]);
      const confidence = a.confidence === undefined && b.confidence === undefined ? first.confidence : a.confidence === b.confidence ? a.confidence : `${a.confidence ?? "?"} (${la}) / ${b.confidence ?? "?"} (${lb})`;
      out.push({ ids, raised_by: raisedBy(ids), status: a.status, ...Object.fromEntries(FIELDS.map((f) => [f, both(f)])), severity: severityOf(a), confidence });
    } else {
      out.push({ ids, raised_by: raisedBy(ids), status: "unresolved", ...pick(first), positions: { [la]: positionOf(a, ids), [lb]: positionOf(b, ids) } });
    }
  }
  return out;
}

/** What the result says of one side's closing block: the verdict that stands, the one declared, the declared coverage. */
export interface Closing {
  verdict: Verdict | "not stated";
  declared_verdict: string | null;
  coverage: Coverage | null;
  note?: string;
}

/**
 * The review's verdict once reconciled, by the same rule as each side's, from both sides' closing
 * blocks whether or not they agreed: a verdict both blocks reach stands, and anything else is
 * unresolved, with each side's position. One side's block alone never settles it, so the side that
 * closes the discussion (often the caller, whose work is under review) cannot set the verdict on
 * its own. Each side's closing declaration is kept in `closing`.
 *
 * `reviews` is the two independent reviews' declared coverage. Anything both declared not examined
 * was examined by neither, so a closing block's pass stands only if that block lists it as examined
 * (the same words, ignoring case and surrounding space); otherwise it is unknown. This compares
 * declarations only: two partial reviews can still reach a pass together when they cover different
 * things, or when the reconciliation examined what both left out and says so.
 */
export function reconciledVerdict(sides: Record<string, ConsensusBlock | null>, reviews: (Coverage | null | undefined)[] = []): Json {
  const key = (e: string) => e.trim().toLowerCase();
  const [ra, rb] = reviews.map((c) => c?.not_examined ?? []);
  const leftOut = reviews.length === 2 ? ra.filter((e, i) => rb.some((f) => key(f) === key(e)) && ra.findIndex((g) => key(g) === key(e)) === i) : [];
  const closing = Object.fromEntries(
    Object.entries(sides).map(([l, b]): [string, Closing | null] => {
      if (!b) return [l, null];
      const coverage = coverageOf(b.coverage);
      let verdict = standingVerdict(b.verdict, coverage);
      let note = verdictNote(b.verdict, verdict);
      const unlisted = leftOut.filter((e) => !coverage?.examined?.some((x) => key(x) === key(e)));
      if (verdict === "pass" && unlisted.length) {
        verdict = "unknown";
        note = `a pass stands as unknown: both reviews declared ${unlisted.map((e) => JSON.stringify(e)).join(", ")} not examined, and this block does not list it as examined`;
      }
      const declared = b.verdict === undefined || b.verdict === null ? null : shown(b.verdict);
      return [l, { verdict: verdict ?? "not stated", declared_verdict: declared, coverage, ...(note ? { note } : {}) }];
    }),
  );
  const each = Object.values(closing).map((c) => c?.verdict ?? "not stated");
  const verdict = each.length === 2 && each[0] === each[1] ? each[0] : "unresolved";
  return {
    verdict,
    ...(verdict === "unresolved" ? { verdict_positions: Object.fromEntries(Object.entries(closing).map(([l, c]) => [l, c?.verdict ?? "not stated"])) } : {}),
    closing,
  };
}

const warningsOf = (w: string[]): Json => (w.length ? { warnings: w } : {});

/**
 * The open review a job is the reviewer of, if any. While a review is open its reviewer (which is
 * also the other side of its reconciliation) is reached only through the review: resuming it, or
 * holding another discussion with it, would put words into its session ahead of the blind review
 * or the reconciliation, and could bring out its result before the caller has handed in its own.
 */
export function openReviewOf(n: NodeRow): NodeRow | null {
  if (n.kind !== "job") return null;
  const rid = sessionParams(n).review_id;
  const r = rid ? getNode(rid) : undefined;
  return r && r.kind === "review" && r.status === "open" ? r : null;
}
export const reviewOnly = (n: NodeRow, r: NodeRow, verb: string): string =>
  `${n.id} is the reviewer of review ${r.id}, which is still open, and until it ends the reviewer is reached only through the review: call review with review_id "${r.id}" (and discuss on its reconciliation). You can ${verb} it once the review has ended.`;

export interface ReviewArgs {
  target?: string; plan?: string; focus?: string; reviewer?: Target; model?: string; effort?: string; cwd?: string;
  /** The reviewer's speed: for the job a review starts, or, given when continuing one, from the reconciliation's first turn (caller.ts admitSpeed; ReviewParams.reviewer_speed). */
  speed?: Speed;
  review_id?: string; own_review?: string; skip_own?: boolean;
  /** Names a call that starts a review (see calls.ts). Not used when continuing one. */
  request_id?: string;
}
/** The reviewer's side label. In an older row it is the reviewer job's target. */
const reviewerSide = (p: ReviewParams): string => p.other ?? getNode(p.reviewer)?.target ?? CALLER_LABEL;
const reviewDir = (r: NodeRow) => path.join(runDir(r.run_id), "reviews", r.id);
const readSide = (file: string): Partial<SideReview> | null => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SideReview>) : null);
const readItems = (file: string): ReviewItem[] => readSide(file)?.items ?? [];
/** What the result says of one side's review: the verdict that stands, the one declared, the declared coverage. */
const sideSummary = (r: Partial<SideReview> | null) =>
  r ? { verdict: r.verdict ?? "not stated", declared_verdict: r.declared ?? null, coverage: r.coverage ?? null, items: r.items?.length ?? 0, ...(r.note ? { note: r.note } : {}) } : null;
/**
 * Writes one side's review to its files, with the secrets relay knows the shape of cut out
 * (core/storage.ts keepRecord): they are records a person reads, and what the reconciliation and
 * the consensus are built from. A file that cannot be written (a full disk, say) throws what to do
 * about it, with `consequence`, what the caller can do then; neither file is left, so that a later
 * call does not find half a review.
 */
function writeSide(dir: string, label: string, subject: string, text: string, consequence: string): SideReview {
  const parsed = parseReview(label, text);
  const renumbered = renumberedNote(parsed);
  const md = path.join(dir, `${label}.md`);
  const json = path.join(dir, `${label}.json`);
  const o = { consequence: `the ${label} review was not saved; ${consequence}` };
  const problem = keepRecord(md, `# ${label} review of ${subject}\n\nItem ids: ${sidePrefix(label)}<n>, where n is the item number below.${renumbered ? ` ${renumbered}` : ""}\n\n${text.trim()}\n`, o)
    ?? keepRecord(json, JSON.stringify(parsed, null, 2), o);
  if (problem) {
    for (const f of [md, json]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // Left: a review without its .json is read as having no items.
      }
    }
    throw new Error(problem);
  }
  return parsed;
}

/**
 * A plan given as one line naming a file is that file, which the reviewer reads (relay does not);
 * anything else is the plan's text. One word that names no file is refused rather than reviewed as text.
 * For a launched agent (`confined`) only a file inside its own directory counts, and relay does not
 * look outside it at all, so that the reply cannot tell it whether a file elsewhere exists.
 */
function planSubject(plan: string, cwd: string, confined: boolean): ReviewSubject | { error: string } {
  const v = plan.trim();
  if (!v) return { error: "plan is empty: give the path of the plan's file, or its full text" };
  if (!v.includes("\n")) {
    const file = path.resolve(cwd, expandHome(v));
    if ((!confined || inside(file, cwd)) && fs.existsSync(file) && fs.statSync(file).isFile()) return { kind: "plan", path: file };
    if (!/\s/.test(v)) return { error: `plan "${v}" is not a file in ${cwd}. Give the path of the plan's file, or the plan's full text.` };
  }
  return { kind: "plan", text: v };
}

function ownReviewNote(p: ReviewParams, reviewId: string): string {
  const kind = p.plan ? "plan" : "code";
  const job = getNode(p.reviewer);
  const working = job && busy(job);
  return (
    (working ? "The other reviewer is still working. " : "The other reviewer has settled; hand in your own review to continue. ") +
    (p.submission_tried ? "Your review is accepted only once the reviewer settles. A submission call still waiting will be accepted then; one that returned pending was not, so resend it after the reviewer settles. " : "") +
    `Review the same ${kind === "plan" ? "plan" : "target"} yourself or with your own subagents, without reading theirs: ` +
    "relay keeps it out of its replies until yours is saved (or you skip it); do not open the reviewer's log or files before then. Relay accepts yours only after the reviewer settles. " +
    "Relay defers its review files and redacts own_review arguments in identified relay review tool calls from logs and structured reply echoes. Host transcripts, drafts and free-form echoes can still expose your review: withholding is a safeguard for normal use, not a guarantee of independence. " +
    (kind === "plan" ? `The plan (${p.plan}) is work not yet done: judge whether it would work and is the right plan, without expecting the code it proposes to exist. ` : "") +
    "Give numbered items, each with severity (blocker, major, minor or nit), confidence (high, medium or low), file and lines ([start, end]) where it has them, location, summary, evidence and fix; " +
    `then your verdict (pass, fail or unknown) and your coverage: what you examined, what you did not, and complete: true only if you examined everything. ${PASS_RULE} ` +
    `End with them as one fenced JSON block: ${reviewJsonShape(kind)}. ` +
    `Then call review with review_id "${reviewId}" and own_review set to your review's full text. If you have no review of your own to give, pass skip_own: true.` + ownReviewFamilyNote(familiesOf(getNode(reviewId)!))
  );
}

/**
 * The reviewer's speed where it is not standard (views.ts speedView), with the one a call has kept
 * for the reconciliation's first turn (reviewer_speed) as `next` until the reconciliation opens.
 */
function reviewerSpeed(p: ReviewParams, job: NodeRow | undefined): Json | null {
  const seen = job ? speedView(job) : null;
  const kept = p.discussion ? undefined : p.reviewer_speed;
  const now_ = (seen?.requested as Speed | undefined) ?? (job ? speedOf(job) : "standard");
  return kept && kept !== now_ ? { ...(seen ?? { requested: now_ }), next: kept } : seen;
}

export function reviewView(id: string): Json {
  // Like discussion settlement, this is safe on repeated reads. A safety stop needs no
  // reconciliation turn. An own_review still in a caller's pending call may be accepted later.
  tx(() => {
    const r = getNode(id)!;
    const p = reviewParams(r);
    if (r.status === "open" && (!p.discussion || p.discussion === "opening")) {
      const job = getNode(p.reviewer);
      if (job?.status === "refused") endRefusedReview(r, p, JSON.parse(job.result_json ?? "{}") as Json);
    }
  });
  const r = getNode(id)!;
  const p = reviewParams(r);
  const speed = reviewerSpeed(p, getNode(p.reviewer));
  const phase = r.status !== "open" ? "finished" : !p.own ? "waiting for your own review" : !p.discussion ? "ready to reconcile: call review with this review_id" : "reconciling";
  return {
    review_id: id, ...runRecovery(r.run_id), status: r.status, phase, reviewer: reviewerSide(p), reviewer_job: p.reviewer, ...(speed ? { speed } : {}), ...(p.plan ? { plan: p.plan } : {}),
    ...(r.target && !targetDef(r.target).qualified ? { target_label: targetLabel(targetDef(r.target)) } : {}),
    ...(p.discussion && p.discussion !== "opening" ? { discussion_id: p.discussion } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.result_json ? (JSON.parse(r.result_json) as Json) : {}),
    families: familiesOf(r, "review"),
    ...notesView(r),
    ...(r.status === "open" && !p.own ? { next: ownReviewNote(p, id) } : {}),
    ...(r.status === "refused" && !p.own ? { next: `You may still submit own_review or skip_own with review_id "${id}"; it will be recorded without restarting the reviewer.` } : {}),
  };
}

function endReview(id: string, result: Json, error?: string): void {
  const r = getNode(id)!;
  const families = familiesOf(r, "review");
  // Relay owns the header and metadata; raw agent text stays as written. A file that cannot be
  // annotated (a full disk, a directory that is not writable) does not keep the review from ending:
  // its result, which says the families too, names the file.
  const dir = reviewDir(r);
  const unkept: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /\.(md|json)$/.test(f) && f !== "plan.md");
  } catch (err) {
    unkept.push(readProblem(dir, err, "its files do not say which families took part, though the review's result does"));
  }
  const consequence = "that file does not say which families took part, though the review's result does";
  for (const file of names) {
    const at = path.join(dir, file);
    let problem: string | null;
    try {
      problem = file.endsWith(".md") ? keepRecord(at, `\n(relay) Families: ${families.summary}\n`, { append: true, consequence })
        : keepRecord(at, JSON.stringify({ ...JSON.parse(fs.readFileSync(at, "utf8")), families }, null, 2), { consequence });
    } catch (err) {
      // keepRecord says what it could not write; what throws here is the read of the side's .json.
      problem = readProblem(at, err, consequence);
    }
    if (problem) unkept.push(problem);
  }
  const warnings = [...((result.warnings as string[] | undefined) ?? []), ...unkept];
  result = { ...result, families, ...warningsOf(warnings) };
  updateNode(id, { result_json: JSON.stringify(result), error: error ?? null, ended_at: now() });
  db().prepare("UPDATE nodes SET status = ? WHERE id = ? AND status IN ('open', 'refused')").run(result.outcome === "refused" ? "refused" : error ? "failed" : "done", id);
}

/** Keeps even an empty submitted review; a refusal never supplies an independent verdict. */
function endRefusedReview(r: NodeRow, p: ReviewParams, result: Json): void {
  const other = reviewerSide(p);
  const own = readSide(path.join(reviewDir(r), `${p.caller}.json`));
  const paths = Object.fromEntries(inSideOrder([p.caller, other]).filter((l) => fs.existsSync(path.join(reviewDir(r), `${l}.md`))).map((l) => [l, path.join(reviewDir(r), `${l}.md`)]));
  const fresh = reviewParams(getNode(r.id)!);
  if (fresh.discussion === "opening") {
    delete fresh.discussion;
    updateNode(r.id, { params_json: JSON.stringify(fresh) });
  }
  endReview(r.id, {
    outcome: "refused", refusal: result.refusal, unfinished: true, verdict: "unknown",
    verdict_note: `no independent review was obtained: the ${other} turn was stopped by its vendor's safety system`,
    sides: own ? { [p.caller]: sideSummary(own) } : {},
    consensus: (own?.items ?? []).map((i) => ({ ...i, id: undefined, ids: [i.id], raised_by: [p.caller], status: "unresolved" })),
    reviews: paths, reviewer_job: p.reviewer, ...(p.plan ? { plan: p.plan } : {}),
    note: `The ${other} family produced no completed review. ${result.refusal ? refusalNote(result.refusal as unknown as VendorRefusal) : REFUSAL_POLICY}${own ? " Your own review is preserved and stands alone." : ""}`,
    ...(result.warnings ? { warnings: result.warnings } : {}),
  }, r.error ?? getNode(p.reviewer)?.error ?? undefined);
}

/** Builds the consensus list once the reconciliation has ended, however it ended. */
export function finishReview(reviewId: string, discussionId: string): void {
  const r = getNode(reviewId);
  if (!r || r.status !== "open") return;
  const p = reviewParams(r);
  // Only the review's own reconciliation ends it. (It may close before its id is recorded.)
  if (p.discussion && p.discussion !== "opening" && p.discussion !== discussionId) return;
  const d = getNode(discussionId)!;
  const dp = discussionParams(d);
  const res = JSON.parse(d.result_json ?? "{}") as Json;
  const dir = reviewDir(r);
  // Each side's files and final list, in registry order whoever called.
  const labels = inSideOrder([p.caller, reviewerSide(p)]);
  const reviews = Object.fromEntries(labels.map((l) => [l, readSide(path.join(dir, `${l}.json`))]));
  const items = labels.flatMap((l) => reviews[l]?.items ?? []);
  // Both sides' closing blocks, however it ended: the one that closed it never settles the list or the verdict alone.
  const sides = Object.fromEntries(inSideOrder([dp.caller, otherSide(dp)]).map((l) => [l, parseConsensus(dp.state.last[l] ?? null)]));
  const entries = Object.fromEntries(Object.entries(sides).map(([l, b]) => [l, b?.consensus ?? null]));
  endReview(reviewId, {
    outcome: res.outcome, ...(res.refusal ? { refusal: res.refusal, note: res.note, unfinished: true } : {}), ...reconciledVerdict(sides, labels.map((l) => reviews[l]?.coverage)), consensus: buildConsensus(items, entries), cruxes: res.cruxes ?? null, conclusion: res.conclusion,
    sides: Object.fromEntries(labels.map((l) => [l, sideSummary(reviews[l])])), ...(p.plan ? { plan: p.plan } : {}),
    reviews: Object.fromEntries(labels.filter((l) => fs.existsSync(path.join(dir, `${l}.md`))).map((l) => [l, path.join(dir, `${l}.md`)])),
    transcript_path: d.transcript_path, discussion_id: discussionId, reviewer_job: p.reviewer,
    ...warningsOf([...(p.reviewer_warnings ?? []), ...((res.warnings as string[] | undefined) ?? [])]),
  }, res.outcome === "error" || res.outcome === "refused" ? String(res.error) : undefined);
}

/** Starts a review or carries one on. ops.ts review, the tool, answers a repeated request_id first. */
export async function review(inst: Instance, a: ReviewArgs, w: ToolCall = {}): Promise<Json> {
  if (!a.review_id) {
    if (a.target && a.plan !== undefined) return { error: "give either target (code to review) or plan (a plan to review), not both" };
    if (!a.target && a.plan === undefined) return { error: "say what to review: target (a path, a diff range, a branch), or plan (the path of a plan's file, or its text)" };
    const admitted = admitNew(inst, { target: a.reviewer, model: a.model, cwd: a.cwd });
    if ("reason" in admitted) return refused(admitted.reason);
    const { caller, to } = admitted;
    // The reviewer's session goes on to reconcile the two reviews in a discussion. A review takes no grant.
    const work = admitWork(caller, to.target, { mode: "read", continues: true }, w);
    if ("reason" in work) return refused(work.reason);
    const sp = admitSpeed(caller, to.target, { speed: a.speed, model: to.model ?? a.model }, w);
    if ("reason" in sp) return refused(sp.reason);
    const subject = a.plan !== undefined ? planSubject(a.plan, caller.cwd, caller.node !== null) : ({ kind: "code", target: a.target! } as const);
    if ("error" in subject) return subject;
    const label = subject.kind === "code" ? subject.target : "path" in subject ? `the plan in ${subject.path}` : "the plan given as text";
    // The review's directory, and a plan given as text, are written before the review is made: one
    // that cannot be written (a full disk, a directory that is not writable) leaves no review open
    // with nothing to run it, only the reason. The reviewer is given the plan's text itself; its
    // copy in plan.md has the secrets relay knows the shape of cut out (core/storage.ts keepRecord).
    const id = newId("review");
    const dir = path.join(runDir(caller.runId), "reviews", id);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { error: writeProblem(dir, err, "no review was started") };
    }
    const plan = subject.kind === "code" ? undefined : "path" in subject ? subject.path : path.join(dir, "plan.md");
    const unkept = subject.kind === "plan" && "text" in subject ? keepRecord(plan!, `${subject.text}\n`, { consequence: "no review was started" }) : null;
    if (unkept) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { error: unkept };
    }
    const { r, job } = tx(() => {
      const r = insertNode({
        id, run_id: caller.runId, parent_id: caller.node?.id ?? null, kind: "review", target: to.target, mode: "read",
        depth: caller.depth + 1, allow_delegation: 0, task: `review: ${label}`, cwd: caller.cwd, status: "open",
      });
      const job = insertNode({
        id: newId("job"), run_id: caller.runId, parent_id: r.id, kind: "job", target: to.target, mode: "read", depth: caller.depth + 1,
        allow_delegation: 0, task: `independent review: ${label}`, cwd: caller.cwd, model: to.model ?? a.model ?? null, effort: a.effort ?? null,
        params_json: JSON.stringify({ review_id: r.id, speed: sp.speed }),
      });
      insertTurn(job.id, `review:${r.id}`, reviewerPrompt(subject, a.focus), "read");
      // A contradicted registration still identifies a candidate transcript home, even though
      // it cannot establish routing identity. With no registration, protect both known stores.
      const family = familyOf(inst) ?? inst.registration?.host;
      const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
      const transcriptHomes = family === "codex" ? [codexHome] : family === "claude" ? [claudeHome] : [codexHome, claudeHome];
      const callerTranscripts = [...new Set([
        ...transcriptHomes.map((home) => path.resolve(expandHome(home))),
        ...(caller.node ? [path.join(harnessHome(), caller.runId, caller.node.id), nodeDir(caller.runId, caller.node.id)] : []),
      ])];
      const p: ReviewParams = { target: label, focus: a.focus ?? null, caller: callerSide(inst, to.target), other: to.target, reviewer: job.id, caller_transcripts: callerTranscripts, own: false, ...(plan ? { plan } : {}) };
      updateNode(r.id, { params_json: JSON.stringify(p), started_at: now() });
      const cfg = runConfig(r.run_id);
      recordStart(r.id, inst, w, to.target, job.model, cfg);
      recordStart(job.id, inst, w, to.target, job.model, cfg);
      // Recorded once the review is complete enough to be answered from.
      noteCall(inst, a, r.id);
      return { r, job };
    });
    const warning = dispatch(job.id);
    return { ...reviewView(r.id), ...(warning ? { warning } : {}) };
  }

  const r = getNode(a.review_id);
  if (!r || r.kind !== "review") return { error: `${a.review_id} is not a review` };
  if (legacyTwoSided(r)) return legacyRefusal(r);
  const caller = admitExisting(inst, r, "continue", a.cwd);
  if ("reason" in caller) return refused(caller.reason);
  const unknown = knownCaller(inst);
  if (unknown) return refused(unknown);
  const p = reviewParams(r);
  const submitting = !!a.own_review || !!a.skip_own;
  const unused = { submission_note: "A submission was already saved or skipped for this review; this call's text was not used." };
  const notSaved = () => ({ ...reviewView(r.id), ...(submitting && reviewParams(getNode(r.id)!).own ? unused : {}) });
  const acceptsOwn = (n: NodeRow) => n.status === "open" || n.status === "refused" && !reviewParams(n).own && !reviewParams(n).discussion;
  if (!acceptsOwn(r)) return notSaved();
  // A speed given here is the reviewer's from its next turn: the reconciliation's first, which this
  // call or a later one opens. It is kept with the review until then (reviewer_speed) and set on the
  // reviewer only as that turn is queued (discuss), so the reviewer's own turn, still running perhaps,
  // keeps its speed. Asked whether or not the call names one: a launched agent may not carry on a
  // reviewer faster than itself.
  const reviewer = getNode(p.reviewer);
  let unapplied: string | undefined;
  if (reviewer?.target) {
    // Until the reconciliation opens, the reviewer goes on at the speed kept for it; from then on, at its own (discuss changes it).
    const current = (!p.discussion && p.reviewer_speed) || speedAfter(reviewer);
    const sp = admitSpeed(caller, reviewer.target, { speed: a.speed, current, model: reviewer.model }, w);
    if ("reason" in sp) return refused(sp.reason);
    if (a.speed && p.discussion) {
      unapplied = `The reconciliation is already open, so this call changed no speed: pass speed to discuss${p.discussion === "opening" ? "" : ` with discussion_id "${p.discussion}"`}, from the turn that call queues.`;
    } else if (a.speed && sp.speed !== p.reviewer_speed) {
      p.reviewer_speed = sp.speed;
      updateNode(r.id, { params_json: JSON.stringify({ ...reviewParams(getNode(r.id)!), reviewer_speed: sp.speed }) });
    }
  }
  const other = reviewerSide(p);
  if (!p.own && !a.own_review && !a.skip_own) return reviewView(r.id);
  if (p.discussion) return unapplied ? { ...notSaved(), speed_note: unapplied } : notSaved();
  if (submitting && !p.own) tx(() => {
    const row = getNode(r.id)!, q = reviewParams(row);
    if (row.status === "open" && !q.own && !q.submission_tried) updateNode(r.id, { params_json: JSON.stringify({ ...q, submission_tried: true }) });
  });

  // Do not accept the submission until the reviewer settles. In particular, own stays false:
  // a timed-out call, a different connection or a restarted server must still withhold everything.
  // Use the status wait machinery, including progress, cancellation, slot lending and host cap.
  const done = await waitUntil(() => {
    const row = getNode(r.id);
    return !row || row.status !== "open" || !!reviewParams(row).discussion || settled(p.reviewer);
  }, waitOpts(inst, r.run_id, w, { progressOf: p.reviewer, awaits: [r.id] }));
  const fresh = getNode(r.id)!;
  if (!acceptsOwn(fresh) || reviewParams(fresh).discussion) return notSaved();
  if (!done || w.signal?.aborted) {
    const again = p.own ? "" : a.own_review ? " and own_review" : " and skip_own: true";
    return { ...pendingHandle(r.id, { review_id: r.id }, inst), next: `The ${other} reviewer is still working; call status with id "${p.reviewer}" and wait_s until it settles, then call review with review_id "${r.id}"${again} again.${!p.own ? " Relay has not accepted or stored your review." : ""}` };
  }
  // A launched caller's turn or authority may have ended while this call waited.
  const stillAllowed = admitExisting(inst, fresh, "continue", a.cwd);
  if ("reason" in stillAllowed) return refused(stillAllowed.reason);
  // Save the caller's review and claim reconciliation together. Concurrent waiters keep the
  // first saved submission and only one opens the discussion; no process-local state survives.
  const claimed = tx(() => {
    const fresh = getNode(r.id)!;
    const q = reviewParams(fresh);
    if (!acceptsOwn(fresh) || q.discussion || !settled(q.reviewer)) return false;
    const alreadyAccepted = q.own;
    let saved = q;
    if (!alreadyAccepted) {
      // The caller's family is recorded only for the submission relay accepts, in the same transaction.
      const contribution = callerLabel(inst, w);
      addContribution(r.id, contribution);
      addContribution(q.reviewer, contribution);
      saved = reviewParams(getNode(r.id)!);
      if (a.own_review) writeSide(reviewDir(r), saved.caller, saved.target, a.own_review, "nothing else was changed, and the call can be made again");
      saved.own = true;
      saved.skipped = !a.own_review;
    }
    updateNode(r.id, { params_json: JSON.stringify({ ...saved, discussion: "opening" }) });
    return { params: saved, alreadyAccepted };
  });
  if (!claimed) return notSaved();
  const submissionNote = submitting && claimed.alreadyAccepted ? unused : {};
  try {
    return { ...await reconcileReview(inst, r, claimed.params, w), ...submissionNote };
  } catch (e) {
    // Whatever went wrong, the claim is let go, so that the review is not left opening for ever and can be tried again.
    const q = reviewParams(getNode(r.id)!);
    if (q.discussion === "opening") {
      delete q.discussion;
      updateNode(r.id, { params_json: JSON.stringify(q) });
    }
    throw e;
  }
}

/** Once the reviewer has finished and this call holds the claim: ends the review unreconciled, or opens the reconciliation. */
async function reconcileReview(inst: Instance, r: NodeRow, p: ReviewParams, w: ToolCall): Promise<Json> {
  const dir = reviewDir(r);
  const other = reviewerSide(p);
  const job = getNode(p.reviewer)!;
  const text = nodeTurns(job.id)[0]?.reply ?? "";
  const own = readItems(path.join(dir, `${p.caller}.json`));
  const unresolved = (items: ReviewItem[], by: string) => items.map((i) => ({ ids: [i.id], raised_by: [by], status: "unresolved", ...i, id: undefined }));
  const paths = () => Object.fromEntries(inSideOrder([p.caller, other]).filter((l) => fs.existsSync(path.join(dir, `${l}.md`))).map((l) => [l, path.join(dir, `${l}.md`)]));
  const jobResult = JSON.parse(job.result_json ?? "{}") as { warnings?: string[]; blocked?: string[] };
  if (job.status === "refused" || r.status === "refused") {
    endRefusedReview(r, p, r.status === "refused" ? JSON.parse(r.result_json ?? "{}") as Json : JSON.parse(job.result_json ?? "{}") as Json);
    return reviewView(r.id);
  }
  const jobWarnings = [...(jobResult.warnings ?? []), ...(jobResult.blocked?.length ? [`was refused ${jobResult.blocked.join("; ")}`] : [])].map((w) => `${other} reviewer: ${w}`);
  // Unreconciled, the verdict is the one review's own.
  const alone = (label: string, s: Partial<SideReview> | null) => ({ verdict: s?.verdict ?? "not stated", sides: { [label]: sideSummary(s) }, ...(p.plan ? { plan: p.plan } : {}) });
  // A reviewer that was refused something still wrote its review.
  if ((job.status !== "done" && job.status !== "blocked") || !text) {
    const why = job.error ?? `the ${other} reviewer ended as ${job.status}`;
    // Without an independent review there is no verdict to give: the caller's own is kept under sides, never as the review's.
    // The review fails unless the caller's own raised something, as before verdicts existed.
    const ownReview = readSide(path.join(dir, `${p.caller}.json`));
    endReview(r.id, {
      outcome: own.length ? "partial" : "error", ...alone(p.caller, ownReview), verdict: "unknown", verdict_note: `no independent review was obtained: the ${other} reviewer failed`,
      reviews: paths(), errors: { [other]: why }, consensus: unresolved(own, p.caller), reviewer_job: job.id,
      note: `The ${other} reviewer failed, so nothing was reconciled.${own.length ? " Your own review stands alone." : ""}`, ...(jobWarnings.length ? { warnings: jobWarnings } : {}),
    }, own.length ? undefined : why);
    return reviewView(r.id);
  }
  const theirReview = writeSide(dir, other, p.target, text, `your ${p.skipped ? "choice to skip your own review" : "own review"} was saved, so make the call again with review_id alone once it can be written`);
  const theirs = theirReview.items;
  if (p.skipped) {
    endReview(r.id, {
      outcome: "partial", ...alone(other, theirReview), reviews: paths(), consensus: unresolved(theirs, other), reviewer_job: job.id,
      note: "You gave no review of your own, so nothing was reconciled. This is the other reviewer's list as it stands.", ...(jobWarnings.length ? { warnings: jobWarnings } : {}),
    });
    return reviewView(r.id);
  }

  // Kept with the review: the reconciliation's turns run on the reviewer's session and replace its job's result.
  if (jobWarnings.length) updateNode(r.id, { params_json: JSON.stringify({ ...reviewParams(getNode(r.id)!), reviewer_warnings: jobWarnings }) });
  const mine = fs.readFileSync(path.join(dir, `${p.caller}.md`), "utf8");
  // Where relay gave items ids of their own, each side is told: the reviewer of its own here, and of the caller's in that file's header.
  const theirIds = renumberedNote(theirReview);
  const opening =
    `Your own review is the one you wrote earlier in this session; its items are ${sidePrefix(other)}1, ${sidePrefix(other)}2, … in the order you numbered them.${theirIds ? ` ${theirIds}` : ""}\n` +
    `Mine follows; its items are ${sidePrefix(p.caller)}<n>.\n\n----- ${p.caller} review -----\n${mine.trim()}\n----- end of ${p.caller} review -----\n\n` +
    "Go through both lists: say which items you hold to be real and at what severity, which you would drop and why, which are the same finding under two ids, and what verdict and coverage the two reviews reach between them.\nCONTINUE";
  const rules = reviewDiscussionRules([p.caller, other]);
  // At the speed a call carrying on the review gave for the reviewer, if one did; else the reviewer goes on at its own.
  const speed = reviewParams(getNode(r.id)!).reviewer_speed;
  const out = await discuss(inst, { topic: `Reconcile two independent reviews of ${p.target} into one consensus list.`, message: opening, with: job.id, role: "peer", ...(speed ? { speed } : {}) }, w, { extraRules: rules, reviewId: r.id, caller: p.caller });
  if (typeof out.discussion_id !== "string") {
    const q = reviewParams(getNode(r.id)!);
    delete q.discussion;
    updateNode(r.id, { params_json: JSON.stringify(q) });
    return { review_id: r.id, ...out, families: familiesOf(getNode(r.id)!, "review") };
  }
  const now_ = reviewParams(getNode(r.id)!);
  now_.discussion = out.discussion_id;
  updateNode(r.id, { params_json: JSON.stringify(now_) });
  // The reconciliation can end on its opening turn (the reviewer refused by its vendor, or failed):
  // the review has then settled, so the caller gets its result, not an invitation to carry on.
  if (getNode(r.id)!.status !== "open") return { ...reviewView(r.id), ...(jobWarnings.length ? { reviewer_warnings: jobWarnings } : {}) };
  const idsNote = ([[`your review`, readSide(path.join(dir, `${p.caller}.json`))], [`the ${other} review`, theirReview]] as const)
    .filter(([, s]) => s?.renumbered?.length).map(([whose, s]) => `${whose}: ${s!.renumbered!.join(", ")}`);
  return {
    review_id: r.id, phase: "reconciling", their_review: path.join(dir, `${other}.md`), their_items: theirs.length, your_items: own.length,
    ...(idsNote.length ? { ids_note: `Relay gave its own ids to items whose n was missing, not a positive whole number, or used before. In ${idsNote.join("; in ")}.` } : {}), ...out,
    families: familiesOf(getNode(r.id)!, "review"), rules,
    next: `Their review is at their_review; their first reconciliation message is in reply. Carry on with discuss (discussion_id "${out.discussion_id}") until you both write AGREE, each AGREE message carrying the consensus JSON block the rules describe. Then result with id "${r.id}" gives the consensus list.`,
    ...(jobWarnings.length ? { reviewer_warnings: jobWarnings } : {}),
  };
}
