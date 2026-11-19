// The default turn runner, for a CLI that reads its prompt on stdin and writes one JSON event per
// line (Claude, and Codex's `codex exec` fallback), and the after-turn step a backend can add. Apart
// from run.ts, so that the backends can use it without importing the backend registry.
import { spawn } from "node:child_process";
import readline from "node:readline";
import { drainGroup, isGroupSignalRefusal, killProcs, procStart, sendGroupSignal, stopProcs } from "../core/procs.js";
import { executable } from "../core/executables.js";
import { openAgentLog, watchProcess, type Invocation, type OnEvent, type StreamState, type TurnHandle, type TurnResult, type TurnSpec } from "./types.js";
import { diagnosticTail } from "../core/redact.js";
import { refusalError } from "../core/refusal.js";

/** The handle with `fn` run after the agent and its descendants have stopped, before the turn is reported. */
export function afterTurn(handle: TurnHandle, fn: (result: TurnResult) => Promise<TurnResult>): TurnHandle {
  const done = handle.done.then(fn);
  return { ...handle, done, cancel: async () => { await handle.cancel(); await done; } };
}

/**
 * Diagnostic lines a harness prints only because relay asked it to (Claude Code's sandbox under
 * SRT_DEBUG, which reports its proxy ports): kept in the agent's log, never in what a failed turn reports.
 */
const DEBUG_LINE = /^\[SandboxDebug\] /;

/**
 * Runs one turn of a CLI that takes its prompt on stdin and writes one JSON event per line, which
 * `onEvent` reads into the turn's state: Claude, and Codex's `codex exec` fallback.
 */
