import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closeDbForTests, createRun, db, insertNode, insertTurn, updateTurn } from "../dist/core/db.js";
import { withDefaults } from "../dist/core/config.js";
import { allowOverlay, assertOverlayLaunch, consumeOverlay, createOverlayRequest, finishOverlay, getOverlay, markOverlayLaunched, markOverlayReceipt, nextOverlayTurn, originOverlay, overlayInterlock, overlayPrompt, overlayTurnProblem, prepareOverlayRestart, reapOverlays, setOverlayClockForTests, overlayDeadlineExpired, settleOverlayRequestInTransaction } from "../dist/core/restart-overlay.js";
import { tx, setParam } from "../dist/core/db.js";
import { reserveLaunch, finishLaunchReservation, launchReservationState } from "../dist/core/restart-overlay.js";
import { stage2Wanted } from "../dist/backends/codex-stage2.js";
import { targetDef } from "../dist/targets/index.js";
import { executorPolicy } from "../dist/backends/codex-env.js";
import { seatbeltProfile } from "../dist/confine/seatbelt.js";
import { readNeverFloor } from "../dist/core/never-checkpoint.js";
import { setOverlayControlSnapshotForTests } from "../dist/core/restart-overlay.js";

setOverlayControlSnapshotForTests(() => ({ ports: [], controlPlanes: [] }));

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "overlay-")));
  const old = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = path.join(home, "registry");
  process.env.RELAY_CONFIG = path.join(home, "config.json");
  const cfg = withDefaults({ targets: { codex: { stage2: true } }, job_timeout_s: null, turn_timeout_s: null });
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
  const run = createRun(home, cfg, "test-root");
  const cwd = path.join(home, "work"); fs.mkdirSync(cwd);
  insertNode({ id: "j_overlay", run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "test", cwd, status: "running" });
  const origin = insertTurn("j_overlay", "initial", "test", "write", "running");
  let wall = 100_000, mono = 1000;
  setOverlayClockForTests({ wall: () => wall, mono: () => mono, boot: () => "unit-boot", owner: () => ({ pid: process.pid, start: "unit-start" }) });
  const request = (extra = {}) => createOverlayRequest({ nodeId: "j_overlay", originTurn: origin, capabilities: [{ kind: "port0" }], reason: "tests", continuation: "continue tests", authority: { owningRoot: "root-session", tokenBinding: "nonsecret-version-1", required_decider: "owning_run_root" }, ...extra });
  const allow = (r = request()) => allowOverlay(run, r.id, r.digest, { decisionId: "decision-1", decidedBy: "root-session", route: "supervisor", at: wall });
  const ready = () => { const r = allow(); markOverlayReceipt(run, r.id, true); updateTurn(origin, { status: "done" }); return prepareOverlayRestart(run, r.id, { clean: true }); };
  return { home, run, origin, request, allow, ready, clock(w: number, m: number) { wall = w; mono = m; }, close() { setOverlayClockForTests(null); closeDbForTests(); for (const [k,v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; fs.rmSync(home, { recursive: true, force: true }); } };
}

test("overlay allow closes origin with durable receipt; no destination before receipt and verified teardown", () => {
  const f = fixture(); try {
    const r = f.allow();
    assert.equal(r.state, "pending_restart");
    assert.match(r.receipt!.disclosures.join(" "), /reserved block of 4 TCP ports \(\$PORT\/\$PORTS\).*LAN and tailnet/);
    assert.match(overlayTurnProblem("j_overlay", f.origin)!, /closing/);
    assert.equal(originOverlay("j_overlay", f.origin)?.id, r.id);
    assert.throws(() => prepareOverlayRestart(f.run, r.id, { clean: true }), /receipt|origin/);
    markOverlayReceipt(f.run, r.id, true); updateTurn(f.origin, { status: "done" });
    const tainted = prepareOverlayRestart(f.run, r.id, { clean: false, problem: "detached survivor" });
    assert.equal(tainted.state, "tainted");
    assert.match(overlayInterlock("local")!, /tainted/);
    assert.throws(() => consumeOverlay(f.run, r.id, 999), /ready|destination/);
  } finally { f.close(); }
});

test("listen disclosure names its port and the opened job block with LAN and tailnet exposure", () => {
  const f = fixture(); try {
    const r = f.request({ capabilities: [{ kind: "localhost", operation: "listen", port: 49240 }] });
    const text = r.request.disclosures.join(" ");
    assert.match(text, /TCP listen port 49240.*LAN and tailnet/);
    assert.match(text, /reserved block of 4 TCP ports \(\$PORT\/\$PORTS\).*LAN and tailnet/);
  } finally { f.close(); }
});

test("destination is assigned atomically, consumed once, never inherited by unrelated resume", () => {
  const f = fixture(); try {
    const r = f.ready(); assert.ok(r.destinationTurn);
    assert.throws(() => consumeOverlay(f.run, r.id, r.destinationTurn! + 1), /destination/);
    const consumed = consumeOverlay(f.run, r.id, r.destinationTurn!);
    assert.equal(consumed.state, "running");
    assert.equal(consumed.budgetMs, 3_600_000);
    assert.equal(consumed.recoveryDeadline, 3_700_000);
    assert.throws(() => consumeOverlay(f.run, r.id, r.destinationTurn!), /consum/);
    assert.match(overlayTurnProblem("j_overlay", 999)!, /overlay/);
    assert.equal(finishOverlay(f.run, r.id, { clean: true }).state, "expired");
    assert.equal(overlayTurnProblem("j_overlay", 999), null);
  } finally { f.close(); }
});

test("default deadline is monotonic through backward wall clocks and approval pauses", () => {
  const f = fixture(); try {
    const r = f.ready(); const c = consumeOverlay(f.run, r.id, r.destinationTurn!);
    f.clock(90_000, 3_601_001);
    assert.equal(overlayDeadlineExpired(c), true);
    assert.match(overlayTurnProblem("j_overlay", r.destinationTurn!)!, /deadline/);
    assert.equal(getOverlay(f.run, r.id).state, "stopping");
    assert.equal(finishOverlay(f.run, r.id, { clean: false, problem: "survivors" }).state, "tainted");
  } finally { f.close(); }
});

test("tighter bounds and pending expiry cannot be renewed by a late allow", () => {
  const f = fixture(); try {
    const r = f.request({ remainingMs: 700 });
    assert.equal(r.budgetMs, 700);
    f.clock(101_000, 2000);
    assert.throws(() => f.allow(r), /expir/);
  } finally { f.close(); }
});

test("worker death recovery stops app first and retains taint until a clean reap", () => {
  const f = fixture(); try {
    const r = f.ready(); consumeOverlay(f.run, r.id, r.destinationTurn!);
    const order: string[] = [];
    reapOverlays(f.run, { ownerAlive: () => false, stop: () => { order.push("app-first-stop"); return { clean: false, problem: "sweep uncertain" }; } });
    assert.deepEqual(order, ["app-first-stop"]); assert.equal(getOverlay(f.run, r.id).state, "tainted");
    reapOverlays(f.run, { ownerAlive: () => false, stop: () => ({ clean: true }) });
    assert.equal(getOverlay(f.run, r.id).state, "expired");
    assert.equal(overlayInterlock("local"), null);
  } finally { f.close(); }
});

test("never additions and grant changes invalidate pending approval at launch", () => {
  const f = fixture(); try {
    const r = f.ready();
    fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify(withDefaults({ never: { ports: [{ port: 49222 }] } })));
    assert.throws(() => consumeOverlay(f.run, r.id, r.destinationTurn!), /never.*changed/);
    assert.equal(getOverlay(f.run, r.id).state, "ready");
  } finally { f.close(); }
});

