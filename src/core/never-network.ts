import net from "node:net";
import { neverEndpointProblem, type NeverEndpoint, type NeverPolicy } from "./never-policy.js";
import { normalizeNeverHost } from "./never-schema.js";

export interface NeverEndpointSet { policyHash: string; expiresAt: number; addresses: string[]; cnames: string[] }
export type NeverLookup = (host: string) => Promise<{ addresses: string[]; cnames: string[] }>;
/** Provider-owned DNS, never a model-supplied DNS snapshot. Refresh before new connections. */
export async function resolveNeverEndpoints(policy: NeverPolicy, lookup: NeverLookup, o: { now?: number; ttlMs?: number } = {}): Promise<NeverEndpointSet> {
  const ttl = o.ttlMs ?? 30_000;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("never endpoint TTL must be finite and positive");
  const addresses = new Set<string>(), cnames = new Set<string>();
  for (const h of policy.hosts) {
    if (net.isIP(h.host)) { addresses.add(h.host); continue; }
    const found = await lookup(h.host);
    if (!found.addresses.length) throw new Error(`never cannot resolve required authority ${h.host}; mediated provider unavailable`);
    for (const address of found.addresses) {
      const a = normalizeNeverHost(address);
      if (!net.isIP(a)) throw new Error(`never resolver returned a nonnumeric endpoint for ${h.host}`);
      addresses.add(a);
    }
    for (const name of found.cnames) cnames.add(normalizeNeverHost(name));
  }
  return { policyHash: policy.hash, expiresAt: (o.now ?? Date.now()) + ttl, addresses: [...addresses].sort(), cnames: [...cnames].sort() };
}

/** Screen the requested authority AND all checked numeric endpoints, then dial only those. */
export function neverConnectionProblem(policy: NeverPolicy, endpoint: NeverEndpoint, checked?: NeverEndpointSet, now = Date.now()): string | null {
  const direct = neverEndpointProblem(policy, endpoint);
  if (direct) return direct;
  if (policy.hosts.length) {
    if (!checked || checked.policyHash !== policy.hash || checked.expiresAt <= now) return "never requires a fresh validated forbidden endpoint set before a mediated connection";
    const host = normalizeNeverHost(endpoint.host);
    if ([host, ...(endpoint.cnames ?? []).map(normalizeNeverHost)].some(h => checked.cnames.includes(h))) return `never refuses forbidden CNAME authority ${host}`;
    const ips = [...(net.isIP(host) ? [host] : []), ...(endpoint.addresses ?? [])].map(normalizeNeverHost);
    if (ips.some(ip => checked.addresses.includes(ip))) return `never refuses an endpoint alias of a forbidden authority (${host})`;
  }
  if (!net.isIP(normalizeNeverHost(endpoint.host)) && !endpoint.addresses?.length) return "never requires checked numeric endpoints; an independent later DNS lookup is not allowed";
  if ((endpoint.addresses ?? []).some(a => !net.isIP(normalizeNeverHost(a)))) return "never connection endpoints must be numeric";
  return null;
}
