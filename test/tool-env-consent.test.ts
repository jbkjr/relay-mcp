import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, mock } from "node:test";
import net from "node:net";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { hostVar } from "./host-env.ts";
import "./temp-root.ts";

// Set the synthetic root before importing any relay module: root capture must precede all turns.
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "e")));
const saved = { ...process.env };
for (const name of Object.keys(process.env)) if (hostVar(name)) delete process.env[name];
const ROOT_SECRET = "opaque-withheld-root-value-73x";
Object.assign(process.env, { HOME: dir, RELAY_HOME: path.join(dir, "c"), RELAY_CONFIG: path.join(dir, "config.json"), ENV_CANARY: "opaque-request-canary-Q29x", JAVA_HOME: "/synthetic/java", W9_ROOT_TOKEN: ROOT_SECRET });
fs.mkdirSync(process.env.RELAY_HOME!);
// Probe the real transport once. When an outer sandbox refuses listen, stand in only socket
// transport and kernel peer acquisition; run the production framing, liveness, claim and consent
// logic unchanged. A separate skipped test records the still-required real-kernel gate.
const realTransport = await new Promise<boolean>((resolve, reject) => {
  const server = net.createServer(); const file = path.join(dir, "probe");
  server.once("error", (err: NodeJS.ErrnoException) => err.code === "EPERM" ? resolve(false) : reject(err));
  server.listen(file, () => server.close(() => { fs.rmSync(file, { force: true }); resolve(true); }));
});
if (!realTransport) {
  let listening: EventEmitter;
  mock.method(net, "createServer", (listener: (socket: net.Socket) => void) => {
    const server = new EventEmitter() as any;
    listening = server; server.on("connection", listener);
    server.listen = (file: string, done: () => void) => { fs.writeFileSync(file, ""); queueMicrotask(done); return server; };
    server.unref = () => server;
    server.close = (done: () => void) => queueMicrotask(done);
    return server;
  });
  mock.method(net, "connect", () => {
    let a: Duplex, b: Duplex;
    const make = (other: () => Duplex) => new Duplex({ read() {}, write(chunk, _encoding, done) { other().push(chunk); done(); }, final(done) { other().push(null); done(); } });
    a = make(() => b); b = make(() => a);
    for (const [self, other] of [[a, b], [b, a]]) {
      (self as any).setTimeout = () => self;
      self.once("close", () => other.destroy());
    }
    const server = listening;
    queueMicrotask(() => { server.emit("connection", b); a.emit("connect"); });
    return a;
  });
}
const { withDefaults } = await import("../dist/core/config.js");
const { newInstance, admitWork, persistentGrant } = await import("../dist/core/caller.js");
const { createRun, insertNode, insertTurn, updateNode, updateTurn, closeDbForTests, getTurn, db } = await import("../dist/core/db.js");
const { openRootEnvironment, closeRootEnvironment, turnEnvironment, claimTurnEnvironment, workerRedaction, recordEnvironmentRequest, workerEnvironment, environmentAdmission } = await import("../dist/core/env-broker.js");
const { redact, redactor, streamSecretValues } = await import("../dist/core/secrets.js");
const { openAgentLog } = await import("../dist/backends/types.js");
const { pendingRequests, requestView, getRequest, decide } = await import("../dist/core/approvals.js");
const { approve, confirm } = await import("../dist/core/ops.js");
const { commandRefusal } = await import("../dist/core/extensions.js");
const { procStart } = await import("../dist/core/procs.js");
const { watch } = await import("../dist/core/watch.js");

