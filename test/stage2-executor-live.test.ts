import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test as nodeTest, type TestContext, type TestOptions } from "node:test";
import "./helpers.ts";
import { LiveScope } from "./live-scope.ts";
import { codexBackend, codexFlags } from "../dist/backends/codex.js";
import { setCodexHomeConfigForTests } from "../dist/backends/codex-pin.js";
import { setLeaseOptionsForTests, setStage2HookForTests, setStage2DepsForTests as setRealStage2Deps } from "../dist/backends/codex-env.js";
import { STAGE2_APP_SERVER_ENV, stage2Plan, stage2TurnReadback, type Stage2BrokerConfig } from "../dist/backends/codex-stage2.js";
import { openHttpBroker as openRealHttpBroker, type HttpBroker } from "../dist/confine/broker-http.js";
import { tcpPeerLookup } from "../dist/confine/peer.js";
import { codexToolTimeoutS } from "../dist/targets/codex.js";
import { busyPorts, portHeld } from "../dist/confine/ports.js";
import { redact, withTurnSecrets } from "../dist/core/secrets.js";
import { relayHome, withDefaults } from "../dist/core/config.js";
import { closeTurns, createRun, getNode, insertNode, insertTurn, launchLeaders, reap, setParam, updateNode, updateTurn } from "../dist/core/db.js";
import { rawNetworkKey } from "../dist/core/raw-network.js";
import { cancel } from "../dist/core/ops.js";
import { procStart, sameProcess } from "../dist/core/procs.js";
import { executorRecords, sweepOrphanedExecutors } from "../dist/core/stage2-executors.js";
import { targetDef } from "../dist/targets/index.js";
import { newInstance } from "../dist/core/caller.js";
import { openRootEnvironment } from "../dist/core/env-broker.js";
// The live fake-model homes are explicit fixtures; production never preserves home config.
const pcFixtureHomes = new Set<string>();
setCodexHomeConfigForTests((home) => pcFixtureHomes.has(home) ? fs.readFileSync(path.join(home, "config.toml"), "utf8") : undefined);
import { descendants } from "../dist/core/db.js";
import type { ApprovalAsk, TurnHandle, TurnResult, TurnSpec } from "../dist/backends/types.js";
import { sendGroupSignal } from "../dist/core/procs.js";

// WP-C live (docs/codex-confinement-design.md §13.2): W1-W7, the survivor cases, executor death and
// the resumed turn's binding, through relay's own path (codexBackend.start, openStage2,
// startCodexAppTurn) with Codex 0.164 and a fake Responses-API model on loopback. Every package is
// relay's own: D's admission, plan, readback and thread checks, A's lease and network rules, B's
// stage-2 probes. Only the port range is a scratch one (setLeaseOptionsForTests), since leases are
// kept per relay home and other relay processes on this Mac run executors in the reserved range.
// Model-free, scratch homes, our own listeners on random high ports.
// Opt-in: RELAY_TEST_STAGE2_LIVE=1 and a Codex 0.164 or later at RELAY_TEST_CODEX (default /opt/homebrew/bin/codex).

const CODEX = process.env.RELAY_TEST_CODEX ?? "/opt/homebrew/bin/codex";
const version = (() => {
  try {
    return /(\d+)\.(\d+)\.(\d+)/.exec(execFileSync(CODEX, ["--version"], { encoding: "utf8" }))?.slice(1).map(Number) ?? null;
  } catch {
    return null;
  }
})();
const skip = process.env.RELAY_TEST_STAGE2_LIVE !== "1" ? "set RELAY_TEST_STAGE2_LIVE=1 to run Codex itself"
  : process.platform !== "darwin" ? "macOS only"
  : !version || version[0] === 0 && version[1] < 164 ? `needs Codex 0.164 or later at ${CODEX}` : false;

const scopes = new AsyncLocalStorage<LiveScope>();
const scope = () => { const s = scopes.getStore(); assert.ok(s, "live resource allocated outside a test"); return s; };
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sleep = (ms: number) => scope().wait(pause(ms));
const brokers = new Set<HttpBroker>();
const children = new Map<number, string | null>();
const leasedPorts = new Set<number>();

/** Include production brokers as well as the explicitly opened self-start/checker fixtures. */
const openHttpBroker: typeof openRealHttpBroker = async (...args) => {
  const b = await openRealHttpBroker(...args);
  brokers.add(b);
  const close = b.close.bind(b);
  b.close = async () => { await close(); brokers.delete(b); };
  scope().defer(() => b.close(), -10); // all app servers and turns must be gone first
  return b;
};
const setStage2DepsForTests = (d: Parameters<typeof setRealStage2Deps>[0]) =>
  setRealStage2Deps({ ...d, openBroker: d?.openBroker ?? openHttpBroker });

function assertClean() {
  assert.equal(brokers.size, 0, "a broker from an earlier live test is still open");
  const records = executorRecords();
  assert.deepEqual(records.problems, []);
  assert.deepEqual(records.records, [], "an earlier live test left an executor record");
  assert.equal(ourExecutor(), null, "an earlier live test left a stage-2 executor");
  for (const [pid, start] of children) assert.ok(!sameProcess(pid, start, { fresh: true }), `earlier live process ${pid} is alive`);
  for (const port of leasedPorts) assert.ok(!portHeld(port), `earlier live lease ${port} is held`);
  children.clear(); leasedPorts.clear();
}

/** An internal deadline leaves time to reap resources before node:test starts the next test. */
function test(name: string, options: TestOptions, body: (t: TestContext) => Promise<void>) {
  return nodeTest(name, { ...options, timeout: (options.timeout ?? 120_000) + 30_000 }, async (t) => {
    assertClean();
    const s = new LiveScope();
    await scopes.run(s, async () => {
      setStage2DepsForTests(null);
      const abort = () => s.controller.abort(new Error(`live test cancelled: ${name}`));
      t.signal.addEventListener("abort", abort, { once: true });
      const deadline = setTimeout(() => s.controller.abort(new Error(`live test deadline: ${name}`)), options.timeout ?? 120_000);
      const work = Promise.resolve().then(() => body(t));
      try { await s.wait(work); }
      finally {
        clearTimeout(deadline);
        try { await s.close(); }
        finally {
          // Signal-aware waits unwind the test's own finally blocks too, before globals reset.
          await work.catch(() => {});
          t.signal.removeEventListener("abort", abort);
          setRealStage2Deps(null); setStage2HookForTests(null); setLeaseOptionsForTests(null);
          assertClean();
        }
      }
    });
  });
}
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
};
const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 };
const sse = (evs: unknown[]) => evs.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const exec = (cmd: string, extra: Record<string, unknown> = {}) => ({ type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd, login: false, timeout_ms: 15000, ...extra }) });
const patch = (file: string, text: string) => ({ type: "custom_tool_call", name: "apply_patch", input: `*** Begin Patch\n*** Add File: ${file}\n+${text}\n*** End Patch\n` });
/** A multi-agent v2 call: the fixture's mock-model is code_mode_only with multi_agent_version v2, whose tools are in the "collaboration" namespace. */
const collab = (name: string, args: Record<string, unknown>) => ({ type: "function_call", name, namespace: "collaboration", arguments: JSON.stringify(args) });
const brokerSearch = () => ({ type: "tool_search_call", execution: "client", arguments: { query: "relay status delegate", limit: 10 } });
const brokerCall = (name: string, args: Record<string, unknown> = {}) => ({ type: "function_call", namespace: "mcp__relay_tools", name, arguments: JSON.stringify(args) });

/** Deadline-based condition, with no unbounded model/server waits in the added broker probes. */
async function brokerUntil(check: () => boolean, what: string, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (check()) return;
  assert.fail(`timed out waiting for ${what}`);
}

/** Our own listener on a random high port, counting what connects. */
async function listener(port = 0): Promise<{ port: number; accepted: () => number; close: () => Promise<void> }> {
  let n = 0;
  const sockets = new Set<net.Socket>();
  const s = net.createServer((c) => { sockets.add(c); c.once("close", () => sockets.delete(c)); n++; c.on("error", () => {}); c.end("x"); });
  const close = scope().defer(async () => {
    for (const c of sockets) c.destroy();
    await new Promise<void>((r) => s.close(() => r()));
  });
  await scope().wait(new Promise<void>((resolve, reject) => { s.once("error", reject); s.listen(port, "127.0.0.1", () => resolve()); }));
  return { port: (s.address() as net.AddressInfo).port, accepted: () => n, close };
}

async function connectionResult(port: number): Promise<string> {
  const c = net.connect(port, "127.0.0.1");
  const close = scope().defer(() => { c.destroy(); });
  try {
    return await scope().wait(new Promise<string>((resolve) => {
      c.setTimeout(3000, () => resolve("timeout"));
      c.once("connect", () => resolve("connected"));
      c.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "error"));
    }));
  } finally { await close(); }
}

/** A free high port, closed again: for a listener opened only after the turn's listening snapshot. */
async function freePort(): Promise<number> {
  const l = await listener();
  await l.close();
  return l.port;
}

/** A scratch lease range of 16 high ports nothing listens on. */
function scratchRange(): { first: number; count: number } {
  for (let i = 0; i < 50; i++) {
    const first = 50000 + 16 * Math.floor(Math.random() * 600);
    if (!busyPorts(Array.from({ length: 16 }, (_, k) => first + k)).size) return { first, count: 16 };
  }
  throw new Error("no free scratch range");
}

/** One conversation the fake model holds: the first whose `match` the newest matching message contains, else the one without. */
interface Conv { match?: string; calls: unknown[] }

/**
 * The fake Responses API: each request goes to a conversation (the newest user or agent message
 * that contains a conversation's `match`, else the conversation without one), which answers with its
 * next scripted call, numbered by the outputs of its own calls the input already holds, and then a
 * final message. Records every request body and each conversation's outputs.
 */
