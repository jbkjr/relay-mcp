import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { briefSkill, HOSTS } from "../dist/hosts/index.js";
import { otherTargets, TARGETS, TESTED } from "../dist/targets/index.js";
import { harness } from "./helpers.ts";

const ADAPTERS = path.resolve(import.meta.dirname, "..", "adapters");
const build = () => import("../adapters/generate.mjs");
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-briefs-")));

/** Every file under `dir`, relative to it, sorted. */
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();

/** The brief skill's file in a host's adapter, by the host's skill layout. */
const briefFile = (root: string, dir: string, target: string) =>
  path.join(root, dir, "relay", "skills", dir === "codex" ? `relay-${briefSkill(target)}` : briefSkill(target), "SKILL.md");

test("briefs: the checked-in adapters are what build.mjs generates", async () => {
  const out = scratch();
  try {
    (await build()).buildAdapters(out);
    for (const h of HOSTS.filter((h) => h.adapter)) {
      const dir = h.adapter!.dir;
      const got = files(path.join(out, dir));
      assert.deepEqual(files(path.join(ADAPTERS, dir)), got, `adapters/${dir} has the generated files and no others; run node adapters/build.mjs`);
      for (const f of got) assert.equal(fs.readFileSync(path.join(ADAPTERS, dir, f), "utf8"), fs.readFileSync(path.join(out, dir, f), "utf8"), `adapters/${dir}/${f} is up to date`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("briefs: regenerating over an earlier build removes what is no longer generated, and only within the hosts' adapters", async () => {
  // A per-target file (relay:<target>, a brief skill) stops being generated when its target leaves
  // otherTargets; the test above then fails, and running build.mjs must be what fixes it.
  const out = scratch();
  const fresh = scratch();
  try {
    const { buildAdapters } = await build();
    buildAdapters(out);
    buildAdapters(fresh);
    const planted: string[] = [];
    for (const h of HOSTS.filter((h) => h.adapter)) {
      for (const f of [path.join(h.adapter!.dir, "relay", "agents", "stale.md"), path.join(h.adapter!.dir, "relay", "skills", "write-for-stale", "SKILL.md")]) {
        fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
        fs.writeFileSync(path.join(out, f), "stale\n");
        planted.push(f);
      }
    }
    // adapters/ itself holds the generator (build.mjs, generate.mjs), which is no host's adapter.
    fs.writeFileSync(path.join(out, "keep.mjs"), "kept\n");
    buildAdapters(out);
    for (const f of planted) assert.ok(!fs.existsSync(path.join(out, f)), `${f} is gone after regenerating`);
    assert.equal(fs.readFileSync(path.join(out, "keep.mjs"), "utf8"), "kept\n", "a file outside the hosts' adapter directories is left alone");
    for (const h of HOSTS.filter((h) => h.adapter)) {
      const dir = h.adapter!.dir;
      assert.deepEqual(files(path.join(out, dir)), files(path.join(fresh, dir)), `adapters/${dir} is what a fresh build gives`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test("briefs: each host's skills carry the brief for every family it reaches, written by that family, and no other", async () => {
  const { loadBriefs } = await import("../dist/targets/briefs.js");
  const briefs = loadBriefs();
  for (const h of HOSTS.filter((h) => h.adapter)) {
    const dir = h.adapter!.dir;
    const reached = otherTargets(h.target).map((t) => t.id);
    assert.ok(reached.length, `${h.id} reaches some family`);
    for (const t of TARGETS) {
      const file = briefFile(ADAPTERS, dir, t.id);
      if (!reached.includes(t.id)) {
        assert.ok(!fs.existsSync(file), `${h.id} gets no brief for its own family (${t.id})`);
        continue;
      }
      const text = fs.readFileSync(file, "utf8");
      assert.ok(text.includes(briefs[t.id].brief), `${h.id}'s ${briefSkill(t.id)} carries briefs/${t.id}.md`);
      assert.match(text, new RegExp(`^## Writing for ${t.name}$`, "m"));
      assert.match(text, new RegExp(`written by ${t.name}: each family wrote the brief on prompting itself`));
      // The model notes are printed with the date and version they were checked with.
      assert.ok(text.includes(`Checked ${briefs[t.id].models.checked} with ${briefs[t.id].models.checked_with}.`), `${h.id}'s brief for ${t.id} dates its model notes`);
      for (const n of briefs[t.id].models.notes) assert.ok(text.includes(n), `${h.id}'s brief for ${t.id} has its model notes`);
      // The other families' briefs are not mixed in.
      for (const o of TARGETS.filter((o) => o.id !== t.id && briefs[o.id])) assert.ok(!text.includes(briefs[o.id].brief), `${h.id}'s brief for ${t.id} is not ${o.id}'s`);
      // A reference skill, which the agent may load itself: no request line, no "only when asked".
      assert.doesNotMatch(text, /\$ARGUMENTS|argument-hint|Use only when the user asks|The user's request follows/);
    }
    // The skills that write to another agent point at the brief, by the name this host knows it by.
    const names = { claude: (t: string) => `relay:${briefSkill(t)}`, codex: (t: string) => `$relay-${briefSkill(t)}` }[dir]!;
    for (const name of ["delegate", "ask"]) {
      const skill = fs.readFileSync(path.join(ADAPTERS, dir, "relay", "skills", dir === "codex" ? `relay-${name}` : name, "SKILL.md"), "utf8");
      for (const t of reached) assert.ok(skill.includes(`skill on writing for that agent (\`${names(t)}\`)`), `${h.id}'s ${name} skill points at ${names(t)}`);
    }
    for (const f of files(path.join(ADAPTERS, dir))) assert.doesNotMatch(fs.readFileSync(path.join(ADAPTERS, dir, f), "utf8"), /\{\{|write-for-</, `adapters/${dir}/${f} has no placeholder left`);
  }
  const snippet = fs.readFileSync(path.join(ADAPTERS, "codex", "AGENTS.snippet.md"), "utf8");
  for (const t of otherTargets("codex")) assert.ok(snippet.includes(`$relay-${briefSkill(t.id)}`), `the AGENTS.md snippet names the brief for ${t.id}`);
  assert.match(snippet, /relay's `brief` tool without the plugin/, "and the tool, for a session without the plugin");
});

test("briefs: skill descriptions stay plain YAML scalars", async () => {
  for (const h of HOSTS.filter((h) => h.adapter)) {
    const skills = path.join(ADAPTERS, h.adapter!.dir, "relay", "skills");
    for (const name of fs.readdirSync(skills)) {
      const text = fs.readFileSync(path.join(skills, name, "SKILL.md"), "utf8");
      const description = /^description: (.*)$/m.exec(text)?.[1];
      assert.ok(description, `${name} has a description`);
      assert.doesNotMatch(description, /: |^["'[{>|&*!%@`]| #/, `${name}'s description needs no YAML quoting`);
    }
  }
});

test("briefs: model notes are checked against at least the harness version relay is tested with", async () => {
  const { loadBriefs } = await import("../dist/targets/briefs.js");
  const briefs = loadBriefs();
  // Every family a host reaches as shipped has a brief.
  for (const t of TARGETS.filter((t) => t.enabledByDefault)) assert.ok(briefs[t.id], `${t.id} has a brief`);
  const version = (s: string) => /(\d+)\.(\d+)\.(\d+)/.exec(s)!.slice(1).map(Number);
  for (const [id, { models }] of Object.entries(briefs) as [keyof typeof TESTED, { models: { checked: string; checked_with: string } }][]) {
    const [a, b] = [version(models.checked_with), [...TESTED[id]]];
    assert.ok(a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2], `${id}'s notes were checked with ${a.join(".")}, at least ${b.join(".")}`);
    assert.ok(Date.parse(models.checked) <= Date.now(), `${id}'s checked date is not in the future`);
  }
});

test("briefs: the build refuses notes older than the tested version, and a brief without notes", async () => {
  const { loadBriefs } = await import("../dist/targets/briefs.js");
  const dir = scratch();
  try {
    const good = JSON.parse(fs.readFileSync(path.join(ADAPTERS, "briefs", "models.json"), "utf8"));
    for (const t of TARGETS.filter((t) => good[t.id])) fs.copyFileSync(path.join(ADAPTERS, "briefs", `${t.id}.md`), path.join(dir, `${t.id}.md`));
    const save = (data: unknown) => fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(data));
    save(good);
    assert.deepEqual(Object.keys(loadBriefs(dir)).sort(), Object.keys(good).sort());
    const id = Object.keys(good)[0];
    save({ ...good, [id]: { ...good[id], checked_with: "0.0.1" } });
    assert.throws(() => loadBriefs(dir), /older than the .* relay is tested with; check them again/);
    save({ ...good, [id]: { ...good[id], checked: "last week" } });
    assert.throws(() => loadBriefs(dir), /checked must be a date/);
    save({ ...good, [id]: { ...good[id], checked: "2026-02-30" } });
    assert.throws(() => loadBriefs(dir), /checked must be a date/, "not a calendar date");
    save({ ...good, [id]: { ...good[id], sources: ["http://example.com"] } });
    assert.throws(() => loadBriefs(dir), /sources must be https URLs/);
    const { [id]: _gone, ...rest } = good;
    save(rest);
    assert.throws(() => loadBriefs(dir), new RegExp(`no model notes for ${id}`));
    save(good);
    fs.writeFileSync(path.join(dir, `${id}.md`), "  \n");
    assert.throws(() => loadBriefs(dir), new RegExp(`no prompting brief for ${id}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("briefs: what they say about relay's report is said of jobs, since a question asks for none", async () => {
  const { loadBriefs } = await import("../dist/targets/briefs.js");
  for (const [id, { brief }] of Object.entries(loadBriefs()) as [string, { brief: string }][]) {
    for (const line of brief.split("\n").filter((l) => /relay's (?:required )?report|RELAY REPORT/i.test(l))) {
      assert.match(line, /\bin a job\b/i, `briefs/${id}.md says relay's report applies to jobs: ${line}`);
    }
  }
});

test("briefs: build.mjs writes the adapters however it is invoked, a path through a symlink included", () => {
  const dir = scratch();
  try {
    // A link to adapters/: node runs build.mjs by its real path, while argv names the link.
    fs.symlinkSync(ADAPTERS, path.join(dir, "link"));
    const out = path.join(dir, "out");
    const r = spawnSync(process.execPath, [path.join(dir, "link", "build.mjs"), out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /adapters written/);
    for (const h of HOSTS.filter((h) => h.adapter)) assert.deepEqual(files(path.join(out, h.adapter!.dir)), files(path.join(ADAPTERS, h.adapter!.dir)), `${h.id}'s adapter was written to the directory given`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("briefs: every host's sessions can read the brief for each family they reach, with relay's plugin or without it", async () => {
  const { loadBriefs } = await import("../dist/targets/briefs.js");
  const briefs = loadBriefs();
  const h = await harness();
  try {
    for (const host of HOSTS) {
      // The server as the host's registration starts it (relay mcp --host <family>), plugin or not.
      const s = await h.instance({ args: ["--host", host.target] });
      try {
        assert.ok((await s.tools()).includes("brief"), `${host.id}'s sessions have the brief tool`);
        const reached = otherTargets(host.target);
        for (const t of reached) {
          const r = await s.call("brief", { target: t.id });
          assert.equal(r.target, t.id);
          assert.ok(String(r.brief).includes(briefs[t.id]!.brief), `${host.id} reads ${t.id}'s brief, written by ${t.name}`);
          assert.ok(String(r.brief).includes(`Checked ${briefs[t.id]!.models.checked} with ${briefs[t.id]!.models.checked_with}.`), "with its dated model notes");
          for (const o of TARGETS.filter((o) => o.id !== t.id && briefs[o.id])) assert.ok(!String(r.brief).includes(briefs[o.id]!.brief), `and not ${o.id}'s`);
        }
        if (reached.length === 1) assert.equal((await s.call("brief")).target, reached[0].id, "with no target, the brief of the agent relay reaches by default");
        // Where a host has relay's plugin, the skill and the tool give the same text.
        if (host.adapter) {
          for (const t of reached) {
            const skill = fs.readFileSync(briefFile(ADAPTERS, host.adapter.dir, t.id), "utf8");
            assert.ok(skill.includes(String((await s.call("brief", { target: t.id })).brief)), `${host.id}'s ${briefSkill(t.id)} skill carries the tool's text`);
          }
        }
      } finally {
        await s.close();
      }
    }
    const anon = await h.instance({ host: null });
    try {
      assert.match(String((await anon.call("brief")).error), /name the agent you are writing for as target/i, "a caller relay cannot place names the agent");
      assert.equal((await anon.call("brief", { target: "codex" })).target, "codex");
    } finally {
      await anon.close();
    }
    // A registration without --host (an older install) is placed by its client's name once it has
    // introduced itself; the brief tool goes by that, not by what was known before (review X4).
    const legacy = await h.instance({ host: null, clientInfo: { name: "codex-mcp-client", version: "0.162.1" } });
    try {
      const r = await legacy.call("brief");
      assert.equal(r.target, "claude", JSON.stringify(r));
    } finally {
      await legacy.close();
    }
  } finally {
    await h.close();
  }
});

test("briefs: doctor's check says when a CLI has moved past the version the model notes were checked with, and warns a month on", async () => {
  const { notesBehind, RECHECK_DAYS } = await import("../dist/targets/briefs.js");
  const t = TARGETS[0];
  const notes = { checked: "2026-10-15", checked_with: "1.2.3 (harness)", effort: ["high"], notes: ["n"], sources: ["https://example.com"] };
  const day = (d: string) => new Date(`${d}T12:00:00Z`);
  assert.equal(notesBehind(t, notes, [1, 2, 3], day("2027-06-01")), null, "the version checked with: nothing to say, however long ago");
  assert.equal(notesBehind(t, notes, [1, 1, 9], day("2027-06-01")), null, "an older one: nothing to say (doctor warns about the CLI itself)");
  const soon = notesBehind(t, notes, [1, 2, 4], day("2026-10-20"));
  assert.equal(soon?.stale, false, "a newer patch within the month is said, not warned about");
  assert.match(soon!.text, new RegExp(`newer than the 1\\.2\\.3 \\(harness\\) the model notes in relay's prompting brief for ${t.name} were checked with \\(2026-10-15, 5 days ago\\)`));
  const later = notesBehind(t, notes, [1, 3, 0], new Date(Date.parse("2026-10-15T00:00:00Z") + RECHECK_DAYS * 86_400_000));
  assert.equal(later?.stale, true, `a newer CLI ${RECHECK_DAYS} days on is a warning`);
  assert.match(later!.text, /the CLI.s own model list decides, and a newer relay release brings newer notes/);
  assert.doesNotMatch(later!.text, /update it/, "never tells a user to edit the installed package");
});
