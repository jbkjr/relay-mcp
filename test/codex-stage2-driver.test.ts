// The Codex qualifier's stage-2 driver (scripts/codex-qualify/codex-stage2.mjs): how it judges each
// item's evidence (the older Codex's control, the token checks, tool lists, effort, plugin
// prefetch, code mode's isolate, the denied port's spellings), how items and parts make a verdict,
// and its command line; and the canonical form of minified code (scripts/js-canon.mjs) that the
// qualifier's tests read Codex's and Claude Code's code with. Moved from test/release-watch.test.ts,
// which covers only the release watcher, so that a tree without the watcher keeps this coverage.
import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { canonicalize, chunkLinks, enclosingFunction, importRunBefore, renameShort, scan } from "../scripts/js-canon.mjs";
import * as Q from "../scripts/codex-qualify/codex-stage2.mjs";
import { CURRENT_VERDICT_SCHEMA, EXPECTED_PARTS, judgeVerdict, VERDICT_SCHEMAS } from "../scripts/codex-qualify/codex-pin-store.mjs";
import * as S2 from "../dist/backends/codex-stage2.js";

const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-stage2-driver-")));
const same = (a: string, b: string) => assert.deepEqual(canonicalize([{ label: "m", src: a }]).tokens, canonicalize([{ label: "m", src: b }]).tokens);
const differ = (a: string, b: string) => assert.notDeepEqual(canonicalize([{ label: "m", src: a }]).tokens, canonicalize([{ label: "m", src: b }]).tokens);

test("stage-2 driver: the qualifier's scripts share isMain, which follows a symlinked or spaced path", async (t) => {
  const { isMain } = await import("../scripts/codex-qualify/main-module.mjs");
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, "real dir", "script.mjs");
  fs.mkdirSync(path.dirname(real)); fs.writeFileSync(real, "");
  const url = pathToFileURL(fs.realpathSync(real)).href;
  const link = path.join(dir, "link.mjs"); fs.symlinkSync(real, link);
  assert.equal(isMain(url, real), true, "a path with a space");
  assert.equal(isMain(url, link), true, "a symlinked path");
  assert.equal(isMain(url, path.join(dir, "missing.mjs")), false);
  assert.equal(isMain(url, undefined), false);
  assert.equal(isMain(pathToFileURL(path.join(dir, "other.mjs")).href, real), false);
  for (const name of ["codex-stage2", "codex-qualifier", "install-codex-qualifier", "codex-shipped-pin"]) {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, `../scripts/codex-qualify/${name}.mjs`), "utf8");
    assert.match(src, /^if \(isMain\(import\.meta\.url\)\) \{?/m, name);
    assert.doesNotMatch(src, /import\.meta\.url === /, `${name} keeps a hand-made main guard`);
  }
});

test("js-canon: minified names compare equal under a one-to-one renaming, and nothing else does", () => {
  same("function ab(e,n){let r=e+n;return r}", "function Xq(t,o){let i=t+o;return i}");
  differ("function ab(e,n){return e+n}", "function ab(e,n){return n+e}");
  // Properties, object keys and class members are kept as written.
  differ("let e=a.CLAUDE_CODE_TMPDIR", "let e=a.CLAUDE_CODE_TMPDIRX");
  differ("g(n,{recursive:!0,mode:448})", "g(n,{recursive:!0,mod:448})");
  same("class V{ensured=void 0;markEnsured(e){this.ensured=e}}", "class Q{ensured=void 0;markEnsured(n){this.ensured=n}}");
  differ("class V{markEnsured(e){}}", "class V{markDone(e){}}");
  // Shorthand properties, methods and accessors of an object name properties too; a block does not.
  differ("function f(a){return{a}}", "function f(b){return{b}}");
  differ("x={a(){return 1}}", "x={b(){return 1}}");
  differ("x={get a(){return 1}}", "x={get b(){return 1}}");
  differ("let{a,b}=x", "let{a,c}=x");
  same("if(x){g(e)}", "if(x){h(e)}");
  same('import{mkdirSync as g}from"fs";try{g(i)}catch{}', 'import{mkdirSync as h}from"fs";try{h(i)}catch{}');
  // A conditional's branches are not object keys.
  same("x={a:b?c:d}", "x={a:q?w:z}");
  // Template substitutions are code; regular expressions and strings are kept.
  same("t(`dir ${e} is ${n}`)", "t(`dir ${r} is ${o}`)");
  differ('e.replace(/[\\/]+$/,"")', 'e.replace(/[\\/]*$/,"")');
  // Node imports read as what they import: a renamed import is the same, a changed one is not.
  same('import{openSync as pe}from"fs";pe(r)', 'import{openSync as Ab}from"fs";Ab(r)');
  differ('import{openSync as pe}from"fs";pe(r)', 'import{readSync as pe}from"fs";pe(r)');
  assert.throws(() => scan('let a="unterminated'), /unterminated string/);
  // A statement compared on its own: short names renamed in order, so the same binding stays the same.
  assert.equal(renameShort("let xe=ge.indexOf(J);if(xe!==-1)ge.splice(xe,1)", new Map([["ge", "LIST"]])), "let $1=LIST.indexOf($2);if($1!==-1)LIST.splice($1,1)");
  assert.equal(renameShort("let of=f(...un),x=a.of"), "let $1=$2(...$3),$4=$5.of");
});

