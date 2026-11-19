// Host-only qualification for item 29. One real, installed Claude turn (with stage 2 on, and again off) checks effective settings
// and native tools; its Bash carrier reaches owned listeners only through Relay's proxy, whose dial
// runs outside the confinement. Two deterministic ACP-v1 turns check the generic adapter: inside
// the granted profile, a parent listener synchronised to start after profile compilation is the
// positive loopback control and pre-start listeners are negative controls. The parent separately drives the production public
// proxy for exact built-in/user never decisions; that evidence is outside ACP confinement.
import "./helpers.ts";
import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { startAcpTurn, genericApproval, type AcpProfile } from "../dist/backends/acp.js";
import { CLAUDE_KEPT_BUILTIN, claudeBackend, claudeSkillsProblem, keepsPrivacyPlugin } from "../dist/backends/claude.js";
import { managedSettingsPaths } from "../dist/core/claude-settings.js";
import { withDefaults } from "../dist/core/config.js";
import { resolveNeverPolicy } from "../dist/core/never-policy.js";
import { neverKeychainIpc } from "../dist/core/never-coverage.js";
import { spawnSync } from "node:child_process";
import { attempt, decoyKeychain, keychainSkip, retrieved, withTeardown, wrapped, type DecoyKeychain } from "./keychain-decoy.ts";
import { openProxy, type TurnProxy } from "../dist/confine/proxy.js";
import { busyPorts } from "../dist/confine/ports.js";
import { targetDef } from "../dist/targets/index.js";
import { withTurnSecrets } from "../dist/core/secrets.js";
import type { TurnHandle, TurnResult, TurnSpec } from "../dist/backends/types.js";

const skip = process.env.RELAY_TEST_STAGE2_NATIVE_LIVE !== "1" ? "host only: RELAY_TEST_STAGE2_NATIVE_LIVE=1"
  : process.platform !== "darwin" ? "macOS only" : false;
// The installed Claude Code: the first `claude` on PATH, else the native installer's place under the
// real home folder (from the user database: HOME is a scratch folder here).
const CLAUDE = (process.env.PATH ?? "").split(":").filter(Boolean).map((dir) => path.join(dir, "claude"))
  .find((candidate) => fs.existsSync(candidate)) ?? path.join(os.userInfo().homedir, ".local/bin/claude");
const ACP_FIXTURE = path.join(import.meta.dirname, "fixtures/stage2-acp-native.mjs");
const NETWORK_FIXTURE = path.join(import.meta.dirname, "fixtures/stage2-native-network.mjs");
const SERVICE_PORTS = [22, 5900] as const;
const ALLOWED_HOST = "relay-stage2-owned.invalid";
const MODEL_HOST = "model.relay-stage2.invalid";

type Sink = { server: net.Server; port: number; accepts: string[]; payloads: string[]; close(): Promise<void> };

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

