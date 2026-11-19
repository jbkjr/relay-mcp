// Relay's tools for a harness that takes them through its own command-based tool discovery rather
// than relay's MCP bridge (TargetDef.toolDiscovery: Gemini CLI, which connects no MCP server in the
// untrusted folder relay runs it in). They are offered on every version relay's general version gate
// lets run: what keeps them safe is relay's sandbox and broker, not the harness version. Whether
// discovery ran is checked at each launch instead (backends/gemini.ts, PreparedState.beforePrompt);
// the versions TargetDef.toolDiscovery names are those it was verified on live, for doctor and notes.
import type { Target, TargetDef } from "../targets/types.js";
import { targetDef } from "../targets/index.js";

/** A version as a harness reports it, its whole identity: a pre-release (0.64.0-preview.0, a nightly) or build part included. */
const FULL_VERSION = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/;

/** The whole version in a harness's version text (`--version`, or ACP's agentInfo.version), or null. */
export const fullVersionOf = (text: string | null | undefined): string | null => (text ? (FULL_VERSION.exec(text)?.[0] ?? null) : null);

/**
 * Whether relay's tools through `def`'s tool discovery were verified live on `version`, matched
 * whole: a pre-release or build of a verified version is not it. Informational: an unverified
 * version still gets the tools, and each launch checks that discovery ran.
 */
export function discoveryVerified(def: Pick<TargetDef, "toolDiscovery">, version: string | null): boolean {
  return Boolean(version && def.toolDiscovery?.versions.includes(version));
}

/** The name a launched agent of `target` calls one of relay's tools by: with the harness's discovery prefix, where it has one. */
export const relayToolName = (target: Target, tool: string): string => `${targetDef(target).toolDiscovery?.prefix ?? ""}${tool}`;