test("js-canon: a name links to another segment's declaration only within its chunk or through an import", () => {
  const def = { label: "d", src: "function Od(){return 1}function Vx(){return 2}", chunk: 1, imports: new Map(), exports: new Map([["Od", "Od"]]) };
  const use = (src: string, imports: [string, string][]) => ({ label: "u", src, chunk: 2, imports: new Map(imports), exports: new Map() });
  const inUse = (tokens: string[]) => tokens.slice(tokens.indexOf("@segment u") + 2);
  const sole = new Map([["Od", [1]]]);
  assert.deepEqual(inUse(canonicalize([def, use("x=Od()", [["Od", "Od"]])], { exporters: sole }).tokens), ["$1", "=", "$G1", "(", ")"], "an import of the one chunk exporting it keeps its global name");
  // The name only happens to match a declaration of the other chunk: not imported, so not linked.
  assert.deepEqual(inUse(canonicalize([def, use("x=Vx()", [])], { exporters: sole }).tokens), ["$1", "=", "$2", "(", ")"], "a name another chunk declares is not linked without an import");
  // Two chunks export the name, or nothing says which: ESM could resolve it elsewhere, so not linked.
  assert.deepEqual(inUse(canonicalize([def, use("x=Od()", [["Od", "Od"]])], { exporters: new Map([["Od", [1, 3]]]) }).tokens), ["$1", "=", "$2", "(", ")"]);
  assert.deepEqual(inUse(canonicalize([def, use("x=Od()", [["Od", "Od"]])]).tokens), ["$1", "=", "$2", "(", ")"]);
  const links = chunkLinks('import{Od,WLe as w}from"/$bunfs/root/chunk-a.js";x=1\nexport{Cm,A0e as z}');
  assert.deepEqual([...links.imports], [["Od", "Od"], ["w", "WLe"]]);
  assert.deepEqual([...links.exports], [["Cm", "Cm"], ["z", "A0e"]]);
  const text = 'var q=1;import{join as N}from"path";function Fm(){if(a){return 1}return 2}';
  const at = text.indexOf("return 1");
  const fn = enclosingFunction(text, at)!;
  assert.equal(fn.name, "Fm");
  assert.equal(text.slice(fn.end - 1, fn.end), "}");
  assert.equal(text.slice(importRunBefore(text, fn.start), fn.start), 'import{join as N}from"path";');
});

test("stage-2 driver: item 13's older Codex passes only when its command ran in the worktree and wrote nothing outside", () => {
  const said = "codex-cli 0.163.0";
  assert.equal(Q.oldCodexPart({ said, m: { oldout: "1", oldin: "0" } }).state, "passed");
  const escaped = Q.oldCodexPart({ said, m: { oldout: "0", oldin: "0" } });
  assert.equal(escaped.state, "failed");
  assert.match(escaped.why.join(), /wrote outside the roots/);
  assert.equal(Q.oldCodexPart({ said, m: { oldout: "1", oldin: "0" }, wroteOut: true }).state, "failed");
  // No evidence is not a pass: the case threw before any command, or the command never ran.
  const threw = Q.oldCodexPart({ said, err: "app server exited during initialize" });
  assert.equal(threw.state, "failed");
  assert.match(threw.why.join(), /cannot tell/);
  assert.match(threw.why.join(), /app server exited during initialize/);
  for (const m of [{}, { oldout: "1" }, { oldout: "1", oldin: "1" }]) {
    const p = Q.oldCodexPart({ said, m });
    assert.equal(p.state, "failed", JSON.stringify(m));
    assert.match(p.why.join(), /cannot tell/);
  }
});

test("stage-2 driver: item 6's token check counts only when its command ran and dumped its environment in the worktree", (t) => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wt = path.join(dir, "wt");
  fs.mkdirSync(wt);
  const token = "a".repeat(64), hash = "b".repeat(64);
  const w = (said: string) => ({ token, hash, d: { dir, wt }, model: { output: (c: number, s: number) => (c === 0 && s === 0 ? said : undefined) } });
  const seen = { exPs: `codex exec-server --ws-token-sha256 ${hash}`, appPs: "codex app-server", stderr: "" };
  // The command never ran: no env.txt and no ok=1. The env half has looked at nothing.
  const none = Q.item6CodexPart(w(""), seen);
  assert.equal(none.state, "failed");
  assert.match(none.why.join(), /cannot tell/);
  // It reported running but wrote no dump (the worktree unwritable, say): still nothing looked at.
  assert.equal(Q.item6CodexPart(w("ok=1\n"), seen).state, "failed");
  fs.writeFileSync(path.join(wt, "env.txt"), "PATH=/usr/bin:/bin\nHOME=/h\n");
  assert.equal(Q.item6CodexPart(w(""), seen).state, "failed", "a dump without the command's ok=1 is not this command's");
  assert.equal(Q.item6CodexPart(w("ok=1\n"), seen).state, "passed");
  // With the dump there, the token in it fails the part, as before.
  fs.writeFileSync(path.join(wt, "env.txt"), `PATH=/usr/bin\nX=${token}\n`);
  const leaked = Q.item6CodexPart(w("ok=1\n"), seen);
  assert.equal(leaked.state, "failed");
  assert.match(leaked.why.join(), /the token is in wt\/env\.txt/);
  assert.deepEqual(Q.envDumpProblems("ok=1\n", wt), []);
});

