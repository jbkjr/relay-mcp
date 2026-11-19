import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ESCALATION_CASES, RELEASE_CHECK_CASES, judgeTestRun, runEscalationSuite } from "../scripts/codex-qualify/stage2-escalation-cases.mjs";
import { ITEMS, escalationParts, item } from "../scripts/codex-qualify/codex-stage2.mjs";
import { EXPECTED_PARTS, judgeVerdict } from "../scripts/codex-qualify/codex-pin-store.mjs";
import { report } from "../experiments/stage2-redteam/lib/report.mjs";
import { assertHostileWebEvidence } from "./fixtures/stage2-hostile-web.mjs";
import { codexProcesses, descendants, fileSize, frozenAfter, psTable, refusedBesideControl, snapshotFixtureAssets, tokenLeakHits } from "../experiments/stage2-redteam/lib/oracles.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const summary = (pass = 3, more = {}) => {
  const counts = { tests: pass, pass, fail: 0, skipped: 0, cancelled: 0, todo: 0, ...more };
  return Object.entries(counts).map(([k,v]) => `# ${k} ${v}`).join("\n");
};
test("red-team: setup refusal and swallowed hook failures cannot pass absence-only checks", t => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const checks = [{ name: "no outside marker", pass: true }];
  assert.equal(report("refused", checks, { modelRequests: [], outputs: [], result: { status: "failed" } }), false);
  assert.ok(lines.filter(l => l.includes("no outside marker")).every(l => l.includes("[XX]")), "vacuous checks are not printed as ok");
  assert.equal(report("hook failure", checks, { modelRequests: [{}], outputs: ["output"], modelErrors: ["positive control missing"] }), false);
  assert.equal(report("exercised", checks, { modelRequests: [{}], outputs: ["actual tool output"], modelErrors: [] }), true);
});

test("red-team: immutable prelaunch fixture bytes are not token leaks; changed assets and new files still fail", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redteam-oracle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asset = path.join(dir, "codex-source");
  fs.writeFileSync(asset, `authBearerToken protocol field; public binary digest ${"a".repeat(64)}`);
  const baseline = snapshotFixtureAssets([dir]);
  assert.deepEqual(tokenLeakHits({ dirs: [dir], baseline }), []);
  fs.writeFileSync(path.join(dir, "leak"), "b".repeat(64));
  assert.ok(tokenLeakHits({ dirs: [dir], baseline }).some(h => h.label.endsWith("/leak")));
  fs.appendFileSync(asset, "changed");
  assert.ok(tokenLeakHits({ dirs: [dir], baseline }).some(h => /asset changed/.test(h.why)));
  fs.unlinkSync(asset);
  assert.ok(tokenLeakHits({ dirs: [dir], baseline }).some(h => /asset removed/.test(h.why)));
});

test("red-team: a tick file never written, or written and still growing, does not pass as frozen after teardown", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redteam-tick-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tick = path.join(dir, "tick");
  // The ticking loop never ran: two reads of a missing file are not a frozen file.
  assert.equal(frozenAfter(fileSize(tick), fileSize(tick)), false);
  fs.writeFileSync(tick, "");
  assert.equal(frozenAfter(fileSize(tick), fileSize(tick)), false, "an empty tick file shows no writer either");
  fs.writeFileSync(tick, "xxx");
  const before = fileSize(tick);
  assert.equal(frozenAfter(before, fileSize(tick)), true);
  fs.appendFileSync(tick, "x");
  assert.equal(frozenAfter(before, fileSize(tick)), false);
});

test("red-team: a process table ps could not read fails the survivor checks instead of listing nothing", t => {
  const answers = [{ status: 1, stdout: "", stderr: "ps: failed" }, { status: null, error: Object.assign(new Error("spawnSync /bin/ps ENOBUFS"), { code: "ENOBUFS" }), stdout: "1 0 /sbin/launchd\n" }, { status: 0, stdout: "" }];
  let answer = answers[0];
  t.mock.method(childProcess, "spawnSync", (() => answer) as never);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const a of answers) {
    answer = a;
    assert.throws(() => psTable(), /process table/, JSON.stringify(a.status));
    assert.throws(() => descendants(process.pid), /process table/);
    assert.throws(() => codexProcesses(), /process table/);
  }
  answer = { status: 0, stdout: `  1     0 /sbin/launchd\n${process.pid}     1 node test\n` };
  assert.deepEqual(psTable().map(p => p.pid), [1, process.pid]);
});

