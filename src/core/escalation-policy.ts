import { MEDIATED_NETWORK_EFFECT } from "./mediated-network-provider.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonical, insideAnyCase, type RelayConfig } from "./config.js";
import { neverDigest, neverEndpointProblem, neverPathIdentity, neverPathProblem, type NeverPolicy } from "./never-policy.js";
import type { Capability, EscalationCanonical, EscalationInput, NormalizedCapability, RequiredDecider, RootBinding } from "./escalation-contract.js";

const text = z.string().min(1).max(65536).refine(s => !s.includes("\0"), "NUL is not allowed");
const literalRoot = text.refine(s => path.isAbsolute(s) && path.normalize(s) === s && !/[\r\n*?\[\]{}~]/.test(s), "expected a literal absolute normalized root");
export const EscalationInputSchema = z.strictObject({
  capabilities: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("localhost"), port: z.number().int().min(1).max(65535), operation: z.enum(["connect", "listen"]), host: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"), api_effects: text }),
    z.strictObject({ kind: z.literal("port0") }),
    z.strictObject({ kind: z.literal("write_root"), root: literalRoot, change_to_write: z.literal(true).optional() }),
    z.strictObject({ kind: z.literal("network"), mode: z.enum(["mediated", "raw", "local"]) }),
  ])).min(1).max(32),
  reason: text,
  continuation: z.strictObject({ argv: z.array(text).min(1).max(4096).optional(), command: text.optional(), cwd: literalRoot.optional(), work: text.optional() }),
});
/** One classifier for request, display and decision. Prose never supplies authorization. */
export function requiredDecider(caps: readonly Capability[], cfg: RelayConfig): RequiredDecider {
  return caps.some(c => c.kind === "network" && c.mode !== "mediated" || c.kind === "port0" && typeof cfg.escalation === "object" && cfg.escalation.port0_authority === "person") ? "person" : "owning_run_root";
}
export function escalationDigest(value: unknown): string { return neverDigest(value); }
/** This is a non-secret binding, not a bearer token or a user-provided root label. */
export const owningRootBinding = (run: string, token: string): RootBinding => ({ run_id: run, session_identity: neverDigest(["relay-escalation-owner-v1", token]), token_version: 1 });

export function normalizeCapabilities(input: EscalationInput, cwd: string): NormalizedCapability[] {
  const values = input.capabilities.map(c => {
    let extra = {};
    if (c.kind === "localhost") extra = { transport: "tcp", resolved_addresses: [c.host] };
    if (c.kind === "write_root") {
      const real = canonical(c.root);
      if (insideAnyCase(c.root, cwd) || insideAnyCase(real, canonical(cwd))) throw new Error("write_root must name an exact root outside the worktree");
      extra = { real_root: real, exists: fs.existsSync(c.root), pins: [...neverPathIdentity(c.root), ...neverPathIdentity(real)] };
    }
    const body = { ...c, ...extra };
    return { ...body, id: neverDigest(body) };
  });
  return [...new Map(values.map(c => [c.id, c])).values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function escalationCapabilityProblem(caps: readonly NormalizedCapability[], policy: NeverPolicy, access: string): string | null {
  for (const c of caps) {
    if (c.kind === "write_root") {
      if (access === "read" && !c.change_to_write) return "read jobs need an explicit change_to_write for outside writes";
      const why = neverPathProblem(policy, c.root, "write", true); if (why) return why;
      if (canonical(c.root) !== c.real_root || neverDigest([...neverPathIdentity(c.root), ...neverPathIdentity(c.real_root!)]) !== neverDigest(c.pins)) return "outside-write root identity changed; request fresh approval";
    }
    if (c.kind === "localhost") {
      const why = neverEndpointProblem(policy, { host: c.host, port: c.port, transport: "tcp", operation: c.operation }); if (why) return why;
    }
    if (c.kind === "network" && c.mode === "raw" && policy.hosts.length) return "never.hosts disables raw network in Release A; request a qualified mediated route";
  }
  return null;
}

export const MUTABLE_CODE_TEXT = "The command runs worktree code that the agent can edit after approval.";
/** Release A's fixed four-port job block; kept local to avoid the policy/overlay/port runtime cycle. */
export const BIND_BLOCK_APPROVAL_TEXT = "The job's reserved block of 4 TCP ports ($PORT/$PORTS) is also opened for binding; listeners there may bind 0.0.0.0 and are exposed on the LAN and tailnet.";
export const PORT0_APPROVAL_TEXT = `The listener may bind 0.0.0.0 for that turn, so it is on the LAN and tailnet. This permits any otherwise allowed TCP bind port, not just OS-selected ephemeral ports. ${BIND_BLOCK_APPROVAL_TEXT} Never ports, relay control ports and protected listeners remain denied.`;
export const localhostConnectEffect = (port: number): string => `IPv4 localhost connect also allows port ${port} on this Mac's LAN and tailnet addresses. It does not allow ::1, 127.0.0.2 or other ports. Never and relay control ports remain denied. Service API effects count as part of this authority.`;
export const localhostListenEffect = (port: number): string => `TCP listen port ${port} may bind wildcard/0.0.0.0, exposing it on the LAN and tailnet. ${BIND_BLOCK_APPROVAL_TEXT} Outbound connect is not added.`;
export function escalationEffect(c: EscalationCanonical): string {
  return `End turn ${c.origin_turn} and start one new turn with the explicit capabilities below. ${MUTABLE_CODE_TEXT} The addition applies to all commands and descendants in the replacement turn and ends when that turn and its processes stop; outside writes persist on disk. `
    + (c.capabilities.some(x => x.kind === "network" && x.mode === "mediated") ? MEDIATED_NETWORK_EFFECT + " " : "")
    + (c.capabilities.some(x => x.kind === "port0") ? `${PORT0_APPROVAL_TEXT} ` : "")
    + c.capabilities.flatMap(x => x.kind === "localhost" && x.operation === "listen" ? [localhostListenEffect(x.port) + " "] : []).join("")
    + c.capabilities.flatMap(x => x.kind === "localhost" && x.operation === "connect" ? [localhostConnectEffect(x.port) + " "] : []).join("")
    + (c.capabilities.some(x => x.kind === "network" && x.mode !== "mediated") ? "Broad raw/local network is person-only: direct network, LAN/tailnet service APIs, forwarding and exfiltration are possible. " : "")
    + `Required decider: ${c.required_decider}. The owning root may approve eligible effects only when the person's authorized task clearly covers them; port-0 requires tests or servers. `
    + `Overlay budget: ${c.overlay_budget_s}s; approval expires at ${c.approval_deadline_ms}${c.deadline_ms ? `; earlier job/turn deadline ${c.deadline_ms}` : ""}. `
    + `Capabilities: ${JSON.stringify(c.capabilities)}. Intended continuation (untrusted): ${JSON.stringify(c.continuation)}. Reason (untrusted): ${JSON.stringify(c.reason)}.`;
}
