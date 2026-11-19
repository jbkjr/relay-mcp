// Child processes in the model-free qualifier never inherit a person's home or credentials.
import fs from "node:fs";
import path from "node:path";

export const SYSTEM_PATH = `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

/** Construct, and validate even overridden paths against, this run's scratch root. */
export function scratchEnv(root, extra = {}) {
  if (!root || !path.isAbsolute(root)) throw new Error("an absolute scratch root is required");
  root = fs.realpathSync(root);
  const env = {
    PATH: SYSTEM_PATH, HOME: path.join(root, "home"), CODEX_HOME: path.join(root, "codex-home"),
    TMPDIR: path.join(root, "tmp"), RELAY_HOME: path.join(root, "relay-home"),
    RELAY_CONFIG: path.join(root, "relay-config.json"), ...extra,
  };
  for (const key of ["HOME", "CODEX_HOME", "TMPDIR", "RELAY_HOME"]) {
    const value = env[key];
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${key} must be an absolute scratch path`);
    // Check existing ancestors too: a symlink must not redirect scratch state outside the run.
    let ancestor = path.resolve(value);
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error(`${key} has no existing ancestor`);
      ancestor = parent;
    }
    const inside = (p) => p === root || p.startsWith(`${root}${path.sep}`);
    if (!inside(path.resolve(value)) || !inside(fs.realpathSync(ancestor))) throw new Error(`${key} escapes scratch root`);
    fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  }
  return env;
}
