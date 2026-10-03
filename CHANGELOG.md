# Changelog

All notable changes to tokenhud are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and tokenhud
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); see
[VERSIONING.md](VERSIONING.md) for what counts as breaking while the version is 0.x.

## [Unreleased]

### Changed

- **A projected 100 % counts down.** A limits card said `100% at 12:13` (or
  `100% ~Sun evening` for a weekly window), which left the subtraction to you. It now says
  how long first, rounded up so it never says later than it is, and the time second where
  the card has room: `100% in <2h (12:13)`, `100% in ~3d (~Sun evening)`, `100% now` under
  a minute. Narrower, the time goes first, then the `in` (`100% <2h`); a weekly card drops
  `this week` from its pace before its time. The countdown is worked out afresh each time
  the screen is drawn.
- **The Accounts view shows each window's projection**, under its meter, in the same form.
- **The Overview's top models follow the activity chart's window.** They always covered
  the last 24 hours, even beside a 5-hour or 7-day chart. `a`/`d` now switch both between
  the last 5 hours, 24 hours and 7 days, and the title names the window
  (`TOP MODELS · 7d`). When a row is free, a dim `more windows: 3 Models` under the list
  points to the Models view for today, this week, this month and the rest.

### Added

- **MCP:** `limits` and `should_wait` give `projected_exhaustion_in_s`, the whole seconds
  until `projected_exhaustion_at` (null when there is none).

## [0.1.2] - 2026-10-02

### Fixed

- **Bar charts draw a baseline where usage is zero.** An idle stretch in the Overview's
  activity chart (or the Accounts view's charts) was blank, so one chart could read as two.
  Zero is now a dim `▁` along the bottom row, and bars start at `▂`, so `▁` only ever means
  zero, with or without colour.

## [0.1.1] - 2026-10-02

### Fixed

- **The Overview's activity chart fills its width in every window.** At a wide terminal
  the 7-day chart stopped at about 60 % of the row, its bars one cell each; now the bars
  widen to fill it, spread so they differ by at most one cell, and the ticks follow.
- **A new release on npm never lacks its binary.** For 0.1.0, npm served
  `@tokenhud/linux-x64` as a 404 for about 10 minutes after it was published, and
  `bun add -g tokenhud` installed tokenhud without it, leaving a command that only said its
  binary was missing. Releases now publish `tokenhud` only once every platform package's
  tarball downloads from npm and matches its integrity.
- **When the binary's package is missing**, the `tokenhud` command names a failed download
  as a cause too, and how to reinstall right after a release
  (`bun remove -g tokenhud && bun add -g --no-cache tokenhud`, or
  `npm install -g --prefer-online tokenhud`). `tokenhud doctor` points out such an install,
  bun's or npm's, with the same command.

### Changed

- The README says what Bun's `Blocked 1 postinstall` after `bun add -g tokenhud` is:
  tokenhud's Windows-only `preinstall`, harmless on Linux and macOS, best left blocked.

### For contributors

- Releases publish to npm as a trusted publisher (OIDC), with no token or secret, on npm
  11.21.0, and move only `tokenhud`'s `next` tag. A prerelease older than the one on `next`
  goes under `next-<major>.<minor>`, so `next` never moves backwards.
  `scripts/publish-npm.ts` does the publishing; CI runs it with the real npm against a
  registry on localhost that serves a tarball late.

## [0.1.0] - 2026-10-02

The first release: tokenhud succeeds cc-usage 2.6.1 and imports its history. It is the same
code as the release candidate 0.1.0-rc.2, the first one on npm; 0.1.0-rc.1 had the first
part of it.

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
  re-checks every 30 minutes that they still do, and at once when a credential file
  changes; settings link or unlink them by hand (`same_account`, `separate_accounts` in
  `config.json`). MCP answers for the shared account from either root, and re-checks it
  too; finding new links is left to the TUI's 5-minute limits fetches. `tokenhud doctor`
  lists the groups.
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
- **Install**: `bun add -g tokenhud`, which needs no Node, or `npm install -g tokenhud`: a
  launcher that runs the right prebuilt binary. Standalone binaries for Linux (x64, arm64;
  glibc and musl), macOS (x64, arm64) and Windows (x64, arm64) on GitHub Releases with
  SHA-256 checksums, and `install.sh` and `install.ps1` to install them.
- **`tokenhud update`**: updates a bun or npm install through its package manager, and a
  standalone binary in place after checking its checksum; tells npx and bunx users the
  command. `--check` only reports, `--print` prints the command. The TUI notes a newer
  release in its footer, checking at most once a day (a setting turns it off); it never
  updates on its own.

### Changed since 0.1.0-rc.1

- **Install and update with Bun.** `bun add -g tokenhud` is the recommended install on Linux
  and macOS, and needs no Node; npm keeps working everywhere. On Linux and macOS the command
  is now a small sh script that starts the binary, so no JS runtime runs and nothing in the
  directory you run it in (a `.env`, a `bunfig.toml`) reaches tokenhud, whichever package
  manager installed it. On Windows, tokenhud is supported through npm, whose install script
  sets up a Node launcher, or `install.ps1`; Bun isn't supported there yet (`bun add -g`
  installs a command that fails with `"/bin/sh" not found`), and `tokenhud doctor` says so
  if it finds a bun install, with how to switch. `tokenhud update` on a bun
  or npm install asks the package manager which version the `latest` tag points at (`next`
  for a release candidate, while `next` is no older), installs exactly that version, checks
  that the `tokenhud` command runs it, and never installs an older version unless given
  `--allow-downgrade`; it used to print the command. `--print` prints the command instead.
  On Windows the running `tokenhud.exe` is moved aside meanwhile, so the package manager
  replaces the old copy whole. On musl Linux (Alpine), the binary's package is now installed
  by name beside tokenhud (`@tokenhud/linux-x64-musl`): as an optional dependency, Bun would
  download it on every Linux machine, since it ignores `libc`.
- **`tokenhud doctor` lists every tokenhud on PATH**, with its version and how it was
  installed, and marks the one a shell runs. It warns when tokenhud is installed more than
  one way or an older copy comes first, names the command that removes the extra one, quoted
  so it can be pasted (it never removes anything), and checks that bun's bin directory is on
  PATH. `tokenhud update` warns after updating when another copy comes first on PATH.
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
- **One name for each thing on screen.** History shows models by name (`Opus 5.5`), as the
  other views do, and its filter finds a model by name or id; Accounts counts `requests`,
  as Models does; the Overview's agents card names each session's project (the name of
  its directory, never the path) where it said "claude session".

### Fixed since 0.1.0-rc.1

- **Weekly projections no longer carry a 30-minute burst over the whole week.** A weekly
  window is projected at its average pace since it began, idle time and nights included
  (after its first 6 hours; until then, the last 30 minutes'); the 5-hour window keeps the
  30-minute pace. Two agents working at once for half an hour no longer say a weekly limit
  runs out tonight. A weekly window's time shows as a part of a day, never to the minute
  (`100% ~Sun evening`, `~tomorrow morning`), and each card's pace says which it is:
  `pace $X/h (30m)` or `avg $X/h this week`. MCP's `limits` and `should_wait` report
  `pace_basis` (`30m` or `window_avg`) with each window's pace and projection.
- **An idle card with a nearly full window says so**: `idle · week 83%`, in red, instead of
  a plain `idle` that read as fine.

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
