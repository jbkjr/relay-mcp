// Generic hooks of the ACP driver (src/backends/acp.ts) that a harness profile can use, each tested
// on the stub ACP agent (test/stubs/targets/acp.mjs) with a profile of the test's own, under relay's
// own sandbox on macOS.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { prepareLaunch } from "../dist/confine/index.js";
import { SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
import { setBoundaryProbeForTests, type BoundaryProbe } from "../dist/confine/turn-probe.js";
import { selectEnvironment } from "../dist/core/env-policy.js";
import { hostVar, scratchOnly } from "./helpers.ts";

/** The real per-turn boundary probes, stood in as only a test can (see acp.test.ts). */
const REAL_PROBES: BoundaryProbe = (mechanism, policy, command, args, signal, environment) => prepareLaunch(mechanism, policy, scratchOnly(command, "harness"), args, signal, environment);

/** A stub ACP agent (test/stubs/targets/<emulator>.mjs), as a scratch copy, so that no probe aims beside the checkout's files. */
function stubBin(emulator: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-hooks-stub-")));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const stubs = path.resolve(import.meta.dirname, "stubs");
  const href = (p: string) => JSON.stringify(pathToFileURL(path.join(stubs, p)).href);
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  const bin = path.join(dir, `stub-${emulator}`);
  fs.writeFileSync(bin, `#!/usr/bin/env node\nimport { main } from ${href("stub-agent.mjs")};\nimport stub from ${href(`targets/${emulator}.mjs`)};\nawait main(stub);\n`, { mode: 0o755 });
  return scratchOnly(bin, "harness");
}
/** The ACP stub agent, Copilot's dialect. */
const STUB_ACP = stubBin("acp");
/** The Gemini CLI stub, which answers session/load and then replays the conversation, as Gemini CLI 0.64.0 does. */
const STUB_GEMINI = stubBin("gemini");
/** What the stub recorded, from the agent's log. */
const records = (log: string): Record<string, any>[] => log.split("\n").flatMap((l) => {
  const m = /^\[stderr\] STUB-RECORD (.*)$/.exec(l);
  return m ? [JSON.parse(m[1])] : [];
});

const onMac = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC) ? test : test.skip;

/**
 * One turn of a relay-enforced Probe target (Codex's entry with relay's own confinement) on the
 * stub agent, playing `steps`, with `profile` merged over a minimal one and `env` set in this process
 * for the turn (the stub's switches), put back whatever happens. Returns the result and the agent's log.
 */
async function turn(steps: unknown[], profile: Record<string, unknown> = {}, opts: { target?: Record<string, unknown>; model?: string; config?: Record<string, unknown>; env?: Record<string, string>; bin?: string; sessionId?: string; before?: (root: string) => void } = {}) {
  const { startAcpTurn, genericApproval: normalizeApproval } = await import("../dist/backends/acp.js");
  const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-hooks-")));
  const wt = path.join(root, "wt");
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify({ rules: [{ steps }] }));
  opts.before?.(root);
  const saved = { scenario: process.env.STUB_SCENARIO, home: process.env.HOME };
  const savedEnv = Object.fromEntries(Object.keys(opts.env ?? {}).map((k) => [k, process.env[k]]));
  Object.assign(process.env, opts.env ?? {});
  process.env.STUB_SCENARIO = path.join(root, "scenario.json");
  process.env.HOME = path.join(root, "home");
  fs.mkdirSync(process.env.HOME);
  setBoundaryProbeForTests(REAL_PROBES);
  try {
    const base = targetDef("codex");
    const target = { ...base, name: "Probe", ...opts.target, capabilities: { ...base.capabilities, confinement: "relay-enforced" } };
    const spec = {
      target, prompt: "go", cwd: wt, access: "write", relay: null, dir: root, logPath: path.join(root, "agent.log"), ...(opts.model ? { model: opts.model } : {}), ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      config: { ...DEFAULT_CONFIG, child_network: true, allow_temp_home: true, ...opts.config, targets: { ...DEFAULT_CONFIG.targets, codex: { enabled: true, bin: opts.bin ?? STUB_ACP } } },
      markers: { runId: "r", nodeId: "n", depth: 1 },
    };
    const base_profile = { args: (_: unknown, model?: string) => ["--acp", ...(model ? ["--model", model] : [])], scrub: () => false, login: { how: "", verify: () => null }, normalizeApproval };
    // These direct calls have no root broker. Select only the fixture's named controls, under
    // the real allowlist, rather than relying on edits to the already captured process.env.
    spec.config.child_env = { ...spec.config.child_env, pass: [...(spec.config.child_env?.pass ?? []),
      "STUB_SCENARIO", ...Object.keys(opts.env ?? {}).filter((name) => name.startsWith("STUB_"))] };
    const selected = selectEnvironment(target.id, spec.config, { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !hostVar(k))), ...opts.env });
    Object.assign(spec, { environment: selected.env, environmentReleased: selected.releasedNames });
    const r = await (await startAcpTurn(spec as never, { ...base_profile, ...profile } as never)).done;
    return { r, log: fs.readFileSync(spec.logPath, "utf8"), root };
  } finally {
    setBoundaryProbeForTests(null);
    for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    process.env.HOME = saved.home;
    if (saved.scenario === undefined) delete process.env.STUB_SCENARIO;
    else process.env.STUB_SCENARIO = saved.scenario;
  }
}

