import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { staysSandboxed } from "../dist/core/approvals.js";
import { acknowledgesCancel } from "../dist/mcp/elicit.js";
import { shown } from "../dist/core/shown.js";
import { adoptRun, alive, CLI, terminalApprove, forEachTarget, harness, INTERACTIVE_CLAUDE, reached, release, sleep, task, until, type Rec, type Rule, UNAVAILABLE_REPLY } from "./helpers.ts";

// A request is a shell command to run outside the sandbox, or a stub request object ({ web: "query" }, say).
// Under the never floor a Claude job's command requests are refused before they are filed (core/approvals.ts),
// so tests of the approval plumbing that launch Claude have it ask for something else, such as a web search.
const asker = (name: string, command: string | Record<string, unknown>): Rule => ({
  match: task(name),
  steps: [{ request: command }, { reply: "request result: {{last}}" }],
});
/** What relay tells a Claude agent whose command request the never floor refuses. */
const CLAUDE_COMMAND_REFUSED = /never: Claude command approvals are unavailable under the never floor, so this request was refused and nobody was asked/;

forEachTarget((target) => {
  test(`escalation (${target}): a blocked agent's request reaches the root, which allows or denies it`, async () => {
    // Claude asks for web searches: its command requests are refused before they are filed (see the next Claude test).
    const ask = (q: string) => (target === "claude" ? { web: q } : q);
    const wants = (q: string) => (target === "claude" ? `web search: ${q}` : q);
    const h = await harness([asker("NEEDS", ask("npm install left-pad")), asker("NEEDS2", ask("rm -rf build"))]);
    try {
      const job = await h.call("delegate", { target, task: "NEEDS", mode: "write", allow_delegation: false });
      // The root is waiting on the job; the request interrupts the wait and is handed to it.
      const waited = await h.call("status", { id: job.job_id, wait_s: 20 });
      assert.equal(waited.status, "running");
      assert.equal(waited.needs_approval.length, 1);
      const req = waited.needs_approval[0];
      assert.equal(req.from, job.job_id);
      assert.equal(req.agent, target);
      assert.equal(req.wants, wants("npm install left-pad"));
      assert.match(waited.approval_note, /approve tool/);
      assert.ok(h.cli("tree").includes(`! needs approval ${req.request_id}: ${wants("npm install left-pad")}`), h.cli("tree"));
      assert.match(h.cli("approvals"), /npm install left-pad/);

      const start = h.starts()[0];
      if (target === "claude") {
        assert.equal(start.promptTool, "mcp__relay__permission_prompt");
        assert.equal(start.hasRelay, true, "the server is present for the permission tool even though the job may not delegate");
      } else {
        assert.equal(start.via, "app-server");
        assert.equal(start.thread.approvalPolicy, "on-request");
        // The sandbox is relay's permission profile, named on the thread; no legacy sandbox beside it.
        assert.equal(start.thread.permissions, "relay");
        assert.equal(start.thread.sandbox, undefined);
        assert.equal(start.access, "write");
      }

      const ok = await h.call("approve", { request_id: req.request_id, decision: "allow", note: "fine" });
      assert.equal(ok.decision, "allowed");
      const done = await h.call("status", { id: job.job_id, wait_s: 20 });
      assert.equal(done.status, "done");
      assert.match(done.result.final_message, /"decision":"allow"/);
      assert.equal(done.needs_approval, undefined);
      assert.match((await h.call("approve", { request_id: req.request_id, decision: "deny" })).error, /already allowed/);

      // Denied, this time from the terminal.
      const job2 = await h.call("delegate", { target, task: "NEEDS2", mode: "write" });
      await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 10000, "second request");
      const id2 = h.sql("SELECT id FROM requests WHERE status = 'pending'")[0].id;
      assert.equal(JSON.parse(h.cli("deny", id2, "not", "on", "this", "machine")).decision, "denied");
      const done2 = await h.call("status", { id: job2.job_id, wait_s: 20 });
      assert.equal(done2.status, "blocked", "the agent finished, but was refused what it asked for");
      assert.match(done2.blocked[0], /rm -rf build/);
      assert.match(done2.outcome_note, /refused something it tried/);
      assert.match(done2.result.final_message, /"decision":"deny"/);
      assert.equal(h.sql("SELECT note FROM requests WHERE id = ?", id2)[0].note, "not on this machine");
    } finally {
      await h.close();
    }
  });
});

test("escalation: a command with a line break keeps it, escaped with its line count, in progress lines, the tree and event texts", async () => {
  const cmd = "echo one\nprintf two";
  const h = await harness([{
    match: task("MULTI"),
    steps: [{ emit: { method: "item/started", params: { item: { type: "commandExecution", id: "exec_1", command: cmd } } } }, { awaitMark: "seen" }, { request: cmd }, { reply: "request result: {{last}}" }],
  }]);
  try {
    const escaped = "(2 lines, shown escaped) echo one\\nprintf two";
    const session = await h.instance({ env: { RELAY_TICK_MS: "300" } });
    const job = await session.call("delegate", { target: "codex", task: "MULTI", mode: "write" });
    const lines: string[] = [];
    const ctl = new AbortController();
    const waiting = session.call("status", { id: job.job_id, wait_s: 30 }, { onprogress: (p) => lines.push(p.message ?? ""), signal: ctl.signal });
    await until(() => lines.some((l) => l.includes("now: $")), 10000, "a progress line naming the command");
    assert.ok(lines.find((l) => l.includes("now: $"))!.includes(`now: $ ${escaped}`), JSON.stringify(lines));
    ctl.abort();
    await assert.rejects(waiting);
    h.mark("seen");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 15000, "the request");
    const id = h.sql("SELECT id FROM requests")[0].id;
    assert.ok(h.cli("tree").includes(`! needs approval ${id}: ${escaped}`), h.cli("tree"));
    assert.equal(terminalApprove(h, id).json.decision, "allowed");
    const told = await session.call("status", { id: job.job_id, wait_s: 20 });
    const decided = (told.events ?? []).find((e: { kind: string }) => e.kind === "decided");
    assert.ok(decided, JSON.stringify(told.events));
    assert.ok(decided.notice.includes(escaped), decided.notice);
  } finally {
    await h.close();
  }
});

