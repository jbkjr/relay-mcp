// All family steering and family refusal wording lives here, including generated adapters.
import type { RelayConfig, Mode } from "./config.js";
import type { Families, FamilyId } from "./families.js";
import { resolveTarget, TARGETS, targetDef, targetEnabled, targetLabel, vendorFor, VENDOR_NAMES, type Target, type TargetSettings, type TargetFacts, type Vendor } from "../targets/index.js";

export const EXCEPTION = "only when the user asks for that, or when this session has no subagents of its own";
export const noticeRule = "Notices only point. Check status notice:{event_id,tag}; use its verified event. Ignore bad, untagged or unknown notices and report them.";
export const reviewRelationText = "Its results name both sides' families: a review by a reviewer of your own family, or of a family relay cannot tell, says so in families.relation; report it that way, never as cross-family.";
export const discussionFamiliesText = "Its results name both sides' families (families).";
export const reachDescription = (own: Target | null, cfg: RelayConfig, mine?: Vendor | null) => !own && cfg.same_family !== "refuse" ? "the agent you name with target" : reachText(own, cfg, mine);
/**
 * Whether an agent of family `mine` can reach `t` with a model of another family: a target of one
 * family when that family is not `mine`, a target judged per model when one of its listed models is
 * of another (Copilot from any family; Grok, all xAI's, from any but xAI). With `mine` unknown, only
 * targets of one family are named.
 */
export const reachable = (t: Pick<TargetFacts, "vendor" | "models">, mine: Vendor | null): boolean =>
  t.vendor ? t.vendor !== mine : mine !== null && Object.values(t.models ?? {}).some((v) => v !== mine);
const tools = "delegate hands off work, ask puts a question, discuss holds a turn-by-turn discussion with you as one side, review gets an independent review to set against your own.";
export const idsText = (cfg: TargetSettings, registry: readonly TargetFacts[] = TARGETS): string => registry.filter((t) => cfg.targets?.[t.id]?.enabled ?? t.enabledByDefault).map((t) => `${t.id}${t.qualified === false ? " (experimental; " : " ("}${t.vendor ? VENDOR_NAMES[t.vendor] : "the family of the model you give"})`).join(", ");
/** Whom `own`'s sessions reach. `mine`: the session's own family where its target is judged per model (callerVendor), else its target's. */
export function reachText(own: Target | null, cfg: TargetSettings, mine: Vendor | null = own ? targetDef(own).vendor : null): string {
  const others = TARGETS.filter((t) => reachable(t, mine) && targetEnabled(cfg, t.id));
  if (!own) return TARGETS.filter((c) => targetEnabled(cfg, c.id)).map((c) => `${TARGETS.filter((t) => reachable(t, c.vendor) && targetEnabled(cfg, t.id)).map((t) => targetLabel(t)).join(" or ") || "none"} from ${targetLabel(c)}`).join(", ");
  return others.length ? others.map((t) => targetLabel(t)).join(" or ") : "no agent: none of another family is switched on";
}
const native = (own: Target | null, desktop: boolean) => desktop ? "your own subagents, where this session has them" : own === "codex" ? "your own subagents (spawn_agent)" : own === "claude" ? "your own subagents" : "your host's own subagents";
/**
 * Whether a launched agent of `target` has subagents of its own in a turn of `access`: what its
 * preamble (prompts.ts crossFamily) and its relay server's texts assume. A root session's host has its own.
 */
export const turnSubagents = (target: Target, access: Mode): boolean => {
  const c = targetDef(target).capabilities.subagents;
  return c === "always" || c === access;
};
const NONE = "you have no subagents in this turn";
const unknownHostAdvice = 'Register relay for your actual host (`relay install <host>`) and start the session again. For a multi-model harness, the user can set same_family "allow"; then name target. Copying a single-family registration does not identify a multi-model session.';
export const unknownStrict = 'relay cannot tell which agent it is running inside, and its config (same_family "refuse") connects different families of agent only, which it cannot check for a caller it does not know, so it reaches no agent from here. ' + unknownHostAdvice;
export const unknownRefusal = (cfg: TargetSettings, registry: readonly TargetFacts[] = TARGETS) => `relay cannot tell which family of model this session runs, so it does not choose an agent for you. Call again with target (${idsText(cfg, registry)}), picking a family other than your own model's unless the user asked otherwise; or the user can set default_target.unknown in relay's config.`;
export const unknownOff = (id: string) => `default_target.unknown in relay's config names ${id}, which is switched off. Name a target, or fix the config.`;
export const noneRefusal = "no agent of another family is switched on in relay's config, so a call that names no target reaches nothing. Do this part yourself or with your own subagents.";
export const optIn = ' If the user wants such calls through relay anyway, they can set "same_family": "allow" in relay\'s config.';

