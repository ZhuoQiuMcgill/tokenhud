# Changelog

All notable changes to tokenhud are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and tokenhud
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); see
[VERSIONING.md](VERSIONING.md) for what counts as breaking while the version is 0.x.

## [Unreleased]

The first release, v0.1.0: tokenhud succeeds cc-usage 2.6.1 and imports its history.

### Added

- **Interactive TUI** (`tokenhud`) with four views: Overview (limits per account, spend,
  24-hour activity, top models, limit events), History, Models and Accounts. Layouts for
  half a 1080p screen, a portrait half, 80 × 24 and wide terminals; a settings screen;
  dark, light and high-contrast themes. It reads stored totals, so it starts and switches
  views without rescanning transcripts.
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

### Differences from cc-usage

Numbers match cc-usage to the cent except where tokenhud corrects it: Codex subagent
replays are no longer counted twice, Codex priority and Claude fast requests are priced at
their tier, prices that changed over time apply by date, and `codex-auto-review` is priced
as an estimate. [docs-public/MIGRATING-FROM-CC-USAGE.md](docs-public/MIGRATING-FROM-CC-USAGE.md)
has the details.
