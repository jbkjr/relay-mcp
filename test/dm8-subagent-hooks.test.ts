import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { settingsAnswerForPerson } from "../dist/core/claude-settings.js";
import { harness, INTERACTIVE_CLAUDE, UNAVAILABLE_REPLY } from "./helpers.ts";

test("DM8 subagents: user, project and CLAUDE_CONFIG_DIR frontmatter hooks withhold confirm and adopt", async () => {
  const h = await harness();
  try {
    const owner = await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"] });
    const job = await owner.call("delegate", { target: "codex", task: "ORPHAN", mode: "write", background: false });
    await owner.close();
    const configDir = path.join(path.dirname(h.home), "claude-config");
    const env = { ...h.env, CLAUDE_CONFIG_DIR: configDir };
    const dirs = [path.join(h.env.HOME, ".claude", "agents"), path.join(h.repo, ".claude", "agents"), path.join(configDir, "agents")];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "operator.md");
      for (const event of ["PreToolUse", "PermissionRequest"]) for (const tool of ["confirm", "adopt"]) {
        fs.writeFileSync(file, `---\nname: operator\ndescription: test\nhooks:\n  ${event}:\n    - matcher: "mcp__relay__${tool}"\n      hooks:\n        - type: command\n          command: "echo SECRET-HOOK-COMMAND"\n---\nSECRET-BODY\n`);
        const consent = settingsAnswerForPerson(env, h.repo, [], []);
        assert.match(consent.confirm ?? "", /subagent definition.*hooks/);
        assert.ok(consent.confirm!.includes(file));
        assert.equal(consent.dialog, null);
        assert.doesNotMatch(JSON.stringify(consent), /SECRET/);
        const host = await h.instance({ ...INTERACTIVE_CLAUDE, env: { ...INTERACTIVE_CLAUDE.env, CLAUDE_CONFIG_DIR: configDir }, args: ["--host", "claude"] });
        const tools = await host.tools();
        assert.ok(!tools.includes("confirm"));
        // adopt remains available for terminal-ticket recovery, but never trusts this prompt.
        const status = await host.call("status");
        assert.deepEqual(await host.call("adopt", { run_id: job.run_id, into_session: status.session.fingerprint, ...job.adoption }), UNAVAILABLE_REPLY);
        await host.close();
      }
      fs.unlinkSync(file);
    }
  } finally { await h.close(); }
});

test("DM8 subagents: only frontmatter counts; all hook forms and unreadable definitions fail closed", async () => {
  const h = await harness();
  try {
    const dir = path.join(h.repo, ".claude", "agents"); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "worker.md");
    const consent = () => settingsAnswerForPerson(h.env, h.repo, [], []);
    for (const front of ["name: worker", 'name: worker\ndescription: "normal description"\ntools: Read, Bash', "name: worker\ndescription: |\n  ordinary multiline description"]) {
      fs.writeFileSync(file, `---\n${front}\n---\nhooks:\n  PreToolUse:\n    - matcher: mcp__relay__confirm\n`);
      assert.deepEqual(consent(), { dialog: null, confirm: null });
    }
    for (const front of ["hooks: [", "hooks: {}", "hooks:\n  PreToolUse:\n    - matcher: mcp__email__send\n      hooks: []", "hooks:\n  PreToolUse:\n    - hooks: []", 'hooks: {PermissionRequest: [{matcher: "[", hooks: []}]}', 'hooks: {PreToolUse: [{matcher: "mcp__relay__adopt", hooks: []}]}', '"hooks": {}', "'hooks': {}", "hooks: &hooked {}", "hooks: *hooked", 'alias: &hooked {PreToolUse: []}\nhooks: *hooked', '{hooks: {PreToolUse: []}}', '"ho\\u006fks": {}', 'name: worker\n\thooks: {}']) {
      fs.writeFileSync(file, `---\n${front}\n---\nbody\n`);
      assert.ok(consent().confirm, front);
    }
    fs.writeFileSync(file, "---\nname: unterminated\n");
    assert.match(consent().confirm!, /could not read/);
    for (const bytes of [Buffer.from("\ufeff---\nname: worker\n---\n"), Buffer.from("---\nname: worker\n---\n", "utf16le"), Buffer.from([45,45,45,10,0xff,10,45,45,45,10])]) {
      fs.writeFileSync(file, bytes);
      assert.match(consent().confirm!, /could not read/);
    }
    fs.unlinkSync(file); fs.mkdirSync(file);
    assert.match(consent().confirm!, /could not read/);
  } finally { await h.close(); }
});
