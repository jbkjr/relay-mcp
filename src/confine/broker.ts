import { brokerCore, TURN_ENDED, MAX_MESSAGE, type BrokerTurn } from "./broker-core.js";
export { TURN_ENDED, turnRefusal, turnContext, type BrokerTurn } from "./broker-core.js";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, Tool } from "@modelcontextprotocol/sdk/types.js";
import { RELAY_CLI } from "../core/config.js";
import { relayServer } from "../mcp/server.js";
import { inProcessTree, sameProcess, type Proc } from "../core/procs.js";
import { socketPeer, type PeerIdentity } from "./peer.js";
import { ensureRelaySocketsDir } from "./sockets.js";
import { BRIDGE_SECRET_ENV } from "./broker-names.js";

export { BRIDGE_SECRET_ENV };

/**
 * The broker: relay's MCP tools for one confined turn, served by the worker, outside the sandbox,
 * on a Unix socket in a private directory. The confined agent reaches it only through
 * `relay bridge <socket>` (bridge.ts), which forwards stdio to the socket and holds no authority of
 * its own. The directory is inside relay's sockets directory (sockets.ts), which the profile of
 * every confined turn closes but for that turn's own bridge. The registry and worker creation stay outside the sandbox; every request is checked
 * against the live turn, and the socket is gone once the turn ends.
 */

/** macOS keeps 104 bytes for a socket path, its terminating NUL included. */
const MAX_SOCKET_PATH = 103;
/** How long a new connection has to present the turn's secret, and how long its first line may be. */
const HANDSHAKE_MS = 5000;
const MAX_HANDSHAKE = 512;

/**
 * Reads a connection's first line, which must be `{"relay_bridge_secret":"<the turn's secret>"}`,
 * and leaves whatever follows it unread. True when it matches, compared in constant time.
 */
function handshake(sock: net.Socket, secret: string): Promise<boolean> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("close", onClose);
      resolve(ok);
    };
    const onClose = () => done(false);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return void (buf.length > MAX_HANDSHAKE && done(false));
      // A first line longer than any secret line is refused unread (review r_f0fce42b C2).
      if (nl > MAX_HANDSHAKE) return done(false);
      sock.pause();
      const rest = buf.subarray(nl + 1);
      if (rest.length) sock.unshift(rest);
      let given: unknown;
      try {
        given = (JSON.parse(buf.subarray(0, nl).toString("utf8")) as { relay_bridge_secret?: unknown }).relay_bridge_secret;
      } catch {
        return done(false);
      }
      const a = Buffer.from(typeof given === "string" ? given : "");
      const b = Buffer.from(secret);
      done(a.length === b.length && crypto.timingSafeEqual(a, b));
    };
    const timer = setTimeout(() => done(false), HANDSHAKE_MS);
    sock.on("data", onData);
    sock.once("close", onClose);
    sock.resume();
  });
}

export interface Broker {
  /** The turn's private directory (mode 0700), which holds the socket. */
  dir: string;
  socketPath: string;
  /**
   * The MCP server entry to give the confined harness: `relay bridge <socket>`, with the turn's
   * secret in its environment (BRIDGE_SECRET_ENV) and nothing else. The broker serves a connection
   * only after it presents that secret AND its kernel peer identity belongs to the pinned launched
   * harness's live process tree and uid (core review C21).
   */
  bridgeCommand: { command: string; args: string[]; env: Record<string, string> };
  /**
   * The tools a connection to this broker is offered, each as its tools/list gives it (name,
   * description, input schema): read from a server made exactly as each connection's is, for a
   * harness that takes relay's tools through its own tool discovery (backends/gemini.ts). Host-side
   * only; a call still goes through the socket and every check above.
   */
  listTools(): Promise<Tool[]>;
  /**
   * The turn's secret in a file of its own, `bridge-secret` beside the socket (mode 0600), written on
   * the first call: for a harness whose own tool helper presents the secret rather than relay's bridge
   * (Gemini's tool discovery). Only the turn's own profile may read it (ConfinementPolicy.bridgeSecret);
   * every other turn's denies relay's sockets directory whole. It goes with the directory on close.
   */
  secretFile(): string;
  /** Pin the process relay launched, before it receives the bridge entry. May be called only once. */
  bindHarness(harness: Proc): void;
  /** Stops serving: closes every connection and removes the socket and its directory. Call it when the turn ends. */
  close(): Promise<void>;
}

/** The stdio bridge itself receives only its own credential, even from an inheriting harness. */
export function bridgeCommand(socketPath: string, secret: string): Broker["bridgeCommand"] {
  return {
    command: "/bin/sh",
    // The shell expands only this turn's bridge secret. Stored command text contains no value.
    args: ["-c", 'exec /usr/bin/env -i RELAY_BRIDGE_SECRET="$RELAY_BRIDGE_SECRET" "$@"', "relay-bridge", process.execPath, RELAY_CLI, "bridge", socketPath],
    env: { [BRIDGE_SECRET_ENV]: secret },
  };
}

/**
 * A transport over one socket connection that passes the agent's messages to the server only while
 * `refusal` returns null. Afterwards requests are answered with an error and everything else is dropped.
 */
class GatedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly inner: StdioServerTransport;
  private closed = false;
  private readonly gone: Promise<void>;

  constructor(private readonly sock: net.Socket, private readonly refusal: () => string | null,
    private readonly accepted?: (message: JSONRPCMessage) => void) {
    this.inner = new StdioServerTransport(sock, sock, { maxBufferSize: MAX_MESSAGE });
    this.gone = new Promise((resolve) => sock.once("close", () => resolve()));
  }

  async start(): Promise<void> {
    this.inner.onmessage = (message) => {
      let reason: string | null;
      try {
        reason = this.refusal();
      } catch (err) {
        reason = `relay could not check this agent's turn: ${(err as Error).message}`;
      }
      if (reason === null) {
        this.accepted?.(message);
        return this.onmessage?.(message);
      }
      if ("method" in message && "id" in message) {
        void this.send({ jsonrpc: "2.0", id: message.id, error: { code: TURN_ENDED, message: `Refused: ${reason}` } });
      }
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    // The inner transport closes itself on an oversized message; the connection goes with it.
    this.inner.onclose = () => {
      this.closed = true;
      this.sock.destroy();
      this.onclose?.();
    };
    void this.gone.then(() => this.close());
    await this.inner.start();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.sock.destroyed) return;
    // A write the agent never reads must not hold a reply open after the connection is gone.
    await Promise.race([this.inner.send(message), this.gone]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sock.destroy();
    await this.inner.close();
  }
}

/**
 * Starts serving one confined turn. Call it once the turn is running in the registry (the worker
 * has marked it so before it starts the agent), and close it when the turn ends.
 */
export async function openBroker(turn: BrokerTurn, opts: {
  parent?: string;
  /** Refusals go to the turn's log; never include the presented bearer secret. */
  onRefusal?: (reason: string) => void;
  /** Host-side seam for testing credential-read failures; never supplied by the confined client. */
  peerIdentity?: (sock: net.Socket) => Promise<PeerIdentity>;
  /** Host-only observation after production authentication and turn-liveness checks. */
  onAcceptedMessage?: (message: JSONRPCMessage, peer: PeerIdentity) => void;
  /** No-effect tool handler for boundary tests; production registration still controls authority. */
  toolHandler?: NonNullable<Parameters<typeof relayServer>[1]>["toolHandler"];
} = {}): Promise<Broker> {
  const core = brokerCore(turn, { toolHandler: opts.toolHandler });

  // In relay's sockets directory, which every confined turn's profile closes but for its own bridge.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(opts.parent ?? ensureRelaySocketsDir(), "relay-turn-")));
  fs.chmodSync(dir, 0o700);
  const socketPath = path.join(dir, "relay.sock");
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`the broker socket path is too long for a Unix socket (${Buffer.byteLength(socketPath)} bytes): ${socketPath}`);
  }

  let closed = false;
  let harness: Proc | null = null;
  const sockets = new Set<net.Socket>();
  const authenticating = new Set<Promise<void>>();
  // The turn's own: handed to its bridge through the harness, and written nowhere but, when a harness
  // needs it there, its own file in this private directory (secretFile), which only this turn may read.
  const secret = crypto.randomBytes(24).toString("base64url");
  const refusal = () => (closed ? "the relay turn this agent was started for has ended. Continue without relay." : core.refusal());
  /** The server a connection gets: one instance each, made from the worker's record of the turn alone. */
  const serve = core.serve;
  const refuse = (sock: net.Socket, reason: string) => {
    sock.destroy();
    (opts.onRefusal ?? ((why) => process.stderr.write(`[broker] refused: ${why}\n`)))(reason);
  };
  const server = net.createServer({ pauseOnConnect: true }, (sock) => {
    // An agent going away mid-reply must never take the worker down.
    sock.on("error", () => {});
    if (closed) return void sock.destroy();
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    const auth = (async () => {
      try {
        if (!harness) return refuse(sock, "the launched harness identity has not been bound");
        const peer = await (opts.peerIdentity ?? socketPeer)(sock);
        if (closed || sock.destroyed) return;
        if (peer.uid !== process.getuid?.()) return refuse(sock, `kernel peer uid ${peer.uid} is not the relay user's uid`);
        if (!inProcessTree(harness, peer)) return refuse(sock, `kernel peer pid ${peer.pid} is outside the live launched harness process tree (or its process identity changed)`);
        if (!await handshake(sock, secret)) return refuse(sock, "the bridge secret is missing or invalid");
        if (closed || sock.destroyed) return;
        // The handshake can take seconds. Do not carry an identity/tree decision across that wait.
        if (!inProcessTree(harness, peer)) return refuse(sock, `kernel peer pid ${peer.pid} left the live launched harness process tree (or its process identity changed)`);
        // One instance per connection, as each `relay mcp` process had its own.
        const mcp = serve();
        await mcp.connect(new GatedTransport(sock, refusal, (message) => opts.onAcceptedMessage?.(message, peer)));
        sock.resume();
      } catch (err) {
        refuse(sock, `could not authenticate broker peer: ${(err as Error).message}`);
      }
    })();
    authenticating.add(auth);
    void auth.finally(() => authenticating.delete(auth));
  });
  server.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((err) => {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  });
  fs.chmodSync(socketPath, 0o600);

  return {
    dir,
    socketPath,
    bridgeCommand: bridgeCommand(socketPath, secret),
    secretFile() {
      if (closed) throw new Error("the broker is closed");
      const file = path.join(dir, "bridge-secret");
      if (!fs.existsSync(file)) fs.writeFileSync(file, secret, { mode: 0o600, flag: "wx" });
      return file;
    },
    async listTools() {
      const why = refusal();
      if (why) throw new Error(`relay cannot list this turn's tools: ${why}`);
      return core.listTools();
    },
    bindHarness(identity) {
      if (closed || harness) throw new Error("the broker's launched harness identity is already bound or the broker is closed");
      if (!identity.start || !sameProcess(identity.pid, identity.start, { fresh: true })) throw new Error("cannot bind broker to an unknown, dead or reused harness process");
      harness = { ...identity };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled(authenticating);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
