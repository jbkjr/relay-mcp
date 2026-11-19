import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { settingsAnswerForPerson } from "../dist/core/claude-settings.js";
import { harness, INTERACTIVE_CLAUDE } from "./helpers.ts";

test("extension consent: plugin default, manifest inline and referenced hooks withhold only matching routes; unreadable manifests fail closed", async () => {
  const h = await harness();
  try {
    const clean = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"] });
    try { assert.ok((await clean.tools()).includes("confirm"), "no hooks leaves confirm available"); } finally { await clean.close(); }
    for (const config of [path.join(h.env.HOME, ".claude"), path.join(h.env.HOME, "custom-claude")]) {
      const env = { ...h.env, CLAUDE_CONFIG_DIR: config };
      const root = path.join(config, "plugins/cache/scratch/operator/1");
      const write = (rel: string, value: unknown) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
      const hooks = (event: string, matcher: unknown) => ({ [event]: [{ matcher, hooks: [{ type: "command", command: "SECRET" }] }] });
      write(".claude-plugin/plugin.json", { name: "operator" });
      const consent = () => settingsAnswerForPerson(env, h.repo, [], []);
      assert.deepEqual(consent(), { confirm: null, dialog: null });
      for (const matcher of ["mcp__relay__confirm", "mcp__relay__adopt", "mcp__relay__.*", "*", "[", 1]) {
        write("hooks/hooks.json", { hooks: hooks("PreToolUse", matcher) });
        assert.ok(consent().confirm, String(matcher));
        assert.equal(consent().dialog, null);
        assert.doesNotMatch(JSON.stringify(consent()), /SECRET/);
      }
      const hooked = await h.instance({ ...INTERACTIVE_CLAUDE, env: { ...INTERACTIVE_CLAUDE.env, CLAUDE_CONFIG_DIR: config }, args: ["--host", "claude"] });
      try { assert.ok(!(await hooked.tools()).includes("confirm")); } finally { await hooked.close(); }
      write("hooks/hooks.json", { hooks: hooks("PreToolUse", "Bash") });
      assert.deepEqual(consent(), { confirm: null, dialog: null });
      write(".claude-plugin/plugin.json", { name: "operator", hooks: hooks("PermissionRequest", "mcp__relay__confirm") });
      assert.ok(consent().confirm);
      write(".claude-plugin/plugin.json", { name: "operator", hooks: ["./extra.json"] });
      write("extra.json", { hooks: hooks("ElicitationResult", "relay") });
      assert.equal(consent().confirm, null);
      assert.ok(consent().dialog);
      fs.writeFileSync(path.join(root, ".claude-plugin/plugin.json"), "{");
      assert.ok(consent().confirm); assert.ok(consent().dialog);
      write(".claude-plugin/plugin.json", { name: "operator" });
    }
  } finally { await h.close(); }
});

