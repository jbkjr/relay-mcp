import "./helpers.ts";
import { nonTempScratch } from "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { NEVER_RETIRED_BUILTIN_IDS, NeverConfigSchema, normalizeNeverHost } from "../dist/core/never-schema.js";
import { resolveNeverPolicy, mergeNeverPolicies, neverPathProblem, neverEndpointProblem, neverGrantProblem, neverIdentityProblem } from "../dist/core/never-policy.js";
import { assertNeverCurrent, assertNeverLaunchCurrent, checkpointNever, readNeverFloor } from "../dist/core/never-checkpoint.js";
import { closeDbForTests, createRun, db, getRun, insertNode, insertTurn, registryBackup, runConfig } from "../dist/core/db.js";
import { configDeprecations, withDefaults } from "../dist/core/config.js";
import { checkNativeTempAlias, ensureNativeTempAlias, nativeTempAlias, nativeTempRoot, privateStateRoot, setNativeTempAliasParentForTests } from "../dist/confine/private-root.js";
import { harnessHome, worktreesHome } from "../dist/core/config.js";
import { nativeTemp } from "../dist/backends/native-temp.js";
import { prepareCodexHome } from "../dist/backends/codex-pin.js";
import { decide, getRequest, neverApprovalProblem, requestApproval } from "../dist/core/approvals.js";
import { admitWork } from "../dist/core/caller.js";
import { relayCodexProtected, relayPathDirs, relayWriteProtected } from "../dist/core/protected-config.js";

function fixture(home = scratch(), config = withDefaults({ ask_user: "never", allow_temp_home: true, approval_timeout_s: 1 })) {
  const old = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = path.join(home, "registry"); process.env.RELAY_CONFIG = path.join(home, "config.json");
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(config));
  const run = createRun(home, config, "test-root");
  const write = (never: unknown) => fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify({ ...config, never }));
  return { home, run, write, close() {
    closeDbForTests(); for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(home, { recursive: true, force: true });
  } };
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-never-"));
const policy = (never: unknown = {}, home = os.homedir()) => resolveNeverPolicy({ never: NeverConfigSchema.parse(never), home, builtins: false });

