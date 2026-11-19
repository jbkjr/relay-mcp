# Gemini CLI 0.64.0: qualification record with a real key

Three runs were made on the maintainer's Mac (macOS 27.0.1, 26A434). All used Gemini CLI 0.64.0 from npm, installed into a scratch prefix (`npm install --prefix <scratch>/gemini-cli @google/gemini-cli@0.64.0`), not globally. The key is the maintainer's, saved at the default `~/.config/relay-keys/gemini-api-key` (directory 0700, file 0600). Nothing read it except relay itself and `grep -c`, which prints only a count.

- **2026-10-21, at `ec8f689`** (a private branch). The key's project is on Google's prepaid billing, and it had no credit left: every prompt got HTTP 402, "Your prepayment credits are depleted". Only what needs no model reply could be checked. This run also found two relay faults, fixed the same day. See "First run" below.
- **2026-10-22, at `4e006ae`** (a private commit and one commit of that lane; the credit check ran at `2554f6b`, before that commit). This ran after credit was added. Every check that needed a reply was made. See "Second run" below.
- **2026-10-22, at `072c34b`** (a private branch). Relay's tools reach Gemini through its command-based tool discovery (docs/gemini.md §3.8). This run covers checks 12-17, with 1 and 4 again. See "Third run" below.

Checks 12-15 were run again at `debefe3` (Addendum below). Checks 12-15, with 1 and 4, were then taken on Gemini CLI 0.65.0 at `31ba1c0`, which joined the versions relay offers its tools on: [gemini-0.65.0.md](gemini-0.65.0.md).

The account is a paid tier on prepaid billing. No free key was available.

## Verdict

**Qualified for 1.0 (the maintainer, 2026-10-22), with the residuals below accepted.** `qualified` is now `true` (`src/targets/gemini.ts`). Checks 7 and 11 stay open: they concern Google, not relay ("What is left", below).

**The recommendation the maintainer took: qualify Gemini once a private branch is merged.** The maintainer's bar, that Gemini can use relay's tools, is met at `072c34b`:
- A Gemini job listed relay's ten tools.
- It called `status` and got relay's run tree back.
- It reached Codex with `ask`, and with `delegate` in a call of 54 seconds or more.
- None of these drew a permission prompt, and none left the turn's secret anywhere relay keeps.

Two conditions come with the recommendation:
- **Re-run checks 12-15 on the merged commit.** Review fixes were landing on that branch in parallel. **Done:** checks 12-15 passed again at `debefe3`, the 1.0 line with the review fixes merged (see "Addendum" below).
- **The maintainer accepts the documented residuals below,** as he did for Copilot ("Accept both, documented"). **Done:** accepted on 2026-10-22, when he qualified Gemini.

Every check of docs/gemini.md §8 that concerns what relay does passed against the real binary. The two that did not fully pass concern Google, not relay:
- **7:** whether Google serves free keys;
- **11:** a fallback that a funded paid key cannot be made to take.

| Check | Result | Run |
|---|---|---|
| 1 (`model_usage` with a tool call, pinned and `auto`) | Passed | 2nd, again in 3rd |
| 2 (model menu, reported model) | Passed | 1st, again in 2nd |
| 3 (policy in `default` mode; requests that reach relay) | Passed. Corrects §3.2/§3.6: Gemini refuses a `dir_path` outside its workspace itself, and asks nothing. | 2nd |
| 4 (writes and hosts) | Passed | 1st (startup), 2nd (tools), again in 3rd |
| 5 (`session/load` in a second turn) | Passed, with and without an earlier reply | 2nd |
| 6 (sign-in over ACP, no key in any environment) | Passed | 1st, again in 2nd |
| 7 (whether a free key is served) | Not tested: no free key | |
| 8 (`--include-directories`) | Passed | 2nd |
| 9 (a `/help` message reaches the model) | Passed, as a follow-up and as a resume | 2nd |
| 10 (no MCP server connects) | Passed | 1st, again in 2nd |
| 11 (fallback) | Partly | 2nd |
| 12 (discovery starts, inside relay's sandbox; the tools listed) | Passed | 3rd |
| 13 (a call: `status`, no permission prompt, no stderr, no broker refusal) | Passed | 3rd |
| 14 (a call that starts work, and a long one) | Passed: `ask` to Codex; `delegate` to Codex, background false, 54 s or more | 3rd |
| 15 (what the model sees of the commands; the secret) | Passed: paths only; the secret in no file during or after the turn; `relay-tools` gone | 3rd |
| 16 (read and write jobs; no delegation) | Passed | 3rd |
| 17 (another Gemini version) | Passed on 0.65.0, with and without `allow_untested` | 3rd |

Details for 11:
- A pinned model Google does not serve fails the turn plainly, with no fallback.
- From the 0.64.0 source, Gemini over ACP falls back only silently, and only in two chains: from Flash-Lite, and from Pro to Flash under `auto` on a transient failure.
- No such failure could be caused on a funded key.

The residuals the maintainer accepted on 2026-10-22, all documented in docs/gemini.md and the README:
- What the tool-discovery route does not carry (§3.8):
  - relay's MCP `instructions`, of which the preamble carries the family steering;
  - tool annotations;
  - progress while a call waits, and cancellation of a call (relay ends a call with the turn).
- Codex jobs can read the key file (§2.6; §7, question 4).
- A fallback inside a round shows only from the next round (§3.4).
- An API key in place of an account login.
- What every relay-enforced harness can read: everything of the person's but relay's own and the key's directories. The third run saw Gemini read the qualification driver's scratch files (below).

## Addendum: checks 12-15 again at `debefe3` (2026-10-22)

- **Why.** The review fixes of a private branch were merged into the 1.0 line at `debefe3` (a private branch). One of them changes what checks 12-15 exercise: the helper now runs through its own entry point, `dist/confine/gemini-tools-main.js` with `--no-warnings`, not `cli.js`. The others are an exact version-string gate, Claude jobs kept out of relay's sockets directory, and docs.
- **How.** A detached worktree at `debefe3` (`<checkout>`), built. The third run's driver ran against it (`<scratch>/gq-scripts/drive4.mjs`, which only points at the new build and tells the agents to do nothing else), with the same scratch state and key file and `gemini-3.8-flash`.
- **Result.** Four Gemini jobs and two Codex turns, all passed:

| Check | Item | Result |
|---|---|---|
| 12 | `j_867ec44e` | Passed. The agent listed the same ten `discovered_tool_` tools as `tools.json`. No sandbox denial came from the helper at all. The one `DNSConfiguration` lookup denial is the Gemini harness's own (`node(3388)`, the harness's pid), where the third run's helper also had one per run. |
| 13 | `j_867ec44e` | Passed. `discovered_tool_status` completed with relay's run tree (`{"run_id": "run_6dfb7db1", …`). There was no permission request, and the only `[broker]` line is the probe's, made before the harness is bound. |
| 14 | `j_aa84a673` (Codex `t_0bf1921f`); `j_10f4805c` (Codex `j_62cba7da`) | Passed. `discovered_tool_ask` returned `{"reply": "OK", "thread_id": "t_0bf1921f", …}`. `discovered_tool_delegate`, `background: false`, waited out the 54 s Codex job and returned it; the final message was "DONE". |
| 15 | `j_f04efca9`, and all four | Passed. The model quoted both command strings, which hold paths only (`'<home>/relay-tools/call' --list`, `<home>/relay-tools/call status`). During each turn the secret was in none of `tools.json`, `bridge.json`, the shim or relay's settings; its file was mode 0600. After each turn `relay-tools` was gone, and the secret was in 0 of 415 files under relay's state, the Gemini homes and the worktrees. |

