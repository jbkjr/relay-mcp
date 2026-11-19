// WP6 shares these suites between release qualification and the red-team runner.
// Existing Node tests are the probes; no second lifecycle/proxy implementation lives here.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const ESCALATION_CASES = {
  23: { name: "out-of-profile hosted/open-page and extension screening, distinguishing exact model websocket upgrades", parts: {
    unit: { files: ["never-tools", "stage2-escalation-qualification"], min: 10 },
    surfaces: { files: ["stable-surfaces"], pattern: "registered MCP tools", min: 1 },
    freshResume: { files: ["stage2-standing-live"], pattern: "^hostile web live:", min: 2, host: true, timeoutMs: 500_000, env: { RELAY_TEST_STANDING_LIVE: "1" } },
    overlay: { files: ["stage2-escalation-live"], pattern: "live worker:.*hostile-(direct|code) result", min: 2, host: true, timeoutMs: 400_000, env: { RELAY_TEST_STAGE2_LIVE: "1" } },
  } },
  24: { name: "restart receipt, first call, replay, cancellation and handoff loss", parts: {
    unit: { files: ["stage2-escalation"], min: 40 },
    worker: { files: ["stage2-escalation-live"], pattern: "live worker:.*port0 result", min: 1, host: true, env: { RELAY_TEST_STAGE2_LIVE: "1" } },
    cancel: { files: ["stage2-escalation-live"], pattern: "live worker:.*cancel result", min: 1, host: true, env: { RELAY_TEST_STAGE2_LIVE: "1" } },
    http: { files: ["stage2-escalation-live"], pattern: "^WP3 live HTTP", min: 1, host: true, env: { RELAY_TEST_ESCALATION_HTTP: "1" } },
    code: { files: ["stage2-escalation-live"], pattern: "live worker:.*(port0-code|cancel-code) result", min: 2, host: true, timeoutMs: 400_000, env: { RELAY_TEST_STAGE2_LIVE: "1" } },
    mismatch: { files: ["stage2-escalation-live"], pattern: "live worker:.*(identity|readback)-mismatch result", min: 2, host: true, timeoutMs: 400_000, env: { RELAY_TEST_STAGE2_LIVE: "1" } },
  } },
  25: { name: "authenticated authority adversaries and consume isolation", parts: {
    unit: { files: ["stage2-escalation", "restart-overlay"], min: 70 },
  } },
  26: { name: "finite deadline, worker-death/reap and monotonic floor races", parts: {
    unit: { files: ["restart-overlay", "never-policy"], skipPattern: "grant admission rechecks kept|stale native temp alias repair|X1 never refusals preserve", min: 40 },
    hostRoots: { files: ["never-policy"], pattern: "^grant admission rechecks kept|^stale native temp alias repair|^X1 never refusals preserve", min: 3, host: true },
    crash: { files: ["stage2-escalation-live"], pattern: "live worker:.*mediated-crash result", min: 1, host: true, timeoutMs: 300_000, env: { RELAY_TEST_MEDIATED_LIVE: "1" } },
  } },
  27: { name: "overlay decoy profiles, exact listen, outside roots and raw-host refusal", parts: {
    unit: { files: ["restart-overlay-profile", "restart-overlay"], min: 35 },
    planner: { files: ["stage2-probe"], pattern: "^stage-2 overlay expectation|^stage-2 overlay probe plan:|^stage-2 decoy network:", min: 3 },
    kernel: { files: ["stage2-probe"], pattern: "^stage-2 overlay live controls:", min: 1, host: true },
    profiles: { files: ["stage2-escalation-live"], pattern: "live worker:.*(port0|listen|connect|write) result", min: 4, host: true, timeoutMs: 650_000, env: { RELAY_TEST_STAGE2_LIVE: "1" } },
  } },
  28: { name: "mediated DNS, aliases, teardown, bypass and credentials", parts: {
    unit: { files: ["mediated-network", "mediated-proxy"], min: 23 },
    addresses: { files: ["proxy"], pattern: "^proxy: address and host-name checks|^proxy: the on-link check|^proxy: a name resolving to one of this machine", min: 3 },
    worker: { files: ["stage2-escalation-live"], pattern: "live worker:.*mediated result", min: 1, host: true, env: { RELAY_TEST_MEDIATED_LIVE: "1" } },
    public: { files: ["stage2-escalation-live"], pattern: "live worker:.*mediated-public result", min: 1, host: true, optIn: "RELAY_TEST_PUBLIC_NET" },
    crossJobCrash: { files: ["stage2-escalation-live"], pattern: "live worker:.*mediated-crash result", min: 1, host: true, timeoutMs: 300_000, env: { RELAY_TEST_MEDIATED_LIVE: "1" } },
  } },
  29: { name: "local refusal, interlock and Claude/ACP never proxies", parts: {
    unit: { files: ["wp4-interlock", "wp4-adapters", "mediated-proxy"], min: 25 },
    decisions: { files: ["stage2-network-decisions"], min: 2 },
    local: { files: ["stage2-grant"], pattern: "^local-mode interlock|^local mode while stage 2 is switched on:|^raw network grant:", min: 3 },
    // The installed Claude case with stage 2 on, and the ACP case. Its stage-2-off variant is the
    // claude-floor release check below, not a Codex pin requirement.
    nativeProfiles: { files: ["stage2-native-live"], pattern: "^stage2 native live:", skipPattern: "\\(stage 2 off\\)", min: 2, host: true, timeoutMs: 500_000, env: { RELAY_TEST_STAGE2_NATIVE_LIVE: "1" } },
  } },
  31: { name: "standing network: stage2 routing, never hosts, proxy variables, refusal and resume", parts: {
    unit: { files: ["stage2-network-decisions", "mediated-network"], min: 14 },
    executor: { files: ["stage2-executor"], pattern: "^BB: open order", min: 1 },
    live: { files: ["stage2-standing-live"], pattern: "^standing mediated live:", min: 4, host: true, timeoutMs: 1_000_000, env: { RELAY_TEST_STANDING_LIVE: "1" } },
  } },
  32: { name: "IPv4 localhost connect: disclosed LAN/tailnet scope, never and other-port denial", parts: {
    unit: { files: ["stage2-network-decisions", "restart-overlay-profile"], min: 12 },
    accounting: { files: ["stage2-escalation"], pattern: "^localhost connect (discloses|refuses)", min: 2 },
    planner: { files: ["stage2-probe"], pattern: "^stage-2 overlay probe plan:|^stage-2 decoy network:", min: 2 },
    kernel: { files: ["restart-overlay-live"], min: 1, host: true, env: { RELAY_TEST_STAGE2_LIVE: "1" } },
    worker: { files: ["stage2-escalation-live"], pattern: "live worker:.*connect result", min: 1, host: true, env: { RELAY_TEST_STAGE2_LIVE: "1" } },
  } },
  // The keychain under the never floor: the floor denies the keychain files, and only relay's own
  // Seatbelt denies the security daemons too. Reading an item in a file-based keychain needs both.
  // A decoy keychain item is tried from native Codex turns, two for each network state: floored
  // (its directory in never.paths, as the keychains are) it must be refused on every turn; the
  // control, without that entry, must match doctor's documented keychain IPC (core/never-coverage.ts
  // neverKeychainIpc). Network on (IPC open) the control retrieves the item, which shows the floored
  // refusal comes from the file deny; network off (IPC closed) both are refused, a consistency check
  // only. A new Codex version can change its seatbelt policy, so this belongs to the pin. Claude's
  // side is the claude-floor release check.
  33: { name: "the keychain under the never floor: a decoy keychain item is refused to floored native Codex turns, and its control without the file deny matches doctor's documented keychain IPC", parts: {
    codex: { files: ["codex-permissions"], pattern: "^keychain decoy live \\(codex", min: 4, host: true, timeoutMs: 300_000, env: { RELAY_TEST_KEYCHAIN_LIVE: "1", RELAY_REQUIRE_REAL_CODEX: "1" } },
  } },
};

