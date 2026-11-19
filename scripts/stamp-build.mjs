// Run by `npm run build` after the compiler: writes dist/build-info.json, the commit the build was
// made from, so that `relay doctor` can say when the checkout has moved on since. A pull, or a
// fast-forward by a sync job, changes the sources but never rebuilds dist/.
//
//   node scripts/stamp-build.mjs [<checkout>]     (default: the checkout this script is in)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = fs.realpathSync(path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "..")));
// git by its absolute name on PATH, as relay runs it (dist/core/executables.js, which the compiler has just written).
const { findExecutable } = await import(path.join(import.meta.dirname, "..", "dist", "core", "executables.js"));
const gitBin = findExecutable("git");
const git = (args) => {
  if (!gitBin) return null;
  const r = spawnSync(gitBin, ["-C", root, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

// Only the checkout's own commit counts: a copy unpacked inside some other repository is not built from that repository's HEAD.
const top = git(["rev-parse", "--show-toplevel"]);
const own = top !== null && real(top) === root;
const commit = own ? git(["rev-parse", "--verify", "-q", "HEAD"]) : null;
// Untracked files count: a new file under src/ is compiled like any other.
const status = commit ? git(["status", "--porcelain"]) : null;
const info = { commit, dirty: status === null ? null : status !== "", built_at: new Date().toISOString() };

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