class FakeModel {
  #convs: Conv[] = [];
  /** Bumped with each new set of conversations: call ids carry it, so a resumed thread's history from an earlier turn is never counted again. */
  epoch = 0;
  bodies: { epoch: number; conv: number; raw: string }[] = [];
  outs = new Map<number, Map<string, string>>();
  get convs(): Conv[] {
    return this.#convs;
  }
  set convs(c: Conv[]) {
    this.#convs = c;
    this.epoch++;
    this.outs = new Map();
  }
  hook: ((conv: number, step: number) => Promise<void> | void) | null = null;
  port = 0;
  private server = http.createServer((q, s) => {
    let b = "";
    q.on("data", (d) => (b += d));
    q.on("end", async () => {
      if (q.method !== "POST" || !q.url?.includes("/responses")) { s.writeHead(404); s.end("{}"); return; }
      const body = JSON.parse(b);
      const conv = this.route(body.input ?? []);
      this.bodies.push({ epoch: this.epoch, conv, raw: b });
      const prefix = `e${this.epoch}c${conv}-`;
      const mine = (body.input ?? []).filter((i: { type?: string; call_id?: string }) => /(?:_call_output|tool_search_output)$/.test(i?.type ?? "") && String(i.call_id ?? "").startsWith(prefix));
      const got = this.outs.get(conv) ?? new Map<string, string>();
      for (const x of mine) if (!got.has(x.call_id)) got.set(x.call_id, typeof x.output === "string" ? x.output : JSON.stringify(x.output ?? x.tools ?? x));
      this.outs.set(conv, got);
      const step = mine.length;
      // Hook assertions must reach the test: swallowing them can produce a misleading green turn.
      try { await this.hook?.(conv, step); }
      catch (err) { scope().controller.abort(err); s.destroy(); return; }
      if (s.destroyed) return;
      const call = conv >= 0 ? this.#convs[conv].calls[step] : undefined;
      s.writeHead(200, { "content-type": "text/event-stream" });
      if (call) {
        const id = `${prefix}${step}`;
        s.end(sse([{ type: "response.created", response: { id: `r${id}` } }, { type: "response.output_item.done", item: { ...(call as object), call_id: id, id: `i${id}` } }, { type: "response.completed", response: { id: `r${id}`, usage } }]));
      } else {
        s.end(sse([{ type: "response.created", response: { id: "rz" } }, { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "mz", content: [{ type: "output_text", text: "done" }] } }, { type: "response.completed", response: { id: "rz", usage } }]));
      }
    });
  });

  private route(input: { type?: string; content?: unknown }[]): number {
    const text = (i: { content?: unknown }) => typeof i.content === "string" ? i.content : ((i.content ?? []) as { text?: string; encrypted_content?: string }[]).map((c) => c?.text ?? c?.encrypted_content ?? "").join("");
    const msgs = input.filter((i) => i?.type === "message" || i?.type === "agent_message");
    for (let k = msgs.length - 1; k >= 0; k--) {
      const t = text(msgs[k]);
      const hit = this.#convs.findIndex((c) => c.match !== undefined && t.includes(c.match));
      if (hit >= 0) return hit;
    }
    return this.#convs.findIndex((c) => c.match === undefined);
  }

  /** The outputs of a conversation's calls (current conversations), in order. */
  outputs(conv: number): string[] {
    return [...(this.outs.get(conv) ?? new Map<string, string>()).entries()].sort(([a], [b]) => Number(a.split("-")[1]) - Number(b.split("-")[1])).map(([, v]) => v);
  }
  /** How often a conversation (of the current ones) was asked. */
  asked(conv: number): number {
    return this.bodies.filter((b) => b.epoch === this.epoch && b.conv === conv).length;
  }
  async start() {
    this.close = scope().defer(async () => {
      this.hook = null;
      this.server.closeAllConnections();
      await new Promise<void>((r) => this.server.close(() => r()));
    }, -20);
    await scope().wait(new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    }));
    this.port = (this.server.address() as net.AddressInfo).port;
  }
  close = async () => {};
}

/** A scratch session: its directories, CODEX_HOME and fake model, kept across the turns of one Codex thread, and its job in the registry. */
interface Scratch { root: string; cwd: string; out: string; appHome: string; home: string; model: FakeModel; range: { first: number; count: number }; runId: string; nodeId: string }

/** The raw-network grant every live turn holds. */
const GRANT = { network: true, raw_network: true };
let liveRun: string | null = null;
let liveNodes = 0;

/** The session's job, registered with the person's consent stored for GRANT, as session.ts records the person's answer (review R2). */
function registerJob(root: string, cwd: string): { runId: string; nodeId: string } {
  liveRun ??= createRun(root, withDefaults({}), "s2-live");
  const nodeId = `j_s2live${String(++liveNodes).padStart(3, "0")}`;
  insertNode({ id: nodeId, run_id: liveRun, kind: "job", target: "codex", mode: "write", depth: 1, task: "stage-2 live", cwd, status: "running" });
  setParam(nodeId, "raw_network_consent", { grant: rawNetworkKey(GRANT as never), by: "by the user", at: Date.now() });
  return { runId: liveRun, nodeId };
}
type Dirs = Pick<Scratch, "cwd" | "out" | "appHome" | "root">;

/** git in a scratch directory, with this test process's scratch home and no system config. */
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=s2@relay.test", "-c", "user.name=s2", ...args], { cwd, stdio: "pipe", env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: os.homedir(), GIT_CONFIG_NOSYSTEM: "1" } });

/**
 * A scratch session. Its cwd is a git repository, as a real job's is: a plain checkout, or (`git:
 * "worktree"`) a worktree of another repository laid out as relay makes them (a `.git` file pointing
 * into the main repository's `.git/worktrees`). Codex writes a new thread's rollout late in a git cwd
 * (stage2TurnReadback), which a plain directory would hide.
 */
async function scratchSession(o: { mcp?: (d: Dirs) => string; rules?: string; git?: "checkout" | "worktree" } = {}): Promise<Scratch> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2l-")));
  const cwd = path.join(root, "w"), out = path.join(root, "out"), appHome = path.join(root, "apphome");
  for (const d of [out, appHome]) fs.mkdirSync(d, { recursive: true });
  const repo = o.git === "worktree" ? path.join(root, "repo") : cwd;
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "stage-2 live test\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "base");
  if (o.git === "worktree") git(repo, "worktree", "add", "-q", "-b", "relay/j_s2live", cwd);
  assert.ok(fs.existsSync(path.join(cwd, ".git")), "the cwd is a git repository");
  const home = os.homedir(); // helpers.ts: a scratch home for this test process
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "decoy"), "not the agent's\n");
  const model = new FakeModel();
  await model.start();
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "stage2-catalog.json"), path.join(root, "catalog.json"));
  fs.writeFileSync(path.join(appHome, "config.toml"), [
    'model = "mock-model"', `openai_base_url = "http://127.0.0.1:${model.port}/v1"`, `model_catalog_json = ${JSON.stringify(path.join(root, "catalog.json"))}`,
    ...(o.mcp ? [`[mcp_servers.mark]`, `command = "/bin/sh"`, `args = ["-c", ${JSON.stringify(o.mcp({ cwd, out, appHome, root }))}]`] : []), "",
  ].join("\n"));
  pcFixtureHomes.add(appHome);
  // A fake key for the fake model, written into the scratch home only.
  fs.writeFileSync(path.join(appHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-relay-stage2-fake-model" }));
  if (o.rules) {
    fs.mkdirSync(path.join(appHome, "rules"));
    fs.writeFileSync(path.join(appHome, "rules", "default.rules"), o.rules);
  }
  return { root, cwd, out, appHome, home, model, range: scratchRange(), ...registerJob(root, cwd) };
}

interface Live {
  root: string; cwd: string; out: string; appHome: string; home: string;
  /** The executor's port, then the job's block, as the executor's argv and environment showed them. */
  ports: number[];
  /** The outputs of the default conversation's calls. */
  outputs: string[];
  result: TurnResult;
  /** Texts captured while the turn ran, checked for the token by redaction once it is over. */
  captured: { what: string; text: string }[];
  tokenIn: string[];
  approvals: ApprovalAsk[];
  executorPid: number;
  appPid: number;
}

type Ctx = { executorPid: () => number; appPid: () => number; execPort: () => number; capture: (what: string, text: string) => void; tmpDirs: () => string[] };

/** The executor this test process started (codexBackend runs in-process): pid, port, block. */
function ourExecutor(): { pid: number; port: number; block: number[] } | null {
  const pid = Number(spawnSync("/usr/bin/pgrep", ["-P", String(process.pid), "-f", "exec-server --listen ws://127.0.0.1:"], { encoding: "utf8" }).stdout.trim().split("\n")[0] || 0);
  if (!pid) return null;
  const ps = spawnSync("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
  const port = Number(/--listen ws:\/\/127\.0\.0\.1:(\d+) /.exec(ps)?.[1] ?? 0);
  const block = (/PORTS=([\d,]+)/.exec(ps)?.[1] ?? "").split(",").filter(Boolean).map(Number);
  return { pid, port, block };
}

/**
 * One turn through codexBackend.start with stage 2 switched on (config targets.codex.stage2) in
 * session `s`. `convs` replace the model's conversations; `onRequest(conv, step, ctx)` runs when the
 * model is asked (before it answers).
 */
async function relayTurn(s: Scratch, o: {
  convs: Conv[];
  prompt?: string;
  sessionId?: string;
  approve?: boolean;
  onRequest?: (conv: number, step: number, ctx: Ctx) => Promise<void> | void;
  broker?: boolean;
}): Promise<Live> {
  const captured: { what: string; text: string }[] = [];
  let executorPid = 0, appPid = 0;
  let ports: number[] = [];
  const look = () => {
    if (executorPid && ports.length) return;
    const ex = ourExecutor();
    if (ex) (executorPid = ex.pid), (ports = [ex.port, ...ex.block]);
  };
  const ctx: Ctx = {
    executorPid: () => (look(), executorPid),
    appPid: () => appPid,
    execPort: () => (look(), ports[0]),
    capture: (what, text) => void captured.push({ what, text }),
    tmpDirs: () => fs.readdirSync(path.join(s.home, ".rn")).map((n) => path.join(s.home, ".rn", n)),
  };
  s.model.convs = o.convs;
  s.model.hook = async (conv, step) => {
    look();
    await o.onRequest?.(conv, step, ctx);
  };
  const approvals: ApprovalAsk[] = [];
  const brokerTurn = o.broker ? insertTurn(s.nodeId, "test", "broker live", "write", "running") : undefined;
  const spec = {
    target: targetDef("codex"), prompt: o.prompt ?? "go", cwd: s.cwd, dir: s.root, logPath: path.join(s.root, "agent.log"), access: "write",
    relay: o.broker ? { runId: s.runId, nodeId: s.nodeId, depth: 1, turnId: brokerTurn, mayDelegate: true, mayAsk: false } : null,
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    config: withDefaults({ codex_backend: "app-server", child_auth: "any", codex_endpoint_override: "accept", child_mcp: "relay-only", cancel_grace_ms: 2000, targets: { codex: { bin: CODEX, stage2: true, home: s.appHome, pinned: false } } }),
    environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: s.home, CODEX_HOME: s.appHome, SHELL: "/bin/zsh" },
    markers: { runId: s.runId, nodeId: s.nodeId, depth: 1 },
    grant: GRANT,
    signal: scope().signal,
    escalate: Boolean(o.approve),
    onApproval: async (ask: ApprovalAsk) => { approvals.push(ask); return { decision: o.approve ? "allow" : "deny" }; },
  } as unknown as TurnSpec;
  let result!: TurnResult;
  const tokenIn: string[] = [];
  setLeaseOptionsForTests({ range: s.range });
  for (let p = s.range.first; p < s.range.first + s.range.count; p++) leasedPorts.add(p);
  let stop: (() => Promise<void>) | undefined;
  try {
    await withTurnSecrets(async () => {
      const starting: Promise<TurnHandle> = codexBackend.start(spec);
      let finished = false;
      void starting.then((h) => h.done.then(() => { finished = true; }), () => {});
      stop = scope().defer(async () => {
        const h = await starting.catch(() => null);
        if (h) { if (!finished) await h.cancel(); await h.done; }
      }, 10);
      const handle = await scope().wait(starting);
      appPid = handle.pid ?? 0;
      children.set(appPid, handle.startedAt);
      result = await scope().wait(handle.done);
      // The token, wherever it showed: only redaction knows it, so only redaction can tell.
      for (const c of captured) if (redact(c.text).includes("[redacted: executor token]")) tokenIn.push(c.what);
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile() && redact(fs.readFileSync(p, "latin1")).includes("[redacted: executor token]")) tokenIn.push(p);
        }
      };
      walk(s.root);
    });
  } finally {
    try { await stop?.(); }
    finally {
      if (brokerTurn) updateTurn(brokerTurn, { status: result?.status === "ok" ? "done" : "failed" });
      setLeaseOptionsForTests(null);
      s.model.hook = null;
    }
  }
  const def = o.convs.findIndex((c) => c.match === undefined);
  return { root: s.root, cwd: s.cwd, out: s.out, appHome: s.appHome, home: s.home, ports, outputs: def >= 0 ? s.model.outputs(def) : [], result, captured, tokenIn, approvals, executorPid, appPid };
}

