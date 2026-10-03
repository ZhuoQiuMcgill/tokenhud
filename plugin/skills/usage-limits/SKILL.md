---
name: usage-limits
description: Check this Claude account's usage limits (5-hour and weekly rate limits) and decide whether to pause until a reset. Use before a long autonomous run or many subagents, and whenever a rate-limit or "usage limit reached" error appears.
---

# Usage limits

The tokenhud MCP tools report the account this session runs on. Their names end in
`limits`, `should_wait`, `wait_for_reset`, `usage` and `accounts`.

1. Before a long autonomous run, before starting many subagents, or as soon as a
   rate-limit or usage-limit error appears, call `should_wait`. Pass `model` (your model
   id, e.g. `claude-opus-4-8`) if you know it: per-model weekly limits only count for
   their model. Pass `estimated_cost` (USD) if you can guess what the work will cost.
2. If `wait` is false, carry on.
3. If `wait` is true:
   - **Non-interactive session** (`claude -p`, a background task, a teammate): call
     `wait_for_reset` with the same `model` and `max_wait_s` up to 18000. It reports
     progress while it waits. When it returns, call `should_wait` again before going on.
   - **Interactive session:** don't block. Tell the user the `reason` and when the
     window resets, and let them decide.
4. "not signed in on this machine" means limits are unknown here: don't wait for them.

`limits` lists every window with its reset time. `projected_exhaustion_at` (and
`projected_exhaustion_in_s`, the seconds until it) is an estimate. `usage` gives tokens and API-equivalent cost, not the quota. Never guess limits
or reset times from memory: ask the tools.
