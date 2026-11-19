# Codex CLI 0.167.2: checked by the release watcher

Checked on 2026-11-16 by the maintainer's release watcher (not published) on the maintainer's Mac by hand (macOS 27.2.1, a Background session under tmux, Node v24.22.3), with the watcher's own lane steps (ci.mjs detect --codex 0.167.2, static, live) in a scratch HOME and TMPDIR, with relay at a private commit plus 0.167.2 in `VERIFIED.codexCli`. The checks are those of the hand check of 0.164.0 (the maintainer's notes, 2026-10-23). `tested` stays the floor relay was qualified at; this records only that relay's Codex route was checked on 0.167.2. The binary: npm's `@openai/codex@0.167.2` (darwin-arm64), 271027872 bytes, sha256 `97bc82fd46f117cf`.

## Source

`rust-v0.167.2` against `rust-v0.167.1` in github.com/openai/codex, by `SOURCE` in the maintainer's release watcher (not published): whole files token by token (comments and layout aside), the permission and sandbox code of `core/src/config/mod.rs`, and the app-server protocol's fields relay sends and reads.

Each entry's outcome (compared: identical in what relay depends on):
- `codex-rs/core/src/config/permissions.rs`: compared
- `codex-rs/protocol/src/permissions.rs`: compared
- `codex-rs/app-server-protocol/src/experimental_api.rs`: compared
- `codex-rs/protocol/src/shell_environment.rs`: compared
- `codex-rs/config/src/shell_environment_policy.rs`: compared
- `codex-rs/models-manager/src/cache.rs`: compared
- `codex-rs/protocol/src/openai_models/access_programs.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/v2/turn.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/v2/config.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/v2/experimental_feature.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/v2/command_exec.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/v2/shared.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/v2/permissions.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`: compared
- `codex-rs/protocol/src/approvals.rs`: compared
- `codex-rs/sandboxing/src/seatbelt.rs`: compared
- `codex-rs/network-proxy/src/policy.rs`: compared
- `codex-rs/network-proxy/src/connect_policy.rs`: compared
- `codex-rs/network-proxy/src/runtime.rs`: compared
- `codex-rs/network-proxy/src/network_policy.rs`: compared
- `codex-rs/core/src/config/network_config.rs`: compared
- `codex-rs/core/src/tools/network_approval.rs`: compared
- `codex-rs/core/src/tools/sandboxing.rs`: compared
- `codex-rs/protocol/src/permissions/target.rs`: compared
- `codex-rs/core/src/exec_policy.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/v2/environment.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/common.rs`: compared
- `codex-rs/exec-server/src/environment.rs`: compared
- `codex-rs/exec-server/src/environment_toml.rs`: compared
- `codex-rs/exec-server/src/environment_provider.rs`: compared
- `codex-rs/exec-server/src/server/transport.rs`: compared
- `codex-rs/exec-server-cli/src/command.rs`: compared
- `codex-rs/exec-server-cli/src/config.rs`: compared
- `codex-rs/exec-server/src/remote.rs`: compared
- `codex-rs/exec-server/src/local_process.rs`: compared
- `codex-rs/websocket-auth/src/lib.rs`: compared
- `codex-rs/core/src/tools/spec_plan.rs`: compared
- `codex-rs/core/src/tools/handlers/multi_agents/spawn.rs`: compared
- `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs`: compared
- `codex-rs/codex-mcp/src/mcp/mod.rs`: compared
- `codex-rs/codex-mcp/src/runtime.rs`: compared
- `codex-rs/core/src/unified_exec/process_manager.rs`: compared
- `codex-rs/codex-mcp/src/rmcp_client.rs`: compared
- `codex-rs/rmcp-client/src/rmcp_client.rs`: compared
- `codex-rs/rmcp-client/src/streamable_http_retry.rs`: compared
- `codex-rs/rmcp-client/src/utils.rs`: compared
- `codex-rs/rmcp-client/src/http_client_adapter.rs`: compared
- `codex-rs/http-client/src/outbound_proxy.rs`: compared
- `codex-rs/core/src/config/mod.rs`: compared
- `codex-rs/codex-mcp/src/connection_manager/tool_catalog.rs`: compared
- `codex-rs/app-server-transport/src/transport/stdio.rs`: compared
- `codex-rs/config/src/merge.rs`: compared
- `codex-rs/config/src/mcp_types.rs`: compared
- `codex-rs/core/src/session/mcp.rs`: compared
- `codex-rs/core/src/mcp_skill_dependencies.rs`: compared
- `codex-rs/core/src/mcp_tool_call.rs`: compared
- `codex-rs/ext`: compared
- `codex-rs/hooks/src`: compared
- `codex-rs/core/src/tasks/user_shell.rs`: compared
- `codex-rs/features/src/lib.rs`: differs (the file's code)
- `codex-rs/app-server/src/message_processor.rs`: compared
- `codex-rs/core-plugins/src/manager.rs`: compared
- `codex-rs/core-plugins/src/startup_sync.rs`: compared
- `codex-rs/app-server/src/thread_sample.rs`: compared
- `codex-rs/app-server/src/request_processors/thread_processor.rs`: compared
- `codex-rs/core/src/session/mod.rs`: compared
- `codex-rs/core/src/context/world_state/tools.rs`: compared
- `codex-rs/core/src/session/world_state.rs`: compared
- `codex-rs/core/src/session/reasoning_effort.rs`: compared
- `codex-rs/core/src/client.rs`: compared
- `codex-rs/network-proxy/src`: compared
- `codex-rs/app-server/src/request_processors/thread_queue_processor.rs`: compared
- `codex-rs/app-server/src/request_processors/daemon_continuation.rs`: compared
- `codex-rs/core/src/session/turn_input.rs`: compared
- `callers of \b\w*(?:_if_idle|IfIdle)\w*\b|\bcontinue_daemon_turn\b|\bsubmit_turn_input_with_mode\b`: compared
- `codex-rs/core/src/code_mode_host.rs`: compared
- `codex-rs/code-mode-runtime/src/runtime/globals.rs`: compared
- `codex-rs/code-mode-runtime/src/runtime/module_loader.rs`: compared

**It differs:** codex-rs/features/src/lib.rs: the file's code. Merging the watcher's PR accepts it after reading the diff.

## Live checks

Codex was not signed in: the checks that need a login did not run. A scratch HOME, relay home and repository; relay's MCP server driven as a host would drive it.

| Case | What | Result |
|---|---|---|
| sandbox | Codex's own sandbox (`codex sandbox`) under relay's write profile: the worktree and a grant writable; `.claude`, `.gemini`, `.mcp.json`, `.codex`, `.agents` and `.git` at their top, `/tmp` and elsewhere not (and `.Claude`, on a case-insensitive disk); the read profile writes nothing. No login. | Passed. |
| config | relay's own checks of the app server's reports with relay's flags (MCP servers listed by `codex mcp list --json`): config/read (the profile selected and exactly relay's, the fast-mode pin, a shell_environment_policy relay can read), configRequirements/read and skills/list. No login. | Passed. |
| read-pong | An `ask` that replies PONG. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |
| write-job | A write `delegate`: `mkdir .claude` refused by the sandbox, `hello.txt` written to the job's worktree. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |
| write-job-resume | Its `resume` in the same Codex session: a second line appended, still no `.claude`. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |
| case-alias | A write `delegate`: `mkdir .Claude` (and a file in it) refused. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |
| daybreak-eligible | Daybreak on, a model the account's cache lists for daybreak_blue: OK and no note, also on a follow-up in the thread; Codex recorded `daybreak_blue` for both turns. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |
| daybreak-ineligible | Daybreak on, a model it does not list: OK, with relay's note that Daybreak was not applied; Codex recorded `standard`. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |
| stage2 | Stage 2's qualification ([design](../codex-confinement-design.md) §7.2; [escalation WP6](../qualification/escalation-wp6.md)), model-free: items 1-30, below. No login. Public and hour-long controls require explicit opt-in. | **not run**: stage 2 qualification not run; item 28 not run: public: opt in with RELAY_TEST_PUBLIC_NET=1; item 30 not run: long: opt in with RELAY_TEST_ESCALATION_LONG=1 (takes over one hour), or =readback for the timeout readback alone. |
| daybreak-nomodel | Daybreak on, no model named: OK, with relay's note that the model is unknown; Codex recorded `standard`. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |
| daybreak-exec | Daybreak on, the `codex exec` backend, the eligible model: OK and no note; Codex recorded `daybreak_blue`. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |
| daybreak-unset | Daybreak unset, the eligible model: OK and no note; Codex recorded no access program relay set. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |

