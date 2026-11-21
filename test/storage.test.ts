// What relay keeps in its control directory and for how long (review C12/X10): agents' logs
// rotated at log_max_mb, the secrets relay passes kept out of what it writes, records it cannot
// write reported rather than taking the turn down, and finished runs' records forgotten after
// keep_records_days, never a run still in use.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openAgentLog } from "../dist/backends/types.js";
import { procStart } from "../dist/core/procs.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import { alive, CLI, forEachTarget, harness, reached, release, task, terminalAdoption, until, type Harness } from "./helpers.ts";
import { sendGroupSignal } from "../dist/core/procs.js";

const scratchDir = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-storage-${name}-`)));
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const lines = (n: number, width = 40) => Array.from({ length: n }, (_, i) => `line ${String(i).padStart(3, "0")} ${"x".repeat(width)}\n`);

test("storage: concurrent turns and nested sessions keep generated secret values private to their own redactors", async () => {
  const { withTurnSecrets, registerTurnSecret, redact, redactor } = await import("../dist/core/secrets.js");
  const a = "aTurnSecret1234567890";
  const b = "bTurnSecret1234567890";
  await Promise.all([a, b].map((value) => withTurnSecrets(async () => {
    const cut = redactor({});
    registerTurnSecret(value, "proxy token");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const other = value === a ? b : a;
    assert.equal(cut(`${value} ${other}`), `[redacted: proxy token] ${other}`);
    assert.equal(redact(value), "[redacted: proxy token]");
    withTurnSecrets(() => assert.equal(redact(value), value));
  })));
  assert.equal(redact(`${a} ${b}`), `${a} ${b}`);
});

test("storage: an agent log past its cap is rotated, keeping the newest output and the part before it in agent.log.1, nothing older", async () => {
  const dir = scratchDir("rotate");
  try {
    const file = path.join(dir, "agent.log");
    const { log, warnings } = openAgentLog(file, { maxBytes: 1000 });
    for (const l of lines(100)) log.write(l);
    log.end();
    await until(() => read(file).includes("line 099"), 10000, "the last line to be written");
    assert.ok(fs.existsSync(`${file}.1`), "the log was rotated");
    assert.ok(fs.statSync(file).size <= 1000, `agent.log is within its cap (${fs.statSync(file).size} bytes)`);
    assert.ok(fs.statSync(`${file}.1`).size <= 1000, "so is the part before it");
    assert.doesNotMatch(read(file) + read(`${file}.1`), /line 000/, "the oldest output is gone");
    // Nothing between the two files is lost: agent.log.1 ends where agent.log starts.
    const kept = (read(`${file}.1`) + read(file)).trim().split("\n").map((l) => Number(l.split(" ")[1]));
    assert.deepEqual(kept, Array.from({ length: kept.length }, (_, i) => 100 - kept.length + i));
    assert.deepEqual(warnings(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: an agent log is rotated between the lines of one chunk, and a line longer than the cap is kept whole, alone in its file", async () => {
  const dir = scratchDir("rotate-chunk");
  try {
    const file = path.join(dir, "agent.log");
    const { log, warnings } = openAgentLog(file, { maxBytes: 1000 });
    // Two chunks of 100 lines each (about 5 KB), as a CLI's stderr arrives.
    log.write(lines(100).join(""));
    log.write(lines(100).map((l) => l.replace("line", "more")).join(""));
    for (const f of [file, `${file}.1`]) assert.ok(fs.statSync(f).size <= 1000, `${f} is within its cap (${fs.statSync(f).size} bytes)`);
    assert.match(read(file), /more 099 x+\n$/, "the newest output is kept");
    const long = `${"L".repeat(5000)}\n`;
    log.write(long);
    log.write("after\n");
    log.end();
    assert.equal(read(`${file}.1`), long, "the long line, alone and whole");
    assert.equal(read(file), "after\n");
    assert.deepEqual(warnings(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: relay's own diagnostic logs are rotated at log_max_mb, and a log that cannot be rotated or written says so once", async () => {
  const { appendLog, useStoragePolicy, takeDiagnosticProblems } = await import("../dist/core/storage.js");
  const dir = scratchDir("diag");
  takeDiagnosticProblems();
  try {
    useStoragePolicy({ log_max_mb: 0.001 });
    const cap = Math.round(0.001 * 1024 * 1024);
    const file = path.join(dir, "notices.log");
    for (let i = 0; i < 50; i++) assert.equal(appendLog(file, `{"n":${i},"pad":"${"x".repeat(80)}"}\n`), null);
    assert.ok(fs.existsSync(`${file}.1`), "rotated");
    for (const f of [file, `${file}.1`]) assert.ok(fs.statSync(f).size <= cap, `${f} is within ${cap} bytes (${fs.statSync(f).size})`);
    assert.match(read(file), /"n":49,/);
    assert.doesNotMatch(read(file) + read(`${file}.1`), /"n":0,/, "the oldest entries are gone");
    assert.deepEqual(takeDiagnosticProblems(), []);
    // Its directory made read-only: the log can still be added to, but not moved aside.
    const agent = path.join(dir, "agent.log");
    fs.writeFileSync(agent, `${"a".repeat(2000)}\n`);
    fs.chmodSync(dir, 0o555);
    const problem = appendLog(file, `{"pad":"${"y".repeat(1100)}"}\n`);
    assert.match(String(problem), /^relay could not rotate \S+notices\.log at log_max_mb \(EACCES[^)]*\), so it grows past that size$/);
    assert.match(read(file), /y{1100}/, "the entry itself was written");
    assert.equal(appendLog(file, "{}\n"), problem);
    assert.deepEqual(takeDiagnosticProblems(), [problem], "said once");
    const { log, warnings } = openAgentLog(agent, { maxBytes: 1000 });
    log.write("more\n");
    log.end();
    assert.match(warnings().join("\n"), /^relay could not rotate the agent's log \S+agent\.log at log_max_mb \(EACCES[^)]*\), so it grew past that$/);
    assert.match(read(agent), /a{2000}\nmore\n$/);
  } finally {
    fs.chmodSync(dir, 0o755);
    useStoragePolicy({ log_max_mb: null });
    takeDiagnosticProblems();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: a rotation's lock held by another relay process leaves the rotation to it, and one left by a process killed while it rotated is taken over", async () => {
  const { rotateLog } = await import("../dist/core/storage.js");
  const dir = scratchDir("rotate-lock");
  try {
    const file = path.join(dir, "notices.log");
    const lock = `${file}.rotating`;
    fs.writeFileSync(file, "x".repeat(100));
    // Held a moment ago: its holder rotates the file, so this process does not, and leaves the lock alone.
    fs.mkdirSync(lock);
    assert.equal(rotateLog(file, 50), null);
    assert.equal(fs.existsSync(`${file}.1`), false, "not rotated while another holds the lock");
    assert.equal(read(file), "x".repeat(100));
    assert.ok(fs.existsSync(lock), "the holder's lock is left");
    // Left for longer than a rotation takes (storage.ts LOCK_STALE_MS): taken over, the file rotated, the lock removed.
    const past = new Date(Date.now() - 20_000);
    fs.utimesSync(lock, past, past);
    assert.equal(rotateLog(file, 50), null);
    assert.equal(read(`${file}.1`), "x".repeat(100));
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(lock), false, "the stale lock is removed");
    // A file another process has just rotated away is not rotated again over the part it moved aside.
    assert.equal(rotateLog(file, 50), null);
    assert.equal(read(`${file}.1`), "x".repeat(100));
    // Without a lock, a file past the size is rotated, and no lock is left.
    fs.writeFileSync(file, "y".repeat(100));
    assert.equal(rotateLog(file, 50), null);
    assert.equal(read(`${file}.1`), "y".repeat(100));
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: relay processes appending to the same diagnostic log at once all rotate it without an error, and leave no lock behind", async () => {
  const dir = scratchDir("diag-race");
  try {
    const file = path.join(dir, "notices.log");
    const storage = path.join(import.meta.dirname, "..", "dist", "core", "storage.js");
    const script = `import { appendLog, useStoragePolicy } from ${JSON.stringify(storage)};
      useStoragePolicy({ log_max_mb: 0.002 });
      const problems = new Set();
      for (let i = 0; i < 3000; i++) { const p = appendLog(process.argv[1], JSON.stringify({ pid: process.pid, i, pad: "x".repeat(60) }) + "\\n"); if (p) problems.add(p); }
      console.log(JSON.stringify([...problems]));`;
    // Three relay servers or workers noting at once, as notices.log and elicitation.log are shared.
    const children = [0, 1, 2].map(() => spawn(process.execPath, ["--input-type=module", "-e", script, file], { env: { PATH: process.env.PATH, HOME: dir }, stdio: ["ignore", "pipe", "inherit"] }));
    const outs = await Promise.all(children.map((c) => new Promise<string>((resolve) => {
      let out = "";
      c.stdout!.on("data", (d) => (out += String(d)));
      c.once("exit", () => resolve(out));
    })));
    for (const out of outs) assert.deepEqual(JSON.parse(out), [], out);
    assert.ok(fs.existsSync(`${file}.1`), "rotated");
    assert.equal(fs.existsSync(`${file}.rotating`), false, "no lock is left behind");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: an agent's log that cannot be rotated or opened again says so with the turn, and writing to it never throws", async () => {
  const dir = scratchDir("rotate-fail");
  const node = path.join(dir, "node");
  fs.mkdirSync(node);
  try {
    const file = path.join(node, "agent.log");
    const { log, warnings } = openAgentLog(file, { maxBytes: 100 });
    log.write(`${"a".repeat(79)}\n`);
    // Nothing in its directory can be looked at any more: the rotation's look fails, then the reopening.
    fs.chmodSync(node, 0o000);
    assert.doesNotThrow(() => log.write(`${"b".repeat(79)}\n`));
    assert.doesNotThrow(() => log.write("more\n"));
    log.end();
    const said = warnings().join("\n");
    assert.match(said, /relay could not rotate the agent's log \S+agent\.log at log_max_mb \(EACCES[^)]*\), so it grew past that/, said);
    assert.match(said, /relay could not write the agent's log \S+agent\.log \(EACCES[^)]*\), so the log may be missing or incomplete/, said);
  } finally {
    fs.chmodSync(node, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: a relay server's diagnostic logs are rotated at log_max_mb as the config says at each entry, and as it last loaded while it does not", async () => {
  const dir = scratchDir("diag-config");
  try {
    const config = path.join(dir, "config.json");
    const file = path.join(dir, "notices.log");
    const storage = path.join(import.meta.dirname, "..", "dist", "core", "storage.js");
    // As a relay server writes them: no run's policy set, the user's config read as it is.
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      import { appendLog } from ${JSON.stringify(storage)};
      const [config, file] = process.argv.slice(1);
      const entry = "x".repeat(2000) + "\\n";
      const rotated = () => fs.existsSync(file + ".1");
      const seen = [];
      fs.writeFileSync(config, "{}");
      appendLog(file, entry); appendLog(file, entry);
      seen.push(rotated());
      fs.writeFileSync(config, JSON.stringify({ log_max_mb: 0.001 }));
      appendLog(file, entry);
      seen.push(rotated());
      fs.rmSync(file + ".1");
      fs.writeFileSync(config, "{ not json");
      appendLog(file, entry); appendLog(file, entry);
      seen.push(rotated());
      console.log(JSON.stringify(seen));
    `, config, file], { env: { PATH: process.env.PATH, HOME: dir, RELAY_CONFIG: config }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [false, true, true], "kept whole without it; rotated once it is set; still rotated while the config does not load");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: a worker's worker.log is rotated at the run's log_max_mb when its next worker starts, and a relay server that cannot rotate it says so once", async () => {
  const h = await harness([], { log_max_mb: 0.001 });
  let dir = "";
  try {
    const first = await h.call("ask", { target: "claude", message: "FIRST" });
    assert.ok(first.thread_id, JSON.stringify(first));
    await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", first.thread_id)[0].worker_pid === null, 20000, "the first turn's worker to finish");
    const workerLog = path.join(path.dirname(h.sql("SELECT log_path FROM nodes WHERE id = ?", first.thread_id)[0].log_path as string), "worker.log");
    // As if the first worker had said that much.
    fs.appendFileSync(workerLog, `${"z".repeat(2000)}\n`);
    const second = await h.call("ask", { target: "claude", thread_id: first.thread_id, message: "SECOND" });
    assert.ok(second.reply !== undefined, JSON.stringify(second));
    assert.match(read(`${workerLog}.1`), /z{2000}/, "rotated as the second worker started");
    assert.doesNotMatch(read(workerLog), /z{2000}/);
    assert.equal(JSON.stringify(second).includes("could not rotate"), false, JSON.stringify(second));
    // Once it cannot be rotated (its directory not writable), the relay server that starts the next
    // worker says so in that call's result, once.
    await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", first.thread_id)[0].worker_pid === null, 20000, "the second turn's worker to finish");
    fs.appendFileSync(workerLog, `${"y".repeat(2000)}\n`);
    dir = path.dirname(workerLog);
    fs.chmodSync(dir, 0o555);
    const third = await h.call("ask", { target: "claude", thread_id: first.thread_id, message: "THIRD" });
    assert.ok(third.reply !== undefined, JSON.stringify(third));
    const unrotated = (r: Record<string, unknown>) => ((r.warnings ?? []) as string[]).filter((w) => w.startsWith(`relay could not rotate ${workerLog} at log_max_mb (EACCES`));
    assert.equal(unrotated(third).length, 1, JSON.stringify(third));
    await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", first.thread_id)[0].worker_pid === null, 20000, "the third turn's worker to finish");
    const fourth = await h.call("ask", { target: "claude", thread_id: first.thread_id, message: "FOURTH" });
    assert.ok(fourth.reply !== undefined, JSON.stringify(fourth));
    assert.equal(unrotated(fourth).length, 0, `said once: ${JSON.stringify(fourth)}`);
  } finally {
    if (dir) fs.chmodSync(dir, 0o755);
    await h.close();
  }
});

forEachTarget((target) => {
  test(`storage (${target}): log_max_mb in relay's config caps each agent's log; without it the log is kept whole`, async () => {
    // About 30 KB of output from the agent in one turn.
    const noisy = [{ match: "NOISY", steps: [...Array.from({ length: 150 }, (_, i) => ({ emit: { type: "stub_noise", n: i, pad: "x".repeat(180) } })), { reply: "done" }] }];
    const capped = await harness(noisy, { log_max_mb: 0.01 });
    try {
      const r = await capped.call("ask", { target, message: "NOISY" });
      assert.equal(r.reply, "done", JSON.stringify(r));
      const log = capped.sql("SELECT log_path FROM nodes WHERE id = ?", r.thread_id)[0].log_path as string;
      await until(() => capped.sql("SELECT worker_pid FROM nodes WHERE id = ?", r.thread_id)[0].worker_pid === null, 20000, "the turn's worker to finish");
      assert.ok(fs.existsSync(`${log}.1`), "the log was rotated");
      // Rotated before a write would take it past the cap; each write is a line of the agent's output.
      for (const f of [log, `${log}.1`]) assert.ok(fs.statSync(f).size <= 10486, `${f} stays within 0.01 MB (${fs.statSync(f).size} bytes)`);
      assert.doesNotMatch(read(log) + read(`${log}.1`), /"n":0,/, "the oldest output is gone");
    } finally {
      await capped.close();
    }
    const whole = await harness(noisy);
    try {
      const r = await whole.call("ask", { target, message: "NOISY" });
      assert.equal(r.reply, "done", JSON.stringify(r));
      const log = whole.sql("SELECT log_path FROM nodes WHERE id = ?", r.thread_id)[0].log_path as string;
      await until(() => whole.sql("SELECT worker_pid FROM nodes WHERE id = ?", r.thread_id)[0].worker_pid === null, 20000, "the turn's worker to finish");
      assert.equal(fs.existsSync(`${log}.1`), false, "by default nothing is rotated away");
      assert.match(read(log), /"n":0,/);
    } finally {
      await whole.close();
    }
  });
});


