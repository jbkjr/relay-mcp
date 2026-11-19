// DEVELOPMENT TOOL. Launches real agents, which spend your Claude and ChatGPT usage.
//
// One-shot root client for smoke testing: node smoke/call.mjs <tool> '<json args>'
// Starts `relay mcp` in the current directory as a root instance, calls one tool, and for
// pending handles keeps polling status until the item finishes.
// RELAY_SMOKE_HOST=<target id> (claude, codex) makes the root speak as a session of that family. It is
// required by this development tool so default routing exercises the chosen family.
// RELAY_HOME is required too, and may not be the default ~/.local/state/relay: the root opens the
// registry there, and a newer build migrates it (smoke/guard.mjs).
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scratchHome } from "./guard.mjs";

scratchHome();

const cli = path.resolve(import.meta.dirname, "..", "dist", "cli.js");
const [tool, raw = "{}"] = process.argv.slice(2);
const { TARGET_IDS } = await import(path.resolve(import.meta.dirname, "..", "dist", "targets", "index.js"));
if (!TARGET_IDS.includes(process.env.RELAY_SMOKE_HOST ?? "")) {
  console.error(`Set RELAY_SMOKE_HOST to the family this root speaks as (${TARGET_IDS.join(", ")}): relay refuses a root whose family it cannot tell.`);
  process.exit(2);
}
const host = ["--host", process.env.RELAY_SMOKE_HOST];
// Run from a Claude Code session, the environment carries that session's inbox. Relay posts notices
// only from Claude Code itself, but the root started here is not that session and must not post there.
const rootEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDE_CODE_MESSAGING_SOCKET" && k !== "CLAUDE_CODE_MESSAGING_TOKEN"));
const client = new Client({ name: process.env.RELAY_SMOKE_HOST === "claude" ? "claude-code" : process.env.RELAY_SMOKE_HOST === "codex" ? "codex-mcp-client" : "relay-smoke-unknown", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", ...host], env: rootEnv, cwd: process.cwd() }));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, { timeout: 3600000 })).content[0].text);
let out = await call(tool, JSON.parse(raw));
while (out.pending && !process.env.NO_WAIT) out = await call("status", { id: out.id, wait_s: 200 });
console.log(JSON.stringify(out, null, 2));
await client.close();
