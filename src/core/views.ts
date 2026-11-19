import { escalationAccounting } from "./escalations.js";
// Views: what relay shows of an item in status, result and relay tree, and the approval note and
// pending handle that come with them. A reviewer's result is withheld until the caller hands in
// its own, and so is anything that would show it (its log, what it is doing, what it was refused).
import fs from "node:fs";
import { familiesOf } from "./families.js";
import path from "node:path";
import type { Usage } from "../backends/types.js";
import { elicitationState, pendingRequests, requestView } from "./approvals.js";
import type { Instance, Json } from "./caller.js";
import { harnessHome } from "./config.js";
import { ACTIVE, getNode, getRun, nodeTurns, now, reap, runNodes, speedAfter, turnReports, workCwd, type NodeRow, type TurnRow } from "./db.js";
import { liveness } from "./liveness.js";
import { outcomeView, removedBranch, resultNow } from "./outcome.js";
import { discussionParams, reviewParams, sessionParams, speedOf } from "./params.js";
import { extensionsSummary, extensionsView, PERSON_ROUTES } from "./extensions.js";
import { clipped, oneLine } from "./shown.js";
import { targetDef, targetLabel } from "../targets/index.js";
import { REPORTED_COMPLETION } from "./reported.js";

/**
 * One line on how an item is getting on, for progress notifications: its status, how long it has
 * run, which turn, what its agent last started (command, tool or file) and when, and any approval
 * request it is waiting on. Never the agent's own words, and not what a reviewer whose result is
 * withheld is doing, which status leaves out too (review C19).
 */
