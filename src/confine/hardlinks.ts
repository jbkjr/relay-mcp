import fs from "node:fs";
import path from "node:path";
import { within } from "./paths.js";

/**
 * The hard-link check. Seatbelt decides by path, so a regular file in a writable directory that also
 * has a name the turn may not write (outside every writable directory, or at a path the profile
 * hard-denies, such as the worktree's `.git` pointer or a denied directory) writes through to that
 * inode, whatever the profile says. `git worktree add` never makes such links, but a package
 * manager's store (pnpm) or a user can. Relay refuses a confined turn when it finds one.
 *
 * Every writable directory is walked with plain `fs`: directories from their dirents without a stat,
 * symlinks never followed, a stat only for regular files, and the hard-denied paths neither walked
 * nor counted. An inode passes when all its names were found in writable places.
 */

export interface HardLinkReport {
  /** Regular files with a name outside the writable places, up to the limit asked for. */
  linked: string[];
  /** Regular files looked at. */
  files: number;
  ms: number;
}

/**
 * `roots`: the turn's writable directories (resolved). `denied`: resolved paths the profile
 * hard-denies inside them (files or directories); names there count as outside.
 */
export function hardLinksOutside(roots: string[], opts: { denied?: string[]; limit?: number } = {}): HardLinkReport {
  const started = performance.now();
  const limit = opts.limit ?? 1;
  const all = [...new Set(roots)];
  const denied = opts.denied ?? [];
  // A root inside another is walked as part of it.
  const tops = all.filter((r) => !all.some((o) => o !== r && within(r, o)));
  const multi = new Map<string, { names: Set<string>; nlink: number }>();
  let files = 0;
  const stack = [...tops];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // A directory that vanished mid-walk is no link; anything else stops the check.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (denied.some((d) => within(p, d))) continue;
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!e.isFile()) continue;
      files++;
      const st = fs.lstatSync(p, { bigint: true });
      if (st.nlink <= 1n) continue;
      const key = `${st.dev}:${st.ino}`;
      const seen = multi.get(key) ?? { names: new Set<string>(), nlink: Number(st.nlink) };
      seen.names.add(p);
      multi.set(key, seen);
    }
  }
  const linked: string[] = [];
  for (const { names, nlink } of multi.values()) {
    if (names.size < nlink) linked.push([...names].sort()[0]);
    if (linked.length >= limit) break;
  }
  return { linked: linked.sort(), files, ms: Math.round(performance.now() - started) };
}
