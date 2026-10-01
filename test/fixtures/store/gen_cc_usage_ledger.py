"""Generate a small, synthetic cc-usage ledger and what cc-usage reads back from it.

Run with cc-usage's Python (it must be able to `import cc_usage`), from anywhere:

    /mnt/d/Projects/CC_Usage/.venv/bin/python test/fixtures/store/gen_cc_usage_ledger.py

Writes, next to this script:

* cc-usage-ledger.sqlite3: written by cc-usage v2.6.1's own `Ledger` class, in batches
  the way its engine syncs (a streaming partial then its final count, a label rename, a
  codex-unattributed row). Synthetic: nothing is read from this machine. Every id is a
  literal fake (`00000000-0000-4000-8000-0000000000NN`, `req_FAKE…`), the account
  identities hash made-up paths, and the random `ledger_id` is replaced by a fixed fake,
  so the file is byte-for-byte reproducible. `main()` checks all of that.
* cc-usage-ledger.expected.json: every row as cc-usage stores it (keys as decimal
  strings) and its `--ledger-info` summary from `ledger.read_summary`.

The files are regenerated from scratch and come out identical on every run.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

from cc_usage.ledger import SCHEMA_VERSION, Ledger, LedgerRow, read_summary
from cc_usage.parser import KEY_SCHEME, ledger_key

HERE = Path(__file__).parent
LEDGER = HERE / "cc-usage-ledger.sqlite3"
EXPECTED = HERE / "cc-usage-ledger.expected.json"

SEP = "\x1f"
SESSION = "00000000-0000-4000-8000-000000000001"  # a fake Codex session id
LEDGER_ID = "00000000000040008000000000000001"  # replaces cc-usage's random uuid4().hex
UUID = re.compile(rb"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
FAKE_UUID = re.compile(rb"00000000-0000-4000-8000-0000000000\d\d")
NOW = 1_780_000_000_000  # epoch ms, 2026-05-28T20:26:40Z
MIN = 60_000
HOUR = 3_600_000
DAY = 24 * HOUR


def identity(root: str) -> str:
    # accounts.root_identity of a root whose resolved path is `root`
    return hashlib.sha256(root.encode("utf-8")).hexdigest()[:32]


PERSONAL = ("claude", identity("/home/user/.claude"), "personal")
COMPANY = ("claude", identity("/home/user/.claude-company"), "company")
CODEX = ("codex", identity("/home/user/.codex"), "codex")


def claude(acct, material, ts, model, inp, outp, cr=0, cc=0, eph=None, key=None):
    provider, ident, label = acct
    e5, e1 = eph if eph is not None else (None, None)
    return LedgerRow(
        key if key is not None else ledger_key(material),
        provider, ident, label, ts, model, inp, outp, cr, cc, e5, e1,
    )


def codex(ts_iso, total, last, ts, model, inp, outp, cr):
    material = SEP.join(
        ("x", SESSION, ts_iso,
         ",".join(map(str, total)), ",".join(map(str, last)))
    )
    provider, ident, label = CODEX
    return LedgerRow(ledger_key(material), provider, ident, label, ts, model, inp, outp, cr, 0, 0, 0)


def batches() -> list[list[LedgerRow]]:
    m = "claude-opus-4-8"
    partial = claude(PERSONAL, f"c{SEP}req_FAKE_a1{SEP}msg_FAKE_a1", NOW - 30 * MIN, m, 1000, 5,
                     cc=1200, eph=(1000, 200))
    final = claude(PERSONAL, f"c{SEP}req_FAKE_a1{SEP}msg_FAKE_a1", NOW - 30 * MIN, m, 1000, 500,
                   cc=1200, eph=(1000, 200))
    unattributed = codex("2026-05-28T15:26:40.000Z", (100, 20, 10), (100, 20, 10),
                         NOW - 5 * HOUR, "codex-unattributed", 80, 10, 20)
    return [
        # 1st sync: a streaming partial line, plus history across accounts and models.
        [
            partial,
            claude(PERSONAL, f"c{SEP}req_FAKE_a2{SEP}msg_FAKE_a2", NOW - 3 * HOUR, "claude-sonnet-4-6",
                   300, 40, cc=300),  # no sub-bucket object: e5/e1 NULL
            claude(PERSONAL, f"c{SEP}req_FAKE_a3{SEP}msg_FAKE_a3", NOW - 2 * DAY, "claude-mystery-1",
                   50, 5, cr=900, eph=(0, 0)),  # an unpriced model
            claude(PERSONAL, f"u{SEP}00000000-0000-4000-8000-000000000004", NOW - 20 * DAY, m,
                   700, 70, cr=5000, eph=(0, 0)),
            claude(PERSONAL, f"c{SEP}req_FAKE_a5{SEP}msg_FAKE_a5", NOW - 25 * MIN, m, 10, 1,
                   eph=(0, 0)),  # same hour as the streaming one
            claude(PERSONAL, f"c{SEP}req_FAKE_a6{SEP}msg_FAKE_a6", NOW - 4 * HOUR,
                   "claude-" + chr(0xD800) + "-odd", 11, 2),  # stored as U+FFFD x3
            claude(COMPANY, f"c{SEP}req_FAKE_b1{SEP}msg_FAKE_b1", NOW - 6 * HOUR, m, 2000, 200,
                   eph=(0, 0)),
            claude(COMPANY, f"c{SEP}req_FAKE_b2{SEP}msg_FAKE_b2", NOW - 10 * DAY, m, 800, 80,
                   cc=50, eph=(50, 0)),
            unattributed,
        ],
        # 2nd sync: the streaming final count, keys at the edges of 64 bits, Codex events.
        [
            final,
            claude(PERSONAL, "", NOW - 7 * DAY, m, 1, 1, key=2**63 - 1),
            claude(PERSONAL, "", NOW - 7 * DAY + MIN, m, 2, 2, key=-(2**63)),
            claude(PERSONAL, "", NOW - 7 * DAY + 2 * MIN, m, 3, 3, key=2**53 + 1),
            claude(PERSONAL, "", NOW - 7 * DAY + 3 * MIN, m, 4, 4, key=-(2**53) - 1),
            codex("2026-05-28T15:27:40.000Z", (400, 120, 60), (300, 100, 50),
                  NOW - 5 * HOUR + MIN, "gpt-5.5", 200, 50, 100),
            codex("2026-05-28T15:28:40.000Z", (500, 150, 70), (100, 30, 10),
                  NOW - 5 * HOUR + 2 * MIN, "gpt-5.5", 70, 10, 30),
        ],
        # 3rd sync: the rollout's model resolves; the company root was relabelled "work".
        [
            LedgerRow(unattributed.key, *CODEX, unattributed.ts_ms, "gpt-5.5",
                      unattributed.inp, unattributed.outp, unattributed.cr, 0, 0, 0),
            claude(("claude", COMPANY[1], "work"), f"c{SEP}req_FAKE_b3{SEP}msg_FAKE_b3", NOW - 1 * HOUR,
                   "claude-sonnet-4-6", 120, 12, cc=10, eph=(10, 0)),
        ],
    ]


def stored_rows(path: Path) -> list[dict]:
    conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT u.key, a.provider, a.identity, a.label, u.ts, m.name, "
            "u.inp, u.outp, u.cr, u.cc, u.e5, u.e1 "
            "FROM usage u JOIN accounts a ON a.id = u.acct JOIN models m ON m.id = u.model "
            "ORDER BY u.key"
        ).fetchall()
        models = [name for (name,) in conn.execute("SELECT name FROM models ORDER BY id")]
        lineage = conn.execute("SELECT v FROM meta WHERE k = 'ledger_id'").fetchone()[0]
    finally:
        conn.close()
    names = ("provider", "identity", "label", "ts", "model", "inp", "outp", "cr", "cc", "e5", "e1")
    return lineage, models, [{"key": str(r[0]), **dict(zip(names, r[1:]))} for r in rows]


def main() -> int:
    for suffix in ("", "-wal", "-shm"):
        Path(f"{LEDGER}{suffix}").unlink(missing_ok=True)
    ledger = Ledger(LEDGER)
    for batch in batches():
        ledger.write(batch)
    ledger.close()  # the last connection checkpoints the WAL and removes -wal/-shm
    conn = sqlite3.connect(LEDGER)
    conn.execute("UPDATE meta SET v = ? WHERE k = 'ledger_id'", (LEDGER_ID,))
    conn.commit()
    conn.close()
    leftovers = [p.name for p in HERE.glob(f"{LEDGER.name}-*")]
    assert not leftovers, leftovers

    lineage, models, rows = stored_rows(LEDGER)
    summary = read_summary(LEDGER)
    # Read-only connections leave empty -wal/-shm index files behind (cc-usage documents
    # this in read_summary). Nothing is in them; only the ledger file is the fixture.
    wal = Path(f"{LEDGER}-wal")
    assert not wal.exists() or wal.stat().st_size == 0
    for suffix in ("-wal", "-shm"):
        Path(f"{LEDGER}{suffix}").unlink(missing_ok=True)
    doc = {
        "about": "Generated by gen_cc_usage_ledger.py with cc-usage's own Ledger and "
        "read_summary; do not edit by hand.",
        "schema_version": SCHEMA_VERSION,
        "key_scheme": KEY_SCHEME,
        "lineage": lineage,
        "summary": {
            "rows": summary.rows,
            "rows_by_provider": summary.rows_by_provider,
            "accounts": [
                {"label": label, "provider": provider, "identity": ident, "rows": n}
                for label, provider, ident, n in summary.accounts
            ],
        },
        "models": models,
        "rows": rows,
    }
    text = json.dumps(doc, ensure_ascii=True, indent=2) + "\n"
    EXPECTED.write_text(text, "utf-8")
    # Nothing from this machine: every uuid in the outputs and in this script is a fake.
    for blob in (LEDGER.read_bytes(), text.encode(), Path(__file__).read_bytes()):
        for found in UUID.findall(blob):
            assert FAKE_UUID.fullmatch(found), "a uuid that is not a fake one"
    assert lineage == LEDGER_ID
    print(f"wrote {LEDGER.name} ({LEDGER.stat().st_size} bytes, {summary.rows} rows) and "
          f"{EXPECTED.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
