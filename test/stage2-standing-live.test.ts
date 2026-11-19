// Host-only qualification: real Codex executor/app-server, production stage-2 admission,
// probes, proxy and teardown. All model/upstream traffic terminates at our owned listener.
import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LiveScope } from "./live-scope.ts";
import { hostileWebCalls, assertHostileWebEvidence, modelStubRequestKind } from "./fixtures/stage2-hostile-web.mjs";
import { codexBackend } from "../dist/backends/codex.js";
import { setLeaseOptionsForTests } from "../dist/backends/codex-env.js";
import { setCodexHomeConfigForTests } from "../dist/backends/codex-pin.js";
import type { TurnSpec, TurnHandle, TurnResult } from "../dist/backends/types.js";
import { busyPorts } from "../dist/confine/ports.js";
import { openProxy } from "../dist/confine/proxy.js";
import { targetDef } from "../dist/targets/index.js";
import { withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun, insertNode, insertTurn, updateTurn } from "../dist/core/db.js";
import { checkpointNever } from "../dist/core/never-checkpoint.js";
import { createMediatedNetworkProvider, setMediatedNetworkProviderForTests } from "../dist/core/mediated-network-provider.js";
import { executorRecords, sweepOrphanedExecutors } from "../dist/core/stage2-executors.js";
import { withTurnSecrets } from "../dist/core/secrets.js";

const skip = process.env.RELAY_TEST_STANDING_LIVE !== "1" ? "host only: RELAY_TEST_STANDING_LIVE=1"
  : process.platform !== "darwin" ? "macOS only" : false;
const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 };

