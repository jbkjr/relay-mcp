import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { EventEmitter } from "node:events";
import path from "node:path";
import { test } from "node:test";
import { nativeCodexNeverNetworkEntry, nativeCodexShellRoute, neverAdapterProblem } from "../dist/backends/never-admission.js";
import { launchTurn } from "../dist/backends/run.js";
import { codexPermissions } from "../dist/backends/codex.js";
import { configProblem } from "../dist/backends/codex-app.js";
import { NETWORK_MODE_TEXT } from "../dist/backends/codex-network.js";
import { applyClaudeNeverPolicy } from "../dist/backends/claude.js";
import { neverEndpointProblem, neverProfileInputs, resolveNeverPolicy } from "../dist/core/never-policy.js";
import { neverSeatbeltRules } from "../dist/confine/seatbelt-never.js";
import { STAGE2_FLAG_ENV } from "../dist/core/stage2-switch.js";
import { localModeRetired, rawNetworkGrantProblem } from "../dist/core/raw-network.js";
import { withDefaults } from "../dist/core/config.js";
import { targetDef } from "../dist/targets/index.js";
import { turnPolicy } from "../dist/confine/turn.js";
import { seatbeltProfile } from "../dist/confine/seatbelt.js";
import { openProxy } from "../dist/confine/proxy.js";
import { closeDbForTests, createRun, insertNode, insertTurn } from "../dist/core/db.js";
import { requestApproval } from "../dist/core/approvals.js";
import { admitWork } from "../dist/core/caller.js";
import { checkpointNever } from "../dist/core/never-checkpoint.js";
import type { TurnSpec } from "../dist/backends/types.js";

test("WP4: stage 2 keeps known credential/settings bypass refusals and admits native Codex", () => {
  const policy = resolveNeverPolicy({ builtins: false });
  const spec = (id: "codex" | "claude" | "copilot" | "grok" | "gemini", extra = {}) => ({ target: targetDef(id), config: withDefaults({ targets: { codex: { stage2: true } } }), access: "write", neverPolicy: policy, ...extra }) as TurnSpec;
  // Test native admission too: escalation:false keeps network-off turns on native Codex.
  assert.equal(neverAdapterProblem(spec("codex")), null);
  for (const codex_backend of ["app-server", "exec"] as const) for (const grant of [undefined, { network: true }]) {
    assert.equal(neverAdapterProblem(spec("codex", { config: withDefaults({ targets: { codex: { stage2: true } }, escalation: false, codex_backend }), grant })), null);
  }
  assert.match(NETWORK_MODE_TEXT.strict, /trustd.*bypass/);
  assert.equal(neverAdapterProblem(spec("codex", { grant: { network: true, raw_network: true } })), null);
  // Exec's raw-network rejection remains at the grant gate, rather than refusing all exec jobs.
  assert.match(rawNetworkGrantProblem({ network: true, raw_network: true }, "write", "codex", withDefaults({ targets: { codex: { stage2: true } }, codex_backend: "exec" }))!, /needs codex_backend "app-server"/);
  assert.match(neverAdapterProblem(spec("copilot"))!, /KEYCHAIN\/TRUST.*qualified/);
  assert.match(neverAdapterProblem(spec("grok"))!, /token-store\/TRUST.*qualified/);
  assert.equal(neverAdapterProblem(spec("gemini")), null);
  assert.equal(neverAdapterProblem(spec("claude")), null);
  for (const config of [{ allow_dangerous: true }, { child_hooks: true }, { child_settings: "inherit" }, { child_mcp: "inherit" }]) assert.match(neverAdapterProblem(spec("claude", { config: withDefaults({ ...config, targets: { codex: { stage2: true } } } as any) }))!, /never:.*bypass/);
  const hostPolicy = resolveNeverPolicy({ builtins: false, never: { hosts: ["decoy.example"] } });
  assert.match(neverAdapterProblem(spec("gemini", { neverPolicy: hostPolicy, grant: { network: true } }))!, /never.hosts disables raw network/);
  assert.equal(neverAdapterProblem(spec("gemini", { neverPolicy: hostPolicy })), null);
});

