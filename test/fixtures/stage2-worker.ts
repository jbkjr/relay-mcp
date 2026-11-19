// Test-only stand-in for a relay worker running one stage-2 Codex turn (stage2-executor-live.test.ts):
// codexBackend.start with stage 2 on (config targets.codex.stage2), a fake Responses-API model on
// loopback, and every package as relay runs it (D's admission and checks, B's probes, A's lease),
// the lease on a scratch range (setLeaseOptionsForTests). The model's first tool call starts what a
// turn leaves behind (a setsid listener on the block's first port) and then blocks. Once those run,
// it prints one JSON line (pids and ports) and waits; the test then kills it or cancels its node.
// The model never answers after that (unless STAGE2_WORKER_ANSWER is set), so the turn stays in progress.
// SIGTERM is ignored, as by a worker stuck in teardown: cancel must then kill it.
// Usage: node stage2-worker.ts '<json: { codex, root, runId, nodeId, turnId (a running turn of the node), range: { first, count } }>'
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { codexBackend } from "../../dist/backends/codex.js";
import { setCodexHomeConfigForTests } from "../../dist/backends/codex-pin.js";
import { setLeaseOptionsForTests } from "../../dist/backends/codex-env.js";
import { withTurnSecrets } from "../../dist/core/secrets.js";
import { withDefaults } from "../../dist/core/config.js";
import { updateNode } from "../../dist/core/db.js";
import { targetDef } from "../../dist/targets/index.js";
import type { TurnSpec } from "../../dist/backends/types.js";

const o = JSON.parse(process.argv[2]) as { codex: string; root: string; runId: string; nodeId: string; turnId: number; range: { first: number; count: number } };
process.on("SIGTERM", () => {});

const cwd = path.join(o.root, "w"), appHome = path.join(o.root, "apphome");
for (const d of [cwd, appHome]) fs.mkdirSync(d, { recursive: true });
// A git repository, as a real job's cwd is (Codex writes a new thread's rollout late there: stage2TurnReadback).
spawnSync("git", ["init", "-q", cwd], { stdio: "ignore", env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1" } });
const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 };
const sse = (evs: unknown[]) => evs.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const cmd = [
  `/usr/bin/perl -MPOSIX -MIO::Socket::INET -e 'exit 0 if fork; POSIX::setsid(); my $s = IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => $ENV{PORT}, Listen => 5, ReuseAddr => 1) or die; open(F, ">", "pid_listen"); print F $$; close F; while (my $c = $s->accept) { print $c "hi"; close $c }'`,
  "/bin/sleep 4312",
].join("; ");
let asked = 0;
const server = http.createServer((q, s) => {
  let b = "";
  q.on("data", (d) => (b += d));
  q.on("end", () => {
    if (q.method !== "POST" || !q.url?.includes("/responses")) { s.writeHead(404); s.end("{}"); return; }
    s.writeHead(200, { "content-type": "text/event-stream" });
    if (asked++ === 0) {
      const call = { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd, login: false, timeout_ms: 600000, yield_time_ms: 600000 }) };
      s.end(sse([{ type: "response.created", response: { id: "r1" } }, { type: "response.output_item.done", item: { ...call, call_id: "c1", id: "i1" } }, { type: "response.completed", response: { id: "r1", usage } }]));
    } else if (process.env.STAGE2_WORKER_ANSWER) {
      s.end(sse([{ type: "response.created", response: { id: "rz" } }, { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "mz", content: [{ type: "output_text", text: "done" }] } }, { type: "response.completed", response: { id: "rz", usage } }]));
    } else {
      // The model thinks forever: the turn stays in progress until the test kills or cancels the worker.
      s.write(sse([{ type: "response.created", response: { id: "rz" } }]));
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const modelPort = (server.address() as net.AddressInfo).port;
fs.copyFileSync(path.join(import.meta.dirname, "stage2-catalog.json"), path.join(o.root, "catalog.json"));
fs.writeFileSync(path.join(appHome, "config.toml"), ['model = "mock-model"', `openai_base_url = "http://127.0.0.1:${modelPort}/v1"`, `model_catalog_json = ${JSON.stringify(path.join(o.root, "catalog.json"))}`, ""].join("\n"));
setCodexHomeConfigForTests((home) => home === appHome ? fs.readFileSync(path.join(appHome, "config.toml"), "utf8") : undefined);
fs.writeFileSync(path.join(appHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-relay-stage2-fake-model" }));
setLeaseOptionsForTests({ range: o.range });
const spec = {
  target: targetDef("codex"), prompt: "go", cwd, dir: o.root, logPath: path.join(o.root, "agent.log"), access: "write", relay: null, turnId: o.turnId,
  config: withDefaults({ codex_backend: "app-server", child_auth: "any", codex_endpoint_override: "accept", child_mcp: "relay-only", cancel_grace_ms: 2000, targets: { codex: { bin: o.codex, stage2: true, home: appHome, pinned: false } } }),
  environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME, CODEX_HOME: appHome, SHELL: "/bin/zsh" },
  markers: { runId: o.runId, nodeId: o.nodeId, depth: 1 },
  grant: { network: true, raw_network: true },
  onApproval: async () => ({ decision: "deny" }),
} as unknown as TurnSpec;
await withTurnSecrets(async () => {
  const handle = await codexBackend.start(spec);
  // Publish before waiting for command pid files: a startup failure/timeout must let the parent
  // reap the app server before its executor, even if the first info line never arrives.
  updateNode(o.nodeId, { agent_pid: handle.pid, agent_pgid: handle.pgid, agent_start: handle.startedAt });
  const pidIn = (name: string) => {
    try { return Number(fs.readFileSync(path.join(cwd, name), "utf8").trim()) || 0; } catch { return 0; }
  };
  for (let i = 0; i < 600 && !pidIn("pid_listen"); i++) await new Promise((r) => setTimeout(r, 50));
  // This worker's executor (its child): its port from argv, the job's block from its environment.
  const executor = Number(spawnSync("/usr/bin/pgrep", ["-P", String(process.pid), "-f", "exec-server --listen ws://127.0.0.1:"], { encoding: "utf8" }).stdout.trim().split("\n")[0] || 0);
  const ps = executor ? spawnSync("/bin/ps", ["eww", "-o", "command=", "-p", String(executor)], { encoding: "utf8" }).stdout : "";
  const l = { exec: Number(/--listen ws:\/\/127\.0\.0\.1:(\d+) /.exec(ps)?.[1] ?? 0), block: (/PORTS=([\d,]+)/.exec(ps)?.[1] ?? "").split(",").filter(Boolean).map(Number) };
  const sleeper = Number(spawnSync("/usr/bin/pgrep", ["-f", "^/bin/sleep 4312$"], { encoding: "utf8" }).stdout.trim().split("\n")[0] || 0);
  process.stdout.write(`${JSON.stringify({ app: handle.pid, appPgid: handle.pgid, appStart: handle.startedAt, executor, exec: l.exec, block: l.block, listen: pidIn("pid_listen"), sleeper })}\n`);
  await handle.done;
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
});
