# Relay-owned Codex runtime (PC)

`targets.codex.home` defaults to `~/.local/share/relay-codex-home` and
`targets.codex.pin_store` to `~/.local/share/relay-codex-pins`. Both accept absolute
paths or `~/...`. `targets.codex.pinned` defaults to `true`, including before
bootstrap and for older saved configurations. `false` explicitly selects the
configured `targets.codex.bin`; there is no automatic fallback based on store
presence. A missing store or missing or malformed `current` fails
closed and names `scripts/codex-qualify/codex-qualifier.mjs`.

At launch, Relay reads `current` once, validates its relative version/digest
target, sealed publication, manifest fields and executable SHA-256, and copies
the absolute versioned executable into the turn's configuration. Its version
probe, MCP discovery, preflight, app server, executor and archive client all use
that path. A later promotion affects the next turn only. Runtime validation
trusts the qualifier's manifest; it does not repeat codesigning or qualification.

Every Codex turn uses the configured home, overriding inherited `CODEX_HOME`.
Relay creates it with mode 0700 and atomically replaces `config.toml` with its
own deterministic configuration (`cli_auth_credentials_store = "file"`). Equal
content is left untouched. Nothing is copied from interactive Codex. `AGENTS.md`
is never read or rewritten. Login is a separate, person-run setup step. Doctor
reports the home, selected pin and login metadata: it only lstats `auth.json`,
requiring a regular file with mode 0600, and never opens that file.

Skill sources remain in the person's original root environment:
`$CODEX_HOME/skills` (or `~/.codex/skills`) and `~/.agents/skills`. Consent resolves
those roots before launch, and Relay gives the runtime filtered copies through a
per-turn extra skill root. `targets.codex.home` supplies runtime config and login,
never the source catalog. Any skills the runtime finds in that home, shared user
roots or the repository are disabled unless they are Relay's consented copies.

The default, current machine and saved run credential homes are denied for reads and writes in
every Relay Seatbelt mode, native Codex permissions and Claude's sandbox and
file-tool rules. Their pin stores stay readable/executable
and are write-protected as whole trees, including staging and pointer entries.
Both kinds of root are excluded from new and retained write grants, file
requests and path requests, including ancestors, descendants and aliases. A
turn's saved config also supplies its protections if machine config changes.
The native Codex profile is checked by the existing exact config readback.

Native Codex's existing ordinary outside-sandbox approval path preserves denied
reads but grants writes across `/`; it cannot preserve the pin store's read-only
entry. PC therefore declines such requests before asking the supervisor, including
when `pinned: false` selects a legacy binary.
Requests with fully understood, explicit absolute path additions may proceed
only when they do not overlap either protected root; network-only additions
retain the filesystem profile. Stage-2 requests continue through the executor's
hard denials. `allow_dangerous` remains the existing explicit sandbox waiver.
Turning pin selection off does not waive runtime-root protection.

## Validation and person-run checks

New tests use scratch stores and homes. `test/codex-pin.test.ts` covers selection,
promotion during a turn, invalid manifests and executable digests, home/config
idempotence, AGENTS preservation, metadata-only doctor output without CLI
fallback, native readback, approval confinement, grants and generated profiles.
The config snapshot in `test/fixtures/stable-surfaces/config.json` was deliberately
updated for `home`, `pin_store` and `pinned`. Daybreak and runtime-config doctor
fixtures use the owned home; consent and doctor skill-source fixtures keep the
person's roots.

Sandbox validation on the completed branch: TypeScript compilation passed;
101 distinct focused tests passed and the opt-in host test skipped. The passing
selections were PC (16), native permissions/readback (6), environment policy (8),
stage-2 gates (21), Seatbelt generation (15), broker/executor lifecycle and policy
(10), stable schema (1), doctor's owned-home configuration/Daybreak checks (4),
fake-CLI initial/resumed environment launches (6), native subagent/approval handling (10),
and shell environment policy launches (4). The full suite was not run.
The coordinator's subsequent outside run on `9f24df5` reported 320 tests: 299
passed, three extension-skill tests failed, and 18 live tests skipped. The
failures came from fixtures incorrectly moved into the runtime home: source
resolution refused before a job id or consent request existed. The fixtures
are restored to personal roots, runtime catalog expectations account for the
separate home, and failed delegates are asserted immediately before waiting.
Four new model-free pinned-launch cases cover named/user skills under default
and custom personal homes, duplicate-source precedence, owned-home decoys, and
missing/extra-skill launch refusals. These are included in `codex-pin.test.ts`.
The follow-up passed 22 focused tests in the delegated sandbox: all 20 PC tests,
the source-resolution/package test in `extensions.test.ts`, and doctor's extension
report test. TypeScript compilation/typecheck and diff checks passed. The three
reported consent integration cases still require the coordinator's outside rerun.
One escalation integration test was attempted and blocked before startup by the
outer sandbox (`mkdtemp /Users/Shared/relay-test-...: EPERM`); no loopback listener
or agent was started by that attempt. It needs the outside commands below.

The WIP's schema snapshot additions for `home`, `pin_store` and `pinned` were
deliberately retained and verified. Its launch plumbing, generated home config,
manifest validation and scratch fixture seams were retained. The completion
adds fail-closed defaults, current-plus-saved protection sets, grant and file
request checks against saved roots, metadata-only auth detection assertions,
and executable/publication/symlink regressions. Scratch tests unseal and remove
their own trees. The temporary dependency symlink is removed before handoff.

The delegated sandbox cannot verify kernel Seatbelt behavior or bind loopback.
No live test, model request, login, real credential home or real pin store was
used. Run these outside that sandbox after applying the branch:

```sh
npm run build
node --test --test-concurrency=1 --test-timeout=60000 test/codex-pin.test.ts test/native-subagents.test.ts
node --test --test-concurrency=1 --test-timeout=600000 test/claude-children.test.ts test/daybreak.test.ts test/extensions.test.ts test/escalation.test.ts test/codex-network.test.ts test/codex-subagent.test.ts test/consent.test.ts test/approval-dialogs.test.ts
node --test --test-name-pattern='^BB:|^executorEnv:|^executorPolicy:' test/stage2-executor.test.ts
```

The approval-transport stub now models generic requests as input to an already
running terminal (`writeStdin`), which adds no filesystem authority. Explicit
command-addition scenarios still send the protocol's command requests. Their
integration expectations now require absolute path additions and auto-denial of
unknown additions; the separate PC stdio fixture covers broad command refusal.
These integration scenarios were updated but could not run here because their
harness needs loopback. The lead must run them before merging.

The new opt-in host test is model-free, file-only and uses writable scratch
fixtures so chmod cannot supply the protection being tested. Supply a separately
staged qualified Codex executable, outside the real credential and pin stores:

```sh
RELAY_PC_LIVE=1 RELAY_PC_CODEX_BIN=/absolute/path/to/staged/bin/codex \
  node --test --test-concurrency=1 --test-timeout=300000 test/codex-pin-live.test.ts
```

It checks ACP NETWORK_ON/OFF, the stage-2 profile and native Codex's profile:
credential reads/writes fail; store reads/exec succeed; manifest/staging/pointer
writes and store renames fail; a control write succeeds. It opens no network
listener and probes no port. The test is skipped unless explicitly enabled.
