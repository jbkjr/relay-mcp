import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import "./helpers.ts";
import { ConfigSchema, withDefaults, loadConfig } from "../dist/core/config.js";
import { effectiveChildEnv, selectEnvironment, runtimeEnvironment, validatedProxy, BACKEND_ENVIRONMENT_SCRUBS } from "../dist/core/env-policy.js";
import { childEnv, agentEnv } from "../dist/backends/env.js";
import { targetDef, TARGET_IDS } from "../dist/targets/index.js";
import { redact, registerReleasedEnvironment, withTurnSecrets, recognizedSecretShape } from "../dist/core/secrets.js";

const canaries = { AWS_SECRET_ACCESS_KEY: "cloud-canary-739182", NPM_TOKEN: "registry-canary-739182", GH_TOKEN: "vcs-canary-739182", CI_JOB_TOKEN: "ci-canary-739182", DATABASE_URL: "postgres://person:canary@invalid/db", SSH_AUTH_SOCK: "/synthetic/ssh.sock", NEUTRAL_ALIAS: "opaque-739182-azQp", npm_config__authToken: "npm-mixed-case-739182" };

test("tool env policy: strict schema, exact names, reserved controls and unsupported policy", () => {
  for (const setting of [{ policy: "tool-denylist" }, { policy: false }, { unknown: [] }, { pass: "NPM_TOKEN" }, { request: ["NPM_*"] }, { drop: ["A-B"] }, { pass: ["9BAD"] }, { pass: ["RELAY_NODE_ID"] }, { request: ["HOME"] }, { drop: ["TMPDIR"] }, { pass: ["NODE_OPTIONS"] }]) {
    assert.equal(ConfigSchema.safeParse({ child_env: setting }).success, false, JSON.stringify(setting));
  }
  const unavailable = ConfigSchema.safeParse({ child_env: { policy: "tool-denylist" } });
  assert.equal(unavailable.success, false);
  if (!unavailable.success) assert.match(unavailable.error.message, /not available yet/);
  assert.equal(ConfigSchema.safeParse({ targets: { codex: { child_env: { request: ["GH_TOKEN"] } } } }).success, true);
  assert.equal(ConfigSchema.safeParse({ targets: { copilot: { child_env: { request: ["GH_TOKEN"] } } } }).success, false);
  assert.equal(ConfigSchema.safeParse({ targets: { codex: { child_auth: "any", child_env: { pass: ["OPENAI_API_KEY"] } } } }).success, true);
  assert.equal(ConfigSchema.safeParse({ targets: { claude: { child_auth: "any", child_env: { pass: ["OPENAI_API_KEY"] } } } }).success, false);
});

test("tool env policy: inheritance unions lists, target overrides policy, drop veto and empty values", () => {
  const cfg = withDefaults({ child_env: { policy: "legacy", pass: ["JAVA_HOME", "EMPTY"], drop: ["NPM_TOKEN"], request: ["NEUTRAL_ALIAS"] }, targets: { codex: { child_env: { policy: "allowlist", pass: ["JAVA_HOME", "NPM_TOKEN"], drop: [], request: [] } } } });
  assert.deepEqual(effectiveChildEnv(cfg, "codex"), { policy: "allowlist", pass: ["JAVA_HOME", "EMPTY", "NPM_TOKEN"], drop: ["NPM_TOKEN"], request: ["NEUTRAL_ALIAS"] });
  const selected = selectEnvironment("codex", cfg, { PATH: "/usr/bin", LANG: "C", HOME: "/synthetic/home", JAVA_HOME: "/java", EMPTY: "", ABSENT: undefined, ...canaries }, ["NEUTRAL_ALIAS"]);
  assert.equal(selected.env.EMPTY, ""); assert.equal(selected.env.ABSENT, undefined);
  assert.equal(selected.env.JAVA_HOME, "/java"); assert.equal(selected.env.NPM_TOKEN, undefined);
  assert.equal(selected.env.NEUTRAL_ALIAS, canaries.NEUTRAL_ALIAS);
  assert.equal(selectEnvironment("claude", cfg, canaries).env.AWS_SECRET_ACCESS_KEY, canaries.AWS_SECRET_ACCESS_KEY);
  for (const names of [["MISSING"], ["NPM_TOKEN"], ["INVALID-NAME"]]) assert.throws(() => selectEnvironment("codex", cfg, canaries, names));
  const missing = withDefaults({ child_env: { request: ["MISSING"] } });
  assert.throws(() => selectEnvironment("codex", missing, canaries, ["MISSING"]), /absent/);
  const dropped = withDefaults({ child_env: { request: ["NPM_TOKEN"], drop: ["NPM_TOKEN"] } });
  assert.throws(() => selectEnvironment("codex", dropped, canaries, ["NPM_TOKEN"]), /dropped/);
});

