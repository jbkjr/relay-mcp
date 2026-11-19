import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hostVar } from "./helpers.ts";
import { codexBackend } from "../dist/backends/codex.js";
import { withDefaults } from "../dist/core/config.js";
import { selectEnvironment } from "../dist/core/env-policy.js";
import { createRun, getNode, insertNode, type TurnRow } from "../dist/core/db.js";
import { finishTurn } from "../dist/core/outcome.js";
import { delegationPreamble } from "../dist/core/prompts.js";
import { targetDef } from "../dist/targets/index.js";
import type { TurnHandle, TurnSpec } from "../dist/backends/types.js";

const ROOT = "parent-thread";
// j_7b0378f2 agent.log: 62-63/93-94 (spawn), 100-101 (message to root),
// 468 (completed activity on item/started), 469-470 (child answer/turn completion).
const activity = (kind: string, id: string, agentPath: string, method = "item/started", threadId = ROOT) => ({
  method, params: { threadId, turnId: "turn_1", item: {
    type: "subAgentActivity", id: `call-${kind}-${id}`, model: null, reasoningEffort: null,
    kind, agentThreadId: id, agentPath,
  } },
});
const spawn = (id: string, name: string) => [
  activity("started", id, name), activity("started", id, name, "item/completed"),
];

/** Real backend and stub CLI, with every writable home under temp: no native sandbox needed. */
async function turn(backend: "app-server" | "exec", events: unknown[], brokenLog = false, options: {
  steps?: unknown[]; onApproval?: TurnSpec["onApproval"]; onUsage?: TurnSpec["onUsage"];
  inspect?: (records: Record<string, any>[]) => void;
} = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-subagents-")));
  const saved = { STUB_DIR: process.env.STUB_DIR, STUB_SCENARIO: process.env.STUB_SCENARIO };
  let handle: TurnHandle | undefined;
  let finished = false;
  try {
    process.env.STUB_DIR = dir;
    process.env.STUB_SCENARIO = path.join(dir, "scenario.json");
    fs.mkdirSync(path.join(dir, "sessions"));
    fs.writeFileSync(path.join(dir, "sessions", `codex-${ROOT}.json`), '{"turns":0}');
    fs.writeFileSync(process.env.STUB_SCENARIO, JSON.stringify({ rules: [{ steps: [
      ...events.map((emit) => ({ emit })), ...(options.steps ?? []), { reply: "parent final answer" },
    ] }] }));
    const logPath = path.join(dir, "agent.log");
    if (brokenLog) fs.mkdirSync(logPath);
    const config = withDefaults({ codex_backend: backend, child_auth: "any", child_env: { pass: ["STUB_DIR", "STUB_SCENARIO"] }, targets: {
      codex: { bin: path.resolve(import.meta.dirname, "stubs/stub-codex"), pinned: false, home: path.join(dir, "codex-home") },
    } });
    const spec: TurnSpec = {
      target: targetDef("codex"), prompt: "finish the parent task", cwd: dir, dir, logPath,
      sessionId: ROOT, access: "read", relay: null, config,
      escalate: Boolean(options.onApproval), onApproval: options.onApproval, onUsage: options.onUsage,
      environment: selectEnvironment("codex", config, Object.fromEntries(Object.entries(process.env).filter(([k]) => !hostVar(k)))).env,
      markers: { runId: "r", nodeId: "j", depth: 1 },
    };
    handle = await codexBackend.start(spec);
    const result = await handle.done;
    finished = true;
    options.inspect?.(fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.finalMessage, "parent final answer", "children cannot overwrite the parent's answer");
    // Exercise the same result/status recording as a worker, without launching a confined job.
    const run = createRun(dir, config, "subagents-root");
    const node = insertNode({ id: `j_${run}`, run_id: run, kind: "job", target: "codex", mode: "read", cwd: dir, task: "test", depth: 1 });
    const outcome = { ...result, warnings: result.warnings ?? [], finalPath: null };
    finishTurn(node, { id: 1, source: "delegate" } as TurnRow, outcome, config);
    assert.equal(getNode(node.id)!.status, result.denials?.length ? "blocked" : "done", "warnings preserve the outcome; denials still block it");
    return JSON.parse(getNode(node.id)!.result_json!);
  } finally {
    if (handle && !finished) await handle.cancel();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const children = [
  ...spawn("docs", "/root/docs"), ...spawn("env", "/root/env_policy"),
  // The child's message back to /root is an interaction, not another spawn or completion.
  activity("interacted", ROOT, "/root", "item/started", "docs"),
  activity("interacted", ROOT, "/root", "item/completed", "docs"),
  activity("completed", "docs", "/root/docs"),
  { method: "item/completed", params: { threadId: "docs", item: { type: "agentMessage", text: "child final answer" } } },
  { method: "turn/completed", params: { threadId: "docs", turn: { id: "child-turn", rootTurnId: "turn_1", status: "completed" } } },
  activity("interacted", "docs", "/root/docs"),
];

test("native subagents: app-server warns for the unfinished child, preserving done and the parent answer", async () => {
  const result = await turn("app-server", children);
  assert.deepEqual(result.warnings, ["Native subagents still running when the turn ended: /root/env_policy. Relay stopped them when the turn ended; any changes they made are in the checkpoint but unfinished."]);
});

test("native subagents: child file approvals reach the root, and decision notes return to the requesting child", async () => {
  const asks: unknown[] = [];
  const result = await turn("app-server", children, false, {
    steps: [{ request: { edit: "/child/change.txt", threadId: "docs" } }],
    onApproval: async (ask) => { asks.push(ask); return { allow: true, deciderNote: "allow this child change" }; },
    inspect: (records) => {
      assert.equal(records.find((r) => r.event === "approval-answer")?.decision, "accept");
      const note = records.find((r) => r.event === "steer");
      assert.equal(note?.threadId, "docs");
      assert.equal(note?.expectedTurnId, "child-turn");
      assert.match(note?.input[0].text, /allow this child change/);
    },
  });
  assert.equal(asks.length, 1, "a child's approval is not silently declined");
  assert.deepEqual((asks[0] as any).paths, ["/child/change.txt"]);
  assert.equal((asks[0] as any).kind, "file");
  assert.equal(result.blocked, undefined);
});

test("native approvals: transport fixture adds no authority and explicit broad commands are declined before asking", async () => {
  const asks: string[] = [];
  const result = await turn("app-server", [], false, {
    steps: [{ request: "input to the existing terminal" }, { request: { cmd: "broad command", kind: "command" } }],
    onApproval: async (ask) => { asks.push(ask.summary); return { allow: true }; },
    inspect: (records) => {
      assert.deepEqual(records.filter((r) => r.event === "approval-answer").map((r) => r.decision), ["accept", "decline"]);
    },
  });
  assert.deepEqual(asks, ["input to the existing terminal"]);
  assert.ok(result.blocked?.some((d: string) => /pin-store write protection/.test(d)), JSON.stringify(result));
});

test("native subagents: child declined files and commands appear in denials without using another thread's paths", async () => {
  const usage: unknown[] = [];
  const item = (threadId: string, method: string, value: unknown) => ({ method, params: { threadId, item: value } });
  const result = await turn("app-server", [
    ...children,
    item(ROOT, "item/started", { type: "fileChange", id: "same-id", changes: [{ path: "/parent/change.txt" }] }),
    item("docs", "item/started", { type: "fileChange", id: "same-id", changes: [{ path: "/child/change.txt" }] }),
    item("env", "item/started", { type: "fileChange", id: "same-id", changes: [{ path: "/other-child/change.txt" }] }),
    item("docs", "item/completed", { type: "fileChange", id: "same-id", status: "declined" }),
    item("docs", "item/completed", { type: "commandExecution", status: "declined", command: "child forbidden command" }),
    // Child lifecycle, usage and refusals must leave the parent's running turn alone.
    { method: "turn/started", params: { threadId: "docs", turn: { id: "child-turn" } } },
    { method: "thread/tokenUsage/updated", params: { threadId: "docs", tokenUsage: { total: { inputTokens: 99999 } } } },
    { method: "error", params: { threadId: "docs", error: { codexErrorInfo: "cyberPolicy", message: "child safety stop" } } },
    { method: "turn/completed", params: { threadId: "docs", turn: { status: "failed", error: { message: "child failed" } } } },
  ], false, { onUsage: (u) => usage.push(u) });
  assert.equal(result.blocked.length, 2);
  assert.match(result.blocked[0], /\/child\/change\.txt/);
  assert.doesNotMatch(result.blocked[0], /\/parent\/|other-child/);
  assert.match(result.blocked[1], /child forbidden command/);
  assert.equal(usage.length, 1, "only the parent's usage is reported");
});

test("native subagents: app-server has no warning when all children completed", async () => {
  const result = await turn("app-server", [...children, activity("completed", "env", "/root/env_policy", "item/completed")]);
  assert.equal(result.warnings, undefined);
});

test("native subagents: root excluded, duplicate notifications deduplicated, and log warnings retained", async () => {
  const result = await turn("app-server", [...children, ...spawn(ROOT, "/root"), ...spawn("env", "/root/env_policy")], true);
  assert.equal(result.warnings.filter((w: string) => /Native subagents/.test(w)).length, 1);
  assert.match(result.warnings.join("\n"), /relay could not write the agent's log/);
  assert.match(result.warnings[0], /: \/root\/env_policy\./);
});

const collab = (tool: string, receivers: string[], agents_states: Record<string, unknown>, status = "completed", type = "item.completed") => ({
  type, item: { id: `call-${tool}`, type: "collab_tool_call", tool, receiver_thread_ids: receivers, agents_states, status },
});
for (const completed of [false, true]) test(`native subagents: exec collaboration reports ${completed ? "all complete" : "an unfinished child by thread id"}`, async () => {
  const result = await turn("exec", [
    collab("spawn_agent", ["docs"], { docs: { status: "running" } }),
    collab("spawn_agent", ["env"], { env: { status: "pending_init" } }),
    collab("wait", ["docs", "env"], { docs: { status: "completed" }, env: { status: completed ? "completed" : "running" } }, "completed", "item.updated"),
  ]);
  if (completed) assert.equal(result.warnings, undefined);
  else assert.match(result.warnings.join("\n"), /still running when the turn ended: env\. Relay stopped them/);
});

test("native subagents: exec shutdown events cannot erase the warning from turn end", async () => {
  const result = await turn("exec", [
    collab("spawn_agent", ["env"], { env: { status: "running" } }),
    { type: "turn.completed", usage: {} },
    collab("close_agent", ["env"], { env: { status: "shutdown" } }),
  ]);
  assert.match(result.warnings.join("\n"), /still running when the turn ended: env\./);
});

test("native subagents: every delegated target gets the wait instruction, even without relay delegation", () => {
  const cfg = withDefaults({});
  for (const target of ["codex", "claude", "copilot", "gemini", "grok"] as const) for (const mode of ["read", "write"] as const) {
    const node = { target, mode, depth: 1, allow_delegation: 0, branch: "test", params_json: null };
    assert.match(delegationPreamble(node as never, cfg, "root", "parent", undefined), /If you use your own subagents, wait for every one to finish before your final answer, because relay stops any still running when your turn ends\./);
  }
});
