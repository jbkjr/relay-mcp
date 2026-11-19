// A Codex job's shell network (backends/codex-network.ts): through Codex's own network proxy,
// strict by default and local only with the person's consent, verified before any agent runs, and
// Codex's hosted web search only where relay cannot verify the proxy. Approval requests that would
// add the network to one command of a session without the proxy are declined by relay itself.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { harness, hostFor, INTERACTIVE_CLAUDE, task, until, type Harness, type Rec, type Rule } from "./helpers.ts";
import { canaryProblem, CANARY_SCRIPT, codexNonPublicIp, codexRuleFolders, networkRuleFiles, openCanaryTargets, ownPublicAddress } from "../dist/backends/codex-network.js";
import { addsNetwork, autoDenial, configProblem, connect, featuresProblem, type Expected } from "../dist/backends/codex-app.js";
import { codexFlags, codexPermissions } from "../dist/backends/codex.js";
import { withDefaults } from "../dist/core/config.js";
import { localNetworkKey } from "../dist/core/session.js";
import { targetDef } from "../dist/targets/index.js";

const appServer = withDefaults({ codex_backend: "app-server" });

test("codex network: Codex's proxy's own classification of non-public addresses, ported with its boundaries", () => {
  const nonPublic = [
    "0.0.0.0", "0.255.255.255", "10.0.0.0", "10.255.255.255", "100.64.0.0", "100.127.255.255", "127.0.0.1", "127.255.255.255",
    "169.254.0.0", "169.254.255.255", "172.16.0.0", "172.31.255.255", "192.0.0.0", "192.0.0.255", "192.0.2.0", "192.0.2.255",
    "192.168.0.0", "192.168.255.255", "198.18.0.0", "198.19.255.255", "198.51.100.0", "198.51.100.255", "203.0.113.0", "203.0.113.255",
    "224.0.0.0", "239.255.255.255", "240.0.0.0", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "::127.0.0.1", "::0.0.0.1",
    "fc00::", "fdff:ffff::1", "fd7a:115c:a1e0::1", "fe80::", "febf:ffff::1", "fe80::1%en0", "ff00::", "ff02::1",
    "not an address",
  ];
  const isPublic = [
    "1.0.0.0", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0", "169.253.255.255", "169.255.0.0",
    "172.15.255.255", "172.32.0.0", "192.0.1.0", "192.0.3.0", "192.167.255.255", "192.169.0.0", "198.17.255.255", "198.20.0.0",
    "198.51.99.255", "198.51.101.0", "203.0.112.255", "203.0.114.0", "223.255.255.255", "8.8.8.8",
    // Public to Codex's proxy although relay's own blocks them: it judges by these ranges alone.
    "192.88.99.1", "168.63.129.16", "2001:db8::1", "64:ff9b::808:808", "fec0::1", "2002::1",
    "::ffff:8.8.8.8", "::8.8.8.8", "2606:4700::1111", "fe00::1", "fec0::",
  ];
  for (const ip of nonPublic) assert.equal(codexNonPublicIp(ip), true, ip);
  for (const ip of isPublic) assert.equal(codexNonPublicIp(ip), false, ip);
});

test("codex network: an address of this Mac's own that either proxy calls public keeps a turn out of strict mode, naming it", () => {
  const iface = (address: string, internal = false) => ({ address, internal, family: address.includes(":") ? "IPv6" : "IPv4", netmask: "", mac: "", cidr: null }) as never;
  // As on the maintainer's Mac: loopback, a LAN address, Tailscale's CGNAT and ULA addresses, link-local ones.
  assert.equal(ownPublicAddress({ lo0: [iface("127.0.0.1", true), iface("::1", true)], en0: [iface("192.0.2.10"), iface("fe80::db8:0:b364:1f2%en0"), iface("fd00:db8:0:0::1")], utun4: [iface("100.64.0.1"), iface("fd7a:115c:a1e0::1")] }), null);
  const global = ownPublicAddress({ en0: [iface("192.0.2.10"), iface("2606:4700:10:1::5")] });
  assert.equal(global?.address, "2606:4700:10:1::5");
  assert.match(global!.why, /interface en0 has the address 2606:4700:10:1::5, which Codex's network proxy treats as public, so a command could reach this Mac's own services through the proxy/);
  // Codex alone calls it public; still kept out.
  assert.equal(ownPublicAddress({ en1: [iface("2001:db8::7")] })?.address, "2001:db8::7");
  assert.equal(ownPublicAddress({ en1: [iface("93.184.216.34")] })?.address, "93.184.216.34");
  // An internal interface counts too: a public address aliased on lo0 is still this Mac's (review r_17565c33 X2).
  assert.equal(ownPublicAddress({ lo0: [iface("127.0.0.1", true), iface("93.184.216.34", true)] })?.address, "93.184.216.34");
  assert.equal(ownPublicAddress({ lo0: [iface("127.0.0.1", true), iface("::1", true), iface("fe80::1%lo0", true)] }), null);
});

