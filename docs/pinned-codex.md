# Pinned Codex

Relay runs Codex only from a **qualified pin**: a copy of a Codex release that relay downloaded
and verified, whose run under relay passed the stage-2 qualification, kept in a store that
launched agents cannot write. The qualification is either your own (`relay qualify-codex`, a
**local** pin) or the maintainer's, shipped with the release (a **shipped** pin, below). Until
there is one, relay refuses every Codex job (`relay doctor` says so under "codex pin"). It never
falls back to the Codex on your PATH.

## Qualifying once: `relay qualify-codex`

```sh
relay qualify-codex                    # npm's latest Codex
relay qualify-codex --version 0.169.0  # a release of your choice
```

Run it from a terminal in your own desktop login. It refuses to run inside an agent relay
launched, and the qualifier refuses outside a desktop (Aqua) session, such as over SSH.

It runs the same qualifier as the LaunchAgent below, with the same checks:

- It downloads the release and its source.
- It verifies npm's integrity, Apple's signature, OpenAI's Team ID and the exact version.
- It runs relay's model-free stage-2 qualification against the release. This step takes about an hour and a half.
- It promotes the release into the pin store only when every item passes.

The pin store is `targets.codex.pin_store`, by default `~/.local/share/relay-codex-pins`.

When it finishes, it prints what was checked and where the pin is. Then it asks relay which Codex
it would now run, and prints relay's answer. It exits 0 only when relay would run a qualified pin.

`--force` retries a release whose exact inputs failed before; every check still runs.

The command runs from the relay that `relay` runs from: an npm install, or a git checkout after
`npm run build`. The pin names relay's build identity (see below), not a git commit, so it needs no
`.git`, and a checkout with local changes is qualified as what it is. After you update or edit a
checkout, run `npm run build` before qualifying: the qualifier runs the build in `dist/`, never the
sources.

### Relay's build identity

A pin records which relay it was qualified with as `relayBuild`: relay's version and one SHA-256
over the build a qualification exercises ([build-identity.ts](../src/core/build-identity.ts),
scheme `relay-build-v2`). The build is `dist/`, `npm-shrinkwrap.json`, `scripts/codex-qualify/`,
the stage-2 test files the qualification's cases run with the test modules, fixtures and stubs they
load, and the two red-team oracle modules one of them imports; `package.json` ships each of them in
its `files`. Every regular file under those paths is hashed in sorted path order, as
`<path>\0<sha256>\n` after the line `relay-build-v2\n`; names npm never packs (dotfiles,
`node_modules`, `*.orig`) are left out alike, and a symlink or special file is refused. A git
checkout and an npm install of the same build therefore name the same identity.

`npm-shrinkwrap.json` is relay's dependency lock: exact versions and sha512 integrities for relay's
whole dependency tree, so an identity, and a pin that names one, also names relay's dependencies.
`npm ci` in a checkout installs exactly what it names. An npm install reads a package's shrinkwrap
only when the registry marks the version as having one (`_hasShrinkwrap`, which it sets for a
published package that ships one, not for a local tarball), so `package.json` also names each of
relay's direct dependencies at exactly its locked version, which npm installs either way. Relay
then checks what it would actually load: it walks its runtime dependency graph, finds each package
as Node would (from the package that requires it) and its entry in the lock as npm lays it out, and
requires the same version for every one, transitive dependencies included (dev-only entries are
never reached). The qualifier refuses to run otherwise (run `npm ci`). Under a shipped pin, relay
refuses to run Codex otherwise (reinstall relay), both when the dependencies the process loaded at
start drifted and when the ones on disk now do. `dist/build-info.json` is part of `dist/`: it records the commit the build was
made from and when, so every build has an identity of its own, even of the same commit. Everything
else in the build is reproducible from its sources (the native helper is linked under a fixed name,
since its ad-hoc signature carries that name).