// Made up for the tests, in the shapes relay knows: a GitHub token, another tool's token, a proxy URL's password, an Anthropic key.
const GH = `ghp_${"A1b2C3d4E5".repeat(4)}`;
const OTHER = "tok-3x4mpl3-s3cr3t-val";
const PROXY_PASS = "Zx9-proxy-token_abcdefghijk";
const ANTHROPIC_SHAPED = `sk-ant-oat01-${"q".repeat(40)}`;
const XAI_SHAPED = `xai-${"A1b2C3d4E5".repeat(8)}`; // An invented 80-character suffix, never a real key.

test("storage: xAI keys are cut by shape without an environment value or secret name, and near misses are kept", async () => {
  const { redactor } = await import("../dist/core/secrets.js");
  const cut = redactor({});
  for (const key of [XAI_SHAPED, XAI_SHAPED.toUpperCase(), `xai-${"a".repeat(20)}`, `${XAI_SHAPED}1234567890`]) {
    assert.equal(cut(`found (${key}), done`), "found ([redacted]), done");
  }
  for (const text of [
    "xai-status", `xai-${"A1b2C3d4E5".repeat(2).slice(0, 19)}`,
    `prefix${XAI_SHAPED}`, XAI_SHAPED.replace("xai-", "xai_"),
    `xai-${"A1b2C3d4E5"}_${"F6g7H8i9J0"}`,
  ]) assert.equal(cut(text), text, text);
});

test("storage: an xAI key found outside relay's environment is cut from an agent log and job result", async () => {
  // No secret's name beside the value: this must exercise the vendor shape alone.
  const h = await harness([{ match: task("XAI-SHAPE"), steps: [
    { emit: { type: "stub_noise", seen: XAI_SHAPED } },
    { reply: `found ${XAI_SHAPED}, done` },
  ] }]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "XAI-SHAPE", mode: "read", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const result = (await h.call("result", { job_id: job.job_id })).result;
    assert.equal(result.final_message, "found [redacted], done");
    const node = h.sql("SELECT log_path FROM nodes WHERE id = ?", job.job_id)[0];
    await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", job.job_id)[0].worker_pid === null, 20000, "the turn's worker to finish");
    assert.match(read(node.log_path), /"type":"stub_noise","seen":"\[redacted\]"/);
    for (const text of [JSON.stringify(result), read(node.log_path), read(result.final_message_path)]) {
      assert.equal(text.includes(XAI_SHAPED), false, text);
      assert.ok(text.includes("[redacted]"), text);
    }
  } finally {
    await h.close();
  }
});

test("storage: the agent's log keeps out the secrets in the environment relay passes, and credentials by their shape", async () => {
  const dir = scratchDir("redact");
  try {
    const file = path.join(dir, "agent.log");
    const env = { GH_TOKEN: GH, SOME_SERVICE_TOKEN: OTHER, HTTPS_PROXY: `http://relay:${PROXY_PASS}@127.0.0.1:9`, PLAIN_VALUE: "an-ordinary-value", AUTH_DIR: "/a/path/not/a/secret" };
    const { log } = openAgentLog(file, { env });
    log.write(`{"type":"tool","output":"GH_TOKEN=${GH}"}\n`);
    // A secret split across two writes, as stderr arrives in chunks.
    log.write(`[stderr] other ${OTHER.slice(0, 7)}`);
    log.write(`${OTHER.slice(7)} and the proxy's ${PROXY_PASS}\n`);
    log.write(`Proxy-Authorization: Basic ${Buffer.from(`relay:${PROXY_PASS}`).toString("base64")}\n`);
    log.write(`a key it found: ${ANTHROPIC_SHAPED}\n`);
    log.write(`a value it read: ${XAI_SHAPED.slice(0, 17)}`);
    log.write(`${XAI_SHAPED.slice(17)}\n`);
    // The last line, with no line break after it (an agent's last words on stderr), is cut as every other: one secret by value, one by shape.
    log.write(`an-ordinary-value under /a/path/not/a/secret, last ${OTHER} and ${GH}, unfinished`);
    log.end();
    await until(() => read(file).includes("unfinished"), 10000, "the log to be written");
    const text = read(file);
    for (const secret of [GH, OTHER, PROXY_PASS, Buffer.from(`relay:${PROXY_PASS}`).toString("base64"), ANTHROPIC_SHAPED, XAI_SHAPED]) assert.equal(text.includes(secret), false, `${secret} was kept out:\n${text}`);
    assert.equal(text.match(/\[redacted\]/g)?.length, 8, text);
    assert.match(text, /\nan-ordinary-value under \/a\/path\/not\/a\/secret, last \[redacted\] and \[redacted\], unfinished$/, "nothing else is cut");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

forEachTarget((target) => {
  test(`storage (${target}): a token relay passes to an agent is kept out of its log, its reply and what relay records of the turn`, async () => {
    const h = await harness([{ match: "TELL", steps: [{ emit: { type: "stub_noise", seen: GH } }, { stderr: `token ${OTHER} on stderr\n` }, { reply: `the tokens are ${GH} and ${OTHER}` }] }], {}, { GH_TOKEN: GH, SOME_SERVICE_TOKEN: OTHER });
    try {
      const r = await h.call("ask", { target, message: "TELL" });
      assert.equal(r.reply, "the tokens are [redacted] and [redacted]", JSON.stringify(r));
      const node = h.sql("SELECT log_path, run_id FROM nodes WHERE id = ?", r.thread_id)[0];
      await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", r.thread_id)[0].worker_pid === null, 20000, "the turn's worker to finish");
      assert.match(read(node.log_path), /"type":"stub_noise","seen":"\[redacted\]"/, "what the agent printed reached its log, cut");
      // Claude's stderr is kept in its log (Codex's app server's is not).
      if (target === "claude") assert.match(read(node.log_path), /\[stderr\] token \[redacted\] on stderr/);
      const turn = h.sql("SELECT reply, prompt_path FROM turns WHERE node_id = ?", r.thread_id)[0];
      const finals = fs.readdirSync(path.dirname(node.log_path)).filter((f) => f.startsWith("final-")).map((f) => read(path.join(path.dirname(node.log_path), f)));
      for (const [what, text] of [["log", read(node.log_path)], ["turn's reply", turn.reply], ["final message", finals.join("\n")]] as const) {
        assert.equal(text.includes(GH) || text.includes(OTHER), false, `the ${what} keeps the tokens out:\n${text}`);
      }
      assert.match(read(node.log_path), /\[redacted\]/);
    } finally {
      await h.close();
    }
  });
});

test("storage: a write that fails on a full disk or a read-only directory is said in words a person can act on", async () => {
  const { storageProblem, writeProblem, writing } = await import("../dist/core/storage.js");
  const err = (code: string, message: string, syscall = "open") => Object.assign(new Error(`${code}: ${message}, ${syscall} '/x/final-3.md'`), { code, syscall, path: "/x/final-3.md" });
  assert.equal(storageProblem(err("ENOSPC", "no space left on device")), "relay could not write /x/final-3.md (ENOSPC: no space left on device, open '/x/final-3.md'): the disk it is on is full; free space there");
  assert.equal(storageProblem(err("EDQUOT", "disk quota exceeded")), "relay could not write /x/final-3.md (EDQUOT: disk quota exceeded, open '/x/final-3.md'): the disk it is on is full; free space there");
  assert.match(storageProblem(err("EROFS", "read-only file system"))!, /: it, or the directory it is in, is not writable; make it writable again$/);
  for (const code of ["EACCES", "EPERM"]) {
    // A refusal is a write problem where relay was writing: a call only a write makes, or one it made in writing().
    for (const syscall of ["mkdir", "rename", "unlink", "write"]) assert.match(storageProblem(err(code, "denied", syscall))!, /: it, or the directory it is in, is not writable; make it writable again$/, `${code} ${syscall}`);
    assert.throws(() => writing(() => { throw err(code, "denied"); }), (e: unknown) => /is not writable; make it writable again$/.test(storageProblem(e)!));
    // A read's refusal, or an open relay cannot tell was a write's, is left as it was: relay was not writing then.
    for (const syscall of ["open", "lstat", "realpath", "scandir", "stat", "access"]) assert.equal(storageProblem(err(code, "denied", syscall)), null, `${code} ${syscall}`);
    // Where relay knows it was writing (a record, a log), any refusal is a write's.
    assert.match(writeProblem("/x/final-3.md", err(code, "denied")), /is not writable; make it writable again$/);
  }
  // As the filesystem gives them: a launch's read under a directory relay may not look in is not said as a write.
  const dir = scratchDir("refused");
  const locked = path.join(dir, "locked");
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, "f"), "x");
  fs.chmodSync(locked, 0o000);
  try {
    const thrown = (f: () => unknown): unknown => {
      try {
        f();
      } catch (e) {
        return e;
      }
      return assert.fail("no error");
    };
    assert.equal(storageProblem(thrown(() => fs.realpathSync(path.join(locked, "inner")))), null);
    assert.equal(storageProblem(thrown(() => fs.readFileSync(path.join(locked, "f")))), null);
    assert.match(storageProblem(thrown(() => fs.mkdirSync(path.join(locked, "new"))))!, /^relay could not write \S+new \(EACCES[^)]*\): it, or the directory it is in, is not writable/);
  } finally {
    fs.chmodSync(locked, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // What it cost comes before what to do about it.
  assert.equal(storageProblem(err("ENOSPC", "no space left on device"), "the worker stopped there"), "relay could not write /x/final-3.md (ENOSPC: no space left on device, open '/x/final-3.md'), so the worker stopped there: the disk it is on is full; free space there");
  // The registry's own: node:sqlite's errors carry SQLite's result code (an extended one in the high bits).
  const sqlite = (errcode: number, message: string) => Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode, errstr: message });
  assert.match(storageProblem(sqlite(13, "database or disk is full"))!, /^relay could not write its registry \S+relay\.db \(database or disk is full\): the disk it is on is full; free space there$/);
  for (const code of [8, 264, 1032]) assert.match(storageProblem(sqlite(code, "attempt to write a readonly database"))!, /^relay could not write its registry .*: it, or the directory it is in, is not writable/);
  assert.equal(storageProblem(sqlite(1555, "UNIQUE constraint failed: runs.id")), null, "a registry error that is not about room or permissions is left as it was");
  assert.equal(storageProblem(new Error("something else")), null, "anything else is left as it was");
});

