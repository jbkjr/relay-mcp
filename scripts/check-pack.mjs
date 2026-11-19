// npm's prepack: refuses to pack relay without its build. The package's `bin` is dist/cli.js and
// `relay qualify-codex` hashes dist/ with the files its stage-2 run needs (src/core/build-identity.ts),
// so a pack without them would be a package that neither runs nor qualifies. It does not build:
// a release packs the build it qualified, byte for byte (docs/pinned-codex.md, Shipping a pin).
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
if (!fs.existsSync(path.join(root, "dist", "cli.js")) || !fs.existsSync(path.join(root, "dist", "core", "build-identity.js"))) {
  console.error("relay: refusing to pack without a build: run npm run build first");
  process.exit(1);
}
const { buildIdentity, describeBuild } = await import(path.join(root, "dist", "core", "build-identity.js"));
try {
  const build = buildIdentity(root);
  console.error(`relay: packing ${describeBuild(build)} (${build.scheme} sha256 ${build.sha256})`);
  // A shipped Codex pin (codex-pin.json, scripts/codex-qualify/codex-shipped-pin.mjs) is packed
  // only for the exact build it was qualified with; a rebuild after qualifying refuses the pack.
  const { readShippedPin } = await import(path.join(root, "dist", "core", "shipped-pin.js"));
  const pin = readShippedPin(root);
  if (pin && !(pin.relay.scheme === build.scheme && pin.relay.version === build.version && pin.relay.sha256 === build.sha256)) {
    throw new Error(`codex-pin.json was qualified with ${describeBuild(pin.relay)}, not this build: qualify this build and write it again, or remove it`);
  }
  console.error(pin ? `relay: with its shipped Codex pin, Codex ${pin.codex.version}` : "relay: without a shipped Codex pin (Codex needs relay qualify-codex)");
} catch (err) {
  console.error(`relay: refusing to pack: ${err.message}`);
  process.exit(1);
}