test("red-team: an nc connect counts as refused only beside its positive control in the same output", () => {
  // nc that never ran (127), or a turn whose shell failed, also prints a non-zero code.
  assert.equal(refusedBesideControl("deny=127\n", "deny"), false);
  assert.equal(refusedBesideControl("self_block=1\ndeny=1\n", "deny"), false, "a control that could not connect either cannot tell");
  assert.equal(refusedBesideControl("self_block=0\n", "deny"), false, "the connect itself was not attempted");
  assert.equal(refusedBesideControl("self_block=0\ndeny=0\n", "deny"), false, "the connect reached the port");
  assert.equal(refusedBesideControl("Output:\nself_block=0\nvictim_port=1\n", "victim_port"), true);
  assert.equal(refusedBesideControl("rc self_block=0\ndeny=1\n", "deny"), true);
});

test("hostile web evidence requires tool advertisements and both actual refusal outputs", () => {
  const body = { tools: [{ type: "function", name: "exec_command" }] };
  const refused = ["unknown tool web_search", "unknown tool web.run"];
  assert.doesNotThrow(() => assertHostileWebEvidence("direct", [body], refused));
  for (const [bodies, outputs] of [[[], refused], [[{}], refused], [[body], []], [[body], [refused[0]]],
    [[{ tools: [{ type: "web_search" }] }], refused], [[body], ["HTTP 401", refused[1]]]])
    assert.throws(() => assertHostileWebEvidence("direct", bodies, outputs));
  assert.throws(() => assertHostileWebEvidence("code", [body], refused));
});
test("WP6 qualifier: empty, filtered-away, failed, cancelled, skipped and todo evidence cannot pass", () => {
  const good = { code: 0, output: summary() };
  assert.equal(judgeTestRun(good, 3).state, "passed");
  for (const result of [
    { ...good, output: "" }, { ...good, output: summary(0) },
    { ...good, output: summary(3, { skipped: 1, tests: 4 }) },
    { ...good, output: summary(3, { fail: 1 }) },
    { ...good, output: summary(3, { cancelled: 1 }) },
    { ...good, output: summary(3, { todo: 1 }) },
    { ...good, code: 1 }, { ...good, signal: "SIGTERM" }, { ...good, error: "timeout" },
  ]) assert.equal(judgeTestRun(result, 3).state, "failed", JSON.stringify(result));
  assert.equal(judgeTestRun(good, 4).state, "failed");
});

