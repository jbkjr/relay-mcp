// Stage 2, WP-D (docs/codex-confinement-design.md §2.2, §2.4, §2.5, §13.2): admission gates, the
// stage-2 plan and codexFlags, the readback of Codex's settings, the thread checks, the per-kind
// `confined` accounting, the enforcement record, the hard-link check and the skill asset dir.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { hostVar } from "./host-env.ts";
// Also for its side effect: the process gets a scratch HOME at once (see helpers.ts); this file then sets its own.
import "./helpers.ts";

// A scratch HOME and relay home before any relay module loads: the registry and ~/.relay-t live there.
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2g")));
const saved = { ...process.env };
for (const name of Object.keys(process.env)) if (hostVar(name)) delete process.env[name];
Object.assign(process.env, { HOME: dir, RELAY_HOME: path.join(dir, "c"), RELAY_CONFIG: path.join(dir, "config.json") });
fs.mkdirSync(process.env.RELAY_HOME!);

const S2 = await import("../dist/backends/codex-stage2.js");
const { STAGE2_FLAG_ENV } = await import("../dist/core/raw-network.js");
const { codexFlags } = await import("../dist/backends/codex.js");
const { commandAsk, threadPermissionsProblem, CODEX_PROFILE } = await import("../dist/backends/codex-app.js");
const { withDefaults } = await import("../dist/core/config.js");
const { targetDef } = await import("../dist/targets/index.js");
const { createRun, insertNode, getNode, setParam, closeDbForTests } = await import("../dist/core/db.js");
const { rawNetworkKey } = await import("../dist/core/raw-network.js");
const { sessionParams } = await import("../dist/core/params.js");
const { requestView } = await import("../dist/core/approvals.js");
const { nodeView } = await import("../dist/core/views.js");
const { hardLinkProblem } = await import("../dist/core/worktree.js");