test("extension consent: recorded in-place plugins and nonstandard skill roots cannot hide hooks; broken registries and dangling hook paths fail closed", async () => {
  const h = await harness();
  try {
    const root = path.join(h.env.HOME, "local-plugin");
    const manifest = path.join(root, ".claude-plugin/plugin.json");
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    const registry = path.join(h.env.HOME, ".claude/plugins/installed_plugins.json");
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify({ version: 2, plugins: { "local@scratch": [{ scope: "user", installPath: root, version: "1" }] } }));
    fs.writeFileSync(manifest, JSON.stringify({ name: "local", skills: ["./extra"] }));
    fs.mkdirSync(path.join(root, "extra/nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "extra/nested/SKILL.md"), "---\nname: nested\nhooks: {}\n---\n");
    const consent = () => settingsAnswerForPerson(h.env, h.repo, [], []);
    assert.ok(consent().confirm); assert.ok(consent().dialog);
    fs.writeFileSync(manifest, JSON.stringify({ name: "local", hooks: "./missing.json" }));
    assert.match(consent().confirm!, /could not read/);
    fs.writeFileSync(manifest, JSON.stringify({ name: "local", hooks: { modules: ["./opaque.js"] } }));
    assert.ok(consent().confirm); assert.ok(consent().dialog);
    // A hooks file that loads a hooks module withholds and says so, with or without a hooks map.
    for (const file of [{ hooks: {}, modules: ["./opaque.js"] }, { modules: ["./register.tsx"] }]) {
      fs.writeFileSync(path.join(root, "modules.json"), JSON.stringify(file));
      fs.writeFileSync(manifest, JSON.stringify({ name: "local", hooks: "./modules.json" }));
      assert.match(consent().confirm!, /modules\.json load a hooks module/); assert.match(consent().dialog!, /hooks module/);
    }
    fs.writeFileSync(path.join(root, "modules.json"), JSON.stringify({ description: "neither hooks nor modules" }));
    assert.match(consent().confirm!, /could not read the Claude Code plugin hooks in .*modules\.json/);
    fs.writeFileSync(registry, "{");
    assert.match(consent().confirm!, /installed plugin manifest/);
    assert.ok(consent().dialog);
    assert.ok(settingsAnswerForPerson(h.env, h.repo, ["claude --plugin-dir /a path"], []).confirm);
  } finally { await h.close(); }
});

test("extension consent: a nested repository skill that Claude can discover later is scanned before consent", async () => {
  const h = await harness();
  try {
    const dir = path.join(h.repo, "nested/.claude/skills/operator");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: operator\nhooks: {}\n---\n");
    const consent = settingsAnswerForPerson(h.env, h.repo, [], []);
    assert.ok(consent.confirm); assert.ok(consent.dialog);
  } finally { await h.close(); }
});

test("extension consent: a local marketplace outside the plugin cache cannot supply uninspected hooks", async () => {
  const h = await harness();
  try {
    const marketplace = path.join(h.env.HOME, "local-marketplace");
    fs.mkdirSync(path.join(marketplace, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(marketplace, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "scratch", plugins: [{ name: "operator", source: "./operator", hooks: { PreToolUse: [{ matcher: "mcp__relay__confirm", hooks: [] }] } }] }));
    const plugins = path.join(h.env.HOME, ".claude/plugins"); fs.mkdirSync(plugins, { recursive: true });
    fs.writeFileSync(path.join(plugins, "known_marketplaces.json"), JSON.stringify({ scratch: { source: { source: "directory", path: marketplace }, installLocation: marketplace } }));
    const consent = settingsAnswerForPerson(h.env, h.repo, [], []);
    assert.ok(consent.confirm); assert.ok(consent.dialog);
  } finally { await h.close(); }
});

test("extension consent: skill frontmatter in user, config and repository roots withholds confirm, adopt and extensions; unreadable frontmatter fails closed", async () => {
  const h = await harness();
  try {
    const roots = [path.join(h.env.HOME, ".claude/skills"), path.join(h.repo, ".claude/skills"), path.join(h.env.HOME, "custom-claude/skills")];
    for (const root of roots) {
      const dir = path.join(root, "operator"); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "SKILL.md");
      const env = { ...h.env, CLAUDE_CONFIG_DIR: path.join(h.env.HOME, "custom-claude") };
      for (const front of ["hooks:\n  PreToolUse:\n    - matcher: mcp__relay__confirm\n      hooks: []", "hooks: {}", '"hooks": {}', "name: broken\n[", "hooks: &h {}", "hooks: *h"]) {
        fs.writeFileSync(file, `---\n${front}\n---\nSECRET\n`);
        const c = settingsAnswerForPerson(env, h.repo, [], []);
        assert.ok(c.confirm, front);
        assert.doesNotMatch(JSON.stringify(c), /SECRET/);
      }
      fs.writeFileSync(file, "---\nname: ordinary\ndescription: fine\n---\nhooks: body only\n");
      assert.deepEqual(settingsAnswerForPerson(env, h.repo, [], []), { confirm: null, dialog: null });
    }
    fs.writeFileSync(path.join(roots[0], "operator/SKILL.md"), "---\nname: ordinary\nhooks: {}\n---\n");
    const host = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"] });
    try { assert.ok(!(await host.tools()).includes("confirm")); } finally { await host.close(); }
  } finally { await h.close(); }
});

/**
 * A marketplace laid out like anthropics/skills: one repository whose entries share the root
 * (`source: "./"`, `strict: false`) and list skill folders, registered and installed into the cache.
 */
