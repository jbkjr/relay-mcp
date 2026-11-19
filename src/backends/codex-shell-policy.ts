// Which of the names relay released to a Codex turn (child_env.pass, a person-approved grant.env)
// Codex itself keeps from the commands it runs, by the person's own shell_environment_policy.
// Relay never sets, overrides or edits that policy: this only reads it (config/read, at a turn and
// in doctor's codex env line) and says what it does. Names and reasons only, never a value.
//
// Mirrors codex-cli 0.163.0 (tag rust-v0.163.0, commit 8308618), and is unchanged in 0.164.0 (tag
// rust-v0.164.0, commit 6aaac69; rechecked 2026-10-23), whose lines these are, under codex-rs/:
//  - config/src/shell_environment_policy.rs:15-49, 92-131: the fields (inherit,
//    ignore_default_excludes, exclude, set, include_only, filters, experimental_use_profile), and
//    `filters`, which cannot be mixed with exclude or include_only, nor repeat a pattern ignoring case.
//  - same file, 133-169: inherit defaults to "all" and ignore_default_excludes to true, so the
//    default excludes are off unless it is set false; filters' "include" patterns are include_only,
//    their "exclude" patterns exclude.
//  - protocol/src/shell_environment.rs:105-175 populate_env, applied to the app server's own
//    environment, where relay's released names are: (1) inherit all, none, or core
//    (UNIX_CORE_ENV_VARS, 177-181, compared ignoring ASCII case); (2) unless
//    ignore_default_excludes, drop *KEY*, *SECRET*, *TOKEN*; (3) drop exclude matches; (4) insert
//    `set`, by exact name on Unix, which replaces a released value of that name; (5) with
//    include_only non-empty, keep only matches, `set`'s entries too; (6) NON_INHERITABLE_ENV_VARS
//    (15-28, ignoring ASCII case) always removed.
//  - protocol/src/config_types.rs:230: patterns are wildmatch 2.6.1 WildMatchPattern<'*','?'>
//    built case-insensitive: `*` any run of characters, `?` one, the whole name, no escapes or
//    classes, each character compared after Unicode lowercasing.
//  - core/src/unified_exec/process_manager.rs:1473-1496, exec_command (the tool Codex's model runs
//    commands with; source unifiedExecStartup): the policy's result, then Codex sets CODEX_THREAD_ID,
//    CODEX_TOOL_CALL_ID, CODEX_SESSION_ID, CODEX_VERSION, CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS and
//    CODEX_PERMISSION_PROFILE (core/src/exec_env.rs:41-82), the ten names of UNIFIED_EXEC_ENV
//    (process_manager.rs:94-105, 130-135), and removes CODEX_PLUGIN_METRICS_OUTPUT
//    (core-plugins/src/plugin_metrics_sidecar.rs:26, 247-253). The local exec backend builds the
//    same environment again from the same policy (exec-server/src/local_process.rs:747-802).
//  - The login shell's snapshot keeps only the exports the same policy admits
//    (shell-command/src/shell_snapshot_render.rs:17-32, core/src/shell_snapshot.rs:618-619 and
//    670-676), so it cannot bring a withheld name back. The person's shell startup files can still
//    give a name a value of their own when a command runs a login shell or is captured in the
//    snapshot; relay cannot see that, and does not judge it.
//  - experimental_use_profile is parsed into use_profile and read nowhere in 0.163.0 or 0.164.0.
//  - A profile cannot set this policy (config/src/profile_toml.rs:24-82 has no such field), and
//    config/read reports the policy merged from every layer, -c flags included
//    (app-server/src/config_manager.rs:603-624, config_manager_service.rs:120-151), as configured,
//    not resolved: an unset field is null.
// A shape this does not recognise (a field it does not know, a value of the wrong type, filters
// mixed with the legacy lists) makes every name "cannot tell", never a guess.

type Inherit = "all" | "core" | "none";
interface Policy {
  inherit: Inherit;
  ignoreDefaultExcludes: boolean;
  exclude: string[];
  set: Set<string>;
  includeOnly: string[];
  /** Whether the patterns came from `filters` rather than the legacy exclude and include_only lists, for the wording. */
  filters: boolean;
}

