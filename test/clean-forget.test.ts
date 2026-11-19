// relay clean --forget <run_id> [--write] (1.0): the person's own way to forget a run that
// keep_records_days keeps because a repository it has a branch or worktree in is not there, which
// relay cannot tell from a volume not mounted. Refused for a run still in use or one whose
// repository is there; changes nothing without --write; with it, removes the run's rows and
// relay's own files for it, never through a link, and touches no branch.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { procStart } from "../dist/core/procs.js";
import { CLI, type Harness, alive, harness, killGroup, task, until } from "./helpers.ts";

/** relay clean with these arguments, from the person's own terminal unless `env` says otherwise. */
function clean(h: Harness, args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; json: Record<string, any>; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, "clean", ...args], { env: { ...h.env, ...env }, cwd: h.repo, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, json: r.stdout ? JSON.parse(r.stdout) : {}, stderr: r.stderr };
}
/** relay clean --forget with these arguments. */
const forget = (h: Harness, args: string[], env: Record<string, string> = {}) => clean(h, ["--forget", ...args], env);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const runOf = (h: Harness, id: string) => h.sql("SELECT run_id FROM nodes WHERE id = ?", id)[0].run_id as string;
const nodeOf = (h: Harness, run: string) => h.sql("SELECT id FROM nodes WHERE run_id = ?", run)[0].id as string;
const rows = (h: Harness, run: string) => h.sql(`SELECT (SELECT COUNT(*) FROM runs WHERE id = ?1) + (SELECT COUNT(*) FROM nodes WHERE run_id = ?1)
  + (SELECT COUNT(*) FROM turns WHERE node_id IN (SELECT id FROM nodes WHERE run_id = ?1)) + (SELECT COUNT(*) FROM requests WHERE run_id = ?1)
  + (SELECT COUNT(*) FROM events WHERE run_id = ?1) AS n`, run)[0].n as number;
/** Everything the registry holds of a run. */
const registryOf = (h: Harness, run: string) => JSON.stringify([
  h.sql("SELECT * FROM runs WHERE id = ?", run), h.sql("SELECT * FROM nodes WHERE run_id = ?", run),
  h.sql("SELECT * FROM turns WHERE node_id IN (SELECT id FROM nodes WHERE run_id = ?) ORDER BY id", run),
  h.sql("SELECT * FROM requests WHERE run_id = ?", run), h.sql("SELECT * FROM events WHERE run_id = ? ORDER BY id", run),
]);
/** Every path under these directories, links listed and not followed. */
function inventory(...dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) return;
    out.push(p);
    if (st.isDirectory() && !st.isSymbolicLink()) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  };
  for (const d of dirs) walk(d);
  return out.sort();
}
const lstat = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false });

/** A root session of its own that asks one thing and closes, its relay server and workers gone; returns the run it made. */
async function closedRun(h: Harness, message: string): Promise<string> {
  const s = await h.instance({ args: ["--host", "codex"] });
  const r = await s.call("ask", { target: "claude", message });
  assert.ok(r.thread_id, JSON.stringify(r));
  return closed(h, s, runOf(h, r.thread_id));
}
async function closed(h: Harness, s: { close(): Promise<void> }, run: string): Promise<string> {
  const pid = h.sql("SELECT root_pid FROM runs WHERE id = ?", run)[0].root_pid as number;
  await s.close();
  await until(() => !alive(pid), 20000, "the session's relay server to exit");
  const workers = () => h.sql("SELECT pid FROM relay_procs WHERE kind = 'worker' AND node_id IN (SELECT id FROM nodes WHERE run_id = ?)", run).map((r) => r.pid as number);
  await until(() => workers().every((pid) => !alive(pid)), 20000, `the workers of ${run} to exit`);
  return run;
}
/** Records a run's item as having a branch in `repo`, as a write job does. */
const branchIn = (h: Harness, run: string, repo: string) => h.sql("UPDATE nodes SET repo = ?, branch = 'relay/' || id WHERE run_id = ?", repo, run);

