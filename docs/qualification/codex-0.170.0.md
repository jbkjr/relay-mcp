# Codex CLI 0.170.0: checked by hand

Checked on 2026-11-18 by hand with the maintainer's release watcher's own steps (not published) on the maintainer's Mac (macOS 27.2.1, an Aqua session under tmux, Node v24.22.3), with relay at a private commit plus 0.170.0 in `VERIFIED.codexCli`. The checks are those of the hand check of 0.164.0 (the maintainer's notes, 2026-10-23). `tested` stays the floor relay was qualified at; this records only that relay's Codex route was checked on 0.170.0. The binary: npm's `@openai/codex@0.170.0` (darwin-arm64), 284118160 bytes, sha256 `9248cfeebec9b4cc`.

## Source

`rust-v0.170.0` against `rust-v0.167.2` in github.com/openai/codex, by `SOURCE` in the maintainer's release watcher (not published): whole files token by token (comments and layout aside), the permission and sandbox code of `core/src/config/mod.rs`, and the app-server protocol's fields relay sends and reads.

Each entry's outcome (compared: identical in what relay depends on):
- `codex-rs/core/src/config/permissions.rs`: compared
- `codex-rs/protocol/src/permissions.rs`: differs (the file's code)
- `codex-rs/app-server-protocol/src/experimental_api.rs`: compared
- `codex-rs/protocol/src/shell_environment.rs`: compared
- `codex-rs/config/src/shell_environment_policy.rs`: compared
- `codex-rs/models-manager/src/cache.rs`: compared
- `codex-rs/protocol/src/openai_models/access_programs.rs`: differs (the file's code)
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
- `codex-rs/sandboxing/src/seatbelt.rs`: differs (fn create_seatbelt_command_args: changed; fn create_seatbelt_command_args_with_profile: changed)
- `codex-rs/network-proxy/src/policy.rs`: compared
- `codex-rs/network-proxy/src/connect_policy.rs`: differs (the file's code)
- `codex-rs/network-proxy/src/runtime.rs`: compared
- `codex-rs/network-proxy/src/network_policy.rs`: differs (fn evaluate_host_policy: changed)
- `codex-rs/core/src/config/network_config.rs`: compared
- `codex-rs/core/src/tools/network_approval.rs`: differs (the file's code)
- `codex-rs/core/src/tools/sandboxing.rs`: differs (the file's code)
- `codex-rs/protocol/src/permissions/target.rs`: compared
- `codex-rs/core/src/exec_policy.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/v2/environment.rs`: compared
- `codex-rs/app-server-protocol/src/protocol/common.rs`: compared
- `codex-rs/exec-server/src/environment.rs`: differs (the file's code)
- `codex-rs/exec-server/src/environment_toml.rs`: compared
- `codex-rs/exec-server/src/environment_provider.rs`: compared
- `codex-rs/exec-server/src/server/transport.rs`: compared
- `codex-rs/exec-server-cli/src/command.rs`: differs (the file's code)
- `codex-rs/exec-server-cli/src/config.rs`: differs (the file's code)
- `codex-rs/exec-server/src/remote.rs`: differs (the file's code)
- `codex-rs/exec-server/src/local_process.rs`: differs (the file's code)
- `codex-rs/websocket-auth/src/lib.rs`: compared
- `codex-rs/core/src/tools/spec_plan.rs`: differs (the file's code)
- `codex-rs/core/src/tools/handlers/multi_agents/spawn.rs`: differs (the file's code)
- `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs`: compared
- `codex-rs/codex-mcp/src/mcp/mod.rs`: differs (the file's code)
- `codex-rs/codex-mcp/src/runtime.rs`: differs (the file's code)
- `codex-rs/core/src/unified_exec/process_manager.rs`: differs (the file's code)
- `codex-rs/codex-mcp/src/rmcp_client.rs`: differs (the file's code)
- `codex-rs/rmcp-client/src/rmcp_client.rs`: differs (the file's code)
- `codex-rs/rmcp-client/src/streamable_http_retry.rs`: compared
- `codex-rs/rmcp-client/src/utils.rs`: compared
- `codex-rs/rmcp-client/src/http_client_adapter.rs`: differs (the file's code)
- `codex-rs/http-client/src/outbound_proxy.rs`: compared
- `codex-rs/core/src/config/mod.rs`: differs (the file's code)
- `codex-rs/codex-mcp/src/connection_manager/tool_catalog.rs`: differs (the file's code)
- `codex-rs/app-server-transport/src/transport/stdio.rs`: compared
- `codex-rs/config/src/merge.rs`: compared
- `codex-rs/config/src/mcp_types.rs`: differs (the file's code)
- `codex-rs/core/src/session/mcp.rs`: differs (the file's code)
- `codex-rs/core/src/mcp_skill_dependencies.rs`: differs (the file's code)
- `codex-rs/core/src/mcp_tool_call.rs`: differs (the file's code)
- `codex-rs/ext`: differs (agent-message-board/Cargo.toml: changed; agent-message-board/src/backend.rs: new; agent-message-board/src/lib.rs: changed; agent-message-board/src/mcp.rs: new; extension-api/src/contributors.rs: changed; extension-api/src/contributors/approval_review.rs: changed; extension-api/src/contributors/mcp.rs: changed; extension-api/src/contributors/thread_lifecycle.rs: changed; extension-api/src/contributors/tool_lifecycle.rs: changed; extension-api/src/contributors/world_state.rs: changed; extension-api/src/lib.rs: changed; extension-api/src/message_lifecycle.rs: changed; extension-api/src/model_request.rs: changed; git-attribution/Cargo.toml: changed; git-attribution/src/lib.rs: changed; git-attribution/src/policy.rs: changed; goal/src/extension.rs: changed; goal/src/runtime.rs: changed; goal/src/steering.rs: changed; goal/src/tool.rs: changed; guardian-reviewer/Cargo.toml: changed; guardian-reviewer/src/approval_request.rs: changed; guardian-reviewer/src/approval_request_json.rs: changed; guardian-reviewer/src/elicitation.rs: changed; guardian-reviewer/src/execution.rs: changed; guardian-reviewer/src/feedback.rs: changed; guardian-reviewer/src/lib.rs: changed; guardian-reviewer/src/model.rs: changed; guardian-reviewer/src/outcome.rs: changed; guardian-reviewer/src/pool.rs: changed; guardian-reviewer/src/prompt.rs: changed; guardian-reviewer/src/reconsideration.rs: new; guardian-reviewer/src/retry.rs: changed; guardian-reviewer/src/review.rs: changed; guardian-reviewer/src/review_evidence.rs: changed; guardian-reviewer/src/routing.rs: changed; guardian-v2/Cargo.toml: changed; guardian-v2/src/async_scorer/approval.rs: changed; guardian-v2/src/async_scorer/classification.rs: changed; guardian-v2/src/async_scorer/config.rs: changed; guardian-v2/src/async_scorer/decisions.rs: changed; guardian-v2/src/async_scorer/extension.rs: changed; guardian-v2/src/async_scorer/metrics.rs: changed; guardian-v2/src/async_scorer/observation.rs: changed; guardian-v2/src/async_scorer/request.rs: changed; guardian-v2/src/async_scorer/sampler.rs: changed; guardian-v2/src/async_scorer/sampler/connection_pool.rs: changed; guardian-v2/src/async_scorer/sampler/execution.rs: changed; guardian-v2/src/async_scorer/startup.rs: changed; guardian-v2/src/async_scorer/transcript.rs: changed; guardian-v2/src/async_scorer/trusted_tools.rs: changed; guardian-v2/src/sync_reviewer/mod.rs: changed; guardian-v3/BUILD.bazel: changed; guardian-v3/Cargo.toml: changed; guardian-v3/src/delivery.rs: new; guardian-v3/src/evidence.rs: new; guardian-v3/src/housekeeper.rs: new; guardian-v3/src/lib.rs: changed; guardian-v3/src/retrieval_tools.rs: new; guardian-v3/src/sampling.rs: new; guardian-v3/src/selection.rs: new; guardian-v3/src/subscription_tools.rs: new; history-notes/BUILD.bazel: changed; history-notes/Cargo.toml: changed; history-notes/src/backend.rs: changed; history-notes/src/extension.rs: changed; history-notes/src/lib.rs: changed; history-notes/src/requests.rs: new; history-notes/src/snapshots/codex_history_notes_extension__tools__tests__bundled_tool_contracts.snap: new; history-notes/src/tools.rs: changed; image-generation/BUILD.bazel: changed; image-generation/src/artifact.rs: changed; image-generation/src/backend.rs: changed; image-generation/src/extension.rs: changed; image-generation/src/tool.rs: changed; mcp/src/plugin.rs: changed; mcp/src/plugin/discovery.rs: changed; queue/src/service.rs: changed; skills/src/catalog_delta.rs: changed; skills/src/catalog_state.rs: changed; skills/src/cloud_skill.rs: changed; skills/src/extension.rs: changed; skills/src/host_outcome.rs: changed; skills/src/host_prompt.rs: changed; skills/src/host_roots.rs: changed; skills/src/host_service.rs: changed; skills/src/host_snapshot.rs: changed; skills/src/invocation.rs: changed; skills/src/lib.rs: changed; skills/src/loader/discovery.rs: changed; skills/src/loader/host.rs: changed; skills/src/loader/host_merge.rs: changed; skills/src/loader/metadata.rs: changed; skills/src/loader/mod.rs: changed; skills/src/preparation.rs: changed; skills/src/provider.rs: changed; skills/src/provider/executor.rs: changed; skills/src/provider/frozen_cloud.rs: changed; skills/src/provider/host.rs: changed; skills/src/render_dedup.rs: changed; skills/src/sources.rs: changed; skills/src/state.rs: changed; skills/src/tools/installations.rs: changed; skills/src/tools/list.rs: changed; skills/src/tools/mod.rs: changed; skills/src/tools/read.rs: changed; skills/src/world_state_catalogs.rs: changed; web-search/src/extension.rs: changed; web-search/src/tool.rs: changed)
- `codex-rs/hooks/src`: differs (bin/write_hooks_schema_fixtures.rs: changed)
- `codex-rs/core/src/tasks/user_shell.rs`: differs (the file's code)
- `codex-rs/features/src/lib.rs`: differs (the file's code)
- `codex-rs/app-server/src/message_processor.rs`: differs (the file's code)
- `codex-rs/core-plugins/src/manager.rs`: differs (the file's code)
- `codex-rs/core-plugins/src/startup_sync.rs`: compared
- `codex-rs/app-server/src/thread_sample.rs`: differs (the file's code)
- `codex-rs/app-server/src/request_processors/thread_processor.rs`: differs (the file's code)
- `codex-rs/core/src/session/mod.rs`: differs (the file's code)
- `codex-rs/core/src/context/world_state/tools.rs`: compared
- `codex-rs/core/src/session/world_state.rs`: differs (the file's code)
- `codex-rs/core/src/session/reasoning_effort.rs`: differs (the file's code)
- `codex-rs/core/src/client.rs`: differs (the file's code)
- `codex-rs/network-proxy/src`: differs (config.rs: changed; connect_policy.rs: changed; domain_matcher.rs: changed; http_proxy.rs: changed; lib.rs: changed; mitm.rs: changed; network_policy.rs: changed; policy.rs: changed; proxy.rs: changed; proxy/execution_scope.rs: changed; runtime.rs: changed; socks5.rs: changed; tcp_upstream.rs: new)
- `codex-rs/app-server/src/request_processors/thread_queue_processor.rs`: differs (the file's code)
- `codex-rs/app-server/src/request_processors/daemon_continuation.rs`: differs (the file's code)
- `codex-rs/core/src/session/turn_input.rs`: differs (the file's code)
- `callers of \b\w*(?:_if_idle|IfIdle)\w*\b|\bcontinue_daemon_turn\b|\bsubmit_turn_input_with_mode\b`: differs (codex-rs/app-server-client/src/cloud_backend/mod.rs: new caller; `cloud :: SubmissionMode :: StartIfIdle`; `cloud :: SubmissionMode :: StartIfIdle`; codex-rs/app-server-client/src/cloud_backend/requests.rs: new caller; `mode : cloud :: SubmissionMode :: StartIfIdle`; codex-rs/cloud-client/src/turns.rs: new caller; `StartIfIdle`; `SubmissionMode :: StartIfIdle => 3`; codex-rs/ext/goal/src/runtime.rs: `match thread . start_turn_if_idle ( request . on_start ( TurnStartOptions`; codex-rs/ext/queue/src/service.rs: `let submission = thread . start_turn_if_idle ( TurnInputRequest :: new ( input ) . with_responses_metadata ( item . responsesapi_client_metadata ) . with_trace `; `match thread . start_turn_if_idle ( TurnInputRequest :: new ( item . input ) . with_responses_metadata ( item . responsesapi_client_metadata ) . on_start ( Turn`)
- `codex-rs/core/src/code_mode_host.rs`: compared
- `codex-rs/code-mode-runtime/src/runtime/globals.rs`: differs (the file's code)
- `codex-rs/code-mode-runtime/src/runtime/module_loader.rs`: compared

**It differs:** codex-rs/protocol/src/permissions.rs: the file's code; codex-rs/protocol/src/openai_models/access_programs.rs: the file's code; codex-rs/sandboxing/src/seatbelt.rs: fn create_seatbelt_command_args: changed; fn create_seatbelt_command_args_with_profile: changed; codex-rs/network-proxy/src/connect_policy.rs: the file's code; codex-rs/network-proxy/src/network_policy.rs: fn evaluate_host_policy: changed; codex-rs/core/src/tools/network_approval.rs: the file's code; codex-rs/core/src/tools/sandboxing.rs: the file's code; codex-rs/exec-server/src/environment.rs: the file's code; codex-rs/exec-server-cli/src/command.rs: the file's code; codex-rs/exec-server-cli/src/config.rs: the file's code; codex-rs/exec-server/src/remote.rs: the file's code; codex-rs/exec-server/src/local_process.rs: the file's code; codex-rs/core/src/tools/spec_plan.rs: the file's code; codex-rs/core/src/tools/handlers/multi_agents/spawn.rs: the file's code; codex-rs/codex-mcp/src/mcp/mod.rs: the file's code; codex-rs/codex-mcp/src/runtime.rs: the file's code; codex-rs/core/src/unified_exec/process_manager.rs: the file's code; codex-rs/codex-mcp/src/rmcp_client.rs: the file's code; codex-rs/rmcp-client/src/rmcp_client.rs: the file's code; codex-rs/rmcp-client/src/http_client_adapter.rs: the file's code; codex-rs/core/src/config/mod.rs: the file's code; codex-rs/codex-mcp/src/connection_manager/tool_catalog.rs: the file's code; codex-rs/config/src/mcp_types.rs: the file's code; codex-rs/core/src/session/mcp.rs: the file's code; codex-rs/core/src/mcp_skill_dependencies.rs: the file's code; codex-rs/core/src/mcp_tool_call.rs: the file's code; codex-rs/ext: agent-message-board/Cargo.toml: changed; agent-message-board/src/backend.rs: new; agent-message-board/src/lib.rs: changed; agent-message-board/src/mcp.rs: new; extension-api/src/contributors.rs: changed; extension-api/src/contributors/approval_review.rs: changed; extension-api/src/contributors/mcp.rs: changed; extension-api/src/contributors/thread_lifecycle.rs: changed; extension-api/src/contributors/tool_lifecycle.rs: changed; extension-api/src/contributors/world_state.rs: changed; extension-api/src/lib.rs: changed; extension-api/src/message_lifecycle.rs: changed; extension-api/src/model_request.rs: changed; git-attribution/Cargo.toml: changed; git-attribution/src/lib.rs: changed; git-attribution/src/policy.rs: changed; goal/src/extension.rs: changed; goal/src/runtime.rs: changed; goal/src/steering.rs: changed; goal/src/tool.rs: changed; guardian-reviewer/Cargo.toml: changed; guardian-reviewer/src/approval_request.rs: changed; guardian-reviewer/src/approval_request_json.rs: changed; guardian-reviewer/src/elicitation.rs: changed; guardian-reviewer/src/execution.rs: changed; guardian-reviewer/src/feedback.rs: changed; guardian-reviewer/src/lib.rs: changed; guardian-reviewer/src/model.rs: changed; guardian-reviewer/src/outcome.rs: changed; guardian-reviewer/src/pool.rs: changed; guardian-reviewer/src/prompt.rs: changed; guardian-reviewer/src/reconsideration.rs: new; guardian-reviewer/src/retry.rs: changed; guardian-reviewer/src/review.rs: changed; guardian-reviewer/src/review_evidence.rs: changed; guardian-reviewer/src/routing.rs: changed; guardian-v2/Cargo.toml: changed; guardian-v2/src/async_scorer/approval.rs: changed; guardian-v2/src/async_scorer/classification.rs: changed; guardian-v2/src/async_scorer/config.rs: changed; guardian-v2/src/async_scorer/decisions.rs: changed; guardian-v2/src/async_scorer/extension.rs: changed; guardian-v2/src/async_scorer/metrics.rs: changed; guardian-v2/src/async_scorer/observation.rs: changed; guardian-v2/src/async_scorer/request.rs: changed; guardian-v2/src/async_scorer/sampler.rs: changed; guardian-v2/src/async_scorer/sampler/connection_pool.rs: changed; guardian-v2/src/async_scorer/sampler/execution.rs: changed; guardian-v2/src/async_scorer/startup.rs: changed; guardian-v2/src/async_scorer/transcript.rs: changed; guardian-v2/src/async_scorer/trusted_tools.rs: changed; guardian-v2/src/sync_reviewer/mod.rs: changed; guardian-v3/BUILD.bazel: changed; guardian-v3/Cargo.toml: changed; guardian-v3/src/delivery.rs: new; guardian-v3/src/evidence.rs: new; guardian-v3/src/housekeeper.rs: new; guardian-v3/src/lib.rs: changed; guardian-v3/src/retrieval_tools.rs: new; guardian-v3/src/sampling.rs: new; guardian-v3/src/selection.rs: new; guardian-v3/src/subscription_tools.rs: new; history-notes/BUILD.bazel: changed; history-notes/Cargo.toml: changed; history-notes/src/backend.rs: changed; history-notes/src/extension.rs: changed; history-notes/src/lib.rs: changed; history-notes/src/requests.rs: new; history-notes/src/snapshots/codex_history_notes_extension__tools__tests__bundled_tool_contracts.snap: new; history-notes/src/tools.rs: changed; image-generation/BUILD.bazel: changed; image-generation/src/artifact.rs: changed; image-generation/src/backend.rs: changed; image-generation/src/extension.rs: changed; image-generation/src/tool.rs: changed; mcp/src/plugin.rs: changed; mcp/src/plugin/discovery.rs: changed; queue/src/service.rs: changed; skills/src/catalog_delta.rs: changed; skills/src/catalog_state.rs: changed; skills/src/cloud_skill.rs: changed; skills/src/extension.rs: changed; skills/src/host_outcome.rs: changed; skills/src/host_prompt.rs: changed; skills/src/host_roots.rs: changed; skills/src/host_service.rs: changed; skills/src/host_snapshot.rs: changed; skills/src/invocation.rs: changed; skills/src/lib.rs: changed; skills/src/loader/discovery.rs: changed; skills/src/loader/host.rs: changed; skills/src/loader/host_merge.rs: changed; skills/src/loader/metadata.rs: changed; skills/src/loader/mod.rs: changed; skills/src/preparation.rs: changed; skills/src/provider.rs: changed; skills/src/provider/executor.rs: changed; skills/src/provider/frozen_cloud.rs: changed; skills/src/provider/host.rs: changed; skills/src/render_dedup.rs: changed; skills/src/sources.rs: changed; skills/src/state.rs: changed; skills/src/tools/installations.rs: changed; skills/src/tools/list.rs: changed; skills/src/tools/mod.rs: changed; skills/src/tools/read.rs: changed; skills/src/world_state_catalogs.rs: changed; web-search/src/extension.rs: changed; web-search/src/tool.rs: changed; codex-rs/hooks/src: bin/write_hooks_schema_fixtures.rs: changed; codex-rs/core/src/tasks/user_shell.rs: the file's code; codex-rs/features/src/lib.rs: the file's code; codex-rs/app-server/src/message_processor.rs: the file's code; codex-rs/core-plugins/src/manager.rs: the file's code; codex-rs/app-server/src/thread_sample.rs: the file's code; codex-rs/app-server/src/request_processors/thread_processor.rs: the file's code; codex-rs/core/src/session/mod.rs: the file's code; codex-rs/core/src/session/world_state.rs: the file's code; codex-rs/core/src/session/reasoning_effort.rs: the file's code; codex-rs/core/src/client.rs: the file's code; codex-rs/network-proxy/src: config.rs: changed; connect_policy.rs: changed; domain_matcher.rs: changed; http_proxy.rs: changed; lib.rs: changed; mitm.rs: changed; network_policy.rs: changed; policy.rs: changed; proxy.rs: changed; proxy/execution_scope.rs: changed; runtime.rs: changed; socks5.rs: changed; tcp_upstream.rs: new; codex-rs/app-server/src/request_processors/thread_queue_processor.rs: the file's code; codex-rs/app-server/src/request_processors/daemon_continuation.rs: the file's code; codex-rs/core/src/session/turn_input.rs: the file's code; callers of \b\w*(?:_if_idle|IfIdle)\w*\b|\bcontinue_daemon_turn\b|\bsubmit_turn_input_with_mode\b: codex-rs/app-server-client/src/cloud_backend/mod.rs: new caller; `cloud :: SubmissionMode :: StartIfIdle`; `cloud :: SubmissionMode :: StartIfIdle`; codex-rs/app-server-client/src/cloud_backend/requests.rs: new caller; `mode : cloud :: SubmissionMode :: StartIfIdle`; codex-rs/cloud-client/src/turns.rs: new caller; `StartIfIdle`; `SubmissionMode :: StartIfIdle => 3`; codex-rs/ext/goal/src/runtime.rs: `match thread . start_turn_if_idle ( request . on_start ( TurnStartOptions`; codex-rs/ext/queue/src/service.rs: `let submission = thread . start_turn_if_idle ( TurnInputRequest :: new ( input ) . with_responses_metadata ( item . responsesapi_client_metadata ) . with_trace `; `match thread . start_turn_if_idle ( TurnInputRequest :: new ( item . input ) . with_responses_metadata ( item . responsesapi_client_metadata ) . on_start ( Turn`; codex-rs/code-mode-runtime/src/runtime/globals.rs: the file's code. Merging the watcher's PR accepts it after reading the diff.

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
| stage2 | Stage 2's qualification ([design](../codex-confinement-design.md) §7.2; [escalation WP6](../qualification/escalation-wp6.md)), model-free: items 1-30, below. No login. Public and hour-long controls require explicit opt-in. | Passed. |
| daybreak-nomodel | Daybreak on, no model named: OK, with relay's note that the model is unknown; Codex recorded `standard`. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |
| daybreak-exec | Daybreak on, the `codex exec` backend, the eligible model: OK and no note; Codex recorded `daybreak_blue`. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |
| daybreak-unset | Daybreak unset, the eligible model: OK and no note; Codex recorded no access program relay set. | **not run**: no Codex credential is set as a repository secret (CODEX_ACCESS_TOKEN or OPENAI_API_KEY). |

## Stage 2 qualification

`scripts/codex-qualify/codex-stage2.mjs` (template and items: [codex-stage2-template.md](codex-stage2-template.md)): a fake Responses API on loopback, scratch Codex and relay homes, this run's own listeners; each item's `codex` part against this release under relay's stage-2 profile and flags, its `control` where the same calls must escape, its `relay` part through relay's own stage-2 path. Overall: **passed**; relay's stage-2 path: present.

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
| 28 | mediated DNS, aliases, teardown, bypass and credentials | Passed. |
| 29 | local refusal, interlock and Claude/ACP never proxies | Passed. |
| 30 | MCP result delivered exactly once beyond the former 3600-second timeout (opt-in hour-long probe) | Passed. |
| 31 | standing network: stage2 routing, never hosts, proxy variables, refusal and resume | Passed. |
| 32 | IPv4 localhost connect: disclosed LAN/tailnet scope, never and other-port denial | Passed. |
| 33 | the keychain under the never floor: a decoy keychain item is refused to floored native Codex turns, and its control without the file deny matches doctor's documented keychain IPC | Passed. |

## How this record was made

The scheduled qualifier on the maintainer's Mac ran stage 2 against 0.170.0 at 2026-11-18T05:15Z, from its stale checkout (`6089a24`, schema `stage2-v3`). Almost every item failed, and the cause was relay's own readback refusing to start Codex: eight features on that relay had not qualified, the model tool `send_message_to_user_async`, and the isolate global `content`. Its pin store was not touched. This record is a qualification by hand, not one by the watcher. The steps:
- the watcher's static step: `sourceCheck("0.167.2", "0.170.0")` in the maintainer's release watcher (not published);
- its no-login live cases: `codex-live.mjs` with `RELAY_WATCH_CASES=sandbox,config`;
- stage 2 in full: `codex-stage2.mjs` with `--old-bin` (npm's 0.163.0), `--source` (`codex-rs` at `rust-v0.170.0`), `RELAY_TEST_PUBLIC_NET=1` and `RELAY_TEST_ESCALATION_LONG=1`.

Everything ran from a frozen worktree of this branch, in a scratch HOME and TMPDIR under `/tmp/s2q170`. The sections above were rendered by `codexRecord` in `records.mjs`. The verdict, item by item, is in [codex-stage2-0.170.0.md](codex-stage2-0.170.0.md).

## Source review (rust-v0.167.2..rust-v0.170.0)

44 of the 80 watched entries differ. `rust-v0.170.0` is one squashed commit on top of 0.167.2 (29eb79e986), so no change can be traced to an upstream PR. Every entry that differs was read against 0.167.2 by surface, and the callers outside the watched files were followed where it mattered. Nothing found loosens relay's confinement on either route. Line numbers are at `rust-v0.170.0`, under `codex-rs/`.

**Sandbox and network (native route).**
- `sandboxing/src/seatbelt.rs` (`create_seatbelt_command_args*`): profiles now resolve through `FileSystemSandboxPolicy::resolve_for_enforcement(cwd, PreserveMutableRoots)`, using the same root helpers.
  - Unchanged: every `.sbpl` file, the escaping of writable roots (so relay's refusal of `"`, tab and newline in root names stands), and the protected-name regex. Also unchanged: the proxy ports, the Unix-socket and dynamic network policy, and the daemon-socket and fcntl denies.
  - `create_seatbelt_command_args` is now test-only.
  - A new `ProcessWithInheritedTerminal` profile is used only by `codex sandbox`.
  - One narrowing that does not affect relay: a metadata name under a writable root is now protected only if every alias of its path is also unwritable. That differs only where a write is granted on an aliased spelling of a metadata path, and relay grants none.
- `network-proxy/src/*`, including `evaluate_host_policy` and `connect_policy.rs`: tightened.
  - `is_non_public_ip` and its helpers are byte-identical, so relay's port (`codexNonPublicIp`) needs no change.
  - Deny rules now also match equivalent IP spellings (`numeric_host_address`).
  - A new `resolved_target_blocked` applies IP deny rules to the connected address.
  - `allows_non_public_target` uses the admission's dial policy instead of assuming approval. An approval still cannot pass a deny or the non-public refusal.
  - `tcp_upstream.rs` is new and dormant: nothing outside its tests calls `set_tcp_upstream_proxy`.
- `core/src/tools/sandboxing.rs`, `network_approval.rs`, `protocol/src/permissions.rs`, `access_programs.rs`: refactors, plus bookkeeping that tracks whether remote network decisions have drained, and a saved Daybreak choice for helper agents. No grant is widened.

**Executor and environments (stage 2).**
- `exec-server/src/environment.rs`: adds `remove_environment`, called only by tests. `normalize_exec_server_url` still maps `none` to no `local` and no default (`environment_provider.rs`, identical).
- `remote.rs`, `exec-server-cli/src/{command,config}.rs`: a ChatGPT-token registry auth mode and stdin credentials, all behind `--remote` (`requires = "exec_server_remote"`). Relay's `--listen ws://127.0.0.1:P --ws-auth capability-token --ws-token-sha256 H` path is unchanged, and so are `websocket-auth` and the server transport.
- `local_process.rs`, `session_registry.rs`: exited-process retention is now configurable, and a detached session lives 80 s instead of 30 s. Its processes stay in the executor, inside relay's Seatbelt, and relay's teardown kills the executor's process group regardless.
- `core/src/unified_exec/process_manager.rs`: the choice between `env_for` and `env_for_exec_server` moved to `tools/runtimes/unified_exec.rs`. The functions that build a command's environment are textually identical. Item 20 (C6) checks live that `RELAY_BROKER_TOKEN` and its value reach no command.
- `spec_plan.rs`:
  - Model search only removes tools.
  - `request_user_input` and `send_message_to_user_async` are now restricted to root turns.
  - Code mode's `exec_definitions` need `incremental_exec_tools` (under development, off).
  - No other new tool.
- `multi_agents/spawn.rs`: subagents still inherit `step_context.inherited_environments`.
- New experimental `thread/settings/update` and `turn/settings/update` environment fields, and `thread/prepareApprovedPlan`: client-sent only, and relay sends none of them.

**MCP and the broker (stage 2).**
- `codex-mcp` mod.rs, runtime.rs, rmcp_client.rs, tool_catalog.rs, `rmcp-client`, `mcp_types.rs`, `session/mcp.rs`, `mcp_skill_dependencies.rs`, `mcp_tool_call.rs`:
  - Servers are keyed by `McpServerKey`. In the default Legacy exposure there is still one server per name.
  - `resolve_server_environment` is byte-identical: local HTTP uses the app server's client, and stdio still needs `local`.
  - The bearer-token branch is unchanged, and so is the retry, still limited to `tools/list`. `outbound_proxy.rs` and its use sites are identical.
  - Auth headers are now resolved per request, and trace headers are added.
  - `mcp_types.rs` adds a method but no config key, so `stage2BrokerConfigProblem` is unaffected.
  - New MCP features (`mcp_lazy_stdio_startup`, `multi_environment_mcp`, `agent_message_board_mcp`): all under development and off by default. Relay's readback refuses each if a layer turns it on.
- `core/src/config/mod.rs`: permission resolution moved to `codex_config::resolve_permission_config`, and a session `default_permissions` still wins. The subagent limit and its alias are unchanged.

**Extensions, hooks and plugins.**
- `ext/`:
  - No new extension crate.
  - The agent message board gains an HTTP MCP backend that would bind a loopback listener in the app server. It needs both `agent_message_board_mcp` and `multi_agent_v2` (off by default). Neither is allowlisted, so the readback refuses it.
  - Goals: the objective now travels as untrusted context. The continuation still goes through `start_turn_if_idle`, gated by `features.goals`, which relay pins off.
  - Skills, web search, history notes, guardian and image generation: refactors, or new gates that default off.
- `hooks/src`: only `bin/write_hooks_schema_fixtures.rs`, a development tool.
- `core-plugins/src/manager.rs`, `app-server/src/message_processor.rs`:
  - Prefetch is removed.
  - Every plugin startup task stays inside `if config.plugins_enabled`, and recommendations also need `apps`. Relay pins `plugins`, `remote_plugin` and `apps` off.
  - New client requests (`ModelProviderList`, `ModelProviderConfigWrite`, `ThreadPrepareApprovedPlan`, `GetAccountSecuritySetup`) act only when a client sends them.

**Turns Codex starts by itself (WP-C).**
- `callers`: the only new start-if-idle callers are in `app-server-client/src/cloud_backend` and `cloud-client`. The `codex-app-server` crate depends on neither; only the CLI, exec and TUI do.
- `thread_queue_processor.rs`: carries Responses metadata, with the same `start_turn_if_idle` path.
- `daemon_continuation.rs`: still needs `local` as the thread's only environment, so it never fires under stage 2.
- `turn_input.rs`:
  - An agent-message start-or-steer path is reachable only through inter-agent input, never through the app server's `turn/start`.
  - `reserve_pending_work_turn` is stricter.
  - Self-started turns take the thread's configured environments, with no fallback.
- `session/mod.rs`: a "host" agent runtime that suppresses `turn_started` is enabled only by a test fixture.
- `reasoning_effort.rs`, `client.rs`: effort plumbing unchanged (item 10's effort part checks it).
- `thread_sample.rs`, `thread_processor.rs`: client-driven only. No change to environments on start or resume.

**Code mode.** `globals.rs`: the new `content` helper (below). The host's gRPC transport is behind `code_mode_host_grpc` (below).

## Decisions

| What | 0.170.0 | Decision | Why |
|---|---|---|---|
| `code_mode_host_grpc` | stable, on | **pinned off** from 0.170.0 | Picks the gRPC host provider: the same unsandboxed host binary over its stdio. Only the wire protocol and session recovery differ (teardown checked below). No confinement reason to refuse it; pinned off for parity with 0.167.2 until a qualification runs with it on. |
| `code_mode_host_output_truncation` | stable, on | **pinned off** | Truncates `exec` output in the host rather than the client. Model-visible only. |
| `guardian_include_additional_context` | new, stable, on | **pinned off** | Guardian review history only. Relay answers approvals itself. |
| `incremental_tools_legacy` | stable, off → on | **pinned off** | Read only for the Amazon Bedrock providers, like the `gcp` key relay already pins off. |
| `incremental_tools_legacy_gcp` | stable, on | pinned off (since 0.167.2, a private PR) | Already on `main`; the qualifier's stale checkout lacked it. |
| `retain_client_tool_outputs` | stable, on | **pinned off** | Compaction retention. |
| `unified_image_budget` | stable, on | **pinned off** | Image preparation budget. |
| `untrusted_as_tool_output` | stable, on | **pinned off** | Renders untrusted additional context as a tool output. Relay sends none and pins goals off, so it is inert. Off keeps 0.167.2's form. |
| `plugin_discovery_prefetch` | removed | pin kept | Config ignores it and the list reports it off, so the pin reads back unchanged. |
| tool `send_message_to_user_async` | catalog-forced on root turns | **admitted** to `STAGE2_TOOLS` | The feature cannot remove it: the model's `experimental_supported_tools` adds it. Its handler emits one agent-message item and returns `{"accepted":true}`, with no file, process or network access. Relay keeps the last completed agent message as the job's result, so at worst an async note becomes the result. |
| isolate global `content` | new | **admitted** to `ISOLATE_GLOBALS` | Emits MCP-shaped text or inline media as `exec` output, as `text`, `image` and `audio` do. It refuses file references (`value.rs` `mcp_output_item`). Item 10 confirms there is no new Node, file or network binding. |

Pinning off the newly default-on features was chosen over admitting them. Relay needs none of them, and off is 0.167.2's qualified behaviour. Each would otherwise have to be shown safe on its own.

### `code_mode_host_grpc` and teardown (checked 2026-11-18)

Before deciding, the reviewer suspected that the gRPC host's own process group (`code_mode_host.rs`, `process_group(0)`) would let it escape relay's group kill. The source and a live check show it makes no difference:
- **Both hosts are outside the group.** The process-owned host already runs in a group of its own: `code-mode/src/remote_session/connection.rs`, `process_group(0)`, unchanged since 0.167.2. Relay's group kill reaches neither.
- **Relay stops the host anyway.** `watchProcess` records the app server's descendants during the turn, and teardown stops them directly (`codex-app.ts`, `stopProcs(watch.procs())`).

The live check: a scratch 0.170.0 app server, spawned detached as relay spawns it, with a model-written `exec` cell busy-looping at about 100% CPU. Then two teardowns:
- relay's group SIGTERM, then SIGKILL two seconds later;
- a SIGKILL of the app server alone, as in a crash.

| Host | Own process group | Group TERM→KILL | App server killed alone |
|---|---|---|---|
| gRPC (`code_mode_host_grpc=true`) | yes | gone 2.0 s after the TERM, when the KILL took the app server | gone ≤ 0.25 s |
| process-owned (`=false`) | yes | gone 2.0 s after the TERM, as above | gone ≤ 0.25 s |

Each host exits when it loses the app server (its stdin), even mid-cell, and relay also stops it directly. Only the wire protocol and session recovery differ between them. The pin keeps 0.167.2's provider for parity. Admitting the gRPC host needs only a qualification run with it on.

## Harness changes

0.170.0 blinded two controls; it did not break any confinement:
- **Item 11.** In the scheduled run, the goal and no-local goal cases reported "cannot tell" (`selfStarted 1, goalAsked 0`). The goal's own turn did start, but 0.170 sends its objective as untrusted additional context: a `function_call_output` with no `call_id`, in namespace `agent`, not a message. The fake model routed only on messages. It now routes on that output too (`messageList`).
- **Item 12.** The positive control failed because 0.170 no longer requests `ps/plugins/list` or `plugins/featured` at startup: prefetch was removed upstream. From 0.170.0 it requires the startup discovery that remains with plugins on, authenticated `ps/plugins/installed` and `ps/plugins/suggested/codex` (`pluginDiscoveryPaths`). The negatives are as wide as before, and now wider: they also count any request to the plugin service (`/backend-api/ps/`). With plugins on, 0.170 also POSTs `ps/mcp`, which has no `plugins` segment. That was found while reviewing this change and fixed after the run. Re-judging the recorded relay-flag traffic of this run and of 0.167.2's with the wider predicate still finds no discovery: under relay's pins, 0.170 sent the fake service only an account check, user settings and analytics, as 0.166 did.

The scheduled run's other failures were knock-ons of the refusal. Every relay part, items 23–32's suites through relay's Codex path, and item 22's eighth session (the threadless readback) stopped at the readback. The run above shows them all passing once the refusal is gone.

## Not covered, and open

- **Signed-in cases: not run.** Codex was not signed in, so read-pong, write-job, write-job-resume, case-alias and the five daybreak cases did not run. Relay's Codex home (`~/.local/share/relay-codex-home`) holds a ChatGPT sign-in, and copying it into scratch would let Codex rotate its refresh token there. As for 0.167.2, these cases need a run by hand in the maintainer's own session.
- **Executor-side MCP discovery (pre-existing, not new in 0.170.0).** For a remote turn environment, such as relay's executor, `core/src/session/mcp_runtime.rs` asks the executor for HTTP MCP servers in its own config layers: its `CODEX_HOME`, system config, and project layers at the cwd (`exec-server/src/environment_config.rs`, `discover_http_mcp_servers`). It registers any `url` server whose name is not already registered, bound to the executor's environment. That file is identical to 0.167.2, and `mcp_runtime.rs` only moved code in this release. Such a server's HTTP goes through the executor's own client, inside relay's Seatbelt, so it is not an escape. But its tools would reach the model outside `STAGE2_TOOLS`, and relay's docs do not cover this path. It was not tested live. Relay's executor has a scratch `CODEX_HOME`, so whether a repository's `.codex/config.toml` or `/etc/codex/config.toml` is read there is plausible, not verified. To settle it: a live turn with a repository `.codex/config.toml` declaring a `url` server. Then either refuse such turns or keep the executor from reading config. `mcp_runtime.rs` and `environment_config.rs` are not in `STAGE2_SOURCE`.
- **Watch next release.** `core/src/config/network_proxy_spec.rs` carries an unused `mcp_network_policy` (`expect(dead_code, reason = "used by the next PR")`) that will route MCP calls through the network proxy. Session `turn_started` suppression for a "host" agent runtime (`session/mod.rs`) is enabled by no app-server path today.
