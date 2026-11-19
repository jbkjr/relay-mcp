import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/**
 * `relay gemini-tools <dir> --list | <tool>`: relay's tools for a Gemini agent, through Gemini's
 * command-based tool discovery (backends/gemini.ts geminiTools), which runs this, inside the turn's
 * sandbox, through the shim `<dir>/call`. Like `relay bridge` (bridge.ts) it holds no authority of
 * its own and opens nothing of relay's but the turn's broker socket: the broker decides every call.
 *
 * - `--list`: prints `<dir>/tools.json`, the turn's tools as Gemini's function declarations, which
 *   relay wrote from the broker's own list before Gemini started, and leaves a mark where
 *   `<dir>/bridge.json` says (`listed`, in the turn's private temporary directory), which relay checks
 *   before the prompt to know that Gemini ran its discovery (backends/gemini.ts geminiDiscoveryCheck).
 *   It reads no broker, so the list cannot fail for want of one (a failed discovery would fail
 *   Gemini's session setup); a mark it cannot leave fails nothing.
 * - `<tool>`: reads the arguments, a JSON object, from stdin (as Gemini 0.64.0 writes them,
 *   tool-registry.ts:111-112), reads the turn's secret from the broker's file that `<dir>/bridge.json`
 *   names (which only this turn's sandbox may read), presents it on the socket named there, as the
 *   bridge does, then calls the tool over MCP: initialize, initialized,
 *   tools/call. The result's text goes to stdout. Gemini reads any stderr, or a non-zero exit, as a
 *   failure (:157-173), so stderr is written only then: a tool error, a refusal, or relay not
 *   reachable, in which case the agent is told to continue without relay, as the bridge tells it.
 *   Every failure says plainly what failed, with the tool's name, and never what the secret is; one
 *   that a Gemini release changing how it runs these commands would cause says that it may be that.
 *
 * Deliberately free of imports beyond node's own.
 */

/** As the broker's MAX_MESSAGE: arguments larger than this are refused before anything is sent. */
const MAX_ARGS = 8 * 1024 * 1024;
/** The MCP protocol version this client asks for (one relay's server speaks). */
const PROTOCOL = "2025-06-18";

type Io = { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
type Json = Record<string, unknown>;

const fail = (io: Io, text: string, code = 1): number => {
  io.stderr.write(`${text}\n`);
  return code;
};

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      size += b.length;
      if (size > MAX_ARGS) return reject(new Error(`the arguments are larger than ${MAX_ARGS} bytes`));
      chunks.push(b);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

/** The text of a tool result's content, as an MCP client shows it: text as it is, anything else as JSON. */
function contentText(result: Json): string {
  const content = Array.isArray(result.content) ? (result.content as Json[]) : [];
  return content.map((c) => (c && c.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c))).join("\n");
}

/** Runs one call through the turn's broker; resolves with the tools/call response, or rejects with what went wrong. */
function callThroughBroker(socketPath: string, secret: string, tool: string, args: Json): Promise<{ result?: Json; error?: { code?: number; message?: string } }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      fn();
    };
    const send = (m: Json) => sock.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      // The turn's secret first, as the bridge presents it; the broker serves nothing until it has it.
      sock.write(JSON.stringify({ relay_bridge_secret: secret }) + "\n");
      send({ id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "relay-gemini-tools", version: "1" } } });
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m: Json;
        try {
          m = JSON.parse(line) as Json;
        } catch {
          continue;
        }
        // A request of the server's (a ping): answered, or refused as a client with no capabilities would.
        if (typeof m.method === "string" && m.id !== undefined) {
          send(m.method === "ping" ? { id: m.id, result: {} } : { id: m.id, error: { code: -32601, message: `relay's Gemini tool client does not provide ${m.method}` } });
          continue;
        }
        if (m.id === 1) {
          if (m.error) return done(() => resolve({ error: m.error as { code?: number; message?: string } }));
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/call", params: { name: tool, arguments: args } });
        } else if (m.id === 2) {
          done(() => resolve(m.error ? { error: m.error as { code?: number; message?: string } } : { result: (m.result ?? {}) as Json }));
        }
      }
    });
    sock.on("error", (err: NodeJS.ErrnoException) => done(() => reject(new Error(`the turn it was started for has ended, or its connection could not be opened (${err.code ?? err.message})`))));
    sock.on("close", () => done(() => reject(new Error("relay closed the connection: the turn this agent was started for has ended, or relay refused it"))));
  });
}

export async function geminiTools(dir: string | undefined, argv: string[], io: Io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  if (!dir || argv.length !== 1) {
    return fail(io, `usage: relay gemini-tools <dir> (--list | <tool>)\nrelay's tool helper was run with ${argv.length} argument(s) after its directory, where it takes --list or one tool's name (its arguments as JSON on stdin). If Gemini changed how it runs tool commands, relay's tools do not work with this version of it.`, 2);
  }
  if (argv[0] === "--list") {
    let list: string;
    try {
      list = fs.readFileSync(path.join(dir, "tools.json"), "utf8");
      if (!Array.isArray(JSON.parse(list))) throw new Error("it is not a list");
    } catch (err) {
      return fail(io, `relay's tool list for this turn could not be read (${(err as Error).message}).`);
    }
    // The mark that Gemini ran relay's discovery: where relay's own file says, nothing it cannot leave fatal.
    try {
      const listed = (JSON.parse(fs.readFileSync(path.join(dir, "bridge.json"), "utf8")) as { listed?: unknown }).listed;
      if (typeof listed === "string") fs.writeFileSync(listed, "listed\n");
    } catch {
      // Relay then tells the agent its tools are unavailable, which is the safe side.
    }
    io.stdout.write(list);
    return 0;
  }
  const tool = argv[0];
  let args: Json;
  try {
    const text = (await readAll(io.stdin)).trim();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("they are not a JSON object");
    args = parsed as Json;
  } catch (err) {
    return fail(io, `relay could not read the arguments for ${tool}: ${(err as Error).message}. They come as a JSON object on stdin; if Gemini changed how it passes them, relay's tools do not work with this version of it.`);
  }
  let socketPath: string, secretFile: string;
  try {
    // Paths only; the secret's file is the broker's, which this turn's sandbox alone may read.
    const where = JSON.parse(fs.readFileSync(path.join(dir, "bridge.json"), "utf8")) as { socket?: unknown; secret?: unknown };
    if (typeof where.socket !== "string" || typeof where.secret !== "string") throw new Error("bridge.json names no socket or secret");
    socketPath = where.socket;
    secretFile = where.secret;
  } catch {
    return fail(io, "relay is not reachable from this agent: this turn's connection to relay is gone. Continue without relay.");
  }
  let secret: string;
  try {
    secret = fs.readFileSync(secretFile, "utf8");
  } catch (err) {
    return fail(io, `relay is not reachable from this agent: this turn's credential for relay could not be read (${(err as NodeJS.ErrnoException).code ?? "error"}), as happens once the turn is over or from outside it. Continue without relay.`);
  }
  let answer: Awaited<ReturnType<typeof callThroughBroker>>;
  try {
    answer = await callThroughBroker(socketPath, secret, tool, args);
  } catch (err) {
    return fail(io, `relay is not reachable from this agent: ${(err as Error).message}. Continue without relay.`);
  }
  if (answer.error) return fail(io, `relay did not run ${tool}: ${answer.error.message ?? `error ${answer.error.code ?? "without a code"}`}`);
  const text = contentText(answer.result ?? {});
  if (answer.result?.isError) return fail(io, text ? `${tool} failed: ${text}` : `${tool} failed, and said nothing more`);
  io.stdout.write(text);
  return 0;
}