test("stage-2 driver: item 6 looks for the token in the app server's argv and environment only once it has read the app server's", (t) => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wt = path.join(dir, "wt"), home = path.join(dir, "home");
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, "env.txt"), "PATH=/usr/bin\n");
  const token = "a".repeat(64), hash = "b".repeat(64);
  const w = { token, hash, d: { dir, wt, home }, model: { output: (c: number, s: number) => (c === 0 && s === 0 ? "ok=1\n" : undefined) } };
  const exPs = `codex exec-server --ws-token-sha256 ${hash}`;
  const app = `/pins/codex app-server -c x=y CODEX_HOME=${home} PATH=/usr/bin`;
  assert.equal(Q.item6CodexPart(w, { exPs, appPs: app, stderr: "" }).state, "passed");
  assert.equal(Q.item6CodexPart(w, { exPs, appPs: `/pins/codex -c x=y CODEX_HOME=${home}`, stderr: "" }).state, "passed", "its CODEX_HOME names it too");
  // ps failed (psEnv gives ""), or read some other process: the app-server half has looked at nothing.
  for (const appPs of ["", "/usr/bin/sleep 60 PATH=/usr/bin"]) {
    const part = Q.item6CodexPart(w, { exPs, appPs, stderr: "" });
    assert.equal(part.state, "failed", JSON.stringify(appPs));
    assert.match(part.why.join(), /app server.*cannot tell/);
  }
  // Through relay: at least one app server must have matched the case's CODEX_HOME.
  const r = { d: { wt }, model: w.model, result: { status: "ok" }, tokenIn: [], captured: [{}, {}] };
  assert.equal(Q.item6RelayPart(r, { hashSeen: true, tmpSeen: "/t", appSeen: 1 }).state, "passed");
  const none = Q.item6RelayPart(r, { hashSeen: true, tmpSeen: "/t", appSeen: 0 });
  assert.equal(none.state, "failed");
  assert.match(none.why.join(), /app server.*cannot tell/);
});

test("stage-2 driver: item 6 scans the very app-server snapshots it counted, each read once", () => {
  const home = "/q/i6-relaypath/home";
  const ours = `/pins/codex app-server -c x=y CODEX_HOME=${home} PATH=/usr/bin`;
  // ps answers once, then nothing (the process gone, or ps failing): the bytes counted must be the bytes scanned.
  const reads = new Map<number, number>();
  const read = (pid: number) => {
    reads.set(pid, (reads.get(pid) ?? 0) + 1);
    if (pid === 3) return "/other/codex app-server CODEX_HOME=/elsewhere";
    return reads.get(pid) === 1 ? ours : "";
  };
  const apps = Q.appServerSnapshots([1, 2, 3], home, read);
  assert.deepEqual(apps.map((a: { pid: number }) => a.pid), [1, 2]);
  for (const a of apps) assert.equal(a.env, ours, `pid ${a.pid}'s captured bytes are the ones that matched`);
  assert.deepEqual([...reads.values()], [1, 1, 1], "one read per pid");
  // Nothing readable, or nothing of the case's: no snapshot, so the relay part cannot tell.
  assert.deepEqual(Q.appServerSnapshots([1, 2], home, () => ""), []);
  assert.deepEqual(Q.appServerSnapshots([], home, read), []);
});