test("tool env policy: exact baseline, unknown synthetic secrets and authenticated proxies", () => {
  const env = { PATH: "/usr/bin", LC_TIME: "C", JAVA_HOME: "/java", npm_config_cache: "/cache", EMPTY: "", ...canaries };
  for (const target of TARGET_IDS) {
    const selected = selectEnvironment(target, withDefaults({}), env);
    for (const name of [...Object.keys(canaries), "JAVA_HOME", "npm_config_cache", "EMPTY"]) assert.equal(selected.env[name], undefined, `${target}: ${name}`);
    assert.equal(selected.env.PATH, env.PATH); assert.equal(selected.env.LC_TIME, "C");
  }
  for (const value of ["http://proxy.example:8080", "https://proxy.example/", "socks5h://localhost:1080"]) assert.equal(validatedProxy("HTTP_PROXY", value), true);
  for (const value of ["http://u:p@proxy.example", "http://proxy.example/?secret=canary", "http://proxy.example/#secret", "file:///tmp/proxy", "http://proxy.example/path", "http://proxy.example:0", "http://proxy.example:99999"]) assert.equal(validatedProxy("HTTP_PROXY", value), false, value);
  assert.equal(validatedProxy("NO_PROXY", "localhost,.example.com,[::1]:80"), true);
  assert.equal(validatedProxy("NO_PROXY", "http://person:secret@host/"), false);
  const credentialProxy = "http://person:opaque-canary@proxy.example";
  assert.equal(selectEnvironment("codex", withDefaults({}), { HTTP_PROXY: credentialProxy }).env.HTTP_PROXY, undefined);
  assert.equal(selectEnvironment("codex", withDefaults({ child_env: { pass: ["HTTP_PROXY"] } }), { HTTP_PROXY: credentialProxy }).env.HTTP_PROXY, credentialProxy);
  const shaped = "ghp_" + "a".repeat(40);
  assert.equal(selectEnvironment("codex", withDefaults({}), { LANG: shaped }).env.LANG, undefined);
  assert.equal(selectEnvironment("codex", withDefaults({ child_env: { pass: ["LANG"] } }), { LANG: shaped }).env.LANG, shaped);
  assert.equal(recognizedSecretShape("a".repeat(200_000)), false);
});

