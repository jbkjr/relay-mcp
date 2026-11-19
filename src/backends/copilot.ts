// GitHub Copilot CLI over ACP: its profile for the generic driver (acp.ts). What this says about
// Copilot comes from its documentation and the 1.0.98 package (docs.github.com Copilot CLI
// reference, ACP server and configuration pages; the bundled CLI), checked in signed-in runs on
// 2026-10-17 (docs/qualification/copilot-1.0.98.md); what those runs could not settle is marked
// "unverified".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { harnessHome } from "../core/config.js";
import { acpBackend, genericApproval, type AcpProfile, type PreparedState, type ToolCallState } from "./acp.js";
import { targetLabel } from "../targets/index.js";
import type { ApprovalAsk, PathAccess, TurnSpec } from "./types.js";

/** Copilot's default ACP mode: ordinary prompting. Its modes are URLs. */
const COPILOT_AGENT_MODE = "https://agentclientprotocol.com/protocol/session-modes#agent";

/** Copilot's built-in subagents, which run models of their own choosing (explore, research, task; rubber-duck picks the other family on purpose). */
const SUBAGENTS = ["explore", "research", "task", "rubber-duck", "code-review", "general-purpose"];

/**
 * Tools that start or drive Copilot's subagents and background agents, which run models of their
 * own choosing: taken away from the model (--excluded-tools, which 1.0.98 applies over ACP). `task`
 * from its documentation; the rest are what a signed-in 1.0.98 session listed as its tools.
 */
export const SUBAGENT_TOOLS = ["task", "search_code_subagent", "run_dynamic_workflow", "dynamic_workflows_manage", "read_agent", "list_agents", "write_agent"];

/** The project directories of Claude Code's skills, agents and commands, which Copilot would otherwise load. */
const CLAUDE_DIRS = [".claude/skills", ".claude/agents", ".claude/commands"];

/** Where the user's own Copilot state is, from the worker's environment (relay replaces it in Copilot's). */
const userHome = () => process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");

/**
 * The Copilot home a session runs with: one per relay session, under relay's harness directory,
 * outside its control directory. It is relay's, and read-only to the agent; only two directories
 * in it are writable:
 *
 * - `session-state/`: Copilot's sessions, the one thing kept from turn to turn, since resuming
 *   needs it. Relay makes it, and refuses to run on it if it is anything but a plain directory (an
 *   agent could otherwise swap in a link that the next turn's sandbox would follow and open).
 * - `turn/`: logs and caches for this turn only (`logs` in the home links there), removed with it.
 *
 * Before every turn relay rebuilds the rest: its own settings file (Copilot's sandbox off, since it
 * would nest inside relay's; hooks off; skill, agent and command directories of Claude Code
 * ignored, by absolute path, since 1.0.98 ignores relative entries; subagents, which run other
 * models, off; no switch to automatic model choice) and a link named config.json to the user's
 * own, through which Copilot finds its stored login. Relay never opens that file (GitHub documents
 * that it can hold a token in plain text); the link only lets Copilot read it, as it could anyway,
 * and the sandbox keeps it unwritable. Nothing else of the user's Copilot configuration comes
 * along: no MCP servers, saved approvals or hooks.
 *
 * Seen in signed-in runs (1.0.98): Copilot reads every key of this settings file (`copilot config
 * --list` under this home shows each, with no problems), finds its keychain login through the
 * linked config.json (reading the item with /usr/bin/security), and tries to write two things in
 * the home outside the writable directories, both refused and neither needed: a new config.json
 * (to record the last logged-in user) and an `installed-plugins` directory. Without a stored login
 * it cannot start in this read-only home at all (it exits before ACP's initialize).
 *
 * The home is given to relay's sandbox as relay-owned persistent state (src/confine,
 * `HarnessState.persistent`): read-only but for `session-state/` and `turn/`, and checked again by the
 * sandbox layer before every turn, so a link in place of either stops the turn there too. HOME stays
 * the person's own (read-only): the keychain, where Copilot's login is, finds its search list
 * through HOME, so a temporary HOME would hide the login keychain.
 */
