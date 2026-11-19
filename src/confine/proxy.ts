import crypto from "node:crypto";
import dns from "node:dns";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import net from "node:net";
import os from "node:os";
import { appendLog, logMaxBytes } from "../core/storage.js";
import { checkProxyHost, createNeverProxyPolicy, mediatedLookup, proxyHostName as hostName } from "../core/never-proxy-policy.js";
import { neverEndpointProblem } from "../core/never-policy.js";

// Taken as the CommonJS builtin, not imported: the registry reaches this module (for its address
// helpers), and Node's ES-module wrapper of node:http reads every lazy export as it is imported,
// which compiles its fetch implementation (undici) too: about 9 ms of every relay process's start.
const http = process.getBuiltinModule("node:http");

/**
 * The per-turn proxy, in one of two modes.
 *
 * "allowlist" (the default), for a confined turn with the network off. The sandbox lets the harness
 * reach exactly this proxy's loopback port and nothing else on the network, DNS included; the proxy
 * tunnels HTTPS (CONNECT to port 443) to the exact host names it was given, resolving them itself,
 * and to nothing else: no IP literals, no private, loopback or link-local addresses, no plain HTTP.
 * Every CONNECT must carry the turn's token, so a loopback port that any local process can reach
 * still serves only this turn.
 *
 * "public", for a Claude turn with the network: Claude Code's sandbox sends every connection its
 * commands make here (sandbox.network.httpProxyPort and socksProxyPort), and the Claude process
 * itself comes here through HTTPS_PROXY (its WebFetch and its model traffic). It reaches any public
 * host on any port, by CONNECT, plain-HTTP forwarding or SOCKS5 CONNECT, and nothing that is not
 * public: no loopback, private, shared (CGNAT, Tailscale), link-local, unique-local or metadata
 * address, none of this machine's own addresses and nothing on the same link as them. Names are
 * resolved once, here, and the screened address is what is dialled, so a name cannot be rebound
 * between the check and the connection.
 *
 * Each decision is a JSON line in the turn's log. Ported from
 * docs/research/seatbelt-prototype/proxy.ts. Zero dependencies.
 */

/** The only port tunnelled in allowlist mode. Model APIs are HTTPS. */
export const PROXY_PORT_ALLOWED = 443;
/** How long the upstream connect may take before the client gets 502. */
const CONNECT_TIMEOUT_MS = 15000;
/** How long a client of the public mode has to say what it wants before it is dropped. */
const HANDSHAKE_TIMEOUT_MS = 30000;

export interface ProxyDecision {
  t: string;
  /** Whatever the caller labels the turn with (for example its job and turn ids). */
  turn?: string;
  event: "allow" | "deny" | "upstream-error";
  reason?: string;
  /** The CONNECT target as the client sent it, or the request line for anything else. In public mode, `host:port` (no path). */
  target: string;
  /** The address the proxy connected to, for allowed tunnels. */
  address?: string;
  /** Public mode: how the client asked (CONNECT, plain HTTP with its method, or SOCKS5). */
  via?: string;
  /** Public mode: whether the request carried the turn's token (the harness process) or none (its sandbox). */
  token?: boolean;
  /** Public mode, development only: the request went to the model stub (ProxyOptions.modelStub). */
  stub?: true;
}