Builds before the lock was added wrote `relay-build-v1`, the same files without it. A local pin or failure record
that names a v1 identity is still read as a record of what it ran with, and a local pin keeps
working. A v1 identity never equals a v2 one, though: a recorded failure under v1 is qualified
again, and a shipped pin that names v1 is refused (a release must be qualified with the build it
ships). Node will not strip TypeScript types under
`node_modules`, so the qualifier copies the build to its scratch directory, checks the copy's
identity against the source's, and runs stage 2 from the copy; before promoting, it checks that
neither the source nor the copy changed during the run.

Pins written before build identities record the relay commit they ran from (`relayCommit`) and
keep working: a local pin was never bound to the relay running it, only to its own Codex binary
and the evidence of its qualification, and that is unchanged. `relay qualify-codex` describes
either kind.

After the first pin, sign in once with relay's own Codex home. `relay install codex --write` makes
that home first, with the `config.toml` relay writes there (Codex refuses a `CODEX_HOME` that does
not exist, and relay's file keeps the login in the file store its turns read):

```sh
CODEX_HOME="$HOME/.local/share/relay-codex-home" ~/.local/share/relay-codex-pins/current/bin/codex login
```

## A release's shipped pin

A release installed from npm carries `codex-pin.json`,
the maintainer's qualification of one Codex release with exactly that relay build
([shipped-pin.ts](../src/core/shipped-pin.ts)):

```json
{
  "format": "relay-shipped-codex-pin-v1",
  "codex": { "version": "0.169.0", "npmIntegrity": "sha512-…" },
  "relay": { "scheme": "relay-build-v2", "version": "1.2.1", "sha256": "…" }
}
```

That is all it can hold. npm's sha512 integrity fixes every byte of the Codex package, and relay's
build identity fixes every byte of the relay that ran the qualification, so nothing in it depends
on the maintainer's machine: no path, user, host or time. A manifest with any other field is
refused, not trimmed. What it does not carry is the maintainer's Mac itself, which is the trust a
shipped pin asks for (README, Security model, "Pinned Codex").

**Putting it in place.** `relay install codex --write` (and `relay qualify-codex --shipped`) run
[codex-shipped-pin.mjs](../scripts/codex-qualify/codex-shipped-pin.mjs) `installShippedPin`:

- it refuses a package whose build is not the one its pin names (a package changed after release);
- it refuses npm metadata naming another integrity, before downloading;
- it then downloads `@openai/codex@<version>-darwin-arm64` and checks its bytes against that
  integrity, and Apple's signature, OpenAI's Team ID and the exact version as the qualifier does;
- it publishes the vendor tree under `shipped/<version>-<sha12>` (never `versions/`), and makes it
  `current` through the same journalled promotion. Rollback works across both kinds.

**What relay checks on every turn.** A `shipped/` tree runs only if the package relay is running
from ships a pin naming exactly that tree's version and integrity, and that pin's relay build is
the build running now, both on disk and as the process loaded it when it started (a worker kept
running across an in-place upgrade still runs the old release's code, which the new release's pin
does not cover, so it refuses Codex until the session restarts).
Upgrading relay therefore refuses the old shipped pin until
`relay install codex --write` puts the new release's in place. That is immediate when the new
release ships the same Codex: the tree is shared. A `shipped/` manifest has no verdict, so it can
never pass as a local pin, and a local manifest under `shipped/` is refused too.

**Precedence.** Relay runs whatever `current` names, and:

- `relay install codex --write` makes the shipped pin current only when there is no pin or the
  current one is shipped. It never replaces a pin qualified on this Mac.
- `relay qualify-codex --shipped` replaces a local pin with the shipped one, on request. `previous`
  keeps the local one for rollback.
- `relay qualify-codex` (and the LaunchAgent) always qualify here, even the version the shipped pin
  names, and the local pin then takes precedence.
- `relay doctor` reports which pin is in force. When a local pin is current and the release ships
  another, doctor says so and how to switch.

### Shipping a pin with a release (maintainer)

The manifest is written only by `writeShippedPin`, and only from a passing local qualification. It
holds the store's lock and refuses unless all of these hold:

- the store's `current` is a `versions/` tree;
- the tree's sealed manifest, binary digest and verdict re-judge as passing under the current
  schema, with the verdict bound by its digest;
- it is not a stage-2 fixture;
- it records a `relayBuild` equal to the build being released.

`npm pack` refuses a `codex-pin.json` that names another build (`scripts/check-pack.mjs`). Because
the pin names `dist/` byte for byte, `dist/build-info.json` included, build once and pack that
build; never rebuild between qualifying and packing.

**Release order.** Development happens in a private repository; each release reaches the public
repository as one exported commit. The export leaves every file of the build identity, and the
sources they are built from (`src/`, `native/`, the build scripts), byte for byte as they are in
the private repository: it strips and rewrites only documentation and other files outside the
build. A release is then built, qualified and packed in the exported tree, never in the private
one, so `dist/build-info.json` records the public commit that anyone can check out:

1. Export the release commit to a clean clone of the public repository, commit it there, and push.
2. In that clone, at that commit, with a clean tree: `npm ci && npm run build`.
3. Qualify that build into a fresh store and write the pin from it.
4. Pack it, check the tarball, and publish that exact tarball.

```sh
# in the public clone, at the release commit, with nothing uncommitted (git status --porcelain is empty)
npm ci && npm run build
# qualify into a fresh store (not your live one), with repo = this checkout
store=$(mktemp -d)/pins
printf '{"repo":"%s","store":"%s"}\n' "$PWD" "$store" > "$TMPDIR/release-qualifier.json"
node scripts/codex-qualify/codex-qualifier.mjs "$TMPDIR/release-qualifier.json" --run --version X.Y.Z   # ~1.5 h, desktop login
node scripts/codex-qualify/codex-shipped-pin.mjs --write --store "$store"                                 # writes ./codex-pin.json
npm pack                                                                     # prepack checks the pin against the build
node scripts/codex-qualify/codex-shipped-pin.mjs --check-tarball jbkjr-relay-<version>.tgz   # the packed release names its own build
npm publish jbkjr-relay-<version>.tgz                                        # exactly the bytes just checked
```

The identity in the published tarball then equals the identity in its pin by construction, and
both checks above refuse otherwise. A build of the same commit made elsewhere with `npm ci` and the
same developer tools differs only in `dist/build-info.json` (its time, and the commit when made in
another repository). Other tools can change more: the native helper (`dist/native/relay-sbcheck`) is
compiled with the Mac's own `cc`, and is left out of a build made without Apple's command line
tools.

`codex-pin.json` is ignored by git: it belongs to one build, not to a commit.

## How the qualifier works

The independent [Codex qualifier](../scripts/codex-qualify/codex-qualifier.mjs) admits complete npm macOS ARM vendor trees into a Relay-owned store. Interactive Codex continues to update independently. Failed downloads, signatures, qualification, or missing GUI prerequisites leave the current qualified binary in service. There is no fallback to interactive Codex. Relay's separate Codex home defaults to `~/.local/share/relay-codex-home`, beside `~/.local/share/relay-codex-pins`; `targets.codex.home` and `targets.codex.pin_store` override those paths. Relay requires a pin by default, resolves `current` once per turn to its immutable executable, and uses its own `CODEX_HOME`. Its credential-home denials, whole-store write protection, explicit legacy opt-out and remaining person-run checks are documented in [the runtime qualification note](qualification/pinned-codex-runtime.md).

The default store is `~/.local/share/relay-codex-pins/`; `store` in the [example config](../scripts/codex-qualify/codex-qualifier.example.json) overrides it. Use a dedicated, trusted, built Relay checkout for `repo`, with no concurrent edits or builds. The runner never builds or updates that checkout and never reads your interactive Codex state. All child processes, including version probes, diagnostic tools, downloads and notifications, receive explicit scratch `HOME`, `CODEX_HOME` and `TMPDIR`. Stage 2 continues to use synthetic credentials and its own fake model; no signed-in turn runs.

```text
relay-codex-pins/
  versions/<version>-<binary-sha256-first-12>/   # qualified on this Mac
    bin/codex
    codex-package.json, codex-resources/, codex-path/, ... (complete vendor tree)
    manifest.json
  shipped/<version>-<binary-sha256-first-12>/    # a release's shipped pin, downloaded and verified here
    bin/codex, ... , manifest.json               # version, binary SHA-256, npm SRI, codesign, installedAt
  current -> versions/... or shipped/...
  previous -> versions/...
  journal.jsonl
  pending.json                 # only during a pointer transaction
  lock/owner.json              # one updater or rollback at a time
  staging/                     # publication and stale-lock tombstones
  runs/<timestamp>-<random>/   # runner.log, stage2.log, verdict or failure
  failed-qualifications/<key>.json # rejected verdicts, keyed by version, binary SHA and relay build
  last-result.json
  last-failure.json            # last historical failure, retained after recovery
```

The runner checks npm's stable `latest`, or an explicit `--version X.Y.Z`. It downloads `@openai/codex@<version>-darwin-arm64`, verifies npm's SHA-512 SRI before extraction, rejects archive traversal, links and special files, and runs no install scripts. It requires the exact `codex-cli <version>` output, `/usr/bin/codesign --verify --strict` with an Apple signature requirement for Team ID `2DC432GLL2`, and records the displayed signing identity and binary SHA-256. SRI authenticates bytes against npm metadata; it does not independently verify npm provenance. It resolves `rust-v<version>` (including annotated tags) to a Git commit and downloads the source at that commit.

After a verdict fails qualification, the runner atomically records the candidate version, binary SHA-256, relay build identity (`relayBuild`), timestamp (`at`) and retained `verdictPath` in `failed-qualifications/` inside the configured store. Each filename is the SHA-256 of the JSON array `[version, binarySha256, scheme, relay version, relay build sha256]`, so failures for different inputs remain remembered independently; a record from before build identities, keyed by a relay commit, matches no build, so those inputs are qualified again. After transaction recovery and the existing current-pin check, a later run acquires and verifies the candidate. If all three inputs match a recorded failure, it skips control/source acquisition and stage 2, writes `state: "skipped"` to `last-result.json`, and logs one skip line identifying the inputs and prior verdict. It sends no notification. Any changed version, binary SHA-256 or relay build runs qualification again. Runs without a parseable verdict (including crashes, kills and reboot interruptions), and errors after a passing verdict, are never added to this failure index. Promotion and recovery rules are unchanged.

Use `--force` to retry a recorded failure, with npm's latest or alongside `--version`:

```sh
node scripts/codex-qualify/codex-qualifier.mjs ~/.local/share/relay-codex-qualifier/qualifier.json --run --force
node scripts/codex-qualify/codex-qualifier.mjs ~/.local/share/relay-codex-qualifier/qualifier.json --run --version 0.166.0 --force
```

`--force` bypasses only the failed-qualification lookup; an already-current version still returns unchanged, and a candidate still needs every existing qualification and promotion check to pass. A passing verdict clears any prior failure record for those inputs, so a later driver, publication or promotion error cannot leave that old failure blocking retries.

The qualification invocation is exactly:

```sh
node <copy>/scripts/codex-qualify/codex-stage2.mjs <copy> <out-dir> <version> <codex-bin> --source <codex-rs> --old-bin <bin>
```

where `<copy>` is the verified copy of relay's build in the run's scratch directory.

`--old-bin` always means **0.163.0**: one check, a negative control, confirms that relay refuses stage 2 on a Codex older than stage 2 supports, and 0.163.0 is that Codex. By default the runner acquires and verifies that version into scratch too. An optional absolute `oldBin` config path may supply it; its signature and exact version are checked every time. It is never the previous pin. A zero exit status is insufficient: the verdict must be JSON with `ok === true`, `state === "passed"`, the requested version, `relayPath === "present"`, exactly the current schema's items (`stage2-v4`: items 1–33), all expected evidence parts from the reviewed driver, and every recorded part passed. Missing controls or Relay parts, missing verdicts, skipped parts, pending integration and unavailable GUI probes fail qualification.

Evidence requirements are versioned in the fixed, frozen `VERDICT_SCHEMAS` list in [codex-pin-store.mjs](../scripts/codex-qualify/codex-pin-store.mjs). `stage2-v1` is the exact Relay 1.1.0 set at `237bd74`; `stage2-v2` (Relay 1.1.1) adds item 10's `effort` evidence; `stage2-v3` adds item 12's `prefetch` positive control; `stage2-v4` (Relay 1.1.4) adds item 33, the decoy keychain under the never floor, and is the current schema. Pins already qualified under `stage2-v3` (items 1–32) stay valid. New driver verdicts record `verdictSchema`. Every new qualification is judged explicitly against `CURRENT_VERDICT_SCHEMA`, regardless of any older schema claimed in its verdict; after a pass, the runner records the schema it actually enforced. Unknown ids and custom requirement sets are invalid. When adding a requirement, add a new fixed schema entry and advance `CURRENT_VERDICT_SCHEMA`; preserve every historical entry, including its escalation parts, independently of the live driver.

On a pass, the complete vendor tree and `manifest.json` are staged on the store filesystem and renamed into `versions/`. The manifest records version, npm SRI, binary SHA-256, codesign identity/Team ID, qualification time, absolute verdict path, `verdictSchema`, `verdictSha256`, source commit/archive digest, relay build identity (`relayBuild`; earlier pins: the Relay commit), driver digest and Node version. New publications require the current schema. Published trees are never rewritten; old trees and their evidence remain available. Read-only file modes prevent accidental edits; Relay's separate whole-store sandbox protection is still required against agents running as you.

Stored receipts, including `current`, `previous`, promotion recovery and rollback targets, are checked against their publication's schema. A manifest without schema/digest fields always selects the fixed `stage2-v1` baseline, and a verdict without a schema id means `stage2-v1`. Its evidence must still contain every required item and part, with every recorded part passing. This keeps pre-schema 1.1.0 receipts usable after requirements grow; an unchanged check or rollback does not requalify them against today's requirements.

The verdict file lives outside the sealed vendor tree, in the run directory, and was neither sealed nor hashed by 1.1.0. For new receipts, the sealed manifest binds both its schema id and the SHA-256 of the verdict's exact bytes. Validation hashes and parses the same bytes, requires the verdict's schema to match the manifest, and rejects any content change, including removal or downgrading of the schema id. Legacy evidence retains its original trust model: its content is not hash-bound, but the sealed manifest's absent schema fixes the oldest allowed baseline, so changing that external verdict cannot choose a weaker or different schema. No receipt can supply its own requirements. The manifest is protected by read-only publication modes and the trusted store, rather than a cryptographic signature; an owner who can rewrite the store can defeat those protections.

Promotion first makes a temporary `previous` symlink and renames it over `previous`, then does the same for `current`. The `current` rename is the visibility commit point. The first successful run bootstraps `current` with no `previous`. `pending.json` records the transaction before the swaps; the next locked operation restores the old `previous` if `current` never switched, or finishes the journal append if it did. A torn/corrupt journal fails closed and requires inspection rather than silently discarding history. Each committed promotion/rollback appends a synced JSONL record. A qualified tree can remain unreferenced if publication is interrupted; the runner never promotes an incomplete tree.

Rollback takes the same lock and verifies that `previous` matches the journal's last recorded `from`, then swaps `previous` and `current` by the same temporary-link/rename procedure:

```sh
node scripts/codex-qualify/codex-qualifier.mjs ~/.local/share/relay-codex-qualifier/qualifier.json --rollback
```

**Rollback changes the binary only.** It does not undo `targets.codex.home` configuration, sessions, credential refreshes or database migrations. It does not establish home downgrade compatibility. Keep version/state compatibility and consistent database backup policy in the runtime rollout plan. The next scheduled check may qualify and promote npm's latest again; stop the agent first if a rollback must stay in place.

The lock is an exclusive directory with a PID and random owner token. A live PID is never evicted (including permission-denied liveness checks); a recent incomplete lock is busy. After 30 seconds a dead owner's lock or an abandoned partial lock can be recovered. Nonempty stale-lock tombstones are retained so concurrent recoverers cannot rename a new lock over an already claimed stale lock. A reused living PID conservatively keeps the lock busy. Do not remove a live lock by hand.

Stage 2 has a two-hour watchdog (`timeoutMs`, the most it can be set to): a full qualification includes one probe that runs for just over an hour (3601 seconds) and takes about 85 minutes. The runner sets `RELAY_TEST_PUBLIC_NET=1` and `RELAY_TEST_ESCALATION_LONG=1` for the driver, since a part left "not run" fails the verdict. Its driver starts in its own process group. The watchdog inventories descendants using macOS `ps -E` (uppercase: include environments), tracks PID/start identities and groups whose leaders have exited, and finds detached/reparented processes by the unique scratch paths in their environments. On timeout or SIGTERM/SIGINT it repeatedly freezes newly found identities until discovery converges, then kills the frozen processes and their groups. It preserves the parent chain until discovery finishes and never resumes frozen children before killing them. It looks again after the kill, stops any newly discovered survivors, and requires a final empty look; zombies have already exited. Inspection failure, nonconvergent discovery or surviving processes fail cleanup and prevent promotion. This is for this trusted model-free harness, not a general hostile-process containment boundary. Real macOS process-tree cleanup and logout behavior require the host checks below; fixture tests alone do not establish them.

Failure text goes to `runs/.../runner.log`, `failure.json`, `last-failure.json`, and launchd's stderr/stdout logs. Notifications use `/usr/bin/osascript` with a constant `display notification` script and the message as an argument, never interpolated AppleScript. Notification failure is logged too. Evidence and scratch directories are retained deliberately; monitor disk use and prune only inactive scratch/evidence that no manifest or transaction references. No automatic version eviction runs.

**Release gates run the suite's real-Codex tests on the pin too.** The sandbox tests that run a real Codex (`codex sandbox (installed Codex)` in `test/codex-permissions.test.ts`, and C1 in `test/security-boundary.test.ts`) take the absolute path in `RELAY_TEST_CODEX`, as the red team does. A gate sets it to the pinned executable (`versions/<version>-<sha>/bin/codex`, the one it qualifies and red-teams with) and sets `RELAY_REQUIRE_REAL_CODEX=1`, under which a missing `RELAY_TEST_CODEX` fails those tests: they neither skip nor fall back to PATH's or Homebrew's Codex, which update by themselves. Outside gates, with neither set, they use the first `codex` on PATH (Homebrew's for C1) and skip, saying so, when there is none.

