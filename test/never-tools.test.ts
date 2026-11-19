import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { resolveNeverPolicy, neverDigest } from "../dist/core/never-policy.js";
import { screenExtensionCall, extensionToolProblem, neverToolAdapters, normalizeToolUrl, QUALIFIED_NEVER_TOOL_ADAPTERS, type QualifiedToolAdapter, type ExtensionToolIdentity } from "../dist/core/never-tools.js";
import { resolveNeverEndpoints } from "../dist/core/never-network.js";
import { codexFlags } from "../dist/backends/codex.js";
import { configProblem } from "../dist/backends/codex-app.js";
import { withDefaults } from "../dist/core/config.js";
import { targetDef } from "../dist/targets/index.js";
import { offerGateway, type Gateway } from "../dist/mcp/gateway.js";
import { runtimeEnvironment } from "../dist/core/env-policy.js";

const identity: ExtensionToolIdentity = { server: "decoy", version: "1", definitionHash: "trusted-definition", tool: "get", schemaHash: neverDigest({ type: "object" }) };
const adapter: QualifiedToolAdapter = {
  identity,
  normalize: (args) => ({ complete: true, arguments: args, effects: [{ kind: "endpoint", ...normalizeToolUrl(String(args.url)), addresses: ["192.0.2.50"] }] }),
};
const p = () => resolveNeverPolicy({ never: { hosts: ["secret.example"], paths: [{ path: "/private/decoy-secret" }], ports: [{ port: 2525 }] }, builtins: false });