/** One turn in a fresh session, with one conversation: `calls`; `onRequest(step, ctx)` when the model is asked. */
async function liveTurn(o: {
  calls: (d: Dirs) => unknown[];
  rules?: string;
  mcp?: (d: Dirs) => string;
  git?: "checkout" | "worktree";
  approve?: boolean;
  onRequest?: (step: number, ctx: Ctx) => Promise<void> | void;
}): Promise<Live> {
  const s = await scratchSession({ mcp: o.mcp, rules: o.rules, git: o.git });
  try {
    return await relayTurn(s, { convs: [{ calls: o.calls(s) }], approve: o.approve, onRequest: (conv, step, ctx) => (conv === 0 ? o.onRequest?.(step, ctx) : undefined) });
  } finally {
    await s.model.close();
  }
}

const pidsIn = (dir: string, prefix: string) => fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).map((n) => Number(fs.readFileSync(path.join(dir, n), "utf8").trim())).filter((n) => n > 1);

/** Every file under `dirs`, read now (they are gone once the turn is over). */
function captureFiles(capture: (what: string, text: string) => void, dirs: string[]) {
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) try { capture(p, fs.readFileSync(p, "latin1")); } catch { /* raced */ }
    }
  };
  for (const d of dirs) try { walk(d); } catch { /* gone */ }
}

