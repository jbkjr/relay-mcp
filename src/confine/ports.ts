import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { relayHome } from "../core/config.js";
import { addHolder, lookLeases, releaseOwn, takePort } from "./leases.js";
import { loopbackAliases } from "./probe.js";
import { canonicalAddress } from "./proxy.js";
import { STATIC_DENIED_TCP } from "./port-policy.js";

export { STATIC_DENIED_TCP, STATIC_DENIED_UDP } from "./port-policy.js";

export { portHeld, releaseLeasesOf } from "./leases.js";

/**
 * Stage 2 (docs/codex-confinement-design.md §5): the ports a stage-2 Codex turn may and may not
 * reach or bind, and the watch on this Mac's addresses. Owner: WP-A.
 */

/** relay's reserved range (§5.5): executors, job port blocks, and relay's own proxies once moved there. */
export const RELAY_PORT_RANGE = { first: 47200, count: 64 } as const;
/** Ports in a job's own block (§5.9, decision D3), passed as PORT and PORTS only when bindable. */
export const JOB_BLOCK_SIZE = 4;

/** One turn's six ports from the reserved range: executor, broker and job block. Released when the turn ends. */
export interface PortLease {
  /** The executor's websocket port (bind and inbound in this turn's profile; outbound denied to everyone). */
  exec: number;
  /** HTTP MCP broker, denied to commands and distinct from the executor and job block. */
  broker: number;
  /** Trusted worker proxy, reserved only for a mediated overlay. */
  proxy?: number;
  /** The job's own block: the only TCP ports it may listen on, and the only reserved ports it may reach. */
  block: number[];
  /**
   * Every port of the reserved range but `block` (the executor's included): the profile's
   * relay-range deny, as `Stage2Network.relayRange`.
   */
  range: number[];
  /**
   * Names another process as holding these ports too (the executor, by pid and start time), and
   * its record: the lease then outlives the leasing process while that one lives, or while the
   * record is there, so that a relay process started after a crash, or after a teardown that was not
   * sure everything stopped, does not hand out ports an orphaned executor or its commands may still
   * use. Optional for stand-in leases in tests.
   */
  hold?(pid: number, start: string, record?: string): void;
  release(): void;
}

/** Options for leaseTurnPorts. Only `blockSize` is for callers; the rest let tests use a scratch range and lease directory. */
export interface LeaseOptions {
  blockSize?: number;
  proxy?: boolean;
  /** The reserved range; RELAY_PORT_RANGE by default. */
  range?: { first: number; count: number };
  /** Where leases are recorded across relay processes; `<relay home>/ports` by default. */
  dir?: string;
  /** Which of these ports something already listens on; a bind test in a child process by default. */
  busy?: (ports: number[]) => Set<number>;
  /** Test-only: called between the look at the leases and the claims, where another relay process may take them first. */
  afterLook?: () => void;
}

/** The ports of a range, in order. */
export const rangePorts = (r: { first: number; count: number } = RELAY_PORT_RANGE): number[] => Array.from({ length: r.count }, (_, i) => r.first + i);

/**
 * Leases free executor and broker ports and a job block; refuses when the reserved range is full.
 *
 * Leases are files in relay's control directory (`<relay home>/ports`, which every confined profile
 * denies), one generation per port at a time, holding the leasing process's pid and start time
 * (leases.ts), so that relay processes serving different sessions never hand out the same port. A
 * lease whose process is gone is taken over, unless a process it names as holding it too (`hold`,
 * the executor) is still that process; of the processes that find it so, one takes it. A port
 * something already listens on is skipped (`busy`): a job's block is exempt from the range deny,
 * so a block port with someone else's listener on it would be reachable.
 */
