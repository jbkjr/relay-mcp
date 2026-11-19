import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { scratchOnly, until } from "./helpers.ts";

// A launched agent's host going away in the middle of an approval wait (review r_78aca319 X1/C28;
// 1.0 audit A9). The chain that ends the wait: the connection closes (relay mcp closes its
// transport when stdin ends; lifecycle.test.ts has that end of it, through a real stdio server),
// the MCP SDK's Protocol._onclose aborts every request handler still running, and permission_prompt
// passes its handler's signal to requestApproval, which withdraws the request at its next look.
// Here the server is relay's own, in this process, over an in-memory connection, so that what
// ends the wait can only be the connection closing: the request's own deadline is an hour away.

const home = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-disconnect-"))));
process.env.RELAY_HOME = home;
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const { createRun, db, insertNode, insertTurn } = await import("../dist/core/db.js");
const { withDefaults } = await import("../dist/core/config.js");
const { newInstance } = await import("../dist/core/caller.js");
const { relayServer } = await import("../dist/mcp/server.js");
const { requestApproval } = await import("../dist/core/approvals.js");

const runId = createRun(home, withDefaults({ approval_timeout_s: 3600 }), "root-token");
let n = 0;
/** A Claude job in the middle of a turn, which may ask for approval: what a launched agent's relay server serves. */
function runningTurn() {
  const nodeId = `j_0a09${String(++n).padStart(4, "0")}`;
  insertNode({ id: nodeId, run_id: runId, kind: "job", target: "claude", mode: "write", depth: 1, task: "t", cwd: home, status: "running" });
  const turnId = insertTurn(nodeId, "test", "", "write", "running");
  return { nodeId, turnId };
}
const rows = (sql: string, ...params: unknown[]) => db().prepare(sql).all(...(params as never[])).map((r) => ({ ...r }));
const fetchAsk = (url: string) => ({ tool_name: "WebFetch", input: { url } });

test("disconnect: an approval wait ends when the asking agent's connection closes; the request is withdrawn (expired, decided by nobody) and its turn goes on", async () => {
  const { nodeId, turnId } = runningTurn();
  // The job holds a concurrency slot; while its agent waits on approval it is lent.
  db().prepare("INSERT INTO slots (run_id, holder, pid, state, created_at) VALUES (?, ?, ?, 'held', ?)").run(runId, nodeId, process.pid, Date.now());
  const inst = newInstance({ kind: "child", runId, nodeId, depth: 1, turnId, access: "write", mayDelegate: false, mayAsk: true }, home);
  const server = relayServer(inst);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "stub-claude", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["permission_prompt"]);

  const call = client.callTool({ name: "permission_prompt", arguments: fetchAsk("https://gone.example") }, undefined, { timeout: 3_600_000 })
    .then(() => "answered", (err: Error) => err.message);
  try {
    await until(() => rows("SELECT status FROM requests WHERE node_id = ?", nodeId)[0]?.status === "pending", 10000, "the request to be filed");
    assert.equal(rows("SELECT state FROM slots WHERE holder = ?", nodeId)[0].state, "lent");
    const [{ id }] = rows("SELECT id FROM requests WHERE node_id = ?", nodeId) as { id: string }[];

    // The agent's side goes away.
    await client.close();
    assert.match(await call, /Connection closed/, "the client's own call ends with the connection");
    await until(() => rows("SELECT status FROM requests WHERE id = ?", id)[0].status !== "pending", 10000, "the wait to end");
    const [row] = rows("SELECT status, decided_by, note, scope, decided_at FROM requests WHERE id = ?", id);
    assert.deepEqual({ ...row, decided_at: typeof row.decided_at }, { status: "expired", decided_by: null, note: null, scope: null, decided_at: "number" }, "withdrawn, not decided");
    await until(() => rows("SELECT state FROM slots WHERE holder = ?", nodeId)[0].state === "held", 10000, "the slot to be given back");
    // The connection is gone, not the turn: ending that is for the worker, which knows.
    assert.equal(rows("SELECT status FROM turns WHERE id = ?", turnId)[0].status, "running");
    assert.equal(rows("SELECT status FROM nodes WHERE id = ?", nodeId)[0].status, "running");
    assert.equal(rows("SELECT COUNT(*) AS c FROM requests WHERE node_id = ?", nodeId)[0].c, 1);
  } finally {
    // Should the wait outlive the connection (the failure under test), the turn's end stops it, so
    // that this process does not wait out the hour.
    db().prepare("UPDATE turns SET status = 'done' WHERE id = ?").run(turnId);
    db().prepare("UPDATE nodes SET status = 'done' WHERE id = ?").run(nodeId);
    await client.close().catch(() => {});
  }
});

// A call that has gone away (cancelled, or its connection closed) files nothing, however its looks
// fall: a request filed for it would be withdrawn at once, but not before the root session, the
// user's dialog or a desktop notification could have been told of it.
// A web request: a Claude job's command requests are refused under the never floor before anything is filed (core/approvals.ts).
const ask = (summary: string) => ({ kind: "web" as const, summary });
const requestsOf = (nodeId: string) => rows("SELECT summary, status FROM requests WHERE node_id = ? ORDER BY created_at, rowid", nodeId).map((r) => [r.summary, r.status]);

test("disconnect: a call already gone when it would file its request files none", async () => {
  const { nodeId, turnId } = runningTurn();
  const answer = await requestApproval(nodeId, turnId, ask("gone first"), () => true);
  // The call has gone; its turn has not, so the answer does not say the turn is over.
  assert.deepEqual(answer, { allow: false, note: "the call that asked was cancelled or its turn is over" });
  assert.equal(rows("SELECT status FROM turns WHERE id = ?", turnId)[0].status, "running");
  assert.deepEqual(requestsOf(nodeId), []);
});

test("disconnect: a call queued behind another files none once its connection has closed, also when the one ahead is closed before it looks again", async () => {
  const { nodeId, turnId } = runningTurn();
  const requests = () => requestsOf(nodeId);
  // Two calls of one connection: the first files its request, the second waits behind it. The
  // connection closes, and the first's request is closed before the second looks again.
  let gone = false;
  const first = requestApproval(nodeId, turnId, ask("ahead"), () => gone);
  const second = requestApproval(nodeId, turnId, ask("behind"), () => gone);
  assert.deepEqual(requests(), [["ahead", "pending"]]);
  gone = true;
  db().prepare("UPDATE requests SET status = 'expired', decided_at = ? WHERE node_id = ? AND summary = 'ahead'").run(Date.now(), nodeId);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.allow, false);
  assert.deepEqual(b, { allow: false, note: "the call that asked was cancelled or its turn is over" });
  assert.deepEqual(requests(), [["ahead", "expired"]], "the call behind filed nothing once it had gone");
});