test("stage-2 driver: the stage-2 qualification reads tool lists, conversations and command output as Codex sends them", () => {
  assert.deepEqual(Q.markers("x\nwt=0\nout=1 \nwt=1\n"), { wt: "1", out: "1" });
  assert.equal(Q.outputText([{ type: "input_text", text: "a=" }, "1"]), "a=1");
  // A code-mode request: tools in an additional_tools item, namespaces with their members, exec's nested tools from its description.
  const body = {
    tools: [],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "additional_tools", tools: [
        { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "declare const tools: { exec_command(args: X): Y; };\ndeclare const tools: { apply_patch(input: string): Z; };" }, { type: "function", name: "wait" }] },
        { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent" }] },
      ] },
    ],
  };
  const names = Q.offeredTools(body);
  assert.deepEqual(names, ["functions", "exec", "exec_command", "apply_patch", "wait", "collaboration", "spawn_agent"]);
  assert.equal(S2.stage2ToolsProblem(names), null);
  // A direct-mode request, and a hosted tool by its type; a tool relay has not qualified is named.
  const direct = Q.offeredTools({ tools: [{ type: "function", name: "exec_command" }, { type: "web_search" }, { type: "function", name: "image_generation" }] });
  assert.deepEqual(direct, ["exec_command", "web_search", "image_generation"]);
  assert.match(S2.stage2ToolsProblem(direct) ?? "", /not qualified for stage 2: image_generation$/);
  // Which conversation a request is: by its messages, not by a spawn call's arguments; steps by that conversation's outputs.
  const convs = [{ match: "SUB", calls: [{ type: "function_call", name: "exec_command" }] }, { calls: [{ type: "function_call", name: "spawn_agent", arguments: "SUB" }, () => ({ type: "function_call", name: "late" })] }];
  const parent = (outs: number) => ({ input: [{ type: "message", content: "go" }, { type: "function_call", arguments: "SUB" }, ...Array.from({ length: outs }, (_, i) => ({ type: "function_call_output", call_id: `c1-${i}`, output: "x" })), { type: "function_call_output", call_id: "c0-0", output: "other conversation" }] });
  assert.deepEqual([Q.nextReply(convs, parent(0)).conv, Q.nextReply(convs, parent(0)).item.name, Q.nextReply(convs, parent(0)).item.call_id], [1, "spawn_agent", "c1-0"]);
  assert.equal(Q.nextReply(convs, parent(1)).item.name, "late");
  assert.equal(Q.nextReply(convs, parent(2)).item.type, "message");
  const sub = { input: [{ type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "SUB: do it" }] }] };
  assert.equal(Q.nextReply(convs, sub).conv, 0);
  // 0.170.0: a goal's objective arrives as untrusted additional context, a function_call_output
  // with no call_id in namespace `agent`; it routes like a message, a real call's output never does.
  const goal = { input: [{ type: "message", content: "earlier turn" }, { type: "function_call_output", name: "goal_objective", namespace: "agent", output: "SUB objective" }] };
  assert.equal(Q.nextReply(convs, goal).conv, 0);
  assert.equal(Q.nextReply(convs, { input: [{ type: "function_call_output", call_id: "c9-0", output: "SUB in a tool result" }] }).conv, 1);
  assert.equal(Q.nextReply(convs, { input: [{ type: "function_call_output", namespace: "agent", output: [{ type: "input_text", text: "SUB as items" }] }] }).conv, 0);
  assert.match(Q.sse({ type: "message" }), /event: response\.completed/);
});

test("stage-2 driver: effort qualification reads request effort and the latest configuration update", () => {
  assert.deepEqual(Q.effortEvidence({ reasoning: { effort: "high" } }), { request: "high", updates: [], effective: "high" });
  assert.deepEqual(Q.effortEvidence({ reasoning: { effort: "high" }, input: [
    { type: "configuration_update", reasoning: { effort: "high" } },
    { type: "message", reasoning: { effort: "low" } },
    { type: "configuration_update", reasoning: { effort: "medium" } },
  ] }), { request: "high", updates: ["high", "medium"], effective: "medium" });
  assert.equal(Q.effortEvidence({}).effective, null, "missing evidence cannot pass");
  assert.equal(Q.effortEvidence({ reasoning: { effort: "high" }, input: [{ type: "configuration_update" }] }).effective, null, "malformed update cannot fall back to a passing baseline");
});

function pluginEvidence() {
  const quiet = { tmp: null, proxied: [] as string[], discovery: [] as { method: string; path: string; authenticated: boolean }[], readback: null };
  return {
    hasPrefetch: true,
    control: { ...quiet, tmp: ["plugins"] },
    off: { ...quiet, features: { plugins: false, plugin_discovery_prefetch: false, remote_plugin: false } },
    pluginsOnly: { ...quiet, features: { plugins: false, plugin_discovery_prefetch: true, remote_plugin: false } },
    prefetchOn: { ...quiet, features: { plugins: true, plugin_discovery_prefetch: true, remote_plugin: true },
      discovery: Q.PLUGIN_DISCOVERY_PATHS.map((path: string) => ({ method: "GET", path, authenticated: true })) },
  };
}

test("stage-2 driver: plugin prefetch requires authenticated discovery at every positive-control endpoint", () => {
  assert.deepEqual(Q.PLUGIN_DISCOVERY_PATHS, ["/backend-api/ps/plugins/list", "/backend-api/plugins/featured", "/backend-api/ps/plugins/suggested/codex"]);
  const evidence = pluginEvidence();
  assert.equal(Q.item(Q.pluginParts(evidence)).state, "passed");
  for (const discovery of [[], [{ method: "GET", path: "/backend-api/ps/plugins/installed", authenticated: true }]]) {
    const parts = Q.pluginParts({ ...evidence, prefetchOn: { ...evidence.prefetchOn, discovery } });
    assert.equal(parts.control.state, "passed", "curated sync remains an independent control");
    assert.equal(parts.prefetch.state, "failed");
    assert.equal(Q.item(parts).state, "failed", "quiet negatives cannot pass an uninformative positive control");
    assert.match(parts.prefetch.why.join(), /prefetch check cannot tell/);
  }
  for (const path of Q.PLUGIN_DISCOVERY_PATHS) {
    for (const change of ["missing", "unauthenticated", "wrong-method"]) {
      const discovery = evidence.prefetchOn.discovery.flatMap((r: any) => r.path !== path ? [r] : change === "missing" ? [] : [{ ...r, ...(change === "unauthenticated" ? { authenticated: false } : { method: "POST" }) }]);
      const parts = Q.pluginParts({ ...evidence, prefetchOn: { ...evidence.prefetchOn, discovery } });
      assert.equal(parts.prefetch.state, "failed", `${change}: ${path}`);
      assert.ok(parts.prefetch.why.join().includes(path));
    }
  }
  for (const feature of ["plugins", "plugin_discovery_prefetch", "remote_plugin"]) {
    assert.equal(Q.pluginParts({ ...evidence, prefetchOn: { ...evidence.prefetchOn, features: { ...evidence.prefetchOn.features, [feature]: false } } }).prefetch.state, "failed", feature);
  }
  assert.equal(Q.pluginParts({ ...evidence, prefetchOn: null }).prefetch.state, "failed");
});

