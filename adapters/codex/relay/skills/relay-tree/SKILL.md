---
name: relay-tree
description: Show the current relay run as a tree of jobs, consult threads, discussions and reviews. Use only when the user asks for it by name.
---

The user's request follows the skill name (usage: `$relay-tree [run_id]`).

Call the relay `status` tool with no id (or with the run id the user gave) and show the `tree` text as returned: target, mode, depth, status and elapsed time for every item.

The relay tools are the tools of the `relay` MCP server.
