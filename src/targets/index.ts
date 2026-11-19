// The registry of targets. Adding one is a module beside claude.ts and a line here, and its
// backend in backends/index.ts: there is no loading of targets from config, so that each one relay
// can launch is reviewed as code. The registry is data: it imports no backend, so that the
// backends and the config can import it.
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { copilot } from "./copilot.js";
import { gemini } from "./gemini.js";
import { grok } from "./grok.js";
import { TARGET_IDS, VENDOR_NAMES, type Target, type TargetDef, type Vendor } from "./types.js";
import { unknownStrict, unknownRefusal, unknownOff, noneRefusal, familyRefusal, defaultRefusal } from "../core/steering.js";

export { SPEEDS, speedRank, TARGET_IDS, VENDOR_NAMES, type Capabilities, type FamilyId, type Speed, type SpeedOption, type Target, type TargetDef, type Vendor } from "./types.js";

export const TARGETS: readonly TargetDef[] = [claude, codex, copilot, gemini, grok];

/**
 * The side label of the calling agent in a discussion or review where its target id would be the
 * other side's too (same_family "allow", or an existing session of its own family), and the prefix
 * of its review items. Rows recorded before relay refused callers of unknown family use it for
 * those. No target uses either.
 */
export const CALLER_LABEL = "caller";
export const CALLER_PREFIX = "R";

{
  const ids = TARGETS.map((t) => t.id);
  if (ids.some((id: string) => id === "unknown" || id === CALLER_LABEL)) throw new Error("target ids unknown and caller are reserved");
  if (ids.join() !== TARGET_IDS.join()) throw new Error(`relay's target registry (${ids.join(", ")}) does not match TARGET_IDS (${TARGET_IDS.join(", ")})`);
  const prefixes = TARGETS.map((t) => t.reviewPrefix);
  if (new Set(prefixes).size !== prefixes.length || prefixes.some((p) => !/^[A-Z]{1,2}$/.test(p) || p === CALLER_PREFIX)) {
    throw new Error(`relay's targets need distinct review prefixes of one or two capital letters other than ${CALLER_PREFIX}, not ${prefixes.join(", ")}`);
  }
}

const BY_ID = new Map<string, TargetDef>(TARGETS.map((t) => [t.id, t]));

export const isTarget = (id: unknown): id is Target => typeof id === "string" && BY_ID.has(id);
export const targetDef = (id: Target): TargetDef => BY_ID.get(id)!;

/** Human-facing target name or id. Opting in does not make an unqualified target qualified. */
export const targetLabel = (t: Pick<TargetDef, "name"> & Partial<Pick<TargetDef, "qualified">>, label = t.name): string =>
  `${label}${t.qualified === false ? " (experimental)" : ""}`;

/** One value per target, keyed by id. */
export const perTarget = <V>(fn: (t: TargetDef) => V): Record<Target, V> =>
  Object.fromEntries(TARGETS.map((t) => [t.id, fn(t)])) as Record<Target, V>;

/** The floor versions relay's confinement was checked against by hand. Older ones are refused. */
export const TESTED = perTarget((t) => t.tested);

/** The first x.y.z in a version line: "codex-cli 0.162.1" is [0, 162, 1]. */
export const versionOf = (text: unknown): number[] | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(typeof text === "string" ? text : "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
/** Whether version `a` is older than `b`, compared number by number over `b`'s (a missing number in `a` counts as 0). */
export function olderVersion(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) < b[i];
  return false;
}

/**
 * Credentials any registered target's CLI would take from the environment in place of its stored
 * login. All of them, whichever target is launched: no agent is handed another vendor's keys,
 * except under the legacy global child_auth "any", which removes none (see scrubbedCredentials).
 */
export const CREDENTIALS = new RegExp(TARGETS.map((t) => `(?:${t.credentialEnv.source})`).join("|"));

/**
 * The targets of other families that `id`'s sessions reach as shipped (switched on by default),
 * for what is written ahead of any config: the generated skills and adapters.
 */
export const otherTargets = (id: Target): TargetDef[] =>
  TARGETS.filter((t) => t.vendor !== targetDef(id).vendor && t.enabledByDefault);
/** The same, named: "Codex". */
export const otherFamilies = (id: Target): string => otherTargets(id).map((t) => targetLabel(t)).join(", ");

/**
 * The family a target answers with when running `model`: its own, or for a harness of several
 * families' models the model's, from its reviewed list; null when relay cannot tell (no model, an
 * unknown id, an automatic choice).
 */
