// Family labels describe the two sides of one item. They never grant authority or route calls.
import { familyOf, type Instance, type ToolCall } from "./caller.js";
import type { Mode, RelayConfig } from "./config.js";
import { db, getNode, runConfig, setParam, tx, type NodeRow } from "./db.js";
import { sessionParams, type FamilyDoubt } from "./params.js";
import { hostFamilyDoubt } from "../mcp/host.js";
import { targetDef, TARGETS, vendorFor, VENDOR_NAMES, type Target, type TargetDef, type Vendor } from "../targets/index.js";
import type { FamilyId } from "../targets/types.js";
import { oneLine } from "./shown.js";
import { managedSettings, settingsEnvProblem } from "./claude-settings.js";
import { turnSubagents } from "./steering.js";
import type { CallerSnapshot } from "./identity.js";

export type { FamilyId } from "../targets/types.js";
export interface Families {
  caller: FamilyId; launched: FamilyId;
  relation: "cross-family" | "same-family" | "unknown";
  summary: string; note?: string;
}
export interface Contribution { label: FamilyId; doubts: FamilyDoubt[]; snapshot?: CallerSnapshot }
const fold = (ids: FamilyId[]): FamilyId => ids.length && ids.every((f) => f === ids[0]) ? ids[0] : "unknown";
export const relationOf = (a: FamilyId, b: FamilyId): Families["relation"] =>
  a === "unknown" || b === "unknown" ? "unknown" : a === b ? "same-family" : "cross-family";
export const vendorName = (f: FamilyId) => f === "unknown" ? "family unknown" : VENDOR_NAMES[f];
const doubt = (side: FamilyDoubt["side"], code: string, detail?: string): FamilyDoubt => ({ side, code, ...(detail ? { detail } : {}) });
const atomic = <T>(fn: () => T): T => db().isTransaction ? fn() : tx(fn);
const waiverFor = (target: Target, cfg: RelayConfig): string | null =>
  target === "codex" && cfg.codex_endpoint_override === "accept" ? "codex_endpoint_override_config"
    : target === "claude" && cfg.claude_settings_env === "accept" && settingsEnvProblem({ ...cfg, claude_settings_env: "refuse" }, managedSettings()) ? "claude_settings_env" : null;

/** Resolve the contribution afresh, including call metadata for native Codex subagent threads. */
export function callerLabel(inst: Instance, call: ToolCall = {}): Contribution {
  if (call.identity) return call.identity.contribution;
  const own = familyOf(inst);
  let label: FamilyId = own ? targetDef(own).vendor ?? "unknown" : "unknown";
  const doubts: FamilyDoubt[] = [];
  if (inst.ctx.kind === "child") {
    const n = getNode(inst.ctx.nodeId);
    label = n ? launchedLabel(n) : "unknown";
    if (label === "unknown") doubts.push(doubt("caller", "parent", inst.ctx.nodeId));
  } else {
    if (inst.registration) {
      label = "unknown";
      doubts.push(doubt("caller", "registration", `${inst.registration.host} (--host), but its client is ${JSON.stringify(inst.registration.client)}`));
    } else if (label === "unknown") doubts.push(doubt("caller", "host", inst.clientName ?? "no client name"));
    const envDoubt = hostFamilyDoubt(process.env, own ? targetDef(own).vendor : null);
    if (envDoubt) { label = "unknown"; doubts.push(doubt("caller", "environment", envDoubt)); }
  }
  if (own === "codex" && call.hostModel !== undefined && !targetDef("codex").ownModels!.test(call.hostModel)) {
    label = "unknown"; doubts.push(doubt("caller", "model", call.hostModel));
  }
  return { label, doubts };
}

/** Record only accepted contributions, in the transaction that accepts the message. */
export function addContribution(id: string, contribution: Contribution | FamilyId, doubts: FamilyDoubt[] = []): void {
  const c = typeof contribution === "string" ? { label: contribution, doubts } : contribution;
  atomic(() => {
    const seen = new Set<string>();
    const add = (key: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      const n = getNode(key);
      if (!n) return;
      const p = sessionParams(n);
      if (c.snapshot && !p.caller_snapshots?.some((s) => s.call_id === c.snapshot!.call_id)) {
        const snapshots = [...(p.caller_snapshots ?? []), c.snapshot];
        // Retain origin evidence and a bounded recent window for long-running items.
        setParam(key, "caller_snapshots", snapshots.length <= 21 ? snapshots : [snapshots[0]!, ...snapshots.slice(-20)]);
      }
      // A continuation of legacy work must retain its unknown history.
      setParam(key, "caller_families", [...new Set([...(p.caller_families ?? ["unknown" as const]), c.label])]);
      const all = [...(p.family_doubts ?? []), ...(!p.caller_families ? [doubt("caller", "legacy")] : []), ...c.doubts];
      setParam(key, "family_doubts", all.filter((d, i) => all.findIndex((e) => JSON.stringify(e) === JSON.stringify(d)) === i));
      if (n.kind === "discussion") {
        const dp = JSON.parse(n.params_json!) as { borrowed: boolean; participant: string; review_id?: string };
        add(dp.participant);
        if (dp.review_id) add(dp.review_id);
      }
    };
    add(id);
  });
}

