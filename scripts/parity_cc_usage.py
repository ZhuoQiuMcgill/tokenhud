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
  key (as a string), timestamp (ms), model and counts, the speed tier its rollout sets, and
  whether it belongs to a child rollout's replay of its parent.

Tier and replay are derived here, from the rollouts' structure, apart from both apps:
cc-usage knows neither, and the gate must not take tokenhud's word for them.

- **Tier.** A rollout starts standard; each `thread_settings_applied` event with a
  `service_tier` sets it ("priority" and "fast" are fast, anything else standard), and one
  without the key keeps it. A record takes the tier in effect when the parser emits it.
- **Replay.** Only a child rollout replays: its first line is a `session_meta` naming a
  parent (`forked_from_id`, or `source.subagent.thread_spawn.parent_thread_id`). Its own
  usage starts at the child-turn boundary, the first `inter_agent_communication` (or
  `..._metadata`) event with `trigger_turn` true, or rather the `task_started` just before
  it when there is one: the replayed head holds the parent's own `task_started` lines, so
  only the one that opens the child's first turn counts. A record before that boundary is
  replay. A child without such a marker (a fork, or a subagent that never got one) replays
  exactly the events whose cumulative `total_token_usage` also occurs in its parent's
  rollout: those totals are the parent's history, not the child's own.

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
from cc_usage.parser import Parser, codex_session_id
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


def event(line: bytes) -> dict | None:
    try:
        obj = json.loads(line)
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def payload_of(obj: dict) -> dict:
    payload = obj.get("payload")
    return payload if isinstance(payload, dict) else {}


def parent_of(first: dict | None) -> str | None:
    """The parent session a rollout's first line names, if it is a child."""
    if first is None or first.get("type") != "session_meta":
        return None
    meta = payload_of(first)
    if isinstance(meta.get("forked_from_id"), str):
        return meta["forked_from_id"].lower()
    source = meta.get("source") if isinstance(meta.get("source"), dict) else {}
    subagent = source.get("subagent") if isinstance(source.get("subagent"), dict) else {}
    spawn = subagent.get("thread_spawn") if isinstance(subagent.get("thread_spawn"), dict) else {}
    parent = spawn.get("parent_thread_id")
    return parent.lower() if isinstance(parent, str) else None


def total_of(obj: dict) -> tuple | None:
    info = payload_of(obj).get("info")
    total = info.get("total_token_usage") if isinstance(info, dict) else None
    if not isinstance(total, dict):
        return None
    return (total.get("input_tokens"), total.get("cached_input_tokens"), total.get("output_tokens"))


def totals_of(paths: list[Path]) -> set:
    """Every cumulative total a session's rollouts report."""
    out: set = set()
    for path in paths:
        try:
            fh = open(path, "rb")
        except OSError:
            continue
        with fh:
            for line in fh:
                if b"token_count" not in line:
                    continue
                obj = event(line)
                if obj is not None and payload_of(obj).get("type") == "token_count":
                    total = total_of(obj)
                    if total is not None:
                        out.add(total)
    return out


def codex_records(rollouts: str, pricing: dict) -> list:
    parser = Parser(pricing, roots=[])
    tiers: dict[int, int] = {}
    replays: dict[int, bool] = {}
    paths = sorted(Path(p) for p in Path(rollouts).read_text("utf-8").splitlines() if p)
    sessions: dict[str, list[Path]] = {}
    for path in paths:
        sessions.setdefault(codex_session_id(str(path)).lower(), []).append(path)
    parent_totals: dict[str, set] = {}
    for path in paths:
        source = str(path)
        tier = 0
        parent: str | None = None
        first = True
        task_started: int | None = None  # the latest task_started line, until the boundary
        boundary: int | None = None
        emitted: list[tuple[int, int, tuple | None]] = []  # (line, key, total)
        try:
            fh = open(path, "rb")
        except OSError:
            continue
        with fh:
            for index, line in enumerate(fh):
                if not line.strip():
                    continue
                if first:
                    first = False
                    parent = parent_of(event(line))
                if b"thread_settings_applied" in line:
                    tier = settings_tier(line, tier)
                if parent is not None and boundary is None and (
                    b"task_started" in line or b"trigger_turn" in line
                ):
                    obj = event(line) or {}
                    kind = obj.get("type")
                    if kind == "event_msg" and payload_of(obj).get("type") == "task_started":
                        task_started = index
                    elif (
                        kind in ("inter_agent_communication_metadata", "inter_agent_communication")
                        and payload_of(obj).get("trigger_turn") is True
                    ):
                        boundary = index if task_started is None else task_started
                total = None
                if parent is not None and b"token_count" in line:
                    obj = event(line)
                    total = total_of(obj) if obj is not None else None
                before = len(parser.records)
                parser._ingest_line(line, source)
                for rec in parser.records[before:]:
                    if rec.lkey is not None:
                        tiers.setdefault(rec.lkey, tier)
                        emitted.append((index, rec.lkey, total))
        for index, key, total in emitted:
            if parent is None:
                replay = False
            elif boundary is not None:
                replay = index < boundary
            else:
                if parent not in parent_totals:
                    parent_totals[parent] = totals_of(sessions.get(parent, []))
                replay = total is not None and total in parent_totals[parent]
            replays.setdefault(key, replay)
    return [
        [str(r.lkey), round(r.ts * 1000), r.model_raw, r.input_tokens, r.output_tokens,
         r.cache_read, tiers.get(r.lkey, 0), 1 if replays.get(r.lkey) else 0]
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
