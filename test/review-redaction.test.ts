import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openAgentLog } from "../dist/backends/types.js";
import { diagnosticTail, redactOwnReview } from "../dist/core/redact.js";
import "./helpers.ts";

test("review redaction: ACP updates and permission requests identify submissions by rawInput shape", () => {
  const args = { review_id: "r_probe", own_review: "ACP-SECRET", keep: "unrelated" };
  const marker = `[own_review: ${args.own_review.length} chars, withheld]`;
  for (const sessionUpdate of ["tool_call", "tool_call_update"]) {
    for (const title of [undefined, "review", "relay-review", "relay/review", "Review (relay)"]) {
      const update = { sessionUpdate, toolCallId: "call-1", ...(title ? { title } : {}), rawInput: args };
      const event = { method: "session/update", params: { sessionId: "session-1", update } };
      assert.deepEqual(JSON.parse(redactOwnReview(JSON.stringify(event), true)), {
        ...event, params: { ...event.params, update: { ...update, rawInput: { ...args, own_review: marker } } },
      });
    }
  }
  for (const rawInput of [args, JSON.stringify(args)]) {
    const event = { jsonrpc: "2.0", id: 42, method: "session/request_permission", params: { sessionId: "session-1", toolCall: { toolCallId: "call-1", rawInput }, options: [{ optionId: "deny" }] } };
    const clean = { ...args, own_review: marker };
    assert.deepEqual(JSON.parse(redactOwnReview(JSON.stringify(event), true)), {
      ...event, params: { ...event.params, toolCall: { ...event.params.toolCall, rawInput: typeof rawInput === "string" ? JSON.stringify(clean) : clean } },
    });
  }
  for (const event of [
    { sessionUpdate: "tool_call_update", rawInput: { own_review: "ordinary data" } },
    { method: "unrelated", params: { toolCall: { rawInput: args } } },
    { rawInput: args },
  ]) {
    const line = JSON.stringify(event);
    assert.equal(redactOwnReview(line, true), line);
  }
});

test("review redaction: Claude result permission denials hide only the relay review argument", () => {
  const denied = { tool_name: "mcp__relay__review", tool_use_id: "call-1", tool_input: { review_id: "r_probe", own_review: "DENIED-SECRET", keep: "unrelated" } };
  const other = { tool_name: "mcp__other__review", tool_input: { own_review: "other tool's data" } };
  const event = { type: "result", result: "reply stays intact", permission_denials: [denied, other] };
  assert.deepEqual(JSON.parse(redactOwnReview(JSON.stringify(event), true)), {
    ...event, permission_denials: [{ ...denied, tool_input: { ...denied.tool_input, own_review: `[own_review: ${denied.tool_input.own_review.length} chars, withheld]` } }, other],
  });
});

test("review redaction: a stray diagnostic quote does not hide the following call envelope", () => {
  const call = { type: "tool_use", name: "mcp__relay__review", input: { review_id: "r_probe", own_review: "STRAY-QUOTE-SECRET", keep: "unrelated" } };
  const prefix = 'note "x ';
  assert.equal(redactOwnReview(prefix + JSON.stringify(call), true), prefix + JSON.stringify({ ...call, input: { ...call.input, own_review: `[own_review: ${call.input.own_review.length} chars, withheld]` } }));
});

test("review redaction: malformed diagnostic openers cannot stall the event loop", () => {
  // A separate process bounds this probe even with the old quadratic scan. The normal scan
  // takes milliseconds; the deadline is deliberately generous for a loaded test machine.
  const module = new URL("../dist/core/redact.js", import.meta.url).href;
  const script = `import { redactOwnReview } from ${JSON.stringify(module)};
for (const opener of ['{', '[']) {
  const line = opener.repeat(512 * 1024);
  if (redactOwnReview(line, true) !== line) process.exit(1);
}`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000, encoding: "utf8" });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});