test("escalation: the approval dialog shows the asking agent's task escaped, so control characters and bidi overrides in it do not reach the screen", async () => {
  const h = await harness([{ match: "TASKCTL", steps: [{ request: "cmd-taskctl" }, { reply: "request result: {{last}}" }] }]);
  try {
    const messages: string[] = [];
    const host = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"], elicit: (m) => (messages.push(m), { action: "cancel" }) });
    // ESC sequences that would clear the screen and recolour what follows, and a right-to-left override.
    const job = await host.call("delegate", { target: "codex", task: "TASKCTL \u001b[2J\u001b[31mfix it\u001b[0m \u202Eevil.sh", mode: "write" });
    await host.call("status", { id: job.job_id, wait_s: 20 });
    await until(() => messages.some((m) => m.includes("cmd-taskctl")), 15000, "the approval dialog");
    const lines = messages.find((m) => m.includes("cmd-taskctl"))!.split("\n");
    const taskLine = lines.find((l) => l.startsWith("Its task"));
    assert.ok(taskLine, JSON.stringify(lines));
    assert.doesNotMatch(taskLine, /[\u0000-\u001f\u007f\p{Cf}]/u, JSON.stringify(taskLine));
    assert.match(taskLine, /^Its task \(depth 1, write session\): \(1 line, shown escaped\) TASKCTL \\u001b\[2J\\u001b\[31mfix it\\u001b\[0m \\u\{202E\}evil\.sh$/);
    const id = h.sql("SELECT id FROM requests WHERE status = 'pending'")[0].id;
    assert.equal(terminalApprove(h, id).json.decision, "allowed");
    assert.equal((await host.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
  } finally {
    await h.close();
  }
});

test("escalation (claude): under the never floor a Claude command request, sandboxed or asking to leave its sandbox, is refused before it is filed; staysSandboxed still says when an allowed one would stay sandboxed", async () => {
  // Claude command approvals are unavailable under the floor, whether the request would stay in
  // its sandbox or asks to leave it: relay refuses it at once, files nothing and asks nobody.
  const h = await harness([
    { match: task("INSIDE"), steps: [{ request: { sandboxed: "node build.js" } }, { reply: "request result: {{last}}" }] },
    asker("OUTSIDE", "curl -sI https://example.com"),
  ]);
  try {
    for (const [name, mode] of [["INSIDE", "write"], ["INSIDE", "read"], ["OUTSIDE", "write"]] as const) {
      const job = await h.call("delegate", { target: "claude", task: name, mode, background: false });
      assert.equal(job.status, "blocked", `${name} ${mode}: the agent was refused what it asked for: ${JSON.stringify(job)}`);
      assert.equal(job.needs_approval, undefined);
      assert.match(job.result.final_message, /"decision":"deny"/);
      assert.match(job.result.final_message, CLAUDE_COMMAND_REFUSED);
      assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests WHERE node_id = ?", job.job_id)[0].c, 0, `${name} ${mode}: nothing filed`);
    }
    // What allowing a command would do where one is filed: sandboxed only when it asked to stay
    // in, under relay's own settings, with no organisation-managed settings outranking them.
    assert.equal(staysSandboxed(true, "isolated", null), true);
    assert.equal(staysSandboxed(true, "isolated", "/Library/Application Support/ClaudeCode/managed-settings.json"), false);
    assert.equal(staysSandboxed(true, "inherit", null), false);
    assert.equal(staysSandboxed(undefined, "isolated", null), false);
  } finally {
    await h.close();
  }
});

test("escalation: only the root can approve, and a nested agent's request still reaches it", async () => {
  const h = await harness([
    {
      match: task("PARENT"),
      steps: [
        { call: "delegate", args: { target: "codex", task: "CHILD", mode: "write", background: true }, as: "child" },
        // Held until the child's request is pending, so that there is something to see and to try to approve.
        { await: "child-asked" },
        { call: "status", args: {}, as: "seen" },
        { call: "approve", args: { request_id: "{{seen.needs_approval.0.request_id}}", decision: "allow" }, as: "tried" },
        { signal: "parent-tried" },
        { call: "status", args: { id: "{{child.job_id}}", wait_s: 20 } },
        { reply: "parent done" },
      ],
    },
    asker("CHILD", "curl https://example.com"),
  ]);
  try {
    const parent = await h.call("delegate", { target: "claude", task: "PARENT", mode: "write" });
    const waited = await h.call("status", { id: parent.job_id, wait_s: 20 });
    assert.equal(waited.needs_approval.length, 1, "the depth-2 agent's request is visible from the root");
    assert.equal(waited.needs_approval[0].depth, 2);
    release(h, "child-asked");
    await until(() => reached(h, "parent-tried"), 20000, "the parent to try to approve");
    assert.equal(h.sql("SELECT status FROM requests")[0].status, "pending", "the parent could not approve it");
    await h.call("approve", { request_id: waited.needs_approval[0].request_id, decision: "allow" });
    assert.equal((await h.call("status", { id: parent.job_id, wait_s: 20 })).status, "done");
    const parentEnd = h.ends().find((e) => e.reply === "parent done")!;
    const tried = parentEnd.calls.find((c: { tool: string }) => c.tool === "approve")!;
    assert.ok(tried.result.tool_error || tried.result.error || tried.result.refused, "a launched agent has no way to approve");
    assert.equal(parentEnd.calls.find((c: { tool: string }) => c.tool === "status")!.result.needs_approval.length, 1, "but it can see what its child is waiting for");
  } finally {
    await h.close();
  }
});

test("escalation: an unanswered request expires as a denial, the wait does not use up the job's time, and it can be switched off", async () => {
  // The job's own running time (starting, asking, finishing) must stay under its limit on a loaded machine too, so the limit is not cut fine.
  const h = await harness([asker("SLOWASK", "make deploy")], { approval_timeout_s: 6, job_timeout_s: 4 });
  try {
    const job = await h.call("delegate", { target: "codex", task: "SLOWASK", mode: "write" });
    await until(() => h.sql("SELECT status FROM requests")[0]?.status === "expired", 15000, "the request to expire");
    const done = await h.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(done.status, "blocked", "six seconds waiting for approval did not trip the four-second job timeout; the expired request is a refusal");
    assert.match(done.result.final_message, /"decision":"deny"/);
  } finally {
    await h.close();
  }
  const off = await harness([asker("NOASK", "make deploy")], { escalation: false });
  try {
    const job = await off.call("delegate", { target: "claude", task: "NOASK", mode: "write", background: false });
    assert.equal(job.status, "blocked", "Claude refused the permission on the spot, and says so");
    const s = off.starts()[0];
    assert.equal(s.promptTool, null);
    assert.ok(s.argv.join(" ").includes("--permission-prompts none"));
    assert.match(s.prompt, /do not work around it\. Finish what you can and say exactly what you needed/);
    assert.equal(off.sql("SELECT COUNT(*) AS c FROM requests")[0].c, 0);
    const cx = await off.call("delegate", { target: "codex", task: "NOASK", mode: "write", background: false });
    assert.equal(cx.status, "done", "a command that fails in Codex's sandbox is not a refusal Codex reports");
    assert.equal(off.starts()[1].thread.approvalPolicy, "never", "without escalation Codex is told never to ask");
  } finally {
    await off.close();
  }
});

test("escalation: where the host can ask, the user answers directly; a closed question stays undecided and cannot be answered by the agent on its own", async () => {
  // B is Claude's, which asks for a web search: its command requests are refused before they are filed.
  const h = await harness([asker("A", "cmd-allow"), asker("B", { web: "cmd-decline" }), asker("C", "cmd-dismiss")]);
  try {
    const seen: string[] = [];
    const host = await h.instance({
      ...INTERACTIVE_CLAUDE,
      elicit: (message) => {
        seen.push(message);
        if (message.includes("cmd-allow")) return { action: "accept", content: { decision: "allow", note: "go ahead" } };
        if (message.includes("cmd-decline")) return { action: "decline" };
        return { action: "cancel" };
      },
    });
    // Allowed by the user: the agent never sees a request to decide.
    const a = await host.call("delegate", { target: "codex", task: "A", mode: "write", background: false });
    assert.equal(a.status, "done");
    assert.equal(a.needs_approval, undefined);
    assert.match(a.result.final_message, /"decision":"allow"/);
    // Claude Code shows the first lines and folds the rest: who asks, its effect, what exactly and where come first.
    const [first, second, third] = seen[0].split("\n");
    // Generic Codex fixture requests model input to an existing terminal, whose authority is unknown.
    assert.ok(first.startsWith(`relay: the codex agent ${a.job_id} asks for approval. Effect: runs this one command outside the sandbox, with your full access`), first);
    assert.equal(second, "Wants: cmd-allow");
    assert.match(third, /^In: \//);
    assert.deepEqual({ ...h.sql("SELECT status, decided_by, note FROM requests")[0] }, { status: "allowed", decided_by: "user", note: "go ahead" });
    // The agent is told that the user decided it, so that it does not say nobody approved anything.
    const allowedId = h.sql("SELECT id FROM requests WHERE summary = 'cmd-allow'")[0].id;
    const told = (a.events ?? []).filter((e: { kind: string }) => e.kind === "decided");
    assert.equal(told.length, 1, JSON.stringify(a.events));
    assert.equal(told[0].about, allowedId);
    assert.match(told[0].notice, new RegExp(`approval ${allowedId} \\(job ${a.job_id}: cmd-allow\\) was allowed by the user in relay's approval dialog`));

    // Declined in Claude Code's dialog, however fast: the user's denial, again without involving the agent.
    const b = await host.call("delegate", { target: "claude", task: "B", mode: "write", background: false });
    assert.equal(b.status, "blocked");
    assert.match(b.result.final_message, /"decision":"deny"/);
    assert.equal(h.sql("SELECT decided_by FROM requests WHERE summary = 'web search: cmd-decline'")[0].decided_by, "user");
    assert.match((b.events ?? []).find((e: { kind: string }) => e.kind === "decided")?.notice ?? "", /approval q_\w+ \(job j_\w+: web search: cmd-decline\) was denied by the user in relay's approval dialog/);

    // Closed without answering (Esc), however fast: no decision. Handed to the agent, which may deny, or allow only on the user's say-so.
    const c = await host.call("delegate", { target: "codex", task: "C", mode: "write" });
    let waited = await host.call("status", { id: c.job_id, wait_s: 20 });
    const id = waited.needs_approval[0].request_id;
    // While the question is still on screen the agent is told so, and cannot allow on its own judgment.
    if (waited.needs_approval[0].user_is_being_asked) {
      assert.match((await host.call("approve", { request_id: id, decision: "allow" })).reason, /being asked about this request directly/);
      waited = await host.call("status", { id: c.job_id, wait_s: 20 });
    }
    assert.equal(waited.needs_approval[0].user_dismissed_prompt, true);
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", id)[0].status, "pending", "a cancel decides nothing");
    assert.match(waited.approval_note, /allow only with user_confirmed/);
    assert.match((await host.call("approve", { request_id: id, decision: "allow" })).reason, /closed it without answering/);
    assert.equal((await host.call("approve", { request_id: id, decision: "allow", user_confirmed: true })).decision, "allowed");
    assert.equal((await host.call("status", { id: c.job_id, wait_s: 20 })).status, "done");
    assert.equal(seen.length, 3, "each request was asked once");
    const log = fs.readFileSync(path.join(h.home, "elicitation.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.map((e) => [e.action, e.reading]), [["accept", "allow"], ["decline", "denied by the user"], ["cancel", "dismissed: left undecided"]]);
  } finally {
    await h.close();
  }
});

test("escalation: a request is put to the user as soon as it is filed, with no call waiting, and is withdrawn when decided elsewhere", async () => {
  // ELSEWHERE is Claude's, which asks for a web search: its command requests are refused before they are filed.
  const h = await harness([asker("NOW", "cmd-now"), asker("ELSEWHERE", { web: "cmd-elsewhere" })]);
  try {
    const seen: string[] = [];
    let withdrawn = false;
    const host = await h.instance({
      ...INTERACTIVE_CLAUDE,
      elicit: (message, signal, params) => {
        seen.push(message);
        // Claude Code's dialog keeps the order it always had.
        assert.deepEqual(params.requestedSchema.properties.decision.enum, ["allow", "allow for the rest of this job", "deny"]);
        if (message.includes("cmd-now")) return { action: "accept", content: { decision: "allow for the rest of this job" } };
        // Left on screen until relay takes it back.
        return new Promise((resolve) => signal.addEventListener("abort", () => {
          withdrawn = true;
          resolve({ action: "cancel" });
        }));
      },
    });
    const job = await host.call("delegate", { target: "codex", task: "NOW", mode: "write" });
    assert.equal(job.status, "queued", "delegate returned at once");
    await until(() => h.sql("SELECT status FROM requests")[0]?.status === "allowed", 15000, "the user's answer, with nothing waiting");
    assert.deepEqual({ ...h.sql("SELECT decided_by, scope FROM requests")[0] }, { decided_by: "user", scope: "job" });
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "done", 15000, "the job to finish");

    const job2 = await host.call("delegate", { target: "claude", task: "ELSEWHERE", mode: "write" });
    await until(() => seen.length === 2, 15000, "the second question");
    const id = h.sql("SELECT id FROM requests WHERE summary = 'web search: cmd-elsewhere'")[0].id;
    assert.equal(terminalApprove(h, id).json.decision, "allowed");
    await until(() => withdrawn, 10000, "the question to be withdrawn");
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job2.job_id)[0].status === "done", 15000, "the second job to finish");
    await until(() => h.sql("SELECT reading FROM elicitations WHERE request_id = ?", id)[0]?.reading === "withdrawn", 10000, "the withdrawal outcome to be recorded");
    const log = fs.readFileSync(path.join(h.home, "elicitation.log"), "utf8");
    assert.match(log, /"action":"withdrawn"/);
    assert.equal(h.sql("SELECT reading FROM elicitations WHERE request_id = ?", id)[0].reading, "withdrawn");
  } finally {
    await h.close();
  }
});

test("escalation: a question the user closed is not asked again by a relay server started later", async () => {
  const h = await harness([asker("CLOSED", "cmd-closed"), { match: "carry on", steps: [{ reply: "carried on" }] }]);
  try {
    let asked1 = 0;
    const first = await h.instance({ ...INTERACTIVE_CLAUDE, elicit: () => (asked1++, { action: "cancel" }) });
    const job = await first.call("delegate", { target: "codex", task: "CLOSED", mode: "write" });
    await until(() => h.sql("SELECT reading FROM elicitations")[0]?.reading === "dismissed", 15000, "the question to be closed");
    await first.close();
    const rootPid = h.sql("SELECT root_pid FROM runs")[0].root_pid;
    await until(() => !alive(rootPid), 5000, "the first server to exit");

    let asked2 = 0;
    const second = await h.instance({ ...INTERACTIVE_CLAUDE, elicit: () => (asked2++, { action: "accept", content: { decision: "allow" } }) });
    // Explicit recovery transfers the run; the new server watches it from then on.
    await adoptRun(h, second, job.job_id);
    assert.equal((await second.call("resume", { job_id: job.job_id, message: "carry on" })).status, "queued_behind_current_turn");
    const waited = await second.call("status", { id: job.job_id, wait_s: 3 });
    assert.equal(waited.needs_approval[0].user_dismissed_prompt, true);
    assert.equal(asked1, 1);
    assert.equal(asked2, 0, "not asked again");
    assert.equal((await second.call("approve", { request_id: waited.needs_approval[0].request_id, decision: "deny" })).decision, "denied");
  } finally {
    await h.close();
  }
});

test("escalation: headless, desktop and unrecognised hosts are never asked, including with ask_user always", async () => {
  const h = await harness([asker("HEADLESS", "cmd-x"), asker("DESKTOP", "cmd-y"), asker("UNKNOWN", "cmd-z")]);
  try {
    let asked = 0;
    const elicit = () => (asked++, { action: "decline" });
    for (const [label, env] of [["HEADLESS", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ATTENDED: "0" }], ["DESKTOP", { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_DESKTOP_APP_VERSION: "1.0", CLAUDE_AGENT_SDK_VERSION: "0.3" }]] as const) {
      // Both answer every question on their own (unattended Claude Code cancels, the desktop app declines), with nothing shown.
      const host = await h.instance({ clientInfo: { name: "claude-code", version: "2.1.299" }, env, elicit });
      const job = await host.call("delegate", { target: "codex", task: label, mode: "write" });
      const waited = await host.call("status", { id: job.job_id, wait_s: 20 });
      assert.equal(waited.needs_approval.length, 1);
      assert.equal(waited.needs_approval[0].user_dismissed_prompt, undefined);
      assert.equal(waited.needs_approval[0].effect, "runs this one command outside the sandbox, with your full access");
      assert.equal((await host.call("approve", { request_id: waited.needs_approval[0].request_id, decision: "allow" })).decision, "allowed");
      assert.equal((await host.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
      await host.close();
    }
    assert.equal(asked, 0, "no question went to a host that answers on its own");
    assert.deepEqual(h.sql("SELECT decided_by FROM requests").map((r) => r.decided_by), ["root session", "root session"]);
    const log = fs.readFileSync(path.join(h.home, "elicitation.log"), "utf8");
    assert.match(log, /"action":"not asked","reading":"Claude Code running unattended/);
    assert.match(log, /"action":"not asked","reading":"Claude Code under the Agent SDK or the desktop app/);

    // A host relay does not recognise is not asked under "auto".
    const unknown = await h.instance({ elicit });
    const u = await unknown.call("delegate", { target: "codex", task: "UNKNOWN", mode: "write" });
    const w = await unknown.call("status", { id: u.job_id, wait_s: 20 });
    assert.equal(w.needs_approval.length, 1);
    assert.equal(asked, 0);
    await unknown.call("approve", { request_id: w.needs_approval[0].request_id, decision: "deny" });
  } finally {
    await h.close();
  }
  // "always" cannot bypass the unknown surface's missing idle/busy qualification.
  const always = await harness([asker("UNKNOWN", "cmd-z")], { ask_user: "always" });
  try {
    let asked = 0;
    const host = await always.instance({ elicit: () => (asked++, { action: "decline" }) });
    const job = await host.call("delegate", { target: "codex", task: "UNKNOWN", mode: "write", background: false });
    assert.equal(job.pending, true);
    assert.equal(asked, 0);
    assert.equal(always.sql("SELECT status FROM requests")[0].status, "pending");
    await host.call("approve", { request_id: job.needs_approval[0].request_id, decision: "deny" });
    assert.equal(always.sql("SELECT decided_by FROM requests")[0].decided_by, "root session");
  } finally {
    await always.close();
  }
});

test("escalation: requests made at the same moment are handled one after another, and a rest-of-job approval covers the ones behind it", async () => {
  const h = await harness([
    { match: "PARALLEL", steps: [{ requests: [{ fetch: "https://a.example" }, { fetch: "https://b.example" }, { fetch: "https://c.example" }] }, { reply: "{{last}}" }] },
  ]);
  try {
    const pending = h.call("ask", { target: "claude", message: "PARALLEL" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 10000, "first request");
    await sleep(600);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests")[0].c, 1, "the other two wait instead of being refused");
    const first = h.sql("SELECT id FROM requests")[0].id;
    await h.call("approve", { request_id: first, decision: "allow", scope: "job" });
    // The root's blocking call was handed the request and returned; the thread carries on once it is decided.
    const handle = await pending;
    assert.equal(handle.pending, true);
    const r = await h.call("status", { id: handle.thread_id, wait_s: 20 });
    assert.equal((r.result.reply.match(/"decision":"allow"/g) ?? []).length, 3, "all three fetches were allowed");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests")[0].c, 1, "and only one question was ever asked");
  } finally {
    await h.close();
  }
});

test("a job's worktree is not removed while agents it started are still working in it", async () => {
  const h = await harness([
    { match: task("OUTER"), steps: [{ call: "delegate", args: { target: "codex", task: "INNER", mode: "read", background: true } }, { reply: "outer done without waiting" }] },
    // Held until the test has seen the outer job finish while it is still at work.
    { match: task("INNER"), steps: [{ await: "inner-may-finish" }, { reply: "inner done" }] },
  ]);
  try {
    const fs = await import("node:fs");
    const outer = await h.call("delegate", { target: "claude", task: "OUTER", mode: "write", background: false });
    assert.equal(outer.status, "done");
    assert.equal(outer.result.no_changes, true, "it changed nothing");
    assert.equal(outer.outcome, "no_changes");
    assert.equal(outer.result.branch, `relay/${outer.job_id}`, "but its worktree is kept: its child is still running inside it");
    const cwd = h.starts()[0].cwd;
    assert.ok(fs.existsSync(cwd));
    await until(() => h.starts().length === 2, 60000, "inner to start");
    assert.equal(h.starts()[1].cwd, cwd, "the read child works in the parent's worktree");
    release(h, "inner-may-finish");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM nodes WHERE status = 'done'")[0].c === 2, 10000, "inner to finish");
    assert.ok(fs.existsSync(cwd));
  } finally {
    await h.close();
  }
});

test("escalation: requests cannot be decided across runs, are closed when the job is cancelled, and no launched agent is offered approve", async () => {
  // Claude asks for a web search: its command requests are refused before they are filed.
  const h = await harness([asker("HOLD", { web: "sleep-forever" }), { match: "CONSULT", steps: [{ tools: true }, { reply: "{{last}}" }] }]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "HOLD", mode: "write" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 10000, "request");
    const id = h.sql("SELECT id FROM requests")[0].id;
    const other = await h.instance({});
    await other.call("delegate", { target: "claude", task: "unrelated", mode: "read", background: false });
    assert.deepEqual(await other.call("approve", { request_id: id, decision: "allow" }), UNAVAILABLE_REPLY);
    assert.equal(h.sql("SELECT status FROM requests")[0].status, "pending");

    await h.call("cancel", { id: job.job_id });
    assert.equal(h.sql("SELECT status FROM requests")[0].status, "expired");
    assert.equal(JSON.parse(h.cli("approve", id)).error, `request ${id} is already expired`);

    // No launched agent is offered approve, whatever else it has.
    const r = await h.call("ask", { target: "claude", message: "CONSULT", allow_delegation: true });
    assert.ok(r.reply.includes("delegate"));
    assert.ok(!r.reply.includes('"approve"'));
  } finally {
    await h.close();
  }
});

forEachTarget((target) => {
  test(`read sessions (${target}): a consult can ask for the web, "rest of the job" stops repeat asks, and edits are never askable`, async () => {
    const h = await harness([
      {
        match: "RESEARCH",
        steps: [
          { awaitMark: "ask-returned" },
          // Codex's stub represents this as `curl <query>`; a literal relay word now correctly
          // requires the person under DM8, independently of the web-approval behavior tested here.
          { request: { web: "mcp protocol" } }, { reply: "first: {{last}}" },
        ],
      },
      // Codex has no separate web request (its web search tool is governed by config), so only Claude repeats one here.
      { target: "claude", match: "AGAIN", steps: [{ request: { web: "second query" } }, { request: { edit: "/etc/hosts" } }, { reply: "second web: done; edit: {{last}}" }] },
      { target: "codex", match: "AGAIN", steps: [{ request: { edit: "/etc/hosts" } }, { reply: "edit: {{last}}" }] },
      // With the network granted a real Codex job just uses it; only Claude's web tools pass through the permission tool.
      { target: "claude", match: task("WEBJOB"), steps: [{ request: { fetch: "https://example.com" } }, { reply: "{{last}}" }] },
    ], { block_s: 1 });
    try {
      const finished = async (id: string): Promise<Rec> => {
        let view: Rec = {};
        await until(async () => {
          view = await h.call("status", { id, wait_s: 1 });
          return typeof view.status === "string" && !["queued", "running"].includes(view.status);
        }, 60000, `${id} to finish`);
        return view;
      };
      // A consult that needs the web files a request; allowing it for the rest of the job lets its later web searches and fetches through.
      // An ask may return pending before the agent reaches its permission prompt on a loaded
      // machine. Force that ordering with a gate, then wait for the request to be handed back.
      // Approving while a call still waits would race its return, so approve only afterwards.
      const first = await h.call("ask", { target, message: "RESEARCH" });
      assert.equal(first.pending, true);
      assert.equal(first.needs_approval, undefined, "the stub cannot ask until the initial call has returned");
      h.mark("ask-returned");
      let handed: Rec = {};
      await until(async () => {
        handed = await h.call("status", { id: first.thread_id, wait_s: 1 });
        return Boolean(handed.needs_approval?.length);
      }, 60000, "the consult's web request to be handed back");
      assert.equal(handed.needs_approval?.length, 1, JSON.stringify(handed));
      const req = h.sql("SELECT * FROM requests WHERE id = ?", handed.needs_approval[0].request_id)[0];
      assert.equal(req.status, "pending");
      assert.equal(h.sql("SELECT kind, mode FROM nodes WHERE id = ?", req.node_id)[0].mode, "read");
      if (target === "claude") assert.equal(req.summary, "web search: mcp protocol");
      const ok = await h.call("approve", { request_id: req.id, decision: "allow", scope: "job" });
      assert.equal(ok.scope, "rest of the job");
      const settled = await finished(first.thread_id);
      assert.equal(settled.status, "done", JSON.stringify(settled));
      const r1 = { thread_id: first.thread_id as string, reply: settled.result?.reply as string };
      assert.match(r1.reply, /"decision":"allow"/);

      // Follow-up in the same thread: web no longer asks; an edit is refused without asking anyone.
      const r2 = await h.call("ask", { target, message: "AGAIN", thread_id: r1.thread_id });
      const second = await finished(r1.thread_id);
      assert.equal(second.status, "blocked");
      assert.match(r2.reply ?? second.result.reply, /"decision":"deny"/, "the edit was refused");
      if (target === "claude") {
        assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests")[0].c, 1, "no further request was filed");
        // Held for the web tools only: the thread was not given the network, so its shell commands still have none.
        assert.notEqual(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", req.node_id)[0].params_json ?? "{}").grant?.network, true);
        assert.doesNotMatch(h.starts().at(-1)!.prompt, /Granted beyond your sandbox: network/);
      } else {
        assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests WHERE kind = 'file'")[0].c, 0, "the edit request never reached anyone");
      }

      // A read job given the web up front never asks for it.
      const started = await h.call("delegate", { target, task: "WEBJOB", mode: "read", grant: { network: true }, background: false });
      const job = { ...started, ...await finished(started.job_id) };
      assert.equal(job.status, "done", JSON.stringify(job));
      assert.deepEqual(job.grant, { network: true, write_paths: [] });
      const s = h.starts().at(-1)!;
      assert.equal(s.access, "read");
      assert.match(s.prompt, /Granted beyond your sandbox: network and web access/);
      if (target === "claude") {
        assert.ok(s.argv.join(" ").includes("--allowedTools WebSearch WebFetch") || s.argv.join(" ").includes("mcp__relay WebSearch WebFetch"));
        assert.match(job.result.final_message, /"decision":"allow"/);
      } else {
        // Read-only with the network is relay's profile now, for the whole thread: no per-turn sandbox.
        assert.equal(s.sandboxPolicy, null);
        assert.ok(s.argv.join(" ").includes("permissions.relay.network.enabled=true"));
        assert.equal(s.thread.permissions, "relay");
        assert.ok(s.argv.join(" ").includes('web_search="live"'));
      }
    } finally {
      await h.close();
    }
  });
});

test("a write job that changes nothing leaves no worktree or branch behind, and both come back on resume", async () => {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const h = await harness([{ match: "now write", steps: [{ write: "late.txt", content: "x\n" }, { reply: "wrote" }] }]);
  try {
    const branches = () => execFileSync("git", ["branch", "--list", "relay/*"], { cwd: h.repo, encoding: "utf8" }).trim();
    const job = await h.call("delegate", { target: "codex", task: "look only", mode: "write", background: false });
    assert.equal(job.status, "done");
    assert.equal(job.result.no_changes, true);
    assert.equal(job.outcome, "no_changes", "changing nothing is the job's outcome, said up front");
    // Said as what it is, no changes to merge: a file git ignores is not counted, so it is not "no file changed" (review C16).
    assert.match(job.outcome_note, /no changes to merge/);
    assert.doesNotMatch(job.outcome_note, /without changing any file/);
    assert.equal(job.result.branch, null);
    assert.equal(job.branch, undefined, "the removed branch is not advertised");
    assert.equal(branches(), "", "no relay branch is left");
    assert.ok(!fs.existsSync(h.starts()[0].cwd), "no worktree is left");
    const m = await h.call("merge", { job_id: job.job_id });
    assert.equal(m.status, "up_to_date");
    assert.match(m.note, /no changes to merge/);

    await h.call("resume", { job_id: job.job_id, message: "now write" });
    const again = await h.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(again.status, "done");
    assert.equal(again.outcome, undefined, "it has changes now");
    assert.deepEqual(again.result.files_changed_git, ["late.txt"]);
    assert.match(branches(), /relay\/j_/, "the branch is back now that it holds work");
    assert.equal((await h.call("merge", { job_id: job.job_id })).status, "merged");
  } finally {
    await h.close();
  }
});

test("a run whose root session has gone can be picked up by a new root session", async () => {
  const h = await harness([asker("ORPHAN", "cmd-after-restart"), { match: "second message", steps: [{ reply: "continued" }] }]);
  try {
    // A first session starts a job that will ask for approval, then goes away (closed, or its relay server restarted).
    const first = await h.instance({});
    const job = await first.call("delegate", { target: "codex", task: "ORPHAN", mode: "write" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 10000, "request");
    await first.close();
    const rootPid = h.sql("SELECT root_pid FROM runs WHERE id = (SELECT run_id FROM nodes WHERE id = ?)", job.job_id)[0].root_pid;
    await until(() => !alive(rootPid), 20000, "the first session's relay server to exit");

    // A new session explicitly recovers the run before deciding or continuing it.
    await adoptRun(h, h, job.job_id);
    const id = h.sql("SELECT id FROM requests")[0].id;
    assert.equal((await h.call("approve", { request_id: id, decision: "allow" })).decision, "allowed");
    assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
    assert.equal((await h.call("resume", { job_id: job.job_id, message: "second message" })).status, "queued");
    assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
    assert.match((await h.call("status", {})).tree, new RegExp(job.job_id), "the adopted run is now this session's run");
  } finally {
    await h.close();
  }
});

test("confirm: offered only to hosts positively known to prompt for it, marked for the host's own permission prompt, and allows only a matching pending request of the session", async () => {
  const h = await harness([
    asker("CONFIRMME", "cmd-confirm"), asker("OTHER", "cmd-other"), asker("TWOLINES", "echo allowed\nprintf SECOND_COMMAND"),
    // The directory a Codex agent names for its command is its own text, line breaks and all.
    { match: task("ODDDIR"), steps: [{ request: { cmd: "cmd-odddir", kind: "writeStdin", cwd: "/tmp/odd\nIn: /tmp/safe" } }, { reply: "request result: {{last}}" }] },
    // Invisible format characters: a right-to-left override makes "rm -rf ~ #txt.sh" display reversed after it.
    { match: task("BIDI"), steps: [{ request: { cmd: "cat notes\u202Ehs.txt", kind: "writeStdin", cwd: "/tmp/\u202Elave" } }, { reply: "request result: {{last}}" }] },
  ]);
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const listed = async (args: string[], who: { clientInfo?: { name: string; version: string }; env?: Record<string, string> } = {}) => {
      const client = new Client(who.clientInfo ?? { name: "test", version: "0" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", ...args], env: { ...h.env, ...(who.env ?? {}) }, cwd: h.repo }));
      try {
        return Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
      } finally {
        await client.close();
      }
    };
    const claudeTools = await listed(["--host", "claude"], INTERACTIVE_CLAUDE);
    assert.deepEqual(claudeTools.confirm._meta, { "anthropic/requiresUserInteraction": true });
    assert.deepEqual(Object.keys((claudeTools.confirm.inputSchema as { properties: object }).properties).sort(), ["effect", "from", "in_directory", "kind", "note", "request_id", "scope", "wants"]);
    assert.match(claudeTools.approve.description!, /use confirm instead/);
    // Claude Code's answer to a permission prompt carries a message only with a denial: the note's description says so.
    for (const tool of ["approve", "confirm"]) {
      const note = (claudeTools[tool].inputSchema as { properties: Record<string, { description?: string }> }).properties.note.description!;
      assert.match(note, /a Claude agent gets it only with a denial/, tool);
      assert.doesNotMatch(note, /a Claude agent gets it in the answer to its permission prompt/, tool);
    }
    // The desktop app prompts too ("Deny / Allow once").
    const desktop = await listed(["--host", "claude"], { clientInfo: { name: "claude-code", version: "2.1.299" }, env: { CLAUDE_CODE_DESKTOP_APP_VERSION: "1.2", CLAUDE_AGENT_SDK_VERSION: "0.3", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" } });
    assert.ok(desktop.confirm);
    // Hosts not positively known to prompt for a marked tool never get it, whatever family relay was registered for.
    for (const [label, args, who] of [
      ["an unrecognised client registered as Claude", ["--host", "claude"], {}],
      ["claude -p", ["--host", "claude"], { clientInfo: INTERACTIVE_CLAUDE.clientInfo, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ATTENDED: "0" } }],
      ["an older Claude Code", ["--host", "claude"], { clientInfo: { name: "claude-code", version: "2.1.250" }, env: { CLAUDE_CODE_ENTRYPOINT: "cli" } }],
      ["Codex", ["--host", "codex"], { clientInfo: { name: "codex-mcp-client", version: "0.162.1" } }],
      ["a host relay cannot tell", [], {}],
    ] as const) {
      const tools = await listed([...args], who);
      assert.equal(tools.confirm, undefined, label);
      assert.doesNotMatch(tools.approve.description!, /confirm/, label);
    }

    // A Claude Code session whose user closed the question: the agent cannot allow on its own, but confirm can.
    const messages: string[] = [];
    const host = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"], elicit: (m) => (messages.push(m), { action: "cancel" }) });
    const job = await host.call("delegate", { target: "codex", task: "CONFIRMME", mode: "write" });
    const waited = await host.call("status", { id: job.job_id, wait_s: 20 });
    const req = waited.needs_approval[0];
    assert.equal(req.user_dismissed_prompt, true);
    assert.match(waited.approval_note, /call confirm with the request's request_id, from, kind, effect, in_directory and wants exactly as shown/);
    assert.match(waited.approval_note, /or use confirm, which puts it to them in a permission prompt/);
    const as = (r: Record<string, any>) => ({ request_id: r.request_id, from: r.from, wants: r.wants, kind: r.kind, effect: r.effect, in_directory: r.in_directory });
    assert.match((await host.call("confirm", { ...as(req), wants: "something milder" })).reason, /does not match .* wants "cmd-confirm"/);
    // The refusal names what differed.
    assert.match((await host.call("confirm", { ...as(req), wants: "something milder" })).reason, /differs in wants:/);
    assert.match((await host.call("confirm", { ...as(req), from: "j_00000000" })).reason, /differs in from:/);
    assert.match((await host.call("confirm", { ...as(req), kind: "web", effect: "x" })).reason, /differs in kind and effect:/);
    assert.match((await host.call("confirm", { ...as(req), in_directory: "/elsewhere" })).reason, /differs in in_directory:/);
    // Exactly as shown: not padded, and with relay's own kind and effect, so the prompt shows what allowing does.
    assert.match((await host.call("confirm", { ...as(req), wants: ` ${req.wants} ` })).reason, /does not match/);
    assert.ok((await host.call("confirm", { ...as(req), effect: "runs this one command inside its sandbox, with the same limits as its other commands" })).reason.includes(`with effect ${JSON.stringify(req.effect)}`));
    assert.equal(req.effect, "runs this one command outside the sandbox, with your full access");
    assert.match((await host.call("confirm", { ...as(req), kind: "web" })).reason, /does not match .* of kind "command"/);
    assert.equal(h.sql("SELECT status FROM requests")[0].status, "pending");
    const ok = await host.call("confirm", { ...as(req), scope: "job" });
    assert.equal(ok.decision, "allowed");
    assert.equal(ok.decided_by, "user, through the host's permission prompt (confirm)", "the result says the person decided it");
    assert.equal(ok.scope, "rest of the job");
    assert.deepEqual({ ...h.sql("SELECT decided_by, scope FROM requests")[0] }, { decided_by: "user, through the host's permission prompt (confirm)", scope: "job" });
    assert.match((await host.call("confirm", as(req))).error, /already allowed/);
    assert.equal((await host.call("status", { id: job.job_id, wait_s: 20 })).status, "done");

    // Another session's request is not this session's to confirm, even with every detail right.
    const other = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"] });
    const job2 = await other.call("delegate", { target: "codex", task: "OTHER", mode: "write" });
    const w2 = await other.call("status", { id: job2.job_id, wait_s: 20 });
    const r2 = w2.needs_approval[0];
    assert.deepEqual(await host.call("confirm", as(r2)), UNAVAILABLE_REPLY);
    assert.equal((await other.call("confirm", as(r2))).decision, "allowed");

    // A request whose text has a line break: the dialog shows it escaped, with its line count, and
    // confirm allows it only as it is, so a prompt showing one line cannot allow two commands.
    const job4 = await host.call("delegate", { target: "codex", task: "TWOLINES", mode: "write" });
    let w4 = await host.call("status", { id: job4.job_id, wait_s: 20 });
    if (w4.needs_approval[0].user_is_being_asked) w4 = await host.call("status", { id: job4.job_id, wait_s: 20 });
    const r4 = w4.needs_approval[0];
    assert.equal(r4.wants, "echo allowed\nprintf SECOND_COMMAND");
    assert.ok(messages.some((m) => m.split("\n")[1] === "Wants: (2 lines, shown escaped) echo allowed\\nprintf SECOND_COMMAND"), JSON.stringify(messages.at(-1)));
    assert.match((await host.call("confirm", { ...as(r4), wants: "echo allowed printf SECOND_COMMAND" })).reason, /does not match .*line breaks included/);
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", r4.request_id)[0].status, "pending");
    assert.equal((await host.call("confirm", as(r4))).decision, "allowed");

    // The directory too: the dialog shows it escaped, and confirm needs it exactly as shown.
    const job5 = await host.call("delegate", { target: "codex", task: "ODDDIR", mode: "write" });
    let w5 = await host.call("status", { id: job5.job_id, wait_s: 20 });
    if (w5.needs_approval[0].user_is_being_asked) w5 = await host.call("status", { id: job5.job_id, wait_s: 20 });
    const r5 = w5.needs_approval[0];
    assert.equal(r5.in_directory, "/tmp/odd\nIn: /tmp/safe");
    const dialog = messages.find((m) => m.includes("cmd-odddir"))!;
    assert.equal(dialog.split("\n")[2], "In: (2 lines, shown escaped) /tmp/odd\\nIn: /tmp/safe", JSON.stringify(dialog));
    const { in_directory: _dir, ...withoutDir } = as(r5);
    assert.ok((await host.call("confirm", withoutDir)).tool_error, "in_directory is required");
    assert.match((await host.call("confirm", { ...as(r5), in_directory: "/tmp/safe" })).reason, /does not match .* in directory "\/tmp\/odd\\nIn: \/tmp\/safe"/);
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", r5.request_id)[0].status, "pending");
    assert.equal((await host.call("confirm", as(r5))).decision, "allowed");
    assert.equal(shown("plain text"), "plain text");
    assert.equal(shown("a\\b\tc\r\nd\u0007"), "(2 lines, shown escaped) a\\\\b\\tc\\r\\nd\\u0007");

    // Unicode format characters (bidi controls, zero-width characters, category Cf) are shown as visible escapes too,
    // while confirm still compares the raw text.
    const job6 = await host.call("delegate", { target: "codex", task: "BIDI", mode: "write" });
    let w6 = await host.call("status", { id: job6.job_id, wait_s: 20 });
    if (w6.needs_approval[0].user_is_being_asked) w6 = await host.call("status", { id: job6.job_id, wait_s: 20 });
    const r6 = w6.needs_approval[0];
    assert.equal(r6.wants, "cat notes\u202Ehs.txt");
    assert.equal(r6.in_directory, "/tmp/\u202Elave");
    const bidi = messages.find((m) => m.includes("cat notes"))!.split("\n");
    assert.equal(bidi[1], "Wants: (1 line, shown escaped) cat notes\\u{202E}hs.txt", JSON.stringify(bidi));
    assert.equal(bidi[2], "In: (1 line, shown escaped) /tmp/\\u{202E}lave", JSON.stringify(bidi));
    assert.match((await host.call("confirm", { ...as(r6), wants: "cat notes\\u{202E}hs.txt" })).reason, /does not match/);
    assert.match((await host.call("confirm", { ...as(r6), in_directory: "/tmp/lave" })).reason, /does not match/);
    assert.equal((await host.call("confirm", as(r6))).decision, "allowed");
    for (const c of ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069", "\u200E", "\u200F", "\u061C", "\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", "\u00AD", "\u{E0001}"]) {
      const cp = c.codePointAt(0)!.toString(16).toUpperCase();
      assert.equal(shown(`a${c}b`), `(1 line, shown escaped) a\\u{${cp}}b`, cp);
    }
    // Lossless: a backslash is escaped too, so a literal "\u{202E}" in the text cannot pass for one.
    assert.equal(shown("x\\u{202E}\u202E"), "(1 line, shown escaped) x\\\\u{202E}\\u{202E}");

    // An unrecognised host registered as Claude cannot call it: its allow would be the agent's word alone.
    const unknown = await h.instance({ args: ["--host", "claude"] });
    const job3 = await unknown.call("delegate", { target: "codex", task: "OTHER", mode: "write" });
    const w3 = await unknown.call("status", { id: job3.job_id, wait_s: 20 });
    const r3 = w3.needs_approval[0];
    assert.doesNotMatch(w3.approval_note, /confirm/);
    const tried = await unknown.call("confirm", as(r3));
    assert.ok(tried.tool_error, JSON.stringify(tried));
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", r3.request_id)[0].status, "pending");
  } finally {
    await h.close();
  }
});

const CODEX_HOST = { args: ["--host", "codex"], clientInfo: { name: "codex-mcp-client", version: "0.163.0" } };

/**
 * A form as real Codex CLI 0.162.1 shows it: it stays on screen after the request is decided
 * elsewhere, until the person answers it or presses Esc, and it answers a cancellation of the
 * question with "cancel" at once (which is not the person's answer). `answer` is the person's.
 */
function codexForm() {
  const state = { asked: 0, message: undefined as string | undefined, schema: undefined as Record<string, any> | undefined, cancelled: false };
  let answer!: (a: Record<string, unknown>) => void;
  const answered = new Promise<Record<string, unknown>>((resolve) => (answer = resolve));
  const elicit = (m: string, signal: AbortSignal, params: Record<string, any>) => {
    state.asked++;
    state.message = m;
    state.schema = params.requestedSchema;
    return new Promise<Record<string, unknown>>((resolve) => {
      signal.addEventListener("abort", () => {
        state.cancelled = true;
        resolve({ action: "cancel" });
      });
      void answered.then(resolve);
    });
  };
  return { state, elicit, answer };
}
const logged = (h: { home: string }, what: RegExp) => {
  try {
    return what.test(fs.readFileSync(path.join(h.home, "elicitation.log"), "utf8"));
  } catch {
    return false;
  }
};

test("escalation: Codex keeps a withdrawn form open; relay sends it no cancellation, listens on, and reports a late answer that changed nothing", async () => {
  const h = await harness([asker("LATE", { web: "cmd-late" })]);
  try {
    const form = codexForm();
    const host = await h.instance({ ...CODEX_HOST, elicit: form.elicit });
    const job = await host.call("delegate", { target: "claude", task: "LATE", mode: "write" });
    await until(() => form.state.message !== undefined, 15000, "the form");
    // Codex's form could not be submitted with an optional text field left empty: the decision only.
    assert.deepEqual(Object.keys(form.state.schema!.properties), ["decision"]);
    assert.deepEqual(form.state.schema!.required, ["decision"]);
    // Codex preselects the first choice and Enter submits it: the first is the safe one.
    assert.deepEqual(form.state.schema!.properties.decision.enum, ["deny", "allow", "allow for the rest of this job"]);
    // The person is told the form does not go away by itself, and the agent that its decision will not close it.
    assert.match(form.state.message!, /If it is decided elsewhere first .*this form stays open until you answer it or press Esc; an answer then changes nothing/);
    const waiting = await host.call("status", { id: job.job_id, wait_s: 1 });
    assert.equal(waiting.needs_approval[0].user_is_being_asked, true);
    assert.match(waiting.approval_note, /keeps relay's form on the user's screen, and holds your turn, until they answer it or press Esc/);

    const id = h.sql("SELECT id FROM requests")[0].id;
    assert.equal(terminalApprove(h, id).json.decision, "allowed");
    await until(() => logged(h, /"action":"withdrawn"/), 15000, "relay to note the question decided elsewhere");
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "done", 15000, "the job to finish");
    await sleep(1500);
    // Codex would answer a cancellation with "cancel" at once and stop listening: relay sends none.
    assert.equal(form.state.cancelled, false, "no cancellation was sent to a host that keeps the form");
    // The answer to the stale form: recorded and reported, never applied.
    form.answer({ action: "accept", content: { decision: "deny" } });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events WHERE kind = 'late'")[0].c === 1, 15000, "the late answer to be recorded");
    assert.deepEqual({ ...h.sql("SELECT status, decided_by FROM requests")[0] }, { status: "allowed", decided_by: "terminal" });
    const told = await host.call("status", { id: job.job_id });
    const late = (told.events ?? []).find((e: { kind: string }) => e.kind === "late");
    assert.ok(late, JSON.stringify(told.events));
    assert.match(late.notice, new RegExp(`the user answered approval ${id} \\("deny"\\) in relay's approval form after it had already been allowed from a terminal \\(relay approve or relay deny\\)\\. Their answer changed nothing`));
    const log = fs.readFileSync(path.join(h.home, "elicitation.log"), "utf8");
    assert.match(log, /"action":"withdrawn","ms":\d+,"reading":"decided elsewhere first; the host keeps the form open"/);
    assert.match(log, /"action":"late","ms":\d+,"reading":"deny after it was decided elsewhere: changed nothing"/);
    assert.equal(h.sql("SELECT reading FROM elicitations WHERE request_id = ?", id)[0].reading, "withdrawn");
  } finally {
    await h.close();
  }
});

test("escalation: a cancel that follows a cancellation relay sent at once is the host's acknowledgement, not an answer", () => {
  assert.equal(acknowledgesCancel("cancel", 1000, 1001), true);
  assert.equal(acknowledgesCancel("cancel", 1000, 1500), true);
  assert.equal(acknowledgesCancel("cancel", 1000, 1501), false, "later than that, it may be the person's");
  assert.equal(acknowledgesCancel("cancel", undefined, 1001), false, "no cancellation was sent");
  assert.equal(acknowledgesCancel("cancel", 1000, 999), false);
  assert.equal(acknowledgesCancel("decline", 1000, 1001), false);
  assert.equal(acknowledgesCancel("accept", 1000, 1001), false);
});

test("escalation: an answer that arrives after the request was decided elsewhere, before relay withdraws the form, is reported as late, not as the user's decision", async () => {
  const h = await harness([asker("RACE", { web: "cmd-race" })]);
  try {
    let asked = false;
    const host = await h.instance({
      ...CODEX_HOST,
      // The person answers in the moment between a decision from the terminal and relay's next look.
      elicit: async () => {
        asked = true;
        for (;;) {
          if (h.sql("SELECT status FROM requests")[0]?.status !== "pending") return { action: "accept", content: { decision: "deny" } };
          await sleep(5);
        }
      },
    });
    const job = await host.call("delegate", { target: "claude", task: "RACE", mode: "write" });
    await until(() => asked, 15000, "the form");
    const id = h.sql("SELECT id FROM requests")[0].id;
    assert.equal(terminalApprove(h, id).json.decision, "allowed");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events WHERE kind = 'late'")[0].c === 1, 15000, "the late answer to be recorded");
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status === "done", 15000, "the job to finish");
    assert.deepEqual({ ...h.sql("SELECT status, decided_by FROM requests")[0] }, { status: "allowed", decided_by: "terminal" });
    // The elicitation does not claim that the user decided.
    await until(() => h.sql("SELECT reading FROM elicitations WHERE request_id = ?", id)[0].reading !== null, 15000, "the elicitation to end");
    assert.equal(h.sql("SELECT reading FROM elicitations WHERE request_id = ?", id)[0].reading, "withdrawn");
    const late = h.sql("SELECT text FROM events WHERE kind = 'late'")[0].text;
    assert.match(late, new RegExp(`the user answered approval ${id} \\("deny"\\) in relay's approval form after it had already been allowed from a terminal`));
  } finally {
    await h.close();
  }
});

test("escalation: a decline from a host that keeps the form, after the request was decided elsewhere, is reported as the host's answer, not the user's", async () => {
  const h = await harness([asker("HOSTLATE", { web: "cmd-hostlate" })]);
  try {
    const form = codexForm();
    const host = await h.instance({ ...CODEX_HOST, elicit: form.elicit });
    await host.call("delegate", { target: "claude", task: "HOSTLATE", mode: "write" });
    await until(() => form.state.asked > 0, 15000, "the form");
    const id = h.sql("SELECT id FROM requests")[0].id;
    assert.equal(terminalApprove(h, id).json.decision, "allowed");
    await until(() => logged(h, /"action":"withdrawn"/), 15000, "relay to note the question decided elsewhere");
    // Codex declines for many reasons; relay cannot tell this one was the person's.
    form.answer({ action: "decline" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events WHERE kind = 'late'")[0].c === 1, 15000, "the late answer to be recorded");
    const late = h.sql("SELECT text FROM events WHERE kind = 'late'")[0].text;
    assert.doesNotMatch(late, /the user answered/);
    assert.match(late, new RegExp(`approval ${id} was answered \\("decline"\\) by the host .*after it had already been allowed from a terminal`));
    assert.match(late, /cannot tell whether the user gave it/);
  } finally {
    await h.close();
  }
});

test("escalation: a host that keeps the form gets an answer reported even when it comes after approval_timeout_s", async () => {
  const h = await harness([asker("SLOWLATE", { web: "cmd-slowlate" })], { approval_timeout_s: 3 });
  try {
    const form = codexForm();
    const host = await h.instance({ ...CODEX_HOST, elicit: form.elicit });
    await host.call("delegate", { target: "claude", task: "SLOWLATE", mode: "write" });
    await until(() => form.state.asked > 0, 15000, "the form");
    const id = h.sql("SELECT id FROM requests")[0].id;
    assert.equal(terminalApprove(h, id).json.decision, "allowed");
    await until(() => logged(h, /"action":"withdrawn"/), 15000, "relay to note the question decided elsewhere");
    // The form is still on the person's screen; they answer it well after the approval deadline.
    await sleep(4500);
    form.answer({ action: "accept", content: { decision: "deny" } });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events WHERE kind = 'late'")[0].c === 1, 15000, "the late answer to be recorded");
    assert.doesNotMatch(fs.readFileSync(path.join(h.home, "elicitation.log"), "utf8"), /the form ended without an answer/);
    assert.equal(form.state.cancelled, false);
  } finally {
    await h.close();
  }
});

test("escalation: a note given with a decision reaches a Codex agent as a message in its running turn", async () => {
  const h = await harness([asker("NOTED", "cmd-noted"), asker("BARE", "cmd-bare"), asker("TERMNOTE", "cmd-termnote")]);
  try {
    const decideWith = async (name: string, decision: "allow" | "deny", note?: string) => {
      const job = await h.call("delegate", { target: "codex", task: name, mode: "write" });
      const waited = await h.call("status", { id: job.job_id, wait_s: 20 });
      await h.call("approve", { request_id: waited.needs_approval[0].request_id, decision, ...(note ? { note } : {}) });
      // A denied command is a refusal its agent met, so the job ends blocked (1.0's outcomes).
      assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, decision === "deny" ? "blocked" : "done");
    };
    await decideWith("NOTED", "deny", "use the staging host instead");
    await until(() => h.log().some((r) => r.event === "steer"), 15000, "the note to be steered in");
    const steer = h.log().find((r) => r.event === "steer")!;
    assert.equal(steer.expectedTurnId, "turn_1");
    assert.equal(steer.threadId, h.starts()[0].sessionId);
    // Who decided is named: Codex's own message to its agent says "rejected by user" whoever decided.
    assert.deepEqual(steer.input, [{ type: "text", text: "[relay] Your approval request (cmd-noted) was denied by the root session supervising this run, not by the user. The note that came with the decision: use the staging host instead", text_elements: [] }]);
    // Without a note, nothing is added to the turn.
    await decideWith("BARE", "allow");
    assert.equal(h.log().filter((r) => r.event === "steer").length, 1);
    // Decided from a terminal.
    const job3 = await h.call("delegate", { target: "codex", task: "TERMNOTE", mode: "write" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 15000, "the third request");
    const id3 = h.sql("SELECT id FROM requests WHERE status = 'pending'")[0].id;
    assert.equal(JSON.parse(h.cli("deny", id3, "not", "today")).decision, "denied");
    assert.equal((await h.call("status", { id: job3.job_id, wait_s: 20 })).status, "blocked");
    await until(() => h.log().filter((r) => r.event === "steer").length === 2, 15000, "the second note");
    const steer3 = h.log().filter((r) => r.event === "steer")[1];
    assert.equal(steer3.input[0].text, "[relay] Your approval request (cmd-termnote) was denied from a terminal (relay deny). The note that came with the decision: not today");
  } finally {
    await h.close();
  }
});

test("escalation (codex): explicit path additions keep the sandbox and name the access; unknown additions are declined; terminal input adds no authority", async () => {
  // As Codex 0.164.0 sends them, with its experimental API on (exec_permission_approvals): with
  // entries present, the legacy read and write lists are null (app-server-protocol v2
  // permissions.rs, From<CoreFileSystemPermissions>).
  const adds = { network: { enabled: true }, fileSystem: { read: null, write: null, entries: [
    { path: { type: "path", path: "/w/cache" }, access: "write" },
    { path: { type: "path", path: "/w/tmp" }, access: "write" },
  ] } };
  const asking = (name: string, request: Record<string, unknown>): Rule => ({ match: task(name), steps: [{ request }, { reply: "request result: {{last}}" }] });
  const h = await harness([
    asking("ADDS", { cmd: "npm ci", additionalPermissions: adds, availableDecisions: ["accept", "cancel"] }),
    asking("ODD", { cmd: "npm ci", additionalPermissions: { fileSystem: { entries: [{ path: { type: "special", value: { kind: "unknown", path: ":future", subpath: null } }, access: "write" }] } } }),
    asking("STDIN", { cmd: "write_stdin --session-id 1 y", kind: "writeStdin", additionalPermissions: adds }),
  ]);
  try {
    // Network added to one command is asked only of a session whose shell has Codex's network proxy
    // (a network grant): without one, relay declines it itself (codex-network.test.ts).
    const proxied = (name: string) => (name === "ADDS" ? { grant: { network: true } } : {});
    const decide = async (name: string, mode: "read" | "write", scope?: "job") => {
      const job = await h.call("delegate", { target: "codex", task: name, mode, ...proxied(name) });
      const waited = await h.call("status", { id: job.job_id, wait_s: 20 });
      const req = waited.needs_approval[0];
      const approved = await h.call("approve", { request_id: req.request_id, decision: "allow", ...(scope ? { scope } : {}) });
      assert.equal(approved.decision, "allowed", JSON.stringify({ approved, waited }));
      assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
      return { req, note: waited.approval_note as string };
    };
    const inside = "runs this one command inside its sandbox, with the same limits as its other commands except for the access its request asks to add (in wants), for this command alone";
    const added = await decide("ADDS", "write");
    assert.equal(added.req.wants, 'npm ci (asks to add for this command: write access to "/w/cache", "/w/tmp"; network access)');
    assert.equal(added.req.effect, inside);
    assert.equal(added.req.once_only, "allowed for this one command only, never for the rest of the job");
    assert.match(added.note, /^A launched agent is waiting for approval: allowing it runs this one command inside its sandbox/);
    assert.match(h.cli("approvals"), /no approval requests waiting/);
    // A read-only turn: the same, its sandbox read-only but for what it names.
    assert.equal((await decide("ADDS", "read")).req.effect, inside);
    // Never for the rest of the job (codex-app.ts commandAsk): refused, saying so, with nothing
    // decided, and the request still waits to be allowed once or denied.
    {
      const job = await h.call("delegate", { target: "codex", task: "ADDS", mode: "write", grant: { network: true } });
      const req = (await h.call("status", { id: job.job_id, wait_s: 20 })).needs_approval[0];
      const forJob = await h.call("approve", { request_id: req.request_id, decision: "allow", scope: "job" });
      assert.match(JSON.stringify(forJob), /can be allowed for this one command only: a Codex command asking for access added to its sandbox is never allowed for the rest of the job\. Nothing was decided; allow it once or deny it\./);
      assert.equal((await h.call("status", { id: job.job_id })).needs_approval[0].request_id, req.request_id);
      assert.equal((await h.call("approve", { request_id: req.request_id, decision: "allow" })).decision, "allowed");
      assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
    }
    // Unknown additions cannot prove preservation of PC's runtime roots: nobody is asked.
    const odd = await h.call("delegate", { target: "codex", task: "ODD", mode: "write", background: false });
    assert.equal(odd.status, "blocked", JSON.stringify(odd));
    assert.equal(h.sql("SELECT id FROM requests WHERE node_id = ?", odd.job_id).length, 0);
    assert.ok((odd.blocked as string[]).some((b) => /pin-store write protection/.test(b)), JSON.stringify(odd));
    // Input for a terminal already running carries the permissions it kept: left as it was.
    const stdin = await decide("STDIN", "write");
    assert.equal(stdin.req.wants, "write_stdin --session-id 1 y");
    assert.equal(stdin.req.effect, "runs this one command outside the sandbox, with your full access");
    assert.equal(stdin.req.once_only, undefined);
    assert.deepEqual(h.log().filter((r) => r.event === "approval-answer").map((r) => r.decision), ["accept", "accept", "accept", "decline", "accept"]);
  } finally {
    await h.close();
  }
});