test("WP4: switch off admits released ACP/Codex harness variants, refuses Claude's floor-bypassing ones; environment switch restores refusals", () => {
  const saved = process.env[STAGE2_FLAG_ENV];
  try {
    delete process.env[STAGE2_FLAG_ENV];
    const policy = resolveNeverPolicy({ builtins: false, never: { hosts: ["decoy.example"] } });
    for (const id of ["codex", "copilot", "grok", "claude", "gemini"] as const) {
      for (const variant of [{}, { allow_dangerous: true }, { child_hooks: true }, { child_settings: "inherit" }, { child_mcp: "inherit" }, { codex_backend: "exec" }]) for (const grant of [undefined, { network: true }]) {
        const spec = { target: targetDef(id), config: withDefaults({ ...variant, targets: { codex: { stage2: false } } } as any), access: "write", neverPolicy: policy, grant } as TurnSpec;
        if (id === "codex" && (grant?.network || variant.allow_dangerous)) assert.match(neverAdapterProblem(spec)!, /never user.host:decoy.example.*native Codex/);
        // Claude gets the floor whatever stage 2 says (decided 2026-11-04), and with it the variant gates.
        else if (id === "claude" && ("allow_dangerous" in variant || "child_hooks" in variant || "child_settings" in variant || "child_mcp" in variant)) assert.match(neverAdapterProblem(spec)!, /never:.*bypass/, `claude: ${JSON.stringify(variant)}`);
        else assert.equal(neverAdapterProblem(spec), null, `${id}: ${JSON.stringify(variant)}`);
      }
    }
    const spec = { target: targetDef("copilot"), config: withDefaults({}), access: "write", neverPolicy: policy } as TurnSpec;
    process.env[STAGE2_FLAG_ENV] = "1";
    assert.match(neverAdapterProblem(spec)!, /KEYCHAIN\/TRUST/);
    delete process.env[STAGE2_FLAG_ENV];
    const forbidden = resolveNeverPolicy({ builtins: false, never: { paths: [{ path: "/decoy/private" }] } });
    for (const on of [false, true]) {
      spec.config = withDefaults({ targets: { codex: { stage2: on } } });
      assert.match(neverAdapterProblem({ ...spec, neverPolicy: forbidden, grant: { write_paths: ["/decoy/private"] } })!, /never/);
      assert.match(neverAdapterProblem({ ...spec, neverPolicy: { ...forbidden, authorityPins: [{ path: "/decoy/missing", dev: -1, ino: -1, kind: 0 }] } })!, /identity/);
    }
  } finally {
    if (saved === undefined) delete process.env[STAGE2_FLAG_ENV]; else process.env[STAGE2_FLAG_ENV] = saved;
  }
});

test("WP4: stage 2 refuses native dangerous Codex writes while the switch-off route is unchanged", () => {
  const policy = resolveNeverPolicy({ builtins: false });
  const turn = (stage2: boolean, extra = {}) => ({
    target: targetDef("codex"), access: "write", cwd: "/owned/work", neverPolicy: policy,
    config: withDefaults({ allow_dangerous: true, escalation: false, targets: { codex: { stage2 } } }), ...extra,
  }) as TurnSpec;
  assert.match(neverAdapterProblem(turn(true))!, /allow_dangerous.*without stage-2 confinement/);
  assert.match(neverAdapterProblem(turn(true, { sessionId: "resumed-thread" }))!, /allow_dangerous/);
  assert.equal(neverAdapterProblem(turn(false)), null);
  assert.equal(neverAdapterProblem({ ...turn(true), access: "read" }), null);
  assert.equal(neverAdapterProblem({ ...turn(true), grant: { network: true } }), null, "a selected stage-2 route never falls back to native danger-full-access");
});

