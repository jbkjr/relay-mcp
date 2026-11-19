import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import { Resolver } from "node:dns/promises";
import { openProxy } from "../dist/confine/proxy.js";
import { resolveNeverPolicy, neverEndpointProblem } from "../dist/core/never-policy.js";

class Socket extends EventEmitter {
  destroyed = false; written = "";
  pause() {} resume() {} setTimeout() {} pipe() {} unshift() {}
  write(b) { this.written += String(b); }
  end(b = "") { this.write(b); this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}

// Exercise the production HTTP/CONNECT/SOCKS handlers and teardown without a kernel bind.
async function harness(t, resolve = async () => ["8.8.8.8"], options = {}) {
  let requestHandler, accept, connected = 0;
  const bindings = [];
  const server = Object.assign(new EventEmitter(), {
    listen(port, host, cb) { bindings.push({ host, port }); cb(); },
    address: () => ({ port: 49202 }), close(cb) { cb(); },
  });
  t.mock.method(http, "createServer", fn => { requestHandler = fn; return server; });
  const listener = () => Object.assign(new EventEmitter(), {
    listen(o, cb) { bindings.push(o); cb(); },
    address: () => ({ port: 49202 }), close(cb) { cb(); },
  });
  t.mock.method(net, "createServer", fn => { accept = fn; return listener(); });
  const upstreams = [];
  t.mock.method(net, "connect", o => { connected++; assert.equal(o.host, options.modelStub ? "127.0.0.1" : "8.8.8.8"); const s = new Socket(); upstreams.push(s); return s; });
  const proxy = await openProxy({ mode: "public", allow: [], listen: { port: 49202, ipv4Only: true }, ...(resolve ? { publicPolicy: { resolve } } : {}), testing: { local: new Set(), subnets: [] }, ...options });
  const client = () => { const c = new Socket(); if (options.mode === "allowlist") server.emit("connection", c); else accept(c); return c; };
  return { proxy, upstreams, bindings, connected: () => connected, client,
    connect(c = client(), target = "allowed.test:443", token = false) {
      const headers = token ? { "proxy-authorization": `Basic ${Buffer.from(`relay:${proxy.token}`).toString("base64")}` } : {};
      server.emit("connect", { headers, url: target }, c, Buffer.alloc(0)); return c;
    },
    async http(url, host, token = false) {
      const req = Object.assign(new Socket(), { url, headers: { host, ...(token ? { "proxy-authorization": `Basic ${Buffer.from(`relay:${proxy.token}`).toString("base64")}` } : {}) }, method: "GET" });
      const res = Object.assign(new Socket(), { status: 0, writeHead(status) { this.status = status; return this; } });
      await requestHandler(req, res); return res;
    },
  };
}
const tick = () => new Promise(r => setImmediate(r));

test("public proxy fakes: mismatched HTTP Host refused before policy/DNS/dial", async t => {
  let screens = 0; const h = await harness(t, async () => { screens++; return ["8.8.8.8"]; });
  try {
    const res = await h.http("http://allowed.test/path", "forbidden.test");
    assert.equal(res.status, 400); assert.match(res.written, /disagree/);
    assert.equal(screens, 0); assert.equal(h.connected(), 0);
  } finally { await h.proxy.close(); }
});

test("public proxy fakes: close during pending DNS never dials", async t => {
  let finish;
  const h = await harness(t, () => new Promise(resolve => finish = resolve));
  const c = h.connect(); await h.proxy.close(); finish(["8.8.8.8"]); await tick();
  assert.equal(c.destroyed, true); assert.equal(h.connected(), 0);
});

test("public proxy fakes: close destroys pending connects and live tunnels", async t => {
  const h = await harness(t);
  const pending = h.connect(); await tick();
  const live = h.connect(); await tick(); h.upstreams[1].emit("connect"); await tick();
  assert.match(live.written, /200 Connection Established/);
  assert.equal(pending.destroyed, false); assert.equal(live.destroyed, false);
  await h.proxy.close(); await tick();
  assert.equal(pending.destroyed, true); assert.equal(live.destroyed, true);
  assert.ok(h.upstreams.every(s => s.destroyed));
});

test("public proxy fakes: new CONNECT and SOCKS requests each screen the requested port", async t => {
  const seen = [];
  const h = await harness(t, async (host, port) => { seen.push([host, port]); throw new Error("never"); });
  try {
    const c = h.connect(); await tick(); assert.match(c.written, /403/);
    const socks = h.client(); socks.read = () => Buffer.from([5, 1, 0, 5, 1, 0, 1, 8, 8, 8, 8, 0xc1, 0x24]);
    socks.emit("readable"); await tick();
    assert.deepEqual(seen, [["allowed.test", 443], ["8.8.8.8", 49444]]);
    assert.equal(h.connected(), 0);
  } finally { await h.proxy.close(); }
});

// Exercise the standalone adapter path with production DNS traversal, faking only DNS answers
// and sockets. No request reaches a real host or any protected service port.
function dnsFixture(t, lookup = async host => host === "forbidden.test" ? ["1.1.1.1"] : ["8.8.8.8"]) {
  t.mock.method(Resolver.prototype, "resolveCname", async host => host === "cname.test" ? ["forbidden-alias.test"] : host === "forbidden.test" ? ["forbidden-alias.test"] : []);
  t.mock.method(Resolver.prototype, "resolve4", lookup);
  t.mock.method(Resolver.prototype, "resolve6", async () => []);
}
const floor = (never = {}) => resolveNeverPolicy({ builtins: false, never });

for (const [label, never, allowed] of [
  ["positive mapping", {}, true],
  ["forbidden authority", { hosts: ["model.relay-test.invalid"] }, false],
  ["forbidden mapped port", { ports: [{ port: 49555, transport: "tcp", destinations: "this-machine" }] }, false],
  ["forbidden address alias", { hosts: ["127.0.0.1"] }, false],
]) test(`synthetic model endpoint: ${label} retains never without DNS`, async t => {
  t.mock.method(dns.promises, "lookup", () => assert.fail("synthetic model mapping must not use DNS"));
  t.mock.method(Resolver.prototype, "resolveCname", () => assert.fail("synthetic model mapping must not use CNAME DNS"));
  t.mock.method(http, "request", () => new Socket());
  const host = "model.relay-test.invalid";
  const h = await harness(t, null, { modelStub: { host, port: 49555 }, neverPolicy: floor(never) });
  try {
    const result = h.http(`http://${host}/messages`, host, true);
    await tick();
    if (allowed) { assert.equal(h.connected(), 1); h.upstreams[0].emit("connect"); }
    const response = await result;
    assert.equal(h.connected(), allowed ? 1 : 0);
    if (!allowed) assert.equal(response.status, 403);
  } finally { await h.proxy.close(); }
});

test("Claude public proxy: never screens host, port, every resolved address and CNAME without requiring a token", async t => {
  dnsFixture(t, async host => host === "forbidden-alias.test" || host === "address-alias.test" ? ["1.1.1.1"]
    : host === "mixed.test" ? ["8.8.8.8", "::ffff:909:909"] : ["8.8.8.8"]);
  const h = await harness(t, null, { listen: undefined, neverPolicy: floor({ hosts: ["forbidden.test", "9.9.9.9"], ports: [{ port: 49444 }] }) });
  try {
    assert.deepEqual(h.bindings.map(b => b.host), ["127.0.0.1", "::1"]);
    const allowed = h.connect(); await tick();
    assert.equal(h.connected(), 1); h.upstreams[0].emit("connect"); await tick();
    assert.match(allowed.written, /200 Connection Established/);
    assert.equal(h.proxy.authenticated(), false, "Claude sandbox callers need no token");
    for (const target of ["forbidden.test:443", "allowed.test:49444", "address-alias.test:443", "9.9.9.9:443", "mixed.test:443", "cname.test:443"]) {
      const denied = h.connect(undefined, target); await tick();
      assert.match(denied.written, /403/, target);
    }
    for (const url of ["http://forbidden.test/", "http://allowed.test:49444/"]) {
      const res = await h.http(url, new URL(url).host); assert.equal(res.status, 403);
    }
    const socks = h.client();
    socks.read = () => Buffer.from([5, 1, 0, 5, 1, 0, 1, 9, 9, 9, 9, 1, 187]);
    socks.emit("readable"); await tick();
    assert.equal(socks.written, String(Buffer.from([5, 0])) + String(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])));
    assert.equal(h.connected(), 1, "denials never dial");
  } finally { await h.proxy.close(); }
});

