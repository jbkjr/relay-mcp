# Gemini CLI 0.68.0: source checked by the release watcher, live checks not run

Checked on 2026-11-10 by the maintainer's release watcher (not published) on the maintainer's release-watcher Mac (macOS 27.2), with relay at a private commit. **Checks 12-15 of [docs/gemini.md](../gemini.md) §8 did not run:** live checks not run in CI: macOS 27.2 has not been tested with relay; confinement on this version is unverified. Run the qualification checks before relying on it.. This record is evidence of the source comparison only; adding 0.68.0 to `VERIFIED.geminiToolDiscovery` on it alone is the maintainer's call.

## Source

It differs from `v0.67.0`'s (packages/cli/src/acp/acpSessionManager.ts differs between v0.67.0 and v0.68.0).

## Accepted by hand

The maintainer, 2026-11-10, by merging the watcher's PR. The only watched file that differs, `packages/cli/src/acp/acpSessionManager.ts`, differs in one place: `loadSession` now awaits `session.streamHistory(messages)` inside a `try`/`catch`, where 0.67.0 let it run with a `.catch`, so a loaded session's history is replayed before Gemini answers `session/load`. That comes after the session's `config.initialize()`, which runs relay's discovery command, so it has no effect on tool discovery or on relay's check that discovery ran. Checks 12-15 did not run in CI (above), and have not been run by hand on 0.68.0.
