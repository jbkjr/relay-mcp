import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import dgram from "node:dgram";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hostileWebCalls, assertHostileWebEvidence, codeCall, modelStubRequestKind } from "./fixtures/stage2-hostile-web.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openHttpBroker, BROKER_TOKEN_ENV } from "../dist/confine/broker-http.js";
import { withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun, insertNode, insertTurn, setParam, getTurn, getNode, reap, updateTurn } from "../dist/core/db.js";
import { newInstance } from "../dist/core/caller.js";
import { approve, cancel } from "../dist/core/ops.js";
import { pendingRequests, requestView } from "../dist/core/approvals.js";
import { registerEscalationRuntime } from "../dist/core/escalation-contract.js";
import { procStart, sameProcess } from "../dist/core/procs.js";
import { getOverlay, consumeOverlay, overlayInterlock } from "../dist/core/restart-overlay.js";
import { escalationAccounting } from "../dist/core/escalations.js";
import { rawNetworkKey } from "../dist/core/raw-network.js";
import { openRootEnvironment, workerEnvironment } from "../dist/core/env-broker.js";
import { setCodexHomeConfigForTests } from "../dist/backends/codex-pin.js";
import { busyPorts } from "../dist/confine/ports.js";
import { nodeDir } from "../dist/core/config.js";
import { executorRecords, sweepOrphanedExecutors } from "../dist/core/stage2-executors.js";
import { withTurnSecrets, redactor } from "../dist/core/secrets.js";
import { codexBackend } from "../dist/backends/codex.js";
import { setLeaseOptionsForTests } from "../dist/backends/codex-env.js";
import { checkpointNever } from "../dist/core/never-checkpoint.js";
import { targetDef } from "../dist/targets/index.js";
import { portHeld } from "../dist/confine/leases.js";
import type { TurnHandle, TurnSpec } from "../dist/backends/types.js";
import { sendGroupSignal } from "../dist/core/procs.js";

// Host-only transport qualification. Actual HTTP sockets and the production kernel peer check;
// a fake overlay lifecycle deliberately does not claim production executor/profile qualification.
test("WP3 live HTTP: non-delegating child escalates with actual peer authentication and receipt delivery", {
  skip: process.env.RELAY_TEST_ESCALATION_HTTP !== "1" ? "host only: RELAY_TEST_ESCALATION_HTTP=1" : false,
  timeout: 20000,
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-escalation-http-"));
  process.env.RELAY_HOME = path.join(home, "registry"); process.env.RELAY_CONFIG = path.join(home, "config.json");
  const cfg = withDefaults({ desktop_notifications: false, approval_timeout_s: 5, ask_user: "never", targets: { codex: { stage2: true } } });
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
  const root = newInstance({ kind: "root" }, home); const run = createRun(home, cfg, root.token); root.runId = run;
  const node = insertNode({ id: "j_00000001", run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "run a server test", cwd: home, status: "running" });
  const turn = insertTurn(node.id, "test", "", "write", "running");
  const delivered: boolean[] = []; let requests = 0;
  const unregister = registerEscalationRuntime(node.id, turn, {
    snapshot: () => ({ native_thread: "fake-thread", native_turn: "fake-turn", base_policy_hash: "fake-policy", launch_plan: "fake-overlay", overlay_budget_s: 3600 }),
    qualify: () => null,
    request: async () => { requests++; return { state: "restart_pending" }; },
    receipt: async (_approval, ok) => { delivered.push(ok); },
  });
  const client = new Client({ name: "wp3-live-fake-model", version: "1" });
  let broker: Awaited<ReturnType<typeof openHttpBroker>> | undefined;
  try {
    // OS-selected owned high port; never contact any real service or credential store.
    const candidate = net.createServer(); await new Promise<void>(resolve => candidate.listen(0, "127.0.0.1", resolve));
    const port = (candidate.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => candidate.close(err => err ? reject(err) : resolve()));
    assert.ok(port > 1024 && port !== 5900);
    broker = await withTurnSecrets(() => openHttpBroker({ nodeId: node.id, turnId: turn, mayDelegate: false, mayAsk: true }, port, { onRefusal() {} }));
    const start = procStart(process.pid); assert.ok(start);
    broker.bindAppServer({ pid: process.pid, start }); broker.arm();
    await client.connect(new StreamableHTTPClientTransport(new URL(broker.url), { requestInit: { headers: { Authorization: `Bearer ${broker.env[BROKER_TOKEN_ENV]}` } } }));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["escalate"]);
    const answer = client.callTool({ name: "escalate", arguments: { capabilities: [{ kind: "port0" }], reason: "authorized server test", continuation: { argv: ["node", "./server-test.js"], cwd: home } } });
    let request;
    for (let n = 0; n < 500 && !request; n++) { request = pendingRequests()[0]; if (!request) await new Promise(r => setTimeout(r, 10)); }
    assert.ok(request); assert.equal(approve(root, { request_id: request.id, decision: "allow" }).decision, "allowed");
    const result = JSON.parse((await answer).content[0].text);
    assert.equal(result.state, "restart_pending"); assert.match(result.effect, /0\.0\.0\.0.*on the LAN/);
    for (let n = 0; n < 100 && !delivered.length; n++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(delivered, [true]); assert.equal(requests, 1);
  } finally {
    await client.close(); await broker?.close(); unregister(); closeDbForTests(); fs.rmSync(home, { recursive: true, force: true });
  }
});

