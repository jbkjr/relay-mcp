# Escalations and the never-list: Release A design

Status: **revised design, 2026-10-29**, written before Release A was built; Release A shipped in relay 1.1.0. Revised after cross-family confirmation `d_516f2cd5` (Claude and Codex Daybreak). This replaces the earlier full-scope design. Release A implements restart-only escalation and a uniform never-list. Release B contains the deferred mechanisms in §8; none is a Release A prerequisite.

Authoritative decisions: a private planning note, sections “Scope decision from the maintainer's grill session (2026-10-29)”, “Grill round 3”, “Grill round 3 addendum”, “Pinned Codex, relay-side package (PC): requirements”, and the later “WP0 trustd result and a 1.0.6 residual”. The addendum and measured trustd result supersede the earlier helper, machine-wide coordination, watcher and conditional TRUST proposals.

The six accepted resolutions in confirmation d_516f2cd5 (a relay discussion record, not published) further govern Release A: out-of-profile tool screening/withholding, broker §14 arming order, local restoration deferred to B, authenticated decider identity, an enforced finite overlay deadline and a monotonic never floor.

Dependencies: [MCP broker design](codex-mcp-broker-design.md), including revision 2 and its build obligations; [confinement design](codex-confinement-design.md); WP0 feasibility research (not published) and its probe sources and receipts (not published); [approval boundary](approve-boundary.md); [stable surfaces](stable-surfaces.md). The broker and pinned, automatically qualified Codex are part of the larger Release A program and are not costed again here.

Evidence labels:

- **Verified (this revision):** `git log -1`, `git status --short` and document/source inspection establish baseline `f370372` and an initially clean worktree. No model, network, Seatbelt, login, listener or host-configuration probes were run for this revision.
- **From source:** a repository file or the lead's report was read, not executed here. Earlier live results are attributed to their source; they are not fresh verification. WP0's unresolved gate-4 status predates the lead's later result and must not reopen the TRUST option.
- **Assumption / proposed mechanism:** implementation details and estimates below. Unlabelled normative statements specify the proposed Release A implementation, not behavior already shipped.

## 0. Release A

Local-mode restoration is **Release B**. In A, local mode stays refused while stage 2 is enabled; localhost work uses qualified stage-2 localhost-port or port-0 overlays (§5).

Sandbox by default; approved additions last **one new turn**; never and relay's authority protections win over every addition. The broker serves an `escalate` child tool. It requests a capability, ends the current turn cleanly and relaunches the job with an immutable one-turn overlay. It does not execute a command itself. There is **no per-command helper, patch runner, escalation PTY or transparent executor-wire router** in A.

### Capability table

All rows retain credentials, never entries, X1 installation protections and process/IPC restrictions. A request may combine rows, but every effect must be explicit and the strongest required approval authority wins. Existing standing grants are separate and unchanged in lifetime; `escalate` cannot create or modify one.

| Release A capability | Mechanism and actual scope | Approval authority | Expiry / admission |
|---|---|---|---|
| A localhost port | Restart with direct access to Seatbelt's IPv4 `localhost:P`, which also includes port P on this Mac's LAN and tailnet addresses. Specify connect or listen; never implicitly both. A listen exception opens that otherwise allowed port plus the job's reserved four-port block and discloses their wildcard/LAN/tailnet exposure. No general LAN/local-network switch. | Supervisor for clearly authorized work; otherwise person. Service API effects count as part of authorization. | One overlay turn; fresh destination checks. Never/control endpoints cannot be exceptions. Occupied listen ports fail. |
| Port-0 TCP binds | Restart with broad TCP bind/inbound permission, minus final never, control/reserved and ordinary listener-snapshot restrictions (§4.1). The profile cannot express “only OS-selected ephemeral ports”. | **Supervisor may approve when the task clearly involves running tests or servers.** One config point controls this authority (§3.1). Otherwise person. | One overlay turn. Both request and job result say the listener may bind **0.0.0.0**, so it is **on the LAN**. |
| Writes outside the worktree | Restart with write access to an exact approved file/tree root, pinned by name and identity. Ordinary executor tools perform writes; no relay-side arbitrary patch writer. | Supervisor for clearly authorized writes; otherwise person. Read jobs need an explicit change to write access. | One overlay turn; writes persist on disk. Refuse overlapping never/X1/authority roots in either direction. |
| Network for one turn: public mediated HTTP(S)/TCP | Restart with a turn-scoped proxy allowance. OS restrictions require this route; proxy variables alone are insufficient. Includes a job that began without network. | Supervisor for clearly authorized network work; otherwise person. | One overlay turn; every requested authority and checked numeric endpoint passes never. Close its tunnels on teardown. |
| Network for one turn: broad raw or broad local network | Restart with the corresponding qualified profile/proxy. Raw includes direct TCP/UDP/DNS and LAN/tailnet reachability; broad local exposes APIs with their own authority. Standing `raw_network` / `local_network` consent stays person-only too. | **Person-only**, even for a test task. Port-0 authority does not grant this authority. | One overlay turn. **Any `never.hosts` entry makes raw network unavailable in Release A**, including existing standing raw grants; use a qualified mediated route instead. A standing mediated baseline also refuses raw/local substitution rather than replacing its route for the overlay turn. |

Only capabilities with a qualified compiler/provider are admitted. A localhost request must not grant broad raw egress; a port-0 request grants listening, not additional outbound network. An overlay may require relay's executor lifecycle even when the base turn used another mode; that is an explicit launch-plan change, not a hidden standing raw grant. Existing stage-2 admission requires a standing raw grant; WP2 must extend it for narrower overlay plans without weakening their checks.

**Explicit exclusions:** no TRUST escalation, no host-limited raw provider (E6), no arbitrary executable/AF_UNIX/other-OS-capability escalation, no command-lifetime or job-lifetime escalation API. Ordinary native approval within an unchanged checked profile remains available. If A cannot express an addition, return `capability_unavailable` with reason and recovery; do not call it a never violation unless it matches never.

The earlier confinement D2 local-mode retirement remains in A; its restoration is deferred to B because native strict/local cannot enforce never through the measured trustd route. D3's permanent port-0 refusal is replaced by the qualified overlay capability here. D1's separate broad raw consent, D4's listener snapshot, D5's baseline restrictions, D6's relay-owned commits, D7–D8's app-server/credential protections, D9's LAN disclosure and D10's transport remain except for an explicitly approved overlay. Nested delegation remains available through the reviewed broker under its existing authority.

