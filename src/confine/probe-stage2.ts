import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { CanaryStep, ListenPortOutcome, Port0ListenRetryBudget } from "./canary.js";
import type { ConfinementPolicy } from "./index.js";
import { within } from "./paths.js";
import { STATIC_DENIED_TCP } from "./ports.js";
import { localAddressSpellings } from "./probe.js";
import { boundaryPaths, dirIdentity } from "./seatbelt.js";
import type { Stage2Network } from "./seatbelt-stage2.js";
import { neverPathIdentity, neverPolicyHash } from "../core/never-policy.js";

/**
 * Stage 2's probe mode (docs/codex-confinement-design.md §7.1, review X4). Owner: WP-B.
 * probeBoundary (probe.ts) keeps every filesystem, process and IPC check, leaves out the network
 * checks stage 2 reverses (tcp-loopback, tcp-loopback-v6, the loopback link-local and alias checks,
 * unix-listen-worktree, listen-loopback and listen-any), and calls planStage2Network instead, with
 * its own planner.
 *
 * Every TCP and UDP check runs in a second canary under the same rules with decoy ports
 * (`decoyNetwork`): relay's own listeners on free high ports stand in for the denied ports, the
 * reserved range and the executor's port, so no probe is ever aimed at a real denied port (the
 * person's sshd, mail bridge, screen sharing, or whatever the snapshot found). probeBoundary checks
 * that the decoy's rules hash is the real turn's. A read turn's cwd is decoyed the same way (review
 * C4): its socket check runs with a scratch directory of relay's own, laid out like the cwd, as the
 * worktree, so relay creates nothing in the cwd, which may be the person's own checkout. The write
 * turns' worktree checks run under the real profile, in relay's own worktree or one the turn writes.
 */

export type ProbeJudge = (got: string) => boolean;

/** probeBoundary's planner, handed to the stage-2 plan: the same allow/deny/skip and cleanup lists. */
export interface ProbePlanner {
  allow(name: string, step: CanaryStep, judge?: ProbeJudge): void;
  deny(name: string, step: CanaryStep, judge?: ProbeJudge): void;
  skip(name: string, expect: "allow" | "deny", why: string): void;
  /** Paths the canary may create, removed afterwards. */
  created: string[];
  /** Run when the probe ends. */
  closers: (() => void)[];
  /** relay's own listeners outside the sandbox, closed when the probe ends. */
  servers: net.Server[];
  /**
   * Checks that run in a second canary under `policy`: the turn's, with decoy ports (`decoyNetwork`)
   * and, on a read turn, a decoy cwd (`decoyCwd`), as the login-store decoy does. probeBoundary
   * refuses the launch unless the decoy wrap has the turn's rules hash. Called at most once per probe.
   */
  decoy(policy: ConfinementPolicy & { network: Stage2Network }): Pick<ProbePlanner, "allow" | "deny">;
}

/** How long a connect or a send the sandbox should refuse at once may hang before it counts as not refused. */
const STEP_TIMEOUT_MS = 1000;
/** Never routed (TEST-NET-1): the "any host" form of the UDP deny, without sending anything anywhere real. */
const UNROUTABLE = "192.0.2.1";
/** macOS keeps 104 bytes for a Unix socket's path, its terminating NUL included. */
const MAX_SOCKET_PATH = 103;
/** Where filler decoy values come from: the dynamic range, far from every port the static denylist names. */
const DECOY_FIRST = 49152;
const DECOY_LAST = 65535;

const sandboxDenied: ProbeJudge = (g) => g === "EPERM";

/** Retrying positive listens retain their complete diagnostic JSON in ProbeResult.got. */
const port0Listened = (budget: Port0ListenRetryBudget): ProbeJudge => (got) => {
  try {
    const result = JSON.parse(got) as ListenPortOutcome;
    return result.outcome === "allowed" && result.attemptCount >= 1 && result.attemptCount <= budget.maxAttempts
      && result.attempts.length === result.attemptCount && result.attempts.at(-1)?.errorCode === null;
  } catch {
    return false;
  }
};

