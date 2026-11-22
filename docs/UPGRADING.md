# Upgrading relay

How to move an installed relay to a newer release, and back. The release notes below say, for
each release, whether its registry or config changed and anything to do on upgrade.

## How to upgrade

1. **Let relay's work finish**, or cancel what you do not need (`relay tree` shows a run;
   `relay cancel <id>`). Upgrading replaces relay's files under any relay process still running.
   Such a process goes on with the code it has loaded, but loads parts of relay only when it first
   needs them, and starts workers from the files on disk, so it can mix the old release with the
   new. Under a release's shipped Codex pin it refuses further Codex turns ("relay was changed on
   disk after this process started") until it is restarted.
2. **Install the new release.**
   - From npm: `npm install -g @jbkjr/relay@latest`.
   - From a checkout: pull, then `npm ci` and `npm run build`. A pull alone leaves the old build
     in `dist/` running; `relay doctor` reports the commit the build was made from and warns when
     the checkout has moved on.
3. **Run `relay install <host> --write` again for each host you use** (`claude`, `codex`,
   `claude-desktop`). It puts relay's plugin in again where the host's copy differs from this
   release's, updates relay's registration where its form changed, and migrates relay's registry
   if the release changed it, backing it up first (below). `relay install codex --write` also puts
   the new release's shipped Codex pin in place, unless a pin you qualified on this Mac with
   `relay qualify-codex` is current; until it has, relay refuses the old release's shipped pin,
   which names the old build ([Pinned Codex](pinned-codex.md)).
4. **Restart the hosts' sessions.** Each runs its own relay server. The Claude desktop app runs one
   for all its chats and for all its Cowork and Code tab sessions, and restarts it only when you
   quit and reopen the app.
5. **Check:** `relay --version` and `relay doctor`.

### Your config across versions

Every version validates `~/.config/relay/config.json` strictly and refuses a key or value it does
not know, so a setting only a newer version knows stops an older one from starting. Add a new
release's settings only after upgrading. If more than one relay reads the same config file (one
shared between machines, say), add them only once every one of those relays runs a version that
knows them. Release notes name each new key, and which earlier versions reject it.

## The registry

Relay keeps its runs, jobs, approval requests and events in one SQLite file, `relay.db`, in its
state directory (`RELAY_HOME`, by default `~/.local/state/relay`).

- The file carries a schema version (`PRAGMA user_version`). When a relay opens a registry with a
  lower version, it first writes a consistent copy next to it,
  `relay.db.backup-v<old version>-<time>-<pid>`, then migrates the file and records the new
  version. If the copy cannot be written, relay stops and leaves the file as it is.
- Any relay process that opens the registry does this on its first open: the MCP server a host
  session starts, workers, and commands such as `tree`, `chat`, `cancel`, `clean`, `approvals`,
  `approve` and `deny`. `relay install <host> --write` does it before it changes anything in the
  host, prints the backup's path and records it in `~/.config/relay/install.json`. `relay doctor`,
  `--version`, `help`, and `install` without `--write` do not open the registry (without `--write`,
  install only says that it would migrate it).
- A registry with a higher version than the running relay knows is refused, so an older relay
  never works on a schema it does not know.
- Retention (`keep_records_days`) never deletes a migration backup. A backup can hold prompts and
  results; delete it yourself once you will not go back to the version that wrote it.
- To look at the registry with `sqlite3`, open it as `sqlite3 "file:$HOME/.local/state/relay/relay.db?mode=rw"`,
  not by a bare path and not with `-readonly`. The file is in WAL mode, and macOS's own
  `/usr/bin/sqlite3` has failed a read-only open ("unable to open database file") on a registry no
  process had open. `mode=rw` opens only a file that exists, where a plain `sqlite3 <path>` would
  create an empty one. Do not use `?immutable=1`: it skips the write-ahead log and can show stale
  rows while relay is running. Write `$HOME`, not `~`, inside the quotes.

## Rollback

Going back to an earlier release means restoring the registry backup the upgrade made, not running
the earlier relay on the migrated file (it refuses a schema it does not know). When no release
after the one you go back to changed the registry (the release notes say), skip step 3.

1. **The config first.** Remove the settings the earlier release does not know (the release notes
   name them), or restore the file you had before upgrading.
2. **Stop relay.** Let work finish or cancel it, quit the sessions that use relay and the Claude
   desktop app, and make sure no relay process is left: `pgrep -fl 'dist/cli.js (mcp|worker)'`
   prints nothing. Keep the branches and worktrees of finished write jobs whose work you want.
3. **Restore the registry backup** the upgrade made: the path `relay install` printed and recorded
   in `~/.config/relay/install.json`, never a guess at the newest-looking file. Check it first:
   `sqlite3 "file:<backup>?mode=rw" 'PRAGMA user_version'` must print the earlier schema version.
   Then fold the migrated file's write-ahead log into it, and keep it, with whatever is left of
   its log, beside the restored one:

   ```sh
   cd ~/.local/state/relay
   sqlite3 "file:relay.db?mode=rw" 'PRAGMA wal_checkpoint(TRUNCATE)'   # prints 0|0|0; a first 1 means something still has it open: back to step 2
   ts=$(date +%Y%m%d%H%M%S)
   mv relay.db relay.db.migrated-$ts
   [ -e relay.db-wal ] && mv relay.db-wal relay.db.migrated-$ts-wal
   [ -e relay.db-shm ] && mv relay.db-shm relay.db.migrated-$ts-shm
   cp relay.db.backup-v<N>-<time>-<pid> relay.db
   sqlite3 "file:relay.db?mode=rw" 'PRAGMA user_version'              # the earlier schema version
   ```

4. **Install the earlier release**: `npm install -g @jbkjr/relay@<version>`, or in a checkout
   `git switch --detach v<version>` and then `npm ci && npm run build`. Run
   `relay install <host> --write` for each host, and restart the hosts' sessions. Where the
   earlier installer takes the newer release's registration for one you changed yourself, it says
   so and stops; `--force` replaces it, after saving it. `relay install codex --write` puts the
   earlier release's shipped Codex pin in place, as on an upgrade, unless a pin you qualified on
   this Mac is current.

What restoring loses: the registry's record of whatever ran under the newer release. Job branches
(`relay/<job>`) and worktrees stay in git and on disk. Uninstall does not restore the registry.

# Release notes

Newest first. Relay 1.1.4 and earlier came before the first public release; their notes are kept
because later notes and the reference docs point into them.

## Relay 1.3.1

A fix release. No config or registry migration is needed (the registry stays at schema 5), and Codex
pins in your store keep working.

- **A sandbox check that stalls no longer hides an escape.** Before a confined launch, relay runs a
  canary inside the sandbox that tries what the sandbox must refuse. On a heavily loaded Mac one of
  its steps could hang until relay's 30-second limit, and the launch was then refused as "canary"
  with no results, so a step that did get through went unnamed. The canary now reports at its own
  20-second deadline: a step still running then counts as "timeout", which is never taken as a
  refusal, and every other step's result is kept. When one step escaped, the refusal names that step
  first. A stalled step still refuses the launch, as before.

## Relay 1.3.0

