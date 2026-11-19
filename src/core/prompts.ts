import { preamble, turnSubagents } from "./steering.js";
import type { NodeRow } from "./db.js";
import { sessionParams } from "./params.js";
import { extensionsLine, type SessionExtensions } from "./extensions.js";
import { networkOn, type Mode, type RelayConfig, type Target } from "./config.js";
import { inSideOrder, sideName, sidePrefix, targetDef, targetLabel, targetEnabled, TARGETS, vendorFor } from "../targets/index.js";
import { relayToolName } from "../backends/tool-discovery.js";

/**
 * Text on one line, cut to `max`, for a prompt: model input, not a person's screen, so nothing is
 * escaped (unlike shown.ts oneLine, which is for what a person sees).
 */
const flat = (s: string, max = 200) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export const DELEGATION_NORM =
  "Delegate only well-defined chunks that are meaningfully smaller than your assignment, and do real work yourself. " +
  "Never forward your whole assignment, and never hand work back to an ancestor. Handle small tasks directly.";

/**
 * What the relay tools are for, said to a launched agent of `target` that has them. `model`: the
 * model its session runs, which is its family on a harness of several families' models.
 */
export function crossFamily(target: Target, cfg: RelayConfig, model?: string | null, access: Mode = "write"): string {
  return preamble(target, cfg, model, turnSubagents(target, access));
}

export const REPORT_FIELDS = ["Summary", "Files changed", "Branch", "Tests run", "Open issues"] as const;

/**
 * Where in the repository the person was working, for a write job: its agent always starts at the
 * worktree root (a subdirectory path could be redirected), so the position is said instead.
 */
function subdirLine(node: NodeRow): string {
  const subdir = sessionParams(node).subdir;
  return typeof subdir === "string" && subdir ? ` The person was working in ${subdir}/ of this repository; your working directory is the worktree's root.` : "";
}

/**
 * Whether an agent of `target` can be given relay's tools at all (a harness that drops relay's bridge
 * cannot: Copilot). A harness that takes them through its own tool discovery (Gemini) is offered them
 * on every version; where discovery did not run, its turn's prompt is corrected at launch
 * (PreparedState.beforePrompt), so the preamble needs no reading of the version here.
 */
const hasRelayTools = (target: Target | null): boolean => !target || targetDef(target).capabilities.relayTools !== false;
const NO_RELAY_TOOLS = "Relay's tools are not available to you in this harness, so you cannot delegate; do the work yourself.";
/**
 * For a harness that names relay's tools with a prefix of its own (Gemini's discovered tools), what
 * they are called there, since relay's texts and its tools' descriptions name them without it.
 */
function toolNames(target: Target): string {
  const prefix = targetDef(target).toolDiscovery?.prefix;
  if (!prefix) return "";
  const named = ["delegate", "status", "result", "merge"].map((t) => relayToolName(target, t)).join(", ");
  return ` In this harness each relay tool's name starts with ${prefix} (${named}, and so on): where relay's texts name a tool without it, call it with it.`;
}