export function leaseTurnPorts(o: LeaseOptions = {}): PortLease {
  const size = o.blockSize ?? JOB_BLOCK_SIZE;
  if (!Number.isInteger(size) || size < 1) throw new Error(`a job's port block needs at least one port: ${size}`);
  const all = rangePorts(o.range);
  const dir = o.dir ?? path.join(relayHome(), "ports");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const busy = o.busy ?? busyPorts;
  for (let attempt = 0; attempt < 5; attempt++) {
    const look = lookLeases(dir, all);
    const held = look.held;
    const candidates = all.filter((p) => !held.has(p));
    const taken = busy(candidates);
    const free = candidates.filter((p) => !taken.has(p));
    const block = contiguous(free, size) ?? (free.length > size ? free.slice(0, size) : null);
    const exec = block ? free.find((p) => !block.includes(p)) : undefined;
    const broker = block ? free.find((p) => p !== exec && !block.includes(p)) : undefined;
    const proxy = o.proxy ? free.find(p => p !== exec && p !== broker && !block?.includes(p)) : undefined;
    if (!block || exec === undefined || broker === undefined || (o.proxy && proxy === undefined)) {
      throw new Error(`relay's reserved port range ${all[0]}-${all.at(-1)} has no room for another stage-2 turn (${held.size} leased, ${taken.size} in use by something else); wait for a turn to end`);
    }
    o.afterLook?.();
    const claimed: string[] = [];
    let lost = false;
    for (const p of [exec, broker, ...(proxy === undefined ? [] : [proxy]), ...block]) {
      const file = takePort(dir, p, look.free.get(p)!);
      if (file) claimed.push(file);
      else {
        lost = true;
        break;
      }
    }
    if (lost) {
      // Another relay process took one between the look and the claim: give back what was claimed and look again.
      for (const f of claimed) releaseOwn(f);
      continue;
    }
    let released = false;
    return {
      exec,
      broker,
      ...(proxy === undefined ? {} : { proxy }),
      block,
      range: all.filter((p) => !block.includes(p)),
      hold(pid: number, start: string, record?: string) {
        if (released || !Number.isInteger(pid) || pid <= 1 || !start || /[\n]/.test(start)) return;
        for (const f of claimed) addHolder(f, pid, start, record);
      },
      release() {
        if (released) return;
        released = true;
        for (const f of claimed) releaseOwn(f);
      },
    };
  }
  throw new Error("relay could not lease ports for a stage-2 turn: other relay processes kept taking them; try again");
}

/** The first run of `n` consecutive ports in `free` (ascending), or null. */
function contiguous(free: number[], n: number): number[] | null {
  for (let i = 0; i + n <= free.length; i++) {
    if (free[i + n - 1] - free[i] === n - 1) return free.slice(i, i + n);
  }
  return null;
}

/**
 * The hosts a port is tried on to find out whether something listens on it. On macOS, with the
 * SO_REUSEADDR every Node server sets, a wildcard bind succeeds beside another socket's specific
 * address and the reverse, so each kind is tried: loopback, the dual-stack wildcard, and every
 * address of this Mac's, link-local ones with their interface (review R6: a survivor listening on
 * fe80::1%lo0 alone was not found, and the job could then reach it on its own block).
 */
export function bindHosts(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const own = Object.entries(interfaces).flatMap(([name, list]) => (list ?? []).map((a) => {
    const bare = a.address.split("%")[0];
    return a.family === "IPv6" && /^fe[89ab][0-9a-f]:/i.test(bare) ? `${bare}%${name}` : bare;
  }));
  return [...new Set(["127.0.0.1", "::1", "::", ...own])];
}

