import { redact } from "./secrets.js";

/**
 * Redact only a relay review tool call's own_review argument. Ordinary data, prose and code
 * examples are not submissions. Diagnostic lines can wrap a call in a prefix or JSON quoting;
 * final replies are inspected only when the whole reply is a structured echo of a call.
 */
export function redactOwnReview(text: string, diagnostic = false): string {
  const hidden = (value: string) => /^\[own_review: \d+ chars, withheld\]$/.test(value) ? value : `[own_review: ${value.length} chars, withheld]`;
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  function submission(value: unknown, depth = 0): boolean {
    if (depth > 64) return false;
    if (typeof value === "string") {
      try { return submission(JSON.parse(value), depth + 1); } catch { return false; }
    }
    return object(value) && Object.hasOwn(value, "review_id") && Object.hasOwn(value, "own_review");
  }
  const permissionRequest = (value: unknown): boolean => object(value) && value.method === "session/request_permission"
    && object(value.params) && object(value.params.toolCall) && submission(value.params.toolCall.rawInput);
  const argumentField = (value: unknown): string | null => !object(value) ? null
    : value.type === "tool_use" && value.name === "mcp__relay__review" ? "input"
    : (value.type === "mcpToolCall" || value.type === "mcp_tool_call") && value.server === "relay" && value.tool === "review" ? "arguments"
    : (value.sessionUpdate === "tool_call" || value.sessionUpdate === "tool_call_update") && submission(value.rawInput) ? "rawInput"
    : value.tool_name === "mcp__relay__review" && Object.hasOwn(value, "tool_input") ? "tool_input" : null;
  function argument(value: unknown, depth: number): unknown {
    if (depth > 64) return value;
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value), clean = argument(parsed, depth + 1);
        return clean === parsed ? value : JSON.stringify(clean);
      } catch { return value; }
    }
    return object(value) && Object.hasOwn(value, "own_review") ? { ...value, own_review: hidden(typeof value.own_review === "string" ? value.own_review : JSON.stringify(value.own_review)) } : value;
  }
  function walk(value: unknown, depth: number, permissionParams = false): unknown {
    if (depth > 64) return value;
    if (typeof value === "string") return structured(value, depth + 1, true) ?? value;
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
    if (!object(value)) return value;
    const field = argumentField(value);
    return Object.fromEntries(Object.entries(value).map(([key, v]) => {
      if (key === field) return [key, argument(v, depth + 1)];
      // ACP permission requests carry a toolCall without sessionUpdate or necessarily a title.
      if (permissionParams && key === "toolCall" && object(v) && submission(v.rawInput)) {
        return [key, { ...v, rawInput: argument(v.rawInput, depth + 1) }];
      }
      return [key, walk(v, depth + 1, value.method === "session/request_permission" && key === "params")];
    }));
  }
  function structured(s: string, depth: number, echoOnly = false): string | null {
    if (depth > 64) return s;
    try {
      const value: unknown = JSON.parse(s);
      if ((!diagnostic || echoOnly) && typeof value !== "string" && !argumentField(value) && !permissionRequest(value)) return s;
      const clean = walk(value, depth + 1);
      return JSON.stringify(clean) === JSON.stringify(value) ? s : JSON.stringify(clean);
    } catch { return null; }
  }
  const clean = structured(text, 0);
  if (clean !== null) return clean;
  if (!diagnostic) return text;
  // Recognise complete JSON values inside stderr/error prefixes, including debug-quoted JSON.
  // No key-name regex or whole-message fallback: an unrecognised fragment stays ordinary text.
  // Bound total diagnostic scanning work, including failed candidate scans. Malformed input
  // with many unmatched openers must not repeatedly rescan an arbitrarily long suffix.
  const budget = { left: 4 * 1024 * 1024 };
  let out = "", from = 0;
  for (let i = 0; i < text.length && budget.left-- > 0; i++) {
    if (!'{["'.includes(text[i])) continue;
    const end = jsonEnd(text, i, budget);
    if (end === null) continue;
    const candidate = text.slice(i, end), redacted = structured(candidate, 0);
    if (redacted !== null && redacted !== candidate) {
      out += text.slice(from, i) + redacted;
      from = end;
    }
    // An unchanged string may just start with a stray diagnostic quote: still inspect any
    // envelope inside it. Objects and arrays have already been walked in full.
    if (redacted !== null && (redacted !== candidate || text[i] !== '"')) i = end - 1;
  }
  return out + text.slice(from);
}

/** End of a complete JSON object, array or quoted string; braces inside strings are data. */
function jsonEnd(text: string, start: number, budget: { left: number }): number | null {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length && budget.left-- > 0; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') {
        quoted = false;
        if (!depth) return i + 1;
      }
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
  }
  return null;
}

/**
 * Keep error tails only after filtering complete stderr lines, before truncation loses context:
 * a review's own_review arguments withheld, and the secrets relay knows the shape of cut
 * (secrets.ts), so that the cut at `limit` can leave neither part of a secret nor a secret whose
 * context (an Authorization header's name, say) fell before it.
 */
export function diagnosticTail(limit = 2000): { write(text: string): void; text(): string } {
  let tail = "", pending = "";
  const clean = (line: string) => redact(redactOwnReview(line, true));
  return {
    write(text) {
      pending += text;
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        tail = (tail + clean(pending.slice(0, end)) + "\n").slice(-limit);
        pending = pending.slice(end + 1);
      }
    },
    text: () => (tail + clean(pending)).slice(-limit),
  };
}