export interface ProxyOptions {
  /** Shared cumulative floor; screened here when no trusted publicPolicy is supplied. */
  neverPolicy?: import("../core/never-policy.js").NeverPolicy;
  /** "allowlist" (default) or "public"; see above. */
  mode?: "allowlist" | "public";
  /** Allowlist mode: exact host names the turn may reach on port 443, the target's API hosts and any the root session granted. Empty in public mode. */
  allow: string[];
  /** Trusted provider: screen authority and numeric endpoints before any dial. */
  publicPolicy?: { resolve(host: string, port: number): Promise<string[]> };
  /** Leased stage-2 listener; other callers retain dual loopback. */
  listen?: { port: number; ipv4Only: true };
  /** The turn's log. Decisions are appended to it as JSON lines; the token is never written. */
  logFile?: string;
  /** Written into every decision. */
  label?: string;
  /** Told every decision as it is made (after it is logged), for the turn's own log. Must not throw. */
  onDecision?: (d: ProxyDecision) => void;
  /**
   * Tests only. `resolve`: replaces DNS resolution of a name together with its public-address
   * check, with `upstreamPort` the port connected to, so a test can tunnel to a local server under a
   * name. `lookup`: replaces DNS alone, the checks still applied. `local` and `subnets`: this
   * machine's addresses and on-link subnets as the checks see them.
   */
  testing?: { resolve?(host: string): Promise<string[]>; upstreamPort?: number; lookup?(host: string): Promise<string[]>; local?: Set<string>; subnets?: string[] };
  /**
   * Public mode, development only (relay's smoke probe and tests, behind RELAY_DEV_MODEL_STUB): plain
   * HTTP requests (absolute-form) carrying the turn's token for exactly this host go to
   * 127.0.0.1:port, where a stub model listens. CONNECT and SOCKS to the host, and every request
   * without the token (the sandbox's), are as without it: so `api.anthropic.com` can be the stub's
   * name for the model requests (sent to http://api.anthropic.com) while Claude's other requests to
   * it go to Anthropic as usual.
   */
  modelStub?: { host: string; port: number };
}

export interface TurnProxy {
  port: number;
  /** The turn's Proxy-Authorization password. */
  token: string;
  /** What the confinement policy needs for this turn: `network` for `ConfinementPolicy`. */
  network: { mode: "off-except-proxy"; proxyPort: number; proxyToken: string };
  /** Whether a request carrying the turn's token has arrived: in public mode, that the harness process itself uses the proxy. */
  authenticated(): boolean;
  /** The hosts (lower case, no port) that requests carrying the turn's token have named, so far. */
  tokenHosts(): ReadonlySet<string>;
  /** Stops listening and drops every tunnel. Call it when the turn ends. */
  close(): Promise<void>;
}

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A host name relay will put on an allowlist: lower case, no trailing dot, no IP literal, no wildcard. */
export function allowlistHost(h: string): string {
  if (typeof h !== "string") throw new Error(`allowlisted host is not a string: ${String(h)}`);
  const host = h.trim().toLowerCase().replace(/\.$/, "");
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) throw new Error(`an IP literal cannot be allowlisted, only a host name: ${h}`);
  if (host.length > 253 || !host.split(".").every((l) => HOST_LABEL.test(l))) throw new Error(`not a host name: ${JSON.stringify(h)}`);
  return host;
}

/** Addresses the proxy never connects to: unspecified, loopback, private, shared, link-local, multicast, reserved and documentation ranges. */
const BLOCKED = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  // Cloud-platform metadata endpoints in otherwise-public ranges (srt resolved-address-guard): Azure's
  // WireServer/IMDS 168.63.129.16, which is not in any private range. (Most metadata IPs — AWS/GCP/Oracle
  // 169.254.169.254, Alibaba 100.100.100.200 — already fall under link-local or the shared 100.64/10 range.)
  ["168.63.129.16", 32],
] as const) BLOCKED.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(a, p, "ipv6");

/** The addresses of this machine's own network interfaces, loopback included, in canonical form. */
export function localInterfaceAddresses(): Set<string> {
  const out = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) out.add(canonicalAddress(a.address));
  }
  return out;
}

/**
 * An address in one canonical form, so two spellings of the same address compare equal: the zone id
 * is dropped; an IPv4-mapped or -compatible IPv6 address (`::ffff:1.2.3.4`, the hex `::ffff:0102:0304`,
 * `::1.2.3.4`) becomes the dotted IPv4 it carries; any other IPv6 is expanded to its eight zero-padded
 * groups. So the machine's own `93.184.216.34` matches a name that resolves to `::ffff:93.184.216.34`.
 */
export function canonicalAddress(ip: string): string {
  const a = ip.split("%")[0].toLowerCase();
  const v4 = /^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/.exec(a)?.[1];
  if (v4) return v4;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return net.isIPv6(a) ? expandIPv6(a) : a;
}

/** An IPv6 address as eight colon-separated four-hex-digit groups (so compressed and full forms compare equal). */
function expandIPv6(ip: string): string {
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const gap = tail !== undefined ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(gap, 0)).fill("0"), ...right];
  return groups.map((g) => (g || "0").padStart(4, "0")).join(":");
}

