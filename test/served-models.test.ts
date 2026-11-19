import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promptModels } from "../dist/backends/acp.js";
import { prepareLaunch } from "../dist/confine/index.js";
import { SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
import { setBoundaryProbeForTests, type BoundaryProbe } from "../dist/confine/turn-probe.js";
import { harness, scratchOnly } from "./helpers.ts";
import { selectEnvironment } from "../dist/core/env-policy.js";

const REAL_PROBES: BoundaryProbe = (mechanism, policy, command, args) => prepareLaunch(mechanism, policy, scratchOnly(command, "harness"), args);
/** The ACP stub agent, as a scratch copy, so that no probe aims beside the checkout's files. */
const STUB_ACP = (() => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-stub-")));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const stubs = path.resolve(import.meta.dirname, "stubs");
  const href = (p: string) => JSON.stringify(pathToFileURL(path.join(stubs, p)).href);
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  const bin = path.join(dir, "stub-acp");
  fs.writeFileSync(bin, `#!/usr/bin/env node\nimport { main } from ${href("stub-agent.mjs")};\nimport acp from ${href("targets/acp.mjs")};\nawait main(acp);\n`, { mode: 0o755 });
  return scratchOnly(bin, "harness");
})();
const onMac = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC) ? test : test.skip;
const GPT = "gpt-6.1-sol";
const CLAUDE = "claude-sonnet-5.5";

test("acp: promptModels reads the models Gemini CLI says answered from its prompt response, in order, and nothing from anything else", () => {
  // The shape gemini-cli v0.64.0 builds (packages/cli/src/acp/acpSession.ts, buildPromptResponse).
  const response = {
    stopReason: "end_turn",
    usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
    _meta: { quota: {
      token_count: { input_tokens: 300, output_tokens: 40 },
      model_usage: [
        { model: "gemini-3.8-flash", token_count: { input_tokens: 100, output_tokens: 10 } },
        { model: "gemini-3.1-pro-preview", token_count: { input_tokens: 200, output_tokens: 30 } },
      ],
    } },
  };
  assert.deepEqual(promptModels(response), ["gemini-3.8-flash", "gemini-3.1-pro-preview"]);
  assert.deepEqual(promptModels({ _meta: { quota: { model_usage: [{ model: "a" }, { model: "b" }, { model: "a" }] } } }), ["a", "b"]);
  for (const junk of [null, undefined, "x", {}, { _meta: null }, { _meta: { quota: { model_usage: "gemini" } } }, { _meta: { quota: { model_usage: [null, {}, { model: 3 }, { model: " " }] } } }, { stopReason: "end_turn", usage: {} }]) {
    assert.deepEqual(promptModels(junk), [], JSON.stringify(junk));
  }
});