export function recordStart(id: string, inst: Instance, call: ToolCall, target: Target, model: string | null | undefined, cfg: RelayConfig): void {
  atomic(() => {
    setParam(id, "caller_families", []);
    const def = targetDef(target);
    const waiver = waiverFor(target, cfg);
    const initial = waiver ? "unknown" : vendorFor(def, model ?? cfg.targets[target]?.default_model) ?? "unknown";
    setParam(id, "launched_family", initial);
    setParam(id, "family_doubts", waiver ? [doubt("launched", waiver)] : []);
    if (!def.vendor && initial === "unknown") {
      setParam(id, "family_doubts", [doubt("launched", !model || model === def.autoModel ? "auto" : "unlisted", model ?? cfg.targets[target]?.default_model ?? "no model")]);
    }
    addContribution(id, callerLabel(inst, call));
  });
}

export function recordServed(id: string, def: TargetDef, model: string | null): void {
  atomic(() => {
    const n = getNode(id);
    if (!n) return;
    const p = sessionParams(n);
    const models = [...(p.served_models ?? [])];
    if (model && models.at(-1) !== model) models.push(model);
    setParam(id, "served_models", models);
    setParam(id, "served_model", model);
    const current = vendorFor(def, model) ?? "unknown";
    const before = launchedLabel(n);
    setParam(id, "launched_family", fold([before, current]));
    if (!def.vendor && models.length > 1) {
      const all = [...(p.family_doubts ?? []).filter((d) => d.code !== "switch"), doubt("launched", "switch", models.join(", then "))];
      setParam(id, "family_doubts", all);
    }
  });
}

export function recordWaiver(id: string, which: "claude_settings_env" | "codex_endpoint_override"): void {
  atomic(() => {
    const n = getNode(id);
    if (!n) return;
    setParam(id, "launched_family", "unknown");
    const ds = (sessionParams(n).family_doubts ?? []).filter((d) => d.code !== `${which}_config`);
    if (!ds.some((d) => d.code === which)) setParam(id, "family_doubts", [...ds, doubt("launched", which)]);
  });
}

/** Old rows cannot prove the caller's family, and accepted legacy waivers lower the launch. */
export function launchedLabel(n: NodeRow, p = sessionParams(n)): FamilyId {
  if (p.launched_family) return p.launched_family;
  if (!n.target) return "unknown";
  const cfg = runConfig(n.run_id);
  if (waiverFor(n.target, cfg)) return "unknown";
  return vendorFor(targetDef(n.target), n.model ?? cfg.targets[n.target]?.default_model) ?? "unknown";
}

export function summaryText(kind: string, caller: string, launched: string, relation: Families["relation"], family: FamilyId): string {
  return relation === "cross-family" ? `Cross-family: ${caller} working with ${launched}.`
    : relation === "same-family" ? `Same-family: ${caller} working with ${launched}. Both run ${vendorName(family)}'s models; this is not a cross-family ${kind}.`
    : `Family unknown: relay cannot show that ${caller} and ${launched} are of different families, so this ${kind} is not known to be cross-family.`;
}

