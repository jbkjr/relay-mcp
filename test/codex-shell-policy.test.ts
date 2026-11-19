import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { harness } from "./helpers.ts";
import { withDefaults } from "../dist/core/config.js";
import { selectEnvironment } from "../dist/core/env-policy.js";
import { withTurnSecrets } from "../dist/core/secrets.js";
import { codexBackend } from "../dist/backends/codex.js";
import { launchTurn } from "../dist/backends/run.js";
import { targetDef } from "../dist/targets/index.js";
import { codexPatternMatches, codexShellPolicyNote, codexShellPolicyVerdict } from "../dist/backends/codex-shell-policy.js";
import type { TurnSpec } from "../dist/backends/types.js";

// Codex 0.163.0's shell_environment_policy, as config/read reports it (every unset field null).
const DEFAULT = { inherit: null, ignore_default_excludes: null, exclude: null, set: null, include_only: null, filters: null, experimental_use_profile: null };
// A restrictive personal shape (a real ~/.codex/config.toml, 2026-10-22), under which `printenv SMOKE_CANARY` printed nothing.
const RESTRICTIVE = { ...DEFAULT, inherit: "core", exclude: ["*KEY*", "*TOKEN*", "*SECRET*", "AWS_*", "GCP_*", "AZURE_*"], include_only: ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_*"] };
const withheld = (policy: unknown, names: string[]) => {
  const v = codexShellPolicyVerdict(policy, names);
  assert.equal(v.known, true, JSON.stringify(v));
  return Object.fromEntries((v as { withheld: { name: string; reasons: string[] }[] }).withheld.map((w) => [w.name, w.reasons]));
};

test("codex shell policy: patterns match as wildmatch 2.6.1 does, whole name, ignoring case", () => {
  for (const [p, n, m] of [
    ["*TOKEN*", "GH_TOKEN", true], ["*TOKEN*", "gh_token", true], ["*token*", "NPM_TOKEN_X", true], ["AWS_*", "AWS_PROFILE", true], ["AWS_*", "MY_AWS_X", false],
    ["LC_?", "LC_A", true], ["LC_?", "LC_AB", false], ["PATH", "PATH", true], ["PATH", "PATHX", false], ["PATH", "path", true],
    ["*", "", true], ["", "", true], ["", "X", false], ["A*B*C", "AXXBYYC", true], ["A*B*C", "AXXBYY", false], ["**K", "KKK", true],
    ["\\*", "*", false], ["[A]", "A", false], ["[A]", "[a]", true],
  ] as const) assert.equal(codexPatternMatches(p, n), m, `${p} ~ ${n}`);
});

test("codex shell policy: the maintainer's shape (core, include_only, excludes) withholds a released name, with its reasons", () => {
  const w = withheld(RESTRICTIVE, ["SMOKE_CANARY", "HOME", "GH_TOKEN", "LC_TIME", "JAVA_HOME"]);
  assert.deepEqual(w.SMOKE_CANARY, ['not inherited: inherit = "core"', "matches no include_only pattern"]);
  assert.deepEqual(w.GH_TOKEN, ['not inherited: inherit = "core"', 'matches exclude "*TOKEN*"', "matches no include_only pattern"]);
  assert.deepEqual(w.LC_TIME, ['not inherited: inherit = "core"'], "LC_* is included, but core does not inherit LC_TIME");
  assert.ok(w.JAVA_HOME);
  assert.equal(w.HOME, undefined, "HOME is inherited under core and included");
  // Core names are compared ignoring ASCII case, as Codex does.
  assert.equal(withheld({ ...RESTRICTIVE, include_only: null, exclude: null }, ["home"]).home, undefined);
  const note = codexShellPolicyNote(RESTRICTIVE, ["SMOKE_CANARY"])!;
  assert.match(note, /^Codex will not pass this name relay released for this turn to the commands it runs: SMOKE_CANARY \(not inherited: inherit = "core"; matches no include_only pattern\)\. Relay gave it to Codex's process\. To let a name through, change shell_environment_policy \(inherit, include_only, exclude, set\) in Codex's own config; relay does not override it\.$/);
});

test("codex shell policy: Codex's default policy withholds nothing, since its default excludes are off by default", () => {
  for (const policy of [DEFAULT, {}]) {
    assert.deepEqual(withheld(policy, ["GH_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "JAVA_HOME", "SMOKE_CANARY"]), {});
    assert.equal(codexShellPolicyNote(policy, ["GH_TOKEN", "SMOKE_CANARY"]), null);
  }
  // experimental_use_profile is read nowhere in 0.163.0 or 0.164.0: it changes nothing.
  assert.deepEqual(withheld({ ...DEFAULT, experimental_use_profile: true }, ["GH_TOKEN"]), {});
});

test("codex shell policy: ignore_default_excludes = false drops *KEY*, *SECRET* and *TOKEN* names", () => {
  const w = withheld({ ...DEFAULT, ignore_default_excludes: false }, ["GH_TOKEN", "OPENAI_API_KEY", "my_secret", "JAVA_HOME"]);
  assert.deepEqual(w.GH_TOKEN, ["matches Codex's default exclude *TOKEN*, on with ignore_default_excludes = false"]);
  assert.deepEqual(w.OPENAI_API_KEY, ["matches Codex's default exclude *KEY*, on with ignore_default_excludes = false"]);
  assert.deepEqual(w.my_secret, ["matches Codex's default exclude *SECRET*, on with ignore_default_excludes = false"]);
  assert.equal(w.JAVA_HOME, undefined);
  assert.deepEqual(withheld({ ...DEFAULT, ignore_default_excludes: true }, ["GH_TOKEN"]), {});
});

test("codex shell policy: set replaces a released value by exact name; inherit none; Codex's own names", () => {
  const set = { ...DEFAULT, set: { GH_HOST: "synthetic-set-value-61834" } };
  assert.deepEqual(withheld(set, ["GH_HOST", "gh_host"]), { GH_HOST: ["replaced by shell_environment_policy.set"] }, "exact name on Unix");
  const note = codexShellPolicyNote(set, ["GH_HOST"])!;
  assert.match(note, /GH_HOST \(replaced by shell_environment_policy\.set\)/);
  assert.doesNotMatch(note, /synthetic-set-value/, "names and reasons only, never a value");
  // A set entry is still subject to include_only.
  assert.deepEqual(withheld({ ...set, include_only: ["PATH"] }, ["GH_HOST"]).GH_HOST, ["replaced by shell_environment_policy.set", "matches no include_only pattern"]);
  assert.deepEqual(withheld({ ...DEFAULT, inherit: "none" }, ["PATH", "X"]), { PATH: ['not inherited: inherit = "none"'], X: ['not inherited: inherit = "none"'] });
  const own = withheld(DEFAULT, ["node_repl_auth_token", "PAGER", "CODEX_THREAD_ID", "LANG"]);
  assert.deepEqual(own.node_repl_auth_token, ["Codex never passes it to commands"]);
  assert.deepEqual(own.PAGER, ["Codex sets it itself for every command"]);
  assert.deepEqual(own.CODEX_THREAD_ID, ["Codex sets it itself for every command"]);
  assert.deepEqual(own.LANG, ["Codex sets it itself for every command"]);
  const ownNote = codexShellPolicyNote(DEFAULT, ["PAGER"])!;
  assert.match(ownNote, /PAGER \(Codex sets it itself for every command\)\. Relay gave it to Codex's process\.$/, "no policy remedy for Codex's own handling");
});

test("codex shell policy: the filters form, include and exclude, matched ignoring case", () => {
  const filters = { ...DEFAULT, filters: { "AWS_*": "exclude", "smoke_*": "include", PATH: "include" } };
  const w = withheld(filters, ["SMOKE_CANARY", "AWS_PROFILE", "JAVA_HOME", "PATH"]);
  assert.equal(w.SMOKE_CANARY, undefined);
  assert.equal(w.PATH, undefined);
  assert.deepEqual(w.AWS_PROFILE, ['matches the exclude filter "AWS_*"', "matches no include filter"]);
  assert.deepEqual(w.JAVA_HOME, ["matches no include filter"]);
  // Only exclude filters: no include_only.
  assert.deepEqual(withheld({ ...DEFAULT, filters: { "*TOKEN*": "exclude" } }, ["GH_TOKEN", "JAVA_HOME"]), { GH_TOKEN: ['matches the exclude filter "*TOKEN*"'] });
});

test("codex shell policy: a shape relay does not recognise is cannot tell for every name, never a guess", () => {
  for (const [policy, why] of [
    [undefined, /did not report its shell_environment_policy/],
    [null, /not a table/],
    ["core", /not a table/],
    [{ ...DEFAULT, inherit_from: "core" }, /a field relay does not know \(inherit_from\)/],
    [{ ...DEFAULT, inherit: "some" }, /inherit is not of a type/],
    [{ ...DEFAULT, ignore_default_excludes: "no" }, /ignore_default_excludes is not of a type/],
    [{ ...DEFAULT, exclude: "AWS_*" }, /exclude is not of a type/],
    [{ ...DEFAULT, include_only: [1] }, /include_only is not of a type/],
    [{ ...DEFAULT, set: { A: 1 } }, /set is not of a type/],
    [{ ...DEFAULT, filters: { A: "maybe" } }, /filters is not of a type/],
    [{ ...DEFAULT, filters: { A: "include" }, exclude: ["B"] }, /mixes filters with exclude or include_only/],
    [{ ...DEFAULT, filters: { A: "include", a: "exclude" } }, /repeats a pattern ignoring case/],
    [{ ...DEFAULT, experimental_use_profile: "yes" }, /experimental_use_profile is not of a type/],
  ] as [unknown, RegExp][]) {
    const v = codexShellPolicyVerdict(policy, ["SMOKE_CANARY"]);
    assert.equal(v.known, false, JSON.stringify(policy));
    assert.match((v as { why: string }).why, why);
    const note = codexShellPolicyNote(policy, ["SMOKE_CANARY", "GH_TOKEN"])!;
    assert.match(note, /^Relay cannot tell whether Codex passes GH_TOKEN, SMOKE_CANARY, released for this turn, to the commands it runs: .*relay does not override it\.$/);
  }
});

test("codex shell policy: no released names, no note", () => {
  for (const policy of [RESTRICTIVE, DEFAULT, undefined, { bogus: true }]) assert.equal(codexShellPolicyNote(policy, []), null);
});

// Turns: the note on the app server and on the exec fallback's preflight, for names relay
// released from child_env.pass and from a person-approved grant.env, through the real backend.

/** A scratch home and work directory, and Codex stubs whose config/read reports a policy (set inside the wrapper, so it is no released name). */
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rsp-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), cwd = path.join(root, "work");
  for (const d of [home, cwd]) fs.mkdirSync(d);
  const saved = { HOME: process.env.HOME, RELAY_HOME: process.env.RELAY_HOME };
  process.env.HOME = home;
  process.env.RELAY_HOME = path.join(root, "control");
  fs.mkdirSync(process.env.RELAY_HOME);
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const stubs = path.resolve(import.meta.dirname, "stubs");
  const href = (file: string) => JSON.stringify(pathToFileURL(path.join(stubs, file)).href);
  let n = 0;
  /** A Codex stub reporting `policy`, or Codex's default (all null) when it is undefined. */
  const bin = (policy?: unknown) => {
    const file = path.join(root, `codex-${n++}`);
    fs.writeFileSync(file, `#!${process.execPath}
process.env.STUB_DIR=${JSON.stringify(root)};
${policy === undefined ? "" : `process.env.STUB_CODEX_SHELL_POLICY=${JSON.stringify(JSON.stringify(policy))};`}
const {main}=await import(${href("stub-agent.mjs")});
const {default:target}=await import(${href("targets/codex.mjs")});
await main(target);
`, { mode: 0o755 });
    return file;
  };
  return { root, home, cwd, bin };
}

const CANARY = "synthetic-released-value-90417";
for (const backend of ["app-server", "exec"] as const) {
  test(`codex shell policy: ${backend} turns note released names (pass and grant.env) the policy withholds, by name only`, async (t) => {
    const f = fixture(t);
    const config = withDefaults({
      allow_untested: process.platform !== "darwin", codex_backend: backend,
      child_env: { pass: ["JAVA_HOME", "NPM_TOKEN"] }, targets: { codex: { bin: f.bin({ ...DEFAULT, exclude: ["*TOKEN*"] }), pinned: false, child_env: { request: ["GH_TOKEN"] } } },
    });
    const rootEnv = { PATH: process.env.PATH, HOME: f.home, JAVA_HOME: "/synthetic/java", NPM_TOKEN: CANARY, GH_TOKEN: CANARY };
    let sessionId: string | undefined;
    const notes: string[][] = [];
    // The first turn has the person's consent for GH_TOKEN; the resumed one does not.
    for (const requested of [["GH_TOKEN"], []]) {
      const selected = selectEnvironment("codex", config, rootEnv, requested);
      const turn: string[] = [];
      const spec = {
        target: targetDef("codex"), prompt: "synthetic", cwd: f.cwd, access: "read", relay: null, dir: f.root, logPath: path.join(f.root, "agent.log"),
        config, markers: { runId: "r", nodeId: "n", depth: 1 }, environment: selected.env, environmentReleased: selected.releasedNames, sessionId,
        grant: { env: requested }, onNote: (n: string) => turn.push(n),
      } as TurnSpec;
      const result = await withTurnSecrets(async () => (await launchTurn(targetDef("codex"), spec, codexBackend)).done);
      assert.equal(result.status, "ok", `${result.error ?? ""}\n${fs.readFileSync(spec.logPath, "utf8")}`);
      sessionId = result.sessionId;
      notes.push(turn);
    }
    const policy = notes.map((n) => n.filter((x) => /shell_environment_policy/.test(x)));
    assert.equal(policy[0].length, 1, JSON.stringify(notes));
    assert.match(policy[0][0], /^Codex will not pass these names relay released for this turn to the commands it runs: GH_TOKEN \(matches exclude "\*TOKEN\*"\), NPM_TOKEN \(matches exclude "\*TOKEN\*"\)\. /);
    assert.doesNotMatch(policy[0][0], /JAVA_HOME/, "a released name the policy lets through is not named");
    assert.equal(policy[1].length, 1);
    assert.match(policy[1][0], /: NPM_TOKEN \(matches exclude "\*TOKEN\*"\)\. Relay gave it/, "the standing pass only, once the one-turn consent is gone");
    for (const n of notes.flat()) assert.ok(!n.includes(CANARY), "never a value");
  });

  test(`codex shell policy: ${backend} turns with no released names, or a policy that withholds none, get no note`, async (t) => {
    const f = fixture(t);
    for (const [pass, policy] of [[[], RESTRICTIVE], [["JAVA_HOME"], undefined]] as [string[], unknown][]) {
      const config = withDefaults({ allow_untested: process.platform !== "darwin", codex_backend: backend, child_env: { pass }, targets: { codex: { bin: f.bin(policy), pinned: false } } });
      const selected = selectEnvironment("codex", config, { PATH: process.env.PATH, HOME: f.home, JAVA_HOME: "/synthetic/java" });
      const notes: string[] = [];
      const spec = {
        target: targetDef("codex"), prompt: "synthetic", cwd: f.cwd, access: "read", relay: null, dir: f.root, logPath: path.join(f.root, "agent.log"),
        config, markers: { runId: "r", nodeId: "n", depth: 1 }, environment: selected.env, environmentReleased: selected.releasedNames, onNote: (n: string) => notes.push(n),
      } as TurnSpec;
      const result = await withTurnSecrets(async () => (await launchTurn(targetDef("codex"), spec, codexBackend)).done);
      assert.equal(result.status, "ok", result.error);
      assert.deepEqual(notes, [], JSON.stringify({ pass, policy }));
    }
  });

  test(`codex shell policy: ${backend} jobs show the note in result and status (the maintainer's shape), and cannot tell where Codex reports no policy`, async () => {
    const h = await harness([], { codex_backend: backend, child_env: { pass: ["SMOKE_CANARY"] } }, { SMOKE_CANARY: CANARY, STUB_CODEX_SHELL_POLICY: JSON.stringify(RESTRICTIVE) });
    try {
      const r = await h.call("ask", { target: "codex", message: "printenv SMOKE_CANARY" });
      assert.ok(r.reply, JSON.stringify(r));
      const note = (r.notes ?? []).find((n: string) => /shell_environment_policy/.test(n));
      assert.match(note, /^Turn \d+: Codex will not pass these names relay released for this turn to the commands it runs: .*SMOKE_CANARY \(not inherited: inherit = "core"; matches no include_only pattern\)/);
      assert.ok(!JSON.stringify(r).includes(CANARY), "never a value");
      assert.deepEqual((await h.call("status", { id: r.thread_id })).notes, r.notes);
      const omitted = await (await h.instance({ env: { STUB_CODEX_SHELL_POLICY: JSON.stringify("omit") } })).call("ask", { target: "codex", message: "again" });
      assert.ok((omitted.notes ?? []).some((n: string) => /^Turn \d+: Relay cannot tell whether Codex passes .*SMOKE_CANARY.*: Codex did not report its shell_environment_policy/.test(n)), JSON.stringify(omitted));
    } finally { await h.close(); }
  });
}
