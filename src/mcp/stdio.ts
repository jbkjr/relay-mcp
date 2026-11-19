import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Readable, Writable } from "node:stream";

/** The SDK resolves send on buffer acceptance. Event delivery needs the completed write. */
export class RelayStdioTransport extends StdioServerTransport {
  constructor(input: Readable = process.stdin, private output: Writable = process.stdout) {
    super(input, output);
  }

  override send(message: JSONRPCMessage): Promise<void> {
    const line = serializeMessage(message);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.output.off("close", closed);
        this.output.off("error", failed);
      };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const closed = () => failed(new Error("Output closed before reply was written"));
      this.output.once("close", closed);
      this.output.once("error", failed);
      try {
        this.output.write(line, error => {
          // Keep the error listener until the stream emits the error after this callback.
          if (error) reject(error);
          else { cleanup(); resolve(); }
        });
      } catch (error) { failed(error as Error); }
    });
  }
}
