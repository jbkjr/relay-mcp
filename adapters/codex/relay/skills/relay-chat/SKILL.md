---
name: relay-chat
description: Show a relay discussion's transcript and optionally add a message that both sides will see as coming from the user. Use only when the user asks for it by name.
---

The user's request follows the skill name (usage: `$relay-chat <discussion_id> [message]`).

1. Run `relay chat <discussion_id> --print` in the shell and show the transcript so far.
2. If the user gave a message, run `relay chat <discussion_id> --say "<message>"` with their words unchanged. The other agent sees it on its next turn and the calling agent on its next call, marked as coming from the human user.

For a continuous live view the user can run `relay chat <discussion_id>` in a terminal.

The relay tools are the tools of the `relay` MCP server.