/**
 * The subnets this machine's network interfaces are on, as `address/prefix` (os.networkInterfaces()
 * cidr), read afresh on every call: a laptop changes networks in the middle of a turn. A device on
 * the same link (a printer, a NAS, the router) is the person's own network even when its address
 * is a public one, as a LAN's global IPv6 addresses are.
 */
export function localSubnets(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.cidr) out.push(a.cidr);
  }
  return out;
}

/** Whether `ip` lies in one of `subnets` (`address/prefix`, the interface's own address allowed in place of the network's). */
export function onLink(ip: string, subnets: readonly string[]): boolean {
  const list = new net.BlockList();
  for (const cidr of subnets) {
    const at = cidr.lastIndexOf("/");
    const addr = cidr.slice(0, at).split("%")[0];
    const prefix = Number(cidr.slice(at + 1));
    const kind = net.isIP(addr);
    if (at < 0 || !kind || !Number.isInteger(prefix)) continue;
    // An IPv4-mapped interface address is judged by the IPv4 address it carries, like a destination.
    const v4 = kind === 6 ? canonicalAddress(addr) : addr;
    try {
      if (net.isIPv4(v4)) list.addSubnet(v4, kind === 6 ? Math.max(prefix - 96, 0) : prefix, "ipv4");
      else list.addSubnet(addr, prefix, "ipv6");
    } catch {}
  }
  const a = canonicalAddress(ip);
  const kind = net.isIP(a);
  return kind === 4 ? list.check(a, "ipv4") : kind === 6 ? list.check(a, "ipv6") : false;
}

/**
 * Screens the addresses a name resolved to (or an IP literal, given alone). A name on the allowlist
 * that resolves to anything but a public unicast address — a private, loopback or link-local
 * address, cloud-metadata endpoints (169.254.169.254 and the IPv6 metadata addresses are link-local
 * or unique-local, so already caught), an address bound to one of this machine's own interfaces (its
 * own public IP, which would otherwise pass), or an address on the same link as one of them (a LAN
 * device's global IPv6 address) — is never meant, and one such answer refuses the whole name. (srt
 * resolved-address-guard.ts: the reasoning is theirs; the on-link check is relay's.) Returns the
 * public addresses to try, or the reason to refuse.
 */
export function screenAddresses(addresses: string[], local: Set<string> = localInterfaceAddresses(), subnets: readonly string[] = localSubnets()): { addresses: string[] } | { reason: string; address: string } {
  for (const a of addresses) {
    if (!publicAddress(a)) return { reason: "private-address", address: a };
    if (local.has(canonicalAddress(a))) return { reason: "local-interface-address", address: a };
    if (onLink(a, subnets)) return { reason: "on-link-address", address: a };
  }
  return { addresses };
}

/** Whether an address is one the proxy may connect to: a public unicast address. */
export function publicAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return !BLOCKED.check(ip, "ipv4");
  if (kind !== 6) return false;
  // IPv4-mapped and -compatible forms are judged by the IPv4 address they carry.
  const v4 = /^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (v4) return publicAddress(v4);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return publicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !BLOCKED.check(ip, "ipv6");
}

/** The environment that points a harness at the turn's proxy. Both cases, as tools differ; Node needs NODE_USE_ENV_PROXY. */
export function proxyEnv(port: number, token: string): Record<string, string> {
  const url = `http://relay:${token}@127.0.0.1:${port}`;
  const env: Record<string, string> = { NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "1" };
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) env[k] = env[k.toLowerCase()] = url;
  return env;
}

/** A per-turn token: URL-safe, so it can sit in a proxy URL as is. */
export const PROXY_TOKEN = /^[A-Za-z0-9_-]{22,}$/;

function authorised(req: IncomingMessage, token: string): boolean {
  const h = req.headers["proxy-authorization"];
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(typeof h === "string" ? h : "");
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const pass = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
  const want = Buffer.from(token);
  return decoded.includes(":") && pass.length === want.length && crypto.timingSafeEqual(pass, want);
}

/** CONNECT's target: `host:port` or `[v6]:port`. */
function parseTarget(target: string): { host: string; port: number } | null {
  const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:[\]\s]+)):(\d{1,5})$/.exec(target);
  if (!m) return null;
  const port = Number(m[3]);
  return port >= 1 && port <= 65535 ? { host: (m[1] ?? m[2]).toLowerCase().replace(/\.$/, ""), port } : null;
}

