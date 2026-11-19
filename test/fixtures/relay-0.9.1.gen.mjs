// Writes test/fixtures/relay-0.9.1.sql (read by test/upgrade.test.ts): a registry exactly as relay
// 0.9.1's own code leaves it, made by driving 0.9.1's MCP server, workers and stub agents through
// 0.9.1's own test harness. Not a test itself; run by hand to make the fixture again:
//
//   mkdir -p "$SCRATCH/v091" && git archive v0.9.1 | tar -x -C "$SCRATCH/v091"
//   (cd "$SCRATCH/v091" && npm ci && ./node_modules/.bin/tsc -p tsconfig.json)
//   node test/fixtures/relay-0.9.1.gen.mjs "$SCRATCH/v091" test/fixtures/relay-0.9.1.sql
//
// npm ci there installs 0.9.1's own locked dependencies (its SDK, zod and TypeScript), not this
// checkout's; the generator refuses a checkout whose installed packages differ from its lock. The
// harness keeps everything (HOME, RELAY_HOME, the repo, the agents' state) in a scratch directory
// of its own; the dump needs /usr/bin/sqlite3 (macOS's). A new fixture has new ids, which
// test/upgrade.test.ts names.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const check = (cond, what) => {
  if (!cond) throw new Error(`generator: ${what}`);
};
const [given, out] = process.argv.slice(2).map((p) => path.resolve(p));
if (!given || !out) throw new Error("usage: node relay-0.9.1.gen.mjs <v0.9.1 checkout> <out.sql>");
// The registry records real paths (0.9.1's harness resolves its own, and Node resolves the
// import.meta.dirname its stub paths come from), so the checkout is known by its real path too.
const checkout = fs.realpathSync(given);
const version = JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8")).version;
// Every package 0.9.1 locked is installed at the version it locked (optional ones may be absent:
// they are other platforms' builds).
const lock = JSON.parse(fs.readFileSync(path.join(checkout, "package-lock.json"), "utf8"));
const drift = Object.entries(lock.packages).filter(([where, p]) => where && !p.link).flatMap(([where, p]) => {
  const file = path.join(checkout, where, "package.json");
  if (!fs.existsSync(file)) return p.optional ? [] : [`${where} is missing`];
  const installed = JSON.parse(fs.readFileSync(file, "utf8")).version;
  return installed === p.version ? [] : [`${where} is ${installed}, locked at ${p.version}`];
});
check(drift.length === 0, `the checkout's node_modules is not the one ${version} locked (run npm ci there): ${drift.join("; ")}`);
const { harness, task, until, INTERACTIVE_CLAUDE } = await import(path.join(checkout, "test", "helpers.ts"));
const { SCHEMA_VERSION } = await import(path.join(checkout, "dist", "core", "db.js"));

const items = (n, extra = "") => "```json\n" + JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ n: i + 1, severity: "major", location: `src/parser.js:${i + 1}`, summary: `issue ${i + 1}${extra}`, evidence: "e", fix: "f" })) }) + "\n```";
const consensus = (entries) => "```json\n" + JSON.stringify({ consensus: entries }) + "\n```";
const agreed = [{ ids: ["C1", "X1"], severity: "major", status: "agreed", summary: "the empty input is not handled" }];

