import { spawn, type ChildProcess } from "node:child_process";
import { sendGroupSignal } from "../core/procs.js";

/**
 * Streams the kernel's Seatbelt denials for one confined turn into a callback, so a harness that
 * cannot work inside the profile says which rule stopped it (srt does this). Every turn's profile
 * puts the turn's tag on its `(deny default)` rule (seatbelt.ts, `diagnosticTag`), and the kernel
 * appends that tag to each denial it logs; `log stream` is asked for just the denials carrying it.
 * The stream holds no authority and reads only the system log; a failure to start it is swallowed,
 * since it is a diagnostic, never part of the boundary.
 */

export const LOG = "/usr/bin/log";

/**
 * Denials every process on the machine raises against the deny-default profile, which say nothing
 * about the harness: lockdown-mode and boot-args reads the system libraries make at startup. They
 * are filtered out so they do not drown the harness's real denials in the log (review C4).
 */
const HARMLESS = new Set(["sysctl-read security.mac.lockdown_mode_state", "sysctl-read kern.bootargs"]);

export interface DenialStream {
  /** Resolves once `log stream` has attached (its filter banner has printed), so the launch can wait for it, or after a short grace. */
  ready: Promise<void>;
  /** Stops the stream. Safe to call more than once. */
  close(): void;
}

/** A single denial, condensed from the kernel's log line: the operation and what it was tried against. */
export interface SandboxDenial {
  /** For example `file-write-create /private/etc/x` or `mach-lookup com.apple.pasteboard.1`. */
  operation: string;
  /** The process that was refused, as the kernel names it (`node(1234)`). */
  process?: string;
}

/**
 * Parses one `log stream` ndjson line. Returns the denial when the line is a Sandbox denial
 * carrying `tag`, else null. The kernel's message reads `Sandbox: <proc>(<pid>) deny(1) <operation>`
 * then a newline and the tag; a run of identical denials is reported once as "N duplicate reports for …".
 */
export function parseDenial(line: string, tag: string): SandboxDenial | null {
  let msg: string;
  try {
    const j = JSON.parse(line) as { eventMessage?: unknown };
    if (typeof j.eventMessage !== "string") return null;
    msg = j.eventMessage;
  } catch {
    return null;
  }
  if (!msg.endsWith(`\n${tag}`)) return null;
  const first = msg.slice(0, msg.length - tag.length - 1).replace(/^\d+ duplicate reports? for /, "");
  const m = /^Sandbox:\s+(\S+)\s+deny\(\d+\)\s+(.*)$/s.exec(first);
  if (!m) return null;
  const operation = m[2].replace(/\s+/g, " ").trim();
  if (HARMLESS.has(operation)) return null;
  return { process: m[1], operation };
}

/**
 * Starts streaming this turn's sandbox denials. `onDenial` is called for each, at most `limit` of
 * them (default 200), so a flood cannot grow the log without bound. Returns a handle to stop it.
 */
export function streamSandboxDenials(tag: string, onDenial: (d: SandboxDenial) => void, opts: { limit?: number; attachMs?: number } = {}): DenialStream {
  const limit = opts.limit ?? 200;
  let seen = 0;
  let child: ChildProcess | null = null;
  let closed = false;
  let markReady!: () => void;
  // Resolves when log stream has attached, or after a grace, so the launch never blocks on it.
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  try {
    // log stream runs forever, and a process killed outright (SIGKILL, a crash) runs no cleanup, so a
    // plain child would be orphaned and keep streaming the whole system log. It runs under a small
    // watchdog shell instead, in its own process group: the shell stops it as soon as the process
    // that started it is gone (checked every second), and close() kills the whole group.
    const watchdog = 'P=$1; shift; "$@" & L=$!; trap \'kill $L 2>/dev/null\' TERM INT HUP EXIT; while kill -0 "$P" 2>/dev/null && kill -0 "$L" 2>/dev/null; do /bin/sleep 1; done; kill $L 2>/dev/null';
    child = spawn("/bin/sh", ["-c", watchdog, "sh", String(process.pid), LOG, "stream", "--style", "ndjson", "--predicate", `sender == "Sandbox" AND eventMessage ENDSWITH "${tag}"`], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  } catch {
    markReady();
    return { ready, close() {} };
  }
  child.on("error", () => markReady());
  // Give log stream a bounded time to attach; the launch waits for this, not forever.
  const graceTimer = setTimeout(markReady, opts.attachMs ?? 2000);
  if (typeof graceTimer.unref === "function") graceTimer.unref();
  let buf = "";
  let banner = false;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    // The first output means the stream has attached (log prints a "Filtering the log data…" banner).
    if (!banner) {
      banner = true;
      clearTimeout(graceTimer);
      markReady();
    }
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (seen >= limit) continue;
      const d = parseDenial(line, tag);
      if (d) {
        seen++;
        try {
          onDenial(d);
        } catch {
          // The sink's problem is not the turn's.
        }
      }
    }
  });
  return {
    ready,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(graceTimer);
      try {
        // The whole group: the watchdog shell and log stream with it. Only while the shell that
        // leads it is still relay's child, not yet reaped: Node reaps a child and records its exit
        // (exitCode or signalCode) in one step, and until then the pid, and so the group id, cannot
        // be reused. Once reaped, the id may be another process's group, and the stream has gone.
        if (child?.pid && child.exitCode === null && child.signalCode === null) sendGroupSignal(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    },
  };
}
