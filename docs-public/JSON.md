# `tokenhud json` and `doctor --json`: output reference (schema 1)

`tokenhud json` prints usage and cost as JSON for scripts and agents. The TypeScript types in
[`src/query/types.ts`](../src/query/types.ts) (`Json*`) are the source of truth;
`doctor --json` is `DoctorReport` in [`src/commands/doctor.ts`](../src/commands/doctor.ts).

## The schema-1 contract

Every document carries `"schema": 1`. While it does:
- the fields documented here keep their names, types and meaning;
- new fields may be added, so consumers should ignore fields they don't know;
- any change that would break a consumer comes with a new `schema` number instead.

## Conventions

- Every document starts with `schema` (1), `generated_at` (ISO-8601 UTC) and `warnings`
  (problems that did not stop the answer, e.g. a malformed `pricing.overrides.json`).
- Instants are ISO-8601 strings in the query's zone, e.g. `2026-09-28T00:00:00.000-04:00`.
  Ranges are half-open: `from` inclusive, `to` exclusive.
- Money is USD (`cost_usd`), rounded to 1e-6. Token counts are integers.
- Unpriced tokens are never $0: they are counted in `coverage` and listed in `unpriced`.
- The store is read as it is (read-only connection, no ingest), unless `--refresh` asks for
  one ingest pass first. Without a store yet, every query answers zeros.
- Exit codes: 0 ok (document on stdout); 2 bad arguments; 1 store error. On 1 and 2,
  stderr holds `{"schema":1,"error":{"code":"bad_argument"|"store_error","message":"…"}}`
  and stdout is empty.

## Arguments

```
tokenhud json usage    [--period P] [--group-by G] [--account A]... [--provider X]... [--tz ZONE] [--refresh]
tokenhud json models   [--period P] [--account A]... [--provider X]... [--tz ZONE] [--refresh]
tokenhud json accounts [--period P] [--tz ZONE] [--refresh]
```

| Option | Values |
|---|---|
| `--period` | `today`, `this_week` (Monday 00:00), `this_month` (the 1st), `all` (default: the store's first to last row), `1h`, `5h`, `24h` (rolling, ending now inclusive), `custom` |
| `--since`, `--until` | A custom period. `YYYY-MM-DD` is local midnight in `--tz`; as `--until` it includes that day. Otherwise an ISO-8601 instant with `Z` or an offset. Nothing before 1970. `--until` defaults to now. Either one implies `--period custom`. |
| `--group-by` | `model`, `account`, `day`, `week`, `month` (`usage` only) |
| `--account` | A label (case-insensitive) or an id; repeatable |
| `--provider` | `claude` or `codex`; repeatable |
| `--tz` | An IANA zone; default the config's `time_zone` (`config.json`), else the system zone (`TZ` is honoured) |
| `--refresh` | First run one incremental ingest pass (what the transcripts added since the last one), under the single-writer ingest lock. Skipped, with a warning, while another tokenhud process holds the lock and keeps the store current; a pass that could not store anything is a warning too |

## Shared pieces

```jsonc
// usage: the aggregate of a set of rows
{
  "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "total": 0 },
  "records": 0,              // usage rows (API responses)
  "cost_usd": 0,             // priced tokens only, estimated included
  "estimated_cost_usd": 0,   // part of cost_usd from an estimated price (codex-auto-review)
  "coverage": {
    "priced_tokens": 0, "unpriced_tokens": 0, "unpriced_tier_tokens": 0,
    "estimated_tokens": 0,   // subset of priced_tokens
    "priced_pct": 100        // 0-100, two decimals; 100 with no tokens
  }
}
// period
{ "name": "this_week" | "custom" | …, "from": "…" | null, "to": "…" | null, "tz": "America/Toronto" }
// account
{ "id": 1, "label": "personal", "provider": "claude" }
```

`unpriced-tier` tokens belong to a priced model at a tier it has no price for (e.g. a fast
request on a model without a fast card) or to a long-context row whose tier has no
long-context price.

## `json usage`

```jsonc
{
  "schema": 1, "generated_at": "…", "warnings": [],
  "query": "usage",
  "period": { … },
  "filter": { "accounts": [account] | null, "providers": ["codex"] | null },
  "group_by": "day" | null,
  "totals": { …usage, "unpriced": [{ "model": "codex-unattributed", "tier": "standard", "reason": "unpriced" | "unpriced-tier", "tokens": 0 }] },
  "groups": [ … ]   // [] without --group-by
}
```

Group shapes (each also carries every `usage` field):

| `group_by` | Extra fields | Order |
|---|---|---|
| `model` | `model` (normalised id), `tier` (`standard`/`fast`), `share` (of total cost), `status` (`priced`, `unpriced`, `unpriced-tier`, `partial`), `rates` | most cost first |
| `account` | `account`, `share` | most cost first; idle accounts included |
| `day`, `week`, `month` | `key` (`YYYY-MM-DD`; a week is keyed by its Monday; `YYYY-MM`), `from`, `to`, `top_model` | chronological; empty groups included; the first and last are clipped to the period |

`rates` is the tier's card in effect now, USD per 1M tokens, or null when unpriced:
`{ "input", "output", "cache_read", "cache_write", "long_context": { "threshold", "input_multiplier", "output_multiplier" } | null, "estimated" }`.
`cache_write` is the card's own rate, else the 5-minute rate (1.25x input). `estimated` is
true when the rates are another model's standing in for this one (an estimated alias, such
as `codex-auto-review`); that model's cost is then all in `estimated_cost_usd`.

