#!/usr/bin/env node
// Each command loads what it uses when it runs, by a literal specifier: a worker, the MCP server,
// a confined agent's bridge and --version start without the registry, the views, install or
// doctor, unless they use them. A module that fails to load fails its command, as main's catch
// reports any other error.
import fs from "node:fs";
import readline from "node:readline";
import { relayVersion, usageError } from "./install/basics.js";
import { HOST_IDS } from "./hosts/types.js";

async function usage(): Promise<string> {
  const { TARGETS, targetLabel } = await import("./targets/index.js");
  return `relay — delegation, consultation, discussion and review across families of coding agent
        (targets: ${TARGETS.map((t) => targetLabel(t, t.id)).join(", ")}; hosts: ${HOST_IDS.join(", ")})

  relay mcp [--host <target>] [--desktop] [--context <file>]
                                      run the stdio MCP server (hosts start this, as install
                                      registers it): --host names the family of the host's
                                      sessions, --desktop marks the Claude desktop app's shared entry
  relay bridge <socket>               a confined agent's MCP server: forwards stdio to its turn's socket
  relay gemini-tools <dir> --list|<tool>
                                      a confined Gemini agent's relay tools, through its tool discovery
  relay tree [run_id] [--watch]       jobs, threads, discussions and reviews as one tree
  relay chat <discussion_id>          tail a discussion; type a line to send it to both participants
        [--say "message"] [--print]   one-shot forms: inject a message / print the transcript and exit
  relay room new                      create a room; print one invitation prompt per conversation
                                      (on macOS, then offer each on the clipboard in turn, clearing it after)
  relay room list                     list rooms as JSON (no transcript or credentials)
  relay room <id>                      follow a room; type a line to add terminal text
        --print                       print the full transcript and exit (no terminal required)
        --say "message"               add one terminal line; print the JSON result
        --reseat <member-1|member-2>   review a seat, type the exact confirmation, print a new prompt
        --close                       review the room, type the exact confirmation, close it
                                      Room writes require your own interactive terminal.
  relay approvals                     approval requests waiting for a decision
  relay adopt <id> --to <fingerprint>  explicitly authorize takeover by the connection named in status
  relay approve <request_id> [--job] [note]   let a launched agent do what it asked: needs an
                                      interactive terminal and a one-time code you type back, and
                                      refuses inside relay-launched process trees it can detect (not a
                                      security boundary; see README). --job: for the rest of that job.
                                      Not a request marked person_only, which only you can allow in your session
  relay deny <request_id> [reason]    refuse it (from anywhere)
  relay cancel <id | run_id>          cancel an item and everything under it, or a whole run
  relay clean [run_id]                remove finished runs' worktrees and merged relay/* branches
                                      (all finished runs if no id; unmerged branches are kept),
                                      relay's leftover temporary directories, and, if
                                      keep_records_days is set, records of runs with no
                                      activity for that many days; rooms expire independently,
                                      with transcripts kept for that many days after ending
  relay clean --forget <run_id> [--write]
                                      forget a finished run kept because its repository is gone:
                                      its records and relay's own files for it; prints what it
                                      would do, and changes nothing without --write
  relay install <${HOST_IDS.join("|")}> [--write] [--force] [--no-link]
                                      register relay with a host; prints what it would do, and
                                      changes nothing without --write
  relay uninstall <${HOST_IDS.join("|")}> [--write] [--force] [--remove-link]
                                      take relay's own entries out of a host again
  relay doctor                        check this machine against what relay needs
  relay qualify-codex [--version X.Y.Z] [--force]
                                      qualify a Codex release and make it the pin relay runs
                                      (relay refuses Codex without one), from your desktop
                                      login; it takes about an hour and a half. Without
                                      --version, npm's latest. A release that ships a pin needs
                                      this only for other versions: install codex puts it in place
  relay qualify-codex --shipped       switch to this release's shipped pin from one qualified here
  relay --version
`;
}

async function tree(args: string[]): Promise<void> {
  const { ACTIVE, getRun, latestRun, runNodes, sleep } = await import("./core/db.js");
  const { renderTree } = await import("./core/views.js");
  const watch = args.includes("--watch");
  const id = args.find((a) => !a.startsWith("--")) ?? latestRun()?.id;
  if (!id || !getRun(id)) return void console.log(id ? `unknown run ${id}` : "no runs yet");
  if (!watch) return void console.log(renderTree(id));
  for (;;) {
    process.stdout.write("\x1b[2J\x1b[H" + renderTree(id) + "\n");
    if (!runNodes(id).some((n) => ACTIVE.includes(n.status))) return;
    await sleep(1000);
  }
}