after(() => {
  closeDbForTests();
  mock.restoreAll();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(dir, { recursive: true, force: true });
});
let sequence = 0;
const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
async function pending(node: string) {
  for (let i = 0; i < 300; i++) { const r = pendingRequests().find((r) => r.node_id === node); if (r) return r; await delay(); }
  throw new Error("no environment approval request arrived");
}
async function fixture(t: import("node:test").TestContext, options: Record<string, unknown> = {}) {
  const config = { allow_temp_home: true, allow_untested: true, approval_timeout_s: 2, child_env: { pass: ["JAVA_HOME"], request: ["ENV_CANARY"] }, ...options };
  fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify(config));
  const cfg = withDefaults(config);
  const inst = newInstance({ kind: "root" }, dir, "claude");
  inst.host = { recognised: true, confirmTool: true };
  const run = createRun(dir, cfg, inst.token); inst.runId = run; inst.since.set(run, Date.now()); inst.reapedAt = Date.now();
  const authority = await openRootEnvironment(inst, realTransport ? {} : { peerIdentity: async () => ({ pid: process.pid, uid: process.getuid!(), start: procStart(process.pid)! }) });
  process.env.RELAY_ENV_SOCKET = authority.socket;
  t.after(async () => { await closeRootEnvironment(inst); });
  const node = `j_${String(++sequence).padStart(8, "0")}`;
  insertNode({ id: node, run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "synthetic caller purpose", cwd: dir });
  updateNode(node, { status: "running", worker_pid: process.pid, worker_start: procStart(process.pid) });
  const turn = (names?: string[], access: "read" | "write" = "read", network = false) => {
    const id = insertTurn(node, "caller", "synthetic purpose", access);
    recordEnvironmentRequest(id, names);
    updateTurn(id, { status: "running", grant_json: JSON.stringify({ ...JSON.parse(getTurn(id)!.grant_json ?? "{}"), network }) });
    return id;
  };
  return { inst, run, node, turn, cfg };
}
const confirmArgs = (r: Parameters<typeof requestView>[0]) => {
  const v = requestView(r);
  return { request_id: r.id, from: r.node_id, wants: r.summary, kind: String(v.kind), effect: String(v.effect), in_directory: String(v.in_directory) };
};

test("tool env redaction: startup claim authenticates the pinned worker before any turn; root values remain redaction only", async (t) => {
  const f = await fixture(t);
  const start = procStart(process.pid);
  updateNode(f.node, { worker_start: "wrong-start" });
  await assert.rejects(workerRedaction(f.node), /registry-pinned/);
  updateNode(f.node, { worker_start: start });
  // This redactor predates the claim, just as the worker's diagnostic writer does.
  const cut = redactor({});
  delete process.env.W9_ROOT_TOKEN;
  assert.equal(streamSecretValues().includes(ROOT_SECRET), false, "worker process.env does not carry the root secret");
  await workerRedaction(f.node);
  assert.equal(redact(ROOT_SECRET), "[redacted]");
  assert.equal(cut(ROOT_SECRET), "[redacted]");
  assert.ok(streamSecretValues().includes(ROOT_SECRET), "ACP streaming must know withheld root secrets too");
  assert.equal(workerEnvironment(f.run).W9_ROOT_TOKEN, undefined);
  const selected = await turnEnvironment(f.turn());
  assert.equal(selected.selection.env.W9_ROOT_TOKEN, undefined);
  assert.equal(JSON.stringify(selected).includes(ROOT_SECRET), false, "redaction values never escape the internal claim into turn/tool results");
  const file = path.join(dir, "redaction-only.log");
  const { log } = openAgentLog(file, { env: selected.selection.env });
  log.write(`bare ${ROOT_SECRET}\n`); log.end();
  assert.equal(fs.readFileSync(file, "utf8"), "bare [redacted]\n");
  assert.equal(JSON.stringify(db().prepare("SELECT * FROM nodes").all()).includes(ROOT_SECRET), false);
  assert.equal(JSON.stringify(db().prepare("SELECT * FROM turns").all()).includes(ROOT_SECRET), false);
});

