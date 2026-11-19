import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers.ts";
import {
  bindHosts, busyPorts, CONTROL_PLANE_PATTERNS, deniedTcpPorts, portHeld, interfaceAddresses, JOB_BLOCK_SIZE, leaseTurnPorts, listeningSnapshot, loopbackAliasProblem,
  lsofListeners, nettopListeners, parseListeningSnapshot, RELAY_PORT_RANGE, rangePorts, snapshotOf, STATIC_DENIED_TCP, STATIC_DENIED_UDP, watchInterfaces,
} from "../dist/confine/ports.js";

// WP-A: the reserved range and per-turn leases, the listening snapshot, the interface watch
// (docs/codex-confinement-design.md §5.3, §5.5, §2.2 steps 5 and 13).

const leaseDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "s2-leases-"));
const none = () => new Set<number>();
const R = { first: 50000, count: 12 };

test("mediated proxy has a seventh distinct lease, collision check and release", () => {
  const dir = leaseDir();
  try {
    const a = leaseTurnPorts({ range: R, dir, busy: none, proxy: true });
    assert.equal(new Set([a.exec, a.broker, a.proxy, ...a.block]).size, 7);
    assert.ok(a.range.includes(a.proxy!)); assert.ok(portHeld(a.proxy!, { dir }));
    assert.throws(() => deniedTcpPorts({ ports: [a.proxy!], controlPlanes: [] }, a), /mediated proxy/);
    a.release(); assert.equal(portHeld(a.proxy!, { dir }), false);
    assert.throws(() => leaseTurnPorts({ range: { first: 51000, count: 6 }, dir, busy: none, proxy: true }), /no room/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("BB: broker takes a sixth distinct lease and refuses a snapshot collision", () => {
  const dir = leaseDir();
  try {
    const a = leaseTurnPorts({ range: R, dir, busy: none });
    assert.ok(Number.isInteger(a.broker));
    assert.equal(new Set([a.exec, a.broker, ...a.block]).size, 6);
    assert.ok(a.range.includes(a.broker));
    assert.ok(portHeld(a.broker, { dir }));
    assert.throws(() => deniedTcpPorts({ ports: [a.broker], controlPlanes: [] }, a), /broker/);
    a.release();
    assert.ok(!portHeld(a.broker, { dir }));
    assert.throws(() => leaseTurnPorts({ range: { first: 51000, count: 5 }, dir, busy: none }), /no room/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the fixed lists are macOS's own services (decision D5), nothing of one person's Mac", () => {
  assert.deepEqual([...STATIC_DENIED_TCP], [22, 5900, 3283, 3031, 445, 548, 631]);
  assert.deepEqual([...STATIC_DENIED_UDP], [1900, 5351]);
  assert.equal(JOB_BLOCK_SIZE, 4);
  assert.deepEqual(rangePorts().slice(0, 2), [RELAY_PORT_RANGE.first, RELAY_PORT_RANGE.first + 1]);
  assert.equal(rangePorts().length, RELAY_PORT_RANGE.count);
});

test("leases: executor port and block from the range, never overlapping, released for reuse", () => {
  const dir = leaseDir();
  try {
    const a = leaseTurnPorts({ range: R, dir, busy: none });
    assert.equal(a.block.length, JOB_BLOCK_SIZE);
    assert.ok(!a.block.includes(a.exec));
    for (const p of [a.exec, a.broker, ...a.block]) assert.ok(p >= R.first && p < R.first + R.count);
    assert.deepEqual(a.block, [a.block[0], a.block[0] + 1, a.block[0] + 2, a.block[0] + 3], "a contiguous block");
    assert.deepEqual(a.range, rangePorts(R).filter((p) => !a.block.includes(p)), "range: everything but the block");
    assert.ok(a.range.includes(a.exec), "the executor's own port is in the range deny");
    for (const p of [a.exec, a.broker, ...a.block]) assert.match(fs.readFileSync(path.join(dir, `${p}.1`), "utf8"), new RegExp(`^${process.pid} \\S`), "the first generation, naming this process and its start time");
    const b = leaseTurnPorts({ range: R, dir, busy: none });
    const mine = (l: typeof a) => [l.exec, l.broker, ...l.block];
    assert.equal(mine(a).filter((p) => mine(b).includes(p)).length, 0, "two leases share no port");
    // 12 ports hold two turns of six; a third does not fit.
    assert.throws(() => leaseTurnPorts({ range: R, dir, busy: none }), /no room for another stage-2 turn/);
    a.release();
    a.release();
    for (const p of mine(a)) assert.ok(!portHeld(p, { dir }), "released");
    const c = leaseTurnPorts({ range: R, dir, busy: none });
    assert.equal(mine(c).filter((p) => mine(b).includes(p)).length, 0);
    b.release();
    c.release();
    assert.ok(rangePorts(R).every((p) => !portHeld(p, { dir })));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("leases: ports something listens on are skipped; a dead process's lease is taken back; a live one's is not", () => {
  const dir = leaseDir();
  try {
    const busy = new Set([R.first, R.first + 1, R.first + 5]);
    const a = leaseTurnPorts({ range: R, dir, busy: (ps) => new Set(ps.filter((p) => busy.has(p))) });
    for (const p of [a.exec, a.broker, ...a.block]) assert.ok(!busy.has(p), `busy port ${p} not leased`);
    a.release();
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    for (const p of rangePorts(R)) fs.writeFileSync(path.join(dir, String(p)), `${dead}\n`);
    const b = leaseTurnPorts({ range: R, dir, busy: none });
    assert.ok(b.block.length === JOB_BLOCK_SIZE, "stale leases reclaimed");
    b.release();
    for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n));
    for (const p of rangePorts(R)) fs.writeFileSync(path.join(dir, String(p)), `${process.ppid}\n`);
    assert.throws(() => leaseTurnPorts({ range: R, dir, busy: none }), /no room/, "a live process's leases hold");
    assert.throws(() => leaseTurnPorts({ range: R, dir, busy: none, blockSize: 0 }), /at least one port/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("leases (R6): two relay processes that both find a lease stale never both take the port", () => {
  const dir = leaseDir();
  try {
    // One lease's room: six ports, all leased by a process that has gone.
    const one = { first: 50100, count: 6 };
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    for (const p of rangePorts(one)) fs.writeFileSync(path.join(dir, String(p)), `${dead}\n`);
    // A has looked and found them stale; before it claims, B looks, finds them stale too and takes them.
    // (Before generations, B removed and re-made each lease file; A then removed B's fresh files and made its own: both held the ports.)
    let b: ReturnType<typeof leaseTurnPorts> | null = null;
    const afterLook = () => void (b ??= leaseTurnPorts({ range: one, dir, busy: none }));
    assert.throws(() => leaseTurnPorts({ range: one, dir, busy: none, afterLook }), /no room/, "A finds them taken when it looks again");
    assert.ok(b, "B took them");
    for (const p of rangePorts(one)) assert.ok(portHeld(p, { dir }), `${p} held by B`);
    assert.deepEqual(fs.readdirSync(dir).sort(), rangePorts(one).map((p) => `${p}.1`).sort(), "B's leases stand; the stale ones are gone, and A made none");
    b!.release();
    // Released, the newest generation stays as a marker, and the next lease follows it.
    const c = leaseTurnPorts({ range: one, dir, busy: none });
    assert.deepEqual(fs.readdirSync(dir).sort(), rangePorts(one).map((p) => `${p}.2`).sort());
    c.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("leases (R6): a process that judged an older generation free does not take a newer lease", async () => {
  const { takePort, lookLeases } = await import("../dist/confine/leases.js");
  const dir = leaseDir();
  try {
    const p = 50200;
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    fs.writeFileSync(path.join(dir, `${p}.3`), `${dead}\n`);
    const judged = lookLeases(dir, [p]).free.get(p);
    assert.equal(judged, 3);
    // Meanwhile: taken (generation 4), released, taken again (5), and generation 4 removed as older.
    assert.ok(takePort(dir, p, 3));
    fs.writeFileSync(path.join(dir, `${p}.4`), "released\n");
    assert.ok(takePort(dir, p, 4));
    lookLeases(dir, [p]);
    assert.deepEqual(fs.readdirSync(dir), [`${p}.5`]);
    // The slow process now claims from what it judged: generation 4 can be made again, but it is not the newest.
    assert.equal(takePort(dir, p, judged!), null);
    assert.deepEqual(fs.readdirSync(dir), [`${p}.5`], "nothing of the slow claim is left");
    assert.equal(takePort(dir, p, 5 - 1), null, "and the newest generation is never made twice");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("busyPorts: finds this test's own listener by a bind test, and nothing on a free port", async () => {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen({ port: 0, host: "127.0.0.1" }, r));
  const taken = (srv.address() as net.AddressInfo).port;
  const free = await new Promise<number>((res) => { const s = net.createServer(); s.listen({ port: 0, host: "::", ipv6Only: false }, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
  try {
    assert.deepEqual([...busyPorts([taken, free])], [taken]);
  } finally {
    srv.close();
  }
});

test("busyPorts: a listener on a link-local address alone (fe80::1%lo0) is found; bind hosts carry their interface (review R6)", async () => {
  const hosts = bindHosts({ lo0: [{ address: "127.0.0.1", family: "IPv4" }, { address: "fe80::1", family: "IPv6" }], en0: [{ address: "fe80::aa%en0", family: "IPv6" }, { address: "192.168.1.5", family: "IPv4" }] } as never);
  assert.deepEqual(hosts, ["127.0.0.1", "::1", "::", "fe80::1%lo0", "fe80::aa%en0", "192.168.1.5"]);
  const srv = net.createServer();
  await new Promise<void>((r, j) => { srv.once("error", j); srv.listen({ port: 0, host: "fe80::1%lo0" }, r); });
  const taken = (srv.address() as net.AddressInfo).port;
  try {
    assert.deepEqual([...busyPorts([taken])], [taken], "a survivor on lo0's link-local address alone is busy");
  } finally {
    srv.close();
  }
});

// lsof -F pcn output, as recorded on a Mac (values changed): two Codex websockets, Jupyter, a Chrome
// debugger, a media server on two ports and both stacks, a mail helper, an ssh -L forward, relay's own proxy.
const LSOF = `p719
cControlCenter
f9
n*:7000
f10
n*:7000
p1001
cMedia Server
f12
n*:32400
f13
n127.0.0.1:32401
p1002
cmailhelper
f20
n127.0.0.1:1025
f21
n127.0.0.1:51125
p1003
ccodex
f5
n127.0.0.1:47201
p1004
cnode
f30
n127.0.0.1:61000
p1005
cpython3.12
f8
n[::1]:8888
n127.0.0.1:8888
p1006
cGoogle Chrome
f40
n127.0.0.1:9222
p1007
cssh
f3
n127.0.0.1:5433
p1008
cnode
f9
n127.0.0.1:52000
n127.0.0.1:52000->127.0.0.1:60000
p1009
cvanished
f1
n*:4000
`;
const ARGS = new Map<number, string>([
  [719, "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter"],
  [1001, "/Applications/Media Server.app/Contents/MacOS/Media Server"],
  [1002, "/Applications/Mail Helper.app/Contents/MacOS/mailhelper --grpc"],
  [1003, "/opt/homebrew/bin/codex exec-server --listen ws://127.0.0.1:47201"],
  [1004, "/Users/x/.local/share/fnm/node /Users/x/dev/relay/dist/cli.js serve"],
  [1005, "/opt/homebrew/bin/python3.12 /opt/homebrew/bin/jupyter-lab --no-browser"],
  [1006, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222"],
  [1007, "ssh -N -L 5433:db:5432 host"],
  [1008, "node server.js"],
]);

test("listening snapshot: parses lsof fields, control planes first, each port once", () => {
  const snap = parseListeningSnapshot(LSOF, ARGS);
  assert.deepEqual(snap.controlPlanes, [5433, 8888, 9222, 47201, 61000]);
  assert.deepEqual(snap.ports, [5433, 8888, 9222, 47201, 61000, 1025, 4000, 5000 + 2000, 32400, 32401, 51125, 52000].filter((p, i, a) => a.indexOf(p) === i));
  assert.ok(!snap.ports.includes(60000), "the far end of a connection is not a listener");
  assert.ok(snap.ports.includes(4000), "a process gone by the time of ps still counts, by its command name");
  for (const s of ["codex app-server --listen ws://127.0.0.1:1", "/usr/local/bin/claude remote-control", "node --inspect=9229 x.js", "socat TCP-LISTEN:1,fork TCP:h:2"]) {
    assert.ok(CONTROL_PLANE_PATTERNS.some((re) => re.test(s)), s);
  }
  for (const s of ["/Applications/Media Server.app/Contents/MacOS/Media Server", "node server.js", "ollama serve"]) {
    assert.ok(!CONTROL_PLANE_PATTERNS.some((re) => re.test(s)), s);
  }
});

// nettop -L 1 -m tcp -n -J state output, as recorded on macOS 27.0.1 (values changed): root's
// launchd (ssh, screen sharing) and kdc, a VPN extension, a mail helper, Codex's app with a dotted name,
// and connections, which are not listeners.
const NETTOP = `,state,
launchd.1,,
tcp6 *.22<->*.*,Listen,
tcp4 *:22<->*:*,Listen,
tcp4 *:5900<->*:*,Listen,
kdc.436,,
tcp6 *.88<->*.*,Listen,
apsd.425,,
tcp4 192.0.2.10:55508<->17.57.144.102:5223,Established,
com.example.vpn.1596,,
tcp4 *:443<->*:*,Listen,
tcp6 *.44822<->*.*,Listen,
tcp4 127.0.0.1:49171<->*:*,Listen,
rapportd.1044,,
tcp6 fe80::db8:0:c286:1bfe%en1.49152<->*.*,Listen,
tcp6 fe80::db8:0:c286:1bfe%en1.49152<->fe80::db8:0:2392:706%en1.51191,Established,
Codex (Service).1366,,
tcp4 192.0.2.10:49577<->104.18.32.47:443,Established,
mailhelper.1720,,
tcp4 127.0.0.1:1025<->*:*,Listen,
tcp6 ::1.7679<->*.*,Listen,
codex.1801,,
tcp4 127.0.0.1:61001<->*:*,Listen,
`;

test("listening snapshot: nettop's listeners, every user's, with their processes; another shape of output is refused (review R8)", () => {
  const l = nettopListeners(NETTOP);
  assert.deepEqual(l.map((x) => `${x.command}.${x.pid}:${x.port}`), [
    "launchd.1:22", "launchd.1:22", "launchd.1:5900", "kdc.436:88", "com.example.vpn.1596:443", "com.example.vpn.1596:44822", "com.example.vpn.1596:49171",
    "rapportd.1044:49152", "mailhelper.1720:1025", "mailhelper.1720:7679", "codex.1801:61001",
  ]);
  assert.ok(!l.some((x) => x.port === 5223 || x.port === 49577 || x.port === 51191), "connections are not listeners");
  // Together with lsof's (this user's, with command lines): one snapshot, control planes first.
  const snap = snapshotOf([...lsofListeners(LSOF), ...l], new Map([...ARGS, [1801, "/opt/homebrew/bin/codex app-server --listen ws://127.0.0.1:61001"]]));
  for (const p of [22, 88, 443, 5900, 44822, 49152]) assert.ok(snap.ports.includes(p), `root's or another user's ${p}`);
  assert.ok(snap.controlPlanes.includes(61001));
  assert.equal(new Set(snap.ports).size, snap.ports.length);
  for (const bad of ["", "time,,interface,state,\nlaunchd.1,,,\n", ",state,\nsomething else entirely\n", ",state,,extra,\n"]) assert.throws(() => nettopListeners(bad), /nettop/, JSON.stringify(bad));
  assert.deepEqual(nettopListeners(",state,\n"), [], "no listeners at all is an answer");
});

test("denied TCP ports: the static list, then control planes, then the rest; relay's range left to its own deny", () => {
  const snap = parseListeningSnapshot(LSOF, ARGS);
  const d = deniedTcpPorts(snap, { exec: 47210, block: [47211, 47212, 47213, 47214] });
  assert.deepEqual(d.slice(0, STATIC_DENIED_TCP.length), [...STATIC_DENIED_TCP]);
  assert.deepEqual(d.slice(STATIC_DENIED_TCP.length, STATIC_DENIED_TCP.length + 4), [5433, 8888, 9222, 61000]);
  assert.ok(!d.includes(47201), "a port in relay's range is covered by the range deny");
  assert.equal(d.filter((p) => p === 1025).length, 1, "a snapshot port once");
  const both = deniedTcpPorts({ ports: [STATIC_DENIED_TCP[0], 1025], controlPlanes: [] }, { exec: 47210, block: [47211, 47212, 47213, 47214] });
  assert.equal(both.filter((p) => p === STATIC_DENIED_TCP[0]).length, 1, "a static port the snapshot also found, once");
  assert.equal(new Set(d).size, d.length);
  // A listener on the turn's own block or executor port refuses the turn (review R6); elsewhere in the range it is the range deny's.
  assert.throws(() => deniedTcpPorts(snap, { exec: 47210, block: [47201, 47202, 47203, 47204] }), /47201 \(the job's block\).*does not start the turn/);
  assert.throws(() => deniedTcpPorts(snap, { exec: 47201, block: [47211, 47212, 47213, 47214] }), /47201 \(the executor's port\)/);
});

test("listening snapshot on this Mac: finds this test's own decoy listeners, a Jupyter-named one as a control plane", { skip: process.platform !== "darwin" && "lsof -F as on macOS" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2-snap-"));
  const script = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));setTimeout(()=>process.exit(0),60000)";
  fs.writeFileSync(path.join(dir, "jupyter-decoy.js"), script);
  fs.writeFileSync(path.join(dir, "plain-decoy.js"), script);
  const kids = ["jupyter-decoy.js", "plain-decoy.js"].map((f) => spawn(process.execPath, [path.join(dir, f)], { stdio: ["ignore", "pipe", "inherit"] }));
  try {
    const [jp, pp] = await Promise.all(kids.map((k) => new Promise<number>((r) => k.stdout!.once("data", (d) => r(Number(String(d).trim()))))));
    const snap = listeningSnapshot();
    assert.ok(snap.controlPlanes.includes(jp), "the Jupyter-named decoy is a control plane");
    assert.ok(snap.ports.includes(pp) && !snap.controlPlanes.includes(pp), "the plain decoy is listed, not as a control plane");
    assert.ok(snap.ports.indexOf(jp) < snap.ports.indexOf(pp));
    const free = rangePorts().filter((p) => !snap.ports.includes(p));
    assert.ok(deniedTcpPorts(snap, { exec: free[0], block: free.slice(1, 5) }).includes(pp));
    // nettop sees them too, with their pids: the source that also lists other users' listeners (review R8).
    const seen = nettopListeners(spawnSync("/usr/bin/nettop", ["-L", "1", "-m", "tcp", "-n", "-J", "state"], { encoding: "utf8" }).stdout);
    for (const [k, port] of kids.map((k, i) => [k, [jp, pp][i]] as const)) assert.ok(seen.some((x) => x.port === port && x.pid === k.pid), `nettop lists ${port} for pid ${k.pid}`);
  } finally {
    for (const k of kids) k.kill();
    await Promise.all(kids.map((k) => new Promise((r) => (k.exitCode !== null || k.signalCode ? r(null) : k.once("exit", r)))));
    for (const k of kids) assert.notEqual(spawnSync("/bin/ps", ["-p", String(k.pid)]).status, 0, `decoy ${k.pid} gone`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ifs = (extra: Record<string, os.NetworkInterfaceInfo[]> = {}) => ({
  lo0: [
    { address: "127.0.0.1", family: "IPv4" }, { address: "::1", family: "IPv6" }, { address: "fe80::1", family: "IPv6" },
  ],
  en1: [{ address: "192.0.2.10", family: "IPv4" }, { address: "fe80::db8:0:b364:1f2", family: "IPv6" }, { address: "FD00:db8::1", family: "IPv6" }],
  ...extra,
}) as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

test("interface addresses: canonical, link-local with its interface, sorted, each once", () => {
  const got = interfaceAddresses(ifs({ awdl0: [{ address: "fe80::db8:0:b364:1f2", family: "IPv6" } as os.NetworkInterfaceInfo], en2: [{ address: "::ffff:10.0.0.2", family: "IPv6" } as os.NetworkInterfaceInfo] }));
  assert.deepEqual(got, [
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "10.0.0.2",
    "127.0.0.1",
    "192.0.2.10",
    "fd00:0db8:0000:0000:0000:0000:0000:0001",
    "fe80:0000:0000:0000:0000:0000:0000:0001%lo0",
    "fe80:0000:0000:0000:0db8:0000:b364:01f2%awdl0",
    "fe80:0000:0000:0000:0db8:0000:b364:01f2%en1",
  ]);
  assert.ok(interfaceAddresses().includes("127.0.0.1"), "this Mac's own, by default");
});

test("interface watch: a new address is reported, once, and stays reported; one that goes away is not", async () => {
  let now = ["127.0.0.1", "192.0.2.10"];
  const w = watchInterfaces(now, 10, () => now);
  try {
    assert.equal(w.changed(), null);
    now = ["127.0.0.1"];
    assert.equal(w.changed(), null, "an address going away fails nothing");
    const told: string[] = [];
    w.onChange((what) => told.push(what));
    now = ["127.0.0.1", "100.64.0.9"];
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(told.length, 1, "told once");
    assert.match(told[0], /new 100\.64\.0\.9; gone 192\.0\.2\.10/);
    now = ["127.0.0.1", "192.0.2.10"];
    assert.equal(w.changed(), told[0], "a change stays reported after the address goes back");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(told.length, 1);
  } finally {
    w.stop();
  }
  // A change seen before onChange is registered is told on registration; a failing read is a change.
  const late = watchInterfaces(["a"], 60_000, () => ["a", "b"]);
  assert.match(late.changed() ?? "", /new b/);
  let got = "";
  late.onChange((w2) => (got = w2));
  assert.match(got, /new b/);
  late.stop();
  // IPv6 link-local churn (awdl0, llw0 rotate theirs) is not a change; a new global or IPv4 one still is.
  let ll = ["127.0.0.1", "fe80:0000:0000:0000:0000:0000:0000:0001%awdl0"];
  const churn = watchInterfaces(ll, 60_000, () => ll);
  ll = ["127.0.0.1", "fe80:0000:0000:0000:0000:0000:0000:0002%awdl0", "fe80:0000:0000:0000:0000:0000:0000:0003%llw0"];
  assert.equal(churn.changed(), null, "link-local churn fails nothing");
  ll = [...ll, "2001:0db8:0000:0000:0000:0000:0000:0001"];
  assert.match(churn.changed() ?? "", /new 2001:0db8/);
  churn.stop();
  const broken = watchInterfaces(["a"], 60_000, () => { throw new Error("boom"); });
  assert.match(broken.changed() ?? "", /could not read.*boom/);
  broken.stop();
});

test("loopback aliases refuse a stage-2 turn", () => {
  assert.equal(loopbackAliasProblem(ifs()), null);
  const p = loopbackAliasProblem(ifs({ lo0: [{ address: "127.0.0.1", family: "IPv4" }, { address: "127.0.0.2", family: "IPv4" }] as os.NetworkInterfaceInfo[] }));
  assert.match(p ?? "", /127\.0\.0\.2/);
});
