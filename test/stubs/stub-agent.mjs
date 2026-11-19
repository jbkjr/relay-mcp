// Stub agent used by the tests in place of the real CLIs. It parses the real flag sets, records
// what it was given, and plays back steps from a scenario file, so no model tokens are spent. A
// step can call a relay tool through the MCP config the stub was launched with, which is how
// nested behaviour is exercised across real process boundaries.
//
// This file is what every target's stub shares: the scenario, the session files, the record and
// the course of a turn. What differs by target (its flags, its event dialect, how it asks for
// approval, its version) is in targets/<id>.mjs, and each stub-<id> launcher joins the two.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DIR = process.env.STUB_DIR;
/** Output held back by a stub that is about to vanish (see main's leave), or null when output goes straight out. */
let heldBack = null;
// Written synchronously, so that what an agent said is out before anything it does next.
export const emit = (obj) => {
  const line = JSON.stringify(obj) + "\n";
  if (heldBack !== null) heldBack += line;
  else fs.writeSync(1, line);
};
/** What of the environment reached this agent, for tests of what relay passes down. */
export const SEEN_ENV = {
  tmpdir: process.env.TMPDIR ?? null, claudeTmpdir: process.env.CLAUDE_CODE_TMPDIR ?? null,
  anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY), openaiKey: Boolean(process.env.OPENAI_API_KEY),
  worktrees: process.env.RELAY_WORKTREES ?? null, lang: process.env.LC_ALL ?? null, home: process.env.HOME ?? null,
  inbox: Boolean(process.env.CLAUDE_CODE_MESSAGING_SOCKET || process.env.CLAUDE_CODE_MESSAGING_TOKEN),
  anthropicBaseUrl: Boolean(process.env.ANTHROPIC_BASE_URL),
  hostMarkers: Boolean(process.env.CLAUDE_CODE_DESKTOP_APP_VERSION || process.env.CLAUDE_AGENT_SDK_VERSION),
  baseUrls: Object.keys(process.env).filter((k) => /BASE_URL$/.test(k)).sort(),
  hostVars: ["CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_AGENT_SDK_VERSION"].filter((k) => k in process.env),
  autoBackground: process.env.CLAUDE_AUTO_BACKGROUND_TASKS ?? null,
  // The proxy variables, with any credentials in them replaced, and Claude's sandbox debug switch.
  proxies: Object.fromEntries(Object.keys(process.env).filter((k) => /^(https?|all|no)_proxy$/i.test(k)).sort().map((k) => [k, process.env[k].replace(/\/\/[^@/]*@/, "//***@")])),
  srtDebug: process.env.SRT_DEBUG ?? null,
};
/**
 * Set by an `ignoreSignals` step: from then on the agent does not stop when asked, whether by a
 * signal (it records each one it ignores) or in-band (the Codex app server's turn/interrupt), so
 * that only a kill ends it.
 */
export const stubborn = { on: false };
/** Polls `fn` until it is true or `ms` pass; false if they did. How a step waits on something instead of sleeping. */
const waitFor = async (fn, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await fn()) return true;
  return false;
};
/** A mark is a file in the stub's directory: set by a step (`mark`) or by the test (Harness.mark), and waited on. */
const markFile = (name) => path.join(DIR, `mark-${name}`);
const get = (o, key) => key.split(".").reduce((v, k) => (v == null ? v : v[k]), o);