test("tool env redaction: turn claims carry the captured root set independently of selection and never release it to another root", async (t) => {
  const f = await fixture(t);
  const selected = await turnEnvironment(f.turn());
  assert.equal(selected.selection.env.W9_ROOT_TOKEN, undefined);
  assert.equal(redact(ROOT_SECRET), "[redacted]");
  const other = createRun(dir, f.cfg, "another-root");
  const node = `j_${String(++sequence).padStart(8, "0")}`;
  insertNode({ id: node, run_id: other, kind: "job", target: "codex", mode: "read", depth: 1, task: "other root", cwd: dir });
  updateNode(node, { worker_pid: process.pid, worker_start: procStart(process.pid) });
  await assert.rejects(workerRedaction(node), /does not own/);
});

test("tool env consent: actual worker peer, root/CLI/automatic refusal, confirm, one claim and fresh resumed turn", async (t) => {
  const f = await fixture(t);
  const id = f.turn(["ENV_CANARY"]);
  const release = turnEnvironment(id);
  const r = await pending(f.node);
  assert.equal(requestView(r).person_only, true);
  assert.match(commandRefusal(r)!, /never from a command/);
  for (const user_confirmed of [false, true]) assert.equal(approve(f.inst, { request_id: r.id, decision: "allow", user_confirmed }).refused, true);
  for (const by of ["terminal", "root session", "root session, stating that the user confirmed", "automatic reviewer"]) assert.ok("error" in decide(r.id, true, by));
  assert.equal(getRequest(r.id)!.status, "pending");
  assert.ok("error" in decide(r.id, true, "user", undefined, "job"));
  const view = requestView(r);
  assert.match(String(view.effect), /standing_passes.*JAVA_HOME/);
  assert.match(String(view.effect), /network.*false/);
  assert.match(r.summary, /untrusted.*synthetic purpose/);
  assert.equal(JSON.stringify(view).includes("opaque-request-canary-Q29x"), false);
  assert.equal(confirm(f.inst, { ...confirmArgs(r), wants: "different purpose" }).refused, true);
  assert.equal(confirm(f.inst, { ...confirmArgs(r), note: "opaque-request-canary-Q29x" }).decision, "allowed");
  assert.equal(getRequest(r.id)!.note?.includes("opaque-request-canary-Q29x"), false);
  const selected = await release;
  assert.equal(selected.selection.env.ENV_CANARY, "opaque-request-canary-Q29x");
  assert.equal(selected.selection.env.JAVA_HOME, "/synthetic/java");
  assert.equal(confirm(f.inst, confirmArgs(r)).error, `request ${r.id} is already allowed`);
  await assert.rejects(turnEnvironment(id), /already been consumed/);
  updateTurn(id, { status: "done" });
  const resume = f.turn();
  const next = await turnEnvironment(resume);
  assert.equal(next.selection.env.ENV_CANARY, undefined, "a resume never inherits a previous request");
  assert.equal(pendingRequests(f.run).length, 0);
  const snapshot = JSON.stringify(db().prepare("SELECT params_json FROM nodes WHERE id = ?").get(f.node)) + JSON.stringify(db().prepare("SELECT detail_json FROM requests WHERE node_id = ?").all(f.node));
  assert.equal(snapshot.includes("opaque-request-canary-Q29x"), false);
  assert.equal(snapshot.includes("/synthetic/java"), false, "standing passes persist names, not their values");
  assert.equal(workerEnvironment(f.run).ENV_CANARY, undefined);
  assert.equal(workerEnvironment(f.run).JAVA_HOME, undefined);
});

test("tool env consent: follow-ups describe the current turn, redacted and clipped, for every session kind", async (t) => {
  for (const kind of ["job", "thread", "participant"] as const) {
    const f = await fixture(t);
    updateNode(f.node, { kind });
    const first = f.turn();
    await turnEnvironment(first);
    updateTurn(first, { status: "done" });
    const followup = f.turn(["ENV_CANARY"]);
    updateTurn(followup, { body: `publish the follow-up report using ${ROOT_SECRET}. ${"purpose detail ".repeat(200)}tail omitted` });
    const release = turnEnvironment(followup);
    const r = await pending(f.node);
    assert.match(r.summary, /Caller-supplied purpose \(untrusted\): publish the follow-up report using \[redacted\]/);
    assert.match(r.reason!, /Caller-supplied purpose \(untrusted\): publish the follow-up report/);
    assert.doesNotMatch(r.summary + r.reason, /synthetic caller purpose|tail omitted/);
    assert.equal((r.summary + r.reason).includes(ROOT_SECRET), false);
    assert.ok(r.reason!.length < 1100);
    assert.ok(r.reason!.endsWith("…"));
    confirm(f.inst, confirmArgs(r));
    await release;
  }
});

