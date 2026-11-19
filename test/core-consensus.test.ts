import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { scratchOnly, until } from "./helpers.ts";
import { harnessHome, nodeDir, withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun, db, getNode, insertNode, insertTurn, updateNode } from "../dist/core/db.js";
import { newInstance } from "../dist/core/caller.js";
import { decide, pendingRequests, requestApproval } from "../dist/core/approvals.js";
import { cancel, review } from "../dist/core/ops.js";
import { openReviewOf } from "../dist/modes/review.js";
import { nodeView } from "../dist/core/views.js";
import { pendingEvents, watch } from "../dist/core/watch.js";
import { forgetOldRuns, sweepTemps } from "../dist/core/retention.js";
import { ensurePrivateRoot, nativeTempRoot } from "../dist/confine/private-root.js";
import { relayServer } from "../dist/mcp/server.js";
import { waitUntil } from "../dist/core/wait.js";
import { TARGETS } from "../dist/targets/index.js";

function fixture(config = {}) {
  closeDbForTests();
  const home = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-core-consensus-"))));
  const previous = { ...process.env };
  process.env.RELAY_HOME = home;
  process.env.RELAY_CONFIG = path.join(home, "config.json");
  const cfg = withDefaults({ ask_user: "never", allow_temp_home: true, approval_timeout_s: 5, ...config });
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
  const inst = newInstance({ kind: "root" }, home, "codex");
  const run = createRun(home, cfg, inst.token);
  inst.runId = run;
  inst.since.set(run, 0);
  let seq = 0;
  const node = (values = {}) => insertNode({ id: `j_${(++seq).toString(16).padStart(8, "0")}`, run_id: run, kind: "job", target: "claude", mode: "read", depth: 1, task: "test", cwd: home, status: "done", ...values });
  return { home, inst, run, node, close() {
    closeDbForTests();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    fs.rmSync(home, { recursive: true, force: true });
  } };
}

test("X1: an unavailable repository is retained even when its parent exists", () => {
  const f = fixture();
  try {
    f.node({ repo: path.join(f.home, "unmounted"), branch: "relay/keep" });
    db().prepare("UPDATE runs SET root_pid = NULL, root_start = NULL, root_token = NULL").run();
    const r = forgetOldRuns(7, { at: Date.now() + 30 * 86400000 });
    assert.deepEqual(r.forgotten, []);
    assert.match(r.kept.join("\n"), /absence does not establish deletion/);
    assert.ok(db().prepare("SELECT 1 FROM runs WHERE id = ?").get(f.run));
  } finally { f.close(); }
});

test("X1: a run whose only missing repository held no branch (a read job) can still be forgotten", () => {
  const f = fixture();
  try {
    f.node({ repo: path.join(f.home, "removed-scratch-repo") });
    db().prepare("UPDATE runs SET root_pid = NULL, root_start = NULL, root_token = NULL").run();
    const r = forgetOldRuns(7, { at: Date.now() + 30 * 86400000 });
    assert.deepEqual(r.forgotten, [f.run]);
  } finally { f.close(); }
});

test("X2: queued MCP calls recheck the matching job-wide tool allowance", async () => {
  const f = fixture();
  const ctl = new AbortController();
  const calls: Promise<unknown>[] = [];
  try {
    const n = f.node({ status: "running" });
    const turn = insertTurn(n.id, "test", "test", "read", "running");
    const ask = { kind: "mcp", summary: "extension search", detail: { server: "search", tool: "find" } };
    const first = requestApproval(n.id, turn, ask, () => ctl.signal.aborted);
    calls.push(first);
    await until(() => pendingRequests(f.run).length === 1);
    const second = requestApproval(n.id, turn, ask, () => ctl.signal.aborted);
    calls.push(second);
    const request = pendingRequests(f.run)[0];
    assert.equal("error" in decide(request.id, true, "user", undefined, "job"), false);
    assert.equal((await second).allow, true);
    assert.equal((await first).allow, true);
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM requests").get()!.n, 1);
    const other = requestApproval(n.id, turn, { ...ask, detail: { server: "search", tool: "write" } }, () => ctl.signal.aborted);
    calls.push(other);
    await until(() => pendingRequests(f.run).length === 1);
    decide(pendingRequests(f.run)[0].id, false, "user");
    assert.equal((await other).allow, false, "an allowance for a different tool does not match");
    // A grant arriving while queued is still bounded by the turn that made the call.
    db().prepare("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES ('q_00000001', ?, ?, 'command', 'ahead in queue', 'pending', ?)").run(f.run, n.id, Date.now());
    const gone = requestApproval(n.id, turn, { ...ask, detail: { server: "search", tool: "write" } }, () => ctl.signal.aborted);
    calls.push(gone);
    db().prepare("INSERT INTO requests (id, run_id, node_id, kind, summary, detail_json, status, scope, created_at) VALUES ('q_00000002', ?, ?, 'mcp', 'write', ?, 'allowed', 'job', ?)").run(f.run, n.id, JSON.stringify({ server: "search", tool: "write" }), Date.now());
    db().prepare("UPDATE turns SET status = 'done' WHERE id = ?").run(turn);
    assert.equal((await gone).allow, false, "even a matching allowance must not outlive the calling turn");
  } finally { ctl.abort(); await Promise.allSettled(calls); f.close(); }
});

