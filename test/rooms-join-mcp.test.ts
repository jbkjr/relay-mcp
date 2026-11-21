// Revision 3, option B over real MCP dispatch: join asks the person in the host's own dialog
// where open would, and behaves as before everywhere else. Stub hosts and scratch registries only.
import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { closeDbForTests } from "../dist/core/db.js";
import { roomCreate } from "../dist/core/rooms.js";
import { ROOM_JOIN_NO, ROOM_JOIN_YES, ROOM_OPEN_YES, ROOM_REFUSALS, type RoomCreateResult } from "../dist/core/room-types.js";
import { conversationOn, DESKTOP_CHATS, harness, INTERACTIVE_CLAUDE, scratchOnly, type Harness, type Rec } from "./helpers.ts";

const CLI_TURN = { session_id: "session", thread_id: "thread", reasoning_effort: "high", turn_id: "turn", model: "gpt-6-astra", thread_source: "user", turn_trigger: "user", sandbox: "seatbelt", sandbox_mode: "workspace-write", auto_review_enabled: true, workspaces: {} };
const APP_TURN = { ...CLI_TURN, client_type: "desktop_app", turn_trigger: "composer" };
// ChatGPT 26.1117's Work mode (observed 2026-11-20): its own client_type, no originator, version 0.0.0.
const WORK_TURN = { ...CLI_TURN, client_type: "macos_app", turn_trigger: "composer", requested_model_experience: "work" };
const meta = (turn: Rec = CLI_TURN) => ({ meta: { "x-codex-turn-metadata": turn } });
const CODEX = { args: ["--host", "codex"], clientInfo: { name: "codex-mcp-client", version: "0.167.0" } };
const CLAUDE = { ...INTERACTIVE_CLAUDE, args: ["--host", "claude"] };
const refusal = (key: keyof typeof ROOM_REFUSALS) => ({ refused: true, reason: ROOM_REFUSALS[key] });