- **The new entry point.** The agent log does not record what Gemini runs, so this comes from outside the sandbox:
  - **The shim** relay wrote reads `exec /usr/bin/env -i '<node>' --no-warnings '<checkout>/dist/confine/gemini-tools-main.js' '<home>/relay-tools' "$@"`.
  - **The process table** shows the helper as `<node> --no-warnings <checkout>/dist/confine/gemini-tools-main.js <home>/relay-tools …`, a child of the Gemini harness, for discovery and for each call. `cli.js` appears nowhere.
- **Stderr empty on success.** The agent log's record of each call says so:
  - Each `tool_call_update` for `discovered_tool_status`, `discovered_tool_ask` and `discovered_tool_delegate` is `completed`, and its content is the tool's stdout alone: relay's JSON.
  - None holds the `Stderr:` block that Gemini 0.64.0 adds when a call fails or writes to stderr.
  - No `[stderr]` line comes from the helper.
- **Bridges.** Relay bridge processes were running on the machine during the run (the full suite was running elsewhere), but none was a child of a Gemini harness.
- **Key.** 0 occurrences, counted with `grep -cF`, in the four agent logs, the driver's output and everything under the scratch directories.

## Third run: relay's tools through Gemini's tool discovery (2026-10-22)

### How it was run

- **The build:** worktree `<checkout>`, branch: a private branch from `072c34b` (a private branch), built.
- **Scratch state:** the same as before: Gemini 0.64.0 from `<scratch>/gemini-cli`, `RELAY_HOME=<scratch>/gq`, the scratch repository and the key file. Gemini 0.65.0 was installed beside it, in `<scratch>/gemini-cli-065`, for check 17 only.
- **The driver:** `<scratch>/gq-scripts/drive3.mjs`, the earlier driver with three more watches outside the sandbox:
  - **The tool files.** Every 150 ms while a Gemini turn ran, it copied what relay wrote to `<home>/relay-tools`: `tools.json`, `bridge.json` and the shim. It also copied the `tools` part of relay's settings.
  - **The secret, in memory only.** It read the turn's bridge secret from the file `bridge.json` names, held it in memory only, and checked it was in none of those files.
  - **After the turns:** whether `relay-tools` was gone, and in how many files under `<scratch>/gq`, `<scratch>/gq-harness` and `<scratch>/gq-worktrees` each turn's secret occurs.

| Item | Run as | Outcome |
|---|---|---|
| `j_ec8f3d60` | `delegate` read: list the `discovered_tool_` tools, call `discovered_tool_status`, quote its description's end | 10 tools; relay's run tree; relay's own text quoted |
| `j_5dce86f6` (and Codex `t_e4e41a06`) | `delegate` read: `discovered_tool_ask` to Codex, "Reply with the single word OK" | "OK" |
| `j_e5e10c5e` (and Codex `j_34f1f888`) | `delegate` read: `discovered_tool_delegate` to Codex, read, background false, `sleep 45` | "DONE"; Codex job 54 s |
| `j_a1a7d017`, `j_91027982` | `delegate` read: quote the sentences of `discovered_tool_status`'s description that name a command or a path | Both command strings, paths only |
| `j_4be16fef` | `delegate` write: list the tools | The same 10 |
| `j_baf68568` | `delegate` read: `discovered_tool_delegate` to Codex in write mode | Refused by relay |
| `j_3163e013` | `delegate` read, `allow_delegation: false`: does it have relay's tools? | "I do not have any of relay's tools …" |
| `j_56fa6a6b` | Gemini 0.65.0, read job: does it have relay's tools? | None, with relay's warning |
| `j_6a892e8b` | Gemini 0.65.0 with `allow_untested`: the same | The 10 tools, with relay's "unverified" warning |
| `t_1e31bfd0`, `t_b84039d8` | `ask`, `auto` with a file read; `ask` pinned with `ls` and a file read | Checks 1 and 4 again |