// Actual Codex + production worker, broker, lifecycle, executor and profile. The only model
// is the owned high-port Responses stub below. No real model API or credential store is used.
/** The kernel's first ephemeral port (net.inet.ip.portrange.first; 49152 by default). Read only by the macOS listen case. */
const ephemeralFirst = () => Number(execFileSync("/usr/sbin/sysctl", ["-n", "net.inet.ip.portrange.first"], { encoding: "utf8" }).trim()) || 49152;

/**
 * The listen case's port: free on 0.0.0.0 now, and below both the ephemeral range and relay's
 * reserved range (47200), so no outgoing connection can be given it in the ~25 s before the
 * overlay's command binds it. A port taken from the ephemeral range lost that race on a laptop
 * (item 27, EADDRINUSE, Nov 3). The case still fails when the listen itself is denied: the
 * command then prints no OVERLAY_PORT0_OK line for this port.
 */
async function stableListenPort(): Promise<number> {
  const top = Math.min(ephemeralFirst(), 47200);
  for (let i = 0; i < 200; i++) {
    const p = 20000 + Math.floor(Math.random() * (top - 20000));
    const free = await new Promise<boolean>((ok) => { const s = net.createServer(); s.once("error", () => ok(false)); s.listen(p, "0.0.0.0", () => s.close(() => ok(true))); });
    if (free) return p;
  }
  throw new Error(`no free listen port in 20000-${top - 1}`);
}

