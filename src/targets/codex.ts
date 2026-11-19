import { shellQuote } from "../core/shell.js";
import type { TargetDef } from "./types.js";

/** Codex filters MCP server environments; keep home discovery and native host identity. */
export const CODEX_MCP_ENV_VARS = ["CODEX_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"];

/**
 * Why a Codex agent cannot be given `dir` to write, or null: a granted directory, the repository's
 * git directories under child_git "native", or a write turn's own directory, each a workspace root
 * of relay's profile (backends/codex.ts codexPermissions). Codex 0.164.0 writes every directory its
 * sandbox makes writable into the Seatbelt profile its commands run in, inside a regex literal
 * (`#"…"`, which keeps the .git, .codex and .agents at its top read-only) that a double quote in
 * the name ends early: it escapes the quote with a backslash, which such a literal does not take
 * (codex-rs sandboxing/src/seatbelt.rs, seatbelt_protected_metadata_name_regex). The profile then
 * does not compile, with the rest of the name read as profile text, and no command runs. A tab, a
 * line feed or a carriage return in the name of a root relay names in the profile (a grant, a git
 * directory) leaves that directory unwritable, with nothing said; other control characters work,
 * with the names at its top still read-only. As the directory a command runs in (`codex sandbox`'s
 * working directory) those three worked too, but relay refuses them for the turn's own directory
 * as well: an app-server turn names it as a runtime workspace root, which was not tried. Seen with
 * codex-cli 0.164.0 (test/codex-permissions.test.ts).
 */
export function codexWriteRootProblem(dir: string): string | null {
  if (dir.includes('"')) return "holds a double quote, and Codex's sandbox cannot be built with a directory so named writable: the agent could run no command at all";
  if (/[\t\n\r]/.test(dir)) return "holds a tab or a line break, and Codex's sandbox can leave a directory so named unwritable, saying nothing";
  return null;
}

/** The registration relay gives a launched Codex, including extension approval waits. */
export function codexToolTimeoutS(approvalTimeoutS: number, overlayBudgetS = 3600): number {
  const total = Math.ceil(Math.max(3600, 2 * approvalTimeoutS + 300) + overlayBudgetS + 300);
  // Pinned Codex reads an unsigned integer; keep the registration representable and exact.
  if (!Number.isFinite(approvalTimeoutS) || approvalTimeoutS <= 0 || !Number.isFinite(overlayBudgetS) || overlayBudgetS <= 0 || !Number.isSafeInteger(total) || total > 0xffffffff) throw new Error("Codex MCP timeout cannot represent the finite approval/overlay/transition budget");
  return total;
}

/** OpenAI's Codex CLI, run through `codex app-server` (or `codex exec`). */
export const codex: TargetDef = {
  id: "codex",
  vendor: "openai",
  ownModels: /^(gpt-|o\d|codex-|chatgpt-)/i,
  enabledByDefault: true,
  defaultBin: "codex",
  name: "Codex",
  product: "codex-cli",
  reviewPrefix: "X",
  clientNames: /codex/i,
  tested: [0, 163, 0],
  // 2026-10-23: relay 1.0.0 against 0.164.0, live (read, write, resume, Daybreak) and in the source it depends on.
  checked: [[0, 164, 0]],
  credentialEnv: /^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN)$/,
  endpointEnv: /^OPENAI_BASE_URL$/,
  // The app server sends approval requests to relay as JSON-RPC requests (`codex exec` sends none).
  approvals: { channel: "in-band" },
  // Withheld (nativeResumeWithheld): relay runs Codex with its own Codex home and its pinned binary
  // (codex-pin.ts), not ~/.codex and the codex on PATH, so this plain command finds no such thread.
  // A command with relay's CODEX_HOME would run Codex outside relay's confinement on relay's login,
  // and the thread is archived after each turn (relay unarchives it before its own resume); no such
  // native resume has been checked.
  resumeCommand: (sessionId) => `codex resume ${shellQuote(sessionId)}`,
  nativeResumeWithheld: "Relay shows no command to open a Codex session in your own codex. Relay ran it with its own Codex home (targets.codex.home, not ~/.codex) and its pinned Codex, and archives the thread after each turn, so `codex resume` with your own Codex does not find it; opened in relay's Codex home instead, it would run outside the confinement relay gave it, on relay's login and the settings relay writes there. Continue it with relay's resume, which unarchives the thread and keeps it confined.",
  capabilities: { subagents: "always", confinement: "verified", readOnly: true, networkOff: true, writeRoots: true, approvals: "native", escalation: true, resume: true, login: "account-verified", extensions: true },
  // Service tiers, by their ids in the model catalog (model/list serviceTiers; Codex 0.163.0).
  // Which the account has, for which model, is the catalog's to say: relay asks it before each turn.
  speeds: { fast: { id: "priority" }, ultrafast: { id: "ultrafast" } },
  qualified: true,
  text: { blockedHow: () => "request escalated permissions for that one command" },
};
