// Whether this process has no login session, in which relay's own sandbox cannot show that it
// refuses Apple Events, so that relay refuses every harness it confines itself. Under a launchd
// daemon (no Aqua session) that is the case; under a desktop login it is not. The stage-2 driver
// (codex-stage2.mjs) asks this so that what the gap stops is reported as "not run: no login
// session", and nothing else is. It is decided from relay's own probes run unchanged.
// The release watcher's lane logic built on it lives in scripts/release-watch/lanes.mjs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Runs a command without a shell: { ok, status, stdout, stderr }, never throwing. */
function tryRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  return { ok: !r.error && r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error?.message ?? "") };
}

/** What relay says when its apple-events probe fails for want of a login session: osascript cannot get its sandbox extensions. */
export const NO_SESSION_REFUSAL = /boundary probe apple-events was not shown to be refused by the sandbox \(exit [1-9]\d*: sandbox_extension_issue_file failed/;
/**
 * The same failure as a test sees it: relay's refusal above; the probe's own result, osascript
 * failing to get a sandbox extension for its preferences (test/probe.test.ts reads it directly); or
 * relay naming the apple-events probe as the one that refused where a test expected another (the
 * first probe to fail is that one here), as an equality diff or as the stage-2 negative controls'
 * own message ("<rule>: refused on apple-events", test/stage2-probe.test.ts).
 */
export const NO_SESSION_EVIDENCE = new RegExp(`${NO_SESSION_REFUSAL.source}|exit [1-9]\\d*: sandbox_extension_issue_file failed for \\S*/Library/Preferences/com\\.apple\\.osascript\\.plist|\\+ 'apple-events'\\s+- '[\\w-]+'|: refused on apple-events(?![\\w-])`);

/** The launchd session this process runs in: "Aqua" in a login session, "System" under a LaunchDaemon, "Background" or another. */
export function sessionManager() {
  const r = tryRun("launchctl", ["managername"]);
  return r.ok ? r.stdout.trim() : null;
}

/**
 * Whether relay-enforced confinement launches here, as relay itself decides it before a launch:
 * relay's `prepareLaunch` (dist/confine/index.js, unchanged) with its boundary probes, for a read
 * turn of a scratch harness script in a scratch tree, in a child process whose HOME and RELAY_HOME are
 * scratch too. Nothing is launched. Returns { ok } or { ok: false, check, message }.
 */
export function confinedLaunch(checkout) {
  // Short paths under /tmp: the probes listen on Unix sockets, whose paths must stay under 104 bytes.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rwc-"));
  try {
    const tmp = path.join(root, "t");
    fs.mkdirSync(tmp);
    const r = tryRun(process.execPath, ["--input-type=module", "-e", CHILD, path.join(checkout, "dist", "confine", "index.js"), root], {
      env: { PATH: process.env.PATH, HOME: path.join(root, "home"), RELAY_HOME: path.join(root, "control"), TMPDIR: tmp }, timeout: 120_000,
    });
    try { return JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch { return { ok: false, check: "none", message: `relay's confinement check gave no answer (exit ${r.status}): ${r.stderr.slice(-300)}` }; }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const CHILD = `
import fs from "node:fs";
import path from "node:path";

/** Runs a command without a shell: { ok, status, stdout, stderr }, never throwing. */
function tryRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  return { ok: !r.error && r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error?.message ?? "") };
}
const [indexJs, root] = process.argv.slice(1);
const { confinement, prepareLaunch } = await import(indexJs);
const wt = path.join(root, "wt"), tmp = path.join(root, "tmp"), control = path.join(root, "control"), home = path.join(root, "home"), bin = path.join(root, "bin");
for (const d of [wt, tmp, control, home, bin]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\\n");
const harness = path.join(bin, "harness");
fs.writeFileSync(harness, "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
const found = confinement();
if (!found.mechanism) { console.log(JSON.stringify({ ok: false, check: "mechanism", message: found.reason })); process.exit(0); }
try {
  await prepareLaunch(found.mechanism, { worktree: wt, worktreeWritable: false, tmpDir: tmp, denied: [control], network: { mode: "off-except-proxy", proxyPort: 9, proxyToken: "p".repeat(32) } }, harness, []);
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, check: err.check ?? "error", message: String(err.message).slice(0, 600) }));
}
`;

/**
 * Whether this process has the gap: no login session (launchctl), and relay's own apple-events probe
 * refused for want of one (NO_SESSION_REFUSAL). Both must hold; anything else is not this gap.
 */
export function noLoginSession(checkout) {
  const manager = sessionManager();
  if (manager === "Aqua") return { gap: false, manager, why: "a login session (launchctl managername: Aqua)" };
  const probe = confinedLaunch(checkout);
  const gap = !probe.ok && probe.check === "apple-events" && NO_SESSION_REFUSAL.test(probe.message);
  return {
    gap, manager, probe,
    why: gap
      ? `launchctl managername: ${manager}, and relay's own boundary probe refuses for want of one: ${probe.message.slice(0, 300)}`
      : `launchctl managername: ${manager}; relay's confinement check: ${probe.ok ? "launches" : `${probe.check}: ${probe.message.slice(0, 300)}`}`,
  };
}