export function delegationPreamble(
  node: NodeRow, cfg: RelayConfig, rootTask: string, parentTask: string, scope: string[] | undefined,
  grant?: { network?: boolean; local_network?: boolean; raw_network?: boolean; write_paths?: string[] },
  canAsk = false,
  extensions?: SessionExtensions,
): string {
  const tools = hasRelayTools(node.target);
  const canDelegate = tools && node.allow_delegation === 1 && node.depth < cfg.max_depth;
  const lines = [
    `[relay] You are a delegated agent, started by another agent through relay. Depth ${node.depth} of max ${cfg.max_depth}.`,
    `Root task: ${flat(rootTask)}`,
    `Parent task: ${flat(parentTask)}`,
    `Your scope: ${scope?.length ? scope.join(", ") : "not restricted"}.`,
    node.mode === "write"
      ? `Mode: write. You are in your own git worktree on branch ${node.branch}; your writes are limited to it.${subdirLine(node)}`
      : "Mode: read. Your session is read-only; do not try to modify files.",
    canDelegate
      ? `You may delegate further using the relay tools.${toolNames(node.target!)} ${crossFamily(node.target!, cfg, node.model, node.mode as Mode)}`
      : node.allow_delegation === 1
        ? (tools ? "You are at the maximum depth, so you cannot delegate; do the work yourself." : NO_RELAY_TOOLS)
        : "You may not delegate; do the work yourself.",
    DELEGATION_NORM,
    "If you use your own subagents, wait for every one to finish before your final answer, because relay stops any still running when your turn ends.",
  ];
  if (canDelegate) {
    lines.push(
      "Jobs you start keep running after your turn ends, but nobody else will collect them. Wait for them" +
        (node.mode === "write" ? ", and integrate their branches with the relay merge tool, before you report." : " before you report."),
    );
  }
  if (node.mode === "write") {
    lines.push(
      cfg.child_git === "native"
        ? "Commit your work on your branch before you report."
        : "Relay commits your work when your turn ends, so you do not need to run git commit (the sandbox may block it).",
    );
  }
  // Relay stops what it can still trace to the agent when the turn ends, which is not everything.
  lines.push("Stop any process you start (servers, watchers, anything in the background) before you report. Nothing else is certain to stop it once your turn is over.");
  const network = networkOn(cfg, grant);
  const extras = [
    network ? "network and web access" : "",
    network && node.mode === "write" && grant?.local_network ? "this Mac's loopback and the local network from your shell, once the user consents" : "",
    ...(node.mode === "write" ? (grant?.write_paths ?? []) : []).map((p) => `write access to ${p}`),
  ].filter(Boolean);
  if (extras.length) lines.push(`Granted beyond your sandbox: ${extras.join("; ")}.`);
  if (extensions) lines.push(extensionsLine(node.target!, extensions));
  // A job always has a target.
  lines.push(blockedAdvice(node.target!, node.mode, canAsk, network, webWithheld(cfg)));
  lines.push(
    "End your final message with this report, with every field filled in (write \"none\" where nothing applies):",
    "## RELAY REPORT",
    ...REPORT_FIELDS.map((f) => `${f}: …`),
    "",
    "Your assignment:",
    "",
  );
  return lines.join("\n");
}

/**
 * Whether the run's captured never.hosts withholds the host's own web tools (backends/claude.ts
 * applyClaudeNeverPolicy denies Claude's WebSearch and WebFetch whenever its floor lists a host). A
 * run's floor only adds to the captured config, so a host listed there is always in it: true means
 * denied. False does not mean allowed: the durable floor can gain a host after capture (a later
 * checkpoint, core/never-checkpoint.ts), and copied user deny rules can deny the tools too. This
 * reads no checkpoint; instead Claude's web wording (targets/claude.ts WEB_TOOLS) is conditional on
 * permission policy, so it never promises an approval prompt and says to finish and report after a
 * policy denial.
 */
const webWithheld = (cfg: RelayConfig): boolean => (cfg.never?.hosts?.length ?? 0) > 0;

/**
 * What an agent should do when its sandbox stops it, worded for how that agent asks. `webDenied`:
 * never.hosts withholds the host's own web tools (Claude's; see TargetDef.text.blockedAsks).
 */
