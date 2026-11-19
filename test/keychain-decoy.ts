// Decoy-keychain checks (qualification item 33 for Codex; the claude-floor release check for Claude):
// a throwaway keychain with one generic-password item, tried from an agent's sandboxed commands in
// pairs. Floored: the decoy's directory is in never.paths, as ~/Library/Keychains is in the floor, and
// the item must stay out of reach whatever the keychain IPC (the security daemons). Control: the same
// turn without that entry, which must match doctor's documented keychain IPC (core/never-coverage.ts
// neverKeychainIpc). Where that IPC is open (Codex with the network, and Claude's network-on turns,
// the only ones its check runs), the control retrieves the item, which shows that a floored refusal
// comes from the file deny, not from a broken command: that pair is the causal control. Where it is
// closed (Codex without the network) the control is refused too, so that pair only observes that
// the refusal is consistent with the documented IPC; it is no evidence about the file deny.
// Reading an item in a file-based keychain needs both its keychain file and the daemons
// (measured by hand with sandbox-exec on Darwin 27.0, 2026-11-04). Host only, behind
// RELAY_TEST_KEYCHAIN_LIVE=1: it creates a keychain file in a scratch directory (never under
// ~/Library/Keychains) and deletes it afterwards.
//
// It runs only under the test harness's scratch HOME (test/helpers.ts) and refuses otherwise:
// `security` keeps the user search list and default keychain under $HOME, so the person's are never
// written. Every decoy command names the keychain by its path. Checked by hand on Darwin 27.0: under a
// scratch HOME, create-keychain at an explicit path changes neither the scratch nor the person's
// search list or default, and the item is added, read and deleted by that path. The person's search
// list and default keychain are read (HOME set to the account's home) before and after, never set;
// if they differ afterwards, cleanup throws with both readings and how to put them back by hand.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const KEYCHAIN_LIVE = process.env.RELAY_TEST_KEYCHAIN_LIVE === "1";
export const keychainSkip = process.platform !== "darwin" ? "macOS only" : !KEYCHAIN_LIVE ? "host only: RELAY_TEST_KEYCHAIN_LIVE=1" : false;

export const SECURITY = "/usr/bin/security";
/** What a `security` invocation returned; the part of spawnSync's result that matters here. */
export type SecurityResult = { status: number | null; signal?: NodeJS.Signals | null; error?: Error; stdout?: string; stderr?: string };
/** Runs `security` with the inherited (scratch) HOME, or with HOME set to `opts.home`. */
export type SecurityRunner = (args: string[], opts?: { home?: string }) => SecurityResult;
export const runSecurity: SecurityRunner = (args, opts = {}) =>
  spawnSync(SECURITY, args, { encoding: "utf8", timeout: 30000, ...(opts.home ? { env: { ...process.env, HOME: opts.home } } : {}) });

const how = (r: SecurityResult) => (r.error ? String(r.error) : r.signal ? `signal ${r.signal}` : `exit ${r.status}`);
/** Runs `security` with the inherited HOME, and throws unless it ran and exited 0. */
function must(run: SecurityRunner, args: string[]): string {
  const r = run(args);
  if (r.error || r.signal || r.status !== 0) throw new Error(`decoy keychain: security ${args.join(" ")} failed (${how(r)}): ${(r.stderr ?? "").trim()}`);
  return r.stdout ?? "";
}
const paths = (out: string): string[] => out.split("\n").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean);

/**
 * The account's home from the user database, after checking that HOME is somewhere else: the decoy
 * runs only under the test harness's scratch HOME, so `security` never writes the person's keychain
 * preferences. Throws before anything is run or created.
 */
function scratchHomeOnly(): string {
  const accountHome = os.userInfo().homedir;
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return undefined; } };
  const home = process.env.HOME ? real(process.env.HOME) : undefined, account = real(accountHome);
  if (!home || !account || home === account) {
    throw new Error(`decoy keychain: refusing to run with HOME=${JSON.stringify(process.env.HOME ?? "")}: the decoy runs only under the test harness's scratch HOME (test/helpers.ts), so the person's keychain preferences (search list and default keychain, kept under the real home) are never written`);
  }
  return accountHome;
}