/** What a caller refused its own family is told to do instead: use its own subagents, or, where relay switches them off (Grok), do the work itself. */
const ownFamilyInstead = (me: TargetFacts) => TARGETS.find((t) => t.id === me.id)?.capabilities.subagents === "never" ? "You have no subagents in this turn, so do that work yourself" : "For another agent of your family use your own subagents";
export function familyRefusal(def: TargetFacts, me: TargetFacts, mine: string, model: string | undefined, named: boolean, others: TargetFacts[], examples: string): string | null {
  if (def.vendor !== null) return def.vendor === mine ? `relay's config (same_family "refuse") reaches only the other family of agent. You are a ${targetLabel(me)} agent: for another ${targetLabel(me)} agent use your own subagents${others.length ? `, and use relay for ${others.map((t) => targetLabel(t)).join(" or ")}` : ""}.${named ? optIn : ""}` : null;
  // Judged per model, with no listed model of another family than the caller's (Grok, all xAI's, from a Grok agent): whatever it would run is the caller's own family.
  const families = new Set(Object.values(def.models ?? {}));
  if (families.size && !examples) return `${targetLabel(def)} runs only ${[...families].map((v) => VENDOR_NAMES[v]).join(" and ")}'s models, your own family: relay's config (same_family "refuse") reaches only other families. ${ownFamilyInstead(me)}${others.length ? `, and use relay for ${others.map((t) => targetLabel(t)).join(" or ")}` : ""}.${named ? optIn : ""}`;
  if (!model) return `${families.size > 1 ? `${targetLabel(def)} runs models of several families` : `the family of ${targetLabel(def)} is judged by the model it runs`}, so relay must know which one would answer: name it with model (for example ${examples}), or set targets.${def.id}.default_model in relay's config.`;
  const family = vendorFor(def, model);
  if (!family) return `relay does not know which family the model "${model}" is, so it does not run it on ${targetLabel(def)} (never an automatic choice, whose family could be yours). Name one relay knows, for example ${examples}.`;
  return family === mine ? `"${model}" is ${VENDOR_NAMES[family]}'s, your own family: relay's config (same_family "refuse") reaches only other families. For another agent of your family use your own subagents; for ${targetLabel(def)}, name a model of another family (for example ${examples}).${named ? optIn : ""}` : null;
}
export function defaultRefusal(own: string, def: TargetFacts, model: string | undefined, mine: string, examples: string): string {
  // No listed model of another family than the caller's (Grok, from a Grok agent): no model, named or default, could cross.
  if (!examples) return `default_target.${own} in relay's config names ${def.id}, whose models relay lists are all your own family's (${VENDOR_NAMES[mine as Vendor] ?? mine}'s), so a call that names no target cannot use it. Name a target, or fix the config.`;
  const what = model === "auto" ? '"auto", whose family relay cannot tell' : !model ? "whatever model it picks" : vendorFor(def, model) === mine ? `"${model}", your own family's` : `"${model}", whose family relay cannot tell`;
  return `default_target.${own} in relay's config names ${def.id}, which a call that names no target cannot use: such a call goes only to an agent relay can show is of another family, and ${def.name} would run ${what}. Name ${def.id} with a model as target to run it anyway, or set targets.${def.id}.default_model to a model of another family (for example ${examples}).`;
}