/** Every file under `dir` whose bytes hold `needle`. */
function filesHolding(dir: string, needle: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath, e.name);
    if (e.isFile() && fs.readFileSync(p).includes(needle)) out.push(p);
  }
  return out;
}

// HarnessState.secrets: values relay redacts from everything it reads from the agent.

const SECRET = "AIzaTEST-not-a-real-secret_0123456789ab";

test("acp: the redactor replaces each secret wherever it occurs, and refuses one short enough to occur by chance", async () => {
  const { redactor } = await import("../dist/backends/acp.js");
  const r = redactor([SECRET]);
  assert.equal(r(`{"text":"key ${SECRET} twice ${SECRET}"}`), '{"text":"key [redacted] twice [redacted]"}');
  assert.equal(r("nothing here"), "nothing here");
  assert.equal(redactor([])("x"), "x", "no secrets, nothing changed");
  assert.throws(() => redactor(["short-secret"]), /too short/);
});

test("acp: an agent's error is reported with the detail its data carries (data.details, or data as a string), on one line, cut of secrets and clipped as the stderr tail is", async () => {
  const { rpcErrorText, redactor } = await import("../dist/backends/acp.js");
  // Gemini CLI 0.64.0's answer to a session/load of a session it has no file for.
  const details = 'Invalid session identifier "bb446e82-f176-47d0-9522-064b495edf50".\n  Searched for sessions in /h/.cache/.gemini/tmp/repo/chats.\n  Use --list-sessions to see available sessions, then use --resume {number}, --resume {uuid}, or --resume latest.';
  assert.equal(rpcErrorText({ code: -32603, message: "Internal error", data: { details } }),
    'Internal error: Invalid session identifier "bb446e82-f176-47d0-9522-064b495edf50". Searched for sessions in /h/.cache/.gemini/tmp/repo/chats. Use --list-sessions to see available sessions, then use --resume {number}, --resume {uuid}, or --resume latest.');
  assert.equal(rpcErrorText({ code: -32000, message: "Load failed", data: "the store is locked" }), "Load failed: the store is locked", "data itself, when it is a string");
  assert.equal(rpcErrorText({ code: -32000, message: "Load failed", data: { reason: "x" } }), "Load failed", "no other shape of data");
  assert.equal(rpcErrorText({ code: -32000, message: "Load failed", data: { details: "  \n " } }), "Load failed", "an empty detail adds nothing");
  assert.equal(rpcErrorText({ code: -32000, message: "Load failed" }), "Load failed");
  assert.equal(rpcErrorText({ code: 7 }), '{"code":7}', "an error without a message or detail as before");
  assert.equal(rpcErrorText({ code: 7, data: { details: "why" } }), "error 7: why");
  // The profile's secrets, and credentials of a shape relay knows, are cut from the detail.
  const cut = redactor([SECRET]);
  const shaped = `sk-ant-${"a1".repeat(20)}`;
  const text = rpcErrorText({ code: -32603, message: `refused ${SECRET}`, data: { details: `signed in with ${SECRET}; also ${shaped}` } }, cut);
  assert.ok(!text.includes(SECRET) && !text.includes(shaped), text);
  assert.match(text, /^refused \[redacted\]: signed in with \[redacted\]; also \[redacted\]$/);
  // Clipped to the stderr tail's bound, keeping its end, as the tail a failure quotes is.
  const long = rpcErrorText({ code: -32603, message: "Internal error", data: { details: `${"x".repeat(5000)} the end` } });
  assert.ok(long.length <= "Internal error: ".length + 2000, String(long.length));
  assert.ok(long.endsWith("x the end"));
});

