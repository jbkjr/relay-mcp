import assert from "node:assert/strict";
import { test } from "node:test";
import { alive, harness, passed, task, until } from "./helpers.ts";

// The turn runners: the default one, which reads one JSON event per line (Claude, and Codex's
// `codex exec` fallback), and Codex's app-server runner. Each starts the agent, reads it, cancels it
// and settles its exit in its own copy of the same lifecycle. These cases pin what each says and
// does where the copies are to become one supervisor (consolidation design R3, CT3): a binary that
// is missing, an agent that exits without finishing its turn, and one that will not stop when asked.
// What reaches the result about processes relay could not account for (survivors, unseenMs) is
// pinned by review.test.ts ("a child started just before a crash", "warnings about processes").

const MISSING = "/nonexistent/relay-test-missing-cli";

const RUNNERS = [
  { name: "claude (default runner)", target: "claude", config: {} },
  { name: "codex exec (default runner)", target: "codex", config: { codex_backend: "exec" } },
  { name: "codex app-server", target: "codex", config: {} },
] as const;

for (const r of RUNNERS) {
  test(`runners (${r.name}): an agent that exits without finishing its turn fails with its exit code and the last lines it wrote to stderr`, async () => {
    // The stub waits after writing, so that relay has certainly read its stderr before it exits.
    const h = await harness([{ match: task("CRASH"), steps: [{ stderr: "first\nsecond\nthird\nfourth\n" }, { sleep: 1000 }, { crash: 3 }] }], r.config);
    try {
      const j = await h.call("delegate", { target: r.target, task: "CRASH", mode: "read" });
      const st = await h.call("status", { id: j.job_id, wait_s: 30 });
      assert.equal(st.status, "failed", JSON.stringify(st));
      const said = r.name === "codex app-server"
        ? "codex app-server exited (code 3) before the turn finished. second third fourth"
        : "agent exited (code 3) without finishing its turn. second third fourth";
      // Anything relay could not account for about the agent's processes follows, as a warning.
      assert.ok(st.error.startsWith(said), st.error);
      assert.ok(h.sql("SELECT error FROM turns WHERE node_id = ?", j.job_id)[0].error.startsWith(said));
    } finally {
      await h.close();
    }
  });

  test(`runners (${r.name}): an agent that ignores the request to stop is killed after the grace period, and the cancel reports it stopped`, async () => {
    const h = await harness([{ match: task("STUBBORN"), steps: [{ ignoreSignals: true }, { checkpoint: "ignoring" }, { sleep: 60000 }, { reply: "never" }] }], r.config);
    try {
      const j = await h.call("delegate", { target: r.target, task: "STUBBORN", mode: "read" });
      // Relay has read everything the agent said before this, its turn's start included.
      await passed(h, j.job_id, "ignoring");
      const pid = h.starts()[0].pid as number;
      const c = await h.call("cancel", { id: j.job_id });
      assert.deepEqual(c.cancelled, [j.job_id]);
      assert.equal(c.killed_process_groups, 1, JSON.stringify(c));
      assert.equal(c.warning, undefined);
      await until(() => !alive(pid), 20000, "the agent to be killed");
      assert.equal(h.sql("SELECT status FROM nodes WHERE id = ?", j.job_id)[0].status, "cancelled");
      assert.deepEqual(h.sql("SELECT status FROM turns WHERE node_id = ?", j.job_id).map((t) => t.status), ["cancelled"]);
      const asked = h.log().filter((e) => e.event === "signal" || e.event === "interrupt").map((e) => (e.event === "signal" ? e.signal : "turn/interrupt"));
      // The default runner asks with SIGINT; the app-server runner asks the server, in-band, once its turn has started.
      assert.deepEqual(asked, r.name === "codex app-server" ? ["turn/interrupt"] : ["SIGINT"]);
      assert.equal(h.ends().length, 0, "the agent never finished its turn");
    } finally {
      await h.close();
    }
  });
}

test("runners: a CLI that is not there fails the turn with the spawn error, or, for Codex, with the check that runs before it", async () => {
  // allow_untested: the version check, which would find no version first, is out of the way.
  const cases: { name: string; target: string; config: Record<string, unknown>; error: string }[] = [
    { name: "claude", target: "claude", config: {}, error: `could not start ${MISSING}: spawn ${MISSING} ENOENT` },
    { name: "codex app-server", target: "codex", config: { child_mcp: "inherit" }, error: `could not start ${MISSING}: spawn ${MISSING} ENOENT` },
    { name: "codex exec", target: "codex", config: { child_mcp: "inherit", codex_backend: "exec" }, error: `relay could not read Codex's effective configuration (spawn ${MISSING} ENOENT), so it will not start a Codex agent.` },
    // By default relay first lists Codex's own MCP servers, to switch them off.
    { name: "codex, its servers listed first", target: "codex", config: {}, error: `relay could not list Codex's MCP servers (spawnSync ${MISSING} ENOENT), so it cannot switch them off for a launched agent and will not start one.` },
  ];
  for (const c of cases) {
    const h = await harness([], { allow_untested: true, ...c.config, targets: { [c.target]: { bin: MISSING } } });
    try {
      const j = await h.call("delegate", { target: c.target, task: "x", mode: "read" });
      const st = await h.call("status", { id: j.job_id, wait_s: 30 });
      assert.equal(st.status, "failed", `${c.name}: ${JSON.stringify(st)}`);
      assert.equal(st.error, c.error, c.name);
    } finally {
      await h.close();
    }
  }
});

