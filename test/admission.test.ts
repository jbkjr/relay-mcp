import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { adoptRun, alive, harness, task, until, type Harness, UNAVAILABLE_REPLY } from "./helpers.ts";

// Admission: which refusal a call gets when it fails two of relay's checks at once. Every tool
// writes its own sequence of checks today, and the order is behaviour: the reason an agent is given
// tells it what to do next. These cases pin the order, text and all, so that gathering admission
// into one module (consolidation design R1, CT1) moves the checks without reordering them.

const STUB_ACP = path.join(import.meta.dirname, "stubs", "stub-acp");
/** Codex marks the calls of a native subagent thread in their _meta (see codex-subagent.test.ts). */
const subagent = { "x-codex-turn-metadata": { thread_source: "subagent", session_id: "s", thread_id: "t" } };

const POISONED = "relay context for this agent could not be loaded (this relay server was not started by relay, but the session is a relay child (duplicate server))";
const READ_ONLY_START = "Refused: your current turn is read-only, so you can start only read-only work. Do the reading yourself or delegate it in read mode, and report what would need changing.";
const CHILD_GRANT = "Refused: only the root session can grant extra permissions. Omit grant; if the work needs more than a worktree allows, say so in your report.";
const SUBAGENT_GRANT =
  "Refused: this call comes from a Codex subagent thread, which no person is working in, so it cannot grant network access or write paths: relay cannot tell that the user authorized them, whatever the agent that started you said. " +
  "Make the call without grant (the launched agent then asks relay for what it needs, and the user decides), or return to the agent that started you and ask it to make this call itself with the grant, from its own thread; it can hand you the job_id to wait on with status.";
const UNKNOWN_CALLER = 'Refused: relay cannot tell which agent it is running inside, and its config (same_family "refuse") connects different families of agent only, which it cannot check for a caller it does not know, so it reaches no agent from here. Register relay for your actual host (`relay install <host>`) and start the session again. For a multi-model harness, the user can set same_family "allow"; then name target. Copying a single-family registration does not identify a multi-model session.';
const EXPERIMENTAL = "Refused: Copilot (experimental) is experimental: relay has not yet qualified it with a signed-in run (its login, model selection and protocol behaviour are unverified). Set targets.copilot.experimental to true in relay's config to use it anyway.";

/** The run a node is in. */
const runOf = (h: Harness, id: string): string => h.sql("SELECT run_id FROM nodes WHERE id = ?", id)[0].run_id;

