import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { harness, nonTempScratch, realCodexBin, task } from "./helpers.ts";
import { privateStateRoot, nativeTempRoot, setNativeTempAliasParentForTests } from "../dist/confine/private-root.js";
import { privateTurnTemp } from "../dist/confine/turn.js";
import { relaySocketsDir } from "../dist/confine/sockets.js";
import { clearGeminiMemory } from "../dist/backends/gemini.js";
import { dirIdentity, HARNESS_CONFIG, seatbeltLaunch, SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
import { turnPolicy } from "../dist/backends/types.js";
import { streamSecretValues, registerTurnSecret, withTurnSecrets } from "../dist/core/secrets.js";
import { secretSafeLog } from "../dist/backends/acp.js";
import { confinementSummary } from "../dist/confine/index.js";
import { probeBoundary } from "../dist/confine/probe.js";
import { codexFlags } from "../dist/backends/codex.js";
import { withDefaults } from "../dist/core/config.js";
import { targetDef } from "../dist/targets/index.js";
import { nativeTemp } from "../dist/backends/native-temp.js";

// RELAY_TEST_CODEX's Codex (gates: the pinned binary), else Homebrew's; a failure without one under RELAY_REQUIRE_REAL_CODEX=1 (realCodexBin).
const C1_CODEX = realCodexBin(() => fs.existsSync("/opt/homebrew/bin/codex") ? "/opt/homebrew/bin/codex" : null);
test("C1: installed Codex's actual workspace sandbox writes only its private temp, not sibling turns or shared temp", { skip: process.platform !== "darwin" ? true : !C1_CODEX.bin && !C1_CODEX.required ? C1_CODEX.why : false }, () => {
  assert.ok(C1_CODEX.bin, C1_CODEX.why);
  const root = nonTempScratch("relay-codex-boundary-");
  const shared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-shared-boundary-")));
  const systemTmp = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout.trim();
  const userTmp = fs.realpathSync(fs.mkdtempSync(path.join(systemTmp, "relay-native-boundary-")));
  const [home, wt, own, other, confined] = ["home", "wt", "native/own", "native/other", "private/sockets"].map((p) => path.join(root, p));
  for (const dir of [home, wt, own, other, confined]) fs.mkdirSync(dir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: path.join(home, ".codex"), TMPDIR: own };
  fs.mkdirSync(env.CODEX_HOME);
  try {
    const spec = { config: withDefaults({}), target: targetDef("codex"), access: "write", cwd: wt, relay: null } as never;
    const flags = codexFlags(spec, [], env);
    const files = [own, other, confined, shared, userTmp].map((dir) => path.join(dir, "marker"));
    const script = "const fs=require('fs');console.log(JSON.stringify(process.argv.slice(1).map(p=>{try{fs.writeFileSync(p,'scratch');return true}catch{return false}})))";
    const r = spawnSync(C1_CODEX.bin!, ["sandbox", ...flags.c, "--", process.execPath, "-e", script, ...files], { cwd: wt, env, encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [true, false, false, false, false], r.stderr);
  } finally { for (const dir of [root, shared, userTmp]) fs.rmSync(dir, { recursive: true, force: true }); }
});

test("C1: Claude refuses a path that would trigger its shared-temp fallback", async () => {
  const saved = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-long-native-home-"));
  process.env.HOME = home;
  // The short link's directory, scratch and itself too long: neither name fits (claude-temp-link.test.ts has the rest).
  const parent = path.join(home, "a-link-directory-too-long");
  fs.mkdirSync(parent);
  setNativeTempAliasParentForTests(parent);
  let started = false;
  try {
    await assert.rejects(nativeTemp({ target: { id: "claude" } } as never, async () => { started = true; throw new Error("must not start"); }), /44-byte limit/);
    assert.equal(started, false);
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally { setNativeTempAliasParentForTests(null); process.env.HOME = saved; fs.rmSync(home, { recursive: true, force: true }); }
});

test("C1: native launches use distinct private temps; Claude denies confined state and grants refuse both roots", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    for (const target of ["claude", "codex", "claude", "codex"]) {
      const job = await h.call("delegate", { target, mode: "write", task: "temp", background: false });
      assert.equal(job.status, "done", JSON.stringify(job));
    }
    const starts = h.starts();
    const dirs = starts.map((s) => s.env.tmpdir);
    assert.equal(new Set(dirs).size, 4);
    for (const dir of dirs) {
      assert.equal(path.dirname(dir), path.join(h.env.HOME, ".rn"));
      assert.equal(fs.existsSync(dir), false, "removed when the turn finishes");
    }
    for (const start of starts.filter((s) => s.target === "claude")) {
      assert.equal(start.env.claudeTmpdir, start.env.tmpdir);
      assert.ok(start.settings.sandbox.filesystem.denyWrite.includes(path.join(h.env.HOME, ".relay-t")));
      assert.ok(start.settings.sandbox.filesystem.allowWrite.includes(start.env.tmpdir));
    }
    for (const dir of [path.join(h.env.HOME, ".relay-t"), path.join(h.env.HOME, ".rn")]) {
      fs.mkdirSync(dir, { recursive: true });
      const r = await h.call("delegate", { target: "codex", mode: "write", task: "no", grant: { write_paths: [dir] } });
      assert.equal(r.refused, true, JSON.stringify(r));
      assert.match(r.reason, /private.*state/);
    }
  } finally { await h.close(); }
});

test("C1: confined temps and short socket paths live outside relay's TMPDIR", () => {
  const dir = privateTurnTemp();
  try {
    assert.equal(path.dirname(dir), privateStateRoot());
    assert.notEqual(path.dirname(dir), fs.realpathSync(os.tmpdir()));
    assert.ok(relaySocketsDir().startsWith(privateStateRoot() + "/"));
    assert.ok(Buffer.byteLength(path.join(relaySocketsDir(), "relay-turn-ABC123", "relay.sock")) < 104);
    assert.notEqual(privateStateRoot(), nativeTempRoot());
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("C2: native launch policies refuse missing pins, replaced directories and linked ancestors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pin-regression-"));
  const parent = path.join(root, "parent");
  const dir = path.join(parent, "granted");
  fs.mkdirSync(dir, { recursive: true });
  const pin = dirIdentity(dir);
  const spec = (pins: unknown[]) => ({ config: {}, access: "write", grant: { write_paths: [pin.path], write_path_pins: pins } }) as never;
  try {
    assert.throws(() => turnPolicy(spec([])), /recorded directory pin/);
    turnPolicy(spec([pin]));
    fs.renameSync(dir, `${dir}-old`);
    fs.mkdirSync(dir);
    assert.throws(() => turnPolicy(spec([pin])), /replaced since/);
    fs.rmdirSync(dir);
    fs.renameSync(`${dir}-old`, dir);
    fs.renameSync(parent, `${parent}-old`);
    fs.symlinkSync(`${parent}-old`, parent);
    assert.throws(() => turnPolicy(spec([pin])), /symbolic link/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("C2: a new grant in shared temp is refused", async () => {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-shared-grant-"));
  try {
    const r = await h.call("delegate", { target: "codex", task: "no", mode: "write", grant: { write_paths: [dir] } });
    assert.equal(r.refused, true);
    assert.match(r.reason, /shared temporary directory/);
  } finally { await h.close(); fs.rmSync(dir, { recursive: true }); }
});

test("C2: every native resume rechecks kept grant pins before launching", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    for (const target of ["claude", "codex"]) for (const change of ["missing pin", "replaced", "link"]) {
      const dir = path.join(h.env.HOME, `${target}-${change.replaceAll(" ", "-")}`);
      fs.mkdirSync(dir);
      const job = await h.call("delegate", { target, mode: "write", task: "seed", background: false, grant: { write_paths: [dir] } });
      assert.equal(job.status, "done", JSON.stringify(job));
      const count = h.starts().length;
      if (change === "missing pin") {
        const params = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json);
        delete params.grant.write_path_pins;
        h.sql("UPDATE nodes SET params_json = ? WHERE id = ?", JSON.stringify(params), job.job_id);
      } else {
        fs.renameSync(dir, `${dir}-old`);
        if (change === "link") fs.symlinkSync(`${dir}-old`, dir);
        else fs.mkdirSync(dir);
      }
      await h.call("resume", { job_id: job.job_id, message: "again" });
      const ended = await h.call("status", { id: job.job_id, wait_s: 20 });
      assert.equal(ended.status, "failed", `${target}/${change}: ${JSON.stringify(ended)}`);
      assert.equal(h.starts().length, count, "the substituted grant never reaches an agent");
    }
  } finally { await h.close(); }
});

test("X1: cleanup isolates the mutable ancestor before checking or deleting project memory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cleanup-race-"));
  const home = path.join(root, "home");
  const cache = path.join(home, ".cache");
  const project = path.join(cache, ".gemini", "tmp", "project");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(project, "memory"), { recursive: true });
  fs.mkdirSync(path.join(project, "chats"));
  fs.mkdirSync(path.join(outside, "memory"), { recursive: true });
  fs.writeFileSync(path.join(outside, "memory", "marker"), "untouched");
  const wt = path.join(root, "wt"), tmp = path.join(root, "tmp");
  fs.mkdirSync(wt); fs.mkdirSync(tmp);
  // Build the child's original policy while .cache still exists. It survives the host's rename.
  const mutator = process.platform === "darwin" ? seatbeltLaunch({ worktree: wt, tmpDir: tmp, denied: [], network: { mode: "on" }, state: { home: "temp", persistent: { root: home, writable: [".cache"] } } }, "/usr/bin/true", []) : null;
  const lstat = fs.lstatSync;
  let isolatedCheck = false;
  t.mock.method(fs, "lstatSync", (p: fs.PathLike, ...args: unknown[]) => {
    const st = (lstat as Function)(p, ...args);
    if (String(p) === project && st?.isDirectory()) {
      // The old lstat-then-rm implementation deletes outside/memory after this swap.
      fs.renameSync(project, `${project}-old`);
      fs.symlinkSync(outside, project);
    }
    if (String(p).endsWith("/tmp/project") && String(p).includes("/.relay-cleanup-")) {
      isolatedCheck = true;
      assert.equal(fs.existsSync(cache), false, "the old writable ancestor is detached first");
      if (mutator) {
        const l = mutator.rewrap(process.execPath, ["-e", "const fs=require('fs');fs.renameSync(process.argv[1],process.argv[1]+'-old');fs.symlinkSync(process.argv[2],process.argv[1])", String(p), outside]);
        const swapped = spawnSync(l.command, l.args, { env: { ...process.env, ...mutator.env } });
        assert.notEqual(swapped.status, 0, "a surviving confined child cannot substitute the quarantined ancestor");
      }
    }
    return st;
  });
  try {
    clearGeminiMemory(home);
    assert.equal(fs.readFileSync(path.join(outside, "memory", "marker"), "utf8"), "untouched");
    assert.equal(isolatedCheck, true);
    assert.equal(fs.existsSync(path.join(project, "memory")), false);
    assert.ok(fs.existsSync(path.join(project, "chats")), "sessions survive cleanup");
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("X2: queuing a wider parent grant or a narrower child grant never changes running authority", async () => {
  const h = await harness([{ match: task("P"), steps: [{ write: "parent.txt" }, { reply: "parent" }] }, { steps: [{ reply: "child" }] }]);
  try {
    const parent = await h.call("delegate", { target: "claude", task: "P", mode: "write", background: false });
    const ctx = await h.childOf(parent.job_id);
    const caller = await h.instance(ctx);
    const child = await caller.call("delegate", { target: "codex", task: "C", mode: "write", background: false });
    assert.equal(child.status, "done", JSON.stringify(child));
    const childCtx = await h.childOf(child.job_id);
    h.sql("UPDATE turns SET grant_json = ? WHERE id = ?", JSON.stringify({ network: true }), childCtx.turnId);
    const params = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", parent.job_id)[0].params_json);
    params.grant = { network: true }; // queued resume has replaced session params, not the live grant
    h.sql("UPDATE nodes SET params_json = ? WHERE id = ?", JSON.stringify(params), parent.job_id);
    const denied = await caller.call("resume", { job_id: child.job_id, message: "borrow network" });
    assert.equal(denied.refused, true, JSON.stringify(denied));
    assert.match(denied.reason, /more access than your current turn/);
    h.sql("UPDATE turns SET status = 'done' WHERE id IN (?, ?)", ctx.turnId, childCtx.turnId);
  } finally { await h.close(); }
});

test("X3: all known environment and turn-secret forms are removed across ACP chunk boundaries", () => withTurnSecrets(() => {
  const env = { NPM_TOKEN: "opaque-aB79-token", HTTPS_PROXY: "http://user:proxyPa55word@localhost:1" };
  registerTurnSecret("bridge-aB79/%secret", "bridge secret");
  registerTurnSecret("proxy-aB79/%secret", "proxy token");
  const values = streamSecretValues(["profile-aB79/%secret"], env);
  assert.ok(values.includes(encodeURIComponent("bridge-aB79/%secret")));
  assert.ok(values.includes(Buffer.from("user:proxyPa55word").toString("base64")));
  for (const value of values.filter((v) => !v.includes("\n"))) {
    let output = "";
    const sink = { write: (s: string) => (output += s, true), end() {}, writableEnded: false };
    const log = secretSafeLog(sink, values);
    const mid = Math.max(1, Math.floor(value.length / 2));
    for (const text of [value.slice(0, mid), value.slice(mid)]) {
      const m = { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } };
      log.agent(m, JSON.stringify(m));
    }
    log.end();
    const reconstructed = output.trim().split("\n").map((line) => JSON.parse(line).params.update.content.text).join("");
    assert.equal(reconstructed, "[redacted]");
  }
}));

