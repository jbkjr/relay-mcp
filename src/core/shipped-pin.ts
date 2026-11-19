// A release's shipped Codex pin (decision 18): `codex-pin.json` at relay's package root, written by
// the maintainer's qualification (scripts/codex-qualify/codex-shipped-pin.mjs writeShippedPin, from
// a passing local qualification only) and packed with the release. It is portable by construction:
// it holds the Codex release (version and npm's sha512 integrity, which fixes every byte of the
// binary) and relay's build identity (src/core/build-identity.ts), and nothing else. No path, user,
// host, time or machine detail is allowed; a manifest with any other field is refused, not trimmed.
// Relay accepts it only for exactly that relay build and runs only a Codex whose download matched
// that integrity (src/backends/codex-pin.ts). What it does not carry is the maintainer's machine:
// the trust is the maintainer's qualification on the maintainer's Mac (README, Security model).
import fs from "node:fs";
import path from "node:path";
import { BUILD_SCHEME, LEGACY_BUILD_SCHEMES, isBuildIdentity, type BuildIdentity } from "./build-identity.js";

export const SHIPPED_PIN_FILE = "codex-pin.json";
export const SHIPPED_PIN_FORMAT = "relay-shipped-codex-pin-v1";

export interface ShippedPin {
  format: typeof SHIPPED_PIN_FORMAT;
  codex: { version: string; npmIntegrity: string };
  relay: BuildIdentity;
}

const exactKeys = (value: unknown, keys: string[]): boolean =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** The manifest, deeply frozen, or throws saying what is wrong. Any field beyond the format is refused. */
export function parseShippedPin(value: unknown): ShippedPin {
  const v = value as ShippedPin;
  if (!exactKeys(v, ["format", "codex", "relay"])) throw new Error("a shipped Codex pin has exactly format, codex and relay, and nothing else");
  if (v.format !== SHIPPED_PIN_FORMAT) throw new Error(`unknown shipped Codex pin format ${JSON.stringify(v.format)}`);
  if (!exactKeys(v.codex, ["version", "npmIntegrity"]) || !/^\d+\.\d+\.\d+$/.test(v.codex.version) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(v.codex.npmIntegrity)) throw new Error("a shipped Codex pin's codex is exactly a stable version and npm's sha512 integrity");
  if (exactKeys(v.relay, ["scheme", "version", "sha256"]) && LEGACY_BUILD_SCHEMES.includes(v.relay.scheme)) {
    throw new Error(`a shipped Codex pin names relay's build under ${v.relay.scheme}, which does not cover relay's dependency lock; this relay matches only ${BUILD_SCHEME}, so the release must be qualified again`);
  }
  if (!exactKeys(v.relay, ["scheme", "version", "sha256"]) || !isBuildIdentity(v.relay)) throw new Error("a shipped Codex pin's relay is exactly relay's build identity (scheme, version, sha256)");
  return Object.freeze({ format: v.format, codex: Object.freeze({ ...v.codex }), relay: Object.freeze({ ...v.relay }) });
}

/** The shipped pin in relay's package at `root`; null when this relay ships none (a git checkout never does). Throws on a present but invalid one. */
export function readShippedPin(root: string): ShippedPin | null {
  let text: string;
  try { text = fs.readFileSync(path.join(root, SHIPPED_PIN_FILE), "utf8"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  return parseShippedPin(JSON.parse(text));
}

export const sameShippedPin = (a: ShippedPin, b: ShippedPin): boolean =>
  a.format === b.format && a.codex.version === b.codex.version && a.codex.npmIntegrity === b.codex.npmIntegrity &&
  a.relay.scheme === b.relay.scheme && a.relay.version === b.relay.version && a.relay.sha256 === b.relay.sha256;
