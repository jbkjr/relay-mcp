import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { withDefaults } from "../dist/core/config.js";
import "./helpers.ts";

test("steering: shared exception, all host and policy variants, bounded texts", async () => {
  const s = await import("../dist/core/steering.js");
  for (const own of [null, "claude", "codex"] as const) for (const same_family of ["allow", "refuse"] as const) for (const desktop of [false, true]) for (const multiple of [false, true]) {
    const cfg = withDefaults({ same_family, targets: { copilot: { enabled: multiple } } });
    const instructions = s.instructions(own, cfg, desktop);
    const param = s.targetText(own, cfg, desktop);
    assert.ok(instructions.length <= 1000, `${instructions.length}: ${instructions}`);
    assert.ok(param.length <= 2000);
    if (own && same_family === "allow") {
      assert.ok(instructions.includes(s.EXCEPTION));
      assert.ok(param.includes(s.EXCEPTION));
    }
    if (!own && same_family === "allow") assert.match(instructions, /cannot tell which family/);
    if (same_family === "refuse") assert.match(instructions, /same_family "refuse"/);
  }
  assert.match(s.preamble("codex", withDefaults({}), undefined, true), /use your own subagents/);
  assert.match(s.preamble("claude", withDefaults({}), undefined, false), /no subagents of your own/);
  assert.match(s.preamble("copilot", withDefaults({}), "auto", false), /cannot tell your own model's family/);
  assert.match(s.modelText(withDefaults({ targets: { copilot: { enabled: true } } })), /"auto", or no model/);
  assert.match(s.targetText(null, withDefaults({ targets: { copilot: { enabled: true } } })), /copilot \(experimental; the family/);
  assert.match(s.reviewRelationText, /never as cross-family/);
});

test("steering schemas: every description is bounded and reviewer shares the target exception", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { relayServer } = await import("../dist/mcp/server.js");
  const { newInstance } = await import("../dist/core/caller.js");
  const { EXCEPTION } = await import("../dist/core/steering.js");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-steering-schema-"));
  const previous = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  try {
    process.env.RELAY_HOME = tmp;
    process.env.RELAY_CONFIG = path.join(tmp, "config.json");
    for (const own of [null, "claude", "codex"] as const) for (const same_family of ["allow", "refuse"]) for (const desktop of [false, true]) {
      fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ same_family, targets: { copilot: { enabled: true } } }));
      const server = relayServer(newInstance({ kind: "root" }, tmp, own), { desktop });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: own === "claude" ? "claude-code" : own === "codex" ? "codex-mcp-client" : "unknown", version: "0" });
      try {
        await Promise.all([server.connect(a), client.connect(b)]);
        // The shared desktop entry also teaches D9's session token (design-family-steering.md 6.5).
        const instructions = client.getInstructions() ?? "";
        assert.ok(instructions.length <= (desktop ? 1500 : 1000), `${own}/${same_family}/${desktop}: instructions ${instructions.length}`);
        const tools = (await client.listTools()).tools;
        for (const t of tools) {
          assert.ok((t.description ?? "").length <= 2000, `${own}/${same_family}/${desktop}/${t.name}: ${t.description?.length}`);
          assert.doesNotMatch((t.description ?? "").replace(/\b(?:CONTINUE|AGREE|CRUX|JSON|MCP)\b/g, ""), /\b[A-Z]{2,}\b/);
        }
        if (own && same_family === "allow") {
          for (const [tool, param] of [["delegate", "target"], ["review", "reviewer"]]) assert.ok((tools.find((t) => t.name === tool)!.inputSchema.properties![param] as any).description.includes(EXCEPTION));
        }
      } finally { await client.close(); await server.close(); }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("steering: generated skills and host snippet share the exception and report labels", async () => {
  const { EXCEPTION } = await import("../dist/core/steering.js");
  const root = path.resolve(import.meta.dirname, "../adapters");
  for (const file of ["claude/relay/skills/delegate/SKILL.md", "codex/relay/skills/relay-delegate/SKILL.md", "codex/AGENTS.snippet.md"]) assert.ok(fs.readFileSync(path.join(root, file), "utf8").includes(EXCEPTION), file);
  for (const host of ["claude", "codex"]) for (const kind of ["delegate", "discuss", "review"]) {
    const file = path.join(root, host, "relay/skills", host === "codex" ? `relay-${kind}` : kind, "SKILL.md");
    assert.match(fs.readFileSync(file, "utf8"), /families.summary/);
  }
  assert.match(fs.readFileSync(path.join(root, "claude/relay/agents/operator.md"), "utf8"), /Do not name your own family's target unless you were told to/);
});

test("steering snapshots: instructions, parameters, model text, preambles, notes and refusals", async () => {
  const s = await import("../dist/core/steering.js");
  const f = await import("../dist/core/families.js");
  const { resolveTarget } = await import("../dist/targets/index.js");
  const variants: Record<string, unknown> = {};
  for (const own of [null, "claude", "codex"] as const) for (const same_family of ["allow", "refuse"] as const) for (const desktop of [false, true]) {
    const cfg = withDefaults({ same_family });
    variants[`${own}-${same_family}-${desktop}`] = { instructions: s.instructions(own, cfg, desktop), target: s.targetText(own, cfg, desktop) };
  }
  for (const same_family of ["allow", "refuse"] as const) for (const enabled of [false, true]) {
    const cfg = withDefaults({ same_family, targets: { copilot: { enabled } } });
    variants[`model-${same_family}-${enabled}`] = s.modelText(cfg);
    for (const target of ["claude", "codex", "copilot"] as const) for (const native of [false, true]) variants[`preamble-${same_family}-${enabled}-${target}-${native}`] = s.preamble(target, cfg, target === "copilot" ? "auto" : undefined, native);
  }
  for (const caller of ["anthropic", "openai", "unknown"] as const) for (const launched of ["anthropic", "openai", "unknown"] as const) {
    const relation = f.relationOf(caller, launched);
    variants[`side-${caller}-${launched}`] = s.describeSide(caller, launched);
    variants[`review-${caller}-${launched}`] = s.ownReviewFamilyNote({ caller, launched, relation, summary: "" });
    for (const kind of ["job", "consult", "discussion", "review"]) variants[`summary-${kind}-${caller}-${launched}`] = f.summaryText(kind, "caller", "launched", relation, caller);
  }
  for (const same_family of ["allow", "refuse"] as const) for (const caller of [null, "claude", "codex"]) for (const target of [undefined, "claude", "codex", "copilot"]) variants[`resolution-${same_family}-${caller}-${target}`] = resolveTarget(caller, target, { same_family });
  variants.unknownDefault = s.instructions(null, withDefaults({ default_target: { unknown: "codex" } }));
  variants.leaveOutNone = s.targetText("claude", withDefaults({ targets: { codex: { enabled: false } } }));
  variants.leaveOutSeveral = s.targetText("claude", withDefaults({ targets: { copilot: { enabled: true, default_model: "gemini-3.8-flash" } } }));
  variants.unknownOff = s.unknownOff("copilot");
  variants.none = s.noneRefusal;
  const file = path.join(import.meta.dirname, "fixtures/steering.json");
  if (process.env.RELAY_UPDATE_SNAPSHOTS === "1") fs.writeFileSync(file, JSON.stringify(variants, null, 2) + "\n");
  assert.deepEqual(variants, JSON.parse(fs.readFileSync(file, "utf8")));
});
