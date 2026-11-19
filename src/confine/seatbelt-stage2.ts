/**
 * Stage 2's network block for relay's Seatbelt profile (docs/codex-confinement-design.md §5.1).
 * Owner: WP-A. seatbelt.ts calls stage2NetworkRules for `network.mode === "stage2"`.
 */
import { STATIC_DENIED_TCP } from "./port-policy.js";

/** The network a stage-2 turn's profile gets. Every port reaches the profile as a `-D` parameter. */
export interface Stage2Network {
  mode: "stage2";
  /** TCP ports denied at every local address (static list and snapshot), outbound and bind. */
  deniedTcp: number[];
  /** UDP ports denied to any host (1900, 5351). */
  deniedUdp: number[];
  /** relay's reserved range minus an authorized block; includes the block when it has no bind authority. */
  relayRange: number[];
  /** The executor's port: bind and inbound only. */
  execPort: number;
  /** The job's block when raw network or a listen/port0 overlay authorizes bind/inbound; empty otherwise. */
  bindPorts: number[];
  /** Unix sockets under the worktree too: write turns in a worktree relay created and pinned only (review C4). */
  worktreeSockets: boolean;
  /** Overlay-only plans have no raw egress, DNS or UDP bind permission. */
  egress?: "raw" | "none";
  /** Approved IPv4 localhost:P connects, including this Mac's LAN/tailnet addresses. */
  connectPorts?: number[];
  /** Internal worker proxy, bound to 127.0.0.1 only; not an exact-connect capability. */
  mediatedPort?: number;
  listenPorts?: number[];
  broadBind?: boolean;
}

/**
 * The most ports one profile names (denied, range, block and executor together). Far above what a
 * turn needs (the static list, a snapshot of a few dozen listeners, a 64-port range); past it the
 * turn is refused rather than given a shortened denylist.
 */
export const STAGE2_MAX_PORTS = 1024;

// Seatbelt accepts only * and localhost as address hosts. Owner-approved IPv4
// localhost:P includes this Mac's LAN/tailnet addresses. No IPv6 allow is added.

/**
 * The profile text for a stage-2 network, written with `param` (seatbelt.ts's parameter writer) so
 * that no port or path is in the text: the probe's decoy variant then has the same rules hash.
 * `diag` is the turn's `(with message …)` clause for every deny. `paths` are the canonical TMPDIR and worktree.
 *
 * The text depends only on how many ports each list holds and on `worktreeSockets`; every value is
 * a parameter. The turn's own Unix sockets under TMPDIR are allowed by seatbeltProfile in every
 * mode, so this block adds only the worktree's, and only when `worktreeSockets` is set.
 *
 * Order: baseline allows first, then denies, since Seatbelt takes the last matching rule. Explicit
 * localhost connect/listen exceptions follow the baseline snapshot denies, before final never/control rules. Each deny
 * must win over the outbound IP allow and the UDP bind allow above it. The block's allows never meet a
 * deny: checkStage2Network refuses a block port that is also denied or in the range.
 *
 * Every IP rule names its family (ip4, ip6), never "ip": beside an ip6 rule, `(remote ip
 * "localhost:P")` stopped matching IPv4 (127.0.0.1, 0.0.0.0, the LAN address connected), and an ip6
 * deny beside `(remote ip "*:*")` refused IPv4 egress too (measured on macOS 27.0.1, review R1).
 */
