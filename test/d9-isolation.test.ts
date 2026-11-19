// D9 in 1.0: conversations on one shared relay connection, separated by the session token each
// model carries (docs/d9-isolation-plan.md). Every test here drives several conversations over ONE
// MCP connection, as the Claude desktop app does; two server processes would not reproduce it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { test } from "node:test";
import {
  alive, conversationOn, DESKTOP_CHATS, harness, scratchOnly, SESSION_UNAVAILABLE_REPLY, task, terminalAdoption, until, UNAVAILABLE_REPLY,
} from "./helpers.ts";

const TOKEN = /^rs1_[0-9a-f]{56}$/;
const counts = (h: { sql(q: string, ...p: unknown[]): any[] }) =>
  Object.fromEntries(["runs", "nodes", "calls", "requests"].map((t) => [t, h.sql(`SELECT COUNT(*) AS c FROM ${t}`)[0].c]));

test("D9 isolation: two conversations on one shared connection cannot see or touch each other's items", async () => {
  const h = await harness([{ match: task("PRIVATE"), steps: [{ request: "private-command" }, { reply: "ok" }] }]);
  try {
    const shared = await h.instance(DESKTOP_CHATS);
    const a = await conversationOn(shared), b = await conversationOn(shared);
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.fingerprint, b.fingerprint);
    const cwd = h.repo;
    const job = await a.call("delegate", { target: "codex", task: "PRIVATE", mode: "write", cwd });
    const waiting = await a.call("status", { id: job.job_id, wait_s: 20 });
    const request = waiting.needs_approval[0].request_id;
    const run = job.run_id;
    const thread = await a.call("ask", { target: "codex", message: "private thread", cwd });
    const discussion = await a.call("discuss", { target: "codex", topic: "private", message: "hello\nCONTINUE", cwd });
    const review = await a.call("review", { reviewer: "codex", target: "README.md", cwd });
    for (const id of [thread.thread_id, discussion.discussion_id, review.review_id]) assert.equal(h.sql("SELECT run_id FROM nodes WHERE id = ?", id)[0].run_id, run, "one conversation, one run");
    for (const [tool, field, id, rest] of [
      ["status", "id", job.job_id, {}], ["status", "id", run, {}],
      ["result", "job_id", job.job_id, {}], ["resume", "job_id", job.job_id, { message: "continue" }],
      ["cancel", "id", job.job_id, {}], ["cancel", "id", run, {}],
      ["merge", "job_id", job.job_id, { cwd }],
      ["approve", "request_id", request, { decision: "allow", user_confirmed: true }],
      ["approve", "request_id", request, { decision: "deny" }],
      ["ask", "thread_id", thread.thread_id, { message: "continue" }],
      ["discuss", "discussion_id", discussion.discussion_id, { message: "continue\nCONTINUE" }],
      ["discuss", "with", job.job_id, { topic: "borrow", message: "hello\nCONTINUE", cwd }],
      ["review", "review_id", review.review_id, { own_review: "private" }],
      ["status", "id", review.reviewer_job, {}],
    ] as const) {
      assert.ok(id, `${tool}.${field}: fixture exists`);
      const foreign = await b.call(tool, { ...rest, [field]: id });
      const unknown = await b.call(tool, { ...rest, [field]: field === "request_id" ? "q_00000000" : "j_00000000" });
      assert.deepEqual(foreign, UNAVAILABLE_REPLY, `${tool}.${field}`);
      assert.deepEqual(foreign, unknown, `${tool}.${field}: no existence oracle`);
    }
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", request)[0].status, "pending");
    assert.notEqual(h.sql("SELECT status FROM nodes WHERE id = ?", job.job_id)[0].status, "cancelled");
    assert.equal(h.sql("SELECT status FROM runs WHERE id = ?", run)[0].status, "active");
    // B sees only its own scope, and its work goes into a run of its own.
    assert.deepEqual((await b.call("status")).nodes, []);
    const own = await b.call("delegate", { target: "codex", task: "B's work", mode: "read", background: false, cwd });
    assert.equal(own.status, "done");
    assert.notEqual(own.run_id, run);
    assert.deepEqual((await b.call("status")).nodes.map((n: any) => n.id), [own.job_id]);
    assert.ok((await a.call("status")).nodes.some((n: any) => n.id === job.job_id));
    // A conversation still decides its own requests.
    await a.call("approve", { request_id: request, decision: "deny" });
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", request)[0].status, "denied");
  } finally { await h.close(); }
});