## Stage 2 qualification

the maintainer's release watcher (not published) (template and items: [codex-stage2-template.md](codex-stage2-template.md)): a fake Responses API on loopback, scratch Codex and relay homes, this run's own listeners; each item's `codex` part against this release under relay's stage-2 profile and flags, its `control` where the same calls must escape, its `relay` part through relay's own stage-2 path. Overall: **not run**; relay's stage-2 path: present.

| Item | What | Result |
|---|---|---|
| 1 | commands, apply_patch and code mode's nested tools confined to the roots, and a denied port unreachable; control without the environment (W1, W5, B0) | Passed. |
| 2 | a restricted Codex profile in the environment fails closed: exit 71 (B3) | Passed. |
| 3 | a local stdio MCP server starts outside the executor; under relay's stage-2 settings only authenticated relay_tools runs (W2) | Passed. |
| 4 | an exec-policy allow rule and an approved require_escalated command stay confined (W3) | Passed. |
| 5 | an unreachable executor: no fallback to local (W4) | Passed. |
| 6 | the executor token is memory-only: in no argv, environment or file (X7, W7) | Passed. |
| 7 | cross-turn authentication: no token, a wrong token and a guessed one are refused (X7, W6, W7) | Passed. |
| 8 | survivors: background, nohup, setsid, a terminal session and a block-port listener are gone after teardown (C5, X3) | Passed. |
| 9 | executor death mid-turn: the app server is stopped first, the turn fails, a fresh listener on its port sees nothing | Passed. |
| 10 | the tool list under relay's version-specific stage-2 settings (prediction parent tools pinned off where supported) is within the allowlist for every catalog model; code mode's isolate has no Node, file or network bindings; explicit effort reaches the model on fresh and resumed turns (§2.5, §9.3) | Passed. |
| 11 | a subagent's command runs in the relay environment; under relay's settings (no local environment) a resumed thread has no environment until bound per turn (turn/start.environments), then keeps commands and subagents in the executor, and unbound runs nothing (control: with local, unbound runs locally); no turn starts by itself on a resume under relay's flags, an active goal's included (control: with goals on it does); with goals on and no local, the goal's own turn, steered into by a bound turn/start, runs nothing (control: with local it runs there); relay refuses a resume with a queued message | Passed. |
| 12 | plugins off and discovery prefetch off where supported: no curated sync or host-side discovery traffic, with an authenticated discovery positive control | Passed. |
| 13 | an older Codex (0.163): nothing escapes, and relay's admission refuses it (STAGE2_MIN_CODEX) | Passed. |
| 14 | HTTP without local: exact entry, listings, direct and code-mode calls, and a 75-second call | Passed. |
| 15 | credentials/front: missing variable, wrong token, foreign peer, broken checker, required startup and app-server-first mid-turn failure | Passed. |
| 16 | relay stdio coexists with relay_tools; person-defined relay_tools refuses admission | Passed. |
| 17 | NO_PROXY protects the bearer from a decoy proxy, with a leaking negative control | Passed. |
| 18 | authenticated reconnect after broker loss and app-server EOF within one second | Passed. |
| 19 | 404 replays; tombstone and cap JSON-RPC errors never replay or evict | Passed. |
| 20 | C6: no broker-token name or value in commands (plain, terminal, nested code mode) through the real executor | Passed. |
| 21 | C1: a self-started goal continuation cannot call the disarmed broker | Passed. |
| 22 | C8: v1/v2 broker session counts, churn and resume under canonical pins | Passed. |
| 23 | out-of-profile hosted/open-page and extension screening, distinguishing exact model websocket upgrades | Passed. |
| 24 | restart receipt, first call, replay, cancellation and handoff loss | Passed. |
| 25 | authenticated authority adversaries and consume isolation | Passed. |
| 26 | finite deadline, worker-death/reap and monotonic floor races | Passed. |
| 27 | overlay decoy profiles, exact listen, outside roots and raw-host refusal | Passed. |
| 28 | mediated DNS, aliases, teardown, bypass and credentials | **not run** in the watcher's run: public: opt in with RELAY_TEST_PUBLIC_NET=1. Passed with the opt-in, every part (below). |
| 29 | local refusal, interlock and Claude/ACP never proxies | Passed. |
| 30 | MCP result delivered exactly once beyond the former 3600-second timeout (opt-in hour-long probe) | **not run** in the watcher's run: long: opt in with RELAY_TEST_ESCALATION_LONG=1 (takes over one hour), or =readback for the timeout readback alone. Passed with the opt-in (below). |
| 31 | standing network: stage2 routing, never hosts, proxy variables, refusal and resume | Passed. |
| 32 | IPv4 localhost connect: disclosed LAN/tailnet scope, never and other-port denial | Passed. |
| 33 | the keychain under the never floor: a decoy keychain item is refused to floored native Codex turns, and its control without the file deny matches doctor's documented keychain IPC | Passed. |