export function stage2NetworkRules(net: Stage2Network, param: (name: string, value: string) => string, diag: string, paths: { tmpDir: string; worktree: string }): string {
  checkStage2Network(net);
  const local = (p: string) => `(string-append "localhost:" ${p})`;
  const anyHost = (p: string) => `(string-append "*:" ${p})`;
  const L: string[] = [];
  if (net.egress !== "none") L.push(`; --- network, stage 2 (docs/codex-confinement-design.md §5.1): IP anywhere, then the local denies.
; Creating IP and Unix sockets needs no rule; kernel-control sockets (AF_SYSTEM, SYSPROTO_CONTROL),
; which the network stack uses, do. DNS through mDNSResponder, as with the network on.
; Every IP rule names its family: an "ip" rule beside ip4 or ip6 ones matched other addresses (measured).
(allow network-outbound (remote ip4 "*:*") (remote ip6 "*:*"))
(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.mDNSResponder")
  (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.networkd") (global-name "com.apple.nehelper"))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))`);
  if (net.broadBind) L.push(`; --- approved port-0 scope: TCP listeners may bind 0.0.0.0, on the LAN\n(allow network-bind network-inbound (local tcp "*:*"))`);
  // Listening: always the executor's port; the job's block only when its plan carries authority. Seatbelt's
  // "localhost" in a local rule matches 127.0.0.1, ::1 and the wildcard address alike (measured).
  L.push(`; --- listening: TCP on the executor's port, plus an authorized job block when present\n(allow network-bind network-inbound (local tcp ${local(param("EXEC_PORT", String(net.execPort)))}))`);
  net.bindPorts.forEach((p, i) => L.push(`(allow network-bind network-inbound (local tcp ${local(param(`BIND_PORT_${i}`, String(p)))}))`));
  // UDP: a client binds implicitly on its first send, and its replies arrive as inbound datagrams;
  // without these every UDP send fails, and every reply (a direct DNS query, QUIC) is refused (measured).
  if (net.egress !== "none") L.push(`(allow network-bind network-inbound (local udp "localhost:*"))`);
  if (net.worktreeSockets) {
    // Write turns in a worktree relay made and pinned (seatbeltProfile checks both). A read turn's
    // directory may be the person's own checkout or home, whose sockets are theirs (review C4).
    const wt = param("WORKTREE", paths.worktree);
    L.push(`; --- Unix sockets in the job's own worktree\n(allow network-bind (local unix-socket (subpath ${wt})))\n(allow network-outbound (remote unix-socket (subpath ${wt})))`);
  }
  // The denies, after every allow they must win over. IPv4: "localhost" in a remote rule matches every
  // IPv4 address of this Mac's own (loopback, LAN, tailnet) and 0.0.0.0 (measured, §5.2). IPv6: the
  // port is denied at every host, since "localhost" misses the IPv4-mapped spellings of this Mac's
  // addresses (::ffff:0.0.0.0 reaches loopback, ::ffff:<LAN address> the LAN address; review R1) and
  // Seatbelt names no host but * and localhost. The cost: IPv6, and IPv4 through an IPv6 socket, to
  // these port numbers on every host. Binding: denied at every local address of either family.
  const denyOut = (port: string) => `(deny network-outbound (remote ip4 ${local(port)}) ${diag})\n(deny network-outbound (remote ip6 ${anyHost(port)}) ${diag})`;
  L.push(`; --- denied ports: the static list and the listening snapshot, at every local address (IPv6: every host), and never bound`);
  net.deniedTcp.forEach((p, i) => {
    const port = param(`DENY_PORT_${i}`, String(p));
    L.push(`${denyOut(port)}\n(deny network-bind (local ip4 ${anyHost(port)}) (local ip6 ${anyHost(port)}) ${diag})\n(deny network-inbound (local ip4 ${anyHost(port)}) (local ip6 ${anyHost(port)}) ${diag})`);
  });
  // Approved listener ports appear in the snapshot deny too: override that deny only,
  // before the reserved/control and final never denies. Values remain parameters, no literal IP.
  (net.connectPorts ?? []).forEach((p, i) => L.push(`(allow network-outbound (remote ip4 ${local(param(`CONNECT_PORT_${i}`, String(p)))}))`));
  (net.listenPorts ?? []).forEach((p, i) => L.push(`(allow network-bind network-inbound (local tcp ${local(param(`LISTEN_PORT_${i}`, String(p)))}))`));
  L.push(`; --- relay's reserved range but this turn's block: other turns' executors and blocks, this turn's executor, relay's own proxies`);
  net.relayRange.forEach((p, i) => L.push(denyOut(param(`RELAY_PORT_${i}`, String(p)))));
  // Broad bind cannot impersonate any other relay listener. The executor needs its own port to start.
  net.relayRange.filter(p => p !== net.execPort).forEach((p, i) => L.push(`(deny network-bind network-inbound (local ip4 ${anyHost(param(`RELAY_LISTEN_DENY_${i}`, String(p)))}) (local ip6 ${anyHost(`(param "RELAY_LISTEN_DENY_${i}")`)}) ${diag})`));
  L.push(`; --- UDP port mappings (SSDP/UPnP, NAT-PMP/PCP), to any host`);
  net.deniedUdp.forEach((p, i) => L.push(`(deny network-outbound (remote udp (string-append "*:" ${param(`UDP_DENY_${i}`, String(p))})) ${diag})`));
  if (net.mediatedPort !== undefined) L.push(`; --- trusted worker proxy only; final never rules still follow
(allow network-outbound (remote ip4 ${local(param("MEDIATED_PORT", String(net.mediatedPort)))}))`);
  return L.join("\n");
}