test("stage-2 driver: from 0.170.0 (prefetch removed) the positive control needs startup discovery's installed and suggested requests", () => {
  assert.deepEqual(Q.PLUGIN_STARTUP_DISCOVERY_PATHS, ["/backend-api/ps/plugins/installed", "/backend-api/ps/plugins/suggested/codex"]);
  for (const [v, paths] of [[[0, 166, 0], Q.PLUGIN_DISCOVERY_PATHS], [[0, 169, 1], Q.PLUGIN_DISCOVERY_PATHS], [[0, 170, 0], Q.PLUGIN_STARTUP_DISCOVERY_PATHS], [[0, 171, 2], Q.PLUGIN_STARTUP_DISCOVERY_PATHS], [[1, 0, 0], Q.PLUGIN_STARTUP_DISCOVERY_PATHS]] as const) {
    assert.deepEqual(Q.pluginDiscoveryPaths(v), paths, v.join("."));
  }
  const evidence = pluginEvidence();
  const discoveryPaths = Q.PLUGIN_STARTUP_DISCOVERY_PATHS;
  // What 0.170.0 sent with plugins, remote plugins and prefetch on (the scheduled qualifier's run, 2026-11-18).
  const seen = [
    { method: "GET", path: "/backend-api/ps/plugins/installed", authenticated: true },
    { method: "GET", path: "/backend-api/wham/accounts/check", authenticated: true },
    { method: "GET", path: "/backend-api/ps/plugins/suggested/codex", authenticated: true },
    { method: "POST", path: "/backend-api/ps/mcp", authenticated: false },
  ];
  const on = { ...evidence.prefetchOn, discovery: seen };
  assert.equal(Q.item(Q.pluginParts({ ...evidence, prefetchOn: on, discoveryPaths })).state, "passed");
  assert.equal(Q.pluginParts({ ...evidence, prefetchOn: on }).prefetch.state, "failed", "the old paths still fail it on an older version");
  for (const path of discoveryPaths) {
    const parts = Q.pluginParts({ ...evidence, prefetchOn: { ...on, discovery: seen.filter((r) => r.path !== path) }, discoveryPaths });
    assert.equal(parts.prefetch.state, "failed", path);
    assert.ok(parts.prefetch.why.join().includes(path));
  }
  // The plugin service's MCP endpoint (no `plugins` segment) counts as discovery too; other backend calls do not.
  assert.equal(Q.pluginDiscoveryRequest({ path: "/backend-api/ps/mcp" }), true);
  assert.equal(Q.pluginDiscoveryRequest({ path: "/backend-api/ps" }), true);
  assert.equal(Q.pluginDiscoveryRequest({ path: "/backend-api/psx/mcp" }), false);
  assert.equal(Q.pluginDiscoveryRequest({ path: "/backend-api/wham/settings/user" }), false);
  const mcp = Q.pluginParts({ ...evidence, off: { ...evidence.off, discovery: [{ method: "POST", path: "/backend-api/ps/mcp", authenticated: false }] }, prefetchOn: on, discoveryPaths });
  assert.equal(mcp.codex.state, "failed", "a plugin-service MCP call under relay's pins fails the codex part");
  // The negatives are as wide as before: any plugins path under relay's pins fails the codex part.
  const leaked = Q.pluginParts({ ...evidence, off: { ...evidence.off, discovery: [{ method: "GET", path: "/backend-api/ps/plugins/installed", authenticated: true }] }, prefetchOn: on, discoveryPaths });
  assert.equal(leaked.codex.state, "failed");
});