## `json models`

`{ schema, generated_at, warnings, "query": "models", period, filter, totals, "models": [model group] }`

## `json accounts`

`{ schema, generated_at, warnings, "query": "accounts", period, "accounts": [{ …account, …usage, "share", "first_seen", "last_seen" }] }`

`first_seen`/`last_seen` are the account's first and last rows of all time (null if none).

## `doctor --json`

```jsonc
{
  "schema": 1, "generated_at": "…",
  "store": {
    "path", "exists", "error",            // error: why the store couldn't be read, else null
    "damaged",                             // the next ingest moves it aside and recovers it
    "size_bytes",                          // database plus WAL
    "schema_version", "key_scheme", "created_at",
    "rows", "rows_by_provider": { "claude": 0 },
    "accounts": [{ "id", "label", "provider", "rows", "first_seen", "last_seen" }],
    "models",                              // distinct models with rows
    "first_seen", "last_seen",
    "imports": [{ "at", "source", "lineage", "rows", "accounts" }],
    "migration_report",                    // a record of key-scheme migrations, or null
    "rollups": { "triggers_intact", "counts_agree" } | null,
    "long_context_index",
    "backup": { "path", "at", "age_hours", "previous_at" },   // at: null before the first
    "recovery": {
      "pending": [{ "file", "why" }],      // files still to merge; why: damaged, missing, held
      "merged_lineages",                   // other stores whose history this one absorbed
      "last_report": { "at", "summary", "still_pending": [] } | null
    }
  },
  "pricing": {
    "bundled": { "anthropic": { "url", "checked" }, "openai": { … } },
    "overrides": { "path", "exists", "models", "warnings": [] },
    "priced_pct", "priced_tokens", "unpriced_tokens", "unpriced_tier_tokens",
    "estimated_tokens", "estimated_cost_usd",
    "unpriced": [{ "model", "tier", "tokens" }],
    "unpriced_tier": [{ "model", "tier", "tokens" }]
  },
  "cc_usage": {
    "dir", "ledger",                       // ledger: whether ledger.sqlite3 exists
    "last_import": { … } | null,
    "rows_only_in_cc_usage": 0 | null,     // null: see note
    "note": null | "…"
  },
  "sources": {                             // every discovered root; each is one account
    "cache": { "path", "exists" },
    "roots": [{
      "label", "provider", "found_by",     // found_by: auto, env, config, home, wsl
      "enabled", "history_only",
      "mode",                              // watched, polled (a Windows drive under WSL), off
      "transcripts",                       // tracked by the cache; null without one
      "last_ingest"                        // when a pass last covered the root, or null
    }]
  },
  "claude_code": {
    "tokenhud_on_path", "npm_shim",        // npm_shim: a Windows .cmd Claude Code can't start
    "accounts": [{
      "label",
      "plugin",                            // "enabled", "installed" (switched off) or null
      "mcp",                               // a user-scope MCP server running tokenhud mcp
      "hook"                               // the alert hook: "plugin", "settings" (settings.json),
    }]                                     //   "both" (it runs twice) or null
  }
}
```

Doctor prints config paths only (the store and its backup, the overrides file, the cursor
cache, cc-usage's directory); never transcript, prompt or credential paths. Roots go by
their labels.

## `tokenhud hook`

The Claude Code hook that delivers the limit alerts agents set with the MCP server's
`set_alert` tool. Claude Code runs it on `PostToolBatch`, `UserPromptSubmit` and
`SessionEnd` with its hook event on stdin (`session_id`, `transcript_path`,
`hook_event_name`, …; see Claude Code's hooks reference). When one or more alerts fire, it
prints Claude Code's hook reply, one line per alert:

```json
{"hookSpecificOutput":{"hookEventName":"PostToolBatch","additionalContext":"[tokenhud alert] 5-hour limit (personal) is at 82% (alert at 80%), resets in 1h12m. Note: pause the refactor and commit. Call should_wait before long tasks."}}
```

`hookEventName` is the event it ran for. Otherwise, and on `SessionEnd` (which removes the
session's alerts), it prints nothing. It always exits 0: a failure (unreadable input, say)
is written once to `logs/hook.log` and never reaches the agent. The command line the plugin
registers is `tokenhud hook; exit 0`, and `tokenhud mcp install --hooks` writes the same
with the binary's full path, so a tokenhud without `hook` exits 0 with nothing on stdout
too.
