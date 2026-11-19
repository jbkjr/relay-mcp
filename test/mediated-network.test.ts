import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMediatedNetworkProvider, MEDIATED_NETWORK_EFFECT, mediatedLookup, mediatedNetworkProblem, setMediatedNetworkProviderForTests } from "../dist/core/mediated-network-provider.js";
import { Resolver } from "node:dns/promises";
import dns from "node:dns";
import { resolveNeverPolicy } from "../dist/core/never-policy.js";
import { stage2NetworkRules, checkStage2Network } from "../dist/confine/seatbelt-stage2.js";
import { neverSeatbeltRules } from "../dist/confine/seatbelt-never.js";
import { screenAddresses } from "../dist/confine/proxy.js";
import { requiredDecider, escalationEffect } from "../dist/core/escalation-policy.js";
import { withDefaults } from "../dist/core/config.js";

const base = { mode: "stage2", deniedTcp: [49160], deniedUdp: [49161], relayRange: [49201, 49202, 49203], execPort: 49201, bindPorts: [], worktreeSockets: false, egress: "none" } as const;
const policy = (never = {}) => resolveNeverPolicy({ builtins: false, never });
const caps = [{ kind: "network", mode: "mediated" }] as const;
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve: v => resolve(v) }; };

test("worker DNS fakes: follows full CNAME chain, refuses loops, cancellation reaches resolver", async t => {
  let looping = false, pending = false, rejectPending, cancels = 0;
  t.mock.method(Resolver.prototype, "resolveCname", async name => {
    if (pending) return new Promise((_ok, reject) => rejectPending = reject);
    return looping ? [name] : name === "origin.test" ? ["middle.test"] : name === "middle.test" ? ["target.test"] : [];
  });
  t.mock.method(Resolver.prototype, "resolve4", async name => { assert.equal(name, "target.test"); return ["8.8.8.8"]; });
  t.mock.method(Resolver.prototype, "resolve6", async () => []);
  t.mock.method(Resolver.prototype, "cancel", () => { cancels++; rejectPending?.(new Error("DNS cancelled")); });
  const c = new AbortController();
  assert.deepEqual(await mediatedLookup("origin.test", c.signal), { addresses: ["8.8.8.8"], cnames: ["middle.test", "target.test"] });
  looping = true; await assert.rejects(mediatedLookup("origin.test", c.signal), /CNAME loop/);
  pending = true;
  const answer = mediatedLookup("origin.test", c.signal); const rejected = assert.rejects(answer, /cancelled/);
  await Promise.resolve(); c.abort(); await rejected;
  assert.ok(cancels >= 3);
});

test("provider fakes: cancellation during listener preparation closes partial resource", async () => {
  const controller = new AbortController(), opened = deferred(), release = deferred(); let closed = 0;
  const provider = createMediatedNetworkProvider({ open: async () => {
    opened.resolve(); await release.promise; return { port: 49202, close: async () => { closed++; } };
  } });
  const preparing = provider.prepare({ capabilities: caps, policy: policy(), baseline: undefined, network: base, spec: { signal: controller.signal }, env: {}, tmpDir: "/tmp", proxyPort: 49202 });
  const rejected = assert.rejects(preparing, /ended/);
  await opened.promise; controller.abort(); release.resolve(); await rejected;
  assert.equal(closed, 1);
});

async function fixture(p = policy(), lookup = async () => ({ addresses: ["8.8.8.8"], cnames: [] }), signal?) {
  let options, closes = 0;
  const provider = createMediatedNetworkProvider({ lookup, open: async o => {
    options = o;
    return { port: o.listen.port, close: async () => { closes++; } };
  } });
  const context = { capabilities: caps, baseline: undefined, policy: p, network: base, spec: { signal }, env: {}, tmpDir: "/tmp", proxyPort: 49202 };
  const launch = await provider.prepare(context);
  return { provider, context, launch, options, closes: () => closes, resolve: (host, port = 443) => options.publicPolicy.resolve(host, port) };
}

