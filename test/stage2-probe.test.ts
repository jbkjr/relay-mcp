import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net, { connect as netConnect } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CanaryStep, ListenPortAttempt, ListenPortOutcome } from "../dist/confine/canary.js";
import { ConfinementRefused, prepareLaunch, type Confinement, type ConfinementPolicy, type ProbeReport } from "../dist/confine/index.js";
import { decoyNetwork, localDestinations as allLocalDestinations, planStage2Network, stage2Port0RetryBudget, stage2ProbeExpectations, type ProbePlanner } from "../dist/confine/probe-stage2.js";
import { STATIC_DENIED_TCP, STATIC_DENIED_UDP } from "../dist/confine/ports.js";
import { canonical, dirIdentity, seatbelt, SANDBOX_EXEC } from "../dist/confine/seatbelt.js";
import { stage2NetworkRules, type Stage2Network } from "../dist/confine/seatbelt-stage2.js";
import { neverPathIdentity, resolveNeverPolicy } from "../dist/core/never-policy.js";
// Also for its side effect: the test process gets a scratch HOME (see helpers.ts).
import { REAL_HOME, scratchOnly, until } from "./helpers.ts";
import { TEST_HOME_PARENT } from "./process-home.ts";

// macOS rotates AirDrop's link-local address (awdl0, llw0) by itself, so a probe may not see the one listed here, and the reverse.
const rotating = (n: string) => /%(awdl|llw)\d+$/.test(n);
const localDestinations = () => allLocalDestinations().filter((h: string) => !rotating(h));

// Stage 2's probe mode (docs/codex-confinement-design.md §7.1, §13.2 WP-B): every stage-2 network
// check runs against relay's own decoys, passes under a stage-2 profile, and fails when the rule it
// stands for is missing (the negative controls).