export function copilotState(spec: TurnSpec): PreparedState {
  const home = path.join(harnessHome(), spec.markers.runId, spec.markers.nodeId, "copilot");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const sessions = path.join(home, "session-state");
  const kept = fs.lstatSync(sessions, { throwIfNoEntry: false });
  if (kept && (kept.isSymbolicLink() || !kept.isDirectory())) {
    throw new Error(`${targetLabel(spec.target)}'s session state for this session (${sessions}) has been replaced by something other than a directory, which relay's sandbox would follow, so relay does not run it on that directory. Start a new job.`);
  }
  for (const name of fs.readdirSync(home)) if (name !== "session-state") fs.rmSync(path.join(home, name), { recursive: true, force: true });
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const turn = path.join(home, "turn");
  fs.mkdirSync(path.join(turn, "logs"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(turn, "cache"), { recursive: true });
  fs.symlinkSync(path.join(turn, "logs"), path.join(home, "logs"));
  // Absolute paths: 1.0.98 ignores relative entries (`copilot skill list` still listed a skill in
  // .claude/skills with them; it did not with the same directory named in full).
  const roots = [...new Set([path.resolve(spec.cwd), repoRoot(spec.cwd)].filter((d): d is string => d !== null))];
  const settings = {
    sandbox: { enabled: false },
    disableAllHooks: true,
    ignoredSkillsLocations: roots.flatMap((r) => CLAUDE_DIRS.map((d) => path.join(r, d))),
    subagents: { disabledSubagents: SUBAGENTS },
    continueOnAutoMode: false,
    autoUpdate: false,
  };
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings, null, 2), { mode: 0o600 });
  // A link, not a copy: relay does not read the user's Copilot config. Without one, Copilot reports that it is not signed in, and relay says so.
  const user = path.join(userHome(), "config.json");
  if (fs.lstatSync(user, { throwIfNoEntry: false })) fs.symlinkSync(user, path.join(home, "config.json"));
  return {
    stateDirs: [],
    persistent: { root: home, writable: ["session-state", "turn"] },
    home: "real",
    env: { COPILOT_HOME: home, COPILOT_CACHE_HOME: path.join(turn, "cache"), COPILOT_AUTO_UPDATE: "false" },
    // The stored login's token is in the keychain (service "copilot-cli"), which Copilot reads
    // through /usr/bin/security: a stated downgrade.
    keychain: true,
    // Copilot's Rust core checks certificates through the system (trustd); without the daemons it
    // cannot verify GitHub's (seen 2026-10-17: "failed to copy trust settings", then no login). A
    // stated downgrade: they fetch from URLs their caller supplies.
    certificateTrust: true,
    cleanup: () => fs.rmSync(turn, { recursive: true, force: true }),
  };
}