## 1. Evidence and feasibility boundary

| Evidence | Result / implication for Release A |
|---|---|
| From source: a research note (not published) §1; a research note (not published) | Lead's broad-bind candidate passed **114 cases, 0 failures**. Feasibility for that decoy matrix, not a qualified production overlay executor: the probe omits production filesystem/authority and broker rules. |
| From source: lead report, “WP0 trustd result” | **24 evaluations, 0 invalid**, with a working fetch positive control. Every tested TRUST-on profile made OCSP and CRL HTTP GETs to owned loopback decoys, including redirects; TRUST-off made none. The condition failed: **no TRUST escalation in A**. Certificate-driven blind fetching, not arbitrary response-body access; actual never services were not probed. |
| From source: same lead report | With relay 1.0.6's exact Codex strict flags, network-on produced one OCSP and one CRL loopback GET; network-off produced none; unsandboxed control produced one each. Record the **1.0.5/1.0.6 strict-mode trustd residual** (§7). Stage 2 refuses TRUST; Claude remains untested. |
| From source: a research note (not published) §§2–3, 5 | Raw sockets cannot enforce DNS-authority never rules; Go file-root observations do not qualify general Go/Swift platform TLS. Copilot/Grok's shared-process credential routes need separation; Gemini's key-only route can preserve direct store denial subject to qualification. |
| From source: `src/confine/seatbelt.ts` (`TRUST`, `seatbeltProfile`); `src/backends/codex-env.ts` | An already-running outer Seatbelt cannot be widened by a native approval. Stage 2 rejects `certificateTrust`. A fresh executor is required for a changed outer policy. |
| From source: confinement design §2.2; `src/backends/codex-stage2.ts` | Keep `CODEX_EXEC_SERVER_URL=none`, explicit per-turn executor binding, no-local readback, self-started-turn guard and resume checks. A steered turn does not prove a new environment was selected. |
| From source: `src/core/raw-network.ts` (`localModeRetired`, `localModeInterlock`); `src/core/stage2-executors.ts` | Blanket retirement, per-registry two-way interlock and survivor records already exist. A extends those records/interlock; no machine-wide coordinator. |
| From source: `src/targets/codex.ts` (`codexToolTimeoutS`); `src/backends/codex.ts`; `src/backends/codex-stage2.ts` | Current MCP timeout is `max(3600, 2 * approval_timeout_s + 300)`: approval waits, not an explicitly budgeted overlay turn. Raise and read back `tool_timeout_sec` (§2.4). |

Native Codex command approval is a decision, not an execution redirect; file approvals do not supply a checked executor identity (confinement design and `codex-stage2.ts`). A never returns `accept` and separately runs the same native action. There is no pending-command transfer or hot executor replacement.

## 2. Restart-only mechanism

### 2.1 Tool, identity and lifetime

**Proposed tool shape:** `escalate({ capabilities, reason, continuation })`. Structured capability variants correspond exactly to §0; `continuation` can identify the intended initial command, cwd and subsequent work. It is untrusted task context, not authority. No caller-supplied approved/confined flag, profile, destination turn or person-confirmation flag is accepted.

Relay derives root/run/node/relay-turn IDs, native thread/turn and MCP session/call identity, access mode, baseline grant and effective launch plan. The canonical request includes the normalized delta, exact roots/endpoints and pins, full intended command/argv/shell script and cwd when supplied, continuation, reason, deadline, base-policy/never-policy hashes and `required_decider` (`owning_run_root | person`) with the authenticated owning-root session identity (§3.1). Preserve full material details, not just a summary. No secret environment values or bearer tokens enter transcripts/receipts.

The approved object is a **turn capability**, not an exact-command lease. Every command/file operation in that turn has the addition. The turn may execute worktree code the agent edits after approval (§3.2). OS/proxy enforcement, rather than declared argv/resources, bounds the effect. Same-turn subprocesses share the profile; separately delegated relay jobs and future turns do not inherit it. Native subagent execution must remain within the same effective overlay turn and cannot carry it into another turn.

The overlay is separate from standing `grant`, bound to one destination turn, baseline grant hash, request and recorded decision, and consumed once. It expires at that turn's completion, cancellation, failure or deadline. No `acceptForSession`, ACP `allow_always`, queued continuation, later resume or crash recovery converts it to persistent consent. Another addition needs a new approval for its entire next effective overlay; additions do not accumulate across restarts implicitly.

### 2.2 Lifecycle

1. **Ask through the broker.** Offer `escalate` only to the owning live child through its authenticated, armed broker. Keep token-first checks, bounded kernel peer checks, required-server readback, session tombstones and no-404 replay behavior. Make tool/broker availability independent of `mayDelegate`: a non-delegating child still needs escalation, with delegation tools withheld. Other harnesses use a qualified authenticated tool transport, never an agent-controlled listener.
2. **Resolve and queue.** Normalize; load never and durably merge additions into the run floor at this approval checkpoint; refuse never/unsupported effects with a structured reason. Persist the canonical request and emit existing `needs_approval` events. Reuse serialization, lent concurrency slots, timeout, person paths and decision provenance.
3. **Approve atomically.** Bind the decision to a digest of all authoritative fields, including the owning-root identity. Authenticate the decision channel against `required_decider` (§3.1); atomically accept at most one terminal decision for that digest. Check origin liveness, access/grant, pins, the durable never floor, decider and deadline. Allow creates a pending overlay; it widens nothing yet. A lost caller/transport or cancellation before this handoff cannot create a runnable continuation.
4. **Acknowledge and stop cleanly.** Return a bounded `restart_pending` tool receipt (request ID, approved effects and provenance), persist continuation, and mark the turn closing so no further tool/command work is admitted. Finish/interrupt it through the normal turn lifecycle. Do not hold this child call open for the replacement turn: its app server must die first. Record failed receipt delivery without replaying the effect or treating delivery as execution.
5. **Tear down before relaunch.** Disarm broker; kill app server first; stop executor/tree; close tunnels and run the existing descendant/survivor sweep. Hold broker wildcard listeners until the app server is dead. Uncertain cleanup taints records and quarantines leases; it prevents restart. A denied/expired pending request cannot widen the old profile. Expiry of a consumed/running overlay instead requires its teardown (§2.4).
6. **Prepare a fresh destination.** Reload never and durably merge additions into the run floor at launch; recheck pins, captured grant, capability digest, consent, pending-request expiry, remaining finite overlay/job deadline and per-registry interlock. Material policy/identity changes invalidate the old allow and need a new request; never silently broaden its effect. Arm the trusted supervisor's monotonic deadline and persist its recovery deadline no later than atomic assignment/consumption for one destination (§2.4); never release launch/model work first. Replayed calls return existing state, never another turn. Crash after consumption is failed/unknown launch, not permission to retry automatically.
7. **Launch through the existing trusted executor path.** Generate a fresh baseline-plus-overlay profile with final never/authority denies. Retain fresh temp identity, qualified pinned executable, durable overlay/executor records and lease quarantine. Persist reservation/identity before releasing model work; record/sweep partial failures. Probe the exact profile with decoys. Require the prelaunch permission/no-`local` checks, then bind the executor in relay's own `turn/start`. Follow [broker design §14](codex-mcp-broker-design.md#14-confirmation-d_63ad5c08-2026-10-29-build-revision-2-with-one-change): validate the turn identity with `guard.replied(started.turn.id)`, arm the broker immediately, then await `stage2TurnReadback` as defence in depth. The binding travels in the same `turn/start`; readback may retry while the model runs and must not delay arming. On mismatch or readback failure, disarm, kill the app server first, then fail the turn and tear down the executor. No hot `environment/add`, wire interception or command runner.
8. **Deliver and expire.** Inject receipt/continuation into the replacement turn with scope and expiry. Persist outcome/cleanup at turn end; deadline expiry enters `stopping`, or `tainted` with survivors, and removes the overlay only after verified teardown. The job result includes requested/effective capabilities, decider and cleanup, including §3.2's LAN statement. Later turns use baseline and wait for cleanup. Unrelated resumes cannot consume stale overlay state.

