import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { harness, hostFor, INTERACTIVE_CLAUDE, task, until, type Harness, type Rec } from "./helpers.ts";
import {
  localModeInterlock, localModeRetired, stage2Enabled, RAW_NETWORK_CONSENT_TEXT, RAW_NETWORK_TURN_NOTE, rawNetworkConsent, rawNetworkGrantProblem, rawNetworkKey, rawNetworkText, STAGE2_FLAG_ENV,
} from "../dist/core/raw-network.js";
import { STATIC_DENIED_TCP, STATIC_DENIED_UDP } from "../dist/confine/ports.js";
import { ConfigSchema, withDefaults } from "../dist/core/config.js";

// Stage 2's grant, the person's consent to it and the local-mode interlock
// (docs/codex-confinement-design.md §5.4, §6, §13.2 WP-E), called directly.

/** Runs `fn` with stage 2 switched on (or off) through the environment override, restoring it after. */
async function withSwitch<T>(on: boolean, fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env[STAGE2_FLAG_ENV];
  if (on) process.env[STAGE2_FLAG_ENV] = "1";
  else delete process.env[STAGE2_FLAG_ENV];
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[STAGE2_FLAG_ENV];
    else process.env[STAGE2_FLAG_ENV] = saved;
  }
}

/** A scratch registry in this process, closed and removed afterwards. */
async function withRegistry<T>(fn: (db: typeof import("../dist/core/db.js")) => T | Promise<T>): Promise<T> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-s2e-")));
  const saved = process.env.RELAY_HOME;
  process.env.RELAY_HOME = home;
  const dbm = await import("../dist/core/db.js");
  try {
    return await fn(dbm);
  } finally {
    dbm.closeDbForTests();
    if (saved === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("raw network grant: Codex write jobs only, with network: true, never with local_network, app server only, and only while stage 2 is switched on", async () => {
  const ok = { network: true, raw_network: true };
  await withSwitch(true, () => {
    assert.equal(rawNetworkGrantProblem(undefined, "write", "codex"), null);
    assert.equal(rawNetworkGrantProblem({ network: true }, "write", "codex"), null);
    assert.equal(rawNetworkGrantProblem({ network: true, raw_network: false }, "write", "codex"), null);
    assert.equal(rawNetworkGrantProblem(ok, "write", "codex"), null);
    assert.equal(rawNetworkGrantProblem(ok, "write", "codex", withDefaults({})), null);
    assert.match(rawNetworkGrantProblem({ network: true, raw_network: "yes" } as never, "write", "codex") ?? "", /must be true or false/);
    assert.match(rawNetworkGrantProblem(ok, "write", "claude") ?? "", /for Codex write jobs only: Claude has no mode/);
    assert.match(rawNetworkGrantProblem(ok, "read", "codex") ?? "", /for Codex write jobs only: a read-only session/);
    assert.match(rawNetworkGrantProblem({ raw_network: true }, "write", "codex") ?? "", /needs network: true in the same grant/);
    assert.match(rawNetworkGrantProblem({ network: false, raw_network: true }, "write", "codex") ?? "", /needs network: true/);
    assert.match(rawNetworkGrantProblem({ ...ok, local_network: true }, "write", "codex") ?? "", /cannot be combined: choose one/);
    assert.match(rawNetworkGrantProblem(ok, "write", "codex", withDefaults({ codex_backend: "exec" })) ?? "", /needs codex_backend "app-server"/);
  });
  await withSwitch(false, () => {
    assert.match(rawNetworkGrantProblem(ok, "write", "codex") ?? "", /not available: relay's stage 2 .* is switched off/);
    assert.equal(rawNetworkGrantProblem({ network: true }, "write", "codex"), null, "nothing changes without the key");
  });
});

test("raw network consent: bound to the grant's network, raw_network and write paths, in any order, and to the text the person saw", () => {
  const a = rawNetworkKey({ network: true, raw_network: true, write_paths: ["/b", "/a"], write_path_pins: [{ path: "/a", dev: 1, ino: 2 }] } as never);
  assert.equal(a, rawNetworkKey({ network: true, raw_network: true, write_paths: ["/a", "/b"] }));
  assert.equal(a, rawNetworkKey({ network: true, raw_network: true, write_paths: ["/a", "/b"], env: ["X"] }), "a turn's environment names are not the grant");
  assert.notEqual(a, rawNetworkKey({ network: true, raw_network: true, write_paths: ["/a"] }));
  assert.notEqual(a, rawNetworkKey({ network: true, raw_network: false, write_paths: ["/a", "/b"] }));
  assert.notEqual(a, rawNetworkKey({ network: false, raw_network: true, write_paths: ["/a", "/b"] }));
  assert.match(JSON.parse(a).text, /^[0-9a-f]{16}$/);
});

test("raw network consent text: names everything the design says the person consents to, and claims nothing more", async () => {
  const t = RAW_NETWORK_CONSENT_TEXT;
  // Raw network, and that it is relay's sandbox rather than Codex's.
  assert.match(t, /raw network/);
  assert.match(t, /TCP, UDP, ssh and DNS to any host/);
  assert.match(t, /inside relay's own sandbox instead of Codex's/);
  // The LAN and the tailnet.
  assert.match(t, /every device and service on your local network \(LAN\) and your tailnet, on any port/);
  // The denied ports: every static one, the snapshot (D4), relay's range, the UDP mappings.
  for (const p of STATIC_DENIED_TCP) assert.match(t, new RegExp(`\\b${p}\\b`), String(p));
  for (const p of STATIC_DENIED_UDP) assert.match(t, new RegExp(`UDP .*\\b${p}\\b`), String(p));
  assert.match(t, /every TCP port anything on this Mac \(your processes or the system's\) is listening on when each turn starts/);
  // The person's own never.ports, held there as the built-ins are (seatbelt-never.ts).
  assert.match(t, /the ports your never\.ports entries name/);
  assert.match(t, /relay's own reserved ports/);
  assert.match(t, /A service you start after a turn starts is reachable/);
  // The IPv6 cost of closing the IPv4-mapped spellings (review R1), and the forwarding and NAT-hairpin residual.
  assert.match(t, /Over IPv6 those TCP ports are refused at every host/);
  assert.match(t, /IPv4 that a program sends through an IPv6 socket \(as Java does\), fails/);
  assert.match(t, /only this Mac's own addresses as destinations: a router port forward reached back through NAT hairpin, a tailnet subnet router or a VM bridge/);
  // Listening: the block only, and its exposure on 0.0.0.0 (D3).
  assert.match(t, /listen only on its own block of 4 TCP ports \(given to it as PORT and PORTS\)/);
  assert.match(t, /binds there on 0\.0\.0\.0 can be reached from your LAN and tailnet/);
  // D6: git writes fail, relay commits.
  assert.match(t, /git commands that write .* fail: relay commits the job's work at the end of each turn/);
  // No stronger words than the design's.
  assert.doesNotMatch(t, /\b(guarantee|cannot reach|secure|safe)\b/i);
  assert.match(rawNetworkText({ id: "j_1", target: "codex" }), /^allow j_1 \(Codex, a write job\) raw network from its shell \(TCP, UDP, ssh, DNS\) inside relay's sandbox, with your local network and tailnet reachable, for the rest of the job$/);
  assert.match(RAW_NETWORK_TURN_NOTE, /^\[relay\] .*\$PORTS .*port 0, are refused.*git commands that write .* fail here/);
  assert.doesNotMatch(RAW_NETWORK_TURN_NOTE, /tools.*not available|cannot delegate or ask/);
  // Raw network retains the same delegation and approval policy as strict network.
  const { delegationPreamble } = await import("../dist/core/prompts.js");
  const node = { id: "j_1", target: "codex", mode: "write", depth: 1, allow_delegation: 1, branch: "relay/j_1", cwd: "/w", worktree: "/w", params_json: "{}" } as never;
  const cfg = withDefaults({ max_depth: 3 });
  const raw = delegationPreamble(node, cfg, "root", "parent", undefined, { network: true, raw_network: true }, true);
  assert.match(raw, /You may delegate further using the relay tools/);
  assert.match(raw, /Jobs you start keep running/);
  assert.doesNotMatch(raw, /tools are not available|cannot delegate or ask/);
  const strict = delegationPreamble(node, cfg, "root", "parent", undefined, { network: true }, true);
  assert.match(strict, /You may delegate further using the relay tools/);
  assert.doesNotMatch(strict, /while your grant has raw network/);
});

test("raw network consent: person-only, and shown with its effect in the approval view", async () => {
  await withRegistry(async ({ createRun, insertNode }) => {
    const { personOnly } = await import("../dist/core/extensions.js");
    const { requestView } = await import("../dist/core/approvals.js");
    const run = createRun("/", withDefaults({}), "s2e-person");
    const n = insertNode({ id: "j_person", run_id: run, kind: "job", target: "codex", task: "t", cwd: "/", mode: "write", depth: 1 });
    assert.equal(personOnly({ kind: "raw_network", node_id: n.id }), true);
    const view = requestView({ id: "r_1", run_id: run, node_id: n.id, kind: "raw_network", summary: rawNetworkText(n), reason: null, detail_json: null, status: "pending", decided_by: null, note: null, created_at: Date.now(), decided_at: null, turn_id: null } as never);
    assert.equal(view.person_only, true);
    assert.equal(view.effect, RAW_NETWORK_CONSENT_TEXT);
  });
});

test("raw network consent: once per grant, gone when the grant changes, and asked again when raw network comes back (toggle away and back); read turns are never asked", async () => {
  await withSwitch(true, () => withRegistry(async ({ createRun, insertNode, insertTurn, getNode, setParam, db }) => {
    const { sessionParams } = await import("../dist/core/params.js");
    const run = createRun("/", withDefaults({}), "s2e-consent");
    const grant = { network: true, raw_network: true, write_paths: [] as string[] };
    const n = insertNode({ id: "j_consent", run_id: run, kind: "job", target: "codex", task: "t", cwd: "/", mode: "write", depth: 1, status: "running", params_json: JSON.stringify({ grant }) });
    const turn = insertTurn(n.id, "caller", "go", "write", "running");
    const consent = () => sessionParams(getNode(n.id)!).raw_network_consent ?? null;
    // Asked: a person-only request is filed; the turn is cancelled once it is, so it is not taken as given.
    const filed = () => (db().prepare("SELECT COUNT(*) AS c FROM requests WHERE node_id = ? AND kind = 'raw_network'").get(n.id) as { c: number }).c;
    const onceFiled = (count: number) => () => filed() >= count;
    const asked = await rawNetworkConsent(getNode(n.id)!, turn, "write", onceFiled(1));
    assert.deepEqual(asked, { cancelled: "cancelled while waiting for the user's consent to its raw network" });
    assert.equal(filed(), 1, "a raw_network request was filed");
    // The consent for this grant, as the person's answer records it: not asked again.
    setParam(n.id, "raw_network_consent", { grant: rawNetworkKey(grant), by: "by the user", at: 1 });
    assert.equal(await rawNetworkConsent(getNode(n.id)!, turn, "write", () => { throw new Error("asked again"); }), null);
    // A read turn of the job keeps it, unasked.
    assert.equal(await rawNetworkConsent(getNode(n.id)!, turn, "read", () => { throw new Error("asked on a read turn"); }), null);
    assert.ok(consent());
    // Raw network taken away: the consent goes, even on a read turn.
    setParam(n.id, "grant", { network: true, write_paths: [] });
    assert.equal(await rawNetworkConsent(getNode(n.id)!, turn, "read", () => true), null);
    assert.equal(consent(), null);
    // And back: asked again, not taken from the earlier consent.
    setParam(n.id, "grant", grant);
    assert.deepEqual(await rawNetworkConsent(getNode(n.id)!, turn, "write", onceFiled(2)), { cancelled: "cancelled while waiting for the user's consent to its raw network" });
    assert.equal(filed(), 2, "asked again");
    // A consent for another grant (other write paths) is gone too.
    setParam(n.id, "raw_network_consent", { grant: rawNetworkKey({ ...grant, write_paths: ["/x"] }), by: "by the user", at: 1 });
    await rawNetworkConsent(getNode(n.id)!, turn, "write", () => true);
    assert.equal(consent(), null);
    // Not a raw-network grant: nothing to ask.
    setParam(n.id, "grant", { network: true });
    assert.equal(await rawNetworkConsent(getNode(n.id)!, turn, "write", () => { throw new Error("asked"); }), null);
    // A malformed legacy grant (raw network without network) is refused, never run with less.
    setParam(n.id, "grant", { raw_network: true });
    assert.match((await rawNetworkConsent(getNode(n.id)!, turn, "write", () => true) as { refusal: string }).refusal, /holds raw_network without network, so its agent was not started/);
  }));
});

test("raw network consent: decided and keyed on the turn's own grant, not the session's current one (resume while queued, review R2)", async () => {
  await withSwitch(true, () => withRegistry(async ({ createRun, insertNode, insertTurn, getNode, setParam, db }) => {
    const { sessionParams } = await import("../dist/core/params.js");
    const run = createRun("/", withDefaults({}), "s2e-queued");
    const g1 = { network: true, raw_network: true, write_paths: [] as string[] };
    const n = insertNode({ id: "j_queued", run_id: run, kind: "job", target: "codex", task: "t", cwd: "/", mode: "write", depth: 1, status: "running", params_json: JSON.stringify({ grant: g1 }) });
    const turn = insertTurn(n.id, "caller", "go", "write", "running");
    // The turn read the job (and so its grant) when it was picked up; a resume then replaced the session's grant.
    const asPickedUp = getNode(n.id)!;
    setParam(n.id, "grant", { network: true, write_paths: [] });
    const filed = () => (db().prepare("SELECT COUNT(*) AS c FROM requests WHERE node_id = ? AND kind = 'raw_network'").get(n.id) as { c: number }).c;
    // The turn launches with G1, so the person is asked about G1 (before the fix: nothing asked, null).
    assert.deepEqual(await rawNetworkConsent(asPickedUp, turn, "write", () => filed() >= 1), { cancelled: "cancelled while waiting for the user's consent to its raw network" });
    assert.equal(filed(), 1);
    // A consent for G1 (as the person's answer to that request records it) ends with the next turn, under G2.
    setParam(n.id, "raw_network_consent", { grant: rawNetworkKey(g1), by: "by the user", at: 1 });
    assert.equal(await rawNetworkConsent(getNode(n.id)!, turn, "write", () => { throw new Error("asked"); }), null);
    assert.equal(sessionParams(getNode(n.id)!).raw_network_consent ?? null, null);
  }));
});

test("raw network consent: with stage 2 switched off, a job still holding the grant is refused, not run with less", async () => {
  await withSwitch(false, () => withRegistry(async ({ createRun, insertNode, insertTurn, getNode }) => {
    const run = createRun("/", withDefaults({}), "s2e-off");
    const n = insertNode({ id: "j_off", run_id: run, kind: "job", target: "codex", task: "t", cwd: "/", mode: "write", depth: 1, status: "running", params_json: JSON.stringify({ grant: { network: true, raw_network: true } }) });
    const turn = insertTurn(n.id, "caller", "go", "write", "running");
    assert.match((await rawNetworkConsent(getNode(n.id)!, turn, "write", () => true) as { refusal: string }).refusal, /stage 2 .* is switched off, so its agent was not started/);
  }));
});

test("local-mode interlock: no local-mode proxy while a raw-network turn runs, and no raw-network turn while a local-mode one runs", async () => {
  await withRegistry(async ({ createRun, insertNode, insertTurn, db }) => {
    const run = createRun("/", withDefaults({}), "s2e-interlock");
    const job = (id: string, target = "codex") => insertNode({ id, run_id: run, kind: "job", target, task: "t", cwd: "/", mode: "write", depth: 1, status: "running" });
    const turn = (node: string, grant: unknown, access: "read" | "write" = "write", status: "running" | "done" | "queued" = "running") => {
      const id = insertTurn(node, "caller", "go", access, status);
      db().prepare("UPDATE turns SET grant_json = ? WHERE id = ?").run(grant === undefined ? null : typeof grant === "string" ? grant : JSON.stringify(grant), id);
      return id;
    };
    const end = (id: number) => db().prepare("UPDATE turns SET status = 'done' WHERE id = ?").run(id);
    assert.equal(localModeInterlock("local"), null);
    assert.equal(localModeInterlock("stage2"), null);

    // A raw-network turn running: local mode is held off, stage 2 is not.
    job("j_raw");
    const raw = turn("j_raw", { network: true, raw_network: true });
    assert.match(localModeInterlock("local") ?? "", /^j_raw is running a turn with raw network \(relay's stage 2\), and relay does not open Codex's local-network proxy while one runs/);
    assert.equal(localModeInterlock("stage2"), null, "two raw-network turns may run together");
    end(raw);
    assert.equal(localModeInterlock("local"), null, "once it has ended");

    // A local-mode turn running: stage 2 is refused, local mode is not.
    job("j_local");
    const local = turn("j_local", { network: true, local_network: true });
    assert.match(localModeInterlock("stage2") ?? "", /^j_local is running a turn in local network mode, and relay does not start a raw-network turn/);
    assert.equal(localModeInterlock("local"), null);
    end(local);

    // Not counted: queued or ended turns, read turns, other targets, strict network.
    turn("j_raw", { network: true, raw_network: true }, "write", "queued");
    turn("j_raw", { network: true, raw_network: true }, "read");
    job("j_claude", "claude");
    turn("j_claude", { network: true, local_network: true });
    job("j_strict");
    turn("j_strict", { network: true });
    turn("j_strict", undefined);
    assert.equal(localModeInterlock("local"), null);
    assert.equal(localModeInterlock("stage2"), null);

    // WP4: malformed relevant records fail both directions closed; flags are not captured policy.
    job("j_bad");
    const bad = turn("j_bad", "{not json");
    assert.match(localModeInterlock("local") ?? "", /cannot read the grant of a running turn of j_bad/);
    assert.match(localModeInterlock("stage2") ?? "", /cannot read the grant of a running turn of j_bad/);
    end(bad);
    const onRun = createRun("/", withDefaults({ targets: { codex: { stage2: true } } } as never), "s2e-interlock-on");
    insertNode({ id: "j_bad_on", run_id: onRun, kind: "job", target: "codex", task: "t", cwd: "/", mode: "write", depth: 1, status: "running" });
    const badOn = turn("j_bad_on", "{not json");
    assert.match(localModeInterlock("local") ?? "", /cannot read the grant of a running turn of j_bad_on/);
    assert.match(localModeInterlock("stage2") ?? "", /cannot read the grant of a running turn of j_bad_on/);
    end(badOn);
    assert.equal(localModeInterlock("local"), null);
  });
});

test("local mode while stage 2 is switched on: refused outright; switched off, unchanged (review R3)", () => {
  const on = withDefaults({ targets: { codex: { stage2: true } } } as never);
  return withSwitch(false, () => {
    assert.equal(localModeRetired(withDefaults({})), null);
    assert.equal(localModeRetired(undefined), null);
    assert.match(localModeRetired(on) ?? "", /^grant\.local_network is not available while relay's stage 2 is switched on .* Use grant\.raw_network .* or grant\.network alone/);
    // The environment override switches it on too.
    process.env[STAGE2_FLAG_ENV] = "1";
    try {
      assert.match(localModeRetired(withDefaults({})) ?? "", /not available while relay's stage 2 is switched on/);
    } finally {
      delete process.env[STAGE2_FLAG_ENV];
    }
  });
});

test("local mode while a stage-2 executor or its survivor still runs: refused even with stage 2 switched off (review R3)", async () => {
  const { recordExecutor, forgetExecutor } = await import("../dist/core/stage2-executors.js");
  const { procStart } = await import("../dist/core/procs.js");
  return withSwitch(false, () => {
    assert.equal(localModeRetired(withDefaults({})), null);
    // This test process stands in for a live executor: the record names it by pid and start time.
    const file = recordExecutor({ pid: process.pid, start: procStart(process.pid, { fresh: true })!, runId: "r_r3", nodeId: "j_r3", turnId: 1, ports: { exec: 61001, block: [61002] }, tmpDir: os.tmpdir() });
    try {
      assert.match(localModeRetired(withDefaults({})) ?? "", /^grant\.local_network is not available: executor .*j_r3.*state running or awaiting verified teardown.*reap\/cancel/);
    } finally {
      forgetExecutor(file);
    }
    assert.equal(localModeRetired(withDefaults({})), null, "gone once the record is");
  });
});

// The switch in config, and the grant through relay's MCP tools.

// These tests exercise standing grants/consent and native profile accounting, not the
// separate escalation executor. Keep network-off jobs native without changing routing.
const STAGE2_ON = { targets: { codex: { stage2: true } }, escalation: false };
const RAW_CAPABLE_STUB = { STUB_VERSION: "codex-cli 0.164.0 (stub)" };

test("stage 2 switch: targets.codex.stage2 in relay's config, Codex only, off by default; the environment override still works", async () => {
  await withSwitch(false, () => {
    assert.equal(stage2Enabled(process.env, withDefaults({})), false);
    assert.equal(stage2Enabled(process.env, withDefaults({ targets: { codex: { stage2: false } } } as never)), false);
    assert.equal(stage2Enabled(process.env, withDefaults(STAGE2_ON as never)), true);
    assert.equal(stage2Enabled({ [STAGE2_FLAG_ENV]: "1" }, withDefaults({})), true);
    assert.equal(rawNetworkGrantProblem({ network: true, raw_network: true }, "write", "codex", withDefaults(STAGE2_ON as never)), null);
    assert.match(rawNetworkGrantProblem({ network: true, raw_network: true }, "write", "codex", withDefaults({})) ?? "", /switched off \(targets\.codex\.stage2/);
  });
  assert.equal(ConfigSchema.safeParse(STAGE2_ON).success, true);
  assert.equal(ConfigSchema.safeParse({ targets: { codex: { stage2: "true" } } }).success, false, "a quoted value is an error");
  assert.equal(ConfigSchema.safeParse({ targets: { claude: { stage2: true } } }).success, false, "Codex only");
});

/** A root session in a host that shows relay's questions to a person, and the person at it (as codex-network.test.ts personSession). */
async function personSession(h: Harness) {
  const open: { message: string; signal: AbortSignal; resolve: (r: Rec) => void }[] = [];
  const inst = await h.instance({
    ...INTERACTIVE_CLAUDE, args: ["--host", hostFor("codex")],
    elicit: (message, signal) => new Promise((resolve) => {
      open.push({ message, signal, resolve });
      signal.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true });
    }),
  });
  const question = (req: Rec) => open.find((q) => !q.signal.aborted && q.message.includes(` ${req.from} asks`));
  return {
    ...inst,
    async answers(req: Rec, decision: "allow" | "deny") {
      let q: ReturnType<typeof question>;
      await until(() => Boolean((q = question(req))), 30000, `relay's question about ${req.request_id}`);
      open.splice(open.indexOf(q!), 1);
      q!.resolve({ action: "accept", content: { decision } });
      await until(() => h.sql("SELECT status FROM requests WHERE id = ?", req.request_id)[0]?.status !== "pending", 30000, `${req.request_id} decided`);
      return q!.message;
    },
  };
}

async function pendingOf(h: Pick<Harness, "call">, id: string, kind: string): Promise<Rec> {
  let req: Rec | undefined;
  await until(async () => {
    const s = await h.call("status", { id, wait_s: 5 });
    req = (s.needs_approval as Rec[] | undefined)?.find((r) => r.kind === kind && r.from === id);
    return Boolean(req);
  }, 60000, `a ${kind} request from ${id}`);
  return req!;
}

const settled = async (h: Pick<Harness, "call">, id: string): Promise<Rec> => {
  let s: Rec = {};
  await until(async () => {
    s = await h.call("status", { id, wait_s: 10 });
    return !["queued", "running"].includes(s.status);
  }, 60000, `${id} to settle`);
  return s;
};

test("raw network grant (MCP): refused where it cannot run, and where nobody could consent; switched off, not available", async () => {
  const h = await harness([{ match: task("RAW"), steps: [{ reply: "done" }] }], STAGE2_ON, RAW_CAPABLE_STUB);
  try {
    const refused = async (args: Rec, re: RegExp) => {
      const r = await h.call("delegate", { task: "RAW", background: false, ...args });
      assert.equal(r.refused, true, JSON.stringify(r));
      assert.match(r.reason, re, JSON.stringify(r));
    };
    await refused({ target: "codex", mode: "read", grant: { network: true, raw_network: true } }, /grant\.raw_network is for Codex write jobs only: a read-only session/);
    await refused({ target: "codex", mode: "write", grant: { raw_network: true } }, /grant\.raw_network needs network: true in the same grant/);
    await refused({ target: "claude", mode: "write", grant: { network: true, raw_network: true } }, /grant\.raw_network is for Codex write jobs only: Claude has no mode/);
    await refused({ target: "codex", mode: "write", grant: { network: true, raw_network: true, local_network: true } }, /cannot be combined: choose one/);
    // Stage 2 switched on: local mode is refused outright (review R3, decision D2).
    await refused({ target: "codex", mode: "write", grant: { network: true, local_network: true } }, /grant\.local_network is not available while relay's stage 2 is switched on \(targets\.codex\.stage2 in relay's config\): Codex's local-network proxy has no authentication/);
    // This harness's root session has no person path: refused up front.
    await refused({ target: "codex", mode: "write", grant: { network: true, raw_network: true } }, /grant\.raw_network needs the user's consent through confirm or a qualified approval dialog/);
    assert.equal(h.starts().length, 0, "nothing started");
  } finally {
    await h.close();
  }
  const off = await harness([{ match: task("RAW"), steps: [{ reply: "done" }] }]);
  try {
    const r = await off.call("delegate", { target: "codex", task: "RAW", mode: "write", background: false, grant: { network: true, raw_network: true } });
    assert.match(r.reason, /grant\.raw_network is not available: relay's stage 2 .* is switched off/, JSON.stringify(r));
    // Switched off, local mode is as in 1.0.5: here refused only because this root has no way to ask the person.
    const local = await off.call("delegate", { target: "codex", task: "RAW", mode: "write", background: false, grant: { network: true, local_network: true } });
    assert.match(local.reason, /grant\.local_network needs the user's consent/, JSON.stringify(local));
  } finally {
    await off.close();
  }
});

test("raw network consent (MCP): the person's alone, before the agent starts; a denial refuses the turn; dropping the grant ends the consent and bringing it back asks again", async () => {
  const h = await harness([{ match: task("RAWJOB"), steps: [{ reply: "done" }] }], { ...STAGE2_ON, escalation: true }, RAW_CAPABLE_STUB);
  try {
    const person = await personSession(h);
    const consentOf = (id: string) => JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", id)[0].params_json).raw_network_consent ?? null;
    const job = await person.call("delegate", { target: "codex", task: "RAWJOB", mode: "write", grant: { network: true, raw_network: true } });
    assert.ok(job.job_id, JSON.stringify(job));
    assert.deepEqual(job.grant, { network: true, raw_network: true, write_paths: [] });
    const req = await pendingOf(person, job.job_id, "raw_network");
    assert.equal(req.person_only, true);
    assert.equal(req.effect, RAW_NETWORK_CONSENT_TEXT);
    assert.match(req.wants, /raw network from its shell \(TCP, UDP, ssh, DNS\) inside relay's sandbox, with your local network and tailnet reachable/);
    assert.equal(h.starts().length, 0, "nothing runs before consent");
    // The root agent's word is not the person's.
    assert.match(JSON.stringify(await person.call("approve", { request_id: req.request_id, decision: "allow" })), /only the user can allow .*: it gives a job's shell raw network/);
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", req.request_id)[0].status, "pending");
    await person.answers(req, "deny");
    const denied = await settled(person, job.job_id);
    assert.equal(denied.status, "failed", JSON.stringify(denied));
    assert.match(denied.error, /consent to this job's raw network was refused .*, so its agent was not started\. Continue it to be asked again/);
    assert.equal(h.starts().length, 0);

    // Continued under the same grant: asked again, and allowed this time; the consent is kept for that grant.
    await person.call("resume", { job_id: job.job_id, message: "RAWJOB again" });
    const again = await pendingOf(person, job.job_id, "raw_network");
    assert.notEqual(again.request_id, req.request_id);
    await person.answers(again, "allow");
    await settled(person, job.job_id);
    const given = consentOf(job.job_id);
    assert.equal(given?.grant, rawNetworkKey({ network: true, raw_network: true, write_paths: [] }));

    // Raw network taken away on resume: the consent ends there.
    await person.call("resume", { job_id: job.job_id, message: "RAWJOB strict", grant: { network: true } });
    assert.equal(consentOf(job.job_id), null);
    await settled(person, job.job_id);
    // And given back: asked again, as for a grant never consented to.
    await person.call("resume", { job_id: job.job_id, message: "RAWJOB back", grant: { network: true, raw_network: true } });
    const back = await pendingOf(person, job.job_id, "raw_network");
    assert.ok(![req.request_id, again.request_id].includes(back.request_id));
    await person.answers(back, "deny");
    assert.equal((await settled(person, job.job_id)).status, "failed");
    assert.equal(h.sql("SELECT id FROM requests WHERE kind = 'raw_network'").length, 3);
    await person.close();
  } finally {
    await h.close();
  }
});

test("raw network consent (MCP): a resume while the turn waits for its slot does not skip the person's consent (review R2)", async () => {
  const h = await harness([
    { match: task("HOLDQ"), steps: [{ awaitMark: "go" }, { reply: "held" }] },
    { match: task("RAWQ"), steps: [{ reply: "done" }] },
  ], {
    ...STAGE2_ON, escalation: true, max_concurrent: 1,
    // RAW_CAPABLE_STUB's Codex version must not make the native Claude holder
    // report 0.164.0 and fail Claude's 2.1.302 minimum before the stub starts.
    targets: { ...STAGE2_ON.targets, claude: { child_env: { drop: ["STUB_VERSION"] } } },
  }, RAW_CAPABLE_STUB);
  try {
    const person = await personSession(h);
    // Another job of the same run (slots are per run) holds the one slot.
    const holder = await person.call("delegate", { target: "claude", task: "HOLDQ", mode: "read" });
    assert.ok(holder.job_id, JSON.stringify(holder));
    await until(() => {
      const status = h.sql("SELECT status FROM nodes WHERE id = ?", holder.job_id)[0]?.status;
      return h.starts().length === 1 || ["done", "failed", "cancelled"].includes(status);
    }, 30000, "the holder to start or fail");
    assert.equal(h.starts().length, 1, `the holder must start: ${JSON.stringify(await person.call("status", { id: holder.job_id }))}`);
    assert.equal(h.starts()[0].target, "claude");
    // The raw-network job's first turn is picked up under G1 and waits for the slot.
    const job = await person.call("delegate", { target: "codex", task: "RAWQ", mode: "write", grant: { network: true, raw_network: true } });
    assert.ok(job.job_id, JSON.stringify(job));
    const first = () => h.sql("SELECT id, status, grant_json, error FROM turns WHERE node_id = ? ORDER BY id", job.job_id)[0];
    await until(() => String(first()?.grant_json ?? "").includes("raw_network"), 30000, "the first turn to record its grant");
    assert.equal(h.sql("SELECT id FROM requests WHERE kind = 'raw_network'").length, 0, "still waiting for the slot, not yet asked");
    // The caller drops raw network while that turn waits.
    const r = await person.call("resume", { job_id: job.job_id, message: "RAWQ strict", grant: { network: true } });
    assert.ok(!r.refused, JSON.stringify(r));
    h.mark("go");
    // The first turn still launches with G1, so the person is asked about it; denied, it does not start.
    const req = await pendingOf(person, job.job_id, "raw_network");
    await person.answers(req, "deny");
    await until(() => first()?.status !== "queued" && first()?.status !== "running", 30000, "the first turn to end");
    assert.equal(first().status, "failed", JSON.stringify(first()));
    assert.match(first().error, /consent to this job's raw network was refused/);
    // A failed turn cancels the queued inbox (outcome.settle). Denying G1 must not silently
    // continue the queued resume: explicitly resume under G2 after that failure.
    const denied = await settled(person, job.job_id);
    assert.equal(denied.status, "failed", JSON.stringify(denied));
    const turns = h.sql("SELECT status, grant_json FROM turns WHERE node_id = ? ORDER BY id", job.job_id);
    assert.deepEqual(turns.map(t => t.status), ["failed", "cancelled"]);
    assert.equal(h.starts().filter(s => s.target === "codex").length, 0, "denied consent starts no Codex agent");
    const strict = await person.call("resume", { job_id: job.job_id, message: "RAWQ strict", grant: { network: true } });
    assert.ok(!strict.refused && !strict.error, JSON.stringify(strict));
    // With stage 2 on, a standing network grant runs on the executor, which this stub Codex doesn't
    // serve, so the turn ends failed at the executor. What matters here happened before that: it
    // ran under G2, with no raw network and no second question.
    await settled(person, job.job_id);
    assert.equal(h.sql("SELECT id FROM requests WHERE kind = 'raw_network'").length, 1, "the explicit G2 resume is not asked");
    const last = h.sql("SELECT status, grant_json FROM turns WHERE node_id = ? ORDER BY id", job.job_id).at(-1);
    assert.ok(!String(last.grant_json ?? "").includes("raw_network"), JSON.stringify(last));
    assert.equal(h.starts().filter((s) => s.target === "codex").length, 0, "the denied and cancelled turns never ran");
    await person.close();
  } finally {
    await h.close();
  }
});

/** Replaces a job's params_json grant directly, as an earlier relay (or a run with stage 2 off) would have stored it, retrying while the worker holds the registry. */
async function storeGrant(h: Harness, id: string, grant: Rec) {
  await until(() => {
    try {
      const params = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", id)[0].params_json);
      h.sql("UPDATE nodes SET params_json = ? WHERE id = ?", JSON.stringify({ ...params, grant }), id);
      return true;
    } catch (e) {
      if ((e as { errcode?: number }).errcode === 5) return false;
      throw e;
    }
  }, 10000, "the registry to take the grant");
}

test("local mode while stage 2 is switched on (MCP): a job holding local_network from before the switch is refused at its turn, asking nobody (review R3)", async () => {
  const h = await harness([{ match: task("PLAIN"), steps: [{ reply: "done" }] }], STAGE2_ON);
  try {
    const job = await h.call("delegate", { target: "codex", task: "PLAIN", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    await storeGrant(h, job.job_id, { network: true, local_network: true, write_paths: [] });
    const before = h.starts().length;
    const r = await h.call("resume", { job_id: job.job_id, message: "PLAIN again" });
    assert.ok(!r.refused, JSON.stringify(r));
    const s = await settled(h, job.job_id);
    assert.equal(s.status, "failed", JSON.stringify(s));
    assert.match(s.error, /grant\.local_network is not available while relay's stage 2 is switched on .*So this job's agent was not started: continue it with one of those grants instead of local_network/);
    assert.equal(h.sql("SELECT id FROM requests WHERE kind = 'local_network'").length, 0, "nobody is asked");
    assert.equal(h.starts().length, before, "the agent was not started again");
  } finally {
    await h.close();
  }
});

test("stage 2 switched on by the config alone, no environment variable: the session path records the turn's enforcement and doctor reports stage 2 (review R5)", async () => {
  assert.equal(process.env[STAGE2_FLAG_ENV], undefined, "this test runs without the environment override");
  for (const on of [true, false]) {
    const h = await harness([{ match: task("PLAIN"), steps: [{ reply: "done" }] }], on ? STAGE2_ON : {});
    try {
      const job = await h.call("delegate", { target: "codex", task: "PLAIN", mode: "write", background: false });
      assert.equal(job.status, "done", JSON.stringify(job));
      const turn = h.sql("SELECT id FROM turns WHERE node_id = ? ORDER BY id", job.job_id)[0].id;
      const recorded = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json).codex_confinement;
      const doctor = h.cli("doctor");
      if (on) {
        // Codex's own sandbox confined it (no raw network), and the record says so.
        assert.deepEqual(recorded, { turn, enforcement: "codex" });
        assert.match(doctor, /codex stage 2 +/);
      } else {
        assert.equal(recorded, undefined);
        assert.doesNotMatch(doctor, /codex stage 2/);
      }
    } finally {
      await h.close();
    }
  }
});

test("raw_network: false with stage 2 switched off is no grant at all, as before stage 2 (review R9); switched on, it is a grant", async () => {
  for (const on of [false, true]) {
    const h = await harness([{ match: task("PARENT"), steps: [{ write: "parent.txt" }, { reply: "done" }] }, { steps: [{ reply: "done" }] }], on ? STAGE2_ON : {});
    try {
      // The root: off, no grant is stored; on, a grant without raw network (so a resume with it drops raw network).
      const root = await h.call("delegate", { target: "codex", task: "ROOT", mode: "write", background: false, grant: { raw_network: false } });
      assert.ok(root.job_id, JSON.stringify(root));
      assert.deepEqual(root.grant, on ? { network: false, write_paths: [] } : undefined, JSON.stringify(root));
      // A launched agent: off, accepted as no grant; on, refused as any grant from it is.
      const parent = await h.call("delegate", { target: "claude", task: "PARENT", mode: "write", background: false });
      assert.equal(parent.status, "done", JSON.stringify(parent));
      const asParent = await h.instance(await h.childOf(parent.job_id, { access: "write" }));
      const kid = await asParent.call("delegate", { target: "codex", task: "KID", mode: "write", background: false, grant: { raw_network: false } });
      if (on) assert.match(kid.reason, /only the root session can grant extra permissions/, JSON.stringify(kid));
      else assert.ok(kid.job_id && !kid.grant, JSON.stringify(kid));
      await asParent.close();
    } finally {
      await h.close();
    }
  }
});

test("raw network grant (MCP): a launched agent cannot give it, its jobs do not inherit it, and without it an agent cannot drive a job that has it", async () => {
  // The parent leaves work in its worktree, which keeps it for the instance that acts as the parent.
  const h = await harness([{ match: task("PARENT"), steps: [{ write: "parent.txt" }, { reply: "done" }] }, { steps: [{ reply: "done" }] }], STAGE2_ON);
  try {
    // A write job of the root's (Claude, so that the job it starts crosses no family), and the job it starts.
    const parent = await h.call("delegate", { target: "claude", task: "PARENT", mode: "write", background: false });
    assert.equal(parent.status, "done", JSON.stringify(parent));
    const asParent = await h.instance(await h.childOf(parent.job_id, { access: "write" }));
    const given = await asParent.call("delegate", { target: "codex", task: "KID", mode: "write", grant: { network: true, raw_network: true } });
    assert.match(given.reason, /only the root session can grant extra permissions/, JSON.stringify(given));
    const kid = await asParent.call("delegate", { target: "codex", task: "KID", mode: "write", background: false });
    assert.ok(kid.job_id, JSON.stringify(kid));
    assert.equal(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", kid.job_id)[0].params_json).grant?.raw_network, undefined, "not inherited");
    // The kid given raw network (as the root's resume would, after the person consented): the parent, without it, can no longer drive it.
    await until(() => {
      try {
        const params = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", kid.job_id)[0].params_json);
        h.sql("UPDATE nodes SET params_json = ? WHERE id = ?", JSON.stringify({ ...params, grant: { network: true, raw_network: true, write_paths: [] } }), kid.job_id);
        return true;
      } catch (e) {
        if ((e as { errcode?: number }).errcode === 5) return false;
        throw e;
      }
    }, 10000, "the registry to take the grant");
    assert.match((await asParent.call("resume", { job_id: kid.job_id, message: "go on" })).reason, /more access than your current turn/);
    assert.match((await asParent.call("cancel", { id: kid.job_id })).reason, /more access than your current turn/);
  } finally {
    await h.close();
  }
});
