// Grok Build (`grok agent stdio`) as a relay-enforced ACP target: its registry entry, its profile
// for the generic driver (src/backends/grok.ts), and conformance runs against the stub ACP agent
// (test/stubs/targets/acp.mjs, which answers as Grok when started as `grok … agent … stdio`), under
// relay's own sandbox on macOS. The stub writes its records to stderr, which relay keeps in the
// agent's log, since a confined harness cannot write where the other stubs keep theirs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import { SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
import { harness, scratchOnly, task, until, type Harness, type Rec, type Rule } from "./helpers.ts";

/** The ACP stub agent as a scratch copy, so that no boundary probe aims beside the checkout's files; named grok, as relay finds it. */
const STUB_GROK = (() => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-grok-stub-")));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const stubs = path.resolve(import.meta.dirname, "stubs");
  const href = (p: string) => JSON.stringify(pathToFileURL(path.join(stubs, p)).href);
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  const bin = path.join(dir, "grok");
  fs.writeFileSync(bin, `#!/usr/bin/env node\nimport { main } from ${href("stub-agent.mjs")};\nimport acp from ${href("targets/acp.mjs")};\nawait main(acp);\n`, { mode: 0o755 });
  return scratchOnly(bin, "harness");
})();

/** The real per-turn boundary probes, stood in through the tests' own preload in every relay process a harness starts (as in acp.test.ts). */
const REAL_PROBES_PRELOAD = `--import=${pathToFileURL(path.resolve(import.meta.dirname, "fixtures", "boundary-probes.mjs")).href}`;

const macOS = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
const onMac = macOS ? test : test.skip;
const MODEL = "grok-4.6";

/** Grok switched on, pointed at the stub, experimental use allowed; the network off unless a test says otherwise, so the turn goes through relay's proxy. */
const GROK = (extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  child_network: false, ...top, targets: { grok: { enabled: true, bin: STUB_GROK, experimental: true, ...extra } },
});

/**
 * A harness whose relay-enforced launches run the real boundary probes, with its scratch HOME and the
 * scratch stub, and a stored Grok login of the user's in that HOME's ~/.grok, as `grok login` leaves
 * it (unless `login` is false): relay runs Grok on that login only, its login store.
 */
async function grokHarness(rules: Rule[], config: Record<string, unknown>, env: Record<string, string> = {}, login = true): Promise<Harness> {
  const h = await harness(rules, config, { NODE_OPTIONS: REAL_PROBES_PRELOAD, ...env });
  if (login) userGrok(h);
  return h;
}

/** A root session in Claude Code for each harness: tests reach Grok from a Claude caller. */
const roots = new Map<Harness, Promise<Awaited<ReturnType<Harness["instance"]>>>>();
const root = (h: Harness) => ({
  call: async (tool: string, args: Record<string, unknown> = {}) => {
    if (!roots.has(h)) roots.set(h, h.instance({ args: ["--host", "claude"] }));
    return (await roots.get(h)!).call(tool, args);
  },
});