test("never schema is strict, additive and rejects ambiguous resources and silent overrides", () => {
  assert.deepEqual(NeverConfigSchema.parse({}), { paths: [], ports: [], hosts: [], override_builtin: [] });
  for (const bad of [
    { paths: [{ path: "relative" }] }, { paths: [{ path: "/a/../b" }] }, { paths: [{ path: "/a/*" }] },
    { paths: [{ path: "/a", extra: 1 }] }, { ports: [{ port: 0 }] }, { ports: [{ port: 1.2 }] },
    { hosts: ["https://secret.example"] }, { hosts: ["*.example"] }, { hosts: ["fe80::1%en0"] },
    { hosts: ["127.1"] }, { hosts: ["0x7f000001"] }, { extra: [] },
    { override_builtin: [{ id: "unknown", acknowledge: "x", reason: "x" }] },
    { override_builtin: [{ id: "relay.install", acknowledge: "REMOVE BUILT-IN NEVER relay.install", reason: "x" }] },
    { override_builtin: [{ id: "service.sshd", acknowledge: "yes", reason: "x" }] },
  ]) assert.equal(NeverConfigSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(normalizeNeverHost("BÜCHER.example."), "xn--bcher-kva.example");
  assert.equal(normalizeNeverHost("::ffff:192.0.2.40"), "192.0.2.40");
  assert.equal(normalizeNeverHost("2001:0DB8:0:0::40"), "2001:db8::40");
});

test("never paths retain aliases, write semantics, missing tails, hard links and identities", () => {
  const home = scratch();
  try {
    fs.mkdirSync(path.join(home, "real"));
    fs.symlinkSync("real", path.join(home, "named"));
    fs.writeFileSync(path.join(home, "secret"), "decoy");
    fs.linkSync(path.join(home, "secret"), path.join(home, "alias"));
    const p = policy({ paths: [{ path: "~/named/missing" }, { path: "~/secret" }, { path: "~/archive", access: "write" }] }, home);
    for (const name of ["named/missing/file", "real/missing/file", "REAL/MISSING/file", "alias"]) assert.ok(neverPathProblem(p, path.join(home, name), "read"), name);
    assert.equal(neverPathProblem(p, path.join(home, "archive/a"), "read"), null);
    assert.ok(neverPathProblem(p, path.join(home, "archive/a"), "write"));
    assert.equal(neverPathProblem(p, path.join(home, "real/sibling"), "write"), null);
    assert.ok(neverGrantProblem(p, { write_paths: [home] }));
    assert.equal(neverIdentityProblem(p), null);
    fs.unlinkSync(path.join(home, "named"));
    fs.symlinkSync("elsewhere", path.join(home, "named"));
    assert.match(neverIdentityProblem(p)!, /identity/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("never endpoint rules preserve local IPv4 service semantics and fail raw closed with hosts", () => {
  const p = policy({ hosts: ["SECRET.example.", "::ffff:192.0.2.40"], ports: [{ port: 2525, destinations: "this-machine" }, { port: 443, transport: "udp" }] });
  assert.ok(neverEndpointProblem(p, { host: "secret.example", port: 80, transport: "tcp" }));
  assert.ok(neverEndpointProblem(p, { host: "192.0.2.40", port: 80, transport: "tcp" }));
  assert.ok(neverEndpointProblem(p, { host: "127.0.0.2", port: 2525, transport: "udp" }));
  assert.equal(neverEndpointProblem(p, { host: "192.0.2.41", port: 2525, transport: "tcp" }), null);
  assert.ok(neverEndpointProblem(p, { host: "192.0.2.41", port: 2525, transport: "tcp", operation: "listen" }));
  assert.ok(neverEndpointProblem(p, { host: "2001:db8::2", port: 2525, transport: "tcp" }));
  assert.equal(neverEndpointProblem(p, { host: "example.org", port: 443, transport: "tcp" }), null);
  assert.ok(neverGrantProblem(p, { raw_network: true }));
});

test("never merge is deterministic and cumulative, including old path identities and removals", () => {
  const a = policy({ hosts: ["a.example"] }); const b = policy({ hosts: ["b.example"] });
  const union = mergeNeverPolicies(a, b);
  assert.throws(() => union.hosts.push({ id: "injected", host: "other.example" }), TypeError, "hashed policy snapshots cannot be mutated by consumers");
  assert.deepEqual(union.hosts.map(h => h.host), ["a.example", "b.example"]);
  assert.equal(mergeNeverPolicies(union, a).hash, union.hash);
  assert.equal(mergeNeverPolicies(a, b).hash, mergeNeverPolicies(b, a).hash);
  assert.equal(mergeNeverPolicies(union, policy()).hash, union.hash);
});

test("checkpoint durably keeps add approve remove launch and rejects malformed reload without loss", () => {
  const home = scratch(); const old = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  try {
    process.env.RELAY_HOME = path.join(home, "registry"); process.env.RELAY_CONFIG = path.join(home, "config.json");
    fs.writeFileSync(process.env.RELAY_CONFIG, "{}");
    const run = createRun(home, withDefaults({}), "test-root");
    fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ never: { hosts: ["a.example"] } }));
    const a = checkpointNever(run, "approval");
    fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ never: { hosts: ["b.example"] } }));
    checkpointNever(run, "approval");
    fs.writeFileSync(process.env.RELAY_CONFIG, "{}");
    closeDbForTests();
    const launch = checkpointNever(run, "launch");
    assert.deepEqual(launch.hosts.map(h => h.host), ["a.example", "b.example"]);
    assert.notEqual(a.hash, launch.hash);
    fs.writeFileSync(process.env.RELAY_CONFIG, "{ malformed");
    assert.throws(() => checkpointNever(run, "approval"), /config/);
    assert.equal(readNeverFloor(run)!.hash, launch.hash);
    fs.unlinkSync(process.env.RELAY_CONFIG);
    assert.throws(() => checkpointNever(run, "launch"), /config/);
  } finally {
    closeDbForTests();
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("built-ins include exact service ports, whole Codex home, X1 and immutable authority", () => {
  const f = fixture();
  try {
    const p = resolveNeverPolicy({ codexHome: path.join(f.home, "configured-codex") });
    assert.deepEqual(p.ports.map(x => x.port).sort((a, b) => a - b), [22, 5900]);
    assert.deepEqual(p.ports.map(x => x.id).sort(), ["service.screen-sharing", "service.sshd"], "generic macOS services only");
    for (const suffix of [".ssh", ".aws", ".gnupg", ".netrc", ".codex/auth.json", ".local/share/relay-codex-home/any-file"]) assert.ok(neverPathProblem(p, path.join(os.homedir(), suffix), "read"), suffix);
    assert.ok(neverPathProblem(p, path.join(f.home, "configured-codex/any-file"), "read"));
    assert.equal(neverPathProblem(p, process.execPath, "read"), null, "X1 remains write-only");
    assert.ok(neverPathProblem(p, process.execPath, "write"));
    const removed = resolveNeverPolicy({ never: { override_builtin: [{ id: "service.sshd", acknowledge: "REMOVE BUILT-IN NEVER service.sshd", reason: "decoy policy test" }] } });
    assert.equal(removed.ports.some(x => x.id === "service.sshd"), false);
    assert.ok(mergeNeverPolicies(p, removed).ports.some(x => x.id === "service.sshd"), "a new override cannot shrink a running floor");
  } finally { f.close(); }
});

test("an override of a retired built-in (1.2.1) is still accepted, removes nothing and is warned about", () => {
  const f = fixture();
  try {
    const plain = resolveNeverPolicy({});
    for (const id of NEVER_RETIRED_BUILTIN_IDS) {
      const override_builtin = [{ id, acknowledge: `REMOVE BUILT-IN NEVER ${id}`, reason: "kept from an earlier config" }];
      const p = resolveNeverPolicy({ never: { override_builtin } });
      assert.deepEqual(p.removed, [], "nothing was removed, so nothing is reported removed");
      assert.equal(p.hash, plain.hash, "the floor is the one without the override");
      const warnings = configDeprecations({ never: { override_builtin } } as never);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], new RegExp(`${id.replace(".", "\\.")}, which is no longer a built-in never entry .*removes nothing.*never\\.ports.*this-machine.*throughout relay 1\\.x`));
      assert.doesNotMatch(warnings[0], /NEVER PROTECTION REMOVED/);
      assert.throws(() => NeverConfigSchema.parse({ override_builtin: [{ ...override_builtin[0], acknowledge: "REMOVE BUILT-IN NEVER service.sshd" }] }), /acknowledgment/);
    }
    assert.throws(() => NeverConfigSchema.parse({ override_builtin: [{ id: "service.unknown", acknowledge: "REMOVE BUILT-IN NEVER service.unknown", reason: "x" }] }));
  } finally { f.close(); }
});