test("clean --forget: refuses an unknown run, a run still in use, quarantined or whose repository is there, one no missing repository keeps, and a launched agent's terminal, changing nothing", async () => {
  const h = await harness();
  const gone = path.join(path.dirname(h.home), "gone", "repo");
  try {
    const unknown = forget(h, ["run_00000000", "--write"]);
    assert.equal(unknown.status, 1);
    assert.deepEqual(unknown.json, { error: "unknown run run_00000000" });

    // In use: a run of this test's own session, which is still open.
    const open = runOf(h, (await h.call("ask", { target: "claude", message: "OPEN" })).thread_id);
    branchIn(h, open, gone);
    // In use: an item queued, with an approval request of it waiting.
    const queued = await closedRun(h, "QUEUED");
    branchIn(h, queued, gone);
    h.sql("UPDATE nodes SET status = 'queued', worker_pid = NULL, worker_start = NULL, ended_at = NULL WHERE run_id = ?", queued);
    h.sql("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES ('q_0000aaaa', ?, ?, 'command', 'run something', 'pending', ?)", queued, nodeOf(h, queued), Date.now());
    // Login-store entries relay quarantined, which its records explain.
    const quarantined = await closedRun(h, "QUARANTINED");
    branchIn(h, quarantined, gone);
    const quarantine = path.join(h.home, "quarantine", quarantined);
    fs.mkdirSync(path.join(quarantine, nodeOf(h, quarantined)), { recursive: true });
    // Its repository is there: relay clean's to deal with.
    const there = await closedRun(h, "THERE");
    branchIn(h, there, h.repo);
    // No branch or worktree in any repository: nothing missing keeps it.
    const none = await closedRun(h, "NONE");

    const runs = [open, queued, quarantined, there, none];
    const before = new Map(runs.map((run) => [run, registryOf(h, run)]));
    const files = () => inventory(path.join(h.home, "runs"), path.join(h.home, "quarantine"), `${h.home}-harness`, `${h.home}-worktrees`);
    const filesBefore = files();
    const reason = (run: string) => {
      const r = forget(h, [run, "--write"]);
      assert.equal(r.status, 1, JSON.stringify(r));
      assert.equal(r.json.refused, true, JSON.stringify(r.json));
      assert.equal(r.json.run_id, run);
      return r.json.reason as string;
    };
    assert.equal(reason(open), `relay will not forget ${open}: its session is still open`);
    assert.equal(reason(queued), `relay will not forget ${queued}: ${nodeOf(h, queued)} is queued`);
    assert.equal(reason(quarantined), `relay will not forget ${quarantined}: relay quarantined login-store entries of it in ${quarantine}, which its records explain; delete that directory once you have looked at it`);
    assert.equal(reason(there), `relay will not forget ${there}: its repository ${h.repo} is there, so relay clean ${there} is what applies: it removes the run's finished worktrees and its relay/* branches already merged, and keep_records_days forgets the run once nothing holds it`);
    assert.match(reason(none), new RegExp(`^relay will not forget ${none}: no job of it has a branch or a worktree in a repository, so no missing repository keeps it`));
    // The dry run says the same.
    assert.equal(forget(h, [queued]).json.reason, `relay will not forget ${queued}: ${nodeOf(h, queued)} is queued`);

    // Only from the person's own terminal, whatever the run.
    for (const marker of ["RELAY_RUN_ID", "RELAY_NODE_ID"]) {
      const r = forget(h, [there, "--write"], { [marker]: "launched" });
      assert.equal(r.status, 2, `${marker}: ${r.stderr}`);
      assert.match(r.stderr, /^relay clean --forget cannot run in a launched agent's environment\. Run it from the person's own terminal\./);
    }
    // The run named once, and no flag but --write.
    for (const args of [[], [there, none], [there, "--wirte"]]) {
      const r = forget(h, args);
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.match(r.stderr, /^usage: relay clean --forget <run_id> \[--write\]/);
    }
    // Another spelling of --forget, or a flag relay clean does not have, is a mistake, never a
    // clean of every run (which would print its result).
    for (const args of [[`--forget=${there}`], [`--forget=${there}`, "--write"], ["--bogus"], ["--write"], [there, none]]) {
      const r = clean(h, args);
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.equal(r.stdout, "", `${JSON.stringify(args)}: nothing was cleaned`);
      assert.match(r.stderr, /^usage: relay clean /, JSON.stringify(args));
    }

    for (const run of runs) assert.equal(registryOf(h, run), before.get(run), `${run}'s rows are as they were`);
    assert.deepEqual(files(), filesBefore, "and so are relay's files");
  } finally {
    await h.close();
  }
});

