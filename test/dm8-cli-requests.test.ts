import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runsRelayCommand, requestRunsRelayCommand } from "../dist/core/relay-command.js";
import { launchedTree } from "../dist/core/presence.js";
import { genericApproval } from "../dist/backends/acp.js";
import { CLI, forEachTarget, harness, INTERACTIVE_CLAUDE, task, terminalApprove } from "./helpers.ts";

forEachTarget((target) => {
  // Claude's command requests are refused under the never floor before they are filed (core/approvals.ts),
  // relay's CLI among them: there is nothing for anyone to allow.
  const name = target === "claude" ? "is refused relay's CLI before anyone is asked" : "only the person can allow relay's CLI";
  test(`DM8 CLI request (${target}): ${name}`, async () => {
    const commands = ["relay approve q_1", `node --no-warnings ${CLI} approve q_1`];
    const h = await harness(commands.map((command, i) => ({ match: task(`CLI${i}`), steps: [{ request: command }, { reply: "{{last}}" }] })), { ask_user: "never" });
    try {
      if (target === "claude") {
        for (let i = 0; i < commands.length; i++) {
          const job = await h.call("delegate", { target, task: `CLI${i}`, mode: "write", background: false });
          assert.equal(job.status, "blocked", JSON.stringify(job));
          assert.match(job.result.final_message, /never: Claude command approvals are unavailable under the never floor/);
        }
        assert.equal(h.sql("SELECT COUNT(*) AS c FROM requests")[0].c, 0);
        return;
      }
      const session = target === "codex" ? await h.instance({ ...INTERACTIVE_CLAUDE, args: ["--host", "claude"] }) : { call: h.call };
      for (let i = 0; i < commands.length; i++) {
        const job = await session.call("delegate", { target, task: `CLI${i}`, mode: "write" });
        const pending = await session.call("status", { id: job.job_id, wait_s: 20 });
        const req = pending.needs_approval[0];
        for (const user_confirmed of [false, true]) {
          const r = await session.call("approve", { request_id: req.request_id, decision: "allow", user_confirmed });
          assert.equal(r.refused, true, JSON.stringify(r));
          assert.match(r.reason, /relay's CLI/);
          assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", req.request_id)[0].status, "pending");
        }
        if (i === 0) {
          assert.equal((await session.call("approve", { request_id: req.request_id, decision: "deny" })).decision, "denied");
        } else if (target === "codex") {
          const { request_id, from, wants, kind, effect, in_directory } = req;
          const allowed = await session.call("confirm", { request_id, from, wants, kind, effect, in_directory });
          assert.equal(allowed.decision, "allowed", JSON.stringify({ allowed, note: pending.approval_note }));
        } else {
          assert.equal(terminalApprove(h, req.request_id).json.decision, "allowed");
        }
        await session.call("status", { id: job.job_id, wait_s: 20 });
      }
    } finally { await h.close(); }
  });
});

test("DM8 CLI request: the terminal-path command table", () => {
  const run = "relay approve q_1";
  const yes = [
    run, "/path/to/relay approve q_1", `node ${CLI} join x`, `node --no-warnings ${CLI} approve q_1`,
    "FOO=1 relay approve q_1", "env FOO=1 relay join x", "env -i relay approve q_1",
    ...["exec", "command", "builtin", "nohup", "time", "timeout 30", "nice -n 5", "sudo -u someone", "caffeinate -i", "arch -arm64", "script -q /dev/null", "xargs -n1", "npx", "bunx", "npm exec", "pnpm exec", "pnpm dlx", "yarn"].map((w) => `${w} ${run}`),
    ...[";", "&", "&&", "||", "|", "\n"].map((op) => `echo before ${op} ${run}`),
    `( ${run} )`, `echo $(${run})`, `echo \`${run}\``, `echo "$(${run})"`,
    ...["sh -c", "bash -ec", "sh -xc", "/bin/zsh -lc", "eval"].map((w) => `${w} '${run}'`),
    "find . -exec relay approve q_1 \\;", `python3 -c 'import os; os.system("${run}")'`, "relay approve 'q_1",
    "rg --pre relay x clean", "rg --pre=relay x clean", "LESSOPEN='|relay approve q_1 %s' less README.md", "less '+!relay approve q_1' README.md", "rg relay src",
    "cat <<EOF\nrelay approve q_1\nEOF", "git -C ~/dev/relay status", "curl relay protocol", "r'e'lay approve q_1", "re\\lay approve q_1",
  ];
  const no = ["grep relay README.md", "cat ./relay", "echo relay", "ls ~/dev/relay", "cd ~/dev/relay && npm test", "FOO=1 printf '%s' relay", "echo 'relay approve q_1'", "echo ok # relay approve q_1", "node /unrelated/cli.js", "echo relayer"];
  for (const command of yes) assert.equal(runsRelayCommand(command), true, command);
  for (const command of no) assert.equal(runsRelayCommand(command), false, command);
  const argv = ["env", "X=a b", "relay", "approve", "q_1"];
  assert.equal(runsRelayCommand(argv), true);
  assert.equal(runsRelayCommand(["echo", "relay"]), false);
  // Read the ACP vector from detail, even when the displayed summary would be exempt.
  const ask = genericApproval({ toolCallId: "c", kind: "execute", rawInput: { command: argv } })!;
  assert.deepEqual(ask.detail.argv, argv);
  assert.equal(requestRunsRelayCommand({ kind: ask.kind, summary: "echo relay", detail_json: JSON.stringify(ask.detail) }, process.cwd()), true);
});

// The six recognizer bypasses the cross-family review found (r_04ed60cc; handoff 2026-10-27), each
// written as an attack that would run relay's CLI. The recognizer is defence in depth behind the
// structural terminal check; each of the six returns true from it. Probes 1-3 and 6 are caught by
// main's existing fail-closed handling of `$` words; 4 by the interpreter-in-a-pipeline rule and 5
// by the glob-in-command-position rule, both added here.
test("approve boundary: the six bypass probes are each caught by the recognizer", () => {
  const probes: Record<string, string> = {
    "1 sort --compress-program runs a program": 'sort --compress-program="$x" f',
    "2a zsh (e) code-evaluating expansion": "print -r -- ${(e)x}",
    "2b zsh (%) prompt expansion": "print -rP -- ${(%)x}",
    "2c bash @P prompt expansion": "eval ${x@P}",
    "2d zsh ~ qualifier": "eval ${~x}",
    "3 find -$x relay with x=exec": "find . -$x relay \;",
    "4 interpreter reads a pipeline": "printf 'rela%s --version' y | sh",
    "5 glob in command position": "~/.local/bin/rela? --version",
    "6 PERL5DB executes a program": `PERL5OPT=-d PERL5DB='BEGIN{system "relay approve r_x"}' shasum f`,
  };
  for (const [name, probe] of Object.entries(probes)) assert.equal(runsRelayCommand(probe), true, `${name}: ${probe}`);
});

test("approve boundary: recognizer defence in depth, and the accepted false positives stay closed", () => {
  // An interpreter fed by a pipe: command position relay cannot see, so it fails closed.
  for (const i of ["sh", "bash", "zsh", "dash", "ksh", "fish", "python3", "perl", "ruby", "node", "osascript"]) {
    assert.equal(runsRelayCommand(`printf x | ${i}`), true, `piped ${i}`);
  }
  // The same interpreter not in a pipeline, with no relay in it, is not flagged by this rule.
  assert.equal(runsRelayCommand("sh ./build.sh"), false);
  assert.equal(runsRelayCommand("python3 ./tool.py --flag"), false);
  assert.equal(runsRelayCommand("node /unrelated/cli.js"), false);
  // C5/X3: the pipe rule parses |& and a newline after |, and resolves wrappers before the
  // interpreter test, so none of these slip past it.
  assert.equal(runsRelayCommand("cat f |& bash"), true, "|& is a pipe");
  assert.equal(runsRelayCommand("cat f |\n sh"), true, "a newline after | continues the pipeline");
  for (const w of ["env FOO=1 sh", "command bash", "nice -n 5 zsh", "nohup python3", "timeout 30 perl", "exec ruby"]) {
    assert.equal(runsRelayCommand(`printf x | ${w}`), true, `wrapper before interpreter: ${w}`);
  }
  assert.equal(runsRelayCommand("printf x | sudo -u someone zsh"), true, "sudo -u VALUE resolves to the interpreter");
  assert.equal(runsRelayCommand("printf x | stdbuf -o0 bash"), true, "stdbuf attached-value option");
  assert.equal(runsRelayCommand("printf x | timeout -s KILL 5 perl"), true, "timeout value option then DURATION");
  // C1/X2: a non-shell interpreter given inline code fails closed, by per-interpreter flag.
  for (const c of ["python3 -c 'pass'", "perl -e 1", "perl -E say", "ruby -e 'x'", "node --eval x", "node -p x", "php -r 'x'", "lua -e 'x'", "osascript -e 'x'", "deno eval 'x'"]) {
    assert.equal(runsRelayCommand(c), true, `inline code: ${c}`);
  }
  // C1/X2: shells are NOT flagged by the inline rule — Codex sends every command as zsh -lc '<cmd>'.
  // The -c string is parsed as a nested command instead, so only a relay inside it is caught.
  for (const [cmd, exp] of [
    [["/bin/zsh", "-lc", "npm run check"], false],
    [["/bin/zsh", "-lc", "TMPDIR=/tmp/x bash deploy/tests/run.sh"], false],
    [["/bin/zsh", "-lc", "/usr/bin/python3 -I -B -m unittest discover -s tests"], false],
    ["/bin/zsh -lc 'npm run check'", false],
    [["/bin/zsh", "-lc", "relay approve q_1"], true],
    ["bash -e x.sh", false],
    ["bash -euo pipefail x.sh", false],
    ["ruby -c app.rb", false], // ruby -c is a syntax check, not inline code
  ] as const) {
    assert.equal(runsRelayCommand(cmd as string | string[]), exp, `shell inline: ${JSON.stringify(cmd)}`);
  }
  // X2: `--` ends a wrapper's options; the next word is the command (after timeout's DURATION).
  for (const c of ["env -- echo ok", "nice -- echo ok", "sudo -- echo ok", "timeout -- 5 echo ok", "stdbuf -- echo ok"]) {
    assert.equal(runsRelayCommand(c), false, `end of options: ${c}`);
  }
  assert.equal(runsRelayCommand("printf x | env -- sh"), true, "the command after -- is still the interpreter");
  // X2: --name=value / -o=value is accepted only for a known value option of that wrapper.
  assert.equal(runsRelayCommand("printf x | timeout --signal=KILL 5 sh"), true, "known long value option with =");
  assert.equal(runsRelayCommand("printf x | stdbuf -o=L bash"), true, "known short value option with =");
  assert.equal(runsRelayCommand("env --bogus=1 echo ok"), true, "unknown --name=value on a wrapper fails closed");
  assert.equal(runsRelayCommand("timeout -z=1 5 echo ok"), true, "unknown -o=value on a wrapper fails closed");
  // C3 nit: legacy `nice -10 cmd`, and `exec -a NAME cmd`.
  assert.equal(runsRelayCommand("nice -10 ls"), false, "nice -<digits> resolves to the command");
  assert.equal(runsRelayCommand("printf x | nice -10 sh"), true, "nice -<digits> before an interpreter");
  assert.equal(runsRelayCommand("exec -a name ls"), false, "exec -a NAME resolves to the command");
  assert.equal(runsRelayCommand("printf x | exec -a name bash"), true, "exec -a NAME before an interpreter");
  // Hardening: inline code attached to its flag, and --eval= / --print=.
  for (const c of [["python3", "-cprint(1)"], ["perl", "-eprint 1"], ["node", "-eprocess.exit(0)"], ["node", "--eval=1"], ["node", "--print=1"], ["bun", "--eval=1"]]) {
    assert.equal(runsRelayCommand(c), true, `attached inline code: ${JSON.stringify(c)}`);
  }
  assert.equal(runsRelayCommand(["python3", "-I", "-B", "-m", "unittest"]), false, "python options without -c are not inline code");
  // C5/X3: sed, awk and xargs in ordinary pipelines are deliberately NOT flagged.
  assert.equal(runsRelayCommand("git log | sed -n 1,5p"), false, "sed in a pipeline");
  assert.equal(runsRelayCommand("git ls-files | xargs wc -l"), false, "xargs in a pipeline");
  assert.equal(runsRelayCommand("cat f | awk '{print}'"), false, "awk in a pipeline");
  // || is logical OR, not a pipe: the right side is not treated as reading piped input.
  assert.equal(runsRelayCommand("false || echo done"), false, "|| is not a pipe");
  // Glob metacharacters in command position fail closed (also after a wrapper); in an argument they do not.
  for (const g of ["./rela?", "rela*", "rel[a]y", "~/bin/*"]) assert.equal(runsRelayCommand(`${g} --version`), true, `glob ${g}`);
  assert.equal(runsRelayCommand("env ./rela? x"), true, "glob after a wrapper");
  assert.equal(runsRelayCommand("grep 'a*b' file"), false, "glob in an argument is left alone");
  assert.equal(runsRelayCommand("ls dir/*.ts"), false, "ls is never-run and the glob is an argument");
  // The earlier, accepted false-positive annoyance stays closed (handoff item 3); the structural
  // check makes that acceptable.
  assert.equal(runsRelayCommand("rg --pre relay x clean"), true);
  assert.equal(runsRelayCommand("rg relay src"), true);
});

test("approve boundary: launchedTree reports a relay launch marker in the environment", () => {
  // The structural check's first line: an environment marker relay sets on every launched agent.
  for (const marker of ["RELAY_RUN_ID", "RELAY_NODE_ID", "RELAY_DEPTH", "RELAY_INJECTED"]) {
    assert.match(launchedTree({ [marker]: "x" }) ?? "", new RegExp(marker), marker);
    assert.match(launchedTree({ [marker]: "" }) ?? "", new RegExp(marker), `${marker} empty`);
  }
});

test("approve boundary: relay approve is refused in a launched agent and without a terminal, allowed by a person", async () => {
  const h = await harness([{ match: "BND", steps: [{ request: { web: "example" } }, { reply: "{{last}}" }] }]);
  try {
    const job = await h.call("delegate", { target: "claude", task: "BND", mode: "read" });
    const pending = await h.call("status", { id: job.job_id, wait_s: 20 });
    const req = pending.needs_approval[0];
    // C3: launching the job recorded its worker and agent as group/session leaders for the run.
    const kinds = h.sql("SELECT kind FROM launch_leaders WHERE node_id = ?", job.job_id).map((r) => r.kind).sort();
    assert.deepEqual(kinds, ["agent", "worker"], "the job's worker and agent are recorded as launched leaders");
    // Inside a launched agent's environment (marker present): refused before any decision.
    const marked = spawnSync(process.execPath, [CLI, "approve", req.request_id], { env: { ...h.env, RELAY_NODE_ID: "j_launched" }, cwd: h.repo, encoding: "utf8" });
    assert.equal(marked.status, 2, `${marked.stdout} ${marked.stderr}`);
    assert.match(marked.stderr, /launched agent's environment\. Run it from the person's own terminal\. \(Its environment carries RELAY_NODE_ID/);
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", req.request_id)[0].status, "pending");
    // A plain non-interactive shell (piped stdin/stdout, no TTY): refused for lack of a terminal.
    const noTty = JSON.parse(h.cli("approve", req.request_id));
    assert.equal(noTty.refused, true, JSON.stringify(noTty));
    assert.match(noTty.reason, /interactive terminal/);
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", req.request_id)[0].status, "pending");
    // Typing a wrong code at a real terminal leaves it pending.
    const wrong = terminalApprove(h, req.request_id, { answer: "NOPE11" });
    assert.equal(wrong.json.refused, true, wrong.output);
    assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", req.request_id)[0].status, "pending");
    // A person at a terminal who types back the printed code allows it.
    assert.equal(terminalApprove(h, req.request_id).json.decision, "allowed", "person types the code");
  } finally { await h.close(); }
});