test("X3: brief uses a launched Grok caller's resolved model family", async () => {
  const f = fixture({ default_target: { grok: "codex", unknown: "claude" } });
  let client: Client | undefined;
  let server: ReturnType<typeof relayServer> | undefined;
  try {
    const n = f.node({ target: "grok", model: "grok-4.6", status: "running" });
    const turnId = insertTurn(n.id, "test", "test", "read", "running");
    f.inst.ctx = { kind: "child", runId: f.run, nodeId: n.id, turnId, depth: 1, access: "read", mayDelegate: true, mayAsk: true };
    server = relayServer(f.inst);
    client = new Client({ name: "grok", version: "1.0.62" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const out = await client.callTool({ name: "brief", arguments: {} });
    assert.equal(JSON.parse((out.content as { text: string }[])[0].text).target, "codex");
  } finally { await client?.close(); await server?.close(); f.close(); }
});

test("C1: cancelling reconciliation cancels its review and releases the reviewer", async () => {
  const f = fixture();
  try {
    const r = f.node({ id: "r_00000001", kind: "review", status: "open" });
    const j = f.node({ parent_id: r.id, params_json: JSON.stringify({ review_id: r.id }) });
    const d = f.node({ id: "d_00000001", kind: "discussion", parent_id: r.id, status: "open", params_json: JSON.stringify({ review_id: r.id, participant: j.id, borrowed: true }) });
    updateNode(r.id, { params_json: JSON.stringify({ reviewer: j.id, discussion: d.id, own: true }) });
    assert.equal(openReviewOf(getNode(j.id)!)?.id, r.id);
    const out = await cancel(f.inst, { id: d.id });
    assert.ok(out.cancelled.includes(r.id));
    assert.equal(getNode(r.id)!.status, "cancelled");
    assert.equal(JSON.parse(getNode(r.id)!.result_json!).outcome, "cancelled");
    assert.equal(JSON.parse(getNode(d.id)!.result_json!).outcome, "cancelled");
    assert.equal(openReviewOf(getNode(j.id)!), null);
  } finally { f.close(); }
});

test("C2: a completion after the result snapshot is delivered as an event", () => {
  const f = fixture();
  try {
    const n = f.node({ status: "running" });
    const snapshot = nodeView(n);
    updateNode(n.id, { status: "done", ended_at: Date.now() });
    assert.equal(pendingEvents(f.inst, snapshot).events.length, 1);
    assert.equal(pendingEvents(f.inst, { id: n.id, pending: true }).events.length, 1);
    assert.equal(pendingEvents(f.inst, nodeView(getNode(n.id)!)).events.length, 0, "the completed snapshot does report completion");
  } finally { f.close(); }
});

for (const kind of ["discussion", "review"] as const) test(`C3: whole-run listings keep ${kind} reply events`, () => {
  const f = fixture();
  try {
    const parent = f.node({ id: kind === "review" ? "r_00000001" : "d_00000001", kind, status: "open" });
    const part = f.node({ parent_id: parent.id });
    updateNode(part.id, { ended_at: Date.now() });
    if (kind === "review") updateNode(parent.id, { params_json: JSON.stringify({ discussion: "d_00000002" }) });
    const result = { nodes: [nodeView(getNode(parent.id)!, false), nodeView(part, false)] };
    const events = pendingEvents(f.inst, result).events;
    assert.equal(events.length, 1);
    assert.match(String(events[0].notice), /has a reply/);
  } finally { f.close(); }
});

test("C4: recursive temporary deletion runs after COMMIT, and a failed deletion is retryable", async (t) => {
  const f = fixture();
  const temp = path.join(f.home, "tmp");
  fs.mkdirSync(temp);
  process.env.TMPDIR = temp;
  try {
    const n = f.node();
    const dir = path.join(temp, "relay-tmp-retired");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "file"), "large tree");
    const st = fs.statSync(dir);
    const turn = insertTurn(n.id, "test", "test", "read", "done");
    db().prepare("UPDATE turns SET tmp_dir = ?, tmp_dev = ?, tmp_ino = ? WHERE id = ?").run(dir, st.dev, st.ino, turn);
    const rm = fs.rmSync;
    let checked = false;
    t.mock.method(fs, "rmSync", (file: fs.PathLike, opts: fs.RmOptions) => {
      if (String(file).startsWith(dir)) {
        checked = true;
        assert.equal(db().isTransaction, false, "recursive deletion must not hold the registry write lock");
        const writer = new DatabaseSync(path.join(f.home, "relay.db"));
        try { writer.exec("PRAGMA busy_timeout=20; BEGIN IMMEDIATE; COMMIT"); } finally { writer.close(); }
        throw new Error("injected removal failure");
      }
      return rm(file, opts);
    });
    const first = await sweepTemps();
    assert.ok(checked);
    assert.match(first.problems.join("\n"), /injected removal failure/);
    assert.equal(fs.existsSync(dir), false, "the verified directory was renamed before deletion");
    const aside = db().prepare("SELECT tmp_dir FROM turns WHERE id = ?").get(turn)!.tmp_dir as string;
    assert.ok(fs.existsSync(aside));
    // A process could also die after rename but before COMMIT: the recorded old identity is
    // sufficient to recover the aside directory, without trusting anything written inside it.
    db().prepare("UPDATE turns SET tmp_dir = ? WHERE id = ?").run(dir, turn);
    t.mock.restoreAll();
    assert.deepEqual((await sweepTemps()).removed, [aside]);
  } finally { t.mock.restoreAll(); f.close(); }
});

