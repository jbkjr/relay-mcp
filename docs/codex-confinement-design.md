# Codex inside relay's own Seatbelt (stage 2): design

Status: revision 2, after review r_92b19bad; the maintainer approved D1-D10 on 2026-10-28 (§10) (Claude plus Codex Daybreak, discussion d_2b476aad; verdict fail, 12 agreed items). Written 2026-10-28 against relay 1.0.4, before any of it was built. Stage 2 shipped in relay 1.1.0 (`targets.codex.stage2`, off by default). This is the design as approved; where the code differs, the code, [pinned-codex.md](pinned-codex.md) and [security-model.md](security-model.md) describe what ships. The disposition of every review item is in §11; the decisions are in §10.

Inputs: a private planning note (the problem, review r_0742cd50 findings C5, X2, X8, the qualification, the maintainer's decisions, the 1.0.5 log); [ADR 0001](adr/0001-relay-enforced-confinement.md); confine-hardening.md (not published); a research note (not published); `src/confine/`; `src/backends/codex.ts`, `codex-app.ts`, `acp.ts`; `src/core/procs.ts`; Codex source 0.164.0 at `/tmp/rcn-src/codex` (Codex paths below are relative to its `codex-rs/`).

Evidence labels:
- **verified (how)**: run on the maintainer's Mac (macOS 27, Darwin 27.0.0, arm64), model-free, under `/tmp/rcs.ZE6N`, against my own listeners and decoys. Scripts and logs: a research note (not published).
- **from source (file:line)**: read, not run. Some lines come from the review and are marked "(review)"; I checked the ones I cite in relay.
- **assumption**: neither.

The probe profiles were built by `mkprof.mjs`. It copies relay's `BASE`, `TRUST`, `KEYCHAIN`, `NETWORK_ON` and `EXEC_SYSTEM` text out of `src/confine/seatbelt.ts` at ee57228 and adds the candidate network block. It lacks relay's per-turn hard denies (`.git`, control directory, config carve-outs, fixed paths) and, unless stated, relay's PTY rule. Those parts are unchanged by this design and covered by relay's existing tests and probes.

## 0. Decision in brief

1. **Architecture unchanged: only Codex's command executor runs inside relay's Seatbelt.** Codex 0.164 sends every command and every `apply_patch` to a separate `codex exec-server` (an "environment"). relay starts it under its own profile and binds the thread to it. The app server stays outside with its login, sessions and model traffic, and runs without Codex's own `local` environment (`CODEX_EXEC_SERVER_URL=none`), so relay's executor is the only place a command can run (review r_0c11d860, §2.2). The cost: no MCP server on a stage-2 turn, relay's own included (§4). Verified (B1, B2, W1-W7; the no-local live tests).
2. **The app server's own local actions are now gated** (review C1, C6). Stage-2 turns always run `on-request`. They are admitted only with relay-only MCP (and then run no MCP server at all), hooks off, and plugins, apps, image generation and skill-dependency installs off, each read back. relay never calls `thread/shellCommand` or `command/exec` on them. The tool list is qualified as an exact allowlist per Codex release.
3. **The executor is supervised** (C5, X3). It is a registered launch leader on a reserved port. Its exit fails the turn, with the app server killed first. At the end of the turn relay kills the app server, then the executor and every descendant it can find, and reports survivors. Verified: a `setsid` child survives a process-group kill and stays sandboxed (W7).
4. **Networking is narrower than revision 1** (C2, C3, C4, C7):
   - TCP listening only on a per-turn block of reserved ports, passed to the job as `PORT`/`PORTS`; verified expressible.
   - relay's own proxies and executors sit in a reserved range that every stage-2 profile denies.
   - AF_UNIX only under TMPDIR, plus the worktree for write turns in relay-made worktrees.
   - UDP to ports 1900 and 5351 denied; the turn fails if the Mac's addresses change.
5. **Stage 2 is a new, separately named, person-only grant** (X5, C2). It does not replace local mode without migration and renewed consent. It cannot run while a relay local-mode proxy runs. Retiring local mode is a decision for the maintainer (§10).
6. **The probe suite gets a stage-2 mode** (X4). The tests that stage 2 deliberately reverses are replaced by decoy-based checks. The filesystem, process and IPC checks stay. The bearer token is memory-only: it is in no file, argv or environment. A confined process of another turn cannot authenticate. Verified (W7).
7. Still rejected: wrapping the whole app server (option A), for the reasons in §3.2.

Estimated size: 6-9 working days of sequential work in seven stages (§12); split into six parallel packages for 1-2 days of wall-clock time (§13).

## 1. Constraints recap

- Codex's sandbox calls `/usr/bin/sandbox-exec` by absolute path. From source (`sandboxing/src/seatbelt.rs:62`).
- Codex has no configurable wrapper for sandboxed commands. `main_execve_wrapper_exe` and `zsh_path` are "ignored compatibility" fields. From source (`core/src/config/mod.rs:1033-1037`).
- A second `sandbox-exec` inside a sandboxed process fails with `sandbox_apply: Operation not permitted`, exit 71. Verified (B3; a research note (not published) §4).
- So whatever runs inside relay's profile must have Codex's sandbox off.

## 2. Architecture

### 2.1 Options

| | A. Whole app server inside | B. Only the executor inside (recommended) | C. Wrapper instead of Codex's `sandbox-exec` |
|---|---|---|---|
| How | `sandbox-exec -p <relay profile> codex app-server …`, Codex at `:danger-full-access` | app server outside; `codex exec-server` inside relay's profile; thread bound to it | not possible (§1) |
| Commands, `apply_patch` | confined (verified A2) | confined (verified B1, B2, W1) | — |
| `~/.codex` from the agent's commands | writable, because the app server needs it; a command rewrote `config.toml` (verified A2) | not writable (verified W1) | — |
| TLS for model traffic | needs `trustd` and `com.apple.SecurityServer`, the keychain downgrade (verified A5-A8) | unaffected | — |
| relay MCP server | needs broker and bridge (C5 of r_0742cd50) | none on a stage-2 turn: a stdio server needs `local`, which the app server no longer has (§4); brokering it is a follow-up | — |
| App server's own local actions (image saves, hooks, MCP, plugin sync) | confined with it | outside; must be switched off and read back (§2.5) | — |
| Codex APIs relied on | stable ones | experimental `environment/add`, `thread/start.environments` | — |

B keeps the trust boundary where it is today: Codex's own process is trusted and unconfined, and the agent's commands are not. Its cost, shown by the review, is that every app-server-side action must be switched off and checked (§2.5).

### 2.2 Turn lifecycle under B

Admission (before anything starts; any failure refuses the turn with the reason):
1. The node holds the stage-2 grant (§6), with the person's consent. The consent is decided and keyed on the grant the turn itself recorded when it was picked up, not on the session's current grant, which a resume replaces at once; admission then reads the stored consent again, last thing before the launch, and refuses unless it is for that very grant (`rawNetworkConsentProblem`, review R2).
2. Codex is 0.164 or later. No `~/.codex/environments.toml` exists, because it takes precedence over `environment/add` and `CODEX_EXEC_SERVER_URL` (from source `exec-server/src/environment.rs:197-208`). `CODEX_EXEC_SERVER_URL` and the Noise environment variables are absent from the person's environment, which admission checks; relay then adds its own `CODEX_EXEC_SERVER_URL=none` (step 10).
3. `child_mcp` is "relay-only" and `child_hooks` is false (review C1, C6; relay applies these only when so configured, `src/backends/codex.ts:277-281`). Otherwise the turn is refused, not downgraded. `child_mcp` still matters without `local`: a stdio server cannot start then, but a streamable-HTTP one can (`codex-mcp/src/runtime.rs:992`). A stage-2 job has no extension servers either (refused at delegate, `NO_NETWORK_WITH_SERVERS`, and again at admission).
4. No relay local-mode Codex proxy is running (§5.4, C2), unless the maintainer retires local mode (§10).
5. The Mac's interface addresses are recorded, and lo0 has no aliases (`loopbackAliases()`, `src/confine/probe.ts:84`).

Launch:
6. relay picks, from its reserved range (§5.5), one executor port `E` and a block of job ports `B`.
7. relay builds the turn's `ConfinementPolicy` with `turnPolicy()` (`src/confine/turn.ts`), the stage-2 network block (§5.1) and the AF_UNIX roots of §2.3.
8. relay runs `prepareLaunch()` (`src/confine/index.ts:216`): the hard-link check, the wrap, and the stage-2 probe mode (§7.1).
9. relay makes a 32-byte token in memory and registers it as a turn secret (`registerTurnSecret`, `src/core/secrets.ts:39`, a new kind "executor token"). It spawns, as a detached launch leader registered in the registry like other agents (`watchProcess`, `src/core/procs.ts:205`):
   `sandbox-exec -p <profile> -D … <codex> exec-server --listen ws://127.0.0.1:E --ws-auth capability-token --ws-token-sha256 <sha256(token)>`.
   Its environment is relay's scrubbed confined-child environment (`agentEnv` plus the sandbox's `stateEnv`), with `TMPDIR` the turn's temp dir and `CODEX_HOME` a directory inside it (review C8: the executor builds each command's environment from its own, from source `exec-server/src/local_process.rs:746-760` (review)). relay checks that the pid is sandboxed (`sandbox_check`, as `acp.ts` `verify`) and that it printed `ws://127.0.0.1:E`.
10. relay starts the app server outside, with `default_permissions=":danger-full-access"`, the pinned features of §2.5, approval policy `on-request` always (C1), no MCP server of relay's, and `CODEX_EXEC_SERVER_URL=none` in its environment (`STAGE2_APP_SERVER_ENV`; the frozen `Stage2Session.env` is what admission checked plus this). Codex then registers no `local` environment and no default one. It calls `environment/add {environmentId:"relay", execServerUrl:"ws://127.0.0.1:E", authBearerToken}` over the app server's stdin, then `thread/start` or `thread/resume` with `environments:[{environmentId:"relay", cwd}]`.
11. Readback, before the prompt: `environment/status` for `local` answers `unknown` (`stage2LocalProblem`; 0.164.0 replies `{status:"unknown", error:"unknown environment id \`local\`"}`, and `ready` when Codex has it); profile `:danger-full-access`; a fresh thread's `environments` exactly `[{environmentId:"relay", cwd, runtimeWorkspaceRoots:[cwd]}]`, a resumed one's that or none; the §2.5 settings in `config/read` and `experimentalFeature/list`; `hooks/list` empty; no MCP server on in `config/read`, relay's own included, and in Codex's MCP listing (`mcpServerStatus/list`) only servers `config/read` shows switched off. Before the thread exists the listing reports which servers the thread would start, not which run (`runtimeStatus` is null until there is a thread), and Codex starts each enabled server it lists once to read its tools; so relay asks for it last, only when everything else has read back, and by then none is enabled (review R7).

During the turn:
12. relay watches the executor. If it exits, relay kills the app server first, so it cannot reconnect to whatever later holds port `E`, then fails the turn (C5). The app server reconnects to the same URL with the same token after a drop (from source `exec-server/src/remote.rs:810-891` (review)). A squatter on `E` would still run inside its own sandbox and gain no wider authority. It is an integrity failure, not an escape.
13. relay polls the Mac's interface addresses (every few seconds, and before each approval). A new or changed address fails the turn, because the probes did not cover it (C7). As built: a new IPv6 link-local address does not count. macOS rotates those on awdl0 and llw0 every few minutes (WP-F saw two failed turns in ten minutes), and the stage-2 rules deny the denied and reserved ports over IPv6 at every host, so a new one opens nothing.

Teardown, before relay checkpoints or commits the worktree:
14. Kill the app server; kill the executor's process group; kill every descendant `watchProcess` recorded; look once more. Report survivors in the turn's log and result, as relay does for other agents. Verified that this matters: after a group kill, a `nohup` child died but a `setsid` child survived, with PPID 1, its own session, and still sandboxed (W7). A PTY session left running (`tty:true`) died with the executor (W7). The executor does not die with its parent: `--exit-on-stdin-close` is accepted only with `--remote` (verified). My own W5 executor of revision 1 was left running, orphaned, until the lead stopped it: the same failure.
15. relay's descendant tracking alone is best effort (`src/core/procs.ts`): a process detached between looks is missed. So teardown also runs the survivor sweep (built, `src/core/stage2-executors.ts` `sweepSurvivorsNow`; review r_0c11d860 C2, C3, C5, X3): it asks the kernel, for each of the maintainer's processes, whether its sandbox lets it write the turn's temp dir and not the directory holding it (`sandbox_check` with a path filter, through the compiled helper `dist/native/relay-sbcheck`, `src/confine/sbcheck.ts`). Only this turn's processes answer so. Each process a look finds is stopped (SIGSTOP) before the next look, so it cannot fork or detach in between; once a look finds nothing new, all are killed and a last look must find nothing at all. A look that fails (helper unavailable or changed, ps or the helper failing, a process the kernel cannot answer for) or 64 looks without converging is not a clean sweep. Then, or when anything would not die, the executor's record is kept, tainted, and its lease stays quarantined (the lease names the record): local mode stays refused (`localModeRetired`), the ports are not leased again, and reap and retention sweep it again until a sweep comes out clean. A stage-2 turn is refused at admission while the helper is unavailable (`openStage2`), and doctor says so. The same sweep stops an executor whose worker died (reap, cancel, retention).