const macOS = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** The real ports a stage-2 turn would get (static list plus a snapshot port, relay's range and a lease); never probed. */
const BLOCK = [47204, 47205, 47206, 47207];
const REAL: Stage2Network = {
  mode: "stage2",
  deniedTcp: [...STATIC_DENIED_TCP, 51125],
  deniedUdp: [...STATIC_DENIED_UDP],
  relayRange: Array.from({ length: 64 }, (_, i) => 47200 + i).filter((p) => !BLOCK.includes(p)),
  execPort: 47200,
  bindPorts: BLOCK,
  worktreeSockets: false,
};
const REAL_PORTS = new Set([...REAL.deniedTcp, ...REAL.deniedUdp, ...REAL.relayRange, ...REAL.bindPorts, REAL.execPort]);
/** The person's own services: no probe may aim at them, whatever the profile (the WP-B brief). */
const NEVER = [22, 5900, 3283, 3031, 445, 548, 631];

/**
 * Design §5.1's rules, one per form, for the probes until WP-A's stage2NetworkRules lands: a stand-in,
 * not the generator. Every port and path is a parameter, as there.
 */
function section51(n: Stage2Network, param: (name: string, value: string) => string, diag: string, paths: { worktree: string }): string {
  const L = ["; --- stage 2 network (test stand-in for WP-A, design §5.1)", '(allow network-outbound (remote ip4 "*:*") (remote ip6 "*:*"))'];
  // Review R1: IPv4 at this Mac's addresses, IPv6 at every host (the IPv4-mapped spellings), never a family-less "ip".
  const deny = (q: string) => `(deny network-outbound (remote ip4 (string-append "localhost:" ${q})) ${diag})\n(deny network-outbound (remote ip6 (string-append "*:" ${q})) ${diag})`;
  n.deniedTcp.forEach((p, i) => L.push(deny(param(`DENY_PORT_${i}`, String(p)))));
  n.relayRange.forEach((p, i) => L.push(deny(param(`RELAY_PORT_${i}`, String(p)))));
  n.deniedUdp.forEach((p, i) => L.push(`(deny network-outbound (remote udp (string-append "*:" ${param(`UDP_DENY_${i}`, String(p))})) ${diag})`));
  L.push(
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    '(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.mDNSResponder") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.networkd") (global-name "com.apple.nehelper"))',
    '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
  );
  const tcpLocal = (p: string) => `(local tcp (string-append "localhost:" ${p}))`;
  const exec = param("EXEC_PORT", String(n.execPort));
  L.push(`(allow network-bind ${tcpLocal(exec)})`, `(allow network-inbound ${tcpLocal(exec)})`);
  n.bindPorts.forEach((p, i) => {
    const b = param(`BIND_PORT_${i}`, String(p));
    L.push(`(allow network-bind ${tcpLocal(b)})`, `(allow network-inbound ${tcpLocal(b)})`);
  });
  L.push('(allow network-bind (local udp "localhost:*"))');
  L.push('(allow network-bind (local unix-socket (subpath (param "TMPDIR"))))', '(allow network-outbound (remote unix-socket (subpath (param "TMPDIR"))))');
  if (n.worktreeSockets) {
    const w = param("WORKTREE", paths.worktree);
    L.push(`(allow network-bind (local unix-socket (subpath ${w})))`, `(allow network-outbound (remote unix-socket (subpath ${w})))`);
  }
  return L.join("\n");
}

/** relay's Seatbelt with design §5.1's rules in place of the network-on block, for stage-2 policies. */
const standIn: Confinement = {
  ...seatbelt,
  wrap(policy, command, args) {
    if (policy.network.mode !== "stage2") return seatbelt.wrap(policy, command, args);
    const l = seatbelt.wrap({ ...policy, network: { mode: "on" } }, command, args);
    const extra: string[] = [];
    const param = (name: string, value: string) => (extra.push("-D", `${name}=${value}`), `(param "${name}")`);
    const text = section51(policy.network, param, '(with message (param "DIAG_TAG"))', { worktree: canonical(policy.worktree) });
    const start = l.args[1].indexOf("; --- network on");
    const last = '(allow network-outbound (literal "/private/var/run/mDNSResponder"))';
    const end = l.args[1].indexOf(last, start);
    assert.ok(start >= 0 && end > start, "the network-on block is where the stand-in expects it");
    const profile = l.args[1].slice(0, start) + text + l.args[1].slice(end + last.length);
    const fix = (a: string[]) => ["-p", profile, ...extra, ...a.slice(2)];
    return { ...l, args: fix(l.args), rewrap: (c, a) => ({ ...l.rewrap(c, a), args: fix(l.rewrap(c, a).args) }), rules: sha(profile), fingerprint: sha(JSON.stringify({ args: fix(l.args), env: l.env })) };
  },
};

/** WP-A's generator, once it is in this build: the probes then run under it too. */
const wpaReady = (() => {
  try {
    stage2NetworkRules(REAL, (n) => `(param "${n}")`, "", { tmpDir: "/tmp", worktree: "/tmp" });
    return true;
  } catch (err) {
    if (/not implemented/.test((err as Error).message)) return false;
    throw err;
  }
})();
const MECHANISMS: [string, Confinement][] = [["design §5.1 stand-in", standIn], ...(wpaReady ? [["WP-A's rules", seatbelt] as [string, Confinement]] : [])];

/** The top-level forms of a profile kept by `keep` (comments and strings respected); the rest dropped. */
function keepForms(profile: string, keep: (form: string) => boolean): string {
  let out = "";
  let i = 0;
  while (i < profile.length) {
    const ch = profile[i];
    if (ch === ";") {
      const e = profile.indexOf("\n", i);
      out += profile.slice(i, e < 0 ? profile.length : e);
      i = e < 0 ? profile.length : e;
    } else if (ch === "(") {
      let depth = 0;
      let j = i;
      for (; j < profile.length; j++) {
        const c = profile[j];
        if (c === '"') {
          for (j++; profile[j] !== '"'; j++) if (profile[j] === "\\") j++;
        } else if (c === ";") {
          while (j < profile.length && profile[j] !== "\n") j++;
        } else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) break;
      }
      const form = profile.slice(i, j + 1);
      if (keep(form)) out += form;
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * A mechanism whose every wrap (the turn's and the decoy's alike, so the rules hashes still agree)
 * has its profile edited: what a generator bug would look like.
 */
function edited(base: Confinement, edit: (profile: string, params: Map<string, string>, policy: ConfinementPolicy) => string): Confinement {
  return {
    ...base,
    wrap(policy, command, args) {
      const l = base.wrap(policy, command, args);
      const params = new Map<string, string>();
      for (let i = 2; l.args[i] === "-D"; i += 2) {
        const kv = l.args[i + 1];
        params.set(kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1));
      }
      const profile = edit(l.args[1], params, policy);
      assert.notEqual(profile, l.args[1], "the edit changed the profile");
      const fix = (a: string[]) => ["-p", profile, ...a.slice(2)];
      return { ...l, args: fix(l.args), rewrap: (c, a) => ({ ...l.rewrap(c, a), args: fix(l.rewrap(c, a).args) }), rules: sha(profile), fingerprint: sha(JSON.stringify({ args: fix(l.args), env: l.env })) };
    },
  };
}

/** Drops the rules (top-level forms) matching `kind` that name a parameter whose value is one of `values(network)`. */
const without = (base: Confinement, kind: RegExp, values: (n: Stage2Network, p: ConfinementPolicy) => (string | number)[]) =>
  edited(base, (profile, params, policy) => {
    const want = new Set(values(policy.network as Stage2Network, policy).map(String));
    const names = new Set([...params].filter(([, v]) => want.has(v)).map(([k]) => k));
    return keepForms(profile, (form) => {
      const drop = kind.test(form) && [...form.matchAll(/\(param "([^"]+)"\)/g)].some((m) => names.has(m[1]));
      return !drop;
    });
  });
/** Drops the rules matching `kind`, whatever they name. */
const withoutForms = (base: Confinement, kind: RegExp) => edited(base, (profile) => keepForms(profile, (form) => !kind.test(form)));
/** Adds a rule at the end, where it wins. */
const plus = (base: Confinement, rule: (p: ConfinementPolicy) => string) => edited(base, (profile, _params, policy) => `${profile}\n${rule(policy)}\n`);
/**
 * Adds a rule naming a parameter of its own, set per wrap to `value(policy)`: a rule about the turn's
 * own paths (its cwd, say) that stays the same text for the turn and its decoy, as the generator's would.
 */
function plusParam(base: Confinement, name: string, value: (p: ConfinementPolicy) => string, rule: string): Confinement {
  return {
    ...base,
    wrap(policy, command, args) {
      const l = base.wrap(policy, command, args);
      const profile = `${l.args[1]}\n${rule}\n`;
      const fix = (a: string[]) => ["-p", profile, "-D", `${name}=${value(policy)}`, ...a.slice(2)];
      return { ...l, args: fix(l.args), rewrap: (c, a) => ({ ...l.rewrap(c, a), args: fix(l.rewrap(c, a).args) }), rules: sha(profile), fingerprint: sha(JSON.stringify({ args: fix(l.args), env: l.env })) };
    },
  };
}

/** A run directory as relay lays it out (as test/probe.test.ts's): this turn's worktree and a sibling's, a control dir, a temp dir, a scratch home and harness. */
function scratch() {
  // This fixture adds /home below the scratch root, unlike process-home.ts.
  const example = path.join(TEST_HOME_PARENT, "s2p-XXXXXX", "home", ".relay-t/s/relay-probe-XXXXXX/relay.sock");
  const parent = Buffer.byteLength(example) <= 103 ? TEST_HOME_PARENT : fs.realpathSync("/tmp");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "s2p-")));
  const run = path.join(root, "worktrees", "r_1");
  const wt = path.join(run, "j_this");
  const sibling = path.join(run, "j_sibling");
  const checkout = path.join(root, "checkout");
  const control = path.join(root, "control");
  const tmp = path.join(root, "turn-tmp");
  for (const d of [wt, sibling, checkout, control, tmp]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  fs.writeFileSync(path.join(control, "relay.db"), "secret\n");
  process.env.RELAY_HOME = control;
  const realHomeVar = process.env.HOME;
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  process.env.HOME = home;
  const harness = path.join(root, "bin", "harness");
  fs.mkdirSync(path.dirname(harness));
  fs.writeFileSync(harness, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  return {
    root, wt, checkout, control, tmp, harness,
    done: () => {
      process.env.HOME = realHomeVar;
      // Every process the probes started is gone: none still names the run directory.
      const left = spawnSync("/usr/bin/pgrep", ["-f", root], { encoding: "utf8" }).stdout.trim();
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(left, "", `processes left running: ${left}`);
    },
  };
}
type Scratch = ReturnType<typeof scratch>;

/** The turn kinds of §2.3 and C4: a write turn in relay's worktree, one in a worktree relay did not make, a read turn in relay's worktree, a read turn in the person's checkout. */
const TURNS = {
  write: (s: Scratch): ConfinementPolicy => ({ worktree: s.wt, worktreePin: dirIdentity(s.wt), worktreeWritable: true, tmpDir: s.tmp, denied: [s.control], network: { ...REAL, worktreeSockets: true } }),
  /** A write turn in a worktree relay did not make (no pin): no sockets there (C4). */
  "write-unpinned": (s: Scratch): ConfinementPolicy => ({ worktree: s.wt, worktreeWritable: true, tmpDir: s.tmp, denied: [s.control], network: REAL }),
  "read-relay-worktree": (s: Scratch): ConfinementPolicy => ({ worktree: s.wt, worktreePin: dirIdentity(s.wt), worktreeWritable: false, tmpDir: s.tmp, denied: [s.control], network: REAL }),
  "read-checkout": (s: Scratch): ConfinementPolicy => ({ worktree: s.checkout, worktreeWritable: false, tmpDir: s.tmp, denied: [s.control], network: REAL }),
} as const;

const launched = (m: Confinement, policy: ConfinementPolicy, s: Scratch) => prepareLaunch(m, policy, scratchOnly(s.harness, "harness"), []);
const byName = (r: ProbeReport) => Object.fromEntries(r.results.map((x) => [x.name, x]));
const REVERSED = ["tcp-loopback", "tcp-loopback-v6", "tcp-loopback-link-local", "unix-listen-worktree", "listen-loopback", "listen-any"];

/** No probe aimed at a real port of the turn, at the person's services, at the real home or outside the scratch tree with a write. */
function assertTargets(r: ProbeReport) {
  for (const x of r.results) {
    const m = x.target && /:(\d+)$/.exec(x.target);
    if (m && x.name.startsWith("stage2-")) {
      assert.ok(!REAL_PORTS.has(Number(m[1])) && !NEVER.includes(Number(m[1])), `${x.name} aimed at a real port: ${x.target}`);
    }
    if (x.target) assert.ok(!x.target.includes(REAL_HOME + "/"), `${x.name} aimed at the real home: ${x.target}`);
  }
}

/** Nothing the probes made is left in the worktree, the checkout or the temp dir. */
function assertClean(s: Scratch) {
  for (const d of [s.wt, s.checkout, s.tmp]) {
    assert.deepEqual(fs.readdirSync(d).filter((n) => n.startsWith(".relay-probe-") || n.endsWith(".sock")), [], `nothing left in ${d}`);
  }
}

/** A fake planner: what planStage2Network asks for, by name. */
function fakePlanner() {
  const plan: Record<string, { expect: "allow" | "deny"; step?: unknown; skip?: string; decoy?: boolean; judge?: (g: string) => boolean }> = {};
  let decoyPolicy: (ConfinementPolicy & { network: Stage2Network }) | undefined;
  const p: ProbePlanner = {
    allow: (n, step) => void (plan[n] = { expect: "allow", step }),
    deny: (n, step) => void (plan[n] = { expect: "deny", step }),
    skip: (n, expect, why) => void (plan[n] = { expect, skip: why }),
    created: [], closers: [], servers: [],
    decoy(dp) {
      assert.equal(decoyPolicy, undefined, "one decoy per probe");
      decoyPolicy = dp;
      return { allow: (name, step, judge) => void (plan[name] = { expect: "allow", step, decoy: true, judge }), deny: (name, step, judge) => void (plan[name] = { expect: "deny", step, decoy: true, judge }) };
    },
  };
  return { p, plan, decoyPolicy: () => decoyPolicy!, network: () => decoyPolicy!.network, close: () => (p.servers.forEach((x) => x.close()), p.closers.forEach(c => c()), p.created.forEach((c) => fs.rmSync(c, { force: true }))) };
}

const fiveAttemptBudget = { longestDeniedRun: 1, maxAttempts: 5 };

/** Exercise the real canary entry point with injected listen events; no host sockets are opened. */
function listenCanary(step: CanaryStep, outcomes: ListenPortAttempt[]) {
  const preload = `
    import assert from "node:assert/strict";
    import net from "node:net";
    const outcomes = ${JSON.stringify(outcomes)};
    const servers = new Set();
    const addresses = new WeakMap();
    let calls = 0, closed = 0;
    net.Server.prototype.listen = function(port, host, ready) {
      assert.ok(!servers.has(this), "each attempt uses a fresh server");
      servers.add(this);
      const result = outcomes[calls++] ?? outcomes.at(-1);
      addresses.set(this, result.port === null ? null : { port: result.port });
      queueMicrotask(() => result.errorCode ? this.emit("error", Object.assign(new Error(result.errorCode), { code: result.errorCode })) : ready());
      return this;
    };
    net.Server.prototype.address = function() { return addresses.get(this); };
    net.Server.prototype.close = function(done) {
      closed++;
      queueMicrotask(done);
      return this;
    };
    process.on("exit", () => process.stderr.write(JSON.stringify({ calls, closed, servers: servers.size })));
  `;
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    path.resolve(import.meta.dirname, "../dist/confine/canary.js"), JSON.stringify({ listen: step })], { encoding: "utf8", timeout: 5000 });
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.status, 0, r.stderr);
  const stats = JSON.parse(r.stderr) as { calls: number; closed: number; servers: number };
  assert.equal(stats.servers, stats.calls);
  assert.equal(stats.closed, stats.calls, "every attempt closes its server before continuing");
  return { got: JSON.parse(r.stdout).listen as string, calls: stats.calls };
}

