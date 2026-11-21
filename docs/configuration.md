# Configuration

Relay's settings, the never floor, the environment launched agents get, and the checks and network modes of
the Codex target. How to use the tools is in [usage.md](usage.md); what the settings do and do not protect is in
[security-model.md](security-model.md).

## Limits and configuration

Optional file `~/.config/relay/config.json` (`RELAY_CONFIG` names another file; under a custom `RELAY_HOME` it is `$RELAY_HOME/config.json`); defaults shown. A setting relay does not know, or a value of the wrong type, stops relay with a message saying which: nothing is read loosely.

```json
{
  "never": { "paths": [], "ports": [], "hosts": [], "override_builtin": [] },
  "max_depth": 3,
  "max_concurrent": 4,
  "block_s": 240,
  "job_timeout_s": null,
  "turn_timeout_s": null,
  "cancel_grace_ms": 5000,
  "child_mcp": "relay-only",
  "child_hooks": false,
  "child_network": false,
  "child_git": "relay",
  "child_settings": "isolated",
  "child_auth": "login",
  "child_env": { "policy": "allowlist", "pass": [], "drop": [], "request": [] },
  "child_web": "inherit",
  "trust_git_filters": false,
  "claude_managed_settings": "refuse",
  "claude_settings_env": "refuse",
  "codex_endpoint_override": "refuse",
  "allow_untested": false,
  "same_family": "allow",
  "log_max_mb": null,
  "keep_records_days": null,
  "allow_dangerous": false,
  "escalation": true,
  "approval_timeout_s": 3600,
  "desktop_notifications": false,
  "ask_user": "auto",
  "codex_backend": "app-server",
  "targets": {
    "claude": { "enabled": true, "bin": "claude" },
    "codex": { "enabled": true, "bin": "codex", "pinned": true, "home": "~/.local/share/relay-codex-home", "pin_store": "~/.local/share/relay-codex-pins" },
    "copilot": { "enabled": false, "bin": "copilot" },
    "gemini": { "enabled": false, "bin": "gemini" },
    "grok": { "enabled": false, "bin": "grok" }
  },
  "default_target": {}
}
```