test("WP4: native Codex refuses unenforceable network floors before initial and resumed launch with either switch", async () => {
  const saved = process.env[STAGE2_FLAG_ENV];
  delete process.env[STAGE2_FLAG_ENV];
  const policy = resolveNeverPolicy({ builtins: false, never: { hosts: ["forbidden.example"] } });
  let launches = 0;
  const backend = { start: async () => { launches++; return { done: Promise.resolve({ status: "ok" }) } as never; } };
  try {
    for (const stage2 of [false, true]) for (const codex_backend of ["app-server", "exec"] as const) {
      // escalation:false affects only network-off origins; standing grants still select stage 2.
      const config = withDefaults({ allow_untested: true, escalation: false, codex_backend, targets: { codex: { stage2, pinned: false } } });
      for (const sessionId of [undefined, "existing-thread"]) for (const access of ["write", "read"] as const) {
        const spec = { target: targetDef("codex"), config, access, sessionId, neverPolicy: policy } as TurnSpec;
        for (const extra of [{ grant: { network: true } }, { config: { ...config, child_network: true } }]) {
          const turn = { ...spec, ...extra };
          if (stage2) {
            assert.equal(neverAdapterProblem(turn), null, "the stage2 provider enforces the host floor");
            await launchTurn(turn.target, turn, backend);
            continue;
          }
          // codex exec read turns have no shell network even when granted it.
          if (access === "read" && codex_backend === "exec") { assert.equal(neverAdapterProblem(turn), null); continue; }
          const why = neverAdapterProblem(turn)!;
          assert.match(why, /never user.host:forbidden.example: native Codex.*cannot enforce/);
          assert.match(why, /Remove the network grant/);
          assert.equal(why.includes("stage-2 mediated route"), stage2);
          if (turn.config.child_network) assert.match(why, /disable child_network/);
          await assert.rejects(launchTurn(turn.target, turn, backend), { message: why });
        }
        assert.equal(neverAdapterProblem(spec), null, "host rules with shell network off are admitted");
        await launchTurn(spec.target, spec, backend);
        const noUserRules = { ...spec, neverPolicy: resolveNeverPolicy({}), grant: { network: true } };
        assert.equal(neverAdapterProblem(noUserRules), null, "built-ins alone preserve admission");
        await launchTurn(spec.target, noUserRules, backend);
      }
    }
    assert.equal(launches, 48, "native refusals stay off the backend; stage2 routes reach backend qualification");
    // child_network on a selected stage-2 route does not turn on the native proxy.
    assert.equal(neverAdapterProblem({ target: targetDef("codex"), config: withDefaults({ child_network: true, targets: { codex: { stage2: true } } }), access: "write", neverPolicy: policy } as TurnSpec), null);
  } finally {
    if (saved === undefined) delete process.env[STAGE2_FLAG_ENV]; else process.env[STAGE2_FLAG_ENV] = saved;
  }
});