## Opt-in controls (2026-11-17)

The watcher leaves item 28's public part and item 30 off, so its stage-2 verdict above is "not run" for those two alone. The pinned-Codex qualifier counts a part left "not run" as a failure. To complete the qualification, both items were run by hand straight after, with the same binary (sha256 `97bc82fd46f117cf`), relay build and scratch HOME and TMPDIR: `RELAY_TEST_PUBLIC_NET=1 RELAY_TEST_ESCALATION_LONG=1 node scripts/release-watch/codex-stage2.mjs "$PWD" <scratch> 0.167.2 <codex> --old-bin <codex 0.163.0> --items 28,30`.

- **Item 28:** passed, every part (unit, addresses, worker, public, crossJobCrash).
- **Item 30:** passed. One call was delivered exactly once after 3601 seconds, with the tool timeout at 7500 seconds.

Its verdict is "not run" overall only because the other 31 items were not selected. Taken together, the two runs pass all 33 items.

## Requalified with `incremental_tools_legacy_gcp` pinned off (2026-11-17)

The first hand run, on 2026-11-16 at `da2fea5ae749`, failed stage 2 in every item that goes through relay's stage-2 path. The source difference (`codex-rs/features/src/lib.rs`, openai/codex#60617 and #60848) adds the feature `incremental_tools_legacy_gcp`, `Stage::Stable` and `default_enabled: true`; 0.167.0 and 0.167.1 do not list it. Relay's feature readback (`stage2Readback`) refused it as on and unqualified. That was relay failing closed, not a fault in Codex. At `rust-v0.167.2`, `core/src/session/step_context.rs` selects the feature only when the turn's model provider is `gcp` (`GCP_PROVIDER_ID`). Relay's turns use OpenAI's provider, so it changes no tool they are offered.