/** Appends a decision to the turn's log and tells the caller. */
function decisionLog(opts: ProxyOptions, maxBytes: number | null) {
  return (d: Omit<ProxyDecision, "t" | "turn">) => {
    const decision: ProxyDecision = { t: new Date().toISOString(), ...(opts.label ? { turn: opts.label } : {}), ...d };
    // A log that cannot be written must not take the turn's network down with it.
    try {
      if (opts.logFile) appendLog(opts.logFile, JSON.stringify(decision) + "\n", { maxBytes });
    } catch {}
    try {
      opts.onDecision?.(decision);
    } catch {}
  };
}

/** Starts the proxy for one turn on 127.0.0.1 at an ephemeral port (public mode: on ::1 too), with a fresh token. */
export async function openProxy(opts: ProxyOptions): Promise<TurnProxy> {
  if (!opts.neverPolicy || opts.publicPolicy) return openScreenedProxy(opts);
  const controller = new AbortController();
  const signal = controller.signal;
  const stub = opts.mode === "public" ? opts.modelStub : undefined;
  const publicPolicy = createNeverProxyPolicy(opts.neverPolicy, { signal,
    ...(stub ? { lookup: async (host: string) => host === stub.host
      ? { addresses: ["127.0.0.1"], cnames: [] }
      : opts.neverPolicy!.hosts.length ? mediatedLookup(host, signal)
      : { addresses: (await dns.promises.lookup(host, { all: true, verbatim: true })).map(a => a.address), cnames: [] } } : {}),
  });
  try {
    await publicPolicy.refresh();
    const proxy = await openScreenedProxy({ ...opts, publicPolicy });
    return { ...proxy, close: async () => { controller.abort(new Error("proxy closed")); await proxy.close(); } };
  } catch (e) { controller.abort(); throw e; }
}

async function openScreenedProxy(opts: ProxyOptions): Promise<TurnProxy> {
  if (opts.mode === "public") return openPublicProxy(opts);
  // Like an agent log, this proxy keeps the policy its turn started with. Reopen at each entry
  // (appendLog), so a rotation never leaves a descriptor appending into the renamed generation.
  const maxBytes = logMaxBytes();
  const allow = new Set(opts.allow.map(allowlistHost));
  const token = crypto.randomBytes(24).toString("base64url");
  const sockets = new Set<net.Socket>();
  /** Set by close(): from then on nothing new is opened, lookups still pending included. */
  let closed = false;
  const log = decisionLog(opts, maxBytes);
  let sawToken = false;
  const hostsWithToken = new Set<string>();
  const resolve = async (host: string, port: number) => {
    if (!opts.publicPolicy && opts.testing?.resolve) return opts.testing.resolve(host);
    const found = opts.publicPolicy ? await opts.publicPolicy.resolve(host, port)
      : (await dns.promises.lookup(host, { all: true, verbatim: true })).map(a => a.address);
    const screened = screenAddresses(found, opts.testing?.local, opts.testing?.subnets);
    if ("reason" in screened) throw Object.assign(new Error(`resolves to ${screened.reason === "local-interface-address" ? "this machine's own address" : "a non-public address"} (${screened.address})`), { reason: screened.reason });
    return screened.addresses;
  };
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  };

  const server = http.createServer((req, res) => {
    // Plain-HTTP forwarding is not offered: it would need its own allowlist and header handling.
    log({ event: "deny", reason: "not-connect", target: `${req.method} ${req.url}` });
    res.writeHead(405, { "content-type": "text/plain", connection: "close" }).end("relay proxy: only CONNECT to port 443 is supported\n");
  });
  server.on("connection", track);
  server.on("clientError", (_err, sock) => sock.destroy());

  server.on("connect", (req: IncomingMessage, client: net.Socket, head: Buffer) => {
    const target = req.url ?? "";
    client.on("error", () => {});
    if (closed) return void client.destroy();
    const refuse = (code: number, reason: string) => {
      log({ event: "deny", reason, target });
      const challenge = code === 407 ? 'Proxy-Authenticate: Basic realm="relay"\r\n' : "";
      client.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nProxy-Agent: relay\r\n${challenge}Connection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!authorised(req, token)) return refuse(407, "bad-or-missing-token");
    sawToken = true;
    const t = parseTarget(target);
    if (t) hostsWithToken.add(t.host);
    if (!t) return refuse(400, "bad-target");
    if (net.isIP(t.host)) return refuse(403, "ip-literal");
    if (t.port !== PROXY_PORT_ALLOWED) return refuse(403, "port-not-443");
    if (!allow.has(t.host)) return refuse(403, "host-not-allowlisted");
    client.pause();
    resolve(t.host, t.port).then(
      (addresses) => {
        // The proxy closed, or the client left, while the name was being looked up: open nothing.
        if (closed || client.destroyed) return void client.destroy();
        if (!addresses.length) return refuse(502, "no-address");
        const port = opts.testing?.upstreamPort ?? t.port;
        const badGateway = () => client.end("HTTP/1.1 502 Bad Gateway\r\nProxy-Agent: relay\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        let connected = false;
        let current: net.Socket | null = null;
        // The resolved addresses in turn: the first that connects carries the tunnel; if one fails to
        // connect, the next is tried, so a name with a dead address still reaches a live one.
        const tryAt = (i: number) => {
          if (closed || client.destroyed) return void client.destroy();
          if (i >= addresses.length) return void badGateway();
          const address = addresses[i];
          const upstream = net.connect({ host: address, port });
          current = upstream;
          track(upstream);
          upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error("connect timed out")));
          upstream.once("connect", () => {
            if (closed || client.destroyed) return void upstream.destroy();
            connected = true;
            upstream.setTimeout(0);
            log({ event: "allow", target, address });
            client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: relay\r\n\r\n");
            if (head.length) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
            client.resume();
          });
          upstream.on("error", (e) => {
            if (connected) return void client.destroy();
            log({ event: "upstream-error", reason: e.message, target, address });
            tryAt(i + 1);
          });
        };
        client.on("close", () => current?.destroy());
        tryAt(0);
      },
      (err: Error & { reason?: string }) => refuse(403, err.reason ?? `unresolved: ${err.message}`),
    );
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      ok();
    });
  });
  server.on("error", () => {});
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    token,
    network: { mode: "off-except-proxy", proxyPort: port, proxyToken: token },
    authenticated: () => sawToken,
    tokenHosts: () => hostsWithToken,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

