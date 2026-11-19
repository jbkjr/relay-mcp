// Host only. This file does not launch anything unless the explicit live switch is set.
import "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executorPolicy } from "../dist/backends/codex-env.js";
import { seatbeltProfile, SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
import { privateTurnTemp } from "../dist/confine/turn.js";
import { neverPathIdentity, resolveNeverPolicy } from "../dist/core/never-policy.js";
import { withDefaults } from "../dist/core/config.js";
import { targetDef } from "../dist/targets/index.js";

const skip = process.env.RELAY_TEST_STAGE2_LIVE !== "1" ? "set RELAY_TEST_STAGE2_LIVE=1 outside the sandbox" : process.platform !== "darwin" ? "macOS only" : false;
const listen = async (host = "127.0.0.1") => {
  const s = net.createServer(c => {
    // Reach probes destroy their client immediately after connecting. A reset while this
    // owned decoy replies is expected; listener errors and client reach assertions still fail.
    c.on("error", () => {});
    c.end("owned-decoy");
  });
  await new Promise<void>((ok, fail) => { s.once("error", fail); s.listen(0, host, ok); });
  return s;
};
const port = (s: net.Server) => (s.address() as net.AddressInfo).port;
const close = (s: net.Server) => new Promise<void>(ok => s.close(() => ok()));

test("overlay live production profile: port0/write controls, IPv4 localhost connect reach and final never decoys", { skip, timeout: 30_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "overlay-live-")));
  const tmp = privateTurnTemp(); const work = path.join(root, "work"), outside = path.join(root, "outside"), sibling = path.join(root, "sibling"), denied = path.join(root, "never-secret");
  for (const d of [work, outside, sibling]) fs.mkdirSync(d);
  fs.writeFileSync(denied, "owned forbidden decoy");
  const listeners: net.Server[] = []; let child: ReturnType<typeof spawn> | undefined;
  try {
    // Never contact real services. Every endpoint is allocated and owned by this test.
    const allowed = await listen("0.0.0.0"), other = await listen("0.0.0.0"), forbidden = await listen(); listeners.push(allowed, other, forbidden);
    const holders = await Promise.all(Array.from({ length: 4 }, () => listen()));
    const [execPort, reserved, block, neverBind] = holders.map(port); await Promise.all(holders.map(close));
    for (const p of [port(allowed), port(other), port(forbidden), execPort, reserved, block, neverBind]) assert.ok(p > 10000);
    const floor = resolveNeverPolicy({ builtins: false, never: { paths: [{ path: denied }], ports: [{ port: port(forbidden), transport: "both", destinations: "this-machine" }, { port: neverBind, transport: "both", destinations: "this-machine" }] } });
    const spec = { target: targetDef("codex"), cwd: work, access: "write", grant: undefined, config: withDefaults({}), neverPolicy: floor,
      overlay: { request: { roots: [{ root: outside, scope: "tree", pins: neverPathIdentity(outside), existed: true }] } },
    } as any;
    const network = { mode: "stage2" as const, egress: "none" as const, deniedTcp: [port(allowed), port(forbidden), neverBind], deniedUdp: [], relayRange: [execPort, reserved], execPort, bindPorts: [block], broadBind: true, worktreeSockets: false, connectPorts: [port(allowed)] };
    // The approved rule uses Seatbelt's supported localhost token, whose IPv4 scope includes
    // this Mac's LAN/tailnet addresses. Snapshot denies are overridden only at the approved port.
    const policy = executorPolicy(spec, tmp, network);
    const generated = seatbeltProfile(policy, process.execPath);
    assert.doesNotMatch(generated.profile, /\((?:remote|local)\s+(?:ip[46]?|tcp|udp)\s+(?:\(string-append\s+)?"(?:\d+\.\d+\.\d+\.\d+|\[?::1)/);
    const hosts = [...new Set(["127.0.0.1", ...Object.values(os.networkInterfaces()).flatMap(as => as ?? [])
      .filter(a => a.family === "IPv4" && !a.address.startsWith("127.")).map(a => a.address)])];
    const script = `
      const fs = require('node:fs'), net = require('node:net');
      const out = {};
      const write = p => { try { fs.writeFileSync(p, 'decoy'); return 'ok'; } catch(e) { return e.code; } };
      const bind = p => new Promise(ok => { const s = net.createServer(); s.once('error', e => ok(e.code)); s.listen(p, '0.0.0.0', () => s.close(() => ok('ok'))); });
      const connect = (p, host='127.0.0.1') => new Promise(ok => { const s = net.connect(p, host); const timer = setTimeout(() => { s.destroy(); ok('TIMEOUT'); }, 2000); s.once('connect', () => { clearTimeout(timer); s.destroy(); ok('ok'); }); s.once('error', e => { clearTimeout(timer); ok(e.code); }); });
      (async () => {
        out.write = write(${JSON.stringify(path.join(outside, "allowed"))}); out.sibling = write(${JSON.stringify(path.join(sibling, "denied"))});
        try { fs.readFileSync(${JSON.stringify(denied)}); out.neverRead = 'ok'; } catch(e) { out.neverRead = e.code; }
        out.broad = await bind(0); out.executor = await bind(${execPort}); out.reserved = await bind(${reserved}); out.neverBind = await bind(${neverBind});
        out.connect = await connect(${port(allowed)}); out.neverConnect = await connect(${port(forbidden)});
        out.allowedHosts = {}; out.otherHosts = {};
        for(const host of ${JSON.stringify(hosts)}) { out.allowedHosts[host] = await connect(${port(allowed)},host); out.otherHosts[host] = await connect(${port(other)},host); }
        out.alias = await connect(${port(allowed)},'127.0.0.2'); out.ipv6 = await connect(${port(allowed)},'::1'); out.mapped = await connect(${port(allowed)},'::ffff:127.0.0.1');
        console.log(JSON.stringify(out));
      })().catch(e => { console.error(e); process.exitCode = 1; });`;
    const result = await new Promise<string>((ok, fail) => {
      child = spawn(SANDBOX_EXEC, ["-p", generated.profile, ...generated.params.flatMap(([k,v]) => ["-D", `${k}=${v}`]), process.execPath, "-e", script], { cwd: work, timeout: 15000, killSignal: "SIGKILL", env: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: tmp }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout!.on("data", d => stdout += d); child.stderr!.on("data", d => stderr += d);
      child.once("error", fail); child.once("exit", code => code === 0 ? ok(stdout) : fail(new Error(`sandbox exit ${code}: ${stderr}`)));
    });
    const r = JSON.parse(result);
    for (const key of ["write", "broad", "executor", "connect"]) assert.equal(r[key], "ok", key);
    for (const host of hosts) { assert.equal(r.allowedHosts[host], "ok", host); assert.equal(r.otherHosts[host], "EPERM", host); }
    for (const key of ["sibling", "neverRead", "reserved", "neverBind", "neverConnect", "alias", "ipv6", "mapped"]) assert.match(r[key], /^(EPERM|EACCES)$/, `${key}: use a denial oracle, never timeout/EADDRINUSE`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(ok => child!.once("exit", ok)); }
    await Promise.all(listeners.map(close));
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