async function chat(args: string[]): Promise<void> {
  const { getNode, sleep } = await import("./core/db.js");
  const { inject } = await import("./core/ops.js");
  const id = args.find((a) => !a.startsWith("--"));
  const found = id ? getNode(id) : undefined;
  if (!found || found.kind !== "discussion" || !found.transcript_path) {
    console.error(`${id ?? "(no id)"} is not a discussion`);
    process.exitCode = 1;
    return;
  }
  const node = found;
  const file = found.transcript_path;
  // --print only reads the transcript, so it runs anywhere. Both ways of injecting a message —
  // --say and typing a line interactively — speak as the person to both agents, so they refuse
  // inside a launched agent's tree (no TTY or code: a message is not an approval). C4/X2.
  const sayIdx = args.indexOf("--say");
  if (sayIdx >= 0) {
    if (await launchedAgentTerminal("chat --say")) return;
    return void console.log(JSON.stringify(inject(node.id, args[sayIdx + 1] ?? ""), null, 2));
  }
  if (args.includes("--print")) return void console.log(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(no transcript yet)");
  if (await launchedAgentTerminal("chat")) return;

  let offset = 0;
  const flush = () => {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size <= offset) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    process.stdout.write(buf.toString());
  };
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const r = inject(node.id, line.trim());
    console.log(r.error ? `(not sent: ${r.error})` : "(sent: the other agent sees it on its next turn, the calling agent on its next call)");
  });
  for (;;) {
    flush();
    if (getNode(node.id)!.status !== "open") {
      await sleep(300);
      flush();
      rl.close();
      return;
    }
    await sleep(500);
  }
}

/** Rooms have their own terminal boundary; chat, approve and adopt retain theirs. */
async function room(args: string[]): Promise<void> {
  const [id, flag, value] = args;
  const usage = () => usageError("usage: relay room new | list\n       relay room <id> [--print | --say <text> | --reseat <member-1|member-2> | --close]");
  const named = id !== undefined && id !== "new" && id !== "list" && !id.startsWith("-");
  if (!((id === "new" || id === "list") && args.length === 1) && !(named && (
    args.length === 1 || args.length === 2 && (flag === "--print" || flag === "--close") ||
    args.length === 3 && (flag === "--say" && !value.startsWith("--") || flag === "--reseat" && (value === "member-1" || value === "member-2"))
  ))) return usage();
  const printResult = (result: object) => {
    console.log(JSON.stringify(result, null, 2));
    if ("error" in result || "refused" in result) process.exitCode = 1;
  };
  const { roomAddLine, roomCloseAtTerminal, roomCreate, roomList, roomPrint, roomReseat } = await import("./core/rooms.js");
  const { invitePrompt, renderRoomCreatePrompts, renderRoomCreateSummary, renderRoomInteractive, renderRoomList, renderRoomReseatPrompt, renderRoomReseatSummary, renderRoomSeatReview, renderRoomTranscript, roomCloseConfirmation, roomConfirmationMatches, roomReseatConfirmation, roomTerminalGuard } = await import("./core/room-terminal.js");
  const { roomText } = await import("./core/shown.js");
  const { sleep } = await import("./core/db.js");
  if (id === "list") return void console.log(renderRoomList(roomList()));
  // Even an unavailable id must pass the guard before any room lookup or review.
  if (flag !== "--print") {
    const guard = roomTerminalGuard();
    if (!guard.allowed) return printResult({ refused: guard.refused, reason: guard.reason });
  }
  if (id === "new") {
    const result = roomCreate();
    if (!("invites" in result)) return printResult(result);
    // The prompts are printed whatever follows; the clipboard is a convenience over them.
    console.log(renderRoomCreatePrompts(result));
    await offerClipboard(result.invites.map((i) => ({ label: i.label, text: invitePrompt(i) })), result.invites.map((i) => i.invite));
    return void console.log(`\n${renderRoomCreateSummary(result)}`);
  }
  const roomId = id as import("./core/room-types.js").RoomId;
  if (flag === "--say") return printResult(roomAddLine(roomId, value, roomText));
  const review = roomPrint(roomId);
  if ("error" in review) return printResult(review);
  if (flag === "--print") return void console.log(renderRoomTranscript(review));
  if (flag === "--reseat" || flag === "--close") {
    const seat = review.seats.find((s) => s.label === value);
    if (flag === "--reseat" && !seat) return printResult({ error: "Room unavailable." });
    console.log(renderRoomSeatReview(review, seat ? { action: "reseat", label: seat.label } : { action: "close" }));
    const exact = seat ? roomReseatConfirmation(roomId, seat.label) : roomCloseConfirmation(roomId);
    const input = readline.createInterface({ input: process.stdin });
    let answer: string | undefined;
    for await (const line of input) { answer = line; input.close(); break; }
    if (!roomConfirmationMatches(answer, exact)) return printResult({ refused: true, reason: "Confirmation did not match; nothing changed." });
    if (seat) {
      const result = roomReseat(roomId, seat.member_id, seat.generation);
      if (!("invite" in result)) return printResult(result);
      console.log(renderRoomReseatPrompt(result));
      await offerClipboard([{ label: result.invite.label, text: invitePrompt(result.invite, "terminal", result.purpose, { room_id: result.room_id, origin: result.origin }) }], [result.invite.invite]);
      return void console.log(`\n${renderRoomReseatSummary(result)}`);
    }
    return printResult(roomCloseAtTerminal(roomId));
  }

  console.log(renderRoomInteractive(review));
  if (review.state === "ended") return;
  let revision = review.revision, through = review.messages.at(-1)?.seq ?? 0, closed = false;
  const input = readline.createInterface({ input: process.stdin });
  input.on("close", () => { closed = true; });
  input.on("line", (line) => {
    if (!line.trim()) return;
    // A throw here would escape main's catch (this runs from readline's event); say it as main
    // would, and keep following, as after a refused line, which also exits 1.
    try {
      printResult(roomAddLine(roomId, line, roomText));
    } catch (err) {
      console.error(errorText(err));
      process.exitCode = 1;
    }
  });
  try {
    while (!closed) {
      const current = roomPrint(roomId);
      if ("error" in current) return printResult(current);
      if (current.revision !== revision) {
        console.log(renderRoomInteractive({ ...current, messages: current.messages.filter((m) => m.seq > through) }));
        revision = current.revision;
        through = current.messages.at(-1)?.seq ?? through;
      }
      if (current.state === "ended") return;
      await sleep(500);
    }
  } finally { input.close(); }
}