test("D9 isolation: events and request_ids stay with their conversation", async () => {
  const h = await harness();
  try {
    const shared = await h.instance(DESKTOP_CHATS);
    const a = await conversationOn(shared), b = await conversationOn(shared);
    const cwd = h.repo;
    // The same request_id from two conversations starts two jobs; an exact retry replays.
    const args = { target: "codex", task: "same id", mode: "read", background: false, request_id: "1", cwd };
    const first = await a.call("delegate", args), other = await b.call("delegate", args), again = await a.call("delegate", args);
    assert.notEqual(first.job_id, other.job_id);
    assert.equal(again.job_id, first.job_id);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes")[0].c, 2);
    assert.equal(h.sql("SELECT COUNT(DISTINCT scope) AS c FROM calls")[0].c, 2);
    // News of A's run waits for A: B's replies neither carry nor acknowledge it.
    const late = await a.call("delegate", { target: "codex", task: "late news", mode: "read", cwd });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events WHERE subject = ? AND seen_at IS NULL", late.job_id)[0].c > 0, 20000, "A's settled event");
    for (const [tool, args] of [["status", {}], ["result", { job_id: other.job_id }], ["brief", { target: "codex" }], ["status", { id: late.job_id }]] as const) {
      const reply = tool === "brief" ? await shared.call(tool, args) : await b.call(tool, args);
      assert.equal(JSON.stringify(reply.events ?? []).includes(late.job_id), false, tool);
    }
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM events WHERE subject = ? AND seen_at IS NULL", late.job_id)[0].c, 1, "B consumed nothing of A's");
    const delivered = await a.call("result", { job_id: first.job_id });
    assert.ok(delivered.events?.some((e: any) => e.about === late.job_id), JSON.stringify(delivered.events));
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events WHERE subject = ? AND seen_at IS NULL", late.job_id)[0].c === 0, 5000, "acknowledged on delivery");
  } finally { await h.close(); }
});

test("D9 isolation: a call without a token gets a fresh scope or does nothing, and is told to carry one", async () => {
  const h = await harness();
  try {
    const shared = await h.instance(DESKTOP_CHATS);
    const fresh = await shared.call("status");
    assert.equal(fresh.run_id, null);
    assert.deepEqual(fresh.nodes, []);
    assert.match(fresh.new_session.token, TOKEN);
    assert.match(fresh.new_session.carry, /session_token, exactly, on every later relay call/);
    assert.match(fresh.note, /^If this conversation already has a session_token from relay, call again with that one \(this new token has none of its work\); otherwise use new_session\.token/);
    assert.deepEqual({ scope: fresh.session.scope, source: fresh.session.source, topology: fresh.session.topology }, { scope: "conversation-token", source: "session-token", topology: "shared" });
    assert.match(fresh.session.reason, /bearer key/);
    const second = await shared.call("status");
    assert.notEqual(second.new_session.token, fresh.new_session.token, "each token-less call gets a fresh scope");
    assert.notEqual(second.session.fingerprint, fresh.session.fingerprint);
    assert.deepEqual(counts(h), { runs: 0, nodes: 0, calls: 0, requests: 0 });

    const a = await conversationOn(shared);
    const job = await a.call("delegate", { target: "codex", task: "exists", mode: "read", background: false, cwd: h.repo });
    const before = counts(h);
    const shape = (r: any) => ({ ...r, new_session: { ...r.new_session, token: TOKEN.test(r.new_session?.token) ? "<token>" : r.new_session?.token } });
    let reference: unknown;
    for (const [tool, args] of [
      ["delegate", { target: "codex", task: "nothing", mode: "read", cwd: h.repo, request_id: "r" }], ["ask", { target: "codex", message: "nothing", cwd: h.repo }],
      ["discuss", { target: "codex", topic: "t", message: "m\nCONTINUE", cwd: h.repo }], ["review", { reviewer: "codex", target: "README.md", cwd: h.repo }],
      ["status", { id: job.job_id }], ["status", { id: "j_00000000" }], ["status", { id: job.job_id, wait_s: 5 }], ["status", { notice: { event_id: 1, tag: "0".repeat(32) } }],
      ["result", { job_id: job.job_id }], ["result", { job_id: "j_00000000" }], ["resume", { job_id: job.job_id, message: "go" }],
      ["cancel", { id: job.run_id }], ["merge", { job_id: job.job_id, cwd: h.repo }], ["approve", { request_id: "q_00000000", decision: "deny" }],
      ["adopt", { run_id: job.run_id, into_session: a.fingerprint }],
    ] as const) {
      const r = await shared.call(tool, args);
      assert.equal(r.session_required, true, `${tool}: ${JSON.stringify(r)}`);
      assert.match(r.new_session.token, TOKEN);
      assert.match(r.reason, /This call had none, so relay did nothing\. If this conversation already has a session_token from relay, call again with that one/);
      reference ??= shape(r);
      assert.deepEqual(shape(r), reference, `${tool}: the reply depends on nothing the call names`);
    }
    assert.deepEqual(counts(h), before, "nothing looked up, claimed or started");
    // Every scoped tool takes the token; brief, which reads no work, does not.
    const tools = await shared.toolDefinitions();
    for (const t of tools) assert.equal(Boolean(t.inputSchema.properties?.session_token), t.name !== "brief", t.name);
    assert.equal((await shared.call("brief", { target: "codex" })).target, "codex");
  } finally { await h.close(); }
});

