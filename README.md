# relay

Relay lets coding agents of different model families hand work to each other. From a Claude Code
session you can delegate a task to OpenAI's Codex, ask it a question, argue a design out with it, or
get its independent review of your work; from a Codex session you can do the same with Claude.
Gemini CLI can join as a target, and GitHub Copilot CLI and xAI's Grok Build as experimental ones.

Every agent relay starts is confined by default: in its vendor's own macOS sandbox, which relay
configures and checks (Claude Code, Codex), or in a sandbox relay builds for each turn (Gemini,
Copilot, Grok). A few settings you can choose take jobs outside that; [Security model](#security-model)
names them. Relay is one stdio MCP server that you register with each host you use. It runs on macOS only.

## Why use it

- **A second opinion from another model family**, without leaving your session. `ask` puts a
  question to the other agent mid-task and keeps the thread for follow-ups.
- **Cross-family review.** `review` has the other agent review your code or plan without seeing
  your own review, then reconciles the two into one list. An item is settled only where both
  sides' closing statements agree.
- **Delegation.** `delegate` hands a chunk of work to the other agent. A write job runs in its own
  git worktree on its own branch, and you merge exactly what its result showed you. The agent you
  delegate to can delegate back across in turn.
- **Discussion.** `discuss` argues a question out turn by turn, to an agreed conclusion or a stated
  crux.
- **Rooms.** Connect two conversations you already have open, a Claude Code session and a Codex
  session say, so they can compare recommendations and reach agreement or state a crux. You create
  the room in your own terminal (`relay room new`), or say yes when a conversation asks to open one.
  Relay launches nobody; each conversation keeps its own files, tools, runs and permissions
  ([Rooms](docs/usage.md#rooms)).

Relay fills the gaps *between* families. For more agents of your own family, your host's native
subagents are the better tool; relay admits a call that names your own family, and labels it.

## What it looks like

In a Claude Code session, with relay installed, either type a slash command or ask in plain
language ("ask Codex whether…", "have Codex review this branch"):

```
/relay:ask Is the retry loop in src/net/client.ts safe if the server returns 429 with no Retry-After?
```

Claude calls relay's `ask` tool. Relay starts Codex, read-only, in the same repository, and returns
its answer to Claude, which can follow up in the same thread:

```json
ask({ "message": "Is the retry loop …", "context": ["src/net/client.ts"] })
→ { "reply": "…", "thread_id": "t_c0bbe50e", … }
```

A write job returns at once and runs in the background, on its own branch:

```
/relay:delegate write Add input validation to src/api/upload.ts and cover it with tests
```

```json
delegate({ "mode": "write", "task": "Add input validation to …" })
→ { "job_id": "j_7cfab338", "target": "codex", "branch": "relay/j_7cfab338", "status": "queued" }
```

When it finishes, Claude reads the job's `result` (summary, files changed, tests run, diff summary)
and, if you agree, `merge`s it. `relay tree` in a terminal shows every job, thread, discussion and
review of the run as it goes. From a Codex session the same tools reach Claude, through the skills
`$relay-ask`, `$relay-delegate`, `$relay-review` and so on.

## Requirements

- **A Mac.** macOS only: process handling relies on `ps`, and confinement on macOS sandboxes; Linux
  and Windows are not supported. Relay has recorded checks on macOS 27.0, 27.0.1, 27.2 and 27.2.1,
  and `relay doctor` warns on another version. Codex through relay needs Apple silicon: its pinned
  Codex is OpenAI's `darwin-arm64` build.
- **Node 24.15 or newer** (Node 24 LTS, or a later release), and **git**.
- **Claude Code and Codex CLI**, both installed and signed in with your account (relay refuses a
  turn that would sign in with an API key unless you allow it; see `child_auth` in
  [configuration](docs/configuration.md)). Tested minimums: Claude Code 2.1.302 and codex-cli
  0.163.0. Relay refuses an older version unless you set `allow_untested`; doctor reports the same
  failure (a warning with that opt-in). Relay runs Claude under the login Claude Code has stored,
  and Codex under the login in relay's own Codex home (see [Codex](#codex)). `relay doctor` prints
  the method each CLI reports (`claude auth status`, `codex login status`); for Codex that can be a
  ChatGPT account or a stored API key. For Codex it also asks Codex's app server which account it
  is signed in with, the check each turn makes, since `codex login status` only finds a stored
  login, and Codex may no longer accept it (one that expired and could not be refreshed).
- Launched agents use your Claude and ChatGPT plans like any other use of those CLIs. See
  [Accounts and cost](#accounts-and-cost).

## Install

```sh
npm install -g @jbkjr/relay
relay doctor                    # platform, Node, the CLIs and their logins, and what is registered
relay install claude            # prints what it would do, and changes nothing
relay install claude --write    # registers relay with Claude Code
relay install codex --write     # registers relay with Codex, and puts the shipped Codex pin in place
```

Then sign Codex in once for relay, which runs Codex with a Codex home of its own (see [Codex](#codex)):

```sh
CODEX_HOME="$HOME/.local/share/relay-codex-home" ~/.local/share/relay-codex-pins/current/bin/codex login
```

On a remote or headless Mac, add `--device-auth`, which needs device code sign-in switched on in
ChatGPT's Security settings. The same command signs in again when relay says Codex no longer
accepts the stored login.

Restart your Claude Code and Codex sessions: each session starts its own relay server when it
starts.

What the installs set up:

- **Claude Code** (`relay install claude --write`): the MCP server `relay` at user scope, and relay's
  plugin from a local marketplace (`relay@relay-local`). The plugin adds the slash commands
  `/relay:delegate`, `/relay:ask`, `/relay:discuss`, `/relay:review`, `/relay:tree` and
  `/relay:chat`; two subagents, `relay:operator` and `relay:codex`, that run one delegation or one
  question in the background and report back; and `relay:write-for-codex`, a brief on writing tasks
  for Codex that Claude loads itself.
- **Codex** (`relay install codex --write`): an `[mcp_servers.relay]` table in `~/.codex/config.toml`,
  and relay's plugin, whose skills are `$relay-delegate`, `$relay-ask`, `$relay-discuss`,
  `$relay-review`, `$relay-tree`, `$relay-chat` and `$relay-write-for-claude`. With `--write` it also
  puts this release's shipped Codex pin in place.
- **Claude desktop app and Cowork** (`relay install claude-desktop --write`, with the app quit): see
  [below](#claude-desktop-app-and-cowork).
- **ChatGPT desktop app**: its Codex side and its Work mode both run on the app's own Codex, which
  reads `~/.codex/config.toml`, so `relay install codex` covers both; see [below](#chatgpt-desktop-app).
- Each install also links `~/.local/bin/relay` to relay's launcher (`--no-link` skips that). The npm
  install also puts a `relay` command in npm's bin directory; either runs the same relay
  ([the `relay` command and your PATH](docs/install.md#the-relay-command-and-your-path)).

Every install is a dry run until you add `--write`. It stops, changing nothing, where something
named `relay` is not its own (unless you pass `--force`), copies each file before editing it, never
overwrites a backup, and records what it changed in `~/.config/relay/install.json`. Running it
twice changes nothing the second time. The details, every host and optional target (Gemini CLI,
OpenCode, Copilot CLI, Grok Build), upgrading, uninstalling and installing from a git checkout are
in [docs/install.md](docs/install.md).

### Claude desktop app and Cowork

The desktop app reads local MCP servers from its own config file, and a running app overwrites that
file, so quit the app first:

```sh
relay install claude-desktop --write
open -a Claude
```

The entry is named `relay-desktop`, and the app shares it: one relay process serves all its chats,
and a second serves Cowork, the Code tab's in-app bridge, remote Cowork and widgets. So no session on
this shared entry gets an approval dialog, `confirm` or notices, and its waits end after 50 seconds,
under the app's 60-second tool timeout; the agent then calls again. Approval requests arrive with
the conversation's next relay call (`relay approvals` lists them in a terminal). Relay keeps the
conversations apart with a session token each one's model carries: a bearer key that separates
conversations using relay honestly, not one whose model has seen another's token. A session there
passes `cwd`, the project's absolute path, to start a job, discussion or review, or to merge (an
`ask` without one gets an empty directory of its own). A Code tab session also has the relay of its
own `relay install claude` registration, inside its project, with notices and `confirm` as in a
terminal. The full description, including what auto mode does with the token and how to recover
a conversation's work, is in [docs/install.md](docs/install.md#claude-desktop-app-and-cowork).

### ChatGPT desktop app

The ChatGPT desktop app's Codex side and its **Work mode** (its counterpart to Claude's Cowork) both
run on the app's own bundled Codex, which reads its MCP servers from `~/.codex/config.toml`, the
Codex CLI's file, so `relay install codex --write` registers relay for both. Relay does not put approval
requests to you as dialogs there (only the app's idle case has been checked, not a request arriving
mid-task), so they arrive with the conversation's next relay call, and `relay approvals` lists them
in a terminal. A session that starts relay outside your project passes `cwd`, the project's absolute
path, as on the Claude desktop app.

Each conversation, on either side, gets a relay process of its own, so conversations stay apart
without the session token Cowork's shared entry needs (checked with Work mode on 2026-11-19: two
conversations at once, each with its own process). A Work conversation outside a project runs in a
folder the app makes for it (under `~/Documents/Codex/`), which is not a git repository: asks and
read jobs work there, and a write job or merge needs `cwd` set to your repository. The app's ordinary
chat mode does not run local MCP servers at all (its tools come only from ChatGPT's connectors,
which OpenAI's servers call), so relay is not available there; use Work mode.

## Codex

Relay runs Codex only from a **pinned copy**: one Codex release, downloaded and verified, whose run
under relay has passed relay's qualification of its confinement. That qualification covers stage 2
too: an optional mode, off by default, in which Codex's commands run in relay's own sandbox instead
of Codex's (see [configuration](docs/configuration.md#codex-raw-network-stage-2)). Relay refuses
every Codex job until it has a pin, and it never falls back to the `codex` on your PATH, unless you
set `targets.codex.pinned: false`, which runs the Codex `targets.codex.bin` names, unqualified.

- **A release installed from npm ships a pin.** The maintainer qualified one Codex release with
  exactly this relay build, and the package carries that pin (`codex-pin.json`).
  `relay install codex --write` puts it in place: it downloads that Codex release from npm and
  checks npm's integrity against the pin, Apple's signature, OpenAI's Team ID and the exact version.
  That takes a minute or two, and Codex works right away. It never replaces a pin you qualified on
  this Mac. What a shipped pin trusts is below, under [Pinned Codex](#pinned-codex-what-a-shipped-pin-trusts).
- **`relay qualify-codex` is for any other Codex version**, or to check this Mac yourself. It
  qualifies npm's latest release (or `--version X.Y.Z`) here and pins it. That takes about an hour
  and a half, from a terminal in your desktop login (not over SSH), with the network. A git checkout
  ships no pin, so from a checkout run it once after installing. A pin you qualified here stays in
  force over a shipped one; `relay qualify-codex --shipped` switches back to the release's.

Relay runs the pinned Codex with a Codex home of its own, `~/.local/share/relay-codex-home`, not
`~/.codex`, which is why it needs the one-time `codex login` above (`relay install codex --write`
makes that home, with the `config.toml` relay rewrites on every turn). `relay doctor` shows under
"codex pin" which pin is in force (shipped or local) and for which Codex, under "codex home" and
"codex login" whether that home is signed in (by the account Codex's app server reports, as each
turn checks, not only by `codex login status`), and under "codex launch" whether a Codex job started
in the current directory passes the check each turn makes of Codex's effective configuration
(system, managed and project layers included). Your own `~/.codex` is for your own Codex sessions:
relay's jobs read none of it ("your codex").

**Keeping up with Codex releases.** Relay keeps running the pinned release until another is pinned.
Each relay release ships a pin, so upgrading relay and running `relay install codex --write` again
moves to that release's Codex. To follow Codex releases sooner, rerun `relay qualify-codex`, or
install the optional LaunchAgent, which runs the same qualifier six times a day
([Pinned Codex, the LaunchAgent](docs/pinned-codex.md#keeping-up-with-codex-releases-the-launchagent)).
How pins, the build identity and the qualifier work: [docs/pinned-codex.md](docs/pinned-codex.md).

## A first run

About two minutes, once the installs above are done and the sessions restarted.

1. `relay doctor` should report no failures. Read its warnings: each says what to do.
2. In a git repository, start Claude Code and type:

   ```
   /relay:ask What does this repository do? Answer in three sentences.
   ```

   Depending on your permission settings, Claude Code may ask you first whether to allow relay's
   tool. Codex starts read-only in the repository, and its answer comes back into your session,
   with the item's `families` saying which family asked and which answered.
3. While it runs, `relay tree` in another terminal shows the thread, its status, and what the agent
   is doing.
4. The other way round: start Codex in the same repository and type
   `$relay-ask What does this repository do? Answer in three sentences.` This time Claude answers.

From there, try `/relay:review` on a file or a branch, or `/relay:delegate write …` on a small task
and look at its result before you merge it. [docs/usage.md](docs/usage.md) describes every tool.

## Security model

Relay launches agents that run code on your Mac, so read this before giving one write access to a
repository you care about. In short:

- **Each launched agent runs in a sandbox.** Claude Code and Codex run in their own macOS sandboxes,
  configured by relay and checked before each turn. Gemini, Copilot and Grok run inside relay's own
  Seatbelt profile, built for each turn, and only after boundary probes have passed under exactly
  that turn's sandbox. With stage 2 on, a Codex job's commands run in relay's Seatbelt instead. A
  write job can write only its own worktree, directories the root session granted, and its private
  temporary directory.
- **A job's commands have no network unless granted.** The root session grants it per job. A grant
  sends a Claude job's connections, and a Codex job's under stage 2, through a per-turn proxy of
  relay's, which refuses loopback, private, link-local and this Mac's own addresses. With stage 2
  off, a Codex job uses Codex's own network proxy in strict mode (HTTP(S) to public addresses),
  which relay verifies before each turn. For Gemini, Copilot and Grok, "off" still lets them reach
  their own API hosts through relay's proxy, and a grant opens IPv4 to anything but this Mac's own
  addresses, your LAN included. Every agent reaches its own model API either way.
- **The never floor.** Credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, the CLIs' login
  files, the keychain files) are denied to the commands of Claude and Codex jobs, and of Gemini jobs
  while stage 2 is on, whatever they are granted; relay's own config, install and key files are
  protected from every agent. `relay doctor` says which applies on your Mac
  ([the never floor](docs/configuration.md#the-never-floor)).
- **Logins stay with the CLIs.** Relay runs each CLI under the login that CLI keeps, and refuses a
  turn that would sign in with an API key unless you allow it. The one key relay reads is the Gemini
  API key you save for it, which it hands to Gemini's process alone.
- **Approvals go to the root.** A launched agent that needs something its sandbox does not allow
  asks; the request goes to the root session, the one you started, and to you in an approval dialog
  where the host is known to show one. What can be allowed is narrow: a Claude or Codex file change
  outside its writable places, a Claude agent's web search or fetch, an explicit access added to one
  Codex command inside its sandbox, and, under stage 2, a new turn with the capabilities the job
  asked for. Relay declines a request to run a command outside the sandbox itself, without asking
  anyone. Some requests (environment variables holding tokens, skills, local or raw network) only
  you can allow.
- **Settings that leave these guarantees** are off by default and only your config file can set
  them: `allow_dangerous` (a Codex write job without a sandbox while stage 2 is off; Claude write
  jobs refused), `targets.codex.pinned: false` (an unqualified Codex), `child_network` (every job
  gets the network), `allow_untested` and experimental targets, among others listed in
  [SECURITY.md](SECURITY.md#settings-that-take-you-outside-these-guarantees).
- **The root session is trusted.** It can grant network and write access, merge, and decide
  approval requests. Relay does not protect you from your own root agent, and an approval the root
  agent gives is not proof that a person gave it. `relay approve` in a terminal asks for a code you
  type back, which stops an accidental approval but is not a security boundary.

The full model, with a row per agent, is in [docs/security-model.md](docs/security-model.md). To
report a way around any of it, see [SECURITY.md](SECURITY.md).

### Pinned Codex: what a shipped pin trusts

- **What a pin means.** Relay's Codex confinement depends on how one Codex release behaves under relay's checks. So relay runs Codex only from a pin: a release that passed relay's qualification of how Codex behaves under its checks, 33 items today ([Pinned Codex](docs/pinned-codex.md)). `targets.codex.pinned: false` turns this off and runs an unqualified Codex.
- **A pin you make with `relay qualify-codex`** is that qualification run on your own Mac. It ran under the relay build and evidence schema of its day. It stays in force when relay is upgraded, because it is bound to its Codex binary, not to the relay that runs it later. A pin qualified under an earlier schema keeps the requirements of that schema. Rerunning `relay qualify-codex` for the version that is already pinned changes nothing (the qualifier reports it unchanged); a new pin comes from qualifying another version.
- **A pin shipped with a release** is the maintainer's qualification, run on the maintainer's Mac, of one Codex release (its version and npm's sha512 integrity) with exactly this relay build (a hash of the installed build). Relay checks everything it can check here:
  - the Codex it downloads must match that integrity, Apple's signature, OpenAI's Team ID and the version;
  - the relay running it must be the build the pin names, both on disk and as the process loaded it at start, or relay refuses Codex on every turn. After an upgrade in place, restart the sessions.
  - The build identity covers relay's own files (`dist/`, the qualifier and the tests it runs) and its dependency lock, `npm-shrinkwrap.json`. Relay also checks that the dependencies it loads (`@modelcontextprotocol/sdk`, `zod`, `smol-toml` and theirs) are the locked versions, and refuses Codex under a shipped pin when they are not; reinstalling relay fixes that.
- **What relay cannot check here** is that your Mac behaves as the maintainer's did. A different macOS version, other system configuration or other hardware can change how a sandbox behaves, and nothing on your Mac reruns the qualification. This is the same trust as Claude Code's verified list in [`src/targets/verified.ts`](src/targets/verified.ts): versions the maintainer checked, taken on the maintainer's word for your Mac.
- **To remove that trust**, run `relay qualify-codex` (with `--version` the shipped version to recheck exactly it). Your own pin then takes precedence over the shipped one. `relay doctor` says which pin is in force.
- **What a shipped pin holds.** The format admits only the Codex version and integrity and relay's build identity, nothing about the maintainer's machine, and relay refuses one that carries anything else.

## Known limits

The ones most people meet first. The full list, with what each one covers, is
[docs/known-limits.md](docs/known-limits.md).

- **macOS only.** Process handling relies on `ps`, and confinement on each CLI's macOS sandbox, or on
  relay's own Seatbelt sandbox for Copilot, Gemini and Grok.
- **Reads are not confined.** Outside the never floor and relay's own directories, a launched agent
  can read whatever you can, and with any network access, including a target's own API host, which
  stays reachable with the network off for the targets relay confines itself, what it reads can
  leave your Mac.
- **What you approve acts with the access it names.** A file change you allow is made outside the
  job's sandbox, and a capability you allow for a stage-2 turn is that turn's to use. No agent can
  have a command approved to run outside its sandbox: relay declines those requests itself.
- **Keychain IPC is open for Claude, and for Codex turns with shell network while stage 2 is off.** The floor denies the
  keychain files, so items in file-based keychains stay unreadable, but not the security daemons.
- **The network proxies judge addresses, not contents.** They cannot inspect TLS, tell apart
  services behind one allowed public endpoint, or screen the network's own public address. A Codex
  job given local mode reaches this Mac's loopback and your LAN; one given raw network (stage 2),
  your LAN and tailnet.
- **Prompt injection.** Hosted web search and fetched pages can carry it into an agent's context.
- **Review independence is a workflow barrier, not a guarantee.** Relay withholds the other side's
  review until yours is in, but either side could read unprotected copies of the other's.
- **Processes an agent detaches can outlive its turn.** Relay stops what it can trace; `merge` takes
  only the commit the job's result showed.
- **Write jobs can plant configuration below the top of their worktree** (a nested `.claude/` or
  `.mcp.json`, say), which your own agent then loads after you merge. Review a write job's diff
  before you merge it.
- **Copilot and Grok are experimental**: off by default, not qualified with a signed-in run, and
  launched only with `targets.<id>.experimental: true`. Gemini signs in with an API key, not an
  account login.

## Status

A personal tool, published as it is: built and used by one person, on their own Macs, before this
first public release.

- Recorded tested floors: Claude Code 2.1.302 and codex-cli 0.163.0 (including speed protocol checks). codex-cli 0.164.0 was also checked on 2026-10-23 (read, write, resume and Daybreak runs, at standard speed); the floor stays 0.163.0. Relay's Codex route has been checked on codex-cli <!-- verified:codexCli -->0.163.0, 0.164.0, 0.167.0, 0.167.1, 0.167.2 and 0.170.0<!-- /verified -->. macOS checks are recorded on 27.0, 27.0.1, 27.2 and 27.2.1; doctor reports these and warns on an untested version. Relay refuses to launch an agent on another platform, or with an older CLI, unless you set `allow_untested`.
- The automated tests run against stub agents and test relay's own logic; where an installed Codex is found, they also check Codex's sandbox as relay configures it, without a model. The confinement claims rest on the qualification records in [docs/qualification](docs/qualification), run on real CLIs before each release.
- Both CLIs change often, and OpenAI labels `codex app-server` experimental. An update to either can break relay.
- Read [Security model](#security-model) before giving it write access to a repository you care about.
- No support is promised. Reports are welcome as GitHub issues; see [Reporting a problem](#reporting-a-problem).
- Relay is unrelated to T3 Code's "T3 Connect" remote-access relay.

The 1.x compatibility and deprecation promises are in [stable surfaces](docs/stable-surfaces.md); upgrade steps and rollback are in [UPGRADING](docs/UPGRADING.md).

## How it works

Relay is one stdio MCP server installed in each host. It launches Claude and Codex through their own CLIs (`claude -p`, `codex app-server`) under their stored logins, without reading their API keys or account credentials. The [per-harness security table](docs/security-model.md#per-harness-security) records each additional target's login policy; the one API key relay reads is the one you save for the Gemini target, which it hands to Gemini alone. Agents decide for themselves when to delegate, ask, or discuss. For launched agents, relay enforces two hard limits, depth and concurrency; jobs and turns have no time limit unless you set one.

How it is built: [docs/architecture.md](docs/architecture.md).

## Reference

- [docs/install.md](docs/install.md): what install does; Claude Code, Codex, the Claude desktop app, Gemini CLI, OpenCode, Copilot CLI and Grok Build; the `relay` command and PATH; how relay finds Node and the CLIs; upgrading; uninstalling; installing from a git checkout.
- [docs/usage.md](docs/usage.md): the tools; delegate, consult, discuss and review; rooms; speed; approval requests; extensions; watching and stopping runs; `relay tree`, `cancel` and `clean`.
- [docs/configuration.md](docs/configuration.md): every setting in `~/.config/relay/config.json`, the never floor, the environment launched agents get, Codex's launch checks and its raw network (stage 2).
- [docs/security-model.md](docs/security-model.md): the per-harness table, and what relay relies on, checks and does not do, including what it keeps on disk and the secrets it cuts from it.
- [docs/known-limits.md](docs/known-limits.md): every stated limit.
- [docs/pinned-codex.md](docs/pinned-codex.md): pinned Codex, the qualifier and the build identity.
- [docs/UPGRADING.md](docs/UPGRADING.md): what changed in each release, and how to upgrade and roll back.
- [GLOSSARY.md](GLOSSARY.md): relay's terms.

`relay --help` lists the commands.

## Accounts and cost

Claude, Codex, Copilot and Grok run through their vendors' own unmodified CLIs under the login you already have, and Gemini through its own on an API key. Relay does not read, store or forward your vendor credentials (logins and API keys), with one exception: for the Gemini target, which is key-only (see the [per-harness security table](docs/security-model.md#per-harness-security)) and needs an explicit per-target opt-in (`targets.gemini.child_auth: "any"`), it reads the Gemini API key you saved in a file of your own and hands it to Gemini's process alone, never storing or logging it. Relay also reads the session's own Claude Code inbox token (`CLAUDE_CODE_MESSAGING_TOKEN`), which it uses only to post notices to that same session; it never stores it, and keeps it out of launched agents' environments. That is not a gate: on macOS a process running as you can post to a Claude Code session's inbox without the token (see "Delegate" in [docs/usage.md](docs/usage.md#delegate)), so a relay-formatted notice is a pointer to check, not proof that relay sent it. Launched agents draw on your Claude and ChatGPT plans (and, for the targets that are off by default, your GitHub Copilot or xAI plan, or your Gemini API key's billing) like any other use of those CLIs, and relay has no spending cap: what bounds a run is depth (3) and agents at once (4), and a time limit per job or turn only if you set one. Work delegated at high reasoning effort can use a lot of a plan's allowance, and so can a faster speed (see "Speed" in [docs/usage.md](docs/usage.md#speed); standard unless you ask): Claude's fast mode is billed to usage credits, and Codex's faster tiers use the allowance several times as fast.

Whether driving the CLIs from another tool fits each vendor's terms for your plan is for you to check; relay's author is not in a position to say. Anthropic's statement on how Claude Code may be used is at [code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance).

## Development

```sh
npm ci
npm test    # builds, then runs the suite; spends nothing
```

The tests come in three tiers:

- **`npm test`** runs relay's logic against stub agents. A few tests also run an installed Codex, without a model, to check its own sandbox as relay configures it (`codex sandbox`): the Codex at the absolute path in `RELAY_TEST_CODEX`, or else the first `codex` on PATH (Homebrew's for one of them). They skip, saying so, where there is none. Nothing in this tier signs in or spends model usage.
- **Host-only tests** are off unless their variable switches them on (`RELAY_TEST_STAGE2_LIVE=1` and the like, named at the top of each `*-live.test.ts` file). They start real sandboxes and real CLIs on your Mac, and some run a signed-in CLI and spend model usage. CI never switches them on.
- **Release checks** are run by the maintainer, on real CLIs on the maintainer's Macs: the Codex qualification behind each shipped pin ([docs/pinned-codex.md](docs/pinned-codex.md)), the host-only tests, signed-in checks of the targets, and red-team campaigns. The records in [docs/qualification](docs/qualification) say which checks ran for each version and which did not.

The stubs in `test/stubs/` stand in for `claude` and `codex`: they parse the real flag sets, record every prompt and argument they are given, and play back scripted replies, including calls back into relay for nested cases.

`smoke/call.mjs` and `smoke/root.mjs` are development tools that launch the real agents, and so spend your plans' allowance. Both need `RELAY_SMOKE_HOST` set to the family the root speaks as (`claude` or `codex`), and `RELAY_HOME` set to a scratch state directory outside temporary directories: they refuse the default `~/.local/state/relay`, whose registry a newer build would migrate. The first makes one call as a root session. The second keeps one root session alive behind a Unix socket so that follow-up calls (resume, approve, discuss) reach the same run; the socket carries that session's full authority, and the tool refuses a socket whose directory is not yours alone. `smoke/claude-network-probe.mjs` checks, without spending model usage, that a Claude Code binary keeps a network-granted job on relay's proxy (see the Claude network item in [docs/known-limits.md](docs/known-limits.md)).

Tests must never change real files on your machine (installed programs, the home folder, dotfiles, CLI logins): every test file loads `test/helpers.ts`, which gives it a scratch HOME and refuses paths under the real one, and a guard test checks that each file loads it. An installed Codex is only ever run, with scratch homes. In a worktree someone else is also working in, stage explicit paths; never `git commit -a`.

The hosts run a checkout's `dist/` directly, so a rebuild there replaces live code. If your hosts run relay from a checkout, develop in a separate git worktree and rebuild the main checkout only when nothing is running (`relay tree`).

`npm run build && node adapters/build.mjs` regenerates every host's adapter from one set of skill texts; each host's layout is in its module in `src/hosts/`. Each host also gets the prompting brief for every family it reaches: `adapters/briefs/<target>.md`, written by that family, with the model-specific notes (effort values, model advice) kept apart in `adapters/briefs/models.json`, dated and tied to the harness version they were checked with. Relay's `brief` tool returns the same text, for hosts and launched agents without the plugin. The build refuses notes checked with an older version than the one relay is tested with, so raising that version means checking them again. `relay doctor` says when an installed CLI is newer than the version the notes were checked with, and warns about it from a month after the check, when a new model or effort level is likely to have shipped. A test fails if the checked-in adapters differ from what the build generates.

## Reporting a problem

Open an issue with what you ran, what happened, your macOS version and the output of `relay doctor`. Logs and transcripts under `~/.local/state/relay/runs/` help, but they can contain anything an agent read, including file contents and paths: relay cuts only the secrets it knows the shape of (see "What is kept" in [docs/security-model.md](docs/security-model.md)), so read them and cut what should not be public before attaching them.

A security problem (a way around confinement, the never floor, the network proxy or approvals, or a check that claims a protection that is not there) goes through GitHub's private vulnerability reporting instead of an issue: see [SECURITY.md](SECURITY.md).

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for how they land.

## License

MIT; see [LICENSE](LICENSE). Third-party notices are in [LICENSES/](LICENSES/).