test("WP6 qualifier: every escalation item/part is mandatory for publication, including item 29 host profiles", () => {
  for (const [id, c] of Object.entries(ESCALATION_CASES)) {
    assert.equal(ITEMS[id], c.name);
    assert.deepEqual(EXPECTED_PARTS[id], [...Object.keys(c.parts), ...(c.gap ? ["coverage"] : [])]);
  }
  const items = Object.fromEntries(Object.entries(EXPECTED_PARTS).map(([id, names]) => [id, { state: "passed", parts: Object.fromEntries(names.map(name => [name, { state: "passed" }])) }]));
  const v = { ok: true, state: "passed", relayPath: "present", version: "0.164.0", items };
  assert.equal(judgeVerdict(v, v.version).ok, true);
  assert.equal(ESCALATION_CASES[29].gap, undefined, "the live profile suite closes item 29's declared gap");
  assert.deepEqual(EXPECTED_PARTS[29], ["unit", "decisions", "local", "nativeProfiles"]);
  assert.deepEqual(ESCALATION_CASES[29].parts.nativeProfiles.env, { RELAY_TEST_STAGE2_NATIVE_LIVE: "1" });
  assert.equal(ESCALATION_CASES[29].parts.nativeProfiles.min, 2, "installed Claude with stage 2 on, and the ACP case");
  assert.equal(ESCALATION_CASES[29].parts.nativeProfiles.skipPattern, "\\(stage 2 off\\)", "the stage-2-off Claude variant is a release check, not a pin requirement");
  // The pin needs item 33's Codex part only; claude-floor adds no pin dependency (item 29's existing Claude case remains).
  assert.deepEqual(EXPECTED_PARTS[33], ["codex"]);
  assert.deepEqual(Object.keys(ESCALATION_CASES[33].parts), ["codex"]);
  assert.deepEqual(ESCALATION_CASES[33].parts.codex.env, { RELAY_TEST_KEYCHAIN_LIVE: "1", RELAY_REQUIRE_REAL_CODEX: "1" });
  // Item 33: network off and on, each floored (refused on every turn) and its control without the file deny.
  assert.equal(ESCALATION_CASES[33].parts.codex.min, 4, "a floored decoy and its control for each network state");
  for (const network of ["off", "on"]) for (const kind of ["floored", "control without the file deny"]) {
    assert.match(`keychain decoy live (codex, network ${network}, ${kind}): x`, new RegExp(ESCALATION_CASES[33].parts.codex.pattern));
  }
  assert.equal(RELEASE_CHECK_CASES["claude-floor"].parts.keychainDecoy.min, 2, "a floored decoy and its control");
  for (const kind of ["floored", "control without the file deny"]) {
    assert.match(`keychain decoy live (claude, stage 2 off, ${kind}): x`, new RegExp(RELEASE_CHECK_CASES["claude-floor"].parts.keychainDecoy.pattern));
  }
  for (const c of Object.values(ESCALATION_CASES)) for (const spec of Object.values(c.parts) as { files: string[]; pattern?: string }[]) {
    assert.ok(!(spec.files.includes("stage2-native-live") && /claude|stage 2 off/i.test(spec.pattern ?? "") && !/\(stage 2 off/.test((spec as { skipPattern?: string }).skipPattern ?? "")), "no pin part selects a Claude floor release check");
  }
  assert.ok(!Object.keys(EXPECTED_PARTS).includes("claude-floor"));
  assert.deepEqual(Object.keys(RELEASE_CHECK_CASES["claude-floor"].parts), ["nativeStage2Off", "keychainDecoy"]);
  assert.match("stage2 native live: installed Claude settings and native tools enforce the never floor (stage 2 off)", new RegExp(RELEASE_CHECK_CASES["claude-floor"].parts.nativeStage2Off.pattern));
  assert.doesNotMatch("stage2 native live: installed Claude settings and native tools enforce the never floor (stage 2 on)", new RegExp(RELEASE_CHECK_CASES["claude-floor"].parts.nativeStage2Off.pattern));
  for (const id of [23, 24, 26, 28, 29, 33]) for (const name of Object.keys(ESCALATION_CASES[id].parts)) {
    if (!ESCALATION_CASES[id].parts[name].host) continue;
    items[id].parts[name].state = "not run";
    assert.equal(judgeVerdict(v, v.version).ok, false, `${id}.${name} cannot qualify without host evidence`);
    items[id].parts[name].state = "passed";
  }
  assert.deepEqual(EXPECTED_PARTS[30], ["long"]);
  const parts = escalationParts({ unit: { state: "passed", why: "", counts: { pass: 10 } }, coverage: { state: "pending integration", why: "missing live probe" } });
  assert.deepEqual(item(parts).why, ["coverage: missing live probe"]);
  assert.equal(item(parts).state, "pending integration");
  assert.deepEqual(parts.unit.detail.counts, { pass: 10 });
});

test("WP6 qualifier: public network is opt-in before spawning, including selected qualification", async () => {
  const saved = process.env.RELAY_TEST_PUBLIC_NET;
  delete process.env.RELAY_TEST_PUBLIC_NET;
  try {
    const result = await runEscalationSuite({ checkout: "/does-not-exist", dir: "/does-not-exist", bin: "/does-not-exist", id: "28", name: "public", spec: { ...ESCALATION_CASES[28].parts.public, host: false } });
    assert.equal(result.state, "not run"); assert.match(result.why, /RELAY_TEST_PUBLIC_NET=1/);
  } finally { if (saved === undefined) delete process.env.RELAY_TEST_PUBLIC_NET; else process.env.RELAY_TEST_PUBLIC_NET = saved; }
});

test("WP6 qualifier: all registered files exist and selected patterns are valid", () => {
  for (const c of [...Object.values(ESCALATION_CASES), ...Object.values(RELEASE_CHECK_CASES)]) for (const s of Object.values(c.parts)) {
    for (const f of s.files) assert.ok(fs.existsSync(path.join(import.meta.dirname, `${f}.test.ts`)), f);
    if (s.pattern) assert.ok(new RegExp(s.pattern));
    assert.ok(s.min > 0);
  }
});