test("D9 isolation: forged, mistyped and other relay homes' tokens get one generic reply", async () => {
  const h = await harness();
  const other = await harness();
  try {
    const shared = await h.instance(DESKTOP_CHATS);
    const a = await conversationOn(shared);
    const job = await a.call("delegate", { target: "codex", task: "mine", mode: "read", background: false, cwd: h.repo });
    const elsewhere = (await conversationOn(await other.instance(DESKTOP_CHATS))).token;
    const flip = (t: string) => t.slice(0, -1) + (t.endsWith("0") ? "1" : "0");
    const before = counts(h);
    for (const token of [elsewhere, flip(a.token), a.token.slice(0, -2), a.token.toUpperCase(), `rs1_${"0".repeat(56)}`, `${a.token} `, "not-a-token", ""]) {
      for (const [tool, args] of [
        ["status", {}], ["status", { id: job.job_id }], ["status", { id: "j_00000000" }], ["result", { job_id: job.job_id }],
        ["delegate", { target: "codex", task: "forged", mode: "read", cwd: h.repo }], ["approve", { request_id: "q_00000000", decision: "deny" }],
        ["adopt", { run_id: job.run_id, into_session: a.fingerprint }], ["cancel", { id: job.run_id }],
      ] as const) {
        assert.deepEqual(await shared.call(tool, { ...args, session_token: token }), SESSION_UNAVAILABLE_REPLY, `${tool} with ${token.slice(0, 12)}…`);
      }
    }
    assert.deepEqual(counts(h), before);
    assert.equal((await a.call("result", { job_id: job.job_id })).status, "done", "the real token still works");
  } finally { await h.close(); await other.close(); }
});

