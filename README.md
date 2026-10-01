# tokenhud

A live terminal heads-up display for your coding-agent usage: Claude Code and Codex
subscription limits per account, cost history, and an MCP server so agents can check
their own limits and wait for a reset instead of failing mid-task.

> **Status: early development.** Nothing is usable yet. tokenhud is the TypeScript (Bun)
> successor to [cc-usage](https://github.com/ZhuoQiuMcgill/cc-usage), which is now frozen.
> When tokenhud ships, it will import cc-usage's usage history.

## Use with Claude Code

tokenhud's MCP server lets a Claude Code agent check the limits of the account it runs
on, decide whether to pause, and wait for a reset. That matters most for sessions that
can't resume on their own: `claude -p`, background tasks and teammates. Interactive
Claude Code resumes by itself after a reset, so there an agent should tell you instead of
waiting.

### Install

Plugins and user-scope MCP servers belong to one Claude config dir, so install once per
account: once for `~/.claude`, and once more for each `CLAUDE_CONFIG_DIR` you use.
`tokenhud doctor` shows which accounts have it.

**The plugin** adds the MCP server and a skill that tells agents when to use it:

```sh
claude plugin marketplace add ZhuoQiuMcgill/tokenhud
claude plugin install tokenhud@tokenhud

# another account
CLAUDE_CONFIG_DIR=~/.claude-work claude plugin marketplace add ZhuoQiuMcgill/tokenhud
CLAUDE_CONFIG_DIR=~/.claude-work claude plugin install tokenhud@tokenhud
```

The plugin runs `tokenhud mcp` when `tokenhud` is on your PATH, and `npx -y tokenhud@0 mcp`
otherwise. That fallback downloads about 37 MB the first time, which can take longer than
Claude Code waits for an MCP server to start (`MCP_TIMEOUT`). Install tokenhud first, or
raise `MCP_TIMEOUT` for the first run. The plugin starts the server through `sh`, so on
native Windows add the MCP server on its own instead.

**The MCP server on its own:**

```sh
claude mcp add -s user tokenhud -- tokenhud mcp
CLAUDE_CONFIG_DIR=~/.claude-work claude mcp add -s user tokenhud -- tokenhud mcp
```

### Tools

| Tool | What it does |
|---|---|
| `limits` | The account's limit windows (5-hour, weekly, per model): utilization from 0 to 1, reset time, spend pace, and when the window would run out at that pace (an estimate). Fetches fresh limits when the cached ones are over 60 s old. |
| `should_wait` | `wait: true` when a window is at 90 % or more (`min_headroom`, default 0.1), when `estimated_cost` (USD) would take it there, or when it is projected to run out within 10 minutes, before its reset. Returns a short reason and `wait_s`: until the reset, plus 30 s. |
| `wait_for_reset` | Waits until the window resets, or its utilization drops under `until_utilization_below`, for at most `max_wait_s` (5 hours or less). Sends progress every 30 s, re-checks the limits every 5 minutes, and stops at once when the call is cancelled. |
| `usage` | Tokens and API-equivalent cost for a period, optionally by model, account, day, week or month (at most 500 groups per call), as `tokenhud json usage` prints them ([schema](docs-public/JSON.md)), plus `stale_s`, the age of the store's data. |
| `accounts` | The accounts on this machine: whether their limits can be read here (`signed_in`), their last usage, and which one this session runs on. |

Every tool answers for the account the session runs on: `CLAUDE_CONFIG_DIR`, else
`~/.claude`, confirmed by finding the session's transcript. `limits` reports how it was
found (`detected_via`). Pass `account` (a label from `accounts`) for another account, or
`provider: "codex"` for Codex. An account that isn't signed in on this machine reports
`signed_in: false`, and `should_wait` doesn't make agents wait on it.

## Development

Prerequisite: [Bun](https://bun.com) 1.4.2 or later. CI pins 1.4.2; Bun 1.3.12 and 1.4.0
produced macOS binaries with broken signatures.

```sh
bun install      # the MCP SDK (the one runtime dependency) and dev tooling
bun run check    # typecheck (tsc), lint and format check (Biome), tests (bun test)
bun run build    # standalone binary for this machine at dist/tokenhud
```

`tokenhud json` output for scripts and agents is documented in
[docs-public/JSON.md](docs-public/JSON.md) (schema 1).

`bun run format` rewrites files in the project style. `bun run build --target=<bun target>`
cross-compiles; for example, `--target=bun-windows-x64` writes `dist/tokenhud.exe`.

Repository layout:

```
src/cli.ts         entry point: parses arguments and dispatches commands
src/version.ts     the version, taken from package.json at build time
src/commands/      one module per subcommand: json, mcp, doctor, import-cc-usage
src/mcp/           the MCP server: account detection, the tools, waiting for a reset
src/query/         the query layer: periods, totals and groupings, priced to the cent
src/store/         the SQLite usage store and its hourly rollup
src/pricing/       the dated price table and the cost engine
test/              bun test suites; they run the CLI in a subprocess
scripts/build.ts   wrapper around bun build --compile
plugin/            the Claude Code plugin (listed by .claude-plugin/marketplace.json)
```

## License

[MIT](LICENSE)
