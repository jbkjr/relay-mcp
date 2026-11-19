// The harness versions relay has checked by hand or by the maintainer's release checks, one list per
// pin, oldest first. A version is appended only with the evidence for it in
// docs/research/claude-temp-limit.md or docs/qualification/, and only after the maintainer reviews it.
// Each list stays on one line of exactly this shape, which the release checks rewrite, and the docs'
// `<!-- verified:KEY -->` markers repeat it (test/verified.test.ts).
// Nothing here is a `tested` floor: those stay in each target's module.

export const VERIFIED = {
  // Claude Code versions whose temporary-directory code relay has read: each measures
  // CLAUDE_CODE_TMPDIR before resolving links. The newest is the long-home link's ceiling
  // (backends/native-temp.ts, CLAUDE_TEMP_LINK_VERIFIED_THROUGH).
  claudeTempLink: ["2.1.302", "2.1.303", "2.1.304", "2.1.308", "2.1.325", "2.1.326"],
  // Claude Code versions whose built-in plugin registry CLAUDE_BUILTIN_PLUGINS (backends/claude.ts)
  // was checked against (2.1.325: docs/research/claude-builtin-plugins.md). The list holds every
  // listed version's registry and is exactly the newest's. Evidence only: an unfamiliar built-in
  // plugin fails a turn on any version.
  claudeBuiltinPlugins: ["2.1.303", "2.1.308", "2.1.325", "2.1.326"],
  // Claude Code versions whose cc-plugin-privacy relay has read and leaves on in the Claude agents it
  // launches (backends/claude.ts keepsPrivacyPlugin; 2.1.325 and 2.1.326: docs/research/claude-builtin-plugins.md).
  // A safety pin, matched whole: on any other version relay disables that plugin like every other
  // built-in, and a turn whose init report lists it is refused.
  claudePrivacyPlugin: ["2.1.325", "2.1.326"],
  // Gemini CLI versions on which relay's tools through Gemini's command-based tool discovery were
  // checked, matched whole: live on 0.64.0 and 0.65.0, by source comparison on 0.67.0 and 0.68.0
  // (docs/qualification/gemini-<v>.md) (targets/gemini.ts toolDiscovery, backends/tool-discovery.ts).
  // Informational: the tools are offered on every version, and each launch checks discovery ran.
  geminiToolDiscovery: ["0.64.0", "0.65.0", "0.67.0", "0.68.0"],
  // Codex CLI releases on which relay's Codex route was checked: 0.163.0 by its qualification
  // (docs/UPGRADING.md), 0.164.0 by hand (2026-10-23), later ones by the release
  // watcher (docs/qualification/codex-<v>.md). Informational: targets/codex.ts's `tested` stays the floor.
  codexCli: ["0.163.0", "0.164.0", "0.167.0", "0.167.1", "0.167.2", "0.170.0"],
} as const satisfies Record<string, readonly string[]>;

export type VerifiedKey = keyof typeof VERIFIED;

/** "a", "a and b", "a, b and c": a list as relay's messages and docs write one. */
export const englishList = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** The newest version of a list. */
export const newest = (key: VerifiedKey): string => VERIFIED[key][VERIFIED[key].length - 1];
