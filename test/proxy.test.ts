import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { confinement } from "../dist/confine/index.js";
import { allowlistHost, canonicalAddress, localInterfaceAddresses, localSubnets, onLink, openProxy, proxyEnv, publicAddress, screenAddresses } from "../dist/confine/proxy.js";
import { SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
// For its side effect: the test process gets a scratch HOME (see helpers.ts).
import "./helpers.ts";
import { useStoragePolicy } from "../dist/core/storage.js";

test("proxy: log_max_mb rotates proxy.jsonl between complete decision records", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-proxy-rotation-"));
  const file = path.join(dir, "proxy.jsonl");
  useStoragePolicy({ log_max_mb: 0.001 });
  const decisions: unknown[] = [];
  const proxy = await openProxy({ allow: [], logFile: file, onDecision: (d) => decisions.push(d) });
  try {
    // Cross one boundary: both files together must contain every decision, in order.
    for (let i = 0; i < 10; i++) await connectVia(proxy.port, `denied-${i}.example:443`, auth(proxy.token));
    assert.ok(fs.existsSync(`${file}.1`), "proxy.jsonl was rotated at the agent log's limit");
    assert.deepEqual([...readLog(`${file}.1`), ...readLog(file)], decisions, "no record was split or lost at rotation");
    for (const f of [file, `${file}.1`]) assert.ok(fs.statSync(f).size <= Math.round(0.001 * 1024 * 1024));
  } finally {
    await proxy.close();
    useStoragePolicy({ log_max_mb: null });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const macOS = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);

/** A plain TCP echo server on loopback: the stand-in for a vendor API, reached under a fake allowlisted name. */
async function echoServer() {
  const server = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const auth = (token: string, user = "relay") => `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

/** Sends one CONNECT and returns the status line; on 200, also what the tunnel echoes back for `ping`. */
function connectVia(port: number, target: string, authorization?: string): Promise<{ status: number; head: string; echoed?: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = "";
    let status = 0;
    let head = "";
    s.setEncoding("utf8");
    s.on("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n`));
    s.on("data", (d: string) => {
      buf += d;
      if (!status) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        head = buf.slice(0, end);
        status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
        buf = buf.slice(end + 4);
        if (status === 200) return void s.write("ping");
      }
      if (status === 200 && buf.length >= 4) {
        s.destroy();
        resolve({ status, head, echoed: buf });
      }
    });
    s.on("error", reject);
    s.on("close", () => resolve({ status, head }));
  });
}

