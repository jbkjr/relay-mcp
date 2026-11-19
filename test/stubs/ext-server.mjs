// A stand-in for an MCP server the person allows launched agents to use (an extension, relay's
// mcp.json). It records every call it is sent in $EXT_LOG, so that a test can tell exactly what
// reached it, and when: relay must forward nothing before the person allows it.
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const record = (entry) => {
  if (process.env.EXT_LOG) fs.appendFileSync(process.env.EXT_LOG, JSON.stringify({ t: Date.now(), ...entry }) + "\n");
};

const server = new McpServer({ name: "ext", version: "0" });
server.registerTool("echo", {
  description: "Echoes the text back.",
  inputSchema: { text: z.string().describe("What to echo") },
  annotations: { readOnlyHint: true },
}, async ({ text }) => {
  record({ tool: "echo", args: { text } });
  return { content: [{ type: "text", text: JSON.stringify({ echoed: text }) }] };
});
server.registerTool("send", {
  description: "Sends a message to someone.",
  inputSchema: { to: z.string(), body: z.string(), urgent: z.boolean().optional() },
}, async (args) => {
  record({ tool: "send", args });
  return { content: [{ type: "text", text: JSON.stringify({ sent_to: args.to }) }] };
});

record({ started: true, secret: process.env.EXT_SECRET ?? null, relay_vars: Object.keys(process.env).filter((k) => k.startsWith("RELAY_")) });
await server.connect(new StdioServerTransport());