/** Checks a Stage2Network before it is written (ports in range, no overlap between block, exec port and denies). Throws what is wrong. */
export function checkStage2Network(net: Stage2Network): void {
  if (!net || net.mode !== "stage2") throw new Error(`not a stage-2 network: ${JSON.stringify((net as { mode?: unknown } | undefined)?.mode)}`);
  const isPort = (p: unknown): p is number => typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535;
  const list = (name: "deniedTcp" | "deniedUdp" | "relayRange" | "bindPorts"): number[] => {
    const v: unknown = net[name];
    if (!Array.isArray(v)) throw new Error(`stage-2 network: ${name} is not a list of ports`);
    for (const p of v) if (!isPort(p)) throw new Error(`stage-2 network: ${name} holds ${JSON.stringify(p)}, which is not a port (1-65535)`);
    if (new Set(v).size !== v.length) throw new Error(`stage-2 network: ${name} names a port twice`);
    return v;
  };
  const deniedTcp = list("deniedTcp"), deniedUdp = list("deniedUdp"), relayRange = list("relayRange"), bindPorts = list("bindPorts");
  if (net.egress !== undefined && !["raw", "none"].includes(net.egress)) throw new Error("stage-2 network: invalid overlay egress");
  for (const key of ["connectPorts", "listenPorts"] as const) {
    if (net[key] !== undefined && (!Array.isArray(net[key]) || net[key]!.some(p => !isPort(p) || relayRange.includes(p)))) throw new Error(`stage-2 network: invalid or protected overlay ${key}`);
    const staticPort = net[key]?.find(p => STATIC_DENIED_TCP.includes(p));
    if (staticPort !== undefined) throw new Error(`stage-2 network: static denied TCP port ${staticPort} cannot be an overlay ${key === "connectPorts" ? "connect" : "listen"} exception`);
  }
  if (net.mediatedPort !== undefined && (!isPort(net.mediatedPort) || net.egress !== "none" || !relayRange.includes(net.mediatedPort) || net.mediatedPort === net.execPort || bindPorts.includes(net.mediatedPort) || deniedTcp.includes(net.mediatedPort) || net.listenPorts?.includes(net.mediatedPort))) throw new Error("stage-2 network: invalid internal mediated proxy port");
  if (!isPort(net.execPort)) throw new Error(`stage-2 network: the executor's port ${JSON.stringify(net.execPort)} is not a port (1-65535)`);
  if (net.egress === "none" && bindPorts.length && !net.broadBind && !net.listenPorts?.length) throw new Error("stage-2 network: the job's block cannot bind without raw network, an explicit listen, or a port-0 overlay");
  if (typeof net.worktreeSockets !== "boolean") throw new Error("stage-2 network: worktreeSockets must be true or false");
  if (bindPorts.includes(net.execPort)) throw new Error(`stage-2 network: the executor's port ${net.execPort} is also in the job's block`);
  // The executor's port falls under the range deny, so the job cannot open a second session on its own executor (§5.1).
  if (!relayRange.includes(net.execPort)) throw new Error(`stage-2 network: the executor's port ${net.execPort} is not in the relay-range deny, so the job could reach its own executor`);
  const inRange = bindPorts.filter((p) => relayRange.includes(p));
  if (inRange.length) throw new Error(`stage-2 network: block port(s) ${inRange.join(", ")} are also in the relay-range deny`);
  const deniedOwn = [net.execPort, ...bindPorts].filter((p) => deniedTcp.includes(p));
  if (deniedOwn.length) throw new Error(`stage-2 network: port(s) ${deniedOwn.join(", ")} are both the turn's own and denied`);
  const total = deniedTcp.length + deniedUdp.length + relayRange.length + bindPorts.length + 1 + (net.connectPorts?.length ?? 0) + (net.listenPorts?.length ?? 0);
  if (total > STAGE2_MAX_PORTS) throw new Error(`stage-2 network: ${total} ports is more than one profile carries (${STAGE2_MAX_PORTS}); relay does not shorten the denylist, so the turn is refused`);
}