const readLog = (f: string) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("proxy: an allowlisted name tunnels; other hosts, IP literals, other ports and plain HTTP are refused, and every decision is logged", async () => {
  const echo = await echoServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-proxy-"));
  const logFile = path.join(dir, "turn.log");
  const resolved: string[] = [];
  const proxy = await openProxy({
    allow: ["API.Vendor.test.", "other.vendor.test"], logFile, label: "j_1/7",
    testing: { resolve: async (h) => (resolved.push(h), ["127.0.0.1"]), upstreamPort: echo.port },
  });
  try {
    assert.deepEqual(proxy.network, { mode: "off-except-proxy", proxyPort: proxy.port, proxyToken: proxy.token });
    const ok = await connectVia(proxy.port, "api.vendor.test:443", auth(proxy.token));
    assert.equal(ok.status, 200, ok.head);
    assert.equal(ok.echoed, "ping", "bytes flow through the tunnel");
    assert.equal((await connectVia(proxy.port, "API.VENDOR.TEST.:443", auth(proxy.token))).status, 200, "names compare case- and trailing-dot-insensitively");

    for (const [target, code] of [
      ["example.com:443", 403], ["api.vendor.test:80", 403], ["api.vendor.test.evil.test:443", 403],
      ["127.0.0.1:443", 403], ["[::1]:443", 403], ["93.184.215.14:443", 403], ["no-port", 400],
    ] as const) {
      const r = await connectVia(proxy.port, target, auth(proxy.token));
      assert.equal(r.status, code, `${target}: ${r.head}`);
      assert.equal(r.echoed, undefined);
    }
    assert.deepEqual([...new Set(resolved)], ["api.vendor.test"], "only allowlisted names are ever resolved");

    const plain = await fetch(`http://127.0.0.1:${proxy.port}/`).then((r) => r.status);
    assert.equal(plain, 405);

    const log = readLog(logFile);
    assert.ok(log.every((d) => d.turn === "j_1/7" && typeof d.t === "string"));
    assert.deepEqual(log.filter((d) => d.event === "allow").map((d) => [d.target, d.address]), [["api.vendor.test:443", "127.0.0.1"], ["API.VENDOR.TEST.:443", "127.0.0.1"]]);
    const reasons = Object.fromEntries(log.filter((d) => d.event === "deny").map((d) => [d.target, d.reason]));
    assert.equal(reasons["example.com:443"], "host-not-allowlisted");
    assert.equal(reasons["api.vendor.test:80"], "port-not-443");
    assert.equal(reasons["127.0.0.1:443"], "ip-literal");
    assert.equal(reasons["[::1]:443"], "ip-literal");
    assert.equal(reasons["GET /"], "not-connect");
    assert.ok(!fs.readFileSync(logFile, "utf8").includes(proxy.token), "the token is never logged");
  } finally {
    await proxy.close();
    await echo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("proxy: a missing or wrong token, or another turn's, gets 407 with a challenge", async () => {
  const echo = await echoServer();
  const testing = { resolve: async () => ["127.0.0.1"], upstreamPort: echo.port };
  const a = await openProxy({ allow: ["api.vendor.test"], testing });
  const b = await openProxy({ allow: ["api.vendor.test"], testing });
  try {
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.port, b.port);
    for (const authorization of [undefined, auth("wrong"), auth(b.token), `Bearer ${a.token}`, auth(a.token.slice(0, -1)), `Basic ${Buffer.from(a.token).toString("base64")}`]) {
      const r = await connectVia(a.port, "api.vendor.test:443", authorization);
      assert.equal(r.status, 407, `${authorization}: ${r.head}`);
      assert.match(r.head, /Proxy-Authenticate: Basic realm="relay"/);
      assert.match(r.head, /Connection: close/);
    }
    assert.equal((await connectVia(a.port, "api.vendor.test:443", auth(a.token, "anyone"))).status, 200, "the user name is not checked, the token is");
    assert.equal((await connectVia(b.port, "api.vendor.test:443", auth(b.token))).status, 200);
  } finally {
    await a.close();
    await b.close();
    await echo.close();
  }
});

test("proxy: names that resolve to loopback or private addresses are refused; closing drops open tunnels", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-proxy-"));
  const logFile = path.join(dir, "turn.log");
  // `localhost` resolves without any network: the real resolver path, with its public-address check.
  const proxy = await openProxy({ allow: ["localhost"], logFile });
  try {
    const r = await connectVia(proxy.port, "localhost:443", auth(proxy.token));
    assert.equal(r.status, 403, r.head);
    assert.equal(readLog(logFile).at(-1).reason, "private-address");
  } finally {
    await proxy.close();
  }

  const echo = await echoServer();
  const p2 = await openProxy({ allow: ["api.vendor.test"], testing: { resolve: async () => ["127.0.0.1"], upstreamPort: echo.port } });
  const s = net.connect(p2.port, "127.0.0.1");
  await new Promise<void>((res) => s.on("connect", () => res()));
  s.write(`CONNECT api.vendor.test:443 HTTP/1.1\r\nProxy-Authorization: ${auth(p2.token)}\r\n\r\n`);
  await new Promise<void>((res) => s.once("data", () => res()));
  const gone = new Promise<void>((res) => s.on("close", () => res()));
  await p2.close();
  await gone;
  await assert.rejects(connectVia(p2.port, "api.vendor.test:443", auth(p2.token)), /ECONNREFUSED/);
  await echo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("proxy: address and host-name checks", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "not an ip",
    // Azure's metadata endpoint, a public-range address, and its IPv4-mapped IPv6 forms (review X3).
    "168.63.129.16", "::ffff:168.63.129.16", "::ffff:a83f:8110"]) {
    assert.equal(publicAddress(ip), false, ip);
  }
  for (const ip of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(publicAddress(ip), true, ip);

  assert.equal(allowlistHost(" API.Example.COM. "), "api.example.com");
  for (const bad of ["1.2.3.4", "::1", "[::1]", "*.googleapis.com", "a..b", "-a.com", "a b.com", "", "x".repeat(64) + ".com", "host:443"]) {
    assert.throws(() => allowlistHost(bad), /IP literal|not a host name/, bad);
  }

  const env = proxyEnv(4321, "tok");
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) assert.equal(env[k], "http://relay:tok@127.0.0.1:4321", k);
  assert.equal(env.NO_PROXY, "");
  assert.equal(env.no_proxy, "");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("proxy e2e: under the Seatbelt profile the harness reaches an allowlisted host only through the turn's proxy", { skip: !macOS && "macOS only" }, async () => {
  const found = confinement();
  assert.ok("mechanism" in found);
  const echo = await echoServer();
  const proxy = await openProxy({ allow: ["api.vendor.test"], testing: { resolve: async () => ["127.0.0.1"], upstreamPort: echo.port } });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-proxy-e2e-")));
  try {
    const wt = path.join(root, "wt");
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(wt);
    fs.mkdirSync(tmp);
    const launch = found.mechanism.wrap({ worktree: wt, worktreeWritable: true, tmpDir: tmp, denied: [], network: proxy.network }, process.execPath, [
      "-e",
      `
      const net = require("node:net");
      const u = new URL(process.env.HTTPS_PROXY);
      const tryConnect = (port, send) => new Promise((res) => {
        const s = net.connect(port, "127.0.0.1");
        let got = "";
        s.on("connect", () => send ? s.write(send) : (s.destroy(), res("connected")));
        s.on("data", (d) => { got += d; if (got.includes("ping")) { s.destroy(); res(got.slice(0, 12) + "|" + got.slice(-4)); } else if (got.includes("\\r\\n\\r\\n")) s.write("ping"); });
        s.on("error", (e) => res(e.code));
      });
      (async () => {
        const auth = "Basic " + Buffer.from("relay:" + decodeURIComponent(u.password)).toString("base64");
        const viaProxy = await tryConnect(Number(u.port), "CONNECT api.vendor.test:443 HTTP/1.1\\r\\nProxy-Authorization: " + auth + "\\r\\n\\r\\n");
        const direct = await tryConnect(${echo.port});
        console.log(JSON.stringify({ viaProxy, direct, noProxy: process.env.NO_PROXY, nodeEnvProxy: process.env.NODE_USE_ENV_PROXY }));
      })();
      `,
    ]);
    // Not spawnSync: the proxy runs in this process and must keep answering.
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn(launch.command, launch.args, { cwd: wt, env: { PATH: "/usr/bin:/bin", ...launch.env } });
      let stdout = "";
      let stderr = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stderr += d));
      c.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.viaProxy, "HTTP/1.1 200|ping", "the tunnel through the proxy works from inside");
    assert.equal(out.direct, "EPERM", "the same server, connected to directly, is refused by the sandbox");
    assert.equal(out.noProxy, "");
    assert.equal(out.nodeEnvProxy, "1");
  } finally {
    await proxy.close();
    await echo.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("proxy: a lookup that finishes after close() opens no upstream connection (review r_faba9d17 X3)", async () => {
  let connections = 0;
  const live = new Set<net.Socket>();
  const server = net.createServer((s) => (connections++, live.add(s), s.pipe(s)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let asked!: () => void;
  const lookedUp = new Promise<void>((r) => (asked = r));
  const proxy = await openProxy({ allow: ["api.vendor.test"], testing: { resolve: async () => (asked(), await gate, ["127.0.0.1"]), upstreamPort: port } });
  const s = net.connect(proxy.port, "127.0.0.1");
  s.on("error", () => {});
  try {
    await new Promise<void>((r) => s.on("connect", () => r()));
    s.write(`CONNECT api.vendor.test:443 HTTP/1.1\r\nProxy-Authorization: ${auth(proxy.token)}\r\n\r\n`);
    await lookedUp;
    await proxy.close();
    release();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(connections, 0, "nothing was opened upstream after the proxy closed");
  } finally {
    s.destroy();
    for (const c of live) c.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("proxy: a name resolving to one of this machine's own interface addresses is refused, even though it is a public address (hardening 7)", () => {
  // A public address that is not on this machine passes; the same address, were it one of ours, does not.
  const publicIp = "93.184.215.14";
  assert.deepEqual(screenAddresses([publicIp], new Set()), { addresses: [publicIp] });
  assert.deepEqual(screenAddresses([publicIp], new Set([publicIp])), { reason: "local-interface-address", address: publicIp });
  // A private answer still refuses first, whatever the interface list.
  assert.deepEqual(screenAddresses(["10.0.0.1", publicIp], new Set()), { reason: "private-address", address: "10.0.0.1" });
  // An IPv6 interface address compares in canonical form, so a zone id, compression and case do not matter (review C5).
  const ownV6 = (addr: string) => new Set([canonicalAddress(addr)]);
  assert.deepEqual(screenAddresses(["2606:4700::1111"], ownV6("2606:4700::1111%en0")), { reason: "local-interface-address", address: "2606:4700::1111" }, "a zone on the interface side");
  assert.deepEqual(screenAddresses(["2606:4700::1111%en0"], ownV6("2606:4700:0000:0000:0000:0000:0000:1111")), { reason: "local-interface-address", address: "2606:4700::1111%en0" }, "full form vs compressed");
  // An IPv4-mapped/compatible or hex IPv6 form of the machine's own public address is caught too (review C5).
  for (const mapped of ["::ffff:93.184.216.34", "::ffff:5db8:d822", "::93.184.216.34"]) {
    assert.deepEqual(screenAddresses([mapped], ownV6("93.184.216.34")), { reason: "local-interface-address", address: mapped }, mapped);
  }
  // The machine's loopback is in the set but is caught as private first; the set is non-empty here.
  assert.ok(localInterfaceAddresses().has("127.0.0.1"));
});

test("proxy: when a name resolves to several addresses, a dead one is passed over for a live one (hardening 7)", async () => {
  const echo = await echoServer();
  // 127.0.0.2 has nothing listening (ECONNREFUSED at once); 127.0.0.1 is the echo server.
  const proxy = await openProxy({ allow: ["api.vendor.test"], testing: { resolve: async () => ["127.0.0.2", "127.0.0.1"], upstreamPort: echo.port } });
  try {
    const r = await connectVia(proxy.port, "api.vendor.test:443", auth(proxy.token));
    assert.equal(r.status, 200, r.head);
    assert.equal(r.echoed, "ping", "the tunnel reached the live address");
  } finally {
    await proxy.close();
    await echo.close();
  }
});

// ---- Public mode (Claude turns with the network, relay 1.0.5) ----

/** An IPv6 address as its sixteen bytes (an IPv4-mapped one as ::ffff: and its four). */
function v6Bytes(ip: string): Buffer {
  const c = canonicalAddress(ip);
  if (net.isIPv4(c)) return Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, ...c.split(".").map(Number)]);
  return Buffer.from(c.split(":").flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]));
}

/** Sends one SOCKS5 CONNECT (no authentication) for `host` (a name, or an IPv4 or IPv6 literal) and returns the reply code; on 0, also what the tunnel echoes back for `ping`. */
function socksVia(port: number, host: string, dport: number, cmd = 1, at = "127.0.0.1"): Promise<{ code: number; echoed?: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, at);
    let buf = Buffer.alloc(0);
    let stage = 0;
    s.on("connect", () => s.write(Buffer.from([5, 1, 0])));
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        buf = buf.subarray(2);
        stage = 1;
        const kind = net.isIP(host);
        const addr = kind === 4 ? Buffer.from([1, ...host.split(".").map(Number)])
          : kind === 6 ? Buffer.concat([Buffer.from([4]), v6Bytes(host)])
            : Buffer.concat([Buffer.from([3, host.length]), Buffer.from(host)]);
        const p = Buffer.alloc(2);
        p.writeUInt16BE(dport);
        s.write(Buffer.concat([Buffer.from([5, cmd, 0]), addr, p]));
      }
      if (stage === 1 && buf.length >= 10) {
        const code = buf[1];
        buf = buf.subarray(10);
        stage = 2;
        if (code !== 0) return void (s.destroy(), resolve({ code }));
        s.write("ping");
      }
      if (stage === 2 && buf.length >= 4) {
        s.destroy();
        resolve({ code: 0, echoed: buf.toString() });
      }
    });
    s.on("error", reject);
    s.on("close", () => resolve({ code: -1 }));
  });
}

