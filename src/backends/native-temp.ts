import fs from "node:fs";
import path from "node:path";
import { checkNativeTempAlias, claudeTempFits, ensureNativeTempAlias, ensurePrivateRoot, nativeTempAlias, nativeTempRoot } from "../confine/private-root.js";
import { privateTurnTemp } from "../confine/turn.js";
import { getTurn, updateTurn } from "../core/db.js";
import { capturedRootEnvironment, selectEnvironment } from "../core/env-policy.js";
import type { RelayConfig } from "../core/config.js";
import { appendLog, logBytes } from "../core/storage.js";
import { olderVersion } from "../targets/index.js";
import { englishList, newest, VERIFIED } from "../targets/verified.js";
import { installedVersion } from "./cli-version.js";
import type { TurnHandle, TurnSpec } from "./types.js";

const TOO_LONG = "Claude's private temporary path would exceed its 44-byte limit and fall back to shared temp";

/**
 * The newest Claude Code whose temporary-directory code relay has read (VERIFIED.claudeTempLink,
 * targets/verified.ts): each version there measures CLAUDE_CODE_TMPDIR before resolving links,
 * which is what makes the short link keep Claude out of shared temp
 * (docs/research/claude-temp-limit.md, which also names the versions not read). Relay's version
 * gate is a floor, and Claude updates itself, so the link is refused for anything newer. Raise it
 * only after re-reading that code in the newer version (scripts/release-watch does, by behaviour).
 */
export const CLAUDE_TEMP_LINK_VERIFIED_THROUGH: readonly number[] = newest("claudeTempLink").split(".").map(Number);

/** What makes `have` a version whose temp code relay has not read (newer than the ceiling, or unreadable), or null. */
function unreadVersion(have: readonly number[] | null, bin: string): string | null {
  const top = CLAUDE_TEMP_LINK_VERIFIED_THROUGH.join(".");
  const which = !have ? `relay could not read a version from \`${bin} --version\``
    : olderVersion(CLAUDE_TEMP_LINK_VERIFIED_THROUGH, have) ? `${bin} is Claude Code ${have.join(".")}, newer than ${top}` : null;
  return which && `${which}, the newest version whose temporary-directory code relay has read`;
}

/**
 * Why relay's long-home link may not be used with the Claude Code `bin` reports as `have` (null:
 * unreadable), or null when it may: at or below CLAUDE_TEMP_LINK_VERIFIED_THROUGH, or allow_untested.
 */
export function linkVersionProblem(have: readonly number[] | null, bin: string, allowUntested: boolean): string | null {
  const which = allowUntested ? null : unreadVersion(have, bin);
  if (!which) return null;
  const top = CLAUDE_TEMP_LINK_VERIFIED_THROUGH.join(".");
  return `${which}. This is the check on relay's long-home workaround: ` +
    `under a home this long relay hands Claude its private temporary directory through a short link, which keeps Claude out of shared temp only while Claude measures CLAUDE_CODE_TMPDIR before resolving links, as ${englishList(VERIFIED.claudeTempLink)} do. ` +
    `Pin Claude Code to ${top} or older (targets.claude.bin can name that version's binary), or update relay once a release has re-read that code; or set "allow_untested": true in relay's config to run anyway, unverified`;
}

/**
 * Why Claude may not be launched with `env`, by the link's ceiling (linkVersionProblem), or null:
 * asked with the environment Claude is launched with, beside the version gate and on the same read
 * (run.ts launchTurn), whenever that environment names Claude's temp through relay's short link.
 * nativeTemp asks first, before it uses the link, with the turn's selected environment, since
 * Claude's own does not exist yet; but one launcher can report another version under the
 * environment it runs with (review 2026-11-09, item I2), so the launch is checked by its own.
 */