const cases = [
  ...(["write", "read"] as const).flatMap(access => [false, true].map(childNetwork => ({ access, childNetwork, surface: "" }))),
  ...["direct", "code"].map(surface => ({ access: "write" as const, childNetwork: false, surface })),
];
for (const { access, childNetwork, surface } of cases) {
  test(`${surface ? "hostile web live: " + surface : "standing mediated live: " + (childNetwork ? "child_network" : "grant.network") + " " + access} fresh and kept resume`, { skip, timeout: 180_000 }, async t => {
    const scope = new LiveScope();
    const abort = () => scope.controller.abort(new Error("standing live test cancelled"));
    t.signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => scope.controller.abort(new Error("standing live test deadline")), 150_000);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-standing-")));
    const saved = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
    const cwd = path.join(home, "work"), appHome = path.join(home, "app");
    fs.mkdirSync(cwd); fs.mkdirSync(appHome);
    process.env.RELAY_HOME = path.join(home, "registry"); process.env.RELAY_CONFIG = path.join(home, "config.json");
    let epoch = 0, command = "", output = "", udpSeen = 0, upstreamRequests = 0, unexpectedRequests = 0, responsesWebSocketUpgrades = 0;
    let hostile: any[] = [], bodies: any[] = [];
    const hostileOutputs = new Map<string, string>();
    const upstreamSockets = new Set<net.Socket>();
    const model = http.createServer((req, res) => {
      if (req.url === "/mediated-upstream" || req.url === "/mediated-hold") {
        upstreamRequests++;
        upstreamSockets.add(req.socket); req.socket.once("close", () => upstreamSockets.delete(req.socket));
        if (req.url === "/mediated-upstream") res.end("MEDIATED_UPSTREAM_OK");
        return;
      }
      let raw = ""; req.on("data", b => raw += b);
      req.on("end", () => {
        const kind = modelStubRequestKind(req);
        if (kind === "websocket") { responsesWebSocketUpgrades++; res.writeHead(404); res.end("{}"); return; }
        if (kind === "unexpected") { unexpectedRequests++; res.writeHead(404); res.end("{}"); return; }
        const body = JSON.parse(raw); bodies.push(body);
        const id = `standing-${epoch}`;
        const outputs = (body.input ?? []).filter((i: any) => /_call_output$/.test(i.type ?? ""));
        for (let k = 0; k < hostile.length; k++) {
          const got = outputs.find((i: any) => i.call_id === `hostile-${epoch}-${k}`);
          if (got) hostileOutputs.set(got.call_id, typeof got.output === "string" ? got.output : JSON.stringify(got.output));
        }
        const next = hostile.findIndex((_, k) => !hostileOutputs.has(`hostile-${epoch}-${k}`));
        const got = outputs.find((i: any) => i.call_id === id);
        if (got) output = typeof got.output === "string" ? got.output : JSON.stringify(got.output);
        const item = next >= 0 ? { ...hostile[next], call_id: `hostile-${epoch}-${next}` }
          : got ? { type: "message", role: "assistant", content: [{ type: "output_text", text: "standing proxy checks complete" }] }
          : { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ login: false, cmd: command, timeout_ms: 30000 }) };
        const events = [{ type: "response.created", response: { id: `r-${id}` } },
          { type: "response.output_item.done", item: { ...item, id: `i-${id}` } },
          { type: "response.completed", response: { id: `r-${id}`, usage } }];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
      });
    });
    const udp = dgram.createSocket("udp4"); udp.on("message", () => udpSeen++);
    scope.defer(async () => {
      for (const socket of upstreamSockets) socket.destroy(); model.closeAllConnections();
      await new Promise<void>(ok => model.close(() => ok()));
    }, -20);
    try {
      const bin = process.env.RELAY_TEST_CODEX ?? "/opt/homebrew/bin/codex";
      assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /codex-cli/);
      await scope.wait(new Promise<void>((ok, fail) => { model.once("error", fail); model.listen(0, "127.0.0.1", ok); }));
      const port = (model.address() as net.AddressInfo).port;
      assert.ok(port > 10000);
      await scope.wait(new Promise<void>((ok, fail) => { udp.once("error", fail); udp.bind(port, "127.0.0.1", ok); }));
      scope.defer(() => new Promise<void>(ok => udp.close(() => ok())), -20);
      const gitEnv = { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: os.homedir(), GIT_CONFIG_NOSYSTEM: "1" };
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=relay test", "-c", "user.email=relay@test.invalid", ...args], { cwd, env: gitEnv, stdio: "pipe" });
      git("init", "-q", "-b", "main"); fs.writeFileSync(path.join(cwd, "README.md"), "standing mediated fixture\n");
      git("add", "README.md"); git("commit", "-qm", "fixture");
      const script = path.join(cwd, "mediated-command.cjs");
      fs.copyFileSync(path.join(import.meta.dirname, "fixtures/mediated-command.cjs"), script);
      fs.copyFileSync(path.join(import.meta.dirname, "fixtures/stage2-catalog.json"), path.join(home, "catalog.json"));
      if (surface === "direct") {
        const catalog = JSON.parse(fs.readFileSync(path.join(home, "catalog.json"), "utf8"));
        catalog.models[0].tool_mode = "direct";
        fs.writeFileSync(path.join(home, "catalog.json"), JSON.stringify(catalog));
      }
      const appConfig = `cli_auth_credentials_store="file"\nmodel="mock-model"\nopenai_base_url="http://127.0.0.1:${port}/v1"\nmodel_catalog_json=${JSON.stringify(path.join(home, "catalog.json"))}\n`;
      fs.writeFileSync(path.join(appHome, "config.toml"), appConfig);
      fs.writeFileSync(path.join(appHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-owned-standing-model" }));
      setCodexHomeConfigForTests(h => h === appHome ? appConfig : undefined);
      let range: { first: number; count: number } | undefined;
      for (let n = 0; n < 100; n++) {
        const first = 50000 + 16 * Math.floor(Math.random() * 600);
        if (!busyPorts(Array.from({ length: 16 }, (_, k) => first + k)).size) { range = { first, count: 16 }; break; }
      }
      assert.ok(range, "owned free executor range"); setLeaseOptionsForTests({ range });
      // DNS is deterministic and entirely in-process. Redirect only the final, already screened
      // public-IP dial to our owned upstream. The command process has no such fixture override.
      const realConnect = net.connect;
      t.mock.method(net, "connect", function(...args: any[]) {
        const options = args[0];
        if (options && typeof options === "object" && options.host === "8.8.8.8" && options.port === port)
          return realConnect.call(net, { ...options, host: "127.0.0.1" }, ...args.slice(1));
        return realConnect.apply(net, args as any);
      });
      setMediatedNetworkProviderForTests(createMediatedNetworkProvider({
        lookup: async host => {
          if (!["forbidden.test", "forbidden-alias.test", "owned-upstream.test"].includes(host)) throw new Error(`unexpected fixture DNS authority: ${host}`);
          return { addresses: [host === "forbidden.test" || host === "forbidden-alias.test" ? "9.9.9.9" : "8.8.8.8"], cnames: host === "forbidden-alias.test" ? ["forbidden.test"] : [] };
        },
        open: async options => openProxy({ ...options, testing: { upstreamPort: port } }),
      }));
      const config = withDefaults({ codex_backend: "app-server", child_network: childNetwork, escalation: false,
        child_auth: "any", codex_endpoint_override: "accept", child_mcp: "relay-only", cancel_grace_ms: 1000,
        never: { hosts: ["forbidden.test"], ports: [{ port: 49444, destinations: "any" }] },
        targets: { codex: { bin, stage2: true, home: appHome, pinned: false } } });
      fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify(config));
      const run = createRun(cwd, config, "standing-live-root"), nodeId = "j_standing";
      const grant = childNetwork ? undefined : { network: true };
      insertNode({ id: nodeId, run_id: run, kind: "job", target: "codex", mode: access, depth: 1, task: "owned standing mediated test", cwd, status: "running", params_json: JSON.stringify({ grant }) });
      let sessionId: string | undefined;
      const proxyPorts: number[] = [];
      for (const resumed of [false, true]) {
        epoch++; output = ""; bodies = []; hostileOutputs.clear();
        hostile = surface ? hostileWebCalls(surface, `http://forbidden.test:${port}/owned-never-page`) : [];
        command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${port} standing "$TMPDIR/standing-held-${epoch}"`;
        const notes: string[] = [];
        const turnId = insertTurn(nodeId, "test", resumed ? "kept resume" : "fresh", access, "running");
        updateTurn(turnId, { grant_json: grant ? JSON.stringify(grant) : null });
        const spec: TurnSpec = { target: targetDef("codex"), config, cwd, access, grant, sessionId,
          prompt: `standing mediated epoch ${epoch}`, dir: home, logPath: path.join(home, `turn-${epoch}.log`), relay: null,
          markers: { runId: run, nodeId, depth: 1 }, turnId, neverPolicy: checkpointNever(run, "launch"),
          environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), CODEX_HOME: appHome, SHELL: "/bin/zsh" },
          signal: scope.signal, onNote: note => notes.push(note), onApproval: async () => { throw new Error("standing grant must need no escalation"); } };
        let handle: TurnHandle | undefined, result: TurnResult | undefined;
        await withTurnSecrets(async () => {
          const starting = codexBackend.start(spec);
          const stop = scope.defer(async () => { const h = await starting.catch(() => null); if (h) { if (!result) await h.cancel(); await h.done; } }, 10);
          try { handle = await scope.wait(starting); result = await scope.wait(handle.done); }
          finally { await stop(); }
        });
        updateTurn(turnId, { status: result!.status === "ok" ? "done" : "failed" });
        assert.equal(result!.status, "ok", JSON.stringify({ result, output, notes }));
        if (surface) {
          assertHostileWebEvidence(surface, bodies, [...hostileOutputs.values()]);
          t.diagnostic(`model stub observed ${responsesWebSocketUpgrades} exact Responses websocket upgrade attempt(s)`);
          assert.equal(unexpectedRequests, 0, "no non-model request, including the decoy page, reached the model stub");
        }
        const matched = /MEDIATED_RESULT:(\{[^\r\n]+\})/.exec(output);
        assert.ok(matched, output);
        const evidence = JSON.parse(matched[1]);
        assert.equal(evidence.direct, "EPERM"); assert.equal(evidence.udp, "EPERM"); assert.equal(evidence.held, true);
        assert.ok(notes.some(n => /stage-2 mediated/.test(n) && /Go\/Swift TLS.*Release B/.test(n)), notes.join("\n"));
        assert.equal(udpSeen, 0, "direct DNS/UDP never reached our owned sink");
        assert.equal(upstreamSockets.size, 0, "all owned upstream tunnels closed at turn teardown");
        assert.deepEqual(executorRecords().records, [], "executor teardown completed");
        const proxyPort = Number(evidence.port); assert.ok(proxyPort > 1024); proxyPorts.push(proxyPort);
        await scope.wait(new Promise<void>((ok, fail) => {
          const c = net.connect(proxyPort, "127.0.0.1");
          c.setTimeout(3000, () => { c.destroy(); fail(new Error("proxy teardown check timed out")); });
          c.once("connect", () => { c.destroy(); fail(new Error("proxy still accepts after turn")); });
          c.once("error", e => e.code === "ECONNREFUSED" ? ok() : fail(e));
        }));
        assert.ok(result!.sessionId, "real Codex thread id");
        if (resumed) assert.equal(result!.sessionId, sessionId, "kept grant resumes the same thread");
        sessionId = result!.sessionId;
      }
      assert.equal(proxyPorts.length, 2); assert.equal(upstreamRequests, 4, "each fresh/resumed turn used the mediated provider for request and held tunnel");
    } finally {
      clearTimeout(deadline);
      try { await scope.close(); }
      finally {
        t.signal.removeEventListener("abort", abort);
        sweepOrphanedExecutors(); setLeaseOptionsForTests(null); setCodexHomeConfigForTests(null); setMediatedNetworkProviderForTests(null);
        closeDbForTests();
        for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });
}