/** `harness`: the launched side's harness, by name ("Copilot", "Grok"), for the doubts about the model it ran. */
export function noteText(ds: FamilyDoubt[], legacy: boolean, mixed: Vendor[], models: string[], harness: string): string {
  const sentences = ds.map((raw) => {
    const d = { ...raw, ...(raw.detail ? { detail: oneLine(raw.detail, 120) } : {}) };
    switch (d.code) {
      case "registration": return `Relay cannot tell this session's family: it is registered as ${d.detail}.`;
      case "host": return `Relay cannot tell this session's family: its host is not one relay knows (client name ${JSON.stringify(d.detail)}).`;
      case "environment": return `Relay cannot tell this session's family: this session's environment sets ${d.detail}, so its model may not be ${d.detail?.startsWith("ANTHROPIC") ? "Anthropic" : "OpenAI"}'s.`;
      case "model": return `Relay cannot tell this session's family: Codex reported the model ${JSON.stringify(d.detail)} for this call.`;
      case "parent": return `The calling agent ${d.detail} has a family relay cannot tell.`;
      case "auto": return `${harness} chose the model (${d.detail === "no model" ? "no model named" : "auto"}); it reported ${oneLine(models.join(", then "), 120) || "no model"}.`;
      case "unlisted": return `${harness} was asked to run ${JSON.stringify(d.detail)}, which relay's model list does not name.`;
      case "switch": return `${harness} changed models during the work (${d.detail}).`;
      case "codex_endpoint_override": return 'Relay launched Codex with an endpoint its config does not judge (codex_endpoint_override "accept").';
      case "codex_endpoint_override_config": return 'Relay\'s config permits an endpoint override (codex_endpoint_override "accept"); relay conservatively labels this item unknown even when no redirect is active.';
      case "claude_settings_env": return 'Relay launched Claude with settings it does not vet (claude_settings_env "accept").';
      case "legacy": return "This item was recorded before relay kept the caller's family.";
      default: return "";
    }
  }).filter(Boolean);
  if (mixed.length > 1) sentences.push(`Sessions of more than one family worked on the calling side (${mixed.map(vendorName).join(", ")}).`);
  if (legacy) sentences.push("This item was recorded before relay kept the caller's family.");
  return [...new Set(sentences)].join(" ") || "Relay cannot show the two sides are of different families.";
}

export function familiesOf(row: NodeRow, kind = row.kind === "thread" ? "consult" : row.kind): Families {
  // Always read fresh: backend callbacks and other sessions can have contributed since row was read.
  const n = getNode(row.id) ?? row;
  const p = sessionParams(n);
  const raw = p as { participant?: string; reviewer?: string };
  const part = n.kind === "discussion" ? getNode(raw.participant ?? "") : n.kind === "review" ? getNode(raw.reviewer ?? "") : n;
  // A job's or thread's own params, read once.
  const pp = part === n ? p : part ? sessionParams(part) : {};
  const caller = fold(p.caller_families ?? []);
  const launched = part ? launchedLabel(part, pp) : "unknown";
  const relation = relationOf(caller, launched);
  const mixed = (p.caller_families ?? []).filter((f): f is Vendor => f !== "unknown");
  let parent = n.parent_id ? getNode(n.parent_id) : null;
  if (parent && ["review", "discussion"].includes(parent.kind)) parent = parent.parent_id ? getNode(parent.parent_id) : null;
  const launchedCaller = parent && ["job", "thread"].includes(parent.kind) ? parent : null;
  const ownName = TARGETS.find((t) => t.vendor === caller)?.name ?? vendorName(caller);
  const c = caller !== "unknown" ? launchedCaller ? `${launchedCaller.id} (${launchedCaller.target ? targetDef(launchedCaller.target).name : ownName}, ${vendorName(caller)})` : `${ownName} (${vendorName(caller)})`
    : mixed.length > 1 ? `sessions of more than one family (${mixed.map(vendorName).join(", ")})` : "a session of unknown family";
  const def = n.target ? targetDef(n.target) : null;
  const model = part?.model ?? (def ? runConfig(n.run_id).targets[def.id]?.default_model : null);
  const a = def ? `${def.name}${!def.vendor ? ` running ${model ? oneLine(model, 60) : "its own choice"}` : ""} (${vendorName(launched)})` : "an agent of unknown family";
  const summary = summaryText(kind, c, a, relation, caller);
  if (relation === "cross-family") return { caller, launched, relation, summary };
  const launchedDoubts = (pp.family_doubts ?? []).filter((d) => d.side === "launched");
  if (part && !pp.launched_family) {
    const cfg = runConfig(part.run_id);
    const waiver = part.target && waiverFor(part.target, cfg);
    if (waiver) launchedDoubts.push(doubt("launched", waiver));
  }
  const note = relation === "same-family"
    ? `Relay started ${a} because the call named it. ${launchedCaller ? (!launchedCaller.target || turnSubagents(launchedCaller.target, launchedCaller.kind === "job" ? launchedCaller.mode as Mode : "read") ? "Relay's preamble to you gives your own subagents first place for helpers of your own kind." : "Relay's preamble to you says you have no subagents in this turn, so you may name your own family's target when the work needs another agent of your kind.") : `Its tool descriptions give your own subagents first place for ${ownName} work, unless the user asked for relay or this session has none.`}`
    : noteText([...(p.family_doubts ?? []).filter((d) => d.side === "caller"), ...launchedDoubts], !p.caller_families, mixed, pp.served_models ?? [], part?.target ? targetDef(part.target).name : "Its harness");
  return { caller, launched, relation, summary, note };
}