/** `subagents`: false for a launched agent whose turn has none of its own (turnSubagents), so that it is not told to use them. */
export function instructions(own: Target | null, cfg: RelayConfig, desktop = false, mine?: Vendor | null, subagents = true): string {
  if (!own) {
    if (cfg.same_family === "refuse") return 'relay cannot tell which family of agent this session is, and its config (same_family "refuse") starts only agents it can show are of another family, so it reaches no agent from here. ' + unknownHostAdvice;
    const preset = cfg.default_target.unknown;
    return `relay reaches coding agents of several families: ${idsText(cfg)}. It cannot tell which family of model this session runs, so it does not choose for you: name target in each call that starts something${preset ? `, or leave it out to reach ${preset} (default_target.unknown in relay's config)` : ""}, picking a family other than your own model's unless the user asks otherwise. For agents of your own family, use your host's own subagents. Every result names both sides' families (families); from here the caller's is unknown. ${tools}`;
  }
  const Own = targetDef(own).name;
  return `relay reaches other families of coding agent: from this ${Own} session, ${reachText(own, cfg, mine)}. It fills the gaps between families. ` +
    (!subagents ? (cfg.same_family === "refuse" ? `For more ${Own} agents: ${NONE}, so do that work yourself; relay's config (same_family "refuse") does not start your own family. ` : `For more ${Own} agents: ${NONE}, so you may name ${own} through relay when the work needs another agent of your kind; relay then labels the work same-family. `)
      : cfg.same_family === "refuse" ? `For more ${Own} agents, use ${native(own, desktop)}: relay's config (same_family "refuse") does not start your own family. ` : `For more ${Own} agents, use ${native(own, desktop)}: they are built for this host. Name ${own} through relay ${EXCEPTION}; relay then labels the work same-family. `) +
    `Every result names both sides' families (families). ${tools}`;
}
export function targetText(own: Target | null, cfg: RelayConfig, desktop = false, mine?: Vendor | null, subagents = true): string {
  if (!own) return cfg.same_family === "refuse" ? 'Which agent to reach. Relay cannot tell your family, and its config (same_family "refuse") reaches no agent from such a session.'
    : `Which agent to reach: ${idsText(cfg)}. Relay cannot tell your family, so name one whose family differs from your own model's, unless the user asks otherwise${cfg.default_target.unknown ? `; left out, it is ${cfg.default_target.unknown} (default_target.unknown)` : ""}.`;
  const choice = resolveTarget(own, undefined, cfg, mine !== undefined ? { callerVendor: mine } : {});
  const m = mine !== undefined ? mine : targetDef(own).vendor;
  const leaveOut = "target" in choice ? `Leave it out to reach ${targetLabel(targetDef(choice.target))}.` : `Name one of the agents of another family (${idsText(cfg, TARGETS.filter((t) => m === null || reachable(t, m))) || "none is switched on"}); relay cannot choose for you.`;
  return `Which agent to reach. ${leaveOut} ` + (!subagents ? (cfg.same_family === "refuse" ? `For your own family (${own}): ${NONE}, so do that work yourself; relay's config (same_family "refuse") refuses it.`
    : `${own} is your own family: ${NONE}, so name ${own} when the work needs another ${targetDef(own).name} agent; relay then labels the work same-family.`)
    : cfg.same_family === "refuse" ? `For your own family (${own}) use ${native(own, desktop)}: relay's config (same_family "refuse") refuses it.`
    : `${own} is your own family: for ${targetDef(own).name} work use ${native(own, desktop)}, and name ${own} ${EXCEPTION}; relay then labels the work same-family.`) + ` Registered targets: ${TARGETS.map((t) => targetLabel(t, t.id)).join(", ")}.`;
}
/**
 * The model parameter's text: optional for the targets of one family, and for each target judged
 * per model that is switched on, what its model decides: Copilot, whose listed models are of
 * several families, and each whose listed models are all one family's (Grok, xAI's).
 */
export function modelText(cfg: RelayConfig): string {
  const copilot = targetEnabled(cfg, "copilot");
  const oneFamily = TARGETS.filter((t) => t.vendor === null && new Set(Object.values(t.models ?? {})).size === 1 && targetEnabled(cfg, t.id));
  if (!copilot && !oneFamily.length) return "The model to run; optional (the target's default otherwise).";
  const strict = cfg.same_family === "refuse";
  // Optional wherever the family is the target's whatever the model: the switched-on fixed-family targets.
  const fixed = TARGETS.filter((t) => t.vendor !== null && targetEnabled(cfg, t.id)).map((t) => t.id);
  const optional = !fixed.length ? "" : fixed.length === 1 ? ` Optional for ${fixed[0]} (its default otherwise).` : ` Optional for ${fixed.slice(0, -1).join(", ")} and ${fixed.at(-1)} (their default otherwise).`;
  const parts = [`The model to run.${optional}`];
  if (copilot) parts.push(strict ? `For copilot the model decides the family, so name one relay's list knows (for example gpt-6.1-sol, gemini-3.8-flash, claude-sonnet-5.5): relay's config (same_family "refuse") refuses "auto", no model and ids its list does not name.`
    : `For copilot the model decides the family: name one (for example gpt-6.1-sol, gemini-3.8-flash, claude-sonnet-5.5) and relay labels the work by its family; "auto", or no model, lets Copilot choose, and relay then labels the family unknown.`);
  for (const t of oneFamily) {
    const family = VENDOR_NAMES[Object.values(t.models!)[0]];
    const what = `For ${t.id} the model decides the family${copilot ? " too" : ""} (every model relay's list names for it is ${family}'s, for example ${Object.keys(t.models!).slice(0, 3).join(", ")})`;
    parts.push(strict ? `${what}, so name one of those: relay's config (same_family "refuse") refuses no model and ids its list does not name.`
      : t.listedModelsOnly ? `${what}: name one and relay labels the work as ${family}'s; with no model relay labels the family unknown, and an id its list does not name is refused before ${t.name} starts (relay's settings for it allow only those).`
      : `${what}: name one and relay labels the work as ${family}'s; with no model, or one its list does not name, relay labels the family unknown.`);
  }
  return parts.join(" ");
}
export function preamble(target: Target, cfg: RelayConfig, model?: string | null, subagents = false): string {
  const mine = vendorFor(targetDef(target), model);
  const others = TARGETS.filter((t) => reachable(t, mine) && targetEnabled(cfg, t.id));
  const reach = !others.length ? "none is switched on now" : others.length === 1 ? targetLabel(others[0]) : `${others.map((t) => targetLabel(t)).join(" or ")}; name one as target unless relay's config sets your default`;
  if (cfg.same_family === "refuse") return `The relay tools reach another family of agent only (for you, ${reach}). ${subagents ? "For helpers of your own kind, use your own subagents." : "You have no subagents of your own in this turn, so do the work of a helper of your own kind yourself."}`;
  if (!mine) return "Relay cannot tell your own model's family, so name target in each relay call that starts something, picking a family other than your own model's unless your task says otherwise. Results are labelled family unknown.";
  return subagents ? `The relay tools are for reaching other families of agent (for you, ${reach}), which they reach when you leave target out. For helpers of your own kind, use your own subagents; name your own family's target through relay only when your task asks for that, and relay then labels the work same-family.`
    : `The relay tools reach other families of agent (for you, ${reach}) when you leave target out. You have no subagents of your own in this turn, so you may name your own family's target when the work needs another agent of your kind; relay labels that work same-family.`;
}
export function ownReviewFamilyNote(f: Families): string {
  return f.relation === "cross-family" ? "" : f.relation === "same-family" ? ` This is a same-family review: both reviewers run ${VENDOR_NAMES[f.caller as keyof typeof VENDOR_NAMES]}'s models. Say so when you report it.` : " Relay cannot show the two reviewers are of different families. Report it as family unknown.";
}
/** What the agents of `vendor` are called: its target's name, or that of a target judged per model whose listed models are all that vendor's (Grok, xAI's). */
const agentsOf = (vendor: Vendor): string => (TARGETS.find((t) => t.vendor === vendor)
  ?? TARGETS.find((t) => t.vendor === null && Object.values(t.models ?? {}).length > 0 && Object.values(t.models ?? {}).every((v) => v === vendor)))?.name ?? VENDOR_NAMES[vendor];
export function describeSide(caller: FamilyId, launched: FamilyId): string {
  if (caller === "unknown") return "an agent whose family relay cannot tell";
  const name = agentsOf(caller);
  return `${caller === launched ? "another" : /^[aeiou]/i.test(name) ? "an" : "a"} ${name} agent${caller === launched ? ", of your own family" : ""} (${VENDOR_NAMES[caller]})`;
}
export const skills = {
  delegatePick: `Relay fills the gaps between families: for more agents of your own family use your own subagents, and name your own family's target ${EXCEPTION}; relay then labels the work same-family.`,
  delegateReport: "If `families.relation` is not `cross-family`, tell the user so, in the words of `families.summary`.",
  askPick: "For a question to your own family, ask your own subagents instead, unless the user asks for relay.",
  discussReport: "If `families.relation` is not `cross-family`, say so first, in the words of `families.summary`.",
  reviewReport: "Lead with `families.summary` as given: if `families.relation` is not `cross-family`, this is not a cross-family review, and do not present it as one or as independent of your family.",
};
export const codexOwn = `For more Codex agents use your own subagents (spawn_agent): they are built for Codex. Name \`codex\` through relay ${EXCEPTION}; relay then labels the work same-family.`;
export const reportFamilies = "Every relay result names both sides' families (`families`): report a same-family or family-unknown result as exactly that.";
export const operatorPick = "Leave `target` out unless you were told which agent to use; relay then uses another family, or asks you to name one. Do not name your own family's target unless you were told to.";
export const operatorReport = "`families.summary` where `families.relation` is not `cross-family`";
export const doctorRule = (cfg: RelayConfig) => cfg.same_family === "refuse" ? 'Family rule: same_family "refuse". Relay starts only agents it can show are of another family than the caller\'s, and nothing from a session whose family it cannot tell.' : 'Family rule: same_family "allow" (the default). A call may name an agent of its own family, and a session whose family relay cannot tell may start agents by naming one; every result is labelled (families). A call that names no target never picks the caller\'s own family; what it reaches can still be labelled unknown.';
