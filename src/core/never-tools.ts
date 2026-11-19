import { neverDigest, neverIdentityProblem, neverPathProblem, type NeverEndpoint, type NeverPolicy } from "./never-policy.js";
import { neverConnectionProblem, type NeverEndpointSet } from "./never-network.js";
import { normalizeNeverHost } from "./never-schema.js";
import type { ServerDefinition } from "./extensions.js";

export interface ExtensionToolIdentity { server: string; version: string; definitionHash: string; tool: string; schemaHash: string }
export type NeverToolEffect = { kind: "path"; path: string; access: "read" | "write" | "test" | "link" } | ({ kind: "endpoint" } & NeverEndpoint);
export interface NeverToolPlan {
  /** The qualified adapter guarantees all effects, including redirects/later selection, are bounded. */
  complete: boolean;
  effects: NeverToolEffect[];
  /** Exact screened call, possibly rewritten to disable redirects/use checked numeric endpoints. */
  arguments: Record<string, unknown>;
}
/** Trusted code only, never constructed from a tool schema, annotation, model or config. */
export interface QualifiedToolAdapter { identity: ExtensionToolIdentity; normalize(args: Record<string, unknown>): NeverToolPlan | Promise<NeverToolPlan> }

/** No external server/version has been qualified yet. Unsupported tools are explicitly withheld.
 * WP6 adds reviewed adapters here only with semantic and endpoint/redirect qualification evidence.
 */
export const QUALIFIED_NEVER_TOOL_ADAPTERS: readonly QualifiedToolAdapter[] = Object.freeze([]);

/**
 * Explicit test-only registration across the harness's root, worker and child MCP processes.
 * Normal launches never set this marker. Even with it, only the fixed checked-in fixture
 * module can register adapters; no caller-selected module, server schema or effects is trusted.
 */
export async function neverToolAdapters(definitions: Record<string, ServerDefinition>): Promise<readonly QualifiedToolAdapter[]> {
  if (process.env.RELAY_TEST_NEVER_ADAPTERS !== "1" || !process.env.NODE_TEST_CONTEXT?.startsWith("child")) return QUALIFIED_NEVER_TOOL_ADAPTERS;
  const fixture = await import(new URL("../../test/fixtures/qualified-ext-adapters.mjs", import.meta.url).href);
  return [...QUALIFIED_NEVER_TOOL_ADAPTERS, ...fixture.qualifiedFixtureAdapters(definitions)];
}

export function extensionToolProblem(identity: ExtensionToolIdentity, catalog: readonly QualifiedToolAdapter[] = QUALIFIED_NEVER_TOOL_ADAPTERS): string | null {
  return catalog.some(a => neverDigest(a.identity) === neverDigest(identity)) ? null : `never withholds ${identity.server}.${identity.tool}: no qualified effects adapter for this exact server definition, version and tool schema; person consent cannot screen opaque effects`;
}
export function normalizeToolUrl(value: string): NeverEndpoint {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /%/.test(url.hostname)) throw new Error("tool URL has an unsupported scheme or authority");
  return { host: normalizeNeverHost(url.hostname.replace(/^\[|\]$/g, "")), port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80, transport: "tcp", operation: "connect" };
}

export type NeverToolScreenResult = { allow: true; arguments: Record<string, unknown>; policyHash: string } | { allow: false; reason: string; policyHash: string };
/** Every call, also preauthorized/person-approved calls, is screened immediately before forwarding. */
export async function screenExtensionCall(policy: NeverPolicy, identity: ExtensionToolIdentity, args: Record<string, unknown>, catalog: readonly QualifiedToolAdapter[] = QUALIFIED_NEVER_TOOL_ADAPTERS, checked?: NeverEndpointSet): Promise<NeverToolScreenResult> {
  const refuse = (reason: string): NeverToolScreenResult => ({ allow: false, reason, policyHash: policy.hash });
  const problem = extensionToolProblem(identity, catalog);
  if (problem) return refuse(problem);
  const adapter = catalog.find(a => neverDigest(a.identity) === neverDigest(identity))!;
  try {
    const identityProblem = neverIdentityProblem(policy); if (identityProblem) return refuse(identityProblem);
    const plan = await adapter.normalize(structuredClone(args));
    if (plan.complete !== true || !Array.isArray(plan.effects) || !plan.arguments || typeof plan.arguments !== "object") return refuse("never cannot screen opaque or implicit tool effects, redirects or later resource selection");
    for (const effect of plan.effects) {
      if (effect.kind === "path" && (typeof effect.path !== "string" || !["read", "write", "test", "link"].includes(effect.access))) return refuse("never tool adapter returned an invalid path/access effect");
      const why = effect.kind === "path" ? neverPathProblem(policy, effect.path, effect.access)
        : effect.kind === "endpoint" ? neverConnectionProblem(policy, effect, checked)
        : "never cannot screen an unsupported tool effect";
      if (why) return refuse(why);
    }
    return { allow: true, arguments: structuredClone(plan.arguments), policyHash: policy.hash };
  } catch (err) { return refuse(`never tool effects cannot be screened: ${(err as Error).message}`); }
}