/** One read of the person's keychain preferences. A non-zero exit is part of it (there may be no default). */
type Reading = { status: number | null; stdout: string };
type Fingerprint = { list: Reading; dflt: Reading };
const LIST = ["list-keychains", "-d", "user"], DEFAULT = ["default-keychain", "-d", "user"];
function read(run: SecurityRunner, args: string[], home: string): Reading {
  const r = run(args, { home });
  // A read that did not run to completion (spawn error, timeout, signal) says nothing about the state.
  if (r.error || r.signal) throw new Error(`decoy keychain: could not read the person's keychain preferences: security ${args.join(" ")} did not complete (${how(r)})`);
  return { status: r.status, stdout: r.stdout ?? "" };
}
/** The person's search list and default keychain, read with HOME set to the account's home. Writes nothing. */
const fingerprint = (run: SecurityRunner, home: string): Fingerprint => ({ list: read(run, LIST, home), dflt: read(run, DEFAULT, home) });
const sameReading = (a: Reading, b: Reading) => a.status === b.status && a.stdout === b.stdout;
const shown = (r: Reading) => `exit ${r.status} ${JSON.stringify(r.stdout.trim())}`;
const quoted = (ps: string[]) => ps.map((p) => JSON.stringify(p)).join(" ");

/** Throws, with both readings and how to put back what changed, unless `after` reads as `before`. */
function unchanged(before: Fingerprint, after: Fingerprint): void {
  const fixes: string[] = [];
  if (!sameReading(before.list, after.list)) {
    const list = paths(before.list.stdout);
    fixes.push(before.list.status === 0 && list.length
      ? `security list-keychains -d user -s ${quoted(list)}`
      : `the search list read back ${before.list.status === 0 ? "empty" : `as ${shown(before.list)}`} before; check it with security list-keychains -d user`);
  }
  if (!sameReading(before.dflt, after.dflt)) {
    const dflt = paths(before.dflt.stdout)[0];
    fixes.push(before.dflt.status === 0 && dflt
      ? `security default-keychain -d user -s ${quoted([dflt])}`
      : `there was no default keychain before (${shown(before.dflt)}); check it with security default-keychain -d user`);
  }
  if (!fixes.length) return;
  throw new Error("decoy keychain: the person's user keychain search list or default keychain changed while the decoy existed (this helper only reads them).\n" +
    `  before: search list ${shown(before.list)}; default ${shown(before.dflt)}\n` +
    `  after:  search list ${shown(after.list)}; default ${shown(after.dflt)}\n` +
    `Put them back by hand, in a shell with your own HOME: ${fixes.join("; ")}`);
}

export type DecoyKeychain = { dir: string; keychain: string; service: string; account: string; secret: string; command: string[]; cleanup(): void };

/**
 * A decoy keychain in `dir` (which a floored attempt lists in never.paths, as ~/Library/Keychains is
 * in the floor, and its control does not), unlocked, holding one item whose access list trusts
 * /usr/bin/security, as go-keyring's items for `gh` do. Callers create it inside their `try` and
 * call cleanup() in `finally`; a failure while it is being set up cleans up before rethrowing. Runs
 * only under a scratch HOME (see above).
 */
export function decoyKeychain(dir: string, run: SecurityRunner = runSecurity): DecoyKeychain {
  const accountHome = scratchHomeOnly();
  const keychain = path.join(dir, "relay-decoy.keychain-db");
  const password = crypto.randomBytes(16).toString("hex");
  const secret = `RELAY_DECOY_KEYCHAIN_${crypto.randomBytes(8).toString("hex")}`;
  const service = "relay-decoy-keychain-item", account = "relay-decoy";
  const before = fingerprint(run, accountHome);
  let created = false;
  const cleanup = () => {
    const problems: string[] = [];
    if (created || fs.existsSync(keychain)) {
      try { must(run, ["delete-keychain", keychain]); created = false; } catch (err) { problems.push((err as Error).message); }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { problems.push(`decoy keychain: could not remove ${dir}: ${(err as Error).message}`); }
    try { unchanged(before, fingerprint(run, accountHome)); } catch (err) { problems.push((err as Error).message); }
    if (problems.length) throw new Error(problems.join("\n"));
  };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    must(run, ["create-keychain", "-p", password, keychain]);
    created = true;
    must(run, ["set-keychain-settings", keychain]); // No auto-lock during the turn.
    must(run, ["unlock-keychain", "-p", password, keychain]);
    must(run, ["add-generic-password", "-a", account, "-s", service, "-w", secret, "-T", SECURITY, keychain]);
  } catch (err) {
    try { cleanup(); } catch (also) { throw new Error(`${(err as Error).message}\n${(also as Error).message}`); }
    throw err;
  }
  const command = [SECURITY, "find-generic-password", "-a", account, "-s", service, "-w", keychain];
  return { dir, keychain, service, account, secret, command, cleanup };
}

