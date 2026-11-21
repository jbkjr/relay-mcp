import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matcherMatches, settingsAnswerForPerson, settingsArguments } from "../dist/core/claude-settings.js";
import { canBypassPrompts, hostProfile } from "../dist/mcp/host.js";
import { CLI, harness, INTERACTIVE_CLAUDE, scratchOnly, task, type Rule } from "./helpers.ts";

// Where relay cannot establish that a person answered, nothing is read as their answer: the
// confirm tool and the approval dialog are qualified only for the conditions they were seen in.

const asker = (name: string, command: string): Rule => ({ match: task(name), steps: [{ request: command }, { reply: "request result: {{last}}" }] });
const interactive = { CLAUDE_CODE_ENTRYPOINT: "cli" };

test("consent: Claude Code started able to skip permission prompts gets no confirm, and its dialog answers would not count as a person's", () => {
  const claude = { name: "claude-code", version: "2.1.286" };
  for (const line of [
    "claude --dangerously-skip-permissions",
    "/Users/x/.local/share/claude/versions/2.1.286 --allow-dangerously-skip-permissions --resume abc",
    "claude --permission-mode bypassPermissions",
    "claude --permission-mode=bypassPermissions",
  ]) {
    assert.equal(canBypassPrompts([line]), true, line);
    const p = hostProfile(interactive, claude, true, ["node /x/dist/cli.js mcp --host claude", line]);
    assert.equal(p.confirm, false, line);
    // No question is put to the user under any ask_user: an answer, accept or decline, could be the mode's.
    assert.equal(p.elicit, "no", line);
    assert.equal(p.declineIsDenial, false, line);
    assert.equal(p.longWaits, true, "waiting is unaffected");
    assert.match(p.why, /skip permission prompts/);
  }
  for (const line of ["claude", "claude --permission-mode acceptEdits", "claude --resume x", "grep -- --dangerously-skip-permissions-not"]) {
    assert.equal(canBypassPrompts([line]), false, line);
    const p = hostProfile(interactive, claude, true, [line]);
    assert.equal(p.confirm, true, line);
    assert.equal(p.elicit, "dialog", line);
  }
  // A Codex session is judged by its own rules, whatever its command line.
  assert.equal(hostProfile({}, { name: "codex-mcp-client", version: "0.163.0" }, true, ["codex --dangerously-bypass-approvals-and-sandbox"]).elicit, "dialog");
});

test("consent: a relay server whose host was started with --dangerously-skip-permissions offers no confirm and puts no question to the user", async () => {
  const h = await harness([asker("BYPASSED", "cmd-bypassed")]);
  try {
    // Stands in for Claude Code: a process started with the flag, which starts relay's server.
    const wrapper = "const c=require('node:child_process').spawn(process.execPath,[process.env.WRAP_CLI,'mcp','--host','claude'],{stdio:'inherit'});c.on('exit',(code)=>process.exit(code??0));process.on('SIGTERM',()=>c.kill('SIGTERM'));";
    const client = new Client(INTERACTIVE_CLAUDE.clientInfo, { capabilities: { elicitation: {} } });
    let asked = 0;
    const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    client.setRequestHandler(ElicitRequestSchema, async () => {
      asked++;
      return { action: "accept", content: { decision: "allow" } };
    });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["-e", wrapper, "--", "--dangerously-skip-permissions"],
      env: { ...h.env, ...INTERACTIVE_CLAUDE.env, WRAP_CLI: CLI }, cwd: h.repo,
    }));
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(tools.includes("approve"));
      assert.equal(tools.includes("confirm"), false);
      const call = async (name: string, args: Record<string, unknown>) =>
        JSON.parse(((await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })) as { content: { text: string }[] }).content[0].text);
      const job = await call("delegate", { target: "codex", task: "BYPASSED", mode: "write" });
      const waited = await call("status", { id: job.job_id, wait_s: 20 });
      assert.equal(waited.needs_approval?.[0]?.wants, "cmd-bypassed", "the request is handed to the agent");
      assert.equal(asked, 0, "the user was not asked in a mode where an answer may not be theirs");
      assert.equal(h.sql("SELECT status FROM requests")[0].status, "pending");
    } finally {
      await client.close();
    }
  } finally {
    await h.close();
  }
});

