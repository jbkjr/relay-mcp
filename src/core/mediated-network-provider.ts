/** Single trusted provider for standing grants and mediated overlays. No tool/config selects it. */
import type { Grant, TurnSpec } from "../backends/types.js";
import type { Stage2Network } from "../confine/seatbelt-stage2.js";
import type { Capability } from "./escalation-contract.js";
import type { OverlayCapability } from "./restart-overlay.js";
import type { NeverPolicy } from "./never-policy.js";
import { neverProxyInputs } from "./never-policy.js";
import type { NeverLookup } from "./never-network.js";
import { createNeverProxyPolicy } from "./never-proxy-policy.js";
export { mediatedLookup } from "./never-proxy-policy.js";
import { openProxy as openTurnProxy } from "../confine/proxy.js";
import { checkStage2Network } from "../confine/seatbelt-stage2.js";

/** child_network is standing network consent too, without manufacturing a stored grant. */
export const mediatedBaseline = (grant: Grant | undefined | null, cfg: { child_network: boolean }): Grant | undefined => cfg.child_network ? { ...grant, network: true } : grant ?? undefined;

export interface MediatedNetworkContext {
  capabilities: readonly (Capability | OverlayCapability)[];
  baseline: Grant | undefined;
  policy: NeverPolicy;
}
export interface MediatedNetworkLaunch {
  network: Stage2Network;
  executorEnv?: NodeJS.ProcessEnv;
  appEnv?: NodeJS.ProcessEnv;
  /** Called after executor teardown, also on any subsequent launch failure. */
  close(): Promise<void>;
}
export interface MediatedNetworkProvider {
  /** Check all requested/baseline effects and the cumulative never floor before prompting.
   * Release A refuses localhost-connect overlays when never.hosts is nonempty; no direct-socket or
   * mediated exception route exists. Repeated at decision, consumption and launch; no proxy starts here. */
  qualify(context: MediatedNetworkContext): string | null;
  /** Prepare one turn under the existing supervisor deadline/signal. A throwing implementation
   * must clean up its partial preparation. No command executor or unconfined fallback belongs here. */
  prepare(context: MediatedNetworkContext & {
    spec: TurnSpec; env: Readonly<NodeJS.ProcessEnv>; tmpDir: string; network: Stage2Network; proxyPort?: number;
  }): Promise<MediatedNetworkLaunch>;
}

export const NO_MEDIATED_PROVIDER = "no qualified mediated provider is available";
export function needsMediatedNetwork(capabilities: MediatedNetworkContext["capabilities"], baseline?: Grant, policy?: NeverPolicy): boolean {
  return capabilities.some(c => c.kind === "network" && c.mode === "mediated"
    || c.kind === "localhost" && c.operation === "connect" && !!policy?.hosts.length) || !!(baseline?.network && !baseline.raw_network);
}

/** Public HTTP(S)/TCP only. No raw fallback, local route, Codex proxy or trust daemon. */
export const MEDIATED_NETWORK_EFFECT = "Public hosts through the turn's HTTP(S)/SOCKS5 proxy only; the proxy refuses local, private, on-link and this-machine destinations. Tools must honour proxy settings; tools that ignore proxy variables fail closed. Direct TCP, UDP and DNS remain denied except separately approved localhost capabilities. Each requested authority and checked numeric endpoint passes never. Opaque tunnels have no TLS/SNI inspection. No Go/Swift TLS for these jobs until Release B: Security.framework certificate trust stays disabled.";

/** Code-only fixture dependencies; neither config nor a child environment can select these. */
export function createMediatedNetworkProvider(deps: {
  open?: typeof openTurnProxy;
  lookup?: (host: string, signal: AbortSignal) => ReturnType<NeverLookup>;
  now?: () => number;
} = {}): MediatedNetworkProvider {
  const qualify = (c: MediatedNetworkContext): string | null => {
    if (!c.baseline?.network && !c.capabilities.some(x => x.kind === "network" && x.mode === "mediated")) return "mediated provider requires a standing network grant or an explicit one-turn mediated capability";
    if (c.baseline?.raw_network || c.baseline?.local_network || c.capabilities.some(x => x.kind === "network" && x.mode !== "mediated")) return "mediated networking cannot be combined with raw or local networking";
    if (c.policy.hosts.length && c.capabilities.some(x => x.kind === "localhost" && x.operation === "connect")) return "localhost connect is unavailable with never.hosts: the direct IPv4 allowance cannot screen forbidden DNS endpoints";
    return null;
  };
  return { qualify, async prepare(c) {
    const problem = qualify(c); if (problem) throw new Error(problem);
    if (!c.proxyPort) throw new Error("mediated networking requires a stage-2 leased proxy port");
    const network = { ...c.network, egress: "none" as const, mediatedPort: c.proxyPort };
    checkStage2Network(network);
    // A final never deny cannot be lifted even for the proxy's transport port.
    const inputs = neverProxyInputs(c.policy);
    if (inputs.ports.some(p => p.port === c.proxyPort && p.transport !== "udp")) throw new Error("never refuses the leased proxy transport port");
    const controller = new AbortController(), signal = controller.signal;
    const abort = () => controller.abort(new Error("mediated turn ended"));
    c.spec.signal?.addEventListener("abort", abort, { once: true });
    if (c.spec.signal?.aborted) abort();
    const lookup: NeverLookup | undefined = deps.lookup ? host => deps.lookup!(host, signal) : undefined;
    const publicPolicy = createNeverProxyPolicy(c.policy, { signal, lookup, now: deps.now });
    let proxy: Awaited<ReturnType<typeof openTurnProxy>> | undefined;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      abort(); c.spec.signal?.removeEventListener("abort", abort);
      await proxy?.close();
    })();
    try {
      await publicPolicy.refresh();
      proxy = await (deps.open ?? openTurnProxy)({ mode: "public", allow: [],
        listen: { port: c.proxyPort, ipv4Only: true },
        publicPolicy,
      });
      signal.throwIfAborted();
      const url = `http://127.0.0.1:${proxy.port}`;
      return { network, executorEnv: { HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url,
        http_proxy: url, https_proxy: url, all_proxy: url, NO_PROXY: "", no_proxy: "" }, close };
    } catch (e) { await close(); throw e; }
  } };
}

const builtin = createMediatedNetworkProvider();
let provider: MediatedNetworkProvider | undefined = builtin;
export const mediatedNetworkProvider = (): MediatedNetworkProvider | undefined => provider;
/** Code-only fixture seam, like the executor dependency seam. No environment/config override. */
export function setMediatedNetworkProviderForTests(value: MediatedNetworkProvider | undefined | null): void { provider = value === null ? builtin : value; }

export function mediatedNetworkProblem(context: MediatedNetworkContext): string | null {
  if (context.policy.hosts.length && context.capabilities.some(c => c.kind === "localhost" && c.operation === "connect")) return "localhost connect is unavailable with never.hosts: the direct IPv4 allowance cannot screen forbidden DNS endpoints";
  if (!needsMediatedNetwork(context.capabilities, context.baseline, context.policy)) return null;
  const selected = mediatedNetworkProvider();
  return selected ? selected.qualify(context) : NO_MEDIATED_PROVIDER;
}
