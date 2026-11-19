Write the assignment the way you would brief a capable colleague who has not seen any of your work: what you want, why, and how you will know it is done. Claude follows instructions closely and literally, so what the text leaves out it will not infer, and what it says it will act on.

### Structure the task

- Open with the outcome in one or two sentences, then the reason for it. Knowing what the work is for lets Claude make the judgment calls you did not anticipate.
- Then give what it needs, in this order as far as it applies: context (files, symbols, decisions already made and why), requirements and non-goals, how to verify, and what to hand back.
- Say plainly whether you want changes made or only proposed. "Can you suggest how to fix this" gets a suggestion; "fix this" gets a fix.
- Put long material (logs, a spec, a failing test's output) before the instructions that refer to it, and wrap each piece in its own tag, such as `<log>` or `<spec>`, so instructions and material cannot be confused. Plain headings are enough for the rest.
- If one example would settle a format or a behavior, include it, and make sure it matches the requirements exactly: Claude copies examples closely, including their accidents.

### Ground the work

- The launched agent sees only your text and relay's preamble. Name the paths, the commands and the decisions; do not refer to "the bug we discussed" or "the approach above".
- Separate what you have checked from what you suspect. Ask it to confirm a diagnosis against the code before building on it, and to say so if the evidence points elsewhere.
- State constraints with their reasons ("keep the public API unchanged: two other services import it"). A reason travels to cases a bare rule does not cover.
- Mark pasted third-party text (an email, an issue, a web page) as material to evaluate, not instructions to follow.

### Define the deliverable and the stopping point

- Name the deliverable: working changes with tests, a diagnosis, a recommendation with its tradeoffs, a list of findings. In a job, put any answer or structured output before relay's report, not in place of it.
- For implementation, say the job ends when the change works and is verified, not at a plan or a progress summary. For analysis, say where to stop so it does not drift into implementing.
- Bound the scope. Claude tends to be thorough: without a stated limit it may add tests, refactors or abstractions you did not ask for. Say what is out of scope and ask for unrelated problems to be reported, not fixed.
- Allow it to make reasonable, reversible choices and state them; reserve questions for missing facts that change the result. A launched agent has nobody to answer mid-turn, so it should finish what it can and report what it needs.

### Specify verification

- Give the exact commands for build, tests and lint, and anything they need (environment variables, a service, a fixture).
- Say what counts as evidence for each acceptance criterion; a passing suite may not exercise the change. Ask for a regression test when one would show the fix.
- Ask it to report each check as run and passed, run and failed, or not run with the reason, and to say what it could not verify.

### Avoid what works against Claude

- Capitals, "MUST", "CRITICAL" and repeated warnings. Current Claude models already take instructions seriously; emphasis makes them overapply a rule to cases it was never meant for. Say it once, calmly, with the reason.
- Long lists of prohibitions. Say what to do instead: "write the summary as prose paragraphs" works better than "no bullet points, no headers, no lists".
- Asking it to write out its full reasoning step by step in the reply. It reasons before answering on its own; ask for conclusions, evidence and a short rationale.
- Terse ticket shorthand with no why ("fix auth flake, see CI"). Claude does its best work when it understands the purpose and the stakes.
- Prescribing tool calls or naming tools from your own host. Describe the result; Claude Code has its own tools for reading, editing, searching and running commands.

### Questions through `ask`

- State the question, the decision it feeds, and what evidence would settle it. Name the files to read first with `context`.
- Ask for a direct answer first, then the support for it, and for disagreement with your premise if the evidence warrants it. A thread is read-only, so ask for a recommendation or a patch in the reply, not edits.
- Follow up in the same thread, saying what changed since the last answer.