// The `codex exec` fallback checks Codex's effective configuration first, through a short-lived app
// server (the preflight). It runs in the worker itself (consolidation design R3, review C7/X1), with
// the agent's environment and a deadline of its own. These pin what that check gets, how long it may
// take, and that a cancel during it ends it cleanly. The first two passed on the subprocess the
// preflight ran in before, unchanged.

test("runners (codex exec): the preflight's app server gets the environment the agent gets", async () => {
  const h = await harness([{ match: task("SEEN"), steps: [{ reply: "seen" }] }], { codex_backend: "exec" }, { STUB_RECORD_CONFIG_READ: "1", ANTHROPIC_API_KEY: "sk-test-anthropic", OPENAI_API_KEY: "sk-test-openai" });
  try {
    const j = await h.call("delegate", { target: "codex", task: "SEEN", mode: "read", background: false });
    assert.equal(j.status, "done", JSON.stringify(j));
    const read = h.log().filter((e) => e.event === "config-read");
    assert.equal(read.length, 1, "one preflight");
    assert.deepEqual(read[0].env, h.starts()[0].env, "the same environment as the agent's");
    assert.equal(read[0].node, j.job_id, "with relay's identity of the job");
    assert.equal(read[0].env.anthropicKey, false, "and every family's credentials removed");
    assert.equal(read[0].env.openaiKey, false);
  } finally {
    await h.close();
  }
});

test("runners (codex exec): a preflight whose app server never answers fails the turn at its deadline, and leaves no app server behind", async () => {
  const h = await harness([], { codex_backend: "exec", block_s: 120 }, { STUB_RECORD_CONFIG_READ: "1", STUB_CODEX_HANG_CONFIG: "1" });
  try {
    const started = Date.now();
    const j = await h.call("delegate", { target: "codex", task: "x", mode: "read" });
    const st = await h.call("status", { id: j.job_id, wait_s: 120 });
    assert.equal(st.status, "failed", JSON.stringify(st));
    assert.equal(st.error, "relay could not check Codex's effective configuration");
    assert.ok(Date.now() - started >= 30_000, "not before its 30 s deadline");
    assert.equal(h.starts().length, 0, "the agent never started");
    const server = h.log().find((e) => e.event === "config-read")!.pid as number;
    await until(() => !alive(server), 20000, "the preflight's app server to be gone");
  } finally {
    await h.close();
  }
});

test("runners (codex exec): a cancel during the preflight ends the turn cancelled at once: the worker stops its app server and exits by itself, and the agent never starts", async () => {
  const h = await harness([], { codex_backend: "exec" }, { STUB_RECORD_CONFIG_READ: "1", STUB_CODEX_HANG_CONFIG: "1" });
  try {
    const j = await h.call("delegate", { target: "codex", task: "x", mode: "read" });
    await until(() => h.log().some((e) => e.event === "config-read"), 20000, "the preflight to ask for the configuration");
    const server = h.log().find((e) => e.event === "config-read")!.pid as number;
    const worker = h.sql("SELECT worker_pid FROM nodes WHERE id = ?", j.job_id)[0].worker_pid as number;
    assert.ok(alive(server) && alive(worker));
    const asked = Date.now();
    const c = await h.call("cancel", { id: j.job_id });
    assert.deepEqual(c.cancelled, [j.job_id], JSON.stringify(c));
    assert.equal(c.warning, undefined);
    // Within cancel_grace_ms (5 s by default), after which cancel would have killed the worker itself.
    assert.ok(Date.now() - asked < 5000, `cancel took ${Date.now() - asked} ms`);
    assert.ok(!alive(worker), "the worker had exited");
    await until(() => !alive(server), 5000, "the preflight's app server to be gone");
    assert.equal(h.sql("SELECT status FROM nodes WHERE id = ?", j.job_id)[0].status, "cancelled");
    assert.deepEqual(h.sql("SELECT status, error FROM turns WHERE node_id = ?", j.job_id).map((t) => ({ ...t })), [{ status: "cancelled", error: "cancelled" }], "as cancel recorded it");
    assert.equal(h.starts().length, 0, "the agent never started");
  } finally {
    await h.close();
  }
});
