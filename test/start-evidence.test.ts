// A root server asks ps how its host started it while its modules load (mcp/host.ts
// startEvidence), and builds its first host profile from those answers; where the session's
// repository is, it asks git when it builds the profile. These check that the answers are the ones
// the blocking reads give, that no message but initialize is read before they are in, and that the
// profile is built from them and from the repository as it is then.
import assert from "node:assert/strict";
import cp, { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ancestorCommandLines, ancestorCommandLinesLater } from "../dist/core/procs.js";
import { startEvidence } from "../dist/mcp/host.js";
import { harness, INTERACTIVE_CLAUDE, until } from "./helpers.ts";

test("start evidence: the command lines above a server, asked without blocking, are the ones asked with", async () => {
  for (const levels of [1, 3, 8]) assert.deepEqual(await ancestorCommandLinesLater(levels), ancestorCommandLines(levels), `${levels} levels`);
});

test("start evidence: a ps that fails is evidence that could not be read, as the profile's own ps takes it, never a start with nothing above it", async () => {
  // Each failure gives a row ps could have printed, so that a failure read as an answer shows.
  const row = "1 claude --dangerously-skip-permissions\n";
  const failures: { what: string; later: (cb: (err: Error | null, stdout: string, stderr: string) => void) => void; now: () => unknown }[] = [
    { what: "ps exits with an error", later: (cb) => cb(Object.assign(new Error("Command failed"), { code: 1 }), row, ""), now: () => ({ status: 1, stdout: row, stderr: "" }) },
    { what: "ps cannot be started", later: (cb) => cb(Object.assign(new Error("spawn /bin/ps EAGAIN"), { code: "EAGAIN" }), "", ""), now: () => ({ status: null, error: Object.assign(new Error("spawnSync /bin/ps EAGAIN"), { code: "EAGAIN" }), stdout: "", stderr: "" }) },
    { what: "ps is killed", later: (cb) => cb(Object.assign(new Error("Command failed"), { code: null, killed: true, signal: "SIGKILL" }), row, ""), now: () => ({ status: null, signal: "SIGKILL", stdout: row, stderr: "" }) },
    { what: "ps answers with nothing", later: (cb) => cb(null, "", ""), now: () => ({ status: 0, stdout: "", stderr: "" }) },
    { what: "starting ps throws", later: () => { throw new Error("spawn failed"); }, now: () => { throw new Error("spawn failed"); } },
  ];
  const { execFile, spawnSync } = cp;
  try {
    for (const f of failures) {
      const mine = (command: unknown, args: unknown) => command === "/bin/ps" && Array.isArray(args) && args[0] === "-ww";
      (cp as { execFile: unknown }).execFile = (command: string, args: string[], options: unknown, cb: never) => (mine(command, args) ? f.later(cb) : execFile(command, args, options as never, cb));
      (cp as { spawnSync: unknown }).spawnSync = (command: string, args: string[], options: never) => (mine(command, args) ? f.now() : spawnSync(command, args, options));
      syncBuiltinESMExports();
      // The blocking read, as the profile makes it when it has no evidence (server.ts): null, or a throw it takes for null.
      let blocking: string[] | null | "threw";
      try {
        blocking = ancestorCommandLines(3);
      } catch {
        blocking = "threw";
      }
      assert.ok(blocking === null || blocking === "threw", `${f.what}: the blocking read cannot say (${JSON.stringify(blocking)})`);
      assert.deepEqual(await startEvidence([], {}), { started: null }, `${f.what}: the start evidence cannot say either`);
    }
  } finally {
    Object.assign(cp, { execFile, spawnSync });
    syncBuiltinESMExports();
  }
});