export function progressLine(nodeId: string): string {
  const n = getNode(nodeId);
  if (!n) return `relay: ${nodeId} is not in the registry`;
  const turns = nodeTurns(n.id);
  const cur = turns.find((t) => t.status === "running") ?? turns.find((t) => t.status === "queued") ?? turns.at(-1);
  const secs = (ms: number) => (ms >= 3600_000 ? `${Math.floor(ms / 3600_000)}h${Math.floor((ms % 3600_000) / 60_000)}m` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s` : `${Math.round(ms / 1000)}s`);
  const parts = [`relay: ${n.id} ${n.status}`, secs(now() - (n.started_at ?? n.created_at))];
  if (cur) parts.push(`turn ${turns.indexOf(cur) + 1}${turns.length > 1 ? ` of ${turns.length}` : ""}`);
  const asking = pendingRequests(n.run_id).find((r) => r.node_id === n.id);
  const tokens = usageOf(n.id, turns)?.total_tokens;
  if (typeof tokens === "number") parts.push(`${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`);
  if (asking) parts.push(`waiting for approval ${asking.id}: ${clipped(asking.summary, 80)}`);
  else if (cur?.status === "running" && cur.activity && !withheld(n)) parts.push(`now: ${oneLine(cur.activity, 100)} (${secs(now() - (cur.activity_at ?? now()))} ago)`);
  return parts.join(" · ");
}

/** What the pending requests want, by what allowing them would actually do (their effect), and how to decide. */
function approvalNote(effects: unknown[]): string {
  const distinct = [...new Set(effects.filter((e): e is string => typeof e === "string"))];
  const what = distinct.length === 1
    ? `${effects.length === 1 ? "A launched agent is" : "Launched agents are"} waiting for approval: allowing ${effects.length === 1 ? "it" : "each"} ${distinct[0]}.`
    : "Launched agents are waiting for approval; each request's effect says what allowing it would do.";
  return `${what} Decide with the approve tool: allow what the user has clearly authorized for this task, deny what they would not want, and ask the user when unsure. The agent stays blocked until then.`;
}

const CONFIRM_NOTE =
  " To allow something the user has not clearly authorized, call confirm with the request's request_id, from, kind, effect, in_directory and wants exactly as shown: your host then asks the user before the call goes ahead, so the decision is theirs.";

const PERSON_ONLY_NOTE =
  ` A request marked person_only (consent to extensions, a call of an MCP server's tool, or any request of a session holding MCP servers) can be allowed only by the user, ${PERSON_ROUTES}; relay takes it from no command, relay approve included. approve can only deny it.`;

const FORM_STAYS_NOTE =
  " Your host keeps relay's form on the user's screen, and holds your turn, until they answer it or press Esc, even after the request is decided elsewhere (by you or from a terminal); if you decide one they are being asked about, tell them to press Esc. An answer given after the decision changes nothing, and relay tells you if one comes.";

export function approvalsFor(runId: string, inst?: Instance): Json {
  const open = pendingRequests(runId);
  if (!open.length) return {};
  const views = open.map((r) => {
    const state = elicitationState(r.id);
    return {
      ...requestView(r),
      ...(state === "asking" ? { user_is_being_asked: true } : state === "dismissed" ? { user_dismissed_prompt: true } : state ? { host_answered_prompt: state.unattributed } : {}),
    };
  });
  const isPersonal = (v: object) => (v as { person_only?: unknown }).person_only === true;
  const asked = views.filter((v) => "user_is_being_asked" in v || "user_dismissed_prompt" in v);
  // A person-only request is never allowed with user_confirmed (approve refuses it), so the advice to do so is only for the others.
  const direct = asked.some((v) => !isPersonal(v));
  const directPersonal = asked.some(isPersonal);
  const personal = views.some(isPersonal);
  const unattributed = views.some((v) => "host_answered_prompt" in v);
  const confirmable = Boolean(inst?.host.confirmTool);
  return {
    needs_approval: views,
    approval_note: approvalNote(views.map((v) => (v as { effect?: unknown }).effect)) + (confirmable ? CONFIRM_NOTE : "") + (personal ? PERSON_ONLY_NOTE : "") +
      (direct
        ? ` For a request marked user_is_being_asked (the question is on their screen now) or user_dismissed_prompt (they closed it without answering)${directPersonal ? " and not person_only" : ""}, do not allow it on your own judgment: wait, or ask them in conversation, and allow only with user_confirmed once they say so` +
          (confirmable ? ", or use confirm, which puts it to them in a permission prompt" : "") + ". You may still deny."
        : "") +
      (directPersonal
        ? ` For a person_only request marked user_is_being_asked or user_dismissed_prompt, user_confirmed allows nothing: wait for the user's answer to relay's question${confirmable ? ", or use confirm, which puts it to them in a permission prompt" : ""}. You may still deny.`
        : "") +
      (asked.length && inst?.host.formStays ? FORM_STAYS_NOTE : "") +
      (unattributed
        ? " A request marked host_answered_prompt was put to the user, but the host answered it in a way that decides nothing and that relay cannot attribute to them (for example Codex, which declines on its own when its approval policy is never): decide it as any other, and ask the user when unsure, mindful that a decline may have been theirs."
        : "") +
      // Why the user is not asked directly, or confirm is not offered, so that the agent can tell them.
      (inst?.host.noElicit ? ` relay is not putting requests to the user directly in this session: ${inst.host.noElicit}.` : "") +
      (inst?.host.confirmWithheld ? ` confirm is not offered in this session: ${inst.host.confirmWithheld}.` : ""),
  };
}

export const pendingHandle = (id: string, extra: Json = {}, inst?: Instance): Json => {
  const n = getNode(id);
  const runId = n?.run_id;
  return {
    pending: true,
    id,
    ...extra,
    ...(n ? { families: familiesOf(n) } : {}),
    ...(n ? notesView(n) : {}),
    ...(n?.target && !targetDef(n.target).qualified ? { target_label: targetLabel(targetDef(n.target)) } : {}),
    ...(runId ? { ...runRecovery(runId), ...approvalsFor(runId, inst) } : {}),
    note: `Still running. Call status with id "${id}" and wait_s to wait for it; the work continues in the meantime.`,
  };
};

/**
 * Only render after item access is checked. Saved replies can describe a later recovery prompt.
 * `itemCount`: the number of the run's items, where the caller has just read them all.
 */
export function runRecovery(runId: string, itemCount?: number): Json {
  const run = getRun(runId)!;
  return { run_id: runId, adoption: { in_directory: run.root_cwd, item_count: itemCount ?? runNodes(runId).length } };
}

/**
 * A reviewer's result is kept out of relay's replies until the agent that asked for the review
 * has saved its own (or skipped it). This prevents seeing it early through normal use of the tools.
 * Host transcripts, drafts and reviewer files remain outside this safeguard.
 */
function withheld(n: NodeRow, params = sessionParams(n)): string | null {
  const rid = params.review_id;
  const r = rid && n.kind === "job" ? getNode(rid) : undefined;
  if (!r || r.status !== "open" || reviewParams(r).own) return null;
  return `This reviewer's result is withheld until you hand in your own review: call review with review_id "${r.id}" and own_review (or skip_own).`;
}

/**
 * A session's token usage across its turns, as its agent reported it. Codex reports its thread's
 * running total, so its latest report is the session's; Claude reports each turn's own, so they are added up.
 */
function usageOf(nodeId: string, turns: Pick<TurnRow, "usage_json">[] = turnReports(nodeId)): Json | null {
  const reports = turns.filter((t) => t.usage_json).map((t) => JSON.parse(t.usage_json!) as Usage);
  if (!reports.length) return null;
  const last = reports.at(-1)!;
  if (last.cumulative) {
    const { cumulative: _, ...rest } = last;
    return { ...rest, as_reported: "the session's running total, as its agent reports it" };
  }
  const sum: Record<string, number> = {};
  for (const r of reports) {
    for (const [k, v] of Object.entries(r)) if (typeof v === "number") sum[k] = (sum[k] ?? 0) + v;
  }
  if (sum.cost_usd !== undefined) sum.cost_usd = Math.round(sum.cost_usd * 1e6) / 1e6;
  return { ...sum, as_reported: `added up over ${reports.length} turn${reports.length === 1 ? "" : "s"}, as its agent reported each` };
}

/**
 * A session's speed, when it is not standard: the one requested for its turn now running or last
 * started (no harness reports the tier that actually served a turn), the one a call has since asked
 * for its queued turns (`next`, where that differs), and what its harness last reported about its
 * speed, where it reports anything (Claude's fast mode state, its reason, the speed it ran at, and
 * a notice on its stream). That report is shown only if its turn asked for the speed requested now:
 * one from a turn at another speed (the session's speed changed since, and no turn has reported at
 * the new one yet) says nothing about it.
 */
export function speedView(n: NodeRow, turns?: Pick<TurnRow, "usage_json">[]): Json | null {
  if (n.kind !== "job" && n.kind !== "thread") return null;
  const requested = speedOf(n);
  const next = speedAfter(n);
  if (requested === "standard" && next === "standard") return null;
  const last = (turns ?? turnReports(n.id)).filter((t) => t.usage_json).map((t) => JSON.parse(t.usage_json!) as Usage).filter((u) => u.speed_report).at(-1);
  return { requested, ...(next !== requested ? { next } : {}), ...(last?.speed_requested === requested ? { reported: last.speed_report } : {}) };
}

const shellQuote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;

/**
 * How to open a finished job's or thread's session in the user's own CLI, and what that means: it
 * runs under the user's own settings, not the confinement relay gave it, and in the directory it
 * worked in, which for a write job is a worktree that may have been removed since. For a target
 * that withholds it (nativeResumeWithheld), only why.
 */
function nativeResume(n: NodeRow): Json | null {
  if (!n.session_id || !n.target || (n.kind !== "job" && n.kind !== "thread")) return null;
  const def = targetDef(n.target);
  if (def.nativeResumeWithheld) return { command: null, note: def.nativeResumeWithheld };
  const dir = workCwd(n);
  const command = `cd ${shellQuote(dir)} && ${def.resumeCommand(n.session_id, { harnessState: path.join(harnessHome(), n.run_id, n.id) })}`;
  const own = `Opens the session in your own ${targetLabel(def, def.product)}, with your own settings and permissions, not the confinement relay gave it.`;
  if (!fs.existsSync(dir)) {
    const where = n.worktree
      ? ` Its worktree ${n.worktree} has been removed (after a merge or relay clean, or because the job changed nothing), so the cd fails: continue it with relay's resume, which puts the worktree back, or first run git worktree add ${shellQuote(n.worktree)} ${n.branch ?? ""} in ${n.repo ?? "the repository"}.`
      : ` Its directory ${dir} no longer exists.`;
    return { command, note: own + where, directory_exists: false };
  }
  return { command, note: own + (n.worktree ? ` It works in the job's worktree, which still exists; changes made there are on branch ${n.branch}.` : ""), directory_exists: true };
}

/** Plain launch notes also accompany the discussion or review that uses this session. */
export function notesView(n: NodeRow): Json {
  // A discussion or review row can be listed before its params are written: no notes then.
  const id = n.kind === "discussion" ? discussionParams(n)?.participant
    : n.kind === "review" ? reviewParams(n)?.reviewer : n.id;
  const session = typeof id === "string" ? getNode(id) : undefined;
  const params = session ? sessionParams(session) : undefined;
  const notes = params?.notes;
  const never = (params as { never_policy?: unknown } | undefined)?.never_policy;
  const escalations = session ? escalationAccounting(session.id) : [];
  return { ...(notes?.length ? { notes } : {}), ...(never ? { never_policy: never } : {}), ...(escalations.length ? { escalations } : {}) };
}

export function nodeView(n: NodeRow, withResult = true): Json {
  const end = n.ended_at ?? now();
  const view: Json = {
    id: n.id, kind: n.kind, target: n.target, families: familiesOf(n), mode: n.mode, depth: n.depth, status: n.status,
    parent: n.parent_id, elapsed_s: Math.round((end - (n.started_at ?? n.created_at)) / 1000), task: oneLine(n.task, 100),
    ...notesView(n),
  };
  if (n.target && !targetDef(n.target).qualified) view.target_label = targetLabel(targetDef(n.target));
  // A Codex session whose latest turn ran with raw network (stage 2): its commands were confined by
  // relay's own sandbox, not Codex's (backends/codex-stage2.ts recordEnforcement). Written only while
  // stage 2 is switched on, so other sessions' views are unchanged.
  const params = sessionParams(n);
  const enforced = params.codex_confinement;
  if (enforced?.enforcement === "relay") view.confinement = { by: "relay", turn: enforced.turn, note: "confined by relay: its commands ran in relay's own sandbox, not Codex's" };
  if (Array.isArray(view.escalations) && view.escalations.length) view.confinement = { ...(enforced?.enforcement === "relay" ? { by: "relay" } : { enforcement: "unreported" }), scope: "per-turn escalation accounting", note: "Read escalations for each turn's effective scope, launch outcome and cleanup; baseline-only confinement is not claimed." };
  const res = resultNow(n, n.result_json ? (JSON.parse(n.result_json) as Json) : null);
  const settledNow = !ACTIVE.includes(n.status);
  if (settledNow && n.status !== "open") Object.assign(view, { [REPORTED_COMPLETION]: { id: n.id, status: n.status, endedAt: n.ended_at } });
  // A job that changed nothing may have had its empty branch removed; do not advertise it.
  if (n.branch && !(settledNow && removedBranch(res))) view.branch = n.branch;
  if (n.error) view.error = n.error;
  // While a reviewer's result is withheld, so is the way to its log: someone looking into a slow
  // reviewer would follow that path without meaning to read the review. What it was refused would
  // show where it looked, so that is held back too; its status still says blocked.
  const held = withheld(n, params);
  const outcome = settledNow && !held ? outcomeView(n, res) : null;
  if (outcome) Object.assign(view, outcome);
  if (held) view.note = held;
  if (n.log_path && !held) view.log_path = n.log_path;
  if (n.transcript_path && !held) view.transcript_path = n.transcript_path;
  // What it is doing is left out while held, as its log is.
  const live = liveness(n, { activity: !held });
  if (live) view.liveness = live;
  if (withResult && settledNow && res && !held) view.result = { ...res, ...notesView(n) };
  // The session's turns, read once for its usage, its speed and what is queued.
  const turns = turnReports(n.id);
  const usage = usageOf(n.id, turns);
  if (usage && !held) view.usage = usage;
  const speed = speedView(n, turns);
  if (speed) view.speed = speed;
  if (withResult && settledNow && !held) {
    const native = nativeResume(n);
    if (native) view.resume_natively = native;
  }
  const queued = turns.filter((t) => t.status === "queued").length;
  if (queued) view.queued_messages = queued;
  // Every extension the session was given, and whether the person has consented (docs/extensions.md).
  const ext = n.kind === "job" || n.kind === "thread" ? params.extensions : undefined;
  if (ext) view.extensions = extensionsView(ext);
  return view;
}

/**
 * The run as a tree. `built`: the run's items and their views (nodeView, without results) that the
 * caller has just made from the registry after reaping the run, as status does, so that they are
 * not reaped and built a second time; otherwise the run is reaped and read here.
 */
export function renderTree(runId: string, built?: { nodes: NodeRow[]; views: Json[] }): string {
  if (!built) reap(runId);
  const nodes = built?.nodes ?? runNodes(runId);
  const views = built?.views;
  const run = getRun(runId)!;
  const lines = [`${run.id}  ${run.status}  ${run.root_cwd}`];
  const open = pendingRequests(runId);
  // Each item's children in the order runNodes gives them.
  const children = new Map<string | null, { n: NodeRow; at: number }[]>();
  nodes.forEach((n, at) => {
    const list = children.get(n.parent_id);
    if (list) list.push({ n, at });
    else children.set(n.parent_id, [{ n, at }]);
  });
  const walk = (parent: string | null, indent: string) => {
    const kids = children.get(parent) ?? [];
    kids.forEach(({ n, at }, i) => {
      const last = i === kids.length - 1;
      const v = views?.[at] ?? nodeView(n, false);
      const relation = (v.families as ReturnType<typeof familiesOf>).relation;
      const tag = relation === "cross-family" ? "" : relation === "same-family" ? " [same-family]" : " [family unknown]";
      lines.push(
        `${indent}${last ? "└─" : "├─"} ${n.id}  ${n.kind}${n.target ? `:${targetLabel(targetDef(n.target), n.target)}` : ""}${tag}  ${n.mode}  d${n.depth}  ${n.status}${v.outcome ? ` (${v.outcome})` : ""}  ${v.elapsed_s}s  ${oneLine(n.task, 60)}`,
      );
      // Every extension the session was given (docs/extensions.md): names from the person's own config.
      const ext = n.kind === "job" || n.kind === "thread" ? sessionParams(n).extensions : undefined;
      if (ext) lines.push(`${indent}${last ? "   " : "│  "}   + extensions: ${extensionsSummary(ext)}`);
      const live = v.liveness as { quiet_s: number; activity?: string; files_touched?: string[]; files_touched_more?: number } | undefined;
      if (live) {
        const files = (live.files_touched?.length ?? 0) + (live.files_touched_more ?? 0);
        lines.push(`${indent}${last ? "   " : "│  "}   · ${live.activity ? `${oneLine(live.activity, 70)}, ` : ""}quiet ${live.quiet_s}s${live.files_touched ? `, ${files} file${files === 1 ? "" : "s"} changed` : ""}`);
      }
      for (const r of open.filter((r) => r.node_id === n.id)) {
        lines.push(`${indent}${last ? "   " : "│  "}   ! needs approval ${r.id}: ${clipped(r.summary, 80)}`);
      }
      if (n.status === "lost" && n.agent_pgid) lines.push(`${indent}${last ? "   " : "│  "}   ! an agent process (group ${n.agent_pgid}) may still be running`);
      walk(n.id, indent + (last ? "   " : "│  "));
    });
  };
  walk(null, "");
  if (nodes.length === 0) lines.push("(nothing started yet)");
  return lines.join("\n");
}
