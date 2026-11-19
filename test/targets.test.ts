import assert from "node:assert/strict";
import { test } from "node:test";
import { CREDENTIALS, TARGET_IDS, TARGETS } from "../dist/targets/index.js";
// For its side effect: the test process gets a scratch HOME (see helpers.ts).
import "./helpers.ts";

test("targets: ids and review prefixes are unique, and the registry matches its id list", async () => {
  const ids = TARGETS.map((t) => t.id);
  assert.deepEqual(ids, [...TARGET_IDS]);
  assert.equal(new Set(ids).size, ids.length);
  const prefixes = TARGETS.map((t) => t.reviewPrefix);
  assert.equal(new Set(prefixes).size, prefixes.length);
  for (const p of prefixes) assert.match(p, /^[A-Z]{1,2}$/);
  const { BACKENDS } = await import("../dist/backends/index.js");
  assert.deepEqual(Object.keys(BACKENDS), [...TARGET_IDS], "every target has a backend, and nothing else does");
  for (const t of TARGETS) assert.equal(typeof BACKENDS[t.id].start, "function", `${t.id}'s backend starts its turns`);
});

test("targets: the credentials scrubbed from every agent are every vendor's, and nothing else", () => {
  // CODEX_ACCESS_TOKEN: Codex's workspace access token (codex-rs login/src/auth/manager.rs, CODEX_ACCESS_TOKEN_ENV_VAR).
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "COPILOT_GITHUB_TOKEN"];
  for (const k of keys) assert.ok(CREDENTIALS.test(k), k);
  // GitHub tokens other tools use are Copilot's to lose only (its loginEnv), not every agent's.
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_SKIP_PROMPT", "ANTHROPIC_BASE_URL", "OPENAI_API_KEYS", "MY_OPENAI_API_KEY", "PATH", "GH_TOKEN", "GITHUB_TOKEN"]) assert.ok(!CREDENTIALS.test(k), k);
});

test("targets: discussion and review sides are labelled by target id, with a caller of unknown family as a third label", async () => {
  const { CALLER_LABEL, CALLER_PREFIX, inSideOrder, sideOfItem, sidePrefix } = await import("../dist/targets/index.js");
  const { buildConsensus, parseItems } = await import("../dist/modes/review.js");
  const { reviewDiscussionRules } = await import("../dist/core/prompts.js");
  assert.ok(!TARGETS.some((t) => t.reviewPrefix === CALLER_PREFIX), "no target takes the unknown caller's prefix");
  assert.equal(sidePrefix(CALLER_LABEL), "R");
  assert.equal(sideOfItem("R4"), CALLER_LABEL);
  assert.equal(sideOfItem("X12"), "codex");
  assert.equal(sideOfItem("C1"), "claude");
  assert.equal(sideOfItem("Q1"), null);
  assert.deepEqual(inSideOrder(["codex", "claude"]), ["claude", "codex"]);
  assert.deepEqual(inSideOrder([CALLER_LABEL, "codex"]), ["codex", CALLER_LABEL]);

  // Between Claude and Codex the rules read as they always have, whichever side called.
  const twoFamilies = [
    "- Items are identified by id: C<n> came from the Claude reviewer, X<n> from the Codex reviewer. Refer to items by id.",
    "- When you write AGREE, and on your final turn whatever marker you use, put a fenced JSON block immediately before the marker line listing every original item id exactly once, with the verdict and coverage you hold the two reviews to reach together:",
    "    ```json",
    '    {"verdict":"fail","coverage":{"complete":false,"examined":["…"],"not_examined":["…"]},"consensus":[{"ids":["C1","X3"],"severity":"major","confidence":"high","status":"agreed","summary":"…","file":"…","lines":[1,2],"location":"…","evidence":"…","fix":"…"}]}',
    "    ```",
    '  status is "agreed" (both of you hold that it is a real issue at that severity) or "dropped" (you hold that it should not be raised). Merge duplicates into one entry with several ids. An item is agreed or dropped only where both your closing blocks give it that status and the same severity (an entry without a severity holds the one its items have in the reviews); anything else is unresolved, with each block\'s position.',
    `  verdict is "pass" if nothing agreed should hold the work back, "fail" if something should, "unknown" if you cannot tell. coverage is what the two reviews examined between them; complete is true only if together they examined everything under review. A pass over coverage that is not declared complete is recorded as unknown. The review's verdict is the one both your closing blocks reach; if they differ it is unresolved. Anything both reviews declared not examined counts against complete unless your closing coverage lists it under examined, in the same words.`,
  ].join("\n");
  assert.equal(reviewDiscussionRules(["claude", "codex"]), twoFamilies);
  assert.equal(reviewDiscussionRules(["codex", "claude"]), twoFamilies);
  assert.match(reviewDiscussionRules([CALLER_LABEL, "codex"]), /X<n> came from the Codex reviewer, R<n> from the calling reviewer/);

  // A third label works through items, raised_by and an unresolved join.
  const mine = parseItems(CALLER_LABEL, '```json\n{"items": [{"n": 1, "severity": "major", "summary": "a"}]}\n```');
  const theirs = parseItems("codex", '```json\n{"items": [{"n": 1, "severity": "minor", "summary": "b"}]}\n```');
  assert.deepEqual([...mine, ...theirs].map((i) => i.id), ["R1", "X1"]);
  const out = buildConsensus([...theirs, ...mine], {
    codex: [{ ids: ["X1", "R1"], status: "agreed", severity: "minor" }],
    [CALLER_LABEL]: [{ ids: ["R1"], status: "agreed", severity: "minor" }, { ids: ["X1"], status: "dropped" }],
  });
  assert.deepEqual(out.map((e) => [e.ids, e.status, e.raised_by]), [[["X1"], "unresolved", ["codex"]], [["R1"], "agreed", [CALLER_LABEL]]]);
  assert.deepEqual(out[0].positions, { codex: { status: "agreed", severity: "minor", ids: ["X1", "R1"] }, [CALLER_LABEL]: { status: "dropped" } });
  const merged = [{ ids: ["X1", "R1"], status: "agreed" }];
  const agreed = buildConsensus([...theirs, ...mine], { codex: merged, [CALLER_LABEL]: merged });
  assert.deepEqual(agreed[0].raised_by, ["codex", CALLER_LABEL]);
});