/** The ports among these that something listens on, by a bind test in a child process (bind is asynchronous in Node). */
export function busyPorts(ports: number[]): Set<number> {
  if (!ports.length) return new Set();
  const script = `
const net = require("node:net");
const [ports, hosts] = JSON.parse(process.argv[1]);
const tryBind = (host, port) => new Promise((res) => {
  const s = net.createServer();
  s.once("error", (e) => res(e.code));
  s.listen({ host, port, ipv6Only: host === "::1" ? true : host === "::" ? false : undefined }, () => s.close(() => res("ok")));
});
(async () => {
  const busy = [];
  for (const p of ports) for (const h of hosts) {
    const r = await tryBind(h, p);
    if (r !== "ok" && r !== "EADDRNOTAVAIL" && r !== "EAFNOSUPPORT") { busy.push(p); break; }
  }
  process.stdout.write(JSON.stringify(busy));
})();`;
  const r = spawnSync(process.execPath, ["-e", script, JSON.stringify([ports, bindHosts()])], { encoding: "utf8", timeout: 20_000, env: { PATH: "/usr/bin:/bin" } });
  if (r.status !== 0) throw new Error(`relay could not test which reserved ports are free: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
  return new Set(JSON.parse(r.stdout) as number[]);
}

/** The listening snapshot (decision D4): TCP ports anything on this Mac listens on now, agent control planes first. */
export interface ListeningSnapshot {
  /** Every port, control planes first, deduplicated. */
  ports: number[];
  /** The subset recognised as agent control planes (Codex app-server and exec-server websockets, Codex proxies, Jupyter, Chrome remote debugging, remote-control hosts). */
  controlPlanes: number[];
}

/**
 * What marks a listener as an agent control plane, by its command line: something that runs or
 * forwards whatever a client asks. Codex's own listeners (app-server and exec-server websockets, its
 * network proxy), Claude Code and relay (remote-control hosts, sandbox and CONNECT proxies),
 * Jupyter kernels and servers, Chrome or Electron remote debugging, Node's inspector, editor servers,
 * and forwarders (ssh, socat).
 */
export const CONTROL_PLANE_PATTERNS: readonly RegExp[] = [
  /(^|\/)codex(\s|$)/,
  /(^|\/)claude(\s|$)/,
  /(^|[\s/])relay(\/dist\/cli\.js|\s|$)/,
  /remote-control/,
  /jupyter/i,
  /--remote-debugging-(port|pipe)/,
  /--inspect(-brk)?(=|\s|$)/,
  /(^|\/)(code-server|code-tunnel)(\s|$)/,
  /(^|\/)(ssh|socat)(\s|$)/,
];

const isControlPlane = (args: string): boolean => CONTROL_PLANE_PATTERNS.some((re) => re.test(args));

/** A TCP listener on this Mac: its process (pid and command name) and its port. */
export interface Listener {
  pid: number;
  command: string;
  port: number;
}

const validPort = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535;

/** The listeners in `lsof -F pcn` output (`-iTCP -sTCP:LISTEN`). */
export function lsofListeners(lsofFields: string): Listener[] {
  const out: Listener[] = [];
  let pid = -1, command = "";
  for (const line of lsofFields.split("\n")) {
    const tag = line[0], value = line.slice(1);
    if (tag === "p") (pid = Number(value)), (command = "");
    else if (tag === "c") command = value;
    else if (tag === "n") {
      // -n -P names: "127.0.0.1:1025", "*:32400", "[::1]:7679"; a listening socket has no "->".
      const m = /:(\d+)$/.exec(value);
      if (!m || value.includes("->")) continue;
      const port = Number(m[1]);
      if (validPort(port)) out.push({ pid, command, port });
    }
  }
  return out;
}

/**
 * The listeners in `nettop -L 1 -m tcp -n -J state` output: a CSV log with a `,state,` header, a
 * line per process (`name.pid,,`) and after it a line per socket of that process (`tcp4
 * 127.0.0.1:1025<->*:*,Listen,`, `tcp6 ::1.7679<->*.*,Listen,`). nettop reads the kernel's network
 * statistics, which show every user's sockets to an unprivileged caller; lsof shows only this
 * user's, and netstat no TCP socket at all (measured on macOS 27.0.1, review R8). Output of another
 * shape throws, so that a changed nettop refuses the turn instead of hiding listeners.
 */
export function nettopListeners(csv: string): Listener[] {
  const lines = csv.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  if (lines[0] !== ",state,") throw new Error(`nettop's output does not start with the expected header: ${JSON.stringify((lines[0] ?? "").slice(0, 80))}`);
  const out: Listener[] = [];
  let pid = -1, command = "";
  for (const line of lines.slice(1)) {
    const flow = /^tcp[46] (\S*?)[:.](\d+|\*)<->\S*,(\w*),$/.exec(line);
    if (flow) {
      const port = Number(flow[2]);
      if (flow[3] === "Listen" && validPort(port)) out.push({ pid, command, port });
      continue;
    }
    const proc = /^(.*)\.(\d+),\w*,$/.exec(line);
    if (!proc) throw new Error(`nettop printed a line relay does not recognise: ${JSON.stringify(line.slice(0, 80))}`);
    (command = proc[1]), (pid = Number(proc[2]));
  }
  return out;
}

/**
 * The snapshot from listeners and each one's command line (`ps` args by pid; the command name stands
 * in where a process is gone or its arguments are not shown). Ports in numeric order within each group.
 */
export function snapshotOf(listeners: Listener[], argsByPid: Map<number, string>): ListeningSnapshot {
  const control = new Set<number>(), other = new Set<number>();
  for (const l of listeners) (isControlPlane(argsByPid.get(l.pid) ?? l.command) ? control : other).add(l.port);
  const controlPlanes = [...control].sort((a, b) => a - b);
  return { ports: [...controlPlanes, ...[...other].filter((p) => !control.has(p)).sort((a, b) => a - b)], controlPlanes };
}

/** The snapshot from `lsof -F pcn` output alone (snapshotOf over lsofListeners). */
export function parseListeningSnapshot(lsofFields: string, argsByPid: Map<number, string>): ListeningSnapshot {
  return snapshotOf(lsofListeners(lsofFields), argsByPid);
}

const LSOF = "/usr/sbin/lsof";
const NETTOP = "/usr/bin/nettop";

/**
 * Every TCP listener on this Mac now, any user's (decision D4, review R8): this user's from lsof,
 * with their command lines, and everyone's from nettop, root's included (sshd and screen sharing
 * through launchd, smbd, kdc, a VPN's own listeners). Either failing refuses the turn.
 */
export function listeningSnapshot(uid: number = process.getuid?.() ?? -1): ListeningSnapshot {
  if (!Number.isInteger(uid) || uid < 0) throw new Error("relay cannot take the listening snapshot: no user id on this platform");
  const r = spawnSync(LSOF, ["-nP", "-a", "-u", String(uid), "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { encoding: "utf8", timeout: 20_000, maxBuffer: 16 << 20 });
  // lsof exits 1 when nothing matches; anything else, or output with an error, refuses the turn.
  if (r.error || (r.status !== 0 && !(r.status === 1 && !r.stdout.trim()))) {
    throw new Error(`relay could not list the ports this user listens on (lsof: ${(r.error?.message || r.stderr || `exit ${r.status}`).trim()}), so it cannot deny them`);
  }
  const n = spawnSync(NETTOP, ["-L", "1", "-m", "tcp", "-n", "-J", "state"], { encoding: "utf8", timeout: 20_000, maxBuffer: 64 << 20 });
  if (n.error || n.status !== 0) {
    throw new Error(`relay could not list every TCP listener on this Mac (nettop: ${(n.error?.message || n.stderr || `exit ${n.status}`).trim()}), so it cannot deny them`);
  }
  let everyone: Listener[];
  try {
    everyone = nettopListeners(n.stdout);
  } catch (err) {
    throw new Error(`relay could not read the TCP listeners on this Mac (${(err as Error).message}), so it cannot deny them`);
  }
  const listeners = [...lsofListeners(r.stdout), ...everyone];
  const pids = [...new Set(listeners.map((l) => l.pid))].filter((p) => p > 0);
  const args = new Map<number, string>();
  if (pids.length) {
    const ps = spawnSync("/bin/ps", ["-ww", "-o", "pid=,args=", "-p", pids.join(",")], { encoding: "utf8", timeout: 20_000, maxBuffer: 16 << 20 });
    for (const line of (ps.stdout ?? "").split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m) args.set(Number(m[1]), m[2]);
    }
  }
  return snapshotOf(listeners, args);
}

/**
 * The TCP ports a stage-2 turn denies: the static list, then the snapshot (control planes first).
 * Ports in relay's reserved range are left to the profile's range deny, which covers all of them
 * but the turn's own block, except that a listener on the block, executor or broker port refuses
 * the turn (review R6): the block is exempt from the range deny, so the job could reach whatever
 * listens there, and the executor could not take its port. The lease is taken before the snapshot
 * and the executor started after it, so neither is the turn's own.
 */
export function deniedTcpPorts(snapshot: ListeningSnapshot, own: Pick<PortLease, "exec" | "block"> & Partial<Pick<PortLease, "broker" | "proxy">>): number[] {
  const taken = snapshot.ports.filter((p) => p === own.exec || p === own.broker || p === own.proxy || own.block.includes(p));
  if (taken.length) {
    const what = taken.map((p) => `${p} (${p === own.exec ? "the executor's port" : p === own.broker ? "the broker's port" : p === own.proxy ? "the mediated proxy's port" : "the job's block"})`).join(", ");
    throw new Error(`something is already listening on this turn's own ports in relay's reserved range, ${what}, so relay does not start the turn; it may be a process left from an earlier turn`);
  }
  const r = RELAY_PORT_RANGE;
  const reserved = (p: number) => p >= r.first && p < r.first + r.count;
  return [...new Set([...STATIC_DENIED_TCP, ...snapshot.controlPlanes, ...snapshot.ports])].filter((p) => !reserved(p));
}

/**
 * This Mac's interface addresses, as the probes and the watch compare them (canonical form).
 * IPv4 dotted, IPv6 in full (canonicalAddress), link-local IPv6 with its interface (`%en1`) so that
 * the same address on another interface counts as new and the probes can connect to it. Sorted, unique.
 */
export function interfaceAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const a of list ?? []) {
      const c = canonicalAddress(a.address);
      out.add(a.family === "IPv6" && /^fe[89ab]/.test(c) ? `${c}%${name}` : c);
    }
  }
  return [...out].sort();
}

