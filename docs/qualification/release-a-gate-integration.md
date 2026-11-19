# Release A gate integration at 7311fba

Branch: a relay job's branch, based on a private commit.
Test/harness changes only; no production fix. This receipt does **not** qualify Release A.
Host tests were deliberately not executed from the delegated sandbox.

## Red-team setup

`makeScratch` stages the supplied candidate with `stageQualificationPin`, including its
adjacent code-mode host, sealed manifest and scratch `current` link. It never selects or
updates the installed pin. The managed home and pin store both live under this run's root.
All synthetic configs explicitly select file authentication and a fake key.

Managed-home preparation overwrites config.toml in production. The black-box MCP harness
therefore copies the built distribution into scratch and installs the qualifier's existing
`setCodexHomeConfigForTests` seam there. Both the MCP entry point and detached workers use
that copy. The source production modules, real config, pin store and real Codex home are
unchanged. The scratch copy uses the checkout's dependency tree read-only.

The approval dialog is scripted by `lib/relay-client.mjs`: its SDK elicitation handler
returns accept/allow-for-job. `serverEnv` constructs a fresh environment, with no real
host messaging socket or SDK/desktop identity. Thus “allowed by the user in relay's approval
dialog” describes this harness client, not a request delivered to the maintainer. The unknown
launched family is expected: `core/families.ts` records the synthetic endpoint acceptance
(`codex_endpoint_override_config`) as a family doubt. Neither label proves confinement.
These are source-confirmed conclusions, not a new host-run observation.

Reports require a real model request and tool output, and fail on probe-hook exceptions.
Absence-only checks cannot print `[ok]` when setup failed. Hook exceptions are no longer
silently swallowed. The no-LAN case also cannot return a successful campaign result.
The staged binary/distribution's prelaunch file hashes distinguish immutable fixture bytes
from runtime token leaks; changed/missing fixture assets and new files remain failing evidence.

Host execution must still confirm that the candidate launches and every probe produces
its expected tool-output markers. No new 13/13 result is claimed here.

## Consent fixture

The holder/version repair remains intact. The test intentionally denies the original G1
raw-network turn, while G2 is queued. `outcome.settle` cancels queued turns when a turn
fails; expecting that queued G2 to finish was a fixture error, not lost consent.
The repaired test requires G1 failed, queued G2 cancelled and zero Codex starts, then
explicitly resumes under G2 and requires completion without a second raw-network question.
The existing pure consent snapshot test also passes. The MCP scenario still needs a host run.

## Integrated qualification cases

| Item | Required new host parts | Evidence checked |
|---|---|---|
| 23 | `freshResume`, `overlay` | Direct and code-mode catalogs, hostile hosted-search and provider open-page calls on fresh, kept-resumed and replacement turns; tool advertisements withhold both paths; both attempts return explicit unavailable-tool errors; zero non-model requests to the owned model stub. Exact `GET /v1/responses` websocket upgrades are counted separately, answered 404 and excluded from that last counter; all other methods/paths, including the owned decoy page, fail it. Each turn also executes a permitted command/proxy control. |
| 24 | `code`, `mismatch` | Code-mode broker escalation and replacement command; cancellation of a running code-mode replacement listener; real restart with an injected mismatched live app start identity, or a contradictory real thread/read environment reply. Receipt/consumption/no-replay and executor cleanup remain required. |
| 26 | `crash` | Actual worker SIGKILL while a mediated CONNECT tunnel to an owned upstream is live; real reap stops app/executor, closes the tunnel and retains uncertain app cleanup and proxy-port lease quarantine. |
| 28 | `crossJobCrash` | A second actual Codex executor must receive EPERM reaching the live victim proxy; unsandboxed owned controls work immediately before and after the attack. The same crash probe then checks teardown, retained lease and local interlock. |

These reuse `stage2-standing-live.test.ts`, `stage2-escalation-live.test.ts`, the existing
stub model/catalog and mediated command fixture. A small shared hostile-call fixture is
the only new helper. Identity/readback contradictions use existing code-only dependency
seams around real live processes/replies; they do not claim a naturally occurring Codex fault.
The qualifier manifest replaces those items' coverage placeholders with mandatory suites.
Missing, filtered-away, failed or skipped suites still cannot qualify a pin.