test("stage-2 driver: plugin negatives ignore the fake service's non-plugin traffic (Codex 0.166.0 with plugins off)", () => {
  const evidence = pluginEvidence();
  // What 0.166.0 sent the fake service under relay's pins in the 1.1.2 gate's information run (gates-90dee60).
  const discovery = [
    { method: "GET", path: "/backend-api/wham/accounts/check", authenticated: true },
    { method: "GET", path: "/backend-api/wham/accounts/check", authenticated: true },
    { method: "POST", path: "/backend-api/codex/analytics-events/events", authenticated: true },
    { method: "GET", path: "/backend-api/wham/settings/user", authenticated: true },
    { method: "POST", path: "/backend-api/codex/analytics-events/events", authenticated: true },
  ];
  const parts = Q.pluginParts({ ...evidence, off: { ...evidence.off, discovery }, pluginsOnly: { ...evidence.pluginsOnly, discovery } });
  assert.equal(parts.codex.state, "passed", parts.codex.why.join());
  assert.equal(Q.item(parts).state, "passed");
  for (const path of [...Q.PLUGIN_DISCOVERY_PATHS, "/backend-api/ps/plugins/installed", "/backend-api/plugins"]) {
    assert.equal(Q.pluginDiscoveryRequest({ path }), true, path);
  }
  for (const path of ["/backend-api/wham/accounts/check", "/backend-api/codex/analytics-events/events", "/backend-api/wham/settings/user", "/backend-api/pluginsx", ""]) {
    assert.equal(Q.pluginDiscoveryRequest({ path }), false, path);
  }
});

test("stage-2 driver: plugin negatives still reject sync, proxy traffic, fake-service traffic and bad readback", () => {
  const evidence = pluginEvidence();
  for (const change of [
    { tmp: ["plugins.sha"] }, { proxied: ["CONNECT github.com:443"] }, { proxied: ["CONNECT chatgpt.com:443"] },
    { discovery: evidence.prefetchOn.discovery.slice(0, 1) },
    { discovery: [{ method: "GET", path: "/backend-api/ps/plugins/installed", authenticated: true }] },
  ]) {
    for (const name of ["off", "pluginsOnly"] as const) {
      assert.equal(Q.pluginParts({ ...evidence, [name]: { ...evidence[name], ...change } }).codex.state, "failed", `${name}: ${JSON.stringify(change)}`);
    }
  }
  // A plugin-discovery request among other service traffic still fails each negative (the 1.1.3 narrowing keeps the check able to fail).
  const other = [
    { method: "GET", path: "/backend-api/wham/accounts/check", authenticated: true },
    { method: "POST", path: "/backend-api/codex/analytics-events/events", authenticated: true },
    { method: "GET", path: "/backend-api/wham/settings/user", authenticated: true },
  ];
  for (const path of [...Q.PLUGIN_DISCOVERY_PATHS, "/backend-api/ps/plugins/installed", "/backend-api/plugins"]) {
    for (const name of ["off", "pluginsOnly"] as const) {
      const parts = Q.pluginParts({ ...evidence, [name]: { ...evidence[name], discovery: [...other, { method: "GET", path, authenticated: false }] } });
      assert.equal(parts.codex.state, "failed", `${name}: ${path}`);
    }
  }
  assert.equal(Q.pluginParts({ ...evidence, off: { ...evidence.off, readback: "plugin pin did not read back" } }).codex.state, "failed");
  for (const features of [{ plugins: true, plugin_discovery_prefetch: true }, { plugins: false, plugin_discovery_prefetch: false }, {}]) {
    assert.equal(Q.pluginParts({ ...evidence, pluginsOnly: { ...evidence.pluginsOnly, features } }).codex.state, "failed");
  }
  assert.equal(Q.pluginParts({ ...evidence, pluginsOnly: null }).codex.state, "failed");
  assert.equal(Q.pluginParts({ ...evidence, control: evidence.off }).control.state, "failed");
  assert.equal(Q.pluginParts({ ...evidence, control: { ...evidence.off, proxied: ["CONNECT github.com:443"] } }).control.state, "passed");
  const legacy = Q.pluginParts({ ...evidence, hasPrefetch: false, prefetchOn: null, pluginsOnly: null });
  assert.equal(Q.item(legacy).state, "passed", "versions without prefetch retain the sync check");
  assert.deepEqual(legacy.prefetch.detail, { supported: false });
});

test("stage-2 driver: a qualification receipt cannot omit item 12's prefetch control", () => {
  assert.deepEqual(EXPECTED_PARTS[12], ["control", "codex", "prefetch"]);
  const items = Object.fromEntries(Object.entries(EXPECTED_PARTS).map(([id, names]) => [id, { state: "passed", parts: Object.fromEntries(names.map((name: string) => [name, { state: "passed" }])) }]));
  const verdict = { ok: true, state: "passed", relayPath: "present", version: "0.166.0", items };
  assert.equal(judgeVerdict(verdict, verdict.version).ok, true);
  delete items[12].parts.prefetch;
  const judged = judgeVerdict(verdict, verdict.version);
  assert.equal(judged.ok, false);
  assert.ok(judged.why.includes("item 12.prefetch evidence missing"));
});