/**
 * Mirror the TCP listener denies in stage2NetworkRules and neverSeatbeltRules, including their
 * exact-listen and own-executor/block exceptions. Use the completed decoy values, not real ports:
 * the reserved range is scattered by the decoy mapping, while kernel-picked floor ports may bunch.
 */
export function stage2Port0RetryBudget(network: Stage2Network, floor?: ConfinementPolicy["neverPolicy"]): Port0ListenRetryBudget {
  const denied = [...new Set([
    ...network.deniedTcp.filter(port => !network.listenPorts?.includes(port)),
    ...network.relayRange.filter(port => port !== network.execPort),
    ...(floor?.ports.filter(rule => rule.transport !== "udp").map(rule => rule.port) ?? []),
    ...(floor?.authorityPorts.filter(port => port !== network.execPort && !network.bindPorts.includes(port)) ?? []),
  ])].filter(port => port >= DECOY_FIRST && port <= DECOY_LAST).sort((a, b) => a - b);
  let run = 0, longestDeniedRun = 0, previous = -1;
  for (const port of denied) {
    run = port === previous + 1 ? run + 1 : 1;
    longestDeniedRun = Math.max(longestDeniedRun, run);
    previous = port;
  }
  // A sequential allocator may wrap from the top of the dynamic range back to its bottom.
  if (denied[0] === DECOY_FIRST && denied.at(-1) === DECOY_LAST && denied.length < DECOY_LAST - DECOY_FIRST + 1) {
    let head = 1, tail = 1;
    while (denied[head] === DECOY_FIRST + head) head++;
    while (denied[denied.length - 1 - tail] === DECOY_LAST - tail) tail++;
    longestDeniedRun = Math.max(longestDeniedRun, head + tail);
  }
  // L denied ports take L failures plus one successful listen; allow one more attempt as margin.
  // Other processes may advance the allocator too: success is still measured, never presumed.
  return { longestDeniedRun, maxAttempts: Math.max(5, longestDeniedRun + 2) };
}

/** Expectations from the trusted, compiled turn policy; the canary reports outcomes only. */
export function stage2ProbeExpectations(network: Stage2Network): { egress: "allow" | "deny"; outsideListen: "allow" | "deny"; blockListen: "allow" | "deny"; connectBlock: boolean } {
  const blockListen = network.bindPorts.length ? "allow" : "deny";
  return {
    egress: network.egress === "none" ? "deny" : "allow",
    outsideListen: network.broadBind === true ? "allow" : "deny",
    blockListen,
    connectBlock: blockListen === "allow" && network.egress !== "none",
  };
}

/**
 * The same network with decoy ports in place of the real denied, range and block ports, for the
 * probe's wrap. Each list keeps its length, so the profile has the same rules and only its `-D`
 * values differ (the rules hash is the real turn's; the fingerprint is not). Refuses a decoy that is
 * one of the real ports or of the static denylist, or a list of another length.
 */
