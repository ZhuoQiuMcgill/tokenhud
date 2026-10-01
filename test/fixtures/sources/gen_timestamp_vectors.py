"""Generate timestamp-vectors.json: what cc-usage stores as a record's timestamp.

Run with cc-usage's Python (it must be able to `import cc_usage`), from anywhere:

    /mnt/d/Projects/CC_Usage/.venv/bin/python test/fixtures/sources/gen_timestamp_vectors.py

Each vector is an input string and `round(parse_timestamp(s) * 1000)` (cc-usage's
`LedgerRow.ts_ms`), or null where `parse_timestamp` returns None. Every input below is a
literal; nothing is read from this machine. Strings are written with JSON escapes, so a
lone surrogate reaches JavaScript as a lone UTF-16 code unit.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from cc_usage.parser import parse_timestamp

OUT = Path(__file__).with_name("timestamp-vectors.json")

BASE = "2026-06-01T12:34:56"
CASES: list[str] = [
    # the shape every real transcript uses, and its neighbours
    "2026-06-01T00:00:00.000Z",
    f"{BASE}.789Z",
    f"{BASE}Z",
    f"{BASE}.1Z",
    f"{BASE}.12Z",
    f"{BASE}.123456Z",
    f"{BASE}.1234567Z",
    f"{BASE}.999999999Z",
    f"{BASE}.000000001Z",
    f"{BASE}.Z",
    f"{BASE}.",
    f"{BASE}.5",
    f"{BASE},5Z",
    f"{BASE}.12a3Z",
    # offsets
    f"{BASE}+00:00",
    f"{BASE}-00:00",
    f"{BASE}+05:30",
    f"{BASE}-08:00",
    f"{BASE}+0530",
    f"{BASE}+05",
    f"{BASE}+5",
    f"{BASE}+053",
    f"{BASE}+05:30:15",
    f"{BASE}+05:30:15.123456",
    f"{BASE}+00:00:00.5",
    f"{BASE}+053015",
    f"{BASE}+053015.25",
    f"{BASE}+23:59",
    f"{BASE}+24:00",
    f"{BASE}+05:60",
    f"{BASE}+05:99",
    f"{BASE}+00:00:99",
    f"{BASE}+00:99:99.999999",
    f"{BASE}+00:00:01.5",
    f"{BASE}-00:00:00.5",
    f"{BASE}-00:00:01.5",
    f"{BASE}+23:59:59.999999",
    f"{BASE}-23:59:59.999999",
    f"{BASE}+23:60",
    f"{BASE}+",
    f"{BASE}-",
    f"{BASE}+05:30Z",
    f"{BASE}Z+05:30",
    f"{BASE}-08:00Z",
    f"{BASE}ZZ",
    f"{BASE}z",
    f"{BASE}.000z",
    # naive times are UTC
    BASE,
    f"{BASE}.250",
    # date-only and the other date forms
    "2026-06-01",
    "20260601",
    "2026-W01",
    "2026W01",
    "2026-W01-1",
    "2026W011",
    "2026-W53-1",
    "2020-W53-7",
    "2026-W00-1",
    "2026-W01-8",
    "2026-W01-",
    "2026-W011",
    "2026W01-1",
    "2026-153",
    "2026-06",
    "202606",
    "2026-6-1",
    "2026-0601",
    "202606-01",
    # date-time combinations of the other forms
    "20260601T123456Z",
    "20260601T1234Z",
    "20260601T12Z",
    "2026-06-01T1234",
    "2026-06-01T12:3456",
    "2026-06-01T1234:56",
    "2026-06-01T12",
    "2026-06-01T1",
    "2026-06-01T",
    "2026-W01-1T12:00:00Z",
    "2026W011T12:00:00Z",
    "2026-W01T12:00:00Z",
    # separators
    "2026-06-01 12:34:56Z",
    "2026-06-01t12:34:56Z",
    "2026-06-01X12:34:56Z",
    "2026-06-01é12:34:56Z",
    "2026-06-01€12:34:56Z",
    "2026-06-01\U0001f600" "12:34:56Z",
    "2026-06-01\ud80012:34:56Z",
    "2026-06-01T12:34:56\ud800Z",
    "20260601\ud800" "123456",
    # out of range
    "2026-13-01T00:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2024-02-29T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-06-31T00:00:00Z",
    "2026-06-01T25:00:00Z",
    "2026-06-01T23:60:00Z",
    "2026-06-01T23:59:60Z",
    "2026-06-01T23:59:61Z",
    "0000-01-01T00:00:00Z",
    # end-of-day midnight
    "2026-06-01T24:00:00Z",
    "2026-06-30T24:00:00Z",
    "2026-12-31T24:00:00Z",
    "2026-12-31T24:00Z",
    "2026-06-01T24:00:01Z",
    "2026-06-01T24:00:00.000001Z",
    "2026-06-31T24:00:00Z",
    "9999-12-31T24:00:00Z",
    "9999-12-31T23:59:59.999999Z",
    # far from the epoch: exact division and negative times
    "0001-01-01T00:00:00Z",
    "0001-01-01T00:00:00+14:00",
    "0001-01-01T00:00:00.000001-23:59",
    "1969-12-31T23:59:59.999Z",
    "1969-12-31T23:59:59.9995Z",
    "1970-01-01T00:00:00Z",
    "1970-01-01T00:00:00.0005Z",
    "1970-01-01T00:00:00.0015Z",
    "1970-01-01T00:00:00.0025Z",
    "2255-06-05T23:47:34.740993Z",
    "2300-01-01T00:00:00.000500Z",
    "5000-07-15T08:30:00.123457Z",
    "2026-06-01T00:00:00.0005Z",
    "2026-06-01T00:00:00.0015Z",
    "2026-06-01T00:00:00.4995Z",
    "2026-06-01T00:00:00.4985Z",
    # whitespace: Python strips its own set
    " 2026-06-01T00:00:00.000Z ",
    "\t2026-06-01T00:00:00.000Z\n",
    " 2026-06-01T00:00:00.000Z　",
    "\x1f2026-06-01T00:00:00.000Z\x1c",
    "\x852026-06-01T00:00:00.000Z",
    "﻿2026-06-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z​",
    "2026-06-01T00:00:00.000 Z",
    " ",
    # the strptime fallback
    "2026-6-1T1:2:3Z",
    "2026-6-1T1:2:3.5Z",
    "2026-6-1T1:2:3",
    "2026-06-01T 1:02:03",
    "2026-06- 1T01:02:03",
    "2026-6-1t1:2:3",
    "2026-6-1T1:2:3+05:30",
    "2026-6-1T1:2:3+0530",
    "2026-6-1T1:2:3-05:30:15",
    "2026-6-1T1:2:3+05:30:15.5",
    "2026-6-1T1:2:3+0530:15",
    "2026-6-1T1:2:3+05:3015",
    "2026-6-1T1:2:3+2400",
    "2026-6-1T1:2:3+9900",
    "2026-6-1T1:2:3+05:60",
    "2026-6-1T1:2:3.1234567Z",
    "2026-6-1T1:2:60",
    "2026-6-1T1:2:61",
    "2026-2-30T1:2:3",
    "2026-6-1T1:2:3Zx",
    "2026-6-1T1:2:3z",
    "２０２６-06-01T12:34:56Z",
    "2026-06-01T12:34:56.5５",
    "2026-6-1T1:2:3+０５:30",
    "\U0001d7ce\U0001d7d0\U0001d7d0\U0001d7d6-6-1T1:2:3",
    "٢٠٢٦-06-01T12:34:56",
    # garbage
    "",
    "Z",
    "garbage",
    "2026",
    "2026-06-01Tgarbage",
    "12:34:56",
    "2026-06-01T12:34:56.789Z\x00",
    "2026-06-01\x0012:34:56Z",
]


def canonical_cases() -> list[str]:
    """Seeded random timestamps in the shape Claude Code writes, with 0 to 9 fraction digits."""
    rng = random.Random(20261001)
    out = []
    for _ in range(400):
        year = rng.choice([rng.randint(1970, 2299), rng.randint(2024, 2027)])
        frac_digits = rng.choice([0, 1, 2, 3, 3, 3, 4, 5, 6, 7, 9])
        frac = "".join(str(rng.randint(0, 9)) for _ in range(frac_digits))
        out.append(
            f"{year:04d}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}T"
            f"{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}:{rng.randint(0, 59):02d}"
            + (f".{frac}" if frac_digits else "")
            + "Z"
        )
    return out


def main() -> None:
    vectors = []
    for case in CASES + canonical_cases():
        ts = parse_timestamp(case)
        vectors.append({"input": case, "ms": None if ts is None else round(ts * 1000)})
    text = json.dumps(vectors, indent=1, ensure_ascii=True) + "\n"
    OUT.write_text(text, "utf-8")
    parsed = sum(v["ms"] is not None for v in vectors)
    print(f"wrote {len(vectors)} vectors ({parsed} parse) to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