test("stage-2 driver: code mode's isolate passes only with no forbidden binding, every import refused and no unqualified global", () => {
  assert.ok(Q.ISOLATE_HELPERS.every((h: string) => Q.ISOLATE_GLOBALS.includes(h)));
  assert.ok(!Q.ISOLATE_FORBIDDEN.some((f: string) => Q.ISOLATE_GLOBALS.includes(f)));
  assert.match(Q.ISOLATE_PROBE, /typeof require/);
  const ok = { types: Object.fromEntries(Q.ISOLATE_FORBIDDEN.map((k: string) => [k, "undefined"])), imports: { "node:fs": "refused: unsupported import in exec" }, globals: ["Array", "text", "tools"] };
  const said = (r: object) => `Script completed\nISOLATE=${JSON.stringify(r)}\n`;
  assert.deepEqual(Q.isolateProblems(said(ok)), []);
  assert.match(Q.isolateProblems(said({ ...ok, types: { ...ok.types, fetch: "function" } })).join(), /isolate has fetch \(function\)/);
  assert.match(Q.isolateProblems(said({ ...ok, imports: { "node:fs": "loaded 80" } })).join(), /can import node:fs/);
  assert.match(Q.isolateProblems(said({ ...ok, globals: [...ok.globals, "Deno2"] })).join(), /globals relay has not qualified: Deno2/);
  assert.match(Q.isolateProblems("exec failed").join(), /printed no result/);
  assert.match(Q.isolateProblems(said({ ...ok, globals: [] })).join(), /listed no globals/);
});

test("stage-2 driver: a stage-2 item passes only when every part passed, and the run only when every item did", () => {
  const p = Q.part;
  assert.equal(Q.item({ codex: p("passed"), control: p("passed") }).state, "passed");
  assert.equal(Q.item({ codex: p("passed"), relay: p(Q.PENDING, "no WP-C") }).state, Q.PENDING);
  const failed = Q.item({ codex: p("failed", "escaped"), relay: p(Q.PENDING, "no WP-C") });
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.why, ["codex: escaped", "relay: no WP-C"]);
  assert.equal(Q.item({}).state, "not run");
  const all = Object.fromEntries(Object.keys(Q.ITEMS).map((id) => [id, Q.item({ codex: p("passed") })]));
  assert.equal(Q.verdictOf(all).state, "passed");
  assert.equal(Q.verdictOf(all).verdictSchema, CURRENT_VERDICT_SCHEMA);
  const { 13: _lost, ...lost } = all;
  assert.equal(Q.verdictOf(lost).state, "failed");
  assert.match(Q.verdictOf(lost).why.join(), /item 13 failed: the driver recorded no result/);
  assert.equal(Q.verdictOf({ ...all, 8: Q.item({ relay: p(Q.PENDING, "x") }) }).state, Q.PENDING);
  assert.equal(Q.verdictOf({ ...all, 8: Q.item({ relay: p(Q.PENDING, "x") }), 2: Q.item({ codex: p("failed", "y") }) }).state, "failed");
  assert.equal(Q.notImplemented(new Error("not implemented: stage 2 WP-C (openStage2)")), true);
  assert.equal(Q.notImplemented("relay cannot run this Codex job"), false);
  // Its command line.
  const o = Q.parseArgs(["co", "/tmp/x", "0.165.0", "/bin/codex", "--old-bin", "/bin/old", "--items", "1,13"]);
  assert.deepEqual([o.version, o.bin, o.oldBin, o.source, o.only], ["0.165.0", "/bin/codex", "/bin/old", null, ["1", "13"]]);
  assert.throws(() => Q.parseArgs(["co", "/tmp/x", "0.165.0"]), /usage/);
  assert.throws(() => Q.parseArgs(["co", "/tmp/x", "latest", "/bin/codex"]), /usage/);
  assert.deepEqual(Q.parseArgs(["co", "/tmp/x", "0.165.0", "/bin/codex", "--items", "14,20,22"]).only, ["14", "20", "22"]);
  assert.deepEqual(Q.parseArgs(["co", "/tmp/x", "0.165.0", "/bin/codex", "--items", "23,30"]).only, ["23", "30"]);
  assert.deepEqual(Q.parseArgs(["co", "/tmp/x", "0.165.0", "/bin/codex", "--items", "31,32"]).only, ["31", "32"]);
  assert.deepEqual(Q.parseArgs(["co", "/tmp/x", "0.165.0", "/bin/codex", "--items", "33"]).only, ["33"], "item 33: the keychain under the never floor");
  assert.throws(() => Q.parseArgs(["co", "/tmp/x", "0.165.0", "/bin/codex", "--items", "34"]), /no item 34/);
  assert.throws(() => Q.parseArgs(["co", "/tmp/x", "0.165.0", "/bin/codex", "--old-bin"]), /needs a value/);
  assert.throws(() => Q.parseArgs(["co", "/tmp/x", "0.165.0", "/bin/codex", "--push"]), /unknown option --push/);
});

