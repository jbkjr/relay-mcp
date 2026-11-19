// Pure fixture tests only: no listeners, Codex processes, sandbox-exec or model traffic.
import assert from "node:assert/strict";
import { test } from "node:test";
// For its side effect: the test process gets a scratch HOME (test/guard.test.ts requires every file to load it).
import "./helpers.ts";
import { brokerAgentId, brokerEnvProblems, brokerObservation, brokerOK, brokerRpc, brokerSessionProblems, ITEMS, nextReply, offeredTools, ownTurnCompleted, qualificationStart } from "../scripts/codex-qualify/codex-stage2.mjs";
import { EXPECTED_PARTS, judgeVerdict } from "../scripts/codex-qualify/codex-pin-store.mjs";

test("broker qualifier: discovery output advances the script exactly once", () => {
  const conversations = [{ calls: [{ type: "tool_search_call" }, { type: "function_call", name: "status" }] }];
  assert.equal(nextReply(conversations, { input: [] }).step, 0);
  const searched = { type: "tool_search_output", call_id: "c0-0", tools: [] };
  assert.equal(nextReply(conversations, { input: [searched] }).item.name, "status");
  assert.equal(nextReply(conversations, { input: [searched, { type: "function_call_output", call_id: "c0-1", output: "ok" }] }).item.type, "message");
});

test("broker qualifier: runner pins all 33 items and every broker/escalation part", () => {
  assert.deepEqual(Object.keys(ITEMS), Object.keys(EXPECTED_PARTS));
  assert.equal(Object.keys(ITEMS).length, 33, "item 33: the keychain under the never floor");
  const passed = () => ({ ok: true, state: "passed", relayPath: "present", version: "0.164.0", items: Object.fromEntries(Object.entries(EXPECTED_PARTS).map(([id, names]) => [id, { state: "passed", parts: Object.fromEntries(names.map((name: string) => [name, { state: "passed" }])) }])) });
  assert.equal(judgeVerdict(passed(), "0.164.0").ok, true);
  for (const id of Object.keys(EXPECTED_PARTS).map(Number).filter(id => id >= 14)) {
    const v = passed(); delete v.items[id];
    assert.equal(judgeVerdict(v, "0.164.0").ok, false, `missing item ${id}`);
    for (const name of EXPECTED_PARTS[id]) {
      const absent = passed(); delete absent.items[id].parts[name];
      assert.equal(judgeVerdict(absent, "0.164.0").ok, false, `missing ${id}.${name}`);
      for (const state of ["failed", "not run", "pending integration", "unknown"]) {
        const incomplete = passed(); incomplete.items[id].parts[name].state = state;
        assert.equal(judgeVerdict(incomplete, "0.164.0").ok, false, `${id}.${name} ${state}`);
      }
    }
  }
});

test("broker qualifier: C6 rejects missing runs, token names and known-value hits", () => {
  const outputs = Array(3).fill("PATH=/usr/bin\nBROKER_ENV_END\n");
  assert.deepEqual(brokerEnvProblems(outputs), []);
  assert.match(brokerEnvProblems([outputs[0], null, outputs[2]]).join(), /command 2 printed no environment marker/);
  assert.match(brokerEnvProblems([outputs[0], "RELAY_BROKER_TOKEN=leak\nBROKER_ENV_END", outputs[2]]).join(), /command 2 exposed/);
  assert.match(brokerEnvProblems(outputs, true).join(), /token value/);
  assert.match(brokerEnvProblems(outputs.slice(0, 2)).join(), /exactly three/);
});

test("broker qualifier: transport observations discard credentials and malformed RPC cannot pass", () => {
  const seen = brokerObservation("POST /mcp HTTP/1.1\r\nAuthorization: Bearer secret\r\nMcp-Session-Id: sid\r\n");
  assert.equal(seen.method, "POST"); assert.equal(seen.sid, "sid");
  assert.ok(!JSON.stringify(seen).includes("secret"));
  assert.equal(brokerObservation("HTTP/1.1 200 OK\r\nMcp-Session-Id: new\r\n").issued, "new");
  assert.deepEqual(brokerRpc('event: message\ndata: {"jsonrpc":"2.0","error":{"code":-32001}}\n\n')?.error, { code: -32001 });
  assert.equal(brokerRpc("refused or truncated"), null);
});

