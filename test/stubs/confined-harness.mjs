// A stand-in for a harness run under relay's sandbox. Its MCP server is the bridge command it is
// given; it takes one JSON command per stdin line and answers each with one JSON line:
//   {"op":"call","tool":..,"args":..}   call a relay tool over the bridge it started with
//   {"op":"fresh","tool":..,"args":..}  the same through a newly spawned bridge
//   {"op":"probe","probes":{name:[kind, path]}}  try things the sandbox should allow or deny
// usage: node confined-harness.mjs '<{"bridge":{command,args}}>'
import fs from "node:fs";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const plan = JSON.parse(process.argv[2]);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

async function connect() {
  const client = new Client({ name: "confined-harness", version: "0" });
  // The bridge's environment is the entry's own (the turn's secret) plus what a harness's MCP child inherits.
  await client.connect(new StdioClientTransport({ command: plan.bridge.command, args: plan.bridge.args, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...(plan.bridge.env ?? {}) }, stderr: "ignore" }));
  return client;
}

async function call(client, tool, args) {
  try {
    const res = await client.callTool({ name: tool, arguments: args ?? {} }, undefined, { timeout: 60000 });
    return JSON.parse(res.content[0].text);
  } catch (err) {
    return { rpc_error: err.message, code: err.code };
  }
}

const probes = {
  write: (p) => fs.appendFileSync(p, "x"),
  read: (p) => fs.readFileSync(p),
  list: (p) => fs.readdirSync(p),
  sqlite: async (p) => {
    const { DatabaseSync } = await import("node:sqlite");
    new DatabaseSync(p).prepare("SELECT count(*) FROM nodes").get();
  },
  connect: (p) => new Promise((resolve, reject) => {
    const s = net.connect(p);
    s.on("connect", () => { s.destroy(); resolve(); });
    s.on("error", reject);
  }),
};

let first;
// The broker test pins this harness after spawn, before the harness opens its bridge.
if (plan.waitForStart) await new Promise((resolve) => process.stdin.once("data", resolve));
try {
  first = await connect();
} catch (err) {
  out({ error: `could not start the bridge: ${err.message}` });
  process.exit(1);
}
out({ ready: true, pid: process.pid });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const cmd = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (cmd.op === "call") out(await call(first, cmd.tool, cmd.args));
    else if (cmd.op === "tools") out({ tools: (await first.listTools()).tools.map((t) => t.name).sort() });
    else if (cmd.op === "fresh") {
      try {
        const c = await connect();
        out(await call(c, cmd.tool, cmd.args));
        await c.close();
      } catch (err) {
        out({ rpc_error: err.message, code: err.code });
      }
    } else if (cmd.op === "probe") {
      const r = {};
      for (const [name, [kind, p]] of Object.entries(cmd.probes)) {
        try {
          await probes[kind](p);
          r[name] = "allowed";
        } catch (err) {
          r[name] = err.code ?? err.message;
        }
      }
      out(r);
    }
  }
});
process.stdin.on("end", async () => {
  await first.close().catch(() => {});
  process.exit(0);
});
