import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers.ts";
import { executorEnv, executorPolicy, executorToken, openStage2, setInterfaceReaderForTests, setLeaseOptionsForTests, STAGE2_ENVIRONMENT_ID, sweepTurnSurvivors } from "../dist/backends/codex-env.js";
import { startCodexAppTurn } from "../dist/backends/codex-app.js";
import { sandboxAllows, sandboxCheckHelper, sandboxCheckUnavailable, sandboxReports, setSandboxCheckHelperForTests } from "../dist/confine/sbcheck.js";
import { ensurePrivateRoot, nativeTempRoot } from "../dist/confine/private-root.js";
import { privateTurnTemp } from "../dist/confine/turn.js";
import { busyPorts, interfaceAddresses, portHeld, rangePorts } from "../dist/confine/ports.js";
import { executorRecords, liveExecutorRecords, stopNodeExecutorsNow } from "../dist/core/stage2-executors.js";
import { dirIdentity } from "../dist/confine/seatbelt.js";
import { redact, withTurnSecrets } from "../dist/core/secrets.js";
import { relayHome, withDefaults } from "../dist/core/config.js";
import { createRun, insertNode, insertTurn, setParam } from "../dist/core/db.js";
import { escalationRuntime } from "../dist/core/escalation-contract.js";
import { createMediatedNetworkProvider, setMediatedNetworkProviderForTests } from "../dist/core/mediated-network-provider.js";
import { checkpointNever } from "../dist/core/never-checkpoint.js";
import { rawNetworkKey } from "../dist/core/raw-network.js";
import { targetDef } from "../dist/targets/index.js";
import type { Stage2Network } from "../dist/confine/seatbelt-stage2.js";
import type { TurnSpec } from "../dist/backends/types.js";
import { parse } from "smol-toml";
import { codexFlags } from "../dist/backends/codex.js";
import { configProblem } from "../dist/backends/codex-app.js";
import { Stage2TurnGuard, STAGE2_FEATURES_OFF, stage2Admission, stage2Plan, stage2Permissions } from "../dist/backends/codex-stage2.js";
import { codexToolTimeoutS } from "../dist/targets/codex.js";