const psEnv = (pid: number) => spawnSync("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;

/**
 * Codex itself, outside relay: an app server on the session's CODEX_HOME, for what a person's other
 * client could do to the stored thread (queue a message, set a goal) and for the unbound control.
 * `o.args` (relay's stage-2 flags, say) and `o.env` (relay's STAGE2_APP_SERVER_ENV, say) are added.
 */
function directAppServer(s: Scratch, o: { args?: string[]; env?: Record<string, string> } = {}) {
  const child = spawn(CODEX, ["app-server", ...(o.args ?? [])], { cwd: s.cwd, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: s.home, CODEX_HOME: s.appHome, ...(o.env ?? {}) }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  children.set(child.pid!, procStart(child.pid!, { fresh: true }));
  let id = 1;
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const notes: { method?: string; params?: any }[] = [];
  readline.createInterface({ input: child.stdout! }).on("line", (line) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method === undefined) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) w?.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
      else w?.resolve(m.result);
    } else if (m.id !== undefined) child.stdin!.write(JSON.stringify({ id: m.id, error: { code: -32000, message: "declined by the test" } }) + "\n");
    else notes.push(m);
  });
  child.stderr!.on("data", () => {});
  child.once("exit", () => {
    for (const w of waiting.values()) w.reject(new Error("direct app server exited"));
    waiting.clear();
  });
  const request = (method: string, params: unknown) => scope().wait(new Promise<any>((resolve, reject) => {
    const n = id++;
    waiting.set(n, { resolve, reject });
    child.stdin!.write(JSON.stringify({ id: n, method, params }) + "\n");
  }));
  const stop = scope().defer(async () => {
    try { sendGroupSignal(child.pid!, "SIGKILL"); } catch { /* gone */ }
    for (let i = 0; i < 100 && !gone(child.pid!); i++) await pause(20);
    child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
    assert.ok(gone(child.pid!), "direct app server reaped");
  }, 10);
  return {
    pid: child.pid!, notes, request,
    async hello() {
      await request("initialize", { clientInfo: { name: "s2-test", title: "s2-test", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      child.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
    },
    async until(pred: (m: { method?: string; params?: any }) => boolean, ms: number) {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (notes.some(pred)) return true;
      return false;
    },
    stop,
  };
}

test("BB broker production order: the model's first relay status call is served while turn readback waits, without manual arm", { skip, timeout: 120_000 }, async () => {
  const s = await scratchSession();
  let readbackWaiting = false, servedDuringReadback = false;
  let releaseModel!: () => void;
  const checked = new Promise<void>((resolve) => { releaseModel = resolve; });
  setStage2DepsForTests({ turnReadback: async (...args) => {
    readbackWaiting = true;
    try {
      await brokerUntil(() => s.model.outputs(0).length >= 2, "the first real broker status output during readback");
      const result = await stage2TurnReadback(...args);
      servedDuringReadback = true;
      return result;
    } finally { releaseModel(); }
  } });
  try {
    const live = await relayTurn(s, { broker: true, convs: [{ calls: [brokerSearch(), brokerCall("status")] }], onRequest: async (_conv, step) => {
      if (step === 2) { assert.ok(readbackWaiting); await checked; }
    } });
    assert.equal(live.result.status, "ok", JSON.stringify(live.result));
    assert.ok(servedDuringReadback);
    assert.match(live.outputs[1] ?? "", new RegExp(s.nodeId));
    assert.doesNotMatch(live.outputs[1] ?? "", /turn has not started|isError.*true/);
  } finally { releaseModel(); setStage2DepsForTests(null); await s.model.close(); }
});

test("BB broker self-start: a queued turn before relay's turn/start is refused relay tools", { skip, timeout: 120_000 }, async () => {
  const s = await scratchSession();
  let broker: Awaited<ReturnType<typeof openHttpBroker>> | undefined;
  let app: ReturnType<typeof directAppServer> | undefined;
  const refusals: string[] = [];
  try {
    const first = await relayTurn(s, { convs: [{ calls: [] }] });
    assert.equal(first.result.status, "ok", JSON.stringify(first.result));
    const threadId = first.result.sessionId!;
    const queue = directAppServer(s);
    try {
      await queue.hello();
      await queue.request("thread/unarchive", { threadId }).catch(() => {});
      await queue.request("thread/queue/add", { threadId, input: [{ type: "text", text: "BB-SELF-START", text_elements: [] }], clientUserMessageId: "bb-self" });
    } finally { await queue.stop(); }
    s.model.convs = [{ calls: [brokerSearch(), brokerCall("status")] }];
    const turnId = insertTurn(s.nodeId, "test", "self-start broker", "write", "running");
    await withTurnSecrets(async () => {
      broker = await openHttpBroker({ nodeId: s.nodeId, turnId, mayDelegate: true, mayAsk: false }, await freePort(), { onRefusal: (why) => refusals.push(why) });
      app = directAppServer(s, { args: relayFlags(s, { broker: { url: broker.url, toolTimeoutS: codexToolTimeoutS(300) } }),
        env: { ...STAGE2_APP_SERVER_ENV, ...broker.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" } });
      const start = procStart(app.pid, { fresh: true }); assert.ok(start);
      broker.bindAppServer({ pid: app.pid, start });
      await app.hello();
      // No relay turn/start and no arm: Codex consumes the queued message on resume itself.
      await app.request("thread/resume", { threadId, cwd: s.cwd, runtimeWorkspaceRoots: [s.cwd], permissions: ":danger-full-access", approvalPolicy: "on-request", approvalsReviewer: "user", excludeTurns: true });
      assert.ok(await app.until((m) => m.method === "turn/completed", 60_000));
      assert.match(s.model.outputs(0)[1] ?? "", /relay's turn has not started/);
      assert.ok(refusals.some((r) => r.includes("turn has not started")));
      await app.stop(); app = undefined;
      await broker.close(); broker = undefined;
    });
  } finally { await app?.stop(); await broker?.close(); await s.model.close(); }
});

test("BB broker mid-turn checker failure: kill app server before failing the turn and before closing listeners", { skip, timeout: 120_000 }, async (t) => {
  const s = await scratchSession();
  let failPeer = false, appPid = 0;
  const sockets = new Set<net.Socket>(), order: string[] = [];
  const kill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid: number, sig?: NodeJS.Signals | number) => {
    if (pid === -appPid && sig === "SIGKILL") order.push("app-kill");
    return kill(pid, sig);
  });
  setStage2DepsForTests({ openBroker: async (turn, port) => {
    const b = await openHttpBroker(turn, port, {
      network: { connect: net.createConnection, createServer(options, accept) {
        return net.createServer(options, (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); accept(socket); });
      } },
      peer: (p, sock) => failPeer ? Promise.resolve({ error: "BB injected checker failure" }) : tcpPeerLookup(p, sock),
    });
    return { ...b,
      onFatal(fail) { b.onFatal((why) => { order.push("fatal"); fail(why); order.push("failed"); }); },
      async close() { assert.ok(gone(appPid), "app server reaped before listeners close"); order.push("broker-close"); await b.close(); },
    };
  } });
  try {
    const live = await relayTurn(s, { broker: true, convs: [{ calls: [brokerSearch(), brokerCall("status")] }], onRequest: (_c, step, ctx) => {
      appPid = ctx.appPid();
      if (step === 2) {
        assert.match(s.model.outputs(0)[1] ?? "", new RegExp(s.nodeId), "a tool was served before breaking the checker");
        failPeer = true;
        // Force a fresh peer lookup on Codex's event-stream reconnect, keeping all listeners up.
        for (const socket of sockets) socket.destroy();
        return brokerUntil(() => order.includes("fatal"), "the real broker's fatal checker path");
      }
    } });
    assert.equal(live.result.status, "failed", JSON.stringify(live.result));
    assert.match(live.result.error ?? "", /TCP peer|checker/);
    assert.ok(order.indexOf("fatal") < order.indexOf("app-kill"));
    assert.ok(order.indexOf("app-kill") < order.indexOf("failed"));
    assert.ok(order.indexOf("failed") < order.indexOf("broker-close"));
  } finally { setStage2DepsForTests(null); t.mock.restoreAll(); await s.model.close(); }
});

test("BB broker nested delegation: status and delegate reach relay's real server and a Claude stub child finishes", { skip, timeout: 120_000 }, async () => {
  const s = await scratchSession();
  const owner = newInstance({ kind: "root" }, s.cwd, "codex");
  owner.token = "s2-live"; // registerJob's registry owner, for the real worker environment authority.
  const stubDir = path.join(s.root, "stub"); fs.mkdirSync(stubDir);
  fs.writeFileSync(path.join(stubDir, "log.jsonl"), "");
  const bin = path.join(s.root, "stub-claude");
  // The executable itself names only fixture modules; no installed Claude CLI or model is used.
  fs.writeFileSync(bin, `#!${process.execPath}\nprocess.env.STUB_DIR = ${JSON.stringify(stubDir)};\nconst { main } = await import(${JSON.stringify(new URL("./stubs/stub-agent.mjs", import.meta.url).href)});\nconst { default: claude } = await import(${JSON.stringify(new URL("./stubs/targets/claude.mjs", import.meta.url).href)});\nawait main(claude);\n`, { mode: 0o755 });
  // This test has its own run, so it cannot change the config of other live sessions.
  const cfg = withDefaults({ allow_temp_home: true, child_auth: "any", block_s: 30, targets: { claude: { bin } } });
  const runId = createRun(s.cwd, cfg, owner.token);
  const nodeId = `j_s2nest${String(++liveNodes).padStart(3, "0")}`;
  insertNode({ id: nodeId, run_id: runId, kind: "job", target: "codex", mode: "write", depth: 1, task: "nested broker test", cwd: s.cwd, status: "running" });
  setParam(nodeId, "raw_network_consent", { grant: rawNetworkKey(GRANT as never), by: "by the user", at: Date.now() });
  const configFile = path.join(relayHome(), "config.json");
  const priorConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile) : null;
  fs.mkdirSync(relayHome(), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ allow_temp_home: true, child_auth: "any" }));
  // A fixture worker must never sweep the Mac's shared temp directory on its way out.
  fs.writeFileSync(path.join(relayHome(), "housekeeping"), "marked done by the live fixture\n");
  let authority: Awaited<ReturnType<typeof openRootEnvironment>> | undefined;
  const cleanup = scope().defer(async () => {
    try {
      for (const child of descendants(nodeId)) {
        // The registry clears worker_pid just before worker exit; remember the launched pid too.
        const workers = launchLeaders().filter((p) => p.kind === "worker" && p.node_id === child.id);
        for (const p of workers) children.set(p.leader_pid, p.start);
        if (!["done", "failed", "cancelled"].includes(child.status)) await cancel(owner, { id: child.id });
        for (let i = 0; i < 500; i++) {
          const n = getNode(child.id);
          if (!n?.worker_pid || n.worker_pid > 0 && gone(n.worker_pid)) break;
          await pause(20);
        }
        const n = getNode(child.id);
        assert.ok(!n?.worker_pid || n.worker_pid > 0 && gone(n.worker_pid), "the nested fixture worker stopped");
        for (let i = 0; i < 500 && workers.some((p) => sameProcess(p.leader_pid, p.start, { fresh: true })); i++) await pause(20);
        assert.ok(workers.every((p) => !sameProcess(p.leader_pid, p.start, { fresh: true })), "nested workers exited after clearing the registry");
      }
    } finally {
      await authority?.close();
      if (priorConfig) fs.writeFileSync(configFile, priorConfig); else fs.rmSync(configFile, { force: true });
    }
  });
  try {
    authority = await openRootEnvironment(owner);
    const nested = { ...s, runId, nodeId };
    const live = await relayTurn(nested, { broker: true, convs: [{ calls: [brokerSearch(), brokerCall("status"),
      brokerCall("delegate", { target: "claude", mode: "read", task: "BB nested fixture: reply with the stub's default answer", allow_delegation: false, background: false }),
    ] }] });
    assert.equal(live.result.status, "ok", JSON.stringify(live.result));
    assert.match(live.outputs[1] ?? "", new RegExp(nodeId));
    assert.match(live.outputs[2] ?? "", /stub claude reply/);
    const children = descendants(nodeId);
    assert.equal(children.length, 1);
    assert.equal(children[0].target, "claude");
    assert.equal(children[0].status, "done");
    assert.match(fs.readFileSync(path.join(stubDir, "log.jsonl"), "utf8"), /"event":"start"/);
  } finally {
    await cleanup();
    await s.model.close();
  }
});

