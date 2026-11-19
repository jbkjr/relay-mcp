// Regression tests for the findings of the pre-release review (ids as in docs/design-history.md §21).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HARNESS_CONFIG } from "../dist/confine/seatbelt.js";
import { relayPackageRoot } from "../dist/core/protected-config.js";
import { test } from "node:test";
import { CLI, INTERACTIVE_CLAUDE, type Rule, UNAVAILABLE_REPLY, alive, authorizeRun, claudeFloor, claudeReadDeny, forEachTarget, harness, killGroup, lookSteps, looked, passed, reached, release, sleep, task, until } from "./helpers.ts";

const asker = (name: string, request: unknown): Rule => ({ match: task(name), steps: [{ request }, { reply: "request result: {{last}}" }] });
const settingsOf = (start: { argv: string[] }) => JSON.parse(fs.readFileSync(start.argv[start.argv.indexOf("--settings") + 1], "utf8"));

test("X1: a read-only turn cannot cause writes through another agent", async () => {
  const h = await harness([
    { match: task("READER"), steps: [
      { call: "delegate", args: { target: "codex", task: "WRITER", mode: "write", background: false }, as: "w" },
      { call: "delegate", args: { target: "codex", task: "LOOKER", mode: "read", background: false }, as: "r" },
      { reply: "write: {{w}} read: {{r.status}}" },
    ] },
    { match: task("WRITER"), steps: [{ write: "child.txt", content: "should never exist\n" }, { reply: "wrote" }] },
  ]);
  try {
    const r = await h.call("delegate", { target: "claude", task: "READER", mode: "read", background: false });
    assert.equal(r.status, "done");
    const calls = h.ends().find((e) => e.calls.length === 2)!.calls;
    assert.equal(calls[0].result.refused, true);
    assert.match(calls[0].result.reason, /your current turn is read-only/);
    assert.equal(calls[1].result.status, "done", "it can still start read-only work");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes WHERE mode = 'write'")[0].c, 0);
    assert.equal(execFileSync("git", ["branch", "--list", "relay/*"], { cwd: h.repo, encoding: "utf8" }).trim(), "");
  } finally {
    await h.close();
  }
});

test("X1: a launched agent can steer only what it started, and nothing with more access than its own turn", async () => {
  const h = await harness([
    { match: task("PARENT"), steps: [{ call: "delegate", args: { target: "codex", task: "CHILD", mode: "write", background: false } }, { reply: "{{last}}" }] },
    { match: task("SIBLING"), steps: [{ call: "delegate", args: { target: "codex", task: "NEPHEW", mode: "write", background: false } }, { reply: "{{last}}" }] },
  ]);
  try {
    const parent = await h.call("delegate", { target: "claude", task: "PARENT", mode: "write", background: false });
    // In the parent's run (the same target, so the same session), and the job it started: of the
    // other family from the parent, so that only the rule under test can refuse.
    const sibling = await h.call("delegate", { target: "claude", task: "SIBLING", mode: "write", background: false });
    const nephew = h.sql("SELECT id FROM nodes WHERE parent_id = ?", sibling.job_id)[0].id;
    const child = h.sql("SELECT id FROM nodes WHERE parent_id = ?", parent.job_id)[0].id;
    const runId = h.sql("SELECT run_id FROM nodes WHERE id = ?", parent.job_id)[0].run_id;

    const asParent = await h.instance(await h.childOf(parent.job_id, { access: "write" }));
    for (const [tool, args] of [
      ["resume", { job_id: sibling.job_id, message: "do my bidding" }],
      ["cancel", { id: sibling.job_id }],
      ["merge", { job_id: sibling.job_id }],
      ["discuss", { topic: "t", message: "m", with: nephew }],
      ["resume", { job_id: nephew, message: "do my bidding" }],
    ] as const) {
      assert.match((await asParent.call(tool, args)).reason, /only work that you started/, `${tool} on a sibling or its job`);
    }
    assert.match((await asParent.call("cancel", { id: runId })).reason, /only the root session or the user can cancel a whole run/);
    assert.equal((await asParent.call("resume", { job_id: child, message: "more" })).status, "queued", "its own child is fine");
    await h.call("status", { id: child, wait_s: 20 });

    // The root gives the child network access. The parent, which has none, can no longer drive it.
    await h.call("resume", { job_id: child, message: "with web", grant: { network: true } });
    await h.call("status", { id: child, wait_s: 20 });
    assert.match((await asParent.call("resume", { job_id: child, message: "fetch something for me" })).reason, /more access than your current turn/);

    // The same parent in a read-only turn (a discussion, say) cannot drive its write child or merge.
    const asReader = await h.instance(await h.childOf(parent.job_id, { access: "read" }));
    assert.match((await asReader.call("merge", { job_id: child })).reason, /your current turn is read-only/);
    assert.match((await asReader.call("delegate", { target: "codex", task: "x", mode: "write" })).reason, /read-only/);
  } finally {
    await h.close();
  }
});

