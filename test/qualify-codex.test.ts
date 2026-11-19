// relay qualify-codex (src/install/qualify-codex.ts): one run of the Codex qualifier with every
// check a scheduled run has, its refusals before anything runs, and what it tells the person,
// which is relay's own selection of Codex afterwards rather than the qualifier's say-so. No test
// here runs the real qualifier: each passes the command a recording stand-in for runQualifier, or
// refuses before the qualifier is loaded.
import "./helpers.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { withDefaults } from "../dist/core/config.js";
import { CODEX_QUALIFIER } from "../dist/backends/codex-pin.js";
import { relayPackageRoot } from "../dist/core/protected-config.js";
import { qualifyCodex, qualifyCodexDefaults, QUALIFY_CODEX_USAGE } from "../dist/install/qualify-codex.js";
import { runQualifier } from "../scripts/codex-qualify/codex-qualifier.mjs";
import { installQualifier } from "../scripts/codex-qualify/install-codex-qualifier.mjs";
import { CLI } from "./helpers.ts";
import { fakeRelayBuild } from "./fake-build.ts";
import { buildIdentity } from "../dist/core/build-identity.js";

function scratch(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-qualify-cmd-")));
  t.after(() => {
    const unseal = (dir: string) => { fs.chmodSync(dir, 0o700); for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unseal(path.join(dir, e.name)); };
    unseal(root); fs.rmSync(root, { recursive: true, force: true });
  });
  // A stand-in relay package: built, with the qualifier where relay looks for it, and no .git (an npm install).
  const checkout = fakeRelayBuild(path.join(root, "relay"), "1.0.0", { "dist/backends/codex.js": "", [CODEX_QUALIFIER]: "" });
  const store = path.join(root, "pins");
  const cfg = withDefaults({ targets: { codex: { home: path.join(root, "codex-home"), pin_store: store, pinned: true } } });
  return { root, checkout, store, cfg };
}

/** A sealed pin as the qualifier publishes it (the shape freezeCodexConfig accepts). */
function pin(store: string, version = "0.169.0") {
  const bytes = `#!/bin/sh\necho codex-cli ${version}\n`;
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = `versions/${version}-${hash.slice(0, 12)}`;
  const dir = path.join(store, target);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin/codex"), bytes, { mode: 0o555 });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version, binarySha256: hash,
    npmIntegrity: `sha512-${"A".repeat(86)}==`, codesign: { teamId: "2DC432GLL2", identity: "Developer ID Application: OpenAI" },
    qualifiedAt: new Date().toISOString(), verdictPath: path.join(store, "runs/r/stage2-verdict.json"), verdictSchema: "stage2-v4",
    sourceCommit: "b".repeat(40), relayBuild: { scheme: "relay-build-v2", version: "1.0.0", sha256: "c".repeat(64) }, nodeVersion: process.version }), { mode: 0o444 });
  fs.chmodSync(path.join(dir, "bin"), 0o555);
  fs.chmodSync(dir, 0o555);
  fs.symlinkSync(target, path.join(store, "current"));
  return { target, bin: path.join(dir, "bin/codex") };
}

/** The command with a recording qualifier: `run` decides what it does. */
function harness(s: ReturnType<typeof scratch>, run: (input: any, options: any) => Promise<any> = async () => ({ state: "busy" }), launched: string | null = null) {
  const lines: string[] = [], calls: any[] = [], loaded: string[] = [];
  const deps = {
    root: s.checkout, config: () => s.cfg, launched: () => launched, out: (l: string) => lines.push(l),
    load: async (file: string) => { loaded.push(file); return { runQualifier: async (input: any, options: any) => { calls.push({ input, options, umask: process.umask() }); return run(input, options); } }; },
  };
  return { deps, lines, calls, loaded, text: () => lines.join("\n") };
}

