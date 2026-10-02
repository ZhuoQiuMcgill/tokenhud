# Changelog

All notable changes to tokenhud are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and tokenhud
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); see
[VERSIONING.md](VERSIONING.md) for what counts as breaking while the version is 0.x.

## [Unreleased]

The first release, v0.1.0: tokenhud succeeds cc-usage 2.6.1 and imports its history. The
release candidate 0.1.0-rc.1 has all of it.

### Added

- **Interactive TUI** (`tokenhud`) with four views, each with its own keys (`?` lists them):
  - **Overview:** a card per account with its 5-hour and weekly limits, time to each reset,
    spend pace and its projection (when the window hits 100 %, where the week ends, or safe
    until reset), marked when the limits are stale or the account isn't signed in here;
    the MCP agents at work; spend from the last hour to all time; activity over 5 hours,
    24 hours or 7 days, in cost or tokens; the top models; the past week's limit events.
    `w`/`s` select a card and `enter` opens its account.
  - **History:** a 26-week calendar heat map, the selected day's card with its limit hits,
    and a table of this week, this month, every day, the weeks or the months against the
    30-day average, and a filter that narrows every number to one model.
  - **Models:** a rate board (tokens, the rates each model is billed at, cost and share) for
    a window you pick, sortable, with the selected model's full rates, their sources, and
    which accounts used it.
  - **Accounts:** every account with its status; the selected one's root, history, limit
    windows, weekly use at the last 8 resets, 30 days of spend, models and agents. Accounts
    can be scoped to, turned off, renamed or marked history only from their menu.

  Layouts for half a 1080p screen, a portrait half, 80 × 24 and wide terminals; a settings
  screen; dark, light and high-contrast themes. It reads stored totals, so it starts and
  switches views without rescanning transcripts. While it runs, it fetches each account's
  limits itself, and a damaged ingest lock is repaired, or the TUI stays read-only with the
  reason and retries.
- **`tokenhud --once`** prints the Overview once, for scripts and terminals without a TUI.
- **Usage store** (`~/.config/tokenhud/tokenhud.db`): every usage event tokenhud parses, as
  token counts only, kept after Claude Code deletes the transcript. Hourly rollups keep the
  views fast at any size. A verified backup is made daily; a damaged store is set aside and
  recovered, never deleted.
- **Claude Code and Codex ingest**: every account's transcripts, followed live; Windows-side
  accounts under WSL are found and polled. Several accounts, each its own config dir, are
  told apart and labelled.
- **History-only accounts**: an account that isn't signed in on this machine keeps its full
  history without limit errors.
- **Subscription limits** for Claude and Codex accounts: 5-hour and weekly windows (and
  per-model ones), reset times, spend pace, projected exhaustion, and limit events.
- **Roots on one subscription account**: config dirs signed in to the same Claude (or
  ChatGPT) account, such as `~/.claude` and its Windows-side twin under WSL, share one
  limits card, one fetch, and a pace summed over all of them; history stays per root.
  tokenhud finds them when their limits reset together and their use moves together, and
  re-checks every 30 minutes that they still do; settings link or unlink them by hand
  (`same_account`, `separate_accounts` in `config.json`). MCP answers for the shared
  account from either root, and `tokenhud doctor` lists the groups.
- **Pricing**: a bundled price table with effective dates, fast and priority tiers, long
  context, and estimated prices for `codex-auto-review`; your own overrides in
  `pricing.overrides.json`, which never hide later corrections to the bundled prices.
  Costs are recomputed from token counts, so a price fix applies to all history.
- **`tokenhud json`**: usage, models and accounts as JSON (schema 1) for scripts and agents.
- **`tokenhud doctor`**: store health, backups, pricing coverage, roots, rows still only in
  cc-usage, and whether each Claude account has the plugin or MCP server.
- **MCP server** (`tokenhud mcp`) and **Claude Code plugin**: `limits`, `should_wait`,
  `wait_for_reset`, `usage` and `accounts`, so agents can check their own account's limits
  and wait for a reset instead of failing.
- **Import from cc-usage**: automatic on first run (history, settings, last limits), and
  `tokenhud import-cc-usage` for price edits or a later re-import. cc-usage's files are only
  read.
- **Install**: standalone binaries for Linux (x64, arm64; glibc and musl), macOS (x64,
  arm64) and Windows (x64, arm64) on GitHub Releases with SHA-256 checksums; `install.sh`
  and `install.ps1`; an npm package (`tokenhud`) that runs the right binary.
- **`tokenhud update`**: updates a standalone binary in place after checking its checksum,
  or tells npm, npx and bunx users the command. `--check` only reports. The TUI notes a
  newer release in its footer, checking at most once a day (a setting turns it off); it
  never updates on its own.

### Changed since 0.1.0-rc.1

- **Keys: one movement scheme for every view**, all within reach of the left hand. `a`/`d`
  (or `←`/`→`) switch the tab, `w`/`s` (or `↑`/`↓`) move the selection, `enter` opens it
  and `esc` goes back one step, in every view, the settings screen and the new account
  menu. Letters work with Caps Lock on. A view with tabs shows them as a strip,
  `◀ a … d ▶`, and the footer takes two lines from 30 rows: the view's keys, then the
  global ones. What moved:
  - account scope `a` → `c`; settings `s` → `x`; `tab` and `shift-tab` now switch views;
  - History: `d`/`w`/`m` and `W`/`M` → its tabs (this week, this month, days, weeks,
    months), on this week at first; the heat map is no longer a focus of its own and
    highlights the selected row's day, week or month; the filter `/` → `f` (`/` still
    works);
  - Overview: `tab` → `w`/`s` select a card; `↑`/`↓` no longer switch cost and tokens (`t`
    does);
  - Models: sort `o` → `r` (`o` still works);
  - Accounts and the settings account editor: `e`/`l`/`h` → `enter`, which opens the
    account's menu (show only it, enable or disable, rename, history only).

### For contributors

- Tests can never start the real `claude` or `codex`: a test guard puts stubs first on
  every test's PATH and the product refuses any other client under test. Every test file
  calls `guard()`, and every process `src/` starts gets an explicit environment; a lint
  test enforces both.
- CI is deterministic on Linux, macOS and Windows, and `.github/workflows/repeat.yml` runs
  the suite many times on demand to measure flakiness.
- `.github/workflows/release.yml` builds, tests and publishes a release from a `v*` tag, and
  runs everything but publishing on pull requests that touch the release path.

### Differences from cc-usage

Numbers match cc-usage to the cent except where tokenhud corrects it: Codex subagent
replays are no longer counted twice, Codex priority and Claude fast requests are priced at
their tier, prices that changed over time apply by date, and `codex-auto-review` is priced
as an estimate. [docs-public/MIGRATING-FROM-CC-USAGE.md](docs-public/MIGRATING-FROM-CC-USAGE.md)
has the details.
