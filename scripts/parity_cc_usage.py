"""cc-usage's side of the parity harness (scripts/parity.ts): its own numbers, per cell.

The harness runs it with cc-usage v2.6.1's interpreter:

    python scripts/parity_cc_usage.py LEDGER_COPY TIME_ZONE OUT_JSON

It reads a snapshot copy of cc-usage's ledger, never the live file, and prices every row
with cc-usage's own `load_pricing` and `compute_cost`, as cc-usage's views do. The
harness sets XDG_CONFIG_HOME to a temp dir holding a copy of the user's pricing.json, so
cc-usage's config dir is never opened from here.

Writes JSON: cc-usage's version, the pricing it used, and per (local day, account
identity, normalised model) the token sums, the cost and the row count. Content-free:
dates, account identities (hashes), model ids and numbers.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import cc_usage
from cc_usage.cost import compute_cost, get_rates, normalize_model
from cc_usage.pricing import load_pricing


def main() -> None:
    ledger, zone_name, out = sys.argv[1:4]
    pricing, warnings = load_pricing()
    zone = ZoneInfo(zone_name)
    cells: dict[tuple[str, str, str], list] = {}
    conn = sqlite3.connect(ledger)
    try:
        rows = conn.execute(
            "SELECT a.identity, u.ts, m.name, u.inp, u.outp, u.cr, u.cc, u.e5, u.e1 "
            "FROM usage u JOIN accounts a ON a.id = u.acct JOIN models m ON m.id = u.model "
            "ORDER BY u.key"
        )
        for identity, ts, model, inp, outp, cr, cc, e5, e1 in rows:
            day = datetime.fromtimestamp(ts / 1000, zone).date().isoformat()
            cost = compute_cost(
                input_tokens=inp,
                output_tokens=outp,
                cache_read=cr,
                cache_creation_total=cc,
                ephemeral_5m=e5,
                ephemeral_1h=e1,
                rates=get_rates(model, pricing),
            )
            cell = cells.setdefault((day, identity, normalize_model(model)), [0, 0, 0, 0, 0.0, 0])
            cell[0] += inp
            cell[1] += outp
            cell[2] += cr
            cell[3] += cc
            cell[4] += cost
            cell[5] += 1
    finally:
        conn.close()
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "version": cc_usage.__version__,
                "warnings": warnings,
                "pricing": pricing,
                "cells": [[*key, *values] for key, values in sorted(cells.items())],
            },
            fh,
        )


if __name__ == "__main__":
    main()