test("targets: resolution crosses vendors only, refuses an unknown caller, and asks for a choice it cannot make", async () => {
  const { resolveTarget } = await import("../dist/targets/index.js");
  // Three families, the third switched off by default as new targets are.
  const registry = [
    { id: "claude", vendor: "anthropic", name: "Claude", enabledByDefault: true },
    { id: "codex", vendor: "openai", name: "Codex", enabledByDefault: true },
    { id: "gemini", vendor: "google", name: "Gemini", enabledByDefault: false },
  ];
  const r = (caller: string | null, requested: string | undefined, cfg = {}, existing = false) => resolveTarget(caller, requested, { same_family: "refuse", ...cfg }, { registry, existing });
  // The two that ship: as before.
  assert.deepEqual(r("claude", undefined), { target: "codex" });
  assert.deepEqual(r("codex", undefined), { target: "claude" });
  assert.match(r("claude", "claude").reason, /reaches only the other family.*You are a Claude agent.*use your own subagents, and use relay for Codex\./);
  // An unknown caller is refused, named target or not.
  for (const requested of [undefined, "codex", "claude"]) assert.match(r(null, requested).reason, /cannot tell which agent it is running inside/);
  assert.match(r("cursor", "codex").reason, /cannot tell which agent/);
  // Off unless switched on; a session that already exists may still be continued.
  assert.match(r("claude", "gemini").reason, /Gemini is switched off.*targets\.gemini\.enabled.*Use Codex instead/);
  assert.deepEqual(r("claude", "gemini", {}, true), { target: "gemini" });
  // same_family "allow": a caller may name its own family; nothing reaches it by default.
  const allow = { same_family: "allow" as const };
  assert.match(r("claude", "claude").reason, /"same_family": "allow"/, "the refusal says what the user can change");
  assert.deepEqual(r("claude", "claude", allow), { target: "claude" });
  assert.deepEqual(r("claude", undefined, allow), { target: "codex" }, "left out, the target is still another family");
  assert.match(r("claude", undefined, { ...allow, targets: { codex: { enabled: false } } }).reason, /no agent of another family is switched on/, "never the caller's own family by default");
  assert.match(r("claude", undefined, { ...allow, default_target: { claude: "claude" } }).reason, /cannot reach/, "nor as a default target");
  assert.deepEqual(r(null, "claude", allow), { target: "claude" }, "unknown caller may name a target under allow");
  // Going on with a session that exists is not a family matter.
  assert.deepEqual(r("claude", "claude", {}, true), { target: "claude" });
  assert.match(r(null, "codex", {}, true).reason, /cannot tell which agent/, "but the caller's family must still be known");
  assert.match(r("claude", "grok").reason, /no agent called "grok"/);
  const three = { targets: { gemini: { enabled: true } } };
  assert.deepEqual(r("claude", "gemini", three), { target: "gemini" });
  // Two other families and no default: name one.
  assert.match(r("claude", undefined, three).reason, /several agents of other families are available \(codex, gemini\).*default_target\.claude/);
  assert.match(r("claude", "claude", three).reason, /use relay for Codex or Gemini\./);
  assert.deepEqual(r("claude", undefined, { ...three, default_target: { claude: "gemini" } }), { target: "gemini" });
  assert.match(r("gemini", undefined, { ...three, default_target: { claude: "gemini" } }).reason, /several/, "a default is per caller");
  // A default that cannot be used is refused, not passed over.
  assert.match(r("claude", undefined, { ...three, default_target: { claude: "claude" } }).reason, /default_target\.claude .*names claude, which a Claude agent cannot reach/);
  assert.match(r("claude", undefined, { default_target: { claude: "gemini" } }).reason, /names gemini, which is switched off/);
  // With only one's own family switched on, there is nothing to reach.
  assert.match(r("claude", undefined, { targets: { codex: { enabled: false } } }).reason, /no agent of another family is switched on/);
  // The rule compares vendors: a second target of the caller's vendor is its own family too.
  const twoOpenAI = [...registry, { id: "codex2", vendor: "openai", name: "Codex Two", enabledByDefault: true }];
  assert.match(resolveTarget("codex", "codex2", { same_family: "refuse" }, { registry: twoOpenAI }).reason, /You are a Codex agent/);
  assert.deepEqual(resolveTarget("codex2", undefined, {}, { registry: twoOpenAI }), { target: "claude" });
});