test("fixture adapter registration requires both test markers, binds exact decoys and still screens their log effect", async () => {
  const saved = { RELAY_TEST_NEVER_ADAPTERS: process.env.RELAY_TEST_NEVER_ADAPTERS, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-adapter-test-"));
  const log = path.join(root, "log");
  const defs = { ext: { command: process.execPath, args: [fileURLToPath(new URL("./stubs/ext-server.mjs", import.meta.url))], env: { EXT_LOG: log } } };
  try {
    delete process.env.RELAY_TEST_NEVER_ADAPTERS;
    assert.equal((await neverToolAdapters(defs)).length, 0);
    process.env.RELAY_TEST_NEVER_ADAPTERS = "1";
    delete process.env.NODE_TEST_CONTEXT;
    assert.equal((await neverToolAdapters(defs)).length, 0, "a production environment flag is insufficient");
    assert.equal(runtimeEnvironment({ RELAY_TEST_NEVER_ADAPTERS: "1" }).RELAY_TEST_NEVER_ADAPTERS, undefined);
    process.env.NODE_TEST_CONTEXT = "child-v8";
    const catalog = await neverToolAdapters(defs);
    assert.equal(catalog.length, 2);
    assert.equal(QUALIFIED_NEVER_TOOL_ADAPTERS.length, 0, "production catalog is not mutated");
    const inherited = runtimeEnvironment({ RELAY_TEST_NEVER_ADAPTERS: "1", NODE_TEST_CONTEXT: "child-v8" });
    assert.equal(inherited.RELAY_TEST_NEVER_ADAPTERS, "1");
    assert.equal(inherited.NODE_TEST_CONTEXT, "child-v8");
    const module = new URL("../dist/core/never-tools.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { neverToolAdapters } from ${JSON.stringify(module)}; const catalog = await neverToolAdapters(JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify(catalog.map(a => a.identity.tool)));`, JSON.stringify(defs)], { env: { ...inherited, HOME: os.homedir() }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), ["echo", "send"], "trusted worker environment carries registration across processes");
    for (const def of [{ command: "/bin/sh", args: defs.ext.args }, { command: process.execPath, args: ["/unknown/server.mjs"] }, { command: process.execPath, args: [...defs.ext.args, "extra"] }]) {
      assert.equal((await neverToolAdapters({ ext: def })).length, 0, "arbitrary server definitions cannot opt into fixture semantics");
    }
    const echo = catalog.find(a => a.identity.tool === "echo")!;
    assert.equal((await screenExtensionCall(resolveNeverPolicy({ builtins: false }), echo.identity, { text: "decoy" }, catalog)).allow, true);
    const denied = resolveNeverPolicy({ never: { paths: [{ path: log }] }, builtins: false });
    assert.equal((await screenExtensionCall(denied, echo.identity, { text: "decoy" }, catalog)).allow, false);
    assert.equal(fs.existsSync(log), false, "screening never invokes the server");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extension screen requires pinned tool semantics, withholds opaque and hosted web tools", () => {
  assert.match(extensionToolProblem(identity, [])!, /qualified/);
  assert.equal(extensionToolProblem(identity, [adapter]), null);
  for (const field of ["version", "definitionHash", "schemaHash", "server", "tool"]) assert.ok(extensionToolProblem({ ...identity, [field]: "changed" }, [adapter]), field);
});

test("semantic URL screen covers IDNA, defaults, mapped IP, ports and compound resources", async () => {
  const policy = p();
  const endpoints = await resolveNeverEndpoints(policy, async () => ({ addresses: ["192.0.2.40"], cnames: [] }));
  for (const url of ["https://SECRET.example./", "http://[::ffff:192.0.2.40]/", "http://allowed.example:2525/"]) {
    assert.equal((await screenExtensionCall(policy, identity, { url }, [adapter], endpoints)).allow, false, url);
  }
  assert.equal((await screenExtensionCall(policy, identity, { url: "https://allowed.example/a?url=secret.example" }, [adapter], endpoints)).allow, true);
  const cname: QualifiedToolAdapter = { identity, normalize: args => ({ complete: true, arguments: args, effects: [{ kind: "endpoint", host: "allowed.example", cnames: ["SECRET.example."], port: 443, transport: "tcp", addresses: ["192.0.2.99"] }] }) };
  assert.equal((await screenExtensionCall(policy, identity, {}, [cname], endpoints)).allow, false);
  assert.equal(normalizeToolUrl("HTTPS://BÜCHER.example./").host, "xn--bcher-kva.example");
  assert.equal(normalizeToolUrl("https://allowed.example/").port, 443);
  const compound: QualifiedToolAdapter = { identity, normalize: args => ({ complete: true, arguments: args, effects: [{ kind: "path", path: "/tmp/allowed", access: "read" }, { kind: "path", path: "/private/decoy-secret/item", access: "read" }] }) };
  assert.equal((await screenExtensionCall(policy, identity, {}, [compound], endpoints)).allow, false);
});

test("implicit effects, unbounded redirects, opaque commands and stale/missing endpoint sets fail closed", async () => {
  const policy = p();
  assert.equal((await screenExtensionCall(policy, identity, { url: "https://allowed.example" }, [adapter])).allow, false);
  const implicit: QualifiedToolAdapter = { identity, normalize: args => ({ complete: false, arguments: args, effects: [] }) };
  assert.equal((await screenExtensionCall(policy, identity, {}, [implicit])).allow, false);
  const opaque: QualifiedToolAdapter = { identity, normalize: () => { throw new Error("unbounded redirects/implicit resource"); } };
  assert.equal((await screenExtensionCall(policy, identity, {}, [opaque])).allow, false);
  await assert.rejects(resolveNeverEndpoints(policy, async () => ({ addresses: [], cnames: [] })), /resolve/);
  const stale = await resolveNeverEndpoints(policy, async () => ({ addresses: ["192.0.2.40"], cnames: [] }), { now: 0, ttlMs: 1 });
  assert.equal((await screenExtensionCall(policy, identity, { url: "https://allowed.example" }, [adapter], stale)).allow, false);
});

test("never hosts disable hosted web even with standing network, and effective readback is mandatory", () => {
  const policy = p();
  const spec: any = { target: targetDef("codex"), prompt: "", cwd: "/tmp", dir: "/tmp", logPath: "/tmp/log", access: "read", relay: null, config: withDefaults({}), markers: { runId: "test", nodeId: "test", depth: 1 }, grant: { network: true }, neverPolicy: policy };
  for (const sessionId of [undefined, "resume"]) {
    const flags = codexFlags({ ...spec, sessionId }, [], {});
    assert.ok(flags.c.includes('web_search="disabled"'));
    assert.equal(flags.expect.webSearch, "disabled");
    const effective = { default_permissions: flags.expect.permissions.id, permissions: { relay: flags.expect.permissions.profile }, features: flags.expect.features, skills: { config: [] } };
    assert.match(configProblem({ ...effective, web_search: "live" }, flags.expect)!, /web_search/);
    assert.match(configProblem(effective, flags.expect)!, /web_search/);
    assert.doesNotMatch(configProblem({ ...effective, web_search: "disabled" }, flags.expect) ?? "", /web_search/);
  }
});

test("central gateway refuses before consent and forwarding, rechecks after consent, and screens preauthorized calls", async () => {
  const policy = resolveNeverPolicy({ never: { paths: [{ path: "/private/decoy-secret" }] }, builtins: false });
  const local: QualifiedToolAdapter = { identity, normalize: args => ({ complete: true, arguments: args, effects: [{ kind: "path", path: String(args.path), access: "read" }] }) };
  let called = 0, asked = 0, screens = 0, denyAfterConsent = false;
  let handler: any;
  const tool: any = { name: "decoy__get", server: "decoy", tool: "get", identity, description: "decoy", schema: {}, preauthorized: false, client: { callTool: async () => { called++; return { content: [] }; } } };
  const gw: Gateway = { tools: [tool], warnings: [], close: async () => {}, screen: async (t, args) => {
    screens++;
    if (denyAfterConsent) return { allow: false, reason: "new never addition", policyHash: "new" };
    return screenExtensionCall(policy, t.identity, args, [local]);
  } };
  const server: any = { registerTool: (_name: string, _config: unknown, h: any) => { handler = h; } };
  const offer = (afterConsent = false) => offerGateway(server, gw, async () => { asked++; denyAfterConsent = afterConsent; return { allow: true }; }, () => undefined, () => null);
  offer();
  assert.equal((await handler({ path: "/private/decoy-secret/file" }, {})).isError, true);
  assert.equal(called, 0); assert.equal(asked, 0);
  await handler({ path: "/tmp/allowed-decoy" }, {});
  assert.equal(called, 1); assert.equal(asked, 1);
  offer(true);
  assert.equal((await handler({ path: "/tmp/allowed-decoy" }, {})).isError, true);
  assert.equal(called, 1, "a policy addition during approval reaches no server");
  denyAfterConsent = false; tool.preauthorized = true; offer();
  const before = screens;
  await handler({ path: "/tmp/allowed-decoy" }, {});
  assert.equal(called, 2); assert.equal(screens - before, 2);
  assert.equal(asked, 2, "preauthorization does not skip the policy screen");
});
