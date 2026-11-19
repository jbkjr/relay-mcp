import { execFile, spawn, type ExecFileException } from "node:child_process";
import type net from "node:net";
import { procStart, type Proc } from "../core/procs.js";
import { redactor } from "../core/secrets.js";

export interface PeerIdentity extends Proc { uid: number }

export type TcpPeerResult = "ok" | "foreign" | { error: string };
export type TcpPeerSocket = Pick<net.Socket, "localPort" | "remotePort"> & Partial<Pick<net.Socket, "destroyed" | "readableEnded" | "writableEnded">>;
export type TcpPeerCheck = (app: Proc, sock: TcpPeerSocket) => Promise<TcpPeerResult>;
/** Fixed helper invocation, injectable without spawning a process in unit tests. */
export type TcpPeerExec = (file: string, args: string[], options: {
  env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: "utf8";
}, done: (error: Error | null, stdout: string, stderr?: string) => void) => void;

function helperFailure(error: Error, stderr: string, cut: (s: string) => string, reason?: string): TcpPeerResult {
  const failure = error as ExecFileException;
  const code = typeof failure.code === "number" ? String(failure.code)
    : typeof failure.code === "string" && /^[A-Z0-9_]+$/.test(failure.code) ? failure.code : "none";
  const signal = typeof failure.signal === "string" && /^SIG[A-Z0-9]+$/.test(failure.signal) ? failure.signal : "none";
  const detail = reason ?? (failure.killed ? "timed out or killed" : typeof failure.code === "number" ? `exited ${code}` : "failed");
  // Redact before truncating: cutting a token in half first could hide its shape/value.
  const excerpt = cut(stderr).replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 256);
  return { error: `TCP peer helper ${detail} (code=${code}, signal=${signal}, stderr=${JSON.stringify(excerpt)})` };
}

/**
 * The TCP client must belong to the pinned app server itself, not its process tree. Relay's
 * accepted end is the positive control: a successful checker always sees that exact tuple.
 * A nonzero exit, timeout or spawn failure is operational even if stdout contains both ends.
 * Only an empty exit 1 for an already ended socket is a nonfatal drop.
 */
export const tcpPeerLookup = async (app: Proc, sock: TcpPeerSocket, o: { exec?: TcpPeerExec } = {}): Promise<TcpPeerResult> => {
  if (![app.pid, sock.localPort, sock.remotePort].every((n) => Number.isSafeInteger(n) && n! > 0)) return { error: "invalid TCP peer endpoints" };
  const { localPort, remotePort } = sock;
  const cut = redactor();
  return new Promise((resolve) => {
    try {
      // Do not AND in -p app,relay: lsof can exit 1 when a requested PID has no matching
      // file, even while printing relay's end. That is the normal foreign-peer case. The
      // single socket selector must always match our own end; compare its owners below.
      (o.exec ?? execFile)("/usr/sbin/lsof", ["-nP", `-iTCP@127.0.0.1:${remotePort}`, "-F", "pn"], {
        env: { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C" }, timeout: 2000, maxBuffer: 256 * 1024, encoding: "utf8",
      }, (error, stdout, stderr = "") => {
        // Do not rescue partial output: confirmation §14 obligation 2.
        if (error !== null) {
          const failure = error as ExecFileException;
          // lsof's empty exit 1 means no matching socket. A client that has already
          // ended cannot be authenticated or dispatched, but has not broken the checker.
          // Partial output, stderr, signals and timeouts NEVER take this exception.
          if (failure.code === 1 && !failure.signal && !failure.killed && !stdout.trim() && !stderr.trim()
            && (sock.destroyed || sock.readableEnded || sock.writableEnded)) return resolve("foreign");
          return resolve(helperFailure(error, stderr, cut));
        }
        let pid = 0;
        let own = false, client = false;
        const ownName = `127.0.0.1:${localPort}->127.0.0.1:${remotePort}`;
        const clientName = `127.0.0.1:${remotePort}->127.0.0.1:${localPort}`;
        for (const line of stdout.split("\n")) {
          if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
          else if (line === `n${ownName}` && pid === process.pid) own = true;
          else if (line === `n${clientName}` && pid === app.pid) client = true;
        }
        resolve(!own ? helperFailure(Object.assign(new Error(), { code: 0 }), stderr, cut, "did not list relay's own end") : client ? "ok" : "foreign");
      });
    } catch (error) {
      resolve(helperFailure(error instanceof Error ? error : new Error("helper could not run"), "", cut));
    }
  });
};

// Darwin sys/un.h: SOL_LOCAL=0, LOCAL_PEERPID=2, LOCAL_PEERCRED=1. xucred (sys/ucred.h)
// begins with uint32 version, uid_t uid. These are socket credentials supplied by the kernel,
// never a pid/uid sent by the client. Perl only inspects fd 3; it never reads the JSON-RPC stream.
const PEER = String.raw`
open(my $s, "+<&=3") or die "inherited socket: $!";
my $p = getsockopt($s, 0, 2); defined($p) && length($p) == 4 or die "LOCAL_PEERPID: $!";
my $c = getsockopt($s, 0, 1); defined($c) && length($c) >= 8 or die "LOCAL_PEERCRED: $!";
unpack("I", $c) == 0 or die "unknown xucred version";
print unpack("i", $p), " ", unpack("I", substr($c, 4, 4)), "\n";
`;

/** Read macOS peer credentials on the accepted socket itself, with a bounded, fixed system helper. */
export async function socketPeer(sock: net.Socket): Promise<PeerIdentity> {
  if (process.platform !== "darwin") throw new Error("kernel broker peer identity is supported only on macOS");
  const result = await new Promise<string>((resolve, reject) => {
    // A net.Socket in stdio duplicates its fd into the child. No private Node _handle is used.
    // No inherited PERL5OPT, module paths, cwd modules or caller-supplied program text.
    const child = spawn("/usr/bin/perl", ["-T", "-e", PEER], {
      stdio: ["ignore", "pipe", "pipe", sock], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    let out = "", err = "", failure: Error | undefined;
    const stop = (reason: string) => { failure ??= new Error(reason); child.kill("SIGKILL"); };
    const onClose = () => stop("peer disconnected before its kernel identity could be read");
    sock.once("close", onClose);
    const timer = setTimeout(() => stop("kernel peer identity helper timed out"), 2000);
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 128) stop("invalid kernel peer identity output");
    });
    child.stderr!.on("data", (chunk: Buffer) => { err = (err + chunk.toString("utf8")).slice(0, 256); });
    child.on("error", (error) => { failure = error; });
    child.once("close", (code) => {
      clearTimeout(timer);
      sock.off("close", onClose);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`kernel peer identity helper failed (${code}): ${err.trim()}`));
      else resolve(out);
    });
  });
  const m = /^(\d+) (\d+)\n$/.exec(result);
  if (!m || !Number.isSafeInteger(Number(m[1])) || Number(m[1]) <= 1 || !Number.isSafeInteger(Number(m[2]))) throw new Error("invalid kernel peer pid/uid");
  const pid = Number(m[1]), uid = Number(m[2]);
  const start = procStart(pid, { fresh: true });
  if (!start) throw new Error(`could not determine start time of kernel peer pid ${pid}`);
  return { pid, uid, start };
}
