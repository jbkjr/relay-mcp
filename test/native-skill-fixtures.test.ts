import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLAUDE_BUILTIN_PLUGINS, claudeSkillsProblem } from "../dist/backends/claude.js";
import { skillsProblem } from "../dist/backends/codex-app.js";
import { claudeInitProblem } from "../dist/install/claude-init.js";
import "./helpers.ts";

// Selected fields from the actual 0.163.0 skills/list and 2.1.302 local /skills init reports.
// The disable list covers the built-in registry of the versions in VERIFIED.claudeBuiltinPlugins (src/targets/verified.ts); 2.1.302 source accepts the extra false entries.
// Regenerate without model calls: npm run build; node scripts/probe-skill-isolation.mjs --out …
const root = path.join(os.tmpdir(), "native-replay");
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/native-skill-isolation.json"), "utf8").replaceAll("@ROOT@", root));
test("native skill reports: Claude isolation and inherit controls leave exactly the given skills", () => {
  for (const c of fixture.claude) {
    if (c.settings.disableBundledSkills) {
      assert.deepEqual(c.settings.enabledPlugins, Object.fromEntries(CLAUDE_BUILTIN_PLUGINS.map((name) => [`${name}@builtin`, false])));
      assert.equal(claudeSkillsProblem(c.init, undefined), null);
    }
    else assert.ok(claudeSkillsProblem(c.init, undefined), c.sources);
  }
  const skills = { dir: path.join(root, "package"), names: ["given-probe"] };
  assert.equal(claudeSkillsProblem(fixture.claudeGiven, skills), null);
  assert.ok(claudeSkillsProblem({ ...fixture.claudeGiven, plugins: [] }, skills), "skill names alone cannot establish the package's identity");
  assert.match(claudeSkillsProblem({ ...fixture.claudeGiven, skills: [...fixture.claudeGiven.skills, "unadvertised"] }, skills)!, /skills relay did not give it/);
  for (const name of [...CLAUDE_BUILTIN_PLUGINS, "unrecognized-built-in"]) {
    const plugin = { name, path: "builtin" };
    assert.match(claudeSkillsProblem({ skills: [], plugins: [plugin] }, undefined)!, /plugins relay did not give it/);
    assert.match(claudeSkillsProblem({ ...fixture.claudeGiven, plugins: [...fixture.claudeGiven.plugins, plugin] }, skills)!, /plugins relay did not give it/);
  }
});
test("native skill reports: bundled plugins explain their provenance and remedy; foreign plugins keep the refusal", () => {
  const bundled = fixture.claude[0].init.plugins[0];
  const problem = claudeSkillsProblem({ skills: [], plugins: [bundled] }, undefined)!;
  assert.match(problem, /plugins bundled with this Claude Code version that relay does not yet disable \(cc-plugin-agents-md\)/);
  assert.match(problem, /Update relay or pin Claude Code to a tested version/);
  const foreign = { name: "foreign", path: "/elsewhere", source: "foreign@market" };
  assert.equal(claudeSkillsProblem({ skills: [], plugins: [foreign] }, undefined), "Claude started with plugins relay did not give it (foreign)");
  assert.match(claudeSkillsProblem({ skills: [], plugins: [foreign, bundled] }, undefined)!, /plugins relay did not give it \(foreign\).*bundled.*cc-plugin-agents-md/);
  assert.match(claudeSkillsProblem({ skills: [], plugins: [{ ...bundled, name: "future-builtin", source: "future-builtin@builtin" }] }, undefined)!, /future-builtin/);
});
test("native skill reports: an init probe spawn failure is diagnostic, not an exception", async () => {
  // A home short enough for Claude's temp limit, so the probe gets as far as starting the CLI.
  const saved = process.env.HOME;
  const home = fs.mkdtempSync("/tmp/");
  process.env.HOME = home;
  try {
    assert.match((await claudeInitProblem(path.join(root, "missing-cli"), { HOME: home, PATH: process.env.PATH }, () => null))!, /init-only probe could not start \(ENOENT\)/);
    assert.deepEqual(fs.readdirSync(path.join(home, ".rn")), [], "its private temp in ~/.rn is removed");
  } finally { process.env.HOME = saved; fs.rmSync(home, { recursive: true, force: true }); }
});
test("native skill reports: Codex disabled user, repository and bundled skills, and enabled exactly the extra root's copy", async () => {
  for (const [key, names] of [["codexEmpty", []], ["codexGiven", ["given-probe"]]] as const) {
    const calls: string[] = [];
    const rpc = { request: async (method: string) => { calls.push(method); return method === "skills/list" ? structuredClone(fixture[key]) : {}; } };
    assert.equal(await skillsProblem(rpc, path.join(root, "repo"), { root: names.length ? path.join(root, "package/skills") : null, names: [...names] }), null);
    assert.deepEqual(calls, names.length ? ["skills/extraRoots/set", "skills/list"] : ["skills/list"]);
  }
  for (const bad of [
    { ...fixture.codexEmpty, data: [{ ...fixture.codexEmpty.data[0], errors: [{ path: "/missing", message: "unreadable" }] }] },
    { ...fixture.codexEmpty, data: [{ ...fixture.codexEmpty.data[0], cwd: path.join(root, "wrong") }] },
    { ...fixture.codexEmpty, data: [{ ...fixture.codexEmpty.data[0], skills: [{ name: "unknown", path: "/unknown", scope: "system", enabled: true }] }] },
  ]) assert.ok(await skillsProblem({ request: async () => bad }, path.join(root, "repo"), { root: null, names: [] }));
});
