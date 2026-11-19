#!/usr/bin/env node
// Fixed network probe used by the installed-Claude Bash route. Built-in service ports are sent
// only as CONNECT targets to relay's proxy. Direct connects are limited to owned high-port decoys.
import net from "node:net";

const plan = JSON.parse(process.argv[2]);
const errorCode = error => String(error?.code ?? error?.message ?? error);

const direct = (port) => new Promise(resolve => {
  const socket = net.connect({ host: "127.0.0.1", port });
  let settled = false;
  const done = answer => { if (!settled) { settled = true; socket.destroy(); resolve(answer); } };
  socket.setTimeout(3000, () => done({ ok: false, code: "ETIMEDOUT" }));
  socket.once("connect", () => done({ ok: true }));
  socket.once("error", error => done({ ok: false, code: errorCode(error) }));
});

const credentials = raw => {
  const proxy = new URL(raw);
  return { proxy, auth: Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64") };
};

// Reach the owned qualification proxy only through Claude's production proxy: the outer CONNECT
// names a public carrier address whose final dial the test redirects to the owned proxy. The inner
// CONNECT is the built-in/user-never request whose exact reason the owned proxy records.
const nestedTunnel = (host, port, payload = "") => new Promise(resolve => {
  const outerRaw = process.env.HTTPS_PROXY || process.env.https_proxy;
  const innerRaw = process.env.STAGE2_CLAUDE_NESTED_PROXY;
  if (!outerRaw || !innerRaw) return resolve({ ok: false, code: "NO_PROXY" });
  const outer = credentials(outerRaw), inner = credentials(innerRaw);
  const socket = net.connect({ host: outer.proxy.hostname, port: Number(outer.proxy.port) });
  let data = "", stage = "outer", settled = false;
  const done = answer => { if (!settled) { settled = true; socket.destroy(); resolve(answer); } };
  socket.setTimeout(3000, () => done({ ok: false, code: "ETIMEDOUT" }));
  socket.once("connect", () => socket.write(
    `CONNECT ${plan.carrierHost}:${plan.carrierPort} HTTP/1.1\r\nHost: ${plan.carrierHost}:${plan.carrierPort}\r\nProxy-Authorization: Basic ${outer.auth}\r\n\r\n`,
  ));
  socket.on("data", chunk => {
    data += chunk;
    for (;;) {
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) break;
      const head = data.slice(0, end); data = data.slice(end + 4);
      if (!/^HTTP\/1\.[01] 200\b/.test(head)) return done({ ok: false, stage, code: /^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? "BAD_PROXY_REPLY" });
      if (stage === "outer") {
        stage = "inner";
        socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${inner.auth}\r\nConnection: close\r\n\r\n`);
        continue;
      }
      stage = "payload";
      if (payload) socket.write(payload); else return done({ ok: true });
    }
    if (stage === "payload" && (data.includes("\n") || data.includes("ALLOWED"))) done({ ok: true, data: data.slice(0, 120) });
  });
  socket.once("error", error => done({ ok: false, code: errorCode(error) }));
  socket.once("close", () => done({ ok: false, stage, code: "ECONNCLOSED" }));
});

const evidence = { allowed: await nestedTunnel(plan.publicHost, plan.allowedPort, "CLAUDE_PROXY_PING\n"), services: [], neverPorts: [] };
for (const port of plan.servicePorts) evidence.services.push({ port, proxy: await nestedTunnel("127.0.0.1", port) });
for (const port of plan.neverPorts) evidence.neverPorts.push({ port, proxy: await nestedTunnel("127.0.0.1", port), direct: await direct(port) });
process.stdout.write(`STAGE2_NATIVE_NETWORK:${JSON.stringify(evidence)}\n`);