What this gives (from revision 1, still true, and since r_0c11d860 by construction):
- There is no `local`: with `CODEX_EXEC_SERVER_URL=none` Codex registers no environment of its own (`exec-server/src/environment_provider.rs` `normalize_exec_server_url`). Verified on 0.164.0, model-free and live: `environment/status local` answers `unknown`; `thread/start` with `local` is refused ("unknown turn environment id `local`"); a thread started or resumed without environments has none; a command in such a turn gets "No usable execution environment is available"; Codex refuses its user shell command, `command/exec` ("local environment is not configured") and `fs/*` ("local filesystem is not configured").
- Tools see one environment, so they take no `environment_id` and cannot name `local`. From source (`core/src/tools/spec_plan.rs:1250`).
- An unreachable executor makes tools fail with "No usable execution environment is available". Nothing runs locally. Verified (W4).
- Codex subagents and delegates inherit the parent's environments. From source (`core/src/tools/handlers/multi_agents/spawn.rs:134`); the review confirmed the same for fork and review delegates. Verified for subagents (WP-C, below).

**Resumed turns: the binding is per turn (WP-C, 2026-10-28, as built; WP-F item 11).** Codex 0.164's `thread/resume` takes no `environments` (it ignores the key). A resumed thread gets Codex's defaults instead. With Codex's own `local` registered, that was every environment the server knows, `local` first, so `[local, relay]`, and a command the model sent there without naming an environment ran in `local`, unconfined (F item 11; WP-C again with a marker in /tmp). On relay's stage-2 app server, which has no `local`, the defaults are nothing: a resumed thread has no environment, and so no workspace roots, until relay binds the turn (seen live on 0.164.0: reply `environments: []`, `runtimeWorkspaceRoots: []`). As built:
- **Every stage-2 `turn/start`, fresh or resumed, carries `environments: [{environmentId: "relay", cwd}]`** (`stage2TurnParams`). Codex applies it before the turn starts, in the request that carries the prompt (`turn_processor.rs`: thread settings, then `start_or_steer_turn`), for this turn and every later one of the thread. There is no gap between the binding and the prompt.
- **Readback after the reply:** `thread/read` must report exactly relay's executor at cwd (`stage2TurnReadback`; it reports the live thread's environments). Otherwise relay kills the app server and fails the turn.
  - In a git cwd, Codex writes a new thread's rollout only after collecting git information (about 20 ms here). Until then, `thread/read` refuses with "rollout at … is empty" (WP-F, 2026-10-28). The git information is collected by the app server itself (`rollout/src/recorder.rs`, `git` run directly), not through an environment, so this is unchanged without `local`.
  - relay retries that refusal alone, every 25 ms, for at most 10 s, which is Codex's own worst case for its git commands. Any other error, or the deadline, fails the turn.
  - The retries happen only on fresh threads, whose `thread/start` reply already showed relay's executor alone.
  - The environments are on no notification, and `thread/loaded/list` returns only ids, so there is no other read.