export function blockedAdvice(target: Target, mode: Mode, canAsk: boolean, network: boolean, webDenied = false): string {
  const blocked = mode === "write"
    ? (network ? "a path outside your worktree" : "the network, or a path outside your worktree")
    : (network ? "a command the read-only sandbox blocks" : "web access, or a command the read-only sandbox blocks");
  const text = targetDef(target).text;
  const shell = !network && text.shellNetwork ? ` ${text.shellNetwork(canAsk && !webDenied)}` : "";
  // What this turn can actually ask for; null: nothing, so it is told to finish and report.
  const asks = text.blockedAsks ? text.blockedAsks(mode, { network, webDenied }) : blocked;
  // Nothing approved takes an agent out of relay's own sandbox, so it is not told it can ask.
  if (!canAsk || !targetDef(target).capabilities.escalation || asks === null) {
    return `If you need something your sandbox blocks (${blocked}), do not work around it. Finish what you can and say exactly what you needed${mode === "write" ? " under Open issues" : ""}, so it can be granted.${shell}`;
  }
  return (
    `If you genuinely need something your sandbox blocks (${asks}), you may ask for approval: ${text.blockedHow(mode)}. ` +
    "The request goes to the user and may take a while. If it is denied, do not work around it; finish what you can and say what you needed." +
    (mode === "read" ? " You cannot ask to change files; this session stays read-only." : "") + shell
  );
}

export interface Report {
  summary: string | null;
  files_changed: string | null;
  branch: string | null;
  tests_run: string | null;
  open_issues: string | null;
  report_parsed: boolean;
}

/** Tolerant parser for the final report. Missing fields are null; the raw message is always kept elsewhere. */
export function parseReport(message: string): Report {
  const idx = message.toUpperCase().lastIndexOf("RELAY REPORT");
  const body = idx >= 0 ? message.slice(idx) : message;
  const labels = REPORT_FIELDS.map((f) => f.replace(" ", "\\s+")).join("|");
  const field = (name: string): string | null => {
    const re = new RegExp(`^[\\s>*_#-]*${name.replace(" ", "\\s+")}[*_]*\\s*:[*_]*\\s*([\\s\\S]*?)(?=^[\\s>*_#-]*(?:${labels})[*_]*\\s*:|(?![\\s\\S]))`, "im");
    const m = re.exec(body);
    const value = m?.[1]?.trim();
    return value ? value : null;
  };
  const out = {
    summary: field("Summary"),
    files_changed: field("Files changed"),
    branch: field("Branch"),
    tests_run: field("Tests run"),
    open_issues: field("Open issues"),
  };
  return { ...out, report_parsed: idx >= 0 && Object.values(out).every((v) => v !== null) };
}

export function consultHeader(caller: string, target: Target, mayDelegate: boolean, opts: { canAsk: boolean; network: boolean; cfg: RelayConfig; model?: string | null; extensions?: SessionExtensions }): string {
  return [
    `[relay] Another agent (${caller}) is consulting you mid-task and is waiting for your answer.`,
    "Your session is read-only.",
    mayDelegate && hasRelayTools(target) ? `You may use the relay tools to delegate.${toolNames(target)} ${crossFamily(target, opts.cfg, opts.model, "read")}` : "You may not delegate; answer from your own work.",
    ...(opts.network ? ["You have network and web access."] : []),
    ...(opts.extensions ? [extensionsLine(target, opts.extensions)] : []),
    blockedAdvice(target, "read", opts.canAsk, opts.network, webWithheld(opts.cfg)),
    "Follow-up questions will arrive in this same session.",
    "",
  ].join("\n");
}

export function contextBlock(paths: string[] | undefined): string {
  return paths?.length ? `Context files to read first:\n${paths.map((p) => `- ${p}`).join("\n")}\n\n` : "";
}

// Discussions

export const HUMAN_LABEL = "[Message from the human user, not from the other participant]";

export const ROLE_PRESETS: Record<string, string> = {
  proposer: "You are the proposer. Put forward a concrete position on the topic and defend or revise it on the merits.",
  critic: "You are the critic. Test the other side's position against the evidence, and say what you would do instead where you disagree.",
  peer:
    "You are a peer. Defend or revise your own points on the merits, evaluate the other side's points, merge duplicates, " +
    "and drop anything you are persuaded is wrong (say what persuaded you).",
};

