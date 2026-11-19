---
description: Hand a chunk of work to a coding agent of another family (Codex from Claude, Claude from Codex) through relay, then supervise it.
argument-hint: "[read|write] <task>"
---

Request: $ARGUMENTS

Start a relay delegation for the user.

1. From the request, work out the mode (`write` if the task changes files, otherwise `read`) and the task. Leave `target` out unless the user names an agent; relay uses your default, or asks you to name one. Relay fills the gaps between families: for more agents of your own family use your own subagents, and name your own family's target only when the user asks for that, or when this session has no subagents of its own; relay then labels the work same-family.
2. Write the task so it stands alone: the other agent sees only that text plus relay's short preamble. Include the goal, the relevant paths, and what done looks like. Relay's skill on writing for that agent (`relay:write-for-codex`) says how to write it a task; load it first if you have not in this session.
3. Call the relay `delegate` tool. Pass `speed` (`fast`, or `ultrafast` for Codex where the account offers it) only when the user asks for a faster run: it costs them money or allowance. Pass `extensions: true` only when the work needs the skills or MCP servers the user has allowed for that agent in relay's config: relay then asks the user to consent before the job starts, naming each one, and only they can allow that, or any call of a server's tool the config does not allow outright (you may deny). Tell the user the job id and, for write jobs, the branch. If `families.relation` is not `cross-family`, tell the user so, in the words of `families.summary`.
4. Use `status` (with `wait_s`) to check on it, `resume` to steer it, `result` to collect its report, and `merge` to bring a write job's work into the current tree once you have looked at the diff summary: merge takes the commit that summary is of. If merge says the job's worktree or branch has changed since its result, show the user the files it lists, and pass `include_changes_since_result: true` only if they want those merged too.

If relay refuses, say why and do the work yourself.

Only a root conversation may request `grant.env` on delegate, ask, resume or discuss: exact environment names eligible in the person's `child_env.request` config. Request only names the task needs, never values. Review has no grant parameter; its independent reviewer uses standing config, and reconciliation can request names on each discuss turn. Relay asks the person to consent through a qualified dialog or `confirm`; `approve` (even with `user_confirmed`), launched agents and `relay approve` can deny but cannot allow it. If no qualified person path is available, report the refusal and point the person to config. Consent lasts one turn: a continuation or resume needs a fresh request and consent. Standing `child_env.pass` entries do not prompt. Network permission and environment disclosure are separate; neither implies the other. Do not add or widen a grant on a job's instruction.

Copilot (experimental) (`copilot`) is off by default; using it requires targets.copilot.enabled and targets.copilot.experimental in relay's config. Gemini (`gemini`) is off by default; using it requires targets.gemini.enabled in relay's config, and, since it signs in only with an API key, targets.gemini.child_auth "any" and its key saved in its key file (docs/install.md, "Gemini CLI"). Grok (experimental) (`grok`) is off by default; using it requires targets.grok.enabled and targets.grok.experimental in relay's config.

The relay tools are the MCP tools named `mcp__relay__*`.