test("D9 isolation: a token keeps its runs across a restart; adoption needs the person's terminal step", async () => {
  const h = await harness();
  try {
    const first = await h.instance(DESKTOP_CHATS);
    const a = await conversationOn(first);
    const job = await a.call("delegate", { target: "codex", task: "survives", mode: "read", background: false, cwd: h.repo });
    const run = job.run_id;
    const pid1 = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid;
    await first.close(); await until(() => !alive(pid1));

    // The app restarts its relay: the conversation carries on by its token, without adoption.
    const second = await h.instance(DESKTOP_CHATS);
    const again = (tool: string, args: Record<string, unknown> = {}) => second.call(tool, { ...args, session_token: a.token });
    assert.equal((await again("result", { job_id: job.job_id })).status, "done");
    const tree = await again("status");
    assert.equal(tree.run_id, run, "it goes on in its run");
    assert.equal(tree.session.fingerprint, a.fingerprint, "the fingerprint is the token's, not the process's");
    const pid2 = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid;
    assert.notEqual(pid2, pid1);
    assert.ok(alive(pid2), "the live process took over the run's lease");
    assert.equal((await again("resume", { job_id: job.job_id, message: "more" })).status, "queued");
    await again("status", { id: job.job_id, wait_s: 20 });
    await second.close(); await until(() => !alive(pid2));

    // The token is lost: a new conversation gets the run only through the person's terminal step.
    const third = await h.instance(DESKTOP_CHATS);
    const b = await conversationOn(third), c = await conversationOn(third);
    for (const args of [{}, { user_confirmed: true }, { in_directory: h.repo, item_count: 1 }]) {
      assert.deepEqual(await b.call("adopt", { run_id: run, into_session: b.fingerprint, ...args }), UNAVAILABLE_REPLY, "no ticket, no transfer");
    }
    assert.deepEqual(await b.call("result", { job_id: job.job_id }), UNAVAILABLE_REPLY);
    const terminal = terminalAdoption(h, job.job_id, b.fingerprint);
    assert.equal(terminal.status, 0, `${terminal.stdout}\n${terminal.stderr}`);
    assert.deepEqual(await c.call("adopt", { run_id: run, into_session: b.fingerprint }), UNAVAILABLE_REPLY, "another conversation cannot take up B's ticket");
    assert.deepEqual(await c.call("adopt", { run_id: run, into_session: c.fingerprint }), UNAVAILABLE_REPLY);
    const adopted = await b.call("adopt", { run_id: run, into_session: b.fingerprint });
    assert.equal(adopted.adopted, true, JSON.stringify(adopted));
    assert.equal((await b.call("result", { job_id: job.job_id })).status, "done");
    assert.deepEqual(await third.call("result", { job_id: job.job_id, session_token: a.token }), UNAVAILABLE_REPLY, "the old token lost the run it handed over");
    assert.deepEqual(await c.call("status", { id: run }), UNAVAILABLE_REPLY);
  } finally { await h.close(); }
});

test("D9 isolation: relay stores no raw token and refuses to pass one on", async () => {
  const h = await harness();
  try {
    const shared = await h.instance(DESKTOP_CHATS);
    const a = await conversationOn(shared);
    const job = await a.call("delegate", { target: "codex", task: "plain", mode: "read", background: false, cwd: h.repo, request_id: "stored" });
    await a.call("ask", { target: "codex", message: "plain", cwd: h.repo });
    // The caller snapshot names where the scope came from, never the token.
    const snapshot = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json).caller_snapshots[0];
    assert.deepEqual({ scope: snapshot.session.scope, source: snapshot.session.source, assurance: snapshot.session.assurance }, { scope: "conversation-token", source: "session-token", assurance: "relay-capability" });
    assert.ok(snapshot.session.evidence.includes("argument:session_token"));
    const before = counts(h);
    for (const [tool, args] of [
      ["delegate", { target: "codex", task: `use ${a.token}`, mode: "read", cwd: h.repo }],
      ["ask", { target: "codex", message: "x", context: [`/tmp/${a.token}`], cwd: h.repo }],
      ["resume", { job_id: job.job_id, message: `token ${a.token}` }],
    ] as const) {
      const r = await a.call(tool, args);
      assert.equal(r.refused, true, `${tool}: ${JSON.stringify(r)}`);
      assert.match(r.reason, /holds a session token/);
    }
    assert.deepEqual(counts(h), before);
    // Neither the registry nor anything else under relay's home holds the token.
    const dump = JSON.stringify(["runs", "nodes", "turns", "calls", "events", "requests"].map((t) => h.sql(`SELECT * FROM ${t}`)));
    assert.equal(dump.includes(a.token), false);
    assert.equal(dump.includes(a.token.slice(4)), false);
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
    });
    for (const file of walk(h.home)) assert.equal(fs.readFileSync(file).includes(a.token.slice(4)), false, file);
    assert.equal(fs.statSync(path.join(h.home, "session.key")).mode & 0o777, 0o600);
    fs.unlinkSync(path.join(h.home, "session.key"));
    assert.deepEqual(await a.call("status"), SESSION_UNAVAILABLE_REPLY, "deleting the key revokes every token, in a running process too");
  } finally { await h.close(); }
});

