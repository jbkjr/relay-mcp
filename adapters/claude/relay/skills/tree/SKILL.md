---
description: Show the current relay run as a tree of jobs, consult threads, discussions and reviews.
argument-hint: "[run_id]"
---

Request: $ARGUMENTS

Call the relay `status` tool with no id (or with the run id the user gave) and show the `tree` text as returned: target, mode, depth, status and elapsed time for every item.

The relay tools are the MCP tools named `mcp__relay__*`.