onMac("acp: models a harness reports, in its prompt response (Gemini's _meta) or mid-turn, are recorded and label the item; only one other than a pinned model is a switch, and only another family's stops a turn under refuse (design-family-steering.md §2.1, §2.9)", async () => {
  const h = await harness();
  const saved = { home: process.env.HOME, relay: process.env.RELAY_HOME, scenario: process.env.STUB_SCENARIO, report: process.env.STUB_ACP_REPORT };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-served-")));
  try {
    // The registry in-process, so that the turn's model reports reach the item's labels as a live turn's do.
    process.env.RELAY_HOME = h.home;
    const { createRun, insertNode, getNode } = await import("../dist/core/db.js");
    const { DEFAULT_CONFIG, withDefaults } = await import("../dist/core/config.js");
    const { newInstance, callerVendor } = await import("../dist/core/caller.js");
    const f = await import("../dist/core/families.js");
    const { targetDef } = await import("../dist/targets/index.js");
    const { startAcpTurn, genericApproval: normalizeApproval } = await import("../dist/backends/acp.js");
    const cfg = withDefaults({});
    const run = createRun(h.repo, cfg, "served-root");
    const caller = newInstance({ kind: "root" }, h.repo, "claude");
    const target = targetDef("copilot");
    setBoundaryProbeForTests(REAL_PROBES);
    process.env.HOME = path.join(root, "home");
    fs.mkdirSync(process.env.HOME);
    let n = 0;
    /** One turn: `served` is what the prompt's response names, `steps` what the agent does (a step's hook can report a model mid-turn). */
    const turn = async (o: { model?: string; served?: string[]; steps?: unknown[]; same_family?: "allow" | "refuse"; hook?: (r: unknown) => string[] }) => {
      if (o.served) process.env.STUB_ACP_REPORT = JSON.stringify({ served: o.served });
      else delete process.env.STUB_ACP_REPORT;
      const id = `served-${++n}`;
      fs.writeFileSync(path.join(root, `scenario${n}.json`), JSON.stringify({ rules: [{ steps: o.steps ?? [{ reply: "answered" }] }] }));
      process.env.STUB_SCENARIO = path.join(root, `scenario${n}.json`);
      const node = insertNode({ id, run_id: run, kind: "job", target: "copilot", task: "served", cwd: h.repo, mode: "read", depth: 1, model: o.model ?? null });
      f.recordStart(node.id, caller, {}, "copilot", o.model ?? null, cfg);
      const [dir, state] = [`t${n}`, `state${n}`].map((d) => path.join(root, d));
      for (const d of [dir, state]) fs.mkdirSync(d, { mode: 0o700 });
      const profile = {
        args: (_: unknown, model: string | undefined) => (model ? ["--acp", "--model", model] : ["--acp"]), scrub: () => false, login: { how: "", verify: () => null }, normalizeApproval,
        // The stub keeps its session where a harness keeps its state.
        prepareState: () => ({ stateDirs: [], persistent: { root: state, writable: ["session-state"] }, env: { COPILOT_HOME: state }, keychain: false }),
        ...(o.hook ? { servedModels: o.hook } : {}),
      };
      const spec = {
        target, prompt: "go", cwd: dir, access: "read", relay: null, dir, logPath: path.join(dir, "agent.log"), model: o.model,
        config: { ...DEFAULT_CONFIG, same_family: o.same_family ?? "allow", child_network: true, allow_temp_home: true,
          child_env: { pass: ["STUB_DIR", "STUB_SCENARIO", "STUB_ACP_REPORT"] },
          targets: { ...DEFAULT_CONFIG.targets, copilot: { enabled: true, experimental: true, bin: STUB_ACP } } },
        markers: { runId: run, nodeId: id, depth: 1 },
        onServed: (model: string | null) => f.recordServed(id, target, model),
      };
      // Supply a synthetic root. Reports are structured controls, never a bare model name
      // released as an environment value that must then be redacted from the model assertions.
      const selected = selectEnvironment("copilot", spec.config as never, {
        PATH: process.env.PATH, HOME: process.env.HOME, STUB_DIR: h.env.STUB_DIR,
        STUB_SCENARIO: process.env.STUB_SCENARIO, STUB_ACP_REPORT: process.env.STUB_ACP_REPORT,
      });
      const r = await (await startAcpTurn({ ...spec, environment: selected.env, environmentReleased: selected.releasedNames } as never, profile)).done;
      const after = getNode(id)!;
      return { r, log: fs.readFileSync(spec.logPath, "utf8"), families: f.familiesOf(after), served: JSON.parse(after.params_json ?? "{}").served_models as string[], routing: callerVendor(newInstance({ kind: "child", runId: run, nodeId: id } as never, h.repo)) };
    };

    // The model relay pinned answered: recorded, logged, labelled, no warning.
    const same = await turn({ model: GPT, served: [GPT], hook: promptModels });
    assert.equal(same.r.status, "ok", `${same.r.error}\n${same.log}`);
    assert.equal(same.r.warnings, undefined);
    assert.match(same.log, /reports "gpt-6\.1-sol" answered this turn \(in its prompt response\)/);
    assert.equal(same.families.launched, "openai");
    assert.equal(same.served.at(-1), GPT);
    assert.equal(same.routing, "openai");

    // Another family's model answered too: a switch. Under "allow" the turn goes on with a warning,
    // relabelled, and routed by its latest report (§2.9); under "refuse" it is stopped. Recorded either way.
    const mixed = await turn({ model: GPT, served: [GPT, CLAUDE], hook: promptModels });
    assert.equal(mixed.r.status, "ok", `${mixed.r.error}\n${mixed.log}`);
    assert.match((mixed.r.warnings ?? []).join(" "), /changed its model in the middle of the turn to "claude-sonnet-5\.5" \(Anthropic's\), from "gpt-6\.1-sol"/);
    assert.match(mixed.log, /reports "gpt-6\.1-sol", then "claude-sonnet-5\.5" answered this turn/);
    assert.equal(mixed.families.launched, "unknown");
    assert.deepEqual(mixed.served, [GPT, CLAUDE]);
    assert.equal(mixed.routing, "anthropic");
    const strict = await turn({ model: GPT, served: [CLAUDE], same_family: "refuse", hook: promptModels });
    assert.equal(strict.r.status, "failed");
    assert.match(strict.r.error ?? "", /changed its model mid-turn to "claude-sonnet-5\.5", from the "gpt-6\.1-sol" relay asked for, so relay stopped it/);
    assert.equal(strict.served.at(-1), CLAUDE);
    assert.equal(strict.families.launched, "unknown");

    // Under "auto" what answered is what auto chose: recorded, no warning, and the item and its
    // agent stay unknown even though the model is a listed one (§2.9).
    const auto = await turn({ model: "auto", served: [GPT], hook: promptModels });
    assert.equal(auto.r.status, "ok", `${auto.r.error}\n${auto.log}`);
    assert.equal(auto.r.warnings, undefined);
    assert.equal(auto.served.at(-1), GPT);
    assert.equal(auto.families.launched, "unknown");
    assert.equal(auto.routing, null);

    // Without the hook the driver reads nothing from the response (Copilot reports its model in the session).
    const plain = await turn({ model: GPT, served: [CLAUDE] });
    assert.equal(plain.r.status, "ok");
    assert.ok(!plain.served.includes(CLAUDE));
    assert.doesNotMatch(plain.log, /in its prompt response/);
    assert.equal(plain.families.launched, "openai");

    // The session's own mid-turn reports follow the same rule (coordinator decision, 2026-10-17): under
    // "auto" or no model, a concrete model reported mid-turn is what auto chose, not a switch.
    const midTurn = (model: string) => [{ hook: { switchModel: model, currentModelUpdate: true, awaitModel: true } }, { reply: "carried on" }];
    for (const model of ["auto", undefined]) {
      const chosen = await turn({ model, steps: midTurn(GPT) });
      assert.equal(chosen.r.status, "ok", `${chosen.r.error}\n${chosen.log}`);
      assert.equal(chosen.r.warnings, undefined, `no "changed its model" note under ${model ?? "no model"}`);
      assert.equal(chosen.served.at(-1), GPT);
      assert.equal(chosen.families.launched, "unknown");
      assert.equal(chosen.routing, null);
    }

    // A switch within the pinned model's family goes on under "refuse" too, with a note (coordinator
    // decision, 2026-10-17): the same_family policy is not at stake. Through either report.
    for (const how of ["session", "response"] as const) {
      const within = how === "session"
        ? await turn({ model: GPT, steps: midTurn("gpt-5.4"), same_family: "refuse" })
        : await turn({ model: GPT, served: [GPT, "gpt-5.4"], same_family: "refuse", hook: promptModels });
      assert.equal(within.r.status, "ok", `${how}: ${within.r.error}\n${within.log}`);
      assert.match((within.r.warnings ?? []).join(" "), /changed its model in the middle of the turn to "gpt-5\.4", from "gpt-6\.1-sol" \(switched within OpenAI; same_family policy unaffected\)/, how);
      assert.deepEqual(within.served, [GPT, "gpt-5.4"]);
      assert.equal(within.families.launched, "openai");
      assert.equal(within.routing, "openai");
    }
    // Several models within the family (a helper call beside the main one): one note for the turn, naming them in order.
    for (const same_family of ["allow", "refuse"] as const) {
      const helpers = await turn({ model: GPT, served: [GPT, "gpt-5.4", "gpt-5.3-codex"], same_family, hook: promptModels });
      assert.equal(helpers.r.status, "ok", `${same_family}: ${helpers.r.error}`);
      assert.equal(helpers.r.warnings?.length, 1, `${same_family}: ${JSON.stringify(helpers.r.warnings)}`);
      assert.match(helpers.r.warnings![0], /to "gpt-5\.4", then "gpt-5\.3-codex", from "gpt-6\.1-sol" \(switched within OpenAI; same_family policy unaffected\)/);
      assert.deepEqual(helpers.served, [GPT, "gpt-5.4", "gpt-5.3-codex"]);
    }
    // A stop under "refuse" does not end the record: every model the response named is recorded,
    // the failure and the lost tools unchanged (review r_75bf1f48 X1).
    const stopFirst = await turn({ model: GPT, served: [CLAUDE, "gpt-5.4"], same_family: "refuse", hook: promptModels });
    assert.equal(stopFirst.r.status, "failed");
    assert.match(stopFirst.r.error ?? "", /changed its model mid-turn to "claude-sonnet-5\.5"/);
    assert.deepEqual(stopFirst.served, [GPT, CLAUDE, "gpt-5.4"]);
    assert.equal(stopFirst.families.launched, "unknown");
    // What still stops under "refuse" says why: another family, or one relay cannot tell.
    const unlisted = await turn({ model: GPT, steps: midTurn("unlisted-model"), same_family: "refuse" });
    assert.equal(unlisted.r.status, "failed");
    assert.match(unlisted.r.error ?? "", /changed its model mid-turn to "unlisted-model", from the "gpt-6\.1-sol" relay asked for, so relay stopped it and took away its relay tools: relay cannot tell which family "unlisted-model" is/);
    assert.match(strict.r.error ?? "", /took away its relay tools: Anthropic's model may have answered, not OpenAI's/);

    // A hook that cannot read the response fails the turn rather than leaving the label unchecked.
    const broken = await turn({ model: GPT, served: [GPT], hook: () => { throw new Error("malformed"); } });
    assert.equal(broken.r.status, "failed");
    assert.match(broken.r.error ?? "", /could not read which model .* says answered \(malformed\)/);
  } finally {
    setBoundaryProbeForTests(null);
    for (const [k, v] of [["HOME", saved.home], ["RELAY_HOME", saved.relay], ["STUB_SCENARIO", saved.scenario], ["STUB_ACP_REPORT", saved.report]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
    await h.close();
  }
});