test("mediated provider without never hosts: OS lookup and underscore names retain port and resolved-address denies", async t => {
  const lookedUp = [];
  t.mock.method(Resolver.prototype, "resolveCname", () => assert.fail("must use the OS resolver"));
  t.mock.method(dns.promises, "lookup", async (host, options) => {
    lookedUp.push(host); assert.deepEqual(options, { all: true, verbatim: true });
    return (host === "mixed_name.test" ? ["8.8.8.8", "::ffff:909:909"] : ["8.8.8.8"]).map(address => ({ address }));
  });
  const p = { ...policy({ ports: [{ port: 49444 }, { port: 49445, destinations: "this-machine" }] }), localAddresses: ["9.9.9.9"] };
  let screen;
  const provider = createMediatedNetworkProvider({ open: async o => { screen = o.publicPolicy; return { port: 49202, close: async () => {} }; } });
  const launch = await provider.prepare({ capabilities: caps, baseline: undefined, policy: p, network: base, spec: {}, env: {}, tmpDir: "/tmp", proxyPort: 49202 });
  try {
    assert.deepEqual(await screen.resolve("os_name.test", 443), ["8.8.8.8"]);
    await assert.rejects(screen.resolve("os_name.test", 49444), /never.*49444/);
    await assert.rejects(screen.resolve("mixed_name.test", 49445), /never.*49445/);
    await assert.rejects(screen.resolve("-invalid.test", 443), /not a host name/);
    assert.deepEqual(lookedUp, ["os_name.test", "mixed_name.test"]);
  } finally { await launch.close(); }
});

test("mediated provider with never hosts: direct DNS traverses CNAMEs and rejects forbidden aliases", async t => {
  t.mock.method(dns.promises, "lookup", () => assert.fail("a host floor requires CNAME-aware DNS"));
  const names = [];
  t.mock.method(Resolver.prototype, "resolveCname", async host => {
    names.push(host); return ["forbidden.test", "alias.test"].includes(host) ? ["common.test"] : [];
  });
  t.mock.method(Resolver.prototype, "resolve4", async () => ["8.8.8.8"]);
  t.mock.method(Resolver.prototype, "resolve6", async () => []);
  let screen;
  const provider = createMediatedNetworkProvider({ open: async o => { screen = o.publicPolicy; return { port: 49202, close: async () => {} }; } });
  const launch = await provider.prepare({ capabilities: caps, baseline: undefined, policy: policy({ hosts: ["forbidden.test"] }), network: base, spec: {}, env: {}, tmpDir: "/tmp", proxyPort: 49202 });
  try {
    await assert.rejects(screen.resolve("alias.test", 443), /forbidden CNAME/);
    assert.ok(names.includes("alias.test")); assert.ok(names.includes("common.test"));
  } finally { await launch.close(); }
});

test("mediated provider: leased IPv4 proxy, executor variables only, egress none and authority wording", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.options.listen, { port: 49202, ipv4Only: true });
    assert.equal(f.options.mode, "public"); assert.deepEqual(f.options.allow, []);
    assert.equal(f.launch.network.egress, "none"); assert.equal(f.launch.network.mediatedPort, 49202);
    assert.equal(f.launch.appEnv, undefined, "the app server and broker secret get no proxy variables");
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) assert.equal(f.launch.executorEnv[key], "http://127.0.0.1:49202");
    assert.equal(f.launch.executorEnv.NO_PROXY, ""); assert.equal(f.launch.executorEnv.no_proxy, "");
    const cfg = withDefaults({});
    assert.equal(requiredDecider(caps, cfg), "owning_run_root");
    for (const mode of ["raw", "local"]) assert.equal(requiredDecider([{ kind: "network", mode }], cfg), "person");
    assert.match(escalationEffect({ capabilities: caps }), /Public hosts.*Tools must honour proxy settings/);
    assert.match(MEDIATED_NETWORK_EFFECT, /Opaque tunnels/);
    assert.equal(f.provider.qualify({ ...f.context, baseline: { network: true, raw_network: true } })?.includes("cannot be combined"), true);
    assert.match(f.provider.qualify({ ...f.context, capabilities: [] }), /standing network grant or an explicit one-turn/);
    assert.equal(f.provider.qualify({ ...f.context, capabilities: [], baseline: { network: true } }), null);
    setMediatedNetworkProviderForTests(undefined);
    assert.match(mediatedNetworkProblem(f.context), /no qualified mediated provider/);
    await assert.rejects(f.provider.prepare({ ...f.context, proxyPort: undefined }), /leased proxy port/);
  } finally { setMediatedNetworkProviderForTests(null); await f.launch.close(); await f.launch.close(); }
  assert.equal(f.closes(), 1);
});

test("mediated never: authority, every address, mapped spellings, CNAME and redirect ports", async () => {
  const p = policy({ hosts: ["forbidden.test", "9.9.9.9"], ports: [{ port: 49444, destinations: "any" }] });
  const f = await fixture(p, async host => host === "forbidden.test" ? { addresses: ["1.1.1.1"], cnames: ["blocked-alias.test"] }
    : host === "cname.test" ? { addresses: ["8.8.8.8"], cnames: ["blocked-alias.test"] }
    : host === "bad-target.test" ? { addresses: ["8.8.8.8", "::ffff:909:909"], cnames: [] }
    : { addresses: ["8.8.8.8"], cnames: [] });
  try {
    for (const host of ["forbidden.test", "FORBIDDEN.test.", "9.9.9.9", "::ffff:9.9.9.9", "::9.9.9.9", "::ffff:0:909:909", "0:0:0:0:0:ffff:909:909", "1.1.1.1", "cname.test", "bad-target.test"]) await assert.rejects(f.resolve(host), /never/, host);
    for (const host of ["2130706433", "0177.0.0.1", "127.1"]) await assert.rejects(f.resolve(host), /never|canonical/);
    assert.deepEqual(await f.resolve("allowed.test"), ["8.8.8.8"]);
    // The proxy does not follow redirects: the client's next request is a fresh screen.
    await assert.rejects(f.resolve("allowed.test", 49444), /never.*49444/);
  } finally { await f.launch.close(); }
});