test("WP6 floor: add before approve, remove before launch and registry reload never shrink the approved floor", () => {
  const f = fixture(); try {
    const decoy = path.join(f.home, "never-decoy"); fs.mkdirSync(decoy);
    fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify(withDefaults({ never: { paths: [{ path: decoy }] } })));
    const r = f.allow();
    markOverlayReceipt(f.run, r.id, true); updateTurn(f.origin, { status: "done" });
    const saved = readNeverFloor(f.run)!;
    fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify(withDefaults({})));
    closeDbForTests();
    const ready = prepareOverlayRestart(f.run, r.id, { clean: true });
    const consumed = consumeOverlay(f.run, r.id, ready.destinationTurn!);
    assert.equal(consumed.state, "running");
    assert.equal(readNeverFloor(f.run)!.hash, saved.hash);
    assert.ok(readNeverFloor(f.run)!.paths.some(p => p.path === decoy));
  } finally { f.close(); }
});

for (const access of ["all", "write"]) test(`WP6 outside tree: ${access} never floor refuses parent and descendant grants`, () => {
  const f = fixture(); try {
    const parent = path.join(f.home, "outside-installation"); fs.mkdirSync(parent);
    const decoy = path.join(parent, "installation-decoy"); fs.mkdirSync(decoy);
    fs.mkdirSync(path.join(decoy, "child"));
    fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify(withDefaults({ never: { paths: [{ path: decoy, access }] } })));
    for (const root of [parent, path.join(decoy, "child")]) {
      assert.throws(() => f.request({ capabilities: [{ kind: "write", scope: "tree", root }] }), /never|protected/);
    }
  } finally { f.close(); }
});

