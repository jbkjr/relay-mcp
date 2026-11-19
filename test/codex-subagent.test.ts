import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, task, type Rule } from "./helpers.ts";

// A web search: Claude's command requests are refused under the never floor before they are filed (core/approvals.ts).
const asker = (name: string, query: string): Rule => ({
  match: task(name),
  steps: [{ request: { web: query } }, { reply: "request result: {{last}}" }],
});

// Codex marks the calls of a native subagent thread (one an agent started with spawn_agent) in their
// _meta (rust-v0.160.1: core/src/mcp_tool_call.rs build_mcp_tool_call_request_meta).
const subagent = { "x-codex-turn-metadata": { thread_source: "subagent", session_id: "s", thread_id: "t" } };
const userThread = { "x-codex-turn-metadata": { thread_source: "user", session_id: "s", thread_id: "t" } };

test("codex subagent: a Codex subagent thread's root session may deny a request but never allow it", async () => {
  const h = await harness([asker("ALLOWED", "allowed-query"), asker("DENIED", "denied-query")]);
  try {
    const host = await h.instance({ args: ["--host", "codex"] });
    const job = await host.call("delegate", { target: "claude", task: "ALLOWED", mode: "write" });
    const waited = await host.call("status", { id: job.job_id, wait_s: 20 });
    const id = waited.needs_approval[0].request_id;
    for (const extra of [{}, { user_confirmed: true }, { scope: "job" }]) {
      const tried = await host.call("approve", { request_id: id, decision: "allow", ...extra }, { meta: subagent });
      assert.equal(tried.refused, true, JSON.stringify(tried));
      assert.match(tried.reason, /Codex subagent thread/);
      assert.match(tried.reason, /relay approve <request_id>/);
      assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", id)[0].status, "pending");
    }
    // The same session's calls from a thread a person is working in decide as before.
    assert.equal((await host.call("approve", { request_id: id, decision: "allow" }, { meta: userThread })).decision, "allowed");
    assert.equal((await host.call("status", { id: job.job_id, wait_s: 20 })).status, "done");

    const denied = await host.call("delegate", { target: "claude", task: "DENIED", mode: "write" });
    const asked = await host.call("status", { id: denied.job_id, wait_s: 20 });
    assert.equal((await host.call("approve", { request_id: asked.needs_approval[0].request_id, decision: "deny" }, { meta: subagent })).decision, "denied");
    // A job whose agent was refused something ends blocked.
    assert.equal((await host.call("status", { id: denied.job_id, wait_s: 20 })).status, "blocked");
    assert.deepEqual(h.sql("SELECT summary, status FROM requests ORDER BY summary").map((r) => ({ ...r })), [
      { summary: "web search: allowed-query", status: "allowed" }, { summary: "web search: denied-query", status: "denied" },
    ]);
  } finally {
    await h.close();
  }
});

test("codex subagent: a Codex subagent thread cannot grant network or write paths to work it starts or continues (review C6)", async () => {
  const h = await harness([
    { match: task("PLAIN"), steps: [{ reply: "plain" }] },
    { match: task("GRANTED"), steps: [{ reply: "granted" }] },
    { match: "QUESTION", steps: [{ reply: "answer" }] },
  ]);
  try {
    const host = await h.instance({ args: ["--host", "codex"] });
    const nodes = () => h.sql("SELECT COUNT(*) AS c FROM nodes")[0].c;
    for (const [tool, args] of [
      ["delegate", { target: "claude", task: "GRANTED", mode: "read", grant: { network: true } }],
      ["ask", { target: "claude", message: "QUESTION", grant: { network: true } }],
      ["discuss", { target: "claude", topic: "t", message: "QUESTION\nCONTINUE", grant: { network: true } }],
    ] as const) {
      const r = await host.call(tool, args, { meta: subagent });
      assert.equal(r.refused, true, `${tool}: ${JSON.stringify(r)}`);
      assert.match(r.reason, /Codex subagent thread/);
      assert.match(r.reason, /make this call itself/);
      assert.equal(nodes(), 0, `${tool} started nothing`);
    }
    // Without a grant it delegates as before, and the job cannot be widened from there either.
    const job = await host.call("delegate", { target: "claude", task: "PLAIN", mode: "read", background: false }, { meta: subagent });
    assert.equal(job.status, "done", JSON.stringify(job));
    const resumed = await host.call("resume", { job_id: job.job_id, message: "more", grant: { network: true } }, { meta: subagent });
    assert.equal(resumed.refused, true, JSON.stringify(resumed));
    assert.equal(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json).grant, null);
    // The same session's calls from a thread a person is working in grant as before.
    const granted = await host.call("delegate", { target: "claude", task: "GRANTED", mode: "read", background: false, grant: { network: true } }, { meta: userThread });
    assert.equal(granted.grant.network, true, JSON.stringify(granted));
    assert.equal(granted.status, "done");
  } finally {
    await h.close();
  }
});
