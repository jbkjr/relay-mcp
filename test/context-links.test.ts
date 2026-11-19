import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { writeWorktreeContext } from "../dist/core/context.js";
import { harness, scratchOnly, task } from "./helpers.ts";

// Relay writes a job's identity file into the job's worktree outside any sandbox, and the job's
// agent can write that worktree. Nothing the agent leaves there may steer relay's write elsewhere,
// nor have a relay server read something else, or hang reading it.

const ctx = { run_id: "run_x", node_id: "j_x", depth: 1 };

test("worktree context: a link the agent left at .relay or at its file is replaced, never written through", () => {
  const root = scratchOnly(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "relay-ctx-")));
  try {
    const outsideFile = path.join(root, "outside.txt");
    const outsideDir = path.join(root, "outside-dir");
    fs.mkdirSync(outsideDir);
    const cases: [string, (wt: string) => void][] = [
      ["context.json a link to an outside file", (wt) => {
        fs.mkdirSync(path.join(wt, ".relay"));
        fs.symlinkSync(outsideFile, path.join(wt, ".relay", "context.json"));
      }],
      ["context.json a dangling link", (wt) => {
        fs.mkdirSync(path.join(wt, ".relay"));
        fs.symlinkSync(path.join(root, "not-there.txt"), path.join(wt, ".relay", "context.json"));
      }],
      [".relay a link to an outside directory", (wt) => fs.symlinkSync(outsideDir, path.join(wt, ".relay"))],
      [".relay a file", (wt) => fs.writeFileSync(path.join(wt, ".relay"), "not a directory")],
      [".relay a directory with a link inside", (wt) => {
        fs.mkdirSync(path.join(wt, ".relay"));
        fs.symlinkSync(outsideDir, path.join(wt, ".relay", "inner"));
      }],
      ["nothing there", () => {}],
    ];
    for (const [name, plant] of cases) {
      fs.writeFileSync(outsideFile, "keep");
      const wt = path.join(root, `wt-${cases.findIndex(([n]) => n === name)}`);
      fs.mkdirSync(wt);
      plant(wt);
      writeWorktreeContext(wt, ctx);
      assert.equal(fs.readFileSync(outsideFile, "utf8"), "keep", `${name}: the outside file is untouched`);
      assert.deepEqual(fs.readdirSync(outsideDir), [], `${name}: nothing is written into the outside directory`);
      assert.ok(!fs.existsSync(path.join(root, "not-there.txt")), `${name}: a dangling link is not followed`);
      const dir = fs.lstatSync(path.join(wt, ".relay"));
      assert.ok(dir.isDirectory() && !dir.isSymbolicLink(), `${name}: .relay is a real directory`);
      const file = fs.lstatSync(path.join(wt, ".relay", "context.json"));
      assert.ok(file.isFile() && !file.isSymbolicLink(), `${name}: context.json is a regular file`);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(wt, ".relay", "context.json"), "utf8")), ctx);
      assert.deepEqual(fs.readdirSync(path.join(wt, ".relay")), ["context.json"], `${name}: nothing else is left in .relay`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worktree context: a write job that links its .relay/context.json to an outside file does not get relay to overwrite it on its next turn", async () => {
  // It writes a file, so that its worktree is kept between turns (an unchanged one is removed).
  const h = await harness([{ match: task("LINKER"), steps: [{ write: "made.txt" }, { reply: "wrote made.txt" }] }]);
  try {
    const job = await h.call("delegate", { target: "codex", task: "LINKER", mode: "write", background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree as string;
    const outside = path.join(h.home, "outside.txt");
    fs.writeFileSync(outside, "keep");
    // What the agent could have done during its turn: its worktree is its to write.
    const file = path.join(wt, ".relay", "context.json");
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    await h.call("resume", { job_id: job.job_id, message: "go on" });
    assert.equal((await h.call("status", { id: job.job_id, wait_s: 20 })).status, "done");
    assert.equal(fs.readFileSync(outside, "utf8"), "keep");
    assert.ok(fs.lstatSync(file).isFile());
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).node_id, job.job_id);
  } finally {
    await h.close();
  }
});

