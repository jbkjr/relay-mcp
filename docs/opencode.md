# OpenCode and relay

OpenCode (github.com/anomalyco/opencode, the `opencode` CLI) is a multi-model coding agent. It can
meet relay in two ways: as a **host**, an MCP client whose sessions call relay's tools, and as a
**target**, an agent relay launches over the Agent Client Protocol (`opencode acp`). The host works
today ([install.md](install.md#opencode), "OpenCode"); the target does not exist yet (below).

## 1. OpenCode as a host

### What was checked, 2026-10-26

On a Mac with macOS 27.0, OpenCode 2.1.4 from Homebrew core (`brew install opencode`; GitHub's
"latest" release is still the 1.19 line, while the v2 tags, 2.1.4 of 2026-10-23 included, are what
Homebrew packages). Relay's 1.0.3 development build ran from a worktree with scratch state
(`RELAY_HOME`, `RELAY_CONFIG`, `TMPDIR` in a scratch directory), registered in a scratch repository's
`opencode.json`;
`HOME` stayed real so that Claude Code and Codex used their stored logins. The OpenCode model was
`opencode/big-pickle`, one of OpenCode Zen's free models, which needs no key or account.

What OpenCode sends, from a logging stub server:
- `initialize`: protocol `2025-11-25`, `clientInfo` `{"name": "opencode", "version": "2.1.4"}`,
  capabilities `elicitation` (`form`, `url`) and `roots`.
- Every `tools/call`: `_meta` `{"ai.opencode/sessionID": "ses_…", "progressToken": n}`.
- **One MCP process serves every session of the background service** (two `opencode run` sessions,
  one stub pid, two session IDs). `--standalone` runs a private server instead.
- Server `instructions` reach the model (OpenCode's `McpInstructions`). MCP tools are called from
  code through OpenCode's `execute` tool (`tools.relay.ask({...})`), after a `search` for them.
- MCP execution timeout: 12 hours by default (`packages/core/src/mcp/client.ts`,
  `DEFAULT_EXECUTION_TIMEOUT`), so relay needs no wait cap for OpenCode.

Runs through relay (before the scoping change below):
- `ask` with no target: refused, "relay cannot tell which family of model this session runs…",
  naming claude and codex and `default_target.unknown`. As designed.
- `ask` with `target: "codex"`: answered; `families` caller `unknown`, launched `openai`, relation
  `unknown`, note naming client `"opencode"`.
- `delegate` with `target: "claude"`, `mode: "write"`, then `status` (wait) and `result`: done in
  11 s, a commit adding exactly the asked function on `relay/<job>`; not merged.
- **The defect:** that job landed in the run the earlier `ask` (another OpenCode session) had
  made, and a third session read the first session's thread with `status`. Every OpenCode session
  of a service shared one relay scope.

### How relay identifies an OpenCode root

- **Family:** unknown. OpenCode's client name is the same whatever model a session runs, and
  `_meta` carries no model. Sessions name a target or the person sets `default_target.unknown`
  (family steering's rules for unknown callers, unchanged). Relay does not try to read OpenCode's
  model: that would be a lookup in OpenCode's own state, not evidence relay can check.
- **Scope:** a client named `opencode` makes the process host-keyed (`Instance.hostKey`), unless
  its version is a 0.x or 1.x release (`opencodeLegacy`): OpenCode's own builds also report `local`,
  `unknown` and `0.0.0-…` (its beta and dev channels), which are 2.x code. Each scoped call acts as the view of the session its
  `ai.opencode/sessionID` names, made by the same machinery as the desktop app's session tokens
  (`sessionView`, `SessionViews`). The view's owner is a hash of the process's own random token,
  the key kind and the session ID (`hostSessionOwner`), so the ID separates sessions within the
  process and grants nothing to another process: OpenCode keeps session IDs in plain text in its
  database and logs. After a restart, earlier runs are orphans, recovered by the person with
  `relay adopt` exactly as for a dedicated session. A scoped call with no stamp is refused before
  anything is looked up; a malformed one gets the same reply as other malformed session metadata.
  `brief` reads no work and answers either way.
- **Approvals and dialogs:** unchanged. `hostProfile` gives OpenCode `elicit: "no"`, so relay asks
  no one through OpenCode; the session's agent answers with `approve`, the person with
  `relay approve`. A person-only request cannot be allowed from OpenCode.
- **OpenCode 1.x** sends no stamp and keeps the unqualified single scope.

Tests: `test/opencode-host.test.ts` (two sessions over one connection; events; unstamped and
malformed calls; restart and adoption; 1.x).

### Notes for scripting OpenCode

- `opencode run` reads stdin when it is not a terminal, and waits for it to close: give it
  `</dev/null` in scripts, or it hangs before making a session.
- The background service reads configuration at start; `opencode reload` or
  `opencode service restart` picks up a new MCP server.
- `opencode run --format json` prints one JSON event per line; tool parts carry the code the model
  ran and the tool's output.

## 2. OpenCode as a target (`opencode acp`): designed, blocked

**Verdict (2026-10-26, OpenCode 2.1.4): not tractable as OpenCode stands.** Its ACP layer fits
relay's driver well (below), but three properties of how `opencode acp` is built cannot be confined
by relay's sandbox without giving up what that sandbox promises. Nothing of the target is
implemented; this section is the design to build once OpenCode changes, and the checklist to
qualify it.

Sources: OpenCode 2.1.4's source (tag `v2.1.4`, `68bc26b7`), read in full for the ACP path, with
the points that decide the verdict re-read by the coordinating session; one `opencode acp`
handshake (`initialize`, `authenticate`, `session/new`, no key, no prompt) with scratch `HOME` and
XDG directories under `env -i`. Paths below are in OpenCode's repository. Fuller notes, with a
citation for every claim, were kept beside this work and are summarised here.

### 2.1 The blockers

1. **The key cannot be handed over in-band.** `opencode acp` offers one auth method,
   `opencode-login` ("Run `opencode auth login` in the terminal"), and `authenticate` checks the
   method id and returns `{}`, ignoring its params and `_meta` (`packages/cli/src/acp/service.ts`,
   `authenticate`; seen: `{"methodId":"opencode-login","_meta":{"api-key":"x"}}` → `{}`).
   `session/new` reads only `cwd`, `additionalDirectories` and `mcpServers`. OpenCode takes a
   provider key only from its environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), its SQLite
   database (which imports a legacy `auth.json`), or its config (`apiKey`, or `{env:…}`/`{file:…}`
   substitution). And an environment key reaches every command the agent runs: the shell tool
   starts commands with the server's whole `process.env` (`packages/core/src/shell.ts`,
   `Shell.create`), and stdio MCP servers inherit it too (`packages/core/src/mcp/stdio.ts`). That
   fails Gemini's requirements outright (docs/gemini.md §2.1 item 4, §2.4), where even a key in the
   harness's start-up environment, unseen by its commands' own environments, was rejected.
2. **The harness is two processes talking HTTP over loopback TCP, on a port no one can pin.**
   `opencode acp` always starts a private `opencode serve --stdio --port 0` and drives it over HTTP
   at `127.0.0.1:<port the OS picked>` (`packages/cli/src/services/standalone.ts`; the arguments
   are fixed, and `acp` takes no `--server` or port option). The tools run in that server, so it
   must be inside relay's sandbox. Relay's profile allows no listening socket and denies loopback
   TCP even with the network on (`src/confine/seatbelt.ts`, `NETWORK_ON`; only the turn's proxy
   port is allowed). Seatbelt cannot allow one port chosen at run time, so the only profile that
   runs it opens every loopback TCP service on the Mac (other projects' dev servers, databases, a
   Docker API, other turns' servers) to the agent's commands.
3. **The server's password is in its start-up environment.** `serve` authenticates every request
   with HTTP basic auth, and the password reaches it as `OPENCODE_PASSWORD` in its exec-time
   environment (`standalone.ts`, `command`; the server deletes it from `process.env` after reading
   it, but the exec-time block keeps it). Relay's profile lets a turn's processes read the
   start-up environment of the turn's other processes (`process-info*` with `target same-sandbox`;
   docs/gemini.md §2.4 saw a Gemini command read Gemini's this way). For OpenCode's Bun processes
   this is inferred from the same rule, not yet seen (checklist item 2). With the password, the agent's commands drive
   their own server: read its config and stored credentials, key included
   (`packages/server/src/handlers/config.ts`, `credential.ts`), answer their own permission asks,
   change the session's permissions, add MCP servers, and start sessions on any model the server
   offers. None of that widens relay's sandbox, but relay's approval path and its family label
   would both become advisory.

A fourth point is serious but could be closed by relay's own configuration:

4. **Model reporting.** OpenCode reports the *selected* model (the session's `model` config option,
   and `config_option_update` when it changes), never the model that ran: no
   `current_model_update`, nothing in the prompt's response, and the translator drops the
   `session.step.started` events that do carry it (`packages/cli/src/acp/translate.ts`). Two
   paths run other models unseen: the `subagent` tool takes a `model` argument
   (`packages/core/src/tool/plugin/subagent.ts`), and title generation picks a small model of the
   same provider (`packages/core/src/session/context.ts`), which on an aggregator (OpenCode Zen,
   OpenRouter) can be another family. Relay's config could deny `subagent`, disable the `title`
   agent and allow one provider by policy, but nothing inside the turn can carry that closure:
   the agent's commands can drive the server (blocker 3), and they can write the session's own
   permission rules into OpenCode's database, which must be writable for resume and which OpenCode
   merges after the agent's rules, last match winning (`packages/core/src/permission.ts`,
   `configured` and `evaluate`; cross-family review `r_d175fea4`, X1). So until OpenCode reports
   every model that ran (change 3 below), relay could label OpenCode turns only family unknown.

**Relay-side ways round them, considered and rejected:**
- Opening loopback TCP in the profile: it hands every local TCP service to the agent (2).
- Denying same-sandbox `process-info`: unverified whether Bun and OpenCode run without it, and it
  answers only (3).
- Running `serve` outside the sandbox: the agent's tools run there, so nothing would be confined.
- A key file named by `{file:…}` in relay's injected config and deleted once `session/new` has
  answered: the key would stay readable over the server API through (3), and a config reload after
  the deletion would substitute an empty string (fails closed, but unverified when reloads happen).

**What would unblock it** (upstream changes to ask OpenCode for, in order of value):
1. `opencode acp` serving its own sessions without a TCP server: in-process, or `serve` over a Unix
   socket at a path the caller names (relay would put it in the turn's private directory, which its
   profile already allows), with the credential handed over the lease pipe rather than the
   environment. That settles 2 and 3 together.
2. A provider key taken in `authenticate` (`_meta`, as Gemini CLI takes `api-key`), kept in memory,
   and kept out of the shell tool's and MCP servers' environments. That settles 1.
3. `current_model_update` (or the model in the prompt response's `_meta`) for each model that ran,
   from `session.step.started`, subagents and title generation included. That settles 4, and is
   required for any family label other than unknown: in-turn configuration cannot settle it.

### 2.2 What already fits

- **A private server per process.** `opencode acp` never uses the shared background service or
  `service.json`, whatever is running (seen: a running `opencode serve --service` was ignored).
- **Every state root relocatable:** `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/
  `XDG_CACHE_HOME`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DB` (a per-item database keeps sessions for
  resume), `TMPDIR`, and `OPENCODE_TEST_HOME` (honoured in production code) for what it takes as
  home. No keychain use anywhere in the CLI, core, server or util packages.
- **Relay's own config injectable** as `OPENCODE_CONFIG_CONTENT`, ranked above user and project
  files and below only system-managed ones; switches by environment for project config
  (`OPENCODE_DISABLE_PROJECT_CONFIG`), Claude Code's skills (`OPENCODE_DISABLE_CLAUDE_CODE`), the
  models.dev fetch (`OPENCODE_DISABLE_MODELS_FETCH`), keyless Zen models
  (`OPENCODE_DISABLE_FREE_MODELS`) and the file watcher (`OPENCODE_DISABLE_FILEWATCHER`).
- **Models set and refused over ACP:** `session/set_config_option` with `configId: "model"` and a
  `provider/model` id; an unknown id is refused (seen: `-32602 … model not found`). No
  `session/set_model` (seen: method not found).
- **Approvals over `session/request_permission`**, offering `allow_once`, `allow_always` and
  `reject_once`, with the tool's own `rawInput` and `locations`.
- **Relay's bridge loads:** stdio and HTTP MCP servers from the client are accepted (SSE is not),
  unlike Copilot 1.0.98.
- **Sessions:** `session/load` (with replay), `session/resume`, `session/cancel` (answers
  `stopReason: "cancelled"`).
- No telemetry by default, no LSP downloads (2.1.4 has no LSP runtime), no update check on the ACP
  path.

### 2.3 The design, for when it is unblocked

A target `opencode` (`vendor: null`, judged per model like Copilot), `confinement:
"relay-enforced"`, `approvals: "acp"`, `escalation: false`, `login: "key-only"`, off by default and
experimental until a qualification run. Launched as `opencode acp`.

- **State.** A harness home per item under relay's harness directory, as Copilot's: XDG
  directories and `OPENCODE_CONFIG_DIR` inside it, read-only to the agent but for the database
  (`OPENCODE_DB`, kept for resume, checked to be a plain file as Copilot's `session-state` is) and
  a per-turn directory for logs, cache and `TMPDIR`. HOME is the driver's default fresh temporary
  home (OpenCode needs no keychain), which is what keeps `~/.agents/skills` (it has no switch) and
  `~/.claude` from loading; `OPENCODE_TEST_HOME`, a test hook OpenCode happens to read in
  production code, could back that up but is not to be relied on. Bun extracts native
  libraries to `$TMPDIR/.bun-*.dylib` and maps them: the profile must allow that in the turn's
  temporary directory (to verify).
- **Everything inside the turn is the agent's.** OpenCode's database (session permission rules
  included), its server API and its in-memory state are in the same sandbox as the agent's
  commands, so relay treats them as agent-controllable: they may steer what OpenCode asks, never
  what relay enforces or how it labels the work (review `r_d175fea4`, X1).
- **Relay's config** (`OPENCODE_CONFIG_CONTENT`), as defaults for an honest agent, not as
  enforcement: `permissions` `external_directory * ask` on top of OpenCode's default allow (granted
  directories then re-allowed as ACP `additionalDirectories`) and `subagent * deny`;
  `agents.title.disabled: true`; `policies` allowing `provider.use` for the chosen model's provider
  only (policies come from configuration, not the database; whether the agent can change them at
  run time is to verify); `websearch: false` (its keyless search goes to third parties);
  `snapshots: false` (a shadow git repository of the worktree in OpenCode's data directory);
  `update: "disable"`. Environment: project config, Claude Code compatibility, the models fetch,
  free models (unless the model is one of them) and the file watcher off; every `OPENCODE_*`
  variable scrubbed and set by relay.
- **Credentials.** Key-only, opt-in per target with `targets.opencode.child_auth: "any"`, one key
  file per provider kept as Gemini's is (`~/.config/relay-keys/<provider>-api-key`, the same checks,
  the same denials for every confined agent), handed over in `authenticate` once OpenCode takes it
  there (2.1, change 2). Every other vendor's keys scrubbed as for every target.
- **Family per model.** A reviewed table of `provider/model` ids, first-party providers only
  (`anthropic/…`, `openai/…`, `google/…`, `xai/…`); aggregators and Zen's free models (no stated
  vendor) labelled unknown, run only under `same_family: "allow"`. The model set with
  `set_config_option` and read back from the session's config options before the prompt;
  `config_option_update` treated as a model switch. The table applies only once OpenCode reports
  every model that ran (2.1, change 3); until then every OpenCode turn is labelled unknown.
- **Approvals.** OpenCode's asks name the tool's call, not which of its permissions asked
  (`external_directory` or `shell`), and take `locations` from the tool's input: a shell
  `cd /outside && …` would name its working directory, not `/outside`. So, as for Copilot's path
  checks: an ask for a call announced as `edit` is a write, `read`/`search` a read, anything else
  `read or write` (writing where that matters); read jobs refuse anything but reads unasked; the
  sandbox stays unchanged whatever is decided. Relay answers `allow_once` or `reject_once` only,
  never `allow_always`, which OpenCode saves to its database for the project. A rejection rejects
  every other pending ask of the session.
- **Network.** `apiHosts` per provider (`api.anthropic.com`, `api.openai.com`,
  `generativelanguage.googleapis.com`, `api.x.ai`; `opencode.ai` for Zen). The codemode `execute`
  tool's `fetch` and `webfetch` reach any URL the proxy admits.
- **Cancel.** `serve` runs in its own process group and shell commands are spawned detached;
  background shells and subagents outlive a cancelled prompt. Relay must kill every process of the
  turn's sandbox, not the `opencode acp` group alone.
- **Relay's tools.** Through the bridge in `session/new` (`relayTools: true`, to verify).

### 2.4 Review

Cross-family review `r_d175fea4` (Codex, 2026-10-26; discussion `d_518962b6`) of the host change
and this section agreed: C1 (major) OpenCode builds that report `local`, `unknown` or `0.0.0-…` as
their version were left in the shared scope, fixed by keying every OpenCode client but a 0.x or 1.x
release (`opencodeLegacy`); X1 (major) the design relied on OpenCode permission rules the agent can
rewrite, fixed above; C2 (minor) the Bun start-up environment read is inferred, marked; X2 (minor)
the network check, corrected; C4 (nit) the README now says a parent session cannot supervise its
subagent's relay jobs. C3 was dropped.

### 2.5 Qualification checklist (when unblocked)

Most of this needs no key: OpenCode Zen's free models (`opencode/big-pickle`) run with none, through
`opencode.ai`, and are labelled family unknown. Only item 1 needs a provider key, which the maintainer would
create (relay's sessions do not create accounts or keys).

1. **Model:** a named first-party model is reported exactly before the prompt; a mid-turn switch
   (`config_option_update`) is seen and handled; every model that ran is reported (title and
   subagent runs included), also after the agent's commands rewrite the session's permission rules
   in OpenCode's database or call its server, mid-turn and across a resume.
2. **Key:** handed over in `authenticate` only; not in any environment block (a command reading
   `ps eww`/`kern.procargs2` of every turn process finds it in none); not readable over the
   server API by the agent; redacted if quoted back.
3. **No loopback exposure:** a turn's command cannot connect to a loopback TCP service outside the
   turn (a decoy listener), and cannot reach its own server's API.
4. **What loads:** no user or project config, MCP servers, plugins, skills (`~/.agents`,
   `~/.claude`, project `.claude`/`.agents`) or instructions beyond what relay names; the
   repository's `AGENTS.md` decision recorded.
5. **Writes:** nothing outside the worktree, granted directories, the turn directory and the item's
   database; `~/.local/share/opencode`, `~/.config/opencode` and `~/.local/state/opencode` unchanged
   (modification and change times before and after).
6. **Relay's tools** load through the bridge and work (an `ask` from the agent).
7. **Approvals:** an outside write reaches the root as a request, `allow_once` only, the sandbox
   still refusing; a read job refuses writes unasked; a rejection ends or continues the turn as
   recorded.
8. **Read job, write job and merge, resume (`session/load` and `session/resume`), cancel** with no
   process left (background shells included).
9. **Network:** without a network grant the proxy admits only the provider's API host; `webfetch`
   and `execute`'s `fetch` to any other host fail. The proxy tells destinations apart, not model
   requests from tool requests, so a tool's fetch to the provider's host succeeds: a stated
   residual, as for every relay-enforced harness.

### 2.6 What a tester can do today

Use OpenCode as a **host** (section 1, and [install.md](install.md#opencode)): an OpenCode session delegates to, consults,
discusses with and reviews against Claude Code and Codex, which relay launches as usual, confined
and on their own logins. OpenCode cannot be a target: a Claude Code or Codex session cannot hand
work to OpenCode through relay.