test("C4: a native turn's temp directory left renamed aside by a crash is found and removed", async () => {
  const f = fixture();
  try {
    const n = f.node();
    const dir = path.join(ensurePrivateRoot(nativeTempRoot()), "Ab12Cd.swept");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "file"), "left by a crash");
    const st = fs.statSync(dir);
    const turn = insertTurn(n.id, "test", "test", "read", "done");
    // The registry still names the directory before the rename: the crash came before COMMIT.
    db().prepare("UPDATE turns SET tmp_dir = ?, tmp_dev = ?, tmp_ino = ? WHERE id = ?").run(dir.slice(0, -6), st.dev, st.ino, turn);
    const swept = await sweepTemps();
    assert.deepEqual(swept.removed, [dir]);
    assert.equal(fs.existsSync(dir), false);
  } finally { f.close(); }
});

test("C4: registry rebuild is deferred for unrelated active runs and retried when idle", (t) => {
  const f = fixture();
  try {
    const erased = "FORGOTTEN-REBUILD-MARKER";
    const old = createRun(path.join(f.home, erased), withDefaults({}), "old");
    db().prepare("UPDATE runs SET root_cwd = ? WHERE id = ?").run(f.home, old);
    db().prepare("UPDATE runs SET root_pid = NULL, root_start = NULL, root_token = NULL WHERE id = ?").run(old);
    const exec = db().exec.bind(db());
    let vacuums = 0;
    t.mock.method(db(), "exec", (sql: string) => { if (sql === "VACUUM") vacuums++; return exec(sql); });
    const out = forgetOldRuns(7, { runIds: [old], at: Date.now() + 30 * 86400000 });
    assert.deepEqual(out.forgotten, [old]);
    assert.equal(vacuums, 0);
    assert.match(out.left.join("\n"), /deferred while runs are active/);
    assert.ok(fs.existsSync(path.join(f.home, "registry-rebuild")));
    db().prepare("UPDATE runs SET root_pid = NULL, root_start = NULL, root_token = NULL").run();
    forgetOldRuns(7, { runIds: [] });
    assert.equal(vacuums, 1, "the pending rebuild runs even without another forgotten run");
    assert.equal(fs.existsSync(path.join(f.home, "registry-rebuild")), false);
    for (const name of ["relay.db", "relay.db-wal"]) {
      const file = path.join(f.home, name);
      if (fs.existsSync(file)) assert.equal(fs.readFileSync(file).includes(erased), false, `${name} no longer holds forgotten records after the idle rebuild`);
    }
  } finally { t.mock.restoreAll(); f.close(); }
});