/**
 * Revision 3, part A: on macOS, offers room prompts on the clipboard one at a time
 * (core/room-clipboard.ts), after they were printed. The clipboard is cleared of their invites on
 * every way out: the end of the flow, end of input, and Ctrl-C or another terminating signal.
 */
async function offerClipboard(prompts: { label: string; text: string }[], secrets: string[]): Promise<void> {
  const { CLEAR_FAILED, clearInvites, clipboardFlow, clipboardOffered, pasteboard } = await import("./core/room-clipboard.js");
  if (!clipboardOffered()) return;
  const { constants } = await import("node:os");
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  const lines = input[Symbol.asyncIterator]();
  let armed = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (armed && clearInvites(pasteboard, secrets) === "failed") process.stderr.write(`\n${CLEAR_FAILED}\n`);
    process.exit(128 + (constants.signals[signal] ?? 1));
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);
  try {
    console.log("");
    await clipboardFlow(prompts, secrets, {
      ask: async (question) => {
        console.log(question);
        const next = await lines.next();
        return next.done ? null : next.value;
      },
      say: (line) => console.log(line),
    }, pasteboard, () => { armed = true; });
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    input.close();
  }
}

async function clean(args: string[]): Promise<void> {
  // Any spelling of --forget is the forget, which refuses the ones it does not take: a slip must
  // not turn one run's preview into a clean of every run.
  if (args.some((a) => a.startsWith("--forget"))) return forget(args);
  const ids = args.filter((a) => !a.startsWith("-"));
  if (ids.length > 1 || ids.length < args.length) return usageError("usage: relay clean [run_id]\n       relay clean --forget <run_id> [--write]");
  const { clean: cleanRuns } = await import("./core/ops.js");
  console.log(JSON.stringify(await cleanRuns(ids[0]), null, 2));
}

/** relay clean --forget <run_id> [--write]: the person's own say that a run's repository is gone for good. */
async function forget(args: string[]): Promise<void> {
  if (await launchedAgentTerminal("clean --forget")) return;
  const ids = args.filter((a) => !a.startsWith("-"));
  if (ids.length !== 1 || args.some((a) => a.startsWith("-") && a !== "--forget" && a !== "--write")) {
    return usageError("usage: relay clean --forget <run_id> [--write]");
  }
  const { forgetRun } = await import("./core/retention.js");
  const r = forgetRun(ids[0], { write: args.includes("--write") });
  console.log(JSON.stringify(r, null, 2));
  if (r.error || r.refused) process.exitCode = 1;
}