test("clean --forget: a dry run changes nothing; with --write, exactly the run's rows and relay's files for it go, and its branches are not touched", async () => {
  const h = await harness([{ match: task("CHANGE"), steps: [{ write: "change.txt", content: "c\n" }, { reply: "changed" }] }]);
  const scratch = path.dirname(h.home);
  const harnessHome = `${h.home}-harness`;
  const treesHome = `${h.home}-worktrees`;
  try {
    // A repository of the run's own, where its write job branches, and which then goes away (moved, here).
    const repo = path.join(scratch, "proj");
    fs.mkdirSync(repo);
    const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: h.env.HOME } }).trim();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(repo, "README.md"), "proj\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const s = await h.instance({ args: ["--host", "codex"], cwd: repo });
    const job = await s.call("delegate", { target: "claude", task: "CHANGE", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const run = await closed(h, s, runOf(h, job.job_id));
    const other = await closedRun(h, "OTHER");

    const records = path.join(h.home, "runs", run);
    const harnessState = path.join(harnessHome, run);
    fs.mkdirSync(harnessState, { recursive: true });
    fs.writeFileSync(path.join(harnessState, "session.json"), "{}\n");
    const trees = path.join(treesHome, run);
    const tree = path.join(trees, job.job_id);
    assert.ok(fs.existsSync(path.join(tree, "change.txt")), "the job's worktree is still there");
    // Transfers relay adopt authorized, of this run and of the other.
    const adoptions = path.join(h.home, "adoptions");
    fs.mkdirSync(adoptions, { mode: 0o700 });
    const ticket = path.join(adoptions, `${run}-${"a".repeat(24)}.json.used`);
    const otherTicket = path.join(adoptions, `${other}-${"b".repeat(24)}.json.used`);
    for (const f of [ticket, otherTicket]) fs.writeFileSync(f, "{}", { mode: 0o600 });
    const moved = `${repo}-moved`;
    fs.renameSync(repo, moved);

    const files = () => inventory(path.join(h.home, "runs"), adoptions, harnessHome, treesHome);
    const filesBefore = files();
    const registryBefore = registryOf(h, run);
    const otherBefore = registryOf(h, other);
    const branches = [`relay/${job.job_id} in ${repo}`];

    const dry = forget(h, [run]);
    assert.equal(dry.status, 0, JSON.stringify(dry));
    assert.equal(dry.json.dry_run, true);
    assert.equal(dry.json.forgotten, false);
    assert.deepEqual(dry.json.relay_files, [records, harnessState, tree, trees, ticket]);
    assert.deepEqual(dry.json.branches_not_touched, branches);
    assert.equal(dry.json.registry_rows.items, 1);
    assert.ok(dry.json.registry_rows.turns >= 1, JSON.stringify(dry.json.registry_rows));
    assert.equal("left_alone" in dry.json, false);
    assert.match(dry.json.note, /^Nothing was changed\. With --write, relay removes the run's rows from the registry and relay_files from disk \(work never committed in its worktrees goes with them\), and nothing else\./);
    assert.equal(registryOf(h, run), registryBefore, "the dry run changed no row");
    assert.deepEqual(files(), filesBefore, "nor any file");

    const done = forget(h, [run, "--write"]);
    assert.equal(done.status, 0, JSON.stringify(done));
    assert.equal(done.json.dry_run, false);
    assert.equal(done.json.forgotten, true);
    assert.deepEqual(done.json.relay_files, dry.json.relay_files, "it removed what the dry run said");
    assert.deepEqual(done.json.branches_not_touched, branches);
    assert.equal("left" in done.json, false, JSON.stringify(done.json));
    assert.match(done.json.note, new RegExp(`^${run} is forgotten: its rows are gone from the registry, and relay_files from disk\\. Its branches`));
    assert.equal(rows(h, run), 0, "every row of the run is gone");
    const ofRun = [records, harnessState, trees, ticket];
    assert.deepEqual(files(), filesBefore.filter((p) => !ofRun.some((d) => p === d || p.startsWith(`${d}${path.sep}`))), "and exactly its files");
    for (const parent of [path.join(h.home, "runs"), harnessHome, treesHome]) {
      assert.deepEqual(fs.readdirSync(parent).filter((n) => n.startsWith(".forgotten-")), [], `nothing is left aside in ${parent}`);
    }
    assert.equal(registryOf(h, other), otherBefore, "the other run is as it was");
    assert.ok(fs.existsSync(otherTicket));
    assert.equal(fs.existsSync(path.join(h.home, "registry-rebuild")), false, "and the registry was rebuilt, no run being active");
    // The repository, wherever it went, still has the job's branch and its commit.
    assert.equal(git(moved, "log", "-1", "--format=%s", `relay/${job.job_id}`).length > 0, true);
    assert.equal(git(moved, "show", `relay/${job.job_id}:change.txt`), "c");
    assert.deepEqual(forget(h, [run]).json, { error: `unknown run ${run}` });
  } finally {
    await h.close();
  }
});

