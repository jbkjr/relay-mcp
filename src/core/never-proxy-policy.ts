/** Shared authority and endpoint screen for per-turn TCP proxies. */
import type { NeverPolicy } from "./never-policy.js";
import { neverEndpointProblem, neverPortProblem } from "./never-policy.js";
import { neverConnectionProblem, resolveNeverEndpoints, type NeverLookup } from "./never-network.js";
import { normalizeNeverHost } from "./never-schema.js";
import { Resolver } from "node:dns/promises";
import dns from "node:dns";
import net from "node:net";

/** The public proxy's existing DNS-name rule, including underscore labels. */
const NAME_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
export const proxyHostName = (h: string): boolean => h.length > 0 && h.length <= 253 && h.split(".").every(l => NAME_LABEL.test(l));

/** Shared authority syntax check; callers retain their own policy and DNS check ordering. */
export function checkProxyHost(host: string): void {
  if (!net.isIP(host) && !proxyHostName(host)) throw Object.assign(new Error("not a host name"), { reason: "bad-host" });
}

/** Cancellable worker-owned DNS. Follow the full CNAME chain and fail on ambiguous DNS errors. */
export async function mediatedLookup(host: string, signal: AbortSignal): ReturnType<NeverLookup> {
  signal.throwIfAborted();
  const resolver = new Resolver({ timeout: 1500, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const cnames: string[] = [], seen = new Set<string>();
  const optional = async <T>(p: Promise<T[]>): Promise<T[]> => {
    try { return await p; } catch (e) {
      if (["ENODATA", "ENOTFOUND"].includes((e as NodeJS.ErrnoException).code ?? "")) return [];
      throw e;
    }
  };
  try {
    let name = normalizeNeverHost(host);
    while (!net.isIP(name)) {
      signal.throwIfAborted();
      if (seen.has(name) || seen.size >= 16) throw new Error("mediated DNS CNAME loop or excessive chain");
      seen.add(name);
      const aliases = await optional(resolver.resolveCname(name));
      if (!aliases.length) break;
      if (aliases.length !== 1) throw new Error("mediated DNS returned ambiguous CNAMEs");
      name = normalizeNeverHost(aliases[0]); cnames.push(name);
    }
    const addresses = net.isIP(name) ? [name] : (await Promise.all([
      optional(resolver.resolve4(name)), optional(resolver.resolve6(name)),
    ])).flat();
    signal.throwIfAborted();
    if (!addresses.length) throw new Error(`mediated DNS has no numeric endpoint for ${host}`);
    return { addresses, cnames };
  } finally { signal.removeEventListener("abort", cancel); resolver.cancel(); }
}

/** Re-resolve before every request, retaining forbidden endpoints for the whole turn.
 * A failed refresh never falls back to the last set. The same screen serves every proxy mode. */
export function createNeverProxyPolicy(policy: NeverPolicy, deps: {
  signal: AbortSignal;
  lookup?: NeverLookup;
  now?: () => number;
}) {
  const { signal } = deps;
  // Without forbidden hosts, use the OS resolver: /etc/hosts and scoped/VPN DNS must keep
  // working. Only a host floor needs the direct resolver's full CNAME traversal.
  const lookup: NeverLookup = deps.lookup ?? (policy.hosts.length ? host => mediatedLookup(host, signal)
    : async host => ({ addresses: (await dns.promises.lookup(host, { all: true, verbatim: true })).map(a => a.address), cnames: [] }));
  const now = deps.now ?? Date.now;
  const addresses = new Set<string>(), cnames = new Set<string>();
  const refresh = async () => {
    signal.throwIfAborted();
    const checked = await resolveNeverEndpoints(policy, lookup, { now: now() });
    signal.throwIfAborted();
    checked.addresses.forEach(a => addresses.add(a)); checked.cnames.forEach(n => cnames.add(n));
    return { ...checked, addresses: [...addresses], cnames: [...cnames] };
  };
  return { refresh, async resolve(host: string, port: number): Promise<string[]> {
    signal.throwIfAborted();
    if (!policy.hosts.length) {
      const literal = net.isIP(host) !== 0;
      checkProxyHost(host);
      const authority = literal ? normalizeNeverHost(host) : host;
      const direct = neverPortProblem(policy, { host: authority, port, transport: "tcp" });
      if (direct) throw new Error(direct);
      const found = literal ? [host] : (await lookup(host)).addresses;
      signal.throwIfAborted();
      const numeric = found.map(normalizeNeverHost);
      if (numeric.some(a => !net.isIP(a))) throw new Error("never connection endpoints must be numeric");
      const why = neverPortProblem(policy, { host: authority, port, transport: "tcp", addresses: numeric });
      if (why) throw new Error(why);
      return found;
    }
    const direct = neverEndpointProblem(policy, { host, port, transport: "tcp" });
    if (direct) throw new Error(direct);
    const checked = await refresh();
    const canonical = normalizeNeverHost(host);
    const found = net.isIP(canonical) ? { addresses: [canonical], cnames: [] } : await lookup(canonical);
    signal.throwIfAborted();
    const why = neverConnectionProblem(policy, { host: canonical, port, transport: "tcp", ...found },
      { ...checked, addresses: [...addresses], cnames: [...cnames] }, now());
    if (why) throw new Error(why);
    return found.addresses.map(normalizeNeverHost);
  } };
}
