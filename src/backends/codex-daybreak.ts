// Person-owned standing policy, never a tool argument or a grant. No credentials or model calls.
// Unset leaves Codex's own configuration and automatic behavior untouched. On 0.163.0+,
// explicit false pins -c daybreak=false; true requests -c daybreak=true only for an exact
// model slug whose models_cache.json available_access_programs.cyber lists daybreak_blue.
// The launching server's model/list must confirm availableAccessPrograms.cyber includes
// daybreakBlue before the turn. Missing or stale metadata narrows the request to standard.
// Eligible launches also pin -c features.cli_daybreak=true (stable/on in 0.163.0) and
// -c model=<slug>, so server config loads against the selected model rather than a CLI default.
// App-server additionally opts into experimentalApi and supplies cyberAccessProgram on
// turn/start: daybreakBlue or standard. Omitting that field preserves automatic behavior;
// a saved thread preference alone does not select it. Thread config pins the same daybreak
// choice for initial/resumed turns. Exec uses the CLI flags and its existing preflight.
// These select a program; neither discovery nor a successful turn attests it was served.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { olderVersion, versionOf } from "../targets/index.js";
import { probeVersion } from "./cli-version.js";

export const DAYBREAK_VERSION = [0, 163, 0] as const;
export function codexVersion(bin: string, env: NodeJS.ProcessEnv = process.env): number[] | null {
  const r = probeVersion("codex", bin, env);
  return r.status === 0 ? versionOf(r.stdout) : null;
}

/** Codex 0.163.0's ModelsCacheEntry / ModelInfo: exact slugs and caller-specific access programs.
 * Read afresh for each turn, including resumes; no aliases, inferred CLI default or static list.
 * Missing, malformed or ambiguous metadata never authorizes Daybreak.
 */
export function daybreakCatalog(env: NodeJS.ProcessEnv = process.env): { models: string[]; source: string; problem?: string } {
  const source = path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"), "models_cache.json");
  try {
    const cache = JSON.parse(fs.readFileSync(source, "utf8"));
    if (!Array.isArray(cache?.models)) throw new Error("missing models array");
    const counts = new Map<string, number>();
    for (const m of cache.models) if (typeof m?.slug === "string") counts.set(m.slug, (counts.get(m.slug) ?? 0) + 1);
    const models = cache.models.filter((m: any) => typeof m?.slug === "string" && counts.get(m.slug) === 1 &&
      Array.isArray(m.available_access_programs?.cyber) && m.available_access_programs.cyber.includes("daybreak_blue"))
      .map((m: any) => m.slug as string).sort();
    return { models, source };
  } catch {
    return { models: [], source, problem: "Codex's model cache is missing or unreadable" };
  }
}

export interface DaybreakDecision { enabled: boolean; explicit: boolean; note?: string }
/** A current server's catalog can narrow the cache's decision, never opt a turn in. */
export function skipDaybreak(flags: { c: string[]; expect: { daybreak?: boolean } }, onNote: ((note: string) => void) | undefined, note: string): void {
  flags.expect.daybreak = false;
  const at = flags.c.indexOf("daybreak=true");
  if (at >= 0) flags.c[at] = "daybreak=false";
  onNote?.(note);
}

export function daybreakDecision(on: boolean | undefined, model: string | undefined, version: readonly number[] | null, catalog: { models: string[]; problem?: string }): DaybreakDecision {
  if (on === undefined) return { enabled: false, explicit: false };
  if (!version) return { enabled: false, explicit: false, ...(on ? { note: "Daybreak was requested, but relay cannot determine the Codex version; no Daybreak override was passed." } : {}) };
  if (olderVersion(version, DAYBREAK_VERSION)) return { enabled: false, explicit: false, ...(on ? { note: `Codex ${version.join(".")} applies Daybreak automatically for enrolled accounts; targets.codex.daybreak has no effect before 0.163.0.` } : {}) };
  if (!on) return { enabled: false, explicit: true };
  const why = !model ? "relay cannot determine the turn's model" : catalog.problem ?? (!catalog.models.includes(model) ? `Codex's model cache does not list ${JSON.stringify(model)} for daybreak_blue` : null);
  return why ? { enabled: false, explicit: true, note: `Daybreak was requested, but ${why}; this turn runs without Daybreak.` } : { enabled: true, explicit: true };
}

export function daybreakDoctor(on: boolean | undefined, version: readonly number[] | null, env: NodeJS.ProcessEnv = process.env): string {
  if (on === undefined) return "targets.codex.daybreak not set: Codex's own configuration decides";
  const catalog = daybreakCatalog(env);
  const old = version && olderVersion(version, DAYBREAK_VERSION);
  return `targets.codex.daybreak ${on ? "on" : "off"}; Codex ${version?.join(".") ?? "unknown"}; ` +
    (old ? "Daybreak is automatic for enrolled accounts before 0.163.0; this key has no effect" :
      `eligible models: ${catalog.models.join(", ") || "none known"} (${catalog.source}${catalog.problem ? `; ${catalog.problem}` : ""}); unknown models run without Daybreak`);
}
