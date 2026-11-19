// Claude's network grant through relay's proxy (relay 1.0.5): the sandbox's report, the proxy environment,
// and the managed settings that refuse it. The turns themselves are in modes.test.ts ("shell network (claude)").
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers.ts";
import { claudeModelHosts, claudeProxyEnv, claudeProxyReport, devModelStub } from "../dist/backends/claude.js";
import net from "node:net";
import { managedNetworkProblem } from "../dist/core/claude-settings.js";

test("claude network: the sandbox's report confirms relay's ports only when both are named, and another port is caught at once", () => {
  const lines = (port: number) => [`[SandboxDebug] Using external HTTP proxy on port ${port}`, `[SandboxDebug] Using external SOCKS proxy on port ${port}`];
  const r = claudeProxyReport(4321);
  assert.equal(r.seen("[SandboxDebug] Parent proxy configured: http=http://***:***@127.0.0.1:4321/"), null);
  assert.equal(r.seen(lines(4321)[0]), null);
  assert.equal(r.confirmed(), false, "HTTP alone is not enough: Claude Code would start its own SOCKS proxy");
  assert.equal(r.seen(lines(4321)[1] + "\r"), null);
  assert.equal(r.confirmed(), true);
  const other = claudeProxyReport(4321);
  assert.equal(other.seen(lines(4322)[1]), "other", "another port is not relay's");
  assert.equal(other.seen(`  ${lines(4321)[0]} (extra)`), null, "only the exact report counts");
  assert.equal(other.confirmed(), false);
});

test("claude network: the Claude process gets the token proxy URL in every case, nothing exempt, and the sandbox's debug report", () => {
  const env = claudeProxyEnv({ port: 4321, token: "tok_123" });
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) assert.equal(env[k], "http://relay:tok_123@127.0.0.1:4321", k);
  assert.deepEqual([env.NO_PROXY, env.no_proxy, env.SRT_DEBUG], ["", "", "1"]);
  assert.equal(env.NODE_USE_ENV_PROXY, undefined, "Node children (relay's own MCP server, started with env -i anyway) are not pointed at it");
});

test("claude network: managed settings that would take the job around relay's proxy refuse the network; harmless ones do not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-managed-"));
  try {
    const file = (name: string, content: unknown) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
      return p;
    };
    const harmless = file("harmless.json", { sandbox: { network: { allowLocalBinding: false, allowAllUnixSockets: false, allowUnixSockets: [], allowedDomains: ["example.com"] } }, env: { FOO: "1" } });
    assert.equal(managedNetworkProblem([harmless, path.join(dir, "missing.json")]), null);
    for (const [name, content, key] of [
      ["port.json", { sandbox: { network: { httpProxyPort: 8080 } } }, "sandbox.network.httpProxyPort"],
      ["socks.json", { sandbox: { network: { socksProxyPort: 1080 } } }, "sandbox.network.socksProxyPort"],
      ["bind.json", { sandbox: { network: { allowLocalBinding: true } } }, "sandbox.network.allowLocalBinding"],
      ["unix.json", { sandbox: { network: { allowUnixSockets: ["/tmp/x.sock"] } } }, "sandbox.network.allowUnixSockets"],
      ["allunix.json", { sandbox: { network: { allowAllUnixSockets: true } } }, "sandbox.network.allowAllUnixSockets"],
      ["env.json", { env: { no_proxy: "localhost" } }, "env.no_proxy"],
      ["envp.json", { env: { HTTPS_PROXY: "http://corp:8080" } }, "env.HTTPS_PROXY"],
    ] as const) {
      const problem = managedNetworkProblem([harmless, file(name, content)]);
      assert.ok(problem?.includes(`set ${key}`) && /does not give Claude jobs the network/.test(problem), `${name}: ${problem}`);
    }
    assert.match(managedNetworkProblem([file("broken.json", "{ not json")]) ?? "", /could not read/, "what relay cannot read refuses");
    // A managed-settings.d directory contributes its JSON files.
    const d = path.join(dir, "managed-settings.d");
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "10-net.json"), JSON.stringify({ sandbox: { network: { httpProxyPort: 1 } } }));
    assert.match(managedNetworkProblem([d]) ?? "", /10-net\.json set sandbox\.network\.httpProxyPort/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("claude network: the model endpoint relay expects Claude's model traffic at, by provider; an unknown provider refuses", () => {
  const host = (env: Record<string, string>) => {
    const m = claudeModelHosts(env);
    return "problem" in m ? m.problem : m;
  };
  const anthropic = host({}) as { test(h: string): boolean };
  assert.equal(anthropic.test("api.anthropic.com"), true);
  for (const h of ["statsig.anthropic.com", "api.anthropic.com.evil.test", "claude.ai"]) assert.equal(anthropic.test(h), false, h);
  assert.equal((host({ CLAUDE_CODE_USE_BEDROCK: "0" }) as { test(h: string): boolean }).test("api.anthropic.com"), true, "a provider switched off is no provider");
  const bedrock = host({ CLAUDE_CODE_USE_BEDROCK: "1" }) as { test(h: string): boolean };
  assert.equal(bedrock.test("bedrock-runtime.us-east-1.amazonaws.com"), true);
  assert.equal(bedrock.test("api.anthropic.com"), false);
  const vertex = host({ CLAUDE_CODE_USE_VERTEX: "true" }) as { test(h: string): boolean };
  assert.equal(vertex.test("us-east5-aiplatform.googleapis.com"), true);
  assert.equal(vertex.test("aiplatform.googleapis.com"), true);
  assert.match(host({ CLAUDE_CODE_USE_FOUNDRY: "1" }) as string, /CLAUDE_CODE_USE_FOUNDRY, a model provider whose endpoint relay does not know/);
  assert.match(host({ CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1" }) as string, /does not give this job the network/);
});

test("claude network: the development model stub needs RELAY_DEV_MODEL_STUB in relay's own environment, and a bad or stale file then refuses loudly", async () => {
  const saved = { home: process.env.RELAY_HOME, flag: process.env.RELAY_DEV_MODEL_STUB };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-devstub-"));
  const file = path.join(home, "dev", "claude-model-stub.json");
  fs.mkdirSync(path.dirname(file));
  const server = net.createServer((c) => c.end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    process.env.RELAY_HOME = home;
    delete process.env.RELAY_DEV_MODEL_STUB;
    fs.writeFileSync(file, "{ not json");
    assert.equal(await devModelStub(), undefined, "without the flag the file is ignored, malformed or not: turns are unaffected");
    process.env.RELAY_DEV_MODEL_STUB = "1";
    await assert.rejects(devModelStub(), /could not be read as JSON/);
    fs.writeFileSync(file, JSON.stringify({ host: "api.anthropic.com" }));
    await assert.rejects(devModelStub(), /must hold/);
    fs.writeFileSync(file, JSON.stringify({ host: "api.anthropic.com", port }));
    assert.deepEqual(await devModelStub(), { host: "api.anthropic.com", port });
    await new Promise<void>((r) => server.close(() => r()));
    await assert.rejects(devModelStub(), /nothing listens on 127\.0\.0\.1:\d+.*earlier run/, "a stale file refuses");
    fs.rmSync(file);
    assert.equal(await devModelStub(), undefined, "with the flag and no file: no stub");
    process.env.RELAY_HOME = path.join(os.homedir(), ".local", "state", "relay");
    await assert.rejects(devModelStub(), /default state directory/, "never in relay's default home");
  } finally {
    for (const [k, v] of [["RELAY_HOME", saved.home], ["RELAY_DEV_MODEL_STUB", saved.flag]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
