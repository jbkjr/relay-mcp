# Third-party code in relay

relay is MIT-licensed (`../LICENSE`). Code copied from other projects keeps its own licence. It is
listed here with the notices those licences require.

## OpenAI Codex (Apache License 2.0)

- **What:** one Seatbelt rule, which allows a turn's own pseudo-terminals through the kernel's
  `com.apple.sandbox.pty` extension. It is in `src/confine/seatbelt.ts`, marked where it appears.
- **Source:** `codex-rs/sandboxing/src/seatbelt.rs` in
  [openai/codex](https://github.com/openai/codex) at
  [`0e67502`](https://github.com/openai/codex/tree/0e67502123b4c6952b9fa5d672d2907fe4059f56).
- **Changes:** none. The rule is copied unchanged.
- **Licence:** Apache License 2.0. The copy in `Apache-2.0.txt` is Codex's `LICENSE` at that commit.
- **NOTICE:** Codex's `NOTICE` file at that commit is reproduced in full in `codex-NOTICE.txt`
  ("OpenAI Codex, Copyright 2025 OpenAI").

The rest of relay's confinement draws on the reasoning in Codex's and Anthropic's sandbox-runtime's
designs, but is written fresh.
