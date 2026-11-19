// The decoy keychain helper (test/keychain-decoy.ts) against a fake `security`: it runs only under a
// scratch HOME, only reads the person's search list and default keychain (with the account's home),
// never sets them, and fails loudly if they change. No real keychain is touched here: the fake
// writes only inside scratch directories.
import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { attempt, decoyKeychain, EXIT_MARKER, SECURITY, withTeardown, wrapped, type DecoyKeychain, type SecurityResult, type SecurityRunner } from "./keychain-decoy.ts";

const ACCOUNT_HOME = os.userInfo().homedir;
const LOGIN = "/Users/someone/Library/Keychains/login.keychain-db";
const NO_DEFAULT: SecurityResult = { status: 1, stdout: "", stderr: "security: SecKeychainCopyDomainDefault user: A default keychain could not be found." };
type Prefs = { list: string[]; dflt: string | null };
type Call = { args: string[]; home?: string };
type Fake = { run: SecurityRunner; calls: Call[]; person: Prefs };

/**
 * A fake `security`. With home set to the account's home it answers from the person's preferences;
 * with the inherited HOME, from a scratch HOME's (empty search list, no default). create-keychain and
 * delete-keychain write and remove the named (scratch) file. `fail` decides which calls fail;
 * `onCreate` lets a test change the person's preferences as a misbehaving `security` would.
 */
function fakeSecurity(o: { person?: Partial<Prefs>; fail?: (c: Call) => Partial<SecurityResult> | null; onCreate?: (person: Prefs) => void } = {}): Fake {
  const person: Prefs = { list: [LOGIN], dflt: LOGIN, ...o.person };
  const scratchPrefs: Prefs = { list: [], dflt: null };
  const calls: Call[] = [];
  const run: SecurityRunner = (args, opts = {}) => {
    const call = { args, home: opts.home };
    calls.push(call);
    if (opts.home !== undefined && opts.home !== ACCOUNT_HOME) throw new Error(`fake security: unexpected HOME ${opts.home}`);
    const failure = o.fail?.(call);
    if (failure) return { status: 1, stdout: "", stderr: "fake failure", ...failure };
    const prefs = opts.home === ACCOUNT_HOME ? person : scratchPrefs;
    const ok = (stdout = ""): SecurityResult => ({ status: 0, stdout, stderr: "" });
    switch (args[0]) {
      case "list-keychains": return ok(prefs.list.map((p) => `    "${p}"\n`).join(""));
      case "default-keychain": return prefs.dflt ? ok(`    "${prefs.dflt}"\n`) : NO_DEFAULT;
      case "create-keychain": fs.writeFileSync(args.at(-1)!, ""); o.onCreate?.(person); return ok();
      case "delete-keychain": fs.rmSync(args.at(-1)!); return ok();
      default: return ok();
    }
  };
  return { run, calls, person };
}
const scratch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-decoy-unit-")), "k");
const isPrefs = (c: Call) => c.args[0] === "list-keychains" || c.args[0] === "default-keychain";
const READS = [["list-keychains", "-d", "user"], ["default-keychain", "-d", "user"]];

/** The person's preferences are only ever read, with the account's home; everything else names the decoy by path under the inherited HOME. */
function onlyReadsPrefs(fake: Fake, keychain: string) {
  for (const c of fake.calls) {
    if (isPrefs(c)) {
      assert.ok(READS.some((r) => JSON.stringify(r) === JSON.stringify(c.args)), `only plain reads of the preferences, never -s: ${JSON.stringify(c.args)}`);
      assert.equal(c.home, ACCOUNT_HOME, "the preferences are read with the account's home");
    } else {
      assert.equal(c.home, undefined, `decoy commands run with the inherited scratch HOME: ${JSON.stringify(c)}`);
      assert.equal(c.args.at(-1), keychain, `decoy commands name the keychain by path: ${JSON.stringify(c.args)}`);
    }
  }
}