## Keeping up with Codex releases: the LaunchAgent

`relay qualify-codex` pins one release; relay keeps running it until you qualify another. The optional LaunchAgent runs the same qualifier six times a day, so each new Codex release is qualified and pinned without you. It is for a Mac that stays logged in to its desktop: each run takes about an hour and a half, needs the network and a desktop (Aqua) session, and spends no model usage. Nothing installs or loads the agent for you; these are the steps.

1. **Set up a dedicated relay checkout and the qualifier's config.** The agent runs the qualifier from a checkout of its own, which nothing else edits or builds, so that a qualification never runs against a half-updated build:

   ```sh
   mkdir -p ~/.local/share/relay-codex-qualifier
   git clone https://github.com/jbkjr/relay-mcp.git ~/.local/share/relay-codex-qualifier/relay
   cd ~/.local/share/relay-codex-qualifier/relay
   npm ci --ignore-scripts
   npm run build
   printf '{"repo":"%s","store":"%s","timeoutMs":7200000}\n' \
     "$HOME/.local/share/relay-codex-qualifier/relay" "$HOME/.local/share/relay-codex-pins" \
     > ~/.local/share/relay-codex-qualifier/qualifier.json
   ```

   `store` must be the pin store relay reads (`targets.codex.pin_store`, by default the one above), and both paths must be absolute; [codex-qualifier.example.json](../scripts/codex-qualify/codex-qualifier.example.json) shows the same shape. After you update this checkout later, run `npm run build` again before the next scheduled run: the agent's process supervisor imports the checkout's `dist/`, and scripts newer than the build can be incompatible with it.