test("ACP allowlist proxy: never refuses allowlisted authorities and address aliases; authentication and allowlist still apply", async t => {
  dnsFixture(t, async host => host === "address-alias.test" ? ["9.9.9.9"] : host === "forbidden-alias.test" ? ["1.1.1.1"] : ["8.8.8.8"]);
  const h = await harness(t, null, { mode: "allowlist", allow: ["allowed.test", "forbidden.test", "address-alias.test"], neverPolicy: floor({ hosts: ["forbidden.test", "9.9.9.9"] }) });
  try {
    const missingToken = h.connect(); assert.match(missingToken.written, /407/);
    for (const target of ["forbidden.test:443", "address-alias.test:443", "not-allowlisted.test:443", "allowed.test:444"]) {
      const denied = h.connect(undefined, target, true); await tick(); assert.match(denied.written, /403/, target);
    }
    assert.equal(h.connected(), 0);
    const allowed = h.connect(undefined, "allowed.test:443", true); await tick();
    assert.equal(h.connected(), 1); h.upstreams[0].emit("connect"); await tick();
    assert.match(allowed.written, /200 Connection Established/);
    assert.equal(h.proxy.authenticated(), true);
  } finally { await h.proxy.close(); }
});

test("ACP allowlist proxy: an allowlisted model API still passes never port checks", async t => {
  dnsFixture(t);
  const h = await harness(t, null, { mode: "allowlist", allow: ["allowed.test"], neverPolicy: floor({ ports: [{ port: 443 }] }) });
  try {
    const denied = h.connect(undefined, "allowed.test:443", true); await tick();
    assert.match(denied.written, /403/); assert.equal(h.connected(), 0);
  } finally { await h.proxy.close(); }
});

