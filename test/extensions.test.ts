import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptRun, CLI, forEachTarget, harness as baseHarness, hostFor, INTERACTIVE_CLAUDE, nonTempScratch, reached, task, until, type Harness, type Rec } from "./helpers.ts";
import { closeDbForTests, createRun } from "../dist/core/db.js";
import { withDefaults } from "../dist/core/config.js";
import { readMcpFile } from "../dist/core/extensions.js";
import { qualifiedFixtureAdapters } from "./fixtures/qualified-ext-adapters.mjs";
import { RELAY_CODEX_HOME_MARKER } from "../dist/backends/codex-pin.js";

// Extensions for launched agents (docs/extensions.md): skills and MCP servers a job or thread gets
// only when the root session asks for them and the person consents, with every MCP tool call the
// config does not allow outright put to the person, and nothing of it reachable another way.

const EXT_SERVER = path.resolve(import.meta.dirname, "stubs", "ext-server.mjs");
const EXT_ODD_SERVER = path.resolve(import.meta.dirname, "stubs", "ext-odd-server.mjs");
const EXT_BROKEN_SERVER = path.resolve(import.meta.dirname, "stubs", "ext-broken-server.mjs");
const STUB_ACP = path.join(import.meta.dirname, "stubs", "stub-acp");

// Explicitly qualify only this suite's checked-in decoys. Other harnesses and production keep
// the empty catalog. The opt-out below exercises Release A's refusal before any consent.
const harness: typeof baseHarness = (rules, config, env) => baseHarness(rules, config, { RELAY_TEST_NEVER_ADAPTERS: "1", ...env });

for (const target of ["codex", "claude"] as const) for (const inherit of [false, true]) {
  // Under the never floor a Claude job that would inherit the person's settings is refused before it starts (backends/never-admission.ts).
  const refused = target === "claude" && inherit;
  test(`skill isolation (${target}, inherit ${inherit}): ${refused ? "refused under the never floor before any skill could load" : "no extensions means no implicit skills; unexpected skills refuse before work"}`, async () => {
    for (const stray of [false, true]) {
      const env = !stray ? {} : target === "codex"
        ? { STUB_CODEX_SKILLS: JSON.stringify([{ name: "unexpected", scope: "system", path: "/elsewhere/SKILL.md" }]) }
        : { STUB_INIT: JSON.stringify({ skills: ["unexpected"] }) };
      const h = await harness([{ match: task("NO-SKILLS"), steps: stray ? [{ awaitMark: "never" }, { signal: "acted" }] : [{ reply: "ok" }] }], inherit ? { child_settings: "inherit", claude_settings_env: "accept" } : {}, env);
      try {
        for (const [root, name] of [[path.join(h.env.HOME, ".codex/skills"), "codex-user"], [path.join(h.env.HOME, ".agents/skills"), "agents-user"], [path.join(h.repo, ".agents/skills"), "codex-repo"], [path.join(h.env.HOME, ".claude/skills"), "claude-user"], [path.join(h.repo, ".claude/skills"), "claude-repo"]]) writeSkill(path.join(root, name), name, "description: Scratch.\n");
        const job = await h.call("delegate", { target, task: "NO-SKILLS", mode: "read" });
        const s = await settled(h, job.job_id);
        assert.equal(s.status, stray || refused ? "failed" : "done", JSON.stringify(s));
        if (refused) {
          assert.match(s.error, /^never: inherited Claude settings, hooks or MCP tools can bypass the checked sandbox\/tool route/);
          assert.equal(h.starts().length, 0, "no Claude was launched");
        } else if (stray) {
          assert.match(s.error, /skills relay did not give it.*unexpected/);
          assert.ok(!reached(h, "acted"));
        } else if (target === "codex") {
          const listed = h.log().filter((r) => r.event === "skills-list").at(-1);
          assert.ok(listed, "skills/list runs even without extensions");
          assert.deepEqual(listed.enabled, []);
        } else {
          const listed = h.log().filter((r) => r.event === "skills-init").at(-1);
          assert.ok(listed, "every Claude init report is checked");
          assert.deepEqual(listed.skills, []);
          assert.deepEqual(listed.plugins, []);
        }
      } finally { await h.close(); }
    }
  });
}

/** Writes relay's own MCP definitions file (beside config.json) with the stand-in server as `ext`. */
function defineServers(h: Harness, extra: Record<string, unknown> = {}, dir = h.home): string {
  const log = path.join(h.env.STUB_DIR, "ext.jsonl");
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({
    mcpServers: { ext: { command: process.execPath, args: [EXT_SERVER], env: { EXT_LOG: log, EXT_SECRET: "s3cret" } }, ...extra },
  }), { mode: 0o600 });
  return log;
}

/** The Codex CLI as relay's server sees it: a host known to show relay's question to a person (src/mcp/host.ts). */
const CODEX_HOST = { clientInfo: { name: "codex-mcp-client", version: "0.163.0" } };

type Decision = "allow" | "deny" | "allow for the rest of this job";
type PersonSession = Awaited<ReturnType<Harness["instance"]>> & {
  /** The person answers relay's question about this request; relay records it as theirs. */
  answers(req: Rec, decision?: Decision): Promise<void>;
  /** Every question relay has put to the person, as its message. */
  questions: string[];
};

/**
 * A root session in a host of another family than `target`, one relay knows to show its question
 * to a person (interactive Claude Code, or Codex), and the person at it. Only there, or in the
 * host's permission prompt (confirm), can the person allow a request only they may allow.
 */
async function personSession(h: Harness, target: string, o: { cwd?: string } = {}): Promise<PersonSession> {
  const host = hostFor(target);
  const open: { message: string; params: Rec; signal: AbortSignal; resolve: (r: Rec) => void }[] = [];
  const questions: string[] = [];
  const inst = await h.instance({
    ...(host === "claude" ? INTERACTIVE_CLAUDE : CODEX_HOST), args: ["--host", host], ...o,
    elicit: (message, signal, params) => new Promise((resolve) => {
      questions.push(message);
      open.push({ message, params, signal, resolve });
      signal.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true });
    }),
  });
  // Codex's form names its request in _meta (it keeps a withdrawn one on screen); Claude Code's says who asks.
  const question = (req: Rec) => open.find((q) => !q.signal.aborted && (q.params._meta ? q.params._meta["relay/request"] === req.request_id : q.message.includes(` ${req.from} asks`)));
  return {
    ...inst,
    questions,
    async answers(req, decision = "allow") {
      let q: ReturnType<typeof question>;
      await until(() => Boolean((q = question(req))), 30000, `relay's question about ${req.request_id}`);
      open.splice(open.indexOf(q!), 1);
      q!.resolve({ action: "accept", content: { decision } });
      await until(() => h.sql("SELECT status FROM requests WHERE id = ?", req.request_id)[0]?.status !== "pending", 30000, `${req.request_id} to be decided`);
      const row = h.sql("SELECT status, decided_by FROM requests WHERE id = ?", req.request_id)[0];
      assert.deepEqual({ ...row }, { status: decision === "deny" ? "denied" : "allowed", decided_by: "user" });
    },
  };
}

/** `relay approve` run under a pseudo-terminal of its own (script(1)), as an agent's shell could run it. */
function approveInTerminal(h: Pick<Harness, "env" | "repo">, id: string): string {
  const argv = process.platform === "darwin"
    ? ["-q", "/dev/null", process.execPath, CLI, "approve", id]
    : ["-qec", [process.execPath, CLI, "approve", id].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" "), "/dev/null"];
  const r = spawnSync("script", argv, { env: h.env, cwd: h.repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.error, undefined, `script(1) could not run: ${r.error?.message}`);
  return `${r.stdout}${r.stderr}`;
}

const settingsOf = (start: { argv: string[] }) => JSON.parse(fs.readFileSync(start.argv[start.argv.indexOf("--settings") + 1], "utf8"));
const extLog = (log: string): Rec[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const calls = (log: string, tool: string) => extLog(log).filter((e) => e.tool === tool);

/** Waits for the item's first pending approval request of `kind`, by polling status. */
async function pendingOf(h: Pick<Harness, "call">, id: string, kind: string): Promise<Rec> {
  let req: Rec | undefined;
  await until(async () => {
    const s = await h.call("status", { id, wait_s: 5 });
    req = (s.needs_approval as Rec[] | undefined)?.find((r) => r.kind === kind && r.from === id);
    return Boolean(req);
  }, 60000, `a ${kind} request from ${id}`);
  return req!;
}

const settled = async (h: Pick<Harness, "call">, id: string): Promise<Rec> => {
  let s: Rec = {};
  await until(async () => {
    s = await h.call("status", { id, wait_s: 10 });
    return !["queued", "running"].includes(s.status);
  }, 60000, `${id} to settle`);
  return s;
};

test("extensions: an unqualified server is refused before consent or model launch", async () => {
  const h = await harness([{ steps: [{ reply: "must not run" }] }], { targets: { codex: { mcp_servers: ["ext"] } } }, { RELAY_TEST_NEVER_ADAPTERS: "0" });
  const host = await personSession(h, "codex");
  try {
    const log = defineServers(h);
    const job = await host.call("delegate", { target: "codex", mode: "read", task: "unqualified decoy", extensions: true, background: true });
    const done = await settled(host, job.job_id);
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.match(done.error, /never withholds extension tools from ext: no qualified tool-specific effects adapter/);
    assert.match(done.error, /opaque paths, network destinations, redirects or commands cannot be screened/);
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM requests WHERE kind = 'extensions'")[0].n, 0);
    assert.deepEqual(host.questions, []);
    assert.equal(h.starts().length, 0);
    assert.deepEqual(extLog(log), [], "the unqualified server is not started");
  } finally { await host.close(); await h.close(); }
});

/** The first thread in the registry, once there is one: for an ask still waiting on its reply. */
async function firstThread(h: Pick<Harness, "sql">): Promise<string> {
  let id: string | undefined;
  await until(() => Boolean((id = h.sql("SELECT id FROM nodes WHERE kind = 'thread' ORDER BY created_at")[0]?.id)), 30000, "the thread");
  return id!;
}

/** Every file under these directories, with its size and modification time: to tell that nothing there changed. */
function snapshot(dirs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d).sort()) {
      const p = path.join(d, e);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = `${st.size}:${st.mtimeMs}`;
    }
  };
  for (const d of dirs) walk(d);
  return out;
}
const personDirs = (home: string) => [".claude", ".codex", ".agents"].map((d) => path.join(home, d));

test("extensions: config takes skills and an allowlist of MCP servers per target, for Claude and Codex only", async () => {
  const { validateConfig, withDefaults } = await import("../dist/core/config.js");
  const file = validateConfig({
    targets: {
      codex: { skills: ["tdd", "~/shared/skills/diagnose", "/abs/skill"], mcp_servers: ["docs", { name: "email", allow_tools: ["list_emails"] }] },
      claude: { skills: "user" },
    },
  }, "x");
  const cfg = withDefaults(file);
  assert.deepEqual(cfg.targets.codex.skills, ["tdd", "~/shared/skills/diagnose", "/abs/skill"]);
  assert.deepEqual(cfg.targets.codex.mcp_servers, ["docs", { name: "email", allow_tools: ["list_emails"] }]);
  assert.equal(cfg.targets.claude.skills, "user");
  // None unless allowed.
  assert.equal(withDefaults({}).targets.codex.skills, undefined);
  assert.equal(withDefaults({}).targets.codex.mcp_servers, undefined);

  // An ACP target (Copilot) runs inside relay's own sandbox: no extensions, with a clear message.
  assert.throws(() => validateConfig({ targets: { copilot: { skills: "user" } } }, "x"), /targets\.copilot\.skills: .*only to Claude and Codex agents/);
  assert.throws(() => validateConfig({ targets: { copilot: { mcp_servers: ["docs"] } } }, "x"), /targets\.copilot\.mcp_servers: .*only to Claude and Codex agents/);
  // Every ACP target alike, Grok included: refused by capability, not by name.
  assert.throws(() => validateConfig({ targets: { grok: { skills: ["x"] } } }, "x"), /targets\.grok\.skills: .*only to Claude and Codex agents/);
  // Only the documented forms.
  assert.throws(() => validateConfig({ targets: { codex: { skills: "all" } } }, "x"), /targets\.codex\.skills/);
  assert.throws(() => validateConfig({ targets: { codex: { skills: [] } } }, "x"), /targets\.codex\.skills/);
  assert.throws(() => validateConfig({ targets: { codex: { skills: ["../escape"] } } }, "x"), /targets\.codex\.skills/);
  // A path may not climb out of where it says it is, absolute or under ~/.
  for (const climbs of ["/abs/../x", "~/../x", "/abs/skills/.."]) {
    assert.throws(() => validateConfig({ targets: { codex: { skills: [climbs] } } }, "x"), /targets\.codex\.skills/, climbs);
  }
  assert.throws(() => validateConfig({ targets: { codex: { mcp_servers: ["bad name"] } } }, "x"), /targets\.codex\.mcp_servers/);
  assert.throws(() => validateConfig({ targets: { codex: { mcp_servers: ["a__b"] } } }, "x"), /targets\.codex\.mcp_servers/);
  assert.throws(() => validateConfig({ targets: { codex: { mcp_servers: [{ name: "docs", tools: ["x"] }] } } }, "x"), /targets\.codex\.mcp_servers/);
  assert.throws(() => validateConfig({ targets: { codex: { mcp_servers: ["docs", { name: "docs" }] } } }, "x"), /docs.*more than once/);
});

test("extensions: the legacy inheritance settings cannot be combined with any extension (review C17)", async () => {
  const { validateConfig } = await import("../dist/core/config.js");
  for (const [legacy, value, targets] of [["child_mcp", "inherit", ["claude", "codex"]], ["child_hooks", true, ["claude", "codex"]], ["child_settings", "inherit", ["claude"]]] as const) {
    for (const target of targets) {
      for (const ext of [{ skills: "user" }, { mcp_servers: ["docs"] }]) {
        assert.throws(() => validateConfig({ [legacy]: value, targets: { [target]: ext } }, "x"), new RegExp(`${legacy}.*extensions|extensions.*${legacy}`), `${legacy} with ${target} ${Object.keys(ext)[0]}`);
      }
    }
    // Alone, each is still accepted as before.
    validateConfig({ [legacy]: value }, "x");
  }
  // child_settings is about Claude Code's settings files alone: it loads nothing into a Codex agent,
  // so it does not weaken a Codex target's allowlist, and the refusal names Claude agents only.
  validateConfig({ child_settings: "inherit", targets: { codex: { skills: "user", mcp_servers: ["docs"] } } }, "x");
  assert.throws(() => validateConfig({ child_settings: "inherit", targets: { claude: { skills: "user" } } }, "x"), /in every launched Claude agent/);
});

