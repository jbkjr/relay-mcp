import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "../core/context.js";
import { newInstance } from "../core/caller.js";
import { ancestors, getNode, getRun, getTurn, workCwd } from "../core/db.js";
import { relayServer } from "../mcp/server.js";
import { overlayTurnProblem } from "../core/restart-overlay.js";
import { escalationTurnClosing } from "../core/escalations.js";

export const TURN_ENDED = -32001;
/** As on the stdio front, one message is bounded to 8 MiB. */
export const MAX_MESSAGE = 8 * 1024 * 1024;

/** The turn a broker serves. Everything else comes from the worker's registry. */
export interface BrokerTurn {
  nodeId: string;
  turnId: number;
  /** Whether this turn may start agents, as the worker decided. */
  mayDelegate: boolean;
  /** Whether this turn may ask for approval through relay. */
  mayAsk: boolean;
}

export function turnRefusal(turn: Pick<BrokerTurn, "nodeId" | "turnId">): string | null {
  const t = getTurn(turn.turnId);
  if (!t || t.node_id !== turn.nodeId) return "this agent's turn is not in the relay registry.";
  if (t.status !== "running") return `the relay turn this agent was started for has ended (${t.status}). Continue without relay.`;
  if (escalationTurnClosing(turn.nodeId, turn.turnId)) return "this turn is closing for an approved escalation; no further work is admitted.";
  const node = getNode(turn.nodeId);
  if (!node || getRun(node.run_id)?.status === "cancelled") return "this agent's run has been cancelled.";
  if (ancestors(node, { self: true }).some((n) => n.status === "cancelled")) return "this agent's work has been cancelled.";
  return overlayTurnProblem(turn.nodeId, turn.turnId);
}

/** Authority comes from the registry, never a context supplied over the connection. */
export function turnContext(turn: BrokerTurn): Extract<Context, { kind: "child" }> & { cwd: string } {
  const t = getTurn(turn.turnId);
  const node = getNode(turn.nodeId);
  if (!t || !node || t.node_id !== node.id) throw new Error(`turn ${turn.turnId} of ${turn.nodeId} is not in the registry`);
  if (t.access !== "read" && t.access !== "write") throw new Error(`turn ${turn.turnId} has no access mode`);
  return {
    kind: "child", runId: node.run_id, nodeId: node.id, depth: node.depth,
    turnId: t.id, access: t.access, mayDelegate: turn.mayDelegate, mayAsk: turn.mayAsk, cwd: workCwd(node),
  };
}

/** Same MCP server, fresh owner token per Unix connection or HTTP MCP session. */
export function brokerCore(turn: BrokerTurn, opts: Parameters<typeof relayServer>[1] = {}) {
  const { cwd, ...ctx } = turnContext(turn);
  const refusal = () => turnRefusal(turn);
  const why = refusal();
  if (why) throw new Error(`no broker for a turn that is not live: ${why}`);
  const serve = () => relayServer(newInstance(ctx, cwd), opts);
  return {
    refusal, serve,
    async listTools(): Promise<Tool[]> {
      const why = refusal();
      if (why) throw new Error(`relay cannot list this turn's tools: ${why}`);
      const [near, far] = InMemoryTransport.createLinkedPair();
      const mcp = serve();
      const client = new Client({ name: "relay-tool-list", version: "1" });
      try {
        await mcp.connect(far);
        await client.connect(near);
        if (!client.getServerCapabilities()?.tools) return [];
        const tools: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        return tools;
      } finally {
        await client.close().catch(() => {});
        await mcp.close().catch(() => {});
      }
    },
  };
}
