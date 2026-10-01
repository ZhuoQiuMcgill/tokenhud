"""Generate the cost parity fixtures from cc-usage's own cost function.

Run with cc-usage's interpreter (it must import cc_usage v2.6.1), with Bun on PATH:

    /mnt/d/Projects/CC_Usage/.venv/bin/python scripts/gen-cost-parity.py

Writes:
  src/pricing/cc-usage-v2.6.1-pricing.json
                                cc-usage's bundled table: the same data, reformatted for
                                Biome. `tokenhud import-cc-usage` compares the user's
                                pricing.json with it.
  test/fixtures/pricing/cost-parity.json
                                deterministic pseudo-random usage records, each with
                                cc_usage.cost.compute_cost's result:
                                - "cases": every model in that table. Zeros, null ephemeral
                                  buckets, long-context crossings at threshold - 1,
                                  threshold and threshold + 1, and huge counts up to
                                  2**53 - 1.
                                - "card_cases": random rate cards with odd decimal rates and
                                  non-power-of-two multipliers, chosen so that regrouping
                                  any one cost term (see VARIANTS) changes the result. The
                                  bundled rates are too round to catch that: with 2x and
                                  1.5x multipliers most regroupings come out bit-identical.

Everything is synthetic numbers: no transcript data. Python's float repr round-trips, so
JSON carries every expected cost bit for bit. The files then go through the repo's Biome
formatter, which only re-wraps long number arrays and shortens exponents
(7.275e-05 -> 7.275e-5): same values.
"""

from __future__ import annotations

import json
import random
import subprocess
import sys
from importlib.resources import files
from pathlib import Path

import cc_usage
from cc_usage.cost import CACHE_READ_MULT, Rates, compute_cost, get_rates

CC_USAGE_VERSION = "2.6.1"
SEED = 20261001
CASES_PER_MODEL = 200
# Models without a long-context tier still get the crossing cases, at OpenAI's threshold.
DEFAULT_THRESHOLD = 272_000
LINE_WIDTH = 100  # biome.json formatter.lineWidth
# Each regrouping in VARIANTS must change the result of at least this many card cases.
CASES_PER_VARIANT = 30
MAX_CANDIDATES = 500_000

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "fixtures" / "pricing"


def tokens(rng: random.Random) -> int:
    r = rng.random()
    if r < 0.08:
        return 0
    if r < 0.30:
        return rng.randint(1, 2_000)
    if r < 0.75:
        return rng.randint(2_000, 400_000)
    if r < 0.97:
        return rng.randint(400_000, 20_000_000)
    return rng.randint(10**9, 10**13)


def edge_cases(threshold: int) -> list[tuple]:
    cases: list[tuple] = [
        (0, 0, 0, 0, None, None),
        (0, 0, 0, 0, 0, 0),
        (0, 0, 0, 0, None, 0),
        (0, 0, 0, 0, 0, None),
        (1, 1, 1, 1, None, None),
        (0, 0, 0, 1_000, None, 1_000),
        (0, 0, 0, 1_000, 1_000, None),
    ]
    for delta in (-1, 0, 1):
        n = threshold + delta
        third = n // 3
        cases += [
            (n, 1_000, 0, 0, 0, 0),
            (0, 1_000, n, 0, 0, 0),
            (third, 5_000, n - third, 2_000, None, None),
            (third, 5_000, n - third, 3_000, 1_000, 2_000),
        ]
    for big in (10**9, 10**12, 10**15, 2**53 - 1):
        cases += [
            (big, big, big, big, None, None),
            (big, 0, 0, big, big, 0),
            (0, big, 0, big, 0, big),
        ]
    return cases


def random_case(rng: random.Random, threshold: int) -> tuple:
    if rng.random() < 0.25:
        total = threshold + rng.randint(-50, 50)
        inp = rng.randint(0, total)
        cache_read = total - inp
    else:
        inp, cache_read = tokens(rng), tokens(rng)
    out = tokens(rng)
    mode = rng.random()
    if mode < 0.3:
        e5 = e1 = None
    elif mode < 0.4:
        e5, e1 = None, tokens(rng)
    elif mode < 0.5:
        e5, e1 = tokens(rng), None
    else:
        e5, e1 = tokens(rng), tokens(rng)
    # Usually the buckets sum to the total, as in real transcripts; sometimes not, which
    # cc-usage tolerates (the bucket path ignores the total).
    if (e5 is None and e1 is None) or rng.random() < 0.3:
        creation = tokens(rng)
    else:
        creation = (e5 or 0) + (e1 or 0)
    return (inp, out, cache_read, creation, e5, e1)


