// What relay can tell about the program a root session's server runs in, from the server's own
// environment and the client's initialize request, and what that allows. Every answer here comes
// from host experiments (experiments/answers.md); a host relay has not positively identified gets
// the cautious answer.

import { spawnSync } from "node:child_process";
import { hostSession } from "../backends/env.js";
import { managedSettingsPaths, settingsArguments, settingsFiles, type Consent } from "../core/claude-settings.js";
import type { Instance } from "../core/caller.js";
import { launchMarker, launchedTree } from "../core/presence.js";
import { ancestorCommandLines, ancestorCommandLinesLater } from "../core/procs.js";
import { ROOM_REFUSALS, type RoomEligibility, type RoomIdentityEvidence } from "../core/room-types.js";
import { TARGETS, targetDef, type Target, type Vendor } from "../targets/index.js";

/**
 * What a root server's host profile reads about how it was started, asked of ps as the server
 * starts so that its processes run while the server's modules load: the command lines of the three
 * processes above it (core/procs.ts ancestorCommandLines), or null where ps could not give them, as
 * that answers. The server reads no message but initialize until it has them (server.ts
 * relayServer), so its first profile is built from them. Where the session's repository is, and so
 * which local settings Claude Code reads, is not among them: a .git file can be repointed between
 * the start and the profile, so git is asked when the profile is built.
 */
export interface StartEvidence {
  started: string[] | null;
}

/**
 * Starts reading the StartEvidence of a `relay mcp` with these arguments. Null for a launched
 * agent's server (--context, or relay's variables in its environment), which builds no host profile.
 */
export function startEvidence(argv: string[], env: NodeJS.ProcessEnv): Promise<StartEvidence> | null {
  if (argv.includes("--context") || ["RELAY_RUN_ID", "RELAY_NODE_ID", "RELAY_DEPTH", "RELAY_INJECTED"].some((k) => env[k] !== undefined)) return null;
  // A reading that fails is one that could not be made, as ancestorCommandLines throwing is to the profile.
  return ancestorCommandLinesLater(3).then((started) => ({ started }), () => ({ started: null }));
}

/** The client's name and version, as it gave them in initialize. */
export interface ClientInfo {
  name?: string;
  version?: string;
}
const multiModelClient = /^(opencode|cli|t3[- ]?code)$/i;
// Positive evidence only: the desktop chat's client name has not been observed.
// VS Code sends productService.nameLong (branded Visual Studio Code / - Insiders; OSS: Code - OSS):
// https://github.com/microsoft/vscode/blob/278880aeb30de8d2b16d0d1ee65e5f82a3d869fe/src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts#L135-L138
// https://github.com/microsoft/vscode/blob/9ab103a9f4bf101d1115f17f79119e763c8c6f07/product.json#L2-L3
// Branded wire logs: https://github.com/microsoft/vscode/issues/306918 (stable), /issues/311305 (Insiders).
// It imports desktop registrations: https://code.visualstudio.com/docs/agents/reference/mcp-configuration#automatic-discovery
// Continue's Client name is continue-client:
// https://github.com/continuedev/continue/blob/5ddd0d37a1c755c5cd8cd77fd18dc15dd520c81a/core/context/mcp/MCPConnection.ts#L88-L92
const multiModelRegistration = /^(opencode(?:[ -].*)?|grok(?:[ -].*)?|cursor(?:[ -].*)?|cline|roo[- ]?code|kilo[- ]?code|continue(?:-client)?|visual studio code(?: - insiders)?|code - oss|cli|t3[- ]?code)$/i;