async function sink(port = 0): Promise<Sink> {
  const accepts: string[] = [], payloads: string[] = [];
  const server = net.createServer((socket) => {
    accepts.push(`${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`);
    socket.setEncoding("utf8");
    socket.once("data", (data) => {
      payloads.push(String(data).slice(0, 200));
      if (/^GET /.test(data)) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 17\r\nConnection: close\r\n\r\nOWNED_ALLOWED_OK\n");
      else socket.end("OWNED_ALLOWED_OK\n");
    });
    socket.once("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => { server.off("error", reject); resolve(); });
  });
  return {
    server, port: (server.address() as net.AddressInfo).port, accepts, payloads,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

async function ownedNeverSinks(count = 2): Promise<Sink[]> {
  const out: Sink[] = [];
  try {
    for (let attempts = 0; out.length < count && attempts < 200; attempts++) {
      const port = 30_000 + Math.floor(Math.random() * 10_000);
      if (out.some(item => item.port === port)) continue;
      if (busyPorts([port]).has(port)) continue;
      try { out.push(await sink(port)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE") throw error;
      }
    }
    assert.equal(out.length, count, `could not bind ${count} exclusively owned high-port never decoys`);
    return out;
  } catch (error) {
    await Promise.all(out.map(item => item.close()));
    throw error;
  }
}

async function lateSink(excluded: ReadonlySet<number>): Promise<Sink> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = await sink();
    if (!excluded.has(candidate.port)) return candidate;
    await candidate.close();
  }
  throw new Error("could not open a post-start listener outside the denied port sets");
}

function scratchHome(): string {
  // At this length Claude's private TMPDIR plus its claude-<uid> suffix is at most 44 bytes, so the
  // qualification never creates or changes relay's /Users/Shared native-temp alias.
  const home = fs.realpathSync(fs.mkdtempSync("/Users/Shared/r-"));
  return home;
}

function saveProcessEnv() {
  const names = ["HOME", "RELAY_HOME", "RELAY_CONFIG", "RELAY_WORKTREES", "RELAY_DEV_MODEL_STUB", "RELAY_EXPERIMENTAL_CODEX_STAGE2"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };
}

function useScratch(home: string, stateRoot = home, modelStub = false) {
  process.env.HOME = home;
  process.env.RELAY_HOME = path.join(stateRoot, "relay");
  process.env.RELAY_CONFIG = path.join(stateRoot, "relay-config.json");
  process.env.RELAY_WORKTREES = path.join(stateRoot, "worktrees");
  if (modelStub) process.env.RELAY_DEV_MODEL_STUB = "1";
  else delete process.env.RELAY_DEV_MODEL_STUB;
}

type ModelStep = { name: "Read" | "Edit" | "Bash"; input: Record<string, unknown> };
type ScriptedModel = {
  server: http.Server;
  port: number;
  issued: string[];
  results: Set<string>;
  errors: string[];
  close(): Promise<void>;
};

/** A prompt-independent Anthropic Messages stub: one tool call per response, then end_turn. */
async function scriptedModel(steps: readonly ModelStep[]): Promise<ScriptedModel> {
  const issued: string[] = [], results = new Set<string>(), errors: string[] = [];
  let next = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (req.url?.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        return void res.end('{"input_tokens":1}');
      }
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json", connection: "close" });
        return void res.end('{"type":"error","error":{"type":"not_found_error","message":"stage2 stub"}}');
      }
      let request: any;
      try { request = JSON.parse(body); }
      catch {
        errors.push("model request was not JSON");
        res.writeHead(400, { connection: "close" });
        return void res.end();
      }
      for (const message of request.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "tool_result" && /^toolu_stage2_\d+$/.test(block.tool_use_id ?? "")) results.add(block.tool_use_id);
      }
      const hasNativeTools = (request.tools ?? []).some((tool: any) => tool?.name === "Read")
        && (request.tools ?? []).some((tool: any) => tool?.name === "Edit")
        && (request.tools ?? []).some((tool: any) => tool?.name === "Bash");
      let block: any;
      if (!hasNativeTools) {
        block = { type: "text", text: "stage2 auxiliary request" };
      } else if (next > 0 && !results.has(`toolu_stage2_${next - 1}`)) {
        errors.push(`request for step ${next} arrived before toolu_stage2_${next - 1}'s result`);
        res.writeHead(409, { "content-type": "application/json", connection: "close" });
        return void res.end('{"type":"error","error":{"type":"invalid_request_error","message":"missing scripted tool result"}}');
      } else if (next < steps.length) {
        const step = steps[next];
        block = { type: "tool_use", id: `toolu_stage2_${next}`, ...step };
        issued.push(step.name);
        next++;
      } else {
        block = { type: "text", text: "QUALIFICATION_DONE" };
      }
      const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
      const message = { id: `msg_stage2_${next}`, type: "message", role: "assistant",
        model: request.model ?? "claude-haiku-stub", content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } };
      if (!request.stream) {
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        return void res.end(JSON.stringify({ ...message, content: [block], stop_reason: stop }));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      const event = (type: string, data: Record<string, unknown>) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", { message });
      event("content_block_start", { index: 0, content_block: block.type === "tool_use"
        ? { type: "tool_use", id: block.id, name: block.name, input: {} } : { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: block.type === "tool_use"
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: block.text } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
      event("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return { server, port: (server.address() as net.AddressInfo).port, issued, results, errors,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }) };
}

/** Established development route: set only the stub endpoint/key, then exec the exact installed CLI. */
function claudeStubLauncher(root: string): string {
  const launcher = path.join(root, "claude-stage2-stub");
  fs.writeFileSync(launcher, `#!/bin/sh
export ANTHROPIC_BASE_URL=${JSON.stringify(`http://${MODEL_HOST}`)}
export ANTHROPIC_API_KEY=sk-ant-stub-0000
exec ${JSON.stringify(CLAUDE)} "$@"
`, { mode: 0o700 });
  return launcher;
}

function fixtureFiles(home: string) {
  const cwd = path.join(home, "work");
  const outside = path.join(home, "outside");
  fs.mkdirSync(cwd); fs.mkdirSync(outside);
  const allowedFile = path.join(cwd, "allowed.txt");
  const forbiddenFile = path.join(outside, "forbidden.txt");
  const networkProbe = path.join(cwd, "stage2-native-network.mjs");
  fs.writeFileSync(allowedFile, "ALLOWED_READ_NONCE_29\n");
  fs.writeFileSync(forbiddenFile, "FORBIDDEN_UNCHANGED_29\n");
  fs.copyFileSync(NETWORK_FIXTURE, networkProbe);
  return { cwd, allowedFile, forbiddenFile, allowedWrite: path.join(cwd, "acp-write.txt"), networkProbe };
}

function policy(home: string, forbiddenFile: string, neverPorts: readonly number[]) {
  const p = resolveNeverPolicy({ home, never: {
    paths: [{ path: forbiddenFile }],
    ports: neverPorts.map(port => ({ port, transport: "both" as const, destinations: "this-machine" as const })),
  } });
  assert.deepEqual(p.ports.map(entry => entry.port).sort((a, b) => a - b),
    [...SERVICE_PORTS, ...neverPorts].sort((a, b) => a - b), "the exact built-in list plus owned user-never decoys");
  assert.deepEqual(p.ports.filter(entry => entry.id.startsWith("service.")).map(entry => entry.port).sort((a, b) => a - b),
    [...SERVICE_PORTS].sort((a, b) => a - b), "every built-in service port remains in the floor");
  return p;
}

async function complete(starting: Promise<TurnHandle>): Promise<TurnResult> {
  const handle = await starting;
  let done = false;
  try { const result = await handle.done; done = true; return result; }
  finally { if (!done) await handle.cancel(); }
}

function redirectOwnedDial(t: TestContext, allowed: Sink, nestedProxyPort?: number) {
  const connect = net.connect;
  t.mock.method(net, "connect", function(...args: any[]) {
    const options = args[0];
    if (options && typeof options === "object" && options.host === "8.8.8.8") {
      if (nestedProxyPort !== undefined && options.port === nestedProxyPort)
        return connect.call(net, { ...options, host: "127.0.0.1", port: nestedProxyPort }, ...args.slice(1));
      if (options.port === allowed.port || options.port === 443)
        return connect.call(net, { ...options, host: "127.0.0.1", port: allowed.port }, ...args.slice(1));
    }
    return connect.apply(net, args as any);
  });
}

function proxyTunnel(raw: string, host: string, port: number, payload = ""): Promise<{ ok: boolean; code?: string; data?: string }> {
  return new Promise(resolve => {
    const proxy = new URL(raw);
    const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
    let data = "", established = false, settled = false;
    const done = (answer: { ok: boolean; code?: string; data?: string }) => {
      if (settled) return;
      settled = true; socket.destroy(); resolve(answer);
    };
    socket.setTimeout(3000, () => done({ ok: false, code: "ETIMEDOUT" }));
    socket.once("connect", () => socket.write(
      `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${auth}\r\nConnection: close\r\n\r\n`,
    ));
    socket.on("data", chunk => {
      data += chunk;
      if (!established) {
        const end = data.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = data.slice(0, end); data = data.slice(end + 4);
        if (!/^HTTP\/1\.[01] 200\b/.test(head)) return done({ ok: false, code: /^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? "BAD_PROXY_REPLY" });
        established = true;
        if (payload) socket.write(payload); else return done({ ok: true });
      }
      if (data.includes("\n") || data.includes("ALLOWED")) done({ ok: true, data: data.slice(0, 120) });
    });
    socket.once("error", error => done({ ok: false, code: String((error as NodeJS.ErrnoException).code ?? error.message) }));
    socket.once("close", () => done({ ok: false, code: established ? "ECONNCLOSED" : "NO_PROXY_REPLY" }));
  });
}

// Claude takes the floor whatever stage 2 says (core/never-coverage.ts), so the same installed-CLI
// case runs with stage 2 on and off. Item 29 (the Codex pin) runs the stage-2-on variant; the
// stage-2-off one is release check claude-floor, part nativeStage2Off.
for (const stage2 of [true, false]) test(`stage2 native live: installed Claude settings and native tools enforce the never floor (stage 2 ${stage2 ? "on" : "off"})`, { skip, timeout: 300_000 }, async (t) => {
  const restore = saveProcessEnv();
  if (!stage2) delete process.env.RELAY_EXPERIMENTAL_CODEX_STAGE2;
  const home = scratchHome();
  const runRoot = fs.realpathSync(fs.mkdtempSync(path.join(home, "run-")));
  let allowed: Sink | undefined;
  let neverSinks: Sink[] = [];
  let publicProxy: TurnProxy | undefined;
  let model: ScriptedModel | undefined;
  try {
    useScratch(home, runRoot, true);
    fs.mkdirSync(process.env.RELAY_HOME!, { recursive: true });
    const files = fixtureFiles(runRoot);
    allowed = await sink();
    neverSinks = await ownedNeverSinks();
    const lookup = dns.promises.lookup.bind(dns.promises);
    t.mock.method(dns.promises, "lookup", ((host: string, options: any) => host === ALLOWED_HOST
      ? Promise.resolve(options?.all ? [{ address: "8.8.8.8", family: 4 }] : { address: "8.8.8.8", family: 4 })
      : lookup(host, options)) as typeof dns.promises.lookup);
    const floor = policy(home, files.forbiddenFile, neverSinks.map(item => item.port));
    for (let attempt = 0; attempt < 10; attempt++) {
      publicProxy = await openProxy({ neverPolicy: floor, mode: "public", allow: [],
        logFile: path.join(runRoot, "claude-public-proxy.jsonl"), label: "claude-native/public" });
      if (!floor.authorityPorts.includes(publicProxy.port)) break;
      await publicProxy.close(); publicProxy = undefined;
    }
    assert.ok(publicProxy, "could not open the Claude test's nested public proxy outside relay's reserved port range");
    redirectOwnedDial(t, allowed, publicProxy.port);
    const publicProxyUrl = `http://relay:${publicProxy.token}@127.0.0.1:${publicProxy.port}`;
    // Built-ins are never bound or dialled directly: the Bash fixture explicitly sends CONNECT
    // requests through Claude's own proxy to a second production public proxy and each must log a
    // service.* refusal. The outer proxy's final public-IP dial is deterministically redirected to
    // that owned proxy. The two owned high ports are the actual-dial canaries: nested proxy requests
    // and harmless direct connects must leave their accept logs empty. The allowed sink must accept.
    const networkPlan = JSON.stringify({ carrierHost: "8.8.8.8", carrierPort: publicProxy.port,
      publicHost: ALLOWED_HOST, allowedPort: allowed.port, servicePorts: SERVICE_PORTS,
      neverPorts: neverSinks.map(item => item.port) });
    const bash = [
      `/bin/cat ${JSON.stringify(files.forbiddenFile)}`,
      `${JSON.stringify(process.execPath)} ${JSON.stringify(files.networkProbe)} ${JSON.stringify(networkPlan)}`,
    ].join(" ; ");
    const steps: ModelStep[] = [
      { name: "Read", input: { file_path: files.allowedFile } },
      { name: "Read", input: { file_path: files.forbiddenFile } },
      { name: "Edit", input: { file_path: files.forbiddenFile, old_string: "FORBIDDEN_UNCHANGED_29\n", new_string: "CHANGED_BY_CLAUDE\n" } },
      { name: "Bash", input: { command: bash, description: "Run the fixed stage2 native network probe" } },
    ];
    model = await scriptedModel(steps);
    const stubFile = path.join(process.env.RELAY_HOME!, "dev", "claude-model-stub.json");
    fs.mkdirSync(path.dirname(stubFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stubFile, JSON.stringify({ host: MODEL_HOST, port: model.port }));
    const launcher = claudeStubLauncher(runRoot);
    const logPath = path.join(runRoot, "claude-agent.log");
    assert.ok(fs.existsSync(CLAUDE), `installed Claude missing at ${CLAUDE}`);
    assert.deepEqual(managedSettingsPaths().filter(candidate => fs.existsSync(candidate)), [],
      "an existing system managed-settings source is never overwritten; relay's floored Claude route refuses it instead");
    const config = withDefaults({ allow_temp_home: true, escalation: false, child_settings: "isolated", child_hooks: false,
      child_mcp: "relay-only", child_env: { pass: ["STAGE2_CLAUDE_NESTED_PROXY"] },
      targets: { claude: { bin: launcher, child_auth: "any" }, codex: { stage2 } } });
    // The prompt carries no tool instructions. The owned Messages stub above drives the exact
    // sequence and advances only after Claude Code returns each tool result, including refusals.
    // This uses the real installed CLI and Relay's production settings/proxy, but deliberately
    // does not prove real Anthropic/model transport, provider login, quota, or model behaviour.
    const spec: TurnSpec = { target: targetDef("claude"), config, cwd: files.cwd, access: "write", grant: { network: true },
      model: "haiku", prompt: "stage2 native qualification", dir: runRoot, logPath, relay: null, markers: { runId: "stage2-native", nodeId: "claude-native", depth: 1 },
      neverPolicy: floor, environment: { HOME: home, USER: os.userInfo().username,
        PATH: [...new Set([path.dirname(CLAUDE), "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"), SHELL: "/bin/zsh", LANG: "C.UTF-8", STAGE2_CLAUDE_NESTED_PROXY: publicProxyUrl },
      environmentReleased: ["STAGE2_CLAUDE_NESTED_PROXY"],
      signal: t.signal, onApproval: async () => { throw new Error("item 29 has no approval route"); } };
    const result = await withTurnSecrets(() => complete(claudeBackend.start(spec)));
    const log = fs.readFileSync(logPath, "utf8");
    assert.equal(result.status, "ok", JSON.stringify({ result, log: log.slice(-8000) }));
    assert.ok(result.sessionId, "installed Claude returned a real session id");
    assert.match(log, /"--setting-sources" ""/, "production launch isolated user/project setting sources");
    assert.match(log, /"--settings" "[^"]+\/claude-settings\.json"/, "production launch handed Claude relay's compiled runtime settings");
    assert.deepEqual(result.served, undefined, "Claude's native stream does not synthesize ACP served-model evidence");
    assert.equal(fs.readFileSync(files.forbiddenFile, "utf8"), "FORBIDDEN_UNCHANGED_29\n", "Read/Edit/Bash never changed the owned forbidden file");
    assert.ok(allowed.accepts.length > 0, "the allowed network control reached its listener");
    assert.ok(allowed.payloads.some(payload => /CLAUDE_PROXY_PING/.test(payload)), allowed.payloads.join("\n"));
    for (const decoy of neverSinks) assert.deepEqual(decoy.accepts, [], `Claude made no actual dial to owned user-never port ${decoy.port}`);

    const events = log.split("\n").filter(line => line.trim().startsWith("{")).map(line => JSON.parse(line));
    const init = events.find(event => event.type === "system" && event.subtype === "init");
    assert.equal(init?.permissionMode, "acceptEdits", "installed Claude read back relay's effective permission mode");
    for (const tool of ["Bash", "Read", "Edit"]) assert.ok(init?.tools?.includes(tool), `installed Claude readback includes ${tool}`);
    // On a version where relay read cc-plugin-privacy, that built-in stays on; nothing else may load.
    const kept = keepsPrivacyPlugin(String(init?.claude_code_version ?? ""))
      ? [{ name: CLAUDE_KEPT_BUILTIN, path: "builtin", source: `${CLAUDE_KEPT_BUILTIN}@builtin` }] : [];
    assert.deepEqual(init?.plugins, kept, "installed Claude loaded no unapproved plugin");
    assert.equal(claudeSkillsProblem(init as Record<string, unknown>, undefined), null, "relay's own init check admits what installed Claude loaded");
    assert.deepEqual(init?.skills, [], "installed Claude loaded no unapproved skill");
    assert.equal(init?.apiKeySource, "ANTHROPIC_API_KEY", "the stub uses only its owned dummy key under child_auth any");
    const uses = events.flatMap(event => event.type === "assistant" && Array.isArray(event.message?.content) ? event.message.content : [])
      .filter(block => block?.type === "tool_use");
    assert.deepEqual(uses.filter(block => /^toolu_stage2_\d+$/.test(block.id ?? "")).map(block => block.name),
      steps.map(step => step.name), "the real native tool attempts appeared in the stream exactly once and in scripted order");
    for (const tool of ["Bash", "Read", "Edit"]) assert.ok(uses.some(block => block.name === tool), `real turn attempted native ${tool}`);
    assert.ok(uses.some(block => block.name === "Read" && block.input?.file_path === files.allowedFile), "positive Read control used the exact allowed file");
    assert.ok(uses.some(block => block.name === "Read" && block.input?.file_path === files.forbiddenFile), "native Read tried the exact never file");
    assert.ok(uses.some(block => block.name === "Edit" && block.input?.file_path === files.forbiddenFile), "native Edit tried the exact never file");
    assert.ok(uses.some(block => block.name === "Bash" && block.input?.command === bash), "native Bash ran the fixed file/network probe");
    assert.deepEqual(model.issued, steps.map(step => step.name), "the stub issued every scripted tool call exactly once and in order");
    assert.deepEqual([...model.results].sort(), steps.map((_, i) => `toolu_stage2_${i}`), "Claude Code returned a result for every real tool attempt");
    assert.deepEqual(model.errors, [], "the installed CLI followed the scripted Messages/tool-result protocol");
    assert.match(log, /ALLOWED_READ_NONCE_29/, "the allowed Read tool returned its owned nonce");
    const networkText = events.flatMap(stringsIn).find(text => text.includes("STAGE2_NATIVE_NETWORK:")) ?? "";
    const networkLine = /STAGE2_NATIVE_NETWORK:(\{[^\r\n]+\})/.exec(networkText);
    assert.ok(networkLine, "the fixed Bash network fixture returned evidence");
    const networkEvidence = JSON.parse(networkLine[1]);
    assert.equal(networkEvidence.allowed.ok, true, JSON.stringify(networkEvidence.allowed));
    for (const { port } of neverSinks) {
      const evidence = networkEvidence.neverPorts.find((entry: any) => entry.port === port);
      assert.ok(evidence && evidence.proxy.ok === false && evidence.direct.ok === false, JSON.stringify(networkEvidence));
    }
    assert.ok(result.denials?.some(denial => denial.includes(files.forbiddenFile) && /Read/.test(denial)), JSON.stringify(result.denials));
    assert.ok(result.denials?.some(denial => denial.includes(files.forbiddenFile) && /Edit/.test(denial)), JSON.stringify(result.denials));
    const modelDecisions = fs.readFileSync(path.join(runRoot, "proxy.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(modelDecisions.some(d => d.event === "allow" && d.target === `${MODEL_HOST}:80` && d.token === true && d.stub === true),
      `the installed CLI reached the owned model only through Relay's authenticated stub mapping: ${JSON.stringify(modelDecisions)}`);
    const decisions = fs.readFileSync(path.join(runRoot, "claude-public-proxy.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const port of SERVICE_PORTS) assert.ok(decisions.some(d => d.event === "deny" && d.target === `127.0.0.1:${port}` && d.reason === "refused"), `proxy recorded the built-in service denial for ${port}: ${JSON.stringify(decisions)}`);
    for (const { port } of neverSinks) assert.ok(decisions.some(d => d.event === "deny" && d.target === `127.0.0.1:${port}` && d.reason === "refused"), `proxy recorded the user-never denial for ${port}: ${JSON.stringify(decisions)}`);
    t.diagnostic("installed Claude binary with owned Messages stub: no provider login, quota, or real model transport");
  } finally {
    t.mock.restoreAll();
    await publicProxy?.close();
    await model?.close();
    await Promise.all([...neverSinks, ...(allowed ? [allowed] : [])].map(item => item.close()));
    restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("stage2 native live: scripted generic ACP profile and proxy enforce the never floor", { skip, timeout: 120_000 }, async (t) => {
  const restore = saveProcessEnv();
  const home = scratchHome();
  let allowed: Sink | undefined;
  let neverSinks: Sink[] = [];
  let publicProxy: TurnProxy | undefined;
  let lateAllowed: Sink | undefined;
  let directHandle: TurnHandle | undefined, directDone = false;
  try {
    useScratch(home);
    const files = fixtureFiles(home);
    allowed = await sink();
    neverSinks = await ownedNeverSinks();
    const lookup = dns.promises.lookup.bind(dns.promises);
    t.mock.method(dns.promises, "lookup", ((host: string, options: any) => host === ALLOWED_HOST
      ? Promise.resolve(options?.all ? [{ address: "8.8.8.8", family: 4 }] : { address: "8.8.8.8", family: 4 })
      : lookup(host, options)) as typeof dns.promises.lookup);
    redirectOwnedDial(t, allowed);
    const floor = policy(home, files.forbiddenFile, neverSinks.map(item => item.port));
    // Exact built-in/user proxy evidence is driven here, outside the confined ACP turn. The direct
    // turn receives no route to this proxy; its synchronised post-start listener is the control.
    publicProxy = await openProxy({ neverPolicy: floor, mode: "public", allow: [],
      logFile: path.join(home, "acp-public-proxy.jsonl"), label: "acp-native/public" });
    const publicProxyUrl = `http://relay:${publicProxy.token}@127.0.0.1:${publicProxy.port}`;
    const parentProxyAllowed = await proxyTunnel(publicProxyUrl, ALLOWED_HOST, allowed.port, "ACP_PARENT_PROXY_PING\n");
    assert.equal(parentProxyAllowed.ok, true, JSON.stringify(parentProxyAllowed));
    assert.match(parentProxyAllowed.data ?? "", /OWNED_ALLOWED_OK/);
    // Built-in and user never-ports here are "this-machine" rules, so the probes name this Mac: the
    // same port on a public host is correctly allowed. The proxy refuses before dialling anything.
    for (const port of SERVICE_PORTS) assert.equal((await proxyTunnel(publicProxyUrl, "127.0.0.1", port)).code, "403", `built-in ${port}`);
    for (const { port } of neverSinks) assert.equal((await proxyTunnel(publicProxyUrl, "127.0.0.1", port)).code, "403", `user-never ${port}`);
    await proxyTunnel(publicProxyUrl, "127.0.0.1", allowed.port);
    const base = targetDef("gemini");
    const target = { ...base, name: "Scripted ACP qualification fixture", product: "scripted ACP fixture", apiHosts: [ALLOWED_HOST] };
    const config = withDefaults({ allow_temp_home: true, escalation: false, child_auth: "any", targets: {
      codex: { stage2: true }, gemini: { enabled: true, bin: process.execPath, child_auth: "any" },
    } });
    const profile: AcpProfile = { args: () => [ACP_FIXTURE], scrub: () => false,
      prepareState: () => ({ stateDirs: [], keychain: false }),
      login: { how: "scripted fixture has no provider login" }, normalizeApproval: genericApproval };
    const common = { target, config, cwd: files.cwd, access: "write" as const, dir: home, relay: null,
      markers: { runId: "stage2-native", nodeId: "acp-native", depth: 1 }, neverPolicy: floor,
      environment: { HOME: home, USER: os.userInfo().username, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: "/bin/zsh", LANG: "C.UTF-8" },
      signal: t.signal, onApproval: async () => { throw new Error("item 29 has no approval route"); } };
    const turnSpec = (mode: "proxy" | "direct", extra: Record<string, unknown> = {}) => {
      const logPath = path.join(home, `acp-${mode}.log`);
      const prompt = JSON.stringify({ mode, allowedHost: ALLOWED_HOST, allowedPort: allowed.port,
        neverPorts: neverSinks.map(item => item.port), ...files, ...extra });
      const direct = mode === "direct" ? { grant: { network: true } } : {};
      return { spec: { ...common, ...direct, prompt, logPath } as TurnSpec, logPath };
    };
    const run = async (mode: "proxy") => {
      const { spec, logPath } = turnSpec(mode);
      const result = await complete(startAcpTurn(spec, profile));
      return { result, log: fs.readFileSync(logPath, "utf8"), evidence: JSON.parse(result.finalMessage) };
    };
    const proxied = await run("proxy");
    const allowedBeforeDirect = allowed.accepts.length;
    // NETWORK_ON denies all of this Mac's own addresses. To show that does not depend on when a
    // listener started, the ready file is written from inside the prompt after the profile is live;
    // only then is a parent-owned listener opened and its port written back, and it must be refused.
    const readyFile = path.join(files.cwd, "direct-ready");
    const goFile = path.join(files.cwd, "direct-go.json");
    const directTurn = turnSpec("direct", { readyFile, goFile, publicControlHost: "1.1.1.1", publicControlPort: 443 });
    directHandle = await startAcpTurn(directTurn.spec, profile);
    let early: TurnResult | undefined;
    directHandle.done.then(result => { early = result; directDone = true; });
    for (const deadline = Date.now() + 60_000; !fs.existsSync(readyFile) && !early && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(fs.existsSync(readyFile), `direct ACP turn ended before its post-start control (${JSON.stringify(early)})`);
    lateAllowed = await lateSink(new Set([...SERVICE_PORTS, ...neverSinks.map(item => item.port), ...floor.authorityPorts]));
    fs.writeFileSync(`${goFile}.tmp`, JSON.stringify({ port: lateAllowed.port }));
    fs.renameSync(`${goFile}.tmp`, goFile);
    const directResult = await directHandle.done;
    directDone = true;
    const direct = { result: directResult, log: fs.readFileSync(directTurn.logPath, "utf8"), evidence: JSON.parse(directResult.finalMessage) };
    for (const turn of [proxied, direct]) {
      assert.equal(turn.result.status, "ok", JSON.stringify(turn.result));
      assert.equal(turn.evidence.files.allowedRead, "ALLOWED_READ_NONCE_29\n");
      assert.match(turn.evidence.files.forbiddenRead, /^ERROR:/);
      assert.match(turn.evidence.files.forbiddenWrite, /^ERROR:/);
      assert.equal(turn.evidence.files.allowedWrite, "WROTE");
      assert.match(turn.log, /# relay boundary probes:/, "production ACP launch verified the exact outer profile");
    }
    assert.equal(proxied.evidence.allowed.ok, true, JSON.stringify(proxied.evidence.allowed));
    assert.match(proxied.evidence.allowed.data, /OWNED_ALLOWED_OK/);
    assert.deepEqual(proxied.evidence.services.map((entry: any) => entry.port).sort((a: number, b: number) => a - b),
      neverSinks.map(item => item.port).sort((a, b) => a - b));
    assert.ok(proxied.evidence.services.every((entry: any) => entry.direct?.ok === false && entry.direct?.code === "EPERM"), JSON.stringify(proxied.evidence.services));
    assert.deepEqual(direct.evidence.publicControl, { ok: true }, "the granted profile really opened the network (needs this Mac online)");
    assert.deepEqual(direct.evidence.allowed, { ok: false, code: "EPERM" }, "a pre-start listener is refused in the granted profile");
    assert.equal(allowed.accepts.length, allowedBeforeDirect, "the granted turn made no connection to the pre-start allowed sink");
    assert.equal(direct.evidence.lateLoopback.port, lateAllowed.port);
    assert.equal(direct.evidence.lateLoopback.ok, false, JSON.stringify(direct.evidence.lateLoopback));
    assert.equal(direct.evidence.lateLoopback.code, "EPERM", JSON.stringify(direct.evidence.lateLoopback));
    assert.deepEqual(lateAllowed.accepts, [], "a listener opened after the profile is live is refused too: all of loopback is closed");
    for (const { port } of neverSinks) {
      const evidence = direct.evidence.services.find((entry: any) => entry.port === port);
      assert.ok(evidence && evidence.direct.ok === false && evidence.direct.code === "EPERM", JSON.stringify(direct.evidence.services));
    }
    assert.match(proxied.log, new RegExp(`# relay network: off, except relay's proxy to ${ALLOWED_HOST.replace(/\./g, "\\.")}`));
    assert.match(direct.log, /# relay network: on \(granted\)/);
    assert.equal(fs.readFileSync(files.forbiddenFile, "utf8"), "FORBIDDEN_UNCHANGED_29\n");
    assert.equal(fs.readFileSync(files.allowedWrite, "utf8"), "ACP_ALLOWED_WRITE\n");
    assert.ok(allowed.payloads.some(data => /ACP_PROXY_PING/.test(data)), "permitted owned port accepted the ACP allowlist-proxy positive control");
    assert.ok(allowed.payloads.some(data => /ACP_PARENT_PROXY_PING/.test(data)), "parent-driven production proxy reached the permitted owned sink");
    for (const decoy of neverSinks) assert.deepEqual(decoy.accepts, [], `ACP made no actual dial to owned user-never port ${decoy.port}`);
    const decisions = fs.readFileSync(path.join(home, "proxy.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(decisions.some(d => d.event === "allow" && d.target === `${ALLOWED_HOST}:443`), JSON.stringify(decisions));
    const publicDecisions = fs.readFileSync(path.join(home, "acp-public-proxy.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const port of SERVICE_PORTS) assert.ok(publicDecisions.some(d => d.event === "deny" && d.target === `127.0.0.1:${port}` && d.reason === "refused"), `ACP public proxy recorded the built-in service denial for ${port}: ${JSON.stringify(publicDecisions)}`);
    for (const { port } of neverSinks) assert.ok(publicDecisions.some(d => d.event === "deny" && d.target === `127.0.0.1:${port}` && d.reason === "refused"), `ACP public proxy recorded the user-never denial for ${port}: ${JSON.stringify(publicDecisions)}`);
    assert.ok(publicDecisions.some(d => d.event === "deny" && d.target === `127.0.0.1:${allowed.port}` && d.reason === "private-address"), "a loopback port outside the floor reads private-address, so \"refused\" above is the never floor");
    t.diagnostic("ACP boundary: scripted ACP-v1 fixture only; no vendor binary or provider credentials were used");
  } finally {
    t.mock.restoreAll();
    if (directHandle && !directDone) await directHandle.cancel().catch(() => {});
    await publicProxy?.close();
    await Promise.all([...neverSinks, ...(allowed ? [allowed] : []), ...(lateAllowed ? [lateAllowed] : [])].map(item => item.close()));
    restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Release check claude-floor, part keychainDecoy (host only, RELAY_TEST_KEYCHAIN_LIVE=1; not a Codex
// pin requirement): the keychain from a floored Claude turn with stage 2 off, in two turns. The
// installed CLI's Bash asks the security daemons for a decoy keychain's item. Floored: the decoy's
// directory is in the floor's never.paths, as ~/Library/Keychains is, so the item must be refused
// whatever the keychain IPC, since reading an item in a file-based keychain needs its file as well as
// the daemons. Control: the same floor without that entry, which must match what doctor documents
// (core/never-coverage.ts neverKeychainIpc): Claude Code's sandbox profile allows
// com.apple.SecurityServer and com.apple.securityd.xpc, so "open", and the item is retrieved. The
// control shows that a floored refusal comes from the file deny and not from a broken command: a
// causal control. A turn needs the network grant here only so the CLI reaches the owned model stub
// through relay's proxy, so both turns are network-on: doctor's "open" for Claude's network-off
// turns is the recorded binary-profile reading, which these turns do not measure.
// Teardown goes through withTeardown (keychain-decoy.ts), in this order: the decoy is cleaned up
// while HOME is still the scratch one (its mutating security commands use the inherited HOME), and
// only then is the environment restored and the scratch home removed; a failing step skips none of
// the later ones, and the test's own failure is kept beside it.
for (const floored of [true, false]) test(`keychain decoy live (claude, stage 2 off, network on, ${floored ? "floored" : "causal control without the file deny"}): ${floored ? "a floored Claude Bash command cannot retrieve a decoy keychain item in a never path, whatever the keychain IPC" : "without that never path, retrieving the decoy item from a Claude Bash command matches the documented keychain IPC"}`, { skip: keychainSkip, timeout: 300_000 }, async (t) => {
  const restore = saveProcessEnv();
  delete process.env.RELAY_EXPERIMENTAL_CODEX_STAGE2;
  const home = scratchHome();
  let decoy: DecoyKeychain | undefined;
  let model: ScriptedModel | undefined;
  await withTeardown(async () => {
    const runRoot = fs.realpathSync(fs.mkdtempSync(path.join(home, "run-")));
    decoy = decoyKeychain(path.join(home, "keychains"));
    useScratch(home, runRoot, true);
    fs.mkdirSync(process.env.RELAY_HOME!, { recursive: true });
    const outside = spawnSync(decoy.command[0], decoy.command.slice(1), { encoding: "utf8", timeout: 30000 });
    assert.ok(retrieved(decoy, outside.stdout), `positive control outside any sandbox: ${outside.stderr}`);
    const cwd = path.join(home, "work"); fs.mkdirSync(cwd);
    // The same floor either way (the built-ins, keychain files among them); only the decoy's entry differs.
    const floor = resolveNeverPolicy({ home, never: { paths: floored ? [{ path: decoy.dir }] : [] } });
    // The exit marker shows the command ran; a refusal without it is not evidence (keychain-decoy.ts attempt).
    const bash = wrapped(decoy);
    const steps: ModelStep[] = [{ name: "Bash", input: { command: bash, description: "Try the decoy keychain item" } }];
    model = await scriptedModel(steps);
    const stubFile = path.join(process.env.RELAY_HOME!, "dev", "claude-model-stub.json");
    fs.mkdirSync(path.dirname(stubFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stubFile, JSON.stringify({ host: MODEL_HOST, port: model.port }));
    const launcher = claudeStubLauncher(runRoot);
    const logPath = path.join(runRoot, "claude-agent.log");
    assert.ok(fs.existsSync(CLAUDE), `installed Claude missing at ${CLAUDE}`);
    const config = withDefaults({ allow_temp_home: true, escalation: false, child_settings: "isolated", child_hooks: false, child_mcp: "relay-only",
      targets: { claude: { bin: launcher, child_auth: "any" }, codex: { stage2: false } } });
    const spec: TurnSpec = { target: targetDef("claude"), config, cwd, access: "write", grant: { network: true },
      model: "haiku", prompt: "keychain decoy qualification", dir: runRoot, logPath, relay: null, markers: { runId: "keychain-decoy", nodeId: "claude-keychain", depth: 1 },
      neverPolicy: floor, environment: { HOME: home, USER: os.userInfo().username,
        PATH: [...new Set([path.dirname(CLAUDE), path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"), SHELL: "/bin/zsh", LANG: "C.UTF-8" },
      signal: t.signal, onApproval: async () => { throw new Error("the keychain decoy check has no approval route"); } };
    const result = await withTurnSecrets(() => complete(claudeBackend.start(spec)));
    const log = fs.readFileSync(logPath, "utf8");
    assert.equal(result.status, "ok", JSON.stringify({ result, log: log.slice(-8000) }));
    const settings = JSON.parse(fs.readFileSync(path.join(runRoot, "claude-settings.json"), "utf8"));
    const denyRead: string[] = settings.sandbox.filesystem.denyRead;
    if (floored) assert.ok(denyRead.includes(decoy.dir), "the decoy's directory is in the floor's denyRead, as the keychains are");
    else assert.ok(!denyRead.some(p => decoy!.dir === p || decoy!.dir.startsWith(`${p}/`)), `the control's denyRead does not cover the decoy's directory: ${JSON.stringify(denyRead)}`);
    const events = log.split("\n").filter(line => line.trim().startsWith("{")).map(line => JSON.parse(line));
    // The Bash tool_use the stub issued, and the tool_result Claude Code returned for that id: the
    // command's text (which names both markers) is never mistaken for its output.
    const blocks = (type: string) => events.flatMap(event => Array.isArray(event.message?.content) ? event.message.content : []).filter(block => block?.type === type);
    const use = blocks("tool_use").find(block => block.name === "Bash" && block.input?.command === bash);
    assert.ok(use?.id, "the installed CLI attempted the scripted Bash command");
    const results = blocks("tool_result").filter(block => block.tool_use_id === use.id);
    assert.equal(results.length, 1, `exactly one tool_result for ${use.id}`);
    const output = stringsIn(results[0].content).join("\n");
    // attempt() throws unless the output carries exactly one numeric exit marker, so a tool error
    // (the command never ran, or was cut off) is never read as a refusal.
    const observed = attempt(decoy, output);
    const documented = neverKeychainIpc("claude", config, {})!;
    const expected = floored ? "refused" : documented.networkOn === "open" ? "retrieved" : "refused";
    t.diagnostic(`keychain decoy (claude, stage 2 off, ${floored ? "floored" : "control"}): ${observed}; documented keychain IPC ${documented.networkOn}; expected ${expected}`);
    assert.equal(observed, expected,
      `${floored ? "floored" : "control"}, documented keychain IPC ${documented.networkOn}; observed ${observed}: ${JSON.stringify(output.replaceAll(decoy!.secret, "<secret>").slice(-600))}`);
  }, [
    ["model stub", () => model?.close()],
    ["decoy cleanup", () => decoy?.cleanup()],
    ["environment", () => restore()],
    ["scratch home", () => fs.rmSync(home, { recursive: true, force: true })],
  ]);
});