test("tool env consent: qualified dialog uses existing watch decision path; root environment is captured once", async (t) => {
  const f = await fixture(t);
  f.inst.host = { recognised: true, personDialog: true, elicit: async () => ({ reading: "decided", outcome: "accept", allow: true }) };
  process.env.ENV_CANARY = "changed-after-root-start";
  const release = turnEnvironment(f.turn(["ENV_CANARY"]));
  await pending(f.node); watch(f.inst);
  const selected = await release;
  assert.equal(selected.selection.env.ENV_CANARY, "opaque-request-canary-Q29x");
});

for (const failure of ["deny", "timeout", "cancel", "policy", "revision", "target", "path", "lost-peer", "restart"] as const) {
  test(`tool env consent: ${failure} releases nothing and cannot reuse a decision`, async (t) => {
    const f = await fixture(t, { approval_timeout_s: 0.2 });
    const id = f.turn(["ENV_CANARY"]);
    const ctl = new AbortController();
    const release = turnEnvironment(id, ctl.signal);
    const rejected = assert.rejects(release, /denied|expired|cancelled|binding changed|unavailable|closed/);
    const r = await pending(f.node);
    if (failure === "deny") assert.equal(approve(f.inst, { request_id: r.id, decision: "deny" }).decision, "denied");
    if (failure === "cancel") updateTurn(id, { status: "cancelled" });
    if (failure === "policy") fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify({ allow_temp_home: true, child_env: { request: ["ENV_CANARY"], drop: ["ENV_CANARY"] } }));
    if (failure === "revision") fs.writeFileSync(process.env.RELAY_CONFIG!, fs.readFileSync(process.env.RELAY_CONFIG!, "utf8"));
    if (failure === "target") updateNode(f.node, { target: "claude" });
    if (failure === "path") updateNode(f.node, { cwd: path.join(dir, "different") });
    if (failure === "lost-peer") ctl.abort();
    if (failure === "restart") await closeRootEnvironment(f.inst);
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (failure === "restart") {
      const restarted = await openRootEnvironment(f.inst, realTransport ? {} : { peerIdentity: async () => ({ pid: process.pid, uid: process.getuid!(), start: procStart(process.pid)! }) }); process.env.RELAY_ENV_SOCKET = restarted.socket;
      const again = turnEnvironment(f.turn(["ENV_CANARY"]));
      const denied = assert.rejects(again, /denied|expired/);
      const fresh = await pending(f.node); assert.notEqual(fresh.id, r.id);
      approve(f.inst, { request_id: fresh.id, decision: "deny" }); await denied;
    } else assert.notEqual(getRequest(r.id)?.status, "allowed");
  });
}

