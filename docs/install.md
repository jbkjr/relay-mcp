# Installing relay: hosts, targets, upgrading and uninstalling

The [README](../README.md#install) has the short version. This is the detail: what each install
does, each host (where your session runs) and each optional target (an agent relay launches),
upgrading and uninstalling.

Below, `<relay>` is the directory relay is installed in: `$(npm root -g)/@jbkjr/relay` after
`npm install -g @jbkjr/relay`, or your checkout (below). Hosts are registered with the launcher
inside it, `<relay>/bin/relay`.

## What install does

Every install is a dry run until you add `--write`. Before it changes anything it checks that the host's CLI runs and looks at what is already there:

- An installation that is already in place is left as it is; running install twice changes nothing the second time.
- An earlier relay registration (another checkout, one from before `--host`, or in the Claude desktop app one under the earlier name `relay`) is replaced, when relay can confirm it is its own: its launcher is inside a relay package, or relay's installation record names it.
- Anything else named `relay` is not touched: a different MCP server, a different plugin marketplace called `relay-local`, a file or another tool's link at `~/.local/bin/relay`. Install stops, changes nothing, and says what it found. `--force` replaces it, after saving what was there. (In the Claude desktop app's file the name relay uses is `relay-desktop`; a server of someone else's named `relay` there is left alone, and install goes on.) Relay's own entry is treated the same way if you have added settings of your own to it, or changed one that relay writes (a timeout, an approval mode): replacing it would lose them.
- A config file is copied to `<file>.bak-relay` before it is edited, or to a timestamped name if that exists. A backup is never overwritten. A replaced Claude Code registration or marketplace entry is saved under `~/.config/relay/install-backups/`.
- If a step fails, install stops there and exits with an error. It does not undo the steps that had succeeded; it lists them, including any registry migration with its backup path and recovery procedure. Uninstall removes host registrations but does not undo a registry migration; restoring the registry requires stopping every relay process and following the rollback procedure in [UPGRADING](UPGRADING.md). Running the same install again continues from where it stopped. `install codex --write` registers relay first and then readies relay's own Codex (its pin and its Codex home); if that fails, it keeps the registration, says what is not ready, and exits with an error. A checkout that ships no pin, or a pin you qualified here that stays in force, is not a failure.

What install changed is recorded in `~/.config/relay/install.json`, per host: each change, where what it replaced is saved, the command that reverses it, and the launcher path registered.

## Installing from a git checkout

For development, or to run a commit that is not released:

```sh
git clone https://github.com/jbkjr/relay-mcp.git ~/dev/relay && cd ~/dev/relay
npm ci
npm run build
bin/relay doctor    # platform, Node, both CLIs and their logins, and what is registered
bin/relay install claude --write
bin/relay install codex --write
```

The first time, the command is `bin/relay`, run from the checkout: `relay` on its own is not on your PATH until an install has made the link described below. A checkout ships no Codex pin, so run `relay qualify-codex` once after installing ([Pinned Codex](pinned-codex.md)). The build also compiles a small native helper (`native/sbcheck.c`) when Apple's command line tools are installed; without them the build still succeeds, and relay says that the helper is missing. The hosts run the checkout's `dist/` directly, so a rebuild there replaces live code ([Development](../README.md#development)).

## The `relay` command and your PATH

Each install also links `~/.local/bin/relay` to the launcher, which is what makes `relay` a command. That only works if `~/.local/bin` is on your PATH. To check:

```sh
command -v relay    # prints ~/.local/bin/relay if it is found
```

If it prints nothing, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new terminal, or keep using `<relay>/bin/relay`, which is the same command. `--no-link` installs without the link.

An npm install also puts a `relay` command in npm's own bin directory, which runs the same relay (`<relay>/dist/cli.js`, with the `node` your PATH finds), so there `relay` works without the link. The hosts use neither command: each is registered with the launcher's full path. `relay doctor` says which `relay` your PATH finds, and warns when it is not this relay's launcher or npm's command for this install.

## How relay finds Node and the CLIs

Hosts are registered with the launcher script `bin/relay`, not with a Node binary. Each time it starts it picks the first Node 24.15 or newer it finds: `RELAY_NODE` if you set it (the path of a `node` binary), then `PATH`, then fnm's default, nvm's installed versions (newest first), Volta, the asdf and mise shims, then Homebrew. Upgrading or removing a Node version does not break the registration.

`claude` and `codex` are found on `PATH`. If they are somewhere else, say where in `~/.config/relay/config.json`:

```json
{ "targets": { "claude": { "bin": "/path/to/claude" }, "codex": { "bin": "/path/to/codex" } } }
```

The earlier form, `{ "bin": { "claude": "…", "codex": "…" } }`, still works. `bin` locates the targets' executables only. It has no effect on which Node runs relay; that is `RELAY_NODE`.

## Claude Code

```sh
relay install claude --write
```

This runs:

```sh
claude mcp add -s user relay -- <relay>/bin/relay mcp --host claude
claude plugin marketplace add <relay>/adapters/claude
claude plugin install relay@relay-local
```

The MCP server gives Claude the tools. The plugin adds the slash commands `/relay:delegate`, `/relay:ask`, `/relay:discuss`, `/relay:review`, `/relay:tree`, `/relay:chat`, and two subagents that run one delegation or one question through relay and report back (a review or a discussion stays with `/relay:review` and `/relay:discuss`, where your session is one side): `relay:operator`, which leaves `target` out (relay picks an agent of another family, or asks for one to be named) unless told which agent to use, and `relay:codex`, which always names Codex, so you can say "use the codex agent". They set `background: true`, so Claude Code runs them in the background (in an interactive session, where fork mode is on by default, it does so for every subagent) and the report arrives as a notification when the work is done, with three exceptions: under `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` they run in the foreground; Claude Code refuses to start them from an in-process agent-team teammate, whose subagents run only in the foreground; and under `claude -p`, once your session's last turn has ended, Claude Code waits for a background subagent only 10 idle minutes (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`; `0` waits without a limit), then stops it and drops its report. The relay job runs on, and `relay tree` shows it; the `-p` session's exit leaves its run orphaned, so a later session's `result` answers `Item unavailable.` until that session adopts the run (**Run access and recovery in 1.0**, below). They run on Sonnet rather than your session's model: from Claude Code 2.1.251 a subagent's own model outranks `CLAUDE_CODE_SUBAGENT_MODEL`, so only a model Claude passes for one call, or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, puts them on another; before 2.1.251, `CLAUDE_CODE_SUBAGENT_MODEL`, when set, wins. Neither has the tools that decide an approval request (`approve`, `confirm`), nor `adopt` or `merge`: each reports an approval request back to your session, an `Item unavailable.` answer with its recovery text, and a write job's branch with its diff summary, so that your session looks before it merges. Each is told to pass on a grant (network, write paths) only as your session gave it. The plugin also carries `relay:write-for-codex`, a short brief, written by Codex, on writing a task or question for Codex so it does its best work; Claude loads it itself before it delegates or asks.

## Codex

```sh
relay install codex --write
```

This appends a block to `~/.codex/config.toml` (`$CODEX_HOME/config.toml` when `CODEX_HOME` is set) and installs the plugin. With relay installed by npm under Homebrew's Node, the block reads:

```toml
[mcp_servers.relay]
command = "/opt/homebrew/lib/node_modules/@jbkjr/relay/bin/relay"
args = ["mcp", "--host", "codex"]
env_vars = ["CODEX_HOME","CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]
tool_timeout_sec = 11400
startup_timeout_sec = 30
default_tools_approval_mode = "approve"

[mcp_servers.relay.tools.approve]
approval_mode = "prompt"
```

```sh
codex plugin marketplace add <relay>/adapters/codex
codex plugin add relay@relay-local
```

After the registration, `install codex --write` puts the release's shipped Codex pin in place. Relay runs Codex only from a pinned copy, never from your own `codex`; how the pin works, when you need `relay qualify-codex`, signing in with relay's own Codex home, and keeping up with Codex releases are in the README's [Codex](../README.md#codex) section and in [Pinned Codex](pinned-codex.md).

`relay doctor`'s "codex login" line judges relay's Codex home as each Codex turn does: by the account Codex's app server reports for it (`account/read`), not only by `codex login status`, which finds a stored login even when Codex no longer accepts it. Where a login is stored but Codex reports no account (most likely one that expired and could not be refreshed), the line is a requirement not met, and it and each refused turn give the command to sign in again: `CODEX_HOME=<targets.codex.home> <pin store>/current/bin/codex login`, with `--device-auth` on a remote or headless Mac, which needs device code sign-in switched on in ChatGPT's Security settings.

Hand-maintained registrations need the `env_vars` line too: it forwards the Codex home used to locate review transcripts and the originator marker used for host qualification.

The file is parsed before the edit and again after it, and it is written only if the result parses, `mcp_servers.relay` is exactly the block above, and every other setting is unchanged. Its line endings are kept. If it does not parse, or already defines `mcp_servers.relay` in a form relay does not edit (a quoted or spaced table name such as `[mcp_servers."relay"]`, an inline table, dotted keys), relay writes nothing and says which lines to remove by hand.

Codex has no custom slash commands; the plugin's skills are invoked as `$relay-delegate`, `$relay-ask`, `$relay-discuss`, `$relay-review`, `$relay-tree`, `$relay-chat`, plus `$relay-write-for-claude`, a short brief, written by Claude, on writing a task or question for Claude, which Codex loads itself before it delegates or asks. If you would rather not use the plugin, paste `adapters/codex/AGENTS.snippet.md` into your `AGENTS.md`; Codex then reads the brief with relay's `brief` tool.

Relay installs no Codex subagent role. From Codex, call relay's tools directly: `delegate` returns at once, and the job's completion arrives in the `events` of your next relay call, or through a `status` wait. A Codex subagent you start yourself (`spawn_agent`) can call relay too, but each Codex thread starts a relay server of its own, so the subagent's calls belong to another root session than yours, and no person is in its conversation: relay takes a denial of an approval request from it but not an allowance, and no grant. For a job that needs a grant, or whose approvals, merge and resume you want in your own session, make the call from your own thread; a native Codex subagent cannot read or wait on its parent's items, so call `status` and `result` from the parent thread.

`tool_timeout_sec` controls how long Codex accepts a tool reply. Relay reads the root registration in `$CODEX_HOME/config.toml` (otherwise `~/.codex/config.toml`) and ends all waits in one call before that timeout, including nested waits: 50 seconds for a 60-second timeout, or 11390 for the install’s 11400. Missing or unreadable registrations use Codex’s 60-second default. A launched Codex uses the timeout relay sets for that turn (at least 7500 seconds, including a finite 3600-second overlay budget and 300 seconds for transitions), independently of the root registration. The margin is 10 seconds, or one sixth of a shorter timeout. `status` says `wait_ended` when it returns early; call again to continue waiting. `relay doctor` explains caps that shorten configured waits. Restart the session after changing its registration; keep timeout overrides outside that file consistent with it, since relay cannot see them. `default_tools_approval_mode` stops Codex asking you about every relay call; the one exception is `approve`, the call that decides a launched agent's approval request, which Codex confirms with you. With `approvals_reviewer = "guardian_subagent"` in your Codex configuration, Codex's automatic reviewer answers that confirmation instead of you, and can approve relay's `approve` call without asking you.

## Claude desktop app and Cowork

The desktop app reads local MCP servers from its own config file, not from Claude Code's, and a running app overwrites that file. Quit the app, then:

```sh
relay install claude-desktop --write
open -a Claude
```

The app does not inherit your shell's PATH, so the entry carries one. It is built at install time from where `node`, `claude`, `codex` and `git` are on your machine, followed by the system directories, and install warns if `claude` or `codex` was not found. If you later move one of them, run the install again.

The desktop app does not start its own relay inside your project, so a session using it passes `cwd` (the absolute path of the project) on `delegate`, `discuss`, `review` and `merge`, and on `ask` when the question is about a project. Without it relay refuses a new start and says so, except that a new `ask` then consults in a new, empty directory of its own, made under `~/.local/share/relay/consult` (`$RELAY_HOME-consult` under a custom home), so a question that needs no files works as it is. Each such thread has its own directory, kept for its follow-ups, so nothing one conversation's agent leaves there is where another's starts; no job may be granted or given a file change there, and relay refuses to ask there while the consult directory holds anything it did not put there. A call about an existing item (a follow-up, or `discuss` with a thread) works where that item works. A terminal session never needs `cwd`, and a launched agent cannot set it.

The entry is named `relay-desktop`. The app starts relay twice from it, outside any project: once for its chats, and once for Cowork and the Code tab together, into each of whose sessions it passes that relay's tools as a server named after the entry (`mcp__relay-desktop__*` in Claude Code). Cowork sessions get MCP servers only this way. A Code tab session also has the relay Claude Code starts for it from its own registration (`relay install claude`), named `relay`, inside its project, with notices and `confirm` as in a terminal; the tool descriptions of `relay-desktop` start by telling the agent to use that one where it has it. An entry an earlier version left under the name `relay` hides the tools of the Code tab session's own relay: `relay install claude-desktop --write` renames it, and until then `relay doctor` and `relay install claude` warn about it. A server named `relay` there that is not relay's is left alone.

**This entry is shared by conversations, which a session token keeps apart.** Desktop chats in the main window share one relay process, through the claude.ai web page relayed by the app. Cowork, the Code tab's in-app bridge, remote Cowork and widgets share a second process (`local-agent-mode-relay-desktop`). The Code tab's own dedicated `relay` registration is separate and unaffected.

Claude.app **2.42304.0 (checked 2026-10-17)** forwards only `{name, arguments}` on tools/call through either process, with no per-conversation `_meta` or `progressToken`. The claude.ai web client sends `_meta["anthropic/conversationUuid"]` only to Claude in Chrome. That gate is in remotely served JS and can change without an app update. So relay gives each conversation a token its model carries:

- The first call of a conversation without `session_token` gets `new_session.token` (`rs1_` and 56 hex digits) and does nothing else; `status` with no id also answers, in an empty scope. The model passes the token as `session_token` on every later call. A model that only left its token out once is told to call again with the one it has: the new token has none of its work. The tool descriptions and relay's instructions on this entry say so.
- Each conversation then has its own run, jobs, approval requests, events and `request_id`s. Another conversation naming its ids gets `Item unavailable.`, exactly as for an unknown id. A token relay did not issue (mistyped, invented, from another relay home) gets `Session unavailable.` and nothing happens.
- Relay keeps only a hash of the token and returns it only once, when it issues it. It refuses a call whose text holds a token-shaped string (in any case), so that a token is not passed to another agent, and it cuts token-shaped strings out of what agents write (their logs, final messages and results) before keeping or returning it. A restart of the shared process (the app restarts it on its 60-second timeout, and on quit and reopen) keeps each conversation's work: it goes on by its token, without adoption, and a job's worker that outlived the old process finds the new one's environment broker.
- **The token is a bearer key, and this separates conversations that use relay honestly.** It does not stop a model that sees another conversation's token (in a transcript, the app's logs, a file, or a paste) from acting as that conversation: reading its work, deciding its requests, cancelling, merging, and taking its events. Local processes running as you can read relay's registry and the app's logs anyway. Deleting `session.key` in relay's home revokes every token at once; to move their runs to new tokens, quit and reopen the app, then run `relay adopt` from a terminal (`relay cancel` there stops the work instead).

**Auto mode can block the token.** Seen on 2026-10-25, from a cloud session that reached this entry through the person's Mac: Claude Code's auto-mode classifier took `session_token` for a credential copied from tool output and sent to a tool that starts another agent, and refused the call. The token goes only to relay, which refuses any task or message that holds one, but the classifier cannot see that, and confirming in the chat did not reliably get past it. Allow the entry's tools with a permission rule in that session's settings: `mcp__<server>__*`, with the server name the session gives the entry, such as `mcp__relay-desktop__*` (or `mcp__remote-devices__relay-desktop__*` through the remote-devices bridge, not yet checked). Claude Code settles a call that matches an allow rule before the classifier sees it ([permission modes](https://code.claude.com/docs/en/permission-modes#how-the-classifier-evaluates-actions)), so `approve` and `merge` then go unclassified as well. Otherwise use a permission mode that asks. Don't reshape the token so that it looks like something else: it is a secret.

`status.session` reports a conversation's scope (`conversation-token`), its fingerprint and this limit; `relay doctor` describes both shared processes.

There is no approval dialog, `confirm` or notice through this shared entry; requests arrive with the next call of the conversation that owns the run (`relay approvals` lists them from a terminal). A new `delegate`, `discuss` or `review` still needs explicit `cwd`, as does a `merge` (its destination); a new `ask` without one gets a directory of its own. The app's 60-second tool timeout can restart the shared process for every session using it (observed for Cowork/Code on 2026-10-16), so relay ends each wait after 50 seconds and the agent calls again. This cap also applies to `local-agent-mode-…` clients without `--desktop`. Register this entry for desktop chat or Cowork, with `--desktop` as `relay install claude-desktop --write` writes it (`relay doctor` warns about an entry without it); Code-tab sessions can use their own registration. Quit the app before `relay uninstall claude-desktop --write`.

<a id="run-access-and-recovery-in-10"></a>

**Run access and recovery.** A separate relay connection cannot read or change another connection's run by naming an item, even after its owner exits. Unknown and foreign items both answer `Item unavailable.` with the same fixed recovery hint. Starts report `run_id` and an `adoption` description. The terminal's inspection and approval commands remain administrative. To recover an orphan, get the destination connection's `status.session.fingerprint`, then explicitly call `adopt({run_id: <any job, thread, discussion, review or run id>, into_session, in_directory, item_count})`: a qualified Claude Code host asks the person through its permission prompt. Copy `in_directory` and `item_count` exactly from that run's last reported `adoption` description; a stale count requires terminal recovery. On other hosts, including relay-desktop (whose app Allow prompt cannot authorize adoption), the person first runs `relay adopt <id> --to <fingerprint>` in an interactive terminal and types the exact transfer shown, then the destination calls `adopt` within ten minutes. Piped stdin is refused. A root agent with unrestricted shell access and a pty is outside the threat model. This transfers supervision of the whole run, its jobs, approvals and pending events; it does not add a family contribution until work is continued. A model's `user_confirmed`, cwd or family cannot adopt. On the shared desktop entry a conversation keeps its runs across restarts by its session token; a conversation that lost its token gets a new one, and the person adopts the old run into it with `relay adopt` after the app has been quit and reopened (the live shared process holds the run until then).

The desktop app has no relay plugin, so a session there has no `write-for-codex` skill; it reads the same brief with the `brief` tool, which every host has.

The same token also binds a room seat on this shared entry: a conversation uses its existing `session_token` on `room` calls, and there is no separate room key. Relay cannot tell whether anyone is at a desktop chat or Cowork session, or establish its permission mode, so a conversation there cannot open a room; creating one in your terminal supplies the opt-in. Rooms in the desktop app have not been qualified. See [Rooms](usage.md#rooms) for the bounded exchange and the restart rules.

The ChatGPT desktop app shares `~/.codex/config.toml` with the Codex CLI, so `relay install codex` covers its Codex side; the same `cwd` rule applies if it starts relay outside the project. Relay does not show approval dialogs there: only the app's idle case has been checked. The app's Work mode, its counterpart to Cowork, runs on the same bundled Codex and the same `~/.codex/config.toml`, so the same install covers it. Each Work conversation gets its own relay process (checked on 2026-11-19), so relay keeps conversations apart as it does on the Codex side, with no session token. Relay sees both sides as the Codex host (`codex-mcp-client`) and does not tell them apart. A Work conversation outside a project runs in a folder the app makes for it under `~/Documents/Codex/`, not a git repository: give a write job or merge `cwd`, your repository's absolute path. The app's ordinary chat mode runs no local MCP servers (checked on 2026-11-19: it finds no relay tool), so relay is not available there.

## Gemini CLI

Google's Gemini CLI (`gemini`, also over the Agent Client Protocol) is qualified for 1.0, switched off by default (`targets.gemini.enabled`), and the one target that signs in with an API key: Google no longer serves Gemini CLI's "Login with Google" to consumer accounts, and its Workspace route needs a Gemini Code Assist subscription Google no longer sells. Relay reads the key from a file you keep (`~/.config/relay-keys/gemini-api-key`) and hands it to Gemini's process alone, and only with `targets.gemini.child_auth: "any"`. It runs only inside relay's own sandbox, in an untrusted folder, where Gemini connects no MCP server: its agents get relay's tools through Gemini's own tool discovery instead. Its qualification runs with a real key (2026-10-21 and 2026-10-22) passed every check that concerns relay, and the maintainer qualified it on 2026-10-22, accepting the limits listed under [Known limits](known-limits.md) ([design and setup](gemini.md), [qualification record](qualification/gemini-0.64.0.md)).

Gemini CLI signs in only with a Gemini API key. To use it through relay:

1. Create a key in Google AI Studio (aistudio.google.com) on a personal Google account. A free-tier key's prompts may be used by Google to improve its products; use a paid-tier key for code you care about.
2. Save it as one line in a file of your own, typed at a hidden prompt so that it reaches neither the screen nor your shell history:

   ```sh
   mkdir -p ~/.config/relay-keys && chmod 700 ~/.config/relay-keys
   (umask 077; printf 'Gemini API key: '; IFS= read -rs KEY; echo; printf '%s\n' "$KEY" > ~/.config/relay-keys/gemini-api-key; unset KEY)
   ```

   The directory sits beside `~/.config/relay`, not inside it, so a config directory you sync does not carry it. Relay refuses the file if it is a link, has a second name, is not yours, is readable or writable by group or others, sits in a directory others can write, sits where agents relay launches write without a grant (a temporary directory outside your home, relay's state, worktrees or harness directories), or holds anything but one key. To keep it elsewhere, name it in `~/.config/relay/local.json`, a file of this machine's own that is never synced: `{ "targets": { "gemini": { "api_key_file": "~/elsewhere/gemini-api-key" } } }`. Relay's sandbox denies the agents it confines the default directory whole, and a key file kept elsewhere by itself (the rest of its directory stays as readable to them as your other files). Claude and Codex agents relay launches may read neither: the never floor denies both to their commands (not to a Codex write job run without a sandbox under `allow_dangerous`).
3. Install Gemini CLI from npm (Homebrew's formula is frozen at 0.46.0), best a version relay's tools were checked on, now <!-- verified:geminiToolDiscovery -->0.64.0, 0.65.0, 0.67.0 and 0.68.0<!-- /verified --> (live on 0.64.0 and 0.65.0; on later versions by comparing Gemini's source with the last one checked, without the live checks): `npm install -g @google/gemini-cli@<version>`, the newest being <!-- verified:geminiToolDiscovery:last -->0.68.0<!-- /verified -->. Relay runs 0.64.0 or newer (an older one only with `allow_untested`), and offers its tools on any of them, checking at each launch that Gemini ran relay's discovery command.
4. Switch the target on in relay's config: `"targets": { "gemini": { "enabled": true, "child_auth": "any", "default_model": "gemini-3.8-flash" } }, "default_target": { "claude": "codex", "codex": "claude" }`. `child_auth` must be set for `gemini` itself; the global `child_auth` does not count. Gemini needs no `experimental`; a config that still sets it, from before Gemini was qualified, works as before. With a free key, name a Flash model, since `auto` may pick a Pro model that has no free tier. Set `default_target` too (to the defaults you want): with Gemini on, a Claude or Codex session that leaves `target` out has two agents of another family to choose from, and relay refuses the call as ambiguous until it names one.
5. `relay doctor` says whether the key file is in place and private, and whether relay's sandbox keeps confined agents from it, without reading it out.

Relay never stores, logs or prints the key. It reads the file before each Gemini turn and hands the key to that turn's Gemini process in its ACP sign-in request, nowhere else and never in an environment: inside relay's sandbox the commands Gemini runs could read Gemini's start-up environment. How and why: [docs/gemini.md](gemini.md).

Gemini has no reasoning-effort setting: relay takes `effort` and `targets.gemini.default_effort` for it without applying them, and runs it at standard speed only. A write job's granted directories (`grant.write_paths`) join Gemini's workspace, so its own file tools can write there (a directory whose path holds a comma, or starts or ends with a space, is left out, and only its shell commands can use it). A resume message or follow-up that starts with `/` or `$` goes to Gemini with a line in front, so that Gemini does not run it as one of its own commands.

A Gemini agent reaches relay's tools (delegate, ask, status and the rest its turn may use) through Gemini's own tool discovery, which relay sets up in its own Gemini settings, as `discovered_tool_delegate`, `discovered_tool_status` and so on; its prompt says so. Relay offers them on any Gemini version it runs, and checks at each launch that Gemini ran relay's discovery command for the session (which shows only that, not that every call will work): where it did not, relay tells the agent before its prompt that it has no relay tools, the turn's warnings say so, and the turn goes on. Discovery that runs and fails is different: Gemini then fails the turn at its start; use a version relay's tools were verified on, or `allow_delegation: false` for that work. They were checked on Gemini CLI <!-- verified:geminiToolDiscovery -->0.64.0, 0.65.0, 0.67.0 and 0.68.0<!-- /verified -->: live on 0.64.0 and 0.65.0, and on later versions by comparing Gemini's source, their live checks not run. On another version a turn gets a short note saying so, and `relay doctor` says whether the installed one is on that list. How and why: [docs/gemini.md](gemini.md) §3.8.

## OpenCode

OpenCode 2 (the `opencode` CLI; checked with 2.1.4 from Homebrew on 2026-10-26) can use relay as a host: its sessions reach Claude Code and Codex through relay's tools. Relay has no installer for it yet; register relay with OpenCode's own command, then restart OpenCode's background service, which reads its configuration when it starts:

```sh
opencode mcp add --global relay -- <relay>/bin/relay mcp
opencode service restart
```

That writes `mcp.servers.relay` into `~/.config/opencode/opencode.json` (without `--global`, into the current project's `opencode.json`). Restart the service again after upgrading relay, as you would restart any host's sessions. The service keeps the environment of the shell that first started it, and relay looks for `claude` and `codex` on that PATH; if it cannot find them, name them in relay's config (`targets.<id>.bin`, see above). Claude Code and Codex must be installed and signed in as for any other host.

Leave `--host` out. OpenCode runs models of many families, and relay cannot see which one a session runs, so it labels the caller's family unknown (OpenCode's client name would contradict a `--host` anyway). An OpenCode session therefore names a target on every call that starts work (`target: "codex"` or `"claude"`, `reviewer` for a review), or you give such sessions a default in relay's config, `"default_target": { "unknown": "codex" }`; without either, relay refuses the call and says which targets there are. Pick the family your OpenCode model is not (a Claude model there should name `codex`): relay cannot check it, and every item's `families` says the relation is unknown.

**Each OpenCode session has its own relay scope.** OpenCode's service runs one relay process for all its sessions in a project, and puts the session on each tool call (`_meta["ai.opencode/sessionID"]`). Relay keeps each session's runs, jobs, approval requests and events apart by it; another session naming their ids gets `Item unavailable.`, as for an unknown id, and `status.session` reports the scope `host-session`. A subagent of OpenCode's runs in a session of its own, so the work it starts through relay is its own too: its parent session cannot check, collect or merge it through relay, and the subagent reports its result and branch back as any subagent does. The session ID separates sessions OpenCode stamps faithfully; it is not a secret, and not authentication. The scope lasts as long as that relay process: after OpenCode restarts its service, earlier work is recovered by `relay adopt <id> --to <fingerprint>` in a terminal (the fingerprint is in the session's `status.session`) and then `adopt` from the session (**Run access and recovery in 1.0**, above). A call that carries no session ID does nothing. OpenCode 1.x sends none, and a 1.x release keeps one scope for all its sessions, as an unrecognised host does; any other version OpenCode reports (its beta and dev builds say `0.0.0-…`, an unbuilt one `local`) is taken for 2.x.

**Approval requests** go to the OpenCode session's agent, which decides them with `approve`, or to you with `relay approve` in a terminal (`relay approvals` lists them). Relay puts no dialog through OpenCode: OpenCode offers MCP elicitation, but relay has not checked how it shows one, so a person-only request (environment disclosure, extensions) cannot be allowed from an OpenCode session. OpenCode lets an MCP call run for 12 hours by default, so relay's waits run as long as `block_s` says. OpenCode calls MCP tools from code through its own `execute` tool (`tools.relay.delegate({...})`); nothing needs setting up for that.

Relay cannot launch OpenCode as a target (an agent relay starts) yet; [docs/opencode.md](opencode.md) has the design and what stands in the way.

## Copilot CLI (experimental)

GitHub Copilot CLI (`copilot`, driven over the Agent Client Protocol) is an experimental target: switched off by default, and launched only with `targets.copilot.experimental: true`, because relay has not qualified it with a signed-in run (a recorded check, on a machine, that a version of a harness meets relay's requirements when signed in). It ships that way by the maintainer's choice (2026-10-17). It runs only inside relay's own sandbox, after the per-turn boundary probes have passed under exactly that turn's sandbox. Copilot Free offers only automatic model choice (`auto`), whose family relay cannot tell: under the default `same_family: "allow"` relay runs it and labels the work family unknown, and under `"refuse"` it refuses it ([qualification record](qualification/copilot-1.0.98.md)).

## Grok Build (experimental)

xAI's Grok Build (`grok`, driven over the same protocol through `grok agent stdio`) is experimental on the same terms: switched off by default, launched only with `targets.grok.experimental: true`, not qualified with a signed-in run, and run only inside relay's own sandbox. What relay does with it comes from the 1.0.62 package run without a login, the user guide that binary ships, and its public source, which lags the binary. Relay runs it on the login `grok login` keeps in `~/.grok` only, and lets its turns refresh that login there as Grok does (its lock, a temp file and a rename) and change nothing else in that directory: a stated downgrade (see Security model). To use it: an xAI account (on 2026-10-17, x.ai/pricing listed Grok Build as "Limited" on the free plan and included from Plus, at $8 a month), `npm install -g @xai-official/grok@1.0.62` and `grok login` on your Mac, with `GROK_HOME` and `GROK_AUTH_PATH` unset where relay runs (relay refuses a login kept elsewhere), then `targets.grok` with `enabled` and `experimental` set; `relay doctor` then says whether anything on the machine would make relay refuse every Grok turn (Grok settings in `/etc/grok` or from device management, a login kept elsewhere, or a login directory relay's sandbox would not run on). Name a model relay knows (`grok-4.6`, say) in each call to Grok: without one relay labels the call family unknown, and under `same_family: "refuse"` refuses it; relay runs Grok on no model its list does not name (`auto` included), under either setting. A `targets.grok.default_model` saves naming it, but makes Grok a candidate for every call that names no target, so Claude and Codex sessions, which reach each other today when they leave `target` out, would have to name one each time; to keep that, also set `default_target.claude: "codex"` and `default_target.codex: "claude"`.

## Upgrading

From npm: `npm install -g @jbkjr/relay@latest`. From a checkout: pull, then `npm ci` and `npm run build`. Either way, run `relay install <host> --write` again for each host, and restart the host's sessions (each runs its own relay server; the Claude desktop app runs the relay of its own entry, `relay-desktop`, for all its chats and for all its Cowork and Code tab sessions, and restarts it only when you quit and reopen the app). `relay install codex --write` also puts the new release's shipped Codex pin in place, unless a pin you qualified on this Mac is current: until it has, relay refuses the old release's shipped pin, which names the old build ([Pinned Codex](pinned-codex.md)). For the desktop app this also renames an entry an earlier version left under `relay` (see "Claude desktop app and Cowork"). For Claude Code and Codex it puts relay's plugin in again wherever the host's own copy of it is not this installation's `adapters/` (another version, or the same version with other content). In a checkout, a pull alone leaves the old build in `dist/` running; `relay doctor` reports the commit the build was made from and warns when the checkout has moved on. The first install after an upgrade backs up relay's registry (`~/.local/state/relay/relay.db`) next to itself before migrating it, and prints the backup's path; going back to the earlier version means restoring that backup. The config file is validated strictly by every version, so a setting only the newer version knows stops an older one. Details, including a config shared between machines: [docs/UPGRADING.md](UPGRADING.md).

## Uninstall

```sh
relay uninstall claude            # prints what it would remove, and changes nothing
relay uninstall claude --write
relay uninstall codex --write
relay uninstall claude-desktop --write    # with the app quit
```

Uninstall takes relay's own entries out of that host and leaves everything else as it is:

- Claude Code: `claude plugin uninstall relay@relay-local`, `claude plugin marketplace remove relay-local`, `claude mcp remove -s user relay`.
- Codex: the `[mcp_servers.relay]` tables in `~/.codex/config.toml`, any proxy role a pre-release build wrote under `~/.codex/agents/`, then `codex plugin remove relay@relay-local` and `codex plugin marketplace remove relay-local` (`CODEX_HOME` is honoured).
- Claude desktop app: the `relay-desktop` entry under `mcpServers`, and relay's own entry under its earlier name, `relay`, if one is left.

Config files are edited in place, with the same checks and backups as install. A backup is never copied back, so whatever you have added to a file since installing stays.

A proxy role is removed only while it carries relay's ownership marker, and is saved first; a file of that name without the marker stays, even with `--force`.

Uninstall reads the record install left: an entry that still runs the launcher the record names is the one relay put there. Where there is no record (an installation made by an earlier version), or the record does not account for an entry, the entry is relay's if its command is a relay launcher (`…/bin/relay mcp`) inside a relay package (one whose `package.json` names relay). An entry of that shape with no relay package behind it (a checkout deleted since, or another program's `bin/relay`) is not taken as relay's: install and uninstall leave it and say so, and `--force` replaces or removes it. Anything else named `relay` (in the desktop app's file, `relay-desktop`) is left where it is and reported; `--force` removes it too, after saving it. A server of someone else's named `relay` in the desktop app's file is not relay's name there any more, and stays even with `--force`.

The link `~/.local/bin/relay` is removed when no host has relay registered any more, or when you add `--remove-link`, and only if it is relay's link: a symlink to the launcher of a relay checkout. Another tool's link of the same name, or a file, is left where it is.

Uninstall does not delete the following, because they can hold your work or your logins. It prints the same list with the paths on your machine (the default locations are shown here), marks the ones that hold credentials, and gives the commands that remove each:

- `~/.local/state/relay`: the registry of runs, logs, the prompts sent and the transcripts.
- `~/.local/share/relay/worktrees`: the worktrees of write jobs.
- `~/.local/share/relay/consult`: the directories questions without a project were asked in.
- `~/.local/share/relay/harness`: the state of the harnesses relay confines itself (each item's Copilot, Grok or Gemini home).
- `~/.config/relay`: your configuration, its local settings (`local.json`), the installation record and what install saved.
- `~/.local/share/relay-codex-home` (`targets.codex.home`), relay's Codex home: **holds the Codex login** relay's jobs run on (`auth.json`), and their Codex sessions.
- `~/.local/share/relay-codex-pins` (`targets.codex.pin_store`): relay's pinned Codex releases, sealed read-only (make them writable with `chmod -R u+w` before deleting), and the qualifier's results.
- `~/.config/relay-keys`: **holds the API keys** relay hands a key-only target (Gemini). `local.json` can name a key file elsewhere, which is yours to delete.
- `~/.relay-t` and `~/.rn`: relay's private sockets and per-turn state, and the short temp directories it gives Claude's turns; `/Users/Shared/.rn-<uid>`, a link to `~/.rn` made for a long home directory.
- `~/.rsm/q`: the Codex qualifier's scratch runs.
- The Codex qualifier's LaunchAgent, if you installed it ([Pinned Codex](pinned-codex.md)): `~/Library/LaunchAgents/<label>.plist` and its logs in `~/Library/Logs/relay-codex-qualifier`. Stop it with `launchctl bootout gui/$(id -u)/<label>` before deleting the plist; uninstall names the ones it finds.
- In each repository where relay ran a write job: the line `.relay/` in `.git/info/exclude`, and any `relay/*` branches.

To remove them by hand, run `relay clean` first, while the state directory still exists (after the link is gone, `<relay>/bin/relay clean`). It commits work left in finished jobs' worktrees to their branches, removes those worktrees, and deletes `relay/*` branches that are already merged; it lists the unmerged ones it kept, so no work is lost. Then, in each of those repositories, `git branch --list 'relay/*'` shows what is left: merge what you want, delete the rest with `git branch -D <branch>`, and delete the `.relay/` line from `.git/info/exclude`. After that stop the qualifier's LaunchAgent if there is one, delete the rest, and relay itself: `npm uninstall -g @jbkjr/relay`, or delete the checkout.

Uninstall suggests `rm -rf` only for a directory relay named itself: its default location, or one it derived from `RELAY_HOME` (`<RELAY_HOME>-worktrees`, `-consult`, `-harness`). A directory you named (`RELAY_HOME`, `RELAY_WORKTREES`, the directory of `RELAY_CONFIG`, a `targets.codex.home` relay did not make, or `targets.codex.pin_store`) could be your home or hold your own files, so for those it names relay's files in it (for the configuration, `config.json`, `install.json`, `mcp.json` and `install-backups/`) rather than the whole directory.