test("hosts: each host's adapter is generated, and relay's Claude skills may be loaded by the model", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { HOSTS, HOST_IDS } = await import("../dist/hosts/index.js");
  assert.deepEqual(HOSTS.map((h) => h.id), [...HOST_IDS]);
  for (const h of HOSTS) assert.ok(TARGET_IDS.includes(h.target), `${h.id} registers as a known target's family`);
  const adapters = path.resolve(import.meta.dirname, "..", "adapters");
  for (const h of HOSTS.filter((h) => h.adapter)) assert.ok(fs.existsSync(path.join(adapters, h.adapter!.dir, "relay")), `${h.id}'s adapter is checked in`);
  const skills = path.join(adapters, "claude", "relay", "skills");
  for (const name of fs.readdirSync(skills)) {
    const text = fs.readFileSync(path.join(skills, name, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, /disable-model-invocation/, name);
    assert.doesNotMatch(text, /the other family's/, `${name} does not assume two families`);
  }
});

test("targets: admission refuses a call its target cannot honour, and every target says what it can", async () => {
  const { incapable } = await import("../dist/targets/index.js");
  for (const t of TARGETS) {
    assert.ok(["verified", "relay-enforced", "none"].includes(t.capabilities.confinement), t.id);
    assert.equal(typeof t.qualified, "boolean", t.id);
  }
  const base = TARGETS.find((t) => t.id === "codex")!;
  const all = { mode: "write" as const, network: false, writePaths: true, continues: true };
  assert.equal(incapable(base, all), null, "Codex honours everything relay asks of it");
  const def = (c: Record<string, unknown>) => ({ ...base, name: "Probe", capabilities: { ...base.capabilities, ...c } });
  assert.match(incapable(def({ confinement: "none" }), all)!, /no confinement relay can enforce or verify/);
  assert.match(incapable(def({ readOnly: false }), { ...all, mode: "read" })!, /cannot keep Probe read-only/);
  assert.equal(incapable(def({ readOnly: false }), all), null, "a write job does not need read-only enforcement");
  assert.match(incapable(def({ networkOff: false, confinement: "relay-enforced" }), all)!, /cannot keep Probe off the network yet.*network proxy.*grant: \{ network: true \}/);
  assert.equal(incapable(def({ networkOff: false }), { ...all, network: true }), null, "with network granted, network-off enforcement is not needed");
  assert.match(incapable(def({ writeRoots: false }), all)!, /grant\.write_paths cannot be honoured/);
  assert.match(incapable(def({ resume: false }), all)!, /cannot be continued/);
  assert.equal(incapable(def({ resume: false }), { ...all, continues: false }), null);
});

test("targets: a relay-enforced target that promises network-off enforcement declares the exact hosts its proxy admits", async () => {
  const { allowlistHost } = await import("../dist/confine/proxy.js");
  for (const t of TARGETS) {
    if (t.capabilities.confinement !== "relay-enforced") {
      assert.equal(t.apiHosts, undefined, `${t.id}: only relay's proxy reads apiHosts`);
      continue;
    }
    if (!t.capabilities.networkOff) continue;
    assert.ok(t.apiHosts?.length, `${t.id} keeps its turns off the network, so it must name the hosts relay's proxy admits`);
    for (const h of t.apiHosts!) assert.equal(allowlistHost(h), h, `${t.id}: ${h} is an exact, lower-case host name`);
    assert.equal(new Set(t.apiHosts).size, t.apiHosts!.length, `${t.id}: no host twice`);
  }
});

test("docs: doctor's confinement summary and the security model name exactly the hosts Copilot's target declares, and its downgrades (consolidation E15)", async () => {
  // The summary (confine/index.ts) is the text doctor prints and the source docs/security-model.md follows; the
  // hosts themselves are the target's (targets/copilot.ts). Neither may drift from the other.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { confinementSummary } = await import("../dist/confine/index.js");
  const { COPILOT_API_HOSTS } = await import("../dist/targets/copilot.js");
  const readme = fs.readFileSync(path.resolve(import.meta.dirname, "..", "docs", "security-model.md"), "utf8");
  const off = confinementSummary().enforces.find((l: string) => l.startsWith("network off"))!;
  const named = (text: string) => [...text.matchAll(/api\.[a-z.]*github(copilot)?\.com/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(named(off))].sort(), [...COPILOT_API_HOSTS].sort(), off);
  const section = readme.slice(readme.indexOf("- **Relay-enforced confinement.**"), readme.indexOf("- **How relay knows the confinement is in force.**"));
  assert.deepEqual([...new Set(named(section))].sort(), [...COPILOT_API_HOSTS].sort(), "the security model's relay-enforced section names the same hosts");
  for (const downgrade of [/keychain/, /certificate[- ]trust daemons/]) {
    assert.match(confinementSummary().doesNot.join("\n"), downgrade);
    assert.match(section, downgrade);
  }
  // Every network-off claim names the trust daemons' exception, since Copilot takes that downgrade
  // (review r_7feaed80 C2), and what api.github.com admits (C1).
  assert.match(off, /certificate-trust downgrade \(Copilot\) can have the system's trust daemons fetch URLs it supplies, past the proxy/, off);
  assert.match(section, /The one exception is a harness whose profile takes the certificate-trust downgrade \(Copilot\)/);
  const creds = confinementSummary().doesNot.find((l: string) => l.startsWith("protect credentials"))!;
  for (const text of [creds, section]) assert.match(text, /`?api\.github\.com`?, GitHub's whole REST API/);
});

test("targets: a harness of several vendors' models is judged by the model it would run", async () => {
  const { resolveTarget, vendorFor } = await import("../dist/targets/index.js");
  const models = { "claude-x": "anthropic", "gpt-x": "openai", "gemini-x": "google" } as const;
  const registry = [
    { id: "claude", vendor: "anthropic", name: "Claude", enabledByDefault: true },
    { id: "codex", vendor: "openai", name: "Codex", enabledByDefault: true },
    { id: "multi", vendor: null, name: "Multi", enabledByDefault: false, models },
  ];
  const on = { targets: { multi: { enabled: true } } };
  const r = (caller: string, requested: string | undefined, cfg: Record<string, unknown> = on, opts: Record<string, unknown> = {}) =>
    resolveTarget(caller, requested, { same_family: "refuse", ...cfg }, { registry, ...opts });
  assert.equal(vendorFor(registry[2], "gpt-x"), "openai");
  for (const m of [undefined, null, "", "auto", "toString", "constructor", "GPT-X"]) assert.equal(vendorFor(registry[2], m), null, String(m));
  assert.equal(vendorFor(registry[0], undefined), "anthropic", "a single-vendor target needs no model");

  // A model is required, must be one relay knows, and must not be the caller's own family.
  assert.match(r("claude", "multi").reason, /runs models of several families.*name it with model \(for example gpt-x, gemini-x\)/);
  assert.match(r("claude", "multi", on, { model: "auto" }).reason, /does not know which family the model "auto" is.*never an automatic choice/);
  assert.match(r("claude", "multi", on, { model: "claude-x" }).reason, /"claude-x" is Anthropic's, your own family.*for example gpt-x, gemini-x.*same_family/);
  assert.deepEqual(r("claude", "multi", { ...on, same_family: "allow" }, { model: "claude-x" }), { target: "multi", model: "claude-x" }, "named, with the opt-in");
  assert.match(r("claude", undefined, { targets: { multi: { enabled: true, default_model: "claude-x" } }, same_family: "allow", default_target: { claude: "multi" } }).reason, /your own family|your own family\'s/, "a default with an own-family model is refused even with the opt-in");
  assert.deepEqual(r("claude", "multi", on, { model: "gpt-x" }), { target: "multi", model: "gpt-x" });
  // The same model is the Codex caller's own family.
  assert.match(r("codex", "multi", on, { model: "gpt-x" }).reason, /"gpt-x" is OpenAI's, your own family/);
  assert.deepEqual(r("codex", "multi", on, { model: "claude-x" }), { target: "multi", model: "claude-x" });
  // A default model counts as the model asked for; the call's own model wins over it.
  const withDefault = { targets: { multi: { enabled: true, default_model: "gemini-x" } } };
  assert.deepEqual(r("claude", "multi", withDefault), { target: "multi", model: "gemini-x" });
  assert.match(r("claude", "multi", withDefault, { model: "claude-x" }).reason, /your own family/);
  // Without a target named, a harness counts as another family only through the model it would run.
  assert.deepEqual(r("claude", undefined), { target: "codex" }, "no model: Multi is no candidate, so Codex is the only one");
  assert.match(r("claude", undefined, withDefault).reason, /several agents of other families are available \(codex, multi\)/);
  assert.deepEqual(r("claude", undefined, { ...withDefault, default_target: { claude: "multi" } }), { target: "multi", model: "gemini-x" });
  assert.match(r("claude", undefined, { ...on, default_target: { claude: "multi" } }).reason, /default_target\.claude .*a call that names no target cannot use/);
  // A caller on such a harness is of its model's family; with none known, it is refused.
  assert.deepEqual(r("multi", "claude", on, { callerVendor: "openai" }), { target: "claude" });
  assert.match(r("multi", "codex", on, { callerVendor: "openai" }).reason, /reaches only the other family/);
  assert.match(r("multi", "claude", on, { callerVendor: null }).reason, /cannot tell which agent/);
  assert.match(r("multi", "claude").reason, /cannot tell which agent/, "its vendor is no family by itself");
});

test("targets: Copilot is a harness of several families, off by default, experimental, and confined by relay", async () => {
  const { COPILOT_MODELS } = await import("../dist/targets/copilot.js");
  const { VENDOR_NAMES, vendorFor } = await import("../dist/targets/index.js");
  const copilot = TARGETS.find((t) => t.id === "copilot")!;
  assert.equal(copilot.vendor, null);
  assert.equal(copilot.enabledByDefault, false);
  assert.equal(copilot.qualified, false);
  const { validateConfig } = await import("../dist/core/config.js");
  assert.deepEqual(validateConfig({ targets: { copilot: { experimental: true } } }, "x"), { targets: { copilot: { experimental: true } } });
  assert.throws(() => validateConfig({ targets: { copilot: { experimental: "yes" } } }, "x"), /experimental/);
  assert.equal(copilot.capabilities.confinement, "relay-enforced");
  assert.equal(copilot.capabilities.escalation, false, "nothing approved lifts relay's sandbox");
  // Off the network it reaches exactly the hosts seen working in a signed-in run, and no telemetry.
  const { COPILOT_API_HOSTS } = await import("../dist/targets/copilot.js");
  assert.equal(copilot.capabilities.networkOff, true);
  assert.deepEqual([...copilot.apiHosts!], ["api.github.com", "api.individual.githubcopilot.com"]);
  assert.equal(copilot.apiHosts, COPILOT_API_HOSTS);
  assert.ok(Object.isFrozen(COPILOT_API_HOSTS), "the list cannot be changed at run time");
  assert.ok(copilot.loginEnv!.test("GH_HOST"), "GH_HOST would choose another host's stored login");
  assert.ok(!copilot.clientNames.test("copilot") && !copilot.clientNames.test(""), "never taken for a root session's host");
  assert.ok(copilot.loginEnv!.test("GH_TOKEN") && copilot.loginEnv!.test("GITHUB_TOKEN"));
  const families = new Set(Object.values(COPILOT_MODELS));
  for (const f of families) assert.ok(f in VENDOR_NAMES, f);
  assert.ok(families.has("anthropic") && families.has("openai"), "it reaches both shipped families' models, so each caller has something to reach");
  for (const m of ["auto", "", "default"]) assert.equal(vendorFor(copilot, m), null, `${m} is no model relay can name the family of`);
  for (const [m, f] of Object.entries(COPILOT_MODELS)) assert.equal(vendorFor(copilot, m), f);
  assert.throws(() => { (COPILOT_MODELS as Record<string, string>)["sneaky"] = "openai"; }, "the map cannot be changed at run time");
});

test("family norm: relay fills the gaps between families; one's own family is for one's own subagents first, through relay only when the user wants it", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { crossFamily } = await import("../dist/core/prompts.js");
  const { withDefaults } = await import("../dist/core/config.js");
  // A launched Claude agent has no subagents (relay removes its Task tools), so under "refuse" it does that work itself; a Codex agent has them.
  assert.match(crossFamily("claude", withDefaults({ same_family: "refuse" })), /reach another family of agent only.*You have no subagents of your own in this turn, so do the work of a helper of your own kind yourself\.$/);
  assert.match(crossFamily("codex", withDefaults({ same_family: "refuse" })), /reach another family of agent only.*use your own subagents\.$/);
  assert.match(crossFamily("claude", withDefaults({ same_family: "allow" })), /no subagents of your own in this turn/);

  // What a root session's tools say, under each setting.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-norm-"));
  const saved = { home: process.env.RELAY_HOME, config: process.env.RELAY_CONFIG };
  const texts = async (cfg: Record<string, unknown>) => {
    const file = path.join(tmp, `${Object.keys(cfg).length}.json`);
    fs.writeFileSync(file, JSON.stringify(cfg));
    process.env.RELAY_HOME = tmp;
    process.env.RELAY_CONFIG = file;
    const { relayServer } = await import("../dist/mcp/server.js");
    const ops = await import("../dist/core/ops.js");
    const server = relayServer(ops.newInstance({ kind: "root" }, tmp, "claude"));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-code", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const delegate = (await client.listTools()).tools.find((t) => t.name === "delegate")!;
    const out = { instructions: client.getInstructions() ?? "", target: String((delegate.inputSchema.properties as Record<string, { description?: string }>).target.description) };
    await client.close();
    return out;
  };
  try {
    const refuse = await texts({ same_family: "refuse" });
    assert.match(refuse.instructions, /fills the gaps between families\. For more Claude agents, use your own subagents: relay's config \(same_family "refuse"\)/);
    assert.match(refuse.target, /same_family "refuse"/);
    const allow = await texts({ same_family: "allow" });
    assert.match(allow.instructions, /Name claude through relay only when the user asks for that/);
    assert.match(allow.target, /use your own subagents/);
  } finally {
    for (const [k, v] of [["RELAY_HOME", saved.home], ["RELAY_CONFIG", saved.config]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // The generated adapters say the same.
  const adapters = path.resolve(import.meta.dirname, "..", "adapters");
  for (const f of ["claude/relay/skills/delegate/SKILL.md", "codex/relay/skills/relay-delegate/SKILL.md"]) {
    assert.match(fs.readFileSync(path.join(adapters, f), "utf8"), /Relay fills the gaps between families: for more agents of your own family use your own subagents/, f);
  }
  assert.match(fs.readFileSync(path.join(adapters, "codex", "AGENTS.snippet.md"), "utf8"), /fills the gaps between families\. For more Codex agents use your own subagents/);
});

test("targets (claude): a generic tool request shows its whole input, so that what is allowed is what was shown", async () => {
  const { claude } = await import("../dist/targets/claude.js");
  const tool = claude.approvals.channel === "relay-tool" ? claude.approvals.tool : null;
  assert.ok(tool);
  // Past the first 300 characters of the input is where a harmful argument could hide.
  const input = { server: "x".repeat(400), query: "DROP TABLE users;\nSELECT 1" };
  const ask = tool.toAsk({ tool_name: "mcp__db__run", input });
  assert.equal(ask.kind, "tool");
  assert.equal(ask.summary, `mcp__db__run ${JSON.stringify(input)}`);
  assert.match(ask.summary, /DROP TABLE users;\\nSELECT 1/);
  // An allowed call goes ahead with exactly that input.
  assert.deepEqual(tool.reply({ tool_name: "mcp__db__run", input }, { allow: true }), { behavior: "allow", updatedInput: input });
});
