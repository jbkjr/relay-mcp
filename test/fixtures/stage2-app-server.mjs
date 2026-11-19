// Model-free stdio app server for BB lifecycle unit tests. No listeners or child processes.
import fs from "node:fs";
import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const note = (method, params) => send({ method, params });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  fs.appendFileSync(process.env.BB_EVENTS, m.method + "\n");
  let result = {};
  if (m.method === "config/read") result = { config: JSON.parse(process.env.BB_CONFIG) };
  if (m.method === "configRequirements/read") result = { requirements: null };
  if (m.method === "thread/start" || m.method === "thread/resume") {
    if (process.env.BB_SELF_START) note("turn/started", { threadId: "thread", turn: { id: "self" } });
    result = { thread: { id: "thread" }, activePermissionProfile: { id: ":danger-full-access" }, sandbox: { type: "dangerFullAccess" } };
  }
  if (m.method === "turn/start") {
    note("turn/started", { threadId: "thread", turn: { id: "turn" } });
    result = { turn: { id: "turn" } };
  }
  if (m.method === "bb/complete") note("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
  send({ id: m.id, result });
}