/** A `codex exec-server` of the test's own, outside every sandbox, for the unbound control. */
async function plainExecServer(root: string): Promise<{ url: string; token: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const home = path.join(root, "control-exec-home");
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(CODEX, ["exec-server", "--listen", `ws://127.0.0.1:${port}`, "--ws-auth", "capability-token", "--ws-token-sha256", hash], { env: { PATH: "/usr/bin:/bin", HOME: os.homedir(), CODEX_HOME: home }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.set(child.pid!, procStart(child.pid!, { fresh: true }));
  const stop = scope().defer(async () => {
    try { sendGroupSignal(child.pid!, "SIGKILL"); } catch { /* gone */ }
    for (let i = 0; i < 100 && !gone(child.pid!); i++) await pause(20);
    child.stdout!.destroy(); child.stderr!.destroy();
    assert.ok(gone(child.pid!), "control exec server reaped");
  }, 10);
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  for (let i = 0; i < 400 && !out.includes(`ws://127.0.0.1:${port}`); i++) await sleep(25);
  return {
    url: `ws://127.0.0.1:${port}`, token,
    stop,
  };
}

test("W1, W5, W7 (token): commands and patches confined; listening ports denied; ~/.codex unreadable; the token in no argv, environment or file", { skip }, async () => {
  // Listening before the turn: in the turn's listening snapshot, so denied (D4). Opened only after it: reachable.
  const deny = await listener();
  const okPort = await freePort();
  let ok: Awaited<ReturnType<typeof listener>> | null = null;
  try {
    let hash = "";
    const live = await liveTurn({
      git: "worktree",
      calls: (d) => [
        exec([
          "touch in_wt; echo wt=$?",
          `touch ${d.out}/proof; echo out=$?`,
          `/usr/bin/nc -z -w1 127.0.0.1 ${deny.port}; echo ncdeny=$?`,
          `/usr/bin/nc -z -w1 127.0.0.1 ${okPort}; echo ncok=$?`,
          "ls ~/.codex >/dev/null 2>&1; echo lscodex=$?",
          `cat ${d.appHome}/auth.json >/dev/null 2>&1; echo readauth=$?`,
          `echo x >> ${d.appHome}/config.toml; echo writecfg=$?`,
          "echo port=$PORT ports=$PORTS home=$CODEX_HOME",
          `/usr/bin/perl -MIO::Socket::INET -e 'IO::Socket::INET->new(LocalAddr=>"127.0.0.1",LocalPort=>$ARGV[0],Listen=>1) or exit 1' $PORT; echo bindblock=$?`,
          `/usr/bin/perl -MIO::Socket::INET -e 'IO::Socket::INET->new(LocalAddr=>"127.0.0.1",LocalPort=>$ARGV[0],Listen=>1) or exit 1' ${okPort}; echo bindother=$?`,
          "env > env.txt",
        ].join("; ")),
        patch(`${d.out}/patched.txt`, "outside"),
        patch("patched_in.txt", "inside"),
      ],
      onRequest: async (step, ctx) => {
        if (step === 0) ok = await listener(okPort);
        if (step !== 3) return;
        // While everything still runs: the executor's and the app server's argv and environment, and the turn's temp dirs.
        const ex = ctx.executorPid();
        assert.ok(ex > 1, "executor found");
        const exPs = psEnv(ex);
        hash = /--ws-token-sha256 ([0-9a-f]{64})/.exec(exPs)?.[1] ?? "";
        ctx.capture("executor ps eww", exPs);
        ctx.capture("app server ps eww", psEnv(ctx.appPid()));
        captureFiles(ctx.capture, ctx.tmpDirs());
      },
    });
    assert.equal(live.result.status, "ok", JSON.stringify(live.result));
    const [cmd, outside, inside] = live.outputs;
    for (const want of ["wt=0", "out=1", "ncdeny=1", "ncok=0", "lscodex=1", "readauth=1", "writecfg=1", "bindblock=0", "bindother=1",
      `port=${live.ports[1]} ports=${live.ports.slice(1, 5).join(",")}`]) assert.ok(cmd.includes(want), `${want} in ${cmd}`);
    assert.equal(deny.accepted(), 0, "the denied port saw no connection");
    assert.ok((ok as Awaited<ReturnType<typeof listener>> | null)!.accepted() >= 1);
    assert.ok(!fs.existsSync(path.join(live.out, "proof")));
    assert.match(outside, /Failed to write file/);
    assert.ok(!fs.existsSync(path.join(live.out, "patched.txt")));
    assert.match(inside, /Success/);
    assert.equal(fs.readFileSync(path.join(live.cwd, "patched_in.txt"), "utf8"), "inside\n");
    // The command's environment came from the executor: the turn's temp dir, its CODEX_HOME.
    const env = fs.readFileSync(path.join(live.cwd, "env.txt"), "utf8");
    assert.match(env, /^CODEX_HOME=.*\/codex-exec-home$/m);
    assert.doesNotMatch(env, new RegExp(`=${live.appHome}`));
    assert.match(hash, /^[0-9a-f]{64}$/, "the hash is in the executor's argv");
    assert.ok(live.captured.length >= 2, JSON.stringify(live.captured.map((c) => [c.what, c.text.slice(0, 200)])));
    assert.deepEqual(live.tokenIn, [], "the token is in no argv, environment or file (temp dirs, worktree, app server's CODEX_HOME, agent log)");
  } finally {
    await deny.close();
    await (ok as Awaited<ReturnType<typeof listener>> | null)?.close();
  }
});

test("W2: a stdio MCP server of the person's never starts on a stage-2 turn (child_mcp relay-only, read back)", { skip }, async () => {
  const live = await liveTurn({ mcp: (d) => `touch ${d.out}/mcp_marker && exec cat >/dev/null`, calls: () => [exec("echo hi")] });
  assert.equal(live.result.status, "ok", JSON.stringify(live.result));
  assert.ok(!fs.existsSync(path.join(live.out, "mcp_marker")), "the person's MCP server did not run beside the app server");
});

test("W3: an exec-policy allow rule and an approved escalation stay inside relay's sandbox; approvals name relay's executor", { skip }, async () => {
  const live = await liveTurn({
    approve: true,
    rules: 'prefix_rule(pattern=["touch"], decision="allow")\n',
    calls: (d) => [
      exec(`touch ${d.out}/proof_rule; echo rule=$?`),
      exec(`touch ${d.out}/proof_esc; echo esc=$?`, { sandbox_permissions: "require_escalated", justification: "test" }),
    ],
  });
  // An approval naming any environment but relay's executor would have failed the turn (review R4).
  assert.equal(live.result.status, "ok", JSON.stringify(live.result));
  assert.ok(!fs.existsSync(path.join(live.out, "proof_rule")), live.outputs[0]);
  assert.ok(!fs.existsSync(path.join(live.out, "proof_esc")), live.outputs[1]);
  assert.match(live.outputs[0], /rule=1/);
  for (const a of live.approvals) {
    if (a.kind === "command") assert.equal((a.detail as Record<string, unknown> | undefined)?.confined, true, "command approvals from the executor carry stage 2's detail");
    else assert.equal((a.detail as Record<string, unknown> | undefined)?.confined, undefined, "file changes name no environment: unmarked");
  }
  console.log(`# W3 approvals asked: ${live.approvals.map((a) => a.kind).join(", ") || "none"}; outputs: ${JSON.stringify(live.outputs)}`);
});

test("W6, W7 (cross-turn): the executor refuses no token and a wrong one; another turn's sandbox cannot reach it", { skip }, async () => {
  const seen: Record<string, string> = {};
  const live = await liveTurn({
    calls: () => [exec("echo hi")],
    onRequest: async (step, ctx) => {
      if (step !== 1) return;
      const url = `ws://127.0.0.1:${ctx.execPort()}`;
      for (const [k, headers] of [["none", {}], ["wrong", { Authorization: `Bearer ${"0".repeat(64)}` }]] as const) {
        seen[k] = await scope().wait(new Promise<string>((res) => {
          const ws = new WebSocket(url, { headers } as never);
          const t = setTimeout(() => res("timeout"), 3000);
          scope().defer(() => { clearTimeout(t); ws.close(); });
          ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "initialize", params: { clientName: "probe" } }));
          ws.onmessage = (m) => { clearTimeout(t); res(`answered ${String(m.data).slice(0, 60)}`); ws.close(); };
          ws.onerror = () => { clearTimeout(t); res("refused"); };
        }));
      }
      // Another stage-2 turn: the whole reserved range, this executor's port included, is outbound-denied to it.
      const r = spawnSync("/usr/bin/sandbox-exec", ["-p", `(version 1)(allow default)(deny network-outbound (remote ip "localhost:${ctx.execPort()}"))`,
        "/usr/bin/perl", "-MIO::Socket::INET", "-e", 'IO::Socket::INET->new(PeerAddr => "127.0.0.1", PeerPort => $ARGV[0]) ? print "connected" : print "$!"', String(ctx.execPort())], { encoding: "utf8" });
      seen.otherTurn = r.stdout.trim();
    },
  });
  assert.equal(live.result.status, "ok", JSON.stringify(live.result));
  assert.equal(seen.none, "refused", JSON.stringify(seen));
  assert.equal(seen.wrong, "refused", JSON.stringify(seen));
  assert.equal(seen.otherTurn, "Operation not permitted", JSON.stringify(seen));
});

test("survivors: nohup, setsid (a writer and a block-port listener) and a kept terminal are all gone after the turn; nothing writes or listens after", { skip }, async () => {
  const live = await liveTurn({
    calls: () => [
      exec([
        "nohup /bin/sleep 4301 >/dev/null 2>&1 & echo $! > pid_nohup",
        `/usr/bin/perl -MPOSIX -e 'exit 0 if fork; POSIX::setsid(); open(F, ">", "pid_setsid"); print F $$; close F; exec "/bin/sleep", "4302"'`,
        `/usr/bin/perl -MPOSIX -e 'exit 0 if fork; POSIX::setsid(); open(F, ">", "pid_tick"); print F $$; close F; while (1) { open(T, ">>", "tick"); print T "x"; close T; select(undef, undef, undef, 0.1) }'`,
        `/usr/bin/perl -MPOSIX -MIO::Socket::INET -e 'exit 0 if fork; POSIX::setsid(); my $s = IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => $ENV{PORT}, Listen => 5, ReuseAddr => 1) or die; open(F, ">", "pid_listen"); print F $$; close F; while (my $c = $s->accept) { print $c "hi"; close $c }'`,
        "/bin/sleep 1; echo started",
      ].join("; ")),
      exec("echo $$ > pid_tty; exec /bin/sleep 4303", { tty: true, yield_time_ms: 500 }),
    ],
  });
  assert.equal(live.result.status, "ok", JSON.stringify(live.result));
  const pids = pidsIn(live.cwd, "pid_");
  assert.equal(pids.length, 5, `pid files: ${fs.readdirSync(live.cwd).join(" ")}; outputs ${JSON.stringify(live.outputs)}`);
  for (const p of pids) assert.ok(gone(p), `pid ${p} is gone after the turn`);
  const size = fs.statSync(path.join(live.cwd, "tick")).size;
  await sleep(1000);
  assert.equal(fs.statSync(path.join(live.cwd, "tick")).size, size, "nothing writes after teardown");
  const listening = await connectionResult(live.ports[1]);
  assert.equal(listening, "ECONNREFUSED", "nothing listens on the block after teardown");
  assert.deepEqual(live.result.survivors ?? [], []);
  console.log(`# survivors warnings: ${JSON.stringify(live.result.warnings ?? [])}`);
});

test("W4, executor death: the app server is killed within a few hundred ms (inside Codex's ~1 s reconnect backoff), the turn fails, nothing runs locally, and a squatter on its port sees nothing", { skip }, async () => {
  let squat: Awaited<ReturnType<typeof listener>> | null = null;
  let appGoneMs: number | null = null;
  try {
    const live = await liveTurn({
      calls: (d) => [exec(`touch ${d.out}/after_death; touch after_death_in`)],
      onRequest: async (step, ctx) => {
        if (step !== 0) return;
        const ex = ctx.executorPid();
        const port = ctx.execPort();
        assert.ok(ex > 1);
        const t0 = Date.now();
        process.kill(ex, "SIGKILL");
        for (let i = 0; i < 400 && !gone(ex); i++) await sleep(5);
        // A job's process could now take the executor's port: squat it at once.
        squat = await listener(port);
        for (let i = 0; i < 400 && !gone(ctx.appPid()); i++) await sleep(5);
        if (gone(ctx.appPid())) appGoneMs = Date.now() - t0;
      },
    });
    await sleep(3000);
    assert.equal(live.result.status, "failed", JSON.stringify(live.result));
    assert.match(live.result.error ?? "", /sandboxed executor .* exited during the turn \(SIGKILL\)/);
    assert.ok(appGoneMs !== null && appGoneMs < 500, `the app server was killed ${appGoneMs} ms after the executor died`);
    console.log(`# app server gone ${appGoneMs} ms after the executor's death`);
    assert.ok(gone(live.appPid));
    assert.ok(!fs.existsSync(path.join(live.out, "after_death")));
    assert.ok(!fs.existsSync(path.join(live.cwd, "after_death_in")), "no local fallback");
    assert.equal(squat!.accepted(), 0, "nobody reconnected to the executor's port");
  } finally {
    await (squat as Awaited<ReturnType<typeof listener>> | null)?.close();
  }
});

