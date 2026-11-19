// Codex's sandbox as relay sets it: a permission profile of relay's own (codex.ts codexPermissions),
// selected with -c and named on the thread, with the harness configuration relay's own sandbox
// refuses read-only at the top of every workspace root. Checked against what Codex reports back
// (codex-app.ts configProblem, requirementsProblem, threadPermissionsProblem), and, where Codex is
// installed, against Codex's own sandbox (`codex sandbox`, the Seatbelt profile its commands run in).
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse } from "smol-toml";
import { harness, realCodexBin, scratchEnv } from "./helpers.ts";
import { codexFlags, codexPermissions, deniedCredentials, permissionFlags, toml, tomlInline } from "../dist/backends/codex.js";
import { addedPermissions, CODEX_PROFILE, commandAsk, configProblem, requirementsProblem, threadPermissionsProblem, type CodexPermissions } from "../dist/backends/codex-app.js";
import { dirIdentity } from "../dist/confine/index.js";
import { codexEscalatedEffect } from "../dist/core/approvals.js";
import { HARNESS_CONFIG } from "../dist/confine/seatbelt.js";
import { withDefaults } from "../dist/core/config.js";
import { requestRunsRelayCommand } from "../dist/core/relay-command.js";
import { codexWriteRootProblem } from "../dist/targets/codex.js";
import { targetDef } from "../dist/targets/index.js";
import { neverKeychainIpc } from "../dist/core/never-coverage.js";
import { resolveNeverPolicy } from "../dist/core/never-policy.js";
import { attempt, decoyKeychain, keychainSkip, retrieved, withTeardown, wrapped, type DecoyKeychain } from "./keychain-decoy.ts";

const appServer = { codex_backend: "app-server" } as never;
const exec = { codex_backend: "exec" } as never;
const readOnlyNames = Object.fromEntries(HARNESS_CONFIG.map((n: string) => [n, "read"]));

/** A -c value read back as Codex reads it: as the value of a TOML key (in plain objects, as the assertions compare them). */
const tomlBack = (raw: string): unknown => structuredClone(parse(`v = ${raw}`).v);

test("codex permissions: every kind of turn relay launches, as a profile with the sandbox it had before plus read-only harness configuration", () => {
  const read = codexPermissions({ access: "read", config: appServer }, { dangerous: false, network: false, roots: [] });
  // Every confined turn, read or write, may not read the credential stores (and so no command leaves the sandbox).
  const ownedHome = path.join(os.homedir(), ".local/share/relay-codex-home");
  const store = path.join(os.homedir(), ".local/share/relay-codex-pins");
  const denied = { "~/.ssh": "deny", "~/.aws": "deny", "~/.gnupg": "deny", "~/.netrc": "deny", "~/.codex/auth.json": "deny", [ownedHome]: "deny" };
  assert.deepEqual(deniedCredentials(undefined), denied);
  // Codex's login where CODEX_HOME puts it.
  assert.deepEqual(deniedCredentials("/x/codex-home"), { ...denied, "/x/codex-home/auth.json": "deny" });
  assert.deepEqual(deniedCredentials("relative/home"), denied, "a CODEX_HOME that is not absolute: Codex's default");
  assert.deepEqual(codexPermissions({ access: "read", config: appServer }, { dangerous: false, network: false, roots: [], codexHome: "/x/codex-home" }).profile!.filesystem["/x/codex-home/auth.json"], "deny");
  const protectedPaths = { [store]: "read", ...denied };
  assert.deepEqual(read, { id: CODEX_PROFILE, profile: { filesystem: { ":root": "read", ...protectedPaths }, network: { enabled: false } }, sandbox: "read-only", network: false, proxy: null });
  // The network, when a turn has it, goes through Codex's proxy: every public host, nothing of this
  // Mac's own or private, no upstream proxy; strict unless asked otherwise.
  const strict = { enabled: true, domains: { "*": "allow" }, allow_local_binding: false, allow_upstream_proxy: false };
  // A read turn with the network: granted on the app server, strict and with no Unix sockets whatever
  // is asked; the exec fallback never gave it one, and still does not.
  assert.deepEqual(codexPermissions({ access: "read", config: appServer }, { dangerous: false, network: true, roots: [] }), { id: CODEX_PROFILE, profile: { filesystem: { ":root": "read", ...protectedPaths }, network: strict }, sandbox: "read-only", network: true, proxy: "strict" });
  assert.deepEqual(codexPermissions({ access: "read", config: appServer }, { dangerous: false, network: true, roots: [], net: { mode: "local", sockets: ["/t"] } }).profile!.network, strict);
  assert.deepEqual(codexPermissions({ access: "read", config: exec }, { dangerous: false, network: true, roots: [] }).profile!.network, { enabled: false });
  assert.equal(codexPermissions({ access: "read", config: exec }, { dangerous: false, network: true, roots: [] }).proxy, null);
  const write = codexPermissions({ access: "write", config: appServer }, { dangerous: false, network: true, roots: ["/g/one", "/g/two"], net: { mode: "strict", sockets: ["/t/own", "/w"] } });
  assert.deepEqual(write, {
    id: CODEX_PROFILE, sandbox: "workspace-write", network: true, proxy: "strict",
    profile: {
      workspace_roots: { "/g/one": true, "/g/two": true },
      // Everything readable; the worktree and the granted directories writable, and the turn's own
      // TMPDIR, not the rest of /tmp; at the top of each, relay's list of harness configuration read-only.
      filesystem: { ":root": "read", ":tmpdir": "write", ":workspace_roots": { ".": "write", ...readOnlyNames }, ...protectedPaths },
      // Unix sockets only in the directories named: the turn's TMPDIR and the job's worktree.
      network: { ...strict, unix_sockets: { "/t/own": "allow", "/w": "allow" } },
    },
  });
  // Local: the same with loopback and the LAN open; hosted: no shell network at all.
  const local = codexPermissions({ access: "write", config: exec }, { dangerous: false, network: true, roots: [], net: { mode: "local", sockets: ["/t/own"] } });
  assert.deepEqual([local.proxy, local.network, local.profile!.network], ["local", true, { ...strict, allow_local_binding: true, unix_sockets: { "/t/own": "allow" } }]);
  const hosted = codexPermissions({ access: "write", config: appServer }, { dangerous: false, network: true, roots: [], net: { mode: "hosted" } });
  assert.deepEqual([hosted.proxy, hosted.network, hosted.profile!.network], [null, false, { enabled: false }]);
  // No socket directories named: no unix_sockets key, so no Unix sockets.
  assert.equal("unix_sockets" in codexPermissions({ access: "write", config: appServer }, { dangerous: false, network: true, roots: [] }).profile!.network, false);
  for (const name of [".claude", ".gemini", ".codex", ".agents", ".mcp.json", ".vscode", ".envrc"]) {
    assert.equal((write.profile!.filesystem[":workspace_roots"] as Record<string, string>)[name], "read", name);
  }
  // No granted directory: no workspace_roots key at all.
  assert.equal("workspace_roots" in codexPermissions({ access: "write", config: exec }, { dangerous: false, network: false, roots: [] }).profile!, false);
  // allow_dangerous: Codex's own profile without a sandbox.
  assert.deepEqual(codexPermissions({ access: "write", config: appServer }, { dangerous: true, network: false, roots: [] }), { id: ":danger-full-access", profile: null, sandbox: "danger-full-access", network: true, proxy: null });
});

