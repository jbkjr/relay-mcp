// Which `relay` on PATH doctor accepts as this relay (install/common.ts relayCommandKind): the
// launcher of this install, or npm's global command for this installed package, judged by where the
// command leads and where it sits, never by its name. Everything else is not this relay.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers.ts";
import { relativePathEntryBefore, relayCommandKind } from "../dist/install/common.js";

const PKG = { name: "@jbkjr/relay", version: "1.1.4", bin: { relay: "dist/cli.js" } };

/** A temporary directory, removed after the body runs. */
function inTemp(body: (tmp: string) => void): void {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-command-")));
  try { body(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** An installed copy of the package at `root`: package.json, the bin entry and the launcher. */
function pkgAt(root: string, pkg: object = PKG): string {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "bin", "relay"), "#!/bin/sh\n", { mode: 0o755 });
  return root;
}

/** What `npm install -g` makes under `prefix`: the package in lib/node_modules and bin/relay, a relative symlink to its bin entry. */
function npmGlobal(prefix: string, pkg: object = PKG): { root: string; command: string } {
  const root = pkgAt(path.join(prefix, "lib", "node_modules", "@jbkjr", "relay"), pkg);
  const command = path.join(prefix, "bin", "relay");
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.symlinkSync("../lib/node_modules/@jbkjr/relay/dist/cli.js", command);
  return { root, command };
}

test("npm's global command for this package is this relay, under Homebrew's prefix and under a custom prefix", () => {
  inTemp((tmp) => {
    for (const prefix of [path.join(tmp, "opt", "homebrew"), path.join(tmp, "home", ".npm-global"), path.join(tmp, "home", ".nvm", "versions", "node", "v24.11.0")]) {
      const { root, command } = npmGlobal(prefix);
      assert.equal(relayCommandKind(command, root), "npm", prefix);
    }
  });
});

test("a PATH directory that is a symlink to npm's bin directory is judged by where it leads", () => {
  inTemp((tmp) => {
    const { root } = npmGlobal(path.join(tmp, "opt", "homebrew"));
    fs.mkdirSync(path.join(tmp, "usr", "local"), { recursive: true });
    fs.symlinkSync(path.join(tmp, "opt", "homebrew", "bin"), path.join(tmp, "usr", "local", "bin"));
    assert.equal(relayCommandKind(path.join(tmp, "usr", "local", "bin", "relay"), root), "npm");
  });
});

test("the ~/.local/bin link install makes, to this install's launcher, is this relay: in a checkout and in an npm install", () => {
  inTemp((tmp) => {
    const checkout = pkgAt(path.join(tmp, "dev", "relay"));
    const { root: npmRoot } = npmGlobal(path.join(tmp, "opt", "homebrew"));
    for (const root of [checkout, npmRoot]) {
      const link = path.join(tmp, "home", ".local", "bin", "relay");
      fs.rmSync(link, { force: true });
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.join(root, "bin", "relay"), link);
      assert.equal(relayCommandKind(link, root), "launcher", root);
      assert.equal(relayCommandKind(path.join(root, "bin", "relay"), root), "launcher", "the launcher itself");
    }
  });
});

test("a foreign `relay` earlier on PATH is not this relay, whatever it is called", () => {
  inTemp((tmp) => {
    const { root } = npmGlobal(path.join(tmp, "opt", "homebrew"));
    const foreign = path.join(tmp, "usr", "local", "bin", "relay");
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, "#!/bin/sh\necho someone else's relay\n", { mode: 0o755 });
    assert.equal(relayCommandKind(foreign, root), null);
    // Another package named relay, installed by npm in the same prefix layout, leading to its own entry.
    const other = npmGlobal(path.join(tmp, "other-prefix"), { name: "relay", bin: { relay: "dist/cli.js" } });
    assert.equal(relayCommandKind(other.command, root), null);
  });
});