test("acp: a turn's secret split across streamed text chunks reaches its log neither whole nor in pieces, whatever lines come between; without secrets each line goes straight through", async () => {
  const { secretSafeLog } = await import("../dist/backends/acp.js");
  const sink = () => {
    const out: string[] = [];
    let ended = false;
    return { out, log: { write: (t: string) => (ended ? false : (out.push(t), true)), end: (cb?: () => void) => { ended = true; cb?.(); }, get writableEnded() { return ended; } } };
  };
  const update = (u: Record<string, unknown>) => {
    const m = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: u } };
    return [m, JSON.stringify(m)] as const;
  };
  const chunk = (text: string, kind = "agent_message_chunk") => update({ sessionUpdate: kind, content: { type: "text", text } });
  const textOf = (l: string) => JSON.parse(l).params.update.content.text as string;
  const chunks = (out: string[]) => out.filter((l) => /_chunk"/.test(l)).map(textOf);
  // Without secrets, straight through, at once.
  {
    const k = sink();
    const log = secretSafeLog(k.log, []);
    const [m, line] = chunk("hello");
    log.agent(m, line);
    assert.deepEqual(k.out, [line + "\n"]);
  }
  const cases: [string, ReturnType<typeof update>[]][] = [
    ["split in two", [chunk(`the key is ${SECRET.slice(0, 15)}`), chunk(`${SECRET.slice(15)}.`)]],
    ["split in three, its middle piece short", [chunk(`the key is ${SECRET.slice(0, 5)}`), chunk(SECRET.slice(5, 7)), chunk(`${SECRET.slice(7)}.`)]],
    ["split by a usage update", [chunk(`the key is ${SECRET.slice(0, 20)}`), update({ sessionUpdate: "usage_update", used: 10, size: 100 }), chunk(`${SECRET.slice(20)}.`)]],
    ["split between a thought and the reply", [chunk(`the key is ${SECRET.slice(0, 9)}`, "agent_thought_chunk"), chunk(`${SECRET.slice(9)}.`)]],
  ];
  for (const [name, lines] of cases) {
    const k = sink();
    const log = secretSafeLog(k.log, [SECRET]);
    lines.forEach(([m, line], i) => {
      log.agent(m, line);
      if (i === 0) log.write("# relay: a note of relay's own\n");
    });
    log.end();
    const all = k.out.join("");
    assert.equal(chunks(k.out).join(""), "the key is [redacted].", `${name}: ${all}`);
    for (let n = 8; n <= SECRET.length; n++) for (let i = 0; i + n <= SECRET.length; i++) assert.ok(!all.includes(SECRET.slice(i, i + n)), `${name}: no piece of the secret (${SECRET.slice(i, i + n)}) in ${all}`);
    // Every line, in the order it came, relay's own note after the first.
    assert.equal(k.out.length, lines.length + 1, name);
    assert.equal(k.out[1], "# relay: a note of relay's own\n", name);
    if (name.includes("usage")) assert.match(k.out[2], /usage_update/, name);
  }
  // A line is not held for ever: once the stream has run on far enough past it, it is written.
  {
    const k = sink();
    const log = secretSafeLog(k.log, [SECRET]);
    log.agent(...chunk("first words"));
    assert.deepEqual(k.out, [], "held while the next text could still finish a secret");
    log.agent(...chunk("x".repeat(SECRET.length)));
    assert.equal(chunks(k.out)[0], "first words", "written once no secret could still span it");
    log.agent(...update({ sessionUpdate: "tool_call", toolCallId: "t", title: "ls" }));
    log.end();
    assert.equal(k.out.length, 3);
  }
});