test("admission: continuing refuses kept grants over current config and control paths, including case and data-volume aliases", async () => {
  const h = await harness([{ steps: [{ reply: "ok" }] }]);
  try {
    const shared = path.join(h.env.HOME, "shared");
    const safe = path.join(h.env.HOME, "safe");
    fs.mkdirSync(shared);
    fs.mkdirSync(safe);
    const job = await h.call("delegate", { target: "codex", task: "seed", mode: "write", grant: { write_paths: [shared] }, background: false });
    assert.equal(job.status, "done", JSON.stringify(job));
    const params = JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json);
    // A legitimately granted directory now holds the config behind its original symlink.
    // Keep an unrelated file there so configProtection protects files, not the whole directory.
    fs.writeFileSync(path.join(shared, "notes.txt"), "notes");
    const config = path.join(h.home, "config.json");
    fs.renameSync(config, path.join(shared, "config.json"));
    fs.symlinkSync(path.join(shared, "config.json"), config);
    const paths: [string, RegExp][] = [[shared, /overlaps relay's config (file|or install files)/], [h.home, /overlaps relay's control directory/], [`${h.home}-worktrees`, /overlaps the directory holding job worktrees/], [`${h.home}-harness`, /overlaps the directory holding confined agents' state/], [`${h.home}-consult`, /overlaps the directory questions without a project are asked in/]];
    // Legacy grants can contain these names even though new admission refuses them.
    const backups = path.join(h.env.HOME, "backups");
    fs.mkdirSync(backups);
    fs.symlinkSync(backups, path.join(h.home, "install-backups"));
    paths.push([path.join(shared, "config.json"), /overlaps relay's config file/], [backups, /overlaps relay's config or install files/], [path.join(h.home, "mcp.json"), /overlaps relay's control directory/]);
    if (process.platform === "darwin") {
      for (const [p, why] of [...paths]) {
        paths.push([p.toUpperCase(), why], [path.join("/System/Volumes/Data", p), why], [path.join("/SYSTEM/VOLUMES/DATA", p.toUpperCase()), why]);
      }
    }
    const starts = h.starts().length;
    for (const [p, why] of paths) {
      await until(() => {
        try {
          h.sql("UPDATE nodes SET params_json = ? WHERE id = ?", JSON.stringify({ ...params, grant: { ...params.grant, write_paths: [p] } }), job.job_id);
          return true;
        } catch (e) {
          if ((e as { errcode?: number }).errcode === 5) return false;
          throw e;
        }
      }, 10000, "the registry to accept a legacy grant");
      const refused = await h.call("resume", { job_id: job.job_id, message: "more" });
      assert.equal(refused.refused, true, `${p}: ${JSON.stringify(refused)}`);
      assert.match(refused.reason, /the grant this session keeps from when it was given can no longer be used/);
      assert.match(refused.reason, why, p);
    }
    assert.equal(h.starts().length, starts, "no refused continuation launches a turn");
    const replaced = await h.call("resume", { job_id: job.job_id, message: "safe replacement", grant: { write_paths: [safe] } });
    assert.equal(replaced.refused, undefined, JSON.stringify(replaced));
    assert.equal((await h.call("status", { id: job.job_id, wait_s: 30 })).status, "done");
    assert.deepEqual(JSON.parse(h.sql("SELECT params_json FROM nodes WHERE id = ?", job.job_id)[0].params_json).grant.write_paths, [safe]);
  } finally { await h.close(); }
});

test("admission: when a call fails two checks, the same one wins as before, with the same text", async () => {
  const h = await harness(
    [{ match: task("SEED"), steps: [{ reply: "seeded" }] }, { match: task("WRITER"), steps: [{ reply: "written" }] }, { match: "QUESTION", steps: [{ reply: "answer" }] }],
    { same_family: "refuse", targets: { copilot: { enabled: true, bin: STUB_ACP } } },
  );
  try {
    const host = await h.instance({ args: ["--host", "codex"] });
    const seed = await host.call("delegate", { target: "claude", task: "SEED", mode: "read", background: false });
    assert.equal(seed.status, "done", JSON.stringify(seed));
    const S = seed.job_id as string;

    // A poisoned context wins over everything else the call gets wrong: its cwd, its grant, its target.
    const poisoned = await h.instance({ env: { RELAY_RUN_ID: runOf(h, S), RELAY_NODE_ID: S, RELAY_DEPTH: "1" } });
    const continueNote = " Continue without delegating, consulting, or starting discussions.";
    assert.equal((await poisoned.call("delegate", { target: "claude", task: "x", mode: "write", cwd: "/nonexistent", grant: { network: true } })).reason, `Refused: ${POISONED}.${continueNote}`);
    assert.equal((await poisoned.call("ask", { target: "claude", message: "x", cwd: "/nonexistent", grant: { network: true } })).reason, `Refused: ${POISONED}.${continueNote}`);
    assert.equal((await poisoned.call("resume", { job_id: S, message: "x", grant: { write_paths: ["relative"] } })).reason, `Refused: ${POISONED}.${continueNote}`);
    // cancel and merge word it without the advice.
    assert.equal((await poisoned.call("cancel", { id: S })).reason, `Refused: ${POISONED}.`);
    assert.equal((await poisoned.call("merge", { job_id: S, cwd: "/nonexistent" })).reason, `Refused: ${POISONED}.`);
    assert.equal((await poisoned.call("approve", { request_id: "q_00000000", decision: "allow" })).reason, `Refused: ${POISONED}.`);
    await poisoned.close();

    // A launched agent that passes cwd is told so, even after its turn has ended; merge says the turn ended first.
    const stale = await h.instance(await h.childOf(S, { running: false }));
    assert.equal((await stale.call("delegate", { target: "codex", task: "x", mode: "read", cwd: h.repo })).reason, "Refused: cwd can only be set by the root session. Omit it; you work in your own directory.");
    assert.equal((await stale.call("delegate", { target: "codex", task: "x", mode: "read" })).reason, "Refused: the turn this relay connection belonged to has ended, so it can no longer start or change anything.");
    assert.equal((await stale.call("merge", { job_id: S, cwd: h.repo })).reason, "Refused: the turn this relay connection belonged to has ended, so it can no longer merge.");
    assert.equal((await stale.call("cancel", { id: S })).reason, "Refused: the turn this relay connection belonged to has ended, so it can no longer cancel anything.");
    await stale.close();

    // A read-only turn delegating write work with a grant: the read-only refusal comes before the grant's.
    const ro = await h.instance(await h.childOf(S, { access: "read" }));
    assert.equal((await ro.call("delegate", { target: "codex", task: "x", mode: "write", grant: { network: true } })).reason, READ_ONLY_START);
    assert.equal((await ro.call("delegate", { target: "codex", task: "x", mode: "read", grant: { network: true } })).reason, CHILD_GRANT);
    await ro.close();

    // A launched agent granting, to a target relay could not launch anyway: the grant's refusal comes first.
    const rw = await h.instance(await h.childOf(S, { access: "write" }));
    assert.equal((await rw.call("delegate", { target: "copilot", model: "gpt-6.1-sol", task: "x", mode: "read", grant: { network: true } })).reason, CHILD_GRANT);
    const offNet = (await rw.call("delegate", { target: "copilot", model: "gpt-6.1-sol", task: "x", mode: "read" })).reason;
    if (process.platform === "darwin") assert.equal(offNet, EXPERIMENTAL);
    else assert.match(offNet, /^Refused: Copilot runs only inside relay's own sandbox/);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes WHERE target = 'copilot'")[0].c, 0, "nothing was started on Copilot");

    // A borrowed participant with more access than the caller's turn, and a caller relay cannot place
    // in a family: the participant's refusal comes first. First a discussion held with a write job.
    const writer = await rw.call("delegate", { target: "codex", task: "WRITER", mode: "write" });
    const W = writer.job_id as string;
    assert.equal((await host.call("status", { id: W, wait_s: 30 })).status, "done");
    const opened = await rw.call("discuss", { with: W, topic: "precedence", message: "hello\nCONTINUE" });
    const D = opened.discussion_id as string;
    assert.equal(opened.status, "open", JSON.stringify(opened));
    await rw.close();
    // The caller becomes one whose family relay cannot tell: a harness of several families, no model recorded.
    h.sql("UPDATE nodes SET target = 'copilot', model = NULL WHERE id = ?", S);
    const unknownRead = await h.instance(await h.childOf(S, { access: "read" }));
    assert.equal((await unknownRead.call("discuss", { discussion_id: D, message: "more\nCONTINUE" })).reason, `Refused: ${W} has more access than your current turn does, so you cannot carry on a discussion with it. Report it to whoever started you.`);
    await unknownRead.close();
    const unknownWrite = await h.instance(await h.childOf(S, { access: "write" }));
    assert.equal((await unknownWrite.call("discuss", { discussion_id: D, message: "more\nCONTINUE" })).reason, UNKNOWN_CALLER);
    await unknownWrite.close();
    h.sql("UPDATE nodes SET target = 'claude' WHERE id = ?", S);

    // Resuming a reviewer while its review is open: the review's refusal comes before the grant's, a Codex subagent's included.
    const review = await host.call("review", { target: "README.md", reviewer: "claude" });
    const reviewOnly = `Refused: ${review.reviewer_job} is the reviewer of review ${review.review_id}, which is still open, and until it ends the reviewer is reached only through the review: call review with review_id "${review.review_id}" (and discuss on its reconciliation). You can resume it once the review has ended.`;
    assert.equal((await host.call("resume", { job_id: review.reviewer_job, message: "x", grant: { write_paths: ["relative"] } })).reason, reviewOnly);
    assert.equal((await host.call("resume", { job_id: review.reviewer_job, message: "x", grant: { network: true } }, { meta: subagent })).reason, reviewOnly);

    // A Codex subagent thread granting, to a target relay could not launch anyway: the subagent's refusal comes first.
    assert.equal((await host.call("delegate", { target: "copilot", model: "claude-sonnet-5.5", task: "x", mode: "read", grant: { network: true } }, { meta: subagent })).reason, SUBAGENT_GRANT);
    const unlaunchable = (await host.call("delegate", { target: "copilot", model: "claude-sonnet-5.5", task: "x", mode: "read", grant: { network: true } })).reason;
    if (process.platform === "darwin") assert.equal(unlaunchable, EXPERIMENTAL, "with the probes enabled, an unqualified target not switched to experimental");
    else assert.match(unlaunchable, /^Refused: Copilot \(experimental\) runs only inside relay's own sandbox, and .*, so relay does not launch it\. Use another agent, or do this part yourself\.$/);
    assert.equal(h.sql("SELECT COUNT(*) AS c FROM nodes WHERE target = 'copilot'")[0].c, 0, "nothing was started on Copilot");

    // A follow-up from a root session of unknown family that names the wrong target: the mismatch is
    // an error, given before the unknown caller is refused. The thread's own session has gone, so the
    // root explicitly recovers its run before continuing.
    const asker = await h.instance({ args: ["--host", "codex"] });
    const asked = await asker.call("ask", { target: "claude", message: "QUESTION" });
    assert.equal(asked.reply, "answer", JSON.stringify(asked));
    const T = asked.thread_id as string;
    const owner = h.sql("SELECT root_pid FROM runs WHERE id = ?", runOf(h, T))[0].root_pid as number;
    await asker.close();
    await until(() => !alive(owner), 20000, "the asking session's relay server to exit");
    const unknownRoot = await h.instance({ host: null });
    await adoptRun(h, unknownRoot, T);
    const mismatch = await unknownRoot.call("ask", { thread_id: T, target: "codex", message: "again" });
    assert.equal(mismatch.error, `${T} is a claude thread, not codex`);
    assert.equal(mismatch.refused, undefined);
    assert.equal((await unknownRoot.call("ask", { thread_id: T, message: "again" })).reason, UNKNOWN_CALLER);
    await unknownRoot.close();
    await host.close();
  } finally {
    await h.close();
  }
});

test("admission: an allowed own-family start still gets the depth refusal", async () => {
  const h = await harness([{ match: task("SEED"), steps: [{ reply: "seeded" }] }], { max_depth: 1 });
  try {
    const host = await h.instance({ args: ["--host", "codex"] });
    const seed = await host.call("delegate", { target: "claude", task: "SEED", mode: "read", background: false });
    const child = await h.instance(await h.childOf(seed.job_id, { access: "write" }));
    assert.equal((await child.call("delegate", { target: "claude", task: "x", mode: "read" })).reason, "Refused: you are at depth 1 of 1, the maximum, so you cannot start further agents. Do this part yourself.");
    assert.equal((await child.call("delegate", { target: "codex", task: "x", mode: "read" })).reason, "Refused: you are at depth 1 of 1, the maximum, so you cannot start further agents. Do this part yourself.");
    assert.equal((await child.call("ask", { target: "codex", message: "x" })).reason, "Refused: you are at depth 1 of 1, the maximum, so you cannot start further agents. Do this part yourself.");
    await child.close();
    await host.close();
  } finally {
    await h.close();
  }
});

test("admission: strict own-family refusal precedes depth; default unknown root still checks authority first", async () => {
  const h = await harness([{ steps: [{ reply: "seed" }] }], { same_family: "refuse", max_depth: 1 });
  try {
    const seed = await h.call("delegate", { target: "claude", task: "seed", mode: "read", background: false });
    const child = await h.instance(await h.childOf(seed.job_id, { access: "write" }));
    assert.match((await child.call("delegate", { target: "claude", task: "x", mode: "read" })).reason, /same_family "refuse".*use your own subagents/);
    assert.match((await child.call("delegate", { target: "codex", task: "x", mode: "read" })).reason, /depth 1 of 1/);
  } finally { await h.close(); }
  const allow = await harness();
  try {
    const thread = await allow.call("ask", { target: "codex", message: "owned" });
    const root = await allow.instance({ host: null });
    assert.deepEqual(await root.call("ask", { thread_id: thread.thread_id, message: "other root" }), UNAVAILABLE_REPLY);
    assert.equal((await root.call("delegate", { target: "codex", task: "x", mode: "read", grant: { network: true } }, { meta: subagent })).reason, SUBAGENT_GRANT);
    assert.equal(allow.starts().length, 1, "only the original owner's consult started");
  } finally { await allow.close(); }
});

test("admission: ~ is the home folder in a grant's write_paths, a review's plan and a root's cwd; a relative write path is refused (review C1)", async () => {
  const h = await harness([{ match: task("A"), steps: [{ reply: "ok" }] }]);
  try {
    const home = h.env.HOME;
    fs.mkdirSync(path.join(home, "shared"));
    fs.writeFileSync(path.join(home, "plan.md"), "the plan\n");
    fs.mkdirSync(path.join(h.repo, "notes"));
    fs.writeFileSync(path.join(h.repo, "notes", "plan.md"), "another plan\n");
    const host = await h.instance({ args: ["--host", "codex"] });
    const grant = (p: string) => host.call("delegate", { target: "claude", task: "A", mode: "write", grant: { write_paths: [p] } });

    // Only an absolute path, or one that ~ makes absolute, is a write path; "~x" is not ~.
    assert.equal((await grant("relative/dir")).reason, "Refused: grant.write_paths must be absolute paths (got relative/dir).");
    assert.equal((await grant("~shared")).reason, "Refused: grant.write_paths must be absolute paths (got ~shared).");
    assert.equal((await grant("~/missing")).reason, `Refused: grant.write_paths entry ${path.join(home, "missing")} is not an existing directory.`);
    const ok = await host.call("delegate", { target: "claude", task: "A", mode: "write", grant: { write_paths: ["~/shared/../shared"] }, background: false });
    assert.deepEqual(ok.grant, { network: false, write_paths: [fs.realpathSync(path.join(home, "shared"))] }, JSON.stringify(ok));

    // A plan's file: ~ is the home folder, and a relative path is the caller's directory's.
    assert.equal((await host.call("review", { plan: "~/plan.md", reviewer: "claude" })).plan, path.join(home, "plan.md"));
    assert.equal((await host.call("review", { plan: "notes/plan.md", reviewer: "claude" })).plan, path.join(h.repo, "notes", "plan.md"));
    assert.equal((await host.call("review", { plan: "~/nope.md", reviewer: "claude" })).error, `plan "~/nope.md" is not a file in ${h.repo}. Give the path of the plan's file, or the plan's full text.`);

    // A root's cwd: ~ is the home folder, and a relative one is relay's own directory's.
    assert.equal((await host.call("delegate", { target: "claude", task: "A", mode: "read", cwd: "~/missing" })).reason, `Refused: cwd ${path.join(home, "missing")} is not an existing directory.`);
    assert.equal((await host.call("delegate", { target: "claude", task: "A", mode: "read", cwd: "sub" })).reason, `Refused: cwd ${path.join(h.repo, "sub")} is not an existing directory.`);
    const there = await host.call("delegate", { target: "claude", task: "A", mode: "read", cwd: "~/shared", background: false });
    assert.equal(h.sql("SELECT cwd FROM nodes WHERE id = ?", there.job_id)[0].cwd, path.join(home, "shared"));
    await host.close();
  } finally {
    await h.close();
  }
});
