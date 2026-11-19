// The gateway (docs/extensions.md): in the relay server of a launched agent's turn given MCP
// servers, relay starts each server as its own client and offers the server's tools as its own,
// named <server>__<tool>. The harness allows relay's tools without asking (Claude's
// --allowedTools mcp__relay, Codex's approve mode on relay's entry), so every call reaches relay,
// which forwards it only if the config allows that tool outright or the person allows the call.
// No server is ever configured in the harness itself, so the harness's own MCP approval handling
// (unqualified for Codex) decides nothing.
import fs from "node:fs";
import os from "node:os";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { expandHome, relayHome, VERSION } from "../core/config.js";
import { ownManifest, readMcpFile, type GatewayManifest } from "../core/extensions.js";
import { checkpointNever } from "../core/never-checkpoint.js";
import { neverDigest, type NeverPolicy } from "../core/never-policy.js";
import { extensionToolProblem, neverToolAdapters, screenExtensionCall, type ExtensionToolIdentity, type NeverToolScreenResult, type QualifiedToolAdapter } from "../core/never-tools.js";

/** A tool the gateway offers: its name on relay's server, its server's client, and what relay needs to forward a call. */
interface Offered {
  identity: ExtensionToolIdentity;
  name: string;
  server: string;
  tool: string;
  description: string;
  schema: z.ZodObject;
  annotations?: Record<string, unknown>;
  /** The config allows it outright (allow_tools): it runs without asking. */
  preauthorized: boolean;
  client: Client;
}

export interface Gateway {
  tools: Offered[];
  /** What could not be started or offered, for the turn's result. */
  warnings: string[];
  /** Mandatory, called before approval and again immediately before invocation. */
  screen(tool: Offered, args: Record<string, unknown>): Promise<NeverToolScreenResult>;
  close(): Promise<void>;
}

/** How long the gateway waits for its servers before the agent's relay server answers the harness: under both harnesses' startup timeouts (30 s). */
const START_MS = 20_000;
/** A name on relay's server, as both harnesses take tool names. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * Starts the servers a turn's manifest names and lists their tools. A server that cannot be
 * started, or a tool relay cannot pass on (a name or an input schema it cannot offer as given),
 * is left out and reported, never offered in some other form. The report goes beside the
 * manifest, for the worker to put in the turn's result.
 */
export async function openGateway(manifestFile: string, suppliedCatalog?: readonly QualifiedToolAdapter[]): Promise<Gateway> {
  const warnings: string[] = [];
  const tools: Offered[] = [];
  const clients: Client[] = [];
  const close = async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  };
  let manifest: GatewayManifest;
  let policy: NeverPolicy | undefined;
  let catalog: readonly QualifiedToolAdapter[] = suppliedCatalog ?? [];
  const screen: Gateway["screen"] = async (tool, args) => {
    try {
      if (!manifest.run_id) throw new Error("gateway has no trusted run binding");
      const current = checkpointNever(manifest.run_id, "tool");
      return await screenExtensionCall(current, tool.identity, args, catalog);
    } catch (err) { return { allow: false, reason: `never: ${(err as Error).message}`, policyHash: policy?.hash ?? "unavailable" }; }
  };
  try {
    // Only a manifest relay wrote, in its control directory, which no agent can write.
    if (!ownManifest(manifestFile, relayHome())) throw new Error("it is not in relay's control directory");
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as GatewayManifest;
  } catch (err) {
    return { tools, warnings: [`relay could not read the turn's list of MCP servers (${(err as Error).message}), so none of them is offered`], close, screen };
  }
  const report = () => {
    try {
      fs.writeFileSync(manifest.report, JSON.stringify({ started: [...new Set(tools.map((t) => t.server))], tools: tools.map((t) => t.name), warnings }, null, 2));
    } catch {
      // The result then says nothing about it; the agent sees the tools it has.
    }
  };
  let defs: ReturnType<typeof readMcpFile>;
  try {
    if (!manifest.run_id) throw new Error("never withholds extension tools without a trusted run binding");
    policy = checkpointNever(manifest.run_id, "tool");
    defs = readMcpFile(manifest.mcp_file);
    catalog = suppliedCatalog ?? await neverToolAdapters(defs);
  } catch (err) {
    warnings.push(`${(err as Error).message}, so none of the job's MCP servers is offered`);
    report();
    return { tools, warnings, close, screen };
  }
  // The servers get the agent's relay server's environment (the agent's, as its harness passes it
  // on), without relay's own identity, plus their own variables.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("RELAY_"))) as Record<string, string>;
  // The SDK's client is loaded here, by the one kind of server that uses it, rather than by every
  // relay server at start. A failure to load it fails this server's start, as it did before.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const deadline = Date.now() + START_MS;
  await Promise.all(manifest.servers.map(async (s) => {
    const def = defs[s.name];
    if (!def) return void warnings.push(`the MCP server ${s.name} is no longer defined in ${manifest.mcp_file}; its tools are not offered`);
    const definitionHash = neverDigest(def);
    if (!catalog.some(a => a.identity.server === s.name && a.identity.definitionHash === definitionHash)) {
      warnings.push(`never withholds every tool of ${s.name}: no qualified effects adapter for this server definition; opaque/implicit effects cannot be person-approved`);
      return;
    }
    const client = new Client({ name: "relay", version: VERSION });
    try {
      // Started in its own directory or the home folder, never the agent's: a file the agent wrote there must not steer it.
      const transport = new StdioClientTransport({
        command: expandHome(def.command), args: def.args ?? [], env: { ...base, ...(def.env ?? {}) }, cwd: def.cwd ? expandHome(def.cwd) : os.homedir(), stderr: "ignore",
      });
      clients.push(client);
      await withTimeout(client.connect(transport), Math.max(1, deadline - Date.now()), "starting it");
      const listed: { name: string; description?: string; inputSchema: unknown; annotations?: Record<string, unknown> }[] = [];
      for (let cursor: string | undefined, pages = 0; pages < 20; pages++) {
        const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), Math.max(1, deadline - Date.now()), "listing its tools");
        listed.push(...(page.tools as typeof listed));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      for (const t of listed) {
        const identity: ExtensionToolIdentity = { server: s.name, version: client.getServerVersion()?.version ?? "", definitionHash, tool: t.name, schemaHash: neverDigest(t.inputSchema) };
        const problem = extensionToolProblem(identity, catalog);
        if (problem) { warnings.push(problem); continue; }
        const name = `${s.name}__${t.name}`;
        if (tools.some((o) => o.name === name)) {
          warnings.push(`the tool ${t.name} of ${s.name} is listed more than once; relay offers the first`);
          continue;
        }
        if (!TOOL_NAME.test(name)) {
          warnings.push(`the tool ${t.name} of ${s.name} is not offered: ${name} is not a name relay can give a tool`);
          continue;
        }
        let schema: z.ZodType;
        try {
          schema = z.fromJSONSchema(t.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
        } catch (err) {
          warnings.push(`the tool ${t.name} of ${s.name} is not offered: relay cannot check its input schema (${String((err as Error).message).slice(0, 80)})`);
          continue;
        }
        if (!(schema instanceof z.ZodObject)) {
          warnings.push(`the tool ${t.name} of ${s.name} is not offered: its input schema is not an object`);
          continue;
        }
        tools.push({
          identity,
          name, server: s.name, tool: t.name, description: t.description ?? "", schema, preauthorized: s.allow_tools.includes(t.name), client,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        });
      }
      const unknown = s.allow_tools.filter((a) => !listed.some((t) => t.name === a));
      if (unknown.length) warnings.push(`${s.name} has no tool ${unknown.join(", ")}, which its allow_tools names`);
    } catch (err) {
      warnings.push(`the MCP server ${s.name} could not be started (${String((err as Error).message).slice(0, 160)}); its tools are not offered`);
      await client.close().catch(() => {});
    }
  }));
  tools.sort((a, b) => a.name.localeCompare(b.name));
  report();
  return { tools, warnings, close, screen };
}