test("mediated never refresh: fail closed on unavailable/stale DNS; retain rebinding endpoints", async () => {
  let forbidden = "1.1.1.1", broken = false;
  const f = await fixture(policy({ hosts: ["forbidden.test"] }), async host => {
    if (broken) throw new Error("DNS unavailable");
    return { addresses: [host === "forbidden.test" ? forbidden : "8.8.8.8"], cnames: [] };
  });
  try {
    forbidden = "9.9.9.9";
    await assert.rejects(f.resolve("9.9.9.9"), /never/);
    await assert.rejects(f.resolve("1.1.1.1"), /never/);
    broken = true;
    await assert.rejects(f.resolve("allowed.test"), /DNS unavailable/);
  } finally { await f.launch.close(); }
  let time = 0;
  // Capture the policy through the fake proxy instead of opening any listener.
  let screen;
  const delayed = createMediatedNetworkProvider({ now: () => time, lookup: async host => {
    if (host === "allowed.test") time += 60000;
    return { addresses: [host === "forbidden.test" ? "1.1.1.1" : "8.8.8.8"], cnames: [] };
  }, open: async o => { screen = o.publicPolicy.resolve; return { port: 49202, close: async () => {} }; } });
  const launch = await delayed.prepare({ ...f.context, spec: {} });
  try { await assert.rejects(screen("allowed.test", 443), /fresh validated/); } finally { await launch.close(); }
  await assert.rejects(fixture(policy({ hosts: ["unresolvable.test"] }), async () => ({ addresses: [], cnames: [] })), /cannot resolve/);
});

test("mediated teardown cancels pending worker DNS and forbids subsequent requests", async () => {
  const entered = deferred(); let cancelled = false;
  const f = await fixture(policy(), async (_host, signal) => {
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(new Error("DNS cancelled")); }, { once: true }));
  });
  const pending = f.resolve("allowed.test"); await entered.promise;
  const rejected = assert.rejects(pending, /cancelled/);
  await f.launch.close(); await rejected;
  assert.equal(cancelled, true); assert.equal(f.closes(), 1);
  await assert.rejects(f.resolve("8.8.8.8"), /ended/);
});

test("mediated profile keeps final never/control floors and additive IPv4 connects", async () => {
  const f = await fixture();
  try {
    const params = new Map(); const param = (k, v) => { params.set(k, v); return `(param "${k}")`; };
    const rules = stage2NetworkRules(f.launch.network, param, "", { tmpDir: "/tmp", worktree: "/tmp/work" });
    assert.match(rules, /remote ip4 \(string-append "localhost:" \(param "MEDIATED_PORT"\)\)/);
    assert.doesNotMatch(rules, /remote ip4 "\*:\*"|mDNSResponder|local udp/);
    assert.doesNotThrow(() => checkStage2Network({ ...f.launch.network, connectPorts: [49220] }));
    assert.throws(() => checkStage2Network({ ...f.launch.network, connectPorts: [49202] }), /protected/);
    const floor = { ...policy(), authorityPorts: [49201, 49202, 49204] };
    const final = neverSeatbeltRules(floor, param, "", { worktree: "/tmp/work", tmpDir: "/tmp", execPort: 49201, bindPorts: [49203], mediatedPort: 49202 }).join("\n");
    assert.match(final, /remote ip6.*NEVER_CONTROL_1/);
    assert.doesNotMatch(final, /remote ip4.*NEVER_CONTROL_1/);
    assert.match(final, /network-bind network-inbound.*NEVER_CONTROL_1/);
    assert.match(final, /remote ip4.*NEVER_CONTROL_2/);
    assert.ok("reason" in screenAddresses(["8.8.8.8"], new Set(["8.8.8.8"]), []), "own public address refused");
    assert.ok("reason" in screenAddresses(["8.8.8.9"], new Set(), ["8.8.8.0/24"]), "on-link public address refused");
    assert.ok("reason" in screenAddresses(["::ffff:127.0.0.1"], new Set(), []));
  } finally { await f.launch.close(); }
});