const FIELDS = new Set(["inherit", "ignore_default_excludes", "exclude", "set", "include_only", "filters", "experimental_use_profile"]);
const CORE = ["PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "USER"];
const DEFAULT_EXCLUDES = ["*KEY*", "*SECRET*", "*TOKEN*"];
const NON_INHERITABLE = ["CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN", "NODE_REPL_AUTH_TOKEN", "CODEX_GUARDIAN_DECISIONS_API_KEY", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT"];
/** What exec_command sets or removes after the policy, by exact name on Unix. */
const CODEX_SETS = new Set([
  "CODEX_THREAD_ID", "CODEX_TOOL_CALL_ID", "CODEX_SESSION_ID", "CODEX_VERSION", "CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS", "CODEX_PERMISSION_PROFILE", "CODEX_PLUGIN_METRICS_OUTPUT",
  "NO_COLOR", "TERM", "LANG", "LC_CTYPE", "LC_ALL", "COLORTERM", "PAGER", "GIT_PAGER", "GH_PAGER", "CODEX_CI",
]);

/** Rust's eq_ignore_ascii_case: only A-Z fold. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const sameAscii = (a: string, b: string) => asciiLower(a) === asciiLower(b);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const unset = (v: unknown) => v === undefined || v === null;

/** wildmatch 2.6.1's case-insensitive match: `*` any run, `?` one character, the whole name, characters compared lowercased. */
export function codexPatternMatches(pattern: string, name: string): boolean {
  const p = [...pattern].map((c) => c.toLowerCase());
  const s = [...name].map((c) => c.toLowerCase());
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < s.length) {
    if (i < p.length && p[i] === "*") { star = i++; mark = j; }
    else if (i < p.length && (p[i] === "?" || p[i] === s[j])) { i++; j++; }
    else if (star >= 0) { i = star + 1; j = ++mark; }
    else return false;
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length;
}

/** The policy, or why relay does not recognise its shape. `raw` undefined: the server did not report one. */
function parse(raw: unknown): Policy | string {
  if (raw === undefined) return "Codex did not report its shell_environment_policy";
  if (!isObject(raw)) return "Codex reported a shell_environment_policy that is not a table";
  const unknown = Object.keys(raw).filter((k) => !FIELDS.has(k)).sort();
  if (unknown.length) return `Codex's shell_environment_policy has ${unknown.length === 1 ? "a field" : "fields"} relay does not know (${unknown.join(", ")})`;
  const wrong = (field: string) => `Codex's shell_environment_policy.${field} is not of a type relay knows`;
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const inherit = unset(raw.inherit) ? "all" : raw.inherit;
  if (inherit !== "all" && inherit !== "core" && inherit !== "none") return wrong("inherit");
  if (!unset(raw.ignore_default_excludes) && typeof raw.ignore_default_excludes !== "boolean") return wrong("ignore_default_excludes");
  if (!unset(raw.experimental_use_profile) && typeof raw.experimental_use_profile !== "boolean") return wrong("experimental_use_profile");
  for (const field of ["exclude", "include_only"]) if (!unset(raw[field]) && !strings(raw[field])) return wrong(field);
  if (!unset(raw.set) && !(isObject(raw.set) && Object.values(raw.set).every((v) => typeof v === "string"))) return wrong("set");
  let exclude = (raw.exclude ?? []) as string[];
  let includeOnly = (raw.include_only ?? []) as string[];
  const filters = !unset(raw.filters);
  if (filters) {
    if (!isObject(raw.filters) || !Object.values(raw.filters).every((v) => v === "include" || v === "exclude")) return wrong("filters");
    if (!unset(raw.exclude) || !unset(raw.include_only)) return "Codex's shell_environment_policy mixes filters with exclude or include_only, which Codex does not accept";
    const keys = Object.keys(raw.filters);
    if (new Set(keys.map((k) => k.toLowerCase())).size !== keys.length) return "Codex's shell_environment_policy.filters repeats a pattern ignoring case, which Codex does not accept";
    exclude = keys.filter((k) => (raw.filters as Record<string, string>)[k] === "exclude");
    includeOnly = keys.filter((k) => (raw.filters as Record<string, string>)[k] === "include");
  }
  return {
    inherit, ignoreDefaultExcludes: (raw.ignore_default_excludes as boolean | null | undefined) ?? true,
    exclude, includeOnly, set: new Set(Object.keys((raw.set ?? {}) as object)), filters,
  };
}

/** The two reasons that are Codex's own handling rather than the person's policy, and not the person's to change. */
const NEVER = "Codex never passes it to commands";
const CODEX_SET = "Codex sets it itself for every command";

/** Why Codex keeps `name` from its commands, in Codex's order, or [] when the released value reaches them. */
function reasons(policy: Policy, name: string): string[] {
  const out: string[] = [];
  if (policy.inherit === "none") out.push('not inherited: inherit = "none"');
  else if (policy.inherit === "core" && !CORE.some((c) => sameAscii(c, name))) out.push('not inherited: inherit = "core"');
  if (!policy.ignoreDefaultExcludes) {
    const hit = DEFAULT_EXCLUDES.find((p) => codexPatternMatches(p, name));
    if (hit) out.push(`matches Codex's default exclude ${hit}, on with ignore_default_excludes = false`);
  }
  const excluded = policy.exclude.find((p) => codexPatternMatches(p, name));
  if (excluded !== undefined) out.push(policy.filters ? `matches the exclude filter ${JSON.stringify(excluded)}` : `matches exclude ${JSON.stringify(excluded)}`);
  if (policy.set.has(name)) out.push("replaced by shell_environment_policy.set");
  if (policy.includeOnly.length && !policy.includeOnly.some((p) => codexPatternMatches(p, name))) out.push(policy.filters ? "matches no include filter" : "matches no include_only pattern");
  if (NON_INHERITABLE.some((n) => sameAscii(n, name))) out.push(NEVER);
  if (CODEX_SETS.has(name)) out.push(CODEX_SET);
  return out;
}

export type ShellPolicyVerdict =
  | { known: true; withheld: { name: string; reasons: string[] }[] }
  | { known: false; why: string };

/**
 * Which of `names` Codex keeps from the commands it runs, and why, under `policy` as config/read
 * reports it (shell_environment_policy) or as config.toml has it. A shape relay does not recognise
 * gives known: false, with why, for every name.
 */
export function codexShellPolicyVerdict(policy: unknown, names: readonly string[]): ShellPolicyVerdict {
  const parsed = parse(policy);
  if (typeof parsed === "string") return { known: false, why: parsed };
  const withheld = [...new Set(names)].sort().map((name) => ({ name, reasons: reasons(parsed, name) })).filter((w) => w.reasons.length);
  return { known: true, withheld };
}

/** Whether any reason is the person's policy (and so the person's to change), not Codex's own handling. */
const byPolicy = (withheld: { reasons: string[] }[]) => withheld.some((w) => w.reasons.some((r) => r !== NEVER && r !== CODEX_SET));
const listed = (withheld: { name: string; reasons: string[] }[]) => withheld.map((w) => `${w.name} (${w.reasons.join("; ")})`).join(", ");
const REMEDY = "To let a name through, change shell_environment_policy (inherit, include_only, exclude, set) in Codex's own config; relay does not override it.";

/**
 * The note for a Codex turn whose released names (as delivered to Codex's process) include some
 * Codex keeps from its commands, or null: names and reasons only.
 */
export function codexShellPolicyNote(policy: unknown, names: readonly string[]): string | null {
  if (!names.length) return null;
  const v = codexShellPolicyVerdict(policy, names);
  if (!v.known) return `Relay cannot tell whether Codex passes ${[...new Set(names)].sort().join(", ")}, released for this turn, to the commands it runs: ${v.why}. Codex's own shell_environment_policy decides that; relay does not override it.`;
  if (!v.withheld.length) return null;
  return `Codex will not pass ${v.withheld.length === 1 ? "this name" : "these names"} relay released for this turn to the commands it runs: ${listed(v.withheld)}. ` +
    `Relay gave ${v.withheld.length === 1 ? "it" : "them"} to Codex's process.${byPolicy(v.withheld) ? ` ${REMEDY}` : ""}`;
}
