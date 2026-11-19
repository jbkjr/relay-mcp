import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parse } from "smol-toml";
import { managedSettings } from "../dist/core/claude-settings.js";
import { SCHEMA_VERSION } from "../dist/core/db.js";
import { leftTempsLine } from "../dist/core/retention.js";
import { codexBlock } from "../dist/hosts/codex.js";
import { RELAY_CODEX_CONFIG, RELAY_CODEX_HOME_MARKER } from "../dist/backends/codex-pin.js";
import { CLI, hostVar } from "./helpers.ts";

// Everything here runs against a temporary HOME and CODEX_HOME, with fake `claude` and `codex`
// executables first on a PATH that does not reach the real ones. Nothing touches the real home.

const ROOT = fs.realpathSync(path.resolve(import.meta.dirname, ".."));
const LAUNCHER = path.join(ROOT, "bin", "relay");
const FAKE = path.join(ROOT, "test", "stubs", "fake-host-cli.mjs");
const HOST_ARGS = { claude: ["mcp", "--host", "claude"], codex: ["mcp", "--host", "codex"] };

type Rec = Record<string, any>;
interface Out { status: number | null; stdout: string; stderr: string; all: string }

interface Box {
  tmp: string;
  home: string;
  bin: string;
  /** Codex's config.toml, relay's link, the desktop app's config and relay's installation record. */
  toml: string;
  link: string;
  desktop: string;
  record: string;
  env: Record<string, string>;
  relay(args: string[], env?: Record<string, string>): Out;
  /** What the fake CLIs were asked to do, as command lines; `changes` leaves out the calls that only read. */
  calls(): string[];
  changes(): string[];
  forget(): void;
  /** The fake CLI's own state: the server it has registered, its marketplaces and plugins. */
  state(cli: "claude" | "codex"): Rec;
  setState(cli: "claude" | "codex", state: Rec): void;
  /** Takes a CLI off PATH, as on a machine where it is not installed. */
  without(cli: string): void;
  files(dir: string): string[];
  close(): void;
}