test("C4: the live boundary plan never creates entries inside denied key directories", { skip: process.platform !== "darwin" }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-probe-keys-")));
  const [wt, tmp, keys] = ["wt", "tmp", "keys"].map((p) => path.join(root, p));
  for (const dir of [wt, tmp, keys]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(keys, "key-decoy"), "decoy");
  const controller = new AbortController();
  let inspected = false;
  try {
    const policy = { worktree: wt, tmpDir: tmp, denied: [keys], network: { mode: "on" as const } };
    const l = seatbeltLaunch(policy, "/usr/bin/true", []);
    const spy = { ...l, rewrap: (_command: string, args: string[]) => {
      inspected = true;
      const plan = JSON.parse(args[1]);
      const creating = Object.values(plan).filter((s: any) => s.kind === "write" && s.path.startsWith(keys + "/"));
      assert.deepEqual(creating, [], "even a broken policy must never create inside the person's denied key directory");
      controller.abort();
      return { command: "/usr/bin/true", args: [] };
    } };
    await assert.rejects(probeBoundary(spy, policy, { signal: controller.signal }), /stopped/);
    assert.equal(inspected, true);
    assert.deepEqual(fs.readdirSync(keys), ["key-decoy"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("C3/C4: exact denied-directory rules deny creating writes and reads through case/data-volume aliases on decoys", { skip: process.platform !== "darwin" || !fs.existsSync(SANDBOX_EXEC) }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-denied-decoy-")));
  const [wt, tmp, keys] = ["wt", "tmp", "keys"].map((p) => path.join(root, p));
  for (const dir of [wt, tmp, keys]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(keys, "marker"), "decoy");
  try {
    const policy = { worktree: wt, tmpDir: tmp, worktreeWritable: true, writable: [keys], denied: [keys], network: { mode: "on" as const } };
    // Place the decoy inside the worktree so only the explicit deny, not the default write
    // boundary, denies creation. Never aim a creating write at the person's key directory.
    const inside = path.join(wt, "keys");
    fs.renameSync(keys, inside);
    policy.writable = [];
    policy.denied = [inside];
    const run = (args: string[]) => { const l = seatbeltLaunch(policy, process.execPath, args); return spawnSync(l.command, l.args, { env: { ...process.env, ...l.env } }); };
    assert.notEqual(run(["-e", "require('fs').writeFileSync(process.argv[1], 'no')", path.join(inside, "created")]).status, 0);
    assert.equal(fs.existsSync(path.join(inside, "created")), false);
    const upper = inside.slice(0, -4) + "KEYS";
    for (const name of [inside, upper, `/System/Volumes/Data${inside}`, `/System/Volumes/Data${upper}`]) {
      assert.equal(spawnSync(process.execPath, ["-e", "require('fs').readdirSync(process.argv[1])", name]).status, 0, `alias exists without confinement: ${name}`);
      assert.notEqual(run(["-e", "require('fs').readdirSync(process.argv[1])", name]).status, 0, name);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("C5: doctor names resolver exceptions, same-sandbox environment inspection and proxy token limits", () => {
  const s = confinementSummary();
  const enforced = s.enforces.join("\n");
  assert.match(enforced, /network-on.*mDNSResponder resolver socket/);
  assert.match(enforced, /dnssd.*configd.*DNSConfiguration.*networkd.*nehelper/);
  assert.match(enforced, /kern.procargs2 permit inspection of same-sandbox processes/);
  assert.match(s.doesNot.join("\n"), /other loopback-capable processes can connect but need its token/);
});

test("harness config: a Claude write turn keeps its shell and its file tools off harness configuration at the top of its worktree and of each granted directory; read turns add no such rule, and a full-access write turn is refused under the never floor", async () => {
  // Relay's own sandbox denies these names to the targets it confines (confine/seatbelt.ts); a Claude
  // turn runs in Claude Code's sandbox, which protects its own `.claude` settings and `.mcp.json` but
  // not the others, so relay sets Claude Code's controls for the same list.
  for (const name of [".codex", ".agents", ".gemini", ".aws", ".envrc", ".claude", ".mcp.json"]) assert.ok(HARNESS_CONFIG.includes(name), name);
  const escape = (p: string) => p.replace(/([*?[\]{}!\\])/g, "\\$1");
  const configOf = (root: string) => HARNESS_CONFIG.map((n) => path.join(root, n));
  const editRules = (root: string) => configOf(root).flatMap((p) => [`Edit(/${escape(p)})`, `Edit(/${escape(p)}/**)`]);
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  const full = await harness([{ steps: [{ reply: "ok" }] }], { allow_dangerous: true });
  try {
    // A granted directory whose name gitignore patterns would read as a character class.
    const granted = path.join(fs.realpathSync(path.dirname(h.home)), "shared [x]");
    fs.mkdirSync(granted);
    for (const [label, args] of [["plain", {}], ["granted", { grant: { write_paths: [granted] } }]] as const) {
      const job = await h.call("delegate", { target: "claude", task: label, mode: "write", background: false, ...args });
      assert.equal(job.status, "done", JSON.stringify(job));
      const start = h.starts().at(-1)!;
      const { denyWrite, allowWrite } = start.settings.sandbox.filesystem;
      const deny: string[] = start.settings.permissions.deny;
      const roots = label === "granted" ? [start.cwd, granted] : [start.cwd];
      for (const root of roots) {
        // The shell: Claude Code's sandbox denies each path whole, creating it included.
        for (const p of configOf(root)) assert.ok(denyWrite.includes(p), `${label}: ${p} in ${JSON.stringify(denyWrite)}`);
        // The file tools (Write, Edit, NotebookEdit): an Edit rule for the path and everything under it.
        for (const rule of editRules(root)) assert.ok(deny.includes(rule), `${label}: ${rule}`);
        // The root itself stays writable: only the names at its top are denied.
        assert.ok(!denyWrite.includes(root) && !deny.includes(`Edit(/${escape(root)})`), `${label}: ${root} stays writable`);
      }
      if (label === "granted") {
        assert.ok(allowWrite.includes(granted));
        assert.ok(deny.includes(`Edit(/${granted.replace("[x]", "\\[x\\]")}/.codex)`), "a granted directory's name is escaped in the rule");
        assert.ok(!deny.includes(`Edit(/${granted}/.codex)`));
      } else {
        assert.ok(!denyWrite.some((p: string) => p.startsWith(granted)), "no grant, no rule for it");
      }
    }
    // A read turn: its sandbox denies writes to the whole worktree already, and its editing tools are absent.
    const read = await h.call("delegate", { target: "claude", task: "read", mode: "read", background: false });
    assert.equal(read.status, "done", JSON.stringify(read));
    const r = h.starts().at(-1)!;
    assert.equal(r.access, "read");
    assert.ok(r.settings.sandbox.filesystem.denyWrite.includes(fs.realpathSync(r.cwd)));
    assert.ok(!configOf(r.cwd).some((p) => r.settings.sandbox.filesystem.denyWrite.includes(p)), "read turns are unchanged");
    assert.ok(!editRules(r.cwd).some((rule) => (r.settings.permissions?.deny ?? []).includes(rule)), "read turns are unchanged");
    // Full access (allow_dangerous) would run with no sandbox and no guarded paths, bypassing the
    // never floor, so such a Claude write turn is not launched at all (backends/never-admission.ts).
    const any = await full.call("delegate", { target: "claude", task: "full", mode: "write", background: false });
    assert.equal(any.status, "failed", JSON.stringify(any));
    assert.match(any.error, /^never: Claude's unsandboxed full-access variant bypasses the floor/);
    assert.equal(full.starts().length, 0);
  } finally {
    await h.close();
    await full.close();
  }
});

test("r_0c11d860 X1: no grant, new or kept, may cover relay's own installation, the Node it runs on, or a target CLI relay starts; file requests there are refused too", async () => {
  const { relayPackageRoot } = await import("../dist/core/protected-config.js");
  const { underTemp } = await import("../dist/core/config.js");
  const { offLimits } = await import("../dist/core/approvals.js");
  // The running copy: this checkout, whichever worktree the tests run from.
  const root = relayPackageRoot();
  assert.equal(root, path.resolve(import.meta.dirname, ".."));
  const cliDir = nonTempScratch("relay-x1-cli-");
  // A codex CLI of its own, outside relay's package: a link to the stub, as Homebrew's bin links are.
  fs.symlinkSync(path.join(root, "test", "stubs", "stub-codex"), path.join(cliDir, "codex"));
  // A directory of relay's PATH that holds none of the programs relay runs: a job could put one there.
  const pathDir = nonTempScratch("relay-x1-path-");
  fs.mkdirSync(path.join(pathDir, "bin"));
  const h = await harness([{ steps: [{ reply: "ok" }] }], { targets: { codex: { bin: path.join(cliDir, "codex") } } }, { PATH: `${path.join(pathDir, "bin")}:${process.env.PATH}` });
  try {
    const refused = async (dir: string, why: RegExp) => {
      const r = await h.call("delegate", { target: "codex", mode: "write", task: "no", grant: { write_paths: [dir] } });
      assert.equal(r.refused, true, `${dir}: ${JSON.stringify(r)}`);
      assert.match(r.reason, why, dir);
    };
    // Relay's package, a directory in it, and its parent (which could rename it away).
    if (!underTemp(root)) for (const dir of [root, path.join(root, "dist"), path.join(root, "test", "stubs"), path.dirname(root)]) await refused(dir, /relay's own installation .*outside any sandbox/);
    // The Node relay runs on, by its directory.
    const node = fs.realpathSync(process.execPath);
    if (!underTemp(node)) await refused(path.dirname(node), /Node .*outside any sandbox/);
    // A target CLI's directory, where only the link relay starts lives.
    await refused(cliDir, /the codex target's CLI .*outside any sandbox/);
    // The git relay runs: its directory (on PATH) and, from Homebrew, the keg it leads to.
    const { gitExecutable } = await import("../dist/core/executables.js");
    const git = gitExecutable();
    if (git && !underTemp(git)) {
      await refused(path.dirname(git), /git relay runs|relay's PATH/);
      const real = fs.realpathSync(git);
      if (real !== git && !underTemp(real)) await refused(path.dirname(real), /git relay runs/);
    }
    // A directory on relay's PATH, and one holding it, though neither holds anything relay runs now.
    await refused(path.join(pathDir, "bin"), /is .*a directory on relay's PATH/);
    await refused(pathDir, /holds .*a directory on relay's PATH/);
    // A directory inside one, under a program's name: skipped by a lookup only while it is not runnable.
    fs.mkdirSync(path.join(pathDir, "bin", "git"));
    await refused(path.join(pathDir, "bin", "git"), /is inside .*a directory on relay's PATH/);

    // Kept: a grant given before its directory held a CLI relay starts is refused on the next turn.
    const kept = path.join(h.env.HOME, "kept");
    fs.mkdirSync(kept);
    const job = await h.call("delegate", { target: "claude", mode: "write", task: "seed", background: false, grant: { write_paths: [kept] } });
    assert.equal(job.status, "done", JSON.stringify(job));
    fs.writeFileSync(path.join(kept, "gemini"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const file = path.join(h.home, "config.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    cfg.targets.gemini = { ...(cfg.targets.gemini ?? {}), bin: path.join(kept, "gemini") };
    fs.writeFileSync(file, JSON.stringify(cfg));
    const count = h.starts().length;
    const again = await h.call("resume", { job_id: job.job_id, message: "again" });
    assert.equal(again.refused, true, JSON.stringify(again));
    assert.match(again.reason, /can no longer be used: .*the gemini target's CLI .*outside any sandbox/);
    assert.equal(h.starts().length, count, "the kept grant never reaches an agent");

    // A file request (relay writes it unconfined once approved) into relay's package: refused,
    // nobody asked. A harness's own check of reading there is not (a read job may read relay's code).
    if (!underTemp(root)) {
      const wt = h.repo;
      assert.match(offLimits({ cwd: wt, worktree: wt }, [path.join(root, "dist", "cli.js")]) ?? "", /relay's own installation/);
      assert.doesNotMatch(offLimits({ cwd: wt, worktree: wt }, [path.join(root, "dist", "cli.js")], "reach") ?? "", /relay's own installation/);
    }
    {
      const wt = h.repo;
      const saved = process.env.PATH;
      process.env.PATH = `${path.join(pathDir, "bin")}:${saved}`;
      try { assert.match(offLimits({ cwd: wt, worktree: wt }, [path.join(pathDir, "bin", "git")]) ?? "", /directory on relay's PATH/); }
      finally { process.env.PATH = saved; }
    }
  } finally { await h.close(); }
});

test("r_0c11d860 X1: installDirOf names a Homebrew keg, an npm package and a Node distribution's prefix, and nothing shared", async () => {
  const { installDirOf } = await import("../dist/core/protected-config.js");
  assert.equal(installDirOf("/opt/homebrew/Caskroom/codex/0.164.0/bin/codex"), "/opt/homebrew/Caskroom/codex/0.164.0");
  assert.equal(installDirOf("/opt/homebrew/Cellar/node/24.1.0/bin/node"), "/opt/homebrew/Cellar/node/24.1.0");
  const s = nonTempScratch("relay-x1-dirs-");
  const pkg = path.join(s, "lib", "node_modules", "@scope", "cli");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  fs.writeFileSync(path.join(pkg, "bin", "cli.js"), "");
  assert.equal(installDirOf(path.join(pkg, "bin", "cli.js")), pkg);
  const prefix = path.join(s, "node-v24");
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "include", "node"), { recursive: true });
  assert.equal(installDirOf(path.join(prefix, "bin", "node")), prefix);
  assert.equal(installDirOf("/usr/local/bin/node"), null);
  assert.equal(installDirOf(path.join(s, "loose-binary")), null);
});

test("r_0c11d860 X1: a turn whose own PATH finds a target CLI in, or leads through, one of its write paths is refused at launch", async () => {
  const { targetLaunchProblem } = await import("../dist/core/protected-config.js");
  const root = nonTempScratch("relay-x1-launch-");
  const [bin, granted, other] = ["bin", "granted", "other"].map((d) => path.join(root, d));
  for (const d of [bin, granted, other]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(granted, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // The turn's PATH finds the CLI inside the write path.
  assert.match(targetLaunchProblem("the codex target's CLI", "codex", `${granted}:/usr/bin:/bin`, [granted]) ?? "", /it is .*granted\/codex.*overlaps the job's write path/);
  // A write path that is a directory of the turn's PATH, or holds one, though the CLI is found elsewhere.
  assert.match(targetLaunchProblem("the codex target's CLI", "codex", `${bin}:${other}:/usr/bin:/bin`, [other]) ?? "", /a directory on the PATH the turn would start it from/);
  assert.match(targetLaunchProblem("the codex target's CLI", "codex", `${bin}:/usr/bin:/bin`, [root]) ?? "", /overlaps/);
  // Neither: the launch goes ahead.
  assert.equal(targetLaunchProblem("the codex target's CLI", "codex", `${bin}:/usr/bin:/bin`, [granted]), null);
  assert.equal(targetLaunchProblem("the codex target's CLI", "codex", `${granted}:/usr/bin:/bin`, []), null, "no write paths, nothing to judge");
});
