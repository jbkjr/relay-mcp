// OpenCode 2 as a host: one relay process serves every session of OpenCode's background service,
// and OpenCode stamps each tool call with its session (_meta["ai.opencode/sessionID"], seen on
// 2.1.4). Each test drives several sessions over ONE MCP connection, as OpenCode does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, task, terminalAdoption, until, UNAVAILABLE_REPLY } from "./helpers.ts";

const OPENCODE = { clientInfo: { name: "opencode", version: "2.1.4" } };
const session = (id: string) => ({ meta: { "ai.opencode/sessionID": id, progressToken: 1 } });
/** Rows in the registry's work tables; none when nothing has opened it. */
const counts = (h: { sql(q: string, ...p: unknown[]): any[] }) =>
  Object.fromEntries(["runs", "nodes", "calls", "requests"].map((t) => {
    try { return [t, h.sql(`SELECT COUNT(*) AS c FROM ${t}`)[0].c]; } catch (err) { if (/no such table/.test(String(err))) return [t, 0]; throw err; }
  }));

test("OpenCode 2: two sessions on one connection cannot see or touch each other's items", async () => {
  const h = await harness([{ match: task("PRIVATE"), steps: [{ request: "private-command" }, { reply: "ok" }] }]);
  try {
    const oc = await h.instance(OPENCODE);
    const a = (tool: string, args: Record<string, unknown> = {}) => oc.call(tool, args, session("ses_A"));
    const b = (tool: string, args: Record<string, unknown> = {}) => oc.call(tool, args, session("ses_B"));
    const job = await a("delegate", { target: "codex", task: "PRIVATE", mode: "write" });
    assert.equal(job.families.caller, "unknown", "OpenCode's family is the model's, which relay cannot see");
    const waiting = await a("status", { id: job.job_id, wait_s: 20 });
    const request = waiting.needs_approval[0].request_id;
    const thread = await a("ask", { target: "codex", message: "private thread" });
    assert.equal(h.sql("SELECT run_id FROM nodes WHERE id = ?", thread.thread_id)[0].run_id, job.run_id, "one session, one run");
    for (const [tool, field, id, rest] of [
      ["status", "id", job.job_id, {}], ["status", "id", job.run_id, {}],
      ["result", "job_id", job.job_id, {}], ["resume", "job_id", job.job_id, { message: "continue" }],
      ["cancel", "id", job.job_id, {}], ["merge", "job_id", job.job_id, {}],
      ["approve", "request_id", request, { decision: "allow", user_confirmed: true }],
      ["approve", "request_id", request, { decision: "deny" }],
      ["ask", "thread_id", thread.thread_id, { message: "continue" }],
    ] as const) {
      assert.deepEqual(await b(tool, { ...rest, [field]: id }), UNAVAILABLE_REPLY, `${tool}.${field}`);
    }
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", request)[0].status, "pending");
    const mine = await b("status");
    assert.deepEqual(mine.nodes, [], "B's plain status lists nothing of A's");
    assert.notEqual(mine.run_id, job.run_id);
    assert.deepEqual({ scope: mine.session.scope, source: mine.session.source, topology: mine.session.topology }, { scope: "host-session", source: "host-key", topology: "shared" });
    const theirs = await a("status");
    assert.notEqual(theirs.session.fingerprint, mine.session.fingerprint);
    assert.equal(theirs.run_id, job.run_id);
    // B's own work is B's: a separate run, and A cannot read it.
    const other = await b("delegate", { target: "codex", task: "B's own", mode: "read", background: false });
    assert.notEqual(other.run_id, job.run_id);
    assert.deepEqual(await a("result", { job_id: other.job_id }), UNAVAILABLE_REPLY);
    const snapshot = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", other.job_id)[0].params_json).caller_snapshots.at(-1);
    assert.equal(snapshot.session.assurance, "host-correlation");
    assert.ok(snapshot.session.evidence.includes("ai.opencode/sessionID"));
    assert.equal(JSON.stringify(snapshot).includes("ses_B"), false, "the raw session ID stays out of the record");
    // A's decision still reaches A's job.
    await a("approve", { request_id: request, decision: "deny" });
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", request)[0].status, "denied");
  } finally { await h.close(); }
});