test("resume: a resumed stage-2 turn and the subagent it spawns run in relay's executor; the same thread unbound, straight through Codex, runs locally; no goal tools are offered", { skip }, async () => {
  const s = await scratchSession({ git: "worktree" });
  try {
    const first = await relayTurn(s, { convs: [{ calls: [exec("touch first_in; echo first=$?")] }] });
    assert.equal(first.result.status, "ok", JSON.stringify(first.result));
    const threadId = first.result.sessionId!;
    assert.ok(threadId);
    // Goals are pinned off: no goal tool in any request (their names would be in the tool list or in exec's description).
    assert.ok(s.model.bodies.length > 0 && s.model.bodies.every((b) => b.raw.includes("exec_command")), "the requests carry the tool list");
    for (const b of s.model.bodies) assert.doesNotMatch(b.raw, /\b(create|get|update)_goal\b/, "no goal tool offered");

    // Turn 2, resumed: thread/resume replies [local, relay]; relay binds the turn to its executor.
    const RESUMED = "RESUMED-TURN-PROMPT", SUB = "SUBAGENT-OF-RESUMED-TURN";
    const before = s.model.bodies.length;
    const second = await relayTurn(s, {
      sessionId: threadId, prompt: RESUMED,
      convs: [
        { match: RESUMED, calls: [
          exec(`touch resumed_in; echo wt=$?; touch ${s.out}/resumed_out; echo out=$?`),
          collab("spawn_agent", { task_name: "resumed_sub", message: SUB, fork_turns: "none" }),
          collab("wait_agent", { timeout_ms: 30000 }),
        ] },
        { match: SUB, calls: [exec(`touch sub_in; echo subwt=$?; touch ${s.out}/sub_out; echo subout=$?`)] },
      ],
    });
    assert.equal(second.result.status, "ok", JSON.stringify(second.result));
    assert.equal(second.result.sessionId, threadId, "the same thread");
    const [cmd] = s.model.outputs(0);
    const [sub] = s.model.outputs(1);
    assert.match(cmd ?? "", /wt=0/, cmd);
    assert.match(cmd ?? "", /out=1/, cmd);
    assert.match(sub ?? "", /subwt=0/, `the subagent ran: ${sub}`);
    assert.match(sub ?? "", /subout=1/, sub);
    assert.ok(fs.existsSync(path.join(s.cwd, "resumed_in")) && fs.existsSync(path.join(s.cwd, "sub_in")));
    assert.ok(!fs.existsSync(path.join(s.out, "resumed_out")), "the resumed turn's command did not run locally");
    assert.ok(!fs.existsSync(path.join(s.out, "sub_out")), "its subagent's command did not run locally");
    for (const b of s.model.bodies.slice(before)) assert.doesNotMatch(b.raw, /\b(create|get|update)_goal\b/);

    // The control, straight through Codex: the same thread resumed with a reachable "relay"
    // environment beside Codex's own, and a turn/start without relay's binding.
    const CONTROL = "UNBOUND-CONTROL-PROMPT";
    s.model.convs = [{ match: CONTROL, calls: [exec(`touch ${s.out}/control_out; echo ctl=$?`)] }];
    const ex = await plainExecServer(s.root);
    const a = directAppServer(s);
    try {
      await a.hello();
      // relay archives a thread after each turn (codex.ts) and unarchives it to resume; another client does the same.
      await a.request("thread/unarchive", { threadId });
      await a.request("environment/add", { environmentId: "relay", execServerUrl: ex.url, authBearerToken: ex.token });
      const r = await a.request("thread/resume", { threadId, cwd: s.cwd, runtimeWorkspaceRoots: [s.cwd], permissions: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "user", excludeTurns: true });
      assert.deepEqual(r.thread.environments.map((e: { environmentId: string }) => e.environmentId), ["local", "relay"], "what relay's binding has to take away");
      await a.request("turn/start", { threadId, input: [{ type: "text", text: CONTROL, text_elements: [] }] });
      assert.ok(await a.until((m) => m.method === "turn/completed" && m.params?.threadId === threadId, 60_000), "the control turn finished");
    } finally {
      await a.stop();
      await ex.stop();
    }
    assert.ok(fs.existsSync(path.join(s.out, "control_out")), "unbound, the same command ran in Codex's local environment: the binding is what keeps it out");
  } finally {
    await s.model.close();
  }
});

test("resume: a message queued for the session in Codex makes relay refuse the resume, and nothing runs", { skip }, async () => {
  const s = await scratchSession();
  try {
    const first = await relayTurn(s, { convs: [{ calls: [exec("echo first=1")] }] });
    assert.equal(first.result.status, "ok", JSON.stringify(first.result));
    const threadId = first.result.sessionId!;
    // Another client of the person's queues a message on the stored thread.
    const QUEUED = "QUEUED-BY-ANOTHER-CLIENT";
    const a = directAppServer(s);
    try {
      await a.hello();
      // relay archives a thread after each turn (codex.ts) and unarchives it to resume; another client does the same.
      await a.request("thread/unarchive", { threadId });
      await a.request("thread/queue/add", { threadId, input: [{ type: "text", text: QUEUED, text_elements: [] }], clientUserMessageId: "q1" });
    } finally {
      await a.stop();
    }
    const live = await relayTurn(s, {
      sessionId: threadId, prompt: "RESUME-AFTER-QUEUE",
      convs: [
        { match: QUEUED, calls: [exec(`touch ${s.out}/queued_out; echo q=$?`)] },
        { match: "RESUME-AFTER-QUEUE", calls: [exec(`touch ${s.out}/relay_out`)] },
      ],
    });
    assert.equal(live.result.status, "failed", JSON.stringify(live.result));
    assert.match(live.result.error ?? "", /a message is queued for the session in Codex/);
    assert.equal(s.model.asked(0) + s.model.asked(1), 0, "the model was never asked: no turn started");
    assert.ok(!fs.existsSync(path.join(s.out, "queued_out")) && !fs.existsSync(path.join(s.out, "relay_out")));
  } finally {
    await s.model.close();
  }
});

test("resume: an active goal set from outside starts no turn of its own; relay's resumed turn alone runs, bound", { skip }, async () => {
  const s = await scratchSession();
  try {
    const first = await relayTurn(s, { convs: [{ calls: [exec("echo first=1")] }] });
    assert.equal(first.result.status, "ok", JSON.stringify(first.result));
    const threadId = first.result.sessionId!;
    // Another client sets a goal on the stored thread (not loaded there, so nothing starts yet).
    const OBJECTIVE = "GOAL-OBJECTIVE-FROM-OUTSIDE";
    const a = directAppServer(s);
    try {
      await a.hello();
      // relay archives a thread after each turn (codex.ts) and unarchives it to resume; another client does the same.
      await a.request("thread/unarchive", { threadId });
      await a.request("thread/goal/set", { threadId, objective: OBJECTIVE });
      const g = await a.request("thread/goal/get", { threadId });
      assert.equal(g?.goal?.status, "active", JSON.stringify(g));
    } finally {
      await a.stop();
    }
    // With goals on, Codex starts a continuation as soon as thread/resume leaves the thread idle, with [local, relay]
    // (WP-C, verified on 0.164.0 straight through Codex). relay pins goals off: no such turn, and the guard would fail one.
    const live = await relayTurn(s, {
      sessionId: threadId, prompt: "RESUME-AFTER-GOAL",
      convs: [
        { match: OBJECTIVE, calls: [exec(`touch ${s.out}/goal_out; echo g=$?`)] },
        { match: "RESUME-AFTER-GOAL", calls: [exec(`touch after_goal_in; echo ag=$?; touch ${s.out}/after_goal_out; echo agout=$?`)] },
      ],
    });
    assert.equal(live.result.status, "ok", JSON.stringify(live.result));
    assert.equal(s.model.asked(0), 0, "no goal continuation reached the model");
    assert.ok(!fs.existsSync(path.join(s.out, "goal_out")));
    assert.match(s.model.outputs(1)[0] ?? "", /ag=0[\s\S]*agout=1/);
    assert.ok(!fs.existsSync(path.join(s.out, "after_goal_out")));

    // The control, straight through Codex with goals on (its default): thread/resume alone starts
    // the goal's continuation, with Codex's local environment first, and its command runs locally.
    s.model.convs = [{ match: OBJECTIVE, calls: [exec(`touch ${s.out}/goal_out; echo g=$?`)] }];
    const c = directAppServer(s);
    try {
      await c.hello();
      await c.request("thread/unarchive", { threadId });
      await c.request("thread/resume", { threadId, cwd: s.cwd, runtimeWorkspaceRoots: [s.cwd], permissions: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "user", excludeTurns: true });
      assert.ok(await c.until((m) => m.method === "turn/started" && m.params?.threadId === threadId, 15_000), "with goals on, a turn started by itself on resume");
      await c.until((m) => m.method === "turn/completed" && m.params?.threadId === threadId, 30_000);
    } finally {
      await c.stop();
    }
    assert.ok(s.model.asked(0) > 0 && fs.existsSync(path.join(s.out, "goal_out")), "the control's goal turn ran its command locally: the goal was live, and pinning goals off is what kept relay's resume from starting it");
  } finally {
    await s.model.close();
  }
});

/**
 * relay's own app-server flags for a stage-2 turn of session `s` (codexFlags with stage2Plan, as
 * codexBackend.start builds them), for a direct app server that stands in for relay's. `goals`: the
 * one pin a control turns back on.
 */
function relayFlags(s: Scratch, o: { goals?: boolean; broker?: Stage2BrokerConfig } = {}): string[] {
  const spec = {
    target: targetDef("codex"), cwd: s.cwd, access: "write", relay: null, grant: GRANT,
    config: withDefaults({ codex_backend: "app-server", child_mcp: "relay-only", child_hooks: false, targets: { codex: { bin: CODEX, stage2: true } } }),
  } as unknown as TurnSpec;
  const plan = stage2Plan(spec, { mode: "stage2", deniedTcp: [], deniedUdp: [], relayRange: [], execPort: 0, bindPorts: [], worktreeSockets: false } as never);
  if (o.broker) plan.broker = o.broker;
  const f = codexFlags(spec, [], { HOME: s.home, CODEX_HOME: s.appHome, PATH: "/usr/bin:/bin" }, [], undefined, plan);
  const args = [...f.off, ...f.c];
  if (o.goals) {
    const at = args.indexOf("features.goals=false");
    assert.ok(at > 0, "relay pins goals off");
    args[at] = "features.goals=true";
  }
  return args;
}