export function vendorFor(def: Pick<TargetDef, "vendor" | "models">, model: string | null | undefined): Vendor | null {
  if (def.vendor) return def.vendor;
  if (!model || !def.models || !Object.hasOwn(def.models, model)) return null;
  return def.models[model];
}

// Discussions and reviews have two sides, each labelled with its target's id (or CALLER_LABEL).

/** How a side is named in messages: "Claude", or "the calling agent's" side for CALLER_LABEL. */
export const sideName = (label: string): string => (isTarget(label) ? targetLabel(targetDef(label)) : "calling");
/** The prefix of a side's review items: C1, X2, or R3 for a caller of unknown family. */
export const sidePrefix = (label: string): string => (isTarget(label) ? targetDef(label).reviewPrefix : CALLER_PREFIX);
/** The side a review item id belongs to, by its prefix, or null for an id no side would give. */
export function sideOfItem(id: string): string | null {
  const prefix = /^([A-Z]+)\d+$/.exec(id)?.[1];
  if (!prefix) return null;
  if (prefix === CALLER_PREFIX) return CALLER_LABEL;
  return TARGETS.find((t) => t.reviewPrefix === prefix)?.id ?? null;
}
/** Two side labels in registry order (an unknown caller last), so that what is listed by side reads the same whoever called. */
export const inSideOrder = (labels: string[]): string[] => {
  const rank = (l: string) => (isTarget(l) ? TARGET_IDS.indexOf(l) : TARGET_IDS.length);
  return [...labels].sort((a, b) => rank(a) - rank(b));
};

// Which target a call reaches.

/** What of relay's config target resolution reads: which targets are switched on, and each caller's default. */
export interface TargetSettings {
  targets?: Partial<Record<Target, { enabled?: boolean; default_model?: string }>>;
  /** Whether a call may name a target of its own family (see RelayConfig.same_family). */
  same_family?: "refuse" | "allow";
  default_target?: Partial<Record<Target | "unknown", Target>>;
}
export const targetEnabled = (cfg: TargetSettings, id: Target): boolean => cfg.targets?.[id]?.enabled ?? targetDef(id).enabledByDefault;

/** What resolution needs to know about each target. The registry, unless a test passes another. */
export type TargetFacts = Pick<TargetDef, "id" | "vendor" | "name" | "enabledByDefault"> & Partial<Pick<TargetDef, "models" | "qualified">>;

/** Resolve each call: explicit targets are allowed and labelled by default; omitted targets
 * always cross the current routing family. Unknown callers use only their explicit target or
 * default_target.unknown. Strict policy retains 0.9 admission; authority checks stay separate. */