def random_card(rng: random.Random) -> Rates:
    def rate(top: float) -> float:
        return round(rng.uniform(0.01, top), rng.choice((2, 3, 4)))

    long_context = rng.random() < 0.7
    return Rates(
        input=rate(40),
        output=rate(120),
        cache_read=rate(4) if rng.random() < 0.5 else None,
        cache_write=rate(50) if rng.random() < 0.4 else None,
        long_context_threshold=rng.randint(1_000, 400_000) if long_context else None,
        long_context_input_multiplier=round(rng.uniform(0.9, 3.3), 3) if long_context else 1.0,
        long_context_output_multiplier=round(rng.uniform(0.9, 3.3), 3) if long_context else 1.0,
    )


def card_json(card: Rates) -> dict:
    row = {"input": card.input, "output": card.output}
    if card.cache_read is not None:
        row["cache_read"] = card.cache_read
    if card.cache_write is not None:
        row["cache_write"] = card.cache_write
    if card.long_context_threshold is not None:
        row["long_context_threshold"] = card.long_context_threshold
        row["long_context_input_multiplier"] = card.long_context_input_multiplier
        row["long_context_output_multiplier"] = card.long_context_output_multiplier
    return row


# One plausible porting slip per cost term: the same arithmetic, grouped differently.
VARIANTS = (
    "input rate: input / 1e6 * mult",
    "output rate: output / 1e6 * mult",
    "sum order: cache read before output",
    "cache read: tokens * (rate / 1e6)",
    "derived cache-read rate: input * 0.1 * mult",
    "cache write: tokens * (write * mult)",
    "aggregate creation: tokens * (rate * 1.25)",
    "5m bucket: tokens * (rate * 1.25)",
    # Not tokens * (rate * 2): doubling is exact in binary, so that regrouping never shows.
    "1h bucket: tokens * input * mult * 2 / 1e6",
)


def mirror_cost(card: Rates, inp, out, cache_read, creation, e5, e1, variant=None) -> float:
    """compute_cost's arithmetic, step for step, with at most one term regrouped."""
    long_context = (
        card.long_context_threshold is not None and inp + cache_read > card.long_context_threshold
    )
    im = card.long_context_input_multiplier if long_context else 1.0
    om = card.long_context_output_multiplier if long_context else 1.0
    if variant == VARIANTS[0]:
        ir = card.input / 1_000_000.0 * im
    else:
        ir = card.input * im / 1_000_000.0
    if variant == VARIANTS[1]:
        orr = card.output / 1_000_000.0 * om
    else:
        orr = card.output * om / 1_000_000.0
    if card.cache_read is not None:
        read_rate = card.cache_read * im
    elif variant == VARIANTS[4]:
        read_rate = card.input * CACHE_READ_MULT * im
    else:
        read_rate = card.input * im * CACHE_READ_MULT
    if variant == VARIANTS[3]:
        read = cache_read * (read_rate / 1_000_000.0)
    else:
        read = cache_read * read_rate / 1_000_000.0
    if variant == VARIANTS[2]:
        cost = inp * ir + read + out * orr
    else:
        cost = inp * ir + out * orr
        cost += read
    if card.cache_write is not None:
        if variant == VARIANTS[5]:
            cost += creation * (card.cache_write * im) / 1_000_000.0
        else:
            cost += creation * card.cache_write * im / 1_000_000.0
    elif e5 is None and e1 is None:
        if variant == VARIANTS[6]:
            cost += creation * (ir * 1.25)
        else:
            cost += creation * ir * 1.25
    else:
        if variant == VARIANTS[7]:
            cost += (e5 or 0) * (ir * 1.25)
        else:
            cost += (e5 or 0) * ir * 1.25
        if variant == VARIANTS[8]:
            cost += (e1 or 0) * card.input * im * 2.0 / 1_000_000.0
        else:
            cost += (e1 or 0) * ir * 2.0
    return cost


def card_cases(rng: random.Random) -> tuple[list[dict], list[list], dict[str, int]]:
    """Random cards and records, kept while some regrouping still needs catching."""
    cards: list[dict] = []
    rows: list[list] = []
    caught = dict.fromkeys(VARIANTS, 0)
    for _ in range(MAX_CANDIDATES):
        if min(caught.values()) >= CASES_PER_VARIANT:
            break
        card = random_card(rng)
        threshold = card.long_context_threshold or DEFAULT_THRESHOLD
        case = random_case(rng, threshold)
        expected = compute_cost(
            input_tokens=case[0],
            output_tokens=case[1],
            cache_read=case[2],
            cache_creation_total=case[3],
            ephemeral_5m=case[4],
            ephemeral_1h=case[5],
            rates=card,
        )
        # The mirror must be cc-usage's arithmetic exactly, or the variants prove nothing.
        assert mirror_cost(card, *case) == expected, (card, case)
        differs = [v for v in VARIANTS if mirror_cost(card, *case, variant=v) != expected]
        if not any(caught[v] < CASES_PER_VARIANT for v in differs):
            continue
        for v in differs:
            caught[v] += 1
        rows.append([len(cards), *case, expected])
        cards.append(card_json(card))
    missing = [v for v, n in caught.items() if n < CASES_PER_VARIANT]
    if missing:
        sys.exit(f"no {CASES_PER_VARIANT} cases found for: {missing}")
    return cards, rows, caught