forEachTarget((target) => {
  test(`storage (${target}): a turn whose records cannot be written (a read-only or full control directory) still runs, and says what was not kept`, async () => {
    const h = await harness([{ match: "FIRST", steps: [{ reply: "first answer" }] }, { match: "SECOND", steps: [{ reply: "second answer" }] }]);
    let dir = "";
    try {
      const first = await h.call("ask", { target, message: "FIRST" });
      assert.equal(first.reply, "first answer", JSON.stringify(first));
      const node = h.sql("SELECT log_path, worker_pid FROM nodes WHERE id = ?", first.thread_id)[0];
      dir = path.dirname(node.log_path);
      await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", first.thread_id)[0].worker_pid === null, 20000, "the first turn's worker to finish");
      // Nothing new can be made in the node's directory now, as on a full disk; files there already can still be written.
      fs.chmodSync(dir, 0o555);
      const second = await h.call("ask", { target, thread_id: first.thread_id, message: "SECOND" });
      assert.equal(second.reply, "second answer", JSON.stringify(second));
      // What the caller is given: the turn's warning names both records.
      const said = String(second.warning);
      assert.match(said, /relay could not write \S*prompt-\d+\.txt \([^)]*\), so no copy of this turn's prompt was kept: it, or the directory it is in, is not writable; make it writable again\./, JSON.stringify(second));
      assert.match(said, /relay could not write \S*final-\d+\.md \([^)]*\), so the final message is kept only in the registry: it, or the directory it is in, is not writable/, JSON.stringify(second));
      // And status, from the thread's result, each once.
      const status = await h.call("status", { id: first.thread_id });
      const kept = JSON.stringify(status);
      assert.equal(kept.match(/prompt-\d+\.txt \(/g)?.length, 1, kept);
      assert.equal(kept.match(/final-\d+\.md \(/g)?.length, 1, kept);
      const turn = h.sql("SELECT status, reply, prompt_path FROM turns WHERE node_id = ? ORDER BY id DESC LIMIT 1", first.thread_id)[0];
      assert.equal(turn.status, "done");
      assert.equal(turn.reply, "second answer");
      assert.equal(turn.prompt_path, null, "no prompt copy is claimed that was not written");
    } finally {
      if (dir) fs.chmodSync(dir, 0o755);
      await h.close();
    }
  });
});

test("storage: a job whose final message cannot be written keeps all of it in its result, and names no file for it", async () => {
  // Past the 6000 characters a job's result keeps of a message that is in its file.
  const long = `the whole report ${"0123456789".repeat(700)} ends here`;
  const h = await harness([{ match: task("JOB-FIRST"), steps: [{ reply: "first report" }] }, { match: "JOB-SECOND", steps: [{ reply: long }] }]);
  let dir = "";
  try {
    const job = await h.call("delegate", { target: "claude", task: "JOB-FIRST", mode: "read", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    dir = path.dirname(h.sql("SELECT log_path FROM nodes WHERE id = ?", job.job_id)[0].log_path as string);
    assert.ok(fs.existsSync((await h.call("result", { job_id: job.job_id })).result.final_message_path), "the first report is in its file");
    await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", job.job_id)[0].worker_pid === null, 20000, "the first turn's worker to finish");
    fs.chmodSync(dir, 0o555);
    await h.call("resume", { job_id: job.job_id, message: "JOB-SECOND" });
    await until(() => h.sql("SELECT COUNT(*) AS c FROM turns WHERE node_id = ? AND status = 'done'", job.job_id)[0].c === 2 && h.sql("SELECT worker_pid FROM nodes WHERE id = ?", job.job_id)[0].worker_pid === null, 20000, "the second turn");
    const r = (await h.call("result", { job_id: job.job_id })).result;
    assert.equal(r.final_message, long, "kept whole, not truncated to a file that is not there");
    assert.equal("final_message_path" in r, false, JSON.stringify(r));
    assert.match(JSON.stringify(r.warnings), /relay could not write \S*final-\d+\.md \([^)]*\), so the final message is kept only in the registry: it, or the directory it is in, is not writable/, JSON.stringify(r.warnings));
  } finally {
    if (dir) fs.chmodSync(dir, 0o755);
    await h.close();
  }
});

test("storage: a worker whose worker.log cannot be opened still starts, its turn answers, and the log's failure is said once", async () => {
  const h = await harness([{ match: "FIRST", steps: [{ reply: "first answer" }] }, { match: "AGAIN", steps: [{ reply: "again" }] }]);
  let dir = "";
  try {
    const first = await h.call("ask", { target: "claude", message: "FIRST" });
    dir = path.dirname(h.sql("SELECT log_path FROM nodes WHERE id = ?", first.thread_id)[0].log_path as string);
    await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", first.thread_id)[0].worker_pid === null, 20000, "the first turn's worker to finish");
    // No worker.log, and none can be made: the node's directory is not writable.
    fs.rmSync(path.join(dir, "worker.log"));
    fs.chmodSync(dir, 0o555);
    const unlogged = new RegExp(`relay could not write ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/worker\\.log \\(EACCES[^)]*\\), so what the worker of ${first.thread_id} prints is not kept: it, or the directory it is in, is not writable; make it writable again`);
    const said: string[] = [];
    for (const message of ["AGAIN", "AGAIN once more"]) {
      const r = await h.call("ask", { target: "claude", thread_id: first.thread_id, message });
      assert.equal(r.reply, "again", JSON.stringify(r));
      said.push(...((r.warnings ?? []) as string[]));
      await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", first.thread_id)[0].worker_pid === null, 20000, "the turn's worker to finish");
    }
    assert.equal(said.filter((w) => unlogged.test(w)).length, 1, JSON.stringify(said));
    assert.equal(said.some((w) => /go on/.test(w)), false, "nothing is promised of the turns");
  } finally {
    if (dir) fs.chmodSync(dir, 0o755);
    await h.close();
  }
});

test("storage: a new session whose directory cannot be made fails its first turn with why and what to do, and leaves no turn of it open", async () => {
  const h = await harness([{ match: "FIRST", steps: [{ reply: "first answer" }] }, { match: "NEW-THREAD", steps: [{ reply: "never" }] }]);
  let nodes = "";
  try {
    const first = await h.call("ask", { target: "claude", message: "FIRST" });
    nodes = path.join(h.home, "runs", runOf(h, first.thread_id), "nodes");
    await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", first.thread_id)[0].worker_pid === null, 20000, "the first turn's worker to finish");
    fs.chmodSync(nodes, 0o555);
    const r = await h.call("ask", { target: "claude", message: "NEW-THREAD" });
    assert.ok(r.thread_id && r.thread_id !== first.thread_id, JSON.stringify(r));
    assert.match(String(r.error), /^relay could not write \S+\/nodes\/t_[0-9a-f]+ \(EACCES: permission denied, mkdir [^)]*\), so the session's worker stopped there: it, or the directory it is in, is not writable; make it writable again\.$/, JSON.stringify(r));
    // Its worker.log could not be made either: said, without a word about its turns going on.
    const said = JSON.stringify(r.warnings ?? []);
    assert.match(said, /relay could not write its worker\.log \(EACCES[^)]*\), so what the worker of t_[0-9a-f]+ prints is not kept: /, said);
    assert.equal(/go on/.test(said), false, said);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM turns WHERE node_id = ? AND status IN ('queued', 'running')", r.thread_id)[0].c, 0, "no turn is left open");
    assert.equal(h.sql("SELECT status FROM nodes WHERE id = ?", r.thread_id)[0].status, "failed");
  } finally {
    if (nodes) fs.chmodSync(nodes, 0o755);
    await h.close();
  }
});

test("storage: a worker stopped by an error that is no storage problem says so as a worker error, and closes every turn of its session", async () => {
  const h = await harness([{ match: "FIRST", steps: [{ reply: "first answer" }] }]);
  try {
    const first = await h.call("ask", { target: "claude", message: "FIRST" });
    const id = first.thread_id as string;
    await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", id)[0].worker_pid === null, 20000, "the first turn's worker to finish");
    // Two turns queued on a session whose target relay does not know: its worker throws at the first.
    h.sql("UPDATE nodes SET target = 'no-such-target', status = 'queued' WHERE id = ?", id);
    for (const body of ["one", "two"]) h.sql("INSERT INTO turns (node_id, source, body, access, status, created_at) VALUES (?, 'caller', ?, 'read', 'queued', ?)", id, body, Date.now());
    // A worker relay starts gets its root's broker address; one run by hand needs it given (W9).
    const socket = h.environmentSocket(id);
    assert.ok(socket, "the first turn's launch named the root's environment broker");
    h.cliEnv({ RELAY_ENV_SOCKET: socket! }, "worker", id);
    const node = h.sql("SELECT status, error FROM nodes WHERE id = ?", id)[0];
    assert.equal(node.status, "failed");
    assert.match(String(node.error), /^worker error: TypeError/, String(node.error));
    const turns = h.sql("SELECT status, error FROM turns WHERE node_id = ? AND body IN ('one', 'two')", id);
    assert.deepEqual(turns.map((t) => t.status), ["failed", "failed"], "no turn is left queued or running with no worker to run it");
    for (const t of turns) assert.match(String(t.error), /^worker error: /);
  } finally {
    await h.close();
  }
});

test("storage: a discussion whose transcript cannot be written goes on, and its result says the transcript is incomplete", async () => {
  const h = await harness([
    { target: "codex", turn: 1, steps: [{ reply: "One point.\nCONTINUE" }] },
    { target: "codex", turn: 2, steps: [{ reply: "Agreed.\nAGREE: keep it" }] },
  ]);
  let transcript = "";
  try {
    const first = await h.call("discuss", { target: "codex", topic: "keep it?", message: "Keep it?\nCONTINUE" });
    assert.equal(first.status, "open", JSON.stringify(first));
    transcript = first.transcript_path;
    fs.chmodSync(transcript, 0o444);
    const second = await h.call("discuss", { discussion_id: first.discussion_id, message: "Then we agree.\nAGREE: keep it" });
    assert.equal(second.outcome, "agree", JSON.stringify(second));
    assert.equal(second.conclusion, "keep it");
    assert.equal(second.warnings?.filter((w: string) => /transcript is incomplete/.test(w)).length, 1, JSON.stringify(second.warnings));
    assert.match(second.warnings[0], new RegExp(`relay could not write ${transcript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
  } finally {
    if (transcript) fs.chmodSync(transcript, 0o644);
    await h.close();
  }
});

const DAY = 86_400_000;
/** Moves everything recorded of a run `days` into the past, as if it had happened then. */
function age(h: Harness, runId: string, days: number): void {
  const ms = days * DAY;
  const shift = (col: string) => `${col} = CASE WHEN ${col} IS NULL THEN NULL ELSE ${col} - ${ms} END`;
  h.sql(`UPDATE runs SET ${shift("created_at")} WHERE id = ?`, runId);
  h.sql(`UPDATE nodes SET ${["created_at", "started_at", "ended_at"].map(shift).join(", ")} WHERE run_id = ?`, runId);
  h.sql(`UPDATE turns SET ${["created_at", "started_at", "ended_at"].map(shift).join(", ")} WHERE node_id IN (SELECT id FROM nodes WHERE run_id = ?)`, runId);
  h.sql(`UPDATE requests SET ${["created_at", "decided_at"].map(shift).join(", ")} WHERE run_id = ?`, runId);
  h.sql(`UPDATE events SET ${["created_at", "noticed_at", "seen_at"].map(shift).join(", ")} WHERE run_id = ?`, runId);
}
/** Waits for every worker process relay started for a run to have exited, its housekeeping done. */
async function workersGone(h: Harness, runId: string): Promise<void> {
  const pids = () => h.sql("SELECT pid FROM relay_procs WHERE kind = 'worker' AND node_id IN (SELECT id FROM nodes WHERE run_id = ?)", runId).map((r) => r.pid as number);
  await until(() => pids().every((pid) => !alive(pid)), 20000, `the workers of ${runId} to exit`);
}
const runOf = (h: Harness, id: string) => h.sql("SELECT run_id FROM nodes WHERE id = ?", id)[0].run_id as string;
/** A root session of its own that asks one thing and closes, its relay server gone; returns the run it made. */
async function closedRun(h: Harness, message: string, host = "codex", target = "claude"): Promise<string> {
  const s = await h.instance({ args: ["--host", host] });
  const r = await s.call("ask", { target, message });
  assert.ok(r.thread_id, JSON.stringify(r));
  const run = runOf(h, r.thread_id);
  const pid = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid as number;
  await s.close();
  await until(() => !alive(pid), 20000, "the session's relay server to exit");
  await workersGone(h, run);
  return run;
}
const rows = (h: Harness, runId: string) => h.sql("SELECT (SELECT COUNT(*) FROM runs WHERE id = ?1) + (SELECT COUNT(*) FROM nodes WHERE run_id = ?1) AS n", runId)[0].n as number;
/**
 * A private temporary directory for the relay processes of a test whose workers do their daily
 * housekeeping, which sweeps it: never the machine's (helpers.ts harness). Short, so that relay's
 * socket names fit in it.
 */
const shortTmp = () => fs.realpathSync(fs.mkdtempSync("/tmp/rs-"));
/** Lets the next worker do its daily housekeeping, which the harness marks done (helpers.ts harness). */
const housekeepingDue = (h: Harness) => fs.rmSync(path.join(h.home, "housekeeping"), { force: true });

test("storage: by default relay clean forgets no run's records, however old", async () => {
  const h = await harness();
  try {
    const old = await closedRun(h, "OLD");
    age(h, old, 400);
    const cleaned = JSON.parse(h.cli("clean"));
    assert.match(cleaned.records_note, /^kept: keep_records_days is not set/, JSON.stringify(cleaned));
    assert.equal(rows(h, old), 2, "the run and its thread are still in the registry");
    assert.ok(fs.existsSync(path.join(h.home, "runs", old)), "and its records on disk");
  } finally {
    await h.close();
  }
});

test("storage: with keep_records_days, relay clean forgets runs older than that which nothing uses, and keeps every run still in use", async () => {
  const h = await harness([
    { match: task("HELD"), steps: [{ signal: "held-started" }, { await: "held-go" }, { reply: "held done" }] },
    { match: task("CHANGE"), steps: [{ write: "change.txt", content: "c\n" }, { reply: "changed" }] },
  ], { keep_records_days: 7 });
  try {
    // Workers' own housekeeping stays off (the harness marks it done): what the test sees is relay clean's doing.
    // A: finished, its session gone. F: the same, but recent.
    const a = await closedRun(h, "A-FORGET-ME-0x7f3c");
    const f = await closedRun(h, "F");
    // B: a job still running, its session gone.
    const sb = await h.instance({ args: ["--host", "codex"] });
    const held = await sb.call("delegate", { target: "claude", task: "HELD", mode: "read", background: true });
    // Its agent must have started before the session goes. The node shows as running once the turn
    // holds its slot, before the turn has its environment from the owning root (W9); a session
    // closed in between fails the turn by design, and nothing would then be running.
    await until(() => reached(h, "held-started"), 20000, "the held job's agent to start");
    const b = runOf(h, held.job_id);
    const bPid = h.sql("SELECT root_pid FROM runs WHERE id = ?", b)[0].root_pid as number;
    await sb.close();
    await until(() => !alive(bPid), 20000, "B's session to exit");
    // C: a discussion left open, waiting for its caller.
    const sc = await h.instance({ args: ["--host", "claude"] });
    const disc = await sc.call("discuss", { target: "codex", topic: "open", message: "Still thinking.\nCONTINUE" });
    assert.equal(disc.status, "open", JSON.stringify(disc));
    const c = runOf(h, disc.discussion_id);
    const cPid = h.sql("SELECT root_pid FROM runs WHERE id = ?", c)[0].root_pid as number;
    await sc.close();
    await until(() => !alive(cPid), 20000, "C's session to exit");
    // D: a write job whose branch is not merged.
    const sd = await h.instance({ args: ["--host", "codex"] });
    const change = await sd.call("delegate", { target: "claude", task: "CHANGE", mode: "write", background: false });
    assert.equal(change.status, "done", JSON.stringify(change));
    const d = runOf(h, change.job_id);
    const dPid = h.sql("SELECT root_pid FROM runs WHERE id = ?", d)[0].root_pid as number;
    await sd.close();
    await until(() => !alive(dPid), 20000, "D's session to exit");
    // E: finished, in this test's own session, which is still open.
    const e = runOf(h, (await h.call("ask", { target: "claude", message: "E" })).thread_id);
    // G: finished, its session gone, but one of relay's own processes for it still running (here, this test's).
    const g = await closedRun(h, "G");
    const gNode = h.sql("SELECT id FROM nodes WHERE run_id = ?", g)[0].id as string;
    h.sql("INSERT INTO relay_procs (pid, start, kind, node_id, created_at) VALUES (?, ?, 'server', ?, ?)", process.pid, procStart(process.pid), gNode, Date.now());
    for (const run of [a, b, c, d, e, g]) age(h, run, 30);
    fs.mkdirSync(path.join(`${h.home}-harness`, a, "j_00000000"), { recursive: true });

    const cleaned = JSON.parse(h.cli("clean"));
    assert.deepEqual(cleaned.records_forgotten, [a], JSON.stringify(cleaned));
    const kept = (run: string) => (cleaned.records_kept as string[]).find((k) => k.startsWith(`${run}: `)) ?? "";
    assert.match(kept(b), new RegExp(`${held.job_id} is running`));
    assert.match(kept(c), new RegExp(`${disc.discussion_id} is an open discussion`));
    assert.match(kept(d), new RegExp(`${change.job_id}'s branch relay/${change.job_id} is still in`));
    assert.match(kept(e), /its session is still open/);
    assert.match(kept(g), new RegExp(`relay's server process ${process.pid} for ${gNode} is still running`));
    assert.equal(kept(f), "", "a recent run is not even considered");
    assert.equal(rows(h, a), 0, "A's rows are gone from the registry");
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM turns WHERE node_id NOT IN (SELECT id FROM nodes)")[0].n, 0, "and its turns");
    assert.equal(fs.existsSync(path.join(h.home, "runs", a)), false, "its records are gone from disk");
    assert.equal(fs.existsSync(path.join(`${h.home}-harness`, a)), false, "and its harnesses' state");
    // Rebuilding the registry while B runs could block its result writer. The rows and files
    // are forgotten now; removal of old database copies is explicitly deferred until idle.
    assert.match(cleaned.records_left.join("\n"), /deferred while runs are active/);
    assert.ok(fs.existsSync(path.join(h.home, "registry-rebuild")));
    for (const run of [b, c, d, e, f, g]) {
      assert.ok(rows(h, run) >= 2, `${run} is still in the registry`);
      assert.ok(fs.existsSync(path.join(h.home, "runs", run)), `${run}'s records are still on disk`);
    }
    release(h, "held-go");
    await until(() => h.sql("SELECT status FROM nodes WHERE id = ?", held.job_id)[0]?.status === "done", 20000, "the held job to finish");
  } finally {
    await h.close();
  }
});

test("storage: relay clean with a run's id applies keep_records_days to that run alone, refuses a run it does not know, and keeps every run when the config does not load", async () => {
  const h = await harness([], { keep_records_days: 7 });
  const config = path.join(h.home, "config.json");
  const given = fs.readFileSync(config, "utf8");
  try {
    const a = await closedRun(h, "A");
    const b = await closedRun(h, "B");
    age(h, a, 30);
    age(h, b, 30);
    const one = JSON.parse(h.cli("clean", a));
    assert.deepEqual(one.records_forgotten, [a], JSON.stringify(one));
    assert.equal(rows(h, a), 0, "the named run is forgotten");
    assert.equal(rows(h, b), 2, "the other, as old, is not");
    assert.ok(fs.existsSync(path.join(h.home, "runs", b)));
    assert.match(JSON.parse(h.cli("clean", "run_00000000")).error, /^unknown run run_00000000/);
    // A config that does not load (an edit in progress) forgets nothing, and the rest of the clean is still done.
    fs.writeFileSync(config, "{ not json");
    const kept = JSON.parse(h.cli("clean"));
    assert.match(kept.records_note, /^kept: relay's config did not load, so keep_records_days was not applied/, JSON.stringify(kept));
    assert.equal("records_forgotten" in kept, false);
    assert.ok(Array.isArray(kept.temp_dirs_removed), JSON.stringify(kept));
    assert.equal(rows(h, b), 2);
  } finally {
    fs.writeFileSync(config, given);
    await h.close();
  }
});

test("storage: a run is forgotten only once its directories are moved aside, and what could not be removed then goes at the next relay clean", async () => {
  const h = await harness([], { keep_records_days: 7 });
  const harnessHome = `${h.home}-harness`;
  let stuck = "";
  try {
    const a = await closedRun(h, "A");
    age(h, a, 30);
    const records = path.join(h.home, "runs", a);
    // Its harnesses' state cannot be moved: its records, moved first, are put back, and nothing is forgotten.
    fs.mkdirSync(path.join(harnessHome, a), { recursive: true });
    fs.chmodSync(harnessHome, 0o555);
    let cleaned = JSON.parse(h.cli("clean"));
    fs.chmodSync(harnessHome, 0o755);
    assert.deepEqual(cleaned.records_forgotten, [], JSON.stringify(cleaned));
    assert.match(cleaned.records_kept.join("\n"), new RegExp(`${a}: relay could not move ${path.join(harnessHome, a)} aside`));
    assert.equal(rows(h, a), 2, "the run is still in the registry");
    assert.ok(fs.existsSync(records), "with its records where they were");
    // Part of its records cannot be removed: the run is forgotten, and what is left of it is named.
    stuck = path.join(records, "stuck");
    fs.mkdirSync(stuck);
    fs.writeFileSync(path.join(stuck, "f"), "x");
    fs.chmodSync(stuck, 0o555);
    cleaned = JSON.parse(h.cli("clean"));
    const aside = path.join(h.home, "runs", `.forgotten-${a}`);
    assert.deepEqual(cleaned.records_forgotten, [a], JSON.stringify(cleaned));
    assert.match(cleaned.records_left.join("\n"), new RegExp(`${a}: .*${aside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`), JSON.stringify(cleaned));
    assert.equal(rows(h, a), 0);
    assert.equal(fs.existsSync(records), false);
    assert.equal(fs.existsSync(path.join(harnessHome, a)), false, "its harnesses' state went");
    // Once it can be, a later relay clean removes the rest.
    fs.chmodSync(path.join(aside, "stuck"), 0o755);
    stuck = "";
    cleaned = JSON.parse(h.cli("clean"));
    assert.ok(cleaned.temp_dirs_removed.includes(aside), JSON.stringify(cleaned));
    assert.equal(fs.existsSync(aside), false);
  } finally {
    for (const dir of [harnessHome, stuck, path.join(h.home, "runs")]) if (dir && fs.existsSync(dir)) fs.chmodSync(dir, 0o755);
    for (const name of fs.existsSync(path.join(h.home, "runs")) ? fs.readdirSync(path.join(h.home, "runs")) : []) {
      if (name.startsWith(".forgotten-") && fs.existsSync(path.join(h.home, "runs", name, "stuck"))) fs.chmodSync(path.join(h.home, "runs", name, "stuck"), 0o755);
    }
    await h.close();
  }
});

test("storage: a worker applies keep_records_days, as the person's config says now, once its session's turns are done, at most once a day", async () => {
  const tmp = shortTmp();
  const h = await harness([], { keep_records_days: 7 }, { TMPDIR: tmp });
  const stamp = path.join(h.home, "housekeeping");
  try {
    const old = await closedRun(h, "OLD");
    const later = await closedRun(h, "LATER");
    age(h, old, 30);
    fs.rmSync(stamp);
    const r = await h.call("ask", { target: "claude", message: "NOW" });
    const session = runOf(h, r.thread_id);
    await until(() => rows(h, old) === 0, 20000, "a worker to forget the old run");
    assert.equal(fs.existsSync(path.join(h.home, "runs", old)), false);
    await workersGone(h, session);
    // Within the day, no worker looks again.
    age(h, later, 30);
    await h.call("ask", { target: "claude", thread_id: r.thread_id, message: "AGAIN" });
    await workersGone(h, session);
    assert.equal(rows(h, later), 2, "the run aged since is left for the next day, or relay clean");
    // The next day, with keep_records_days taken out of the config: the session's run began with
    // it, but what a worker applies is the person's policy as it is now.
    const config = path.join(h.home, "config.json");
    const { keep_records_days: _, ...rest } = JSON.parse(fs.readFileSync(config, "utf8"));
    fs.writeFileSync(config, JSON.stringify(rest));
    fs.rmSync(stamp);
    await h.call("ask", { target: "claude", thread_id: r.thread_id, message: "THIRD" });
    await workersGone(h, session);
    assert.ok(fs.existsSync(stamp), "the worker did its housekeeping");
    assert.equal(rows(h, later), 2, "and forgot nothing");
  } finally {
    await h.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("storage: relay clean removes the temporary directories relay made and no longer needs, and none still in use", async () => {
  // Short, so that relay's own socket names fit in it: a Unix socket's path may not exceed 103 bytes.
  const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/rs-"));
  const h = await harness([], {}, { TMPDIR: tmp });
  const server = net.createServer();
  try {
    const sockets = path.join(h.env.HOME, ".relay-t", "s");
    fs.mkdirSync(sockets, { mode: 0o700, recursive: true });
    const dirIn = (parent: string, name: string) => {
      const dir = path.join(parent, name);
      fs.mkdirSync(dir, { mode: 0o700 });
      return dir;
    };
    const turnDir = (name: string) => dirIn(sockets, name);
    const hourAgo = (dir: string, minutes = 90) => fs.utimesSync(dir, new Date(Date.now() - minutes * 60_000), new Date(Date.now() - minutes * 60_000));
    const deadSocket = (dir: string) => {
      spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path.join(dir, "relay.sock"))}, () => process.kill(process.pid, "SIGKILL"))`]);
      assert.ok(fs.existsSync(path.join(dir, "relay.sock")), "the dead socket is left behind");
      hourAgo(dir);
    };
    // A broker whose worker died: its socket is still there, with nothing listening. And a probe's
    // decoy of one, left the same way.
    const dead = turnDir("relay-turn-dead01");
    deadSocket(dead);
    const decoy = turnDir("relay-probe-dead02");
    deadSocket(decoy);
    // One that never got its socket, an hour ago; and one being set up now.
    const never = turnDir("relay-turn-never1");
    hourAgo(never);
    const starting = turnDir("relay-turn-start1");
    // A broker still serving its turn, however old its directory.
    const live = turnDir("relay-turn-live01");
    await new Promise<void>((r) => server.listen(path.join(live, "relay.sock"), () => r()));
    hourAgo(live);
    // Not a name relay makes there.
    const other = turnDir("relay-turn-x");
    hourAgo(other);
    // A confinement probe's scratch directory left by a crash; one in use now; and someone else's of a like name.
    const scratch = dirIn(tmp, "relay-probe-scr001");
    hourAgo(scratch);
    const privateScratch = dirIn(path.dirname(sockets), "relay-probe-prv001");
    hourAgo(privateScratch);
    const probing = dirIn(tmp, "relay-probe-now001");
    const lookalike = dirIn(tmp, "relay-probe-test-abc123");
    hourAgo(lookalike);
    // A confined turn's private temporary directory, however old: relay cannot tell yet whether its turn still runs.
    const turnTmp = dirIn(tmp, "relay-tmp-abc123");
    hourAgo(turnTmp, 600);
    // A job identity file's build directory left by a crash, and one being written now.
    const trees = path.join(`${h.home}-worktrees`, "run_00000000");
    fs.mkdirSync(trees, { recursive: true });
    const build = path.join(trees, ".j_00000000.relay.0123456789abcdef");
    fs.mkdirSync(build);
    fs.writeFileSync(path.join(build, "context.json"), "{}");
    hourAgo(build, 20);
    const building = path.join(trees, ".j_00000001.relay.fedcba9876543210");
    fs.mkdirSync(building);

    const cleaned = JSON.parse(h.cli("clean"));
    const removed = [build, dead, decoy, never, scratch, privateScratch];
    assert.deepEqual([...cleaned.temp_dirs_removed].sort(), removed.sort(), JSON.stringify(cleaned));
    for (const gone of removed) assert.equal(fs.existsSync(gone), false, `${gone} is removed`);
    for (const left of [starting, live, other, probing, lookalike, turnTmp, building]) assert.ok(fs.existsSync(left), `${left} is left alone`);
  } finally {
    server.close();
    await h.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("storage: settled turns' private temp directories are swept only with registry identity and no live processes", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/rt-"));
  const h = await harness([], {}, { TMPDIR: tmp });
  try {
    const r = await h.call("ask", { target: "claude", message: "temp sweep" });
    const node = h.sql("SELECT * FROM nodes WHERE id = ?", r.thread_id)[0];
    await until(() => !h.sql("SELECT pid FROM relay_procs WHERE node_id = ?", node.id).some((p) => alive(p.pid)), 10000, "worker process to exit");
    // Seed the registry identity a confined launch records. On the pre-fix build the fixture adds
    // these columns so the regression reaches the sweep, rather than failing on missing schema.
    const cols = h.sql("PRAGMA table_info(turns)").map((c) => c.name);
    for (const [name, type] of [["tmp_dir", "TEXT"], ["tmp_dev", "INTEGER"], ["tmp_ino", "INTEGER"]]) {
      if (!cols.includes(name)) h.sql(`ALTER TABLE turns ADD COLUMN ${name} ${type}`);
    }
    const make = (name: string, status?: string) => {
      const dir = path.join(tmp, `relay-tmp-${name}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "keep"), name);
      if (status) {
        const st = fs.lstatSync(dir);
        h.sql("INSERT INTO turns (node_id, source, body, access, status, created_at, tmp_dir, tmp_dev, tmp_ino) VALUES (?, 'test', '', 'write', ?, 0, ?, ?, ?)", node.id, status, dir, st.dev, st.ino);
      }
      return dir;
    };
    const settled = ["done", "failed", "cancelled", "lost"].map((s) => make(s, s));
    const running = make("running", "running");
    const queued = make("queued", "queued");
    const unknown = make("unknown");
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "outside");
    fs.symlinkSync(outside, path.join(settled[0], "outside-link"));
    const link = path.join(tmp, "relay-tmp-link");
    fs.symlinkSync(outside, link);
    const replacement = make("replaced", "done");
    fs.renameSync(replacement, path.join(tmp, "original-directory"));
    fs.mkdirSync(replacement);
    const cleaned = JSON.parse(h.cli("clean"));
    for (const dir of settled) assert.ok(cleaned.temp_dirs_removed?.includes(dir), `${dir} is swept: ${JSON.stringify(cleaned)}`);
    for (const dir of [running, queued, unknown, link, replacement]) assert.ok(fs.lstatSync(dir), `${dir} is left alone`);
    assert.equal(read(path.join(outside, "keep")), "outside");
    // Both left in the temporary directory (the unknown one, and the replacement of a recorded one) make one line.
    assert.match(h.cli("doctor"), /temp dirs +WARNING: 2 directories in \S+ \(relay-tmp-replaced, relay-tmp-unknown\) cannot be matched to a turn in the registry; left alone\./);
    // A settled turn with a still-live, start-time-matched agent must keep its directory.
    const live = make("live", "done");
    h.sql("UPDATE nodes SET agent_pid = ?, agent_start = ? WHERE id = ?", process.pid, procStart(process.pid), node.id);
    assert.ok(!JSON.parse(h.cli("clean")).temp_dirs_removed?.includes(live));
    assert.ok(fs.existsSync(live));
    // A reused PID is not the recorded process.
    h.sql("UPDATE nodes SET agent_start = 'a different start' WHERE id = ?", node.id);
    assert.ok(JSON.parse(h.cli("clean")).temp_dirs_removed?.includes(live));
    h.sql("UPDATE nodes SET agent_pid = NULL, agent_start = NULL WHERE id = ?", node.id);
  } finally {
    await h.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("storage: secrets relay makes for a turn, in no environment relay itself has, are kept out by their shape, and code is not cut", async () => {
  const dir = scratchDir("shapes");
  try {
    const file = path.join(dir, "agent.log");
    // As relay hands them to a confined agent: a per-turn proxy token and bridge secret.
    const proxyToken = "pT0k3n_per-turn_AbCdEf123456";
    const bridge = "b1dg3S3cr3t-QwErTyUiOp_AsDfGhJk12";
    const apiKey = `k3y-${"Z".repeat(20)}9`;
    const bearer = "abc123DEF456ghi789";
    const secrets = [proxyToken, bridge, apiKey, bearer, Buffer.from(`relay:${proxyToken}`).toString("base64")];
    const written = [
      `HTTPS_PROXY=http://relay:${proxyToken}@127.0.0.1:53111`,
      `{"relay_bridge_secret":"${bridge}"}`,
      `RELAY_BRIDGE_SECRET=${bridge}`,
      `{"type":"item","text":"{\\"api_key\\": \\"${apiKey}\\"}"}`,
      `Proxy-Authorization: Basic ${Buffer.from(`relay:${proxyToken}`).toString("base64")}`,
      `curl -H "Authorization: Bearer ${bearer}" https://example.com`,
    ];
    const code = [
      "const API_KEY = process.env.API_KEY;",
      "API_KEY=process.env.API_KEY",
      "max_tokens=4096 and SOME_TOKEN=short1",
      "postgres://user:${PASSWORD}@db.local/x and https://user:<password>@host/",
      "ssh://git@github.com/owner/relay.git",
      "AUTH_DIR=/a/path/not/a/secret1234567",
    ];
    // No environment given: these are in none relay reads.
    const { log } = openAgentLog(file, { env: {} });
    for (const l of [...written, ...code]) log.write(`${l}\n`);
    log.end();
    const text = read(file);
    for (const s of secrets) assert.equal(text.includes(s), false, `${s} was kept out:\n${text}`);
    assert.equal(text.match(/\[redacted\]/g)?.length, written.length, text);
    for (const l of code) assert.ok(text.includes(`${l}\n`), `left as it was: ${l}\n${text}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: the redactor leaves ordinary keys alone, cuts a header's credentials in JSON and TOML too, and takes time linear in a crafted line's length", async () => {
  const { redactor } = await import("../dist/core/secrets.js");
  const cut = redactor({});
  // Data whose names end in _key or _token without saying it is a secret, as an agent's reply can carry them.
  for (const ordinary of [
    "cache_key=v2-linux-node20-abc123def", `"primary_key": "user_id_1234567890"`, `"idempotency_key": "order-2026-10-17-abc123"`,
    "SORT_KEY=created_at_2026_10_17", "RUN_KEY=run_7be08fbb12345678", `"next_page_token": "CiAKGjBpNDd2Nmp2Zml2cXRlMjAxNjEyMDQ"`,
    "sk-abcdefghijklmnopqrstuvwxyzabcdefgh",
    // A secret's name next to a URL, a path or a value made of words: the public fields of a
    // Google client or service-account JSON, Auth.js's AUTH_URL, a token endpoint, an auth mode.
    `"token_uri": "https://oauth2.googleapis.com/token"`, `"auth_uri": "https://accounts.google.com/o/oauth2/auth"`,
    `"auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs"`, "AUTH_URL=http://localhost:3000/api/auth",
    "TOKEN_ENDPOINT=https://login.example.com/oauth2/v2.0/token", "AUTH_MODE=oauth2_device_flow_v2", `"auth_type": "service_account_v1_json"`,
    "AUTH_FILE=secrets/token_v2.json", "SECRET_STORE=AWS_SECRETS_MANAGER_V2", `"token_format": "Jwt_Rs256_Signed"`,
  ]) assert.equal(cut(ordinary), ordinary);
  const bearer = "abcdefghijklmnop1234";
  for (const secret of [
    `{"headers":{"Authorization":"Bearer ${bearer}"}}`, `http_headers = { Authorization = "Bearer ${bearer}" }`,
    `{"text":"{\\"Authorization\\": \\"Bearer ${bearer}\\"}"}`, `{"proxy-authorization":"Basic ${Buffer.from(`relay:${PROXY_PASS}`).toString("base64")}"}`,
    `"signing_key": "k3yabcdefghijklmnop1"`, `"access_token": "ya29abcdefghijk123456"`, `sk-proj-${"a".repeat(30)}1234`,
    // Tokens with separators in them are still cut: a UUID-shaped key, words broken by digits,
    // base64url, and a password after a user name.
    `"api_key": "3f2a9c1e-4b5d-4e6f-8a7b-9c0d1e2f3a4b"`, `SOME_TOKEN=${OTHER}`, "RELAY_BRIDGE_SECRET=Qw3rTy_uI0p-AsDfGhJk_L9zXcV",
    "AUTH=deploy:p4ssw0rd-x9y8z7w6",
  ]) {
    const out = cut(secret);
    assert.equal(out.match(/\[redacted\]/g)?.length, 1, `${secret} -> ${out}`);
  }
  // Lines an agent's output can hold, each 1 MB, built so that a pattern which scanned to the end of
  // a run from every place it could start would take minutes (quadratic); linear, they take milliseconds.
  const MB = 1 << 20;
  const crafted = ["a.", "sk-", "x-y-", "a://", "Authorization: ", "github_pat_", "a\" "].map((unit) => unit.repeat(Math.ceil(MB / unit.length)));
  crafted.push(`a://b:${"c:".repeat(MB / 2)}`, JSON.stringify({ method: "item/completed", params: { item: { aggregatedOutput: "x-y-".repeat(MB / 4) } } }));
  const started = Date.now();
  for (const line of crafted) cut(line);
  const ms = Date.now() - started;
  assert.ok(ms < 10_000, `${crafted.length} crafted lines of 1 MB took ${ms} ms`);
});

test("storage: the redactor reads an assignment chained after another, TOML's, YAML's and a Python dict's, and an Authorization header of any scheme", async () => {
  const { redactor } = await import("../dist/core/secrets.js");
  const cut = redactor({});
  const t = "Zx8qL2mN9pR4tV7wY1bC";
  for (const [given, kept] of [
    // A name that is no secret's does not swallow the assignment after it.
    [`kubectl create secret generic x --from-literal=API_TOKEN=${t}`, "kubectl create secret generic x --from-literal=API_TOKEN=[redacted]"],
    [`gcloud run deploy --set-env-vars=DB_PASSWORD=${t}`, "gcloud run deploy --set-env-vars=DB_PASSWORD=[redacted]"],
    [`docker build --build-arg=NPM_TOKEN=${t} .`, "docker build --build-arg=NPM_TOKEN=[redacted] ."],
    [`mode=x:SECRET_KEY=${t}`, "mode=x:SECRET_KEY=[redacted]"], [`FOO=a.b/API_TOKEN=${t}`, "FOO=a.b/API_TOKEN=[redacted]"],
    // As a Claude Bash tool_use has it in agent.log and an activity: inside a JSON string.
    [`Bash: {\\"command\\":\\"kubectl --from-literal=API_TOKEN=${t}\\"}`, `Bash: {\\"command\\":\\"kubectl --from-literal=API_TOKEN=[redacted]\\"}`],
    [`{"command":"docker build --build-arg=NPM_TOKEN=${t} ."}`, `{"command":"docker build --build-arg=NPM_TOKEN=[redacted] ."}`],
    // TOML and INI with spaces around the = where the value is quoted; YAML; a Python dict.
    [`api_key = "${t}"`, `api_key = "[redacted]"`], [`password = '${t}'`, `password = '[redacted]'`],
    [`password: ${t}`, "password: [redacted]"], [`  client_secret: "${t}"`, `  client_secret: "[redacted]"`], [`{'api_key': '${t}'}`, `{'api_key': '[redacted]'}`],
    // Any scheme's credentials when they look like a token, or none; Bearer, Basic and Token's at 8 characters.
    ["Authorization: ApiKey abcdefgh12345678abcdefgh", "Authorization: ApiKey [redacted]"],
    ["Authorization: Bot MTk4NjIyNDgzNDcxOTI1MjQ4.Cl2FMQ.ZnCjm1XVW7vRze4b7Cq4se7kKWs", "Authorization: Bot [redacted]"],
    ["Authorization: 0123456789abcdef0123456789abcdef", "Authorization: [redacted]"], [`"Authorization": "abcdefgh12345678abcdefgh"`, `"Authorization": "[redacted]"`],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [redacted]"],
    // A URL's password however short.
    ["postgres://app:hunter2@db.internal/app", "postgres://app:[redacted]@db.internal/app"],
  ]) assert.equal(cut(given), kept);
  for (const ordinary of [
    // Not a token: a name that is no secret's, an unquoted value after spaces (code), a time, an identifier, prose after a header's name.
    "--from-literal=MODE=fast_mode_v2", "token = getAccessTokenFromProvider(x)", `"token_expires": "2026-10-19T03:00:00Z"`,
    "token=getAccessTokenFromEnvironment", "Authorization: required for this endpoint", "Authorization: Bearer $TOKEN", "Authorization: Bearer short",
    `Authorization: Digest username="u", realm="r"`, "password: correct horse", "https://user:${PASS}@host/",
  ]) assert.equal(cut(ordinary), ordinary);
  // A bridge secret is 24 random bytes in base64url, which can hold no digit: it is cut all the same.
  for (let i = 0; i < 2000; i++) {
    const secret = crypto.randomBytes(24).toString("base64url");
    for (const line of [`RELAY_BRIDGE_SECRET=${secret}`, `{"relay_bridge_secret":"${secret}"}`]) assert.equal(cut(line).includes(secret), false, line);
  }
  assert.equal(cut("RELAY_BRIDGE_SECRET=wHwTFAjJcCL_RRWEOhmBgNRzUKQRNEb_"), "RELAY_BRIDGE_SECRET=[redacted]");
  // Linear on lines crafted against the assignment rule, as the earlier ones are against the rest.
  const MB = 1 << 20;
  const started = Date.now();
  for (const unit of ["a=", "aTOKEN", "TOKEN=", "a_", "\\", "a: ", "a='", "TOKEN: ", "p': '", "Authorization=", "Authorization: x "]) cut(unit.repeat(Math.ceil(MB / unit.length)));
  const ms = Date.now() - started;
  assert.ok(ms < 10_000, `crafted lines of 1 MB took ${ms} ms`);
});

test("storage: a variable whose name may be a secret's is cut by value only when its value looks like a token, and one whose name ends in a secret's word whatever it is", async () => {
  const { redactor } = await import("../dist/core/secrets.js");
  const cut = redactor({
    GCM_CREDENTIAL_STORE: "keychain", AWS_CREDENTIAL_EXPIRATION: "2026-10-19T03:00:00Z", NPM_CONFIG_CACHE_KEY: "frontend", GIT_AUTH_MODE: "credential-manager",
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", DB_PASSWORD: "sunshine-pony", APP_SECRET: "hunterhunter",
  });
  assert.equal(
    cut("Store it in the macOS keychain, it expires 2026-10-19T03:00:00Z; the frontend tests pass with credential-manager."),
    "Store it in the macOS keychain, it expires 2026-10-19T03:00:00Z; the frontend tests pass with credential-manager.",
  );
  assert.equal(cut("key AKIAIOSFODNN7EXAMPLE, password sunshine-pony, secret hunterhunter"), "key [redacted], password [redacted], secret [redacted]");
});

test("storage: what relay records of a turn's activity and of its error keeps out a token in relay's environment", async () => {
  const h = await harness([
    { match: "STEP-ACTIVITY", steps: [{ emit: { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: `curl -H "X-Key: ${OTHER}" https://example.com` } }] } } }, { reply: "acted" }] },
    { match: "STEP-FAILURE", steps: [{ fail: `the service said ${OTHER} is not valid` }] },
  ], {}, { SOME_SERVICE_TOKEN: OTHER });
  try {
    const acted = await h.call("ask", { target: "claude", message: "STEP-ACTIVITY" });
    assert.equal(acted.reply, "acted", JSON.stringify(acted));
    const activity = String(h.sql("SELECT activity FROM turns WHERE node_id = ?", acted.thread_id)[0].activity);
    assert.match(activity, /^\$ curl -H "X-Key: \[redacted\]"/, activity);
    const failed = await h.call("ask", { target: "claude", message: "STEP-FAILURE" });
    const error = String(h.sql("SELECT error FROM turns WHERE node_id = ?", failed.thread_id)[0].error);
    assert.match(error, /the service said \[redacted\] is not valid/, error);
    assert.equal(JSON.stringify(failed).includes(OTHER), false, JSON.stringify(failed));
  } finally {
    await h.close();
  }
});

test("storage: the commands an agent was refused keep out a token, in what relay records and in what it returns as blocked", async () => {
  const refused = `curl -H "Authorization: Bearer ${GH}" -H "X: ${OTHER}" https://example.com`;
  const h = await harness([{ match: "REFUSED", steps: [{ request: refused }, { reply: "done without it" }] }], { escalation: false }, { GH_TOKEN: GH, SOME_SERVICE_TOKEN: OTHER });
  try {
    const codex = await h.instance({ args: ["--host", "codex"] });
    const r = await codex.call("ask", { target: "claude", message: "REFUSED" });
    assert.equal(r.reply, "done without it", JSON.stringify(r));
    assert.equal(r.blocked?.length, 1, JSON.stringify(r));
    assert.match(r.blocked[0], /^\$ curl -H "Authorization: Bearer \[redacted\]" -H "X: \[redacted\]"/, r.blocked[0]);
    const denials = String(h.sql("SELECT denials FROM turns WHERE node_id = ?", r.thread_id)[0].denials);
    const status = await codex.call("status", { id: r.thread_id });
    for (const [what, text] of [["result", JSON.stringify(r)], ["turn's denials", denials], ["status", JSON.stringify(status)]] as const) {
      assert.equal(text.includes(GH) || text.includes(OTHER), false, `the ${what} keeps the tokens out:\n${text}`);
    }
    assert.match(denials, /\[redacted\]/);
  } finally {
    await h.close();
  }
});

test("storage: a token is cut from an activity and a refused command as the agent gave it, before either is clipped or escaped", async () => {
  // GH has GitHub's shape, cut by it alone: no environment here holds it.
  const long = `curl -sS "https://api.github.com/repos/owner/relay/actions/runs?per_page=100&status=completed" -H "Accept: application/vnd.github+json" -u me:${GH} | jq .`;
  assert.ok(long.indexOf(GH) < 160 && long.indexOf(GH) + GH.length > 160, "the token crosses the point an activity is clipped at");
  // A token that starts a line of a command, which escaping would join to the text before it.
  const heredoc = `cat > creds <<EOF\n${GH}\nEOF`;
  const bash = (command: string) => ({ emit: { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } } });
  const h = await harness([
    { match: "LONG-ACTIVITY", steps: [bash(long), { request: heredoc }, { reply: "one" }] },
    { match: "LINES-ACTIVITY", steps: [bash(heredoc), { request: long }, { reply: "two" }] },
  ], { escalation: false });
  try {
    const codex = await h.instance({ args: ["--host", "codex"] });
    for (const message of ["LONG-ACTIVITY", "LINES-ACTIVITY"]) {
      const r = await codex.call("ask", { target: "claude", message });
      assert.equal(r.blocked?.length, 1, JSON.stringify(r));
      const turn = h.sql("SELECT activity, denials FROM turns WHERE node_id = ?", r.thread_id)[0];
      for (const [what, text] of [["activity", String(turn.activity)], ["refused command", String(turn.denials)], ["blocked", JSON.stringify(r.blocked)]] as const) {
        assert.equal(text.includes(GH.slice(0, 8)), false, `${message}: the ${what} keeps no part of the token:\n${text}`);
        assert.match(text, /\[redacted\]/, `${message}: ${what}`);
      }
      const shown = message === "LONG-ACTIVITY" ? String(turn.activity) : r.blocked[0];
      assert.match(shown, /-u me:\[redacted\] \| jq \.$/, "the rest of the long command is kept, unclipped once the token is cut");
      const lines = message === "LONG-ACTIVITY" ? r.blocked[0] : String(turn.activity);
      assert.equal(lines, "$ (3 lines, shown escaped) cat > creds <<EOF\\n[redacted]\\nEOF", "its lines still show");
    }
  } finally {
    await h.close();
  }
});

test("storage: an activity is cut of a secret before it is clipped, for each kind of tool call", async () => {
  const { activityOf } = await import("../dist/backends/types.js");
  // The key crosses the 160 characters an activity is clipped at; once it is cut, the line fits.
  const pad = "x".repeat(120);
  const key = `sk-ant-api03-${"Q7r8".repeat(10)}`;
  for (const [tool, input] of [
    ["commandExecution", { command: `echo ${pad} ${key}` }], ["command_execution", { command: ["sh", "-c", `echo ${pad} ${key}`] }],
    ["fileChange", { changes: [{ path: `/tmp/${pad}/${key}.txt` }] }], ["WebFetch", { url: `https://example.com/${pad}?key=${key}` }],
    ["webSearch", { query: `${pad} ${key}` }], ["Grep", { pattern: `${pad}|${key}` }], ["Read", { file_path: `/tmp/${pad}/${key}` }],
  ] as const) {
    const text = activityOf(tool, input as Record<string, unknown>)!;
    assert.equal(text.includes(key.slice(0, 10)), false, `${tool}: ${text}`);
    assert.match(text, /\[redacted\]/, `${tool}: ${text}`);
  }
});

test("storage: an error that refuses a turn's launch keeps out a key in it, whichever Codex backend refused it", async () => {
  const key = `sk-proj-${"Ab1Cd2Ef3Gh4".repeat(3)}`;
  const redirect = { STUB_CODEX_EFFECTIVE: JSON.stringify({ openai_base_url: `https://gw:${key}@proxy.example/v1` }) };
  for (const backend of ["app-server", "exec"]) {
    const h = await harness([{ steps: [{ reply: "ok" }] }], { codex_backend: backend });
    try {
      const root = await h.instance({ env: redirect });
      const r = await root.call("delegate", { target: "codex", task: "x", mode: "read", background: false });
      assert.equal(r.status, "failed", `${backend}: ${JSON.stringify(r)}`);
      assert.match(r.error, /openai_base_url is set/, backend);
      const error = String(h.sql("SELECT error FROM turns WHERE node_id = ?", r.job_id)[0].error);
      for (const [what, text] of [["result", JSON.stringify(r)], ["turn's error", error]] as const) {
        assert.equal(text.includes(key), false, `${backend}: the ${what} keeps the key out:\n${text}`);
      }
    } finally {
      await h.close();
    }
  }
});

test("storage: relay's own diagnostic logs keep out a token in its environment", async () => {
  const dir = scratchDir("diag-redact");
  try {
    const file = path.join(dir, "elicitation.log");
    const storage = path.join(import.meta.dirname, "..", "dist", "core", "storage.js");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { appendLog } from ${JSON.stringify(storage)}; console.log(appendLog(process.argv[1], "the host answered " + process.env.SOME_SERVICE_TOKEN + "\\n"));`, file], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SOME_SERVICE_TOKEN: OTHER }, encoding: "utf8",
    });
    assert.equal(r.stdout.trim(), "null", r.stderr);
    assert.equal(read(file), "the host answered [redacted]\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: a prompt's copy and a discussion's transcript keep out a token in relay's environment; the agent is sent it as given", async () => {
  // GH has a vendor's shape, which is cut whatever the environment; OTHER has none, and is cut only because relay's environment holds it.
  const h = await harness([{ target: "codex", turn: 1, steps: [{ reply: `I see ${GH} and ${OTHER} too.\nAGREE: done` }] }], {}, { GH_TOKEN: GH, SOME_SERVICE_TOKEN: OTHER });
  try {
    const r = await h.call("discuss", { target: "codex", topic: `the tokens ${GH} and ${OTHER}`, message: `Look at ${GH} and ${OTHER}.\nAGREE: done` });
    assert.equal(r.outcome, "agree", JSON.stringify(r));
    const transcript = read(r.transcript_path);
    assert.equal(transcript.includes(GH) || transcript.includes(OTHER), false, transcript);
    assert.match(transcript, /Topic: the tokens \[redacted\] and \[redacted\]/);
    assert.match(transcript, /I see \[redacted\] and \[redacted\] too\./);
    assert.ok(r.participant, JSON.stringify(r));
    const prompts = h.sql("SELECT prompt_path FROM turns WHERE node_id = ?", r.participant).map((t) => read(t.prompt_path as string));
    assert.ok(prompts.length && prompts.every((p) => p.length > 0), "the prompt's copy was kept");
    for (const p of prompts) assert.equal(p.includes(GH) || p.includes(OTHER), false, p);
    assert.match(prompts.join("\n"), /\[redacted\] and \[redacted\]/);
    assert.ok(h.log().some((e) => JSON.stringify(e).includes(GH) && JSON.stringify(e).includes(OTHER)), "the agent was sent the prompt as the caller gave it");
  } finally {
    await h.close();
  }
});

test("storage: on a full disk, the agent's log, a record and relay's own logs say so, and none throws", async (t) => {
  const { appendLog, keepRecord, takeDiagnosticProblems } = await import("../dist/core/storage.js");
  const dir = scratchDir("full");
  try {
    // What writes get from a disk with no room left: the tests cannot mount a full one.
    const full = (p?: unknown) => Object.assign(new Error(`ENOSPC: no space left on device, write${typeof p === "string" ? ` '${p}'` : ""}`), { code: "ENOSPC", errno: -28, syscall: "write", ...(typeof p === "string" ? { path: p } : {}) });
    t.mock.method(fs, "writeSync", () => {
      throw full();
    });
    t.mock.method(fs, "appendFileSync", (p: unknown) => {
      throw full(p);
    });
    t.mock.method(fs, "writeFileSync", (p: unknown) => {
      throw full(p);
    });
    const file = path.join(dir, "agent.log");
    const { log, warnings } = openAgentLog(file);
    log.write("a line\n");
    log.end();
    assert.deepEqual(warnings(), [`relay could not write the agent's log ${file} (ENOSPC: no space left on device, write), so the log may be missing or incomplete, though the turn itself went on: the disk it is on is full; free space there`]);
    const final = path.join(dir, "final-1.md");
    // Written whole beside it first (keepRecord), so the error names that file.
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(String(keepRecord(final, "the answer", { consequence: "the final message is kept only in the registry" })), new RegExp(`^relay could not write ${esc(final)} \\(ENOSPC: no space left on device, write '${esc(dir)}/\\.final-1\\.md\\.\\d+\\.[0-9a-f]{8}\\.tmp'\\), so the final message is kept only in the registry: the disk it is on is full; free space there$`));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "nothing is left beside it");
    const notices = path.join(dir, "notices.log");
    const unlogged = `relay could not write ${notices} (ENOSPC: no space left on device, write '${notices}'), so an entry of that diagnostic log is missing, and nothing else is affected: the disk it is on is full; free space there`;
    assert.equal(appendLog(notices, "{}\n"), unlogged);
    // Said once, where a person sees it: a relay server's next result, a worker's next turn.
    appendLog(notices, "{}\n");
    assert.deepEqual(takeDiagnosticProblems(), [unlogged]);
    assert.deepEqual(takeDiagnosticProblems(), []);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: a run's directory left aside by a relay killed while forgetting it is put back while the registry lists the run, whatever the config", async () => {
  const h = await harness();
  try {
    const a = await closedRun(h, "A");
    const records = path.join(h.home, "runs", a);
    const harnessState = path.join(`${h.home}-harness`, a);
    fs.mkdirSync(harnessState, { recursive: true });
    // As the transaction that forgot it left them, had it not committed.
    const asides = [records, harnessState].map((d) => path.join(path.dirname(d), `.forgotten-${a}`));
    fs.renameSync(records, asides[0]);
    fs.renameSync(harnessState, asides[1]);
    const cleaned = JSON.parse(h.cli("clean"));
    assert.deepEqual(cleaned.temp_dirs_removed, [], JSON.stringify(cleaned));
    for (const d of [records, harnessState]) assert.ok(fs.existsSync(d), `${d} is back`);
    for (const d of asides) assert.equal(fs.existsSync(d), false);
    assert.equal(rows(h, a), 2);
  } finally {
    await h.close();
  }
});

const RETENTION = path.join(import.meta.dirname, "..", "dist", "core", "retention.js");
/** keep_records_days applied as a worker's housekeeping applies it: without relay clean's reaping first. */
function forgetNow(h: Harness, days: number): { forgotten: string[]; kept: string[]; left: string[] } {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { forgetOldRuns } from ${JSON.stringify(RETENTION)}; console.log(JSON.stringify(forgetOldRuns(${days})));`], { env: h.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
/** Resolves once `child` has printed `text`. */
const said = (child: ChildProcess, text: string) => new Promise<void>((resolve, reject) => {
  let out = "";
  child.stdout!.on("data", (d) => {
    out += String(d);
    if (out.includes(text)) resolve();
  });
  child.once("exit", (code) => reject(new Error(`exited (${code}) before saying ${text}: ${out}`)));
});
const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", resolve)));

test("storage: keep_records_days keeps a run with an approval request waiting, a worktree left, or a branch relay cannot look for", async () => {
  const h = await harness([], { keep_records_days: 7 });
  const scratch = scratchDir("held");
  try {
    const pending = await closedRun(h, "P");
    const tree = await closedRun(h, "T");
    const broken = await closedRun(h, "B");
    const unmounted = await closedRun(h, "U");
    const removed = await closedRun(h, "R");
    const node = (run: string) => h.sql("SELECT id FROM nodes WHERE run_id = ?", run)[0].id as string;
    h.sql("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES ('q_0000aaaa', ?, ?, 'command', 'run something', 'pending', ?)", pending, node(pending), Date.now());
    const worktree = path.join(scratch, "tree");
    fs.mkdirSync(worktree);
    h.sql("UPDATE nodes SET worktree = ? WHERE run_id = ?", worktree, tree);
    // Not a repository at all: git fails there (exit 128), which says nothing of the branch.
    const notRepo = path.join(scratch, "not-a-repo");
    fs.mkdirSync(notRepo);
    h.sql("UPDATE nodes SET branch = 'relay/j_0000beef', repo = ? WHERE run_id = ?", notRepo, broken);
    // Neither the repository nor the directory it was in: a volume not mounted, say.
    h.sql("UPDATE nodes SET branch = 'relay/j_0000beef', repo = ? WHERE run_id = ?", path.join(scratch, "volume", "repo"), unmounted);
    // An unavailable repository under an existing parent still does not prove deletion.
    h.sql("UPDATE nodes SET branch = 'relay/j_0000beef', repo = ? WHERE run_id = ?", path.join(scratch, "deleted-repo"), removed);
    for (const run of [pending, tree, broken, unmounted, removed]) age(h, run, 30);
    const r = forgetNow(h, 7);
    assert.deepEqual(r.forgotten, [], JSON.stringify(r));
    const kept = (run: string) => r.kept.find((k) => k.startsWith(`${run}: `)) ?? "";
    assert.equal(kept(pending), `${pending}: it has an approval request waiting`);
    assert.equal(kept(tree), `${tree}: ${node(tree)} still has its worktree (${worktree})`);
    assert.match(kept(broken), new RegExp(`^${broken}: relay could not check whether ${node(broken)}'s branch relay/j_0000beef is still in \\S+not-a-repo \\(.*not a git repository.*\\), so the run is kept until it can$`), kept(broken));
    assert.match(kept(unmounted), /absence does not establish deletion/, kept(unmounted));
    assert.match(kept(removed), /absence does not establish deletion/, kept(removed));
    for (const run of [pending, tree, broken, unmounted, removed]) assert.equal(rows(h, run), 2, `${run} is still in the registry`);
  } finally {
    await h.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("storage: keep_records_days keeps a run whose owner may still run, as adopt counts it, or with a transfer waiting, and a forgotten run's transfer authorizations go with it", async () => {
  const h = await harness([], { keep_records_days: 7 });
  const adoptions = path.join(h.home, "adoptions");
  try {
    const legacy = await closedRun(h, "L");
    const waiting = await closedRun(h, "W");
    const forgotten = await closedRun(h, "F");
    // An owner with no token or start time, as an earlier relay recorded one: this test's process, still running.
    h.sql("UPDATE runs SET root_token = NULL, root_start = NULL, root_pid = ? WHERE id = ?", process.pid, legacy);
    fs.mkdirSync(adoptions, { mode: 0o700 });
    const ticket = (run: string, to: string, suffix: string, minutesAgo: number) => {
      const at = Date.now() - minutesAgo * 60_000;
      const file = path.join(adoptions, `${run}-${to}.json${suffix}`);
      fs.writeFileSync(file, JSON.stringify({ run, to, previous_owner: "0".repeat(64), approved_at: at }), { mode: 0o600 });
      fs.utimesSync(file, new Date(at), new Date(at));
      return file;
    };
    const live = ticket(waiting, "a".repeat(24), "", 1);
    const used = ticket(forgotten, "b".repeat(24), ".used", 60);
    const expired = ticket(forgotten, "c".repeat(24), "", 60);
    for (const run of [legacy, waiting, forgotten]) age(h, run, 30);
    const r = forgetNow(h, 7);
    assert.deepEqual(r.forgotten, [forgotten], JSON.stringify(r));
    assert.match(r.left.join("\n"), /deferred while runs are active/, JSON.stringify(r));
    const kept = (k: string[], run: string) => k.find((x) => x.startsWith(`${run}: `)) ?? "";
    assert.equal(kept(r.kept, legacy), `${legacy}: its session is still open`);
    assert.equal(kept(r.kept, waiting), `${waiting}: a transfer of it to another session, which relay adopt authorized, is waiting to be taken up`);
    assert.equal(fs.existsSync(used), false, "a forgotten run's authorization taken up goes with it");
    assert.equal(fs.existsSync(expired), false, "and one never taken up");
    assert.ok(fs.existsSync(live), "another run's is left alone");
    // Where relay cannot look for transfers, a run that may have one is kept, saying why.
    fs.chmodSync(adoptions, 0o000);
    try {
      const again = forgetNow(h, 7);
      assert.deepEqual(again.forgotten, [], JSON.stringify(again));
      assert.match(kept(again.kept, waiting), new RegExp(`^${waiting}: relay could not look for transfers of it that relay adopt authorized in \\S+adoptions \\(EACCES`), JSON.stringify(again));
    } finally {
      fs.chmodSync(adoptions, 0o700);
    }
    for (const run of [legacy, waiting]) assert.equal(rows(h, run), 2, `${run} is still in the registry`);
  } finally {
    await h.close();
  }
});

test("storage: keep_records_days keeps a run with login-store entries relay quarantined, as they were, until that directory is removed", async () => {
  const h = await harness([], { keep_records_days: 7 });
  try {
    const run = await closedRun(h, "Q");
    const quarantine = path.join(h.home, "quarantine", run);
    const dir = path.join(quarantine, "j_00000000", "1");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // What a harness left at its token's name: a link, which relay moved here without following it.
    fs.symlinkSync("/etc/hosts", path.join(dir, "auth.json"));
    age(h, run, 30);
    const r = forgetNow(h, 7);
    assert.deepEqual(r.forgotten, [], JSON.stringify(r));
    assert.equal(r.kept.find((k) => k.startsWith(`${run}: `)), `${run}: relay quarantined login-store entries of it in ${quarantine}, which its records explain; delete that directory once you have looked at it`);
    assert.equal(rows(h, run), 2, "the run is still in the registry");
    assert.ok(fs.lstatSync(path.join(dir, "auth.json")).isSymbolicLink(), "and what was quarantined is left as it was");
    fs.rmSync(quarantine, { recursive: true });
    assert.deepEqual(forgetNow(h, 7).forgotten, [run], "once the person has removed it, the run goes");
  } finally {
    await h.close();
  }
});

test("storage: relay adopt's authorization that cannot be written says why and what to do, and authorizes nothing", async () => {
  const h = await harness();
  const adoptions = path.join(h.home, "adoptions");
  try {
    const run = await closedRun(h, "A");
    const to = "d".repeat(24);
    fs.mkdirSync(adoptions, { mode: 0o700 });
    fs.chmodSync(adoptions, 0o555);
    try {
      const terminal = terminalAdoption(h, run, to);
      assert.equal(terminal.status, 1, `${terminal.stdout}\n${terminal.stderr}`);
      const file = path.join(adoptions, `${run}-${to}.json`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(terminal.stdout, new RegExp(`"error": "relay could not write ${file} \\(EACCES[^)]*\\), so no transfer was authorized: it, or the directory it is in, is not writable; make it writable again\\."`), terminal.stdout);
      assert.doesNotMatch(terminal.stdout + terminal.stderr, /\n\s+at /, "no stack is thrown at the person");
      assert.deepEqual(fs.readdirSync(adoptions), []);
    } finally {
      fs.chmodSync(adoptions, 0o700);
    }
  } finally {
    await h.close();
  }
});

test("storage: keep_records_days goes by a run's latest activity, not when it began, and keeps a run whose worker or agent processes may still be running", async () => {
  const h = await harness([], { keep_records_days: 7 });
  // An agent's process group that outlived its turn.
  const agent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const runs: string[] = [];
    for (const name of ["TURNED", "DECIDED", "SEEN", "WORKING", "CLAIMED", "STALE"]) runs.push(await closedRun(h, name));
    const node = (run: string) => h.sql("SELECT id FROM nodes WHERE run_id = ?", run)[0].id as string;
    for (const run of runs) age(h, run, 30);
    const [t, d, s, w, c, old] = runs;
    const yesterday = Date.now() - DAY;
    const monthAgo = Date.now() - 30 * DAY;
    // Begun a month ago, but a turn of it ended yesterday, as a thread resumed long after its run began.
    h.sql("UPDATE turns SET ended_at = ? WHERE id = (SELECT MAX(id) FROM turns WHERE node_id = ?)", yesterday, node(t));
    // Nothing since a month ago but an approval request decided yesterday.
    h.sql("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at, decided_at) VALUES ('q_0000dddd', ?, ?, 'command', 'run something', 'denied', ?, ?)", d, node(d), monthAgo, yesterday);
    // Nothing but an event its session was shown yesterday.
    h.sql("INSERT INTO events (run_id, key, kind, item_id, subject, text, created_at, seen_at) VALUES (?, 'test-seen-yesterday', 'done', ?, 'subject', 'text', ?, ?)", s, node(s), monthAgo, yesterday);
    // A month old, but an agent process of it still running; and a worker just claimed for it, not started yet.
    h.sql("UPDATE nodes SET agent_pgid = ? WHERE run_id = ?", agent.pid, w);
    h.sql("UPDATE nodes SET worker_pid = -1, worker_claimed_at = ? WHERE run_id = ?", Date.now(), c);
    const r = forgetNow(h, 7);
    assert.deepEqual(r.forgotten, [old], JSON.stringify(r));
    const kept = (run: string) => r.kept.find((k) => k.startsWith(`${run}: `)) ?? "";
    for (const run of [t, d, s]) {
      assert.equal(kept(run), "", `${run} had activity within the limit, so it is not even considered: ${JSON.stringify(r)}`);
      assert.equal(rows(h, run), 2, `${run} is still in the registry`);
    }
    assert.equal(kept(w), `${w}: an agent process of ${node(w)} (group ${agent.pid}) may still be running`);
    assert.equal(kept(c), `${c}: the worker of ${node(c)} is still running`);
    for (const run of [w, c]) assert.equal(rows(h, run), 2, `${run} is still in the registry`);
  } finally {
    try {
      sendGroupSignal(agent.pid!, "SIGKILL");
    } catch {
      // Gone already.
    }
    await h.close();
  }
});

test("storage: a run's directory left aside while another relay process is forgetting that run is not put back, so no records outlive their rows", async () => {
  const h = await harness();
  const tmp = shortTmp();
  let holder: ChildProcess | null = null;
  let sweeper: ChildProcess | null = null;
  try {
    const a = await closedRun(h, "A");
    const records = path.join(h.home, "runs", a);
    const aside = path.join(h.home, "runs", `.forgotten-${a}`);
    const mark = path.join(tmp, "sweeping");
    // Another process forgetting A, as forgetOldRuns does: in one transaction, A's directory moved
    // aside and its rows deleted; committed only once the sweep below has begun.
    holder = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      const { DatabaseSync } = require("node:sqlite");
      const [file, run, records, aside, mark] = process.argv.slice(1);
      const d = new DatabaseSync(file);
      d.exec("PRAGMA busy_timeout = 10000");
      d.exec("BEGIN IMMEDIATE");
      fs.renameSync(records, aside);
      d.prepare("DELETE FROM turns WHERE node_id IN (SELECT id FROM nodes WHERE run_id = ?)").run(run);
      d.prepare("DELETE FROM nodes WHERE run_id = ?").run(run);
      d.prepare("DELETE FROM runs WHERE id = ?").run(run);
      console.log("held");
      const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      for (let i = 0; i < 1200 && !fs.existsSync(mark); i++) wait(50);
      wait(1000);
      d.exec("COMMIT");
      console.log("committed");
    `, path.join(h.home, "relay.db"), a, records, aside, mark], { stdio: ["ignore", "pipe", "inherit"] });
    const held = said(holder, "held");
    const holderDone = exited(holder);
    await held;
    sweeper = spawn(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      import { sweepTemps } from ${JSON.stringify(RETENTION)};
      fs.writeFileSync(process.env.SWEEP_MARK, "");
      console.log(JSON.stringify(await sweepTemps()));
    `], { env: { ...h.env, TMPDIR: tmp, SWEEP_MARK: mark }, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    sweeper.stdout!.on("data", (d) => (out += String(d)));
    const [held1, swept] = await Promise.all([holderDone, exited(sweeper)]);
    assert.equal(held1, 0, "the forgetting committed");
    assert.equal(swept, 0, out);
    assert.equal(rows(h, a), 0, "the run is forgotten");
    assert.equal(fs.existsSync(records), false, "its records were not put back");
    assert.equal(fs.existsSync(aside), false, "and what was left aside is removed");
    assert.deepEqual(JSON.parse(out).removed, [aside], out);
  } finally {
    for (const c of [holder, sweeper]) if (c && c.exitCode === null) c.kill("SIGKILL");
    await h.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("storage: a temporary directory that is not there stops neither relay clean nor a worker's housekeeping from applying keep_records_days, and each says what it could not sweep", async () => {
  const h = await harness([], { keep_records_days: 7 });
  const scratch = scratchDir("no-tmp");
  try {
    const missing = path.join(scratch, "missing-tmp");
    const old = await closedRun(h, "OLD");
    age(h, old, 30);
    const r = spawnSync(process.execPath, [CLI, "clean"], { env: { ...h.env, TMPDIR: missing }, cwd: h.repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const cleaned = JSON.parse(r.stdout);
    assert.deepEqual(cleaned.records_forgotten, [old], r.stdout);
    assert.doesNotMatch(cleaned.temp_dirs_left.join("\n"), /sockets directory/, "the relocated sockets root does not depend on TMPDIR");
    assert.match(cleaned.temp_dirs_left.join("\n"), /missing-tmp was not swept \(ENOENT/, r.stdout);
    // A worker's housekeeping the same way: what it could not sweep goes to its log, and the old run is still forgotten.
    const later = await closedRun(h, "LATER");
    age(h, later, 30);
    housekeepingDue(h);
    const w = spawnSync(process.execPath, ["--input-type=module", "-e", `import { housekeepDaily } from ${JSON.stringify(RETENTION)}; await housekeepDaily({ keep_records_days: 7 });`], { env: { ...h.env, TMPDIR: missing }, encoding: "utf8" });
    assert.equal(w.status, 0, w.stderr);
    assert.match(w.stderr, /relay: removed leftover temporary directories: none; .*missing-tmp was not swept \(ENOENT/, w.stderr);
    assert.match(w.stderr, new RegExp(`relay: keep_records_days 7: forgot ${later}`), w.stderr);
    assert.equal(rows(h, later), 0);
    assert.ok(fs.existsSync(path.join(h.home, "housekeeping")), "and it is stamped done for the day");
  } finally {
    await h.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("storage: runs forgotten while another relay process holds the registry open are said to stay readable in it until a later checkpoint", async () => {
  const h = await harness([], { keep_records_days: 7 });
  let reader: ChildProcess | null = null;
  try {
    const a = await closedRun(h, "A");
    age(h, a, 30);
    // Another relay process in the middle of a read, for longer than the busy timeout (here 200 ms).
    reader = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const d = new DatabaseSync(process.argv[1]);
      d.exec("BEGIN");
      d.prepare("SELECT COUNT(*) FROM runs").get();
      console.log("reading");
      setInterval(() => {}, 1000);
    `, path.join(h.home, "relay.db")], { stdio: ["ignore", "pipe", "inherit"] });
    await said(reader, "reading");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { db } from ${JSON.stringify(path.join(import.meta.dirname, "..", "dist", "core", "db.js"))};
      import { forgetOldRuns } from ${JSON.stringify(RETENTION)};
      db().exec("PRAGMA busy_timeout = 200");
      console.log(JSON.stringify(forgetOldRuns(7)));
    `], { env: h.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.forgotten, [a], r.stdout);
    assert.match(out.left.join("\n"), /^the registry's write-ahead log could not be emptied \(another relay process was using the registry\), so what the forgotten runs held may stay readable in relay\.db and relay\.db-wal/, r.stdout);
  } finally {
    if (reader && reader.exitCode === null) reader.kill("SIGKILL");
    await h.close();
  }
});

test("storage: doctor says how much relay keeps, the room left on its disk and the storage policy, and warns when the room is short", async () => {
  const { storageReport, LOW_FREE } = await import("../dist/core/storage.js");
  const u = { dir: "/x/relay", bytes: 5 * 1024 ** 2, runs: 3, free: 200 * 1024 ** 3, backups: [] as string[] };
  const unset = storageReport(u, { log_max_mb: null, keep_records_days: null });
  assert.deepEqual(unset.lines, [
    "5.0 MB in /x/relay, with the records of 3 runs; 200.0 GB free on its disk",
    "logs: kept whole (log_max_mb not set)",
    "records: kept until you delete them (keep_records_days not set), ended rooms' transcripts too; relay clean and a worker remove only the temporary directories relay left behind",
  ]);
  assert.equal(unset.warning, null);
  const set = storageReport({ ...u, free: LOW_FREE - 1 }, { log_max_mb: 5, keep_records_days: 30 });
  assert.match(set.lines[1], /^logs: each rotated at 5 MB to <name>\.1/);
  assert.match(set.lines[2], /^records: a run's are forgotten after 30 days without activity/);
  assert.match(set.lines[2], /; an ended room's, with its transcript, 30 days after it ended/);
  // Rounded down: just under 1 GB never reads as 1 GB.
  assert.match(set.warning!, /^only 1023\.9 MB free on the disk holding \/x\/relay\. Once it is full, relay can keep no copy of a turn's prompt, log or final message and cannot update its registry, so turns fail and what they said may not be recorded\. Free space there/);
  // The copies of the registry made before upgrades, which nothing removes, are listed for the person to delete.
  const backedUp = storageReport({ ...u, backups: ["/x/relay/relay.db.backup-v7-a", "/x/relay/relay.db.backup-v8-b"] }, { log_max_mb: null, keep_records_days: 30 });
  assert.match(backedUp.lines[3], /^registry backups: 2, .*whatever keep_records_days says\. Delete them once you will not go back to the relay that wrote them: \/x\/relay\/relay\.db\.backup-v7-a, \/x\/relay\/relay\.db\.backup-v8-b$/);

  const h = await harness([], { log_max_mb: 2 });
  try {
    await closedRun(h, "A");
    const backup = path.join(h.home, "relay.db.backup-v7-2026-10-01T00-00-00-000Z-123");
    fs.writeFileSync(backup, "");
    const out = h.cli("doctor");
    assert.match(out, new RegExp(`records\\s+\\d+(\\.\\d)? [KMG]B in ${h.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, with the records of 1 run; \\d+(\\.\\d)? [KMG]B free on its disk\\n\\s+logs: each rotated at 2 MB`), out);
    assert.ok(out.includes(`registry backups: 1, `) && out.includes(backup), out);
    const cleaned = JSON.parse(h.cli("clean"));
    assert.deepEqual(cleaned.registry_backups_kept, [backup]);
    assert.match(cleaned.registry_backups_note, /^copies of the registry relay made before upgrading it, /);
  } finally {
    await h.close();
  }
});

test("storage: what a worker writes to its worker.log keeps out a token in relay's environment", async () => {
  const tmp = shortTmp();
  const h = await harness([], {}, { SOME_SERVICE_TOKEN: OTHER, TMPDIR: tmp });
  try {
    housekeepingDue(h);
    // A leftover the worker's housekeeping removes and names in its log, under a directory that
    // happens to be called by the token's value.
    const build = path.join(`${h.home}-worktrees`, OTHER, ".j_00000000.relay.0123456789abcdef");
    fs.mkdirSync(build, { recursive: true });
    const past = new Date(Date.now() - 20 * 60_000);
    fs.utimesSync(build, past, past);
    const r = await h.call("ask", { target: "claude", message: "NOW" });
    await workersGone(h, runOf(h, r.thread_id));
    assert.equal(fs.existsSync(build), false, "the housekeeping ran");
    const log = read(path.join(path.dirname(h.sql("SELECT log_path FROM nodes WHERE id = ?", r.thread_id)[0].log_path as string), "worker.log"));
    assert.match(log, /removed leftover temporary directories: .*\[redacted\]/, log);
    assert.equal(log.includes(OTHER), false, log);
  } finally {
    await h.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const reviewItems = (n: number, extra = "") => "```json\n" + JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ n: i + 1, severity: "major", location: `a.ts:${i + 1}`, summary: `issue ${i + 1}${extra}`, evidence: "e", fix: "f" })) }) + "\n```";
const agreedList = "```json\n" + JSON.stringify({ consensus: [{ ids: ["C1", "X1"], severity: "major", status: "agreed", summary: "same" }] }) + "\n```";

test("storage: a review's files keep out a token in relay's environment, and a review whose files cannot be written as it ends still ends, saying which", async () => {
  const h = await harness([
    { target: "codex", match: "independent code reviewer", steps: [{ reply: `REVIEWER-FINDING\n${reviewItems(1)}` }] },
    { target: "codex", turn: 2, steps: [{ reply: "C1 and X1 are the same.\nCONTINUE" }] },
    { target: "codex", turn: 3, steps: [{ reply: `Same.\n${agreedList}\nAGREE: list above` }] },
  ], {}, { GH_TOKEN: GH, SOME_SERVICE_TOKEN: OTHER });
  const files: string[] = [];
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { target: "src/a.ts" });
    assert.ok(started.review_id, JSON.stringify(started));
    assert.equal((await claude.call("status", { id: started.reviewer_job, wait_s: 20 })).status, "done");
    const handed = await claude.call("review", { review_id: started.review_id, own_review: `MINE: ${GH} and ${OTHER} are printed by the build\n${reviewItems(1, ` (${GH}, ${OTHER})`)}` });
    assert.equal(handed.phase, "reconciling", JSON.stringify(handed));
    const dir = path.dirname(handed.their_review);
    files.push(...fs.readdirSync(dir).filter((f) => /\.(md|json)$/.test(f)).map((f) => path.join(dir, f)));
    assert.equal(files.length, 4, files.join(", "));
    for (const f of files) assert.equal(read(f).includes(GH) || read(f).includes(OTHER), false, `${f}: ${read(f)}`);
    assert.match(files.map(read).join("\n"), /MINE: \[redacted\] and \[redacted\] are printed by the build/);

    // Nothing in the review's directory can be written any more, as on a full disk.
    for (const f of files) fs.chmodSync(f, 0o444);
    const closed = await claude.call("discuss", { discussion_id: handed.discussion_id, message: `Agreed.\n${agreedList}\nAGREE: list above` });
    assert.equal(closed.outcome, "agree", JSON.stringify(closed));
    const result = await claude.call("result", { job_id: started.review_id });
    assert.equal(result.status, "done", JSON.stringify(result));
    assert.equal(result.outcome, "agree", JSON.stringify(result));
    assert.ok(result.families, JSON.stringify(result));
    const said = (result.warnings ?? []).join("\n");
    for (const f of files) assert.match(said, new RegExp(`relay could not write ${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\([^)]*\\), so that file does not say which families took part, though the review's result does: it, or the directory it is in, is not writable`), said);
  } finally {
    for (const f of files) fs.chmodSync(f, 0o644);
    await h.close();
  }
});

test("storage: a plan given as text is kept in plan.md cut of a token in relay's environment, and the reviewer is given it as written", async () => {
  const h = await harness([{ target: "codex", match: "independent plan reviewer", steps: [{ reply: `REVIEWER-FINDING\n${reviewItems(1)}` }] }], {}, { GH_TOKEN: GH, SOME_SERVICE_TOKEN: OTHER });
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { plan: `Step one: export ${OTHER} and ${GH}.\nStep two: check it.` });
    assert.ok(started.review_id, JSON.stringify(started));
    assert.equal((await claude.call("status", { id: started.reviewer_job, wait_s: 20 })).status, "done");
    const plan = read(path.join(h.home, "runs", runOf(h, started.review_id), "reviews", started.review_id, "plan.md"));
    assert.equal(plan, "Step one: export [redacted] and [redacted].\nStep two: check it.\n");
    const given = h.log().filter((e) => String(e.prompt ?? "").includes("independent plan reviewer"));
    assert.ok(given.length && given.every((e) => String(e.prompt).includes(`Step one: export ${OTHER} and ${GH}.`)), "the reviewer was given the plan as written");
  } finally {
    await h.close();
  }
});

test("storage: a review that cannot make its directory (a read-only or full control directory) says what to do, and leaves no review open", async () => {
  const h = await harness([{ match: "FIRST", steps: [{ reply: "first answer" }] }]);
  let runs = "";
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const first = await claude.call("ask", { target: "codex", message: "FIRST" });
    assert.equal(first.reply, "first answer", JSON.stringify(first));
    const run = runOf(h, first.thread_id);
    runs = path.join(h.home, "runs", run);
    await until(() => h.sql("SELECT worker_pid FROM nodes WHERE id = ?", first.thread_id)[0].worker_pid === null, 20000, "the turn's worker to finish");
    fs.chmodSync(runs, 0o555);
    const r = await claude.call("review", { plan: "Step one: do the thing.\nStep two: check it." });
    assert.match(String(r.error), /relay could not write \S*reviews\S* \([^)]*\), so no review was started: it, or the directory it is in, is not writable; make it writable again$/, JSON.stringify(r));
    assert.deepEqual(h.sql("SELECT id, status FROM nodes WHERE run_id = ? AND kind IN ('review', 'job')", run), [], "no review or reviewer is left behind");
  } finally {
    if (runs) fs.chmodSync(runs, 0o755);
    await h.close();
  }
});

test("storage: a caller's own review that cannot be saved says what to do, and the review takes the same call again once it can", async () => {
  const h = await harness([
    { target: "codex", match: "independent code reviewer", steps: [{ reply: `REVIEWER-FINDING\n${reviewItems(1)}` }] },
    { target: "codex", turn: 2, steps: [{ reply: "C1 and X1 are the same.\nCONTINUE" }] },
  ]);
  let dir = "";
  try {
    const claude = await h.instance({ args: ["--host", "claude"] });
    const started = await claude.call("review", { target: "src/a.ts" });
    assert.equal((await claude.call("status", { id: started.reviewer_job, wait_s: 20 })).status, "done");
    dir = path.join(h.home, "runs", runOf(h, started.review_id), "reviews", started.review_id);
    fs.chmodSync(dir, 0o555);
    const own = { review_id: started.review_id, own_review: `MINE\n${reviewItems(1)}` };
    const refused = await claude.call("review", own);
    assert.match(String(refused.error), /relay could not write \S+\.md \([^)]*\), so the \S+ review was not saved; nothing else was changed, and the call can be made again: it, or the directory it is in, is not writable; make it writable again$/, JSON.stringify(refused));
    assert.equal((await claude.call("result", { job_id: started.review_id })).phase, "waiting for your own review");
    fs.chmodSync(dir, 0o755);
    const handed = await claude.call("review", own);
    assert.equal(handed.phase, "reconciling", JSON.stringify(handed));
  } finally {
    if (dir) fs.chmodSync(dir, 0o755);
    await h.close();
  }
});

// Its .md refused, nothing of it is written; its .json refused, the .md written first is removed too.
for (const blocked of ["md", "json"]) {
  test(`storage: a reviewer's review that cannot be saved as the reconciliation opens (its .${blocked}) says that the caller's own was saved, leaves none of it half-written, and the review opens once it can be written`, async () => {
    const h = await harness([
      { target: "codex", match: "independent code reviewer", steps: [{ reply: `REVIEWER-FINDING\n${reviewItems(1)}` }] },
      { target: "codex", turn: 2, steps: [{ reply: "C1 and X1 are the same.\nCONTINUE" }] },
    ]);
    try {
      const claude = await h.instance({ args: ["--host", "claude"] });
      const started = await claude.call("review", { target: "src/a.ts" });
      assert.equal((await claude.call("status", { id: started.reviewer_job, wait_s: 20 })).status, "done");
      const p = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", started.review_id)[0].params_json as string);
      const dir = path.join(h.home, "runs", runOf(h, started.review_id), "reviews", started.review_id);
      // One of the reviewer's files cannot be written: something read-only is in its place.
      const theirs = { md: path.join(dir, `${p.other}.md`), json: path.join(dir, `${p.other}.json`) };
      const inTheWay = theirs[blocked as "md" | "json"];
      fs.writeFileSync(inTheWay, "in the way\n");
      fs.chmodSync(inTheWay, 0o444);
      const refused = await claude.call("review", { review_id: started.review_id, own_review: `MINE\n${reviewItems(1)}` });
      const quoted = inTheWay.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(String(refused.error), new RegExp(`^relay could not write ${quoted} \\([^)]*\\), so the ${p.other} review was not saved; your own review was saved, so make the call again with review_id alone once it can be written: it, or the directory it is in, is not writable; make it writable again$`), JSON.stringify(refused));
      assert.ok(fs.existsSync(path.join(dir, `${p.caller}.md`)), "the caller's own review was saved");
      for (const f of Object.values(theirs)) assert.equal(fs.existsSync(f), false, `no review of theirs is left half-written: ${f}`);
      const handed = await claude.call("review", { review_id: started.review_id });
      assert.equal(handed.phase, "reconciling", JSON.stringify(handed));
    } finally {
      await h.close();
    }
  });
}

// Review r_462d14ae (C12/X10 round 4).

test("storage: the redactor reads a secret's name in camelCase, glued to a prefix (PGPASSWORD) or ending in _PWD, and leaves ordinary names alone", async () => {
  const { redactor } = await import("../dist/core/secrets.js");
  const t = "Zx9vB2nM4qL7wT1yR5uK";
  const cut = redactor({});
  for (const [given, kept] of [
    // JSON's usual spelling of a secret's name, and npm's .npmrc.
    [`{"accessToken":"${t}"}`, `{"accessToken":"[redacted]"}`], [`{"refreshToken": "${t}"}`, `{"refreshToken": "[redacted]"}`],
    [`{"clientSecret": "${t}"}`, `{"clientSecret": "[redacted]"}`], [`{"secretAccessKey": "${t}"}`, `{"secretAccessKey": "[redacted]"}`],
    [`authToken: ${t}`, "authToken: [redacted]"], [`//registry.npmjs.org/:_authToken=npm_${t}`, "//registry.npmjs.org/:_authToken=[redacted]"],
    // libpq's and MySQL's own variables, as an agent's command or a .env has them.
    [`PGPASSWORD=${t} psql -h db`, "PGPASSWORD=[redacted] psql -h db"], [`MYSQL_PWD=${t}`, "MYSQL_PWD=[redacted]"],
  ]) assert.equal(cut(given), kept);
  for (const ordinary of [
    `{"maxTokens": 4096, "tokenCount": 12345678901234567}`, `{"nextPageToken": "CiAKGjBpNDd2Nmp2Zml2cXRlMjAxNjEyMDQ"}`, `{"tokenType": "Bearer"}`,
    "accessToken = getAccessTokenFromProvider(x)", `{"authorName": "jack1234567890abcdef"}`, "pwd=/Users/someone/project", "OLDPWD=/tmp/old_dir_1234567890",
  ]) assert.equal(cut(ordinary), ordinary);
  // By value: the variables relay passes on.
  const env = redactor({ PGPASSWORD: "s3cr3tPgPassw0rd", MYSQL_PWD: t, PWD: "/Users/someone/project", OLDPWD: "/Users/someone/elsewhere" });
  assert.equal(env(`bare s3cr3tPgPassw0rd and ${t} in /Users/someone/project`), "bare [redacted] and [redacted] in /Users/someone/project");
});

test("storage: a secret known by value is cut in its other forms too: each line of a multi-line one, trimmed, percent-encoded, and JSON-escaped twice", async () => {
  const { redactor } = await import("../dist/core/secrets.js");
  const body = ["MIIEowIBAAKCAQEAx7abcdefghijklmnopqrstuv0123456789ABCDEFGH", "+QWERTYUIOPasdfghjklzxcvbnm0123456789qwertyuiopASDFGH/"];
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body.join("\n")}\nQ==\n-----END RSA PRIVATE KEY-----`;
  const quoted = 'pa"ss\\w0rdXYZ12345';
  const env = {
    GITHUB_APP_PRIVATE_KEY: pem, MY_SERVICE_TOKEN: "abcdefgh12345678wxyz\n", OTHER_SERVICE_TOKEN: "\tQwErTy12345678uiop\r",
    SVC_API_KEY: "p@ss/w0rd+with=chars!x", SERVICE_PASSWORD: quoted,
  };
  const cut = redactor(env);
  assert.equal(cut("token abcdefgh12345678wxyz here, and QwErTy12345678uiop there"), "token [redacted] here, and [redacted] there");
  const encoded = encodeURIComponent(env.SVC_API_KEY);
  assert.equal(cut(`https://example.com/?key=${encoded}&k2=${encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}`), "https://example.com/?key=[redacted]&k2=[redacted]");
  // A tool's arguments given as a JSON string inside a JSON event: escaped twice.
  const nested = JSON.stringify({ arguments: JSON.stringify({ password: quoted }) });
  assert.equal(cut(nested).includes("w0rdXYZ12345"), false, cut(nested));
  // Each line of the key, wherever it is printed on its own; not the armour around it, which says nothing.
  assert.equal(cut(`it begins ${body[0]}`), "it begins [redacted]");
  // In the agent's log, cut a line at a time, as a CLI's stderr is.
  const dir = scratchDir("forms");
  try {
    const file = path.join(dir, "agent.log");
    const { log } = openAgentLog(file, { env, maxBytes: null });
    log.write(`[stderr] printenv:\n${pem}\n`);
    log.end();
    const text = read(file);
    for (const l of body) assert.equal(text.includes(l), false, text);
    assert.match(text, /^\[stderr\] printenv:\n-----BEGIN RSA PRIVATE KEY-----\n\[redacted\]\n\[redacted\]\nQ==\n-----END RSA PRIVATE KEY-----\n?$/, text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: an error's diagnostic tail is cut of secrets before it is clipped, so neither part of a secret nor one whose context was clipped away is kept", async () => {
  const { diagnosticTail } = await import("../dist/core/redact.js");
  // A credential relay knows by its shape, straddling the place where the tail is cut.
  const straddled = diagnosticTail(2000);
  straddled.write(`${GH} ${"y".repeat(1980)}\n`);
  assert.equal(straddled.text().includes(GH.slice(-12)), false, straddled.text().slice(0, 40));
  // A bearer token known only by its header, the header itself falling before the cut.
  const token = "abcdefgh12345678ijklmnop";
  const clipped = diagnosticTail(2000);
  clipped.write(`curl failed: Authorization: Bearer ${token} ${"z".repeat(2000 - token.length - 2)}\n`);
  assert.equal(clipped.text().includes(token), false, clipped.text().slice(0, 40));
  // The part not yet ended by a line break, too.
  const held = diagnosticTail(2000);
  held.write(`Authorization: Bearer ${token} ${"z".repeat(2000 - token.length - 1)}`);
  assert.equal(held.text().includes(token), false, held.text().slice(0, 40));
});

test("storage: a backend's own warnings are cut of a token in relay's environment, in the result and in what relay records of the turn", async () => {
  const h = await harness([], {}, { SOME_SERVICE_TOKEN: OTHER });
  try {
    // The archive warning quotes what Codex's app server said.
    const root = await h.instance({ env: { STUB_CODEX_ARCHIVE_ERROR: `disk full near ${OTHER}` } });
    const r = await root.call("delegate", { target: "codex", task: "answer", mode: "read", background: false });
    assert.equal(r.status, "done", JSON.stringify(r));
    // The stub's archive error reaches it as a passed control (W9), and a released secret-like value
    // is cut whole, so the token goes with the words around it; either way it is never kept.
    assert.match(r.result.warnings[0], /Could not archive Codex thread .*: (disk full near \[redacted\]|\[redacted: environment value\])/, JSON.stringify(r.result.warnings));
    const turn = h.sql("SELECT error FROM turns WHERE node_id = ?", r.job_id)[0];
    for (const [what, text] of [["result", JSON.stringify(r)], ["turn's error", String(turn.error)]] as const) assert.equal(text.includes(OTHER), false, `the ${what} keeps the token out:\n${text}`);
  } finally {
    await h.close();
  }
});

test("storage: an agent's line that arrives in many chunks is held in time linear in its length", async () => {
  const dir = scratchDir("long-line");
  try {
    const file = path.join(dir, "agent.log");
    const { log } = openAgentLog(file, { maxBytes: 1 << 20 });
    // 16 MB in 4 KB chunks: scanning all that is held at every chunk would take tens of seconds.
    const chunk = "x".repeat(4096);
    const started = Date.now();
    for (let i = 0; i < 4096; i++) log.write(chunk);
    log.write("\nafter\n");
    log.end();
    const ms = Date.now() - started;
    assert.ok(ms < 3000, `a 16 MB line in 4 KB chunks took ${ms} ms`);
    assert.equal(fs.statSync(`${file}.1`).size, 16 * (1 << 20) + 1, "the long line, whole, rotated away from the line after it");
    assert.equal(read(file), "after\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: relay clean sweeps no sockets directory that is a link, or not a directory, and says so", async () => {
  const tmp = shortTmp();
  const h = await harness([], {}, { TMPDIR: tmp });
  try {
    // Somewhere else, a directory of this user's with a name the sweep would remove in relay's own.
    const elsewhere = path.join(tmp, "elsewhere");
    const victim = path.join(elsewhere, "relay-turn-ext001");
    fs.mkdirSync(victim, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(victim, "keep.txt"), "not relay's");
    const old = new Date(Date.now() - 90 * 60_000);
    fs.utimesSync(victim, old, old);
    const sockets = path.join(h.env.HOME, ".relay-t", "s");
    fs.mkdirSync(path.dirname(sockets), { mode: 0o700, recursive: true });
    fs.symlinkSync(elsewhere, sockets);
    const cleaned = JSON.parse(h.cli("clean"));
    assert.ok(fs.existsSync(path.join(victim, "keep.txt")), "nothing is removed through the link");
    assert.deepEqual(cleaned.temp_dirs_removed, [], JSON.stringify(cleaned));
    assert.match((cleaned.temp_dirs_left ?? []).join("\n"), /\/s is not a plain directory of this user's, so relay did not sweep it/, JSON.stringify(cleaned));
  } finally {
    await h.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("storage: a record rewritten in place keeps what it held when the new text cannot be written whole", async (t) => {
  const { keepRecord } = await import("../dist/core/storage.js");
  const dir = scratchDir("replace");
  try {
    // As endReview rewrites a side's .json with the families: a full disk partway through.
    const file = path.join(dir, "codex.json");
    fs.writeFileSync(file, '{"items":[{"n":1}]}');
    const real = fs.writeFileSync;
    t.mock.method(fs, "writeFileSync", (p: fs.PathOrFileDescriptor, data: string) => {
      real(p, String(data).slice(0, 5));
      throw Object.assign(new Error(`ENOSPC: no space left on device, write`), { code: "ENOSPC", syscall: "write" });
    });
    const problem = keepRecord(file, '{"items":[{"n":1}],"families":{}}', { consequence: "that file does not say which families took part" });
    t.mock.restoreAll();
    assert.match(String(problem), /^relay could not write .*codex\.json \(ENOSPC: no space left on device, write\), so that file does not say which families took part: the disk it is on is full; free space there$/);
    assert.equal(read(file), '{"items":[{"n":1}]}', "the record as it was");
    assert.deepEqual(fs.readdirSync(dir), ["codex.json"], "and nothing half-written beside it");
    // Written whole, it replaces the record.
    assert.equal(keepRecord(file, '{"items":[],"families":{}}'), null);
    assert.equal(read(file), '{"items":[],"families":{}}');
    assert.deepEqual(fs.readdirSync(dir), ["codex.json"]);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
