# Codex CLI 0.167.0: checked by the release watcher

Checked on 2026-11-08 by the maintainer's release watcher (not published) on the maintainer's release-watcher Mac (macOS 27.2), with relay at a private commit plus 0.167.0 in `VERIFIED.codexCli`. The checks are those of the hand check of 0.164.0 (the maintainer's notes, 2026-10-23). `tested` stays the floor relay was qualified at; this records only that relay's Codex route was checked on 0.167.0.

## Source

`rust-v0.167.0` against `rust-v0.164.0` in github.com/openai/codex, by `SOURCE` in the maintainer's release watcher (not published): whole files token by token (comments and layout aside), the permission and sandbox code of `core/src/config/mod.rs`, and the app-server protocol's fields relay sends and reads.

**It differs:** codex-rs/models-manager/src/cache.rs: the file's code; codex-rs/protocol/src/approvals.rs: enum ExecApprovalKind: changed; codex-rs/network-proxy/src/connect_policy.rs: the file's code; codex-rs/core/src/tools/network_approval.rs: the file's code; codex-rs/core/src/tools/sandboxing.rs: the file's code; codex-rs/core/src/exec_policy.rs: fn load_exec_policy: changed; codex-rs/exec-server/src/environment.rs: the file's code; could not compare Codex's source on GitHub: rust-v0.167.0/codex-rs/cli/src/exec_server_command.rs: HTTP 404. Merging the watcher's PR accepts it after reading the diff.

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

Hand checks for two 0.167.0 changes relay cannot test live (human-only approvals, network approval queueing): [codex-0.167.0-hand-checks.md](codex-0.167.0-hand-checks.md).