test("grant admission rechecks kept raw grants and outside writes against current cumulative policy", () => {
  const f = fixture(nonTempScratch("relay-never-grant-"));
  try {
    fs.mkdirSync(path.join(f.home, "forbidden"));
    f.write({ hosts: ["secret.example"], paths: [{ path: path.join(f.home, "forbidden") }] });
    const caller: any = { runId: f.run };
    const raw = admitWork(caller, "codex", { mode: "write", kept: { network: true, raw_network: true }, continues: true }, {});
    assert.match((raw as any).reason, /never.hosts/);
    const write = admitWork(caller, "claude", { mode: "write", kept: { write_paths: [path.join(f.home, "forbidden")] }, continues: true }, {});
    assert.match((write as any).reason, /user.path/);
    f.write({});
    assert.match((admitWork(caller, "codex", { mode: "write", kept: { network: true, raw_network: true }, continues: true }, {}) as any).reason, /never.hosts/);
  } finally {
    f.close();
  }
});

test("file requests refuse before prompting; stale decisions expire and retain newly observed additions", async () => {
  const f = fixture();
  try {
    const node = insertNode({ id: "j_00000001", run_id: f.run, kind: "job", target: "codex", mode: "write", depth: 1, task: "decoy", cwd: f.home, status: "running" });
    const turn = insertTurn(node.id, "test", "", "write", "running");
    f.write({ paths: [{ path: path.join(f.home, "secret") }] });
    const blocked = await requestApproval(node.id, turn, { kind: "file", summary: "decoy", paths: [path.join(f.home, "secret/file")] });
    assert.equal(blocked.allow, false); assert.match(blocked.note!, /user.path/);
    assert.equal((db().prepare("SELECT COUNT(*) AS n FROM requests").get() as any).n, 0);
    const before = checkpointNever(f.run, "approval");
    db().prepare("INSERT INTO requests (id, run_id, node_id, turn_id, kind, summary, detail_json, status, created_at) VALUES ('q_00000001', ?, ?, ?, 'command', 'decoy', ?, 'pending', ?)").run(f.run, node.id, turn, JSON.stringify({ never_hash: before.hash }), Date.now());
    f.write({ hosts: ["new.example"] });
    assert.match(String(decide("q_00000001", true, "user").error), /stale never policy hash/);
    assert.equal(getRequest("q_00000001")!.status, "expired");
    assert.ok(readNeverFloor(f.run)!.hosts.some(h => h.host === "new.example"));
    assert.ok(neverApprovalProblem(readNeverFloor(f.run)!, "web", [], f.home));
    assert.ok(neverApprovalProblem(readNeverFloor(f.run)!, "raw_network", [], f.home));
  } finally { f.close(); }
});

test("an address the Mac gains while a person decides keeps their answer, joins the floor, and is refused from then on", async () => {
  const f = fixture();
  const real = os.networkInterfaces;
  try {
    const node = insertNode({ id: "j_00000001", run_id: f.run, kind: "job", target: "codex", mode: "write", depth: 1, task: "decoy", cwd: f.home, status: "running" });
    const turn = insertTurn(node.id, "test", "", "write", "running");
    const before = checkpointNever(f.run, "approval");
    db().prepare("INSERT INTO requests (id, run_id, node_id, turn_id, kind, summary, detail_json, status, created_at) VALUES ('q_00000001', ?, ?, ?, 'command', 'decoy', ?, 'pending', ?)").run(f.run, node.id, turn, JSON.stringify({ never_hash: before.hash, never_version: before.version, never_removed: before.removed }), Date.now());
    // AirDrop's awdl0 and llw0 come and go by themselves, with a link-local address.
    const added = "fe80::2:3:4:5";
    (os as any).networkInterfaces = () => ({ ...real(), awdl0: [{ address: `${added}%awdl0`, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: `${added}/64`, scopeid: 20 }] });
    assert.equal(decide("q_00000001", true, "user").error, undefined);
    assert.equal(getRequest("q_00000001")!.status, "allowed");
    const after = readNeverFloor(f.run)!;
    assert.equal(after.hash, before.hash, "the hash stands for what the person was asked against, not the Mac's addresses");
    assert.ok(after.localAddresses.includes(added), "still observed, and kept");
    assert.deepEqual(assertNeverCurrent(f.run, before.hash).localAddresses, after.localAddresses);
    (os as any).networkInterfaces = real;
    assert.ok(checkpointNever(f.run, "approval").localAddresses.includes(added), "an address that went away stays in the floor");
    const port = after.authorityPorts[0];
    assert.match(String(neverEndpointProblem(after, { host: added, port, transport: "tcp" })), /relay.authority/);
  } finally { (os as any).networkInterfaces = real; f.close(); }
});

