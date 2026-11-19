import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLI, hostVar } from "./helpers.ts";

// What install and uninstall print, whole, for each host: fresh, with --force, over an entry of
// relay's name that another program wrote, and after an install. The installer's planning is to be
// gathered into one planner (consolidation design R9, CT4), and install.test.ts asserts lines one at
// a time; this compares everything, so that a line that moves, changes or goes shows up. Dry runs
// only (no --write after the setup): nothing is changed, so each case sees the state it was set up with.
//
// To record the snapshots again after a deliberate change: RELAY_UPDATE_SNAPSHOTS=1 node --test test/install-snapshots.test.ts

const ROOT = fs.realpathSync(path.resolve(import.meta.dirname, ".."));
const FAKE = path.join(ROOT, "test", "stubs", "fake-host-cli.mjs");
const SNAPSHOTS = path.join(ROOT, "test", "fixtures", "install-snapshots");
const UPDATE = process.env.RELAY_UPDATE_SNAPSHOTS === "1";

/** A scratch HOME with fake `claude` and `codex` first on PATH, as install.test.ts's box. */
function box() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-snap-")));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const fake = path.join(tmp, "fake");
  for (const d of [home, bin, fake]) fs.mkdirSync(d, { recursive: true });
  assert.notEqual(home, os.homedir());
  for (const cli of ["claude", "codex"]) fs.writeFileSync(path.join(bin, cli), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${cli} "$@"\n`, { mode: 0o755 });
  // The desktop app is not running.
  fs.writeFileSync(path.join(bin, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !hostVar(k) && !/^(RELAY_|CODEX_|CLAUDE|FAKE_|XDG_)/.test(k)) env[k] = v;
  Object.assign(env, { HOME: home, CODEX_HOME: path.join(home, ".codex"), PATH: `${bin}:/usr/bin:/bin`, RELAY_TEST_SYSTEM_TOOLS: bin, FAKE_DIR: fake });
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  return {
    tmp, home,
    relay(args: string[]): string {
      const r = spawnSync(process.execPath, [CLI, ...args], { env, cwd: tmp, encoding: "utf8" });
      // Scratch and checkout paths, and the day, differ from run to run and machine to machine.
      const norm = (s: string) => s.split(tmp).join("<TMP>").split(ROOT).join("<ROOT>").split(process.execPath).join("<NODE>").split(path.dirname(process.execPath)).join("<NODE_DIR>")
        // The installation record's date.
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<DATE>");
      return `$ relay ${args.join(" ")}\nexit status ${r.status}\n--- stdout\n${norm(r.stdout)}--- stderr\n${norm(r.stderr)}`;
    },
    /** An entry of relay's name in the host's own configuration, written by another program. */
    foreign(host: string) {
      if (host === "claude") {
        fs.writeFileSync(path.join(fake, "claude.json"), JSON.stringify({ server: { scope: "User config (available in all your projects)", type: "stdio", command: "/usr/local/bin/relay-chat", args: [], env: [] }, markets: [], plugins: [] }));
      } else if (host === "codex") {
        write(path.join(home, ".codex", "config.toml"), '[mcp_servers.relay]\ncommand = "foreign-server"\n');
      } else {
        write(path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), JSON.stringify({ mcpServers: { "relay-desktop": { command: "npx", args: ["some-relay"] } } }, null, 2));
      }
    },
    /** The desktop app's config file, as the app leaves it once opened; install refuses without one. Nothing for the other hosts. */
    opened(host: string) {
      if (host === "claude-desktop") write(path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), "{}\n");
    },
    close: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

type Box = ReturnType<typeof box>;
const CASES: { name: string; setup?: (b: Box, host: string) => void; runs: (host: string) => string[][] }[] = [
  { name: "fresh", runs: (h) => [["install", h], ["install", h, "--force"], ["uninstall", h]] },
  { name: "foreign", setup: (b, h) => b.foreign(h), runs: (h) => [["install", h], ["install", h, "--force"], ["uninstall", h], ["uninstall", h, "--force"]] },
  { name: "installed", setup: (b, h) => (b.opened(h), void b.relay(["install", h, "--write"])), runs: (h) => [["install", h], ["install", h, "--force"], ["uninstall", h], ["uninstall", h, "--force"]] },
];

for (const host of ["claude", "codex", "claude-desktop"]) {
  for (const c of CASES) {
    test(`install snapshots (${host}, ${c.name}): install and uninstall print what they printed before`, () => {
      const b = box();
      try {
        c.setup?.(b, host);
        const got = c.runs(host).map((args) => b.relay(args)).join("\n");
        const file = path.join(SNAPSHOTS, `${host}-${c.name}.txt`);
        if (UPDATE) {
          fs.mkdirSync(SNAPSHOTS, { recursive: true });
          fs.writeFileSync(file, got);
        }
        assert.ok(fs.existsSync(file), `no snapshot ${file}: record it with RELAY_UPDATE_SNAPSHOTS=1`);
        assert.equal(got, fs.readFileSync(file, "utf8"));
      } finally {
        b.close();
      }
    });
  }
}