test("tool env policy: every target, legacy/global any, mandatory guards and backend identities", () => {
  const root = { HOME: "/synthetic/home", CODEX_HOME: "/synthetic/codex", CLAUDE_CONFIG_DIR: "/synthetic/claude", ANTHROPIC_API_KEY: "anthropic-canary", OPENAI_API_KEY: "openai-canary", GEMINI_API_KEY: "gemini-canary", XAI_API_KEY: "xai-canary", CLAUDE_CODE_MESSAGING_TOKEN: "inbox-canary", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "parent", CLAUDE_CODE_DESKTOP_APP_VERSION: "host", RELAY_NODE_ID: "parent", TMPDIR: "/untrusted/temp", NODE_OPTIONS: "--require=untrusted", ...canaries };
  for (const target of TARGET_IDS) for (const policy of ["allowlist", "legacy"] as const) for (const auth of ["login", "any"] as const) {
    const cfg = withDefaults({ child_auth: auth, child_env: { policy } });
    const selected = selectEnvironment(target, cfg, root);
    const spec = { target: targetDef(target), config: cfg, markers: { runId: "r", nodeId: "n", depth: 1 }, environment: selected.env, environmentReleased: selected.releasedNames } as never;
    const env = childEnv(spec, (name) => BACKEND_ENVIRONMENT_SCRUBS[target].test(name));
    for (const name of ["NODE_OPTIONS", "TMPDIR", "CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_CODE_MESSAGING_TOKEN", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]) assert.equal(env[name], undefined, `${target}/${policy}/${auth}: ${name}`);
    for (const [name, value] of Object.entries(root)) if (targetDef(target).credentialEnv.test(name) === false && /^(ANTHROPIC|OPENAI|GEMINI|XAI)_API_KEY$/.test(name)) assert.notEqual(env[name], value);
    assert.equal(env.RELAY_NODE_ID, "n"); assert.equal(env.RELAY_DEPTH, "1");
    if (auth === "login") for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", ...(target === "copilot" ? ["GH_TOKEN"] : [])]) assert.equal(env[name], undefined);
  }
  const config = withDefaults({ targets: { codex: { child_env: { pass: ["OPENAI_BASE_URL"] } } } });
  assert.throws(() => selectEnvironment("codex", config, { OPENAI_BASE_URL: "https://user:canary@invalid" }), /OPENAI_BASE_URL/);
  // Keep the final backend check too: a wrapper must not introduce an endpoint after selection.
  assert.throws(() => agentEnv({ target: targetDef("codex"), config, markers: { runId: "r", nodeId: "n", depth: 1 }, environment: { OPENAI_BASE_URL: "https://user:canary@invalid" } } as never, () => false), /OPENAI_BASE_URL/);
  const runtime = runtimeEnvironment({ ...root, JAVA_HOME: "/java" });
  for (const name of [...Object.keys(canaries), "JAVA_HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NODE_OPTIONS"]) assert.equal(runtime[name], undefined);
});

test("tool env policy: secret-like explicit values of any name are redacted; short values, numbers and paths remain; diagnostics names only", () => {
  const secretLike = { NEUTRAL_ALIAS: "opaque-canary-7aYq-921", EIGHT: "abcdefgh", HTTP_PROXY: "http://person:canary@invalid" };
  const ordinary = { JAVA_HOME: "/synthetic/java", HOME_PATH: "~/synthetic/java", RELATIVE_PATH: "./synthetic/java", PARENT_PATH: "../synthetic/java", SHORT: "xy", SEVEN: "abcdefg", FLAG: "1", NUMBER: "123456789012" };
  const env = { ...secretLike, ...ordinary };
  withTurnSecrets(() => {
    registerReleasedEnvironment(env, Object.keys(env));
    for (const value of Object.values(secretLike)) assert.equal(redact(value), "[redacted: environment value]");
    for (const value of Object.values(ordinary)) assert.equal(redact(value), value);
  });
  assert.equal(redact(env.NEUTRAL_ALIAS), env.NEUTRAL_ALIAS, "one turn's literal secrets do not become standing secrets");
  const selected = selectEnvironment("codex", withDefaults({ child_env: { pass: Object.keys(env) } }), env);
  assert.deepEqual(selected.diagnostics, Object.keys(env).sort().map((name) => ({ name, included: true, reason: "standing pass" })), "diagnostics contain exactly names, inclusion and fixed reasons, never values");
});

