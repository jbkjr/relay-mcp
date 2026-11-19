# relay benchmark

Times relay's own overhead against the stub agents (`test/stubs/`), so that no model or real CLI is
involved. Build first (`npm run build`); the bench drives `dist/` and `bin/relay`.

    TMPDIR=/tmp/rwk-bench node scripts/bench/run.mjs                      # the board, about 8 min
    TMPDIR=/tmp/rwk-bench node scripts/bench/run.mjs --only ask_codex,cli # some cells (or scenarios)
    TMPDIR=/tmp/rwk-bench node scripts/bench/run.mjs --compare .audit/bench-baseline.json
    TMPDIR=/tmp/rwk-bench node scripts/bench/run.mjs --ab ../other-checkout   # interleaved A/B
    node scripts/bench/run.mjs --list                                      # every cell and what it measures

TMPDIR must be short (relay's Unix sockets live under it; `/var/folders/...` is too long).

- **Isolation.** Every trial gets its own control directory, HOME, config, TMPDIR and repository
  under TMPDIR, with the stubs as its targets; nothing of the session running the bench reaches
  relay. Root servers start under two shells the bench owns, because a root server reads the
  command lines of the three processes above it. Whatever a trial started is gone before the next.
- **One at a time.** A run holds `/tmp/relay-bench.lock`; another waits and says so. It does not
  stop other work on the machine (this Mac also runs relay's CI runner, Time Machine and Spotlight):
  the start and end load average and any process using a lot of CPU are printed and kept in the
  JSON. Compare runs made under similar load, or use `--ab`, which alternates the two builds trial
  by trial on the same fixtures so that load affects both alike.
- **Reading a result.** A cell's value is its median (the mean for the four poll cells; see
  `scenarios.mjs`). `--compare` and `--ab` print each cell's change, PASS at `--target` (default
  20) percent faster, REGRESSED when slower by more than max(5%, 10 ms), and the geometric mean of
  the ratios per family and overall.
- **What the stubs leave out.** The stubs start in about 20 ms (a real Codex or Claude Code CLI
  takes longer) and answer at once; the Codex stub reports relay's network canary without running
  it. Cells measure relay's time around them, not a real agent's.