/** Everything the stub ACP agents of this harness recorded, from the agents' logs, in order. */
function grokRecords(h: Harness): Rec[] {
  const out: Rec[] = [];
  for (const { log_path } of h.sql("SELECT DISTINCT log_path FROM nodes WHERE target = 'grok' AND log_path IS NOT NULL")) {
    if (!fs.existsSync(log_path)) continue;
    for (const line of fs.readFileSync(log_path, "utf8").split("\n")) {
      const m = /^\[stderr\] STUB-RECORD (.*)$/.exec(line);
      if (m) out.push(JSON.parse(m[1]));
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
const grokStarts = (h: Harness) => grokRecords(h).filter((r) => r.event === "start");
const agentLog = (h: Harness, id: string) => fs.readFileSync(h.sql("SELECT log_path FROM nodes WHERE id = ?", id)[0].log_path, "utf8");

/**
 * The user's Grok login directory in the harness's scratch HOME (~/.grok): a stored login relay never
 * opens, its lock, and the user's own Grok settings beside them, which no turn may change. Made once.
 */
function userGrok(h: Harness): { dir: string; auth: string; lock: string; config: string } {
  const dir = path.join(h.env.HOME, ".grok");
  const [auth, lock, config] = ["auth.json", "auth.json.lock", "config.toml"].map((n) => path.join(dir, n));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(auth, '{"https://auth.x.ai::client":{"key":"secret-access-token","refresh_token":"secret-refresh-token"}}', { mode: 0o600 });
    fs.writeFileSync(lock, "", { mode: 0o644 });
    fs.writeFileSync(config, '[sandbox]\nprofile = "strict"\n', { mode: 0o600 });
  }
  return { dir, auth, lock, config };
}

test("grok: Grok Build is a target, off by default and experimental, confined by relay, whose family is judged per model from a reviewed list of xAI's", async () => {
  const { TARGETS, TARGET_IDS, CREDENTIALS, vendorFor, resolveTarget, incapable } = await import("../dist/targets/index.js");
  const grok = TARGETS.find((t) => t.id === "grok");
  assert.ok(grok, "relay knows a target called grok");
  assert.ok((TARGET_IDS as readonly string[]).includes("grok"));
  assert.equal(grok.product, "Grok Build");
  assert.equal(grok.defaultBin, "grok");
  assert.equal(grok.enabledByDefault, false);
  assert.equal(grok.qualified, false, "experimental until a signed-in qualification run");
  assert.deepEqual([...grok.tested], [1, 0, 62]);
  // The family: vendor null, so that the generic per-model path decides, with every listed model xAI's.
  assert.equal(grok.vendor, null);
  const models = grok.models!;
  assert.ok(Object.isFrozen(models), "the list cannot be changed at run time");
  assert.ok(Object.keys(models).length >= 1 && Object.values(models).every((v) => v === "xai"), JSON.stringify(models));
  for (const m of ["grok-4.6", "grok-4.5"]) assert.equal(vendorFor(grok, m), "xai", `${m} is in 1.0.62's own catalog`);
  for (const m of ["auto", "", "grok-build", "claude-sonnet-5.5", "gpt-6.1-sol"]) assert.equal(vendorFor(grok, m), null, `${m} is no model relay lets Grok run`);
  // Relay runs it on no other (its settings allow only these, and the driver refuses another before Grok starts); the ones seen offered come first.
  assert.equal(grok.listedModelsOnly, true);
  assert.deepEqual(Object.keys(models), ["grok-4.6", "grok-4.5", "grok-4.7"]);
  // Confinement and what can be asked of it.
  assert.deepEqual(grok.capabilities, { subagents: "never", confinement: "relay-enforced", readOnly: true, networkOff: true, writeRoots: true, approvals: "acp", escalation: false, resume: true, login: "scrubbed" });
  for (const needs of [{ mode: "read", network: false, writePaths: false, continues: true }, { mode: "write", network: false, writePaths: true, continues: true }] as const) assert.equal(incapable(grok, needs), null);
  // The network: its inference proxy and its sign-in issuer, nothing else.
  assert.deepEqual([...grok.apiHosts!], ["cli-chat-proxy.grok.com", "auth.x.ai"]);
  assert.ok(Object.isFrozen(grok.apiHosts), "the list cannot be changed at run time");
  for (const h of ["code.grok.com", "assets.grok.com", "api.mixpanel.com", "x.ai", "storage.googleapis.com", "registry.npmjs.org", "api.x.ai"]) assert.ok(!grok.apiHosts!.includes(h), h);
  // Credentials: xAI's keys and Grok's own credential variables are removed from every agent; where its login is, is not a credential.
  for (const k of ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_AUTH", "GROK_DEPLOYMENT_KEY", "GROK_ALPHA_TEST_KEY", "GROK_EXTRA_AUTH_KEY"]) {
    assert.ok(grok.credentialEnv.test(k), k);
    assert.ok(CREDENTIALS.test(k), `${k} is removed from every launched agent`);
  }
  for (const k of ["GROK_AUTH_PATH", "GROK_HOME", "XAI_API_KEYS"]) assert.ok(!grok.credentialEnv.test(k), k);
  assert.ok(!grok.clientNames.test("grok") && !grok.clientNames.test(""), "never taken for a root session's host");
  // Its login store (D10, "Exact-name renames"): ~/.grok, its token, its lock and Grok's own temp names.
  assert.deepEqual(JSON.parse(JSON.stringify(grok.tokenStore)), { name: "Grok's login directory", dir: ".grok", files: ["auth.json"], locks: ["auth.json.lock"], tempName: String.raw`^\.[0-9]+\.[0-9]+\.tmp$` });
  const temp = new RegExp(grok.tokenStore!.tempName);
  for (const n of [".4242.0.tmp", ".1.17.tmp"]) assert.ok(temp.test(n), `${n}: Grok's .{pid}.{counter}.tmp, decimal`);
  for (const n of ["auth.json", "auth.json.lock", "config.toml", ".4242.ff.tmp", ".4242.1.tmp/x", "a.4242.1.tmp", ".4242.1.tmp.bak"]) assert.ok(!temp.test(n), n);
  assert.match(grok.reviewPrefix, /^[A-Z]{1,2}$/);
  assert.equal(new Set(TARGETS.map((t) => t.reviewPrefix)).size, TARGETS.length, "a review prefix of its own");

  // The family rule is the generic one, unchanged. Under same_family "refuse", a Claude or Codex caller reaches Grok with a model relay knows.
  const cfg = { targets: { grok: { enabled: true } }, same_family: "refuse" as const };
  assert.match((resolveTarget("claude", "grok", cfg) as { reason: string }).reason, /name it with model \(for example grok-4\.\d/);
  assert.deepEqual(resolveTarget("claude", "grok", cfg, { model: MODEL }), { target: "grok", model: MODEL });
  assert.deepEqual(resolveTarget("codex", "grok", cfg, { model: "grok-4.5" }), { target: "grok", model: "grok-4.5" });
  assert.match((resolveTarget("claude", "grok", cfg, { model: "grok-build" }) as { reason: string }).reason, /does not know which family the model "grok-build" is/);
  assert.match((resolveTarget("claude", "grok", { same_family: "refuse" }, { model: MODEL }) as { reason: string }).reason, /Grok \(experimental\) is switched off in relay's config \(targets\.grok\.enabled\)/);
  assert.deepEqual(resolveTarget("claude", "grok", { targets: { grok: { enabled: true, default_model: "grok-4.5" } }, same_family: "refuse" }), { target: "grok", model: "grok-4.5" });
  // Under the default "allow", a call that names Grok reaches it, with the model it names, or none (then labelled family unknown).
  const allow = { targets: { grok: { enabled: true } } };
  assert.deepEqual(resolveTarget("claude", "grok", allow), { target: "grok" });
  assert.deepEqual(resolveTarget("claude", "grok", allow, { model: MODEL }), { target: "grok", model: MODEL });
  // A Grok agent is xAI's, by the model its session runs: it reaches the other families, and another Grok agent only where same_family allows it.
  assert.deepEqual(resolveTarget("grok", "claude", cfg, { callerVendor: "xai" }), { target: "claude" });
  // Every model relay lets Grok run is xAI's, so from a Grok agent there is no model to suggest: it is told so, never "for example ()".
  for (const model of [MODEL, "grok-build", undefined]) {
    const reason = (resolveTarget("grok", "grok", cfg, { model, callerVendor: "xai" }) as { reason: string }).reason;
    // A Grok agent has no subagents (relay switches them off), so it is not told to use them.
    assert.equal(reason, `Grok (experimental) runs only xAI's models, your own family: relay's config (same_family "refuse") reaches only other families. You have no subagents in this turn, so do that work yourself, and use relay for Claude or Codex. If the user wants such calls through relay anyway, they can set "same_family": "allow" in relay's config.`, String(model));
  }
  // From another family, it is judged by the model it runs, not said to run several families' models.
  const noModel = (resolveTarget("claude", "grok", cfg) as { reason: string }).reason;
  assert.equal(noModel, "the family of Grok (experimental) is judged by the model it runs, so relay must know which one would answer: name it with model (for example grok-4.6, grok-4.5, grok-4.7), or set targets.grok.default_model in relay's config.");
  // A default of Grok's names Grok, not Copilot.
  for (const same_family of ["allow", "refuse"] as const) {
    const reason = (resolveTarget("claude", undefined, { targets: { grok: { enabled: true } }, same_family, default_target: { claude: "grok" } }) as { reason: string }).reason;
    assert.equal(reason, "default_target.claude in relay's config names grok, which a call that names no target cannot use: such a call goes only to an agent relay can show is of another family, and Grok would run whatever model it picks. Name grok with a model as target to run it anyway, or set targets.grok.default_model to a model of another family (for example grok-4.6, grok-4.5, grok-4.7).", same_family);
  }
  assert.deepEqual(resolveTarget("grok", "grok", allow, { model: MODEL, callerVendor: "xai" }), { target: "grok", model: MODEL });
  // A Grok agent whose default is Grok, with or without a default model: no model of Grok's could cross, so it is not told to name one.
  for (const same_family of ["allow", "refuse"] as const) for (const default_model of [undefined, MODEL]) {
    const reason = (resolveTarget("grok", undefined, { same_family, targets: { grok: { enabled: true, ...(default_model ? { default_model } : {}) } }, default_target: { grok: "grok" } }, { callerVendor: "xai" }) as { reason: string }).reason;
    assert.equal(reason, "default_target.grok in relay's config names grok, whose models relay lists are all your own family's (xAI's), so a call that names no target cannot use it. Name a target, or fix the config.", `${same_family} ${default_model}`);
  }
  const { sideOfItem } = await import("../dist/targets/index.js");
  assert.equal(sideOfItem(`${grok.reviewPrefix}3`), "grok");
});

test("grok: the tests' own environment holds no Grok home or login path of the developer's", () => {
  // Removed by the test helpers, as every home-like variable is: otherwise a developer's GROK_AUTH_PATH
  // would reach relay and the agents, and a test that tampers with "$GROK_AUTH_PATH" would aim at their login.
  // Checked in a process that is given them, as a developer's shell would give them, and loads the helpers.
  const vars = ["GROK_HOME", "GROK_AUTH_PATH", "COPILOT_HOME"];
  const given = Object.fromEntries(vars.map((k) => [k, path.join(os.tmpdir(), "relay-a-developers", k)]));
  const helpers = pathToFileURL(path.join(import.meta.dirname, "helpers.ts")).href;
  const r = spawnSync(process.execPath, [`--import=${helpers}`, "-e", `console.log(JSON.stringify(${JSON.stringify(vars)}.map((k) => process.env[k] ?? null)))`], { env: { ...process.env, ...given }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").at(-1)!), [null, null, null], "the helpers drop them as they load");
  for (const k of vars) assert.equal(process.env[k], undefined, k);
});

test("grok: what a Grok agent is told it can reach, and what others are told of Grok, agree with what relay lets them reach", async () => {
  const s = await import("../dist/core/steering.js");
  const { withDefaults } = await import("../dist/core/config.js");
  for (const same_family of ["allow", "refuse"] as const) {
    const cfg = withDefaults({ same_family, targets: { grok: { enabled: true, experimental: true }, copilot: { enabled: true, experimental: true } } });
    // A Grok agent (xAI's, by its model) reaches Claude, Codex and Copilot with another family's model, never Grok.
    assert.equal(s.reachText("grok", cfg, "xai"), "Claude or Codex or Copilot (experimental)");
    assert.match(s.preamble("grok", cfg, MODEL), /\(for you, Claude or Codex or Copilot \(experimental\);/);
    assert.match(s.instructions("grok", cfg, false, "xai"), /from this Grok session, Claude or Codex or Copilot \(experimental\)\./);
    // A Copilot agent on an OpenAI model reaches Claude, Copilot with another family's model, and Grok; not Codex.
    assert.equal(s.reachText("copilot", cfg, "openai"), "Claude or Copilot (experimental) or Grok (experimental)");
    assert.match(s.preamble("copilot", cfg, "gpt-6.1-sol"), /\(for you, Claude or Copilot \(experimental\) or Grok \(experimental\);/);
    // Of a family relay cannot tell, only the targets of one family are named, as before.
    assert.equal(s.reachText("grok", cfg, null), "Claude or Codex");
    assert.equal(s.reachText("claude", cfg), "Codex or Copilot (experimental) or Grok (experimental)");
  }
  // In a discussion a Grok agent starts, the other side is told it talks with a Grok agent, of xAI's family.
  assert.equal(s.describeSide("xai", "anthropic"), "a Grok agent (xAI)");
  assert.equal(s.describeSide("xai", "xai"), "another Grok agent, of your own family (xAI)");
  assert.equal(s.describeSide("anthropic", "openai"), "a Claude agent (Anthropic)");
});

test("grok: a Grok agent, whose subagents relay switches off, is told to do its own family's work itself, or to name grok where relay allows it, never to use subagents", async () => {
  const s = await import("../dist/core/steering.js");
  const { crossFamily } = await import("../dist/core/prompts.js");
  const { withDefaults } = await import("../dist/core/config.js");
  for (const access of ["read", "write"] as const) assert.equal(s.turnSubagents("grok", access), false, access);
  const on = { enabled: true, experimental: true };
  const allow = withDefaults({ targets: { grok: on } });
  const refuse = withDefaults({ same_family: "refuse", targets: { grok: on } });
  assert.equal(s.instructions("grok", allow, false, "xai", false), "relay reaches other families of coding agent: from this Grok session, Claude or Codex. It fills the gaps between families. For more Grok agents: you have no subagents in this turn, so you may name grok through relay when the work needs another agent of your kind; relay then labels the work same-family. Every result names both sides' families (families). delegate hands off work, ask puts a question, discuss holds a turn-by-turn discussion with you as one side, review gets an independent review to set against your own.");
  assert.equal(s.instructions("grok", refuse, false, "xai", false), "relay reaches other families of coding agent: from this Grok session, Claude or Codex. It fills the gaps between families. For more Grok agents: you have no subagents in this turn, so do that work yourself; relay's config (same_family \"refuse\") does not start your own family. Every result names both sides' families (families). delegate hands off work, ask puts a question, discuss holds a turn-by-turn discussion with you as one side, review gets an independent review to set against your own.");
  assert.ok(s.targetText("grok", allow, false, "xai", false).endsWith("grok is your own family: you have no subagents in this turn, so name grok when the work needs another Grok agent; relay then labels the work same-family. Registered targets: claude, codex, copilot (experimental), gemini, grok (experimental)."), s.targetText("grok", allow, false, "xai", false));
  assert.ok(s.targetText("grok", refuse, false, "xai", false).endsWith("For your own family (grok): you have no subagents in this turn, so do that work yourself; relay's config (same_family \"refuse\") refuses it. Registered targets: claude, codex, copilot (experimental), gemini, grok (experimental)."), s.targetText("grok", refuse, false, "xai", false));
  // Its preamble, from its target's capabilities, in read and write turns alike.
  for (const access of ["read", "write"] as const) {
    assert.equal(crossFamily("grok", refuse, MODEL, access), "The relay tools reach another family of agent only (for you, Claude or Codex; name one as target unless relay's config sets your default). You have no subagents of your own in this turn, so do the work of a helper of your own kind yourself.", access);
    assert.match(crossFamily("grok", allow, MODEL, access), /You have no subagents of your own in this turn, so you may name your own family's target/, access);
  }
  for (const text of [s.instructions("grok", allow, false, "xai", false), s.instructions("grok", refuse, false, "xai", false), s.targetText("grok", allow, false, "xai", false), s.targetText("grok", refuse, false, "xai", false), crossFamily("grok", refuse, MODEL), crossFamily("grok", allow, MODEL)]) {
    assert.doesNotMatch(text, /use (your|your host's) own subagents/, text);
  }
});

test("grok: the model parameter's text names Grok wherever it is switched on, and under same_family \"refuse\" says a call to it needs a model relay lists", async () => {
  const s = await import("../dist/core/steering.js");
  const { withDefaults } = await import("../dist/core/config.js");
  const on = { enabled: true, experimental: true };
  const lead = "The model to run. Optional for claude and codex (their default otherwise).";
  const grokText = (too: string) => ({
    refuse: `For grok the model decides the family${too} (every model relay's list names for it is xAI's, for example grok-4.6, grok-4.5, grok-4.7), so name one of those: relay's config (same_family "refuse") refuses no model and ids its list does not name.`,
    allow: `For grok the model decides the family${too} (every model relay's list names for it is xAI's, for example grok-4.6, grok-4.5, grok-4.7): name one and relay labels the work as xAI's; with no model relay labels the family unknown, and an id its list does not name is refused before Grok starts (relay's settings for it allow only those).`,
  });
  for (const same_family of ["allow", "refuse"] as const) {
    assert.equal(s.modelText(withDefaults({ same_family, targets: { grok: on } })), `${lead} ${grokText("")[same_family]}`, same_family);
    // With Copilot on too: Copilot's text as before, then Grok's.
    const copilot = s.modelText(withDefaults({ same_family, targets: { copilot: on } }));
    assert.ok(copilot.startsWith(`${lead} For copilot the model decides the family`), copilot);
    assert.equal(s.modelText(withDefaults({ same_family, targets: { copilot: on, grok: on } })), `${copilot} ${grokText(" too")[same_family]}`, same_family);
    assert.equal(s.modelText(withDefaults({ same_family })), "The model to run; optional (the target's default otherwise).");
  }
});

test("grok: a launched Grok agent's relay server says, from the family of the model it runs, that it reaches Claude, Codex and Copilot, and never offers Grok", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { relayServer } = await import("../dist/mcp/server.js");
  const { newInstance } = await import("../dist/core/caller.js");
  const { createRun, insertNode, closeDbForTests } = await import("../dist/core/db.js");
  const { withDefaults } = await import("../dist/core/config.js");
  const h = await harness();
  const saved = process.env.RELAY_HOME;
  closeDbForTests();
  process.env.RELAY_HOME = h.home;
  try {
    for (const same_family of ["allow", "refuse"] as const) {
      const cfg = withDefaults({ same_family, targets: { grok: { enabled: true, experimental: true }, copilot: { enabled: true, experimental: true } } });
      const run = createRun(h.repo, cfg, `grok-root-${same_family}`);
      const node = insertNode({ id: `grok-child-${same_family}`, run_id: run, kind: "job", target: "grok", task: "t", cwd: h.repo, mode: "read", depth: 1, model: MODEL });
      const inst = newInstance({ kind: "child", runId: run, nodeId: node.id, depth: 1, turnId: 1, access: "read", mayDelegate: true, mayAsk: false } as never, h.repo);
      const server = relayServer(inst);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "grok", version: "0" });
      try {
        await Promise.all([server.connect(a), client.connect(b)]);
        assert.match(client.getInstructions() ?? "", /from this Grok session, Claude or Codex or Copilot \(experimental\)\./, same_family);
        assert.match(client.getInstructions() ?? "", /For more Grok agents: you have no subagents in this turn, so /, same_family);
        assert.doesNotMatch(client.getInstructions() ?? "", /own subagents/, same_family);
        const delegate = (await client.listTools()).tools.find((t) => t.name === "delegate")!;
        assert.ok(delegate.description!.includes("(Claude or Codex or Copilot (experimental))"), delegate.description);
        const target = (delegate.inputSchema.properties!.target as { description: string }).description;
        assert.ok(target.includes("Name one of the agents of another family (claude (Anthropic), codex (OpenAI), copilot (experimental; the family of the model you give)); relay cannot choose for you."), target);
        assert.ok(target.includes("you have no subagents in this turn") && !target.includes("own subagents"), target);
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    closeDbForTests();
    if (saved === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = saved;
    await h.close();
  }
});

test("grok: under same_family \"refuse\" the ACP driver refuses a Grok turn that names no model, as judged by its model, not as running several families' models; and under either setting one that names a model relay does not list", async () => {
  const { startAcpTurn } = await import("../dist/backends/acp.js");
  const { grokProfile } = await import("../dist/backends/grok.js");
  const { copilotProfile } = await import("../dist/backends/copilot.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const { withDefaults } = await import("../dist/core/config.js");
  const on = { enabled: true, experimental: true };
  const spec = { target: targetDef("grok"), config: withDefaults({ same_family: "refuse", targets: { grok: on } }) } as never;
  await assert.rejects(startAcpTurn(spec, { ...grokProfile, refuse: undefined }), { message: "The family of Grok (experimental) is judged by the model it runs, and this turn names none, so relay cannot tell which family would answer. It does not launch it." });
  // Copilot's side of the same refusal: it does run several families' models.
  const copilot = { target: targetDef("copilot"), config: withDefaults({ same_family: "refuse", targets: { copilot: on } }) } as never;
  await assert.rejects(startAcpTurn(copilot, { ...copilotProfile, refuse: undefined }), { message: "Copilot (experimental) runs models of several families, and this turn names none, so relay cannot tell which family would answer. It does not launch it." });
  // Relay runs Grok on its listed models only (listedModelsOnly): "auto" or an unlisted id is refused before Grok starts, under "allow" too.
  for (const model of ["auto", "grok-code-fast-1", "grok-build"]) {
    const allow = { target: targetDef("grok"), model, config: withDefaults({ targets: { grok: on } }) } as never;
    await assert.rejects(startAcpTurn(allow, { ...grokProfile, refuse: undefined }), { message: `relay lets Grok (experimental) run only the models its list names (grok-4.6, grok-4.5, grok-4.7), so it does not launch it with ${JSON.stringify(model)}.` }, model);
  }
});

test("grok: the profile's reading of an approval request resolves its paths and directory against the agent's own, and says relay's sandbox stays on", async () => {
  const { grokProfile } = await import("../dist/backends/grok.js");
  const spec = { cwd: "/w/repo" } as never;
  assert.deepEqual(grokProfile.normalizeApproval({ toolCallId: "t1", kind: "execute", title: "Run make", rawInput: { command: "make test", cwd: "sub" } } as never, spec), {
    kind: "command", summary: "make test", reason: "Run make", detail: { cwd: "/w/repo/sub", tool_call: "t1", confined: true },
  });
  assert.deepEqual(grokProfile.normalizeApproval({ toolCallId: "t2", kind: "edit", title: "Edit", rawInput: { path: "a.txt" }, locations: [{ path: "/abs/b.txt" }] } as never, spec), {
    kind: "file", summary: "edit /abs/b.txt, a.txt", reason: "Edit", paths: ["/abs/b.txt", "/w/repo/a.txt"], detail: { tool_call: "t2", cwd: "/w/repo", confined: true },
  });
  assert.equal(grokProfile.normalizeApproval({ toolCallId: "t3", kind: "other", title: "Something", rawInput: {} } as never, spec), null, "what relay has no reading of is refused without reaching anyone");
});

test("grok: the config knows targets.grok, off and experimental unless switched on, and launches refuse it until targets.grok.experimental", async () => {
  const { validateConfig, withDefaults, DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const { untested } = await import("../dist/backends/run.js");
  assert.deepEqual(validateConfig({ targets: { grok: { enabled: true, experimental: true, default_model: MODEL } } }, "x"), { targets: { grok: { enabled: true, experimental: true, default_model: MODEL } } });
  assert.throws(() => validateConfig({ targets: { grok: { experimental: "yes" } } }, "x"), /experimental/);
  assert.deepEqual(withDefaults({}).targets.grok, { enabled: false, bin: "grok" });
  assert.match(untested("grok", withDefaults({ targets: { grok: { enabled: true } } })) ?? "", /^Grok is experimental: relay has not qualified it with a signed-in run.*targets\.grok\.experimental/);
  assert.equal(DEFAULT_CONFIG.targets.grok.enabled, false);
});

test("grok: the profile starts `grok agent stdio` with no leader, no update and no asking, and every Grok, xAI, OpenTelemetry and Sentry variable is relay's to set", async () => {
  const { grokProfile, GROK_ENV, grokUserAuthPath } = await import("../dist/backends/grok.js");
  const spec = (effort?: string, network = false) => ({ effort, cwd: "/w", config: { child_network: false }, grant: network ? { network: true } : undefined }) as never;
  // Without a network grant Grok's web search is dropped (--disable-web-search, a top-level flag: it goes out through Grok's own API host and never asks).
  assert.deepEqual(grokProfile.args(spec("high"), MODEL), ["--no-auto-update", "--disable-web-search", "agent", "--no-leader", "--always-approve", "-m", MODEL, "--reasoning-effort", "high", "stdio"]);
  assert.deepEqual(grokProfile.args(spec(), undefined), ["--no-auto-update", "--disable-web-search", "agent", "--no-leader", "--always-approve", "stdio"]);
  assert.deepEqual(grokProfile.args(spec(undefined, true), MODEL), ["--no-auto-update", "agent", "--no-leader", "--always-approve", "-m", MODEL, "stdio"], "with a network grant it keeps its web search");
  for (const k of ["GROK_MODELS_BASE_URL", "GROK_CONFIG", "GROK_CONFIG_PATH", "GROK_AUTH_PATH", "GROK_HOME", "GROK_LOCAL_AUTH", "GROK_OIDC_ISSUER", "XAI_API_KEY", "XAI_API_KEYS", "OTEL_EXPORTER_OTLP_ENDPOINT", "SENTRY_DSN"]) assert.ok(grokProfile.scrub(k), k);
  for (const k of ["PATH", "HOME", "LANG", "ANTHROPIC_API_KEY", "STUB_SCENARIO"]) assert.ok(!grokProfile.scrub(k), k);
  assert.deepEqual(grokProfile.login.reuse, ["cached_token"], "the stored login only, checked without a browser");
  assert.match(grokProfile.login.how, /grok login/);
  // What relay sets in its place, whole: Grok's own sandboxes off (they would nest inside relay's), its
  // updater, telemetry, crash and error reports, subagents, memory, campaigns, managed MCP servers,
  // session sync and web_fetch off, and nothing imported from Claude Code, Cursor or Codex.
  const imports = Object.fromEntries(["CLAUDE", "CURSOR", "CODEX"].flatMap((tool) => ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"].map((what) => [`GROK_${tool}_${what}_ENABLED`, "0"])));
  assert.deepEqual({ ...GROK_ENV }, {
    GROK_SANDBOX: "off", GROK_SANDBOX_MODE: "off", GROK_DISABLE_AUTOUPDATER: "1",
    GROK_TELEMETRY_ENABLED: "0", GROK_TELEMETRY_TRACE_UPLOAD: "0", GROK_TELEMETRY_MIXPANEL_ENABLED: "0",
    GROK_ERROR_REPORTING: "0", DISABLE_ERROR_REPORTING: "1", GROK_EXTERNAL_OTEL: "0", GROK_CRASH_HANDLER: "0",
    GROK_SUBAGENTS: "0", GROK_MEMORY: "0", GROK_CAMPAIGNS: "0", GROK_MANAGED_MCPS_ENABLED: "0",
    GROK_RELAY_SYNC_ENABLED: "0", GROK_SESSION_REGISTRY: "0", GROK_WEB_FETCH: "0",
    ...imports,
  });
  assert.ok(Object.keys(GROK_ENV).every((k) => !/^(XAI_|OTEL_)/.test(k) && k !== "SENTRY_DSN"), "relay sets no xAI key, OpenTelemetry sink or Sentry DSN");
  assert.ok(Object.isFrozen(GROK_ENV));
  // Where the user's own login is, as Grok finds it.
  assert.equal(grokUserAuthPath({ GROK_AUTH_PATH: "/a/auth.json", GROK_HOME: "/h" }), "/a/auth.json");
  assert.equal(grokUserAuthPath({ GROK_HOME: "/h" }), "/h/auth.json");
  assert.equal(grokUserAuthPath({ GROK_AUTH_PATH: "", GROK_HOME: "" }), path.join(os.homedir(), ".grok", "auth.json"), "an empty variable is unset, as for Grok");
});

test("grok: relay runs Grok on the login in ~/.grok only, its login store, and refuses a worker whose Grok variables put it elsewhere", async () => {
  const { grokLoginPath, grokLoginRefusal, grokProfile } = await import("../dist/backends/grok.js");
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-grok-login-")));
  try {
    const name = "Grok (experimental)";
    const login = path.join(scratch, ".grok", "auth.json");
    assert.equal(grokLoginPath(scratch), login);
    assert.equal(grokLoginRefusal(name, {}, scratch), `${name} has no login on this machine (${path.join(scratch, ".grok")} does not exist). Sign in with \`grok login\`.`);
    fs.mkdirSync(path.join(scratch, ".grok"), { mode: 0o700 });
    for (const env of [{}, { GROK_HOME: path.join(scratch, ".grok") }, { GROK_HOME: `${path.join(scratch, ".grok")}/` }, { GROK_AUTH_PATH: login }, { GROK_AUTH_PATH: "", GROK_HOME: "" }]) assert.equal(grokLoginRefusal(name, env, scratch), null, JSON.stringify(env));
    assert.equal(grokLoginRefusal(name, { GROK_HOME: "/elsewhere" }, scratch), `GROK_HOME in relay's environment puts Grok's login at /elsewhere/auth.json, but relay runs ${name} only on the login in ${login}, the one place its sandbox lets a turn refresh it. Unset GROK_HOME in the environment relay runs in, so that \`grok login\` keeps the login there.`);
    assert.match(grokLoginRefusal(name, { GROK_AUTH_PATH: "/k/auth.json", GROK_HOME: path.join(scratch, ".grok") }, scratch)!, /^GROK_AUTH_PATH in relay's environment puts Grok's login at \/k\/auth\.json/);
    // The profile's refusal, before anything starts: this process's HOME (the tests' scratch one) has no ~/.grok.
    assert.match(grokProfile.refuse!({ target: (await import("../dist/targets/index.js")).targetDef("grok") } as never)!, /Grok \(experimental\) has no login on this machine \(.*\.grok does not exist\)/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("grok: Grok's login-store grant passes the sandbox layer's own checks on a login directory as `grok login` leaves it", async () => {
  const { loginStore } = await import("../dist/backends/acp.js");
  const { tokenStore } = await import("../dist/confine/seatbelt.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-grok-store-")));
  try {
    const dir = path.join(scratch, ".grok");
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "auth.json"), "{}", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "auth.json.lock"), "4242:1760000000", { mode: 0o644 });
    fs.writeFileSync(path.join(dir, ".4242.3.tmp"), "", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "config.toml"), "", { mode: 0o600 });
    fs.mkdirSync(path.join(dir, "sessions"));
    const store = loginStore(targetDef("grok").tokenStore!, scratch);
    assert.equal(store.dir, dir);
    const checked = tokenStore(store);
    assert.deepEqual([checked.files, checked.locks, checked.subdirs], [[path.join(dir, "auth.json")], [path.join(dir, "auth.json.lock")], [path.join(dir, "sessions")]]);
    // A stale temp file of Grok's that is a link, or executable, refuses the turn (and is left for the person).
    fs.chmodSync(path.join(dir, ".4242.3.tmp"), 0o700);
    assert.throws(() => tokenStore(store), /is executable/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("grok: relay's config.toml pins the stored login and turns off Grok's sandbox, telemetry, updates, subagents, memory and every import, and allows only the reviewed models", async () => {
  const { grokConfig } = await import("../dist/backends/grok.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const c = parseToml(grokConfig()) as Rec;
  assert.equal(c.auth.preferred_method, "oidc", "cached_token then fails without a stored login instead of falling through to a browser or an API key");
  // The pin refuses the API-key method, not an API key stored in auth.json (its xai::api_key scope, which 1.0.62
  // loads): Grok's own switch refuses that too, under child_auth "login" (review r_f887dc06 C2).
  assert.equal(c.auth.disable_api_key_auth, true, "a stored API key is refused as well");
  const keys = parseToml(grokConfig(false, true)) as Rec;
  assert.equal("disable_api_key_auth" in keys.auth, false, "under child_auth \"any\", whatever Grok signs in with is accepted");
  assert.equal(keys.auth.preferred_method, "oidc", "and the pin stays");
  assert.equal(c.sandbox.profile, "off");
  assert.deepEqual([c.cli.auto_update, c.cli.use_leader, c.cli.session_registry], [false, false, false]);
  assert.deepEqual([c.features.telemetry, c.features.managed_config, c.features.campaigns], [false, false, false]);
  assert.deepEqual([c.telemetry.trace_upload, c.telemetry.otel_enabled, c.diagnostics.error_reporting], [false, false, false]);
  assert.deepEqual([c.subagents.enabled, c.memory.enabled, c.memory_v2.enabled, c.session.load_envrc, c.managed_mcps.enabled, c.relay.enabled], [false, false, false, false, false, false]);
  assert.deepEqual([c.harness.disable_workspace_teleport, c.harness.disable_codebase_upload], [true, true]);
  for (const tool of ["claude", "cursor", "codex"]) {
    assert.ok(Object.keys(c.compat[tool]).length > 0, tool);
    for (const [k, v] of Object.entries(c.compat[tool])) assert.equal(v, false, `compat.${tool}.${k}`);
  }
  assert.deepEqual(c.models.allowed_models, Object.keys(targetDef("grok").models!));
  for (const k of ["model", "model_providers", "endpoints", "mcp_servers", "hooks", "plugins", "auth_provider", "experiments", "campaigns"]) assert.equal(k in c, false, `no ${k} of anyone's`);
  // Its web tools: web_search (on in Grok by default, never asking, out through cli-chat-proxy.grok.com) is dropped without a
  // network grant, which drops web_fetch too (1.0.62: 25 tools, 24 with disable_web_search; GROK_WEB_FETCH=1 makes 26, still 24 with it).
  assert.equal(c.disable_web_search, true);
  assert.equal(c.features.web_fetch, false);
  // Its server-side tools (backend web search, X search, the code interpreter), run inside the model request on that same host: off too.
  assert.equal(c.features.backend_tools, false);
  const granted = parseToml(grokConfig(true)) as Rec;
  assert.equal("disable_web_search" in granted, false, "with a network grant web_search stays");
  assert.equal("backend_tools" in granted.features, false, "and so do its server-side tools");
  assert.equal(granted.features.web_fetch, false);
});

test("grok: relay builds Grok's home for each session, keeps only its sessions from turn to turn, and refuses one swapped for a link", async () => {
  const { grokState } = await import("../dist/backends/grok.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-grok-state-")));
  const saved = { relay: process.env.RELAY_HOME, auth: process.env.GROK_AUTH_PATH, home: process.env.GROK_HOME };
  process.env.RELAY_HOME = path.join(scratch, "relay");
  delete process.env.GROK_AUTH_PATH;
  process.env.GROK_HOME = path.join(scratch, "user-grok");
  try {
    const spec = { target: targetDef("grok"), markers: { runId: "r1", nodeId: "j1", depth: 1 }, config: { child_network: false, child_auth: "login", targets: {} } } as never;
    const state = grokState(spec);
    const home = path.join(`${process.env.RELAY_HOME}-harness`, "r1", "j1", "grok");
    assert.deepEqual(state.persistent, { root: home, writable: ["sessions", "turn"] });
    assert.equal(state.home, "temp", "a temporary HOME hides ~/.claude, ~/.cursor, ~/.codex and ~/.agents");
    assert.equal(state.keychain, false);
    assert.equal(state.certificateTrust, true);
    assert.equal(state.env.GROK_HOME, home);
    assert.equal(state.env.GROK_AUTH_PATH, path.join(os.homedir(), ".grok", "auth.json"), "the login in ~/.grok, relay's login store, whatever the worker's GROK_HOME says (one elsewhere is refused before this: grokLoginRefusal)");
    assert.equal(state.env.GROK_BACKEND_SEARCH, "0", "no network grant: Grok's server-side tools off, by the variable that outranks its files too");
    assert.equal(grokState({ ...(spec as object), grant: { network: true } } as never).env.GROK_BACKEND_SEARCH, undefined, "with a grant they stay");
    // Under child_auth "login" an API key stored in auth.json is refused, by the variable as well as the file (review r_f887dc06 C2).
    assert.equal(state.env.GROK_DISABLE_API_KEY_AUTH, "1");
    assert.equal((parseToml(fs.readFileSync(path.join(home, "config.toml"), "utf8")) as Rec).auth.disable_api_key_auth, true);
    for (const config of [{ child_network: false, child_auth: "login", targets: { grok: { child_auth: "any" } } }, { child_network: false, child_auth: "any", targets: {} }]) {
      const any = grokState({ ...(spec as object), config } as never);
      assert.equal(any.env.GROK_DISABLE_API_KEY_AUTH, undefined, `under child_auth "any" (${JSON.stringify(config)}) relay leaves Grok's sign-in to it`);
      assert.equal("disable_api_key_auth" in (parseToml(fs.readFileSync(path.join(home, "config.toml"), "utf8")) as Rec).auth, false);
    }
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.ok(fs.readFileSync(path.join(home, "config.toml"), "utf8").includes('preferred_method = "oidc"'));
    assert.equal(fs.readlinkSync(path.join(home, "logs")), path.join(home, "turn", "logs"));
    assert.ok(!fs.existsSync(path.join(home, "requirements.toml")), "an unsigned requirements.toml would be read but not applied, so relay writes none");
    assert.ok(!fs.existsSync(path.join(scratch, "user-grok")), "nothing is made in the user's own Grok home");
    // The next turn: everything but the sessions is rebuilt.
    fs.writeFileSync(path.join(home, "sessions", "kept.json"), "{}");
    fs.writeFileSync(path.join(home, "config.toml"), "[sandbox]\nprofile = 'strict'\n");
    fs.writeFileSync(path.join(home, "managed_config.toml"), "x");
    state.cleanup!();
    assert.ok(!fs.existsSync(path.join(home, "turn")), "the turn's own logs go with it");
    grokState(spec);
    assert.ok(fs.existsSync(path.join(home, "sessions", "kept.json")));
    assert.ok(!fs.existsSync(path.join(home, "managed_config.toml")));
    assert.match(fs.readFileSync(path.join(home, "config.toml"), "utf8"), /profile = "off"/);
    // A session store swapped for a link stops the turn.
    fs.rmSync(path.join(home, "sessions"), { recursive: true });
    fs.symlinkSync(scratch, path.join(home, "sessions"));
    assert.throws(() => grokState(spec), /replaced by something other than a directory/);
  } finally {
    for (const [k, v] of [["RELAY_HOME", saved.relay], ["GROK_AUTH_PATH", saved.auth], ["GROK_HOME", saved.home]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("grok: a machine with Grok configuration relay cannot override (/etc/grok, device management) is refused", async () => {
  const { GROK_SYSTEM_LAYERS, grokSystemLayers, grokSystemRefusal, systemLayer } = await import("../dist/backends/grok.js");
  for (const p of ["/etc/grok/managed_config.toml", "/etc/grok/requirements.toml", "/Library/Managed Preferences/ai.x.grok.plist"]) assert.ok(GROK_SYSTEM_LAYERS.includes(p), p);
  // The list checked by default: the machine's layers and this user's device-managed preferences.
  assert.deepEqual(grokSystemLayers(), [...GROK_SYSTEM_LAYERS, path.join("/Library/Managed Preferences", os.userInfo().username, "ai.x.grok.plist")]);
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-grok-layers-")));
  try {
    const [missing, present, linked] = ["missing.toml", "present.toml", "linked.toml"].map((n) => path.join(scratch, n));
    assert.equal(systemLayer([missing]), null);
    assert.equal(grokSystemRefusal("Grok (experimental)", [missing]), null, "nothing there: Grok runs");
    fs.writeFileSync(present, "");
    assert.equal(systemLayer([missing, present]), present);
    assert.equal(grokSystemRefusal("Grok (experimental)", [missing, present]), `this machine has Grok configuration that relay cannot override (${present}): its pinned settings outrank everything relay sets, so relay cannot tell which model would answer or keep Grok (experimental)'s own sandbox and telemetry off. It does not run Grok (experimental) here.`);
    fs.symlinkSync(path.join(scratch, "nowhere"), linked);
    assert.equal(systemLayer([missing, linked]), linked, "a dangling link counts: relay does not guess what Grok would make of it");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("grok: the profile's refusal checks the system layers first: one present refuses Grok with a login in ~/.grok too, and outranks the login refusal", async () => {
  const { grokProfile, grokSystemLayers, setGrokSystemLayersForTests } = await import("../dist/backends/grok.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const spec = { target: targetDef("grok") } as never;
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-grok-refuse-")));
  // The tests' own scratch HOME, which has no ~/.grok until this test makes one.
  const login = scratchOnly(path.join(os.homedir(), ".grok"), "HOME");
  const layer = path.join(scratch, "managed_config.toml");
  const system = /^this machine has Grok configuration that relay cannot override \(.*managed_config\.toml\)/;
  try {
    setGrokSystemLayersForTests([path.join(scratch, "missing.toml"), layer]);
    assert.deepEqual(grokSystemLayers(), [path.join(scratch, "missing.toml"), layer]);
    assert.match(grokProfile.refuse!(spec)!, /Grok \(experimental\) has no login on this machine/, "no layer and no login: the login's refusal");
    fs.writeFileSync(layer, "");
    assert.match(grokProfile.refuse!(spec)!, system, "a layer and no login: the layer's, first");
    fs.mkdirSync(login, { mode: 0o700 });
    assert.match(grokProfile.refuse!(spec)!, system, "a layer and a login: still refused");
    fs.rmSync(layer);
    assert.equal(grokProfile.refuse!(spec), null, "the login and no layer: Grok runs");
  } finally {
    setGrokSystemLayersForTests(null);
    fs.rmSync(login, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(grokSystemLayers().length, 4, "the stand-in is gone");
});

test("grok: the resume command, which relay does not show yet, would open the session in the user's own grok with relay's home for it and the login relay's turns use", async () => {
  const { targetDef } = await import("../dist/targets/index.js");
  const cmd = targetDef("grok").resumeCommand("01a14b60-b3ee-7392-8d2e-618eff7f10f1", { harnessState: "/h/run/j_1" });
  assert.equal(cmd, `GROK_AUTH_PATH="$HOME/.grok/auth.json" GROK_HOME='/h/run/j_1/grok' grok --resume '01a14b60-b3ee-7392-8d2e-618eff7f10f1'`);
  // As a shell runs it: the login in ~/.grok, whatever Grok variables the user's shell has.
  const show = cmd.replace(/ grok --resume \S+$/, ' /bin/sh -c \'printf "%s|%s" "$GROK_AUTH_PATH" "$GROK_HOME"\'');
  const run = (env: Record<string, string>) => spawnSync("/bin/sh", ["-c", show], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" }).stdout;
  assert.equal(run({ HOME: "/u" }), "/u/.grok/auth.json|/h/run/j_1/grok");
  assert.equal(run({ HOME: "/u", GROK_HOME: "/mine" }), "/u/.grok/auth.json|/h/run/j_1/grok");
  assert.equal(run({ HOME: "/u", GROK_AUTH_PATH: "/k/auth.json" }), "/u/.grok/auth.json|/h/run/j_1/grok");
});

onMac("grok: a read job runs confined over ACP with network only to Grok's hosts, its stored login reused through cached_token, the model read back, and Grok's home and environment relay's", async () => {
  const rules: Rule[] = [{ target: "grok", match: task("READ1"), steps: [{ run: "echo x > blocked.txt; echo y > \"$TMPDIR/ok.txt\"" }, { reply: "grok read reply" }] }];
  const h = await grokHarness(rules, GROK(), {
    XAI_API_KEY: "xai-secret", GROK_AUTH: "{}", GROK_MODELS_BASE_URL: "https://elsewhere.example/v1", GROK_CONFIG: '{"sandbox":{"profile":"strict"}}',
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example", SENTRY_DSN: "https://sentry.example/1", ANTHROPIC_API_KEY: "sk-ant",
  });
  try {
    const user = userGrok(h);
    const job = await root(h).call("delegate", { target: "grok", model: MODEL, task: "READ1", mode: "read", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.equal(job.result.final_message, "grok read reply");
    assert.ok(!fs.existsSync(path.join(h.repo, "blocked.txt")), "a read job cannot write the checkout it reads");
    assert.equal(h.sql("SELECT model FROM nodes WHERE id = ?", job.job_id)[0].model, MODEL, "the model the family was judged by is kept with the session");
    const recs = grokRecords(h);
    const start = grokStarts(h)[0];
    assert.equal(start.target, "grok");
    assert.deepEqual(start.argv, ["--no-auto-update", "--disable-web-search", "agent", "--no-leader", "--always-approve", "-m", MODEL, "stdio"]);
    assert.equal(start.model, MODEL);
    assert.deepEqual(recs.filter((r) => r.event === "authenticate").map((r) => [r.methodId, r.session]), [["cached_token", false], ["cached_token", true]], "the stored login, checked before the session and again once it exists");
    assert.equal(recs.find((r) => r.event === "session")!.method, "session/new");
    assert.deepEqual(recs.find((r) => r.event === "session")!.mcpServers, ["relay"], "relay's bridge goes to the session (relayTools)");
    assert.equal(start.hasRelay, true);
    // No command to open it in the user's own grok: it would restore, outside relay's sandbox, session files the turn could write.
    assert.deepEqual(job.resume_natively, { command: null, note: (await import("../dist/targets/index.js")).targetDef("grok").nativeResumeWithheld });
    assert.match(job.resume_natively.note, /^Relay shows no command to open a Grok session in your own grok\..*read jobs included.*outside relay's sandbox.*relay's Grok settings rather than yours.*Grok's own sandbox off for the life of the session.*Continue it with relay's resume/);
    // Its login store, a stated downgrade, in the turn's log.
    assert.ok(agentLog(h, job.job_id).includes(`# relay login store: Grok's login directory (${user.dir}): its token, lock and temp names only (auth.json, auth.json.lock, `), agentLog(h, job.job_id));
    // The network: relay's proxy to Grok's two hosts and nothing else.
    assert.match(agentLog(h, job.job_id), /# relay network: off, except relay's proxy to cli-chat-proxy\.grok\.com, auth\.x\.ai, and what the certificate-trust daemons fetch for it, past the proxy \(a stated downgrade\) \(decisions in /);
    // The environment: relay's Grok variables only, the user's login where their grok keeps it, and a temporary HOME.
    const env = start.env.grok as Record<string, string>;
    const home = env.GROK_HOME;
    assert.ok(home.startsWith(`${h.home}-harness/`) && home.includes(job.job_id), `a Grok home of relay's own per session, outside its control directory (${home})`);
    assert.equal(env.GROK_AUTH_PATH, user.auth, "the login in ~/.grok");
    for (const k of ["XAI_API_KEY", "GROK_AUTH", "GROK_MODELS_BASE_URL", "GROK_CONFIG", "OTEL_EXPORTER_OTLP_ENDPOINT", "SENTRY_DSN"]) assert.equal(env[k], undefined, `${k} is gone`);
    assert.equal(start.env.anthropicKey, false, "and no other vendor's key either");
    assert.deepEqual([env.GROK_SANDBOX, env.GROK_SANDBOX_MODE, env.GROK_SUBAGENTS, env.GROK_MEMORY, env.GROK_TELEMETRY_ENABLED, env.GROK_CLAUDE_HOOKS_ENABLED], ["off", "off", "0", "0", "0", "0"]);
    assert.ok(start.env.home && start.env.home !== h.env.HOME && start.env.home.startsWith(start.env.tmpdir), `a temporary HOME (${start.env.home})`);
    const written = parseToml(fs.readFileSync(path.join(home, "config.toml"), "utf8")) as Rec;
    assert.equal(written.auth.preferred_method, "oidc");
    assert.equal(written.auth.disable_api_key_auth, true, "and no API key stored in auth.json either");
    assert.equal(env.GROK_DISABLE_API_KEY_AUTH, "1");
    assert.equal(written.disable_web_search, true, "no network grant, so no web search");
    assert.equal(written.features.backend_tools, false, "and no server-side tools");
    assert.equal(env.GROK_BACKEND_SEARCH, "0");
    assert.equal(env.GROK_WEB_FETCH, "0");
    assert.ok(!fs.existsSync(path.join(home, "turn")), "the turn's own logs are gone with it");
    assert.ok(start.env.tmpdir && !fs.existsSync(start.env.tmpdir), "the turn's private temp directory is removed with the turn");
    assert.equal(fs.readFileSync(user.auth, "utf8").includes("secret-refresh-token"), true, "the user's login is as it was");
  } finally {
    await h.close();
  }
});

onMac("grok: without a stored login Grok offers no cached_token, and relay refuses the turn with how to sign in, starting no sign-in of its own", async () => {
  // ~/.grok as `grok logout` leaves it: the directory, no auth.json. The stub, like 1.0.62, looks at the file relay points it at.
  const h = await grokHarness([{ target: "grok", steps: [{ reply: "never" }] }], GROK());
  fs.rmSync(userGrok(h).auth);
  try {
    const job = await root(h).call("delegate", { target: "grok", model: MODEL, task: "NOLOGIN", mode: "read", background: false });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, /Grok \(experimental\) does not offer the login check relay knows \(cached_token\).*Sign in with `grok login`/);
    const recs = grokRecords(h);
    assert.deepEqual(recs.filter((r) => r.event === "authenticate"), [], "relay authenticated with nothing: grok.com would start a browser sign-in");
    assert.equal(grokStarts(h).length, 0, "no prompt was sent");
  } finally {
    await h.close();
  }
});

onMac("grok: under child_auth \"any\" relay makes no login check: with a stored login Grok opens its session without one, as 1.0.62 does, and without one it refuses the session", async () => {
  const h = await grokHarness([{ target: "grok", steps: [{ reply: "ran without authenticate" }] }], GROK({ child_auth: "any" }));
  try {
    const job = await root(h).call("delegate", { target: "grok", model: MODEL, task: "ANY1", mode: "read", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.equal(job.result.final_message, "ran without authenticate");
    assert.deepEqual(grokRecords(h).filter((r) => r.event === "authenticate"), [], "no login check, as child_auth \"any\" says");
    assert.equal((grokStarts(h)[0].env.grok as Record<string, string>).GROK_DISABLE_API_KEY_AUTH, undefined, "nor Grok's own refusal of a stored API key");
  } finally {
    await h.close();
  }
  // No stored login: Grok 1.0.62 answers session/new "Authentication required" when nothing authenticated first.
  const none = await grokHarness([{ target: "grok", steps: [{ reply: "never" }] }], GROK({ child_auth: "any" }));
  fs.rmSync(userGrok(none).auth);
  try {
    const job = await root(none).call("delegate", { target: "grok", model: MODEL, task: "ANY2", mode: "read", background: false });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, /Authentication required/);
    assert.equal(grokStarts(none).length, 0, "no prompt was sent");
  } finally {
    await none.close();
  }
});

onMac("grok: a worker whose GROK_AUTH_PATH puts the login elsewhere, or a machine with no ~/.grok, is refused before Grok starts", async () => {
  const elsewhere = await grokHarness([{ target: "grok", steps: [{ reply: "never" }] }], GROK(), { GROK_AUTH_PATH: path.join(os.tmpdir(), "relay-grok-elsewhere", "auth.json") });
  try {
    const job = await root(elsewhere).call("delegate", { target: "grok", model: MODEL, task: "ELSEWHERE", mode: "read", background: false });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, /GROK_AUTH_PATH in relay's environment puts Grok's login at .*relay-grok-elsewhere\/auth\.json, but relay runs Grok \(experimental\) only on the login in .*\.grok\/auth\.json/);
    assert.deepEqual(grokRecords(elsewhere), [], "Grok was not started");
  } finally {
    await elsewhere.close();
  }
  const never = await grokHarness([{ target: "grok", steps: [{ reply: "never" }] }], GROK(), {}, false);
  try {
    const job = await root(never).call("delegate", { target: "grok", model: MODEL, task: "NEVER", mode: "read", background: false });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, /Grok \(experimental\) has no login on this machine \(.*\.grok does not exist\)\. Sign in with `grok login`/);
    assert.deepEqual(grokRecords(never), []);
  } finally {
    await never.close();
  }
});

onMac("grok: Grok's home is relay's, and in ~/.grok a turn can do Grok's refresh and nothing else: not change relay's settings, add to its home, or touch any other name in the login directory", async () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-outside-")));
  // What the agent is given: GROK_AUTH_PATH, ~/.grok's login. The rules aim at it through that variable only.
  const D = '"$(dirname "$GROK_AUTH_PATH")"';
  const rules: Rule[] = [{
    target: "grok", turn: 1, match: task("TAMPER"), steps: [
      { run: `rm -rf "$GROK_HOME/sessions"; ln -s ${JSON.stringify(outside)} "$GROK_HOME/sessions"; mv "$GROK_HOME/sessions" "$GROK_HOME/sessions.away"` },
      { run: 'printf "[sandbox]\\nprofile = \\"strict\\"\\n" > "$GROK_HOME/config.toml"; touch "$GROK_HOME/managed_config.toml" "$GROK_HOME/requirements.toml"; echo ok > "$GROK_HOME/sessions/mine.txt"' },
      // Grok's own save (fs_atomic.rs): a new temp file, mode 0600, written, chmodded, renamed onto the token, the token chmodded; and its lock.
      { run: `printf held > ${D}/auth.json.lock; (umask 077; printf refreshed > ${D}/.4242.17.tmp) && chmod 600 ${D}/.4242.17.tmp && mv ${D}/.4242.17.tmp "$GROK_AUTH_PATH" && chmod 600 "$GROK_AUTH_PATH" && echo saved > saved.txt` },
      // The token linked out, its outcome kept in the worktree (the turn's TMPDIR goes with the turn).
      { run: `(ln "$GROK_AUTH_PATH" "$TMPDIR/linked" 2>/dev/null && echo linked || echo refused) > link.txt` },
      // Everything else there: another name, the user's own settings, a link, a directory, the token moved away.
      { run: `echo x > ${D}/other.json; echo x >> ${D}/config.toml; ln -s /etc/hosts ${D}/.4243.1.tmp; mkdir ${D}/.4244.1.tmp; mv "$GROK_AUTH_PATH" ${D}/moved.json; true` },
      { reply: "tampered" },
    ],
  }];
  const h = await grokHarness(rules, GROK());
  const user = userGrok(h);
  try {
    const job = await root(h).call("delegate", { target: "grok", model: MODEL, task: "TAMPER", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const home = (grokStarts(h)[0].env.grok as Record<string, string>).GROK_HOME;
    assert.equal((grokStarts(h)[0].env.grok as Record<string, string>).GROK_AUTH_PATH, user.auth, "the tampering below aimed at this scratch login, which the checks then read");
    assert.equal((parseToml(fs.readFileSync(path.join(home, "config.toml"), "utf8")) as Rec).sandbox.profile, "off", "relay's settings are read-only to the agent");
    assert.ok(!fs.existsSync(path.join(home, "managed_config.toml")) && !fs.existsSync(path.join(home, "requirements.toml")), "nothing can be added to the home");
    assert.ok(fs.existsSync(path.join(home, "sessions", "mine.txt")), "the session store is writable");
    assert.ok(fs.lstatSync(path.join(home, "sessions")).isDirectory(), "but cannot itself be swapped for a link");
    assert.ok(!fs.existsSync(path.join(home, "sessions.away")), "or moved away");
    assert.deepEqual(fs.readdirSync(outside), []);
    // The login store: Grok's refresh goes through (its lock, its temp file, the rename onto the token, the chmods) ...
    const worktree = h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree;
    assert.equal(fs.readFileSync(path.join(worktree, "saved.txt"), "utf8").trim(), "saved", "the whole save went through");
    assert.equal(fs.readFileSync(path.join(worktree, "link.txt"), "utf8").trim(), "refused", "the token cannot be hard-linked out of the store");
    assert.equal(fs.readFileSync(user.auth, "utf8"), "refreshed", "the token, replaced by the refresh");
    assert.ok(fs.lstatSync(user.auth).isFile() && (fs.statSync(user.auth).mode & 0o777) === 0o600 && fs.statSync(user.auth).nlink === 1, "a regular file of one name, owner-only: not linked out");
    assert.equal(fs.readFileSync(user.lock, "utf8"), "held", "its lock taken");
    // ... and nothing else does.
    assert.deepEqual(fs.readdirSync(user.dir).sort(), ["auth.json", "auth.json.lock", "config.toml"], "no other name, link or directory appears there, and the token is not moved away");
    assert.equal(fs.readFileSync(user.config, "utf8"), '[sandbox]\nprofile = "strict"\n', "the user's own Grok settings are unchanged");
    // Should the session store be swapped anyway, between turns, the next turn will not run on it.
    fs.rmSync(path.join(home, "sessions"), { recursive: true });
    fs.symlinkSync(outside, path.join(home, "sessions"));
    await root(h).call("resume", { job_id: job.job_id, message: "again" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM turns WHERE node_id = ?", job.job_id)[0].c === 2 && h.sql("SELECT status FROM turns WHERE node_id = ? ORDER BY id DESC", job.job_id)[0].status === "failed", 30000, "second turn refused");
    assert.match(h.sql("SELECT error FROM turns WHERE node_id = ? ORDER BY id DESC", job.job_id)[0].error, /replaced by something other than a directory/);
    assert.equal(grokStarts(h).length, 1, "no second turn ran");
    assert.deepEqual(fs.readdirSync(outside), [], "and nothing was written through the link");
  } finally {
    await h.close();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

onMac("grok: a write job writes only its worktree and continues the same session with session/resume, effort and model on every turn", async () => {
  const rules: Rule[] = [
    { target: "grok", turn: 1, match: task("WRITE1"), steps: [{ write: "out.txt", content: "from grok\n" }, { run: "echo x > ../../../repo/escaped.txt" }, { reply: "wrote it" }] },
    { target: "grok", turn: 2, steps: [{ reply: "second turn" }] },
  ];
  const h = await grokHarness(rules, GROK());
  try {
    const job = await root(h).call("delegate", { target: "grok", model: "grok-4.5", effort: "high", task: "WRITE1", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const node = h.sql("SELECT * FROM nodes WHERE id = ?", job.job_id)[0];
    assert.equal(fs.readFileSync(path.join(node.worktree, "out.txt"), "utf8"), "from grok\n");
    assert.ok(!fs.existsSync(path.join(h.repo, "escaped.txt")), "nothing outside the worktree");
    await root(h).call("resume", { job_id: job.job_id, message: "carry on" });
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "done" && grokStarts(h).length === 2, 30000, "second turn");
    const [first, second] = grokStarts(h);
    assert.equal(second.sessionId, first.sessionId, "the same Grok session");
    assert.equal(second.turn, 2);
    assert.equal(grokRecords(h).filter((r) => r.event === "session")[1].method, "session/resume", "resumed without a replay, as Grok advertises");
    for (const s of [first, second]) {
      assert.equal(s.argv[s.argv.indexOf("-m") + 1], "grok-4.5");
      assert.equal(s.argv[s.argv.indexOf("--reasoning-effort") + 1], "high");
    }
    assert.match(agentLog(h, job.job_id), /# relay: Grok \(experimental\) "1\.0\.62" speaks ACP 1/, "its version, from _meta.agentVersion");
    assert.equal((await root(h).call("result", { job_id: job.job_id })).result.final_message, "second turn");
  } finally {
    await h.close();
  }
});

onMac("grok: a model relay lists but Grok's catalog does not offer (grok-4.7 on 1.0.62's built-in one) is refused before the prompt, not run as Grok's default", async () => {
  // 1.0.62 with `-m grok-4.7` reports grok-4.6 as current and offers grok-4.6 and grok-4.5 (models.availableModels).
  const h = await grokHarness([{ target: "grok", steps: [{ reply: "never" }] }], GROK());
  try {
    const job = await root(h).call("delegate", { target: "grok", model: "grok-4.7", task: "UNOFFERED", mode: "read", background: false });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, /Grok \(experimental\) does not offer the model "grok-4\.7" to this account \(it offers "grok-4\.6", "grok-4\.5"\), so relay stopped it before it did anything/);
    assert.equal(grokStarts(h).length, 0, "no prompt was sent");
  } finally {
    await h.close();
  }
});

onMac("grok: an effort the model's menu lacks, which Grok would run as \"high\" without a word, is refused before the prompt", async () => {
  // This checks the ACP effort handshake. Keep the real sandbox wrapper and kernel check, but
  // isolate it from the boundary battery's production deadlines (covered by the other Grok tests).
  const probeModule = pathToFileURL(path.resolve(import.meta.dirname, "../dist/confine/turn-probe.js")).href;
  const preload = `data:text/javascript,${encodeURIComponent(`
    import { setBoundaryProbeForTests } from ${JSON.stringify(probeModule)};
    setBoundaryProbeForTests(async (mechanism, policy, command, args) => {
      const launch = mechanism.wrap(policy, command, args);
      return { launch, probes: { ok: true, profile: launch.fingerprint, relay: "test", os: process.platform, ms: 0, results: [] } };
    });
  `)}`;
  const h = await grokHarness([{ target: "grok", steps: [{ reply: "never" }] }], GROK(), { NODE_OPTIONS: `--import=${preload}` });
  try {
    const started = await root(h).call("delegate", { target: "grok", model: "grok-4.5", effort: "xhigh", task: "EFFORT", mode: "read", background: false });
    await until(() => !["queued", "running"].includes(h.sql("SELECT status FROM nodes WHERE id = ?", started.job_id)[0].status), 60000, "the effort refusal to settle");
    const job = await root(h).call("status", { id: started.job_id });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, /Grok \(experimental\) reports the reasoning effort "high", not the "xhigh" relay asked for \(it offers "high", "medium", "low" for "grok-4\.5"\), so relay stopped it before it did anything/);
    assert.equal(grokStarts(h).length, 0, "no prompt was sent");
  } finally {
    await h.close();
  }
});

onMac("grok: a turn that names an effort is refused before the prompt when the session reports no effort at all", async () => {
  const h = await grokHarness([{ target: "grok", steps: [{ reply: "never" }] }], GROK(), { STUB_ACP_REPORT: JSON.stringify({ noEffortOption: true }) });
  try {
    const job = await root(h).call("delegate", { target: "grok", model: "grok-4.5", effort: "high", task: "NOEFFORT", mode: "read", background: false });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, /Grok \(experimental\) reports the reasoning effort null, not the "high" relay asked for, so relay stopped it before it did anything/);
    assert.equal(grokStarts(h).length, 0, "no prompt was sent");
  } finally {
    await h.close();
  }
});

onMac("grok: a session that reports another model than the one asked for is stopped before the prompt", async () => {
  const h = await grokHarness([{ target: "grok", steps: [{ reply: "never" }] }], GROK(), { STUB_ACP_REPORT: JSON.stringify({ model: "grok-4.5", pinModel: true }) });
  try {
    const job = await root(h).call("delegate", { target: "grok", model: MODEL, task: "PINNED", mode: "read", background: false });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.match(job.error, /Grok \(experimental\) reports the model "grok-4\.5", not the "grok-4\.6" relay asked for/);
    assert.equal(grokStarts(h).length, 0);
  } finally {
    await h.close();
  }
});

onMac("grok: a job that names no model runs labelled family unknown, and its note says Grok chose the model, not Copilot", async () => {
  const h = await grokHarness([{ target: "grok", steps: [{ reply: "its own choice" }] }], GROK());
  try {
    const job = await root(h).call("delegate", { target: "grok", task: "NOMODEL", mode: "read", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.equal(job.families.relation, "unknown");
    assert.equal(job.families.note, "Grok chose the model (no model named); it reported grok-4.6.");
    assert.match(job.families.summary, /Grok running its own choice \(family unknown\)/);
    assert.deepEqual(grokStarts(h)[0].argv, ["--no-auto-update", "--disable-web-search", "agent", "--no-leader", "--always-approve", "stdio"], "no -m: Grok's own default");
  } finally {
    await h.close();
  }
});

onMac("grok: under the default \"allow\" a job naming \"auto\" or a model relay does not list is refused before Grok starts, naming relay's own list", async () => {
  const h = await grokHarness([{ target: "grok", steps: [{ reply: "never" }] }], GROK());
  try {
    for (const model of ["auto", "grok-code-fast-1"]) {
      const job = await root(h).call("delegate", { target: "grok", model, task: `UNLISTED ${model}`, mode: "read", background: false });
      assert.equal(job.status, "failed", JSON.stringify(job));
      assert.equal(job.error, `relay lets Grok (experimental) run only the models its list names (grok-4.6, grok-4.5, grok-4.7), so it does not launch it with ${JSON.stringify(model)}.`);
      assert.equal(job.families.note, `Grok was asked to run ${JSON.stringify(model)}, which relay's model list does not name.`);
    }
    assert.deepEqual(grokRecords(h), [], "Grok was never started");
  } finally {
    await h.close();
  }
});

onMac("grok: a listed model that a catalog offers (grok-4.7, where a subscription's catalog has it) runs, labelled xAI's", async () => {
  const h = await grokHarness([{ target: "grok", steps: [{ reply: "on grok-4.7" }] }], GROK(), { STUB_ACP_REPORT: JSON.stringify({ catalog: ["grok-4.7", "grok-4.6", "grok-4.5"] }) });
  try {
    const job = await root(h).call("delegate", { target: "grok", model: "grok-4.7", task: "OFFERED", mode: "read", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.equal(job.result.final_message, "on grok-4.7");
    assert.equal(grokStarts(h)[0].model, "grok-4.7");
    assert.equal(job.families.launched, "xai");
    assert.equal(job.families.relation, "cross-family");
  } finally {
    await h.close();
  }
});

onMac("grok: in a read turn without network access, Grok's own save of a refreshed login still goes through the login store, and nothing else is written there", async () => {
  // A read turn has no worktree to keep an outcome in: the store itself shows it.
  const D = '"$(dirname "$GROK_AUTH_PATH")"';
  const rules: Rule[] = [{
    target: "grok", match: task("READSAVE"), steps: [
      { run: `printf held > ${D}/auth.json.lock; (umask 077; printf refreshed > ${D}/.4242.17.tmp) && chmod 600 ${D}/.4242.17.tmp && mv ${D}/.4242.17.tmp "$GROK_AUTH_PATH" && chmod 600 "$GROK_AUTH_PATH"` },
      { run: `echo x > ${D}/other.json; echo x >> ${D}/config.toml; true` },
      { reply: "saved" },
    ],
  }];
  const h = await grokHarness(rules, GROK());
  const user = userGrok(h);
  try {
    const job = await root(h).call("delegate", { target: "grok", model: MODEL, task: "READSAVE", mode: "read", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.match(agentLog(h, job.job_id), /# relay network: off, except relay's proxy to cli-chat-proxy\.grok\.com, auth\.x\.ai/, "the network was off");
    assert.equal(fs.readFileSync(user.auth, "utf8"), "refreshed", "the token, replaced by the refresh");
    assert.ok(fs.lstatSync(user.auth).isFile() && (fs.statSync(user.auth).mode & 0o777) === 0o600 && fs.statSync(user.auth).nlink === 1);
    assert.equal(fs.readFileSync(user.lock, "utf8"), "held", "its lock taken");
    assert.deepEqual(fs.readdirSync(user.dir).sort(), ["auth.json", "auth.json.lock", "config.toml"], "no other name appears there");
    assert.equal(fs.readFileSync(user.config, "utf8"), '[sandbox]\nprofile = "strict"\n', "the user's own Grok settings are unchanged");
  } finally {
    await h.close();
  }
});
