---
status: accepted
---

# Standing design and policy decisions

Relay's behaviour rests on a set of decisions the maintainer made while building 1.0 and 1.1 that are not obvious from the code: why relay does not block same-family work, why nothing times out by default, who may approve what, and which gaps are accepted and disclosed rather than enforced. They are collected here so that a reader of the code, the README or a test that cites one can find the reason. Dates are when the decision was made; decision and review ids (D2, C6, `r_…`) are the ones the code and docs cite. Where a decision is an accepted limit, the user-facing statement of it is in the README's "Known limits".

## Families: steer, don't block

Relay steers each agent to its own family's native subagents for its own family's work, and to relay for another family's. It does not refuse deliberate same-family work or a caller whose family it cannot tell: those are allowed by default and labelled, and every result names both sides' families (`families`), so same-family or unknown work is never presented as cross-family. A call that omits `target` never picks the caller's own routing family. Admission is strict only by opt-in, `same_family: "refuse"`. Behaviour evals of the steering, and real-agent gates on macOS, stay release gates.

Why: a hard block broke legitimate uses (a host with no subagents of its own, a person who wants a second opinion from the same family) and invited agents to work around it; labelling keeps the person able to see what ran.

## What relay limits, and what it does not

- Relay drives each agent through its own login and does not ask for API keys. The exception is a key-only target (Gemini), whose key relay hands over only when the person opts in for that target.
- A write job's writes are confined to its worktree by default. There are no bypass modes unless the person configures one.
- The only hard limits are depth and concurrency. There are no default timeouts on jobs, turns or waits, and no default length limit on a discussion (2026-10-15, 2026-10-16). Liveness reporting (what an item last did, how long it has been quiet) is report-only and stops nothing.
- Raising a call's speed costs the person money or allowance, so only the root session may raise it; launched agents run at their job's speed or slower (2026-10-16). Whether a speed is offered is decided from the account's own catalog, never from a table of plans; the plan is named only to explain a refusal.

## Approvals and consent

- The supervising (root) session decides approval requests from the agents it launched: it approves what is clearly in scope and escalates what is uncertain to the person. Only the root session approves, never an intermediate launched agent. On a Codex root, Codex's own guardian reviewer answering the root's `approve` call is acceptable.
- A Codex decline or cancel that cannot be attributed to the person is reported as `host_answered_prompt`, not as the person's dismissal. An explicit deny given in the form still binds.
- A Codex subagent thread (the `relay-<target>` proxy role) may not originate or forward grants. A job that needs one has its parent session make the relay call itself (review C6, 2026-10-17).

## Probes and tests never touch the person's files