test("consent: an approval dialog answer that is not exactly one of the offered decisions decides nothing, and is reported as the host's, not the user's", async () => {
  const h = await harness([asker("ODD", "cmd-odd"), asker("EMPTY", "cmd-empty"), asker("NOTE", "cmd-note")]);
  try {
    const host = await h.instance({
      ...INTERACTIVE_CLAUDE,
      elicit: (message) => {
        if (message.includes("cmd-odd")) return { action: "accept", content: { decision: "yes please" } };
        if (message.includes("cmd-empty")) return { action: "accept", content: {} };
        return { action: "accept", content: { decision: "allow", note: 5 } };
      },
    });
    for (const name of ["ODD", "EMPTY", "NOTE"]) {
      const job = await host.call("delegate", { target: "codex", task: name, mode: "write" });
      const waited = await host.call("status", { id: job.job_id, wait_s: 20 });
      const req = waited.needs_approval?.[0];
      assert.ok(req, `${name}: handed to the agent, undecided`);
      assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", req.request_id)[0].status, "pending", name);
      if (req.user_is_being_asked) continue;
      // Not a person's answer, so neither a decision nor the user closing it: the agent decides it as any other.
      assert.equal(req.user_dismissed_prompt, undefined, name);
      assert.equal(req.host_answered_prompt, "accept (unqualified)", name);
      assert.equal((await host.call("approve", { request_id: req.request_id, decision: "deny" })).decision, "denied", name);
    }
  } finally {
    await h.close();
  }
});