test("another relay is not this relay: a stale checkout's link, another npm install of this package, a copy of the entry point", () => {
  inTemp((tmp) => {
    const { root } = npmGlobal(path.join(tmp, "opt", "homebrew"));
    const stale = pkgAt(path.join(tmp, "dev", "old-relay"));
    const link = path.join(tmp, "home", ".local", "bin", "relay");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(stale, "bin", "relay"), link);
    assert.equal(relayCommandKind(link, root), null, "a stale checkout's launcher");
    const elsewhere = npmGlobal(path.join(tmp, "home", ".npm-global"));
    assert.equal(relayCommandKind(elsewhere.command, root), null, "the same package installed under another prefix");
    assert.equal(relayCommandKind(path.join(tmp, "opt", "homebrew", "bin", "relay"), stale), null, "seen from the stale checkout, npm's command is not it");
    const copy = path.join(tmp, "opt", "homebrew", "bin", "relay-copy");
    fs.copyFileSync(path.join(root, "dist", "cli.js"), copy);
    assert.equal(relayCommandKind(copy, root), null, "a copy, not a link to the entry point");
  });
});

test("a link to the entry point outside npm's layout, or a package relay cannot read, is not accepted", () => {
  inTemp((tmp) => {
    const { root } = npmGlobal(path.join(tmp, "opt", "homebrew"));
    // Leads to this package's entry point, but does not sit in <prefix>/bin beside lib/node_modules/<name>.
    for (const dir of [path.join(tmp, "elsewhere"), path.join(tmp, "elsewhere", "bin")]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(path.join(root, "dist", "cli.js"), path.join(dir, "relay"));
      assert.equal(relayCommandKind(path.join(dir, "relay"), root), null, dir);
    }
    // npm's command, but the package's own manifest names another bin entry, or none, or is unreadable.
    const command = path.join(tmp, "opt", "homebrew", "bin", "relay");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...PKG, bin: { relay: "bin/other.js" } }));
    assert.equal(relayCommandKind(command, root), null, "another bin entry");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: PKG.name }));
    assert.equal(relayCommandKind(command, root), null, "no bin entry");
    fs.writeFileSync(path.join(root, "package.json"), "{ not json");
    assert.equal(relayCommandKind(command, root), null, "unreadable manifest");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...PKG, name: "@jbkjr/../relay" }));
    assert.equal(relayCommandKind(command, root), null, "a name that is not a package name");
    for (const text of ["null", "[]", "\"relay\"", "7"]) {
      fs.writeFileSync(path.join(root, "package.json"), text);
      assert.equal(relayCommandKind(command, root), null, `manifest ${text}`);
    }
  });
});

test("an entry point that leads out of the install is not this relay, though npm's layout and the manifest agree", () => {
  inTemp((tmp) => {
    const prefix = path.join(tmp, "opt", "homebrew");
    const foreign = path.join(tmp, "foreign", "program");
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, "#!/bin/sh\n", { mode: 0o755 });
    // The manifest's bin entry names a path outside the package, and npm's link follows it.
    const { root, command } = npmGlobal(prefix, { ...PKG, bin: { relay: "../../../../../foreign/program" } });
    fs.rmSync(command);
    fs.symlinkSync(foreign, command);
    assert.equal(relayCommandKind(command, root), null, "bin entry outside the package");
    // dist/cli.js inside the package is itself a link to a program elsewhere.
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(PKG));
    fs.rmSync(path.join(root, "dist", "cli.js"));
    fs.symlinkSync(foreign, path.join(root, "dist", "cli.js"));
    fs.rmSync(command);
    fs.symlinkSync("../lib/node_modules/@jbkjr/relay/dist/cli.js", command);
    assert.equal(relayCommandKind(command, root), null, "entry point linked out of the package");
    // Likewise a launcher that is a link out of the install.
    fs.rmSync(path.join(root, "bin", "relay"));
    fs.symlinkSync(foreign, path.join(root, "bin", "relay"));
    assert.equal(relayCommandKind(path.join(root, "bin", "relay"), root), null, "launcher linked out of the install");
    assert.equal(relayCommandKind(foreign, root), null);
  });
});

test("a relative or empty PATH entry ahead of the command's directory is named; one after it, or none, is not", () => {
  inTemp((tmp) => {
    const dir = path.join(tmp, "bin");
    fs.mkdirSync(dir);
    assert.equal(relativePathEntryBefore(dir, `/usr/bin:${dir}:/bin`), null);
    assert.equal(relativePathEntryBefore(dir, `.:${dir}`), ".");
    assert.equal(relativePathEntryBefore(dir, `/usr/bin::${dir}`), "(an empty entry)");
    assert.equal(relativePathEntryBefore(dir, `node_modules/.bin:${dir}`), "node_modules/.bin");
    assert.equal(relativePathEntryBefore(dir, `${dir}:.:/bin`), null, "after it");
  });
});