/** Refuses (usage error) when this command runs in a launched agent's environment or process tree (core/presence.ts). */
async function launchedAgentTerminal(command: string): Promise<boolean> {
  const { launchedTree } = await import("./core/presence.js");
  const why = launchedTree();
  if (!why) return false;
  usageError(`relay ${command} cannot run in a launched agent's environment. Run it from the person's own terminal. (${why[0].toUpperCase()}${why.slice(1)}.)`);
  return true;
}

/**
 * relay approve: allowed only for a person at an interactive terminal who types back a code relay
 * prints for this one request, outside every launched agent's process tree (docs/approve-boundary.md).
 */
/** Prints a command's JSON result; one that is an error (unknown id, already decided, …) exits 1. */
function printResult(result: unknown): void {
  if (result && typeof result === "object" && "error" in result) process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
}

async function approveAtTerminal(args: string[]): Promise<void> {
  if (await launchedAgentTerminal("approve")) return;
  if (!args[0]) return usageError("usage: relay approve <request_id> [--job] [note]");
  const { decide, getRequest, requestUnchanged, requestView } = await import("./core/approvals.js");
  const { commandRefusal } = await import("./core/extensions.js");
  const { personTypesCode, terminalProblem } = await import("./core/presence.js");
  const { escalationDecisionAuthentication } = await import("./core/escalation-authority.js");
  const id = args[0];
  const refuse = (reason: string) => { process.exitCode = 1; console.log(JSON.stringify({ refused: true, reason }, null, 2)); };
  const r = getRequest(id);
  if (!r) return printResult({ error: `unknown request ${id}` });
  // A request only the person may allow (docs/extensions.md) is never allowed by a command. It can be denied from here.
  const personal = commandRefusal(r);
  if (personal) return refuse(personal);
  if (r.status !== "pending") return printResult({ error: `request ${id} is already ${r.status}` });
  const tty = terminalProblem();
  if (tty) {
    return refuse(`relay approve allows a request only for a person at an interactive terminal, and ${tty}. ` +
      `Run relay approve ${id} in your own terminal and type the code it shows. relay deny ${id} works from anywhere.`);
  }
  const scope = args.includes("--job") ? "job" : "once";
  const view = requestView(r);
  const review = [
    `Request ${id} from ${r.node_id}`,
    `  kind:         ${JSON.stringify(view.kind)}`,
    `  effect:       ${JSON.stringify(view.effect)}`,
    `  in directory: ${JSON.stringify(view.in_directory)}`,
    `  wants:        ${JSON.stringify(r.summary)}`,
    `  allowing it:  ${scope === "job" ? "for the rest of that job" : "this once"}`,
  ];
  if (!(await personTypesCode(id, review))) return refuse(`the code was not typed back, so ${id} was not allowed; it is still pending.`);
  // What was shown is what is allowed: the request must still be the same pending request.
  const now = getRequest(id);
  if (!requestUnchanged(r, now)) {
    return printResult({ error: `request ${id} changed or was decided while you were asked (${now?.status ?? "gone"}); nothing was allowed` });
  }
  const rest = args.slice(1).filter((a) => a !== "--job");
  printResult(decide(id, true, "terminal", rest.join(" ") || undefined, scope, escalationDecisionAuthentication(r, "person-terminal")));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "mcp": {
      // What the host profile reads of ps is asked first, so that those processes run while the server's modules load.
      const { startEvidence } = await import("./mcp/host.js");
      const evidence = startEvidence(args, process.env);
      const { serve } = await import("./mcp/server.js");
      return serve(args, evidence);
    }
    case "bridge": {
      // Runs inside a confined agent's sandbox, where the registry is unreadable; it never opens it.
      if (!args[0]) return usageError("usage: relay bridge <socket>");
      const { bridge } = await import("./confine/bridge.js");
      return bridge(args[0]);
    }
    case "gemini-tools": {
      // Runs inside a confined Gemini agent's sandbox, as Gemini's tool discovery runs it (backends/gemini.ts geminiTools).
      const { geminiTools } = await import("./confine/gemini-tools.js");
      process.exitCode = await geminiTools(args[0], args.slice(1));
      return;
    }
    case "worker": {
      const { runWorker } = await import("./worker.js");
      return runWorker(args[0]);
    }
    case "tree":
      return tree(args);
    case "chat":
      return chat(args);
    case "room":
      return room(args);
    case "cancel": {
      if (await launchedAgentTerminal(cmd)) return;
      if (!args[0]) return usageError("usage: relay cancel <id | run_id>");
      const { cancel } = await import("./core/ops.js");
      return printResult(await cancel(null, { id: args[0] }));
    }
    case "clean":
      return clean(args);
    case "approvals": {
      const { pendingRequests, requestView } = await import("./core/approvals.js");
      const open = pendingRequests();
      return void console.log(open.length ? JSON.stringify(open.map(requestView), null, 2) : "no approval requests waiting");
    }
    case "adopt": {
      if (await launchedAgentTerminal(cmd)) return;
      if (!process.stdin.isTTY) return usageError("Adoption requires an interactive terminal (TTY); piped stdin cannot authorize a transfer.");
      const id = args[0], to = args[args.indexOf("--to") + 1];
      if (!id || !args.includes("--to") || !/^[0-9a-f]{24}$/.test(to ?? "")) return usageError("usage: relay adopt <id> --to <status-session-fingerprint>");
      const { adoptionRun, authorizeAdoption } = await import("./core/adoption.js");
      const { pendingRequests, requestView } = await import("./core/approvals.js");
      const { unseenEvents } = await import("./core/events.js");
      const { renderTree } = await import("./core/views.js");
      const run = adoptionRun(id);
      if (!run) return usageError("Item unavailable.");
      const runId = run.id;
      console.log(`Take over run ${runId} into connection ${to}: all its jobs, approval requests and events, with supervision rights. Pending events will be delivered there. The old owner must have exited.`);
      console.log(`Directory: ${JSON.stringify(run.root_cwd)}`);
      console.log(`Items: ${JSON.stringify(renderTree(runId))}`);
      console.log(`Pending approvals: ${JSON.stringify(pendingRequests(runId).map(requestView))}`);
      console.log(`Pending events: ${JSON.stringify(unseenEvents([runId]).map((e) => ({ event_id: e.id, kind: e.kind, item: e.item_id })))}`);
      const exact = `adopt ${runId} into ${to}`;
      console.log(`Type exactly ${JSON.stringify(exact)} to authorize this transfer:`);
      const input = readline.createInterface({ input: process.stdin });
      let answer = "";
      for await (const line of input) { answer = line; input.close(); break; }
      if (answer !== exact) return usageError("Transfer not confirmed; no authority changed.");
      const result = authorizeAdoption(runId, to);
      console.log(JSON.stringify(result, null, 2));
      if (!result.authorized) process.exitCode = 1;
      return;
    }
    case "approve":
      return approveAtTerminal(args);
    case "deny": {
      // Denying needs no person: it only ever narrows what an agent may do.
      if (!args[0]) return usageError("usage: relay deny <request_id> [reason]");
      const rest = args.slice(1).filter((a) => a !== "--job");
      const { decide, getRequest } = await import("./core/approvals.js");
      const { escalationDecisionAuthentication } = await import("./core/escalation-authority.js");
      const request = getRequest(args[0]);
      return printResult(decide(args[0], false, "terminal", rest.join(" ") || undefined, args.includes("--job") ? "job" : "once", request ? escalationDecisionAuthentication(request, "terminal-deny") : undefined));
    }
    case "install":
      return (await import("./install.js")).install(args);
    case "uninstall":
      return (await import("./install.js")).uninstall(args);
    case "doctor":
      return (await import("./install/doctor.js")).doctor();
    case "qualify-codex":
      process.exitCode = await (await import("./install/qualify-codex.js")).qualifyCodex(args);
      return;
    case "--version":
    case "-v":
    case "version":
      return void console.log(`relay ${relayVersion()}`);
    case "help":
    case "--help":
    case "-h":
      return void console.log(await usage());
    default:
      // No command, or one relay does not have, is a mistake in how it was called.
      return usageError(`${cmd ? `relay: unknown command ${cmd}\n\n` : ""}${await usage()}`);
  }
}

// A config typo or another error relay reports in words is a message, not a stack trace;
// RELAY_DEBUG=1 shows the stack, for a bug report.
function errorText(err: unknown): unknown {
  return err instanceof Error ? (process.env.RELAY_DEBUG ? err.stack : `relay: ${err.message}`) : err;
}
main().catch((err) => {
  console.error(errorText(err));
  process.exit(1);
});