The per-turn confinement probes must never rename or touch the person's own directories. They aim at relay-owned decoys wherever possible. The rules that protect the person's own paths (their checkout and its parent, siblings and `.git`, the real home, login stores, the harness's binary directory) are covered by tests of the profile generator against scratch copies, not by a live write (decision C3, 2026-10-16). The test suite follows the same rule: no test may aim at a real file on the developer's machine; every test file loads `test/helpers.ts`, which gives it a scratch HOME, and a guard test checks that it does.

## Relay-owned confinement details

These refine [ADR 0001](0001-relay-enforced-confinement.md):

- Named POSIX semaphores are allowed only under `/mp-`, so Python's multiprocessing works. The residual is accepted and documented: the name space is machine-wide, so another process's `/mp-` semaphore is reachable by its random name, which there is no call to list (2026-10-16).
- A login directory a harness refreshes by temp file and rename (Grok's `~/.grok`) is writable in a confined turn only for its exact names: the token file, its lock and its temp-file pattern (decision D10, 2026-10-17, "Exact-name renames"). Relay checks the store before and after every turn, and an unsafe store fails the turn with its offending entries quarantined by rename (2026-10-18).
- Relay's design draws on OpenAI's and Anthropic's own implementations in Codex and Claude Code, for the interaction system and especially the sandbox (2026-10-16).

## The never floor

- With stage 2 off, `never.paths` and the built-in entries are disclosure for Copilot, Gemini and Grok, not enforcement: they stay out of those agents' sandbox profiles, because Copilot's and Grok's login routes would otherwise be cut. `relay doctor` and the README say so per target and stage-2 state (2026-11-04, relay 1.1.3).
- From the release after 1.1.3, Claude jobs take the floor whether stage 2 is on or off, with its gates (inherited settings, hooks and MCP servers, managed settings, `allow_dangerous` writes refused). The cost, accepted: a Claude job loses commands approved to run outside its sandbox. Codex's sandbox takes the floor on every sandboxed turn. One predicate decides which targets take it when: `src/core/never-coverage.ts` (2026-11-04).
- **Keychain IPC for Claude jobs and network-on Codex turns is accepted and disclosed, not enforced** (2026-11-04, review `r_07de0a44` X1). The floor denies the keychain files, but only relay's own Seatbelt denies the security daemons; Claude Code's sandbox allows them on every turn, and Codex's network profile allows `com.apple.SecurityServer`. Enforcing it for Claude would mean relay's own Seatbelt around Claude, which would also block Claude's keychain login (the same conflict that refuses Copilot and Grok under the floor); for network-on Codex turns stage 2 already closes it. Measured the same day: reading an item in a file-based keychain needs its keychain file as well as the daemons, so the file deny keeps such items (for example `gh`'s keyring token) out of reach. Not covered: data the daemons serve without a keychain file, such as data-protection items, and a copy of a keychain file kept outside the denied directories. Revisit if the decoy-keychain checks show retrieval beyond items trusted to `/usr/bin/security`, or if more CLI tokens move into the keychain.
- The Claude floor is checked every release by release check `claude-floor` (an installed Claude with stage 2 off, and a decoy keychain, floored and its control), qualification item 33 (the Codex decoy keychain, floored and its control with network off and on) and one signed-in Claude turn under the keychain login.

## Accepted risks and deferrals

- **The keychain arm of the red-team is deferred to 1.0.x** (2026-10-21). No adversarial run has tested what a confined agent can reach through the keychain downgrade; it matters mainly for Copilot, whose login lives in the keychain. `docs/security-model.md` states the limit.
- **A Codex job can read a Gemini key file.** Codex's own sandbox has no read denial, so a Codex job can read relay's Gemini key file, as it can the rest of the disk (`~/.ssh`, Codex's own `auth.json`). Accepted and documented; relay-enforced read confinement for Codex is a later design.
- **Local mode is refused while stage 2 is on** (decision D2; review R3, 2026-10-28): Codex's local-mode proxy has no authentication and would reach every denied port. The interlock that keeps local mode and raw network apart with stage 2 off is per registry: a relay with another `RELAY_HOME`, an older relay, and forwarders outside relay are outside its scope. No machine-wide coordinator is planned.
- Copilot ships as an experimental target (2026-10-17); Gemini is qualified with its documented limits accepted (2026-10-22). The README's "Known limits" lists both sets of limits.

## Hosts

- The Claude desktop app's entry is named `relay-desktop`, so that Claude Code tab sessions keep their own `relay` entry (2026-10-16).
- Relay disables every built-in plugin of a Claude job but one: Claude Code's deny-only privacy hook, which refuses putting the signed-in account's email into a client's identity. It is kept only on Claude Code versions whose copy relay has read (2026-11-16).

## Release triage

Only a possible false pass, or a hole in confinement or consent, blocks a release. A step that produced no result may be rerun once, and the rerun is recorded; a step that produced a wrong result blocks until it is fixed or explained. Release gates run Codex from the sealed pin, checked by hash (2026-11-03).

## Consequences

- Several of relay's guarantees are statements of what it does not enforce. Each such statement must appear where a person will read it: the README's "Known limits", `relay doctor`, and the per-target docs.
- A change that would move a decision here (a default timeout, blocking same-family work, an intermediate agent approving, enforcing keychain IPC for Claude) needs a new ADR that supersedes the relevant section.
