import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { alive, harness, release, sleep, task, until, type Rule } from "./helpers.ts";

const chain = (from: string, to: string, target: string): Rule => ({
  match: task(from),
  steps: [{ call: "delegate", args: { target, task: to, mode: "read", background: false } }, { reply: "{{last}}" }],
});

test("depth cap: a start at max depth is refused with the reason", async () => {
  const h = await harness([chain("L1", "L2", "codex"), chain("L2", "L3", "claude"), chain("L3", "L4", "codex")]);
  try {
    const r = await h.call("delegate", { target: "claude", task: "L1", mode: "read", background: false });
    assert.equal(r.status, "done");
    const ends = h.ends();
    assert.equal(h.starts().length, 3, "L4 must never start");
    const deepest = ends.find((e) => e.calls.length && e.calls[0].result.refused);
    assert.ok(deepest, "the depth-3 agent's delegate call is refused");
    assert.match(deepest.calls[0].result.reason, /depth 3 of 3/);
    assert.match(deepest.calls[0].result.reason, /yourself/);
    const depths = h.sql("SELECT depth FROM nodes ORDER BY depth").map((n) => n.depth);
    assert.deepEqual(depths, [1, 2, 3]);
    // The preamble tells each agent where it sits.
    const l3 = h.starts().find((s) => /assignment:\s+L3$/.test(s.prompt))!;
    assert.match(l3.prompt, /Depth 3 of max 3/);
    assert.match(l3.prompt, /Root task: L1/);
    assert.match(l3.prompt, /Parent task: L2/);
    assert.match(l3.prompt, /Never forward your whole assignment, and never hand work back to an ancestor/);
    assert.match(l3.prompt, /## RELAY REPORT/);
  } finally {
    await h.close();
  }
});

test("allow_delegation = false: relay is not injected, and a direct call is refused", async () => {
  const h = await harness([{ match: task("SOLO"), steps: [{ tools: true }, { call: "delegate", args: { target: "codex", task: "X", mode: "read" } }, { reply: "{{last}}" }] }]);
  try {
    const r = await h.call("delegate", { target: "claude", task: "SOLO", mode: "read", allow_delegation: false, background: false });
    assert.equal(r.status, "done");
    assert.equal(h.starts().length, 1);
    // Its relay server exists only so that its permission prompts have somewhere to go.
    const solo = h.ends()[0].calls;
    assert.deepEqual(solo[0].result.tools, ["permission_prompt"], "no delegation tools are offered");
    assert.match(solo[1].result.error, /not found/i);
    assert.match(h.starts()[0].prompt, /You may not delegate/);

    // A relay server started for a turn that may not delegate offers the permission tool and nothing else.
    const node = h.sql("SELECT * FROM nodes")[0];
    const child = await h.instance(await h.childOf(node.id, { access: "read", may_delegate: false, may_ask: true }));
    assert.deepEqual(await child.tools(), ["permission_prompt"]);
    assert.match((await child.call("delegate", { target: "codex", task: "X", mode: "read" })).tool_error, /not found/i);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes")[0].c, 1);
  } finally {
    await h.close();
  }
});

test("missing or inconsistent context: the instance refuses and never becomes a new root run", async () => {
  const h = await harness();
  try {
    const seed = await h.call("delegate", { target: "claude", task: "seed", mode: "read", background: false });
    const node = h.sql("SELECT * FROM nodes WHERE id = ?", seed.job_id)[0];
    const good = path.join(h.home, "runs", node.run_id, "nodes", node.id, "context.json");
    const envFor = (over: Record<string, string> = {}) => ({ RELAY_RUN_ID: node.run_id, RELAY_NODE_ID: node.id, RELAY_DEPTH: "1", RELAY_INJECTED: "1", ...over });
    const cases: { name: string; args?: string[]; env?: Record<string, string>; cwd?: string }[] = [
      { name: "child markers in env but server not injected", env: { RELAY_RUN_ID: node.run_id, RELAY_NODE_ID: node.id, RELAY_DEPTH: "1" } },
      { name: "context file missing", args: ["--context", path.join(h.home, "nope.json")], env: envFor() },
      { name: "env stripped, only the argument survives", args: ["--context", good] },
      { name: "env and file disagree on depth", args: ["--context", good], env: envFor({ RELAY_DEPTH: "0" }) },
      { name: "node not in registry", args: ["--context", good], env: envFor({ RELAY_NODE_ID: "j_missing" }) },
    ];
    // A worktree-style context file in cwd with nothing else must also poison the instance.
    const stray = path.join(h.home, "stray");
    fs.mkdirSync(path.join(stray, ".relay"), { recursive: true });
    fs.copyFileSync(good, path.join(stray, ".relay", "context.json"));
    cases.push({ name: ".relay/context.json present but nothing injected", cwd: stray });

    const runsBefore = h.sql("SELECT COUNT(*) AS c FROM runs")[0].c;
    for (const c of cases) {
      const inst = await h.instance(c);
      for (const [tool, args] of [
        ["delegate", { target: "codex", task: "X", mode: "read" }],
        ["ask", { target: "codex", message: "hi" }],
        ["discuss", { topic: "t", message: "m", target: "codex" }],
        ["review", { target: "README.md", reviewer: "codex" }],
      ] as const) {
        const r = await inst.call(tool, args);
        assert.equal(r.refused, true, `${c.name}: ${tool} must be refused`);
        assert.match(r.reason, /could not be loaded/, c.name);
      }
      await inst.close();
    }
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM runs")[0].c, runsBefore, "no new run was created");
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes")[0].c, 1, "nothing was started");

    // Control: a consistent context loads, and is a child at the recorded depth.
    const ok = await h.instance(await h.childOf(node.id, { access: "read" }));
    const started = await ok.call("delegate", { target: "codex", task: "from child", mode: "read", background: false });
    assert.equal(started.depth, 2);

    // The same context after its turn has ended carries no authority: a lingering server cannot start anything.
    const stale = await h.instance(await h.childOf(node.id, { access: "read", running: false }));
    assert.match((await stale.call("delegate", { target: "codex", task: "late", mode: "read" })).reason, /turn this relay connection belonged to has ended/);
    // And a context file with no turn policy at all is not accepted.
    const bare = path.join(h.home, "bare.json");
    fs.writeFileSync(bare, JSON.stringify({ run_id: node.run_id, node_id: node.id, depth: 1 }));
    const noPolicy = await h.instance({ args: ["--context", bare], env: envFor() });
    assert.match((await noPolicy.call("delegate", { target: "codex", task: "x", mode: "read" })).reason, /no turn policy/);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM runs")[0].c, runsBefore);
  } finally {
    await h.close();
  }
});

test("concurrency: extra work queues, and blocked callers lend their slot", async () => {
  const h = await harness(
    [
      // Held until the test has looked at the queue, so the first two are certainly still running then.
      { match: task("SLOW"), steps: [{ await: "slow-may-finish" }, { reply: "done" }] },
      // Both are held until both hold a slot, so that their consults certainly find no slot free.
      { match: task("ASKER"), steps: [{ await: "askers-may-ask" }, { call: "ask", args: { target: "codex", message: "QUESTION" } }, { reply: "{{last}}" }] },
      { match: "QUESTION", steps: [{ sleep: 300 }, { reply: "answer" }] },
    ],
    { max_concurrent: 2 },
  );
  try {
    const ids: string[] = [];
    // One target, so that all four are in one run (a session reaches one family) and share its two slots.
    for (let i = 0; i < 4; i++) ids.push((await h.call("delegate", { target: "claude", task: "SLOW", mode: "read" })).job_id);
    await until(() => h.starts().length >= 2, 60000, "two jobs to start");
    // Nothing can finish before the release, so a third start in this time would be a slot too many.
    await sleep(300);
    const mid = h.sql("SELECT status, COUNT(*) AS c FROM nodes GROUP BY status");
    assert.equal(mid.find((r) => r.status === "running")?.c, 2);
    assert.equal(mid.find((r) => r.status === "queued")?.c, 2);
    assert.equal(h.starts().length, 2);
    release(h, "slow-may-finish");
    await until(() => h.sql("SELECT COUNT(*) AS c FROM nodes WHERE status = 'done'")[0].c === 4, 120000, "all four to finish");

    // Never more than two agents at once, judged from the stub's own start and end times.
    const spans = h.starts().map((s) => ({ a: s.t, b: h.ends().find((e) => e.pid === s.pid)!.t }));
    for (const s of spans) assert.ok(spans.filter((o) => o.a <= s.a && s.a < o.b).length <= 2, "at most two overlap");

    // Two jobs fill both slots and each blocks on a consult. Without lending this would deadlock.
    const a = await h.call("delegate", { target: "claude", task: "ASKER", mode: "read" });
    const b = await h.call("delegate", { target: "claude", task: "ASKER", mode: "read" });
    await until(() => h.starts().filter((s) => /ASKER$/.test(s.prompt)).length === 2, 20000, "both askers to start");
    release(h, "askers-may-ask");
    const ra = await h.call("status", { id: a.job_id, wait_s: 20 });
    const rb = await h.call("status", { id: b.job_id, wait_s: 20 });
    assert.equal(ra.status, "done");
    assert.equal(rb.status, "done");
    assert.match(JSON.stringify(ra.result), /answer/);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM slots")[0].c, 0, "all slots released");
  } finally {
    await h.close();
  }
});

test("cancel(run_id) kills a nested tree", async () => {
  const h = await harness([chain("T1", "T2", "codex"), chain("T2", "T3", "claude"), { match: task("T3"), steps: [{ sleep: 60000 }, { reply: "never" }] }]);
  try {
    await h.call("delegate", { target: "claude", task: "T1", mode: "read" });
    await until(() => h.starts().length === 3, 20000, "three nested agents to start");
    const agentPids = h.starts().map((s) => s.pid as number);
    const rows = h.sql("SELECT run_id, worker_pid, agent_pgid FROM nodes");
    const workerPids = rows.map((r) => r.worker_pid as number).filter((p) => p > 0);
    assert.equal(workerPids.length, 3);
    for (const p of [...agentPids, ...workerPids]) assert.ok(alive(p), `pid ${p} is running before cancel`);

    const r = await h.call("cancel", { id: rows[0].run_id });
    assert.equal(r.run_cancelled, true);
    assert.equal(r.cancelled.length, 3);
    await until(() => [...agentPids, ...workerPids].every((p) => !alive(p)), 20000, "every agent and worker to exit");
    assert.deepEqual(h.sql("SELECT DISTINCT status FROM nodes").map((n) => n.status), ["cancelled"]);

    // A cancelled run starts nothing more from a child that is still talking to relay.
    const node = h.sql("SELECT * FROM nodes WHERE depth = 1")[0];
    const ctxFile = path.join(h.home, "runs", node.run_id, "nodes", node.id, "context.json");
    const child = await h.instance({ args: ["--context", ctxFile], env: { RELAY_RUN_ID: node.run_id, RELAY_NODE_ID: node.id, RELAY_DEPTH: "1", RELAY_INJECTED: "1" } });
    const late = await child.call("delegate", { target: "codex", task: "late", mode: "read" });
    assert.equal(late.refused, true);
    assert.match(late.reason, /cancelled|has ended/);
  } finally {
    await h.close();
  }
});

test("several relay processes can open a fresh registry at the same moment", async () => {
  const h = await harness();
  try {
    for (const f of fs.readdirSync(h.home)) if (f.startsWith("relay.db")) fs.rmSync(path.join(h.home, f));
    const insts = await Promise.all(Array.from({ length: 6 }, () => h.instance({})));
    const results = await Promise.all(insts.map((i) => i.call("delegate", { target: "claude", task: "X", mode: "read", background: false })));
    assert.deepEqual(results.map((r) => r.status), Array(6).fill("done"));
  } finally {
    await h.close();
  }
});
