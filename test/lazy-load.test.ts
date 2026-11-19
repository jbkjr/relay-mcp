// Relay loads a command's modules when it runs, and a worker loads a target's backend and the
// brokers only when a turn needs them (src/cli.ts, src/backends/index.ts). A module that fails to
// load is then found mid-operation rather than at start, so these check, on a copy of the build
// with a module taken out, that such a failure ends the turn as a failure and leaves nothing
// queued or running, and that a module every server needs still stops `relay mcp` at start.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { harness, hostFor, nonTempScratch } from "./helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

/** A copy of this build (dist and package.json, with this checkout's node_modules) without `missing`. */
function brokenCopy(missing: string): string {
  const pkg = nonTempScratch("relay-broken-");
  fs.cpSync(path.join(ROOT, "dist"), path.join(pkg, "dist"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(pkg, "package.json"));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(pkg, "node_modules"));
  fs.rmSync(path.join(pkg, "dist", missing));
  return path.join(pkg, "dist", "cli.js");
}

test("a target's backend that fails to load fails the turn, with the loader's reason, and strands nothing", async () => {
  const cli = brokenCopy(path.join("backends", "codex.js"));
  const h = await harness([]);
  try {
    const root = await h.instance({ args: ["--host", hostFor("codex")], cli });
    const r = await root.call("ask", { target: "codex", message: "q" });
    assert.match(String(r.error), /Cannot find module .*backends\/codex\.js/, JSON.stringify(r));
    const id = r.thread_id as string;
    const [node] = h.sql("SELECT status, worker_pid FROM nodes WHERE id = ?", id);
    assert.deepEqual([node.status, node.worker_pid], ["failed", null]);
    assert.deepEqual(h.sql("SELECT status FROM turns WHERE node_id = ? AND status IN ('queued', 'running')", id), []);
    assert.equal(h.starts().filter((s) => s.target === "codex").length, 0, "no agent was started");
    await root.close();
  } finally {
    await h.close();
  }
});

test("a module every server needs that is missing stops relay mcp at start, naming it", () => {
  const cli = brokenCopy(path.join("core", "db.js"));
  const r = spawnSync(process.execPath, [cli, "mcp"], { input: "", encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /core\/db\.js/);
});

test("the module for a Codex host's registration is loaded only for a Codex client, and one that fails to load stops that server, naming it", async () => {
  const cli = brokenCopy(path.join("hosts", "codex.js"));
  const exchange = (clientName: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cli, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; if (stdout.includes('"id":2}')) child.stdin.end(); });
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    for (const m of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]) child.stdin.write(JSON.stringify(m) + "\n");
  });
  const claude = await exchange("claude-code");
  assert.match(claude.stdout, /^\{"result":\{"tools":\[.*"id":2\}$/m, claude.stderr);
  const codex = await exchange("codex-mcp-client");
  assert.equal(codex.code, 1, codex.stderr);
  assert.match(codex.stderr, /hosts\/codex\.js/);
  assert.doesNotMatch(codex.stdout, /"id":2\}/, "it lists no tools without it");
});

test("relay --version loads no module of relay's but the CLI and its basics", () => {
  const cli = brokenCopy(path.join("core", "db.js"));
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^relay \d+\.\d+\.\d+/);
});
