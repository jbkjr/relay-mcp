import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { alive, harness, INTERACTIVE_CLAUDE, reached, release, task, until, type Harness, type Rec, type Rule } from "./helpers.ts";

// W9: a turn's worker claims its environment from the owning root as it picks the turn up, before
// the turn waits for a concurrency slot, and holds it in memory until the launch. These jobs queue
// behind a first one held at max_concurrent 1, so each waits for its slot after its claim.

const CANARY = "opaque-early-claim-canary-58q";

async function behindHeld(second: Rule["steps"] = [{ reply: "second done" }], config: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const h = await harness([
    { match: task("FIRST"), steps: [{ signal: "first-started" }, { await: "first-go" }, { reply: "first done" }] },
    { match: task("SECOND"), steps: second },
  ], { max_concurrent: 1, ...config }, env);
  // A root that can put a person-only request to the user (confirm), reaching Codex.
  const root = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"] });
  const first = await root.call("delegate", { target: "codex", task: "FIRST", mode: "read", background: true });
  assert.ok(first.job_id, JSON.stringify(first));
  await until(() => reached(h, "first-started"), 20000, "the first job's agent to start");
  return { h, root, first };
}
/** True once the job's worker waits for a slot, which it asks for only after its claim. */
const waitingForSlot = (h: Harness, id: string) => h.sql("SELECT COUNT(*) AS c FROM slots WHERE holder = ? AND state = 'waiting'", id)[0].c === 1;
const started = (h: Harness, name: string) => h.starts().filter((s) => new RegExp(task(name)).test(s.prompt));
const turnOf = (h: Harness, id: string) => h.sql("SELECT status, error FROM turns WHERE node_id = ? ORDER BY id", id).at(-1)!;
const nodeStatus = (h: Harness, id: string) => h.sql("SELECT status FROM nodes WHERE id = ?", id)[0]?.status;
async function closeRoot(h: Harness, root: { close(): Promise<void> }, job: Rec) {
  const pid = h.sql("SELECT root_pid FROM runs WHERE id = ?", job.run_id)[0].root_pid as number;
  await root.close();
  await until(() => !alive(pid), 20000, "the root session's relay server to exit");
}
/** Every file under dir whose contents include text. */
function filesHolding(dir: string, text: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name))
    .filter((f) => { try { return fs.readFileSync(f).includes(text); } catch { return false; } });
}

test("tool env claim: a job queued behind the concurrency limit survives a no-op config save and its root session closing while it waits, then runs to done", async () => {
  const { h, root, first } = await behindHeld();
  try {
    const second = await root.call("delegate", { target: "codex", task: "SECOND", mode: "read", background: true });
    await until(() => waitingForSlot(h, second.job_id), 20000, "the second job to claim and wait for its slot");
    assert.equal(turnOf(h, second.job_id).status, "queued", "claimed while still queued");
    assert.equal(nodeStatus(h, second.job_id), "queued");
    // A save that leaves the policy as it was does not fail a claim without grant.env.
    const config = path.join(h.home, "config.json");
    fs.writeFileSync(config, fs.readFileSync(config));
    await closeRoot(h, root, first);
    release(h, "first-go");
    await until(() => nodeStatus(h, second.job_id) === "done", 30000, "the second job to run to done");
    assert.equal(turnOf(h, second.job_id).status, "done", JSON.stringify(turnOf(h, second.job_id)));
    assert.equal(started(h, "SECOND").length, 1);
    assert.equal(nodeStatus(h, first.job_id), "done");
  } finally { await h.close(); }
});