Rooms: a new `room` tool and `relay room` commands that let two conversations you already have
open, a Claude Code session and a Codex session say, exchange messages until they agree or state
a crux ([Rooms](usage.md#rooms)). No config key or host registration changes. **The registry moves
from schema 4 to schema 5, and schema 5 needs every relay server stopped before the upgrade and
restarted afterwards**, whether or not you use rooms (below). What changes:

- **Rooms.** Create one in your own terminal with `relay room new`, which prints one invitation
  prompt per conversation and, on macOS, offers each on the clipboard in turn; paste each into the
  conversation you mean. In interactive Claude Code in a terminal and the Codex CLI, a conversation
  can instead ask you to open a room, in that host's own dialog; on your yes it takes the first
  seat, and the second seat's prompt goes to your clipboard, never to the model. On those hosts a
  join asks you first too. A room carries information only, at most 24 messages, for at most 24
  hours. Relay launches nobody, and each conversation keeps its own runs and permissions.
- **`relay room`** lists rooms (`list`), prints a transcript (`<id> --print`), follows one and adds
  terminal lines (`<id>`, `--say`), and re-seats or closes one (`--reseat member-1|member-2`,
  `--close`). Writes need your own interactive terminal.
- **An approval change for conversations that have read room text** (below).
- **`relay clean` and daily housekeeping** also expire rooms, and delete an ended room's transcript
  `keep_records_days` after it ended (never, when the setting is unset).
- **`relay doctor`** has a "rooms" line saying how seats survive restarts and where a conversation
  can open a room.
- **A question relay is putting to you stays yours while `ps` briefly fails.** When the machine
  refused to start `ps` (under heavy load, say), relay took the server asking the question for gone:
  a waiting call could then hand the agent a request you were being asked about, without
  `user_is_being_asked`, and another relay server could ask you the same question again. Relay now
  counts the asker gone only when it can show that it is.

### Upgrading to 1.3.0: stop every relay server first

Schema 5 adds six tables (`rooms`, `room_members`, `room_bindings`, `room_invites`,
`room_messages` and `room_exposures`) and keeps every existing row. As with any migration, relay
backs the registry up first ([The registry](#the-registry)). An older relay refuses a schema-5
file when it opens it, but a relay server that is already running keeps its open connection
without checking the version again, so it cannot be relied on to refuse. So:

1. **Stop all of relay.** Let work finish or cancel it, keeping the branches and worktrees of
   finished write jobs you want. Quit every session that uses relay, and the Claude desktop app
   (both of its shared relay processes), and make sure no relay process is left:
   `pgrep -fl 'dist/cli.js (mcp|worker)'` prints nothing. Do this before the new release's
   installer, or any command of the new release, opens the registry.
2. **Install 1.3.0 and run `relay install <host> --write`** for each host you use, as in
   [How to upgrade](#how-to-upgrade). The first one migrates the registry, backing it up as
   `relay.db.backup-v4-<time>-<pid>`, and prints and records the backup's path; keep it until you
   are sure you will not go back. `sqlite3 "file:$HOME/.local/state/relay/relay.db?mode=rw" 'PRAGMA user_version'`
   then prints 5. A new registry needs no backup.
3. **Restart every session**, and reopen the desktop app, so that every relay server runs 1.3.0.

A room seat held by a Codex or Claude Code session belongs to that session's relay server: when
the server restarts, the seat is lost, and `relay room <id> --reseat member-1` (or `member-2`)
prints a replacement prompt. A seat held by a desktop chat or Cowork session continues with its
session token, in the same relay home.

### The approval change

Once a conversation's relay owner has received room text from the other member or from a
terminal, relay records that (as a hash of the owner, kept after the transcript is deleted), and
`user_confirmed: true` on that owner's `approve` then counts for nothing: it no longer allows a
request you are being asked about (`asking`) or one whose question you closed (`dismissed`), and no
longer earns the audit label of a confirmation the agent claimed. Answer those requests yourself,
through relay's dialog, `confirm` or `relay approve` in a terminal. Everything else `approve` could
do stays: the root's own judgments where they were allowed, denials and grants; person-only
requests keep their existing restrictions. This is not a ban on approvals or grants in a
conversation that has been in a room, it does not make terminal text your consent, and it does not
follow text copied to another conversation.

### Rollback from 1.3.0

Follow [Rollback](#rollback), stopping every relay server as for the upgrade, and also close any
`relay room <id>` you are following in a terminal, which holds the registry open as well:
`pgrep -fl 'dist/cli.js (mcp|worker|room)'` must print nothing. Then restore the schema-4 backup the
upgrade made (`PRAGMA user_version` on it prints 4). Rooms and their transcripts, like everything
else recorded after the backup, are lost from the registry.

## Relay 1.2.2

A fix release. No config or registry migration is needed, and Codex pins in your store keep working.

- **`relay doctor`'s "codex login" line goes by the account Codex reports**, the check each Codex
  turn makes (`account/read`), not only by `codex login status`, which finds a stored login whether
  or not Codex still accepts it. A login stored in relay's Codex home that Codex no longer accepts
  (most likely one that expired and could not be refreshed) now fails the line, where before the
  line said "Logged in" while every Codex job was refused. Under the default `child_auth`, an API-key
  login there fails the line too, as it already failed each turn. Doctor asks the app server it
  already starts for the "codex launch" line, so it starts nothing more.
- **A Codex turn refused for its login says how to sign in again**: the `codex login` command for
  relay's Codex home and pin, with `--device-auth` for a remote or headless Mac (which needs device
  code sign-in switched on in ChatGPT's Security settings). When a login is stored but Codex no
  longer accepts it, the refusal says so, rather than only "not signed in".

## Relay 1.2.1

The first public release (1.2.0 was tagged in the pre-publication repository and never published,
so its notes are folded in here): relay is published to npm as `@jbkjr/relay`, and a release can ship a
Codex pin the maintainer qualified, so Codex works without an hour-and-a-half qualification on your
Mac. No config or registry migration is needed (the registry schema and the config file are as in
1.1.4). Codex pins already in your store keep working, whichever relay commit or build they record.
What changes:

- **Install from npm** (`npm install -g @jbkjr/relay`), then `relay install codex --write`, which
  now also makes relay's Codex home for the one-time `codex login` there (below). From a checkout
  nothing changes, except that `relay qualify-codex` replaces running the qualifier script by hand.
- **`relay doctor`** reports the build and Codex's setup as relay's jobs see them (below).
- **Fixes** to events, turn authority and the sandbox-denial stream (below), and Claude Code 2.1.326
  verified.
- **Node 24.15 or newer** is required (below).
- **The never floor's built-in ports are macOS's own services only**, and a `never.ports` entry of
  yours for this Mac works with Codex's strict network (below).

### `relay doctor`: the build on an npm install, and Codex as relay's jobs see it

- **build.** On an npm install, which has no checkout, the line names the build by relay's build
  identity, the version and hash a shipped Codex pin names: `an npm install of @jbkjr/relay (no git
  checkout): relay 1.2.1, build 0123456789abcdef; built from <commit> on <date>`. Before, it said
  relay could not read the checkout's HEAD. A checkout is reported as before.
- **codex launch** and **codex env** come from the checks a Codex turn makes before it starts: a
  short-lived Codex app server reports its effective configuration for a job started in the current
  directory, every layer merged (system, managed, the directory's project layers and relay's Codex
  home), and relay judges it as the turn does, for the configured default job (default model and
  speed, relay's tools, no grants), read and write. Before, these lines judged the `config.toml` in
  relay's Codex home, which relay rewrites on every turn, and saw no other layer. When that file
  holds changes of yours, doctor says that they never apply to a job. Doctor now starts two Codex app
  servers to ask (no thread, no model request), so it takes a few seconds longer. Run inside an
  agent whose sandbox keeps it from relay's Codex home, it says the check could not be made there.
- **codex login** asks `codex login status` of relay's Codex home, where relay's Codex jobs sign in,
  not of `~/.codex`. A missing or signed-out home of relay's is a requirement not met, with the
  command that signs it in.
- **your codex** is new: your own `~/.codex` is for your own Codex sessions, and relay's jobs read
  none of it (its `config.toml`, rules, skills, `AGENTS.md` and login).
- **relay on PATH**: npm's global `relay` command for this install counts as this relay, so a
  correct npm install no longer warns there.
- Registration lines say "from this npm install" on an npm install.

### `relay install codex --write` makes relay's Codex home

Codex refuses a `CODEX_HOME` that does not exist, so on a fresh install, where nothing had made
relay's Codex home yet, the one-time `CODEX_HOME=… codex login` failed. `relay install codex --write` now
makes it (a private directory with the `config.toml` relay writes there on every turn, so the login
goes to the file store relay's turns read) and prints the sign-in command. A dry run says it would.

### Fixes

- **Events.** A discussion reply followed at once by the borrowed session's own queued turn is
  announced; before, only the session's completion was.
- **Turn authority.** A turn's authority ends when its agent exits, not after relay's bookkeeping
  (process-group checks, writing the final message), so nothing left of the agent can start, steer
  or file requests for the turn in between.
- **Sandbox-denial stream.** Closing it signals its process group only while relay's child still
  leads it, so a reused group id (another agent's, say) is never signalled.
- **Claude Code 2.1.326** is verified for the temp link and for `cc-plugin-privacy`, which relay
  now checks by a digest per verified version.
- **Dependencies:** `@hono/node-server` 2.1.8 and `hono` 4.13.18, both through the lock.

### Node 24.15 or newer

Relay needs Node 24.15 or newer (before: 22.18). `node:sqlite`, which relay's registry uses, printed
an `ExperimentalWarning` on every command under Node 22 and earlier Node 24 releases; 24.15 is the
first without it. Install a Node 24 LTS (or a later release) before upgrading relay: the launcher
`bin/relay` passes over an older Node, and `relay doctor` fails the `node` line on one.

### The never floor: built-in ports and yours

- **Built-in ports.** `service.sshd` (22) and `service.screen-sharing` (5900) are the only built-in
  never ports, and stage 2's static deny is macOS's own services (22, 5900, 3283, 3031, 445, 548,
  631). Two built-ins that named services of one particular Mac, a mail bridge's ports (1025, 1143)
  and an MCP gateway's (8787, 11143), are gone. If you run such a service, add its ports under
  `never.ports` with `"destinations": "this-machine"`. A run started before the upgrade keeps
  them in its floor until it ends. An `override_builtin` entry naming one of the two is still
  accepted and removes nothing; relay warns about it.
- **Your this-Mac ports and native Codex.** A `never.ports` entry of yours with
  `"destinations": "this-machine"` no longer refuses a Codex turn with strict shell network (a
  network grant or `child_network`, stage 2 off): strict reaches none of this Mac's addresses, so it
  enforces the entry as it does the built-ins. Local mode (`grant.local_network`) and
  `allow_dangerous` write turns, which reach this Mac's addresses, still refuse any `never.ports`
  entry of yours, now a UDP-only one too. `relay doctor`'s "never Codex" line says which.
- The raw-network consent text now names your `never.ports` among the denied ports, so a job holding
  a raw-network consent is asked again.

### The package is @jbkjr/relay, with a dependency lock in its build identity

- **Name.** The package is named `@jbkjr/relay`, its npm name. The command is still `relay`.
  `relay install` still recognises a `~/.local/bin/relay` link into a checkout whose package.json
  says `relay`, so an older checkout's link is replaced, not reported as someone else's.
- **Dependency lock.** `package-lock.json` is now `npm-shrinkwrap.json`, which npm also honours when
  it installs relay from the registry: relay's dependencies are installed at the versions it names,
  checked against their integrities. Run `npm ci` as before.
- **Build identity `relay-build-v2`.** The identity a Codex pin records now covers that lock, so a
  shipped pin also fixes relay's dependencies ([pinned-codex.md](pinned-codex.md#relays-build-identity)).
  Existing local pins keep working, whichever identity or commit they record. A failure recorded
  under `relay-build-v1` no longer matches, so those inputs are qualified again, and a shipped pin
  naming `relay-build-v1` is refused.
- **Exact dependencies.** `package.json` names relay's direct dependencies at exactly their locked
  versions. The qualifier refuses to run, and relay refuses to run Codex under a shipped pin, when
  any dependency relay would load, transitive ones included, is not the version the lock names.
- **The sandbox_check helper** is linked under a fixed name, so two builds of the same sources give
  the same `dist/native/relay-sbcheck`.

### Claude consent: ordinary skill and command frontmatter no longer withholds

Relay's frontmatter check, used for skills, legacy commands and
agents (plugin and personal), withheld the approval dialog and `confirm` for ordinary YAML. Among
these were permissions such as `allowed-tools: Bash(git add:*)` (it took the `:*` for an alias),
flow lists such as `tools: ["Read", "Grep"]` and `argument-hint: [project-name]`, and values on
the line after their key. On a machine with the claude-plugins-official marketplace this was about
25 of the reasons.

- The check now follows how Claude Code reads a definition's frontmatter: up to the first `---`
  anywhere, Bun's YAML parser, then one retry with column-0 `key: value` values quoted, and
  hooks from the top-level `hooks` key. A top-level key starts at column 0 in each of those, so
  relay withholds when `hooks` followed by `:` appears anywhere in the block, or when a line at
  column 0 is anything but a comment, a `- ` entry, or a plain `key:` entry. It also withholds when
  such a line continues a quoted value or flow list opened earlier.
- Still withheld, as margin: flow mappings, anchors, aliases, tags, directives, quoted and
  explicit keys, duplicate top-level keys, nested flow lists, and comments or pairs inside a flow
  list. Lookalikes such as `hooks:` inside a quoted or folded description still withhold too.
- A hooks file that loads a hooks module (`"modules"` in `hooks/hooks.json`, as the
  code-modernization and theme-examples plugins do) still withholds. The reason now says so
  instead of "could not read".

### Claude consent: marketplaces that declare only skills keep the approval dialog

A plugin marketplace entry that declares `skills` no longer
withholds the approval dialog and `confirm` by itself. Before, any marketplace manifest entry
that declared hooks, skills, agents or commands withheld both, so the `anthropic-agent-skills`
marketplace (anthropics/skills) turned dialogs off on any machine that had it added.

- For an entry that declares only skills, relay finds every copy of that plugin on disk: under the
  marketplace for a relative `source` (also under `metadata.pluginRoot`), each cached version
  (`plugins/cache/<marketplace>/<plugin>/<version>`), and each recorded install path. It reads
  the leading frontmatter of every `SKILL.md` under each declared path, with the same
  conservative check as other skills: any `hooks` key, or frontmatter it cannot read or rule out,
  withholds both. So does a declared path or `source` outside the plugin or marketplace (`..`), a
  link that leads out of the plugin directory (even between plugins of one marketplace, which
  Claude Code itself allows), a zipped cached copy, a plugin name relay cannot place in the cache,
  and an entry it cannot read.
- A remote plugin (a `github`, `url` or `git-subdir` source) that was never installed has no copy
  on disk and adds nothing. Once installed, its cached copy is checked.
- Every cached version (`plugins/cache/<marketplace>/<plugin>/<version>`) now counts as a plugin
  root even when it has no `plugin.json`. Its default `skills/`, `agents/`, `commands/` and
  `hooks/hooks.json` are read like an installed plugin's. Before, relay read them only for a copy
  with a manifest or a recorded install path. A running session can still have an older version
  loaded.
- Entries that declare `hooks`, `agents` or `commands` withhold as before.
- New: `CLAUDE_CODE_PLUGIN_CACHE_DIR` and `CLAUDE_CODE_PLUGIN_SEED_DIR` in relay's environment
  withhold both. They move plugins outside the directories relay scans.

Other checks can still withhold on your machine. `relay doctor` (the `claude consent` line) gives
the first reason that applies. Restart relay's MCP servers to apply the change.

### Codex 0.170.0: seven new default-on features pinned off; a new tool and an isolate helper admitted

Codex 0.170.0 turns on by default seven features that 0.167.2 lists off or not at all:
`code_mode_host_grpc`, `code_mode_host_output_truncation`, `guardian_include_additional_context`,
`incremental_tools_legacy`, `retain_client_tool_outputs`, `unified_image_budget` and
`untrusted_as_tool_output`. The stage-2 readback refused every turn on them as unqualified
features. None adds a tool or host action, and relay now pins each off on 0.170.0 and later,
keeping 0.167.2's behaviour. It does not require them of older versions. 0.170.0's model catalog
also offers `send_message_to_user_async`, which only posts a message to the thread, so relay now
admits it. Code mode's JavaScript gains a `content` helper, a sibling of `text`/`image`/`audio`,
which is admitted too. The reasons, file by file, are in the
[qualification](qualification/codex-0.170.0.md). No config or registry migration is needed. A
Codex pin you qualified on your Mac moves to 0.170.0 only when the qualifier qualifies it with this
release.

### Codex 0.167.2: `incremental_tools_legacy_gcp` pinned off

Codex 0.167.2 adds the feature `incremental_tools_legacy_gcp`, stable and on by default, and the
stage-2 readback refused every turn on it as an unqualified feature. Relay now pins it
off on 0.167.2 and later, as it does `deferred_tool_world_state`, and does not require it of
0.167.1 or earlier, which do not list it (the maintainer, 2026-11-16). Codex reads it only when the model
provider is `gcp` (`core/src/session/step_context.rs`), so relay's OpenAI-provider turns are
unchanged. No config or registry migration is needed. Relay's Codex pin stays 0.167.0; 0.167.2's
route was checked by relay's release checks ([qualification](qualification/codex-0.167.2.md)).

### `relay qualify-codex`, and a qualifier LaunchAgent for any user

**`relay qualify-codex [--version X.Y.Z] [--force]`** runs the Codex qualifier once, from a git
checkout or an npm install, into `targets.codex.pin_store`. It has the same checks as the optional
qualifier LaunchAgent, which calls the same code. Without a pin, `relay doctor` and every refused
Codex job now name it. The command refuses inside a launched agent and outside a complete relay
build, and the pin it writes names relay's build identity
([pinned-codex.md](pinned-codex.md#relays-build-identity)). It ends by asking relay which Codex it
would run, and exits 0 only for a qualified pin. Details: [pinned-codex.md](pinned-codex.md).

The LaunchAgent's installer (`scripts/codex-qualify/install-codex-qualifier.mjs`) works for any
user. Its label is `local.<login name>.relay-codex-qualifier` unless `--label` sets another, and
the plist is written as `~/Library/LaunchAgents/<label>.plist` from the template
`scripts/codex-qualify/relay-codex-qualifier.plist`.

### A release ships a Codex pin

A release packed for npm
can carry `codex-pin.json`: the maintainer's qualification of one Codex release (version and npm
integrity) with exactly that relay build. `relay install codex --write` downloads that Codex,
verifies it against the pin and makes it current under `shipped/` in the pin store, so Codex works
without a local qualification. Relay runs a shipped tree only while the running build is the one
the pin names. A pin you qualified yourself stays in force over a shipped one; `relay qualify-codex
--shipped` switches to the shipped one. `relay doctor` reports which is in force. **Nothing changes
for a git checkout**, which ships no pin: `relay qualify-codex` as before. Existing local pins are
unchanged. [pinned-codex.md](pinned-codex.md#a-releases-shipped-pin) has the format, the precedence
rule and the maintainer's steps.

### Codex pins name relay's build, and `relay qualify-codex` runs from an npm install

A new pin records
`relayBuild`, relay's version and a SHA-256 of its installed build (`dist/`, the qualifier and the
files its stage-2 run loads), instead of `relayCommit`. `relay qualify-codex` no longer needs a git
checkout or refuses one with local changes; it refuses an incomplete build instead, before anything
runs, and runs stage 2 from a verified copy of the build in its scratch directory.
`package.json` now has a `files` list that ships that build, and `npm pack` refuses to run without
`dist/` (`scripts/check-pack.mjs`). **Pins already in the store keep working**, as before: a local
pin is not bound to the relay that runs it. Failed-qualification records keyed by a relay commit
no longer match, so a release that failed before is qualified again on its next run.
[pinned-codex.md](pinned-codex.md#relays-build-identity) has the scheme.

## Relay 1.1.4

No config or registry migration is needed. Codex pins already qualified under `stage2-v3` stay
valid; the qualifier stores new ones under `stage2-v4` (item 33, below). What changes:

- **Claude jobs get the never floor whether or not stage 2 is on.** In 1.1.3 a Claude job got it
  only with stage 2 on. Now its settings always carry it: sandbox `denyRead`/`denyWrite` and
  Read/Edit deny rules for `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, the CLIs' login files
  (`~/.config/gh/hosts.yml`, `~/.config/gcloud`, Codex's, Claude's, Gemini's, Copilot's, Grok's),
  relay's key directory, the keychain files and your `never.paths`, and `allowUnsandboxedCommands:
  false`. These bind Claude's sandboxed commands and file tools, not the Claude Code process
  (relay starts it unwrapped), which signs in as before. What a Claude job can no longer do:
  - use `gh` with a token in `hosts.yml` or the keychain, git over SSH or with git's osxkeychain
    credentials, GPG signing, `~/.netrc`, or the AWS or gcloud CLIs from its shell. Claude Code's
    sandbox lets commands reach the security daemons (keychain IPC), but reading an item in a
    file-based keychain, such as the login keychain, also needs its keychain file, which the floor
    denies (measured 2026-11-04; checked each release by `claude-floor`). So there is no need to
    move gh's token out of the keychain (`gh auth login --insecure-storage`) for the floor. What the
    daemons serve without a keychain file, such as data-protection keychain items, is not covered,
    nor is a copy of a keychain file kept outside the denied directories;
  - run a command outside its sandbox: Claude's own unsandboxed retry is off, and relay refuses
    every command approval for a Claude job, one that would stay in its sandbox as well
    (`never: Claude command approvals are unavailable under the never floor …`);
  - run at all under `child_settings: "inherit"`, `child_hooks: true` or `child_mcp: "inherit"`
    (global settings: they refuse every Claude job), or on a machine with organisation-managed
    Claude Code settings on disk, even with `claude_managed_settings: "accept"`;
  - run a write job under `allow_dangerous`;
  - use WebSearch or WebFetch while any `never.hosts` entry is set.

  `relay doctor`'s "never enforced" block now shows Claude as enforced in both stage-2 states, and
  doctor warns (`claude launch`) when the config or the machine would refuse Claude jobs. Its
  per-agent text comes from the same predicate as the launches (`core/never-coverage.ts`); the
  1.1.3 `neverPathEnforcement` text is gone. The escape hatch is `never.override_builtin` (e.g.
  `{ "id": "credentials.files", "acknowledge": "REMOVE BUILT-IN NEVER credentials.files",
  "reason": "…" }`): it removes that built-in group for new runs of every agent, Codex too, not for
  Claude alone; it lifts denies, not the refusals above, and cannot remove `relay.config`,
  `relay.install` or `relay.authority`. Runs started earlier keep their recorded floor, and their
  Claude jobs take it from their next turn under the new relay.
- **Doctor's "never enforced" block lists keychain IPC separately from the path entries.** The
  floor's keychain-file denies do not cover the security daemons. Only relay's own Seatbelt denies
  those; Claude Code's sandbox leaves them open on every turn, and Codex's native sandbox opens
  them on a turn with shell network while stage 2 is off (`core/never-coverage.ts`
  `neverKeychainIpc`). The file denies still keep items in file-based keychains unreadable, since
  reading one needs its keychain file as well as the daemons (measured 2026-11-04; checked each
  release by a floored decoy keychain and its control without the file deny). What the daemons
  serve without a keychain file, such as data-protection keychain items, is not covered, nor is a
  copy of a keychain file kept outside the denied directories. 1.1.3's doctor line and docs said the floor's "keychain and port rules"
  followed the path entries, which overstated it for Codex network-on turns and for Claude under
  stage 2. The floor's port rules, likewise, reach only relay's own Seatbelt; elsewhere relay's
  proxy and native Codex admission screen ports.
- **Claude agents are no longer told to retry a command with the sandbox disabled.** Their prompt
  says a blocked command cannot be approved out of the sandbox: use the file tools (write jobs) or
  WebSearch/WebFetch, which ask, report what was blocked, or ask for a network grant on a later turn.
- **Required release checks for this change** (all passed 2026-11-04 at `d690592`, with the full
  gate chain and the red team):
  - release check `claude-floor` (`RELEASE_CHECK_CASES` in
    `scripts/codex-qualify/stage2-escalation-cases.mjs`; run with the release gates and the red
    team, never by the Codex pin qualifier): part `nativeStage2Off`, item 29's installed-Claude case
    with stage 2 off, and part `keychainDecoy`, the decoy keychain from two Claude turns with stage
    2 off (`RELAY_TEST_KEYCHAIN_LIVE=1`): refused with its directory in `never.paths`, and in the
    control without that entry, retrieved, as doctor's "keychain IPC open" says;
  - qualification item 33, the decoy keychain from native Codex turns with network off and on:
    refused on every floored turn, and each control without the file deny matching doctor's
    keychain IPC (refused with network off, retrieved with network on). It is a Codex pin
    requirement (verdict schema `stage2-v4`): a new Codex version can change its seatbelt policy.
    Pins stored under `stage2-v3` stay valid;
  - one signed-in `claude-live.mjs turn` under the keychain login with stage 2 off (the local
    release checks, whose scratch config leaves `child_auth` at "login"), to show Claude still signs in with the floor's keychain-file denies in place.

  Rerun 2026-11-08 on the merge with main (`f67f622`), Codex pin 0.167.0 by hash, macOS 27.2: all
  passed in the same shape. What 1.1.4 adds after `f67f622` (below) changes no confinement code.
- **Codex 0.167.0:** its new `deferred_tool_world_state` feature is pinned off with the other
  stage-2 features (model-visible deferred tool namespaces, no host action). Relay's release checks
  verified Codex 0.167.0's route and Gemini CLI 0.67.0's tool discovery (informational records).
- **Qualifier fixes** (the pinned-Codex qualifier, not relay itself): its launchd job runs at
  Standard priority, not Background (background QoS stalled `ps` for 5–30 s on a busy Mac and
  failed runs); the process inventory waits up to 30 s and logs one over 5 s; a failed cleanup no
  longer hides the error that started it; and a group kill macOS answers with EPERM counts as done
  when only zombies are left in the group. Reinstall its LaunchAgent (`ProcessType Standard`).
- **Claude Code 2.1.325 runs again.** It (and 2.1.321 on) bundles `cc-plugin-privacy`, which relay
  did not disable, so every Claude turn was refused ("plugins bundled with this Claude Code version
  that relay does not yet disable"). Relay now disables it and `claude-platform` (2.1.325's name for
  2.1.321's `cc-plugin-claude-platform`), and relay's release checks read the built-in registry, not
  only `cc-plugin-` strings, so an unprefixed built-in is seen. Disabling `cc-plugin-privacy` means a
  launched Claude agent no longer gets Claude Code's check against sending the signed-in account's
  email as a client's identity.
- **Launched Claude agents keep `cc-plugin-privacy` on** (the maintainer, 2026-11-16), so they keep Claude
  Code's refusal of a call that puts the signed-in account's email into a client's identity (a
  User-Agent, a `From:` header, git's `user.email`, an SEC EDGAR identity), as an interactive
  session has. Relay's isolation still fails closed for everything else: the plugin is admitted only
  on a Claude Code version in `VERIFIED.claudePrivacyPlugin`, now <!-- verified:claudePrivacyPlugin -->2.1.325 and 2.1.326<!-- /verified -->,
  whose copy relay read (a deny-only `tool.check` hook with the `fs.list`, `fs.read` and
  `session.identity` calls; from 2.1.326 also a `session.identity` hook that only refuses or
  withholds the identity it is asked for), and only when the init report lists it as
  exactly that built-in, with no skill, command, agent, MCP server or tool of its own. On any other
  version, or one whose `--version` relay cannot read, relay disables it as before, and an init
  report that lists it anyway refuses the turn. `claude-platform` and every other built-in stay
  disabled. Relay's release checks compare the plugin's code in each new release whole, canonicalized and
  hashed (`PRIVACY_PLUGIN_DIGESTS`, one per version a person read), and adds the version to the list only when it is one of those; any
  change, or anything it cannot read, is reported with a diff for review and the plugin stays off there. Nothing to do on upgrade.

## Relay 1.1.3

No config or registry migration is needed. What changes:

- **`relay doctor` says which agents the never floor's path entries bind** (new "never enforced"
  line). Codex's sandbox takes `never.paths` and the built-in entries on every sandboxed turn;
  Claude's, Copilot's, Gemini's and Grok's profiles take them only with stage 2 on, which then
  refuses Copilot and Grok. With stage 2 off, the default, those four agents are not held to the
  path entries. This is disclosure only, the maintainer's decision for 1.1.3 (Nov 4, 2026); enforcement is
  unchanged. `relay doctor`'s "never enforced" line shows which agents enforce what.
- **Qualification fixes** (the qualifier and red team, not relay itself):
  - checks that could pass without evidence now fail closed: item 6 (the token check and the
    app-server half count only when their command ran and the app server was read), item 13 (the
    older Codex's part needs its command to have run), the Codex live lane's Daybreak cases (no
    thread, or a rollout with no turn, is "not run"), and the red team's tick, process-table and
    nc probes;
  - item 12's negatives count only plugin discovery at the run's fake service, so Codex 0.166.0's
    account-check, settings and analytics calls with plugins off no longer fail it; a discovery
    request still does;
  - item 27's listen case binds a port below the ephemeral range, so an outgoing connection can no
    longer take it first (`EADDRINUSE`);
  - the suite's real-Codex sandbox tests take `RELAY_TEST_CODEX`, which gates set to the pinned
    Codex, and fail rather than skip under `RELAY_REQUIRE_REAL_CODEX=1`.
- **For contributors:** the test harness writes an owner file (`<dir>.owner`, the pid) beside each
  `/Users/Shared/relay-*` scratch tree and, at start-up, removes the trees of this user's whose
  owner process is gone (a killed run skips its exit cleanup). Trees without an owner file, from
  before 1.1.3, are left for you to remove; `RELAY_TEST_KEEP_SCRATCH=1` turns the sweep off.
- **Diagnostics:** when an app server's stop cannot be confirmed, the job's error now says the
  executor stays quarantined until you clear it (below), instead of "until a later sweep does".

- **An app server relay cannot confirm stopped keeps its executor quarantined, as a refused stop
  does.** When a job's worker has died and reap kills its orphaned Codex app server, but the
  group is still there a second after SIGKILL, or a cancel's process group does not exit (and was
  not refused), the stage-2 executor is still stopped and swept, but its record stays in
  `<relay home>/executors/` (`~/.local/state/relay/executors/` by default), tainted
  `untraceable app-server cleanup: …`. No later sweep, however clean, lets it go: the app server
  may still be running and could reconnect to the executor's port. Before, a clean sweep released
  the record.
- **While the record is there, its ports stay leased and local mode is refused.** The record
  keeps its ports in relay's reserved range, so no other turn is given them, and the local-mode
  interlock refuses `grant.local_network` (`executor <record> of <job> state tainted; reap/cancel
  and verify cleanup before local launch`). The job's error, or the cancel's warning, names the
  process group that may still be running.
- **Clearing it is the person's, after checking cleanup.** Relay never clears this quarantine by
  itself. Seeing that the group named is gone is not enough: a detached descendant (one that
  called setsid, or a double fork) has left that group and still runs. Check that nothing of the
  turn is left, including such processes: the app server and whatever it started, and the
  executor's pid, group and the `descendants` its record lists. Look for any process whose
  arguments or environment name the record's `tmpDir` or the job's worktree, for example with
  `ps -E -axww`. Stop anything you find. Then remove the record file from
  `<relay home>/executors/`. Its ports are free again once no process its leases name is running
  (`<relay home>/ports/`), and the interlock no longer refuses on that record.

  That clears only the record. Two other things can still make the interlock refuse local mode,
  and relay has no supported way to clear either yet:
  - **A launch reservation.** A stage-2 turn's reservation (raw network, or an overlay's turn)
    comes out clean only when reap finds the turn's executor record and the worker recorded the
    app server's cleanup as clean. Once the record is removed, it can never come out clean, so it
    stays, tainted, and refuses local mode (`launch reservation <turn> of <job> tainted reserves
    stage2; …`).
  - **The job's agent group, for a job with no reservation.** Relay keeps the group it could not
    confirm stopped on the job's record. The interlock refuses local mode while a write turn with
    raw network has an agent group on record (`… terminal turn retains agent group`). Cancel and
    the lost-worker reap act only on active jobs, so neither looks at that group again.

## Relay 1.1.2

No config or registry migration is needed. What changes:

- **A tool call can no longer hang on a broken broker request.** When relay's broker cannot
  serve an MCP request, the call now fails instead of staying pending until Codex's tool timeout
  (an MCP `status` call could hang this way). Error replies keep the request's id where it is
  known instead of answering with `id: null`, broken SSE responses end cleanly instead of getting
  a raw HTTP status line, the server's header timeout is on, and client errors are logged with
  their code.
- **The stage-2 network probe retries port-0 listens past denied ports**, up to
  max(5, longest run of denied ports + 2) times, with diagnostics if it still fails.
- **Qualification item 12 has a positive control for discovery prefetch.** New pin receipts use
  the `stage2-v3` schema (v2 plus item 12's `prefetch` part). Existing 1.1.0 and 1.1.1 pins keep
  validating against the schema they were qualified under; nothing needs to be requalified.
- **The qualifier skips a Codex version that already failed** at the same binary and Relay
  commit; `--force` retries it. See [Pinned Codex](pinned-codex.md).
- **A replaced installation refuses only for the sealed Codex pin store.** If a package-manager
  upgrade replaces something in relay's pinned Codex store during a run, that run refuses to
  launch until a fresh one starts: restart relay's MCP server (per-session connection) or use a
  new session (shared server). Updates to other CLIs, Node or git are taken up at the next
  checkpoint, as before.
- **Agent cleanup is sturdier.** The Codex app server, ACP and stream backends take their last
  process snapshot before every stop signal. If a group cleanup is refused, the turn still
  settles: its pipes and pending requests are closed, the refusal is reported as a warning, and a
  stage-2 executor stays quarantined with its record and ports rather than being signalled or
  swept.
- **For contributors:** three load-sensitive tests now wait on state rather than on fixed
  timings.

## Relay 1.1.1

No config or registry migration is needed. What changes:

- **Launches re-check this Mac's addresses.** Relay takes a fresh never-floor checkpoint
  immediately before Codex's `turn/start`, the exec spawn and ACP's `session/prompt`. If the
  floor has gained a routable address since the launch plan was built, the turn is refused
  with nothing started; send it again. Rotating link-local addresses still pass.
- **Relay never signals its own process group or a parent's.** Every group signal goes through
  one guard, which refuses such a group (unless its recorded leader is verified fresh) and
  reports the refusal; cleanup derived from a refused group is skipped. If an orphaned app
  server's stop is refused, its executor stays quarantined: it is not cleaned up, its lease is
  not released, and the quarantine reason is kept.
- **Pin receipts are versioned.** Verdicts and new pin manifests record the schema they were
  qualified under (`stage2-v1`, `stage2-v2`), and new manifests seal the verdict's SHA-256.
  Existing 1.1.0 pins keep validating against the `stage2-v1` baseline; nothing needs to be
  requalified.
- **Codex 0.166.0 can be admitted.** From 0.166.0, relay pins `plugin_discovery_prefetch` and
  `prediction_preserve_parent_tools` off and allows `reasoning_effort_override`; qualification
  item 10 gains an effort check. 0.164.0 stays the pin until the qualifier qualifies 0.166.0.
- **Codex 0.167.0 is no longer refused for `deferred_tool_world_state`.** 0.167.0 turns this
  feature on by default (it describes deferred tool namespaces to the model), and the stage-2
  readback refused every turn because relay had not qualified it on. Relay now pins it off on
  every version, as 0.164.0 and 0.166.0 already ship it. 0.167.0 still needs the qualifier.
- **The qualifier needs a rebuilt checkout.** Its process supervisor now imports the checkout's
  `dist/core/procs.js`; after updating the qualifier's dedicated checkout, rebuild it before
  resuming its schedule. See [Pinned Codex](pinned-codex.md).
- **For contributors:** `npm test` runs eight test files at a time, and
  `RELAY_TEST_ESCALATION_LONG=readback` gives qualification item 30 a readback-only mode for
  release gates (the hour-long call is recorded as not run, so it can never promote a pin).

## Relay 1.1.0

### Before you upgrade: Relay's Codex runs on a pinned copy

Relay's Codex jobs now run on Relay's own qualified copy of Codex, with stage 2 on or off.
Your interactive Codex keeps updating by itself and is not used. `targets.codex.pinned`
defaults to `true`, so **until a qualified copy exists on this Mac, every Relay Codex job
refuses**, including reviews, with `relay refuses Codex: no valid qualified pin`. There is no
fallback to interactive Codex.

Before installing this version on a Mac that runs Codex jobs, follow
[Pinned Codex](pinned-codex.md): qualify a Codex from a logged-in terminal, and log in once to
Relay's own Codex home (`~/.local/share/relay-codex-home`). (A release's shipped pin, from a later
release on, replaces the first step.) `targets.codex.pinned: false` is the
explicit opt-out, and selects `targets.codex.bin`.

Stage 2 itself stays off unless `targets.codex.stage2` is set.

### Escalation qualification gates (WP6)

Stage-2 qualification now requires items **1–32**, including the restart/authority,
deadline/floor, overlay-profile, mediated and adapter tests. Historical 22-item
verdicts do not qualify this enlarged gate. Known missing integrated cases remain
explicit pending parts; no pin is promoted from partial, skipped or opt-out evidence.
The new `RELAY_TEST_ESCALATION_LONG=1` probe runs a real Codex MCP call for 3601 seconds;
the public control still requires `RELAY_TEST_PUBLIC_NET=1`. See the
[acceptance map, omissions and exact host commands](qualification/escalation-wp6.md).
The owner decisions below also change stage-2 network routing; no config schema or
registry migration is required.

### Mediated network, standing and one-turn

`escalate` accepts `{ "kind": "network", "mode": "mediated" }` for one replacement
Codex app-server turn. With stage 2 enabled, network-disabled jobs now use the stage-2
executor too, so they can request that restart. The authenticated owning run root may
approve clearly authorized network work; uncertain authorization goes to the person.
Raw/local network remains person-only. With stage 2 on, standing non-raw `grant.network`,
`child_network` and kept grants on resume use this same mediated provider every turn,
without escalation. Read jobs with network use the executor and proxy too; filesystem
access stays read-only. An overlay preserves that baseline plus its approved addition;
raw substitution is refused. Unqualified stage2 settings, an exec-only backend or an
unavailable provider refuse launch with a reason; there is no native strict or raw fallback.
Stage 2 off preserves the released native route and its never-host refusal.

Hosted web search still runs at OpenAI, live with a network grant, and is disabled and
read back when `never.hosts` is set. It does not traverse the executor proxy. The native
"strict" note describes only the stage-2-off route; these turns report "stage-2 mediated"
and doctor describes both routes.

The trusted worker runs relay's existing public HTTP forwarding, CONNECT and SOCKS5
proxy at 127.0.0.1 on a separately leased port. Commands get uppercase and lowercase
HTTP_PROXY, HTTPS_PROXY and ALL_PROXY, with empty NO_PROXY. The app server receives
no added proxy environment: its broker credential retains its existing bypass.
Codex's `network_proxy` stays pinned off. Relay's executor profile has egress disabled
and allows only the worker proxy's leased IPv4 transport port; its final never rules
retain all service and control restrictions with that internal transport exception.
Approved IPv4 localhost-connect additions also permit their named port. No proxy credential is
required; other jobs' sandboxes cannot reach the port, and unsandboxed local processes
already have network authority.

Never hosts are compatible with mediated networking. Worker DNS follows CNAMEs,
checks every requested authority and every numeric result, and dials only screened
numeric addresses. Before every new request it refreshes all forbidden DNS endpoints
and retains every endpoint seen during the turn. An unavailable, malformed or stale
forbidden endpoint set refuses the connection; launch also requires an initial set.
No stale-cache or raw fallback exists. The proxy follows no redirects: each client
request after a redirect is screened again, including its port. Teardown cancels DNS,
closes listeners, pending connects and live tunnels. A teardown error follows the
existing uncertain-cleanup accounting. A worker crash closes the proxy's sockets.

No Go/Swift TLS for these jobs until Release B: TRUST remains off, so tools using
Security.framework TLS verification fail. Node/OpenSSL success does not qualify them.
Tools must honour proxy settings, or explicitly use the HTTP/SOCKS5 endpoint; direct
TCP, UDP and DNS fail except separately approved localhost capabilities. Tools that
ignore proxy variables fail closed. Opaque CONNECT/SOCKS tunnels are screened by
requested authority and checked endpoint, without TLS inspection or SNI checks.
Native strict's existing trustd
residual is unchanged: the lead measured certificate-driven blind OCSP/CRL GETs to
owned local decoys (including redirects) on 1.0.5/1.0.6, without establishing arbitrary
response access. Stage 2's no-TRUST path is unaffected by that measured route; Claude's
corresponding trustd behavior is unverified. See [qualification and host commands](qualification/mediated-network.md).

### IPv4 localhost-port connects

`{kind:"localhost", operation:"connect", host:"127.0.0.1", port:P}` compiles to
Seatbelt's `(remote ip4 "localhost:P")`. This also reaches port P on this Mac's LAN
and tailnet addresses; the approval request, receipt and result disclose it, including
failed or cancelled turns. `127.0.0.2`, `::1`, mapped IPv6 and other ports stay denied
unless separate baseline authority already permits them. Clearly authorized work may
be approved by the owning supervisor; otherwise ask the person. Service API effects
count. Never and relay control ports stay denied by number, with final denies winning.
Connect additions remain refused with `never.hosts`: their direct allowance cannot
enforce forbidden DNS endpoints. No per-turn proxy token was added.

### Test temporary paths

All test files share a short temp root when the inherited macOS TMPDIR would make a
probe socket exceed 103 bytes. Child fixtures inherit it too. The cancellation probe's
polling timer now clears even when setup/assertion fails, so an earlier socket failure
cannot keep that test process alive. Run the full suite from the default shell with
`node --test --test-timeout=600000 --test-concurrency=1 test/*.test.ts` after building.

### Escalation approval authority (WP3)

The child broker serves `escalate` independently of delegation. It requests typed capabilities
for one replacement turn; a qualified WP2 lifecycle must be registered before a provider is
available. Missing providers refuse before approval. The tool executes no command and creates no
standing grant. Release A still refuses local mode while stage 2 is enabled.

The existing boolean `escalation` setting remains supported. To require person approval for
port-0, use `"escalation": { "port0_authority": "person" }`; the default is `"supervisor"`,
meaning the authenticated owning run root, for clearly authorized tests/servers. Broad raw/local
network remains person-only. Labels and `user_confirmed` prose never substitute for that route.
Port-0 approval and job results disclose possible 0.0.0.0/LAN listening and whole-turn access to
worktree code the agent may edit after approval. Missing person channels return
`person_path_unavailable`. Outside writes persist; results report launch scope and cleanup.

New Codex registrations reserve the finite overlay/transition budget too: the default MCP timeout
is 11400 seconds. Reinstall and restart Codex to refresh the root registration. The prior shipped
3600-second default upgrades automatically; unrelated custom settings retain existing safeguards.
Launched stdio/broker registrations and readback share the timeout calculation. See
[WP3 integration and qualification](qualification/escalation-wp3.md) for the WP2 seam and host checks.
### Never policy (WP1)

WP1 adds strict additive `never.paths`, `never.ports`, `never.hosts` and
`never.override_builtin` config. **The registry stays at schema 4; no migration.**
The per-run never floor lives in private `params_json` within the existing run JSON
envelope, separate from effective config. Each run durably retains every observed
addition; removals need a new run. Host entries disable raw grants and require
hosted web search/open-page withholding with effective readback. Extension servers
are refused for Release A until their per-server never-screen adapter is qualified,
before consent or launch. The initial production catalog is empty; person consent
does not bypass this refusal. The adapter interface remains available for qualification.
Older relay
versions reject the new public config keys; remove them from person-edited config
before using an older version.

Stage 2 runs a Codex job's commands inside relay's own Seatbelt sandbox, so that the job can have
raw network. It is off by default and requires no registry migration. MCP tools and
config change additively.

- **New config key: `targets.codex.stage2`** (boolean, default off). It switches stage 2 on.
  `RELAY_EXPERIMENTAL_CODEX_STAGE2=1` in relay's environment does the same, for tests and
  development. Keep the key out of a config that an older relay reads: an older relay rejects
  unknown keys.
- **New: `grant.raw_network: true`** on `delegate` and `resume`, for Codex write jobs, with
  `network: true` in the same grant, on the app-server backend. It cannot be combined with
  `local_network`. With stage 2 off, it is refused.
- **Only you can allow it.** Relay files a person-only request (`raw_network`) before the job's
  first turn under the grant. The root's `approve` and `relay approve` cannot allow it. Where relay
  has no way to ask you, the grant is refused up front. A resume that changes the grant asks again.
  A resume that drops `raw_network` ends the consent. A local-network consent never counts.
- **What the job gets.** Raw TCP, UDP, ssh and DNS to the internet. Your LAN and tailnet on every
  port; relay cannot close them. This Mac's loopback except the denied ports (TCP 22, 1025, 1143,
  8787, 11143, 5900, 3283, 3031, 445, 548, 631; every port anything on this Mac listens on when the
  turn starts, the system's included; relay's reserved range 47200-47263 but the job's own block) and
  UDP 1900 and 5351 to every host. Over IPv6 the denied ports are refused at every host: the sandbox
  cannot otherwise refuse the IPv4-mapped forms of this Mac's addresses (`::ffff:0.0.0.0`,
  `::ffff:` and its LAN address), which reach its services. IPv6 to those port numbers fails
  everywhere, and so does IPv4 sent through an IPv6 socket (Java by default). Otherwise the deny
  matches this Mac's own addresses only: a port forward reached through NAT hairpin, a tailnet
  subnet router or a VM bridge can lead back to a denied service.
- **What the job loses.** Read these before you switch it on:
  - It can listen only on its block of 4 TCP ports (`PORT`, `PORTS`). Port 0 and every other fixed
    port fail: `node --inspect` on 9229, `python -m http.server` without a port, `ssh -L`, test
    runners that pick their own port. A server bound on 0.0.0.0 on a block port is visible on your
    LAN and tailnet.
  - Services already running when the turn started, yours or the system's, are denied to it at
    every address of this Mac: your database, ollama, Jupyter, a dev server.
  - git cannot write inside the job. `git add`, `commit`, `stash`, `checkout -b`, `rebase`, and
    tools that call git fail. Relay commits the worktree at the end of each turn with its own
    message, so the agent's own commits and messages are lost.
  - Unix sockets only under the turn's temporary directory and a relay-made worktree; no image
    generation; executables only from the usual system and developer locations.
  - **No relay tools.** The job's Codex app server runs without Codex's own local environment
    (`CODEX_EXEC_SERVER_URL=none`), so that a turn Codex starts by itself has nowhere outside
    relay's sandbox to run a command. A stdio MCP server needs that environment, relay's own
    included, so a raw-network job cannot delegate, ask or use any other relay tool, and runs no MCP
    server at all. Give such a job everything it needs up front, or do the nesting from the root.
- **Requirements.** Codex 0.164.0 or later, `child_mcp: "relay-only"`, `child_hooks: false`, and no
  extension servers on the job. Otherwise the turn is refused with the reason.
- **Switching stage 2 on switches local mode off.** Codex's local-mode proxy has no
  authentication, and Codex binds it on ephemeral ports, so relay cannot fence it off. While stage
  2 is on, `grant.local_network` is refused on `delegate` and `resume`, and a turn of a job that
  still holds it fails before its agent starts, asking nobody. Continue such jobs with
  `raw_network` (and the person's consent) or with `network` alone.
- **Across runs.** The switch is read from each run's config, fixed when the run starts. While a
  raw-network turn runs, a local-mode turn of a run with stage 2 off gets hosted web search only,
  with the reason in its notes; while a local-mode turn that started before the switch runs, a
  raw-network turn is refused. Relay sees its own registry only.
- **With stage 2 off, nothing changes.** `grant.raw_network: false` is accepted as no grant, from
  the root and from launched agents alike, as before the key existed. With stage 2 on it counts as
  a grant: a root's `resume` with it replaces the job's grant (dropping raw network), and a launched
  agent's is refused like any grant it gives. A local-mode turn reads relay's registry once for
  running raw-network turns; with stage 2 off everywhere it finds none.
- **Local mode is to be retired fully when stage 2 ships (decision D2). Not done yet.** Jobs that use
  `grant.local_network` will have to move to `raw_network`, with renewed consent. That brings raw
  egress, the LAN, the port block and the denied running services along. No mode will be left with
  proxied egress and loopback.

## Relay 1.0.7 (2026-10-29)

- **A native turn's temp cleanup no longer crashes the worker.** In 1.0.6, if a job left files in
  its private temporary directory that were still being closed, removing it could fail with
  `ENOTEMPTY`. The worker then stopped with an error, and the job was marked failed although its
  agent had finished. Removal now retries briefly. If something still can't be removed, the turn
  keeps its outcome and reports the leftover as a warning in its result and its agent log;
  relay's temp sweep retries later.

## Relay 1.0.6 (2026-10-29)

- **Relay-enforced harnesses (Copilot, Gemini, Grok) with the network on now have IPv4 only.**
  Through 1.0.5 their profile refused this Mac's own addresses with `(remote ip "localhost:*")`,
  which Seatbelt does not match for the IPv4-mapped IPv6 spellings of those addresses, loopback's
  apart: a connect to `::ffff:0.0.0.0` reached this Mac's loopback services, and one to `::ffff:`
  followed by its LAN or tailnet address reached services listening there (review R1, measured on
  macOS 27.0.1). The only rule that refuses those spellings refuses all IPv6, so the profile now
  allows IPv4 alone and refuses this Mac's own IPv4 addresses. Tools that try IPv6 first fall back
  to IPv4 at once (curl, git over HTTPS and Node's fetch, measured). A client that reaches IPv4
  hosts through an IPv6 socket (Java by default) is refused; `-Djava.net.preferIPv4Stack=true`
  avoids it. The per-turn probes now try every address of this Mac's own, the IPv4-mapped and
  -compatible spellings included, with the network on and off. Strict Codex jobs and Claude jobs
  are not affected: their proxies already refused these spellings.
- **No grant may cover what relay runs outside every sandbox** (review r_0c11d860 X1): relay's own
  installation (the checkout whose `dist/` is running), the Node it runs on, and each target's CLI,
  by the name relay starts, the file it leads to and the Homebrew keg, npm package or Node
  distribution holding it. Before, a person-given `grant.write_paths` over the checkout or one of its
  parents let a write job change relay's code, which relay runs unconfined at its next start. A grant
  a job already holds is checked again on its next turn and refused there if it covers one of them;
  continue such a job with a grant that leaves that out. File requests there are refused too, and
  relay's Seatbelt profiles and Claude's sandbox settings deny writing relay's installation and Node.
  Limits: README, Known limits.
- **Relay runs every program by an absolute path, and no grant may cover a directory on its PATH**
  (r_0c11d860 X1). macOS's own tools (`pgrep`, `osascript`, `sw_vers`, `xcode-select`, `sleep`, `tty`)
  run from the system volume; git and the target CLIs are found on PATH and run by the absolute
  name found (git once per process). Before, relay started several by name, so a program a job put
  in a granted directory earlier on PATH would have run instead, unconfined. The git relay runs is
  protected as relay's installation is (grants, file requests, the sandboxes' write denies), and so
  are the developer tools behind `/usr/bin/git` when that is the git found. A grant over a directory
  on relay's PATH, one holding it or one inside it, is now refused, and a kept one is refused on its
  next turn. Relay's Seatbelt profiles and Claude's sandbox settings now deny writing the target CLIs
  and relay's PATH directories as well, and a turn whose own PATH finds its target's CLI in, or
  passes through, one of its write paths is refused at launch.

## Relay 1.0.5

1.0.5 closes the local reach of network-granted Codex jobs and of Claude jobs' shells (Unix
sockets, loopback and, for Claude, the LAN) that 1.0.4 recorded as still open, by address. The
network's own public address is not screened; a Claude job under `child_settings: "inherit"` keeps
any Unix sockets your own settings list in `allowUnixSockets`; and Claude's own WebFetch is pointed
at relay's proxy but not guaranteed to use it under settings relay cannot see (README, Known
limits). It also closes a way out of Codex's sandbox through
exec-policy allow rules. No registry migration; the MCP tools change additively
(`grant.local_network`).

### Codex jobs

- **A Codex job's granted network now goes through Codex's own network proxy, in strict mode.**
  Codex's plain network toggle, which relay set before, also opened every Unix socket (your tmux
  server's among them) and all of loopback (sshd, Proton Bridge) to the job's commands. Relay no
  longer sets it alone. A job given network (a grant, or `child_network`; `allow_dangerous` is
  unchanged) runs with `features.network_proxy` on, every public host allowed, no upstream proxy,
  `allow_local_binding` off, and Unix sockets only under the turn's temporary directory and, for a
  write job in its own worktree, that worktree. HTTP(S) works (curl, git over https, npm, pip); raw
  TCP, ssh remotes, direct DNS, this Mac's loopback and the local network do not. A job that relied
  on reaching a local service, or on ssh remotes, now fails at that step; see local mode below.
- **Verified before every turn, and hosted web search only where it cannot be.** A short-lived app
  server with the turn's exact settings must show the proxy: config readback (the proxy feature as
  `true`, the network table exactly), no administrator's network requirements, `network_proxy`
  listed and on in Codex's feature list, and a check Codex runs in the sandbox itself
  (`command/exec`) that finds relay's own loopback port and Unix socket unreachable and the proxy
  refusing loopback. Strict mode also requires that none of this Mac's own addresses is one the
  proxy would treat as public (a global IPv6 address), and that no exec-policy rules file Codex
  loads holds `network_rule`. Otherwise the turn gets Codex's hosted web search and no shell
  network, with the reason in the job's notes and at the top of the turn's input. The turn's own
  server repeats all of these checks before its thread starts, and refuses the turn on a mismatch
  (under `codex_backend: "exec"`, the short-lived server that checks its configuration does, since
  `codex exec` reports nothing). Each
  network turn's mode (strict, local, hosted search only) is in the job's notes (`status`, result).
  This works on Codex 0.163.0 and 0.164.0, where the feature is experimental.
- **New: `grant.local_network: true`** (Codex write jobs, with `network: true`) for a job that needs
  its own server on localhost. It opens this Mac's loopback and the local network to the job's
  shell, with your account's reach: loopback directly as well as through the proxy, and the job may
  listen on every interface, so devices on your LAN or tailnet can connect to servers it starts. Only you can allow it: a person-only request
  (`local_network`) asked before the job's first turn under that grant, and again when a resume
  changes the grant. The root's `approve` and `relay approve` cannot allow it; where relay has no
  way to ask you (no approval dialog or `confirm`, or escalation off) the grant is refused up front.
- **Network added to one command.** On a Codex job without a network grant, relay now declines,
  without asking anyone, a command's request to add the network to its sandbox
  (`additionalPermissions.network`): without the proxy, Codex would give that command the old open
  policy. Such denials are recorded with the job's refusals (`blocked`) and explained to the agent.
- **No access is added to one Codex command's sandbox any more.** Every turn switches off Codex's
  `request_permissions` tool (its requests were never answered by relay) and its
  `exec_permission_approvals` feature (`-c features.request_permissions_tool=false`, `-c
  features.exec_permission_approvals=false`), both read back from the configuration and checked in
  the feature list. With `exec_permission_approvals` on, a command your exec-policy rules allow
  would get the access it names (`with_additional_permissions`, network included) without any
  request reaching relay. If you turned the feature on, per-command file and network additions no
  longer happen in relay's jobs.
- **Codex jobs can no longer read credential stores**: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`
  and Codex's own `auth.json` (`$CODEX_HOME/auth.json` where CODEX_HOME is set) are denied in
  relay's profile, read and write jobs alike, and confirmed by the exact profile readback on every
  turn. A job that needed them (an ssh git remote, an AWS CLI call) now fails at that step.
- **Exec-policy allow rules no longer take a command out of the sandbox.** Codex runs a command your
  rules allow (`~/.codex/rules`, `/etc/codex/rules`, or a trusted repository's committed
  `.codex/rules`, which a job's worktree loads too) without asking and, before 1.0.5, outside the
  sandbox. While a profile denies a read, Codex lets no command leave the sandbox, so such a command
  now runs sandboxed. `relay doctor` lists your own rules files (`codex rules`). (From 1.1.0
  relay's Codex jobs run with relay's own Codex home, so they load its `rules` folder, not
  `~/.codex/rules`.)
- **An approved Codex command, or file change, no longer runs with full access.** For the same
  reason Codex runs it in a sandbox that can write anywhere but the denied stores, with the job's own
  network (none without a grant or after a fallback to hosted search; through the proxy in strict
  mode; loopback and the LAN open directly in local mode). Writing anywhere in your home
  directory is still your authority; the request's effect now says this instead of "full access".
  A request to reach a host the sandbox blocked (`networkApprovalContext`) is declined by relay on
  every job: with the proxy it can only be this Mac's own or a private address, and without it no
  approval can give the network (the agent is told to ask for a network grant).
- **Codex's hosted web search with a network grant is unchanged** (`web_search = "live"`): it runs
  at OpenAI, so it reaches nothing on this Mac, but its results can still carry prompt injection
  and its queries leave the Mac.

### Claude jobs with a network grant

- **Their shell no longer reaches this Mac's local services or its LAN by address, and WebFetch
  does not either unless settings relay cannot see exempt it.** In 1.0.4 relay gave a Claude job
  with the network (a grant or `child_network`) Claude Code's own sandbox proxy with every host
  allowed (`allowedDomains: ["*"]`). That proxy connected the job to loopback and LAN addresses by
  IP literal (plain HTTP, CONNECT and SOCKS5 alike), and WebFetch, which runs outside the sandbox,
  reached them directly. In 1.0.5 the sandbox sends every connection to a proxy relay runs for the
  turn (`sandbox.network.httpProxyPort` and `socksProxyPort`), and the Claude process gets
  `HTTPS_PROXY` with the turn's token and an empty `NO_PROXY`, which points WebFetch and Claude's
  model traffic at it too (console-delivered settings can still exempt them: README, Known limits). The proxy refuses every address that is not public (see the README's
  Known limits for the list), resolving each name itself and connecting to the address it checked.
  It does not know the network's own public (WAN) address, which a router's port forwards, UPnP
  mappings or hairpin NAT can lead back to this Mac or the LAN (README, Known limits).
- **What still works:** any public host on any port, over HTTP, HTTPS or SOCKS5 (`git` over https
  and over ssh, `npm`, `pip`, `curl`), public IP literals, WebFetch and WebSearch. **What stops
  working** (for the shell always; for WebFetch unless unseen settings exempt it): anything the job reached on `localhost`, the LAN, a Tailscale address (`100.64/10`) or
  this Mac's own addresses. A job that needs a local server needs a run without relay's sandbox
  (an approved unsandboxed command, or `allow_dangerous` for a write job).
- **Relay checks it as the turn runs.** It sets `SRT_DEBUG`, whose output (the sandbox's report of
  its proxy ports) goes to the agent log only. A report naming a port other than relay's stops the
  job at once. Network turns run with `--include-partial-messages`, and at the start of Claude's
  first response, before a tool in it can run, both ports must have been relay's and the Claude
  process must have sent at least one request with the turn's token to the model host through the
  proxy (`api.anthropic.com`, or Bedrock's or Vertex's where chosen; another `CLAUDE_CODE_USE_*`
  provider refuses the grant), or the job is stopped then with a reason saying which. This catches a
  Claude process that ignores relay's proxy variables and a `NO_PROXY` covering the model host; it
  does not prove that the model requests themselves, or WebFetch, went through the proxy. Settings
  relay cannot see (an organisation's, from the claude.ai console: a managed `ANTHROPIC_BASE_URL`
  with a `NO_PROXY` for its host, or a `NO_PROXY` listing local ranges) can send model requests or
  WebFetch around the proxy unnoticed: that is outside what relay guarantees (README, Known limits).
- **New refusals, for network grants only:** a proxy (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`) in
  the environment relay passes to Claude, and, with `claude_managed_settings: "accept"`, managed
  settings on disk that set the sandbox's proxy ports, local binding, Unix sockets or proxy
  variables. A job without the network is unaffected by either.
- **Every Claude turn** now sets `allowLocalBinding` and `allowAllUnixSockets` to false in relay's
  settings, which outrank your own under `child_settings: "inherit"`. A list of `allowUnixSockets`
  in your own settings is still merged in under "inherit".
- **Checking a Claude Code version:** `RELAY_HOME=<scratch> node smoke/claude-network-probe.mjs`
  runs relay's launch of the installed Claude Code (or `CLAUDE_BIN`) against a stub model and
  reports every route, its stub model reached through relay's proxy; `--control port`, `--control
  noproxy` and `--control modelbypass` check that relay stops a job whose sandbox, or whose model
  traffic, bypasses its proxy, and `--control collision` shows the known limit above (not stopped). It spends no model usage. Relay's release checks run it on each new
  version.

## Relay 1.0.4

Two things to know before upgrading: the registry migrates (schema 3 to 4), and `relay approve`
now has to be run at a terminal by a person. Still open in 1.0.4: a Codex job with a network
grant can reach local IPC and loopback (fixed in 1.0.5, above). What changes:

### What changes

- **Inbox notices say who sent them.** Claude Code shows everything on its inbox socket as a
  message from another Claude session, so a relay notice could be read as coming from one, or
  from the agent it is about. After the unchanged `relay (event N, tag <32 hex digits>): ` prefix,
  each notice now says so: `Sent by the local relay server, not by a Claude session or by the
  Codex agent (OpenAI) of job j_….`, naming that agent's harness and family from relay's
  registry, or just `Sent by the local relay server, not by a Claude session.` when the event is
  about no launched agent. The verification direction and pointer follow as before. Consumers
  matching the prefix are unaffected; anything matching `): Verify first` straight after the tag
  must allow the new sentence. Tool-result `events` and verified events are unchanged. Line 1 of
  `notice.txt` and line 2 of `inbox.jsonl` change accordingly; no other fixture does. Claude
  Code's inbox format has no documented sender field relay could set instead
  ([stable-surfaces](stable-surfaces.md#events-and-notices)).
- **`relay approve` now requires a person at an interactive terminal.** Allowing a request from the
  command line prints a one-time code that you type back, and refuses unless stdin and stdout are an
  interactive terminal and the command is not running inside a relay-launched agent's process tree
  (by the environment marker relay sets on launched agents, or by process ancestry, group or
  session). This replaces the old environment-marker-only check. It raises the bar against a naive
  or accidental approval; it is **not** a security boundary. The boundary that keeps a launched
  agent from deciding its own request is confinement — the sandbox that keeps the agent out of
  relay's registry. A command relay does not confine (`allow_dangerous`, or a command allowed to run
  outside the sandbox) runs with your authority and can get past this check, the same way it could
  write relay's registry directly; see [docs/approve-boundary.md](approve-boundary.md) and the
  README's Known limits. `relay deny` is unchanged and still works from anywhere, as does denying or
  allowing through relay's approval dialog, `confirm`, or the root agent's `approve` (which still
  cannot allow a person-only request). `relay cancel`, `relay adopt`, `relay clean --forget` and the
  two `relay chat` message paths (`--say` and typing a line interactively; `--print` is unaffected)
  now use the same launched-agent check. Scripts that ran `relay approve <id>` non-interactively and
  read the JSON result must now run it at a terminal and type the code; the help text and
  `usage.txt` reflect this.
- **Registry schema 4.** One new table, `launch_leaders`, holds the leader pids of the workers and
  agents relay launches, with each leader's start time (so a reused pid is not mistaken for a
  launched leader, and a pid that led twice keeps both), for the launched-agent check above. The first open by this build backs the
  registry up (`relay.db.backup-v3-…`) and adds the empty table; no existing row changes. Relay
  1.0.3 and earlier refuse a version-4 registry, so keep that backup if you may roll back. See
  [the registry contract](stable-surfaces.md#registry-and-migration).
- **Recognizer defence in depth** (`src/core/relay-command.ts`): these now fail closed —
  an interpreter in command position fed by a pipe (`… | sh`, including `|&` and a newline after
  `|`, and through wrappers such as `env`, `nice`, `timeout`, `stdbuf`, `sudo` and `exec`, whose
  value-taking options and `--` are parsed); a non-shell interpreter given inline code by its own
  flag (`python -c`, `perl -e/-E`, `ruby -e`, `node -e/-p/--eval/--print`, `osascript -e`,
  `php -r`, `lua -e`, `bun -e/--eval`, `deno eval`, also with the code attached, `-cprint(1)`, or
  as `--eval=…`); an unrecognised option on one of those wrappers; and glob metacharacters in
  command position (`rela?`). A shell's `-c` string (`sh`, `bash`, `zsh`, …) does not fail closed:
  it is parsed recursively as the nested command it is, so Codex's `/bin/zsh -lc '<cmd>'` is judged
  by its `<cmd>`. `sed`, `awk` and `xargs` are deliberately not flagged in ordinary pipelines
  (`git log | sed -n 1,5p`, `git ls-files | xargs wc -l`). This is a convenience filter behind the
  check above; its existing fail-closed behaviour on `$`-bearing words is unchanged.
- **Known limit recorded (not fixed here): a Codex job with a network grant can reach local IPC and
  loopback services.** With network granted, a Codex workspace-write sandbox can reach the person's
  running terminal-multiplexer server and local login service, which are outside relay's confinement
  and run with the person's authority; from there the approval check above does not help. relay's
  own Seatbelt confinement blocks this; Codex's does not, because the network toggle also opens the
  local sockets. This is pre-existing and tracked separately. Treat a network grant to a Codex job
  as giving it the reach of your account under 1.0.4. Fixed for Codex in 1.0.5.

## Relay 1.0.3

Nothing to do unless you use relay from OpenCode. What changes:

- **OpenCode 2 sessions each get their own scope.** OpenCode 2's background service runs one relay
  process for all its sessions in a project (seen on 2.1.4, 2026-10-26), so until now every OpenCode
  session shared one run: each could read, decide, cancel and merge the others' work, and take
  their events. Relay now scopes each call by the session OpenCode stamps on it
  (`_meta["ai.opencode/sessionID"]`); `status.session` reports `scope: "host-session"`,
  `source: "host-key"`. Another session's ids answer `Item unavailable.`.
- **A call from OpenCode 2 that carries no session ID does nothing** and is refused, saying why.
  OpenCode 2.1.4 stamps every MCP tool call. An OpenCode 0.x or 1.x release (no stamp) keeps one
  scope per process; any other version string (`local`, `unknown`, `0.0.0-…` from OpenCode's beta
  and dev builds) is taken for 2.x.
- **Restarts.** The scope lasts as long as the relay process: the session ID is no secret, so it
  gives no claim on work from before OpenCode restarted its service. Recover that work with
  `relay adopt <id> --to <fingerprint>` in a terminal, then `adopt` from the session.
- The README has an OpenCode section (registration with `opencode mcp add`, naming a target or
  setting `default_target.unknown`, approvals). No config keys change.

## Relay 1.0.2

Nothing to do for most installs. What changes:

- **`ask` on the desktop app's entry needs no `cwd`.** Where relay was started outside any
  project and a new question names no directory, relay now consults in a new, empty directory of
  the thread's own, made under `~/.local/share/relay/consult` (or `$RELAY_HOME-consult`), instead
  of refusing. Its follow-ups go on there. That parent must be a plain directory of yours (relay
  makes it, mode 0700) holding only the directories relay made there, and no job may be granted
  it or given a file change in it. A new
  `delegate`, `discuss` or `review`, and `merge`, still refuse without `cwd`. Uninstall lists the
  directory among what it leaves behind.
- **Auto mode and the desktop entry's session token.** The README's desktop section says what to
  do when Claude Code's auto mode blocks the session token: allow the entry's tools with a
  permission rule, such as `mcp__relay-desktop__*`, in that session's settings.

## Relay 1.0.1

Nothing to do for most installs. What changes:

- **`CODEX_ACCESS_TOKEN` is one of Codex's credentials.** It is a ChatGPT access token that Codex
  signs in with ahead of its stored login. Relay now withholds it from every agent under the
  default `child_auth: "login"`, and from every agent but Codex under `"any"`. A config that names
  it in the root `child_env.pass` or `child_env.request`, where no target has `child_auth: "any"`,
  passed validation on 1.0.0 and fails it on 1.0.1. While a 1.0.0 relay reads the same config, keep
  it out of the root lists. If Codex should sign in with it, set `targets.codex.child_auth: "any"` and
  list it under `targets.codex.child_env.pass`.
- **A Codex command that asks for access added to its sandbox can be allowed once only.** Where
  Codex's `exec_permission_approvals` feature is on, such a request's `wants` names the access and
  its effect says the command stays in its sandbox with that added. `approve` with `scope: "job"`
  refuses it and decides nothing, and relay's question offers no "for the rest of this job". Codex
  offers no more for such a request, and on Codex 0.163.0 an allow held for the job would also
  cover a later retry of the command outside the sandbox.
- **Codex jobs refuse some directory names.** A grant, a turn's own directory or a repository's
  git directory whose name holds a double quote, a tab or a line break is refused, saying why,
  before Codex starts. With a double quote, Codex 0.164.0 cannot build its sandbox at all; a grant
  or git directory with a tab or a line break stays unwritable without a word. Relay refuses those
  in the turn's own directory too, as a precaution: that case was not tested.
- **`thread/resume` asks Codex to leave the thread's past turns out of its reply.** Relay reads
  none of them.

## Codex sandbox as a permission profile in 1.0 (2026-10-22)

Relay now gives every Codex turn its sandbox as a Codex permission profile of its own,
`[permissions.relay]`, defined and selected with `-c` (`default_permissions = "relay"`) and named on
the thread, instead of `sandbox_mode` and `sandbox_workspace_write`. The sandbox is the same for
read jobs, write jobs, grants, network on or off, temporary directories, both backends,
Daybreak and speed, with one addition: a Codex write job can no longer create, change or remove
harness configuration (`.claude`, `.codex`, `.gemini`, `.mcp.json` and the rest of relay's list)
at the top of its worktree or of a granted directory. What to check:

- Your own `default_permissions`, other `[permissions]` profiles and `sandbox_mode` in Codex's
  configuration no longer stop Codex launches (0.9 refused `default_permissions` and
  `[permissions]`): relay's selection outranks them. A `[permissions.relay]` table of your own
  does stop them, since it adds keys to relay's profile. Rename it.
- An administrator's requirements for Codex that do not allow the profile `relay`
  (`allowed_permission_profiles`) or the sandbox mode a job needs (`allowed_sandbox_modes`) stop
  Codex launches, with a message saying so.
- Relay starts Codex's app server with its experimental API on for every turn (it was on only
  for Daybreak); naming a profile on the thread needs it.
- An approved escalation (a command or file change a person allows outside the sandbox) runs with
  no sandbox, so the read-only names do not hold for it.
- Under `codex_backend: "exec"` a read job still gets no network even when granted, as before.
- Relay names a thread's workspace roots (the job's directory) on every start and resume. A
  thread started before this change stored its grants among its roots and would restore them on
  resume; named, a grant taken away when the job is continued is no longer writable.

## Desktop conversation isolation in 1.0 (D9, 2026-10-21)

The Claude desktop app's shared entry, `relay-desktop`, now keeps its conversations apart by a
session token each model carries. In 0.9.1 the
conversations of each of its two processes shared one run, with one another's jobs, approval
requests and events. Dedicated registrations (Claude Code, Codex) and unqualified hosts do not
get the token: their tools do not take the parameter, and one passed anyway is dropped.

- **Reinstall the desktop entry, then quit and reopen the app.** Run
  `relay install claude-desktop --write` with the app quit, or check that relay's entry carries
  `--desktop`: that marker is what makes relay treat the desktop chats as a shared relay. Cowork's
  connection is also recognised by its client name, but how the chats' connection names itself
  has not been observed, so an entry without the marker (an old one named `relay`, say) may leave
  the chats in one unisolated scope. `relay doctor` warns about it. A `relay-desktop` process
  that 0.9.1 started still shares one run among its conversations until the app is quit and
  reopened.
- **Every conversation's first call gets a token and does nothing else.** A call without
  `session_token` returns `new_session.token`; `status` with no id answers in an empty scope,
  and any other call returns `session_required` with nothing started, telling a model that
  already has a token to call again with it. The model passes the token on every later call. A
  token relay did not issue gets `Session unavailable.`.
- **Runs from 0.9.1's shared processes belong to no conversation.** After the upgrade they are
  orphans, as every run from before it is ("Explicit orphan recovery" below):
  `relay adopt <id> --to <fingerprint>` in a terminal transfers one, whole, into the
  conversation whose `status.session.fingerprint` you give. A run several chats used cannot be
  split between them.
- **A conversation keeps its work across later restarts** by its token, without adoption. One
  that lost its token gets a new one; quit and reopen the app, then adopt the old run into it.
- **No registry change of its own.** Beyond 1.0's schema 3, relay adds `session.key` (0600) and,
  for each open environment broker, a record under `brokers/` to its home. Deleting
  `session.key` revokes every token at once; to move their runs to new tokens, quit and reopen
  the app, then run `relay adopt` from a terminal (`relay cancel` there stops the work instead).
- **The token is a bearer key.** It separates conversations that use relay honestly. A model
  that sees another conversation's token can act as that conversation; see the README's
  "Claude desktop app and Cowork".

## `relay clean --forget` in 1.0 (2026-10-21)

New, and additive: nothing changes until you run it. 0.9.1 never forgets a run. 1.0's
`keep_records_days` forgets inactive runs, but keeps a run whose job branch is in a repository
that is no longer there, since a repository deleted for good looks the same as one on a volume
not mounted. `relay clean --forget <run_id>` is the way to forget such a run.
It prints, as JSON, what it would remove and what it would leave, and changes nothing; add
`--write` to forget the run: its registry rows,
`runs/<run_id>/`, its harnesses' state, its `relay adopt` transfers and what relay made for
it in the worktrees directory. Branches in the missing repository are not touched. It
refuses a run still in use, one whose repository is there (`relay clean` applies then), and
one with quarantined login-store entries. See "What is kept" in the
[README](../README.md#security-model). 0.9.1 (on a Mac not yet upgraded, or after a rollback)
does not have the option and ignores the flag: there, `relay clean --forget <run_id>` is an
ordinary `relay clean <run_id>`, which keeps the run's records, and
`relay clean --forget=<run_id>` cleans every run.

`relay clean` itself now refuses a flag it does not have, and a second run id, with a usage
error (exit 2) that cleans nothing; 0.9.1 ignored them. A script that passed one must drop it.

## Claude jobs under a long home in 1.0 (2026-10-21)

**On a Mac whose home path is longer than about 22 characters, 1.0 gives Claude its private
temporary directory through a short link, and can refuse Claude jobs that 0.9.1 ran.** 1.0
gives each Claude turn a private temporary directory in `~/.rn`; 0.9.1 did not set
`CLAUDE_CODE_TMPDIR`, which leaves Claude Code in the shared `/tmp/claude-<uid>`. Claude Code
measures `$CLAUDE_CODE_TMPDIR/claude-<uid>` as written and, past 44 bytes, gives its sandboxed
commands that shared directory anyway. For such a home relay hands Claude the turn's directory
in `~/.rn` through a short link, `/Users/Shared/.rn-<uid>`,
which it makes on first use and checks before every Claude turn (yours, a link, exactly to your
`~/.rn`, in a sticky root-owned directory). The files stay in `~/.rn`; the registry and the
sweep know only the real directory, never the link. Short homes are unaffected: no link is made.

This works only because Claude Code measures that name before resolving links, which relay has
read in <!-- verified:claudeTempLink -->2.1.302, 2.1.303, 2.1.304, 2.1.308, 2.1.325 and 2.1.326<!-- /verified --> (2.1.305 to 2.1.307 and 2.1.309 to 2.1.324 were not read
one by one; they lie between versions that measure it the same way). Relay's version gate is a floor and Claude Code
updates itself, so on the link path relay refuses a Claude Code newer than <!-- verified:claudeTempLink:last -->2.1.326<!-- /verified --> (or one whose
version it cannot read) unless `allow_untested` is set, and says which versions. Short homes never
meet this check.

Check after upgrading on a long-home Mac:

- `relay doctor` has a `claude temp` line: the link not there yet (relay makes it on the first
  Claude turn), in place, or why relay refuses Claude turns, with the version ceiling. Doctor
  never makes the link, and its Claude init probe runs only once the link is usable.
- If relay refuses and names `/Users/Shared/.rn-<uid>`, something else is already
  there: another user's entry (an administrator must remove it), a directory, or a link to
  another place (an old home of yours: remove it). Relay never replaces it.
- If it refuses because Claude Code is newer than <!-- verified:claudeTempLink:last -->2.1.326<!-- /verified -->, pin Claude Code to <!-- verified:claudeTempLink:last -->2.1.326<!-- /verified --> or older
  (point `targets.claude.bin` at that version's binary), wait for a relay release that raises the
  ceiling, or set `"allow_untested": true` to run unverified.
- With a uid over five digits even the short link is too long, and relay refuses Claude jobs
  on such a home.
- Rollback to 0.9.1 leaves the link in place and harmless (0.9.1 does not use it); remove it
  by hand if you like (`rm /Users/Shared/.rn-$(id -u)`).

On every Mac, long home or not, a grant of `/Users/Shared` itself is now refused (new or kept),
since a job holding it could change the link. Grants of directories inside it are unaffected.
Doctor's Claude init probe keeps its temporary directory in `~/.rn`, as a turn does.

**Release checklist.** A release admits a newer Claude Code on the long-home link only after
that version's temporary-directory handling has been checked to measure the name before resolving
links, as the versions above do; only then is `CLAUDE_TEMP_LINK_VERIFIED_THROUGH` in
`src/backends/native-temp.ts` raised.

## Tool-token policy in 1.0 (W9, 2026-10-19)

**0.9.1 inherited unknown environment variables; 1.0 no longer does.** With no
`child_env` setting, launched agents inherit the exact runtime baseline and validated
proxy variables only, after mandatory vendor/auth and host-session scrubs. Unknown cloud,
registry, GitHub, database and SSH-agent variables are excluded. Network grants and
`child_auth: "any"` do not select them.

Configure exact names in your own relay config, never secret values:

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

`JAVA_HOME` is a standing pass and prompts for no additional consent. Root and target
lists are unioned; target `policy` overrides root; `drop` wins, including over standing
passes and approved requests. Names are exact, case-sensitive and must match
`[A-Za-z_][A-Za-z0-9_]*`. Wildcards, unknown keys and pass/request entries for relay-owned
names are errors. A root-level entry applies wherever a target may receive it; mandatory
guards still remove it per target (for example, `GH_TOKEN` from Copilot under login),
and doctor gives the reason. It is an error only when no target could receive it;
a target-level entry must be allowed for that target. Empty target lists do not clear root lists.

To request one turn's private install, a root call can carry
`grant: { network: true, env: ["NPM_TOKEN"] }`. For a GitHub operation request
`grant.env: ["GH_TOKEN"]`. Each requested name must be in effective `request` and present
in the root server's captured environment; missing, dropped or forbidden names refuse
before launch. Only the person may allow disclosure through the existing qualified
approval dialog or `confirm` path. Root `approve`, including `user_confirmed`, child
tools and `relay approve` may deny but cannot allow it. Without that person path, relay
refuses and points you to config: choose a deliberate standing `pass` if appropriate,
or use a qualified host. Standing `pass: ["NPM_TOKEN"]` or `pass: ["GH_TOKEN"]` releases
that exact variable without a prompt. Prefer narrowly scoped, short-lived credentials.

A private install can now fail because `NPM_TOKEN` is absent, and a push or GitHub CLI
call because its environment credential is absent. Select only the exact needed names;
network permission is a separate decision. Public installs often need network alone.
Install scripts can read released tokens. `GH_TOKEN` can authenticate GitHub CLI but does
not configure git's transport or credential helper; prefer having the root push a reviewed
branch when the launched task does not need push authority. Toolchains that relied on
`JAVA_HOME`, `SDKROOT`, `CARGO_HOME` or `VIRTUAL_ENV` need exact `pass` entries too.
Codex's own `shell_environment_policy` must also allow a released name for it to reach
commands Codex runs. Relay does not override a stricter policy, such as
`inherit = "core"` with `include_only`, but it names each released name that policy
withholds, with the reason, in a note on the Codex turn and, for `pass`, in `relay doctor`.

For temporary compatibility, explicitly select `child_env.policy: "legacy"`. Relay warns
on **every root load** and in doctor. It restores other-variable inheritance, including
unknown secrets, subject to mandatory scrubs and `drop`; it is supported through 1.x.
It does not restore 0.9.1's cross-vendor exception: global `child_auth: "any"` remains
accepted but permits only each destination's own supported auth inputs and warns with a
pointer to `targets.<id>.child_auth`. Own-target auth inputs must also be selected by the
environment policy. Prefer the per-target form. `tool-denylist` is unavailable in 1.0;
a config naming it fails validation. It may be added later.

A person-set endpoint override in the root environment refuses launch for every target,
under both `child_auth: "login"` and `"any"`, before any environment filtering. Excluding
or dropping Claude's `ANTHROPIC_*BASE_URL`, Codex's `OPENAI_BASE_URL` or Gemini's endpoint
variables cannot bypass this refusal: relay cannot tell which family answers there.
Under `any`, filtering could also send a credential intended for that endpoint to the
vendor instead. Unset the named variables and restart the root. A desktop/Agent SDK
host's own Anthropic endpoint remains the exception under Claude's login policy:
relay removes the host endpoint and credentials together and verifies the account login.

Run `relay doctor` to preview each target's effective policy and included/dropped names
with reasons; diagnostics never show values, proxy URL contents or value hashes. Restart
all root servers and workers on upgrade: an old process retains its inherited values.
Root-environment changes require another server restart. Requests authorize one turn
only; every resume needs fresh person consent. Consent persists metadata/decisions only,
never values or reusable hashes, and old consent cannot be replayed after a restart.
Every new turn gets its environment from the owning root's relay server. If that server
has restarted, a resume or nested launch fails with a "restart the root" message instead
of inheriting another process's environment. A running turn is unaffected.
Removing a pass cannot erase an already running agent's memory, transcripts or leftover
processes; cancel affected work and revoke/rotate the credential when needed.

**When a job needs its root.** A turn's worker claims its environment as soon as it picks
the turn up, before the turn waits for a `max_concurrent` slot, and holds it in memory,
never on disk, until the launch. For a new job, or a resume of work with nothing running,
that is right after `delegate` or `resume` returns, once the worker has started. From then
on the job survives its root session exiting, as in 0.9.1, also while it is queued behind
other jobs. A root that exits in the moment before the claim still fails the job: before
the worker's start-up claim, its queued turns fail with "…could not supply worker redaction
values…"; after that, the turn fails with "…environment broker is unavailable…". A
follow-up queued behind a turn that is still running claims only when that turn ends, so
its root must still be there then. A `grant.env` request is put to the person at the
claim, while the job is still queued, and a denial fails the turn there. Consent given then
is used at the launch however long the job waits for its slot, and restarting the root
neither refreshes nor withdraws what a queued job has already claimed: cancel the job to
withdraw it. Before the launch, relay checks that the turn's grant, its worker, its
working directory and its environment/auth policy are as they were at the claim. If any of
them changed while the turn waited, it fails closed and says so, rather than launch with
what it was given earlier: resume it to claim afresh. For a job with a `grant.env`
request, any edit of relay's config file counts, even one that leaves the policy as it
was; for any other job, only a change to its environment/auth policy (`child_env`,
`child_auth`) does. A turn cancelled while it waits launches nothing and drops what it
claimed.

**Environment filtering is not credential-file or keychain isolation.** Tools can generally
still read `.npmrc`, cloud credentials, `.env`, login stores and git credential helpers,
and may reach keychains or sockets under their harness's rules. Loaded CLI settings and
native MCP servers have separate credential paths. Network-off still permits disclosure
through model traffic/results and permitted API hosts. Redaction is defence in depth;
it does not prevent reading or using credentials.
Explicitly released values of any name are registered for per-turn literal redaction
only when secret-like: at least eight characters, not starting with `/`, `~` or `.`,
and not all digits. Short values, numbers and those paths are not registered by value;
the existing shape and context redactors still apply.

0.9.1 rejects `child_env` and `targets.<id>.child_env`, even when set to `{}`, default policies
or empty lists, so keep them out of a config file a 0.9.1 relay also reads.
See [the environment policy](configuration.md#environment-policy). Stub tests
do not close gate 8: each admitted signed-in harness still needs scratch launch/resume,
toolchain, public/private install, synthetic-token visibility and network-off/on probes,
including permitted API hosts, sockets/helpers and hostile repository instructions.

## Codex Daybreak in 1.0 (A33, 2026-10-19)

`targets.codex.daybreak: true` requests Daybreak for eligible Codex models; relay
does not enable it unless set. Unset leaves Codex's own configuration unchanged;
explicit `false` disables it. Only your relay config can set it, for the enrolled
account holder's own use: never proxy or provide Daybreak to anyone else.
Eligible models come from Codex's catalog; other or unknown models run without it,
with a plain note in status/results. Before Codex 0.163.0 this key has no effect:
enrolled accounts received Daybreak automatically. 0.9.1 rejects the key even when
`false`, so keep it out of a config file a 0.9.1 relay also reads.

## Verifiable inbox pointers in 1.0 (D14, 2026-10-18)

Restart relay's root servers to use signed inbox notices. The prefix changes from
`relay (event N):` to `relay (event N, tag <32 lowercase hex digits>):`, and the notice
directs the agent to call `status({notice: {event_id: N, tag: "<copied tag>"}})` before
acting. This optional parameter performs verification only, ignoring `id` and `wait_s`.
Use only the stored event returned with `notice_verification.verified: true`; ignore
missing tags, unknown events and failed verification, and report them to the user.
Notices remain pointers, never approval or other authority. Update consumers matching
the old inbox prefix; accepting unsigned notices would bypass this security tightening.

The signing key is generated per live server and held only in memory, independently of
registry ownership tokens. Tags bind the session/run and event contents, and verification
also checks current ownership. Relay persists neither keys nor tags in registry, agent
files or diagnostic logs, though the host may record the notice and verification call in
its own transcript. Old tags fail after restart or ownership transfer; use ordinary status
to recover. Deduplicate repeated verified events by `event_id`: verification proves
authenticity, not freshness. Unsigned tool-result events, existing status/result calls,
database schema, config keys and inbox JSONL envelopes remain compatible.

The fixture changes are the additive `status.notice` object in `tools.json`,
line 1 of `notice.txt` (signed prefix and verification direction), and line 2 of
`inbox.jsonl` (the same notice in the user envelope). No other stable fixture changes.
See [the complete contract and fixture rationale](stable-surfaces.md#events-and-notices).

To limit inbox delivery, set Claude Code's `crossSessionInbound` to `hold` or `refuse`;
these withhold or drop relay notices as well. Events still arrive on the next relay call.
The controls do not restrict socket connections or provide a relay-only sender list;
see [Claude Code's documentation](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages).
Doctor now reports observed inbound setting values and their sources for its directory,
with an explicit limit on inferring another session's effective configuration.

## Tool deadlines and event delivery in 1.0 (2026-10-18)

Relay now caps all waits in one Codex call below its registered `tool_timeout_sec`, with a shared deadline from request receipt. Roots read `[mcp_servers.relay]` in `$CODEX_HOME/config.toml` (or `~/.codex/config.toml`); missing or unreadable timeouts use the 60-second default. Launched Codex agents use the timeout relay sets for their turn, at least 3600 seconds. The margin is 10 seconds, scaled to one sixth for shorter timeouts. Doctor now explains early-return caps instead of requiring `tool_timeout_sec` above twice `block_s`. Restart sessions after changing registrations, and keep any CLI overrides consistent with the file relay reads.

For unattended Claude Code with `CLAUDE_AUTO_BACKGROUND_TASKS=1`, the shared cap is 110 seconds by default. Relay respects `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` from its host environment; interactive terminal waits are unchanged. See the [Claude Code variable reference](https://code.claude.com/docs/en/env-vars) and [backgrounding guide](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls). No manual reduction of `block_s` is needed for these modes.

A capped `status` result reports `wait_ended` and delivers pending events. Events are acknowledged only after the reply’s transport write completes; cancelled calls and closed or failed transports leave them pending. Concurrent replies or an acknowledgement failure may repeat an event with the same `event_id`. A completed write is not an acknowledgement from the agent. No config keys or database schema changed.


## Approval dialog qualification in 1.0 (2026-10-18)

Approval dialogs now require a detected surface qualified for unsolicited elicitation both idle
and busy. Relay cannot reliably observe whether the host's turn is busy: no relay call in flight
can still mean a shell command is running. The enforced table in `src/mcp/host.ts` cites the
host observations behind it (not published):

| Surface | Idle evidence | Busy evidence | Dialogs offered |
|---|---|---|---|
| Interactive Claude Code terminal | 2.1.286, C-k; rerun 2.1.302 | 2.1.286, C-g; rerun 2.1.302 | From 2.1.286, with existing consent checks |
| Codex CLI | 0.162.1, X-e; rerun 0.163.0 | 0.163.0, X-j | From 0.163.0 |
| Codex app / desktop | 0.162.0-alpha.17.2, XA-d | XA-f unrun | Withheld in every state |
| Claude SDK / desktop Code tab, unattended `-p` | D-c/D-d, P-c: automatic decline/cancel | No human dialog qualification | Withheld; Code tab keeps qualified `confirm` |
| Shared desktop bridge, unknown hosts, custom Codex originators | Unqualified | Unqualified | Withheld |

Codex detection uses `codex-mcp-client`, version, the forwarded originator, the app's MCP UI
capability and `client_type: desktop_app` call metadata (XA-a). Desktop evidence takes precedence
at newer versions too; once seen on a call, later calls omitting it cannot re-enable dialogs.
The native CLI signature without desktop/custom-originator markers retains CLI qualification.
Later versions of a qualified surface retain the existing version-floor policy. Claude's
interactive entrypoint, SDK/desktop markers, bypass and settings checks remain in force.

`ask_user: "always"` remains valid but no longer opts unknown or partially qualified hosts into
dialogs; it observes the same gates as `auto`. `never` still disables all dialogs. No migration
or config edit is needed. Restart root sessions to use the new gates. Requests remain pending,
arrive in the next call's `events`, and have their full details in `status.needs_approval`.
`confirm` remains available wherever its separate permission prompt is qualified; otherwise use
the root conversation or terminal for ordinary requests. Person-only requests still need a
qualified dialog or `confirm` to allow them.

`status.approval_dialogs` reports this connection's effective `offered` boolean and `reason`,
including when no request exists. `relay doctor` prints idle/busy qualification floors and
withholding reasons per surface; it describes the policy and cannot inspect another live host.
The Codex app's busy dialog path stays unqualified until XA-f is run and the table is updated.

## Skill isolation and consent scans in 1.0 (2026-10-18)

Every launched Claude and Codex agent now loads exactly the skills Relay gives it, none by default. Codex no longer inherits personal or repository skills on jobs without extensions; bundled skills are disabled too. Claude disables skills under isolated and inherited settings alike, and checks every init report. Codex checks `skills/list` on every turn (the `exec` fallback through its existing app-server preflight). Unexpected skills/plugins, missing reports and discovery errors refuse the turn before work.

To give an agent your user skills, set `targets.<id>.skills: "user"` (or select names/paths), request `extensions: true`, and consent. Config alone does not give a job skills. Given Codex extensions still require `codex_backend: "app-server"`; inherited Claude settings remain incompatible with Claude extensions. No personal CLI files are rewritten. New upstream bundled skills/plugins that Relay cannot switch off refuse the turn rather than extending it silently.

Claude consent scans now include installed plugin hooks, manifest-declared hooks and skill frontmatter under `~/.claude` and `CLAUDE_CONFIG_DIR`, plus repository and plugin definitions. Matching hooks withhold `confirm`/adopt permission prompts or the approval dialog as appropriate. Unreadable plugin manifests, ambiguous skill frontmatter, any skill `hooks` key and uninspectable plugin sources fail closed; cached copies count conservatively. Restart MCP servers to apply the scan. Console-managed settings and changes after server startup remain limitations. See [extensions](extensions.md#consent-scans-include-extension-hooks) for exact scope and official Claude Code references.


## Family steering in 1.0 (2026-10-17)

`same_family` now defaults to `"allow"`. To retain 0.9's admission, set `"same_family": "refuse"`; that key and value already validate in 0.9. Existing runs keep their full snapshotted config, including their old default. Root sessions use the new default.

An explicit `"allow"` now also admits unknown callers' starts and continuations, and Copilot on `auto`, no model or unlisted ids. Copilot model switches continue with a warning under allow, even to an unlisted id; pinned model mismatches before the prompt still fail. Copilot remains experimental and gated by boundary probes. Omitted targets never select a known caller's own routing family under either policy.

A client name contradicting `--host` now makes the caller unknown (for example opencode importing a Claude registration). Under allow it must name a target, or use `default_target.unknown`; under refuse it cannot start or continue work. Under `--desktop`, an unobserved or unknown client name still keeps the registered family; a name identifying another known family or a multi-model harness contradicts it. The desktop chat clientInfo has not been observed. Do not copy another host's registration to impersonate that host.

`default_target.unknown` is new in 1.0 and rejected by 0.9's strict schema. Keep it out of a config file a 0.9 relay also reads. Copilot's `default_model: "auto"` validates in 0.9 but is refused there at call time. No keys or values were removed or renamed.

The registry is now schema version 3: each confined turn records the path, device and inode of its private temporary directory before launch. Opening a version-2 registry first makes a `relay.db.backup-v2-…` copy; earlier builds refuse the newer registry, so retain that backup for rollback. Old `relay-tmp-*` directories have no mapping and are left alone, with a warning from doctor. Old items without caller-family records read `unknown` with a legacy note; their stored config cannot prove a cross-family caller. Applicable Claude settings waivers make labels unknown from the start (isolated settings without managed settings need none). Codex’s `codex_endpoint_override: "accept"` conservatively makes every launch unknown even without an active redirect; its note says whether a redirect was actually found. Regenerate adapters with `npm run build && node adapters/build.mjs`, reinstall with `relay install claude|codex|claude-desktop --write`, and restart sessions. Relay work does not edit personal instruction files.

**Storage gates:** `log_max_mb` now rotates `proxy.jsonl` at the run's size limit between complete decision records, keeping `<name>.1` like agent logs. `relay clean` and worker housekeeping sweep a mapped `relay-tmp-*` directory only after its turn is settled and start-time-checked process evidence says nothing still uses it; running, unknown and linked directories stay. Bare occurrences of that turn's generated proxy token and bridge secret are cut from its logs, results and errors with labels naming what was cut. No new config keys are required.

**Schema-3 migration:** `turns` gains nullable `tmp_dir TEXT`, `tmp_dev INTEGER` and `tmp_ino INTEGER` columns. Existing rows retain `NULL` in each; no old temporary-directory mapping is guessed. A 0.9.1 registry (schema 1) receives all schema-2 and schema-3 additions in one open, with `PRAGMA user_version` advancing directly from 1 to 3 and exactly one unchanged pre-migration schema-1 backup. A second open makes no further backup. The registry snapshot includes the schema-3 columns; MCP tools and config schemas are unchanged. See [the registry contract](stable-surfaces.md#registry-and-migration). Schema 3 also adds nullable `refusal_json TEXT` for the new terminal status `refused`; old turns retain NULL and their original statuses.

Under both settings, §3.7 also rewords the no-other-target (R-none) and unusable configured-default (R-default) refusals. Unknown-caller instructions no longer advise multi-model hosts to copy a single-family registration. Strict unknown-caller agent lists keep the old “Codex from Claude, Claude from Codex” mapping.

ACP `current_model_update` now replaces stale model-option state, including a missing id. Under `refuse` a switch stops the turn and revokes relay tools; under `allow` it continues with an unknown label and a warning. This intentionally closes a 0.9 fail-open gap rather than preserving that bug. Recording errors fail the turn; they cannot skip the strict stop.

`relay install codex --write` adds `env_vars = ["CODEX_HOME","CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]` to `[mcp_servers.relay]`. Codex (tested floor 0.162+) otherwise strips the originator marker (and `CODEX_HOME`, which review withholding needs; see below) before starting stdio MCP servers. It lets relay identify T3 and exclude unattributable elicitation under both `ask_user: "auto"` and `"always"`, preserving the Codex waiting profile. Decisions go through the root agent or `relay approve` in a terminal. Launched agents have that originator marker removed, so their Codex threads identify relay. Existing relay entries without the line upgrade without `--force`, are backed up, and reinstall idempotently; both old and new entries uninstall cleanly. Doctor warns when an entry lacks the marker line; restart Codex after reinstalling. The desktop Code tab keeps inbox notices on, including with its SDK markers. Bare SDK inbox profiles (including T3) default off; an explicit `RELAY_HOST_INBOX=on` or `off` marker overrides the detected host profile without changing family identity.

**Rolling back to 0.9.1:** its installer treats 1.0’s `env_vars` as a user customization. After rebuilding 0.9.1, use `relay install codex --write --force` to replace that entry with 0.9.1’s registration (the old file is backed up), then restart Codex. This also applies to running a 0.9.1 installer on a Mac whose entry was written by 1.0.

## Relay 1.0

Relay 1.0's changes, gathered from the dated 1.0 sections above.

### Behaviour changes in 1.0

- **Environment disclosure.** Unknown root variables are no longer inherited by default.
  Configure exact `child_env.pass` or person-approved `grant.env` requests; see the
  [migration and limits above](#tool-token-policy-in-10-w9-2026-10-19).
- **Family steering.** `same_family` now defaults to `"allow"`: named same-family work
  and work of unknown family can run and is labelled as such. An omitted target still
  excludes the caller's registered family and chooses only a unique eligible target
  (or `default_target`); ambiguity asks for a name. `same_family: "refuse"` restores
  strict cross-family admission. Copilot `auto` and Grok without a pinned model are
  unknown. Registration/clientInfo contradictions make the caller unknown and are
  diagnosed; `default_target.unknown` routes that case.
- **Review withholding.** The caller's `own_review` is accepted and written only after
  the reviewer settles. If the wait returns pending, keep the review in context, wait
  with status, then resend it. Until submission or explicit skip, results withhold the
  other review and its log/transcript paths, across reconnects; steering the reviewer
  outside reconciliation is refused. Identified `own_review` tool arguments are redacted
  in logs, structured echoes and diagnostics. Claude reviewers get read denies for the
  caller's host-state stores; reinstall Codex to forward `CODEX_HOME`. Codex reviewers
  have no read carve-out, and drafts, free-form echoes and copies outside denied paths
  can still expose reviews. This is a normal-use safeguard, not guaranteed independence.

- **Relay config protection (DM8).** Grants, file requests, Claude's write denies and relay-enforced confinement protect the configured and resolved config file, `install.json` and `install-backups`; dedicated relay directories are protected whole. Broad directories get file protection only, which doctor explains.
- **Relay CLI requests (DM8).** The model's `approve` cannot allow a command that runs relay's own CLI, even with `user_confirmed`; denials still work. The person can allow through the host's dialog, `confirm`, or `relay approve` in their terminal.
- **Terminal authority (DM8).** `relay approve`, `relay cancel` and `relay adopt` refuse an environment with `RELAY_RUN_ID` or `RELAY_NODE_ID` and direct the caller to the person's own terminal. (Strengthened in 1.0.4, above: the launched-agent check now also follows process ancestry, group and session, `relay approve` additionally requires an interactive terminal and a typed one-time code, and `relay clean --forget` and the `relay chat` message paths use the same check. None of this is a security boundary against an unconfined same-user process; see that section and the README's Known limits.)
- **Claude subagent hooks (DM8).** User and project `.claude/agents/*.md` definitions, including `CLAUDE_CONFIG_DIR/agents`, are now checked. Conservatively, any frontmatter `hooks` key or unreadable/ambiguous frontmatter withholds `confirm` and the permission-prompt authorization of `adopt`; terminal-ticket recovery remains available. No YAML dependency was added.

- **Scoped MCP access.** A different root connection can no longer read or change a run merely by naming one of its items, secondary IDs or approval requests. Foreign and unknown IDs both return `Item unavailable.` The administrative CLI stays global. Launched children may read only their injected run; their existing mutation limits remain.
- **Native Codex subagents.** Native Codex subagents (`spawn_agent`) lose read access to their parent's items: each native thread has a separate root relay connection. The parent must call `status` and `result` for its own items; handing their IDs to a native subagent no longer permits inspection or waiting. This differs from a relay-launched child, whose injected context permits reads within its run.
- **Explicit orphan recovery.** Owner process death no longer permits automatic adoption by status, result or a mutation. Start replies include `run_id` and an `adoption` description. Use `adopt({run_id: <job, thread, discussion, review or run id>, into_session: status.session.fingerprint, in_directory, item_count})` through a qualified Claude Code permission prompt, copying the description fields exactly from the run's reported `adoption` object. Unknown, live and mismatched runs get one generic unavailable reply with a fixed recovery hint. Else (including relay-desktop), the person first runs `relay adopt <id> --to <fingerprint>` in an interactive TTY, reviews the printed whole-run transfer, and types the exact confirmation; piped input is refused. The destination consumes that one-use authorization within ten minutes. Jobs and pending events survive; process-scoped request_ids do not migrate across restart. `user_confirmed` is no recovery credential. Restart every old MCP server to get these access checks.
- **Desktop conversations are kept apart by a session token (D9).** Main-window desktop chats still share one `relay-desktop` process, and Cowork, the Code-tab in-app bridge, remote Cowork and widgets a second; in 0.9.1 the conversations of each process shared one run. Now each conversation has its own runs, jobs, approvals and events, by a token its model carries: see [Desktop conversation isolation in 1.0](#desktop-conversation-isolation-in-10-d9-2026-10-21). Status and doctor label both processes shared. The Code tab's dedicated native registration is separate. Explicit cwd and the 50-second wait cap remain.

- **No Codex proxy role.** Pre-release 1.0 builds wrote a Codex subagent role per target of another family, `~/.codex/agents/relay-<target>.toml` (under `CODEX_HOME` if set). No release shipped it, and 1.0 writes none (the maintainer, 2026-10-17). `relay install codex` and `relay uninstall codex` remove a role relay wrote, saving it first beside itself (`relay-<target>.toml.bak-relay`); install asks for `--force` if the role was changed after relay wrote it. A file of that name without relay's ownership marker is left alone, `--force` or not. From Codex, call relay's tools directly.
- **A new target, Grok (`grok`), off by default and experimental.** 0.9.1 knows only the target ids `claude`, `codex` and `copilot`, and its config schema is strict about them (`v0.9.1:src/core/config.ts`, `byTarget`), so it rejects `targets.grok` (even `{ "enabled": false }`), a `default_target` key or value of `"grok"`, and a `grok` entry in the legacy `bin`, `default_model` and `default_effort` maps, and then refuses every call. Keep all of them out of a config file a 0.9.1 relay also reads. The README's Grok setup (`targets.grok` with `enabled` and `experimental`, and optionally a `default_model`, with the routing caveat there) is for after that.
- **xAI's and Grok's credentials are removed from every launched agent.** `XAI_API_KEY`, `GROK_CODE_XAI_API_KEY`, `GROK_AUTH`, `GROK_DEPLOYMENT_KEY`, `GROK_ALPHA_TEST_KEY` and `GROK_EXTRA_AUTH_KEY` are now among the vendor credentials relay removes from a launched agent's environment under `child_auth: "login"` (the default), Claude's and Codex's agents included, whether Grok is switched on or not. A Claude or Codex job that used one of them (a script calling xAI's API, say) no longer sees it; `targets.<id>.child_auth: "any"` does not bring it back, since it passes only that target's own vendor's keys. The old global `child_auth: "any"` exception has ended: it no longer forwards foreign-vendor keys in 1.0, including under `legacy`.
- **Restart, and reinstall the Codex registration.** Before relying on the updated review withholding and log redaction, restart every relay session, and quit and reopen the desktop app. Reinstall the Codex registration (`bin/relay install codex --write`) so it passes `CODEX_HOME` through to relay's MCP server.
- **`relay:operator` no longer merges, and has a sibling, `relay:codex`.** In 0.9.x, Claude Code's `relay:operator` subagent had `merge` and ran on your session's model. In 1.0 it has no `merge`: it reports a write job's branch with its diff summary, and your session merges once it has looked. It runs on Sonnet (from Claude Code 2.1.251; before that, on `CLAUDE_CODE_SUBAGENT_MODEL` when you set it), and in the background (`background: true`), its report arriving as a notification; under `claude -p` a job that outlasts Claude Code's 10-minute wait for background work loses that report, and a later session collects it only after adopting its run (README, "Claude Code"). A new `relay:codex` subagent does the same but always names Codex, for "use the codex agent". Both come with relay's plugin, whose content changed: run `bin/relay install claude --write` again and restart Claude Code's sessions.

- **Google's credentials are removed from every launched agent, and what decides Gemini's key is out of every job's reach (Gemini target).** Gemini's target adds Google's credential variables (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_GCA`, `GOOGLE_CLOUD_ACCESS_TOKEN`, `GEMINI_CLI_USE_COMPUTE_ADC`, `GEMINI_CLI_AUTH_OVERRIDE`, `GEMINI_API_KEY_AUTH_MECHANISM`) to the vendor keys relay removes from Claude, Codex and Copilot, whether Gemini is switched on or not: under `child_auth: "login"` and under another target's per-target `"any"`. The global `child_auth: "any"` cross-vendor exception has ended in 1.0; `legacy` does not restore it. Gemini still uses only its configured key file. Every relay-enforced turn (Copilot's) is denied `~/.config/relay-keys`, and a key file `~/.config/relay/local.json` moves elsewhere; Claude's turns may not read them either (its sandbox's `denyRead` and `Read` deny rules), while Codex's still can. No job may be granted, keep a grant over, have a file request approved in, or (Claude) write `~/.config/relay`, `~/.config/relay-keys` or a directory `~/.config/relay/local.json` moves a key file to: a job continued with such a grant (one given by 0.9.x, say) is refused until it is given one that leaves the directory out.
- **Unsafe login-store entries are quarantined after a turn (1.0).** Relay renames offending names and token files into its private `quarantine/<run>/<node>/<turn>/` directory before reporting failure (EXDEV: `.relay-quarantine.<turn>.<name>` inside the store). The result lists moves or loud per-name failures; run `grok login` again before using Grok. Further turns still require a safe store and restored login.

- **Speed.** `speed` is `standard`, `fast`, or `ultrafast` where the target/model/account
  supports it; unset uses the configured target speed or standard (a continuing session
  keeps its own). Faster service costs money or allowance and is requested only when
  the user asks. Codex checks the account catalog before prompting; a fast Claude turn
  that reports standard returns a warning. Launched agents cannot start or continue
  work faster than their own speed. Older Codex/Claude CLIs are now below the tested floor.
- **Extensions.** Claude and Codex jobs/consults may request `extensions: true` when
  the config allowlists skills or MCP servers. Relay asks the person to consent before
  launch; only the person may allow consent, gated server calls or other requests from
  an MCP-bearing session. Skills are filtered and copied per turn; server processes run
  outside the agent sandbox and go through relay's tool gate. MCP-bearing sessions get
  no network, no extra write paths and no relay delegation; incompatible inheritance,
  full-access settings and the Codex exec backend are refused. No extension is inherited
  merely because it exists in the host config. See [extensions](extensions.md).
- **Storage retention.** Defaults keep logs and records indefinitely. `log_max_mb`
  rotates each log to one `.1` file; `keep_records_days` removes inactive, unused
  runs through clean and a worker's daily cleanup. Registry migration backups are never
  deleted by retention and may contain prompts; remove them yourself once rollback is
  no longer needed. Doctor reports usage and warns below 1 GB free.
- **Targets off by default.** Copilot remains off by default and unqualified at 1.0.98;
  opt in with enabled + experimental. Its Free plan's `auto` runs as unknown family,
  it drops relay's tools, and repository skills/hooks load inside relay's sandbox.
  Grok is off by default and unqualified at 1.0.62. Gemini CLI is off by default and
  qualified (the maintainer, 2026-10-22; 0.64.0 and 0.65.0 recorded, its documented residuals accepted):
  opt in with enabled alone, and a `targets.gemini.experimental` kept from before is accepted
  and changes nothing. Its agents
  get relay's tools through Gemini's own tool discovery on any version relay runs, with a
  check at each launch that Gemini ran relay's discovery command (where it did not, the agent is told before its
  prompt and the turn says so); verified live on <!-- verified:geminiToolDiscovery -->0.64.0, 0.65.0, 0.67.0 and 0.68.0<!-- /verified -->, which `relay doctor`
  reports ([gemini.md](gemini.md) §3.8). It runs only with
  `targets.gemini.child_auth: "any"` and the key file of its setup ([gemini.md](gemini.md)
  §4; [security row](security-model.md#per-harness-security)). Neither
  `allow_untested` nor an installed binary substitutes for Copilot's or Grok's experimental opt-in.