test("a launch whose proxy would miss a routable address the floor gained is refused; a rotating link-local one is not", async () => {
  const f = fixture();
  const real = os.networkInterfaces;
  const gain = (address: string, family: string) => { (os as any).networkInterfaces = () => ({ ...real(), en9: [{ address, netmask: "255.255.255.255", family, mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/32` }] }); };
  try {
    const captured = checkpointNever(f.run, "launch");
    assert.doesNotThrow(() => assertNeverLaunchCurrent(f.run, captured));
    for (const rotating of ["fe80::2:3:4:5", "169.254.7.8"]) {
      gain(rotating, rotating.includes(":") ? "IPv6" : "IPv4");
      assert.ok(checkpointNever(f.run, "launch").localAddresses.includes(rotating));
      assert.doesNotThrow(() => assertNeverLaunchCurrent(f.run, captured), rotating);
    }
    gain("203.0.113.9", "IPv4");
    checkpointNever(f.run, "launch");
    (os as any).networkInterfaces = real;
    assert.equal(readNeverFloor(f.run)!.hash, captured.hash, "the person's answer still stands");
    assert.throws(() => assertNeverLaunchCurrent(f.run, captured), /203\.0\.113\.9/, "gone again, but in the floor: the captured proxy would permit it");
    assert.doesNotThrow(() => assertNeverLaunchCurrent(f.run, checkpointNever(f.run, "launch")), "a plan rebuilt on the current floor launches");
  } finally { (os as any).networkInterfaces = real; f.close(); }
});

test("built-in file refusals keep relay's person-facing reason while the cumulative floor remains enforced", async () => {
  const f = fixture();
  try {
    const node = insertNode({ id: "j_00000001", run_id: f.run, kind: "job", target: "claude", mode: "write", depth: 1, task: "decoy", cwd: f.home, status: "running" });
    const turn = insertTurn(node.id, "test", "", "write", "running");
    for (const [name, reason] of [
      [path.join(process.env.RELAY_HOME!, "relay.db"), /inside relay's own directories, which no job may change/],
      [path.join(os.homedir(), ".config/relay-keys/gemini-api-key"), /overlaps the directory of relay's API keys .*which no job may change/],
    ] as const) {
      const answer = await requestApproval(node.id, turn, { kind: "file", summary: "decoy", paths: [name] });
      assert.equal(answer.allow, false); assert.match(answer.note!, reason);
    }
    const reached = await requestApproval(node.id, turn, { kind: "path", summary: "decoy", paths: [process.env.RELAY_HOME!], detail: { access: "read" } });
    assert.equal(reached.allow, false); assert.match(reached.note!, /no approval lets a job reach/);
    assert.equal((db().prepare("SELECT COUNT(*) AS n FROM requests").get() as any).n, 0);
  } finally { f.close(); }
});

test("concurrent processes atomically merge independently observed additions", async () => {
  const f = fixture();
  try {
    checkpointNever(f.run, "approval"); closeDbForTests();
    const module = new URL("../dist/core/never-checkpoint.js", import.meta.url).href;
    const script = `import { checkpointNever } from ${JSON.stringify(module)}; checkpointNever(process.argv[1], "launch");`;
    const files = ["a", "b", "c"].map(n => { const file = path.join(f.home, `${n}.json`); fs.writeFileSync(file, JSON.stringify({ never: { hosts: [`${n}.example`] } })); return file; });
    await Promise.all(files.map(file => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, f.run], { env: { ...process.env, RELAY_CONFIG: file }, stdio: ["ignore", "ignore", "pipe"] });
      let error = ""; child.stderr.on("data", data => error += data); child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(error)));
    })));
    assert.deepEqual(readNeverFloor(f.run)!.hosts.map(h => h.host), ["a.example", "b.example", "c.example"]);
  } finally { f.close(); }
});

test("checkpoint identity history retains both targets after protected symlink replacement", () => {
  const f = fixture();
  try {
    const named = path.join(f.home, "named"); const a = path.join(f.home, "a"); const b = path.join(f.home, "b");
    fs.mkdirSync(a); fs.mkdirSync(b); fs.symlinkSync(a, named);
    f.write({ paths: [{ path: named }, { path: path.join(f.home, "future/secret") }] });
    const before = checkpointNever(f.run, "approval");
    fs.unlinkSync(named); fs.symlinkSync(b, named);
    fs.mkdirSync(path.join(f.home, "future"));
    assert.ok(neverIdentityProblem(before), "unobserved namespace change invalidates the captured plan");
    const after = checkpointNever(f.run, "launch");
    assert.notEqual(after.hash, before.hash);
    assert.equal(neverIdentityProblem(after), null, "new checkpoint preserves history and current identities");
    for (const target of [a, b]) assert.ok(neverPathProblem(after, path.join(target, "file"), "read"), target);
    f.write({});
    assert.ok(neverPathProblem(checkpointNever(f.run, "launch"), path.join(a, "file"), "read"));
  } finally { f.close(); }
});

test("schema 4 stores the run floor in JSON params without migration and reconstructs old runs", () => {
  const f = fixture();
  try {
    const file = path.join(process.env.RELAY_HOME!, "relay.db"); closeDbForTests();
    const old = new DatabaseSync(file);
    assert.equal((old.prepare("PRAGMA user_version").get() as any).user_version, 4);
    assert.equal(old.prepare("PRAGMA table_info(runs)").all().some((c: any) => c.name === "never_floor_json"), false);
    // An existing schema-4 run has no private params yet. Reopening must not migrate it.
    old.prepare("UPDATE runs SET config_json = json_remove(config_json, '$.params_json') WHERE id = ?").run(f.run);
    old.close();
    db();
    assert.equal(registryBackup(), null);
    assert.equal((db().prepare("PRAGMA user_version").get() as any).user_version, 4);
    db().prepare("UPDATE runs SET config_json = json_set(config_json, '$.params_json.unrelated', 7) WHERE id = ?").run(f.run);
    const config = runConfig(f.run);
    assert.equal("params_json" in config, false, "private run params are not configuration");
    assert.ok(checkpointNever(f.run, "launch").hash);
    assert.equal(JSON.parse(getRun(f.run)!.config_json).params_json.unrelated, 7);
    assert.deepEqual(runConfig(f.run), config, "floor updates preserve the configuration snapshot");
    db().prepare("UPDATE runs SET config_json = json_set(config_json, '$.params_json.never_floor', 'malformed') WHERE id = ?").run(f.run);
    assert.throws(() => checkpointNever(f.run, "approval"));
    assert.equal(JSON.parse(getRun(f.run)!.config_json).params_json.never_floor, "malformed");
  } finally { f.close(); }
});

test("relay-managed roots may appear or be recreated without invalidating a launch snapshot", () => {
  const savedHome = process.env.HOME; const home = scratch();
  process.env.HOME = home;
  const f = fixture();
  const aliases = path.join(home, "aliases"); fs.mkdirSync(aliases);
  setNativeTempAliasParentForTests(aliases);
  try {
    const before = checkpointNever(f.run, "launch");
    for (const root of [nativeTempRoot(), privateStateRoot(), worktreesHome(), harnessHome()]) {
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(path.join(root, "first-turn"));
      assert.doesNotThrow(() => assertNeverCurrent(f.run, before.hash), root);
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(path.join(root, "next-turn"));
      assert.doesNotThrow(() => assertNeverCurrent(f.run, before.hash), `${root} recreated`);
      assert.ok(neverPathProblem(before, path.join(root, "private-state"), "write"), "name/containment protection remains");
    }
    fs.symlinkSync(nativeTempRoot(), nativeTempAlias());
    assert.doesNotThrow(() => assertNeverCurrent(f.run, before.hash));
    fs.unlinkSync(nativeTempAlias()); fs.symlinkSync(nativeTempRoot(), nativeTempAlias());
    assert.doesNotThrow(() => assertNeverCurrent(f.run, before.hash));
    assert.equal(checkpointNever(f.run, "launch").hash, before.hash, "ordinary state creation adds no authority inode identities");
  } finally {
    setNativeTempAliasParentForTests(null); f.close();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Codex home bootstrap precedes launch snapshots and repeated preparation cannot invalidate sibling launches", () => {
  const savedHome = process.env.HOME; const home = scratch(); process.env.HOME = home;
  const f = fixture();
  try {
    const cfg = runConfig(f.run);
    const beforeBootstrap = checkpointNever(f.run, "launch");
    const codexHome = prepareCodexHome(cfg);
    const firstLaunch = checkpointNever(f.run, "launch");
    assert.notEqual(firstLaunch.hash, beforeBootstrap.hash, "new credential-home identities must enter the durable floor");
    assert.ok(firstLaunch.paths.some(entry => entry.path === codexHome && entry.pins.some(pin => pin.path === codexHome)));
    for (let sibling = 0; sibling < 3; sibling++) {
      prepareCodexHome(cfg);
      assert.equal(checkpointNever(f.run, "launch").hash, firstLaunch.hash);
      assert.doesNotThrow(() => assertNeverCurrent(f.run, firstLaunch.hash));
    }
    fs.renameSync(codexHome, `${codexHome}-replaced`); fs.mkdirSync(codexHome);
    assert.throws(() => assertNeverCurrent(f.run, firstLaunch.hash), /identity changed/, "bootstrap ordering must not weaken identity checks");
  } finally {
    f.close(); if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("grant hard-link screen considers all authorized roots while outside and immutable metadata links still refuse", () => {
  const f = fixture(nonTempScratch("relay-never-hardlinks-"));
  try {
    const worktree = path.join(f.home, "worktree"), grant = path.join(f.home, "grant"), second = path.join(f.home, "second");
    for (const root of [worktree, grant, second]) fs.mkdirSync(root);
    fs.writeFileSync(path.join(worktree, "file"), "decoy");
    fs.linkSync(path.join(worktree, "file"), path.join(grant, "file"));
    const p = checkpointNever(f.run, "grant");
    const given = { write_paths: [grant] };
    assert.match(neverGrantProblem(p, given)!, /outside hard link/, "a new job cannot treat another job's tree as writable");
    assert.equal(neverGrantProblem(p, given, [worktree]), null, "a resumed job may link between its own writable roots");
    fs.writeFileSync(path.join(grant, "shared"), "decoy"); fs.linkSync(path.join(grant, "shared"), path.join(second, "shared"));
    assert.equal(neverGrantProblem(p, { write_paths: [grant, second] }, [worktree]), null, "two granted roots are one writable set");
    const caller = { runId: f.run, node: null, depth: 0, cwd: f.home, access: "write" as const };
    assert.ok(!("reason" in admitWork(caller, "claude", { mode: "write", grant: { write_paths: [grant, second] }, continues: true, worktree }, {})), "resume admission passes its existing worktree to the shared screen");
    const outside = path.join(f.home, "outside"); fs.writeFileSync(outside, "decoy");
    fs.linkSync(outside, path.join(second, "outside"));
    assert.match(neverGrantProblem(p, { write_paths: [grant, second] }, [worktree])!, /outside hard link/);
    fs.unlinkSync(path.join(second, "outside"));
    for (const metadata of [".git", ".relay"]) {
      fs.mkdirSync(path.join(worktree, metadata)); fs.writeFileSync(path.join(worktree, metadata, "authority"), "decoy");
      fs.linkSync(path.join(worktree, metadata, "authority"), path.join(grant, "alias"));
      assert.match(neverGrantProblem(p, { write_paths: [grant, second] }, [worktree])!, /outside hard link/, metadata);
      fs.unlinkSync(path.join(grant, "alias"));
    }
    fs.writeFileSync(path.join(grant, ".mcp.json"), "{}");
    fs.linkSync(path.join(grant, ".mcp.json"), path.join(second, "config-alias"));
    assert.match(neverGrantProblem(p, { write_paths: [grant, second] }, [worktree])!, /outside hard link/, "protected harness config stays immutable across writable roots");
    fs.unlinkSync(path.join(second, "config-alias"));
  } finally { f.close(); }
});

test("stale native temp alias repair keeps the launch checkpoint and denies grants and never writes by both names", () => {
  const savedHome = process.env.HOME; const home = nonTempScratch("relay-never-alias-"); process.env.HOME = home;
  const f = fixture(nonTempScratch("relay-never-registry-"));
  const parent = path.join(home, "aliases"); fs.mkdirSync(parent);
  setNativeTempAliasParentForTests(parent);
  try {
    const oldRoot = path.join(home, "deleted-home", ".rn");
    fs.symlinkSync(oldRoot, nativeTempAlias());
    fs.mkdirSync(nativeTempRoot(), { mode: 0o700 });
    assert.equal(checkNativeTempAlias(nativeTempRoot()).state, "stale", "exercise repair of an owned link through canonical, trusted ancestors");
    const before = checkpointNever(f.run, "launch");
    const checkDenied = () => {
      for (const name of [parent, nativeTempAlias(), path.join(nativeTempAlias(), "Ab12Cd"), nativeTempRoot()]) {
        assert.ok(neverPathProblem(before, name, "write", true), name);
        assert.ok(neverGrantProblem(before, { write_paths: [name] }), name);
        const admission = admitWork({ runId: f.run, node: null } as any, "claude", {
          mode: "write", grant: { write_paths: [name] }, continues: false,
        }, {}) as { reason: string };
        assert.match(admission.reason, /short link|private temporary state|never relay.authority|not an existing directory/, name);
      }
    };
    checkDenied();
    ensureNativeTempAlias(nativeTempRoot());
    assert.equal(fs.readlinkSync(nativeTempAlias()), nativeTempRoot());
    assert.doesNotThrow(() => assertNeverCurrent(f.run, before.hash));
    assert.equal(checkpointNever(f.run, "launch").hash, before.hash);
    checkDenied();
    assert.equal(fs.existsSync(oldRoot), false);
  } finally {
    setNativeTempAliasParentForTests(null); f.close();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("missing protected names may be created while existing protected objects still detect replacement", () => {
  const home = scratch();
  try {
    const file = path.join(home, "file"); const dir = path.join(home, "dir");
    fs.writeFileSync(file, "decoy"); fs.mkdirSync(dir);
    const p = policy({ paths: [{ path: file }, { path: dir }, { path: path.join(home, "new/secret") }] });
    fs.mkdirSync(path.join(home, "new")); fs.writeFileSync(path.join(home, "new/secret"), "decoy");
    assert.equal(neverIdentityProblem(p), null, "creation at a never name remains protected by name");
    fs.renameSync(file, path.join(home, "old-file")); fs.writeFileSync(file, "replacement");
    assert.match(neverIdentityProblem(p)!, /identity changed/);
    const refreshed = policy({ paths: [{ path: file }, { path: dir }] });
    fs.renameSync(dir, path.join(home, "old-dir")); fs.mkdirSync(dir);
    assert.match(neverIdentityProblem(refreshed)!, /identity changed/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

for (const change of ["pin-store", "pin-store-child", "pin-store-parent", "replaced", "removed", "repointed"] as const) test(`protected package installation ${change}: checkpoints refresh ordinary installs but keep sealed pins`, (t) => {
  // Exercise the synthetic installation independently of the host's CLIs and system keychain.
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  });
  process.env.PATH = "/usr/bin:/bin";
  const home = scratch(); process.env.HOME = home;
  closeDbForTests();
  const f = fixture(home, withDefaults({ ask_user: "never", allow_temp_home: true, never: { override_builtin: [{
    id: "credentials.keychain", acknowledge: "REMOVE BUILT-IN NEVER credentials.keychain", reason: "installation identity fixture",
  }] } }));
  try {
    // Model a stable CLI name pointing into a sealed pin or a versioned Caskroom installation.
    const bin = path.join(f.home, "bin"); fs.mkdirSync(bin);
    const store = path.join(f.home, ".local/share/relay-codex-pins");
    const sealed = change === "pin-store" || change === "pin-store-child";
    const install = change === "pin-store" ? store : change.startsWith("pin-store-") ? path.join(store, "versions/0.164.0") : path.join(f.home, "Caskroom/codex/0.164.0");
    const cli = path.join(bin, "codex");
    const putCLI = (dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    };
    putCLI(install); fs.symlinkSync(path.join(install, "codex"), cli);
    const config = withDefaults({ ...runConfig(f.run), targets: { codex: { bin: cli } } });
    fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify(config));
    const run = createRun(f.home, config, "before-upgrade");
    const before = checkpointNever(run, "launch");
    const original = before.paths.filter(p => p.id === "relay.install").flatMap(p => p.pins).find(p => p.path === install)!;
    assert.ok(original, "the resolved CLI installation is identity-pinned");
    assert.ok(before.paths.some(p => p.id === "relay.install" && p.path === store && p.what === "relay's pinned Codex installation"));
    assert.ok(relayWriteProtected().some(p => p.path === cli));
    assert.ok(relayWriteProtected().some(p => p.path === path.join(install, "codex")));
    assert.equal(relayCodexProtected(config).stores.some(p => p.path === install), change === "pin-store");
    assert.equal(relayPathDirs(bin).includes(install), false);
    assert.equal(neverIdentityProblem(before), null);

    const current = change === "removed" || change === "repointed" ? path.join(f.home, "Caskroom/codex/0.166.0") : install;
    let changedPath = install;
    if (change === "pin-store-parent") {
      // Replace only an ancestor, preserving the store and every object underneath it.
      changedPath = path.dirname(store);
      const oldParent = path.join(f.home, "old-parent");
      fs.renameSync(changedPath, oldParent); fs.mkdirSync(changedPath);
      fs.renameSync(path.join(oldParent, path.basename(store)), store);
    } else {
      // Keep old inodes alive so the filesystem cannot reuse them for the replacement.
      if (change !== "repointed") fs.renameSync(install, path.join(f.home, "old-install"));
      putCLI(current);
    }
    if (change === "removed" || change === "repointed") {
      fs.unlinkSync(cli); fs.symlinkSync(path.join(current, "codex"), cli);
      if (change === "repointed") changedPath = cli;
    }
    const expected = `never relay.install: protected path identity ${change === "removed" ? "is unavailable" : "changed"} at ${changedPath}; it may have been replaced by a package-manager upgrade. Ask the person to start a fresh relay run (cancel this run, restart relay's MCP server for a per-session connection, or use a new session for a shared server), then start new work. Retrying, resuming or adopting this run does not create a fresh run.`;
    assert.equal(neverIdentityProblem(before), expected);
    assert.throws(() => assertNeverCurrent(run, before.hash), { message: expected });
    const retried = checkpointNever(run, "launch");
    const afterCheckpoint = sealed || change === "removed" ? expected : null;
    assert.equal(neverIdentityProblem(retried), afterCheckpoint, "only sealed pins reject observed replacements; vanished ordinary paths still refuse");
    if (afterCheckpoint) assert.throws(() => assertNeverCurrent(run, retried.hash), { message: expected });
    else assert.doesNotThrow(() => assertNeverCurrent(run, retried.hash));
    closeDbForTests();
    assert.equal(neverIdentityProblem(readNeverFloor(run)!), afterCheckpoint, "reopening the registry preserves the checkpoint result");

    const freshRun = createRun(f.home, config, "after-person-restart");
    const fresh = checkpointNever(freshRun, "launch");
    assert.equal(neverIdentityProblem(fresh), null);
    const replacement = fresh.paths.filter(p => p.id === "relay.install").flatMap(p => p.pins).find(p => p.path === current)!;
    assert.equal(replacement.ino, fs.lstatSync(current).ino);
    if (change !== "pin-store-parent") assert.notEqual(replacement.ino, original.ino);
    else assert.equal(replacement.ino, original.ino, "replacing the ancestor preserved the sealed installation");
    assert.ok(neverPathProblem(fresh, path.join(current, "file"), "write"), "the fresh run still denies writes to the replacement");
    assert.doesNotThrow(() => assertNeverCurrent(freshRun, fresh.hash));
    assert.equal(neverIdentityProblem(readNeverFloor(run)!), afterCheckpoint, "the new run does not alter the old run's checkpoint");
  } finally { f.close(); }
});

test("successive native temp launches pass the checkpoint and clean up their own directories", async () => {
  const savedHome = process.env.HOME; const home = scratch(); process.env.HOME = home;
  const f = fixture();
  try {
    const policy = checkpointNever(f.run, "launch");
    const seen: string[] = [];
    for (let turn = 0; turn < 3; turn++) {
      const handle = await nativeTemp({ target: { id: "codex" } } as never, async (dir) => {
        seen.push(dir);
        assert.doesNotThrow(() => assertNeverCurrent(f.run, policy.hash));
        return { done: Promise.resolve({ text: "decoy" }), cancel: async () => {} } as never;
      });
      await handle.done;
      assert.equal(fs.existsSync(seen.at(-1)!), false);
    }
    assert.equal(new Set(seen).size, 3);
    assert.equal(checkpointNever(f.run, "launch").hash, policy.hash);
  } finally {
    f.close(); if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("X1 never refusals preserve the target identity, sandbox explanation and kept-grant recovery", () => {
  const f = fixture(nonTempScratch("relay-never-x1-"));
  try {
    const kept = path.join(f.home, "kept"); fs.mkdirSync(kept);
    const cli = path.join(kept, "gemini"); fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify({ targets: { gemini: { bin: cli } } }));
    const policy = checkpointNever(f.run, "grant");
    const why = neverPathProblem(policy, kept, "write", true)!;
    assert.match(why, /the gemini target's CLI .*which relay runs outside any sandbox/);
    assert.match(why, /never relay.install/);
    const caller: any = { runId: f.run, node: null };
    const fresh = admitWork(caller, "claude", { mode: "write", grant: { write_paths: [kept] }, continues: false }, {}) as { reason: string };
    assert.match(fresh.reason, /the gemini target's CLI .*outside any sandbox/);
    const checkKept = () => {
      const result = admitWork(caller, "claude", { mode: "write", kept: { write_paths: [kept] }, continues: true }, {}) as { reason: string };
      assert.match(result.reason, /can no longer be used: .*the gemini target's CLI .*outside any sandbox/);
      assert.match(result.reason, /Continue it with a grant of its own .*that leaves that out/);
    };
    checkKept();
    // The cumulative floor retains the explanation after this CLI leaves the live config.
    fs.writeFileSync(process.env.RELAY_CONFIG!, "{}");
    checkKept();
  } finally {
    f.close();
  }
});

test("config never refusals explain protection through linked names and data-volume aliases", () => {
  // /tmp is a symlink on macOS: only its physical /private/tmp name has a data-volume alias.
  const f = fixture(fs.realpathSync(scratch()));
  try {
    const named = process.env.RELAY_CONFIG!;
    // Sort the dedicated directory before the configured name so a broad directory deny cannot
    // hide the specific file's explanation in the deterministically sorted policy.
    const real = path.join(f.home, "a-synced/config.json");
    fs.mkdirSync(path.dirname(real)); fs.renameSync(named, real); fs.symlinkSync(real, named);
    const policy = checkpointNever(f.run, "approval");
    for (const file of [named, real, path.join(f.home, "mcp.json")]) {
      const names = [file, ...(process.platform === "darwin" ? [path.join("/System/Volumes/Data", file)] : [])];
      for (const name of names) {
        const reason = neverPathProblem(policy, name, "write")!;
        assert.match(reason, /is relay's own config file .*\b(?:config|mcp)\.json, which no job may change/);
        assert.match(reason, /\(never relay\.config\)/);
        assert.equal(neverApprovalProblem(policy, "file", [name], f.home), reason);
        assert.equal(neverPathProblem(policy, name, "read"), reason);
      }
    }
    assert.match(neverPathProblem(policy, path.dirname(real), "write", true)!, /relay's own config file .*which no job may change/);
  } finally { f.close(); }
});

test("doctor discloses which agents the never floor binds, per stage-2 state, from the launch predicate (core/never-coverage.ts)", async () => {
  const { neverFloorReport } = await import("../dist/core/never-coverage.js");
  const { TARGETS, targetLabel } = await import("../dist/targets/index.js");
  const rows = TARGETS.map((t) => ({ id: t.id, label: targetLabel(t, t.id), enabled: true }));
  const report = (stage2: boolean, allow_dangerous: boolean) => neverFloorReport(rows, { targets: { codex: { stage2 } }, child_settings: "isolated", child_hooks: false, child_mcp: "relay-only", allow_dangerous }, {}).join("\n");
  const off = report(false, false);
  assert.match(off, /codex, enabled: path entries enforced in every sandboxed turn's profile; keychain IPC closed on network-off turns, open on network-on turns\n/);
  assert.match(off, /claude, enabled: path entries enforced, whatever stage 2 says; keychain IPC open/);
  assert.match(off, /copilot \(experimental\), enabled: not enforced; refused with stage 2 on/);
  assert.match(off, /gemini, enabled: not enforced; enforced only with stage 2 on/);
  assert.match(off, /relay's network proxy, where a turn uses one .* still screens never hosts and ports/);
  assert.doesNotMatch(off, /allow_dangerous write turns/);
  assert.match(report(false, true), /not in allow_dangerous write turns, which run without a sandbox/);
  const on = report(true, true);
  assert.match(on, /stage-2 executor/);
  assert.match(on, /allow_dangerous write jobs refused outside the stage-2 route/);
  assert.match(on, /gemini, enabled: path entries enforced, only while stage 2 is on; keychain IPC closed/);
  assert.match(on, /copilot \(experimental\), enabled: refused/);
  assert.match(on, /grok \(experimental\), enabled: refused/);
  assert.doesNotMatch(on, /not enforced/);
  assert.match(on, /stage-2 executor; keychain IPC closed/, "with stage 2 on, Codex network turns run in relay's executor");
  assert.match(off, /keychain IPC open: .*reach the security daemons\. Items in file-based keychains .* still stay out of reach, since reading one also needs its keychain file, which the floor denies .*data-protection keychain items, is not covered, nor is a copy of a keychain file kept outside the denied directories\./, "the open keychain IPC is disclosed, with what the file deny still keeps out of reach and what it does not");
});
