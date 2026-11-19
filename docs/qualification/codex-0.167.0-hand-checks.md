# Codex CLI 0.167.0: hand checks for two changes relay's tests cannot reach live

From the review of the 0.166 → 0.167.0 source diff (2026-11-16). Its verdict: the 0.167.0 pin is
sound, with no blocker. It flagged two changes to pin with regression tests. Relay's side of both
is tested against the stub app server in `test/codex-network.test.ts` ("codex 0.167 (stub): …"),
which runs in the full suite. Codex's own side cannot be made to run reliably as an automated live
test against the release pin, for the reasons below, so each has a hand check here.

Codex source references are to `rust-v0.167.0` (`codex-rs/`).

## A. Human-only approvals (`HumanCommand`)

**The change.** A managed exec-policy rule with decision `prompt_user` now yields
`ExecApprovalRequirement::NeedsHumanApproval` (`core/src/exec_policy.rs`, the `Decision::PromptUser`
arm). It is sent as a command approval of kind `HumanCommand` (`protocol/src/approvals.rs`),
"a fresh human decision; automated and reusable approvals are invalid". The app server delivers
one only to a client that advertised the `requiredHumanApproval` initialize capability with the
experimental API (`app-server/src/request_processors/initialize_processor.rs`). Otherwise the
command is denied.

**Relay's side, tested.** Relay's `initialize` (`HELLO`, `src/backends/codex-app.ts`) does not
advertise `requiredHumanApproval`. The stub test records every `initialize` relay sends, on a fresh
and on a resumed turn, and fails if the capability appears. It caught the capability when it was
added to the built `HELLO`. A comment at `HELLO` says not to advertise it until relay enforces
person-only, one-time decisions.

**Why Codex's side is not automated.** `prompt_user` comes only from managed requirements: the
system `requirements.toml` (`/etc/codex/requirements.toml`), MDM managed preferences, or a cloud
requirements bundle (`config/src/loader/managed_requirements.rs`). A user `.rules` file cannot
produce it, since `Decision::parse` accepts only `allow`, `prompt` and `forbidden`. The scratch
overrides that could point Codex at a test file (`with_managed_config_path_for_tests`, the
`MANAGED_CONFIG_PATH` and `DISABLE_MANAGED_CONFIG` debug variables in `app-server/src/main.rs`) exist
only in debug builds. The release pin ignores them. So a live test would have to write the real
`/etc/codex` or MDM state, which no relay test may touch.

**Hand check** (on a throwaway macOS VM or a test account's Mac, never the maintainer's): as root, write
`/etc/codex/requirements.toml` with a `[rules]` prefix rule `{ pattern = [{ token = "touch" }],
decision = "prompt_user", justification = "hand check" }`. Then run a relay Codex write job (the
0.167.0 pin) whose agent runs `touch marker`, and resume it with the same request. Expected each
time:
- the command is denied;
- no `marker` appears;
- relay files no approval request;
- the turn ends without hanging.

Remove the file afterwards.

## B. Native network approval queueing

**The change.** Concurrent prompts for one host now queue behind the first
(`core/src/tools/network_approval.rs`, `PendingHostApprovalOwner::review_user_prompt`). A queued
prompt takes over when the first is decided, and inherits an allow-for-session. A request whose
execution was cancelled is withdrawn (`serverRequest/resolved`).

**Relay's side, tested.** Relay declines every request carrying a `networkApprovalContext`
(`autoDenial`). The stub test sends two concurrent requests for one blocked host. The first is
withdrawn by the server while the second waits. The test runs this on a fresh proxied turn and
again after a resume. It requires that:
- every answer relay gives is a decline (the one it sends after the withdrawal included);
- nobody is asked;
- both turns end.

**Why Codex's side is not automated.** On relay's route the queue cannot be reached. Relay's
proxied profile allows every host (`domains = { "*" = "allow" }`, `src/backends/codex.ts`) with
`allow_local_binding` off. In `network-proxy/src/runtime.rs` (`host_blocked_with_lookup`), every
host is then authorized. A loopback, private or non-public literal, or a name resolving to one, is
blocked as `NotAllowedLocal`. Only `NotAllowed` consults the decider that raises a network approval
(`network_policy.rs` `evaluate_host_policy`). Under relay's profile that arises only for a host
`Host::parse` rejects, an empty one. A live test of two requests to a blocked endpoint would
therefore see two immediate denials and no approval, queued or not. That is still worth knowing,
and it is the hand check below. But it does not exercise the queueing this change added.

**Hand check** (any Mac, scratch homes; the 0.167.0 pin): run a relay Codex write job with
`grant: { network: true }` whose agent runs, at once and twice in parallel,
`curl -sS --max-time 5 http://10.255.255.1/ & curl -sS --max-time 5 http://10.255.255.1/ & wait`.
Interrupt the first `curl` while the second runs. Resume the job and repeat. Expected each time:
- both requests are refused by Codex's proxy (`NotAllowedLocal`) with no connection made;
- no approval request reaches relay (the job's `blocked` and the registry's `requests` show none);
- both `curl`s exit;
- the turn ends.

If an approval does reach relay, relay's `autoDenial` must decline it ("a host Codex's network
proxy refused"), as the stub test pins.