test("OpenCode 2: B's replies neither carry nor acknowledge A's events", async () => {
  const h = await harness();
  try {
    const oc = await h.instance(OPENCODE);
    const a = (tool: string, args: Record<string, unknown> = {}) => oc.call(tool, args, session("ses_A"));
    const b = (tool: string, args: Record<string, unknown> = {}) => oc.call(tool, args, session("ses_B"));
    const own = await b("delegate", { target: "codex", task: "B's", mode: "read", background: false });
    const first = await a("delegate", { target: "codex", task: "A's", mode: "read", background: false });
    const late = await a("delegate", { target: "codex", task: "late news", mode: "read" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM events WHERE subject = ? AND seen_at IS NULL", late.job_id)[0].c > 0, 20000, "A's settled event");
    for (const [tool, args] of [["status", {}], ["result", { job_id: own.job_id }], ["status", { id: own.job_id }]] as const) {
      const reply = await b(tool, args);
      assert.equal(JSON.stringify(reply.events ?? []).includes(late.job_id), false, tool);
    }
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM events WHERE subject = ? AND seen_at IS NULL", late.job_id)[0].c, 1, "B consumed nothing of A's");
    const delivered = await a("result", { job_id: first.job_id });
    assert.ok(delivered.events?.some((e: any) => e.about === late.job_id), JSON.stringify(delivered.events));
  } finally { await h.close(); }
});

test("OpenCode 2: a call that names no session, or a malformed one, does nothing", async () => {
  const h = await harness();
  try {
    const oc = await h.instance(OPENCODE);
    const tools = await oc.toolDefinitions();
    for (const tool of tools) assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, "session_token"), false, `${tool.name}: OpenCode's sessions carry no token`);
    for (const [tool, args] of [
      ["delegate", { target: "codex", task: "nothing", mode: "read" }], ["ask", { target: "codex", message: "nothing" }],
      ["status", {}], ["status", { id: "j_00000000" }], ["approve", { request_id: "q_00000000", decision: "deny" }],
    ] as const) {
      const bare = await oc.call(tool, args);
      assert.equal(bare.refused, true, `${tool}: ${JSON.stringify(bare)}`);
      assert.match(bare.reason, /This call carried none, so relay did nothing/);
      for (const bad of [42, "", " ", "x".repeat(4097)]) {
        const r = await oc.call(tool, args, { meta: { "ai.opencode/sessionID": bad } });
        assert.deepEqual(r, { refused: true, reason: "Refused: invalid session metadata; this call cannot be used." }, `${tool} with ${JSON.stringify(bad).slice(0, 20)}`);
      }
    }
    assert.deepEqual(counts(h), { runs: 0, nodes: 0, calls: 0, requests: 0 });
    // brief reads no work, and answers without a session.
    assert.ok((await oc.call("brief", { target: "codex" })).brief);
  } finally { await h.close(); }
});

test("OpenCode 2: a session ID gives no claim on another process's work; the person adopts it", async () => {
  const h = await harness();
  try {
    const first = await h.instance(OPENCODE);
    const job = await first.call("delegate", { target: "codex", task: "before restart", mode: "read", background: false }, session("ses_A"));
    const run = job.run_id;
    const ownerPid = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid;
    await first.close();
    await until(() => { try { process.kill(ownerPid, 0); return false; } catch { return true; } });
    // OpenCode restarted its service: the same session, a new relay process.
    const second = await h.instance(OPENCODE);
    assert.deepEqual(await second.call("result", { job_id: job.job_id }, session("ses_A")), UNAVAILABLE_REPLY);
    assert.deepEqual((await second.call("status", {}, session("ses_A"))).nodes, []);
    const fingerprint = (await second.call("status", {}, session("ses_A"))).session.fingerprint;
    const adopted = terminalAdoption(h, job.job_id, fingerprint);
    assert.equal(adopted.status, 0, adopted.stdout + adopted.stderr);
    assert.deepEqual(await second.call("adopt", { run_id: run, into_session: fingerprint }, session("ses_B")), UNAVAILABLE_REPLY, "the authorization is for A's scope");
    assert.equal((await second.call("adopt", { run_id: run, into_session: fingerprint }, session("ses_A"))).adopted, true);
    const recovered = await second.call("result", { job_id: job.job_id }, session("ses_A"));
    assert.equal(recovered.status, "done", JSON.stringify(recovered));
    assert.deepEqual(await second.call("result", { job_id: job.job_id }, session("ses_B")), UNAVAILABLE_REPLY, "adoption is into that session only");
  } finally { await h.close(); }
});

test("OpenCode builds that report local, unknown or prerelease versions are keyed; only 0.x and 1.x releases are not", async () => {
  const { opencodeLegacy } = await import("../dist/mcp/server.js");
  for (const v of ["1.19.4", "0.15.2", "1.0.142"]) assert.equal(opencodeLegacy(v), true, v);
  for (const v of ["2.1.4", "2.0.0", "local", "unknown", "0.0.0", "0.0.0-dev-202610260443", "0.0.0-beta-202608110357", "1.19.4-beta", "", undefined]) assert.equal(opencodeLegacy(v), false, String(v));
  const h = await harness();
  try {
    for (const version of ["local", "unknown", "0.0.0-dev-202610260443"]) {
      const oc = await h.instance({ clientInfo: { name: "opencode", version } });
      const bare = await oc.call("status");
      assert.match(bare.reason ?? "", /This call carried none, so relay did nothing/, version);
      const a = await oc.call("delegate", { target: "codex", task: `A on ${version}`, mode: "read", background: false }, session("ses_A"));
      assert.deepEqual(await oc.call("result", { job_id: a.job_id }, session("ses_B")), UNAVAILABLE_REPLY, version);
      assert.equal((await oc.call("status", {}, session("ses_A"))).session.scope, "host-session", version);
    }
  } finally { await h.close(); }
});

test("OpenCode 1.x sends no session stamp and keeps one scope per process", async () => {
  const h = await harness();
  try {
    const oc = await h.instance({ clientInfo: { name: "opencode", version: "1.19.4" } });
    const job = await oc.call("delegate", { target: "codex", task: "legacy", mode: "read", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const status = await oc.call("status");
    assert.equal(status.session.scope, "unqualified-process");
    assert.equal(status.run_id, job.run_id);
  } finally { await h.close(); }
});