def to_json(value, indent: str = "", prefix: str = "", suffix: str = "") -> str:
    """Close to Biome's layout, so its pass changes little: a container stays on one line
    when it fits, else it opens one entry per line."""

    def inline(v) -> str:
        if isinstance(v, list):
            return "[" + ", ".join(inline(x) for x in v) + "]"
        if isinstance(v, dict):
            if not v:
                return "{}"
            return "{ " + ", ".join(f"{json.dumps(k)}: {inline(x)}" for k, x in v.items()) + " }"
        return json.dumps(v)

    flat = inline(value)
    if not isinstance(value, (list, dict)) or len(indent + prefix + flat + suffix) <= LINE_WIDTH:
        return indent + prefix + flat + suffix
    inner = indent + "  "
    if isinstance(value, list):
        entries = [("", v) for v in value]
        brackets = ("[", "]")
    else:
        entries = [(f"{json.dumps(k)}: ", v) for k, v in value.items()]
        brackets = ("{", "}")
    last = len(entries) - 1
    body = [to_json(v, inner, p, "," if i < last else "") for i, (p, v) in enumerate(entries)]
    return "\n".join([indent + prefix + brackets[0], *body, indent + brackets[1] + suffix])


def main() -> None:
    if cc_usage.__version__ != CC_USAGE_VERSION:
        sys.exit(f"expected cc-usage {CC_USAGE_VERSION}, found {cc_usage.__version__}")
    bundled = json.loads((files("cc_usage") / "data" / "pricing.json").read_text("utf-8"))
    models = bundled["models"]

    rng = random.Random(SEED)
    cards, card_rows, caught = card_cases(random.Random(SEED + 1))
    rows = []
    for index, model in enumerate(models):
        rates = get_rates(model, models)
        threshold = rates.long_context_threshold or DEFAULT_THRESHOLD
        cases = edge_cases(threshold)
        while len(cases) < CASES_PER_MODEL:
            cases.append(random_case(rng, threshold))
        for inp, out, cache_read, creation, e5, e1 in cases:
            cost = compute_cost(
                input_tokens=inp,
                output_tokens=out,
                cache_read=cache_read,
                cache_creation_total=creation,
                ephemeral_5m=e5,
                ephemeral_1h=e1,
                rates=rates,
            )
            rows.append([index, inp, out, cache_read, creation, e5, e1, cost])

    OUT.mkdir(parents=True, exist_ok=True)
    table_path = ROOT / "src" / "pricing" / "cc-usage-v2.6.1-pricing.json"
    parity_path = OUT / "cost-parity.json"
    table = {"_comment": bundled["_comment"], "models": models}
    table_path.write_text(to_json(table) + "\n", "utf-8")
    parity = {
        "_comment": (
            "Generated by scripts/gen-cost-parity.py from cc_usage.cost.compute_cost "
            f"(cc-usage {CC_USAGE_VERSION}) and the rates in cc-usage-v2.6.1-pricing.json. "
            "Synthetic token counts only. Do not edit."
        ),
        "seed": SEED,
        "models": list(models),
        "columns": [
            "model index",
            "input",
            "output",
            "cache read",
            "cache creation",
            "ephemeral 5m",
            "ephemeral 1h",
            "cost",
        ],
        "cases": rows,
        "cards": cards,
        "card_columns": ["card index", "input", "output", "cache read", "cache creation",
                         "ephemeral 5m", "ephemeral 1h", "cost"],
        "card_cases": card_rows,
        "card_cases_catching": caught,
    }
    parity_path.write_text(to_json(parity) + "\n", "utf-8")
    biome = ["bunx", "biome", "format", "--write", table_path, parity_path]
    subprocess.run(biome, cwd=ROOT, check=True)
    print(f"wrote {len(rows)} cases for {len(models)} models to {OUT}")
    print(f"and {len(card_rows)} random-card cases; regroupings each catches:")
    for variant, n in caught.items():
        print(f"  {n:4}  {variant}")


if __name__ == "__main__":
    main()