test("tool env policy: Claude key auth never loses the root endpoint and redirects its credential", () => {
  const root = { ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_AUTH_TOKEN: "gateway-token", ANTHROPIC_API_KEY: "gateway-api-key" };
  for (const policy of ["allowlist", "legacy"] as const) for (const marker of [{}, { CLAUDE_AGENT_SDK_VERSION: "1.2.3" }, { CLAUDE_CODE_DESKTOP_APP_VERSION: "1.2.3" }]) {
    for (const auth of [{ child_auth: "any" }, { targets: { claude: { child_auth: "any" } } }] as const) {
      for (const settings of [{}, { pass: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] }, { drop: ["ANTHROPIC_BASE_URL"] }, { pass: ["ANTHROPIC_BASE_URL"] }, { request: ["ANTHROPIC_AUTH_TOKEN"] }]) {
        const config = withDefaults({ ...auth, child_env: { policy, ...settings } });
        assert.throws(() => selectEnvironment("claude", config, { ...root, ...marker }, "request" in settings ? ["ANTHROPIC_AUTH_TOKEN"] : []), (error: Error) => {
          assert.match(error.message, /sets ANTHROPIC_BASE_URL, which sends Claude Code to another endpoint/);
          assert.match(error.message, /could send a credential meant for it to the vendor instead/);
          assert.match(error.message, /Unset those variables.*restart relay/);
          if (Object.keys(marker).length) assert.match(error.message, /"child_auth": "login".*host-session endpoint/);
          else assert.doesNotMatch(error.message, /"child_auth": "login"/);
          for (const value of Object.values(root)) assert.ok(!error.message.includes(value), "only names appear in the refusal");
          return true;
        });
      }
    }
  }
  // Stored credentials need the same protection even when no credential variable was set.
  for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL"]) {
    assert.throws(() => selectEnvironment("claude", withDefaults({ child_auth: "any" }), { [name]: "https://gateway.example" }), new RegExp(`sets ${name}`));
  }
  assert.equal(selectEnvironment("claude", withDefaults({ child_auth: "any", child_env: { pass: ["ANTHROPIC_API_KEY"] } }), { ANTHROPIC_API_KEY: root.ANTHROPIC_API_KEY }).env.ANTHROPIC_API_KEY, root.ANTHROPIC_API_KEY, "key auth without an endpoint override remains available");
  const login = withDefaults({ child_auth: "any", targets: { claude: { child_auth: "login" } } });
  const selected = selectEnvironment("claude", login, { ...root, CLAUDE_AGENT_SDK_VERSION: "1.2.3" });
  for (const name of Object.keys(root)) assert.equal(selected.env[name], undefined, "a target's login policy overrides global any");
});