test("broker qualifier: session-count drift, retries and a lost child all fail", () => {
  const actors = (resumed = false) => ["parent", ...Array.from({ length: resumed ? 1 : 6 }, (_, i) => `child ${resumed ? 6 : i}`)].map((actor) => ({ actor, ok: true, output: '{"fixture":"BROKER_OK"}' }));
  const first = { opened: 8, peak: 2, calls: 7, resumed: false, actors: actors() };
  const resumed = { opened: 3, peak: 2, calls: 2, resumed: true, actors: actors(true) };
  assert.deepEqual(brokerSessionProblems(first, "v1"), []);
  assert.deepEqual(brokerSessionProblems({ ...first, peak: 7 }, "v2"), []);
  assert.deepEqual(brokerSessionProblems(resumed, "v2"), []);
  // Readback overlap is inside the design's reserved eighth slot; it is not a replay.
  assert.deepEqual(brokerSessionProblems({ ...first, peak: 8 }, "v2"), []);
  assert.deepEqual(brokerSessionProblems({ ...first, peak: 3 }, "v1"), []);
  assert.deepEqual(brokerSessionProblems({ ...resumed, peak: 3 }, "v2"), []);
  assert.equal(brokerSessionProblems({ ...first, opened: 9, peak: 9, calls: 8 }, "v2").length, 3);
  assert.match(brokerSessionProblems({ ...first, actors: actors().slice(0, 6) }, "v2").join(), /missing per-parent\/child/);
  const failed = actors(); failed[1].ok = false;
  assert.match(brokerSessionProblems({ ...first, actors: failed }, "v2").join(), /child 0 did not receive/);
  const duplicates = actors(); duplicates[1].actor = "parent";
  assert.match(brokerSessionProblems({ ...first, actors: duplicates }, "v2").join(), /identities/);
});

test("broker qualifier: v1 waits use the current spawn output before the next request is recorded", () => {
  const agent = "01a18907-ca91-74f0-ae22-e0027f338d87";
  const conversations = [{ calls: [null, null, { type: "function_call", name: "spawn_agent" }, (body) => ({ type: "function_call", name: "wait_agent", arguments: JSON.stringify({ targets: [brokerAgentId(body, 0, 2)] }) })] }];
  const input = [
    { type: "tool_search_output", call_id: "c0-0", tools: [] },
    { type: "function_call_output", call_id: "c0-1", output: "status" },
    { type: "function_call_output", call_id: "c0-2", output: JSON.stringify({ agent_id: agent, nickname: "Arendt" }) },
  ];
  assert.deepEqual(JSON.parse(nextReply(conversations, { input }).item.arguments).targets, [agent]);
  assert.throws(() => brokerAgentId({ input: input.slice(0, 2) }, 0, 2), /no valid agent_id/);
  assert.throws(() => brokerAgentId({ input: [{ ...input[2], output: '{"agent_id":null}' }] }, 0, 2), /no valid agent_id/);
});

test("broker qualifier: a child's completion never ends its parent's case", () => {
  assert.equal(ownTurnCompleted({ method: "turn/completed", params: { threadId: "child" } }, "parent"), false);
  assert.equal(ownTurnCompleted({ method: "turn/completed" }, "parent"), false);
  assert.equal(ownTurnCompleted({ method: "turn/completed", params: { threadId: "parent" } }, "parent"), true);
});

test("broker qualifier: expected admission failure is distinct from an unrelated launch failure", async () => {
  const reason = "relay cannot run this Codex job with raw network: the person's Codex config defines relay_tools; remove or rename it";
  const expected = (e) => /the person's Codex config defines relay_tools;/.test(e.message);
  const refused = await qualificationStart(async () => { throw new Error(reason); }, expected);
  assert.equal(refused.startRefused, true);
  assert.equal(refused.result.status, "failed");
  assert.equal(refused.result.error, reason);
  const handle = { pid: 123 };
  assert.deepEqual(await qualificationStart(async () => handle, expected), { startRefused: false, handle });
  await assert.rejects(qualificationStart(async () => { throw new Error("executor launch failed"); }, expected), /executor launch failed/);
  await assert.rejects(qualificationStart(async () => { throw new Error(reason); }), /config defines/);
});

test("broker qualifier: fixture status must be valid JSON and successful; an echoed marker in a parse error fails", () => {
  const fixture = { fixture: "BROKER_OK" };
  assert.equal(brokerOK(JSON.stringify(fixture)), true);
  assert.equal(brokerOK({ result: { content: [{ type: "text", text: JSON.stringify(fixture) }] } }), true);
  assert.equal(brokerOK('Wall time: 0.1 seconds\nOutput:\n{"fixture":"BROKER_OK"}'), true);
  assert.equal(brokerOK('Unexpected token \'B\', "BROKER_OK" is not valid JSON'), false);
  assert.equal(brokerOK("BROKER_OK"), false);
  assert.equal(brokerOK({ isError: true, content: [{ type: "text", text: JSON.stringify(fixture) }] }), false);
  assert.equal(brokerOK(null), false);
});

test("broker qualifier: discovered MCP tools join the offered-tool allowlist check", () => {
  assert.deepEqual(offeredTools({ input: [{ type: "tool_search_output", tools: [{ type: "namespace", name: "mcp__relay_tools", tools: [{ name: "status" }] }] }] }), ["mcp__relay_tools", "status"]);
});
