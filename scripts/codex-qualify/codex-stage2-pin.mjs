// Provisional pins for the model-free qualifier only. These are never published or promoted:
// qualification must exercise Relay's pinned path before the candidate has a passing verdict.
import fs from "node:fs";
import path from "node:path";
import { atomicJson, sha256, TEAM_ID, validateManifest } from "./codex-pin-store.mjs";
import { scratchEnv } from "./scratch-env.mjs";

/** Stage the supplied executable (not an installed/current pin) in a fresh scratch store. */
export function stageQualificationPin({ scratch, bin, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("candidate must be stable semver");
  const env = scratchEnv(scratch);
  const home = path.join(env.HOME, ".local/share/relay-codex-home");
  const store = path.join(env.HOME, ".local/share/relay-codex-pins");
  // Validate existing ancestors before creating anything beneath them. A stale scratch symlink
  // must not redirect a write to a person's home or pin store.
  scratchEnv(scratch, { CODEX_HOME: home });
  scratchEnv(scratch, { CODEX_HOME: path.dirname(store) });
  fs.mkdirSync(store, { mode: 0o700 }); // Deliberately refuse reuse, including symlink aliases.
  const source = fs.realpathSync(bin);
  const binarySha256 = sha256(source);
  const target = `versions/${version}-${binarySha256.slice(0, 12)}`;
  const dir = path.join(store, target);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true, mode: 0o700 });
  const copy = (from, to) => { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, 0o555); };
  const stagedBin = path.join(dir, "bin/codex");
  copy(source, stagedBin);
  if (sha256(stagedBin) !== binarySha256) throw new Error("candidate changed while staging qualification pin");
  // Homebrew and npm ship code mode's host beside the native executable. Resolve a launcher
  // symlink first so copying the candidate does not lose its companion or select one from PATH.
  const host = path.join(path.dirname(source), "codex-code-mode-host");
  if (fs.existsSync(host)) copy(host, path.join(dir, "bin/codex-code-mode-host"));
  const manifest = validateManifest({
    version, binarySha256,
    // Shape-compatible fixture metadata, not acquisition/qualification evidence. The real
    // qualifier verifies npm/codesign/source and publishes only AFTER this run has passed.
    npmIntegrity: `sha512-${"A".repeat(86)}==`,
    codesign: { teamId: TEAM_ID, identity: "stage-2 qualification fixture (unqualified)" },
    qualifiedAt: new Date().toISOString(), sourceCommit: "0".repeat(40),
    verdictPath: path.join(fs.realpathSync(scratch), "stage2-verdict.json"),
    qualificationFixture: true,
  });
  atomicJson(path.join(dir, "manifest.json"), manifest);
  fs.chmodSync(path.join(dir, "manifest.json"), 0o444);
  fs.chmodSync(path.join(dir, "bin"), 0o555);
  fs.chmodSync(dir, 0o555);
  fs.symlinkSync(target, path.join(store, "current"));
  return { bin: stagedBin, pin_store: store, home, pinned: true };
}