test("qualify-codex: runs the checkout's own qualifier with relay's pin store and nothing that weakens a check", async (t) => {
  const s = scratch(t);
  const h = harness(s, async (input) => ({ state: "promoted", version: "0.169.0", target: pin(input.store).target, runDir: "/r" }));
  const before = process.umask();
  assert.equal(await qualifyCodex(["--version", "0.169.0"], h.deps), 0, h.text());
  assert.deepEqual(h.loaded, [path.join(s.checkout, CODEX_QUALIFIER)], "the qualifier file the LaunchAgent runs");
  assert.equal(h.calls.length, 1);
  const { input, options, umask } = h.calls[0];
  // Exactly the scheduled run's inputs: no aqua:false, test services, supervisor or signal opt-out.
  assert.deepEqual(Object.keys(input).sort(), ["repo", "store"]);
  assert.deepEqual(input, { repo: s.checkout, store: s.store });
  assert.deepEqual(Object.keys(options).sort(), ["force", "version"]);
  assert.deepEqual(options, { version: "0.169.0", force: false });
  assert.equal(umask, 0o077, "as the qualifier's own main sets it");
  assert.equal(process.umask(), before, "restored afterwards");
  // It says what was checked, where the pin went, and what relay will now run.
  const text = h.text();
  for (const said of [/npm package @openai\/codex@0\.169\.0-darwin-arm64/, /Team ID 2DC432GLL2/, /exactly codex-cli 0\.169\.0/, /rust-v0\.169\.0 at commit b{40}/,
    /every item and part of stage2-v4 passed/, /run from relay 1\.0\.0, build c{16} \(sha256 c{64}\)/,
    new RegExp(`for relay 1\\.0\\.0, build ${buildIdentity(s.checkout).sha256.slice(0, 16)} at `), new RegExp(`Pin: ${path.join(s.store, "current")} -> versions/0\\.169\\.0-`), /relay will run Codex from the qualified pin .*\/bin\/codex/]) assert.match(text, said);
});

test("qualify-codex: the pin store follows targets.codex.pin_store, and --force passes through only as the qualifier's own flag", async (t) => {
  const s = scratch(t);
  const custom = path.join(s.root, "elsewhere");
  s.cfg.targets.codex.pin_store = custom;
  const h = harness(s, async () => ({ state: "busy" }));
  assert.equal(await qualifyCodex(["--force"], h.deps), 1);
  assert.deepEqual(h.calls[0].input, { repo: s.checkout, store: custom });
  assert.deepEqual(h.calls[0].options, { version: undefined, force: true });
  assert.match(h.text(), /every check still runs/);
  assert.match(h.text(), new RegExp(`another qualifier run holds the lock on ${custom}`));
});