test("stage-2 driver: item 1 tries the denied port at every spelling of the Mac's addresses and requires EPERM", () => {
  const ifs = { lo0: [{ family: "IPv4", address: "127.0.0.1" }, { family: "IPv6", address: "::1" }, { family: "IPv6", address: "fe80::1" }], en0: [{ family: "IPv4", address: "192.168.1.5" }, { family: "IPv6", address: "fe80::abc%en0" }, { family: "IPv6", address: "2001:db8::5" }] };
  const all = Q.localSpellings(ifs);
  for (const a of ["127.0.0.1", "::1", "0.0.0.0", "::ffff:127.0.0.1", "::ffff:0.0.0.0", "0:0:0:0:0:ffff:0:0", "192.168.1.5", "::ffff:192.168.1.5", "fe80::1%lo0", "fe80::abc%en0", "2001:db8::5"]) assert.ok(all.includes(a), a);
  assert.equal(new Set(all).size, all.length);
  const probe = Q.netProbe("/usr/local/bin/node", 4000, ["127.0.0.1", "::ffff:0.0.0.0"], 4001, ["127.0.0.1"]);
  assert.match(probe, /^\/usr\/local\/bin\/node -e '[^']+'$/);
  const lines = Q.netLines("x\nnet deny 127.0.0.1 EPERM\nnet deny ::ffff:0.0.0.0 CONNECTED\nnet ok 127.0.0.1 CONNECTED\n");
  assert.deepEqual(lines.map((l: { address: string }) => l.address), ["127.0.0.1", "::ffff:0.0.0.0", "127.0.0.1"]);
  assert.deepEqual(Q.netProblems(lines, ["127.0.0.1", "::ffff:0.0.0.0", "::1"], ["127.0.0.1"]), ["the denied port at ::ffff:0.0.0.0: CONNECTED, not EPERM", "no result for the denied port at ::1: the check cannot tell"]);
  assert.match(Q.netProblems(Q.netLines("net deny 127.0.0.1 ECONNREFUSED\n"), ["127.0.0.1"], ["127.0.0.1"]).join(), /ECONNREFUSED, not EPERM.*127\.0\.0\.1: no result/);
});

test("stage-2 driver: item 30 passes only on one broker answer past the hour, delivered once to a turn that completed", () => {
  const delayMs = 3_601_000, toolTimeoutS = 7500, OK = JSON.stringify({ fixture: "BROKER_OK" });
  const out = (call_id: string, text: string) => ({ call_id, text });
  const good = () => ({
    done: { method: "turn/completed", params: { threadId: "th", turn: { id: "t1", status: "completed" } } },
    turnId: "t1", delayMs, toolTimeoutS,
    diag: { calls: 1, durations: [3_601_001], fatal: [] as string[], refusals: [] as string[] },
    requests: [
      { conv: 0, step: 0, outputs: [], sent: undefined },
      { conv: 0, step: 1, outputs: [out("c0-0", "found")], sent: "status" },
      { conv: 0, step: 2, outputs: [out("c0-0", "found"), out("c0-1", OK)], sent: "message" },
    ] as any[],
  });
  assert.deepEqual(Q.item30Problems(good()), []);
  const fails = (change: (x: ReturnType<typeof good>) => void, why: RegExp) => {
    const x = good(); change(x);
    const p = Q.item30Problems(x);
    assert.ok(p.some((w: string) => why.test(w)), `${why}: ${JSON.stringify(p)}`);
  };
  // Two outputs for the same call in the request that carries the result (output() took the first).
  fails((x) => { x.requests[2].outputs.push(out("c0-1", OK)); }, /held \[2\] outputs for it, not one each/);
  // A timeout error first, then the real answer: the first output is not the broker's.
  fails((x) => { x.requests[2].outputs[1] = out("c0-1", "Error calling tool: timed out"); }, /not the broker's answer/);
  fails((x) => { x.requests[2].outputs.splice(1, 1); }, /no request to the model carried/);
  fails((x) => { x.requests.push({ conv: 0, step: 2, outputs: [out("c0-0", "found"), out("c0-1", "other")], sent: "message" }); }, /changed between requests/);
  fails((x) => { x.requests.splice(2, 0, { conv: 0, step: 1, outputs: [out("c0-0", "found")], sent: "status" }); }, /issued the long call 2 times/);
  // The turn's terminal status, and the turn it belongs to.
  fails((x) => { x.done = null as any; }, /the turn did not complete/);
  fails((x) => { x.done.params.turn = { id: "t1", status: "failed", error: { message: "boom" } } as any; }, /the turn ended failed: boom/);
  fails((x) => { x.done.params.turn.status = "interrupted"; }, /the turn ended interrupted/);
  fails((x) => { x.done.params.turn.id = "t0"; }, /not the one turn\/start started/);
  // The broker: exactly one call, held past the hour, nothing fatal.
  fails((x) => { x.diag.calls = 2; x.diag.durations.push(3_601_002); }, /received 2 calls, not 1/);
  fails((x) => { x.diag.durations = [3_599_000]; }, /not one of at least 3601000 ms/);
  fails((x) => { x.diag.fatal.push("relay could not check the TCP peer of its tools"); }, /fatal failure: relay could not check/);
  fails((x) => { x.requests.push({ scriptError: "boom" }); }, /the fake model failed: boom/);
  fails((x) => { x.toolTimeoutS = 3600; }, /tool timeout \(3600 s\) is not beyond/);
  // Every failed condition is named, not just the first.
  const x = good(); x.diag.fatal.push("f"); x.done.params.turn.status = "failed";
  assert.equal(Q.item30Problems(x).length, 2);
});
