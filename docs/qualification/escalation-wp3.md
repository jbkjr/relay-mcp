# WP3: tool, approval authority and accounting

WP3 targets a private commit and the confirmed design `d_516f2cd5`.
Its production overlay provider is now connected through the trusted stage-2 worker lifecycle;
see [the connection receipt](escalation-wp2-wp3-connection.md) for implementation, test boundaries
and host commands. No tool can select a profile, destination turn, decision principal or standing grant.

## WP2 integration seam

`src/core/escalation-contract.ts` is the single type definition:

1. The worker registers `registerEscalationRuntime(nodeId, turnId, runtime)` before serving the
   live child. `snapshot()` supplies checked native identities, base-policy hash, launch-plan
   identity and a finite remaining overlay budget/deadline. WP3 derives run/node/turn/access,
   captured grant digest and owning-root session binding from the registry.
2. `qualify(capabilities, never)` admits only compiler/provider combinations WP2 actually
   supports. In particular localhost never means broad outbound network, port-0 only adds
   TCP bind/inbound, and the provider must preserve final never/control/snapshot restrictions.
3. `request(ApprovedEscalation, signal)` durably stores the pending continuation and closing
   state, then immediately returns `restart_pending`. It must not launch, consume, execute a
   command, or wait for the destination. The old app server must be dead before replacement.
4. The broker's actual transport write invokes `receipt(approval, delivered)` exactly once.
   Failed/cancelled delivery invalidates pending state. This is separate from handler return.
   A successful write is delivery evidence, not proof the model read it or that an overlay ran.
5. Before consumption, WP2 calls `checkpointNever(runId, "launch")` outside its transaction.
   Inside the transaction assigning/consuming the destination, call
   `assertEscalationConsumable(requestId, digest, policy.hash)`. This rechecks the canonical
   request, delivered receipt, actual decision, root/session binding, source grant/access,
   roots/pins, policy floor and approval expiry. WP2 owns the atomic consume-once transition,
   destination binding, supervisor deadline arming and recovery deadline before launch.
6. WP2 records launch/failure/cancellation/teardown through
   `recordEscalationOutcome(requestId, outcome)`. Include destination turn, whether launched,
   actual effective scope and verified/uncertain/survivor cleanup. Never infer successful cleanup
   from completion. Dispose the runtime after teardown.

`codex-app.ts` passes the checked native identities into `codex-env.ts` immediately before arming
the broker. `escalation-runtime.ts` prepares a WP2 record before prompting, and `approvals.ts`
allows that bound record in the authenticated terminal-decision transaction. WP2 rechecks WP3
authority at destination assignment, consumption and before launch, and records outcomes on
durable state transitions. A missing runtime/provider returns `capability_unavailable` before
approval. No unconfined fallback exists.

## Authority and compatibility

`escalation.port0_authority` is the single authority key: `supervisor` (default) or `person`.
The existing `escalation: true/false` form remains compatible; object form also accepts
`enabled: false`. These settings are captured with the run, like other non-never settings.
Supervisor means the authenticated owning run root; neither task text nor a reason is an
authorization classifier. Root approval means the root has checked the person's task.
Broad raw/local always requires a qualified person dialog/confirm. Existing extension and
environment person-only rules remain. An unavailable person path fails immediately.

The canonical digest binds every explicit capability, root identity pin, intended argv/script/cwd,
untrusted reason/continuation, deadline/budget, source native/MCP identity, captured access/grant,
never/base-policy hashes and required decider, plus a non-secret versioned root-token binding.
Tokens and known released secret values are rejected from request context. Decision validation
uses authenticated channel context; `decided_by` is explanatory text only.

Request views expose the full canonical object and digest; successful receipts and job/status
results retain actual decision provenance and scope. Port-0 approval and launched results contain
the explicit 0.0.0.0/LAN disclosure. Pending/unreported launch state never claims actual exposure,
baseline-only confinement or successful cleanup. Outside writes persist beyond the turn.

Codex's stdio and broker timeout now use
`ceil(max(3600, 2 * approval_timeout_s + 300) + 3600 + 300)` (11400 s at defaults).
Readback uses the same computed timeout. Values outside a conservative unsigned 32-bit range
refuse; the lead must qualify the complete budget with the pinned timeout parser and live calls.
The finite overlay deadline itself remains WP2's supervisor responsibility. Reinstalling upgrades
the previously shipped 3600 s registration; unrelated custom settings retain installer safeguards.

## Validation commands for the lead

Safe fake/unit checks, without native sandboxing or listeners:

```sh
npx --offline tsc -p tsconfig.json
node --test --test-concurrency=1 test/stage2-escalation.test.ts test/approvals.test.ts test/stage2-gates.test.ts
node --test --test-name-pattern='registered MCP tools' test/stable-surfaces.test.ts
node --test --test-name-pattern='README:|previous default timeout|pre-T3-marker|earlier form is replaced|user.s own settings' test/install.test.ts
```

Outside the delegated sandbox only:

```sh
npm run build
RELAY_TEST_ESCALATION_HTTP=1 node --test test/stage2-escalation-live.test.ts
node --test test/codex-shell-policy.test.ts test/stage2-executor.test.ts
RELAY_TEST_STAGE2_LIVE=1 RELAY_TEST_CODEX=/path/to/qualified/codex node --test test/stage2-executor-live.test.ts
```

The opt-in HTTP check exercises the real broker/kernel peer route with a fake model/lifecycle.
It creates owned high-port listeners and performs no overlay command. It does not qualify
Seatbelt, actual LAN exposure, restart ordering, consume-once state or deadline teardown.
After merging WP2, the lead must additionally qualify direct/code-mode calls spanning approval,
restart and results beyond the old timeout, loss/cancel at each handoff, real destination
consumption and deadline expiry, and the exact generated profiles with owned decoys. Include
failed/cancelled-after-launch LAN results. Do not contact real credential stores or ports
22, 1025, 1143, 8787, 11143 or 5900.

## Delegated verification receipt

TypeScript compilation and `git diff --check` passed. The final selected runs passed 54 tests:
24 WP3 fake/unit tests, 23 existing approval/stage-2 gate checks, two stable-surface/presence
checks, and five installer compatibility checks. The new live HTTP test was skipped.
The stable fixtures include the new config/tool schema and full approval/receipt/event/result.

An earlier broader invocation mistakenly selected host-dependent tests. It produced two
`/Users/Shared` filesystem-denial failures in shell-policy tests and ten executor-test failures:
three missing native sandbox-check helper failures, one survivor-test API mismatch
(`sweepTurnSurvivors(...).map is not a function`), and six unavailable scratch listener-range
failures. The survivor test's `finally` kills its created process IDs. These are not successful
live qualification evidence; they were not retried or escalated. The full suite was not run.
