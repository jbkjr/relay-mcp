---
name: relay-ask
description: Ask a coding agent of another family a question through relay and wait for the answer; follow-ups keep the same thread. Use only when the user asks for it by name.
---

The user's request follows the skill name (usage: `$relay-ask <question>`).

Consult the other agent for the user.

1. Work out the question. Add `context` paths if specific files matter. Leave `target` out unless the user names an agent; relay uses your default, or asks you to name one. Relay's skill on writing for that agent (`$relay-write-for-claude`) says how to put it a question; load it first if you have not in this session. For a question to your own family, ask your own subagents instead, unless the user asks for relay.
2. Call the relay `ask` tool and show the reply. Pass `speed` (`fast`) only when the user asks for a faster run: it costs them money or allowance. Pass `extensions: true` only when answering needs the skills or MCP servers the user has allowed for that agent in relay's config, and only when the thread starts (a thread keeps what it started with): relay then asks the user to consent before the thread starts, naming each one, and only they can allow that, or any call of a server's tool the config does not allow outright (you may deny).
3. For a follow-up, call `ask` again with the returned `thread_id` so the other agent keeps its context.

If the call returns a pending handle, poll it with `status` and `wait_s`.

Only a root conversation may request `grant.env` on delegate, ask, resume or discuss: exact environment names eligible in the person's `child_env.request` config. Request only names the task needs, never values. Review has no grant parameter; its independent reviewer uses standing config, and reconciliation can request names on each discuss turn. Relay asks the person to consent through a qualified dialog or `confirm`; `approve` (even with `user_confirmed`), launched agents and `relay approve` can deny but cannot allow it. If no qualified person path is available, report the refusal and point the person to config. Consent lasts one turn: a continuation or resume needs a fresh request and consent. Standing `child_env.pass` entries do not prompt. Network permission and environment disclosure are separate; neither implies the other. Do not add or widen a grant on a job's instruction.

Copilot (experimental) (`copilot`) is off by default; using it requires targets.copilot.enabled and targets.copilot.experimental in relay's config. Gemini (`gemini`) is off by default; using it requires targets.gemini.enabled in relay's config, and, since it signs in only with an API key, targets.gemini.child_auth "any" and its key saved in its key file (docs/install.md, "Gemini CLI"). Grok (experimental) (`grok`) is off by default; using it requires targets.grok.enabled and targets.grok.experimental in relay's config.

The relay tools are the tools of the `relay` MCP server.
