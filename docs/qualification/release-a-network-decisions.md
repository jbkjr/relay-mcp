# Release A network owner decisions

Base: a private commit. Implementation: a relay job's branch.

Standing non-raw Codex network grants now select stage 2 whenever it is enabled,
including `child_network`, kept grants on resume and read turns. The existing
mediated provider qualifies and prepares the turn; its existing teardown closes
the proxy after the executor. It leases the proxy port for standing grants too.
An overlay preserves that mediated baseline and adds only its approved capability.
Raw/local substitution is refused. Qualification failures refuse launch rather
than reverting to native strict or raw network. Stage 2 off keeps the released
native route only when the effective never policy is enforceable there; native
network turns with user `never.hosts` or unenforceable TCP `never.ports` entries
are refused.

Hosted web search still runs at OpenAI and stays live with a network grant unless
`never.hosts` disables it, with effective disabled readback. It does not traverse
the executor proxy. Read jobs now get mediated shell network too, with read-only
filesystem policy. The native `strict` note remains accurate for the stage-2-off
route; stage-2 mediated turns have their own result/input note, and doctor now
describes both routes. No Go/Swift TLS for these jobs until Release B; trust remains
off. Tools that ignore proxy variables fail closed.

Approved IPv4 localhost connects compile to Seatbelt's `localhost:P`, including
port P on this Mac's LAN and tailnet addresses. They override the listening-snapshot
deny for that port, before reserved-port and final never/control denies. They never
override the static service deny (22, 1025, 1143, 8787, 11143, 5900, 3283, 3031,
445, 548 and 631), including when a built-in service rule was removed. Admission
and launch revalidation refuse those ports, protected ports, IPv6 and connects with `never.hosts`; a direct allow cannot
screen forbidden DNS endpoints. Requests, receipts and results disclose the wider
scope, including failed/cancelled accounting. Service API effects retain the existing
authority rule: owning supervisor only for clearly authorized work, otherwise person.
No per-turn proxy token was added.

The reserved port block is no longer bindable merely because stage 2 is selected.
Ordinary no-network and mediated fresh or resumed turns keep the block reserved
and under the final relay-range deny and do not advertise `PORT`/`PORTS`; only
person-consented raw network, an explicit listen overlay, or a port-0 overlay
carves it out for bind/inbound and supplies those variables.
The executor's separate reserved port remains bindable, so Codex startup is unchanged.
Per-turn boundary probes cover loopback and wildcard block binding in both the open
and closed shapes.

Qualification and red-team share new items **31** (standing routing) and **32**
(IPv4 connects). The owned-upstream live fixture also fixes its final numeric-dial
mapping: `testing.resolve` is ignored when production `publicPolicy` supplies
addresses. The fixture now redirects only the already screened approved numeric
dial to its owned listener, preserving the production screening path.

All test fixtures normalize an inherited long TMPDIR once through `test/temp-root.ts`.
The probe cancellation test clears its polling interval in `finally`; an unexpected
setup/refusal assertion used to leave that timer alive indefinitely. Production
`probeBoundary` already cleaned up setup resources.

Validation in this delegated sandbox:

- Passed: `npx --offline tsc -p tsconfig.json`; 167 tests across decision/provider,
  overlay/profile, stage2 gates, adapter, escalation and release-watch suites;
  8 executor lifecycle/seam tests; 3 probe planner tests; 1 raw-consent text test.
  Total: **179 distinct focused tests passed**, with no skips in those selections.
- Failed/blocked: the new long-TMPDIR Unix-socket regression. An initial attempt
  could not create `/tmp` scratch directories; one supervisor-approved escalation
  passed directory setup, but the outer Relay sandbox still refused the Unix bind
  with `EPERM`. This is not a host pass. Early stale/new assertion failures in the
  implementation work were corrected and the affected suites rerun successfully.
- Skipped: the four new standing-network live cases under their default opt-in gate.
- Not run: the default-shell full suite, live Codex/kernel cases, full qualification
  and red-team host runs. These remain the lead's host gates; no release qualification
  is claimed by the focused unit results.

Exact host commands, from this checkout and outside an agent's outer sandbox:

```sh
npm run build
npx --offline tsc -p tsconfig.json
node --test --test-timeout=600000 --test-concurrency=1 test/*.test.ts
node --test --test-name-pattern='test guard: a long inherited TMPDIR' test/guard.test.ts

export RELAY_TEST_CODEX=/absolute/path/to/pinned/codex
RELAY_TEST_STANDING_LIVE=1 node --test --test-concurrency=1 --test-timeout=240000 test/stage2-standing-live.test.ts
RELAY_TEST_STAGE2_LIVE=1 node --test --test-name-pattern='live worker:.*connect result' test/stage2-escalation-live.test.ts
RELAY_TEST_STAGE2_LIVE=1 node --test test/restart-overlay-live.test.ts
node --test --test-name-pattern='^stage-2 overlay live controls:' test/stage2-probe.test.ts
RELAY_TEST_MEDIATED_LIVE=1 node --test --test-name-pattern='live worker:.*mediated result' test/stage2-escalation-live.test.ts

node scripts/release-watch/codex-stage2.mjs "$PWD" /tmp/s2q-owner-decisions 0.164.0 "$RELAY_TEST_CODEX" --items 31,32
node experiments/stage2-redteam/run-escalation.mjs --unit
```

The final command checks the shared unit parts only and deliberately leaves host and
known missing integrated evidence incomplete. Do not interpret its overall non-pass
as successful qualification or as a replacement for the host commands above.
