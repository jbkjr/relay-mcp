import { parse, TomlError } from "smol-toml";

const RELAY_BLOCK_COMMENT = "# Deciding a launched agent's approval request";
/** The only spelling of relay's table headers that relay writes, and so the only one it removes. */
const RELAY_HEADER = /^\s*\[mcp_servers\.relay(?:\.[^\]]*)?\]\s*(?:#.*)?$/;

export type TomlData = Record<string, unknown>;
export type Edit = { ok: true; text: string } | { ok: false; reason: string };

/** Lines with their own endings attached, so that a line relay does not touch stays byte for byte what it was. */
const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const body = (line: string) => line.replace(/\r?\n$/, "");
const blank = (line: string) => /^\s*$/.test(body(line));

/** The line ending most of the file uses; relay's own lines are written with it. */
function eolOf(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Removes every [mcp_servers.relay…] table, line by line. Comments and blank lines sitting
 * directly above the next table belong to that table and are kept, as is anything after relay's
 * last key at the end of the file. A blank line that only set relay's block apart goes with it.
 */
function stripLines(lines: string[]): string[] {
  const out: string[] = [];
  let held: string[] = [];
  let inRelay = false;
  // Lines that followed relay's tables are put back without doubling the blank line before them.
  const keep = (ls: string[]) => {
    for (const l of ls) if (!(blank(l) && (!out.length || blank(out[out.length - 1])))) out.push(l);
  };
  for (const line of lines) {
    const text = body(line);
    if (/^\s*\[/.test(text)) {
      const relay = RELAY_HEADER.test(text);
      if (inRelay && !relay) keep(held);
      else if (!inRelay && relay) while (out.length && body(out[out.length - 1]).startsWith(RELAY_BLOCK_COMMENT)) out.pop();
      held = [];
      inRelay = relay;
      if (!relay) out.push(line);
    } else if (!inRelay) {
      out.push(line);
    } else if (/^\s*(#.*)?$/.test(text)) {
      if (!text.startsWith(RELAY_BLOCK_COMMENT)) held.push(line);
    } else {
      held = [];
    }
  }
  if (inRelay) {
    const comments = held.some((l) => !blank(l));
    keep(held);
    if (!comments && out.length && blank(out[out.length - 1])) out.pop();
  }
  return out;
}

export function readToml(text: string): { ok: true; data: TomlData } | { ok: false; error: string } {
  try {
    // Integers too large for a JavaScript number are valid TOML; they must not make the file unreadable.
    return { ok: true, data: parse(text, { integersAsBigInt: "asNeeded" }) as TomlData };
  } catch (err) {
    if (err instanceof TomlError) return { ok: false, error: `line ${err.line}, column ${err.column}: ${err.message.split("\n")[0]}` };
    return { ok: false, error: (err as Error).message };
  }
}

export const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** The mcp_servers.relay table of a parsed config, however it was written; undefined if there is none. */
export function relayServer(data: TomlData): unknown {
  return isTable(data.mcp_servers) ? data.mcp_servers.relay : undefined;
}

/** A plain, key-sorted form in which two parsed documents can be compared exactly. */
function canon(v: unknown): unknown {
  if (typeof v === "bigint") return { "\u0000int": v.toString() };
  if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0) ? v : { "\u0000float": Object.is(v, -0) ? "-0" : String(v) };
  // A TOML date prints in the form it was written, so a local date and a date-time stay distinct.
  if (v instanceof Date) return { "\u0000date": v.toISOString() };
  if (Array.isArray(v)) return v.map(canon);
  if (isTable(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

export function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** Where a relay entry is written in a way relay will not edit, for the message that says so. */
function unusualForms(text: string): string[] {
  const key = (name: string) => `(?:${name}|"${name}"|'${name}')`;
  const servers = new RegExp(`^\\s*\\[\\s*${key("mcp_servers")}\\s*\\]`);
  const header = new RegExp(`^\\s*\\[\\[?\\s*${key("mcp_servers")}\\s*\\.\\s*${key("relay")}\\s*[.\\]]`);
  const dotted = new RegExp(`^\\s*${key("mcp_servers")}\\s*\\.\\s*${key("relay")}\\s*[.=]`);
  const inline = new RegExp(`^\\s*${key("mcp_servers")}\\s*=`);
  const child = new RegExp(`^\\s*${key("relay")}\\s*[.=]`);
  const found: string[] = [];
  let inServers = false;
  splitLines(text).forEach((line, i) => {
    const t = body(line);
    if (/^\s*\[/.test(t)) inServers = servers.test(t);
    if ((header.test(t) && !RELAY_HEADER.test(t)) || dotted.test(t) || inline.test(t) || (inServers && child.test(t))) found.push(`line ${i + 1}: ${t.trim()}`);
  });
  return found.slice(0, 8);
}

/**
 * Replaces relay's block in a Codex config, or removes it when block is null, and proves the
 * result before anyone writes it: the new text must parse, mcp_servers.relay must be exactly
 * what the block says (or gone), and every other setting must be what it was. Anything else is
 * a refusal with the reason, and the caller writes nothing.
 */
export function editCodexConfig(current: string, block: string | null): Edit {
  const before = readToml(current);
  if (!before.ok) return { ok: false, reason: `it does not parse as TOML (${before.error})` };
  const bom = current.startsWith("\uFEFF") ? "\uFEFF" : "";
  const eol = eolOf(current);
  // With no relay entry there is nothing to take out, and so no line of the file to touch.
  let text = current.slice(bom.length);
  if (relayServer(before.data) !== undefined) text = stripLines(splitLines(text)).join("");

  const stripped = readToml(text);
  if (stripped.ok && relayServer(stripped.data) !== undefined) {
    const where = unusualForms(current.slice(bom.length));
    return {
      ok: false,
      reason: "it defines mcp_servers.relay in a form relay does not edit: a quoted or spaced table name, an inline table, or dotted keys. "
        + "Relay only removes tables written as [mcp_servers.relay] and [mcp_servers.relay.<name>]. Remove that definition by hand, then run this again."
        + (where.length ? `\n  Look at:\n${where.map((w) => `    ${w}`).join("\n")}` : ""),
    };
  }

  let intended: unknown;
  if (block !== null) {
    const parsed = readToml(block);
    intended = parsed.ok ? relayServer(parsed.data) : undefined;
    if (intended === undefined) return { ok: false, reason: "relay's own block does not parse; this is a bug in relay" };
    if (text && !text.endsWith("\n")) text += eol;
    if (text) text += eol;
    text += block.replace(/\r?\n/g, eol);
  }
  text = bom + text;

  const after = readToml(text);
  const unsafe = "relay's line-by-line edit would not leave the file as intended, so it was not made and has to be made by hand";
  if (!after.ok) return { ok: false, reason: `${unsafe} (the result would not parse: ${after.error})` };
  const want = canon(before.data) as Record<string, unknown>;
  const got = canon(after.data) as Record<string, unknown>;
  if (isTable(want.mcp_servers) || block !== null) {
    const servers = { ...(isTable(want.mcp_servers) ? want.mcp_servers : {}) };
    delete servers.relay;
    if (block !== null) servers.relay = intended;
    want.mcp_servers = servers;
  }
  // A table that is empty and a table that is not there mean the same thing to Codex.
  for (const doc of [want, got]) if (isTable(doc.mcp_servers) && !Object.keys(doc.mcp_servers).length) delete doc.mcp_servers;
  if (JSON.stringify(canon(want)) !== JSON.stringify(canon(got))) return { ok: false, reason: `${unsafe} (settings other than mcp_servers.relay would change)` };
  return { ok: true, text };
}
