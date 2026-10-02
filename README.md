# tokenhud

tokenhud is a terminal dashboard for your coding-agent usage. It reads the transcripts that
Claude Code and Codex write on your machine and shows, for every account, how close you are
to your subscription limits, what your usage would cost at API prices, and where it went:
by day, by model and by account. It keeps that history after the transcripts are deleted.
It also runs an MCP server, so a Claude Code agent can check its own account's limits and
wait for a reset instead of failing halfway through a task.

tokenhud succeeds [cc-usage](https://github.com/ZhuoQiuMcgill/cc-usage) and imports its
history on first run.

```
 tokenhud   1 Overview   2 History   3 Models   4 Accounts              scope all accounts   as of 15:10
─────────────────────────────────────────────────────────────────────────────────────────────────────────

 LIMITS                                     pace = spend rate over the last 30 min · times are estimates
 ╭─ personal · claude ─────────────────────────────╮  ╭─ old-laptop · claude ──────────────────────────╮
 │ 5h   ━━━━━━━━━━━━━━━━━━━━━━━         78%  1h47m │  │ not signed in here                             │
 │ week ━━━━━━━━                        27%  4d05h │  │                                                │
 │ pace $1.3/h → hits 100% at 16:29                │  │ pace $0/h   → idle                             │
 ╰─────────────────────────────────────────────────╯  ╰────────────────────────────────────────────────╯
 ╭─ work · claude (47m old) ───────────────────────╮  ╭─ codex · codex ────────────────────────────────╮
 │ 5h   ━━━━                            12%  3h54m │  │ 5h   ━━                              8%  4h30m │
 │ week ━━━                              9%  2d10h │  │ week ━━━━━━━━━━━━━━━━━━━━━━━━       83% 19h04m │
 │ pace $0/h   → idle                              │  │ pace $0.04/h → week ends ~89%                  │
 ╰─────────────────────────────────────────────────╯  ╰────────────────────────────────────────────────╯

 SPEND                                                                           * not all tokens priced
                today    this week   this month     all-time
  cost        $10.07*      $21.38*      $13.48*     $226.19*
  tokens         8.5M        20.7M        12.5M       240.9M

 ACTIVITY · cost per 15 min · 24h                                                    peak $1.46 at 01:00
 $1.46                                        █                                             ▃ ▃ ▃ ▃
                                              █                                             █ █ █ █
                                              █                             ▄               █ █ █ █
 $0.73                                        █                             █               █ █ █ █
                                              █                            ▂█           ▁▃  █ █ █ █  ▁
                                              █                            ██           ██  █ █ █ █  █▁
     0                                        █▆                           ██           ██  █ █ █ █  ██
       -24h                    -18h                    -12h                   -6h                   now

 TOP MODELS · 24h
 Opus 4.8                    $7.66  76% ━━━━━
 gpt-5.6-sol                 $1.42  14% ━
 gpt-5.5                     $0.99  10% ━
 Mystery 9                unpriced   0%

 LIMIT EVENTS · 7 days
  Fri 12:10  work      5-hour limit reached  —
  Mon 13:10  personal  5-hour limit reached  resumed 15:10
  Wed 01:10  codex     weekly passed 80%     —
```

<sub>`tokenhud --once --width 105` on made-up accounts and usage.</sub>

## Install

**Linux and macOS:**

```sh
curl -fsSL https://raw.githubusercontent.com/ZhuoQiuMcgill/tokenhud/main/install.sh | sh
```

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/ZhuoQiuMcgill/tokenhud/main/install.ps1 | iex
```

Both download the binary for your machine from
[GitHub Releases](https://github.com/ZhuoQiuMcgill/tokenhud/releases), check its SHA-256
against the release's `SHA256SUMS`, and install it without sudo or admin rights:
`install.sh` to `~/.local/bin/tokenhud` (it tells you if that isn't on your PATH),
`install.ps1` to `%LOCALAPPDATA%\tokenhud\bin\tokenhud.exe`, which it adds to your user
PATH. Running either again reinstalls, or updates to the newest release.

| Variable | Effect |
|---|---|
| `TOKENHUD_VERSION` | Install this release, e.g. `0.1.0` or `0.1.0-rc.1`. Default: the latest stable release; until there is one, name a release candidate here |
| `TOKENHUD_INSTALL` | Install into this directory instead |
| `TOKENHUD_NO_MODIFY_PATH` | `1`: `install.ps1` leaves your PATH alone |

```sh
curl -fsSL https://raw.githubusercontent.com/ZhuoQiuMcgill/tokenhud/main/install.sh | TOKENHUD_VERSION=0.1.0-rc.1 sh
```

```powershell
$env:TOKENHUD_VERSION = '0.1.0-rc.1'; irm https://raw.githubusercontent.com/ZhuoQiuMcgill/tokenhud/main/install.ps1 | iex
```

**Alpine and other musl-based Linux** need the C++ runtime the binary links against:
`apk add libstdc++ libgcc`.

**By hand:** download `tokenhud-<os>-<arch>` (`linux-x64`, `linux-arm64`, `linux-x64-musl`,
`linux-arm64-musl`, `darwin-x64`, `darwin-arm64`, `windows-x64.exe`, `windows-arm64.exe`)
and `SHA256SUMS` from a release, check it with `sha256sum --check --ignore-missing
SHA256SUMS` (`shasum -a 256 --check --ignore-missing SHA256SUMS` on macOS), make it
executable and put it on your PATH. On macOS, a binary downloaded with a web browser is
quarantined, and macOS refuses to start it, because tokenhud's binaries are signed but not
notarized. Clear the flag with `xattr -d com.apple.quarantine tokenhud-darwin-arm64` (or
`-x64`). `install.sh` downloads with curl, which doesn't set the flag.

**npm** (once the packages are published):

```sh
npm install -g tokenhud     # or run it without installing: npx tokenhud, bunx tokenhud
```

The `tokenhud` package is a small launcher that runs a prebuilt binary from a platform
package (`@tokenhud/linux-x64` and so on), which npm installs as an optional dependency.
Don't install it with `--omit=optional`. The launcher needs Node 18 or later; on a machine
with Bun but no Node, use `bunx tokenhud`.

## First run

Run `tokenhud`. It finds your Claude Code and Codex accounts (see [Accounts](#accounts)),
and on its first start:

- if you used cc-usage, it imports cc-usage's usage history and settings
  ([what comes over](docs-public/MIGRATING-FROM-CC-USAGE.md));
- it reads every transcript once to build its store. That takes a few seconds; after that,
  it reads only what's new as the agents write it.

`tokenhud --once` prints the Overview once and exits: with colours in a terminal, as plain
text when piped. `--width N` sets its width. `tokenhud doctor` reports what tokenhud found:
the store, the accounts it follows, unpriced models, and anything still only in cc-usage.

## Keys

| Key | Does |
|---|---|
| `1-4` | Switch view: Overview, History, Models, Accounts |
| `a` | Cycle the account scope: all accounts, then each account, then all again |
| `s` | Open settings |
| `?` | Show the keys, the current view's included |
| `q` or `Ctrl-C` | Quit |

The footer shows the keys of the view you are in.

### Overview

| Key | Does |
|---|---|
| `←/→` | Change the activity span: the last 5 hours, 24 hours or 7 days |
| `t` | Show cost or tokens; the top models follow (`↑/↓` too) |
| `tab` | Select the next account card; `esc` clears the selection |
| `enter` | Open the selected card's account (the first card's when none is selected) in Accounts |

### History

| Key | Does |
|---|---|
| `tab` | Move between the heat map and the table |
| `←→↑↓` | On the heat map, a week back or forward and a day up or down; in the table, a row |
| `d/w/m` | Group the table by day, week or month |
| `W/M` | List the days of this week, or of this month |
| `enter` | On a week or month, list its days; on a day, list its limit events |
| `/` | Filter every number by model: type part of a model id, `enter` applies it |
| `esc` | Close the open week, month or day, then clear the filter |

### Models

| Key | Does |
|---|---|
| `←/→` | Change the window: today, this week, this month or all time (and the last 1, 5 or 24 hours on a wide screen) |
| `↑/↓` | Select a model |
| `enter` | Show or hide the selected model's rates and who used it |
| `o` | Sort by cost, tokens or name |

### Accounts

| Key | Does |
|---|---|
| `↑/↓` | Select an account |
| `enter` | Scope every view to that account; again, back to all accounts |
| `e` | Turn the account off or on |
| `l` | Rename (label) it |
| `h` | Mark it history only, or not |

### Settings

| Key | Does |
|---|---|
| `↑/↓` | Move |
| `enter` | Change the selected setting, or pick a value |
| `esc` | Back; from the main list, back to the view |
| `e`, `l`, `h` | Under Accounts: turn an account off or on, rename it, mark it history only |

Settings are the refresh interval, the default spend window, whether to show cost, the
theme (dark, light, high contrast), the time zone, whether to check for updates, and the
accounts. They are saved in `~/.config/tokenhud/config.json`.

## Views

1. **Overview**: a card per account with its 5-hour and weekly limits (how full, and how
   long until each resets), its spend pace over the last 30 minutes, and what that pace
   leads to: the time it hits 100 %, where the week ends, or "safe until reset". A card
   says when its limits are stale, or "not signed in here" for an account that isn't. Then
   the agents using tokenhud's MCP server, spend for today, this week, this month and all
   time (also the last 1 and 5 hours on a wide screen), activity over the last 5 hours, 24
   hours or 7 days, the top models, and the past week's limit events.
2. **History**: a 26-week calendar heat map of daily cost, a card for the selected day
   (cost, tokens, models and any limit hits), and a table by day, week or month with each
   period compared to the 30-day average. A model filter narrows every number to one model.
3. **Models**: a rate board: every model's input, output and cache tokens with the rate it
   is billed at, its cost and its share, for the window you pick. The selected model's card
   shows all of its rates, where they come from, and how its use splits across accounts.
4. **Accounts**: every account with its status and highest limit use; the selected one in
   detail: its config directory and history, its limit windows and when they reset, its
   weekly usage at the last 8 resets, 30 days of spend, its models, and its agents' recent
   MCP calls.

The layout adapts to the terminal: it is laid out for half of a 1080p screen (about 105 ×
50), the top half of a portrait monitor (about 120 × 45), 80 × 24 and wider. Costs
marked `*` include tokens with no price; see [Pricing](#pricing).

## Accounts

An account is one Claude Code or Codex config directory. tokenhud finds:

- **Claude Code:** `~/.claude`, `$CLAUDE_CONFIG_DIR`, and every `~/.claude-*` directory
  (`~/.claude-work` is labelled `work`);
- **Codex:** `~/.codex` and `$CODEX_HOME`;
- **under WSL**, the same directories on the Windows side (`/mnt/c/Users/*/.claude*`,
  `/mnt/c/Users/*/.codex*`), labelled with a `-win` suffix. `TOKENHUD_WSL_USERS=` (empty)
  skips them.

Directories elsewhere go in `config.json` as `claude_roots` or `codex_roots`, for example
`"claude_roots": [{"path": "/srv/claude-ci", "label": "ci"}]`. In the Accounts view, or in
settings under Accounts, you can turn any account off, rename it, or mark it history only.
`a` narrows every view to one account.

**History-only accounts.** An account that isn't signed in on this machine any more (it now
runs on another computer, say) keeps all of its history. Its card says "not signed in
here" instead of showing an error, and tokenhud checks its limits only once a day, or never
once you mark it history only (`h`).

## Use with Claude Code

tokenhud's MCP server lets a Claude Code agent check the limits of the account it runs
on, decide whether to pause, and wait for a reset. That matters most for sessions that
can't resume on their own: `claude -p`, background tasks and teammates. Interactive
Claude Code resumes by itself after a reset, so there an agent should tell you instead of
waiting.

### Install

[Install tokenhud](#install) first, so `tokenhud` is on the PATH Claude Code starts with:
the plugin and the MCP server both run `tokenhud mcp`. Otherwise `/mcp` in Claude Code
shows the server as failed.

Plugins and user-scope MCP servers belong to one Claude config dir, so install once per
account: once for `~/.claude`, and once more for each `CLAUDE_CONFIG_DIR` you use.
`tokenhud doctor` shows which accounts have it, and whether `tokenhud` is on the PATH.

**The plugin** adds the MCP server and a skill that tells agents when to use it:

```sh
claude plugin marketplace add ZhuoQiuMcgill/tokenhud
claude plugin install tokenhud@tokenhud

# another account
CLAUDE_CONFIG_DIR=~/.claude-work claude plugin marketplace add ZhuoQiuMcgill/tokenhud
CLAUDE_CONFIG_DIR=~/.claude-work claude plugin install tokenhud@tokenhud
```

**The MCP server on its own:**

```sh
claude mcp add -s user tokenhud -- tokenhud mcp
CLAUDE_CONFIG_DIR=~/.claude-work claude mcp add -s user tokenhud -- tokenhud mcp
```

**Native Windows:** an npm install puts a `tokenhud.cmd` shim on the PATH, which Claude
Code can't start directly. Register the server through `cmd` instead of installing the
plugin: `claude mcp add -s user tokenhud -- cmd /c tokenhud mcp`. The standalone
`tokenhud.exe` (installed with `install.ps1`) works directly, plugin included.

### Tools

| Tool | What it does |
|---|---|
| `limits` | The account's limit windows (5-hour, weekly, per model): utilization from 0 to 1, reset time, spend pace, and when the window would run out at that pace (an estimate). Fetches fresh limits when the cached ones are over 60 s old. |
| `should_wait` | `wait: true` when a window is at 90 % or more (`min_headroom`, default 0.1), when `estimated_cost` (USD) would take it there, or when it is projected to run out within 10 minutes, before its reset. The 5-hour and weekly windows always count; a per-model window (such as a model's weekly limit) counts only when `model` names that model, and is otherwise just mentioned. Returns a short reason and `wait_s`: until the reset, plus 30 s. |
| `wait_for_reset` | Waits until the window `should_wait` binds on (for the same `model`) resets, or its utilization drops under `until_utilization_below`, for at most `max_wait_s` (5 hours or less). Sends progress every 30 s, re-checks the limits every 5 minutes, and stops at once when the call is cancelled. |
| `usage` | Tokens and API-equivalent cost for a period, optionally by model, account, day, week or month (at most 500 groups per call), as `tokenhud json usage` prints them ([schema](docs-public/JSON.md)), plus `stale_s`, the age of the store's data. |
| `accounts` | The accounts on this machine, from cached data only: whether their limits can be read here (`signed_in`, null until first checked), their last usage, and which one this session runs on. |

Every tool answers for the account the session runs on: `CLAUDE_CONFIG_DIR`, else
`~/.claude`, confirmed by finding the session's transcript. `limits` reports how it was
found (`detected_via`). Pass `account` (a label from `accounts`) for another account, or
`provider: "codex"` for Codex. An account that isn't signed in on this machine reports
`signed_in: false`, and `should_wait` doesn't make agents wait on it.

## Scripts: `tokenhud json`

```sh
tokenhud json usage --period this_week --group-by day
tokenhud json models --period today
tokenhud json accounts
```

Each prints one JSON document from the store, with the same queries the MCP server uses.
[docs-public/JSON.md](docs-public/JSON.md) documents the options, the output and the
schema-1 contract.

## Pricing

Costs are API-equivalent: what the tokens would cost at the providers' published API
prices, not what your subscription costs. Each request is priced by its model, its date
(prices that changed apply from the day they changed), its tier (Claude fast mode, Codex
priority), long context, and cache reads and writes. The bundled table and where every price
comes from are in [src/pricing](src/pricing) (`pricing.json`, `SOURCES.md`).

- A model with no price is counted but not priced. Its cost shows as `unpriced`, totals that
  leave tokens out are marked `*`, and `tokenhud doctor` lists the models and how much of
  your usage is priced.
- `codex-auto-review` is priced as an estimate, at the model OpenAI said serves it.
- Costs are recomputed from the stored token counts every time, so a price correction
  applies to all of your history.

**Your own prices** go in `~/.config/tokenhud/pricing.overrides.json`, which holds only your
entries; rates are USD per 1 million tokens:

```json
{
  "models": {
    "my-local-model": { "input": 3, "output": 15, "cache_read": 0.3 },
    "gpt-5.6-sol": {
      "periods": [
        { "from": null, "card": { "input": 5, "output": 30, "cache_read": 0.5 } },
        { "from": "2026-08-21T07:00:00Z", "card": { "input": 4, "output": 20, "cache_read": 0.4 } }
      ]
    }
  }
}
```

`input` and `output` are required. `cache_read` defaults to a tenth of `input` and
`cache_write` to 1.25 × `input`; `fast` holds a fast or priority card in the same form. An
entry replaces everything the bundled table says about that model, its dated prices and
fast card included. Because the file holds only your entries, later corrections to the
bundled table still reach every other model. An entry tokenhud can't read is skipped, with
a warning in `tokenhud doctor`.

## Data and privacy

- **Provider data is read-only.** tokenhud reads the transcripts under Claude Code's and
  Codex's config directories, and never writes, moves or deletes anything there.
- **It stores token counts, not content:** per request, its time, model, token counts and
  account. No prompts, responses or file contents. (`cache.db` remembers which transcript
  files it has read, by path, so it can pick up where it left off.)
- **Credentials stay in memory.** To show a Claude account's limits, tokenhud reads that
  account's OAuth token from its credentials file and calls Anthropic's usage endpoint; when
  the token has expired, it lets the `claude` command refresh it. For Codex it asks the
  installed `codex` app server. Tokens are never logged, cached or sent anywhere else.
- **Network:** the limit requests above, and GitHub's list of tokenhud releases: when you
  run `tokenhud update`, and at most once a day while the TUI runs, to show when a newer
  release is out (settings, "Check for updates", turns that off). No telemetry; prices are
  bundled, never fetched.

tokenhud's own files are in `~/.config/tokenhud/` (or `$XDG_CONFIG_HOME/tokenhud/`):

```
tokenhud.db               your usage history: the only copy of usage whose transcripts are gone
tokenhud.db.bak           a verified daily backup of it, and tokenhud.db.bak.prev before that
cache.db                  how far each transcript has been read (safe to delete: it is rebuilt)
config.json               settings
pricing.overrides.json    your prices, if any
limits.json               the last limits fetched
update-check.json         when GitHub was last asked about a newer release, and its answer
logs/tokenhud.log         errors, for tokenhud doctor and bug reports
mcp/                      which MCP servers are running, for the Overview
ingest.lock.db            which tokenhud process writes the store
```

A store that can't be read is renamed `tokenhud.db.corrupt-<time>` and its history
recovered into a new one; it is never deleted.

## Update and uninstall

```sh
tokenhud update --check     # is there a newer release?
tokenhud update             # install it
```

A binary from `install.sh` or `install.ps1` replaces itself: it downloads the new release,
checks its SHA-256 against the release's `SHA256SUMS`, checks that it starts, and only then
swaps it in. `--prerelease` includes release candidates. For an npm, npx or bunx install,
`tokenhud update` prints the command that updates it instead.

Nothing updates on its own. When a newer release is out, the TUI says so in its footer, in
dim text; it asks GitHub at most once a day, and the "Check for updates" setting turns that
off.

To uninstall:

1. Remove the binary: `rm ~/.local/bin/tokenhud`; on Windows, delete
   `%LOCALAPPDATA%\tokenhud` and remove its `bin` folder from your user PATH (Settings ›
   System › About › Advanced system settings › Environment Variables). For npm:
   `npm uninstall -g tokenhud`.
2. Remove it from Claude Code, once per account: `claude plugin uninstall tokenhud@tokenhud`
   or `claude mcp remove -s user tokenhud`.
3. If you no longer want your usage history, delete `~/.config/tokenhud/`.

## Development

Prerequisite: [Bun](https://bun.com) 1.4.2 or later. CI pins 1.4.2; Bun 1.3.12 and 1.4.0
produced macOS binaries with broken signatures.

```sh
bun install      # dependencies and dev tooling
bun run check    # typecheck (tsc), lint and format check (Biome), tests (bun test)
bun run build    # standalone binary for this machine at dist/tokenhud
bun src/cli.ts   # run from source
```

`bun run build --target=<bun target>` cross-compiles one binary, for example
`--target=bun-windows-x64` writes `dist/tokenhud.exe`. `bun run build --release` builds all
eight release binaries and `SHA256SUMS` (install with `bun install --os="*" --cpu="*"`
first), and `bun run build --smoke` runs the ones this machine can. `bun run format`
rewrites files in the project style. [VERSIONING.md](VERSIONING.md) describes releases.

Repository layout:

```
src/cli.ts         entry point: parses arguments and dispatches commands
src/commands/      one module per subcommand: json, mcp, doctor, import-cc-usage, update
src/tui/           the interactive views, --once, settings
src/ingest/        reading transcripts into the store, live
src/sources/       the Claude Code and Codex transcript parsers, and account discovery
src/limits/        subscription limits, pace and limit events
src/mcp/           the MCP server: account detection, the tools, waiting for a reset
src/query/         the query layer: periods, totals and groupings, priced to the cent
src/store/         the SQLite usage store, its hourly rollup, backups and recovery
src/pricing/       the dated price table and the cost engine
src/update.ts      tokenhud update: install method, releases, verified replacement
test/              bun test suites
scripts/build.ts   builds, checksums and smoke-tests the binaries
install.sh         the Linux and macOS installer; install.ps1 is the Windows one
npm/               the npm launcher; scripts/stage-npm.ts builds the npm packages
plugin/            the Claude Code plugin (listed by .claude-plugin/marketplace.json)
```

## License

[MIT](LICENSE)