export function linkLaunchProblem(config: RelayConfig, env: NodeJS.ProcessEnv): string | null {
  if (config.allow_untested) return null;
  const link = nativeTempAlias();
  const through = (p: string | undefined) => {
    if (!p) return false;
    const rel = path.relative(link, path.resolve(p));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (!through(env.CLAUDE_CODE_TMPDIR) && !through(env.TMPDIR)) return null;
  const { bin } = config.targets.claude;
  const version = linkVersionProblem(installedVersion("claude", bin, env), bin, false);
  return version && `Claude's private temporary directory is named through relay's short link ${link} for this launch, which relay does not use here: ${version}`;
}

/**
 * The name Claude is given for its private directory `dir` (in `~/.rn`): `dir` itself when it fits
 * Claude's limit, or else the same directory through relay's short link, checked on each use, when
 * `versionProblem` (asked only then) has none. A turn makes a missing link; `create: false` (doctor's
 * probe) only uses one already there. Refuses when neither name fits, the Claude version is not one
 * whose temp code relay has read, or the link is missing or cannot be trusted; never shared temp.
 */
export function claudeTempPath(dir: string, versionProblem: () => string | null, o: { create: boolean } = { create: true }): string {
  if (claudeTempFits(dir)) return dir;
  const link = nativeTempAlias();
  const short = path.join(link, path.basename(dir));
  // Nothing is made outside the home for a name that would not fit anyway (a uid over five digits),
  // or for a Claude version the link has not been checked against.
  if (!claudeTempFits(short)) throw new Error(`${TOO_LONG}, even through relay's short link ${short}; use a shorter home path before launching this turn`);
  const version = versionProblem();
  if (version) throw new Error(`${TOO_LONG}, and relay does not use its short link ${link} here: ${version}`);
  if (o.create) {
    try { ensureNativeTempAlias(path.dirname(dir)); }
    catch (err) { throw new Error(`${TOO_LONG}, and ${(err as Error).message}`); }
  } else {
    const found = checkNativeTempAlias(path.dirname(dir));
    if (found.state === "missing") throw new Error(`${TOO_LONG}, and relay's short link ${link} is not there yet; relay makes it on the first Claude turn`);
    if (found.state === "stale") throw new Error(`${TOO_LONG}, and relay's short link ${link} points to missing earlier private directory ${found.target}; relay repoints it on the first Claude turn`);
    if (found.state === "refused") throw new Error(`${TOO_LONG}, and ${found.problem}`);
  }
  const via = fs.statSync(short);
  const real = fs.lstatSync(dir);
  if (via.dev !== real.dev || via.ino !== real.ino) throw new Error(`${TOO_LONG}, and ${short} does not lead to ${dir}`);
  return short;
}

/**
 * Doctor's report on the long-home link, from the checks a Claude turn makes, making nothing; null
 * for a home short enough not to need it. `level` is how doctor says it; `usable` whether a Claude
 * turn (and doctor's init probe) could have its private temp now. `version` is what doctor read.
 */
export function claudeLinkDoctor(version: readonly number[] | null, bin: string, allowUntested: boolean): { level: "line" | "warn"; usable: boolean; text: string } | null {
  const root = nativeTempRoot();
  if (claudeTempFits(path.join(root, "Ab12Cd"))) return null;
  const link = nativeTempAlias();
  const top = CLAUDE_TEMP_LINK_VERIFIED_THROUGH.join(".");
  const refuses = (why: string) => ({ level: "warn" as const, usable: false, text: `relay refuses every Claude turn here: ${why}` });
  if (!claudeTempFits(path.join(link, "Ab12Cd"))) {
    return refuses(`${root} is too long for Claude's 44-byte temporary-directory limit, and so is relay's short link ${link} with a uid of ${String(process.getuid?.() ?? 0).length} digits. Use an account with a shorter home path, or a shorter uid`);
  }
  const unread = unreadVersion(version, bin);
  if (unread && !allowUntested) return refuses(linkVersionProblem(version, bin, false)!);
  const found = checkNativeTempAlias(root);
  if (found.state === "refused") return refuses(found.problem);
  const intro = `${root} is too long for Claude's 44-byte temporary-directory limit, so Claude gets its private temp through relay's short link ${link}`;
  const state = found.state === "missing" ? "not there yet; relay makes it on the first Claude turn"
    : found.state === "stale" ? `points to missing earlier private directory ${found.target}; relay repoints it on the first Claude turn`
    : "in place, yours and leading there";
  if (unread) return { level: "warn", usable: found.state === "ok", text: `${intro}: ${state}. ${unread}; allow_untested is set, so relay uses the link anyway, unverified` };
  return { level: "line", usable: found.state === "ok", text: `${intro}: ${state}; checked against Claude Code through ${top}` };
}

/**
 * Each native sandbox gets only its own TMPDIR, outside the shared /tmp allowances. `start` gets the
 * directory and the name the agent is to use for it: the same, except for a Claude turn whose
 * directory is too long for Claude (claudeTempPath). The registry and the sweep know only the directory.
 */
export async function nativeTemp(spec: TurnSpec, start: (dir: string, agentDir: string) => Promise<TurnHandle>): Promise<TurnHandle> {
  const dir = privateTurnTemp(ensurePrivateRoot(nativeTempRoot()), "");
  // Descendants may still be closing files when the process group exits. Bound the retries, and
  // keep a cleanup failure out of the worker's control flow: the registry/sweep retains this path.
  const remove = (): string[] => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return [];
    } catch (error) {
      const warning = `relay could not remove native turn's private temporary directory ${dir}: ${(error as Error).message}. Private temporary files may remain; relay's temp sweep can retry cleanup.`;
      const logProblem = spec.logPath ? appendLog(spec.logPath, `[relay] ${warning}\n`, { maxBytes: logBytes(spec.config) }) : null;
      return [warning, ...(logProblem ? [logProblem] : [])];
    }
  };
  const cleanupError = (error: unknown): unknown => {
    const warnings = remove();
    return warnings.length ? new Error(`${(error as Error).message} ${warnings.join(" ")}`, { cause: error }) : error;
  };
  try {
    const agentDir = spec.target.id === "claude" ? claudeTempPath(dir, () => {
      // Before the link is used, with the turn's selected environment, from the gate's cache (cli-version.ts): read again when
      // the executable or the environment changes, and after a minute. The launch is checked again with its own (linkLaunchProblem).
      const { bin } = spec.config.targets.claude;
      if (spec.config.allow_untested) return null;
      return linkVersionProblem(installedVersion("claude", bin, spec.environment ?? selectEnvironment("claude", spec.config, capturedRootEnvironment).env), bin, false);
    }) : dir;
    const id = spec.turnId ?? spec.relay?.turnId;
    if (id !== undefined) {
      const turn = getTurn(id);
      if (!turn || turn.node_id !== spec.markers.nodeId || turn.status !== "running") throw new Error("cannot record temp state for an inactive turn");
      const st = fs.lstatSync(dir);
      updateTurn(id, { tmp_dir: dir, tmp_dev: st.dev, tmp_ino: st.ino });
    }
    const handle = await start(dir, agentDir);
    const done = handle.done.then((result) => {
      const warnings = remove();
      return warnings.length ? { ...result, warnings: [...(result.warnings ?? []), ...warnings] } : result;
    }, (error) => { throw cleanupError(error); });
    return { ...handle, done, cancel: async () => { await handle.cancel(); await done; } };
  } catch (error) { throw cleanupError(error); }
}
