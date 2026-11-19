// The benchmark board: each scenario sets up fresh isolated trials (lib.mjs sandbox) and records
// samples for one or more cells. A cell is one number on the board; its value is the median of its
// samples (the mean for the poll cells, below). Families: "start/continue" (starting and continuing agents), "supervise" (status,
// events, approvals, cancellation, idle cost), "cli/maintenance" (the terminal commands).
// "diagnostic" cells run only on request (--diag) and are never on the pass/fail board.
//
// Polling and dithering. Several of relay's waits are fixed-interval polls (the MCP wait loop,
// 200 ms; a worker's wait for an approval decision, 250 ms; the root's watch loop, 1 s). With an
// instant stub, a turn ends at nearly the same moment in every trial, so the poll's phase is the
// same every time and the measured latency is a step function of relay's own work: a speed-up
// shows only when it crosses a poll boundary. Each such cell therefore delays the stub (or the
// next call) by a known amount d spread evenly over the poll's period across the cell's samples
// (stratified, in a fixed shuffled order), and records the latency minus d. The median then equals
// relay's work plus the expected poll wait, and moves one-for-one with relay's own time.
// Where the stub's start-up jitter would blur the phase (the settle and approval cells), the stub
// is held and released by the bench at a stratified offset from the waiting call (or from the watch
// loop's ticks), and the cell's value is the mean of its samples, which for evenly spread phases is
// steadier than the median (estimator: "mean").
//
// Short calls on an idle server (status) are timed back to back after two warm-up calls: a call
// after half a second of idleness pays a wake-up and clock ramp of several ms that depends on what
// else the machine is doing (on this M5 Max, 2.4 ms warm against about 10 ms spaced, on either core
// type), which no change to relay can move and which made those cells bimodal from run to run.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as L from "./lib.mjs";

const FAM = { start: "start/continue", supervise: "supervise", cli: "cli/maintenance", diag: "diagnostic" };
const WAIT_POLL = 200; // src/core/wait.ts waitUntil
const DECISION_POLL = 250; // src/core/approvals.ts, a worker waiting for a decision
const WATCH_TICK = 1000; // src/mcp/server.ts, the root's watch loop (src/core/watch.ts watch)

const reply = (text) => ({ reply: text });
/** Stub rules: every turn of `target` sleeps d then answers. */
const instant = (target, d, extra = []) => [{ target, steps: [...(d >= 1 ? [{ sleep: Math.round(d) }] : []), ...extra, reply("bench reply\nCONTINUE")] }];
const since = (t0) => performance.now() - t0;

/**
 * A root session in a fresh sandbox, its first ask done (the session's one-off costs paid) and at
 * rest. In the large repository, a first write job too: the first worktree checkout in a freshly
 * copied repository reads every object cold (about twice the steady time), a one-off per repository
 * that would otherwise land on whichever sample comes first.
 */
async function warmRoot(ctx, { host = "claude", target = "codex", repo = "small", extraEnv, config, stubEnv } = {}) {
  const sb = ctx.sandbox({ config, stubEnv });
  repo === "large" ? L.largeRepo(sb) : L.smallRepo(sb);
  const c = await L.rootSession(sb, { host, extraEnv });
  L.setRules(sb, instant(target, 0));
  const first = await c.call("ask", { target, message: "warm-up" });
  if (!first.reply) throw new Error(`warm-up ask got no reply: ${JSON.stringify(first).slice(0, 1000)}`);
  if (repo === "large") {
    const job = await c.call("delegate", { target, task: "warm-up write", mode: "write", background: false });
    if (job.status !== "done") throw new Error(`warm-up write job: ${JSON.stringify(job).slice(0, 1000)}`);
  }
  await L.quiesce(sb);
  return { sb, c, runId: first.run_id, warmThread: first.thread_id };
}

/** One timed tool call (request written -> response read), minus the stub's dither d. */
async function timed(c, tool, args, d = 0) {
  const t0 = performance.now();
  const r = await c.call(tool, args);
  return { ms: since(t0) - d, r };
}