test("typed capabilities refuse opaque providers, read widening, never roots and control endpoints", () => {
  const f = fixture(); try {
    for (const capabilities of [[{ kind: "network", mode: "local" }], [{ kind: "localhost", operation: "connect", port: 5900 }], [{ kind: "write", root: process.env.RELAY_HOME!, scope: "tree" }], [{ kind: "port0", extra: true }]]) {
      assert.throws(() => f.request({ capabilities }), /never|capability_unavailable|Unrecognized|unrecognized|requires a person decision/);
    }
  } finally { f.close(); }
});

test("malformed overlay records fail the per-registry interlock closed", () => {
  const f = fixture(); try {
    f.request();
    db().prepare("UPDATE runs SET config_json = json_set(config_json, '$.params_json.overlays', json(?)) WHERE id = ?").run('{"bad":{}}', f.run);
    assert.match(overlayInterlock("local")!, /malformed/);
    assert.match(overlayInterlock("stage2")!, /malformed/);
  } finally { f.close(); }
});

test("WP4: overlay-only reservation blocks local through pending, ready, running, stopping and tainted states with flags off", () => {
  const f = fixture(); try {
    const check = (id: string, state: string) => {
      setParam("j_overlay", "grant", null);
      assert.match(overlayInterlock("local")!, new RegExp(`overlay ${id} ${state} reserves stage2.*reap/cancel`));
    };
    const r = f.request(); check(r.id, "requested");
    f.allow(r); check(r.id, "pending_restart");
    markOverlayReceipt(f.run, r.id, true); check(r.id, "stopping");
    updateTurn(f.origin, { status: "done" });
    const ready = prepareOverlayRestart(f.run, r.id, { clean: true }); check(r.id, "ready");
    consumeOverlay(f.run, r.id, ready.destinationTurn!); check(r.id, "running");
    // Feature flags and standing node grants are not classification evidence.
    db().prepare("UPDATE runs SET config_json=json_set(config_json,'$.targets.codex.stage2',json('false')) WHERE id=?").run(f.run);
    finishOverlay(f.run, r.id, { clean: false, problem: "uncertain survivor sweep" }); check(r.id, "tainted");
    finishOverlay(f.run, r.id, { clean: true }); assert.equal(overlayInterlock("local"), null);
  } finally { f.close(); }
});

