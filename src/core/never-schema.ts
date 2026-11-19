import net from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";

export const NEVER_VERSION = 1;
export const NEVER_BUILTIN_IDS = ["credentials.files", "credentials.relay-codex-home", "credentials.keychain", "service.sshd", "service.screen-sharing", "relay.config", "relay.install", "relay.authority"] as const;
export type NeverBuiltinId = typeof NEVER_BUILTIN_IDS[number];
/**
 * Built-in ids relay no longer has (relay 1.2.1 keeps only macOS's own services as built-in ports).
 * An override naming one is still accepted throughout 1.x (docs/stable-surfaces.md, deprecation
 * policy), removes nothing, and config load and doctor warn about it.
 */
export const NEVER_RETIRED_BUILTIN_IDS = ["service.proton-bridge", "service.mcp-gateway"] as const;
export const NEVER_IMMUTABLE_IDS = ["relay.config", "relay.install", "relay.authority"] as const;

/** Canonical exact authority only. URL parsing is deliberately separate from config parsing. */
export function normalizeNeverHost(value: string): string {
  if (!value || value.trim() !== value || /[\s\/@?#%*\\\[\]]/.test(value)) throw new Error("never host must be an exact DNS authority or IP literal, without URL, zone or pattern");
  const ip = net.isIP(value);
  if (ip === 4) return value;
  if (ip === 6) {
    const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
    // Include IPv4-compatible and translated spellings accepted by the host stack.
    const mapped = /^::(?:ffff:(?:0:)?)?([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
    if (mapped) { const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16); return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
    return normalized;
  }
  if (value.includes(":")) throw new Error("never host cannot include a port");
  const host = domainToASCII(value.replace(/\.$/, "")).toLowerCase();
  if (!host || host.length > 253 || !host.split(".").every(l => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(l))) throw new Error("invalid never host");
  // WHATWG accepts legacy integer, octal and shortened IPv4. Refuse those ambiguous spellings.
  const parsed = new URL(`http://${host}/`).hostname;
  if (net.isIP(parsed)) throw new Error("use a canonical IP literal for a never host");
  return host;
}

export const neverLiteralPath = (p: string): boolean => Boolean(p) && p.trim() === p && (p.startsWith("/") || p.startsWith("~/"))
  && !/[\x00-\x1f\x7f*?\[\]{}$`\\]/.test(p) && !p.split("/").some(part => part === "." || part === "..");

export const NeverConfigSchema = z.object({
  paths: z.array(z.object({ path: z.string().refine(neverLiteralPath, "must be a literal absolute path or ~/ path, without traversal or expansion"), access: z.enum(["all", "write"]).default("all") }).strict()).default([]),
  ports: z.array(z.object({ port: z.number().int().min(1).max(65535), transport: z.enum(["tcp", "udp", "both"]).default("both"), destinations: z.enum(["this-machine", "any"]).default("any") }).strict()).default([]),
  hosts: z.array(z.string().refine(h => { try { normalizeNeverHost(h); return true; } catch { return false; } }, "must be an exact DNS authority or IP literal")).default([]),
  override_builtin: z.array(z.object({
    id: z.enum([...NEVER_BUILTIN_IDS, ...NEVER_RETIRED_BUILTIN_IDS]), acknowledge: z.string(), reason: z.string().trim().min(1),
  }).strict().superRefine((v, ctx) => {
    if ((NEVER_IMMUTABLE_IDS as readonly string[]).includes(v.id)) ctx.addIssue({ code: "custom", message: `${v.id} is non-removable` });
    if (v.acknowledge !== `REMOVE BUILT-IN NEVER ${v.id}`) ctx.addIssue({ code: "custom", message: "requires exact REMOVE BUILT-IN NEVER <id> acknowledgment" });
  })).default([]),
}).strict();
export type NeverConfig = z.input<typeof NeverConfigSchema>;