test("consent: Claude Code settings that skip permission prompts or carry hooks that answer for relay are read for those two things only, and anything unreadable counts", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-consent-")));
  try {
    const home = scratchOnly(path.join(root, "home"), "HOME");
    const project = scratchOnly(path.join(root, "project"), "project");
    const managedDir = path.join(root, "managed-settings.d");
    for (const d of [path.join(home, ".claude"), path.join(project, ".claude"), managedDir]) fs.mkdirSync(d, { recursive: true });
    const env = { HOME: home };
    const write = (file: string, value: unknown) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    const clear = () => {
      for (const f of [path.join(home, ".claude", "settings.json"), path.join(project, ".claude", "settings.json"), path.join(project, ".claude", "settings.local.json")]) fs.rmSync(f, { force: true });
      for (const f of fs.readdirSync(managedDir)) fs.rmSync(path.join(managedDir, f));
    };
    const consent = (lines: string[] = [], managed: string[] = [managedDir]) => settingsAnswerForPerson(env, project, lines, managed);
    // What stands in the way of either the dialog or confirm, for the checks that concern both.
    const check = (lines: string[] = [], managed: string[] = [managedDir]) => {
      const c = consent(lines, managed);
      return c.dialog ?? c.confirm;
    };
    const secret = "sk-ant-not-a-real-key";

    assert.deepEqual(consent(), { dialog: null, confirm: null }, "no settings at all");
    const files = { user: path.join(home, ".claude", "settings.json"), project: path.join(project, ".claude", "settings.json"), local: path.join(project, ".claude", "settings.local.json"), managed: path.join(managedDir, "10-org.json") };
    for (const [where, file] of Object.entries(files)) {
      clear();
      write(file, { env: { ANTHROPIC_API_KEY: secret }, permissions: { defaultMode: "bypassPermissions", allow: ["Bash"] } });
      const why = consent();
      // A mode that skips prompts stands in the way of both.
      assert.match(String(why.dialog), /permissions\.defaultMode "bypassPermissions"/, where);
      assert.match(String(why.confirm), /permissions\.defaultMode "bypassPermissions"/, where);
      assert.ok(!JSON.stringify(why).includes(secret), `${where}: nothing but the two keys is read`);
      // A tool hook for everything stands in the way of confirm only; an elicitation hook, of the dialog only.
      for (const [hook, way] of [["PreToolUse", "confirm"], ["PermissionRequest", "confirm"], ["Elicitation", "dialog"], ["ElicitationResult", "dialog"]] as const) {
        write(file, { env: { X: secret }, hooks: { [hook]: [{ matcher: "*", hooks: [{ type: "command", command: "echo allow" }] }] } });
        const c = consent();
        assert.match(String(c[way]), new RegExp(`${hook} hooks for everything`), `${where}: ${hook}`);
        assert.equal(c[way === "dialog" ? "confirm" : "dialog"], null, `${where}: ${hook} leaves the other alone`);
        assert.ok(!JSON.stringify(c).includes(secret) && !JSON.stringify(c).includes("echo allow"), `${where}: nor the hook's command`);
      }
    }
    clear();
    // Modes that still prompt (or refuse), hooks that cannot answer, and empty hook lists pass.
    for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk"]) {
      write(files.user, { permissions: { defaultMode: mode }, hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }], PreToolUse: [] } });
      assert.equal(check(), null, mode);
    }
    // A mode relay does not know, a mode that is not a string, and a file it cannot parse all count.
    write(files.user, { permissions: { defaultMode: "yolo" } });
    assert.match(String(check()), /not a mode relay knows/);
    write(files.user, { permissions: { defaultMode: 1 } });
    assert.match(String(check()), /permissions\.defaultMode "1"/);
    write(files.user, "{ not json");
    assert.match(String(check()), /could not read the Claude Code settings/);
    clear();
    // CLAUDE_CONFIG_DIR is read as well as ~/.claude.
    const configDir = path.join(root, "config-dir");
    fs.mkdirSync(configDir);
    write(path.join(configDir, "settings.json"), { permissions: { defaultMode: "bypassPermissions" } });
    assert.match(String(settingsAnswerForPerson({ ...env, CLAUDE_CONFIG_DIR: configDir }, project, [], []).dialog), /config-dir/);
    // A managed plist (scratch path here) is read the same way.
    const plist = path.join(root, "com.anthropic.claudecode.plist");
    write(plist, { hooks: { Elicitation: [{ hooks: [{ type: "command", command: "x" }] }] } });
    assert.equal(spawnSync("/usr/bin/plutil", ["-convert", "xml1", plist]).status, 0);
    assert.match(String(consent([], [plist]).dialog), /Elicitation hooks/);

    // --settings on the command lines that started the server: inline JSON (spaces and all, as ps prints it) or a file.
    const inline = 'claude --settings {"env": {"K": "v w"}, "permissions": {"defaultMode": "bypassPermissions"}} --resume abc';
    assert.equal(settingsArguments([inline], project).length, 1);
    assert.match(String(check([inline])), /a --settings argument set permissions\.defaultMode "bypassPermissions"/);
    assert.match(String(consent(['claude --settings={"hooks":{"PermissionRequest":[{"hooks":[]}]}}']).confirm), /PermissionRequest hooks/);
    assert.equal(check(['claude --settings {"permissions": {"defaultMode": "plan"}}']), null);
    write(path.join(project, "extra.json"), { hooks: { PreToolUse: [{ hooks: [] }] } });
    assert.match(String(consent(["claude --settings extra.json"]).confirm), /extra\.json have PreToolUse hooks/, "relative to the project");
    assert.match(String(check(["claude --settings missing.json"])), /could not read/, "a file relay cannot find counts");
    assert.match(String(check(['claude --settings {"permissions": {'])), /could not read/, "nor can JSON that never closes");
    assert.equal(check(["claude --resume abc", "node /x/dist/cli.js mcp --host claude"]), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("consent: hooks that match only other tools or servers stand in the way of nothing; matchers are read as Claude Code reads them, failing closed", () => {
  // Claude Code's matcher rules: absent, "" or "*" match all; letters, digits, _, -, spaces, "," and "|" only: exact names; anything else: an unanchored regex.
  for (const [matcher, expected] of [
    [undefined, true], ["", true], ["*", true],
    ["mcp__relay__confirm", true], ["Bash|mcp__relay__confirm", true], ["Bash, mcp__relay__confirm", true], [" Edit | mcp__relay__confirm ", true],
    ["mcp__relay__.*", true], ["^mcp__relay", true], ["mcp__.*__confirm", true], ["confirm$", true], ["(", true],
    ["mcp__email__send_email", false], ["mcp__email__send_email|mcp__email__forward_email", false], ["relay", false], ["mcp__relay", false], ["mcp__relay__approve", false],
    ["confirm", false], ["^mcp__email__.*", false], ["^Bash$", false],
  ] as const) {
    assert.equal(matcherMatches(matcher, "mcp__relay__confirm"), expected, JSON.stringify(matcher));
  }
  assert.equal(matcherMatches("relay", "relay"), true);
  assert.equal(matcherMatches("email", "relay"), false);
  assert.equal(matcherMatches("^rel", "relay"), true);

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-consent-")));
  try {
    const home = scratchOnly(path.join(root, "home"), "HOME");
    const project = scratchOnly(path.join(root, "project"), "project");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    const user = path.join(home, ".claude", "settings.json");
    const consent = (hooks: unknown) => {
      fs.writeFileSync(user, JSON.stringify({ permissions: { defaultMode: "auto" }, hooks }));
      return settingsAnswerForPerson({ HOME: home }, project, [], []);
    };
    const cmd = [{ type: "command", command: "guard.sh" }];
    // The shape of a real user's settings: PreToolUse hooks that guard an email server's send and forward tools.
    assert.deepEqual(consent({
      PreToolUse: [{ matcher: "mcp__email__send_email", hooks: cmd }, { matcher: "mcp__email__forward_email", hooks: cmd }],
      SessionStart: [{ hooks: cmd }], Stop: [{ hooks: cmd }],
    }), { dialog: null, confirm: null });
    // One that reaches relay's confirm stands in the way of confirm, and not of the dialog.
    const c = consent({ PreToolUse: [{ matcher: "mcp__email__send_email", hooks: cmd }, { matcher: "mcp__relay__.*", hooks: cmd }] });
    assert.match(String(c.confirm), /PreToolUse hooks matching "mcp__relay__\.\*", which can answer for you in the permission prompt for relay's confirm/);
    assert.equal(c.dialog, null);
    assert.match(String(consent({ PermissionRequest: [{ matcher: "Bash|mcp__relay__confirm", hooks: cmd }] }).confirm), /PermissionRequest hooks/);
    for (const event of ["PreToolUse", "PermissionRequest"]) {
      assert.match(String(consent({ [event]: [{ matcher: "mcp__relay__adopt", hooks: cmd }] }).confirm), /permission prompt for relay's adopt/);
    }
    // Elicitation hooks match on the server's name.
    assert.deepEqual(consent({ Elicitation: [{ matcher: "email", hooks: cmd }], ElicitationResult: [{ matcher: "^github$", hooks: cmd }] }), { dialog: null, confirm: null });
    const e = consent({ Elicitation: [{ matcher: "email", hooks: cmd }, { matcher: "relay", hooks: cmd }] });
    assert.match(String(e.dialog), /Elicitation hooks matching "relay", which can answer for you in relay's approval dialog/);
    assert.equal(e.confirm, null);
    assert.match(String(consent({ ElicitationResult: [{ hooks: cmd }] }).dialog), /ElicitationResult hooks for everything/);
    // What relay cannot make out counts: a matcher that is not text, an event that is not a list, a regex that does not compile.
    assert.match(String(consent({ PreToolUse: [{ matcher: true, hooks: cmd }] }).confirm), /matcher relay could not read/);
    assert.match(String(consent({ Elicitation: { matcher: "email" } }).dialog), /could not read/);
    assert.match(String(consent({ PreToolUse: [{ matcher: "mcp__relay__(", hooks: cmd }] }).confirm), /PreToolUse hooks matching/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("consent: the local settings file is read where Claude Code keeps it in a git repository: the repository root, the main checkout's root from a linked worktree, and the starting directory", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-consent-")));
  try {
    const home = scratchOnly(path.join(root, "home"), "HOME");
    const repo = scratchOnly(path.join(root, "repo"), "repo");
    const sub = path.join(repo, "src", "deep");
    const wt = path.join(root, "wt");
    const plain = path.join(root, "plain", "sub");
    for (const d of [home, sub, plain]) fs.mkdirSync(d, { recursive: true });
    const g = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
    g(repo, "init", "-q", "-b", "main");
    g(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
    assert.equal(g(repo, "worktree", "add", "-q", wt).status, 0);
    fs.mkdirSync(path.join(wt, "pkg"));
    const consent = (cwd: string) => settingsAnswerForPerson({ HOME: home, PATH: process.env.PATH }, cwd, [], []);
    const hook = { hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "echo allow" }] }] } };
    const local = (dir: string) => path.join(dir, ".claude", "settings.local.json");
    const put = (dir: string) => (fs.mkdirSync(path.join(dir, ".claude"), { recursive: true }), fs.writeFileSync(local(dir), JSON.stringify(hook)));

    // At the repository root: a session started in a subdirectory, or in a linked worktree of it, reads it.
    put(repo);
    assert.match(String(consent(repo).confirm), /PermissionRequest hooks/);
    assert.match(String(consent(sub).confirm), new RegExp(`${local(repo).replace(/[.]/g, "\\.")} have PermissionRequest hooks`), "from a subdirectory");
    assert.match(String(consent(wt).confirm), /PermissionRequest hooks/, "from a linked worktree");
    assert.match(String(consent(path.join(wt, "pkg")).confirm), /PermissionRequest hooks/, "from a subdirectory of a linked worktree");
    fs.rmSync(local(repo));
    assert.deepEqual(consent(sub), { dialog: null, confirm: null });
    // A copy an older Claude Code left in the starting directory still counts, as does one at the worktree's own root.
    put(sub);
    assert.match(String(consent(sub).confirm), /PermissionRequest hooks/, "the legacy copy in the starting directory");
    put(wt);
    assert.match(String(consent(path.join(wt, "pkg")).confirm), /PermissionRequest hooks/, "the worktree's own root");
    // Outside a git repository only the starting directory is read, as before.
    put(path.join(root, "plain"));
    assert.deepEqual(consent(plain), { dialog: null, confirm: null });
    put(plain);
    assert.match(String(consent(plain).confirm), /PermissionRequest hooks/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("consent: hostProfile treats bypass or answering hooks found in settings as it treats the flag: no confirm, no question under any ask_user", () => {
  const claude = { name: "claude-code", version: "2.1.286" };
  const p = hostProfile(interactive, claude, true, ["claude"], "the Claude Code settings in /x/settings.json have Elicitation hooks, which can answer for you");
  assert.equal(p.confirm, false);
  assert.equal(p.elicit, "no");
  assert.equal(p.declineIsDenial, false);
  assert.match(p.why, /Elicitation hooks/);
  assert.equal(hostProfile(interactive, claude, true, ["claude"], null).confirm, true);
  // Each obstacle withholds only what it can answer: a hook on confirm leaves the dialog, an elicitation hook leaves confirm.
  const noConfirm = hostProfile(interactive, claude, true, ["claude"], { dialog: null, confirm: "PreToolUse hooks on confirm" });
  assert.deepEqual([noConfirm.elicit, noConfirm.declineIsDenial, noConfirm.confirm, noConfirm.confirmWithheld], ["dialog", true, false, "PreToolUse hooks on confirm"]);
  const noDialog = hostProfile(interactive, claude, true, ["claude"], { dialog: "Elicitation hooks on relay", confirm: null });
  assert.deepEqual([noDialog.elicit, noDialog.confirm, noDialog.why], ["no", true, "Elicitation hooks on relay"]);
  assert.deepEqual([hostProfile(interactive, claude, true, ["claude"], { dialog: null, confirm: null }).elicit, hostProfile(interactive, claude, true, ["claude"], { dialog: null, confirm: null }).confirm], ["dialog", true]);
  // A Codex session is not judged by Claude Code's settings.
  assert.equal(hostProfile({}, { name: "codex-mcp-client", version: "0.163.0" }, true, [], "anything").elicit, "dialog");
  // Command lines relay could not inspect are not taken for a plain start: no dialog, no confirm.
  const blind = hostProfile(interactive, claude, true, null, null);
  assert.deepEqual([blind.elicit, blind.confirm], ["no", false]);
  assert.match(blind.why, /could not inspect how Claude Code was started/);
  // Notices go to Claude Code's inbox only from the version seen taking them.
  assert.equal(hostProfile(interactive, claude, true, ["claude"]).inbox, true);
  assert.equal(hostProfile(interactive, { name: "claude-code", version: "2.1.250" }, true, ["claude"]).inbox, false);
});

test("consent: claude -p as Claude Code 2.1.302 starts relay (entry point sdk-cli, no CLAUDE_CODE_SESSION_ATTENDED) is unattended: no question under any ask_user, no confirm, no long waits", () => {
  // experiments/answers.md C-a and P-c (2026-10-17): under -p, 2.1.302 sets CLAUDE_CODE_ENTRYPOINT=sdk-cli and
  // leaves CLAUDE_CODE_SESSION_ATTENDED unset, and it cancels an elicitation within 2 ms, showing nothing.
  const claude = { name: "claude-code", version: "2.1.302" };
  for (const env of [{ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ATTENDED: "0" }]) {
    const p = hostProfile(env, claude, true, ["claude -p hello"]);
    assert.deepEqual([p.elicit, p.declineIsDenial, p.confirm, p.longWaits], ["no", false, false, false], JSON.stringify(env));
    assert.match(p.why, /running unattended \(-p\)/, JSON.stringify(env));
  }
  // An interactive session of the same version is unchanged.
  const cli = hostProfile(interactive, claude, true, ["claude"]);
  assert.deepEqual([cli.elicit, cli.confirm, cli.longWaits, cli.inbox], ["dialog", true, true, true]);
});

test("consent: a Claude Code session whose settings skip permission prompts gets no confirm and no question, even with ask_user always", async () => {
  const h = await harness([asker("SETTINGS", "cmd-settings"), asker("GUARDED", "cmd-guarded"), asker("HOOKED", "cmd-hooked"), asker("WITHHELD", "cmd-withheld")], { ask_user: "always" });
  try {
    // Control: with no settings, the same kind of session is offered confirm.
    const plain = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"] });
    assert.equal((await plain.tools()).includes("confirm"), true);
    await plain.close();
    // The harness's scratch HOME stands in for the user's: their settings put Claude Code in bypassPermissions.
    fs.mkdirSync(path.join(scratchOnly(h.env.HOME, "HOME"), ".claude"), { recursive: true });
    fs.writeFileSync(path.join(h.env.HOME, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
    let asked = 0;
    const host = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"], elicit: () => (asked++, { action: "decline" }) });
    assert.equal((await host.tools()).includes("confirm"), false);
    const job = await host.call("delegate", { target: "codex", task: "SETTINGS", mode: "write" });
    const waited = await host.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(waited.needs_approval?.[0]?.wants, "cmd-settings", "the request is handed to the agent");
    // The agent is told why, so that it can tell the user.
    assert.match(waited.approval_note, /relay is not putting requests to the user directly in this session: the Claude Code settings in \S+ set permissions\.defaultMode "bypassPermissions"/);
    assert.equal(asked, 0, "the user was not asked, so no decline could be read as theirs");
    assert.equal(h.sql("SELECT status FROM requests")[0].status, "pending");
    // Project settings with an answering hook do the same.
    fs.rmSync(path.join(h.env.HOME, ".claude", "settings.json"));
    fs.mkdirSync(path.join(h.repo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(h.repo, ".claude", "settings.local.json"), JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "echo" }] }] } }));
    const hooked = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"], elicit: () => (asked++, { action: "accept", content: { decision: "allow" } }) });
    assert.equal((await hooked.tools()).includes("confirm"), false);
    // A hook on confirm leaves the dialog: the user is asked, and their answer decides.
    const hookedJob = await hooked.call("delegate", { target: "codex", task: "HOOKED", mode: "write", background: false });
    assert.match(hookedJob.result.final_message, /"decision":"allow"/);
    assert.equal(h.sql("SELECT decided_by FROM requests WHERE summary = 'cmd-hooked'")[0].decided_by, "user");
    await hooked.close();
    // Where the user closes the dialog, the agent is told why confirm is not there to put it to them.
    const withheld = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"], elicit: () => ({ action: "cancel" }) });
    const wjob = await withheld.call("delegate", { target: "codex", task: "WITHHELD", mode: "write" });
    let ws = await withheld.call("status", { id: wjob.job_id, wait_s: 20 });
    if (ws.needs_approval?.[0]?.user_is_being_asked) ws = await withheld.call("status", { id: wjob.job_id, wait_s: 20 });
    assert.match(ws.approval_note, /confirm is not offered in this session: the Claude Code settings in \S+settings\.local\.json have PermissionRequest hooks for everything/);
    await withheld.call("approve", { request_id: ws.needs_approval[0].request_id, decision: "deny" });
    await withheld.close();
    await host.close();
    // Hooks that guard other tools only (an email server's send and forward) withhold nothing: confirm is offered and the user is asked.
    fs.rmSync(path.join(h.repo, ".claude", "settings.local.json"));
    const guard = [{ type: "command", command: "email-guard.sh" }];
    fs.mkdirSync(path.join(h.env.HOME, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(h.env.HOME, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "mcp__email__send_email", hooks: guard }, { matcher: "mcp__email__forward_email", hooks: guard }] } }));
    const before = asked;
    const guarded = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"], elicit: () => (asked++, { action: "decline" }) });
    assert.equal((await guarded.tools()).includes("confirm"), true, "confirm is offered");
    const job2 = await guarded.call("delegate", { target: "codex", task: "GUARDED", mode: "write", background: false });
    assert.equal(asked, before + 1, "the user was asked");
    assert.match(job2.result.final_message, /"decision":"deny"/);
    assert.deepEqual({ ...h.sql("SELECT status, decided_by FROM requests WHERE summary = 'cmd-guarded'")[0] }, { status: "denied", decided_by: "user" });
    await guarded.close();
  } finally {
    await h.close();
  }
});

