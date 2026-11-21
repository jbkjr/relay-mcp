import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { claimElicitation, decide, elicitationState, endElicitation, getRequest } from "../dist/core/approvals.js";
import { admitWork, newInstance } from "../dist/core/caller.js";
import { withDefaults } from "../dist/core/config.js";
import { closeDbForTests, createRun, db, insertNode, insertTurn, newId } from "../dist/core/db.js";
import { approve } from "../dist/core/ops.js";
import { markRoomExposure, roomOwnerExposed, roomOwnerHash } from "../dist/core/room-policy.js";
import { ROOM_REFUSALS } from "../dist/core/room-types.js";
import { issueSessionToken, sessionOwner, sessionView } from "../dist/core/session-token.js";
import { harness, INTERACTIVE_CLAUDE, nonTempScratch, task, terminalApprove, until, UNAVAILABLE_REPLY, type Rec } from "./helpers.ts";

const STATES = ["unasked", "asking", "dismissed", "unattributed", "error", "withdrawn", "decided", "abandoned"] as const;
type State = typeof STATES[number];
const C1 = { refused: true, reason: ROOM_REFUSALS.user_confirmed };

function fixture() {
  closeDbForTests();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rooms-auth-")));
  const saved = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  process.env.RELAY_HOME = path.join(home, "registry");
  process.env.RELAY_CONFIG = path.join(home, "config.json");
  const cfg = withDefaults({});
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify(cfg));
  const owner = (inst = newInstance({ kind: "root" }, home, "claude")) => {
    const run = createRun(home, cfg, inst.token);
    const node = insertNode({ id: newId("job"), run_id: run, kind: "job", target: "codex", mode: "write", depth: 1, task: "C1 test", cwd: home, status: "running" });
    const turn = insertTurn(node.id, "test", "C1 test", "write", "running");
    const request = (state: State = "unasked", kind = "web", summary = "web search: C1 test") => {
      const id = newId("request");
      db().prepare("INSERT INTO requests (id, run_id, node_id, turn_id, kind, summary, detail_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, '{}', 'pending', ?)")
        .run(id, run, node.id, turn, kind, summary, Date.now());
      if (state !== "unasked") {
        assert.equal(claimElicitation(id, inst.token), true);
        if (state === "abandoned") db().prepare("UPDATE elicitations SET pid = -1 WHERE request_id = ?").run(id);
        else if (state !== "asking") endElicitation(id, inst.token, state === "dismissed" ? "cancel" : state, state);
      }
      return id;
    };
    return { inst, run, node, request, expose: () => markRoomExposure(roomOwnerHash(inst.token)) };
  };
  return {
    owner,
    close() {
      closeDbForTests();
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

for (const exposed of [false, true]) test(`rooms C1: ${exposed ? "exposed" : "unexposed"} model approvals preserve each elicitation state and denials`, () => {
  const f = fixture();
  try {
    const o = f.owner();
    if (exposed) o.expose();
    for (const state of STATES) for (const user_confirmed of [false, true]) {
      const id = o.request(state);
      const blocked = state === "asking" || state === "dismissed";
      assert.deepEqual(elicitationState(id), state === "unattributed" ? { unattributed: state } : blocked ? state : null);
      const result = approve(o.inst, { request_id: id, decision: "allow", user_confirmed, scope: "job", note: "test note" });
      const label = user_confirmed && !exposed ? "root session, stating that the user confirmed" : "root session";
      if (blocked && (exposed || !user_confirmed)) {
        if (exposed) assert.deepEqual(result, C1, "fixed refusal only: no room view or text");
        else assert.deepEqual(result, { refused: true, reason: "Refused: " +
          (state === "asking" ? "the user is being asked about this request directly right now" : "the user was shown this request and closed it without answering") +
          ", so you cannot allow it on your own judgment. Ask them in conversation; if they tell you to allow it, call approve again with user_confirmed: true. You may deny it without asking." });
        assert.equal(getRequest(id)!.status, "pending");
        assert.equal(getRequest(id)!.decided_by, null);
        const denied = approve(o.inst, { request_id: id, decision: "deny", user_confirmed, note: "deny note" });
        assert.equal(denied.decision, "denied");
        assert.equal(denied.decided_by, label);
        assert.equal(getRequest(id)!.note, "deny note");
      } else {
        assert.equal(result.decision, "allowed", `${state}, flag ${user_confirmed}`);
        assert.equal(result.decided_by, label);
        assert.equal(getRequest(id)!.scope, "job");
        assert.equal(getRequest(id)!.note, "test note");
      }
      // Denials never needed confirmation, including when the flag is supplied.
      const denyId = o.request(state);
      assert.equal(approve(o.inst, { request_id: denyId, decision: "deny", user_confirmed }).decided_by, label);
      assert.equal(getRequest(denyId)!.status, "denied");
      assert.equal(getRequest(denyId)!.scope, null);
    }
  } finally { f.close(); }
});

test("rooms C1: person-only, relay-command, child and subagent refusals are unchanged", () => {
  const f = fixture();
  try {
    const o = f.owner();
    const personal = o.request("asking", "extensions", "give extensions");
    const command = o.request("dismissed", "command", "relay approve q_12345678");
    const ordinary = o.request();
    const before = [personal, command].map(request_id => approve(o.inst, { request_id, decision: "allow", user_confirmed: true }));
    assert.match(String(before[0].reason), /only the user can allow.*relay takes no agent's word/);
    assert.deepEqual(before[1], { refused: true, reason: "Refused: this command runs relay's CLI, so only the person can allow it, through the host's approval dialog, confirm, or `relay approve` in their own terminal. You may deny it." });
    const subagent = { codexSubagent: true };
    const subBefore = approve(o.inst, { request_id: ordinary, decision: "allow", user_confirmed: true }, subagent);
    const child = newInstance({ kind: "child", runId: o.run, nodeId: o.node.id, depth: 1, turnId: getRequest(ordinary)!.turn_id!, access: "write", mayDelegate: true, mayAsk: false }, o.inst.cwd, "codex");
    const childBefore = approve(child, { request_id: ordinary, decision: "allow", user_confirmed: true });
    assert.equal(subBefore.refused, true);
    assert.equal(childBefore.refused, true);
    o.expose();
    for (const [index, request_id] of [personal, command].entries()) {
      assert.deepEqual(approve(o.inst, { request_id, decision: "allow", user_confirmed: true }), before[index]);
      assert.equal(approve(o.inst, { request_id, decision: "deny", user_confirmed: true }).decision, "denied");
    }
    assert.deepEqual(approve(o.inst, { request_id: ordinary, decision: "allow", user_confirmed: true }, subagent), subBefore);
    assert.deepEqual(approve(child, { request_id: ordinary, decision: "allow", user_confirmed: true }), childBefore);
  } finally { f.close(); }
});

for (const state of ["asking", "dismissed", "unasked"] as const) test(`rooms C1: exposure between approve's precheck and decision transaction is honoured (${state})`, () => {
  const f = fixture(), exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
  try {
    const o = f.owner(), id = o.request(state);
    let begins = 0, outsideChecks = 0, insideChecks = 0;
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (sql === "SELECT 1 FROM room_exposures WHERE owner_hash = ?") {
        if (this.isTransaction) insideChecks++; else outsideChecks++;
      }
      return prepare.call(this, sql);
    };
    DatabaseSync.prototype.exec = function (sql: string) {
      // The first writer is checkpointNever; the second owns the actual decision. Deliver room
      // text just before that lock, after ops.approve has already found this owner unexposed.
      if (sql === "BEGIN IMMEDIATE" && ++begins === 2) {
        assert.equal(outsideChecks, 1);
        assert.equal(this.isTransaction, false);
        o.expose();
      }
      return exec.call(this, sql);
    };
    const result = approve(o.inst, { request_id: id, decision: "allow", user_confirmed: true });
    assert.equal(begins, 2, "no nested or extra transactions");
    assert.equal(insideChecks, 1, "exposure rechecked while holding the decision writer lock");
    if (state === "unasked") {
      assert.equal(result.decision, "allowed");
      assert.equal(result.decided_by, "root session");
      assert.equal(getRequest(id)!.decided_by, "root session", "ignored flag is absent from the persisted audit");
    } else {
      assert.deepEqual(result, C1);
      assert.equal(getRequest(id)!.status, "pending");
      assert.equal(getRequest(id)!.decided_by, null);
    }
  } finally {
    DatabaseSync.prototype.exec = exec;
    DatabaseSync.prototype.prepare = prepare;
    f.close();
  }
});

test("rooms C1: decide uses trusted context, never a person's free-text audit label", () => {
  const f = fixture();
  try {
    const o = f.owner(); o.expose();
    const context = { ownerHash: roomOwnerHash(o.inst.token), userConfirmed: true };
    const id = o.request("asking");
    assert.deepEqual(decide(id, true, "user", undefined, "once", undefined, context), C1);
    assert.equal(decide(id, false, "user", undefined, "once", undefined, context).decided_by, "root session");
    // Existing person paths do not carry model-approve context; the model's audit wording alone
    // cannot cause C1 to attach to one of those paths.
    const person = o.request("asking");
    assert.equal(decide(person, true, "user").decision, "allowed");
  } finally { f.close(); }
});

test("rooms C1: the decision transaction rechecks a question opened after approve's precheck", () => {
  const f = fixture(), exec = DatabaseSync.prototype.exec;
  try {
    const o = f.owner(), id = o.request("error");
    o.expose();
    let begins = 0;
    DatabaseSync.prototype.exec = function (sql: string) {
      if (sql === "BEGIN IMMEDIATE" && ++begins === 2) {
        db().prepare("UPDATE elicitations SET outcome = NULL, reading = NULL, ended_at = NULL WHERE request_id = ?").run(id);
      }
      return exec.call(this, sql);
    };
    assert.deepEqual(approve(o.inst, { request_id: id, decision: "allow" }), C1);
    assert.equal(getRequest(id)!.status, "pending");
  } finally { DatabaseSync.prototype.exec = exec; f.close(); }
});

test("rooms C1: exposure survives registry reopen, separate owners cannot decide each other's runs", () => {
  const f = fixture();
  try {
    const exposed = f.owner(), other = f.owner(); exposed.expose();
    const first = exposed.request("dismissed"), second = other.request("dismissed");
    closeDbForTests();
    assert.equal(roomOwnerExposed(roomOwnerHash(exposed.inst.token)), true);
    assert.equal(roomOwnerExposed(roomOwnerHash(other.inst.token)), false);
    assert.deepEqual(approve(other.inst, { request_id: first, decision: "allow", user_confirmed: true }), UNAVAILABLE_REPLY);
    assert.deepEqual(approve(exposed.inst, { request_id: second, decision: "deny" }), UNAVAILABLE_REPLY);
    assert.deepEqual(approve(exposed.inst, { request_id: first, decision: "allow", user_confirmed: true }), C1);
    assert.equal(approve(other.inst, { request_id: second, decision: "allow", user_confirmed: true }).decision, "allowed");
  } finally { f.close(); }
});

test("rooms C1: shared-session views use their resolved owner; a fresh carried token cannot decide old work", () => {
  const f = fixture();
  try {
    const base = newInstance({ kind: "root" }, process.cwd(), "claude");
    const token = issueSessionToken(), owner = sessionOwner(token)!;
    const o = f.owner(sessionView(base, owner));
    const id = o.request("dismissed"); o.expose();
    assert.equal(roomOwnerExposed(roomOwnerHash(owner)), true);
    assert.equal(roomOwnerExposed(roomOwnerHash(token)), false, "public token is not the deciding owner's value");
    assert.equal(roomOwnerExposed(roomOwnerHash(base.token)), false, "shared process is not the owner");
    assert.deepEqual(approve(o.inst, { request_id: id, decision: "allow", user_confirmed: true }), C1);
    const restored = sessionView(base, sessionOwner(token)!);
    assert.deepEqual(approve(restored, { request_id: id, decision: "allow", user_confirmed: true }), C1);
    const fresh = sessionView(base, sessionOwner(issueSessionToken())!);
    assert.deepEqual(approve(fresh, { request_id: id, decision: "allow", user_confirmed: true }), UNAVAILABLE_REPLY);
    assert.deepEqual(approve(fresh, { request_id: id, decision: "deny" }), UNAVAILABLE_REPLY);
  } finally { f.close(); }
});

test("rooms C1: exposure adds no ban on ordinary root network and write-path grants", () => {
  const f = fixture();
  let granted: string | undefined;
  try {
    const o = f.owner();
    granted = nonTempScratch("relay-test-c1-grant-");
    const caller = { runId: o.run, node: null, depth: 0, cwd: o.inst.cwd, access: "write" as const };
    const options = { mode: "write" as const, grant: { network: true, write_paths: [granted] }, continues: false };
    const before = admitWork(caller, "claude", options, {});
    assert.ok("grant" in before, JSON.stringify(before));
    o.expose();
    assert.deepEqual(admitWork(caller, "claude", options, {}), before);
  } finally {
    if (granted) fs.rmSync(granted, { recursive: true, force: true });
    f.close();
  }
});

/** Use P0's helper against the harness's scratch registry, never a live room or account. */
function exposeHarnessOwner(home: string, token: string) {
  const saved = process.env.RELAY_HOME;
  closeDbForTests();
  process.env.RELAY_HOME = home;
  try { markRoomExposure(roomOwnerHash(token)); }
  finally {
    closeDbForTests();
    if (saved === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = saved;
  }
}

test("rooms C1: exposed owner's real confirm, dialog and terminal paths still allow; a restarted dedicated server owns none of its old runs", async () => {
  const h = await harness([{ match: task("C1-PERSON"), steps: [{ request: "c1-person-path" }, { reply: "{{last}}" }] }]);
  try {
    let answer: ((value: Rec) => void) | undefined;
    let dialog = false;
    const host = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"], elicit: () => dialog
      ? new Promise(resolve => { answer = resolve; }) : { action: "cancel" } });
    const pending = async () => {
      const job = await host.call("delegate", { target: "codex", task: "C1-PERSON", mode: "write" });
      await until(() => h.sql("SELECT id FROM requests WHERE node_id = ? AND status = 'pending'", job.job_id).length === 1, 15000, "C1 pending request");
      return { job, id: h.sql("SELECT id FROM requests WHERE node_id = ?", job.job_id)[0].id as string };
    };
    const modelAllow = async (id: string) => {
      // The MCP envelope can attach ordinary approval events; C1 itself carries no room view.
      const { events, ...result } = await host.call("approve", { request_id: id, decision: "allow", user_confirmed: true });
      return result;
    };
    const first = await pending();
    const ownerToken = h.sql("SELECT u.root_token FROM runs u JOIN nodes n ON n.run_id = u.id WHERE n.id = ?", first.job.job_id)[0].root_token;
    exposeHarnessOwner(h.home, ownerToken);
    await until(() => h.sql("SELECT reading FROM elicitations WHERE request_id = ?", first.id)[0]?.reading === "dismissed", 15000, "dismissed question");
    assert.deepEqual(await modelAllow(first.id), C1);
    const status = await host.call("status", { id: first.job.job_id });
    const req = status.needs_approval[0];
    const fields = Object.fromEntries(["request_id", "from", "kind", "effect", "in_directory", "wants"].map(key => [key, req[key]]));
    assert.equal((await host.call("confirm", fields)).decision, "allowed");
    assert.equal(h.sql("SELECT decided_by FROM requests WHERE id = ?", first.id)[0].decided_by, "user, through the host's permission prompt (confirm)");

    dialog = true;
    const second = await pending();
    await until(() => !!answer, 15000, "real host dialog");
    assert.deepEqual(await modelAllow(second.id), C1);
    answer!({ action: "accept", content: { decision: "allow" } });
    await until(() => h.sql("SELECT status FROM requests WHERE id = ?", second.id)[0].status === "allowed", 15000, "real dialog decision");
    assert.equal(h.sql("SELECT decided_by FROM requests WHERE id = ?", second.id)[0].decided_by, "user");

    dialog = false;
    const third = await pending();
    await until(() => h.sql("SELECT reading FROM elicitations WHERE request_id = ?", third.id)[0]?.reading === "dismissed", 15000, "terminal path's question dismissed");
    const terminal = terminalApprove(h, third.id);
    assert.equal(terminal.status, 0, terminal.output);
    assert.equal(terminal.json.decision, "allowed", terminal.output);
    assert.equal(h.sql("SELECT decided_by FROM requests WHERE id = ?", third.id)[0].decided_by, "terminal");

    const old = await pending();
    await host.close();
    const restarted = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"] });
    assert.deepEqual(await restarted.call("approve", { request_id: old.id, decision: "allow", user_confirmed: true }), UNAVAILABLE_REPLY);
    assert.deepEqual(await restarted.call("approve", { request_id: old.id, decision: "deny" }), UNAVAILABLE_REPLY);
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", old.id)[0].status, "pending");
  } finally { await h.close(); }
});
