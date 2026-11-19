// DEVELOPMENT TOOL. Spends no model usage: Claude Code talks to a stub model on loopback.
//
// What it proves: that a Claude job with a network grant, launched by this build of relay exactly as
// relay launches it (its argv, settings and environment), reaches nothing on this machine or its
// local network, by any route its shell or Claude's WebFetch has, and still reaches the public
// internet. It runs the installed Claude Code (or CLAUDE_BIN) against a stub of Anthropic's Messages
// API that plays a fixed list of tool calls: one Bash call running a probe script inside Claude
// Code's sandbox, then WebFetch calls. The targets are scratch listeners this tool starts on random
// ports (127.0.0.1, ::1, this machine's LAN address, a Unix socket in its own temp directory); each
// listener records every connection, which is the evidence. No other local service is touched.
//
//   RELAY_HOME=~/relay-smoke node smoke/claude-network-probe.mjs [--control port|noproxy|modelbypass|collision] [--stub-host <name>] [--no-public]
//
// The routes: plain HTTP, CONNECT and SOCKS5 through the sandbox's proxy, to loopback and LAN
// literals in every spelling, to [::1], and to public names that resolve to loopback; a direct Unix
// socket and direct TCP; WebFetch to loopback, LAN and such a name. The public checks (https, http,
// a public IP literal, git over https, ssh's banner through SOCKS, WebFetch) need the internet;
// --no-public skips them.
//
// What it changes in relay's launch: a wrapper set as targets.claude.bin points Claude at the stub
// (ANTHROPIC_BASE_URL, a dummy API key, so the config sets child_auth "any"). The stub's name is
// `model.relay-probe.invalid` (or --stub-host): Claude sends its model requests to http://<that name>,
// through relay's proxy, which serves them from the stub for this run only (relay started with
// RELAY_DEV_MODEL_STUB=1 and dev/claude-model-stub.json in the scratch RELAY_HOME, which the tool
// removes afterwards; plain HTTP with the turn's token only). The controls
// change one more thing each, and relay must then stop the job: `--control port` reports another
// proxy port to Claude Code's sandbox (as managed settings could), which relay must stop as soon as
// the sandbox reports it, before Claude's first model request; `--control noproxy` exempts
// everything from the proxy (the stub reached directly on loopback); `--control modelbypass` exempts
// only the model requests (NO_PROXY naming the stub's loopback address), while Claude's other
// requests to the model host still go through the proxy. Relay must stop those two at the start of
// Claude's first response. `--control collision` is modelbypass with the stub named
// api.anthropic.com, as in production: Claude's requests to api.anthropic.com at start (HTTPS) go to
// Anthropic through the proxy, its model requests do not. Relay's check does not catch that (a
// known limit, docs/known-limits.md), so this control reports it, not stopped, and does not fail; it still
// requires that no listener was reached. The bypass controls set NO_PROXY in
// relay's settings file too, whose env would otherwise empty it. Run with RELAY_HOME naming a scratch
// state directory (smoke/guard.mjs); relay's config for the run is written to the tool's own temp
// directory (RELAY_CONFIG).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scratchHome } from "./guard.mjs";

const home = scratchHome();
const args = process.argv.slice(2);
const control = args.includes("--control") ? args[args.indexOf("--control") + 1] : null;
if (control && !["port", "noproxy", "modelbypass", "collision"].includes(control)) throw new Error("--control is port, noproxy, modelbypass or collision");
const pub = !args.includes("--no-public");
// The collision control is modelbypass under Anthropic's own host name (see the top of this file).
const MODEL_HOST = control === "collision" ? "api.anthropic.com" : args.includes("--stub-host") ? args[args.indexOf("--stub-host") + 1] : "model.relay-probe.invalid";
const claudeBin = process.env.CLAUDE_BIN ?? spawnSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
if (!claudeBin) throw new Error("no claude on PATH; set CLAUDE_BIN");
// Short: Unix socket paths are limited to 103 bytes, and relay's own sockets go under TMPDIR.
const dir = fs.realpathSync(fs.mkdtempSync("/tmp/rcp."));
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address ?? null;
const hits = [];
const servers = [];

