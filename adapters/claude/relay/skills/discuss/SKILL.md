---
description: Hold a discussion with a coding agent of another family through relay, with you as one side, ending in agreement or a stated crux.
argument-hint: "<topic> [--max-turns N]"
---

Request: $ARGUMENTS

Hold a discussion with the other agent for the user. You are one of its two sides.

1. Take the topic from the request and form your own opening position on it. Pass relevant files as `context`. If the user names an existing job or thread of the other agent, pass it as `with` so that session takes part with what it knows; otherwise leave `target` out unless the user names an agent, and relay uses your default or asks you to name one.
2. Call the relay `discuss` tool with `topic` and your opening `message`, ending the message with `CONTINUE`. You get the other agent's reply and a `discussion_id`. Pass `speed` (`fast`, or `ultrafast` for Codex where the account offers it) only when the user asks for a faster run: it costs them money or allowance.
3. Answer with `discussion_id` and `message`, and keep going. Argue from evidence: concede what is right, hold what you can support, and do not agree for the sake of ending. End every message with `CONTINUE`, `AGREE: <the conclusion>` or `CRUX: <what you cannot agree on>`. It ends when you both write AGREE in a row, or when you write CRUX and the other has answered.
4. If `families.relation` is not `cross-family`, say so first, in the words of `families.summary`. Report the outcome: the agreed conclusion, or each side's crux, and the transcript path. Mention that `relay chat <discussion_id>` shows it and lets the user add a message.

Only a root conversation may request `grant.env` on delegate, ask, resume or discuss: exact environment names eligible in the person's `child_env.request` config. Request only names the task needs, never values. Review has no grant parameter; its independent reviewer uses standing config, and reconciliation can request names on each discuss turn. Relay asks the person to consent through a qualified dialog or `confirm`; `approve` (even with `user_confirmed`), launched agents and `relay approve` can deny but cannot allow it. If no qualified person path is available, report the refusal and point the person to config. Consent lasts one turn: a continuation or resume needs a fresh request and consent. Standing `child_env.pass` entries do not prompt. Network permission and environment disclosure are separate; neither implies the other. Do not add or widen a grant on a job's instruction.

Copilot (experimental) (`copilot`) is off by default; using it requires targets.copilot.enabled and targets.copilot.experimental in relay's config. Gemini (`gemini`) is off by default; using it requires targets.gemini.enabled in relay's config, and, since it signs in only with an API key, targets.gemini.child_auth "any" and its key saved in its key file (docs/install.md, "Gemini CLI"). Grok (experimental) (`grok`) is off by default; using it requires targets.grok.enabled and targets.grok.experimental in relay's config.

The relay tools are the MCP tools named `mcp__relay__*`.
