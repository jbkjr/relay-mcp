// A stand-in relay package for tests of the qualifier and `relay qualify-codex`: every entry of
// relay's qualified build (src/core/build-identity.ts QUALIFIED_BUILD) as a small file, so that its
// build identity can be computed, plus package.json. The real dist/ and tests are not copied.
import fs from "node:fs";
import path from "node:path";
import { QUALIFIED_BUILD } from "../dist/core/build-identity.js";

export function fakeRelayBuild(root: string, version = "1.0.0", files: Record<string, string> = {}): string {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@jbkjr/relay", version, dependencies: {} }));
  // relay's dependency lock, in the shape npm writes (copyBuild checks it names this package and version).
  fs.writeFileSync(path.join(root, "npm-shrinkwrap.json"), JSON.stringify({ name: "@jbkjr/relay", version, lockfileVersion: 3, requires: true, packages: { "": { name: "@jbkjr/relay", version } } }));
  for (const entry of QUALIFIED_BUILD) {
    const file = entry.endsWith("/") ? path.join(root, entry, "fixture.txt") : path.join(root, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, `fixture ${entry}\n`);
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
