// Whether a script module is the one node was started with.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when `metaUrl` (the caller's import.meta.url) is the script node was started with, by any
 * path. Node gives import.meta.url as the file's real path, so argv[1] is compared by its realpath:
 * started through a symlinked path (macOS's /tmp included), a plain comparison is false and the
 * script exits 0 having done nothing; `file://${argv[1]}` also misses a path with a space.
 */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return metaUrl === pathToFileURL(fs.realpathSync(argv1)).href; } catch { return false; }
}
