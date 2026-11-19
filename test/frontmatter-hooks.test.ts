// The frontmatter check behind the skill, command and agent consent scans (hookedFrontmatter).
// Each case notes how Claude Code 2.1.326 reads it: its pipeline (the block up to the first `---`,
// Bun 1.4.4's YAML parser, then one retry with `key: value` lines quoted) was run on every case
// below. `claude: "hooks"` means Claude reads a top-level hooks key; relay must withhold for all of
// those. `claude: "none"` means it does not; relay accepts it or withholds as a stated margin.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hookedFrontmatter, settingsAnswerForPerson } from "../dist/core/claude-settings.js";
import { harness, INTERACTIVE_CLAUDE } from "./helpers.ts";

type Case = { front: string; claude: "hooks" | "none"; relay: "accept" | "withhold" };

const CASES: Case[] = [
  // `:` not followed by a space is part of a plain scalar (claude-plugins-official commands).
  { front: "allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)", claude: "none", relay: "accept" },
  { front: "allowed-tools: Bash:*", claude: "none", relay: "accept" },
  { front: "allowed-tools: Bash(git add:*", claude: "none", relay: "accept" },
  // allowed-tools lists, flow and block style.
  { front: 'allowed-tools: [Read, Grep, "Bash(test -f x:*)"]', claude: "none", relay: "accept" },
  { front: 'tools: ["Read", "Grep"]\nmodel: inherit', claude: "none", relay: "accept" },
  { front: "allowed-tools:\n  - Read\n  - Bash(git add:*)", claude: "none", relay: "accept" },
  { front: "allowed-tools:\n- Read\n- Grep\nname: x", claude: "none", relay: "accept" },
  { front: 'allowed-tools:\n  [\n    "Read",\n    \'Write\',\n  ]', claude: "none", relay: "accept" },
  { front: "argument-hint: [project-name]", claude: "none", relay: "accept" },
  // Invalid YAML that Claude's retry reads as one string.
  { front: "argument-hint: [system] [--source <path>]", claude: "none", relay: "accept" },
  // Multi-line quoted and plain values, and a `: ` inside a value.
  { front: 'description:\n  "Solve competition math problems\n  with adversarial review."', claude: "none", relay: "accept" },
  { front: 'description: "x\\\n  y"', claude: "none", relay: "accept" },
  { front: "description: Use when: you need it\nmodel: inherit", claude: "none", relay: "accept" },
  { front: "description: a long line\n  that continues: here", claude: "none", relay: "accept" },
  { front: "description: >\n  folded text\nname: x", claude: "none", relay: "accept" },
  { front: "description: a --- b\nx: 1", claude: "none", relay: "accept" },
  { front: "metadata:\n  author: someone\n  tags:\n    - a", claude: "none", relay: "accept" },

  // Hooks keys in every spelling Claude reads: always withhold.
  { front: "hooks: {}", claude: "hooks", relay: "withhold" },
  { front: "name: x\nhooks:\n  PreToolUse: []", claude: "hooks", relay: "withhold" },
  { front: '"hooks": {}', claude: "hooks", relay: "withhold" },
  { front: "'hooks': {}", claude: "hooks", relay: "withhold" },
  { front: '"hoo\\u006bs": {}', claude: "hooks", relay: "withhold" },
  { front: '"hoo\\x6bs": {}', claude: "hooks", relay: "withhold" },
  { front: "? hooks\n: {}", claude: "hooks", relay: "withhold" },
  { front: "? hooks # c\n: {}", claude: "hooks", relay: "withhold" },
  { front: "a: &x hooks\n*x : {}", claude: "hooks", relay: "withhold" },
  { front: "a: [&x hooks]\n*x : {}", claude: "hooks", relay: "withhold" },
  { front: "<<: {hooks: {}}", claude: "hooks", relay: "withhold" },
  { front: "a: &m {hooks: {}}\n<<: *m", claude: "hooks", relay: "withhold" },
  { front: "!!str hooks: {}", claude: "hooks", relay: "withhold" },
  { front: "{hooks: {}}", claude: "hooks", relay: "withhold" },
  { front: "  hooks: {}", claude: "hooks", relay: "withhold" },
  // A lone carriage return is a YAML line break.
  { front: 'description: x\r"hooks": {}', claude: "hooks", relay: "withhold" },
  // Claude's retry quotes the first line, which closes the string the second line was in.
  { front: 'a: [x] "q\nhooks: 1"', claude: "hooks", relay: "withhold" },
  { front: 'a: [x] "q\n"hooks": 1"', claude: "hooks", relay: "withhold" },
  { front: "a: [x] [\n\"hooks\": 1", claude: "hooks", relay: "withhold" },

  // Lookalikes Claude does not read as hooks: withheld as margin (rule 1 or unmodeled YAML).
  { front: 'description: "see the\n  hooks: section"', claude: "none", relay: "withhold" },
  { front: "description: >\n  hooks: folded", claude: "none", relay: "withhold" },
  { front: "description: 'it''s hooks: x'", claude: "none", relay: "withhold" },
  { front: "description: ok\n# hooks: x", claude: "none", relay: "withhold" },
  { front: "Hooks: {}", claude: "none", relay: "withhold" },
  { front: 'description: "abc\nhooks: {}"', claude: "none", relay: "withhold" },
  { front: 'description: "abc\n"hooks": {}"', claude: "none", relay: "withhold" },
  { front: 'description: "abc ---\nhoo: x"', claude: "none", relay: "withhold" },
  { front: "name: x\n  hooks: {}", claude: "none", relay: "withhold" },
  { front: "a: 1\na: 2", claude: "none", relay: "withhold" },
  { front: "name: x\n%YAML 1.2", claude: "none", relay: "withhold" },
  { front: "name: x\n...\nhooks: {}", claude: "none", relay: "withhold" },
  { front: "a: [a: b]", claude: "none", relay: "withhold" },
  { front: "a: [x, [y]]", claude: "none", relay: "withhold" },
  { front: "a: [x # c\n  ]", claude: "none", relay: "withhold" },
  { front: "a: {b: c}", claude: "none", relay: "withhold" },
  { front: "a: &anchor x", claude: "none", relay: "withhold" },
  { front: "a: *alias", claude: "none", relay: "withhold" },
  { front: "a: !tag x", claude: "none", relay: "withhold" },
  { front: 'a: "x" y\n  more', claude: "none", relay: "withhold" },
  { front: "a: [x] y\n  hooks: 1", claude: "none", relay: "withhold" },
  { front: 'description: "unterminated\nname: x', claude: "none", relay: "withhold" },
];