The owned stub can observe only requests sent to its local Responses endpoint. It cannot
observe hosted search performed inside a real provider, because no real provider is contacted.
The hosted-web path is therefore covered by the advertised-tool checks and by both scripted
calls returning explicit unavailable-tool outputs. The request counter is narrower evidence:
it catches any owned-decoy-path request that reaches the stub while excluding only the exact
Responses websocket handshake shape used for model transport.

Item **29** now has a mandatory host-only `nativeProfiles` suite. It launches the installed
Claude binary through the production backend against an owned scripted Anthropic Messages
stub, checks effective settings readback and actual Bash/Read/Edit and owned-listener outcomes,
and runs two scripted ACP-v1 turns through the production generic profile/proxy. The Claude
lane uses a fresh scratch HOME and an owned dummy key under target-local `child_auth: "any"`,
so it needs no provider login or quota. It does not qualify real model transport, provider
login, model selection or model behaviour. The ACP evidence qualifies Relay's side only,
not a vendor binary. Item **30 remains opt-in**, using the
existing fixed 3601-second MCP probe; the lead owns that run. Pending DNS/connect races
remain deterministic provider tests; this new host crash probe specifically covers a live tunnel.

## Host commands

From this branch on a logged-in Mac, outside an agent sandbox; use fresh scratch output
directories. Replace the absolute candidate and source paths below.

```sh
npm run build
export RELAY_TEST_CODEX=/absolute/path/to/candidate/codex
export RELAY_TEST_CODEX_SOURCE=/absolute/path/to/codex-rs
mkdir -p /tmp/s2rt

# Pin staging + actual CLI/model/consent/executor positive control.
TMPDIR=/tmp/s2rt node experiments/stage2-redteam/run-e2e.mjs

# The repaired consent regression.
node --test --test-concurrency=1 --test-name-pattern='a resume while the turn waits for its slot' test/stage2-grant.test.ts

# Item 23: fresh/resumed direct + code; item 24 and overlay part of 23.
RELAY_TEST_STANDING_LIVE=1 node --test --test-concurrency=1 --test-name-pattern='^hostile web live:' test/stage2-standing-live.test.ts
RELAY_TEST_STAGE2_LIVE=1 node --test --test-concurrency=1 --test-name-pattern='live worker:.*(hostile-(direct|code)|port0-code|cancel-code|(identity|readback)-mismatch) result' test/stage2-escalation-live.test.ts

# Items 26/28: one probe covers the live victim, confined attacker and crash recovery.
RELAY_TEST_MEDIATED_LIVE=1 node --test --test-concurrency=1 --test-name-pattern='live worker:.*mediated-crash result' test/stage2-escalation-live.test.ts

# Item 29: installed Claude plus owned model stub, then scripted ACP; no login or quota.
RELAY_TEST_STAGE2_NATIVE_LIVE=1 node --test --test-concurrency=1 test/stage2-native-live.test.ts

# Shared qualifier selection (unselected items remain not-run; not a publishable verdict).
node scripts/release-watch/codex-stage2.mjs "$PWD" /tmp/s2rt/qualification-new 0.164.0 "$RELAY_TEST_CODEX" --source "$RELAY_TEST_CODEX_SOURCE" --items 23,24,26,28

# Existing full red-team entry point, including all new manifest parts.
TMPDIR=/tmp/s2rt node experiments/stage2-redteam/run-all.mjs
```

The version argument must match the candidate. Public networking stays separately opt-in
with `RELAY_TEST_PUBLIC_NET=1`; the hour-long case stays opt-in with
`RELAY_TEST_ESCALATION_LONG=1`; item 29's mandatory `nativeProfiles` host suite must pass for a complete release verdict.

Release gates (from 1.1.1) run item 30 with `RELAY_TEST_ESCALATION_LONG=readback`: Codex's
effective config must carry the tool timeout relay sets, and the hour-long call is recorded as
not run, so the verdict reads `not run` and can never promote a pin. A gate passes with item 30
the only item not passed and its `readback` part passed. The full hour still runs at every pin
qualification (the qualifier sets `=1`), and at a gate whose change touches the broker
(`src/confine/broker-http.ts`) or the tool timeout (`codexToolTimeoutS`). This saves about 60 of
the qualification's 83 minutes.