test("WP4: pending destination may reserve beside its source local proxy, but no same-job launch exemption", () => {
  const f = fixture(); try {
    updateTurn(f.origin, { grant_json: '{"network":true,"local_network":true}' });
    reserveLaunch("j_overlay", f.origin, "local"); launchReservationState(f.run, f.origin, "running");
    const r = f.allow(); markOverlayReceipt(f.run, r.id, true); updateTurn(f.origin, { status: "done" });
    assert.throws(() => prepareOverlayRestart(f.run, r.id, { clean: true }), /reservation.*j_overlay running.*local/);
    finishLaunchReservation(f.run, f.origin, { clean: false, problem: "source proxy still alive" });
    assert.throws(() => prepareOverlayRestart(f.run, r.id, { clean: true }), /j_overlay tainted/);
    finishLaunchReservation(f.run, f.origin, { clean: true });
    assert.equal(prepareOverlayRestart(f.run, r.id, { clean: true }).state, "ready");
  } finally { f.close(); }
});

test("IPv4 localhost connect approval carries LAN/tailnet disclosure and refuses IPv6 and control ports", () => {
  const f = fixture(); try {
    for (const port of [22, 5900, 47200]) {
      assert.throws(() => f.request({ capabilities: [{ kind: "localhost", operation: "connect", port }] }), /never/);
    }
    assert.throws(() => f.request({ capabilities: [{ kind: "localhost", operation: "connect", port: 49240, host: "::1" }] }));
    const request = f.request({ capabilities: [{ kind: "localhost", operation: "connect", port: 49240 }] });
    assert.match(request.request.disclosures.join(" "), /port 49240 on this Mac's LAN and tailnet addresses/);
    const allowed = f.allow(request);
    assert.match(overlayPrompt(allowed), /LAN and tailnet/);
  } finally { f.close(); }
});

test("static denied ports cannot be localhost connect or listen exceptions and are rechecked before decision", () => {
  const f = fixture(); try {
    for (const operation of ["connect", "listen"] as const) for (const port of [22, 3031, 3283, 445, 548, 631]) {
      assert.throws(() => f.request({ capabilities: [{ kind: "localhost", operation, port }] }), new RegExp(`static denied TCP port ${port}`));
    }
    const pending = f.request({ capabilities: [{ kind: "localhost", operation: "connect", port: 49240 }] });
    setOverlayControlSnapshotForTests(() => ({ ports: [49240], controlPlanes: [49240] }));
    assert.throws(() => f.allow(pending), /control listeners/, "validatePlan rechecks authority immediately before the decision");
  } finally { setOverlayControlSnapshotForTests(() => ({ ports: [], controlPlanes: [] })); f.close(); }
});

test("standing mediated baseline survives a port0 addition and raw substitution is refused", () => {
  const f = fixture(); try {
    setParam("j_overlay", "grant", { network: true });
    assert.throws(() => f.request({ capabilities: [{ kind: "network", mode: "raw" }], authority: { owningRoot: "root-session", tokenBinding: "nonsecret-version-1", required_decider: "person" } }), /cannot be combined/);
    const request = f.allow();
    markOverlayReceipt(f.run, request.id, true); updateTurn(f.origin, { status: "done" });
    const ready = prepareOverlayRestart(f.run, request.id, { clean: true });
    const consumed = consumeOverlay(f.run, request.id, ready.destinationTurn!);
    assert.equal(consumed.state, "running");
    assert.match(overlayPrompt(consumed), /port0/);
  } finally { f.close(); }
});

test("localhost connect refuses non-reserved control listeners and unreadable snapshots before approval", () => {
  const f = fixture(); try {
    setOverlayControlSnapshotForTests(() => ({ ports: [49240], controlPlanes: [49240] }));
    assert.throws(() => f.request({ capabilities: [{ kind: "localhost", operation: "connect", port: 49240 }] }), /never relay.authority.*control listeners/);
    setOverlayControlSnapshotForTests(() => { throw new Error("fixture snapshot unavailable"); });
    assert.throws(() => f.request({ capabilities: [{ kind: "localhost", operation: "connect", port: 49240 }] }), /cannot check localhost control listeners.*fixture snapshot unavailable/);
  } finally { setOverlayControlSnapshotForTests(() => ({ ports: [], controlPlanes: [] })); f.close(); }
});

test("failed receipt delivery persists allowed-not-executed and never queues a destination", () => {
  const f = fixture(); try {
    const r = f.allow(); markOverlayReceipt(f.run, r.id, false); updateTurn(f.origin, { status: "done" });
    const stopped = prepareOverlayRestart(f.run, r.id, { clean: true });
    assert.equal(stopped.state, "failed"); assert.equal(stopped.destinationTurn, undefined);
    assert.equal(stopped.receipt?.delivered, false);
  } finally { f.close(); }
});

test("an expired consumption cannot launch or be revived by a second attempt", () => {
  const f = fixture(); try {
    const r = f.ready(); f.clock(r.request.pendingDeadline, r.request.pendingMonotonicDeadline);
    assert.throws(() => consumeOverlay(f.run, r.id, r.destinationTurn!), /expired/);
    assert.equal(getOverlay(f.run, r.id).consumedAt, undefined);
  } finally { f.close(); }
});

test("a grant change after allow cannot widen the replacement turn", () => {
  const f = fixture(); try {
    const r = f.ready(); setParam("j_overlay", "grant", { network: true, raw_network: true });
    assert.throws(() => consumeOverlay(f.run, r.id, r.destinationTurn!), /grant changed/);
  } finally { f.close(); }
});

test("read access cannot silently acquire an outside write root", () => {
  const f = fixture(); try {
    const root = path.join(f.home, "outside"); fs.mkdirSync(root); updateTurn(f.origin, { access: "read" });
    assert.throws(() => f.request({ capabilities: [{ kind: "write", scope: "tree", root }] }), /read jobs/);
  } finally { f.close(); }
});

test("outside writes pin exact existing trees and missing files; a swapped root refuses launch", () => {
  const f = fixture(); try {
    const root = path.join(f.home, "outside"); fs.mkdirSync(root);
    const r = f.allow(f.request({ capabilities: [{ kind: "write", scope: "tree", root }, { kind: "write", scope: "file", root: path.join(f.home, "missing.txt") }] }));
    assert.equal(r.request.roots[1].existed, false);
    markOverlayReceipt(f.run, r.id, true); updateTurn(f.origin, { status: "done" });
    fs.renameSync(root, root + "-old"); fs.mkdirSync(root);
    assert.throws(() => prepareOverlayRestart(f.run, r.id, { clean: true }), /identity changed/);
  } finally { f.close(); }
});

for (const attack of ["symlink", "hardlink"]) test(`WP6 outside file: ${attack} replacement after approval invalidates the root pin`, () => {
  const f = fixture(); try {
    const root = path.join(f.home, "approved-file"), decoy = path.join(f.home, "owned-decoy");
    fs.writeFileSync(root, "approved"); fs.writeFileSync(decoy, "untouched");
    const r = f.allow(f.request({ capabilities: [{ kind: "write", scope: "file", root }] }));
    markOverlayReceipt(f.run, r.id, true); updateTurn(f.origin, { status: "done" });
    fs.unlinkSync(root);
    if (attack === "symlink") fs.symlinkSync(decoy, root); else fs.linkSync(decoy, root);
    assert.throws(() => prepareOverlayRestart(f.run, r.id, { clean: true }), /identity changed|never/);
    assert.equal(fs.readFileSync(decoy, "utf8"), "untouched");
    assert.equal(getOverlay(f.run, r.id).destinationTurn, undefined);
  } finally { f.close(); }
});

test("WP6 another job cannot use an overlay destination, before or after consumption", () => {
  const f = fixture(); try {
    const r = f.ready();
    insertNode({ id: "j_foreign", run_id: f.run, kind: "job", target: "codex", mode: "write", depth: 1, task: "foreign", cwd: f.home, status: "running" });
    const foreign = insertTurn("j_foreign", "test", "try stolen overlay", "write", "running");
    assert.throws(() => consumeOverlay(f.run, r.id, foreign), /destination/);
    const consumed = consumeOverlay(f.run, r.id, r.destinationTurn!);
    assert.throws(() => assertOverlayLaunch(consumed, foreign), /destination/);
    assert.throws(() => consumeOverlay(f.run, r.id, r.destinationTurn!), /consumed/);
    assert.equal(getOverlay(f.run, r.id).destinationTurn, r.destinationTurn);
  } finally { f.close(); }
});

test("consume records survive registry reload and reject unknown recovery clocks", () => {
  const f = fixture(); try {
    const ready = f.ready(); const r = consumeOverlay(f.run, ready.id, ready.destinationTurn!);
    closeDbForTests(); assert.equal(getOverlay(f.run, r.id).recoveryDeadline, r.recoveryDeadline);
    setOverlayClockForTests({ wall: () => 100_000, mono: () => 1000, boot: () => "different-boot" });
    assert.equal(overlayDeadlineExpired(getOverlay(f.run, r.id)), true);
    assert.throws(() => assertOverlayLaunch(r, r.destinationTurn), /expired/);
  } finally { f.close(); }
});

test("a crash after consumption never retries and deadline is never reset", () => {
  const f = fixture(); try {
    const ready = f.ready(); const r = consumeOverlay(f.run, ready.id, ready.destinationTurn!);
    closeDbForTests(); f.clock(101_000, 2000);
    assert.throws(() => consumeOverlay(f.run, r.id, r.destinationTurn!), /consumed/);
    assert.equal(getOverlay(f.run, r.id).recoveryDeadline, r.recoveryDeadline);
  } finally { f.close(); }
});

test("terminal allow/deny race has one winner with immutable decision provenance", () => {
  const f = fixture(); try {
    const request = f.request(); const r = f.allow(request);
    assert.throws(() => tx(() => settleOverlayRequestInTransaction(f.run, r.id, r.digest, "denied")), /terminal/);
    assert.throws(() => f.allow(request), /terminal/);
    assert.equal(getOverlay(f.run, r.id).decision?.decisionId, "decision-1");
  } finally { f.close(); }
});

test("raw scope cannot be classified as supervisor and host-never refuses even person raw", () => {
  const f = fixture(); try {
    assert.throws(() => f.request({ capabilities: [{ kind: "network", mode: "raw" }] }), /person/);
    fs.writeFileSync(process.env.RELAY_CONFIG!, JSON.stringify(withDefaults({ never: { hosts: ["decoy.example"] } })));
    assert.throws(() => f.request({ capabilities: [{ kind: "network", mode: "raw" }], authority: { owningRoot: "root", tokenBinding: "version", required_decider: "person" } }), /never.hosts/);
  } finally { f.close(); }
});

test("overlay-only plans select stage2 without manufacturing a standing raw grant", () => {
  const f = fixture(); try {
    const ready = f.ready(); const r = consumeOverlay(f.run, ready.id, ready.destinationTurn!);
    assert.equal(stage2Wanted({ config: withDefaults({ targets: { codex: { stage2: true } } }), target: targetDef("codex"), overlay: r }), true);
    assertOverlayLaunch(r, r.destinationTurn);
    assert.throws(() => assertOverlayLaunch(r, f.origin), /destination/);
  } finally { f.close(); }
});

test("captured local turn blocks overlay consumption even after mutable grant removal", () => {
  const f = fixture(); try {
    const ready = f.ready();
    insertNode({ id: "j_local", run_id: f.run, kind: "job", target: "codex", mode: "write", depth: 1, task: "local", cwd: f.home, status: "running" });
    const turn = insertTurn("j_local", "initial", "local", "write", "running");
    updateTurn(turn, { grant_json: JSON.stringify({ network: true, local_network: true }) });
    assert.throws(() => consumeOverlay(f.run, ready.id, ready.destinationTurn!), /j_local is running a turn in local network mode/);
  } finally { f.close(); }
});

test("replacement runs before already queued messages, which retain baseline authority", () => {
  const f = fixture(); try {
    const queued = insertTurn("j_overlay", "followup", "unrelated continuation", "write");
    const ready = f.ready();
    assert.ok(queued < ready.destinationTurn!);
    assert.equal(nextOverlayTurn("j_overlay")?.id, ready.destinationTurn);
    assert.match(overlayTurnProblem("j_overlay", queued)!, /overlay/);
    const c = consumeOverlay(f.run, ready.id, ready.destinationTurn!);
    assert.match(overlayPrompt(c), /outcome unknown/);
    const launched = markOverlayLaunched(c, c.destinationTurn);
    assert.match(overlayPrompt(launched), /This turn allowed listeners to bind 0.0.0.0/);
    assert.throws(() => markOverlayLaunched(c, c.destinationTurn), /already recorded/);
    finishOverlay(f.run, c.id, { clean: true });
    assert.equal(overlayTurnProblem("j_overlay", queued), null);
  } finally { f.close(); }
});

test("production executor compiler applies exact file/tree writes with final floor parameters", () => {
  const f = fixture(); try {
    const root = path.join(f.home, "outside"); fs.mkdirSync(root);
    const tmp = path.join(f.home, "tmp"); fs.mkdirSync(tmp);
    const file = path.join(f.home, "missing.txt");
    const r = f.allow(f.request({ capabilities: [{ kind: "write", root, scope: "tree" }, { kind: "write", root: file, scope: "file" }] }));
    markOverlayReceipt(f.run, r.id, true); updateTurn(f.origin, { status: "done" });
    const ready = prepareOverlayRestart(f.run, r.id, { clean: true }); const consumed = consumeOverlay(f.run, ready.id, ready.destinationTurn!);
    const policy = executorPolicy({ target: targetDef("codex"), cwd: path.join(f.home, "work"), access: "write", config: withDefaults({}), neverPolicy: readNeverFloor(f.run)!, overlay: consumed } as any, tmp,
      { mode: "stage2", egress: "none", deniedTcp: [], deniedUdp: [], relayRange: [49230, 49233], execPort: 49230, bindPorts: [], worktreeSockets: false });
    const profile = seatbeltProfile(policy); const params = Object.fromEntries(profile.params);
    assert.deepEqual(policy.overlayRoots, consumed.request.roots, "probe roots come from this consumed overlay only");
    assert.equal(params.OVERLAY_FILE_0, file); assert.ok(Object.entries(params).some(([k,v]) => k.startsWith("WRITABLE_") && v === root));
    assert.match(profile.profile, /allow file-write\* \(literal \(param "OVERLAY_FILE_0"\)\)/);
    assert.match(profile.profile, /deny file-link \(literal \(param "OVERLAY_FILE_0"\)\)/);
    assert.ok(profile.profile.lastIndexOf("NEVER_") > profile.profile.indexOf("OVERLAY_FILE_0"));
    assert.doesNotMatch(profile.profile, /allow network-outbound \(remote ip[46] "\*:\*"/);
    assert.doesNotMatch(profile.profile, /\((?:remote|local)\s+(?:ip[46]?|tcp|udp)\s+(?:\(string-append\s+)?"(?:\d+\.\d+\.\d+\.\d+|\[?::1)/);
  } finally { f.close(); }
});

test("fresh person-authorized raw overlay adds one turn without a standing raw grant", () => {
  const f = fixture(); try {
    const request = f.request({ capabilities: [{ kind: "network", mode: "raw" }], authority: { owningRoot: "root-session", tokenBinding: "version", required_decider: "person" } });
    const r = allowOverlay(f.run, request.id, request.digest, { decisionId: "person-1", decidedBy: "person-dialog", route: "person", at: 100_000 });
    markOverlayReceipt(f.run, r.id, true); updateTurn(f.origin, { status: "done" });
    const ready = prepareOverlayRestart(f.run, r.id, { clean: true }); const c = consumeOverlay(f.run, ready.id, ready.destinationTurn!);
    assertOverlayLaunch(c, c.destinationTurn); assert.equal(c.request.authority.required_decider, "person");
    assert.equal(JSON.parse((db().prepare("SELECT params_json FROM nodes WHERE id='j_overlay'").get() as any).params_json ?? "{}").grant, undefined);
  } finally { f.close(); }
});
