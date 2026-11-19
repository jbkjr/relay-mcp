import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { stage2NetworkRules } from "../dist/confine/seatbelt-stage2.js";
import { stage2Admission, stage2Wanted } from "../dist/backends/codex-stage2.js";
import { codexFlags, stage2InputPrefix } from "../dist/backends/codex.js";
import { nativeCodexNeverNetworkProblem } from "../dist/backends/never-admission.js";
import { createMediatedNetworkProvider, mediatedNetworkProblem, setMediatedNetworkProviderForTests } from "../dist/core/mediated-network-provider.js";
import { resolveNeverPolicy } from "../dist/core/never-policy.js";
import { withDefaults } from "../dist/core/config.js";
import { targetDef } from "../dist/targets/index.js";

const policy = resolveNeverPolicy({ builtins: false, never: { hosts: ["forbidden.test"] } });
const spec = (config = {}, extra = {}) => ({ config: withDefaults({ targets: { codex: { stage2: true } }, ...config }), target: targetDef("codex"), cwd: "/owned/work", access: "write", neverPolicy: policy, grant: { network: true }, ...extra });
const probes = { consent: () => assert.fail("standing mediated grants need no raw consent"), version: () => [0, 164, 0], mcpServers: () => [], interlock: () => null, aliases: () => null };

test("Release A localhost connect compiles IPv4 localhost:P after snapshot and before control denies", () => {
  const network = { mode: "stage2" as const, deniedTcp: [49240], deniedUdp: [], relayRange: [49230, 49231], execPort: 49230, bindPorts: [], worktreeSockets: false, egress: "none" as const, connectPorts: [49240] };
  const text = stage2NetworkRules(network, k => `(param "${k}")`, "", { worktree: "/owned/work", tmpDir: "/owned/tmp" });
  assert.match(text, /allow network-outbound \(remote ip4 \(string-append "localhost:" \(param "CONNECT_PORT_0"\)\)\)/);
  assert.ok(text.indexOf("CONNECT_PORT_0") > text.indexOf("DENY_PORT_0"));
  assert.ok(text.indexOf("CONNECT_PORT_0") < text.indexOf("RELAY_PORT_0"));
  assert.doesNotMatch(text, /allow network-outbound \(remote ip6|127\.0\.0\.1/);
});

test("Release A standing grants and child_network route fresh, read and resumed turns through stage 2", () => {
  for (const access of ["read", "write"]) for (const sessionId of [undefined, "kept-thread"]) for (const child of [false, true]) {
    const s = spec({ escalation: false, child_network: child }, { access, sessionId, ...(child ? { grant: undefined } : {}) });
    assert.equal(stage2Wanted(s), true);
    assert.equal(nativeCodexNeverNetworkProblem(s), null);
    assert.equal(stage2Admission(s, {}, probes), null);
  }
  assert.equal(stage2Wanted(spec({ targets: { codex: { stage2: false } } })), false);
  assert.match(nativeCodexNeverNetworkProblem(spec({ targets: { codex: { stage2: false } } }))!, /native Codex/);
});

test("Release A standing grant refuses unqualified stage2 or provider with no fallback", () => {
  assert.match(stage2Admission(spec(), {}, { ...probes, version: () => [0, 163, 0] })!, /Codex is 0\.163\.0.*no native strict or raw fallback/);
  assert.match(stage2Admission(spec({ codex_backend: "exec" }), {}, probes)!, /codex_backend is "exec".*no native strict or raw fallback/);
  try {
    setMediatedNetworkProviderForTests(undefined);
    assert.match(stage2Admission(spec(), {}, probes)!, /no qualified mediated provider.*no native strict or raw fallback/);
    setMediatedNetworkProviderForTests({ qualify: () => "fixture unqualified", prepare: async () => assert.fail("never prepare an unqualified launch") });
    assert.match(stage2Admission(spec(), {}, probes)!, /fixture unqualified/);
  } finally { setMediatedNetworkProviderForTests(null); }
});

test("Release A mediated baseline permits additive capabilities and forbids raw substitution and host bypass", () => {
  const provider = createMediatedNetworkProvider();
  const context = { capabilities: [{ kind: "port0" }], baseline: { network: true }, policy };
  assert.equal(provider.qualify(context), null);
  assert.match(provider.qualify({ ...context, capabilities: [{ kind: "network", mode: "raw" }] })!, /cannot be combined/);
  assert.match(mediatedNetworkProblem({ ...context, capabilities: [{ kind: "localhost", operation: "connect", host: "127.0.0.1", port: 49240 }] })!, /localhost connect is unavailable with never.hosts/);
});

test("Release A overlay input retains its mediated-baseline note", () => {
  const prefix = stage2InputPrefix(spec({}, { overlay: { id: "ov_test", request: { capabilities: [{ kind: "port0" }] } } }));
  assert.match(prefix, /approved one-turn overlay ov_test/);
  assert.match(prefix, /This turn uses stage-2 mediated network/);
  assert.match(prefix, /Tools must honour proxy settings/);
});

test("Release A hosted web search stays live with a grant and is disabled with never.hosts, including read jobs", () => {
  for (const access of ["read", "write"]) for (const hosts of [false, true]) {
    const s = spec({}, { access, neverPolicy: hosts ? policy : resolveNeverPolicy({ builtins: false }) });
    const flags = codexFlags(s, [], {});
    assert.ok(flags.c.includes(`web_search=${JSON.stringify(hosts ? "disabled" : "live")}`));
    assert.equal(flags.expect.webSearch, hosts ? "disabled" : undefined);
  }
});