| Key | Meaning |
|---|---|
| `never` | The never floor: paths, ports and hosts no launched agent may reach, on top of relay's built-in entries. See [The never floor](#the-never-floor). |
| `max_depth` | Your session is depth 0; anything it starts is depth 1, and so on. A start at the maximum depth is refused with the reason, and the agent carries on by itself. |
| `max_concurrent` | Agents doing work at once in a run; the rest queue. An agent blocked waiting on something it started does not count. |
| `block_s` | How long a blocking call waits before returning a pending handle to poll with `status`. |
| `job_timeout_s`, `turn_timeout_s` | Wall-clock limits, in seconds, for a job turn and for a consult or discussion turn, after which relay cancels the turn. `null` (the default): no limit; a turn runs until it ends, you cancel it, or its agent dies (relay still cleans up after agents that die or are orphaned). Unlike `block_s`, which only ends a call's wait and leaves the work running, these stop the work. A run keeps the limits it started with. |
| `cancel_grace_ms` | How long, in milliseconds, a cancelled agent is given to stop cleanly before relay kills what is left (see "Watching and stopping" in [usage.md](usage.md#watching-and-stopping)). |
| `child_mcp` | `relay-only`: launched agents get relay as their only MCP server (and, on Codex, no plugins), except that on Grok a repository's own `.grok/config.toml` and `.mcp.json` servers still load, inside relay's sandbox (see Known limits). `inherit`: they get your usual servers too, ungated, which no extension can be combined with. |
| `child_hooks` | Whether your user-level hooks run in launched agents. `true` cannot be combined with extensions. |
| `child_network` | Shell network access, and web tools, for every job without needing a grant. |
| `child_git` | `relay`: relay commits and merges on the agents' behalf. `native`: Codex write jobs may write the repository's `.git`, which lets a sandboxed agent write `.git/hooks` and the repository's git config. |
| `child_settings` | Which of your Claude Code settings a launched Claude agent loads. `isolated`: none of your user, project or local settings files, so your allow rules, extra directories and allowed domains cannot widen a job, and a job cannot widen itself by writing a settings file into its worktree. Your deny rules are the exception: relay copies `permissions.deny` from your user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`) into the agent's settings, and nothing else from that file, so `env` and `apiKeyHelper` set there do not apply. A deny rule for a path with one leading slash (`Read(/secrets/**)`), which Claude reads relative to the settings file's directory, is anchored there (and if that directory's name holds pattern characters such as `[` or `*`, relay refuses rather than anchor it wrongly). If that file exists but cannot be read, is not valid JSON, or its deny list is not a list of strings, relay does not launch Claude. Deny rules in project or local settings are not carried. `inherit`: all of them would load, with both effects. The value is still accepted, but since 1.1.4 relay refuses every Claude job under it, whatever `claude_settings_env` says: those settings could take a job around the never floor ([what a Claude job cannot do under the never floor](security-model.md#what-a-claude-job-cannot-do-under-the-never-floor)). |
| `child_auth` | `login` (default): remove API keys and refuse key sign-in. `any`: allow only the destination target's own supported auth inputs when also selected by `child_env`; other vendors' keys remain removed. The global form is still accepted but warns; prefer `targets.<id>.child_auth`. Grok's key-mode restrictions remain. Gemini needs `targets.gemini.child_auth: "any"` and reads its key only from its configured key file; inherited Google/Gemini key variables remain removed. |
| `child_env`, `targets.<id>.child_env` | (1.0) `policy`: `allowlist` (default) or explicit `legacy`; `pass`, `drop`, `request`: arrays of exact, case-sensitive environment names. The target policy overrides root; root and target lists are unioned. `drop` wins over baseline, pass and request. Standing `pass` does not prompt; `request` only makes names eligible for one-turn person-approved `grant.env`. Mandatory scrubs and backend-owned values cannot be overridden. See [Environment policy](#environment-policy). |
| `child_web` | Codex's own web search when no network grant applies. `inherit`: relay leaves it to Codex's configuration. Relay runs Codex with a Codex home of its own whose `config.toml` it writes itself, so your `~/.codex/config.toml` does not decide it: Codex's default does, unless a configuration layer relay does not write (an administrator's, say) sets it. `ask`: off; for Claude, relay also adds ask rules for WebSearch and WebFetch on a turn without the network, so they need a grant or an approval whatever else would allow them. (Your own rules no longer decide for Claude's web tools: `child_settings: "inherit"`, which loaded them, refuses every Claude job since 1.1.4.) Grok's client web tools (`web_search`, `web_fetch`) are off without a network grant under either value, and so, by Grok's own setting, are its server-side tools (`features.backend_tools`), which a signed-in run has yet to confirm. |
| `trust_git_filters` | Let a repository's content filters (other than Git LFS) and merge drivers stand when relay commits, checks out or merges a job's files. Off by default because they run outside the sandbox. Diff drivers and `diff.external` are never refused: relay's own diffs never run them. |
| `claude_managed_settings` | `refuse` (default): do not launch Claude on a machine with organisation-managed Claude Code settings. `accept` does not permit relay's Claude jobs: since 1.1.4 every one carries the never floor, which managed settings could override, so relay refuses them on such a machine whatever this says. The key is still accepted; `accept` would launch only a Claude launch without the floor, which relay's own jobs never are (and also needs `claude_settings_env: "accept"`). |
| `claude_settings_env` | `refuse`: do not launch Claude when settings relay does not vet would load (`child_settings: "inherit"`, or accepted managed settings): their `env` could send Claude to another endpoint after relay's environment check. `accept`: launch anyway; the launched family is labelled unknown even when Claude reports a Claude model. Since 1.1.4 relay's own Claude jobs are refused under both sources before this applies (see `child_settings` and `claude_managed_settings`), so `accept` no longer launches one. |
| `codex_endpoint_override` | `refuse`: do not launch Codex when its effective configuration (any of its configuration layers, or a profile one selects) sends OpenAI's provider to another endpoint (`openai_base_url`, or `model_providers.openai.base_url`), or sends ChatGPT-login traffic elsewhere (`chatgpt_base_url` other than Codex's default, `experimental_realtime_*_base_url`), since relay cannot tell which family answers there. `accept`: launch anyway with the launched family labelled unknown; an endpoint that does not answer then leaves Codex retrying indefinitely (relay sets no turn timeout by default), and `relay cancel` stops it. `OPENAI_BASE_URL` in the environment is refused either way. |
| `same_family` | `allow` (default): a call may name an agent of the caller's own family, or a target whose family is judged per model (Copilot, Grok) with a model of that family or with no model, and Copilot with `auto` or an unlisted model (Grok runs no model its list does not name, under either setting). A session whose family relay cannot tell may start and continue agents by naming one. Every result labels both sides (`families`). A call naming no target never picks the caller's routing family; its launched label can still be unknown. `refuse`: admit only starts provably of another family; refuse unknown callers' starts and continuations and Copilot or Grok without a listed model of another family (all of Grok's are xAI's, so a Grok agent cannot reach Grok), and stop their switches to another family's model or to one relay cannot name. Endpoint waivers are separate settings and still apply. |
| `log_max_mb` | Size in megabytes at which each of these logs is rotated: agents' logs, `proxy.jsonl`, `worker.log`, `elicitation.log` and `notices.log`. Each is rotated to `<name>.1`, so about twice that is kept of each. `null` (the default): logs are kept whole. A run's agents' logs, proxy decision logs and `worker.log` keep the value the run started with; `elicitation.log` and `notices.log` follow your config as it is at each entry. See "What is kept" in [security-model.md](security-model.md). |
| `keep_records_days` | Days without activity after which `relay clean`, and a worker once a day, forget a finished run's records (registry rows, `runs/<run_id>/`, harness state, `relay adopt`'s transfers of it). Never a run still in use, whose job worktrees or branches remain, whose branches relay cannot look for (`relay clean --forget` forgets one whose repository is gone, when you say so), or with login-store entries relay quarantined. The same setting forgets an ended room's transcript that many days after the room ended (see "What is kept" under Rooms in [usage.md](usage.md#rooms)). `null` (the default): records are kept until you delete them. See "What is kept" in [security-model.md](security-model.md). |
| `allow_untested` | Launch agents on a platform or CLI version relay was not checked with. This waives the compatibility check only; relay still asks for the same confinement, unverified. It does not switch on an experimental target (see `targets.<id>.experimental`). |
| `escalation`, `approval_timeout_s` | Whether launched agents may ask for approval to act outside their sandbox, and how long a request waits before it counts as denied. `escalation` may also be an object, `{ "enabled": true, "port0_authority": "person" }`: with stage 2, `port0_authority` says who may allow a Codex job's request to listen on ephemeral ports, the root session (`"supervisor"`, the default) or only you (`"person"`) ([UPGRADING](UPGRADING.md#escalation-approval-authority-wp3)). |
| `desktop_notifications` | Show a macOS desktop notification for each approval request. Default `false`. (`notify`, its earlier name, is still read.) |
| `ask_user` | Whether relay puts approval requests to you directly through the host: `auto` (hosts seen showing approval dialogs), `always` (same qualification gates as `auto`, retained for compatibility) or `never` (see [Approval requests](usage.md#approval-requests)). |
| `codex_backend` | `app-server` (default) or `exec` (no approval requests). Either way Codex is not started unless its effective configuration is the one relay set. |
| `targets.codex.pinned`, `targets.codex.pin_store`, `targets.codex.home` | Relay runs Codex only from a qualified pin (`pinned`, default `true`), kept in `pin_store` (default `~/.local/share/relay-codex-pins`), and runs it with a Codex home of its own (`home`, default `~/.local/share/relay-codex-home`), not `~/.codex`. Relay makes that home private and rewrites its `config.toml` on every turn, so it takes as `home` only a new or empty directory, or one it made (it leaves a `.relay-codex-home` file there): it refuses `~/.codex`, the `CODEX_HOME` your environment names, and a directory holding anything else, before writing to it, and `relay doctor` reports such a `home` without changing it. `pinned: false` makes relay run the Codex `targets.codex.bin` names instead, which no qualification has checked; `relay doctor` then shows the pin as off. See the README's [Codex](../README.md#codex) and [Pinned Codex](pinned-codex.md). |
| `targets.codex.stage2` | `true` switches stage 2 on: a Codex turn runs its commands in relay's own Seatbelt instead of Codex's sandbox whenever it has the network or may ask for approval (`escalation`, on by default); network grants then go through relay's mediated proxy, and `raw_network` and the `escalate` tool become available. Off by default. See [Codex raw network (stage 2)](#codex-raw-network-stage-2). |
| `targets.codex.daybreak` | (1.0) `true` requests OpenAI Daybreak (Trusted Access for Cyber) for eligible Codex models; `false` disables it; unset leaves it to Codex: its default, or a configuration layer relay does not write (relay's Codex does not read `~/.codex/config.toml`). Only your relay config can set it. For the enrolled account holder's own use only; never proxy or provide Daybreak to anyone else. |
| `targets.<id>` | Per target: `enabled` (whether relay may launch it; `claude` and `codex` are on unless switched off, targets added later are off until switched on), `bin` (where its executable is, if not on relay's PATH; Node is found by the launcher, see [install.md](install.md#how-relay-finds-node-and-the-clis)), `default_model` and `default_effort` (used when a call names none; unset means the CLI's own default), `speed` (`standard`, `fast` or `ultrafast`: the speed of a job, thread, discussion or review a root session starts with this target without naming one; a call that carries on a session and names none keeps that session's speed; unset means standard; see [Speed](usage.md#speed)), `child_auth` (that target's own sign-in policy, see `child_auth`), `child_env` (that target's environment policy, see above), and `experimental` (lets relay launch a target it has not qualified with a signed-in run, such as `copilot` or `grok`; off unless set; on a qualified target, such as `gemini`, it is accepted and changes nothing, so a config written before it was qualified still loads). Where Gemini's key file is goes in `~/.config/relay/local.json`, never here (see "Gemini CLI" in [install.md](install.md#gemini-cli)). For a target whose family is judged per model (Copilot, which runs several families' models; Grok, whose listed models are all xAI's), a named listed model supplies a family; no model, and on Copilot `auto`, is labelled unknown under the default `allow`, and a model Grok's list does not name is refused. For example `{ "claude": { "default_model": "opus", "default_effort": "high" } }`. A switched-off target is not started for callers: naming it for new work is refused with the reason, while naming it to continue one of its existing jobs, threads or discussions still works. |
| `targets.<id>.skills`, `targets.<id>.mcp_servers` | The skills and MCP servers (by their names in relay's `mcp.json`, each optionally with `allow_tools`) a job or thread of that target may be given when the root session asks for them and you consent. Claude and Codex only. In this release only skills work: a job or thread given an MCP server is refused, because no server has a qualified adapter to screen its calls against the never floor yet. See [Extensions](usage.md#extensions). |
| `default_target` | Per caller target, the target reached when omitted, for example `{ "claude": "codex", "unknown": "codex" }`. A known caller's default must be another routing family; a single eligible target is used when no default is set. With several eligible targets relay asks for a target. `unknown` is unset by default, has no family check, and is the only omitted-target path for unknown callers. A switched-off default is refused. |
| `default_model`, `default_effort`, `bin` | The earlier form of the per-target settings, keyed by target (`{ "claude": "opus", "codex": "gpt-6.1-sol" }`). Still valid, and the same as setting `targets.<id>.default_model` and so on. Setting one both ways is an error. |
| `allow_dangerous` | Run write jobs with each CLI's full-access mode. Off unless you set it here; no tool parameter can turn it on. |
| `allow_temp_home` | Lets relay's control directory (`RELAY_HOME`) live under a temporary directory. For tests only: a job's sandbox can write there. |

## The never floor

The never floor is a set of paths, ports and hosts kept from launched agents: no grant or approval can open them, and relay's sandboxes deny them where they enforce the floor (which agents do, and which entries, is below). Relay's built-in entries are always on unless you remove one:

- `credentials.files`: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, Codex's `~/.codex/auth.json`, Claude's credential files under `~/.claude`, `~/.config/gh/hosts.yml`, `~/.config/gcloud`, Gemini's login files under `~/.gemini`, `~/.copilot`, `~/.grok/auth.json`, `~/.config/relay-keys` and any key file you configured;
- `credentials.relay-codex-home`: relay's own Codex home and its login;
- `credentials.keychain`: `~/Library/Keychains` and `/Library/Keychains`;
- ports on this Mac: `service.sshd` (22) and `service.screen-sharing` (5900), TCP and UDP. Relay protects no other service by default: add your own (a database, a mail bridge, a local MCP server) under `never.ports` with `"destinations": "this-machine"`;
- `relay.config`, `relay.install` and `relay.authority`: relay's config files, its installation and pinned Codex (write-protected), and its control directory. These three cannot be removed.

You add to it with `never`:

```json
{
  "never": {
    "paths": [{ "path": "~/secrets" }, { "path": "~/infra", "access": "write" }],
    "ports": [{ "port": 5432, "transport": "tcp", "destinations": "this-machine" }],
    "hosts": ["internal.example.com"],
    "override_builtin": []
  }
}
```

- `paths`: literal absolute or `~/` paths (no patterns, no `..`), each with `access` `"all"` (the default) or `"write"`.
- `ports`: `port`, with `transport` `"tcp"`, `"udp"` or `"both"` (the default) and `destinations` `"this-machine"` or `"any"` (the default). `"this-machine"` keeps jobs from connecting to that port at any address of this Mac's own (loopback, LAN, tailnet) and from listening on it, as the built-in ports do; connections to other hosts on that port stay open. `"any"` refuses the port at every host. Relay's own sandbox, which cannot name the IPv4-mapped IPv6 forms of this Mac's addresses, refuses a `"this-machine"` port over IPv6 at every host.
- `hosts`: exact DNS names or IP literals, without a scheme, port, path or pattern. With any entry, Codex's hosted web search is disabled and read back, relay denies Claude's WebSearch and WebFetch, and offers no raw network (stage 2).
- Codex with stage 2 off: a turn's shell network goes through Codex's own network proxy in strict mode, which reaches none of this Mac's addresses and sends no UDP. So it enforces every `"this-machine"` entry, yours as well as the built-ins, and every UDP-only entry. It cannot enforce a `hosts` entry, or an `"any"` entry whose `transport` covers TCP, since it lets every public host and port through: while you have one, relay refuses a Codex turn with shell network (a network grant or `child_network`) before it starts. Local mode (`grant.local_network`) and `allow_dangerous` write turns reach this Mac's addresses directly, so relay refuses them while you have any `ports` entry or `hosts` entry; the built-in ports stay open to them, as local mode's consent says and as a turn without a sandbox implies. With stage 2 on, Codex's network goes through relay's own sandbox and proxy, which enforce every entry, and local mode is not available.
- `override_builtin`: removes a built-in group for new runs of every agent, for example `{ "id": "credentials.keychain", "acknowledge": "REMOVE BUILT-IN NEVER credentials.keychain", "reason": "…" }`. The acknowledgement must be exactly `REMOVE BUILT-IN NEVER <id>`, and the reason must not be empty. A removal grants nothing and cannot shrink the floor of a run already started. An override naming one of the two port built-ins relay 1.2.0 dropped is still accepted, removes nothing, and relay warns about it.

A run's floor only grows: each check reloads your config and adds to it. `relay doctor` shows the floor in force ("never policy") and which agents enforce what ("never enforced").

Which agents the never floor's path entries bind (`never.paths` and the built-in entries, among
them `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc` and the CLIs' login files) depends on the agent and
on stage 2. Codex's sandbox takes them on every sandboxed turn (not on an `allow_dangerous` write
turn with stage 2 off, which runs without a sandbox). Claude's sandbox settings take them on every
turn, whatever stage 2 says ([what a Claude job cannot do under it](security-model.md#what-a-claude-job-cannot-do-under-the-never-floor)).
Copilot's, Gemini's and Grok's sandbox profiles take them only with stage 2 on
(`targets.codex.stage2`), and stage 2 then refuses Copilot and Grok, whose login routes would bypass
the floor. With stage 2 off, the default, those three agents are not held to the path entries: they
can read those files as you can, while relay's own config, install and key files stay protected.
The path entries include the keychain files (`~/Library/Keychains`, `/Library/Keychains`). That
keeps items in file-based keychains, such as `gh`'s keyring token and git's osxkeychain
credentials in the login keychain, out of reach of the floored agents' commands: reading one needs
its keychain file as well as **keychain IPC**, the security daemons. Only relay's own Seatbelt keeps
the daemons closed (Gemini, and Codex's network turns, with stage 2 on). Claude Code's sandbox
leaves them open on every turn, and Codex's native sandbox opens them on a turn with shell network
(stage 2 off). What the daemons serve without a keychain file, such as data-protection keychain
items, is not covered, nor is a copy of a keychain file kept outside the denied directories; see
[Known limits](known-limits.md). Relay's network proxy,
where a turn uses one, still screens never hosts and ports for every agent. `relay doctor` says
which applies on this Mac ("never enforced").

## Environment policy

Configure exact names, never values, paths to secret files or shell expressions:

```json
{
  "child_env": {
    "policy": "allowlist",
    "pass": ["JAVA_HOME"],
    "drop": ["SSH_AUTH_SOCK"],
    "request": []
  },
  "targets": {
    "codex": { "child_env": { "request": ["GH_TOKEN", "NPM_TOKEN"] } }
  }
}
```

A root call can then pass `grant: { env: ["NPM_TOKEN"] }` for a private install;
add `network: true` separately when needed. Only the person can allow token release,
through a qualified dialog or `confirm`. A token must exist in the root server's captured
environment, be eligible in `request`, survive all mandatory guards and not be dropped.
Missing, forbidden or dropped names refuse the call before launch. Restart the root
server after changing its environment. Consent lasts one turn; request it again on resume.
To select a token without prompting, put its exact name in `pass` in your own config.
Never pass a powerful token just to fix a public install: network may be all it needs.

For every target, a person-set endpoint override in the root environment refuses launch
under both `child_auth: "login"` and `"any"`, before `child_env` filtering, even if the
variable would be excluded or dropped. This includes Claude's `ANTHROPIC_*BASE_URL`,
Codex's `OPENAI_BASE_URL` and Gemini's endpoint variables: relay cannot tell which family
answers there. Under `any`, losing the endpoint could also send a credential intended for
it to the vendor instead. Unset the named variables and restart the root. The exception is
a desktop/Agent SDK host's own Anthropic endpoint under Claude's login policy: relay
removes that host endpoint and credentials together and verifies the account login at init.

Every new turn obtains its environment from the owning root's relay server. If that
server has restarted, a resume or nested launch fails with a "restart the root" message
instead of inheriting another process's environment. A running turn is unaffected.
Codex also applies its own `shell_environment_policy` to commands it runs: a name
released by relay reaches those commands only if Codex's policy allows it too. Relay
does not override a stricter policy, such as `inherit = "core"` with `include_only`.
It says so instead: a Codex turn whose released names (`pass` or `grant.env`) include
ones Codex's effective policy withholds gets a note naming them and why (not inherited,
an exclude, `set`, no `include_only` match), and `relay doctor` does the same for
`pass` with the same check, for a job started in the directory it runs in (`codex env`). Names only, never values. Where relay does not recognise
the policy's shape, the note says it cannot tell.

The runtime baseline is `PATH`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `LC_COLLATE`,
`LC_MESSAGES`, `LC_MONETARY`, `LC_NUMERIC`, `LC_TIME`, `TZ`, `TERM`, `COLORTERM`,
`NO_COLOR`, `CLICOLOR` and `CLICOLOR_FORCE`. Toolchain variables such as `JAVA_HOME`
need `pass`. `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lowercase forms pass only
with a supported scheme/host/port and no credentials, query, fragment or non-root path;
`NO_PROXY`/`no_proxy` must be a host exclusion list. Values with recognized secret shapes
need explicit selection too. Relay's own proxy, config roots, temp paths and identities
always win. Names must match `[A-Za-z_][A-Za-z0-9_]*`; unknown keys, wildcard names and
attempts to pass/request reserved names are config errors. A root-level entry applies
wherever a target may receive it; each target's mandatory guard still removes it there
(for example, `GH_TOKEN` from Copilot under login), and doctor explains why. It is an
error only when no target could receive it; a target-level entry must be allowed there.
A target cannot clear root lists with `[]` or undo a root drop.

`relay doctor` previews each target's effective policy and included/dropped names with
reasons only, one line per outcome and reason. It never prints their values, proxy URL
contents or value hashes. For a short-term compatibility escape hatch set
`child_env.policy: "legacy"`; it warns on every root load and in doctor, preserves
mandatory guards, and does not restore the old global cross-vendor `child_auth: "any"`
exception. `tool-denylist` is unavailable in 1.0. See
[the upgrade instructions](UPGRADING.md#tool-token-policy-in-10-w9-2026-10-19).

## Codex launch checks

Every Codex turn runs through `codex app-server`. It is the only Codex entry point that delivers approval requests, and the only one that reports Codex's effective configuration. Before a turn starts, relay asks that server for the effective configuration in the job's directory and refuses to start unless it is what relay set: its sandbox, no other MCP server enabled, and plugins off.

The sandbox is a Codex permission profile of relay's own, `[permissions.relay]`, defined and selected with `-c` on every launch (`default_permissions = "relay"`) and named again on the thread, so that no setting a resumed thread stored outranks it. A read job reads everything but the credential stores relay denies (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc` and Codex's `auth.json`, at `$CODEX_HOME` where that is set), and writes nothing. A write job also writes its worktree, each directory you granted and its own temporary directory (never the rest of `/tmp`), and at the top of the worktree and of each granted directory it cannot create, change or remove harness configuration (`.claude`, `.codex`, `.gemini`, `.mcp.json`, `.envrc`, `.vscode`, the shell rc files and the rest of relay's list, as in relay's own sandbox); Codex also keeps its own protection of `.git`, `.agents`, `.codex` and `.aws`. Either has the network only when granted, and then only through Codex's network proxy (below). Under `allow_dangerous` a write job runs with Codex's built-in `:danger-full-access`. Both Codex's shell commands and its own file edits keep to the profile.

Relay checks the profile three ways: the effective configuration must select it and define it exactly as relay did (a `[permissions.relay]` table of your own adds keys to it, and relay then refuses); an administrator's requirements for Codex (`allowed_permission_profiles`, `allowed_sandbox_modes` in `requirements.toml` or managed preferences) must allow it, since Codex would otherwise fall back to another profile with only a warning; and the thread must report it as active, with the sandbox kind and network relay set, and the job's directory as its only workspace root (relay names it on every start and resume, since a resumed thread otherwise restores the roots it stored, and every workspace root is writable under relay's profile). Your own `default_permissions`, other `[permissions]` profiles and `sandbox_mode` do not matter: relay's selection outranks them. Relay starts Codex's app server with its experimental API on, which naming a profile on the thread needs. `codex_backend: "exec"` falls back to `codex exec`, without approval requests, making the same checks through a short-lived app server first (the requirements, since there is no thread yet to report its profile); under it, as before, a read job gets no network even when granted.

A job given network (a grant, or `child_network`) gets its shell's network through Codex's own network proxy (`features.network_proxy`, experimental in Codex 0.163.0 and 0.164.0), never Codex's plain network toggle, which also opens loopback and every Unix socket. The profile's network allows every public host (`domains = {"*" = "allow"}`), chains to no upstream proxy, and in **strict** mode (`allow_local_binding = false`) the proxy refuses loopback, private, link-local and other non-public destinations, including names that resolve to them, while Seatbelt lets commands reach only the proxy's own two ports and Unix sockets only under the turn's temporary directory and, for a write job in its own worktree, that worktree (a read job: none). In practice HTTP(S) works (`curl`, git over https, npm, pip); raw TCP, ssh remotes, direct DNS, this Mac's loopback and the local network do not. **Local** mode (`allow_local_binding = true`) is the same with loopback and the LAN open (loopback directly as well as through the proxy, and the job may listen on every interface, so devices on your LAN or tailnet can connect to servers it starts), for a write job whose grant has `local_network: true` and whose person consented (an approval request only you can allow, asked once for the grant the job holds and again when a resume changes it; refused up front where relay has no way to ask you). Before each such turn a short-lived app server started with exactly the turn's settings must show that Codex will do this: the effective configuration as relay set it (the proxy feature as `true`, the profile's network table exactly), no administrator's network requirements, `network_proxy` listed and on in Codex's own feature list (an unknown key is silently ignored, so reading back the key alone proves nothing), and a check Codex itself runs in that sandbox (`command/exec`) that finds the proxy, finds a loopback port and a Unix socket of relay's own unreachable, and has the proxy refuse loopback. Strict mode also needs no address of this Mac's own that the proxy would treat as public (a global IPv6 address, say), and no `network_rule` in any exec-policy rules file Codex would load (`$CODEX_HOME/rules`, `/etc/codex/rules`, any `.codex/rules` from the job's directory up), since a rule allowing an exact local host would open it. Where any of this fails, the turn runs with Codex's hosted web search only and no shell network, and its notes and its input say why. The turn's own server then repeats these checks (the requirements, the address and rules guards, the feature list and the sandbox check) before its thread starts; a mismatch there refuses the turn. Under `codex_backend: "exec"` the turn's own process (`codex exec`) reports nothing, so the repeat runs on the short-lived app server that checks its configuration first, just before `codex exec` starts. Each network turn's mode (strict, local or hosted search only) is in the job's notes, in `status` and the result. Every turn also has Codex's `request_permissions` tool and its `exec_permission_approvals` feature switched off, both read back (no access is added to one command's sandbox: the tool's requests are ones relay does not answer, and with the feature on a command an exec-policy rule allows would get the access it names without anyone being asked). On a job without a network grant, relay itself declines a command's request to add the network to its sandbox, and on any job a request to reach a host the sandbox blocked (with the proxy, only this Mac's own or a private address is; without it, no approval could give the network); each is recorded with the job's refusals and explained to the agent.

When requested, Daybreak eligibility comes from Codex's catalog; other or unknown models run without it, with plain notes in status/results. `relay doctor` shows the setting and eligibility; before Codex 0.163.0 the key has no effect because Daybreak was automatic for enrolled accounts. Keep it out of a config file a 0.9 relay also reads ([upgrade notes](UPGRADING.md)).

Relay archives its Codex threads after each turn, including failed or cancelled turns, so completed work leaves Codex's normal history and desktop Recents. Follow-ups automatically unarchive the same thread and archive it again afterwards; its context is preserved. Threads can appear while a turn runs. If archival fails, relay returns the answer with a warning; a worker killed before cleanup can also leave a thread visible. This uses Codex's own archive calls, keeps the usual Codex home and login, and applies to both backends. It does not archive older relay threads until they are continued through relay.

## Codex raw network (stage 2)

Stage 2 is an optional way of running Codex, off by default. Codex sends every command and file edit to a separate executor (`codex exec-server`), which relay starts inside its own Seatbelt sandbox, built for the turn; Codex's app server, with its login and model traffic, stays outside, with its own local actions switched off and read back. With stage 2 on, a Codex turn on the `app-server` backend runs this way whenever it has the network or may ask for approval (`escalation`, on by default); any other Codex turn, or one on the `exec` backend without the network, runs in Codex's own sandbox as with stage 2 off; an `exec`-backend turn with the network, and an `allow_dangerous` write turn that would not run this way, are refused. It brings mediated network for ordinary grants, raw network, and the `escalate` tool (see [Approval requests](usage.md#approval-requests)).

With stage 2 on, ordinary non-raw `grant.network`, `child_network` and kept network
grants on resume use relay's executor and the same mediated HTTP(S)/SOCKS5 provider
every turn, without escalation. Read jobs use it too, with filesystem writes still
refused. Provider or stage-2 qualification failure refuses launch with a reason;
there is no native strict or raw fallback. Stage 2 off retains the released route.
A replacement overlay preserves the mediated baseline plus its approved addition;
raw substitution is refused. Hosted web search still runs at OpenAI, live with a
network grant, and is disabled and read back with `never.hosts`.

Go and Swift TLS do not work in these jobs yet: Security.framework trust remains
disabled. Tools that ignore proxy variables fail closed. Results say
`stage-2 mediated`; the native `strict` note describes the stage-2-off route.

An approved `{kind:"localhost", operation:"connect", host:"127.0.0.1", port:P}`
uses IPv4 `localhost:P`, which also reaches port P on this Mac's LAN and tailnet
addresses. Requests and results disclose this scope, including failed/cancelled
turns. IPv6 `::1` stays refused; never/control ports and final denies still win.
Connect additions remain unavailable with `never.hosts` because a direct allowance
cannot screen forbidden DNS endpoints. Clearly authorized service API effects may
be approved by the owning supervisor; uncertain authority goes to the person.


Stage 2 is off by default. Switch it on with `"targets": { "codex": { "stage2": true } }` in relay's config. `RELAY_EXPERIMENTAL_CODEX_STAGE2=1` in relay's environment does the same; it is for tests and development.

With it on, the root session can give a Codex write job `grant: { "network": true, "raw_network": true }`. The job's shell then has raw network: TCP, UDP, ssh and DNS, not only HTTP(S) through a proxy. Its commands run in relay's own Seatbelt sandbox, not Codex's. Codex sends every command and file edit to a separate executor (`codex exec-server`), which relay starts inside that sandbox. The app server stays outside, as before, with its login and model traffic. The [design](codex-confinement-design.md) has the details and the probes.

The grant:
- It is for Codex write jobs only, with `network: true` in the same grant, on `codex_backend: "app-server"`. It cannot be combined with `local_network`, which is refused altogether while stage 2 is on (below). A turn runs only on Codex 0.164.0 or later, with `child_mcp: "relay-only"` and `child_hooks: false`, and without extension servers; otherwise relay refuses it and says why.
- Only you can allow it. Relay files a person-only approval request (`raw_network`) before the job's first turn under the grant. The root's `approve` and `relay approve` cannot allow it. Where relay has no way to ask you (no approval dialog or `confirm`, or escalation off), the grant is refused up front.
- Your consent belongs to the grant. A resume that changes `network`, `raw_network` or `write_paths` asks again. A resume that drops `raw_network` ends the consent, and adding it back later asks again.
- Launched agents cannot give it, and jobs that a raw-network job starts do not inherit it. A launched agent without it cannot steer, cancel or merge a job that has it.
- A read turn on the job's session (a discussion, say) uses stage-2 mediated network, with read-only filesystem access.

What the job can reach:
- The internet, over any protocol.
- Your local network (LAN) and your tailnet, on every port. Seatbelt cannot express address ranges, so relay cannot close them. A job that must not reach them should get `network: true` alone (stage-2 mediated network).
- This Mac's loopback, except the denied ports: TCP 22 (ssh), 5900 (screen sharing), 3283 (Remote Management), 3031 (Remote Apple Events), 445 and 548 (file sharing) and 631 (printing); the ports of your `never.ports` entries; every TCP port anything on this Mac listens on when the turn starts, your processes' and the system's (sshd, screen sharing, file sharing, a VPN's own listeners); and relay's reserved ports (47200-47263) other than the job's own block. UDP 1900 and 5351 are denied to every host, so the job cannot ask your router for port mappings.
- A service you start after the turn starts is reachable.
- Over IPv6, the denied ports are refused at every host, not only this Mac. Relay's sandbox cannot refuse the IPv4-mapped IPv6 forms of this Mac's addresses (`::ffff:0.0.0.0`, `::ffff:` and its LAN address) any other way, and they reach its services. So IPv6 to those port numbers anywhere fails, and so does IPv4 that a program sends through an IPv6 socket (Java does by default): with Tailscale's 443 in the snapshot, say, that is HTTPS over IPv6. IPv4 to those ports on other hosts is unaffected, and most tools fall back to it.
- Otherwise the deny matches this Mac's own addresses as destinations, nothing else. A router port forward reached back through NAT hairpin, a tailnet subnet router or a VM bridge can still lead to a denied service.

What changes for the job:
- **It can listen only on its own block of 4 TCP ports**, given to it as `PORT` and `PORTS`. Listening on port 0 (an ephemeral port) fails, and so does every fixed port outside the block: `node --inspect` on 9229, `python -m http.server` without a port, `ssh -L`, language servers and test runners that pick their own port. Tools that honour `PORT` work. A server bound on 0.0.0.0 on a block port can be reached from your LAN and tailnet.
- **Your running services are closed to it**, at every address of this Mac, IPv4-mapped forms included. The denied ports include whatever was listening when the turn started, yours or the system's: your database, ollama, Jupyter, a dev server. In practice the job reaches services started after its turn began, and the LAN.
- **git cannot write inside the job.** Relay's sandbox denies writes to the git directories, so `git add`, `commit`, `stash`, `checkout -b`, `rebase` and tools that call git (pre-commit hooks, `npm version`) fail. Relay commits the worktree at the end of each turn with its own message. The agent's own commits and messages are lost.
- Unix sockets work only under the turn's temporary directory, and in the job's worktree when relay made it. Executables run only from system, Homebrew, `/usr/local` and developer-tool locations, and the writable directories. Codex's image generation, hooks, plugins and apps are off.
- **Relay's tools come through a broker.** Its Codex app server runs without Codex's own local environment (`CODEX_EXEC_SERVER_URL=none`), so a turn Codex starts by itself (a queued message, a goal) has nowhere outside relay's sandbox to run a command, and no stdio MCP server can start. Relay therefore serves its tools (`delegate`, `ask`, `status`, `escalate` and the rest the turn may use) to the job from a broker of its own for the turn, outside the sandbox: an MCP server over HTTP on a port of relay's reserved range, which the job's commands cannot reach and whose credential only the app server holds. The agent sees it as `relay_tools`. No other MCP server runs on these turns (see Known limits for an executor-side discovery path not yet ruled out).

Local mode and the interlock:
- Codex's local-mode proxy has no authentication. A raw-network job could reach every denied port through it. Relay cannot move it into its reserved range, because Codex binds it on ephemeral ports whatever its configuration says.
- **While stage 2 is switched on, local mode is refused outright.** `grant.local_network` is refused on `delegate` and `resume`, and a turn of a job that still holds it from before fails before its agent starts, asking nobody; continue such a job with `raw_network` or with `network` alone.
- With stage 2 off, local mode works as [Delegate](usage.md#delegate) describes, with one interlock left for a relay whose runs differ (the switch is read from each run's config, fixed when the run starts): while a raw-network turn runs, relay opens no local-mode proxy, and such a turn gets hosted web search only, with the reason in its notes; while a local-mode turn that started before the switch runs, a raw-network turn is refused. This sees relay's own registry only: a relay with another `RELAY_HOME`, an older relay, and a port forwarder outside relay are not seen.
- With stage 2 on there is no mode with proxied egress and loopback: a job that needs a local server uses raw network, and takes raw egress, the LAN, the port block and the denied running services with it, or asks through `escalate` for a turn with one loopback port to connect to or listen on.