export function decoyNetwork(real: Stage2Network, decoys: { deniedTcp: number[]; deniedUdp: number[]; relayRange: number[]; bindPorts: number[]; execPort: number; listenPorts?: number[]; connectPorts?: number[]; mediatedPort?: number }): Stage2Network {
  const lists = ["deniedTcp", "deniedUdp", "relayRange", "bindPorts"] as const;
  for (const k of lists) {
    if (decoys[k].length !== real[k].length) throw new Error(`the decoy ${k} has ${decoys[k].length} ports where the turn's has ${real[k].length}, so it would not be under the same rules`);
  }
  if ((decoys.listenPorts?.length ?? 0) !== (real.listenPorts?.length ?? 0)) throw new Error("the decoy listenPorts must keep the turn's list length");
  if ((decoys.connectPorts?.length ?? 0) !== (real.connectPorts?.length ?? 0)) throw new Error("the decoy connectPorts must keep the turn's list length");
  if ((real.mediatedPort === undefined) !== (decoys.mediatedPort === undefined)) throw new Error("the decoy mediated port must match the turn shape");
  const all = [...lists.flatMap((k) => decoys[k]), decoys.execPort, ...(decoys.listenPorts ?? []), ...(decoys.connectPorts ?? []), ...(decoys.mediatedPort ? [decoys.mediatedPort] : [])];
  // Never a real port: a decoy that were one would aim a probe at it.
  const realPorts = new Set([...lists.flatMap((k) => real[k]), real.execPort, ...(real.listenPorts ?? []), ...(real.connectPorts ?? []), ...(real.mediatedPort ? [real.mediatedPort] : []), ...STATIC_DENIED_TCP]);
  const clash = all.find((p) => realPorts.has(p));
  if (clash !== undefined) throw new Error(`decoy port ${clash} is one of the turn's real ports`);
  const bad = all.find((p) => !Number.isInteger(p) || p < 1024 || p > 65535);
  if (bad !== undefined) throw new Error(`decoy port ${bad} is not a port in the high range`);
  return { ...real, deniedTcp: [...decoys.deniedTcp], deniedUdp: [...decoys.deniedUdp], relayRange: [...decoys.relayRange], bindPorts: [...decoys.bindPorts], execPort: decoys.execPort,
    ...(real.mediatedPort ? { mediatedPort: decoys.mediatedPort } : {}),
    ...(real.listenPorts ? { listenPorts: [...(decoys.listenPorts ?? [])] } : {}),
    ...(real.connectPorts ? { connectPorts: [...(decoys.connectPorts ?? [])] } : {}) };
}

/**
 * Every address a connect could reach this Mac at, all of which a denied port's rules must cover
 * (§5.2): probe.ts localAddressSpellings, that is the loopback and unspecified addresses, each
 * interface address `os.networkInterfaces()` reports (lo0 aliases included; link-local ones with
 * their interface, without which they cannot be connected to), and the IPv4-mapped (`::ffff:a.b.c.d`,
 * `0:0:0:0:0:ffff:0:0`) and IPv4-compatible (`::a.b.c.d`) spellings of each IPv4 one, which
 * Seatbelt's "localhost" does not cover (review R1).
 */
export function localDestinations(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  return localAddressSpellings(interfaces);
}

function listenOn(server: net.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host, exclusive: true }, () => (server.off("error", reject), resolve()));
  });
}

const closeServer = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

/**
 * A decoy of relay's own on a fresh port, normally at 127.0.0.1 and ::1, counting connections,
 * each closed at once. Approved-connect probes use a wildcard IPv4 listener to measure the
 * disclosed LAN/tailnet reach at that port as well; no application protocol is served.
 */
async function decoyListener(p: ProbePlanner, avoid: Set<number>, ipv4Host = "127.0.0.1"): Promise<{ port: number; accepted: () => number; v6: boolean }> {
  let accepted = 0;
  const count = (c: net.Socket) => (accepted++, c.destroy());
  for (let attempt = 0; attempt < 20; attempt++) {
    const v4 = net.createServer(count);
    await listenOn(v4, 0, ipv4Host);
    p.servers.push(v4);
    const port = (v4.address() as net.AddressInfo).port;
    if (port < 1024 || avoid.has(port)) continue;
    const v6 = net.createServer(count);
    let hasV6 = true;
    try {
      await listenOn(v6, port, "::1");
      p.servers.push(v6);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") continue;
      // No IPv6 loopback on this machine: the IPv4 decoy is the target, and ::1 leads nowhere anyway.
      if (code !== "EADDRNOTAVAIL") throw err;
      hasV6 = false;
    }
    avoid.add(port);
    return { port, accepted: () => accepted, v6: hasV6 };
  }
  throw new Error("relay could not find a free port for a decoy listener");
}

/** A TCP port free on both loopback addresses just now (listened on and closed), not in `avoid`. */
async function freeTcpPort(avoid: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const v4 = net.createServer();
    await listenOn(v4, 0, "127.0.0.1");
    const port = (v4.address() as net.AddressInfo).port;
    let free = port >= 1024 && !avoid.has(port);
    if (free) {
      const v6 = net.createServer();
      try {
        await listenOn(v6, port, "::1");
        await closeServer(v6);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL") free = false;
      }
    }
    await closeServer(v4);
    if (free) {
      avoid.add(port);
      return port;
    }
  }
  throw new Error("relay could not find a free TCP port for its stage-2 probes");
}

