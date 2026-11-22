# relay

Relay lets coding agents of different model families work together the way native subagents work within one family: a session hands work or a question to another family's agent, and relay launches it, confines it, routes its permission requests back, and reports. It runs on macOS only.

This describes relay 1.3.1: the words its documentation, tool results and `relay doctor` use, what each means, and the words to avoid for it. Names in backticks are what you type in relay's config or a tool call.

## Who is involved

**Family**:
The company whose models do the thinking: Anthropic, OpenAI, Google, xAI. A harness that runs several companies' models (Copilot, Cursor) is not a family; the model decides. Relay connects different families by default (see cross-family rule).
_Avoid_: vendor, provider, model family (in prose)

**Cross-family rule**:
Leaving the target out never picks the caller's own family; what it reaches is labelled, and the label can be unknown. Naming one's own family, and calls from a session whose family relay cannot tell, are allowed and labelled unless same_family is "refuse".
_Avoid_: same-family check

**Same-family setting**:
The config setting (`same_family`): "allow" by default, with "refuse" as strict opt-in. Native subagents remain the first choice for one's own family.
_Avoid_: same-family mode

**Target**:
What a caller names to say whom it wants to reach (`claude`, `codex`, `copilot`, `gemini`, `grok`, …): a harness plus, where the harness runs several families' models, the model that decides the family.
_Avoid_: backend, provider, agent type

**Experimental target**:
A target whose harness has not passed qualification on this machine. It is off unless the person switches it on, and says that it is experimental wherever it is offered. Copilot and Grok are experimental (`targets.<id>.experimental: true` switches one on); Gemini was qualified on 2026-10-22.
_Avoid_: beta, unsupported

**Key-only target**:
A target whose harness has no account login relay can use, so it signs in with an API key the person keeps in a file of their own (Gemini: `~/.config/relay-keys/gemini-api-key`). The one exception to launching agents on their own logins: relay hands the key to that target's process alone, only when the person opts in for that target by name (`targets.<id>.child_auth: "any"`), and never logs or stores it.
_Avoid_: API-key mode, BYOK

**Harness**:
The command-line coding agent program relay launches for a target (Claude Code, Codex, Copilot CLI, Gemini CLI, Grok Build, …).
_Avoid_: CLI (when the program itself is meant), runtime

**Host**:
A program a person works in where relay is installed so its sessions can call relay (Claude Code, Codex, the Claude desktop app, the ChatGPT app). A host may run several families; its profile governs approval UX separately from family routing and labels.
_Avoid_: client, frontend

**Root session**:
A session the person is working in, as opposed to a launched agent's. It may start runs, grant their extra permissions and cancel them; it need not own a run to join a room. Under the Claude desktop app's own entry (`relay-desktop`), several conversations share one relay process; each is a root session of its own, by the session token its model carries (README, "Claude desktop app and Cowork").
_Avoid_: main session, parent (parent is relative)

**Launched agent**:
An agent relay started for a target, as part of an item in a run.
_Avoid_: child (relative), worker, subagent

**Prompting brief**:
A short text, written by a family's own model, on how to write a task or question for that family's agents, with dated notes on its models. Shipped as a skill in each host that reaches the family, and returned by the `brief` tool.
_Avoid_: prompt guide, style guide

## What relay keeps track of