test("review logs: one filter redacts vendor argument shapes, nested JSON and split writes before they reach disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-log-"));
  const file = path.join(dir, "agent.log"), secret = 'private review\nwith "quotes" and \\ paths';
  const args = { own_review: secret, review_id: "r_probe" };
  const events = [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__relay__review", input: args }] } },
    { method: "item/started", params: { item: { type: "mcpToolCall", server: "relay", tool: "review", arguments: JSON.stringify(args) } } },
    { method: "session/update", params: { update: { sessionUpdate: "tool_call", title: "relay.review", rawInput: args } } },
    { type: "tool_result", text: JSON.stringify({ type: "mcpToolCall", server: "relay", tool: "review", arguments: JSON.stringify(JSON.stringify(args)) }) },
  ];
  const { log } = openAgentLog(file);
  try {
    for (const e of events) {
      const line = JSON.stringify(e) + "\n";
      const at = line.indexOf("private") + 4;
      log.write(line.slice(0, at));
      log.write(line.slice(at));
    }
    log.write(JSON.stringify(events[0])); // The last, unterminated line is filtered too.
    await new Promise<void>((resolve) => log.end(resolve));
    const saved = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(saved, /private review/);
    assert.ok(saved.includes(`[own_review: ${secret.length} chars, withheld]`));
    assert.ok(saved.includes("r_probe"));
    assert.ok(saved.includes("session/update"));
  } finally {
    if (!log.writableEnded) await new Promise<void>((resolve) => log.end(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review redaction: ordinary prose, code examples and other tools are preserved exactly", () => {
  for (const text of [
    'Review cites `{"own_review": a.own_review}` and still has findings.',
    '{ "partial_json": 42 }',
    JSON.stringify({ own_review: "this is an ordinary data object" }),
    JSON.stringify({ verdict: "fail", items: [{ example: { type: "mcpToolCall", server: "relay", tool: "review", arguments: { own_review: "example" } } }] }),
    JSON.stringify({ type: "tool_use", name: "mcp__other__review", input: { own_review: "other server's arguments" } }),
    JSON.stringify({ type: "mcpToolCall", server: "relay", tool: "ask", arguments: { own_review: "another tool's data" } }),
    'Prose quoting a tool example: ' + JSON.stringify({ type: "mcpToolCall", server: "relay", tool: "review", arguments: { own_review: "example" } }),
  ]) assert.equal(redactOwnReview(text), text);
  const reviewJson = JSON.stringify({ verdict: "fail", items: [{ example: { type: "mcpToolCall", server: "relay", tool: "review", arguments: { own_review: "example in reviewer's finding" } } }] });
  const result = JSON.stringify({ type: "result", result: reviewJson });
  assert.equal(redactOwnReview(result, true), result, "a CLI result's ordinary JSON review is text, not a nested tool call");
  assert.equal(redactOwnReview("[stderr] " + result, true), "[stderr] " + result, "a diagnostic prefix must not turn the review's example into a submission");
});

test("review redaction: only the value inside the identified tool's arguments changes", () => {
  const call = { type: "mcpToolCall", server: "relay", tool: "review", own_review: "ordinary envelope metadata", arguments: { review_id: "r_probe", own_review: { text: "submitted text" }, partial_json: 42, nested: { own_review: "ordinary data" } } };
  const clean = JSON.parse(redactOwnReview(JSON.stringify(call)));
  assert.deepEqual(clean, { ...call, arguments: { ...call.arguments, own_review: `[own_review: ${JSON.stringify(call.arguments.own_review).length} chars, withheld]` } });
});

test("review redaction: a long stderr line is redacted before error-tail truncation, including split writes and no newline", () => {
  const secret = "PRIVATE-SUBMISSION".repeat(300);
  const line = `arguments=${JSON.stringify({ type: "mcpToolCall", server: "relay", tool: "review", arguments: { own_review: secret, keep: "unrelated" } })}`;
  for (const ending of ["", "\n"]) {
    const tail = diagnosticTail();
    tail.write(line.slice(0, 100)); tail.write(line.slice(100) + ending);
    assert.doesNotMatch(tail.text(), /PRIVATE-SUBMISSION/);
    assert.ok(tail.text().includes(`[own_review: ${secret.length} chars, withheld]`));
    assert.match(tail.text(), /unrelated/);
  }
});

test("review redaction: stderr debug quoting and JSON strings retain the envelope and redact only the review argument", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-log-"));
  const file = path.join(dir, "agent.log"), secret = "STDERR-PRIVATE-REVIEW";
  const call = { type: "mcpToolCall", server: "relay", tool: "review", arguments: JSON.stringify({ review_id: "r_probe", own_review: secret, keep: "unrelated" }) };
  const { log } = openAgentLog(file);
  try {
    log.write(`[stderr] arguments=${JSON.stringify(JSON.stringify(call))}\n`);
    log.write(JSON.stringify({ diagnostic: JSON.stringify(JSON.stringify(call)) }) + "\n");
    await new Promise<void>((resolve) => log.end(resolve));
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(secret));
    assert.match(text, /mcpToolCall/);
    assert.match(text, /unrelated/);
    assert.ok(text.includes(`[own_review: ${secret.length} chars, withheld]`));
  } finally {
    if (!log.writableEnded) await new Promise<void>((resolve) => log.end(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