test("clean --forget: a link planted in a run's state is removed as a link, never followed, and what relay did not make is left alone", async () => {
  const h = await harness();
  const scratch = path.dirname(h.home);
  const gone = path.join(scratch, "gone", "repo");
  try {
    const run = await closedRun(h, "LINKED");
    const node = nodeOf(h, run);
    const trees = path.join(`${h.home}-worktrees`, run);
    const tree = path.join(trees, node);
    h.sql("UPDATE nodes SET repo = ?, branch = ?, worktree = ? WHERE id = ?", gone, `relay/${node}`, tree, node);
    fs.mkdirSync(path.join(tree, "sub"), { recursive: true });
    fs.writeFileSync(path.join(tree, "sub", "work.txt"), "work\n");
    // What the links lead to, outside relay's directories.
    const outside = path.join(scratch, "outside");
    fs.mkdirSync(path.join(outside, "sub"), { recursive: true });
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep\n");
    fs.writeFileSync(path.join(outside, "sub", "deeper.txt"), "deeper\n");
    const records = path.join(h.home, "runs", run);
    fs.symlinkSync(outside, path.join(records, "planted"));
    fs.symlinkSync(outside, path.join(tree, "escape"));
    fs.symlinkSync(path.join(outside, "keep.txt"), path.join(tree, "sub", "escape.txt"));
    // Its harnesses' state is itself a link.
    const harnessState = path.join(`${h.home}-harness`, run);
    fs.mkdirSync(path.dirname(harnessState), { recursive: true });
    fs.symlinkSync(outside, harnessState);
    // In its worktrees directory, a name relay gives an identity file's build directory, but a link;
    // and a directory relay never makes.
    const build = path.join(trees, `.${node}.relay.0123456789abcdef`);
    fs.symlinkSync(outside, build);
    const stranger = path.join(trees, "stranger");
    fs.mkdirSync(stranger);
    fs.writeFileSync(path.join(stranger, "f"), "f\n");
    const outsideBefore = inventory(outside);
    // Another run, whose job's worktree was made while relay's worktrees home was elsewhere.
    const elsewhereRun = await closedRun(h, "ELSEWHERE");
    const elsewhereNode = nodeOf(h, elsewhereRun);
    const elsewhere = path.join(scratch, "old-worktrees", elsewhereRun, elsewhereNode);
    fs.mkdirSync(elsewhere, { recursive: true });
    h.sql("UPDATE nodes SET repo = ?, branch = ?, worktree = ? WHERE id = ?", gone, `relay/${elsewhereNode}`, elsewhere, elsewhereNode);

    const alone = [
      `${build}: not a plain directory of this user's (a link, say), so relay leaves it`,
      `${stranger}: not a name relay gives what it makes for a job, so relay leaves it`,
    ];
    const dry = forget(h, [run]);
    assert.equal(dry.status, 0, JSON.stringify(dry));
    assert.deepEqual(dry.json.relay_files, [records, harnessState, tree], "the run's directory of worktrees is not, with something else in it");
    assert.deepEqual(dry.json.left_alone, alone);
    assert.match(dry.json.note, / What left_alone names is not relay's to remove: delete it yourself once you have looked at it\. /);

    const done = forget(h, [run, "--write"]);
    assert.equal(done.status, 0, JSON.stringify(done));
    assert.equal(done.json.forgotten, true, JSON.stringify(done.json));
    assert.deepEqual(done.json.left_alone, alone);
    assert.equal("left" in done.json, false, JSON.stringify(done.json));
    assert.deepEqual(inventory(outside), outsideBefore, "nothing a link led to was touched");
    assert.deepEqual(fs.readdirSync(`${h.home}-worktrees`).filter((n) => n.startsWith(".forgotten-")), [], "nothing is left aside");
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep\n");
    for (const p of [records, tree]) assert.equal(lstat(p), undefined, `${p} is gone`);
    assert.equal(lstat(harnessState), undefined, "the link that was its harnesses' state is gone, and only the link");
    assert.deepEqual(fs.readdirSync(trees).sort(), [path.basename(build), "stranger"], "what relay did not make is where it was");
    assert.ok(lstat(build)!.isSymbolicLink());
    assert.equal(rows(h, run), 0);

    const kept = forget(h, [elsewhereRun, "--write"]);
    assert.equal(kept.json.forgotten, true, JSON.stringify(kept.json));
    assert.deepEqual(kept.json.left_alone, [`${elsewhere}: ${elsewhereNode}'s worktree, outside relay's worktrees home ${h.home}-worktrees, so relay does not remove it`]);
    assert.ok(fs.existsSync(elsewhere), "a worktree outside relay's worktrees home is left where it is");
  } finally {
    await h.close();
  }
});

test("clean --forget: a preview settles nothing: a job whose worker is gone, or a request no job can take up, keeps the run, its rows and its agent as they were; --write settles them and forgets the run", async () => {
  const h = await harness();
  const gone = path.join(path.dirname(h.home), "gone", "repo");
  // An agent of the job left without a supervisor, which reap would stop: a process group of its
  // own whose parent has gone (so that, once stopped, it is reaped by the system, not left a zombie
  // of this test's, which waits on relay's CLI meanwhile).
  const launched = spawnSync(process.execPath, ["-e", `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid);`], { encoding: "utf8" });
  const agent = { pid: Number(launched.stdout.trim()) };
  assert.ok(agent.pid > 0 && alive(agent.pid), launched.stderr);
  try {
    const run = await closedRun(h, "DEAD");
    const node = nodeOf(h, run);
    branchIn(h, run, gone);
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    h.sql("UPDATE nodes SET status = 'running', ended_at = NULL, worker_pid = ?, worker_start = 'gone', agent_pid = ?, agent_pgid = ?, agent_start = ? WHERE id = ?",
      dead, agent.pid, agent.pid, procStart(agent.pid), node);
    h.sql("UPDATE turns SET status = 'running', ended_at = NULL WHERE node_id = ?", node);
    h.sql("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES ('q_0000dead', ?, ?, 'command', 'run something', 'pending', ?)", run, node, Date.now());
    // Another run, its job finished, with an approval request of it still marked waiting.
    const stale = await closedRun(h, "STALE");
    branchIn(h, stale, gone);
    h.sql("INSERT INTO requests (id, run_id, node_id, kind, summary, status, created_at) VALUES ('q_0000beef', ?, ?, 'command', 'run something', 'pending', ?)", stale, nodeOf(h, stale), Date.now());
    const before = registryOf(h, run);
    const staleBefore = registryOf(h, stale);
    const files = () => inventory(path.join(h.home, "runs"));
    const filesBefore = files();

    const dry = forget(h, [run]);
    assert.equal(dry.status, 1, JSON.stringify(dry));
    assert.equal(dry.json.reason, `relay will not forget ${run}: ${node}'s worker is gone; run relay tree or relay clean first, or run this again with --write`);
    const staleDry = forget(h, [stale]);
    assert.equal(staleDry.json.reason, `relay will not forget ${stale}: its approval request q_0000beef waits on ${nodeOf(h, stale)}, which is no longer running; run relay tree or relay clean first, or run this again with --write`);
    assert.equal(registryOf(h, run), before, "the job, its turn and its request are as they were");
    assert.equal(registryOf(h, stale), staleBefore);
    assert.deepEqual(files(), filesBefore);
    assert.ok(alive(agent.pid), "and its agent was not stopped");

    const done = forget(h, [run, "--write"]);
    assert.equal(done.status, 0, JSON.stringify(done));
    assert.equal(done.json.forgotten, true, JSON.stringify(done.json));
    assert.equal(rows(h, run), 0);
    await until(() => !alive(agent.pid), 10000, "the agent left without a supervisor to be stopped");
    assert.equal(forget(h, [stale, "--write"]).json.forgotten, true);
  } finally {
    killGroup(agent.pid);
    await h.close();
  }
});

test("clean --forget: a worktrees home that is a link is refused, and nothing where it leads is touched, by the forget or by relay clean's sweep", async () => {
  const h = await harness();
  const scratch = path.dirname(h.home);
  const gone = path.join(scratch, "gone", "repo");
  try {
    const run = await closedRun(h, "LINKED-HOME");
    const node = nodeOf(h, run);
    const treesHome = `${h.home}-worktrees`;
    assert.equal(lstat(treesHome), undefined);
    // Where the link leads: directories by the names relay would remove in its own worktrees home.
    const target = path.join(scratch, "elsewhere");
    fs.mkdirSync(path.join(target, run, node), { recursive: true });
    fs.writeFileSync(path.join(target, run, node, "keep.txt"), "keep\n");
    fs.mkdirSync(path.join(target, ".forgotten-run_0000dead"));
    fs.writeFileSync(path.join(target, ".forgotten-run_0000dead", "keep.txt"), "keep\n");
    fs.symlinkSync(target, treesHome);
    h.sql("UPDATE nodes SET repo = ?, branch = ?, worktree = ? WHERE id = ?", gone, `relay/${node}`, path.join(treesHome, run, node), node);
    const targetBefore = inventory(target);
    const registryBefore = registryOf(h, run);

    for (const args of [[run], [run, "--write"]]) {
      const r = forget(h, args);
      assert.equal(r.status, 1, JSON.stringify(r));
      assert.equal(r.json.reason, `relay will not forget ${run}: relay's worktrees home ${treesHome} is not a plain directory of this user's (a link, say), so relay will not look for the run's worktrees in it, nor remove anything there`);
    }
    assert.equal(registryOf(h, run), registryBefore);
    assert.ok(fs.existsSync(path.join(h.home, "runs", run)));
    const cleaned = clean(h, []);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.match(cleaned.json.temp_dirs_left.join("\n"), new RegExp(`${escape(treesHome)} is not a plain directory of this user's, so relay did not sweep it`), cleaned.stdout);
    assert.deepEqual(inventory(target), targetBefore, "nothing where the link leads was touched");
    assert.ok(lstat(treesHome)!.isSymbolicLink());
  } finally {
    await h.close();
  }
});

test("clean --forget: a run's worktrees left aside by a relay stopped while forgetting it are put back while the registry lists the run, and removed by relay clean once it does not", async () => {
  const h = await harness();
  try {
    const run = await closedRun(h, "ASIDE");
    const node = nodeOf(h, run);
    const treesHome = `${h.home}-worktrees`;
    // As forgetRun's transaction leaves them before it commits: moved aside, the run still listed.
    const aside = path.join(treesHome, `.forgotten-${run}`);
    fs.mkdirSync(path.join(aside, node), { recursive: true });
    fs.writeFileSync(path.join(aside, node, "work.txt"), "work\n");
    // As it leaves them once it has committed: the run no longer listed.
    const forgotten = path.join(treesHome, ".forgotten-run_0000dead");
    fs.mkdirSync(path.join(forgotten, "j_0000dead"), { recursive: true });
    fs.writeFileSync(path.join(forgotten, "j_0000dead", "work.txt"), "work\n");

    const cleaned = clean(h, []);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.readFileSync(path.join(treesHome, run, node, "work.txt"), "utf8"), "work\n", "put back where it was");
    assert.equal(lstat(aside), undefined);
    assert.deepEqual(cleaned.json.temp_dirs_removed, [forgotten], cleaned.stdout);
    assert.equal(lstat(forgotten), undefined);
  } finally {
    await h.close();
  }
});