after(() => {
  closeDbForTests();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs `f` with the stage-2 switch as given, restoring it after. */
function switched<T>(on: boolean, f: () => T): T {
  const was = process.env[STAGE2_FLAG_ENV];
  if (on) process.env[STAGE2_FLAG_ENV] = "1";
  else delete process.env[STAGE2_FLAG_ENV];
  try {
    return f();
  } finally {
    if (was === undefined) delete process.env[STAGE2_FLAG_ENV];
    else process.env[STAGE2_FLAG_ENV] = was;
  }
}
async function switchedAsync<T>(on: boolean, f: () => Promise<T>): Promise<T> {
  const was = process.env[STAGE2_FLAG_ENV];
  if (on) process.env[STAGE2_FLAG_ENV] = "1";
  else delete process.env[STAGE2_FLAG_ENV];
  try {
    return await f();
  } finally {
    if (was === undefined) delete process.env[STAGE2_FLAG_ENV];
    else process.env[STAGE2_FLAG_ENV] = was;
  }
}

const cwd = path.join(dir, "w");
fs.mkdirSync(cwd);
const spec = (o: { config?: Record<string, unknown>; grant?: Record<string, unknown>; access?: string; target?: string; relay?: unknown; extensionServers?: string[] } = {}) => ({
  config: withDefaults((o.config ?? {}) as never), target: targetDef((o.target ?? "codex") as never), access: o.access ?? "write", cwd, relay: o.relay ?? null,
  grant: o.grant ?? { network: true, raw_network: true }, ...(o.extensionServers ? { extensionServers: o.extensionServers } : {}),
}) as never;
const okProbes = { consent: () => null, version: () => [0, 164, 0], mcpServers: () => [], interlock: () => null, aliases: () => null };
const NET = { mode: "stage2", deniedTcp: [22], deniedUdp: [1900], relayRange: [47201], execPort: 47200, bindPorts: [47202], worktreeSockets: true } as never;

test("stage 2 gates: wanted and per-turn confinement for raw grants, overlays and network-disabled origins, switched on", () => {
  switched(false, () => {
    assert.equal(S2.stage2Wanted(spec()), false);
    assert.equal(S2.turnConfinement(spec()), "verified");
  });
  switched(true, () => {
    assert.equal(S2.stage2Wanted(spec()), true);
    assert.equal(S2.turnConfinement(spec()), "relay-enforced");
    assert.equal(S2.turnConfinement(spec({ grant: { network: true } })), "relay-enforced");
    assert.equal(S2.stage2Wanted(spec({ grant: {} })), true, "network-disabled origins can escalate");
    assert.equal(S2.stage2Wanted(spec({ grant: {}, config: { escalation: false } })), false);
    assert.equal(S2.stage2Wanted(spec({ grant: {}, config: { escalation: { enabled: false } } })), false);
    assert.equal(S2.stage2Admission(spec({ grant: {}, access: "read" }), {}, { ...okProbes, consent: () => assert.fail("no raw consent for a network-disabled origin") }), null);
    assert.equal(S2.turnConfinement(spec({ config: { codex_backend: "exec" } })), "relay-enforced", "unqualified network-on variants refuse admission rather than use native strict");
    assert.equal(S2.turnConfinement(spec({ target: "claude" })), "verified");
  });
  // The config switch alone (targets.codex.stage2) turns it on; without it or the variable, off.
  switched(false, () => {
    assert.equal(S2.stage2Wanted(spec({ config: { targets: { codex: { stage2: true } } } })), true);
    assert.equal(S2.stage2Wanted(spec({ config: { targets: { codex: { stage2: false } } } })), false);
  });
});

test("stage 2 gates: admission refuses each unsafe or unknown setting, and admits the safe one", () => {
  switched(true, () => {
    assert.equal(S2.stage2Admission(spec(), {}, okProbes), null);
    const refused = (s: unknown, env: NodeJS.ProcessEnv, probes: object, why: RegExp) => {
      const r = S2.stage2Admission(s as never, env, { ...okProbes, ...probes });
      assert.match(r ?? "", why);
      assert.match(r ?? "", /^relay cannot run this Codex job under stage 2: .*It does not start the agent/);
    };
    refused(spec({ grant: { network: true } }), {}, {}, /no checked never policy/);
    refused(spec({ config: { codex_backend: "exec" } }), {}, {}, /codex_backend is "exec"/);
    refused(spec({ access: "read" }), {}, {}, /raw network is for write jobs/);
    refused(spec(), {}, { version: () => null }, /could not read Codex's version/);
    refused(spec(), {}, { version: () => { throw new Error("boom"); } }, /could not read Codex's version/);
    refused(spec(), {}, { version: () => [0, 163, 0] }, /Codex is 0\.163\.0, and stage 2 needs 0\.164\.0 or later/);
    assert.equal(S2.stage2Admission(spec(), {}, { ...okProbes, version: () => [0, 165, 1] }), null);
    assert.equal(S2.stage2Admission(spec(), {}, { ...okProbes, version: () => [1, 0, 0] }), null);
    // environments.toml in the agent's CODEX_HOME, and in ~/.codex when CODEX_HOME is unset.
    const home = path.join(dir, "codex-home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "environments.toml"), "");
    refused(spec(), { CODEX_HOME: home }, {}, /environments\.toml exists/);
    fs.mkdirSync(path.join(dir, "h2", ".codex"), { recursive: true });
    fs.writeFileSync(path.join(dir, "h2", ".codex", "environments.toml"), "");
    refused(spec(), { HOME: path.join(dir, "h2") }, {}, /environments\.toml exists/);
    for (const name of ["CODEX_EXEC_SERVER_URL", "CODEX_EXEC_SERVER_NOISE_REGISTRY_URL", "CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID", "CODEX_EXEC_SERVER_NOISE_CHATGPT_ACCOUNT_ID"]) {
      refused(spec(), { [name]: "x" }, {}, new RegExp(`sets ${name}`));
    }
    // relay's own CODEX_EXEC_SERVER_URL=none is relay's to set (stage2AppServerEnv): the person's, even "none", is refused.
    refused(spec(), { CODEX_EXEC_SERVER_URL: "none" }, {}, /sets CODEX_EXEC_SERVER_URL/);
    for (const token of ["person-secret", ""]) refused(spec(), { RELAY_BROKER_TOKEN: token }, {}, /sets RELAY_BROKER_TOKEN/);
    // Include disabled entries: recursive TOML merging would retain their inherited fields too.
    refused(spec(), {}, { mcpServers: () => ["relay_tools"] }, /person's Codex config defines relay_tools.*inherited fields/);
    refused(spec(), {}, { mcpServers: () => { throw new Error("cannot read config"); } }, /could not read the person's MCP server names.*cannot read config/);
    assert.equal(S2.stage2Admission(spec(), {}, { ...okProbes, mcpServers: () => ["relay", "other"] }), null);
    // The broker restores relay tools; stage-2 extension servers remain unsupported.
    refused(spec({ extensionServers: ["ext"] }), {}, {}, /stage-2 jobs do not support extension servers/);
    refused(spec({ config: { child_mcp: "inherit" } }), {}, {}, /child_mcp is not "relay-only"/);
    refused(spec({ config: { child_hooks: true } }), {}, {}, /child_hooks is on/);
    refused(spec(), {}, { interlock: () => "a relay local-network job is running" }, /a relay local-network job is running/);
    refused(spec(), {}, { interlock: () => { throw new Error("no registry"); } }, /could not check whether a relay local-network job runs \(no registry\)/);
    refused(spec(), {}, { aliases: () => "lo0 carries 127.0.0.2" }, /lo0 carries 127\.0\.0\.2/);
    refused(spec(), {}, { aliases: () => { throw new Error("not implemented"); } }, /could not check this Mac's loopback addresses/);
  });
  // Switched off: never admitted.
  switched(false, () => assert.match(S2.stage2Admission(spec(), {}, okProbes) ?? "", /this turn does not select stage 2/));
});

test("stage 2 gates: admission step 1 refuses unless the person's stored consent is for the very grant the turn launches with (review R2)", () => {
  const run = createRun(dir, withDefaults({}), "consent");
  const g1 = { network: true, raw_network: true, write_paths: [] as string[] };
  insertNode({ id: "j_cons0001", run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "t", cwd, params_json: JSON.stringify({ grant: g1 }) });
  const at = (grant: Record<string, unknown>, nodeId = "j_cons0001") => ({ ...(spec({ grant }) as object), markers: { runId: run, nodeId, depth: 1 } }) as never;
  // Every probe but the consent one: the real check reads the registry.
  const { consent: _real, ...others } = okProbes;
  const admit = (s: never) => S2.stage2Admission(s, {}, others);
  switched(true, () => {
    // Never asked (or a resume ended the consent while the turn started): refused.
    assert.match(admit(at(g1)) ?? "", /^relay cannot run this Codex job under stage 2: the person has not consented to this job's raw network/);
    setParam("j_cons0001", "raw_network_consent", { grant: rawNetworkKey(g1), by: "by the user", at: 1 });
    assert.equal(admit(at(g1)), null);
    // A consent for another grant than the turn's (other write paths): refused.
    assert.match(admit(at({ ...g1, write_paths: ["/x"] })) ?? "", /consent is for another grant than the one this turn holds/);
    // A job relay cannot find: refused.
    assert.match(admit(at(g1, "j_missing1")) ?? "", /cannot find the job in its registry/);
    // A consent check that throws refuses too.
    assert.match(S2.stage2Admission(at(g1), {}, { ...others, consent: () => { throw new Error("db closed"); } }) ?? "", /could not read the person's consent \(db closed\)/);
  });
});

test("stage 2 broker: admission reads all person-defined MCP names, including disabled collisions, and fails closed on an unreadable catalog", () => {
  const bin = path.join(dir, "fake-codex-mcp");
  const { mcpServers: _real, ...probes } = okProbes;
  const admit = (output: unknown, status = 0) => {
    // A CLI double, not an app server: exercise the admission probe without starting Codex.
    fs.writeFileSync(bin, `#!${process.execPath}\nif (process.cwd() !== ${JSON.stringify(cwd)} || JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(["--disable", "plugins", "mcp", "list", "--json"]))}) process.exit(9);\nprocess.stdout.write(${JSON.stringify(typeof output === "string" ? output : JSON.stringify(output))}); process.exit(${status});\n`, { mode: 0o700 });
    return S2.stage2Admission(spec({ config: { targets: { codex: { bin } } } }), {}, probes);
  };
  switched(true, () => {
    assert.equal(admit([{ name: "relay", enabled: true }, { name: "other", enabled: false }]), null);
    for (const enabled of [true, false]) assert.match(admit([{ name: "relay_tools", enabled }]) ?? "", /person's Codex config defines relay_tools/);
    for (const output of ["not JSON", {}, [null], [{ enabled: false }]]) assert.match(admit(output) ?? "", /could not read the person's MCP server names/);
    assert.match(admit([], 1) ?? "", /codex mcp list exited with 1/);
    assert.match(S2.stage2Admission(spec({ config: { targets: { codex: { bin: path.join(dir, "missing-codex") } } } }), {}, probes) ?? "", /could not read the person's MCP server names/);
  });
});

test("stage 2 gates: the app server runs with relay's own CODEX_EXEC_SERVER_URL=none over the checked environment, frozen", () => {
  assert.deepEqual({ ...S2.STAGE2_APP_SERVER_ENV }, { CODEX_EXEC_SERVER_URL: "none" });
  assert.ok(Object.isFrozen(S2.STAGE2_APP_SERVER_ENV));
  const checked = Object.freeze({ PATH: "/usr/bin", CODEX_HOME: "/h" });
  const env = S2.stage2AppServerEnv(checked);
  assert.ok(Object.isFrozen(env));
  assert.deepEqual({ ...env }, { PATH: "/usr/bin", CODEX_HOME: "/h", CODEX_EXEC_SERVER_URL: "none" });
  assert.deepEqual({ ...checked }, { PATH: "/usr/bin", CODEX_HOME: "/h" }, "what admission checked is left as it was");
  // relay's value wins over anything a checked environment could carry (admission refuses one anyway).
  assert.equal(S2.stage2AppServerEnv({ CODEX_EXEC_SERVER_URL: "ws://127.0.0.1:1" }).CODEX_EXEC_SERVER_URL, "none");
});

test("stage 2 gates: the plan and codexFlags give :danger-full-access enforced by relay, on-request, every app-server feature pinned off", () => {
  const plan = S2.stage2Plan(spec(), NET);
  assert.deepEqual(plan.permissions, { id: ":danger-full-access", profile: null, sandbox: "danger-full-access", network: true, proxy: null, enforcement: "relay" });
  assert.deepEqual(S2.stage2Permissions(false).network, false);
  assert.deepEqual(plan.off, []);
  assert.deepEqual(plan.features, Object.fromEntries(S2.STAGE2_FEATURES_OFF.map((f: string) => [f, false])));
  for (const f of ["image_generation", "apps", "plugins", "hooks", "skill_mcp_dependency_install", "exec_permission_approvals", "request_permissions_tool", "network_proxy"]) {
    assert.ok(S2.STAGE2_FEATURES_OFF.includes(f), f);
    assert.ok(plan.c.includes(`features.${f}=false`), f);
    // Pinned off, never qualified as allowed on.
    assert.ok(!S2.STAGE2_FEATURES_ALLOWED_ON.includes(f), f);
  }
  assert.ok(plan.c.includes('approval_policy="on-request"'));
  for (const pin of ["agents.max_concurrent_threads_per_session=6", "features.respect_system_proxy=false"]) assert.ok(plan.c.includes(pin), pin);
  assert.ok(!plan.c.some((x: string) => x.startsWith("agents.max_threads")), "no legacy alias pin: it is the same key");
  // Every value is a -c pair.
  for (let i = 0; i < plan.c.length; i += 2) assert.equal(plan.c[i], "-c");
  assert.deepEqual(S2.stage2ThreadParams("/w", "relay"), { environments: [{ environmentId: "relay", cwd: "/w" }], approvalPolicy: "on-request" });
  // Every turn, fresh or resumed, names relay's executor as its only environment.
  assert.deepEqual(S2.stage2TurnParams("/w", "relay"), { environments: [{ environmentId: "relay", cwd: "/w" }] });
  // A goal starts turns by itself on resume, before relay can bind them: pinned off, never allowed on.
  assert.ok(S2.STAGE2_FEATURES_OFF.includes("goals"));
  assert.ok(!S2.STAGE2_FEATURES_ALLOWED_ON.includes("goals"));
  assert.ok(plan.c.includes("features.goals=false"));

  const flags = codexFlags(spec(), [], {}, [], undefined, plan);
  assert.equal(flags.expect.permissions, plan.permissions);
  const all = flags.c.join(" ");
  assert.match(all, /default_permissions=":danger-full-access"/);
  assert.doesNotMatch(all, new RegExp(`permissions\\.${CODEX_PROFILE}\\.`), "no profile of relay's own: relay's Seatbelt confines");
  assert.doesNotMatch(all, /features\.network_proxy=true/);
  // The 1.0.5 pins and the stage-2 pins, read back through Expected.features.
  for (const f of S2.STAGE2_FEATURES_OFF) assert.equal(flags.expect.features![f], false, f);
  assert.equal(flags.expect.features!.exec_permission_approvals, false);
  assert.equal(flags.expect.features!.request_permissions_tool, false);
  assert.ok(flags.off.join(" ").includes("--disable hooks") && flags.off.join(" ").includes("--disable plugins"));
  assert.equal(flags.expect.relayOnly, true);
  // A job that may delegate (spec.relay set) still gets no relay MCP server on a stage-2 turn: the
  // app server has no `local` environment, where a stdio server would run (review r_0c11d860 C1+X2).
  const child = { runId: "r_x", nodeId: "j_x", depth: 1, contextFile: "/x/ctx.json", turnId: 1, mayDelegate: true, mayAsk: true };
  const delegating = codexFlags(spec({ relay: child }), [], {}, [], undefined, plan);
  const dall = delegating.c.join(" ");
  assert.equal(delegating.expect.relay, null, "the readback expects no relay server");
  assert.match(dall, /mcp_servers\.relay\.enabled=false/);
  assert.match(dall, /mcp_servers\.relay\.command="false"/);
  assert.doesNotMatch(dall, /mcp_servers\.relay\.enabled=true|RELAY_NODE_ID|default_tools_approval_mode/);
  // The control: the same job without stage 2 builds relay's server, as before (here it stops at the
  // environment broker this test has none of; the stage-2 call above never got that far).
  assert.throws(() => codexFlags(spec({ relay: child }), [], {}), /environment broker is unavailable/);
  // Without a plan, nothing of stage 2 is set.
  const plain = codexFlags(spec(), [], {}).c.join(" ");
  assert.doesNotMatch(plain, /approval_policy=|features\.image_generation=|:danger-full-access/);
});

/** A fake app server for the readback: config already read; the feature list, hooks and MCP server list as given. */
function fakeRpc(o: { features?: [string, unknown][] | "error"; hooks?: unknown; pages?: number; mcp?: Record<string, unknown>[] | "error" | "malformed"; local?: unknown; onMcp?: (params: any) => void } = {}) {
  const methods: string[] = [];
  const listed: [string, unknown][] = o.features === "error" ? [] : o.features ?? [
    ...S2.STAGE2_FEATURES_OFF.map((f: string) => [f, false] as [string, unknown]),
    ...S2.STAGE2_FEATURES_ALLOWED_ON.map((f: string) => [f, true] as [string, unknown]),
    ["multi_env_copy_file", false],
  ];
  const pages = o.pages ?? 2;
  const per = Math.ceil(listed.length / pages);
  return {
    methods,
    request: async (method: string, params: any) => {
      methods.push(method);
      if (method === "environment/status") {
        if (params?.environmentId !== "local") throw new Error(`unexpected environment ${params?.environmentId}`);
        if (o.local === "error") throw new Error("method not found");
        // As Codex 0.164.0 answers with CODEX_EXEC_SERVER_URL=none.
        return o.local ?? { status: "unknown", error: "unknown environment id `local`" };
      }
      if (method === "experimentalFeature/list") {
        if (o.features === "error") throw new Error("method not found");
        const page = params.cursor ? Number(params.cursor) : 0;
        const data = listed.slice(page * per, (page + 1) * per).map(([name, enabled]) => ({ name, enabled, stage: "stable" }));
        return { data, nextCursor: page + 1 < pages ? String(page + 1) : null };
      }
      if (method === "hooks/list") {
        if (o.hooks === "error") throw new Error("hooks unavailable");
        return o.hooks ?? { data: [{ cwd: params.cwds?.[0], hooks: [], warnings: [], errors: [] }] };
      }
      if (method === "mcpServerStatus/list") {
        o.onMcp?.(params);
        if (o.mcp === "error") throw new Error("mcp registry unavailable");
        if (o.mcp === "malformed") return { servers: [] };
        // As Codex 0.164.0 lists them before a thread exists: relay's entry and the person's server, both switched off, no running state.
        const listed = o.mcp ?? [{ name: "other", runtimeStatus: null, pluginId: null }, { name: "relay", runtimeStatus: null, pluginId: null }];
        // One server a page, so that paging is exercised.
        const at = params.cursor ? Number(params.cursor) : 0;
        return { data: listed.slice(at, at + 1), nextCursor: at + 1 < listed.length ? String(at + 1) : null };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}
const goodEff = () => ({
  approval_policy: "on-request",
  agents: { max_concurrent_threads_per_session: 6 },
  // relay's entry switched off (codexFlags on a stage-2 turn), the person's too (child_mcp relay-only).
  mcp_servers: { relay: { command: "false", enabled: false }, other: { command: "y", enabled: false } },
  features: Object.fromEntries(S2.STAGE2_FEATURES_OFF.map((f: string) => [f, false])),
});

test("stage 2 gates: the selected version pins new 0.166 features without requiring them from 0.164", async () => {
  for (const version of [[0, 164, 0], [0, 166, 0]]) {
    const s = spec();
    switched(true, () => assert.equal(S2.stage2Admission(s, {}, { ...okProbes, version: () => version }), null));
    const plan = S2.stage2Plan(s, NET);
    const off = Object.keys(plan.features);
    const added = ["plugin_discovery_prefetch", "prediction_preserve_parent_tools"];
    assert.deepEqual(off, S2.stage2FeaturesOff(version));
    for (const f of added) {
      assert.equal(off.includes(f), version[1] >= 166);
      assert.equal(plan.c.includes(`features.${f}=false`), version[1] >= 166);
      assert.ok(!S2.STAGE2_FEATURES_ALLOWED_ON.includes(f));
    }
    const eff = { ...goodEff(), features: { ...plan.features, reasoning_effort_override: true } };
    const listed: [string, unknown][] = [...off.map((f): [string, unknown] => [f, false]), ["reasoning_effort_override", true]];
    const read = (features = listed, config = eff) => S2.stage2Readback(fakeRpc({ features }), config, cwd, undefined, off);
    assert.equal(await read(), null, `${version.join(".")} accepts effort override and its own off policy`);
    for (const f of added) {
      assert.match(await read([...listed.filter(([name]) => name !== f), [f, true]]) ?? "", new RegExp(f));
      if (off.includes(f)) {
        assert.match(await read(listed, { ...eff, features: { ...eff.features, [f]: true } }) ?? "", new RegExp(f));
        assert.match(await read(listed.filter(([name]) => name !== f)) ?? "", new RegExp(`does not list the features ${f}`));
      }
    }
  }
});

test("stage 2 gates: deferred_tool_world_state is pinned off on every admitted version, 0.167's default on refuses", async () => {
  const f = "deferred_tool_world_state";
  assert.ok(S2.STAGE2_FEATURES_OFF.includes(f));
  assert.ok(!S2.STAGE2_FEATURES_ALLOWED_ON.includes(f));
  for (const version of [[0, 164, 0], [0, 166, 0], [0, 167, 0]]) {
    const s = spec();
    switched(true, () => assert.equal(S2.stage2Admission(s, {}, { ...okProbes, version: () => version }), null));
    const plan = S2.stage2Plan(s, NET);
    const off = Object.keys(plan.features);
    assert.deepEqual(off, S2.stage2FeaturesOff(version));
    assert.ok(off.includes(f), version.join("."));
    assert.equal(plan.features[f], false);
    assert.ok(plan.c.includes(`features.${f}=false`), version.join("."));
    const eff = { ...goodEff(), features: { ...plan.features } };
    const listed: [string, unknown][] = off.map((g): [string, unknown] => [g, false]);
    const read = (features = listed, config = eff) => S2.stage2Readback(fakeRpc({ features }), config, cwd, undefined, off);
    assert.equal(await read(), null, `${version.join(".")} reads back with ${f} off`);
    // 0.167.0's default: listed on.
    assert.match(await read([...listed.filter(([name]) => name !== f), [f, true]]) ?? "", new RegExp(`reports ${f} on`));
    assert.match(await read(listed, { ...eff, features: { ...eff.features, [f]: true } }) ?? "", new RegExp(f));
    assert.match(await read(listed.filter(([name]) => name !== f)) ?? "", new RegExp(`does not list the features ${f}`));
  }
});

test("stage 2 gates: incremental_tools_legacy_gcp is pinned off from 0.167.2 without requiring it earlier, its default on refuses", async () => {
  const f = "incremental_tools_legacy_gcp";
  assert.ok(!S2.STAGE2_FEATURES_OFF.includes(f));
  assert.ok(!S2.STAGE2_FEATURES_ALLOWED_ON.includes(f));
  for (const version of [[0, 167, 0], [0, 167, 1], [0, 167, 2], [0, 169, 0]]) {
    const v = version.join(".");
    const pinned = version[1] > 167 || version[2] >= 2;
    const s = spec();
    switched(true, () => assert.equal(S2.stage2Admission(s, {}, { ...okProbes, version: () => version }), null));
    const plan = S2.stage2Plan(s, NET);
    const off = Object.keys(plan.features);
    assert.deepEqual(off, S2.stage2FeaturesOff(version));
    assert.equal(off.includes(f), pinned, v);
    assert.equal(plan.c.includes(`features.${f}=false`), pinned, v);
    const eff = { ...goodEff(), features: { ...plan.features } };
    const listed: [string, unknown][] = off.map((g): [string, unknown] => [g, false]);
    const read = (features = listed, config = eff) => S2.stage2Readback(fakeRpc({ features }), config, cwd, undefined, off);
    assert.equal(await read(), null, `${v} reads back with its own off policy`);
    // 0.167.2's default: listed on. Refused on every version, pinned or not.
    assert.match(await read([...listed.filter(([name]) => name !== f), [f, true]]) ?? "", new RegExp(f), v);
    if (pinned) {
      assert.match(await read([...listed.filter(([name]) => name !== f), [f, true]]) ?? "", new RegExp(`reports ${f} on`), v);
      assert.match(await read(listed, { ...eff, features: { ...eff.features, [f]: true } }) ?? "", new RegExp(f), v);
      assert.match(await read(listed.filter(([name]) => name !== f)) ?? "", new RegExp(`does not list the features ${f}`), v);
    }
  }
});

test("stage 2 gates: 0.170.0's default-on features are pinned off from 0.170.0 without requiring them earlier, each one on refuses", async () => {
  const added = ["code_mode_host_grpc", "code_mode_host_output_truncation", "guardian_include_additional_context", "incremental_tools_legacy",
    "retain_client_tool_outputs", "unified_image_budget", "untrusted_as_tool_output"];
  assert.deepEqual([...S2.STAGE2_FEATURES_OFF_0170], added);
  for (const f of added) {
    assert.ok(!S2.STAGE2_FEATURES_OFF.includes(f), f);
    assert.ok(!S2.STAGE2_FEATURES_ALLOWED_ON.includes(f), f);
  }
  for (const version of [[0, 167, 2], [0, 169, 1], [0, 170, 0], [0, 171, 0]]) {
    const v = version.join(".");
    const pinned = version[1] >= 170;
    const s = spec();
    switched(true, () => assert.equal(S2.stage2Admission(s, {}, { ...okProbes, version: () => version }), null));
    const plan = S2.stage2Plan(s, NET);
    const off = Object.keys(plan.features);
    assert.deepEqual(off, S2.stage2FeaturesOff(version));
    // Earlier pins stay: 0.170.0 removes plugin_discovery_prefetch but still lists it off.
    for (const kept of ["plugin_discovery_prefetch", "prediction_preserve_parent_tools", "incremental_tools_legacy_gcp", "deferred_tool_world_state"]) assert.ok(off.includes(kept), `${v} ${kept}`);
    const eff = { ...goodEff(), features: { ...plan.features } };
    const listed: [string, unknown][] = off.map((g): [string, unknown] => [g, false]);
    const read = (features = listed, config = eff) => S2.stage2Readback(fakeRpc({ features }), config, cwd, undefined, off);
    assert.equal(await read(), null, `${v} reads back with its own off policy`);
    for (const f of added) {
      assert.equal(off.includes(f), pinned, `${v} ${f}`);
      assert.equal(plan.c.includes(`features.${f}=false`), pinned, `${v} ${f}`);
      // 0.170.0's default: listed on. Refused on every version, pinned or not.
      assert.match(await read([...listed.filter(([name]) => name !== f), [f, true]]) ?? "", new RegExp(f), `${v} ${f}`);
      if (pinned) {
        assert.match(await read([...listed.filter(([name]) => name !== f), [f, true]]) ?? "", new RegExp(`reports ${f} on`), `${v} ${f}`);
        assert.match(await read(listed, { ...eff, features: { ...eff.features, [f]: true } }) ?? "", new RegExp(f), `${v} ${f}`);
        assert.match(await read(listed.filter(([name]) => name !== f)) ?? "", new RegExp(`does not list the features ${f}`), `${v} ${f}`);
      }
    }
  }
});

const brokerConfig = { url: "http://127.0.0.1:47203/mcp", toolTimeoutS: 3900 };
const brokerEntry = () => ({
  url: brokerConfig.url, bearer_token_env_var: "RELAY_BROKER_TOKEN", environment_id: "local",
  enabled: true, required: true, default_tools_approval_mode: "approve", startup_timeout_sec: 30,
  tool_timeout_sec: brokerConfig.toolTimeoutS,
});
const brokerEff = () => ({ ...goodEff(), mcp_servers: { ...goodEff().mcp_servers, relay_tools: brokerEntry() } });
const brokerListing = (runtimeStatus: unknown = null) => ({
  name: "relay_tools", pluginId: null, runtimeStatus, httpOrigin: "http://127.0.0.1:47203",
  authStatus: "bearerToken", toolsError: null, tools: { status: { name: "status" }, ask: { name: "ask" } },
});
function fakeBroker() {
  let served = 0;
  return { ...brokerConfig, listTools: async () => [{ name: "status" }, { name: "ask" }], sessionsServed: () => served, connect: () => { served++; } };
}

test("stage 2 broker: exact config entry, including readiness, timeouts and no extra auth or tool filters", async () => {
  const check = S2.stage2BrokerConfigProblem;
  assert.equal(check(brokerEntry(), brokerConfig), null);
  assert.equal(check({ ...brokerEntry(), startup_readiness: "connection" }, brokerConfig), null);
  for (const [key, value] of Object.entries(brokerEntry())) {
    for (const bad of [undefined, null, typeof value === "boolean" ? !value : typeof value === "number" ? value + 1 : "wrong"]) {
      assert.match(check({ ...brokerEntry(), [key]: bad }, brokerConfig) ?? "", new RegExp(key), `${key}=${bad}`);
    }
  }
  for (const readiness of ["catalog", null, true]) assert.match(check({ ...brokerEntry(), startup_readiness: readiness }, brokerConfig) ?? "", /startup_readiness/);
  for (const key of ["bearer_token", "http_headers", "env_http_headers", "http_headers_helper", "oauth", "command", "args", "env", "env_vars", "enabled_tools", "disabled_tools", "tools", "scopes", "unknown_auth"]) {
    const problem = check({ ...brokerEntry(), [key]: "DO-NOT-ECHO-THIS" }, brokerConfig) ?? "";
    assert.match(problem, new RegExp(key));
    assert.ok(!problem.includes("DO-NOT-ECHO-THIS"), "readback refusals must not echo unexpected secret values");
  }
  assert.match(check(undefined, brokerConfig) ?? "", /relay_tools/);
});

test("stage 2 broker: config pins and exact entry read back before the listing may connect", async () => {
  const broker = fakeBroker();
  const read = (eff: Record<string, unknown>) => {
    const rpc = fakeRpc({ mcp: [brokerListing()], onMcp: () => broker.connect() });
    return { rpc, result: S2.stage2Readback(rpc, eff, cwd, broker) };
  };
  assert.equal(await read(brokerEff()).result, null);
  for (const key of ["max_concurrent_threads_per_session"]) {
    for (const bad of [undefined, null, 0, 9, "4"]) {
      const { rpc, result } = read({ ...brokerEff(), agents: { ...goodEff().agents, [key]: bad } });
      assert.match(await result ?? "", new RegExp(`agents.${key}`));
      assert.ok(!rpc.methods.includes("mcpServerStatus/list"));
    }
  }
  // An old, noncanonical top-level v2 key cannot satisfy the pin.
  assert.match(await read({ ...brokerEff(), agents: {}, max_concurrent_threads_per_session: 6 }).result ?? "", /agents.max_concurrent_threads_per_session/);
  for (const key of Object.keys(brokerEntry())) {
    const { rpc, result } = read({ ...brokerEff(), mcp_servers: { ...brokerEff().mcp_servers, relay_tools: { ...brokerEntry(), [key]: null } } });
    assert.match(await result ?? "", new RegExp(key));
    assert.ok(!rpc.methods.includes("mcpServerStatus/list"));
  }
  const { rpc, result } = read(goodEff());
  assert.match(await result ?? "", /relay_tools/);
  assert.ok(!rpc.methods.includes("mcpServerStatus/list"));
  assert.match(await S2.stage2Readback(fakeRpc(), brokerEff(), cwd) ?? "", /MCP servers are on \(relay_tools\)/, "no expected broker means no enabled broker");
  assert.match(await read({ ...brokerEff(), mcp_servers: { ...brokerEff().mcp_servers, relay: { enabled: true } } }).result ?? "", /MCP servers are on \(relay\)/);
  const { relay: _disabledRelay, ...withoutRelay } = brokerEff().mcp_servers;
  const missingRelay = read({ ...brokerEff(), mcp_servers: withoutRelay });
  assert.match(await missingRelay.result ?? "", /relay.*off/);
  assert.ok(!missingRelay.rpc.methods.includes("mcpServerStatus/list"));
});

test("stage 2 broker: listing requires exactly its origin, bearer auth, tools, and fresh broker evidence", async () => {
  const check = async (mcp: Parameters<typeof fakeRpc>[0]["mcp"], connects = true, broker = fakeBroker()) => S2.stage2Readback(fakeRpc({ mcp, onMcp: connects ? () => broker.connect() : undefined }), brokerEff(), cwd, broker);
  assert.equal(await check([brokerListing(), { name: "relay", runtimeStatus: "disabled" }, { name: "other", runtimeStatus: null }]), null);
  for (const patch of [
    { pluginId: "plugin" }, { httpOrigin: "http://127.0.0.1:47204" }, { httpOrigin: null },
    { authStatus: "notLoggedIn" }, { authStatus: null }, { toolsError: "unavailable" },
    { tools: {} }, { tools: null }, { tools: [] }, { tools: { status: { name: "status" } } },
    { tools: { ...brokerListing().tools, evil: { name: "evil" } } },
    { tools: { ...brokerListing().tools, status: { name: "evil" } } },
    { runtimeStatus: "failed" }, { runtimeStatus: "disabled" },
  ]) assert.match(await check([{ ...brokerListing(), ...patch }]) ?? "", /relay_tools/, JSON.stringify(patch));
  for (const listing of [[], [brokerListing(), brokerListing()], [brokerListing(), { name: "unexpected" }], [brokerListing(), { name: "other", runtimeStatus: "connected" }]]) {
    assert.ok(await check(listing), JSON.stringify(listing));
  }
  const stale = fakeBroker();
  stale.connect();
  assert.match(await check([brokerListing()], false, stale) ?? "", /authenticated, peer-verified session.*listing/);
  assert.match(await check([brokerListing()], false) ?? "", /authenticated, peer-verified session.*listing/);
  assert.match(await check("error") ?? "", /could not read the MCP servers/);
  assert.match(await check("malformed") ?? "", /no list of servers/);
  const broken = { ...fakeBroker(), listTools: async () => { throw new Error("broker gone"); } };
  assert.match(await S2.stage2Readback(fakeRpc(), brokerEff(), cwd, broken) ?? "", /broker gone/);
  for (const count of [NaN, -1, Infinity]) {
    const invalid = { ...fakeBroker(), sessionsServed: () => count };
    assert.match(await S2.stage2Readback(fakeRpc(), brokerEff(), cwd, invalid) ?? "", /session/);
  }
});

test("stage 2 broker: per-thread listing is connected and has a new authenticated thread session", async () => {
  const check = async (listing: Record<string, unknown>[], threadConnects: boolean, baseline: number | undefined = 1) => {
    const broker = fakeBroker();
    broker.connect(); // The threadless readback's session, already closed.
    if (threadConnects) broker.connect(); // thread/start or thread/resume connects before this check.
    const params: any[] = [];
    const rpc = fakeRpc({ mcp: listing, onMcp: (p) => params.push(p) });
    const result = await S2.stage2ThreadMcpProblem(rpc, brokerEff(), "thread-1", broker, baseline);
    for (const p of params) assert.equal(p.threadId, "thread-1");
    return result;
  };
  assert.equal(await check([brokerListing("connected")], true), null);
  for (const state of [null, "starting", "notStarted", "failed", "cancelled", "authenticationRequired", "disabled"]) {
    assert.match(await check([brokerListing(state)], true) ?? "", /connected/);
  }
  assert.match(await check([brokerListing("connected")], false) ?? "", /thread session/);
  assert.match(await check([{ ...brokerListing("connected"), authStatus: "unsupported" }], true) ?? "", /bearerToken/);
  assert.match(await check([{ ...brokerListing("connected"), tools: {} }], true) ?? "", /tools/);
  assert.match(await check([], true) ?? "", /relay_tools/);
  for (const patch of [{ pluginId: "plugin" }, { httpOrigin: null }, { toolsError: "offline" }, { tools: null }]) {
    assert.match(await check([{ ...brokerListing("connected"), ...patch }], true) ?? "", /relay_tools/);
  }
  for (const mcp of ["error", "malformed"] as const) {
    const b = fakeBroker(); b.connect(); b.connect();
    assert.match(await S2.stage2ThreadMcpProblem(fakeRpc({ mcp }), brokerEff(), "thread-1", b, 1) ?? "", /could not read back the thread's MCP connection/);
  }
  assert.match(await check([brokerListing("connected"), { name: "other", runtimeStatus: "connected" }], true) ?? "", /other/);
  const broker = fakeBroker();
  assert.match(await S2.stage2ThreadMcpProblem(fakeRpc(), brokerEff(), "thread-1", broker) ?? "", /session/);
  assert.match(await S2.stage2ThreadMcpProblem(fakeRpc(), brokerEff(), "thread-1", broker, 0) ?? "", /session/);
  assert.match(await S2.stage2ThreadMcpProblem(fakeRpc(), brokerEff(), "", broker, 1) ?? "", /thread/);
  assert.equal(await S2.stage2ThreadMcpProblem(fakeRpc(), goodEff(), "thread-1"), null, "a turn without relay context still permits only switched-off servers");
});

test("stage 2 gates: the readback refuses each setting that does not read back as relay set it", async () => {
  const rpc = fakeRpc();
  assert.equal(await S2.stage2Readback(rpc, goodEff(), cwd), null);
  // Only reads: never command/exec, thread/shellCommand or fs/* on a stage-2 session.
  assert.deepEqual([...new Set(rpc.methods)].sort(), ["environment/status", "experimentalFeature/list", "hooks/list", "mcpServerStatus/list"]);
  assert.equal(rpc.methods[0], "environment/status", "whether Codex has a `local` environment, first");
  assert.equal(rpc.methods.at(-1), "mcpServerStatus/list", "the MCP listing (which starts every enabled server it lists once) comes last");
  const refused = async (eff: Record<string, unknown>, why: RegExp, o: Parameters<typeof fakeRpc>[0] = {}) => {
    const r = await S2.stage2Readback(fakeRpc(o), eff, cwd);
    assert.match(r ?? "", /^relay will not start a Codex agent under stage 2, because Codex's settings for it are not what relay set: /);
    assert.match(r ?? "", why);
  };
  for (const policy of ["never", "untrusted", "on-failure", null, { granular: {} }]) await refused({ ...goodEff(), approval_policy: policy }, /approval_policy is .* where relay set "on-request"/);
  // Codex's own `local` environment present (review r_0c11d860 C1+X2), or relay cannot ask: refused.
  await refused(goodEff(), /Codex reports its own "local" environment as "ready" \(environment\/status\), where relay started it with none \(CODEX_EXEC_SERVER_URL=none\)/, { local: { status: "ready" } });
  for (const status of ["pending", "disconnected", null]) await refused(goodEff(), new RegExp(`"local" environment as ${JSON.stringify(status)}`), { local: { status } });
  await refused(goodEff(), /could not ask Codex whether its own "local" environment exists \(environment\/status: method not found\)/, { local: "error" });
  // No MCP server on at all, relay's own included.
  await refused({ ...goodEff(), mcp_servers: { relay: { enabled: true } } }, /MCP servers are on \(relay\), where a stage-2 turn runs none/);
  await refused({ ...goodEff(), mcp_servers: { relay: { enabled: false }, mine: { command: "z" } } }, /MCP servers are on \(mine\)/);
  await refused({ ...goodEff(), mcp_servers: { relay: { enabled: false }, plugin_server: { enabled: true } } }, /plugin_server/);
  for (const f of S2.STAGE2_FEATURES_OFF) {
    for (const v of [true, null, { enabled: false }]) await refused({ ...goodEff(), features: { ...goodEff().features, [f]: v } }, new RegExp(`${f} \\(`));
    const listed = (on: unknown): [string, unknown][] => [...S2.STAGE2_FEATURES_OFF.map((g: string) => [g, g === f ? on : false] as [string, unknown]), ...S2.STAGE2_FEATURES_ALLOWED_ON.map((g: string) => [g, true] as [string, unknown])];
    await refused(goodEff(), new RegExp(`Codex reports ${f} on where relay set it off`), { features: listed(true) });
    await refused(goodEff(), new RegExp(`does not list the features ${f}`), { features: listed(true).filter(([g]) => g !== f) });
  }
  // Image generation, by name (decision D7), and the 1.0.5 pins.
  await refused({ ...goodEff(), features: { ...goodEff().features, image_generation: true } }, /image_generation \(true\)/);
  await refused({ ...goodEff(), features: { ...goodEff().features, exec_permission_approvals: true } }, /exec_permission_approvals \(true\)/);
  // A feature on that relay has not qualified: the exact per-turn allowlist (a new tool: multi_env_copy_file adds one).
  await refused(goodEff(), /features on that relay has not qualified for stage 2 \(multi_env_copy_file\)/, {
    features: [...S2.STAGE2_FEATURES_OFF.map((f: string) => [f, false] as [string, unknown]), ...S2.STAGE2_FEATURES_ALLOWED_ON.map((f: string) => [f, true] as [string, unknown]), ["multi_env_copy_file", true]],
  });
  await refused(goodEff(), /could not read the features Codex runs with/, { features: "error" });
  await refused(goodEff(), /Codex would run 1 hook/, { hooks: { data: [{ cwd, hooks: [{ key: "k", command: "touch x" }], warnings: [], errors: [] }] } });
  await refused(goodEff(), /reported errors reading its hooks/, { hooks: { data: [{ cwd, hooks: [], warnings: [], errors: [{ message: "bad" }] }] } });
  await refused(goodEff(), /did not say which hooks it would run/, { hooks: {} });
  await refused(goodEff(), /could not read the hooks Codex would run/, { hooks: "error" });
  // The MCP servers Codex lists (review R7): only those config/read shows switched off, relay's entry among them; nothing else.
  const mcp = async (listed: Record<string, unknown>[] | "error" | "malformed", why: RegExp, eff = goodEff()) => refused(eff, why, { mcp: listed });
  assert.equal(await S2.stage2Readback(fakeRpc({ mcp: [] }), goodEff(), cwd), null, "no server at all");
  assert.equal(await S2.stage2Readback(fakeRpc({ mcp: [{ name: "relay", runtimeStatus: null, pluginId: null }] }), goodEff(), cwd), null, "relay's entry, switched off");
  await mcp([{ name: "relay", runtimeStatus: "connected", pluginId: null }], /MCP servers it would run \(relay;/);
  await mcp([{ name: "relay", runtimeStatus: null, pluginId: null }], /MCP servers it would run \(relay;/, { ...goodEff(), mcp_servers: { other: { enabled: false } } });
  await mcp([{ name: "relay", pluginId: null }, { name: "node_repl", runtimeStatus: null, pluginId: "browser@openai" }], /MCP servers it would run \(node_repl \(from the plugin "browser@openai"\); mcpServerStatus\/list\), where a stage-2 turn runs none/);
  await mcp([{ name: "codex_apps", runtimeStatus: null, pluginId: null }], /MCP servers it would run \(codex_apps;/);
  await mcp([{ name: "relay", runtimeStatus: null, pluginId: "evil@x" }], /relay \(from the plugin "evil@x"\)/);
  await mcp([{ name: "other", runtimeStatus: "connected", pluginId: null }], /it would run \(other;/);
  await mcp([{ runtimeStatus: null }], /listed an MCP server without a name/);
  await mcp("error", /could not read the MCP servers Codex would run \(mcpServerStatus\/list: mcp registry unavailable\)/);
  await mcp("malformed", /could not read the MCP servers Codex would run \(mcpServerStatus\/list: its reply has no list of servers\)/);
  // Not asked at all when something earlier is already wrong: the listing starts the servers it lists.
  const early = fakeRpc();
  await S2.stage2Readback(early, { ...goodEff(), approval_policy: "never" }, cwd);
  assert.ok(!early.methods.includes("mcpServerStatus/list"));
});

test("stage 2 gates: no stage-2 path calls thread/shellCommand or command/exec", () => {
  // command/exec runs only in relay's proxied-network check, which needs a proxy; a stage-2 turn has none.
  assert.equal(S2.stage2Permissions(true).proxy, null);
  const app = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "backends", "codex-app.ts"), "utf8");
  assert.ok(!app.includes("thread/shellCommand"));
  assert.equal(app.match(/"command\/exec"/g)?.length, 1, "command/exec only in networkCanary");
  assert.equal(app.match(/networkCanary\(/g)?.length, 2, "networkCanary defined once and called once, in proxiedProblem");
  const proxied = app.slice(app.indexOf("async function proxiedProblem"));
  assert.ok(proxied.indexOf("if (!mode) return null;") >= 0 && proxied.indexOf("if (!mode) return null;") < proxied.indexOf("networkCanary("), "the canary runs only with a proxy");
  for (const file of ["codex-stage2.ts", "codex-env.ts"]) {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "backends", file), "utf8");
    for (const m of ["thread/shellCommand", '"command/exec"', '"fs/']) assert.ok(!src.includes(m), `${file}: ${m}`);
  }
});

test("stage 2 gates: the thread must be on-request, at full access, with relay's executor as its only environment", () => {
  const good = () => ({
    approvalPolicy: "on-request", activePermissionProfile: { id: ":danger-full-access", extends: null }, sandbox: { type: "dangerFullAccess" },
    runtimeWorkspaceRoots: [cwd], thread: { id: "t", environments: [{ environmentId: "relay", cwd, runtimeWorkspaceRoots: [cwd] }] },
  });
  assert.equal(S2.stage2ThreadProblem(good(), cwd, "relay"), null);
  const refused = (t: unknown, why: RegExp) => assert.match(S2.stage2ThreadProblem(t, cwd, "relay") ?? "", why);
  refused({ ...good(), approvalPolicy: "never" }, /approval policy "never"/);
  refused({ ...good(), activePermissionProfile: { id: "relay" } }, /permission profile "relay"/);
  refused({ ...good(), sandbox: { type: "workspaceWrite" } }, /"workspaceWrite" sandbox/);
  refused({ ...good(), runtimeWorkspaceRoots: [cwd, "/elsewhere"] }, /workspace roots/);
  refused({ ...good(), thread: { environments: [] } }, /environments \[\]/);
  refused({ ...good(), thread: {} }, /environments null/);
  refused({ ...good(), thread: { environments: [{ environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd] }] } }, /environment "local"/);
  refused({ ...good(), thread: { environments: [good().thread.environments[0], { environmentId: "local", cwd }] } }, /only its executor/);
  refused({ ...good(), thread: { environments: [{ environmentId: "relay", cwd: "/elsewhere", runtimeWorkspaceRoots: [cwd] }] } }, /at "\/elsewhere"/);
  refused({ ...good(), thread: { environments: [{ environmentId: "relay", cwd, runtimeWorkspaceRoots: ["/"] }] } }, /environment's workspace roots/);
  refused(null, /approval policy null/);

  // After thread/resume, which takes no environments: on an app server without `local` (CODEX_EXEC_SERVER_URL=none),
  // none at all, as Codex 0.164.0 replies, or relay's executor alone. Never `local` (review r_0c11d860 C1+X2).
  const relayEnv = { environmentId: "relay", cwd, runtimeWorkspaceRoots: [cwd] }, localEnv = { environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd] };
  const resumed = (envs: unknown) => S2.stage2ThreadProblem({ ...good(), thread: { environments: envs } }, cwd, "relay", { resumed: true });
  assert.equal(resumed([]), null, "Codex 0.164.0's reply on a server without `local`");
  assert.equal(resumed([relayEnv]), null);
  assert.match(resumed([localEnv, relayEnv]) ?? "", /reports the environments .* after thread\/resume where relay set only its executor \("relay"\) or none/, "Codex's `local` beside relay's is no longer accepted");
  assert.match(resumed([localEnv]) ?? "", /runs in the environment "local", not relay's executor/);
  assert.match(S2.stage2ThreadProblem({ ...good(), thread: { environments: [localEnv, relayEnv] } }, cwd, "relay") ?? "", /only its executor/, "a fresh thread must show relay's executor alone");
  assert.match(S2.stage2ThreadProblem({ ...good(), thread: { environments: [] } }, cwd, "relay") ?? "", /environments \[\]/, "a fresh thread with none is refused: relay set its executor");
  assert.match(resumed(null) ?? "", /environments null/);
  assert.match(resumed([relayEnv, relayEnv]) ?? "", /after thread\/resume where relay set only its executor/);
  assert.match(resumed([{ ...relayEnv, cwd: "/elsewhere" }]) ?? "", /at "\/elsewhere"/);
  assert.match(resumed([{ ...relayEnv, runtimeWorkspaceRoots: [cwd, "/"] }]) ?? "", /environment's workspace roots/);
  for (const other of [{ ...localEnv, cwd: "/elsewhere" }, { environmentId: "remote", cwd }, { environmentId: "relay2", cwd }]) {
    assert.match(resumed([other]) ?? "", /not relay's executor/, JSON.stringify(other));
    assert.match(resumed([other, relayEnv]) ?? "", /after thread\/resume where relay set only its executor/, JSON.stringify(other));
  }
  assert.match(S2.stage2ThreadProblem({ ...good(), approvalPolicy: "never", thread: { environments: [] } }, cwd, "relay", { resumed: true }) ?? "", /approval policy "never"/, "the rest of the reply is checked as on thread/start");
  // Codex reports the primary environment's roots as the thread's: a resumed thread with no environment
  // reports none (0.164.0 without `local`), accepted only then; with relay's executor, exactly [cwd].
  const resumedWith = (envs: unknown[], roots: unknown) => S2.stage2ThreadProblem({ ...good(), runtimeWorkspaceRoots: roots, thread: { environments: envs } }, cwd, "relay", { resumed: true });
  assert.equal(resumedWith([], []), null, "Codex 0.164.0's resume reply without `local`");
  assert.equal(resumedWith([], [cwd]), null);
  assert.match(resumedWith([], [cwd, "/"]) ?? "", /workspace roots/);
  assert.match(resumedWith([], ["/"]) ?? "", /workspace roots/);
  assert.match(resumedWith([relayEnv], []) ?? "", /workspace roots \[\]/, "bound to relay's executor, its roots are [cwd]");
  assert.match(S2.stage2ThreadProblem({ ...good(), runtimeWorkspaceRoots: [], thread: { environments: [] } }, cwd, "relay") ?? "", /environments \[\]/, "a fresh thread never");

  // threadPermissionsProblem's relay branch: the sandbox kind; the roots are stage2ThreadProblem's. allow_dangerous unchanged.
  const p = S2.stage2Permissions(true);
  assert.equal(threadPermissionsProblem(good(), p, cwd), null);
  assert.equal(threadPermissionsProblem({ ...good(), runtimeWorkspaceRoots: [] }, p, cwd), null, "a resumed thread with no environment yet: stage2ThreadProblem decides");
  assert.match(S2.stage2ThreadProblem({ ...good(), runtimeWorkspaceRoots: ["/"] }, cwd, "relay") ?? "", /workspace roots/);
  assert.match(threadPermissionsProblem({ ...good(), sandbox: { type: "workspaceWrite" } }, p, cwd) ?? "", /sandbox/);
  const dangerous = { ...p, enforcement: undefined };
  assert.equal(threadPermissionsProblem({ ...good(), runtimeWorkspaceRoots: ["/"] }, dangerous, cwd), null);
});

test("stage 2 gates: confined only on command approvals bound to relay's executor, and the approval view says so per kind", () => {
  assert.deepEqual(S2.stage2ApprovalDetail("command"), { confined: true });
  // A file change names no environment Codex or relay could check (review R4): unmarked.
  assert.deepEqual(S2.stage2ApprovalDetail("file"), {});
  // A command approval is shown only when Codex names relay's executor as its environment.
  assert.equal(S2.stage2CommandEnvironmentProblem("relay", "relay"), null);
  for (const other of ["local", "remote", "", null, undefined, 7]) {
    assert.match(S2.stage2CommandEnvironmentProblem(other, "relay") ?? "", /asked to approve a command in the environment .*not relay's sandboxed executor \("relay"\); relay declined it/, String(other));
  }
  for (const kind of ["mcp", "web", "extensions", "env", "path", "local_network"]) assert.throws(() => S2.stage2ApprovalDetail(kind as never), /does not mark/);
  // commandAsk under stage 2's permissions claims no narrower Codex effect of its own.
  const ask = commandAsk({ command: "ls", cwd }, S2.stage2Permissions(true));
  assert.deepEqual(ask.detail, { cwd });

  const run = createRun(dir, withDefaults({}), "tok");
  insertNode({ id: "j_view0001", run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "t", cwd });
  const row = (kind: string, detail: Record<string, unknown>) => ({ id: `r_${kind}`, run_id: run, node_id: "j_view0001", turn_id: 1, kind, summary: "s", reason: null, detail_json: JSON.stringify(detail), status: "pending", decided_by: null, note: null, scope: null, created_at: Date.now(), decided_at: null }) as never;
  const inside = /lets it go ahead inside relay's sandbox/;
  assert.match(String(requestView(row("command", { ...ask.detail, ...S2.stage2ApprovalDetail("command") })).effect), inside);
  assert.match(String(requestView(row("file", S2.stage2ApprovalDetail("file"))).effect), /outside its sandbox/, "a file change keeps the outside-the-sandbox wording");
  // The same kinds without the mark keep their outside-the-sandbox accounting; an MCP tool is never marked.
  assert.match(String(requestView(row("command", ask.detail as never)).effect), /outside the sandbox, with your full access/);
  assert.match(String(requestView(row("file", {})).effect), /outside its sandbox/);
  assert.match(String(requestView(row("mcp", {})).effect), /MCP server you allowed, outside the agent's sandbox/);
});

test("stage 2 gates: the enforcement record round-trips in params_json and shows in status as confined by relay", () => {
  const run = createRun(dir, withDefaults({}), "tok2");
  insertNode({ id: "j_enf00001", run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "t", cwd });
  assert.equal(nodeView(getNode("j_enf00001")!).confinement, undefined);
  S2.recordEnforcement("j_enf00001", 3, "relay");
  assert.deepEqual(sessionParams(getNode("j_enf00001")!).codex_confinement, { turn: 3, enforcement: "relay" });
  assert.deepEqual((nodeView(getNode("j_enf00001")!).confinement as { by: string }).by, "relay");
  S2.recordEnforcement("j_enf00001", 4, "codex");
  assert.deepEqual(sessionParams(getNode("j_enf00001")!).codex_confinement, { turn: 4, enforcement: "codex" });
  assert.equal(nodeView(getNode("j_enf00001")!).confinement, undefined);
  assert.throws(() => S2.recordEnforcement("j_enf00001", 5, "none" as never), /not an enforcement/);
});

test("stage 2 gates: the hard-link check follows the turn's confinement", () => {
  const run = createRun(dir, withDefaults({}), "tok3");
  const wt = path.join(dir, "hl");
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(dir, "outside.txt"), "x");
  fs.linkSync(path.join(dir, "outside.txt"), path.join(wt, "linked.txt"));
  const node = insertNode({ id: "j_hl000001", run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "t", cwd: wt });
  assert.match(hardLinkProblem(node, "write", false, null, undefined) ?? "", /hard link/);
  assert.match(hardLinkProblem(node, "write", false, null, undefined, "verified") ?? "", /hard link/);
  // Relay-enforced: the executor's launch (prepareLaunch) makes the check against its own profile.
  assert.equal(hardLinkProblem(node, "write", false, null, undefined, "relay-enforced"), null);
});

test("stage 2 gates: the skill package is copied to a readable per-turn asset dir outside relay's control directory", () => {
  assert.equal(S2.stage2SkillAssets({}), null);
  const pkg = path.join(process.env.RELAY_HOME!, "ext-1");
  fs.mkdirSync(path.join(pkg, "skills", "one", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "skills", "one", "SKILL.md"), "---\nname: one\n---\n");
  fs.writeFileSync(path.join(pkg, "skills", "one", "scripts", "run.sh"), "echo hi\n");
  const assets = S2.stage2SkillAssets({ skills: { dir: pkg, names: ["one"] } })!;
  try {
    assert.ok(assets.startsWith(path.join(fs.realpathSync(dir), ".relay-t", "relay-ext-")), assets);
    assert.ok(!assets.startsWith(process.env.RELAY_HOME!));
    assert.equal(fs.statSync(assets).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(assets, "skills", "one", "scripts", "run.sh"), "utf8"), "echo hi\n");
    assert.equal(fs.readFileSync(path.join(assets, "skills", "one", "SKILL.md"), "utf8"), "---\nname: one\n---\n");
  } finally {
    fs.rmSync(assets, { recursive: true, force: true });
  }
  // Anything but directories and regular files is refused, and nothing is left behind.
  fs.symlinkSync("/etc/hosts", path.join(pkg, "skills", "one", "link"));
  const before = fs.readdirSync(path.join(dir, ".relay-t")).filter((n) => n.startsWith("relay-ext-"));
  assert.throws(() => S2.stage2SkillAssets({ skills: { dir: pkg, names: ["one"] } }), /neither a directory nor a regular file/);
  assert.deepEqual(fs.readdirSync(path.join(dir, ".relay-t")).filter((n) => n.startsWith("relay-ext-")), before);
  fs.rmSync(path.join(pkg, "skills", "one", "link"));
  assert.throws(() => S2.stage2SkillAssets({ skills: { dir: pkg, names: ["one", "two"] } }), /the skill two has no SKILL\.md|ENOENT/);
});

test("stage 2 gates: the advertised tools must be a subset of the allowlist (per-release qualification)", () => {
  // As seen on 0.164.0 with relay's stage-2 flags (gpt-6.1-sol and gpt-5.6-luna, code_mode_only).
  // The goal tools are gone with `goals` pinned off, and refused if offered.
  const sol = ["functions", "exec", "apply_patch", "exec_command", "list_mcp_resource_templates", "list_mcp_resources", "read_mcp_resource", "view_image", "write_stdin", "clock__curr_time",
    "wait", "request_user_input", "request_user_input_async", "clock", "sleep", "collaboration", "followup_task", "interrupt_agent", "list_agents", "send_message", "spawn_agent", "wait_agent"];
  assert.equal(S2.stage2ToolsProblem(sol), null);
  // ext/web-search's standalone search, offered to code-mode models with OpenAI's provider (WP-F item 10).
  assert.equal(S2.stage2ToolsProblem([...sol, "web", "run", "web__run"]), null);
  // 0.170.0's catalog offers send_message_to_user_async to root turns (an agent message item, no host action).
  assert.equal(S2.stage2ToolsProblem([...sol, "send_message_to_user_async"]), null);
  assert.match(S2.stage2ToolsProblem([...sol, "send_message_to_user"]) ?? "", /not qualified for stage 2: send_message_to_user$/);
  assert.match(S2.stage2ToolsProblem([...sol, "files", "run"]) ?? "", /not qualified for stage 2: files$/, "another namespace's run is caught by its namespace");
  assert.equal(S2.stage2ToolsProblem(["functions", "exec", "apply_patch", "exec_command", "write_stdin", "view_image", "wait", "request_user_input"]), null);
  // Direct mode: the classic list and tool_search.
  assert.equal(S2.stage2ToolsProblem(["exec_command", "write_stdin", "apply_patch", "view_image", "web_search", "update_plan", "tool_search"]), null);
  // The broker namespace and its exact names, in direct mode and nested in code mode.
  assert.equal(S2.stage2ToolsProblem([...sol, "mcp__relay_tools", "status", "ask", "mcp__relay_tools__status"], ["status", "ask"]), null);
  assert.ok(S2.STAGE2_TOOLS.includes("mcp__relay_tools"));
  assert.ok(S2.STAGE2_TOOLS.includes("mcp__relay_tools__status"));
  for (const extra of ["delegate", "mcp__relay_tools__delegate", "mcp__relay_tools__evil", "mcp__relay_tools__approve", "approve"]) {
    assert.match(S2.stage2ToolsProblem([...sol, "mcp__relay_tools", extra], ["status", "ask"]) ?? "", /not qualified for stage 2/, extra);
  }
  // Other MCP namespaces, root-only tools, and goal tools remain refused.
  for (const extra of ["mcp__relay__status", "relay", "mcp__relay__delegate", "create_goal", "get_goal", "update_goal", "multi_env_copy_file", "image_generation", "imagegen", "request_permissions", "request_plugin_install", "list_available_plugins_to_install", "mcp__other__x", "relayx", "js_repl"]) {
    assert.match(S2.stage2ToolsProblem([...sol, extra]) ?? "", new RegExp(`not qualified for stage 2: ${extra}$`), extra);
  }
});

test("stage 2 gates: before resume, nothing queued that Codex would start by itself; an unreadable queue refuses", async () => {
  const rpc = (reply: unknown) => {
    const calls: [string, unknown][] = [];
    return { calls, request: async (m: string, p: unknown) => { calls.push([m, p]); if (reply instanceof Error) throw reply; return reply; } };
  };
  const empty = rpc({ data: [], nextCursor: null });
  assert.equal(await S2.stage2QueueProblem(empty, "th"), null);
  assert.deepEqual(empty.calls, [["thread/queue/list", { threadId: "th", limit: 1 }]]);
  assert.match(await S2.stage2QueueProblem(rpc({ data: [{ id: "q", input: [] }] }), "th") ?? "", /a message is queued for the session in Codex/);
  assert.match(await S2.stage2QueueProblem(rpc({}), "th") ?? "", /did not say whether the session has queued messages/);
  assert.match(await S2.stage2QueueProblem(rpc(new Error("unknown method")), "th") ?? "", /could not read the session's queued messages \(thread\/queue\/list: unknown method\)/);
});

test("stage 2 gates: after turn/start, the thread reads back as bound to relay's executor alone", async () => {
  const rpc = (reply: unknown) => {
    const calls: [string, unknown][] = [];
    return { calls, request: async (m: string, p: unknown) => { calls.push([m, p]); if (reply instanceof Error) throw reply; return reply; } };
  };
  const relayEnv = { environmentId: "relay", cwd, runtimeWorkspaceRoots: [cwd] }, localEnv = { environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd] };
  const bound = rpc({ thread: { id: "th", environments: [relayEnv] } });
  assert.equal(await S2.stage2TurnReadback(bound, "th", cwd, "relay"), null);
  assert.deepEqual(bound.calls, [["thread/read", { threadId: "th", includeTurns: false }]]);
  assert.match(await S2.stage2TurnReadback(rpc({ thread: { environments: [localEnv, relayEnv] } }), "th", cwd, "relay") ?? "", /after relay bound the turn to its sandboxed executor, the thread reports the environments .*only its executor/);
  assert.match(await S2.stage2TurnReadback(rpc({ thread: { environments: [] } }), "th", cwd, "relay") ?? "", /environments \[\]/);
  assert.match(await S2.stage2TurnReadback(rpc({ thread: { environments: [localEnv] } }), "th", cwd, "relay") ?? "", /environment "local"/);
  assert.match(await S2.stage2TurnReadback(rpc({ thread: {} }), "th", cwd, "relay") ?? "", /environments null/);
  assert.match(await S2.stage2TurnReadback(rpc(new Error("gone")), "th", cwd, "relay") ?? "", /could not read back .*thread\/read: gone/);

  // A new thread in a git cwd: thread/read refuses until Codex has written the rollout's first line
  // (as 0.164.0 words it). Retried on that refusal alone, within the deadline; anything else refuses at once.
  const empty = "failed to read thread: thread-store internal error: failed to read session metadata /h/.codex/sessions/rollout-x.jsonl: rollout at /h/.codex/sessions/rollout-x.jsonl is empty";
  const flaky = (fails: number, then: unknown) => {
    const calls: string[] = [];
    return { calls, request: async (m: string) => { calls.push(m); if (calls.length <= fails) throw new Error(empty); return then; } };
  };
  const late = flaky(3, { thread: { environments: [relayEnv] } });
  assert.equal(await S2.stage2TurnReadback(late, "th", cwd, "relay", { retryMs: 1 }), null);
  assert.deepEqual(late.calls, ["thread/read", "thread/read", "thread/read", "thread/read"]);
  const lateWrong = flaky(2, { thread: { environments: [localEnv, relayEnv] } });
  assert.match(await S2.stage2TurnReadback(lateWrong, "th", cwd, "relay", { retryMs: 1 }) ?? "", /only its executor/, "a late read is checked as any other");
  const never = flaky(1e9, null);
  const t0 = Date.now();
  assert.match(await S2.stage2TurnReadback(never, "th", cwd, "relay", { deadlineMs: 60, retryMs: 5 }) ?? "", /within 0 s: Codex had not yet written the thread's session/);
  assert.ok(Date.now() - t0 < 1000 && never.calls.length > 1, `bounded: ${never.calls.length} tries`);
  // Any other error is not waited out.
  const other = { calls: [] as string[], request: async (m: string) => { other.calls.push(m); throw new Error("thread not loaded: th"); } };
  assert.match(await S2.stage2TurnReadback(other, "th", cwd, "relay", { retryMs: 1 }) ?? "", /thread\/read: thread not loaded: th/);
  assert.equal(other.calls.length, 1, "no retry for any other error");
  assert.equal(S2.TURN_READBACK_DEADLINE_MS, 10_000);
});

test("stage 2 gates: a turn Codex starts by itself fails the turn; relay's own and its subagents' do not", () => {
  // Before relay asks for its turn, any turn on any thread is foreign (a goal continuation or a queued message on resume).
  for (const thread of ["main", "child"]) {
    const g = new S2.Stage2TurnGuard();
    assert.match(g.started(thread, "main", "t0") ?? "", /Codex started a turn by itself \("t0"\) before relay had delivered the prompt/);
  }
  // Its own turn, announced before or after the reply; subagents' turns on other threads.
  for (const order of ["notification first", "reply first"]) {
    const g = new S2.Stage2TurnGuard();
    g.request();
    if (order === "notification first") {
      assert.equal(g.started("main", "main", "t1"), null);
      assert.equal(g.replied("t1"), null);
    } else {
      assert.equal(g.replied("t1"), null);
      assert.equal(g.started("main", "main", "t1"), null);
    }
    assert.equal(g.started("child", "main", "c1"), null);
    assert.equal(g.started("child", "main", "c2"), null);
    assert.match(g.started("main", "main", "t2") ?? "", /a second turn \("t2"\) on the session's thread beside relay's \("t1"\)/);
  }
  // Relay's prompt steered into a turn Codex had started: the reply names another turn.
  const steered = new S2.Stage2TurnGuard();
  steered.request();
  assert.equal(steered.started("main", "main", "auto"), null);
  assert.match(steered.replied("mine") ?? "", /went into turn "mine" while Codex had started turn "auto"/);
  const silent = new S2.Stage2TurnGuard();
  silent.request();
  assert.match(silent.replied(undefined) ?? "", /did not say which turn it started/);
});