const node = (sb, id) => L.sql(sb, "SELECT * FROM nodes WHERE id = ?", id)[0];
/** Two untimed status calls (no id, and by id), so that the timed ones run warm (see the header). */
async function warmStatus(c, id) {
  await c.call("status", {});
  await c.call("status", { id });
}
/** Lets a stub agent held at an `await` step of that name go on (test/stubs/stub-agent.mjs held, which looks every 20 ms). */
const release = (sb, name) => fs.writeFileSync(path.join(sb.stub, name), "");
/** Until the item's agent has started its turn (task text in its prompt) and the item is running. */
const heldAt = (sb, id, task) => L.until(() => stubLog(sb).some((e) => e.event === "start" && e.prompt?.includes(task)) && node(sb, id).status === "running", `${id}'s agent to start`);
const sleepUntil = (t) => L.sleep(Math.max(0, t - Date.now()));
const stubLog = (sb) => fs.readFileSync(path.join(sb.stub, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function askScenario(id, { host, target, what, stubEnv, args = {}, family = FAM.start }) {
  return {
    id, trials: 6, perTrial: 3,
    cells: { [id]: { family, what } },
    async trial(ctx) {
      const { sb, c } = await warmRoot(ctx, { host, target, stubEnv });
      for (let j = 0; j < ctx.perTrial; j++) {
        const d = ctx.phase(j) * WAIT_POLL;
        L.setRules(sb, instant(target, d));
        const { ms, r } = await timed(c, "ask", { target, message: `question ${j}`, ...args }, d);
        if (!r.reply?.startsWith("bench reply")) throw new Error(`ask: unexpected reply ${JSON.stringify(r).slice(0, 1000)}`);
        ctx.record(id, ms);
        await L.quiesce(sb);
      }
    },
  };
}

export const SCENARIOS = [
  {
    id: "mcp_cold", trials: 20, perTrial: 1, warmup: 1,
    cells: { mcp_cold: { family: FAM.start, what: "bin/relay mcp --host claude, spawned until initialize and tools/list have answered (Claude Code client)" } },
    async trial(ctx) {
      const sb = ctx.sandbox();
      L.smallRepo(sb);
      const t0 = performance.now();
      const c = L.mcp(sb, { host: "claude" });
      await c.initialize();
      const list = await c.request("tools/list");
      ctx.record("mcp_cold", since(t0));
      if (!list.tools?.some((t) => t.name === "ask")) throw new Error("tools/list has no ask tool");
    },
  },

  askScenario("ask_codex", { host: "claude", target: "codex", what: "ask on a new thread to stub Codex from a warm Claude Code root: call -> reply (worker spawn, slot, app-server launch and preflight, turn, archive, wait poll)" }),
  askScenario("ask_codex_network", { host: "claude", target: "codex", args: { grant: { network: true } },
    what: "ask_codex with grant { network: true }: adds Codex's network preflight (an extra app-server and the sandbox canary, which the stub answers without running it)" }),
  askScenario("ask_claude", { host: "codex", target: "claude", what: "ask on a new thread to stub Claude from a warm Codex root: call -> reply" }),

  {
    id: "acp_read", trials: 4, perTrial: 3,
    cells: { acp_read: { family: FAM.start, what: "delegate a read job (background: false) to stub Copilot over ACP, under relay's own confinement (Seatbelt wrap, per-turn boundary probes, broker and bridge): call -> result" } },
    async trial(ctx) {
      // Copilot, switched on and experimental, pointed at a scratch copy of test/stubs/stub-acp in
      // the sandbox: the boundary probes aim beside the harness binary (as test/acp.test.ts does).
      const sb = ctx.sandbox();
      const stubDir = path.join(sb.dir, "acp");
      fs.mkdirSync(stubDir);
      fs.writeFileSync(path.join(stubDir, "package.json"), '{ "type": "module" }\n');
      const href = (p) => JSON.stringify(pathToFileURL(path.join(L.STUBS, p)).href);
      fs.writeFileSync(path.join(stubDir, "stub-acp"), `#!/usr/bin/env node\nimport { main } from ${href("stub-agent.mjs")};\nimport acp from ${href("targets/acp.mjs")};\nawait main(acp);\n`, { mode: 0o755 });
      const cfgFile = path.join(sb.home, "config.json");
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
      cfg.same_family = "refuse";
      cfg.child_network = true;
      cfg.targets.copilot = { enabled: true, experimental: true, bin: path.join(stubDir, "stub-acp") };
      fs.writeFileSync(cfgFile, JSON.stringify(cfg));
      L.smallRepo(sb);
      const c = await L.rootSession(sb, { host: "claude" });
      const args = { target: "copilot", model: "gpt-6.1-sol", mode: "read", background: false };
      L.setRules(sb, instant("copilot", 0));
      const first = await c.call("delegate", { ...args, task: "warm-up" });
      if (first.status !== "done") throw new Error(`warm-up ACP job: ${JSON.stringify(first).slice(0, 1500)}`);
      await L.quiesce(sb);
      for (let j = 0; j < ctx.perTrial; j++) {
        const d = ctx.phase(j) * WAIT_POLL;
        L.setRules(sb, instant("copilot", d));
        const { ms, r } = await timed(c, "delegate", { ...args, task: `confined read ${j}` }, d);
        if (r.status !== "done" || !r.result?.final_message?.startsWith("bench reply")) throw new Error(`ACP read job: ${JSON.stringify(r).slice(0, 1500)}`);
        ctx.record("acp_read", ms);
        await L.quiesce(sb);
      }
    },
  },

  {
    id: "followup_drained", trials: 6, perTrial: 3,
    cells: { followup_drained: { family: FAM.start, what: "ask with thread_id on a settled Codex thread whose worker has exited: call -> reply (fresh worker, unarchive, thread/resume)" } },
    async trial(ctx) {
      const { sb, c, warmThread } = await warmRoot(ctx);
      for (let j = 0; j < ctx.perTrial; j++) {
        const d = ctx.phase(j) * WAIT_POLL;
        L.setRules(sb, instant("codex", d));
        const { ms, r } = await timed(c, "ask", { target: "codex", thread_id: warmThread, message: `follow-up ${j}` }, d);
        if (!r.reply?.startsWith("bench reply")) throw new Error(`follow-up: unexpected reply ${JSON.stringify(r).slice(0, 1000)}`);
        ctx.record("followup_drained", ms);
        await L.quiesce(sb);
      }
    },
  },

  {
    id: "followup_live", trials: 6, perTrial: 2,
    cells: { followup_live: { family: FAM.start, what: "a follow-up queued on a Codex thread mid-turn, so the same worker runs it: first turn's end (registry) -> follow-up's reply" } },
    async trial(ctx) {
      const { sb, c } = await warmRoot(ctx);
      for (let j = 0; j < ctx.perTrial; j++) {
        const d = ctx.phase(j) * WAIT_POLL;
        L.setRules(sb, [
          { target: "codex", match: `HOLD-${j}`, steps: [{ awaitMark: `go-${j}` }, reply("first")] },
          { target: "codex", match: `FOLLOW-${j}`, steps: [...(d >= 1 ? [{ sleep: Math.round(d) }] : []), reply("bench reply")] },
        ]);
        const first = c.call("ask", { target: "codex", message: `HOLD-${j}` });
        let thread;
        await L.until(() => (thread = L.sql(sb, "SELECT id FROM nodes WHERE task = ?", `HOLD-${j}`)[0]?.id) && stubLog(sb).some((e) => e.event === "start" && e.prompt?.includes(`HOLD-${j}`)), "the first turn to be running");
        const second = c.call("ask", { target: "codex", thread_id: thread, message: `FOLLOW-${j}` });
        await L.until(() => L.sql(sb, "SELECT COUNT(*) AS n FROM turns WHERE node_id = ?", thread)[0].n >= 2, "the follow-up to be queued");
        fs.writeFileSync(path.join(sb.stub, `mark-go-${j}`), "");
        const [a, b] = await Promise.all([first, second]);
        const done = Date.now();
        if (a.reply !== "first" || b.reply !== "bench reply") throw new Error(`follow-up (live): unexpected replies ${JSON.stringify([a, b]).slice(0, 1000)}`);
        const turns = L.sql(sb, "SELECT id, ended_at, started_at FROM turns WHERE node_id = ? ORDER BY id", thread);
        const workers = L.sql(sb, "SELECT COUNT(*) AS n FROM launch_leaders WHERE node_id = ? AND kind = 'worker'", thread)[0].n;
        if (workers !== 1) throw new Error(`follow-up (live): expected one worker for both turns, found ${workers}`);
        ctx.record("followup_live", done - turns[0].ended_at - d);
        await L.quiesce(sb);
      }
    },
  },

  ...["changes", "nochange"].map((kind) => ({
    id: `write_${kind}`, trials: 5, perTrial: 2,
    cells: { [`write_${kind}`]: { family: FAM.start, what: kind === "changes"
      ? `delegate write job, background: false, in a ${L.LARGE_REPO.files}-file repository; the stub writes a file: call -> settled result (worktree, hard-link walk, commit)`
      : `as write_changes, but the stub changes nothing: call -> settled result (no_changes, worktree removal)` } },
    async trial(ctx) {
      const { sb, c } = await warmRoot(ctx, { repo: "large" });
      for (let j = 0; j < ctx.perTrial; j++) {
        const d = ctx.phase(j) * WAIT_POLL;
        L.setRules(sb, instant("codex", d, kind === "changes" ? [{ write: `bench-${j}.txt`, content: `bench ${j}\n` }] : []));
        const { ms, r } = await timed(c, "delegate", { target: "codex", task: `bench write ${j}`, mode: "write", background: false }, d);
        if (r.status !== "done") throw new Error(`write job did not finish done: ${JSON.stringify(r).slice(0, 1500)}`);
        if (kind === "changes" && !r.result?.files_changed_git?.includes(`bench-${j}.txt`)) throw new Error(`write job committed no change: ${JSON.stringify(r.result).slice(0, 1500)}`);
        if (kind === "nochange" && r.outcome !== "no_changes") throw new Error(`write job without changes: expected outcome no_changes, got ${JSON.stringify(r).slice(0, 1500)}`);
        ctx.record(`write_${kind}`, ms);
        await L.quiesce(sb);
      }
    },
  })),

  {
    id: "bg_accept", trials: 3, perTrial: 3,
    cells: { bg_accept: { family: FAM.start, what: `delegate write job, background (default), in a ${L.LARGE_REPO.files}-file repository: call -> returned job id (admission, worktree creation, worker start)` } },
    async trial(ctx) {
      const { sb, c } = await warmRoot(ctx, { repo: "large" });
      for (let j = 0; j < ctx.perTrial; j++) {
        L.setRules(sb, instant("codex", 0));
        const { ms, r } = await timed(c, "delegate", { target: "codex", task: `bench background ${j}`, mode: "write" });
        if (!r.job_id) throw new Error(`background delegate returned no job id: ${JSON.stringify(r).slice(0, 1000)}`);
        ctx.record("bg_accept", ms);
        await L.quiesce(sb);
      }
    },
  },

  ...[[4, "available"], [8, "constrained"]].map(([n, how]) => ({
    id: `concurrent_${n}`, trials: 5, perTrial: 2,
    cells: { [`concurrent_${n}`]: { family: FAM.start, what: `${n} simultaneous asks to stub Codex from one warm root (max_concurrent 4: capacity ${how}): first call written -> last reply read` } },
    async trial(ctx) {
      const { sb, c } = await warmRoot(ctx);
      for (let j = 0; j < ctx.perTrial; j++) {
        const d = ctx.phase(j) * WAIT_POLL;
        L.setRules(sb, instant("codex", d));
        const t0 = performance.now();
        const rs = await Promise.all(Array.from({ length: n }, (_, i) => c.call("ask", { target: "codex", message: `parallel ${j}.${i}` })));
        const ms = since(t0) - d;
        if (!rs.every((r) => r.reply?.startsWith("bench reply"))) throw new Error(`concurrent asks: unexpected replies ${JSON.stringify(rs).slice(0, 1500)}`);
        ctx.record(`concurrent_${n}`, ms);
        await L.quiesce(sb);
      }
    },
  })),

  {
    id: "discuss_round", trials: 4, perTrial: 3,
    cells: { discuss_round: { family: FAM.start, what: "discuss: open a discussion with stub Codex and get its first reply (transcript, closing-marker parse): call -> reply" } },
    async trial(ctx) {
      const { sb, c } = await warmRoot(ctx);
      for (let j = 0; j < ctx.perTrial; j++) {
        const d = ctx.phase(j) * WAIT_POLL;
        L.setRules(sb, instant("codex", d));
        const { ms, r } = await timed(c, "discuss", { target: "codex", topic: `bench topic ${j}`, message: `opening ${j}\nCONTINUE` }, d);
        if (!r.discussion_id || !JSON.stringify(r).includes("bench reply")) throw new Error(`discuss: unexpected result ${JSON.stringify(r).slice(0, 1500)}`);
        ctx.record("discuss_round", ms);
        await L.quiesce(sb);
      }
    },
  },

  // --- supervise ---
  {
    id: "status_bigrun", trials: 3, perTrial: 10,
    cells: {
      status_bigrun_noid: { family: FAM.supervise, what: "status with no id on a run of 300 settled items (threads and write jobs, 10 turns each, events seen)" },
      status_bigrun_id: { family: FAM.supervise, what: "status of one settled thread (10 turns) in that run" },
    },
    async trial(ctx) {
      const { sb, c, runId, warmThread } = await warmRoot(ctx);
      L.setRules(sb, instant("codex", 0));
      const job = await c.call("delegate", { target: "codex", task: "source job", mode: "write", background: false });
      await L.quiesce(sb);
      const made = L.seed(sb, { runId, sources: [warmThread, job.job_id], nodes: 300, turns: 10 });
      const target = made.find((id) => id.startsWith("t_"));
      await warmStatus(c, target);
      for (let j = 0; j < ctx.perTrial; j++) {
        const a = await timed(c, "status", {});
        if (a.r.nodes?.length !== 302) throw new Error(`status: expected 302 items, got ${a.r.nodes?.length}`);
        ctx.record("status_bigrun_noid", a.ms);
        const b = await timed(c, "status", { id: target });
        if (b.r.id !== target) throw new Error(`status by id: unexpected ${JSON.stringify(b.r).slice(0, 500)}`);
        ctx.record("status_bigrun_id", b.ms);
      }
    },
  },
  {
    id: "status_manyruns", trials: 3, perTrial: 10,
    cells: {
      status_manyruns_noid: { family: FAM.supervise, what: "status with no id on a small run, in a registry of 300 earlier runs (3,000 items) of ended sessions" },
      status_manyruns_id: { family: FAM.supervise, what: "status of one settled thread of that small run, in the same registry" },
    },
    async trial(ctx) {
      const { sb, c, runId, warmThread } = await warmRoot(ctx);
      L.setRules(sb, instant("codex", 0));
      const job = await c.call("delegate", { target: "codex", task: "source job", mode: "write", background: false });
      await L.quiesce(sb);
      L.seed(sb, { runId, sources: [warmThread, job.job_id], runs: 300, nodesPerRun: 10, turns: 3 });
      await warmStatus(c, warmThread);
      for (let j = 0; j < ctx.perTrial; j++) {
        const a = await timed(c, "status", {});
        if (a.r.nodes?.length !== 2) throw new Error(`status: expected 2 items, got ${a.r.nodes?.length}`);
        ctx.record("status_manyruns_noid", a.ms);
        const b = await timed(c, "status", { id: warmThread });
        if (b.r.id !== warmThread) throw new Error(`status by id: unexpected ${JSON.stringify(b.r).slice(0, 500)}`);
        ctx.record("status_manyruns_id", b.ms);
      }
    },
  },
  {
    id: "status_activewrite", trials: 3, perTrial: 6,
    cells: { status_activewrite_noid: { family: FAM.supervise, what: `status with no id while 3 write jobs run in a ${L.LARGE_REPO.files}-file repository, each with a file changed (git liveness per job)` } },
    async trial(ctx) {
      const { sb, c } = await warmRoot(ctx, { repo: "large" });
      L.setRules(sb, [{ target: "codex", steps: [{ write: "wip.txt", content: "work in progress\n" }, { awaitMark: "release" }, reply("done")] }]);
      const jobs = [];
      for (let i = 0; i < 3; i++) jobs.push((await c.call("delegate", { target: "codex", task: `active ${i}`, mode: "write" })).job_id);
      await L.until(() => stubLog(sb).filter((e) => e.event === "start" && /active \d/.test(e.prompt ?? "")).length >= 3 && jobs.every((id) => node(sb, id).status === "running"), "the three write jobs' agents to start");
      await warmStatus(c, jobs[0]);
      for (let j = 0; j < ctx.perTrial; j++) {
        const a = await timed(c, "status", {});
        const running = (a.r.nodes ?? []).filter((n) => jobs.includes(n.id) && n.status === "running");
        if (running.length !== 3 || !running.every((n) => n.liveness)) throw new Error(`status: expected 3 running write jobs with liveness: ${JSON.stringify(a.r).slice(0, 1500)}`);
        ctx.record("status_activewrite_noid", a.ms);
      }
      fs.writeFileSync(path.join(sb.stub, "mark-release"), "");
      await L.quiesce(sb);
    },
  },
  {
    id: "settle", trials: 6, perTrial: 3,
    cells: {
      settle_to_wait: { family: FAM.supervise, estimator: "mean", what: "a background read job's end (node ended_at) -> the root's waiting status (wait_s) returns it" },
      settle_to_notice: { family: FAM.supervise, estimator: "mean", what: "a background read job's end (node ended_at) -> the root's pointer notice arrives on Claude Code's inbox socket (watch loop), nothing waiting on it" },
    },
    async trial(ctx) {
      const sb = ctx.sandbox();
      L.smallRepo(sb);
      const box = await L.inbox(sb);
      const c = await L.rootSession(sb, { host: "claude", extraEnv: box.env });
      L.setRules(sb, instant("codex", 0));
      await c.call("ask", { target: "codex", message: "warm-up" });
      await L.quiesce(sb);
      for (let j = 0; j < ctx.perTrial; j++) {
        // Held until the waiting call has made two polls, then let go at a stratified point of the next period.
        L.setRules(sb, [{ target: "codex", steps: [{ await: `go-w${j}` }, reply("done")] }]);
        const job = (await c.call("delegate", { target: "codex", task: `waited ${j}`, mode: "read" })).job_id;
        await heldAt(sb, job, `waited ${j}`);
        const sent = Date.now();
        const waiting = c.call("status", { id: job, wait_s: 60 });
        await sleepUntil(sent + 2 * WAIT_POLL + ctx.phase(j) * WAIT_POLL);
        release(sb, `go-w${j}`);
        const w = await waiting;
        const got = Date.now();
        if (w.status !== "done") throw new Error(`status wait returned before the job settled: ${JSON.stringify(w).slice(0, 1000)}`);
        ctx.record("settle_to_wait", got - node(sb, job).ended_at);
        await L.quiesce(sb);

        // Let go at a stratified point of the watch loop's second, its ticks counted from initialize.
        L.setRules(sb, [{ target: "codex", steps: [{ await: `go-n${j}` }, reply("done")] }]);
        const before = box.posts.length;
        const quiet = (await c.call("delegate", { target: "codex", task: `noticed ${j}`, mode: "read" })).job_id;
        await heldAt(sb, quiet, `noticed ${j}`);
        const tick = Math.ceil((Date.now() + 100 - c.initializedAt) / WATCH_TICK);
        await sleepUntil(c.initializedAt + tick * WATCH_TICK + ctx.phase(j) * WATCH_TICK);
        release(sb, `go-n${j}`);
        await L.until(() => box.posts.slice(before).some((p) => p.text.includes(quiet)), "the pointer notice on the inbox", 30_000, 2);
        const post = box.posts.slice(before).find((p) => p.text.includes(quiet));
        ctx.record("settle_to_notice", post.t - node(sb, quiet).ended_at);
        await L.quiesce(sb);
      }
    },
  },
  {
    id: "approval", trials: 6, perTrial: 3,
    cells: {
      approval_handoff: { family: FAM.supervise, estimator: "mean", what: "a write job's agent asks for approval -> the root's waiting status returns the request (request row created -> result read)" },
      approval_continue: { family: FAM.supervise, estimator: "mean", what: "approve (allow) sent -> the agent receives the decision (stub records the answer)" },
    },
    async trial(ctx) {
      const { sb, c } = await warmRoot(ctx);
      for (let j = 0; j < ctx.perTrial; j++) {
        L.setRules(sb, [{ target: "codex", steps: [{ await: `go-a${j}` }, { request: `bench-command-${j}` }, reply("approved")] }]);
        const job = (await c.call("delegate", { target: "codex", task: `needs approval ${j}`, mode: "write" })).job_id;
        await heldAt(sb, job, `needs approval ${j}`);
        const sent = Date.now();
        const waiting = c.call("status", { id: job, wait_s: 60 });
        await sleepUntil(sent + 2 * WAIT_POLL + ctx.phase(j) * WAIT_POLL);
        release(sb, `go-a${j}`);
        const w = await waiting;
        const got = Date.now();
        const req = w.needs_approval?.[0]?.request_id;
        if (!req) throw new Error(`status wait returned without an approval request: ${JSON.stringify(w).slice(0, 1500)}`);
        const filed = L.sql(sb, "SELECT created_at FROM requests WHERE id = ?", req)[0].created_at;
        ctx.record("approval_handoff", got - filed);
        // The worker looks for a decision every DECISION_POLL from the moment it filed the request.
        await sleepUntil(filed + Math.ceil((Date.now() + 20 - filed) / DECISION_POLL) * DECISION_POLL + ctx.phase(j) * DECISION_POLL);
        const approved = Date.now();
        await c.call("approve", { request_id: req, decision: "allow" });
        await L.until(() => stubLog(sb).some((e) => e.event === "approval-answer" && e.t >= approved), "the agent to receive the decision", 30_000, 2);
        const ans = stubLog(sb).find((e) => e.event === "approval-answer" && e.t >= approved);
        if (ans.decision !== "accept") throw new Error(`the agent received ${ans.decision}, not accept`);
        ctx.record("approval_continue", ans.t - approved);
        await L.quiesce(sb);
      }
    },
  },
  {
    id: "cancel", trials: 6, perTrial: 2,
    cells: { cancel: { family: FAM.supervise, what: "cancel a running read job (stub Codex mid-turn): call written -> item cancelled and its worker and agent processes gone" } },
    async trial(ctx) {
      const { sb, c } = await warmRoot(ctx);
      for (let j = 0; j < ctx.perTrial; j++) {
        L.setRules(sb, [{ target: "codex", steps: [{ awaitMark: "never" }, reply("unreachable")] }]);
        const job = (await c.call("delegate", { target: "codex", task: `to cancel ${j}`, mode: "read" })).job_id;
        await L.until(() => stubLog(sb).some((e) => e.event === "start" && e.prompt?.includes(`to cancel ${j}`)) && node(sb, job).status === "running", "the job's agent to be running");
        const n = node(sb, job);
        const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
        const groupAlive = (g) => { try { process.kill(-g, 0); return true; } catch (e) { return e.code === "EPERM"; } };
        if (!(n.worker_pid > 0 && n.agent_pgid > 0)) throw new Error(`running job without worker or agent: ${JSON.stringify(n).slice(0, 500)}`);
        const t0 = performance.now();
        await c.call("cancel", { id: job });
        await L.until(() => node(sb, job).status === "cancelled" && !alive(n.worker_pid) && !groupAlive(n.agent_pgid), "the cancelled job's processes to be gone", 30_000, 2);
        ctx.record("cancel", since(t0));
        await L.quiesce(sb);
      }
    },
  },
  {
    id: "idle", trials: 3, perTrial: 1,
    cells: { idle_cpu: { family: FAM.supervise, unit: "ms CPU / 10 s", what: "CPU time of an idle root server over 10 s (1 s watch loop), its run holding 40 settled items; the server clamped to background QoS (efficiency cores)" } },
    async trial(ctx) {
      const sb = ctx.sandbox();
      L.smallRepo(sb);
      const cpuFile = path.join(sb.dir, "cpu.txt");
      // CPU time depends on the core a light process lands on, which macOS picks by what else is
      // running (12 against 27 ms on the same build in two runs): clamped to background QoS, the
      // server always runs on the efficiency cores.
      const c = await L.rootSession(sb, { host: "claude", launcher: false, prefix: ["/usr/sbin/taskpolicy", "-c", "background"], extraEnv: { NODE_OPTIONS: `--import ${path.join(import.meta.dirname, "cpu-probe.mjs")}`, BENCH_CPU_FILE: cpuFile } });
      L.setRules(sb, instant("codex", 0));
      const first = await c.call("ask", { target: "codex", message: "warm-up" });
      const job = await c.call("delegate", { target: "codex", task: "source job", mode: "write", background: false });
      await L.quiesce(sb);
      L.seed(sb, { runId: first.run_id, sources: [first.thread_id, job.job_id], nodes: 38, turns: 3 });
      await L.sleep(1500);
      const read = async () => {
        const before = fs.existsSync(cpuFile) ? fs.readFileSync(cpuFile, "utf8").split("\n").filter(Boolean).length : 0;
        process.kill(c.pid, "SIGUSR2");
        await L.until(() => fs.existsSync(cpuFile) && fs.readFileSync(cpuFile, "utf8").split("\n").filter(Boolean).length > before, "the CPU probe", 5000, 2);
        return Number(fs.readFileSync(cpuFile, "utf8").split("\n").filter(Boolean).at(-1)) / 1000;
      };
      const a = await read();
      await L.sleep(10_000);
      const b = await read();
      ctx.record("idle_cpu", b - a);
    },
  },

  // --- cli/maintenance ---
  {
    id: "cli", trials: 2, perTrial: 10, warmup: 0,
    cells: {
      cli_version_node: { family: FAM.cli, what: "node dist/cli.js --version (fresh process)" },
      cli_version_launcher: { family: FAM.cli, what: "bin/relay --version (the shipped launcher: Node probe, then dist/cli.js)" },
      cli_tree: { family: FAM.cli, what: "bin/relay tree on a registry whose latest run holds 300 settled items" },
    },
    async trial(ctx) {
      const { sb, c, runId, warmThread } = await warmRoot(ctx);
      L.setRules(sb, instant("codex", 0));
      const job = await c.call("delegate", { target: "codex", task: "source job", mode: "write", background: false });
      await L.quiesce(sb);
      L.seed(sb, { runId, sources: [warmThread, job.job_id], nodes: 300, turns: 3 });
      await c.close();
      sb.clients.length = 0;
      L.cli(sb, ["--version"], { launcher: false }); // one-off file-cache costs, discarded
      L.cli(sb, ["--version"]);
      for (let j = 0; j < ctx.perTrial; j++) {
        ctx.record("cli_version_node", L.cli(sb, ["--version"], { launcher: false }).ms);
        ctx.record("cli_version_launcher", L.cli(sb, ["--version"]).ms);
        const t = L.cli(sb, ["tree"]);
        if (!t.stdout.includes(runId)) throw new Error(`relay tree did not show ${runId}: ${t.stdout.slice(0, 500)}`);
        ctx.record("cli_tree", t.ms);
      }
    },
  },

  // --- diagnostics (--diag only) ---
  askScenario("diag_ask_codex_rpc15", { host: "claude", target: "codex", family: FAM.diag, stubEnv: { STUB_CODEX_RPC_DELAY_MS: "15" },
    what: "ask_codex with stub Codex answering every app-server request 15 ms late (STUB_CODEX_RPC_DELAY_MS): (this - ask_codex) / 15 = requests on the critical path" }),
];

/** Every cell, by id, with its scenario. */
export const CELLS = Object.fromEntries(SCENARIOS.flatMap((s) => Object.entries(s.cells).map(([id, c]) => [id, { ...c, unit: c.unit ?? "ms", estimator: c.estimator ?? "median", scenario: s.id }])));
