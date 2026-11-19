// DEVELOPMENT TOOL. Launches real agents, which spend your Claude and ChatGPT usage.
//
// A persistent root session for driving relay from a shell, for hosts that do not have relay's
// tools loaded. A root's run lives as long as its MCP server process, so follow-up calls
// (resume, approve, discuss with earlier jobs) must go through the same process.
//
//   node smoke/root.mjs serve [<socket-path>]          keep one root instance alive
//   node smoke/root.mjs call <socket-path> <tool> '<json args>'
//
// RELAY_SMOKE_HOST=<target id> (claude, codex) makes the root speak as a session of that family. It is
// required by this development tool so default routing exercises the chosen family.
//
// RELAY_HOME is required too, for serve, and may not be the default ~/.local/state/relay: the root
// opens the registry there, and a newer build migrates it (smoke/guard.mjs).
//
// The socket carries a root session's full authority, approving requests included. It is not
// an isolated channel: anything running as you that can reach the socket can use it. By default
// it is created in a private directory inside relay's control directory. Both commands refuse a
// socket whose directory is not yours alone (mode 700), since whoever can write to the directory
// can replace the socket.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scratchHome } from "./guard.mjs";

const [mode, given, tool, raw = "{}"] = process.argv.slice(2);
// Before anything else: serve starts relay, which opens (and may migrate) the registry under RELAY_HOME.
const scratch = mode === "serve" ? scratchHome() : null;
const { TARGET_IDS } = await import(path.resolve(import.meta.dirname, "..", "dist", "targets", "index.js"));
if (!TARGET_IDS.includes(process.env.RELAY_SMOKE_HOST ?? "")) {
  console.error(`Set RELAY_SMOKE_HOST to the family this root speaks as (${TARGET_IDS.join(", ")}): relay refuses a root whose family it cannot tell.`);
  process.exit(2);
}
const host = ["--host", process.env.RELAY_SMOKE_HOST];
// Run from a Claude Code session, the environment carries that session's inbox. Relay posts notices
// only from Claude Code itself, but the root started here is not that session and must not post there.
const rootEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDE_CODE_MESSAGING_SOCKET" && k !== "CLAUDE_CODE_MESSAGING_TOKEN"));
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/**
 * The socket's directory must be the user's own and closed to everyone else. Whoever can write
 * to the directory can replace the socket, whatever the socket's own mode, and a caller has no
 * other way to know what it is connecting to.
 */
function privateDir(sock) {
  let dir;
  try {
    dir = fs.realpathSync(path.dirname(sock));
  } catch {
    return `${path.dirname(sock)} does not exist`;
  }
  const st = fs.statSync(dir);
  if (st.uid !== process.getuid()) return `${dir} is not owned by you`;
  if ((st.mode & 0o077) !== 0) return `${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}); it must be 700`;
  return null;
}

/** True when something is listening on the socket right now. */
const listening = (sock) => new Promise((resolve) => {
  const probe = net.connect(sock);
  probe.on("connect", () => {
    probe.destroy();
    resolve(true);
  });
  probe.on("error", () => resolve(false));
});

if (mode === "serve") {
  const cli = path.resolve(import.meta.dirname, "..", "dist", "cli.js");
  const sock = given ?? path.join(scratch, "dev", `root-${process.pid}.sock`);
  // Created private if it is new. An existing directory is checked, not trusted.
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  const unsafe = privateDir(sock);
  if (unsafe) fail(`not serving on ${sock}: ${unsafe}`);
  const existing = fs.existsSync(sock) ? fs.lstatSync(sock) : null;
  if (existing && !existing.isSocket()) fail(`${sock} exists and is not a socket; choose another path`);
  // Another root may be serving here. Only a socket nothing answers on is a leftover.
  if (existing && (await listening(sock))) fail(`another root session is already serving on ${sock}`);
  if (existing) fs.rmSync(sock);
  const client = new Client({ name: process.env.RELAY_SMOKE_HOST === "claude" ? "claude-code" : process.env.RELAY_SMOKE_HOST === "codex" ? "codex-mcp-client" : "relay-smoke-unknown", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", ...host], env: rootEnv, cwd: process.cwd() }));
  process.umask(0o077);
  net.createServer({ allowHalfOpen: true }, (conn) => {
    // A caller that goes away mid-call must not take the root session down with it.
    conn.on("error", () => {});
    let buf = "";
    conn.on("data", (d) => (buf += d));
    conn.on("end", async () => {
      try {
        const { tool, args } = JSON.parse(buf);
        const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 3600000 });
        conn.end(res.content[0].text);
      } catch (err) {
        conn.end(JSON.stringify({ error: String(err.message ?? err) }));
      }
    });
  }).listen(sock, () => console.log(`relay root listening on ${sock}`));
} else if (mode === "call") {
  if (!given) fail("usage: node smoke/root.mjs call <socket> <tool> '<json>'");
  const unsafe = privateDir(given);
  if (unsafe) fail(`not connecting to ${given}: ${unsafe}`);
  const conn = net.connect(given, () => conn.end(JSON.stringify({ tool, args: JSON.parse(raw) })));
  let out = "";
  conn.on("error", (err) => fail(`could not reach a root session on ${given}: ${err.message}`));
  conn.on("data", (d) => (out += d));
  conn.on("end", () => console.log(out));
} else {
  fail("usage: node smoke/root.mjs serve [<socket>] | call <socket> <tool> '<json>'");
}