test("start evidence: a root server reads no message but initialize before its start evidence is in, then the rest in order, and builds its first profile from it", async () => {
  const h = await harness();
  const env = { ...process.env };
  const cwd = process.cwd();
  try {
    // The server reads the host's settings and markers from its own environment and directory: the harness's, as a spawned server would.
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, h.env, INTERACTIVE_CLAUDE.env, { RELAY_CONFIG: path.join(h.home, "config.json") });
    process.chdir(h.repo);
    const { relayServer } = await import("../dist/mcp/server.js");
    const { newInstance } = await import("../dist/core/caller.js");
    const cases = [
      { what: "a plain start", started: ["claude"], confirm: true },
      { what: "the evidence's command lines, not ps's", started: ["claude --dangerously-skip-permissions"], confirm: false },
      // Could not be read: nothing there is taken as a person's answer, as when the profile's own ps fails.
      { what: "command lines that could not be read", started: null, confirm: false },
    ];
    for (const c of cases) {
      let release!: () => void;
      const evidence = new Promise<{ started: string[] | null }>((r) => { release = () => r({ started: c.started }); });
      const server = relayServer(newInstance({ kind: "root" }, h.repo, "claude"), { evidence });
      const [ours, theirs] = InMemoryTransport.createLinkedPair();
      const got: JSONRPCMessage[] = [];
      theirs.onmessage = (m) => void got.push(m);
      await server.connect(ours);
      await theirs.start();
      const answered = (id: number) => got.findIndex((m) => "id" in m && m.id === id && ("result" in m || "error" in m));
      try {
        await theirs.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: INTERACTIVE_CLAUDE.clientInfo } });
        await until(() => answered(1) >= 0, 5000, "initialize answered before the evidence is in");
        await theirs.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        await theirs.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        await theirs.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status", arguments: {} } });
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual([answered(2), answered(3)], [-1, -1], `${c.what}: nothing after initialize is answered before the evidence is in`);
        release();
        await until(() => answered(3) >= 0, 10_000, "the held messages answered");
        assert.ok(answered(2) < answered(3), `${c.what}: held messages are answered in the order they came`);
        const tools = (got[answered(2)] as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
        assert.equal(tools.includes("confirm"), c.confirm, `${c.what}: confirm ${c.confirm ? "offered" : "withheld"}, from the evidence`);
      } finally {
        await server.close();
      }
    }
  } finally {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, env);
    await h.close();
  }
});

test("start evidence: the settings a profile reads are found in the repository as it is when the profile is built, not as it was when the server started", async () => {
  const h = await harness();
  const env = { ...process.env };
  const cwd = process.cwd();
  try {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, h.env, INTERACTIVE_CLAUDE.env, { RELAY_CONFIG: path.join(h.home, "config.json") });
    // The session's directory names its repository by a .git file: `plain`, or `hooked`, whose
    // local settings carry a hook that answers permission prompts. Another writer can repoint it.
    const at = path.join(h.home, "session");
    const repos = { plain: path.join(h.home, "plain"), hooked: path.join(h.home, "hooked") };
    for (const repo of Object.values(repos)) execFileSync("git", ["init", "-q", repo], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    fs.mkdirSync(path.join(repos.hooked, ".claude"));
    fs.writeFileSync(path.join(repos.hooked, ".claude", "settings.local.json"), JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "echo" }] }] } }));
    fs.mkdirSync(at);
    const pointTo = (repo: keyof typeof repos) => fs.writeFileSync(path.join(at, ".git"), `gitdir: ${repos[repo]}/.git\n`);
    process.chdir(at);
    const { startEvidence } = await import("../dist/mcp/host.js");
    const { relayServer } = await import("../dist/mcp/server.js");
    const { newInstance } = await import("../dist/core/caller.js");
    for (const [first, then] of [["plain", "hooked"], ["hooked", "plain"], ["plain", "plain"], ["hooked", "hooked"]] as const) {
      pointTo(first);
      // As `relay mcp` starts (cli.ts): everything it reads then is in before the pointer moves.
      const early = await startEvidence(["--host", "claude"], process.env)!;
      // The command lines of a plain interactive start: the test runner's are not a host's.
      const server = relayServer(newInstance({ kind: "root" }, at, "claude"), { evidence: Promise.resolve({ ...early, started: ["claude"] }) });
      const [ours, theirs] = InMemoryTransport.createLinkedPair();
      const got: JSONRPCMessage[] = [];
      theirs.onmessage = (m) => void got.push(m);
      await server.connect(ours);
      await theirs.start();
      const answered = (id: number) => got.findIndex((m) => "id" in m && m.id === id && ("result" in m || "error" in m));
      try {
        await theirs.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: INTERACTIVE_CLAUDE.clientInfo } });
        await until(() => answered(1) >= 0, 5000, "initialize answered");
        pointTo(then);
        await theirs.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        await theirs.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        await until(() => answered(2) >= 0, 10_000, "tools/list answered");
        const tools = (got[answered(2)] as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
        assert.equal(tools.includes("confirm"), then === "plain", `${first}, then ${then}: confirm ${then === "plain" ? "offered" : "withheld"}, as the repository is at the profile`);
      } finally {
        await server.close();
      }
    }
  } finally {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, env);
    await h.close();
  }
});