**Run**:
Everything one root session has started through relay, as a tree of items. (On the desktop app's shared relay, `relay-desktop`, each conversation has runs of its own, by its session token.)
_Avoid_: session (overloaded), tree

**Session token**:
What a conversation on a shared relay (`relay-desktop`) carries on every call as `session_token`, so that relay keeps its runs apart from the other conversations of that process. Relay issues it on the conversation's first call and keeps only its hash. A bearer key: whoever presents it acts as that conversation.
_Avoid_: session id (an agent's own session has one), conversation id (the host's, which the desktop app does not send)

**Room** (1.3.0):
A person-authorized local exchange between exactly two root sessions, created at the person's terminal or, on a qualified host, by a conversation on the person's yes in that host's own prompt. It has members and a transcript, owns no run, and is outside the item namespace. Relay launches nobody; same-family pairs are allowed.
_Avoid_: discussion, thread, channel

**Room member**:
One ordinal seat, with a relay-written label, bound to an existing relay owner. Re-seating changes its owner, preserving the transcript and turn budget.
_Avoid_: participant (a discussion role), supervisor

**Room invite**:
A hashed-at-rest, one-use, ten-minute code issued by a terminal write or, for the second seat of a room a conversation opened on the person's yes, on the person's clipboard (never in the opening conversation's result); always inside a prompt for one seat that only the person's paste delivers. It enrolls a root session and conveys no run rights. A room still waiting for that seat ends when its invite lapses unused; a room's 24 hours count from its creation.
_Avoid_: room key, adoption ticket

**Room message**:
Information from a member's model or a terminal, with separate text and relay-written sender fields. It is never consent or an instruction from the person.

**Room cursor**:
The highest transcript sequence the caller states it has read. Reads do not consume messages. This is a protocol assertion, not proof of model comprehension.

**Item**:
One entry in a run: a job, thread, discussion, review or participant.
_Avoid_: node (outside code), task

**Job**:
Work handed to another agent with `delegate` (of another family, unless same-family calls are allowed). A write job works in its own worktree on its own branch; a read job may not change files.
_Avoid_: task, delegation

**Thread**:
A read-only consulting session started with `ask` and continued with follow-up questions.
_Avoid_: consult, conversation, chat

**Discussion**:
A turn-by-turn exchange between the caller and one other agent (of another family, unless same-family calls are allowed), each message ending with a marker, until both agree or one names the crux, or at a length limit the caller set (there is none by default).
_Avoid_: debate, chat

**Participant**:
The other side's session in a discussion.
_Avoid_: opponent, peer (as a noun for this role)

**Marker**:
The closing word of every discussion message, on its own last line: CONTINUE, AGREE or CRUX.

**Review**:
An independent review by another agent (of another family, unless same-family calls are allowed), of code or of a plan, withheld until the caller's review is saved (accepted only once the reviewer has settled) or skipped, then reconciled in a discussion into a consensus list and a verdict.
_Avoid_: second opinion, audit

**Plan review**:
A review whose target is a plan for work not yet done (its file, or its text) rather than code.

**Consensus list**:
The outcome of a review: every item from both reviews, each agreed, dropped or unresolved. An item is agreed or dropped only where both closing blocks give it that status and the same severity; anything else is unresolved, with each block's position.

**Closing block**:
The JSON block each side ends a review's reconciliation with: its consensus entries, and its verdict and coverage for the two reviews together. Each side's verdict and coverage are kept in the result under `closing`; the review's verdict, and each item's status, are what both closing blocks reach.

**Coverage**:
What a reviewer declares it examined and did not. Complete only when declared `complete` with nothing listed as not examined; relay never judges it.

**Verdict**:
A review's overall call: pass, fail or unknown. A pass over coverage that is not complete is recorded as unknown, and a review or closing block that declares none of the three is recorded as not stated. Once reconciled, the review's verdict is the one both sides' closing blocks reach (not stated if neither declares one), and unresolved otherwise. A closing block's pass over something both reviews declared not examined is unknown unless the block lists it as examined.
_Avoid_: approval (that is something else), rating

**Turn**:
One launch of a harness to answer one message for an item.
_Avoid_: step, invocation

**Blocked**:
The status of an item whose last turn finished but whose harness reports that the agent was refused something on the way (a permission denied, an approval request declined), so its work may be incomplete. The turn itself counts as done.
_Avoid_: denied (for the item), failed

**No changes**:
The outcome of a write job whose turn finished with its worktree exactly as it started, so there are no changes to merge (files git ignores are not counted). Status reports it as `outcome: "no_changes"`.
_Avoid_: empty, no-op

**Call request id**:
An optional key the caller gives a call that starts something (`delegate`, `ask`, a new discussion or review), so that the same call repeated, say after a timeout, returns what the first one started instead of starting it again. Named `request_id` in tool arguments.
_Avoid_: approval request id (an approval request's own id, also `request_id` on `approve`), idempotency key

**Speed**:
How fast a launched agent's model answers: `standard` (the default, pinned on every turn), `fast`, or `ultrafast`. A faster speed costs the person money or allowance (Claude's fast mode is billed to usage credits; Codex's faster service tiers use more of the plan), so only the root session raises it: work a launched agent starts or carries on runs at that agent's own speed or slower. Status shows the speed requested, since Codex does not report the tier that served a turn, and what Claude reported about its fast mode.
_Avoid_: service tier (Codex's name for it), fast mode (Claude's), priority

**Depth**:
How many relay hops an item is from the root session. One of relay's two hard limits.

**Concurrency slot**:
Permission for one launched agent to be running; how many may run at once is relay's other hard limit.

## Permissions

**Grant**:
Extra permissions the root session gives a job when starting or resuming it: network access, extra writable directories.
_Avoid_: allowance, escalation

**Approval request**:
A launched agent asking to do something its confinement does not allow, which the root session or the person decides. Under relay-enforced confinement an approval lets the agent go ahead inside its sandbox and never lifts the boundary; a Codex job under stage 2 asks for more with `escalate`, for its next turn. Relay declines a request to run a command outside the sandbox itself.
_Avoid_: permission request, escalation request

**Consent request**:
A harness asking whether to take an action its confinement already allows (an edit in the worktree, a command). Relay routes it like an approval request, but an answer covers that one action only and never widens confinement.
_Avoid_: approval request (that asks to go beyond confinement), escalation

**Approval scope**:
How far an allowed approval request reaches: once, or the rest of the job. For a Claude agent's web request the rest of the job covers its web tools (WebSearch, WebFetch) only, never its shell commands' network.

**Approval dialog**:
Relay putting an approval request to the person directly, in the host's own question dialog. Withheld where Claude Code's permission mode, or a hook that can match relay's server, could answer it in the person's place. Closed without an answer it decides nothing (`user_dismissed_prompt`); an answer the host gave on its own that decides nothing, such as Codex's automatic decline, is reported as `host_answered_prompt` and not attributed to the person.
_Avoid_: elicitation (outside code), popup

**Confirmation**:
The person approving a request through the host's own permission prompt, when the agent proposes to allow it with `confirm`. Withheld separately from the approval dialog: by a permission mode that skips prompts, or a hook that can match `mcp__relay__confirm`.
_Avoid_: grant (that is something else)

## Confinement

**Confinement**:
What keeps a launched agent's writes inside its worktree (and granted directories) and its network off unless granted. Network off still lets every harness reach its company's inference endpoints (under relay-enforced confinement, through relay's proxy).
_Avoid_: sandboxing (when the general idea is meant), isolation

**Verified confinement**:
Confinement provided by the harness's own sandbox, which relay configures for each turn and checks took effect before the agent acts.

**Relay-enforced confinement**:
Confinement provided by relay's own Seatbelt sandbox, built for each turn: around the whole harness for Gemini, Copilot and Grok, and around Codex's command executor under stage 2.

**Extension**:
A skill or MCP server a Claude or Codex job or thread is given beyond relay's isolation: allowed for its target in config (`targets.<id>.skills`, `targets.<id>.mcp_servers`, the servers defined in relay's own `mcp.json`), asked for by the root session on the call (`extensions: true`), and consented to by the person before the agent starts. None unless all three. In this release only skills work: a job or thread given an MCP server is refused until a qualified adapter can screen that server's calls against the never floor. See [Extensions](docs/usage.md#extensions).
_Avoid_: plugin (Claude Code's own term), add-on

**Gateway**:
The part of a launched agent's own relay server that starts the extension MCP servers its turn was given and offers their tools as `<server>__<tool>`, forwarding a call only once it is allowed and only while the turn lasts. The servers are never configured in the agent's CLI.

**Person-only request**:
An approval request only the person can allow, in relay's approval dialog where the host is known to show it to a person, or in the host's permission prompt through `confirm`; never the root agent or a command (`relay approve`), which may only deny it. Enforced on relay's tools and commands; relay does not confine the root session's own shell. The request for consent to a session's extensions (kind `extensions`), a call of an extension server's tool (kind `mcp`), and every request from a session that holds MCP servers. Marked `person_only` where relay shows it.
_Avoid_: consent request (that is a harness asking about an action inside its confinement)

**Broker**:
The part of relay, outside a relay-enforced sandbox, that serves relay's tools to the agent inside it with exactly its turn's authority: over a Unix socket for Gemini, Copilot and Grok, and over authenticated HTTP (the `relay_tools` server) for a stage-2 Codex turn.

**Bridge**:
The forwarder a confined agent runs as its relay server, which can only pass messages to its turn's broker.

**Never floor**:
What no launched agent's commands may reach, whatever they are granted: credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, the CLIs' logins, the keychain files), relay's own config, install and state, some of this Mac's services' ports, and the paths, ports and hosts of your `never` config. It binds Claude and Codex jobs always, and Gemini jobs while stage 2 is on; relay's own files are protected from every agent. Where a route cannot enforce an entry, relay refuses the turn. See [the never floor](docs/configuration.md#the-never-floor).
_Avoid_: deny list, blocklist

**Network mode**:
What a job's commands can reach once it has the network. **Strict**: through Codex's own network proxy, HTTP(S) to public addresses only (Codex, stage 2 off). **Local**: strict plus this Mac's loopback and your LAN, with the person's consent (`local_network`; Codex write jobs, stage 2 off). **Mediated** (stage-2 mediated): through relay's own HTTP(S)/SOCKS5 proxy for the turn, public hosts only, screened against the never floor (Codex under stage 2). A Claude job's network goes through a per-turn proxy of relay's too, which refuses non-public addresses in the same way. **Raw**: TCP, UDP, ssh and DNS to the internet, your LAN and tailnet, and this Mac's loopback but its denied ports, with the person's consent (`raw_network`; Codex write jobs under stage 2). Gemini, Copilot and Grok given the network get IPv4 to anything but this Mac's own addresses.
_Avoid_: network level, sandbox mode

**Boundary probe**:
A check, run just before a launch under the exact sandbox profile that launch will use, that tries each forbidden action (writing outside, reaching relay's directory, connecting out) and refuses the launch if any succeeds.
_Avoid_: canary (outside code), self-test

**Temporary home**:
The per-turn home directory relay gives a harness under relay-enforced confinement, so nothing the agent writes to "home" outlives the turn.
_Avoid_: fake home, sandbox home

**Token file**:
The one file in a harness's own login store that relay lets the harness rewrite (to refresh its login), named exactly; relay never reads it.
_Avoid_: credential file, auth file

**Qualification**:
A recorded check, run on real CLIs, that a version of a harness meets relay's requirements: signed in, for a target (one that has not passed it is experimental), and model-free, for a Codex release before it becomes a pin. The records are in `docs/qualification/`.
_Avoid_: certification, validation

## Codex

**Pin**:
The one Codex release relay runs, kept unchangeable in relay's pin store (`~/.local/share/relay-codex-pins`), downloaded and checked (npm's integrity, Apple's signature, OpenAI's Team ID, the version) and qualified. Relay refuses Codex without one, unless `targets.codex.pinned` is false. A **local pin** is one you qualified on your Mac with `relay qualify-codex`; it takes precedence over a shipped one.
_Avoid_: Codex version (when the qualified copy is meant)

**Shipped pin**:
The pin a relay release carries (`codex-pin.json`): one Codex release the maintainer qualified with exactly that relay build, put in place by `relay install codex --write`. It is the maintainer's qualification, taken on trust for your Mac.

**Build identity**:
A hash of the relay build that is installed: its own files (`dist/`, the qualifier and the tests it runs) and its dependency lock. A shipped pin names the build it was qualified with, and relay refuses Codex under it when the running build differs.

**Stage 2**:
An optional way of running Codex (`targets.codex.stage2`, off by default) in which Codex's commands and file edits run in an executor relay starts inside its own Seatbelt sandbox, while Codex's app server stays outside. It brings mediated and raw network and the `escalate` tool. See [Codex raw network (stage 2)](docs/configuration.md#codex-raw-network-stage-2).
_Avoid_: stage two, executor mode

**Daybreak**:
OpenAI's Trusted Access for Cyber programme for Codex. `targets.codex.daybreak: true` requests it for eligible models, for the enrolled account holder's own use only.

## Hearing back

**Event**:
Something in a run its root session should hear about: an item settled, an approval request filed, a discussion reply arrived, a person decided an approval request.

**Notice**:
The short pointer relay posts into a host session about an event, naming the item and what to call next; never the other agent's own words.
_Avoid_: notification (reserved for desktop notifications), message

**Liveness**:
What status reports about a running item: when its agent last did anything, how long it has been quiet, what it last started, and the files a write job has changed so far. Report-only: relay stops nothing for being quiet.
_Avoid_: heartbeat, health

**Desktop notification**:
An optional macOS banner about an event, off unless the person turns it on.

**Family label**:
Relay's conservative record of each side: a known family or `unknown`. Caller contributions combine over time; waivers and unknown model reports lower the launched label permanently.

**Routing family**:
The registered root family while the client name agrees, or the launched agent's current verified model family. Visible root overrides lower labels without changing routing.

**Relation**:
The relation of one item's caller and launched labels: `cross-family` only when both are known and different, `same-family` when known and equal, otherwise `unknown`. It describes this pair, not its descendants.