onMac("acp: a harness's secrets are redacted from what relay reads from it: its reply (even streamed in pieces), its stderr and its errors; and a secret split across two message chunks reaches the log in neither piece", async () => {
  const state = { stateDirs: [], env: {}, keychain: false, secrets: [SECRET] };
  const ok = await turn([{ stderr: `diag: key=${SECRET}\npartial ${SECRET.slice(0, 12)}` }, { stderr: `${SECRET.slice(12)} end\n` }, { reply: `the key is ${SECRET}.` }], { prepareState: () => state });
  try {
    assert.equal(ok.r.status, "ok", `${ok.r.error}\n${ok.log}`);
    // The stub streams its reply in two pieces, which split the secret: the reply is redacted whole.
    assert.equal(ok.r.finalMessage, "the key is [redacted].");
    assert.match(ok.log, /\[stderr\] diag: key=\[redacted\]/);
    assert.match(ok.log, /\[stderr\] partial \[redacted\] end/, "stderr is redacted a whole line at a time, so a secret split across two writes is caught");
    // The stub streams the reply in two halves, each holding a piece of the secret: relay holds a
    // chunk's line back until the stream has run on past it, and cuts the secret out of both
    // (secretSafeLog), so neither piece is in the log.
    const reply = `the key is ${SECRET}.`;
    const half = Math.ceil(reply.length / 2);
    const logged = ok.log.split("\n").filter((l) => l.includes("agent_message_chunk")).map((l) => JSON.parse(l).params.update.content.text);
    assert.match(logged.join(""), /the key is \[redacted\]\.$/, JSON.stringify(logged));
    for (const piece of [reply.slice("the key is ".length, half), reply.slice(half, -1)]) assert.ok(!ok.log.includes(piece), `the log holds no ${JSON.stringify(piece)}`);
    assert.deepEqual(filesHolding(ok.root, SECRET).filter((f) => !f.endsWith("scenario.json")), [], "the whole secret is in no file relay wrote");
  } finally {
    fs.rmSync(ok.root, { recursive: true, force: true });
  }
  const crashed = await turn([{ stderr: `fatal: ${SECRET}\n` }, { crash: 3 }], { prepareState: () => state });
  try {
    assert.equal(crashed.r.status, "failed");
    assert.match(crashed.r.error ?? "", /fatal: \[redacted\]/, "the error quotes the agent's stderr, redacted");
    assert.ok(!(crashed.r.error ?? "").includes(SECRET));
  } finally {
    fs.rmSync(crashed.root, { recursive: true, force: true });
  }
});