/** A UDP port free on 127.0.0.1 just now, not in `avoid`. */
async function freeUdpPort(avoid: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = dgram.createSocket("udp4");
      s.once("error", reject);
      s.bind(0, "127.0.0.1", () => {
        const got = s.address().port;
        s.close(() => resolve(got));
      });
    });
    if (port >= 1024 && !avoid.has(port)) {
      avoid.add(port);
      return port;
    }
  }
  throw new Error("relay could not find a free UDP port for its stage-2 probes");
}

/**
 * A scratch directory of relay's own laid out like a read turn's cwd as far as the profile can tell:
 * the same git layout (no repository, a `.git` directory, or a `.git` file to a git directory with
 * or without a shared one; the cwd at the repository's top or below it) and the same pin and git
 * environment, so that the profile has the same rules and only its `-D` values differ. probeBoundary
 * checks the rules hash, which refuses the launch for a layout this does not reproduce.
 */
export function decoyCwd(policy: ConfinementPolicy, root: string): Pick<ConfinementPolicy, "worktree" | "worktreePin" | "gitEnv"> {
  const real = boundaryPaths(policy);
  const top = path.join(root, "r");
  fs.mkdirSync(top, { recursive: true });
  const pointer = fs.lstatSync(real.gitPointer, { throwIfNoEntry: false });
  let gitDir: string | undefined;
  if (pointer?.isDirectory()) fs.mkdirSync(path.join(top, ".git"));
  else if (pointer) {
    // A .git file: to a git directory (with a shared one when the real has its own), or to nothing.
    if (real.gitDir) {
      gitDir = path.join(root, "g");
      fs.mkdirSync(gitDir);
      if (real.commonDir && real.commonDir !== real.gitDir) {
        fs.mkdirSync(path.join(root, "k"));
        fs.writeFileSync(path.join(gitDir, "commondir"), "../k\n");
      }
    }
    fs.writeFileSync(path.join(top, ".git"), `gitdir: ${gitDir ?? path.join(root, "absent")}\n`);
  }
  // Below the repository's top when the real cwd is (its own .git then a nested pointer the profile denies).
  const below = pointer !== undefined && path.dirname(real.gitPointer) !== real.worktree;
  const worktree = below ? path.join(top, "s") : top;
  if (below) fs.mkdirSync(worktree);
  return {
    worktree,
    worktreePin: policy.worktreePin ? dirIdentity(worktree) : undefined,
    gitEnv: policy.gitEnv ? { GIT_DIR: gitDir ?? path.join(top, ".git"), GIT_WORK_TREE: top } : undefined,
  };
}

/**
 * Plans the stage-2 network checks: denied-port decoys at every local address, the positive
 * control, the relay range, UDP denies, the TCP bind block, and AF_UNIX by turn kind (a decoy
 * socket in a read turn's cwd). The decoys are relay's own listeners; the plan runs under the same
 * rule text with decoy `-D` values (`decoyNetwork`), never against the real denied ports.
 */
