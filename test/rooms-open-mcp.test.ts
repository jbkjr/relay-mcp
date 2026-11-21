// Revision 3 over real MCP dispatch: which hosts may ask the person to open a room through their own
// prompt, the yes path end to end, and every refusal, with stub hosts and scratch registries only.
import "./helpers.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ROOM_JOIN_YES, ROOM_NOTE, ROOM_OPEN_NO, ROOM_OPEN_YES, ROOM_PURPOSE_INPUT_UNITS, ROOM_REFUSALS, type RoomCreateResult } from "../dist/core/room-types.js";
import { closeDbForTests } from "../dist/core/db.js";
import { roomCreate } from "../dist/core/rooms.js";
import { conversationOn, DESKTOP_CHATS, harness, INTERACTIVE_CLAUDE, scratchOnly, type Harness, type Rec } from "./helpers.ts";

const CLI_TURN = { session_id: "session", thread_id: "thread", reasoning_effort: "high", turn_id: "turn", model: "gpt-6-astra", thread_source: "user", turn_trigger: "user", sandbox: "seatbelt", sandbox_mode: "workspace-write", auto_review_enabled: true, node_repl_auto_review_required: true, node_repl_disabled: false, workspaces: {} };
const APP_TURN = { ...CLI_TURN, client_type: "desktop_app", turn_trigger: "composer", codex_version: "0.162.0-alpha.17.2" };
const WORK_TURN = { ...CLI_TURN, client_type: "macos_app", turn_trigger: "composer", requested_model_experience: "work" };
const CHILD_TURN = { ...CLI_TURN, thread_source: "subagent", subagent_kind: "thread_spawn", parent_thread_id: "parent" };
const EXEC_TURN = { ...CLI_TURN, turn_trigger: "exec" };
const meta = (turn: Rec = CLI_TURN) => ({ "x-codex-turn-metadata": turn });
const CODEX = { args: ["--host", "codex"], clientInfo: { name: "codex-mcp-client", version: "0.167.0" } };
const CLAUDE = { ...INTERACTIVE_CLAUDE, args: ["--host", "claude"] };
const YES = { action: "accept", content: { decision: ROOM_OPEN_YES } };
const OPEN = { action: "open" };
const refusal = (key: keyof typeof ROOM_REFUSALS) => ({ refused: true, reason: ROOM_REFUSALS[key] });

/** A stub host's prompt: answers with `answer` and records each question it was shown. */
function person(answer: Rec | ((signal: AbortSignal) => Rec | Promise<Rec>) = YES) {
  const asked: { message: string; params: Rec }[] = [];
  return { asked, elicit: (message: string, signal: AbortSignal, params: Rec) => { asked.push({ message, params }); return typeof answer === "function" ? answer(signal) : answer; } };
}
const invitesIn = (text: string) => [...text.matchAll(/ri1_[0-9a-f]{32}/g)].map((m) => m[0]);
function noRooms(h: Harness) {
  for (const table of ["rooms", "room_members", "room_invites", "room_bindings"]) assert.equal(h.sql(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0, 0, table);
}
function noWork(h: Harness) {
  for (const table of ["runs", "nodes", "turns", "requests"]) assert.equal(h.sql(`SELECT COUNT(*) AS n FROM ${table}`)[0].n, 0, table);
  assert.equal(h.starts().length, 0);
}
function writeSettings(dir: string, settings: Rec) {
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify(settings));
}