test("tool env consent: concurrent claims release once; a non-worker cannot request values", async (t) => {
  const f = await fixture(t);
  const id = f.turn(["ENV_CANARY"]);
  const claims = [turnEnvironment(id), turnEnvironment(id)];
  // Install rejection handlers immediately, since the losing peer fails before consent arrives.
  const results = Promise.allSettled(claims);
  const r = await pending(f.node); confirm(f.inst, confirmArgs(r));
  assert.deepEqual((await results).map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  updateNode(f.node, { worker_pid: process.pid + 100000 });
  await assert.rejects(turnEnvironment(f.turn()), /registry-pinned/);
});

test("tool env grants: root-only admission and network/env independence across modes", async (t) => {
  const f = await fixture(t);
  const caller = { runId: f.run, node: null, depth: 0, cwd: dir, access: "write" as const };
  for (const mode of ["read", "write"] as const) for (const network of [false, true]) for (const env of [undefined, ["ENV_CANARY"]]) {
    const result = admitWork(caller, "codex", { mode, continues: false, grant: { network, env } }, {});
    assert.equal("reason" in result, false, JSON.stringify(result));
    if (!("reason" in result)) {
      assert.equal(Boolean(result.grant?.network), network);
      assert.deepEqual(result.grant?.env, env);
      assert.equal(persistentGrant(result.grant)?.env, undefined);
    }
  }
  assert.match((admitWork(caller, "codex", { mode: "read", continues: false, grant: { env: ["ENV_CANARY"] } }, { codexSubagent: true }) as { reason: string }).reason, /subagent/);
  const child = { ...caller, node: { id: f.node } } as never;
  assert.match((admitWork(child, "codex", { mode: "read", continues: false, grant: { env: ["ENV_CANARY"] } }, {}) as { reason: string }).reason, /only the root/);
  f.inst.host = { recognised: false };
  assert.match(environmentAdmission(f.run, "codex", ["ENV_CANARY"])!, /No such person path/);
});

/** As the worker leaves a session it has picked a turn of: the session queued, that turn its next. */
const queuedOn = (node: string) => (names?: string[]) => { const id = insertTurn(node, "caller", "synthetic purpose", "read"); recordEnvironmentRequest(id, names); return id; };
const noOpSave = () => fs.writeFileSync(process.env.RELAY_CONFIG!, fs.readFileSync(process.env.RELAY_CONFIG!, "utf8"));

test("tool env claim: a queued turn is claimed as its worker picks it up, held for one launch, rechecked then, and dropped otherwise", async (t) => {
  const f = await fixture(t);
  updateNode(f.node, { status: "queued" });
  const queued = queuedOn(f.node);
  const first = queued(["ENV_CANARY"]);
  const claiming = claimTurnEnvironment(first);
  const r = await pending(f.node);
  assert.equal(getTurn(first)!.status, "queued", "consent is asked before the turn starts");
  assert.equal(confirm(f.inst, confirmArgs(r)).decision, "allowed");
  const held = await claiming;
  held.check();
  held.check();
  const taken = held.take();
  assert.equal(taken.selection.env.ENV_CANARY, "opaque-request-canary-Q29x", "check does not consume the claim");
  assert.throws(() => held.take(), /already used or dropped/, "one launch per claim");
  held.drop();
  assert.equal(taken.selection.env.ENV_CANARY, "opaque-request-canary-Q29x", "dropping after the launch leaves the launch's environment alone");
  updateTurn(first, { status: "done" });

  const second = queued();
  const dropped = await claimTurnEnvironment(second);
  dropped.drop();
  assert.throws(() => dropped.check(), /already used or dropped/, "a turn that ends without launching forgets its environment");
  assert.throws(() => dropped.take(), /already used or dropped/);
  updateTurn(second, { status: "cancelled" });

  // Only the session's next turn can be claimed before it starts; the pinned worker is told why.
  queued();
  await assert.rejects(claimTurnEnvironment(queued()), /environment cannot be claimed: turn \d+ of j_\d+ is not its session's next turn/);
});

test("tool env claim: a standing claim outlives a no-op config save but not a change to its target's policy; a grant.env claim fails on any save", async (t) => {
  const f = await fixture(t);
  updateNode(f.node, { status: "queued" });
  const queued = queuedOn(f.node);
  const given = fs.readFileSync(process.env.RELAY_CONFIG!, "utf8");

  const standing = queued();
  const kept = await claimTurnEnvironment(standing);
  noOpSave();
  fs.utimesSync(process.env.RELAY_CONFIG!, new Date(), new Date(Date.now() + 5000));
  kept.check();
  assert.equal(kept.take().selection.env.JAVA_HOME, "/synthetic/java", "an edit that leaves the policy as it was does not fail a standing claim");
  updateTurn(standing, { status: "done" });

  const narrowed = queued();
  const stale = await claimTurnEnvironment(narrowed);
  fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify({ ...JSON.parse(given), targets: { codex: { child_env: { drop: ["UNUSED_EXAMPLE_TOKEN"] } } } }));
  assert.throws(() => stale.check(), /changed while it waited to start/);
  assert.throws(() => stale.take(), /already used or dropped/, "a refused claim is forgotten");
  updateTurn(narrowed, { status: "cancelled" });
  fs.writeFileSync(process.env.RELAY_CONFIG!, given);

  const requested = queued(["ENV_CANARY"]);
  const claiming = claimTurnEnvironment(requested);
  confirm(f.inst, confirmArgs(await pending(f.node)));
  const consented = await claiming;
  noOpSave();
  assert.throws(() => consented.take(), /changed while it waited to start/, "consent is bound to the config file it was given under");
});

test("tool env claim: cancel or root loss while a queued turn's consent is pending expires the request and releases nothing", async (t) => {
  for (const loss of ["cancel", "root"] as const) {
    const f = await fixture(t);
    updateNode(f.node, { status: "queued" });
    const id = queuedOn(f.node)(["ENV_CANARY"]);
    const rejected = assert.rejects(claimTurnEnvironment(id), /denied|expired|cancelled|unavailable|closed/);
    const r = await pending(f.node);
    if (loss === "cancel") { updateTurn(id, { status: "cancelled" }); updateNode(f.node, { status: "cancelled" }); }
    else await closeRootEnvironment(f.inst);
    await rejected;
    for (let i = 0; i < 100 && getRequest(r.id)!.status === "pending"; i++) await delay();
    assert.equal(getRequest(r.id)!.status, "expired", loss);
  }
});

test("tool env claim: decide refuses a queued turn's consent once the turn is no longer queued, next or uncancelled", async (t) => {
  for (const change of ["turn cancelled", "not next", "session started", "run cancelled"] as const) {
    const f = await fixture(t);
    updateNode(f.node, { status: "queued" });
    const queued = queuedOn(f.node);
    const earlier = queued();
    updateTurn(earlier, { status: "done" });
    const id = queued(["ENV_CANARY"]);
    const rejected = assert.rejects(claimTurnEnvironment(id), /denied|expired|cancelled|binding changed/);
    const r = await pending(f.node);
    // Decided in the same tick as the change, before the request's own wait looks again.
    if (change === "turn cancelled") updateTurn(id, { status: "cancelled" });
    if (change === "not next") updateTurn(earlier, { status: "queued" });
    if (change === "session started") updateNode(f.node, { status: "running" });
    if (change === "run cancelled") db().prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(f.run);
    const decided = decide(r.id, true, "user");
    const why = { "turn cancelled": /has ended \(cancelled\)/, "not next": /is not its session's next turn/, "session started": /is not about to start \(its session is running\)/, "run cancelled": /its run has been cancelled/ }[change];
    assert.match(String(decided.error), /can no longer be decided/, change);
    assert.match(String(decided.error), why, change);
    assert.equal(getRequest(r.id)!.status, "expired", change);
    await rejected;
  }
});

test("tool env claim: the broker tells the pinned worker why a follow-up behind a running turn cannot be claimed yet", async (t) => {
  const f = await fixture(t);
  f.turn();
  const followup = queuedOn(f.node)();
  await assert.rejects(claimTurnEnvironment(followup), new RegExp(`environment cannot be claimed: turn ${followup} of ${f.node} is not about to start \\(its session is running\\)`));
});

test("tool env consent: real Unix transport and kernel worker-peer gate", { skip: realTransport ? false : "outer sandbox blocks Unix listen; matrix above uses in-memory transport and fixed host-side peer fixture" }, () => { assert.equal(realTransport, true); });