function box(): Box {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-")));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const fake = path.join(tmp, "fake");
  const temp = path.join(tmp, "temp");
  for (const d of [home, bin, fake, temp]) fs.mkdirSync(d, { recursive: true });
  assert.notEqual(home, os.homedir());
  // Relay's Codex home, signed in, as on a machine set up as README says (relay's jobs run Codex with it).
  const codexHome = path.join(home, ".local", "share", "relay-codex-home");
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(codexHome, RELAY_CODEX_HOME_MARKER), "made by relay install\n", { mode: 0o600 });
  fs.writeFileSync(path.join(codexHome, "config.toml"), RELAY_CODEX_CONFIG, { mode: 0o600 });
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}", { mode: 0o600 });
  for (const cli of ["claude", "codex"]) {
    fs.writeFileSync(path.join(bin, cli), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${cli} "$@"\n`, { mode: 0o755 });
  }
  // The desktop app is "not running" unless a test says so.
  // macOS pgrep leaves out its own ancestors unless given -a: an app relay runs inside (its Code tab) is seen only with -a.
  fs.writeFileSync(path.join(bin, "pgrep"), '#!/bin/sh\n[ -n "$FAKE_PGREP_BROKEN" ] && exit 2\n[ -n "$FAKE_DESKTOP_RUNNING" ] && echo 4242 && exit 0\nif [ -n "$FAKE_DESKTOP_ANCESTOR" ]; then for a in "$@"; do [ "$a" = -a ] && echo 4242 && exit 0; done; fi\nexit 1\n', { mode: 0o755 });

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !hostVar(k) && !/^(RELAY_|CODEX_|CLAUDE|FAKE_|XDG_)/.test(k)) env[k] = v;
  Object.assign(env, { HOME: home, CODEX_HOME: path.join(home, ".codex"), PATH: `${bin}:/usr/bin:/bin`, RELAY_TEST_SYSTEM_TOOLS: bin, FAKE_DIR: fake, TMPDIR: temp });
  const log = path.join(fake, "calls.jsonl");
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec).map((c) => `${c.bin} ${c.args.join(" ")}`) : []);
  return {
    tmp, home, bin, env,
    toml: path.join(home, ".codex", "config.toml"),
    link: path.join(home, ".local", "bin", "relay"),
    desktop: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    record: path.join(home, ".config", "relay", "install.json"),
    relay: (args, extra = {}) => {
      const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, cwd: tmp, encoding: "utf8" });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr };
    },
    calls,
    // A Codex app server only reads: doctor's codex launch line asks one for the effective configuration, as a turn does.
    changes: () => calls().filter((c) => !/--version| get | list | status| -p .*--no-session-persistence|^codex app-server /.test(`${c} `)),
    forget: () => fs.rmSync(log, { force: true }),
    state: (cli) => (fs.existsSync(path.join(fake, `${cli}.json`)) ? JSON.parse(fs.readFileSync(path.join(fake, `${cli}.json`), "utf8")) : { server: null, markets: [], plugins: [] }),
    setState: (cli, state) => fs.writeFileSync(path.join(fake, `${cli}.json`), JSON.stringify({ server: null, markets: [], plugins: [], ...state })),
    without: (cli) => fs.rmSync(path.join(bin, cli)),
    files: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []),
    close: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

/** Runs a test body in its own box and always removes it. */
function boxed(name: string, body: (b: Box) => void): void {
  test(name, () => {
    const b = box();
    try {
      if (name.startsWith("doctor:")) writeConfig(path.join(b.home, ".config", "relay", "config.json"), {});
      body(b);
    } finally {
      b.close();
    }
  });
}

boxed("doctor: Daybreak setting, Codex version, cached eligible models, missing CLI and automatic pre-0.163 behavior", (b) => {
  const config = path.join(b.home, ".config", "relay", "config.json");
  write(path.join(b.home, ".local/share/relay-codex-home", "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-eligible", available_access_programs: { cyber: ["standard", "daybreak_blue"] } },
    { slug: "gpt-other", available_access_programs: { cyber: ["standard"] } },
  ] }));
  const unset = b.relay(["doctor"]).stdout;
  assert.match(unset, /codex daybreak\s+targets.codex.daybreak not set: Codex's own configuration decides\n/);
  writeConfig(config, { targets: { codex: { daybreak: false } } });
  assert.match(b.relay(["doctor"]).stdout, /codex daybreak\s+targets.codex.daybreak off; Codex 0\.163\.0; eligible models: gpt-eligible /);
  writeConfig(config, { targets: { codex: { daybreak: true } } });
  assert.match(b.relay(["doctor"]).stdout, /codex daybreak\s+targets.codex.daybreak on; Codex 0\.163\.0; eligible models: gpt-eligible /);
  assert.match(b.relay(["doctor"], { FAKE_CODEX_VERSION: "codex-cli 0.162.1" }).stdout, /codex daybreak\s+.*Codex 0\.162\.1; Daybreak is automatic.*key has no effect/);
  b.without("codex");
  assert.match(b.relay(["doctor"]).stdout, /codex daybreak\s+.*daybreak on; Codex unknown/);
});

boxed("doctor: the never floor is reported per target, enabled or not, for the stage-2 state in force", (b) => {
  const block = (out: string) => out.slice(out.indexOf("never enforced"), out.indexOf("\n", out.indexOf("still screens never hosts and ports")));
  const off = block(b.relay(["doctor"]).stdout);
  assert.match(off, /^never enforced\s+the floor in each agent's sandbox, with stage 2 off \(targets\.codex\.stage2\): its path entries \(never\.paths and the built-ins, keychain files among them\), and keychain IPC \(the security daemons\) separately:\n/);
  assert.match(off, /\n\s+claude, enabled: path entries enforced, whatever stage 2 says; keychain IPC open; no inherited settings, hooks or MCP, managed settings, allow_dangerous writes or unsandboxed-command approvals\n\s+codex, enabled: path entries enforced in every sandboxed turn's profile; keychain IPC closed on network-off turns, open on network-on turns\n\s+copilot \(experimental\), not enabled: not enforced; refused with stage 2 on/);
  assert.match(off, /\n\s+grok \(experimental\), not enabled: not enforced; refused with stage 2 on \(its login route conflicts with the floor\)\n\s+not enforced: .*\n\s+keychain IPC open: .*which the floor denies \(checked each release: qualification item 33 for Codex, release check claude-floor for Claude\)\. What the daemons serve without that file, .* is not covered, nor is a copy of a keychain file kept outside the denied directories\./);
  const on = block(b.relay(["doctor"], { RELAY_EXPERIMENTAL_CODEX_STAGE2: "1" }).stdout);
  assert.match(on, /with stage 2 on .*\n\s+claude, enabled: path entries enforced, whatever stage 2 says; keychain IPC open; .*\n\s+codex, enabled: path entries enforced in every sandboxed turn's profile, and in relay's stage-2 executor; keychain IPC closed\n\s+copilot \(experimental\), not enabled: refused: its login route conflicts with the floor\n\s+gemini, not enabled: path entries enforced, only while stage 2 is on; keychain IPC closed\n/);
  assert.doesNotMatch(on, /not enforced/);
});

boxed("doctor: never Codex says which native shell routes refuse a never port entry", (b) => {
  const config = path.join(b.home, ".config", "relay", "config.json");
  const codexLine = (out: string) => out.split("\n").find((l) => l.startsWith("never Codex")) ?? "";
  assert.equal(codexLine(b.relay(["doctor"]).stdout), "", "the built-in ports alone refuse no route");
  writeConfig(config, { never: { ports: [{ port: 5432, transport: "tcp", destinations: "this-machine" }] } });
  const mine = codexLine(b.relay(["doctor"]).stdout);
  assert.match(mine, /^never Codex\s+user\.port:5432\/tcp\/this-machine: native strict shell network enforces it .*native turns with grant\.local_network, which reach this Mac's addresses, refuse before launch/);
  writeConfig(config, { allow_dangerous: true, never: { ports: [{ port: 5432, transport: "tcp", destinations: "this-machine" }] } });
  assert.match(codexLine(b.relay(["doctor"]).stdout), /grant\.local_network and allow_dangerous write turns, which reach/);
  writeConfig(config, { never: { ports: [{ port: 5432, transport: "tcp", destinations: "any" }] } });
  assert.match(codexLine(b.relay(["doctor"]).stdout), /^never Codex\s+user\.port:5432\/tcp\/any: native shell-network turns refuse before launch/);
});

/** Another relay checkout, as far as install can tell: a package.json that says so, and a bin/relay. */
function otherCheckout(b: Box, name = "old-checkout"): string {
  const root = path.join(b.tmp, name);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "relay", version: "0.0.1" }));
  fs.writeFileSync(path.join(root, "bin", "relay"), "#!/bin/sh\n", { mode: 0o755 });
  return path.join(root, "bin", "relay");
}

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
// Doctor probes versions with the same selected environment as a launch. Disclose only
// the fake CLIs' state directory and version controls, as harness() does for STUB_*.
const writeConfig = (file: string, config: Rec) => write(file, JSON.stringify({
  ...config,
  // These doctor/install fixtures intentionally exercise the fake CLI rather than a pin store.
  targets: { ...config.targets, codex: { pinned: false, ...config.targets?.codex } },
  child_env: { ...config.child_env, pass: [...new Set(["FAKE_DIR", "FAKE_CLAUDE_VERSION", "FAKE_CODEX_VERSION", ...(config.child_env?.pass ?? [])])] },
}));
const read = (file: string) => fs.readFileSync(file, "utf8");
/** A path as a regular expression matches it literally. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Another relay checkout's launcher (a relay package with its own bin/relay), as an earlier install left registered. */
const otherRelay = (b: { tmp: string }, name = "old-checkout") => {
  const root = path.join(b.tmp, name);
  write(path.join(root, "package.json"), JSON.stringify({ name: "relay" }));
  write(path.join(root, "bin", "relay"), "#!/bin/sh\n");
  return path.join(root, "bin", "relay");
};
/** A TOML document as plain data, comparable with deepEqual. */
const toml = (text: string): Rec => JSON.parse(JSON.stringify(parse(text)));
const relayTable = (file: string) => toml(read(file)).mcp_servers?.relay;
const INTENDED = {
  command: LAUNCHER, args: HOST_ARGS.codex, env_vars: ["CODEX_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"], tool_timeout_sec: 11400, startup_timeout_sec: 30, default_tools_approval_mode: "approve",
  tools: { approve: { approval_mode: "prompt" } },
};
const USER_TOML = ['model = "gpt-test"', "", "[mcp_servers.email]", 'command = "email-server"', 'args = ["--stdio"]', "", "[projects.\"/tmp/x\"]", 'trust_level = "trusted"', ""].join("\n");
/** Relay's block as the previous release wrote it: the same launcher, no --host. */
const olderBlock = (launcher = LAUNCHER) => [
  "[mcp_servers.relay]", `command = ${JSON.stringify(launcher)}`, 'args = ["mcp"]', "tool_timeout_sec = 3600", "startup_timeout_sec = 30", 'default_tools_approval_mode = "approve"', "",
  "# Deciding a launched agent's approval request is the one relay call Codex should confirm with you.", "[mcp_servers.relay.tools.approve]", 'approval_mode = "prompt"', "",
].join("\n");

test("README: the Codex registration in docs/install.md matches codexBlock apart from its example launcher path", () => {
  const doc = read(path.join(ROOT, "docs", "install.md"));
  const snippet = doc.match(/```toml\n(\[mcp_servers\.relay\][\s\S]*?)\n```/);
  assert.ok(snippet, "docs/install.md must contain the Codex registration TOML block");
  const documented = toml(snippet[1]);
  assert.equal(documented.mcp_servers.relay.command, "/opt/homebrew/lib/node_modules/@jbkjr/relay/bin/relay");
  documented.mcp_servers.relay.command = LAUNCHER;
  assert.deepEqual(documented, toml(codexBlock()));
});

boxed("install codex: the previous default timeout upgrades even with the current registration shape", (b) => {
  write(b.toml, USER_TOML + codexBlock().replace("tool_timeout_sec = 11400", "tool_timeout_sec = 3600"));
  const upgraded = b.relay(["install", "codex", "--write"]);
  assert.equal(upgraded.status, 0, upgraded.all);
  assert.equal(relayTable(b.toml).tool_timeout_sec, 11400);
});

boxed("install codex: the pre-T3-marker registration upgrades idempotently and both forms uninstall cleanly", (b) => {
  const old = USER_TOML + olderBlock(LAUNCHER).replace('args = ["mcp"]', 'args = ["mcp", "--host", "codex"]');
  write(b.toml, old);
  const upgraded = b.relay(["install", "codex", "--write"]);
  assert.equal(upgraded.status, 0, upgraded.all);
  assert.deepEqual(relayTable(b.toml), INTENDED);
  assert.equal(read(`${b.toml}.bak-relay`), old);
  const installed = read(b.toml);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  assert.equal(read(b.toml), installed);
  assert.equal(b.relay(["uninstall", "codex", "--write"]).status, 0);
  assert.equal(read(b.toml), USER_TOML);
  write(b.toml, old);
  assert.equal(b.relay(["uninstall", "codex", "--write"]).status, 0);
  assert.equal(read(b.toml), USER_TOML);
});

// Before 1.0, builds of relay wrote a Codex proxy role per target of another family,
// agents/relay-<target>.toml beside config.toml. Relay writes none now; install and uninstall take
// out relay's own, as install claude-desktop does with relay's entry under its earlier name.
const rolePath = (b: Box, id = "claude", home = path.dirname(b.toml)) => path.join(home, "agents", `relay-${id}.toml`);
const ROLE_FIELDS: Rec = {
  name: "relay-claude", description: "Hands the task to Claude through relay and returns relay's result.",
  model: "gpt-6-luna", model_reasoning_effort: "low", features: { shell_tool: false, plugins: false },
};
/** A role as those builds wrote it: relay's ownership marker, a hash of each field as written, then the fields. */
function oldRole(fields: Rec = ROLE_FIELDS): string {
  const sorted = (_: string, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))) : v);
  const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v, sorted)).digest("hex");
  const value = (v: unknown): string => (v && typeof v === "object" && !Array.isArray(v) ? `{ ${Object.entries(v).map(([k, x]) => `${k} = ${value(x)}`).join(", ")} }` : JSON.stringify(v));
  return `# Written by relay from ${JSON.stringify(LAUNCHER)}\n# relay role defaults: ${JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, hash(v)])))}\n` +
    Object.entries(fields).map(([k, v]) => `${k} = ${value(v)}`).join("\n") + "\n";
}

boxed("install codex: relay's proxy role from before 1.0 is removed, saved first; a file of that name relay did not write is left alone", (b) => {
  const mine = rolePath(b);
  const theirs = rolePath(b, "copilot");
  write(mine, oldRole());
  write(theirs, 'name = "relay-copilot"\nmodel = "their-model"\n');

  const dry = b.relay(["install", "codex"]);
  assert.equal(dry.status, 0, dry.all);
  assert.ok(dry.stdout.includes(`# remove relay's Codex proxy role ${mine}: relay no longer installs one`), dry.stdout);
  assert.ok(dry.stdout.includes(`# left alone: ${theirs} is not a role relay wrote (no relay ownership marker)`), dry.stdout);
  assert.equal(read(mine), oldRole(), "a dry run removes nothing");

  const r = b.relay(["install", "codex", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.ok(!fs.existsSync(mine));
  assert.equal(read(`${mine}.bak-relay`), oldRole(), "saved before it was removed");
  assert.equal(read(theirs), 'name = "relay-copilot"\nmodel = "their-model"\n');
  const change = JSON.parse(read(b.record)).hosts.codex.resources["role:claude"];
  assert.equal(change.action, "removed");
  assert.equal(change.file, mine);
  assert.equal(change.backup, `${mine}.bak-relay`);
  assert.equal(JSON.parse(read(b.record)).hosts.codex.resources["role:copilot"], undefined);

  // Nothing of relay's is left to remove, and the other file still stays, --force or not.
  const again = b.relay(["install", "codex", "--write", "--force"]);
  assert.equal(again.status, 0, again.all);
  assert.doesNotMatch(again.stdout, /# remove relay's Codex proxy role/);
  assert.equal(read(theirs), 'name = "relay-copilot"\nmodel = "their-model"\n');
  const u = b.relay(["uninstall", "codex", "--write", "--force"]);
  assert.equal(u.status, 0, u.all);
  assert.ok(u.stdout.includes(`# left alone: ${theirs} is not a role relay wrote`), u.stdout);
  assert.equal(read(theirs), 'name = "relay-copilot"\nmodel = "their-model"\n');
});

boxed("install codex: a proxy role someone changed is removed by install only with --force, and by uninstall without it, saved first both times", (b) => {
  const file = rolePath(b);
  const changed = oldRole().replace('model = "gpt-6-luna"', 'model = "my-model"');
  write(file, changed);
  const r = b.relay(["install", "codex", "--write"]);
  assert.notEqual(r.status, 0, r.all);
  assert.ok(r.stderr.includes(`${file} is relay's Codex proxy role from before 1.0, which relay no longer installs, but it has changes relay did not make (model).`), r.stderr);
  assert.match(r.stderr, /Nothing was changed/);
  assert.equal(read(file), changed);
  assert.ok(!fs.existsSync(b.toml), "nothing else was done either");
  assert.deepEqual(b.changes(), []);

  const forced = b.relay(["install", "codex", "--write", "--force"]);
  assert.equal(forced.status, 0, forced.all);
  assert.ok(!fs.existsSync(file));
  assert.equal(read(`${file}.bak-relay`), changed);

  // Uninstall takes out relay's role whatever was changed in it: comments, a field, an added table.
  const edited = `${oldRole().replace("# relay role defaults: ", "# relay role defaults (edited): ")}[shell_environment_policy]\ninherit = "core"\n`;
  write(file, edited);
  const u = b.relay(["uninstall", "codex", "--write"]);
  assert.equal(u.status, 0, u.all);
  assert.ok(!fs.existsSync(file));
  const saved = b.files(path.dirname(file)).filter((f) => f.startsWith("relay-claude.toml.bak-relay"));
  assert.equal(saved.length, 2, "a second backup beside the first, which is never overwritten");
  assert.ok(saved.some((f) => read(path.join(path.dirname(file), f)) === edited));
});

boxed("install codex: a proxy role the installation record lists under an earlier CODEX_HOME is removed there", (b) => {
  const earlier = path.join(b.home, "old-codex-home");
  const file = rolePath(b, "claude", earlier);
  write(file, oldRole());
  const at = new Date().toISOString();
  write(b.record, JSON.stringify({
    version: 1,
    hosts: { codex: { launcher: LAUNCHER, complete: true, at, resources: { "role:claude": { action: "added", at, what: `wrote relay's role ${file}`, file, backup: null, undo: null } } } },
  }));
  const r = b.relay(["install", "codex", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.ok(!fs.existsSync(file));
  assert.equal(read(`${file}.bak-relay`), oldRole());
  assert.ok(!fs.existsSync(rolePath(b)), "and none is written in the current one");
  assert.equal(JSON.parse(read(b.record)).hosts.codex.resources["role:claude"].action, "removed");
});

boxed("install codex: appends relay's block with --host, keeps a backup, and changes nothing without --write", (b) => {
  write(b.toml, USER_TOML);
  const dry = b.relay(["install", "codex"]);
  assert.equal(dry.status, 0, dry.all);
  assert.match(dry.stdout, /Nothing was changed/);
  assert.equal(read(b.toml), USER_TOML, "a dry run writes nothing");
  assert.deepEqual(b.changes(), [], "a dry run only reads");
  assert.deepEqual(b.files(path.dirname(b.toml)), ["config.toml"]);
  assert.ok(!fs.existsSync(b.link) && !fs.existsSync(b.record));

  const r = b.relay(["install", "codex", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(relayTable(b.toml), INTENDED);
  assert.match(read(b.toml), /args = \["mcp", "--host", "codex"\]/);
  assert.ok(read(b.toml).startsWith(USER_TOML), "what was there is untouched and relay's block follows it");
  assert.equal(read(`${b.toml}.bak-relay`), USER_TOML);
  assert.deepEqual(b.changes(), [`codex plugin marketplace add ${ROOT}/adapters/codex`, "codex plugin add relay@relay-local"]);
  assert.equal(fs.readlinkSync(b.link), LAUNCHER);
});

for (const [form, text] of Object.entries({
  "a quoted table name": `[mcp_servers."relay"]\ncommand = ${JSON.stringify(LAUNCHER)}\nargs = ["mcp"]\n`,
  "spaces in the table name": `[mcp_servers . relay]\ncommand = ${JSON.stringify(LAUNCHER)}\nargs = ["mcp"]\n`,
  "an inline table": `mcp_servers = { relay = { command = ${JSON.stringify(LAUNCHER)}, args = ["mcp"] } }\n`,
  "a table inside [mcp_servers]": `[mcp_servers]\nrelay = { command = ${JSON.stringify(LAUNCHER)}, args = ["mcp"] }\n`,
  "dotted keys": `[mcp_servers]\nrelay.command = ${JSON.stringify(LAUNCHER)}\nrelay.args = ["mcp"]\n`,
  "a quoted subtable beside the plain table": `[mcp_servers.relay]\ncommand = ${JSON.stringify(LAUNCHER)}\nargs = ["mcp"]\n\n[mcp_servers."relay".tools.approve]\napproval_mode = "prompt"\n`,
})) {
  boxed(`install codex: an existing relay entry written as ${form} is refused and the file is left byte for byte`, (b) => {
    const before = `model = "x"\n\n${text}\n[other]\nkey = 1\n`;
    assert.ok(toml(before).mcp_servers.relay, "the form is valid TOML that defines mcp_servers.relay");
    for (const flags of [["--write"], ["--write", "--force"], ["--write"]]) {
      write(b.toml, before);
      const r = b.relay(["install", "codex", ...flags]);
      assert.notEqual(r.status, 0, r.all);
      assert.match(r.stderr, /in a form relay does not edit/);
      assert.match(r.stderr, /Remove that definition by hand/);
      assert.match(r.stderr, /Look at:\n\s+line \d+: .*relay/, "it says where to look");
      assert.match(r.stderr, /Nothing was changed/);
      assert.equal(read(b.toml), before);
    }
    assert.deepEqual(b.files(path.dirname(b.toml)), ["config.toml"], "no backup, no temp file");
    assert.deepEqual(b.changes(), []);
    assert.ok(!fs.existsSync(b.link), "the link is not made either");
    // Uninstall cannot take it out line by line either, and says so.
    const u = b.relay(["uninstall", "codex", "--write"]);
    assert.notEqual(u.status, 0, u.all);
    assert.match(u.stderr, /in a form relay does not edit/);
    assert.equal(read(b.toml), before);
  });
}

boxed("install codex: a config that does not parse is refused, with --force too", (b) => {
  for (const before of ['model = "x"\n[broken\nkey = 1\n', "[a]\nx = 1\n[a]\ny = 2\n", `${olderBlock()}\n[mcp_servers.relay]\ncommand = "twice"\n`]) {
    for (const flags of [["--write"], ["--write", "--force"]]) {
      write(b.toml, before);
      const r = b.relay(["install", "codex", ...flags]);
      assert.notEqual(r.status, 0, r.all);
      assert.match(r.stderr, /does not parse as TOML \(line \d+, column \d+/);
      assert.match(r.stderr, /Nothing was changed/);
      assert.equal(read(b.toml), before);
    }
    const u = b.relay(["uninstall", "codex", "--write"]);
    assert.notEqual(u.status, 0);
    assert.equal(read(b.toml), before);
  }
  assert.deepEqual(b.files(path.dirname(b.toml)), ["config.toml"]);
  assert.deepEqual(b.changes(), []);
});

boxed("install codex: a file that is not UTF-8 is refused untouched", (b) => {
  const bytes = Buffer.concat([Buffer.from('model = "caf'), Buffer.from([0xe9]), Buffer.from('"\n')]);
  fs.mkdirSync(path.dirname(b.toml), { recursive: true });
  fs.writeFileSync(b.toml, bytes);
  const r = b.relay(["install", "codex", "--write"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not valid UTF-8/);
  assert.ok(fs.readFileSync(b.toml).equals(bytes));
});

boxed("install codex: reinstalling is a no-op, and the first backup is never overwritten", (b) => {
  write(b.toml, USER_TOML);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  const installed = read(b.toml);
  const record = read(b.record);
  b.forget();

  const again = b.relay(["install", "codex", "--write"]);
  assert.equal(again.status, 0, again.all);
  assert.match(again.stdout, /Nothing to do: relay is already installed/);
  assert.equal(read(b.toml), installed);
  assert.equal(read(b.record), record, "the record is not rewritten either");
  assert.deepEqual(b.changes(), [], "no command that changes anything is run");
  // plugins/ is Codex's own: where it keeps its copy of the plugin.
  assert.deepEqual(b.files(path.dirname(b.toml)).filter((f) => f !== "plugins"), ["config.toml", "config.toml.bak-relay"], "no second backup for a run that changed nothing");

  // Something changes (the earlier form of relay's block), so the next install edits the file again.
  const older = installed.replace('args = ["mcp", "--host", "codex"]', 'args = ["mcp"]');
  write(b.toml, older);
  const third = b.relay(["install", "codex", "--write"]);
  assert.equal(third.status, 0, third.all);
  assert.deepEqual(toml(read(b.toml)), toml(installed), "the earlier form is replaced by the current one");
  assert.equal((read(b.toml).match(/\[mcp_servers\.relay\]/g) ?? []).length, 1);
  const backups = b.files(path.dirname(b.toml)).filter((f) => f.startsWith("config.toml.bak-relay"));
  assert.equal(backups.length, 2);
  assert.match(backups[1], /^config\.toml\.bak-relay-\d{8}T\d{6}Z$/);
  assert.match(third.stdout, new RegExp(`the file as it was is at .*${backups[1]}`), "the new backup's path is printed");
  assert.equal(read(`${b.toml}.bak-relay`), USER_TOML, "the first backup still holds the original");
  assert.equal(read(path.join(path.dirname(b.toml), backups[1])), older);

  // And a third backup made within the same second gets a name of its own.
  write(b.toml, older);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  write(b.toml, older);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  assert.equal(new Set(b.files(path.dirname(b.toml)).filter((f) => f !== "plugins")).size, 5, "config.toml and four distinct backups");
  assert.equal(read(`${b.toml}.bak-relay`), USER_TOML);
});

boxed("install codex: CRLF line endings are kept, in what was there and in what relay adds", (b) => {
  const crlf = USER_TOML.replace(/\n/g, "\r\n");
  write(b.toml, crlf);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  const after = read(b.toml);
  assert.ok(after.startsWith(crlf));
  assert.doesNotMatch(after, /(^|[^\r])\n/, "no bare LF anywhere");
  assert.deepEqual(relayTable(b.toml), INTENDED);

  // Replacing the earlier form keeps them too, and so does taking relay out again.
  write(b.toml, after.replace('args = ["mcp", "--host", "codex"]', 'args = ["mcp"]'));
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  assert.deepEqual(toml(read(b.toml)), toml(after));
  assert.doesNotMatch(read(b.toml), /(^|[^\r])\n/);
  assert.equal(b.relay(["uninstall", "codex", "--write"]).status, 0);
  assert.equal(read(b.toml), crlf, "uninstall gives back the original bytes");
});

boxed("install codex: an entry of relay's shape (…/bin/relay mcp) that relay cannot confirm is its own is replaced or removed only with --force", (b) => {
  // No relay package behind it (a deleted checkout, or another program's bin/relay).
  const stranger = path.join(b.tmp, "elsewhere", "bin", "relay");
  const other = path.join(b.tmp, "other-tool");
  write(path.join(other, "package.json"), JSON.stringify({ name: "relay-chat" }));
  for (const command of [stranger, path.join(other, "bin", "relay")]) {
    const text = `${USER_TOML}\n[mcp_servers.relay]\ncommand = ${JSON.stringify(command)}\nargs = ["mcp"]\n`;
    write(b.toml, text);
    const r = b.relay(["install", "codex", "--write"]);
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.all, new RegExp(`it runs ${esc(command)} mcp, which has the shape of relay's entry, but relay cannot confirm it is relay's.*--force`));
    assert.equal(read(b.toml), text, "left as it was");
    assert.match(b.relay(["doctor"]).stdout, new RegExp(`codex mcp\\s+WARNING: a server named relay is registered, but it runs ${esc(command)} mcp.*install codex --write --force`));
    const u = b.relay(["uninstall", "codex", "--write"]);
    assert.equal(u.status, 0, u.all);
    assert.equal(relayTable(b.toml).command, command, "uninstall leaves it too");
  }
  // Named by relay's installation record: relay's, replaced without --force.
  write(b.record, JSON.stringify({ version: 1, hosts: { claude: { launcher: stranger, complete: true, at: new Date().toISOString(), resources: {} } } }));
  write(b.toml, `${USER_TOML}\n[mcp_servers.relay]\ncommand = ${JSON.stringify(stranger)}\nargs = ["mcp"]\n`);
  const recorded = b.relay(["install", "codex", "--write"]);
  assert.equal(recorded.status, 0, recorded.all);
  assert.deepEqual(relayTable(b.toml), INTENDED);
  // And with --force, an unconfirmed one is replaced, saved first.
  fs.rmSync(b.record);
  write(b.toml, `${USER_TOML}\n[mcp_servers.relay]\ncommand = ${JSON.stringify(stranger)}\nargs = ["mcp"]\n`);
  const forced = b.relay(["install", "codex", "--write", "--force"]);
  assert.equal(forced.status, 0, forced.all);
  assert.deepEqual(relayTable(b.toml), INTENDED);
});

boxed("install codex: the earlier form is replaced where it stands, and comments around it survive", (b) => {
  const before = ["# my settings", 'model = "x"', "", olderBlock(otherRelay(b, "somewhere/else/relay")), "# a note about the next table", "[mcp_servers.github]", 'url = "u"', "", "# the last word", ""].join("\n");
  write(b.toml, before);
  const r = b.relay(["install", "codex", "--write"]);
  assert.equal(r.status, 0, r.all);
  const after = read(b.toml);
  assert.deepEqual(relayTable(b.toml), INTENDED);
  assert.doesNotMatch(after, /somewhere\/else/);
  assert.match(after, /# a note about the next table\n\[mcp_servers\.github\]\nurl = "u"\n\n# the last word\n/);
  assert.equal((after.match(/\[mcp_servers\.relay\]/g) ?? []).length, 1);
  assert.equal((after.match(/Deciding a launched agent/g) ?? []).length, 1, "relay's own comment is not duplicated");
  const rest = (text: string) => {
    const data = toml(text);
    delete data.mcp_servers.relay;
    // What the fake Codex wrote for its own marketplace and plugin.
    delete data.marketplaces;
    delete data.plugins;
    return data;
  };
  assert.deepEqual(rest(after), rest(before), "nothing but mcp_servers.relay changed");

  // A comment after relay's last key at the end of the file is the user's and stays.
  const tail = `model = "x"\n\n${olderBlock()}\n# written after relay's block\n`;
  write(b.toml, tail);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  assert.match(read(b.toml), /^model = "x"\n\n# written after relay's block\n\n\[mcp_servers\.relay\]\n/);
});

boxed("install codex: a relay entry carrying the user's own settings is not replaced without --force", (b) => {
  const before = `${USER_TOML}\n${olderBlock()}\n[mcp_servers.relay.env]\nRELAY_NODE = "/opt/node/bin/node"\n`;
  write(b.toml, before);
  const r = b.relay(["install", "codex", "--write"]);
  assert.notEqual(r.status, 0, r.all);
  assert.match(r.stderr, /carries settings relay did not write \(env\.RELAY_NODE\)/);
  assert.equal(read(b.toml), before);
  assert.deepEqual(b.changes(), []);

  const forced = b.relay(["install", "codex", "--write", "--force"]);
  assert.equal(forced.status, 0, forced.all);
  assert.deepEqual(relayTable(b.toml), INTENDED);
  assert.equal(read(`${b.toml}.bak-relay`), before, "what was there is saved first");

  // A setting relay writes, given another value by the user, is the user's as well.
  const stricter = `${USER_TOML}\n${olderBlock().replace('default_tools_approval_mode = "approve"', 'default_tools_approval_mode = "prompt"').replace("tool_timeout_sec = 3600", "tool_timeout_sec = 7200")}`;
  write(b.toml, stricter);
  const kept2 = b.relay(["install", "codex", "--write"]);
  assert.notEqual(kept2.status, 0, kept2.all);
  assert.match(kept2.stderr, /carries settings relay did not write \(tool_timeout_sec changed, default_tools_approval_mode changed\)/);
  assert.equal(read(b.toml), stricter, "the user's approval mode is not quietly put back to relay's");
  assert.equal(b.relay(["install", "codex", "--write", "--force"]).status, 0);
  assert.deepEqual(relayTable(b.toml), INTENDED);

  // Settings added beside an entry that is already current are simply left alone.
  const current = `${read(b.toml)}\n[mcp_servers.relay.env]\nRELAY_NODE = "/opt/node/bin/node"\n`;
  write(b.toml, current);
  const kept = b.relay(["install", "codex", "--write"]);
  assert.equal(kept.status, 0, kept.all);
  assert.equal(read(b.toml), current);
});

boxed("install codex: something else called relay is refused without --force, and saved before --force replaces it", (b) => {
  const before = `${USER_TOML}\n[mcp_servers.relay]\ncommand = "/usr/local/bin/other-relay"\nargs = ["serve"]\n`;
  write(b.toml, before);
  for (const args of [["install", "codex", "--write"], ["install", "codex"]]) {
    const r = b.relay(args);
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.stderr, /is not relay's \(its command is \/usr\/local\/bin\/other-relay\)/);
    assert.match(r.stderr, /--force/);
    assert.equal(read(b.toml), before);
  }
  assert.deepEqual(b.changes(), []);
  assert.deepEqual(b.files(path.dirname(b.toml)), ["config.toml"]);

  // Uninstall leaves it where it is: it is not relay's to remove.
  const u = b.relay(["uninstall", "codex", "--write"]);
  assert.equal(u.status, 0, u.all);
  assert.match(u.stdout, /left alone: \[mcp_servers\.relay\].* is not relay's/);
  assert.equal(read(b.toml), before);

  const forced = b.relay(["install", "codex", "--write", "--force"]);
  assert.equal(forced.status, 0, forced.all);
  assert.deepEqual(relayTable(b.toml), INTENDED);
  assert.equal(read(`${b.toml}.bak-relay`), before);
});

boxed("install codex: with Codex absent nothing is created and the exit code says so", (b) => {
  b.without("codex");
  for (const args of [["install", "codex", "--write"], ["install", "codex"], ["uninstall", "codex", "--write"]]) {
    const r = b.relay(args);
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.stderr, /needs the codex CLI, and `codex` was not found/);
    assert.match(r.stderr, /Nothing was changed/);
  }
  assert.ok(!fs.existsSync(b.toml), "config.toml is not created");
  assert.ok(!fs.existsSync(path.dirname(b.toml)), "nor is Codex's directory");
  assert.ok(!fs.existsSync(b.link) && !fs.existsSync(b.record));
  assert.deepEqual(b.files(b.home), [".local"], "the home directory is as it was (relay's Codex home, which the box makes)");

  // A CLI that is there but does not run counts the same.
  fs.writeFileSync(path.join(b.bin, "codex"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  const broken = b.relay(["install", "codex", "--write"]);
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /`codex --version` failed \(exit 3\)/);
  assert.deepEqual(b.files(b.home), [".local"]);
});

boxed("install codex: with no config.toml yet the file is created with relay's block only", (b) => {
  const r = b.relay(["install", "codex", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(relayTable(b.toml), INTENDED);
  assert.ok(!fs.existsSync(`${b.toml}.bak-relay`), "there was nothing to back up");
  assert.equal(b.relay(["uninstall", "codex", "--write"]).status, 0);
  assert.deepEqual(toml(read(b.toml)), {});
});

boxed("install: a registry left by an earlier relay is backed up and then migrated with --write, and only reported without it", (b) => {
  const state = path.join(b.home, ".local", "state", "relay");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const file = path.join(state, "relay.db");
  const old = new DatabaseSync(file);
  old.exec(read(path.join(ROOT, "test", "fixtures", "relay-0.2.0.sql")));
  old.close();
  const version = () => {
    const d = new DatabaseSync(file, { readOnly: true });
    try {
      return (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    } finally {
      d.close();
    }
  };
  const backups = () => b.files(state).filter((f) => f.startsWith("relay.db.backup-"));

  // doctor does not open the registry, so it neither backs up nor migrates it.
  b.relay(["doctor"]);
  assert.deepEqual(backups(), [], "doctor backs nothing up");
  assert.equal(version(), 0, "doctor migrates nothing");

  const dry = b.relay(["install", "codex"]);
  assert.equal(dry.status, 0, dry.all);
  assert.match(dry.stdout, /registry .*earlier relay.*backed up/i);
  assert.deepEqual(backups(), [], "a dry run backs nothing up");
  assert.equal(version(), 0, "and migrates nothing");

  const r = b.relay(["install", "codex", "--write"]);
  assert.equal(r.status, 0, r.all);
  const made = backups();
  assert.equal(made.length, 1, made.join(", "));
  assert.match(made[0], /^relay\.db\.backup-v0-/);
  assert.ok(r.stdout.includes(path.join(state, made[0])), `install says where the backup is:\n${r.stdout}`);
  assert.ok(version() >= 1, "the registry is migrated");

  // Run again: the registry is current, nothing more is backed up.
  const again = b.relay(["install", "codex", "--write"]);
  assert.equal(again.status, 0, again.all);
  assert.equal(backups().length, 1);
});

boxed("install: a migration followed by the first host step failing reports and records the registry recovery", (b) => {
  const state = path.join(b.home, ".local", "state", "relay");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const file = path.join(state, "relay.db");
  const old = new DatabaseSync(file);
  old.exec(read(path.join(ROOT, "test", "fixtures", "relay-0.9.1.sql")));
  old.close();

  const r = b.relay(["install", "claude", "--write"], { FAKE_FAIL: "mcp add" });
  assert.equal(r.status, 1, r.all);
  assert.doesNotMatch(r.stderr, /Nothing was changed/);
  assert.match(r.stderr, new RegExp(`migrated the registry .* from schema 1 to ${SCHEMA_VERSION}`));
  const backup = path.join(state, b.files(state).find((name) => name.startsWith("relay.db.backup-v1-"))!);
  assert.ok(fs.existsSync(backup));
  assert.ok(r.stderr.includes(backup), r.stderr);
  assert.match(r.stderr, /to undo: stop every relay process.*docs\/UPGRADING\.md.*WAL\/SHM.*verify PRAGMA user_version is 1/);
  assert.match(r.stderr, /uninstall does not restore the registry/);
  const migration = JSON.parse(read(b.record)).hosts.claude.resources.registry;
  assert.equal(migration.backup, backup);
  assert.equal(migration.file, file);
  assert.ok(r.stderr.includes(migration.undo));
  assert.equal(b.state("claude").server, null, "the first host mutation failed");
  for (const [dbFile, expected] of [[file, SCHEMA_VERSION], [backup, 1]] as const) {
    const d = new DatabaseSync(dbFile, { readOnly: true });
    try { assert.equal(d.prepare("PRAGMA user_version").get()!.user_version, expected); }
    finally { d.close(); }
  }
});

boxed("doctor: unknown private temp directories are reported without creating or migrating the registry", (b) => {
  const dir = path.join(b.env.TMPDIR, "relay-tmp-unknown");
  fs.mkdirSync(dir);
  const state = path.join(b.home, ".local", "state", "relay");
  const file = path.join(state, "relay.db");
  assert.match(b.relay(["doctor"]).stdout, /relay-tmp-unknown.*cannot be matched to a turn/);
  assert.equal(fs.existsSync(state), false, "doctor did not create a control directory or registry");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const legacy = new DatabaseSync(file);
  legacy.exec(read(path.join(ROOT, "test", "fixtures", "relay-0.2.0.sql")));
  legacy.close();
  const before = fs.readFileSync(file);
  assert.match(b.relay(["doctor"]).stdout, /relay-tmp-unknown.*cannot be matched to a turn/);
  assert.deepEqual(fs.readFileSync(file), before, "the legacy registry was left byte-for-byte unchanged");
  assert.deepEqual(b.files(state), ["relay.db"], "no migration backup or journal files");
  assert.ok(fs.existsSync(dir), "the unmatched directory was left alone");
});

boxed("doctor: unmatched temp directories make one counted warning, however many there are, naming a few", (b) => {
  const temp = b.env.TMPDIR;
  const doctor = () => {
    const out = b.relay(["doctor"]).stdout;
    return { out, lines: out.split("\n").filter((l) => /^temp dirs\s/.test(l)), warnings: Number(/, (\d+) warnings?\s*$/.exec(out)?.[1] ?? 0) };
  };
  const none = doctor();
  assert.deepEqual(none.lines, [], "no temp dirs line without any");

  fs.mkdirSync(path.join(temp, "relay-tmp-only01"));
  const one = doctor();
  assert.equal(one.warnings, none.warnings + 1, one.out);
  assert.deepEqual(one.lines.length, 1, one.out);
  // One reads as it always did: its full path, then what relay does with it.
  assert.ok(one.lines[0].startsWith(`temp dirs      WARNING: ${path.join(temp, "relay-tmp-only01")} cannot be matched to a turn in the registry; left alone. `), one.lines[0]);
  assert.match(one.lines[0], /Relay builds before 1\.0 made turns' directories here .* cannot tell what made it or whether anything still uses it; 1\.0 makes and uses none here\.$/);
  assert.doesNotMatch(one.lines[0], /directories in|more\)/);

  for (let i = 0; i < 332; i++) fs.mkdirSync(path.join(temp, `relay-tmp-x${String(i).padStart(5, "0")}`));
  const many = doctor();
  assert.equal(many.warnings, none.warnings + 1, "333 of them are one warning in the summary");
  assert.equal(many.lines.length, 1, many.out);
  assert.equal(many.lines[0], `temp dirs      WARNING: 333 directories in ${temp} (relay-tmp-only01, relay-tmp-x00000, relay-tmp-x00001, and 330 more) cannot be matched to a turn in the registry; left alone. Relay builds before 1.0 made turns' directories here without recording which turn made which, so relay cannot tell what made them or whether anything still uses them; 1.0 makes and uses none here.`);
  assert.equal(many.out.match(/relay-tmp-/g)?.length, 3, "only the few named appear anywhere in doctor's output");
  assert.equal(fs.readdirSync(temp).filter((n) => n.startsWith("relay-tmp-")).length, 333, "all left alone");

  // A registry doctor cannot open leaves every one of them unchecked, not just the first, and still makes one line.
  fs.mkdirSync(path.join(b.home, ".local", "state", "relay", "relay.db"), { recursive: true });
  const unreadable = doctor();
  assert.equal(unreadable.lines.length, 1, unreadable.out);
  assert.match(unreadable.lines[0], /^temp dirs +WARNING: 333 directories in \S+ \(relay-tmp-only01, relay-tmp-x00000, relay-tmp-x00001, and 330 more\) could not be checked against the registry \(.+\); left alone$/);
});

test("doctor: the line about unmatched temp directories says where they are, and on macOS what was seen of the shared temp directory at a restart", () => {
  const T = "/private/var/folders/ab/cdef/T";
  const names = ["relay-tmp-c", "relay-tmp-a", "relay-tmp-d", "relay-tmp-b"];
  const shared = leftTempsLine({ root: T, shared: true, reason: null }, names, "darwin");
  assert.match(shared, /^4 directories in \/private\/var\/folders\/ab\/cdef\/T \(relay-tmp-a, relay-tmp-b, relay-tmp-c, and 1 more\) cannot be matched to a turn in the registry; left alone\. /);
  // Said as what was seen, not promised.
  assert.match(shared, /; 1\.0 makes and uses none here\. On macOS 27 this directory has been seen emptied when the Mac restarts \(2026-10-21\)\.$/);
  assert.doesNotMatch(shared, /nothing needs doing|macOS empties/);
  assert.match(leftTempsLine({ root: T, shared: true, reason: null }, ["relay-tmp-a"], "darwin"), /^\/private\/var\/folders\/ab\/cdef\/T\/relay-tmp-a cannot be matched .* still uses it; .* seen emptied when the Mac restarts \(2026-10-21\)\.$/);
  // Three are all named; a TMPDIR of the person's own, or another platform, is not said to be emptied.
  assert.match(leftTempsLine({ root: T, shared: true, reason: null }, names.slice(0, 3), "darwin"), /\(relay-tmp-a, relay-tmp-c, relay-tmp-d\) cannot be matched/);
  assert.doesNotMatch(leftTempsLine({ root: "/Users/me/tmp", shared: true, reason: null }, names, "darwin"), /macOS/);
  assert.doesNotMatch(leftTempsLine({ root: T, shared: true, reason: null }, names, "linux"), /macOS/);
  // In relay's own directories they are not called leftovers of earlier builds, nor said to go away by themselves.
  const own = leftTempsLine({ root: "/Users/me/.relay-t", shared: false, reason: null }, names, "darwin");
  assert.match(own, /^4 directories in \/Users\/me\/\.relay-t \(relay-tmp-a, relay-tmp-b, relay-tmp-c, and 1 more\) cannot be matched .*; left alone\. Relay removes a turn's directory here only once it matches a settled turn in this registry and nothing still uses it; .*another control directory \(RELAY_HOME\)/);
  assert.doesNotMatch(own, /before 1\.0|macOS/);
  // Those that could not be checked are summed up the same way, with the reason.
  assert.equal(leftTempsLine({ root: "/Users/me/.rn", shared: false, reason: "database is locked" }, ["Ab12Cd", "Ef34Gh"], "darwin"),
    "2 directories in /Users/me/.rn (Ab12Cd, Ef34Gh) could not be checked against the registry (database is locked); left alone");
});

boxed("install: with no registry yet, none is made", (b) => {
  const r = b.relay(["install", "codex", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.ok(!fs.existsSync(path.join(b.home, ".local", "state", "relay", "relay.db")));
});

boxed("install codex: a symlinked config.toml is written through, not replaced", (b) => {
  const real = path.join(b.tmp, "dotfiles", "codex-config.toml");
  write(real, USER_TOML);
  fs.chmodSync(real, 0o640);
  fs.mkdirSync(path.dirname(b.toml), { recursive: true });
  fs.symlinkSync(real, b.toml);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  assert.ok(fs.lstatSync(b.toml).isSymbolicLink(), "still a link");
  assert.deepEqual(relayTable(real), INTENDED);
  assert.equal(fs.statSync(real).mode & 0o777, 0o640, "the file keeps its mode");
  assert.deepEqual(b.files(path.dirname(real)), ["codex-config.toml"], "no temp file left beside it");
  assert.equal(read(`${b.toml}.bak-relay`), USER_TOML);
});

boxed("install codex: a config that changes while relay is working is left as the other writer made it", (b) => {
  write(b.toml, USER_TOML);
  const r = b.relay(["install", "codex", "--write"], { FAKE_TOUCH: b.toml });
  assert.notEqual(r.status, 0, r.all);
  assert.match(r.stderr, /config\.toml changed while relay was working on it, so it was left as it is/);
  assert.match(r.stderr, /Nothing was changed/);
  assert.equal(read(b.toml), `${USER_TOML}# edited meanwhile\n`, "the other writer's edit is not lost and relay's is not made");
  assert.deepEqual(b.files(path.dirname(b.toml)), ["config.toml"], "no temp file, and no backup of an edit that did not happen");
  assert.deepEqual(b.changes(), []);
  // The same holds for uninstall.
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  const installed = read(b.toml);
  const u = b.relay(["uninstall", "codex", "--write"], { FAKE_TOUCH: b.toml });
  assert.notEqual(u.status, 0, u.all);
  assert.equal(read(b.toml), `${installed}# edited meanwhile\n`);
  assert.deepEqual(relayTable(b.toml), INTENDED);
});

boxed("install then uninstall codex: the config parses to what it was, and later additions survive", (b) => {
  write(b.toml, USER_TOML);
  const original = toml(USER_TOML);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  // The fake Codex, like the real one, has written its marketplace and plugin into the same file.
  assert.match(read(b.toml), /\[marketplaces\.relay-local\]/);
  assert.match(read(b.toml), /\[plugins\."relay@relay-local"\]/);
  b.forget();

  const dry = b.relay(["uninstall", "codex"]);
  assert.equal(dry.status, 0, dry.all);
  assert.deepEqual(b.changes(), []);
  assert.ok(relayTable(b.toml), "a dry run removes nothing");

  const u = b.relay(["uninstall", "codex", "--write"]);
  assert.equal(u.status, 0, u.all);
  assert.deepEqual(toml(read(b.toml)), original);
  assert.equal(read(b.toml), USER_TOML, "here even the bytes are the original's");
  assert.deepEqual(b.changes(), ["codex plugin remove relay@relay-local", "codex plugin marketplace remove relay-local"]);
  assert.ok(!fs.existsSync(b.link), "no host is left, so the link goes too");
  assert.ok(!fs.existsSync(b.record), "and the record of the installation");
  assert.equal(read(`${b.toml}.bak-relay`), USER_TOML, "backups stay for the user to consult");

  // Uninstall is surgical: what the user added after installing stays, wherever it was added.
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  const added = `${read(b.toml)}\n# added later\n[mcp_servers.later]\ncommand = "later"\n\n[profiles.mine]\nmodel = "y"\n`.replace("[mcp_servers.email]", '[mcp_servers.early]\ncommand = "early"\n\n[mcp_servers.email]');
  write(b.toml, added);
  const again = b.relay(["uninstall", "codex", "--write"]);
  assert.equal(again.status, 0, again.all);
  const left = toml(read(b.toml));
  assert.equal(left.mcp_servers.relay, undefined, "relay's tables are gone");
  assert.doesNotMatch(read(b.toml), /relay|approval_mode/);
  assert.deepEqual(left.mcp_servers.later, { command: "later" });
  assert.deepEqual(left.mcp_servers.early, { command: "early" });
  assert.deepEqual(left.profiles, { mine: { model: "y" } });
  assert.match(read(b.toml), /# added later\n\[mcp_servers\.later\]/);
  assert.deepEqual({ ...left, mcp_servers: { email: left.mcp_servers.email }, profiles: undefined }, { ...original, profiles: undefined }, "and everything from before is as it was");
});

boxed("uninstall: says what it leaves behind and how to remove it", (b) => {
  write(b.toml, USER_TOML);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  const u = b.relay(["uninstall", "codex", "--write"]);
  assert.equal(u.status, 0, u.all);
  for (const p of [".local/state/relay", ".local/share/relay/worktrees", ".config/relay"]) assert.ok(u.stdout.includes(path.join(b.home, p)), p);
  assert.match(u.stdout, /`\.relay\/` in \.git\/info\/exclude/);
  assert.match(u.stdout, /relay\/\* branches/);
  assert.ok(u.stdout.indexOf(`${LAUNCHER} clean`) < u.stdout.indexOf("rm -rf"), "relay clean comes before anything is deleted");
  assert.match(u.stdout, /no work is lost/);
  // Everything relay keeps, with the ones holding credentials marked, and nothing deleted.
  const codexHome = path.join(b.home, ".local/share/relay-codex-home");
  for (const p of [".local/share/relay/consult", ".local/share/relay/harness", ".local/share/relay-codex-pins", ".config/relay-keys", ".relay-t", ".rn", ".rsm/q"]) assert.ok(u.stdout.includes(path.join(b.home, p)), p);
  assert.match(u.stdout, new RegExp(`${esc(codexHome)} \\[holds a login \\(auth\\.json\\)\\]\\n\\s+relay's Codex home`));
  assert.match(u.stdout, new RegExp(`${esc(path.join(b.home, ".config/relay-keys"))}(?: \\(not present\\))? \\[holds API keys\\]`));
  // The short link in /Users/Shared is named by user id: listed only when it is there and this home's,
  // never the real home's (which a scratch home's never is).
  assert.ok(!u.stdout.includes(`/Users/Shared/.rn-${process.getuid!()}`), "another home's link is not suggested for removal");
  assert.ok(u.stdout.includes(`chmod -R u+w ${path.join(b.home, ".local/share/relay-codex-pins")} && rm -rf ${path.join(b.home, ".local/share/relay-codex-pins")}`), "sealed pin trees are made writable first");
  assert.match(u.stdout, /3\. Stop the Codex qualifier's LaunchAgent, if you installed it:\n\s+# none found in ~\/Library\/LaunchAgents/);
  assert.ok(fs.existsSync(path.join(codexHome, "auth.json")), "uninstall deletes nothing of relay's state");
  // A qualifier LaunchAgent that is there: named, with the commands that stop and remove it.
  const plist = path.join(b.home, "Library/LaunchAgents/local.t.relay-codex-qualifier.plist");
  write(plist, `<plist><dict><key>ProgramArguments</key><array><string>/node</string><string>/r/scripts/codex-qualify/codex-qualifier.mjs</string><string>/c.json</string><string>--run</string></array></dict></plist>\n`);
  write(path.join(b.home, "Library/LaunchAgents/other.plist"), "<plist/>\n");
  const withAgent = b.relay(["uninstall", "codex"]).stdout;
  assert.ok(withAgent.includes("launchctl bootout gui/$(id -u)/local.t.relay-codex-qualifier"), withAgent);
  assert.ok(withAgent.includes(`rm -f ${plist}`));
  assert.doesNotMatch(withAgent, /other\.plist/);
  assert.ok(fs.existsSync(plist), "nor the LaunchAgent");
});

boxed("uninstall: never suggests deleting a directory you named, such as your home, whole; names relay's files there instead", (b) => {
  write(b.toml, USER_TOML);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  // The config file in the home directory, the state in it too.
  const config = path.join(b.home, "relay.json");
  write(config, "{}\n");
  const u = b.relay(["uninstall", "codex"], { RELAY_CONFIG: config, RELAY_HOME: b.home });
  assert.equal(u.status, 0, u.all);
  const removals = u.stdout.slice(u.stdout.indexOf("To remove them by hand"));
  for (const bad of [b.home, fs.realpathSync(b.home)]) assert.ok(!removals.includes(`rm -rf '${bad}'\n`) && !removals.includes(`rm -rf ${bad}\n`), `no rm -rf of the home:\n${removals}`);
  assert.ok(removals.includes(`rm -f ${config} ${path.join(b.home, "install.json")} ${path.join(b.home, "mcp.json")}`), removals);
  assert.ok(removals.includes(`rm -rf ${path.join(b.home, "install-backups")}`), removals);
  assert.match(removals, new RegExp(`# ${esc(b.home)} is a directory you named \\(RELAY_HOME\\): relay does not suggest deleting it whole`));
  // Directories relay derives from RELAY_HOME are relay's own.
  assert.ok(removals.includes(`rm -rf ${b.home}-worktrees`));
  assert.ok(removals.includes(`rm -rf ${b.home}-consult`));
  // A Codex home you named that is not relay's (A1): not suggested either.
  const mine = path.join(b.tmp, "mine");
  write(path.join(mine, "config.toml"), 'model = "mine"\n');
  writeConfig(path.join(b.home, ".config", "relay", "config.json"), { targets: { codex: { home: mine, pin_store: path.join(b.tmp, "pins") } } });
  const named = b.relay(["uninstall", "codex"]).stdout;
  assert.ok(!named.includes(`rm -rf ${mine}`), named);
  assert.match(named, new RegExp(`# ${esc(mine)} is a directory you named \\(targets\\.codex\\.home\\)`));
  assert.match(named, new RegExp(`# ${esc(path.join(b.tmp, "pins"))} is a directory you named \\(targets\\.codex\\.pin_store\\)`));
});

boxed("uninstall codex: goes by the installation record where there is one, and by what the entry is where there is not", (b) => {
  write(b.toml, USER_TOML);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  const rec = JSON.parse(read(b.record));
  assert.equal(rec.hosts.codex.launcher, LAUNCHER);
  assert.equal(rec.hosts.codex.resources.config.action, "added");
  assert.equal(rec.hosts.codex.resources.config.file, b.toml);
  assert.equal(rec.hosts.codex.resources.config.backup, `${b.toml}.bak-relay`);
  assert.match(rec.hosts.codex.resources.config.undo, new RegExp(`^${LAUNCHER} uninstall codex --write`));
  assert.equal(rec.hosts.codex.resources.marketplace.undo, "codex plugin marketplace remove relay-local");
  assert.equal(rec.hosts.codex.resources.plugin.undo, "codex plugin remove relay@relay-local");

  // The user changes how the entry is started. Judged by its command line alone it is no longer relay's,
  // so without the record it is left alone.
  write(b.toml, read(b.toml).replace('args = ["mcp", "--host", "codex"]', 'args = ["--trace", "mcp"]'));
  const record = read(b.record);
  fs.rmSync(b.record);
  const blind = b.relay(["uninstall", "codex"]);
  assert.equal(blind.status, 0, blind.all);
  assert.match(blind.stdout, /no installation record for Codex/);
  assert.match(blind.stdout, /left alone: \[mcp_servers\.relay\]/);
  // The record says relay registered this launcher here, so it is the entry relay put there.
  write(b.record, record);
  const u = b.relay(["uninstall", "codex", "--write"]);
  assert.equal(u.status, 0, u.all);
  assert.match(u.stdout, new RegExp(`installed \\d{4}-\\d\\d-\\d\\d from ${LAUNCHER}, according to ${b.record}`));
  assert.match(u.stdout, new RegExp(`saved at install, for you to consult: ${b.toml}.bak-relay`));
  assert.equal(read(b.toml), USER_TOML);

  // Installed into one CODEX_HOME, asked to uninstall from another: refused, with the way to do it properly.
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  const installed = read(b.toml);
  const moved = b.relay(["uninstall", "codex", "--write"], { CODEX_HOME: path.join(b.tmp, "another-home") });
  assert.notEqual(moved.status, 0, moved.all);
  assert.match(moved.stderr, new RegExp(`relay was put into ${b.toml}, but this run looks at .*another-home/config.toml`));
  assert.match(moved.stderr, new RegExp(`CODEX_HOME=${path.dirname(b.toml)}`));
  assert.equal(read(b.toml), installed);

  // A record that cannot be read, or lacks what relay goes by, stops the run instead of being guessed at or overwritten.
  for (const bad of ["{ not json", JSON.stringify({ version: 1, hosts: { codex: { launcher: LAUNCHER } } }), JSON.stringify({ version: 2, hosts: {} })]) {
    write(b.record, bad);
    for (const args of [["install", "codex", "--write"], ["uninstall", "codex", "--write"]]) {
      const r = b.relay(args);
      assert.equal(r.status, 1, r.all);
      assert.match(r.stderr, /installation record at .* cannot be used/);
      assert.doesNotMatch(r.stderr, /TypeError|    at /, "said plainly, not as a stack trace");
    }
    assert.equal(read(b.record), bad);
  }
  assert.equal(read(b.toml), installed);
});

// Claude Code

boxed("install claude: registers the launcher with --host, adds the plugin, and is a no-op the second time", (b) => {
  const dry = b.relay(["install", "claude"]);
  assert.equal(dry.status, 0, dry.all);
  assert.deepEqual(b.changes(), []);

  const r = b.relay(["install", "claude", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(b.changes(), [
    `claude mcp add -s user relay -- ${LAUNCHER} mcp --host claude`,
    `claude plugin marketplace add ${ROOT}/adapters/claude`,
    "claude plugin install relay@relay-local",
  ]);
  assert.deepEqual(b.state("claude").server.args, HOST_ARGS.claude);
  assert.equal(fs.readlinkSync(b.link), LAUNCHER);
  const rec = JSON.parse(read(b.record));
  assert.equal(rec.hosts.claude.launcher, LAUNCHER);
  assert.equal(rec.hosts.claude.complete, true);
  assert.deepEqual(Object.keys(rec.hosts.claude.resources).sort(), ["marketplace", "mcp", "plugin"]);
  assert.equal(rec.hosts.claude.resources.mcp.undo, "claude mcp remove -s user relay");
  assert.equal(rec.link.target, LAUNCHER);

  b.forget();
  const again = b.relay(["install", "claude", "--write"]);
  assert.equal(again.status, 0, again.all);
  assert.match(again.stdout, /Nothing to do/);
  assert.deepEqual(b.changes(), [], "nothing is removed and added again");
});

boxed("install claude: a registration without --host is relay's earlier form and is replaced, with a record of it", (b) => {
  const old = otherRelay(b);
  b.setState("claude", { server: { scope: "User config (available in all your projects)", type: "stdio", command: old, args: ["mcp"], env: [] } });
  const r = b.relay(["install", "claude", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(b.changes().slice(0, 2), ["claude mcp remove -s user relay", `claude mcp add -s user relay -- ${LAUNCHER} mcp --host claude`]);
  assert.equal(b.state("claude").server.command, LAUNCHER);
  const saved = b.files(path.join(b.home, ".config", "relay", "install-backups"));
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^claude-mcp-\d{8}T\d{6}Z\.json$/);
  const kept = JSON.parse(read(path.join(b.home, ".config", "relay", "install-backups", saved[0])));
  assert.equal(kept.command, old);
  assert.deepEqual(kept.args, ["mcp"]);
  assert.equal(JSON.parse(read(b.record)).hosts.claude.resources.mcp.backup, path.join(b.home, ".config", "relay", "install-backups", saved[0]));
});

boxed("install claude: a server named relay that is not relay's is refused without --force", (b) => {
  const foreign = { scope: "User config (available in all your projects)", type: "stdio", command: "/usr/local/bin/relay-chat", args: ["--stdio"], env: ["TOKEN=secret-value"] };
  b.setState("claude", { server: foreign });
  const r = b.relay(["install", "claude", "--write"]);
  assert.notEqual(r.status, 0, r.all);
  assert.match(r.stderr, /is not relay's \(its command is \/usr\/local\/bin\/relay-chat\)/);
  assert.match(r.stderr, /Nothing was changed/);
  assert.deepEqual(b.changes(), [], "no `claude mcp remove`");
  assert.deepEqual(b.state("claude").server, foreign);
  assert.ok(!fs.existsSync(b.link));

  // Uninstall does not touch it either.
  const u = b.relay(["uninstall", "claude", "--write"]);
  assert.equal(u.status, 0, u.all);
  assert.deepEqual(b.changes(), []);
  assert.deepEqual(b.state("claude").server, foreign);

  const forced = b.relay(["install", "claude", "--write", "--force"]);
  assert.equal(forced.status, 0, forced.all);
  assert.equal(b.state("claude").server.command, LAUNCHER);
  const dir = path.join(b.home, ".config", "relay", "install-backups");
  const kept = JSON.parse(read(path.join(dir, b.files(dir)[0])));
  assert.equal(kept.command, "/usr/local/bin/relay-chat");
  assert.deepEqual(kept.env, ["TOKEN=secret-value"]);
  assert.equal(fs.statSync(path.join(dir, b.files(dir)[0])).mode & 0o777, 0o600, "it can hold secrets, so only the user can read it");
  assert.doesNotMatch(forced.all, /secret-value/, "and they are not printed");
});

boxed("install claude: other things it will not replace: a URL server, relay's entry with the user's environment, one hidden by another scope", (b) => {
  const cases: [Rec, RegExp][] = [
    [{ scope: "User config (available in all your projects)", type: "http", url: "https://relay.example/mcp" }, /is not relay's \(it is a http server\)/],
    [{ scope: "User config (available in all your projects)", type: "stdio", command: LAUNCHER, args: ["mcp"], env: ["RELAY_NODE=/opt/node"] }, /carries settings relay did not write \(env RELAY_NODE\)/],
    [{ scope: "Local config (private to you in this project)", type: "stdio", command: LAUNCHER, args: HOST_ARGS.claude, env: [] }, /at another scope \(Local config/],
  ];
  for (const [server, why] of cases) {
    b.setState("claude", { server });
    const r = b.relay(["install", "claude", "--write"]);
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.stderr, why);
    assert.deepEqual(b.changes(), []);
  }
  // Another scope hides the user-level entry, so --force cannot know what it would replace.
  assert.notEqual(b.relay(["install", "claude", "--write", "--force"]).status, 0);
  assert.deepEqual(b.changes(), []);
});

boxed("install codex --write makes relay's Codex home, with relay's config.toml, so the one-time codex login has a home; a dry run only says so", (b) => {
  const home = path.join(b.home, ".local", "share", "relay-codex-home");
  fs.rmSync(home, { recursive: true });
  const dry = b.relay(["install", "codex"]);
  assert.equal(dry.status, 0, dry.all);
  assert.match(dry.stdout, /# with --write, it would also make relay's Codex home, .*relay-codex-home, for the one-time codex login there/);
  assert.ok(!fs.existsSync(home), "a dry run makes nothing");
  const r = b.relay(["install", "codex", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /Codex home: .*relay-codex-home \(made; relay runs Codex with this home, not ~\/\.codex\)\.\nSign Codex in there once:\n  CODEX_HOME=".*relay-codex-home" ".*relay-codex-pins\/current\/bin\/codex" login/);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), '# Managed by relay. Changes are replaced on the next turn.\ncli_auth_credentials_store = "file"\n');
  // Signed in there: said to be there already, and no sign-in asked for.
  fs.writeFileSync(path.join(home, "auth.json"), "{}", { mode: 0o600 });
  const again = b.relay(["install", "codex", "--write"]);
  assert.match(again.stdout, /Codex home: .*relay-codex-home \(already there; /);
  assert.doesNotMatch(again.stdout, /Sign Codex in there once/);
  assert.doesNotMatch(b.relay(["install", "codex"]).stdout, /would also make relay's Codex home/);
});

boxed("pin in doctor: checked only for an enabled codex target, a warning before any pin is in place, and never hiding Codex's registration", (b) => {
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  // Relay's own default: pinned, and no pin store yet (before `relay install codex --write` put one in place on an npm install).
  const config = path.join(b.home, ".config", "relay", "config.json");
  const pass = { child_env: { pass: ["FAKE_DIR", "FAKE_CLAUDE_VERSION", "FAKE_CODEX_VERSION"] } };
  write(config, JSON.stringify(pass));
  const fresh = b.relay(["doctor"]).stdout;
  assert.match(fresh, /codex pin\s+WARNING: relay refuses Codex: no valid qualified pin/);
  assert.doesNotMatch(fresh, /codex pin\s+FAIL/);
  // The registration is still inspected, from Codex's config.toml, without running a Codex relay has not checked.
  assert.match(fresh, /codex mcp\s+relay registered, from this checkout, tool_timeout_sec=\d+; read from .*\.codex\/config\.toml, without running Codex\n/);
  // A pin store whose current is broken: a failure, and the registration is still inspected.
  const store = path.join(b.home, ".local/share/relay-codex-pins");
  fs.mkdirSync(store, { recursive: true });
  fs.symlinkSync("versions/not-a-pin", path.join(store, "current"));
  const broken = b.relay(["doctor"]);
  assert.match(broken.stdout, /codex pin\s+FAIL: relay refuses Codex: no valid qualified pin/);
  assert.match(broken.stdout, /codex mcp\s+relay registered, from this checkout/);
  assert.equal(broken.status, 1);
  // The codex target disabled: its pin is not checked, and Codex's registration still is.
  write(config, JSON.stringify({ ...pass, targets: { codex: { enabled: false } } }));
  const off = b.relay(["doctor"]).stdout;
  assert.match(off, /codex pin\s+not checked: the codex target is disabled\n/);
  assert.doesNotMatch(off, /codex pin\s+(?:FAIL|WARNING)/);
  assert.match(off, /codex mcp\s+relay registered, from this checkout.*without running Codex/);
  // Uninstalled from Codex: said so, from the file.
  assert.equal(b.relay(["uninstall", "codex", "--write"]).status, 0);
  assert.match(b.relay(["doctor"]).stdout, /codex mcp\s+relay NOT registered in .*config\.toml/);
});

boxed("install codex --write: a targets.codex.home relay does not own is left as it was; install registers, then ends with an error; doctor reports it and changes nothing", (b) => {
  const mine = path.join(b.tmp, "mine");
  fs.mkdirSync(mine, { mode: 0o755 }); fs.chmodSync(mine, 0o755);
  fs.writeFileSync(path.join(mine, "config.toml"), 'model = "mine"\n');
  const untouched = () => {
    assert.equal(fs.statSync(mine).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(mine), ["config.toml"]);
    assert.equal(read(path.join(mine, "config.toml")), 'model = "mine"\n');
  };
  writeConfig(path.join(b.home, ".config", "relay", "config.json"), { targets: { codex: { home: mine } } });
  const dry = b.relay(["install", "codex"]);
  assert.equal(dry.status, 0, dry.all);
  assert.match(dry.stdout, /# with --write, relay would not make or change its Codex home, and install would end with an error: .*mine \(targets\.codex\.home\) holds a config\.toml relay did not write/);
  const r = b.relay(["install", "codex", "--write"]);
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /Codex home: relay could not make .*mine: .*holds a config\.toml relay did not write/);
  assert.match(r.stderr, /relay install codex: registered, but Codex is not ready: relay's Codex home is not usable \(see Codex home above\)/);
  assert.ok(toml(read(b.toml)).mcp_servers?.relay, "the registration is in place");
  untouched();
  const doctor = b.relay(["doctor"]);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /codex home\s+FAIL: .*mine \(targets\.codex\.home\) holds a config\.toml relay did not write, so relay will not take it as its Codex home/);
  assert.match(doctor.stdout, /codex launch\s+not checked: relay will not use .*mine as its Codex home \(see the codex home line\), and doctor changes nothing there/);
  assert.match(doctor.stdout, /codex login\s+not checked: relay will not use .*mine as its Codex home/);
  untouched();
  // The person's own ~/.codex as relay's home: the same, by name, though install just wrote relay's registration there.
  writeConfig(path.join(b.home, ".config", "relay", "config.json"), { targets: { codex: { home: path.join(b.home, ".codex") } } });
  const before = read(b.toml);
  const own = b.relay(["install", "codex", "--write"]);
  assert.equal(own.status, 1, own.all);
  assert.match(own.stdout, /Codex home: relay could not make .*: targets\.codex\.home is .*\.codex, your own Codex's home/);
  assert.equal(read(b.toml), before, "its config.toml is not replaced");
  assert.match(b.relay(["doctor"]).stdout, /codex home\s+FAIL: targets\.codex\.home is .*\.codex, your own Codex's home \(~\/\.codex\)/);
});

boxed("install claude: with Claude Code absent nothing is changed", (b) => {
  b.without("claude");
  const r = b.relay(["install", "claude", "--write"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /needs the claude CLI, and `claude` was not found/);
  assert.deepEqual(b.files(b.home), [".local"]);
});

boxed("install claude: a failed step stops the run, exits nonzero, and says what was changed and how to undo it", (b) => {
  const r = b.relay(["install", "claude", "--write"], { FAKE_FAIL: "plugin install" });
  assert.equal(r.status, 1, r.all);
  assert.match(r.stderr, /`claude plugin install relay@relay-local` failed \(exit 1\)/);
  assert.match(r.stderr, /this run had already:/);
  assert.match(r.stderr, new RegExp(`1\\. registered relay with Claude Code: ${LAUNCHER} mcp --host claude\\n\\s+to undo: claude mcp remove -s user relay`));
  assert.match(r.stderr, /2\. added Claude Code's plugin marketplace "relay-local".*\n\s+to undo: claude plugin marketplace remove relay-local/);
  assert.match(r.stderr, /Relay has not undone these/);
  assert.match(r.stderr, new RegExp(`${LAUNCHER} uninstall claude --write`));
  assert.ok(!fs.existsSync(b.link), "the steps after the failed one were not attempted");
  const rec = JSON.parse(read(b.record));
  assert.equal(rec.hosts.claude.complete, false, "the record says the install did not finish");
  assert.deepEqual(Object.keys(rec.hosts.claude.resources).sort(), ["marketplace", "mcp"]);

  // Running it again finishes the job without repeating what is done.
  b.forget();
  const again = b.relay(["install", "claude", "--write"]);
  assert.equal(again.status, 0, again.all);
  assert.deepEqual(b.changes(), ["claude plugin install relay@relay-local"]);
  assert.equal(JSON.parse(read(b.record)).hosts.claude.complete, true);

  // A replacement that gets as far as removing the old registration and no further: the record
  // still says what was taken out, where it is saved, and how to put it back.
  const d = box();
  try {
    const old = otherRelay(d);
    d.setState("claude", { server: { scope: "User config (available in all your projects)", type: "stdio", command: old, args: ["mcp"], env: [] } });
    const half = d.relay(["install", "claude", "--write"], { FAKE_FAIL: "mcp add" });
    assert.equal(half.status, 1, half.all);
    assert.equal(d.state("claude").server, null);
    assert.match(half.stderr, new RegExp(`1\\. removed the Claude Code's user-level MCP server "relay" that was there\\n\\s+what was there before is saved at .*install-backups\\/claude-mcp-.*\\.json.*\\n\\s+to undo: claude mcp add -s user relay -- ${esc(old)} mcp`));
    assert.match(half.stderr, new RegExp(`The same list is kept in ${d.record}`));
    const kept = JSON.parse(read(d.record)).hosts.claude;
    assert.equal(kept.complete, false);
    assert.equal(kept.resources.mcp.action, "removed");
    assert.match(kept.resources.mcp.backup, /install-backups\/claude-mcp-/);
    assert.equal(kept.resources.mcp.undo, `claude mcp add -s user relay -- ${old} mcp`);
    assert.equal(JSON.parse(read(kept.resources.mcp.backup)).command, old);
    // The next run puts relay in, and the record says so.
    assert.equal(d.relay(["install", "claude", "--write"]).status, 0);
    assert.equal(JSON.parse(read(d.record)).hosts.claude.resources.mcp.action, "added");

    // An uninstall that fails part-way reports what it had removed, and the record has it too.
    const u = d.relay(["uninstall", "claude", "--write"], { FAKE_FAIL: "marketplace remove" });
    assert.equal(u.status, 1, u.all);
    assert.match(u.stderr, /this run had already:\n\s+1\. uninstalled the plugin relay@relay-local from Claude Code\n\s+to undo: claude plugin install relay@relay-local/);
    const partly = JSON.parse(read(d.record)).hosts.claude;
    assert.equal(partly.resources.plugin.action, "removed");
    assert.equal(partly.resources.mcp.action, "added", "what was not reached is still on record as installed");
    assert.equal(d.state("claude").server.command, LAUNCHER);
    assert.equal(d.relay(["uninstall", "claude", "--write"]).status, 0);
    assert.ok(!fs.existsSync(d.record));

    // `claude mcp get relay` failing for some other reason is not "there is no such server".
    d.setState("claude", { server: { scope: "User config (available in all your projects)", type: "stdio", command: "/usr/local/bin/relay-chat", args: [], env: [] } });
    d.forget();
    const blind = d.relay(["install", "claude", "--write"], { FAKE_FAIL: "mcp get" });
    assert.notEqual(blind.status, 0);
    assert.match(blind.stderr, /could not see what is registered: `claude mcp get relay` failed/);
    assert.deepEqual(d.changes(), []);
  } finally {
    d.close();
  }

  // And a failure before anything is changed says that nothing was.
  const c = box();
  try {
    const first = c.relay(["install", "claude", "--write"], { FAKE_FAIL: "mcp add" });
    assert.equal(first.status, 1);
    assert.match(first.stderr, /Nothing was changed/);
    assert.equal(c.state("claude").server, null);
    assert.ok(!fs.existsSync(c.link));
  } finally {
    c.close();
  }
});

boxed("uninstall claude: works from the record, removes only relay's own, and the link only when no host is left", (b) => {
  write(b.toml, USER_TOML);
  assert.equal(b.relay(["install", "claude", "--write"]).status, 0);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  b.forget();

  const u = b.relay(["uninstall", "claude", "--write"]);
  assert.equal(u.status, 0, u.all);
  assert.match(u.stdout, new RegExp(`installed \\d{4}-\\d\\d-\\d\\d from ${LAUNCHER}, according to ${b.record}`));
  assert.deepEqual(b.changes(), ["claude plugin uninstall relay@relay-local", "claude plugin marketplace remove relay-local", "claude mcp remove -s user relay"]);
  assert.deepEqual(b.state("claude"), { server: null, markets: [], plugins: [] });
  assert.match(u.stdout, /kept .*\.local\/bin\/relay: relay is still registered with Codex/);
  assert.equal(fs.readlinkSync(b.link), LAUNCHER);
  const rec = JSON.parse(read(b.record));
  assert.deepEqual(Object.keys(rec.hosts), ["codex"], "the record keeps the host that is still installed");

  // Asked for explicitly, the link goes even though Codex still has relay.
  assert.equal(b.relay(["install", "claude", "--write"]).status, 0);
  const asked = b.relay(["uninstall", "claude", "--write", "--remove-link"]);
  assert.equal(asked.status, 0, asked.all);
  assert.ok(!fs.existsSync(b.link));
  assert.deepEqual(relayTable(b.toml), INTENDED, "Codex's registration is not this command's business");

  // An installation made before there was a record is recognised by what it is.
  assert.equal(b.relay(["install", "claude", "--write"]).status, 0);
  fs.rmSync(b.record);
  b.forget();
  const blind = b.relay(["uninstall", "claude", "--write"]);
  assert.equal(blind.status, 0, blind.all);
  assert.match(blind.stdout, /no installation record for Claude Code; going by what is installed/);
  assert.equal(b.changes().length, 3);
  assert.deepEqual(b.state("claude"), { server: null, markets: [], plugins: [] });

  // With nothing of relay's there, uninstall has nothing to do and says so.
  b.forget();
  const nothing = b.relay(["uninstall", "claude", "--write"]);
  assert.equal(nothing.status, 0, nothing.all);
  assert.match(nothing.stdout, /Nothing to do/);
  assert.deepEqual(b.changes(), []);
});

boxed("claude: an environment the user added to relay's own registration is left in place by install and saved by uninstall", (b) => {
  const mine = { scope: "User config (available in all your projects)", type: "stdio", command: LAUNCHER, args: HOST_ARGS.claude, env: ["RELAY_NODE=/opt/node/bin/node"] };
  b.setState("claude", { server: mine });
  const r = b.relay(["install", "claude", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(b.state("claude").server, mine, "relay's part is already right, so the registration is not rewritten");
  assert.ok(!b.changes().some((c) => c.includes(" mcp ")));

  const u = b.relay(["uninstall", "claude", "--write"]);
  assert.equal(u.status, 0, u.all);
  assert.equal(b.state("claude").server, null);
  const dir = path.join(b.home, ".config", "relay", "install-backups");
  assert.deepEqual(JSON.parse(read(path.join(dir, b.files(dir)[0]))).env, ["RELAY_NODE=/opt/node/bin/node"]);
});

boxed("plugin marketplace: another checkout's is replaced, someone else's is refused", (b) => {
  b.setState("claude", { markets: [{ name: "relay-local", path: "/old/checkout/adapters/claude" }], plugins: ["relay@relay-local"] });
  const r = b.relay(["install", "claude", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(b.changes().slice(1), ["claude plugin uninstall relay@relay-local", "claude plugin marketplace remove relay-local", `claude plugin marketplace add ${ROOT}/adapters/claude`, "claude plugin install relay@relay-local"]);

  const foreign = { markets: [{ name: "relay-local", path: "/somewhere/plugins", foreign: { name: "relay-local", source: "github", repo: "someone/relay-local" } }], plugins: [] };
  for (const cli of ["claude", "codex"] as const) {
    const c = box();
    try {
      c.setState(cli, foreign);
      const refused = c.relay(["install", cli, "--write"]);
      assert.notEqual(refused.status, 0, refused.all);
      assert.match(refused.stderr, /plugin marketplace "relay-local" is not relay's/);
      assert.deepEqual(c.changes(), []);
      assert.ok(!fs.existsSync(c.toml), "refused before config.toml is written");
      const u = c.relay(["uninstall", cli, "--write"]);
      assert.equal(u.status, 0, u.all);
      assert.match(u.stdout, /left alone: .*plugin marketplace "relay-local" is not relay's/);
      assert.deepEqual(c.changes(), []);
    } finally {
      c.close();
    }
  }
});

// ~/.local/bin/relay

boxed("link: a file at ~/.local/bin/relay is never deleted; without --force the install is refused", (b) => {
  write(b.link, "#!/bin/sh\necho someone else's relay\n");
  write(b.toml, USER_TOML);
  const r = b.relay(["install", "codex", "--write"]);
  assert.notEqual(r.status, 0, r.all);
  assert.match(r.stderr, /is not relay's link \(it is a file, not a symbolic link\)/);
  assert.match(r.stderr, /--no-link/);
  assert.equal(read(b.toml), USER_TOML, "refused before anything else is changed");
  assert.deepEqual(b.changes(), []);
  assert.equal(read(b.link), "#!/bin/sh\necho someone else's relay\n");

  // --no-link installs around it.
  const around = b.relay(["install", "codex", "--write", "--no-link"]);
  assert.equal(around.status, 0, around.all);
  assert.equal(read(b.link), "#!/bin/sh\necho someone else's relay\n");
  assert.deepEqual(relayTable(b.toml), INTENDED);

  // --force moves it aside under a name of its own and links.
  const forced = b.relay(["install", "codex", "--write", "--force"]);
  assert.equal(forced.status, 0, forced.all);
  assert.equal(fs.readlinkSync(b.link), LAUNCHER);
  assert.equal(read(`${b.link}.bak-relay`), "#!/bin/sh\necho someone else's relay\n");

  // Uninstall removes relay's link and leaves the file that was moved aside.
  assert.equal(b.relay(["uninstall", "codex", "--write"]).status, 0);
  assert.ok(!fs.lstatSync(b.link, { throwIfNoEntry: false }));
  assert.ok(fs.existsSync(`${b.link}.bak-relay`));

  // A file there is not relay's to remove on uninstall, even when asked for the link.
  write(b.link, "mine\n");
  assert.equal(b.relay(["install", "codex", "--write", "--no-link"]).status, 0);
  const u = b.relay(["uninstall", "codex", "--write", "--remove-link"]);
  assert.equal(u.status, 0, u.all);
  assert.match(u.stdout, /left alone: .*is not relay's link/);
  assert.equal(read(b.link), "mine\n");
});

boxed("link: a symlink to something else is refused; one to another relay checkout is repointed", (b) => {
  fs.mkdirSync(path.dirname(b.link), { recursive: true });
  fs.symlinkSync("/usr/local/bin/some-other-tool", b.link);
  const r = b.relay(["install", "claude", "--write"]);
  assert.notEqual(r.status, 0, r.all);
  assert.match(r.stderr, /a symbolic link to \/usr\/local\/bin\/some-other-tool/);
  assert.deepEqual(b.changes(), []);
  assert.equal(fs.readlinkSync(b.link), "/usr/local/bin/some-other-tool");

  // Another tool called relay, linked the way uv and pipx link theirs. Its target ends in bin/relay too.
  const theirs = path.join(b.home, ".local", "share", "uv", "tools", "relay", "bin", "relay");
  write(theirs, "#!/bin/sh\n");
  fs.rmSync(b.link);
  fs.symlinkSync(theirs, b.link);
  const uv = b.relay(["install", "claude", "--write"]);
  assert.notEqual(uv.status, 0, uv.all);
  assert.match(uv.stderr, /is not relay's link \(it is a symbolic link to .*uv\/tools\/relay\/bin\/relay\)/);
  assert.deepEqual(b.changes(), []);
  // Uninstall does not take it for relay's either, asked or not.
  const u = b.relay(["uninstall", "claude", "--write", "--remove-link"]);
  assert.equal(u.status, 0, u.all);
  assert.match(u.stdout, /left alone: .*is not relay's link/);
  assert.equal(fs.readlinkSync(b.link), theirs);

  const old = otherCheckout(b);
  fs.rmSync(b.link);
  fs.symlinkSync(old, b.link);
  const own = b.relay(["install", "claude", "--write"]);
  assert.equal(own.status, 0, own.all);
  assert.equal(fs.readlinkSync(b.link), LAUNCHER);
  assert.equal(JSON.parse(read(b.record)).link.undo, `ln -sfn ${old} ${b.link}`);
});

boxed("link: something that appears at ~/.local/bin/relay while install is running is not replaced", (b) => {
  const r = b.relay(["install", "claude", "--write"], { FAKE_CREATE: b.link });
  assert.equal(r.status, 1, r.all);
  assert.match(r.stderr, /\.local\/bin\/relay changed while relay was working, so it was left as it is/);
  assert.equal(read(b.link), "someone else's program\n");
  assert.match(r.stderr, /this run had already:/, "and what the run did before that is accounted for");
  assert.deepEqual(b.files(path.dirname(b.link)), ["relay"]);
});

// The Claude desktop app

const DESKTOP = { preferences: { sidebar: true }, mcpServers: { email: { command: "email-server", args: ["--stdio"] } } };

boxed("install claude-desktop: the entry's PATH is built from where the executables are now", (b) => {
  write(b.desktop, JSON.stringify(DESKTOP, null, 2) + "\n");
  const r = b.relay(["install", "claude-desktop", "--write"]);
  assert.equal(r.status, 0, r.all);
  const cfg = JSON.parse(read(b.desktop));
  assert.deepEqual({ ...cfg, mcpServers: { email: cfg.mcpServers.email } }, DESKTOP, "everything else is as it was");
  const entry = cfg.mcpServers["relay-desktop"];
  assert.equal(entry.command, LAUNCHER);
  assert.deepEqual(entry.args, [...HOST_ARGS.claude, "--desktop"], "--desktop: the server knows it is the desktop app's entry");
  assert.equal(cfg.mcpServers.relay, undefined, "nothing under the name Claude Code's own relay has");
  const dirs = entry.env.PATH.split(":");
  assert.equal(dirs[0], path.dirname(process.execPath), "the Node that ran the install comes first");
  assert.ok(dirs.includes(b.bin), "the directory of the fake claude and codex");
  const git = fs.realpathSync(path.dirname(spawnSync("/usr/bin/which", ["git"], { env: b.env, encoding: "utf8" }).stdout.trim()));
  // Exactly: the running Node, where claude, codex and git were found, then the system directories. Nothing from a fixed list.
  assert.deepEqual(dirs, [...new Set([path.dirname(process.execPath), b.bin, git, "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])]);
  assert.doesNotMatch(r.all, /WARNING/);
  assert.match(r.stdout, /# relay-desktop is the desktop app's own relay.*Desktop chats.*one relay process.*Cowork.*a second.*session token.*bearer key.*its waits end after 50 s/, "install says what the entry is");
  assert.equal(read(`${b.desktop}.bak-relay`), JSON.stringify(DESKTOP, null, 2) + "\n");
  assert.equal(fs.readlinkSync(b.link), LAUNCHER);

  b.forget();
  const again = b.relay(["install", "claude-desktop", "--write"]);
  assert.match(again.stdout, /Nothing to do/);
  assert.deepEqual(b.files(path.dirname(b.desktop)), ["claude_desktop_config.json", "claude_desktop_config.json.bak-relay"]);

  // Doctor says what the entry is, as a plain line.
  const solo = b.relay(["doctor"]);
  assert.match(solo.stdout, /desktop app\s+relay registered, from this checkout\n\s+relay-desktop is the desktop app's own relay/);
  assert.doesNotMatch(solo.stdout, /hides/);
  // Under its own name the entry hides nothing in the Code tab, so installing Claude Code has nothing to say about it.
  const after = b.relay(["install", "claude", "--write"]);
  assert.equal(after.status, 0, after.all);
  assert.doesNotMatch(after.stdout, /desktop app/);
  assert.doesNotMatch(b.relay(["doctor"]).stdout, /hides/);
});

boxed("install claude-desktop: a CLI that is not on PATH is warned about and left out of the entry's PATH", (b) => {
  write(b.desktop, JSON.stringify(DESKTOP, null, 2) + "\n");
  const elsewhere = path.join(b.tmp, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.renameSync(path.join(b.bin, "codex"), path.join(elsewhere, "codex"));
  fs.renameSync(path.join(b.bin, "claude"), path.join(elsewhere, "claude"));
  const r = b.relay(["install", "claude-desktop", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /WARNING: claude was not found/);
  assert.match(r.stdout, /WARNING: codex was not found/);
  const dirs = JSON.parse(read(b.desktop)).mcpServers["relay-desktop"].env.PATH.split(":");
  assert.ok(!dirs.includes(elsewhere));

  // With `bin` in relay's config saying where they are, the PATH leads there.
  writeConfig(path.join(b.home, ".config", "relay", "config.json"), { bin: { claude: path.join(elsewhere, "claude"), codex: path.join(elsewhere, "codex") } });
  const located = b.relay(["install", "claude-desktop", "--write"]);
  assert.equal(located.status, 0, located.all);
  assert.doesNotMatch(located.stdout, /WARNING/);
  assert.ok(JSON.parse(read(b.desktop)).mcpServers["relay-desktop"].env.PATH.split(":").includes(elsewhere));
});

boxed("install claude-desktop: refused while the app runs, when there is no config, when it is not relay's entry, and when the file would not survive", (b) => {
  const missing = b.relay(["install", "claude-desktop", "--write"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /does not exist; open the Claude desktop app once first/);
  assert.ok(!fs.existsSync(b.desktop));

  const text = JSON.stringify(DESKTOP, null, 4);
  write(b.desktop, text);
  const running = b.relay(["install", "claude-desktop", "--write"], { FAKE_DESKTOP_RUNNING: "1" });
  assert.notEqual(running.status, 0);
  assert.match(running.stderr, /The Claude desktop app is running/);
  assert.equal(read(b.desktop), text);
  assert.equal(b.relay(["install", "claude-desktop"], { FAKE_DESKTOP_RUNNING: "1" }).status, 0, "a dry run may be read while the app is open");
  // Run from inside the app (a Code tab session), the app is an ancestor of the install, and still seen.
  const inside = b.relay(["install", "claude-desktop", "--write"], { FAKE_DESKTOP_ANCESTOR: "1" });
  assert.notEqual(inside.status, 0, inside.all);
  assert.match(inside.stderr, /The Claude desktop app is running/);
  assert.equal(read(b.desktop), text);

  const foreign = JSON.stringify({ mcpServers: { "relay-desktop": { command: "npx", args: ["some-relay"] } } }, null, 2);
  write(b.desktop, foreign);
  const refused = b.relay(["install", "claude-desktop", "--write"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /mcpServers\.relay-desktop in .* is not relay's \(its command is npx\)/);
  assert.equal(read(b.desktop), foreign);
  const forced = b.relay(["install", "claude-desktop", "--write", "--force"]);
  assert.equal(forced.status, 0, forced.all);
  assert.equal(read(`${b.desktop}.bak-relay`), foreign);

  for (const [bad, why] of [['{ "mcpServers": ', /does not parse as JSON/], ['{"a": 1, "a": 2}', /would not survive being rewritten/], ["[1, 2]", /not the shape relay expects/]] as [string, RegExp][]) {
    write(b.desktop, bad);
    const r = b.relay(["install", "claude-desktop", "--write", "--force"]);
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.stderr, why);
    assert.equal(read(b.desktop), bad);
  }

  // A pgrep that cannot answer is not taken to mean the app is closed.
  const text2 = JSON.stringify(DESKTOP, null, 2);
  write(b.desktop, text2);
  const unsure = b.relay(["install", "claude-desktop", "--write"], { FAKE_PGREP_BROKEN: "1" });
  assert.notEqual(unsure.status, 0, unsure.all);
  assert.match(unsure.stderr, /could not check whether the Claude desktop app is running \(pgrep: exit 2\)/);
  assert.equal(read(b.desktop), text2);
});

boxed("uninstall claude-desktop: takes out relay's entry and keeps the file's own style", (b) => {
  const text = JSON.stringify(DESKTOP, null, 4).replace(/\n/g, "\r\n");
  write(b.desktop, text);
  assert.equal(b.relay(["install", "claude-desktop", "--write"]).status, 0);
  const installed = read(b.desktop);
  assert.match(installed, /\r\n {4}"mcpServers"/, "four-space indentation and CRLF are kept");
  assert.doesNotMatch(installed, /(^|[^\r])\n/);

  const running = b.relay(["uninstall", "claude-desktop", "--write"], { FAKE_DESKTOP_RUNNING: "1" });
  assert.notEqual(running.status, 0);
  assert.equal(read(b.desktop), installed);

  const u = b.relay(["uninstall", "claude-desktop", "--write"]);
  assert.equal(u.status, 0, u.all);
  assert.equal(read(b.desktop), text, "back to the original bytes");
  assert.ok(!fs.existsSync(b.link));

  // A file written on one line stays on one line.
  const flat = JSON.stringify(DESKTOP);
  write(b.desktop, flat);
  assert.equal(b.relay(["install", "claude-desktop", "--write"]).status, 0);
  assert.doesNotMatch(read(b.desktop), /\n/);
  assert.equal(JSON.parse(read(b.desktop)).mcpServers["relay-desktop"].command, LAUNCHER);
  assert.equal(b.relay(["uninstall", "claude-desktop", "--write"]).status, 0);
  assert.equal(read(b.desktop), flat);
});

/** Relay's entry as 0.2.0 and the 0.9 release candidates wrote it: under the name `relay`, without --desktop. */
const oldEntry = (b: Box, extra: Rec = {}) => ({ command: LAUNCHER, args: HOST_ARGS.claude, env: { PATH: `${b.bin}:/usr/bin:/bin`, ...extra } });

boxed("install claude-desktop: relay's entry under its earlier name, relay, is moved to relay-desktop in the same edit; someone else's relay is left alone", (b) => {
  write(b.desktop, JSON.stringify({ ...DESKTOP, mcpServers: { ...DESKTOP.mcpServers, relay: oldEntry(b) } }, null, 2) + "\n");
  // Under the old name it hides Claude Code's own relay in Code tab sessions, and doctor and install claude say so.
  const before = b.relay(["doctor"]);
  assert.match(before.stdout, new RegExp(`desktop app\\s+WARNING: relay's entry is under its earlier name, relay, which in Code tab sessions hides the relay Claude Code starts from its own registration\\. Rename it to relay-desktop: quit the app, then ${LAUNCHER} install claude-desktop --write`));
  assert.doesNotMatch(before.stdout, /desktop app\s+relay NOT registered/);
  // Without the --desktop marker the app's chats may not be treated as a shared relay (D9).
  assert.match(before.stdout, /WARNING: relay's entry mcpServers\.relay lacks --desktop, so relay may not treat the app's desktop chats as a shared relay: their conversations would not be kept apart by session tokens \(unverified for the chats' connection/);
  const claude = b.relay(["install", "claude", "--write"]);
  assert.equal(claude.status, 0, claude.all);
  assert.match(claude.stdout, /Note: relay's entry in the Claude desktop app still has its earlier name, relay, which in the app's Code tab sessions hides the relay registered here\. Rename it to relay-desktop/);

  // The app running stops the move as it stops any edit.
  const running = b.relay(["install", "claude-desktop", "--write"], { FAKE_DESKTOP_RUNNING: "1" });
  assert.notEqual(running.status, 0, running.all);
  assert.match(running.stderr, /The Claude desktop app is running/);
  const dry = b.relay(["install", "claude-desktop"]);
  assert.match(dry.stdout, /# remove relay's entry under its earlier name, mcpServers\.relay: in Code tab sessions that name hides the relay Claude Code starts from its own registration/);
  assert.match(dry.stdout, /Nothing was changed/);

  const r = b.relay(["install", "claude-desktop", "--write"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /# add the entry to .*\n# remove relay's entry under its earlier name, mcpServers\.relay/);
  const cfg = JSON.parse(read(b.desktop));
  assert.deepEqual(Object.keys(cfg.mcpServers), ["email", "relay-desktop"]);
  assert.deepEqual(cfg.mcpServers["relay-desktop"].args, [...HOST_ARGS.claude, "--desktop"]);
  assert.equal(cfg.preferences.sidebar, true);
  assert.match(read(`${b.desktop}.bak-relay`), /"relay": \{/, "the file as it was is saved");
  assert.match(read(b.record), /added mcpServers\.relay-desktop and removed mcpServers\.relay \(relay's entry under its earlier name\)/);
  assert.doesNotMatch(b.relay(["doctor"]).stdout, /earlier name|hides|lacks --desktop/);
  assert.doesNotMatch(b.relay(["install", "claude", "--write"]).stdout, /earlier name/);

  // Someone else's server called relay is not relay's to move or remove, --force or not.
  const foreign = { command: "npx", args: ["some-relay"] };
  write(b.desktop, JSON.stringify({ mcpServers: { relay: foreign } }, null, 2));
  for (const force of [[], ["--force"]]) {
    const kept = b.relay(["install", "claude-desktop", "--write", ...force]);
    assert.equal(kept.status, 0, kept.all);
    assert.match(kept.stdout, /# left alone: mcpServers\.relay in .* is not relay's \(its command is npx\)/);
    assert.deepEqual(JSON.parse(read(b.desktop)).mcpServers.relay, foreign);
    assert.equal(JSON.parse(read(b.desktop)).mcpServers["relay-desktop"].command, LAUNCHER);
  }
  const u = b.relay(["uninstall", "claude-desktop", "--write", "--force"]);
  assert.equal(u.status, 0, u.all);
  assert.deepEqual(JSON.parse(read(b.desktop)).mcpServers, { relay: foreign });
  assert.doesNotMatch(b.relay(["doctor"]).stdout, /earlier name/, "doctor does not take it for relay's");

  // Relay's old entry with settings relay did not write: moving it would lose them, so that takes --force.
  const custom = JSON.stringify({ mcpServers: { relay: oldEntry(b, { MY_SETTING: "1" }) } }, null, 2);
  write(b.desktop, custom);
  const refused = b.relay(["install", "claude-desktop", "--write"]);
  assert.notEqual(refused.status, 0, refused.all);
  assert.match(refused.stderr, /mcpServers\.relay in .* \(relay's entry under its earlier name, which this install replaces with relay-desktop\) is relay's, but it carries settings relay did not write \(env\.MY_SETTING\)/);
  assert.equal(read(b.desktop), custom);
  const forced = b.relay(["install", "claude-desktop", "--write", "--force"]);
  assert.equal(forced.status, 0, forced.all);
  assert.deepEqual(Object.keys(JSON.parse(read(b.desktop)).mcpServers), ["relay-desktop"]);
});

boxed("uninstall claude-desktop: removes relay's entry under either name", (b) => {
  write(b.desktop, JSON.stringify(DESKTOP, null, 2) + "\n");
  assert.equal(b.relay(["install", "claude-desktop", "--write"]).status, 0);
  const installed = JSON.parse(read(b.desktop));
  // Both, as after an earlier relay's install ran again.
  write(b.desktop, JSON.stringify({ ...installed, mcpServers: { ...installed.mcpServers, relay: oldEntry(b) } }, null, 2) + "\n");
  const doctor = b.relay(["doctor"]).stdout;
  assert.match(doctor, /desktop app\s+relay registered, from this checkout\n\s+relay-desktop is the desktop app's own relay.*\n\s+WARNING: relay's entry is under its earlier name, relay/);
  const both = b.relay(["uninstall", "claude-desktop", "--write"]);
  assert.equal(both.status, 0, both.all);
  assert.match(both.stdout, /# remove mcpServers\.relay-desktop and mcpServers\.relay from/);
  assert.equal(read(b.desktop), JSON.stringify(DESKTOP, null, 2) + "\n");

  // Only the old name: relay is still registered there, so the link stays when another host is uninstalled.
  assert.equal(b.relay(["install", "claude-desktop", "--write"]).status, 0);
  write(b.desktop, JSON.stringify({ mcpServers: { relay: oldEntry(b) } }, null, 2));
  assert.match(b.relay(["uninstall", "codex", "--write"]).stdout, /kept .*\.local\/bin\/relay: relay is still registered with the Claude desktop app/);
  const old = b.relay(["uninstall", "claude-desktop", "--write"]);
  assert.equal(old.status, 0, old.all);
  assert.match(old.stdout, /# remove mcpServers\.relay from/);
  assert.deepEqual(JSON.parse(read(b.desktop)).mcpServers, {});
  assert.match(b.relay(["uninstall", "claude-desktop", "--write"]).stdout, /has no entry of relay's/);
});

// doctor, usage, version

boxed("doctor: warns for all 0.2.0 config spellings while preserving their settings", (b) => {
  writeConfig(path.join(b.home, ".config", "relay", "config.json"), {
    bin: { claude: "claude" }, default_model: { codex: "gpt-6.1-sol" }, default_effort: { codex: "high" }, notify: true,
  });
  const r = b.relay(["doctor"]);
  assert.equal(r.status, process.platform === "darwin" ? 0 : 1, r.all);
  for (const key of ["bin", "default_model", "default_effort", "notify"]) {
    assert.match(r.stdout, new RegExp(`config\\s+WARNING: config key ${key} is deprecated; use .*throughout relay 1.x`));
  }
  assert.match(r.stdout, /defaults\s+claude:.*codex: gpt-6\.1-sol \/ high/);
  assert.doesNotMatch(r.stderr, /deprecated/, "doctor prints the load warnings in its own report, once");
});

boxed("doctor: reports tested macOS releases and warns on unknown or untested versions", (b) => {
  if (process.platform !== "darwin") return;
  const macVersion = (output: string, exit = 0) => {
    fs.writeFileSync(path.join(b.bin, "sw_vers"), `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${exit}\n`, { mode: 0o755 });
    return b.relay(["doctor"]);
  };
  for (const version of ["27.0", "27.0.1", "27.2", "27.2.1"]) {
    const r = macVersion(version);
    assert.match(r.stdout, /tested on macOS 27\.0, 27\.0\.1, 27\.2, 27\.2\.1/);
    assert.doesNotMatch(r.stdout, /has not been tested with relay/);
  }
  const newer = macVersion("28.0");
  assert.equal(newer.status, 0, newer.all);
  assert.match(newer.stdout, /platform\s+WARNING: macOS 28\.0 has not been tested with relay/);
  assert.match(macVersion("", 1).stdout, /platform\s+WARNING: macOS unknown has not been tested with relay/);
});

boxed("doctor: the former native CLI floors are refused unless explicitly untested", (b) => {
  const r = b.relay(["doctor"], { FAKE_CLAUDE_VERSION: "2.1.286 (Claude Code)", FAKE_CODEX_VERSION: "codex-cli 0.162.1" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /claude\s+FAIL:.*older than the 2\.1\.302/);
  assert.match(r.stdout, /codex\s+FAIL:.*older than the 0\.163\.0/);
});

boxed("doctor: reports what a new machine needs and exits nonzero only when a requirement fails", (b) => {
  const fresh = b.relay(["doctor"]);
  assert.equal(fresh.status, process.platform === "darwin" ? 0 : 1, fresh.all);
  assert.match(fresh.stdout, process.platform === "darwin" ? /platform\s+macOS/ : /platform\s+FAIL: .* is not supported/);
  assert.match(fresh.stdout, new RegExp(`node\\s+${process.version.replace(/\./g, "\\.")} at .*needs 24\\.15 or newer`));
  assert.match(fresh.stdout, /RELAY_NODE \(not set\)/);
  assert.match(fresh.stdout, /claude\s+2\.1\.302 \(Claude Code\) at .*\/bin\/claude \(found on PATH\); tested with 2\.1\.302/);
  assert.match(fresh.stdout, /codex\s+codex-cli 0\.163\.0 at .*\/bin\/codex \(found on PATH\); tested with 0\.163\.0, 0\.164\.0\n/);
  assert.match(fresh.stdout, /git\s+git version \S+.* at \/.*\/git\n/);
  assert.match(fresh.stdout, /claude login\s+signed in; method reported by `claude auth status`: claude\.ai, max/);
  assert.match(fresh.stdout, /codex login\s+Logged in using ChatGPT, in relay's Codex home .*relay-codex-home \(as `codex login status` reports it there\)/);
  assert.doesNotMatch(fresh.stdout, /someone@example\.com|Private Org/, "no account details");
  assert.match(fresh.stdout, /PATH\s+WARNING: .*\.local\/bin is not on PATH/);
  assert.match(fresh.stdout, /relay on PATH\s+WARNING: none/);
  assert.match(fresh.stdout, /claude mcp\s+relay NOT registered/);
  assert.match(fresh.stdout, /codex mcp\s+relay NOT registered/);
  assert.match(fresh.stdout, /desktop app\s+no config at/);
  if (process.platform === "darwin") assert.match(fresh.stdout, /confinement\s+relay-enforced confinement available \(Seatbelt through \/usr\/bin\/sandbox-exec\)/);
  assert.doesNotMatch(fresh.stdout, /built but not enabled|once enabled/, "with the probes on, it says what it enforces");
  assert.match(fresh.stdout, /^\s+enforces: boundary probes under each turn's exact sandbox before every launch/m);
  assert.match(fresh.stdout, /does not: confine reads/);
  assert.match(fresh.stdout, /does not: protect credentials the harness can read/);
  assert.match(fresh.stdout, /does not: allow escalation in 1\.0/);
  assert.deepEqual(b.changes(), [], "doctor only reads");
  assert.ok(b.calls().every((c) => !/ exec /.test(c) && (!/ -p /.test(c) || /--no-session-persistence.*\/skills$/.test(c))), "only the init-only local /skills probe starts print mode");
  // Codex's app server is asked only for its effective configuration (codex launch): the check a turn makes, for a read and a write job.
  assert.equal(b.calls().filter((c) => /^codex app-server /.test(c)).length, 2);
  assert.ok(!fs.existsSync(path.join(b.home, ".local", "state", "relay", "relay.db")), "doctor opens no registry");

  write(b.toml, USER_TOML);
  write(b.desktop, JSON.stringify(DESKTOP, null, 2));
  for (const host of ["claude", "codex", "claude-desktop"]) {
    const install = b.relay(["install", host, "--write"]);
    assert.equal(install.status, 0, install.all);
  }
  const installed = b.relay(["doctor"], { PATH: `${path.dirname(b.link)}:${b.env.PATH}` });
  assert.match(installed.stdout, /PATH\s+.*\.local\/bin is on PATH/);
  assert.match(installed.stdout, /relay on PATH\s+.*\.local\/bin\/relay \(this relay's launcher\)/);
  assert.match(installed.stdout, /claude mcp\s+relay registered, from this checkout/);
  assert.match(installed.stdout, /codex mcp\s+relay registered, from this checkout, tool_timeout_sec=11400/);
  assert.match(installed.stdout, /desktop app\s+relay registered, from this checkout\n\s+relay-desktop is the desktop app's own relay/);
  // Under its own name the desktop app's entry no longer takes the place of Claude Code's in Code tab sessions.
  assert.doesNotMatch(installed.stdout, /hides/);
  // On a disk with less than 1 GB free, doctor also warns of that, which says nothing of the install.
  const lowDisk = /^disk\s+WARNING: only /m.test(installed.stdout);
  // Relay's own Codex home, signed in (the box's): its login is what codex login reports.
  assert.match(installed.stdout, /codex home\s+.*relay-codex-home: present; login present/);
  assert.match(installed.stdout, /codex login\s+Logged in using ChatGPT, in relay's Codex home/);
  // On a macOS release outside TESTED_MACOS (as the maintainer's Macs were on 27.2 before it was
  // added, Nov 2026), doctor warns of that too, which says nothing of the install either.
  const untestedOs = /^platform\s+WARNING: macOS \S+ has not been tested with relay/m.test(installed.stdout);
  const warnings = Number(lowDisk) + Number(untestedOs);
  if (process.platform === "darwin") assert.match(installed.stdout, new RegExp(`requirements met${warnings ? `, ${warnings} warnings?` : ""}\\n$`));

  // Registered from elsewhere, or in the earlier form: said plainly, with the command that fixes it.
  const old = otherRelay(b);
  b.setState("claude", { ...b.state("claude"), server: { scope: "User config (available in all your projects)", type: "stdio", command: old, args: ["mcp"], env: [] } });
  write(b.toml, read(b.toml).replace('args = ["mcp", "--host", "codex"]', 'args = ["mcp"]'));
  fs.rmSync(b.link);
  fs.symlinkSync(path.join(b.bin, "codex"), b.link);
  const drifted = b.relay(["doctor"], { PATH: `${path.dirname(b.link)}:${b.env.PATH}` });
  assert.match(drifted.stdout, new RegExp(`claude mcp\\s+WARNING: relay is registered from another checkout or install: ${esc(old)}`));
  assert.match(drifted.stdout, new RegExp(`codex mcp\\s+WARNING: relay is registered from this checkout in an earlier form \\(no --host\\)\\. Update it: ${LAUNCHER} install codex --write`));
  assert.match(drifted.stdout, /relay on PATH\s+WARNING: .*\/bin\/relay is not this relay \(.*\): it leads to .*\/bin\/codex/);
});

boxed("doctor: npm's global command for this relay passes \"relay on PATH\" under either prefix layout, and a foreign or stale relay ahead of it does not", (b) => {
  // What `npm install -g` (or `npm link`) leaves under a prefix: <prefix>/lib/node_modules/@jbkjr/relay
  // is this relay, and <prefix>/bin/relay a relative symlink to its bin entry, dist/cli.js.
  const npmPrefix = (prefix: string) => {
    fs.mkdirSync(path.join(prefix, "lib", "node_modules", "@jbkjr"), { recursive: true });
    fs.symlinkSync(ROOT, path.join(prefix, "lib", "node_modules", "@jbkjr", "relay"));
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.symlinkSync("../lib/node_modules/@jbkjr/relay/dist/cli.js", path.join(prefix, "bin", "relay"));
    return path.join(prefix, "bin");
  };
  // npm's command runs `#!/usr/bin/env node`: a node on PATH, here the one running the tests.
  const nodeDir = path.join(b.tmp, "nodebin");
  fs.mkdirSync(nodeDir);
  fs.symlinkSync(process.execPath, path.join(nodeDir, "node"));
  for (const prefix of [path.join(b.tmp, "opt", "homebrew"), path.join(b.home, ".npm-global")]) {
    const npmBin = npmPrefix(prefix);
    const r = b.relay(["doctor"], { PATH: `${npmBin}:${nodeDir}:${b.env.PATH}` });
    assert.match(r.stdout, new RegExp(`relay on PATH\\s+${npmBin}/relay \\(npm's global command for this relay\\)\\n`), prefix);
    assert.match(r.stdout, /PATH\s+.*\.local\/bin is not on PATH; not needed, since npm's command for this relay is\n/, prefix);
    // The link install makes, on PATH ahead of npm's command, is this relay too.
    fs.mkdirSync(path.dirname(b.link), { recursive: true });
    fs.symlinkSync(LAUNCHER, b.link);
    const both = b.relay(["doctor"], { PATH: `${path.dirname(b.link)}:${npmBin}:${nodeDir}:${b.env.PATH}` });
    assert.match(both.stdout, /PATH\s+.*\.local\/bin is on PATH\n/);
    assert.match(both.stdout, /relay on PATH\s+.*\.local\/bin\/relay \(this relay's launcher\)\n/);
    // A foreign relay ahead of npm's: a warning, and "PATH" warns again, since npm's command is not the one found.
    const foreign = path.join(b.tmp, "foreign");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "relay"), "#!/bin/sh\necho not relay\n", { mode: 0o755 });
    const shadowed = b.relay(["doctor"], { PATH: `${foreign}:${npmBin}:${b.env.PATH}` });
    assert.match(shadowed.stdout, new RegExp(`relay on PATH\\s+WARNING: ${foreign}/relay is not this relay \\(${ROOT}\\): it leads to ${foreign}/relay\\n`));
    assert.match(shadowed.stdout, /PATH\s+WARNING: .*\.local\/bin is not on PATH, so the link/);
    fs.rmSync(foreign, { recursive: true });
    fs.rmSync(b.link);
    // A relative entry ahead of npm's directory: a shell in some directory would run another relay.
    const relative = b.relay(["doctor"], { PATH: `.:${npmBin}:${nodeDir}:${b.env.PATH}` });
    assert.match(relative.stdout, /relay on PATH\s+WARNING: .*\/bin\/relay \(npm's global command for this relay\), but PATH has the relative entry "\." ahead of it or of its node/);
    // A relative entry after npm's directory but ahead of node's: `env node` could run ./node.
    const nodeShadow = b.relay(["doctor"], { PATH: `${npmBin}:.:${nodeDir}:${b.env.PATH}` });
    assert.match(nodeShadow.stdout, /relay on PATH\s+WARNING: .*\(npm's global command for this relay\), but PATH has the relative entry "\." ahead of it or of its node/);
    // No node on PATH, so npm's command cannot start, whatever runs this doctor.
    const nodeless = b.relay(["doctor"], { PATH: `${npmBin}:${b.env.PATH}` });
    assert.match(nodeless.stdout, /relay on PATH\s+WARNING: .*\/bin\/relay \(npm's global command for this relay\), but it runs the first node on PATH, of which there is none, not the Node running this doctor/);
  }
  // npm's command from another install of the package (a stale one): not this relay.
  const stale = path.join(b.tmp, "stale-prefix");
  fs.mkdirSync(path.join(stale, "lib", "node_modules", "@jbkjr"), { recursive: true });
  const staleRoot = path.dirname(path.dirname(otherCheckout(b)));
  write(path.join(staleRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");
  fs.chmodSync(path.join(staleRoot, "dist", "cli.js"), 0o755);
  fs.symlinkSync(staleRoot, path.join(stale, "lib", "node_modules", "@jbkjr", "relay"));
  fs.mkdirSync(path.join(stale, "bin"), { recursive: true });
  fs.symlinkSync("../lib/node_modules/@jbkjr/relay/dist/cli.js", path.join(stale, "bin", "relay"));
  const old = b.relay(["doctor"], { PATH: `${path.join(stale, "bin")}:${b.env.PATH}` });
  assert.match(old.stdout, /relay on PATH\s+WARNING: .*stale-prefix\/bin\/relay is not this relay \(.*\): it leads to .*old-checkout/);
  assert.deepEqual(b.changes(), [], "doctor only reads");
});

boxed("doctor: an enabled Grok whose every turn relay would refuse says why: no login directory, a login kept elsewhere, a login store the sandbox layer refuses", (b) => {
  // Review r_f887dc06 C4: the checks the launch makes (backends/grok.ts refuse, and the sandbox layer's own
  // check of the login store), so that doctor does not pass a Grok every turn of which is then refused.
  // On a machine with /etc/grok/*.toml or device-managed ai.x.grok preferences, doctor says that instead.
  write(path.join(b.bin, "grok"), '#!/bin/sh\necho "grok 1.0.62 (test)"\n');
  fs.chmodSync(path.join(b.bin, "grok"), 0o755);
  const config = path.join(b.home, ".config", "relay", "config.json");
  writeConfig(config, { targets: { grok: { enabled: true, experimental: true } } });
  // Grok's own variables, unset as relay's environment should have them, unless a case sets one.
  const doctor = (extra: Record<string, string> = {}) => b.relay(["doctor"], { GROK_HOME: "", GROK_AUTH_PATH: "", ...extra }).stdout;
  const launch = /grok launch\s+WARNING: relay refuses every Grok \(experimental\) turn here: /;
  const none = doctor();
  assert.match(none, /grok \(experimental\)\s+grok 1\.0\.62 \(test\) at .*; tested with 1\.0\.62/);
  assert.match(none, new RegExp(`${launch.source}Grok \\(experimental\\) has no login on this machine \\(${b.home}/\\.grok does not exist\\)\\. Sign in with \`grok login\``));
  // Signed in, as `grok login` leaves it: nothing to say.
  const dir = path.join(b.home, ".grok");
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "auth.json"), "{}", { mode: 0o600 });
  assert.doesNotMatch(doctor(), /grok launch/);
  // Relay's environment puts the login elsewhere.
  assert.match(doctor({ GROK_AUTH_PATH: path.join(b.tmp, "elsewhere", "auth.json") }), new RegExp(`${launch.source}GROK_AUTH_PATH in relay's environment puts Grok's login at ${b.tmp}/elsewhere/auth\\.json`));
  // A login store the sandbox layer refuses: the token with a second name elsewhere.
  fs.linkSync(path.join(dir, "auth.json"), path.join(b.tmp, "second-name"));
  assert.match(doctor(), new RegExp(`${launch.source}.*auth\\.json has 2 hard links`));
  fs.rmSync(path.join(b.tmp, "second-name"));
  assert.doesNotMatch(doctor(), /grok launch/);
  // Under an explicit "allow", the note on what it covers names Grok's case too.
  writeConfig(config, { same_family: "allow", targets: { grok: { enabled: true, experimental: true } } });
  assert.match(doctor(), /"allow" also covers sessions of unknown family, Copilot with "auto", no model or an unlisted model, and Grok with no model\./);
  // Switched off, Grok is not looked at.
  writeConfig(config, {});
  fs.rmSync(dir, { recursive: true });
  const off = doctor();
  assert.doesNotMatch(off, /grok launch/);
  assert.doesNotMatch(off, /^grok \(experimental\)/m);
});

boxed("doctor: Codex timeout warnings describe the enforced shared wait cap", (b) => {
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  const cfg = path.join(b.home, ".config", "relay", "config.json");
  assert.doesNotMatch(b.relay(["doctor"]).stdout, /shared wait cap/);
  write(b.toml, read(b.toml).replace("tool_timeout_sec = 11400", "tool_timeout_sec = 60"));
  assert.match(b.relay(["doctor"]).stdout, /tool_timeout_sec=60: relay enforces a shared wait cap of 50 s per call/);
  writeConfig(cfg, { block_s: 1800 });
  write(b.toml, read(b.toml).replace("tool_timeout_sec = 60", "tool_timeout_sec = 3600"));
  assert.match(b.relay(["doctor"]).stdout, /tool_timeout_sec=3600: relay enforces a shared wait cap of 3590 s per call/);
  write(b.toml, read(b.toml).replace("tool_timeout_sec = 3600\n", ""));
  assert.match(b.relay(["doctor"]).stdout, /no valid tool_timeout_sec: relay caps waits below Codex.s 60 s default/);
  assert.doesNotMatch(b.relay(["doctor"]).stdout, /events its result carried are lost|not above twice block_s/);
});

boxed("doctor: a Codex registration without the T3 originator marker needs updating", (b) => {
  write(b.toml, USER_TOML + olderBlock(LAUNCHER).replace('args = ["mcp"]', 'args = ["mcp", "--host", "codex"]'));
  assert.match(b.relay(["doctor"]).stdout, /codex mcp\s+WARNING: .*CODEX_INTERNAL_ORIGINATOR_OVERRIDE.*install codex --write/);
  assert.equal(b.relay(["install", "codex", "--write"]).status, 0);
  assert.doesNotMatch(b.relay(["doctor"]).stdout, /WARNING: .*CODEX_INTERNAL_ORIGINATOR_OVERRIDE/);
});

boxed("doctor: the T3 marker check accepts a combined env_vars list and detects a missing member", (b) => {
  const block = olderBlock(LAUNCHER).replace('args = ["mcp"]', 'args = ["mcp", "--host", "codex"]');
  for (const vars of [["CODEX_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"], ["CODEX_HOME"]]) {
    write(b.toml, USER_TOML + block.replace('tool_timeout_sec = 3600', `env_vars = ${JSON.stringify(vars)}\ntool_timeout_sec = 3600`));
    const missing = /WARNING: .*missing env_vars entry for CODEX_INTERNAL_ORIGINATOR_OVERRIDE/.test(b.relay(["doctor"]).stdout);
    assert.equal(missing, !vars.includes("CODEX_INTERNAL_ORIGINATOR_OVERRIDE"));
  }
});

boxed("doctor: warns for every missing Codex MCP environment variable and explains review withholding", (b) => {
  const block = olderBlock(LAUNCHER).replace('args = ["mcp"]', 'args = ["mcp", "--host", "codex"]');
  for (const vars of [[], ["CODEX_HOME"], ["CODEX_INTERNAL_ORIGINATOR_OVERRIDE"], ["CODEX_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]]) {
    write(b.toml, USER_TOML + block.replace('tool_timeout_sec = 3600', `env_vars = ${JSON.stringify(vars)}\ntool_timeout_sec = 3600`));
    const out = b.relay(["doctor"]).stdout;
    for (const name of ["CODEX_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]) {
      assert.equal(new RegExp(`WARNING: .*missing env_vars entry for ${name}:`).test(out), !vars.includes(name), name);
    }
    if (!vars.includes("CODEX_HOME")) assert.match(out, /missing env_vars entry for CODEX_HOME:.*review withholding.*install codex --write/);
  }
});

boxed("doctor: says whether Claude Code's settings let relay show its approval dialog and offer confirm, and why not", (b) => {
  const settings = path.join(b.home, ".claude", "settings.json");
  const guard = [{ type: "command", command: "guard.sh" }];
  // Hooks that guard other tools only: nothing is withheld.
  write(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "mcp__email__send_email", hooks: guard }, { matcher: "mcp__email__forward_email", hooks: guard }] } }));
  const fine = b.relay(["doctor"]).stdout;
  assert.match(fine, /dialog surface\s+interactive Claude Code: idle qualified from 2\.1\.286; busy qualified from 2\.1\.286; offered only when both version floors/);
  assert.match(fine, /dialog surface\s+Codex CLI: idle qualified from 0\.162\.1; busy qualified from 0\.163\.0; offered only when both version floors/);
  assert.match(fine, /dialog surface\s+Codex app \/ desktop: idle qualified from 0\.162\.0; busy unqualified; withheld: Codex app busy dialogs are not qualified/);
  assert.match(fine, /unknown hosts \/ custom Codex originators: idle unqualified; busy unqualified; withheld/);
  assert.match(fine, /status\.approval_dialogs reports that session's offer and reason/);
  assert.match(fine, /claude consent\s+Claude Code sessions started in \S+ \(local settings read there, at its repository root and at its main checkout's root\): approval dialog can be shown; confirm can be offered\n/);
  assert.match(fine, /judged again when each session starts relay/);
  // Hooks that reach relay: each withheld with its reason.
  write(settings, JSON.stringify({ hooks: { Elicitation: [{ matcher: "relay", hooks: guard }], PermissionRequest: [{ matcher: "mcp__relay__.*", hooks: guard }] } }));
  const held = b.relay(["doctor"]).stdout;
  assert.match(held, /approval dialog withheld \(the Claude Code settings in \S+settings\.json have Elicitation hooks matching "relay"/);
  assert.match(held, /confirm withheld \(the Claude Code settings in \S+settings\.json have PermissionRequest hooks matching "mcp__relay__\.\*"/);
  assert.doesNotMatch(held + fine, /guard\.sh/, "nothing but the matchers is read");
});

boxed("doctor: a registration's --host must name a known host, and the one being checked", (b) => {
  write(b.toml, USER_TOML);
  write(b.desktop, JSON.stringify(DESKTOP, null, 2));
  for (const host of ["claude", "codex", "claude-desktop"]) assert.equal(b.relay(["install", host, "--write"]).status, 0);
  // Codex registered as Claude's family: relay would judge Codex sessions' calls as Claude's.
  write(b.toml, read(b.toml).replace('args = ["mcp", "--host", "codex"]', 'args = ["mcp", "--host", "claude"]'));
  // The desktop app's entry names no host relay knows: every call there is refused.
  const desktop = JSON.parse(read(b.desktop));
  desktop.mcpServers["relay-desktop"].args = ["mcp", "--host", "claud", "--desktop"];
  write(b.desktop, JSON.stringify(desktop, null, 2));
  const out = b.relay(["doctor"], { PATH: `${path.dirname(b.link)}:${b.env.PATH}` });
  assert.equal(out.status, 1, out.all);
  assert.match(out.stdout, new RegExp(`codex mcp\\s+FAIL: relay is registered with --host claude, but Codex's sessions are Codex \\(--host codex\\).*Fix it: ${LAUNCHER} install codex --write`));
  assert.match(out.stdout, /desktop app\s+FAIL: relay is registered with --host "claud", which is not a host relay knows/);
  assert.match(out.stdout, /claude mcp\s+relay registered, from this checkout/, "a registration that matches its host passes");
  // --host as the last argument, with no value.
  write(b.toml, read(b.toml).replace('args = ["mcp", "--host", "claude"]', 'args = ["mcp", "--host"]'));
  assert.match(b.relay(["doctor"]).stdout, /codex mcp\s+FAIL: relay is registered with --host and no value/);
});

boxed("doctor: a CLI version that launching refuses (older, or unreadable) is a failure, or a warning under allow_untested; a missing CLI or no login is a failure", (b) => {
  const versions = { FAKE_CLAUDE_VERSION: "2.1.99 (Claude Code)", FAKE_CODEX_VERSION: "codex-cli (dev build)" };
  const old = b.relay(["doctor"], versions);
  assert.equal(old.status, 1, old.all);
  // The synthetic version is an explicitly released environment value, so its full text
  // is redacted from diagnostics; the parsed floor and the refusal still have to be reported.
  assert.match(old.stdout, /claude\s+FAIL: \[redacted: environment value\].*older than the 2\.1\.302 relay's confinement was verified with, so relay refuses to launch it\. Update Claude Code, or set "allow_untested": true/);
  assert.match(old.stdout, /codex\s+FAIL: .*could not read the version \(its confinement was verified with 0\.163\.0\), so relay refuses to launch it/);
  // Under allow_untested, launching goes ahead, unverified, and doctor only warns.
  writeConfig(path.join(b.home, ".config", "relay", "config.json"), { allow_untested: true });
  const allowed = b.relay(["doctor"], versions);
  assert.equal(allowed.status, process.platform === "darwin" ? 0 : 1, allowed.all);
  assert.match(allowed.stdout, /claude\s+WARNING: \[redacted: environment value\].*older than the 2\.1\.302.*allow_untested is set, so relay launches it anyway, unverified/);
  assert.match(allowed.stdout, /codex\s+WARNING: .*could not read the version.*allow_untested is set/);
  writeConfig(path.join(b.home, ".config", "relay", "config.json"), {});
  assert.doesNotMatch(b.relay(["doctor"], { FAKE_CLAUDE_VERSION: "3.0.0 (Claude Code)", FAKE_CODEX_VERSION: "codex-cli 0.163.0" }).stdout, /older than|could not read the version/);
  // A CLI newer than the one the model notes in its prompting brief were checked with is said.
  const notes = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "adapters", "briefs", "models.json"), "utf8")).claude;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ahead = b.relay(["doctor"], { FAKE_CLAUDE_VERSION: "3.0.0 (Claude Code)" }).stdout;
  assert.match(ahead, new RegExp(`claude brief\\s+(?:WARNING: )?newer than the ${esc(notes.checked_with)} the model notes in relay's prompting brief for Claude were checked with \\(${notes.checked}`));
  assert.doesNotMatch(old.stdout, /claude brief/, "an older CLI is warned about once, as older");

  // A key login is reported as what it is, without the key.
  const key = b.relay(["doctor"], { FAKE_CODEX_LOGIN: "Logged in using an API key - sk-proj-abc123SECRET" });
  assert.match(key.stdout, /codex login\s+Logged in using an API key, in relay's Codex home .* \(as `codex login status` reports it there\)/);
  assert.doesNotMatch(key.stdout, /SECRET|sk-proj/);

  const out = b.relay(["doctor"], { FAKE_LOGGED_OUT: "1" });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /claude login\s+FAIL: not signed in/);
  assert.match(out.stdout, /codex login\s+FAIL: relay's Codex home .*relay-codex-home is not signed in, according to `codex login status` there\. Sign in once with CODEX_HOME=".*relay-codex-home" ".*" login/);
  assert.match(out.stdout, /\d requirements not met/);

  // `bin` in relay's config is where the CLIs are looked for; it says nothing about Node.
  writeConfig(path.join(b.home, ".config", "relay", "config.json"), { bin: { codex: path.join(b.bin, "codex") } });
  assert.match(b.relay(["doctor"]).stdout, /codex\s+codex-cli 0\.163\.0 at .*\/bin\/codex \(set by targets\.codex\.bin in the config\)/);
  writeConfig(path.join(b.home, ".config", "relay", "config.json"), {});

  // A config Codex cannot read is not the same as relay not being registered.
  write(b.toml, "[broken\n");
  assert.match(b.relay(["doctor"]).stdout, /codex mcp\s+WARNING: `codex mcp get relay --json` failed/);
  fs.rmSync(b.toml);

  b.without("codex");
  const missing = b.relay(["doctor"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /codex\s+FAIL: not found or not runnable/);
  assert.doesNotMatch(missing.stdout, /codex login|codex mcp/, "nothing is asked of a CLI that is not there");
});

const COPILOT_TESTED = "1.0.98";

boxed("doctor: an experimental target that relay refuses anyway is reported, not failed; one switched on says so", (b) => {
  const cfg = path.join(b.home, ".config", "relay", "config.json");
  // Switched on but not experimental: relay refuses to launch it, so a missing CLI is information, not a failed requirement.
  writeConfig(cfg, { targets: { copilot: { enabled: true } } });
  const off = b.relay(["doctor"]);
  assert.match(off.stdout, /copilot \(experimental\)\s+not found or not runnable \(`copilot`, looked up on PATH\); relay refuses it anyway until targets\.copilot\.experimental is true/);
  assert.doesNotMatch(off.stdout, /copilot \(experimental\)\s+FAIL/);
  assert.doesNotMatch(off.stdout, /copilot \(experimental\)\s+.*found on PATH|[^.]bin\.copilot/);
  assert.equal(off.status, process.platform === "darwin" ? 0 : 1, off.all);
  // Experimental: relay would launch it, so a missing CLI fails, and the advice names the current key.
  writeConfig(cfg, { targets: { copilot: { enabled: true, experimental: true } } });
  const on = b.relay(["doctor"]);
  assert.match(on.stdout, /copilot \(experimental\)\s+FAIL: not found or not runnable \(`copilot`, looked up on PATH\)\. Install GitHub Copilot CLI, or set targets\.copilot\.bin in \S+ to its full path/);
  // Present and switched on: the capability line no longer asks for the setting that is already there.
  fs.writeFileSync(path.join(b.bin, "copilot"), `#!/bin/sh\necho "GitHub Copilot CLI ${COPILOT_TESTED}"\n`, { mode: 0o755 });
  const present = b.relay(["doctor"]).stdout;
  assert.match(present, /copilot \(experimental\): .*experimental, not qualified \(switched on by targets\.copilot\.experimental\)/);
  assert.match(present, /defaults\s+.*copilot \(experimental\):/);
  assert.match(present, /credentials\s+.*copilot \(experimental\):/);
  assert.doesNotMatch(present, /needs targets\.copilot\.experimental/);
});

boxed("doctor: warns when settings relay does not vet would make it refuse every Claude launch", (b) => {
  const cfg = path.join(b.home, ".config", "relay", "config.json");
  // Organisation-managed settings on this machine would warn whatever the config says; only the config's part is checked then.
  if (!managedSettings()) assert.doesNotMatch(b.relay(["doctor"]).stdout, /claude launch/);
  writeConfig(cfg, { child_settings: "inherit" });
  const inherit = b.relay(["doctor"]);
  // Claude jobs get the never floor, whose gate refuses inherited settings before the settings-env check is reached.
  if (!managedSettings()) assert.match(inherit.stdout, /claude launch\s+WARNING: relay refuses every Claude launch here: child_settings "inherit" can take a job around the never floor's checked sandbox; use child_settings "isolated", child_hooks false and child_mcp "relay-only"/);
  writeConfig(cfg, { child_settings: "inherit", claude_settings_env: "accept", claude_managed_settings: "accept" });
  if (!managedSettings()) assert.match(b.relay(["doctor"]).stdout, /claude launch\s+WARNING: relay refuses every Claude launch here: child_settings "inherit" can take a job around/, "accepting the settings does not lift the floor's gate");
  writeConfig(cfg, { allow_dangerous: true });
  if (!managedSettings()) assert.match(b.relay(["doctor"]).stdout, /claude launch\s+WARNING: relay refuses Claude write jobs here: allow_dangerous would run them unsandboxed, around the never floor/);
  // Nothing is said about Claude when relay does not launch it.
  writeConfig(cfg, { child_settings: "inherit", targets: { claude: { enabled: false } } });
  assert.doesNotMatch(b.relay(["doctor"]).stdout, /claude launch/);
});

boxed("doctor: checks fixture init plugins with isolated settings and verifies a stop without model results", (b) => {
  // The box's home is too long for Claude's temp limit, so the probe needs relay's short link to its
  // ~/.rn, which doctor never makes: a scratch one, as a first Claude turn would have made it.
  const parent = fs.mkdtempSync("/tmp/");
  const rn = path.join(fs.realpathSync(b.home), ".rn");
  fs.mkdirSync(rn, { mode: 0o700 });
  fs.symlinkSync(rn, path.join(parent, `.rn-${process.getuid!()}`));
  const link = { NODE_OPTIONS: `--import=${pathToFileURL(path.join(ROOT, "test", "fixtures", "link-parent.mjs")).href}`, STUB_LINK_PARENT: parent };
  const doctor = () => b.relay(["doctor"], link);
  try {
    const clean = doctor();
    assert.match(clean.stdout, /claude init\s+isolated skills and plugins checked; stopped at init, process ended without a result event/);
    const probe = JSON.parse(read(path.join(b.env.FAKE_DIR, "claude-probe.json")));
    assert.equal(probe.settings.disableBundledSkills, true);
    assert.equal(probe.settings.disableAllHooks, true);
    assert.ok(Object.values(probe.settings.enabledPlugins).every((v) => v === false));
    assert.equal(probe.args[probe.args.indexOf("--setting-sources") + 1], "");
    assert.equal(probe.args[probe.args.indexOf("--tools") + 1], "");
    assert.equal(probe.args.at(-1), "/skills");
    assert.throws(() => process.kill(probe.pid, 0), /ESRCH/);
    assert.equal(fs.existsSync(probe.cwd), false, "scratch settings are removed after the process exits");
    assert.equal(probe.settings.env.CLAUDE_CODE_TMPDIR.startsWith(path.join(parent, `.rn-${process.getuid!()}`) + path.sep), true, "its temp is private and short, through the link");

    const fixture = JSON.parse(read(path.join(ROOT, "test/fixtures/native-skill-isolation.json")));
    b.setState("claude", { initReport: fixture.claude[0].init });
    const bundled = doctor();
    assert.equal(bundled.status, clean.status, "a new builtin warns, never adds a requirement failure");
    assert.match(bundled.stdout, /claude init\s+WARNING: .*bundled with this Claude Code version.*cc-plugin-agents-md.*Update relay or pin Claude Code/);
    // The local /skills reply queued behind init (live 2.1.303 behaviour) is not read: still the
    // built-in warning, and no stop problem.
    b.setState("claude", { initReport: fixture.claude[0].init, initProbe: "result" });
    const queued = doctor().stdout;
    assert.match(queued, /claude init\s+WARNING: .*cc-plugin-agents-md.*Update relay or pin Claude Code/);
    assert.doesNotMatch(queued, /could not verify a stop/);
    b.setState("claude", { initReport: fixture.claude[0].init, initProbe: "result-first" });
    assert.match(doctor().stdout, /claude init\s+WARNING: .*cc-plugin-agents-md.*Update relay or pin Claude Code.*could not verify a stop/);

    b.setState("claude", { initReport: { skills: [], plugins: [{ name: "foreign", source: "foreign@market" }] } });
    assert.match(doctor().stdout, /claude init\s+WARNING: Claude started with plugins relay did not give it \(foreign\)/);
    for (const initProbe of ["exit", "result-first"]) {
      b.setState("claude", { initProbe });
      const failed = doctor();
      assert.equal(failed.status, clean.status);
      assert.match(failed.stdout, /claude init\s+WARNING: Claude's init-only probe (exited without an init report|emitted a result or assistant event)/);
    }
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

boxed("doctor: names the child_env.pass names Codex's own shell_environment_policy keeps from its commands, by name only, going by the effective configuration a turn reads", (b) => {
  const cfg = path.join(b.home, ".config", "relay", "config.json");
  const value = { SMOKE_CANARY: "synthetic-doctor-value-31415" };
  // CLAUDE_CODE_SKIP_X is never released to Codex (a foreign harness's control), DROPPED_X is dropped: neither is judged.
  writeConfig(cfg, { child_env: { pass: ["SMOKE_CANARY", "CLAUDE_CODE_SKIP_X", "DROPPED_X"], drop: ["DROPPED_X"] } });
  const line = (out: string) => out.split("\n").find((l) => l.startsWith("codex env")) ?? "";
  // Codex's default policy, which passes them. The stub app server reports shell_environment_policy
  // as Codex does; codex-shell-policy.json in the fake's directory stands for whichever layer (system,
  // managed, project) sets it. (FAKE_DIR is the box's own pass name, which the fake CLIs need.)
  let out = b.relay(["doctor"], value).stdout;
  assert.match(line(out), /^codex env\s+for a Codex job started in .*, Codex passes the names relay releases to it \((?:FAKE_DIR, )?SMOKE_CANARY\) to the commands it runs, going by its effective configuration$/);
  assert.doesNotMatch(line(out), /WARNING|CLAUDE_CODE_SKIP_X|DROPPED_X/);
  // The maintainer's shape: core, include_only and excludes.
  const policy = (p: unknown) => (fs.writeFileSync(path.join(b.tmp, "fake", "codex-shell-policy.json"), JSON.stringify(p)), value);
  out = b.relay(["doctor"], policy({ inherit: "core", exclude: ["*KEY*", "*TOKEN*", "AWS_*"], include_only: ["PATH", "HOME", "USER"] })).stdout;
  assert.match(line(out), /^codex env\s+WARNING: for a Codex job started in .*: Codex will not pass these names relay released for this turn to the commands it runs: (?:FAKE_DIR \([^)]*\), )?SMOKE_CANARY \(not inherited: inherit = "core"; matches no include_only pattern\)\. Relay gave them to Codex's process\. To let a name through, change shell_environment_policy \(inherit, include_only, exclude, set\) in Codex's own config; relay does not override it\./);
  assert.doesNotMatch(line(out), /CLAUDE_CODE_SKIP_X|DROPPED_X/);
  assert.ok(!out.includes(value.SMOKE_CANARY), "never a value");
  assert.match(out, /\d+ warnings?/);
  // The filters form, letting them through.
  assert.doesNotMatch(line(b.relay(["doctor"], policy({ filters: { "SMOKE_*": "include", "FAKE_*": "include" } })).stdout), /WARNING/);
  // A shape relay does not know: it cannot tell.
  assert.match(line(b.relay(["doctor"], policy({ inherit_from: "core" })).stdout), /^codex env\s+WARNING: for a Codex job started in .*: Relay cannot tell whether Codex passes (?:FAKE_DIR, )?SMOKE_CANARY, released for this turn, to the commands it runs: .*inherit_from/);
  // Relay's Codex home's config.toml is relay's, rewritten on every turn: a policy written there never applies, and is not what is judged.
  fs.rmSync(path.join(b.tmp, "fake", "codex-shell-policy.json"));
  const toml = path.join(b.home, ".local/share/relay-codex-home/config.toml");
  write(toml, `[shell_environment_policy]\ninherit = "none"\n`);
  out = b.relay(["doctor"], value).stdout;
  assert.match(out, /codex home\s+.*relay-codex-home\/config\.toml held changes of its own; relay replaces that file on every turn, so they never apply to a job/);
  assert.doesNotMatch(line(out), /WARNING/);
  assert.equal(fs.readFileSync(toml, "utf8"), '# Managed by relay. Changes are replaced on the next turn.\ncli_auth_credentials_store = "file"\n', "relay's own, as the turn writes it");
  // Nothing is said about Codex when relay does not launch it.
  writeConfig(cfg, { child_env: { pass: ["SMOKE_CANARY"] }, targets: { codex: { enabled: false } } });
  assert.equal(line(b.relay(["doctor"], policy({ inherit: "none" })).stdout), "");
});

boxed("doctor: names Codex's exec-policy rules, says relay's jobs run what they allow sandboxed, and that a network_rule means hosted search only", (b) => {
  const rules = path.join(b.home, ".local/share/relay-codex-home", "rules");
  const said = () => (/codex rules\s+(.*)/.exec(b.relay(["doctor"]).stdout)?.[1] ?? "");
  assert.match(said(), /^no exec-policy rules in .*relay-codex-home\/rules or \/etc\/codex\/rules/);
  write(path.join(rules, "empty.rules"), "\n");
  assert.match(said(), /^no exec-policy rules/, "an empty file is none");
  write(path.join(rules, "default.rules"), 'prefix_rule(pattern=["swift"], decision="allow")\n');
  assert.match(said(), /exec-policy rules in .*default\.rules: relay's Codex jobs run the commands they allow inside the sandbox/);
  assert.doesNotMatch(said(), /network_rule/);
  write(path.join(rules, "net.rules"), 'network_rule(host="localhost", protocol="http", decision="allow")\n');
  assert.match(said(), /net\.rules hold network_rule, so network-granted Codex jobs fall back to hosted web search only/);
});

boxed("doctor: warns when Codex's effective configuration, as a turn reads it, would make relay refuse Codex launches, saying which", (b) => {
  const cfg = path.join(b.home, ".config", "relay", "config.json");
  // codex-effective.json in the fake's directory stands for a layer above relay's flags (system, managed
  // or this directory's project layer): the stub app server reports it in config/read, as Codex reports every layer merged.
  const layer = (eff: unknown) => (fs.writeFileSync(path.join(b.tmp, "fake", "codex-effective.json"), JSON.stringify(eff)), {});
  const said = (env: Record<string, string> = {}) => b.relay(["doctor"], env).stdout;
  const plain = () => (fs.rmSync(path.join(b.tmp, "fake", "codex-effective.json"), { force: true }), {});
  assert.match(said(), /codex launch\s+Codex read and write jobs started in .* pass the checks each turn makes before it starts, on Codex's effective configuration with every layer \(system, managed, this directory's project layers, relay's Codex home\), for the configured default job \(default model and speed, relay's tools, no grants\)\n/);
  assert.doesNotMatch(said(layer({ model_provider: "openai" })), /codex launch\s+WARNING/, "OpenAI's own provider, named explicitly");

  // Another provider is refused whatever codex_endpoint_override says.
  const other = b.relay(["doctor"], layer({ model_provider: "ollama" }));
  assert.match(other.stdout, /codex launch\s+WARNING: relay refuses Codex read and write jobs started in .*, by the checks each turn makes before it starts \(the configured default job .*\): .*model_provider is "ollama", not OpenAI's/);
  assert.match(other.stdout, /\d+ warnings?/);
  writeConfig(cfg, { codex_endpoint_override: "accept" });
  assert.match(said(layer({ model_provider: "ollama" })), /codex launch\s+WARNING: .*model_provider is "ollama"/);

  // OpenAI's provider sent to another endpoint: refused unless codex_endpoint_override is "accept".
  const redirect = layer({ openai_base_url: "https://proxy.example/v1" });
  assert.doesNotMatch(said(redirect), /codex launch\s+WARNING/, "accepted: launching goes ahead");
  writeConfig(cfg, {});
  assert.match(said(redirect), /codex launch\s+WARNING: .*openai_base_url is set \("https:\/\/proxy\.example\/v1"\).*"codex_endpoint_override": "accept"/);

  // The permission profile relay set, changed by a layer above it: the read and the write job's are judged each.
  assert.match(said(layer({ default_permissions: ":danger-full-access" })), /codex launch\s+WARNING: relay refuses Codex read and write jobs started in /);

  // Relay's Codex home's config.toml is rewritten on every turn: what is written there is never judged.
  plain();
  write(path.join(b.home, ".local/share/relay-codex-home/config.toml"), 'model_provider = "ollama"\n');
  const rewritten = said();
  assert.match(rewritten, /codex home\s+.*held changes of its own; relay replaces that file on every turn/);
  assert.doesNotMatch(rewritten, /codex launch\s+WARNING/);

  // Relay's Codex home not made yet: not checked, and the login line says how to make it and sign in.
  fs.rmSync(path.join(b.home, ".local/share/relay-codex-home"), { recursive: true });
  const none = b.relay(["doctor"]);
  assert.match(none.stdout, /codex launch\s+not checked: relay.s Codex home .*relay-codex-home does not exist yet \(`relay install codex --write` makes it; see the codex login line\)/);
  assert.match(none.stdout, /codex login\s+FAIL: relay's Codex home .*relay-codex-home does not exist yet, so relay's Codex jobs have no login\. Run relay install codex --write \(which makes it\), then CODEX_HOME=".*relay-codex-home" ".*" login/);
  assert.equal(none.status, 1);
  assert.ok(!fs.existsSync(path.join(b.home, ".local/share/relay-codex-home")), "doctor does not make it");

  // Nothing is said about Codex when relay does not launch it.
  writeConfig(cfg, { targets: { codex: { enabled: false } } });
  assert.doesNotMatch(said(layer({ model_provider: "ollama" })), /codex launch|your codex/);
});

boxed("doctor: the codex login line goes by the account the app server reports, as a turn does, and says how to sign in again when a stored login is dead", (b) => {
  const cfg = path.join(b.home, ".config", "relay", "config.json");
  const codexHome = path.join(b.home, ".local/share/relay-codex-home");
  // codex-account.txt in the fake's directory: what the stub app server's account/read reports.
  const account = (type: string) => fs.writeFileSync(path.join(b.tmp, "fake", "codex-account.txt"), type);
  const login = (out: string) => /codex login\s+(.*)/.exec(out)?.[1] ?? "";
  const signIn = (again: boolean) => `${again ? "Sign in again" : "Sign in once"} with CODEX_HOME=".*relay-codex-home" ".*" login \\(on a remote or headless Mac, add --device-auth, which needs device code sign-in switched on in ChatGPT's Security settings\\)`;

  // Signed in with ChatGPT, and the app server agrees.
  const fine = b.relay(["doctor"]).stdout;
  assert.match(login(fine), /^Logged in using ChatGPT, in relay's Codex home .*relay-codex-home \(as `codex login status` reports it there\); the app server reports a ChatGPT account there, as each turn checks$/);

  // a private PR: a ChatGPT login is stored, but Codex no longer accepts it (a revoked refresh token), so every turn is refused.
  account("none");
  const dead = b.relay(["doctor"]);
  assert.equal(dead.status, 1);
  assert.match(login(dead.stdout), new RegExp(`^FAIL: relay's Codex home .*relay-codex-home holds a login \\(\`codex login status\`: Logged in using ChatGPT\\), but Codex reports no account for it, according to the app server \\(account/read, the check each turn makes\\), so relay refuses every Codex job: Codex no longer accepts it, most likely because it expired and Codex could not refresh it \\(its refresh token revoked, for one\\)\\. ${signIn(true)}$`));
  assert.match(dead.stdout, new RegExp(`codex launch\\s+WARNING: relay refuses Codex read and write jobs .*Codex is not signed in: relay's Codex home .*relay-codex-home holds a login, but Codex no longer accepts it.*${signIn(true)}`));

  // No login stored at all, and nothing from `codex login status`: not signed in, said without a cause.
  fs.rmSync(path.join(codexHome, "auth.json"));
  const never = login(b.relay(["doctor"], { FAKE_CODEX_LOGIN: "" }).stdout);
  assert.match(never, new RegExp(`^FAIL: relay's Codex home .*relay-codex-home is not signed in, according to the app server \\(account/read, the check each turn makes\\), so relay refuses every Codex job\\. ${signIn(false)}$`));
  assert.doesNotMatch(never, /refresh/);
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}", { mode: 0o600 });

  // An API key, where relay is set not to run on one.
  account("apiKey");
  assert.match(login(b.relay(["doctor"]).stdout), /^FAIL: relay's Codex home .* is signed in with an API key, according to the app server .*, not with a ChatGPT account, and relay is set not to run on API keys \("child_auth": "any" allows it\)\. Sign in once with /);

  // Under child_auth "any" a turn does not judge the login, and neither does the line.
  writeConfig(cfg, { child_auth: "any" });
  account("none");
  const any = b.relay(["doctor"]).stdout;
  assert.match(login(any), /^Logged in using ChatGPT, in relay's Codex home .* \(as `codex login status` reports it there\)$/);
});

boxed("doctor: the codex launch check is the default job's: relay's own MCP server, the never floor, the default speed; an unwritable Codex home is not checked, not refused", (b) => {
  const cfg = path.join(b.home, ".config", "relay", "config.json");
  const fake = path.join(b.tmp, "fake");
  const layer = (eff: unknown) => fs.writeFileSync(path.join(fake, "codex-effective.json"), JSON.stringify(eff));
  const launch = () => /codex launch\s+(.*)/.exec(b.relay(["doctor"]).stdout)?.[1] ?? "";
  // Review r_44d3e0f9 X1: a layer that turns relay's own MCP server off refuses a job that may delegate.
  layer({ mcp_servers: { relay: { enabled: false } } });
  assert.match(launch(), /^WARNING: relay refuses Codex read and write jobs started in .*the configured default job \(default model and speed, relay's tools, no grants\).*relay.s own MCP server/);
  fs.rmSync(path.join(fake, "codex-effective.json"));
  // X2: the probe's permission profile carries the never floor a new run captures, as the turn's does.
  const secret = path.join(b.tmp, "never-secret");
  fs.mkdirSync(secret);
  writeConfig(cfg, { never: { paths: [{ path: secret }] } });
  b.forget();
  assert.match(launch(), /^Codex read and write jobs started in .* pass the checks each turn makes before it starts/);
  const servers = b.calls().filter((c) => /^codex app-server /.test(c));
  assert.equal(servers.length, 2);
  for (const c of servers) assert.ok(c.includes(secret), "the never path is in the profile the app server is given");
  // X4: the configured default speed is the job's: a faster one keeps the person's fast_mode, which a layer turned off.
  writeConfig(cfg, { targets: { codex: { speed: "fast" } } });
  fs.writeFileSync(path.join(fake, "codex-features.json"), JSON.stringify({ fast_mode: false }));
  assert.match(launch(), /^WARNING: relay refuses Codex read and write jobs .*fast_mode/);
  writeConfig(cfg, {});
  assert.doesNotMatch(launch(), /WARNING/, "a standard job turns fast_mode on itself, so the same setting does not refuse it");
  fs.rmSync(path.join(fake, "codex-features.json"));
  // C1: relay's Codex home cannot be prepared here (as inside a launched agent, whose sandbox denies it;
  // here its config.toml is a directory, which the turn's rewrite cannot replace): not checked, which
  // says nothing about a job relay starts, rather than "relay refuses".
  const toml = path.join(b.home, ".local/share/relay-codex-home/config.toml");
  fs.rmSync(toml, { force: true });
  fs.mkdirSync(toml);
  assert.match(launch(), /^not checked: relay could not prepare its Codex home here \(.*\)\. This says nothing about a job relay starts; run relay doctor in your own terminal$/);
});

boxed("doctor: the person's own ~/.codex is labelled as theirs, not as what relay's Codex jobs read", (b) => {
  const out = b.relay(["doctor"]).stdout;
  assert.match(out, /your codex\s+.*\/home\/\.codex: your own Codex's home, for your Codex sessions\. Relay's Codex jobs do not read it: they run with relay's Codex home \(.*relay-codex-home\), so its config\.toml, rules, skills, AGENTS\.md and login do not apply to them\n/);
  // The registration in it is the person's Codex sessions' own, and is still read there.
  assert.match(out, /codex mcp\s+relay NOT registered/);
});

boxed("doctor: says which credentials launched agents are given, and warns about the legacy global child_auth \"any\"", (b) => {
  const cfgFile = path.join(b.home, ".config", "relay", "config.json");
  assert.match(b.relay(["doctor"]).stdout, /credentials\s+claude: every vendor's API keys removed; codex: every vendor's API keys removed/);

  writeConfig(cfgFile, { targets: { codex: { child_auth: "any" } } });
  const one = b.relay(["doctor"]).stdout;
  assert.match(one, /credentials\s+claude: every vendor's API keys removed; codex: only its own selected authentication inputs eligible; every other vendor's removed/);
  assert.doesNotMatch(one, /credentials\s+WARNING/);

  // The global setting warns but keeps the same foreign-vendor scrubs as the per-target form.
  writeConfig(cfgFile, { child_auth: "any" });
  const global = b.relay(["doctor"]);
  assert.match(global.stdout, /credentials\s+claude: only its own selected authentication inputs eligible; every other vendor's removed; codex: only its own selected authentication inputs eligible; every other vendor's removed/);
  assert.match(global.stdout, /global child_auth "any" no longer forwards other vendors' credentials in relay 1\.0; use targets\.<id>\.child_auth "any" and exact child_env\.pass entries/);
  assert.match(global.stdout, /\d+ warnings?/);

  // A per-target login setting still overrides the global allowance.
  writeConfig(cfgFile, { child_auth: "any", targets: { claude: { child_auth: "login" } } });
  assert.match(b.relay(["doctor"]).stdout, /credentials\s+claude: every vendor's API keys removed; codex: only its own selected authentication inputs eligible; every other vendor's removed/);
  writeConfig(cfgFile, {});
});

boxed("usage errors exit nonzero, and --version prints the package version", (b) => {
  const version = JSON.parse(read(path.join(ROOT, "package.json"))).version;
  const v = b.relay(["--version"]);
  assert.equal(v.status, 0);
  assert.equal(v.stdout, `relay ${version}\n`);
  assert.equal(b.relay(["--help"]).status, 0);
  for (const args of [[], ["frobnicate"], ["install"], ["install", "vscode"], ["install", "codex", "--wirte"], ["install", "claude", "codex"], ["uninstall"], ["uninstall", "codex", "--no-link"], ["cancel"], ["approve"], ["deny"]]) {
    const r = b.relay(args);
    assert.equal(r.status, 2, `relay ${args.join(" ")}: ${r.all}`);
    assert.match(r.stderr, /usage: relay|unknown command|relay install </);
    assert.equal(r.stdout, "");
  }
  assert.deepEqual(b.calls(), [], "a mistyped command runs nothing");
  assert.deepEqual(b.files(path.join(b.home, ".codex")), []);
});

// The launcher

boxed("launcher: RELAY_NODE first, then PATH, then the version managers, newest nvm version first; too old is passed over", (b) => {
  // A stand-in Node says which one it is, and whether it is new enough for relay.
  const node = (file: string, label: string, ok = true) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = "-e" ] && exit ${ok ? 0 : 1}\necho "${label}"\n`, { mode: 0o755 });
    return file;
  };
  const launch = (env: Record<string, string> = {}, PATH = "/usr/bin:/bin") => {
    const r = spawnSync(LAUNCHER, ["--version"], { env: { HOME: b.home, PATH, ...env }, encoding: "utf8" });
    return `${r.stdout.trim()}${r.stderr.trim() ? ` | ${r.stderr.trim()}` : ""}`;
  };
  const h = b.home;
  const onPath = path.join(b.tmp, "pathbin");

  node(path.join(h, ".local/share/mise/shims/node"), "mise");
  assert.equal(launch(), "mise");
  node(path.join(h, ".asdf/shims/node"), "asdf");
  assert.equal(launch(), "asdf");
  node(path.join(h, ".volta/bin/node"), "volta");
  assert.equal(launch(), "volta");
  node(path.join(h, ".nvm/versions/node/v24.14.0/bin/node"), "nvm 24.14", false);
  assert.equal(launch(), "volta", "an nvm version that is too old is passed over");
  node(path.join(h, ".nvm/versions/node/v24.15.0/bin/node"), "nvm 24.15");
  node(path.join(h, ".nvm/versions/node/v9.11.2/bin/node"), "nvm 9", false);
  assert.equal(launch(), "nvm 24.15");
  node(path.join(h, ".nvm/versions/node/v26.1.0/bin/node"), "nvm 26.1");
  node(path.join(h, ".nvm/versions/node/v26.10.0/bin/node"), "nvm 26.10");
  assert.equal(launch(), "nvm 26.10", "newest by number, not by spelling");
  assert.equal(launch({ NVM_DIR: path.join(b.tmp, "no-such") }), "volta");
  node(path.join(h, ".local/share/fnm/aliases/default/bin/node"), "fnm");
  assert.equal(launch(), "fnm");
  node(path.join(onPath, "node"), "path");
  assert.equal(launch({}, `${onPath}:/usr/bin:/bin`), "path");
  const chosen = node(path.join(b.tmp, "chosen", "node"), "RELAY_NODE");
  assert.equal(launch({ RELAY_NODE: chosen }, `${onPath}:/usr/bin:/bin`), "RELAY_NODE");
  assert.match(launch({ RELAY_NODE: node(path.join(b.tmp, "old", "node"), "old", false) }, `${onPath}:/usr/bin:/bin`), /^path \| relay: RELAY_NODE \(.*\) is not a Node >= 24\.15; looking elsewhere$/);

  // A host starts the launcher with its own pipe on stdin. The version check must not read from it.
  const greedy = path.join(b.tmp, "greedy", "node");
  fs.mkdirSync(path.dirname(greedy));
  fs.writeFileSync(greedy, '#!/bin/sh\nif [ "$1" = "-e" ]; then cat >/dev/null; exit 0; fi\ncat\n', { mode: 0o755 });
  const piped = spawnSync(LAUNCHER, ["mcp"], { env: { HOME: b.home, PATH: "/usr/bin:/bin", RELAY_NODE: greedy }, input: "what the host sent\n", encoding: "utf8" });
  assert.equal(piped.stdout, "what the host sent\n");

  // Called by a relative path, as the README's first-run commands do, with CDPATH exported in the shell.
  for (const CDPATH of ["/tmp", `.:${b.tmp}`, ROOT]) {
    const rel = spawnSync("bin/relay", ["--version"], { cwd: ROOT, env: { HOME: b.home, PATH: "/usr/bin:/bin", RELAY_NODE: process.execPath, CDPATH }, encoding: "utf8" });
    assert.equal(rel.stdout + rel.stderr, `relay ${JSON.parse(read(path.join(ROOT, "package.json"))).version}\n`, `CDPATH=${CDPATH}`);
  }

  // Reached through relay's link, it still finds its own checkout.
  fs.mkdirSync(path.dirname(b.link), { recursive: true });
  fs.symlinkSync(LAUNCHER, b.link);
  const real = spawnSync(b.link, ["--version"], { env: { HOME: b.home, PATH: "/usr/bin:/bin", RELAY_NODE: process.execPath }, encoding: "utf8" });
  assert.equal(real.stdout, `relay ${JSON.parse(read(path.join(ROOT, "package.json"))).version}\n`);
});

test("package.json, the launcher and the README agree on the minimum Node", () => {
  const pkg = JSON.parse(read(path.join(ROOT, "package.json")));
  assert.equal(pkg.engines.node, ">=24.15");
  assert.equal(JSON.parse(read(path.join(ROOT, "npm-shrinkwrap.json"))).packages[""].engines.node, ">=24.15");
  assert.match(read(path.join(ROOT, "README.md")), /Node 24\.15 or newer/);
  assert.match(read(path.join(ROOT, "src", "install", "doctor.ts")), /const MIN_NODE = \[24, 15\];/);
  assert.doesNotMatch(read(path.join(ROOT, "README.md")) + read(LAUNCHER), /22\.1[38]/);
  // The launcher's own check, run on version strings: 24.15 and later pass, Node 22 and 24.14 do not.
  const check = /"\$1" -e '([^']+)'/.exec(read(LAUNCHER))![1];
  const accepts = (version: string) => {
    let code = -1;
    new Function("process", check)({ versions: { node: version }, exit: (c: number) => { code = c; } });
    return code === 0;
  };
  for (const v of ["24.15.0", "24.22.3", "25.0.0", "26.13.1"]) assert.ok(accepts(v), v);
  for (const v of ["22.18.0", "22.23.5", "23.11.0", "24.0.0", "24.14.1"]) assert.ok(!accepts(v), v);
});

for (const cli of ["claude", "codex"] as const) {
  boxed(`install ${cli}: a plugin left over from an earlier version of this checkout is put in again; one at this version is left alone`, (b) => {
    assert.equal(b.relay(["install", cli, "--write"]).status, 0);
    b.forget();
    // Same checkout, same version: nothing to do.
    assert.equal(b.relay(["install", cli, "--write"]).status, 0);
    assert.deepEqual(b.changes(), []);
    // The host still has the plugin as an earlier version installed it: its copy holds the old skills.
    const r = b.relay(["install", cli, "--write"], { FAKE_PLUGIN_VERSION: "0.0.9" });
    assert.equal(r.status, 0, r.all);
    const [add, remove] = cli === "claude" ? ["install", "uninstall"] : ["add", "remove"];
    assert.deepEqual(b.changes(), [
      `${cli} plugin ${remove} relay@relay-local`,
      `${cli} plugin marketplace remove relay-local`,
      `${cli} plugin marketplace add ${ROOT}/adapters/${cli}`,
      `${cli} plugin ${add} relay@relay-local`,
    ]);
  });

  boxed(`install ${cli} (D4): a host's copy of the plugin whose content is not this checkout's adapter is put in again, at the same version too`, (b) => {
    const version = JSON.parse(read(path.join(ROOT, "package.json"))).version;
    const [add, remove] = cli === "claude" ? ["install", "uninstall"] : ["add", "remove"];
    const reinstall = [
      `${cli} plugin ${remove} relay@relay-local`,
      `${cli} plugin marketplace remove relay-local`,
      `${cli} plugin marketplace add ${ROOT}/adapters/${cli}`,
      `${cli} plugin ${add} relay@relay-local`,
    ];
    // Where each host keeps its copy: Claude Code names it in `plugin list --json`; Codex's is at a fixed place under CODEX_HOME.
    const copy = path.join(b.home, cli === "claude" ? ".claude" : ".codex", "plugins", "cache", "relay-local", "relay", version);
    const skillIn = (dir: string) => path.join(dir, "skills", cli === "claude" ? "tree" : "relay-tree", "SKILL.md");
    const ours = read(skillIn(path.join(ROOT, "adapters", cli, "relay")));
    assert.equal(b.relay(["install", cli, "--write"]).status, 0);
    assert.equal(read(skillIn(copy)), ours, "the host keeps its own copy of the plugin");
    b.forget();
    // The same content: nothing to do.
    assert.equal(b.relay(["install", cli, "--write"]).status, 0);
    assert.deepEqual(b.changes(), []);

    // The copy an earlier respin at this version put in, whose skill read differently.
    fs.appendFileSync(skillIn(copy), "An earlier wording of this skill.\n");
    const dry = b.relay(["install", cli]);
    assert.equal(dry.status, 0, dry.all);
    assert.ok(dry.stdout.includes(`copy of the plugin (${copy}) is not this checkout's adapters/${cli}/relay`), dry.stdout);
    assert.deepEqual(b.changes(), [], "a dry run only says so");
    const r = b.relay(["install", cli, "--write"]);
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(b.changes(), reinstall);
    assert.equal(read(skillIn(copy)), ours, "the host's copy is this checkout's again");
    b.forget();
    assert.equal(b.relay(["install", cli, "--write"]).status, 0);
    assert.deepEqual(b.changes(), [], "and left alone after that");

    // A file the checkout no longer has (a skill since removed) counts as a difference too.
    write(path.join(copy, "skills", "gone", "SKILL.md"), "A skill this checkout no longer has.\n");
    assert.equal(b.relay(["install", cli, "--write"]).status, 0);
    assert.deepEqual(b.changes(), reinstall);
    assert.ok(!fs.existsSync(path.join(copy, "skills", "gone")));
    b.forget();

    // A copy relay cannot find is put in again, not taken on trust.
    fs.rmSync(copy, { recursive: true });
    const lost = b.relay(["install", cli, "--write"]);
    assert.equal(lost.status, 0, lost.all);
    assert.match(lost.stdout, /could not (find|read) .*copy of the plugin/);
    assert.deepEqual(b.changes(), reinstall);
    assert.equal(read(skillIn(copy)), ours);
  });
}


boxed("doctor: says which extensions each target may be given, that relay's MCP definitions file must be private, and which legacy settings waive relay's isolation (docs/extensions.md, review C17)", (b) => {
  const cfgDir = path.join(b.home, ".config", "relay");
  writeConfig(path.join(cfgDir, "config.json"), { targets: { codex: { skills: ["tdd"], mcp_servers: ["docs", { name: "email", allow_tools: ["list"] }] } } });
  write(path.join(b.home, ".codex", "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Test first.\n---\nBody.\n");
  const out = () => b.relay(["doctor"]).stdout;
  assert.match(out(), /extensions\s+codex: skills tdd/);
  assert.match(out(), /extensions\s+WARNING: codex: MCP servers docs, email: relay's MCP definitions file .*mcp\.json does not exist/);
  write(path.join(cfgDir, "mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" }, email: { command: "email-mcp", env: { TOKEN: "x" } } } }));
  fs.chmodSync(path.join(cfgDir, "mcp.json"), 0o644);
  assert.match(out(), /mcp\.json\s+WARNING: .*can be read by other users \(mode 644\)/);
  assert.match(out(), /extensions\s+codex: MCP servers docs, email \(list without asking\), defined in/);
  assert.match(out(), /runs outside the agent's sandbox as your own process/);
  fs.chmodSync(path.join(cfgDir, "mcp.json"), 0o600);
  assert.doesNotMatch(out(), /can be read by other users/);
  assert.doesNotMatch(out(), /isolation\s/);

  // Without extensions, the legacy settings are allowed and named for what they waive.
  writeConfig(path.join(cfgDir, "config.json"), { child_mcp: "inherit", child_hooks: true });
  const legacy = out();
  assert.match(legacy, /extensions\s+none allowed/);
  assert.match(legacy, /isolation\s+WARNING: child_mcp waives relay's isolation of launched agents/);
  assert.match(legacy, /isolation\s+WARNING: child_hooks waives relay's isolation of launched agents/);
});
