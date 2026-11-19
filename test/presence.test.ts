import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closeDbForTests, createRun, db, recordLaunchLeader } from "../dist/core/db.js";
import { withDefaults } from "../dist/core/config.js";
import { launchedTree, type PresenceProbe, type Row } from "../dist/core/presence.js";
import { requestUnchanged } from "../dist/core/approvals.js";
import { CLI } from "./helpers.ts";

/** A process-table snapshot from rows [pid, parent, pgid, start]. */
function table(...rows: [number, number, number, string][]): Map<number, Row> {
  return new Map(rows.map(([pid, parent, pgid, start]) => [pid, { pid, parent, pgid, start }]));
}
const probe = (t: Map<number, Row> | null, sid: number | null, self?: number): PresenceProbe => ({ table: () => t, sid: () => sid, self });

/** A scratch registry for one case; returns the run id and a cleanup. */
function scratch(): { run: string; cleanup: () => void } {
  const saved = process.env.RELAY_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-presence-"));
  process.env.RELAY_HOME = tmp;
  const run = createRun(tmp, withDefaults({}), "presence-root");
  return { run, cleanup: () => { closeDbForTests(); if (saved === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = saved; fs.rmSync(tmp, { recursive: true, force: true }); } };
}

// C6/X4: the ancestry, PGID, SID, dead-leader, pid-reuse and fail-closed branches of launchedTree,
// exercised through a snapshot of the process table and a chosen session id, with leaders and
// launched processes seeded in a scratch registry. No processes are launched.

test("presence: an ancestor that is a live launched agent places this process inside the tree", () => {
  const { run, cleanup } = scratch();
  try {
    // self 1000 ← 2000 (the agent, recorded alive with start "AGENT START") ← 1 (launchd)
    db().prepare("INSERT INTO nodes (id, run_id, kind, mode, depth, allow_delegation, status, task, cwd, agent_pid, agent_start, created_at) VALUES ('j_a', ?, 'job', 'read', 1, 0, 'running', 't', '/tmp', 2000, 'AGENT START', 0)").run(run);
    const t = table([1000, 2000, 9, "SELF"], [2000, 1, 2000, "AGENT START"]);
    assert.match(launchedTree({}, probe(t, 9, 1000)) ?? "", /process tree of the agent of j_a \(pid 2000\)/);
    // Start-time mismatch (the pid was reused by an unrelated process): no ancestry match.
    const reused = table([1000, 2000, 9, "SELF"], [2000, 1, 2000, "DIFFERENT START"]);
    assert.equal(launchedTree({}, probe(reused, 9, 1000)), null, "a reused ancestor pid with a different start time is not matched");
  } finally { cleanup(); }
});

test("presence: the process group of a recorded leader places this process inside the tree, even when the leader is dead (C3)", () => {
  const { run, cleanup } = scratch();
  try {
    recordLaunchLeader(run, 3000, "agent", "j_g");
    // self 1000 is in group 3000; the leader 3000 is NOT in the table (it has exited).
    const t = table([1000, 1, 3000, "SELF"]);
    assert.match(launchedTree({}, probe(t, 4242, 1000)) ?? "", /process group of the agent of j_g \(leader pid 3000\)/);
  } finally { cleanup(); }
});

test("presence: a reused leader pid (live, different start time) does not falsely place a person's terminal (C2)", () => {
  const { run, cleanup } = scratch();
  try {
    // Leader 3000 recorded with start "OLD". The group 3000 is now led by an unrelated live process
    // with a different start time: the old group is gone (XNU does not reuse a pid still a pgid/sid).
    db().prepare("INSERT INTO launch_leaders (run_id, leader_pid, kind, node_id, start, created_at) VALUES (?, 3000, 'agent', 'j_r', 'OLD', 0)").run(run);
    const reused = table([1000, 1, 3000, "SELF"], [3000, 1, 3000, "NEW START"]);
    assert.equal(launchedTree({}, probe(reused, 4242, 1000)), null, "a live reused pgid with a new start is not matched");
    // But a dead leader (nothing alive at 3000) still matches: the descendants kept the group.
    const orphan = table([1000, 1, 3000, "SELF"]);
    assert.match(launchedTree({}, probe(orphan, 4242, 1000)) ?? "", /process group of the agent of j_r/);
  } finally { cleanup(); }
});

test("presence: a pid that led twice in one run keeps both starts, in either order, so a live leader is not missed (C2)", () => {
  for (const order of [["OLD", "NEW"], ["NEW", "OLD"]]) {
    const { run, cleanup } = scratch();
    try {
      for (const start of order) db().prepare("INSERT INTO launch_leaders (run_id, leader_pid, kind, node_id, start, created_at) VALUES (?, 3000, 'agent', ?, ?, 0)").run(run, `j_${start}`, start);
      // The live process at 3000 is the NEW leader; the caller is in its group.
      const live = table([1000, 1, 3000, "SELF"], [3000, 1, 3000, "NEW"]);
      assert.match(launchedTree({}, probe(live, 4242, 1000)) ?? "", /process group of the agent of j_NEW/, `recorded ${order.join(" then ")}`);
      // An unrelated live process at 3000 matches neither start: not placed.
      const other = table([1000, 1, 3000, "SELF"], [3000, 1, 3000, "SOMEONE ELSE"]);
      assert.equal(launchedTree({}, probe(other, 4242, 1000)), null, `recorded ${order.join(" then ")}: unrelated pid owner`);
    } finally { cleanup(); }
  }
});

test("presence: a pid recorded as a leader in two runs keeps both starts (C2)", () => {
  const { run, cleanup } = scratch();
  try {
    const run2 = createRun(process.env.RELAY_HOME!, withDefaults({}), "presence-root-2");
    db().prepare("INSERT INTO launch_leaders (run_id, leader_pid, kind, node_id, start, created_at) VALUES (?, 3000, 'agent', 'j_a', 'OLD', 0)").run(run);
    db().prepare("INSERT INTO launch_leaders (run_id, leader_pid, kind, node_id, start, created_at) VALUES (?, 3000, 'worker', 'j_b', 'NEW', 1)").run(run2);
    const live = table([1000, 1, 3000, "SELF"], [3000, 1, 3000, "NEW"]);
    assert.match(launchedTree({}, probe(live, 4242, 1000)) ?? "", /process group of relay's worker for j_b/);
    // Through the session too.
    const bySession = table([1000, 1, 7, "SELF"], [3000, 1, 3000, "NEW"]);
    assert.match(launchedTree({}, probe(bySession, 3000, 1000)) ?? "", /session of relay's worker for j_b/);
  } finally { cleanup(); }
});

test("presence: a leader recorded with an unknown start matches whatever holds the pid now (C2)", () => {
  const { run, cleanup } = scratch();
  try {
    db().prepare("INSERT INTO launch_leaders (run_id, leader_pid, kind, node_id, start, created_at) VALUES (?, 3000, 'agent', 'j_u', '', 0)").run(run);
    const live = table([1000, 1, 3000, "SELF"], [3000, 1, 3000, "ANY START"]);
    assert.match(launchedTree({}, probe(live, 4242, 1000)) ?? "", /process group of the agent of j_u/);
  } finally { cleanup(); }
});

test("presence: the session of a recorded leader places this process inside the tree, even when the leader is dead (C3)", () => {
  const { run, cleanup } = scratch();
  try {
    recordLaunchLeader(run, 4000, "worker", "j_s");
    // self 1000, its group 7 is not a leader, but its session id 4000 is a recorded leader.
    const t = table([1000, 1, 7, "SELF"]);
    assert.match(launchedTree({}, probe(t, 4000, 1000)) ?? "", /session of relay's worker for j_s \(leader pid 4000\)/);
  } finally { cleanup(); }
});

test("presence: a person's own terminal, with nothing launched, is not inside any tree", () => {
  const { cleanup } = scratch();
  try {
    const t = table([1000, 500, 7, "SELF"], [500, 1, 500, "LOGIN"]);
    assert.equal(launchedTree({}, probe(t, 7, 1000)), null);
  } finally { cleanup(); }
});

test("presence: unreadable process data, or a session id relay cannot read, fails closed", () => {
  const { run, cleanup } = scratch();
  try {
    recordLaunchLeader(run, 3000, "agent", "j_x");
    const t = table([1000, 1, 3000, "SELF"]);
    assert.match(launchedTree({}, probe(null, 9, 1000)) ?? "", /could not read the process table/);
    assert.match(launchedTree({}, probe(t, null, 1000)) ?? "", /could not read its session id/);
  } finally { cleanup(); }
});

test("presence: an environment marker is reported before any process lookup", () => {
  // No probe needed: the marker short-circuits. (The dm8 suite covers each marker name.)
  assert.match(launchedTree({ RELAY_NODE_ID: "j_1" }, probe(null, null)) ?? "", /RELAY_NODE_ID/);
});

// C6/X4: the post-code re-read refusal, as a pure check.
test("presence: requestUnchanged refuses a request that changed or was decided while the person was asked", () => {
  const shown = { summary: "run X", kind: "command", node_id: "j_1" };
  assert.equal(requestUnchanged(shown, { status: "pending", ...shown }), true);
  assert.equal(requestUnchanged(shown, undefined), false, "gone");
  assert.equal(requestUnchanged(shown, { status: "denied", ...shown }), false, "decided");
  assert.equal(requestUnchanged(shown, { status: "pending", summary: "run Y", kind: "command", node_id: "j_1" }), false, "summary changed");
  assert.equal(requestUnchanged(shown, { status: "pending", summary: "run X", kind: "env", node_id: "j_1" }), false, "kind changed");
  assert.equal(requestUnchanged(shown, { status: "pending", summary: "run X", kind: "command", node_id: "j_2" }), false, "asking node changed");
});

/**
 * Runs `argv` as a launched agent's descendant that has shed every other link to it: in a session
 * of its own, led by a Perl process recorded (by `record`) as a launched agent's leader before the
 * command starts, and in a process group of its own within that session, with no ancestor relay
 * recorded. Only the session backstop can then place it. The session is made here rather than
 * taken from the test runner, which need not lead one: on GitHub's macOS runners the job runs in
 * launchd's session (id 1), which relay never records as a leader and so can never match.
 */
function inRecordedSession(record: (leader: number) => void, argv: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const perl = [
    "use POSIX (); POSIX::setsid() or die qq(setsid: $!\\n); $| = 1;",
    "my $sid = syscall(310, 0); $sid == $$ or die qq(session $sid is not this process's ($$)\\n);",
    "print qq($$\\n); <STDIN>;",
    "my $pid = fork() // die qq(fork: $!\\n);",
    "if (!$pid) { setpgrp(0, 0) or die qq(setpgrp: $!\\n); exec { $ARGV[0] } @ARGV or die qq(exec: $!\\n); }",
    "waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8);",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/perl", ["-e", perl, ...argv], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", leader: number | null = null;
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
      const nl = stdout.indexOf("\n");
      if (leader === null && nl >= 0) {
        leader = Number(stdout.slice(0, nl));
        stdout = stdout.slice(nl + 1);
        try { record(leader); } catch (e) { child.kill(); reject(e); return; }
        child.stdin.end("go\n");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// C6/X4 integration (macOS): the real CLI callers refuse on a non-marker path. A relay process that
// carries no RELAY_* marker, has no recorded ancestor and leads its own process group, but is in a
// session whose leader relay recorded as a launched agent's, is placed inside the launched tree by
// the session backstop.
test("presence: cancel, adopt, clean --forget and approve refuse in a launched session with no marker", async () => {
  const { run, cleanup } = scratch();
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RELAY_")));
    env.RELAY_HOME = process.env.RELAY_HOME!;
    for (const [cmd, extra] of [["cancel", []], ["adopt", ["--to", "a".repeat(24)]], ["clean", ["--forget", run]], ["approve", []]] as const) {
      const r = await inRecordedSession((leader) => recordLaunchLeader(run, leader, "agent", "j_live"), [process.execPath, CLI, cmd, ...(cmd === "clean" ? [] : ["x_1"]), ...extra], env);
      assert.equal(r.status, 2, `${cmd}: status ${r.status} — ${r.stdout} ${r.stderr}`);
      assert.match(r.stderr, /cannot run in a launched agent's environment/, cmd);
      assert.match(r.stderr, /[Ii]t is in the session of the agent of j_live \(leader pid \d+\)/, `${cmd} is placed by the session backstop`);
    }
    // Every leader was recorded (none was pid 1 or less, which relay would have skipped).
    assert.equal((db().prepare("SELECT COUNT(*) AS n FROM launch_leaders WHERE run_id = ?").get(run) as { n: number }).n, 4);
  } finally { cleanup(); }
});

// C4/X2: relay chat's two ways of speaking as the person refuse inside a launched tree and insert
// nothing; --print, which only reads, still works there.
test("presence: chat --say refuses in a launched agent's environment and inserts nothing; --print still reads", () => {
  const { run, cleanup } = scratch();
  try {
    const transcript = path.join(process.env.RELAY_HOME!, "d.md");
    fs.writeFileSync(transcript, "# Discussion d_chat\n");
    db().prepare("INSERT INTO nodes (id, run_id, kind, mode, depth, allow_delegation, status, task, cwd, transcript_path, created_at) VALUES ('d_chat', ?, 'discussion', 'read', 1, 0, 'open', 't', '/tmp', ?, 0)").run(run, transcript);
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RELAY_"))) as Record<string, string>;
    base.RELAY_HOME = process.env.RELAY_HOME!;
    const injected = () => (db().prepare("SELECT COUNT(*) AS n FROM injections WHERE discussion_id = 'd_chat'").get() as { n: number }).n;
    const launched = { ...base, RELAY_NODE_ID: "j_launched" };
    const say = spawnSync(process.execPath, [CLI, "chat", "d_chat", "--say", "as the user"], { env: launched, encoding: "utf8" });
    assert.equal(say.status, 2, `${say.stdout} ${say.stderr}`);
    assert.match(say.stderr, /relay chat --say cannot run in a launched agent's environment/);
    assert.equal(injected(), 0, "nothing was injected");
    // Interactive chat (no --say, no --print) refuses before reading any input.
    const interactive = spawnSync(process.execPath, [CLI, "chat", "d_chat"], { env: launched, input: "typed line\n", encoding: "utf8", timeout: 10000 });
    assert.equal(interactive.status, 2, `${interactive.stdout} ${interactive.stderr}`);
    assert.match(interactive.stderr, /relay chat cannot run in a launched agent's environment/);
    assert.equal(injected(), 0, "nothing was injected interactively");
    // --print only reads: allowed in the same environment.
    const print = spawnSync(process.execPath, [CLI, "chat", "d_chat", "--print"], { env: launched, encoding: "utf8" });
    assert.equal(print.status, 0, print.stderr);
    assert.match(print.stdout, /# Discussion d_chat/);
    // From the person's own terminal (no marker, nothing launched), --say injects.
    const own = spawnSync(process.execPath, [CLI, "chat", "d_chat", "--say", "from the person"], { env: base, encoding: "utf8" });
    assert.equal(own.status, 0, own.stderr);
    assert.equal(JSON.parse(own.stdout).injected, true);
    assert.equal(injected(), 1);
  } finally { cleanup(); }
});