// Release checks: run with the release gates and the red team, never by the Codex pin qualifier
// (codex-stage2.mjs takes ESCALATION_CASES only), so they add no pin dependency. Item 29's
// nativeProfiles still runs the installed Claude CLI (stage 2 on), as before.
export const RELEASE_CHECK_CASES = {
  // Claude takes the never floor whatever stage 2 says (core/never-coverage.ts).
  "claude-floor": { name: "Claude under the never floor with stage 2 off: installed CLI settings and native tools, and a decoy keychain item refused to a floored turn, with its control matching doctor's keychain IPC", parts: {
    nativeStage2Off: { files: ["stage2-native-live"], pattern: "^stage2 native live: installed Claude.*\\(stage 2 off\\)", min: 1, host: true, timeoutMs: 400_000, env: { RELAY_TEST_STAGE2_NATIVE_LIVE: "1" } },
    keychainDecoy: { files: ["stage2-native-live"], pattern: "^keychain decoy live \\(claude", min: 2, host: true, timeoutMs: 400_000, env: { RELAY_TEST_KEYCHAIN_LIVE: "1" } },
  } },
};

// Node TAP summaries are evidence, unlike an exit code from a test filter matching nothing.
export function judgeTestRun({ output, code, signal, error }, minimum = 1) {
  const count = key => Number(new RegExp(`^# ${key} (\\d+)$`, "m").exec(output ?? "")?.[1] ?? NaN);
  const counts = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped", "todo"].map(k => [k, count(k)]));
  const why = [];
  if (error || signal || code !== 0) why.push(error ?? `test process exit ${code}, signal ${signal ?? "none"}`);
  if (!Number.isSafeInteger(counts.tests) || counts.pass < minimum || counts.pass !== counts.tests || counts.fail !== 0 || counts.cancelled !== 0 || counts.skipped !== 0 || counts.todo !== 0) why.push(`incomplete test evidence: ${JSON.stringify(counts)}, require at least ${minimum} passes and no skips`);
  return { state: why.length ? "failed" : "passed", why: why.join("; "), counts };
}