/** The repository root above a directory, or null. */
function repoRoot(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/**
 * The title of Copilot's own check of a path outside the directories it trusts, as 1.0.98 sends it
 * over ACP (session/request_permission). Seen in a signed-in run (2026-10-17, j_a7963b11) for an
 * `apply_patch` that added a file outside the worktree: announced first as a tool call of kind
 * "edit" (its raw input the patch), then this request under the same tool call id, of kind "read"
 * whatever the call would do, with the path in `rawInput.path` and in `locations`, offering
 * allow_once, allow_always and reject_once. `--allow-all-tools` covers Copilot's tools, not its
 * paths: GitHub documents the path check as separate, for shell commands, file operations and search
 * tools, turned off by `--allow-all-paths` (docs.github.com, configuring Copilot CLI and its command
 * reference, read 2026-10-21), which relay does not pass. So under relay's flags these are the
 * requests Copilot sends. Signed in on 2026-10-23 (the record's "Check 7 signed in"): its file viewer
 * and file finder send the same request (announced as "read"), and so does its grep (announced as
 * "other"); in those runs a call touching several paths asked once per path, in turn, not several
 * in one request, and shell commands sent none, whatever paths they named; once allowed, Copilot
 * went on and relay's sandbox decided; and once refused, Copilot ended its turn with no reply.
 */
export const PATH_CHECK_TITLE = "Access paths outside trusted directories";

/** The kinds of tool call that change files (ACP's edit, delete and move). */
const WRITES = new Set(["edit", "delete", "move"]);

/**
 * Whether a path check is for reading or writing, from the tool call it is about: its request says
 * "read" either way. Writing when the call announced, or the request, is a change; reading when the
 * call announced is a read (Copilot's file viewer and file finder); otherwise relay cannot tell (a
 * command, a search, or no call announced), which is taken as writing where that matters.
 */
function pathAccess(call: ToolCallState, announced: ToolCallState | undefined): PathAccess {
  if (WRITES.has(String(call.kind)) || WRITES.has(String(announced?.kind))) return "write";
  return announced?.kind === "read" ? "read" : "read or write";
}

/** The deepest directory holding every path (a path holds itself): one path is shown as it is. */
function commonDir(paths: string[]): string {
  let dir = paths[0];
  while (!paths.every((p) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep))) dir = path.dirname(dir);
  return dir;
}

/**
 * Copilot's check of a path outside its trusted directories, as an approval request of kind "path":
 * what it carries (the path, resolved against the agent's directory) and what relay can tell of the
 * access (pathAccess). The person sees the access and the path as `wants` ("write /x/y.txt"), the
 * path as `in_directory`, and an effect that says allowing it lets Copilot proceed while relay's
 * sandbox still decides what it can touch. Null, so refused unasked, when it names no path.
 */
export function copilotPathCheck(call: ToolCallState, spec: TurnSpec, announced?: ToolCallState): ApprovalAsk | null {
  const input = call.rawInput && typeof call.rawInput === "object" && !Array.isArray(call.rawInput) ? (call.rawInput as Record<string, unknown>) : {};
  const named = [input.path, ...(Array.isArray(input.paths) ? input.paths : []), ...(call.locations ?? []).map((l) => l?.path)];
  const paths = [...new Set(named.filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => path.resolve(spec.cwd, p)))];
  if (!paths.length) return null;
  const access = pathAccess(call, announced);
  const command = announced?.kind === "execute" && announced.rawInput && typeof announced.rawInput === "object" ? (announced.rawInput as { command?: unknown }).command : undefined;
  const title = typeof announced?.title === "string" && announced.title.trim() ? announced.title : undefined;
  const about = typeof command === "string" && command.trim() ? `its command: ${command}`
    : title ? `its tool call: ${title}${announced?.kind ? ` (${announced.kind})` : ""}`
    : "a tool call it did not describe";
  return {
    kind: "path",
    summary: `${access} ${paths.join(", ")}`,
    reason: `Copilot's own check of paths outside its trusted directories, for ${about}`,
    paths,
    // Whatever is approved, relay's sandbox stays on and unchanged: say so to whoever decides.
    detail: { cwd: commonDir(paths), path_access: access, tool_call: call.toolCallId, ...(announced?.kind ? { announced_kind: announced.kind } : {}), confined: true },
  };
}