for (const mode of ["public", "allowlist"]) test(`WP6 ${mode} proxy: built-in service ports never dial, positive allowed-port control works`, async t => {
  dnsFixture(t);
  t.mock.method(dns.promises, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  // These are rules-only fake socket requests. No kernel listener or real service is contacted.
  const builtins = resolveNeverPolicy({ home: "/owned/scratch/home" });
  const h = await harness(t, null, { mode, allow: mode === "allowlist" ? ["allowed.test"] : [], neverPolicy: builtins });
  try {
    for (const port of [22, 5900]) {
      assert.ok(builtins.ports.some(p => p.port === port));
      assert.match(neverEndpointProblem(builtins, { host: "127.0.0.1", port, transport: "tcp" })!, /never/);
      const denied = h.connect(undefined, `127.0.0.1:${port}`, true); await tick();
      assert.match(denied.written, /403/); assert.equal(h.connected(), 0);
    }
    const allowed = h.connect(undefined, "allowed.test:443", true); await tick();
    assert.equal(h.connected(), 1); h.upstreams[0].emit("connect"); await tick();
    assert.match(allowed.written, /200 Connection Established/);
  } finally { await h.proxy.close(); }
});

test("WP6 public proxy: alternative and mapped loopback spellings never dial", async t => {
  t.mock.method(dns.promises, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  const h = await harness(t, null, { neverPolicy: floor() });
  try {
    for (const target of ["2130706433:443", "0177.0.0.1:443", "0x7f000001:443", "[::ffff:127.0.0.1]:443", "127.1:443"]) {
      const denied = h.connect(undefined, target); await tick();
      assert.match(denied.written, /403|400/, target); assert.equal(h.connected(), 0);
    }
  } finally { await h.proxy.close(); }
});

for (const mode of ["public", "allowlist"]) {
  test(`${mode} never proxy: failed/stale forbidden DNS fails closed; rebinding retains earlier endpoints`, async t => {
    let forbidden = "1.1.1.1", broken = false, stale = false, time = 0;
    t.mock.method(Date, "now", () => time);
    dnsFixture(t, async host => {
      if (broken) throw new Error("DNS unavailable");
      if (stale && host === "allowed.test") time += 60_000;
      return [host === "forbidden-alias.test" ? forbidden : host === "old-address.test" ? "1.1.1.1" : "8.8.8.8"];
    });
    const h = await harness(t, null, { mode, allow: mode === "allowlist" ? ["allowed.test", "old-address.test"] : [], neverPolicy: floor({ hosts: ["forbidden.test"] }) });
    try {
      forbidden = "9.9.9.9";
      const rebound = h.connect(undefined, "old-address.test:443", true); await tick();
      assert.match(rebound.written, /403/);
      forbidden = "1.1.1.1";
      const retained = h.connect(undefined, "old-address.test:443", true); await tick();
      assert.match(retained.written, /403/);
      broken = true;
      const failed = h.connect(undefined, "allowed.test:443", true); await tick(); assert.match(failed.written, /403/);
      broken = false; stale = true;
      const expired = h.connect(undefined, "allowed.test:443", true); await tick(); assert.match(expired.written, /403/);
      assert.equal(h.connected(), 0);
    } finally { await h.proxy.close(); }
  });
}

test("standalone never proxy: unresolvable forbidden hosts fail before binding", async t => {
  dnsFixture(t, async () => []);
  t.mock.method(net, "createServer", () => { assert.fail("must not bind before forbidden DNS is validated"); });
  await assert.rejects(openProxy({ mode: "public", allow: [], neverPolicy: floor({ hosts: ["unresolvable.test"] }) }), /no numeric endpoint/);
});

test("standalone never proxy: close cancels pending DNS and prevents subsequent requests", async t => {
  let entered, rejectPending, cancels = 0;
  const started = new Promise(resolve => entered = resolve);
  t.mock.method(Resolver.prototype, "resolveCname", () => { entered(); return new Promise((_ok, reject) => rejectPending = reject); });
  t.mock.method(Resolver.prototype, "cancel", () => { cancels++; rejectPending?.(new Error("DNS cancelled")); });
  const h = await harness(t, null, { neverPolicy: floor({ hosts: ["9.9.9.9"] }) });
  const client = h.connect(); await started; await h.proxy.close(); await tick();
  assert.ok(cancels > 0); assert.equal(client.destroyed, true); assert.equal(h.connected(), 0);
});

test("standalone never proxy without hosts: OS lookup preserves underscore names and screens every address and port", async t => {
  const lookups = [];
  t.mock.method(Resolver.prototype, "resolveCname", () => assert.fail("no forbidden hosts need CNAME DNS"));
  t.mock.method(dns.promises, "lookup", async (host, options) => {
    lookups.push(host); assert.deepEqual(options, { all: true, verbatim: true });
    return (host === "mixed_name.test" ? ["8.8.8.8", "::ffff:909:909"] : ["8.8.8.8"]).map(address => ({ address }));
  });
  const p = { ...floor({ ports: [{ port: 49444, destinations: "any" }, { port: 49445, destinations: "this-machine" }] }), localAddresses: ["9.9.9.9"] };
  const h = await harness(t, null, { neverPolicy: p });
  try {
    const allowed = h.connect(undefined, "os_name.test:443"); await tick();
    assert.equal(h.connected(), 1); h.upstreams[0].emit("connect"); await tick();
    assert.match(allowed.written, /200 Connection Established/);
    const deniedPort = h.connect(undefined, "os_name.test:49444"); await tick();
    assert.match(deniedPort.written, /403/);
    const deniedAddress = h.connect(undefined, "mixed_name.test:49445"); await tick();
    assert.match(deniedAddress.written, /403/);
    const invalid = h.connect(undefined, "-invalid.test:443"); await tick(); assert.match(invalid.written, /403/);
    assert.deepEqual(lookups, ["os_name.test", "mixed_name.test"]);
    assert.equal(h.connected(), 1);
  } finally { await h.proxy.close(); }
});
