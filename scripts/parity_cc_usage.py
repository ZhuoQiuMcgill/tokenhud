"""cc-usage's side of the parity harness (scripts/parity.ts).

The harness runs it with cc-usage v2.6.1's interpreter:

    python scripts/parity_cc_usage.py LEDGER_COPY TIME_ZONE OUT_JSON ROLLOUTS

It reads a snapshot copy of cc-usage's ledger, never the live file, and the Codex rollouts
listed one per line in the file ROLLOUTS. The harness sets XDG_CONFIG_HOME to a temp dir
holding a copy of the user's pricing.json, so cc-usage's config dir is never opened here.

Writes JSON:
- `version`, and `pricing`: the table cc-usage prices with (its `load_pricing`);
- `cells`: per (local day, account identity, normalised model), the ledger's token sums,
  cost by cc-usage's `compute_cost`, and row count;
- `codex`: every record cc-usage's own parser emits from those rollouts today, with its
  key (as a string), timestamp (ms), model and counts, and the speed tier its rollout sets.

The tier is derived here, apart from both apps: cc-usage ignores tiers, and the gate must
not take tokenhud's word for them. A rollout starts standard; each
`thread_settings_applied` event with a `service_tier` sets it ("priority" and "fast" are
fast, anything else standard), and one without the key keeps it. A record takes the tier
in effect when the parser emits it.

Content-free: dates, account identities (hashes), keys, model ids and numbers.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import cc_usage
from cc_usage.cost import compute_cost, get_rates, normalize_model
from cc_usage.parser import Parser
from cc_usage.pricing import load_pricing

FAST = {"priority", "fast"}


def ledger_cells(ledger: str, zone: ZoneInfo, pricing: dict) -> list:
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
    return [[*key, *values] for key, values in sorted(cells.items())]


def settings_tier(line: bytes, tier: int) -> int:
    """The tier after `line`, a rollout line that names thread_settings_applied."""
    try:
        obj = json.loads(line)
    except ValueError:
        return tier
    payload = obj.get("payload") if isinstance(obj, dict) else None
    if obj.get("type") != "event_msg" or not isinstance(payload, dict):
        return tier
    if payload.get("type") != "thread_settings_applied":
        return tier
    settings = payload.get("thread_settings")
    if not isinstance(settings, dict) or not isinstance(settings.get("service_tier"), str):
        return tier
    return 1 if settings["service_tier"] in FAST else 0


def codex_records(rollouts: str, pricing: dict) -> list:
    parser = Parser(pricing, roots=[])
    tiers: dict[int, int] = {}
    paths = sorted(Path(p) for p in Path(rollouts).read_text("utf-8").splitlines() if p)
    for path in paths:
        source = str(path)
        tier = 0
        try:
            fh = open(path, "rb")
        except OSError:
            continue
        with fh:
            for line in fh:
                if not line.strip():
                    continue
                if b"thread_settings_applied" in line:
                    tier = settings_tier(line, tier)
                before = len(parser.records)
                parser._ingest_line(line, source)
                for rec in parser.records[before:]:
                    if rec.lkey is not None:
                        tiers.setdefault(rec.lkey, tier)
    return [
        [str(r.lkey), round(r.ts * 1000), r.model_raw, r.input_tokens, r.output_tokens,
         r.cache_read, tiers.get(r.lkey, 0)]
        for r in parser.records
        if r.lkey is not None
    ]


def main() -> None:
    ledger, zone_name, out, rollouts = sys.argv[1:5]
    pricing, warnings = load_pricing()
    report = {
        "version": cc_usage.__version__,
        "warnings": warnings,
        "pricing": pricing,
        "cells": ledger_cells(ledger, ZoneInfo(zone_name), pricing),
        "codex": codex_records(rollouts, pricing),
    }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(report, fh)


if __name__ == "__main__":
    main()