export interface HostProfile {
  recognised: boolean;
  /**
   * Whether relay puts approval requests to the user through MCP elicitation.
   * "dialog": the host is positively known to show the question to a person.
   * "unknown": the host advertises elicitation, but relay does not know that anyone sees it.
   * "no": the host is known not to show it (it answers on its own, or there is nobody to see it), or cannot elicit at all.
   */
  elicit: "dialog" | "unknown" | "no";
  /** Whether a "decline" from the host is a person's denial. Otherwise it leaves the request undecided. */
  declineIsDenial: boolean;
  /**
   * A positively identified interactive Claude Code main session: a long tool call there moves to
   * the background after two minutes and its completion starts a turn, so status may wait for hours.
   */
  longWaits: boolean;
  /**
   * Whether the host asks the user before every call of a tool marked
   * anthropic/requiresUserInteraction, so that relay may offer confirm: interactive Claude Code
   * (a Yes/No permission prompt) and Claude Code in the Claude desktop app ("Deny / Allow once").
   */
  confirm: boolean;
  /** Why confirm is not offered to a Claude Code session that would otherwise get it, for relay doctor and logs. */
  confirmWithheld?: string;
  /**
   * Whether the approval form has a free-text note field. Codex's form could not be submitted with
   * an optional text field left empty (experiments/answers.md X-c), so Codex gets the decision only.
   */
  formNote: boolean;
  /**
   * Whether the host takes back a question relay withdraws (decided elsewhere first). Codex CLI
   * 0.162.1 does not: it keeps the form on screen, and its turn waits, until the person answers
   * it or presses Esc. Relay then keeps listening, so that a late answer is recorded and reported.
   */
  withdraws: boolean;
  /**
   * Whether the approval form's decision list should start with the safe choice (deny). Codex CLI
   * 0.162.1 preselects the first choice and Enter submits it at once, so a stray Enter (typed as a
   * queued form pops up) chose it unread. Any host not known to show the list otherwise gets deny
   * first; Claude Code keeps the order it was checked with.
   */
  safeFirst: boolean;
  /**
   * Whether the session can take notices on Claude Code's inbox socket (CLAUDE_CODE_MESSAGING_SOCKET):
   * only Claude Code itself, by its client name, from 2.1.286 (the version seen taking them). Any other process can find the variable in an
   * environment it inherited from a Claude Code session, and its notices would land in that session.
   */
  inbox: boolean;
  /** Which waiting pattern the tool texts teach: Claude Code's backgrounded long wait, Codex's parallel read-only calls, or plain waits. */
  waits: "background" | "parallel" | "plain";
  /**
   * The longest one call may wait, in seconds, whatever block_s says, or null for no such limit:
   * Below the host's tool timeout or unattended auto-background threshold.
   */
  waitCapS: number | null;
  /** Why, in a few words, for logs and tests. */
  why: string;
}

/** True when version a.b.c is at least min. Anything unparsable is not. */
export function atLeast(version: string | undefined, min: readonly [number, number, number]): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return false;
  const have = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (have[i] !== min[i]) return have[i] > min[i];
  return true;
}

/** The Claude Code version the host experiments ran: elicitation, idle and busy, shown as a dialog. */
const CLAUDE_DIALOG: readonly [number, number, number] = [2, 1, 286];
/** From this version a main-conversation MCP call is moved to the background after two minutes. */
const CLAUDE_BACKGROUND: readonly [number, number, number] = [2, 1, 212];
type Version = readonly [number, number, number];
interface DialogQualification {
  label: string;
  idleSince: Version | null;
  busySince: Version | null;
  withheld: string;
}

/**
 * Unsolicited dialogs, by detectable surface, not just vendor. Floors retain the existing policy
 * of qualifying later versions of the same surface. A relay call being in flight says nothing
 * about whether the host's turn is busy (it may be in a shell call), so relay cannot select an
 * idle-only path: both columns must qualify. ask_user cannot override this table.
 */
export const DIALOG_QUALIFICATIONS = {
  // experiments/answers.md C-a, C-g (busy), C-k (idle), rerun at 2.1.302.
  claudeCli: { label: "interactive Claude Code", idleSince: CLAUDE_DIALOG, busySince: CLAUDE_DIALOG, withheld: "interactive Claude Code version is below the idle and busy dialog qualification floor (2.1.286)" },
  // experiments/answers.md X-b (client), X-e (idle, 0.162.1), X-j (busy, 0.163.0).
  codexCli: { label: "Codex CLI", idleSince: [0, 162, 1], busySince: [0, 163, 0], withheld: "Codex CLI busy dialogs are not qualified before 0.163.0; relay cannot distinguish idle from busy" },
  // experiments/answers.md XA-a (0.162.0-alpha, MCP UI capability/client_type), XA-d
  // (idle), XA-f (busy UNRUN); docs/plan-1.0.md Outstanding table. Desktop originators
  // can only withhold: a custom originator is never evidence of the qualified CLI.
  codexApp: { label: "Codex app / desktop", idleSince: [0, 162, 0], busySince: null, withheld: "Codex app busy dialogs are not qualified (answers.md XA-f); relay cannot distinguish idle from busy" },
  // experiments/answers.md D-a, D-c, D-d: SDK/Code-tab dialogs decline automatically.
  claudeSdk: { label: "Claude Code SDK / desktop Code tab", idleSince: null, busySince: null, withheld: "Claude Code under the Agent SDK or the desktop app declines elicitations on its own" },
  // experiments/answers.md C-a and P-c: sdk-cli / -p cancels without showing a person.
  claudeUnattended: { label: "Claude Code unattended (-p)", idleSince: null, busySince: null, withheld: "Claude Code running unattended (-p)" },
  // experiments/answers.md D-a to D-d do not qualify the shared desktop bridge; the
  // plan's D C19 requires a conversation-bound, idle-and-busy path. None was observed.
  sharedDesktop: { label: "shared Claude desktop connection", idleSince: null, busySince: null, withheld: "shared desktop connection: dialogs and notices cannot be bound to a conversation" },
  // No idle/busy observations in experiments/answers.md for other clients or wrappers.
  unknown: { label: "unknown hosts / custom Codex originators", idleSince: null, busySince: null, withheld: "unrecognised host surface: idle and busy dialogs are not qualified" },
} as const satisfies Record<string, DialogQualification>;