Required durable lifecycle: `requested → allowed/pending_restart → stopping` (origin teardown) `→ ready → consumed/running → stopping` (overlay teardown) `→ expired`, with denied/cancelled/failed outcomes and `tainted` for uncertain cleanup/survivors. `Expired` is terminal only after verified cleanup; an elapsed clock alone is not cleanup. `Allowed, not executed` is distinct from executed. The origin may be terminal once continuation is durably bound; destination liveness and captured authorization replace origin-liveness checks at that transition. Do not require the dead origin to remain live or let an unrelated turn claim its request.

Standing root-issued grants remain available through start/resume with existing consent rules plus never validation. There is no automatic standing-grant migration. Grant changes during pending restart invalidate it.

### 2.3 Native approvals and harness behavior

Unchanged-profile native actions can receive ordinary decisions. If a wider outer profile is needed, decline/cancel the pending action exactly once and explain `escalate` recovery. Never execute out of band then return `accept`, or imply native approval widens Seatbelt. Files change through ordinary tools in the replacement turn, not a privileged patch dispatcher. Ambiguous/incomplete native payloads cannot authorize wider profiles.

`confined:true` describes checked execution, not approval authority. Render overlay effects before `approvals.ts`'s old generic “limits stay unchanged” text. Native file approvals lacking executor identity remain unmarked; the overlay launch attestation and resulting operations are recorded separately. Hosted web/model/extension tools do not gain shell network, overlay rights or a confinement stamp from their parent turn. Their out-of-profile effects require independent never enforcement or withholding (§4.6); parent confinement and person approval do not screen those effects.

### 2.4 Normative overlay deadline and MCP timeout

Raise Codex's `tool_timeout_sec` for relay's stdio and `relay_tools` broker registrations; update readback expectations together. **Proposed formula:** `max(3600, 2 * approval_timeout_s + 300) + overlay_budget_s + 300`. The added budget covers the overlay's entire wall-clock duration, including any approval pauses; the last 300 seconds covers teardown/relaunch. Enforce those budgets, not merely a larger client timeout, and respect any tighter remaining job/turn deadline. The existing approval-only formula and a 75-second probe do not establish this.

From source, `src/core/config.ts` permits `job_timeout_s` and `turn_timeout_s` to be null (both default to null). **Required finite default:** an overlay gets **3600 seconds**, reduced by any tighter finite remaining job/turn bound. Null baseline timeouts never produce an unbounded overlay. Record the effective budget, pending-request/approval expiry and overlay deadline in the approval, durable state and receipt. The pending request/allow must expire before consumption if its approval/restart deadline elapses; a late decision cannot revive it.

The **trusted supervisor**, not the worker/model or MCP client timeout, arms a **monotonic deadline no later than overlay consumption or launch**, and persists a corresponding recovery deadline before work is released. Start the overlay budget once, never reset it on restart, resume or approval pauses within the overlay, and honor any earlier captured deadline. Recovery/reap uses the persisted deadline to stop expired work after worker death; if a safe remaining interval cannot be reconstructed (including clock uncertainty), stop conservatively rather than renew consent. Durable records and reap must remain effective when the worker is gone.

On overlay expiry, atomically refuse further tool/approval work and enter `stopping`: disarm, kill the app server first, then stop the executor/tree, close tunnels and sweep. Survivors or uncertain cleanup mean `tainted`, with quarantined leases/reservations until reap proves cleanup. Expiry **never** permits the old executor to continue while a baseline/replacement turn starts. Later turns wait for verified teardown, including after worker death. Ordinary baseline turns retain their existing timeout semantics. A finite MCP timeout must never conceal an unbounded overlay. Qualify whether the proposed transition padding suffices and fail the launch if its total cannot be represented by the pinned Codex timeout type.

The child call returns at handoff (step 4). A supervisor's enclosing relay call can span restart and overlay result; a child can make another long relay call during the overlay. Neither may time out while relay later applies an invisible approval. Qualify direct/code-mode calls exceeding the old budget across queue wait, decision, restart and result delivery. Timeout, MCP cancellation or broker failure follows the bound request/turn cancellation path; never consent or retry. MCP transition padding is a WP3 implementation/review choice against these normative deadlines; the finite default, enforcement point and teardown requirement are not optional.

## 3. Approval authority and text

### 3.1 One authority policy

Task authorization and capability authority are distinct. In approval-authority language, **supervisor means the authenticated owning run root**, not any ancestor or agent carrying that label. This decision principal is distinct from the trusted relay supervisor process that enforces deadlines and teardown (§2.4). The owning root approves narrow effects only when the person's task clearly authorizes them. A child can request/deny, never grant itself/another child authority. Broad raw/local stays person-only. Never matches are refused without prompting; person approval cannot remove an entry. Existing person-only extension, environment-disclosure and relay-CLI rules remain independent.

