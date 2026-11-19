# The person-only approval boundary for `relay approve`

Relay's root agent may decide the approval requests of the agents it launches, but a set of
requests are the person's alone to allow (`docs/extensions.md`, GLOSSARY *person-only request*):
consent to extensions, a call of an extension's MCP tool, any request from a session holding MCP
servers, one-turn environment disclosure, and any command that itself runs relay's CLI. A launched
agent is confined and cannot decide anything; the root agent can deny but not allow these; and the
person allows them in relay's approval dialog or through `confirm`.

`relay approve` on the command line is the person's other route. The problem it has always had is
that a command is not a person: any agent with a shell tool can run `relay approve`, under a
pseudo-terminal of its own if it wants (`script -q /dev/null relay approve …` defeats a naive
"is stdin a TTY" check). The previous defence was a string recognizer (`src/core/relay-command.ts`,
`runsRelayCommand`) that tried to tell whether a *command an agent asked to run* was itself a
`relay approve`; a cross-family review (`r_04ed60cc`, 2026-10-27) found six ways to spell such a
command that the recognizer missed. A string classifier of shell cannot be complete.

## The decision (the maintainer, 2026-10-27)

Stop leaning on the recognizer and add a **structural** check, so that how a shell spelled the
command matters less. `relay approve` now refuses to *allow* a request unless it is running at an
interactive terminal, outside every relay-launched process tree relay can detect, and the person
types back a one-time code. The recognizer stays as defence in depth.

This raises the bar; it is **not** a security boundary, and the sections below say so plainly. The
boundary that actually keeps a launched agent from deciding its own request is confinement — the
sandbox that keeps the agent out of relay's registry and off the approval routes. A command relay
does not confine (an `allow_dangerous` or outside-sandbox command) runs with the person's authority
and can get past this check; see "What the real boundary is".

`relay deny` is unchanged and works from anywhere: denying only ever narrows what an agent may do.

## What `relay approve <id>` now requires, in order (`src/cli.ts` `approveAtTerminal`)

1. **Not inside a relay-launched agent's process tree** (`src/core/presence.ts` `launchedTree`,
   used by `launchedAgentTerminal`). Checked, against the worker and agent pids relay recorded in
   its own registry (`nodes`, `relay_procs`), whichever holds:
   - an environment marker relay sets on every launched agent (`RELAY_RUN_ID`, `RELAY_NODE_ID`,
     `RELAY_DEPTH`, `RELAY_INJECTED`; `src/backends/env.ts`, `relayServerCommand`). This is the
     primary signal and the one an honest launch always carries;
   - an ancestor, by parentage, is one of those recorded processes (same pid and start time);
   - this process's process group or session is led by one of them. Relay starts every worker and
     agent detached, each leading its own session and group, which their descendants inherit even
     after they are orphaned and adopted by launchd — so a descendant that unset the environment
     markers is still caught by group or session.

   An unreadable process table or session id counts as *inside* (fail closed). A refusal here is a
   usage error (exit 2) directing the caller to the person's own terminal. `relay cancel`,
   `relay adopt` and `relay clean --forget` use the same check (previously an env-marker-only
   check).

2. **An interactive terminal.** Both stdin and stdout must be a TTY. This alone is weak (a
   same-user process can allocate a PTY), which is why it is only the second line.

3. **The person types back a one-time code.** Relay prints the request (kind, effect, directory,
   what it wants, and whether the allow is once or for the job) and a fresh 6-character code bound
   to this process and this request, then reads one line. Only that exact code (case-insensitive,
   surrounding space ignored) allows the request; anything else leaves it pending. The code never
   leaves the process, is never written to the registry, and cannot be reused for another request
   or another run of the command.

4. **The request is still the one that was shown.** After the code is typed, relay re-reads the
   request and refuses if its status, summary, kind or asking node changed while the person was
   asked, so a time-of-check/time-of-use swap cannot allow something other than what was displayed.
   relay's atomic `decide` then applies the allow, and reports "already …" if another decision won
   the race.

Session id is read on macOS through the system Perl's `getsid` syscall (Darwin `SYS_getsid` = 310),
the same Perl relay already depends on for kernel peer credentials (`src/confine/peer.ts`). Relay is
macOS-only.

## Defence in depth in the recognizer (`src/core/relay-command.ts`)

Gaps the review found are closed so the recognizer still fails closed on them:

- **An interpreter fed by a pipe is command position.** A command downstream of `|` whose name is a
  shell or scripting interpreter (`sh bash zsh dash ksh fish rc`, `python*`, `perl ruby node deno bun
  osascript tclsh lua php`) reads what the pipe gives it as the program to run — which relay cannot
  see — so it fails closed (`printf 'rela%s --version' y | sh`). `sed`, `awk` and `xargs` are left
  out: they can run commands, but flagging every `git log | sed -n 1,5p` or `git ls-files | xargs
  wc -l` is noise, and the structural check is the real boundary. Wrappers (`env`, `nice`, `nohup`,
  `timeout`, `sudo`, `exec`, …) are resolved before the interpreter test, so `… | env FOO=1 sh` is
  seen as sh: their value-taking options (`env -u NAME`, `timeout -s SIG`, `stdbuf -o MODE`,
  `nice -n N` and legacy `nice -N`, `sudo -u USER`, `exec -a NAME`), `--name=value` forms of those
  options and `--` (end of options) are parsed, and any other option on them fails closed.
- **An interpreter given inline code fails closed**, by per-interpreter flag: `python -c`, `perl -e/-E`,
  `ruby -e`, `node -e/-p/--eval/--print`, `osascript -e`, `php -r`, `lua -e`, `bun -e/--eval`, and
  `deno eval`, also with the code attached to the flag (`-cprint(1)`, `-eprint 1`) or given as
  `--eval=…`/`--print=…`. Shells are deliberately excluded: a shell's `-c <string>` argument is itself shell,
  which the recognizer already parses as a nested command. Codex runs every command as
  `/bin/zsh -lc '<cmd>'`, so flagging a shell `-c` would make every Codex command person-only.
- **Glob metacharacters in command position fail closed.** A command *name* containing `*`, `?` or
  `[` is a pattern the shell expands to whatever matches, so relay cannot establish the command.
  (`~/.local/bin/rela? --version`.) A glob in an *argument* is left alone.

Main's existing fail-closed handling of `$`-bearing words is unchanged; it already catches the
other four probes (`sort --compress-program="$x"`, the zsh/bash code-evaluating expansions,
`find -$x relay \;`, and the `PERL5DB` program). The allowlist rework from a private branch was
**not** brought back.

## What the real boundary is, and what this check is not

Be clear about what keeps an agent from allowing its own approval request. **It is confinement, not
this check.** A launched Claude or Codex agent runs under its harness's macOS sandbox as relay
configures it ([security-model.md](security-model.md), "What confines a launched agent"); a Copilot/Gemini/Grok agent runs under
relay's own Seatbelt. That sandbox is what keeps the agent out of relay's registry and off the
routes that decide approvals. relay does **not** confine the root session, and treats it as the
person ([security-model.md](security-model.md), "Who is trusted").

So the honest statement of this feature is narrow:

- **This check is a best-effort guard against a naive or accidental `relay approve`, not a security
  boundary.** It refuses the common and clumsy cases — a launched agent that still carries relay's
  environment markers, or whose parent, process group or session is one relay launched, and any
  blind or replayed `relay approve` that cannot complete the one-time code exchange at a real
  terminal. That is all it is for.
- **Any unconfined process running as the person defeats it.** A command relay's own sandbox does
  not confine — `allow_dangerous`, a command the person allowed to run outside the sandbox, or any
  ordinary process in the person's account — can clear the environment markers and detach into a
  fresh session and process group of its own (so ancestry, group and session no longer place it),
  present a pseudo-terminal, read the printed code back off that terminal, and type it in. A process
  that far outside relay's confinement can equally write relay's registry directly or decide through
  the root session's own tools, so `relay approve` is not the weak point in that case. The live
  review probe demonstrated the detach, and relay's own tests drive a terminal and type the code to
  exercise the allow path.
- **A Codex command allowed out of its sandbox is no exception** (relay 1.0.5). Relay's Codex profile
  denies reads of credential stores, so Codex keeps such a command in a sandbox, but one that can
  write anywhere but those stores: relay's registry and control directory, the person's shell
  startup files and LaunchAgents included. For this purpose it is still outside relay's confinement.
- **Therefore: an outside-sandbox command carries the person's authority over approvals.** Allowing
  a launched agent to run a command outside its sandbox (or configuring `allow_dangerous`) hands it
  the same standing as the person at the keyboard for this purpose. The launched-tree check and the
  typed code do not change that; they only raise the bar against approval by an agent that is still
  confined, or by accident.
- **Fail-closed where relay cannot see.** An unreadable process table, a `getsid` or `ps` failure,
  or any ambiguity is treated as inside a launched tree. The recorded group/session leader ids are
  kept for the run's lifetime, so an orphan left in a dead leader's group or session is still placed
  inside the tree. Each is kept with its leader's start time, and every start a pid led with is
  kept: a leader id stops matching only when a live process holds that pid with a start matching
  none of them, since macOS never reallocates a pid still in use as a group or session id
  (`forkproc` in XNU's `bsd/kern/kern_fork.c`), so the old group or session is gone. That spares a
  person's terminal that happens to reuse an old leader's pid without missing a live leader.
  These reduce false negatives among confined agents; they do not close the outside-sandbox path
  above.