test("frontmatter check: Claude-read hooks keys always withhold; plain colons, flow and block lists do not", () => {
  for (const c of CASES) {
    assert.equal(hookedFrontmatter(c.front), c.relay === "withhold", JSON.stringify(c.front));
    if (c.claude === "hooks") assert.equal(c.relay, "withhold", `fixture: Claude reads hooks in ${JSON.stringify(c.front)}`);
  }
});

test("frontmatter check: claude-plugins-official commands with `:*` permissions keep the dialog and confirm; a hooks key still withholds", async () => {
  const h = await harness();
  try {
    const root = path.join(h.env.HOME, ".claude/plugins/cache/claude-plugins-official/commit-commands/1.0.1");
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "commit-commands" }));
    const command = (name: string, front: string) => {
      fs.mkdirSync(path.join(root, "commands"), { recursive: true });
      fs.writeFileSync(path.join(root, "commands", `${name}.md`), `---\n${front}\n---\nhooks: in the body only\n`);
    };
    command("commit", "allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)\ndescription: Create a git commit");
    command("review", 'allowed-tools: ["Bash", "Glob", "Grep", "Read", "Task"]\nargument-hint: [system] [--source <path>]');
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, "agents/analyzer.md"), '---\nname: analyzer\ndescription: Use when: reviewing\ntools: ["Read", "Grep"]\n---\n');
    fs.mkdirSync(path.join(root, "skills/olympiad"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills/olympiad/SKILL.md"), '---\nname: olympiad\ndescription:\n  "Solve problems\n  carefully."\n---\n');
    const consent = () => settingsAnswerForPerson(h.env, h.repo, [], []);
    assert.deepEqual(consent(), { confirm: null, dialog: null });
    const host = await h.instance({ ...INTERACTIVE_CLAUDE, host: null, elicit: () => ({ action: "cancel" }) });
    try {
      assert.equal((await host.call("status")).approval_dialogs.offered, true);
      assert.ok((await host.tools()).includes("confirm"));
    } finally { await host.close(); }
    for (const front of ["allowed-tools: Bash(git add:*)\nhooks:\n  PreToolUse: []", 'allowed-tools: [Read]\n"hooks": {}', "allowed-tools: Bash(git add:*)\n? hooks\n: {}"]) {
      command("commit", front);
      const c = consent();
      assert.match(c.confirm ?? "", /commands\/commit\.md has hooks or frontmatter relay cannot rule out/, front);
      assert.ok(c.dialog, front);
    }
  } finally { await h.close(); }
});
