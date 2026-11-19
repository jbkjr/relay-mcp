import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { stage2NetworkRules, checkStage2Network } from "../dist/confine/seatbelt-stage2.js";
import { neverSeatbeltRules } from "../dist/confine/seatbelt-never.js";
import { resolveNeverPolicy } from "../dist/core/never-policy.js";

const net = (extra = {}) => ({ mode: "stage2" as const, deniedTcp: [49221], deniedUdp: [49222], relayRange: [49230, 49231, 49232, 49233], execPort: 49230, bindPorts: [], worktreeSockets: false, egress: "none" as const, ...extra });
function rules(n = net()) { const params: Record<string,string> = {}; return { text: stage2NetworkRules(n, (key, value) => { params[key] = value; return `(param "${key}")`; }, '(with message "decoy")', { tmpDir: "/owned/tmp", worktree: "/owned/work" }), params }; }

test("narrow overlay profile has no raw outbound, DNS or UDP listener authority", () => {
  const p = rules();
  assert.doesNotMatch(p.text, /allow network-outbound \(remote ip[46] "\*:\*"/);
  assert.doesNotMatch(p.text, /mDNSResponder|dnssd|allow network-bind network-inbound \(local udp/);
  assert.match(p.text, /allow network-bind network-inbound \(local tcp .*EXEC_PORT/);
});
test("approved IPv4 localhost connect compiles the disclosed localhost host token", () => {
  const p = rules(net({ connectPorts: [49240] }));
  assert.match(p.text, /allow network-outbound \(remote ip4 \(string-append "localhost:" \(param "CONNECT_PORT_0"\)\)\)/);
  assert.doesNotMatch(p.text, /allow network-outbound \(remote ip6/);
});
test("localhost listen adds no connect authority", () => {
  const listen = rules(net({ relayRange: [49230, 49231, 49232], bindPorts: [49233], listenPorts: [49240] }));
  assert.match(listen.text, /allow network-bind network-inbound .*LISTEN_PORT_0/);
  assert.doesNotMatch(listen.text, /CONNECT_PORT/);
});
test("port0 allow precedes final snapshot and reserved bind/inbound denies; executor startup survives", () => {
  const p = rules(net({ relayRange: [49230, 49231, 49232], bindPorts: [49233], broadBind: true }));
  assert.match(p.text, /0.0.0.0, on the LAN/);
  const broad = p.text.indexOf('(allow network-bind network-inbound (local tcp "*:*")');
  assert.ok(broad >= 0 && broad < p.text.indexOf('(deny network-inbound'));
  assert.match(p.text, /deny network-bind network-inbound .*RELAY_LISTEN_DENY/);
  assert.deepEqual(Object.entries(p.params).filter(([key]) => key.startsWith("RELAY_LISTEN_DENY")).map(([,v]) => Number(v)), [49231,49232]);
  assert.doesNotMatch(p.text, /allow network-outbound \(remote ip/);
});
test("typed network refuses reserved, denied and malformed exact exceptions", () => {
  for (const extra of [{ connectPorts: [49230] }, { listenPorts: [49230] }, { connectPorts: [0] }, { listenPorts: [65536] }, { connectPorts: [22] }, { listenPorts: [631] }, { egress: "unqualified" }]) assert.throws(() => checkStage2Network(net(extra)), /invalid|protected|static denied/);
  const connect = rules(net({ relayRange: [49230, 49231, 49232], bindPorts: [49233], connectPorts: [49221], broadBind: true }));
  assert.ok(connect.text.indexOf("CONNECT_PORT_0") > connect.text.indexOf('(deny network-outbound'));
  const listen = rules(net({ relayRange: [49230, 49231, 49232], bindPorts: [49233], listenPorts: [49221] }));
  assert.ok(listen.text.indexOf("LISTEN_PORT_0") > listen.text.indexOf('(deny network-inbound'));
  assert.doesNotMatch(listen.text, /allow network-outbound/);
});
test("generated overlay network addresses contain only Seatbelt's supported host tokens", () => {
  for (const extra of [{}, { connectPorts: [49240] }, { relayRange: [49230, 49231, 49232], bindPorts: [49233], listenPorts: [49240] }, { relayRange: [49230, 49231, 49232], bindPorts: [49233], broadBind: true }, { relayRange: [49230, 49231, 49232], bindPorts: [49233], egress: "raw" }]) {
    const p = rules(net(extra));
    const policy = resolveNeverPolicy({ builtins: false, never: { ports: [{ port: 49223, transport: "both", destinations: "this-machine" }] } });
    const floor = neverSeatbeltRules(policy, (k,v) => { p.params[k] = v; return `(param "${k}")`; }, "", { worktree: "/owned/work", tmpDir: "/owned/tmp" }).join("\n");
    const profile = (p.text + "\n" + floor).replace(/\(param "([^"]+)"\)/g, (_, k) => JSON.stringify(p.params[k]));
    assert.doesNotMatch(profile, /\((?:remote|local)\s+(?:ip[46]?|tcp|udp)\s+(?:\(string-append\s+)?"(?:\d+\.\d+\.\d+\.\d+|\[?::1)/);
    const hosts = [...profile.matchAll(/\((?:remote|local)\s+(?:ip[46]?|tcp|udp)\s+(?:\(string-append\s+)?"([^" ]+):/g)].map(m => m[1]);
    assert.ok(hosts.length > 0);
    assert.ok(hosts.every(h => h === "localhost" || h === "*"), JSON.stringify(hosts));
  }
});
test("final never floor denies write/read/test/link and both listener operations after broad binds", () => {
  const policy = resolveNeverPolicy({ builtins: false, never: { paths: [{ path: "/owned/forbidden", access: "all" }, { path: "/owned/install", access: "write" }], ports: [{ port: 49223, transport: "both", destinations: "this-machine" }] } });
  const params: Record<string,string> = {};
  const final = neverSeatbeltRules(policy, (k,v) => { params[k]=v; return `(param "${k}")`; }, '(with message "decoy")', { worktree: "/owned/work", tmpDir: "/owned/tmp" }).join("\n");
  assert.match(final, /deny file-read\* file-read-data file-read-metadata file-test-existence file-write\*/);
  assert.match(final, /file-write-data file-write-create file-write-unlink file-write-mode file-link/);
  assert.match(final, /deny network-bind network-inbound \(local tcp/);
  assert.match(final, /deny network-bind network-inbound \(local udp/);
  assert.match(final, /require-all \(remote ip6/);
  assert.equal(params.NEVER_PORT_0, "49223");
});
