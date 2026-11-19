// A stand-in MCP server whose tool list holds what relay's gateway must not offer as given: a tool
// listed twice, a name too long for either harness, an input schema relay reads as something other
// than an object (a union), and one relay cannot read at all (a reference to nothing). Each is valid
// MCP, so the client takes the list. Next to them, one tool relay can offer (ok).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const object = { type: "object", properties: { text: { type: "string" } } };
const server = new Server({ name: "odd", version: "0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "ok", description: "A tool relay can offer.", inputSchema: object },
    { name: "ok", description: "The same name again.", inputSchema: object },
    { name: "x".repeat(70), description: "A name too long.", inputSchema: object },
    { name: "union", description: "One of two shapes.", inputSchema: { type: "object", oneOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "number" } } }] } },
    { name: "dangling", description: "A reference to nothing.", inputSchema: { type: "object", properties: { a: { $ref: "#/$defs/nope" } } } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: "text", text: JSON.stringify({ called: req.params.name }) }] }));
await server.connect(new StdioServerTransport());
