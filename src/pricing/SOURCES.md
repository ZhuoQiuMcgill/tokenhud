# Price table sources

Evidence for every rate in `pricing.json` and for every dated boundary. All prices are
USD per 1M tokens. Nothing here comes from memory. Each rate was read from the pages
below, or from captures of them.

| Provider | Page | Checked |
| --- | --- | --- |
| Anthropic | https://platform.claude.com/docs/en/about-claude/pricing.md | 2026-11-09 (capture `anthropic_20261109222005.md`; before it, `anthropic_20261001172026.md`) |
| Anthropic release notes | https://platform.claude.com/docs/en/release-notes/overview.md | 2026-11-09 (capture `anthropic-release-notes_20261109222551.md`) |
| OpenAI | https://developers.openai.com/api/docs/pricing.md | 2026-10-01 (capture `live_20261001172025.md`) |
| OpenAI changelog | https://developers.openai.com/api/docs/changelog.md | 2026-10-01 (capture `changelog_20261001172026.md`) |

Captures live in `docs/pricing-history/` of the main checkout. They are evidence and are
never committed. A capture's file name carries its time in UTC (`YYYYMMDDhhmmss`).

## Anthropic

The standard cards started as cc-usage v2.6.1's table. Every row matches the live "Model
pricing" table of 2026-11-09:
- Fable 5.2 and Mythos 5.2 at $8/$40 with $0.20 cache hits (0.025x);
- Fable 5.1 and Mythos 5.1 at $10/$50 with $0.25 cache hits (0.025x);
- Fable 5 and Mythos 5 at $10/$50;
- Opus 5.5 at $4/$20 with $0.20 cache hits (0.05x);
- Opus 5, 4.8, 4.7, 4.6 and 4.5 at $5/$25;
- Sonnet 5.5 at $2/$10 with $0.10 cache hits (0.05x) since 2026-10-07 (see "Dated
  boundaries" below), and Sonnet 5 at $2/$10;
- Sonnet 4.6 and 4.5 at $3/$15;
- Haiku 5.5 at $0.10/$0.50, more above 100,000 prompt tokens (see "Claude Haiku 5.5 long
  context" below), and Haiku 4.5 at $1/$5.

The other cache rates follow the page's multipliers: 5m writes 1.25x, 1h writes 2x and cache
hits 0.1x, unless stated. The page's footnotes: "Cache hits and refreshes on Claude Fable
5.2, Claude Mythos 5.2, Claude Fable 5.1, and Claude Mythos 5.1 are priced at 0.025x the
base input price", and "on Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x".

Fable 5.2 and Mythos 5.2 launched on 2026-11-09 and Haiku 5.5 on 2026-10-07 (release notes,
under those dates). Each has one card, which applies for all time.

The page's footnote 3 says the Sonnet 5 introductory price of $2/$10 "is now the standard
price" and that the planned rise to $3/$15 on 2026-09-01 "will not occur".

### Dated boundaries

| Model | Effective from | Change | Evidence |
| --- | --- | --- | --- |
| claude-sonnet-5-5 | 2026-10-07T07:00:00Z | cache hits $0.20 (0.1x) -> $0.10 (0.05x); input, output and cache writes unchanged | Release notes, October 7, 2026: "We’ve lowered the price of prompt cache reads on Claude Sonnet 5.5 from $0.20 USD to $0.10 USD per million tokens: 0.05x the base input price instead of 0.1x. Cache writes and all other prices are unchanged." Captures: `anthropic_20261001172026.md` shows $0.20, `anthropic_20261109222005.md` $0.10. |

**An announced date means 00:00 America/Los_Angeles**, as for OpenAI (see "Rules" below):
Anthropic is also based there, and the release notes give no time or zone. That is 07:00Z
while daylight time is in effect, as on 2026-10-07. This is a ruling, not a fact.

### Claude Haiku 5.5 long context

The page lists two rows, "for prompts up to 100,000 tokens" and "for prompts over 100,000
tokens": $0.10/$0.50 (writes $0.125 and $0.20, hits $0.01) and $0.50/$2.50 (writes $0.625
and $1, hits $0.05). Every price is 5x above the threshold, so the card has
`long_context_threshold` 100000 and both multipliers at 5. The base card's cache rates are
the default multipliers.

"Long context pricing" says: "A request’s prompt length counts all of its input tokens,
including cache reads and cache writes. Each request is priced on its own: a request over
the threshold pays the higher prices even when part of its prompt is a cache hit". So the
card sets `long_context_counts_cache_writes`: its threshold counts input + cache reads +
cache writes, strictly greater than 100,000. Without that field a threshold counts input
and cache reads only, cc-usage's rule, which the OpenAI cards keep (Codex reports no cache
writes, so it makes no difference there).