test("D9 isolation: dedicated and unknown deployments are unchanged; a Cowork client without --desktop is shared", async () => {
  const h = await harness();
  try {
    for (const [opts, topology] of [[{ args: ["--host", "codex"] }, "dedicated"], [{ host: null, clientInfo: { name: "some-editor", version: "1" } }, "unknown"]] as const) {
      const root = await h.instance(opts as never);
      for (const t of await root.toolDefinitions()) assert.equal(t.inputSchema.properties?.session_token, undefined, `${topology}: ${t.name}`);
      const status = await root.call("status");
      assert.equal(status.session.topology, topology);
      assert.equal(status.new_session, undefined);
      // An unadvertised session_token is dropped: the call behaves as without it.
      const args = { target: "claude", task: `dropped ${topology}`, mode: "read", background: false, request_id: `drop-${topology}` };
      const job = await root.call("delegate", { ...args, session_token: "rs1_ignored" });
      assert.ok(job.job_id, JSON.stringify(job));
      assert.equal((await root.call("delegate", { ...args, session_token: "another" })).job_id, job.job_id, "and never enters the request_id match");
      assert.equal((await root.call("result", { job_id: job.job_id })).status, "done");
    }
    assert.equal(fs.existsSync(path.join(h.home, "session.key")), false, "no key without a shared deployment");

    const cowork = await h.instance({ args: ["--host", "claude"], clientInfo: { name: "local-agent-mode-relay-desktop", version: "2.42304.0" }, cwd: "/" });
    const tools = await cowork.toolDefinitions();
    assert.ok(tools.find((t) => t.name === "delegate")!.inputSchema.properties.session_token);
    const a = await conversationOn(cowork);
    const job = await a.call("delegate", { target: "codex", task: "cowork", mode: "read", background: false, cwd: h.repo });
    assert.equal(job.status, "done");
    assert.deepEqual(await (await conversationOn(cowork)).call("status", { id: job.job_id }), UNAVAILABLE_REPLY);
  } finally { await h.close(); }
});

