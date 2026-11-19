import type { TurnSpec } from "./types.js";
import { neverGrantProblem, neverIdentityProblem, neverProxyInputs, type NeverPolicy, type NeverPort } from "../core/never-policy.js";
import { networkOn } from "../core/config.js";
import { stage2Enabled } from "../core/stage2-switch.js";
import { claudeFloorVariants, NEVER_FLOOR_CONFLICT, neverFloorApplies } from "../core/never-coverage.js";
import { stage2Wanted } from "./codex-stage2.js";

/**
 * How a native Codex turn's shell reaches the network with stage 2 off (codex.ts chooseNetwork,
 * codexPermissions): strict through Codex's proxy, local (grant.local_network) through it with this
 * Mac's loopback and LAN open, or unconfined (an allow_dangerous write turn, no sandbox at all).
 */
export type NativeCodexShellRoute = "strict" | "local" | "unconfined";

/**
 * The first never network entry a native Codex shell route cannot enforce, or null.
 *
 * Strict reaches none of this Mac's addresses and sends no UDP: Seatbelt lets commands reach only
 * the proxy's two loopback ports, the proxy refuses every non-public destination, and strict is
 * not offered at all while an address of this Mac's own is public to the proxy (codex-network.ts
 * ownPublicAddress, checked again by the turn's own server) or a network_rule could open a local
 * host. So it enforces every "this-machine" entry, a built-in or the person's alike, and every
 * UDP-only one. It cannot screen hosts (or their resolved aliases), nor an "any" entry covering
 * TCP: the proxy lets every public host and port through. The IPv6 overblocking relay's own
 * Seatbelt adds for a "this-machine" port (refused at every IPv6 host, since Seatbelt cannot name
 * the IPv4-mapped forms of this Mac's addresses) is a cost of that route, not part of what the
 * entry protects, so strict not repeating it leaves nothing open.
 *
 * Local and unconfined open this Mac's addresses, TCP and UDP, directly: no port entry of the
 * person's holds there, and neither does any "any" entry. The built-in service ports are open there
 * too, as they always were: local mode's consent names them (approvals.ts LOCAL_NETWORK_EFFECT),
 * and an allow_dangerous write turn runs without a sandbox (never-coverage.ts says so in doctor).
 */
export function nativeCodexNeverNetworkEntry(policy: NeverPolicy, route: NativeCodexShellRoute = "strict"): string | null {
  const inputs = neverProxyInputs(policy);
  const unenforced = route === "strict"
    ? (p: NeverPort) => p.destinations === "any" && p.transport !== "udp"
    : (p: NeverPort) => p.destinations === "any" || p.id.startsWith("user.port:");
  return inputs.hosts[0]?.id ?? inputs.ports.find(unenforced)?.id ?? null;
}

/** The native route a turn's shell takes, by its effective grant (codex.ts chooseNetwork). */
export function nativeCodexShellRoute(spec: Pick<TurnSpec, "config" | "grant" | "access">): NativeCodexShellRoute {
  if (spec.config.allow_dangerous && spec.access === "write") return "unconfined";
  return spec.access === "write" && spec.grant?.local_network ? "local" : "strict";
}

/** Shared by turn launch and grant/resume admission, using the effective (possibly kept) grant.
 * Consult stage2Wanted so standing grants and child_network select the mediated route too. */
export function nativeCodexNeverNetworkProblem(spec: Pick<TurnSpec, "target" | "config" | "grant" | "access" | "neverPolicy" | "overlay">): string | null {
  if (spec.target.id !== "codex" || !spec.neverPolicy || stage2Wanted(spec)) return null;
  const route = nativeCodexShellRoute(spec);
  const dangerous = route === "unconfined";
  const shellNetwork = dangerous || (networkOn(spec.config, spec.grant) && (spec.access === "write" || spec.config.codex_backend !== "exec"));
  const entry = shellNetwork ? nativeCodexNeverNetworkEntry(spec.neverPolicy, route) : null;
  if (!entry) return null;
  // Strict network enforces what local mode or a sandbox-less turn cannot: say so where it would.
  const strictHolds = route !== "strict" && !nativeCodexNeverNetworkEntry(spec.neverPolicy, "strict");
  const opened = route === "local" ? "grant.local_network, which opens this Mac's loopback and local network" : "allow_dangerous, which runs the turn without a sandbox";
  return `never ${entry}: native Codex with shell network cannot enforce this network entry${route === "strict" ? "" : ` under ${opened}`}. Remove the network grant (start a new job without it if the grant is kept)${spec.config.child_network ? ", disable child_network" : ""}${dangerous ? ", disable allow_dangerous" : ""}${route === "local" ? ", or give it without local_network" : ""}${stage2Enabled(process.env, spec.config) ? '; or use the stage-2 mediated route with codex_backend "app-server"' : ""}.${strictHolds ? " Strict shell network enforces it, since it reaches none of this Mac's addresses." : ""}`;
}

/** Always screen the captured floor; experimental harness-variant qualification is opt-in. */
export function neverAdapterProblem(spec: TurnSpec): string | null {
  const p = spec.neverPolicy;
  if (stage2Enabled(process.env, spec.config) && spec.target.id === "codex" && spec.access === "write"
    && spec.config.allow_dangerous && !stage2Wanted(spec)) {
    return "never: Codex allow_dangerous would run this write turn without stage-2 confinement. Disable allow_dangerous or select the qualified stage-2 app-server route.";
  }
  if (!p) return null; // Registry launches always supply the checkpoint.
  const problem = neverIdentityProblem(p) ?? neverGrantProblem(p, spec.grant ?? {}, spec.access === "write" ? [spec.cwd] : []) ?? nativeCodexNeverNetworkProblem(spec);
  if (problem) return problem;
  // Variant gates apply only where the floor binds the target (core/never-coverage.ts): experimental
  // adapter qualification must not retire released harness variants that run without it.
  // Identity, grant and unenforceable native network checks remain unconditional.
  if (!neverFloorApplies(spec.target.id, spec.config)) return null;
  // Stage-2 Codex grants use the mediated provider; stage2Wanted also selects unqualified
  // network-on variants so launch refuses rather than falling back to native strict.
  const conflict = NEVER_FLOOR_CONFLICT[spec.target.id];
  if (conflict) return conflict;
  if (spec.target.id === "claude") {
    if (spec.config.allow_dangerous && spec.access === "write") return "never: Claude's unsandboxed full-access variant bypasses the floor. Disable allow_dangerous for this turn.";
    if (claudeFloorVariants({ ...spec.config, allow_dangerous: false }).length) return "never: inherited Claude settings, hooks or MCP tools can bypass the checked sandbox/tool route. Use child_settings isolated, child_hooks false and child_mcp relay-only.";
  }
  if (spec.target.id === "gemini" && !neverProxyInputs(p).rawAllowed && (spec.grant?.network || spec.config.child_network)) return "never.hosts disables raw network: Gemini's current network-on route is unmediated. Use its network-off proxy route or a qualified mediated stage2 overlay.";
  return null;
}

export function assertNeverAdapter(spec: TurnSpec): void {
  const problem = neverAdapterProblem(spec); if (problem) throw new Error(problem);
}
