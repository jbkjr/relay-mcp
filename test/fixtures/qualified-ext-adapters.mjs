// Qualified semantics for these checked-in decoys only. echo/send append a local log and return
// JSON; "send" does NOT contact a recipient. odd returns JSON with no external effects.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { neverDigest } from "../../dist/core/never-policy.js";

const stub = (name) => fileURLToPath(new URL(`../stubs/${name}`, import.meta.url));
const schema = (shape) => z.toJSONSchema(z.object(shape), { target: "draft-7", io: "input" });
const object = { type: "object", properties: { text: { type: "string" } } };
const tools = new Map([
  [stub("ext-server.mjs"), [
    { name: "echo", inputSchema: schema({ text: z.string().describe("What to echo") }) },
    { name: "send", inputSchema: schema({ to: z.string(), body: z.string(), urgent: z.boolean().optional() }) },
  ]],
  [stub("ext-odd-server.mjs"), [
    { name: "ok", inputSchema: object },
    { name: "x".repeat(70), inputSchema: object },
    { name: "union", inputSchema: { type: "object", oneOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "number" } } }] } },
    { name: "dangling", inputSchema: { type: "object", properties: { a: { $ref: "#/$defs/nope" } } } },
  ]],
  // This process exits before initialization; the placeholder only admits its startup failure.
  [stub("ext-broken-server.mjs"), [{ name: "unavailable", inputSchema: { type: "object" } }]],
]);

export function qualifiedFixtureAdapters(definitions) {
  return Object.entries(definitions).flatMap(([server, def]) => {
    if (def.command !== process.execPath || def.args?.length !== 1 || !path.isAbsolute(def.args[0])) return [];
    const qualified = tools.get(def.args[0]);
    if (!qualified) return [];
    return qualified.map(({ name, inputSchema }) => ({
      identity: { server, version: "0", definitionHash: neverDigest(def), tool: name, schemaHash: neverDigest(inputSchema) },
      normalize: (args) => ({ complete: true, arguments: args, effects: def.env?.EXT_LOG ? [{ kind: "path", path: def.env.EXT_LOG, access: "write" }] : [] }),
    }));
  });
}
