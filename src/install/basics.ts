// The two things every relay command may need, kept apart from install and doctor so that the CLI
// can report its version or a usage mistake without loading either (or the registry, or zod).
import fs from "node:fs";
import path from "node:path";

/** A mistake in how relay was called: said on stderr, with exit code 2. */
export function usageError(message: string): void {
  console.error(message);
  process.exitCode = 2;
}

/** Relay's version, from the package.json of this checkout (two levels above dist/install). */
export function relayVersion(): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8")).version);
  } catch {
    return "unknown";
  }
}