test("tool env claim: one-turn consent is asked at the claim, while queued; the released value is on no file relay or its agents use, and reaches the agent after its root has gone", async () => {
  // Relay's processes get a TMPDIR of their own here, so that it can be searched whole.
  const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/rc-"));
  // The second agent replies with the value it was given, which relay cuts from what it keeps.
  const { h, root, first } = await behindHeld([{ bareEnvironmentSecret: "ENV_CANARY" }], { targets: { codex: { child_env: { request: ["ENV_CANARY"] } } } }, { ENV_CANARY: CANARY, TMPDIR: tmp });
  try {
    const second = await root.call("delegate", { target: "codex", task: "SECOND", mode: "read", background: true, grant: { env: ["ENV_CANARY"] } });
    assert.ok(second.job_id, JSON.stringify(second));
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE node_id = ? AND kind = 'env' AND status = 'pending'", second.job_id)[0].c === 1, 20000, "the consent request");
    // Asked before the job waits for a slot: it holds none, nor waits for one, and its turn is queued.
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM slots WHERE holder = ?", second.job_id)[0].c, 0);
    assert.equal(turnOf(h, second.job_id).status, "queued");
    const req = (await root.call("status", { id: second.job_id })).needs_approval.find((r: Rec) => r.from === second.job_id);
    assert.equal(req.person_only, true);
    const { request_id, from, wants, kind, effect, in_directory } = req;
    assert.equal((await root.call("confirm", { request_id, from, wants, kind, effect, in_directory })).decision, "allowed");
    await until(() => waitingForSlot(h, second.job_id), 20000, "the second job to wait for its slot with its environment claimed");
    // Relay's control directory, the agents' HOME, relay's TMPDIR and the repository: the claimed value is in the worker's memory only.
    assert.deepEqual([h.home, h.env.HOME, tmp, h.repo].flatMap((dir) => filesHolding(dir, CANARY)), []);
    await closeRoot(h, root, first);
    release(h, "first-go");
    await until(() => nodeStatus(h, second.job_id) === "done", 30000, "the second job to run to done");
    assert.deepEqual(h.ends().map((e) => e.reply === CANARY), [false, true], "the one-turn release reached the second agent only");
    const kept = h.sql("SELECT reply FROM turns WHERE node_id = ?", second.job_id)[0].reply as string;
    assert.match(kept, /\[redacted/);
    assert.equal(kept.includes(CANARY), false, "the released value is cut from what relay keeps");
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", request_id)[0].status, "allowed");
  } finally {
    await h.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("tool env claim: a person's denial at the claim fails the queued turn, which never launches", async () => {
  const { h, root, first } = await behindHeld(undefined, { targets: { codex: { child_env: { request: ["ENV_CANARY"] } } } }, { ENV_CANARY: CANARY });
  try {
    const second = await root.call("delegate", { target: "codex", task: "SECOND", mode: "read", background: true, grant: { env: ["ENV_CANARY"] } });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE node_id = ? AND kind = 'env' AND status = 'pending'", second.job_id)[0].c === 1, 20000, "the consent request");
    const req = (await root.call("status", { id: second.job_id })).needs_approval.find((r: Rec) => r.from === second.job_id);
    assert.equal((await root.call("approve", { request_id: req.request_id, decision: "deny" })).decision, "denied");
    await until(() => turnOf(h, second.job_id).status === "failed", 20000, "the denied turn to fail");
    assert.match(turnOf(h, second.job_id).error, /consent was denied.*no environment values were released/);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM slots WHERE holder = ?", second.job_id)[0].c, 0, "it never waited for a slot");
    release(h, "first-go");
    await until(() => nodeStatus(h, first.job_id) === "done", 30000, "the first job to finish");
    assert.equal(started(h, "SECOND").length, 0);
  } finally { await h.close(); }
});

test("tool env claim: a turn whose environment policy changes while it waits for its slot fails closed, launching nothing", async () => {
  const { h, root, first } = await behindHeld();
  try {
    const second = await root.call("delegate", { target: "codex", task: "SECOND", mode: "read", background: true });
    await until(() => waitingForSlot(h, second.job_id), 20000, "the second job to claim and wait for its slot");
    // The person narrows the policy after the claim: the earlier selection must not launch.
    const file = path.join(h.home, "config.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    cfg.child_env.drop = [...(cfg.child_env.drop ?? []), "UNUSED_EXAMPLE_TOKEN"];
    fs.writeFileSync(file, JSON.stringify(cfg));
    release(h, "first-go");
    await until(() => !["queued", "running"].includes(turnOf(h, second.job_id).status), 30000, "the second job's turn to end");
    const turn = turnOf(h, second.job_id);
    assert.equal(turn.status, "failed", JSON.stringify(turn));
    assert.match(turn.error, /changed while it waited to start .*not started with the environment it was given then\. Resume it to claim afresh/);
    assert.equal(started(h, "SECOND").length, 0, "nothing launched on the earlier authority");
    assert.equal(nodeStatus(h, first.job_id), "done", "the launched turn was unaffected");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM slots")[0].c === 0, 20000, "every slot to be released");
  } finally { await h.close(); }
});

test("tool env claim: a turn cancelled while it waits for its slot launches nothing", async () => {
  const { h, root, first } = await behindHeld();
  try {
    const second = await root.call("delegate", { target: "codex", task: "SECOND", mode: "read", background: true });
    await until(() => waitingForSlot(h, second.job_id), 20000, "the second job to claim and wait for its slot");
    const worker = h.sql("SELECT worker_pid FROM nodes WHERE id = ?", second.job_id)[0].worker_pid as number;
    const cancelled = await root.call("cancel", { id: second.job_id });
    assert.deepEqual(cancelled.cancelled, [second.job_id], JSON.stringify(cancelled));
    await until(() => !alive(worker), 20000, "the cancelled job's worker to exit");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM slots WHERE holder = ?", second.job_id)[0].c, 0, "its slot request went with it");
    release(h, "first-go");
    await until(() => nodeStatus(h, first.job_id) === "done", 30000, "the first job to finish");
    assert.equal(nodeStatus(h, second.job_id), "cancelled");
    assert.equal(turnOf(h, second.job_id).status, "cancelled");
    assert.equal(started(h, "SECOND").length, 0);
  } finally { await h.close(); }
});
