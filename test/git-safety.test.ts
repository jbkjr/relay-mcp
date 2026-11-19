// Relay's git runs outside any sandbox, with the user's access, for worktrees an agent has had the
// run of. These tests are about what an agent can leave there to steer it: the worktree's `.git`
// file, files that name configured drivers, a link at a file relay appends to, names that read as
// patterns, and Git LFS's downloads. Every file they touch is scratch.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { harness, scratchOnly, task, until, type Harness, type Rec } from "./helpers.ts";

const scratch = () => scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gitsafe-"))));
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** A script that records each time it runs, and passes its input through as a filter must. */
function recorder(dir: string, name: string): { script: string; ran: () => boolean } {
  const marker = path.join(dir, `${name}.ran`);
  const script = path.join(dir, `${name}.sh`);
  fs.writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, { mode: 0o755 });
  return { script, ran: () => fs.existsSync(marker) };
}
const worktreeOf = (h: Harness, id: string) => h.sql("SELECT worktree FROM nodes WHERE id = ?", id)[0].worktree as string;
const endOf = (h: Harness, target: string) => h.ends().find((e: Rec) => e.target === target)!;

test("git safety: a job worktree's git directory comes from the repository's records, and a changed .git file is refused", async () => {
  const { jobTree } = await import("../dist/core/git.js");
  const root = scratch();
  try {
    const repo = path.join(root, "repo");
    const wt = path.join(root, "wt");
    fs.mkdirSync(repo);
    gitIn(repo, "init", "-q", "-b", "main");
    gitIn(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i");
    gitIn(repo, "worktree", "add", "-q", "-b", "x", wt);
    const admin = fs.realpathSync(path.join(repo, ".git", "worktrees", "wt"));
    assert.deepEqual(jobTree(repo, wt), {
      worktree: wt, gitDir: admin, commonDir: fs.realpathSync(path.join(repo, ".git")), env: { GIT_DIR: admin, GIT_WORK_TREE: wt },
    });

    const dotGit = path.join(wt, ".git");
    const original = fs.readFileSync(dotGit, "utf8");
    // A repository of the agent's own, which would bring its own config.
    const fake = path.join(root, "fake");
    fs.mkdirSync(fake);
    gitIn(fake, "init", "-q");
    const cases: [string, () => void][] = [
      ["another git directory", () => fs.writeFileSync(dotGit, `gitdir: ${path.join(fake, ".git")}\n`)],
      ["a relative path to another", () => fs.writeFileSync(dotGit, "gitdir: ../fake/.git\n")],
      ["the right line with another after it", () => fs.writeFileSync(dotGit, `${original}gitdir: ${path.join(fake, ".git")}\n`)],
      ["a link to a copy of the right file", () => {
        fs.writeFileSync(path.join(root, "copy"), original);
        fs.rmSync(dotGit);
        fs.symlinkSync(path.join(root, "copy"), dotGit);
      }],
      ["a directory", () => {
        fs.rmSync(dotGit);
        fs.mkdirSync(dotGit);
      }],
      ["a FIFO", () => {
        fs.rmSync(dotGit);
        execFileSync("mkfifo", [dotGit]);
      }],
      ["missing", () => fs.rmSync(dotGit)],
    ];
    for (const [name, change] of cases) {
      change();
      assert.match((jobTree(repo, wt) as { error?: string }).error ?? "", /the job's agent, which can write there, changed it/, name);
      fs.rmSync(dotGit, { recursive: true, force: true });
      fs.writeFileSync(dotGit, original);
      assert.equal((jobTree(repo, wt) as { gitDir?: string }).gitDir, admin, `${name}: put back, it is accepted again`);
    }

    // A directory the repository has no record of, even with a .git file naming a real git directory.
    const stray = path.join(root, "stray");
    fs.mkdirSync(stray);
    fs.writeFileSync(path.join(stray, ".git"), original);
    assert.match((jobTree(repo, stray) as { error: string }).error, /has no record of the worktree/);

    // A record git wrote with a relative path (worktree.useRelativePaths), where this git can.
    const rel = path.join(root, "rel");
    let relative = true;
    try {
      gitIn(repo, "worktree", "add", "-q", "--relative-paths", "-b", "y", rel);
    } catch {
      relative = false;
    }
    if (relative) assert.equal((jobTree(repo, rel) as { gitDir?: string }).gitDir, fs.realpathSync(path.join(repo, ".git", "worktrees", "rel")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("git safety: after an agent points its worktree's .git at a repository of its own, relay runs no git for the job until it is put back", async () => {
  // The agent clones the repository into its worktree, hides the clone, and points .git at it.
  const tamper = "common=$(git rev-parse --path-format=absolute --git-common-dir) && git clone -q --no-hardlinks \"$common\" .fakerepo && printf '.fakerepo/\\n' > .gitignore && printf 'gitdir: .fakerepo/.git\\n' > .git";
  const h = await harness([
    { match: task("TAMPER"), steps: [{ write: "work.txt", content: "w\n" }, { run: tamper }, { reply: "done" }] },
    { match: "again", steps: [{ reply: "again" }] },
  ]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "TAMPER", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const wt = worktreeOf(h, job.job_id);
    assert.match(job.result.checkpoint_error, /\.git is no longer the file git made for this worktree.*changed it/);
    assert.equal(job.result.files_changed_git, undefined, "relay reports nothing git said through the agent's repository");
    // Nothing was committed, in the repository or in the agent's.
    assert.equal(gitIn(h.repo, "rev-parse", job.branch), job.base_sha);
    assert.doesNotMatch(gitIn(path.join(wt, ".fakerepo"), "log", "--all", "--format=%s"), /relay: checkpoint/);
    assert.ok(fs.existsSync(path.join(wt, "work.txt")), "the work is still there");

    const merged = await h.call("merge", { job_id: job.job_id });
    assert.equal(merged.status, "error");
    assert.match(merged.error, /changed it/);
    const cleaned = JSON.parse(h.cli("clean"));
    assert.equal(cleaned.worktrees_removed, 0);
    assert.match(cleaned.worktrees_kept.join("\n"), new RegExp(`${job.job_id}: .*changed it`));
    assert.ok(fs.existsSync(wt), "a worktree relay will not run git for is not removed");

    // No further turn starts in it.
    await h.call("resume", { job_id: job.job_id, message: "again" });
    const refused = await h.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(refused.status, "failed");
    assert.match(refused.error, /changed it/);
    assert.equal(h.starts().length, 1);

    // Put back the way the error says, the job goes on, and its work is committed.
    fs.rmSync(path.join(wt, ".git"), { recursive: true, force: true });
    try {
      gitIn(h.repo, "worktree", "repair", wt);
    } catch {
      // git reports the file it found broken, and repairs it all the same.
    }
    await h.call("resume", { job_id: job.job_id, message: "again" });
    const after = await h.call("status", { id: job.job_id, wait_s: 20 });
    assert.equal(after.status, "done", JSON.stringify(after));
    assert.deepEqual(after.result.files_changed_git.sort(), [".gitignore", "work.txt"]);
  } finally {
    await h.close();
  }
});

test("git safety: an agent that changed its worktree's .git cannot have relay branch a new job, or merge one, through it", async () => {
  const dir = scratch();
  const smudge = recorder(dir, "smudge");
  // A repository of the agent's own whose main worktree alone (config.worktree) runs a smudge
  // filter, and a linked worktree of it that the agent's .git is pointed at: from there no filter
  // shows, but the repository's main worktree, where git worktree add would run, has one.
  const evil = [
    "set -e",
    "mkdir .evil && cd .evil && git init -q -b main && git config extensions.worktreeConfig true",
    "printf '* filter=evil\\n' > .gitattributes && echo x > f.txt && git add -A && git -c user.name=a -c user.email=a@a commit -q -m evil",
    "git worktree add -q ../.evilwt -b side && adm=$(cd ../.evilwt && git rev-parse --absolute-git-dir)",
    `git config --worktree filter.evil.smudge 'sh ${smudge.script}' && git config --worktree filter.evil.clean cat`,
    "cd .. && printf 'gitdir: %s\\n' \"$adm\" > .git",
  ].join("\n");
  const h = await harness([
    { match: task("NESTER"), steps: [{ run: evil }, { call: "delegate", args: { target: "codex", task: "INNER", mode: "write", background: false } }, { reply: "{{last}}" }] },
    { match: task("OUTER"), steps: [
      { call: "delegate", args: { target: "codex", task: "INNER", mode: "write", background: false }, as: "inner" },
      { run: "printf 'gitdir: /nowhere\\n' > .git" },
      { call: "merge", args: { job_id: "{{inner.job_id}}" } },
      { reply: "{{last}}" },
    ] },
    { match: task("INNER"), steps: [{ write: "inner.txt", content: "inner\n" }, { reply: "done" }] },
  ]);
  try {
    const nester = await h.call("delegate", { target: "claude", task: "NESTER", mode: "write", background: false });
    const started = endOf(h, "claude").calls[0].result;
    assert.equal(started.refused, true, JSON.stringify(started));
    assert.match(started.reason, /changed it/);
    assert.equal(smudge.ran(), false, "the agent's filter never ran");
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM nodes WHERE parent_id = ?", nester.job_id)[0].n, 0);

    const outer = await h.call("delegate", { target: "claude", task: "OUTER", mode: "write", background: false });
    const merge = h.ends().filter((e: Rec) => e.target === "claude")[1].calls[1].result;
    assert.equal(merge.status, "error", JSON.stringify(merge));
    assert.match(merge.error, /nothing was merged: .*changed it/);
    const inner = h.sql("SELECT id, branch FROM nodes WHERE parent_id = ?", outer.job_id)[0];
    assert.equal(gitIn(h.repo, "branch", "--contains", inner.branch, "--format=%(refname:short)"), inner.branch, "the inner branch was merged nowhere");
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git safety: merge drivers are refused like content filters, unless trusted; diff drivers and an external diff are not", async () => {
  const { filterRefusal } = await import("../dist/core/git.js");
  const h = await harness([{ steps: [{ write: "a.txt", content: "a\n" }, { reply: "done" }] }]);
  try {
    const set = (k: string, v: string) => gitIn(h.repo, "config", k, v);
    const unset = (k: string) => gitIn(h.repo, "config", "--unset", k);
    // Git LFS's own filter stays accepted; its name on another kind of key does not make that key Git LFS's.
    set("filter.lfs.clean", "git-lfs clean -- %f");
    // Relay's own diffs pass --no-ext-diff and --no-textconv, so these are no reason to refuse a repository.
    for (const key of ["diff.evil.textconv", "diff.evil.command", "diff.external"]) {
      set(key, "sh ./helper.sh");
      assert.equal(filterRefusal(h.repo, false), null, key);
      unset(key);
    }
    for (const [key, kind] of [["merge.evil.driver", "a merge driver"], ["merge.lfs.driver", "a merge driver"]]) {
      set(key, key === "merge.lfs.driver" ? "git-lfs clean -- %f" : "sh ./helper.sh");
      // The one command, and nothing else: Git LFS's filter is not listed.
      assert.match(filterRefusal(h.repo, false)!, new RegExp(`runs ${kind} \\(${key.replace(/\./g, "\\.")} = "[^"]*"\\) that relay`), key);
      assert.equal(filterRefusal(h.repo, true), null, `${key}: trusted`);
      const no = await h.call("delegate", { target: "codex", task: "x", mode: "write", background: false });
      assert.match(no.reason, new RegExp(`${kind} \\(${key.replace(/\./g, "\\.")}`), key);
      unset(key);
    }
    assert.equal(h.starts().length, 0);
    assert.equal(filterRefusal(h.repo, false), null);
  } finally {
    await h.close();
  }
});

test("git safety: with drivers trusted, relay's own diffs still run no external diff and no textconv", async () => {
  const dir = scratch();
  const ext = recorder(dir, "external");
  const conv = recorder(dir, "textconv");
  const h = await harness([{ match: task("DIFFED"), steps: [{ write: "a.txt", content: "changed\n" }, { reply: "done" }] }], { trust_git_filters: true });
  try {
    fs.writeFileSync(path.join(h.repo, "a.txt"), "a\n");
    fs.writeFileSync(path.join(h.repo, ".gitattributes"), "* diff=evil\n");
    gitIn(h.repo, "add", "-A");
    gitIn(h.repo, "commit", "-q", "-m", "attrs");
    gitIn(h.repo, "config", "diff.external", ext.script);
    gitIn(h.repo, "config", "diff.evil.textconv", `sh ${conv.script}`);
    gitIn(h.repo, "config", "diff.evil.command", ext.script);
    const job = await h.call("delegate", { target: "codex", task: "DIFFED", mode: "write", background: false });
    assert.deepEqual(job.result.files_changed_git, ["a.txt"]);
    assert.match(job.result.diff_stat, /a\.txt/);
    assert.equal((await h.call("merge", { job_id: job.job_id })).status, "merged");
    assert.equal(ext.ran(), false, "no external diff ran");
    assert.equal(conv.ran(), false, "no textconv ran");
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git safety: relay clean asks git about a worktree only after the filter check, and keeps one it cannot vouch for", async () => {
  const dir = scratch();
  const clean = recorder(dir, "clean");
  const h = await harness([{ match: task("ATTRS"), steps: [{ write: ".gitattributes", content: "*.txt filter=evil\n" }, { write: "a.txt", content: "a\n" }, { reply: "done" }] }]);
  try {
    const job = await h.call("delegate", { target: "codex", task: "ATTRS", mode: "write", background: false });
    assert.equal(job.status, "done");
    const wt = worktreeOf(h, job.job_id);
    // A filter configured since, and a file git can no longer tell is unchanged without filtering it again.
    gitIn(h.repo, "config", "filter.evil.clean", `sh ${clean.script}`);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(wt, "a.txt"), later, later);
    const cleaned = JSON.parse(h.cli("clean"));
    assert.equal(cleaned.worktrees_removed, 0);
    assert.match(cleaned.worktrees_kept.join("\n"), /content filter \(filter\.evil\.clean/);
    assert.equal(clean.ran(), false, "git status never ran the filter");
    assert.ok(fs.existsSync(wt));

    // Merging is refused the same way, so the worktree is never removed through the merge either.
    const merged = await h.call("merge", { job_id: job.job_id });
    assert.equal(merged.status, "error");
    assert.equal(clean.ran(), false);
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git safety: finishing a merge takes conflicted names literally, and checks for filters first", async () => {
  const dir = scratch();
  const clean = recorder(dir, "clean");
  const star = "star*.txt";
  const h = await harness([{ match: task("STAR"), steps: [{ write: star, content: "job\n" }, { reply: "done" }] }]);
  try {
    fs.writeFileSync(path.join(h.repo, star), "base\n");
    gitIn(h.repo, "add", "-A");
    gitIn(h.repo, "commit", "-q", "-m", "base");
    const job = await h.call("delegate", { target: "codex", task: "STAR", mode: "write", background: false });
    fs.writeFileSync(path.join(h.repo, star), "main\n");
    gitIn(h.repo, "commit", "-q", "-am", "main");
    const conflict = await h.call("merge", { job_id: job.job_id });
    assert.equal(conflict.status, "conflict", JSON.stringify(conflict));
    assert.deepEqual(conflict.files, [star]);
    // Unrelated work in the tree that the name, read as a pattern, would match.
    fs.writeFileSync(path.join(h.repo, "starX.txt"), "mine, not the merge's\n");
    fs.writeFileSync(path.join(h.repo, star), "resolved\n");

    // A filter configured in between is refused before anything is staged.
    gitIn(h.repo, "config", "filter.evil.clean", `sh ${clean.script}`);
    fs.writeFileSync(path.join(h.repo, ".gitattributes"), "* filter=evil\n");
    const held = await h.call("merge", { job_id: job.job_id, continue: true });
    assert.equal(held.status, "error");
    assert.match(held.error, /did not finish the merge, because this repository runs a content filter/);
    assert.equal(clean.ran(), false);
    gitIn(h.repo, "config", "--unset", "filter.evil.clean");
    fs.rmSync(path.join(h.repo, ".gitattributes"));

    const done = await h.call("merge", { job_id: job.job_id, continue: true });
    assert.equal(done.status, "merged", JSON.stringify(done));
    assert.equal(gitIn(h.repo, "show", `HEAD:${star}`), "resolved");
    assert.equal(gitIn(h.repo, "ls-files", "starX.txt"), "", "the file the pattern would have matched stays out of the merge");
    assert.equal(gitIn(h.repo, "status", "--porcelain", "--", "starX.txt"), "?? starX.txt");
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git safety: relay adds to info/exclude only as a regular file of one name, never through a link", async () => {
  const dir = scratch();
  const h = await harness([{ steps: [{ write: "a.txt" }, { reply: "done" }] }]);
  try {
    const exclude = path.join(h.repo, ".git", "info", "exclude");
    const victim = path.join(dir, "victim");
    const plants: [string, () => void, RegExp][] = [
      ["a symbolic link", () => fs.symlinkSync(victim, exclude), /is a symbolic link/],
      ["a dangling link", () => {
        fs.rmSync(victim);
        fs.symlinkSync(victim, exclude);
      }, /is a symbolic link/],
      ["a hard link", () => fs.linkSync(victim, exclude), /has 2 names/],
    ];
    for (const [name, plant, why] of plants) {
      fs.writeFileSync(victim, "keep\n");
      fs.rmSync(exclude, { force: true });
      plant();
      const r = await h.call("delegate", { target: "codex", task: "x", mode: "write", background: false });
      assert.equal(r.refused, true, name);
      assert.match(r.reason, why, name);
      if (name === "a dangling link") assert.equal(fs.existsSync(victim), false, `${name}: nothing was created through it`);
      else assert.equal(fs.readFileSync(victim, "utf8"), "keep\n", `${name}: the other file is untouched`);
    }
    assert.equal(h.starts().length, 0);
    assert.equal(gitIn(h.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "no worktree was made");
    fs.rmSync(exclude, { force: true });
    assert.equal((await h.call("delegate", { target: "codex", task: "x", mode: "write", background: false })).status, "done");
    assert.match(fs.readFileSync(exclude, "utf8"), /^\.relay\/$/m);
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Relay's workers run with an allowlisted environment (env-policy.ts runtimeEnvironment), so they read
// the machine's git config whatever this test sets. A machine-wide Git LFS install that names a
// long-running filter (\`git lfs install --system\`, as on GitHub's macOS runners) makes git prefer
// filter.lfs.process, which the stand-in below does not speak (a repository-level empty value does
// not switch it off). Real git-lfs speaks it, so this is the stand-in's limit, not relay's.
const SYSTEM_LFS_PROCESS = (() => {
  const r = spawnSync("git", ["config", "--system", "--get", "filter.lfs.process"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : null;
})();
test("git safety: relay's checkouts and merges fetch no Git LFS objects", { skip: SYSTEM_LFS_PROCESS ? `this machine's system git config sets filter.lfs.process (${SYSTEM_LFS_PROCESS}), which relay's workers read and the test's stand-in git-lfs cannot speak` : false }, async () => {
  const dir = scratch();
  const bin = path.join(dir, "bin");
  const calls = path.join(dir, "lfs-calls");
  fs.mkdirSync(bin);
  // A stand-in for git-lfs that records whether it was told to skip the download, and passes content through.
  fs.writeFileSync(path.join(bin, "git-lfs"), `#!/bin/sh\necho "$1 \${GIT_LFS_SKIP_SMUDGE:-unset}" >> '${calls}'\nif [ "$1" = smudge ] || [ "$1" = clean ]; then cat; fi\n`, { mode: 0o755 });
  // Only this repository's filter may be in play, for relay's git as for the test's own. A Git LFS
  // installed for the whole machine names a long-running filter (`git lfs install --system`, as on
  // GitHub's macOS runners, sets filter.lfs.process, which git prefers to clean and smudge), and
  // the stand-in above does not speak its protocol. HOME is already a scratch one (process-home.ts).
  const gitEnv = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const h = await harness([
    { match: task("LFS"), steps: [{ write: "big.bin", content: "job's\n" }, { reply: "done" }] },
    { match: "again", steps: [{ write: "big.bin", content: "again\n" }, { reply: "again" }] },
  ], {}, gitEnv);
  try {
    const env = { ...process.env, ...gitEnv };
    const g = (...a: string[]) => execFileSync("git", a, { cwd: h.repo, env, stdio: "pipe" });
    g("config", "filter.lfs.clean", "git-lfs clean -- %f");
    g("config", "filter.lfs.smudge", "git-lfs smudge -- %f");
    fs.writeFileSync(path.join(h.repo, ".gitattributes"), "*.bin filter=lfs\n");
    fs.writeFileSync(path.join(h.repo, "big.bin"), "base\n");
    // Enough files for relay's checkouts to use git's parallel workers (PARALLEL_CHECKOUT), with
    // filtered files, an executable and a link among them, which git writes itself.
    const filler = Array.from({ length: 450 }, (_, i) => path.join(`d${i % 9}`, i % 50 === 7 ? `f${i}.bin` : `f${i}.txt`));
    for (const [i, f] of filler.entries()) {
      fs.mkdirSync(path.join(h.repo, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(h.repo, f), `file ${i}\n`, { mode: i === 3 ? 0o755 : 0o644 });
    }
    fs.symlinkSync("../d0/f0.txt", path.join(h.repo, "d1", "link"));
    g("add", "-A");
    g("commit", "-q", "-m", "lfs");
    fs.rmSync(calls, { force: true });
    const smudges = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "").split("\n").filter((l) => l.startsWith("smudge"));

    const job = await h.call("delegate", { target: "codex", task: "LFS", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.ok(smudges().length >= 1, "the worktree's checkout went through the LFS filter");
    const wt = worktreeOf(h, job.job_id);
    for (const [i, f] of filler.entries()) assert.equal(fs.readFileSync(path.join(wt, f), "utf8"), `file ${i}\n`, f);
    assert.equal(fs.statSync(path.join(wt, filler[3])).mode & 0o111, 0o111, "the executable kept its mode");
    assert.equal(fs.readlinkSync(path.join(wt, "d1", "link")), "../d0/f0.txt", "the link is a link");
    const merged = await h.call("merge", { job_id: job.job_id });
    assert.equal(merged.status, "merged", JSON.stringify(merged));
    const afterMerge = smudges().length;
    assert.ok(afterMerge > 1, "so did the merge");
    // The worktree is gone after the merge; resuming puts it back.
    await h.call("resume", { job_id: job.job_id, message: "again" });
    assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
    assert.ok(smudges().length > afterMerge, "and so did putting the worktree back");
    assert.deepEqual([...new Set(smudges())], ["smudge 1"], "each time with downloads off");
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git safety: launched agents' pnpm copies packages, so pnpm install leaves no hard link out of the worktree", async () => {
  const { childEnv } = await import("../dist/backends/env.js");
  const { withDefaults } = await import("../dist/core/config.js");
  const { targetDef } = await import("../dist/targets/index.js");
  const saved = process.env.pnpm_config_package_import_method;
  // Whatever the person set for themselves, a launched agent copies.
  process.env.pnpm_config_package_import_method = "hardlink";
  try {
    for (const t of ["claude", "codex"]) {
      const env = childEnv({ target: targetDef(t), config: withDefaults({}), markers: { runId: "r", nodeId: "n", depth: 1 } } as never, () => false);
      assert.equal(env.pnpm_config_package_import_method, "copy", t);
      // C4: only pnpm's own variable is set; npm has no such setting, so the npm_config_ form is not.
      assert.equal(env.npm_config_package_import_method, undefined, t);
    }
  } finally {
    if (saved === undefined) delete process.env.pnpm_config_package_import_method;
    else process.env.pnpm_config_package_import_method = saved;
  }
});

test("git safety X1: a filter only in the main worktree's config.worktree is refused when branching a nested job's worktree", async () => {
  const { createWorktree } = await import("../dist/core/git.js");
  const root = scratch();
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    gitIn(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    fs.writeFileSync(path.join(repo, ".gitattributes"), "* filter=evil\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "i");
    // A caller worktree (a relay job's) whose own config names no filter.
    const caller = path.join(root, "caller");
    gitIn(repo, "worktree", "add", "-q", "-b", "caller", caller);
    // The filter lives only in the MAIN worktree's per-worktree config, set after the caller exists,
    // so the caller's context does not show it — but `git worktree add` runs in the main worktree.
    gitIn(repo, "config", "extensions.worktreeConfig", "true");
    const rec = recorder(root, "smudge");
    gitIn(repo, "config", "--worktree", "filter.evil.smudge", `sh ${rec.script}`);
    gitIn(repo, "config", "--worktree", "filter.evil.clean", "cat");
    // --get-regexp exits 1 (throws) when nothing matches: that is what "no filter in context" looks like.
    let callerFilters = "";
    try {
      callerFilters = gitIn(caller, "config", "--get-regexp", "^filter\\.evil");
    } catch {
      callerFilters = "";
    }
    assert.equal(callerFilters, "", "the caller's context shows no filter");

    const out = createWorktree(caller, "run_x1", "j_x1", false, { repo, worktree: caller });
    assert.ok("error" in out, `expected a refusal, got ${JSON.stringify(out)}`);
    assert.match((out as { error: string }).error, /content filter \(filter\.evil\.smudge/);
    assert.equal(rec.ran(), false, "no worktree was added, so the filter never ran");
    assert.equal(fs.existsSync(path.join(root, "worktrees")), false);
    // With the filter trusted, or absent, the same branch succeeds (so the refusal is the filter, not the setup).
    gitIn(repo, "config", "--worktree", "--unset", "filter.evil.smudge");
    gitIn(repo, "config", "--worktree", "--unset", "filter.evil.clean");
    const ok = createWorktree(caller, "run_x1", "j_x1b", false, { repo, worktree: caller });
    assert.ok(!("error" in ok), `expected success once the filter is gone, got ${JSON.stringify(ok)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("git safety: a running write job's liveness asks git only through the repository's records, and only after the filter check", async () => {
  const dir = scratch();
  const clean = recorder(dir, "clean");
  const h = await harness([{ match: task("LIVE"), steps: [{ write: ".gitattributes", content: "*.txt filter=evil\n" }, { write: "a.txt", content: "a\n" }, { sleep: 10000 }, { reply: "done" }] }]);
  try {
    // A tracked file the agent's attributes name, so that git would filter it to compare it.
    fs.writeFileSync(path.join(h.repo, "t.txt"), "t\n");
    gitIn(h.repo, "add", "t.txt");
    gitIn(h.repo, "commit", "-q", "-m", "t");
    const job = await h.call("delegate", { target: "codex", task: "LIVE", mode: "write" });
    let st: Rec = {};
    await until(async () => ((st = await h.call("status", { id: job.job_id })).liveness?.files_touched ?? []).includes("a.txt"), 10000, "the files to show");
    const wt = worktreeOf(h, job.job_id);
    const touch = () => {
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(wt, "t.txt"), later, later);
    };

    // A filter configured while the job runs: liveness no longer asks git about the worktree.
    gitIn(h.repo, "config", "filter.evil.clean", `sh ${clean.script}`);
    touch();
    st = await h.call("status", { id: job.job_id });
    assert.equal(st.status, "running");
    assert.equal(st.liveness.files_touched, undefined, "nothing git would have had to filter for");
    gitIn(h.repo, "config", "--unset", "filter.evil.clean");

    // The worktree's .git pointed at a repository of the agent's own, whose config runs the filter.
    const fake = path.join(dir, "fake");
    execFileSync("git", ["clone", "-q", "--no-hardlinks", h.repo, fake], { stdio: "pipe" });
    gitIn(fake, "config", "filter.evil.clean", `sh ${clean.script}`);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(fake, ".git")}\n`);
    touch();
    st = await h.call("status", { id: job.job_id });
    assert.equal(st.status, "running");
    assert.equal(st.liveness.files_touched, undefined, "nothing said through the agent's repository");
    assert.equal(clean.ran(), false, "the filter never ran");
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git safety: every git relay runs leads its own process group, and one that overruns is killed with what it started", async () => {
  const { git, gitWithin } = await import("../dist/core/git.js");
  const root = scratch();
  try {
    gitIn(root, "init", "-q", "-b", "main");
    // An alias runs through the shell git starts, a child of git: its parent is git, and its group must be git's.
    const pg = git(root, ["-c", "alias.pg=!/bin/ps -o pgid=,ppid= -p $$", "pg"]);
    assert.equal(pg.ok, true, pg.err);
    const [pgid, ppid] = pg.out.split(/\s+/).map(Number);
    assert.equal(pgid, ppid, "git is the leader of its own process group");
    assert.notEqual(pgid, Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim()), "not relay's group");

    // What callers read is unchanged: the exit status, stderr, trimmed and raw stdout.
    const bad = git(root, ["rev-parse", "--verify", "-q", "refs/heads/none"]);
    assert.deepEqual([bad.ok, bad.code, bad.out], [false, 1, ""]);
    const fatal = git(root, ["no-such-command"]);
    assert.equal(fatal.ok, false);
    assert.equal(fatal.code, 1);
    assert.match(fatal.err, /is not a git command/);
    const raw = git(root, ["-c", "alias.echo=!printf ' a b \\n'", "echo"]);
    assert.deepEqual([raw.ok, raw.code, raw.out, raw.raw], [true, 0, "a b", " a b \n"]);

    // A git that overruns, having started a child in the background and another in the foreground.
    const child = path.join(root, "child.pid");
    const shell = path.join(root, "shell.pid");
    const started = Date.now();
    const r = gitWithin(1000, root, ["-c", `alias.overrun=!/bin/sleep 4301 & echo $! > '${child}'; echo $$ > '${shell}'; /bin/sleep 4302`, "overrun"]);
    assert.deepEqual([r.ok, r.code, r.err], [false, null, "git -c did not finish within 1s"]);
    assert.ok(Date.now() - started < 10_000, "git() returned at its timeout, not when the last of what git started let go of its output");
    const pids = [child, shell].map((f) => Number(fs.readFileSync(f, "utf8").trim()));
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    await until(() => pids.every(gone), 5000, "the overrunning git's children are killed");
    const sleeps = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" }).split("\n").filter((l) => /sleep 430[12]$/.test(l.trim()));
    assert.deepEqual(sleeps, [], "nothing the overrunning git started is left");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const FILTER_CHECK = "config -z --get-regexp ^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver)$";
const CLEAN_STATUS = "status --porcelain --untracked-files=all";

test("git safety: a job that changed nothing is removed only right after git reports its worktree clean, with every check after the turn's tip read asked again", async () => {
  const dir = scratch();
  const bin = path.join(dir, "bin");
  const calls = path.join(dir, "git-calls");
  fs.mkdirSync(bin);
  const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  // A git that records relay's commands (those with relay's settings in front) and runs the real one.
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\ncase "$*" in "-c core.hooksPath=/dev/null -c core.fsmonitor=false"*) printf '%s\\n' "$*" >> '${calls}' ;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const relayOwn = (line: string) => line.replace(/^(-c [^ ]+ )+/, "");
  // With child_git "relay" no agent can write the repository's git directories, but other writers
  // can still change what git reads (an included config, the job's HEAD through a merge), so neither
  // setting lets the turn's end go by what it asked before.
  for (const childGit of ["relay", "native"] as const) {
    fs.rmSync(calls, { force: true });
    const h = await harness([{ match: task("NOTHING"), steps: [{ reply: "changed nothing" }] }], { child_git: childGit }, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    try {
      const job = await h.call("delegate", { target: "claude", task: "NOTHING", mode: "write", background: false });
      assert.equal(job.outcome, "no_changes", childGit);
      assert.equal(job.result.branch, null, `${childGit}: the worktree and branch are dropped`);
      const log = fs.readFileSync(calls, "utf8").trim().split("\n").map(relayOwn);
      const removal = log.findIndex((l) => l.startsWith("worktree remove --force "));
      assert.ok(removal > 0, `${childGit}: ${log.join("\n")}`);
      assert.equal(log[removal - 1], CLEAN_STATUS, `${childGit}: the removal follows git reporting the tree clean, untracked files asked for`);
      // From the tip the result names to the removal: the filter check before any status, HEAD read
      // again, untracked files asked a second way, and the removal's own merge, filter and status checks.
      const tail = log.slice(log.indexOf("rev-parse --verify HEAD^{commit}") + 1, removal);
      assert.equal(tail[0], FILTER_CHECK, `${childGit}: ${tail.join("\n")}`);
      assert.ok(tail.includes("rev-parse HEAD"), `${childGit}: HEAD is read again: ${tail.join("\n")}`);
      assert.ok(tail.includes("ls-files --others --exclude-standard"), `${childGit}: ${tail.join("\n")}`);
      assert.deepEqual(tail.slice(-3), ["rev-parse -q --verify MERGE_HEAD", FILTER_CHECK, CLEAN_STATUS], `${childGit}: ${tail.join("\n")}`);
    } finally {
      await h.close();
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A git on PATH that runs the real one and, the first time relay reads the tip a write turn ended
 * at (endJobTurn's `rev-parse --verify HEAD^{commit}`), runs `inject` just after, as another
 * process could between that read and the steps that follow it. `<dir>/injected` says it ran.
 */
function gitInjectingAfterTip(dir: string, inject: string): { PATH: string; injected: () => boolean } {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  const once = path.join(dir, "injected");
  fs.writeFileSync(path.join(bin, "git"), [
    "#!/bin/sh",
    `'${realGit}' "$@"`,
    "code=$?",
    `case "$*" in "-c core.hooksPath=/dev/null -c core.fsmonitor=false"*"rev-parse --verify HEAD^{commit}") if mkdir '${once}' 2>/dev/null; then ${inject.replaceAll("$GIT", `'${realGit}'`)}; fi ;; esac`,
    "exit $code",
    "",
  ].join("\n"), { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, injected: () => fs.existsSync(once) };
}

test("git safety: a filter configured after a write turn's checkpoint, in an included config outside .git, is refused before any later git status, and the worktree is kept", async () => {
  const dir = scratch();
  const filter = recorder(dir, "evil-clean");
  // Another job's agent may write the directory an included config lives in; this one adds a
  // filter there after the job's checkpoint found none.
  const shared = path.join(dir, "shared-config");
  const staged = path.join(dir, "evil-config");
  fs.writeFileSync(shared, "");
  fs.writeFileSync(staged, `[filter "evil"]\n\tclean = ${filter.script}\n`);
  const wrap = gitInjectingAfterTip(dir, `cp '${staged}' '${shared}'`);
  // The agent leaves a tracked file with a time in the future, so every git status reads it again (through the filter, once there is one).
  const h = await harness([{ match: task("RACE"), steps: [{ run: "touch -t 209901010000 data.txt" }, { reply: "changed nothing" }] }], { child_git: "relay" }, { PATH: wrap.PATH });
  try {
    fs.writeFileSync(path.join(h.repo, ".gitattributes"), "data.txt filter=evil\n");
    fs.writeFileSync(path.join(h.repo, "data.txt"), "unchanged\n");
    gitIn(h.repo, "add", "-A");
    gitIn(h.repo, "commit", "-q", "-m", "data");
    gitIn(h.repo, "config", "include.path", shared);
    const job = await h.call("delegate", { target: "claude", task: "RACE", mode: "write", background: false });
    assert.equal(wrap.injected(), true, "the filter was added between the tip read and what follows it");
    assert.equal(filter.ran(), false, "the filter never ran");
    assert.notEqual(job.outcome, "no_changes", JSON.stringify(job.result));
    assert.equal(job.result.no_changes, undefined);
    assert.ok(job.result.branch, "the branch is kept");
    assert.ok(fs.existsSync(worktreeOf(h, job.job_id)), "the worktree is kept");
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git safety: a job's HEAD moved by a merge after the turn's tip read keeps its worktree and branch, and the job is not reported unchanged", async () => {
  const dir = scratch();
  const merged = path.join(dir, "merged");
  // NEXT is filled in below, once the commit exists. Run in the job's worktree, with relay's GIT_DIR
  // and GIT_WORK_TREE for it, as a root's merge into the job's worktree would be.
  const nextFile = path.join(dir, "next");
  const wrap = gitInjectingAfterTip(dir, `$GIT merge -q --ff-only "$(cat '${nextFile}')" >/dev/null 2>&1 && : > '${merged}'`);
  const h = await harness([{ match: task("RACE"), steps: [{ reply: "changed nothing" }] }], { child_git: "relay" }, { PATH: wrap.PATH });
  try {
    // A commit ahead of the job's base, on a branch of its own, so that the job starts at main.
    gitIn(h.repo, "checkout", "-q", "-b", "side");
    fs.writeFileSync(path.join(h.repo, "README.md"), "merged child work\n");
    gitIn(h.repo, "commit", "-q", "-am", "child result");
    const next = gitIn(h.repo, "rev-parse", "HEAD");
    fs.writeFileSync(nextFile, next);
    gitIn(h.repo, "checkout", "-q", "main");
    const job = await h.call("delegate", { target: "claude", task: "RACE", mode: "write", background: false });
    assert.equal(wrap.injected(), true);
    assert.equal(fs.existsSync(merged), true, "the job's HEAD was fast-forwarded after the tip read");
    assert.notEqual(job.outcome, "no_changes", JSON.stringify(job.result));
    assert.equal(job.result.no_changes, undefined);
    assert.ok(job.result.branch, "the branch is named");
    const wt = worktreeOf(h, job.job_id);
    assert.ok(fs.existsSync(wt), "the worktree is kept");
    assert.equal(gitIn(h.repo, "rev-parse", "--verify", `refs/heads/${job.result.branch}`), next, "the branch is kept, at the merged commit");
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
