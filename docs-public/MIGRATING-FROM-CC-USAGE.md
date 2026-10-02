# Moving from cc-usage to tokenhud

tokenhud is the successor to [cc-usage](https://github.com/ZhuoQiuMcgill/cc-usage), which is
frozen at v2.6.1. It reads the same Claude Code and Codex transcripts, keeps the same kind of
usage history, and imports everything cc-usage has recorded. cc-usage's files are only ever
read, so you can run both side by side for as long as you like.

## What comes over, and how

The first time you start the interactive `tokenhud`, it imports from `~/.config/cc-usage/`
(or `$XDG_CONFIG_HOME/cc-usage/`) on its own:

| From cc-usage | Into tokenhud | When |
|---|---|---|
| `ledger.sqlite3`: every usage event cc-usage recorded, including those whose transcripts Claude Code has since deleted | the usage store, `~/.config/tokenhud/tokenhud.db` | first run, if the store has no cc-usage import yet |
| `config.json`: account roots and their labels, disabled roots, theme, show-cost, refresh interval, default window | `~/.config/tokenhud/config.json` | first run, if tokenhud has no config yet |
| `provider-limits.json`: the last limits cc-usage fetched | `~/.config/tokenhud/limits.json` | while tokenhud has no limits of its own yet, so the limit cards aren't empty before the first fetch |
| `pricing.json`: your own price edits | `~/.config/tokenhud/pricing.overrides.json` | only with `tokenhud import-cc-usage` |

`tokenhud import-cc-usage` does the history, price and config import on demand, and prints
what it did. It is safe to run any number of times:

- Usage rows are keyed exactly as cc-usage keys them, so a row already in the store is
  never added twice, and usage tokenhud parses itself from a transcript matches the
  imported copy of the same event.
- Only the rows of your `pricing.json` that differ from cc-usage v2.6.1's bundled table are
  imported, and an override you already have in tokenhud is kept. An edit to a model
  tokenhud prices with dated or fast rates is skipped, with a warning: cc-usage's one flat
  price would replace all of them.
- The config is taken over only while tokenhud has none. After that, tokenhud's own settings
  win.

`--from DIR` imports from another cc-usage directory. The ledger is read through a private
snapshot copy; nothing under cc-usage's directory is written or renamed.

`tokenhud doctor` shows how many cc-usage rows are not in the store yet. After the first
run that should be zero.

## Why some numbers differ

On the same transcripts, tokenhud's totals match cc-usage's to the cent, except where
tokenhud corrects how cc-usage counted or priced something. The parity harness, run against
real data, checks that every difference is one of these:

| What | cc-usage | tokenhud | Effect |
|---|---|---|---|
| Codex subagent and fork rollouts | Counts the parent conversation each one replays at its start as new usage | Recognises the replayed part and skips it | Lower Codex tokens and cost; much lower with heavy subagent use |
| Codex priority (fast) tier | Prices every request at the standard rate | Prices requests made in priority mode at the priority rate, going by the session's own settings events | Higher Codex cost where you used priority mode |
| Claude fast mode | Prices every request at the standard rate | Prices `speed: "fast"` requests at the model's fast rate | Higher Claude cost where you used fast mode |
| Prices that changed over time (GPT-5.6 Sol, Terra and Luna) | One price for all dates: Sol at its launch rate, Terra and Luna at their current rates | Each request at the rate in effect when it was made | Sol lower from 2026-08-21; Terra and Luna higher before 2026-07-30 |
| `codex-auto-review` | Unpriced | Priced as an estimate, at the model OpenAI said serves it: GPT-5.4, then GPT-5.6 Luna from 2026-07-30 | Its tokens now count toward cost, reported as estimated |

Costs are always recomputed from the stored token counts and the current price table, so a
corrected price applies to all of your history at once.

## Running both

tokenhud and cc-usage don't share any files:

- tokenhud writes only under `~/.config/tokenhud/`. It never writes to cc-usage's directory,
  so cc-usage keeps working exactly as before.
- Both read the transcripts read-only. Each records new usage in its own history as it
  sees it.
- Usage that only cc-usage saw (say you ran just cc-usage for a week, and Claude Code then
  deleted those transcripts) is in cc-usage's ledger only. Run `tokenhud import-cc-usage`
  again to bring it over; rows already present are skipped.

## Retiring cc-usage

1. Run `tokenhud import-cc-usage` once more, so the store has everything cc-usage
   recorded.
2. Run `tokenhud doctor` and check that no cc-usage rows are missing from the store.
3. Uninstall cc-usage the way you installed it:

   ```sh
   uv tool uninstall cc-usage        # installed with uv
   pipx uninstall cc-usage           # installed with pipx
   rm -rf ~/.venvs/ccusage           # installed into a virtual environment
   ```

4. `~/.config/cc-usage/` stays where it is. tokenhud no longer needs it once the import is
   done; keep it as a backup for a while, then delete it when you are satisfied.

## Commands, side by side

| cc-usage | tokenhud |
|---|---|
| `ccusage` | `tokenhud` |
| `ccusage --once` | `tokenhud --once` |
| `ccusage --ledger-info` | `tokenhud doctor` |
| `ccusage --check-update` | `tokenhud update --check` |
| `ccusage --update` | `tokenhud update` |
| `ccusage --update-prerelease` | `tokenhud update --prerelease` |
| (none) | `tokenhud json` for scripts, `tokenhud mcp` for Claude Code agents |

Your settings carry over, including account labels; the README's "Keys" section lists
tokenhud's keys.