function skillsMarketplace(home: string) {
  const plugins = path.join(home, ".claude/plugins");
  const market = path.join(plugins, "marketplaces/skills-market");
  const cached = path.join(plugins, "cache/skills-market/docs/abc123");
  const manifest = {
    name: "skills-market",
    plugins: [
      { name: "docs", source: "./", strict: false, skills: ["./skills/pdf", "./skills/xlsx"] },
      { name: "examples", source: "./", strict: false, skills: ["./skills/art"] },
      { name: "bundle", source: "./", skills: "./bundle" },
      { name: "remote", source: { source: "git-subdir", url: "https://example.invalid/r.git", path: "skills" }, skills: ["./remote-skill"] },
    ],
  };
  const skill = (root: string, rel: string, front = `name: ${path.basename(rel)}\ndescription: ordinary`) => {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, rel, "SKILL.md"), `---\n${front}\n---\nhooks: in the body only\n`);
  };
  for (const root of [market, cached]) {
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude-plugin/marketplace.json"), JSON.stringify(manifest));
    for (const rel of ["skills/pdf", "skills/xlsx", "skills/art", "bundle/one", "bundle/two"]) skill(root, rel);
  }
  fs.writeFileSync(path.join(plugins, "known_marketplaces.json"), JSON.stringify({ "skills-market": { source: { source: "github", repo: "example/skills" }, installLocation: market } }));
  fs.writeFileSync(path.join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "docs@skills-market": [{ scope: "user", installPath: cached, version: "abc123" }] } }));
  const rewrite = (change: (m: typeof manifest) => void) => {
    const next = structuredClone(manifest); change(next);
    for (const root of [market, cached]) fs.writeFileSync(path.join(root, ".claude-plugin/marketplace.json"), JSON.stringify(next));
  };
  return { plugins, market, cached, skill, rewrite };
}

test("extension consent: a skills-only marketplace keeps the approval dialog and confirm when no declared skill has hooks", async () => {
  const h = await harness();
  try {
    skillsMarketplace(h.env.HOME);
    assert.deepEqual(settingsAnswerForPerson(h.env, h.repo, [], []), { confirm: null, dialog: null });
    const host = await h.instance({ ...INTERACTIVE_CLAUDE, host: null, elicit: () => ({ action: "cancel" }) });
    try {
      assert.equal((await host.call("status")).approval_dialogs.offered, true);
      assert.ok((await host.tools()).includes("confirm"));
    } finally { await host.close(); }
  } finally { await h.close(); }
});

test("extension consent: a declared marketplace skill with hooks withholds, wherever a copy of its plugin is", async () => {
  const h = await harness();
  try {
    const m = skillsMarketplace(h.env.HOME);
    const consent = () => settingsAnswerForPerson(h.env, h.repo, [], []);
    const hooked = "name: art\nhooks:\n  Elicitation:\n    - matcher: relay\n      hooks: []";
    // In the marketplace's own copy, in a cached version only, in a folder of skill folders, and
    // in the cached copy of a remote plugin the marketplace directory does not hold.
    // An older cached version of the remote plugin, without a plugin.json: its default skills/
    // load alongside the declared ones, so they are read too.
    const remote = path.join(m.plugins, "cache/skills-market/remote/0.1");
    const cases: [string, string][] = [
      [m.market, "skills/art"],
      [m.cached, "skills/pdf"],
      [m.market, "bundle/two"],
      [remote, "remote-skill"],
      [remote, "skills/default-only"],
    ];
    for (const [root, rel] of cases) {
      m.skill(root, rel, hooked);
      const c = consent();
      assert.match(c.dialog ?? "", /has hooks/, `${root} ${rel}`);
      assert.ok(c.confirm);
      const instance = await h.instance({ ...INTERACTIVE_CLAUDE, host: null, elicit: () => ({ action: "cancel" }) });
      try { assert.equal((await instance.call("status")).approval_dialogs.offered, false); } finally { await instance.close(); }
      m.skill(root, rel);
    }
    assert.deepEqual(consent(), { confirm: null, dialog: null });
    // Declared hooks, agents and commands still withhold as before, even with nothing behind them.
    for (const key of ["hooks", "agents", "commands"]) {
      m.rewrite((x) => { (x.plugins[0] as Record<string, unknown>)[key] = key === "hooks" ? {} : ["./nothing"]; });
      assert.match(consent().dialog ?? "", /declares extension components/, key);
    }
  } finally { await h.close(); }
});