**Proposed single config point:** `escalation.port0_authority: "supervisor" | "person"`, default `"supervisor"` per the maintainer's addendum. Classifier, UI and decision validator use that one value; no backend-local copies or environment override. `"supervisor"` permits authorized supervisors to allow clearly in-scope tests/servers or refer uncertainty to the person, not auto-approval based on a reason string. `"person"` is a one-line flip. `relay.config` protects it. Broad raw/local authority is unaffected.

**Required decision field:** `required_decider: "owning_run_root" | "person"`. The config spelling `"supervisor"` maps only to `owning_run_root`. Derive the owning root from trusted run/session state and authenticate its session token at decision time. Include that owning-root session identity and a non-secret binding to its token identity/version in the canonical request digest; never serialize bearer tokens into requests or receipts. Missing/mismatched root authentication refuses the decision. A person-only request requires the qualified person channel; root authorization cannot substitute for it. Labels, arbitrary ancestors, launched/nested children, continuation authors, `reason` strings and persisted `decided_by` text never satisfy `required_decider`. A changed owning-root/session binding invalidates the old decision. Competing allow/deny/cancel decisions use an atomic terminal transition for the same digest; losers cannot consume an overlay or overwrite provenance.

Persist actual `decided_by`, qualified dialog/confirm or supervisor route, note/timestamps, request/policy hashes, capability IDs, origin/destination turns and outcome. “User confirmed” prose is not person provenance. Preserve typed-code/ancestry restrictions on `relay approve`. No timeout, unattributed answer, lost dialog or missing person path is consent. Return `person_path_unavailable` with effect/recovery when a person-only request lacks a qualified channel. Supervisor-authorized effects do not need a person channel merely because none exists.

### 3.2 Required approval and result wording

Example port-0 approval for intended `node ./test/server-test.js`:

> Job j_example asks to end turn 7 and start one new turn with broad TCP bind/inbound permission outside its assigned port block. The listener may bind **0.0.0.0 for that turn, so it is on the LAN** (and may be reachable on the tailnet). This permits any otherwise allowed TCP bind port, not just OS-selected ephemeral ports. Never ports, relay control ports and protected listeners remain denied. The intended command runs worktree code that the agent can edit after approval; the addition applies to all commands and descendants in the replacement turn. It ends when that turn and its processes stop. The supervisor may approve because the authorized task involves tests or servers.

The **job result**, including failed/cancelled-after-launch results, repeats: “This turn allowed listeners to bind 0.0.0.0, so they could be on the LAN,” with effective scope and cleanup. A prelaunch failure says allowed but never launched. Do not assert actual exposure or successful cleanup without evidence.

Every command-oriented approval includes: **“The command runs worktree code that the agent can edit after approval.”** Show full intended argv/shell script and cwd when known; this grants the replacement turn, not an immutable code digest. For services show endpoint/protocol, resolved address and API effects; for writes show exact file/tree root, existing/missing status and persistent effects; for raw/local show direct-network/LAN/forwarding/exfiltration effects and person-only authority. Notifications can point to full details; authoritative records cannot omit them. Quote reasons/continuations as untrusted input.

## 4. Never-list

### 4.1 Built-ins and precedence

Stable IDs expand from trusted host configuration, never job-controlled HOME/PATH. One shared `NeverPolicy` supplies admission, profile and proxy enforcement. Refusals name the matching entry and mode/effect before launch.

