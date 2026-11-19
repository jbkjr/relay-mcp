// The prompting briefs: for each target, how to write it a task or question so it does its best
// work, written by that target's own family (adapters/briefs/<target>.md). The model notes, which
// go stale when a family ships a new model, are kept apart in adapters/briefs/models.json with the
// date and harness version they were checked with. The generated skills, the brief tool and
// doctor all read them from here.
import fs from "node:fs";
import path from "node:path";
import { olderVersion, targetLabel, TARGETS, TESTED, versionOf, type Target, type TargetDef } from "./index.js";

/** adapters/briefs in this checkout. */
export const BRIEFS_DIR = path.resolve(import.meta.dirname, "..", "..", "adapters", "briefs");

export interface ModelNotes { checked: string; checked_with: string; effort: string[]; notes: string[]; sources: string[] }
export interface Brief { brief: string; models: ModelNotes }

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "");

/**
 * The brief and model notes for each target that has them, checked. The notes must have been
 * checked with at least the version relay's confinement was last checked with (TESTED): raising
 * that version means checking the notes again. Anything wrong is thrown.
 */
export function loadBriefs(dir = BRIEFS_DIR): Partial<Record<Target, Brief>> {
  const models = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")) as Record<string, Partial<ModelNotes> | undefined>;
  const out: Partial<Record<Target, Brief>> = {};
  for (const t of TARGETS) {
    const file = path.join(dir, `${t.id}.md`);
    if (!fs.existsSync(file) && !(t.id in models)) continue;
    const brief = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
    if (!brief) throw new Error(`no prompting brief for ${t.id}: write briefs/${t.id}.md`);
    const m = models[t.id];
    const where = `briefs/models.json ${t.id}`;
    if (!m || typeof m !== "object") throw new Error(`no model notes for ${t.id} in briefs/models.json`);
    // A real calendar date: Date would turn 2026-02-30 into March 2.
    const day = typeof m.checked === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.checked) ? new Date(`${m.checked}T00:00:00Z`) : null;
    if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== m.checked) throw new Error(`${where}: checked must be a date, YYYY-MM-DD`);
    const seen = versionOf(m.checked_with);
    if (typeof m.checked_with !== "string" || !seen) throw new Error(`${where}: checked_with must name the harness version the notes were checked with`);
    if (olderVersion(seen, TESTED[t.id])) {
      throw new Error(`${where}: the notes were checked with ${seen.join(".")}, older than the ${TESTED[t.id].join(".")} relay is tested with; check them again`);
    }
    for (const key of ["effort", "notes", "sources"] as const) if (!isStrings(m[key])) throw new Error(`${where}: ${key} must be a list of strings`);
    if (!m.sources!.every((u) => u.startsWith("https://"))) throw new Error(`${where}: sources must be https URLs`);
    out[t.id] = { brief, models: m as ModelNotes };
  }
  return out;
}

/** The text of `t`'s brief as an agent reads it, in a skill or from the brief tool. */
export function briefText(t: TargetDef, { brief, models }: Brief): string {
  return `## Writing for ${targetLabel(t)}

How to write a job (\`delegate\`) or a question (\`ask\`) for a ${targetLabel(t)} launched agent, written by ${targetLabel(t)}: each family wrote the brief on prompting itself. Relay's preamble already tells the agent its mode, scope and sandbox, and for a job the report to end with; the task text supplies the rest.

${brief}

### Model notes

Checked ${models.checked} with ${models.checked_with}. These go stale when new models ship: where they disagree with the models or harness in use, trust that harness's documentation and the user's settings.

- \`effort\` values (relay passes them to the harness as given): ${models.effort.map((e) => `\`${e}\``).join(", ")}.
${models.notes.map((n) => `- ${n}`).join("\n")}

Sources: ${models.sources.join(", ")}`;
}

/** How long after the notes were checked a newer harness is reason to check them again. */
export const RECHECK_DAYS = 30;

/**
 * For doctor: whether the installed harness has moved past the version `notes` were checked with,
 * null if it has not. Patch releases ship almost daily, so a newer version alone is said, not
 * warned about; a newer version a month or more after the check is when a new model or effort
 * level is likely to have shipped, so that is `stale`.
 */
export function notesBehind(t: TargetDef, notes: ModelNotes, installed: number[], today = new Date()): { stale: boolean; text: string } | null {
  const checked = versionOf(notes.checked_with);
  if (!checked || !olderVersion(checked, installed)) return null;
  const days = Math.floor((today.getTime() - Date.parse(`${notes.checked}T00:00:00Z`)) / 86_400_000);
  const stale = days >= RECHECK_DAYS;
  return {
    stale,
    text: `newer than the ${notes.checked_with} the model notes in relay's prompting brief for ${targetLabel(t)} were checked with (${notes.checked}, ${days} day${days === 1 ? "" : "s"} ago)` +
      (stale ? `; models or effort levels may have changed since. The notes are only advice to the launching agent: the CLI's own model list decides, and a newer relay release brings newer notes` : ""),
  };
}