/** Watches this Mac's addresses during a turn (§2.2 step 13): a change fails the turn. */
export interface InterfaceWatch {
  /** What changed since the turn started, or null. Also called before each approval. */
  changed(): string | null;
  /** Called once, with what changed, when a poll finds a change. */
  onChange(fail: (what: string) => void): void;
  stop(): void;
}

/** How often the watch reads the addresses. */
export const INTERFACE_POLL_MS = 3000;

/**
 * A new address, one the turn's probes did not see, fails the turn: Seatbelt's local-address deny
 * was measured for the addresses present (§5.2), and a VPN or a new interface can bring paths the
 * design did not look at. Addresses that go away do not fail it: nothing new is reachable. A change,
 * once seen, stays reported. `read` is for tests.
 */
/** An IPv6 link-local address as interfaceAddresses gives it (expanded, with its interface): fe80::/10. */
const LINK_LOCAL_V6 = /^fe[89ab][0-9a-f]:/i;

export function watchInterfaces(baseline: string[], intervalMs: number = INTERFACE_POLL_MS, read: () => string[] = interfaceAddresses): InterfaceWatch {
  const base = new Set(baseline);
  let seen: string | null = null;
  let fail: ((what: string) => void) | null = null;
  let told = false;
  const look = (): string | null => {
    if (seen) return seen;
    let now: string[];
    try {
      now = read();
    } catch (err) {
      seen = `relay could not read this Mac's network addresses: ${(err as Error).message}`;
      return seen;
    }
    // An IPv6 link-local address that comes or goes fails nothing: macOS rotates them on awdl0 and
    // llw0 every few minutes, and the stage-2 rules deny the denied and reserved ports over IPv6 at
    // every host (seatbelt-stage2.ts), so a new one opens nothing. Any other new address fails the
    // turn: the per-turn probes did not cover it.
    const added = now.filter((a) => !base.has(a) && !LINK_LOCAL_V6.test(a));
    if (added.length) {
      const gone = baseline.filter((a) => !now.includes(a));
      seen = `this Mac's network addresses changed during the turn: new ${added.join(", ")}${gone.length ? `; gone ${gone.join(", ")}` : ""}. The turn's checks did not cover the new ones`;
    }
    return seen;
  };
  const tell = () => {
    if (seen && fail && !told) {
      told = true;
      fail(seen);
    }
  };
  const timer = setInterval(() => {
    look();
    tell();
  }, intervalMs);
  timer.unref();
  return {
    changed: () => look(),
    onChange(f) {
      fail = f;
      tell();
    },
    stop: () => clearInterval(timer),
  };
}

/** A refusal when lo0 carries aliases Seatbelt's "localhost" does not cover (§5.2), else null. Uses probe.ts loopbackAliases. */
export function loopbackAliasProblem(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  const aliases = loopbackAliases(interfaces);
  if (!aliases.length) return null;
  return `the loopback interface carries ${aliases.length === 1 ? "an address" : "addresses"} besides 127.0.0.1, ::1 and fe80::1 (${aliases.join(", ")}). ` +
    "A stage-2 profile's local-port denies do not cover such aliases, so relay does not run a stage-2 turn while they exist; remove them (sudo ifconfig lo0 -alias <address>) or run the job in strict mode";
}