The maintainer decided on 2026-11-16 to pin it off, not admit it. Relay now sets `features.incremental_tools_legacy_gcp=false` on Codex 0.167.2 and later (`stage2FeaturesOff`), and the readback requires it to be listed and off there. It stays out of `STAGE2_FEATURES_ALLOWED_ON`, and older versions are not required to list it. This run was at `10c40c544085`: `main` at `533f73be` plus that change and a private PR's commits. The branch was then rebased on `main` at `50e903f3`, whose new commits change only Claude's side (consent, Claude Code 2.1.326), and the full suite passed again there (2106 tests, 2051 passed, 55 skipped, none failed):

- **Source:** differs from 0.167.1 in `codex-rs/features/src/lib.rs` alone, as before.
- **sandbox** and **config:** passed.
- **stage2:** items 1-27, 29 and 31-33 passed in the watcher's run, and items 28 and 30 in the opt-in run.
- **Signed-in cases: not run.** The watcher signs in only from a Codex access token or an API key (`codex login --with-access-token`/`--with-api-key` in a scratch `CODEX_HOME`). Relay's Codex home (`~/.local/share/relay-codex-home`) holds a ChatGPT sign-in. Copying it into scratch would let Codex refresh it there and rotate the refresh token, signing relay's own home out. Neither that nor pointing the checks at that home was done. These cases (read-pong, write-job, write-job-resume, case-alias and the five daybreak cases) still need a run by hand in the maintainer's own session.

The run was in a Background launchd session under tmux rather than the Aqua session of the first run. Relay's sandbox reported that it works, and every relay part of stage 2 ran.

Relay's Codex pin stays 0.167.0. Evidence on the maintainer's Mac: `<scratch>/rw01672/evidence/` holds the plan, static and live JSON, this record as rendered, stage 2's verdict and TAP files (`stage2/`), the opt-in run (`stage2-optin/`, `stage2-optin.log`), the logs and the full suite's log. The first run's evidence is in `<scratch>/rw0167/evidence/`.