export function streamTurn(spec: TurnSpec, { invocation: inv, onEvent, onStderr, unlogged }: {
  invocation: Invocation; onEvent: OnEvent; onStderr?: (line: string, state: StreamState) => void;
  /** Events too many and too small to keep in the agent log (a stream's token deltas); still given to onEvent. */
  unlogged?: (event: Record<string, unknown>) => boolean;
}): TurnHandle {
  const { log, warnings: logWarnings } = openAgentLog(spec.logPath, { env: inv.env });
  log.write(`\n# ${new Date().toISOString()} ${inv.command} ${inv.args.map((a) => JSON.stringify(a)).join(" ")}\n`);

  // Preparation may have grown the never floor since the turn captured its launch plan.
  try { spec.checkEnvironment?.(inv.env); }
  catch (err) { log.end(); throw err; }
  // detached: the agent leads its own process group, so cancel can signal the whole group.
  const child = spawn(executable(inv.command, inv.env.PATH), inv.args, { cwd: spec.cwd, env: inv.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const pid = child.pid ?? -1;
  const state: StreamState = { finalMessage: "", completed: false };
  const stderrTail = diagnosticTail();
  let reported = false;
  let refused = false;
  let stopped = false;
  /** A check relay makes after the start report failed: the prompt reached the agent, so it is not undelivered, but nothing more of the turn may run. */
  const stopIfAsked = () => {
    if (!state.stop || refused || stopped) return;
    stopped = true;
    settled = watch.look() || settled;
    signalGroup("SIGKILL");
  };
  /** True once a look has found the agent alive after it stopped starting things: at its last word, or when told to stop. */
  let settled = false;

  // The prompt goes on stdin, which is then closed: the CLIs block on an open stdin pipe. (Claude
  // Code gives up on stdin after three seconds, and starts its sandbox only after reading it, so
  // nothing the sandbox reports can be waited for before the prompt is sent.)
  child.stdin.on("error", () => {});
  child.stdin.end(spec.prompt);

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let event: Record<string, unknown> | null = null;
    if (line.trim().startsWith("{")) {
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Non-JSON noise on stdout is kept in the log and otherwise ignored.
      }
    }
    if (!event || !unlogged?.(event)) log.write(line + "\n");
    if (!event) return;
    try {
      onEvent(event, state, spec);
    } catch {
      // A backend's reading of an event it cannot make sense of is not the turn's end.
    }
    // The agent is not running the way relay asked. It reports this before its first request to
    // the model, so stopping it here stops it before it has done anything.
    if (state.refuse && !refused) {
      refused = true;
      // A last look first, while it can still be traced: it is being stopped, not lost.
      settled = watch.look() || settled;
      signalGroup("SIGKILL");
    }
    stopIfAsked();
    // A vendor safety stop is terminal. Stop the harness before it can retry or start tools.
    // Unlike a launch-policy rejection, the prompt reached the vendor and its session is kept.
    if (state.refusal) {
      settled = watch.look() || settled;
      signalGroup("SIGKILL");
    }
    // The agent has said its last word and is about to exit: the last look, if it is still there to be looked at.
    if (state.ended && !reported) {
      reported = true;
      settled = watch.look() || settled;
    }
  });
  let errLine = "";
  child.stderr.setEncoding("utf8");
  /** One complete stderr line: to the log; to the tail a failure quotes unless it is relay-requested debug output; to the backend's own check. */
  const errLineDone = (line: string, live = true) => {
    log.write("[stderr] " + line + "\n");
    if (!DEBUG_LINE.test(line)) stderrTail.write(line + "\n");
    if (!onStderr) return;
    onStderr(line, state);
    if (live) stopIfAsked();
  };
  child.stderr.on("data", (text: string) => {
    errLine += text;
    const end = errLine.lastIndexOf("\n");
    if (end >= 0) {
      for (const line of errLine.slice(0, end).split("\n")) errLineDone(line);
      errLine = errLine.slice(end + 1);
    }
  });

  let cancelled = false;
  let groupRefused = false;
  let cleanupRefusal: string | undefined;
  const watch = watchProcess(pid);
  let resolveDone!: (result: TurnResult) => void;
  const done = new Promise<TurnResult>((resolve) => { resolveDone = resolve; });
  let settling: Promise<void> | undefined;
  let spawnError: string | undefined;
  child.on("error", (err) => {
    spawnError = `could not start ${inv.command}: ${err.message}`;
    // A process that never started has no exit to wait for.
    if (pid <= 0) {
      log.end();
      watch.stop();
      resolveDone({ sessionId: undefined, finalMessage: "", exitCode: null, status: "failed", error: spawnError });
    }
  });
  // Resolved from "exit", not "close": a detached process the agent started can hold its output
  // open indefinitely, and the turn must not wait on that. Output gets a moment to drain.
  const settle = (code: number | null) => settling ??= (async () => {
    const unseenMs = watch.stop();
    if (!groupRefused) {
      // Cleared once the streams have closed, so that it does not keep the worker alive for a second after its last turn.
      let drained: NodeJS.Timeout | undefined;
      await Promise.race([new Promise((r) => child.once("close", r)), new Promise((r) => { drained = setTimeout(r, 1000); })]);
      clearTimeout(drained);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    if (errLine) errLineDone(errLine, false);
    log.end();
    // The turn is over only when nothing of the agent is left: children can outlive the leader.
    if (!groupRefused) groupRefused = !await drainGroup(pid);
    if (groupRefused) {
      cleanupRefusal ??= `Agent cleanup refused for group ${pid}`;
      child.unref();
    }
    const survivors = groupRefused ? [pid, ...watch.procs().map(p => p.pid)] : await stopProcs(watch.procs());
    const warnings = [...(state.warnings ?? []), ...logWarnings(), ...(cleanupRefusal ? [cleanupRefusal] : [])];
    const base = {
      sessionId: state.sessionId, finalMessage: state.finalMessage, exitCode: code, ...(state.denials?.length ? { denials: state.denials } : {}),
      // Stopped at its start report, before its first request to the model: the prompt did no work.
      ...(refused ? { delivered: false } : {}),
      ...(warnings.length ? { warnings } : {}), ...(state.speedWarnings?.length ? { speedWarnings: state.speedWarnings } : {}),
      ...(survivors.length ? { survivors } : {}), ...(settled || pid <= 0 ? {} : { unseenMs }),
    };
    if (spawnError) return resolveDone({ ...base, status: "failed", error: spawnError });
    if (state.refuse) return resolveDone({ ...base, status: "failed", error: state.refuse });
    if (state.stop) return resolveDone({ ...base, status: "failed", error: state.stop });
    if (state.refusal) return resolveDone({ ...base, status: "refused", refusal: state.refusal, error: refusalError(state.refusal) });
    if (cancelled) return resolveDone({ ...base, status: "interrupted", error: "cancelled" });
    if (state.failed) return resolveDone({ ...base, status: "failed", error: state.failed });
    if (state.completed) return resolveDone({ ...base, status: "ok" });
    // The stream ended without a terminal event: the agent was killed or crashed.
    resolveDone({ ...base, status: "failed", error: `agent exited (code ${code}) without finishing its turn. ${stderrTail.text().trim().split("\n").slice(-3).join(" ")}`.trim() });
  })();
  child.on("exit", (code) => void settle(code));

  const signalGroup = (sig: NodeJS.Signals) => {
    if (groupRefused) return false;
    try {
      sendGroupSignal(pid, sig);
    } catch (err) {
      if (isGroupSignalRefusal(err)) {
        groupRefused = true;
        cleanupRefusal = `Agent cleanup refused for group ${pid}: ${err.message}`;
        void settle(null);
        return false;
      }
      // Already gone.
    }
    return true;
  };
  const cancel = async () => {
    if (cancelled || pid <= 0) { await done; return; }
    cancelled = true;
    // Before anything is signalled: once the agent has exited, what it started can no longer be traced to it.
    settled = watch.look() || settled;
    // SIGINT first: it is the request to stop cleanly, and `codex exec` only cleans up its tool processes on it.
    if (!signalGroup("SIGINT")) { await done; return; }
    const timer = setTimeout(() => {
      watch.look();
      if (signalGroup("SIGKILL")) killProcs(watch.procs());
    }, spec.config.cancel_grace_ms);
    await done;
    clearTimeout(timer);
    if (signalGroup("SIGKILL")) killProcs(watch.procs());
  };

  return { pid, pgid: pid, startedAt: procStart(pid), done, cancel };
}

