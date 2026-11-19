# Release A escalation qualification (WP6)

Historical receipt. The [Release A gate integration receipt](release-a-gate-integration.md)
and the subsequent item 29 native-profile lane supersede the pending-integration status of
items 23, 24, 26, 28 and 29 below.

Baseline: a private commit; implementation branch: a relay job's branch.
This is a test/runner/docs change, with no production fixes. It maps
[design §6.1](../stage2-escalation-design.md#61-acceptance-tests-for-confirmation-d_516f2cd5)
to executable evidence. **Release A is not qualified by this receipt.** Missing
integrated cases below remain explicit `pending integration` gate parts.

The subsequent [owner-decision implementation receipt](release-a-network-decisions.md)
records standing mediated routing, IPv4 localhost connects, shared temp paths,
new items 31/32 and the exact remaining host commands.

The lead supplied passing host results for the pre-existing production-worker port-0,
mediated and public variants. Those results are not new runs from this sandbox.
The live HTTP and worker harness remains `test/stage2-escalation-live.test.ts`;
WP6 adds exact-listen, outside-write and pending-cancel variants to it. No second
worker/lifecycle harness, test framework or dependency was introduced.

## Acceptance mapping

Qualification items 1–22 retain their numbers. Items 23–29 and 31–33 are registered in
`scripts/codex-qualify/codex-stage2.mjs` (30 is its own driver). Their test-file/selection/minimum-pass manifest
is `scripts/codex-qualify/stage2-escalation-cases.mjs`; red-team uses the same manifest.
The pin publisher requires all 33 items and every declared part (verdict schema `stage2-v4`;
item 33 was added for the release after 1.1.3, so pins qualified under `stage2-v3` stay valid but
a new pin needs item 33). The same file's `RELEASE_CHECK_CASES` (`claude-floor`) are release
checks: the red team runs them and so do the release gates, but the pin qualifier does not, so
they add no new pin dependency. Item 29's `nativeProfiles` part still runs the installed Claude
CLI (its stage-2-on case), as it did before; that existing requirement remains. Empty selections,
nonzero exits, cancellations, skips, todos, absent public/long opt-ins and known
coverage gaps cannot produce a qualified pin. Existing 22-item receipts are historical
evidence, not sufficient evidence for this enlarged gate.

| §6.1 resolution | Runnable evidence / qualification items | Boundary / missing evidence |
|---|---|---|
| 1. Out-of-profile tools | **23**: `never-tools.test.ts` tests hosted search/open-page withholding, fresh/resume disabled readback and missing/overridden readback refusal; opaque/implicit/compound calls, IDNA/default-port/mapped-IP/CNAME screening, pre-consent and post-consent checks, plus an allowed fixture adapter. `stable-surfaces.test.ts` checks MCP/config contracts. | The production extension catalog is empty and opaque tools refuse. Actual hostile Codex hosted/open-page calls in direct/code mode on fresh, resumed and overlay turns are still missing; **23.coverage stays pending**. Unit path/alias tests do not establish a live extension-server path matrix. |
| 2. Arming order | Existing **14.relay** drives the first production broker call while readback waits, without manual `arm()`; **15.midTurn**, **21** test checker loss/app-server-first teardown and disarmed self-start. **24** runs the existing live HTTP harness and real worker first-call/receipt/stop/restart/consume/result case, plus pending-cancel; connected lifecycle units cancel at pending, approved, returned, delivered, ready and consumed, and inject delivery, source-death, policy, pin and grant loss. | The deterministic worker model is direct-mode. A separate full code-mode restart/cancel matrix and live identity/readback-mismatch restart cases are not added; **24.coverage stays pending**. Existing fake app-server/backend and broker items provide bounded coverage. |
| 3. Local deferred | **29**: `wp4-interlock.test.ts`, selected `stage2-grant.test.ts`, `wp4-adapters.test.ts`, and host-only `stage2-native-live.test.ts`; local refusal with consent, both directions, a two-process start race, overlay-only/flag-off/malformed/stopping/tainted records, installed-Claude native Bash/Read/Edit attempts, and generic-ACP final-profile/proxy attempts. **27**: real worker port-0, exact-listen and outside-write; existing `stage2-probe.test.ts` production generator/decoy kernel controls, including a weakened profile missing the never listener deny. | No local restoration is claimed. The ACP host probe uses a deterministic ACP-v1 fixture through the production adapter because the installed Copilot KEYCHAIN/TRUST route is deliberately inadmissible, OpenCode's ACP target remains blocked by its unconfineable loopback/key route, and no usable Gemini/Grok binary is installed; it qualifies Relay's ACP side, not a vendor binary. Another registry/old relay/external forwarder is outside the interlock. |
| 4. Authenticated decider | **25**: `stage2-escalation.test.ts` and `restart-overlay.test.ts`: forged child root/decider/digest/approved fields; own-request and wrong-root/token/session decisions; person-only raw/local and missing person path; prompt-injected reason/continuation; decision races and immutable actual provenance; consume-once, another job's destination and consumed-overlay replay refusal. | In-memory/connected authority seams exercise production decision/state code. A fresh live multi-worker hostile-child authority campaign is not claimed. |
| 5. Deadline | **26**, **24**: finite 3600-second default with null baseline timeouts, tighter bounds, late approval, before-consume and running expiry, backward/unknown recovery clocks, approval pauses, crash after consume without replay, worker-death/reap stop ordering and taint retention. Existing **8/9/15** exercise real survivor/death paths. **30** optionally keeps a real Codex MCP call open for 3601 seconds and requires readback of the extended timeout and one result/dispatch. | Recovery/deadline cases use deterministic clocks and owner/cleanup seams. Worker SIGKILL with an active mediated tunnel and recovery lease quarantine is not implemented; **26.coverage stays pending**. Item 30 qualifies transport duration/result delivery, not an hour-long live overlay with approval pauses. |
| 6. Monotonic floor | **26**: `never-policy.test.ts` covers add/approve/remove/launch, malformed/unreadable reload without loss, registry reload and concurrent-process union; host-root cases include kept grants. New `restart-overlay.test.ts` case removes a never entry after allow, reloads the registry and consumes without shrinking the approved floor; later additions invalidate consumption. | Checkpoint semantics, not live revocation. Host kept-grant/temp-alias/X1 tests are separate mandatory `hostRoots` evidence. |

Additional required coverage:

| Area | Executable evidence | Limits |
|---|---|---|
| Overlay profiles | **27**: narrow/raw/port-0/exact-listen compiler rules; outside-file root swap, symlink and hard-link replacement after allow; parent/descendant overlap with all-access and write-only never; source X1 built-ins and host grant tests. Real worker outside-write confirms an owned file persists and a never decoy remains unchanged. | Production probe planner remaps service/control ports to owned high ports; file attacks use owned scratch names. Live inbound reachability from a separate LAN machine is not tested. |
| LAN disclosure | **24/25/27**: port-0 request, receipt and completed accounting; existing failed/cancelled-result snapshot checks preserve scope, destination, provenance and LAN text. | A cancelled prelaunch request is not evidence of an exposed listener. |
| Raw refusal | **25/27**: person-only authority and raw unavailable with any `never.hosts` entry, including kept grants in **26.hostRoots**. | No raw-host or TRUST provider added. |
| Mediated destinations | **28**: provider/proxy fake DNS CNAME chains/loops, forbidden aliases, rebinding history, stale/unavailable sets, every address and mapped/alternative spellings; separate pure `proxy.test.ts` address tests include own-public/on-link/subnet screening. New Host/request-target mismatch and new-request port checks use production handlers. | DNS and sockets are mocked for units. Redirect coverage screens each new request; the proxy does not inspect opaque tunnels or follow client redirects itself. |
| Mediated teardown/bypass | **28**: pending DNS, pending connects and live tunnels close; cancellation reaches the resolver; real owned-upstream worker requires EPERM for direct TCP/UDP DNS, never/loopback CONNECT refusal, a working proxy control and a held tunnel gone after teardown. Existing **17/20** protect broker credentials from proxy/environment exposure. | Cross-job access to a live victim proxy, worker SIGKILL while DNS/connect/tunnels are pending, and quarantine/reuse recovery remain missing; **28.coverage stays pending**. Foreign unsandboxed local clients already have network authority and the mediated public listener intentionally has no credential. |
| Claude/ACP | **29**: production proxy handlers with deterministic final-dial redirection enforce the shared floor. The host suite launches the installed Claude binary against an owned scripted Anthropic Messages stub, checks effective init readback, observes native Bash/Read/Edit attempts in the exact stub-driven order, and verifies the forbidden owned file is unchanged. Claude's Bash carrier reaches the allowed sink and a nested production public proxy only through Relay's own per-turn proxy; Relay makes that carrier dial outside the confined process. Two scripted ACP-v1 turns check the generic adapter. Generic `NETWORK_ON` allows outbound IPv4 and denies all of this Mac's own addresses, so the granted ACP positive control is a connect-only dial to 1.1.1.1:443 (the host must be online). The pre-start allowed sink, two pre-start `user.port` decoys and a parent-owned listener opened only after the confined fixture writes a ready marker must all return `EPERM`, and their accept logs stay empty. Outside ACP confinement, the parent test drives a production public proxy: every built-in service port and owned never-port on this Mac's address must produce a `refused` deny record, a loopback port outside the floor must read `private-address` as the control, and an allowed request reaches the owned sink. | The Claude run uses a fresh scratch HOME, Relay's guarded development model-stub route and an owned dummy `ANTHROPIC_API_KEY` under target-local `child_auth: "any"`; it needs no provider login or quota and touches no real user settings. It qualifies the installed CLI's settings readback, native tool dispatch, denials and proxy controls, but does **not** qualify real model transport, provider login, model selection or model behaviour. The tests never bind or directly connect to a built-in service port. The parent-driven ACP proxy evidence qualifies Relay's production handler and floor, while the in-profile evidence qualifies the granted profile's closed loopback; neither is a claim about a vendor ACP binary or vendor tool semantics. |
| Keychain IPC | **33** (host only, `RELAY_TEST_KEYCHAIN_LIVE=1`): a throwaway keychain with one generic-password item trusted to `/usr/bin/security`, in a scratch directory, unlocked; a positive control retrieves it outside any sandbox. `codex`: `security find-generic-password` under `codex sandbox` with relay's native profile and floor, network off and on, two turns each (`codex-permissions.test.ts`, "keychain decoy live (codex"; 4 tests). Floored, with the decoy's directory in `never.paths` (as `~/Library/Keychains` is in the floor), it must be refused on every turn. The control, the same floor without that entry, must equal doctor's documented state (`neverKeychainIpc`: closed off-network, open on-network with stage 2 off), so refused and retrieved. Claude's side is release check `claude-floor` (`RELEASE_CHECK_CASES`): the same pair from Claude turns with stage 2 off (`stage2-native-live.test.ts`, "keychain decoy live (claude"; 2 tests; floored refused, control retrieved, as documented open), and item 29's installed-Claude case with stage 2 off. | IPC to the daemons stays open for Claude, and for Codex network-on turns with stage 2 off; only relay's own Seatbelt closes it. The floor's keychain-file denies still keep file-keychain items unreadable, since reading one needs its file as well as the daemons (measured 2026-11-04). Where the documented IPC is open (Codex network on, and Claude, whose two turns are both network-on because the model stub needs the grant), the control retrieves the item and so shows a floored refusal comes from the file deny, not a broken command. Codex's network-off pair is refused on both sides, as the closed IPC documents: a consistency check, not evidence about the file deny. Claude's network-off keychain IPC is doctor's reading of the binary's profile, not measured by these turns. Daemon-only data such as data-protection items is not covered, nor is a copy of a keychain file kept outside the denied directories. The decoy uses an explicit keychain path, not the login keychain's search list, and runs only under the test's scratch HOME: the person's search list and default keychain are read before and after, never written, and must read the same. `claude-floor` is not part of the pin verdict. |
| Owner decisions | **31**: standing grants and child_network route through stage2, proxy environment, no fallback, read access and fresh/resumed turns. **32**: IPv4 localhost:P connect with owned localhost/LAN/tailnet controls, alias/IPv6/other-port and never denials, request/receipt/result disclosure including failed/cancelled turns. | Standing and connect host tests must be run by the lead. Connect stays unavailable with never.hosts; no proxy token added. |
| Stable surfaces | Existing config/tool/registry fixtures and `escalation.json` request/decision/node/event/result snapshot run unchanged and pass; standing scope types remain intact. | WP6 changes no public schema and needs no fixture rewrite. |

## Commands

From a trusted built checkout on a logged-in Mac, outside an agent sandbox:

```sh
npm run build
npx --offline tsc -p tsconfig.json
export RELAY_TEST_CODEX=/absolute/path/to/pinned/codex
export RELAY_TEST_CODEX_SOURCE=/absolute/path/to/codex-rs
mkdir -p /tmp/s2q-wp6

# All qualification items; old binary is exactly 0.163.0.
# Public and hour-long probes are explicit: this takes over an hour.
RELAY_TEST_PUBLIC_NET=1 RELAY_TEST_ESCALATION_LONG=1 \
  node scripts/codex-qualify/codex-stage2.mjs "$PWD" /tmp/s2q-wp6/full 0.164.0 "$RELAY_TEST_CODEX" \
  --old-bin /absolute/path/to/codex-0.163.0 --source "$RELAY_TEST_CODEX_SOURCE"

# Just the additions (diagnostic: unselected items keep the full verdict not-run).
node scripts/codex-qualify/codex-stage2.mjs "$PWD" /tmp/s2q-wp6/additions 0.164.0 "$RELAY_TEST_CODEX" \
  --source "$RELAY_TEST_CODEX_SOURCE" --items 23,24,25,26,27,28,29,30,31,32

# Red-team additions, then the whole existing campaign plus additions.
RELAY_TEST_PUBLIC_NET=1 RELAY_TEST_ESCALATION_LONG=1 \
  node experiments/stage2-redteam/run-escalation.mjs
TMPDIR=/tmp/s2q-wp6 RELAY_TEST_PUBLIC_NET=1 RELAY_TEST_ESCALATION_LONG=1 \
  node experiments/stage2-redteam/run-all.mjs

# New live variants and the existing baseline variants, using the same harness.
RELAY_TEST_STAGE2_LIVE=1 RELAY_TEST_ESCALATION_HTTP=1 RELAY_TEST_MEDIATED_LIVE=1 \
  node --test --test-concurrency=1 test/stage2-escalation-live.test.ts
RELAY_TEST_PUBLIC_NET=1 node --test --test-name-pattern='mediated-public result' test/stage2-escalation-live.test.ts
node --test --test-name-pattern='^stage-2 overlay live controls:' test/stage2-probe.test.ts

# Item 29: installed Claude with an owned scripted model (stage 2 on), then the scripted ACP-v1 turns.
# No Claude login, provider request or quota is used.
RELAY_TEST_STAGE2_NATIVE_LIVE=1 \
  node --test --test-concurrency=1 --test-name-pattern='^stage2 native live:' --test-skip-pattern='\(stage 2 off\)' test/stage2-native-live.test.ts

# Item 33: a decoy keychain item from native Codex turns, network off and on: floored (refused on
# every turn) and its control without the file deny (matches doctor's keychain IPC).
# Creates and deletes a throwaway keychain in a scratch directory, under the test's scratch HOME;
# your search list and default keychain are only read, before and after, and the test fails if
# they changed.
RELAY_TEST_KEYCHAIN_LIVE=1 RELAY_REQUIRE_REAL_CODEX=1 RELAY_TEST_CODEX=<pinned codex> \
  node --test --test-concurrency=1 --test-name-pattern='^keychain decoy live \(codex' test/codex-permissions.test.ts

# Release check claude-floor (gates and red team, not the pin): the installed Claude case with
# stage 2 off, and the decoy keychain from Claude turns, floored (refused) and its control (retrieved).
RELAY_TEST_STAGE2_NATIVE_LIVE=1 RELAY_TEST_KEYCHAIN_LIVE=1 \
  node --test --test-concurrency=1 --test-name-pattern='^stage2 native live: installed Claude.*\(stage 2 off\)|^keychain decoy live \(claude' test/stage2-native-live.test.ts
```

`--source`/`RELAY_TEST_CODEX_SOURCE` avoid fetching the bundled catalog. The latter is
used by the red-team hour-long probe; ordinary qualification uses `--source`.
`RELAY_TEST_ESCALATION_LONG=1` is the new opt-in; it fixes the delay at **3601000 ms**,
so shortening an environment value cannot create a fake beyond-old-timeout pass.
The standalone pin qualifier's default 30-minute watchdog is too short for this probe;
its existing `timeoutMs` must be raised within its supported two-hour limit for a full run.
No change to scheduled host configuration is made here.

Sandbox-safe checks (no listeners or Seatbelt), from the built checkout:

```sh
node --test --test-concurrency=1 test/stage2-escalation-qualification.test.ts test/stage2-network-decisions.test.ts test/stage2-broker-qualification.test.ts test/stage2-escalation.test.ts test/restart-overlay.test.ts test/restart-overlay-profile.test.ts test/mediated-network.test.ts test/mediated-proxy.test.ts test/wp4-interlock.test.ts test/wp4-adapters.test.ts test/never-tools.test.ts
node --test --test-skip-pattern='grant admission rechecks kept|stale native temp alias repair|X1 never refusals preserve' test/never-policy.test.ts
node --test --test-name-pattern='^stage-2 overlay expectation|^stage-2 overlay probe plan:|^stage-2 decoy network:' test/stage2-probe.test.ts
node experiments/stage2-redteam/run-escalation.mjs --unit
```

The last command deliberately exits **1** while host/opt-in probes are not-run or
coverage is pending. Item 29 now has no coverage placeholder: its `nativeProfiles` part is a
mandatory host run, and a skip or missing opt-in fails that part. Inspect
`escalation-verdict.json` and per-part `.tap` logs;
each unit part must pass. This is distinct from a failing unit test. All red-team
results retain the full item/part shape and never turn omitted host work into success.

## Verification receipt

Passed locally: `npx --offline tsc -p tsconfig.json`; `node --check` on all seven
changed/new runner scripts and the live TypeScript test; `git diff --check`.
**178 distinct selected tests passed**: 147 in the combined sandbox suite above,
14 selected never-policy tests, 3 planner tests, 3 proxy address tests, 3 local/grant
tests, 3 selected stable-surface/release-watch tests and 5 selected pin-publisher tests.
Repetitions in the shared runner are not additional distinct tests.

Skipped: **7** opt-in live HTTP/worker variants when loading the live file without
host flags. Not run: actual loopback/Seatbelt profiles, full qualification/red-team,
the public and hour-long controls, three host-root tests and the full suite.
The shared `--unit` red-team parts pass; its overall exit 1 represents missing
host/opt-in evidence and pending coverage, not unit failures.

Failed final unit checks: **none**. Initial attempts found missing worktree dependencies
(resolved with the existing local dependency directory), test-mock assumptions corrected
in this change, and three existing `/Users/Shared` tests blocked by sandbox `EPERM`.
Those three are now separate mandatory host-root parts. Node's negative name pattern
matched the parent file and ran them; using an explicit skip selection for the unit
part and a positive selection for the host part keeps this boundary visible.

Item 29 lane implementation check: `npm run build`, the offline typecheck, syntax checks,
`git diff --check`, and 42 selected qualifier/adapter/proxy/decision tests passed. Loading
`stage2-native-live.test.ts` without its opt-in produced exactly its two declared skips.
The installed-Claude turn, Seatbelt profiles/listeners, and full item-29 qualifier were not
run in the delegated sandbox; the coordinator must run the host commands above.

No loopback, Seatbelt, public control or real credential/service probe is run by this delegated task.
No production bug has been reproduced by the added sandbox tests; no production fix
is included. The full host matrix, full suite and independent release review remain
the lead's gates. In particular, closing the coverage gaps requires adding their probes
and replacing the corresponding pending manifest parts with executable evidence.
The hosted/code-mode matrices need additional model/turn scripts; cross-job/crash
quarantine needs a multi-worker victim/attacker/recovery coordinator; installed
Claude/ACP checks need their native settings/tool harnesses. Those are substantial
new orchestration beyond the existing worker test reused here, so they are listed
as uncovered rather than approximated by another fake lifecycle.

Known limits remain: Go/Swift tools using Security.framework TLS need the refused TRUST
route; Node/OpenSSL public success does not qualify them. Opaque CONNECT/SOCKS tunnels
are authority/endpoint checked without TLS/SNI or remote-forwarder inspection. Native
strict's measured 1.0.5/1.0.6 trustd certificate-driven blind GET residual is unchanged;
stage 2 keeps TRUST off and is unaffected by that measured route.
