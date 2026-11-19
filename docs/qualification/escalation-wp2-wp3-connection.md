# WP2/WP3 connection receipt

Base: a private commit. Branch: a relay job's branch. Relay creates the branch commit when
the delegated job returns; the delegated-job preamble explicitly assigns committing to relay.

## Connected path

`codex-app.ts` supplies the native thread/turn IDs after `guard.replied`, before readback retries.
`codex-env.ts` registers the production runtime before arming the broker and unregisters after
broker/executor teardown. Only the existing checked stage-2 executor path registers it.
`escalation-runtime.ts` maps typed capabilities to WP2, checks provider availability before any
prompt, and creates a durable requested record bound to WP3's canonical digest. Root identity
and token-version bindings are hashes; no bearer token enters either record.

`approvals.ts` authenticates the existing `required_decider` route, then allows/denies WP2 in the
same `BEGIN IMMEDIATE` transaction as WP3's terminal decision. The owning escalation can finish
its receipt while WP2's closing gate refuses other work. The request handler returns without
consuming or waiting for the replacement.

The HTTP SDK queues bytes before its `send()` resolves. `SessionGate` now binds escalation
request IDs to the actual Node HTTP response and awaits `finish`; premature `close`/`error`,
missing response bindings, cancellation or failed sends cannot acknowledge a receipt. This is
transport-write evidence, not evidence that the model read it. A missing/failed/cancelled
receipt invalidates the pending record. A second acknowledgement or decision cannot replay it.

WP2's existing session path interrupts the origin, waits for `handle.done` and verified teardown,
assigns the destination, consumes once, arms its timer, and launches with `TurnSpec.overlay`.
Assignment and consumption now recheck WP3's stored decision, receipt, root/session ownership,
grant, policy, pins and expiry. Prelaunch gates repeat authority validation. Pending records
also require the original worker PID/start identity; a replacement worker cannot recover them
as launch work. Consumption still persists the monotonic/recovery deadlines before releasing
launch work. Asking during an overlay carries its existing deadline into the runtime snapshot;
neither requests nor approval pauses renew it. Durable stopping state cancels destination work.

WP2 state saves call WP3 accounting in the same transaction, including recovery/teardown paths.
They retain destination, actual validated launch, completed/failed/cancelled/expired/tainted
outcome, cleanup evidence, captured baseline grant and approved additions in `effective_scope`.
Known survivor IDs propagate to `cleanup: survivors`; uncertainty stays uncertain. Port-0
requests, receipts and accounting keep the 0.0.0.0/LAN disclosure without claiming that approval
alone exposed a listener. `escalation-state.ts` holds the lower-level authority/accounting
functions to avoid pulling the broker/approval stack into WP2's recovery module.

## Capability boundary

Raw remains person-only and refused with any `never.hosts` entry. A mediated provider is planned
for this release in a separate later job; no provider implementation is included here. The
single provider point is `src/core/mediated-network-provider.ts`: `mediatedNetworkProvider()`
supplies its `qualify` and `prepare` hooks. WP3 qualification and WP2's request, decision,
consumption and launch gates call `mediatedNetworkProblem`; the stage-2 executor calls the same
provider's `prepare` to obtain network policy/environment additions and closes its resources
after executor teardown. Without a provider, the message is exactly "no qualified mediated
provider is available". No raw fallback is allowed. Provider teardown failures propagate
uncertain cleanup rather than verified teardown. The later provider job owns its qualified
implementation and recovery of its resources; no proxy is built in this connection job.

Local remains unavailable. WP2's localhost provider is IPv4 only; IPv6 and read-to-write access
changes are withheld before prompting.

A job with standing `grant.network: true` and no raw grant does **not** take the stage-2 executor
path: `stage2Wanted` is false. With stage 2 enabled in config it continues on the existing native
strict/proxied path; its `escalate` returns `capability_unavailable` because no qualified runtime
is registered. Preserving a non-raw baseline at the adapter/WP2/executor seam uses the mediated
provider point and currently refuses because it has no implementation. The later provider job
can fill that point and qualify broader admission. Such a baseline is never silently converted
to raw or stripped of network.

## Disposition of the reported failures