export const copilotProfile: AcpProfile = {
  args: (spec, model) => [
    // stdio is the default transport; --stdio says so.
    "--acp", "--stdio",
    // Runs the version that was launched, not a newer one it downloaded earlier.
    "--no-auto-update",
    // Its own sandbox would nest inside relay's. Off by default; this flag is not applied on the
    // ACP path (1.0.98), so the settings file above turns it off too.
    "--no-sandbox",
    // The built-in GitHub MCP server would act with the user's GitHub token.
    "--disable-builtin-mcps",
    // Not applied on the ACP path either (1.0.98), so instructions files in the repository
    // (AGENTS.md, CLAUDE.md, .claude/rules) still load: they are the project's, as for Codex.
    "--no-custom-instructions",
    // Tools that start subagents, which run other models (the settings file disables the
    // subagents as well). Applied over ACP: Copilot says so in a notice ("Info: Disabled tools").
    `--excluded-tools=${SUBAGENT_TOOLS.join(",")}`,
    // Relay's sandbox is the boundary, and nothing approved lifts it (no escalation through relay's
    // sandbox in 1.0), so Copilot runs in its most permissive mode that persists nothing: allowed
    // for this process only, never saved. Its own check of paths outside its trusted directories
    // still asks (relay does not pass --allow-all-paths), and relay puts those requests to the root
    // (copilotPathCheck), its sandbox unchanged whatever is decided.
    "--allow-all-tools",
    // Applies to every session of this process; the session's reported model is checked against it.
    ...(model ? ["--model", model] : []),
    // Copilot's documented reasoning-effort flag. A process per turn, so a resumed session gets it
    // too. Unverified that the ACP server applies it (its own ACP option for this is thought_level).
    ...(spec.effort ? ["--reasoning-effort", spec.effort] : []),
  ],
  // Every Copilot variable is relay's to set (COPILOT_ALLOW_ALL=true, say, would trust the
  // directory and load its hooks and MCP servers). Its token is handled with the credentials.
  scrub: (k) => /^(COPILOT_|GITHUB_COPILOT_)/.test(k) && k !== "COPILOT_GITHUB_TOKEN",
  prepareState: copilotState,
  login: {
    // Copilot's ACP server offers "copilot-login", which succeeds only when already signed in
    // (changelog 1.0.69) and does not start a login. Unverified at runtime.
    reuse: ["copilot-login"],
    how: "Sign in with `copilot login`. Relay uses Copilot's stored login and removes COPILOT_GITHUB_TOKEN, GH_TOKEN and GITHUB_TOKEN from its environment, since they would silently take its place.",
  },
  mode: () => COPILOT_AGENT_MODE,
  normalizeApproval(call, spec, announced) {
    // Its own check of a path outside its trusted directories, under --allow-all-tools its only request.
    if (call.title === PATH_CHECK_TITLE) return copilotPathCheck(call, spec, announced);
    const ask = genericApproval(call);
    if (!ask) return null;
    // The directory the command would run in, as the agent gave it (relative to its own), else its own.
    const detail = (ask.detail ?? {}) as { cwd?: unknown };
    const cwd = path.resolve(spec.cwd, typeof detail.cwd === "string" ? detail.cwd : ".");
    const paths = ask.paths?.map((p) => path.resolve(cwd, p));
    // Whatever is approved, relay's sandbox stays on: say so to whoever decides.
    return { ...ask, ...(paths ? { paths } : {}), detail: { ...detail, cwd, confined: true } };
  },
  // Copilot says which tools --excluded-tools took away, as a message chunk of its own ahead of the
  // reply (1.0.98: "Info: Disabled tools: task"); it is not the agent's answer.
  notice: (text) => /^Info: Disabled tools: [\w, .-]+$/.test(text),
  refuse(spec) {
    // A repository can make Copilot fall back to another model than the one asked for.
    const root = repoRoot(spec.cwd);
    if ((spec.config.same_family === "refuse" || (spec.model && spec.model !== spec.target.autoModel)) && root && fs.existsSync(path.join(root, ".github", "allowed_models.txt"))) {
      return `the repository has .github/allowed_models.txt, which can make ${targetLabel(spec.target)} fall back to another model than the one relay asked for, so relay cannot tell which family would answer. It does not run it here.`;
    }
    return null;
  },
};

export const copilotBackend = acpBackend(copilotProfile);