test("qualify-codex: refuses bad arguments, a launched agent and a checkout it cannot qualify from, before loading the qualifier", async (t) => {
  const s = scratch(t);
  for (const args of [["--version", "latest"], ["--version", "0.169.0-alpha.1"], ["--version"], ["0.169.0"], ["--bogus"], ["--aqua=false"]]) {
    const h = harness(s);
    assert.equal(await qualifyCodex(args, h.deps), 2, args.join(" "));
    assert.match(h.text(), new RegExp(QUALIFY_CODEX_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(h.loaded, [], args.join(" "));
  }
  const launched = harness(s, undefined, "its environment carries RELAY_RUN_ID, which relay sets on the agents it launches");
  assert.equal(await qualifyCodex([], launched.deps), 1);
  assert.match(launched.text(), /runs only from your own terminal.*RELAY_RUN_ID.*Nothing ran/);
  assert.deepEqual(launched.loaded, []);
  for (const missing of [CODEX_QUALIFIER, "dist/backends/codex.js"]) {
    const t2 = scratch(t);
    fs.rmSync(path.join(t2.checkout, missing), { recursive: true });
    const h = harness(t2);
    assert.equal(await qualifyCodex([], h.deps), 1, missing);
    assert.match(h.text(), /runs from a built relay \(an npm install, or a git checkout after npm run build\).*Nothing ran/, missing);
    assert.deepEqual(h.loaded, [], missing);
  }
  // The pin names the build by its content, so an incomplete one is refused before anything runs.
  for (const missing of ["test/stubs", "test/stage2-probe.test.ts", "package.json"]) {
    const t2 = scratch(t);
    fs.rmSync(path.join(t2.checkout, missing), { recursive: true });
    const h = harness(t2);
    assert.equal(await qualifyCodex([], h.deps), 1, missing);
    assert.match(h.text(), /relay qualify-codex refused: .*(is incomplete|package\.json|ENOENT).*Nothing ran/, missing);
    assert.deepEqual(h.loaded, [], missing);
  }
  // No .git is needed (an npm install has none), and a checkout's local changes are no refusal:
  // the identity is of the bytes that will run (decision 17, superseding review r_3a408af1 C1).
  const s3 = scratch(t);
  fs.mkdirSync(path.join(s3.checkout, ".git"));
  const before = buildIdentity(s3.checkout);
  fs.writeFileSync(path.join(s3.checkout, "dist/backends/codex.js"), "edited");
  assert.notEqual(buildIdentity(s3.checkout).sha256, before.sha256);
  const edited = harness(s3);
  assert.equal(await qualifyCodex([], edited.deps), 1, "busy");
  assert.equal(edited.calls.length, 1);
});

test("qualify-codex: a qualifier that throws, or a pin manifest it cannot read, still ends with relay's own answer (review r_3a408af1, C2)", async (t) => {
  const s = scratch(t);
  const thrown = harness(s, async () => { throw new Error("EACCES: permission denied, mkdir '/pins/runs'"); });
  assert.equal(await qualifyCodex([], thrown.deps), 1);
  assert.match(thrown.text(), /stopped with an error before it could record a result: EACCES/);
  assert.match(thrown.text(), /relay refuses Codex: no valid qualified pin/);
  const s2 = scratch(t);
  const unread = harness(s2, async () => ({ state: "promoted", version: "0.169.0", target: "versions/0.169.0-000000000000" }));
  assert.equal(await qualifyCodex([], unread.deps), 1);
  assert.match(unread.text(), /could not read the new pin's manifest/);
  assert.match(unread.text(), /relay refuses Codex: no valid qualified pin/);
});

test("qualify-codex: a failed, skipped or unknown result exits 1 and says relay still refuses Codex", async (t) => {
  for (const [result, said] of [
    [{ state: "failed", version: "0.169.0", runDir: "/store/runs/x", error: "Error: stage 2 item 7 failed\n    at stack" }, /Qualification of Codex 0\.169\.0 failed: Error: stage 2 item 7 failed\nEvidence: \/store\/runs\/x/],
    [{ state: "skipped", version: "0.169.0", binarySha256: "d".repeat(64), relayBuild: { scheme: "relay-build-v2", version: "1.0.0", sha256: "e".repeat(64) }, failedAt: "2026-11-17T00:00:00Z", verdictPath: "/v.json" }, /Not run: Codex 0\.169\.0 .*already failed qualification with relay 1\.0\.0, build e{16}.*--force/],
    [{ state: "passed-ish" }, /no result relay knows/],
    [undefined, /no result relay knows/],
  ] as const) {
    const s = scratch(t);
    const h = harness(s, async () => result);
    assert.equal(await qualifyCodex([], h.deps), 1, JSON.stringify(result));
    assert.match(h.text(), said);
    assert.match(h.text(), /relay refuses Codex: no valid qualified pin/, "relay's own answer ends the report");
    assert.doesNotMatch(h.text(), /relay will run Codex from the qualified pin/);
    assert.doesNotMatch(h.text(), /unchanged/, "nothing claims what the pin store holds; relay's own selection says it (review r_3a408af1, X2)");
  }
});

test("qualify-codex: a qualifier that reports success without a pin relay accepts is not success", async (t) => {
  // Promoted or unchanged by the qualifier's say-so, with no valid pin in relay's store: the person is told relay refuses Codex, and the exit is 1.
  for (const result of [{ state: "unchanged", version: "0.169.0", target: "versions/0.169.0-aaaaaaaaaaaa" }]) {
    const s = scratch(t);
    const h = harness(s, async () => result);
    assert.equal(await qualifyCodex([], h.deps), 1);
    assert.match(h.text(), /relay refuses Codex: no valid qualified pin/);
  }
  const s = scratch(t);
  const fake = harness(s, async (input) => {
    // A tree whose binary does not match its manifest: relay's selection refuses it.
    const p = pin(input.store);
    fs.chmodSync(path.dirname(p.bin), 0o755); fs.chmodSync(p.bin, 0o755); fs.writeFileSync(p.bin, "tampered"); fs.chmodSync(p.bin, 0o555); fs.chmodSync(path.dirname(p.bin), 0o555);
    return { state: "promoted", version: "0.169.0", target: p.target };
  });
  assert.equal(await qualifyCodex([], fake.deps), 1);
  assert.match(fake.text(), /digest mismatch/);
});

test("qualify-codex: with targets.codex.pinned false it says relay will not use the pin, and exits 1", async (t) => {
  const s = scratch(t);
  s.cfg.targets.codex.pinned = false;
  const h = harness(s, async (input) => ({ state: "promoted", version: "0.169.0", target: pin(input.store).target }));
  assert.equal(await qualifyCodex([], h.deps), 1);
  assert.match(h.text(), /targets\.codex\.pinned is false.*does not use this pin store/);
});

test("qualify-codex: its defaults are relay's checkout and the same qualifier module the LaunchAgent runs", async (t) => {
  const d = qualifyCodexDefaults();
  assert.equal(d.root, relayPackageRoot());
  assert.equal(buildIdentity(d.root).version, JSON.parse(fs.readFileSync(path.join(d.root, "package.json"), "utf8")).version, "relay's own build is complete");
  const mod = await d.load(path.join(d.root, CODEX_QUALIFIER));
  assert.equal(mod.runQualifier, runQualifier, "one runQualifier, not a copy");
  const s = scratch(t), config = path.join(s.root, "qualifier.json");
  fs.writeFileSync(config, JSON.stringify({ repo: d.root, store: s.store }));
  const agent = installQualifier({ config, node: process.execPath, home: path.join(s.root, "home") });
  assert.match(agent.content, new RegExp(`<string>${path.join(d.root, CODEX_QUALIFIER).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
  // The command's source reaches runQualifier only through that module, with no option a test needs.
  const source = fs.readFileSync(path.join(d.root, "src/install/qualify-codex.ts"), "utf8");
  assert.doesNotMatch(source, /\baqua\b|services:|supervisor:|signals:/);
});

test("qualify-codex: the CLI lists it, and refuses inside a launched agent and on bad arguments", (t) => {
  const s = scratch(t);
  const config = path.join(s.root, "relay.json");
  fs.writeFileSync(config, JSON.stringify({ targets: { codex: { pin_store: s.store, home: path.join(s.root, "codex-home") } } }));
  const env = { ...process.env, HOME: s.root, RELAY_HOME: path.join(s.root, "control"), RELAY_CONFIG: config };
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8", timeout: 20000, env });
  assert.match(help.stdout, /relay qualify-codex \[--version X\.Y\.Z\] \[--force\]/);
  assert.match(help.stdout, /relay qualify-codex --shipped\s+switch to this release's shipped pin/);
  // Every spawn below also carries a launch marker, so a regression refuses rather than runs a real qualification.
  const marked = { ...env, RELAY_RUN_ID: "r_test" };
  for (const flag of ["--help", "-h"]) {
    const usage = spawnSync(process.execPath, [CLI, "qualify-codex", flag], { encoding: "utf8", timeout: 20000, env: marked });
    assert.equal(usage.status, 0, usage.stderr);
    assert.match(usage.stdout, /^usage: relay qualify-codex \[--version X\.Y\.Z\] \[--force\] \| --shipped\nQualifies a Codex release/);
  }
  const bad = spawnSync(process.execPath, [CLI, "qualify-codex", "--version", "nope"], { encoding: "utf8", timeout: 20000, env: marked });
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stdout, /usage: relay qualify-codex/);
  const inside = spawnSync(process.execPath, [CLI, "qualify-codex"], { encoding: "utf8", timeout: 20000, env: marked });
  assert.equal(inside.status, 1, inside.stderr);
  assert.match(inside.stdout, /refused: it runs only from your own terminal.*RELAY_RUN_ID/);
  assert.equal(fs.existsSync(s.store), false, "nothing was written");
  // doctor naming the command: test/codex-pin.test.ts, "doctor reports private auth metadata and a missing pin".
});