const h = await harness([
  // Run 1, a Claude Code session (codex is the other family).
  { target: "codex", match: task("FIX-PARSER"), steps: [{ write: "parser.js", content: "export const parse = (s) => s.trim();\n" }, { request: "npm install left-pad" }, { reply: "Fixed the parser.\n\n## Open issues\nnone" }] },
  { target: "codex", match: "ADD-TESTS", steps: [{ write: "parser.test.js", content: "// tests\n" }, { reply: "Added tests." }] },
  { target: "codex", match: "SOUND-QUESTION", steps: [{ reply: "Mostly sound; the empty input is the edge case." }] },
  { target: "codex", match: "FOLLOW-UP", steps: [{ reply: "Return an empty result for it." }] },
  { target: "codex", match: "independent code reviewer", steps: [{ reply: `The empty input is not handled.\n${items(1)}` }] },
  { target: "codex", match: "CACHE-FIRST", steps: [{ reply: "Keep it, but bound it.\nCONTINUE" }] },
  { target: "codex", match: "CACHE-SECOND", steps: [{ reply: "Agreed.\nAGREE: keep a bounded cache" }] },
  { target: "codex", match: task("BROKEN"), steps: [{ fail: "model unavailable" }] },
  { target: "codex", match: task("LONG-RUNNING"), steps: [{ awaitMark: "never", within: 120000 }, { reply: "never" }] },
  { target: "codex", match: task("NEEDS-WEB"), steps: [{ request: { fetch: "https://example.com/spec" } }, { reply: "web: {{last}}" }] },
  // Review reconciliation: the reviewer's later turns.
  { target: "codex", turn: 2, steps: [{ reply: `Same finding.\n${consensus(agreed)}\nAGREE: list above` }] },
  // Run 2, a Codex session (claude is the other family): active when the registry is copied.
  { target: "claude", match: task("CLEAN-BUILD"), steps: [{ request: "rm -rf build" }, { reply: "Left build/ alone: {{last}}" }] },
  { target: "claude", match: task("CHANGELOG"), steps: [{ request: { fetch: "https://example.com/changelog" } }, { reply: "read it: {{last}}" }] },
], { desktop_notifications: false, targets: { codex: { default_model: "gpt-6.1-sol", default_effort: "high" } } });