/** The output Codex sent back for one of the fake model's calls, by its call id, from the requests' bodies (whichever conversation they were routed to). */
function callOutput(model: FakeModel, callId: string): string | null {
  for (const b of model.bodies) {
    for (const i of (JSON.parse(b.raw).input ?? []) as { type?: string; call_id?: string; output?: unknown }[]) {
      if (/_call_output$/.test(i?.type ?? "") && i.call_id === callId) return typeof i.output === "string" ? i.output : JSON.stringify(i.output);
    }
  }
  return null;
}

test("no local: relay's app server has no `local` environment, on a fresh and a resumed turn; the resume reply holds no environment, and the turn's binding gives it relay's executor alone", { skip }, async () => {
  const s = await scratchSession({ git: "worktree" });
  const seen: Record<string, unknown>[] = [];
  setStage2HookForTests(async (point, o) => {
    if (point === "thread-reply") seen.push({ point, resumed: o.resumed, environments: (o.reply as { thread?: { environments?: unknown } })?.thread?.environments, roots: (o.reply as { runtimeWorkspaceRoots?: unknown })?.runtimeWorkspaceRoots });
    if (point === "turn-bound") {
      seen.push({
        point,
        local: await o.rpc!.request("environment/status", { environmentId: "local" }),
        relay: (await o.rpc!.request("environment/status", { environmentId: "relay" }))?.status,
        environments: (await o.rpc!.request("thread/read", { threadId: o.threadId, includeTurns: false }))?.thread?.environments?.map((e: { environmentId: string }) => e.environmentId),
      });
    }
  });
  try {
    let appEnv = "";
    const first = await relayTurn(s, { convs: [{ calls: [exec(`touch first_in; echo wt=$?; touch ${s.out}/first_out; echo out=$?`)] }], onRequest: (_c, step, ctx) => { if (step === 0) appEnv = psEnv(ctx.appPid()); } });
    assert.equal(first.result.status, "ok", JSON.stringify(first.result));
    assert.match(appEnv, /\bCODEX_EXEC_SERVER_URL=none\b/, "relay's app server runs with CODEX_EXEC_SERVER_URL=none");
    const second = await relayTurn(s, { sessionId: first.result.sessionId, prompt: "RESUMED-NO-LOCAL", convs: [{ match: "RESUMED-NO-LOCAL", calls: [exec(`touch second_in; echo wt=$?; touch ${s.out}/second_out; echo out=$?`)] }] });
    assert.equal(second.result.status, "ok", JSON.stringify(second.result));
    console.log(`# seen: ${JSON.stringify(seen)}`);
    const replies = seen.filter((x) => x.point === "thread-reply"), bound = seen.filter((x) => x.point === "turn-bound");
    assert.equal(replies.length, 2);
    assert.deepEqual((replies[0].environments as { environmentId: string }[]).map((e) => e.environmentId), ["relay"], "a fresh thread: relay's executor alone");
    assert.equal(replies[1].resumed, true);
    assert.deepEqual(replies[1].environments, [], "a resumed thread: no environment at all, `local` included, until relay binds the turn");
    assert.equal(bound.length, 2);
    for (const b of bound) {
      assert.deepEqual(b.local, { status: "unknown", error: "unknown environment id `local`" }, "Codex has no `local` environment");
      assert.equal(b.relay, "ready");
      assert.deepEqual(b.environments, ["relay"]);
    }
    assert.match(first.outputs[0] ?? "", /wt=0[\s\S]*out=1/);
    assert.match(s.model.outputs(0)[0] ?? "", /wt=0[\s\S]*out=1/, "the resumed turn's command ran, in relay's executor");
    for (const name of ["first", "second"]) assert.ok(fs.existsSync(path.join(s.cwd, `${name}_in`)) && !fs.existsSync(path.join(s.out, `${name}_out`)), name);
  } finally {
    setStage2HookForTests(null);
    await s.model.close();
  }
});

test("no local, through relay: a message queued after relay's queue check (the race) runs no command outside relay's sandbox, whichever turn starts first; when Codex's own starts first, the guard fails the turn", { skip }, async () => {
  const s = await scratchSession();
  try {
    const first = await relayTurn(s, { convs: [{ calls: [exec("echo first=1")] }] });
    assert.equal(first.result.status, "ok", JSON.stringify(first.result));
    const threadId = first.result.sessionId!;
    for (const order of ["race", "codex first"] as const) {
      const RACE = `QUEUED-AFTER-RELAYS-CHECK-${order === "race" ? "A" : "B"}`, PROMPT = `RESUME-AFTER-RACE-${order === "race" ? "A" : "B"}`;
      const marker = order === "race" ? "race_a" : "race_b";
      let queued: unknown = null;
      // Between relay's queue check (stage2QueueProblem, empty) and its thread/resume, on relay's own app
      // server: a message queued ("race"); or that, then the thread loaded and left idle a moment, so that
      // Codex starts the queued message before relay's turn/start ("codex first").
      setStage2HookForTests(async (point, o) => {
        if (point !== "queue-checked") return;
        queued = await o.rpc!.request("thread/queue/add", { threadId: o.threadId, input: [{ type: "text", text: RACE, text_elements: [] }], clientUserMessageId: marker }).then(() => "queued", (e: Error) => `error ${e.message}`);
        if (order === "codex first") {
          await o.rpc!.request("thread/resume", { threadId: o.threadId, cwd: s.cwd, runtimeWorkspaceRoots: [s.cwd], permissions: ":danger-full-access", approvalPolicy: "on-request", approvalsReviewer: "user", excludeTurns: true });
          await sleep(2000);
        }
      });
      const live = await relayTurn(s, {
        sessionId: threadId, prompt: PROMPT,
        convs: [
          { match: RACE, calls: [exec(`touch ${marker}_in; echo rin=$?; touch ${s.out}/${marker}_out; echo rout=$?`)] },
          { match: PROMPT, calls: [exec(`touch ${s.out}/${marker}_relay`)] },
        ],
        // Codex's own turn waits at the model a moment: were the guard not to stop it, relay's turn/start would steer into it.
        onRequest: async (conv) => { if (conv === 0) await sleep(1500); },
      });
      setStage2HookForTests(null);
      const output = callOutput(s.model, `e${s.model.epoch}c0-0`);
      console.log(`# ${order}: queued ${JSON.stringify(queued)}; result ${JSON.stringify({ status: live.result.status, error: live.result.error })}; asked ${s.model.asked(0)}/${s.model.asked(1)}; output ${JSON.stringify(output)}`);
      assert.equal(queued, "queued", "the race was set up: a message was queued after relay's check");
      assert.ok(!fs.existsSync(path.join(s.out, `${marker}_out`)) && !fs.existsSync(path.join(s.out, `${marker}_relay`)), `${order}: nothing ran outside relay's sandbox`);
      assert.doesNotMatch(output ?? "", /rout=0/);
      if (order === "codex first") {
        assert.equal(live.result.status, "failed", JSON.stringify(live.result));
        assert.match(live.result.error ?? "", /Codex started a turn by itself/);
        assert.ok(!fs.existsSync(path.join(s.cwd, `${marker}_in`)), "Codex's own turn, unbound, ran its command nowhere");
      } else {
        // relay's turn/start reached Codex first: its turn ran, bound; the queued message waits, or runs after it with the thread's binding.
        assert.ok(live.result.status === "ok" || /Codex started a turn by itself|second turn|went into turn/.test(live.result.error ?? ""), JSON.stringify(live.result));
      }
    }
  } finally {
    setStage2HookForTests(null);
    await s.model.close();
  }
});

/**
 * One case of a turn Codex starts by itself on resume, straight through Codex with relay's stage-2
 * flags (no turn guard, no queue check): `source` "queue" (a message another client queued) or
 * "goal" (an active goal, goals switched back on); `local` whether the app server keeps Codex's
 * `local` (the control) or runs with relay's CODEX_EXEC_SERVER_URL=none. A plain, unsandboxed
 * exec-server is added as "relay", so that a turn bound to it would write outside too. When the
 * self-started turn first asks the model, a turn/start bound to "relay" is sent, as relay sends its
 * own, and steers into that turn; only then does the model ask for the command.
 */
async function selfStarted(s: Scratch, threadId: string, source: "queue" | "goal", local: boolean) {
  const tag = `${source.toUpperCase()}-${local ? "LOCAL" : "NONE"}`;
  const SELF = `SELF-STARTED-${tag}`, STEER = `STEERED-${tag}`;
  const marker = `self_${source}_${local ? "local" : "none"}`;
  const other = directAppServer(s);
  try {
    await other.hello();
    await other.request("thread/unarchive", { threadId }).catch(() => {});
    if (source === "queue") await other.request("thread/queue/add", { threadId, input: [{ type: "text", text: SELF, text_elements: [] }], clientUserMessageId: tag });
    else {
      await other.request("thread/goal/set", { threadId, objective: SELF });
      assert.equal((await other.request("thread/goal/get", { threadId }))?.goal?.status, "active");
    }
  } finally {
    await other.stop();
  }
  const ex = await plainExecServer(s.root);
  const a = directAppServer(s, { args: relayFlags(s, { goals: source === "goal" }), env: local ? {} : { ...STAGE2_APP_SERVER_ENV } });
  let steered: unknown = null;
  // Only Codex's own turn has a conversation: the steered message matches none, so the request after the
  // steer (Codex drops the response in flight and asks again with the steered input) still goes to it,
  // and the command comes after the steer either way.
  s.model.convs = [{ match: SELF, calls: [exec(`touch ${s.out}/${marker}; echo selfout=$?`)] }];
  s.model.hook = async (conv, step) => {
    if (conv !== 0 || step !== 0 || steered) return;
    steered = await a.request("turn/start", { threadId, input: [{ type: "text", text: STEER, text_elements: [] }], environments: [{ environmentId: "relay", cwd: s.cwd }] }).catch((e: Error) => ({ error: e.message }));
  };
  try {
    await a.hello();
    await a.request("environment/add", { environmentId: "relay", execServerUrl: ex.url, authBearerToken: ex.token });
    const status = await a.request("environment/status", { environmentId: "local" });
    const r = await a.request("thread/resume", { threadId, cwd: s.cwd, runtimeWorkspaceRoots: [s.cwd], permissions: ":danger-full-access", approvalPolicy: "on-request", approvalsReviewer: "user", excludeTurns: true });
    const started = await a.until((m) => m.method === "turn/started" && m.params?.threadId === threadId, 15_000);
    if (started) await a.until((m) => m.method === "turn/completed" && m.params?.threadId === threadId, 60_000);
    const turns = a.notes.filter((m) => m.method === "turn/started" && m.params?.threadId === threadId).map((m) => m.params?.turn?.id);
    const out = { status, resumed: (r?.thread?.environments ?? []).map((e: { environmentId: string }) => e.environmentId), turns, steered, asked: s.model.asked(0), output: callOutput(s.model, `e${s.model.epoch}c0-0`), escaped: fs.existsSync(path.join(s.out, marker)) };
    console.log(`# self-started ${tag}: ${JSON.stringify(out)}`);
    return out;
  } finally {
    s.model.hook = null;
    if (source === "goal") {
      const c = directAppServer(s);
      try { await c.hello(); await c.request("thread/goal/clear", { threadId }).catch(() => {}); } finally { await c.stop(); }
    }
    await a.stop();
    await ex.stop();
  }
}

