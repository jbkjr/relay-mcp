import net from "node:net";

/**
 * `relay bridge <socket>`: the MCP server a confined agent is given. It forwards newline-delimited
 * JSON-RPC between its stdio and the turn's broker socket and holds nothing else: no registry, no
 * context, no environment. It runs inside the agent's sandbox, whose profile allows that one socket.
 *
 * When the broker cannot be reached (the turn has ended, or the socket was never there), every
 * request, including those already sent and not yet answered, gets a JSON-RPC error at once, so
 * the agent is told rather than left waiting. Its only environment is the turn's secret, which it
 * presents first. Deliberately free of imports beyond node:net.
 */

/** JSON-RPC error code for "relay is not reachable from here". */
export const UNREACHABLE = -32002;

type Id = string | number;

function requestId(line: string): Id | null {
  try {
    const m = JSON.parse(line) as { method?: unknown; id?: unknown };
    return m && typeof m === "object" && typeof m.method === "string" && (typeof m.id === "string" || typeof m.id === "number") ? m.id : null;
  } catch {
    return null;
  }
}

function responseId(line: string): Id | null {
  try {
    const m = JSON.parse(line) as { method?: unknown; id?: unknown };
    return m && typeof m === "object" && m.method === undefined && (typeof m.id === "string" || typeof m.id === "number") ? m.id : null;
  } catch {
    return null;
  }
}

/** Splits a stream into lines, calling `each` for every complete one. */
function lines(stream: NodeJS.ReadableStream, each: (line: string) => void): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line) each(line);
    }
  });
}

/**
 * `secret`: the turn's bridge secret, from the environment the harness started the bridge with
 * (RELAY_BRIDGE_SECRET, broker.ts); sent as the connection's first line, before anything of the
 * agent's, since the broker serves nothing until it has it.
 */
export function bridge(socketPath: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, secret = process.env.RELAY_BRIDGE_SECRET ?? ""): Promise<void> {
  return new Promise((resolve) => {
    output.on("error", () => {});
    let connected = false;
    let down: string | null = null;
    let inputEnded = false;
    const waiting: string[] = [];
    const pending = new Set<Id>();

    const refuse = (id: Id) =>
      output.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: UNREACHABLE, message: `relay is not reachable from this agent: ${down}. Continue without relay.` } }) + "\n");

    const sock = net.connect(socketPath);
    const lost = (reason: string) => {
      if (down) return;
      down = reason;
      connected = false;
      for (const id of pending) refuse(id);
      pending.clear();
      for (const line of waiting.splice(0)) toRelay(line);
      if (inputEnded) resolve();
    };
    const toRelay = (line: string) => {
      const id = requestId(line);
      if (down) {
        if (id !== null) refuse(id);
        return;
      }
      if (!connected) return void waiting.push(line);
      if (id !== null) pending.add(id);
      sock.write(line + "\n");
    };

    sock.on("connect", () => {
      sock.write(JSON.stringify({ relay_bridge_secret: secret }) + "\n");
      connected = true;
      for (const line of waiting.splice(0)) toRelay(line);
      if (inputEnded) sock.end();
    });
    lines(sock, (line) => {
      const id = responseId(line);
      if (id !== null) pending.delete(id);
      output.write(line + "\n");
    });
    sock.on("error", (err: NodeJS.ErrnoException) => lost(`the turn it was started for has ended, or its connection could not be opened (${err.code ?? err.message})`));
    // The bridge stays up after that, answering with errors, until the agent closes its side.
    sock.on("close", () => lost("relay closed the connection; the turn this agent was started for has ended"));

    lines(input, toRelay);
    input.on("end", () => {
      inputEnded = true;
      if (down) return resolve();
      if (connected) sock.end();
    });
  });
}
