import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { incapable, resolveTarget, targetDef } from "../dist/targets/index.js";
import { CLI, harness } from "./helpers.ts";

test("experimental targets: tool descriptions and every target parameter label the choice, even when disabled", async () => {
  for (const enabled of [false, true]) {
    const h = await harness([], { targets: { copilot: { enabled, experimental: true, default_model: "gpt-6.1-sol" } } });
    const client = new Client({ name: "claude-code", version: "0" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--host", "claude"], env: h.env, cwd: h.repo }));
      const tools = (await client.listTools()).tools;
      for (const name of ["delegate", "ask", "discuss", "review", "brief"]) {
        const tool = tools.find((t) => t.name === name)!;
        const param = tool.inputSchema.properties![name === "review" ? "reviewer" : "target"] as { description: string };
        assert.match(param.description, /copilot \(experimental\)/, `${name}, enabled=${enabled}`);
        if (enabled && name !== "brief") assert.match(tool.description!, /Copilot \(experimental\)/, name);
      }
      if (enabled) {
        assert.match(client.getInstructions()!, /Copilot \(experimental\)/);
        const scope = tools.find((t) => t.name === "approve")!.inputSchema.properties!.scope as { description: string };
        assert.match(scope.description, /Copilot \(experimental\)/);
      }
    } finally {
      await client.close();
      await h.close();
    }
  }
});

test("experimental targets: resolution and capability refusals label names and choice lists", () => {
  const cfg = { targets: { copilot: { enabled: true, default_model: "gpt-6.1-sol" } } };
  for (const requested of [undefined, "unknown", "claude"]) {
    const r = resolveTarget("claude", requested, { ...cfg, same_family: "refuse" });
    assert.ok("reason" in r);
    assert.match(r.reason, /(?:copilot|Copilot) \(experimental\)/);
  }
  for (const model of [undefined, "auto", "claude-opus-5.5"]) {
    const r = resolveTarget("claude", "copilot", {}, { model });
    assert.ok("reason" in r);
    assert.match(r.reason, /Copilot \(experimental\)/);
  }
  // Copilot keeps its turns off the network now (its proxy hosts are declared), so a copy that cannot
  // stands in for a capability refusal, whose label is what this checks.
  const copilot = targetDef("copilot");
  const noNetworkOff = { ...copilot, capabilities: { ...copilot.capabilities, networkOff: false } };
  assert.match(incapable(noNetworkOff, { mode: "read", network: false, writePaths: false, continues: false })!, /Copilot \(experimental\)/);
});

test("experimental targets: status keeps the target id and labels it, and tree labels the target", async () => {
  const h = await harness();
  try {
    const q = await h.call("ask", { target: "claude", message: "hello" });
    h.sql("UPDATE nodes SET target = 'copilot' WHERE id = ?", q.thread_id);
    const status = await h.call("status", { id: q.thread_id });
    assert.equal(status.target, "copilot");
    assert.equal(status.target_label, "Copilot (experimental)");
    assert.match((await h.call("status")).tree, /thread:copilot \(experimental\)/);
    // Direct discussion/review status use their own views rather than nodeView.
    const d = await h.call("discuss", { target: "claude", topic: "hello", message: "hello\nCONTINUE" });
    const r = await h.call("review", { reviewer: "claude", target: "README.md" });
    for (const id of [d.discussion_id, r.review_id]) {
      h.sql("UPDATE nodes SET target = 'copilot', params_json = json_set(params_json, '$.other', 'copilot') WHERE id = ?", id);
      assert.equal((await h.call("status", { id })).target_label, "Copilot (experimental)");
    }
  } finally {
    await h.close();
  }
});

test("experimental targets: build.mjs labels the target in generated action skills", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-experimental-adapters-"));
  try {
    execFileSync(process.execPath, [path.resolve(import.meta.dirname, "../adapters/build.mjs"), out]);
    for (const [host, prefix] of [["claude", ""], ["codex", "relay-"]]) {
      for (const name of ["delegate", "ask", "discuss", "review"]) {
        const text = fs.readFileSync(path.join(out, host, "relay/skills", prefix + name, "SKILL.md"), "utf8");
        assert.match(text, /Copilot \(experimental\)/, `${host}/${name}`);
        assert.match(text, /targets\.copilot\.experimental/);
      }
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("experimental targets: CLI usage labels the target", () => {
  assert.match(execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }), /copilot \(experimental\)/);
});
