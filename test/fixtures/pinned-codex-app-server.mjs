// Model-free stdio fixture: no listeners, network, credentials, or descendant processes.
import fs from "node:fs";
import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
fs.writeFileSync(process.env.PC_APP_CAPTURE, JSON.stringify({ bin: process.argv[1], home: process.env.CODEX_HOME }));
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === "approval") {
    fs.appendFileSync(process.env.PC_APP_CAPTURE, "\n" + JSON.stringify(m.result));
    send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
    continue;
  }
  if (m.id === undefined) continue;
  let result = {};
  if (m.method === "config/read") result = { config: JSON.parse(process.env.PC_APP_CONFIG) };
  if (m.method === "configRequirements/read") result = { requirements: null };
  if (m.method === "skills/list") result = { data: [] };
  if (m.method === "thread/start") result = { thread: { id: "thread" }, activePermissionProfile: { id: "relay" }, runtimeWorkspaceRoots: [m.params.cwd], sandbox: { type: "readOnly", networkAccess: false } };
  if (m.method === "turn/start") {
    result = { turn: { id: "turn" } };
    send({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
  }
  send({ id: m.id, result });
  if (m.method === "turn/start") send({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", command: "ordinary command asking to leave the sandbox" } });
}
