# Codex CLI 0.167.1: checked by the release watcher

Checked on 2026-11-10 by the maintainer's release watcher (not published) on the maintainer's release-watcher Mac (macOS 27.2), with relay at a private commit plus 0.167.1 in `VERIFIED.codexCli`. The checks are those of the hand check of 0.164.0 (the maintainer's notes, 2026-10-23). `tested` stays the floor relay was qualified at; this records only that relay's Codex route was checked on 0.167.1.

## Source

`rust-v0.167.1` against `rust-v0.167.0` in github.com/openai/codex, by `SOURCE` in the maintainer's release watcher (not published): whole files token by token (comments and layout aside), the permission and sandbox code of `core/src/config/mod.rs`, and the app-server protocol's fields relay sends and reads.

**It differs:** could not compare Codex's source on GitHub: rust-v0.167.1/codex-rs/cli/src/exec_server_command.rs: HTTP 404. Merging the watcher's PR accepts it after reading the diff.

## Live checks

Codex was not signed in: the checks that need a login did not run. A scratch HOME, relay home and repository; relay's MCP server driven as a host would drive it.

| Case | What | Result |
|---|---|---|
| sandbox | Codex's own sandbox (`codex sandbox`) under relay's write profile: the worktree and a grant writable; `.claude`, `.gemini`, `.mcp.json`, `.codex`, `.agents` and `.git` at their top, `/tmp` and elsewhere not (and `.Claude`, on a case-insensitive disk); the read profile writes nothing. No login. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |
| config | relay's own checks of the app server's reports with relay's flags (MCP servers listed by `codex mcp list --json`): config/read (the profile selected and exactly relay's, the fast-mode pin, a shell_environment_policy relay can read), configRequirements/read and skills/list. No login. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |
| read-pong | An `ask` that replies PONG. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |
| write-job | A write `delegate`: `mkdir .claude` refused by the sandbox, `hello.txt` written to the job's worktree. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |
| write-job-resume | Its `resume` in the same Codex session: a second line appended, still no `.claude`. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |
| case-alias | A write `delegate`: `mkdir .Claude` (and a file in it) refused. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |
| daybreak-eligible | Daybreak on, a model the account's cache lists for daybreak_blue: OK and no note, also on a follow-up in the thread; Codex recorded `daybreak_blue` for both turns. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |
| daybreak-ineligible | Daybreak on, a model it does not list: OK, with relay's note that Daybreak was not applied; Codex recorded `standard`. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |
| stage2 | Stage 2's qualification ([design](../codex-confinement-design.md) §7.2; [escalation WP6](../qualification/escalation-wp6.md)), model-free: items 1-30, below. No login. Public and hour-long controls require explicit opt-in. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |
| daybreak-nomodel | Daybreak on, no model named: OK, with relay's note that the model is unknown; Codex recorded `standard`. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |
| daybreak-exec | Daybreak on, the `codex exec` backend, the eligible model: OK and no note; Codex recorded `daybreak_blue`. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |
| daybreak-unset | Daybreak unset, the eligible model: OK and no note; Codex recorded no access program relay set. | **not run**: live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. |

## Stage 2 qualification

Not run.

## Accepted by hand

The maintainer, 2026-11-10, by merging the watcher's PR. The "differs" above is not a difference in Codex: `codex-rs/cli/src/exec_server_command.rs` moved to `codex-rs/exec-server-cli/src/command.rs` (with its config loading split into `config.rs`) in openai/codex#57589, first released in 0.166.0, so the watcher's read of the old path returned 404 at both tags. The watcher now reads the new paths. `rust-v0.167.0...rust-v0.167.1` is 3 commits, none in `exec-server`, `exec-server-cli`, sandboxing or approvals:
- a feature `incremental_tools_legacy` (`features/src/lib.rs`: `Stage::UnderDevelopment`, `default_enabled: false`), for Amazon Bedrock providers only;
- incremental tools gated through `StepContext::incremental_tools_feature()` (`core/src/session/step_context.rs`, `world_state.rs`), which picks `IncrementalToolsLegacy` only for those providers;
- `WebSearch` kept declared top-level under incremental tools (`core/src/session/turn.rs`), and left out of the world-state tool section.

Stage 2's feature readback (`stage2Readback`, `src/backends/codex-stage2.ts`) refuses only a feature reported on that `STAGE2_FEATURES_ALLOWED_ON` lacks, so a new key reported off, as `incremental_tools_legacy` is by default, does not refuse a turn. The live checks did not run in CI (above), and both Macs stay pinned to Codex 0.167.0.