test("D9 isolation: only a shared relay's instructions teach the model to carry its token", async () => {
  const { relayServer } = await import("../dist/mcp/server.js");
  const { newInstance } = await import("../dist/core/caller.js");
  const tmp = scratchOnly(fs.mkdtempSync(path.join(os.tmpdir(), "relay-d9-texts-")));
  const saved = { home: process.env.RELAY_HOME, config: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = tmp;
  process.env.RELAY_CONFIG = path.join(tmp, "config.json");
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ allow_temp_home: true }));
  const instructions = async (desktop: boolean, name: string) => {
    const server = relayServer(newInstance({ kind: "root" }, tmp, "claude"), { desktop });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name, version: "2.42304.0" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const text = c.getInstructions() ?? "";
    await c.close();
    return text;
  };
  try {
    for (const [desktop, name, carries] of [[true, "claude.ai", true], [false, "local-agent-mode-relay-desktop", true], [false, "claude-code", false], [false, "some-editor", false]] as const) {
      const text = await instructions(desktop, name);
      assert.equal(/pass that token as session_token on every later relay call/.test(text), carries, `${name}: ${text.slice(-300)}`);
    }
  } finally {
    if (saved.home === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = saved.home;
    if (saved.config === undefined) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = saved.config;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Review r_d0587186 (discussion d_973fadc8): diagnostics, brokers across restarts, view pinning,
// the prefer-your-own-token wording and token-shaped output.

const workerGone = (h: { sql(q: string, ...p: unknown[]): any[] }, id: string) => {
  const pid = h.sql("SELECT worker_pid FROM nodes WHERE id = ?", id)[0]?.worker_pid;
  return pid === null || (pid > 0 && !alive(pid));
};

test("D9 isolation: a worker.log failure is said only to the conversation that owns the run", async () => {
  const h = await harness([{ match: "HOLD-DIAGNOSTIC", steps: [{ awaitMark: "diagnostic" }, { reply: "held" }] }]);
  try {
    const shared = await h.instance(DESKTOP_CHATS);
    const a = await conversationOn(shared), b = await conversationOn(shared);
    const thread = await a.call("ask", { target: "codex", message: "first", cwd: h.repo });
    await until(() => workerGone(h, thread.thread_id), 20000, "the thread's worker to finish");
    // A worker.log that cannot be opened: its failure names A's run and thread.
    const log = path.join(h.home, "runs", thread.run_id, "nodes", thread.thread_id, "worker.log");
    fs.rmSync(log, { force: true });
    fs.mkdirSync(log);
    const pending = a.call("ask", { thread_id: thread.thread_id, message: "HOLD-DIAGNOSTIC" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM turns WHERE node_id = ? AND status = 'running'", thread.thread_id)[0].c === 1, 20000, "A's held turn");
    const names = (r: any) => JSON.stringify(r.warnings ?? []).includes(thread.thread_id);
    for (const reply of [await b.call("status"), await shared.call("brief", { target: "codex" }), await b.call("delegate", { target: "codex", task: "B", mode: "read", cwd: h.repo })]) {
      assert.equal(names(reply), false, JSON.stringify(reply.warnings));
    }
    h.mark("diagnostic");
    const delivered = await pending;
    assert.ok(names(delivered), `A hears of its own run's log: ${JSON.stringify(delivered)}`);
  } finally { await h.close(); }
});

test("D9 isolation: a worker that outlives a restart reaches the new process's broker for its next turn", async () => {
  const h = await harness([{ match: task("SURVIVE"), turn: 1, steps: [{ awaitMark: "first-turn" }, { reply: "first" }] }]);
  try {
    const first = await h.instance(DESKTOP_CHATS);
    const a = await conversationOn(first);
    const job = await a.call("delegate", { target: "codex", task: "SURVIVE", mode: "read", cwd: h.repo });
    // The agent is running (its turn's environment came from the first root's broker) and held.
    await until(() => h.starts().length === 1, 20000, "the first turn's agent");
    const worker = h.sql("SELECT worker_pid FROM nodes WHERE id = ?", job.job_id)[0].worker_pid;
    const pid1 = h.sql("SELECT root_pid FROM runs WHERE id = ?", job.run_id)[0].root_pid;
    await first.close(); await until(() => !alive(pid1));
    assert.ok(alive(worker), "the detached worker outlives its root");

    const second = await h.instance(DESKTOP_CHATS);
    const again = (tool: string, args: Record<string, unknown> = {}) => second.call(tool, { ...args, session_token: a.token });
    const queued = await again("resume", { job_id: job.job_id, message: "the next turn" });
    assert.equal(queued.error ?? queued.refused, undefined, JSON.stringify(queued));
    assert.equal(h.sql("SELECT worker_pid FROM nodes WHERE id = ?", job.job_id)[0].worker_pid, worker, "the same worker carries on");
    h.mark("first-turn");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM turns WHERE node_id = ? AND status NOT IN ('queued', 'running')", job.job_id)[0].c === 2, 30000, "both turns to settle");
    assert.deepEqual(h.sql("SELECT status, error FROM turns WHERE node_id = ? ORDER BY id", job.job_id).map((t) => t.status), ["done", "done"],
      JSON.stringify(h.sql("SELECT error FROM turns WHERE node_id = ?", job.job_id)));
    assert.equal((await again("status", { id: job.job_id })).status, "done");
  } finally { await h.close(); }
});

test("D9 isolation: after a restart, status on recovered work opens the conversation's broker before redispatching", async () => {
  const h = await harness();
  try {
    const first = await h.instance(DESKTOP_CHATS);
    const a = await conversationOn(first);
    const job = await a.call("delegate", { target: "codex", task: "stalled", mode: "read", background: false, cwd: h.repo });
    await until(() => workerGone(h, job.job_id), 20000, "the worker to finish");
    const pid1 = h.sql("SELECT root_pid FROM runs WHERE id = ?", job.run_id)[0].root_pid;
    await first.close(); await until(() => !alive(pid1));
    // Work a call committed and then could not start, as a restart between the two leaves it.
    h.sql("INSERT INTO turns (node_id, source, body, access, status, created_at) VALUES (?, 'caller', 'stalled turn', 'read', 'queued', ?)", job.job_id, Date.now());
    h.sql("UPDATE nodes SET status = 'queued', ended_at = NULL, worker_pid = NULL, worker_start = NULL WHERE id = ?", job.job_id);
    const second = await h.instance(DESKTOP_CHATS);
    await second.call("status", { id: job.job_id, session_token: a.token });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM turns WHERE node_id = ? AND status NOT IN ('queued', 'running')", job.job_id)[0].c === 2, 30000, "the stalled turn to run");
    assert.deepEqual(h.sql("SELECT status FROM turns WHERE node_id = ? ORDER BY id", job.job_id).map((t) => t.status), ["done", "done"],
      JSON.stringify(h.sql("SELECT error FROM turns WHERE node_id = ?", job.job_id)));
  } finally { await h.close(); }
});

test("D9 isolation: an idle conversation's broker is closed, and opened again when wanted", async () => {
  const h = await harness();
  try {
    const shared = await h.instance(DESKTOP_CHATS);
    const a = await conversationOn(shared);
    const brokers = () => (fs.existsSync(path.join(h.home, "brokers")) ? fs.readdirSync(path.join(h.home, "brokers")).filter((f) => f.endsWith(".json")) : []);
    const job = await a.call("delegate", { target: "codex", task: "one", mode: "read", background: false, cwd: h.repo });
    assert.equal(job.status, "done");
    assert.equal(brokers().length, 1, "published while open");
    await until(() => workerGone(h, job.job_id) && brokers().length === 0, 30000, "the idle broker to close");
    const next = await a.call("delegate", { target: "codex", task: "two", mode: "read", background: false, cwd: h.repo });
    assert.equal(next.status, "done", JSON.stringify(next));
  } finally { await h.close(); }
});

test("D9 isolation: a pinned view is never evicted, so a conversation never has two", async () => {
  const tmp = scratchOnly(fs.mkdtempSync(path.join(os.tmpdir(), "relay-d9-views-")));
  const saved = process.env.RELAY_HOME;
  process.env.RELAY_HOME = tmp;
  try {
    const { SessionViews } = await import("../dist/core/session-token.js");
    const { newInstance } = await import("../dist/core/caller.js");
    const views = new SessionViews(newInstance({ kind: "root" }, tmp, "claude"), 2);
    const one = views.acquire("a".repeat(64));
    for (const owner of ["b", "c", "d"]) views.release(views.acquire(owner.repeat(64)));
    assert.equal(views.acquire("a".repeat(64)), one, "the view in use was kept");
    assert.ok(views.inUse("a".repeat(64)));
    views.release(one); views.release(one);
    assert.equal(views.inUse("a".repeat(64)), false);
    for (const owner of ["e", "f"]) views.release(views.acquire(owner.repeat(64)));
    assert.notEqual(views.acquire("a".repeat(64)), one, "an idle view may be evicted, and is rebuilt");
  } finally {
    const { closeDbForTests } = await import("../dist/core/db.js");
    closeDbForTests();
    if (saved === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("D9 isolation: token-shaped text is refused in any case and cut from agents' output", async () => {
  const fake = `rs1_${"ab".repeat(28)}`;
  const h = await harness([{ match: task("ECHO"), steps: [{ reply: `lower ${fake} upper ${fake.toUpperCase()}` }] }]);
  try {
    const shared = await h.instance(DESKTOP_CHATS);
    const a = await conversationOn(shared);
    for (const text of [a.token.toUpperCase(), `x${a.token}y`]) {
      const r = await a.call("delegate", { target: "codex", task: text, mode: "read", cwd: h.repo });
      assert.equal(r.refused, true, JSON.stringify(r));
    }
    const job = await a.call("delegate", { target: "codex", task: "ECHO", mode: "read", background: false, cwd: h.repo });
    const result = await a.call("result", { job_id: job.job_id });
    const hex = /ab{1}(?:ab){27}/i;
    assert.equal(hex.test(JSON.stringify(result)), false, JSON.stringify(result));
    assert.match(JSON.stringify(result), /\[redacted\]/);
    const dump = JSON.stringify(["nodes", "turns", "events"].map((t) => h.sql(`SELECT * FROM ${t}`)));
    assert.equal(hex.test(dump), false);
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
    });
    for (const file of walk(path.join(h.home, "runs"))) assert.equal(hex.test(fs.readFileSync(file, "utf8")), false, file);
  } finally { await h.close(); }
});