/** A plain-HTTP request through the proxy (absolute-form), returning the status and body. */
function httpVia(port: number, url: string, headers: Record<string, string> = {}, at = "127.0.0.1"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let authority; try { authority = new URL(url).host; } catch {}
    const req = http.request({ host: at, port, path: url, headers: { ...(authority ? { host: authority } : {}), ...headers }, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("proxy public: one port on 127.0.0.1 and ::1 tunnels, forwards plain HTTP and SOCKS5 to a name, with or without the token", async () => {
  const echo = await echoServer();
  const seen: { url?: string; headers?: http.IncomingHttpHeaders } = {};
  const web = http.createServer((req, res) => {
    seen.url = req.url;
    seen.headers = req.headers;
    res.writeHead(200, { "content-type": "text/plain", "keep-alive": "timeout=5" }).end("hello");
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  const decisions: { event: string; via?: string; target: string; token?: boolean; reason?: string }[] = [];
  const tunnel = await openProxy({ mode: "public", allow: [], onDecision: (d) => decisions.push(d), testing: { resolve: async () => ["127.0.0.1"], upstreamPort: echo.port } });
  const plain = await openProxy({ mode: "public", allow: [], testing: { resolve: async () => ["127.0.0.1"], upstreamPort: (web.address() as net.AddressInfo).port } });
  try {
    assert.equal(tunnel.authenticated(), false);
    for (const target of ["api.vendor.test:443", "git.vendor.test:22", "api.vendor.test:8443"]) {
      const r = await connectVia(tunnel.port, target);
      assert.equal(r.status, 200, `${target} without a token: ${r.head}`);
      assert.equal(r.echoed, "ping");
    }
    assert.equal(tunnel.authenticated(), false, "requests without the token do not count as the harness's");
    assert.equal((await connectVia(tunnel.port, "api.vendor.test:443", auth("wrong"))).status, 200, "a wrong token is no token: still public egress only");
    assert.equal(tunnel.authenticated(), false);
    assert.equal((await connectVia(tunnel.port, "api.vendor.test:443", auth(tunnel.token))).status, 200);
    assert.equal(tunnel.authenticated(), true);
    assert.deepEqual(await socksVia(tunnel.port, "git.vendor.test", 22), { code: 0, echoed: "ping" });
    assert.deepEqual(await socksVia(tunnel.port, "git.vendor.test", 22, 1, "::1"), { code: 0, echoed: "ping" }, "the same port answers on ::1");
    assert.equal((await connectVia(tunnel.port, "no-port")).status, 400);
    assert.equal((await socksVia(tunnel.port, "git.vendor.test", 22, 2)).code, 7, "SOCKS BIND is not offered");
    const viaLog = decisions.filter((d) => d.event === "allow").map((d) => `${d.via} ${d.target} ${d.token}`);
    assert.ok(viaLog.includes("CONNECT git.vendor.test:22 false") && viaLog.includes("SOCKS5 git.vendor.test:22 false") && viaLog.includes("CONNECT api.vendor.test:443 true"), viaLog.join("\n"));

    const r = await httpVia(plain.port, "http://www.vendor.test:8080/p?q=1", { host: "www.vendor.test:8080", "proxy-authorization": auth(plain.token), "proxy-connection": "keep-alive", "x-keep": "1" });
    assert.deepEqual(r, { status: 200, body: "hello" });
    assert.equal(seen.url, "/p?q=1", "the request goes upstream in origin form");
    assert.equal(seen.headers?.host, "www.vendor.test:8080", "the client's Host is kept");
    assert.equal(seen.headers?.["proxy-authorization"], undefined, "the token never goes upstream");
    assert.equal(seen.headers?.["proxy-connection"], undefined);
    assert.equal(seen.headers?.["x-keep"], "1");
    assert.equal(plain.authenticated(), true);
    assert.equal((await httpVia(plain.port, "/origin-form")).status, 400, "only absolute http:// URLs are forwarded");
  } finally {
    await tunnel.close();
    await plain.close();
    await echo.close();
    await new Promise<void>((r) => web.close(() => r()));
  }
});

test("proxy public: loopback, private, shared, link-local, unique-local and metadata literals are refused on every route, and nothing is dialled", async () => {
  const decisions: { event: string; reason?: string }[] = [];
  const proxy = await openProxy({ mode: "public", allow: [], onDecision: (d) => decisions.push(d), testing: { local: new Set(), subnets: [] } });
  try {
    const v4 = ["127.0.0.1", "127.0.0.2", "0.0.0.0", "10.1.2.3", "172.16.0.1", "192.168.1.20", "100.100.1.1", "169.254.169.254", "168.63.129.16", "224.0.0.1"];
    const v6 = ["::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "fe80::1", "fd7a:115c:a1e0::1", "fc00::1"];
    for (const ip of [...v4, ...v6]) {
      const hostport = `${net.isIPv6(ip) ? `[${ip}]` : ip}:8080`;
      const c = await connectVia(proxy.port, hostport);
      assert.equal(c.status, 403, `CONNECT ${hostport}: ${c.head}`);
      assert.match(c.head, /X-Relay-Refused: private-address/);
      const h = await httpVia(proxy.port, `http://${hostport}/`);
      assert.equal(h.status, 403, `GET ${hostport}`);
      assert.match(h.body, /public addresses only/);
      assert.equal((await socksVia(proxy.port, ip, 8080)).code, 2, `SOCKS5 ${ip}`);
    }
    // Legacy spellings never reach a name lookup that would read them as loopback: refused as names
    // with a lookup (getaddrinfo reads 2130706433 as 127.0.0.1), or as malformed.
    for (const odd of ["2130706433", "127.1", "0x7f.1"]) assert.equal((await connectVia(proxy.port, `${odd}:8080`)).status, 403, odd);
    assert.ok(decisions.every((d) => d.event === "deny"), "no connection was opened");
  } finally {
    await proxy.close();
  }
});

test("proxy public: a name resolving to a non-public, own or on-link address is refused, looked up once per request", async () => {
  const lookups: string[] = [];
  const answers: Record<string, string[]> = {
    "lo.test": ["127.0.0.1"], "mixed.test": ["8.8.8.8", "10.0.0.1"], "own.test": ["93.184.215.14"],
    "lan6.test": ["2606:4700:20:abcd::99"], "lan4.test": ["203.0.114.7"], "mapped.test": ["::ffff:203.0.114.9"],
  };
  const proxy = await openProxy({
    mode: "public", allow: [],
    testing: {
      lookup: async (h) => (lookups.push(h), answers[h] ?? []),
      local: new Set(["93.184.215.14"]), subnets: ["2606:4700:20:abcd:1:2:3:4/64", "203.0.114.1/24"],
    },
  });
  try {
    const want: Record<string, string> = {
      "lo.test": "private-address", "mixed.test": "private-address", "own.test": "local-interface-address",
      "lan6.test": "on-link-address", "lan4.test": "on-link-address", "mapped.test": "on-link-address",
    };
    for (const [name, reason] of Object.entries(want)) {
      const r = await connectVia(proxy.port, `${name}:443`);
      assert.equal(r.status, 403, name);
      assert.match(r.head, new RegExp(`X-Relay-Refused: ${reason}`), name);
    }
    assert.equal((await socksVia(proxy.port, "lan6.test", 22)).code, 2);
    assert.equal((await httpVia(proxy.port, "http://lan4.test/")).status, 403);
    assert.equal((await connectVia(proxy.port, "nothing.test:443")).status, 403, "a name with no address");
    const bad = await connectVia(proxy.port, "bad!name.test:443");
    assert.equal(bad.status, 403);
    assert.match(bad.head, /X-Relay-Refused: bad-host/, "a malformed name is never looked up");
    assert.deepEqual(lookups, [...Object.keys(want), "lan6.test", "lan4.test", "nothing.test"], "one lookup per request, the dialled address being the screened one");
  } finally {
    await proxy.close();
  }
});

test("proxy: the on-link check covers this machine's subnets, IPv4-mapped forms included, in both modes' screening", () => {
  const subnets = ["192.168.0.20/24", "2606:4700:20:abcd:1:2:3:4/64", "fe80::1%en0/64", "not-a-cidr"];
  assert.equal(onLink("2606:4700:20:abcd::99", subnets), true);
  assert.equal(onLink("2606:4700:20:abce::99", subnets), false);
  assert.equal(onLink("192.168.0.9", subnets), true);
  assert.equal(onLink("::ffff:192.168.0.9", subnets), true);
  assert.equal(onLink("192.168.1.9", subnets), false);
  assert.deepEqual(screenAddresses(["2606:4700:20:abcd::99"], new Set(), subnets), { reason: "on-link-address", address: "2606:4700:20:abcd::99" });
  assert.deepEqual(screenAddresses(["2606:4700::1111"], new Set(), subnets), { addresses: ["2606:4700::1111"] });
  // Read afresh from the machine: its loopback subnet is there.
  assert.ok(localSubnets().some((c) => c.startsWith("127.")));
});

test("proxy: allowlist mode reports a token-authenticated CONNECT, and the public mode refuses an allowlist", async () => {
  const echo = await echoServer();
  const p = await openProxy({ allow: ["api.vendor.test"], testing: { resolve: async () => ["127.0.0.1"], upstreamPort: echo.port } });
  try {
    assert.equal(p.authenticated(), false);
    await connectVia(p.port, "api.vendor.test:443");
    assert.equal(p.authenticated(), false);
    await connectVia(p.port, "api.vendor.test:443", auth(p.token));
    assert.equal(p.authenticated(), true);
  } finally {
    await p.close();
    await echo.close();
  }
  await assert.rejects(openProxy({ mode: "public", allow: ["api.vendor.test"] }), /no allowlist/);
});

test("proxy public: token hosts are recorded; a model stub serves only plain-HTTP token requests for its name", async () => {
  const echo = await echoServer();
  const web = http.createServer((_req, res) => res.writeHead(200).end("stub"));
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  const p = await openProxy({ mode: "public", allow: [], modelStub: { host: "api.anthropic.com", port: (web.address() as net.AddressInfo).port }, testing: { lookup: async () => ["10.0.0.1"], local: new Set(), subnets: [] } });
  const tunnel = await openProxy({ mode: "public", allow: [], testing: { resolve: async () => ["127.0.0.1"], upstreamPort: echo.port } });
  try {
    assert.equal((await httpVia(p.port, "http://api.anthropic.com/v1/messages")).status, 403, "without the token the name is screened as usual (here it resolves to a private address)");
    assert.deepEqual([...p.tokenHosts()], []);
    assert.deepEqual(await httpVia(p.port, "http://api.anthropic.com/v1/messages", { "proxy-authorization": auth(p.token) }), { status: 200, body: "stub" });
    assert.equal((await connectVia(p.port, "127.0.0.1:443", auth(p.token))).status, 403, "the token opens nothing else on loopback");
    assert.deepEqual([...p.tokenHosts()].sort(), ["127.0.0.1", "api.anthropic.com"]);
    // A tunnel's host is recorded when its CONNECT carries the token, not otherwise.
    await connectVia(tunnel.port, "plain.vendor.test:443");
    assert.equal((await connectVia(tunnel.port, "api.vendor.test:443", auth(tunnel.token))).echoed, "ping");
    assert.deepEqual([...tunnel.tokenHosts()], ["api.vendor.test"]);
  } finally {
    await p.close();
    await tunnel.close();
    await echo.close();
    await new Promise<void>((r) => web.close(() => r()));
  }
  for (const bad of [{ host: "not a host", port: 1 }, { host: "x.invalid", port: 1.5 }, { host: "x.invalid", port: 70000 }]) {
    await assert.rejects(openProxy({ mode: "public", allow: [], modelStub: bad }), /host name and a port/);
  }
});
