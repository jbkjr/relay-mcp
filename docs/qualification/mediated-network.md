# Stage-2 mediated network qualification

Implementation target: pinned Codex 0.164.0. **Full host qualification pending.** Sandbox
units do not establish kernel confinement, real executor compatibility or crash recovery.

The lead reports the baseline real-worker mediated and public controls passing on the
host. WP6 does not rerun those in its restricted sandbox. The
[WP6 acceptance map](escalation-wp6.md) now wires the items below into qualification
**28** (with broker credential controls in **17/20**, profiles in **27**, adapters in **29**)
and the red-team harness (not published). Cross-job live-proxy and worker-crash
quarantine gaps remain explicit pending parts, not inferred passes.

Delegated sandbox validation: TypeScript compilation passed; 122 distinct sandbox-safe
unit tests passed across provider/proxy fakes, authority/lifecycle, stage-2 gates, executor
seams, lease, profile, probe-planner and never/address screening. Four opt-in live cases
were skipped. An initial broader selection also attempted host-dependent tests and failed
on restricted binds, sandbox-exec, process inspection, /Users/Shared writes and an unbuilt
native helper; it is not a full-suite pass. Assertions made stale by the new provider and
network-disabled origin routing were updated and their sandbox-safe checks passed.

The provider uses the worker's existing public proxy, not Codex's proxy. It opens only
127.0.0.1 at a separately leased stage-2 port, without a credential. The Seatbelt
`remote ip4 localhost:PORT` transport exception also matches this Mac's own LAN/tailnet
addresses at that port; only 127.0.0.1 has a proxy listener. The exception is internal,
separate from the approved IPv4 localhost:P connect capability (which discloses LAN/tailnet reach). Final service denies and other control-port
denies still win. The proxy port remains denied for executor bind/inbound and IPv6.

The provider adds about 200 production lines across provider/proxy/lease/profile and
source-turn routing. No new dependency. Source jobs without network use an egress-none
stage-2 executor when stage 2 and escalation are enabled. Standing non-raw network grants,
child_network and kept resume grants use the same provider every turn, including read
jobs. Failed stage2/provider qualification refuses without native strict or raw fallback. TRUST and Codex's network_proxy remain off for stage 2.
The native strict code path and its residual trustd behavior are unchanged.

Run on the host, outside an agent's restricted sandbox, with the pinned executable:

```sh
npm run build
npx --offline tsc -p tsconfig.json
node --test --test-concurrency=1 test/mediated-network.test.ts test/mediated-proxy.test.ts test/stage2-escalation.test.ts test/restart-overlay.test.ts test/stage2-gates.test.ts test/stage2-ports.test.ts test/stage2-profile.test.ts test/stage2-probe.test.ts test/stage2-executor.test.ts test/never-policy.test.ts test/proxy.test.ts
RELAY_TEST_MEDIATED_LIVE=1 RELAY_TEST_CODEX=/path/to/pinned/codex node --test test/stage2-escalation-live.test.ts
RELAY_TEST_PUBLIC_NET=1 RELAY_TEST_CODEX=/path/to/pinned/codex node --test test/stage2-escalation-live.test.ts
```

The owned-upstream live variant starts without a network grant. It uses the production
worker, broker, authenticated approval, receipt delivery, stop/restart, overlay consumption,
executor, per-turn proxy and profile. The model is an owned Responses stub. A fixture redirects only the final screened numeric dial to that owned listener;
production never and public-address screening still run first. The older testing.resolve
hook is ignored when publicPolicy supplies addresses and is not used for that mapping.
It attempts direct TCP and a direct UDP DNS question to owned sinks (EPERM required),
CONNECT to an arbitrary high never port (403), CONNECT to loopback (403), HTTP through
the proxy to the owned upstream, and a held CONNECT tunnel in a child until teardown.
It requires verified cleanup, no accepted UDP, no upstream sockets and ECONNREFUSED at
the proxy port afterward. It contacts no real protected service port or credential store.

The separately opted-in public variant uses the production DNS/provider with no upstream
hook and fetches https://example.com through CONNECT and Node's OpenSSL TLS stack.
It is the real public-network positive control, not a Security.framework TLS test.

Qualification and red-team items to record before release:

- Pinned 0.164.0 owned-upstream live run, including an origin with no network, exact
  approval identity/scope, receipt delivery, destination and verified cleanup.
- Opt-in example.com control; proxy-ignoring tools fail, including raw TCP and UDP/DNS.
- Real released-profile decoy probes: proxy port allowed over IPv4; direct egress,
  IPv6/mapped proxy access, never/control connections and proxy-port binding denied.
- Worker SIGKILL with live tunnels and pending DNS/connects: no usable proxy remains;
  executor sweep/lease quarantine and later reuse stay correct.
- CNAME chains/loops, DNS rebinding, unavailable/stale forbidden DNS, every returned
  address, alternate/mapped spellings, own-public/on-link endpoints and mixed answers.
- HTTP Host/request-target disagreement and redirect-driven new requests to never ports;
  CONNECT/SOCKS authority and numeric endpoints screened without claiming TLS inspection.
- Missing provider at decision/consumption/launch, cancellation/expiry during preparation,
  teardown failure reporting uncertain cleanup and no raw substitution.
- No broker credential at the proxy; no cross-job proxy access or listener impersonation;
  standing stage2 grants use this provider on every fresh/resumed write/read turn;
  stage2-off native strict and its trustd residual stay unchanged.

Known limits: public endpoints may themselves relay traffic; no TLS/SNI inspection,
no UDP forwarding, no direct DNS, no IPv6 localhost connect, no inferred NAT
public address, no TRUST. No Go/Swift TLS until Release B; tools ignoring proxy variables
fail closed. Approved IPv4 localhost:P additions also reach this Mac's LAN/tailnet port P
and remain refused with never.hosts. Forbidden DNS failure closes access rather than falling back.