| Built-in ID | Protection |
|---|---|
| `credentials.files` | Deny read, write, enumeration/test and link access to credential stores: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.codex` auth and other target token/API-key stores, default and configured locations, missing names and real targets. |
| `credentials.relay-codex-home` | Deny the **whole** `~/.local/share/relay-codex-home` and configured `targets.codex.home`, not merely `auth.json`. Only the trusted unconfined Codex app server reads it. Native Codex, Claude and ACP tool/executor policies preserve denial. Grants/file requests cannot overlap it in either direction. |
| `credentials.keychain` | Keychain databases and credential Mach APIs (`SecurityServer`/securityd routes). No TRUST addition in A. |
| `service.sshd` | Port **22**, this machine, even when stopped. |
| `service.screen-sharing` | Port **5900**, this machine. |
| `relay.config` (non-removable) | Config/MCP definitions/local config/install record/backups and protected names/targets from `configProtection()`. Preserve dedicated-directory versus file-only protection. |
| `relay.install` (non-removable) | X1's full **write-only** `relayWriteProtected()`: running package/native helper, Node/git/target installs, named links/real paths, developer-tool identities and PATH directories. Preserve read/execute. Include the pinned Codex store: readable/executable, never agent-writable. |
| `relay.authority` (non-removable) | Registry, context/broker/overlay/executor/lease state, tokens, other jobs' private state/worktrees, authoritative git pointers/common metadata, control listeners and process/signal/IPC routes to the trusted supervisor. Retain existing narrowly scoped internal control access; these are not escalatable localhost services. |

Service ports protect outbound connections to this Mac on all its addresses and binding/listening, for **TCP and UDP** so another transport cannot impersonate them. Preserve local-service semantics (E4): external IPv4 SSH on port 22 is not globally prohibited. The IPv6/mapped-IPv6 workaround overblocks those port numbers at all hosts; disclose it and qualify address spellings. User entries can choose all destinations explicitly.

D5's extra TCP restrictions (3283, 3031, 445, 548, 631), UDP 1900/5351 and listener snapshot remain baseline protections, not extra built-in never IDs. Static denied ports are refused as exact connect or listen exceptions; an otherwise allowed port covered only by the listener snapshot may receive an expressible exact exception within §0. There is no general UDP/OS provider just to make every restriction escalatable. Do not silently drop them.

Port-0 broad TCP bind/inbound allows precede final operation-specific never/control/reserved denies for both IP families/transports. Deny-bind alone is insufficient if an inbound allow wins. Keep ordinary snapshot denies unless a separate exact service exception is approved. Preserve only the trusted executor's required own-port bind and assigned job block; never reopen broker/other-turn/reserved ports or outbound executor access. The executor needs its listener to start, unlike WP0's standalone candidate. Qualification must prove legitimate startup and the final floor compose; 114/0 is not that proof.

### 4.2 Additive config schema

Proposed strictly validated top-level instance (illustrative only):

```json
{
  "never": {
    "paths": [
      { "path": "~/private-notes", "access": "all" },
      { "path": "~/archive", "access": "write" }
    ],
    "ports": [
      { "port": 5432, "transport": "both", "destinations": "this-machine" },
      { "port": 2525, "transport": "tcp", "destinations": "any" }
    ],
    "hosts": ["sensitive.example", "192.0.2.40", "2001:db8::40"],
    "override_builtin": []
  },
  "escalation": { "port0_authority": "supervisor" }
}
```

Omitted/empty arrays remove nothing. Defaults: path access `all`, transport `both`, destinations `any`. Paths are literal absolute files/recursive trees (leading `~/` expands against the person's real home); no globs, shell expansion or relative traversal. Hosts are exact canonical DNS authorities/IP literals, all ports; no URLs, credentials, suffix matching, wildcards, CIDRs or zone IDs in A. Reject unknown keys/types, empty/ambiguous paths, malformed hosts, invalid/zero/noninteger ports and unknown built-in IDs; never truncate a policy to fit profile limits.

Normalize DNS case/IDNA/trailing dots, IP aliases including mapped IPv6 and path case/data-volume aliases. Protect named path and real target; pin ancestors for missing tails; prevent rename/unlink/repoint bypasses without denying unrelated siblings. Check hard links and root overlap both ways with existing boundary discipline. An outside-write root covering a protected child is refused. Ordinary worktree writes can coexist with a protected descendant only with final denies and namespace pins. Retain X1's launch/PATH identities and native-helper hash checks; do not turn write-only install protection into all-access denial.

Only **person-edited config**, outside agent work, can remove an eligible built-in through a loud entry:

```json
{
  "id": "service.sshd",
  "acknowledge": "REMOVE BUILT-IN NEVER service.sshd",
  "reason": "I deliberately want agents to be able to request this service"
}
```

Require exact ID/acknowledgment; reject boolean/wildcard removals, tool/request flags and environment overrides. `relay.config`, `relay.install` and `relay.authority` are **never removable (E3)**, including X1 expansions. Show removed protections in startup/doctor/approval views. Removal grants nothing: it makes the resource requestable; additive user entries still win. “Person-edited” depends on denying agents config/install/authority writes through every admitted mode; prose alone does not establish provenance.

### 4.3 Loading policy: no live watcher

Reload never at **each approval or launch**, including kept grants, resumes and overlay launch. At every checkpoint, **durably merge every observed addition into the run's never floor before approving or launching**: `floor_next = floor_previous ∪ observed_policy`. The floor is the cumulative union, not just the initial snapshot plus the latest file. Serialize/atomically merge concurrent checkpoints so no addition is lost; crash recovery and resume load the durable floor and cannot shrink it. Apply its union with current policy; removals/overrides require a new run and fresh consent. In particular, add → approve → remove → launch retains the addition. Hash built-in version, cumulative additions, eligible removals, trusted dynamic expansions and identity pins; retain prior protected identities as well as newly observed ones. Revalidate pending approvals against this floor before overlay consumption; an invalidated digest needs a new decision.

There is **no live never-config watcher** or immediate revocation claim. A running turn continues under its launch snapshot until teardown; a new entry does not retrofit its Seatbelt or close tunnels immediately. Explicitly stop/cancel if immediate effect is needed. A next approval uses updated policy even while earlier work is active. Malformed/unreadable config blocks that checkpoint with a reason, retains the durable floor and cannot fall back to defaults or a partial parse. Existing namespace/interface/broker integrity checks remain; they are not config watchers.

### 4.4 Hosts and raw-network admission

**Visible product rule: any `never.hosts` entry disables raw network in Release A.** Apply at new/kept grants, approvals, resume and launch, even if the command names another host. Reject standing raw grants too; person approval cannot bypass it. Offer a compatible mediated route, or explain E6 is deferred to B. A DNS snapshot is not host-limited raw enforcement.

An A mediated route screens canonical requested authority and resolved endpoints, then dials a screened numeric address without another lookup. Use a defined validated endpoint union for never DNS names to reject IP aliases too; fail provider admission when a required never name cannot resolve. Screen returned endpoints/CNAMEs, reject any intersection, refresh expired endpoint sets before new connections and close affected tunnels when refresh invalidates them. Shared hosting may be overblocked. With any `never.hosts` entry, Release A refuses a localhost-connect overlay outright: its direct `localhost:P` compiler cannot screen forbidden DNS endpoints, and no mediated localhost exception route exists.

This is requested-authority/validated-endpoint enforcement for mediated TCP (WP0 §2). New connections after redirects are screened; opaque CONNECT does not expose application identities/redirects inside existing tunnels. It is not content filtering or protection against arbitrary allowed remote forwarders. No mandatory raw gateway, packet provider or TLS interception in A. An unenforceable user port/host rule refuses only the affected mode/provider before launch, not unrelated offline modes.

### 4.5 Uniform enforcement and admission (E8)

Never applies to every admitted mode/tool path. **Refuse only a mode/configuration that actually bypasses it**, with the protection and reason **before launch**. A family is not disabled merely because one variant fails. These are implementation/qualification gates, not verified availability.

| Enforcement point / mode | Release A requirement and recovery |
|---|---|
| Grants, file requests, approval decision, launch | Shared resolver/hashes/two-way overlap checks. Never before approval and again at decision/launch; declared command resources cannot replace enforcement. |
| Every relay Seatbelt profile/overlay | Final credential/path/port/Mach denies after applicable allows; operation-specific precedence, X1, pins and control restrictions. Update exact-profile probes. |
| Codex stage 2 / narrower overlay executor | Broker/no-local/checked profile/readback, no TRUST. Raw plus host entry refuses; a qualified mediated plan needs fresh approval instead. |
| Codex native strict compatibility, including file tools | Stock native strict/local cannot enforce never through the measured trustd bypass. Strict needs a qualified no-TRUST executor/route or refusal of the affected variant, never root-write/unsandboxed retry. Stock 1.0.5/1.0.6 network modes are not fixed by this document. Local restoration is B. |
| Local mode | **Refused while stage 2 is enabled in A; restoration deferred to B.** Retain retirement and §5's interlock/survivor checks. Serve localhost needs through qualified stage-2 port/port-0 overlays, not unrestricted native `allow_local_binding`. Broad local capability consent remains person-only. |
| Claude | Sandbox `denyRead`/`denyWrite`, Read/Edit permission denies, proxy checks. Refuse unsandboxed permission-tool retries/settings variants defeating these. Qualify installed settings/TRUST separately. Offer explicit `escalate` when native network denials have no callback. |
| ACP | Shared outer policy/authenticated bridge; only unchanged-profile `allow_once`; restart if qualified. Copilot's KEYCHAIN/TRUST and Grok's token route bypass isolation: refuse those configurations pending separation (§8), with reason. Qualify Gemini's key-only/store-denying route separately; in-memory key secrecy is a different guarantee. |
| `allow_dangerous`, inherited hooks/settings, legacy exec | Refuse actual bypasses, not a mode merely for its name if execution stays checked. A backend lacking a qualified restart/tool route gives explicit unavailable/recovery, never an unconfined launch. |
| HTTP/CONNECT/SOCKS / known relay forwarders | Never/control denies precede public/local allowances; check literal/resolved/alias endpoints with no overlay forwarding exception. Connections belong to a turn. |
| Hosted web search / `web__run` | With any effective `never.hosts` entry, set `web_search="disabled"` and read it back; withhold both search and open-page paths (§4.6). |
| Extension MCP tools | Central semantic, tool-specific never screen before forwarding; opaque/implicit unscreenable effects refuse, independent of person consent (§4.6). |
| Views/doctor/results | Show effective never hash/version, removed built-ins, enforcement, disabled variant/reason, overlay authority/lifetime and cleanup. No unsupported confinement stamps. |

The contract concerns agent tools/executors. Trusted app server/supervisor retain login/registry authority outside it; never expose their stores or accept arbitrary unconfined callbacks. New authentication separation is B work, not an excuse to admit known bypasses in A.

### 4.6 Out-of-profile tools: withhold or screen

Hosted search, provider open-page and extension MCP effects execute outside the executor profile. **While any `never.hosts` entry exists in the effective cumulative policy, withhold hosted web search and `web__run`: set `web_search="disabled"` and require effective readback before launch**, on fresh and resumed turns and regardless of standing grants/overlay. Qualification must show both hosted search and `web__run` (including open-page) are unavailable; missing/contradictory readback refuses the configuration. Provider trust or an executor deny is not host enforcement.

**Every extension MCP call passes a central relay screen before relay forwards it**, in addition to the existing person-per-call approval. The screen applies the shared effective never floor to paths (with access semantics), ports/transports/destination scope and hosts. It is **semantic and tool-specific, never substring matching**: qualified adapters interpret that tool's actual effects and normalize URL authorities/default or explicit ports, DNS/IP aliases, paths/real targets and read/write intent under §§4.1–4.4. Screen every resource in a compound call. Redirects, implicit destinations, remote path interpretation or a later resource selection must be enforceably screened too; arguments containing one benign URL/path do not prove compliance.

A match is refused with the matching protection. **Opaque or implicit effects relay cannot screen fail closed on turns where never applies**: unsupported tools, arbitrary command/code execution, or tools whose hidden resources cannot be constrained are refused, even if person-approved. A schema alone is not a qualified effects adapter. Admission identifies withheld tools and shows the reason **before launch**; the central screen rechecks each admitted call before forwarding and refuses newly unscreenable effects without invocation. Pin adapters to qualified tool/server semantics; changed/unrecognized versions require qualification or refusal. Built-in never entries count even when user arrays are empty. Do not enable an extension on a mode that already withholds it just to add screening.

## 5. Local mode and the existing per-registry interlock (E5)

**Keep `localModeRetired`'s `stage2Enabled` blanket condition in Release A: local mode stays refused while stage 2 is on.** The measured WP0 trustd result means native strict/local cannot enforce never; the per-registry interlock only prevents conflicting execution and does not fix this bypass. Local-mode restoration, including a qualified no-TRUST executor/mediated provider if needed, is **Release B**, not an A acceptance gate. A serves localhost work with qualified stage-2 localhost-port and port-0 overlays. Broad local-network overlays are a distinct capability with person-only consent; they do not restore native local mode. Keep `localModeInterlock` and survivor checks, extended to pending overlay reservations and executor records, including after stage 2 is turned off. **No machine-wide coordination root in A.**

Before consent/launch, record effective launch class and reserve its start in the **existing registry**. Local mode conflicts with stage-2/overlay executors able to use its unauthenticated proxy, and vice versa. Include starting/running/stopping/tainted states, not just running nodes. Serialize/check transitions so concurrent starts cannot both pass. Classify from captured effective policy/overlay records, not mutable standing grants or feature flags. Include overlay turns without standing raw grants and leftovers after flag-off.

Malformed/unreadable relevant records fail closed. Detached survivors/uncertain sweeps retain quarantined records/leases and block conflicting modes until existing reap/cancel/retention proves cleanup. A pending overlay can reserve its destination, but its source local proxy must close before launch; no same-job concurrency exemption. Return blocking record ID/state and recovery. Release reservations only after proven teardown.

**Retained limit:** another `RELAY_HOME`, old relay or external forwarder is outside this registry. Snapshots/address checks help but do not establish cross-registry coordination or catch every later listener. Disclose this same-user/multiple-home limit; do not claim it is solved or add a hidden machine-wide service. Safe local/stage-2 concurrency and stronger cross-registry coordination are B considerations.

## 6. Qualification, risks and release gates

| Risk / remaining authority | Required evidence before availability |
|---|---|
| Mutable worktree code / whole-turn authority | Approval/result distinguish capability from command identity. Denied root/sibling/config/install/credential decoys after code changes; exact intended command and actual decision provenance. |
| Persistent outside writes / service API authority | Approved-root/API controls; denied parents/siblings/credential/authority decoys; symlink/hardlink/case/data-volume/missing-tail swaps and launch pins. No silent read-to-write change. |
| Broad binds / impersonation / LAN | Production overlay executor startup, ephemeral/ordinary/wildcard binds; LAN disclosure in request **and job result**; never/snapshot/broker/reserved TCP/UDP controls. Candidate 114/0 alone is insufficient. |
| Raw network / forwarding / exfiltration | Person-only, host-entry/raw refusal prelaunch; mediated authority/IP/CNAME/rebinding/TTL controls; interface/mapped-address cases and stated forwarding/NAT residuals. |
| TRUST deputies | TRUST off in admitted overlays; crafted OCSP/CRL/AIA decoys/positive controls per affected mode. Legacy residual in README/UPGRADING and doctor/admission messages; one harness cannot qualify another. |
| Restart loss/replay/authority leakage | Fake-model direct/code-mode calls; receipt-before-stop, native decline once, no hot environment/local fallback; concurrent calls, timeout/cancel at handoffs, crash before/after consume, unrelated resume, next-turn baseline. |
| Detached survivors | setsid/double-fork/nohup/native-terminal survivors, fork during sweep, process/worker death, failed sbcheck, unreadable records. Failed cleanup blocks restart/local conflict and lease reuse. |
| Policy/approval races | Never additions pending/between allow and launch, malformed config, kept grants, namespace swaps, absent person path, spoofed confirmation and competing decisions. Checkpoint semantics, no live revocation claim. |
| Interlock / long MCP calls | Both directions, simultaneous starts, overlay-only/flag-off/tainted records; independent-home residual. Configured wait/restart/overlay budget, cancellation and result delivery without replay. |
| Harnesses / tool paths | Actual native/outer profiles, Bash/file tools, store isolation/settings/native bypass refusal. Unsupported variants fail before model work; compatible variants stay available. |

### 6.1 Acceptance tests for confirmation d_516f2cd5

These are required integrated qualification/red-team cases, not results verified by this docs revision. Each refusal must happen before the forbidden effect; use positive controls to establish the tool/profile/decision route actually works.

| Resolution | Required acceptance evidence |
|---|---|
| 1 — Out-of-profile tools (§4.6) | With a never-host entry, attempt forbidden URLs through hosted search and `web__run` open-page in direct/code mode, fresh/resumed and overlay turns: `web_search="disabled"` is read back and neither path can fetch. Missing/overridden readback refuses launch. Through extension tools attempt forbidden paths, ports and hosts, including URL case/IDNA/default-port variants, IP aliases, symlink/missing-tail paths, compound calls and redirects/implicit resources. Matches and unscreenable effects never reach the extension server. Opaque tools show the refusal reason before launch even with person consent; permitted, semantically screenable calls have a positive control. |
| 2 — Arming order (§2.2 step 7; confinement §2.2) | Rerun the broker §14 production-order first-tool-call test **without manual `arm()`**: relay's first call succeeds immediately after the validated `turn/start` reply, including when readback retries; a self-started turn's call remains refused. Inject identity/readback mismatches: broker disarms, app server dies first, turn fails and executor is torn down. From source: the confirmation reports a passing live first-call test; that does not replace this integrated rerun. |
| 3 — Local deferred (§5) | With stage 2 on, local mode is refused before launch despite person consent, no active raw job, or an otherwise empty interlock. A qualified stage-2 localhost-port overlay and a port-0 server/test succeed with never/control decoys denied and LAN text present. With stage 2 off, pending/stopping/tainted overlay records still block conflicting launches; no local-restoration success gate is claimed for A. |
| 4 — Authenticated decider (§3.1) | Nested delegation, an arbitrary ancestor, forged root/`decided_by` labels, continuation authors and `reason` prose cannot approve. Missing/wrong owning-root token/session and a swapped identity/digest refuse. Valid owning-root authorization succeeds only for eligible effects; a person-only request without a person channel returns `person_path_unavailable` and is never downgraded. Race competing authenticated allow/deny/cancel decisions: one terminal result and at most one consumption, with immutable actual provenance. |
| 5 — Deadline (§2.4) | Check finite 3600 s default with null baseline timeouts and tighter finite bounds. Expire immediately before consumption (no launch), immediately after consumption (stop partial/running launch), and during pending approval or an approval pause in the overlay (no late allow or timer reset). Test detached survivors (tainted/quarantined), worker death followed by reap using the recovery deadline, and uncertain recovery clocks. Observe app-server-first stopping; no baseline/replacement starts while the old executor or survivors remain. |
| 6 — Monotonic floor (§4.3) | Exercise **add → approve → remove → launch**: the addition remains in the durable floor and is enforced or the launch is refused. Repeat through kept grants and resume, including worker restart; concurrent checkpoints retain the union of all additions. Malformed/unreadable policy refuses approval/launch without shrinking the saved floor; stale hashes/decisions cannot bypass revalidation. |

Use scratch homes/credentials/registries, decoy listeners and fake models. Denials need allowed positive and intentionally weakened-profile controls; timeout/EADDRINUSE is not a denial oracle. Never contact real credential stores or real services (ports 22 and 5900, or any listener the person runs). Substitute owned high-port decoys through the **production generator**; inspect real constant inclusion without connections. Report attempted coverage and omissions, not just zero oracle events.

Update stable-surface config fixtures for `never`/port-0 authority; tool fixtures for `escalate`; request/decision/node/event/result fixtures for explicit capability, turn and provenance fields. Preserve existing field types/standing `scope:"job"`. Update README, UPGRADING, confinement summaries, doctor and pinned-Codex qualification/release-watch obligations. This design commit changes no production code or fixtures.

Package checks: build/typecheck and focused behavioral tests. Integrated gates: full suite, qualification on pinned Codex including broker/restart additions, oracle-backed red-team, Daybreak confirmation and report through the lead. Host-only tests go to the lead; no outside-sandbox runs are requested by this design task. No push/tag/deploy/release authorized here.

## 7. Known limits and settled choices

The **1.0.5/1.0.6 strict-mode trustd residual** remains: a network-enabled Codex job can induce certificate-driven blind GETs to local endpoints via admitted trust services. The lead measured owned loopback ports, OCSP/CRL and redirects, not actual never services or arbitrary response access. The no-network-grant control produced no fetch. Relay cannot fix an already-running native profile with a deny inside child commands. Stage 2's no-TRUST avoids the measured route; native strict/local cannot supply A's never guarantee, so local remains refused while stage 2 is on and restoration is deferred to B. The interlock is not a trustd mitigation. Claude is unverified. Route/refuse A's affected variants per §4.5; a warning is not enforcement.

Other limits: next-checkpoint policy additions, agent-editable code/whole-turn overlays, irreversible writes/data learned, service authority and remote forwarding, IPv6 overblocking, per-registry coordination and trusted supervisor/app-server/same-user/root boundary. Report alongside qualified behavior.

| Earlier ID | Release A disposition |
|---|---|
| E1 | **Settled:** restart-only `escalate`; no helper/patch/PTY dispatch or native redirect. |
| E2 | **Settled:** narrow in-scope effects and port-0 tests/servers supervisor-approvable; single port-0 config point, LAN disclosure twice; broad raw/local person-only. |
| E3 | **Settled:** loud person-edited eligible overrides; config/install/authority never removable. |
| E4 | **Settled:** local-service port semantics; D5 extras/snapshot baseline, existing IPv6 overblocking disclosed. |
| E5 | **Settled for A:** local stays refused while stage 2 is on; extend existing per-registry interlock, no machine root. **Restoration deferred to B**; A localhost needs use overlays. |
| E6 | **Deferred to B:** host-limited raw. Any host entry disables A raw. |
| E7 / WP7 | **Deferred to B:** measured trustd result rules out even person-only TRUST in A. |
| E8 | **Settled:** uniform never; refuse only actual bypassing modes/configurations, with reason before launch. |

**Open questions:** no A product-scope decision needs reopening. Record migration/state transitions, deadline-derived timeout padding and per-mode qualification are implementation/review gates. Failed gates withhold affected variants, never silently expand A or require a B provider to ship.

## 8. Release B: explicitly deferred

Absent from A's mechanism, estimate and gates; revisit when a real task needs them with separate design/estimate/review:

- **E6:** host-limited raw, mandatory egress gateway/controlled DNS/packet mediation and honest hostname-versus-endpoint semantics. A keeps mediated checks and refuses raw with any host entry.
- **WP7:** fully confined Go/Swift platform TLS, mediated/isolated trust services or isolated macOS provider. Tool-supported file-root workarounds can qualify without TRUST, but do not establish general platform TLS. No A TRUST request or person-only escape hatch.
- Per-command helper, frozen patch runner, escalation PTY/input handles, transparent wire routing; command/job-lifetime escalation APIs; arbitrary AF_UNIX/executable/OS providers. Optional future work, not a promised B bundle.
- Credential/executor separation for incompatible Copilot/Grok and other harness variants. A checks admission/refuses actual bypasses rather than building new auth architecture.
- Local-mode restoration with qualified never enforcement/no-TRUST execution; native strict/local plus the interlock does not meet that gate.
- Live never watcher/cancellation, machine-wide/cross-registry coordination and safe concurrent local/stage-2 execution. None underlies A's guarantees.

The old WP5 architecture tranche and WP7 providers are **Release B**, except bounded shared-policy/admission wiring and qualification required in A. Broker hardening and pinned-Codex qualification remain independent A prerequisites.

## 9. Work packages and estimate

**Assumptions:** Codex implements via relay write jobs; the lead coordinates, reviews each package and runs host qualification. Broker/pinned-Codex dependencies are ready. Effort includes focused tests/review fixes, excludes waits/dependencies, new virtualization and auth architecture. This design starts no workers/probes.

| Package | Concrete A output / acceptance | Depends on | Codex effort |
|---|---|---|---|
| WP0: feasibility evidence | **Research complete for A's scope choice:** 114/0 candidate binds, measured TRUST rejection. Later report supersedes unresolved trust note; production checks stay WP6. | WP0 receipts/lead report | No new research tranche; evidence integration in WP6 |
| WP1: shared never policy and tool screen | Additive schema/built-ins including Codex home/X1, eligible overrides/non-removable **durable cumulative floor**, identities/hashes/checkpoint races; grants/file/decision/launch checks; shared profile/proxy inputs. Central semantic extension screen with bounded qualified adapters and fail-closed refusal for every unsupported/opaque effect; hosted search/`web__run` withholding and readback. No watcher/auth provider. Accept §6.1 resolutions 1 and 6. | Scope here; PC home/store contract | **2–3 days** |
| WP2: restart overlay lifecycle | Typed overlays, destination-bound consume-once state, durable receipt/closing handoff, teardown-before-restart; §14 identity → arm → readback order. Trusted monotonic **3600 s default** deadline, persisted recovery deadline, expiry stopping/taint/reap and baseline gating. Exact root/local-port/port-0/network deltas and final floor; no command/patch dispatcher. Accept §6.1 resolutions 2 and 5. | WP1; broker/pinned executor | **2–3 days** |
| WP3: tool, approvals/accounting | Broker `escalate` independent of delegation; `required_decider` enum, authenticated owning-root session/token binding in digest, atomic competing decisions and qualified person paths; single port-0 authority key; mutable-code/LAN text and job result; deadline-derived `tool_timeout_sec`/readback. Accept §6.1 resolution 4 and approval-time expiry. | WP1; WP2 interfaces | **1.5–2 days** |
| WP4: retained local refusal / adapter wiring | **No local retrofit or restoration in A.** Retain blanket retirement; extend per-registry overlay/executor/taint reservations/interlock, including flag-off leftovers. Wire WP1's shared never/admission checks into existing Codex/Claude/ACP adapters; refuse unqualified variants. No auth separation/global coordinator/B provider. Accept §6.1 resolution 3. | WP1–3 | **0.5–1 day** |
| WP6: qualification/docs/integration | All six §6.1 acceptance groups, production decoys, hosted/open-page and extension bypass attempts, fake-model first-call/restart/replay/cancel, deadline/worker-death/reap and monotonic-floor races, authenticated authority red-team, interlock/local-refusal tests, host/raw refusal, trustd disclosures, long MCP/result tests, stable surfaces/docs, combined gates and lead review. | Interfaces early; integrated WP1–4 last | **2–3 days** |
| WP5 / WP7 | **Release B:** broader harness credential architecture / isolated raw-host and TLS providers. Separate feasibility/estimate when needed, outside this total. | A and a concrete task | **Not estimated for A** |

**WP1–4 and WP6 total: 8–12 working days sequential.** With at most two bounded implementation jobs against agreed interfaces and lead review/integration, allow **about 6–9 working days wall time**; confidence medium-low until WP1's tool-screen interfaces and WP2's supervisor/recovery deadline integration are settled. Compared with the prior 6.5–11 days, WP4 shrinks by removing local restoration, while semantic screening, durable floor/authority/deadline handling and the expanded qualification add work. Estimates assume a bounded qualified extension catalog, with all other effects refused, rather than universal tool inference. If a mode cannot enforce never, A's fallback is explicit variant refusal, not unestimated B implementation. Local restoration is neither estimated nor advertised as an A outcome.

Order: lead approves interfaces/scope → WP1 → WP2/WP3 → WP4 → WP6 integrated checks → lead release decision. Review diffs before merge; use small logical commits. Implementation commit messages end with a blank line and `Co-Authored-By: Codex <noreply@openai.com>`. Relay manages this delegated design job's final commit; no production code is written here.