All on `gemini-3.8-flash`.

### The checks

12. **Discovery starts, inside relay's sandbox.** **Passed.**
    - **Sessions.** Every job that may delegate started its session with relay's settings: `tools.discoveryCommand` `'<home>/relay-tools/call' --list` and `tools.callCommand` `<home>/relay-tools/call`.
    - **The shim.** It is `exec /usr/bin/env -i '<relay's node>' '<relay's cli.js>' gemini-tools '<home>/relay-tools' "$@"`. It ran as relay's Node process `cli.js gemini-tools <home>/relay-tools`, a child of the Gemini harness. It ran twice before the session existed (Gemini's start-up configuration, then `session/new`), and once more for each call.
    - **No exec denial.** No denial names the shim, `/usr/bin/env` or relay's Node. The only denial attributed to the shim's Node processes is `mach-lookup com.apple.SystemConfiguration.DNSConfiguration`, which Gemini's own Node gets too, and which stops neither.
    - **The tools.** Asked to list its tools, the agent (`j_ec8f3d60`) named exactly `discovered_tool_` + `delegate`, `status`, `result`, `resume`, `cancel`, `merge`, `ask`, `brief`, `discuss` and `review`. That is the ten in relay's `tools.json`, and no other `discovered_tool_`.

13. **A call.** **Passed.** `discovered_tool_status` (`j_ec8f3d60`) went through cleanly:
    - It ran as `tool_call` of kind `other`, title `status`, and completed.
    - Its content was relay's run tree: `{"run_id": "run_6eba8ed2", "adoption": {…}, "run_status": "active", "nodes": [{"id": "j_ec8f3d60", …`.
    - No `session/request_permission` was made for it, and none for any discovered tool in the whole run.
    - No `[stderr]` line came from the helper.
    - Each job turn's only `[broker]` line is the boundary probe's own connection, made before the harness is bound: "refused: the launched harness identity has not been bound", 9 in all, one per turn with a broker.