test("consent: the Claude desktop app's own connection (local-agent-mode-relay, no elicitation) gets no dialog, confirm, notices or long waits", () => {
  // As README "Claude desktop app and Cowork" says: seen 2026-10-16, Claude Code 2.1.299 in the app; its relay sees no SDK or desktop variables.
  const p = hostProfile({}, { name: "local-agent-mode-relay", version: "1.0.0" }, false, []);
  assert.deepEqual([p.elicit, p.confirm, p.inbox, p.longWaits], ["no", false, false, false]);
});

test("desktop entry: waits under the Claude desktop app's own entry end after 50 s, below the app's 60 s tool timeout", async () => {
  const { DESKTOP_WAIT_S } = await import("../dist/mcp/host.js");
  const { LONG_WAIT_S, waitLimitS } = await import("../dist/core/wait.js");
  assert.equal(DESKTOP_WAIT_S, 50);
  // From the --desktop flag the installer writes, or from the client name the app's connection gives.
  const flagged = hostProfile({}, { name: "some-client", version: "1" }, false, [], null, { desktopEntry: true });
  const named = hostProfile({}, { name: "local-agent-mode-relay-desktop", version: "1.0.0" }, false, []);
  for (const p of [flagged, named]) assert.deepEqual([p.waitCapS, p.longWaits, p.waits], [50, false, "plain"]);
  // Even a Claude Code session that would wait for hours, if it were started from that entry.
  const cli = hostProfile(interactive, { name: "claude-code", version: "2.1.286" }, true, ["claude"], null, { desktopEntry: true });
  assert.deepEqual([cli.waitCapS, cli.longWaits, cli.waits, cli.elicit], [50, false, "plain", "no"]);
  // Anywhere else, no such cap.
  assert.equal(hostProfile(interactive, { name: "claude-code", version: "2.1.286" }, true, ["claude"]).waitCapS, null);
  assert.equal(hostProfile({}, { name: "codex-mcp-client", version: "0.162.1" }, true, []).waitCapS, null);
  // The cap applies to every wait: block_s, an explicit wait_s, and a long status wait alike.
  assert.equal(waitLimitS(240, undefined, { capS: 50 }), 50);
  assert.equal(waitLimitS(240, 240, { capS: 50 }), 50);
  assert.equal(waitLimitS(240, 30, { capS: 50 }), 30);
  assert.equal(waitLimitS(30, 240, { capS: 50 }), 30);
  assert.equal(waitLimitS(240, 6 * 3600, { long: true, longWaits: true, capS: 50 }), 50);
  assert.equal(waitLimitS(240, 6 * 3600, { long: true, longWaits: true }), LONG_WAIT_S);
  assert.equal(waitLimitS(240, 1000, { capS: null }), 240);
});