export async function planStage2Network(p: ProbePlanner, policy: ConfinementPolicy & { network: Stage2Network }, ctx: { tag: string; worktree: string; tmpDir: string; scratch: string }): Promise<void> {
  const real = policy.network;
  // These inputs are compiled by executorPolicy/startStage2 from the consumed overlay and saved
  // baseline grant. No canary result, child environment or requested capability decides an expectation.
  const expected = stage2ProbeExpectations(real);
  const broadBind = expected.outsideListen === "allow";
  const relayOwnsWorktree = policy.worktreePin !== undefined;
  // Review C4: Unix sockets in the worktree only for write turns in a worktree relay made and pinned.
  // Any other turn (a read turn, whose cwd may be the person's own checkout or home) gets TMPDIR only.
  if (real.worktreeSockets && !(policy.worktreeWritable && relayOwnsWorktree)) {
    throw new Error("a stage-2 turn may have Unix sockets in its worktree only when it writes a worktree relay created and pinned (review C4)");
  }
  for (const k of ["deniedTcp", "deniedUdp"] as const) {
    if (!real[k].length) throw new Error(`the stage-2 network has no ${k}, so relay cannot probe it`);
  }

  // --- AF_UNIX by turn kind: write turns under the turn's own profile, read turns under the decoy's.
  let cwd: ReturnType<typeof decoyCwd> | undefined;
  let cwdSocket: string | undefined;
  // Short names: the canary runs in the worktree, so the name alone reaches it however deep it is.
  const sockName = (kind: string) => `r${kind}${ctx.tag.slice(13, 19)}.sock`;
  if (within(ctx.worktree, ctx.tmpDir)) {
    for (const n of ["stage2-unix-worktree", "stage2-unix-cwd-decoy"]) p.skip(n, real.worktreeSockets ? "allow" : "deny", "the worktree lies inside the turn's temp dir, where Unix sockets are the turn's own");
  } else if (real.worktreeSockets) {
    // A write turn in relay's worktree: a socket there is listened on and connected to.
    p.allow("stage2-unix-worktree", { kind: "listen-unix", path: sockName("w"), connect: true });
    p.created.push(path.join(ctx.worktree, sockName("w")));
  } else if (policy.worktreeWritable) {
    // A write turn in a worktree relay did not make: it writes there, but the listening itself must be refused.
    p.deny("stage2-unix-worktree", { kind: "listen-unix", path: sockName("w"), connect: false });
    p.created.push(path.join(ctx.worktree, sockName("w")));
  } else {
    // A read turn cannot create a socket in its worktree at all (the file rules refuse it: write-worktree,
    // and the generator tests for the person's checkout). What C4 is about is reaching one that is
    // there, and relay makes nothing in the cwd, which may be the person's own checkout: a socket of
    // relay's own listens in a decoy cwd (decoyCwd), which the decoy canary runs with as its worktree.
    p.skip("stage2-unix-worktree", "deny", "a read turn cannot create files in its worktree; relay's decoy socket in a decoy cwd (stage2-unix-cwd-decoy) is the socket check");
    cwd = decoyCwd(policy, path.join(ctx.scratch, "c"));
    const at = path.join(cwd.worktree, sockName("d"));
    if (Buffer.byteLength(at) > MAX_SOCKET_PATH) {
      p.skip("stage2-unix-cwd-decoy", "deny", "relay's scratch dir is too deep for a Unix socket path");
    } else {
      const decoy = net.createServer((c) => c.destroy());
      await new Promise<void>((resolve, reject) => {
        decoy.once("error", reject);
        decoy.listen(at, () => (decoy.off("error", reject), resolve()));
      });
      p.servers.push(decoy);
      cwdSocket = at;
    }
  }

  // --- TCP and UDP, under the same rules with decoy ports.
  const avoid = new Set<number>([...real.deniedTcp, ...real.deniedUdp, ...real.relayRange, ...real.bindPorts, real.execPort, ...(real.listenPorts ?? []), ...(real.connectPorts ?? []),
    ...(policy.neverPolicy?.ports.map(p => p.port) ?? []), ...(policy.neverPolicy?.authorityPorts ?? []), ...STATIC_DENIED_TCP]);
  const denied = await decoyListener(p, avoid);
  const ranged = await decoyListener(p, avoid);
  const open = await decoyListener(p, avoid);
  const mediated = real.mediatedPort ? await decoyListener(p, avoid) : undefined;
  const exec = await freeTcpPort(avoid);
  const block = await freeTcpPort(avoid);
  const outside = await freeTcpPort(avoid);
  const udpDenied = await freeUdpPort(avoid);
  const udpOpen = await freeUdpPort(avoid);
  // Fillers: further decoy values that keep each list's length (so the rules are the turn's). They are
  // only ever denied, or allowed to be bound, in the decoy profile; no probe is aimed at them.
  const filler = () => {
    for (;;) {
      const port = DECOY_FIRST + Math.floor(Math.random() * (DECOY_LAST - DECOY_FIRST + 1));
      if (!avoid.has(port)) return avoid.add(port), port;
    }
  };
  // Preserve every overlap (snapshot/listen/never/control/block), including final-floor exceptions
  // for this executor and its own block. All probes use high decoys, never the real service ports.
  const ports = new Map<number, number>([[real.execPort, exec]]);
  // An approved localhost:P rule also reaches this Mac's LAN/tailnet IPv4 addresses.
  // Our wildcard IPv4 listener gives each allow a positive control and makes 127.0.0.2
  // a meaningful negative control. IPv6 has its own owned listener when available.
  const connects: { port: number; listener: Awaited<ReturnType<typeof decoyListener>> }[] = [];
  for (const port of real.connectPorts ?? []) {
    const listener = await decoyListener(p, avoid, "0.0.0.0");
    connects.push({ port, listener }); ports.set(port, listener.port);
  }
  // A never TCP port gets an owned listener too: refusal must come from the final floor.
  const neverListeners = new Map<number, Awaited<ReturnType<typeof decoyListener>>>();
  if (connects.length) for (const rule of policy.neverPolicy?.ports ?? []) {
    if (rule.transport === "udp" || ports.has(rule.port)) continue;
    const listener = await decoyListener(p, avoid);
    ports.set(rule.port, listener.port); neverListeners.set(rule.port, listener);
  }
  const mapped = (port: number, preferred?: number) => {
    if (!ports.has(port)) ports.set(port, preferred ?? filler());
    return ports.get(port)!;
  };
  // The relay range: the executor's decoy where the turn's executor port is (§5.1: it falls under the
  // range deny), and the ranged decoy at the first other place.
  const execAt = real.relayRange.indexOf(real.execPort);
  if (real.mediatedPort && mediated) ports.set(real.mediatedPort, mediated.port);
  const rangeAt = real.relayRange.findIndex((port, i) => i !== execAt && port !== real.mediatedPort);
  // With no bindPorts, choose another free member of the reserved range as the job-block stand-in:
  // this proves the same final rule that denies the actual reserved block in the turn profile.
  const blockAt = real.bindPorts.length ? -1 : real.relayRange.findIndex((port, i) => i !== execAt && i !== rangeAt && port !== real.mediatedPort);
  if (!real.bindPorts.length && blockAt < 0) throw new Error("the stage-2 network has no reserved port with which to probe its closed job block");
  const relayRange = real.relayRange.map((port, i) => mapped(port, i === execAt ? exec : i === rangeAt ? ranged.port : i === blockAt ? block : undefined));
  const deniedTcp = real.deniedTcp.map((port, i) => mapped(port, i === 0 ? denied.port : undefined));
  const deniedUdp = real.deniedUdp.map((port, i) => mapped(port, i === 0 ? udpDenied : undefined));
  const bindPorts = real.bindPorts.map((port, i) => mapped(port, i === 0 ? block : undefined));
  const connectPorts = connects.map(c => mapped(c.port));
  const listenPorts: number[] = [];
  for (const port of real.listenPorts ?? []) listenPorts.push(mapped(port, ports.has(port) ? undefined : await freeTcpPort(avoid)));
  const floor = policy.neverPolicy;
  for (const port of [...(floor?.ports.map(p => p.port) ?? []), ...(floor?.authorityPorts ?? [])]) {
    if (!ports.has(port)) mapped(port, await freeTcpPort(avoid));
  }
  let neverPolicy = floor;
  if (floor) {
    const { hash: _hash, ...body } = floor;
    const decoyFloor = { ...body, ports: floor.ports.map(rule => ({ ...rule, port: mapped(rule.port) })), authorityPorts: floor.authorityPorts.map(port => mapped(port)) };
    neverPolicy = { ...decoyFloor, hash: neverPolicyHash(decoyFloor) };
  }
  // File grants are exercised only on scratch copies; never open or write the approved real file.
  const overlayFiles = policy.overlayFiles?.map((root, i) => {
    const at = path.join(ctx.scratch, `overlay-file-${i}`);
    if (root.existed) fs.writeFileSync(at, "relay probe\n");
    return { ...root, root: at, pins: neverPathIdentity(at) };
  });
  const decoyPolicy = { ...policy, ...cwd, overlayFiles, neverPolicy, network: decoyNetwork(real, {
    deniedTcp,
    deniedUdp,
    relayRange,
    bindPorts,
    execPort: exec,
    ...(mediated ? { mediatedPort: mediated.port } : {}),
    ...(real.listenPorts ? { listenPorts } : {}),
    ...(real.connectPorts ? { connectPorts } : {}),
  }) };
  const d = p.decoy(decoyPolicy);
  const port0Budget = stage2Port0RetryBudget(decoyPolicy.network, decoyPolicy.neverPolicy);
  overlayFiles?.forEach((root, i) => d.allow(`stage2-write-overlay-file-${i}`, { kind: "write", path: root.root }));
  for (const [i, root] of (policy.overlayRoots ?? []).entries()) {
    if (root.scope !== "tree") continue;
    // An owned disposable directory within the approved tree: no user file is touched, even if
    // the profile is broken. The surrounding write-outside and all hard denies remain unchanged.
    const dir = fs.mkdtempSync(path.join(root.root, `${ctx.tag}-`));
    p.closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    p.allow(`stage2-write-overlay-tree-${i}`, { kind: "write", path: path.join(dir, "written") });
  }
  if (cwdSocket) d.deny("stage2-unix-cwd-decoy", { kind: "unix", path: cwdSocket });
  const tcp = (host: string, port: number): CanaryStep => ({ kind: "tcp", host, port, timeoutMs: STEP_TIMEOUT_MS });
  const udp = (host: string, port: number): CanaryStep => ({ kind: "udp", host, port, timeoutMs: STEP_TIMEOUT_MS });
  // Refused by the sandbox, and the decoy saw no connection at all.
  const neverReached = (l: { accepted: () => number }): ProbeJudge => (g) => sandboxDenied(g) && l.accepted() === 0;
  // A denied port, at every address of this Mac, IPv4-mapped and -compatible spellings included.
  const destinations = localDestinations();
  for (const host of destinations) d.deny(`stage2-tcp-denied@${host}`, tcp(host, denied.port), neverReached(denied));
  if (mediated) {
    d.allow("stage2-mediated-proxy", tcp("127.0.0.1", mediated.port));
    d.deny("stage2-mediated-proxy-ipv6", tcp("::1", mediated.port));
    d.deny("stage2-mediated-proxy-mapped", tcp("::ffff:127.0.0.1", mediated.port));
  }
  connects.forEach(({ listener }, i) => {
    const hosts = [...new Set(["127.0.0.1", ...Object.values(os.networkInterfaces()).flatMap(as => as ?? [])
      .filter(a => a.family === "IPv4" && !a.address.startsWith("127.")).map(a => a.address)])];
    for (const host of hosts) d.allow(`stage2-connect-overlay-${i}@${host}`, tcp(host, listener.port));
    if (expected.egress === "deny") {
      for (const host of ["127.0.0.2", ...(listener.v6 ? ["::1"] : []), "::ffff:127.0.0.1"])
        d.deny(`stage2-connect-overlay-${i}-denied@${host}`, tcp(host, listener.port));
      d.deny(`stage2-connect-overlay-${i}-other-port`, tcp("127.0.0.1", open.port));
    }
  });
  // Raw egress's positive control, or a deny for overlay-only turns without raw authority.
  // Include IPv6 and mapped IPv4 (the IPv6 denies name their ports, not all of IPv6).
  const egress = d[expected.egress];
  egress("stage2-tcp-open-port", tcp("127.0.0.1", open.port));
  if (open.v6) egress("stage2-tcp-open-port@::1", tcp("::1", open.port));
  egress("stage2-tcp-open-port@::ffff:127.0.0.1", tcp("::ffff:127.0.0.1", open.port));
  // relay's reserved range: another turn's executor or block (at every address, as a denied port),
  // and this turn's own executor.
  if (rangeAt >= 0) {
    d.deny("stage2-tcp-relay-range", tcp("127.0.0.1", ranged.port), neverReached(ranged));
    for (const host of destinations.filter((h) => h !== "127.0.0.1")) d.deny(`stage2-tcp-relay-range@${host}`, tcp(host, ranged.port), neverReached(ranged));
  }
  d.deny("stage2-tcp-exec-port", tcp("127.0.0.1", exec));
  // The executor always binds. The block binds only with raw/person authority or an explicit
  // listen/port-0 overlay; exercise both loopback and wildcard because Seatbelt's localhost local
  // rule matches both. Outbound self-connect still requires raw authority.
  d[expected.blockListen]("stage2-listen-block", { kind: "listen-port", host: "127.0.0.1", port: block, connect: expected.connectBlock });
  d[expected.blockListen]("stage2-listen-block-any", { kind: "listen-port", host: "0.0.0.0", port: block, connect: false });
  d.allow("stage2-listen-exec-port", { kind: "listen-port", host: "127.0.0.1", port: exec, connect: false });
  const bind = d[expected.outsideListen];
  bind("stage2-listen-outside-block", { kind: "listen-port", host: "127.0.0.1", port: outside, connect: false });
  const port0 = (host: string): CanaryStep => ({ kind: "listen-port", host, port: 0, connect: false, ...(broadBind ? { retryOnEperm: port0Budget } : {}) });
  // A kernel-selected port can collide with this profile's denied decoys. Only the positive
  // port-0 checks retry EPERM; a negative control must still observe its very first refusal.
  bind("stage2-listen-port-0", port0("127.0.0.1"), broadBind ? port0Listened(port0Budget) : undefined);
  // Wildcard binding is part of port-0's disclosed scope, not loopback-only authority.
  if (broadBind) d.allow("stage2-listen-port-0-any", port0("0.0.0.0"), port0Listened(port0Budget));
  listenPorts.forEach((port, i) => d.allow(`stage2-listen-overlay-${i}`, { kind: "listen-port", host: "127.0.0.1", port, connect: false }));
  const refuseListen = (name: string, port: number) => {
    d.deny(name, { kind: "listen-port", host: "127.0.0.1", port, connect: false });
    d.deny(`${name}@0.0.0.0`, { kind: "listen-port", host: "0.0.0.0", port, connect: false });
  };
  // Snapshot/static, other assigned blocks and final never/control-plane listener floors still win.
  // Exact listen exceptions intentionally override the earlier snapshot deny for that port only.
  if (broadBind) {
    deniedTcp.forEach((port, i) => { if (!listenPorts.includes(port)) refuseListen(`stage2-listen-denied-${i}`, port); });
    relayRange.forEach((port, i) => { if (port !== exec) refuseListen(`stage2-listen-relay-range-${i}`, port); });
  }
  neverPolicy?.ports.forEach((rule, i) => {
    if (rule.transport !== "udp") {
      refuseListen(`stage2-listen-never-${i}`, rule.port);
      const listener = neverListeners.get(floor!.ports[i].port);
      d.deny(`stage2-tcp-never-${i}`, tcp("127.0.0.1", rule.port), listener ? neverReached(listener) : undefined);
    }
    if (rule.transport !== "tcp") {
      d.deny(`stage2-udp-bind-never-${i}`, { kind: "udp-bind", host: "127.0.0.1", port: rule.port });
      d.deny(`stage2-udp-never-${i}`, udp("127.0.0.1", rule.port));
    }
  });
  neverPolicy?.authorityPorts.forEach((port, i) => {
    if (port !== exec && !bindPorts.includes(port)) refuseListen(`stage2-listen-control-${i}`, port);
    if (!bindPorts.includes(port) && port !== mediated?.port) d.deny(`stage2-tcp-control-${i}`, tcp("127.0.0.1", port));
  });
  egress("stage2-udp-bind", { kind: "udp-bind", host: "127.0.0.1", port: 0 });
  // UDP to a denied port (1900 and 5351 in the real turn) at any host: loopback both ways and a
  // never-routed address; another port is sent to (the positive control).
  for (const host of ["127.0.0.1", "::1", UNROUTABLE]) d.deny(`stage2-udp-denied@${host}`, udp(host, deniedUdp[0]));
  egress("stage2-udp-open-port", udp("127.0.0.1", udpOpen));
}