test("extensions: MCP servers cannot be combined with network for every job or full access, nor any extension with approval requests off or any Codex extension with the exec backend (review C2/X1, X2)", async () => {
  const { validateConfig } = await import("../dist/core/config.js");
  assert.throws(() => validateConfig({ child_network: true, targets: { claude: { mcp_servers: ["docs"] } } }, "x"), /child_network/);
  assert.throws(() => validateConfig({ allow_dangerous: true, targets: { claude: { mcp_servers: ["docs"] } } }, "x"), /allow_dangerous/);
  assert.throws(() => validateConfig({ escalation: false, targets: { claude: { skills: "user" } } }, "x"), /escalation/);
  assert.throws(() => validateConfig({ codex_backend: "exec", targets: { codex: { skills: "user" } } }, "x"), /codex_backend/);
  // MCP servers alone too: a Codex turn given them has its own skills switched off and checked, which codex exec cannot do (review X2).
  assert.throws(() => validateConfig({ codex_backend: "exec", targets: { codex: { mcp_servers: ["docs"] } } }, "x"), /extensions for Codex need codex_backend "app-server"/);
  // Skills alone need no network ban, and Claude skills do not care about Codex's backend.
  validateConfig({ child_network: true, codex_backend: "exec", targets: { claude: { skills: "user" } } }, "x");
});

test("extensions: a skill's front matter is filtered fail-closed: a line relay cannot read for certain as a plain key refuses the skill (review C8)", async () => {
  const { filteredSkill } = await import("../dist/core/extensions.js");
  const skill = (front: string) => `---\nname: x\n${front}\n---\nBody.\n`;
  // Ways YAML names a key that a reading of bare keys line by line would miss, or read otherwise.
  for (const [front, why] of [
    ['description: d\n"allowed-tools": Bash(curl:*) WebFetch', "a quoted key"],
    ["description: d\n'hooks': {}", "a single-quoted key"],
    ["description: d\n<<: {model: opus}", "a merge key"],
    ["description: d\n? allowed-tools\n: Bash", "an explicit key"],
    ["description: d\n{allowed-tools: Bash}", "a flow mapping"],
    ["description: d\n&a allowed-tools: Bash", "an anchor"],
    ["description: d\n!!map allowed-tools: Bash", "a tag"],
    ["description:allowed-tools: Bash", "a colon with no space after it"],
    ["description: d\n\tallowed-tools: Bash", "a tab"],
    ["description: d\rallowed-tools: Bash", "a lone carriage return, which YAML takes for a line break"],
    ["description: d allowed-tools: Bash", "a line separator"],
    ["description: d\u0085allowed-tools: Bash", "a next-line character (U+0085), which some YAML readers take for a line break"],
    ["description: d\u2029allowed-tools: Bash", "a paragraph separator (U+2029)"],
    ["description: d\ndescription: e", "a key given twice"],
    ["description: d\n...\nallowed-tools: Bash", "a document end marker"],
  ]) {
    assert.throws(() => filteredSkill(skill(front), "x"), /front matter/, why);
  }
  // What a skill may hold: the kept keys stay as written; everything under another key goes with it.
  const out = filteredSkill(skill([
    "# a comment",
    "description: |",
    "  Test-first work.",
    "  allowed-tools: this is text inside the description",
    "allowed-tools:",
    "- Bash",
    "- Edit",
    "hooks:",
    "  PreToolUse:",
    "    - command: touch /tmp/pwned",
    "metadata:",
    "  author: someone",
    "model : opus",
  ].join("\n")), "renamed");
  assert.equal(out, [
    "---", "name: renamed", "description: |", "  Test-first work.", "  allowed-tools: this is text inside the description",
    "metadata:", "  author: someone", "---", "Body.\n",
  ].join("\n"));
});