test("extension consent: unreadable, malformed and escaping marketplace skills fail closed", async () => {
  const h = await harness();
  try {
    const m = skillsMarketplace(h.env.HOME);
    const consent = () => settingsAnswerForPerson(h.env, h.repo, [], []);
    const pdf = path.join(m.market, "skills/pdf/SKILL.md");
    for (const body of ["---\nname: pdf\n[\n---\n", "no frontmatter at all\n", "---\nname: pdf\n", "---\n\"hooks\": {}\n---\n", "---\nname:  pdf\n---\n"]) {
      fs.writeFileSync(pdf, body);
      assert.ok(consent().dialog, JSON.stringify(body)); assert.ok(consent().confirm);
    }
    fs.writeFileSync(pdf, "---\nname: pdf\n---\n");
    fs.chmodSync(pdf, 0o000);
    try { assert.match(consent().dialog ?? "", /could not read/); } finally { fs.chmodSync(pdf, 0o644); }
    assert.deepEqual(consent(), { confirm: null, dialog: null });

    // A skill folder linked from outside the plugin root, even an ordinary one, withholds.
    const outside = path.join(h.env.HOME, "elsewhere/art");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "SKILL.md"), "---\nname: art\n---\n");
    const art = path.join(m.cached, "skills/art");
    fs.rmSync(art, { recursive: true });
    fs.symlinkSync(outside, art);
    assert.match(consent().dialog ?? "", /outside its plugin directory/);
    fs.rmSync(art); m.skill(m.cached, "skills/art");
    // So does a linked SKILL.md, and a dangling link.
    const xlsx = path.join(m.market, "skills/xlsx/SKILL.md");
    fs.rmSync(xlsx); fs.symlinkSync(path.join(outside, "SKILL.md"), xlsx);
    assert.match(consent().dialog ?? "", /outside its plugin directory/);
    fs.rmSync(xlsx); fs.symlinkSync(path.join(h.env.HOME, "missing.md"), xlsx);
    assert.ok(consent().dialog);
    fs.rmSync(xlsx); m.skill(m.market, "skills/xlsx");
    assert.deepEqual(consent(), { confirm: null, dialog: null });

    // Paths and sources that leave the plugin or marketplace, names relay cannot place, and
    // shapes it cannot read.
    const bad: [string, (x: any) => void][] = [
      ["declared path", (x) => { x.plugins[0].skills = ["../elsewhere"]; }],
      ["source", (x) => { x.plugins[1].source = "../elsewhere"; }],
      ["pluginRoot", (x) => { x.metadata = { pluginRoot: 3 }; }],
      ["name", (x) => { x.plugins[0].name = "../docs"; }],
      ["skill entry", (x) => { x.plugins[0].skills = [{ path: "./skills/pdf" }]; }],
      ["empty list", (x) => { x.plugins[0].skills = []; }],
      ["source shape", (x) => { x.plugins[3].source = 7; }],
    ];
    for (const [what, change] of bad) {
      m.rewrite(change);
      assert.ok(consent().dialog, what); assert.ok(consent().confirm, what);
    }
    m.rewrite(() => {});
    assert.deepEqual(consent(), { confirm: null, dialog: null });

    // A zipped cache copy cannot be inspected; nor can a relocated plugins root.
    const zip = path.join(m.plugins, "cache/skills-market/remote/0.2.zip");
    fs.mkdirSync(path.dirname(zip), { recursive: true });
    fs.writeFileSync(zip, "PK");
    assert.match(consent().dialog ?? "", /zipped/);
    fs.rmSync(zip);
    assert.deepEqual(consent(), { confirm: null, dialog: null });
    for (const name of ["CLAUDE_CODE_PLUGIN_CACHE_DIR", "CLAUDE_CODE_PLUGIN_SEED_DIR"]) {
      assert.match(settingsAnswerForPerson({ ...h.env, [name]: path.join(h.env.HOME, "other") }, h.repo, [], []).dialog ?? "", new RegExp(name));
    }
  } finally { await h.close(); }
});