function dialogQualification(surface: keyof typeof DIALOG_QUALIFICATIONS, version: string | undefined): { qualified: boolean; why: string } {
  const q: DialogQualification = DIALOG_QUALIFICATIONS[surface];
  const qualified = q.idleSince !== null && q.busySince !== null && atLeast(version, q.idleSince) && atLeast(version, q.busySince);
  return { qualified, why: qualified ? `${q.label}: approval dialogs qualified idle and busy` : q.withheld };
}

/**
 * The longest a call waits under the Claude desktop app's own entry (relay-desktop). The app ends a
 * tool call after 60 s (its MCP SDK's default; progress notifications do not reset it), then takes
 * the connection for dead and restarts relay for every session that shares it (Claude.app
 * 2.42304.0, 2026-10-16). Below that, so that a wait ends on relay's side first.
 */
export const DESKTOP_WAIT_S = 50;

/** Leave time to build and write the reply; scale the margin for short host timeouts. */
export const hostWaitCapS = (timeoutS: number): number => timeoutS - Math.min(10, timeoutS / 6);

const enabled = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value ?? "");

/**
 * In -p, backgrounded calls can die with the turn. Use the environment visible to this server.
 * https://code.claude.com/docs/en/env-vars (CLAUDE_AUTO_BACKGROUND_TASKS)
 * https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls
 * CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS defaults to 120000; 0 or
 * CLAUDE_CODE_DISABLE_BACKGROUND_TASKS disables backgrounding altogether.
 */