/** How relay asks the person about one call, and what came of it. */
export type AskCall = (o: { server: string; tool: string; summary: string }, extra: { signal?: AbortSignal; onTick?: (ms: number) => void }) => Promise<{ allow: boolean; note?: string }>;

/**
 * Offers the gateway's tools on relay's server. A call's arguments are checked against the tool's
 * input schema first (the SDK does it, refusing malformed ones before the handler runs, so nobody
 * is asked about them), then put to the person unless the tool runs without asking, then forwarded
 * with exactly the arguments shown. A name relay did not list is an error and reaches no server.
 * `over` says why the turn can no longer act (it has ended, or its work was cancelled), or null:
 * once it is over no call is forwarded, one that runs without asking included, and nobody is asked.
 */
export function offerGateway(server: McpServer, gw: Gateway, ask: AskCall, tick: (extra: unknown) => ((ms: number) => void) | undefined, over: () => string | null): void {
  const ended = (why: string): CallToolResult => ({ content: [{ type: "text", text: `Not forwarded: the turn that called it is over (${why}).` }], isError: true });
  for (const t of gw.tools) {
    const how = t.preauthorized ? "runs without asking the user" : "each call waits for the user's yes";
    server.registerTool(t.name, {
      description: `${t.description}${t.description ? " " : ""}[MCP server ${t.server}, through relay: ${how}.]`,
      inputSchema: t.schema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }, async (args: Record<string, unknown>, extra): Promise<CallToolResult> => {
      const signal = (extra as { signal?: AbortSignal }).signal;
      const gone = over();
      if (gone) return ended(gone);
      const blocked = (why: string): CallToolResult => ({ content: [{ type: "text", text: `Not forwarded: ${why}` }], isError: true });
      const first = await gw.screen(t, args);
      if (!first.allow) return blocked(first.reason);
      if (!t.preauthorized) {
        const summary = `${t.server}.${t.tool} ${JSON.stringify(args)}`;
        const answer = await ask({ server: t.server, tool: t.tool, summary }, { signal, onTick: tick(extra) });
        if (!answer.allow) {
          return { content: [{ type: "text", text: `Not approved${answer.note ? ` (${answer.note})` : ""}. Do not try to reach ${t.server} another way; continue without it and say what you needed.` }], isError: true };
        }
        // Allowed, but the turn may have ended while the person was deciding.
        const late = over();
        if (late) return ended(late);
      }
      // Consent and preauthorization never bypass semantic policy. Reload at invocation, after
      // any approval wait, and invalidate changed effects rather than silently rewriting consent.
      const checked = await gw.screen(t, args);
      if (!checked.allow) return blocked(checked.reason);
      if (neverDigest(first.arguments) !== neverDigest(checked.arguments)) return blocked("never: effective tool arguments changed while approval was pending; ask again");
      const late = over();
      if (late) return ended(late);
      try {
        return (await t.client.callTool({ name: t.tool, arguments: checked.arguments }, undefined, { signal, timeout: 3_600_000, resetTimeoutOnProgress: true })) as CallToolResult;
      } catch (err) {
        return { content: [{ type: "text", text: `${t.server} did not complete the call: ${String((err as Error).message).slice(0, 300)}` }], isError: true };
      }
    });
  }
}
