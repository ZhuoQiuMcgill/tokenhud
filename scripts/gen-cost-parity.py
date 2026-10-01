"""Generate the cost parity fixtures from cc-usage's own cost function.

Run with cc-usage's interpreter (it must import cc_usage v2.6.1), with Bun on PATH:

    /mnt/d/Projects/CC_Usage/.venv/bin/python scripts/gen-cost-parity.py

Writes, under test/fixtures/pricing/:
  cc-usage-v2.6.1-pricing.json  cc-usage's bundled table: the same data, reformatted for
                                Biome
  cost-parity.json              deterministic pseudo-random usage records for every model
                                in that table, each with cc_usage.cost.compute_cost's result

The cases are synthetic token counts only: no transcript data. They cover zeros, null
ephemeral buckets, long-context crossings at threshold - 1, threshold and threshold + 1,
and huge counts up to 2**53 - 1. Python's float repr round-trips, so JSON carries every
expected cost bit for bit. The files then go through the repo's Biome formatter, which only
re-wraps long number arrays and shortens exponents (7.275e-05 -> 7.275e-5): same values.
"""

from __future__ import annotations

import json
import random
import subprocess
import sys
from importlib.resources import files
from pathlib import Path

import cc_usage
from cc_usage.cost import compute_cost, get_rates

CC_USAGE_VERSION = "2.6.1"
SEED = 20261001
CASES_PER_MODEL = 200
# Models without a long-context tier still get the crossing cases, at OpenAI's threshold.
DEFAULT_THRESHOLD = 272_000
LINE_WIDTH = 100  # biome.json formatter.lineWidth

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
    table_path = OUT / "cc-usage-v2.6.1-pricing.json"
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
    }
    parity_path.write_text(to_json(parity) + "\n", "utf-8")
    biome = ["bunx", "biome", "format", "--write", table_path, parity_path]
    subprocess.run(biome, cwd=ROOT, check=True)
    print(f"wrote {len(rows)} cases for {len(models)} models to {OUT}")


if __name__ == "__main__":
    main()
