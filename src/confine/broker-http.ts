import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, Tool } from "@modelcontextprotocol/sdk/types.js";
import { brokerCore, MAX_MESSAGE, TURN_ENDED, type BrokerTurn } from "./broker-core.js";
import { tcpPeerLookup, type TcpPeerCheck, type TcpPeerResult } from "./peer.js";
import { sameProcess, type Proc } from "../core/procs.js";
import { redactor, registerTurnSecret } from "../core/secrets.js";
import { BROKER_SERVER_NAME, BROKER_TOKEN_ENV } from "./broker-names.js";

export { BROKER_SERVER_NAME, BROKER_TOKEN_ENV };
export const BROKER_SESSION_CAP = 8;
const PENDING_CAP = 16, HEAD_CAP = 8192, DEADLINE_MS = 2000;
// Each lsof invocation has its own 2 s kill timeout. Allow callback/reap overhead,
// and at most one retry: a connection holds the semaphore for at most 4.5 s.
const PEER_ATTEMPT_MS = 2250, PEER_DEADLINE_MS = 2 * PEER_ATTEMPT_MS;

export interface HttpBroker {
  url: string;
  env: Readonly<Record<string, string>>;
  bindAppServer(p: Proc): void;
  arm(): void;
  disarm(): void;
  sessionsServed(): number;
  listTools(): Promise<Tool[]>;
  onFatal(fail: (why: string) => void): void;
  /** Caller kills and reaps the app server BEFORE closing the broker and its holders. */
  close(): Promise<void>;
}
export interface BrokerClock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface BrokerNetwork {
  createServer(options: net.ServerOpts, accept: (s: net.Socket) => void): net.Server;
  connect(port: number, host: string): net.Socket;
}
export interface HttpBrokerOptions {
  onRefusal?(why: string): void;
  peer?: TcpPeerCheck;
  /** Host-side lifecycle observation, including closures without DELETE. */
  onSession?(event: { id: string; state: "opened" | "closed"; live: number }): void;
  /** Host-side test seams; the client cannot choose these. */
  clock?: BrokerClock;
  network?: BrokerNetwork;
  processMatches?: (p: Proc) => boolean;
  toolHandler?: NonNullable<Parameters<typeof brokerCore>[1]>["toolHandler"];
}
const systemClock: BrokerClock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Gate each delivered message (including batches), after the HTTP body has been read. */
export class SessionGate implements Transport {
  onmessage?: Transport["onmessage"];
  onerror?: Transport["onerror"];
  onclose?: Transport["onclose"];
  constructor(private inner: StreamableHTTPServerTransport, private refusal: (m: JSONRPCMessage) => string | null,
    private retired: () => void) {}
  get sessionId() { return this.inner.sessionId; }
  async start() {
    this.inner.onmessage = (message, extra) => {
      const why = this.refusal(message);
      if (why === null) return this.onmessage?.(message, extra);
      if ("method" in message && "id" in message) {
        void this.send({ jsonrpc: "2.0", id: message.id, error: { code: TURN_ENDED, message: why } })
          .catch((err) => this.onerror?.(err));
      }
    };
    this.inner.onerror = (err) => this.onerror?.(err);
    this.inner.onclose = () => { this.retired(); this.onclose?.(); };
    await this.inner.start();
  }
  private writes = new Map<string | number, Promise<boolean>>();
  /** SDK send resolves when it queues SSE bytes. For escalation, require the Node response
   * to finish writing those bytes; close/error before finish is failed delivery, never consent. */
  trackReceipt(id: string | number, res: http.ServerResponse): void {
    if (this.writes.has(id)) throw new Error("duplicate in-flight escalation transport id");
    this.writes.set(id, new Promise(resolve => {
      const settle = (ok: boolean) => {
        res.off("finish", finish); res.off("close", close); res.off("error", close);
        resolve(ok);
      };
      const finish = () => settle(true), close = () => settle(res.writableFinished);
      res.once("finish", finish); res.once("close", close); res.once("error", close);
    }));
  }
  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    const id = "id" in message && ("result" in message || "error" in message) ? message.id : undefined;
    const written = id === undefined ? undefined : this.writes.get(id);
    try {
      let receipt = false;
      if ("result" in message) {
        const content = (message.result as { content?: { text?: string }[] }).content?.[0];
        try { receipt = !!content?.text && JSON.parse(content.text).state === "restart_pending"; } catch { /* ordinary tool result */ }
      }
      if (receipt && !written) throw new Error("escalation receipt has no bound HTTP response write");
      await this.inner.send(message, options);
      if (written && !await written) throw new Error("escalation HTTP response did not finish writing");
    } finally { if (id !== undefined && written) this.writes.delete(id); }
  }
  close() { return this.inner.close(); }
}