forEachTarget((target) => {
  test(`extensions (${target}): a job is given MCP servers only once the person consents, and every call the config does not allow outright waits for the person, who alone can allow it (review C2/X1)`, async () => {
    const steps = [
      { tools: true, as: "tools" },
      { call: "ext__echo", args: { text: "hi" }, as: "echo" },
      { call: "ext__send", args: { to: "a@example.com", body: "hello" }, as: "send" },
      { call: "ext__nosuch", args: {}, as: "unknown" },
      { call: "ext__send", args: { to: 5 }, as: "malformed" },
      { reply: "tools={{tools}} echo={{echo}} send={{send}} unknown={{unknown}} malformed={{malformed}}" },
    ];
    const h = await harness([{ match: task("EXTJOB"), steps }], { targets: { [target]: { mcp_servers: [{ name: "ext", allow_tools: ["echo"] }] } } });
    const host = await personSession(h, target);
    try {
      const log = defineServers(h);
      // allow_delegation false: the agent's relay server is there for the servers alone.
      const job = await host.call("delegate", { target, task: "EXTJOB", mode: "read", allow_delegation: false, extensions: true });
      assert.ok(job.job_id, JSON.stringify(job));
      assert.deepEqual(job.extensions?.mcp_servers, [{ name: "ext", allow_tools: ["echo"] }]);
      assert.match(job.extensions_note, /only they can allow/);
      assert.doesNotMatch(job.extensions_note, /relay approve|terminal/);

      // Consent first, naming every extension; the agent has not started.
      const consent = await pendingOf(host, job.job_id, "extensions");
      assert.equal(consent.person_only, true);
      assert.match(consent.wants, /MCP servers ext/);
      assert.match(consent.wants, /echo/);
      assert.match(consent.effect, /outside its sandbox/);
      assert.match(consent.effect, /the job gets no network and no write paths outside its worktree, may not start or steer other relay agents while it has them \(its own CLI's subagents work under the same sandbox and gate\)/);
      assert.equal(h.starts().length, 0, "the agent waits for consent");
      // The question is on the person's screen: the root agent is told to wait for their answer,
      // never to allow it with user_confirmed, which allows nothing person-only.
      let note = "";
      await until(async () => {
        const s = await host.call("status", { id: job.job_id });
        note = String(s.approval_note ?? "");
        return Boolean((s.needs_approval as Rec[] | undefined)?.some((r) => r.request_id === consent.request_id && r.user_is_being_asked));
      }, 30000, "the consent to be on the person's screen");
      assert.match(note, /person_only request marked user_is_being_asked or user_dismissed_prompt, user_confirmed allows nothing/);
      assert.doesNotMatch(note, /allow only with user_confirmed/);
      // relay tree names them too, and that consent is not given yet.
      assert.match(h.cli("tree"), /\+ extensions: MCP servers ext \(echo without asking\); consent not given yet/);
      // The root agent cannot give it, whatever it says the user said, and no command can.
      const byAgent = await host.call("approve", { request_id: consent.request_id, decision: "allow" });
      assert.equal(byAgent.refused, true);
      assert.match(byAgent.reason, /only the user can allow/);
      assert.equal((await host.call("approve", { request_id: consent.request_id, decision: "allow", user_confirmed: true })).refused, true);
      assert.equal(JSON.parse(h.cli("approve", consent.request_id)).refused, true);
      assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", consent.request_id)[0].status, "pending");
      // The person, in relay's question, which says that only they can allow it and names every extension.
      await host.answers(consent);
      const asked = host.questions.find((q) => q.includes(consent.wants))!;
      assert.ok(asked, JSON.stringify(host.questions));
      assert.match(asked, /Only you can allow this: the agent supervising the run can only deny it\./);

      // The tool the config allows outright runs at once; the other waits, and nothing reaches the server meanwhile.
      const call = await pendingOf(host, job.job_id, "mcp");
      assert.equal(call.person_only, true);
      assert.equal(call.wants, 'ext.send {"to":"a@example.com","body":"hello"}');
      assert.equal(calls(log, "echo").length, 1);
      assert.equal(calls(log, "send").length, 0, "nothing is forwarded before the person allows it");
      assert.match((await host.call("approve", { request_id: call.request_id, decision: "allow" })).reason, /only the user can allow/);
      await host.answers(call);

      const done = await settled(host, job.job_id);
      assert.equal(done.status, "done", JSON.stringify(done));
      // Exactly the arguments shown, once; an unknown tool and malformed arguments reach nobody and ask nobody.
      assert.deepEqual(calls(log, "send").map((c) => c.args), [{ to: "a@example.com", body: "hello" }]);
      assert.equal(h.sql("SELECT count(*) AS n FROM requests WHERE kind = 'mcp'")[0].n, 1);
      const final = h.ends().at(-1)!;
      assert.match(final.reply, /ext__echo/);
      assert.match(final.reply, /ext__send/);
      assert.match(final.reply, /unknown=\{"error":/);
      assert.match(final.reply, /malformed=\{"error":/);
      // The server got its own environment, and none of relay's identity.
      const started = extLog(log).find((e) => e.started)!;
      assert.equal(started.secret, "s3cret");
      assert.deepEqual(started.relay_vars, []);
      // The server is never configured in the agent's own CLI, where its calls would not pass relay's gate: only relay is.
      const argv = h.starts().at(-1)!.argv as string[];
      if (target === "claude") {
        const mcp = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8"));
        assert.deepEqual(Object.keys(mcp.mcpServers), ["relay"]);
      } else {
        const set = argv.filter((_, i) => argv[i - 1] === "-c");
        assert.deepEqual(set.filter((c) => /^mcp_servers\./.test(c) && !/^mcp_servers\.relay\./.test(c) && !/\.enabled=false$/.test(c)), []);
        // A call waiting for the person is not cut off by Codex first: relay's entry outlasts the approval wait (3600 s by default).
        assert.ok(set.includes("mcp_servers.relay.tool_timeout_sec=11400"), JSON.stringify(set.filter((c) => c.includes("timeout"))));
      }
      assert.ok(!argv.join(" ").includes("ext-server"), "the server's command is in nothing the agent's CLI was given");
      // What the job was given is in its status.
      const view = await host.call("status", { id: job.job_id });
      assert.deepEqual(view.extensions.mcp_servers, [{ name: "ext", allow_tools: ["echo"] }]);
      assert.equal(view.extensions.consent, "given by the user in relay's approval dialog");
      assert.match(h.cli("tree"), /\+ extensions: MCP servers ext \(echo without asking\); consent given by the user in relay's approval dialog/);
    } finally {
      await host.close();
      await h.close();
    }
  });
});

test("extensions: a denied consent fails the turn before the agent starts; a denied call is never forwarded, and the agent is told not to work around it", async () => {
  const steps = [{ call: "ext__send", args: { to: "x", body: "y" }, as: "send" }, { reply: "send={{send}}" }];
  const h = await harness([{ match: task("DENIED"), steps }], { targets: { codex: { mcp_servers: ["ext"] } } });
  const host = await personSession(h, "codex");
  try {
    const log = defineServers(h);
    const first = await host.call("delegate", { target: "codex", task: "DENIED", mode: "read", extensions: true });
    const consent = await pendingOf(host, first.job_id, "extensions");
    assert.equal((await host.call("approve", { request_id: consent.request_id, decision: "deny" })).decision, "denied", "the root agent may deny");
    const failed = await settled(host, first.job_id);
    assert.equal(failed.status, "failed");
    // Said as relay recorded who decided: the root session, not the user.
    assert.match(failed.error, /consent to the extensions this job was given was refused by the root session supervising this run, not by the user/);
    assert.doesNotMatch(failed.error, /the user did not consent/);
    assert.equal(h.starts().length, 0, "the agent never started");
    // Continued, it is asked again; a denial from a terminal is said as one.
    const resumed = await host.call("resume", { job_id: first.job_id, message: "go on" });
    assert.notEqual(resumed.refused, true, JSON.stringify(resumed));
    const again = await pendingOf(host, first.job_id, "extensions");
    assert.notEqual(again.request_id, consent.request_id);
    assert.equal(JSON.parse(h.cli("deny", again.request_id)).decision, "denied");
    const refusedAgain = await settled(host, first.job_id);
    assert.equal(refusedAgain.status, "failed");
    // relay approve takes no person-only request, so only relay deny can have refused it from there.
    assert.match(refusedAgain.error, /was refused from a terminal \(relay deny\)/);
    assert.equal(h.sql("SELECT count(*) AS n FROM requests WHERE kind = 'extensions' AND node_id = ?", first.job_id)[0].n, 2);
    assert.equal(h.starts().length, 0, "the agent never started");

    // Cancelled while it waits for consent, the job is cancelled, not refused by anyone.
    const third = await host.call("delegate", { target: "codex", task: "DENIED", mode: "read", extensions: true });
    await pendingOf(host, third.job_id, "extensions");
    await host.call("cancel", { id: third.job_id });
    const cancelled = await settled(host, third.job_id);
    assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
    assert.doesNotMatch(JSON.stringify(cancelled), /consent to the extensions .* was refused|nobody consented/);
    await until(() => h.sql("SELECT status FROM turns WHERE node_id = ?", third.job_id)[0]?.status === "cancelled", 30000, "the turn to be recorded as cancelled");

    const second = await host.call("delegate", { target: "codex", task: "DENIED", mode: "read", extensions: true });
    await host.answers(await pendingOf(host, second.job_id, "extensions"));
    const call = await pendingOf(host, second.job_id, "mcp");
    assert.equal((await host.call("approve", { request_id: call.request_id, decision: "deny" })).decision, "denied");
    await settled(host, second.job_id);
    assert.equal(calls(log, "send").length, 0);
    assert.match(h.ends().at(-1)!.reply, /Not approved.*do not try to reach/i);
  } finally {
    await host.close();
    await h.close();
  }
});

test("extensions: consent nobody gives in time fails the turn before the agent starts, saying nobody consented", async () => {
  const h = await harness([{ match: task("NOANSWER"), steps: [{ reply: "ok" }] }], { approval_timeout_s: 2, targets: { codex: { mcp_servers: ["ext"] } } });
  const host = await personSession(h, "codex");
  try {
    defineServers(h);
    const job = await host.call("delegate", { target: "codex", task: "NOANSWER", mode: "read", extensions: true });
    // The person never answers relay's question.
    const s = await settled(host, job.job_id);
    assert.equal(s.status, "failed", JSON.stringify(s));
    assert.deepEqual(h.sql("SELECT status FROM requests WHERE kind = 'extensions' AND node_id = ?", job.job_id).map((r) => r.status), ["expired"]);
    assert.match(s.error, /nobody consented to the extensions this job was given/);
    assert.doesNotMatch(s.error, /was refused/);
    assert.equal(h.starts().length, 0, "the agent never started");
  } finally {
    await host.close();
    await h.close();
  }
});

test("extensions: consent through the root session's permission prompt (confirm) counts as the person's", async () => {
  const h = await harness([{ match: task("CONFIRMED"), steps: [{ tools: true, as: "tools" }, { reply: "{{tools}}" }] }], { targets: { codex: { mcp_servers: ["ext"] } } });
  try {
    defineServers(h);
    const host = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"] });
    const job = await host.call("delegate", { target: "codex", task: "CONFIRMED", mode: "read", extensions: true });
    const req = await pendingOf(host, job.job_id, "extensions");
    // The root agent is pointed at confirm, not at a command.
    const byAgent = await host.call("approve", { request_id: req.request_id, decision: "allow" });
    assert.match(byAgent.reason, /call confirm/);
    assert.doesNotMatch(byAgent.reason, /run `relay approve/);
    const ok = await host.call("confirm", { request_id: req.request_id, from: req.from, wants: req.wants, kind: req.kind, effect: req.effect, in_directory: req.in_directory });
    assert.equal(ok.decision, "allowed", JSON.stringify(ok));
    const done = await settled(host, job.job_id);
    assert.equal(done.status, "done");
    assert.match(h.ends().at(-1)!.reply, /ext__send/);
    assert.match((await host.call("status", { id: job.job_id })).extensions.consent, /permission prompt/);
  } finally {
    await h.close();
  }
});

test("extensions: a notice of a request only the person can allow says so, and leaves it to them", async () => {
  const h = await harness([{ match: task("NOTICED"), steps: [{ reply: "ok" }] }], { targets: { codex: { mcp_servers: ["ext"] } } });
  try {
    defineServers(h);
    const inbox = await h.inbox();
    // Claude Code with confirm and an inbox, and no approval dialog: the request is handed to the session by a notice.
    const host = await h.instance({ ...INTERACTIVE_CLAUDE, env: { ...INTERACTIVE_CLAUDE.env, ...inbox.env }, args: ["--host", "claude"] });
    try {
      const job = await host.call("delegate", { target: "codex", task: "NOTICED", mode: "read", extensions: true });
      await until(() => inbox.posts().some((p) => p.text.includes("needs approval")), 30000, "the approval notice");
      const request = h.sql("SELECT id FROM requests WHERE kind = 'extensions'")[0].id;
      const notice = inbox.posts().find((p) => p.text.includes(request))!.text;
      assert.match(notice, new RegExp(`job ${job.job_id} needs approval ${request}, which only the user can allow\\. Call status ${job.job_id}, then leave it to them \\(relay's question, or confirm where you have it\\) or deny it\\.$`));
      assert.doesNotMatch(notice, /then approve or deny it/);
      await host.call("cancel", { id: job.job_id });
    } finally {
      await host.close();
    }
  } finally {
    await h.close();
  }
});

test("extensions: unqualified hosts get no dialog even under always; consent stays pending and only explicit denial decides (review C2/X1)", async () => {
  const h = await harness([{ match: task("NOROUTE"), steps: [{ reply: "ok" }] }], { ask_user: "always", targets: { codex: { mcp_servers: ["ext"] } } });
  try {
    defineServers(h);
    // A host with neither relay's question for a person nor confirm: nobody could consent.
    const none = await h.call("delegate", { target: "codex", task: "NOROUTE", mode: "read", extensions: true });
    assert.equal(none.refused, true);
    assert.match(none.reason, /only the user can consent to extensions/);
    assert.match(none.reason, /this session has neither/);
    // Claude Code that relay cannot tell is interactive gets no question under "always",
    // and a session there gives no extensions either.
    const unsureHost = { clientInfo: INTERACTIVE_CLAUDE.clientInfo, args: ["--host", "claude"] };
    const unsure = await h.instance({ ...unsureHost, elicit: () => ({ action: "accept", content: { decision: "allow" } }) });
    assert.match((await unsure.call("delegate", { target: "codex", task: "NOROUTE", mode: "read", extensions: true })).reason, /only the user can consent/);
    await unsure.close();

    // A run started where the person could consent and then adopted by such a host (D9: the person
    // authorizes the transfer explicitly): no dialog is offered, so the request stays pending.
    const host = await personSession(h, "codex");
    const job = await host.call("delegate", { target: "codex", task: "NOROUTE", mode: "read", extensions: true });
    const consent = await pendingOf(host, job.job_id, "extensions");
    await host.close();
    let asked = 0;
    const later = await h.instance({ ...unsureHost, elicit: () => (asked++, { action: "accept", content: { decision: "allow" } }) });
    try {
      await adoptRun(h, later, job.job_id);
      const status = await later.call("status", { id: job.job_id });
      assert.equal(status.approval_dialogs.offered, false);
      assert.match(status.approval_dialogs.reason, /not positively identified as interactive/);
      assert.equal(asked, 0);
      assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", consent.request_id)[0].status, "pending");
      assert.equal(h.starts().length, 0, "the agent waits for the person");
    } finally {
      await later.close();
    }
    // An explicit deny through approve still binds: a denial cannot bypass the consent gate.
    const again = await personSession(h, "codex");
    const job2 = await again.call("delegate", { target: "codex", task: "NOROUTE", mode: "read", extensions: true });
    const consent2 = await pendingOf(again, job2.job_id, "extensions");
    await again.close();
    const denier = await h.instance({ ...unsureHost, elicit: () => (asked++, { action: "accept", content: { decision: "deny" } }) });
    try {
      await adoptRun(h, denier, job2.job_id);
      assert.equal((await denier.call("status", { id: job2.job_id })).approval_dialogs.offered, false);
      assert.equal(asked, 0);
      await denier.call("approve", { request_id: consent2.request_id, decision: "deny" });
      const s = await settled(denier, job2.job_id);
      assert.equal(s.status, "failed", JSON.stringify(s));
      assert.match(s.error, /consent to the extensions this job was given was refused/);
      assert.equal(h.starts().length, 0, "no agent started");
    } finally {
      await denier.close();
    }
  } finally {
    await h.close();
  }
});

test("extensions: a session holding MCP servers gets no network and no write paths outside its worktree, on any call that starts or continues it (review C2/X1)", async () => {
  const steps = [{ request: "curl https://mail.example.com/send" }, { reply: "asked={{last}}" }];
  const h = await harness([{ match: task("NONET"), steps }, { match: "QNONET", steps: [{ reply: "ok" }] }], { targets: { codex: { mcp_servers: ["ext"] } } });
  const host = await personSession(h, "codex");
  try {
    defineServers(h);
    const net = await host.call("delegate", { target: "codex", task: "NONET", mode: "write", extensions: true, grant: { network: true } });
    assert.equal(net.refused, true);
    assert.match(net.reason, /network/);
    // A file outside the worktree would be a way round the gate too: only the person may allow one, never the root agent's grant.
    const granted = path.join(path.dirname(h.repo), "granted");
    fs.mkdirSync(granted);
    const wide = await host.call("delegate", { target: "codex", task: "NONET", mode: "write", extensions: true, grant: { write_paths: [granted] } });
    assert.equal(wide.refused, true, JSON.stringify(wide));
    assert.match(wide.reason, /a session given MCP servers gets no write paths outside its worktree/);
    assert.equal(h.sql("SELECT count(*) AS n FROM nodes")[0].n, 0, "nothing was started");
    const askNet = await host.call("ask", { target: "codex", message: "QNONET", extensions: true, grant: { network: true } });
    assert.equal(askNet.refused, true);
    assert.match(askNet.reason, /network/);

    const job = await host.call("delegate", { target: "codex", task: "NONET", mode: "write", extensions: true });
    await host.answers(await pendingOf(host, job.job_id, "extensions"));
    // A command outside the sandbox could reach the service directly: the root agent cannot allow it.
    const cmd = await pendingOf(host, job.job_id, "command");
    assert.equal(cmd.person_only, true);
    assert.match((await host.call("approve", { request_id: cmd.request_id, decision: "allow" })).reason, /only the user can allow/);
    assert.equal((await host.call("approve", { request_id: cmd.request_id, decision: "deny" })).decision, "denied");
    await settled(host, job.job_id);
    const resumed = await host.call("resume", { job_id: job.job_id, message: "more", grant: { network: true } });
    assert.equal(resumed.refused, true);
    assert.match(resumed.reason, /network/);
    const widened = await host.call("resume", { job_id: job.job_id, message: "more", grant: { write_paths: [granted] } });
    assert.equal(widened.refused, true, JSON.stringify(widened));
    assert.match(widened.reason, /no write paths outside its worktree/);
    assert.equal(h.sql("SELECT count(*) AS n FROM turns WHERE node_id = ?", job.job_id)[0].n, 1, "no turn was queued");
    // Borrowed into a discussion it keeps its servers, and so gets no network there either.
    const discussed = await host.call("discuss", { with: job.job_id, topic: "t", message: "m", grant: { network: true } });
    assert.equal(discussed.refused, true);
    assert.match(discussed.reason, /network/);

    // A consult thread: a follow-up cannot give it the network either.
    const asking = host.call("ask", { target: "codex", message: "QNONET", extensions: true });
    const thread = await firstThread(h);
    await host.answers(await pendingOf(host, thread, "extensions"));
    await asking;
    await settled(host, thread);
    const followUp = await host.call("ask", { thread_id: thread, message: "QNONET again", grant: { network: true } });
    assert.equal(followUp.refused, true);
    assert.match(followUp.reason, /network/);
    const borrowed = await host.call("discuss", { with: thread, topic: "t", message: "m", grant: { network: true } });
    assert.equal(borrowed.refused, true);
    assert.match(borrowed.reason, /network/);
  } finally {
    await host.close();
    await h.close();
  }
});

test("extensions: a session holding MCP servers may not start or steer other agents, so none of its limits can be left behind in a child (review C2/X1, X2)", async () => {
  const h = await harness([{ match: task("HOLDER"), steps: [{ reply: "ok" }] }, { match: task("KID"), steps: [{ reply: "ok" }] }], { targets: { codex: { mcp_servers: ["ext"] } } });
  const host = await personSession(h, "codex");
  try {
    defineServers(h);
    // Asked for outright, it is refused; otherwise it is off.
    const explicit = await host.call("delegate", { target: "codex", task: "HOLDER", mode: "read", extensions: true, allow_delegation: true });
    assert.equal(explicit.refused, true);
    assert.match(explicit.reason, /may not start other agents/);
    const job = await host.call("delegate", { target: "codex", task: "HOLDER", mode: "read", extensions: true });
    assert.equal(h.sql("SELECT allow_delegation FROM nodes WHERE id = ?", job.job_id)[0].allow_delegation, 0);
    await host.answers(await pendingOf(host, job.job_id, "extensions"));
    assert.equal((await settled(host, job.job_id)).status, "done");
    // Its turn's relay server was told it may not delegate.
    const dir = path.dirname(h.sql("SELECT log_path FROM nodes WHERE id = ?", job.job_id)[0].log_path);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "context.json"), "utf8")).may_delegate, false);
    // That is the servers' rule, not only allow_delegation's: with the session's allow_delegation
    // set (nothing relay offers does this), its next turn still may not delegate.
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(path.join(h.home, "relay.db"));
    d.prepare("UPDATE nodes SET allow_delegation = 1 WHERE id = ?").run(job.job_id);
    d.close();
    const more = await host.call("resume", { job_id: job.job_id, message: "more" });
    assert.notEqual(more.refused, true, JSON.stringify(more));
    await until(() => h.sql("SELECT count(*) AS n FROM turns WHERE node_id = ? AND status NOT IN ('queued', 'running')", job.job_id)[0].n === 2, 60000, "the second turn to end");
    // The context file is the second turn's, and that turn ran.
    const second = h.sql("SELECT id, status FROM turns WHERE node_id = ? ORDER BY id", job.job_id)[1];
    assert.equal(second.status, "done", JSON.stringify(second));
    const context = JSON.parse(fs.readFileSync(path.join(dir, "context.json"), "utf8"));
    assert.equal(context.turn_id, second.id);
    assert.equal(context.may_delegate, false);

    // Even under a turn policy that says it may, the session's servers decide.
    const child = await h.instance(await h.childOf(job.job_id, { access: "read", may_delegate: true }));
    try {
      for (const [tool, args] of [
        ["delegate", { target: "claude", task: "KID", mode: "read" }],
        ["ask", { target: "claude", message: "KID" }],
        ["discuss", { target: "claude", topic: "t", message: "KID" }],
        ["review", { reviewer: "claude", target: "HEAD" }],
        // Steering an item that exists, its own session included, is refused the same way.
        ["resume", { job_id: job.job_id, message: "KID" }],
      ] as const) {
        const r = await child.call(tool, args);
        assert.equal(r.refused, true, `${tool}: ${JSON.stringify(r)}`);
        assert.match(r.reason, /holds MCP servers, so it may not start or steer other agents/, tool);
      }
      assert.equal(h.sql("SELECT count(*) AS n FROM nodes WHERE id != ?", job.job_id)[0].n, 0, "it started nothing");
    } finally {
      await child.close();
    }
  } finally {
    await host.close();
    await h.close();
  }
});

test("extensions: only a root session gives extensions, and a launched agent cannot steer an item holding more of them than it does (review X2)", async () => {
  const h = await harness([{ match: task("PARENT"), steps: [{ reply: "ok" }] }, { match: task("KID"), steps: [{ reply: "ok" }] }], { targets: { codex: { mcp_servers: ["ext"] }, claude: { mcp_servers: ["ext"] } } });
  try {
    defineServers(h);
    const parent = await h.call("delegate", { target: "codex", task: "PARENT", mode: "read" });
    await settled(h, parent.job_id);
    const child = await h.instance(await h.childOf(parent.job_id, { access: "read" }));
    try {
      const asked = await child.call("delegate", { target: "claude", task: "KID", mode: "read", extensions: true });
      assert.equal(asked.refused, true);
      assert.match(asked.reason, /only the root session can give extensions/);
      const consult = await child.call("ask", { target: "claude", message: "KID", extensions: true });
      assert.equal(consult.refused, true);

      const kid = await child.call("delegate", { target: "claude", task: "KID", mode: "read" });
      await settled(h, kid.job_id);
      // As if a session held extensions (nothing relay offers makes this happen for one a launched agent started).
      const { DatabaseSync } = await import("node:sqlite");
      const hold = (id: string, extensions: Rec | undefined) => {
        const params = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", id)[0].params_json);
        if (extensions) params.extensions = { ...extensions, consent: { by: "test", at: Date.now() } };
        else delete params.extensions;
        const d = new DatabaseSync(path.join(h.home, "relay.db"));
        d.prepare("UPDATE nodes SET params_json = ? WHERE id = ?").run(JSON.stringify(params), id);
        d.close();
      };
      // A skill its starter does not hold, and a server: each is more than the starter has.
      for (const extensions of [
        { skills: [{ name: "alpha", source: "/x/alpha" }], mcp_servers: [] },
        { skills: [], mcp_servers: [{ name: "ext", allow_tools: [] }] },
      ]) {
        hold(kid.job_id, extensions);
        const what = JSON.stringify(extensions);
        const resumed = await child.call("resume", { job_id: kid.job_id, message: "go on" });
        assert.equal(resumed.refused, true, what);
        assert.match(resumed.reason, /more access than your current turn/, what);
        assert.match((await child.call("cancel", { id: kid.job_id })).reason, /more access than your current turn/, what);
        const borrowed = await child.call("discuss", { with: kid.job_id, topic: "t", message: "m" });
        assert.equal(borrowed.refused, true, what);
        assert.match(borrowed.reason, /more access than your current turn/, what);
      }
      // A tool that runs without asking counts on its own: the same server with it is more than without.
      // (A starter holding a server may only cancel: it starts and steers nothing else.)
      hold(parent.job_id, { skills: [], mcp_servers: [{ name: "ext", allow_tools: [] }] });
      hold(kid.job_id, { skills: [], mcp_servers: [{ name: "ext", allow_tools: ["echo"] }] });
      assert.match((await child.call("cancel", { id: kid.job_id })).reason, /more access than your current turn/);
      hold(parent.job_id, { skills: [], mcp_servers: [{ name: "ext", allow_tools: ["echo"] }] });
      assert.equal((await child.call("cancel", { id: kid.job_id })).refused, undefined, "holding as much, it may");
    } finally {
      await child.close();
    }
  } finally {
    await h.close();
  }
});

test("extensions: a Codex subagent thread gives none, as it gives no grant: no person is working in it (review C6, X2)", async () => {
  // Codex marks the calls of a native subagent thread in their _meta (see codex-subagent.test.ts).
  const subagent = { "x-codex-turn-metadata": { thread_source: "subagent", session_id: "s", thread_id: "t" } };
  const userThread = { "x-codex-turn-metadata": { thread_source: "user", session_id: "s", thread_id: "t" } };
  const h = await harness([{ match: task("SUBEXT"), steps: [{ reply: "ok" }] }, { match: "QSUBEXT", steps: [{ reply: "ok" }] }], { targets: { claude: { mcp_servers: ["ext"] } } });
  const host = await personSession(h, "claude");
  try {
    defineServers(h);
    for (const [tool, args] of [
      ["delegate", { target: "claude", task: "SUBEXT", mode: "read", extensions: true }],
      ["ask", { target: "claude", message: "QSUBEXT", extensions: true }],
    ] as const) {
      const r = await host.call(tool, args, { meta: subagent });
      assert.equal(r.refused, true, `${tool}: ${JSON.stringify(r)}`);
      assert.match(r.reason, /Codex subagent thread, which no person is working in, so it cannot give extensions/, tool);
      assert.match(r.reason, /make this call itself, from its own thread/, tool);
    }
    assert.equal(h.sql("SELECT count(*) AS n FROM nodes")[0].n, 0, "nothing was started");
    assert.equal(h.sql("SELECT count(*) AS n FROM requests")[0].n, 0, "nobody was asked");
    // The same session's calls from a thread a person is working in give them, and the person is asked.
    const job = await host.call("delegate", { target: "claude", task: "SUBEXT", mode: "read", extensions: true }, { meta: userThread });
    assert.ok(job.job_id, JSON.stringify(job));
    await pendingOf(host, job.job_id, "extensions");
    await host.call("cancel", { id: job.job_id });
  } finally {
    await host.close();
    await h.close();
  }
});

test("extensions: a call asking for extensions is refused where the target has none configured, cannot take them, or names a server relay's file does not define", async () => {
  const h = await harness([], { targets: { claude: { mcp_servers: ["ext", "missing"] }, copilot: { enabled: true, experimental: true, bin: STUB_ACP } } });
  const forCodex = await personSession(h, "codex");
  const forClaude = await personSession(h, "claude");
  try {
    const none = await forCodex.call("delegate", { target: "codex", task: "x", mode: "read", extensions: true });
    assert.equal(none.refused, true);
    assert.match(none.reason, /targets\.codex/);
    // No mcp.json yet.
    const nofile = await forClaude.call("delegate", { target: "claude", task: "x", mode: "read", extensions: true });
    assert.equal(nofile.refused, true);
    assert.match(nofile.reason, /MCP definitions file .*mcp\.json does not exist/);
    defineServers(h);
    const missing = await forClaude.call("delegate", { target: "claude", task: "x", mode: "read", extensions: true });
    assert.equal(missing.refused, true);
    assert.match(missing.reason, /missing is named in targets\.claude\.mcp_servers but not defined in .*mcp\.json/);
    // An ACP target (Copilot, here switched on as experimental) runs inside relay's own sandbox and takes none.
    for (const [tool, args] of [
      ["delegate", { target: "copilot", model: "claude-sonnet-5.5", task: "x", mode: "read", extensions: true }],
      ["ask", { target: "copilot", model: "claude-sonnet-5.5", message: "x", extensions: true }],
    ] as const) {
      const acp = await forClaude.call(tool, args);
      assert.equal(acp.refused, true, `${tool}: ${JSON.stringify(acp)}`);
      if (process.platform === "darwin") assert.match(acp.reason, /relay gives extensions only to Claude and Codex agents; Copilot .*takes none/, tool);
    }
    // From a session where relay could not ask the person either, the target's refusal comes first:
    // having the user start the work elsewhere would not change it.
    const nowhere = await h.call("delegate", { target: "copilot", model: "claude-sonnet-5.5", task: "x", mode: "read", extensions: true });
    assert.equal(nowhere.refused, true, JSON.stringify(nowhere));
    if (process.platform === "darwin") {
      assert.match(nowhere.reason, /relay gives extensions only to Claude and Codex agents; Copilot .*takes none/);
      assert.doesNotMatch(nowhere.reason, /only the user can consent/);
    }
    assert.equal(h.sql("SELECT count(*) AS n FROM nodes")[0].n, 0, "nothing was started");
  } finally {
    await forCodex.close();
    await forClaude.close();
    await h.close();
  }
});

test("extensions: relay's own config files are out of every job's reach, by either name of a linked config.json and in any case of a name where the disk ignores case, and nothing beside them is (review C2/X1)", async () => {
  // The production layout: config.json and mcp.json outside relay's control directory, config.json
  // a link into a synced repository (docs/UPGRADING.md).
  const outside = nonTempScratch("relay-config-");
  const looked = path.join(outside, "dot-config", "relay");
  const synced = path.join(outside, "dotfiles", "relay");
  const beside = path.join(outside, "project");
  for (const d of [looked, synced, beside]) fs.mkdirSync(d, { recursive: true });
  // macOS's default disks do not tell names apart by case: there, a name in another case is the same file.
  const upper = (p: string) => path.join(outside, path.relative(outside, p).toUpperCase());
  const caseless = fs.existsSync(upper(looked));
  const edits = [
    path.join(looked, "mcp.json"), path.join(looked, "config.json"), path.join(synced, "config.json"),
    ...(caseless ? [upper(path.join(looked, "mcp.json")), upper(path.join(synced, "config.json"))] : []),
  ];
  const h = await harness([
    { match: task("EDITS"), steps: [...edits.map((p) => ({ request: { edit: p } })), { reply: "done" }] },
    { match: task("BESIDE"), steps: [{ reply: "ok" }] },
  ], {}, { RELAY_CONFIG: path.join(looked, "config.json") });
  try {
    fs.copyFileSync(path.join(h.home, "config.json"), path.join(synced, "config.json"));
    fs.symlinkSync(path.join(synced, "config.json"), path.join(looked, "config.json"));
    defineServers(h, {}, looked);
    const variants = caseless ? [upper(looked), upper(synced), upper(path.dirname(synced)), path.join(path.dirname(outside), path.basename(outside).toUpperCase())] : [];
    for (const dir of [looked, synced, path.dirname(synced), outside, ...variants]) {
      const r = await h.call("delegate", { target: "codex", task: "GRANT", mode: "write", grant: { write_paths: [dir] } });
      assert.equal(r.refused, true, `${dir}: ${JSON.stringify(r)}`);
      assert.match(r.reason, /overlaps relay's config file/, dir);
    }
    // So is relay's control directory, by a name in another case.
    if (caseless) {
      const home = path.join(path.dirname(h.home), path.basename(h.home).toUpperCase());
      const r = await h.call("delegate", { target: "codex", task: "GRANT", mode: "write", grant: { write_paths: [home] } });
      assert.equal(r.refused, true, JSON.stringify(r));
      assert.match(r.reason, /overlaps relay's control directory/);
    }
    // A directory beside them is not relay's.
    const near = await h.call("delegate", { target: "codex", task: "BESIDE", mode: "write", grant: { write_paths: [beside] }, background: false });
    assert.equal(near.status, "done", JSON.stringify(near));
    // A file request for either file, by any name, is refused on the spot: nobody is asked.
    const job = await h.call("delegate", { target: "claude", task: "EDITS", mode: "write", background: false });
    assert.ok(job.job_id, JSON.stringify(job));
    const results = (h.ends().at(-1)!.calls as Rec[]).filter((c) => c.tool === "(approval request)").map((c) => JSON.stringify(c.result));
    assert.equal(results.length, edits.length);
    for (const r of results) {
      assert.match(r, /is relay's own config file .*config\.json|is relay's own config file .*mcp\.json/);
      assert.match(r, /which no job may change/);
      assert.doesNotMatch(r, /inside relay's own directories/);
    }
    assert.equal(h.sql("SELECT count(*) AS n FROM requests")[0].n, 0);
  } finally {
    await h.close();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("extensions: a name for relay's config files or a directory holding one is recognised in any case where the disk ignores case, before mcp.json exists too", async () => {
  const { touchesConfig } = await import("../dist/core/extensions.js");
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-case-")));
  const saved = process.env.RELAY_CONFIG;
  try {
    fs.mkdirSync(path.join(d, "Cfg2", "relay"), { recursive: true });
    fs.mkdirSync(path.join(d, "synced", "relay"), { recursive: true });
    fs.writeFileSync(path.join(d, "synced", "relay", "config.json"), "{}");
    fs.symlinkSync(path.join(d, "synced", "relay", "config.json"), path.join(d, "Cfg2", "relay", "config.json"));
    process.env.RELAY_CONFIG = path.join(d, "Cfg2", "relay", "config.json");
    for (const p of [path.join(d, "Cfg2", "relay", "mcp.json"), path.join(d, "Cfg2", "relay"), path.join(d, "Cfg2"), path.join(d, "synced"), path.join(d, "synced", "relay", "config.json")]) {
      assert.ok(touchesConfig(p), p);
    }
    for (const p of [path.join(d, "other"), path.join(d, "Cfg"), path.join(d, "Cfg2", "relay", "notes.md"), path.join(d, "synced", "relay", "other.json")]) {
      assert.equal(touchesConfig(p), undefined, p);
    }
    if (fs.existsSync(path.join(d, "CFG2"))) {
      // mcp.json does not exist yet: a file made under another case of its name would be the one relay reads.
      for (const r of ["CFG2/relay", "CFG2/relay/mcp.json", "Cfg2/RELAY/MCP.JSON", "cfg2", "SYNCED/relay", "Synced", "CFG2/Relay/Config.JSON"]) {
        assert.ok(touchesConfig(path.join(d, r)), r);
      }
    }
  } finally {
    if (saved === undefined) delete process.env.RELAY_CONFIG;
    else process.env.RELAY_CONFIG = saved;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// On macOS the data volume names every firmlinked directory a second way (/System/Volumes/Data/Users
// is /Users), and realpath(3) keeps whichever name it is given: relay's own paths must be kept out by both.
const DATA_VOLUME = "/System/Volumes/Data";
const firmlinked = (p: string): boolean => {
  try {
    const a = fs.statSync(p);
    const b = fs.statSync(path.join(DATA_VOLUME, p));
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
};

test("extensions: relay's config files and its control directory are kept out by the data volume's name for them too (macOS)", async (t) => {
  const outside = nonTempScratch("relay-firm-");
  if (process.platform !== "darwin" || !firmlinked(outside)) {
    fs.rmSync(outside, { recursive: true, force: true });
    return t.skip("no data-volume name for the temporary directory here");
  }
  const looked = path.join(outside, "dot-config", "relay");
  fs.mkdirSync(looked, { recursive: true });
  const alias = (p: string) => path.join(DATA_VOLUME, p);
  const edits = [alias(path.join(looked, "mcp.json")), alias(path.join(looked, "config.json"))];
  const h = await harness([{ match: task("EDITS"), steps: [...edits.map((p) => ({ request: { edit: p } })), { reply: "done" }] }], {}, { RELAY_CONFIG: path.join(looked, "config.json") });
  const saved = process.env.RELAY_CONFIG;
  try {
    fs.copyFileSync(path.join(h.home, "config.json"), path.join(looked, "config.json"));
    const { touchesConfig } = await import("../dist/core/extensions.js");
    process.env.RELAY_CONFIG = path.join(looked, "config.json");
    // mcp.json does not exist yet, and then does.
    for (const p of [alias(path.join(looked, "mcp.json")), alias(looked), alias(outside), DATA_VOLUME]) assert.ok(touchesConfig(p), p);
    defineServers(h, {}, looked);
    for (const p of [alias(path.join(looked, "mcp.json")), alias(path.join(looked, "config.json"))]) assert.ok(touchesConfig(p), p);
    assert.equal(touchesConfig(alias(path.join(outside, "other"))), undefined);
    // No grant covers them, nor relay's control directory, by that name.
    for (const [dir, why] of [[alias(looked), /overlaps relay's config file/], [alias(h.home), /overlaps relay's control directory/]] as const) {
      const r = await h.call("delegate", { target: "codex", task: "GRANT", mode: "write", grant: { write_paths: [dir] } });
      assert.equal(r.refused, true, `${dir}: ${JSON.stringify(r)}`);
      assert.match(r.reason, why, dir);
    }
    // A file request for either file by that name is refused on the spot: nobody is asked.
    const job = await h.call("delegate", { target: "claude", task: "EDITS", mode: "write", background: false });
    assert.ok(job.job_id, JSON.stringify(job));
    const results = (h.ends().at(-1)!.calls as Rec[]).filter((c) => c.tool === "(approval request)").map((c) => JSON.stringify(c.result));
    assert.equal(results.length, edits.length);
    for (const r of results) assert.match(r, /relay's own config file .*which no job may change/);
    assert.equal(h.sql("SELECT count(*) AS n FROM requests")[0].n, 0);
  } finally {
    if (saved === undefined) delete process.env.RELAY_CONFIG;
    else process.env.RELAY_CONFIG = saved;
    await h.close();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

/** Writes a skill directory, its SKILL.md with the front matter given (and a body), plus extra files. */
function writeSkill(dir: string, name: string, front: string, files: Record<string, string> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n${front}---\n\nThe body of ${name}.\n`);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
}

const RISKY_FRONT = "description: Test-first work.\nallowed-tools: Bash, Edit\nhooks:\n  PreToolUse:\n    - command: touch /tmp/pwned\nmodel: opus\n";

test("extensions (claude): skills go to the agent as a filtered package of relay's own, loaded as a plugin for the session and checked in Claude's init report (review C8)", async () => {
  const h = await harness([{ match: task("SKILLS"), steps: [{ reply: "ok" }] }], { targets: { claude: { skills: ["alpha"] } } });
  const host = await personSession(h, "claude");
  try {
    const home = h.env.HOME;
    // Harness metadata (agents/, SKILL.json, where Codex reads MCP dependencies), a dot-file, and a
    // SKILL.md below the skill's top, which Codex would load as a skill of its own, unfiltered.
    writeSkill(path.join(home, ".claude", "skills", "alpha"), "alpha", RISKY_FRONT, {
      "reference.md": "more", "agents/openai.yaml": "dependencies: {}", "scripts/run.sh": "echo hi",
      "SKILL.json": JSON.stringify({ dependencies: { tools: [{ type: "mcp", value: "mail", transport: "stdio", command: "mail-mcp" }] } }),
      ".mcp.json": JSON.stringify({ mcpServers: { mail: { command: "mail-mcp" } } }),
      "examples/notes.md": "an example", "examples/beta/SKILL.md": `---\nname: beta\ndescription: Nested.\n${RISKY_FRONT}---\nNested body.\n`,
      "examples/gamma/skill.md": "---\nname: gamma\ndescription: Nested, in lower case.\n---\n",
    });
    fs.symlinkSync("/etc/hosts", path.join(home, ".claude", "skills", "alpha", "linked"));
    writeSkill(path.join(home, ".claude", "skills", "beta"), "beta", "description: Not given.\n");
    const before = snapshot(personDirs(home));
    // Skills alone take nothing away: a network grant is fine.
    const job = await host.call("delegate", { target: "claude", task: "SKILLS", mode: "read", extensions: true, grant: { network: true } });
    assert.deepEqual(job.extensions?.skills, ["alpha"], JSON.stringify(job));
    const consent = await pendingOf(host, job.job_id, "extensions");
    // Every skill is named, and what consenting does is said as it is for skills alone, without
    // the limits of a session given MCP servers, which this one does not have.
    assert.match(consent.wants, /give this Claude job these extensions for the rest of it: skills alpha$/);
    assert.match(consent.effect, /copies of these skills/);
    assert.doesNotMatch(consent.effect, /network|only you can allow|MCP servers for|outside its sandbox/);
    assert.match(h.cli("tree"), /\+ extensions: skills alpha; consent not given yet/);
    await host.answers(consent);
    const done = await settled(host, job.job_id);
    assert.equal(done.status, "done", JSON.stringify(done));
    assert.match(h.cli("tree"), /\+ extensions: skills alpha; consent given by the user in relay's approval dialog/);
    const start = h.starts().at(-1)!;
    const argv = start.argv as string[];
    const dir = argv[argv.indexOf("--plugin-dir") + 1];
    assert.ok(argv.includes("--plugin-dir"), "the package is loaded as a plugin for this session");
    assert.ok(!dir.startsWith(path.join(home, ".claude")), "the package is not in the person's own ~/.claude");
    assert.ok(argv[argv.indexOf("--tools") + 1].split(",").includes("Skill"), "a read turn gets the Skill tool to load them");
    const seen = start.pluginSkills as Rec;
    assert.deepEqual(Object.keys(seen), ["alpha"], "only the skill given");
    assert.match(seen.alpha.skill, /description: Test-first work\./);
    assert.doesNotMatch(seen.alpha.skill, /allowed-tools|hooks|PreToolUse|model:/);
    assert.deepEqual(seen.alpha.files.sort(), ["SKILL.md", "examples/notes.md", "reference.md", "scripts/run.sh"], "no harness metadata, dot-file, nested SKILL.md or symlink");
    assert.ok(!fs.existsSync(dir), "the package is removed when the turn ends");
    assert.deepEqual(snapshot(personDirs(home)), before, "nothing was written into the person's ~/.claude, ~/.codex or ~/.agents");
    assert.match((await host.call("status", { id: job.job_id })).extensions.skills.join(","), /alpha/);
    // Continued, the job gets the package built afresh for its next turn, and checked again, without being asked again.
    const more = await host.call("resume", { job_id: job.job_id, message: "SKILLS again" });
    assert.notEqual(more.refused, true, JSON.stringify(more));
    await until(() => h.starts().length === 2, 60000, "the second turn to start");
    assert.equal((await settled(host, job.job_id)).status, "done");
    const next = h.starts().at(-1)!;
    const nextArgv = next.argv as string[];
    assert.ok(nextArgv.includes("--plugin-dir"), "the second turn is given the package too");
    assert.notEqual(nextArgv[nextArgv.indexOf("--plugin-dir") + 1], dir, "a package of the turn's own");
    assert.deepEqual(Object.keys(next.pluginSkills as Rec), ["alpha"]);
    assert.equal(h.sql("SELECT count(*) AS n FROM requests WHERE kind = 'extensions'")[0].n, 1, "consent is asked once per session");
  } finally {
    await host.close();
    await h.close();
  }
});

test("extensions (claude): a skills turn whose init report lists another plugin or another plugin's skill, a skill named like one of the person's or the repository's, misses a given skill, or reports no skills is stopped before its first step, as is one whose skill is too large to copy (review C8)", async () => {
  const cases: [string, Rec, RegExp, Record<string, string>?][] = [
    ["FOREIGN", { plugins: [{ name: "relay-skills", path: "@PKG@" }, { name: "other", path: "/x/other" }] }, /plugins relay did not give it \(other\)/],
    // relay's plugin name at a path that is not the package, alone or beside the real one.
    ["SPOOF", { plugins: [{ name: "relay-skills", path: "/x/relay-skills" }] }, /plugins relay did not give it \(relay-skills\)/],
    ["SPOOFTOO", { plugins: [{ name: "relay-skills", path: "@PKG@" }, { name: "relay-skills", path: "/x/relay-skills" }] }, /plugins relay did not give it \(relay-skills\)/],
    ["PREFIXED", { skills: ["relay-skills:alpha", "x:y"] }, /skills relay did not give it \(x:y\)/],
    // Unprefixed, as Claude Code lists its bundled skills and would list the person's or the repository's.
    ["OWN", { skills: ["relay-skills:alpha", "beta"] }, /skills relay did not give it \(beta\)/],
    ["REPO", { skills: ["relay-skills:alpha", "gamma"] }, /skills relay did not give it \(gamma\)/],
    ["MISSING", { skills: ["debug"] }, /did not load the skills relay gave it \(relay-skills:alpha\)/],
    ["SILENT", { skills: null, plugins: null }, /did not report its skills/],
    // One file more than relay copies of a skill, added after the call: refused, not cut, before the agent starts.
    ["BIG", {}, /relay could not package the skill alpha .*larger than relay copies \(200 files/, Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`data/${i}.txt`, "x"]))],
  ];
  for (const [name, init, why, files] of cases) {
    // The agent's first step waits for a go-ahead the test never gives: one relay failed to stop
    // would wait in vain and fail with another error, never race the check.
    const steps = [{ awaitMark: "proceed" }, { signal: `acted-${name}` }, { reply: "ok" }];
    const h = await harness([{ match: task(name), steps }], { targets: { claude: { skills: ["alpha"] } } }, { STUB_INIT: JSON.stringify(init) });
    const host = await personSession(h, "claude");
    try {
      writeSkill(path.join(h.env.HOME, ".claude", "skills", "alpha"), "alpha", "description: A.\n");
      writeSkill(path.join(h.env.HOME, ".claude", "skills", "beta"), "beta", "description: Not given.\n");
      writeSkill(path.join(h.repo, ".claude", "skills", "gamma"), "gamma", "description: The repository's.\n");
      const job = await host.call("delegate", { target: "claude", task: name, mode: "read", extensions: true });
      assert.ok(job.job_id, `${name}: ${JSON.stringify(job)}`);
      writeSkill(path.join(h.env.HOME, ".claude", "skills", "alpha"), "alpha", "description: A.\n", files);
      await host.answers(await pendingOf(host, job.job_id, "extensions"));
      const s = await settled(host, job.job_id);
      assert.equal(s.status, "failed", name);
      assert.match(s.error, why, name);
      assert.ok(!reached(h, `acted-${name}`), `${name}: stopped before its first step`);
    } finally {
      await host.close();
      await h.close();
    }
  }
  // A write turn with full access (allow_dangerous) would bypass the never floor, so it is refused before Claude starts
  // (backends/never-admission.ts): no Claude runs with skills it was not checked for, whatever its permission mode.
  const steps = [{ awaitMark: "proceed" }, { signal: "acted-DANGER" }, { reply: "ok" }];
  const h = await harness([{ match: task("DANGER"), steps }], { allow_dangerous: true, targets: { claude: { skills: ["alpha"] } } }, { STUB_INIT: JSON.stringify({ skills: ["debug"] }) });
  const host = await personSession(h, "claude");
  try {
    writeSkill(path.join(h.env.HOME, ".claude", "skills", "alpha"), "alpha", "description: A.\n");
    const job = await host.call("delegate", { target: "claude", task: "DANGER", mode: "write", extensions: true });
    await host.answers(await pendingOf(host, job.job_id, "extensions"));
    const s = await settled(host, job.job_id);
    assert.equal(s.status, "failed", JSON.stringify(s));
    assert.match(s.error, /^never: Claude's unsandboxed full-access variant bypasses the floor/);
    assert.equal(h.starts().length, 0, "no Claude was launched");
    assert.ok(!reached(h, "acted-DANGER"), "stopped before its first step");
  } finally {
    await host.close();
    await h.close();
  }
});

test("extensions (codex): skills reach the agent through an extra skill root of relay's own, every other skill of the person's and the repository's is switched off for the session, and what Codex will load is checked first (review C8)", async () => {
  const h = await harness([{ match: task("CSKILLS"), steps: [{ reply: "ok" }] }], { targets: { codex: { skills: ["alpha"] } } });
  try {
    const home = h.env.HOME;
    // Consent discovers the person's roots. Runtime Codex uses relay's own CODEX_HOME,
    // so it sees the filtered copy, never this original or its nested skill.
    writeSkill(path.join(home, ".codex", "skills", "alpha"), "alpha", RISKY_FRONT, { "examples/inner/SKILL.md": "---\nname: inner\ndescription: Nested.\nallowed-tools: Bash\n---\n" });
    writeSkill(path.join(home, ".codex", "skills", "beta"), "beta", "description: B.\n");
    writeSkill(path.join(home, ".codex", "skills", "group", "zeta"), "zeta", "description: Z, nested.\n");
    writeSkill(path.join(home, ".agents", "skills", "gamma"), "gamma", "description: G.\n");
    // The repository's, at its top and in the subdirectory the job works in.
    writeSkill(path.join(h.repo, ".agents", "skills", "delta"), "delta", "description: D.\n");
    writeSkill(path.join(h.repo, ".codex", "skills", "epsilon"), "epsilon", "description: E.\n");
    writeSkill(path.join(h.repo, "sub", ".agents", "skills", "eta"), "eta", "description: H.\n");
    const before = snapshot(personDirs(home));
    const host = await personSession(h, "codex", { cwd: path.join(h.repo, "sub") });
    try {
      const job = await host.call("delegate", { target: "codex", task: "CSKILLS", mode: "read", extensions: true });
      assert.ok(job.job_id, JSON.stringify(job));
      const consent = await pendingOf(host, job.job_id, "extensions");
      assert.match(consent.wants, /give this Codex job these extensions for the rest of it: skills alpha$/);
      assert.match(h.cli("tree"), /\+ extensions: skills alpha; consent not given yet/);
      await host.answers(consent);
      const done = await settled(host, job.job_id);
      assert.equal(done.status, "done", JSON.stringify(done));
      const listed = h.log().filter((r) => r.event === "skills-list").at(-1)!;
      assert.equal(listed.cwd, path.join(h.repo, "sub"));
      assert.deepEqual(listed.found.sort(), ["alpha", "delta", "epsilon", "eta", "gamma", "openai-docs"], "the personal CODEX_HOME is a copy source; the runtime discovers only the package, shared roots and its own bundled skills");
      // No plugin manifest beside the root: with one, codex-cli 0.163.0 names every skill under it <plugin>:<name>.
      assert.deepEqual(listed.plugins, [null]);
      assert.deepEqual(listed.enabled.sort(), ["alpha"], "exactly relay's copy");
      assert.ok(listed.roots.length === 1 && !listed.roots[0].startsWith(path.join(home, ".codex")), "the extra root is relay's, not the person's");
      assert.doesNotMatch(listed.copies.alpha, /allowed-tools|hooks|model:/);
      const argv = h.log().filter((r) => r.event === "start" && r.via === "app-server").at(-1)!.argv as string[];
      assert.ok(argv.join(" ").includes("--disable skill_mcp_dependency_install"));
      assert.ok(!fs.existsSync(path.dirname(listed.roots[0])), "the package is removed when the turn ends");
      assert.deepEqual(snapshot(personDirs(home)), before, "nothing was written into the person's ~/.codex, ~/.agents or ~/.claude");
      // Continued, the job gets a package and an extra root of its next turn's own, and what Codex will load is checked again, without asking again.
      const lists = h.log().filter((r) => r.event === "skills-list").length;
      const more = await host.call("resume", { job_id: job.job_id, message: "CSKILLS again" });
      assert.notEqual(more.refused, true, JSON.stringify(more));
      await until(() => h.log().filter((r) => r.event === "skills-list").length > lists, 60000, "the second turn's skills check");
      assert.equal((await settled(host, job.job_id)).status, "done");
      const relisted = h.log().filter((r) => r.event === "skills-list").at(-1)!;
      assert.equal(relisted.roots.length, 1);
      assert.notEqual(relisted.roots[0], listed.roots[0], "a package of the turn's own");
      assert.deepEqual(relisted.enabled.sort(), ["alpha"]);
      assert.doesNotMatch(relisted.copies.alpha, /allowed-tools|hooks|model:/);
      assert.equal(h.sql("SELECT count(*) AS n FROM requests WHERE kind = 'extensions'")[0].n, 1, "consent is asked once per session");
    } finally {
      await host.close();
    }
  } finally {
    await h.close();
  }
});

test("extensions (codex): a skill Codex would load that relay did not give or could not switch off, a copy it does not load, or skills still able to install servers stop the turn before the thread starts (review C8)", async () => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ["STRAY", { STUB_CODEX_SKILLS: JSON.stringify([{ name: "stray", scope: "admin", path: "/opt/elsewhere/stray/SKILL.md" }]) }, /skills relay did not give it and could not switch off: stray/],
    ["DROPPED", { STUB_CODEX_DROP_ROOTS: "1" }, /did not load the skills relay gave it \(alpha\)/],
    // Inside relay's package, only the given skills by their own names at <root>/<name>/SKILL.md:
    // not a skill nested in a copy, and not a copy under another name (as a plugin manifest would name it).
    ["NESTED", { STUB_CODEX_IN_ROOT: JSON.stringify([{ name: "beta", rel: "alpha/examples/beta/SKILL.md" }]) }, /skills from relay's package other than the ones relay gave it, .*: beta \(/],
    ["RENAMED", { STUB_CODEX_IN_ROOT: JSON.stringify([{ name: "relay-skills:alpha", rel: "alpha/SKILL.md" }]) }, /skills from relay's package other than the ones relay gave it, .*: relay-skills:alpha \(/],
    ["DEPS", { STUB_CODEX_EFFECTIVE: JSON.stringify({ features: { plugins: false, hooks: false, skill_mcp_dependency_install: true } }) }, /skill_mcp_dependency_install/],
  ];
  for (const [name, env, why] of cases) {
    const h = await harness([{ match: task(name), steps: [{ reply: "ok" }] }], { targets: { codex: { skills: ["alpha"] } } }, env);
    const host = await personSession(h, "codex");
    try {
      writeSkill(path.join(h.env.HOME, ".codex", "skills", "alpha"), "alpha", "description: A.\n");
      const job = await host.call("delegate", { target: "codex", task: name, mode: "read", extensions: true });
      assert.ok(job.job_id, JSON.stringify(job));
      await host.answers(await pendingOf(host, job.job_id, "extensions"));
      const s = await settled(host, job.job_id);
      assert.equal(s.status, "failed", name);
      assert.match(s.error, why, name);
      assert.equal(h.log().filter((r) => r.event === "start").length, 0, `${name}: no turn started`);
    } finally {
      await host.close();
      await h.close();
    }
  }
});

test("extensions (codex): a turn given MCP servers alone loads none of the person's or the repository's skills either and cannot install a skill's servers, and what Codex will load is checked first (review X2)", async () => {
  const stray = JSON.stringify([{ name: "stray", scope: "admin", path: "/opt/elsewhere/stray/SKILL.md" }]);
  for (const [name, env] of [["CSERVERS", {}], ["CSTRAY", { STUB_CODEX_SKILLS: stray }]] as const) {
    const h = await harness([{ match: task(name), steps: [{ reply: "ok" }] }], { targets: { codex: { mcp_servers: ["ext"] } } }, env);
    const host = await personSession(h, "codex");
    try {
      const home = h.env.HOME;
      // This is an unexpected runtime skill, not a consent source. It must stay disabled. Relay's
      // Codex home is marked as relay's first, as relay would have made it: an unmarked non-empty
      // directory is refused before anything is written there (codex-pin.ts codexHomeProblem).
      fs.mkdirSync(path.join(home, ".local/share/relay-codex-home"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(home, ".local/share/relay-codex-home", RELAY_CODEX_HOME_MARKER), "");
      writeSkill(path.join(home, ".local/share/relay-codex-home", "skills", "beta"), "beta", "description: B.\n");
      writeSkill(path.join(home, ".agents", "skills", "gamma"), "gamma", "description: G.\n");
      writeSkill(path.join(h.repo, ".agents", "skills", "delta"), "delta", "description: D.\n");
      defineServers(h);
      const job = await host.call("delegate", { target: "codex", task: name, mode: "read", extensions: true });
      assert.deepEqual(job.extensions?.skills, [], JSON.stringify(job));
      await host.answers(await pendingOf(host, job.job_id, "extensions"));
      const s = await settled(host, job.job_id);
      const listed = h.log().filter((r) => r.event === "skills-list").at(-1);
      assert.ok(listed, `${name}: what Codex will load is checked`);
      assert.deepEqual(listed!.roots, [], "no package, so no extra root");
      if (name === "CSTRAY") {
        assert.equal(s.status, "failed", JSON.stringify(s));
        assert.match(s.error, /skills relay did not give it and could not switch off: stray/);
        assert.equal(h.log().filter((r) => r.event === "start").length, 0, "no turn started");
        continue;
      }
      assert.equal(s.status, "done", JSON.stringify(s));
      assert.deepEqual(listed!.found.sort(), ["beta", "delta", "gamma", "openai-docs"], "Codex finds runtime, shared personal and repository skills; none may load implicitly");
      assert.deepEqual(listed!.enabled, [], "no implicit skills, bundled ones included");
      const argv = h.log().filter((r) => r.event === "start" && r.via === "app-server").at(-1)!.argv as string[];
      assert.ok(argv.join(" ").includes("--disable skill_mcp_dependency_install"), "no skill installs a server of its own beside relay's gateway");
    } finally {
      await host.close();
      await h.close();
    }
  }
});

test("extensions: a consult thread is given them when it starts, and keeps them; a server that cannot start is a warning in the result and in what the agent is told, not a tool", async () => {
  const steps = [{ tools: true, as: "tools" }, { instructions: true, as: "told" }, { call: "ext__echo", args: { text: "q" }, as: "echo" }, { reply: "tools={{tools}} told={{told}} echo={{echo}}" }];
  const h = await harness([{ match: "QUESTION", steps }], { targets: { codex: { mcp_servers: [{ name: "ext", allow_tools: ["echo"] }, "broken"] } } });
  const host = await personSession(h, "codex");
  try {
    const log = defineServers(h, { broken: { command: process.execPath, args: [EXT_BROKEN_SERVER] } });
    const asking = host.call("ask", { target: "codex", message: "QUESTION", extensions: true });
    const thread = await firstThread(h);
    const consent = await pendingOf(host, thread, "extensions");
    assert.match(consent.wants, /give this Codex thread/);
    assert.match(consent.wants, /MCP servers ext .*broken/);
    assert.match(consent.effect, /for the rest of the thread/);
    assert.match(consent.effect, /the thread gets no network/);
    await host.answers(consent);
    // The call that started it says what it was given and that the user is asked first, as delegate does.
    const asked = await asking;
    assert.equal(asked.thread_id, thread, JSON.stringify(asked));
    assert.deepEqual(asked.extensions, { skills: [], mcp_servers: [{ name: "ext", allow_tools: ["echo"] }, { name: "broken", allow_tools: [] }] });
    assert.match(asked.extensions_note, /only they can allow/);
    const done = await settled(host, thread);
    assert.equal(done.status, "done", JSON.stringify(done));
    assert.match(JSON.stringify(done), /the MCP server broken could not be started/);
    const reply = h.ends().at(-1)!.reply as string;
    assert.match(reply, /ext__echo/);
    assert.doesNotMatch(reply, /broken__/);
    // Told before it starts, in relay's server instructions: its preamble was written before the turn.
    assert.match(reply, /not all of them: the MCP server broken could not be started/);
    assert.equal(calls(log, "echo").length, 1);

    // A follow-up neither adds nor asks again: the thread keeps what it was given.
    assert.match((await host.call("ask", { thread_id: thread, message: "QUESTION again", extensions: true })).reason, /when it starts/);
    const again = await host.call("ask", { thread_id: thread, message: "QUESTION again" });
    assert.ok(again.reply !== undefined || again.pending, JSON.stringify(again));
    assert.equal(again.extensions, undefined);
    await settled(host, thread);
    assert.equal(h.sql("SELECT count(*) AS n FROM requests WHERE kind = 'extensions'")[0].n, 1, "consent is asked once per session");
    assert.equal(calls(log, "echo").length, 2);
  } finally {
    await host.close();
    await h.close();
  }
});

test("extensions: a call of an MCP server's tool the person allows for the rest of the job goes ahead later without asking, for that tool alone and that job alone", async () => {
  const steps = [
    { call: "ext__send", args: { to: "a", body: "1" }, as: "s1" },
    { call: "ext__send", args: { to: "b", body: "2", urgent: true }, as: "s2" },
    { call: "ext__echo", args: { text: "e" }, as: "e" },
    { reply: "s1={{s1}} s2={{s2}} e={{e}}" },
  ];
  const h = await harness([{ match: task("FORJOB"), steps }], { targets: { codex: { mcp_servers: ["ext"] } } });
  const host = await personSession(h, "codex");
  try {
    const log = defineServers(h);
    const job = await host.call("delegate", { target: "codex", task: "FORJOB", mode: "read", extensions: true });
    await host.answers(await pendingOf(host, job.job_id, "extensions"));
    const first = await pendingOf(host, job.job_id, "mcp");
    assert.match(first.effect, /allowed for the rest of the job: this tool, with any arguments/);
    await host.answers(first, "allow for the rest of this job");
    // The same tool with other arguments is forwarded without a request; another tool of the same server asks.
    const echo = await pendingOf(host, job.job_id, "mcp");
    assert.equal(echo.wants, 'ext.echo {"text":"e"}');
    assert.deepEqual(calls(log, "send").map((c) => c.args), [{ to: "a", body: "1" }, { to: "b", body: "2", urgent: true }]);
    assert.equal(h.sql("SELECT count(*) AS n FROM requests WHERE kind = 'mcp' AND node_id = ?", job.job_id)[0].n, 2);
    await host.answers(echo, "deny");
    assert.equal((await settled(host, job.job_id)).status, "done");
    assert.equal(calls(log, "echo").length, 0);

    // Another job asks again.
    const next = await host.call("delegate", { target: "codex", task: "FORJOB", mode: "read", extensions: true });
    await host.answers(await pendingOf(host, next.job_id, "extensions"));
    const asks = await pendingOf(host, next.job_id, "mcp");
    assert.equal(asks.wants, 'ext.send {"to":"a","body":"1"}');
    assert.equal(calls(log, "send").length, 2);
    await host.call("cancel", { id: next.job_id });
  } finally {
    await host.close();
    await h.close();
  }
});

test("extensions: relay approve never allows a person-only request, with a terminal or without, so no command an agent can run is the person's consent (review C2/X1)", async () => {
  const h = await harness([{ match: task("TTY"), steps: [{ reply: "ok" }] }], { targets: { codex: { mcp_servers: ["ext"] } } });
  const host = await personSession(h, "codex");
  try {
    defineServers(h);
    const job = await host.call("delegate", { target: "codex", task: "TTY", mode: "read", extensions: true });
    const consent = await pendingOf(host, job.job_id, "extensions");
    // As an agent's shell tool runs it, and under a pseudo-terminal it gives itself.
    const plain = JSON.parse(h.cli("approve", consent.request_id));
    assert.equal(plain.refused, true, JSON.stringify(plain));
    assert.match(plain.reason, /only the user can allow .*never from a command/);
    assert.match(approveInTerminal(h, consent.request_id), /"refused": true/);
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", consent.request_id)[0].status, "pending");
    assert.equal(h.starts().length, 0, "the agent waits for consent");
    // The root agent is not told to have anyone run a command.
    assert.doesNotMatch((await host.call("approve", { request_id: consent.request_id, decision: "allow" })).reason, /run `relay approve/);
    // A denial may come from anywhere.
    assert.equal(JSON.parse(h.cli("deny", consent.request_id)).decision, "denied");
    assert.equal((await settled(host, job.job_id)).status, "failed");
  } finally {
    await host.close();
    await h.close();
  }
});

for (const target of ["claude", "codex"] as const) {
  test(`extensions (${target}): a session holding MCP servers gets the host's web tools only by asking the person, whatever child_web says (review C2/X1)`, async () => {
    const h = await harness([{ match: task("WEB"), steps: [{ reply: "ok" }] }], { targets: { [target]: { mcp_servers: ["ext"] } } });
    const host = await personSession(h, target);
    try {
      defineServers(h);
      const job = await host.call("delegate", { target, task: "WEB", mode: "read", extensions: true });
      await host.answers(await pendingOf(host, job.job_id, "extensions"));
      assert.equal((await settled(host, job.job_id)).status, "done");
      const start = h.starts().at(-1)!;
      if (target === "claude") {
        // A fetch could carry a credential the agent read to the service, past relay's gate: it asks, and only the person can allow it.
        const ask = settingsOf(start).permissions?.ask ?? [];
        assert.ok(ask.includes("WebSearch") && ask.includes("WebFetch"), JSON.stringify(ask));
        // Nor can it read the credentials relay's mcp.json may hold, any more than a Claude agent given none can.
        const mcpPath = path.join(h.home, "mcp.json");
        const plain = await host.call("delegate", { target, task: "WEB", mode: "write", background: false });
        assert.equal(plain.status, "done", JSON.stringify(plain));
        for (const s of [start, h.starts().at(-1)!]) {
          const settings = settingsOf(s);
          assert.ok((settings.sandbox?.filesystem?.denyRead ?? []).includes(mcpPath), JSON.stringify(settings.sandbox));
          assert.ok((settings.permissions?.deny ?? []).includes(`Read(/${mcpPath})`), JSON.stringify(settings.permissions));
        }
      } else {
        // Codex has no way to ask per search, so its search is off.
        assert.ok((start.argv as string[]).join(" ").includes('web_search="disabled"'), "Codex's web search is off");
      }
    } finally {
      await host.close();
      await h.close();
    }
  });
}

test("extensions (claude): skills \"user\" gives each skill in the person's Claude skills directory that a launched agent can load: a model-only one (user-invocable false) loads, a slash command only a person can use is left out (review round 2)", async () => {
  const h = await harness([{ match: task("USERSKILLS"), steps: [{ reply: "ok" }] }], { targets: { claude: { skills: "user" } } });
  const host = await personSession(h, "claude");
  try {
    const root = path.join(h.env.HOME, ".claude", "skills");
    writeSkill(path.join(root, "modelonly"), "modelonly", "description: For the model only.\nuser-invocable: false\n");
    writeSkill(path.join(root, "plain"), "plain", "description: Plain.\n");
    writeSkill(path.join(root, "command"), "command", "description: A slash command.\ndisable-model-invocation: true\n");
    writeSkill(path.join(root, ".hidden"), "hidden", "description: In a dot-directory.\n");
    // Claude Code takes the skill directories directly in the root, not one inside a group.
    writeSkill(path.join(root, "group", "deep"), "deep", "description: In a group.\n");
    const job = await host.call("delegate", { target: "claude", task: "USERSKILLS", mode: "read", extensions: true });
    assert.deepEqual(job.extensions?.skills, ["modelonly", "plain"], JSON.stringify(job));
    const consent = await pendingOf(host, job.job_id, "extensions");
    assert.match(consent.wants, /skills modelonly, plain$/);
    await host.answers(consent);
    const done = await settled(host, job.job_id);
    assert.equal(done.status, "done", JSON.stringify(done));
    const seen = h.starts().at(-1)!.pluginSkills as Rec;
    assert.deepEqual(Object.keys(seen).sort(), ["modelonly", "plain"]);
    // Kept, user-invocable false would leave the skill out of Claude Code's init report (2.1.302),
    // where relay checks that every given skill loaded; nobody types a launched agent's slash commands.
    assert.doesNotMatch(seen.modelonly.skill, /user-invocable|disable-model-invocation/);
  } finally {
    await host.close();
    await h.close();
  }
});

test("extensions (codex): skills \"user\" gives the skills Codex finds in both of the person's roots, one in a group directory among them, the first root's for a name in both, and never a dot-directory's such as Codex's own .system (review round 2)", async () => {
  const h = await harness([{ match: task("CUSER"), steps: [{ reply: "ok" }] }], { targets: { codex: { skills: "user" } } });
  try {
    const home = h.env.HOME;
    writeSkill(path.join(home, ".codex", "skills", "top"), "top", "description: From CODEX_HOME.\n");
    writeSkill(path.join(home, ".codex", "skills", "group", "zeta"), "zeta", "description: In a group.\n");
    writeSkill(path.join(home, ".codex", "skills", ".system", "sys"), "sys", "description: Codex's own.\n");
    writeSkill(path.join(home, ".agents", "skills", "top"), "top", "description: From .agents, under a name already taken.\n");
    writeSkill(path.join(home, ".agents", "skills", "other"), "other", "description: Other.\n");
    const host = await personSession(h, "codex");
    try {
      const job = await host.call("delegate", { target: "codex", task: "CUSER", mode: "read", extensions: true });
      assert.ok(job.job_id, JSON.stringify(job));
      assert.deepEqual(job.extensions?.skills, ["zeta", "top", "other"], JSON.stringify(job));
      const consent = await pendingOf(host, job.job_id, "extensions");
      assert.match(consent.wants, /skills zeta, top, other$/);
      await host.answers(consent);
      const done = await settled(host, job.job_id);
      assert.equal(done.status, "done", JSON.stringify(done));
      const listed = h.log().filter((r) => r.event === "skills-list").at(-1)!;
      assert.deepEqual(listed.enabled.sort(), ["other", "top", "zeta"]);
      assert.deepEqual(Object.keys(listed.copies).sort(), ["other", "top", "zeta"]);
      assert.match(listed.copies.top, /From CODEX_HOME/);
    } finally {
      await host.close();
    }
  } finally {
    await h.close();
  }
});

test("extensions: targets.<id>.skills finds skills as the target's CLI does, names a path's skill after its directory, and refuses at the call what a launched agent could not load whole (review round 2)", async () => {
  const { resolveSkills, buildSkillPackage, claudeSkillNames } = await import("../dist/core/extensions.js");
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-skills-")));
  // For ~/…, which relay expands against its own home folder (the test process's, a scratch one).
  const near = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), "skills-")));
  try {
    const home = path.join(tmp, "home");
    const env = { HOME: home };
    const claude = path.join(home, ".claude", "skills");
    const codex = path.join(home, ".codex", "skills");
    const agents = path.join(home, ".agents", "skills");
    writeSkill(path.join(claude, "alpha"), "alpha", "description: A.\n");
    writeSkill(path.join(near, "shared"), "shared", "description: S.\n");
    writeSkill(path.join(tmp, "abs", "absolute"), "absolute", "description: Abs.\n");
    // A name is looked up in the target's roots; a path, absolute or ~/…, is a skill directory, and the skill goes under its name.
    assert.deepEqual(resolveSkills(["alpha", `~/${path.basename(near)}/shared`, path.join(tmp, "abs", "absolute")], "claude", env), [
      { name: "alpha", source: path.join(claude, "alpha") },
      { name: "shared", source: path.join(near, "shared") },
      { name: "absolute", source: path.join(tmp, "abs", "absolute") },
    ]);
    const reason = (setting: unknown, target = "claude", e: Record<string, string> = env): string => {
      const r = resolveSkills(setting as never, target as never, e);
      assert.ok("reason" in r, JSON.stringify(r));
      return (r as { reason: string }).reason;
    };
    assert.match(reason(["nosuch"]), /the skill nosuch in targets\.claude\.skills is not in .*\.claude\/skills/);
    assert.match(reason([path.join(tmp, "nowhere")]), /is not a directory holding a SKILL\.md/);
    writeSkill(path.join(tmp, "other", "alpha"), "alpha", "description: Another alpha.\n");
    assert.match(reason(["alpha", path.join(tmp, "other", "alpha")]), /two skills would both be called alpha/);

    // A slash command only a person can use: disable-model-invocation as anything but a plain false.
    for (const value of ["true", "yes", "'on'", "1", "\"True\"", "|\n  true"]) {
      const dir = path.join(tmp, "command", String(value.length) + value.replace(/\W/g, ""));
      writeSkill(dir, "command", `description: C.\ndisable-model-invocation: ${value}\n`);
      assert.match(reason([dir]), /sets disable-model-invocation, so only a person typing its slash command can use it/, value);
    }
    for (const value of ["false", "no", "'false'", "Off # a comment"]) {
      const dir = path.join(tmp, "model", value.replace(/\W/g, ""));
      writeSkill(dir, "model", `description: M.\ndisable-model-invocation: ${value}\n`);
      assert.ok(!("reason" in resolveSkills([dir], "claude", env)), value);
    }
    // A SKILL.md that is a link: the package takes regular files only, so the skill would arrive without it.
    const linked = path.join(tmp, "linked");
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(claude, "alpha", "SKILL.md"), path.join(linked, "SKILL.md"));
    assert.match(reason([linked]), /linked\/SKILL\.md is a symbolic link/);
    // A SKILL.md named in another case only (on a case-insensitive disk it opens as SKILL.md).
    const lower = path.join(tmp, "lower");
    fs.mkdirSync(lower);
    fs.writeFileSync(path.join(lower, "skill.md"), "---\nname: lower\ndescription: L.\n---\n");
    assert.match(reason([lower]), /names its SKILL\.md skill\.md|is not a directory holding a SKILL\.md/);
    // Larger than the package takes (200 files or 5 MB, counted as the package counts them: no
    // dot-files or metadata): refused at the call, before anyone is asked to consent, and "user" whole.
    const big = path.join(tmp, "big");
    writeSkill(big, "big", "description: B.\n", Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`data/${i}.txt`, "x"])));
    assert.match(reason([big]), /the skill big \(.*big\) is larger than relay copies \(200 files, 5 MB\)/);
    const heavy = path.join(tmp, "heavy");
    writeSkill(heavy, "heavy", "description: H.\n", { "blob.bin": "x".repeat(5 * 1024 * 1024) });
    assert.match(reason([heavy]), /the skill heavy .* is larger than relay copies/);
    const fits = path.join(tmp, "fits");
    writeSkill(fits, "fits", "description: F.\n", Object.fromEntries([...Array.from({ length: 199 }, (_, i) => [`data/${i}.txt`, "x"]), [".cache/big.bin", "x".repeat(6 * 1024 * 1024)], ["agents/openai.yaml", "x"]]));
    assert.ok(!("reason" in resolveSkills([fits], "claude", env)), "what the package leaves out does not count");
    const home3 = path.join(tmp, "home3");
    writeSkill(path.join(home3, ".claude", "skills", "good"), "good", "description: G.\n");
    writeSkill(path.join(home3, ".claude", "skills", "huge"), "huge", "description: Huge.\n", Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`d/${i}`, "x"])));
    assert.match(reason("user", "claude", { HOME: home3 }), /the skill huge .* is larger than relay copies .*so relay cannot give your user skills/);
    // Harness metadata at the top is left out by any case of its name: a disk that ignores case opens Agents/ as agents/.
    const cased = path.join(tmp, "cased");
    writeSkill(cased, "cased", "description: C.\n", { "Agents/openai.yaml": "dependencies: {}", "Skill.Json": "{}", "notes/Agents/kept.md": "below the top, an ordinary directory" });
    const casedPkg = path.join(tmp, "pkg-cased");
    buildSkillPackage(casedPkg, [{ name: "cased", source: cased }], { plugin: false });
    const copied: string[] = [];
    const list = (d: string, rel = "") => {
      for (const e of fs.readdirSync(d)) {
        const r = path.join(rel, e);
        if (fs.statSync(path.join(d, e)).isDirectory()) list(path.join(d, e), r);
        else copied.push(r);
      }
    };
    list(path.join(casedPkg, "skills", "cased"));
    assert.deepEqual(copied.sort(), ["SKILL.md", "notes/Agents/kept.md"]);

    // "user", for Codex: both roots, a skill in a group directory too, for a name in both the first
    // root's, a person's slash command left out, and no dot-directory (Codex's own .system).
    writeSkill(path.join(codex, "top"), "top", "description: From CODEX_HOME.\n", { "examples/inner/SKILL.md": "---\nname: inner\ndescription: I.\nallowed-tools: Bash\n---\n", "examples/notes.md": "n" });
    writeSkill(path.join(codex, "group", "zeta"), "zeta", "description: Z.\n");
    writeSkill(path.join(codex, ".system", "sys"), "sys", "description: Codex's own.\n");
    writeSkill(path.join(codex, "command"), "command", "description: C.\ndisable-model-invocation: true\n");
    writeSkill(path.join(agents, "top"), "top", "description: Under a name already taken.\n");
    writeSkill(path.join(agents, "other"), "other", "description: O.\n");
    // Named, a skill is found as under "user": in a group directory too, for Codex; not inside another skill.
    assert.deepEqual(resolveSkills(["zeta", "top"], "codex", env), [
      { name: "zeta", source: path.join(codex, "group", "zeta") },
      { name: "top", source: path.join(codex, "top") },
    ]);
    assert.match(reason(["inner"], "codex"), /the skill inner in targets\.codex\.skills is not in /);
    const given = resolveSkills("user", "codex", env);
    assert.deepEqual(given, [
      { name: "zeta", source: path.join(codex, "group", "zeta") },
      { name: "top", source: path.join(codex, "top") },
      { name: "other", source: path.join(agents, "other") },
    ]);
    // A skill nested in a given one is part of its copy, without its SKILL.md, which Codex would load as a skill of its own, unfiltered.
    const pkg = path.join(tmp, "pkg");
    buildSkillPackage(pkg, given, { plugin: false });
    assert.ok(!fs.existsSync(path.join(pkg, ".claude-plugin")), "no plugin manifest for Codex, which would name every skill <plugin>:<name>");
    assert.ok(fs.existsSync(path.join(pkg, "skills", "top", "examples", "notes.md")));
    assert.ok(!fs.existsSync(path.join(pkg, "skills", "top", "examples", "inner", "SKILL.md")));
    const forClaude = path.join(tmp, "pkg-claude");
    buildSkillPackage(forClaude, [{ name: "alpha", source: path.join(claude, "alpha") }], { plugin: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(forClaude, ".claude-plugin", "plugin.json"), "utf8")).name, "relay-skills");
    // Changed after the call into something it could not load whole, a skill is refused when its package is built.
    fs.writeFileSync(path.join(codex, "group", "zeta", "SKILL.md"), "---\nname: zeta\ndescription: Z.\ndisable-model-invocation: true\n---\n");
    assert.throws(() => buildSkillPackage(path.join(tmp, "pkg-later"), given, { plugin: false }), /relay could not package the skill zeta .*disable-model-invocation/);

    // "user" refuses all of them when one cannot be given, and says so when there are none.
    const home2 = path.join(tmp, "home2");
    writeSkill(path.join(home2, ".claude", "skills", "good"), "good", "description: G.\n");
    fs.mkdirSync(path.join(home2, ".claude", "skills", "bad"));
    fs.symlinkSync(path.join(home2, ".claude", "skills", "good", "SKILL.md"), path.join(home2, ".claude", "skills", "bad", "SKILL.md"));
    assert.match(reason("user", "claude", { HOME: home2 }), /is a symbolic link.*so relay cannot give your user skills/);
    assert.match(reason("user", "claude", { HOME: path.join(tmp, "empty") }), /skills is "user", but there are no skills in .* that a launched agent could load/);

    // What Claude Code would load by itself in a turn's directory: the person's, and the repository's from there up to its top, no further.
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeSkill(path.join(repo, ".claude", "skills", "r1"), "r1", "description: R1.\n");
    writeSkill(path.join(repo, "sub", ".claude", "skills", "r2"), "r2", "description: R2.\n");
    writeSkill(path.join(tmp, ".claude", "skills", "above"), "above", "description: Above the repository.\n");
    assert.deepEqual(claudeSkillNames(path.join(repo, "sub"), env).sort(), ["alpha", "r1", "r2"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(near, { recursive: true, force: true });
  }
});

test("extensions: the gateway offers a server's tools only as given and reports what it leaves out, and reads no manifest outside relay's control directory (review round 2)", async () => {
  const { openGateway } = await import("../dist/mcp/gateway.js");
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gateway-")));
  const saved = process.env.RELAY_HOME;
  closeDbForTests();
  process.env.RELAY_HOME = path.join(tmp, "relay-home");
  try {
    const mcp = path.join(tmp, "mcp.json");
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { ext: { command: process.execPath, args: [EXT_SERVER] }, odd: { command: process.execPath, args: [EXT_ODD_SERVER] } } }));
    const runId = createRun(tmp, withDefaults({}), "gateway-test-root");
    const catalog = qualifiedFixtureAdapters(readMcpFile(mcp));
    const manifest = (at: string, servers: unknown) => {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, JSON.stringify({ run_id: runId, mcp_file: mcp, servers, report: path.join(path.dirname(at), "gateway-report.json") }));
      return at;
    };
    const dir = path.join(process.env.RELAY_HOME, "runs", "run_x", "j_x", "ext-1");
    const gw = await openGateway(manifest(path.join(dir, "gateway.json"), [{ name: "odd", allow_tools: ["ok", "nosuch"] }, { name: "ext", allow_tools: [] }]), catalog);
    try {
      assert.deepEqual(gw.tools.map((t: Rec) => t.name), ["ext__echo", "ext__send", "odd__ok"]);
      assert.equal(gw.tools.find((t: Rec) => t.name === "odd__ok").preauthorized, true);
      assert.equal(gw.tools.find((t: Rec) => t.name === "odd__ok").description, "A tool relay can offer.", "the first of a tool listed twice");
      const w = gw.warnings.join("\n");
      assert.match(w, /the tool ok of odd is listed more than once; relay offers the first/);
      assert.match(w, /the tool x{70} of odd is not offered: odd__x{70} is not a name relay can give a tool/);
      assert.match(w, /the tool union of odd is not offered: its input schema is not an object/);
      assert.match(w, /the tool dangling of odd is not offered: relay cannot check its input schema/);
      assert.match(w, /odd has no tool nosuch, which its allow_tools names/);
      assert.equal(gw.warnings.length, 5, w);
      const report = JSON.parse(fs.readFileSync(path.join(dir, "gateway-report.json"), "utf8"));
      assert.deepEqual(report.started.sort(), ["ext", "odd"]);
      assert.deepEqual(report.warnings, gw.warnings);
    } finally {
      await gw.close();
    }
    // A manifest anywhere else is not one relay wrote: nothing is started or offered.
    const outside = await openGateway(manifest(path.join(tmp, "elsewhere", "gateway.json"), [{ name: "ext", allow_tools: ["echo"] }]));
    try {
      assert.deepEqual(outside.tools, []);
      assert.match(outside.warnings.join("\n"), /could not read the turn's list of MCP servers \(it is not in relay's control directory\), so none of them is offered/);
      assert.ok(!fs.existsSync(path.join(tmp, "elsewhere", "gateway-report.json")), "nothing is written beside it");
    } finally {
      await outside.close();
    }
  } finally {
    closeDbForTests();
    if (saved === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("extensions: relay's mcp.json is read strictly, stdio servers only, and what is wrong is said without quoting a value", async () => {
  const { readMcpFile } = await import("../dist/core/extensions.js");
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcpfile-")));
  try {
    const file = path.join(tmp, "mcp.json");
    const read = (content: string) => {
      fs.writeFileSync(file, content);
      return () => readMcpFile(file);
    };
    const servers = (def: Rec) => JSON.stringify({ mcpServers: { a: def } });
    assert.deepEqual(read(servers({ command: "x", args: ["y"], env: { K: "v" }, cwd: "/abs" }))(), { a: { command: "x", args: ["y"], env: { K: "v" }, cwd: "/abs" } });
    assert.throws(read("{ not json"), /mcp\.json is not valid JSON/);
    for (const [def, why] of [
      [{ type: "http", url: "https://mail.example.com/MARKER" }, /is not valid: .*stdio servers only/],
      [{ command: "x", transport: "MARKER" }, /is not valid: .*stdio servers only/],
      [{ command: "x", cwd: "relative/MARKER" }, /cwd must be an absolute path/],
      [{ command: "x", env: { TOKEN: 5, KEY: "MARKER-secret" }, args: "MARKER" }, /is not valid/],
      [{ args: ["MARKER"] }, /is not valid/],
    ] as const) {
      const r = read(servers(def));
      assert.throws(r, why, JSON.stringify(def));
      assert.throws(r, (e: Error) => !e.message.includes("MARKER"), `the message quotes no value: ${JSON.stringify(def)}`);
    }
    assert.throws(read(JSON.stringify({ mcpServers: {}, other: "MARKER" })), (e: Error) => /is not valid/.test(e.message) && !e.message.includes("MARKER"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("extensions: the gateway offers nothing of a server no longer defined, and forwards no call, one that runs without asking included, once its turn is over", async () => {
  const { openGateway, offerGateway } = await import("../dist/mcp/gateway.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gateway-")));
  const saved = process.env.RELAY_HOME;
  closeDbForTests();
  process.env.RELAY_HOME = path.join(tmp, "relay-home");
  try {
    const log = path.join(tmp, "ext.jsonl");
    const mcp = path.join(tmp, "mcp.json");
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { ext: { command: process.execPath, args: [EXT_SERVER], env: { EXT_LOG: log } } } }));
    const runId = createRun(tmp, withDefaults({}), "gateway-test-root");
    const dir = path.join(process.env.RELAY_HOME, "runs", "run_x", "j_x", "ext-1");
    fs.mkdirSync(dir, { recursive: true });
    const manifest = path.join(dir, "gateway.json");
    fs.writeFileSync(manifest, JSON.stringify({ run_id: runId, mcp_file: mcp, servers: [{ name: "ext", allow_tools: ["echo"] }, { name: "gone", allow_tools: [] }], report: path.join(dir, "gateway-report.json") }));
    const gw = await openGateway(manifest, qualifiedFixtureAdapters(readMcpFile(mcp)));
    const server = new McpServer({ name: "relay", version: "0" });
    const client = new Client({ name: "test", version: "0" });
    try {
      assert.deepEqual(gw.tools.map((t: Rec) => t.name), ["ext__echo", "ext__send"]);
      assert.match(gw.warnings.join("\n"), /the MCP server gone is no longer defined in .*mcp\.json; its tools are not offered/);
      let over: string | null = null;
      let asked = 0;
      offerGateway(server, gw, async () => (asked++, { allow: true }), () => undefined, () => over);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      const text = (r: Rec) => (r.content as Rec[]).map((c) => c.text).join("");
      // While the turn is live, a tool that runs without asking goes straight through.
      const live = await client.callTool({ name: "ext__echo", arguments: { text: "1" } });
      assert.equal(live.isError, undefined, JSON.stringify(live));
      assert.equal(calls(log, "echo").length, 1);
      // Once it is over (cancelled, timed out, ended), nothing is forwarded and nobody is asked.
      over = "turn 3 of j_x has ended (cancelled)";
      for (const [name, args] of [["ext__echo", { text: "2" }], ["ext__send", { to: "a", body: "b" }]] as const) {
        const r = await client.callTool({ name, arguments: args });
        assert.equal(r.isError, true, name);
        assert.match(text(r), /the turn that called it is over \(turn 3 of j_x has ended \(cancelled\)\)/, name);
      }
      assert.equal(calls(log, "echo").length, 1);
      assert.equal(calls(log, "send").length, 0);
      assert.equal(asked, 0, "nobody was asked about a call from a turn that is over");
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await gw.close();
    }
  } finally {
    closeDbForTests();
    if (saved === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("extensions (codex): relay reads back the web search setting it switches off for a turn given MCP servers, and keeps relay's tool calls alive longer than an approval waits", async (t) => {
  // This unit test builds launch flags only; its child relay needs a broker address,
  // but no transport is opened or worker launched.
  const savedSocket = process.env.RELAY_ENV_SOCKET;
  process.env.RELAY_ENV_SOCKET = path.join(os.tmpdir(), "synthetic-env.sock");
  t.after(() => { if (savedSocket === undefined) delete process.env.RELAY_ENV_SOCKET; else process.env.RELAY_ENV_SOCKET = savedSocket; });
  const { codexFlags } = await import("../dist/backends/codex.js");
  const { configProblem } = await import("../dist/backends/codex-app.js");
  const { withDefaults } = await import("../dist/core/config.js");
  const spec = (cfg: Rec, more: Rec = {}) => ({
    config: withDefaults(cfg), access: "read", cwd: os.tmpdir(), dir: os.tmpdir(), escalate: true,
    relay: { contextFile: "/x/ctx.json", runId: "run_x", nodeId: "j_x", depth: 1 }, ...more,
  });
  const flags = (cfg: Rec, more?: Rec) => codexFlags(spec(cfg, more) as never, [], {});
  const timeout = (f: { c: string[] }) => f.c.find((c) => c.startsWith("mcp_servers.relay.tool_timeout_sec="));
  // Approval queue and decision waits, one finite overlay, and transition margins.
  assert.equal(timeout(flags({})), "mcp_servers.relay.tool_timeout_sec=11400");
  assert.equal(timeout(flags({ approval_timeout_s: 7200 })), "mcp_servers.relay.tool_timeout_sec=18600");
  assert.equal(timeout(flags({ approval_timeout_s: 60 })), "mcp_servers.relay.tool_timeout_sec=7500");

  // A turn given MCP servers: web search off, and expected off in Codex's effective configuration.
  const held = flags({}, { extensionServers: ["ext"] });
  assert.ok(held.c.includes('web_search="disabled"'));
  assert.equal(held.expect.webSearch, "disabled");
  const eff = (web_search: unknown) => ({ default_permissions: "relay", permissions: { relay: held.expect.permissions.profile }, approvals_reviewer: "user", web_search, mcp_servers: { relay: { command: held.expect.relay!.command, args: held.expect.relay!.args, env: held.expect.relay!.env } }, features: { plugins: false, skill_mcp_dependency_install: false } });
  assert.equal(configProblem(eff("disabled"), held.expect), null);
  // Its own skills are switched off as for a turn given skills, with no package of relay's (review X2).
  assert.ok(held.off.join(" ").includes("--disable skill_mcp_dependency_install"));
  assert.deepEqual(held.expect.skills, { root: null, names: [] });
  for (const other of ["live", "cached", undefined]) {
    assert.match(String(configProblem(eff(other), held.expect)), /web_search is .* where relay set "disabled"/, String(other));
  }
  // child_web "ask" switches it off too, and it is read back the same way.
  assert.equal(flags({ child_web: "ask" }).expect.webSearch, "disabled");
  // Where relay leaves it to the person's own setting, it does not judge it.
  assert.equal(flags({}).expect.webSearch, undefined);
  assert.equal(configProblem(eff("live"), flags({}).expect), null);
});

test("extensions: a delegate or ask repeated with its request_id answers as the first did, naming the extensions and that the user is asked first", async () => {
  const h = await harness([{ match: task("AGAIN"), steps: [{ reply: "ok" }] }, { match: "QAGAIN", steps: [{ reply: "ok" }] }], { targets: { codex: { mcp_servers: [{ name: "ext", allow_tools: ["echo"] }] } } });
  const host = await personSession(h, "codex");
  try {
    defineServers(h);
    const args = { target: "codex", task: "AGAIN", mode: "read", extensions: true, request_id: "again-job" };
    const first = await host.call("delegate", args);
    assert.ok(first.extensions, JSON.stringify(first));
    const repeated = await host.call("delegate", args);
    assert.equal(repeated.repeated, true, JSON.stringify(repeated));
    assert.equal(repeated.job_id, first.job_id);
    // The same extensions (the item's view adds whether the user has consented yet), and the same note.
    assert.deepEqual({ skills: repeated.extensions?.skills, mcp_servers: repeated.extensions?.mcp_servers }, first.extensions);
    assert.equal(repeated.extensions_note, first.extensions_note);
    await host.answers(await pendingOf(host, first.job_id, "extensions"));
    assert.equal((await settled(host, first.job_id)).status, "done");

    const q = { target: "codex", message: "QAGAIN", extensions: true, request_id: "again-thread" };
    const asking = host.call("ask", q);
    const thread = await firstThread(h);
    await host.answers(await pendingOf(host, thread, "extensions"));
    const answered = await asking;
    assert.ok(answered.extensions, JSON.stringify(answered));
    const again = await host.call("ask", q);
    assert.equal(again.repeated, true, JSON.stringify(again));
    assert.equal(again.thread_id, thread);
    assert.deepEqual(again.extensions, answered.extensions);
    assert.equal(again.extensions_note, answered.extensions_note);
    assert.equal(h.sql("SELECT count(*) AS n FROM requests WHERE kind = 'extensions'")[0].n, 2, "nothing new was asked");
  } finally {
    await host.close();
    await h.close();
  }
});