function person(answers: Rec[]) {
  const asked: { message: string; params: Rec }[] = [];
  return { asked, elicit: (message: string, _signal: AbortSignal, params: Rec) => { asked.push({ message, params }); return answers[Math.min(asked.length - 1, answers.length - 1)]; } };
}
function create(h: Harness): RoomCreateResult {
  const saved = process.env.RELAY_HOME;
  closeDbForTests(); process.env.RELAY_HOME = h.home;
  try {
    const r = roomCreate();
    assert.ok("invites" in r);
    return r;
  } finally { closeDbForTests(); if (saved === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = saved; }
}
const unspent = (h: Harness) => h.sql("SELECT COUNT(*) AS n FROM room_invites WHERE consumed_at IS NULL")[0].n;
const invitesIn = (text: string) => [...text.matchAll(/ri1_[0-9a-f]{32}/g)].map((m) => m[0]);

test("room join MCP: member-2 of a room a conversation opened is asked in its own dialog; no seats nothing, yes seats", async () => {
  const h = await harness();
  try {
    const opener = await h.instance({ ...CLAUDE, elicit: () => ({ action: "accept", content: { decision: ROOM_OPEN_YES } }) });
    assert.equal((await opener.call("room", { action: "open" })).opened, true);
    const [invite] = invitesIn(h.clipboard().held);
    const p = person([{ action: "accept", content: { decision: ROOM_JOIN_NO } }, { action: "cancel" }, { action: "accept", content: { decision: ROOM_JOIN_YES } }]);
    const codex = await h.instance({ ...CODEX, elicit: p.elicit });
    assert.deepEqual(await codex.call("room", { action: "join", invite }, meta()), refusal("join_declined"));
    assert.deepEqual(await codex.call("room", { action: "join", invite }, meta()), refusal("join_cancelled"));
    assert.equal(unspent(h), 1, "the invite is still unused");
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM room_members WHERE owner_hash IS NOT NULL")[0].n, 1, "only the opener is seated");
    const joined = await codex.call("room", { action: "join", invite }, meta());
    assert.equal(joined.state, "open", JSON.stringify(joined));
    assert.equal(p.asked.length, 3);
    const [{ message, params }] = p.asked;
    assert.match(message, /^relay: this conversation's model asks to join a room as member-2; the room was opened by another conversation\.\n/);
    assert.match(message, /\nmember-1 is held by a claude-code conversation \(host claude, family anthropic\), as relay recorded it\.\n/);
    assert.match(message, /\nRoom rm_[0-9a-f]{32}\. /);
    assert.match(message, /stay on screen/, "Codex keeps a withdrawn form");
    assert.equal(invitesIn(message).length, 0);
    assert.deepEqual((params.requestedSchema as Rec).properties.decision.enum, [ROOM_JOIN_NO, ROOM_JOIN_YES]);
    assert.match(fs.readFileSync(path.join(h.home, "elicitation.log"), "utf8"), /"request":"room-join".*"reading":"yes"/);
  } finally { await h.close(); }
});

test("room join MCP: interactive Claude Code asks for a terminal invite too; a closed question leaves it unspent", async () => {
  const h = await harness();
  try {
    const r = create(h);
    const p = person([{ action: "decline" }, { action: "accept", content: { decision: ROOM_JOIN_YES } }]);
    const claude = await h.instance({ ...CLAUDE, elicit: p.elicit });
    assert.deepEqual(await claude.call("room", { action: "join", invite: r.invites[0].invite }), refusal("join_declined"));
    assert.equal(unspent(h), 2);
    assert.equal((await claude.call("room", { action: "join", invite: r.invites[0].invite })).joined, true);
    assert.match(p.asked[0].message, /The other seat is not held yet\./);
    assert.doesNotMatch(p.asked[0].message, /stay on screen/);
    // An invalid invite is unavailable without a question.
    const other = await h.instance({ ...CLAUDE, elicit: p.elicit });
    assert.equal((await other.call("room", { action: "join", invite: `ri1_${"f".repeat(32)}` })).error, "Room unavailable.");
    assert.equal(p.asked.length, 2);
  } finally { await h.close(); }
});

test("room join MCP: hosts without a qualified dialog join at once, as before", async () => {
  const h = await harness();
  try {
    const p = person([{ action: "decline" }]);
    const cases: [string, () => Promise<{ call: (tool: string, args?: Rec, opts?: Rec) => Promise<Rec> }>, Rec][] = [
      ["Claude Code without elicitation", () => h.instance(CLAUDE), {}],
      ["Codex app", () => h.instance({ ...CODEX, desktopUi: true, elicit: p.elicit }), meta(APP_TURN)],
      ["desktop Code tab", () => h.instance({ ...CLAUDE, env: { CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_DESKTOP_APP_VERSION: "1.6608.0" }, elicit: p.elicit }), {}],
    ];
    for (const [name, connect, opts] of cases) {
      const r = create(h);
      const host = await connect();
      assert.equal((await host.call("room", { action: "join", invite: r.invites[0].invite }, opts)).joined, true, name);
    }
    const r = create(h);
    const shared = await h.instance({ ...DESKTOP_CHATS, elicit: p.elicit });
    assert.equal((await (await conversationOn(shared)).call("room", { action: "join", invite: r.invites[0].invite })).joined, true, "shared desktop chat");
    // An Elicitation hook means relay cannot ask: join behaves as on hosts without a dialog.
    fs.mkdirSync(path.join(scratchOnly(h.env.HOME, "HOME"), ".claude"), { recursive: true });
    fs.writeFileSync(path.join(h.env.HOME, ".claude", "settings.json"), JSON.stringify({ hooks: { Elicitation: [{ matcher: "relay", hooks: [{ type: "command", command: "echo" }] }] } }));
    const hooked = await h.instance({ ...CLAUDE, elicit: p.elicit });
    assert.equal((await hooked.call("room", { action: "join", invite: r.invites[1].invite })).joined, true, "Elicitation hook");
    assert.equal(p.asked.length, 0, "nobody was asked on these hosts");
  } finally { await h.close(); }
});

test("room join MCP: ChatGPT's Work mode joins at once, as the app's Codex side does, and is never asked", async () => {
  const h = await harness();
  try {
    const p = person([{ action: "accept", content: {} }]);
    const r = create(h);
    const work = await h.instance({ ...CODEX, clientInfo: { name: "codex-mcp-client", version: "0.0.0" }, elicit: p.elicit });
    assert.equal((await work.call("room", { action: "join", invite: r.invites[0].invite }, meta(WORK_TURN))).joined, true);
    assert.equal(p.asked.length, 0, "Work mode's dialog is not qualified, so relay never asks there");
  } finally { await h.close(); }
});
