import "./helpers.ts";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { archiveCodexThread, codexNetworkPreflight, codexPreflight, startCodexAppTurn } from "../dist/backends/codex-app.js";
import { codexPermissions } from "../dist/backends/codex.js";
import { Stage2TurnGuard } from "../dist/backends/codex-stage2.js";
import { setAcpLaunchForTests, startAcpTurn } from "../dist/backends/acp.js";
import { streamTurn } from "../dist/backends/stream.js";
import { withDefaults } from "../dist/core/config.js";
import { closeDbForTests } from "../dist/core/db.js";
import { procStart } from "../dist/core/procs.js";
import { openStage2, setStage2DepsForTests, stopExecutor } from "../dist/backends/codex-env.js";
import { setMediatedNetworkProviderForTests } from "../dist/core/mediated-network-provider.js";
import { withTurnSecrets } from "../dist/core/secrets.js";
import { targetDef } from "../dist/targets/index.js";
import type { Stage2Session } from "../dist/backends/codex-env.js";
import type { TurnSpec } from "../dist/backends/types.js";

// No live process or signal: killing the simulated server zombifies it and reparents its tool
// immediately, before exit. A snapshot taken after that point cannot discover the tool.
function fixture(t: TestContext) {
  closeDbForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backend-cleanup-"));
  const saved = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = path.join(root, "registry"); process.env.RELAY_CONFIG = path.join(root, "config.json");
  const pid = 61001, tool = 61002, start = "Thu Jan 1 00:00:00 1970";
  const signals: [number, string | number][] = [], stderr: string[] = [];
  let unreferenced = 0;
  const child = Object.assign(new EventEmitter(), { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() { unreferenced++; } });
  let alive = true, toolAlive = true, protectedGroup = false, exited = false, liveSnapshots = 0;
  const send = (m: unknown) => child.stdout.write(JSON.stringify(m) + "\n");
  const exit = () => {
    alive = false;
    if (exited) return;
    exited = true;
    queueMicrotask(() => { child.emit("exit", null); queueMicrotask(() => child.emit("close", null)); });
  };
  let respond: (m: any) => void = () => {};
  child.stdin.on("data", chunk => {
    for (const line of String(chunk).trim().split("\n")) {
      try { const m = JSON.parse(line); queueMicrotask(() => respond(m)); } catch { /* stream prompt */ }
    }
  });
  t.mock.method(childProcess, "spawn", (() => child) as typeof childProcess.spawn);
  t.mock.method(childProcess, "spawnSync", ((_cmd, args) => {
    if (args.includes("pid=,ppid=,pgid=")) return { status: 0, stdout: `${process.pid} ${protectedGroup ? pid : 1} ${process.pid}\n${pid} 1 ${pid}\n` };
    if (args.includes("lstart=")) return { status: 0, stdout: start };
    if (alive) liveSnapshots++;
    return { status: 0, stdout: `${pid} 1 ${alive ? "S" : "Z"} ${start} fake-app\n${tool} ${alive ? pid : 1} S ${start} fake-tool\n` };
  }) as typeof childProcess.spawnSync);
  t.mock.method(process, "kill", ((target, sig) => {
    if (sig === 0) {
      if ((Math.abs(target) === pid && !alive) || (target === tool && !toolAlive)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    }
    signals.push([target, sig]);
    if (target === -pid && sig === "SIGKILL") exit();
    if (target === tool && sig === "SIGKILL") toolAlive = false;
    return true;
  }) as typeof process.kill);
  t.mock.method(process.stderr, "write", ((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write);
  syncBuiltinESMExports();
  procStart(pid, { fresh: true });
  const config = withDefaults({ same_family: "allow", child_auth: "any", cancel_grace_ms: 5, targets: { codex: { bin: process.execPath, pinned: false }, gemini: { bin: process.execPath } } });
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(config));
  const spec = {
    target: targetDef("codex"), config, access: "read", cwd: root, dir: root, prompt: "test",
    logPath: path.join(root, "agent.log"), relay: null, markers: { runId: "run_test", nodeId: "j_test", depth: 1 },
  } as TurnSpec;
  const permissions = codexPermissions(spec, { dangerous: false, network: false, roots: [], codexHome: root });
  const flags = { off: [], c: [], expect: { permissions, relay: null, relayOnly: false, accountLogin: false } };
  const env = { HOME: root, PATH: process.env.PATH };
  const baseRespond = (m: any) => {
    if (m.id === undefined) return;
    const result = m.method === "config/read" ? { config: { approvals_reviewer: "user", default_permissions: permissions.id, permissions: { relay: permissions.profile } } }
      : m.method === "configRequirements/read" ? { requirements: null }
      : m.method === "thread/start" ? { thread: { id: "thread" }, activePermissionProfile: { id: "relay" }, runtimeWorkspaceRoots: [root], sandbox: { type: "readOnly", networkAccess: false } }
      : m.method === "turn/start" ? { turn: { id: "turn" } } : {};
    send({ id: m.id, result });
  };
  respond = baseRespond;
  t.after(() => {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    setAcpLaunchForTests(null);
    t.mock.restoreAll(); syncBuiltinESMExports(); closeDbForTests();
    procStart(process.pid, { fresh: true });
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { pid, tool, spec, flags, env, signals, stderr, send, exit, baseRespond,
    protect() { protectedGroup = true; }, respond(fn: typeof respond) { respond = fn; },
    get alive() { return alive; }, get liveSnapshots() { return liveSnapshots; }, get unreferenced() { return unreferenced; },
  };
}

function stage2(f: ReturnType<typeof fixture>, extra: Partial<Stage2Session> = {}) {
  const cleanups: Parameters<Stage2Session["teardown"]>[0][] = [];
  let ready!: () => void, fail!: (error: string) => void;
  const prepared = new Promise<void>(r => { ready = r; });
  const session: Stage2Session = {
    env: f.env, bindAppServer() {}, sessionsServed: () => 0, threadMcpProblem: async () => null,
    armTools() {}, disarmTools() {}, bind: async () => null, readback: async () => null,
    threadParams: () => ({}), resumeProblem: async () => null, threadProblem: () => null,
    turnParams: () => ({}), turnProblem: async () => { ready(); return null; }, guard: new Stage2TurnGuard(),
    approvalProblem: () => null, approvalDetail: () => ({}), watch(fn) { fail = fn; },
    async teardown(cleanup) { cleanups.push(cleanup); return { survivors: [], warnings: [] }; }, ...extra,
  };
  return { session, cleanups, prepared, fail: (why: string) => fail(why) };
}

for (const route of ["readback", "guard-reply", "guard-started", "approval", "watch", "refusal", "cancel", "cancel-timeout"] as const) {
  test(`Codex cleanup snapshots before relay's ${route} stop`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    const s = stage2(f, route === "readback" ? { turnProblem: async () => "readback mismatch" } : {});
    if (route === "guard-reply") s.session.guard.replied = () => "unrequested reply";
    if (route === "approval") s.session.approvalProblem = () => "unsafe environment";
    const h = startCodexAppTurn(f.spec, f.flags, f.env, s.session);
    if (route === "cancel") await h.cancel();
    else if (!["readback", "guard-reply"].includes(route)) {
      await s.prepared;
      if (route === "guard-started") f.send({ method: "turn/started", params: { threadId: "thread", turn: { id: "unrequested-turn" } } });
      if (route === "approval") f.send({ id: "approval", method: "item/commandExecution/requestApproval", params: { environmentId: "wrong" } });
      if (route === "watch") s.fail("executor stopped");
      if (route === "refusal") f.send({ method: "error", params: { error: { message: "vendor safety stop", codexErrorInfo: "cyberPolicy" } } });
      if (route === "cancel-timeout") await h.cancel();
    }
    const result = await h.done;
    assert.equal(s.cleanups.length, 1);
    assert.equal(s.cleanups[0]!.uncertain, false, JSON.stringify(result));
    assert.ok(f.liveSnapshots > 0, "server was traced alive before relay stopped it");
    assert.ok(f.signals.some(([pid, sig]) => pid === f.tool && sig === "SIGKILL"), "the detached tool was captured before its parent zombified");
    assert.equal(result.unseenMs, undefined);
    assert.equal(result.survivors, undefined);
  });
}

test("Codex cleanup preserves uncertainty when the server dies before the last snapshot", { timeout: 5000 }, async t => {
  const f = fixture(t);
  const s = stage2(f, { turnProblem: async () => { f.exit(); return "readback mismatch"; } });
  const h = startCodexAppTurn(f.spec, f.flags, f.env, s.session);
  const result = await h.done;
  assert.equal(s.cleanups[0]!.uncertain, true);
  assert.equal(typeof result.unseenMs, "number");
  assert.ok(!f.signals.some(([pid]) => pid === f.tool), "an untraced detached tool is not invented as settled");
});

for (const phase of ["startup", "running"] as const) test(`Codex cancel settles and reports a refused group during ${phase}`, { timeout: 5000 }, async t => {
  const f = fixture(t); f.protect();
  const s = stage2(f);
  const h = startCodexAppTurn(f.spec, f.flags, f.env, s.session);
  if (phase === "running") await s.prepared;
  await Promise.all([h.cancel(), h.cancel()]);
  const result = await h.done;
  assert.equal(result.status, "interrupted");
  assert.match(result.warnings!.join("\n"), /Agent cleanup refused.*without a verified leader/);
  assert.deepEqual(result.survivors, [f.pid, f.tool]);
  assert.deepEqual(f.signals, [], "no group, direct-pid or descendant signal follows refusal");
  assert.equal(f.alive, true, "cancellation did not wait for the protected server's exit");
  assert.equal(f.unreferenced, 1, "the refused child cannot hold the worker open");
  assert.equal(s.cleanups.length, 1, "independent stage-2 resources are still closed");
  assert.match(s.cleanups[0]!.refused!, /Agent cleanup refused/);
});

test("stream cancel settles and reports a refused group without waiting for exit", { timeout: 5000 }, async t => {
  const f = fixture(t); f.protect();
  const h = streamTurn(f.spec, { invocation: { command: process.execPath, args: [], env: f.env }, onEvent() {} });
  await Promise.all([h.cancel(), h.cancel()]);
  const result = await h.done;
  assert.equal(result.status, "interrupted");
  assert.match(result.warnings!.join("\n"), /Agent cleanup refused/);
  assert.deepEqual(result.survivors, [f.pid, f.tool]);
  assert.deepEqual(f.signals, []);
  assert.equal(f.alive, true);
  assert.equal(f.unreferenced, 1);
});

test("stage-2 app refusal closes the broker, provider and lease once without executor signals or a sweep", async t => {
  const f = fixture(t), order: string[] = [];
  const reason = `Agent cleanup refused for group ${f.pid}: protected ancestor`;
  let stoppedOptions: Parameters<typeof stopExecutor>[1] | undefined;
  setStage2DepsForTests({
    admission: () => null, sweepProblem: () => null, confinement: () => ({ mechanism: {} }),
    probe: () => async () => ({ launch: {}, probes: {} }), resolveBin: () => process.execPath,
    plan: () => ({ features: {} }), policy: () => ({}), interfaces: () => [], deniedTcp: () => [],
    lease: () => ({ exec: 47204, broker: 47205, proxy: 47206, block: [], range: [], release() { order.push("lease-release"); } }),
    openBroker: async () => ({ url: "http://127.0.0.1:47205/mcp", env: {},
      disarm() { order.push("disarm"); }, close: async () => { order.push("broker-close"); },
    }),
    launch: async () => ({ pid: f.pid + 100, start: "executor", url: "ws://127.0.0.1:47204", exited: new Promise(() => {}) }),
    stop: async (ex, options) => { stoppedOptions = options; return stopExecutor(ex, options); },
  } as never);
  setMediatedNetworkProviderForTests({ qualify: () => null,
    prepare: async c => ({ network: c.network, close: async () => { order.push("provider-close"); } }),
  });
  t.after(() => { setStage2DepsForTests(null); setMediatedNetworkProviderForTests(null); });
  await withTurnSecrets(async () => {
    const spec = { ...f.spec, grant: { network: true }, neverPolicy: { hosts: [] }, relay: { nodeId: "j_test", turnId: 1 } } as TurnSpec;
    const s = await openStage2(spec, { env: f.env, servers: [] }, f.spec.dir);
    const result = await s.session.teardown({ survivors: [f.pid], uncertain: true, refused: reason });
    await s.session.teardown();
    assert.equal(stoppedOptions!.refused, reason);
    assert.equal(stoppedOptions!.quarantine, `untraceable app-server cleanup: ${reason}`);
    assert.equal(result.uncertain, true);
    assert.deepEqual(result.survivors, [f.pid + 100]);
    assert.deepEqual(order, ["disarm", "provider-close", "broker-close", "lease-release"]);
    assert.deepEqual(f.signals, [], "even the independent executor's safe group is left alone after app refusal");
  });
});

for (const phase of ["startup", "running"] as const) test(`ACP cancel settles and closes independent resources on refusal during ${phase}`, { timeout: 5000 }, async t => {
  const f = fixture(t); f.protect();
  let closed = 0, revoked = 0, ready!: () => void;
  const prepared = new Promise<void>(r => { ready = r; });
  setAcpLaunchForTests(async () => ({ command: process.execPath, args: [], env: {}, relay: null,
    verify: async () => null, revoke: async () => { revoked++; }, close: async () => { closed++; },
  }));
  f.respond(m => {
    if (m.method === "session/prompt") { ready(); return; }
    if (m.id === undefined) return;
    f.send({ id: m.id, result: m.method === "initialize" ? { protocolVersion: 1 } : { sessionId: "session" } });
  });
  const spec = { ...f.spec, target: targetDef("gemini") };
  const h = await startAcpTurn(spec, { args: () => [], scrub: () => false, login: { how: "test" }, normalizeApproval: () => null });
  if (phase === "running") await prepared;
  await Promise.all([h.cancel(), h.cancel()]);
  const result = await h.done;
  assert.equal(result.status, "interrupted");
  assert.match(result.warnings!.join("\n"), /Agent cleanup refused/);
  assert.deepEqual(result.survivors, [f.pid, f.tool]);
  assert.deepEqual(f.signals, []);
  assert.equal(f.alive, true);
  assert.equal(f.unreferenced, 1);
  assert.equal(closed, 1); assert.ok(revoked > 0);
});

for (const action of ["network preflight", "thread archive", "configuration check"] as const) test(`Codex ${action} warns when draining the group is refused`, { timeout: 5000 }, async t => {
  const f = fixture(t); f.protect();
  const options = { bin: process.execPath, args: [], cwd: f.spec.cwd, env: f.env, expect: f.flags.expect };
  if (action === "thread archive") await archiveCodexThread({ ...options, threadId: "thread" });
  else if (action === "network preflight") await codexNetworkPreflight({ ...options, mode: "local" });
  else await codexPreflight(options);
  assert.match(f.stderr.join("\n"), new RegExp(`could not clean up Codex ${action}: cleanup refused for process group ${f.pid}`));
  assert.deepEqual(f.signals, []);
});