/** One step of a caller's teardown, named for the error that reports its failure. */
export type TeardownStep = readonly [name: string, step: () => unknown];

/**
 * Runs `body`, then every teardown step in the order given, each attempted whatever `body` or an
 * earlier step threw, so a decoy cleanup that throws (by design: a failed delete, changed keychain
 * preferences) cannot skip restoring the environment or removing scratch directories. The order is
 * the caller's to keep: decoy cleanup first, while HOME is still the scratch one, since its
 * mutating `security` commands use the inherited HOME. Failures: the body's own error alone, unchanged,
 * when teardown succeeded; a teardown error alone, unchanged, when only one step failed after a
 * passing body; otherwise an AggregateError holding the body's error first, then each step's, with
 * every message in its own.
 */
export async function withTeardown<T>(body: () => T | Promise<T>, steps: readonly TeardownStep[]): Promise<T> {
  const failures: { name: string; error: unknown }[] = [];
  let result: T | undefined;
  try { result = await body(); } catch (error) { failures.push({ name: "", error }); }
  for (const [name, step] of steps) {
    try { await step(); } catch (error) { failures.push({ name, error }); }
  }
  if (!failures.length) return result as T;
  if (failures.length === 1) throw failures[0].error;
  const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const message = failures.map(({ name, error }) => (name ? `teardown step ${JSON.stringify(name)} also failed: ${text(error)}` : text(error))).join("\n");
  throw new AggregateError(failures.map((f) => f.error), message);
}

/**
 * The decoy command as one shell command line that leaves evidence of having run:
 * `<command> && echo KEYCHAIN_DECOY_EXIT:0 || echo KEYCHAIN_DECOY_EXIT:1`. It uses no shell
 * variables (no `$?`): Claude Code refuses an unattended command whose variables it can't check
 * before it runs, and that refusal leaves no marker. Without the marker the command did not run (a
 * refusal, a launch failure, a timeout, a signal), which is never evidence about the keychain. The
 * line's own text names both markers, so the text echoed back without output reads as two, not one.
 */
export const EXIT_MARKER = "KEYCHAIN_DECOY_EXIT";
export const wrapped = (decoy: DecoyKeychain): string => `${decoy.command.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ")} && echo ${EXIT_MARKER}:0 || echo ${EXIT_MARKER}:1`;

/**
 * Judges one attempt's output, which must carry exactly one exit marker (wrapped() prints one; its
 * text, echoed back, holds two). The secret with a marker of 0 is a retrieval; a nonzero marker
 * without the secret is a refusal; anything else (no marker, several, a 0 without the secret, the
 * secret with a nonzero marker) is not evidence, and throws.
 */
export function attempt(decoy: DecoyKeychain, output: string): "retrieved" | "refused" {
  const markers = [...output.matchAll(new RegExp(`${EXIT_MARKER}:(\\d+)`, "g"))].map((m) => Number(m[1]));
  if (markers.length !== 1) throw new Error(`decoy keychain: expected one ${EXIT_MARKER} marker in the attempt's output, found ${markers.length}; the command did not run as expected, which is not evidence. Its output (last 600 characters, secret redacted): ${JSON.stringify(output.replaceAll(decoy.secret, "<secret>").slice(-600))}`);
  const got = output.includes(decoy.secret);
  if (got && markers[0] === 0) return "retrieved";
  if (!got && markers[0] !== 0) return "refused";
  throw new Error(`decoy keychain: inconsistent attempt (exit ${markers[0]}, secret ${got ? "printed" : "absent"}); not evidence`);
}

/** Whether `output` shows the decoy's secret (the unsandboxed positive control). */
export const retrieved = (decoy: DecoyKeychain, output: string): boolean => output.includes(decoy.secret);