onMac("acp: the stderr a failure quotes stays within its bound, a last line with no line break included", async () => {
  // A harness that dies in the middle of a long line, before initialize: the partial line is
  // redacted and quoted, but no more of it than the tail holds (2000 characters). Cleaned as the
  // tail's complete lines are (core/redact.ts diagnosticTail): the profile's secrets, and a
  // credential relay knows by its shape (core/secrets.ts), here an Anthropic key.
  const shaped = `sk-ant-api03-${"a".repeat(30)}`;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-hooks-long-")));
  const bin = path.join(dir, "long-stderr");
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stderr.write("line one\\n" + "x".repeat(100000) + " ${shaped} ${SECRET}", () => process.exit(3));\n`, { mode: 0o755 });
  const state = { stateDirs: [], env: {}, keychain: false, secrets: [SECRET] };
  const long = await turn([], { prepareState: () => state }, { bin: scratchOnly(bin, "harness") });
  try {
    assert.equal(long.r.status, "failed");
    const error = long.r.error ?? "";
    assert.match(error, /exited \(code 3\) before the turn finished/);
    assert.match(error, /x \[redacted\] \[redacted\]$/, "the partial last line is quoted, redacted");
    assert.ok(!error.includes("sk-ant-"), "a credential of a shape relay knows is cut from it too");
    assert.ok(error.length < 2400, `the quoted tail is bounded (${error.length} characters)`);
  } finally {
    fs.rmSync(long.root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// AcpProfile.acceptsUnlistedModels: a session whose availableModels is a menu, not the set of
// models the harness takes (Gemini CLI lists a few; --model takes any id).

onMac("acp: a model the session does not list is refused, unless the profile says its list is a menu; the reported model is still checked", async () => {
  // The stub lists claude-sonnet-5.5, claude-opus-5.5, gpt-6.1-sol, gpt-5.4 and gemini-3.8-flash, and reports the --model it was given.
  const refused = await turn([{ reply: "should not run" }], {}, { model: "gpt-unlisted-1" });
  try {
    assert.equal(refused.r.status, "failed");
    assert.match(refused.r.error ?? "", /does not offer the model "gpt-unlisted-1" to this account/);
  } finally {
    fs.rmSync(refused.root, { recursive: true, force: true });
  }
  const taken = await turn([{ reply: "taken" }], { acceptsUnlistedModels: true }, { model: "gpt-unlisted-1" });
  try {
    assert.equal(taken.r.status, "ok", taken.r.error);
    assert.equal(taken.r.finalMessage, "taken");
    assert.match(taken.log, /# relay: new session "[^"]+"; mode [^,]+, model "gpt-unlisted-1", offered \[/, "the session reported the model relay asked for");
  } finally {
    fs.rmSync(taken.root, { recursive: true, force: true });
  }
  // A session that reports another model than the one asked for is still stopped before the prompt,
  // with the menu no longer checked: the stub takes the model it is set to (a listed one) and keeps its own.
  const other = await turn([{ reply: "should not run" }], { acceptsUnlistedModels: true }, { model: "gpt-6.1-sol", env: { STUB_ACP_REPORT: JSON.stringify({ model: "gpt-5.4", pinModel: true }) } });
  try {
    assert.equal(other.r.status, "failed");
    assert.match(other.r.error ?? "", /reports the model "gpt-5\.4", not the "gpt-6\.1-sol" relay asked for, so relay stopped it before it did anything/);
    assert.doesNotMatch(other.log, /"stopReason"/, "no prompt was answered");
  } finally {
    fs.rmSync(other.root, { recursive: true, force: true });
  }
});

// PreparedState.authenticate: an ACP authenticate request relay makes right after initialize, with
// what the profile prepared (Gemini: its API key in _meta), so that a secret the harness needs is in
// no environment block, which the turn's own processes could read (kern.procargs2).

onMac("acp: a profile can have relay authenticate with what it prepared, right after initialize; the request is never logged, and a refusal fails the turn", async () => {
  const state = (methodId: string) => () => ({ stateDirs: [], keychain: false, authenticate: { methodId, meta: { token: SECRET } }, secrets: [SECRET] });
  const ok = await turn([{ reply: "signed in" }], { prepareState: state("copilot-login") });
  try {
    assert.equal(ok.r.status, "ok", ok.r.error);
    const order = records(ok.log).map((r) => r.event).filter((e) => ["initialize", "authenticate", "session"].includes(e));
    assert.deepEqual(order, ["initialize", "authenticate", "session"], "before the session exists");
    assert.equal(records(ok.log).find((r) => r.event === "authenticate")!.methodId, "copilot-login");
    assert.match(ok.log, /# relay: signed in with "copilot-login", as the profile prepared/);
    assert.ok(!ok.log.includes(SECRET), "what relay sends is not in the agent's log");
  } finally {
    fs.rmSync(ok.root, { recursive: true, force: true });
  }
  const unoffered = await turn([{ reply: "should not run" }], { prepareState: state("gemini-api-key") });
  try {
    assert.equal(unoffered.r.status, "failed");
    assert.match(unoffered.r.error ?? "", /Probe does not offer the sign-in relay hands it \("gemini-api-key"\)/);
    assert.ok(!records(unoffered.log).some((r) => r.event === "session"), "no session was made");
  } finally {
    fs.rmSync(unoffered.root, { recursive: true, force: true });
  }
  const refused = await turn([{ reply: "should not run" }], { prepareState: state("copilot-login") }, { env: { STUB_LOGIN: "none" } });
  try {
    assert.equal(refused.r.status, "failed");
    assert.match(refused.r.error ?? "", /Probe did not accept the sign-in relay handed it \(Authentication required\)/);
    assert.ok(!(refused.r.error ?? "").includes(SECRET));
  } finally {
    fs.rmSync(refused.root, { recursive: true, force: true });
  }
});

// Every relay-enforced turn is denied the default API key directory (core/api-keys.ts keyPathsToDeny, applied in confine/turn.ts turnPolicy),
// whatever its target: Gemini's key is kept there.

onMac("acp: every relay-enforced turn is denied the default key directory: its agent can neither read a key there nor list the directory", async () => {
  const KEY = "AIzaTEST-not-a-real-key-for-denial-0123";
  let file = "";
  // The profile's state is prepared in the turn's HOME, before the launch: the key file goes there, where the person keeps it.
  const prepareState = () => {
    const dir = path.join(os.homedir(), ".config", "relay-keys");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    file = path.join(dir, "some-api-key");
    fs.writeFileSync(file, `${KEY}\n`, { mode: 0o600 });
    return { stateDirs: [], keychain: false, env: { KEY_FILE: file } };
  };
  const steps = [{ run: 'cat "$KEY_FILE" > read.txt 2> read-err.txt; ls "$(dirname "$KEY_FILE")" > list.txt 2> list-err.txt; true' }, { reply: "peeked" }];
  const peek = await turn(steps, { prepareState });
  try {
    assert.equal(peek.r.status, "ok", peek.r.error);
    const wt = path.join(peek.root, "wt");
    assert.equal(fs.readFileSync(path.join(wt, "read.txt"), "utf8"), "", "the key could not be read");
    assert.match(fs.readFileSync(path.join(wt, "read-err.txt"), "utf8"), /Operation not permitted/);
    assert.equal(fs.readFileSync(path.join(wt, "list.txt"), "utf8"), "", "nor the directory listed");
    assert.match(fs.readFileSync(path.join(wt, "list-err.txt"), "utf8"), /Operation not permitted/);
    assert.ok(fs.readFileSync(file, "utf8").includes(KEY), "the file was there to read");
    assert.match(peek.log, /# relay boundary probes: \d+ passed/, "and the turn's probes passed with the directory denied");
  } finally {
    fs.rmSync(peek.root, { recursive: true, force: true });
  }
});

// AcpProfile.replaysAfterLoad: a harness that answers session/load first and replays the
// conversation after (Gemini CLI 0.64.0). Relay sends the prompt once the replay has gone quiet,
// fails the turn if it is still going after the limit, and says once if it went on after the prompt.

/**
 * A turn on the Gemini stub that continues a session of `turns` earlier turns, with `replay` as the
 * profile's replaysAfterLoad and the stub's switches in `env`. The stub's home is in the worktree,
 * with the settings it signs in by, and relay hands it a key in authenticate.
 */
async function loadedTurn(turns: number, replay: { quietMs: number; maxMs: number }, env: Record<string, string> = {}) {
  const sessionId = "earlier-session";
  const home = (wt: string) => path.join(wt, ".gemini-home");
  const before = (root: string) => {
    const chats = path.join(home(path.join(root, "wt")), ".gemini", "tmp", "stub", "chats");
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(home(path.join(root, "wt")), ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }));
    // Each earlier turn got its reply, so Gemini's start-up session cleanup (on in these settings) keeps it.
    fs.writeFileSync(path.join(chats, `${sessionId}.json`), JSON.stringify({ turns, replies: turns }));
  };
  const prepareState = (spec: { cwd: string }) => ({ stateDirs: [], keychain: false, env: { GEMINI_CLI_HOME: home(spec.cwd) }, authenticate: { methodId: "gemini-api-key", meta: { "api-key": SECRET } }, secrets: [SECRET] });
  return turn([{ reply: "this turn's reply" }], { prepareState, replaysAfterLoad: replay }, { bin: STUB_GEMINI, sessionId, before, env });
}
const prompted = (log: string) => records(log).some((r) => r.event === "start");
const LATE = "Probe was still replaying the earlier conversation after relay sent this turn's prompt, so its reply may begin with part of an earlier one.";

onMac("acp: a replay after session/load is waited out before the prompt; one still going after the prompt is said once, however many earlier turns come after it", async () => {
  // The replay stalls before each earlier turn after the first for longer than the quiet interval,
  // and the model answers only after the whole replay: three replayed user messages come after the prompt.
  const late = await loadedTurn(4, { quietMs: 200, maxMs: 10_000 }, { STUB_GEMINI_REPLAY_STALL_MS: "600", STUB_GEMINI_LATENCY_MS: "3000" });
  try {
    assert.equal(late.r.status, "ok", `${late.r.error}\n${late.log}`);
    const sent = late.log.indexOf("replay of the session is over (no update for 200 ms); sending the prompt");
    assert.ok(sent > 0, "relay waited for the replay to go quiet before it prompted");
    const after = late.log.slice(sent).split("\n").filter((l) => l.includes('"sessionUpdate":"user_message_chunk"')).length;
    assert.equal(after, 3, "three earlier turns were replayed after the prompt");
    assert.deepEqual((late.r.warnings ?? []).filter((w: string) => /still replaying/.test(w)), [LATE], "and the warning is given once");
  } finally {
    fs.rmSync(late.root, { recursive: true, force: true });
  }
});

onMac("acp: a replay after session/load still going at the profile's limit fails the turn before any prompt", async () => {
  // Four hundred earlier turns, replayed a few milliseconds apart: seconds of updates, never quiet for 500 ms.
  const endless = await loadedTurn(400, { quietMs: 500, maxMs: 1500 });
  try {
    assert.equal(endless.r.status, "failed");
    assert.match(endless.r.error ?? "", /Probe was still replaying the earlier conversation \d+s after loading the session, so relay could not tell this turn's reply from it\. It stopped it before sending the prompt\./);
    assert.ok(!prompted(endless.log), "no prompt was sent");
  } finally {
    fs.rmSync(endless.root, { recursive: true, force: true });
  }
});

onMac("acp: a harness that exits while relay waits out its replay fails the turn for exiting, with no prompt sent", async () => {
  const died = await loadedTurn(3, { quietMs: 2000, maxMs: 10_000 }, { STUB_GEMINI_EXIT_IN_REPLAY: "1" });
  try {
    assert.equal(died.r.status, "failed");
    assert.match(died.r.error ?? "", /Probe exited \(code 4\) before the turn finished\. .*stub: died in the middle of its replay/);
    assert.doesNotMatch(died.r.error ?? "", /still replaying/);
    assert.ok(!prompted(died.log), "no prompt was sent");
  } finally {
    fs.rmSync(died.root, { recursive: true, force: true });
  }
});

// AcpProfile.promptText: the text relay sends as the prompt, from the turn's own (Gemini: a line in
// front of a message its harness would take for one of its commands).

onMac("acp: a profile's promptText is what the harness is prompted with", async () => {
  const t = await turn([{ reply: "ok" }], { promptText: (p: string) => `A line in front.\n\n${p}` });
  try {
    assert.equal(t.r.status, "ok", t.r.error);
    assert.equal(records(t.log).find((r) => r.event === "start")?.prompt, "A line in front.\n\ngo");
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});
