# Relay 1.0 compatibility contract

These are the interfaces relay promises to preserve through 1.x. Additions are allowed;
consumers must tolerate new optional fields, targets, tools and event kinds. A snapshot
change is a compatibility review trigger, not permission to break this contract. Security
fixes may tighten admission or withhold a feature whose preconditions are not met; accepting
a spelling does not promise authorization. Experimental harness behaviour is not qualified.

## MCP tools

The authoritative declarations are [src/mcp/server.ts](../src/mcp/server.ts). The complete
parameter names, JSON types, enums, nested schemas and required lists are checked into
[tools.json](../test/fixtures/stable-surfaces/tools.json). The registered names are:

`adopt`, `approve`, `ask`, `brief`, `cancel`, `confirm`, `delegate`, `discuss`, `merge`,
`permission_prompt`, `result`, `resume`, `review`, `status`.

The schema fixture is part of this document: optional parameters remain optional and
required parameters remain required. Host qualification controls visibility: `confirm`
is offered only where the person's permission prompt is qualified; `permission_prompt`
is a Claude child's host callback, never a public root tool. Adoption is root-only.
Turn policy can withhold delegation tools. A tool's presence never grants authority.
A Gemini agent calls the same tools through Gemini's tool discovery, under the
names Gemini gives them (`discovered_tool_<name>`); the names above are the contract. Which
Gemini versions they were verified on live (`targets.gemini.toolDiscovery.versions`) is
informational, not a surface: they are offered on every version relay runs and checked at each
launch, and the note a turn carries about it is prose.
Tool descriptions, instructions, diagnostic prose and ordering are not machine interfaces.
The MCP content envelope remains text containing a JSON object; result-specific fields
are described in the tools and [usage.md](usage.md). Item IDs, session fingerprints and
request IDs are opaque; do not infer authority or ownership from them.