test("stage-2 port-0 canary: EPERM then a successful listen records both attempts and the assigned port", () => {
  const attempts = [{ errorCode: "EPERM", port: null }, { errorCode: null, port: 54321 }];
  for (const host of ["127.0.0.1", "0.0.0.0"]) {
    const { got, calls } = listenCanary({ kind: "listen-port", host, port: 0, connect: false, retryOnEperm: fiveAttemptBudget }, attempts);
    assert.equal(calls, 2);
    assert.deepEqual(JSON.parse(got), { outcome: "allowed", attemptCount: 2, attempts, retryBudget: fiveAttemptBudget });
  }
});

test("stage-2 port-0 canary: five EPERMs fail and preserve unavailable and reported assigned ports", () => {
  const attempts = Array.from({ length: 5 }, (_, i) => ({ errorCode: "EPERM", port: i === 0 ? 54320 : null }));
  const { got, calls } = listenCanary({ kind: "listen-port", host: "127.0.0.1", port: 0, connect: false, retryOnEperm: fiveAttemptBudget }, attempts);
  assert.equal(calls, 5);
  assert.deepEqual(JSON.parse(got), { outcome: "EPERM", attemptCount: 5, attempts, retryBudget: fiveAttemptBudget });
});

test("stage-2 port-0 canary: errors other than EPERM are never retried", () => {
  for (const errorCode of ["EACCES", "EADDRINUSE"]) {
    const attempts = [{ errorCode, port: null }];
    const { got, calls } = listenCanary({ kind: "listen-port", host: "127.0.0.1", port: 0, connect: false, retryOnEperm: fiveAttemptBudget }, attempts);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(got), { outcome: errorCode, attemptCount: 1, attempts, retryBudget: fiveAttemptBudget });
  }
});

test("stage-2 listen canary: negative port-0 checks, fixed ports and self-connect controls stay single-shot", () => {
  const steps: CanaryStep[] = [
    { kind: "listen-port", host: "127.0.0.1", port: 0, connect: false },
    { kind: "listen-port", host: "127.0.0.1", port: 54321, connect: false },
    { kind: "listen-port", host: "127.0.0.1", port: 54321, connect: false, retryOnEperm: fiveAttemptBudget },
    { kind: "listen-port", host: "127.0.0.1", port: 0, connect: true, retryOnEperm: fiveAttemptBudget },
  ];
  for (const step of steps) {
    const { got, calls } = listenCanary(step, [{ errorCode: "EPERM", port: null }, { errorCode: null, port: 54322 }]);
    assert.equal(calls, 1);
    assert.equal("retryOnEperm" in step ? (JSON.parse(got) as ListenPortOutcome).outcome : got, "EPERM");
  }
});

test("stage-2 port-0 canary: a sequential allocator clears a 69-port denied run, and exhaustion still fails", () => {
  const retryBudget = stage2Port0RetryBudget({ ...REAL, deniedTcp: Array.from({ length: 69 }, (_, i) => 60000 + i) });
  assert.deepEqual(retryBudget, { longestDeniedRun: 69, maxAttempts: 71 });
  const refusals = Array.from({ length: 69 }, (_, i) => ({ errorCode: "EPERM", port: 60000 + i }));
  const attempts = [...refusals, { errorCode: null, port: 60069 }];
  for (const host of ["127.0.0.1", "0.0.0.0"]) {
    const step: CanaryStep = { kind: "listen-port", host, port: 0, connect: false, retryOnEperm: retryBudget };
    const success = listenCanary(step, attempts);
    assert.equal(success.calls, 70);
    assert.deepEqual(JSON.parse(success.got), { outcome: "allowed", attemptCount: 70, attempts, retryBudget });
    const failed = listenCanary(step, [{ errorCode: "EPERM", port: null }]);
    assert.equal(failed.calls, 71);
    const report = JSON.parse(failed.got) as ListenPortOutcome;
    assert.equal(report.outcome, "EPERM");
    assert.equal(report.attemptCount, 71);
    assert.equal(report.attempts.length, 71);
  }
});

test("stage-2 port-0 retry budget: TCP never/control floors extend runs; UDP and own ports do not", () => {
  const network = { ...REAL, deniedTcp: [49151, 50000, 50001, 50002, 50003],
    relayRange: [50004, 50005, 50006, 50007, 50008], execPort: 50004, bindPorts: [50012], listenPorts: [50002] };
  const floor = { ...resolveNeverPolicy({ builtins: false, never: { ports: [
    { port: 50009, transport: "both" }, { port: 50010, transport: "tcp" }, { port: 50011, transport: "udp" },
  ] } }), authorityPorts: [50004, 50012, 50013, 50014] };
  assert.deepEqual(stage2Port0RetryBudget(network, floor), { longestDeniedRun: 6, maxAttempts: 8 });
  const snapshot = { ...REAL, deniedTcp: Array.from({ length: 6 }, (_, i) => 50000 + i), listenPorts: [50003] };
  assert.deepEqual(stage2Port0RetryBudget(snapshot), { longestDeniedRun: 3, maxAttempts: 5 });
  const override = resolveNeverPolicy({ builtins: false, never: { ports: [{ port: 50003, transport: "tcp" }] } });
  assert.deepEqual(stage2Port0RetryBudget(snapshot, override), { longestDeniedRun: 6, maxAttempts: 8 }, "final never denies beat exact-listen exceptions");
});

test("stage-2 port-0 retry budget: joins runs across ephemeral wrap, ignores other ports and stays finite", () => {
  assert.deepEqual(stage2Port0RetryBudget({ ...REAL, deniedTcp: [...STATIC_DENIED_TCP] }), { longestDeniedRun: 0, maxAttempts: 5 }, "the real 47200-47263 reserved range is outside the ephemeral range");
  assert.deepEqual(stage2Port0RetryBudget({ ...REAL, deniedTcp: [49151, 49152, 49153, 49154, 65533, 65534, 65535] }), { longestDeniedRun: 6, maxAttempts: 8 });
  assert.deepEqual(stage2Port0RetryBudget({ ...REAL, deniedTcp: Array.from({ length: 16384 }, (_, i) => 49152 + i) }), { longestDeniedRun: 16384, maxAttempts: 16386 });
});