test("tool env policy: person-set endpoints refuse every destination before filtering under login and any", () => {
  const endpoints = {
    claude: ["ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL"],
    codex: ["OPENAI_BASE_URL"],
    gemini: ["CODE_ASSIST_ENDPOINT", "CODE_ASSIST_API_VERSION", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_VERTEX_BASE_URL", "GOOGLE_GENAI_API_VERSION", "GCE_METADATA_HOST", "GCE_METADATA_IP"],
  } as const;
  for (const target of Object.keys(endpoints) as (keyof typeof endpoints)[]) for (const name of endpoints[target]) {
    assert.ok(targetDef(target).endpointEnv.test(name));
    for (const auth of ["login", "any"] as const) for (const policy of ["allowlist", "legacy"] as const) {
      for (const settings of [{}, { pass: [name] }, { drop: [name] }, { request: [name] }]) {
        const config = withDefaults({ child_auth: auth, child_env: { policy, ...settings } });
        for (const value of ["", "https://endpoint-canary.example"]) {
          assert.throws(() => selectEnvironment(target, config, { [name]: value }, "request" in settings ? [name] : []), (error: Error) => {
            assert.match(error.message, new RegExp(`sets ${name}, which sends`));
            assert.match(error.message, /cannot tell which family/);
            assert.match(error.message, /Unset those variables/);
            assert.equal(error.message.includes("could send a credential"), auth === "any");
            assert.ok(!error.message.includes("endpoint-canary.example"));
            return true;
          });
        }
        assert.doesNotThrow(() => selectEnvironment(target, config, { [name]: undefined }));
      }
    }
  }
  const config = withDefaults({});
  for (const marker of ["CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_AGENT_SDK_VERSION"]) for (const target of TARGET_IDS) {
    const selection = selectEnvironment(target, config, { [marker]: "host", ANTHROPIC_BASE_URL: "https://host-canary.example" });
    assert.equal(selection.env.ANTHROPIC_BASE_URL, undefined);
    assert.ok(selection.diagnostics.some((d) => d.name === "ANTHROPIC_BASE_URL" && !d.included && d.reason === "host-session endpoint"));
  }
});

test("tool env upgrade: 0.9.1 config has no grandfathered unknown inheritance and warns on every legacy/global-any load", () => {
  const sql = fs.readFileSync(new URL("fixtures/relay-0.9.1.sql", import.meta.url), "utf8");
  const old = JSON.parse(sql.match(/INSERT INTO runs VALUES\('[^']+',\d+,'[^']+','([^']+)'/)![1]);
  assert.equal(withDefaults(old).child_env.policy, "allowlist");
  assert.equal(selectEnvironment("codex", withDefaults(old), canaries).env.NEUTRAL_ALIAS, undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-upgrade-")), saved = process.env.RELAY_CONFIG;
  try {
    process.env.RELAY_CONFIG = path.join(dir, "config.json");
    fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ child_auth: "any", child_env: { policy: "legacy" } }));
    for (let i = 0; i < 2; i++) {
      const warnings: string[] = []; loadConfig((m) => warnings.push(m));
      assert.ok(warnings.some((w) => /unknown environment variables/.test(w)));
      assert.ok(warnings.some((w) => /no longer forwards/.test(w)));
      assert.ok(warnings.every((w) => !w.includes(canaries.NEUTRAL_ALIAS)));
    }
  } finally { if (saved === undefined) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = saved; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("tool env doctor: each target has names/reasons only, including authenticated-proxy and neutral canaries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-doctor-"));
  try {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ child_env: { policy: "legacy", pass: ["NEUTRAL_ALIAS", "HTTP_PROXY"] }, targets: Object.fromEntries(TARGET_IDS.map((id) => [id, { enabled: false }])) }));
    const env = { HOME: dir, RELAY_HOME: path.join(dir, "state"), RELAY_CONFIG: file, PATH: "/usr/bin:/bin", NEUTRAL_ALIAS: canaries.NEUTRAL_ALIAS, HTTP_PROXY: "http://person:proxy-canary-39281@invalid.example" };
    const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../dist/cli.js"), "doctor"], { env, encoding: "utf8", cwd: dir, timeout: 20000 });
    assert.equal(r.error, undefined);
    for (const id of TARGET_IDS) assert.ok(r.stdout.includes(`${id}: legacy`));
    assert.match(r.stdout, /: included \(standing pass\), 2 names: HTTP_PROXY, NEUTRAL_ALIAS\n/);
    // One line per outcome and reason, naming each variable it covers, not one line per variable.
    assert.doesNotMatch(r.stdout, /: [A-Za-z_][A-Za-z0-9_]*: (included|dropped) \(/);
    assert.match(r.stdout, /WARNING.*legacy/s);
    for (const value of [env.NEUTRAL_ALIAS, env.HTTP_PROXY, "proxy-canary-39281", "invalid.example"]) assert.equal((r.stdout + r.stderr).includes(value), false, value);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("tool env doctor: refused endpoints under login and any never run a CLI or abort other previews", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-doctor-endpoint-"));
  try {
    const file = path.join(dir, "config.json"), marker = path.join(dir, "launched"), bin = path.join(dir, "claude");
    fs.writeFileSync(bin, `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(marker)}, "launched");\n`, { mode: 0o755 });
    const env = { HOME: dir, RELAY_HOME: path.join(dir, "state"), RELAY_CONFIG: file, PATH: "/usr/bin:/bin", ANTHROPIC_BASE_URL: "https://gateway-canary.example", ANTHROPIC_API_KEY: "gateway-canary-key", OPENAI_BASE_URL: "https://codex-canary.example", GOOGLE_GEMINI_BASE_URL: "https://gemini-canary.example" };
    for (const [enabled, child_auth] of [[true, "login"], [false, "any"]] as const) {
      fs.writeFileSync(file, JSON.stringify({ child_auth, targets: Object.fromEntries(TARGET_IDS.map((id) => [id,
        ["claude", "codex", "gemini"].includes(id) ? { enabled, bin } : { enabled: false, bin: path.join(dir, "absent-cli") }])) }));
      const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../dist/cli.js"), "doctor"], { env, encoding: "utf8", cwd: dir, timeout: 20000 });
      assert.equal(r.error, undefined);
      assert.match(r.stdout, /claude: refused:.*sets ANTHROPIC_BASE_URL/);
      assert.match(r.stdout, /codex: refused:.*sets OPENAI_BASE_URL/);
      assert.match(r.stdout, /gemini: refused:.*sets GOOGLE_GEMINI_BASE_URL/);
      assert.match(r.stdout, /copilot: allowlist/);
      assert.equal(fs.existsSync(marker), false, "not even a version probe may launch a destination with a refused endpoint");
      for (const value of [env.ANTHROPIC_BASE_URL, env.ANTHROPIC_API_KEY, env.OPENAI_BASE_URL, env.GOOGLE_GEMINI_BASE_URL]) assert.ok(!(r.stdout + r.stderr).includes(value), "the refusal names the endpoint variable, never its value");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("tool env bridges: actual native server and ACP stdio launchers erase the parent's token selection", async () => {
  const { relayServerCommand } = await import("../dist/backends/types.js");
  const { bridgeCommand } = await import("../dist/confine/broker.js");
  const socket = process.env.RELAY_ENV_SOCKET; process.env.RELAY_ENV_SOCKET = "/synthetic/root.sock";
  try {
    const native = relayServerCommand({ runId: "synthetic", nodeId: "child", depth: 2, contextFile: "/synthetic/context" });
    const nativeNode = native.args.indexOf(process.execPath);
    const r = spawnSync(native.command, [...native.args.slice(0, nativeNode), process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"], { env: { ...process.env, ...canaries }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); const seen = JSON.parse(r.stdout);
    for (const name of Object.keys(canaries)) assert.equal(seen[name], undefined);
    assert.equal(seen.RELAY_NODE_ID, "child"); assert.equal(seen.RELAY_ENV_SOCKET, "/synthetic/root.sock");
    const bridge = bridgeCommand("/synthetic/turn.sock", "synthetic-bridge-credential");
    const b = spawnSync(bridge.command, [...bridge.args.slice(0, 3), process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"], { env: { ...process.env, ...canaries, ...bridge.env }, encoding: "utf8" });
    assert.equal(b.status, 0, b.stderr);
    const bridgeSeen = JSON.parse(b.stdout);
    // macOS/Node may create this runtime marker even after env -i; it is not inherited.
    delete bridgeSeen.__CF_USER_TEXT_ENCODING;
    assert.deepEqual(bridgeSeen, { RELAY_BRIDGE_SECRET: "synthetic-bridge-credential" });
  } finally { if (socket === undefined) delete process.env.RELAY_ENV_SOCKET; else process.env.RELAY_ENV_SOCKET = socket; }
});

test("tool env policy: USER reaches every launched target, and relay never sets CLAUDE_CONFIG_DIR itself (Claude Code 2.1.303's keychain login, found live 2026-10-21)", () => {
  // `claude auth status` reports loggedIn: false without USER, and with CLAUDE_CONFIG_DIR set
  // at all, even to ~/.claude. Neither shows in a stub; both were found in a signed-in smoke.
  const root = { PATH: "/usr/bin:/bin", HOME: "/Users/someone", USER: "someone", LOGNAME: "someone", SHELL: "/bin/zsh" };
  for (const t of TARGET_IDS) {
    const { env } = selectEnvironment(t, withDefaults({}), root);
    assert.deepEqual([env.USER, env.LOGNAME, env.SHELL], ["someone", "someone", "/bin/zsh"], `${t} gets the runtime identity`);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined, `${t}: relay does not invent CLAUDE_CONFIG_DIR`);
  }
  const own = selectEnvironment("claude", withDefaults({}), { ...root, CLAUDE_CONFIG_DIR: "/Users/someone/.claude-work" }).env;
  assert.equal(own.CLAUDE_CONFIG_DIR, "/Users/someone/.claude-work", "the person's own CLAUDE_CONFIG_DIR is kept");
});
