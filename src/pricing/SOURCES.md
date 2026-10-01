# Price table sources

Evidence for every rate in `pricing.json` and for every dated boundary. All prices are
USD per 1M tokens. Nothing here comes from memory. Each rate was read from the pages
below, or from captures of them.

| Provider | Page | Checked |
| --- | --- | --- |
| Anthropic | https://platform.claude.com/docs/en/about-claude/pricing.md | 2026-10-01 (capture `anthropic_20261001172026.md`) |
| OpenAI | https://developers.openai.com/api/docs/pricing.md | 2026-10-01 (capture `live_20261001172025.md`) |
| OpenAI changelog | https://developers.openai.com/api/docs/changelog.md | 2026-10-01 (capture `changelog_20261001172026.md`) |

Captures live in `docs/pricing-history/` of the main checkout. They are evidence and are
never committed. A capture's file name carries its time in UTC (`YYYYMMDDhhmmss`).

## Anthropic

The standard cards are cc-usage v2.6.1's table, unchanged. Every row matches the live
"Model pricing" table: Fable 5.1 and Mythos 5.1 at $10/$50 with $0.25 cache hits (0.025x);
Fable 5 and Mythos 5 at $10/$50; Opus 5.5 at $4/$20 with $0.20 cache hits (0.05x); Opus 5,
4.8, 4.7, 4.6 and 4.5 at $5/$25; Sonnet 5.5 and Sonnet 5 at $2/$10; Sonnet 4.6 and 4.5 at
$3/$15; Haiku 4.5 at $1/$5. The other cache rates follow the page's multipliers: 5m writes
1.25x, 1h writes 2x and cache hits 0.1x, unless stated.

No Anthropic model has dated periods. The page's footnote 3 says the Sonnet 5 introductory
price of $2/$10 "is now the standard price" and that the planned rise to $3/$15 on
2026-09-01 "will not occur".

**Fast mode.** These cards come from the "Fast mode pricing" table: Opus 5.5 at $8/$40, and
Opus 5 and Opus 4.8 at $10/$50. The page says "Prompt caching multipliers apply on top of
fast mode pricing" and that "Fast mode pricing applies across the full context window". So
fast cards state only input and output, and `table.ts` derives the cache rates:

- cache read = fast input × (standard cache read ÷ standard input): $0.40 on Opus 5.5
  (0.05x), $1.00 on Opus 5 and 4.8 (0.1x);
- writes = 1.25x (5m) and 2x (1h) of the fast input.

Fast mode "is not available on Claude Opus 4.7 … or Claude Opus 4.6", so those models, and
every other Claude model, have no fast card. A fast record for them is `unpriced-tier`.

## OpenAI

`scripts/extract-openai-pricing.ts` generates the OpenAI entries. It reads 17 archived HTML
captures of the pricing page, from 2026-07-16T10:31:53Z to 2026-09-04T10:30:51Z, plus the
live Markdown page of 2026-10-01T17:20:25Z. The HTML captures carry their price rows as
Astro island props. The tier comes from the island's `tier` prop or, for the "Specialized
models" table, from its tab pane. The "Priority" tab is the fast tier; the page renamed it
"Fast" on 2026-07-30 ("Priority processing was renamed Fast mode on July 30, 2026", first
shown by `s_20260730195107`).

Rules:
- A change takes effect at the earliest capture that shows the new price, unless an
  official announcement gives the date.
- The changelog gives dates without a time or zone. An announced date is taken as 00:00
  UTC. This is an assumption.
- The first known card also applies before the first capture.

The script checks that each announcement's quote appears in the changelog capture under
that date.

### Dated boundaries

| Model | Effective from | Change (standard; fast) | Evidence |
| --- | --- | --- | --- |
| gpt-5.6-terra | 2026-07-30T00:00:00Z | $2.50/$15 (cached $0.25, writes $3.125) -> $2/$12 (cached $0.20, writes $2.50); fast $5/$30 (cached $0.50, writes $6.25) -> $4/$24 (cached $0.40, writes $5) | Changelog, Jul 30 2026: "Starting July 30, GPT-5.6 Luna costs 80% less, while GPT-5.6 Terra costs 20% less." Captures: `s_20260728103058` (2026-07-28T10:30:58Z) shows the old price, `s_20260730195107` (2026-07-30T19:51:07Z) the new one. |
| gpt-5.6-luna | 2026-07-30T00:00:00Z | $1/$6 (cached $0.10, writes $1.25) -> $0.20/$1.20 (cached $0.02, writes $0.25); fast $2/$12 (cached $0.20, writes $2.50) -> $0.40/$2.40 (cached $0.04, writes $0.50) | Same announcement and captures as gpt-5.6-terra. |
| gpt-5.6-sol | 2026-08-21T00:00:00Z | $5/$30 (cached $0.50, writes $6.25) -> $4/$20 (cached $0.40, writes $5); fast $10/$60 (cached $1, writes $12.50) -> $8/$40 (cached $0.80, writes $10) | Changelog, Aug 21 2026: "GPT-5.6 Sol now costs $4 per million input tokens and $20 per million output tokens", and "promotional pricing is available at least through November 21, 2026". Captures: `s_20260821103049` (2026-08-21T10:30:49Z) still shows $5/$30, `s_20260822103053` (2026-08-22T10:30:53Z) is the first to show $4/$20. |