let copyDir = null;
try {
  // Run 1: a Claude Code session in a terminal, which can put requests to the user in a dialog.
  const a = await h.instance({
    ...INTERACTIVE_CLAUDE, args: ["--host", "claude"],
    elicit: (message) => {
      if (message.includes("npm install left-pad")) return { action: "accept", content: { decision: "allow", note: "fine for this job" } };
      return { action: "cancel" };
    },
  });
  // A write job: an approval allowed in the dialog, a second turn, then merged.
  const fix = await a.call("delegate", { target: "codex", task: "FIX-PARSER", mode: "write", background: false });
  check(fix.status === "done", `FIX-PARSER: ${JSON.stringify(fix)}`);
  const more = await a.call("resume", { job_id: fix.job_id, message: "ADD-TESTS for the parser" });
  check(more.status === "queued" || more.status === "running", `resume: ${JSON.stringify(more)}`);
  check((await a.call("status", { id: fix.job_id, wait_s: 30 })).status === "done", "ADD-TESTS");
  const merged = await a.call("merge", { job_id: fix.job_id });
  check(!merged.error && !merged.refused, `merge: ${JSON.stringify(merged)}`);

  // A consult with a follow-up.
  const q = await a.call("ask", { target: "codex", message: "SOUND-QUESTION: is the parser sound?" });
  check(q.reply || q.status === "done", `ask: ${JSON.stringify(q)}`);
  const q2 = await a.call("ask", { thread_id: q.thread_id, message: "FOLLOW-UP: what about empty input?" });
  check(q2.thread_id === q.thread_id, `follow-up: ${JSON.stringify(q2)}`);

  // A discussion with a message from the user injected, ending in agreement.
  const d = await a.call("discuss", { target: "codex", topic: "Keep the parse cache?", message: "CACHE-FIRST: keep the cache?\nCONTINUE" });
  check(d.status === "open", `discuss: ${JSON.stringify(d)}`);
  const said = JSON.parse(h.cli("chat", d.discussion_id, "--say", "user: keep it small."));
  check(said.injected, `chat: ${JSON.stringify(said)}`);
  const d2 = await a.call("discuss", { discussion_id: d.discussion_id, message: "CACHE-SECOND: bounded, then.\nCONTINUE" });
  const d3 = d2.outcome ? d2 : await a.call("discuss", { discussion_id: d.discussion_id, message: "AGREE: keep a bounded cache" });
  check(d3.outcome === "agree", `discussion end: ${JSON.stringify(d3)}`);

  // A review, reconciled to agreement.
  const r = await a.call("review", { target: "src/parser.js", focus: "edge cases" });
  check(r.review_id, `review: ${JSON.stringify(r)}`);
  await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", r.reviewer_job)[0]?.status === "done", 30000, "the reviewer");
  const handed = await a.call("review", { review_id: r.review_id, own_review: `The empty input.\n${items(1)}` });
  check(handed.discussion_id, `own review: ${JSON.stringify(handed)}`);
  const closed = await a.call("discuss", { discussion_id: handed.discussion_id, message: `Agreed.\n${consensus(agreed)}\nAGREE: list above` });
  check(closed.outcome === "agree", `reconciliation: ${JSON.stringify(closed)}`);

  // A job that fails, and one that is cancelled while it runs.
  const broken = await a.call("delegate", { target: "codex", task: "BROKEN", mode: "read", background: false });
  check(broken.status === "failed", `BROKEN: ${JSON.stringify(broken)}`);
  const long = await a.call("delegate", { target: "codex", task: "LONG-RUNNING", mode: "read" });
  await until(() => h.sql("SELECT agent_pid FROM nodes WHERE id = ?", long.job_id)[0]?.agent_pid > 0, 30000, "LONG-RUNNING to start");
  check((await a.call("cancel", { id: long.job_id })).cancelled !== false, "cancel");
  await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", long.job_id)[0]?.status === "cancelled", 30000, "LONG-RUNNING to be cancelled");

  // A web request the user closed in the dialog (undecided), which the session then denied.
  const web = await a.call("delegate", { target: "codex", task: "NEEDS-WEB", mode: "read" });
  await until(() => h.sql("SELECT reading FROM elicitations e JOIN requests q ON q.id = e.request_id WHERE q.node_id = ?", web.job_id)[0]?.reading === "dismissed", 30000, "the dialog to be closed");
  const webReq = h.sql("SELECT id FROM requests WHERE node_id = ?", web.job_id)[0].id;
  check(!(await a.call("approve", { request_id: webReq, decision: "deny", note: "not needed" })).error, "deny NEEDS-WEB");
  check((await a.call("status", { id: web.job_id, wait_s: 30 })).status === "done", "NEEDS-WEB");
  // What the session has seen: every event so far is given with a result.
  await a.call("status", {});

  // Run 2: a Codex session. One request denied from the terminal; one left pending, with a
  // follow-up queued behind it, as an active run is when the upgrade happens.
  const b = await h.instance({ args: ["--host", "codex"] });
  const clean = await b.call("delegate", { target: "claude", task: "CLEAN-BUILD", mode: "write" });
  await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE node_id = ? AND status = 'pending'", clean.job_id)[0].c === 1, 30000, "CLEAN-BUILD's request");
  const cleanReq = h.sql("SELECT id FROM requests WHERE node_id = ?", clean.job_id)[0].id;
  h.cli("deny", cleanReq, "not on this machine");
  check((await b.call("status", { id: clean.job_id, wait_s: 30 })).status === "done", "CLEAN-BUILD");
  const log = await b.call("delegate", { target: "claude", task: "CHANGELOG", mode: "write" });
  await until(() => h.sql("SELECT COUNT(*) AS c FROM requests WHERE node_id = ? AND status = 'pending'", log.job_id)[0].c === 1, 30000, "CHANGELOG's request");
  const queued = await b.call("resume", { job_id: log.job_id, message: "QUEUED-NEXT: then summarise it" });
  check(queued.status === "queued_behind_current_turn", `queued resume: ${JSON.stringify(queued)}`);

  // The registry as it stands now, copied consistently while relay is still running.
  copyDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-091-copy-"));
  const copy = path.join(copyDir, "relay.db");
  h.sql("VACUUM INTO ?", copy);
  // Process ids name processes on this machine, and the version under test acts on them: its reap
  // kills a running job's agent group when the job's worker has gone and the group still has
  // members, which on the machine loading the fixture could be anyone's. In the copy, before the
  // dump, each recorded id is moved above every pid range (macOS's 99999, Linux's limit of 2^22)
  // and kept within a signed 32-bit int; equal ids stay equal, and reap finds no such process.
  const PID_OFFSET = 999_000_000;
  const pidColumns = [];
  {
    const d = new DatabaseSync(copy);
    for (const { name } of d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
      for (const { name: col } of d.prepare(`PRAGMA table_info("${name}")`).all()) {
        if (!/(^|_)pg?id$/.test(col)) continue;
        pidColumns.push(`${name}.${col}`);
        check(d.prepare(`SELECT COUNT(*) AS c FROM "${name}" WHERE "${col}" >= ?`).get(PID_OFFSET).c === 0, `${name}.${col} already holds an id above ${PID_OFFSET}`);
        d.prepare(`UPDATE "${name}" SET "${col}" = "${col}" + ? WHERE "${col}" > 0`).run(PID_OFFSET);
      }
    }
    d.close();
  }
  const dump = spawnSync("/usr/bin/sqlite3", ["-escape", "off", copy, ".dump"], { encoding: "utf8" });
  check(dump.status === 0, dump.stderr);
  const uv = spawnSync("/usr/bin/sqlite3", [copy, "PRAGMA user_version"], { encoding: "utf8" }).stdout.trim();
  check(uv === String(SCHEMA_VERSION), `user_version ${uv}`);
  check(!dump.stdout.includes("unistr("), "the dump uses unistr(), which older SQLite builds lack");
  // .dump leaves out the schema version, which is what the upgrade reads: it goes in at the end. It
  // also recreates sqlite_sequence under writable_schema, which Node's SQLite refuses (defensive
  // mode); the AUTOINCREMENT tables have made that table already, so those three lines go.
  const framing = ["PRAGMA writable_schema=ON;\n", "CREATE TABLE IF NOT EXISTS sqlite_sequence(name,seq);\n", "PRAGMA writable_schema=OFF;\n"];
  for (const line of framing) check(dump.stdout.split(line).length === 2, `the dump has one ${JSON.stringify(line)}`);
  const withVersion = (s) => framing.reduce((t, line) => t.replace(line, ""), s).replace(/COMMIT;\s*$/, `PRAGMA user_version = ${uv};\nCOMMIT;\n`);
  // The dump, loaded with Node's SQLite as the test loads it, is the copy again: every table and row.
  const rows = (d) => Object.fromEntries((d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
    .map(({ name }) => [name, d.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const loaded = new DatabaseSync(":memory:");
  loaded.exec(withVersion(dump.stdout));
  const original = new DatabaseSync(copy, { readOnly: true });
  check(JSON.stringify(rows(loaded)) === JSON.stringify(rows(original)), "the dump does not load back to the same rows");
  check(loaded.prepare("PRAGMA user_version").get().user_version === Number(uv), "the dump does not load back to the same schema version");
  // Scratch paths, which name this machine, are replaced by fixed ones. The checkout's real path
  // goes first: the form given may be a suffix of it (/tmp/x of /private/tmp/x).
  const tmp = path.dirname(h.home);
  const scrubbed = [[tmp, "/Users/someone/relay-0.9.1"], [checkout, "/Users/someone/relay-0.9.1-checkout"], [given, "/Users/someone/relay-0.9.1-checkout"]]
    .reduce((s, [from, to]) => s.replaceAll(from, to), dump.stdout);
  const sql = withVersion(scrubbed);
  const home = os.userInfo().homedir;
  for (const leak of [os.tmpdir(), fs.realpathSync(os.tmpdir()), home, fs.realpathSync(home), given, checkout, "/private/"]) {
    check(!sql.includes(leak), `a scratch or home path is left in the dump: ${leak}`);
  }
  const header = [
    `-- A registry (relay.db) as relay ${version} left it: written by ${version}'s own code (tag v${version},`,
    "-- with the dependencies it locked), driven through its MCP server, workers and stub agents by",
    "-- test/fixtures/relay-0.9.1.gen.mjs, copied with VACUUM INTO while relay was running, and dumped",
    "-- with sqlite3 -escape off .dump. Changed in the copy, before the dump: every recorded process id",
    `-- (${pidColumns.join(", ")})`,
    `-- has ${PID_OFFSET} added, so that none can name a process on the machine that loads it.`,
    "-- Changed in the dump: scratch paths read /Users/someone/...; the writable_schema lines that",
    "-- recreate sqlite_sequence (its tables have made it; Node's SQLite refuses them) are left out;",
    `-- and PRAGMA user_version = ${uv}, which .dump leaves out, is put back before COMMIT. The generator`,
    "-- checks that the dump, with those lines out and the version in, loads back to the same rows.",
    "-- Run 1 (a Claude Code session): a merged write job of two turns with an approval allowed in the",
    "-- dialog, a consult with a follow-up, a discussion with an injected message, a reconciled review,",
    "-- a failed job, a cancelled one, and a request closed in the dialog and then denied.",
    "-- Run 2 (a Codex session, active): a request denied from the terminal, and a running job waiting",
    "-- on a pending request with a turn queued behind it.",
  ].join("\n");
  fs.writeFileSync(out, `${header}\n${sql}`);
  console.log(`wrote ${out}`);
} finally {
  await h.close();
  if (copyDir) fs.rmSync(copyDir, { recursive: true, force: true });
}