for (const host of ["claude", "codex"] as const) test(`room open MCP: ${host === "claude" ? "interactive Claude Code" : "Codex CLI"} asks the person; on yes it holds member-1 and the pasted prompt opens the room`, async () => {
  const h = await harness();
  try {
    const p = person();
    const opener = await h.instance({ ...(host === "claude" ? CLAUDE : CODEX), elicit: p.elicit });
    const ometa = host === "codex" ? { meta: meta() } : {};
    const opened = await opener.call("room", OPEN, ometa);
    assert.equal(p.asked.length, 1, JSON.stringify(opened));
    const [{ message, params }] = p.asked;
    // Relay writes every word of the question: what a room is, its budget, and that the person picks the peer.
    assert.match(message, /Information only/); assert.match(message, /At most 24 messages/); assert.match(message, /another conversation you choose/);
    assert.equal(/stay on screen; answering it then opens nothing/.test(message), host === "codex", "Codex keeps a withdrawn form, so the question says a late answer opens nothing");
    assert.doesNotMatch(message, /expires after|minutes? to answer/, "relay sets no deadline of its own");
    assert.deepEqual((params.requestedSchema as Rec).properties.decision.enum, [ROOM_OPEN_NO, ROOM_OPEN_YES]);
    assert.equal(invitesIn(message).length, 0);
    assert.equal(opened.opened, true); assert.equal(opened.state, "waiting"); assert.equal(opened.note, ROOM_NOTE);
    // Member-2's prompt is on the (stand-in) clipboard, written by relay; the model got one line, no invite.
    assert.equal(invitesIn(JSON.stringify(opened)).length, 0, "the opener never receives the invite");
    assert.equal(opened.peer_prompt, undefined);
    assert.match(opened.clipboard, /is on the person's clipboard/);
    const clip = h.clipboard();
    assert.equal(clip.copies.length, 1, "relay wrote the clipboard once, through the stand-in");
    assert.match(clip.held, /^--- Prompt for member-2 ---\n/);
    const [invite] = invitesIn(clip.held);
    assert.ok(invite);
    assert.match(message, /\nOn yes, member-2's prompt goes on your clipboard \(replacing it\); the model never sees it\.\n/);
    // No purpose given: member-2's prompt says so instead of inventing context.
    assert.match(clip.held, /\nNo purpose was given for this room\.\nThe other conversation will say what the room is for; ask it for context before you take a position\.\n/);
    assert.doesNotMatch(clip.held, /recommendation we have been discussing/);
    // The registry and relay's logs never hold it.
    h.sql("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const file of fs.readdirSync(h.home)) {
      const full = path.join(h.home, file);
      if (fs.statSync(full).isFile()) assert.equal(fs.readFileSync(full).includes(invite), false, file);
    }
    const log = fs.readFileSync(path.join(h.home, "elicitation.log"), "utf8");
    assert.match(log, /"request":"room-open".*"reading":"yes"/);
    // The person pastes the prompt into a conversation on the other host.
    const peer = host === "claude" ? await h.instance(CODEX) : await h.instance(CLAUDE);
    const pmeta = host === "claude" ? { meta: meta() } : {};
    const joined = await peer.call("room", { action: "join", invite }, pmeta);
    assert.equal(joined.state, "open"); assert.equal(joined.next, opened.member_id);
    assert.equal((await opener.call("room", { action: "send", cursor: 0, text: "I recommend A.", stance: "agree", request_id: crypto.randomUUID() }, ometa)).accepted_seq, 1);
    const got = await peer.call("room", { action: "wait", cursor: 0, wait_s: 0 }, pmeta);
    assert.equal(got.messages[0].text, "I recommend A.");
    assert.equal((await peer.call("room", { action: "send", cursor: 1, text: "Agreed.", stance: "agree", request_id: crypto.randomUUID() }, pmeta)).state, "ended");
    // A second open once the room has ended asks again; while it was live it would not have.
    noWork(h);
  } finally { await h.close(); }
});

test("room open MCP: declined, closed, unattributable and unanswered prompts open nothing", async () => {
  const h = await harness([], {}, { RELAY_ROOM_OPEN_PROMPT_MS: "300" });
  try {
    for (const [answer, key] of [
      [{ action: "decline" }, "open_declined"], [{ action: "accept", content: { decision: ROOM_OPEN_NO } }, "open_declined"],
      [{ action: "cancel" }, "open_cancelled"], [{ action: "accept", content: { decision: ROOM_OPEN_YES, note: "extra" } }, "open_unverified"],
    ] as const) {
      const p = person(answer);
      const claude = await h.instance({ ...CLAUDE, elicit: p.elicit });
      assert.deepEqual(await claude.call("room", OPEN), refusal(key), JSON.stringify(answer));
      assert.equal(p.asked.length, 1);
      await claude.close();
    }
    // An answer outside the offered choices is refused by the schema check: not the person's.
    const odd = person({ action: "accept", content: { decision: "sure" } });
    const oddHost = await h.instance({ ...CLAUDE, elicit: odd.elicit });
    assert.deepEqual(await oddHost.call("room", OPEN), refusal("open_unverified"));
    // Nobody answers: the prompt ends at its timeout and a late yes changes nothing.
    let lateYes!: () => void;
    const silent = person((signal) => new Promise((resolve) => { lateYes = () => resolve(YES); signal.addEventListener("abort", () => resolve({ action: "cancel" })); }));
    const codex = await h.instance({ ...CODEX, elicit: silent.elicit });
    assert.deepEqual(await codex.call("room", OPEN, { meta: meta() }), refusal("open_timed_out"));
    lateYes();
    noRooms(h);
    noWork(h);
  } finally { await h.close(); }
});

test("room open MCP: hosts without a prompt relay knows reaches the person stay terminal-only", async () => {
  const h = await harness();
  try {
    const p = person();
    const cases: [string, () => Promise<{ call: (tool: string, args?: Rec, opts?: Rec) => Promise<Rec> }>, Rec, keyof typeof ROOM_REFUSALS][] = [
      ["Claude Code without elicitation", () => h.instance(CLAUDE), {}, "open_unavailable"],
      ["Codex CLI without elicitation", () => h.instance(CODEX), { meta: meta() }, "open_unavailable"],
      ["desktop Code tab (SDK declines dialogs)", () => h.instance({ ...CLAUDE, env: { CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_DESKTOP_APP_VERSION: "1.6608.0" }, elicit: p.elicit }), {}, "open_unavailable"],
      ["Claude Code below the dialog floor", () => h.instance({ ...CLAUDE, clientInfo: { name: "claude-code", version: "2.1.200" }, elicit: p.elicit }), {}, "open_unavailable"],
      ["Codex app (busy dialogs unqualified)", () => h.instance({ ...CODEX, desktopUi: true, elicit: p.elicit }), { meta: meta(APP_TURN) }, "open_unavailable"],
      ["Codex app by call metadata", () => h.instance({ ...CODEX, elicit: p.elicit }), { meta: meta(APP_TURN) }, "open_unavailable"],
      ["ChatGPT Work mode by call metadata", () => h.instance({ ...CODEX, clientInfo: { name: "codex-mcp-client", version: "0.0.0" }, elicit: p.elicit }), { meta: meta(WORK_TURN) }, "open_unavailable"],
      ["Codex CLI below the busy-dialog floor", () => h.instance({ ...CODEX, clientInfo: { name: "codex-mcp-client", version: "0.162.1" }, elicit: p.elicit }), { meta: meta() }, "open_unavailable"],
    ];
    for (const [name, connect, opts, key] of cases) {
      const host = await connect();
      assert.deepEqual(await host.call("room", OPEN, opts), refusal(key), name);
    }
    // The shared desktop entry's conversations: dialogs are forced off.
    const shared = await h.instance({ ...DESKTOP_CHATS, elicit: p.elicit });
    assert.deepEqual(await (await conversationOn(shared)).call("room", OPEN), refusal("open_unavailable"), "shared desktop chat");
    assert.equal(p.asked.length, 0, "no host was asked");
    noRooms(h);
  } finally { await h.close(); }
});

test("room open MCP: ask_user never and an Elicitation hook, even one added after start, withhold the prompt", async () => {
  const never = await harness([], { ask_user: "never" });
  try {
    const p = person();
    const claude = await never.instance({ ...CLAUDE, elicit: p.elicit });
    assert.deepEqual(await claude.call("room", OPEN), refusal("open_unavailable"));
    assert.deepEqual(await claude.call("room", { action: "open", purpose: "even with a purpose" }), refusal("open_unavailable"));
    const codex = await never.instance({ ...CODEX, elicit: p.elicit });
    assert.deepEqual(await codex.call("room", OPEN, { meta: meta() }), refusal("open_unavailable"), "Codex CLI too");
    // Join is not asked there either: it behaves as on hosts without a dialog (Q6, the maintainer 2026-11-16).
    const saved = process.env.RELAY_HOME;
    closeDbForTests(); process.env.RELAY_HOME = never.home;
    let created: RoomCreateResult;
    try { created = roomCreate() as RoomCreateResult; } finally { closeDbForTests(); if (saved === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = saved; }
    assert.equal((await claude.call("room", { action: "join", invite: created.invites[0].invite })).joined, true);
    assert.equal(p.asked.length, 0);
  } finally { await never.close(); }
  const h = await harness();
  try {
    const p = person();
    const hook = { hooks: { Elicitation: [{ matcher: "relay", hooks: [{ type: "command", command: "echo" }] }] } };
    writeSettings(scratchOnly(h.env.HOME, "HOME"), hook);
    const hooked = await h.instance({ ...CLAUDE, elicit: p.elicit });
    assert.deepEqual(await hooked.call("room", OPEN), refusal("open_unavailable"), "hook present at start");
    fs.rmSync(path.join(h.env.HOME, ".claude", "settings.json"));
    const later = await h.instance({ ...CLAUDE, elicit: p.elicit });
    writeSettings(h.repo, hook);
    assert.deepEqual(await later.call("room", OPEN), refusal("open_unavailable"), "hook added after the profile was built");
    assert.equal(p.asked.length, 0);
    noRooms(h);
  } finally { await h.close(); }
});

test("room open MCP: launched, subagent, unattended, bypass and multi-model callers are refused unasked; user_confirmed is no field", async () => {
  const h = await harness();
  try {
    const p = person();
    const codex = await h.instance({ ...CODEX, elicit: p.elicit });
    for (const [name, turn] of [["native subagent", CHILD_TURN], ["exec", EXEC_TURN], ["never", { ...CLI_TURN, approval_policy: "never" }], ["full access", { ...CLI_TURN, sandbox_mode: "danger-full-access" }], ["T3 originator", { ...CLI_TURN, originator: "t3-code" }]] as const) {
      assert.deepEqual(await codex.call("room", OPEN, { meta: meta(turn) }), refusal("ineligible"), name);
    }
    assert.deepEqual(await codex.call("room", OPEN), refusal("ineligible"), "no turn metadata");
    const t3 = await h.instance({ ...CODEX, env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "t3-code" }, elicit: p.elicit });
    assert.deepEqual(await t3.call("room", OPEN, { meta: meta() }), refusal("ineligible"), "T3 Code");
    const print = await h.instance({ ...CLAUDE, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, elicit: p.elicit });
    assert.deepEqual(await print.call("room", OPEN), refusal("ineligible"), "claude -p");
    const opencode = await h.instance({ args: ["--host", "claude"], clientInfo: { name: "opencode", version: "2.2.6" }, elicit: p.elicit });
    assert.deepEqual(await opencode.call("room", OPEN, { meta: { "ai.opencode/sessionID": "ses_1" } }), refusal("ineligible"), "multi-model client");
    const claude = await h.instance({ ...CLAUDE, elicit: p.elicit });
    const confirmed = await claude.call("room", { action: "open", user_confirmed: true });
    assert.match(String(confirmed.tool_error), /Invalid arguments|invalid.*argument/i, "user_confirmed cannot be passed, let alone substitute");
    assert.deepEqual(await claude.call("room", { action: "open", invite: `ri1_${"a".repeat(32)}` }), refusal("arguments"));
    // A launched agent's server has no room tool at all.
    const job = await codex.call("delegate", { target: "claude", task: "visibility", mode: "read", background: false }, { meta: meta() });
    const child = await h.instance({ ...(await h.childOf(job.job_id, { may_delegate: true, may_ask: true })), elicit: p.elicit });
    assert.equal((await child.tools()).includes("room"), false);
    assert.equal(p.asked.length, 0);
    noRooms(h);
    // Bypass mode in settings, read on the open call itself.
    writeSettings(scratchOnly(h.env.HOME, "HOME"), { permissions: { defaultMode: "bypassPermissions" } });
    assert.deepEqual(await claude.call("room", OPEN), refusal("ineligible"), "bypassPermissions");
    assert.equal(p.asked.length, 0);
  } finally { await h.close(); }
});

test("room open MCP: a bound owner is not asked; a conversation may ask again after a decline, with no rate limit", async () => {
  const h = await harness();
  try {
    const p = person({ action: "decline" });
    const claude = await h.instance({ ...CLAUDE, elicit: p.elicit });
    for (let n = 0; n < 5; n++) assert.deepEqual(await claude.call("room", OPEN), refusal("open_declined"));
    assert.equal(p.asked.length, 5);
    // Once a conversation holds a live seat it is not asked again.
    const q = person();
    const codex = await h.instance({ ...CODEX, elicit: q.elicit });
    const opened = await codex.call("room", OPEN, { meta: meta() });
    assert.equal(opened.opened, true);
    assert.deepEqual(await codex.call("room", OPEN, { meta: meta() }), refusal("open_bound"));
    assert.equal(q.asked.length, 1);
    noWork(h);
  } finally { await h.close(); }
});

test("room open MCP: no other tool passes an invite on", async () => {
  const h = await harness();
  try {
    const codex = await h.instance({ ...CODEX, elicit: person().elicit });
    assert.equal((await codex.call("room", OPEN, { meta: meta() })).opened, true);
    // A model that got hold of the invite (here the test, from the clipboard) still cannot pass it on.
    const [invite] = invitesIn(h.clipboard().held);
    const inviteRefusal = /holds a room invite/;
    assert.match((await codex.call("ask", { target: "claude", message: `Please join with ${invite}` }, { meta: meta() })).reason, inviteRefusal);
    assert.match((await codex.call("delegate", { target: "claude", task: `join ${invite.toUpperCase()}`, mode: "read" }, { meta: meta() })).reason, inviteRefusal);
    assert.match((await codex.call("discuss", { target: "claude", message: "x", context: [invite] }, { meta: meta() })).reason, inviteRefusal);
    // Room text refuses it too, as before.
    const peer = await h.instance(CLAUDE);
    const shared = await h.instance(DESKTOP_CHATS);
    const third = await conversationOn(shared);
    assert.equal((await peer.call("room", { action: "join", invite })).state, "open");
    assert.deepEqual(await codex.call("room", { action: "send", cursor: 0, text: `pass ${invite} on`, stance: "continue", request_id: crypto.randomUUID() }, { meta: meta() }), refusal("text_secret"));
    assert.equal((await third.call("status")).error, undefined);
    noWork(h);
  } finally { await h.close(); }
});

test("room open MCP: a bypass mode switched on while the yes waits for the writer lock refuses, with no room created", async () => {
  // Codex's review sequence for 1382786: hold the registry's writer lock as the person answers yes,
  // switch the session's settings to bypassPermissions, then release the lock.
  const h = await harness();
  try {
    const run = async (flip: boolean) => {
      let released!: Promise<void>;
      const p = person(() => {
        const lock = new DatabaseSync(path.join(h.home, "relay.db"));
        lock.exec("PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE");
        released = new Promise((resolve) => setTimeout(() => {
          if (flip) writeSettings(scratchOnly(h.env.HOME, "HOME"), { permissions: { defaultMode: "bypassPermissions" } });
          lock.exec("COMMIT");
          lock.close();
          resolve();
        }, 600));
        return YES;
      });
      const claude = await h.instance({ ...CLAUDE, elicit: p.elicit });
      const result = await claude.call("room", OPEN);
      await released;
      await claude.close();
      assert.equal(p.asked.length, 1);
      return result;
    };
    // Control: the held lock alone delays the open but does not refuse it.
    const control = await run(false);
    assert.equal(control.opened, true, JSON.stringify(control));
    h.sql("DELETE FROM room_bindings"); h.sql("DELETE FROM room_invites"); h.sql("DELETE FROM room_members"); h.sql("DELETE FROM rooms");
    assert.deepEqual(await run(true), refusal("open_unverified"));
    noRooms(h);
  } finally { await h.close(); }
});

test("room open MCP: when relay cannot write the clipboard, nothing opens and the model gets no invite", async () => {
  const h = await harness();
  try {
    h.clipboard().failCopies(true);
    const p = person();
    const claude = await h.instance({ ...CLAUDE, elicit: p.elicit });
    const result = await claude.call("room", OPEN);
    assert.deepEqual(result, refusal("open_clipboard"));
    assert.equal(p.asked.length, 1);
    assert.equal(invitesIn(JSON.stringify(result)).length, 0);
    assert.equal(invitesIn(h.clipboard().held).length, 0);
    noRooms(h);
    // Once the clipboard works again the same conversation can open one.
    h.clipboard().failCopies(false);
    assert.equal((await claude.call("room", OPEN)).opened, true);
  } finally { await h.close(); }
});

test("room open MCP: a purpose line reaches the open and join questions labelled as the model's; origin shows in views and listings", async () => {
  const h = await harness();
  try {
    const p = person();
    const opener = await h.instance({ ...CLAUDE, elicit: p.elicit });
    const opened = await opener.call("room", { action: "open", purpose: "Agree on the API shape with the Codex session" });
    assert.equal(opened.opened, true, JSON.stringify(opened)); assert.equal(opened.origin, "open");
    assert.match(p.asked[0].message, /\nPurpose \(written by the model, unverified\): Agree on the API shape with the Codex session\n/);
    assert.equal(h.sql("SELECT origin, purpose FROM rooms")[0].origin, "open");
    const [invite] = invitesIn(h.clipboard().held);
    const q = person({ action: "accept", content: { decision: ROOM_JOIN_YES } });
    const codex = await h.instance({ ...CODEX, elicit: q.elicit });
    assert.equal((await codex.call("room", { action: "join", invite }, { meta: meta() })).origin, "open");
    assert.match(q.asked[0].message, /the room was opened by another conversation/);
    assert.match(invitesIn(h.clipboard().held).length ? h.clipboard().held : "", /\nPurpose \(written by the model, unverified\): Agree on the API shape with the Codex session\n/);
    assert.match(q.asked[0].message, /\nPurpose \(written by the model, unverified\): Agree on the API shape with the Codex session\n/);
    // A bad purpose refuses without a question; an oversized one is a schema error.
    const before = p.asked.length;
    const claude2 = await h.instance({ ...CLAUDE, elicit: p.elicit });
    assert.deepEqual(await claude2.call("room", { action: "open", purpose: "two\nlines" }), refusal("purpose"));
    assert.match(String((await claude2.call("room", { action: "open", purpose: "x".repeat(ROOM_PURPOSE_INPUT_UNITS + 1) })).tool_error), /Invalid arguments|invalid.*argument/i);
    assert.equal(p.asked.length, before);
  } finally { await h.close(); }
});