test("X2, X3: Codex is not started unless its other MCP servers can be switched off and its effective configuration is what relay set", async () => {
  const h = await harness();
  try {
    const cases: [Record<string, string>, RegExp][] = [
      [{ STUB_CODEX_MCP_LIST: "this is not JSON" }, /could not list Codex's MCP servers \(its output was not JSON\)/],
      [{ STUB_CODEX_MCP_LIST: '[{"enabled":true}]' }, /not a list of named servers/],
      // The sandbox is relay's permission profile: selected, exactly as relay set it, allowed by any
      // administrator's requirements, and the one the thread reports it runs with.
      [{ STUB_CODEX_EFFECTIVE: JSON.stringify({ default_permissions: ":workspace" }) }, /default_permissions is ":workspace" where relay set "relay"/],
      [{ STUB_CODEX_EFFECTIVE: JSON.stringify({ permissions: { relay: { extends: ":danger-full-access" } } }) }, /the permission profile "relay" is \{"extends":":danger-full-access"\}/],
      [{ STUB_CODEX_REQUIREMENTS: JSON.stringify({ allowedPermissionProfiles: { ":workspace": true, ":read-only": true } }) }, /allow only the permission profiles ":workspace", ":read-only", not relay's "relay"/],
      [{ STUB_CODEX_THREAD: JSON.stringify({ activePermissionProfile: { id: ":workspace", extends: null } }) }, /its thread runs with the permission profile ":workspace", not relay's "relay"/],
      [{ STUB_CODEX_THREAD: JSON.stringify({ sandbox: { type: "workspaceWrite", networkAccess: true, excludeSlashTmp: true, excludeTmpdirEnvVar: false } }) }, /its thread reports network access true where relay set false/],
      [{ STUB_CODEX_EFFECTIVE: JSON.stringify({ mcp_servers: { email: { enabled: true }, relay: { enabled: false } } }) }, /other MCP servers are still enabled \(email\)/],
    ];
    for (const [env, expected] of cases) {
      const root = await h.instance({ env });
      const r = await root.call("delegate", { target: "codex", task: "anything", mode: "write", allow_delegation: false, background: false });
      assert.equal(r.status, "failed", JSON.stringify(env));
      assert.match(r.error, expected);
      await root.close();
    }
    assert.equal(h.starts().length, 0, "no agent turn was ever started");

    // Listed servers are switched off, sandbox keys are always explicit, and a normal launch passes the check.
    const listed = await h.instance({ env: { STUB_CODEX_MCP_LIST: JSON.stringify([{ name: "email", enabled: true }, { name: "old", enabled: false }]) } });
    assert.equal((await listed.call("delegate", { target: "codex", task: "ok", mode: "write", background: false })).status, "done");
    const flags = h.starts()[0].argv.join(" ");
    assert.ok(flags.includes("mcp_servers.email.enabled=false"));
    assert.ok(!flags.includes("mcp_servers.old.enabled"));
    assert.ok(flags.includes('default_permissions="relay"'));
    assert.ok(flags.includes("permissions.relay.network.enabled=false"));
    assert.match(flags, /permissions\.relay\.filesystem=\{":root"="read",":tmpdir"="write",":workspace_roots"=\{"\."="write",.*"\.claude"="read"/);
    assert.doesNotMatch(flags, /sandbox_mode|sandbox_workspace_write|permissions\.relay\.workspace_roots/);
  } finally {
    await h.close();
  }
  // The `codex exec` fallback runs the same check first and fails closed.
  const ex = await harness([], { codex_backend: "exec" });
  try {
    const bad = await ex.instance({ env: { STUB_CODEX_EFFECTIVE: JSON.stringify({ permissions: { workspace: {} } }) } });
    const r = await bad.call("delegate", { target: "codex", task: "x", mode: "read", background: false });
    assert.equal(r.status, "failed");
    assert.match(r.error, /the permission profile "relay" is null/);
    // exec has no thread to read the active profile from before it runs: an administrator's requirements are read instead.
    const required = await ex.instance({ env: { STUB_CODEX_REQUIREMENTS: JSON.stringify({ allowedPermissionProfiles: { ":workspace": true, ":read-only": true } }) } });
    const r2 = await required.call("delegate", { target: "codex", task: "x", mode: "read", background: false });
    assert.equal(r2.status, "failed");
    assert.match(r2.error, /allow only the permission profiles ":workspace", ":read-only", not relay's "relay"/);
    const ok = await ex.call("delegate", { target: "codex", task: "y", mode: "read", background: false });
    assert.equal(ok.status, "done");
    assert.equal(ex.starts()[0].via, undefined, "the turn itself ran through codex exec");
  } finally {
    await ex.close();
  }
});

test("X4: an approval that loses the race to a denial grants nothing", async () => {
  const h = await harness([{ match: "RACE", steps: [{ request: { web: "example" } }, { reply: "{{last}}" }] }]);
  let lock: DatabaseSync | null = null;
  try {
    const pending = h.call("ask", { target: "claude", message: "RACE" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'")[0].c === 1, 10000, "request");
    const r = h.sql("SELECT * FROM requests")[0];
    // A denial is committed while an `approve --job` is already on its way in.
    lock = new DatabaseSync(path.join(h.home, "relay.db"));
    // Waits out a write a relay process may be making at this moment, as relay's own connections do.
    lock.exec("PRAGMA busy_timeout = 10000");
    lock.exec("BEGIN IMMEDIATE");
    lock.prepare("UPDATE requests SET status = 'denied', decided_by = 'someone else' WHERE id = ?").run(r.id);
    // `relay approve` now requires a person at a terminal who types back the one-time code it prints
    // (the structural boundary, docs/approve-boundary.md): drive it over a PTY, read the code off the
    // prompt, type it back. relay's atomic decide then loses the race to the committed denial.
    const driver = `import os, pty, re, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
buf = b""
sent = False
try:
    while True:
        if not select.select([fd], [], [], 0.2)[0]:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        buf += chunk
        if not sent:
            m = re.search(rb"type the code ([A-Z0-9]+)", buf)
            if m:
                os.write(fd, m.group(1) + b"\\n")
                sent = True
finally:
    os.close(fd)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
    const child = spawn("python3", ["-c", driver, process.execPath, CLI, "approve", r.id, "--job"], { env: h.env, cwd: h.repo, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    const exited = new Promise((resolve) => child.on("close", resolve));
    // relay's own node process is the PTY child of this python driver; watch it, not the driver.
    const nodePid = () => Number(spawnSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).stdout.trim().split("\n")[0]) || null;
    // It is on its way in once relay's process is waiting for the lock: the registry open and
    // asleep in SQLite's busy wait, twice running.
    const file = path.join(h.home, "relay.db");
    const waiting = () => {
      const pid = nodePid();
      return Boolean(pid)
        && spawnSync("lsof", ["-a", "-w", "-p", String(pid), "-Fn"], { encoding: "utf8" }).stdout.split("\n").includes(`n${file}`)
        && spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().startsWith("S");
    };
    let asleep = 0;
    await until(() => (waiting() ? ++asleep : (asleep = 0)) >= 2, 20000, "the approval to wait for the lock");
    lock.exec("COMMIT");
    lock.close();
    lock = null;
    await exited;
    // Either relay's atomic decide reports it already denied, or its pre-commit re-read sees the
    // decision land first; neither allows anything.
    const result = JSON.parse(out.match(/\{[\s\S]*\}\s*$/)![0]);
    assert.notEqual(result.decision, "allowed", out);
    assert.match(JSON.stringify(result), /denied/, out);
    const handle = await pending;
    await h.call("status", { id: handle.thread_id ?? handle.id, wait_s: 20 });
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", r.id)[0].status, "denied");
    assert.ok(!JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", r.node_id)[0].params_json).grant?.network, "no network grant was applied");
  } finally {
    if (lock) {
      try { lock.exec("ROLLBACK"); } catch {}
      lock.close();
    }
    await h.close();
  }
});

test("X5: work that could not be committed is never removed, by merge or by clean", async () => {
  const h = await harness([
    { match: task("WRITE"), steps: [{ write: "precious.txt", content: "irreplaceable\n" }, { reply: "done" }] },
    { match: task("INTERRUPTED"), steps: [{ write: "half.txt", content: "half done\n", mark: "half" }, { sleep: 60000 }, { reply: "never" }] },
  ]);
  try {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: h.repo, encoding: "utf8" });
    // Nothing new can be stored while the object directory is read-only, so relay's commit fails.
    const objects = path.join(h.repo, ".git", "objects");
    fs.chmodSync(objects, 0o555);
    const job = await h.call("delegate", { target: "codex", task: "WRITE", mode: "write", background: false });
    assert.match(job.result.checkpoint_error, /could not (stage|commit)/);
    const wt = h.starts()[0].cwd;
    // No result showed the work, so merge does not take it unasked; asked, it cannot commit it either.
    const m = await h.call("merge", { job_id: job.job_id });
    assert.equal(m.refused, true, JSON.stringify(m));
    assert.match(m.reason, /nothing was merged, because relay could not commit/);
    const asked = await h.call("merge", { job_id: job.job_id, include_changes_since_result: true });
    assert.equal(asked.status, "error");
    assert.match(asked.error, /nothing was merged/);
    assert.ok(fs.existsSync(path.join(wt, "precious.txt")), "the uncommitted file is still in its worktree");
    const cleaned = JSON.parse(h.cli("clean"));
    assert.equal(cleaned.worktrees_removed, 0);
    assert.match(cleaned.worktrees_kept[0], /uncommitted changes/);
    assert.ok(fs.existsSync(path.join(wt, "precious.txt")));

    // Once committing works again, merge with include_changes_since_result commits the job's work first and brings it over.
    fs.chmodSync(objects, 0o755);
    assert.equal((await h.call("merge", { job_id: job.job_id })).refused, true, "still not without the say-so: no result has shown the work");
    const ok = await h.call("merge", { job_id: job.job_id, include_changes_since_result: true });
    assert.equal(ok.status, "merged");
    assert.equal(fs.readFileSync(path.join(h.repo, "precious.txt"), "utf8"), "irreplaceable\n");
    assert.equal(ok.worktree_removed, true);

    // A job cancelled mid-turn never gets its closing commit. clean saves the work to its branch before removing the tree.
    const cut = await h.call("delegate", { target: "claude", task: "INTERRUPTED", mode: "write" });
    await until(() => h.marked("half"), 60000, "the second job to write half its work");
    await h.call("cancel", { id: cut.job_id });
    const after = JSON.parse(h.cli("clean"));
    assert.equal(after.worktrees_removed, 1);
    assert.match(after.unmerged_branches_kept.join(" "), new RegExp(cut.branch));
    assert.equal(g("show", `${cut.branch}:half.txt`), "half done\n");
  } finally {
    await h.close();
  }
});

test("X6: when a worker dies, the agent it was supervising is stopped rather than abandoned", async () => {
  const h = await harness([{ match: task("HANG"), steps: [{ sleep: 60000 }, { reply: "never" }] }]);
  try {
    const j = await h.call("delegate", { target: "claude", task: "HANG", mode: "read" });
    await until(() => h.sql("SELECT agent_pgid FROM nodes WHERE id = ?", j.job_id)[0].agent_pgid > 0, 10000, "agent");
    const row = h.sql("SELECT worker_pid, agent_pgid, agent_start FROM nodes WHERE id = ?", j.job_id)[0];
    assert.ok(row.agent_start, "the agent's start time is recorded next to its pid");
    process.kill(row.worker_pid, "SIGKILL");
    await until(() => !alive(row.worker_pid), 30000, "the worker to be gone");
    assert.equal((await h.call("status", { id: j.job_id })).status, "lost");
    await until(() => !alive(row.agent_pgid), 30000, "the orphaned agent to be killed");
    assert.equal(h.sql("SELECT agent_pgid FROM nodes WHERE id = ?", j.job_id)[0].agent_pgid, null);
  } finally {
    await h.close();
  }
});

test("X8: a nested job survives the cleanup of the parent worktree it was started from", async () => {
  const h = await harness([
    { match: task("OUTER"), steps: [
      { call: "delegate", args: { target: "codex", task: "INNER", mode: "write", background: false }, as: "inner" },
      { call: "merge", args: { job_id: "{{inner.job_id}}" } },
      { reply: "merged inner" },
    ] },
    { match: task("INNER"), steps: [{ write: "inner.txt", content: "inner\n" }, { reply: "done" }] },
    { match: "one more look", steps: [{ write: "again.txt", content: "again\n" }, { reply: "looked" }] },
  ]);
  try {
    const outer = await h.call("delegate", { target: "claude", task: "OUTER", mode: "write", background: false });
    const inner = h.sql("SELECT id, repo, worktree FROM nodes WHERE parent_id = ?", outer.job_id)[0];
    assert.equal(fs.realpathSync(inner.repo), fs.realpathSync(h.repo), "the nested job is managed from the main repository, not from its parent's worktree");
    assert.equal((await h.call("merge", { job_id: outer.job_id })).status, "merged");
    assert.equal(fs.readFileSync(path.join(h.repo, "inner.txt"), "utf8"), "inner\n");
    assert.ok(!fs.existsSync(h.starts()[0].cwd), "the parent's worktree is gone");

    await h.call("resume", { job_id: inner.id, message: "one more look" });
    const st = await h.call("status", { id: inner.id, wait_s: 20 });
    assert.equal(st.status, "done");
    assert.deepEqual(st.result.files_changed_git.sort(), ["again.txt", "inner.txt"]);
    const cleaned = JSON.parse(h.cli("clean"));
    assert.equal(cleaned.worktrees_removed, 1);
    assert.deepEqual(cleaned.worktrees_kept, []);
  } finally {
    await h.close();
  }
});

test("X9: an approval request says where a command would run and which files a change would touch", async () => {
  const h = await harness([
    asker("CMD", "make deploy"),
    asker("PATCH", { edit: "/etc/hosts" }),
    asker("BLIND", { edit: "/etc/hosts", anonymous: true }),
  ]);
  try {
    // Codex: a Claude command request is refused under the never floor before it is filed (core/approvals.ts).
    const one = await h.call("delegate", { target: "codex", task: "CMD", mode: "write" });
    const w1 = await h.call("status", { id: one.job_id, wait_s: 20 });
    assert.equal(w1.needs_approval[0].in_directory, h.starts()[0].cwd);
    assert.equal(w1.needs_approval[0].session, "write");
    await h.call("approve", { request_id: w1.needs_approval[0].request_id, decision: "deny" });

    const two = await h.call("delegate", { target: "codex", task: "PATCH", mode: "write" });
    const w2 = await h.call("status", { id: two.job_id, wait_s: 20 });
    assert.equal(w2.needs_approval[0].wants, "change files: /etc/hosts");
    assert.equal(w2.needs_approval[0].effect, "changes these files outside its sandbox: outside its worktree and granted directories, or, at their top, configuration your agents or tools load (.claude/, .mcp.json and the like) or git metadata (an existing .git)");
    await h.call("approve", { request_id: w2.needs_approval[0].request_id, decision: "deny" });

    // A file change whose paths cannot be recovered is refused without asking anyone to decide blind.
    const three = await h.call("delegate", { target: "codex", task: "BLIND", mode: "write", background: false });
    assert.match(three.result.final_message, /"decision":"deny"/);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests")[0].c, 2);
  } finally {
    await h.close();
  }
});

test("X10: cancel, then resume, redirects a job at once", async () => {
  const h = await harness([
    { match: task("WRONG"), turn: 1, steps: [{ sleep: 60000 }, { reply: "never" }] },
    { match: "do this instead", steps: [{ reply: "redirected" }] },
  ]);
  try {
    const j = await h.call("delegate", { target: "codex", task: "WRONG", mode: "read" });
    await until(() => h.starts().length === 1, 10000, "first turn");
    await h.call("cancel", { id: j.job_id });
    const r = await h.call("resume", { job_id: j.job_id, message: "do this instead" });
    assert.equal(r.status, "queued");
    const st = await h.call("status", { id: j.job_id, wait_s: 20 });
    assert.equal(st.status, "done");
    assert.equal(st.result.final_message, "redirected");
    assert.equal(h.starts()[1].resumed, true);
    assert.equal(h.starts()[1].sessionId, h.starts()[0].sessionId, "the redirect continues the job's own session");

    // Under a cancelled run, there is nothing to revive.
    const k = await h.call("delegate", { target: "codex", task: "WRONG", mode: "read" });
    await until(() => h.starts().length === 3, 10000, "third start");
    await h.call("cancel", { id: h.sql("SELECT run_id FROM nodes WHERE id = ?", k.job_id)[0].run_id });
    const other = await h.instance({});
    assert.deepEqual(await other.call("resume", { job_id: k.job_id, message: "x" }), UNAVAILABLE_REPLY);
  } finally {
    await h.close();
  }
});

test("C1: a decline counts where the host shows a dialog with a decline button, and a cancel never decides; ask_user says which hosts are asked", async () => {
  const run = async (askUser: string, answer: Record<string, unknown>, host: { clientInfo?: { name: string; version: string }; env?: Record<string, string> } = INTERACTIVE_CLAUDE) => {
    const h = await harness([asker("Q", "cmd")], { ask_user: askUser });
    try {
      let asked = 0;
      const session = await h.instance({ ...host, elicit: () => { asked++; return answer; } });
      const job = await session.call("delegate", { target: "codex", task: "Q", mode: "write" });
      const st = await session.call("status", { id: job.job_id, wait_s: 20 });
      const row = h.sql("SELECT status, decided_by FROM requests")[0];
      const log = fs.existsSync(path.join(h.home, "elicitation.log")) ? fs.readFileSync(path.join(h.home, "elicitation.log"), "utf8") : "";
      if (st.needs_approval) await session.call("approve", { request_id: st.needs_approval[0].request_id, decision: "deny" });
      return { asked, st, row: { ...row }, log };
    } finally {
      await h.close();
    }
  };
  // Declined in Claude Code's dialog, however fast: the user's refusal, never handed to the agent.
  const declined = await run("auto", { action: "decline" });
  assert.deepEqual(declined.row, { status: "denied", decided_by: "user" });
  assert.equal(declined.st.needs_approval, undefined);
  assert.match(declined.log, /"action":"decline".*"reading":"denied by the user"/);
  // Codex declines on its own when its approval policy is "never", so its decline decides nothing.
  const codex = await run("auto", { action: "decline" }, { clientInfo: { name: "codex-mcp-client", version: "0.163.0" } });
  assert.equal(codex.asked, 1);
  assert.equal(codex.row.status, "pending");
  // What it answered is reported as the host's, not as the user closing it: relay cannot tell that anyone saw it.
  assert.equal(codex.st.needs_approval[0].user_dismissed_prompt, undefined);
  assert.equal(codex.st.needs_approval[0].host_answered_prompt, "decline");
  assert.match(codex.st.approval_note, /host_answered_prompt .*cannot attribute to them/);
  assert.match(codex.log, /"action":"decline","ms":\d+,"reading":"unattributed: left undecided"/);
  // A cancel, however fast, is a closed question: undecided, and the agent may not allow it alone.
  const cancelled = await run("auto", { action: "cancel" });
  assert.equal(cancelled.row.status, "pending");
  assert.equal(cancelled.st.needs_approval[0].user_dismissed_prompt, true);
  assert.match(cancelled.log, /"action":"cancel","ms":\d+,"reading":"dismissed: left undecided"/);
  // Under "never", the host is not asked at all.
  const never = await run("never", { action: "accept", content: { decision: "allow" } });
  assert.equal(never.asked, 0);
  assert.equal(never.st.needs_approval.length, 1);
  assert.match(never.log, /"action":"not asked","reading":"ask_user is \\"never\\""/);
  // A host that cannot elicit at all is recorded as such.
  const h = await harness([asker("Q", "cmd")]);
  try {
    const session = await h.instance(INTERACTIVE_CLAUDE);
    const job = await session.call("delegate", { target: "codex", task: "Q", mode: "write" });
    const st = await session.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(st.needs_approval.length, 1);
    assert.match(fs.readFileSync(path.join(h.home, "elicitation.log"), "utf8"), /"action":"not asked","reading":"host lacks elicitation"/);
  } finally {
    await h.close();
  }
});

test("C2: taking over a run is atomic, respects a live owner, and does not need a project directory", async () => {
  const h = await harness([{ match: "again", steps: [{ reply: "continued" }] }]);
  try {
    const first = await h.instance({});
    const j1 = await first.call("delegate", { target: "claude", task: "one", mode: "read", background: false });
    const second = await h.instance({});
    const j2 = await second.call("delegate", { target: "codex", task: "two", mode: "read", background: false });
    // While its session is open, a run belongs to that session.
    assert.deepEqual(await h.call("resume", { job_id: j1.job_id, message: "again" }), UNAVAILABLE_REPLY);
    const pids = h.sql("SELECT root_pid FROM runs WHERE id IN (SELECT run_id FROM nodes WHERE id IN (?, ?))", j1.job_id, j2.job_id).map((r) => r.root_pid);
    await first.close();
    await second.close();
    await until(() => pids.every((p) => !alive(p)), 20000, "both sessions to exit");


    // Two new sessions reach for the same orphaned run at once: exactly one gets it.
    const a = await h.instance({ cwd: "/" });
    const b = await h.instance({ cwd: "/" });
    const permits = await Promise.all([a, b].map((s) => authorizeRun(h, s, j1.job_id)));
    const results = await Promise.all([a, b].map((s, i) => s.call("adopt", { run_id: permits[i].run, into_session: permits[i].to })));
    assert.equal(results.filter((r) => r.adopted).length, 1, JSON.stringify(results));
    assert.match(results.find((r) => r.refused)!.reason, /still open|ownership changed/);
    // Deterministically cover a loser that first reads the owner after the winner committed.
    const loserIndex = results[0].adopted ? 1 : 0;
    const late = await [a, b][loserIndex].call("adopt", { run_id: permits[loserIndex].run, into_session: permits[loserIndex].to });
    assert.match(late.reason, /still open/, "a stale ticket cannot hide the live winner behind a confirmation refusal");
    const winner = results[0].adopted ? a : b;
    assert.equal((await winner.call("resume", { job_id: j1.job_id, message: "again" })).status, "queued");
    // The winner was started outside any project directory and did not need to name one.
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", j1.job_id)[0].status === "done", 15000, "the resumed job");
    assert.equal(h.starts().at(-1)!.cwd, h.repo, "the resumed job ran where it always ran");
  } finally {
    await h.close();
  }
});

test("C3: relay's control directory is out of every job's reach", async () => {
  const strict = await harness([], { allow_temp_home: false });
  try {
    const r = await strict.call("delegate", { target: "claude", task: "x", mode: "read" });
    assert.equal(r.refused, true);
    assert.match(r.reason, /control directory .* is inside a temporary directory/);
  } finally {
    await strict.close();
  }
  const h = await harness();
  try {
    const job = await h.call("delegate", { target: "claude", task: "x", mode: "write", background: false });
    const s = h.starts()[0];
    assert.ok(!s.cwd.startsWith(h.home + path.sep), "worktrees live outside the control directory");
    // Config and install files are protected too (DM8), and relay's MCP definitions (extensions),
    // beside the control directory, the worktree's `.git`, relay's identity directory and the harness
    // configuration at the worktree's top (HARNESS_CONFIG); so are relay's local config, which is
    // always in ~/.config/relay, and the directories that decide which API key relay hands a
    // key-only target (core/api-keys.ts keyAuthority), and what relay runs outside any sandbox: its
    // own package and the Node it runs on (review r_0c11d860 X1). The no-change worktree is gone by now.
    const wt = s.cwd;
    const local = path.join(h.env.HOME, ".config", "relay");
    // What relay runs outside any sandbox and its PATH come between them (relayWriteProtected): the
    // relay process's own config and PATH decide that list, so it is checked by its parts here.
    const denyWrite: string[] = settingsOf(s).sandbox.filesystem.denyWrite;
    const expected = [h.home, path.join(h.env.HOME, ".relay-t"), ...["config.json", "mcp.json", "install.json", "install-backups"].map((p) => path.join(h.home, p)), path.join(local, "local.json"), local, path.join(h.env.HOME, ".config", "relay-keys"), path.join(wt, ".git"), path.join(wt, ".relay"), ...HARNESS_CONFIG.map((n) => path.join(wt, n))];
    assert.deepEqual(denyWrite.filter((p) => expected.includes(p)), expected);
    for (const p of [relayPackageRoot(), fs.realpathSync(process.execPath), ...(process.env.PATH ?? "").split(":").filter((d) => d.startsWith("/")).map((d) => path.resolve(d))]) assert.ok(denyWrite.includes(p), `denyWrite holds ${p}`);
    assert.ok(denyWrite.every((p) => expected.includes(p) || !p.startsWith(wt + path.sep)), "nothing else in the worktree");
    // The edit tools follow permission rules, not the sandbox: the same paths in the worktree are denied to them.
    // Then the never floor's rules, which every Claude turn gets (claudeFloor).
    const floor = claudeFloor(h);
    assert.deepEqual(settingsOf(s).permissions.deny, [...[path.join(h.env.HOME, ".relay-t"), ...[".git", ".relay", ...HARNESS_CONFIG].map((p) => path.join(wt, p))].flatMap((p) => [`Edit(/${p})`, `Edit(/${p}/**)`]), ...claudeReadDeny(h.env.HOME).rules, ...floor.rules]);
    // Nor may it read the API key relay hands a key-only target (core/api-keys.ts keyPathsToDeny), nor anything the floor denies.
    assert.deepEqual(settingsOf(s).sandbox.filesystem.denyRead, [...new Set([...claudeReadDeny(h.env.HOME).paths, ...floor.read])]);
    assert.equal(job.status, "done");
    await h.call("ask", { target: "claude", message: "y" });
    assert.ok(settingsOf(h.starts()[1]).sandbox.filesystem.denyWrite.includes(h.home), "read turns too");
  } finally {
    await h.close();
  }
});

test("C5: child_web = ask puts the host's web tools behind a grant or an approval", async () => {
  const h = await harness([], { child_web: "ask" });
  try {
    await h.call("delegate", { target: "claude", task: "a", mode: "write", background: false });
    await h.call("delegate", { target: "codex", task: "b", mode: "read", background: false });
    await h.call("delegate", { target: "claude", task: "c", mode: "read", grant: { network: true }, background: false });
    await h.call("delegate", { target: "codex", task: "d", mode: "read", grant: { network: true }, background: false });
    const [a, b, c, d] = h.starts();
    assert.deepEqual(settingsOf(a).permissions.ask, ["Bash", "WebSearch", "WebFetch"]);
    assert.ok(b.argv.join(" ").includes('web_search="disabled"'));
    assert.deepEqual(settingsOf(c).permissions.ask, ["Bash"], "with the network granted, web tools are not held back");
    assert.ok(d.argv.join(" ").includes('web_search="live"'));
  } finally {
    await h.close();
  }
  const inherit = await harness();
  try {
    await inherit.call("delegate", { target: "codex", task: "b", mode: "read", background: false });
    assert.ok(!inherit.starts()[0].argv.join(" ").includes("web_search"), "by default the user's own setting applies");
  } finally {
    await inherit.close();
  }
});

test("verification: a turn whose worker died gives its lingering relay server no authority", async () => {
  const h = await harness([{ match: task("LOST"), steps: [{ sleep: 60000 }, { reply: "never" }] }]);
  try {
    const j = await h.call("delegate", { target: "claude", task: "LOST", mode: "read" });
    await until(() => h.starts().length === 1, 10000, "start");
    const row = h.sql("SELECT * FROM nodes WHERE id = ?", j.job_id)[0];
    // The relay server the agent was given, still connected after its worker is killed.
    const file = path.join(h.home, "runs", row.run_id, "nodes", j.job_id, "context.json");
    const child = await h.instance({ args: ["--context", file], env: { RELAY_RUN_ID: row.run_id, RELAY_NODE_ID: j.job_id, RELAY_DEPTH: String(row.depth), RELAY_INJECTED: "1" } });
    process.kill(row.worker_pid, "SIGKILL");
    await until(() => !alive(row.worker_pid), 30000, "the worker to be gone");
    assert.equal((await h.call("status", { id: j.job_id })).status, "lost");
    assert.equal(h.sql("SELECT status FROM turns WHERE node_id = ?", j.job_id)[0].status, "failed", "the turn was closed along with its job");
    const late = await child.call("delegate", { target: "codex", task: "FROM_LOST_TURN", mode: "read" });
    assert.match(late.reason, /turn this relay connection belonged to has ended/);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes")[0].c, 1);
  } finally {
    await h.close();
  }
});

test("verification: a job resumed after its merged branch was cleaned up finds its own earlier work", async () => {
  const h = await harness([
    { match: task("WRITE"), steps: [{ write: "feature.txt", content: "v1\n" }, { reply: "done" }] },
    { match: "REOPEN", steps: [{ reply: "done" }] },
  ]);
  try {
    const j = await h.call("delegate", { target: "codex", task: "WRITE", mode: "write", background: false });
    assert.equal((await h.call("merge", { job_id: j.job_id })).status, "merged");
    const cleaned = JSON.parse(h.cli("clean"));
    assert.deepEqual(cleaned.branches_deleted, [j.branch]);
    await h.call("resume", { job_id: j.job_id, message: "REOPEN" });
    assert.equal((await h.call("status", { id: j.job_id, wait_s: 20 })).status, "done");
    const again = h.starts()[1];
    assert.equal(fs.readFileSync(path.join(again.cwd, "feature.txt"), "utf8"), "v1\n", "the restored worktree starts from the job's last commit, not from where the job began");
  } finally {
    await h.close();
  }
});

test("verification: another open session cannot merge or cancel in a run it does not own", async () => {
  const h = await harness([
    { match: task("WRITE"), steps: [{ write: "file.txt", content: "x\n" }, { reply: "done" }] },
    { match: task("HANG"), steps: [{ sleep: 60000 }, { reply: "never" }] },
  ]);
  try {
    const owner = await h.instance({});
    const foreign = await h.instance({});
    const j = await owner.call("delegate", { target: "claude", task: "WRITE", mode: "write", background: false });
    const k = await owner.call("delegate", { target: "codex", task: "HANG", mode: "read" });
    await until(() => h.starts().length === 2, 10000, "second start");
    for (const [tool, args] of [["resume", { job_id: j.job_id, message: "x" }], ["merge", { job_id: j.job_id }], ["cancel", { id: k.job_id }]] as const) {
      assert.deepEqual(await foreign.call(tool, args), UNAVAILABLE_REPLY, tool);
    }
    assert.equal(h.sql("SELECT status FROM nodes WHERE id = ?", k.job_id)[0].status, "running");
    // The user's terminal is not bound by session ownership.
    assert.deepEqual(JSON.parse(h.cli("cancel", k.job_id)).cancelled, [k.job_id]);
    assert.equal(h.sql("SELECT status FROM turns WHERE node_id = ?", k.job_id)[0].status, "cancelled");
  } finally {
    await h.close();
  }
});

test("verification: cancel does not hang when something the agent started holds its output open", async () => {
  const { streamTurn } = await import("../dist/backends/stream.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const { relayProcs } = await import("../dist/core/db.js");
  const { procTree } = await import("../dist/core/procs.js");
  const descendantProcs = (pid: number) => procTree(pid, relayProcs).procs;
  const h = await harness();
  let tree: number[] = [];
  let handle: any;
  // This test calls the backend in-process, so the registry it consults is this harness's.
  process.env.RELAY_HOME = h.home;
  try {
    // An agent that starts a detached child sharing its stdout, then exits on SIGINT while the child lives on.
    const code = "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']}); c.unref(); process.on('SIGINT',()=>process.exit(0)); setInterval(()=>{},1000);";
    const invocation = { command: process.execPath, args: ["-e", code], env: process.env };
    handle = streamTurn({ config: { ...DEFAULT_CONFIG, cancel_grace_ms: 200, allow_untested: true }, cwd: h.repo, dir: h.home, logPath: path.join(h.home, "synthetic.log"), prompt: "", access: "read", target: targetDef("claude"), relay: null, markers: { runId: "test", nodeId: "test", depth: 1 } } as never, { invocation, onEvent: () => {} });
    // The agent has started its detached child, however long that took.
    await until(() => descendantProcs(handle.pid).length > 0, 30000, "the agent's detached child");
    const procs = descendantProcs(handle.pid);
    tree = procs.map((p: { pid: number }) => p.pid);
    assert.equal(tree.length, 1, "the detached child is found by parentage");
    assert.match(procs[0].start, /\d{4}$/, "with the start time that identifies it");
    // A hang is what this rules out; the deadline is far beyond the 200 ms grace on any machine.
    const finished = await Promise.race([handle.cancel().then(() => true), sleep(30000).then(() => false)]);
    assert.equal(finished, true, "cancel returned");
    assert.equal(alive(handle.pid), false);
    assert.deepEqual(tree.filter((p) => alive(p)), [], "and the detached child was killed too");
  } finally {
    for (const p of tree) try { process.kill(p, "SIGKILL"); } catch {}
    if (handle) killGroup(handle.pid);
    await h.close();
  }
});

test("verification: containment holds for a filesystem root and for paths that do not exist yet", async () => {
  const { inside, underTemp, canonical } = await import("../dist/core/config.js");
  const os = await import("node:os");
  assert.equal(inside("/Users/someone/.local/state/relay", "/"), true, "everything is inside the root");
  assert.equal(inside("/a/bc", "/a/b"), false, "a sibling with a longer name is not inside");
  const notYet = path.join(os.tmpdir(), "relay-not-created-yet", "home");
  assert.equal(fs.existsSync(notYet), false);
  assert.equal(underTemp(notYet), true, "a control directory about to be created under the temp directory is recognised");
  assert.equal(canonical(notYet), path.join(fs.realpathSync(os.tmpdir()), "relay-not-created-yet", "home"));
  const h = await harness();
  try {
    for (const p of ["/", path.dirname(h.home)]) {
      const r = await h.call("delegate", { target: "codex", task: "x", mode: "write", grant: { write_paths: [p] } });
      assert.equal(r.refused, true, p);
      assert.match(r.reason, /overlaps/);
    }
  } finally {
    await h.close();
  }
});

test("verification: the Codex configuration check compares every field relay set, including its own server's identity", async () => {
  const { configProblem } = await import("../dist/backends/codex-app.js");
  const relay = { command: "/n/node", args: ["/r/cli.js", "mcp", "--context", "/c.json"], env: { RELAY_RUN_ID: "run_1", RELAY_NODE_ID: "j_1", RELAY_DEPTH: "1", RELAY_INJECTED: "1" } };
  const { codexPermissions } = await import("../dist/backends/codex.js");
  const permissions = codexPermissions({ access: "write", config: { codex_backend: "app-server" } } as never, { dangerous: false, network: false, roots: [] });
  const expect = { permissions, relay, relayOnly: true };
  const good = {
    approvals_reviewer: "user", default_permissions: "relay", permissions: { relay: permissions.profile },
    mcp_servers: { relay: { enabled: true, ...relay }, email: { enabled: false } }, features: { plugins: false },
  };
  assert.equal(configProblem(good, expect), null);
  const bad = (change: Record<string, unknown>, expected: RegExp) => assert.match(String(configProblem({ ...good, ...change }, expect)), expected);
  bad({ permissions: { relay: { ...permissions.profile, filesystem: { ...permissions.profile!.filesystem, ":slash_tmp": "write" } } } }, /the permission profile "relay" is .*":slash_tmp":"write"/);
  bad({ mcp_servers: { relay: { enabled: true, command: "false", args: [] } } }, /not the command relay injected/);
  bad({ mcp_servers: { relay: { enabled: true, ...relay, env: { ...relay.env, RELAY_NODE_ID: "j_other" } } } }, /does not carry the identity relay injected \(RELAY_NODE_ID\)/);
  bad({ mcp_servers: {} }, /missing or off/);
  bad({ features: { plugins: true } }, /plugins are still enabled/);
  assert.match(String(configProblem(good, { ...expect, relay: null })), /a relay MCP server is on where this turn should have none/);
});

test("verification: a resume that arrives while a cancel is still finishing is not disturbed by it", async () => {
  const h = await harness([
    // The job starts a job of its own, whose agent will not stop when asked. The cancel covers the
    // job's descendants, so it waits for that agent (up to cancel_grace_ms, far longer than this
    // test) after the job itself is free, until the test kills it.
    { match: task("HANG"), steps: [{ call: "delegate", args: { target: "codex", task: "STUBBORN", mode: "read" } }, { sleep: 60000 }, { reply: "never" }] },
    { match: task("STUBBORN"), steps: [{ ignoreSignals: true }, { checkpoint: "ignoring" }, { sleep: 60000 }, { reply: "never" }] },
    // Held until the cancel has returned, so the rerun is certainly in progress while the cancel finishes.
    { match: "RERUN$", steps: [{ signal: "rerun-started" }, { await: "rerun-may-finish" }, { reply: "rerun complete" }] },
  ], { cancel_grace_ms: 30000 });
  let holder: number | null = null;
  try {
    const j = await h.call("delegate", { target: "claude", task: "HANG", mode: "read" });
    let child = "";
    await until(() => (child = h.sql("SELECT id FROM nodes WHERE parent_id = ?", j.job_id)[0]?.id ?? ""), 20000, "the job's own job");
    await passed(h, child, "ignoring");
    holder = h.sql("SELECT agent_pgid FROM nodes WHERE id = ?", child)[0].agent_pgid as number;
    assert.ok(holder > 1, "the stubborn agent's group is recorded");
    let cancelReturned = false;
    const cancelling = h.call("cancel", { id: j.job_id }).then((r) => ((cancelReturned = true), r));
    // The job is free (cancelled, no worker, no agent) before cancel has returned.
    await until(() => {
      const r = h.sql("SELECT status, worker_pid, agent_pgid FROM nodes WHERE id = ?", j.job_id)[0];
      return r.status === "cancelled" && r.worker_pid === null && r.agent_pgid === null;
    }, 10000, "the job to be free");
    assert.equal(h.sql("SELECT status FROM turns WHERE node_id = ? ORDER BY id LIMIT 1", j.job_id)[0].status, "cancelled", "the cancelled turn ended in the same step");
    const resumed = await h.call("resume", { job_id: j.job_id, message: "RERUN" });
    assert.equal(resumed.status, "queued", JSON.stringify(resumed));
    // The rerun is under way: its worker and its agent are running, and recorded on the job.
    await until(() => reached(h, "rerun-started"), 20000, "the rerun's agent");
    let rerun: { worker_pid: number; agent_pgid: number } = { worker_pid: 0, agent_pgid: 0 };
    await until(() => {
      rerun = h.sql("SELECT worker_pid, agent_pgid FROM nodes WHERE id = ?", j.job_id)[0];
      return rerun.worker_pid > 1 && rerun.agent_pgid > 1;
    }, 20000, "the rerun's worker and agent to be recorded");
    const rerunAgent = h.starts().at(-1)!.pid as number;
    // And the cancel has not finished: everything it does from here on is done with the rerun running.
    assert.equal(cancelReturned, false, "the cancel was still finishing when the rerun started");
    assert.ok(alive(holder), "held by the stubborn agent");
    killGroup(holder);
    holder = null;
    const c = await cancelling;
    assert.ok(c.cancelled.includes(j.job_id) && c.cancelled.includes(child), JSON.stringify(c));
    // The cancel's last steps left the rerun alone: its turn, its worker, its agent, and their records.
    assert.deepEqual(h.sql("SELECT status FROM turns WHERE node_id = ? ORDER BY id", j.job_id).map((t) => t.status), ["cancelled", "running"]);
    assert.deepEqual(h.sql("SELECT worker_pid, agent_pgid FROM nodes WHERE id = ?", j.job_id)[0], rerun);
    assert.ok(alive(rerun.worker_pid), "the rerun's worker is alive");
    assert.ok(alive(rerunAgent), "the rerun's agent is alive");
    release(h, "rerun-may-finish");
    const st = await h.call("status", { id: j.job_id, wait_s: 20 });
    assert.equal(st.status, "done");
    assert.equal(st.result.final_message, "rerun complete");
    assert.deepEqual(h.sql("SELECT status FROM turns WHERE node_id = ? ORDER BY id", j.job_id).map((t) => t.status), ["cancelled", "done"]);
  } finally {
    if (holder) killGroup(holder);
    await h.close();
  }
});

test("verification: work that relay commits after the job's turn is still there when the job is resumed after cleanup", async () => {
  const h = await harness([
    { match: task("WRITE"), steps: [{ write: "feature.txt", content: "saved work\n" }, { reply: "done" }] },
    { match: "REOPEN", steps: [{ reply: "reopened" }] },
  ]);
  try {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: h.repo, encoding: "utf8" });
    const objects = path.join(h.repo, ".git", "objects");
    fs.chmodSync(objects, 0o555);
    const j = await h.call("delegate", { target: "codex", task: "WRITE", mode: "write", background: false });
    assert.match(j.result.checkpoint_error, /could not (stage|commit)/);
    fs.chmodSync(objects, 0o755);
    // This time merge can commit the job's work, and, told to take what no result showed, does so before merging.
    assert.equal((await h.call("merge", { job_id: j.job_id, include_changes_since_result: true })).status, "merged");
    JSON.parse(h.cli("clean"));
    await h.call("resume", { job_id: j.job_id, message: "REOPEN" });
    assert.equal((await h.call("status", { id: j.job_id, wait_s: 20 })).status, "done");
    assert.equal(fs.readFileSync(path.join(h.starts()[1].cwd, "feature.txt"), "utf8"), "saved work\n");
  } finally {
    await h.close();
  }
});

test("verification: an agent that dies without warning does not leave a detached child or a stuck worker behind", async () => {
  const { streamTurn } = await import("../dist/backends/stream.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
  const h = await harness();
  let childPid = 0;
  let handle: any;
  process.env.RELAY_HOME = h.home;
  try {
    // An agent that starts a detached child sharing its output, reports the child's pid, and crashes
    // once the test lets it.
    const marker = path.join(h.home, "orphan.pid");
    const go = path.join(h.home, "may-crash");
    const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']}); c.unref(); fs.writeFileSync(${JSON.stringify(marker)}, String(c.pid)); setInterval(()=>{ if (fs.existsSync(${JSON.stringify(go)})) process.exit(1); },20);`;
    const invocation = { command: process.execPath, args: ["-e", code], env: process.env };
    handle = streamTurn({ config: { ...DEFAULT_CONFIG, cancel_grace_ms: 200, allow_untested: true }, cwd: h.repo, dir: h.home, logPath: path.join(h.home, "crash.log"), prompt: "", access: "read", target: targetDef("claude"), relay: null, markers: { runId: "test", nodeId: "test", depth: 1 } } as never, { invocation, onEvent: () => {} });
    await until(() => fs.existsSync(marker), 20000, "the agent to start its child");
    // Relay looks at what the agent started on this process's own timers, at least once a second,
    // and timers fire in the order they fall due: before this one does, a look has found the child.
    await sleep(1100);
    fs.writeFileSync(go, "");
    const result = await Promise.race([handle.done, sleep(30000).then(() => null)]);
    childPid = Number(fs.readFileSync(marker, "utf8"));
    assert.ok(result, "the turn ended although the child held the agent's output open");
    assert.equal(result.status, "failed");
    await until(() => !alive(childPid), 30000, "the detached child to be killed");
  } finally {
    if (childPid) try { process.kill(childPid, "SIGKILL"); } catch {}
    if (handle) killGroup(handle.pid);
    await h.close();
  }
});

forEachTarget((target) => {
  test(`verification (${target}): an agent that crashes mid-turn leaves neither its detached child nor its worker behind`, async () => {
    // The agent crashes only once relay has looked at it since it started its child.
    const h = await harness([{ match: task("CRASH"), steps: [{ orphan: true }, ...lookSteps("crash"), { crash: 1 }] }]);
    try {
      const j = await h.call("delegate", { target, task: "CRASH", mode: "read" });
      await looked(h, j.job_id, "crash");
      await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", j.job_id)[0].worker_pid > 0, 10000, "worker");
      const worker = h.sql("SELECT worker_pid FROM nodes WHERE id = ?", j.job_id)[0].worker_pid;
      const st = await h.call("status", { id: j.job_id, wait_s: 20 });
      assert.equal(st.status, "failed");
      const orphan = Number(fs.readFileSync(path.join(h.env.STUB_DIR, "orphan.pid"), "utf8"));
      await until(() => !alive(orphan), 20000, "the detached child to be killed");
      await until(() => !alive(worker), 20000, "the worker to exit");
    } finally {
      await h.close();
    }
  });

  test(`verification (${target}): a child started just before a crash, too late to be seen, is reported as possibly still running`, async () => {
    // Relay finds what an agent started by looking at intervals. Started and orphaned between two looks, the child cannot be found.
    const h = await harness([{ match: task("BLINK"), steps: [{ sleep: 700 }, { orphan: true }, { crash: 1 }] }]);
    let orphan = 0;
    try {
      const j = await h.call("delegate", { target, task: "BLINK", mode: "write" });
      const st = await h.call("status", { id: j.job_id, wait_s: 20 });
      orphan = Number(fs.readFileSync(path.join(h.env.STUB_DIR, "orphan.pid"), "utf8"));
      assert.equal(st.status, "failed");
      // Nothing claims the agent left nothing behind: the job, its result and its turn all say what is not known.
      assert.match(st.error, /last looked \d+ ms before the agent exited.*may still be running/);
      assert.equal(st.result.warnings.length, 1);
      assert.match(st.result.warnings[0], /may still be running/);
      assert.match(h.sql("SELECT error FROM turns WHERE node_id = ?", j.job_id)[0].error, /may still be running/);
      // The worktree is kept, since something may still be at work in it.
      assert.ok(fs.existsSync(h.sql("SELECT worktree FROM nodes WHERE id = ?", j.job_id)[0].worktree));
      await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", j.job_id)[0].worker_pid === null, 20000, "the worker to leave");
    } finally {
      if (orphan) try { process.kill(orphan, "SIGKILL"); } catch {}
      await h.close();
    }
  });
});

test("verification: warnings about processes reach the caller whatever the turn's outcome", async () => {
  const { processWarnings } = await import("../dist/core/session.js");
  assert.deepEqual(processWarnings({}), []);
  assert.match(processWarnings({ survivors: [41, 42] })[0], /could not be stopped.*pids 41, 42/);
  assert.equal(processWarnings({ survivors: [41], unseenMs: 300 }).length, 2);
  const h = await harness([
    // Still there after its last word as the real CLIs are, until relay has read that word.
    { match: task("TIDY"), steps: [{ sleep: 700 }, { orphan: true }, { reply: "done", after: "tidy-said" }] },
    { match: task("VANISH"), steps: [{ sleep: 700 }, { orphan: true }, { reply: "done", vanish: true }] },
  ]);
  let left = 0;
  try {
    // An agent that shuts down the way the real ones do is still there for relay's last look:
    // what it started a moment before its last word is found and stopped, and nothing is warned of.
    const tidy = await h.call("delegate", { target: "claude", task: "TIDY", mode: "write" });
    await passed(h, tidy.job_id, "tidy-said");
    const a = await h.call("status", { id: tidy.job_id, wait_s: 20 });
    assert.equal(a.status, "done");
    assert.equal(a.result.warnings, undefined);
    assert.equal(a.result.no_changes, true);
    const orphan = Number(fs.readFileSync(path.join(h.env.STUB_DIR, "orphan.pid"), "utf8"));
    await until(() => !alive(orphan), 20000, "the detached child to be killed");

    // One that is gone before that look succeeded all the same. The job is done, and says what relay does not know.
    const gone = await h.call("delegate", { target: "claude", task: "VANISH", mode: "write" });
    const b = await h.call("status", { id: gone.job_id, wait_s: 20 });
    left = Number(fs.readFileSync(path.join(h.env.STUB_DIR, "orphan.pid"), "utf8"));
    assert.equal(b.status, "done");
    assert.equal(b.error, undefined);
    assert.match(b.result.warnings[0], /gone before relay could take a last look.*may still be running/);
    // It changed nothing, but its unchanged worktree is not removed while something may be running in it.
    assert.equal(b.result.no_changes, true);
    assert.equal(b.result.branch, `relay/${gone.job_id}`);
    assert.ok(fs.existsSync(h.sql("SELECT worktree FROM nodes WHERE id = ?", gone.job_id)[0].worktree));
  } finally {
    if (left) try { process.kill(left, "SIGKILL"); } catch {}
    await h.close();
  }
});

test("verification: a discussion that fails on a later turn keeps the warnings of its earlier ones", async () => {
  const h = await harness([
    { target: "codex", turn: 1, steps: [{ sleep: 700 }, { orphan: true }, { reply: "Option A.\nCONTINUE", vanish: true }] },
    { target: "codex", turn: 2, steps: [{ fail: "model unavailable" }] },
  ], { codex_backend: "exec" });
  let left = 0;
  try {
    const first = await h.call("discuss", { target: "codex", topic: "A or B?", message: "B, I think.\nCONTINUE" });
    left = Number(fs.readFileSync(path.join(h.env.STUB_DIR, "orphan.pid"), "utf8"));
    assert.equal(first.status, "open");
    const r = await h.call("discuss", { discussion_id: first.discussion_id, message: "Why A?\nCONTINUE" });
    assert.equal(r.outcome, "error");
    assert.match(r.error, /codex's turn failed/);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /^codex, turn 2: .*may still be running/);
  } finally {
    if (left) try { process.kill(left, "SIGKILL"); } catch {}
    await h.close();
  }
});

test("verification: an error the agent went on to retry does not count as its last word", async () => {
  // `codex exec` reports errors it then recovers from. Relay's last look belongs at the event that really ends the turn.
  // The agent is held until relay has read the error, so that a look taken there would find it alive and leave no warning.
  const h = await harness([{ match: task("RETRY"), steps: [{ emit: { type: "error", message: "stream error; retrying" } }, { checkpoint: "error-read" }, { sleep: 700 }, { orphan: true }, { reply: "done", vanish: true }] }], { codex_backend: "exec" });
  let left = 0;
  try {
    const j = await h.call("delegate", { target: "codex", task: "RETRY", mode: "write" });
    await passed(h, j.job_id, "error-read");
    const st = await h.call("status", { id: j.job_id, wait_s: 20 });
    left = Number(fs.readFileSync(path.join(h.env.STUB_DIR, "orphan.pid"), "utf8"));
    assert.equal(st.status, "done");
    assert.match(st.result.warnings[0], /gone before relay could take a last look/);
    assert.equal(st.result.no_changes, true);
    assert.equal(st.result.branch, `relay/${j.job_id}`, "the worktree is kept while something may still be running in it");
  } finally {
    if (left) try { process.kill(left, "SIGKILL"); } catch {}
    await h.close();
  }
});