- **The `thread/resume` reply** may show relay's executor alone or, as 0.164.0 replies, no environment and no workspace roots (`stage2ThreadProblem` with `resumed`); never `local`. A `thread/start` reply must show only relay's executor. The roots of a relay-enforced thread are checked there, not by `threadPermissionsProblem`.
- **Turns Codex starts by itself (review r_0c11d860 C1+X2).** On resume Codex can start a turn before relay's `turn/start`. Two such sources were found on 0.164.0: an active goal's continuation (`ext/goal` `on_thread_idle`, emitted right after the resume reply), which the model can set up with `create_goal` in an earlier turn; and a message queued for the thread (`ext/queue`), by another client, or after relay's queue check (the race). With `local` registered both ran their commands there. Relay's `turn/start` does not rebind such a turn: it steers into it (`turn_processor.rs:661-693` maps Started and Steered to the same reply; `turn_input.rs:213-221` `apply_steered` changes only the sticky settings; a running task keeps its environments, `core/src/session/tests.rs:8327-8371`), so the guard and the readback could both pass while the running turn still ran commands in `local`. Detection after the turn starts is not enough, so this is now **prevented by construction**: the app server has no `local`, and such a turn starts with no environment. Verified live on 0.164.0 straight through Codex with relay's flags and environment (test "no local, straight through Codex"): a queued message's turn and, with goals switched back on, a goal's turn each started by themselves, a `turn/start` bound to "relay" steered into each (same turn id), and the command each then issued got "No usable execution environment is available" and wrote nothing; the control with `local` ran the same command unconfined after the same steer. Through relay (test "no local, through relay"), a message queued on relay's own app server after its queue check either waited (relay's turn won) or started first and failed the turn at the guard; nothing ran outside the sandbox either way. Kept as defence in depth:
  - `features.goals` pinned off and read back, the goal tools out of `STAGE2_TOOLS`;
  - `thread/queue/list` must be empty before resume, or relay refuses it (`stage2QueueProblem`);
  - **`Stage2TurnGuard`**: a `turn/started` before relay sends its own `turn/start`, or a second turn on the session's thread, kills the app server and fails the turn. It keeps relay from reporting a turn it did not start; it is no longer what keeps that turn's commands confined.
  - **relay's tools in such a turn** (review r_b52db760 C1; authoritative order from broker §14). An HTTP MCP server needs no environment, and `turnRefusal` passes once the registry marks relay's turn running, so a turn Codex started by itself could still call relay's tools (`delegate` included) before the guard's kill lands. The broker therefore refuses `tools/call` until `codex-app.ts` validates relay's own `turn/start` reply with `guard.replied(started.turn.id)`, then **arms immediately before awaiting `stage2TurnReadback`**, per [broker design §14](codex-mcp-broker-design.md#14-confirmation-d_63ad5c08-2026-10-29-build-revision-2-with-one-change). The executor binding travels in that same `turn/start`; readback is defence in depth and may retry while the model is already running. On a mismatch or readback failure, disarm, kill the app server first, then fail the turn and tear down the executor. `initialize` and `tools/list` stay open before arming. It disarms at relay's `turn/completed` and at teardown. From source: confirmation d_516f2cd5 reports the production-order first-tool-call test passes live; integrated qualification must rerun it without manual `arm()`, serving relay's first call while refusing a self-started turn's call.
- **Subagents** take the live parent's environments. That covers ones spawned in the bound turn, and ones from earlier turns reached again (`followup_task`, `send_message`; v1 `resume_agent`, `send_input`). They run in the executor when the turn is bound, and nowhere when it is not. Verified for v2 (gpt-6.1-sol) and v1 (gpt-5.5) straight through Codex, and through relay's path (live test "resume").
- **Residual.** The readback runs after the prompt has gone in; a Codex that ignored `turn/start.environments` on a resumed thread would leave the turn with no environment, so its commands would fail rather than run elsewhere. Per-release qualification still checks the binding (F item 11, resumed and bound) and that `none` still removes `local` (F items 3 and 11).
- **Taken: `CODEX_EXEC_SERVER_URL=none` for the app server** (review r_0c11d860, agreed with the Codex reviewer; revision 2 had not taken it). Its cost: no stdio MCP server starts ("local stdio MCP server … requires a local environment", `codex-mcp/src/runtime.rs:992`), and relay's own MCP server is one. So a stage-2 job has no relay tools (no nested `delegate` or `ask`) until relay's server is brokered over an authenticated, non-stdio transport outside the job's reach (§4, follow-up). What else needed `local`, checked against the 0.164.0 source:
  - hooks: already off; `apply_patch`, `view_image`, `AGENTS.md` and repository skill discovery go through the turn's environment, relay's executor;
  - relay's skill package: an extra skill root, read by the app server itself through its own file system (`ext/skills/src/host_roots.rs` `local_root`, `LOCAL_FS`), so it still loads; seen live with `skills/list`. **New blind spot:** `skills/list` reads repository skills through the default environment, which no longer exists, so relay's check of what Codex will load (`skillsProblem`) no longer sees repository skills, while the turn finds them through relay's executor. Verified model-free on 0.164.0: a `.agents/skills` skill in the cwd was absent from `skills/list` but offered to the model in the turn; with a `skills.config` entry for its path, as relay writes, it was not offered. relay's `skills.config` still switches off every repository skill relay's own scan finds (`codexSkillFiles`); a place that scan misses is no longer caught by the readback (§8 item 10);
  - code mode's host (`codex-code-mode-host`), the git information for the thread, hosted `web_search` and `web__run`: run by the app server directly, unaffected;
  - subagents: inherit the parent's environments (above);
  - `thread/archive` and `thread/unarchive`: unaffected (live tests resume archived threads).
- **Approvals (review R4).** A command approval is shown only when its `environmentId` is relay's executor; any other is declined and fails the turn (`stage2CommandEnvironmentProblem`). File-change approvals carry no environment, nor does their item, so they are not marked confined. This Mac's addresses are read again before each approval (`InterfaceWatch.changed`).
- **The app server's environment.** It runs with exactly the environment admission checked plus relay's own `CODEX_EXEC_SERVER_URL=none`, a frozen copy (`Stage2Session.env`, `stage2AppServerEnv`). `startCodexAppTurn` refuses any other object. The executor's environment never carries the variable (`executorEnv`).

### 2.3 What confines files and sockets

- The thread runs at `:danger-full-access`. relay's Seatbelt profile around the executor is the only boundary for commands and `apply_patch`.
- With a restricted Codex profile, the executor nests `sandbox-exec`: commands exit 71 and `apply_patch` fails. Verified (B3). A Codex change that re-enables its own sandbox fails closed.
- `apply_patch` runs in the executor: outside the roots it failed, inside it succeeded (B2, W1). Without relay's profile both succeeded (B0).

| Rule today (`codexPermissions`, `src/backends/codex.ts:329`) | Stage 2 (relay profile) |
|---|---|
| `:root` read | `(allow file-read*)`. Reads stay broad. |
| worktree writable (write turns) | `worktreeWritable`, pinned. |
| granted directories | `writable` + `writablePins`, checked each turn. |
| `:tmpdir` write | `tmpDir`, a fresh `~/.relay-t/relay-tmp-*`. |
| `HARNESS_CONFIG` read-only at each root's top | `configDenied`, same list. |
| Codex's `.git`, `.agents`, `.codex`, `.aws` protection | relay's `.git` hard denies; the rest are in `HARNESS_CONFIG`. |
| child_git "native": git dirs writable | Not available; relay commits for the agent (decision D6). |
| 1.0.5 credential denies | `denied` entries, plus all of `~/.codex` (decision D8). The executor needs none of it (verified W2-W7). |
| relay's control dir, sockets dir, config, key paths | always denied. |
| (none) | Executables only from system, Homebrew, `/usr/local`, developer tools, writable dirs and `execPaths`. |
| AF_UNIX: Codex's profile per mode | TMPDIR always. The worktree only for write turns whose worktree relay created and pinned (C4). Read and consult turns run in the caller's directory, which may be the person's checkout or home (`src/core/ops.ts:511, 663` (review); `turnPolicy` sets `worktree: spec.cwd`), so they get TMPDIR only. |

Skill packages (C8): relay writes a turn's consented package in its control directory (`src/core/session.ts:217-220`), which the profile denies, so commands cannot read a skill's scripts. Discovered personal and repository skills are already off: `codexFlags` disables them and advertises only relay's package root (`src/backends/codex.ts`, `skills.config`). Fix: for stage-2 turns, copy the package to a per-turn asset directory outside relay's control directory and outside every writable root (for example `~/.relay-t/relay-ext-*`, mode 0700). It is then readable by commands and not writable by them. Point Codex's extra skill root at it.

### 2.4 Accounting (review X8 of r_0742cd50; C9, X6)

Today a null Codex profile means `allow_dangerous`, and some places read it that way (`commandAsk`, `src/backends/codex-app.ts:151`; `threadPermissionsProblem`, `codex-app.ts:378`; `hardLinkProblem` only for "verified" targets, `src/core/worktree.ts:89-90`).

- Add `enforcement: "codex" | "relay"` to `CodexPermissions`. Stage-2 turns are `{ id: ":danger-full-access", profile: null, sandbox: "danger-full-access", network: <relay's>, enforcement: "relay", environment: "relay" }`. `allow_dangerous` stays `enforcement: "codex"` with no environment.
- Confinement becomes a property of the turn: `turnConfinement(spec)` returns "verified" or "relay-enforced". Admission, the hard-link check, the probes, doctor and the turn's log use it. The registry records it, so `status`, `brief` and the approval view say "confined by relay".
- Only two kinds reach relay as Codex approvals: `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`. Elicitations are declined and anything else is answered with an error (`codex-app.ts:808-818`). Stage-2 turns stamp `detail.confined = true` on those two kinds only, because they are proven to run in the executor. MCP tools, extensions, hosted tools and anything else keep their normal outside-the-sandbox accounting (`src/core/approvals.ts:101-103`). Tests per kind on `requestView`.
- `threadPermissionsProblem` for `enforcement: "relay"` checks the readback of §2.2 step 11.
- The executor token is registered as a turn secret, so relay's redaction removes it from logs and errors. Codex warns that executor connection errors can carry credentials (review C9).
- Audit every other reader of `":danger-full-access"` and `profile === null` (`install/doctor.ts:238` among them). `env-broker.ts:200` keys on `allow_dangerous` and is already right.

### 2.5 The app server's own local actions (C1, C6, X1, X2)

Feature policy is version-specific. The validated selected pin retains its manifest version;
admission also retains the selected executable's checked version for the turn. Planning uses
that version, and readback receives the exact planned off-list, without resolving `current`
again. The 0.164.0 policy does not require keys that release does not list. From 0.166.0:

- `plugin_discovery_prefetch=false`: `app-server/src/message_processor.rs` passes the feature
  to `core-plugins/src/manager.rs` startup tasks, which can prefetch remote plugin discovery
  on the host. `plugins=false` already gates the tasks; the additional pin is defence in depth.
- `prediction_preserve_parent_tools=false`: `core/src/session/mod.rs` preserves parent tool
  declarations only with the MCP-disabled marker used by prediction and `thread/sample`
  forks. Relay calls neither API and pins this off; item 10 checks the applicable pins and
  normal-turn tool surface without enabling those APIs.
- `reasoning_effort_override` may be on (default off in 0.164.0, on in 0.166.0).
  `core/src/session/reasoning_effort.rs` records trusted `configuration_update` effort items;
  `core/src/client.rs` sends those with a request-effort baseline. It adds no tool or host
  action. Item 10 checks explicit effort through relay on a fresh turn and a changed-effort resume.

`deferred_tool_world_state=false` on every admitted version. 0.164.0 and 0.166.0 list it under
development, default off; 0.167.0 makes it stable and on by default. Its description at
`rust-v0.167.0` is "Describe deferred tool namespaces in the model-visible world state": when on,
`core/src/session/world_state.rs` adds a section naming the deferred tool namespaces and
`core/src/tools/spec_plan.rs` drops the source listing from tool_search's description. It adds no
tool or host action. Relay pins it off as defence in depth and to keep the model-visible context
of the qualified 0.166.0.

`incremental_tools_legacy_gcp=false` from 0.167.2 (`stage2FeaturesOff`). 0.167.2 adds it,
`Stage::Stable` and on by default ("Publish incremental tool declarations on regular GCP
Responses", `features/src/lib.rs`); 0.167.0 and 0.167.1 do not list it, so it is not required
there. At `rust-v0.167.2`, `core/src/session/step_context.rs` selects it only when the turn's model
provider is `gcp`, to record tool declarations in history on new context windows. Relay's turns use
OpenAI's provider, so it adds no tool or host action there. Relay pins it off as defence in depth
and to keep the qualified 0.167.0's behaviour, rather than admitting it.

From 0.170.0 (`stage2FeaturesOff`, `STAGE2_FEATURES_OFF_0170`), seven more are pinned false and must
be listed false. 0.170.0 makes each one `Stage::Stable` and on by default, where 0.167.2 had it under
development and off, or did not list it. At `rust-v0.170.0` none adds a tool or host action:
- `code_mode_host_grpc` (core `thread_manager.rs`) picks the gRPC code-mode host provider. That host
  is the same unsandboxed `codex-code-mode-host`, over the child's stdio (`code_mode_host.rs`,
  `--listen grpc+stdio://`). Like the process-owned host since at least 0.167.2, it runs in a
  process group of its own. So relay's group kill never reached either host; teardown stops the
  host as a recorded descendant of the app server (`watchProcess`, step 14). Both exit within
  0.25 s of the app server's death even with a busy cell. Only the wire protocol and session
  recovery differ. Pinned off for parity with 0.167.2 until a qualification runs with it on.
- `code_mode_host_output_truncation` truncates `exec` output in the host instead of the client.
- `guardian_include_additional_context` adds tool outputs to Guardian's review history. Relay
  answers approvals itself.
- `incremental_tools_legacy` is read only for the Amazon Bedrock providers (`step_context.rs`).
- `retain_client_tool_outputs` and `unified_image_budget` change compaction and the image budget.
- `untrusted_as_tool_output` renders untrusted additional context, a turn's `additionalContext` or a
  goal's objective, as a tool output rather than a user fragment. Relay sends no additional context
  and pins goals off. `test/stage2-untrusted-context.test.ts` fails if relay ever sends
  `additionalContext`, so the pin is reconsidered then; on is the safer rendering.

Relay pins all seven off to keep the qualified 0.167.2's behaviour, rather than admitting them.
0.170.0 also marks `plugin_discovery_prefetch` `Stage::Removed`: config ignores the key, and
`experimentalFeature/list` still lists it, off, so its pin reads back unchanged. Plugin startup,
every task of which stays inside `plugins_enabled` (`core-plugins/src/manager.rs`), no longer
warms the catalog or the featured ids.

0.170.0's catalog also forces `send_message_to_user_async` into the tool list of root turns through
a model's `experimental_supported_tools` (`tools/spec_plan.rs`), whatever its feature says. Its
handler emits an agent-message item and returns. It is in `STAGE2_TOOLS`. Code mode's isolate gains
the helper `content` (`code-mode-runtime` `globals.rs`, `content.js`). It emits text or inline
media as `exec` output and refuses file references, as `text`, `image` and `audio` do. It is in the
qualification's `ISOLATE_GLOBALS`.

These rationales refer to source at tag `rust-v0.166.0`; they do not qualify that release.
Every required off feature must still be listed and false, and any enabled feature outside
the applicable off-list and allowed-on list refuses the turn.

The app server is unconfined. Everything it does itself, rather than through the executor, is outside relay's profile. With `:danger-full-access` plus approval `never`, Codex treats the turn as full access and approves some of these itself (review C1, from source `codex-mcp/src/mcp/mod.rs:91-110`, `core/src/session/mcp.rs:948-972`, `core/src/mcp_skill_dependencies.rs:251-257` (review)). relay sets `never` today for jobs that may not escalate (`codex-app.ts:959`).

| Action | Where it runs | Stage-2 control (read back) |
|---|---|---|
| MCP tool calls, elicitations (incl. `request_plugin_install`) | app server | no MCP server runs on a stage-2 turn, relay's own included (§4); `on-request` always, so anything that still asked would come to relay, which declines elicitations |
| Person's MCP servers, plugin MCP servers (`node_repl`, `cua_repl`) | app server's children | relay-only MCP and `--disable plugins` required; `config/read` shows none on, and `mcpServerStatus/list` only servers `config/read` shows switched off. Without `local` a stdio server cannot start at all; a streamable-HTTP one still could, so the switches stay |
| Skill MCP-dependency installs (write global `config.toml`) | app server | `features.skill_mcp_dependency_install=false` (already set for every launched turn) |
| Image generation saves (`LOCAL_FS.write_file`, no sandbox, under `CODEX_HOME`) | app server | `features.image_generation=false` (default true, `features/src/lib.rs:1791-1793`); from source `ext/image-generation/src/tool.rs:356-385` (review). Decision D7. |
| Hooks | app server's children (`hooks/src/engine/command_runner.rs:406-425` (review)) | `child_hooks` false required; `hooks/list` empty; `plugin_hooks` off |
| Apps, browser use, computer use, tool suggest, remote plugins | app server | `apps`, `browser_use`, `computer_use`, `tool_suggest`, `remote_plugin` false (defaults true, `features/src/lib.rs`) |
| Curated plugin sync (`git fetch https://github.com/openai/plugins.git` into `CODEX_HOME/.tmp`) | app server's child | Seen in W7, where it outlived a SIGKILL of the app server (verified; I stopped it). Whether `--disable plugins` stops it is unverified (§7.2). |
| User shell commands (`thread/shellCommand`), `command/exec`, `fs/*` | app server, in `local` (`thread_processor.rs`, `command_exec_processor.rs`, `fs_processor.rs` use `try_local_environment`) | refused by Codex without `local` ("local environment is not configured", verified on 0.164.0); relay never calls them on stage-2 sessions either, and a test asserts it |
| Network proxy, `request_permissions` tool | app server | `features.network_proxy=false`, `request_permissions_tool=false` |
| Git info for the thread (`git-utils/src/info.rs`) | app server | Stays. Runs relay-protected `.git` only, as today. Stated residual. |
| Model traffic, hosted `web_search` | app server / OpenAI | Stays, as today. |

Tool allowlist. relay cannot see the tool list the app server sends to the model. So:
- per turn, the feature and config readback above;
- per Codex release, an exact tool-name allowlist qualified with the fake model (§7.2). On 0.164 with these settings it should be at most `exec_command`, `write_stdin`, `apply_patch`, `view_image`, `web_search`, `request_user_input`, the MCP resource tools, `multi_agent_v1` and the goal tools. That is assumption until qualified; B1 showed the default list. No MCP tool is allowed, relay's own included (a stage-2 turn runs no MCP server).
- A release whose list adds a tool fails the watcher's check and waits for the maintainer.
- Qualified on 0.164.0 (WP-F item 10): code-mode models are also offered ext/web-search's `web__run` (namespace `web`) whenever the provider is OpenAI's and web search is on. It runs in the app server, but only POSTs the search commands, open_page URLs included, to the provider's search endpoint; the provider fetches the pages. It is allowed: same trust as model traffic and hosted `web_search`, with the X6 prompt-injection residual.

Implemented and probed (WP-D, 2026-10-28; `src/backends/codex-stage2.ts`; probe a research note (not published) with `s2-flags.mjs`, model-free, scratch `CODEX_HOME`, Codex 0.164.0):
- **Per turn, what relay can read.** `environment/status` for `local`: `unknown` (since r_0c11d860). `config/read`: approval policy `on-request`, no MCP server on (relay's own entry is off since r_0c11d860; before, relay's was the one allowed), every feature of `STAGE2_FEATURES_OFF` false. `experimentalFeature/list` (it lists all 182 features): each of those listed and off, and **no feature on outside `STAGE2_FEATURES_ALLOWED_ON`**, the 52 reported on with relay's stage-2 flags. `hooks/list` empty. `mcpServerStatus/list` (Codex's effective MCP catalog, plugin and app servers included, which `config/read` does not show): only servers `config/read` shows `enabled: false` (before r_0c11d860, relay's own server too); an error listing them refuses (review R7). Seen model-free on 0.164.0 with relay's flags: the person's switched-off server is listed, with `runtimeStatus` null and not started; relay's stand-in is listed and is started once by the call itself, to read its tools (`codex-mcp` `collect_mcp_server_status_snapshot_with_detail`, an eager threadless connection set), then stopped. So it runs last, only when everything before it has read back. Since r_0c11d860 it starts none: relay's entry is off, a stage-2 job has no extension servers (`NO_NETWORK_WITH_SERVERS`), and without `local` an enabled stdio server is listed with "MCP startup failed: local stdio MCP server … requires a local environment" and not started (seen on 0.164.0). The thread: `on-request`, `:danger-full-access`, roots and environments exactly relay's. Verified live: all pass with relay's flags; with a pin dropped or overridden (`plugins`, `hooks`, `image_generation`, `approval_policy="never"`) the readback refuses; turning on an unqualified feature (`multi_env_copy_file`) is refused and was seen to add a tool. With relay's flags, a working decoy MCP server never started, no hook was listed, and the curated plugin sync (`git ls-remote https://github.com/openai/plugins.git`) did not run; with plugins on it did.
- **The tool list itself relay cannot check per turn**: it goes from the app server to OpenAI over TLS. The per-turn guard is the feature and config readback above; the guard for the list is the per-release qualification (§7.2 item 10) against `STAGE2_TOOLS`, which the advertised set must be a **subset** of (`stage2ToolsProblem`), since it varies by model.
- **What 0.164 offers** (§9.3, derived by logging the fake model's request): every gpt-6.x and gpt-5.6 catalog entry is `tool_mode: "code_mode_only"`, which overrides `features.code_mode`. The tools arrive in an `additional_tools` input item, not `body.tools`: namespace `functions` (`exec`, `wait`, `request_user_input`, and on 6.x `request_user_input_async`), on 6.x `clock` (`sleep`) and `collaboration` (`spawn_agent`, `wait_agent`, `send_message`, `followup_task`, `interrupt_agent`, `list_agents`); nested in `exec`: `apply_patch`, `exec_command`, `write_stdin`, `view_image`, `create_goal`, `get_goal`, `update_goal`, the three MCP resource tools and on 6.x `clock__curr_time`. Image generation is absent. A direct-mode model (gpt-5.5, WP-F) gets the classic list and `tool_search`. Hosted `web_search` was not seen with the mock provider.
- **Code-mode host.** `exec` runs model-written JavaScript in a V8 isolate in `codex-code-mode-host`, an unsandboxed child of the app server (`core/src/code_mode_host.rs` `HostConnection::spawn`; its path comes from the install, not config). No Node, file system or network bindings; nested tools go through Codex's router to the thread's environment, relay's executor. The same host runs for every Codex turn under 1.0.5, so stage 2 does not widen it. Accepted as an app-server-side surface (relay-lead, 2026-10-28). Residual in §8.
- `request_user_input` is refused by Codex itself in default collaboration mode ("unavailable in Default mode", probe); were it asked, relay answers `item/tool/requestUserInput` with an error (`codex-app.ts`), so it fails closed.

## 3. What Codex needs inside

### 3.1 Under B (the executor only)

| Need | Result |
|---|---|
| Its binary and the shell | Allowed by `EXEC_SYSTEM` for a Homebrew Codex. Verified. |
| Its websocket | Bind and inbound on its one reserved port `E` (§5.1). Verified mechanism (C3 probe). |
| `CODEX_HOME` | Not needed; a temp-dir one gives a PATH-alias warning only. Verified (W2-W7). |
| `auth.json`, sessions, sqlite, models cache, logs | Not needed: the app server keeps them, outside. |
| Model traffic, hosted search | Not needed. |
| Keychain, certificate trust | Not needed. The job's `curl`, `git` over HTTPS and Node `fetch` worked with neither (verified). Go and Swift tools need `trustd`; keep `TRUST` off, since trustd fetches URLs past the profile. |
| PTYs (`tty:true` sessions) | Need relay's PTY rule. Without it `openpty` failed; with it the session ran (W7). Relay's real profile has the rule. |
| `nice` in zsh background jobs | Denied (`zsh: nice(5) failed`), harmless (W7). |

### 3.2 Under A, for the record

Verified with the app server under `sandbox-exec` (A1-A8): commands and `apply_patch` confined; `CODEX_HOME` must be writable and a command rewrote `config.toml`; HTTPS needed `TRUST` plus `com.apple.SecurityServer`. Harmless denials: FSEvents and DiskArbitration lookups, `vfs.disk-space`, `net.link.addr`. Token refresh writes `auth.json` in place (from source `login/src/auth/storage.rs:227-244`), so relay's token-file rule would fit, but commands could read it. Not probed: a real refresh.

## 4. relay's MCP server

- **Not on stage-2 turns** (review r_0c11d860 C1+X2). MCP servers default to environment "local" (from source `config/src/mcp_types.rs:25, 314`), and a stdio server needs it ("local stdio MCP server … requires a local environment", `codex-mcp/src/runtime.rs:992`). The stage-2 app server has no `local` (§2.2), so relay injects no server for a stage-2 turn (`codexFlags`: its entry switched off, as for a child that may not delegate) and the readback requires none (§2.5). A stage-2 job has no relay tools: no nested `delegate`, `ask`, `status` or `merge`. Its turn note, the first turn's preamble and the `raw_network` grant description say so.
- Revision 2 kept relay's server in `local` (verified with a stand-in, W2), and with it `local` for every command a turn did not bind; the gap that left (self-started turns, steered into by relay's binding) is why it went.
- **Follow-up, not built:** broker relay's server over an authenticated, non-stdio transport outside the job's reach: for example a streamable-HTTP endpoint on a loopback port in relay's reserved range, which every stage-2 profile denies, with a per-turn bearer token the app server holds in memory (as the executor token). Codex's local streamable-HTTP servers need no `local` environment (`runtime.rs:992`). It must keep relay's per-turn identity and approval behaviour (`default_tools_approval_mode="approve"`), and be read back like everything else in §2.5.
- Broker and bridge for option A are unchanged from revision 1 (`openBroker`, `broker.bridgeCommand` as the `mcp_servers.relay` entry, `policy.bridgeSocket`, `bindHarness` on the sandboxed app server).

## 5. Network policy

### 5.1 Rules

Replaces relay's `NETWORK_ON` for stage-2 turns. Every port is a `-D` parameter, so the probe can run the same rule text with decoy values (§7.1).

```
; outbound: IP anywhere, then the local denies; every IP rule names its family (review R1, §5.2)
(allow network-outbound (remote ip4 "*:*") (remote ip6 "*:*"))
(deny network-outbound (remote ip4 (string-append "localhost:" (param "DENY_PORT_i")))) ; one per denied port, §5.3: this Mac's IPv4 addresses
(deny network-outbound (remote ip6 (string-append "*:" (param "DENY_PORT_i"))))         ; and IPv6 to it at every host
(deny network-bind (local ip4 (string-append "*:" (param "DENY_PORT_i"))) (local ip6 (string-append "*:" (param "DENY_PORT_i"))))  ; never bound, TCP or UDP
(deny network-outbound (remote ip4 (string-append "localhost:" (param "RELAY_PORT_j")))) ; every port of relay's reserved range but this turn's job block,
(deny network-outbound (remote ip6 (string-append "*:" (param "RELAY_PORT_j"))))         ; the same two ways
(deny network-outbound (remote udp (string-append "*:" (param "UDP_DENY_k"))))           ; 1900 (SSDP/UPnP), 5351 (NAT-PMP/PCP), any host
; DNS, as today
(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.mDNSResponder")
  (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.networkd") (global-name "com.apple.nehelper"))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
; listening: TCP only on the executor's port and the job's block; UDP sockets may bind (clients need it)
(allow network-bind (local tcp (string-append "localhost:" (param "EXEC_PORT"))))
(allow network-inbound (local tcp (string-append "localhost:" (param "EXEC_PORT"))))
(allow network-bind (local tcp (string-append "localhost:" (param "BIND_PORT_m"))))      ; one per port of the job's block
(allow network-inbound (local tcp (string-append "localhost:" (param "BIND_PORT_m"))))
(allow network-bind (local udp "localhost:*"))
(allow network-inbound (local udp "localhost:*"))                                      ; UDP replies (WP-A, measured)
; Unix sockets: TMPDIR always; the worktree only on write turns in a relay-made worktree
(allow network-bind (local unix-socket (subpath (param "TMPDIR"))))
(allow network-outbound (remote unix-socket (subpath (param "TMPDIR"))))
; write turns in a pinned relay worktree only:
(allow network-bind (local unix-socket (subpath (param "WORKTREE"))))
(allow network-outbound (remote unix-socket (subpath (param "WORKTREE"))))
```

Verified mechanisms:
- Parameterised ports with `string-append` work for outbound denies (param.sb) and for bind allows (C3 probe).
- With TCP bind limited to a block: a block port bound (on 127.0.0.1 and on 0.0.0.0); any other port and the ephemeral port 0 were refused (EPERM). `(local ip "localhost:0")` is rejected outright: "invalid port in network address". So "ephemeral only" cannot be expressed.
- UDP clients need an implicit bind: without a UDP bind allow, a UDP send failed with EPERM; with `(local udp "localhost:*")` it worked while TCP binds stayed limited.
- `(remote udp "*:P")` denied UDP to P on 127.0.0.1 and on the LAN address; other ports were sent.
- Seatbelt cannot express address ranges: `(remote ip "192.168.0.0/16:*")` is rejected ("host must be * or localhost").

As implemented (WP-A, `src/confine/seatbelt-stage2.ts`): every allow comes first and every deny after it; the TMPDIR socket rules are the ones `seatbeltProfile` writes for every mode; bind and inbound share one rule per port. Verified with relay's own generator, model-free, on the maintainer's Mac (2026-10-28, wpa-netprobe.txt (not published), `test/stage2-profile.test.ts`): the §5.2 table again for the denied and the relay-range decoys at every address `os.networkInterfaces()` reports; block ports bind on 127.0.0.1, ::1, 0.0.0.0 and ::, the executor's port binds, any other port and port 0 are EPERM; outside clients reach both listeners; the job's own connect to its executor's port is EPERM; UDP deny EPERM on loopback and LAN. One correction: **UDP replies need an inbound allow.** Without it the datagram left (the decoy logged it) but the reply failed with EPERM, a direct DNS query to 1.1.1.1 included; with `(allow network-inbound (local udp "localhost:*"))` both worked. Consequence: a job can receive UDP on any port it binds (it could already bind any UDP port), a stated residual for §13.4's "UDP on a service port".

The executor's port `E` is not in the job's outbound allow. It falls under the relay-range deny, so the job cannot open a second session on its own executor.

### 5.2 What the local deny covers

Probe: my own dual-stack listeners on random high ports, one passed as a denied port; a confined Node script connecting to every address of this Mac (netprobe-final.txt; baseline without the profile connected everywhere).

**Correction (review R1, 2026-10-28).** The first table below was right for the spellings it tried, but `(remote ip "localhost:P")` does not match the IPv4-mapped IPv6 spellings of this Mac's addresses other than loopback's: `::ffff:0.0.0.0` (also written `0:0:0:0:0:ffff:0:0`) reached loopback, and `::ffff:192.0.2.10` and `::ffff:100.64.0.1` reached services listening on those addresses or the wildcard, on denied and range ports alike. Re-measured on relay's generated profiles (write and read turns; WP-A's live test and the per-turn probe now try every spelling below), macOS 27.0.1, 2026-10-28:

