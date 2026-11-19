# Vendor refusal evidence (A17, 2026-10-19)

No live agent turns were run for this change. The OpenAI fixtures are trimmed from captured
agent output. Only event names, terminal status, the vendor's error message and its error
classification remain; thread/turn/session IDs, prompts, paths, timestamps and unrelated output
are omitted. No credentials or account identifiers are included.

| Fixture | Source | Evidence |
| --- | --- | --- |
| `openai-gpt-6.1-sol-xhigh.json` | The JSON event stream (`stdoutTail`) of a `codex exec --json` turn on gpt-6.1-sol, captured in a red-team campaign of 2026-10-19 (Codex CLI) | Actual `codex exec --json` error followed by `turn.failed`; stopped before work. |
| `openai-gpt-6-astra-max.json` | The same campaign, the same events of a turn on gpt-6-astra | Same terminal events on a second model. |
| `openai-app-cyberPolicy.json` | A captured Codex app-server agent log of a relay delegate job (October 2026) | Actual app-server `error` (`willRetry: false`) and `turn/completed`, with `codexErrorInfo: "cyberPolicy"`; stopped after work had been written. |
| `openai-app-capacity.json` | A captured app-server capacity failure, from another delegate job of the same run | Actual capacity failure: `serverOverloaded`, not a refusal. |
| `openai-review-capacity.json` | A captured app-server capacity failure in a review's reconciliation turn, from the same run | Actual reconciliation capacity failure, also `serverOverloaded`. |
| `claude-source-result.json` | Claude Code **2.1.302**, as described below | Source-derived shape, **not a captured live refusal**. Message is a test placeholder. |

Relay's job records were read, not modified, to confirm the job errors and to identify the
review's reconciliation participant. In both capacity cases the actual turn error is
`Selected model is at capacity. Please try a different model.` The classifier message is
retained verbatim in the OpenAI fixtures, including the vendor's suggestion to rephrase; relay
reports that suggestion as vendor text and never acts on it.

## Claude: what Claude Code 2.1.302 does, and the limits

Checked in Claude Code 2.1.302, without running it:

- Its stream-json `result` event combines the common result fields with the variant's own
  (`result` for success, `errors` for error_during_execution), and the common fields carry the
  final API stop reason (`stop_reason`), as the public SDK result schemas do. So a refusal can
  arrive with a success subtype; the source-derived fixture exercises that case.
- An assistant message is an API refusal when its `message.stop_reason` is `"refusal"`. Relay's
  parser also accepts that explicit stop reason on an assistant message, preserving text blocks
  without treating tool-use blocks as a completed answer.
- Claude Code's fallback to another model after a refusal is switched off by
  `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK`, and its same-model retry by
  `CLAUDE_CODE_DISABLE_REFUSAL_RETRY`. Relay sets both variables to `1` in the child environment
  and its higher-precedence settings env. It does not supply a fallback model.

Anthropic documents classifier intervention as the explicit API
[`stop_reason: "refusal"`](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/handle-streaming-refusals).
This can occur on a successful API response; success subtype or process exit status alone
cannot classify it. The
[streaming documentation](https://platform.claude.com/docs/en/build-with-claude/streaming)
places the API stop reason in `message_delta`; relay consumes Claude Code's stream-json
assistant/result wrappers, not raw API SSE events.

**Unverified:** no live Claude classifier stop, exact live Claude result subtype/is_error/text
combination, managed-settings overrides of the retry controls, other OpenAI safety codes or
message variants, and vendor refusal envelopes transported through ACP. No classifiers for
those unevidenced variants were invented. Ordinary agent text saying it cannot help is not
classified as a vendor safety stop. The refusal retry controls are checked at this CLI version,
not runtime-qualified here.