2. **Check that this Mac can run the qualifier**, from a terminal in your desktop login. The first command runs the qualifier's fixture tests, which need no network, Codex or launchd. The second runs its host checks, which start only synthetic Node processes (detached groups and an orphaned grandchild among them), check that a timeout and a cancellation stop all of them, and clean up even on failure:

   ```sh
   node --test --test-timeout=60000 test/codex-qualifier.test.ts test/qualify-codex.test.ts test/build-identity.test.ts test/codex-shipped-pin.test.ts
   RELAY_QUALIFIER_HOST_CHECKS=1 node --test --test-timeout=60000 test/codex-qualifier-host.test.ts
   ```

3. **Run a first qualification by hand**, still in your desktop login. Without `--version` it takes npm's latest Codex; with `--version`, the release you name (the one `relay doctor` shows under "codex pin", say):

   ```sh
   node scripts/codex-qualify/codex-qualifier.mjs ~/.local/share/relay-codex-qualifier/qualifier.json --run
   ```

   It pins the release only when every item passes (33 today). Its run directory, under the store's `runs/`, holds the verdict and logs; `relay doctor` then shows the new pin.

4. **Sign in once** with relay's Codex home, if you have not already (`relay install codex --write` makes the home first). With the default `targets.codex.home`:

   ```sh
   CODEX_HOME="$HOME/.local/share/relay-codex-home" ~/.local/share/relay-codex-pins/current/bin/codex login
   ```

   If `targets.codex.home` is set to another path, use that. The scheduled qualification never uses this login: it runs Codex with scratch homes and its own fake model.