function unattendedWaitCapS(env: NodeJS.ProcessEnv): number | null {
  if (!unattendedClaude(env) || !enabled(env.CLAUDE_AUTO_BACKGROUND_TASKS) || enabled(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) return null;
  const raw = env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS?.replaceAll("_", "");
  const ms = raw?.trim() ? Number(raw) : 120000;
  if (ms === 0) return null;
  return hostWaitCapS((Number.isFinite(ms) && ms > 0 ? ms : 120000) / 1000);
}

/**
 * The client name the desktop app's connection for Cowork and the Code tab gives:
 * local-agent-mode-<entry name>. The connection for its chats was not seen.
 */
const DESKTOP_CLIENT = /^local-agent-mode-/i;


/**
 * Interactive Claude Code in a terminal: entry point "cli", no SDK or desktop markers, and not
 * running unattended (an interactive session leaves CLAUDE_CODE_SESSION_ATTENDED unset).
 */
export const interactiveClaudeCli = (env: NodeJS.ProcessEnv): boolean =>
  env.CLAUDE_CODE_ENTRYPOINT === "cli" && env.CLAUDE_CODE_SESSION_ATTENDED === undefined && !hostSession(env);

/**
 * Claude Code under `claude -p`: entry point "sdk-cli", or CLAUDE_CODE_SESSION_ATTENDED=0. Claude
 * Code 2.1.302 sets the first and leaves the variable unset, and cancels every elicitation within
 * milliseconds with nothing shown (experiments/answers.md C-a and P-c, 2026-10-17).
 */
const unattendedClaude = (env: NodeJS.ProcessEnv): boolean =>
  env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli" || env.CLAUDE_CODE_SESSION_ATTENDED === "0";

/** Claude Code in the Claude desktop app (its Code tab). */
const desktopApp = (env: NodeJS.ProcessEnv): boolean => Boolean(env.CLAUDE_CODE_DESKTOP_APP_VERSION);

/**
 * Whether one of these command lines starts Claude Code so that it can skip its permission
 * prompts: in bypassPermissions mode, or able to switch to it during the session. Relay's
 * questions were never seen answered by a person in that mode, so nothing there is read as one.
 */
export const canBypassPrompts = (commandLines: readonly string[]): boolean =>
  commandLines.some((line) => /(^|\s)--(allow-)?dangerously-skip-permissions(=\S*)?(\s|$)/.test(line) || /(^|\s)--permission-mode(=|\s+)bypassPermissions(\s|$)/.test(line));

/** Only per-conversation command-line overrides are evidence; global Codex config is not. */
const codexBypassesPrompts = (commandLines: readonly string[]): boolean => commandLines.some((line) =>
  /(^|\s)--dangerously-bypass-approvals-and-sandbox(\s|$)/.test(line)
  || /(^|\s)(--ask-for-approval|-a)(=|\s+)never(\s|$)/.test(line)
  || /(^|\s)(--sandbox|-s)(=|\s+)danger-full-access(\s|$)/.test(line)
  || /(^|\s)(--config|-c)(=|\s+)["']?(approval_policy\s*=\s*["']?never|sandbox_mode\s*=\s*["']?danger-full-access)["']*(\s|$)/.test(line));

/** Rooms need only positive bypass evidence, not qualification of confirm or dialog hooks. */
function roomBypassSettings(env: NodeJS.ProcessEnv, cwd: string, commandLines: readonly string[]): boolean {
  const sources = [...settingsFiles(env, cwd, managedSettingsPaths()).map((file) => ({ file })), ...settingsArguments(commandLines, cwd)];
  for (const src of sources) {
    // As in claude-settings.ts, extract only this key: settings env may contain credentials.
    const r = spawnSync("/usr/bin/plutil", ["-extract", "permissions.defaultMode", "raw", "-expect", "string", "-o", "-", "file" in src ? src.file : "-"], {
      input: "inline" in src ? src.inline : undefined, encoding: "utf8", timeout: 5000,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
    });
    if (r.status === 0 && r.stdout.replace(/\n$/, "") === "bypassPermissions") return true;
  }
  return false;
}

/**
 * Terminal enrollment is the opt-in, not evidence of attendance. Re-read host evidence on every
 * action; inst.host is a cached approval profile and cannot establish the current permission mode.
 * Unknown permission fields/settings do not manufacture either safe values or bypass evidence.
 */
/**
 * Codex turn metadata client_type values that mark the ChatGPT desktop app rather than the Codex CLI:
 * its Codex side sends desktop_app, and its Work mode macos_app (ChatGPT 26.1117, seen 2026-11-20).
 * Either admits a room join, and either makes the connection an app for dialogs (never open).
 */
export const CODEX_APP_CLIENT_TYPES: ReadonlySet<string> = new Set(["desktop_app", "macos_app"]);

export function roomEligibility(inst: Instance, evidence: RoomIdentityEvidence): RoomEligibility {
  const no = (): RoomEligibility => Object.freeze({ eligible: false, refused: true, reason: ROOM_REFUSALS.ineligible });
  const yes = (): RoomEligibility => Object.freeze({ eligible: true });
  const env = process.env;
  const name = evidence.harness ?? "";
  if (inst.ctx.kind !== "root" || evidence.codex.malformed || evidence.subagent || inst.singletonViolation || evidence.singleton_violation || inst.registration
    || inst.keyed || inst.hostKey || multiModelRegistration.test(name) || launchMarker(env)) return no();
  if (unattendedClaude(env) || (hostSession(env) && !desktopApp(env))) return no();
  if ((env.CLAUDE_CODE_CHILD_SESSION && env.CLAUDE_CODE_CHILD_SESSION !== "0")
    || (env.CLAUDE_CODE_HOST_SESSION_ID && env.CLAUDE_CODE_SESSION_ID && env.CLAUDE_CODE_HOST_SESSION_ID !== env.CLAUDE_CODE_SESSION_ID)) return no();
  // Preserve the launch-tree guard's fail-closed behavior when process/registry evidence is unreadable.
  try { if (launchedTree(env)) return no(); } catch { return no(); }

  if (/^codex-mcp-client$/i.test(name)) {
    if (evidence.scope !== "dedicated-process" || inst.carried || inst.desktopEntry) return no();
    const c = evidence.codex;
    if (!c.metadata_present || !c.thread_id || c.thread_source !== "user" || c.turn_trigger === "exec") return no();
    // Codex sends no originator in ordinary turns. An absent override is the CLI; the app
    // identifies itself with client_type or the same desktop originator markers as profileOf.
    for (const originator of [c.originator, env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE]) {
      if (originator && originator !== "codex_cli_rs" && !CODEX_APP_CLIENT_TYPES.has(originator)
        && !/desktop|chatgpt|codex[ _-]?app/i.test(originator)) return no();
      if (/t3[- ]?code/i.test(originator ?? "")) return no();
    }
    const lines = ancestorCommandLines(3);
    if (lines && codexBypassesPrompts(lines)) return no();
    if (c.sandbox === "danger-full-access" || c.approval_policy === "never") return no();
    return yes();
  }

  const shared = inst.desktopEntry || DESKTOP_CLIENT.test(name);
  if (shared) {
    if (evidence.scope !== "conversation-token" || !inst.carried || !registrationAgrees("claude", name, true)) return no();
  } else if (evidence.scope !== "dedicated-process" || !/^claude-code$/i.test(name) || (!interactiveClaudeCli(env) && !desktopApp(env))) return no();
  const lines = ancestorCommandLines(3);
  if (lines && canBypassPrompts(lines)) return no();
  if (roomBypassSettings(env, inst.cwd, lines ?? [])) return no();
  return yes();
}

/**
 * Revision 3 (docs/design-rooms.md): whether a conversation on this host may ask the person to open
 * a room through the host's own prompt, which relay must know reaches the person. Only the two
 * surfaces whose approval dialog is qualified idle and busy, as a person's answer, qualify:
 * interactive Claude Code in a terminal and the Codex CLI (DIALOG_QUALIFICATIONS, experiments/
 * answers.md C-a/C-g/C-k and X-b/X-e/X-g/X-j). The profile must already put relay's questions to
 * the person (elicit "dialog": no bypass mode, no Elicitation hook or bypass default mode, not
 * unattended, SDK, desktop, T3 or an unknown originator), and ask_user must not be "never". The
 * shared desktop entry and the desktop app's own connection never qualify: their dialogs are off.
 * Codex's app (ChatGPT desktop) is withheld with its busy dialogs (XA-f unrun). Per-call evidence
 * (roomEligibility, fresh settings) is checked again by the caller on every open.
 */
export function roomOpenDialog(
  profile: HostProfile, client: ClientInfo | undefined, env: NodeJS.ProcessEnv, opts: { desktopEntry?: boolean; askUser?: string } = {},
): { qualified: true; surface: "claudeCli" | "codexCli"; keepsForm: boolean; why: string } | { qualified: false; why: string } {
  const name = client?.name ?? "";
  if (opts.desktopEntry || DESKTOP_CLIENT.test(name)) return { qualified: false, why: DIALOG_QUALIFICATIONS.sharedDesktop.withheld };
  if (opts.askUser === "never") return { qualified: false, why: 'ask_user is "never"' };
  if (profile.elicit !== "dialog") return { qualified: false, why: profile.why };
  if (/^claude-code$/i.test(name) && interactiveClaudeCli(env) && !unattendedClaude(env) && !desktopApp(env)) {
    return { qualified: true, surface: "claudeCli", keepsForm: !profile.withdraws, why: DIALOG_QUALIFICATIONS.claudeCli.label };
  }
  const originator = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  if (/^codex-mcp-client$/i.test(name) && (!originator || originator === "codex_cli_rs")) {
    return { qualified: true, surface: "codexCli", keepsForm: !profile.withdraws, why: DIALOG_QUALIFICATIONS.codexCli.label };
  }
  return { qualified: false, why: DIALOG_QUALIFICATIONS.unknown.withheld };
}

/**
 * What relay can tell about the host. `hostCommandLines` are the command lines of the processes
 * that started this server (its parent first), read only for the flags in canBypassPrompts; null
 * where relay could not inspect them, which for Claude Code withholds the dialog and confirm.
 * `settings` says why Claude Code's settings may answer for the person, for the dialog and for
 * confirm separately (src/core/claude-settings.ts): a bypassPermissions default mode stands in the
 * way of both; Elicitation hooks that match relay, of the dialog; PreToolUse or PermissionRequest
 * hooks that match relay's confirm tool, of confirm. A string stands in the way of both.
 * `desktopEntry` says the server was started from the Claude desktop app's own entry (--desktop);
 * there, and for a client named as the app's connection, waits end after DESKTOP_WAIT_S.
 */
export function hostProfile(
  env: NodeJS.ProcessEnv, client: ClientInfo | undefined, canElicit: boolean, hostCommandLines: readonly string[] | null = [], settings: Consent | string | null = null,
  opts: { desktopEntry?: boolean; inbox?: boolean; codexDesktop?: boolean } = {},
): HostProfile {
  const raw = profileOf(env, client, canElicit, hostCommandLines, settings, opts.codexDesktop);
  // Profiles decide their own default; an explicit marker can qualify or disable inbox delivery
  // for a particular deployment (including an SDK host) without copying another host's profile.
  const inbox = opts.inbox ?? (env.RELAY_HOST_INBOX === "off" ? false : env.RELAY_HOST_INBOX === "on" ? true : raw.inbox);
  const p = { ...raw, inbox };
  const detectedT3 = /^codex-mcp-client$/i.test(client?.name ?? "") && /t3[- ]?code/i.test(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "");
  const attributed: HostProfile = detectedT3 ? { ...p, inbox: opts.inbox ?? (env.RELAY_HOST_INBOX === "on"), elicit: "no", why: "T3 Code: elicitation answers cannot be attributed to a person" } : p;
  if (!opts.desktopEntry && !DESKTOP_CLIENT.test(client?.name ?? "")) return attributed;
  return { ...attributed, confirm: false, inbox: false, elicit: "no", why: DIALOG_QUALIFICATIONS.sharedDesktop.withheld, waitCapS: DESKTOP_WAIT_S, longWaits: false, waits: attributed.waits === "background" ? "plain" : attributed.waits };
}

function profileOf(env: NodeJS.ProcessEnv, client: ClientInfo | undefined, canElicit: boolean, hostCommandLines: readonly string[] | null, settings: Consent | string | null, codexDesktop = false): HostProfile {
  const name = client?.name ?? "";
  const base = { recognised: false, elicit: "no", declineIsDenial: false, longWaits: false, confirm: false, formNote: true, withdraws: true, safeFirst: true, inbox: false, waits: "plain", waitCapS: null } as const;
  // These frontends allow automation or attached clients to answer; even always cannot
  // attribute their answers to a person. T3 detection stays in the host profile.
  if (multiModelClient.test(name)) {
    return { ...base, why: `${name || "T3 Code"}: elicitation answers cannot be attributed to a person` };
  }
  if (/^claude-code$/i.test(name)) {
    const flag = hostCommandLines === null ? "relay could not inspect how Claude Code was started (ps), so it cannot tell whether it can skip permission prompts"
      : canBypassPrompts(hostCommandLines) ? "Claude Code started so that it can skip permission prompts (bypassPermissions)" : null;
    const consent = typeof settings === "string" ? { dialog: settings, confirm: settings } : settings;
    const noDialog = flag ?? consent?.dialog ?? null;
    const noConfirm = flag ?? consent?.confirm ?? null;
    const cli = interactiveClaudeCli(env);
    const qualified = atLeast(client?.version, CLAUDE_DIALOG);
    const longWaits = cli && atLeast(client?.version, CLAUDE_BACKGROUND);
    // Seen prompting for a marked tool: interactive Claude Code 2.1.286, and the desktop app 2.1.299.
    // Where the mode or a hook could let confirm through without the person, it is not offered.
    const offered = qualified && (cli || desktopApp(env));
    // Notices on its inbox socket were seen taken from 2.1.286 on (2.1.286, 2.1.299 in the desktop
    // app, 2.1.302); before that, events come with the next result. The socket is documented from
    // 2.1.224 (code.claude.com/docs/en/cross-session-messaging), but relay posts only where seen.
    const claude = {
      ...base, recognised: true, safeFirst: false, inbox: qualified && (env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop" || desktopApp(env) || !hostSession(env)), longWaits, waits: longWaits ? "background" : "plain", confirm: offered && !noConfirm,
      waitCapS: unattendedWaitCapS(env),
      ...(offered && noConfirm ? { confirmWithheld: noConfirm } : {}),
    } as const;
    // Its question dialog can be answered by the mode or by a hook, not by a person: an answer
    // there, accept or decline, would decide nothing that is the person's. So no question is put
    // to the user, whatever ask_user says; requests go to the root agent and the terminal.
    if (noDialog) return { ...claude, why: noDialog };
    // Claude Code under the Agent SDK (the Claude desktop app's Code tab among them) advertises
    // elicitation but declines every request on its own within milliseconds, with nothing shown, and
    // does not move long calls to the background.
    if (hostSession(env)) return { ...claude, why: DIALOG_QUALIFICATIONS.claudeSdk.withheld };
    if (unattendedClaude(env)) return { ...claude, why: DIALOG_QUALIFICATIONS.claudeUnattended.withheld };
    if (!canElicit) return { ...claude, why: "host lacks elicitation" };
    // Its dialog has Accept and Decline buttons, and nothing declines on the user's behalf.
    const dialogs = dialogQualification("claudeCli", client?.version);
    if (cli && dialogs.qualified) return { ...claude, elicit: "dialog", declineIsDenial: true, why: dialogs.why };
    return { ...claude, why: cli ? dialogs.why : "Claude Code, not positively identified as interactive; idle and busy dialogs are not qualified" };
  }
  if (/^codex-mcp-client$/i.test(name)) {
    // Its form: no note field, and a withdrawn form stays on screen (see HostProfile).
    const codex = { ...base, recognised: true, waits: "parallel", formNote: false, withdraws: false } as const;
    if (!canElicit) return { ...codex, why: "host lacks elicitation" };
    const originator = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    // XA-a's bundled version is distinct from X-b's CLI. Also recognise desktop evidence
    // at newer versions: MCP UI capability, call metadata, or a forwarded desktop originator.
    const app = codexDesktop || /^0\.162\.0(?:-|$)/.test(client?.version ?? "") || /desktop|chatgpt|codex[ _-]?app/i.test(originator ?? "");
    const surface = app ? "codexApp" : originator && originator !== "codex_cli_rs" ? "unknown" : "codexCli";
    const dialogs = dialogQualification(surface, client?.version);
    // The CLI's decline can be automatic under approval policy never, so it stays unattributed.
    return { ...codex, elicit: dialogs.qualified ? "dialog" : "no", why: dialogs.why };
  }
  if (!canElicit) return { ...base, why: "host lacks elicitation" };
  return { ...base, why: `an unrecognised host (${name || "no client name"}); idle and busy dialogs are not qualified` };
}

/** A copied single-family registration is not evidence about a different harness. */
export function registrationAgrees(host: Target, clientName: string, desktop = false): boolean {
  if (multiModelClient.test(clientName)) return false;
  if (desktop) {
    const mine = targetDef(host).vendor;
    // Keep unknown desktop names compatible, but never let a copied entry overrule a client
    // relay already attributes to another family. Use every registered single-family matcher.
    const other = TARGETS.some((t) => t.vendor && t.vendor !== mine && t.clientNames.test(clientName));
    return !other && !/^gemini-cli-mcp-client$/i.test(clientName) && !multiModelRegistration.test(clientName);
  }
  if (!clientName) return true;
  return host === "claude" ? /^(claude-code|local-agent-mode-.*)$/i.test(clientName)
    : host === "codex" ? /^codex-mcp-client$/i.test(clientName) : false;
}

/** Evidence only lowers labels; it must never change routing. */
export function hostFamilyDoubt(env: NodeJS.ProcessEnv, family: Vendor | Target | null): string | null {
  if (family === "claude") family = "anthropic";
  if (family === "codex") family = "openai";
  if (family === "anthropic") {
    for (const [key, value] of Object.entries(env)) if (value !== undefined && targetDef("claude").endpointEnv.test(key)) {
      if (key !== "ANTHROPIC_BASE_URL") return key;
      try { if (new URL(value).hostname !== "api.anthropic.com") return key; }
      catch { return key; }
    }
    for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) {
      if (env[key] && !targetDef("claude").ownModels!.test(env[key]!)) return key;
    }
  }
  return family === "openai" && env.OPENAI_BASE_URL !== undefined ? "OPENAI_BASE_URL" : null;
}