test("codex permissions: the -c values select and define the profile, and every name and path is a quoted key inside a value, never part of a dotted key", () => {
  // A dot, quotes, a backslash, DEL (which TOML, unlike JSON, wants escaped), a tab and a character beyond the BMP.
  const odd = '/tmp/a.b/with "quotes" and \\back.slash\x7fdel\ttab \u{1F600}';
  const p = codexPermissions({ access: "write", config: appServer }, { dangerous: false, network: false, roots: [odd] });
  const flags = permissionFlags(p);
  const pairs = flags.filter((_: string, i: number) => i % 2 === 1);
  assert.ok(flags.every((f: string, i: number) => i % 2 === 1 || f === "-c"));
  const keys = pairs.map((kv: string) => kv.slice(0, kv.indexOf("=")));
  assert.deepEqual(keys, ["default_permissions", "permissions.relay.filesystem", "permissions.relay.workspace_roots", "permissions.relay.network.enabled"]);
  // Codex splits a key at every dot: no name or path is ever in one.
  for (const k of keys) assert.ok(!/claude|gemini|mcp|\/|"/.test(k), k);
  const value = (key: string) => pairs.find((kv: string) => kv.startsWith(`${key}=`))!.slice(key.length + 1);
  assert.equal(value("default_permissions"), '"relay"');
  assert.deepEqual(tomlBack(value("permissions.relay.filesystem")), p.profile!.filesystem);
  assert.deepEqual(tomlBack(value("permissions.relay.workspace_roots")), { [odd]: true });
  assert.equal(value("permissions.relay.network.enabled"), "false");
  assert.ok(value("permissions.relay.workspace_roots").includes("\\u007f") && !value("permissions.relay.workspace_roots").includes("\x7f"), "DEL escaped");
  assert.match(value("permissions.relay.filesystem"), /"\.claude"="read"/);
  // An inline table's keys are always quoted, however plain.
  assert.equal(tomlInline({ a: "b", ".c": { d: true } }), '{"a"="b",".c"={"d"=true}}');
  // A built-in profile is only selected.
  assert.deepEqual(permissionFlags(codexPermissions({ access: "write", config: appServer }, { dangerous: true, network: false, roots: [] })), ["-c", 'default_permissions=":danger-full-access"']);
  // Nothing of the legacy sandbox settings is left in a launch's flags.
  const spec = { config: withDefaults({}), target: targetDef("codex"), access: "write", cwd: "/w", relay: null } as never;
  const all = codexFlags(spec, [], {}).c.join(" ");
  assert.doesNotMatch(all, /sandbox_mode|sandbox_workspace_write/);
  assert.ok(all.includes('default_permissions="relay"'));
});

test("codex permissions: a TOML string relay writes for Codex reads back as the very string, DEL included; one TOML cannot hold is refused with a reason, before anything starts", () => {
  for (const s of ["plain", 'a.b "q" \\back', "del\x7f", "nul\u0000 bell\u0007 tab\t newline\n cr\r", "\u2028 \u202e é \u{1F600}"]) {
    assert.equal(tomlBack(toml(s)), s, JSON.stringify(s));
  }
  assert.deepEqual(tomlBack(toml(["a\x7f", "b"])), ["a\x7f", "b"]);
  assert.deepEqual(tomlBack(tomlInline({ "k\x7f": "v\x7f", n: { m: true } })), { "k\x7f": "v\x7f", n: { m: true } });
  // A lone surrogate is no Unicode scalar value: no TOML string holds it, escaped or not.
  for (const bad of ["x\ud800", ["ok", "\udfff y"]]) {
    assert.throws(() => toml(bad as never), /relay cannot give Codex "[^"]*\\ud[8f]\w\w[^"]*": it holds a lone UTF-16 surrogate, which no TOML string can hold, so relay does not start the agent\./);
  }
  // JSON's escape for one is not TOML.
  assert.throws(() => parse(`v = ${JSON.stringify("x\ud800")}`), /unicode escape/);
  // A pair is a character like any other.
  assert.equal(tomlBack(toml("\ud83d\ude00")), "\u{1F600}");
  // Refused where a turn's flags are made, so the turn fails saying why rather than Codex refusing its configuration.
  const spec = { config: withDefaults({ child_git: "native" }), target: targetDef("codex"), access: "write", cwd: "/w", relay: null, gitDirs: ["/r/.git\ud800"] } as never;
  assert.throws(() => codexFlags(spec, [], {}), /lone UTF-16 surrogate/);
});

test("codex permissions: the turn's own directory and the repository's git directory are refused at launch where Codex's sandbox cannot make them writable by their names; other control characters are not", () => {
  const spec = (cwd: string, gitDirs: string[] = []) => ({ config: withDefaults({ child_git: "native" }), target: targetDef("codex"), access: "write", cwd, relay: null, gitDirs }) as never;
  assert.throws(() => codexFlags(spec('/w "q"'), [], {}), (e: Error) => e.message.startsWith(`relay does not start the Codex agent: the turn's directory ${JSON.stringify('/w "q"')} holds a double quote`));
  for (const name of ["/w\tx", "/w\nx", "/w\rx"]) {
    assert.throws(() => codexFlags(spec(name), [], {}), (e: Error) => e.message === `relay does not start the Codex agent: the turn's directory ${JSON.stringify(name)} holds a tab or a line break, and Codex's sandbox can leave a directory so named unwritable, saying nothing.`, JSON.stringify(name));
    assert.throws(() => codexFlags(spec("/w", [`/r${name.slice(2)}/.git`]), [], {}), (e: Error) => e.message.startsWith(`relay does not start the Codex agent: the repository's git directory ${JSON.stringify(`/r${name.slice(2)}/.git`)} holds a tab or a line break`), JSON.stringify(name));
  }
  assert.throws(() => codexFlags(spec("/w", ['/r "q"/.git']), [], {}), /the repository's git directory .* holds a double quote/);
  // A read turn writes nowhere by name: its directory is not refused.
  assert.doesNotThrow(() => codexFlags({ ...(spec('/w "q"') as object), access: "read" } as never, [], {}));
  for (const name of ["/w\x1bx", "/w\x07x", "/w\x7fx"]) assert.doesNotThrow(() => codexFlags(spec(name, [`${name}/.git`]), [], {}), JSON.stringify(name));
});

test("codex permissions: a directory Codex's sandbox cannot make writable by its name is refused when it is granted to a Codex agent, saying why; other targets are not refused it", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    const quoted = path.join(path.dirname(h.home), 'with "quotes"');
    const tabbed = path.join(path.dirname(h.home), "with\ttab");
    for (const d of [quoted, tabbed]) fs.mkdirSync(d);
    const refused = await h.call("delegate", { target: "codex", task: "QUOTED", mode: "write", grant: { write_paths: [quoted] }, background: false });
    assert.match(JSON.stringify(refused), /grant\.write_paths entry \\".*with \\\\\\"quotes\\\\\\"\\" holds a double quote, and Codex's sandbox cannot be built with a directory so named writable: the agent could run no command at all\. Rename the directory, or give the work to another target\./);
    const tab = await h.call("delegate", { target: "codex", task: "TABBED", mode: "write", grant: { write_paths: [tabbed] }, background: false });
    assert.match(JSON.stringify(tab), /holds a tab or a line break, and Codex's sandbox can leave a directory so named unwritable, saying nothing/);
    assert.equal(h.starts().length, 0, "no Codex agent started");
    // Other control characters work in Codex's sandbox (the installed-Codex test below): granted.
    const escaped = path.join(path.dirname(h.home), "with\x1besc");
    fs.mkdirSync(escaped);
    const esc = await h.call("delegate", { target: "codex", task: "ESC", mode: "write", grant: { write_paths: [escaped] }, background: false });
    assert.equal(esc.status, "done", JSON.stringify(esc));
    // Relay's own sandbox passes paths as parameters, never as profile text: Claude is given it.
    const claude = await h.call("delegate", { target: "claude", task: "QUOTED", mode: "write", grant: { write_paths: [quoted] }, background: false });
    assert.equal(claude.status, "done", JSON.stringify(claude));
  } finally {
    await h.close();
  }
});

test("codex permissions: a command approval request's additionalPermissions are named in plain words, and relay vouches for the sandbox only where it read them all and the turn has one", () => {
  // As Codex 0.164.0 sends them: entries, the legacy read and write lists null beside them where a
  // special or glob entry is among them (app-server-protocol v2 permissions.rs, From<CoreFileSystemPermissions>).
  assert.deepEqual(addedPermissions({
    network: { enabled: true },
    fileSystem: { read: null, write: null, entries: [
      { path: { type: "path", path: "/w x" }, access: "write" },
      { path: { type: "path", path: "/r" }, access: "read" },
      { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
      { path: { type: "special", value: { kind: "project_roots", subpath: "build" } }, access: "write" },
      { path: { type: "special", value: { kind: "project_roots", subpath: null } }, access: "read" },
      { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
      { path: { type: "special", value: { kind: "root" } }, access: "read" },
      { path: { type: "special", value: { kind: "minimal" } }, access: "read" },
      { path: { type: "glob_pattern", pattern: "**/*.env" }, access: "deny" },
    ] },
  }), {
    words: 'write access to "/w x", its temporary directory (TMPDIR), "build" in each of its workspace roots, /tmp; read access to "/r", its workspace roots, the whole filesystem, Codex\'s minimal system paths; network access; no access to files matching "**/*.env"',
    complete: true,
  });
  // Codex goes by the entries where they are given: legacy lists beside them that say otherwise are not read.
  assert.deepEqual(addedPermissions({ fileSystem: { read: ["/x"], write: null, entries: [{ path: { type: "path", path: "/y" }, access: "read" }] } }), { words: 'read access to "/y"', complete: true });
  // The legacy lists alone, a path quoted as the agent gave it.
  assert.deepEqual(addedPermissions({ network: null, fileSystem: { read: null, write: ['/a "b"'] } }), { words: 'write access to "/a \\"b\\""', complete: true });
  // Asking for nothing.
  for (const nothing of [undefined, null, {}, { network: { enabled: false }, fileSystem: null }, { fileSystem: { entries: [] } }]) assert.equal(addedPermissions(nothing), null, JSON.stringify(nothing));
  // What relay cannot read in full: a key, a kind of path or an access it does not know, a value of the wrong type.
  for (const raw of [
    { network: { enabled: true }, macos: { preferences: "read_write" } },
    { network: { enabled: true, domains: ["example.com"] } },
    { network: { enabled: "yes" } },
    { fileSystem: { entries: [{ path: { type: "special", value: { kind: "unknown", path: ":future", subpath: null } }, access: "write" }] } },
    { fileSystem: { entries: [{ path: { type: "path", path: "/a" }, access: "execute" }] } },
    { fileSystem: { write: [1] } },
    { fileSystem: { entries: "all" } },
    { fileSystem: { write: ["/a"], other: true } },
    // A key relay does not know anywhere in an entry: on the entry, its path, or a special path's value.
    { fileSystem: { entries: [{ path: { type: "path", path: "/a" }, access: "write", futureScope: "x" }] } },
    { fileSystem: { entries: [{ path: { type: "path", path: "/a", futureScope: "x" }, access: "write" }] } },
    { fileSystem: { entries: [{ path: { type: "glob_pattern", pattern: "*.env", futureScope: "x" }, access: "deny" }] } },
    { fileSystem: { entries: [{ path: { type: "special", value: { kind: "root" }, futureScope: "x" }, access: "read" }] } },
    { fileSystem: { entries: [{ path: { type: "special", value: { kind: "tmpdir", futureScope: "x" } }, access: "write" }] } },
    { fileSystem: { entries: [{ path: { type: "special", value: { kind: "project_roots", subpath: null, futureScope: "x" } }, access: "write" }] } },
    "everything",
    ["/a"],
  ]) {
    const got = addedPermissions(raw)!;
    assert.equal(got.complete, false, JSON.stringify(raw));
    assert.equal(got.words, JSON.stringify(raw));
  }
  assert.equal(addedPermissions({ fileSystem: { write: ["/x".repeat(400)], extra: 1 } })!.words.length, 601, "clipped");

  const write = codexPermissions({ access: "write", config: appServer }, { dangerous: false, network: false, roots: [] });
  const read = codexPermissions({ access: "read", config: appServer }, { dangerous: false, network: false, roots: [] });
  const danger = codexPermissions({ access: "write", config: appServer }, { dangerous: true, network: false, roots: [] });
  const p = { command: "npm ci", cwd: "/w", reason: "needs the registry", additionalPermissions: { network: { enabled: true }, fileSystem: { read: null, write: ["/w/.cache"] } }, availableDecisions: ["accept", "cancel"] };
  const summary = 'npm ci (asks to add for this command: write access to "/w/.cache"; network access)';
  // Allowed once only, whatever its effect: never for the rest of the job (commandAsk).
  assert.deepEqual(commandAsk(p, write), { kind: "command", summary, reason: "needs the registry", detail: { cwd: "/w", command: "npm ci", once_only: true, adds_to_sandbox: true } });
  assert.deepEqual(commandAsk(p, read).detail, { cwd: "/w", command: "npm ci", once_only: true, adds_to_sandbox: true });
  assert.deepEqual(commandAsk({ ...p, kind: "command", approvalId: null }, write).detail, { cwd: "/w", command: "npm ci", once_only: true, adds_to_sandbox: true });
  // No sandbox to stay in (allow_dangerous), a retry for a blocked host, additions relay cannot read
  // in full, or a request of a kind or shape relay has not checked: the effect stays full access.
  const full = { cwd: "/w", command: "npm ci", once_only: true };
  assert.deepEqual(commandAsk(p, danger), { kind: "command", summary, reason: "needs the registry", detail: full });
  assert.deepEqual(commandAsk({ ...p, networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" } }, write).detail, full);
  assert.deepEqual(commandAsk({ ...p, additionalPermissions: { macos: {} } }, write), { kind: "command", summary: 'npm ci (asks to add for this command, in terms relay cannot read in full: {"macos":{}})', reason: "needs the registry", detail: full });
  assert.deepEqual(commandAsk({ ...p, approvalId: "sub-1" }, write).detail, full);
  assert.deepEqual(commandAsk({ ...p, kind: "subcommand" }, write).detail, full);
  // Input for a terminal already running: its permissions are those it kept, not something added.
  assert.deepEqual(commandAsk({ ...p, kind: "writeStdin", command: "write_stdin --session-id 3 y" }, write), { kind: "command", summary: "write_stdin --session-id 3 y", reason: "needs the registry", detail: { cwd: "/w" } });
  // What looks for relay's own CLI in a command reads the command alone, not what the summary adds
  // to it: added access whose words a shell could not parse is no reason to ask the person, and a
  // command that runs relay's CLI is found whatever is added to it.
  const runsRelay = (q: Record<string, unknown>) => {
    const ask = commandAsk(q, write);
    return requestRunsRelayCommand({ kind: "command", summary: ask.summary, detail_json: JSON.stringify(ask.detail) }, "/w");
  };
  assert.equal(runsRelay({ ...p, additionalPermissions: { fileSystem: { write: ['/odd "(dir'] } } }), false);
  assert.equal(runsRelay({ ...p, additionalPermissions: { macos: { x: "'" } } }), false);
  assert.equal(runsRelay({ ...p, command: "relay approve q_1" }), true);
  assert.equal(runsRelay({ ...p, command: "npm ci && relay deny q_1", additionalPermissions: { fileSystem: { write: ["/w/'"] } } }), true);
  // Without additionalPermissions: a plain request to leave the sandbox, which on a confined turn
  // stays in a sandbox denying the credential stores (escalates_restricted); on a turn without one
  // (allow_dangerous), or of a kind relay has not checked, full access as before.
  // Its value is the network the command keeps, the turn's: none here, else strict or local (codexEscalatedEffect).
  assert.deepEqual(commandAsk({ command: "ls" }, write), { kind: "command", summary: "ls", reason: undefined, detail: { escalates_restricted: "none" } });
  assert.deepEqual(commandAsk({ command: "ls" }, read).detail, { escalates_restricted: "none" });
  assert.deepEqual(commandAsk({}, write), { kind: "command", summary: "(command not given)", reason: undefined, detail: { escalates_restricted: "none" } });
  for (const mode of ["strict", "local"] as const) {
    const proxied = codexPermissions({ access: "write", config: appServer }, { dangerous: false, network: true, roots: [], net: { mode, sockets: [] } });
    assert.deepEqual(commandAsk({ command: "ls" }, proxied).detail, { escalates_restricted: mode });
  }
  const hostedOnly = codexPermissions({ access: "write", config: appServer }, { dangerous: false, network: true, roots: [], net: { mode: "hosted" } });
  assert.deepEqual(commandAsk({ command: "ls" }, hostedOnly).detail, { escalates_restricted: "none" });
  assert.match(codexEscalatedEffect("none"), /and no network \(the job's shell has none\)\. This is not full access/);
  assert.match(codexEscalatedEffect("strict"), /and the job's network only through Codex's proxy \(no loopback or local network\)/);
  assert.match(codexEscalatedEffect("local"), /loopback and the local network open, directly as well as through Codex's proxy/);
  assert.match(codexEscalatedEffect(true), /and the job's own network\./, "a request recorded before this change");
  assert.deepEqual(commandAsk({ command: "ls" }, danger).detail, {});
  for (const odd of [{ approvalId: "a" }, { kind: "subcommand" }, { networkApprovalContext: { host: "x", protocol: "https" } }]) assert.deepEqual(commandAsk({ command: "ls", ...odd }, write).detail, {}, JSON.stringify(odd));
});

test("codex permissions: config/read must report relay's profile selected and exactly as relay set it; a key another layer adds, another selection or a changed entry is refused", () => {
  const permissions = codexPermissions({ access: "write", config: appServer }, { dangerous: false, network: false, roots: ["/g"] });
  const expect = { permissions, relay: null, relayOnly: false, accountLogin: false };
  // As codex-cli 0.163.0 reports it (seen, 2026-10-22): every key it knows, the unset ones null.
  const reported = {
    description: null, extends: null, workspace_roots: { "/g": true },
    filesystem: { glob_scan_max_depth: null, ...permissions.profile!.filesystem },
    network: { enabled: false, proxy_url: null, enable_socks5: null, socks_url: null, mode: null, domains: null, unix_sockets: null, allow_local_binding: null, mitm: null },
  };
  const good = { approvals_reviewer: "user", default_permissions: "relay", permissions: { relay: reported, theirs: { filesystem: { ":root": "write" } } }, sandbox_mode: "workspace-write" };
  // Another profile of the person's own, and a legacy sandbox_mode, change nothing: relay's selection outranks them.
  assert.equal(configProblem(good, expect), null);
  const bad = (eff: Record<string, unknown>, expected: RegExp) => assert.match(String(configProblem({ ...good, ...eff }, expect)), expected);
  bad({ default_permissions: ":workspace" }, /default_permissions is ":workspace" where relay set "relay"/);
  bad({ default_permissions: null }, /default_permissions is null where relay set "relay"/);
  bad({ permissions: { relay: { ...reported, filesystem: { ...reported.filesystem, "/Users/me": "write" } } } }, /the permission profile "relay" is .*"\/Users\/me":"write"/);
  bad({ permissions: { relay: { ...reported, extends: ":workspace" } } }, /the permission profile "relay" is .*"extends":":workspace"/);
  bad({ permissions: { relay: { ...reported, network: { ...reported.network, enabled: true } } } }, /the permission profile "relay" is/);
  bad({ permissions: { relay: { ...reported, workspace_roots: { "/g": true, "/elsewhere": true } } } }, /the permission profile "relay" is/);
  bad({ permissions: null }, /the permission profile "relay" is null/);
  // The credential stores' denials: each one missing, or changed, is refused, so every turn confirms them.
  for (const key of Object.keys(deniedCredentials(undefined))) {
    const { [key]: _gone, ...without } = reported.filesystem as Record<string, unknown>;
    bad({ permissions: { relay: { ...reported, filesystem: without } } }, /the permission profile "relay" is/);
    bad({ permissions: { relay: { ...reported, filesystem: { ...reported.filesystem, [key]: "read" } } } }, /the permission profile "relay" is/);
  }
  // Built-in: only the selection is judged.
  const danger = codexPermissions({ access: "write", config: appServer }, { dangerous: true, network: false, roots: [] });
  assert.equal(configProblem({ approvals_reviewer: "user", default_permissions: ":danger-full-access" }, { ...expect, permissions: danger }), null);
});

test("codex permissions: an administrator's requirements that would make Codex use another profile or sandbox mode refuse the turn; so does not being able to read them", async () => {
  const p = codexPermissions({ access: "write", config: appServer }, { dangerous: false, network: false, roots: [] });
  const rpc = (requirements: unknown) => ({ request: async (method: string) => { assert.equal(method, "configRequirements/read"); return { supportsIndependentSpeedModes: true, requirements }; } });
  assert.equal(await requirementsProblem(rpc(null), p), null);
  assert.equal(await requirementsProblem(rpc({ allowedPermissionProfiles: { relay: true, ":read-only": true } }), p), null);
  assert.match(String(await requirementsProblem(rpc({ allowedPermissionProfiles: { ":workspace": true, ":read-only": true, relay: false } }), p)), /allow only the permission profiles ":workspace", ":read-only", not relay's "relay"/);
  assert.match(String(await requirementsProblem(rpc({ allowedPermissionProfiles: {} }), p)), /allow only the permission profiles \(none\)/);
  assert.match(String(await requirementsProblem(rpc({ allowedSandboxModes: ["read-only"] }), p)), /allow only the sandbox modes "read-only", not the "workspace-write"/);
  assert.equal(await requirementsProblem(rpc({ allowedSandboxModes: ["read-only", "workspace-write"] }), p), null);
  const broken = { request: async () => { throw new Error("method not found"); } };
  assert.match(String(await requirementsProblem(broken, p)), /could not read the requirements an administrator may have set for Codex \(method not found\)/);
});

test("codex permissions: a thread must report relay's profile as active and a sandbox of the kind, network and temporary directories relay set", () => {
  const write = codexPermissions({ access: "write", config: appServer }, { dangerous: false, network: false, roots: ["/g"] });
  // id null: a thread that reports no active profile.
  // The turn's directory: as Codex reports it, the thread's only workspace root.
  const cwd = "/w";
  const t = (sandbox: Record<string, unknown>, id: unknown = "relay", roots: unknown = [cwd]) => ({ activePermissionProfile: id === null ? undefined : { id, extends: null }, sandbox, runtimeWorkspaceRoots: roots });
  // As codex-cli 0.163.0 reports it (seen, 2026-10-22).
  const ww = { type: "workspaceWrite", writableRoots: ["/g"], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: true };
  assert.equal(threadPermissionsProblem(t(ww), write, cwd), null);
  assert.match(String(threadPermissionsProblem(t(ww, ":workspace"), write, cwd)), /runs with the permission profile ":workspace", not relay's "relay" \(an administrator's requirements can make Codex replace it\)/);
  assert.match(String(threadPermissionsProblem(t(ww, null), write, cwd)), /does not report which permission profile it runs with/);
  assert.match(String(threadPermissionsProblem(t({ ...ww, networkAccess: true }), write, cwd)), /network access true where relay set false/);
  assert.match(String(threadPermissionsProblem(t({ ...ww, excludeSlashTmp: false }), write, cwd)), /temporary directories other than the turn's own/);
  assert.match(String(threadPermissionsProblem(t({ type: "dangerFullAccess" }), write, cwd)), /reports a "dangerFullAccess" sandbox where relay set "workspaceWrite"/);
  const read = codexPermissions({ access: "read", config: appServer }, { dangerous: false, network: true, roots: [] });
  assert.equal(threadPermissionsProblem(t({ type: "readOnly", networkAccess: true }), read, cwd), null);
  assert.match(String(threadPermissionsProblem(t({ type: "readOnly", networkAccess: false }), read, cwd)), /network access false where relay set true/);
  const danger = codexPermissions({ access: "write", config: appServer }, { dangerous: true, network: false, roots: [] });
  assert.equal(threadPermissionsProblem(t({ type: "dangerFullAccess" }, ":danger-full-access"), danger, cwd), null);
  assert.match(String(threadPermissionsProblem(null, write, cwd)), /does not report which permission profile/);
  // Workspace roots: the turn's directory alone. A thread that kept another (a grant it stored under
  // relay's earlier settings, restored on resume) would have it writable under relay's profile.
  assert.match(String(threadPermissionsProblem(t(ww, "relay", [cwd, "/old/grant"]), write, cwd)), /reports the workspace roots \["\/w","\/old\/grant"\] where relay set only the turn's directory "\/w"/);
  assert.match(String(threadPermissionsProblem(t(ww, "relay", null), write, cwd)), /reports the workspace roots null/);
  assert.match(String(threadPermissionsProblem(t({ ...ww, writableRoots: ["/g", "/old/grant"] }), write, cwd)), /reports \["\/old\/grant"\] as writable, which relay did not grant this turn/);
  assert.match(String(threadPermissionsProblem(t({ type: "readOnly", networkAccess: true }, "relay", ["/elsewhere"]), read, cwd)), /reports the workspace roots \["\/elsewhere"\]/);
});

test("codex sandbox tests: the Codex RELAY_TEST_CODEX names is used, and at gates (RELAY_REQUIRE_REAL_CODEX=1) nothing else stands in for it", () => {
  let looked = 0;
  const fallback = () => { looked++; return "/opt/homebrew/bin/codex"; };
  const pinned = "/Users/x/.local/share/relay-codex-pins/versions/0.164.0-d8990e3ee7ac/bin/codex";
  // Named: the named binary, gate or not, without looking elsewhere.
  for (const gate of [{}, { RELAY_REQUIRE_REAL_CODEX: "1" }]) {
    const got = realCodexBin(fallback, { RELAY_TEST_CODEX: pinned, ...gate });
    assert.equal(got.bin, pinned);
    assert.equal(got.required, Boolean(gate.RELAY_REQUIRE_REAL_CODEX));
  }
  assert.equal(looked, 0);
  // At a gate with none named: a failure that says what to set, never PATH's or Homebrew's Codex.
  const gate = realCodexBin(fallback, { RELAY_REQUIRE_REAL_CODEX: "1" });
  assert.deepEqual([gate.bin, gate.required, looked], [null, true, 0]);
  assert.match(gate.why, /RELAY_TEST_CODEX/);
  // Outside gates: today's lookup, and a skip when it finds nothing.
  assert.deepEqual([realCodexBin(fallback, {}).bin, realCodexBin(fallback, {}).required], ["/opt/homebrew/bin/codex", false]);
  assert.equal(realCodexBin(() => null, {}).bin, null);
  // A relative name is refused rather than looked up.
  const relative = realCodexBin(fallback, { RELAY_TEST_CODEX: "codex", RELAY_REQUIRE_REAL_CODEX: "1" });
  assert.equal(relative.bin, null);
  assert.match(relative.why, /absolute/);
});

// Installed Codex's own sandbox (`codex sandbox`: the Seatbelt profile its commands run in), given
// relay's profile for each kind of turn. Codex is the one RELAY_TEST_CODEX names (gates: the pinned
// binary), or else the first on PATH, and must be 0.163.0 or later, the first with permission
// profiles. Without one these tests are skipped, saying so, unless RELAY_REQUIRE_REAL_CODEX=1, which
// makes a missing Codex a failure and takes only RELAY_TEST_CODEX's (realCodexBin). Only on macOS,
// where that sandbox is Seatbelt. Every directory they use is scratch, under the test's TMPDIR.
const MIN_CODEX = "0.163.0";
const STUBS = path.join(import.meta.dirname, "stubs");
function codexOnPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const bin = path.join(dir, "codex");
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      const real = fs.realpathSync(bin);
      if (fs.statSync(real).isFile() && !real.startsWith(STUBS + path.sep)) return bin;
    } catch {
      // Not here.
    }
  }
  return null;
}
const REAL = process.platform === "darwin" ? realCodexBin(codexOnPath) : null;
const REAL_CODEX = REAL?.bin ?? null;
const realCodex = {
  skip: !REAL ? "Codex's sandbox is Seatbelt only on macOS"
    : !REAL.bin && !REAL.required ? REAL.why.replace("no Codex found", "no codex on PATH") : false,
};
/** The installed Codex, checked: present (a failure under RELAY_REQUIRE_REAL_CODEX=1 where it is not) and recent enough. */
function installedCodex(): string {
  assert.ok(REAL_CODEX, REAL?.why);
  const r = spawnSync(REAL_CODEX, ["--version"], { encoding: "utf8", timeout: 20000 });
  const version = /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout ?? "");
  assert.ok(version, `codex --version said ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`);
  const [have, need] = [version.slice(1).map(Number), MIN_CODEX.split(".").map(Number)];
  const order = have.map((n, i) => n - need[i]).find((d) => d !== 0) ?? 0;
  assert.ok(order >= 0, `${REAL_CODEX} is codex ${version[0]}; relay's profile needs ${MIN_CODEX} or later`);
  return REAL_CODEX;
}

/** A scratch tree for one test, under the test's TMPDIR: a home for Codex and the turn's own TMPDIR, and the directories named. */
function sandboxTree(...names: string[]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-sandbox-")));
  const dirs = Object.fromEntries(names.map((n) => [n, path.join(root, n)]));
  const home = path.join(root, "home"), own = path.join(root, "tmp");
  for (const d of [...Object.values(dirs), path.join(home, ".codex"), own]) fs.mkdirSync(d, { recursive: true });
  const env = scratchEnv({ PATH: process.env.PATH, HOME: home, CODEX_HOME: path.join(home, ".codex"), TMPDIR: own, GIT_CONFIG_NOSYSTEM: "1" });
  return { root, dirs, own, env, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * One thing a probe tries inside the sandbox: write a file (its directory made first), remove one,
 * rename one, connect to a port on 127.0.0.1, or run a program.
 */
type Probe = { write: string } | { unlink: string } | { rename: [string, string] } | { connect: number } | { unix: string } | { listenUnix: string } | { viaProxy: number } | { run: string[]; cwd?: string };
const PROBE = `
const fs = require("fs"), path = require("path"), net = require("net"), cp = require("child_process");
const reach = (port) => new Promise((ok, no) => {
  const s = net.connect(port, "127.0.0.1", () => { s.destroy(); ok(); });
  s.on("error", no);
  setTimeout(() => { s.destroy(); no(new Error("timed out")); }, 5000).unref();
});
const unix = (p) => new Promise((ok, no) => {
  const s = net.connect(p, () => { s.destroy(); ok(); });
  s.on("error", no);
  setTimeout(() => { s.destroy(); no(new Error("timed out")); }, 5000).unref();
});
const listenUnix = (p) => new Promise((ok, no) => {
  try { fs.unlinkSync(p); } catch {}
  const srv = net.createServer().listen(p, () => { srv.close(); ok(); });
  srv.on("error", no);
});
// A request for 127.0.0.1:port through the proxy Codex gives the command: worked if the test's server answered 200.
const viaProxy = (port) => new Promise((ok, no) => {
  if (!process.env.HTTP_PROXY) return no(new Error("no proxy"));
  const u = new URL(process.env.HTTP_PROXY);
  const s = net.connect(+u.port, u.hostname, () => s.write("GET http://127.0.0.1:" + port + "/ HTTP/1.1\\r\\nHost: 127.0.0.1:" + port + "\\r\\nConnection: close\\r\\n\\r\\n"));
  // Decided on the status line: the proxy may keep the connection open.
  let b = "";
  const decide = () => { s.destroy(); return /^HTTP\\/1\\.1 200/.test(b) ? ok() : no(new Error(b.split("\\r\\n")[0] || "no answer")); };
  s.on("data", (d) => { b += d; if (b.includes("\\r\\n")) decide(); }); s.on("end", decide);
  s.on("error", no);
  setTimeout(() => { s.destroy(); no(new Error("timed out")); }, 8000).unref();
});
(async () => {
  const out = [];
  for (const o of JSON.parse(process.argv[1])) {
    try {
      if (o.write) { fs.mkdirSync(path.dirname(o.write), { recursive: true }); fs.writeFileSync(o.write, "scratch", { flag: "a" }); }
      else if (o.unlink) fs.unlinkSync(o.unlink);
      else if (o.rename) fs.renameSync(o.rename[0], o.rename[1]);
      else if (o.connect) await reach(o.connect);
      else if (o.unix) await unix(o.unix);
      else if (o.listenUnix) await listenUnix(o.listenUnix);
      else if (o.viaProxy) await viaProxy(o.viaProxy);
      else if (o.run) cp.execFileSync(o.run[0], o.run.slice(1), { cwd: o.cwd, stdio: "pipe" });
      out.push(true);
    } catch (e) { out.push(String(e.code ?? e.stderr ?? e.message).slice(0, 300)); }
  }
  console.log(JSON.stringify(out));
})();`;

/**
 * Runs each probe in installed Codex's sandbox for `p`, from `cwd`, and checks which worked against
 * `cases` ([probe, expected]); the message lists every case, + for one that should work.
 */
function expectInSandbox(codex: string, p: CodexPermissions, cwd: string, env: NodeJS.ProcessEnv, cases: [Probe, boolean][]): void {
  // A profile whose network goes through Codex's proxy needs the feature on, as codexFlags sets it.
  const flags = [...permissionFlags(p), ...(p.proxy ? ["-c", "features.network_proxy=true"] : [])];
  const r = spawnSync(codex, ["sandbox", ...flags, "--", process.execPath, "-e", PROBE, JSON.stringify(cases.map(([probe]) => probe))], { cwd, env, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout) as (true | string)[];
  assert.deepEqual(got.map((g) => g === true), cases.map(([, ok]) => ok), cases.map(([probe, ok], i) => `${ok ? "+" : "-"} ${JSON.stringify(probe)}: ${got[i]}`).join("\n"));
}

/** relay's profile for a turn of this access and network, with these workspace roots (the granted directories), and the network mode and socket directories asked for. */
const profileFor = (access: "read" | "write", network: boolean, roots: string[] = [], net?: { mode: "strict" | "local" | "hosted"; sockets?: string[] }) =>
  codexPermissions({ access, config: withDefaults({}) } as never, { dangerous: false, network, roots, ...(net ? { net } : {}) });

test("codex sandbox (installed Codex): a write turn writes its worktree, grants and own TMPDIR, but not harness configuration at their top, nor .git, /tmp or elsewhere; a read turn writes nothing", realCodex, () => {
  const codex = installedCodex();
  const t = sandboxTree("wt", "grant", "outside");
  const { wt, grant, outside } = t.dirs;
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: wt, env: t.env }).status, 0);
    expectInSandbox(codex, profileFor("write", false, [grant]), wt, t.env, [
      [{ write: path.join(wt, "ok.txt") }, true],
      [{ write: path.join(wt, "sub", ".claude", "deeper-is-not-covered") }, true],
      [{ write: path.join(grant, "ok.txt") }, true],
      [{ write: path.join(t.own, "ok.txt") }, true],
      [{ write: path.join(wt, ".claude", "settings.json") }, false],
      [{ write: path.join(wt, ".gemini", "x") }, false],
      [{ write: path.join(wt, ".mcp.json") }, false],
      [{ write: path.join(wt, ".codex", "config.toml") }, false],
      [{ write: path.join(wt, ".agents", "skills", "x") }, false],
      [{ write: path.join(wt, ".git", "config") }, false],
      [{ write: path.join(grant, ".claude", "settings.json") }, false],
      [{ write: path.join(grant, ".gemini", "x") }, false],
      [{ write: path.join(outside, "x") }, false],
      [{ write: `/tmp/relay-codex-profile-probe-${process.pid}` }, false],
    ]);
    assert.equal(fs.existsSync(path.join(wt, ".claude", "settings.json")) || fs.existsSync(path.join(wt, ".gemini")), false);
    expectInSandbox(codex, profileFor("read", false), wt, t.env, [
      [{ write: path.join(wt, "read.txt") }, false],
      [{ write: path.join(t.own, "read.txt") }, false],
      [{ write: path.join(grant, "read.txt") }, false],
    ]);
  } finally { t.done(); }
});

test("codex sandbox (installed Codex): harness configuration that already exists in a grant or the worktree cannot be removed, renamed or replaced, and a name in another case is the same name", realCodex, () => {
  const codex = installedCodex();
  const t = sandboxTree("wt", "grant");
  const { wt, grant } = t.dirs;
  try {
    for (const top of [wt, grant]) {
      fs.mkdirSync(path.join(top, ".claude"));
      fs.writeFileSync(path.join(top, ".claude", "settings.json"), "{}");
      fs.writeFileSync(path.join(top, ".mcp.json"), "{}");
    }
    const cases: [Probe, boolean][] = [];
    for (const top of [wt, grant]) {
      cases.push(
        [{ unlink: path.join(top, ".mcp.json") }, false],
        [{ unlink: path.join(top, ".claude", "settings.json") }, false],
        [{ rename: [path.join(top, ".claude"), path.join(top, "claude-moved")] }, false],
        [{ rename: [path.join(top, ".mcp.json"), path.join(top, "mcp-moved.json")] }, false],
        [{ rename: [path.join(top, ".claude", "settings.json"), path.join(top, "settings-moved.json")] }, false],
        [{ write: path.join(top, ".claude", "settings.json") }, false],
        // A file of the agent's own, put in place of the existing one.
        [{ write: path.join(top, "planted.json") }, true],
        [{ rename: [path.join(top, "planted.json"), path.join(top, ".mcp.json")] }, false],
        [{ rename: [path.join(top, "planted.json"), path.join(top, ".MCP.json")] }, false],
        // macOS's default disks do not tell names apart by case: these are the same files.
        [{ write: path.join(top, ".Claude", "settings.json") }, false],
        [{ write: path.join(top, ".CLAUDE", "settings.local.json") }, false],
        [{ write: path.join(top, ".MCP.json") }, false],
        [{ unlink: path.join(top, ".MCP.json") }, false],
        [{ rename: [path.join(top, ".Claude"), path.join(top, "claude-moved-2")] }, false],
      );
    }
    expectInSandbox(codex, profileFor("write", false, [grant]), wt, t.env, cases);
    for (const top of [wt, grant]) {
      assert.equal(fs.readFileSync(path.join(top, ".claude", "settings.json"), "utf8"), "{}");
      assert.equal(fs.readFileSync(path.join(top, ".mcp.json"), "utf8"), "{}");
      assert.deepEqual(fs.readdirSync(top).sort(), [".claude", ".mcp.json", "planted.json"]);
      assert.deepEqual(fs.readdirSync(path.join(top, ".claude")), ["settings.json"]);
    }
  } finally { t.done(); }
});

test("codex sandbox (installed Codex): a network grant reaches only the network through Codex's proxy; loopback and Unix sockets outside the turn's own places stay closed, unless local mode opens loopback", realCodex, async () => {
  const codex = installedCodex();
  const t = sandboxTree("wt", "outside");
  const { wt, outside } = t.dirs;
  // A port of the test's own on 127.0.0.1, answering HTTP from a process of its own (this one waits
  // on the sandbox, synchronously); and a Unix socket of its own outside the turn's places.
  const server = spawn(process.execPath, ["-e", 'const s=require("http").createServer((q,r)=>r.end("ok")).listen(0,"127.0.0.1",()=>console.log(s.address().port))'], { stdio: ["ignore", "pipe", "inherit"] });
  const sock = path.join(outside, "s.sock");
  const unixServer = net.createServer((s) => s.destroy()).listen(sock);
  try {
    const port = await new Promise<number>((resolve) => server.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
    const sockets = [t.own, wt];
    // No grant: no network.
    expectInSandbox(codex, profileFor("write", false), wt, t.env, [[{ connect: port }, false], [{ unix: sock }, false], [{ write: path.join(wt, "w.txt") }, true]]);
    // Strict: Seatbelt refuses loopback and the outside socket, the proxy refuses loopback, and
    // sockets work only in the turn's TMPDIR and worktree.
    expectInSandbox(codex, profileFor("write", true, [], { mode: "strict", sockets }), wt, t.env, [
      [{ connect: port }, false], [{ viaProxy: port }, false], [{ unix: sock }, false],
      [{ listenUnix: path.join(t.own, "a.sock") }, true], [{ listenUnix: path.join(wt, "b.sock") }, true], [{ listenUnix: path.join(outside, "c.sock") }, false],
      [{ write: path.join(wt, "w.txt") }, true],
    ]);
    // Local: loopback opens, directly and through the proxy; sockets elsewhere stay closed.
    expectInSandbox(codex, profileFor("write", true, [], { mode: "local", sockets }), wt, t.env, [
      [{ connect: port }, true], [{ viaProxy: port }, true], [{ unix: sock }, false], [{ listenUnix: path.join(t.own, "d.sock") }, true],
    ]);
    // A read turn with the network: strict, no Unix sockets at all, and it still writes nothing.
    expectInSandbox(codex, profileFor("read", true), wt, t.env, [[{ connect: port }, false], [{ viaProxy: port }, false], [{ listenUnix: path.join(t.own, "e.sock") }, false], [{ write: path.join(wt, "r.txt") }, false]]);
    expectInSandbox(codex, profileFor("read", false), wt, t.env, [[{ connect: port }, false]]);
  } finally {
    server.kill();
    unixServer.close();
    t.done();
  }
});

/**
 * One turn of installed Codex's app server, model-free: a scratch CODEX_HOME whose provider is a fake
 * Responses API on loopback that asks for one exec_command, then ends. Returns once the turn completes.
 */
async function oneCommandTurn(codex: string, o: { home: string; cwd: string; tmp: string; flags: string[]; cmd: string; args?: Record<string, unknown>; policy?: string }): Promise<string[]> {
  const http = await import("node:http");
  const { spawn } = await import("node:child_process");
  const log: string[] = [];
  const sse = (evs: Record<string, unknown>[]) => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const done = { type: "response.completed", response: { id: "r", usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } };
  const server = http.createServer((q, res) => {
    let b = "";
    q.on("data", (d) => (b += d));
    q.on("end", () => {
      if (q.method !== "POST" || !q.url?.includes("/responses")) { res.writeHead(404); res.end("{}"); return; }
      const outs = (JSON.parse(b).input ?? []).filter((i: { type?: string }) => i.type === "function_call_output");
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!outs.length) res.end(sse([{ type: "response.created", response: { id: "r1" } }, { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: o.cmd, login: false, timeout_ms: 10000, ...o.args }) } }, done]));
      else {
        log.push(...outs.map((x: { output?: unknown }) => String(x.output)));
        res.end(sse([{ type: "response.created", response: { id: "r2" } }, { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "m1", content: [{ type: "output_text", text: "done" }] } }, done]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  fs.writeFileSync(path.join(o.home, "config.toml"), `model = "mock-model"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const child = spawn(codex, ["app-server", ...o.flags], { cwd: o.cwd, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? os.homedir(), CODEX_HOME: o.home, TMPDIR: o.tmp, SHELL: "/bin/zsh" }, stdio: ["pipe", "pipe", "ignore"] });
  try {
    let id = 0, buf = "";
    const pending = new Map<number, (m: Record<string, any>) => void>();
    let completed!: () => void;
    const turnDone = new Promise<void>((resolve) => (completed = resolve));
    const req = (method: string, params: unknown) => new Promise<Record<string, any>>((resolve) => { const i = ++id; pending.set(i, resolve); child.stdin!.write(JSON.stringify({ id: i, method, params }) + "\n"); });
    child.stdout!.on("data", (d) => {
      buf += d;
      for (let n; (n = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, n); buf = buf.slice(n + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); continue; }
        // Asked for anything (none is expected under approval policy never): declined.
        if (m.method && m.id !== undefined) { log.push(`request ${m.method}`); child.stdin!.write(JSON.stringify({ id: m.id, result: { decision: "decline" } }) + "\n"); continue; }
        if (m.method === "turn/completed") completed();
      }
    });
    await req("initialize", { clientInfo: { name: "relay-test", title: "relay-test", version: "0" }, capabilities: { experimentalApi: true } });
    child.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
    const t = await req("thread/start", { cwd: o.cwd, runtimeWorkspaceRoots: [o.cwd], permissions: CODEX_PROFILE, approvalPolicy: o.policy ?? "never", approvalsReviewer: "user", ephemeral: true });
    assert.ok(t.result?.thread?.id, JSON.stringify(t));
    await req("turn/start", { threadId: t.result.thread.id, input: [{ type: "text", text: "go", text_elements: [] }] });
    await Promise.race([turnDone, new Promise((_, reject) => setTimeout(() => reject(new Error(`no turn/completed: ${log.join(" | ")}`)), 45000))]);
    return log;
  } finally {
    child.kill("SIGKILL");
    server.close();
  }
}

test("codex sandbox (installed Codex): a command an exec-policy rule allows runs sandboxed under relay's profile, whose credential denials keep every command in the sandbox; without them (the control) it would leave it", realCodex, async () => {
  const codex = installedCodex();
  for (const [denials, leaves] of [[true, false], [false, true]] as const) {
    const t = sandboxTree("wt", "outside");
    try {
      const home = path.join(t.root, "home", ".codex");
      fs.mkdirSync(path.join(home, "rules"), { recursive: true });
      // As a user's own rules file would hold it: touch allowed without asking.
      fs.writeFileSync(path.join(home, "rules", "default.rules"), 'prefix_rule(pattern=["touch"], decision="allow")\n');
      const p = codexPermissions({ access: "read", config: withDefaults({}) } as never, { dangerous: false, network: false, roots: [], codexHome: home });
      if (!denials) for (const k of Object.keys(p.profile!.filesystem)) if (p.profile!.filesystem[k] === "deny") delete p.profile!.filesystem[k];
      const proof = path.join(t.dirs.outside, "proof");
      const log = await oneCommandTurn(codex, { home, cwd: t.dirs.wt, tmp: t.own, flags: [...permissionFlags(p), "-c", 'approvals_reviewer="user"'], cmd: `touch ${proof}` });
      assert.equal(fs.existsSync(proof), leaves, `${denials ? "relay's profile" : "control"}: ${log.join(" | ")}`);
      assert.ok(!log.some((l) => l.startsWith("request ")), "nothing was asked");
    } finally { t.done(); }
  }
});

test("codex sandbox (installed Codex): relay pins exec_permission_approvals off, so a command an exec-policy rule allows cannot add the network to its sandbox without asking; with it on (the control) it reaches loopback", realCodex, async () => {
  const codex = installedCodex();
  // A loopback port of the test's own; this process stays free to accept while Codex runs.
  let reached = 0;
  const server = net.createServer((c) => { reached++; c.end("PONG\n"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    for (const [pinned, reaches] of [[true, false], [false, true]] as const) {
      const t = sandboxTree("wt");
      try {
        const home = path.join(t.root, "home", ".codex");
        fs.mkdirSync(path.join(home, "rules"), { recursive: true });
        fs.writeFileSync(path.join(home, "rules", "default.rules"), 'prefix_rule(pattern=["curl"], decision="allow")\n');
        // A confined write turn without the network, as relay sets it.
        const p = codexPermissions({ access: "write", config: withDefaults({}) } as never, { dangerous: false, network: false, roots: [], codexHome: home });
        const flags = [...permissionFlags(p), "-c", 'approvals_reviewer="user"', "-c", "features.request_permissions_tool=false", "-c", `features.exec_permission_approvals=${!pinned}`];
        const before = reached;
        const log = await oneCommandTurn(codex, {
          home, cwd: t.dirs.wt, tmp: t.own, flags, policy: "on-request", cmd: `curl -sS -m 3 http://127.0.0.1:${port}/`,
          args: { sandbox_permissions: "with_additional_permissions", justification: "probe", additional_permissions: { network: { enabled: true } } },
        });
        assert.equal(reached > before, reaches, `${pinned ? "relay's pin" : "control"}: ${log.join(" | ")}`);
        assert.ok(!log.some((l) => l.startsWith("request ")), "nothing was asked either way");
        if (pinned) assert.ok(log.some((l) => /additional permissions are disabled/.test(l)), log.join(" | "));
      } finally { t.done(); }
    }
  } finally {
    server.close();
  }
});

test("codex sandbox (installed Codex): under child_git \"native\" the worktree's git directories are workspace roots and git commit works; otherwise it cannot", realCodex, () => {
  const codex = installedCodex();
  const t = sandboxTree("repo");
  const repo = t.dirs.repo, wt = path.join(t.root, "wt");
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=relay-test", "-c", "user.email=relay-test@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, env: t.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-qm", "first");
    git(repo, "worktree", "add", "-q", "-b", "lane", wt);
    // As a job's worktree gives them (session.ts): the repository's common git directory and the worktree's own.
    const gitDirs = [fs.realpathSync(git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir")), git(wt, "rev-parse", "--absolute-git-dir")];
    assert.deepEqual(gitDirs, [path.join(repo, ".git"), path.join(repo, ".git", "worktrees", "wt")]);
    const flags = (childGit: "native" | "relay") => codexFlags({ config: withDefaults({ child_git: childGit }), target: targetDef("codex"), access: "write", cwd: wt, relay: null, gitDirs } as never, [], {});
    const native = flags("native").expect.permissions, relayGit = flags("relay").expect.permissions;
    assert.deepEqual(native.profile!.workspace_roots, Object.fromEntries(gitDirs.map((d) => [d, true])));
    assert.equal("workspace_roots" in relayGit.profile!, false);
    fs.writeFileSync(path.join(wt, "b.txt"), "b");
    const commit = (message: string): Probe[] => [
      { run: ["git", "-c", "user.name=relay-test", "-c", "user.email=relay-test@localhost", "-c", "commit.gpgsign=false", "add", "b.txt"], cwd: wt },
      { run: ["git", "-c", "user.name=relay-test", "-c", "user.email=relay-test@localhost", "-c", "commit.gpgsign=false", "commit", "-qm", message], cwd: wt },
    ];
    // child_git "relay": git's own files are outside the sandbox, and relay commits for the agent.
    expectInSandbox(codex, relayGit, wt, t.env, commit("refused").map((probe) => [probe, false]));
    expectInSandbox(codex, native, wt, t.env, [...commit("by the agent").map((probe): [Probe, boolean] => [probe, true]),
      // Its .git pointer at the top of the worktree stays read-only.
      [{ write: path.join(wt, ".git") }, false]]);
    assert.equal(git(repo, "log", "--format=%s", "lane"), "by the agent\nfirst");
  } finally { t.done(); }
});

test("codex sandbox (installed Codex): a granted directory whose name holds a dot, a backslash and DEL is the workspace root Codex is given; DEL unescaped, Codex refuses the value, and a double quote, which TOML carries, breaks Codex's sandbox", realCodex, () => {
  const codex = installedCodex();
  const t = sandboxTree("wt");
  const { wt } = t.dirs;
  const odd = path.join(t.root, "a.b \\back\x7fslash");
  // The same name without DEL, beside it: what a mangled name could have reached instead.
  const near = path.join(t.root, "a.b \\backslash");
  const quoted = path.join(t.root, 'a.b "q" \\back');
  const run = (flags: string[]) => spawnSync(codex, ["sandbox", ...flags, "--", "/usr/bin/true"], { cwd: wt, env: t.env, encoding: "utf8", timeout: 20000 });
  try {
    for (const d of [odd, near, quoted]) fs.mkdirSync(d);
    const p = profileFor("write", false, [odd]);
    assert.ok(permissionFlags(p).some((f: string) => f.includes("\\u007f")));
    expectInSandbox(codex, p, wt, t.env, [
      [{ write: path.join(odd, "ok.txt") }, true],
      [{ write: path.join(odd, ".claude", "settings.json") }, false],
      [{ write: path.join(odd, ".MCP.json") }, false],
      [{ write: path.join(near, "x") }, false],
    ]);
    assert.equal(fs.readFileSync(path.join(odd, "ok.txt"), "utf8"), "scratch");
    // DEL left as JSON leaves it (relay 1.0.0): no TOML, so Codex takes the text for a string, which is no table, and does not start.
    const unescaped = run(permissionFlags(p).map((f: string) => f.replaceAll("\\u007f", "\x7f")));
    assert.notEqual(unescaped.status, 0, "Codex took DEL unescaped in a TOML string");
    // A double quote: the TOML relay writes holds it, but Codex's Seatbelt profile does not compile
    // with it (codexWriteRootProblem), and no command runs.
    const q = permissionFlags(profileFor("write", false, [quoted]));
    assert.deepEqual(tomlBack(q[q.findIndex((f: string) => f.startsWith("permissions.relay.workspace_roots="))].slice("permissions.relay.workspace_roots=".length)), { [quoted]: true });
    const broken = run(q);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /sandbox-exec: unbound variable/);
    // So relay refuses it before Codex starts: when it is granted (admitWork), and again at launch.
    const spec = (grant: string) => ({ config: withDefaults({}), target: targetDef("codex"), access: "write", cwd: wt, relay: null, grant: { write_paths: [grant], write_path_pins: [dirIdentity(grant)] } }) as never;
    assert.throws(() => codexFlags(spec(quoted), [], {}), (e: Error) => e.message.startsWith(`relay does not start the Codex agent: the granted directory ${JSON.stringify(quoted)} holds a double quote, and Codex's sandbox cannot be built`));
    assert.doesNotThrow(() => codexFlags(spec(odd), [], {}));
  } finally { t.done(); }
});

test("codex sandbox (installed Codex): a granted directory whose name holds a tab, a line feed or a carriage return stays unwritable, saying nothing, which is why relay refuses it; one holding another control character is writable, the names at its top read-only", realCodex, () => {
  const codex = installedCodex();
  const t = sandboxTree("wt");
  const { wt } = t.dirs;
  try {
    for (const [name, writable] of [["tab\tx", false], ["lf\nx", false], ["cr\rx", false], ["esc\x1bx", true], ["bel\x07x", true]] as const) {
      const dir = path.join(t.root, name);
      fs.mkdirSync(dir);
      expectInSandbox(codex, profileFor("write", false, [dir]), wt, t.env, [
        [{ write: path.join(dir, "ok.txt") }, writable],
        [{ write: path.join(dir, ".claude", "settings.json") }, false],
      ]);
      assert.equal(codexWriteRootProblem(dir) === null, writable, JSON.stringify(name));
    }
  } finally { t.done(); }
});

test("codex permissions: a resumed thread is told its workspace roots, so a grant taken away on resume does not stay writable through roots the thread stored", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    // Two granted directories; a grant on resume replaces the job's, and this one leaves the first out.
    const [grant, kept] = ["granted", "kept"].map((n) => path.join(path.dirname(h.home), n));
    for (const d of [grant, kept]) fs.mkdirSync(d);
    const job = await h.call("delegate", { target: "codex", task: "FIRST", mode: "write", grant: { write_paths: [grant, kept] }, background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const first = h.starts().at(-1)!;
    // Told on start: its workspace roots are its directory alone; the grant is a root of relay's profile.
    assert.deepEqual(first.thread.runtimeWorkspaceRoots, [first.thread.cwd]);
    assert.ok(first.argv.join(" ").includes(`permissions.relay.workspace_roots={${JSON.stringify(grant)}=true,${JSON.stringify(kept)}=true}`));
    // A thread started under relay's earlier settings stored its grants among its workspace roots.
    const file = path.join(h.env.STUB_DIR, "sessions", `codex-${first.sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), roots: [first.thread.cwd, grant] }));
    // Resumed with the grant taken away: relay names the roots again, and Codex no longer has the grant as writable.
    await h.call("resume", { job_id: job.job_id, message: "SECOND", grant: { write_paths: [kept] } });
    assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
    const second = h.starts().at(-1)!;
    assert.equal(second.resumed, true);
    assert.deepEqual(second.thread.runtimeWorkspaceRoots, [second.thread.cwd]);
    assert.ok(second.argv.join(" ").includes(`permissions.relay.workspace_roots={${JSON.stringify(kept)}=true}`));
    assert.deepEqual(second.thread.sandboxWritable, [kept], "of the granted directories only the one still granted is writable");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).roots, [second.thread.cwd], "the stored grant is gone from the thread's roots");
    // A server that kept the stored roots instead: refused before the turn runs.
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), roots: [second.thread.cwd, grant] }));
    fs.writeFileSync(path.join(h.env.STUB_DIR, "codex-ignore-roots"), "");
    await h.call("resume", { job_id: job.job_id, message: "THIRD", grant: { write_paths: [kept] } });
    const third = await h.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(third.status, "failed", JSON.stringify(third));
    assert.match(third.error, new RegExp(`its thread reports the workspace roots .*${grant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.* where relay set only the turn's directory`));
    assert.equal(h.starts().length, 2, "no third turn ran");
  } finally {
    await h.close();
  }
});

// Qualification item 33 (host only, RELAY_TEST_KEYCHAIN_LIVE=1): the keychain under relay's native
// Codex profile with the never floor, stage 2 off. A command asks the security daemons for a decoy
// keychain's item, network off and on, in two turns each. Floored: the decoy's directory is in
// never.paths, as ~/Library/Keychains is in the floor, so the item must be refused whatever the
// keychain IPC, since reading an item in a file-based keychain needs its file as well as the daemons.
// Control: the same floor without that entry, which must match what doctor documents
// (core/never-coverage.ts neverKeychainIpc): Codex's base profile closed, its network profile open
// (com.apple.SecurityServer). Only the network-on pair is a causal control: its control retrieves
// the item, so the floored refusal there comes from the file deny and not from a broken command.
// Network off, the documented IPC is closed and the control is refused too, so that pair only
// observes that the refusal is consistent with the documented IPC; it says nothing about the file
// deny. (The positive control outside any sandbox and the exit marker still show that security ran.)
// Teardown goes through withTeardown (keychain-decoy.ts): a failing decoy cleanup still removes the
// scratch tree, and the test's own failure is kept beside it.
for (const network of [false, true]) for (const floored of [true, false]) test(`keychain decoy live (codex, network ${network ? "on" : "off"}, ${floored ? "floored" : network ? "causal control without the file deny" : "consistency check without the file deny"}): ${floored ? "a floored native Codex command cannot retrieve a decoy keychain item in a never path, whatever the keychain IPC" : network ? "without that never path, retrieving the decoy item matches the documented (open) keychain IPC, so the floored refusal is the file deny's" : "without that never path, the refusal matches the documented (closed) keychain IPC; no evidence about the file deny"}`, { skip: keychainSkip || realCodex.skip }, (ctx) => {
  const codex = installedCodex();
  const t = sandboxTree("wt");
  let decoy: DecoyKeychain | undefined;
  return withTeardown(() => {
    decoy = decoyKeychain(path.join(t.root, "keychains"));
    const outside = spawnSync(decoy.command[0], decoy.command.slice(1), { encoding: "utf8", timeout: 30000 });
    assert.ok(retrieved(decoy, outside.stdout), `positive control outside any sandbox: ${outside.stderr}`);
    // The same floor either way (the built-ins, keychain files among them); only the decoy's entry differs.
    const floor = resolveNeverPolicy({ home: t.env.HOME!, never: { paths: floored ? [{ path: decoy.dir }] : [] } });
    const cfg = withDefaults({ targets: { codex: { stage2: false } } });
    const p = codexPermissions({ access: "write", config: cfg, neverPolicy: floor } as never, { dangerous: false, network, roots: [], ...(network ? { net: { mode: "strict" as const, sockets: [t.own, t.dirs.wt] } } : {}) });
    const flags = [...permissionFlags(p), ...(p.proxy ? ["-c", "features.network_proxy=true"] : [])];
    assert.equal(flags.join("\n").includes(decoy.dir), floored, floored ? "the profile denies the decoy's directory" : "the control's profile does not name the decoy's directory");
    // Wrapped in sh with an exit marker: a refusal counts only if security ran inside the sandbox.
    const r = spawnSync(codex, ["sandbox", ...flags, "--", "/bin/sh", "-c", wrapped(decoy)], { cwd: t.dirs.wt, env: t.env, encoding: "utf8", timeout: 60000 });
    const why = `status ${r.status}, signal ${r.signal}, error ${r.error}, stderr ${JSON.stringify((r.stderr ?? "").replaceAll(decoy.secret, "<secret>").slice(-400))}`;
    assert.ok(!r.error && !r.signal && r.status === 0, `codex sandbox did not run the attempt to completion (launch failure, timeout or signal): ${why}`);
    const observed = attempt(decoy, r.stdout ?? "");
    const documented = neverKeychainIpc("codex", cfg, {})!;
    const ipc = network ? documented.networkOn : documented.networkOff;
    const expected = floored ? "refused" : ipc === "open" ? "retrieved" : "refused";
    const role = floored ? "floored" : ipc === "open" ? "causal control" : "consistency check (closed IPC refuses either way)";
    ctx.diagnostic(`keychain decoy (codex, network ${network ? "on" : "off"}, ${role}): ${observed}; documented keychain IPC ${ipc}; expected ${expected}`);
    assert.equal(observed, expected, `${role}, documented keychain IPC ${ipc}; ${why}`);
  }, [
    // The decoy first: its directory is inside the scratch tree, and HOME is unchanged here.
    ["decoy cleanup", () => decoy?.cleanup()],
    ["scratch tree", () => t.done()],
  ]);
});
