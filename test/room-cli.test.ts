import "./helpers.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { CLI, harness, until } from "./helpers.ts";
import { newInstance } from "../dist/core/caller.js";
import { closeDbForTests, db } from "../dist/core/db.js";
import { ROOM_TERMINAL_MARKERS } from "../dist/core/room-terminal.js";
import { roomText } from "../dist/core/shown.js";
import * as rooms from "../dist/core/rooms.js";
import * as R from "../dist/core/room-types.js";

const missing = `rm_${"0".repeat(32)}`;
const call: R.RoomCallEvidence = {
  identity: { call_id: "test", scope: "dedicated-process", harness: "test root", family: "openai", subagent: false, singleton_violation: false,
    codex: { metadata_present: true, malformed: false, thread_id: "test", thread_source: "user", turn_trigger: "user", originator: null, sandbox: null, auto_review: null, approval_policy: null } },
  eligibility: { eligible: true }, block_s: 50, host_wait_cap_s: null, sanitizeText: roomText,
};
function ok<T>(r: T): Exclude<T, R.RoomFailure> {
  assert.ok(r && typeof r === "object" && !("error" in r) && !("refused" in r), JSON.stringify(r));
  return r as Exclude<T, R.RoomFailure>;
}
async function box() {
  const h = await harness();
  const old = process.env.RELAY_HOME;
  closeDbForTests(); process.env.RELAY_HOME = h.home;
  const env: Record<string, string> = { ...h.env };
  for (const key of ROOM_TERMINAL_MARKERS) delete env[key];
  // Stand-ins for pbcopy and pbpaste (executables.ts systemTool, honoured only under the test
  // runner, from a directory under the system temp): no test touches the real clipboard. pbcopy
  // appends each copy to a log (one JSON string per line); with CLIP_FAIL set it exits 1.
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-clip-"))), clip = path.join(h.home, "clipboard"), log = path.join(h.home, "clipboard.log");
  fs.writeFileSync(path.join(bin, "pbcopy"), `#!/bin/sh\n[ -n "$CLIP_FAIL" ] && exit 1\ncat > "$CLIP_FILE"\n/usr/bin/python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()))' "$CLIP_FILE" >> "$CLIP_LOG"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "pbpaste"), `#!/bin/sh\ncat "$CLIP_FILE"\n`, { mode: 0o755 });
  fs.writeFileSync(clip, "");
  Object.assign(env, { RELAY_TEST_SYSTEM_TOOLS: bin, CLIP_FILE: clip, CLIP_LOG: log });
  return { h, env, clip, copies: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string) : [], async close() { closeDbForTests(); if (old === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = old; fs.rmSync(bin, { recursive: true, force: true }); await h.close(); } };
}
// As terminalAdoption/terminalApprove do, wait for the real prompt before sending input.
// Separate output pipes exercise stdout refusal independently of stdin; no mocked TTY flags.
const driver = `import os, pty, select, signal, sys, time, termios
r, w = os.pipe()
pid, fd = pty.fork()
if pid == 0:
    os.close(r)
    if os.environ.get("ROOM_STDIN_PIPE"):
        os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
    if os.environ.get("ROOM_STDOUT_PIPE"):
        os.dup2(w, 1)
    os.close(w)
    os.execv(sys.argv[1], sys.argv[1:])
os.close(w)
attrs = termios.tcgetattr(fd)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(fd, termios.TCSANOW, attrs)
output = b""
sent = False
import json
steps = json.loads(os.environ.get("ROOM_STEPS", "[]"))
spos = 0
fds = [fd, r]
deadline = time.monotonic() + 12
try:
    while fds and time.monotonic() < deadline:
        for ready in select.select(fds, [], [], 0.1)[0]:
            try:
                chunk = os.read(ready, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                fds.remove(ready)
                continue
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            output += chunk
            trigger = os.environ.get("ROOM_TRIGGER", "Type exactly ").encode()
            if not sent and trigger in output and "ROOM_ANSWER" in os.environ:
                os.write(fd, (os.environ["ROOM_ANSWER"] + "\\n").encode())
                sent = True
            while steps and steps[0][0].encode() in output[spos:]:
                trig, ans = steps.pop(0)
                spos = output.index(trig.encode(), spos) + len(trig.encode())
                os.write(fd, b"\\x04" if ans == "<EOF>" else b"\\x03" if ans == "<INTR>" else (ans + "\\n").encode())
            if os.environ.get("ROOM_EOF") and b'"injected": true' in output:
                os.write(fd, b"\\x04")
                os.environ.pop("ROOM_EOF")
    if fds:
        os.kill(pid, signal.SIGKILL)
finally:
    os.close(fd)
    os.close(r)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
/** The clipboard offer's first question ends with this; tests that do not exercise the clipboard skip it. */
const SKIP_CLIPBOARD = JSON.stringify([["or type n to skip.", "n"]]);
function terminal(b: Awaited<ReturnType<typeof box>>, args: string[], extra: Record<string, string> = {}) {
  const offers = args[0] === "new" || args.includes("--reseat");
  const r = spawnSync("python3", ["-c", driver, process.execPath, CLI, "room", ...args], {
    cwd: b.h.repo, env: { ...b.env, ...(offers ? { ROOM_STEPS: SKIP_CLIPBOARD } : {}), ...extra }, encoding: "utf8", timeout: 15000,
  });
  assert.ifError(r.error);
  return { ...r, stdout: r.stdout.replace(/\r\n/g, "\n") };
}
function cli(b: Awaited<ReturnType<typeof box>>, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, "room", ...args], { cwd: b.h.repo, env: b.env, encoding: "utf8" });
}
function summary(output: string) { return JSON.parse(output.slice(output.lastIndexOf("\n{"))); }
async function pair(r: R.RoomCreateResult) {
  const a = newInstance({ kind: "root" }, process.cwd(), "codex"), b = newInstance({ kind: "root" }, process.cwd(), "claude");
  ok(await rooms.roomJoin(a, { action: "join", invite: r.invites[0].invite }, call));
  ok(await rooms.roomJoin(b, { action: "join", invite: r.invites[1].invite }, call));
  return { a, b };
}

test("room CLI: create, list and print; invites appear once, only in prompts; reads need no terminal", async () => {
  const b = await box();
  try {
    const result = terminal(b, ["new"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const invites = [...result.stdout.matchAll(/ri1_[0-9a-f]{32}/g)].map((m) => m[0]);
    assert.equal(invites.length, 2); assert.notEqual(invites[0], invites[1]);
    assert.equal((result.stdout.match(/--- Prompt for /g) ?? []).length, 2);
    const created = summary(result.stdout);
    assert.deepEqual(Object.keys(created), ["room_id", "state", "expires_at"]);
    assert.equal(created.state, "waiting");
    assert.doesNotMatch(JSON.stringify(created), /ri1_|invite/);
    const list = cli(b, "list"); assert.equal(list.status, 0);
    const listed = JSON.parse(list.stdout); assert.equal(listed.length, 1);
    assert.deepEqual(Object.keys(listed[0]), ["room_id", "origin", "state", "created_at", "expires_at", "seats"]);
    assert.equal(listed[0].origin, "terminal");
    assert.deepEqual(listed[0].seats.map((s: any) => s.label), ["member-1", "member-2"]);
    const printed = cli(b, created.room_id, "--print"); assert.equal(printed.status, 0);
    assert.match(printed.stdout, /relay: \(no messages\)/);
    assert.match(printed.stdout, /^relay: room rm_[0-9a-f]{32}; state waiting; revision \d+; origin terminal \(relay room new\)$/m);
    assert.doesNotMatch(list.stdout + printed.stdout, /ri1_|code_hash|owner_hash|room.key/);
    for (const row of b.h.sql("SELECT code_hash FROM room_invites")) assert.ok(!(list.stdout + printed.stdout).includes(row.code_hash));
    const before = b.h.sql("SELECT * FROM rooms");
    cli(b, "list"); cli(b, created.room_id, "--print");
    for (const args of [["list"], [created.room_id, "--print"]]) {
      const r = spawnSync(process.execPath, [CLI, "room", ...args], {
        cwd: b.h.repo, env: { ...b.env, CODEX_THREAD_ID: "", RELAY_NODE_ID: "" }, encoding: "utf8",
      });
      assert.equal(r.status, 0, "read-only commands remain available in host and launched-agent environments");
    }
    assert.deepEqual(b.h.sql("SELECT * FROM rooms"), before, "administrative reads change nothing");
    for (const args of [[missing], [missing, "--print"], [missing, "--say", "hi"], [missing, "--close"], [missing, "--reseat", "member-1"]]) {
      const r = args[1] === "--print" ? cli(b, ...args) : terminal(b, args);
      assert.equal(r.status, 1); assert.match(r.stdout, /Room unavailable/);
    }
  } finally { await b.close(); }
});

/** No file relay writes in its home holds any of these invites (the stub clipboard's own files aside). */
function noInviteInHome(b: Awaited<ReturnType<typeof box>>, invites: string[]) {
  b.h.sql("PRAGMA wal_checkpoint(TRUNCATE)");
  for (const file of fs.readdirSync(b.h.home)) {
    const full = path.join(b.h.home, file);
    if (file.startsWith("clipboard") || !fs.statSync(full).isFile()) continue;
    const bytes = fs.readFileSync(full);
    for (const invite of invites) assert.equal(bytes.includes(invite), false, `${file} holds an invite`);
  }
}

test("room CLI: new offers each prompt on the clipboard in turn, waits for Enter between them, and clears it at the end", async () => {
  const b = await box();
  try {
    fs.writeFileSync(b.clip, "something of mine");
    const steps = [["or type n to skip.", ""], ["then press Enter to copy member-2's prompt", ""], ["then press Enter to clear the clipboard.", ""]];
    const result = terminal(b, ["new"], { ROOM_STEPS: JSON.stringify(steps) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // The prompts are printed as before, the summary still last; the clipboard is extra.
    assert.equal((result.stdout.match(/--- Prompt for /g) ?? []).length, 2);
    const invites = [...new Set(result.stdout.match(/ri1_[0-9a-f]{32}/g))];
    assert.equal(invites.length, 2);
    assert.equal(summary(result.stdout).state, "waiting");
    const copies = b.copies();
    assert.equal(copies.length, 3, "member-1's prompt, member-2's, then the clearing copy");
    assert.match(copies[0], /^--- Prompt for member-1 ---\n/); assert.ok(copies[0].includes(invites[0])); assert.ok(!copies[0].includes(invites[1]));
    assert.match(copies[1], /^--- Prompt for member-2 ---\n/); assert.ok(copies[1].includes(invites[1])); assert.ok(!copies[1].includes(invites[0]));
    assert.equal(copies[2], "");
    assert.equal(fs.readFileSync(b.clip, "utf8"), "", "no invite is left on the clipboard");
    assert.match(result.stdout, /Clipboard cleared\./);
    assert.ok(result.stdout.indexOf("Paste it into the first conversation") > result.stdout.lastIndexOf("--- End prompt for member-2 ---"), "the prompts print before the offer");
    noInviteInHome(b, invites);
  } finally { await b.close(); }
});

test("room CLI: the clipboard offer can be skipped, stopped, interrupted or fail, and never leaves an invite behind", async () => {
  const b = await box();
  try {
    fs.writeFileSync(b.clip, "something of mine");
    const skipped = terminal(b, ["new"], { ROOM_STEPS: JSON.stringify([["or type n to skip.", "n"]]) });
    assert.equal(skipped.status, 0, skipped.stdout); assert.equal(b.copies().length, 0);
    assert.equal(fs.readFileSync(b.clip, "utf8"), "something of mine", "skipping leaves the clipboard alone");
    assert.equal(summary(skipped.stdout).state, "waiting");

    const stopped = terminal(b, ["new"], { ROOM_STEPS: JSON.stringify([["or type n to skip.", ""], ["(n to stop).", "n"]]) });
    assert.equal(stopped.status, 0, stopped.stdout);
    assert.deepEqual(b.copies().slice(-1), [""]); assert.equal(fs.readFileSync(b.clip, "utf8"), "");

    const ended = terminal(b, ["new"], { ROOM_STEPS: JSON.stringify([["or type n to skip.", ""], ["(n to stop).", "<EOF>"]]) });
    assert.equal(ended.status, 0, ended.stdout); assert.equal(fs.readFileSync(b.clip, "utf8"), "", "end of input clears it");
    assert.equal(summary(ended.stdout).state, "waiting");

    const interrupted = terminal(b, ["new"], { ROOM_STEPS: JSON.stringify([["or type n to skip.", ""], ["(n to stop).", "<INTR>"]]) });
    assert.equal(interrupted.status, 130, interrupted.stdout);
    const [invite] = interrupted.stdout.match(/ri1_[0-9a-f]{32}/g)!;
    assert.ok(b.copies().some((c) => c.includes(invite)), "it was on the clipboard");
    assert.equal(fs.readFileSync(b.clip, "utf8"), "", "Ctrl-C clears it before exiting");

    // Five creations in a minute would meet the home's creation limit; age the earlier ones.
    b.h.sql("UPDATE rooms SET created_at = created_at - 60000");
    const failed = terminal(b, ["new"], { CLIP_FAIL: "1", ROOM_STEPS: JSON.stringify([["or type n to skip.", ""]]) });
    assert.equal(failed.status, 0, failed.stdout);
    assert.match(failed.stdout, /could not use the clipboard; paste the prompts printed above instead/);
    assert.equal((failed.stdout.match(/--- Prompt for /g) ?? []).length, 2);
    assert.equal(summary(failed.stdout).state, "waiting");
  } finally { await b.close(); }
});

test("room CLI: re-seat offers its one replacement prompt on the clipboard and clears it", async () => {
  const b = await box();
  try {
    const r = ok(rooms.roomCreate());
    const result = terminal(b, [r.room_id, "--reseat", "member-2"], {
      ROOM_ANSWER: `reseat member-2 in room ${r.room_id}`,
      ROOM_STEPS: JSON.stringify([["or type n to skip.", ""], ["then press Enter to clear the clipboard.", ""]]),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const [invite] = result.stdout.match(/ri1_[0-9a-f]{32}/g)!;
    const copies = b.copies();
    assert.equal(copies.length, 2); assert.match(copies[0], /^--- Prompt for member-2 ---\n/); assert.ok(copies[0].includes(invite));
    assert.match(result.stdout, /Paste it into the intended conversation/);
    assert.equal(fs.readFileSync(b.clip, "utf8"), "");
    assert.deepEqual(summary(result.stdout), { room_id: r.room_id, member_id: r.invites[1].member_id, state: "waiting" });
    noInviteInHome(b, [invite]);
  } finally { await b.close(); }
});

test("room CLI: every write guards before lookup for either missing TTY, every host/launch marker (including empty)", async () => {
  const b = await box();
  try {
    // A broken registry proves neither a room lookup nor launch evidence is read before refusal.
    fs.writeFileSync(path.join(b.h.home, "relay.db"), "not a registry");
    const writes = [["new"], [missing], [missing, "--say", "hello"], [missing, "--close"], [missing, "--reseat", "member-1"]];
    for (const args of writes) {
      const piped = cli(b, ...args); assert.equal(piped.status, 1); assert.match(piped.stdout, /Standard input/);
      for (const flag of ["ROOM_STDIN_PIPE", "ROOM_STDOUT_PIPE"]) {
        const r = terminal(b, args, { [flag]: "1" });
        assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /not an interactive terminal/);
        assert.doesNotMatch(r.stdout + r.stderr, /not a database|Room unavailable/);
      }
      for (const marker of ROOM_TERMINAL_MARKERS) for (const value of ["", "private-value-73"]) {
        const r = terminal(b, args, { [marker]: value });
        assert.equal(r.status, 1, `${args} ${marker}: ${r.stdout} ${r.stderr}`);
        assert.match(r.stdout, /environment was detected/);
        assert.doesNotMatch(r.stdout + r.stderr, /private-value-73|not a database|Room unavailable/);
      }
    }
  } finally { await b.close(); }
});

test("room CLI: invalid grammar exits 2 without a lookup", async () => {
  const b = await box();
  try {
    for (const args of [[], ["new", "--close"], ["list", "--print"], [missing, "--say"], [missing, "--say", "--close"], [missing, "--reseat", "m_bad"], [missing, "--close", "--print"], [missing, "--wat"], [missing, "--say", "hi", "--print"]]) {
      const r = cli(b, ...args); assert.equal(r.status, 2, JSON.stringify(args)); assert.match(r.stderr, /usage: relay room/);
    }
  } finally { await b.close(); }
});

test("room CLI: exact re-seat, revoked owner, preserved history/budget, replacement prompt, exact close", async () => {
  const b = await box();
  try {
    const r = ok(rooms.roomCreate()), { a, b: peer } = await pair(r);
    ok(await rooms.roomSend(a, { action: "send", cursor: 0, text: "recommendation", stance: "continue", request_id: crypto.randomUUID() }, call));
    const before = ok(rooms.roomPrint(r.room_id));
    const exact = `reseat member-1 in room ${r.room_id}`;
    for (const answer of ["yes", exact + " ", exact.toUpperCase()]) {
      const failed = terminal(b, [r.room_id, "--reseat", "member-1"], { ROOM_ANSWER: answer });
      assert.equal(failed.status, 1); assert.match(failed.stdout, /nothing changed/);
      assert.deepEqual(ok(rooms.roomPrint(r.room_id)), before);
    }
    const reseated = terminal(b, [r.room_id, "--reseat", "member-1"], { ROOM_ANSWER: exact });
    assert.equal(reseated.status, 0, reseated.stdout + reseated.stderr);
    assert.match(reseated.stdout, /owner_fingerprint.*liveness/);
    assert.equal((reseated.stdout.match(/--- Prompt for /g) ?? []).length, 1);
    const invites = reseated.stdout.match(/ri1_[0-9a-f]{32}/g)!; assert.equal(invites.length, 1);
    assert.deepEqual(summary(reseated.stdout), { room_id: r.room_id, member_id: r.invites[0].member_id, state: "waiting" });
    const after = ok(rooms.roomPrint(r.room_id));
    assert.deepEqual(after.messages, before.messages); assert.equal(after.turns, before.turns);
    assert.equal(after.seats[0].generation, before.seats[0].generation + 1);
    assert.equal((await rooms.roomTranscript(a, { action: "transcript", cursor: 0 }, call) as R.RoomUnavailable).error, R.ROOM_UNAVAILABLE_ERROR);
    const replacement = newInstance({ kind: "root" }, process.cwd(), "codex");
    assert.equal(ok(await rooms.roomJoin(replacement, { action: "join", invite: invites[0] }, call)).state, "open");
    assert.equal(ok(await rooms.roomTranscript(peer, { action: "transcript", cursor: 0 }, call)).messages[0].text, "recommendation");
    const ready = ok(rooms.roomPrint(r.room_id));
    const failed = terminal(b, [r.room_id, "--close"], { ROOM_ANSWER: `close room ${r.room_id} ` });
    assert.equal(failed.status, 1); assert.deepEqual(ok(rooms.roomPrint(r.room_id)), ready);
    const closed = terminal(b, [r.room_id, "--close"], { ROOM_ANSWER: `close room ${r.room_id}` });
    assert.equal(closed.status, 0); assert.equal(summary(closed.stdout).ending.closed_by, "terminal");
    assert.equal(summary(closed.stdout).state, "ended");
    const again = terminal(b, [r.room_id, "--close"], { ROOM_ANSWER: `close room ${r.room_id}` });
    assert.deepEqual(summary(again.stdout), summary(closed.stdout));
    assert.match(cli(b, r.room_id, "--print").stdout, /recommendation/);
  } finally { await b.close(); }
});

test("room CLI: say and interactive add are terminal text delivered to both members, with no turns; limits and secret hygiene", async () => {
  const b = await box();
  try {
    const r = ok(rooms.roomCreate()), { a, b: peer } = await pair(r);
    const say = terminal(b, [r.room_id, "--say", "a line\u001b[31m"]);
    assert.equal(say.status, 0); assert.deepEqual(JSON.parse(say.stdout), { injected: true, room_id: r.room_id, seq: 1 });
    for (const i of [a, peer]) {
      const got = ok(await rooms.roomTranscript(i, { action: "transcript", cursor: 0 }, call));
      assert.equal(got.turns, 0); assert.equal(got.messages[0].sender.label, "terminal"); assert.equal(got.messages[0].sender.member_id, null);
      assert.equal(got.messages[0].text, roomText("a line\u001b[31m"));
    }
    const follow = terminal(b, [r.room_id], { ROOM_TRIGGER: "Type a line", ROOM_ANSWER: "interactive line", ROOM_EOF: "1" });
    assert.equal(follow.status, 0, follow.stdout + follow.stderr); assert.match(follow.stdout, /from a terminal/);
    assert.equal(ok(rooms.roomPrint(r.room_id)).messages[1].text, "interactive line");
    assert.equal(ok(rooms.roomPrint(r.room_id)).turns, 0);
    for (const [text, why] of [["", /room text is empty/], ["x".repeat(R.ROOM_TEXT_CODE_POINTS + 1), /longer than 4000 characters/], ["😀".repeat(2001), /longer than 4000 characters/],
      [r.invites[0].invite.toUpperCase(), /contains an invite or a session token/], [`rs1_${"a".repeat(56)}`, /contains an invite or a session token/]] as const) {
      const no = terminal(b, [r.room_id, "--say", text]); assert.equal(no.status, 1); assert.match(no.stdout, why);
    }
    for (let n = 2; n < R.ROOM_TERMINAL_ROWS; n++) ok(rooms.roomAddLine(r.room_id, `line ${n}`, roomText));
    const cap = terminal(b, [r.room_id, "--say", "one too many"]); assert.equal(cap.status, 1); assert.match(cap.stdout, /ROOM_TERMINAL_ROWS/);
    const output = cli(b, "list").stdout + cli(b, r.room_id, "--print").stdout;
    for (const table of ["room_members", "room_invites"]) for (const row of b.h.sql(`SELECT * FROM ${table}`)) for (const field of ["owner_hash", "code_hash", "consumed_owner_hash"]) {
      if (row[field]) assert.ok(!output.includes(row[field]), `${field} must not be printed`);
    }
    for (const invite of r.invites) assert.ok(!output.includes(invite.invite));
  } finally { await b.close(); }
});

test("room CLI: follow tails new member/terminal rows once and exits on room close", async () => {
  const b = await box();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const r = ok(rooms.roomCreate()), { a } = await pair(r);
    child = spawn("python3", ["-c", driver, process.execPath, CLI, "room", r.room_id], { cwd: b.h.repo, env: b.env });
    const exited = once(child, "exit");
    let output = "", errors = "";
    child.stdout!.on("data", (d) => { output += d.toString(); });
    child.stderr!.on("data", (d) => { errors += d.toString(); });
    await until(() => output.includes("Type a line"), 10000, "room follow to start");
    ok(await rooms.roomSend(a, { action: "send", cursor: 0, text: "member tail canary", stance: "continue", request_id: crypto.randomUUID() }, call));
    await until(() => output.includes("member tail canary"), 10000, "new member row in follow");
    ok(rooms.roomAddLine(r.room_id, "external terminal canary", roomText));
    await until(() => output.includes("external terminal canary"), 10000, "new terminal row in follow");
    ok(rooms.roomCloseAtTerminal(r.room_id));
    const [status] = await exited;
    assert.equal(status, 0, output + errors);
    assert.equal(output.split("member tail canary").length - 1, 1);
    assert.equal(output.split("external terminal canary").length - 1, 1);
    assert.match(output, /state ended/); assert.match(output, /from a terminal/);
  } finally { child?.kill("SIGKILL"); await b.close(); }
});

test("room CLI: a typed line that throws while following prints a one-line relay error, not a stack trace, and the exit is 1", async () => {
  const b = await box();
  try {
    const r = ok(rooms.roomCreate()); await pair(r);
    // A registry failure on the insert itself (as a write lock held past the busy timeout would give).
    db().exec("CREATE TRIGGER fail_terminal_line BEFORE INSERT ON room_messages BEGIN SELECT RAISE(ABORT, 'room line write failed in test'); END");
    const follow = terminal(b, [r.room_id], { ROOM_STEPS: JSON.stringify([["Type a line", "doomed line"], ["room line write failed in test", "<EOF>"]]) });
    assert.match(follow.stdout, /^relay: room line write failed in test\r?$/m, follow.stdout + follow.stderr);
    assert.doesNotMatch(follow.stdout + follow.stderr, /^\s+at /m, "no stack trace");
    assert.equal(follow.status, 1, follow.stdout + follow.stderr);
    assert.equal(ok(rooms.roomPrint(r.room_id)).messages.length, 0);
  } finally { await b.close(); }
});

test("room CLI: re-seat uses the generation shown before confirmation", async () => {
  const b = await box();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const r = ok(rooms.roomCreate());
    // The parent controls input to the PTY driver only after changing the reviewed seat.
    const delayed = driver.replace('os.write(fd, (os.environ["ROOM_ANSWER"] + "\\n").encode())', 'sys.stdin.buffer.readline()\n                os.write(fd, (os.environ["ROOM_ANSWER"] + "\\n").encode())');
    child = spawn("python3", ["-c", delayed, process.execPath, CLI, "room", r.room_id, "--reseat", "member-1"], {
      cwd: b.h.repo, env: { ...b.env, ROOM_ANSWER: `reseat member-1 in room ${r.room_id}` },
    });
    const exited = once(child, "exit");
    let output = "", errors = "";
    child.stdout!.on("data", (d) => { output += d.toString(); });
    child.stderr!.on("data", (d) => { errors += d.toString(); });
    await until(() => output.includes("Type exactly"), 10000, "the seat review");
    ok(rooms.roomReseat(r.room_id, r.invites[0].member_id, 1));
    child.stdin!.end("continue\n");
    const [status] = await exited;
    assert.equal(status, 1, output + errors); assert.match(output, /Room unavailable/);
    assert.doesNotMatch(output, /ri1_/);
    assert.equal(ok(rooms.roomPrint(r.room_id)).seats[0].generation, 2);
  } finally { child?.kill("SIGKILL"); await b.close(); }
});

test("room CLI: doctor has one static schema/server/cursor/terminal/restart note, with no inventory", async () => {
  const b = await box();
  try {
    const r = ok(rooms.roomCreate()); await pair(r);
    ok(rooms.roomAddLine(r.room_id, "private room doctor canary", roomText));
    const output = b.h.cli("doctor");
    assert.equal((output.match(/Rooms exist from schema 5/g) ?? []).length, 1);
    assert.match(output, /rooms\s+Rooms exist from schema 5.*restarted Codex or Claude Code server needs a re-seat from the terminal.*caller cursor in room results only.*Terminal checks are best effort.*open a room only in interactive Claude Code or the Codex CLI, on your yes.*Every relay server must be stopped before the upgrade and restarted afterwards/);
    assert.ok(!output.includes(r.room_id)); assert.doesNotMatch(output, /private room doctor canary|ri1_/);
  } finally { await b.close(); }
});

test("room CLI: existing approve and chat retain their terminal behavior", async () => {
  const b = await box();
  try {
    const run = (args: string[], env = b.env) => spawnSync(process.execPath, [CLI, ...args], { env, cwd: b.h.repo, encoding: "utf8" });
    const approve = run(["approve", "missing"], { ...b.env, CODEX_THREAD_ID: "" });
    // Not refused as a host shell: it reaches the request lookup, whose error result exits 1 (as on main).
    assert.equal(approve.status, 1); assert.match(approve.stdout, /unknown request/); assert.doesNotMatch(approve.stderr, /person's own terminal/);
    const launched = run(["approve", "missing"], { ...b.env, RELAY_NODE_ID: "" });
    assert.equal(launched.status, 2); assert.match(launched.stderr, /person's own terminal/);
    // A discussion's existing --print stays readable, including in a host tool shell.
    db().prepare("INSERT INTO runs(id,created_at,root_cwd,config_json,status) VALUES ('run_abc12345', ?, ?, '{}','active')").run(Date.now(), b.h.repo);
    const file = path.join(b.h.home, "discussion.txt"); fs.writeFileSync(file, "old chat transcript\n");
    db().prepare(`INSERT INTO nodes(id,run_id,kind,mode,depth,allow_delegation,status,task,cwd,created_at,transcript_path)
      VALUES ('d_abc12345','run_abc12345','discussion','read',0,0,'open','test',?,?,?)`).run(b.h.repo, Date.now(), file);
    const printed = run(["chat", "d_abc12345", "--print"], { ...b.env, CODEX_THREAD_ID: "" });
    assert.equal(printed.status, 0); assert.equal(printed.stdout, "old chat transcript\n\n");
    const say = run(["chat", "d_abc12345", "--say", "old injection"], { ...b.env, CODEX_THREAD_ID: "" });
    assert.equal(say.status, 0); assert.equal(JSON.parse(say.stdout).injected, true);
    const refused = run(["chat", "d_abc12345", "--say", "blocked"], { ...b.env, RELAY_NODE_ID: "" });
    assert.equal(refused.status, 2);
  } finally { await b.close(); }
});