for (const mode of ["port0", "listen", "connect", "write", "cancel", "port0-code", "cancel-code", "identity-mismatch", "readback-mismatch", "hostile-direct", "hostile-code", "mediated", "mediated-crash", "mediated-public"]) test(`escalation live worker: real approve, delivered receipt, teardown, restart, consume and ${mode} result`, {
  skip: process.platform !== "darwin" ? "macOS only" : !mode.startsWith("mediated")
    ? process.env.RELAY_TEST_STAGE2_LIVE !== "1" && "host only: RELAY_TEST_STAGE2_LIVE=1"
    : mode === "mediated-public" ? process.env.RELAY_TEST_PUBLIC_NET !== "1" && "opt in: RELAY_TEST_PUBLIC_NET=1"
    : process.env.RELAY_TEST_MEDIATED_LIVE !== "1" && "host only: RELAY_TEST_MEDIATED_LIVE=1",
  timeout: mode === "mediated-crash" ? 240_000 : 150_000,
}, async t => {
  const bin = process.env.RELAY_TEST_CODEX ?? "/opt/homebrew/bin/codex";
  assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /codex-cli/);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "esc-live-")));
  const cwd = path.join(home, "work"), appHome = path.join(home, "app");
  fs.mkdirSync(cwd); fs.mkdirSync(appHome);
  process.env.RELAY_HOME = path.join(home, "registry"); process.env.RELAY_CONFIG = path.join(home, "config.json");
  const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 };
  const mediated = mode.startsWith("mediated");
  const surface = mode.startsWith("hostile-") ? mode.slice("hostile-".length) : "";
  const codeMode = mode.endsWith("-code");
  const mismatch = mode.endsWith("-mismatch");
  const outside = path.join(home, "outside"); fs.mkdirSync(outside);
  const forbiddenFile = path.join(home, "never-file"); fs.writeFileSync(forbiddenFile, "owned decoy");
  let capability: Record<string, unknown> = mediated ? { kind: "network", mode: "mediated" } : { kind: "port0" };
  let listenPort = 0;
  const connectServers: net.Server[] = [];
  const connectScript = path.join(cwd, "connect-command.cjs");
  let connectNeverPort = 0;
  let bindOutput = "", destinationAsked = false;
  let ownedPort = 0, udpSeen = 0;
  const udpSink = dgram.createSocket("udp4");
  udpSink.on("message", () => udpSeen++);
  const upstreamSockets = new Set<net.Socket>();
  const script = path.join(cwd, "mediated-command.cjs"), marker = path.join(cwd, "mediated-held");
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures/mediated-command.cjs"), script);
  let origin: number | undefined, overlayBinding: { run: string; id: string } | undefined;
  let handoffEvidence: { delivered: boolean | undefined; clean: boolean | undefined; sourceExecutors: number; sourceStatus: string | undefined } | undefined;
  const pendingResponses = new Set<http.ServerResponse>();
  const hostileBodies: any[] = [], hostileOutputs = new Map<string, string>();
  let unexpectedRequests = 0, responsesWebSocketUpgrades = 0, attackerOutput = "", ownedRun: string | undefined;
  const model = http.createServer((req, res) => {
    if (req.url === "/mediated-upstream" || req.url === "/mediated-hold") {
      upstreamSockets.add(req.socket); req.socket.once("close", () => upstreamSockets.delete(req.socket));
      if (req.url === "/mediated-upstream") res.end("MEDIATED_UPSTREAM_OK");
      return;
    }
    let raw = ""; req.on("data", d => raw += d);
    req.on("end", () => {
      const kind = modelStubRequestKind(req);
      if (kind === "websocket") { responsesWebSocketUpgrades++; res.writeHead(404); res.end(); return; }
      if (kind === "unexpected") { unexpectedRequests++; res.writeHead(404); res.end(); return; }
      const body = JSON.parse(raw), input = body.input ?? [];
      const text = JSON.stringify(input);
      const destination = text.includes("One-turn overlay");
      const outputs = input.filter((i: any) => /(?:_call_output|tool_search_output)$/.test(i.type ?? ""));
      const out = (id: string) => outputs.find((i: any) => i.call_id === id);
      let call: any, id: string;
      if (text.includes("CROSS_JOB_ATTACKER")) {
        id = "cross-job";
        const got = out(id);
        if (got) attackerOutput = typeof got.output === "string" ? got.output : JSON.stringify(got.output);
        call = got ? { type: "message", role: "assistant", content: [{ type: "output_text", text: "attacker complete" }] }
          : { type: "function_call", name: "exec_command", arguments: JSON.stringify({ login: false,
            cmd: `${JSON.stringify(process.execPath)} -e 'const n=require("node:net");const s=n.connect(${Number(fs.readFileSync(marker, "utf8"))},"127.0.0.1");s.setTimeout(3000,()=>{s.destroy();console.log("CROSS_JOB_TIMEOUT")});s.once("connect",()=>{console.log("CROSS_JOB_CONNECTED");s.destroy()});s.once("error",e=>console.log("CROSS_JOB_RESULT:"+e.code))'` }) };
      } else if (destination) {
        hostileBodies.push(body);
        destinationAsked = true;
        // Take evidence before the model issues its first replacement command,
        // rather than rely on catching a potentially short turn in a poll.
        const overlay = overlayBinding && getOverlay(overlayBinding.run, overlayBinding.id);
        handoffEvidence ??= { delivered: overlay?.receipt?.delivered, clean: overlay?.cleanup?.clean,
          sourceExecutors: executorRecords().records.filter(r => r.record.turnId === origin).length,
          sourceStatus: origin === undefined ? undefined : getTurn(origin)?.status };
        if (mismatch) {
          // Let the real restart reach its live readback, but issue no continuation commands.
          pendingResponses.add(res); res.once("close", () => pendingResponses.delete(res)); return;
        }
        const got = out("esc-bind");
        if (got) bindOutput = typeof got.output === "string" ? got.output : JSON.stringify(got.output);
        if (got && (mode === "mediated-crash" || mode === "cancel-code")) {
          pendingResponses.add(res); res.once("close", () => pendingResponses.delete(res)); return;
        }
        id = "esc-bind";
        call = got ? { type: "message", role: "assistant", content: [{ type: "output_text", text: "overlay complete" }] }
          : { type: "function_call", name: "exec_command", arguments: JSON.stringify({ login: false,
              cmd: mediated ? `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${ownedPort} ${mode === "mediated-public" ? "public" : "check"} ${JSON.stringify(marker)}`
                : mode === "connect" ? `${JSON.stringify(process.execPath)} ${JSON.stringify(connectScript)}`
                : mode === "write" ? `${JSON.stringify(process.execPath)} -e 'const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(path.join(outside, "written"))},"overlay write");try{fs.writeFileSync(${JSON.stringify(forbiddenFile)},"bad");throw Error("never write succeeded")}catch(e){if(e.code!=="EPERM"&&e.code!=="EACCES")throw e}console.log("OVERLAY_WRITE_OK")'`
                : `${JSON.stringify(process.execPath)} -e 'const s=require("node:net").createServer();s.listen(${mode === "listen" ? listenPort : 0},"0.0.0.0",()=>{console.log("OVERLAY_PORT0_OK:"+s.address().port);${mode === "cancel-code" ? "" : "s.close()"}})'`,
              ...(mode === "cancel-code" ? { yield_time_ms: 1000 } : {}),
            }) };
        if (!got && codeMode) call = codeCall(`const r = await tools.exec_command(${call.arguments}); text(typeof r === "string" ? r : JSON.stringify(r));`);
        if (surface) {
          const attempts = hostileWebCalls(surface, `http://forbidden.test:${ownedPort}/owned-never-page`);
          for (let k = 0; k < attempts.length; k++) {
            const got = out(`hostile-${k}`);
            if (got) hostileOutputs.set(`hostile-${k}`, typeof got.output === "string" ? got.output : JSON.stringify(got.output));
          }
          const next = attempts.findIndex((_, k) => !hostileOutputs.has(`hostile-${k}`));
          if (next >= 0) { id = `hostile-${next}`; call = attempts[next]; }
        }
      } else if (out("esc-request")) {
        // Keep the old model turn open until the worker interrupts it after receipt delivery.
        pendingResponses.add(res); res.once("close", () => pendingResponses.delete(res)); return;
      } else if (out("esc-search")) {
        id = "esc-request";
        call = { type: "function_call", namespace: "mcp__relay_tools", name: "escalate", arguments: JSON.stringify({ capabilities: [capability], reason: "authorized owned network/server test",
          continuation: { work: "Run the owned port-0 server test in the replacement turn", cwd } }) };
        if (codeMode) call = codeCall(`const r = await tools.mcp__relay_tools__escalate(${call.arguments}); text(typeof r === "string" ? r : JSON.stringify(r));`);
      } else {
        id = "esc-search"; call = { type: "tool_search_call", execution: "client", arguments: { query: "relay escalate", limit: 10 } };
      }
      const events = [{ type: "response.created", response: { id: `r-${id}` } },
        { type: "response.output_item.done", item: { ...call, ...(call.type === "message" ? {} : { call_id: id }), id: `i-${id}` } },
        { type: "response.completed", response: { id: `r-${id}`, usage } }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    });
  });
  let authority: Awaited<ReturnType<typeof openRootEnvironment>> | undefined;
  let worker: ReturnType<typeof spawn> | undefined, exited: Promise<void> | undefined;
  let workerDone = false, workerExit: number | null = null, diagnostics = "";
  const stopWorker = () => { worker?.kill("SIGTERM"); };
  t.signal.addEventListener("abort", stopWorker, { once: true });
  try {
    await new Promise<void>((ok, fail) => { model.once("error", fail); model.listen(0, "127.0.0.1", ok); });
    const port = (model.address() as net.AddressInfo).port;
    ownedPort = port;
    if (mode === "listen") {
      listenPort = await stableListenPort();
      assert.ok(listenPort > 10000 && listenPort < ephemeralFirst() && listenPort < 47200);
      capability = { kind: "localhost", port: listenPort, operation: "listen", api_effects: "owned server decoy" };
    } else if (mode === "connect") {
      const own = async (host: string) => {
        const server = net.createServer(c => c.destroy()); connectServers.push(server);
        await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, host, ok); });
        const port = (server.address() as net.AddressInfo).port;
        assert.ok(port > 10000);
        return port;
      };
      listenPort = await own("0.0.0.0");
      const otherPort = await own("127.0.0.1");
      connectNeverPort = await own("127.0.0.1");
      capability = { kind: "localhost", port: listenPort, operation: "connect", host: "127.0.0.1", api_effects: "Connect only to the owned test listener; no service API mutations" };
      const hosts = [...new Set(["127.0.0.1", ...Object.values(os.networkInterfaces()).flatMap(as => as ?? [])
        .filter(a => a.family === "IPv4" && !a.address.startsWith("127.")).map(a => a.address)])];
      fs.writeFileSync(connectScript, `const net=require("node:net"),assert=require("node:assert/strict");
        const check=(host,port)=>new Promise((resolve,reject)=>{const c=net.connect({host,port});const t=setTimeout(()=>{c.destroy();reject(Error("connect timed out:"+host+":"+port))},2000);const end=value=>{clearTimeout(t);c.destroy();resolve(value)};c.once("connect",()=>end("allowed"));c.once("error",e=>end(e.code))});
        (async()=>{for(const host of ${JSON.stringify(hosts)})assert.equal(await check(host,${listenPort}),"allowed",host);
        for(const [host,port] of ${JSON.stringify([["127.0.0.2", listenPort], ["::1", listenPort], ["::ffff:127.0.0.1", listenPort], ["127.0.0.1", otherPort], ["127.0.0.1", connectNeverPort]])})assert.equal(await check(host,port),"EPERM",host+":"+port);
        console.log("OVERLAY_CONNECT_OK:"+${JSON.stringify(hosts)}.join(","))})().catch(e=>{console.error(e);process.exitCode=1});\n`);
    } else if (mode === "write") capability = { kind: "write_root", root: outside };
    if (mediated) await new Promise<void>((ok, fail) => { udpSink.once("error", fail); udpSink.bind(port, "127.0.0.1", ok); });
    assert.ok(port > 10000);
    fs.copyFileSync(path.join(import.meta.dirname, "fixtures/stage2-catalog.json"), path.join(home, "catalog.json"));
    if (surface === "direct") {
      const catalog = JSON.parse(fs.readFileSync(path.join(home, "catalog.json"), "utf8"));
      catalog.models[0].tool_mode = "direct";
      fs.writeFileSync(path.join(home, "catalog.json"), JSON.stringify(catalog));
    }
    fs.writeFileSync(path.join(appHome, "config.toml"), `cli_auth_credentials_store="file"\nmodel="mock-model"\nopenai_base_url="http://127.0.0.1:${port}/v1"\nmodel_catalog_json=${JSON.stringify(path.join(home, "catalog.json"))}\n`);
    fs.writeFileSync(path.join(appHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-owned-model-stub" }));
    setCodexHomeConfigForTests(h => h === appHome ? fs.readFileSync(path.join(appHome, "config.toml"), "utf8") : undefined);
    let range;
    for (let n = 0; n < 100; n++) {
      const first = 50000 + 16 * Math.floor(Math.random() * 600);
      if (!busyPorts(Array.from({ length: 16 }, (_, k) => first + k)).size) { range = { first, count: 16 }; break; }
    }
    assert.ok(range, "owned high-port executor range");
    const cfg = withDefaults({ desktop_notifications: false, ask_user: "never", approval_timeout_s: 60, allow_temp_home: true,
      child_auth: "any", codex_endpoint_override: "accept", cancel_grace_ms: 1000,
      never: { paths: [{ path: forbiddenFile }], ...(surface ? { hosts: ["forbidden.test"] } : {}), ...(mediated ? { ports: [{ port: 49444, destinations: "any" }] } : mode === "connect" ? { ports: [{ port: connectNeverPort, destinations: "this-machine" }] } : {}) },
      targets: { codex: { bin, stage2: true, home: appHome, pinned: false } } });
    fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
    const root = newInstance({ kind: "root" }, cwd), run = createRun(cwd, cfg, root.token); root.runId = run;
    ownedRun = run;
    authority = await openRootEnvironment(root);
    const grant = mediated || surface || mode === "connect" ? undefined : { network: true, raw_network: true };
    const node = insertNode({ id: "j_00000002", run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "owned server test", cwd, status: "running", params_json: JSON.stringify({ grant }) });
    if (grant) setParam(node.id, "raw_network_consent", { grant: rawNetworkKey(grant), by: "test fixture person", at: Date.now() });
    fs.mkdirSync(nodeDir(run, node.id), { recursive: true });
    origin = insertTurn(node.id, "test", "Ask relay for a port0 overlay for the owned server test.", "write");
    // Run the actual detached worker entry point: it pins its own pid/start, claims
    // environment/redaction through the real root broker and drains both turns.
    // Only the synthetic model config and owned port range use code-only fixtures.
    const bootstrap = `
      import { runWorker } from ${JSON.stringify(new URL("../dist/worker.js", import.meta.url).href)};
      import { setLeaseOptionsForTests } from ${JSON.stringify(new URL("../dist/backends/codex-env.js", import.meta.url).href)};
      import { setCodexHomeConfigForTests } from ${JSON.stringify(new URL("../dist/backends/codex-pin.js", import.meta.url).href)};
      setLeaseOptionsForTests(${JSON.stringify({ range })});
      setCodexHomeConfigForTests(h => h === ${JSON.stringify(appHome)} ? ${JSON.stringify(fs.readFileSync(path.join(appHome, "config.toml"), "utf8"))} : undefined);
      ${mediated && mode !== "mediated-public" ? `
      const { createMediatedNetworkProvider, mediatedLookup, setMediatedNetworkProviderForTests } = await import(${JSON.stringify(new URL("../dist/core/mediated-network-provider.js", import.meta.url).href)});
      const { openProxy } = await import(${JSON.stringify(new URL("../dist/confine/proxy.js", import.meta.url).href)});
      const { default: net } = await import("node:net");
      const connect = net.connect;
      // Final numeric dial only: retain production publicPolicy and address screening first.
      net.connect = function(options, ...args) {
        return connect.call(this, options?.host === "8.8.8.8" && options.port === ${port} ? { ...options, host: "127.0.0.1" } : options, ...args);
      };
      setMediatedNetworkProviderForTests(createMediatedNetworkProvider({
        lookup: async (host, signal) => host === "owned-upstream.test" ? { addresses: ["8.8.8.8"], cnames: [] } : mediatedLookup(host, signal),
        open: async options => openProxy({ ...options, testing: { upstreamPort: ${port} } })
      }));
      ` : ""}
      ${mismatch ? `
      const { setStage2DepsForTests } = await import(${JSON.stringify(new URL("../dist/backends/codex-env.js", import.meta.url).href)});
      const { stage2TurnReadback } = await import(${JSON.stringify(new URL("../dist/backends/codex-stage2.js", import.meta.url).href)});
      const { procStart } = await import(${JSON.stringify(new URL("../dist/core/procs.js", import.meta.url).href)});
      let apps = 0, reads = 0;
      setStage2DepsForTests({
        appStart: (pid, options) => {
          const start = procStart(pid, options);
          return ++apps === 2 && ${mode === "identity-mismatch"} ? start + "-mismatched-start" : start;
        },
        turnReadback: (rpc, ...args) => {
          if (++reads !== 2 || ${mode !== "readback-mismatch"}) return stage2TurnReadback(rpc, ...args);
          // Real live reply, with only its environment identity contradicted at the existing seam.
          return stage2TurnReadback({ request: async (method, params) => {
            const result = await rpc.request(method, params);
            return method === "thread/read" ? { ...result, thread: { ...result.thread, environments: [] } } : result;
          } }, ...args);
        }
      });` : ""}
      await runWorker(${JSON.stringify(node.id)});
    `;
    worker = spawn(process.execPath, ["--input-type=module", "-e", bootstrap], { detached: true,
      env: { ...workerEnvironment(run), RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG }, stdio: ["ignore", "pipe", "pipe"] });
    const cut = redactor();
    for (const stream of [worker.stdout!, worker.stderr!]) stream.on("data", d => { diagnostics = (diagnostics + cut(String(d))).slice(-16000); });
    exited = new Promise<void>(resolve => {
      worker!.once("error", e => { diagnostics += String(e); });
      worker!.once("close", code => { workerDone = true; workerExit = code; resolve(); });
    });
    let request;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && !request && !workerDone && !t.signal.aborted;) {
      request = pendingRequests().find(r => r.node_id === node.id && r.kind === "escalation");
      if (!request) await new Promise(ok => setTimeout(ok, 20));
    }
    assert.ok(request, JSON.stringify({ node: getNode(node.id), turn: getTurn(origin), diagnostics }));
    assert.equal(getNode(node.id)?.worker_pid, worker.pid, "production worker registered its real identity");
    assert.equal(getNode(node.id)?.worker_start, procStart(worker.pid!));
    const overlayId = JSON.parse(request.detail_json!).overlay.id;
    if (mode === "connect") {
      const detail = JSON.parse(request.detail_json!);
      assert.match(JSON.stringify(detail), /LAN.*tailnet/);
      assert.match(detail.effect, /LAN.*tailnet/);
      assert.equal(requestView(request).effect, detail.effect, "approver view includes the stored connect disclosure");
    }
    overlayBinding = { run, id: overlayId };
    if (mode === "cancel") {
      const result = await cancel(root, { id: node.id });
      assert.ok(!result.error && !result.refused, JSON.stringify(result));
      while (!workerDone && !t.signal.aborted) await new Promise(ok => setTimeout(ok, 10));
      await exited;
      assert.equal(getNode(node.id)?.status, "cancelled");
      assert.equal(destinationAsked, false);
      assert.equal(getOverlay(run, overlayId).destinationTurn, undefined);
      assert.throws(() => consumeOverlay(run, overlayId, origin!), /destination|ready|cancel/);
      assert.equal(approve(root, { request_id: request.id, decision: "allow" }).decision === "allowed", false);
      assert.deepEqual(executorRecords().records, [], "cancel stopped the source executor");
      return;
    }
    assert.equal(approve(root, { request_id: request.id, decision: "allow" }).decision, "allowed");
    if (mode === "cancel-code") {
      for (const end = Date.now() + 60_000; Date.now() < end && !/OVERLAY_PORT0_OK:/.test(bindOutput) && !workerDone && !t.signal.aborted; )
        await new Promise(ok => setTimeout(ok, 20));
      assert.match(bindOutput, /OVERLAY_PORT0_OK:\d+/, JSON.stringify({ bindOutput, diagnostics }));
      const live = getOverlay(run, overlayId);
      assert.equal(live.receipt?.delivered, true);
      assert.ok(live.destinationTurn && live.launchedAt !== undefined, "cancel targets the running code-mode replacement");
      const result = await cancel(root, { id: node.id });
      assert.ok(!result.error && !result.refused, JSON.stringify(result));
      while (!workerDone && !t.signal.aborted) await new Promise(ok => setTimeout(ok, 10));
      await exited;
      assert.equal(getNode(node.id)?.status, "cancelled");
      assert.equal(getTurn(live.destinationTurn!)?.status, "cancelled");
      assert.deepEqual(executorRecords().records, [], "cancel stopped the code-mode replacement executor");
      assert.throws(() => consumeOverlay(run, overlayId, live.destinationTurn!), /ready|consumed/);
      await new Promise<void>((ok, fail) => {
        const c = net.connect(Number(/OVERLAY_PORT0_OK:(\d+)/.exec(bindOutput)![1]), "127.0.0.1");
        c.setTimeout(3000, () => { c.destroy(); fail(new Error("cancelled listener check timed out")); });
        c.once("connect", () => { c.destroy(); fail(new Error("code-mode listener survived cancellation")); });
        c.once("error", e => e.code === "ECONNREFUSED" ? ok() : fail(e));
      });
      return;
    }
    if (mode === "mediated-crash") {
      // Keep the replacement model turn open after its successful mediated command. The child
      // has left a real CONNECT tunnel to our held upstream, not a synthetic socket record.
      const until = async (check: () => boolean, what: string) => {
        for (const end = Date.now() + 60_000; Date.now() < end && !t.signal.aborted; ) {
          if (check()) return;
          assert.equal(workerDone, false, JSON.stringify({ diagnostics, node: getNode(node.id) }));
          await new Promise(ok => setTimeout(ok, 20));
        }
        assert.fail(`timed out waiting for ${what}`);
      };
      await until(() => /MEDIATED_RESULT:/.test(bindOutput) && upstreamSockets.size > 0, "live mediated tunnel");
      const proxyPort = Number(fs.readFileSync(marker, "utf8"));
      assert.ok(portHeld(proxyPort), "live victim proxy has a held lease");
      const victimRecord = executorRecords().records.find(r => r.record.nodeId === node.id);
      assert.ok(victimRecord, "live victim executor recorded before SIGKILL");
      const app = getNode(node.id)!;
      assert.ok(app.agent_pgid && app.agent_start, "live app identity persisted before crash");

      // Unsandboxed host control: this proxy really serves requests while the attacker probes.
      const control = () => new Promise<string>((ok, fail) => {
        const req = http.get({ hostname: "127.0.0.1", port: proxyPort,
          path: "http://owned-upstream.test/mediated-upstream", headers: { Host: "owned-upstream.test" } }, res => {
          let body = ""; res.on("data", b => body += b); res.once("end", () => ok(body));
        });
        req.setTimeout(5000, () => req.destroy(new Error("live proxy control timed out"))); req.once("error", fail);
      });
      assert.equal(await control(), "MEDIATED_UPSTREAM_OK");
      const attackerCwd = path.join(home, "attacker"); fs.mkdirSync(attackerCwd);
      const attacker = insertNode({ id: "j_attacker", run_id: run, kind: "job", target: "codex", mode: "write", depth: 1,
        task: "CROSS_JOB_ATTACKER", cwd: attackerCwd, status: "running", params_json: JSON.stringify({ grant: { network: true } }) });
      const attackTurn = insertTurn(attacker.id, "test", "CROSS_JOB_ATTACKER", "write", "running");
      const spec: TurnSpec = { target: targetDef("codex"), config: cfg, cwd: attackerCwd, access: "write", grant: { network: true },
        prompt: "CROSS_JOB_ATTACKER", dir: home, logPath: path.join(home, "attacker.log"), relay: null,
        markers: { runId: run, nodeId: attacker.id, depth: 1 }, turnId: attackTurn, neverPolicy: checkpointNever(run, "launch"),
        environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), CODEX_HOME: appHome, SHELL: "/bin/zsh" },
        signal: t.signal, onApproval: async () => { throw new Error("attacker must not request approval"); } };
      let handle: TurnHandle | undefined, finished = false;
      setLeaseOptionsForTests({ range });
      try {
        await withTurnSecrets(async () => {
          handle = await codexBackend.start(spec);
          const result = await handle.done; finished = true;
          assert.equal(result.status, "ok", JSON.stringify({ result, attackerOutput }));
        });
      } finally {
        if (handle) { if (!finished) await handle.cancel(); await handle.done; }
        updateTurn(attackTurn, { status: finished ? "done" : "failed" });
        setLeaseOptionsForTests(null);
      }
      assert.match(attackerOutput, /CROSS_JOB_RESULT:EPERM/);
      assert.doesNotMatch(attackerOutput, /CROSS_JOB_CONNECTED|CROSS_JOB_TIMEOUT/);
      assert.equal(await control(), "MEDIATED_UPSTREAM_OK", "victim was live on both sides of the confined attack");
      assert.ok(upstreamSockets.size > 0, "victim tunnel is still live at worker SIGKILL");
      worker.kill("SIGKILL"); // the worker only; production reap must stop its app and executor
      await exited;
      for (let end = Date.now() + 5000; upstreamSockets.size && Date.now() < end;) await new Promise(ok => setTimeout(ok, 20));
      assert.equal(upstreamSockets.size, 0, "SIGKILL closed the mediated tunnel");
      assert.ok(portHeld(proxyPort), "dead worker cannot release a proxy lease before verified reap");
      reap(run);
      assert.equal(sameProcess(app.agent_pgid!, app.agent_start!, { fresh: true }), false, "reap stopped the pinned app server");
      assert.equal(sameProcess(victimRecord.record.pid, victimRecord.record.start, { fresh: true }), false, "reap stopped the executor");
      assert.ok(executorRecords().records.some(r => r.file === victimRecord.file && /quarantine|untraceable/.test(r.record.tainted ?? "")), "unknown app cleanup keeps the executor record quarantined");
      assert.ok(portHeld(proxyPort), "proxy lease remains quarantined after reap");
      assert.match(overlayInterlock("local") ?? "", /reservation|executor|tainted/);
      assert.throws(() => consumeOverlay(run, overlayId, getOverlay(run, overlayId).destinationTurn!), /ready|consumed/);
      await assert.rejects(control(), /ECONNREFUSED/, "crashed proxy no longer serves requests");
      return;
    }
    // Let the worker select, consume and launch the replacement itself.
    while (!workerDone && !t.signal.aborted) {
      await new Promise(ok => setTimeout(ok, 10));
    }
    await exited;
    assert.equal(workerExit, 0, diagnostics);
    if (mismatch) {
      const overlay = getOverlay(run, overlayId);
      assert.equal(overlay.receipt?.delivered, true, "restart had a delivered receipt");
      assert.ok(overlay.consumedAt !== undefined && overlay.destinationTurn, "replacement was consumed exactly once");
      assert.equal(getTurn(overlay.destinationTurn!)?.status, "failed");
      assert.equal(getNode(node.id)?.status, "failed");
      assert.match(getNode(node.id)?.error ?? "", mode === "identity-mismatch" ? /unknown, dead or reused app server/ : /thread.*environment|thread.*relay/);
      assert.equal(bindOutput, "", "no continuation command was issued");
      assert.deepEqual(executorRecords().records, [], "failed replacement cleaned its real executor");
      assert.throws(() => consumeOverlay(run, overlayId, overlay.destinationTurn!), /ready|consumed/);
      return;
    }
    assert.equal(getNode(node.id)?.status, "done", JSON.stringify({ node: getNode(node.id), diagnostics }));
    assert.ok(handoffEvidence, "replacement reached the model");
    assert.equal(handoffEvidence.delivered, true);
    assert.equal(handoffEvidence.clean, true);
    assert.equal(handoffEvidence.sourceExecutors, 0, "old executor is gone before the replacement executes");
    assert.match(handoffEvidence.sourceStatus!, /^(done|failed|cancelled)$/, "source turn is terminal before replacement execution");
    assert.ok(destinationAsked);
    if (surface) {
      assertHostileWebEvidence(surface, hostileBodies, [...hostileOutputs.values()]);
      t.diagnostic(`model stub observed ${responsesWebSocketUpgrades} exact Responses websocket upgrade attempt(s)`);
      assert.equal(unexpectedRequests, 0, "hostile overlay made no non-model request, including for the decoy page, to the model stub");
    }
    assert.deepEqual(executorRecords().records, [], "replacement executor is also gone");
    const nextId = getOverlay(run, overlayId).destinationTurn; assert.ok(nextId);
    if (mediated) {
      assert.match(bindOutput, mode === "mediated-public" ? /MEDIATED_PUBLIC_OK:/ : /MEDIATED_RESULT:/, bindOutput);
      const proxyPort = mode === "mediated-public" ? Number(/MEDIATED_PUBLIC_OK:(\d+)/.exec(bindOutput)![1]) : Number(fs.readFileSync(marker, "utf8"));
      assert.ok(proxyPort > 1024);
      await new Promise<void>((ok, fail) => {
        const c = net.connect(proxyPort, "127.0.0.1");
        c.once("connect", () => { c.destroy(); fail(new Error("proxy still accepts after teardown")); });
        c.once("error", e => e.code === "ECONNREFUSED" ? ok() : fail(e));
      });
      assert.equal(upstreamSockets.size, 0, "no live owned upstream tunnels remain");
      assert.equal(udpSeen, 0, "owned DNS sink received no direct datagram");
    } else if (mode === "write") {
      assert.match(bindOutput, /OVERLAY_WRITE_OK/, bindOutput);
      assert.equal(fs.readFileSync(path.join(outside, "written"), "utf8"), "overlay write");
      assert.equal(fs.readFileSync(forbiddenFile, "utf8"), "owned decoy");
    } else if (mode === "connect") {
      assert.match(bindOutput, /OVERLAY_CONNECT_OK:127\.0\.0\.1/, bindOutput);
    } else {
      assert.match(bindOutput, /OVERLAY_PORT0_OK:/, bindOutput);
      if (mode === "listen") assert.match(bindOutput, new RegExp(`OVERLAY_PORT0_OK:${listenPort}\\b`));
    }
    assert.equal(getTurn(nextId)?.status, "done");
    assert.throws(() => consumeOverlay(run, overlayId, nextId), /ready|consumed/);
    const outcome = escalationAccounting(node.id)[0];
    assert.equal(outcome.destination_turn, nextId); assert.equal(outcome.launched, true);
    assert.equal(outcome.outcome, "completed"); assert.equal(outcome.cleanup, "verified");
    if (mediated) {
      assert.match(outcome.effective_scope, /Public hosts.*Tools must honour proxy settings/);
    } else if (mode === "port0" || mode === "port0-code" || surface) { assert.match(outcome.effective_scope, /port0/); assert.match(outcome.lan_disclosure, /0\.0\.0\.0.*LAN/); }
    else if (mode === "connect") { assert.match(outcome.effective_scope, /localhost/); assert.match(outcome.connect_disclosure, /LAN.*tailnet/); }
    else assert.match(outcome.effective_scope, mode === "listen" ? /localhost/ : /write/);
  } finally {
    t.signal.removeEventListener("abort", stopWorker);
    if (worker && !workerDone) {
      stopWorker();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 20000); })]); }
      finally { clearTimeout(timer); }
      if (!workerDone) { sendGroupSignal(worker.pid!, "SIGKILL"); await exited; }
    }
    // A worker can also die before the intended crash checkpoint. Reap its app first on every
    // exit path, rather than sweeping just the executor and leaving an orphaned app server.
    if (ownedRun) reap(ownedRun);
    sweepOrphanedExecutors();
    await authority?.close();
    if (mediated && ownedPort) udpSink.close();
    for (const socket of upstreamSockets) socket.destroy();
    await Promise.all(connectServers.map(server => new Promise<void>(ok => server.close(() => ok()))));
    for (const res of pendingResponses) res.destroy(); model.closeAllConnections();
    await new Promise<void>(ok => model.close(() => ok()));
    setCodexHomeConfigForTests(null); closeDbForTests(); fs.rmSync(home, { recursive: true, force: true });
  }
});