test("WP4: native Codex holds the person's this-machine ports like the built-ins, and refuses them where the route opens this Mac", () => {
  const saved = process.env[STAGE2_FLAG_ENV];
  try {
    delete process.env[STAGE2_FLAG_ENV];
    const builtins = resolveNeverPolicy({});
    for (const transport of ["tcp", "udp", "both"] as const) for (const destinations of ["any", "this-machine"] as const) {
      const entry = `user.port:49225/${transport}/${destinations}`;
      const own = resolveNeverPolicy({ never: { ports: [{ port: 49225, transport, destinations }] } });
      // Strict shell network reaches none of this Mac's addresses and sends no UDP: it holds every
      // this-machine entry and every UDP-only one, and cannot hold an "any" entry covering TCP.
      const strictHolds = destinations === "this-machine" || transport === "udp";
      const base = { target: targetDef("codex"), access: "write", neverPolicy: own } as const;
      const off = withDefaults({ targets: { codex: { stage2: false } } });
      const routes: [string, TurnSpec, "strict" | "local" | "unconfined"][] = [
        ["strict write grant", { ...base, config: off, grant: { network: true } } as TurnSpec, "strict"],
        ["strict read grant", { ...base, access: "read", config: off, grant: { network: true } } as TurnSpec, "strict"],
        ["strict exec write grant", { ...base, config: withDefaults({ codex_backend: "exec", targets: { codex: { stage2: false } } }), grant: { network: true } } as TurnSpec, "strict"],
        ["child_network", { ...base, config: withDefaults({ child_network: true, targets: { codex: { stage2: false } } }) } as TurnSpec, "strict"],
        ["local_network", { ...base, config: off, grant: { network: true, local_network: true } } as TurnSpec, "local"],
        ["allow_dangerous", { ...base, config: withDefaults({ allow_dangerous: true, targets: { codex: { stage2: false } } }) } as TurnSpec, "unconfined"],
      ];
      for (const [label, spec, route] of routes) {
        assert.equal(nativeCodexShellRoute(spec), route, label);
        const why = neverAdapterProblem(spec);
        if (route === "strict" && strictHolds) assert.equal(why, null, `${label}: ${entry} is held by strict network`);
        else {
          assert.match(why!, new RegExp(`^never ${entry.replaceAll(".", "\\.")}: native Codex with shell network cannot enforce`), `${label}: ${entry}`);
          if (route === "local") assert.match(why!, /under grant\.local_network, which opens this Mac's loopback and local network.*or give it without local_network/);
          if (route === "unconfined") assert.match(why!, /under allow_dangerous.*disable allow_dangerous/);
          assert.equal(why!.includes("Strict shell network enforces it"), route !== "strict" && strictHolds, `${label}: ${entry} names strict as the way out where it holds`);
        }
        // The built-in this-machine ports keep their admission on every route, as before.
        assert.equal(neverAdapterProblem({ ...spec, neverPolicy: builtins }), null, `${label}: built-ins alone`);
        // Without shell network nothing is refused (local and unconfined always have it).
        if (route === "strict") assert.equal(neverAdapterProblem({ ...spec, grant: undefined, config: { ...spec.config, child_network: false } }), null, `${label}: network off`);
      }
      assert.equal(nativeCodexNeverNetworkEntry(own, "strict"), strictHolds ? null : entry);
      assert.equal(nativeCodexNeverNetworkEntry(own, "local"), entry);
      assert.equal(nativeCodexNeverNetworkEntry(own, "unconfined"), entry);
      for (const route of ["strict", "local", "unconfined"] as const) assert.equal(nativeCodexNeverNetworkEntry(builtins, route), null);
      // Stage 2: relay's sandbox and proxy hold every entry, so no route is refused for one; local
      // mode is refused outright, and allow_dangerous outside the stage-2 route.
      const on = withDefaults({ targets: { codex: { stage2: true } } });
      for (const grant of [{ network: true }, { network: true, raw_network: true }]) assert.equal(neverAdapterProblem({ ...base, config: on, grant } as TurnSpec), null, `stage 2 ${JSON.stringify(grant)}: ${entry}`);
      assert.match(localModeRetired(on)!, /not available while relay's stage 2 is switched on/);
      assert.match(neverAdapterProblem({ ...base, config: withDefaults({ allow_dangerous: true, escalation: false, codex_backend: "exec", targets: { codex: { stage2: true } } }) } as TurnSpec)!, /allow_dangerous would run this write turn without stage-2 confinement/);
    }
  } finally {
    if (saved === undefined) delete process.env[STAGE2_FLAG_ENV]; else process.env[STAGE2_FLAG_ENV] = saved;
  }
});

test("WP4: a this-machine port of the person's is enforced exactly as a built-in one by relay's sandbox and proxy (stage 2, ACP, Claude)", () => {
  const user = resolveNeverPolicy({ builtins: false, never: { ports: [{ port: 22, transport: "both", destinations: "this-machine" }] } });
  const builtin = resolveNeverPolicy({ builtins: false });
  const sshd = resolveNeverPolicy({}).ports.find(p => p.id === "service.sshd")!;
  assert.deepEqual({ ...sshd, id: "" }, { ...user.ports[0], id: "" }, "the same rule but for its name");
  // Relay's Seatbelt (stage-2 raw and mediated, Copilot, Gemini and Grok): the same deny rules.
  const rules = (policy: typeof user) => neverSeatbeltRules(policy, (_k, v) => v, "", { worktree: "/owned/work", tmpDir: "/owned/tmp" });
  const userRules = rules(user), noRules = rules(builtin);
  assert.ok(userRules.length > noRules.length);
  assert.deepEqual(rules({ ...builtin, ports: [sshd] } as typeof user), userRules);
  // Relay's proxy (stage-2 mediated, Claude, ACP): every address of this Mac's refused, other hosts' port 22 not.
  const local = os.networkInterfaces();
  const mine = Object.values(local).flatMap(list => list ?? []).find(a => a.family === "IPv4" && !a.internal)?.address;
  for (const host of ["127.0.0.1", "localhost", "0.0.0.0", ...(mine ? [mine] : [])]) {
    for (const transport of ["tcp", "udp"] as const) assert.match(neverEndpointProblem(user, { host, port: 22, transport })!, /never user\.port:22\/both\/this-machine/, host);
  }
  assert.match(neverEndpointProblem(user, { host: "example.com", port: 22, transport: "tcp", operation: "listen" })!, /never user\.port/, "never bound");
  assert.equal(neverEndpointProblem(user, { host: "192.0.2.10", port: 22, transport: "tcp", addresses: ["192.0.2.10"] }), null, "another host's ssh is not this Mac's");
  // Admission: no target refuses it; relay's sandbox or proxy holds it.
  for (const stage2 of [false, true]) for (const id of ["gemini", "claude"] as const) {
    const config = withDefaults({ child_settings: "isolated", child_hooks: false, child_mcp: "relay-only", targets: { codex: { stage2 } } } as any);
    for (const grant of [undefined, { network: true }]) assert.equal(neverAdapterProblem({ target: targetDef(id), config, access: "write", neverPolicy: user, grant } as TurnSpec), null, `${id} stage2 ${stage2}`);
  }
});

test("WP4: resume admission rechecks new and kept network grants against the cumulative host floor", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wp4-resume-")));
  const saved = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG, [STAGE2_FLAG_ENV]: process.env[STAGE2_FLAG_ENV] };
  try {
    delete process.env[STAGE2_FLAG_ENV];
    process.env.RELAY_HOME = path.join(home, "registry"); process.env.RELAY_CONFIG = path.join(home, "config.json");
    for (const stage2 of [false, true]) {
      const cfg = withDefaults({ targets: { codex: { stage2 } }, escalation: false });
      fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
      const run = createRun(home, cfg, "unit");
      const caller = { runId: run, node: null } as never;
      assert.deepEqual(admitWork(caller, "codex", { mode: "write", kept: { network: true }, continues: true }, {}), { grant: undefined });
      // A newly observed host deny must screen a grant kept from a previous turn.
      fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ ...cfg, never: { hosts: ["forbidden.example"] } }));
      for (const extra of [{ grant: { network: true } }, { kept: { network: true } }]) {
        const answer = admitWork(caller, "codex", { mode: "write", continues: true, ...extra }, {}) as { reason: string };
        if (stage2) { assert.equal(answer.reason, undefined); continue; }
        assert.match(answer.reason, /never user.host:forbidden.example.*cannot enforce/);
        assert.match(answer.reason, /grant is kept/);
      }
      fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
      const kept = admitWork(caller, "codex", { mode: "write", kept: { network: true }, continues: true }, {}) as { reason: string };
      const launchProblem = neverAdapterProblem({ target: targetDef("codex"), config: cfg, access: "write", sessionId: "existing-thread", grant: { network: true }, neverPolicy: checkpointNever(run, "launch") } as TurnSpec);
      assert.ok(checkpointNever(run, "launch").hosts.some(h => h.host === "forbidden.example"), "removing live config never shrinks the run floor");
      if (stage2) { assert.equal(kept.reason, undefined); assert.equal(launchProblem, null); }
      else { assert.match(kept.reason, /user.host:forbidden.example/); assert.match(launchProblem!, /user.host:forbidden.example/); }
      assert.deepEqual(admitWork(caller, "codex", { mode: "write", continues: true }, {}), { grant: undefined });
    }
  } finally {
    closeDbForTests(); for (const [k,v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("WP4: native Codex profiles carry built-in and user never paths and readback rejects missing denies", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wp4-codex-")));
  try {
    const policy = resolveNeverPolicy({ home, never: { paths: [{ path: path.join(home, "private") }, { path: path.join(home, "install"), access: "write" }] } });
    const floor = neverProfileInputs(policy);
    for (const access of ["read", "write"] as const) for (const codex_backend of ["app-server", "exec"] as const) {
      const permissions = codexPermissions({ access, config: withDefaults({ codex_backend }), neverPolicy: policy }, { dangerous: false, network: false, roots: [home] });
      const filesystem = permissions.profile!.filesystem;
      const baseline = codexPermissions({ access, config: withDefaults({ codex_backend }) }, { dangerous: false, network: false, roots: [home] }).profile!.filesystem;
      for (const p of floor.denyAll) assert.equal(filesystem[p], "deny", p);
      for (const p of floor.denyWrite) assert.equal(filesystem[p], floor.denyAll.includes(p) || baseline[p] === "deny" ? "deny" : "read", p);
      assert.equal(filesystem[path.join(home, ".claude/.credentials.json")], "deny");
      const eff = { approvals_reviewer: "user", default_permissions: permissions.id, permissions: { [permissions.id]: structuredClone(permissions.profile) } };
      const expect = { permissions, relay: null, relayOnly: false, accountLogin: false };
      assert.equal(configProblem(eff, expect), null);
      delete eff.permissions[permissions.id]!.filesystem[path.join(home, "private")];
      assert.match(configProblem(eff, expect)!, /permission profile/);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("WP4: Claude compiles final shared all/write floor into shell and file-tool denies and closes unsandboxed retries", () => {
  const policy = resolveNeverPolicy({ builtins: false, never: { paths: [{ path: "/decoy/private" }, { path: "/decoy/install", access: "write" }], hosts: ["decoy.example"] } });
  const sandbox = { filesystem: { denyRead: ["/existing/read"], denyWrite: ["/existing/write"], allowWrite: ["/decoy"] }, allowUnsandboxedCommands: true };
  const deny: string[] = []; applyClaudeNeverPolicy(policy, sandbox, deny);
  assert.deepEqual(sandbox.filesystem.denyRead, ["/existing/read", "/decoy/private"]);
  assert.deepEqual(new Set(sandbox.filesystem.denyWrite), new Set(["/existing/write", "/decoy/private", "/decoy/install"]));
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  for (const rule of ["Read(//decoy/private)", "Edit(//decoy/private/**)", "Edit(//decoy/install)", "WebSearch", "WebFetch"]) assert.ok(deny.includes(rule), rule);
  assert.ok(!deny.includes("Read(//decoy/install)"), "write-only X1 remains readable");
});

test("WP4: ACP outer profiles receive the exact shared floor and final parameterized denies", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wp4-profile-")));
  try {
    const tmp = path.join(home, "tmp"), work = path.join(home, "work"); fs.mkdirSync(tmp); fs.mkdirSync(work);
    const policy = resolveNeverPolicy({ builtins: false, never: { paths: [{ path: path.join(home, "secret") }], ports: [{ port: 49225 }] } });
    const outer = turnPolicy({ cwd: work, access: "write", target: targetDef("gemini"), neverPolicy: policy, config: withDefaults({ targets: { codex: { stage2: true } } }) }, { stateDirs: [], keychain: false }, tmp, { mode: "on" }, home, "Gemini");
    assert.equal(outer.neverPolicy, policy);
    const compiled = seatbeltProfile(outer);
    assert.ok(compiled.params.some(([, value]) => value === path.join(home, "secret")));
    assert.ok(compiled.params.some(([, value]) => value === "49225"));
    assert.match(compiled.profile, /deny file-read\* file-read-data file-read-metadata file-test-existence.*NEVER_ALL_0/);
    assert.ok(compiled.profile.lastIndexOf("NEVER_ALL_0") > compiled.profile.lastIndexOf("(allow file-write*"), "floor follows applicable write allows");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("WP4: switch off preserves ACP credential/TRUST profile allows without experimental final denies", () => {
  const saved = process.env[STAGE2_FLAG_ENV];
  try {
    delete process.env[STAGE2_FLAG_ENV];
    for (const id of ["copilot", "grok"] as const) {
      const outer = turnPolicy({ cwd: "/decoy/work", access: "read", target: targetDef(id), neverPolicy: resolveNeverPolicy({ builtins: false }), config: withDefaults({}) }, { stateDirs: [], keychain: id === "copilot", certificateTrust: true }, "/decoy/tmp", { mode: "on" }, "/decoy/home", id);
      assert.equal(outer.neverPolicy, undefined);
      assert.equal(outer.certificateTrust, true);
      assert.equal(outer.keychain, id === "copilot");
    }
  } finally { if (saved === undefined) delete process.env[STAGE2_FLAG_ENV]; else process.env[STAGE2_FLAG_ENV] = saved; }
});

const CLAUDE_COMMAND_NOTE = "never: Claude command approvals are unavailable under the never floor, so this request was refused and nobody was asked. " +
  "Continue with the work your sandbox permits, report what you needed (under Open issues, or in your final message), or have the root session or the person arrange the work another supported way.";

test("WP4: Claude permission-tool command requests, sandboxed or not, are refused before consent with stage 2 off and on, with one accurate note; a Codex command request keeps its own route", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wp4-approval-")));
  const saved = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  try {
    process.env.RELAY_HOME = path.join(home, "registry"); process.env.RELAY_CONFIG = path.join(home, "config.json");
    for (const on of [false, true]) {
      const cfg = withDefaults({ targets: { codex: { stage2: on } }, escalation: false }); fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
      const run = createRun(home, cfg, "unit");
      // A request asking to leave the sandbox, and one Claude's permission tool marks as staying in
      // it (targets/claude.ts toAsk): both refused, with the same note.
      for (const [name, detail] of [["unsandboxed", undefined], ["sandboxed", { sandboxed: true }]] as const) {
        const id = `j_claude_${on}_${name}`;
        insertNode({ id, run_id: run, kind: "job", target: "claude", mode: "write", depth: 1, status: "running", cwd: home, task: "unit" });
        const turn = insertTurn(id, "initial", "unit", "write", "running");
        const answer = await requestApproval(id, turn, { kind: "command", summary: "node build.js", ...(detail ? { detail } : {}) });
        assert.equal(answer.allow, false, `${name}, stage 2 ${on}`);
        assert.equal(answer.note, CLAUDE_COMMAND_NOTE, `${name}, stage 2 ${on}`);
        // Not true of a sandboxed request, and restart overlays exist only for Codex.
        assert.doesNotMatch(answer.note!, /outside the checked sandbox|restart overlay/, `${name}, stage 2 ${on}`);
      }
      // A Codex command request does not take Claude's note: it reaches the generic route, which
      // answers here (escalation off) as it did before.
      const codex = `j_codex_${on}`;
      insertNode({ id: codex, run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, status: "running", cwd: home, task: "unit" });
      const codexTurn = insertTurn(codex, "initial", "unit", "write", "running");
      const codexAnswer = await requestApproval(codex, codexTurn, { kind: "command", summary: "node build.js", detail: { sandboxed: true } });
      assert.deepEqual(codexAnswer, { allow: false, note: "approval requests are turned off; report what you needed under Open issues" });
    }
  } finally { closeDbForTests(); for (const [k,v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; fs.rmSync(home, { recursive: true, force: true }); }
});

test("WP4: proxy seam opens with the shared never floor and keeps dual-loopback binding", async t => {
  const bindings = [];
  t.mock.method(net, "createServer", () => Object.assign(new EventEmitter(), {
    listen(options, cb) { bindings.push(options); cb(); },
    address: () => ({ port: 49202 }), close(cb) { cb(); },
  }));
  const proxy = await openProxy({ mode: "public", allow: [], neverPolicy: resolveNeverPolicy({ builtins: false }) });
  try {
    assert.deepEqual(bindings, [{ host: "127.0.0.1", port: 0, ipv6Only: false }, { host: "::1", port: 49202, ipv6Only: true }]);
    assert.equal(proxy.port, 49202);
  } finally { await proxy.close(); }
});
