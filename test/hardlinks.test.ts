import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ConfinementRefused, prepareLaunch, type Confinement } from "../dist/confine/index.js";
import { hardLinksOutside } from "../dist/confine/hardlinks.js";
import { hardLinkProblem } from "../dist/core/worktree.js";
import { neverGrantProblem, resolveNeverPolicy } from "../dist/core/never-policy.js";
// The test process gets a scratch HOME as soon as helpers.ts loads.
import { harness, nonTempScratch, scratchOnly, task } from "./helpers.ts";

function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-hardlinks-")));
  const wt = path.join(root, "wt");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(wt, "src", "deep"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  fs.writeFileSync(path.join(wt, "src", "a.ts"), "a\n");
  fs.writeFileSync(path.join(wt, "src", "deep", "b.ts"), "b\n");
  fs.writeFileSync(path.join(outside, "victim"), "outside\n");
  return { root, wt, outside, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("hard links: a file also linked from outside the worktree is found; links wholly inside are not", () => {
  const t = tree();
  try {
    assert.deepEqual(hardLinksOutside([t.wt], { denied: [path.join(t.wt, ".git")] }).linked, []);
    assert.equal(hardLinksOutside([t.wt], { denied: [path.join(t.wt, ".git")] }).files, 2, "the .git pointer is not walked");

    // Two names for one file, both inside: harmless.
    fs.linkSync(path.join(t.wt, "src", "a.ts"), path.join(t.wt, "src", "deep", "a-again.ts"));
    assert.deepEqual(hardLinksOutside([t.wt], { denied: [path.join(t.wt, ".git")] }).linked, []);

    // A symlink to the outside file is not a hard link, and a symlinked directory is not followed.
    fs.symlinkSync(path.join(t.outside, "victim"), path.join(t.wt, "sym"));
    fs.linkSync(path.join(t.outside, "victim"), path.join(t.outside, "victim2"));
    fs.symlinkSync(t.outside, path.join(t.wt, "outside-dir"));
    assert.deepEqual(hardLinksOutside([t.wt], { denied: [path.join(t.wt, ".git")] }).linked, []);

    fs.linkSync(path.join(t.outside, "victim"), path.join(t.wt, "src", "deep", "hl"));
    assert.deepEqual(hardLinksOutside([t.wt], { denied: [path.join(t.wt, ".git")] }).linked, [path.join(t.wt, "src", "deep", "hl")]);
    fs.rmSync(path.join(t.wt, "src", "deep", "hl"));

    // An inside file with a second name outside, even with a third inside.
    fs.linkSync(path.join(t.wt, "src", "a.ts"), path.join(t.outside, "a-out"));
    assert.equal(hardLinksOutside([t.wt], { denied: [path.join(t.wt, ".git")] }).linked.length, 1);
    assert.equal(hardLinksOutside([t.wt], { denied: [path.join(t.wt, ".git")], limit: 10 }).linked.length, 1);
  } finally {
    t.done();
  }
});

test("hard links: a name under a .git directory counts as outside; other directories named .git do not hide files", () => {
  const t = tree();
  try {
    fs.rmSync(path.join(t.wt, ".git"));
    fs.mkdirSync(path.join(t.wt, ".git", "objects"), { recursive: true });
    fs.linkSync(path.join(t.wt, "src", "a.ts"), path.join(t.wt, ".git", "objects", "x"));
    assert.deepEqual(hardLinksOutside([t.wt], { denied: [path.join(t.wt, ".git")] }).linked, [path.join(t.wt, "src", "a.ts")]);
    // Only the top-level .git is skipped.
    fs.mkdirSync(path.join(t.wt, "vendor", ".git"), { recursive: true });
    fs.linkSync(path.join(t.outside, "victim"), path.join(t.wt, "vendor", ".git", "hl"));
    assert.equal(hardLinksOutside([t.wt], { denied: [path.join(t.wt, ".git")], limit: 10 }).linked.length, 2);
  } finally {
    t.done();
  }
});

test("hard links: a write turn with one is refused before anything is wrapped or probed; a read turn is not checked", async () => {
  const t = tree();
  try {
    fs.linkSync(path.join(t.outside, "victim"), path.join(t.wt, "hl"));
    let wrapped = false;
    const mech: Confinement = {
      id: "spy", unavailable: () => null, confined: () => false,
      wrap: () => {
        wrapped = true;
        throw new Error("wrapped");
      },
    };
    fs.mkdirSync(path.join(t.root, "tmp"));
    const policy = { worktree: t.wt, worktreeWritable: true, tmpDir: path.join(t.root, "tmp"), denied: [], network: { mode: "on" as const } };
    await assert.rejects(prepareLaunch(mech, policy, "/bin/sh", []), (err: ConfinementRefused) => {
      assert.ok(err instanceof ConfinementRefused);
      assert.equal(err.check, "hardlink");
      assert.match(err.message, /hl/);
      return true;
    });
    assert.equal(wrapped, false);
    await assert.rejects(prepareLaunch(mech, { ...policy, worktreeWritable: false }, "/bin/sh", []), /wrapped/, "a read turn goes on to wrap");
  } finally {
    t.done();
  }
});

test("hard links: the walk is fast on a real tree (this checkout, node_modules included)", () => {
  const repo = path.resolve(import.meta.dirname, "..");
  const r = hardLinksOutside([repo], { denied: [path.join(repo, ".git")] });
  console.log(`hard-link walk: ${r.files} files in ${r.ms} ms`);
  assert.ok(r.files > 100);
});

test("hard links: every writable root is checked, and names the sandbox hard-denies count as outside (review r_faba9d17 C5/X2)", async () => {
  const t = tree();
  const control = path.join(t.root, "control");
  const grant = path.join(t.root, "grant");
  const tmp = path.join(t.root, "tmp");
  for (const d of [control, grant, tmp]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(control, "relay.db"), "secret\n");
  const saved = process.env.RELAY_HOME;
  process.env.RELAY_HOME = control;
  try {
    const mech: Confinement = { id: "spy", unavailable: () => null, confined: () => false, wrap: () => { throw new Error("wrapped"); } };
    const policy = { worktree: t.wt, worktreeWritable: true, writable: [grant], tmpDir: tmp, denied: [control], network: { mode: "on" as const } };
    const refused = (p: object, file: string) => assert.rejects(prepareLaunch(mech, p as never, "/bin/sh", []), (err: ConfinementRefused) => {
      assert.equal(err.check, "hardlink", err.message);
      assert.ok(err.message.includes(file), err.message);
      return true;
    });
    await assert.rejects(prepareLaunch(mech, policy, "/bin/sh", []), /wrapped/, "clean: goes on to wrap");
    // GPT's reproduction: a granted directory holding a link to an outside file.
    fs.linkSync(path.join(t.outside, "victim"), path.join(grant, "linked"));
    await refused(policy, path.join(grant, "linked"));
    fs.rmSync(path.join(grant, "linked"));
    // The worktree's .git pointer, which the sandbox denies, aliased by a name in the worktree it allows.
    fs.linkSync(path.join(t.wt, ".git"), path.join(t.wt, "src", "git-alias"));
    await refused(policy, path.join(t.wt, "src", "git-alias"));
    fs.rmSync(path.join(t.wt, "src", "git-alias"));
    // A file of a denied directory aliased into the temp dir: checked on a read turn too.
    fs.linkSync(path.join(control, "relay.db"), path.join(tmp, "db-alias"));
    await refused({ ...policy, worktreeWritable: false }, path.join(tmp, "db-alias"));
    fs.rmSync(path.join(tmp, "db-alias"));
    // Harness configuration the sandbox protects at the top of a writable root, aliased by an ordinary
    // name there (review r_7feaed80 X1): a write through the alias would plant the configuration.
    fs.mkdirSync(path.join(grant, ".vscode"));
    fs.writeFileSync(path.join(grant, ".vscode", "settings.json"), "{}\n");
    fs.linkSync(path.join(grant, ".vscode", "settings.json"), path.join(grant, "settings-copy.json"));
    await refused(policy, path.join(grant, "settings-copy.json"));
    fs.rmSync(path.join(grant, "settings-copy.json"));
    fs.writeFileSync(path.join(t.wt, ".mcp.json"), "{}\n");
    fs.linkSync(path.join(t.wt, ".mcp.json"), path.join(t.wt, "src", "mcp-alias.json"));
    await refused(policy, path.join(t.wt, "src", "mcp-alias.json"));
    fs.rmSync(path.join(t.wt, "src", "mcp-alias.json"));
    await assert.rejects(prepareLaunch(mech, policy, "/bin/sh", []), /wrapped/, "the configuration itself, with no alias, is no reason to refuse");
    // Two names both in writable roots are harmless, even across roots.
    fs.writeFileSync(path.join(grant, "shared"), "x");
    fs.linkSync(path.join(grant, "shared"), path.join(t.wt, "shared"));
    await assert.rejects(prepareLaunch(mech, policy, "/bin/sh", []), /wrapped/);
  } finally {
    if (saved === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = saved;
    t.done();
  }
});

test("hard links: native launch and grant screens refuse a protected config aliased by an ordinary name in the same root", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".relay-hardlinks-config-"));
  try {
    fs.writeFileSync(path.join(root, ".mcp.json"), "{}\n");
    const alias = path.join(root, "ordinary.json");
    fs.linkSync(path.join(root, ".mcp.json"), alias);
    const node = { target: "claude", cwd: root, worktree: root } as never;
    assert.match(hardLinkProblem(node, "write", false, null, undefined)!, /ordinary\.json is a hard link/);
    assert.match(neverGrantProblem(resolveNeverPolicy({ builtins: false }), { write_paths: [root] })!, /outside hard link.*ordinary\.json/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const target of ["claude", "codex"]) {
  test(`hard links: a ${target} write turn does not start while its worktree or a granted directory holds a hard link to a file outside them`, async () => {
    const dir = nonTempScratch("relay-hardlinks-native-");
    const granted = path.join(dir, "granted");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(granted);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "victim"), "outside\n");
    const h = await harness([
      { match: task("LINKED"), steps: [{ write: "made.txt" }, { reply: "done" }] },
      { match: "again", steps: [{ reply: "again" }] },
    ]);
    try {
      const job = await h.call("delegate", { target, task: "LINKED", mode: "write", background: false });
      assert.equal(job.status, "done");
      const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree as string;
      fs.linkSync(path.join(outside, "victim"), path.join(wt, "hl.txt"));
      await h.call("resume", { job_id: job.job_id, message: "again" });
      const refused = await h.call("status", { id: job.job_id, wait_s: 20 });
      assert.equal(refused.status, "failed");
      assert.match(refused.error, /hard link to a file outside the job's worktree/);
      assert.equal(h.starts().length, 1, "the turn was not started");
      fs.rmSync(path.join(wt, "hl.txt"));

      // The worktree's `.git` file, which the sandbox keeps the agent from writing, aliased by a name it may write.
      fs.linkSync(path.join(wt, ".git"), path.join(wt, "git-alias"));
      await h.call("resume", { job_id: job.job_id, message: "again" });
      const aliased = await h.call("status", { id: job.job_id, wait_s: 20 });
      assert.equal(aliased.status, "failed");
      assert.match(aliased.error, /git-alias is a hard link to a file outside the job's worktree/);
      assert.equal(h.starts().length, 1, "the turn was not started");
      fs.rmSync(path.join(wt, "git-alias"));

      // A protected harness config and its ordinary alias are both inside the writable root, but
      // the path-based sandbox cannot let the alias mutate the protected name.
      fs.writeFileSync(path.join(wt, ".mcp.json"), "{}\n");
      fs.linkSync(path.join(wt, ".mcp.json"), path.join(wt, "mcp-alias.json"));
      await h.call("resume", { job_id: job.job_id, message: "again" });
      const configAliased = await h.call("status", { id: job.job_id, wait_s: 20 });
      assert.equal(configAliased.status, "failed");
      assert.match(configAliased.error, /mcp-alias\.json is a hard link/);
      assert.equal(h.starts().length, 1, "the protected-config alias was refused before launch");
      fs.rmSync(path.join(wt, "mcp-alias.json"));

      // In a granted directory too; a link between the worktree and a granted directory is harmless.
      fs.linkSync(path.join(outside, "victim"), path.join(granted, "hl"));
      const g = await h.call("delegate", { target, task: "LINKED", mode: "write", background: false, grant: { write_paths: [granted] } });
      assert.equal(g.refused, true, JSON.stringify(g));
      assert.match(g.reason, /outside hard link/);
      assert.equal(h.starts().length, 1, "grant admission refused the hard link before another turn started");
      fs.rmSync(path.join(granted, "hl"));
      fs.writeFileSync(path.join(granted, ".mcp.json"), "{}\n");
      fs.linkSync(path.join(granted, ".mcp.json"), path.join(granted, "mcp-alias.json"));
      const protectedGrant = await h.call("delegate", { target, task: "LINKED", mode: "write", background: false, grant: { write_paths: [granted] } });
      assert.equal(protectedGrant.refused, true, JSON.stringify(protectedGrant));
      assert.match(protectedGrant.reason, /outside hard link/);
      fs.rmSync(path.join(granted, "mcp-alias.json"));
      fs.linkSync(path.join(wt, "made.txt"), path.join(granted, "made-too"));
      await h.call("resume", { job_id: job.job_id, message: "again", grant: { write_paths: [granted] } });
      assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
    } finally {
      await h.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