test("no local, straight through Codex with relay's flags: a turn Codex starts by itself on resume (a queued message, or an active goal with goals on), steered into by a bound turn/start, cannot run a command; with Codex's local (the control) it runs there", { skip }, async () => {
  const s = await scratchSession();
  try {
    const first = await relayTurn(s, { convs: [{ calls: [exec("echo first=1")] }] });
    assert.equal(first.result.status, "ok", JSON.stringify(first.result));
    const threadId = first.result.sessionId!;
    for (const source of ["queue", "goal"] as const) {
      const none = await selfStarted(s, threadId, source, false);
      assert.deepEqual(none.status, { status: "unknown", error: "unknown environment id `local`" }, source);
      assert.deepEqual(none.resumed, [], `${source}: the resumed thread has no environment`);
      assert.ok(none.turns.length >= 1 && none.asked >= 1, `${source}: Codex started a turn by itself and asked the model (the case has teeth): ${JSON.stringify(none)}`);
      assert.equal((none.steered as { turn?: { id?: string } })?.turn?.id, none.turns[0], `${source}: the bound turn/start steered into Codex's own turn`);
      assert.equal(none.escaped, false, `${source}: without local, the self-started turn's command ran nowhere: ${JSON.stringify(none)}`);
      assert.doesNotMatch(none.output ?? "", /selfout=0/);
      // The control: the same with Codex's local registered. The steer does not rebind the running turn, and its command runs locally: the gap.
      const local = await selfStarted(s, threadId, source, true);
      assert.equal(local.status?.status, "ready", source);
      assert.deepEqual(local.resumed, ["local", "relay"], source);
      assert.equal((local.steered as { turn?: { id?: string } })?.turn?.id, local.turns[0], `${source}: steered in the control too`);
      assert.equal(local.escaped, true, `${source}: with local, the self-started turn's command ran unconfined though a bound turn/start steered into it: ${JSON.stringify(local)}`);
    }
  } finally {
    await s.model.close();
  }
});

/**
 * A stage-2 turn run by a stand-in worker process (fixtures/stage2-worker.ts) for a registry node of
 * this test's, every package real and the lease on a scratch range: what is left when that worker dies mid-turn.
 */
async function orphanable(nodeId: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2o-")));
  const runId = createRun(root, withDefaults({ cancel_grace_ms: 1000 }), `tok-${nodeId}`);
  insertNode({ id: nodeId, run_id: runId, kind: "job", target: "codex", mode: "write", depth: 1, task: "s2 orphan", cwd: root, status: "running" });
  // The person's consent for the worker's grant (fixtures/stage2-worker.ts), as session.ts records it (review R2).
  setParam(nodeId, "raw_network_consent", { grant: rawNetworkKey(GRANT as never), by: "by the user", at: Date.now() });
  const turnId = insertTurn(nodeId, "test", "go", "write", "running");
  const range = { first: 52000 + Math.floor(Math.random() * 400) * 16, count: 16 };
  for (let p = range.first; p < range.first + range.count; p++) leasedPorts.add(p);
  const worker = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures", "stage2-worker.ts"), JSON.stringify({ codex: CODEX, root, runId, nodeId, turnId, range })], { stdio: ["ignore", "pipe", "pipe"] });
  children.set(worker.pid!, procStart(worker.pid!, { fresh: true }));
  // Register before waiting for its first line: startup/assertion failures own resources too.
  updateNode(nodeId, { worker_pid: worker.pid!, worker_start: procStart(worker.pid!, { fresh: true }) });
  const cleanup = scope().defer(async () => {
    worker.kill("SIGKILL");
    for (let i = 0; i < 200 && !gone(worker.pid!); i++) await pause(20);
    assert.ok(gone(worker.pid!), "stand-in worker reaped");
    // Reap uses the registered app group and executor record, including detached survivors,
    // and gives back the executor's leases. Merely killing the pids leaves those leases held.
    try {
      reap(runId);
      const swept = sweepOrphanedExecutors();
      assert.deepEqual(swept.problems, []);
      closeTurns(nodeId, "failed", "live fixture ended");
    } finally {
      worker.stdout!.destroy(); worker.stderr!.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10);
  let err = "";
  worker.stderr!.on("data", (d) => (err += d));
  const kill = () => { try { worker.kill("SIGKILL"); } catch { /* gone */ } };
  const line = await scope().wait(new Promise<string>((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => { kill(); reject(new Error(`the stand-in worker did not report within 120 s: ${err.slice(-2000)}`)); }, 120000);
    worker.stdout!.on("data", (d) => {
      out += d;
      const i = out.indexOf("\n");
      if (i >= 0) { clearTimeout(t); resolve(out.slice(0, i)); }
    });
    worker.once("exit", (c) => { clearTimeout(t); reject(new Error(`the stand-in worker exited (${c}): ${err.slice(-2000)}`)); });
  }));
  const info = JSON.parse(line) as { app: number; appPgid: number; appStart: string | null; executor: number; exec: number; block: number[]; listen: number; sleeper: number };
  const everything = [info.app, info.executor, info.listen, info.sleeper];
  const ports = path.join(relayHome(), "ports");
  try {
    for (const k of ["app", "executor", "listen", "sleeper"] as const) assert.ok(info[k] > 1 && !gone(info[k]), `${k} is running: ${line}`);
    updateNode(nodeId, { worker_pid: worker.pid!, worker_start: procStart(worker.pid!, { fresh: true }), agent_pid: info.app, agent_pgid: info.appPgid, agent_start: info.appStart });
    // While the turn runs: the executor's record, and its lease naming it.
    const rec = executorRecords().records.find((r) => r.record.nodeId === nodeId);
    assert.equal(rec?.record.pid, info.executor, "the executor is recorded");
    assert.equal(rec?.record.owner.pid, worker.pid, "owned by the worker");
    // The port's current lease: its newest generation (R6: `<port>.<gen>`; an earlier test may have used the port).
    const current = (p: number) => fs.readdirSync(ports).filter((n) => new RegExp(`^${p}(\\.\\d+)?$`).test(n)).sort((a, b) => Number(a.split(".")[1] ?? 0) - Number(b.split(".")[1] ?? 0)).at(-1) ?? String(p);
    for (const p of [info.exec, ...info.block]) assert.match(fs.readFileSync(path.join(ports, current(p)), "utf8"), new RegExp(`^${worker.pid} [^\n]+\n${info.executor} `), `lease ${p}`);
  } catch (e) {
    for (const p of [worker.pid!, ...everything]) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
    throw e;
  }
  return {
    root, runId, worker, info, ports, everything,
    async afterwards(what: string) {
      for (const p of everything) assert.ok(await until(() => gone(p), 8000), `${what}: pid ${p} is gone (${JSON.stringify(info)})`);
      assert.ok(gone(worker.pid!));
      assert.equal(getNode(nodeId)!.status === "running", false);
      assert.deepEqual(executorRecords().records.filter((r) => r.record.nodeId === nodeId), [], `${what}: no record left`);
      for (const p of [info.exec, ...info.block]) assert.ok(!portHeld(p), `${what}: lease ${p} given back`);
      const block = await connectionResult(info.block[0]);
      assert.equal(block, "ECONNREFUSED", `${what}: nothing listens on the block`);
      const fresh = await listener(info.exec);
      try {
        await sleep(3000);
        assert.equal(fresh.accepted(), 0, `${what}: nobody connects to the executor's port`);
      } finally {
        await fresh.close();
      }
    },
    cleanup,
  };
}

const until = async (cond: () => boolean, ms: number) => {
  for (let t = 0; t < ms && !cond(); t += 50) await sleep(50);
  return cond();
};

test("worker death, then reap: the orphaned app server, executor, its commands and its lease are all gone; nobody connects to its port", { skip }, async () => {
  const o = await orphanable("j_s2reap");
  try {
    o.worker.kill("SIGKILL");
    assert.ok(await until(() => gone(o.worker.pid!), 5000));
    await sleep(500);
    assert.ok(!gone(o.info.executor), "without reap, the executor outlives its worker (the gap this closes)");
    reap(o.runId);
    assert.equal(getNode("j_s2reap")!.status, "lost");
    await o.afterwards("reap");
  } finally {
    await o.cleanup();
  }
});

test("cancel mid-turn, the worker stuck: cancel kills it, then the app server, the executor, its commands and its lease", { skip }, async () => {
  const o = await orphanable("j_s2cancel");
  try {
    const out = await cancel(null, { id: "j_s2cancel" }) as Record<string, unknown>;
    assert.deepEqual(out.cancelled, ["j_s2cancel"], JSON.stringify(out));
    assert.equal(out.warning, undefined, JSON.stringify(out));
    assert.equal(getNode("j_s2cancel")!.status, "cancelled");
    await o.afterwards("cancel");
  } finally {
    await o.cleanup();
  }
});