test("BB: flags and config preserve the exact required HTTP broker under relay-only", () => {
  const dir = scratch();
  try {
    const spec = specFor(dir, "/bin/true");
    const plan = stage2Plan(spec, {} as never);
    plan.broker = { url: "http://127.0.0.1:47205/mcp", toolTimeoutS: codexToolTimeoutS(spec.config.approval_timeout_s) };
    const flags = codexFlags(spec, ["relay", "relay_tools", "foreign"], {}, [], undefined, plan);
    const settings = new Map(flags.c.filter((_, i) => flags.c[i - 1] === "-c").map((s) => [s.slice(0, s.indexOf("=")), s]));
    const eff = parse([...settings.values()].join("\n")) as any;
    eff.features.plugins = false;
    eff.features.skill_mcp_dependency_install = false;
    assert.deepEqual({ ...eff.mcp_servers.relay_tools }, {
      url: plan.broker.url, bearer_token_env_var: "RELAY_BROKER_TOKEN", environment_id: "local",
      enabled: true, required: true, startup_readiness: "connection", default_tools_approval_mode: "approve",
      tool_timeout_sec: plan.broker.toolTimeoutS, startup_timeout_sec: 30,
    });
    assert.equal(eff.agents.max_concurrent_threads_per_session, 6);
    assert.equal(eff.agents.max_threads, undefined);
    assert.equal(eff.mcp_servers.relay.enabled, false);
    assert.equal(eff.mcp_servers.foreign.enabled, false);
    assert.equal(configProblem(eff, flags.expect), null);
    eff.mcp_servers.relay_tools.required = false;
    assert.match(configProblem(eff, flags.expect) ?? "", /required/);
    eff.mcp_servers.relay_tools.required = true;
    eff.mcp_servers.relay_tools.http_headers = { Authorization: "private" };
    const wrong = configProblem(eff, flags.expect) ?? "";
    assert.match(wrong, /unexpected keys/);
    assert.doesNotMatch(wrong, /private/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("BB: open order, isolated credential, fatal watch and teardown after failed executor launch", async () => {
  const { setStage2DepsForTests } = await import("../dist/backends/codex-env.js");
  const dir = scratch(), order: string[] = [];
  let fatal: ((why: string) => void) | undefined;
  let launchFails = false;
  let served = 0;
  let snapshotFails = false, brokerFails = false;
  let stoppedOptions: any;
  let launchedEnvironment: any, compiledNetwork: any;
  let proxyLeased = false;
  const broker = {
    url: "http://127.0.0.1:47205/mcp", env: Object.freeze({ RELAY_BROKER_TOKEN: "unit-token" }),
    bindAppServer(p: unknown) { order.push("bind-app"); assert.deepEqual(p, { pid: 123, start: "start" }); },
    arm() { order.push("arm"); }, disarm() { order.push("disarm"); },
    sessionsServed: () => served, listTools: async () => [{ name: "status" }],
    onFatal(f: typeof fatal) { fatal = f; }, async close() { order.push("broker-close"); },
  };
  setStage2DepsForTests({
    admission: () => (order.push("admission"), null), sweepProblem: () => null,
    confinement: () => ({ mechanism: {} }), probe: () => async () => ({ launch: {}, probes: {} }), resolveBin: () => "/bin/true",
    lease: (proxy) => (proxyLeased = !!proxy, order.push("lease"), { exec: 47204, broker: 47205, proxy: proxy ? 47206 : undefined, block: [47200, 47201, 47202, 47203], range: [47204, 47205, 47206], release() { order.push("release"); } }),
    deniedTcp: () => { order.push("snapshot"); if (snapshotFails) throw new Error("snapshot collision"); return []; }, interfaces: () => [],
    openBroker: async () => { order.push("broker-open"); if (brokerFails) throw new Error("broker failed"); return broker; }, policy: (_s, _t, network) => { compiledNetwork = network; return {}; }, appStart: () => "start",
    launch: async (o: any) => { order.push("executor"); launchedEnvironment = o.env; assert.equal(o.env.RELAY_BROKER_TOKEN, undefined); if (launchFails) throw new Error("executor failed"); return { url: "ws://127.0.0.1:47204", exited: new Promise(() => {}) }; },
    stop: async (_executor: unknown, options: unknown) => { stoppedOptions = options; order.push("executor-stop"); return { survivors: [] }; },
    watchInterfaces: () => ({ changed: () => null, onChange() {}, stop() { order.push("watch-stop"); } }),
  } as never);
  try {
    const spec = specFor(dir, "/bin/true");
    const turnId = insertTurn(spec.markers!.nodeId, "test", "", "write", "running");
    spec.relay = { nodeId: spec.markers!.nodeId, turnId, mayDelegate: false, mayAsk: true } as never;
    await withTurnSecrets(async () => {
      const s = await openStage2(spec, { env: { NO_PROXY: "example.org", no_proxy: "localhost" }, servers: [] }, dir);
      assert.deepEqual(order, ["admission", "lease", "snapshot", "broker-open", "executor"]);
      assert.deepEqual(compiledNetwork.bindPorts, [47200, 47201, 47202, 47203], "person-consented raw network may bind its reserved block");
      assert.equal(launchedEnvironment.PORT, "47200"); assert.equal(launchedEnvironment.PORTS, "47200,47201,47202,47203");
      assert.equal(s.plan.broker?.toolTimeoutS, codexToolTimeoutS(spec.config.approval_timeout_s));
      assert.ok(Object.isFrozen(s.session.env));
      assert.equal(s.session.env.RELAY_BROKER_TOKEN, "unit-token");
      assert.equal(s.session.env.CODEX_EXEC_SERVER_URL, "none");
      for (const key of ["NO_PROXY", "no_proxy"]) assert.deepEqual(new Set(s.session.env[key]!.split(",")), new Set(["example.org", "localhost", "127.0.0.1"]));
      const eff = { approval_policy: "on-request", agents: { max_concurrent_threads_per_session: 6 },
        features: Object.fromEntries(STAGE2_FEATURES_OFF.map((f) => [f, false])),
        mcp_servers: { relay: { enabled: false }, relay_tools: {
          url: broker.url, bearer_token_env_var: "RELAY_BROKER_TOKEN", environment_id: "local", enabled: true,
          required: true, default_tools_approval_mode: "approve", startup_timeout_sec: 30, tool_timeout_sec: s.plan.broker!.toolTimeoutS,
        } },
      };
      const rpc = { request: async (method: string, params: any) => {
        if (method === "environment/status") return { status: "unknown" };
        if (method === "experimentalFeature/list") return { data: STAGE2_FEATURES_OFF.map((name) => ({ name, enabled: false })) };
        if (method === "hooks/list") return { data: [{ hooks: [], errors: [] }] };
        assert.equal(method, "mcpServerStatus/list");
        if (!params.threadId) served++;
        return { data: [{ name: "relay_tools", runtimeStatus: "connected", authStatus: "bearerToken", httpOrigin: "http://127.0.0.1:47205", tools: { status: { name: "status" } } }] };
      } };
      assert.equal(await s.session.readback(rpc, eff), null, "passes the real BC readback the broker and expected timeout");
      const checkpoint = s.session.sessionsServed();
      assert.equal(checkpoint, 1);
      assert.match(await s.session.threadMcpProblem(rpc, eff, "thread", checkpoint) ?? "", /no authenticated.*thread session/);
      served++;
      assert.equal(await s.session.threadMcpProblem(rpc, eff, "thread", checkpoint), null, "thread session evidence is measured from before startup");
      s.session.bindAppServer(123);
      assert.equal(escalationRuntime(spec.markers!.nodeId, turnId), undefined);
      s.session.armTools("checked-thread", "checked-native-turn");
      const runtime = escalationRuntime(spec.markers!.nodeId, turnId); assert.ok(runtime);
      assert.equal(runtime.snapshot().native_thread, "checked-thread");
      assert.equal(runtime.snapshot().native_turn, "checked-native-turn");
      assert.equal(runtime.snapshot().overlay_budget_s, 3600);
      s.session.disarmTools();
      const failures: string[] = [];
      s.session.watch((why) => failures.push(why));
      fatal!("peer checker failed"); fatal!("again");
      assert.equal(failures.length, 1);
      assert.match(failures[0], /peer checker failed/);
      await s.session.teardown(); await s.session.teardown();
      assert.equal(escalationRuntime(spec.markers!.nodeId, turnId), undefined, "the trusted worker unregisters after teardown");
      assert.ok(order.indexOf("executor-stop") < order.indexOf("broker-close"));
      assert.ok(order.indexOf("broker-close") < order.indexOf("release"));
      assert.equal(order.filter((x) => x === "broker-close").length, 1);
      order.length = 0; launchFails = true;
      await assert.rejects(openStage2(spec, { env: {}, servers: [] }, dir), /executor failed/);
      assert.deepEqual(order, ["admission", "lease", "snapshot", "broker-open", "executor", "disarm", "broker-close", "release"]);
      order.length = 0; launchFails = false;
      snapshotFails = true;
      await assert.rejects(openStage2(spec, { env: {}, servers: [] }, dir), /snapshot collision/);
      assert.deepEqual(order, ["admission", "lease", "snapshot", "release"], "no broker or executor starts after a snapshot collision");
      order.length = 0; snapshotFails = false; brokerFails = true;
      await assert.rejects(openStage2(spec, { env: {}, servers: [] }, dir), /broker failed/);
      assert.deepEqual(order, ["admission", "lease", "snapshot", "broker-open", "release"], "a failed broker cannot start an executor");
      order.length = 0; brokerFails = false;
      const noBroker = await openStage2({ ...spec, relay: null }, { env: {}, servers: [] }, dir);
      assert.equal(noBroker.plan.broker, undefined);
      assert.equal(noBroker.session.env.RELAY_BROKER_TOKEN, undefined);
      assert.ok(!order.includes("broker-open"));
      await noBroker.session.teardown({ survivors: [98765], descendants: [{ pid: 98765, start: "pinned-app-descendant" }] });
      assert.match(stoppedOptions.quarantine, /app-server descendants/);
      assert.deepEqual(stoppedOptions.appDescendants, [{ pid: 98765, start: "pinned-app-descendant" }], "survivor identities must remain durable for reap, not just their numeric pids");

      // The fake admission above isolates the executor/provider seam; production routing and
      // admission are exercised by stage2-network-decisions.test.ts.
      setMediatedNetworkProviderForTests(undefined);
      const mediatedSpec = { ...spec, relay: null, grant: { network: true }, neverPolicy: checkpointNever(spec.markers!.runId, "launch") };
      order.length = 0;
      await assert.rejects(openStage2(mediatedSpec, { env: {}, servers: [] }, dir), /no qualified mediated provider is available/);
      assert.ok(!order.includes("executor"));
      let unsafe = true;
      setMediatedNetworkProviderForTests({
        qualify: () => null,
        async prepare(context) {
          order.push("mediated-prepare");
          assert.equal(context.baseline?.network, true);
          return { network: { ...context.network, egress: unsafe ? "raw" as const : "none" as const, connectPorts: [49234] },
            executorEnv: { STUB_MEDIATED_EXECUTOR: "1" }, appEnv: { STUB_MEDIATED_APP: "1" },
            async close() { order.push("mediated-close"); },
          };
        },
      });
      order.length = 0;
      await assert.rejects(openStage2(mediatedSpec, { env: {}, servers: [] }, dir), /must not substitute raw network/);
      assert.ok(!order.includes("executor")); assert.ok(order.includes("mediated-close"));
      unsafe = false; order.length = 0;
      const mediated = await openStage2(mediatedSpec, { env: {}, servers: [] }, dir);
      assert.equal(compiledNetwork.egress, "none"); assert.deepEqual(compiledNetwork.connectPorts, [49234]);
      assert.equal(launchedEnvironment.STUB_MEDIATED_EXECUTOR, "1");
      assert.equal(mediated.session.env.STUB_MEDIATED_APP, "1");
      assert.equal(mediated.session.env.CODEX_EXEC_SERVER_URL, "none");
      await mediated.session.teardown();
      assert.ok(order.indexOf("executor-stop") < order.indexOf("mediated-close"));
      assert.ok(order.indexOf("mediated-close") < order.indexOf("release"));
      // Exercise the built-in provider with a fake listener, including child_network and resume.
      for (const child_network of [false, true]) for (const sessionId of [undefined, "kept-thread"]) for (const access of ["read", "write"]) {
        let closed = 0;
        setMediatedNetworkProviderForTests(createMediatedNetworkProvider({ open: async options => {
          assert.deepEqual(options.listen, { port: 47206, ipv4Only: true });
          return { port: 47206, close: async () => { closed++; } };
        } }));
        const notes: string[] = [];
        const turn = { ...mediatedSpec, access, sessionId, config: { ...mediatedSpec.config, child_network }, ...(child_network ? { grant: undefined } : {}), onNote: note => notes.push(note) };
        const standing = await openStage2(turn, { env: {}, servers: [] }, dir);
        assert.equal(proxyLeased, true);
        assert.equal(compiledNetwork.egress, "none"); assert.equal(compiledNetwork.mediatedPort, 47206);
        assert.deepEqual(compiledNetwork.bindPorts, [], `${sessionId ? "resumed" : "fresh"} mediated ${access} turn cannot bind its reserved block`);
        for (const port of [47200, 47201, 47202, 47203]) assert.ok(compiledNetwork.relayRange.includes(port), `closed block port ${port} remains in the final reserved-range deny`);
        assert.equal(launchedEnvironment.PORT, undefined); assert.equal(launchedEnvironment.PORTS, undefined, "closed blocks are not advertised to commands");
        for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) assert.equal(launchedEnvironment[key], "http://127.0.0.1:47206");
        assert.equal(standing.session.env.HTTP_PROXY, undefined);
        assert.match(notes.join(" "), /No Go\/Swift TLS.*Release B/);
        assert.match(notes.join(" "), /ignore proxy variables fail closed/);
        await standing.session.teardown(); assert.equal(closed, 1);
      }
      setMediatedNetworkProviderForTests(undefined);
    });
  } finally { setMediatedNetworkProviderForTests(undefined); setStage2DepsForTests(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const mode of ["normal", "fatal", "self-start", "readback-failure", "resume", "provider-cleanup-failure"] as const) {
  test(`BB: app lifecycle ${mode}: bind before initialize, arm before readback, kill before fail, reap before close`, async (t) => {
    const dir = scratch(), events: string[] = [];
    let fail!: (why: string) => void;
    let appPid = 0, armed = false;
    const eventsFile = path.join(dir, "events");
    const bin = path.join(dir, "fake-app");
    fs.writeFileSync(bin, `#!${process.execPath}\n` + fs.readFileSync(path.join(import.meta.dirname, "fixtures", "stage2-app-server.mjs"), "utf8"), { mode: 0o755 });
    const env = Object.freeze({ PATH: process.env.PATH, BB_EVENTS: eventsFile, BB_CONFIG: JSON.stringify({ default_permissions: ":danger-full-access", approvals_reviewer: "user" }), ...(mode === "self-start" ? { BB_SELF_START: "1" } : {}) });
    const kill = process.kill.bind(process);
    t.mock.method(process, "kill", (pid: number, sig?: NodeJS.Signals | number) => {
      if (pid === -appPid && sig === "SIGKILL") events.push("kill");
      return kill(pid, sig);
    });
    const session = {
      env, guard: new Stage2TurnGuard(),
      bindAppServer(pid: number) { appPid = pid; events.push("bind-app"); assert.ok(pid > 1); assert.ok(!fs.existsSync(eventsFile)); },
      bind: async () => null, readback: async () => null,
      threadParams: () => ({}), resumeProblem: async () => null, threadProblem: () => null,
      sessionsServed() { events.push("checkpoint"); assert.ok(!/thread\/(start|resume)/.test(fs.readFileSync(eventsFile, "utf8"))); return 7; },
      threadMcpProblem: async (_rpc: unknown, _eff: unknown, _id: string, checkpoint: number) => {
        assert.equal(checkpoint, 7);
        assert.ok(fs.readFileSync(eventsFile, "utf8").includes(mode === "resume" ? "thread/resume" : "thread/start"));
        events.push("thread-mcp"); return null;
      },
      turnParams: () => ({}),
      armTools() { armed = true; events.push("arm"); },
      disarmTools() { armed = false; events.push("disarm"); },
      async turnProblem(rpc: any) {
        events.push("readback"); assert.ok(armed, "the first tool call while readback waits must already be permitted");
        if (mode === "fatal") { fail("peer checker failed"); return null; }
        if (mode === "readback-failure") return "bad environments";
        await rpc.request("bb/complete", {}); return null;
      },
      approvalProblem: () => null, approvalDetail: () => ({}),
      watch(f: typeof fail) { fail = f; },
      async teardown() {
        assert.ok(gone(appPid), "the app server must be reaped before broker closure"); assert.ok(!armed); events.push("broker-close");
        if (mode === "provider-cleanup-failure") throw new Error("provider cleanup uncertain");
        return { survivors: [], warnings: [] };
      },
    };
    try {
      const spec = specFor(dir, bin, { ...(mode === "resume" ? { sessionId: "thread" } : {}) });
      const handle = startCodexAppTurn(spec, { off: [], c: [], expect: { permissions: stage2Permissions(true), relay: null, relayOnly: false, accountLogin: false } }, env, session);
      const result = await handle.done;
      assert.equal(result.status, ["normal", "resume", "provider-cleanup-failure"].includes(mode) ? "ok" : "failed", result.error);
      if (mode === "provider-cleanup-failure") {
        assert.ok(result.unseenMs !== undefined, "uncertain provider teardown cannot be accounted as verified cleanup");
        assert.match(result.warnings?.join(" ") ?? "", /provider cleanup uncertain/);
      }
      assert.equal(events[0], "bind-app");
      assert.equal(events.at(-1), "broker-close");
      if (mode === "self-start") { assert.ok(!events.includes("arm")); assert.match(result.error ?? "", /started a turn by itself/); }
      else assert.ok(events.indexOf("arm") < events.indexOf("readback"));
      if (["fatal", "self-start", "readback-failure"].includes(mode)) {
        assert.ok(events.indexOf("kill") >= 0);
        assert.ok(events.indexOf("disarm") < events.indexOf("kill"), JSON.stringify(events));
      }
    } finally { t.mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

// WP-C (docs/codex-confinement-design.md §13.2): the executor, its token, its teardown and the
// sandbox_check sweep, through the real packages: D's admission and plan, A's lease and network
// rules, B's stage-2 probes (prepareLaunch). Only what comes from outside relay is replaced: the
// executor binary (a fake that answers --version as Codex 0.164.0), this Mac's addresses
// (setInterfaceReaderForTests) and the port range (setLeaseOptionsForTests: a scratch range, since
// leases are kept per relay home and other relay processes run beside the tests). Live cases with
// Codex itself and a fake model are in stage2-executor-live.test.ts.

const darwin = process.platform === "darwin";
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Codex 0.164 fixture: version, empty mcp list, then executor startup; failures apply only to their named operation. */
function fakeExecutor(dir: string, o: { name?: string; mcpExit?: number; execExit?: number } = {}): string {
  const file = path.join(dir, o.name ?? "fake-exec-server");
  fs.writeFileSync(file, `#!${process.execPath}
const net = await import("node:net");
const { spawn } = await import("node:child_process");
const fs = await import("node:fs");
if (process.argv[2] === "--version") { console.log("codex-cli 0.164.0"); process.exit(0); }
const args = process.argv.slice(2);
if (args.includes("mcp") && args[args.indexOf("mcp") + 1] === "list" && args.includes("--json")) {
  // Codex 0.164 cli/src/mcp_cmd.rs run_list serializes a top-level array, [] without servers.
  if (${o.mcpExit ?? 0}) process.exit(${o.mcpExit ?? 0});
  console.log("[]"); process.exit(0);
}
if (${o.execExit !== undefined}) process.exit(${o.execExit ?? 0});
const url = process.argv[process.argv.indexOf("--listen") + 1];
const port = Number(/:(\\d+)$/.exec(url)[1]);
const s = net.createServer((c) => { c.on("error", () => {}); c.end(); });
s.listen(port, "127.0.0.1", () => {
  console.log(url);
  if (process.env.FAKE_EXEC_CHILDREN) {
    // One child in the group, one that leaves the session and the tree at once (double fork + setsid).
    spawn("/bin/sleep", ["4291"], { stdio: "ignore" });
    const p = spawn("/usr/bin/perl", ["-MPOSIX", "-e", "exit 0 if fork; POSIX::setsid(); open(F, '>', $ARGV[0]); print F $$; close F; exec '/bin/sleep', '4292'", process.env.FAKE_EXEC_CHILDREN], { stdio: "ignore" });
  }
});
`, { mode: 0o755 });
  return file;
}

test("executor fixture: mcp list --json returns Codex's empty top-level array before executor startup", () => {
  const dir = scratch();
  try {
    for (const bin of [fakeExecutor(dir), fakeExecutor(dir, { name: "exits", execExit: 3 })]) {
      for (const args of [["mcp", "list", "--json"], ["--disable", "plugins", "mcp", "list", "--json"]]) {
        const listed = spawnSync(bin, args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
        assert.equal(listed.status, 0, listed.stderr);
        assert.deepEqual(JSON.parse(listed.stdout), []);
      }
      assert.equal(stage2Admission(specFor(dir, bin), { PATH: "/usr/bin:/bin" }, { interlock: () => null, aliases: () => null }), null,
        "real version, consent and MCP admission probes pass even when executor startup will fail");
    }
    assert.equal(spawnSync(path.join(dir, "exits"), ["exec-server"], { stdio: "ignore" }).status, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("executor fixture: a failing mcp list refuses real admission before any executor starts", () => {
  const dir = scratch();
  try {
    const bin = fakeExecutor(dir, { mcpExit: 7 });
    const refusal = stage2Admission(specFor(dir, bin), { PATH: "/usr/bin:/bin" }, { interlock: () => null, aliases: () => null });
    assert.match(refusal ?? "", /could not read the person's MCP server names \(codex mcp list exited with 7\).*cannot rule out a relay_tools entry/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** The registry's run for this file's jobs (the scratch relay home of helpers.ts), made on first use. */
let runId: string | null = null;
let nodes = 0;

/**
 * A write turn granted raw network, for a job registered in the registry with the person's consent
 * stored for exactly its grant, as session.ts records the person's answer (review R2: admission reads
 * it). `consent`: "none" leaves it out, "other" stores one for another grant.
 */
function specFor(dir: string, bin: string, extra: Partial<TurnSpec> = {}, o: { consent?: "none" | "other" } = {}): TurnSpec {
  const cwd = path.join(dir, "w");
  fs.mkdirSync(cwd, { recursive: true });
  runId ??= createRun(dir, withDefaults({}), "s2c-unit");
  const nodeId = `j_s2c${String(++nodes).padStart(4, "0")}`;
  insertNode({ id: nodeId, run_id: runId, kind: "job", target: "codex", mode: "write", depth: 1, task: "stage-2 unit", cwd, status: "running" });
  const spec = {
    target: targetDef("codex"), prompt: "x", cwd, dir, logPath: path.join(dir, "agent.log"), access: "write", relay: null,
    config: withDefaults({ targets: { codex: { bin, stage2: true } } }), markers: { runId, nodeId, depth: 1 },
    environment: { PATH: "/usr/bin:/bin" }, grant: { network: true, raw_network: true } as TurnSpec["grant"], ...extra,
  } as TurnSpec;
  if (o.consent !== "none") {
    const consented = o.consent === "other" ? { ...spec.grant, write_paths: ["/elsewhere"] } : spec.grant;
    setParam(nodeId, "raw_network_consent", { grant: rawNetworkKey(consented as never), by: "by the user", at: Date.now() });
  }
  return spec;
}

/** A scratch lease range of 16 high ports nothing listens on, so these tests' leases never meet another relay process's executors. */
function scratchRange(): { first: number; count: number } {
  for (let i = 0; i < 50; i++) {
    const first = 50000 + 16 * Math.floor(Math.random() * 600);
    const all = Array.from({ length: 16 }, (_, k) => first + k);
    if (!busyPorts(all).size) return { first, count: 16 };
  }
  throw new Error("no free scratch range");
}
/** The ports of the scratch range whose lease is held now (A's lease directory; leases change hands by generation, R6). */
let range = { first: 0, count: 0 };
const leased = (): number[] => rangePorts(range).filter((p) => portHeld(p, { dir: path.join(relayHome(), "ports") }));
/** A fresh scratch range for the next openStage2 calls of this test. */
const useScratchRange = () => setLeaseOptionsForTests({ range: (range = scratchRange()) });
/** The executor this test process started: its pid, its port and its argv and environment. */
function ourExecutor(bin: string): { pid: number; port: number; ps: string } {
  const pids = spawnSync("/usr/bin/pgrep", ["-P", String(process.pid), "-f", `${bin} exec-server --listen`], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).map(Number);
  assert.equal(pids.length, 1, `one executor: ${pids}`);
  const ps = execFileSync("/bin/ps", ["eww", "-o", "command=", "-p", String(pids[0])], { encoding: "utf8" });
  return { pid: pids[0], port: Number(/--listen ws:\/\/127\.0\.0\.1:(\d+) /.exec(ps)![1]), ps };
}

const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2c-")));

test("executorToken: 32 random bytes, its SHA-256 for argv, registered as a turn secret", () => {
  withTurnSecrets(() => {
    const a = executorToken(), b = executorToken();
    assert.match(a.token, /^[0-9a-f]{64}$/);
    assert.notEqual(a.token, b.token);
    assert.equal(a.hash, crypto.createHash("sha256").update(a.token).digest("hex"));
    assert.equal(redact(`error: Bearer ${a.token}`), "error: Bearer [redacted: executor token]");
    assert.equal(redact(a.hash), a.hash, "the hash is not secret");
  });
  assert.throws(() => executorToken(), /redaction scope/, "outside a turn there is nowhere to register it, so nothing is made");
});

test("executorEnv: PORT and PORTS are advertised only when the block is bindable", () => {
  const agent = { PATH: "/usr/bin", CODEX_HOME: "/x/.codex", CODEX_EXEC_SERVER_URL: "ws://x", RELAY_RUN_ID: "r" };
  const ports = { block: [50001, 50002, 50003, 50004] };
  assert.deepEqual(executorEnv(agent, "/t/turn", ports, true), { PATH: "/usr/bin", RELAY_RUN_ID: "r", CODEX_HOME: "/t/turn/codex-exec-home", TMPDIR: "/t/turn", PORT: "50001", PORTS: "50001,50002,50003,50004" });
  assert.deepEqual(executorEnv(agent, "/t/turn", ports, false), { PATH: "/usr/bin", RELAY_RUN_ID: "r", CODEX_HOME: "/t/turn/codex-exec-home", TMPDIR: "/t/turn" });
});

test("executorPolicy: the turn's policy with the stage-2 network, ~/.codex, the app server's CODEX_HOME and the credential stores denied", () => {
  const dir = scratch();
  const tmpDir = privateTurnTemp(ensurePrivateRoot(nativeTempRoot()), "");
  try {
    const spec = specFor(dir, "/bin/true", { environment: { PATH: "/usr/bin", CODEX_HOME: path.join(dir, "apphome") } });
    const n: Stage2Network = { mode: "stage2", deniedTcp: [22], deniedUdp: [1900], relayRange: [50000], execPort: 50000, bindPorts: [50001], worktreeSockets: false };
    const p = executorPolicy(spec, tmpDir, n);
    assert.equal(p.network, n);
    assert.equal(p.tmpDir, tmpDir);
    assert.equal(p.worktree, spec.cwd);
    assert.equal(p.worktreeWritable, true);
    assert.equal(p.state?.home, "real", "commands see the real HOME, read-only, as under Codex's own sandbox");
    assert.equal(p.keychain, false);
    assert.ok(!p.certificateTrust);
    assert.deepEqual(p.stateDirs, [path.join(tmpDir, "codex-exec-home")]);
    assert.ok(fs.statSync(path.join(tmpDir, "codex-exec-home")).isDirectory());
    for (const d of [".codex", ".ssh", ".aws", ".gnupg", ".netrc"]) assert.ok(p.denied.includes(path.join(os.homedir(), d)), d);
    assert.ok(p.denied.includes(path.join(dir, "apphome")));
    assert.equal(executorPolicy({ ...spec, access: "read" }, tmpDir, n).worktreeWritable, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sbcheck: the helper is built, passes its known-answer test, and answers per path", { skip: !darwin }, async () => {
  assert.equal(sandboxCheckUnavailable(), null, `helper at ${sandboxCheckHelper()}`);
  const dir = scratch();
  const a = path.join(dir, "a"), d = path.join(dir, "d");
  fs.mkdirSync(a);
  fs.mkdirSync(d);
  const child = spawn("/usr/bin/sandbox-exec", ["-p", `(version 1)(allow default)(deny file-write* (subpath "${d}"))`, "/bin/sleep", "30"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 40 && sandboxAllows(child.pid!, "file-write-data", d) !== "deny"; i++) await sleep(50);
    assert.equal(sandboxAllows(child.pid!, "file-write-data", a), "allow");
    assert.equal(sandboxAllows(child.pid!, "file-write-data", d), "deny");
    assert.equal(sandboxAllows(process.pid, "file-write-data", d), "allow", "an unsandboxed process may write anything");
    const r = sandboxReports("file-write-data", [a, d], [child.pid!, process.pid]);
    assert.ok(typeof r !== "string");
    assert.deepEqual(r.get(child.pid!), { sandboxed: true, answers: ["allow", "deny"] });
    assert.deepEqual(r.get(process.pid), { sandboxed: false, answers: ["allow", "allow"] });
    assert.match(String(sandboxReports("file-write-data", ["relative"], [1])), /absolute/);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sbcheck: relay runs only its own package's helper, and only while it is the file, with the contents, relay recorded at its start (review r_0c11d860 X1)", { skip: !darwin }, () => {
  // The running package's, whichever worktree the tests run from.
  assert.equal(sandboxCheckHelper(), path.join(path.resolve(import.meta.dirname, ".."), "dist", "native", "relay-sbcheck"));
  const dir = scratch();
  try {
    const copy = path.join(dir, "relay-sbcheck");
    fs.copyFileSync(sandboxCheckHelper(), copy);
    fs.chmodSync(copy, 0o755);
    setSandboxCheckHelperForTests(copy);
    assert.equal(sandboxCheckUnavailable(), null, "a recorded, unchanged helper passes its known-answer test");
    assert.ok(typeof sandboxReports("file-write-data", [dir], [process.pid]) !== "string");
    // Changed in place after relay recorded it: refused before every run, also after the self-test passed.
    fs.appendFileSync(copy, "\0");
    assert.match(sandboxCheckUnavailable() ?? "", /changed since relay started/);
    assert.match(String(sandboxReports("file-write-data", [dir], [process.pid])), /changed since relay started/);
    assert.match(sandboxAllows(process.pid, "file-write-data", dir), /^error: .*changed since relay started/);
    // Replaced by another file of the same contents: a new identity, refused too.
    const other = path.join(dir, "other");
    setSandboxCheckHelperForTests(copy);
    fs.copyFileSync(copy, other);
    fs.chmodSync(other, 0o755);
    fs.renameSync(other, copy);
    assert.match(String(sandboxReports("file-write-data", [dir], [process.pid])), /replaced or changed since relay started/);
  } finally {
    setSandboxCheckHelperForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sbcheck: a missing or unsafe helper is reported, never run", { skip: !darwin }, () => {
  const dir = scratch();
  try {
    setSandboxCheckHelperForTests(path.join(dir, "missing"));
    assert.match(sandboxCheckUnavailable() ?? "", /is not there/);
    assert.match(sandboxAllows(process.pid, "file-write-data", dir), /^error: .*is not there/);
    const writable = path.join(dir, "writable");
    fs.copyFileSync(path.join(import.meta.dirname, "..", "dist", "native", "relay-sbcheck"), writable);
    fs.chmodSync(writable, 0o777);
    setSandboxCheckHelperForTests(writable);
    assert.match(sandboxCheckUnavailable() ?? "", /writable by others/);
    setSandboxCheckHelperForTests(path.join(dir));
    assert.match(sandboxCheckUnavailable() ?? "", /not a regular file/);
  } finally {
    setSandboxCheckHelperForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepTurnSurvivors: finds this turn's detached processes by their sandbox, and nothing else", { skip: !darwin }, async () => {
  const dir = scratch();
  const tmpDir = path.join(dir, "turn"), other = path.join(dir, "other");
  fs.mkdirSync(tmpDir);
  fs.mkdirSync(other);
  // Each one detached (double fork, setsid), so it is in no tree of this test's, as a survivor would be.
  const detached = (prefix: string[], tag: string) => {
    const pidFile = path.join(dir, `${tag}.pid`);
    spawnSync("/usr/bin/perl", ["-MPOSIX", "-e", "exit 0 if fork; POSIX::setsid(); open(F, '>', shift @ARGV); print F $$; close F; exec @ARGV", pidFile, ...prefix, "/bin/sleep", "4290"], { stdio: "ignore" });
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) execFileSync("/bin/sleep", ["0.05"]);
    return Number(fs.readFileSync(pidFile, "utf8"));
  };
  const turnProfile = `(version 1)(allow default)(deny file-write* (subpath "${dir}"))(allow file-write* (subpath "${tmpDir}"))`;
  const otherProfile = `(version 1)(allow default)(deny file-write* (subpath "${dir}"))(allow file-write* (subpath "${other}"))`;
  const pids: number[] = [];
  try {
    const ours = detached(["/usr/bin/sandbox-exec", "-p", turnProfile], "ours");
    const otherTurn = detached(["/usr/bin/sandbox-exec", "-p", otherProfile], "other");
    const broad = detached(["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)"], "broad");
    const plain = detached([], "plain");
    pids.push(ours, otherTurn, broad, plain);
    await sleep(300);
    const found = sweepTurnSurvivors(tmpDir).map((p) => p.pid);
    assert.deepEqual(found, [ours], JSON.stringify({ ours, otherTurn, broad, plain, found }));
  } finally {
    for (const p of pids) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const p of pids) assert.ok(gone(p) || (await sleep(200), gone(p)), `pid ${p} stopped`);
});

test("openStage2: executor sandboxed on its leased port with the token's hash only; bind, hooks, teardown sweep, ports released", { skip: !darwin }, async () => {
  const dir = scratch();
  const tmpDir = privateTurnTemp(ensurePrivateRoot(nativeTempRoot()), "");
  useScratchRange();
  const bin = fakeExecutor(dir);
  const detachedPid = path.join(dir, "w", "detached.pid");
  const spec = specFor(dir, bin, { environment: { PATH: "/usr/bin:/bin", FAKE_EXEC_CHILDREN: detachedPid } });
  const prepared = { PATH: "/usr/bin:/bin", FAKE_EXEC_CHILDREN: detachedPid, CODEX_HOME: path.join(dir, "apphome") };
  let executorPid = 0, stray = 0;
  let s2: Awaited<ReturnType<typeof openStage2>> | undefined;
  try {
    await withTurnSecrets(async () => {
      s2 = await openStage2(spec, { env: prepared, servers: [] }, tmpDir);
      if (!s2) throw new Error("no launch");
      assert.equal(s2.plan.permissions.enforcement, "relay");
      // The app server gets exactly what admission checked, a frozen copy of the agent's environment,
      // with relay's own CODEX_EXEC_SERVER_URL=none over it: Codex registers no `local` environment
      // (review r_0c11d860 C1+X2). The executor's environment never carries it.
      assert.ok(Object.isFrozen(s2.session.env));
      assert.deepEqual({ ...s2.session.env }, { ...prepared, CODEX_EXEC_SERVER_URL: "none" });
      // The executor: whose argv carries the hash, never the token, on a port of the lease with the job's block after it.
      const ex = ourExecutor(bin);
      executorPid = ex.pid;
      const ps = ex.ps;
      assert.ok(ex.port >= range.first && ex.port < range.first + range.count, `${ex.port} in ${JSON.stringify(range)}`);
      assert.match(ps, /--ws-auth capability-token --ws-token-sha256 [0-9a-f]{64}/);
      const block = /PORTS=([\d,]+)/.exec(ps)![1].split(",").map(Number);
      assert.equal(block.length, 4);
      assert.ok(block.every((p, i) => p >= range.first && p < range.first + range.count && (i === 0 || p === block[i - 1] + 1) && p !== ex.port), JSON.stringify(block));
      assert.match(ps, new RegExp(`PORT=${block[0]} `));
      assert.equal(leased().length, 6, "executor, broker and block are leased");
      assert.ok([ex.port, ...block].every((p) => leased().includes(p)));
      // Its record on disk (core/stage2-executors.ts), for whoever must stop it should this process die.
      const recs = executorRecords().records.map((r) => r.record);
      assert.equal(recs.length, 1);
      assert.deepEqual({ pid: recs[0].pid, owner: recs[0].owner.pid, nodeId: recs[0].nodeId, ports: recs[0].ports, tmpDir: recs[0].tmpDir }, { pid: executorPid, owner: process.pid, nodeId: spec.markers.nodeId, ports: { exec: ex.port, block }, tmpDir });
      assert.match(ps, new RegExp(`CODEX_HOME=${tmpDir}/codex-exec-home`));
      assert.doesNotMatch(ps, /CODEX_EXEC_SERVER_URL/, "the executor is not told about any other executor, relay's \"none\" included");
      assert.doesNotMatch(redact(ps), /redacted: executor token/, "the token is in neither argv nor environment");
      const report = sandboxReports("file-write-data", [tmpDir, path.dirname(tmpDir)], [executorPid]);
      assert.deepEqual(typeof report === "string" ? report : report.get(executorPid), { sandboxed: true, answers: ["allow", "deny"] });
      // bind: environment/add with the token, which only that call carries.
      const calls: [string, any][] = [];
      assert.equal(await s2.session.bind({ request: async (m, p) => void calls.push([m, p]) }), null);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], "environment/add");
      assert.equal(calls[0][1].environmentId, STAGE2_ENVIRONMENT_ID);
      assert.equal(calls[0][1].execServerUrl, `ws://127.0.0.1:${ex.port}`);
      assert.equal(redact(calls[0][1].authBearerToken), "[redacted: executor token]");
      assert.equal(crypto.createHash("sha256").update(calls[0][1].authBearerToken).digest("hex"), /--ws-token-sha256 ([0-9a-f]{64})/.exec(ps)![1]);
      const failed = await s2.session.bind({ request: async () => { throw new Error(`refused Bearer ${calls[0][1].authBearerToken}`); } });
      assert.match(failed ?? "", /environment\/add: refused Bearer \[redacted/);
      assert.ok(!failed!.includes(calls[0][1].authBearerToken));
      // The thread's and every turn's overlay: relay's executor alone.
      assert.deepEqual(s2.session.threadParams("/w"), { environments: [{ environmentId: "relay", cwd: "/w" }], approvalPolicy: "on-request" });
      assert.deepEqual(s2.session.turnParams("/w"), { environments: [{ environmentId: "relay", cwd: "/w" }] });
      assert.deepEqual(s2.session.approvalDetail("command"), { confined: true });
      assert.deepEqual(s2.session.approvalDetail("file"), {}, "a file change names no environment: unmarked (review R4)");
      // Before the watch runs, relay cannot say the addresses held: an approval fails the turn.
      assert.match(s2.session.approvalProblem("command", "relay") ?? "", /not watching this Mac's network addresses/);
      let fail: string | null = null;
      s2.session.watch((e) => (fail = e));
      // Approvals (review R4): a command must be bound to relay's executor; a file change names no environment.
      assert.equal(s2.session.approvalProblem("command", "relay"), null);
      assert.equal(s2.session.approvalProblem("file", undefined), null);
      for (const other of ["local", undefined, null, "relay2"]) assert.match(s2.session.approvalProblem("command", other) ?? "", /not relay's sandboxed executor/, String(other));
      for (let i = 0; i < 100 && !fs.existsSync(detachedPid); i++) await sleep(50);
      stray = Number(fs.readFileSync(detachedPid, "utf8"));
      assert.ok(!gone(stray));
      const t = await s2.session.teardown();
      assert.equal(fail, null, "the executor's exit during teardown fails nothing");
      assert.deepEqual(t.survivors, []);
      assert.ok(t.warnings.some((w) => w.includes(String(stray))), `the detached process was swept and reported: ${JSON.stringify(t.warnings)}`);
      assert.ok(gone(executorPid), "executor stopped");
      assert.ok(gone(stray), "the setsid child stopped");
      assert.deepEqual(leased(), [], "the lease is released");
      assert.deepEqual(executorRecords().records, [], "the record goes with the executor");
      assert.equal(await s2.session.bind({ request: async () => {} }), "relay's executor for this turn is no longer available, so it stopped the agent.", "the token is dropped with the turn");
      assert.deepEqual(await s2.session.teardown(), t, "teardown runs once");
    });
  } finally {
    await s2?.session.teardown();
    for (const p of [executorPid, stray]) if (p) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
    setLeaseOptionsForTests(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openStage2: the executor's exit, or a change of addresses, calls fail once; an approval sees a change at once; abort stops it before the app server starts", { skip: !darwin }, async () => {
  const dir = scratch();
  const bin = fakeExecutor(dir);
  const spec = specFor(dir, bin);
  useScratchRange();
  const base = interfaceAddresses();
  let now = base;
  setInterfaceReaderForTests(() => now);
  try {
    await withTurnSecrets(async () => {
      for (const how of ["exit", "addresses", "approval", "abort"] as const) {
        now = base;
        const tmpDir = privateTurnTemp(ensurePrivateRoot(nativeTempRoot()), "");
        const s2 = await openStage2(spec, { env: { PATH: "/usr/bin:/bin" }, servers: [] }, tmpDir);
        const { pid } = ourExecutor(bin);
        assert.ok(pid > 1);
        if (how === "abort") {
          await s2.abort("startCodexAppTurn threw");
          assert.ok(gone(pid));
          assert.deepEqual(executorRecords().records, []);
          assert.deepEqual(leased(), []);
        } else {
          const fails: string[] = [];
          s2.session.watch((e) => fails.push(e));
          if (how === "exit") process.kill(pid, "SIGKILL");
          else now = [...base, "192.0.2.99"];
          if (how === "approval") {
            // InterfaceWatch.changed() runs before each approval: the change is seen without waiting for the poll.
            assert.match(s2.session.approvalProblem("command", "relay") ?? "", /addresses changed during the turn: new 192\.0\.2\.99/);
            assert.match(s2.session.approvalProblem("file") ?? "", /addresses changed during the turn/);
          } else {
            // The poll (INTERFACE_POLL_MS, 3 s) or the exit.
            for (let i = 0; i < 400 && !fails.length; i++) await sleep(20);
            await sleep(100);
            assert.equal(fails.length, 1, JSON.stringify(fails));
            assert.match(fails[0], how === "exit" ? /executor .* exited during the turn \(SIGKILL\)/ : /addresses changed during the turn: new 192\.0\.2\.99/);
          }
          await s2.session.teardown();
          assert.ok(gone(pid));
          assert.deepEqual(leased(), []);
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  } finally {
    setInterfaceReaderForTests(null);
    setLeaseOptionsForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openStage2: a refusal from admission (the person's consent missing or for another grant included), a missing binary or a failed launch leaves nothing running and the ports released", { skip: !darwin }, async () => {
  const dir = scratch();
  const tmpDir = privateTurnTemp(ensurePrivateRoot(nativeTempRoot()), "");
  useScratchRange();
  try {
    await withTurnSecrets(async () => {
      const bin = fakeExecutor(dir);
      // D's admission, as it is: a read job, a Codex that cannot say its version, an environments.toml.
      await assert.rejects(openStage2(specFor(dir, bin, { access: "read" }), { env: { PATH: "/usr/bin" }, servers: [] }, tmpDir), /raw network is for write jobs/);
      // The person's consent (review R2): never given, given for another grant, or a job relay does not know.
      await assert.rejects(openStage2(specFor(dir, bin, {}, { consent: "none" }), { env: { PATH: "/usr/bin" }, servers: [] }, tmpDir), /the person has not consented to this job's raw network/);
      await assert.rejects(openStage2(specFor(dir, bin, {}, { consent: "other" }), { env: { PATH: "/usr/bin" }, servers: [] }, tmpDir), /consent is for another grant than the one this turn holds/);
      const unknown = specFor(dir, bin);
      await assert.rejects(openStage2({ ...unknown, markers: { ...unknown.markers, nodeId: "j_notthere" } }, { env: { PATH: "/usr/bin" }, servers: [] }, tmpDir), /cannot find the job in its registry/);
      await assert.rejects(openStage2(specFor(dir, "no-such-codex-binary"), { env: { PATH: "/usr/bin" }, servers: [] }, tmpDir), /could not read Codex's version/);
      const home = path.join(dir, "apphome");
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, "environments.toml"), "");
      await assert.rejects(openStage2(specFor(dir, bin), { env: { PATH: "/usr/bin", CODEX_HOME: home }, servers: [] }, tmpDir), /environments\.toml exists/);
      await assert.rejects(openStage2(specFor(dir, bin), { env: { PATH: "/usr/bin", CODEX_EXEC_SERVER_URL: "none" }, servers: [] }, tmpDir), /CODEX_EXEC_SERVER_URL/);
      assert.deepEqual(leased(), [], "admission refuses before any port is leased");
      assert.deepEqual(executorRecords().records, [], "and before any executor is recorded");
      assert.equal(spawnSync("/usr/bin/pgrep", ["-P", String(process.pid), "-f", `${bin} exec-server`]).status, 1, "or started");
      // An executor that answers --version and never prints its address: stopped, and the lease released.
      const exited = fakeExecutor(dir, { name: "exits", execExit: 3 });
      await assert.rejects(openStage2(specFor(dir, exited), { env: { PATH: "/usr/bin" }, servers: [] }, tmpDir), /exited before it was ready/);
      assert.deepEqual(leased(), []);
      assert.equal(spawnSync("/usr/bin/pgrep", ["-f", `${exited} exec-server`]).status, 1);
      assert.deepEqual(executorRecords().records, [], "a failed launch leaves no record");
    });
  } finally {
    setLeaseOptionsForTests(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openStage2 (review r_0c11d860 C2, C5): refused without a working sandbox_check helper; a teardown that cannot sweep keeps the record tainted and the ports quarantined until a clean sweep", { skip: !darwin }, async () => {
  const dir = scratch();
  const tmpDir = privateTurnTemp(ensurePrivateRoot(nativeTempRoot()), "");
  useScratchRange();
  const bin = fakeExecutor(dir);
  const missing = path.join(dir, "no-helper");
  let stray = 0, executorPid = 0;
  try {
    await withTurnSecrets(async () => {
      setSandboxCheckHelperForTests(missing);
      await assert.rejects(openStage2(specFor(dir, bin), { env: { PATH: "/usr/bin" }, servers: [] }, tmpDir), /only where it can find every process they leave behind, and relay's sandbox_check helper .* is not there/);
      setSandboxCheckHelperForTests(null);
      assert.deepEqual(leased(), [], "refused before any port is leased");
      assert.deepEqual(executorRecords().records, []);

      const detachedPid = path.join(dir, "w", "detached.pid");
      const spec = specFor(dir, bin, { environment: { PATH: "/usr/bin:/bin", FAKE_EXEC_CHILDREN: detachedPid } });
      const s2 = await openStage2(spec, { env: { PATH: "/usr/bin:/bin", FAKE_EXEC_CHILDREN: detachedPid }, servers: [] }, tmpDir);
      executorPid = ourExecutor(bin).pid;
      for (let i = 0; i < 100 && !fs.existsSync(detachedPid); i++) await sleep(50);
      stray = Number(fs.readFileSync(detachedPid, "utf8"));
      const held = leased();
      assert.equal(held.length, 6, "executor, broker and block stay quarantined");
      // The helper goes away mid-turn: teardown cannot show that nothing is left.
      setSandboxCheckHelperForTests(missing);
      let t: Awaited<ReturnType<typeof s2.session.teardown>>;
      try {
        t = await s2.session.teardown();
      } finally {
        setSandboxCheckHelperForTests(null);
      }
      assert.ok(gone(executorPid), "the executor is stopped all the same");
      assert.ok(!gone(stray), "the detached process could not be found");
      assert.ok(t.warnings.some((w) => /could not confirm that none of this turn's commands is still running \(relay's sandbox_check helper/.test(w)), JSON.stringify(t.warnings));
      assert.ok(t.warnings.some((w) => /keeps this turn's executor record and its ports reserved/.test(w)), JSON.stringify(t.warnings));
      const [rec] = executorRecords().records;
      assert.match(rec?.record.tainted ?? "", /sandbox_check helper/);
      assert.deepEqual(leased(), held, "this process let its claim go, and the record still holds every port");
      assert.equal(liveExecutorRecords().length, 1, "local mode stays refused");
      // A clean sweep (reap or retention; the owner's taint lets it in at once) finds the stray, then lets everything go.
      assert.equal(stopNodeExecutorsNow(spec.markers.nodeId), "");
      for (let i = 0; i < 40 && !gone(stray); i++) await sleep(50);
      assert.ok(gone(stray));
      assert.deepEqual(executorRecords().records, []);
      assert.deepEqual(leased(), []);
    });
  } finally {
    setSandboxCheckHelperForTests(null);
    for (const p of [executorPid, stray]) if (p) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
    setLeaseOptionsForTests(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openStage2: prepareLaunch refuses a hard link out of the worktree or a granted write path (hardLinkProblem skips relay-enforced turns)", { skip: !darwin }, async () => {
  const dir = scratch();
  useScratchRange();
  try {
    await withTurnSecrets(async () => {
      const bin = fakeExecutor(dir);
      const outside = path.join(dir, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "secret"), "not the job's\n");
      const granted = path.join(dir, "granted");
      fs.mkdirSync(granted);
      for (const where of ["worktree", "grant"] as const) {
        const tmpDir = privateTurnTemp(ensurePrivateRoot(nativeTempRoot()), "");
        const spec = specFor(dir, bin, where === "grant" ? { grant: { network: true, raw_network: true, write_paths: [granted], write_path_pins: [dirIdentity(granted)] } as TurnSpec["grant"] } : {});
        const link = path.join(where === "grant" ? granted : spec.cwd, "alias");
        fs.linkSync(path.join(outside, "secret"), link);
        try {
          await assert.rejects(openStage2(spec, { env: { PATH: "/usr/bin:/bin" }, servers: [] }, tmpDir), (err: Error) => /hard link/.test(err.message) && err.message.includes("alias"), where);
          assert.equal(spawnSync("/usr/bin/pgrep", ["-P", String(process.pid), "-f", `${bin} exec-server`]).status, 1, "no executor started");
          assert.deepEqual(leased(), []);
        } finally {
          fs.rmSync(link, { force: true });
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
      // The control: without the link the same turn launches.
      const tmpDir = privateTurnTemp(ensurePrivateRoot(nativeTempRoot()), "");
      const s2 = await openStage2(specFor(dir, bin, { grant: { network: true, raw_network: true, write_paths: [granted], write_path_pins: [dirIdentity(granted)] } as TurnSpec["grant"] }), { env: { PATH: "/usr/bin:/bin" }, servers: [] }, tmpDir);
      await s2.abort("done");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  } finally {
    setLeaseOptionsForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startCodexAppTurn: a stage-2 app server starts only with the environment its admission checked", { skip: !darwin }, async () => {
  const dir = scratch();
  const tmpDir = privateTurnTemp(ensurePrivateRoot(nativeTempRoot()), "");
  useScratchRange();
  try {
    await withTurnSecrets(async () => {
      const bin = fakeExecutor(dir);
      const spec = specFor(dir, bin);
      const s2 = await openStage2(spec, { env: { PATH: "/usr/bin:/bin" }, servers: [] }, tmpDir);
      try {
        const flags = { off: [], c: [], expect: {} as never };
        // An equal copy is not the object admission checked; one with something added even less so.
        for (const env of [{ ...s2.session.env }, { ...s2.session.env, CODEX_EXEC_SERVER_URL: "ws://127.0.0.1:1" }]) {
          assert.throws(() => startCodexAppTurn(spec, flags, env as NodeJS.ProcessEnv, s2.session), /in an environment other than the one its admission checked/);
        }
        assert.ok(!fs.existsSync(spec.logPath), "nothing started, not even the log");
      } finally {
        await s2.abort("done");
      }
    });
  } finally {
    setLeaseOptionsForTests(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
