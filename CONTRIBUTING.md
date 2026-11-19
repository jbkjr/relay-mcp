# Contributing to relay

Bug reports, fixes and improvements are welcome. Relay is maintained by one person, so please
expect replies within days to a couple of weeks rather than hours.

**Security problems go through [SECURITY.md](SECURITY.md)**, never a public issue or pull request.

## How development works here

Relay is developed in a private repository. This public repository receives one commit per release,
exported from it. That affects how a pull request lands:

1. You open a pull request here as usual. CI runs the build, the typecheck and the test suite on
   GitHub's macOS runners.
2. If it is accepted, the maintainer applies the change in the private repository, crediting you as
   a co-author (a `Co-authored-by:` trailer with the name and email of your commits), and runs the
   checks described below.
3. Your pull request is then closed, not merged, with a link to the release that carries the change.
   The release's commit and notes credit you.

So a merged-looking history here is not the goal; credit and the change itself are. If the number of
outside contributions grows, development may move to this repository; this file will say so.

## Before you open a pull request

- For anything beyond a small fix, open an issue first to agree the approach. Confinement,
  approvals, credentials and the network proxy are security boundaries, and changes there get a
  closer review.
- Keep a change to one concern, with tests for what it changes.
- Run the suite locally (below). CI must pass.
- Describe what you changed and why, and how you checked it.

## Building and testing

You need macOS, the Node version `package.json`'s `engines` names (Node 24.15 or newer), git, and Apple's command line tools (`xcode-select --install`)
for the native sandbox-check helper.

```sh
npm ci            # installs exactly what npm-shrinkwrap.json names
npm run build     # dist/, the native helper, dist/build-info.json
npm run typecheck
npm test          # builds, then the suite
```

Run a single file with `node --test test/<name>.test.ts` after `npm run build`.

The tests come in three tiers (the README's Development section has the details):

- `npm test` runs relay's logic against stub agents. A few tests also run an installed Codex,
  without a model, to check its own sandbox as relay configures it (`codex sandbox`): the one at
  `RELAY_TEST_CODEX`, else the first `codex` on PATH; without one they skip and say so. Nothing in
  it signs in or spends model usage. This is what CI runs.
- Host-only tests start real sandboxes and CLIs, and some spend model usage. Each is off unless its
  variable switches it on (named at the top of each `*-live.test.ts` file); CI never does.
- Release checks (the Codex qualification, signed-in target checks, red-team campaigns) are run by
  the maintainer; see below.

The suite never changes your real configuration: every test file imports `test/helpers.ts`, which
gives it a scratch `HOME`, and a guard test checks that each one does. Keep it that way. A test
must never write your real home, dotfiles, CLI logins or installed programs; an installed Codex is
only ever run, with scratch homes.

## What gates a merge

Passing CI is necessary but not sufficient. Before a change ships in a release, the maintainer runs
the checks that need real agent CLIs, a logged-in Mac and, for some, a dedicated macOS account:

- the confinement checks: the stage-2 qualification of the pinned Codex
  ([docs/pinned-codex.md](docs/pinned-codex.md)), the per-target boundary probes, and the red-team
  campaign where a change touches what an agent can reach;
- the qualification records under [docs/qualification](docs/qualification) for any target or
  version a change affects.

A change that weakens a confinement check, or that makes relay report a protection it did not
verify, is not merged, whatever else it fixes. A change to the files of relay's build identity
(`dist/`, `scripts/codex-qualify/`, the stage-2 tests; see
[docs/pinned-codex.md](docs/pinned-codex.md#relays-build-identity)) means the release's Codex pin is
qualified again before it ships.

## Style

Follow the code around you: small modules, plain error messages that say what to do, and comments
that explain why rather than what. User-facing text is plain, precise English.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE), as
relay is.