test("desktop entry: every tool text and the instructions say which relay this is, only under the desktop app's own entry", async () => {
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { DESKTOP_STEER, relayServer } = await import("../dist/mcp/server.js");
  const ops = await import("../dist/core/ops.js");
  const tmp = scratchOnly(fs.mkdtempSync(path.join(os.tmpdir(), "relay-desktop-entry-")));
  const saved = { home: process.env.RELAY_HOME, config: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = tmp;
  process.env.RELAY_CONFIG = path.join(tmp, "config.json");
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ allow_temp_home: true }));
  const texts = async (desktop: boolean, client: { name: string; version: string }) => {
    const server = relayServer(ops.newInstance({ kind: "root" }, tmp, "claude"), { desktop });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client(client);
    await Promise.all([server.connect(a), c.connect(b)]);
    const tools = (await c.listTools()).tools;
    const out = { instructions: c.getInstructions() ?? "", tools: Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""])) };
    await c.close();
    return out;
  };
  try {
    assert.match(DESKTOP_STEER, /^relay-desktop is the Claude desktop app's shared relay, for its chats and Cowork: in a session that also has relay's own tools \(mcp__relay__\*, as in a Code tab session\), use those instead\.$/);
    const desktop = await texts(true, { name: "local-agent-mode-relay-desktop", version: "1.0.0" });
    assert.ok(desktop.instructions.startsWith(`${DESKTOP_STEER} relay reaches other families`), desktop.instructions);
    assert.deepEqual(Object.keys(desktop.tools).sort(), ["adopt", "approve", "ask", "brief", "cancel", "delegate", "discuss", "merge", "result", "resume", "review", "room", "status"]);
    for (const [name, text] of Object.entries(desktop.tools)) assert.ok(text.startsWith(`${DESKTOP_STEER} `), `${name}: ${text.slice(0, 80)}`);
    // The waiting the texts teach is the capped one.
    assert.match(desktop.tools.status, /relay ends a wait after 50 s; call again to go on waiting/);
    assert.match(desktop.tools.delegate, /relay ends a wait after 50 s/);

    for (const client of [{ name: "claude-code", version: "2.1.286" }, { name: "local-agent-mode-relay", version: "1.0.0" }]) {
      const plain = await texts(false, client);
      assert.doesNotMatch(plain.instructions, /relay-desktop/, client.name);
      for (const [name, text] of Object.entries(plain.tools)) assert.doesNotMatch(text, /relay-desktop/, `${client.name} ${name}`);
    }
    // A connection that names itself as the app's, without the flag (an entry from an earlier relay), still gets the cap.
    assert.match((await texts(false, { name: "local-agent-mode-relay", version: "1.0.0" })).tools.status, /relay ends a wait after 50 s/);
  } finally {
    for (const [k, v] of [["RELAY_HOME", saved.home], ["RELAY_CONFIG", saved.config]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("consent: the directories of a session's local settings are what git answers to each question on its own, wherever the session starts", async () => {
  const { localSettingsDirs } = await import("../dist/core/claude-settings.js");
  const root = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-localdirs-"))));
  try {
    const g = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
    const repo = path.join(root, "repo");
    const wt = path.join(root, "wt");
    fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
    assert.equal(g(repo, "init", "-q", "-b", "main").status, 0);
    assert.equal(g(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i").status, 0);
    assert.equal(g(repo, "worktree", "add", "-q", wt).status, 0);
    const bare = path.join(root, "bare.git");
    assert.equal(g(root, "init", "-q", "--bare", bare).status, 0);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    // The old way, one git per question.
    const separately = (cwd: string) => {
      const ask = (...a: string[]) => { const r = g(cwd, "rev-parse", ...a); return r.status === 0 ? r.stdout.trim() : ""; };
      const top = ask("--show-toplevel");
      const common = ask("--path-format=absolute", "--git-common-dir");
      return [...new Set([cwd, ...(top ? [top] : []), ...(common ? [path.dirname(common)] : [])])];
    };
    const places = { repo, sub: path.join(repo, "pkg"), worktree: wt, "inside .git": path.join(repo, ".git"), bare, outside };
    for (const [name, cwd] of Object.entries(places)) assert.deepEqual(localSettingsDirs(cwd), separately(cwd), name);
    assert.deepEqual(localSettingsDirs(wt), [wt, repo], "a linked worktree: its own root and the main checkout's");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