**Fast prices change with the standard ones.** The announcements state the standard price.
The fast price changed in the same capture in every case. The Jul 30 entry also prices Fast
relative to standard ("For GPT-5.6 Sol, Fast mode now delivers up to 2.5× faster speeds
than standard processing at twice the price"). So each fast change shares its model's
boundary.

**gpt-5.6-sol conflicts with the task's first estimate.** Going by captures alone, the cut
would date from 2026-08-22T10:30:53Z. The changelog dates it Aug 21, so 2026-08-21T23:59Z is
already $4/$20. The 10:30Z capture that day still showed the old price. The docs page
probably lagged the billing change, but the exact hour is unknown, so some usage on Aug 21
could be off by up to one day's worth of the price difference. To revert to the capture
rule, delete the gpt-5.6-sol entry from `ANNOUNCEMENTS` and re-run the script.

### Models without dated periods

Each of these has one card in every capture where it appears. The card applies for all
time.

| Model | Standard | Fast | Seen |
| --- | --- | --- | --- |
| gpt-6-astra | $10/$50, cached $1, writes $12.50 | $20/$100, cached $2, writes $25 | from `wb_20260904103051` (absent from `wb_20260902103226`); changelog: released Sep 3 |
| gpt-6.1-sol | $2/$10, cached $0.10, writes $2.50 | $4/$20, cached $0.20, writes $5 | live page only; changelog: released Sep 29, same standard prices |
| gpt-6-sol | $2/$10, cached $0.20, writes $2.50 | $4/$20, cached $0.40, writes $5 | live page only; changelog: released Sep 22, same standard prices |
| gpt-6-luna | $0.10/$0.50, cached $0.01, writes $0.125 | $0.20/$1, cached $0.02, writes $0.25 | live page only; changelog: released Sep 22, same standard prices |
| gpt-5.5 | $5/$30, cached $0.50 | $12.50/$75, cached $1.25 | every capture |
| gpt-5.4 | $2.50/$15, cached $0.25 | $5/$30, cached $0.50 | every capture |
| gpt-5.4-mini | $0.75/$4.50, cached $0.075 | $1.50/$9, cached $0.15 | every capture (the row lost its empty cache-write cell on 2026-09-04: same prices) |
| gpt-5.3-codex | $1.75/$14, cached $0.175 | $3.50/$28, cached $0.35 | every capture ("Specialized models", Codex) |
| gpt-5.2 | $1.75/$14, cached $0.175 | $3.50/$28, cached $0.35 | every capture |

### Long context

The live page says "Short context: ≤272K input tokens. Long context: >272K input tokens."
So the threshold is 272,000 and the test is strictly greater. As in cc-usage, cached input
counts towards it. The multipliers are the page's long-context columns divided by the short
ones: 2x for input, cached input and cache writes, and 1.5x for output. The script checks
that every column agrees.
- The multipliers apply to gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol,
  gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 and gpt-5.4.
- gpt-5.4-mini, gpt-5.3-codex and gpt-5.2 have no long-context tier.
- The rendered tables in the captures show the same multipliers back to 2026-07-16, so
  every period uses them.

Fast cards inherit the standard card's long-context settings. That matches the live page
for the GPT-6 and GPT-5.6 families; Fast long context for GPT-5.6 launched on 2026-08-05,
per the changelog. For gpt-5.5 and gpt-5.4, the page lists no long-context Fast price.
The standard multipliers are applied to them as an assumption.

## Not modelled

These are deliberately absent; the task leaves them out of scope. Usage priced here is
standard or fast API-equivalent cost.
- **Batch** (both providers) and **OpenAI Flex**.
- **OpenAI Ultrafast** (gpt-6-astra, from 2026-09-29).
- **Regional uplifts**: the OpenAI regional-processing (data residency) and FedRAMP uplift
  of 10%, and the Anthropic data-residency multiplier of 1.1x (`inference_geo: "us"`,
  Claude 4.6 and later).
- **Other providers' prices** for the same models, such as Bedrock, Google Cloud and Azure.
- **Claude long-context premiums**: the current page lists none for any model in this
  table ("Claude 4.6 and later models … include the full 1M token context window at
  standard pricing").
- **OpenAI models outside cc-usage's table**, such as gpt-5.5-pro, gpt-5.6-cyber and the
  older GPT-5 and GPT-4 models. They stay unpriced until someone adds them with evidence.