| Destination (denied port) | `ip "localhost:P"` (before) | `ip4 "localhost:P"` + `ip6 "*:P"` (now) | Not sandboxed |
|---|---|---|---|
| 127.0.0.1, ::1, `localhost`, 0.0.0.0, :: | EPERM | EPERM | connected |
| ::ffff:127.0.0.1, ::ffff:7f00:1 | EPERM | EPERM | connected |
| **::ffff:0.0.0.0, 0:0:0:0:0:ffff:0:0** | **connected** | EPERM | connected |
| **::ffff:192.0.2.10 (and ::ffff:c000:20a), ::ffff:100.64.0.1** | **connected** | EPERM | connected |
| LAN 192.0.2.10, tailnet 100.64.0.1, ULA fd00:db8:…, fd7a:…, every fe80::…%if | EPERM | EPERM | connected (utun/awdl link-local: timeout) |
| IPv4-compatible ::127.0.0.1 | EPERM | EPERM | EHOSTUNREACH |
| IPv4-compatible ::192.0.2.10, ::100.64.0.1; SIIT ::ffff:0:127.0.0.1 | EHOSTUNREACH (no route; not refused) | EPERM | EHOSTUNREACH |
| Non-denied port at any of these | as not sandboxed | as not sandboxed | connected, or EHOSTUNREACH/timeout as above |
| Public IPv4 1.1.1.1:443 / IPv4-mapped ::ffff:1.1.1.1:443 / IPv6 2606:4700:4700::1111:443 | connected / connected / EHOSTUNREACH | connected / connected / EHOSTUNREACH | the same (no IPv6 route here) |
| The same with 443 a denied port | not measured | connected / **EPERM** / **EPERM** | as above |