The same section says every other Claude model 4.6 and later has "the full 1M token
context window at standard pricing", so no other Claude card has a threshold.

**Fast mode.** These cards come from the "Fast mode pricing" table: Fable 5.2 and Mythos 5.2
at $16/$80, Opus 5.5 at $8/$40, and Opus 5 and Opus 4.8 at $10/$50. The page says "Prompt
caching multipliers apply on top of fast mode pricing" and that "Fast mode pricing applies
across the full context window". So fast cards state only input and output, and `table.ts`
derives the cache rates:

- cache read = fast input × (standard cache read ÷ standard input): $0.40 on Fable 5.2 and
  Mythos 5.2 (0.025x), $0.40 on Opus 5.5 (0.05x), $1.00 on Opus 5 and 4.8 (0.1x);
- writes = 1.25x (5m) and 2x (1h) of the fast input.

The 2026-10-01 page also said: "Fast mode is not available on Claude Opus 4.7 (requests with
`speed: "fast"` return an error) or Claude Opus 4.6 (requests run at standard speed and are
billed at standard rates)." The 2026-11-09 page no longer names either model; the release
notes of June 29, 2026 say of Opus 4.6: "Requests to `claude-opus-4-6` with `speed: "fast"`
no longer run at fast speed or premium pricing: they run at standard speed, are billed at
standard rates, and do not return an error."
- **Opus 4.6** therefore has a fast card equal to its standard card ($5/$25), so a fast
  record prices exactly as a standard one.
- **Opus 4.7** and every other Claude model have no fast card. A fast record for them is
  `unpriced-tier`.

Fast cards need no long-context fields: "Fast mode pricing applies across the full context
window", and Haiku 5.5, the one Claude model with a threshold, has no fast mode.

## OpenAI

`scripts/extract-openai-pricing.ts` generates the OpenAI entries. It reads 17 archived HTML
captures of the pricing page, from 2026-07-16T10:31:53Z to 2026-09-04T10:30:51Z, plus the
live Markdown page of 2026-10-01T17:20:25Z.
- **Short-context prices** come from the Astro island props. The tier comes from the
  island's `tier` prop or, for the "Specialized models" table, from its tab pane.
- **Long-context prices** come from each island's server-rendered table, since the props
  don't carry them, and from the live page's long-context columns. The script checks every
  rendered row against the props.
- **The "Priority" tab is the fast tier.** The page renamed it "Fast" on 2026-07-30
  ("Priority processing was renamed Fast mode on July 30, 2026", first shown by
  `s_20260730195107`).

Rules:
- A change takes effect at the earliest capture that shows it, unless an official
  announcement gives the date.
- **An announced date means 00:00 America/Los_Angeles,** where OpenAI is based: 07:00Z
  while daylight time is in effect, as on every date here. The changelog gives no time or
  zone, so this is a ruling, not a fact.
- **A capture taken after that time that still shows the old price is page-update lag.**
  The announcement wins.
- The first known card also applies before the first capture.
- A long-context price is used only where the page lists one, for that model, tier and
  time. None is ever extrapolated (see "Long context" below).

The script checks that each announcement's quote appears in the changelog capture under
that date, and that it matches the kind of change the captures show (a price, or Fast long
context).

### Dated boundaries