14. **A call that starts work, and a long one.** **Passed.**
    - **`ask` to Codex** (`j_5dce86f6`). `discovered_tool_ask` returned through the tool's stdout: `{"reply": "OK", "thread_id": "t_e4e41a06", …, "families": {"caller": "google", "launched": "openai", "relation": "cross-family", …}}`. The Gemini job's final message was "OK".
    - **A long `delegate`** (`j_e5e10c5e`). `discovered_tool_delegate` to Codex, read mode, `background: false`, with a task of `sleep 45`, ran one call. The Codex job `j_34f1f888` took 54.5 s, and the call returned its result. The Gemini job's final message was "DONE". Gemini did not cut the call off.
    - **The agent went off task.** After the `ask`, `j_5dce86f6`'s agent spent about two and a half minutes exploring. It listed `<scratch>` and `<scratch>/gq-harness`, read this driver and its earlier output files under `<scratch>/gq-scripts`, and grepped relay's source "to check how RELAY REPORT is parsed". `ls <scratch>/gq` (relay's control directory) was refused by the sandbox. Three of its commands (`grep -rn`, `sed -n`, `grep -A`) drew Gemini's own approval requests, which the driver allowed. This is the model, within the reads every relay-enforced harness has. No key was in what it read (count 0), and later prompts that said "do nothing else" kept it on task.

15. **What the model sees of the commands, and the secret.** **Passed.**
    - **What the model sees.** Asked to quote the sentences of `discovered_tool_status`'s description that name a command or a path (`j_a1a7d017`, `j_91027982`), the agent quoted Gemini's two: "This tool was discovered from the project by executing the command `'<home>/relay-tools/call' --list` on project root." and "When called, this tool will execute the command `<home>/relay-tools/call status` on project root." Both hold paths only.
    - **During the turn.** In `j_91027982`, the secret was in none of `tools.json`, `bridge.json` (the socket's and the secret file's paths), the shim or relay's settings. The secret file was mode 0600 and 32 characters long.
    - **After every turn with tools (8 turns).** `<home>/relay-tools` was gone, and the turn's secret was in none of the 198-350 files under relay's state, the Gemini homes and the worktrees (`filesHoldingSecret: 0` each time). That includes the agent logs, which carry every tool call and result.
    - **Wording, for docs/gemini.md §3.8 and §8 item 15.** The description does not end with the command strings. 0.64.0 follows them with a fixed paragraph about the subprocess and its stdout, stderr and exit code (`DiscoveredTool`, `bundle/chunk-PZ4GDG24.js:314776-314793`).

16. **Read and write jobs, and a job that may not delegate.** **Passed.**
    - **The same set.** The write job (`j_4be16fef`) was offered the same ten tools as the read jobs, both in `tools.json` and as the agent listed them.
    - **Write work from a read job.** From the read job `j_baf68568`, `discovered_tool_delegate` with `mode: "write"` was refused by relay, and the result reached the agent: `{"refused": true, "reason": "Refused: your current turn is read-only, so you can start only read-only work. …"}`.
    - **No delegation.** The job with `allow_delegation: false` (`j_3163e013`) had no `relay-tools` directory, and relay's settings for it hold no `discoveryCommand` or `callCommand`. Its preamble says "You may not delegate", and the agent said "I do not have any of relay's tools or any tool whose name starts with discovered_tool_".

17. **Another Gemini version: 0.65.0.** **Passed.**
    - **Without `allow_untested`** (`j_56fa6a6b`): no relay tools, and the agent said so. The turn's warning: "Gemini CLI takes relay's tools through its own tool discovery, which relay has checked on 0.64.0 only; this is 0.65.0, so this agent was given no relay tools and could not delegate. Install Gemini CLI 0.64.0, or set "allow_untested": true in relay's config to offer them unverified."
    - **With it** (`j_6a892e8b`): the ten tools, with the warning "… this is 0.65.0, so this agent's relay tools are offered unverified (allow_untested)." The secret audit was clean and `relay-tools` was gone afterwards. No call was made on 0.65.0; adding it to `toolDiscovery.versions` would take 12-15 on it.

**1 and 4 again** on this build:
- **Check 1.** `t_1e31bfd0` (`auto`, one `read_file`): `prompt response lists "gemini-3.8-flash", "auto"`. `t_b84039d8` (pinned, `ls` and `read_file`): `"gemini-3.8-flash"`. That is as in the second run.
- **Check 4.** Across the run's 14 agent logs, the proxy admitted `generativelanguage.googleapis.com:443` 15 times and nothing else. The only denials were the same as before:
  - the settings write (12);
  - the node-pty helper (14);
  - DNSConfiguration lookups (32);
  - the off-task `ls` of relay's control directory (1).

### Other observations

- **Process noise.** Gemini's shell tool reports `/bin/ps: Operation not permitted` with its commands' output. Gemini looks for background processes with `ps`, which relay's sandbox does not run. It is noise the model sees, and nothing failed by it.
- **No relay misbehaviour found.** No check failed because of relay.

## Second run, with credit (2026-10-22)

### How it was run

- **Scratch state and driver: as in the first run.** `RELAY_HOME=<scratch>/gq`, the same config, scratch repository, granted directory and key file. The driver is `<scratch>/gq-scripts/drive2.mjs`, the first run's driver pointed at the new build.
- **The build:** worktree `<checkout>`, branch: a private branch from a private commit. This includes the first run's two fixes. It also includes `4e006ae`, which writes the prompt response's own model list into the turn's log, so that check 1 has the list as Gemini sent it (below).
- **Credit check first.** One trivial prompt (`t_008f79cd`) answered "OK", and relay recorded `gemini-3.8-flash` as having answered.

| Item | Run as | Outcome |
|---|---|---|
| `t_008f79cd` | `ask`, `gemini-3.8-flash`, no tools | "OK" |
| `t_7000888c` | `ask`, `gemini-3.8-flash`: a shell command and a file read; then two follow-ups, the second starting "/help" | Turn 1 answered; then "# Scratch repo"; then "PONG" |
| `t_6607095d` | `ask`, no model (`auto`), a file read | "# Scratch repo" |
| `j_9ea58d37` | `delegate` write, `gemini-3.8-flash`, granted `<scratch>/gq-grant`, five steps; then a `resume` starting "/help" | Done, commit `eada16b` (`notes.txt`); then "PONG" |
| `t_b70c400a` | `ask`, `gemini-1.5-pro` (retired); then a follow-up | Both turns 404, `ModelNotFoundError` |

- **Launches and prompts.** Nine Gemini processes were launched. Nine prompts reached Google: seven were answered, and two got the 404.
- **Cost.** About 200,000 input tokens in all, almost all on `gemini-3.8-flash` (the write job 98,645 over two turns, `t_7000888c` 56,161 over three).

### The checks

1. **`model_usage` with a tool call, under `auto` and pinned.** **Passed.** Each line is from the turn's log (`4e006ae`).
   - **Under `auto`** (`t_6607095d`, one `read_file` call, so two rounds), the log reads `prompt response lists "gemini-3.8-flash", "auto" in _meta.quota.model_usage`. That is exactly the source's shape (§3.4): the routed model for the first round, then the configured id `auto` for the round after the tool call.
     - Relay recorded `"gemini-3.8-flash"` as having answered (`reports "gemini-3.8-flash" answered this turn`).
     - The item's `served_models` is `["auto", "gemini-3.8-flash"]`: the session's report, then the routed model. That is as designed and tested.
     - No note: `auto` is not a pin.
   - **Pinned** (`t_7000888c` turn 1, a shell command and a `read_file`; `j_9ea58d37`, seven tool calls): `lists "gemini-3.8-flash"` alone. The routed model is the pin, and so is the configured id that keys the later rounds; one entry per model gives one entry.
   - **No helper in any list.** Under `auto` the router's classifier ran, as the first run's stderr showed, and Flash-Lite never appeared.

2. **The model menu.** **Passed again.**
   - Every session listed the same six models as in the first run.
   - `gemini-3.8-flash` was reported as asked.
   - `gemini-1.5-pro`, which is not on the menu, was reported as asked, and Google then refused it (11).

3. **Relay's policy in the forced `default` mode, and the requests that reach relay.** **Passed.** The write job (`j_9ea58d37`) ran these without asking: `write_file` twice, `update_topic`, and `mkdir -p scratch-tmp && rm -rf scratch-tmp`, which is a command Gemini's heuristics could rate dangerous. One request reached relay:
   - **The request:** `git status --short`, git in an untrusted folder. In the agent log it is `session/request_permission`, `toolCall.kind` `execute`, title `git status --short`, one text content `[current working directory <scratch>/gq-worktrees/run_b6a22e45/j_9ea58d37] (Run git status --short to check working tree status.)`, no `rawInput`.
   - **Options:** `allow_once` and `reject_once` only. Relay's `disableAlwaysAllow` holds.
   - **How relay read it:** `kind: "command"`, `wants: "git status --short"`, `in_directory` the worktree, `reason` the description, and the effect "lets it go ahead inside relay's sandbox, which stays on whatever you decide". That is §3.6's reading.
   - **After allowing it:** relay answered `{"outcome":"selected","optionId":"proceed_once"}`, and git printed `?? notes.txt`. Its attempt to write `.git/worktrees/<job>/index.lock` was refused by the sandbox, as §3.2 says.
   - **Correction to §3.2 and §3.6:** a `dir_path` outside the workspace does not ask. Step 4 (`ls` in `<scratch>/gq-outside`) was refused by Gemini itself, with no request: "Path not in workspace: Attempted path "/Users/you/scratch/gq-outside" resolves outside the allowed workspace directories: <worktree>, <scratch>/gq-grant or the project temp directory". docs/gemini.md is corrected.

4. **Writes and hosts, now with tools.** **Passed.**
   - **Writes.** Over this run's nine launches, the sandbox refused writes only to these, each expected:
     - relay's read-only `.gemini/settings.json` (9 times; Gemini ignores it);
     - git's `index.lock` in the repository's `.git` (once).
   - **Exec.** It refused to run `@lydell/node-pty-darwin-arm64/spawn-helper` (twice). Gemini then ran its shell commands without a pseudo-terminal, and they worked.
   - **What the agent wrote.** `notes.txt` in the worktree; `granted.txt` in the granted directory; `scratch-tmp`, made and removed in the worktree; and Gemini's own state under `.cache`.
   - **Hosts.** The proxy's decisions: `allow generativelanguage.googleapis.com:443` 11 times, no other host and no refusal. Gemini needs no host but its API host, through relay's proxy, with the credentials in the proxy URL.

5. **`session/load` in a second turn.** **Passed.**
   - **Loads of sessions that got a reply** (`t_7000888c` turns 2 and 3; `j_9ea58d37`'s resume). Each logged `continued session "<id>"` and then `replay of the session is over (no update for 300 ms); sending the prompt`.
     - In the agent log, the whole replay (the earlier user messages with relay's preamble, the tool calls, the thoughts, the earlier reply) comes before the load's answer. So at runtime 0.64.0 finished its replay before it answered, well within the quiet interval.
     - The replies held none of it: "# Scratch repo", which the model recalled from the earlier turn, then "PONG". No turn warned of a replay after the prompt.
     - The replay sends some odd text chunks of Gemini's own ("[Thought: true]", "[Function Call: read_file]"), which relay correctly left out of the reply.
   - **A load of a session that got no reply** (`t_b70c400a` turn 2, after a turn that got the 404) logged `continued session …` and the replay line. The prompt then got the same 404. So relay's `general.sessionRetention.enabled: false` keeps such a session, through relay, as the first run's direct check of the binary showed.
   - **Confined, native command withheld.** Every resumed turn passed the boundary probes first: 83 for `ask` threads, 105 for the write job. `resume_natively.command` was `null` throughout.

6. **No key in any environment.** **Passed again.**
   - Seen from outside, the key appeared 0 times in the start-up environments of the nine Gemini processes, and the proxy variables were there as the control.
   - Inside the sandbox, the command Gemini ran (`t_7000888c`) listed its own `GEMINI_*`/`GOOGLE_*` variable names: relay's seven, plus `GEMINI_CLI`, which Gemini sets for its tools. There was no `GEMINI_API_KEY` and no `GOOGLE_*`.
   - Its attempt to read Gemini's start-up environment with `ps -wwE` failed: `/bin/ps: Operation not permitted`.

7. **Whether a free key is served.** **Not tested.** No free key was available; this key is on prepaid billing. docs/gemini.md §7, question 5, stays open.

8. **`--include-directories` in the untrusted folder.** **Passed.**
   - `write_file` (`kind` `edit`, title "Writing to ../../../gq-grant/granted.txt", location `<scratch>/gq-grant/granted.txt`) wrote `granted.txt`, which holds "granted".
   - Gemini's own refusal in step 4 names the granted directory among its workspace directories.

9. **A message starting with `/help` reaches the model with relay's line in front.** **Passed, both ways.** The `ask` follow-up (`t_7000888c` turn 3) and the `resume` (`j_9ea58d37` turn 2) each started "/help …", and the model answered "PONG", with `model_usage` `["gemini-3.8-flash"]`. Gemini's own `/help` command would have printed its command list, with an empty `model_usage`.

10. **No MCP server connects.** **Passed again, over a long turn.**
    - The write job's turns had relay's bridge; the probe's refusal shows a broker. Its first turn lasted 38 seconds.
    - Watched every 50 ms, Gemini started no relay bridge process. Of its children, only `git` was caught; its shell commands were too short-lived to sample.

11. **A fallback.** **Partly.**
    - **What was seen.** A model the key cannot use, `gemini-1.5-pro` (retired), failed both turns of `t_b70c400a`: `over ACP: models/gemini-1.5-pro is not found for API version v1beta, or is not supported for generateContent. …`, a `ModelNotFoundError` on stderr. There was no fallback and no prompt response, so no `model_usage`.
    - **Why there was no fallback (0.64.0 source).** `retryWithBackoff` hands a quota or not-found error to `handleFallback` (`packages/core/src/utils/retry.ts:346-418`). But over ACP no fallback handler is set; only the interactive CLI sets one. So a policy whose action is `prompt` (the default) ends in the error (`packages/core/src/fallback/handler.ts`).
    - **When Gemini does fall back** (`availability/policyCatalog.ts`), it is silent, and only in two places:
      - the Flash-Lite chain (Flash-Lite, then Flash, then Pro);
      - under `auto`, from Pro to Flash on a transient failure.
    - **Unlisted models.** A pinned model outside the default chains is a chain of its own, with nothing to fall back to (`availability/policyHelpers.ts`, `applyDynamicSlicing`).
    - **Not seen:** a funded paid key gave no quota failure to cause either fallback. What relay does with one is covered by the stub tests (a model other than the pin answering is noted as a switch within Google).
    - **Recorded:** relay recorded `served_models: ["gemini-1.5-pro"]` for `t_b70c400a`, the model the session reported before the prompt, although no model answered. This is relay's general rule for a session's reported model, for every ACP target, and not specific to Gemini.

### Relay changes from this run

- **`4e006ae` (generic hook): the turn's log records the prompt response's own model list.** Replies to relay's requests are not in the agent's log, so the only record of `_meta.quota.model_usage` was the list after `geminiServedModels` had filtered it, and check 1 could not be evidenced. The line is `# relay: <target>'s prompt response lists "<model>", … in _meta.quota.model_usage`, written before the profile reads the list. The stub test of a routed model checks it.
- **Documentation:** docs/gemini.md is corrected where this run contradicted it:
  - a `dir_path` outside the workspace is refused by Gemini, not asked about;
  - the replay comes before the load's answer at runtime;
  - when Gemini falls back over ACP;
  - the raw `model_usage` lists seen;
  - the node-pty helper refused;
  - and §8.

No relay misbehaviour was found in this run.

## First run, without credit (2026-10-21)

The first run was at `ec8f689`, branch: a private branch from a private branch.

### How it was run

Scratch state only:
- `RELAY_HOME=<scratch>/gq` and `RELAY_CONFIG=<scratch>/gq/config.json`, so relay's harness homes went to `<scratch>/gq-harness` and its worktrees to `<scratch>/gq-worktrees`.
- A scratch repository, `<scratch>/gq-repo`, holding a two-line README and a two-line `calc.py`.
- A granted directory, `<scratch>/gq-grant`, and a directory outside the workspace, `<scratch>/gq-outside`.

The config was `{"targets": {"gemini": {"enabled": true, "experimental": true, "child_auth": "any", "bin": "<scratch prefix>/node_modules/.bin/gemini"}}}`. `HOME` stayed real. `~/.config/relay` has no `local.json`, so relay used the default key path. Nothing of the live install was touched: `~/.config/relay`, `~/.local/state/relay`, `~/dev/relay`, nor the maintainer's `~/.gemini`, which was last changed 2026-10-17.

`relay doctor` with this config reported:
- "gemini (experimental) 0.64.0 … tested with 0.64.0";
- the key file "in place and private; read before each of its turns and handed to its process alone".

The driver (`<scratch>/gq-scripts/drive.mjs`) ran the build's MCP server (`dist/cli.js mcp --host claude`) as a Claude root session through `@modelcontextprotocol/sdk`'s `StdioClientTransport`. It called `ask`, `delegate`, `resume`, `status`, `result` and `approve`. Approve was never needed: no approval request came.

While each turn ran, it also watched from outside the sandbox:
- every process started with relay's policy file: its arguments, the names (never the values) of its `GEMINI_*` and `GOOGLE_*` start-up variables, a count of lines of its start-up environment that hold the key (`ps -wwE … | grep -cF -f <keyfile>`), and a count of its proxy variables, as a control;
- every process descended from a Gemini harness, every 50 ms;
- Gemini's error reports in the turn's temporary directory, checked for the key by count.

The model was prompted 6 times, and every prompt was refused with 402 (each turn's proxy log shows one tunnel to Google):

| Item | Turn | Run as |
|---|---|---|
| `t_eea1dd85` | 1 | `ask`, `gemini-3.8-flash`, with a shell command and a file read |
| `j_bbf997cd` | 1 | `delegate` write, `gemini-3.8-flash`, granted `<scratch>/gq-grant` |
| `t_f5e11127` | | `ask`, no model (`auto`) |
| `t_3a2449a4` | | `ask`, `gemini-3.1-pro-preview`, no tool |
| `t_f0822d8d` | | `ask`, `gemini-3.1-pro-preview`, with a file read |
| `j_87152ad1` | | `delegate` read, `gemini-3.8-flash` |

The follow-ups (`t_eea1dd85` turns 2 and 3, and `j_bbf997cd`'s resume) failed at `session/load`, before any prompt. Nine Gemini processes were launched in all. With 402s only, nothing should have been billed.

### The checks (docs/gemini.md §8)

1. **A prompt with a tool call, under `auto` and pinned, and its `model_usage`.** **Could not be tested.** Every `session/prompt` failed with the 402 before a round finished, so there was no prompt response and no `_meta.quota.model_usage`. Under `auto` (`t_f5e11127`) the router's classifier ran first: stderr has "Could not find promptId in context for classifier-router … Using a fallback ID". Then the main call failed with the same 402.

2. **The model menu for the key, and `--model gemini-3.8-flash` reported back.** **Passed.**
   - Every session listed `offered ["auto","gemini-3.1-pro-preview-customtools","gemini-3-flash-preview","gemini-2.5-pro","gemini-3.8-flash","gemini-3.5-flash-lite"]`. That is the same menu as with a made-up key (§3.4).
   - `--model gemini-3.8-flash` was reported as `model "gemini-3.8-flash"`.
   - `--model gemini-3.1-pro-preview`, which is not on the menu, ran (`acceptsUnlistedModels`) and was reported as asked.
   - With no model, the session reported `"auto"`.

   Whether the API serves these models for this key could not be seen.

3. **The user-tier policy in the forced `default` mode, and which requests still reach relay.** **Could not be tested.** Each session reported `mode "default"`, which relay expects. But no tool call was ever made, so neither the policy nor Gemini's own approval requests (git, `dir_path`, dangerous commands) were exercised. No approval request reached relay.

4. **Writes outside `<home>/.cache`, and hosts through relay's proxy.** **Passed for what ran: startup, sign-in, session creation and one API call per turn.**
   - **Refused writes.** Across nine launches, the only writes the sandbox refused were Gemini's `authenticate` writing its settings: `[sandbox] denied file-write-create …/gemini/.gemini/.settings.json.<pid>.<n>.0.tmp` and `[sandbox] denied file-write-data …/gemini/.gemini/settings.json`, once per launch. The other denials were the ones seen without a key: `mach-lookup com.apple.SystemConfiguration.DNSConfiguration` and `system-info vfs.disk-space`.
   - **What Gemini wrote.**
     - In its home, only under `.cache/.gemini`: `projects.json` and its temp files, `history/<project>/.project_root`, `tmp/<project>/.project_root` and `tmp/<project>/chats/session-*.jsonl`. Outside `.cache`, the home holds only relay's own `settings.json` and `relay-policy.toml`.
     - Each failed call also left an error report (`gemini-client-error-Turn.run-sendMessageStream-<time>.json`) in the turn's private temporary directory, which the sandbox lets it write. It was gone after the turn, and the copy caught during a turn holds neither the key nor the proxy URL (count 0 for each).
   - **Hosts.** Each turn that reached the network asked for one host only, `generativelanguage.googleapis.com:443`, and relay's proxy admitted it: `[proxy] allow generativelanguage.googleapis.com:443`, six times, with no refusal. No telemetry, Code Assist, OAuth or npm host was asked for. Relay's proxy refuses a tunnel without the turn's token (407, `bad-or-missing-token`), so the admitted tunnel shows that undici sent the credentials in the proxy URL. Google's 402 came back through it. This settles the runtime point in §3.7.
   - **Not exercised:** writes by Gemini's tools, and any host its tools or a longer session would want.

5. **`session/load` in a second turn.** **Partly passed.**
   - **Confined, with the native command withheld.** Each resumed turn ran under relay's sandbox, with the boundary probes passing first (83 for `ask` threads, 105 for the write job's resume). `status` gave `resume_natively: { command: null, note: "Relay shows no command to open a Gemini session in your own gemini. …" }`.
   - **The replay could not be seen.** Every load failed: `-32603 "Internal error"`, with `data.details` "Invalid session identifier "<id>". Searched for sessions in …/gemini/.cache/.gemini/tmp/<project>/chats." The cause, from the 0.64.0 bundle, is that Gemini deletes at each start every session file it cannot resume:
     - `main` calls `cleanupExpiredSessions`, in ACP mode too, and `general.sessionRetention.enabled` defaults to true.
     - `getAllSessionFiles` gives a file with no `hasResumableContent` a null `sessionInfo`, and `identifySessionsToDelete` deletes every such file.
     - A session whose only prompt was refused before a reply has nothing resumable, so the next turn's Gemini deleted it before relay asked to load it. In the items that had only one turn, the session file is still there, with the refused user message and no reply. In `t_eea1dd85` and `j_bbf997cd` it is gone.
   - Relay's settings now turn that cleanup off, and a session with no reply then loads (see "Fixed since" below).
   - That the replay ends within relay's 300 ms quiet interval, and that the reply holds none of it, needs a session that got a reply.

6. **`authenticate` with `_meta["api-key"]`, no key in the environment, and the refused settings write ignored.** **Passed.**
   - Each launch logged `login methods offered ["oauth-personal","gemini-api-key","vertex-ai","gateway"]` and then `# relay: signed in with "gemini-api-key", as the profile prepared`.
   - `session/new` then made a session. Without a key it fails "Gemini API key is missing or not configured" (§2.4). Google's 402 names the key's project's billing.
   - Seen from outside the sandbox, the start-up environment of all nine Gemini processes held no `GEMINI_API_KEY`, `GOOGLE_*` or other key variable. The only `GEMINI_*` names were relay's own: `GEMINI_CLI_HOME`, `GEMINI_CLI_NO_RELAUNCH`, `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `GEMINI_CLI_TRUST_WORKSPACE`, `GEMINI_FORCE_FILE_STORAGE` and `GEMINI_SANDBOX`. Lines holding the key: 0. The control, the proxy variables, was readable in each (2).
   - Gemini printed "Error authenticating: … you must specify the GEMINI_API_KEY environment variable" before ACP started, as without a key. After `authenticate` it printed "Failed to save settings: Operation not permitted: '…/gemini/.gemini/settings.json'", and went on.
   - Not run: a command inside the sandbox reading Gemini's start-up environment. That needed the model.

7. **Whether a free key is served.** **Could not be tested.** This key's project is on prepaid billing, a paid tier, with no credit left. A free-tier project would answer quota errors with 429, not 402. §7's open question 5 stays open.

8. **`--include-directories` in the untrusted folder.** **Partly passed.**
   - The write job's launches carried the flag (`gemini.js --acp --policy … --include-directories … --model gemini-3.8-flash`, granted `<scratch>/gq-grant`).
   - Whether `write_file` can write there could not be seen: the task's first round got the 402. `<scratch>/gq-grant` is still empty.

9. **A resume message starting with `/help` reaches the model with relay's line in front.** **Could not be tested.** The `ask` follow-up (`t_eea1dd85` turn 3) and the `resume` (`j_bbf997cd`) that started with "/help" both failed at `session/load` (see 5), before any prompt was sent.

10. **No MCP server connects in the untrusted folder, relay's bridge included.** **Passed.**
    - The job turns had relay's bridge. Their proxy labels name a relay turn (`j_bbf997cd/4`, `j_87152ad1/9`, where the `ask` threads' labels read `t_…/-`). The `session/load` that Gemini quoted on its stderr for `j_bbf997cd` shows `mcpServers: [ [Object] ]`, built the same way as `session/new`'s.
    - No relay bridge process (`dist/cli.js bridge`) appeared during any turn. In `j_87152ad1`, watched every 50 ms, the Gemini harness's only children were two `git` processes.
    - Each job turn's single broker refusal, `[broker] refused: the launched harness identity has not been bound`, is the boundary probe's own `bridge-socket` connection, made before launch.
    - The prompt said "Relay's tools are not available to you in this harness, so you cannot delegate; do the work yourself."
    - Limit: each turn ended about a second after `session/new`, at the 402, so a server started only later in a session would not have been seen. The 0.64.0 bundle has none: `Config.initialize` starts its MCP servers and, in ACP mode, waits for them before the session is made, and `McpClientManager.startConfiguredMcpServers` returns at once in an untrusted folder.

11. **A fallback from a model the key has no quota for.** **Could not be tested.** With no credit, every model fails alike: `gemini-3.1-pro-preview` got the same 402 in one round (`t_3a2449a4`) as with a tool asked for (`t_f0822d8d`). Gemini attempted no fallback on a 402. No model this key has no quota for, while others work, could be identified.

### Relay misbehaviour found

**At `ec8f689`, a Gemini item whose first turn got no model reply could never be continued, and the error did not say why.** Seen on `t_eea1dd85` (both follow-ups) and `j_bbf997cd` (its resume).
- Relay keeps the session id from `session/new` and continues the item with `session/load`.
- Gemini 0.64.0 deletes that session at its next start, because nothing in it is resumable (5 above).
- So every later follow-up or resume fails, and the caller sees only `Gemini (experimental) over ACP: Internal error`. Relay's ACP layer (`connect` in `src/backends/acp.ts`) keeps `error.message` and drops `error.data`, which here held "Invalid session identifier … Searched for sessions in …".

It is no leak and no crash, and relay fails closed. But the item is stuck, and the error tells the caller nothing.

**Fixed since (same day, on a private branch, merged).**
- **Gemini's session cleanup is off.** Relay's Gemini settings now set `general.sessionRetention.enabled: false`, which 0.64.0's schema has (`packages/cli/src/config/settingsSchema.ts:389-437`). Its start-up cleanup (`packages/cli/src/gemini.tsx:786`) then returns before it looks at any session (`utils/sessionCleanup.ts:116`). Relay's user settings outrank the schema's default (`config/settings.ts:255-280`). `session/load` loads a session by its id whether or not it has a reply (`acp/acpSessionManager.ts:216-219`, `allowEmpty`; `utils/sessionUtils.ts:513-547`). So the settings fix is enough, and relay does not start a new session in place of a missing one: a session that is gone all the same fails the turn.
- **The check.** It used the real 0.64.0 binary, outbound network denied by Seatbelt, a made-up key and no prompt, on a copy of `t_f5e11127`'s Gemini runtime state. That copy holds relay's session, whose only prompt got the 402, and a start-up session.
  - With the schema's default, Gemini deleted both at start, and `session/load` answered -32603 "Internal error", `data.details` "Invalid session identifier "9d3df7f4-…"."
  - With relay's settings, both were kept, and `session/load` loaded the session (`currentModelId` `"auto"`) and replayed it (2 updates).
  - Script: `<scratch>/gq-scripts/retention-check.mjs`; output: `out/retention-check.txt`.
- **ACP errors keep their detail,** for every ACP target (`rpcErrorText`, `src/backends/acp.ts`). Relay adds `data.details`, or `data` itself when that is a string, after the message, on one line. It cuts the profile's secrets from it and cleans and clips it as the stderr tail is. A failed load now reads `… over ACP: Internal error: Invalid session identifier "<id>". Searched for sessions in …/chats. Use --list-sessions …`.
- **Tests.** The Gemini stub now copies 0.64.0's start-up cleanup and its load error, and these tests cover it:
  - a job whose first turn failed is resumed by loading its session;
  - one whose session file is gone fails with Gemini's reason, and no new session is made;
  - another load error fails with its detail, the key in it redacted.

  These are in `test/gemini.test.ts`. The unit test of `rpcErrorText` is in `test/acp-hooks.test.ts`.

## Keys in what these runs produced

The key was counted, never printed, with `grep -cF -f ~/.config/relay-keys/gemini-api-key`, a method checked against a positive control. After all three runs it occurs 0 times in:
- relay's scratch state (`<scratch>/gq`: registry, agent logs, proxy and worker logs, prompts and finals);
- Gemini's homes (`<scratch>/gq-harness`, its session files included) and the worktrees (`<scratch>/gq-worktrees`);
- the drivers' output and recorded results (`<scratch>/gq-scripts`);
- `relay doctor`'s output;
- the error reports caught in turns' temporary directories (three);
- the start-up environment of every Gemini process (eighteen over the first two runs, twelve in the third);
- this file and the documentation changed with it.

## What is left

- **7:** whether Google serves free keys to Gemini CLI. That needs a key of a project without billing, and it is Google's policy rather than relay's behaviour.
- **11:** a fallback taken in a real run, which needs a key with no quota for a model Gemini would fall back from. The likeliest case is a free key under `auto` hitting a transient failure on Pro.
- ~~**the maintainer's decision** on `qualified`, and on the residuals listed under "Verdict".~~ Made on 2026-10-22: qualified, the residuals accepted.