export const DISCUSSION_RULES = [
  "Rules for this discussion:",
  "- Argue from evidence: files, lines, test output, docs.",
  "- Do not concede unless an argument actually persuades you, and say what did.",
  "- End every turn with exactly one of these, on its own line as the last thing you write:",
  "    CONTINUE",
  "    AGREE: <conclusion>",
  "    CRUX: <the specific remaining disagreement>",
  "- Reply AGREE only if you accept the other side's conclusion as they stated it. If yours differs in substance, use CONTINUE and say how.",
].join("\n");

export function discussionOpening(opts: {
  topic: string; context?: string[]; role: string; other: string; resumed: boolean; extraRules?: string; mayDelegate: boolean;
  /** The participant's target, its model, and the config it runs under. */
  target: Target; model?: string | null; cfg: RelayConfig;
}): string {
  return [
    opts.resumed
      ? "[relay] This is a new phase of your existing session: a discussion with another agent. Keep everything you already know from this session."
      : "[relay] You are taking part in a discussion with another agent.",
    `The other participant is ${opts.other}, working in its own session. Relay passes each of you the other's messages verbatim and keeps the record.`,
    `Your session is read-only for this discussion.${opts.mayDelegate && hasRelayTools(opts.target) ? ` You may use the relay tools to delegate.${toolNames(opts.target)} ${crossFamily(opts.target, opts.cfg, opts.model, "read")}` : " You may not delegate."}`,
    "",
    `Topic: ${opts.topic}`,
    "",
    contextBlock(opts.context).trimEnd(),
    `Your role: ${opts.role}`,
    "",
    DISCUSSION_RULES,
    opts.extraRules ?? "",
    "",
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/** A turn's final marker. `inline`: read from the end of the last line rather than from a line of its own. */
export type Marker = { kind: "CONTINUE"; inline?: true } | { kind: "AGREE"; text: string; inline?: true } | { kind: "CRUX"; text: string; inline?: true } | { kind: "NONE" };

/**
 * Finds the turn's final marker: the last line that begins with CONTINUE, AGREE: or CRUX:. Failing
 * that, a marker at the end of the last line, after the end of a sentence ("Looks right. AGREE:
 * use X"), but only when it is unambiguous: the last line is not quoted, no quotation mark comes
 * before the marker on that line, that AGREE: or CRUX: is the only one anywhere in the message,
 * and its conclusion is one sentence naming no other marker (a CONTINUE must end the line). When
 * in doubt there is no marker, and the caller is told so (marker_note).
 */
export function parseMarker(message: string): Marker {
  const lines = message.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    // Quoted (">") and bulleted ("-") lines are not stripped: a copy of the other side's closing
    // line inside a quote must not count as this turn's marker.
    const line = lines[i].replace(/^[\s*_`#]+/, "");
    const m = /^(AGREE|CRUX)\s*[*_]*\s*:[*_]*\s*(.*)$/s.exec(line);
    if (m) {
      const text = [m[2], ...lines.slice(i + 1)].join("\n").trim();
      return { kind: m[1] as "AGREE" | "CRUX", text };
    }
    if (/^CONTINUE\b/.test(line)) return { kind: "CONTINUE" };
  }
  const last = lines.map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (last.startsWith(">")) return { kind: "NONE" };
  const inline = /(?:^|[.!?)\]]\s+)[*_]*(AGREE|CRUX)[*_]*:[*_]*\s*(\S.*)$/.exec(last);
  if (inline) {
    const text = inline[2].trim();
    const alone = (message.match(/\b(?:AGREE|CRUX)[*_]*\s*:/g) ?? []).length === 1;
    // More after the conclusion's first sentence, or another marker in it, could be what the
    // marker was meant to be followed by, or a quotation of the other side going on.
    const more = /[.!?]["'”’)\]]*\s+\S/.test(text) || /\b(?:CONTINUE|AGREE|CRUX)\b/.test(text);
    if (alone && !more && !quotedBefore(last.slice(0, inline.index + inline[0].length - inline[2].length))) {
      return { kind: inline[1] as "AGREE" | "CRUX", text, inline: true };
    }
    return { kind: "NONE" };
  }
  const cont = /(?:^|[.!?)\]]\s+)[*_]*CONTINUE[*_]*\.?$/.exec(last);
  if (cont && !quotedBefore(last.slice(0, cont.index + 1))) return { kind: "CONTINUE", inline: true };
  return { kind: "NONE" };
}

/**
 * Whether a line, up to a marker found inside it, has a quotation mark: " “ ” or a backtick, or an
 * apostrophe (' or ’) that is not inside a word ("don't" is no quotation; "'stop" is).
 */
function quotedBefore(text: string): boolean {
  return /["“”`]/.test(text) || /(?<![\p{L}\p{N}])['’]|['’](?![\p{L}\p{N}])/u.test(text);
}

// Reviews

/** What a review looks at: code (a path, a diff range, a branch), or a plan for work not yet done, in a file or given as text. */
export type ReviewSubject = { kind: "code"; target: string } | { kind: "plan"; path: string } | { kind: "plan"; text: string };

export const PASS_RULE = "A pass over coverage that is not declared complete is recorded as unknown.";

/** The JSON block every review ends with, by example. */
export const reviewJsonShape = (kind: "code" | "plan"): string =>
  JSON.stringify({
    verdict: "fail",
    coverage: kind === "plan" ? { complete: false, examined: ["steps 1-4", "src/a.ts"], not_examined: ["step 5"] } : { complete: false, examined: ["src/a.ts"], not_examined: ["the tests"] },
    items: [{ n: 1, severity: "major", confidence: "high", file: kind === "plan" ? "src/a.ts" : "path/file.ts", lines: [42, 47], location: kind === "plan" ? "step 2" : "fetchUser", summary: "…", evidence: "…", fix: "…" }],
  });

/** How every review is written, by either side: its items, its verdict and what it covers, ending in one JSON block. */
export function reviewFormat(kind: "code" | "plan"): string[] {
  const plan = kind === "plan";
  return [
    "Give numbered feedback items. Each item has:",
    "- severity: blocker, major, minor, or nit",
    "- confidence: high, medium, or low (how sure you are that it is real)",
    plan
      ? "- file and lines: where it has one, the file and inclusive line range ([start, end]) it concerns, in the plan's file or in existing code the plan misjudges"
      : "- file and lines: the file and inclusive line range ([start, end]) it concerns, where it has one",
    plan ? "- location: the step or section of the plan, or a symbol" : "- location: anything else that places it, such as a symbol",
    "- summary: the problem in one sentence",
    "- evidence: what you observed that shows the problem",
    "- fix: the change you suggest",
    "",
    "Then give your verdict and say what your review covers:",
    plan
      ? '- verdict: "pass" if the plan can go ahead as it stands, "fail" if something should change first, "unknown" if you cannot tell'
      : '- verdict: "pass" if nothing you found should hold the work back, "fail" if something should, "unknown" if you cannot tell',
    plan
      ? "- coverage: the parts of the plan and the existing code you checked it against (examined), and what you did not get to (not_examined). complete is true only if you examined all of the plan and everything it builds on."
      : "- coverage: what you examined (files, areas, checks you ran) and what you did not (not_examined). complete is true only if you examined everything the target covers.",
    `  ${PASS_RULE}`,
    "",
    "Write your review as prose first if you wish, then end with a fenced JSON block in exactly this shape:",
    "```json",
    reviewJsonShape(kind),
    "```",
    "If you find nothing worth raising, return an empty items array.",
  ];
}

/** The reviewer's instructions, built from the subject and focus alone. A string subject is code. */
export function reviewerPrompt(subject: string | ReviewSubject, focus: string | undefined): string {
  const s: ReviewSubject = typeof subject === "string" ? { kind: "code", target: subject } : subject;
  const isolation = "Do not look for the other review outside the target; relay gives it to you after yours is finished.";
  if (s.kind === "code") {
    return [
      `[relay] You are an independent code reviewer. Another reviewer is reviewing the same target separately; ${isolation}`,
      "Your session is read-only and you may not delegate.",
      "",
      `Review target: ${s.target}`,
      focus ? `Focus: ${focus}` : "Focus: none given; review for correctness first, then design and maintainability.",
      "",
      "Read the target and whatever surrounding code you need to judge it. Report only what you can support with evidence.",
      ...reviewFormat("code"),
    ].join("\n");
  }
  return [
    `[relay] You are an independent plan reviewer. Another reviewer is reviewing the same plan separately; ${isolation}`,
    "Your session is read-only and you may not delegate.",
    "",
    ...("path" in s ? [`The plan to review is in the file ${s.path}.`] : ["The plan to review follows.", "----- plan -----", s.text.trim(), "----- end of plan -----"]),
    focus ? `Focus: ${focus}` : "Focus: none given; review whether the plan would work first, then whether it is the right plan.",
    "",
    "The plan describes work that has not been done yet. Do not expect the code, files or changes it proposes to exist, and do not report their absence as a problem.",
    "Judge whether it would work and whether it is the right plan: assumptions about the existing code that do not hold (read the code it builds on to check), missing or misordered steps, risks and failure modes it leaves open, simpler alternatives, and how its result would be tested. Report only what you can support with evidence.",
    ...reviewFormat("plan"),
  ].join("\n");
}

/** The rules of a review's reconciliation, for its two sides (side labels: target ids, or CALLER_LABEL). */
export function reviewDiscussionRules(labels: string[]): string {
  const from = inSideOrder(labels).map((l, i) => `${sidePrefix(l)}<n>${i ? "" : " came"} from the ${sideName(l)} reviewer`).join(", ");
  const [a, b] = inSideOrder(labels).map(sidePrefix);
  const block = {
    verdict: "fail", coverage: { complete: false, examined: ["…"], not_examined: ["…"] },
    consensus: [{ ids: [`${a}1`, `${b}3`], severity: "major", confidence: "high", status: "agreed", summary: "…", file: "…", lines: [1, 2], location: "…", evidence: "…", fix: "…" }],
  };
  return [
    `- Items are identified by id: ${from}. Refer to items by id.`,
    "- When you write AGREE, and on your final turn whatever marker you use, put a fenced JSON block immediately before the marker line listing every original item id exactly once, with the verdict and coverage you hold the two reviews to reach together:",
    "    ```json",
    `    ${JSON.stringify(block)}`,
    "    ```",
    "  status is \"agreed\" (both of you hold that it is a real issue at that severity) or \"dropped\" (you hold that it should not be raised). Merge duplicates into one entry with several ids. An item is agreed or dropped only where both your closing blocks give it that status and the same severity (an entry without a severity holds the one its items have in the reviews); anything else is unresolved, with each block's position.",
    `  verdict is "pass" if nothing agreed should hold the work back, "fail" if something should, "unknown" if you cannot tell. coverage is what the two reviews examined between them; complete is true only if together they examined everything under review. ${PASS_RULE} The review's verdict is the one both your closing blocks reach; if they differ it is unresolved. Anything both reviews declared not examined counts against complete unless your closing coverage lists it under examined, in the same words.`,
  ].join("\n");
}

/** Returns the last fenced JSON block in a message that parses and satisfies pick. */
export function lastJsonBlock<T>(message: string, pick: (v: unknown) => T | null): T | null {
  // Fences are paired line by line, so a block tagged with another language (```ts) is skipped
  // as a whole and cannot throw the pairing off.
  const blocks: string[] = [];
  let open: string[] | null = null;
  for (const line of message.split("\n")) {
    if (/^\s*```[\w-]*\s*$/.test(line)) {
      if (open) {
        blocks.push(open.join("\n"));
        open = null;
      } else {
        open = [];
      }
    } else if (open) {
      open.push(line);
    }
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const picked = pick(JSON.parse(blocks[i]));
      if (picked !== null) return picked;
    } catch {
      // Not JSON; try the previous block.
    }
  }
  return null;
}