On a shared deployment (the desktop app's `--desktop` entry, or a `local-agent-mode-*` client),
every root tool that reads or acts on work, all but `brief`, also takes an optional string
`session_token`; [tools-desktop.json](../test/fixtures/stable-surfaces/tools-desktop.json) pins
those schemas. Each differs from the same root tool's schema in `tools.json` by that parameter
alone; `tools.json` also has `permission_prompt`, a launched agent's tool. Dedicated and unknown
deployments do not advertise it. Its replies are additive too: `new_session` (`token`, `carry`)
when relay issues a token, `session_required: true` for a call without one that did nothing, and
`{"error": "Session unavailable.", "recovery"}` for a token relay did not issue. Tokens are
opaque bearer keys (currently `rs1_` and 56 hex digits; do not parse them). `status.session` adds
the scope `conversation-token` and the source `session-token`.

An OpenCode 2 connection (client name `opencode`, any version but a 0.x or 1.x release) is shared too, but takes no
`session_token`: relay scopes each call by the session OpenCode stamps on it
(`_meta["ai.opencode/sessionID"]`), and a call without one is refused (`refused: true`) before
anything is looked up. `status.session` adds the scope `host-session` and the source `host-key`,
and caller snapshots the assurance `host-correlation`. The session ID itself is never returned or
recorded.

Optional `grant.env: string[]` is an additive field on root calls that already accept
a grant (`delegate`, `ask`, `resume`, `discuss`; `review` has no grant parameter). It contains exact names, never values, and every name must be eligible in the
effective `child_env.request`. It requests one-turn person-only consent through the
existing qualified dialog or `confirm` path. Root `approve` (including `user_confirmed`),
child tools and `relay approve` can deny but cannot allow it. A missing qualified person
path refuses before launch. Resumes require fresh consent; grants never imply one another.
Nested jobs receive only their destination's policy and cannot inherit or request a
parent's one-turn disclosure. Consent metadata never stores values or reusable hashes.

Optional `grant.local_network: boolean` (1.0.5) is an additive field on the root calls whose grant
takes `write_paths` (`delegate`, `resume`). It is for Codex write jobs only and needs `network: true`
in the same grant; anything else is refused with a reason. It asks for Codex's network proxy in local
mode (this Mac's loopback and the local network reachable from the job's shell), which only the
person can allow: a person-only request of kind `local_network`, asked before the job's first turn
under the grant and again when a resume changes its `network`, `local_network` or `write_paths`;
a consent ends as soon as the job holds another grant, so a grant toggled away and back is asked
about again.
Root `approve` (including `user_confirmed`), child tools and `relay approve` can deny but cannot
allow it. A missing qualified person path, or escalation off, refuses before launch. A denial
refuses the turn. `ask`, `discuss` and `review` do not take it. Jobs' `grant` views show it when set.

Optional `grant.raw_network: boolean` (stage 2, unreleased) is an additive field on the same calls
(`delegate`, `resume`). It is for Codex write jobs only, needs `network: true` in the same grant and
`codex_backend: "app-server"`, cannot be combined with `local_network`, and is refused unless
`targets.codex.stage2` is on. It asks for Codex's commands to run in relay's own Seatbelt with raw
network (see [Codex raw network (stage 2)](configuration.md#codex-raw-network-stage-2)), which only the person can allow: a
person-only request of kind `raw_network`, asked before the job's first turn under the grant and
again when a resume changes its `network`, `raw_network` or `write_paths`. Root `approve`
(including `user_confirmed`), child tools and `relay approve` can deny but cannot allow it. A
missing qualified person path, or escalation off, refuses before launch. A denial refuses the turn.
Launched agents cannot grant it. Jobs' `grant` views show it when set.

## Configuration

[src/core/config.ts](../src/core/config.ts), `ConfigSchema`, strictly validates files;
unknown keys and wrong types remain errors. [config.json](../test/fixtures/stable-surfaces/config.json)
pins every top-level key, per-target key, routing key and nested MCP-server setting, including
their types and allowed values. `targets` and `default_target` grow with the target registry.
Defaults may change in a minor release when documented in UPGRADING; pin an explicit setting
when its default matters. Config remains JSON, and the existing `RELAY_CONFIG` / `RELAY_HOME`
selection and `targets.<id>` layout remain supported. Credentials in `mcp.json` belong to the
machine, not the synced config; see [extensions](extensions.md).

Release A adds strict `never` arrays `paths`, `ports`, `hosts`, `override_builtin`;
empty/omitted arrays remove nothing. Eligible overrides require an exact ID,
`REMOVE BUILT-IN NEVER <id>` acknowledgment and nonempty reason. Config/install/authority
entries remain non-removable. The registry remains at schema 4, with the cumulative
floor in the run's private `params_json` inside its existing JSON envelope, excluded
from effective config. Request/node views may add `never_policy` hash/version/removals.
The config fixture records the public additions; the registry fixture is unchanged.

`child_env` and `targets.<id>.child_env` are strict objects with `policy`, `pass`,
`drop` and `request`. `policy` is `allowlist` (root default) or `legacy`; the target
value overrides root. Lists contain exact, case-sensitive names matching
`[A-Za-z_][A-Za-z0-9_]*`; root and target lists are unioned and deduplicated.
`drop` wins over baseline, pass and request, and an empty target list clears nothing.
Unknown keys, invalid names/types and attempts to pass/request mandatory scrubs or
relay-owned identities are errors. Backend-owned controls cannot be dropped.
`tool-denylist` is unavailable in 1.0 and rejected with an explanatory validation error;
it may be introduced as an additive value later. `legacy` remains supported through 1.x
and warns on every root load and in doctor. The default changes 0.9.1's unknown-variable
inheritance; see [UPGRADING](UPGRADING.md#tool-token-policy-in-10-w9-2026-10-19).

Global `child_auth: "any"` remains accepted, with a warning pointing to the per-target
form, but no longer admits foreign-vendor credentials. It allows only each target's own
supported auth inputs, also subject to environment selection and mandatory guards.
`legacy` never restores that old cross-vendor exception. Doctor previews each target's
effective policy and included/dropped names with reasons only, never values, URL contents
or value hashes. Standing `pass` is config consent and does not prompt.
Environment filtering does not promise credential-file or keychain isolation.

`targets.codex.daybreak` is an optional boolean accepted only for Codex in the person's
config. Unset leaves it to Codex (its default, or a configuration layer relay does not write;
relay's Codex home is not `~/.codex`); explicit `false` pins Daybreak off.
Tools and grants cannot set it.
On Codex 0.163.0+, exact model slugs advertising `daybreak_blue` in the local Codex
model cache qualify, then the launching server's `model/list` must confirm eligibility;
missing/ambiguous metadata, discovery failure or an unknown model skips Daybreak.
Plain `notes` arrays in status and results report skipped requests without changing
the item's outcome. Before 0.163.0 the key has no effect: enrolled accounts received
Daybreak automatically. Doctor reports the setting, cache eligibility and CLI version.
This is an additive config snapshot change, with no tool parameter or registry change.

`targets.codex.stage2` (stage 2, unreleased) is an optional boolean accepted only for Codex.
Unset or `false` keeps stage 2 off, and `grant.raw_network` is refused. `true` lets a root
session give a Codex write job `grant.raw_network`. Tools and grants cannot set it. An additive
config snapshot change, with the additive tool parameter above and no registry change.

## Deprecation policy

A renamed or removed key, tool parameter or CLI command remains accepted **with a warning
for at least one minor release** after its replacement ships. Release notes identify the old
and new spelling and the earliest removal release. Removing an accepted spelling is a major
version change after that warning interval. No silent reinterpretation is permitted.

The 0.2.0 keys `bin`, `default_model`, `default_effort` and `notify` remain readable throughout
**all of 1.x**. The first three map to `targets.<id>.bin`, `.default_model`, `.default_effort`;
`notify` maps to `desktop_notifications`. Root config load warns on stderr, and `doctor`
prints a warning for every deprecated key. Values are never included in these warnings.
Supplying both spellings of the same setting remains an error, even if the values agree.
`notify` is the only renamed config key; the other three moved into per-target entries.
Comparing the consolidated 1.0 code with `v0.9.1` found no other renamed config key,
MCP parameter, or removed/renamed documented CLI command. The former internal
`codex-preflight` subprocess entry was removed; it was never a documented script interface.
Earlier desktop registrations named `relay` are still recognised and migrated to
`relay-desktop`, with installer/doctor diagnostics; `version`, `-v`, `help` and `-h` aliases
remain accepted. These aliases are not deprecated.

## Registry and migration

[src/core/db.ts](../src/core/db.ts) records **schema version 4** in `PRAGMA user_version`.
0.2.0 registries have version 0; 0.9.x registries have version 1; earlier 1.0 builds have
version 2; 1.0 through 1.0.3 have version 3. Opening any older registry with this build
first makes a consistent `VACUUM INTO` backup beside the registry named
`relay.db.backup-v<old>-<ISO time with colons/dots replaced>-<pid>`, adds missing tables and
columns, then records version 4. A backup failure stops the upgrade before migration;
a registry from a newer schema is refused. Concurrent migration is retried under SQLite
locking. New registries need no backup. [registry.json](../test/fixtures/stable-surfaces/registry.json)
pins the current version and table layouts; [upgrade tests](../test/upgrade.test.ts) exercise
0.2.0 and 0.9.1 fixtures, backup preservation and refusal of a newer schema.

Schema 3 adds three nullable columns to `turns`: `tmp_dir TEXT`, the canonical private
temporary-directory path, and `tmp_dev INTEGER` / `tmp_ino INTEGER`, its device and inode.
Relay records them before launching a confined turn; cleanup requires the same identity,
a settled turn and no remaining recorded live processes. Old turns keep all three `NULL`;
their directories cannot be inferred safely from existing records and remain unswept.
A schema-1 registry receives the schema-2, schema-3 and schema-4 additions in one open: its
`user_version` advances directly from 1 to 4 with exactly one pre-migration schema-1
backup, and every existing row is preserved. These additions change neither the MCP
tool schemas nor the config schema; their fixtures remain unchanged. Schema 3 also adds
nullable `turns.refusal_json TEXT` for the terminal status `refused`; old turns retain NULL
and their original statuses.

Schema 4 (1.0.4) adds one table, `launch_leaders (run_id, leader_pid, kind, node_id,
start, created_at)`, keyed on `(run_id, leader_pid, start)`: the process-group and session
leader pids of the workers and agents relay launches, kept for the run's lifetime and deleted
with the run. The launched-agent check behind `relay approve`, `cancel`, `adopt`,
`clean --forget` and `chat`'s message paths matches a caller's group or session against them
([approve-boundary.md](approve-boundary.md)). `start TEXT NOT NULL DEFAULT ''` is the leader's
start time as `ps` prints it, empty when relay could not read it. It guards against pid reuse:
a leader id matches when nothing is alive at that pid, when the live process's start equals any
start recorded for the pid, or when any recorded start is empty; a live process at that pid
whose start matches none of them is a different process, and since macOS never reallocates a
pid still in use as a group or session id, the old group or session is gone. The start is part
of the key so a pid that leads more than once (within a run or across runs) keeps every start.
The table is empty after a migration; nothing else changes, and a registry of any earlier
version receives it in the same single open with one pre-migration backup. A schema-3 relay
(1.0.3 and before) refuses the version-4 file, so keep the backup for rollback. A version-4
file from a pre-release build of 1.0.4, keyed without `start`, is rebuilt in place under the
current key on first open, every row kept.

The migration promise is forward reading of released registries, not a fixed SQL schema
or permission for an older binary to open a newer registry. Direct table queries in the
cutover procedure are administrative diagnostics. Restore the pre-upgrade backup for
rollback; preserve job branches and worktrees separately. See [UPGRADING](UPGRADING.md).

## Vendor safety stops

`refused` is a terminal node and turn status, distinct from tool denials (`blocked`) and
operational failures (`failed`). Status and result add `outcome: "refused"`,
`refusal: {vendor: "openai" | "anthropic", code: string, message: string}` and
`unfinished: true`; the message is the vendor text, subject to normal redaction.

Claude refusal detection is source-derived from Claude Code 2.1.302 and is not
live-qualified. An unrecognised refusal shape may keep the ordinary harness outcome,
including apparent success.

A refused independent review settles with verdict `unknown` and no reconciliation.
The caller can still submit or skip `own_review` once; a submitted review stands alone under
`sides`, including an empty review and its own verdict/coverage. A refused reconciliation
keeps both original reviews. The [item](../test/fixtures/stable-surfaces/refusal-item.json) and
[review](../test/fixtures/stable-surfaces/refusal-review.json) snapshots pin these fields.

## Events and notices

[src/core/events.ts](../src/core/events.ts) records events; [src/core/watch.ts](../src/core/watch.ts)
projects public events into a root tool reply's optional `events` array. Each entry is:

```json
{"event_id":1,"kind":"settled","item":"j_00000001","about":"j_00000001","notice":"relay (event 1): job j_00000001 finished (done). Call result j_00000001."}
```

`event_id` is a numeric deduplication ID; `kind` is currently `settled`, `approval`, `decided`
or `late`; `item` names the item to inspect; `about` names the subject (often a request).
The notice prefix is `relay (event <event_id>): `, followed by human-readable pointer text.
Do not parse that prose for a decision, command or identity. Events refer only to accessible
runs. A result already reporting the subject can omit its redundant event. Events are marked
seen after delivery; reconnects and overlapping channels can deliver an event again, so dedupe
by ID. This is not an exactly-once queue or a cross-registry ID namespace.

Claude's inbox wire format is newline-delimited JSON: optional
`{"type":"auth","token":"…"}`, then
`{"type":"user","message":{"role":"user","content":"<notice>"}}` and a final newline.
The envelope is a host integration, not authentication of relay as the sender. Notices contain
relay-generated pointers, never agent output or the command an approval request wants.
An event gets at most one notice attempt; failure still leaves it for a tool result.
Decision events go only to tool results. No host inbox token is persisted.
[events.json](../test/fixtures/stable-surfaces/events.json),
[notice.txt](../test/fixtures/stable-surfaces/notice.txt) and
[inbox.jsonl](../test/fixtures/stable-surfaces/inbox.jsonl) pin these formats.

D14 (2026-10-18) tightens the inbox format for authenticity. Its prefix is now
`relay (event <event_id>, tag <32 lowercase hex digits>): `, followed by a sentence naming
the sender (added after 1.0.3; see below), a direction to verify with
`status({notice: {event_id, tag}})` and the pointer text. The optional `notice` parameter has required `event_id` (a positive safe integer) and `tag` (a string of at most
256 characters). Verification accepts only a 32-character lowercase hex tag; other strings
return a failed check. With `notice`, status verifies only and ignores `id` and `wait_s`.
It returns `notice_verification: {verified: true, event: <public event>}` on success;
failure returns `verified: false` with a reason, never the event or the supplied tag.
Unknown events and wrong tags have the same failure response. Ignore failed or untagged
inbox pointers and report them; act only on the verified event. Ordinary status/result
calls and the unsigned `events` schema retain their existing formats.

This is a security tightening of the inbox integration: consumers matching the old unsigned
prefix must migrate, and old inbox pointers must not be trusted. A fresh memory-only key per
server signs the session/run and stored event contents. Ownership must still belong to that
session at verification. Neither keys nor tags are written by relay to its registry, agent
files or logs; the receiving host can retain the notice and tool arguments in its transcript.
Restarted servers reject old tags, and replay of the same valid event is possible: deduplicate
by id, and use ordinary status after a restart. No database or config migration is required.

Fixture review for D14 (every changed line): `tools.json` adds the `status.notice` object, the comma/closure
and optional `status.notice` object, its safe integer bounds, bounded tag string and two required
members. `notice.txt` line 1 changes to the signed prefix and verification direction.
`inbox.jsonl` line 2 carries that same signed notice inside the existing JSONL user envelope;
its auth line is unchanged. `<notice-tag>` is a test-only normalization of the fresh random
tag, not a valid wire tag. The unsigned `events.json` and all other fixtures remain unchanged.

The sender sentence (added after 1.0.3) exists because Claude Code presents every inbox message
as coming from another Claude session. It reads `Sent by the local relay server, not by a Claude
session or by the <harness> agent (<family>) of <kind> <id>.`, naming the launched agent the event
is about (the asking item of an approval, otherwise the session that settled) from relay's registry,
or `Sent by the local relay server, not by a Claude session.` when there is none. It is prose like
the pointer: it is not covered by the tag, is not part of the verified event, and grants nothing.
The prefix is unchanged. Claude Code's documented inbox format has no sender field
([inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket),
read 2026-10-26). The 2.1.309 binary uses an undocumented `<cross-session-message from="…"
from-name="…">` envelope internally and reports `from` and `from_name` in SDK `peer_message_hold`
frames, but its own schema calls them sender-asserted ("a label, not an identity proof"; "a claim,
like `from`"), so relay does not rely on them. Fixture review: `notice.txt` line 1 and `inbox.jsonl` line 2 gain the
sentence, for a Codex job; nothing else changes.

For inbox delivery controls, use Claude Code's `crossSessionInbound` setting; `hold` withholds
and `refuse` drops relay notices too. Neither offers a relay-only sender allowlist. See the
[documented inbound controls](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages).
Doctor reports observed setting values and source files, not another live session's effective
configuration; invisible overrides and runtime changes can differ.

## CLI

[src/cli.ts](../src/cli.ts) and [usage.txt](../test/fixtures/stable-surfaces/usage.txt)
pin `mcp`, `bridge`, `tree`, `chat`, `approvals`, `adopt`, `approve`, `deny`, `cancel`,
`clean`, `install`, `uninstall`, `doctor`, `qualify-codex`, `--version` and their documented flags
(`clean --forget <run_id> [--write]` new in 1.0; `qualify-codex [--version X.Y.Z] [--force]` new in 1.2.1).
`worker` is an internal process entry point, not a supported script interface. So is
`gemini-tools <dir> --list|<tool>` (new in 1.0), the helper behind a confined Gemini agent's own
tool discovery, which runs it through its own entry point ([gemini.md](gemini.md) §3.8): its
arguments, files and output are between relay and that harness.

Workers hold the root's secret values for redaction only. The owning root's broker
sends the values derived by `secretValues` from its captured environment separately
from the selected agent environment, at worker startup and with each turn. Both claims
check the worker's uid, registry-pinned pid and process start time, and root ownership
of the node's run. Workers keep the set in memory only, never write it, never place it
in agent or bridge environments, and never return it in tool results. Worker diagnostic
writes are withheld until startup redaction is available, including housekeeping paths
before any turn. The broker protocol and this in-memory set are internal surfaces.
The `mcp --host <target>` and `--desktop` flags written into installed registrations
remain recognised, even though the concise help omits them. A registration without
`--host` keeps the legacy client-name inference; an invalid explicit host is refused.
Injected child context files and worker arguments remain internal.

Scripts may read:

- `--version`, `-v`, `version`: `relay <package-version>\n` on stdout, exit 0.
- `help`, `--help`, `-h`: usage on stdout, exit 0. Missing/unknown command: diagnostic
  and usage on stderr, exit 2. Usage text is snapshotted so deliberate edits are reviewed;
  consumers should not extract command schemas by parsing its spacing.
- `approvals`: a JSON array of request views, or exactly `no approval requests waiting\n`.
  Request views use the same approval vocabulary as MCP (`request_id`, `from`, `kind`,
  `effect`, `in_directory`, `wants`, plus optional fields).
- `approve`, `deny`, `cancel`, `clean`, `adopt`, and `chat --say`: JSON objects carrying
  the corresponding operation's result. Check the object's `error`/`refused` fields as
  well as process status: historical operation errors do not all set a nonzero exit code.
  Adoption additionally prints an interactive review and requires a TTY before its JSON result.
  `approve` that would *allow* a request now requires an interactive terminal and a one-time code
  the person types back, and refuses inside a relay-launched agent's process tree (the same launched-
  agent refusal `cancel`, `adopt` and `clean --forget` give); the printed prompt is human-readable
  prose, and the final line is the JSON result. `deny` keeps working non-interactively from anywhere.
  A consumer cannot allow a request by piping to `relay approve`. See
  [approve-boundary.md](approve-boundary.md).
- `clean --forget <run_id> [--write]` (new in 1.0): one JSON object. An unknown run has `error`,
  and a refusal `refused: true` with `run_id` and `reason`; each exits 1. Otherwise exit 0,
  with `run_id`, `dry_run`, `forgotten`, `registry_rows` (`items`, `turns`,
  `approval_requests`, `events`), `relay_files` (paths), `branches_not_touched` and `note`,
  and, when there are any, `left_alone` and (with `--write`) `left`. `reason`, `note` and the
  entries of `branches_not_touched`, `left_alone` and `left` are prose. A missing or second run
  id, or a flag other than `--write`, is a usage error (exit 2), as is a launched agent's
  environment. Without `--write` it writes nothing to the registry and signals no process.
- `clean` itself takes at most one run id and no flag but `--forget`'s: another argument,
  `--forget=<run_id>` among them, is a usage error (exit 2) that cleans nothing (new in 1.0;
  0.9.1 ignored every argument starting with `--` and every run id after the first, and
  cleaned every run for `--forget=<run_id>`).
- `chat --print`: the stored transcript, or `(no transcript yet)`. Transcript contents
  are agent-authored text. `tree` is human-readable; `tree --watch` uses terminal escapes.
- `doctor`: exit 1 for a failed requirement, exit 0 when there are only warnings or none.
  Install/uninstall remain dry-run-first and require `--write` to change host registrations;
  `clean --forget` likewise changes nothing without `--write`.
  Doctor/install prose, paths, timestamps, tree drawing and transcript prose are not stable
  parsable fields. Existing install-output snapshots review their whole text separately.

MCP stdout contains only protocol traffic; load warnings go to stderr. `bridge` forwards
that protocol to a per-turn socket; socket paths and internal worker arguments are private.

## Supported versions and qualification

Node **≥24.15**, macOS only. Claude Code **≥2.1.302** and Codex CLI **≥0.163.0** are the
recorded tested floors ([target definitions](../src/targets/index.ts)); the speed protocol
was checked at those versions. Later versions are admitted, not a claim of a new qualification;
Codex CLI 0.164.0 was also checked (2026-10-23, at standard speed), and doctor names it; the floor
stays 0.163.0. Codex CLI releases on which relay's Codex route has been checked since (its source
and live, by hand or by the maintainer's release watcher): <!-- verified:codexCli -->0.163.0, 0.164.0, 0.167.0, 0.167.1, 0.167.2 and 0.170.0<!-- /verified -->.
`allow_untested` permits older/unreadable CLI versions and non-macOS platforms, explicitly
unverified. Doctor reports the recorded macOS releases **27.0, 27.0.1, 27.2 and 27.2.1**, sourced from
the [Copilot run](qualification/copilot-1.0.98.md) and
a Seatbelt prototype run (27.0, 27.0.1; not published), and for 27.2 from Codex
0.167.0's pin qualification, 32/32 on two Macs (2026-11-07), and the release checks, items
1-33, passed at `f67f622` (2026-11-08), and for 27.2.1 from the full release
gate chain (suite, items 1-33, live rounds, red team, claude-floor) at `b9f1eaa`
(2026-11-16); it warns for any other version or
when its version cannot be read. Those records cover different checks, not a complete
host-by-version matrix on both systems.

An ACP harness is supported only at versions with a completed qualification record.
Copilot 1.0.98 and Grok 1.0.62 currently have `qualified: false`, are off by default, and
require `targets.<id>.experimental: true`; `allow_untested` cannot substitute for that opt-in.
Gemini CLI, recorded at 0.64.0 and 0.65.0, is the one qualified ACP target (the maintainer, 2026-10-22):
off by default, it needs `targets.gemini.enabled` and no `experimental` (one a config still sets
is accepted and changes nothing), and also its per-target `targets.gemini.child_auth: "any"`,
since it signs in only with an API key ([gemini.md](gemini.md)).

## Updating the fixtures

```sh
npm run build
RELAY_UPDATE_SNAPSHOTS=1 node --test test/stable-surfaces.test.ts test/install-snapshots.test.ts
```

Review the fixture diff, this contract and UPGRADING together. Regeneration does not
replace the migration, visibility, authority or behavioural tests.
