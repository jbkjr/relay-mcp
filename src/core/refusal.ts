/** A vendor safety stop, distinct from a tool permission denial or an operational failure. */
export interface VendorRefusal {
  vendor: "openai" | "anthropic";
  message: string;
  code: string;
}

export const REFUSAL_POLICY = "Relay neither retried nor rephrased the request, switched models, nor used a fallback target. A caller may explicitly resume the session.";
export const refusalNote = (r: VendorRefusal): string =>
  `Stopped by ${r.vendor === "openai" ? "OpenAI" : "Anthropic"}'s safety system. ${REFUSAL_POLICY}`;

/**
 * Observed in j_9b6a622c's app-server log (cyberPolicy), and the 2026-10-19
 * red-team exec records (message only). Keep the text match narrow: capacity, authentication,
 * crashes and an agent merely discussing safety are not refusals. No other OpenAI codes or
 * ACP refusal shapes have been verified; do not infer them from arbitrary error prose.
 */
export function openaiRefusal(error: unknown): VendorRefusal | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { message?: unknown; codexErrorInfo?: unknown };
  if (typeof e.message !== "string") return undefined;
  if (e.codexErrorInfo === "cyberPolicy" || (e.codexErrorInfo === undefined && e.message.startsWith("This content was flagged for possible cybersecurity risk."))) {
    return { vendor: "openai", message: e.message, code: "cyberPolicy" };
  }
  return undefined;
}

export const refusalError = (r: VendorRefusal): string =>
  `Stopped by ${r.vendor === "openai" ? "OpenAI" : "Anthropic"}'s safety system: ${r.message || `the vendor reported ${r.code} without a message`}`;

/** Source-derived from Claude Code 2.1.302; see test/fixtures/refusals/README.md. */
export function anthropicRefusal(event: Record<string, unknown>): VendorRefusal | undefined {
  const message = event.message as { stop_reason?: unknown; content?: unknown } | undefined;
  if (event.type === "assistant" && message?.stop_reason === "refusal") {
    const text = (Array.isArray(message.content) ? message.content : []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
    return { vendor: "anthropic", code: "refusal", message: text };
  }
  if (event.type === "result" && event.stop_reason === "refusal") {
    const text = typeof event.result === "string" ? event.result : Array.isArray(event.errors) ? event.errors.filter((e) => typeof e === "string").join("; ") : "";
    return { vendor: "anthropic", code: "refusal", message: text };
  }
  return undefined;
}