| Failure | Disposition |
| --- | --- |
| Guard: two escalation tests omit helpers | Tests wrong: load `helpers.ts`, which loads the isolated process HOME before relay imports. |
| Three overlay write-root failures | Fixture wrong: canonicalize the `mkdtemp` root using `realpathSync`, preserving strict canonical-root enforcement and the read-job refusal. `/tmp` aliases `/private/tmp` on macOS. |
| Extensions unit: 7500 vs 11400 | Test wrong: retain WP3's intentional timeout formula; assert 11400, 18600 and 7500 for default, 7200-second and 60-second approval timeouts respectively. |
| Extensions integration at test declaration near 296 | Same stale 7500-second assertion later in its Codex branch; updated to 11400. The consent/security assertions are unchanged. The complete integration test still needs the host. |
| Raw-turn local-mode wording | Code wording regressed: retain the original clear raw-turn explanation, also mention overlays. Preserve the job-specific fail-closed diagnostic for malformed captured grants. Update WP2's assertion to require the clearer wording and exact conflicting job. |
| Long default TMPDIR / Unix sockets | Harness wrong: `process-home.ts`, imported by helpers, chooses a short owned disposable HOME if the canonical default temp path would overflow Darwin's 103-byte socket limit. The guard checks that selected temp parent and retains its real-home/installation exclusions. No blanket temp allowance was added. |

Production can also hit this socket limit with a sufficiently long canonical HOME: private
probe sockets remain under `$HOME/.relay-t/s/relay-probe-XXXXXX/relay.sock`. Ordinary short homes
fit. This change fixes test HOME selection; it does not introduce a production socket alias or
change production HOME policy.

## Validation and host commands

Passed:

- `npx --offline tsc -p tsconfig.json` and `git diff --check`.
- `node --test --test-concurrency=1 test/stage2-escalation.test.ts test/restart-overlay.test.ts test/approvals.test.ts test/broker-http.test.ts test/restart-overlay-profile.test.ts test/stage2-gates.test.ts`: **121 passed, zero failed, two skipped**.
- `node --test --test-name-pattern='^BB:' test/stage2-executor.test.ts`: **8 passed**; includes actual production runtime registration/unregistration, mediated-provider preparation/teardown routing, refusal of raw substitution, and uncertain-provider-cleanup accounting using fake executor/broker dependencies.
- The extensions timeout unit case and helper-loading guard case: **one passed each**.
- The filtered stage2 grant/consent/interlock unit cases: **10 passed**.

Failed in this sandbox:

- The exact requested five-file command: **75 passed, 11 failed**. Two guard failures correctly
  refuse this sandbox's TMPDIR under the real home. Eight tests require denied `/Users/Shared`
  fixture creation. One executor-record test cannot read the current process's start identity.
  The remaining failures do not reproduce the lead's original functional failures. The source
  assertions were retained; this run is not host qualification.

Skipped:

- Two broker HTTP kernel integrations skip after loopback availability returns EPERM.
- Both opt-in escalation live tests skip without their explicit environment flags.

Not run:

- Full extensions integration, default macOS TMPDIR execution, native build helper and real
  Codex/Seatbelt host execution. The live worker test is implemented but not claimed passing.
- Full suite, WP4 extensions and WP6 qualification/red-team.

Live tests remain opt-in; no model endpoint, credential store or prohibited service port is
contacted by the skipped tests.

Run on the host from this branch, with the normal macOS TMPDIR (do not shorten it):

```sh
export TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)"
npm run build
npm run typecheck
node --test --test-concurrency=1 test/stage2-escalation.test.ts test/restart-overlay.test.ts test/guard.test.ts test/stage2-grant.test.ts test/approvals.test.ts
node --test --test-concurrency=1 test/extensions.test.ts test/broker-http.test.ts test/restart-overlay-profile.test.ts test/stage2-gates.test.ts
node --test --test-name-pattern='^BB:' test/stage2-executor.test.ts
RELAY_TEST_ESCALATION_HTTP=1 RELAY_TEST_STAGE2_LIVE=1 node --test --test-concurrency=1 test/stage2-escalation-live.test.ts
RELAY_TEST_STAGE2_LIVE=1 node --test test/restart-overlay-live.test.ts
```

The live worker test uses `/opt/homebrew/bin/codex` by default and honors `RELAY_TEST_CODEX`
if the lead's qualified Codex binary is elsewhere.

The new live worker case drives `runSessionTurn` twice with real Codex and a synthetic Responses
model on an owned high port. It approves the real request, requires the transport receipt,
checks that the old executor is gone, selects the worker-created destination, consumes via the
production session path, runs an actual wildcard port-0 bind under the overlay, and verifies
the final WP3 result/LAN/cleanup accounting and refusal of a second consume. It creates only
scratch credentials for its owned stub model. It is added but unrun in the delegated sandbox;
host execution must establish whether it passes. Broader direct/code-mode timeout, red-team,
and other WP6 qualification remain with the lead.