| Model | Effective from | Change | Evidence |
| --- | --- | --- | --- |
| gpt-5.6-terra | 2026-07-30T07:00:00Z | $2.50/$15 (cached $0.25, writes $3.125) -> $2/$12 (cached $0.20, writes $2.50); fast $5/$30 (cached $0.50, writes $6.25) -> $4/$24 (cached $0.40, writes $5) | Changelog, Jul 30 2026: "Starting July 30, GPT-5.6 Luna costs 80% less, while GPT-5.6 Terra costs 20% less." Captures: `s_20260728103058` (2026-07-28T10:30:58Z) shows the old price, `s_20260730195107` (2026-07-30T19:51:07Z) the new one. |
| gpt-5.6-luna | 2026-07-30T07:00:00Z | $1/$6 (cached $0.10, writes $1.25) -> $0.20/$1.20 (cached $0.02, writes $0.25); fast $2/$12 (cached $0.20, writes $2.50) -> $0.40/$2.40 (cached $0.04, writes $0.50) | Same announcement and captures as gpt-5.6-terra. |
| gpt-5.6-sol | 2026-08-05T07:00:00Z | Fast: no long-context price -> long context at 2x input, cached input and writes, and 1.5x output | Changelog, Aug 5 2026: "Fast mode now supports long-context requests for GPT-5.6 Sol, GPT-5.6 Terra, and GPT-5.6 Luna. As of today, long-context prompts exceeding 272K tokens can run in Fast mode". Captures: up to `s_20260801091023` (2026-08-01T09:10:23Z), the Priority/Fast table has no long-context columns. From `s_20260815103025` (2026-08-15T10:30:25Z), it lists them. |
| gpt-5.6-terra | 2026-08-05T07:00:00Z | Fast: no long-context price -> long context at 2x/1.5x | Same announcement and captures as gpt-5.6-sol on 2026-08-05. |
| gpt-5.6-luna | 2026-08-05T07:00:00Z | Fast: no long-context price -> long context at 2x/1.5x | Same announcement and captures as gpt-5.6-sol on 2026-08-05. |
| gpt-5.6-sol | 2026-08-21T07:00:00Z | $5/$30 (cached $0.50, writes $6.25) -> $4/$20 (cached $0.40, writes $5); fast $10/$60 (cached $1, writes $12.50) -> $8/$40 (cached $0.80, writes $10) | Changelog, Aug 21 2026: "GPT-5.6 Sol now costs $4 per million input tokens and $20 per million output tokens", and "promotional pricing is available at least through November 21, 2026". Captures: `s_20260821103049` (2026-08-21T10:30:49Z) still shows $5/$30, which is page-update lag. `s_20260822103053` (2026-08-22T10:30:53Z) is the first to show $4/$20. |