/** Headers that belong to one connection, not to the request or response carried on it (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = String(headers.connection ?? "").toLowerCase().split(",").map((h) => h.trim()).filter(Boolean);
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP_BY_HOP.has(k) && !named.includes(k)) out[k] = v;
  out.connection = "close";
  return out;
}

/** What a public-mode refusal tells the client, by reason. */
const REFUSED = "relay: a job's network reaches public addresses only, not loopback, private, link-local or this machine's own network";

/**
 * The public mode (see the top of this file). The token is optional here, by design: Claude Code's
 * sandbox hands its commands a proxy URL with no credentials when the proxy is external
 * (sandbox.network.httpProxyPort), so the sandbox's connections arrive without it. That gives a
 * caller without the token nothing it lacks anyway: the proxy reaches public addresses only, which
 * any process of the person's can reach directly, and other jobs' sandboxes cannot reach this port
 * (each sandbox allows only its own proxy's). The token marks the harness process's own requests
 * (authenticated()), which is how relay knows the harness uses the proxy at all.
 */
async function openPublicProxy(opts: ProxyOptions): Promise<TurnProxy> {
  if (opts.allow.length) throw new Error("the public proxy takes no allowlist");
  const stub = opts.modelStub;
  if (stub && (!hostName(stub.host) || !Number.isInteger(stub.port) || stub.port < 1 || stub.port > 65535)) throw new Error("a model stub is a host name and a port");
  const log = decisionLog(opts, logMaxBytes());
  const token = crypto.randomBytes(24).toString("base64url");
  const sockets = new Set<net.Socket>();
  let closed = false;
  let sawToken = false;
  const hostsWithToken = new Set<string>();
  /** A request carrying the token, for `host`: counted, and its host kept (tokenHosts). */
  const tokened = (host: string) => {
    sawToken = true;
    hostsWithToken.add(host);
  };
  const t = opts.testing;
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  };

  /** The addresses `host` (a name or an IP literal) may be dialled at, or a thrown error with the reason. */
  const screen = async (host: string, port: number, toStub = false): Promise<string[]> => {
    if (closed) throw new Error("proxy closed");
    // The authenticated development mapping is the endpoint, so its synthetic name need
    // not exist in DNS. Retain the floor for both the named authority and the actual dial.
    if (toStub) {
      if (opts.neverPolicy) {
        const why = neverEndpointProblem(opts.neverPolicy, { host, port, transport: "tcp", addresses: ["127.0.0.1"] })
          ?? neverEndpointProblem(opts.neverPolicy, { host: "127.0.0.1", port: stub!.port, transport: "tcp" });
        if (why) throw Object.assign(new Error(why), { reason: why });
      }
      // Include resolved aliases of forbidden hosts at the mapped destination too.
      if (opts.publicPolicy) await opts.publicPolicy.resolve(host, stub!.port);
      return ["127.0.0.1"];
    }
    const checked = opts.publicPolicy ? await opts.publicPolicy.resolve(host, port) : undefined;
    const literal = net.isIP(host) !== 0;
    if (!checked && !literal && t?.resolve) return t.resolve(host);
    checkProxyHost(host);
    let found: string[];
    try {
      found = checked ?? (literal ? [host] : t?.lookup ? await t.lookup(host) : (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address));
    } catch (e) {
      throw Object.assign(new Error((e as Error).message), { reason: `unresolved: ${(e as NodeJS.ErrnoException).code ?? "error"}` });
    }
    const screened = screenAddresses(found, t?.local ?? localInterfaceAddresses(), t?.subnets ?? localSubnets());
    if ("reason" in screened) throw Object.assign(new Error(screened.reason), { reason: screened.reason });
    if (!screened.addresses.length) throw Object.assign(new Error("no address"), { reason: "no-address" });
    return screened.addresses;
  };
  const reasonOf = (e: unknown) => (e as { reason?: string }).reason ?? "refused";

  /** Connects to the first of `addresses` that answers on `port`, logging each that does not; null when none did or the proxy closed. */
  const dial = (addresses: string[], port: number, d: Pick<ProxyDecision, "target" | "via" | "token" | "stub">) =>
    new Promise<{ socket: net.Socket; address: string } | null>((done) => {
      const at = (i: number) => {
        if (closed || i >= addresses.length) return done(null);
        const address = addresses[i];
        const up = net.connect({ host: address, port: d.stub ? stub!.port : t?.upstreamPort ?? port });
        track(up);
        up.setTimeout(CONNECT_TIMEOUT_MS, () => up.destroy(new Error("connect timed out")));
        let settled = false;
        up.once("close", () => { if (!settled) done(null); });
        const failed = (e: Error) => {
          settled = true;
          log({ event: "upstream-error", reason: e.message, ...d, address });
          at(i + 1);
        };
        up.once("error", failed);
        up.once("connect", () => {
          settled = true;
          up.off("error", failed);
          up.on("error", () => {});
          up.setTimeout(0);
          if (closed) return void (up.destroy(), done(null));
          done({ socket: up, address });
        });
      };
      at(0);
    });

  /** Joins a client and an upstream socket both ways; either closing closes the other. */
  const join = (client: net.Socket, up: net.Socket, head?: Buffer) => {
    if (head?.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
    client.on("close", () => up.destroy());
    up.on("close", () => client.destroy());
    client.resume();
  };

  const server = http.createServer(async (req, res) => {
    const withToken = authorised(req, token);
    if (withToken) sawToken = true;
    req.on("error", () => {});
    let u: URL | null = null;
    try {
      u = new URL(req.url ?? "");
    } catch {}
    // Absolute-form plain HTTP only: what a client sends a proxy. Its path is never logged.
    if (!u || u.protocol !== "http:" || !u.hostname) {
      log({ event: "deny", reason: "not-absolute-http", target: `${req.method} ${(req.url ?? "").slice(0, 40)}`, via: req.method, token: withToken });
      return void res.writeHead(400, { "content-type": "text/plain", connection: "close" }).end("relay proxy: send an absolute http:// URL, or CONNECT\n");
    }
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    const port = Number(u.port || 80);
    // Host must select the same service as the screened absolute request-target.
    let header: URL | undefined;
    try { header = req.headers.host ? new URL(`http://${req.headers.host}`) : undefined; } catch {}
    if (u.username || u.password || (req.headers.host && (!header || header.host.toLowerCase() !== u.host.toLowerCase()))) {
      log({ event: "deny", reason: "authority-disagreement", target: u.host, via: req.method, token: withToken });
      return void res.writeHead(400, { connection: "close" }).end("relay proxy: Host and request-target disagree\n");
    }
    if (withToken) tokened(host);
    const toStub = Boolean(stub && withToken && host === stub.host);
    const d = { target: `${net.isIPv6(host) ? `[${host}]` : host}:${port}`, via: req.method, token: withToken, ...(toStub ? { stub: true as const } : {}) };
    req.pause();
    let addresses: string[];
    try {
      addresses = await screen(host, port, toStub);
    } catch (e) {
      log({ event: "deny", reason: reasonOf(e), ...d });
      return void res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end(`${REFUSED} (${host}: ${reasonOf(e)})\n`);
    }
    const up = await dial(addresses, port, d);
    if (!up) return void (res.headersSent ? res.destroy() : res.writeHead(502, { connection: "close" }).end());
    log({ event: "allow", ...d, address: up.address });
    const headers = endToEnd(req.headers);
    headers.host = u.host;
    const out = http.request({ createConnection: () => up.socket, method: req.method, path: u.pathname + u.search, headers });
    out.on("response", (r) => {
      res.writeHead(r.statusCode ?? 502, r.statusMessage, endToEnd(r.headers));
      r.pipe(res);
    });
    out.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502, { connection: "close" }).end()));
    res.on("close", () => up.socket.destroy());
    req.pipe(out);
    req.resume();
  });
  server.on("clientError", (_err, sock) => sock.destroy());
  server.on("connect", async (req: IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on("error", () => {});
    if (closed) return void client.destroy();
    const target = req.url ?? "";
    const withToken = authorised(req, token);
    if (withToken) sawToken = true;
    const p0 = parseTarget(target);
    if (withToken && p0) tokened(p0.host);
    const d = { target, via: "CONNECT", token: withToken };
    const refuse = (code: number, reason: string) => {
      log({ event: "deny", reason, ...d });
      client.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nProxy-Agent: relay\r\nX-Relay-Refused: ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const p = p0;
    if (!p) return refuse(400, "bad-target");
    client.pause();
    let addresses: string[];
    try {
      addresses = await screen(p.host, p.port);
    } catch (e) {
      return refuse(403, reasonOf(e));
    }
    if (closed || client.destroyed) return void client.destroy();
    const up = await dial(addresses, p.port, d);
    if (!up) return void (closed || client.destroyed ? client.destroy() : client.end("HTTP/1.1 502 Bad Gateway\r\nProxy-Agent: relay\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
    if (client.destroyed) return void up.socket.destroy();
    log({ event: "allow", ...d, address: up.address });
    client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: relay\r\n\r\n");
    join(client, up.socket, head);
  });

  /**
   * SOCKS5 (RFC 1928), CONNECT only: what Claude Code's sandbox gives non-HTTP tools (git over ssh
   * through `nc -X 5`). No authentication is asked for; user and password (RFC 1929) are accepted
   * when a client offers only that, the password counting as the token.
   */
  const socks = (c: net.Socket, first: Buffer) => {
    let buf = first;
    let stage: "greet" | "auth" | "request" | "done" = "greet";
    let withToken = false;
    const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
    const step = () => {
      if (stage === "greet") {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        if (buf[0] !== 5) return void c.destroy();
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (methods.includes(0)) stage = "request";
        else if (methods.includes(2)) stage = "auth";
        else return void ((stage = "done"), c.end(Buffer.from([5, 0xff])));
        c.write(Buffer.from([5, stage === "auth" ? 2 : 0]));
      }
      if (stage === "auth") {
        if (buf.length < 2 || buf.length < 3 + buf[1] || buf.length < 3 + buf[1] + buf[2 + buf[1]]) return;
        const ul = buf[1];
        const pass = buf.subarray(3 + ul, 3 + ul + buf[2 + ul]);
        buf = buf.subarray(3 + ul + buf[2 + ul]);
        const want = Buffer.from(token);
        withToken = pass.length === want.length && crypto.timingSafeEqual(pass, want);
        if (withToken) sawToken = true;
        c.write(Buffer.from([1, 0]));
        stage = "request";
      }
      if (stage === "request") {
        if (buf.length < 5) return;
        if (buf[0] !== 5) return void c.destroy();
        const [, cmd, , atyp] = buf;
        let host: string;
        let off: number;
        if (atyp === 1) {
          if (buf.length < 10) return;
          host = [...buf.subarray(4, 8)].join(".");
          off = 8;
        } else if (atyp === 3) {
          if (buf.length < 5 + buf[4] + 2) return;
          host = buf.subarray(5, 5 + buf[4]).toString("latin1").toLowerCase().replace(/\.$/, "");
          off = 5 + buf[4];
        } else if (atyp === 4) {
          if (buf.length < 22) return;
          host = Array.from({ length: 8 }, (_, i) => buf.readUInt16BE(4 + 2 * i).toString(16)).join(":");
          off = 20;
        } else {
          stage = "done";
          log({ event: "deny", reason: "bad-address-type", target: "?", via: "SOCKS5", token: withToken });
          return void c.end(reply(8));
        }
        const port = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        stage = "done";
        c.off("data", more);
        c.pause();
        if (withToken) tokened(host);
        const d = { target: `${net.isIPv6(host) ? `[${host}]` : host}:${port}`, via: "SOCKS5", token: withToken };
        if (cmd !== 1) {
          log({ event: "deny", reason: "not-connect", ...d });
          return void c.end(reply(7));
        }
        void (async () => {
          let addresses: string[];
          try {
            addresses = await screen(host, port);
          } catch (e) {
            log({ event: "deny", reason: reasonOf(e), ...d });
            return void c.end(reply(reasonOf(e).startsWith("unresolved") ? 4 : 2));
          }
          if (closed || c.destroyed) return void c.destroy();
          const up = await dial(addresses, port, d);
          if (!up) return void (c.destroyed ? undefined : c.end(reply(1)));
          if (c.destroyed) return void up.socket.destroy();
          log({ event: "allow", ...d, address: up.address });
          c.setTimeout(0);
          c.write(reply(0));
          join(c, up.socket, rest);
        })();
      }
    };
    const more = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 1024) return void c.destroy();
      step();
    };
    c.on("data", more);
    step();
  };

  /** Each client: SOCKS5 if its first byte says so (version 5), HTTP otherwise. */
  const accept = (c: net.Socket) => {
    track(c);
    c.on("error", () => {});
    if (closed) return void c.destroy();
    c.setTimeout(HANDSHAKE_TIMEOUT_MS, () => c.destroy());
    c.once("readable", () => {
      const first = c.read() as Buffer | null;
      if (!first) return void c.destroy();
      if (first[0] === 5) return socks(c, first);
      c.setTimeout(0);
      c.unshift(first);
      server.emit("connection", c);
    });
  };

  // One port on both loopback addresses: the sandbox is told `localhost`, which may resolve to either.
  const servers: net.Server[] = [];
  const listen = (host: string, port: number, ipv6Only = false) =>
    new Promise<net.Server>((ok, fail) => {
      const s = net.createServer(accept);
      s.once("error", fail);
      s.listen({ host, port, ipv6Only }, () => {
        s.off("error", fail);
        s.on("error", () => {});
        ok(s);
      });
    });
  let port = 0;
  for (let attempt = 0; !port; attempt++) {
    const v4 = await listen("127.0.0.1", opts.listen?.port ?? 0);
    if (opts.listen?.ipv4Only) { servers.push(v4); port = (v4.address() as net.AddressInfo).port; break; }
    const p = (v4.address() as net.AddressInfo).port;
    try {
      servers.push(v4, await listen("::1", p, true));
      port = p;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // No IPv6 loopback on this machine: IPv4 alone, which `localhost` then resolves to.
      if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
        servers.push(v4);
        port = p;
      } else {
        await new Promise<void>((r) => v4.close(() => r()));
        if (code !== "EADDRINUSE" || attempt >= 20) throw e;
      }
    }
  }
  return {
    port,
    token,
    network: { mode: "off-except-proxy", proxyPort: port, proxyToken: token },
    authenticated: () => sawToken,
    tokenHosts: () => hostsWithToken,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}