test("decoy keychain: outside a scratch HOME it refuses before running or creating anything", () => {
  const saved = process.env.HOME;
  const links = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-decoy-home-")));
  fs.symlinkSync(ACCOUNT_HOME, path.join(links, "home-link"));
  try {
    for (const home of [ACCOUNT_HOME, path.join(links, "home-link"), undefined, path.join(links, "missing")]) {
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      const fake = fakeSecurity();
      const dir = scratch();
      assert.throws(() => decoyKeychain(dir, fake.run), /refusing to run with HOME=.*runs only under the test harness's scratch HOME/, String(home));
      assert.deepEqual(fake.calls, [], `nothing ran with HOME=${home}`);
      assert.ok(!fs.existsSync(dir), "nothing was created");
    }
  } finally {
    process.env.HOME = saved;
    fs.rmSync(links, { recursive: true, force: true });
  }
});

test("decoy keychain: the person's preferences are read with the account's home before and after, never set, and cleanup deletes the keychain", () => {
  const fake = fakeSecurity();
  const dir = scratch();
  const decoy = decoyKeychain(dir, fake.run);
  assert.equal(decoy.keychain, path.join(dir, "relay-decoy.keychain-db"));
  assert.deepEqual(fake.calls.slice(0, 2).map((c) => c.args), READS, "the person's preferences are read first");
  assert.ok(fake.calls.findIndex((c) => c.args[0] === "create-keychain") > 1, "and only then is the keychain created");
  const add = fake.calls.find((c) => c.args[0] === "add-generic-password")!;
  assert.equal(add.args[add.args.indexOf("-T") + 1], SECURITY, "the item's access list trusts /usr/bin/security");
  decoy.cleanup();
  assert.ok(fake.calls.some((c) => c.args[0] === "delete-keychain" && c.args.at(-1) === decoy.keychain), "cleanup deletes the keychain by path");
  assert.ok(!fs.existsSync(dir), "and removes its directory");
  assert.deepEqual(fake.calls.filter(isPrefs).map((c) => c.args), [...READS, ...READS], "read once before, once after");
  onlyReadsPrefs(fake, decoy.keychain);
  assert.deepEqual(fake.person, { list: [LOGIN], dflt: LOGIN });
});

test("decoy keychain: a person with no default keychain is fine while that stays so", () => {
  const fake = fakeSecurity({ person: { dflt: null } });
  const decoy = decoyKeychain(scratch(), fake.run);
  assert.doesNotThrow(() => decoy.cleanup());
  onlyReadsPrefs(fake, decoy.keychain);
});

test("decoy keychain: a change in the person's preferences is a loud error with both readings and the fix by hand, after cleaning up", () => {
  let keychain = "";
  const changed = fakeSecurity({ onCreate: (person) => { person.list = [...person.list, keychain]; person.dflt = keychain; } });
  const dir = scratch();
  keychain = path.join(dir, "relay-decoy.keychain-db");
  const decoy = decoyKeychain(dir, changed.run);
  assert.throws(() => decoy.cleanup(), (err: Error) => {
    assert.match(err.message, /changed while the decoy existed/);
    assert.match(err.message, /before: search list exit 0 .*login\.keychain-db.*; default exit 0/);
    assert.match(err.message, /after: +search list exit 0 .*relay-decoy\.keychain-db/);
    assert.ok(err.message.includes(`security list-keychains -d user -s ${JSON.stringify(LOGIN)}`), err.message);
    assert.ok(err.message.includes(`security default-keychain -d user -s ${JSON.stringify(LOGIN)}`), err.message);
    return true;
  });
  assert.ok(changed.calls.some((c) => c.args[0] === "delete-keychain"), "the keychain is still deleted");
  assert.ok(!fs.existsSync(dir), "and its directory removed");
  onlyReadsPrefs(changed, keychain);

  // A default appearing where there was none: no command can be built from the failed read, so it says so.
  const appeared = fakeSecurity({ person: { dflt: null }, onCreate: (person) => { person.dflt = LOGIN; } });
  const second = decoyKeychain(scratch(), appeared.run);
  assert.throws(() => second.cleanup(), (err: Error) => {
    assert.match(err.message, /there was no default keychain before \(exit 1 ""\)/);
    assert.ok(!err.message.includes("default-keychain -d user -s"), err.message);
    assert.ok(!err.message.includes("list-keychains -d user -s"), "only what changed is named");
    return true;
  });
  onlyReadsPrefs(appeared, second.keychain);
});

test("decoy keychain: a read of the person's preferences that does not complete stops before anything is created", () => {
  for (const failure of [{ status: null, signal: "SIGKILL" as const }, { status: null, error: new Error("spawn ENOENT") }]) {
    for (const which of ["list-keychains", "default-keychain"]) {
      const fake = fakeSecurity({ fail: (c) => (c.args[0] === which ? failure : null) });
      const dir = scratch();
      assert.throws(() => decoyKeychain(dir, fake.run), /could not read the person's keychain preferences/);
      assert.ok(!fake.calls.some((c) => !isPrefs(c)), JSON.stringify(fake.calls));
      assert.ok(!fs.existsSync(dir));
    }
  }
});

test("decoy keychain: a failure during setup cleans up, still checks the preferences, and rethrows", () => {
  // add-generic-password fails after the keychain was created.
  const late = fakeSecurity({ fail: (c) => (c.args[0] === "add-generic-password" ? { status: 1 } : null) });
  const dir = scratch();
  assert.throws(() => decoyKeychain(dir, late.run), /security add-generic-password .* failed \(exit 1\)/);
  assert.ok(late.calls.some((c) => c.args[0] === "delete-keychain" && c.args.at(-1) === path.join(dir, "relay-decoy.keychain-db")));
  assert.ok(!fs.existsSync(dir));
  assert.equal(late.calls.filter(isPrefs).length, 4, "read before and after");
  onlyReadsPrefs(late, path.join(dir, "relay-decoy.keychain-db"));

  // create-keychain reports failure but left a file: it is still deleted by path.
  const partial = fakeSecurity({ fail: (c) => {
    if (c.args[0] !== "create-keychain") return null;
    fs.writeFileSync(c.args.at(-1)!, "");
    return { status: 1 };
  } });
  const dir2 = scratch();
  assert.throws(() => decoyKeychain(dir2, partial.run), /security create-keychain .* failed/);
  assert.ok(partial.calls.some((c) => c.args[0] === "delete-keychain"));
  assert.ok(!fs.existsSync(dir2));

  // A cleanup problem during a setup failure is reported with the original error.
  const both = fakeSecurity({ fail: (c) => (c.args[0] === "unlock-keychain" || c.args[0] === "delete-keychain" ? { status: 1 } : null) });
  assert.throws(() => decoyKeychain(scratch(), both.run), (err: Error) => {
    assert.match(err.message, /security unlock-keychain .* failed/);
    assert.match(err.message, /security delete-keychain .* failed/);
    return true;
  });
});

test("decoy keychain: the command line uses no shell variables, and prints exactly one exit marker", () => {
  const decoy = (command: string[]) => ({ dir: "/x", keychain: "/x/k", service: "s", account: "a", secret: "RELAY_DECOY_KEYCHAIN_00", command, cleanup() {} });
  const line = wrapped(decoy(["/usr/bin/security", "find-generic-password", "-w", "/x/k"]));
  assert.equal(line, `'/usr/bin/security' 'find-generic-password' '-w' '/x/k' && echo ${EXIT_MARKER}:0 || echo ${EXIT_MARKER}:1`);
  // Claude Code refuses an unattended command whose variables it can't check before it runs.
  assert.ok(!line.includes("$"), line);
  // Run by a real sh: one marker, 0 on success and 1 on failure, with the arguments quoted.
  for (const [command, out] of [[["/bin/echo", "it's"], `it's\n${EXIT_MARKER}:0\n`], [["/usr/bin/false"], `${EXIT_MARKER}:1\n`], [["/bin/sh", "-c", "exit 44"], `${EXIT_MARKER}:1\n`]] as const) {
    const r = spawnSync("/bin/sh", ["-c", wrapped(decoy([...command]))], { encoding: "utf8" });
    assert.equal(r.stdout, out, JSON.stringify(command));
  }
});

test("decoy keychain: an attempt counts only with its exit marker, and must be consistent", () => {
  const decoy = { dir: "/x", keychain: "/x/k", service: "s", account: "a", secret: "RELAY_DECOY_KEYCHAIN_00", command: ["/usr/bin/security", "find-generic-password", "-w", "/x/k"], cleanup() {} };
  assert.equal(attempt(decoy, `RELAY_DECOY_KEYCHAIN_00\n${EXIT_MARKER}:0\n`), "retrieved");
  assert.equal(attempt(decoy, `security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n${EXIT_MARKER}:1\n`), "refused");
  assert.equal(attempt(decoy, `security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n${EXIT_MARKER}:44\n`), "refused");
  // The command line's own text, echoed back without output (a tool refusal quoting it), names both markers.
  for (const output of ["", "RELAY_DECOY_KEYCHAIN_00", `${EXIT_MARKER}:0\n`, `RELAY_DECOY_KEYCHAIN_00\n${EXIT_MARKER}:1`, `${EXIT_MARKER}:1\n${EXIT_MARKER}:1`, `echo ${EXIT_MARKER}:$?`, wrapped(decoy), `${wrapped(decoy)}\n${EXIT_MARKER}:1\n`]) {
    assert.throws(() => attempt(decoy, output), /not evidence/, JSON.stringify(output));
  }
  // A failed attempt's error shows the output's tail, never the secret.
  assert.throws(() => attempt(decoy, `RELAY_DECOY_KEYCHAIN_00 ${"x".repeat(700)}`), (err: Error) => {
    assert.ok(!err.message.includes("RELAY_DECOY_KEYCHAIN_00"), err.message);
    assert.match(err.message, /last 600 characters, secret redacted/);
    return true;
  });
  assert.throws(() => attempt(decoy, "RELAY_DECOY_KEYCHAIN_00 denied"), (err: Error) => {
    assert.ok(!err.message.includes("RELAY_DECOY_KEYCHAIN_00") && err.message.includes("<secret> denied"), err.message);
    return true;
  });
});

// The callers' teardown (codex-permissions.test.ts item 33, stage2-native-live.test.ts claude-floor)
// runs through withTeardown, in this order: decoy cleanup while HOME is still the scratch one (its
// mutating `security` commands use the inherited HOME), then HOME restored, then the scratch home
// removed. A cleanup failure must not skip the later steps or hide the test's own failure.
const homeOrderedTeardown = (o: { harnessHome: string; callerHome: string; decoy: () => DecoyKeychain | undefined; restored: string[] }) => [
  ["decoy cleanup", () => o.decoy()?.cleanup()],
  ["environment", () => { process.env.HOME = o.harnessHome; o.restored.push("HOME"); }],
  ["scratch home", () => fs.rmSync(o.callerHome, { recursive: true, force: true })],
] as const;

test("decoy teardown: a failing decoy cleanup still restores HOME and removes the scratch home, after cleaning up under the scratch HOME, and the test's own error survives beside it", async () => {
  const harnessHome = process.env.HOME!;
  const callerHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-decoy-caller-")));
  try {
    process.env.HOME = callerHome; // As the Claude caller's useScratch does.
    const homeAtDelete: string[] = [];
    const fake = fakeSecurity({ fail: (c) => (c.args[0] === "delete-keychain" ? { stderr: "DELETE_FAILED" } : null) });
    const run: SecurityRunner = (args, opts) => { if (args[0] === "delete-keychain") homeAtDelete.push(process.env.HOME!); return fake.run(args, opts); };
    const restored: string[] = [];
    let decoy: DecoyKeychain | undefined;
    const own = new assert.AssertionError({ message: "the test's own assertion failed" });
    await assert.rejects(withTeardown(() => {
      decoy = decoyKeychain(path.join(callerHome, "keychains"), run);
      throw own;
    }, homeOrderedTeardown({ harnessHome, callerHome, decoy: () => decoy, restored })), (err: AggregateError) => {
      assert.ok(err instanceof AggregateError, String(err));
      assert.equal(err.errors[0], own, "the original assertion error is kept, unchanged");
      assert.equal(err.errors.length, 2);
      assert.match(err.message, /^the test's own assertion failed\n/);
      assert.match(err.message, /teardown step "decoy cleanup" also failed: decoy keychain: security delete-keychain .* failed \(exit 1\): DELETE_FAILED/);
      return true;
    });
    assert.deepEqual(restored, ["HOME"], "HOME was restored");
    assert.equal(process.env.HOME, harnessHome);
    assert.ok(!fs.existsSync(callerHome), "the scratch home was removed");
    assert.deepEqual(homeAtDelete, [callerHome], "the decoy's delete ran before HOME was restored, under the scratch HOME");
  } finally {
    process.env.HOME = harnessHome;
    fs.rmSync(callerHome, { recursive: true, force: true });
  }
});

test("decoy teardown: with no failure of its own, the test fails with the cleanup's error itself; every step still runs, and a passing teardown leaves the test's error untouched", async () => {
  const harnessHome = process.env.HOME!;
  for (const bodyFails of [false, true]) for (const cleanupFails of [false, true]) {
    const callerHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-decoy-caller-")));
    try {
      process.env.HOME = callerHome;
      const fake = fakeSecurity({ fail: (c) => (cleanupFails && c.args[0] === "delete-keychain" ? { stderr: "DELETE_FAILED" } : null) });
      const restored: string[] = [];
      let decoy: DecoyKeychain | undefined;
      const own = new Error("BODY_FAILED");
      const done = withTeardown(async () => {
        decoy = decoyKeychain(path.join(callerHome, "keychains"), fake.run);
        if (bodyFails) throw own;
        return "result";
      }, homeOrderedTeardown({ harnessHome, callerHome, decoy: () => decoy, restored }));
      const label = `body ${bodyFails ? "fails" : "passes"}, cleanup ${cleanupFails ? "fails" : "passes"}`;
      if (!bodyFails && !cleanupFails) assert.equal(await done, "result", label);
      else await assert.rejects(done, (err: Error) => {
        if (bodyFails && !cleanupFails) assert.equal(err, own, `${label}: the body's own error, unwrapped`);
        if (!bodyFails) {
          assert.ok(!(err instanceof AggregateError), label);
          assert.match(err.message, /^decoy keychain: security delete-keychain .* failed \(exit 1\): DELETE_FAILED/, label);
        }
        return true;
      }, label);
      assert.deepEqual(restored, ["HOME"], label);
      assert.equal(process.env.HOME, harnessHome, label);
      assert.ok(!fs.existsSync(callerHome), label);
    } finally {
      process.env.HOME = harnessHome;
      fs.rmSync(callerHome, { recursive: true, force: true });
    }
  }
  // Several failing steps are all reported, in order, and none stops the next.
  const ran: string[] = [];
  await assert.rejects(withTeardown(() => "ok", [
    ["first", () => { ran.push("first"); throw new Error("FIRST"); }],
    ["second", async () => { ran.push("second"); throw new Error("SECOND"); }],
    ["third", () => { ran.push("third"); }],
  ]), (err: AggregateError) => {
    assert.ok(err instanceof AggregateError);
    assert.deepEqual(err.errors.map((e: Error) => e.message), ["FIRST", "SECOND"]);
    assert.match(err.message, /teardown step "first" also failed: FIRST[\s\S]*teardown step "second" also failed: SECOND/);
    return true;
  });
  assert.deepEqual(ran, ["first", "second", "third"]);
});

test("decoy teardown: both live callers tear down through withTeardown, cleaning the decoy up before anything restores HOME or removes their scratch", () => {
  for (const [file, steps] of [
    ["codex-permissions.test.ts", ["decoy cleanup", "scratch tree"]],
    ["stage2-native-live.test.ts", ["model stub", "decoy cleanup", "environment", "scratch home"]],
  ] as const) {
    const source = fs.readFileSync(path.join(import.meta.dirname, file), "utf8");
    const start = source.indexOf("keychain decoy live (");
    assert.ok(start > 0, file);
    const body = source.slice(start, source.indexOf("\n});\n", start));
    assert.match(body, /withTeardown\(/, `${file} uses withTeardown`);
    assert.doesNotMatch(body, /finally \{[^}]*cleanup\(\)/, `${file} no longer cleans up in a bare finally`);
    const at = steps.map((name) => body.indexOf(`["${name}",`));
    assert.ok(at.every((i) => i > 0), `${file}: every step named: ${JSON.stringify(at)}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, `${file}: steps in the order ${steps.join(", ")}`);
  }
});