**Fast prices change with the standard ones.** The price announcements state the standard
price. The fast price changed in the same capture in every case. The Jul 30 entry also
prices Fast relative to standard ("For GPT-5.6 Sol, Fast mode now delivers up to 2.5×
faster speeds than standard processing at twice the price"). So each fast price change
shares its model's boundary.

**The gpt-5.6-sol cut is earlier than the task's first estimate.** Going by captures alone,
it would date from 2026-08-22T10:30:53Z. Under the rules above it dates from
2026-08-21T07:00Z: 2026-08-21T06:59Z is $5/$30, and 07:00Z is $4/$20. The exact hour of
each change is unknown. Usage within a day of a boundary may be off by up to that day's
share of the price difference.

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
counts towards it.

**Standard long context.** The multipliers are the page's long-context columns divided by
the short ones: 2x for input, cached input and cache writes, and 1.5x for output. The
script checks that every column agrees.
- They apply to gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol,
  gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 and gpt-5.4.
- The rendered tables show them in every capture from 2026-07-16 on.
- gpt-5.4-mini, gpt-5.3-codex and gpt-5.2 have no long-context tier.

**Fast long context is never inherited.** In `pricing.json`, a fast card has a
long-context price only if it states its own `long_context_input_multiplier` and
`long_context_output_multiplier`. Those apply to its rates above the standard card's
threshold. A fast card without them has no long-context price: a fast record above the
threshold is `unpriced-tier`, never priced at the standard or an extrapolated rate. Fast
cards state multipliers only where the page lists long-context Fast prices:
- **GPT-6 Astra, 6.1 Sol, 6 Sol and 6 Luna**: listed (2x/1.5x), in every capture showing
  them and on the live page.
- **GPT-5.6 Sol, Terra and Luna**: listed (2x/1.5x) from 2026-08-05T07:00Z, per the
  boundary above. Before that there is no long-context Fast price.
- **gpt-5.5 and gpt-5.4**: the live page shows "-" in all four long-context Fast cells.
  There is no long-context Fast price, at any time.

## Estimated aliases

`pricing.json` → `aliases` holds model ids whose provider does not say which model served
a request. Such an id is priced as the model its alias timeline names at the time, and
every rate found through it carries `estimated: true`, so a caller can label the cost an
estimate. Only the bundled table has aliases; a user override that prices the alias id
itself wins and is not an estimate. An override of a target model (gpt-5.4 or
gpt-5.6-luna) is used by the alias too.

| Alias | Period | Priced as | Evidence |
| --- | --- | --- | --- |
| codex-auto-review | before 2026-03-05T08:00:00Z | (unpriced) | GPT-5.4 did not exist yet. Changelog, Mar 5: "Released GPT-5.4, our newest frontier model for professional work". |
| codex-auto-review | 2026-03-05T08:00:00Z to 2026-07-30T07:00:00Z | gpt-5.4 | OpenAI on X, 2026-07-30T17:17Z (https://x.com/OpenAI/status/2082878180478910571): "We're also upgrading Auto-review in the ChatGPT app and Codex CLI from GPT-5.4 to GPT-5.6 Luna." The same post from @OpenAIDevs (https://x.com/OpenAIDevs/status/2082878497043923265, 17:18Z): "We're upgrading auto review in the ChatGPT app and Codex CLI from GPT-5.4 to GPT-5.6 Luna." |
| codex-auto-review | from 2026-07-30T07:00:00Z | gpt-5.6-luna | Same posts. They accompany the Jul 30 price announcement (changelog: "Starting July 30, GPT-5.6 Luna costs 80% less"), also published as https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/ (that page refused automated fetches, HTTP 403, so its wording was not read here). |

Rulings, not facts:
- **The switch time.** The posts say "upgrading", on 2026-07-30. As with announced price
  dates above, the switch is placed at 00:00 America/Los_Angeles (07:00Z), the same instant
  as Luna's price cut. Auto-review usage between 07:00Z and the rollout of the upgrade is
  then priced as Luna although it may have run on GPT-5.4.
- **The start.** The posts say only what auto-review ran on before the switch. The gpt-5.4
  period starts at GPT-5.4's release (Mar 5, 00:00 America/Los_Angeles, which is 08:00Z in
  winter time), as ccusage's timeline does; auto-review usage before it stays unpriced.
- **Routing.** Auto-review is server-routed; OpenAI may route some requests elsewhere.
  That is why the rates are marked as estimates.

The post texts were read on 2026-10-01 through X's public embed endpoint
(`cdn.syndication.twimg.com/tweet-result`).

## Not modelled

These are deliberately absent; the task leaves them out of scope. Usage priced here is
standard or fast API-equivalent cost.
- **Batch** (both providers) and **OpenAI Flex**.
- **OpenAI Ultrafast** (gpt-6-astra, from 2026-09-29).
- **Regional uplifts**: the OpenAI regional-processing (data residency) and FedRAMP uplift
  of 10%, and the Anthropic data-residency multiplier of 1.1x (`inference_geo: "us"`,
  Claude 4.6 and later, on Haiku 5.5's long-context prices too).
- **Other providers' prices** for the same models, such as Bedrock, Google Cloud and Azure.
- **OpenAI models outside cc-usage's table**, such as gpt-5.5-pro, gpt-5.6-cyber and the
  older GPT-5 and GPT-4 models. They stay unpriced until someone adds them with evidence.