5. **Install the agent, check notifications, and load it.** The installer prints the plist it would write; `--install` writes it, with the validated config and log directories and restrictive permissions, but does not load it:

   ```sh
   node scripts/codex-qualify/install-codex-qualifier.mjs --config ~/.local/share/relay-codex-qualifier/qualifier.json
   node scripts/codex-qualify/install-codex-qualifier.mjs --config ~/.local/share/relay-codex-qualifier/qualifier.json --install
   /usr/bin/osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Relay Codex qualification"' -e 'end run' 'Relay qualifier notification check'
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.$(id -un).relay-codex-qualifier.plist
   launchctl print gui/$(id -u)/local.$(id -un).relay-codex-qualifier
   ```

   The agent's launchd label is `local.<your login name>.relay-codex-qualifier`, with the name lowercased and any character other than a letter, digit or hyphen turned into a hyphen; `--label` sets another. The installer prints the two `launchctl` lines with the label it used: run those if your login name has other characters. An existing plist of that name is replaced only when it is itself a qualifier agent. The installer resolves Node to an absolute installed version, never a shell's temporary link; `--node /absolute/node` and `--logs /absolute/logs` override its choices, and you rerun it if that Node version is removed. The notification check is there because the qualifier reports failures as macOS notifications: allow them for Script Editor, and check Focus and lock-screen settings.

The [plist template](../scripts/codex-qualify/relay-codex-qualifier.plist) requires `Aqua`, runs at load and at 02:15, 06:15, 10:15, 14:15, 18:15 and 22:15, has no KeepAlive, uses umask 077 and a 120-second shutdown allowance, and writes its output under `~/Library/Logs/relay-codex-qualifier/`. It waits for a desktop login after logout or reboot, and sleep can merge missed runs into one. Stop it with `launchctl bootout gui/$(id -u)/<label>`, which sends the runner SIGTERM; the watchdog then stops what it started.

Each run leaves `current` alone unless a new release passes in full: a failed download, signature, qualification, a network outage or a missing desktop session keeps the pin you have. Look at `last-result.json` and `last-failure.json` in the store, or the logs above, to see what the last run did.