/** Writes all of `buf` to `fd`, waiting while the reader is behind (the descriptor may be non-blocking). */
async function writeAll(fd, buf) {
  for (let off = 0; off < buf.length;) {
    try {
      off += fs.writeSync(fd, buf, off);
    } catch (err) {
      if (err.code !== "EAGAIN") return; // The reader is gone: nothing is waiting for the rest.
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

export const record = (obj) => fs.appendFileSync(path.join(DIR, "log.jsonl"), JSON.stringify({ t: Date.now(), pid: process.pid, ...obj }) + "\n");

export function loadSession(target, parsed) {
  const sessDir = path.join(DIR, "sessions");
  fs.mkdirSync(sessDir, { recursive: true });
  const sessionId = parsed.sessionId ?? crypto.randomUUID();
  const sessFile = path.join(sessDir, `${target}-${sessionId}.json`);
  if (parsed.resumed && !fs.existsSync(sessFile)) return { sessionId, missing: true };
  const sess = fs.existsSync(sessFile) ? JSON.parse(fs.readFileSync(sessFile, "utf8")) : { turns: 0 };
  sess.turns += 1;
  fs.writeFileSync(sessFile, JSON.stringify(sess));
  return { sessionId, sess };
}

/**
 * Waits for the test to create a file of that name in the stub's directory. Not for good: a test
 * that was interrupted, or failed, before letting the stub go may never do so, and nothing else
 * would stop it. So the stub gives up, failing, once its directory is gone (the harness removes it
 * when it closes) or after two minutes, as long as a test's tool call may take.
 */
async function held(name) {
  const deadline = Date.now() + Number(process.env.STUB_HOLD_MS ?? 120000);
  while (!fs.existsSync(path.join(DIR, name))) {
    if (!fs.existsSync(DIR) || Date.now() > deadline) {
      console.error(`stub agent: never let go at "${name}"; giving up`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Says a checkpoint of that name on the agent's output, as an event relay logs and otherwise
 * ignores, and is held there until the test lets it go (helpers.ts: passed).
 */
async function checkpoint(name) {
  emit({ type: "stub_checkpoint", method: "stub/checkpoint", params: { checkpoint: name } });
  await held(name);
}

/** Plays the scenario steps for one turn. `ask` sends an approval request the way this host would. */
export async function runSteps(emulator, parsed, prompt, sess, ask) {
  const target = emulator.id;
  const scenario = process.env.STUB_SCENARIO && fs.existsSync(process.env.STUB_SCENARIO) ? JSON.parse(fs.readFileSync(process.env.STUB_SCENARIO, "utf8")) : { rules: [] };
  const rule = scenario.rules.find((r) =>
    (!r.target || r.target === target) && (!r.turn || r.turn === sess.turns) && (!r.match || new RegExp(r.match, "s").test(prompt)));
  const steps = rule?.steps ?? [{ reply: `stub ${target} reply (turn ${sess.turns})` }];

  let client = null;
  const connect = async () => {
    if (client) return client;
    // Loaded only by a turn that calls relay: the SDK is most of a stub's start-up time (scripts/bench).
    const [{ Client }, { StdioClientTransport }] = await Promise.all([import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/client/stdio.js")]);
    const base = emulator.mcpEnv ? emulator.mcpEnv(process.env, parsed.relay.env_vars) : process.env;
    const transport = new StdioClientTransport({ command: parsed.relay.command, args: parsed.relay.args, env: { ...base, ...parsed.relay.env }, cwd: process.cwd() });
    client = new Client({ name: emulator.mcpClientName ?? `stub-${target}`, version: "0" });
    await client.connect(transport);
    return client;
  };
  // A harness that takes relay's tools another way than through relay's MCP server (Gemini's tool
  // discovery) calls and lists them its own way (the emulator's relayTools); otherwise, over MCP.
  const viaHarness = emulator.relayTools;
  const callTool = viaHarness ? (name, args) => viaHarness.call(name, args) : async (name, args) => {
    const res = await (await connect()).callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    if (res.isError) return { error: res.content?.[0]?.text ?? "tool error" };
    try { return JSON.parse(res.content[0].text); } catch { return { raw: res.content }; }
  };

  const vars = { prompt };
  const calls = [];
  let reply = "";
  let failure = null;
  let vanish = false;
  let after;
  const fill = (s) => s.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
    const v = get(vars, key);
    return typeof v === "string" ? v : JSON.stringify(v);
  });
  for (const step of steps) {
    // Print exactly the credentials this turn received, without a name or other identifying shape.
    if (step.bareTurnSecrets) {
      const values = [new URL(process.env.HTTPS_PROXY).password, parsed.relay.env.RELAY_BRIDGE_SECRET];
      fs.writeFileSync("turn-secrets.json", JSON.stringify(values));
      reply = values.join("\n");
      if (step.bareTurnSecrets === "proxy") reply = values[0];
      if (step.bareTurnSecrets === "bridge") reply = values[1];
      fs.writeSync(2, reply + "\n");
      if (step.fail) { failure = reply; vanish = true; }
    }
    if (step.bareEnvironmentSecret) reply = process.env[step.bareEnvironmentSecret];
    if (step.orphan) {
      // A detached child that shares this agent's output and outlives it, as a runaway tool process would.
      // Its arguments name it and this stub's directory, so that the harness can tell it is still that child
      // (killOrphans in helpers.ts); every one is listed in `orphans`, the latest in `orphan.pid`.
      const { spawn } = await import("node:child_process");
      const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "relay-stub-orphan", DIR], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
      c.unref();
      fs.appendFileSync(path.join(DIR, "orphans"), `${c.pid}\n`);
      fs.writeFileSync(path.join(DIR, "orphan.pid"), String(c.pid));
    }
    // A shell command run in the agent's directory, as an agent's shell tool would run it.
    if (step.run) {
      const { execSync } = await import("node:child_process");
      try {
        execSync(step.run, { cwd: process.cwd(), stdio: "ignore", shell: "/bin/sh" });
      } catch {
        // The scenario decides what a failure means.
      }
    }
    // A raw event on the agent's output, such as an error it goes on to retry.
    if (step.emit) emit(step.emit);
    // Text on the agent's stderr, as a CLI's diagnostics would be.
    if (step.stderr) fs.writeSync(2, step.stderr);
    if (step.ignoreSignals) {
      stubborn.on = true;
      for (const sig of ["SIGINT", "SIGTERM"]) {
        process.removeAllListeners(sig);
        process.on(sig, () => record({ event: "signal", target: emulator.id, signal: sig, ignored: true }));
      }
    }
    // Waits for the test (or another agent) to set a mark: explicit synchronisation, where a sleep would be a guess.
    if (step.awaitMark && !(await waitFor(() => fs.existsSync(markFile(step.awaitMark)), step.within ?? 120000))) {
      failure = `the stub waited for mark ${step.awaitMark} in vain`;
      break;
    }
    if (step.sleep) await new Promise((r) => setTimeout(r, step.sleep));
    // Something only this target's emulator knows how to do (an ACP agent switching its model, say).
    if (step.hook) await emulator.hook?.(step.hook);
    // Tells the test this agent got this far: a file of that name in the stub's directory.
    if (step.signal) fs.writeFileSync(path.join(DIR, step.signal), String(process.pid));
    // Held here until the test lets it go, by creating a file of that name in the stub's directory.
    if (step.await) await held(step.await);
    if (step.checkpoint) await checkpoint(step.checkpoint);
    if (step.crash !== undefined) process.exit(step.crash);
    if (step.write) fs.writeFileSync(path.resolve(process.cwd(), step.write), step.content ?? "stub\n");
    if (step.call || step.tools) {
      let result;
      if (!parsed.relay && !viaHarness) result = { error: "no relay server was provided to this agent" };
      else if (step.tools) result = { tools: viaHarness ? viaHarness.list() : (await (await connect()).listTools()).tools.map((t) => t.name).sort() };
      else {
        result = await callTool(step.call, JSON.parse(fill(JSON.stringify(step.args ?? {}))));
        // `until`: the call is repeated until the result has something at that path (or `within` ms pass, and the last result stands).
        if (step.until && get(result, step.until) == null) {
          await waitFor(async () => get((result = await callTool(step.call, JSON.parse(fill(JSON.stringify(step.args ?? {}))))), step.until) != null, step.within ?? 120000);
        }
      }
      calls.push({ tool: step.call ?? "(list tools)", args: step.args, result });
      if (step.as) vars[step.as] = result;
      vars.last = result;
    }
    // What relay's server tells the agent about itself (its MCP instructions), as the harness shows it.
    if (step.instructions) {
      const result = parsed.relay ? { instructions: (await connect()).getInstructions() ?? null } : { error: "no relay server was provided to this agent" };
      calls.push({ tool: "(instructions)", result });
      if (step.as) vars[step.as] = result;
      vars.last = result;
    }
    if (step.requests) {
      // Several approval requests issued at the same moment, as parallel tool calls would be.
      const results = await Promise.all(step.requests.map((r) => ask(r, callTool)));
      calls.push({ tool: "(parallel approval requests)", args: step.requests, result: results });
      vars.last = results;
    }
    if (step.request) {
      // The agent hit its sandbox and asks for approval, through whatever channel its host has.
      const result = await ask(step.request, callTool);
      calls.push({ tool: "(approval request)", args: step.request, result });
      vars.last = result;
    }
    // Set once everything else in the step is done, so a test waiting on it knows the step has happened.
    if (step.mark) fs.writeFileSync(markFile(step.mark), String(Date.now()));
    if (step.reply !== undefined) reply = fill(step.reply);
    if (step.vanish) vanish = true;
    // A checkpoint said after its last word, for a test that must know relay read that word while the agent was still there.
    if (step.after) after = step.after;
    if (step.fail) failure = step.bareTurnSecrets ? reply : step.fail;
  }
  if (client) await client.close().catch(() => {});
  return { calls, reply, failure, vanish, after };
}

/**
 * Runs the stub as one target's CLI. The emulator, from targets/<id>.mjs, has: id; version (what
 * `--version` prints); parse(argv); start(argv, parsed, sessionId), the events the CLI starts a
 * turn with; ask(parsed), how it sends an approval request; fail(message, sessionId) and
 * finish(reply, sessionId), the events it ends one with. Optionally: intercept(argv), for a
 * command that is not a turn (true when handled); serve(argv), for a server mode (a promise, or
 * null when argv is not one); mcpEnv(env), the environment it gives MCP servers.
 */
export async function main(emulator) {
  const target = emulator.id;
  const argv = process.argv.slice(2);
  if (emulator.intercept?.(argv)) return;
  // The versions relay was verified with, unless a test asks for another.
  if (argv[0] === "--version") return void console.log(process.env.STUB_VERSION ?? emulator.version);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  const served = emulator.serve?.(argv);
  if (served) return served;

  const parsed = emulator.parse(argv);
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  // What the CLI does once it has its prompt, before it reports anything (Claude's sandbox reporting its proxy ports).
  await emulator.afterPrompt?.(parsed);

  const { sessionId, sess, missing } = loadSession(target, parsed);
  if (missing) {
    record({ event: "error", target, argv, error: "unknown session" });
    console.error(`No conversation found with session ID: ${sessionId}`);
    process.exit(1);
  }

  record({ event: "start", env: SEEN_ENV, target, argv, prompt, sessionId, resumed: parsed.resumed, turn: sess.turns, access: parsed.access, cwd: process.cwd(), hasRelay: Boolean(parsed.relay), strict: parsed.strict ?? null, promptTool: parsed.promptTool ?? null, settings: parsed.settings ?? null, ...(parsed.extra ?? {}) });
  emulator.start(argv, parsed, sessionId);
  const { calls, reply, failure, vanish, after } = await runSteps(emulator, parsed, prompt, sess, emulator.ask(parsed));

  record({ event: "end", target, sessionId, calls, reply, failure });
  // The real CLIs take a while to shut down after their last event (measured 2026-10-13: claude -p
  // about 475 ms, codex exec about 1.5 s). The stub lingers too, unless a step says to vanish at once.
  const leave = async (code) => {
    // To vanish is to be gone before anyone can look: killed outright, with no shutdown at all.
    // Relay looks when it reads the last word, so the stub must already be gone by then, however
    // loaded the machine. Its last events are therefore written by a helper that shares its output
    // and waits on a pipe only the stub holds: the pipe closes when the kernel ends the stub, and
    // only then does the helper pass the events on. Relay gives the output only a second after the
    // stub exits, so the helper is the one that kills it: by then the helper is running, and what is
    // left for it to do uses shell builtins only, with nothing more to start, however slowly
    // programs start on a loaded machine.
    if (vanish) {
      const { spawn } = await import("node:child_process");
      const helper = spawn("/bin/sh", ["-c", 'kill -9 "$STUB_PID"; while IFS= read -r _; do :; done; printf "%s" "$STUB_LAST_WORDS"'], {
        stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, STUB_PID: String(process.pid), STUB_LAST_WORDS: heldBack ?? "" },
      });
      // A helper that cannot start, or ends without having killed the stub, leaves it to vanish alone, without its last words.
      const alone = () => process.kill(process.pid, "SIGKILL");
      helper.on("error", alone);
      helper.on("exit", alone);
      return new Promise(() => {});
    }
    if (after) await checkpoint(after);
    // A real CLI is still there when relay reads its last word, which is when relay takes its last
    // look at what the agent started. A timed linger only makes that likely: on a loaded machine
    // relay can take longer than any linger to read the line. So, first, more output than a pipe
    // holds, which relay logs and ignores: the write returns only once relay has read past the last
    // word, having taken its look while the stub was still here.
    await writeAll(1, Buffer.from(`${" ".repeat(1023)}\n`.repeat(128)));
    // STUB_LINGER_MS: the benchmark (scripts/bench) sets 0, so that a turn's time is relay's own.
    await new Promise((r) => setTimeout(r, Number(process.env.STUB_LINGER_MS ?? 200)));
    process.exit(code);
  };
  if (vanish) heldBack = "";
  if (failure) {
    emulator.fail(failure, sessionId);
    return leave(1);
  }
  emulator.finish(reply, sessionId);
  return leave(0);
}