export function resolveTarget(
  caller: string | null, requested: string | undefined, cfg: TargetSettings,
  opts: { existing?: boolean; registry?: readonly TargetFacts[]; model?: string | null; callerVendor?: Vendor | null } = {},
): { target: Target; model?: string } | { reason: string } {
  const registry = opts.registry ?? TARGETS;
  const find = (id: string) => registry.find((t) => t.id === id);
  const settings = (t: TargetFacts) => (cfg.targets as Record<string, { enabled?: boolean; default_model?: string }> | undefined)?.[t.id];
  const on = (t: TargetFacts) => settings(t)?.enabled ?? t.enabledByDefault;
  const modelOf = (t: TargetFacts) => opts.model ?? settings(t)?.default_model ?? undefined;
  const familyOf = (t: TargetFacts) => vendorFor(t, modelOf(t));
  const names = (ts: TargetFacts[]) => ts.map((t) => targetLabel(t)).join(" or ");
  const me = caller ? find(caller) : undefined;
  const mine = opts.callerVendor !== undefined ? opts.callerVendor : (me?.vendor ?? null);
  const strict = cfg.same_family === "refuse";
  const reached = (def: TargetFacts) => ({ target: def.id, ...(def.vendor === null && modelOf(def) ? { model: modelOf(def)! } : {}) });
  if (!me || !mine) {
    if (strict) return { reason: unknownStrict };
    const id = requested ?? cfg.default_target?.unknown;
    if (!id) return { reason: unknownRefusal(cfg, registry) };
    const def = find(id);
    if (!def) return { reason: `relay has no agent called "${id}"; it knows ${registry.map((t) => targetLabel(t, t.id)).join(", ")}.` };
    if (!opts.existing && !on(def)) return { reason: requested === undefined ? unknownOff(id) : `${targetLabel(def)} is switched off in relay's config (targets.${def.id}.enabled). Do this part yourself.` };
    return reached(def);
  }
  const others = registry.filter((t) => on(t) && familyOf(t) !== null && familyOf(t) !== mine);
  /** Models of `t` from families other than the caller's, as examples for a message. */
  const examples = (t: TargetFacts) => Object.entries(t.models ?? {}).filter(([, v]) => v !== mine).map(([m]) => m).slice(0, 6).join(", ");
  /** Said with a refusal of the caller's own family: what the person can change, if they want such calls. */
  /**
   * Why the caller cannot reach `def` with the model it would run, or null. `named`: the call names
   * the target itself, the only way the caller's own family is ever reached, and only where the
   * config allows it; a default never is.
   */
  const crossing = (def: TargetFacts, named: boolean): string | null => {
    if (named && !strict) return null;
    if (!named && def.vendor === null && (!familyOf(def) || familyOf(def) === mine)) return defaultRefusal(me.id, def, modelOf(def), mine, examples(def));
    return familyRefusal(def, me, mine, modelOf(def), named, others, examples(def));
  };
  if (requested !== undefined) {
    const def = find(requested);
    if (!def) return { reason: `relay has no agent called "${requested}"; it knows ${registry.map((t) => targetLabel(t, t.id)).join(", ")}.` };
    const no = opts.existing ? null : crossing(def, true);
    if (no) return { reason: no };
    if (!opts.existing && !on(def)) {
      return { reason: `${targetLabel(def)} is switched off in relay's config (targets.${def.id}.enabled).${others.length ? ` Use ${names(others)} instead, or do this part yourself.` : " Do this part yourself."}` };
    }
    return reached(def);
  }
  const preset = (cfg.default_target as Record<string, string> | undefined)?.[me.id];
  if (preset) {
    const def = find(preset);
    if (!def || def.vendor === mine) return { reason: `default_target.${me.id} in relay's config names ${def ? targetLabel(def, preset) : preset}, which a ${targetLabel(me)} agent cannot reach. Name a target, or fix the config.` };
    const no = crossing(def, false);
    if (no) return { reason: no };
    if (!on(def)) return { reason: `default_target.${me.id} in relay's config names ${targetLabel(def, preset)}, which is switched off. Name a target, or fix the config.` };
    return reached(def);
  }
  if (others.length === 1) return reached(others[0]);
  if (!others.length) return { reason: noneRefusal };
  return { reason: `several agents of other families are available (${others.map((t) => targetLabel(t, t.id)).join(", ")}), so name one with target, or set default_target.${me.id} in relay's config.` };
}

// What a target can be asked to do.

/** What a call needs from the target it reaches. */
export interface Needs {
  /** The access of the turns it starts. */
  mode: "read" | "write";
  /** Whether those turns have network access (a grant, or child_network). */
  network: boolean;
  /** Whether the root granted extra write paths. */
  writePaths: boolean;
  /** Whether the session must be continued in later turns: a follow-up, a resume, a discussion. */
  continues: boolean;
}

/**
 * Why `def` cannot honour a call that needs `needs`, or null. Admission control: a call is refused
 * up front rather than run with less than it was promised. Whether relay's own confinement can
 * enforce on this machine is checked by the caller (ops), which can reach the mechanism.
 */
export function incapable(def: TargetDef, needs: Needs): string | null {
  const c = def.capabilities;
  if (c.confinement === "none") return `${targetLabel(def)} has no confinement relay can enforce or verify, so relay does not launch it.`;
  if (needs.mode === "read" && !c.readOnly) return `relay cannot keep ${targetLabel(def)} read-only, so it does not start read-only work there. Use another agent, or do this part yourself.`;
  if (!needs.network && !c.networkOff) {
    return `relay cannot keep ${targetLabel(def)} off the network yet${c.confinement === "relay-enforced" ? " (relay does not know which hosts it needs to reach its model, so its network proxy would admit none)" : ""}, so it starts ${targetLabel(def)} only with network access: pass grant: { network: true } if the work may use the network, or use another agent.`;
  }
  if (needs.writePaths && !c.writeRoots) return `relay cannot give ${targetLabel(def)} write access outside its worktree, so grant.write_paths cannot be honoured there.`;
  if (needs.continues && !c.resume) return `${targetLabel(def)} sessions cannot be continued in a later turn, so relay cannot follow up, resume or hold a discussion there.`;
  return null;
}