test("codex network: the rules folders Codex would read, and any network_rule in them as plain text, fail closed", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-rules-")));
  try {
    const cwd = path.join(root, "repo", "sub");
    fs.mkdirSync(cwd, { recursive: true });
    const folders = codexRuleFolders({
      layers: [{ name: { type: "user", file: "/u/.codex/config.toml" } }, { name: { type: "system", file: "/etc/codex/config.toml" } }, { name: { type: "project", dotCodexFolder: "/p/.codex" } }, { name: { type: "mdm", domain: "x", key: "y" } }, null],
      env: { CODEX_HOME: path.join(root, "ch"), HOME: "/h" }, cwd,
    });
    for (const f of ["/u/.codex", "/etc/codex", "/p/.codex", path.join(root, "ch"), path.join(cwd, ".codex"), path.join(root, "repo", ".codex"), path.join(root, ".codex"), "/.codex"]) assert.ok(folders.includes(f), f);
    // Without CODEX_HOME: ~/.codex.
    assert.ok(codexRuleFolders({ env: { HOME: "/h" }, cwd: "/" }).includes("/h/.codex"));

    const user = path.join(root, "ch"), project = path.join(root, "repo", ".codex");
    fs.mkdirSync(path.join(user, "rules"), { recursive: true });
    fs.writeFileSync(path.join(user, "rules", "default.rules"), 'prefix_rule(pattern=["git", "status"], decision="allow")\n');
    fs.writeFileSync(path.join(user, "rules", "notes.txt"), "network_rule is mentioned in a file Codex does not load\n");
    assert.deepEqual(networkRuleFiles([user, path.join(root, "missing")]), { files: [] });
    fs.mkdirSync(path.join(project, "rules"), { recursive: true });
    fs.writeFileSync(path.join(project, "rules", "net.rules"), '# any form counts\nnetwork_rule(host="127.0.0.1", protocol="http", decision="allow")\n');
    assert.deepEqual(networkRuleFiles([user, project]), { files: [path.join(project, "rules", "net.rules")] });
    // A rules folder that is a file is no folder; one that cannot be read refuses.
    fs.writeFileSync(path.join(root, "flat"), "");
    fs.mkdirSync(path.join(root, "f2"));
    fs.writeFileSync(path.join(root, "f2", "rules"), "");
    assert.deepEqual(networkRuleFiles([path.join(root, "f2")]), { files: [] });
    fs.chmodSync(path.join(user, "rules", "default.rules"), 0o000);
    const unreadable = networkRuleFiles([user]);
    assert.ok("error" in unreadable && unreadable.error.includes("default.rules"), JSON.stringify(unreadable));
    fs.chmodSync(path.join(user, "rules", "default.rules"), 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("codex network: the canary's output is read for the mode, and relay's own listeners count what reaches them", async () => {
  const strictOk = { proxy: "http://127.0.0.1:61000", loop: "EPERM", unix: "EPERM", viaProxy: "HTTP/1.1 403 Forbidden" };
  assert.equal(canaryProblem(JSON.stringify(strictOk), "strict", { tcp: 0, unix: 0 }), null);
  assert.equal(canaryProblem(`noise\n${JSON.stringify({ ...strictOk, loop: "EACCES" })}\n`, "strict", { tcp: 0, unix: 0 }), null);
  assert.match(canaryProblem(JSON.stringify(strictOk), "strict", { tcp: 1, unix: 0 })!, /reached relay's own test listener \(1 connection\)/);
  assert.match(canaryProblem(JSON.stringify(strictOk), "strict", { tcp: 0, unix: 2 })!, /\(2 connections\)/);
  assert.match(canaryProblem(JSON.stringify({ ...strictOk, proxy: null }), "strict", { tcp: 0, unix: 0 })!, /was not given Codex's network proxy/);
  assert.match(canaryProblem(JSON.stringify({ ...strictOk, proxy: "http://10.0.0.1:3128" }), "strict", { tcp: 0, unix: 0 })!, /was not given Codex's network proxy/);
  assert.match(canaryProblem(JSON.stringify({ ...strictOk, loop: "connected" }), "strict", { tcp: 0, unix: 0 })!, /loopback directly/);
  assert.match(canaryProblem(JSON.stringify({ ...strictOk, loop: "ECONNREFUSED" }), "strict", { tcp: 0, unix: 0 })!, /loopback directly/);
  assert.match(canaryProblem(JSON.stringify({ ...strictOk, unix: "connected" }), "strict", { tcp: 0, unix: 0 })!, /Unix socket/);
  assert.match(canaryProblem(JSON.stringify({ ...strictOk, viaProxy: "HTTP/1.1 200 OK" }), "strict", { tcp: 0, unix: 0 })!, /did not refuse a request for this Mac's loopback/);
  assert.match(canaryProblem("not json", "strict", { tcp: 0, unix: 0 })!, /printed no result/);
  // Local: loopback is open by design; the proxy and the socket are still checked.
  assert.equal(canaryProblem(JSON.stringify({ ...strictOk, loop: "connected", viaProxy: "HTTP/1.1 200 OK" }), "local", { tcp: 2, unix: 0 }), null, "loopback reaching relay's port is local mode's point");
  assert.match(canaryProblem(JSON.stringify(strictOk), "local", { tcp: 0, unix: 1 })!, /reached relay's own test listener/);
  assert.match(canaryProblem(JSON.stringify({ ...strictOk, unix: "connected" }), "local", { tcp: 0, unix: 0 })!, /Unix socket/);

  // The script itself, outside any sandbox and without a proxy: it reaches both listeners, and says so.
  const t = await openCanaryTargets();
  try {
    assert.ok(t.sock.length < 100 && t.sock.startsWith("/private/tmp/relay-cn-"), t.sock);
    const env = { ...process.env };
    for (const k of ["HTTP_PROXY", "http_proxy"]) delete env[k];
    const r = await new Promise<string>((resolve) => {
      const c = spawn(process.execPath, ["-e", CANARY_SCRIPT, String(t.port), t.sock], { env });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("exit", () => resolve(out));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(JSON.parse(r), { proxy: null, loop: "connected", unix: "connected", viaProxy: "no proxy" });
    assert.deepEqual(t.hits(), { tcp: 1, unix: 1 });
  } finally {
    t.close();
  }
  assert.equal(fs.existsSync(path.dirname(t.sock)), false, "its directory is removed");
});

const proxyProfile = (mode: "strict" | "local" = "strict") => codexPermissions({ access: "write", config: appServer } as never, { dangerous: false, network: true, roots: [], net: { mode, sockets: ["/t"] } });
const expectFor = (p = proxyProfile()): Expected => ({ permissions: p, features: { request_permissions_tool: false, exec_permission_approvals: false, ...(p.proxy ? { network_proxy: true } : {}) }, relay: null, relayOnly: false, accountLogin: false });
const effFor = (p = proxyProfile(), more: Record<string, unknown> = {}) => ({
  default_permissions: "relay", approvals_reviewer: "user", mcp_servers: {},
  permissions: { relay: { description: null, extends: null, workspace_roots: null, filesystem: { glob_scan_max_depth: null, ...p.profile!.filesystem }, network: { proxy_url: null, enable_socks5: null, socks_url: null, enable_socks5_udp: null, dangerously_allow_non_loopback_proxy: null, dangerously_allow_all_unix_sockets: null, mode: null, mitm: null, ...p.profile!.network } } },
  features: { network_proxy: true, request_permissions_tool: false }, ...more,
});

test("codex network: config/read must report the proxied profile exactly, the proxy feature as true and the permissions tool off", () => {
  assert.equal(configProblem(effFor(), expectFor()), null);
  const eff = effFor();
  (eff.permissions.relay.network as Record<string, unknown>).dangerously_allow_all_unix_sockets = true;
  assert.match(configProblem(eff, expectFor())!, /the permission profile "relay" is .* where relay set/);
  const local = effFor();
  (local.permissions.relay.network as Record<string, unknown>).domains = { "*": "allow", localhost: "allow" };
  assert.match(configProblem(local, expectFor())!, /the permission profile "relay" is/);
  for (const np of [undefined, false, { domains: { "*": "allow" } }]) {
    assert.match(configProblem(effFor(undefined, { features: { network_proxy: np, request_permissions_tool: false } }), expectFor())!, /features\.network_proxy is .* where relay set true/, JSON.stringify(np));
  }
  assert.match(configProblem(effFor(undefined, { features: { network_proxy: true, request_permissions_tool: true } }), expectFor())!, /features\.request_permissions_tool is true where relay set false/);
  assert.match(configProblem(effFor(undefined, { features: { network_proxy: true, exec_permission_approvals: true } }), expectFor())!, /features\.exec_permission_approvals is true where relay set false/);
  // A session without the proxy does not need the feature.
  const hosted = codexPermissions({ access: "write", config: appServer } as never, { dangerous: false, network: true, roots: [], net: { mode: "hosted" } });
  assert.equal(configProblem(effFor(hosted, { features: {} }), expectFor(hosted)), null);
});

test("codex network: the feature list must list the proxy on, and every other feature relay set as relay set it where it is listed", async () => {
  const rpc = (pages: Rec[][] | Error) => ({
    calls: [] as Rec[],
    async request(method: string, params: Rec) {
      this.calls.push({ method, params });
      if (pages instanceof Error) throw pages;
      const i = params.cursor ? Number(params.cursor) : 0;
      return { data: pages[i], nextCursor: i + 1 < pages.length ? String(i + 1) : null };
    },
  });
  const want = { features: { network_proxy: true, request_permissions_tool: false } };
  const good = rpc([[{ name: "request_permissions_tool", enabled: false }], [{ name: "network_proxy", enabled: true }]]);
  assert.equal(await featuresProblem(good, want), null);
  assert.equal(good.calls.length, 2, "every page");
  assert.match((await featuresProblem(rpc([[{ name: "request_permissions_tool", enabled: false }]]), want))!, /does not list its network_proxy feature/);
  assert.match((await featuresProblem(rpc([[{ name: "network_proxy", enabled: false }]]), want))!, /reports its network_proxy feature off where relay set it on/);
  assert.match((await featuresProblem(rpc([[{ name: "network_proxy", enabled: true }, { name: "request_permissions_tool", enabled: true }]]), want))!, /request_permissions_tool feature on where relay set it off/);
  // Not listed: a Codex without that feature.
  assert.equal(await featuresProblem(rpc([[{ name: "network_proxy", enabled: true }]]), want), null);
  assert.equal(await featuresProblem(rpc([[]]), { features: { request_permissions_tool: false } }), null);
  assert.match((await featuresProblem(rpc(new Error("method not found")), want))!, /could not read the features Codex runs with \(experimentalFeature\/list: method not found\)/);
});

test("codex network: relay declines by itself network added to one command of a session without the proxy, and any blocked host; everything else is asked as before", () => {
  for (const raw of [{ network: { enabled: true } }, { network: { enabled: "yes" } }, { network: { enabled: true, domains: ["x"] } }, "everything", ["/a"], { network: true }]) assert.equal(addsNetwork(raw), true, JSON.stringify(raw));
  for (const raw of [undefined, null, {}, { network: null }, { network: { enabled: false } }, { network: { enabled: null } }, { network: {} }, { fileSystem: { write: ["/a"] } }]) assert.equal(addsNetwork(raw), false, JSON.stringify(raw));
  const none = codexPermissions({ access: "write", config: appServer } as never, { dangerous: false, network: false, roots: [] });
  const hosted = codexPermissions({ access: "write", config: appServer } as never, { dangerous: false, network: true, roots: [], net: { mode: "hosted" } });
  const strict = proxyProfile();
  const danger = codexPermissions({ access: "write", config: appServer } as never, { dangerous: true, network: false, roots: [] });
  const adds = { command: "npm ci", additionalPermissions: { network: { enabled: true } } };
  assert.match(autoDenial(adds, none)!, /add network access to one command, and this session's shell has no network proxy/);
  assert.match(autoDenial(adds, hosted)!, /no network proxy/);
  assert.match(autoDenial({ command: "x", additionalPermissions: "unreadable" }, none)!, /no network proxy/);
  assert.equal(autoDenial(adds, strict), null, "a proxied session keeps the proxy for that command");
  assert.equal(autoDenial({ ...adds, kind: "writeStdin" }, none), null, "a running terminal's own permissions");
  assert.equal(autoDenial({ command: "x", additionalPermissions: { fileSystem: { write: ["/a"] } } }, none), null);
  assert.equal(autoDenial(adds, danger), null, "no sandbox to keep");
  const blocked = { command: null, networkApprovalContext: { host: "127.0.0.1", protocol: "http" } };
  assert.match(autoDenial(blocked, strict)!, /a host Codex's network proxy refused/);
  // Without the proxy no approval can give the network (an approved retry keeps the turn's own): declined, pointing at a grant.
  assert.match(autoDenial(blocked, none)!, /this job has no shell network, which no approval can give it; ask the caller for a network grant/);
  assert.equal(autoDenial(blocked, danger), null);
});

test("codex network: a turn's flags set the proxy and its readback, and every turn switches the request_permissions tool off", () => {
  const spec = (grant?: Rec, access = "write") => ({ config: withDefaults({}), target: targetDef("codex"), access, cwd: "/w", relay: null, ...(grant ? { grant } : {}) }) as never;
  const flat = (f: { c: string[] }) => f.c.filter((_, i) => i % 2 === 1);
  const strict = codexFlags(spec({ network: true }), [], {}, [], { mode: "strict", sockets: ["/t", "/w"] });
  for (const kv of ["features.network_proxy=true", "features.request_permissions_tool=false", 'web_search="live"', "permissions.relay.network.enabled=true", 'permissions.relay.network.domains={"*"="allow"}', "permissions.relay.network.allow_local_binding=false", "permissions.relay.network.allow_upstream_proxy=false", 'permissions.relay.network.unix_sockets={"/t"="allow","/w"="allow"}']) {
    assert.ok(flat(strict).includes(kv), kv);
  }
  assert.deepEqual(strict.expect.features, { request_permissions_tool: false, exec_permission_approvals: false, network_proxy: true });
  assert.equal(strict.expect.permissions.proxy, "strict");
  const local = codexFlags(spec({ network: true, local_network: true }), [], {}, [], { mode: "local", sockets: ["/t"] });
  assert.ok(flat(local).includes("permissions.relay.network.allow_local_binding=true"));
  const hosted = codexFlags(spec({ network: true }), [], {}, [], { mode: "hosted" });
  assert.ok(flat(hosted).includes("permissions.relay.network.enabled=false") && flat(hosted).includes('web_search="live"') && !flat(hosted).some((kv) => kv.startsWith("features.network_proxy")));
  const none = codexFlags(spec(), [], {});
  // Every turn: no access added to one command's sandbox, by the tool or by exec_permission_approvals (review r_17565c33 X1).
  assert.ok(flat(none).includes("features.request_permissions_tool=false") && flat(none).includes("features.exec_permission_approvals=false") && !flat(none).some((kv) => kv.startsWith("features.network_proxy")));
  assert.deepEqual(none.expect.features, { request_permissions_tool: false, exec_permission_approvals: false });
});

test("codex network: consent to local network is bound to the grant's network, local network and write paths", () => {
  const a = localNetworkKey({ network: true, local_network: true, write_paths: ["/b", "/a"], write_path_pins: [{ path: "/a", dev: 1, ino: 2 }] });
  assert.equal(a, localNetworkKey({ network: true, local_network: true, write_paths: ["/a", "/b"] }));
  assert.notEqual(a, localNetworkKey({ network: true, local_network: true, write_paths: ["/a"] }));
  assert.notEqual(a, localNetworkKey({ network: true, local_network: false, write_paths: ["/a", "/b"] }));
});

// --- Through relay, with the stub Codex ---

const startOf = (h: Harness, name: string): Rec => h.starts().filter((r) => r.target === "codex" && String(r.prompt).includes(name)).at(-1)!;
const cvalue = (argv: string[], key: string): string | undefined => argv.filter((a, i) => argv[i - 1] === "-c").find((kv) => kv.startsWith(`${key}=`))?.slice(key.length + 1);
const settled = async (h: Pick<Harness, "call">, id: string): Promise<Rec> => {
  let s: Rec = {};
  await until(async () => {
    s = await h.call("status", { id, wait_s: 10 });
    return !["queued", "running"].includes(s.status);
  }, 60000, `${id} to settle`);
  return s;
};

test("codex network (stub): a granted job's shell network is strict through the proxy, verified on a preflight server and again on its own, and the job's notes and the turn say so", async () => {
  const h = await harness([{ match: task("STRICT"), steps: [{ reply: "done" }] }]);
  try {
    const read = await h.call("delegate", { target: "codex", task: "STRICT read", mode: "read", grant: { network: true }, background: false });
    assert.equal(read.status, "done", JSON.stringify(read));
    const start = startOf(h, "STRICT read");
    assert.equal(cvalue(start.argv, "features.network_proxy"), "true");
    assert.equal(cvalue(start.argv, "permissions.relay.network.allow_local_binding"), "false");
    assert.equal(cvalue(start.argv, "permissions.relay.network.unix_sockets"), undefined, "a read turn: no Unix sockets");
    assert.match(start.prompt, /^\[relay\] This turn your shell's network is strict: shell network through Codex's proxy\. HTTP\(S\) works .*; raw TCP, ssh remotes, direct DNS, this Mac's loopback and the local network do not\./);
    assert.ok((read.notes as string[]).some((n) => /^Turn \d+: Codex network: strict: /.test(n)), JSON.stringify(read.notes));
    // Two runs of the sandbox check: the preflight's, and the turn's own server's.
    assert.equal(h.log().filter((r) => r.event === "command-exec").length, 2);
    assert.equal(h.log().filter((r) => r.event === "feature-list").length, 2);

    const write = await h.call("delegate", { target: "codex", task: "STRICT write", mode: "write", grant: { network: true }, background: false });
    assert.equal(write.status, "done", JSON.stringify(write));
    const ws = startOf(h, "STRICT write");
    const sockets = Object.keys(JSON.parse(cvalue(ws.argv, "permissions.relay.network.unix_sockets")!.replace(/"=/g, '":')));
    // The turn's TMPDIR (removed with the turn, so by the name relay gave it) and the job's worktree.
    assert.deepEqual(sockets.sort(), [ws.env.tmpdir, ws.cwd].sort());
  } finally {
    await h.close();
  }
});

test("codex network (stub): where the proxy cannot be verified the turn gets hosted search only, said in its notes and its input; a check failing only on the turn's own server refuses the turn", async () => {
  const rules: Rule[] = [{ match: task("HOSTED"), steps: [{ reply: "done" }] }, { match: task("CHANGED"), steps: [{ reply: "done" }] }];
  for (const [env, why] of [
    [{ STUB_CODEX_FEATURE_LIST: JSON.stringify([{ name: "request_permissions_tool", enabled: false }]) }, /Codex does not list its network_proxy feature/],
    [{ STUB_CODEX_CANARY: JSON.stringify({ proxy: null, loop: "connected", unix: "connected", viaProxy: "no proxy" }) }, /was not given Codex's network proxy/],
    [{ STUB_CODEX_CANARY: "error" }, /Codex could not run relay's sandbox check \(command\/exec: failed to start managed network proxy\)/],
    [{ STUB_CODEX_REQUIREMENTS: JSON.stringify({ network: { enabled: true } }) }, /an administrator's requirements for Codex set its network policy/],
  ] as [Record<string, string>, RegExp][]) {
    const h = await harness(rules, {}, env);
    try {
      const job = await h.call("delegate", { target: "codex", task: "HOSTED", mode: "write", grant: { network: true }, background: false });
      assert.equal(job.status, "done", JSON.stringify(job));
      const start = startOf(h, "HOSTED");
      assert.equal(cvalue(start.argv, "permissions.relay.network.enabled"), "false");
      assert.equal(cvalue(start.argv, "features.network_proxy"), undefined);
      assert.equal(cvalue(start.argv, 'web_search'), '"live"');
      assert.match(start.prompt, /^\[relay\] This turn your shell has no network: relay could not verify Codex's network proxy \(.*\)\. Codex's hosted web search still works\./);
      assert.match(start.prompt, why);
      const note = (job.notes as string[]).find((n) => n.includes("Codex network"))!;
      assert.match(note, /Codex network: hosted search only: Codex's hosted web search works; the shell has no network, because relay could not verify Codex's network proxy/);
      assert.match(note, why);
    } finally {
      await h.close();
    }
  }
  // The preflight's check passes; the turn's own server's then fails: the turn is refused, not given less.
  const h = await harness(rules, {}, { STUB_CODEX_CANARY_LATER: JSON.stringify({ proxy: "http://127.0.0.1:61000", loop: "connected", unix: "EPERM", viaProxy: "HTTP/1.1 403 Forbidden" }) });
  try {
    const job = await h.call("delegate", { target: "codex", task: "CHANGED", mode: "read", grant: { network: true }, background: false });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, /relay will not start a Codex agent, because a command in its sandbox could connect to this Mac's loopback directly/);
    assert.equal(h.starts().some((r) => String(r.prompt).includes("CHANGED")), false, "no agent ran");
  } finally {
    await h.close();
  }
});

test("codex network (stub): grant.local_network is a Codex write job's, with network, and only where a person can be asked", async () => {
  const h = await harness([{ match: task("LOCAL"), steps: [{ reply: "done" }] }]);
  try {
    const refused = async (args: Rec, re: RegExp) => {
      const r = await h.call("delegate", { task: "LOCAL", background: false, ...args });
      assert.match(JSON.stringify(r), re, JSON.stringify(r));
    };
    await refused({ target: "codex", mode: "read", grant: { network: true, local_network: true } }, /grant\.local_network is for Codex write jobs only: a read-only session's shell never reaches/);
    await refused({ target: "codex", mode: "write", grant: { local_network: true } }, /grant\.local_network needs network: true in the same grant/);
    await refused({ target: "claude", mode: "write", grant: { network: true, local_network: true } }, /grant\.local_network is for Codex write jobs only: Claude has no mode/);
    // This harness's root session has no person path: refused up front, nothing started.
    await refused({ target: "codex", mode: "write", grant: { network: true, local_network: true } }, /grant\.local_network needs the user's consent through confirm or a qualified approval dialog in the owning root session/);
    assert.equal(h.starts().length, 0);
  } finally {
    await h.close();
  }
});

/** A root session in a host that shows relay's questions to a person, and the person at it (as extensions.test.ts personSession). */
async function personSession(h: Harness) {
  const host = hostFor("codex");
  const open: { message: string; params: Rec; signal: AbortSignal; resolve: (r: Rec) => void }[] = [];
  const inst = await h.instance({
    ...INTERACTIVE_CLAUDE, args: ["--host", host],
    elicit: (message, signal, params) => new Promise((resolve) => {
      open.push({ message, params, signal, resolve });
      signal.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true });
    }),
  });
  const question = (req: Rec) => open.find((q) => !q.signal.aborted && q.message.includes(` ${req.from} asks`));
  return {
    ...inst, open,
    async answers(req: Rec, decision: "allow" | "deny" = "allow") {
      let q: ReturnType<typeof question>;
      await until(() => Boolean((q = question(req))), 30000, `relay's question about ${req.request_id}`);
      open.splice(open.indexOf(q!), 1);
      q!.resolve({ action: "accept", content: { decision } });
      await until(() => h.sql("SELECT status FROM requests WHERE id = ?", req.request_id)[0]?.status !== "pending", 30000, `${req.request_id} decided`);
      return q!.message;
    },
  };
}

async function pendingOf(h: Pick<Harness, "call">, id: string, kind: string): Promise<Rec> {
  let req: Rec | undefined;
  await until(async () => {
    const s = await h.call("status", { id, wait_s: 5 });
    req = (s.needs_approval as Rec[] | undefined)?.find((r) => r.kind === kind && r.from === id);
    return Boolean(req);
  }, 60000, `a ${kind} request from ${id}`);
  return req!;
}

test("codex network (stub): local network asks the person once for the grant the job holds, before its agent starts; the root cannot allow it, a denial refuses the turn, a changed grant asks again", async () => {
  const h = await harness([{ match: task("LOCALJOB"), steps: [{ reply: "done" }] }]);
  try {
    const person = await personSession(h);
    const job = await person.call("delegate", { target: "codex", task: "LOCALJOB", mode: "write", grant: { network: true, local_network: true } });
    assert.ok(job.job_id, JSON.stringify(job));
    assert.deepEqual(job.grant, { network: true, local_network: true, write_paths: [] });
    const req = await pendingOf(person, job.job_id, "local_network");
    assert.equal(req.person_only, true);
    assert.match(req.wants, /reach this Mac's loopback and the local network from its shell: every service listening there, sshd and screen sharing included, with your account's reach, loopback directly as well as through Codex's proxy; and to listen on every interface, so devices on your local network or tailnet can connect to servers it starts; for the rest of the job/);
    assert.match(req.effect, /every service listening on this Mac's loopback and on the local network \(LAN\), sshd and screen sharing included, with your account's reach, loopback directly as well as through Codex's network proxy; and lets it listen on every interface, so devices on your local network or tailnet can connect to servers it starts; for the rest of the job/);
    assert.equal(h.starts().length, 0, "nothing runs before consent");
    // The root agent's word is not the person's, nor is a command's.
    assert.match(JSON.stringify(await person.call("approve", { request_id: req.request_id, decision: "allow" })), /only the user can allow .*: it opens this Mac's loopback and the local network to a job's shell/);
    let fromTerminal = "";
    try { fromTerminal = h.cli("approve", req.request_id); } catch (err) { fromTerminal = String((err as { stdout?: unknown }).stdout ?? "") + String((err as Error).message); }
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", req.request_id)[0].status, "pending", fromTerminal);
    const asked = await person.answers(req);
    assert.match(asked, /loopback and the local network/);
    const done = await settled(person, job.job_id);
    assert.equal(done.status, "done", JSON.stringify(done));
    const start = startOf(h, "LOCALJOB");
    assert.equal(cvalue(start.argv, "permissions.relay.network.allow_local_binding"), "true");
    assert.match(start.prompt, /^\[relay\] This turn your shell's network is local: shell network through Codex's proxy, with this Mac's loopback and the local network open/);
    assert.equal(h.sql("SELECT kind, decided_by FROM requests WHERE kind = 'local_network'").length, 1);

    // The same grant kept: not asked again.
    await person.call("resume", { job_id: job.job_id, message: "LOCALJOB again" });
    assert.equal((await settled(person, job.job_id)).status, "done");
    assert.equal(h.sql("SELECT id FROM requests WHERE kind = 'local_network'").length, 1);
    // A changed grant: asked again, and this time denied: the turn is refused, saying why.
    const dir = fs.mkdtempSync(path.join(path.dirname(h.home), "extra-"));
    await person.call("resume", { job_id: job.job_id, message: "LOCALJOB third", grant: { network: true, local_network: true, write_paths: [dir] } });
    const again = await pendingOf(person, job.job_id, "local_network");
    assert.notEqual(again.request_id, req.request_id);
    await person.answers(again, "deny");
    const denied = await settled(person, job.job_id);
    assert.equal(denied.status, "failed", JSON.stringify(denied));
    assert.match(denied.error, /consent to this job's local network was refused by the user in relay's approval dialog, so its agent was not started\. Continue it to be asked again, or continue it with a grant without local_network for internet access only\./);

    // Toggled away and back (review r_17565c33 C4): the consent given for the first grant is gone
    // once the job holds another, so the same grant coming back is asked about again.
    await person.call("resume", { job_id: job.job_id, message: "LOCALJOB fourth", grant: { network: true, local_network: true } });
    await person.answers(await pendingOf(person, job.job_id, "local_network"));
    assert.equal((await settled(person, job.job_id)).status, "done");
    const requested = () => h.sql("SELECT id FROM requests WHERE kind = 'local_network'").length;
    const before = requested();
    await person.call("resume", { job_id: job.job_id, message: "LOCALJOB fifth", grant: { network: true } });
    assert.equal((await settled(person, job.job_id)).status, "done");
    assert.equal(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json.includes('"local_network_consent":null'), true, "the consent went with the grant");
    await person.call("resume", { job_id: job.job_id, message: "LOCALJOB sixth", grant: { network: true, local_network: true } });
    const back = await pendingOf(person, job.job_id, "local_network");
    assert.equal(requested(), before + 1, "asked again");
    await person.answers(back);
    assert.equal((await settled(person, job.job_id)).status, "done");
    await person.close();
  } finally {
    await h.close();
  }
});

test("codex network (stub): network added to one command of a session without the proxy is declined by relay, recorded and explained; on a proxied session it is asked; a blocked host is declined on either", async () => {
  const adds = { cmd: "npm ci", additionalPermissions: { network: { enabled: true } }, availableDecisions: ["accept", "cancel"] };
  const asking = (name: string, request: Rec): Rule => ({ match: task(name), steps: [{ request }, { reply: "request result: {{last}}" }] });
  const h = await harness([
    asking("NONET", adds),
    asking("PROXIED", adds),
    asking("BLOCKEDHOST", { cmd: "curl http://127.0.0.1:1/", networkApprovalContext: { host: "127.0.0.1", protocol: "http" } }),
    asking("RETRY", { cmd: "curl https://example.com/", networkApprovalContext: { host: "example.com", protocol: "https" } }),
  ]);
  try {
    // No grant: declined at once, nobody asked.
    const none = await h.call("delegate", { target: "codex", task: "NONET", mode: "write", background: false });
    assert.equal(none.status, "blocked", JSON.stringify(none));
    assert.equal(h.sql("SELECT id FROM requests").length, 0, "no request filed");
    assert.deepEqual(h.log().filter((r) => r.event === "approval-answer").map((r) => r.decision), ["decline"]);
    assert.ok((none.blocked as string[]).some((b) => /^npm ci \(declined by relay: it asked to add network access to one command, and this session's shell has no network proxy/.test(b)), JSON.stringify(none.blocked));
    await until(() => h.log().some((r) => r.event === "steer"), 15000, "the note to the agent");
    assert.match(h.log().find((r) => r.event === "steer")!.input[0].text, /^\[relay\] Your approval request \(npm ci\) was declined by relay without asking anyone: it asked to add network access/);

    // A network grant: the session has the proxy, and the request is asked as before.
    const job = await h.call("delegate", { target: "codex", task: "PROXIED", mode: "write", grant: { network: true } });
    const req = (await h.call("status", { id: job.job_id, wait_s: 20 })).needs_approval?.[0];
    assert.ok(req, "asked");
    assert.equal((await h.call("approve", { request_id: req.request_id, decision: "allow" })).decision, "allowed");
    assert.equal((await settled(h, job.job_id)).status, "done");

    // A blocked host on a proxied session: declined by relay.
    const blocked = await h.call("delegate", { target: "codex", task: "BLOCKEDHOST", mode: "write", grant: { network: true }, background: false });
    assert.ok((blocked.blocked as string[]).some((b) => /declined by relay: it asked to reach a host Codex's network proxy refused/.test(b)), JSON.stringify(blocked));
    // Without the proxy (Codex sends none then, but if it did): no approval could give the network,
    // so it is declined too, and the agent told to ask for a grant.
    const retry = await h.call("delegate", { target: "codex", task: "RETRY", mode: "write", background: false });
    assert.ok((retry.blocked as string[]).some((b) => /declined by relay: it asked for network access, and this job has no shell network, which no approval can give it; ask the caller for a network grant/.test(b)), JSON.stringify(retry));
    assert.equal(h.sql("SELECT id FROM requests WHERE node_id = ?", retry.job_id).length, 0, "nobody asked");
  } finally {
    await h.close();
  }
});

test("codex network: a request to an app server that has exited is refused at once, so nothing waits on it or holds what it opened", async () => {
  const rpc = connect("/bin/sh", ["-c", "exit 0"], os.tmpdir(), { PATH: "/usr/bin:/bin" }, () => {});
  await new Promise((resolve) => rpc.child.once("close", resolve));
  const started = Date.now();
  await assert.rejects(rpc.request("command/exec", {}), /codex app-server exited/);
  assert.ok(Date.now() - started < 1000, "refused at once");
  // A request in flight when it exits is refused too.
  const live = connect("/bin/sh", ["-c", "read line; exit 0"], os.tmpdir(), { PATH: "/usr/bin:/bin" }, () => {});
  await assert.rejects(live.request("config/read", {}), /codex app-server exited/);
});

// Codex 0.167.0 regressions (review of the 0.166 → 0.167.0 source diff). Relay's side, against the stub
// app server; what needs a real Codex is a hand check (docs/qualification/codex-0.167.0.md, "Hand checks").
test("codex 0.167 (stub): relay never advertises requiredHumanApproval, on a fresh or a resumed turn, so Codex turns a managed prompt_user rule's human-only request into a denial", async () => {
  const h = await harness([
    { match: task("HUMANONLY"), steps: [{ reply: "first" }] },
    { match: "HUMANONLY again", steps: [{ reply: "second" }] },
  ]);
  try {
    const job = await h.call("delegate", { target: "codex", task: "HUMANONLY", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    await h.call("resume", { job_id: job.job_id, message: "HUMANONLY again" });
    assert.equal((await settled(h, job.job_id)).status, "done");
    const inits = h.log().filter((r) => r.event === "codex-initialize");
    assert.ok(h.log().filter((r) => r.event === "start" && r.target === "codex").length >= 2, "both turns ran");
    assert.ok(inits.length >= 2, `relay initialized a server for each turn (${inits.length})`);
    for (const init of inits) {
      assert.equal(init.capabilities?.experimentalApi, true, JSON.stringify(init));
      assert.equal("requiredHumanApproval" in (init.capabilities ?? {}), false, `relay advertised requiredHumanApproval: ${JSON.stringify(init.capabilities)}`);
    }
  } finally {
    await h.close();
  }
});

test("codex 0.167 (stub): two concurrent network approvals for one blocked host, the first withdrawn while the second waits, are both declined by relay without asking anyone, on a fresh turn and again after a resume; both turns end", async () => {
  // Codex 0.167 queues a second prompt for the same host behind the first (core/src/tools/network_approval.rs)
  // and withdraws a request whose execution was cancelled (serverRequest/resolved). Relay declines every
  // networkApprovalContext (autoDenial), so nothing is allowed, transferred or left waiting.
  const host = { cmd: "curl http://10.255.255.1/", networkApprovalContext: { host: "10.255.255.1", protocol: "http" } };
  const pair = { requests: [{ ...host, withdraw: true }, host] };
  const h = await harness([
    { match: task("QUEUEDNET"), steps: [pair, { reply: "first: {{last}}" }] },
    { match: "QUEUEDNET again", steps: [pair, { reply: "second: {{last}}" }] },
  ]);
  try {
    const job = await h.call("delegate", { target: "codex", task: "QUEUEDNET", mode: "write", grant: { network: true }, background: false });
    assert.notEqual(job.status, "running", JSON.stringify(job));
    assert.ok((job.blocked as string[] ?? []).some((b) => /declined by relay: it asked to reach a host Codex's network proxy refused/.test(b)), JSON.stringify(job));
    await h.call("resume", { job_id: job.job_id, message: "QUEUEDNET again" });
    const second = await settled(h, job.job_id);
    assert.notEqual(second.status, "running", JSON.stringify(second));
    const log = h.log();
    assert.equal(log.filter((r) => r.event === "end" && r.target === "codex").length, 2, "both turns ended");
    assert.equal(log.filter((r) => r.event === "approval-withdrawn").length, 2, "a request was withdrawn in each turn");
    const answers = log.filter((r) => r.event === "approval-answer" || r.event === "approval-answer-after-withdraw").map((r) => r.decision);
    assert.ok(log.filter((r) => r.event === "approval-answer").length >= 2, "the waiting request was answered in each turn");
    assert.deepEqual([...new Set(answers)], ["decline"], `nothing but declines: ${JSON.stringify(answers)}`);
    assert.equal(h.sql("SELECT id FROM requests WHERE node_id = ?", job.job_id).length, 0, "nobody asked");
  } finally {
    await h.close();
  }
});