// ---- Scratch listeners: each records the path of a plain request, or "TLS" for a TLS handshake (WebFetch upgrades to https).
async function listener(tag, host) {
  const s = net.createServer((c) => {
    c.on("error", () => {});
    c.once("data", (d) => {
      const first = d.toString("latin1");
      const what = d[0] === 0x16 ? "TLS" : (/^\w+ (\S+)/.exec(first)?.[1] ?? "?");
      hits.push({ tag, what });
      c.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nPONG-${tag}\n`);
    });
  });
  await new Promise((r) => s.listen(0, host, r));
  servers.push(s);
  return s.address().port;
}
const port = {};
for (const [tag, host] of [["v4", "127.0.0.1"], ["v6", "::1"], ["wf4", "127.0.0.1"], ["wfn", "127.0.0.1"], ...(lan ? [["lan", lan], ["wfl", lan]] : [])]) port[tag] = await listener(tag, host);
const sock = path.join(dir, "u.sock");
servers.push(net.createServer((c) => (hits.push({ tag: "unix", what: "connect" }), c.end("PONG-unix\n"))).listen(sock));

// ---- The probe script, run by the stub's Bash call inside Claude Code's sandbox. One line per route: "<id>: <output>".
const routes = [];
const probe = ["#!/bin/sh", 'r() { id=$1; shift; out=$("$@" </dev/null 2>&1 | tr "\\n" " " | cut -c1-160); echo "$id: $out"; }', 'export SOCKS="${FTP_PROXY:-$ALL_PROXY}"'];
const route = (id, what, cmd, expect = "refused") => {
  routes.push({ id, what, expect });
  probe.push(`r ${id} ${cmd}`);
};
const v4 = port.v4, v6 = port.v6;
route("direct-v4", "direct TCP 127.0.0.1", `curl -sS -m 4 --noproxy '*' http://127.0.0.1:${v4}/p/direct-v4`);
if (lan) route("direct-lan", `direct TCP ${lan}`, `curl -sS -m 4 --noproxy '*' http://${lan}:${port.lan}/p/direct-lan`);
route("unix", "Unix socket in /tmp", `/usr/bin/nc -w 3 -U ${sock}`);
const hosts = [["127.0.0.1", v4], ["localhost", v4], ["[::1]", v6], ["0.0.0.0", v4], ["127.1", v4], ["2130706433", v4], ["[::ffff:127.0.0.1]", v4], ["[::ffff:7f00:1]", v4], ["127.0.0.1.", v4], ["localtest.me", v4], ["127.0.0.1.nip.io", v4], ...(lan ? [[lan, port.lan]] : [])];
hosts.forEach(([h, p], i) => route(`http-${i}`, `HTTP via proxy to ${h}`, `curl -sS -m 6 --noproxy '' -g http://${h}:${p}/p/http-${i}`));
hosts.forEach(([h, p], i) => route(`conn-${i}`, `CONNECT via proxy to ${h}`, `curl -sS -m 6 --noproxy '' -g -p http://${h}:${p}/p/conn-${i}`));
hosts.forEach(([h, p], i) => route(`socks-${i}`, `SOCKS5h to ${h}`, `curl -sS -m 6 --noproxy '' -g -x "$SOCKS" http://${h}:${p}/p/socks-${i}`));
if (pub) {
  route("pub-https", "public https (github.com)", "curl -sS -m 15 -o /dev/null -w %{http_code} https://github.com/robots.txt", "200");
  route("pub-http", "public plain http (example.com)", "curl -sS -m 15 -o /dev/null -w %{http_code} http://example.com", "200");
  route("pub-ip", "public IP literal (1.1.1.1)", "curl -sS -m 15 -o /dev/null -w %{http_code} https://1.1.1.1", "301");
  route("pub-git", "git ls-remote over https", "git ls-remote https://github.com/git/git HEAD", "HEAD");
  route("pub-ssh", "ssh banner through SOCKS (github.com:22)", `sh -c 'H=$(echo "$SOCKS" | sed "s#^.*://##; s#^.*@##"); (sleep 4) | /usr/bin/nc -X 5 -x "$H" -w 6 github.com 22 2>/dev/null | head -c 12'`, "SSH-2.0");
}
fs.writeFileSync(path.join(dir, "probe.sh"), probe.join("\n") + "\necho probe-done\n", { mode: 0o755 });

// ---- The stub model.
const fetches = [["wf-v4", "WebFetch to 127.0.0.1", `http://127.0.0.1:${port.wf4}/w`, "wf4"], ["wf-name", "WebFetch to localtest.me (resolves to loopback)", `http://localtest.me:${port.wfn}/w`, "wfn"], ...(lan ? [["wf-lan", `WebFetch to ${lan}`, `http://${lan}:${port.wfl}/w`, "wfl"]] : [])];
const steps = [{ name: "Bash", input: { command: `sh ${path.join(dir, "probe.sh")}`, description: "probe" } }, ...fetches.map(([, , url]) => ({ name: "WebFetch", input: { url, prompt: "Return the text." } })), ...(pub ? [{ name: "WebFetch", input: { url: "https://example.com/", prompt: "Return the text." } }] : [])];
const results = [];
const debug = [];
let modelRequests = 0;
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
      res.writeHead(req.url.includes("count_tokens") ? 200 : 404, { "content-type": "application/json" });
      return res.end(req.url.includes("count_tokens") ? '{"input_tokens":1}' : '{"type":"error","error":{"type":"not_found_error","message":"stub"}}');
    }
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const msgs = j.messages ?? [];
    const last = msgs.at(-1);
    // Each step's result, by its call's id, from wherever in the conversation it is (Claude may append a note after it).
    for (const m of msgs) for (const b of Array.isArray(m.content) ? m.content : []) {
      const n = b.type === "tool_result" ? /^toolu_p(\d+)$/.exec(b.tool_use_id ?? "")?.[1] : undefined;
      if (n !== undefined) results[Number(n)] = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
    }
    const withTools = (j.tools ?? []).some((t) => t.name === "Bash");
    if (process.env.PROBE_DEBUG) debug.push({ tools: (j.tools ?? []).map((t) => t.name).join(","), msgs: msgs.length, last: JSON.stringify(last?.content).slice(0, 200) });
    if (withTools) modelRequests++;
    const done = msgs.filter((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use")).length;
    const text = (c) => (typeof c === "string" ? c : (c ?? []).map((b) => b.text ?? "").join("\n"));
    const block = withTools && done < steps.length ? { type: "tool_use", id: `toolu_p${done}`, ...steps[done] } : { type: "text", text: withTools ? "done" : `echo: ${text(last?.content).slice(0, 400)}` };
    const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
    const msg = { id: `msg_p${done}`, type: "message", role: "assistant", model: j.model ?? "stub", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!j.stream) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...msg, content: [block], stop_reason: stop }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: msg });
    ev("content_block_start", { index: 0, content_block: block.type === "tool_use" ? { type: "tool_use", id: block.id, name: block.name, input: {} } : { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
    ev("message_stop", {});
    res.end();
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
servers.push(stub);
const stubPort = stub.address().port;

// ---- The wrapper relay launches as Claude, and relay's config for the run.
const direct = control === "noproxy" || control === "modelbypass" || control === "collision";
const fix = `const fs=require("fs");const [f,mode,stub]=process.argv.slice(1);const s=JSON.parse(fs.readFileSync(f,"utf8"));s.env??={};` +
  `if(mode==="noproxy"||mode==="modelbypass"||mode==="collision"){const n=mode==="noproxy"?"*":"127.0.0.1:"+stub;s.env.NO_PROXY=s.env.no_proxy=n;process.stdout.write(n)}` +
  `if(mode==="port"&&s.sandbox?.network?.httpProxyPort)s.sandbox.network.httpProxyPort+=1;fs.writeFileSync(f,JSON.stringify(s))`;
const wrapper = path.join(dir, "claude");
fs.writeFileSync(wrapper, `#!/bin/sh
# claude-network-probe: relay's own launch of Claude Code, pointed at the stub model.
[ "$1" = "--version" ] && exec ${JSON.stringify(claudeBin)} "$@"
prev=""; for a in "$@"; do [ "$prev" = "--settings" ] && SF="$a"; prev="$a"; done
N=$(${JSON.stringify(process.execPath)} -e ${JSON.stringify(fix).replaceAll("$", "\\$")} "$SF" ${JSON.stringify(control ?? "-")} ${stubPort})
export ANTHROPIC_BASE_URL=${direct ? `http://127.0.0.1:${stubPort}` : `http://${MODEL_HOST}`} ANTHROPIC_API_KEY=sk-ant-stub-0000
[ -n "$N" ] && export NO_PROXY="$N" no_proxy="$N"
exec ${JSON.stringify(claudeBin)} "$@"
`, { mode: 0o755 });
// The stub, served by relay's proxy for this run (see the top of this file).
const stubFile = path.join(home, "dev", "claude-model-stub.json");
fs.mkdirSync(path.dirname(stubFile), { recursive: true, mode: 0o700 });
const before = fs.existsSync(stubFile) ? fs.readFileSync(stubFile) : null;
fs.writeFileSync(stubFile, JSON.stringify({ host: MODEL_HOST, port: stubPort }));
const restore = () => (before ? fs.writeFileSync(stubFile, before) : fs.rmSync(stubFile, { force: true }));
process.on("exit", restore);
const configFile = path.join(dir, "config.json");
fs.writeFileSync(configFile, JSON.stringify({ escalation: false, targets: { claude: { bin: wrapper, child_auth: "any" } } }));
const repo = path.join(dir, "repo");
fs.mkdirSync(repo);
for (const a of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "probe"]]) spawnSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", ...a], { cwd: repo });

// ---- One delegate through relay, from a root speaking as Codex.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RELAY_") && !k.startsWith("CLAUDE_CODE_MESSAGING")));
Object.assign(env, { RELAY_HOME: home, RELAY_CONFIG: configFile, RELAY_DEV_MODEL_STUB: "1", TMPDIR: path.join(dir, "t") });
fs.mkdirSync(env.TMPDIR);
const client = new Client({ name: "codex-mcp-client", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve(import.meta.dirname, "..", "dist", "cli.js"), "mcp", "--host", "codex"], env, cwd: repo }));
const call = async (name, a) => JSON.parse((await client.callTool({ name, arguments: a }, undefined, { timeout: 600000 })).content[0].text);
const started = await call("delegate", { target: "claude", task: "network probe (stub model)", mode: "read", grant: { network: true }, background: true });
if (!started.job_id) throw new Error(`relay did not start the job: ${JSON.stringify(started)}`);
let job = { status: "running" };
for (let i = 0; i < 20 && !["done", "failed", "cancelled", "interrupted"].includes(job.status); i++) job = await call("status", { id: started.job_id, wait_s: 30 });
await client.close();
await new Promise((r) => setTimeout(r, 500));
for (const s of servers) s.close();

// ---- The verdict.
const out = results.join("\n");
const lineOf = (id) => new RegExp(`^${id}: (.*)$`, "m").exec(out)?.[1]?.trim() ?? null;
const rows = [];
let bad = 0;
const row = (what, verdict, evidence, ok) => (rows.push([ok ? "ok " : "BAD", what, verdict, evidence]), ok || bad++);
if (control === "collision") {
  // A known limit (docs/known-limits.md; review C1), not a failure: relay's check sees a token request
  // to api.anthropic.com (Claude's own, at start) and cannot tell that the model requests went around
  // the proxy. Shown here so that a change either way is seen. The shell is still confined.
  const stopped = job.status === "failed" && /model requests did not go through relay's proxy/.test(job.error ?? "");
  row("control collision: known limit (C1), not a failure", stopped ? "stopped (the limit no longer holds)" : `not stopped (${job.status})`, String(job.error ?? "").slice(0, 120), true);
  row("control: no listener reached", `${hits.length} hits`, JSON.stringify(hits), hits.length === 0);
} else if (control) {
  const want = control === "port" ? /proxy port other than relay's/ : /model requests did not go through relay's proxy/;
  row(`control ${control}: relay refuses the job`, job.status, String(job.error ?? "").slice(0, 120), job.status === "failed" && want.test(job.error ?? ""));
  // Claude Code starts its sandbox, and reports its ports, before its first model request: stopped before any.
  if (control === "port") row("control port: stopped before any model request", `${modelRequests} model requests`, "", modelRequests === 0);
  // The bypass controls: stopped at the start of Claude's first response, before the tool in it (the probe script) could run.
  else row(`control ${control}: stopped before the first tool ran`, `${results.filter((r) => r !== undefined).length} tool results`, "", results.filter((r) => r !== undefined).length === 0);
  row("control: no listener reached", `${hits.length} hits`, JSON.stringify(hits), hits.length === 0);
} else {
  row("the job ran", job.status, String(job.error ?? "").slice(0, 120), job.status === "done");
  for (const r of routes) {
    const hit = hits.find((h) => h.what === `/p/${r.id}`) ?? (r.id === "unix" ? hits.find((h) => h.tag === "unix") : null);
    const said = lineOf(r.id);
    if (r.expect === "refused") row(r.what, hit ? "REACHED" : said === null ? "not run" : "refused", (said ?? "").slice(0, 90), !hit && said !== null);
    else row(r.what, said?.includes(r.expect) ? "works" : "failed", (said ?? "").slice(0, 90), Boolean(said?.includes(r.expect)));
  }
  fetches.forEach(([, what, , tag], i) => {
    const hit = hits.find((h) => h.tag === tag);
    row(what, hit ? `REACHED (${hit.what})` : "refused", (results[i + 1] ?? "not run").slice(0, 90).replace(/\s+/g, " "), !hit && results[i + 1] !== undefined);
  });
  if (pub) {
    const r = results[fetches.length + 1] ?? "";
    row("WebFetch to https://example.com", /Example Domain/.test(r) ? "works" : "failed", r.slice(0, 90).replace(/\s+/g, " "), /Example Domain/.test(r));
  }
  const stray = hits.filter((h) => !routes.some((r) => h.what === `/p/${r.id}`) && !["unix", "wf4", "wfn", "wfl"].includes(h.tag));
  row("no other listener hits", `${stray.length}`, JSON.stringify(stray), stray.length === 0);
}
console.log(`claude network probe: ${claudeBin} (${spawnSync(claudeBin, ["--version"], { encoding: "utf8" }).stdout.trim()}), job ${started.job_id}, ${control ? `control ${control}` : "routes"}, model host ${MODEL_HOST}`);
for (const r of rows) console.log(r.join(" | "));
if (process.env.PROBE_DEBUG) console.log(JSON.stringify({ results, hits, debug }, null, 1));
console.log(bad ? `${bad} check(s) failed` : "all checks passed");
fs.rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