export async function runEscalationSuite({ checkout, dir, bin, id, name, spec, timeoutMs = spec.timeoutMs ?? 180_000 }) {
  if (spec.host && process.platform !== "darwin") return { state: "not run", why: "requires a macOS host" };
  if (spec.optIn && process.env[spec.optIn] !== "1") return { state: "not run", why: `opt in with ${spec.optIn}=1` };
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, `escalation-${id}-${name}.tap`);
  const args = ["--test", "--test-reporter=tap", "--test-concurrency=1", "--test-timeout=150000", ...(spec.pattern ? [`--test-name-pattern=${spec.pattern}`] : []), ...(spec.skipPattern ? [`--test-skip-pattern=${spec.skipPattern}`] : []), ...spec.files.map(f => `test/${f}.test.ts`)];
  const result = await new Promise(resolve => {
    // The live harness creates all homes, roots, credentials and ports itself.
    const child = spawn(process.execPath, args, { cwd: checkout, env: { ...process.env, ...spec.env, RELAY_TEST_CODEX: bin }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error;
    const sink = fs.createWriteStream(log, { mode: 0o600 });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", b => { sink.write(b); output = (output + b).slice(-128 * 1024); });
    const timer = setTimeout(() => { error = `suite exceeded ${timeoutMs} ms`; child.kill("SIGTERM"); }, timeoutMs);
    // Node's own test timeout aborts the live harness first; its finally stops workers/executors.
    child.once("error", e => { error = String(e); });
    child.once("close", (code, signal) => { clearTimeout(timer); sink.end(() => resolve({ output, code, signal, error })); });
  });
  return { ...judgeTestRun(result, spec.min), log };
}

export async function runEscalationItem(ctx, id, cases = ESCALATION_CASES) {
  const c = cases[id];
  const parts = {};
  for (const [name, spec] of Object.entries(c.parts)) parts[name] = await runEscalationSuite({ ...ctx, id, name, spec });
  // Known missing integrated evidence cannot accidentally qualify a release.
  if (c.gap) parts.coverage = { state: "pending integration", why: c.gap };
  return parts;
}