Other forms measured on the same profile: `ip4 "localhost:P"` + `ip6 "localhost:P"`, and `tcp "localhost:P"`, leave the same holes. `(remote ip "localhost:P")` beside any `ip6` rule stopped matching IPv4 (127.0.0.1, 0.0.0.0 and the LAN address connected), and with the network on, an `ip6 "*:*"` deny beside `(remote ip "*:*")` refused public IPv4 too; so no stage-2 rule says `ip`. Seatbelt names no host but `*` and `localhost`, so IPv6 to a denied port is refused at every host: **the cost is IPv6, and IPv4 sent through an IPv6 socket (IPv4-mapped, as Java does by default), to the denied and range port numbers on every host.** IPv4 to them elsewhere is unaffected. The job's block and the executor's port bind on 127.0.0.1, ::1, 0.0.0.0 and :: as before, and the job reaches its own block over 127.0.0.1, ::1 and ::ffff:127.0.0.1; UDP denies and replies are unchanged. (relay's NETWORK_ON, used by Copilot, Gemini and Grok, had the same hole with `localhost:*`; it is IPv4-only now, its own fix, cherry-picked to 1.0.5.)

The table as first measured (revision 2), with `(remote ip "localhost:P")`:

| Destination | Denied port | Other port |
|---|---|---|
| 127.0.0.1, ::1, `localhost` (name) | EPERM | connected |
| 0.0.0.0, :: | EPERM | connected |
| ::ffff:127.0.0.1 | EPERM | connected |
| LAN 192.0.2.10, ULA fd00:db8:… | EPERM | connected |
| Tailscale 100.64.0.1 | EPERM | connected |
| Tailscale fd7a:115c:… | EPERM | timeout (also outside the sandbox) |
| fe80::1%lo0, fe80::…%en1 | EPERM | connected |
| UDP to 127.0.0.1, ::1, LAN on the denied port | EPERM | sent |
| Unix socket outside the turn's dirs | EPERM | own TMPDIR socket connected |

The deny matches **this Mac's own addresses as destinations** over IPv4, and the denied port at every host over IPv6 (above), nothing else (C7). It does not cover:
- **Forwarding topology.** A router port forward reached through NAT hairpin, a tailnet subnet router, or a VM bridge can lead back to a protected service through a non-local destination address. Disclosed in the grant text. I do not claim such paths exist here; they depend on configuration.
- **Mappings a job could create.** UPnP-IGD and NAT-PMP/PCP could expose the Mac's sshd or screen sharing to the internet; UDP 1900 and 5351 are denied to any host for that reason. Other mapping protocols are a stated residual.
- **A global IPv6 address of the Mac.** Covered by construction since the R1 correction: IPv6 to a denied or range port is refused at every host, this Mac's addresses included. Before it: none on the maintainer's Mac (2026-10-28: only ULA fd00:db8:… and Tailscale fd7a:…), so not measured; residual §9.4. Inference that it is covered: the deny matched LAN, Tailscale and ULA addresses, none of which is in a special prefix, so Seatbelt's `localhost` means "an address of this Mac's own", not a prefix list; and a ULA already has global scope in the kernel's IPv6 scope logic (only fe80::/10, fec0::/10, multicast and loopback do not), so a 2000::/3 address takes the same path. Runtime guard: WP-B's per-turn probe denies the decoy at every address `interfaceAddresses()` reports, so on a Mac with a global address that is not covered the probe fails and the turn is refused.
- **Addresses that appear mid-turn** (VPN, Tailscale reconnect, `bridge100`, new IPv6 temporaries). The turn fails on change (§2.2 step 13).
- **lo0 aliases.** Not covered by Seatbelt's `localhost` (`src/confine/probe.ts:84-88`); the turn is refused (§2.2 step 5).

### 5.3 The denied ports

Static (decision D5): macOS's own services, TCP 22 (ssh), 5900 (screen sharing), 3283 (Remote Management), 445 and 548 (SMB and AFP file sharing), 631 (printing) and 3031 (Remote Apple Events, review R8). Nothing particular to one person's Mac is in the static list: the person's own services are caught by the snapshot when listening, and `never.ports` entries of theirs are denied as well (relay 1.2.0 dropped a mail bridge's and an MCP gateway's ports from the static list and the built-in never floor). Snapshot (decision D4): at the turn's start, every TCP port anything on this Mac listens on: the person's own processes from `lsof -nP -iTCP -sTCP:LISTEN -a -u $UID` (with their command lines), and every user's from `nettop -L 1 -m tcp -n -J state` (review R8). Root-owned listeners do not appear in a user `lsof`, and an unprivileged `netstat -anv -p tcp` lists no TCP socket at all on macOS 27.0.1; nettop, which reads the kernel's network statistics, lists them all unprivileged (measured 2026-10-28 on a maintainer's Mac: it added root-owned system listeners (sshd and screen sharing under launchd, Kerberos, SMB, a VPN client) to lsof's set, and lsof had none it lacked). Either tool failing refuses the turn. Agent control planes come first in the snapshot and are never dropped if the list is capped: Codex app-server and exec-server websockets, Codex network proxies, Jupyter, Chrome remote debugging, remote-control hosts. A listener on the turn's own block or executor port refuses the turn (review R6). Because each denied port is also refused over IPv6 at every host (§5.2), a local listener on a common port (a VPN client's 443, say) costs the job IPv6 to that port everywhere.

### 5.4 Ways around the denylist (C2)

- **Unauthenticated control planes on loopback.** Codex's network proxy has no proxy authentication (review C2, from source `network-proxy/src`). A concurrent 1.0.5 local-mode job's proxy reaches loopback and the LAN, so a stage-2 job could CONNECT through it to every denied port. Codex also accepts unauthenticated websocket listeners on loopback (`websocket-auth/src/lib.rs:279` (review) flags only non-loopback ones). Fixes:
  - relay launches no local-mode proxy while any stage-2 turn runs, and no stage-2 turn while one runs (interlock), or retires local mode (decision D2). As built (review R3, the maintainer 2026-10-28): while stage 2 is switched on, local mode is refused outright (`localModeRetired`, `src/core/raw-network.ts`: at admission, before the turn of a job that still holds it, and at the launch), as a step towards retiring it. The interlock remains for the cases the switch cannot see: a raw-network turn is refused while a local-mode turn that started before the switch still runs, and a run with stage 2 off gets no local-mode proxy while another run's raw-network turn runs. A hook in `localModeRetired` is reserved for a second condition, any stage-2 executor record still live (from the teardown package);
  - relay-launched proxies and executors bind only in the reserved range (§5.5), which every stage-2 profile denies;
  - the snapshot denylist puts agent control planes first.
- **Other forwarders** started by the person (an SSH `-D` SOCKS proxy, `socat`, Docker forwards, a person's Claude Code sandbox proxy that admits loopback): covered by the snapshot if listening at turn start; otherwise a stated residual.
- **Services acting for the sandbox**: `trustd`/`ocspd` fetch URLs from certificates. `TRUST` stays off.
- **The app server**: gated by §2.5.
- **Credentials readable from the home.** Reads are broad. A local service that authenticates with a token in a file (a mail bridge's gRPC config, a media server, a download manager, Tailscale's local API) is open to a job that can reach its port. Assumption on the specific files; I did not open them. The snapshot denylist closes the ports in use at turn start.

### 5.5 Reserved range

relay reserves a contiguous range (for example 47200-47263, configurable, checked free at install). It holds:
- each stage-2 turn's executor port `E`;
- each stage-2 turn's job block `B` (for example 4 ports);
- relay's own proxies (relay-enforced targets, the 1.0.5 Claude public-only proxy), when they move to it.

Every stage-2 profile denies outbound to the whole range except its own block `B` when that block is opened. A port relay wants that is busy is skipped. Only a raw-network turn or an explicit listen/port-0 overlay learns its bindable block as `PORT` (the first) and `PORTS` (all); closed no-network and mediated turns receive neither variable. Relay's instructions tell agents with an open block to bind 127.0.0.1 on it. Codex's native proxy port in 1.0.5 cannot be placed in the range (§9.2), so the interlock carries C2 alone for local mode.

### 5.6 What stays reachable

What a user's own processes typically have listening on a Mac (`lsof -nP -iTCP -sTCP:LISTEN`, own processes only; a read-only survey of a maintainer's Mac on 2026-10-28 found one or more of each):

| Category | Typical listeners |
|---|---|
| Mail and sync | a local mail bridge's SMTP and IMAP ports and its control port; cloud-drive clients |
| Media | media servers and their helper ports; download managers; small Python or Node services |
| Desktop apps | launchers, device-vendor helpers, ControlCenter (AirPlay) *:5000, *:7000, rapportd *:49152 |
| Development | dev servers (3000, 5173, 8000, 8080), Jupyter 8888, ollama 11434, Chrome debugging 9222, Docker/OrbStack forwards, Tailscale's local API |

With the snapshot denylist all of these are denied if listening when the turn starts. Without it, only the static list and the person's `never.ports` are denied, and the rest are reachable. Services started later remain reachable either way, unless a `never.ports` entry names them. So are other ports on the LAN and tailnet.

### 5.7 Denylist or allowlist

The maintainer chose the denylist. Its case: jobs can use the person's local services and nothing breaks for tools that talk to them. Its risk: it protects what it names, and new services are open the moment they start.

The allowlist alternative: loopback only to the job's own block `B`. It is expressible (one rule per port), now that bind is limited to `B` anyway. It breaks jobs that need the person's services (a database, ollama, a dev server the maintainer runs). Recommendation: keep the maintainer's denylist with the snapshot (decision D4). Offer the allowlist as a per-grant option later if the maintainer wants a tighter stage 2.

### 5.8 The LAN

Open on every non-denied port, and Seatbelt cannot close it (§5.1). It is disclosed in the grant's consent text. A job that must not reach the LAN uses strict mode (decision D9).

### 5.9 Listening (C3)

Revision 1 allowed binding any loopback port. A job could then pose as a stopped local service that the maintainer's unconfined clients use, such as ollama, a dev server, or an HTTP MCP URL. Browsers also share localhost cookies across ports. Now:
- TCP binding only on `B` and `E` (verified mechanism). Ports outside the reserved range cannot be bound.
- Cost: listening on port 0 (ephemeral) fails, which some test runners and tools do by default. Decision D3 states the alternative.
- Binding `B` on 0.0.0.0 is still allowed (Seatbelt's `localhost` matches the wildcard, verified), so a job's server can be visible on the LAN and tailnet on those few ports. Stated residual.

**Release A correction (2026-11-01).** The block allowance above applies only to a
person-consented raw-network turn or an explicit listen/port-0 restart overlay, and
only those turns receive `PORT`/`PORTS`. In a no-network or mediated turn, `B` stays
in the final relay-range bind/inbound deny and cannot listen on loopback or a wildcard
address. The executor port `E` retains its separate allow. Exact localhost
connect overlays add no bind authority. Static denied service ports can never be
connect or listen exceptions; only a listening-snapshot deny may be overridden.

## 6. Grant contract and the 1.0.5 modes (X5, C2)

| | 1.0.5 strict | 1.0.5 local | Stage 2 |
|---|---|---|---|
| External egress | HTTP(S)/SOCKS through Codex's proxy; no raw TCP, ssh, direct DNS | same | **all IP: raw TCP, ssh, DNS** |
| Loopback | none | all | all but the denied ports and relay's range |
| LAN, tailnet | none | open through the proxy | open, directly |
| Listening | none | through `allow_local_binding` | TCP only on the job's block |
| AF_UNIX | TMPDIR and worktree | same | TMPDIR; worktree on write turns in relay worktrees |
| Exec-policy allow rules | need the 1.0.5 deny entry | same | closed by construction (W3) |
| Codex API dependence | experimental `network_proxy` | same | experimental environments |

Stage 2 is broader than local mode for external egress and narrower for local reach. It is not "stricter on every axis", as revision 1 claimed.

Contract:
- A new, separately named grant, `grant.raw_network` (name open), person-only. Its consent text names raw network (TCP, UDP, ssh, DNS), the LAN and tailnet, listening on the job's port block, and the forwarding residual of §5.2. Consent is bound to the grant and asked again when the grant changes, like 1.0.5 local mode.
- `grant.network` keeps meaning 1.0.5 strict mode. Hosted search is unchanged in every mode.
- Local mode is refused outright while stage 2 is switched on (review R3, approved by the maintainer 2026-10-28), and stays as in 1.0.5 while it is off. It is not migrated silently: a job holding `local_network` is refused at its next turn with the reason, and its caller chooses `raw_network` or `network`. A local-mode consent never counts as stage-2 consent.
- The interlock of §5.4 holds for what the switch cannot see (a local-mode turn started before the switch; runs whose configs differ).
- Fallback: a Codex below 0.164, or any failed admission check or readback, refuses the stage-2 turn and says which mode can run instead. Verified that 0.163.0 rejects relay's `environment/add` and then `thread/start` (W163).
- X1 does not arise: at `:danger-full-access` Codex asks no sandbox additions. Fact (b) is closed for commands (W3); the 1.0.5 deny-entry fix stays for jobs on Codex's own sandbox.

## 7. Probes, qualification and release watch

### 7.1 Stage-2 probe mode (X4)

The current battery cannot run unchanged: it requires loopback TCP to be refused, a Unix listener in a writable worktree to be refused, and loopback and any-address listening to be refused (`src/confine/probe.ts:453-505` (review)). Stage 2 permits each of these in part. So `probeBoundary` gets an explicit `network.mode: "stage2"` branch:

Kept unchanged: every filesystem, process, Mach, sysctl, IOKit, semaphore, fcntl, exec-list, signal, LaunchServices and Apple-events check; the bridge checks where they apply.

Replaced:
| Today | Stage 2 |
|---|---|
| deny `tcp-loopback`, `tcp-loopback-v6` | deny TCP to a denied **decoy** port at 127.0.0.1, ::1, 0.0.0.0, ::, ::ffff:127.0.0.1, fe80::1%lo0, every address `os.networkInterfaces()` reports, and the IPv4-mapped and -compatible spellings of each IPv4 one (::ffff:0.0.0.0, 0:0:0:0:0:ffff:0:0, ::ffff:a.b.c.d, ::a.b.c.d; review R1); allow TCP to a non-denied decoy at 127.0.0.1, ::1 and ::ffff:127.0.0.1 (positive controls); the decoy listener must log no accept on the denied port |
| (none) | deny TCP to a decoy port placed in the relay-range parameters, at every one of those addresses |
| (none) | deny UDP to a decoy given as `UDP_DENY` (same rule text as 1900/5351) at 127.0.0.1 and ::1; allow UDP to another port |
| deny loopback and any-address listening | allow TCP bind on a block port; deny TCP bind on a port outside the block and on port 0; allow a UDP bind |
| deny `unix-listen-worktree` (write turns) | write turns in relay's pinned worktree: allow (`stage2-unix-worktree`, listen and connect); other write turns: deny listening there; read turns: a socket of relay's own listening in a **decoy cwd** must be unreachable (`stage2-unix-cwd-decoy`, C4). relay creates nothing in a read turn's real cwd, which may be the person's checkout; TMPDIR allow kept |
| skip DNS denies when network is on | unchanged |

The decoy variants use the same profile text with different `-D` values, so the `rules` hash matches the real turn's and the fingerprint differs, as for relay's login-store decoy. The real denied ports are never touched; a generator test checks that the real profile carries them as parameters. Verified: the parameter mechanism (param.sb, C3 and C7 probes).

As built (WP-B, `src/confine/probe-stage2.ts`): every TCP and UDP check, and a read turn's socket check, run in one second canary under a decoy policy: the turn's, with decoy ports (relay's own loopback listeners on free high ports, plus filler values so each list keeps its length) and, on a read turn, a decoy cwd. The decoy cwd is a scratch directory of relay's own laid out like the real cwd as far as the profile can tell (no repository, a `.git` directory, or a `.git` file to a git directory with or without a shared one; at the repository's top or below it; the same pin and git environment). A read turn's cwd reaches the profile only through `-D` values, never the rules text, so the decoy has the same rules; `probeBoundary` checks the hash and refuses the launch for a layout the decoy does not reproduce. Denied-port checks also require that the decoy logged no accepted connection. Measured on this Mac (macOS 27): `network-bind` is a sub-operation of `network-inbound`, so an inbound allow on a port also lets it be bound and listened on, and a bind allow alone does not let it listen; the bind-block probes (another port, port 0) catch an inbound allow broader than the block. Each stage-2 check has a negative control in `test/stage2-probe.test.ts`: the rule removed or widened, the named probe fails and the launch is refused.

### 7.2 Qualification (per Codex release, model-free, scratch homes)

`scripts/codex-qualify/codex-stage2.mjs`, from the B/W probes:
1. Commands and `apply_patch` inside and outside the roots (W1, W5); control without the environment (B0).
2. Restricted Codex profile in the environment exits 71 (B3).
3. A local stdio MCP server still starts outside (W2); under relay's settings, with no `local` environment, none runs, relay's own included, and `local` reads back as `unknown`.
4. Exec-policy `allow` rule and approved `require_escalated` stay confined (W3).
5. Unreachable executor: no local fallback (W4).
6. **Token (X7)**: production-shaped. The token is made in memory and never written. The executor gets its hash and the app server gets it over stdin. After the turn, relay checks that the token is absent from the executor's argv and environment (`ps eww`) and from every file under the turn's temp dir, the executor's `CODEX_HOME`, the worktree and the app server's `CODEX_HOME` (sessions, sqlite, logs). Verified (W7: absent everywhere; hash present in argv only).
7. **Cross-turn authentication (X7)**: a confined process under another turn's profile tries the executor with no token, a wrong token and a guessed token; all refused. Verified (W7).
8. **Survivors (C5, X3)**: background, `nohup`, `setsid`, retained terminal, and an active listener on the job's block. After teardown, each must be gone and no further write or connection may occur. W7 covered `nohup`, `setsid` (survived a group kill, so the descendant sweep is required) and a PTY session; the listener case is to do.
9. **Executor death mid-turn**: kill the executor; the app server must be killed first and the turn failed; a fresh listener on `E` must see no connection.
10. **Tool list and effort** with the version-specific §2.5 settings (fake model logs the tool names), checked against the allowlist after feature readback. Also check isolate bindings, and explicit effort on a fresh turn and a changed-effort resume, including `configuration_update` encoding.
11. Subagent spawn runs its command in the relay environment; under relay's settings a resumed thread has no environment until `turn/start.environments` binds it, and unbound runs nothing (control: with `local`, it runs there); turns Codex starts by itself (a goal with goals on, a queued message) run nothing without `local`, even when a bound `turn/start` steers into them (control: with `local`, the goal's runs there).
12. Relay's plugin pins stop curated sync and host-side discovery traffic; require `plugin_discovery_prefetch=false` where supported, with feature readback and the existing plugins-on sync control. A fake API key does not cover account-dependent discovery branches; the source watch covers their startup/manager paths.

The integrated driver has items **1–33** (33, the keychain under the never floor from native Codex turns, from the release after 1.1.3: a floored decoy item refused on every turn, and its control without the file deny matching doctor's keychain IPC; Claude's side is release check `claude-floor`, outside the pin), including the HTTP broker, escalation, standing-network
and IPv4 localhost checks. The [qualification template](qualification/codex-stage2-template.md)
and `codex-pin-store.mjs` define the required parts. Partial runs cannot qualify a release.

### 7.3 Release-watch hooks

Add to the Codex static comparison (the release watcher's notes (not published)), so any change leaves the PR for the maintainer:
- environments: `app-server-protocol/src/protocol/v2/environment.rs`, `common.rs` (`environment/add`), `v2/thread.rs` and `v2/turn.rs` (`environments`), `exec-server/src/environment.rs`, `environment_toml.rs`, `environment_provider.rs`;
- executor: `exec-server/src/server/transport.rs`, `exec-server-cli/src/command.rs` (lifetime flags; `cli/src/exec_server_command.rs` before 0.166.0) and `exec-server-cli/src/config.rs`, `exec-server/src/remote.rs` (reconnect), `exec-server/src/local_process.rs` (child environment), `websocket-auth/src/lib.rs`;
- routing: `core/src/tools/spec_plan.rs`, `core/src/tools/sandboxing.rs`, `multi_agents/spawn.rs`;
- app-server-side actions (C1, C6): `codex-mcp/src/mcp/mod.rs`, `codex-mcp/src/runtime.rs`, `config/src/mcp_types.rs`, `core/src/session/mcp.rs`, `core/src/mcp_skill_dependencies.rs`, `core/src/mcp_tool_call.rs`, `ext/*` (image generation and every extension tool), `hooks/src/**`, `core/src/tasks/user_shell.rs`, `features/src/lib.rs` (keys and defaults);
- plugin startup/discovery: `app-server/src/message_processor.rs`, `core-plugins/src/manager.rs`, `core-plugins/src/startup_sync.rs`;
- prediction/sample and tool world-state: `app-server/src/thread_sample.rs`, `app-server/src/request_processors/thread_processor.rs`, `core/src/session/mod.rs`, `core/src/context/world_state/tools.rs`, `core/src/session/world_state.rs` (`deferred_tool_world_state`);
- effort encoding: `core/src/session/reasoning_effort.rs`, `core/src/client.rs`;
- `network-proxy/src` (authentication), `sandboxing/src/seatbelt.rs` (nested failure).

## 8. Risks

1. **Experimental Codex API**, already changed between 0.163 and 0.164 (W163). Floor 0.164, readback, release watch. Failure mode is refusal (W4).
2. **App-server-side actions.** Gated and read back (§2.5), but the gate is configuration on Codex's side. A new Codex tool or extension that writes or spawns locally is outside relay's profile until the release watch flags it.
3. **Open loopback and LAN.** §5.2-5.8. Reduced by the snapshot denylist, the bind block and the interlock; not closed.
4. **Survivors.** relay's descendant tracking is best effort, so teardown also runs the per-path `sandbox_check` sweep (§2.2 step 15), which finds this turn's processes wherever they detached to (live tests: `nohup`, `setsid` writers and a block-port listener, a kept terminal; a worker killed mid-turn, then reap or cancel). Its limits, which taint the record rather than pass silently:
   - It identifies the turn's processes by their profile's write rule on the turn's temp dir. A sandbox cannot be left, and a sandboxed process cannot apply another, narrower one that would hide it: measured on macOS 27 (2026-10-28), `sandbox-exec` inside a turn-shaped allow-default profile fails with `sandbox_apply: Operation not permitted`. So this is complete for processes of this user while the kernel answers.
   - A process started between the last look and the kill would be missed if it forked from a process not yet frozen; the freeze-then-kill order and the last look after the kill make that a failure the sweep sees (a non-empty last look), not a silent gap.
   - The helper is relay's own binary, run outside any sandbox (§9.1); a swap between its check and its exec by a writer outside every sandbox remains.
   - Processes of another user are out of reach; a confined turn cannot become another user.
5. **Executor integrity.** A squatter on `E` after the executor dies could receive the token and the job's calls, but it runs in its own sandbox (C5, narrowed). Fail-on-exit and the reserved, denied port address it.
6. **Turn temp dirs are readable by other confined turns** (`~/.relay-t`, broad reads). Pre-existing. Nothing secret is placed there (W7).
7. **Reads stay broad**, as today for Codex.
8. **Code-mode isolate.** The model's JavaScript runs in a V8 isolate in an unconfined child of the app server (§2.5). An escape from the isolate would run as the app server, outside relay's profile, with the person's authority. Pre-existing: every Codex turn has it today.
9. **Behaviour changes for stage-2 jobs**: no native git commits, no AF_UNIX outside TMPDIR and relay worktrees, no ephemeral-port listening, no image generation, no goals, no per-command approvals, executables only from listed places; a session with a message queued in Codex is not resumed; **no relay tools** (no nested `delegate` or `ask`, §4).
10. **`local` is removed from the app server (review r_0c11d860 C1+X2, taken).** relay starts it with `CODEX_EXEC_SERVER_URL=none`, reads back `environment/status local` as `unknown` before the prompt, and accepts no `local` in any thread reply. A turn Codex starts by itself, and one relay's binding steers into, has no environment and cannot run a command (§2.2, verified live). Kept as defence in depth: the per-turn binding and its readback, goals pinned off, the queue checked before resume, and the turn guard. What remains:
    - A future Codex that registers `local` some other way (a new variable or file, `none` changing meaning) is caught by the readback before the prompt, and per release by F items 3 and 11.
    - The cost: no MCP server on stage-2 turns, so no relay tools. The follow-up is brokering relay's server over an authenticated, non-stdio transport outside the job's reach (§4): designed in [codex-mcp-broker-design.md](codex-mcp-broker-design.md) (streamable HTTP from relay's worker, armed only for relay's own bound turn).
    - The skill check is blind to repository skills: `skills/list` reads them through the default environment, which no longer exists, while the turn reads them through relay's executor. relay still switches off every repository skill its own scan finds (`codexSkillFiles`), but a place that scan misses is no longer caught by `skillsProblem` before the prompt; such a skill's instructions would reach the model (its scripts still run only in relay's executor). A per-release check that `codexSkillFiles` covers Codex's repository discovery would close it.

## 9. Open questions for the next review

1. **Settled: the per-path `sandbox_check` sweep is built and adds to `watchProcess`** (§2.2 step 15, §8.4). A compiled helper (`native/sbcheck.c`, built by `npm run build` where Xcode's command line tools are installed) calls `sandbox_check` with a path filter; relay runs a known-answer self-test once per process (a sleep under a profile that allows one directory and denies another must read sandboxed, allow, deny; relay itself unsandboxed) before trusting it. Measured on macOS 27 (Darwin 27.0.0, arm64): exact for paths that exist; the kernel answers "deny" for any path that does not, so the sweep makes the turn's temp dir again when it has gone (rules name paths) and removes it afterwards. Without the helper, stage 2 is refused, not run with tracking alone.
   The helper runs outside any sandbox, during teardown, so relay must run only its own (review r_0c11d860 X1, 2026-10-28). Relay runs it only from `dist/native/relay-sbcheck` in the package it is running from, reached through real directories, and only while it is still the file relay recorded when its process started: before every run, the file's device, inode, size, mtime and ctime and the sha256 of its contents must match that record, or relay refuses to run it and `sandboxCheckUnavailable` says why (`src/confine/sbcheck.ts`): a new stage-2 turn is then refused, and a teardown under way keeps its record tainted and its ports quarantined (§2.2 step 15). That is the second layer: no grant or file request may cover relay's package, and every profile relay writes (stage 2's included, which is the same generator) denies writing it (`src/core/caller.ts` `grantPathProblem`, `src/confine/seatbelt.ts` `installDenied`). Rebuilding the helper means restarting relay. Residual: a writer outside every sandbox could swap the file between the check and the exec.
2. Can Codex's native proxy (1.0.5) be bound in relay's reserved range, so the range alone carries C2 without the interlock? **Settled (WP-E): no.** Codex binds its managed proxy on ephemeral loopback ports whatever `proxy_url` and `socks_url` say: from source, `network-proxy/src/proxy.rs` `NetworkProxyBuilder::build` calls `reserve_loopback_ephemeral_listeners` whenever `managed_by_codex` is true (the default, and what `core/src/config/network_proxy_spec.rs` `start_proxy` uses) on every OS but Windows; the configured ports are used only by the standalone proxy binary. Verified model-free on 0.164.0: with `permissions.relay.network.proxy_url = "http://127.0.0.1:47258"` and `socks_url` `:47259`, read back by `config/read`, a `command/exec` saw the proxy on 127.0.0.1:57914-57915 (proxyport.mjs (not published), proxyport.log (not published)). So the interlock (`localModeInterlock`, both ways) carries C2 alone; WP-A's listening snapshot, which denies a proxy already listening when a stage-2 turn starts, is a second layer in that direction only.
3. Is the tool allowlist of §2.5 complete for 0.164 under those settings (qualification item 10)?
4. A global IPv6 address of the Mac: confirm on a machine that has one. WP-A (2026-10-28): the maintainer's Mac has none, so it stays a residual, covered by inference and guarded per turn (§5.2). Since the R1 correction the IPv6 deny names every host, so this is covered by the rule itself; the test below still confirms it. The test that settles it: on a Mac with a global (2000::/3) address, a probe script in relay's research notes (not published) (or `test/stage2-profile.test.ts`, which probes every interface address) must show EPERM for the denied and range decoys at that address.
5. Should stage 2 later cover Codex jobs without a network grant too?

## 10. Decisions for the maintainer

The maintainer approved D1-D10 as recommended on 2026-10-28, "at least until i realize later i approved something stupid". So each decision carries a trigger for reopening it. Rows marked **Wider than it reads** have consequences beyond the row; they are spelled out below the table.

| # | Question | Options | Recommendation | The maintainer's decision (2026-10-28) |
|---|---|---|---|---|
| D1 | How stage 2 is offered (X5) | (a) new person-only grant (`raw_network`) beside strict and local; (b) make `grant.network` mean stage 2 | (a). It is broader than strict and local for external egress, so it needs its own consent. | (a) |
| D2 | Local mode, given C2 | (a) retire local mode when stage 2 ships, after migrating its users with renewed consent; (b) keep both with the interlock | (a). Local mode's unauthenticated proxy opens all loopback and is the main C2 hazard. Until then, (b). | (a); (b) until stage 2 ships. **Wider than it reads.** Step taken (review R3, 2026-10-28): local mode is refused outright while stage 2 is switched on; the interlock stays for a local-mode turn started before the switch. |
| D3 | Listening (C3) | (a) TCP bind only on a reserved per-turn block (`PORT`/`PORTS`); ephemeral listening fails; (b) any loopback bind except a client-targeted deny set (static list, snapshot, ports of configured MCP URLs), with the impersonation residual stated | (a). It removes impersonation of absent services at a known compatibility cost. | (a). **Wider than it reads.** |
| D4 | Snapshot denylist | (a) add every port the maintainer's processes listen on at turn start, control planes first; (b) static list only | (a). It covers a mail bridge's gRPC port, a media server and future control planes without upkeep. | (a). **Wider than it reads.** |
| D5 | Static list additions | add TCP 3283 (Remote Management), 445 (SMB), 548 (AFP), 631 (CUPS); UDP 1900 and 5351 to any host | Yes. | Yes |
| D6 | `child_git: "native"` | relay commits for stage-2 jobs (as for Gemini, Copilot, Grok) | Accept. | Accept. **Wider than it reads.** |
| D7 | Image generation in stage 2 | (a) off; (b) on, with sandbox-less writes under `~/.codex/generated_images` outside relay's profile | (a). | (a) |
| D8 | `~/.codex` for the agent's commands | (a) deny reading all of it; (b) only the 1.0.5 list | (a). The executor needs none of it, and it holds other sessions' transcripts. | (a) |
| D9 | The LAN and tailnet | Seatbelt cannot close them. (a) accept, disclosed in the consent; (b) jobs that must not reach them use strict mode | (a), with (b) as the documented choice. | (a), with (b) |
| D10 | Executor transport | (a) executor's own websocket on a reserved port, token hash in argv (as designed); (b) relay-hosted bridge to the executor's stdio, no listener inside, per-command audit log, about 150 more lines | (a) first; (b) later if the maintainer wants the audit log. | (a) first |

Revisit if:
- **D1**: agents keep asking for `network` when they need ssh or raw TCP, or the maintainer finds two network grants confusing in practice.
- **D2**: a job that worked in local mode cannot run in stage 2 (it needs a loopback service the snapshot denies, or the proxied egress was the point), or the migration finds active local-mode users.
- **D3**: common dev servers or test runners in the maintainer's repos fail on the port block (anything that listens on port 0, `node --inspect` on 9229, a dev server that ignores `PORT`).
- **D4**: jobs need a service the maintainer was already running (a local database, ollama, a dev server), or the snapshot misses a control plane started mid-turn.
- **D5**: a job legitimately needs printing or file sharing on this Mac, or Apple moves a service to a new port.
- **D6**: stage-2 jobs regularly fail or waste turns on `git add`, `git commit`, `git stash` or branch switching, or relay's commit loses information the agent's own commits would have carried.
- **D7**: the maintainer wants image output from a stage-2 job, or Codex routes image saves through the environment (then it can be confined).
- **D8**: a job needs something Codex keeps in `~/.codex` (shared rules or skills it should read), or Codex moves a binary or helper there.
- **D9**: a LAN or tailnet device is misused by a job, or the maintainer adds sensitive services on the tailnet; then move such jobs to strict mode by default.
- **D10**: the maintainer wants a per-command audit log, a no-listener profile, or Codex changes its websocket authentication.

What the flagged rows imply beyond their text:
- **D3.** Besides port 0, it stops every listener outside the job's 4-port block: `node --inspect` (9229), language servers and test harnesses on fixed ports, `ssh -L` local forwards, `python -m http.server` without a port argument (8000). Tools that respect `PORT` work. Binding a block port on 0.0.0.0 is still allowed, so those few ports can be visible on the LAN and tailnet (verified, §5.9).
- **D4.** Together with D3 it turns loopback, in practice, into "only what nobody was using when the turn started". Jobs cannot use the maintainer's running database, ollama, Jupyter or dev servers. That gives up most of the case for a denylist in §5.7, which was exactly that access. What stays reachable is services started after the turn begins, other jobs' block ports (denied by the relay-range rule), and the LAN.
- **D6.** relay's profile denies writes to the worktree's git directory and the repository's common directory. So inside a stage-2 job every git command that writes there fails: `git add`, `git commit`, `git stash`, `git checkout -b`, `git rebase`, `git worktree`, index refreshes by `git status` (it carries on read-only), and tools that call git themselves (pre-commit hooks, `npm version`, changeset tools). The agent sees errors unless relay's instructions say so up front. relay commits the worktree's state at the end of the turn with its own message, so the agent's commit structure and messages are lost.
- **D2.** Retiring local mode removes a 1.0.5 feature. Jobs that needed local servers must move to stage 2, which brings raw egress, the LAN, the port block and D4's snapshot along with it. There is no mode left with proxied egress and loopback.

## 11. Review r_92b19bad disposition

| Item | Severity | Resolution | Section |
|---|---|---|---|
| C1 approval `never` + full access auto-approves app-server actions | major | `on-request` always; relay-only MCP, hooks off, plugins/apps off, `skill_mcp_dependency_install=false` required and read back; files watched | §2.2 (3, 10, 11), §2.5, §4, §7.3 |
| C2 unauthenticated loopback control planes | major | interlock with local mode or retire it (D2); reserved range denied by every stage-2 profile; control planes first in the snapshot. Codex's proxy cannot be moved into the range (§9.2, settled no), so the interlock carries it for local mode | §5.3, §5.4, §5.5, §6, §9.2, §10 |
| C3 bind impersonation | major | TCP bind only on a reserved per-turn block passed as `PORT`/`PORTS` (verified expressible); alternative stated (D3) | §5.1, §5.9, §10 |
| C4 worktree AF_UNIX on read turns | major | TMPDIR only for read turns; worktree only for write turns in relay worktrees; decoy-socket probe | §2.3, §5.1, §7.1 |
| C5 + X3 executor lifetime and teardown | major | launch leader with descendant supervision and survivor reporting; fail on executor exit, app server killed first; reserved denied port; qualification of nohup, setsid, terminal, listener (W7 partial); squatter narrowed to an integrity failure | §2.2 (9, 12, 14, 15), §7.2, §8 |
| C6 + X1 + X2 app-server-side local actions | major | admission gates with readback, image generation off, never `thread/shellCommand`/`command/exec`, exact tool allowlist per release, `ext/*` and hooks watched | §2.5, §7.2, §7.3 |
| C7 local-destination-only deny | minor | forwarding residual disclosed; UDP 1900/5351 denied (verified form); turn fails on interface change | §2.2 (13), §5.1, §5.2 |
| C8 executor env and skill package | minor | executor gets relay's scrubbed confined-child env; skill package copied to a readable per-turn asset dir; personal skills already off (revision 1's claim corrected) | §2.2 (9), §2.3 |
| C9 + X6 confined flag and token secret | nit | `confined` only on command and file-change approvals, tested per kind; token registered as a turn secret | §2.4 |
| X4 probe battery conflicts | major | stage-2 probe mode with decoys and positive controls; other checks kept | §7.1 |
| X5 stage 2 broader than local mode | major | separately named person-only grant with explicit raw-network, LAN and listening consent; no silent replacement of local mode | §6, §10 (D1, D2) |
| X7 token test not production-shaped | minor | memory-only token test and cross-turn authentication; verified in W7 | §7.2 (6, 7) |

## 12. Size and staged plan

About 2,200-2,800 lines with tests; 6-9 working days.

| Stage | Work | Size |
|---|---|---|
| S1 | Generator: stage-2 network block (parameterised denied ports, relay range, UDP denies, TCP bind block, AF_UNIX by turn kind); reserved-range allocator; lo0-alias and interface checks; generator tests | 1-1.5 days |
| S2 | Stage-2 probe mode (§7.1) with decoys and positive controls; tests | 1 day |
| S3 | `src/backends/codex-env.ts`: executor as launch leader through `prepareLaunch`, scrubbed env, token in memory and registered, `environment/add`, thread start/resume with environments, readback, fail-on-exit, interface watch, teardown with survivor sweep and report; behind a config flag, off by default | 2-2.5 days |
| S4 | §2.5 gates: admission checks, pinned features and readback, `hooks/list`, MCP status, `on-request`; skill package asset dir | 1 day |
| S5 | Accounting: `enforcement`, per-turn confinement, per-kind `confined`, hard-link path, doctor, registry field | 0.5-1 day |
| S6 | Grant contract (`raw_network`, person-only consent text), local-mode interlock, snapshot denylist and doctor inventory; docs (README, UPGRADING, `confinementSummary`) | 1 day |
| S7 | Release watch: `codex-stage2.mjs` qualification (§7.2) and static surfaces (§7.3) | 1 day |
| — | Cross-family review of the diff; red-team: reach a denied port, act through the app server, survive the turn, use another turn's executor | — |

## Appendix: probe index

All under `/tmp/rcs.ZE6N` with my own listeners on random high ports; scratch `CODEX_HOME` per case with a mock provider and `model_catalog_json` (one models-cache entry renamed `mock-model`). No login, no real model. Logs: a research note (not published).

| Id | What | Result |
|---|---|---|
| net | netprobe.mjs, udp.mjs, srv.mjs under revision 1's block | §5.2 table; bind on 0.0.0.0 allowed under `localhost:*` |
| param | `string-append` port parameter | denied port EPERM, next port connects |
| C3 | TCP bind block; `localhost:0` rule; UDP bind | block port binds (also 0.0.0.0); others and port 0 EPERM; `localhost:0` rejected; UDP clients need a UDP bind allow |
| C7 | `(remote udp "*:P")` | EPERM on loopback and LAN; other port sent |
| B0 | local environment, no relay profile | outside write and patch succeeded (control) |
| B1, B2 | `environments.toml` stdio executor in relay profile | worktree ok; outside EPERM; denied port refused; `CODEX_HOME` write EPERM; patch outside failed |
| B3 | restricted Codex profile in the environment | exit 71; patch failed |
| W1, W5 | `environment/add` over websocket (W5: hash only) | as B1 and B2 |
| W2 | plus a stdio MCP server | started outside |
| W3 | `allow` rule, approved `require_escalated` | both EPERM outside |
| W4 | executor URL to a closed port | no local fallback |
| W6 | upgrade without, wrong, right token | refused, refused, answered |
| W7 | memory-only token; cross-turn auth; survivors; PTY | token in no file, argv or env; cross-turn refused; `setsid` child survived group kill, sandboxed; PTY session needs relay's PTY rule and died with the executor; curated plugin sync outlived the app server |
| L1 | `--exit-on-stdin-close` with `--listen ws://` | refused: needs `--remote` |
| W163 | Codex 0.163.0 | `environment/add` rejected; thread start failed |
| A1-A8 | app server inside relay profile | §3.2 |
| sbcheck | per-path `sandbox_check` via JXA | returned -1 (variadic call); needs a compiled helper |

## 13. Implementation split

The maintainer wants stage 2 built in 1-2 days of wall-clock time by parallel teams (2026-10-28). The skeleton commit on a private branch (from a private branch at 7e23e72) gives every package its module, its signatures and its wiring, so that each package mostly fills in its own new files.

### 13.1 The skeleton

- **Switch.** Stage 2 runs only when relay's process has `RELAY_EXPERIMENTAL_CODEX_STAGE2=1` in its environment (`stage2Enabled`, `src/core/raw-network.ts`). It is not a config key yet: a new key changes the config schema snapshot (`test/fixtures/stable-surfaces/config.json`), and the MCP grant schema (`raw_network`) has a snapshot too. WP-E replaces the variable with `targets.codex.stage2` and adds `raw_network` to the grant schema, updating both snapshots, when stage 2 is ready. Done (WP-E): the switch is `targets.codex.stage2`, read from the run's config by `stage2Enabled(env, cfg)`; the variable stays as a test and development override.
- **Off means unchanged.** With the switch off, `stage2Wanted` is false, `rawNetworkGrantProblem` refuses `raw_network: true` (the MCP schema has the key since WP-E) and is null otherwise, `rawNetworkConsent` is null for a job that never held the grant, and `localModeRetired` is null. Every hook in existing code is `stage2 ? … : <as before>`. `test/stage2-skeleton.test.ts` checks this. Two places were found to differ and are restored or stated (review R9): `raw_network: false` is no grant at all with the switch off, as before the key existed (`checkGrant`; with it on, it counts as a grant, so a root's resume with it drops raw network rather than keeping it, and a launched agent's is refused like any grant from it); and a local-mode turn reads the registry's running Codex write turns (`localModeInterlock`, one query), whose result is null while stage 2 is off everywhere: a turn whose recorded grant cannot be read counts against local mode only where its own run has stage 2 on. Residual: a run whose config has stage 2 off but whose relay process had `RELAY_EXPERIMENTAL_CODEX_STAGE2=1` is judged by this process's environment, so such a turn with an unreadable grant would not hold local mode off (a development override plus a corrupt registry row).
- **On, before the packages land.** Every path refuses: `stage2Admission` returns a refusal, so `openStage2` throws before anything starts; the network mode `stage2` has no rules (`stage2NetworkRules` throws); the probe plan throws.
- **Enforcement record.** No registry schema change. A turn's enforcement goes into the node's `params_json`, key `codex_confinement` (`{ turn, enforcement: "codex" | "relay" }`, latest turn; `src/core/params.ts`), written by `recordEnforcement` (WP-D). Raw-network consent goes into `params_json`, key `raw_network_consent`, like 1.0.5's `local_network_consent`.

New modules (owner in brackets):

| Module | Exports |
|---|---|
| `src/confine/ports.ts` [A] | `STATIC_DENIED_TCP`, `STATIC_DENIED_UDP`, `RELAY_PORT_RANGE`, `JOB_BLOCK_SIZE`, `PortLease`, `leaseTurnPorts`, `ListeningSnapshot`, `listeningSnapshot`, `deniedTcpPorts`, `interfaceAddresses`, `InterfaceWatch`, `watchInterfaces`, `loopbackAliasProblem` |
| `src/confine/seatbelt-stage2.ts` [A] | `Stage2Network`, `stage2NetworkRules`, `checkStage2Network` |
| `src/confine/probe-stage2.ts` [B] | `ProbePlanner`, `ProbeJudge`, `planStage2Network`, `decoyNetwork` |
| `src/confine/sbcheck.ts` [C] | `SandboxAnswer`, `sandboxAllows`, `sandboxCheckUnavailable` |
| `src/backends/codex-env.ts` [C] | `STAGE2_ENVIRONMENT_ID`, `Stage2Session`, `Stage2Launch`, `openStage2`, `executorPolicy`, `executorToken`, `Executor`, `launchExecutor`, `stopExecutor`, `sweepTurnSurvivors` |
| `src/backends/codex-stage2.ts` [D] | `STAGE2_FEATURES_OFF`, `STAGE2_TOOLS`, `CONFINEMENT_PARAM`, `stage2Wanted`, `turnConfinement`, `stage2Admission`, `Stage2Plan`, `stage2Plan`, `stage2Permissions`, `RpcLike`, `stage2Readback`, `stage2ThreadProblem`, `stage2ApprovalDetail`, `recordEnforcement`, `stage2SkillAssets` |
| `src/core/raw-network.ts` [E] | `STAGE2_FLAG_ENV`, `stage2Enabled`, `RAW_NETWORK_CONSENT_TEXT`, `rawNetworkGrantProblem`, `rawNetworkKey`, `rawNetworkConsent`, `localModeInterlock` |

Wiring already in existing files (each package may adjust only the call sites it owns, §13.2):

| File | Call site | Owner |
|---|---|---|
| `src/confine/index.ts` | `NetworkPolicy` includes `Stage2Network` | A |
| `src/confine/seatbelt.ts` | `seatbeltProfile`: accepts mode `stage2`, pushes `stage2NetworkRules(…)` | A |
| `src/confine/probe.ts` | `probeBoundary`: `planStage2Network(…)`; skips `tcp-loopback*`, aliases, `unix-listen-worktree`, `listen-loopback`, `listen-any` under stage 2 | B |
| `src/backends/types.ts` | `Grant.raw_network` | E |
| `src/core/params.ts` | `raw_network_consent`, `codex_confinement` | E, D |
| `src/core/caller.ts` | `admitWork`: `rawNetworkGrantProblem` | E |
| `src/core/session.ts` | `rawNetworkConsent` after `localNetworkConsent` | E |
| `src/backends/codex.ts` | `codexBackend.start`: `openStage2`, `abort` on failure, `stage2.session` to `startCodexAppTurn`; `codexFlags(…, stage2?.plan)`; `chooseNetwork`: `localModeInterlock("local")` | C (start), D (`codexFlags`), E (`chooseNetwork`) |
| `src/backends/codex-app.ts` | `CodexPermissions.enforcement`; `startCodexAppTurn(…, stage2?)`: `bind` after initialize, `readback` after config checks, `threadParams` overlay, `threadProblem`, `approvalDetail` on command and file asks, `watch`, `teardown` in `settle` | C (bind, watch, teardown), D (readback, threadParams content, threadProblem, approvalDetail, `enforcement`) |

### 13.2 Work packages

Rules for every package: work on a branch off a private branch in its own worktree; edit only the files and functions it owns; change a skeleton signature only by agreement with its consumers, recorded in this section; model-free probes only, own listeners on random high ports, scratch homes, every process stopped; full suite green with the switch off before handing back.

| | Scope | Owns (exclusive) | Shared, by function | Provides | Consumes |
|---|---|---|---|---|---|
| **A** Network profile and ports | S1, snapshot, interface watch | `confine/ports.ts`, `confine/seatbelt-stage2.ts`, `test/stage2-ports.test.ts`, `test/stage2-profile.test.ts` | `seatbelt.ts` `seatbeltProfile` stage-2 branch; `index.ts` `NetworkPolicy` | everything in its two modules | `seatbelt.ts` param writer and diag tag; `probe.ts` `loopbackAliases`; `proxy.ts` `canonicalAddress` |
| **B** Stage-2 probe mode | S2 | `confine/probe-stage2.ts`, `test/stage2-probe.test.ts` | `probe.ts` `probeBoundary` stage-2 guards and call; `canary.ts` new step kinds (TCP bind on a port, UDP bind) | `planStage2Network`, `decoyNetwork` | A's `Stage2Network`, `interfaceAddresses`, `stage2NetworkRules` (through `wrap`) |
| **C** Executor | S3 | `backends/codex-env.ts`, `confine/sbcheck.ts` and any helper source and build step, `test/stage2-executor.test.ts`, its fixtures | `codex.ts` `codexBackend.start`; `codex-app.ts` `startCodexAppTurn` calls of `bind`, `watch`, `teardown` | `openStage2`, `Stage2Session`, executor functions | A (`leaseTurnPorts`, `listeningSnapshot`, `deniedTcpPorts`, `interfaceAddresses`, `watchInterfaces`); B through `prepareLaunch`; D (`stage2Admission`, `stage2Plan`, `stage2Readback`, `stage2ThreadProblem`, `stage2ApprovalDetail`, `stage2SkillAssets`); `turnPolicy`, `registerTurnSecret`, `watchProcess`, `stopProcs` |
| **D** Gates, readback, accounting | S4 + S5 | `backends/codex-stage2.ts`, `test/stage2-gates.test.ts` | `codex.ts` `codexFlags` stage-2 block; `codex-app.ts` `threadPermissionsProblem` (relay branch), `CodexPermissions.enforcement`; `core/worktree.ts` `hardLinkProblem` (use `turnConfinement`); `core/session.ts` the `extDir` block (`stage2SkillAssets`); `install/doctor.ts` permission audit; status/brief view of `codex_confinement` | everything in `codex-stage2.ts` | `Stage2Network` (A); `CodexPermissions`, `Expected` (codex-app.ts) |
| **E** Grant, consent, interlock, docs | S6 | `core/raw-network.ts`, `test/stage2-grant.test.ts` | `mcp/server.ts` grant schema; `core/config.ts` `targets.codex.stage2` and the two stable-surface fixtures; `core/caller.ts` `checkGrant`, `publicGrant`, `runningGrant`, `authority` (carry `raw_network` as `local_network` is carried), `admitWork`; `core/session.ts` consent block; `core/extensions.ts` `PERSON_KINDS` (`raw_network`); `core/approvals.ts` kind text; `core/ops.ts` resume message; `codex.ts` `chooseNetwork` interlock; README, UPGRADING, `confinementSummary` | `rawNetworkGrantProblem`, `rawNetworkConsent`, `localModeInterlock`, the switch | registry queries for running local-mode and stage-2 turns |
| **F** Release watch and qualification | S7 | `scripts/codex-qualify/codex-stage2.mjs` (new), `docs/qualification/` stage-2 template | the maintainer's release watcher (not published) static source list; the release watcher's notes (not published); the release watcher's tests (not published) additions | the qualification run and the watched surfaces of §7.3 | the built `dist` of C and D; the probe scripts in relay's research notes (not published) |

Per package:

**WP-A.**
- Unit tests: the rule text puts every port and path in a parameter and no literal; allows come before the denies they must lose to; `checkStage2Network` rejects overlaps and out-of-range ports; leases never overlap and are released; `listeningSnapshot` parses a recorded `lsof` fixture with control planes first; `watchInterfaces` reports an injected change.
- Live probes (the maintainer's Mac): the §5.2 table under the generated profile against its own listeners; the bind block (port 0 and other ports refused); UDP denies; AF_UNIX by turn kind; a decoy-parameter profile has the same rules hash.
- Done: generator and live probes green; §5 marks updated; settles §9.4 on any Mac with a global IPv6 address, or records that none was available.

**WP-B.**
- Unit tests: `planStage2Network` plans each check of §7.1 for read and write turns; the four reversed checks are absent under stage 2 and unchanged otherwise; `decoyNetwork` keeps the rules hash.
- Live probes: `prepareLaunch` with a stage-2 policy passes; for each stage-2 check, a profile with that rule removed fails the named probe (negative controls).
- Done: both, and the full suite unchanged for other modes.

**WP-C.**
- Unit tests: `Stage2Session` call order with a fake executor and fake app server; token absent from argv, env, files and logs (redaction); teardown order (app server, executor group, recorded descendants, sweep); `abort` before `startCodexAppTurn`.
- Live probes, through relay's own code with the fake Responses server: W1-W7 (commands and patches confined, no local fallback, memory-only token, cross-turn authentication refused); survivors after `nohup`, `setsid`, a PTY session and a listener on a block port; executor killed mid-turn (app server killed first, turn failed, a fresh listener on `E` sees no connection).
- Done: all of these; settles §9.1 (the `sandbox_check` path helper: build, install and a known-answer self-test) or documents the residual if it cannot be made reliable.

**WP-D.**
- Unit tests: each admission refusal; `stage2Plan` flags and features; readback failures for each setting; `threadPermissionsProblem` relay branch; `confined` only on command and file asks; `turnConfinement` wherever "verified" was assumed; `recordEnforcement` round trip.
- Live probes: an app server with the stage-2 settings, model-free: `config/read` and `experimentalFeature/list` show every feature in `STAGE2_FEATURES_OFF` off; `hooks/list` empty; only relay's MCP server (since r_0c11d860: none, and `local` absent); image generation absent from the tools; `--disable plugins` stops the curated plugin sync.
- Done: all of these; with F, settles §9.3 (the tool allowlist).

**WP-E.**
- Unit tests: grant validation (write jobs, Codex only, `network: true` with it, root only); consent asked once per grant and again when the grant changes; person-only; interlock both ways; switch read from config; both snapshots updated deliberately.
- Live probes: none beyond the suite.
- Done: these, the docs, and §9.2 settled (can Codex's native proxy be placed in relay's range; if not, the interlock carries C2 alone).

**WP-F.**
- Unit tests: the static source list contains every §7.3 path; the qualification script's parser.
- Live probes: the qualification items 1-12 of §7.2 on 0.164.0, scripted.
- Done: the script green on 0.164.0 with the switch on; a deliberately changed surface leaves the PR for the maintainer.

### 13.3 Integration order and checks

Every package starts on day 1 against the skeleton's signatures. They merge into a private branch in this order, each merge followed by typecheck, build and the full suite with the switch off:
1. **A** and **E** (no consumers among the others yet besides types).
2. **D**.
3. **B** (needs A's rules). Check: `prepareLaunch` of a stage-2 policy passes on the maintainer's Mac.
4. **C** (needs A, B, D). Check: with the switch on (environment variable, until E's config key is in), a Codex job with `raw_network` through relay's real path and the fake model: W1-W7, the survivor cases and executor death.
5. **F**. Check: the qualification script green on 0.164.0.
6. Final: E's switch moved to config; full suite; cross-family review of the diff; red-team (§13.4).

### 13.4 Red-team probes for the integrated build

Run with the switch on, against decoys and scratch state only:
- **Reach a denied port:** directly at every local address and spelling; through a forwarder relay started for the test (a local-mode proxy, an SSH-style SOCKS listener); through DNS names that resolve locally; after an address appears mid-turn; through `trustd` with a crafted certificate URL (`TRUST` off, so this must fail at the lookup).
- **Act through the app server:** ask for image generation, an MCP elicitation, a plugin install, a hook, a skill dependency install, a user shell command; each must be absent, declined or refused, and leave no file outside the roots.
- **Survive the turn:** `setsid`, `nohup`, double fork, a PTY session, a block-port listener, `launchctl submit`, `at`/`crontab`; after teardown nothing runs and no write or connection happens.
- **Use another turn's executor:** scan relay's range from a second stage-2 turn; look for the token in temp dirs, environments, logs and `ps`; kill an executor and squat its port before the app server could reconnect.
- **Impersonate through bind:** bind outside the block, port 0, a denied port while its service is down, UDP on a service port; record what the 0.0.0.0 bind on a block port exposes.
- **Reach the LAN as disclosed:** the LAN and tailnet are reachable on non-denied ports (as disclosed); SSDP and NAT-PMP are refused; nothing beyond the disclosure.

### 13.5 Open questions by package

| §9 item | Package |
|---|---|
| 9.1 compiled `sandbox_check` helper for the survivor sweep | C |
| 9.2 Codex's native proxy in relay's range | E (with A) |
| 9.3 the tool allowlist | D, qualified by F |
| 9.4 global IPv6 | A (profile), B (probe of each global address) |
| 9.5 stage 2 for jobs without network | none: after stage 2 ships |