test("C5: an undelivered approval interrupts the next wait; delivered handoffs do not hide notices", async () => {
  const f = fixture();
  try {
    const n = f.node({ status: "running" });
    db().prepare("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES ('q_00000001', ?, ?, 'command', 'test', 'pending', ?)").run(f.run, n.id, Date.now());
    const opts = { root: { inst: f.inst, runId: f.run }, lender: null, ms: 5000 };
    assert.equal(await waitUntil(() => false, opts), false);
    assert.equal(f.inst.handedOff.has("q_00000001"), false, "returning from a wait has not delivered its result");
    assert.equal(await waitUntil(() => false, opts), false, "a replacement wait must return for the undelivered request");
    assert.equal(pendingEvents(f.inst, { id: n.id, status: "running" }).events.length, 1, "a job snapshot omitting a new approval must still carry its event");
    f.inst.handedOff.add("q_00000001");
    f.inst.waiting.set(1, { runId: f.run, items: new Set([n.id]) });
    const notices: string[] = [];
    f.inst.host.notice = (text) => notices.push(text);
    watch(f.inst);
    assert.equal(notices.length, 1, "a wait which already handed this request off cannot cover its notice");
  } finally { f.close(); }
});

test("C6: a review start rolls back all rows on binding failure and returns its handle on dispatch failure", async () => {
  const f = fixture();
  try {
    db().exec("CREATE TRIGGER fail_binding BEFORE UPDATE OF node_id ON calls BEGIN SELECT RAISE(ABORT, 'binding failed'); END");
    await assert.rejects(review(f.inst, { target: "README.md", reviewer: "claude", request_id: "atomic" }), /binding failed/);
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM nodes").get()!.n, 0);
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM turns").get()!.n, 0);
    db().exec("DROP TRIGGER fail_binding; CREATE TRIGGER fail_worker BEFORE UPDATE OF worker_pid ON nodes WHEN NEW.worker_pid = -1 BEGIN SELECT RAISE(ABORT, 'no worker'); END");
    const r = await review(f.inst, { target: "README.md", reviewer: "claude", request_id: "atomic" });
    assert.match(String(r.review_id), /^r_/);
    assert.match(String(r.warning), /could not start.*no worker/);
    const p = JSON.parse(getNode(r.review_id)!.params_json!);
    assert.equal(p.reviewer, r.reviewer_job);
    assert.equal(db().prepare("SELECT node_id FROM calls WHERE request_id = 'atomic'").get()!.node_id, r.review_id);
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM turns WHERE node_id = ?").get(r.reviewer_job)!.n, 1);
  } finally { f.close(); }
});

test("C8: a launched Grok caller's actual harness and node state are denied to an independent reviewer", async () => {
  const f = fixture({ targets: { grok: { enabled: true, experimental: true } } });
  try {
    const n = f.node({ target: "grok", model: "grok-4.6", allow_delegation: 1, status: "running" });
    const turnId = insertTurn(n.id, "test", "test", "read", "running");
    f.inst.ctx = { kind: "child", runId: f.run, nodeId: n.id, turnId, depth: 1, access: "read", mayDelegate: true, mayAsk: true };
    db().exec("CREATE TRIGGER fail_worker BEFORE UPDATE OF worker_pid ON nodes WHEN NEW.worker_pid = -1 BEGIN SELECT RAISE(ABORT, 'no worker'); END");
    const r = await review(f.inst, { target: "README.md", reviewer: "claude" });
    const denied = JSON.parse(getNode(r.review_id)!.params_json!).caller_transcripts;
    assert.ok(denied.includes(path.join(harnessHome(), f.run, n.id)));
    assert.ok(denied.includes(nodeDir(f.run, n.id)));
    assert.ok(denied.includes(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")));
    assert.ok(denied.includes(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")));
  } finally { f.close(); }
});

for (const target of TARGETS) test(`C10: ${target.id}'s native resume treats session ids as one shell argument`, () => {
  const id = "session 'quoted'; printf INJECTED; #\n$(printf SUBSTITUTION)";
  const command = target.resumeCommand(id, { harnessState: "/scratch/state with 'quotes'" });
  const prefix = "claude() { printf '%s\\0' \"$@\"; }; codex() { printf '%s\\0' \"$@\"; }; copilot() { printf '%s\\0' \"$@\"; }; gemini() { printf '%s\\0' \"$@\"; }; grok() { printf '%s\\0' \"$@\"; }; cat() { :; }; ";
  const out = spawnSync("/bin/sh", ["-c", prefix + command], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const args = out.stdout.split("\0").filter(Boolean);
  assert.ok(args.includes(id) || args.includes(`--resume=${id}`), JSON.stringify(args));
  assert.ok(!args.includes("INJECTED"));
});

test("C11: the Copilot policy comment describes unknown model labels", () => {
  const copilot = fs.readFileSync(path.join(import.meta.dirname, "../src/targets/copilot.ts"), "utf8");
  assert.match(copilot, /unlisted models are accepted with an unknown family label/);
});

test("C12: the ask_user policy comment requires qualified dialogs", () => {
  const config = fs.readFileSync(path.join(import.meta.dirname, "../src/core/config.ts"), "utf8");
  assert.match(config, /"always": still requires a host qualified to show approval dialogs/);
});
