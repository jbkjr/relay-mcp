# Security policy

Relay launches coding agents (Claude Code, Codex CLI and, when you switch them on, Gemini CLI,
Copilot CLI and Grok Build) on your Mac and passes work between them. A flaw in relay can let an
agent do more than you allowed, so reports are welcome and taken seriously.

## Reporting a vulnerability

Report it privately through GitHub: open this repository's **Security** tab and choose
**Report a vulnerability** (GitHub's private vulnerability reporting). Please don't open a public
issue, discussion or pull request for a security problem.

A useful report says:

- the relay version (`relay --version`) and the commit if you built from source;
- your macOS version and the versions of the agent CLIs involved (`relay doctor` prints them);
- the relevant parts of your relay configuration, and which target, mode and grants the job had;
- the steps that reproduce it, and what an agent could do that it should not have been able to.

Relay's logs and transcripts (`~/.local/state/relay/runs/`) can contain anything an agent read,
including file contents, paths and tokens. Check and trim them before attaching them.

Relay is maintained by one person, as a personal project. Expect an acknowledgement within two
weeks and a fix on a best-effort basis; there is no bug bounty. Once a fix is released, the report
is published as a GitHub security advisory, with credit to you if you want it.

## Supported versions

Only the latest release is supported. Security fixes ship in a new patch release on the latest
minor line (1.2.x when this was written); earlier lines are not patched. Relay runs on macOS only,
with Node 24.15 or newer, and supports the agent CLI versions recorded in
[stable surfaces](docs/stable-surfaces.md#supported-versions-and-qualification). Running relay with
`allow_untested`, or a target marked `experimental`, is outside what relay has qualified.

## What relay's security model covers

The README's [Security model](README.md#security-model) has the summary; the full description is
[docs/security-model.md](docs/security-model.md), with a row per agent in
[Per-harness security](docs/security-model.md#per-harness-security). With relay's default
configuration, it aims to ensure the following. The settings that change it are listed in the next
section.

- **Each launched agent runs inside a sandbox.** Claude Code and Codex run in their own macOS
  sandboxes, which relay configures and checks before each turn. Gemini, Copilot and Grok run in a
  Seatbelt profile relay builds for each turn, and only after boundary probes have passed under
  that turn's profile. With stage 2 switched on (`targets.codex.stage2`, off by default), a Codex
  turn that has the network, or that can ask relay for more access, runs its commands in relay's
  own Seatbelt profile instead of Codex's sandbox. A write job writes only its own worktree, the
  directories the root session granted, and its own temporary directory.
- **A job's commands have no network unless it is granted.** The root session grants the network
  per job (`grant.network`). What a grant opens depends on the agent:

  | Agent | No grant | `network: true` |
  | --- | --- | --- |
  | Claude Code | No network for its commands. | Commands go through relay's proxy for the turn, which refuses loopback, private, link-local, on-link and this Mac's own addresses and screens your `never` hosts and ports. |
  | Codex, stage 2 off (the default) | No network for its commands. | Codex's own network proxy in strict mode, which relay checks before each turn: HTTP(S) to public addresses only. It cannot screen `never` hosts or every kind of `never` port, so relay refuses the turn while you have an entry it cannot enforce. Where relay cannot verify the proxy, the turn gets Codex's hosted web search only. |
  | Codex, stage 2 on | No network for its commands. | Relay's proxy (stage-2 mediated), which reaches public hosts only and screens your `never` rules. |
  | Gemini, Copilot, Grok | Only the target's own API hosts, through relay's proxy, which screens your `never` rules (for Copilot and Grok, also what the certificate-trust daemons fetch, past the proxy). | IPv4 to anything but this Mac's own addresses: the internet and your local network (LAN). |

  Two Codex grants widen this, and only you can allow either: `local_network` (stage 2 off, write
  jobs) also opens this Mac's loopback and your LAN; `raw_network` (stage 2 on, write jobs) gives
  raw TCP, UDP, ssh and DNS to the internet, your LAN and tailnet, and this Mac's loopback except
  the ports relay denies. Without a grant, every agent can still reach its own model API, and
  Claude's and Codex's web tools can follow `child_web`.
- **The never floor holds where it applies.** Paths such as `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.netrc`, the agent CLIs' login files and the keychain files are denied to the commands of a
  Claude or Codex job, and of a Gemini job while stage 2 is on. Relay's own configuration, install
  and key files are protected from every agent. Where a route cannot enforce one of your `never`
  entries, relay refuses the turn rather than run it without. `relay doctor` says which agents the
  floor binds on your Mac.
- **Logins stay with the CLIs.** Relay runs each CLI under the login that CLI keeps and does not
  read its credentials. By default it refuses a turn that would sign in with an API key
  (`child_auth`). The one key relay reads is the Gemini API key you save for it, which it hands
  to Gemini's process alone.
- **Approvals go to the top.** A job's request to act outside its limits goes to the root session
  (to you, where the host can show an approval dialog), never to the agent that asked or the agents
  in between. What can be approved is narrow: a Claude or Codex file change outside the job's
  writable places, a Claude agent's web search or fetch, an explicit access a Codex command asks to
  have added inside its sandbox, and, under stage 2, a new turn with the capabilities the job asked
  for. Some requests only you can allow, never the root agent: a Codex job's `local_network` or
  `raw_network`, skills given to a job, and environment values released to one turn. Relay itself
  declines, without asking anyone, a native Codex request to run a command outside its sandbox and
  every Claude request to run a command. For Gemini, Copilot and Grok an approval lets the agent go
  ahead inside its sandbox and never widens it. A request to change relay's own files or another
  job's worktree is refused without anyone being asked
  ([Approval requests](docs/usage.md#approval-requests)).
- **Relay's own reports are honest.** A check that did not run is reported as not run, never as
  passed.

A way around any of these, an agent reading or changing relay's state, credentials or another
job's files, or a doctor or qualification result that claims a protection that is not there, is
a vulnerability. Please report it.

## Settings that take you outside these guarantees

Each of these is off by default and can be set only in relay's config file, never by a tool call.

- **`allow_dangerous`.** With stage 2 off, a Codex write job runs in Codex's full-access mode:
  no sandbox, every network connection, and no never floor. With stage 2 on, relay refuses a Codex
  write turn that would run that way. Claude write jobs are refused under it. It also turns off
  approval requests.
- **`targets.codex.pinned: false`.** Relay runs the Codex that `targets.codex.bin` names instead
  of a qualified pin. Relay still configures and checks its sandbox, but nothing has qualified how
  that Codex behaves under relay's checks.
- **`child_network`.** Every job gets the network, as if granted.
- **`allow_untested`**, and **`targets.<id>.experimental`** for Copilot and Grok: versions,
  platforms and targets relay has not qualified.
- **`child_mcp: "inherit"`, `child_hooks: true`, `trust_git_filters`, `child_git: "native"`,
  `child_auth: "any"`, `codex_endpoint_override: "accept"`.** Each lets something relay does not
  vet run or connect: your own MCP servers and hooks, a repository's git filters, a job's own git
  configuration and hooks, API-key logins, or another endpoint. Relay refuses Claude jobs under the
  first two. [Configuration](docs/configuration.md) describes each.

## What it does not cover

These are stated limits, documented in [Known limits](docs/known-limits.md), not vulnerabilities.
A report that shows one is worse than described is still welcome.

- The session you start relay from (the root) is fully trusted: it can grant network and write
  access, merge, and decide approval requests. Relay does not protect you from your own root agent.
- Reads are not confined: outside the never floor and relay's own directories, a launched agent can
  read whatever you can, and with any network access (including a target's own API, which stays
  reachable with the network off) what it reads can leave your Mac.
- What you approve runs with the access the request names. A file change you allow is made outside
  the sandbox; a capability you allow for a Codex turn is that turn's to use.
- With stage 2 off (the default), the never floor does not bind Gemini, Copilot or Grok: they can
  read the credential paths. Copilot and Grok are refused while stage 2 is on, because their login
  routes conflict with the floor.
- Keychain IPC stays open for Claude, and for Codex turns with shell network while stage 2 is off:
  the floor denies the keychain files, but not the security daemons.
- A Codex job given `local_network` reaches this Mac's loopback and your LAN; one given
  `raw_network`, your LAN and tailnet. Gemini, Copilot and Grok with the network reach your LAN.
- The network proxies check addresses and hosts, not TLS contents: they cannot tell apart services
  behind the same allowed public endpoint, stop an allowed server from forwarding elsewhere, or
  screen your network's own public address.
- Hosted web search and fetched pages can carry prompt injection into an agent's context.
- Experimental targets (Copilot, Grok), versions run under `allow_untested`, and platforms other
  than macOS.
- Flaws in the agent CLIs' own sandboxes or in the models themselves. Report those to the vendor
  (Anthropic, OpenAI, Google, GitHub or xAI) through its own security channel; tell relay too if
  relay should work around the flaw.

Relay's automated tests check its own logic against stub agents, plus model-free checks of an
installed Codex's sandbox where one is found. The confinement claims rest on the qualification
records in [docs/qualification](docs/qualification), run on real CLIs before each release.