test("stage-2 overlay expectation table: port0 changes bind only; localhost connects, listen and writes add no raw authority", () => {
  for (const egress of [undefined, "raw", "none"] as const) for (const broadBind of [false, true]) {
    const block = egress !== "none" || broadBind;
    const network = { ...REAL, egress, broadBind, bindPorts: block ? REAL.bindPorts : [] };
    const expected = { egress: egress === "none" ? "deny" : "allow", outsideListen: broadBind ? "allow" : "deny", blockListen: block ? "allow" : "deny", connectBlock: egress !== "none" && block };
    assert.deepEqual(stage2ProbeExpectations(network), expected);
    assert.deepEqual(stage2ProbeExpectations({ ...network, bindPorts: REAL.bindPorts, listenPorts: [51132] }), { ...expected, blockListen: "allow" }, "exact listen authorizes the reserved block without raw outbound");
    assert.deepEqual(stage2ProbeExpectations({ ...network, connectPorts: [51133] }), expected, "localhost connect changes no bind expectation");
  }
  const real = { ...REAL, egress: "none" as const, broadBind: true, listenPorts: [51132], connectPorts: [51133] };
  const decoys = { deniedTcp: REAL.deniedTcp.map((_, i) => 50000 + i), deniedUdp: [50100, 50101], relayRange: REAL.relayRange.map((_, i) => 50200 + i), bindPorts: [50300, 50301, 50302, 50303], execPort: 50200, listenPorts: [50400], connectPorts: [50401] };
  const d = decoyNetwork(real, decoys);
  assert.equal(d.egress, "none");
  assert.equal(d.broadBind, true);
  assert.deepEqual(d.listenPorts, [50400]);
  assert.deepEqual(d.connectPorts, [50401]);
  assert.throws(() => decoyNetwork(real, { ...decoys, listenPorts: [] }), /list length/);
  assert.throws(() => decoyNetwork(real, { ...decoys, listenPorts: [51132] }), /one of the turn's real ports/);
  assert.throws(() => decoyNetwork(real, { ...decoys, listenPorts: [900] }), /high range/);
  assert.throws(() => decoyNetwork(real, { ...decoys, connectPorts: [] }), /list length/);
  assert.throws(() => decoyNetwork(real, { ...decoys, connectPorts: [51133] }), /one of the turn's real ports/);
});

test("stage-2 overlay probe plan: trusted capabilities change only their own expectations, with scratch positive controls and unchanged final floors", async (t) => {
  // This is a planner unit test: allocate synthetic high ports without opening sockets. The live
  // controls below exercise real owned listeners and sandbox refusal, outside the test sandbox.
  let nextPort = 52000;
  // Force the random filler decoys to be contiguous: a worst-case layout that five tries cannot clear.
  let nextFiller = 60000;
  t.mock.method(Math, "random", () => (nextFiller++ - 49152 + 0.25) / 16384);
  const bindings = new WeakMap<net.Server, number>();
  t.mock.method(net.Server.prototype, "listen", function(this: net.Server, opts: { port: number }, ready: () => void) {
    bindings.set(this, opts.port || nextPort++);
    queueMicrotask(ready);
    return this;
  });
  t.mock.method(net.Server.prototype, "address", function(this: net.Server) { return { address: "127.0.0.1", family: "IPv4", port: bindings.get(this) }; });
  t.mock.method(net.Server.prototype, "close", function(this: net.Server, done?: () => void) { if (done) queueMicrotask(done); return this; });
  t.mock.method(dgram, "createSocket", () => {
    const port = nextPort++;
    return Object.assign(new EventEmitter(), {
      bind: (_port: number, _host: string, ready: () => void) => queueMicrotask(ready),
      address: () => ({ port }), close: (done?: () => void) => { if (done) queueMicrotask(done); },
    });
  });
  const s = scratch();
  try {
    const tree = path.join(s.root, "approved-tree");
    const file = path.join(s.root, "approved-file");
    const missing = path.join(s.root, "approved-missing-file");
    fs.mkdirSync(tree);
    fs.writeFileSync(file, "untouched\n");
    const roots = [
      { root: tree, scope: "tree" as const, pins: neverPathIdentity(tree), existed: true },
      { root: file, scope: "file" as const, pins: neverPathIdentity(file), existed: true },
      { root: missing, scope: "file" as const, pins: neverPathIdentity(missing), existed: false },
    ];
    const floor = resolveNeverPolicy({ builtins: false, never: { ports: [{ port: 51130, transport: "both", destinations: "this-machine" }] } });
    // Control ports include our own executor/block (their existing exceptions must survive) and
    // a different executor's assigned block (always denied), including an overlap with the range.
    const neverPolicy = { ...floor, authorityPorts: [REAL.execPort, ...REAL.bindPorts, REAL.relayRange[1], 51131] };
    for (const route of ["none", "raw", "mediated"] as const) for (const broadBind of [false, true]) for (const exact of [false, true]) {
      const raw = route === "raw";
      const f = fakePlanner();
      const scr = fs.mkdtempSync(path.join(s.root, "overlay-scr-"));
      const blockAllowed = raw || broadBind || exact;
      const policy = { ...TURNS.write(s), writable: [tree], writablePins: [dirIdentity(tree)], overlayRoots: roots,
        overlayFiles: roots.slice(1), neverPolicy,
        network: { ...REAL, relayRange: blockAllowed ? REAL.relayRange : [...REAL.relayRange, ...REAL.bindPorts], bindPorts: blockAllowed ? REAL.bindPorts : [], ...(route === "mediated" ? { mediatedPort: REAL.relayRange[2] } : {}), worktreeSockets: true, egress: raw ? "raw" as const : "none" as const, broadBind, listenPorts: exact ? [51132] : [], connectPorts: exact ? [51133] : [] } };
      try {
        await planStage2Network(f.p, policy, { tag: ".relay-probe-0123456789ab", worktree: s.wt, tmpDir: s.tmp, scratch: scr });
        assert.equal(f.plan["stage2-mediated-proxy"]?.expect, route === "mediated" ? "allow" : undefined);
        if (route === "mediated") for (const name of ["stage2-mediated-proxy-ipv6", "stage2-mediated-proxy-mapped"]) assert.equal(f.plan[name]?.expect, "deny");
        for (const name of ["stage2-tcp-open-port", "stage2-tcp-open-port@::ffff:127.0.0.1", "stage2-udp-bind", "stage2-udp-open-port"]) {
          assert.equal(f.plan[name].expect, raw ? "allow" : "deny", name);
        }
        for (const name of ["stage2-listen-outside-block", "stage2-listen-port-0"]) assert.equal(f.plan[name].expect, broadBind ? "allow" : "deny", name);
        assert.equal(f.plan["stage2-listen-block"].expect, blockAllowed ? "allow" : "deny");
        assert.equal(f.plan["stage2-listen-block-any"].expect, blockAllowed ? "allow" : "deny");
        assert.equal((f.plan["stage2-listen-block"].step as { connect: boolean }).connect, raw, "only raw authority adds an outbound self-connect");
        assert.equal(f.plan["stage2-listen-overlay-0"]?.expect, exact ? "allow" : undefined);
        assert.equal(f.plan["stage2-connect-overlay-0@127.0.0.1"]?.expect, exact ? "allow" : undefined);
        if (exact && !raw) {
          for (const host of ["127.0.0.2", "::1", "::ffff:127.0.0.1"]) assert.equal(f.plan[`stage2-connect-overlay-0-denied@${host}`].expect, "deny");
          assert.equal(f.plan["stage2-connect-overlay-0-other-port"].expect, "deny");
        }
        assert.equal(f.plan["stage2-listen-port-0-any"]?.expect, broadBind ? "allow" : undefined);
        for (const [name, check] of Object.entries(f.plan)) {
          const step = check.step as Extract<CanaryStep, { kind: "listen-port" }> | undefined;
          const retry = broadBind && ["stage2-listen-port-0", "stage2-listen-port-0-any"].includes(name);
          const budget = { longestDeniedRun: route === "mediated" ? 64 : 65, maxAttempts: route === "mediated" ? 66 : 67 };
          assert.deepEqual(step?.retryOnEperm, retry ? budget : undefined, `${name}: only positive port-0 checks opt in with the completed decoy layout`);
          if (retry) {
            assert.equal(check.judge!(JSON.stringify({ outcome: "allowed", attemptCount: 2, attempts: [{ errorCode: "EPERM", port: null }, { errorCode: null, port: 54321 }] })), true, name);
            const recovered = [...Array.from({ length: budget.longestDeniedRun }, () => ({ errorCode: "EPERM", port: null })), { errorCode: null, port: 54321 }];
            assert.equal(check.judge!(JSON.stringify({ outcome: "allowed", attemptCount: recovered.length, attempts: recovered })), true, `${name}: clearing the full run passes the probe judge`);
            const attempts = Array.from({ length: budget.maxAttempts }, () => ({ errorCode: "EPERM", port: null }));
            assert.equal(check.judge!(JSON.stringify({ outcome: "EPERM", attemptCount: attempts.length, attempts })), false, `${name}: exhaustion refuses launch`);
            assert.equal(check.judge!("EPERM"), false, `${name}: a refusal alone is never success`);
          }
        }
        for (const name of ["stage2-write-overlay-tree-0", "stage2-write-overlay-file-0", "stage2-write-overlay-file-1"]) assert.equal(f.plan[name].expect, "allow", name);
        const treeStep = f.plan["stage2-write-overlay-tree-0"].step as { path: string };
        assert.ok(treeStep.path.startsWith(tree + path.sep));
        assert.equal(fs.existsSync(treeStep.path), false, "only the owned directory is created by the planner");
        const fileStep = f.plan["stage2-write-overlay-file-0"].step as { path: string };
        assert.ok(fileStep.path.startsWith(scr + path.sep));
        assert.equal(fs.readFileSync(file, "utf8"), "untouched\n");
        assert.equal(fs.existsSync(missing), false, "an absent approved real file stays absent");
        for (const name of ["stage2-listen-never-0", "stage2-listen-never-0@0.0.0.0", "stage2-tcp-never-0", "stage2-udp-bind-never-0", "stage2-udp-never-0", "stage2-listen-control-6", "stage2-tcp-control-6", "stage2-tcp-exec-port", "stage2-udp-denied@127.0.0.1"]) assert.equal(f.plan[name].expect, "deny", name);
        for (const host of localDestinations()) assert.equal(f.plan[`stage2-tcp-denied@${host}`].expect, "deny");
        if (broadBind) {
          for (const i of REAL.deniedTcp.keys()) assert.equal(f.plan[`stage2-listen-denied-${i}`].expect, "deny");
          for (const [i, port] of REAL.relayRange.entries()) if (port !== REAL.execPort) assert.equal(f.plan[`stage2-listen-relay-range-${i}`].expect, "deny");
        }
        const dp = f.decoyPolicy();
        assert.equal((f.plan["stage2-udp-denied@127.0.0.1"].step as { port: number }).port, dp.network.deniedUdp[0]);
        assert.equal(dp.neverPolicy!.authorityPorts[0], dp.network.execPort);
        if (blockAllowed) assert.deepEqual(dp.neverPolicy!.authorityPorts.slice(1, 5), dp.network.bindPorts);
        assert.equal(dp.neverPolicy!.authorityPorts[5], dp.network.relayRange[1]);
        assert.equal(f.plan["stage2-listen-control-0"], undefined, "own executor may still bind");
        assert.equal(f.plan["stage2-tcp-control-1"] === undefined, blockAllowed, "only an authorized own block is carved out of control-port refusal");
        // Same profile text is essential: losing an overlay allowance must fail its allow probe,
        // rather than accidentally testing a broader or structurally different profile.
        const a = seatbelt.wrap(policy, s.harness, []), b = seatbelt.wrap(dp, s.harness, []);
        assert.equal(a.rules, b.rules, JSON.stringify({ raw, broadBind, exact }));
        for (const c of Object.values(f.plan)) {
          const step = c.step as { port?: number } | undefined;
          if (step?.port) assert.ok(step.port >= 1024 && !REAL_PORTS.has(step.port) && !NEVER.includes(step.port) && ![51130, 51131, ...(exact ? [51132, 51133] : [])].includes(step.port));
        }
      } finally { f.close(); }
      assert.deepEqual(fs.readdirSync(tree), [], "owned scratch directories are removed");
    }
  } finally { s.done(); }
});

test("stage-2 overlay live controls: positive allowances launch; a port0 overlay missing the final never listener deny refuses", { skip: !macOS && "macOS only" }, async () => {
  const s = scratch();
  try {
    const tree = path.join(s.root, "outside-tree");
    const file = path.join(s.root, "outside-file");
    const missing = path.join(s.root, "outside-missing-file");
    fs.mkdirSync(tree);
    fs.writeFileSync(file, "untouched\n");
    const roots = [
      { root: tree, scope: "tree" as const, pins: neverPathIdentity(tree), existed: true },
      { root: file, scope: "file" as const, pins: neverPathIdentity(file), existed: true },
      { root: missing, scope: "file" as const, pins: neverPathIdentity(missing), existed: false },
    ];
    const neverPolicy = resolveNeverPolicy({ builtins: false, never: { ports: [{ port: 51130, transport: "both", destinations: "this-machine" }] } });
    const cases: [string, Partial<Stage2Network>][] = [
      ["port0 without raw", { egress: "none", broadBind: true }],
      ["port0 with baseline raw", { egress: "raw", broadBind: true }],
      ["exact listen without raw", { egress: "none", listenPorts: [51132] }],
      ["exact listen with raw", { egress: "raw", listenPorts: [51132] }],
      ["write roots without raw", { egress: "none" }],
      ["raw network overlay", { egress: "raw" }],
      ["mediated network overlay", { egress: "none", mediatedPort: REAL.relayRange[2] }],
      ["IPv4 localhost connect without raw", { egress: "none", connectPorts: [51133], deniedTcp: [...REAL.deniedTcp, 51133] }],
      ["IPv4 localhost connect preserving mediated baseline", { egress: "none", mediatedPort: REAL.relayRange[2], connectPorts: [51133] }],
    ];
    const policy = (extra: Partial<Stage2Network>): ConfinementPolicy => {
      const blockAllowed = extra.egress !== "none" || extra.broadBind || Boolean(extra.listenPorts?.length);
      return { ...TURNS.write(s), writable: [tree], writablePins: [dirIdentity(tree)], overlayRoots: roots, overlayFiles: roots.slice(1), neverPolicy,
        network: { ...REAL, relayRange: blockAllowed ? REAL.relayRange : [...REAL.relayRange, ...REAL.bindPorts], bindPorts: blockAllowed ? REAL.bindPorts : [], worktreeSockets: true, ...extra } };
    };
    for (const [what, extra] of cases) {
      const { probes } = await launched(seatbelt, policy(extra), s);
      assert.ok(probes.ok, `${what}: ${JSON.stringify(probes.results.filter(r => !r.ok))}`);
      assertTargets(probes);
      const by = byName(probes);
      for (const n of ["stage2-write-overlay-tree-0", "stage2-write-overlay-file-0", "stage2-write-overlay-file-1"]) assert.equal(by[n].got, "allowed", `${what}: ${n}`);
      if (extra.mediatedPort) assert.equal(by["stage2-mediated-proxy"].got, "allowed", what);
      if (extra.broadBind) for (const name of ["stage2-listen-port-0", "stage2-listen-port-0-any"]) {
        const result = JSON.parse(by[name].got) as ListenPortOutcome;
        assert.equal(result.outcome, "allowed", `${what}: ${name}`);
        assert.equal(result.attemptCount, result.attempts.length);
        assert.ok(result.attempts.at(-1)!.port! > 0, "the successful listen reports its assigned port");
      }
      if (extra.listenPorts) assert.equal(by["stage2-listen-overlay-0"].got, "allowed", what);
      if (extra.connectPorts) {
        assert.equal(by["stage2-connect-overlay-0@127.0.0.1"].got, "allowed", what);
        for (const [name, check] of Object.entries(by)) {
          if (name.startsWith("stage2-connect-overlay-0@")) assert.equal(check.got, "allowed", `${what}: ${name}`);
          if (name.startsWith("stage2-connect-overlay-0-denied@") || name === "stage2-connect-overlay-0-other-port") assert.equal(check.got, "EPERM", `${what}: ${name}`);
        }
        assert.equal(by["stage2-tcp-never-0"].got, "EPERM", what);
      }
      // Unrelated boundaries keep their original assertions, even on a broad-bind overlay.
      for (const n of ["write-outside", "read-control-dir", "signal-outside", "proc-listpids", "mach-pasteboard", "sem-open-outside", "exec-outside-list", "foreign-pty-read", "stage2-listen-never-0", "stage2-udp-bind-never-0"]) assert.ok(by[n] && by[n].ok && by[n].expect === "deny", `${what}: ${n}`);
      assert.deepEqual(fs.readdirSync(tree), [], what);
      assert.equal(fs.readFileSync(file, "utf8"), "untouched\n");
      assert.equal(fs.existsSync(missing), false, "the real missing file stays absent");
      assertClean(s);
    }
    const missingFloor = withoutForms(seatbelt, /^\(deny network-bind network-inbound \(local tcp .*NEVER_PORT_0/);
    await assert.rejects(launched(missingFloor, policy({ egress: "raw", broadBind: true }), s), (err: ConfinementRefused) => {
      assert.ok(err instanceof ConfinementRefused && err.report, `refused by a probe: ${err}`);
      const failed = err.report.results.filter(r => !r.ok).map(r => r.name);
      assert.deepEqual(failed.sort(), ["stage2-listen-never-0", "stage2-listen-never-0@0.0.0.0"].sort());
      assert.ok(failed.includes(err.check));
      return true;
    });
    assertClean(s);
  } finally { s.done(); }
});

test("stage-2 probe plan: each §7.1 check for write and read turns, network checks on decoy ports only, AF_UNIX by turn kind (review C4)", async () => {
  const s = scratch();
  try {
    const expected = {
      write: { "stage2-unix-worktree": "allow" },
      "write-unpinned": { "stage2-unix-worktree": "deny" },
      "read-relay-worktree": { "stage2-unix-cwd-decoy": "deny" },
      "read-checkout": { "stage2-unix-cwd-decoy": "deny" },
    } as const;
    for (const [kind, make] of Object.entries(TURNS)) {
      const policy = make(s) as ConfinementPolicy & { network: Stage2Network };
      const f = fakePlanner();
      const scr = fs.mkdtempSync(path.join(s.root, "scr-"));
      try {
        await planStage2Network(f.p, policy, { tag: ".relay-probe-0123456789ab", worktree: policy.worktree, tmpDir: s.tmp, scratch: scr });
        for (const [n, e] of Object.entries(expected[kind as keyof typeof expected])) {
          assert.equal(f.plan[n]?.expect, e, `${kind}: ${n}`);
          assert.equal(f.plan[n]?.skip, undefined, `${kind}: ${n} not skipped`);
          assert.equal(!!f.plan[n].decoy, n === "stage2-unix-cwd-decoy", `${kind}: ${n} runs under ${n === "stage2-unix-cwd-decoy" ? "the decoy" : "the turn's own profile"}`);
        }
        const reading = kind.startsWith("read");
        if (reading) assert.match(f.plan["stage2-unix-worktree"].skip ?? "", /cannot create files in its worktree/);
        else assert.equal(f.plan["stage2-unix-cwd-decoy"], undefined);
        // The decoy socket in a read turn's cwd is relay's, listening, outside the sandbox.
        // Nothing is made in the real cwd: the read turn's socket check runs in a decoy cwd of relay's own,
        // the decoy canary's worktree, under the same rules.
        assert.deepEqual(fs.readdirSync(policy.worktree).filter((n) => n.endsWith(".sock")), [], `${kind}: nothing in the cwd`);
        if (reading) {
          const dp = f.decoyPolicy();
          assert.ok(dp.worktree.startsWith(scr + path.sep), `${kind}: decoy cwd ${dp.worktree} in relay's scratch dir`);
          assert.equal(dp.worktreePin !== undefined, policy.worktreePin !== undefined, `${kind}: pinned like the cwd`);
          const step = f.plan["stage2-unix-cwd-decoy"].step as { path: string };
          assert.equal(step.path, path.join(dp.worktree, "rd012345.sock"));
          assert.ok(fs.statSync(step.path).isSocket(), `${kind}: decoy socket listening in the decoy cwd`);
          assert.ok(f.plan["stage2-unix-cwd-decoy"].decoy, `${kind}: the cwd check runs on the decoy`);
        } else assert.equal(f.decoyPolicy().worktree, policy.worktree, `${kind}: a write turn's worktree is its own`);
        // The network checks, all in the decoy canary.
        const net = [
          ...localDestinations().map((h) => [`stage2-tcp-denied@${h}`, "deny"]),
          ["stage2-tcp-open-port", "allow"], ["stage2-tcp-open-port@::1", "allow"], ["stage2-tcp-open-port@::ffff:127.0.0.1", "allow"],
          ["stage2-tcp-relay-range", "deny"], ...localDestinations().filter((h) => h !== "127.0.0.1").map((h) => [`stage2-tcp-relay-range@${h}`, "deny"]), ["stage2-tcp-exec-port", "deny"],
          ["stage2-listen-block", "allow"], ["stage2-listen-exec-port", "allow"], ["stage2-listen-outside-block", "deny"], ["stage2-listen-port-0", "deny"],
          ["stage2-udp-bind", "allow"], ["stage2-udp-denied@127.0.0.1", "deny"], ["stage2-udp-denied@::1", "deny"], ["stage2-udp-denied@192.0.2.1", "deny"], ["stage2-udp-open-port", "allow"],
        ];
        for (const [n, e] of net) {
          assert.equal(f.plan[n]?.expect, e, `${kind}: ${n}`);
          assert.ok(f.plan[n].decoy, `${kind}: ${n} runs on the decoy`);
        }
        // Review R1: the IPv4-mapped and -compatible spellings, which Seatbelt's "localhost" does not cover.
        const v4 = Object.values(os.networkInterfaces()).flat().filter((a) => a?.family === "IPv4").map((a) => a!.address);
        for (const h of ["127.0.0.1", "::1", "0.0.0.0", "::", "::ffff:127.0.0.1", "fe80::1%lo0", "::ffff:0.0.0.0", "0:0:0:0:0:ffff:0:0", ...v4.flatMap((a) => [`::ffff:${a}`, ...(a === "0.0.0.0" ? [] : [`::${a}`])])]) {
          assert.ok(f.plan[`stage2-tcp-denied@${h}`], h);
        }
        for (const n of REVERSED) assert.equal(f.plan[n], undefined, `${kind}: ${n} is not planned under stage 2`);
        // The decoy: same list lengths, no real port, worktree sockets as the turn's.
        const d = f.network();
        for (const k of ["deniedTcp", "deniedUdp", "relayRange", "bindPorts"] as const) assert.equal(d[k].length, policy.network[k].length, k);
        for (const port of [...d.deniedTcp, ...d.deniedUdp, ...d.relayRange, ...d.bindPorts, d.execPort]) assert.ok(!REAL_PORTS.has(port) && port >= 1024, `decoy ${port}`);
        assert.equal(d.worktreeSockets, policy.network.worktreeSockets);
        assert.equal(d.relayRange[REAL.relayRange.indexOf(REAL.execPort)], d.execPort, "the executor's decoy sits where the turn's executor port is in the range");
        // The accept log (§7.1): a denied decoy that saw a connection fails its probe even on EPERM.
        if (kind === "write") {
          for (const n of ["stage2-tcp-denied@127.0.0.1", "stage2-tcp-relay-range"]) {
            const { judge, step } = f.plan[n] as { judge: (g: string) => boolean; step: { port: number } };
            assert.equal(judge("EPERM"), true, `${n} before a connection`);
            assert.equal(judge("ECONNREFUSED"), false, `${n}: not the sandbox's refusal`);
            await new Promise<void>((resolve, reject) => {
              const c = netConnect({ host: "127.0.0.1", port: step.port }, () => c.end());
              c.on("close", () => resolve());
              c.on("error", reject);
            });
            await until(() => judge("EPERM") === false, 5000, `${n} counted the connection`);
          }
        }
        // Every TCP and UDP check is aimed at a decoy value, never a real port.
        for (const [n, c] of Object.entries(f.plan)) {
          const step = c.step as { port?: number } | undefined;
          if (step?.port !== undefined && step.port !== 0) assert.ok(!REAL_PORTS.has(step.port) && !NEVER.includes(step.port), `${n} aims at ${step.port}`);
        }
      } finally {
        f.close();
      }
    }
    // Worktree sockets on anything but a write turn in relay's pinned worktree: refused before anything is planned.
    for (const policy of [{ ...TURNS["read-relay-worktree"](s), network: { ...REAL, worktreeSockets: true } }, { ...TURNS.write(s), worktreePin: undefined }]) {
      const f = fakePlanner();
      await assert.rejects(planStage2Network(f.p, policy as ConfinementPolicy & { network: Stage2Network }, { tag: ".relay-probe-0123456789ab", worktree: policy.worktree, tmpDir: s.tmp, scratch: s.root }), /review C4/);
      f.close();
    }
  } finally {
    s.done();
  }
});

test("stage-2 decoy network: same rules hash, another fingerprint; lists keep their length and never hold a real port", () => {
  const decoys = { deniedTcp: REAL.deniedTcp.map((_, i) => 50000 + i), deniedUdp: [50100, 50101], relayRange: REAL.relayRange.map((_, i) => 50200 + i), bindPorts: [50300, 50301, 50302, 50303], execPort: 50200 };
  const d = decoyNetwork(REAL, decoys);
  assert.deepEqual({ ...d }, { ...REAL, ...decoys });
  assert.throws(() => decoyNetwork(REAL, { ...decoys, deniedTcp: [50000] }), new RegExp(`deniedTcp has 1 ports where the turn's has ${STATIC_DENIED_TCP.length + 1}`));
  assert.throws(() => decoyNetwork(REAL, { ...decoys, bindPorts: [50300, 50301, 50302, 47205] }), /47205 is one of the turn's real ports/);
  assert.throws(() => decoyNetwork(REAL, { ...decoys, execPort: 22 }), /22 is one of the turn's real ports/);
  assert.throws(() => decoyNetwork({ ...REAL, deniedTcp: [51125] }, { ...decoys, deniedTcp: [3283] }), /3283 is one of the turn's real ports/);
  assert.throws(() => decoyNetwork(REAL, { ...decoys, execPort: 70000 }), /not a port/);
  if (!macOS) return;
  const s = scratch();
  try {
    for (const [label, m] of MECHANISMS) {
      for (const make of Object.values(TURNS)) {
        const policy = make(s);
        const a = m.wrap(policy, s.harness, []);
        const b = m.wrap({ ...policy, network: decoyNetwork(policy.network as Stage2Network, decoys) }, s.harness, []);
        assert.equal(a.rules, b.rules, `${label}: same rules`);
        assert.notEqual(a.fingerprint, b.fingerprint, `${label}: other parameters`);
        // The real profile carries the real ports as parameters, not in its text.
        for (const port of [22, 5900, 47200, 47204, 1900]) {
          assert.ok(a.args.some((x, i) => a.args[i - 1] === "-D" && x.endsWith(`=${port}`)), `${label}: ${port} is a parameter`);
          assert.ok(!a.args[1].includes(`:${port}"`), `${label}: ${port} is not in the profile text`);
        }
      }
    }
  } finally {
    s.done();
  }
});

for (const [label, mechanism] of MECHANISMS) {
  test(`stage-2 probes (${label}): prepareLaunch passes for write turns (in relay's worktree and in another) and read turns (there and in the person's checkout); no real port is aimed at; nothing is left`, { skip: !macOS && "macOS only" }, async () => {
    const s = scratch();
    try {
      for (const [kind, make] of Object.entries(TURNS)) {
        const { probes } = await launched(mechanism, make(s), s);
        assert.ok(probes.ok, `${kind}: ${JSON.stringify(probes.results.filter((r) => !r.ok))}`);
        assertTargets(probes);
        const by = byName(probes);
        for (const n of REVERSED) assert.equal(by[n], undefined, `${kind}: ${n} is not run under stage 2`);
        for (const h of localDestinations()) assert.equal(by[`stage2-tcp-denied@${h}`].got, "EPERM", `${kind}: ${h}`);
        for (const h of localDestinations().filter((x) => x !== "127.0.0.1")) assert.equal(by[`stage2-tcp-relay-range@${h}`].got, "EPERM", `${kind}: range at ${h}`);
        for (const n of ["stage2-tcp-open-port", "stage2-tcp-open-port@::1", "stage2-tcp-open-port@::ffff:127.0.0.1", "stage2-listen-block", "stage2-listen-exec-port", "stage2-udp-bind", "stage2-udp-open-port", "unix-listen-tmpdir"]) assert.equal(by[n].got, "allowed", `${kind}: ${n}`);
        for (const n of ["stage2-tcp-relay-range", "stage2-tcp-exec-port", "stage2-listen-outside-block", "stage2-listen-port-0", "stage2-udp-denied@127.0.0.1", "stage2-udp-denied@::1", "stage2-udp-denied@192.0.2.1", "unix-socket", "relay-socket-other-turn"]) {
          assert.equal(by[n].got, "EPERM", `${kind}: ${n}`);
        }
        if (kind.startsWith("read")) assert.match(by["stage2-unix-worktree"].got, /^skipped: /);
        else assert.equal(by["stage2-unix-worktree"].got, kind === "write" ? "allowed" : "EPERM", kind);
        if (kind.startsWith("read")) assert.equal(by["stage2-unix-cwd-decoy"].got, "EPERM", kind);
        // The filesystem, process and IPC checks stay (a sample across the battery).
        for (const n of ["write-outside", "read-control-dir", "signal-outside", "proc-listpids", "mach-pasteboard", "sem-open-outside", "exec-outside-list", "foreign-pty-read"]) assert.ok(by[n] && by[n].ok && by[n].expect === "deny", `${kind}: ${n}`);
        assertClean(s);
        console.log(`stage-2 probes (${label}, ${kind}): ${probes.results.length} probes, ${probes.results.filter((r) => r.name.startsWith("stage2-")).length} stage-2, ${probes.ms} ms`);
      }
      // The other modes keep the reversed checks.
      const { probes } = await launched(mechanism, { ...TURNS.write(s), network: { mode: "on" } }, s);
      const by = byName(probes);
      for (const n of ["tcp-loopback", "tcp-loopback-v6", "unix-listen-worktree", "listen-loopback", "listen-any"]) assert.equal(by[n]?.got, "EPERM", `network on: ${n}`);
      assert.ok(!probes.results.some((r) => r.name.startsWith("stage2-")));
    } finally {
      s.done();
    }
  });

  test(`stage-2 probes (${label}): a read turn's cwd is decoyed for every git layout (a checkout, below its top, a git worktree with relay's git env); nothing is made in it (git status stays clean)`, { skip: !macOS && "macOS only" }, async () => {
    const s = scratch();
    const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });
    try {
      const repo = path.join(s.root, "repo");
      fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
      fs.writeFileSync(path.join(repo, "sub", "a.txt"), "a\n");
      git(repo, "init", "-q", "-b", "main");
      git(repo, "add", ".");
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
      const wt = path.join(s.root, "worktrees", "r_2", "j_read");
      assert.equal(git(repo, "worktree", "add", "-q", "-b", "relay/j_read", wt).status, 0);
      const wtGitDir = git(wt, "rev-parse", "--absolute-git-dir").stdout.trim();
      const layouts: [string, ConfinementPolicy, string][] = [
        ["checkout", { worktree: repo, worktreeWritable: false, tmpDir: s.tmp, denied: [s.control], network: REAL }, repo],
        ["below its top", { worktree: path.join(repo, "sub"), worktreeWritable: false, tmpDir: s.tmp, denied: [s.control], network: REAL }, repo],
        ["git worktree", { worktree: wt, worktreePin: dirIdentity(wt), worktreeWritable: false, gitEnv: { GIT_DIR: wtGitDir, GIT_WORK_TREE: wt }, tmpDir: s.tmp, denied: [s.control], network: REAL }, wt],
      ];
      for (const [what, policy, top] of layouts) {
        const { probes } = await launched(mechanism, policy, s);
        assert.ok(probes.ok, `${what}: ${JSON.stringify(probes.results.filter((r) => !r.ok))}`);
        const decoySocket = byName(probes)["stage2-unix-cwd-decoy"];
        assert.equal(decoySocket.got, "EPERM", what);
        assert.ok(!decoySocket.target!.startsWith(s.root + path.sep + "repo") && !decoySocket.target!.startsWith(wt), `${what}: aimed at ${decoySocket.target}`);
        assert.equal(git(top, "status", "--porcelain", "--ignored").stdout, "", `${what}: the checkout is untouched`);
      }
    } finally {
      s.done();
    }
  });

  test(`stage-2 negative controls (${label}): each check fails, refusing the launch, when the rule it stands for is missing`, { skip: !macOS && "macOS only" }, async () => {
    const s = scratch();
    const allDenied = localDestinations().map((h) => `stage2-tcp-denied@${h}`);
    const allRange = ["stage2-tcp-relay-range", ...localDestinations().filter((h) => h !== "127.0.0.1").map((h) => `stage2-tcp-relay-range@${h}`)];
    // A decoy that saw any connection fails every probe aimed at it (neverReached), so each control
    // below fails the whole set: the IPv6 deny alone open lets ::1 and the IPv4-mapped spellings
    // through, the IPv4 deny alone open 127.0.0.1 and the LAN address (review R1).
    const controls: { what: string; turn: keyof typeof TURNS; m: Confinement; fails: string[] }[] = [
      { what: "the denied-port deny", turn: "write", m: without(mechanism, /network-outbound/, (n) => [n.deniedTcp[0]]), fails: allDenied },
      { what: "the denied port's IPv6 deny", turn: "write", m: without(mechanism, /\(remote ip6 /, (n) => [n.deniedTcp[0]]), fails: allDenied },
      { what: "the denied port's IPv4 deny", turn: "write", m: without(mechanism, /\(remote ip4 /, (n) => [n.deniedTcp[0]]), fails: allDenied },
      { what: "the relay-range deny", turn: "write", m: without(mechanism, /network-outbound/, (n) => n.relayRange.filter((p) => p !== n.execPort)), fails: allRange },
      { what: "the relay range's IPv6 deny", turn: "write", m: without(mechanism, /\(remote ip6 /, (n) => n.relayRange.filter((p) => p !== n.execPort)), fails: allRange },
      { what: "the executor port's outbound deny", turn: "write", m: without(mechanism, /network-outbound/, (n) => [n.execPort]), fails: ["stage2-tcp-exec-port"] },
      { what: "the UDP deny", turn: "write", m: without(mechanism, /network-outbound/, (n) => [n.deniedUdp[0]]), fails: ["stage2-udp-denied@127.0.0.1", "stage2-udp-denied@::1", "stage2-udp-denied@192.0.2.1"] },
      // Both rules: network-bind is a sub-operation of network-inbound, so an inbound allow on a port
      // alone lets it be bound and listened on (measured on macOS 27); a bind allow alone does not let it listen.
      { what: "the block's bind and inbound allows", turn: "write", m: without(mechanism, /network-(bind|inbound)/, (n) => [n.bindPorts[0]]), fails: ["stage2-listen-block", "stage2-listen-block-any"] },
      { what: "the executor port's bind and inbound allows", turn: "write", m: without(mechanism, /network-(bind|inbound)/, (n) => [n.execPort]), fails: ["stage2-listen-exec-port"] },
      { what: "the bind limit (an any-port inbound allow, which binds too)", turn: "write", m: plus(mechanism, () => '(allow network-inbound (local tcp "localhost:*"))'), fails: ["stage2-listen-outside-block", "stage2-listen-port-0"] },
      { what: "the bind limit (revision 1's any-port bind and inbound)", turn: "write", m: plus(mechanism, () => '(allow network-bind network-inbound (local tcp "localhost:*"))'), fails: ["stage2-listen-outside-block", "stage2-listen-port-0"] },
      { what: "the UDP bind allow", turn: "write", m: withoutForms(mechanism, /\(local udp /), fails: ["stage2-udp-bind", "stage2-udp-open-port"] },
      { what: "the outbound IP allow", turn: "write", m: withoutForms(mechanism, /\(allow network-outbound \(remote ip4 "\*:\*"\) \(remote ip6 "\*:\*"\)\)/), fails: ["stage2-tcp-open-port", "stage2-tcp-open-port@::1", "stage2-tcp-open-port@::ffff:127.0.0.1", "stage2-udp-open-port", "stage2-listen-block"] },
      { what: "the TMPDIR socket allow", turn: "write", m: without(mechanism, /unix-socket/, (_n, p) => [canonical(p.tmpDir)]), fails: ["unix-listen-tmpdir"] },
      { what: "the write turn's worktree socket allow", turn: "write", m: without(mechanism, /unix-socket/, (_n, p) => [canonical(p.worktree)]), fails: ["stage2-unix-worktree"] },
      ...(["read-relay-worktree", "read-checkout", "write-unpinned"] as const).map((turn) => ({
        what: `worktree sockets on a ${turn} turn (review C4)`, turn,
        m: plusParam(mechanism, "TEST_CWD", (p) => canonical(p.worktree), '(allow network-bind (local unix-socket (subpath (param "TEST_CWD"))))\n(allow network-outbound (remote unix-socket (subpath (param "TEST_CWD"))))'),
        fails: [turn === "write-unpinned" ? "stage2-unix-worktree" : "stage2-unix-cwd-decoy"],
      })),
    ];
    try {
      const outcomes: string[] = [];
      for (const c of controls) {
        await assert.rejects(launched(c.m, TURNS[c.turn](s), s), (err: ConfinementRefused) => {
          assert.ok(err instanceof ConfinementRefused, `${c.what}: ${err}`);
          assert.ok(err.report, `${c.what}: refused by a probe, not by setup (${err.check}: ${err.message})`);
          const failed = err.report!.results.filter((r) => !r.ok).map((r) => r.name);
          const family = (n: string) => n.split("@")[0];
          for (const n of c.fails) assert.ok(failed.includes(n), `${c.what}: ${n} should fail; failed: ${failed.join(", ")}`);
          assert.ok(c.fails.includes(err.check), `${c.what}: refused on ${err.check}`);
          // Nothing else broke: the edit took out only what it meant to.
          for (const n of failed) assert.ok(rotating(n) ? c.fails.some((f) => family(f) === family(n)) : c.fails.includes(n) || (c.what === "the UDP bind allow" && n.startsWith("stage2-udp-")), `${c.what}: ${n} failed too`);
          outcomes.push(`${c.what} -> ${failed.map((n) => `${n}=${byName(err.report!)[n].got}`).join(", ")}`);
          return true;
        }, `${c.what}: the launch was not refused`);
        assertClean(s);
      }
      console.log(`stage-2 negative controls (${label}):\n  ${outcomes.join("\n  ")}`);
    } finally {
      s.done();
    }
  });
}
