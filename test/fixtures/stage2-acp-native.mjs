#!/usr/bin/env node
// A deterministic ACP-v1 agent for host qualification of relay's generic adapter. It has no
// provider, model or credentials: its prompt is a fixed probe plan, and every operation is made
// by this process inside relay's production ACP confinement.
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let sessionId = "stage2-acp-native";

const errorCode = (error) => String(error?.code ?? error?.message ?? error);
const direct = (host, port, payload = "probe\n") => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  let data = "", settled = false;
  const done = (answer) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(answer);
  };
  socket.setTimeout(3000, () => done({ ok: false, code: "ETIMEDOUT" }));
  socket.once("connect", () => socket.write(payload));
  socket.on("data", (chunk) => {
    data += chunk;
    if (data.includes("\n") || data.includes("ALLOWED")) done({ ok: true, data: data.slice(0, 120) });
  });
  socket.once("error", (error) => done({ ok: false, code: errorCode(error) }));
  socket.once("close", () => done(data ? { ok: true, data: data.slice(0, 120) } : { ok: false, code: "ECONNCLOSED" }));
});

// ACP's network-off route gives the harness an authenticated HTTP proxy. Use CONNECT directly so
// the fixture neither prints the credential nor depends on a library's environment-proxy support.
const tunnel = (host, port, payload = "probe\n") => new Promise((resolve) => {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!raw) return resolve({ ok: false, code: "NO_PROXY" });
  const proxy = new URL(raw);
  const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
  const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
  let data = "", established = false, settled = false;
  const done = (answer) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(answer);
  };
  socket.setTimeout(3000, () => done({ ok: false, code: "ETIMEDOUT" }));
  socket.once("connect", () => socket.write(
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${auth}\r\nConnection: close\r\n\r\n`,
  ));
  socket.on("data", (chunk) => {
    data += chunk;
    if (!established) {
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = data.slice(0, end);
      data = data.slice(end + 4);
      if (!/^HTTP\/1\.[01] 200\b/.test(head)) return done({ ok: false, code: /^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? "BAD_PROXY_REPLY" });
      established = true;
      socket.write(payload);
    }
    if (established && (data.includes("\n") || data.includes("ALLOWED"))) done({ ok: true, data: data.slice(0, 120) });
  });
  socket.once("error", (error) => done({ ok: false, code: errorCode(error) }));
  socket.once("close", () => done(established && data ? { ok: true, data: data.slice(0, 120) } : { ok: false, code: established ? "ECONNCLOSED" : "NO_PROXY_REPLY" }));
});

const connectOnly = (host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const done = (answer) => { socket.destroy(); resolve(answer); };
  socket.setTimeout(5000, () => done({ ok: false, code: "ETIMEDOUT" }));
  socket.once("connect", () => done({ ok: true }));
  socket.once("error", (error) => done({ ok: false, code: errorCode(error) }));
});

async function probe(plan) {
  const evidence = { mode: plan.mode, files: {}, allowed: null, services: [] };
  try { evidence.files.allowedRead = fs.readFileSync(plan.allowedFile, "utf8"); }
  catch (error) { evidence.files.allowedRead = `ERROR:${errorCode(error)}`; }
  try { evidence.files.forbiddenRead = fs.readFileSync(plan.forbiddenFile, "utf8"); }
  catch (error) { evidence.files.forbiddenRead = `ERROR:${errorCode(error)}`; }
  try { fs.writeFileSync(plan.forbiddenFile, "changed by ACP fixture\n"); evidence.files.forbiddenWrite = "WROTE"; }
  catch (error) { evidence.files.forbiddenWrite = `ERROR:${errorCode(error)}`; }
  try { fs.writeFileSync(plan.allowedWrite, "ACP_ALLOWED_WRITE\n"); evidence.files.allowedWrite = "WROTE"; }
  catch (error) { evidence.files.allowedWrite = `ERROR:${errorCode(error)}`; }

  if (plan.mode === "proxy") {
    evidence.allowed = await tunnel(plan.allowedHost, 443, "ACP_PROXY_PING\n");
    // The adapter's allowlist proxy is 443-only. Owned high-port direct attempts are safe canaries
    // for its exact outer profile; built-in ports are never contacted directly.
    for (const port of plan.neverPorts) evidence.services.push({ port, direct: await direct("127.0.0.1", port, "") });
  } else {
    // NETWORK_ON allows outbound IPv4 and denies all of this Mac's own addresses, whatever is
    // listening and whenever it started (seatbelt.ts). So loopback is pinned as refused both for a
    // listener older than the profile and for one opened after this ready marker, and the positive
    // control is a connect-only dial to a public address that sends nothing. Built-in service
    // ports are never contacted from this fixture.
    evidence.publicControl = await connectOnly(plan.publicControlHost, plan.publicControlPort);
    evidence.allowed = await direct("127.0.0.1", plan.allowedPort, "");
    fs.writeFileSync(plan.readyFile, "ready\n");
    let control;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      try { control = JSON.parse(fs.readFileSync(plan.goFile, "utf8")); break; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!Number.isInteger(control?.port)) throw new Error("parent did not supply the post-start loopback control port");
    evidence.lateLoopback = { port: control.port, ...await direct("127.0.0.1", control.port, "ACP_LATE_LOOPBACK_PING\n") };
    for (const port of plan.neverPorts) evidence.services.push({ port, direct: await direct("127.0.0.1", port, "") });
  }
  return evidence;
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const params = message.params ?? {};
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: {}, mcpCapabilities: {} }, authMethods: [], agentInfo: { name: "stage2-scripted-acp", version: "1" } } });
  } else if (message.method === "session/new") {
    sessionId = "stage2-acp-native";
    send({ id: message.id, result: { sessionId } });
  } else if (message.method === "session/prompt") {
    try {
      const text = (params.prompt ?? []).map((part) => part?.text ?? "").join("");
      const evidence = await probe(JSON.parse(text));
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(evidence) } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    } catch (error) {
      send({ id: message.id, error: { code: -32000, message: errorCode(error) } });
    }
  } else if (message.method === "session/cancel") {
    send({ id: message.id, result: {} });
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } });
  }
});