class OversizedInput extends Error {}
/** Read at most one stdio-sized message; do not let the SDK buffer an unbounded body. */
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => { req.off("data", data); req.off("end", end); req.off("aborted", aborted); req.off("error", aborted); };
    const aborted = () => { cleanup(); reject(new Error("HTTP input aborted")); };
    const oversized = () => { cleanup(); req.resume(); reject(new OversizedInput()); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MESSAGE) return oversized();
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("invalid JSON input")); }
    };
    if (Number(req.headers["content-length"]) > MAX_MESSAGE) return oversized();
    req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", aborted);
    if (req.aborted || req.destroyed) aborted();
  });
}

/** Preserve duplicates, unlike IncomingMessage.headers which coalesces/discards some of them. */
function headers(lines: string[]): Map<string, string[]> | null {
  const out = new Map<string, string[]>();
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0, i))) return null;
    const name = line.slice(0, i).toLowerCase();
    out.set(name, [...(out.get(name) ?? []), line.slice(i + 1).trim()]);
  }
  return out;
}

/** A paused TCP front authenticates without a process before handing a socket to Node HTTP. */
export async function openHttpBroker(turn: BrokerTurn, port: number, o: HttpBrokerOptions = {}): Promise<HttpBroker> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid broker port");
  const core = brokerCore(turn, { toolHandler: o.toolHandler });
  const token = crypto.randomBytes(32).toString("hex");
  registerTurnSecret(token, "broker token");
  const cut = redactor();
  const env = Object.freeze({ [BROKER_TOKEN_ENV]: token });
  const clock = o.clock ?? systemClock;
  const network = o.network ?? { createServer: net.createServer, connect: net.createConnection };
  const matches = o.processMatches ?? ((p: Proc) => sameProcess(p.pid, p.start, { fresh: true }));
  const log = o.onRefusal ?? ((why: string) => { process.stderr.write(`[broker-http] refused: ${why}\n`); });
  let closed = false, opening = true, armed = false;
  let app: Proc | null = null;
  let fatalReason: string | null = null;
  let failed: ((why: string) => void) | undefined;
  const fatal = (why: string) => {
    if (closed || fatalReason) return;
    fatalReason = why; armed = false;
    failed?.(why);
  };
  const refusal = () => closed || fatalReason ? "relay's turn has ended" : core.refusal();
  const authStatus = (h: Map<string, string[]> | null) => {
    if (!h) return 400;
    const host = h.get("host");
    if (host?.length !== 1 || host[0] !== `127.0.0.1:${port}`) return 421;
    if (h.has("origin")) return 403;
    const auth = h.get("authorization");
    const given = Buffer.from(auth?.length === 1 && auth[0].startsWith("Bearer ") ? auth[0].slice(7) : "");
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return 401;
    return [...h.values()].some((v) => v.length !== 1) ? 400 : 0;
  };
  const sockets = new Set<net.Socket>();
  const pending = new Set<net.Socket>();
  const timers = new Set<unknown>();
  const later = (run: () => void, ms: number) => {
    const handle = clock.setTimeout(() => { timers.delete(handle); run(); }, ms);
    timers.add(handle); return handle;
  };
  const clear = (h: unknown) => { clock.clearTimeout(h); timers.delete(h); };
  const reply = (s: Duplex, status: number, code?: string) => {
    log(`HTTP ${status}${code ? ` (${code})` : ""}`);
    if (s.destroyed || !s.writable || s.writableEnded) { s.destroy(); return; }
    s.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    // A peer that never reads cannot retain a pending slot indefinitely.
    const deadline = later(() => s.destroy(), 50);
    s.once("close", () => clear(deadline));
  };
  let active = 0;
  const waiters: (() => void)[] = [];
  const drain = () => { while (active < 2 && waiters.length) waiters.shift()!(); };
  const acquire = (sock: net.Socket): Promise<(() => void) | null> => new Promise((resolve) => {
    const grant = () => {
      sock.off("close", disconnected);
      if (closed || fatalReason || sock.destroyed) { resolve(null); return; }
      active++;
      resolve(() => { active--; drain(); });
    };
    const disconnected = () => {
      const i = waiters.indexOf(grant);
      if (i >= 0) waiters.splice(i, 1);
      resolve(null);
    };
    if (active < 2) grant();
    else { waiters.push(grant); sock.once("close", disconnected); }
  });
  const check = async (p: Proc, sock: net.Socket): Promise<TcpPeerResult> => {
    // Node may clear the ports on close. Both attempts must inspect the same tuple,
    // while the disconnect flags remain live for the empty-exit-1 race.
    const peerSocket = {
      localPort: sock.localPort, remotePort: sock.remotePort,
      get destroyed() { return sock.destroyed; },
      get readableEnded() { return sock.readableEnded; },
      get writableEnded() { return sock.writableEnded; },
    };
    const release = await acquire(sock);
    if (!release) return "foreign";
    let deadline: unknown, expired = false;
    const totalDeadline = new Promise<TcpPeerResult>((resolve) => {
      deadline = later(() => {
        expired = true;
        resolve({ error: 'TCP peer checker total deadline exceeded (code=none, signal=none, stderr="")' });
      }, PEER_DEADLINE_MS);
    });
    try {
      const failures: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        let timeout: unknown;
        let result: TcpPeerResult;
        try {
          result = await Promise.race([
            (o.peer ?? tcpPeerLookup)(p, peerSocket),
            totalDeadline,
            new Promise<TcpPeerResult>((resolve) => { timeout = later(() => resolve({
              error: 'TCP peer checker timed out (code=none, signal=none, stderr="")',
            }), PEER_ATTEMPT_MS); }),
          ]);
        } catch (error) {
          result = { error: `TCP peer checker threw (code=none, signal=none, stderr=""): ${error instanceof Error ? error.message : "unknown error"}` };
        } finally { clear(timeout); }
        if (typeof result !== "object" || closed) return result;
        failures.push(cut(result.error).slice(0, 1024));
        if (expired) break;
      }
      // Disconnection cannot hide a real operational failure or rescue partial output.
      const error = `relay could not check the TCP peer of its tools after ${failures.length} attempts: ${failures.join("; ")}`;
      fatal(error);
      return { error };
    } finally { clear(deadline); release(); }
  };
  const rpcError = (res: http.ServerResponse, id: string | number | null, message: string) => {
    if (res.destroyed || res.writableEnded) return;
    // Codex's HTTP adapter accepts JSON-RPC errors on 4xx too, but rmcp drops
    // id:null errors and keeps waiting for the call's id. If input cannot be
    // correlated, fail the HTTP send instead of delivering an id-less message.
    const uncorrelated = id === null && res.req.method === "POST";
    res.writeHead(uncorrelated ? 400 : 200, { "content-type": uncorrelated ? "text/plain; charset=utf-8" : "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: TURN_ENDED, message } }));
  };
  type Session = {
    transport: StreamableHTTPServerTransport;
    gate: SessionGate;
    server: ReturnType<typeof core.serve>;
    id?: string;
    retired: boolean;
    closing?: Promise<void>;
  };
  const live = new Map<string, Session>();
  // Keep all issued ids for the whole turn, including ones lost before initialize answered.
  const issued = new Set<string>(), tombstones = new Set<string>();
  const sessions = new Set<Session>(); // Includes initialization reservations: never overcommit.
  let served = 0;
  const retire = (session: Session) => {
    if (!session.retired) {
      session.retired = true; sessions.delete(session);
      if (session.id) {
        const wasLive = live.delete(session.id); tombstones.add(session.id);
        if (wasLive) o.onSession?.({ id: session.id, state: "closed", live: live.size });
      }
    }
    session.closing ??= Promise.resolve().then(() => session.server.close()).catch(() => {});
    return session.closing;
  };
  const newSession = () => {
    let session: Session;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => {
        let id: string;
        do { id = crypto.randomUUID(); } while (issued.has(id));
        issued.add(id); session.id = id;
        return id;
      },
      onsessioninitialized: (id) => {
        if (session.retired || refusal()) { tombstones.add(id); throw new Error("relay's turn has ended"); }
        live.set(id, session); served++;
        o.onSession?.({ id, state: "opened", live: live.size });
      },
      onsessionclosed: () => { void retire(session); },
    });
    const gate = new SessionGate(transport, (message) => {
      let why: string | null;
      try { why = session.retired ? "this relay session is closed" : refusal(); }
      catch { why = "relay could not check its turn"; }
      if (!why && "method" in message && message.method === "tools/call" && !armed) why = "relay's turn has not started";
      if (why) log(why);
      return why;
    }, () => { void retire(session); });
    session = { transport, gate, server: core.serve(), retired: false };
    sessions.add(session);
    return { session, gate };
  };
  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // SDK validation errors have id:null. Keep their diagnostic body, but make
    // POST rejections HTTP failures: Codex otherwise accepts then drops them.
    // A concurrent DELETE can also produce 404; use 400 so Codex cannot replay
    // the tool call by reinitializing a deliberately closed session.
    const writeHead = res.writeHead;
    let standaloneStream = false;
    res.writeHead = function (status: number, ...rest: unknown[]) {
      // The SDK passes headers directly to writeHead; Node's getHeader need not
      // retain them. Capture the successful GET stream while they are available.
      const headerIndex = typeof rest[0] === "string" ? 1 : 0;
      const responseHeaders = rest[headerIndex] as http.OutgoingHttpHeaders | undefined;
      const contentType = res.getHeader("content-type")
        ?? Object.entries(responseHeaders ?? {}).find(([name]) => name.toLowerCase() === "content-type")?.[1];
      standaloneStream = req.method === "GET" && status === 200 && String(contentType).startsWith("text/event-stream");
      if (req.method === "POST" && status >= 400) {
        log(`HTTP ${status} (MCP request rejected)`);
        const type = "text/plain; charset=utf-8";
        res.setHeader("content-type", type);
        if (responseHeaders) {
          const h = { ...responseHeaders };
          for (const name of Object.keys(h)) if (name.toLowerCase() === "content-type") delete h[name];
          rest[headerIndex] = { ...h, "content-type": type };
        }
      }
      return Reflect.apply(writeHead, this, [status === 404 ? (req.method === "POST" ? 400 : 200) : status, ...rest]);
    };
    const pairs: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) pairs.push(`${req.rawHeaders[i]}:${req.rawHeaders[i + 1]}`);
    const status = authStatus(headers(pairs));
    if (status) { log(`HTTP ${status}`); res.writeHead(status, { connection: "close" }); res.end(); return; }
    if (req.url !== "/mcp") { rpcError(res, null, "unknown relay endpoint"); return; }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let session = sid ? live.get(sid) : undefined;
    const aborted = () => { if (session) void retire(session); };
    req.once("aborted", aborted);
    res.once("close", () => {
      // The SDK cancels its GET stream mapping without closing the transport, and
      // its Node adapter can finish the response before emitting close. A successful
      // standalone SSE stream is the session's lifetime anchor; its end retires the
      // session even in that order. Ordinary POST/keep-alive closure is not teardown.
      if (!res.writableFinished || standaloneStream) aborted();
    });
    let body: unknown, id: string | number | null = null;
    try {
      if (req.method === "POST") body = await readBody(req);
      id = body && typeof body === "object" && "id" in body && (typeof body.id === "number" || typeof body.id === "string") ? body.id : null;
      const why = refusal();
      if (why) { log(why); rpcError(res, id, why); return; }
      if (sid) {
        // Recheck after the body wait: DELETE, an abort or oversized input may have retired it.
        if (!session || session.retired || live.get(sid) !== session) {
          log(tombstones.has(sid) ? "closed session" : "unknown session");
          rpcError(res, id, "this relay session is closed"); return;
        }
      } else {
        if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
        if (!body || typeof body !== "object" || !("method" in body) || body.method !== "initialize") {
          rpcError(res, id, "this relay session is closed"); return;
        }
        if (sessions.size >= BROKER_SESSION_CAP) { log("session cap"); rpcError(res, id, "relay's session limit for this turn is reached"); return; }
        const created = newSession(); session = created.session;
        await session.server.connect(created.gate);
        if (req.aborted || session.retired || refusal()) { await retire(session); rpcError(res, id, "relay's turn has ended"); return; }
      }
      if (id !== null && body && typeof body === "object" && "method" in body && body.method === "tools/call"
        && "params" in body && (body.params as { name?: string })?.name === "escalate") session.gate.trackReceipt(id, res);
      await session.transport.handleRequest(req, res, body);
      // Invalid initialize must not leave an unissued reservation in the live cap.
      if (!session.id) await retire(session);
    } catch (err) {
      if (session) await retire(session);
      if (err instanceof OversizedInput) res.setHeader("connection", "close");
      log(err instanceof OversizedInput ? "oversized input" : "invalid or aborted input");
      rpcError(res, id, err instanceof OversizedInput ? "relay input is too large; this relay session is closed" : "this relay session is closed");
    } finally { req.off("aborted", aborted); }
  };
  // All keep-alive requests repeat the free checks; only the first one needs a peer lookup.
  const responses = new WeakMap<Duplex, Set<http.ServerResponse>>();
  const httpServer = http.createServer({ maxHeaderSize: HEAD_CAP, connectionsCheckingInterval: DEADLINE_MS }, (req, res) => {
    let activeResponses = responses.get(req.socket);
    if (!activeResponses) responses.set(req.socket, activeResponses = new Set());
    activeResponses.add(res);
    res.once("close", () => activeResponses.delete(res));
    void handleRequest(req, res).catch(() => { res.destroy(); fatal("relay's HTTP broker dispatch failed"); });
  });
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = DEADLINE_MS;
  httpServer.keepAliveTimeout = 5000;
  httpServer.on("clientError", (err, sock) => {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    // Node's default handler also refuses to write a status line once a response
    // has started. In particular, raw HTTP bytes would corrupt an SSE POST.
    // rmcp fails an outstanding POST when its response stream closes unfinished.
    if ([...(responses.get(sock) ?? [])].some((res) => res.headersSent && !res.writableFinished)) {
      log(`HTTP 400 (${code})`); sock.destroy();
    } else reply(sock, 400, code);
  });
  httpServer.on("error", () => fatal("relay's HTTP broker failed"));
  // Node starts its headersTimeout connection tracker on 'listening', not on
  // 'connection'. This server receives authenticated sockets without listen().
  // Start that lifecycle explicitly, including for subsequent keep-alive heads.
  httpServer.emit("listening");
  let selfDone: ((result: TcpPeerResult) => void) | undefined;
  const front = network.createServer({ pauseOnConnect: true }, (sock) => {
    sock.on("error", () => {});
    if (closed || sock.localAddress !== "127.0.0.1" || pending.size >= PENDING_CAP) { log("connection refused"); sock.destroy(); return; }
    sockets.add(sock); pending.add(sock);
    let done = false;
    let buf = Buffer.alloc(0);
    const finish = () => { done = true; clear(timer); sock.off("data", data); };
    const timer = later(() => { finish(); log("head deadline"); sock.destroy(); }, DEADLINE_MS);
    sock.once("close", () => { finish(); pending.delete(sock); sockets.delete(sock); });
    const data = (chunk: Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0 && buf.length <= HEAD_CAP) return;
      finish(); sock.pause();
      if (end < 0 || end + 4 > HEAD_CAP) return reply(sock, 431);
      const h = headers(buf.subarray(0, end).toString("latin1").split("\r\n").slice(1));
      const status = authStatus(h);
      if (status) return reply(sock, status);
      if (fatalReason) return reply(sock, 503);
      const p = opening ? { pid: process.pid, start: "self-check" } : app;
      if (!p) return reply(sock, 403);
      void (async () => {
        const result = await check(p, sock);
        if (closed || sock.destroyed) return;
        if (opening) { pending.delete(sock); sock.destroy(); selfDone?.(result); return; }
        if (sock.readableEnded || sock.writableEnded) { sock.destroy(); return; }
        if (typeof result === "object") {
          reply(sock, 503); fatal("relay could not check the TCP peer of its tools"); return;
        }
        if (result !== "ok" || !matches(p)) return reply(sock, 403);
        if (fatalReason) return reply(sock, 503);
        pending.delete(sock);
        sock.unshift(buf);
        httpServer.emit("connection", sock);
        sock.resume();
      })().catch(() => { reply(sock, 503); fatal("relay's broker authentication failed"); });
    };
    sock.on("data", data); sock.resume();
  });
  const listeners = [front];
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= (async () => {
    closed = true; armed = false;
    for (const s of sockets) s.destroy();
    for (const t of timers) clock.clearTimeout(t);
    timers.clear(); waiters.splice(0).forEach((r) => r());
    httpServer.close(); // Also stops Node's headersTimeout checking interval.
    httpServer.closeAllConnections();
    await Promise.all([...sessions].map(retire));
    await Promise.all(listeners.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  })();
  const listen = async (server: net.Server, host: string, ipv6Only?: boolean) => {
    server.on("error", () => fatal("relay's broker listener or holder failed"));
    server.on("close", () => { if (!closed) fatal("relay's broker listener or holder was lost"); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Plain listeners: never opt into port sharing. exclusive controls Node cluster handle
      // sharing, not SO_REUSEPORT; ipv6Only:false keeps the [::] holder dual-stack.
      server.listen({ port, host, exclusive: true, reusePort: false, ...(ipv6Only === undefined ? {} : { ipv6Only }) }, () => {
        server.off("error", reject); resolve();
      });
    });
  };
  try {
    await listen(front, "127.0.0.1");
    for (const [host, ipv6Only] of [["0.0.0.0", undefined], ["::", false]] as const) {
      const holder = network.createServer({ pauseOnConnect: true }, (s) => { log("wildcard connection refused"); s.destroy(); });
      listeners.push(holder); await listen(holder, host, ipv6Only);
    }
    // Prove the checker works on a connection relay itself owns before starting the app server.
    await new Promise<void>((resolve, reject) => {
      const deadline = later(() => { client.destroy(); reject(new Error("broker TCP peer self-check timed out")); }, PEER_DEADLINE_MS + DEADLINE_MS);
      selfDone = (result) => {
        clear(deadline); client.destroy();
        result === "ok" && !fatalReason ? resolve() : reject(new Error("broker TCP peer self-check failed"));
      };
      const client = network.connect(port, "127.0.0.1");
      client.on("error", () => { clear(deadline); reject(new Error("broker TCP peer self-check could not connect")); });
      client.once("connect", () => client.write(`GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\n\r\n`));
    });
    selfDone = undefined; opening = false;
    if (fatalReason) throw new Error(fatalReason);
  } catch (err) { await close(); throw err; }
  return {
    url: `http://127.0.0.1:${port}/mcp`, env,
    bindAppServer(p) {
      if (closed || fatalReason || app) throw new Error("the broker app server is already bound or the broker is closed");
      if (!p.start || !matches(p)) throw new Error("cannot bind an unknown, dead or reused app server");
      app = { ...p };
    },
    arm() { if (!refusal() && app) armed = true; },
    disarm() { armed = false; },
    sessionsServed: () => served,
    async listTools() {
      const why = refusal();
      if (why) throw new Error(`relay cannot list this turn's tools: ${why}`);
      return core.listTools();
    },
    onFatal(fail) { failed = fail; if (fatalReason) fail(fatalReason); },
    close,
  };
}