test("worktree context: a launched agent's relay server reads .relay/context.json only as a small regular file, never through a link", async () => {
  const h = await harness([{ match: task("KEPT"), steps: [{ write: "made.txt" }, { reply: "done" }] }]);
  try {
    const job = await h.call("delegate", { target: "codex", task: "KEPT", mode: "write", background: false });
    const wt = h.sql("SELECT worktree FROM nodes WHERE id = ?", job.job_id)[0].worktree as string;
    const dir = path.join(wt, ".relay");
    const file = path.join(dir, "context.json");
    const good = fs.readFileSync(file, "utf8");
    const elsewhere = path.join(h.home, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "context.json"), good);
    const cases: [string, () => void, RegExp][] = [
      ["a FIFO", () => {
        fs.rmSync(file);
        execFileSync("mkfifo", [file]);
      }, /not a regular file/],
      ["too large", () => fs.writeFileSync(file, good + " ".repeat(5000)), /larger than 4096 bytes/],
      ["a link to a good file", () => {
        fs.rmSync(file);
        fs.symlinkSync(path.join(elsewhere, "context.json"), file);
      }, /symbolic link/],
      [".relay a link to a directory with a good file", () => {
        fs.rmSync(dir, { recursive: true });
        fs.symlinkSync(elsewhere, dir);
      }, /is not a directory/],
    ];
    // One turn's context for every attempt: each instance is refused before it changes anything.
    const child = await h.childOf(job.job_id);
    for (const [name, plant, why] of cases) {
      plant();
      const inst = await h.instance({ args: child.args, env: child.env, cwd: wt });
      const r = await inst.call("delegate", { target: "claude", task: "x", mode: "read" });
      await inst.close();
      assert.equal(r.refused, true, name);
      assert.match(r.reason, why, name);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      fs.writeFileSync(file, good);
    }
  } finally {
    await h.close();
  }
});

test("worktree context C2: the file is built in a fresh dir and renamed in, never written through a swapped .relay, leaving no temp dir", () => {
  const root = scratchOnly(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "relay-ctx2-")));
  try {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const ctx = { run_id: "run_y", node_id: "j_y", depth: 2 };
    const leftovers = (wt: string) => fs.readdirSync(wt).filter((n) => n.startsWith(".relay.tmp."));

    // A previous turn's real .relay, with extra files: the rename replaces the whole directory, so
    // only context.json remains and nothing stale is left behind.
    const wt1 = path.join(root, "wt1");
    fs.mkdirSync(path.join(wt1, ".relay"), { recursive: true });
    fs.writeFileSync(path.join(wt1, ".relay", "stale.json"), "old");
    fs.writeFileSync(path.join(wt1, ".relay", "context.json"), "old");
    writeWorktreeContext(wt1, ctx);
    assert.deepEqual(fs.readdirSync(path.join(wt1, ".relay")), ["context.json"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(wt1, ".relay", "context.json"), "utf8")), ctx);
    assert.deepEqual(leftovers(wt1), [], "no .relay.tmp.* directory is left behind");

    // .relay is a symlink to an outside directory at the moment of the write (what a racing swap
    // leaves): the rename replaces the link with relay's own directory and never writes through it.
    const wt2 = path.join(root, "wt2");
    fs.mkdirSync(wt2);
    fs.symlinkSync(outside, path.join(wt2, ".relay"));
    writeWorktreeContext(wt2, ctx);
    const st = fs.lstatSync(path.join(wt2, ".relay"));
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), ".relay is now a real directory");
    assert.deepEqual(fs.readdirSync(outside), [], "the symlink's target was not written into");
    assert.deepEqual(leftovers(wt2), []);

    // The identity file itself is a regular file, not a link.
    const f = fs.lstatSync(path.join(wt2, ".relay", "context.json"));
    assert.ok(f.isFile() && !f.isSymbolicLink());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worktree context C1+X3: relay's build directory is outside the worktree, so a swap the agent makes before the write cannot redirect it", async () => {
  const { contextWriteHooks } = await import("../dist/core/context.js");
  const root = scratchOnly(fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "relay-ctx3-"))));
  try {
    const wt = path.join(root, "run", "j_z");
    const outside = path.join(root, "outside");
    fs.mkdirSync(wt, { recursive: true });
    fs.mkdirSync(outside);
    const ctx = { run_id: "run_z", node_id: "j_z", depth: 1 };
    let seen = "";
    // The agent (or something it left running) can change anything inside its worktree, and only
    // that: if relay's build directory were there, it would swap it for a link out before the write.
    contextWriteHooks.afterBuildDir = (dir: string) => {
      seen = dir;
      if (dir === wt || dir.startsWith(wt + path.sep)) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.symlinkSync(outside, dir);
      }
    };
    try {
      writeWorktreeContext(wt, ctx);
    } finally {
      delete contextWriteHooks.afterBuildDir;
    }
    assert.ok(seen && !seen.startsWith(wt + path.sep), `the build directory ${seen} is outside the worktree`);
    assert.deepEqual(fs.readdirSync(outside), [], "nothing was written through a swapped link");
    const st = fs.lstatSync(path.join(wt, ".relay"));
    assert.ok(st.isDirectory() && !st.isSymbolicLink());
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(wt, ".relay", "context.json"), "utf8")), ctx);
    assert.deepEqual(fs.readdirSync(wt), [".relay"], "nothing else is left in the worktree");
    assert.deepEqual(fs.readdirSync(path.dirname(wt)), ["j_z"], "nor beside it");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
