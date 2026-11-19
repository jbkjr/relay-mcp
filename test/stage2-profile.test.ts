import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers.ts";
import { dirIdentity } from "../dist/confine/index.js";
import { deniedTcpPorts, interfaceAddresses, RELAY_PORT_RANGE, rangePorts, STATIC_DENIED_TCP, STATIC_DENIED_UDP } from "../dist/confine/ports.js";
import { SANDBOX_EXEC, seatbeltProfile } from "../dist/confine/seatbelt.js";
import { checkStage2Network, STAGE2_MAX_PORTS, stage2NetworkRules } from "../dist/confine/seatbelt-stage2.js";
import { localDestinations } from "../dist/confine/probe-stage2.js";

// WP-A: the stage-2 network block of relay's Seatbelt profile (docs/codex-confinement-design.md §5.1).

const macOS = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);

function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2p-")));
  const wt = path.join(root, "wt"), tmp = path.join(root, "t"), control = path.join(root, "c");
  for (const d of [wt, tmp, control]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  return { root, wt, tmp, control, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A network shaped like a real turn's: the static list and a snapshot, the 64-port range less a 4-port block. */
function realShaped(over: Record<string, unknown> = {}) {
  const all = rangePorts();
  const block = all.slice(8, 12);
  return {
    mode: "stage2" as const,
    deniedTcp: deniedTcpPorts({ ports: [8888, 32400, 51125], controlPlanes: [8888] }, { exec: all[3], block }),
    deniedUdp: [...STATIC_DENIED_UDP],
    relayRange: all.filter((p) => !block.includes(p)),
    execPort: all[3],
    bindPorts: block,
    worktreeSockets: false,
    ...over,
  };
}

/** The same counts, other values: what the probe's decoy variant does. */
function decoyOf(n: ReturnType<typeof realShaped>, base = 30000) {
  let next = base;
  const fresh = (xs: number[]) => xs.map(() => next++);
  const relayRange = fresh(n.relayRange);
  return { ...n, deniedTcp: fresh(n.deniedTcp), deniedUdp: fresh(n.deniedUdp), relayRange, execPort: relayRange[0], bindPorts: fresh(n.bindPorts) };
}

const policy = (s: ReturnType<typeof scratch>, network: object, extra: Record<string, unknown> = {}) => ({
  worktree: s.wt, worktreeWritable: true, worktreePin: dirIdentity(s.wt), tmpDir: s.tmp, denied: [s.control], network, ...extra,
});

const recorder = () => {
  const params: [string, string][] = [];
  return { params, param: (k: string, v: string) => (params.push([k, v]), `(param "${k}")`) };
};

test("stage-2 rules: every port and path is a parameter; no value is in the text", () => {
  const n = realShaped({ worktreeSockets: true });
  const r = recorder();
  const text = stage2NetworkRules(n, r.param, `(with message (param "DIAG_TAG"))`, { tmpDir: "/tmp/x-tmp", worktree: "/tmp/x-wt" });
  const values = Object.fromEntries(r.params);
  // No digits outside parameters, comments, the address families' names (ip4, ip6) and the fixed AF_SYSTEM protocol number.
  const code = text.replace(/^;.*$/gm, "").replace(/\(param "[A-Z_0-9]+"\)/g, "").replace(/\(socket-protocol 2\)/, "").replace(/\((remote|local) ip[46] /g, "");
  assert.doesNotMatch(code, /\d/, "no port number is written into the rules");
  assert.ok(!text.includes("/tmp/x-wt"), "the worktree is a parameter");
  assert.equal(values.WORKTREE, "/tmp/x-wt");
  assert.equal(values.EXEC_PORT, String(n.execPort));
  assert.deepEqual(n.bindPorts.map((_, i) => values[`BIND_PORT_${i}`]), n.bindPorts.map(String));
  assert.deepEqual(n.deniedTcp.map((_, i) => values[`DENY_PORT_${i}`]), n.deniedTcp.map(String));
  assert.deepEqual(n.relayRange.map((_, i) => values[`RELAY_PORT_${i}`]), n.relayRange.map(String));
  assert.deepEqual(n.deniedUdp.map((_, i) => values[`UDP_DENY_${i}`]), n.deniedUdp.map(String));
  // Each parameter is written once.
  assert.equal(new Set(r.params.map(([k]) => k)).size, r.params.length);
});

test("stage-2 rules: the real profile carries the static denied ports, 1900 and 5351 as parameters", () => {
  const s = scratch();
  try {
    const { profile, params } = seatbeltProfile(policy(s, realShaped()));
    const values = params.filter(([k]) => k.startsWith("DENY_PORT_")).map(([, v]) => Number(v));
    for (const p of STATIC_DENIED_TCP) assert.ok(values.includes(p), `TCP ${p} denied`);
    for (const p of [8888, 32400, 51125]) assert.ok(values.includes(p), `snapshot port ${p} denied`);
    assert.deepEqual(values.slice(0, STATIC_DENIED_TCP.length), [...STATIC_DENIED_TCP], "the static list first");
    assert.equal(values.indexOf(8888), STATIC_DENIED_TCP.length, "then control planes");
    const udp = params.filter(([k]) => k.startsWith("UDP_DENY_")).map(([, v]) => Number(v));
    assert.deepEqual(udp, [1900, 5351]);
    const range = params.filter(([k]) => k.startsWith("RELAY_PORT_")).map(([, v]) => Number(v));
    assert.equal(range.length, RELAY_PORT_RANGE.count - 4);
    assert.doesNotMatch(profile, /localhost:\d/, "no literal local port anywhere in the profile");
    assert.doesNotMatch(profile, /remote ip "localhost:\*"\)/, "no blanket loopback deny: stage 2 replaces NETWORK_ON");
    // Every parameter the profile names is supplied, and nothing else.
    const named = [...profile.matchAll(/\(param "([A-Z_0-9]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(named)].sort(), [...new Set(params.map(([k]) => k))].sort());
  } finally {
    s.done();
  }
});

test("stage-2 rules: every allow comes before the denies it must lose to", () => {
  const s = scratch();
  try {
    const { profile } = seatbeltProfile(policy(s, realShaped({ worktreeSockets: true })));
    const lines = profile.split("\n");
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const last = (re: RegExp) => lines.length - 1 - [...lines].reverse().findIndex((l) => re.test(l));
    const anyOut = at(/^\(allow network-outbound \(remote ip4 "\*:\*"\) \(remote ip6 "\*:\*"\)\)/);
    const udpBind = at(/^\(allow network-bind network-inbound \(local udp "localhost:\*"\)\)/);
    const lastAllow = Math.max(last(/^\(allow network-bind network-inbound \(local tcp/), udpBind, last(/^\(allow network-(bind|outbound) \(.* unix-socket \(subpath \(param "WORKTREE"\)/));
    const firstDeny = Math.min(at(/DENY_PORT_0/), at(/RELAY_PORT_0/), at(/UDP_DENY_0/));
    assert.ok(anyOut >= 0 && udpBind >= 0, "the allows are present");
    assert.ok(anyOut < firstDeny && lastAllow < firstDeny, "allows first, then the port denies");
    assert.ok(at(/^\(deny network-bind \(local ip4 \(string-append "\*:" \(param "DENY_PORT_0"\)\)\) \(local ip6 \(string-append "\*:" \(param "DENY_PORT_0"\)\)\)/) > udpBind, "a denied port is not bound over UDP either");
    // The worktree's sockets lose to relay's hard denies of denied directories, which come later.
    assert.ok(last(/WORKTREE/) < at(/remote unix-socket \(subpath \(param "DENIED_0"\)\)/));
    // Each deny carries the turn's diagnostic tag.
    for (const l of lines.filter((x) => /^\(deny network-(outbound|bind) \(/.test(x) && /(DENY_PORT|RELAY_PORT|UDP_DENY)/.test(x))) assert.match(l, /\(with message \(param "DIAG_TAG"\)\)\)$/);
  } finally {
    s.done();
  }
});

test("stage-2 rules: every IP rule names its family; each denied and range port is denied over IPv4 at this Mac and over IPv6 at every host (review R1)", () => {
  const s = scratch();
  try {
    const n = realShaped({ worktreeSockets: true });
    const { profile } = seatbeltProfile(policy(s, n));
    const code = profile.replace(/^;.*$/gm, "");
    // An "ip" rule beside ip4 or ip6 ones matched other addresses than it says (measured), so there is none.
    assert.doesNotMatch(code, /\((remote|local) ip /, "no family-less ip rule");
    const has = (re: string) => code.split("\n").filter((l) => l.startsWith(re)).length;
    const diag = ' (with message (param "DIAG_TAG")))';
    n.deniedTcp.forEach((_, i) => {
      const p = `(param "DENY_PORT_${i}")`;
      assert.equal(has(`(deny network-outbound (remote ip4 (string-append "localhost:" ${p}))${diag}`), 1, `DENY_PORT_${i} over IPv4`);
      assert.equal(has(`(deny network-outbound (remote ip6 (string-append "*:" ${p}))${diag}`), 1, `DENY_PORT_${i} over IPv6`);
      assert.equal(has(`(deny network-bind (local ip4 (string-append "*:" ${p})) (local ip6 (string-append "*:" ${p}))${diag}`), 1, `DENY_PORT_${i} never bound`);
    });
    n.relayRange.forEach((_, i) => {
      const p = `(param "RELAY_PORT_${i}")`;
      assert.equal(has(`(deny network-outbound (remote ip4 (string-append "localhost:" ${p}))${diag}`), 1, `RELAY_PORT_${i} over IPv4`);
      assert.equal(has(`(deny network-outbound (remote ip6 (string-append "*:" ${p}))${diag}`), 1, `RELAY_PORT_${i} over IPv6`);
    });
    // The job's own ports are never named by an IPv6 deny: its block stays reachable over IPv6.
    assert.doesNotMatch(code, /remote ip6 \(string-append "\*:" \(param "(BIND_PORT|EXEC_PORT)/);
  } finally {
    s.done();
  }
});

test("stage-2 rules: a decoy variant with the same counts has the same rules text and other parameters", () => {
  const s = scratch();
  try {
    const real = seatbeltProfile(policy(s, realShaped()));
    const decoy = seatbeltProfile(policy(s, decoyOf(realShaped())));
    assert.equal(decoy.profile, real.profile, "same rules hash");
    assert.notDeepEqual(decoy.params, real.params, "different fingerprint");
  } finally {
    s.done();
  }
});

test("stage-2 rules: Unix sockets in the worktree only on write turns in a pinned relay worktree", () => {
  const s = scratch();
  try {
    const on = seatbeltProfile(policy(s, realShaped({ worktreeSockets: true })));
    assert.equal(Object.fromEntries(on.params).WORKTREE, s.wt);
    assert.match(on.profile, /\(allow network-outbound \(remote unix-socket \(subpath \(param "WORKTREE"\)\)\)\)/);
    const off = seatbeltProfile(policy(s, realShaped({ worktreeSockets: false }), { worktreeWritable: false }));
    assert.doesNotMatch(off.profile, /WORKTREE/);
    assert.match(off.profile, /\(allow network-outbound \(remote unix-socket \(subpath \(param "TMPDIR"\)\)\)\)/, "TMPDIR sockets in every turn");
    assert.throws(() => seatbeltProfile(policy(s, realShaped({ worktreeSockets: true }), { worktreeWritable: false })), /only on write turns/);
    assert.throws(() => seatbeltProfile(policy(s, realShaped({ worktreeSockets: true }), { worktreePin: undefined })), /created and pinned/);
    assert.throws(() => seatbeltProfile(policy(s, realShaped(), { certificateTrust: true })), /certificate trust/);
  } finally {
    s.done();
  }
});

test("checkStage2Network: refuses non-ports, overlaps, an unreachable-by-deny executor and oversize lists", () => {
  const ok = realShaped();
  assert.doesNotThrow(() => checkStage2Network(ok));
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ mode: "on" }, /not a stage-2 network/],
    [{ deniedTcp: [0] }, /not a port/],
    [{ deniedTcp: [65536] }, /not a port/],
    [{ deniedUdp: [1.5] }, /not a port/],
    [{ relayRange: [Number.NaN] }, /not a port/],
    [{ bindPorts: ["47210"] }, /not a port/],
    [{ deniedTcp: "22" }, /not a list/],
    [{ execPort: 0 }, /executor's port/],
    [{ deniedTcp: [22, 22] }, /twice/],
    [{ egress: "none", bindPorts: ok.bindPorts }, /cannot bind without raw network/],
    [{ connectPorts: [22] }, /static denied TCP port 22/],
    [{ listenPorts: [631] }, /static denied TCP port 631/],
    [{ worktreeSockets: "yes" }, /true or false/],
    [{ bindPorts: [ok.execPort] }, /also in the job's block/],
    [{ relayRange: ok.relayRange.filter((p) => p !== ok.execPort) }, /could reach its own executor/],
    [{ relayRange: [...ok.relayRange, ok.bindPorts[0]] }, /also in the relay-range deny/],
    [{ deniedTcp: [...ok.deniedTcp, ok.bindPorts[1]] }, /both the turn's own and denied/],
    [{ deniedTcp: [...ok.deniedTcp, ok.execPort] }, /both the turn's own and denied/],
    [{ deniedTcp: Array.from({ length: STAGE2_MAX_PORTS }, (_, i) => 1000 + i) }, /more than one profile carries/],
  ];
  for (const [over, re] of bad) assert.throws(() => checkStage2Network({ ...ok, ...over } as never), re, JSON.stringify(over).slice(0, 80));
  const r = recorder();
  assert.doesNotThrow(() => stage2NetworkRules({ ...ok, egress: "none", bindPorts: [] }, r.param, "", { tmpDir: "/t", worktree: "/w" }), "a non-listening turn carries no bind block");
});

const sandboxArgs = (profile: { profile: string; params: [string, string][] }, script: string, args: string[]) =>
  ["-p", profile.profile, ...profile.params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), process.execPath, "-e", script, ...args];

/** The same, asynchronously: this process's own decoys must answer (UDP replies) while it runs. */
function underAsync(profile: { profile: string; params: [string, string][] }, script: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((res, rej) => {
    const c = spawn(SANDBOX_EXEC, sandboxArgs(profile, script, args), { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => (code === 0 ? res(out) : rej(new Error(`exit ${code}: ${err}`))));
  });
}

/** Runs `node -e script` under the profile; returns its stdout. */
function under(profile: { profile: string; params: [string, string][] }, script: string, args: string[], env: Record<string, string>): string {
  const r = spawnSync(SANDBOX_EXEC, sandboxArgs(profile, script, args), { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen({ port: 0, host: "::", ipv6Only: false }, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });

test("stage-2 profile on this Mac: Seatbelt accepts a real-shaped profile and the largest one", { skip: !macOS && "needs macOS sandbox-exec" }, () => {
  const s = scratch();
  try {
    const env = { PATH: "/usr/bin:/bin", HOME: s.root, TMPDIR: s.tmp };
    for (const n of [realShaped({ worktreeSockets: true }), realShaped({ deniedTcp: Array.from({ length: STAGE2_MAX_PORTS - 64 - 2 - 1 }, (_, i) => 1000 + i), relayRange: rangePorts().filter((p) => p !== 47263), bindPorts: [47263] })]) {
      const prof = seatbeltProfile(policy(s, n), process.execPath);
      assert.equal(under(prof, "process.stdout.write('ran')", [], env), "ran");
    }
  } finally {
    s.done();
  }
});

test("stage-2 profile on this Mac: denied and range decoys refused at every local address, the block binds, UDP and Unix sockets by turn kind", { skip: !macOS && "needs macOS sandbox-exec" }, async () => {
  const s = scratch();
  const accepts: string[] = [];
  const servers: (net.Server | dgram.Socket)[] = [];
  const tcpDecoy = (name: string) => new Promise<number>((res) => {
    const srv = net.createServer((c) => { c.on("error", () => {}); accepts.push(name); c.end(); });
    servers.push(srv);
    srv.listen({ port: 0, host: "::", ipv6Only: false }, () => res((srv.address() as net.AddressInfo).port));
  });
  const udpDecoy = (name: string) => new Promise<number>((res) => {
    const u = dgram.createSocket({ type: "udp6", ipv6Only: false });
    servers.push(u);
    u.on("message", (_m, r) => { accepts.push(name); u.send("pong", r.port, r.address); });
    u.bind(0, "::", () => res(u.address().port));
  });
  try {
    const deny = await tcpDecoy("DENY"), relay = await tcpDecoy("RELAY"), ok = await tcpDecoy("OK");
    const udpDeny = await udpDecoy("UDPDENY"), udpOk = await udpDecoy("UDPOK");
    const [exec, b0, b1, other] = [await freePort(), await freePort(), await freePort(), await freePort()];
    const decoySock = path.join(s.wt, "d.sock");
    const unixSrv = net.createServer((c) => { accepts.push("UNIX-WT"); c.end(); });
    servers.push(unixSrv);
    await new Promise<void>((r) => unixSrv.listen(decoySock, r));
    const addrs = interfaceAddresses();
    const network = (write: boolean) => ({ mode: "stage2" as const, deniedTcp: [deny], deniedUdp: [udpDeny], relayRange: [relay, exec], execPort: exec, bindPorts: [b0, b1], worktreeSockets: write });
    const script = `
const net = require("node:net"), dgram = require("node:dgram");
const [P, hosts] = JSON.parse(process.argv[1]);
const tcp = (host, port) => new Promise((res) => { const s = net.connect({ host, port }); const t = setTimeout(() => { s.destroy(); res("timeout"); }, 2000);
  s.on("connect", () => { clearTimeout(t); s.destroy(); res("connected"); }); s.on("error", (e) => { clearTimeout(t); res(e.code); }); });
const bind = (host, port) => new Promise((res) => { const s = net.createServer(); s.on("error", (e) => res(e.code)); s.listen({ host, port }, () => s.close(() => res("bound"))); });
const udp = (host, port) => new Promise((res) => { const s = dgram.createSocket(host.includes(":") ? "udp6" : "udp4"); const fin = (v) => { clearTimeout(t); s.close(); res(v); };
  const t = setTimeout(() => fin("no reply"), 2000); s.on("message", () => fin("reply")); s.on("error", (e) => fin(e.code)); s.send("ping", port, host, (e) => e && fin(e.code)); });
const unix = (p) => new Promise((res) => { const c = net.connect(p); c.on("connect", () => { c.destroy(); res("connected"); }); c.on("error", (e) => res(e.code)); });
(async () => {
  const out = {};
  for (const h of hosts) { out["deny " + h] = await tcp(h, P.deny); out["relay " + h] = await tcp(h, P.relay); }
  out.ok = await tcp("127.0.0.1", P.ok); out.ok6 = await tcp("::1", P.ok); out.okMapped = await tcp("::ffff:127.0.0.1", P.ok);
  // The cost (review R1): IPv6 to a denied port is refused at every host; IPv4 to it elsewhere is not.
  // Documentation and TEST-NET addresses, never routed anywhere real.
  out.v6Denied = await tcp("2001:db8::1", P.deny); out.v6Other = await tcp("2001:db8::1", P.ok); out.v4Denied = await tcp("192.0.2.1", P.deny);
  out.bindBlock = await bind("127.0.0.1", P.b0); out.bindBlockAny = await bind("0.0.0.0", P.b1); out.bindExec = await bind("127.0.0.1", P.exec);
  out.bindOther = await bind("127.0.0.1", P.other); out.bindZero = await bind("127.0.0.1", 0);
  out.udpDeny4 = await udp("127.0.0.1", P.udpDeny); out.udpDeny6 = await udp("::1", P.udpDeny); out.udpOk = await udp("127.0.0.1", P.udpOk);
  out.unixWt = await unix(P.sock);
  process.stdout.write(JSON.stringify(out));
})();`;
    const env = { PATH: "/usr/bin:/bin", HOME: s.root, TMPDIR: s.tmp };
    // Every spelling of this Mac's own addresses (review R1: ::ffff:0.0.0.0 and ::ffff:<LAN address>
    // connected past the old ip "localhost" rule), with the hex forms of the IPv4-mapped ones.
    const v4 = addrs.filter((a) => !a.includes(":"));
    const hex = (a: string) => { const b = a.split(".").map(Number); return `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`; };
    const hosts = [...new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:0.0.0.0", "0:0:0:0:0:ffff:0:0", "fe80::1%lo0",
      ...addrs, ...localDestinations(), ...v4.flatMap((a) => [`::ffff:${a}`, `::ffff:${hex(a)}`, `::${a}`])])];
    for (const h of ["::ffff:0.0.0.0", "0:0:0:0:0:ffff:0:0", ...v4.map((a) => `::ffff:${a}`)]) assert.ok(hosts.includes(h), h);
    const run = async (write: boolean) => JSON.parse(await underAsync(seatbeltProfile(policy(s, network(write), write ? {} : { worktreeWritable: false, worktreePin: undefined }), process.execPath), script,
      [JSON.stringify([{ deny, relay, ok, b0, b1, exec, other, udpDeny, udpOk, sock: decoySock }, hosts])], env));
    for (const write of [true, false]) {
      const got = await run(write);
      for (const h of hosts) {
        assert.equal(got[`deny ${h}`], "EPERM", `denied decoy at ${h}`);
        assert.equal(got[`relay ${h}`], "EPERM", `range decoy at ${h}`);
      }
      assert.equal(got.ok, "connected", "positive control");
      assert.equal(got.ok6, "connected", "positive control over IPv6");
      assert.equal(got.okMapped, "connected", "positive control over an IPv4-mapped address");
      assert.equal(got.v6Denied, "EPERM", "IPv6 to a denied port is refused at any host (the stated cost)");
      assert.notEqual(got.v6Other, "EPERM", "IPv6 to another port is not");
      assert.notEqual(got.v4Denied, "EPERM", "IPv4 to a denied port elsewhere is not");
      assert.equal(got.bindBlock, "bound");
      assert.equal(got.bindBlockAny, "bound", "a block port binds on the wildcard too (stated residual)");
      assert.equal(got.bindExec, "bound");
      assert.equal(got.bindOther, "EPERM");
      assert.equal(got.bindZero, "EPERM", "no ephemeral listening (D3)");
      assert.equal(got.udpDeny4, "EPERM");
      assert.equal(got.udpDeny6, "EPERM");
      assert.equal(got.udpOk, "reply", "UDP clients get their replies");
      assert.equal(got.unixWt, write ? "connected" : "EPERM", `worktree socket on a ${write ? "write" : "read"} turn`);
    }
    for (const name of ["DENY", "RELAY", "UDPDENY"]) assert.ok(!accepts.includes(name), `${name} decoy saw nothing`);
    assert.ok(accepts.includes("OK") && accepts.includes("UDPOK"));
    assert.equal(accepts.filter((a) => a === "UNIX-WT").length, 1, "the worktree decoy saw the write turn only");
  } finally {
    for (const srv of servers) srv.close();
    s.done();
  }
});