The removed unsafe form of `survive-the-turn.mjs` backed up/restored the invoking user's real
crontab and enumerated all of that user's at jobs. Scheduler qualification now has disposable
account isolation. It refuses before any scheduler command unless the effective account is the
non-admin `relay-sched-probe` with home `/Users/relay-sched-probe`; the owner's own account and any CI
runner can therefore never be targets. The guard also requires the launchd manager uid to equal
the effective uid, preventing legacy `load`/`submit` from targeting the owner's domain. Setup gives the account a random unprinted password,
accepts explicit Codex and Node paths before sudo's secure PATH takes effect, stages root-owned readable copies of the built relay, its dependencies, Node and the selected
Codex candidate, and installs no sudoers rule. Exact host sequence:

(Since 2026-11-17 the two scripts are in the red-team harness (not published); the sequence below keeps the paths it ran with.)

```sh
npm run build
sudo scripts/release-watch/setup-scheduler-probe.sh /absolute/path/to/candidate/codex "$(command -v node)"
sudo /bin/launchctl asuser "$(id -u relay-sched-probe)" sudo -u relay-sched-probe -H env TMPDIR=/Users/relay-sched-probe/stage2-tmp RELAY_STAGE2_SCRATCH_BASE=/Users/relay-sched-probe/stage2-scratch RELAY_TEST_CODEX=/Users/Shared/relay-sched-probe-runtime/codex/codex /Users/Shared/relay-sched-probe-runtime/bin/node /Users/Shared/relay-sched-probe-runtime/experiments/stage2-redteam/probes/survive-the-turn.mjs
sudo scripts/release-watch/teardown-scheduler-probe.sh
```

The probe positively controls and then cleans exact unique payloads for crontab, at, a LaunchAgent
(`bootstrap` and legacy `load`), direct `launchctl submit`, and `asuser` plus `submit`; host-disabled controls are explicitly
`not exercisable`, never passed. The confined turn must still deny every submission. External
oracles inspect the account's crontab, `atq`, plist and launchd domains and wait 75 seconds after
the attempt, longer than the one-minute cron/at schedule, before asserting that no marker ran.
Missing execution, status or oracle evidence fails. Teardown removes only this dedicated account,
its scheduler state/home, and its staged runtime. These host commands were not run in the delegated
sandbox, so this receipt still makes no new live scheduler-confinement claim.

The local macOS `launchctl(1)` manual states that legacy `load`/`unload` return zero except for
improper usage. Accordingly, launchctl status only proves that the scripted attempt returned; the
outside exact-label `launchctl print`, plist, and unique-marker oracles decide whether launchd took
effect. Cron/at still require nonzero confined submission status. A launchctl zero with clean state
can pass, while a nonzero with any surviving service/plist/marker fails.

The LAN probe now sends UDP only to exclusively bound, owned loopback sinks on 1900/5351,
with positive controls. It sends no multicast packet and aborts if a port belongs to another
service. The cross-turn executor probe targets only the owned victim, rather than scanning
other real Relay leases. These are harness corrections, not production defects or evidence
of a sandbox escape.

## Sandbox receipt

Passed: offline TypeScript compilation; syntax checks on changed scripts/tests; whitespace
check; 113 lifecycle/overlay/mediated unit tests; 9 selected grant/consent policy tests;
19 pin/driver/live-resource/qualification-evidence tests. Counts are distinct tests, not
repeated invocations. Loading the live files without host flags skipped all 21 cases.

Failed final tests: none. One newly added negative-evidence test initially matched an
assertion's formatted message too narrowly; that expectation was corrected. The first
offline compiler attempt had no local dependencies; a link to the existing local dependency
directory resolved it without fetching packages.

Not run: real Codex/Seatbelt/listeners, the repaired MCP consent test, full red-team/full
qualification, installed Claude/ACP, public networking, hour-long probe and full test suite.
No production bug was reproduced; no production file was changed. The new host cases are
implemented and registered, with their runtime results left for the lead.
