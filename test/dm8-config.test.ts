import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { configProtection } from "../dist/core/protected-config.js";
import { boundaryPaths, seatbeltProfile } from "../dist/confine/seatbelt.js";
import { forEachTarget, harness, task } from "./helpers.ts";

forEachTarget((target) => {
  for (const symlink of [false, true]) {
    test(`DM8 config (${target}): ${symlink ? "symlink" : "RELAY_CONFIG"} outside control directory is protected`, async () => {
      const h = await harness([], { ask_user: "never" });
      try {
        const dir = path.join(path.dirname(h.home), "config-dir");
        fs.mkdirSync(dir);
        const file = path.join(dir, "config.json");
        fs.copyFileSync(path.join(h.home, "config.json"), file);
        // A broad directory: protecting all of it would incorrectly deny the sibling grant.
        const sibling = path.join(dir, "sibling");
        fs.mkdirSync(sibling);
        const configured = symlink ? path.join(path.dirname(h.home), "config-link.json") : file;
        if (symlink) fs.symlinkSync(file, configured);
        h.env.RELAY_CONFIG = configured;
        for (const p of [...new Set([file, configured, dir])]) {
          const r = await h.call("delegate", { target, task: "CONFIG", mode: "write", grant: { write_paths: [p] } });
          assert.equal(r.refused, true, JSON.stringify(r));
          assert.match(r.reason ?? "", /overlaps relay's config/, JSON.stringify(r));
          assert.ok((r.reason ?? "").includes(file) || (r.reason ?? "").includes(configured), JSON.stringify(r));
        }
        const ok = await h.call("delegate", { target, task: "OK", mode: "write", grant: { write_paths: [sibling] }, background: false });
        assert.equal(ok.status, "done", JSON.stringify(ok));
        if (target === "claude") {
          const denied = h.starts()[0].settings.sandbox.filesystem.denyWrite;
          assert.ok(denied.includes(file), JSON.stringify(denied));
          assert.ok(denied.includes(configured), JSON.stringify(denied));
          assert.ok(!denied.includes(dir), "broad directory stays writable");
        }
      } finally { await h.close(); }
    });
  }
  test(`DM8 config (${target}): file request outside control directory is off limits`, async () => {
    const h = await harness([], { ask_user: "never" });
    try {
      const file = path.join(path.dirname(h.home), "config.json");
      fs.copyFileSync(path.join(h.home, "config.json"), file);
      h.env.RELAY_CONFIG = file;
      fs.writeFileSync(h.env.STUB_SCENARIO, JSON.stringify({ rules: [{ match: task("EDIT"), steps: [{ request: { edit: file } }, { reply: "{{last}}" }] }] }));
      const r = await h.call("delegate", { target, task: "EDIT", mode: "write", background: false });
      assert.equal(r.status, "blocked", JSON.stringify(r));
      if (target === "claude") assert.match(r.result.final_message, /config.*no job may change/);
      assert.equal(h.sql("SELECT * FROM requests").length, 0);
    } finally { await h.close(); }
  });
});

test("DM8 config: missing files, dedicated directories and Seatbelt share the protected paths", async () => {
  const h = await harness();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, h.env);
    const dir = path.join(path.dirname(h.home), "dedicated-relay");
    const resolvedDir = path.join(path.dirname(h.home), "resolved-relay");
    fs.mkdirSync(dir); fs.mkdirSync(resolvedDir);
    const file = path.join(dir, "custom.json");
    process.env.RELAY_CONFIG = file;
    assert.ok(configProtection().paths.includes(file), "missing config needs no realpathSync");
    fs.writeFileSync(path.join(resolvedDir, "actual.json"), "{}");
    fs.symlinkSync(path.join(resolvedDir, "actual.json"), file);
    let p = configProtection();
    for (const name of [file, path.join(resolvedDir, "actual.json"), path.join(dir, "install.json"), path.join(dir, "install-backups"), dir, resolvedDir]) assert.ok(p.paths.includes(name), name);
    const tmp = path.join(path.dirname(h.home), "turn"); fs.mkdirSync(tmp);
    const policy = { worktree: h.repo, worktreeWritable: true, tmpDir: tmp, denied: [], network: { mode: "off-except-proxy" as const, proxyPort: 18877, proxyToken: "a".repeat(32) } };
    const bounds = boundaryPaths(policy);
    for (const protectedPath of p.paths) assert.ok(bounds.denied.includes(protectedPath), protectedPath);
    const profile = seatbeltProfile(policy);
    for (const protectedPath of p.paths) assert.ok(profile.params.some(([k, v]) => k.startsWith("DENIED_") && v === protectedPath), protectedPath);
    fs.writeFileSync(path.join(resolvedDir, "unrelated.txt"), "other");
    p = configProtection();
    assert.ok(!p.directories.includes(resolvedDir));
    assert.match(p.fileOnly.find((v) => v.directory === resolvedDir)!.reason, /other than relay/);
    process.env.RELAY_CONFIG = path.join(h.env.HOME, "config.json");
    assert.ok(!configProtection().directories.includes(h.env.HOME), "never protect home whole");
    process.env.RELAY_CONFIG = path.join(h.repo, "config.json");
    assert.ok(!configProtection().directories.includes(h.repo), "never protect project whole");
    const dedicatedInRepo = path.join(h.repo, "relay-config"); fs.mkdirSync(dedicatedInRepo);
    process.env.RELAY_CONFIG = path.join(dedicatedInRepo, "config.json");
    assert.ok(configProtection().directories.includes(dedicatedInRepo), "a dedicated relay subdirectory in a synced repo is protected whole");
  } finally { process.env = saved; await h.close(); }
});
