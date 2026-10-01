"""Generate claude-cases.json: synthetic Claude transcripts and what cc-usage makes of them.

Run with cc-usage's Python (it must be able to `import cc_usage`), from anywhere:

    /mnt/d/Projects/CC_Usage/.venv/bin/python test/fixtures/sources/gen_claude_cases.py

The transcripts below are literals with fake ids (`req_FAKE...`, `msg_FAKE...`,
`00000000-0000-4000-8000-0000000000NN`); nothing is read from this machine. They are
written to a temp `projects` tree, cc-usage's own `Parser.scan()` reads it, and every
record it keeps is written out as the ledger would store it (`LedgerRow`): key, ts in ms
(`round(ts * 1000)`), raw model and token counts. Files are stored base64-encoded so their
exact bytes (CRLF, invalid UTF-8, a missing final newline) survive any checkout.
"""

from __future__ import annotations

import base64
import json
import re
import sys
import tempfile
from pathlib import Path

from cc_usage.parser import Parser

OUT = Path(__file__).with_name("claude-cases.json")


def fake_uuid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
FAKE_UUID = re.compile(r"00000000-0000-4000-8000-0000000000\d\d")
API_ID = re.compile(r"(?:req|msg)_[0-9A-Za-z]+")


def assert_fake(text: str) -> None:
    for found in UUID.findall(text):
        assert FAKE_UUID.fullmatch(found), "a uuid that is not a fake one"
    for found in API_ID.findall(text):
        assert "FAKE" in found, "a request or message id that is not a fake one"


def line(
    req=None,
    mid=None,
    *,
    ts="2026-06-01T00:00:00.000Z",
    model="claude-opus-4-8",
    usage=None,
    uuid=None,
    kind="assistant",
    extra=None,
    drop=(),
) -> str:
    """One transcript line as JSON text. Fields in `drop` are left out."""
    message = {"model": model, "usage": usage if usage is not None else {"input_tokens": 1, "output_tokens": 1}}
    if mid is not None:
        message["id"] = mid
    obj = {"type": kind, "requestId": req, "timestamp": ts, "uuid": uuid, "message": message}
    if extra:
        obj.update(extra)
    for field in drop:
        obj.pop(field, None)
        message.pop(field, None)
    return json.dumps(obj)


def u(inp=0, out=0, cr=None, cc=None, e5=None, e1=None, **more) -> dict:
    usage = {"input_tokens": inp, "output_tokens": out}
    if cr is not None:
        usage["cache_read_input_tokens"] = cr
    if cc is not None:
        usage["cache_creation_input_tokens"] = cc
    if e5 is not None or e1 is not None:
        usage["cache_creation"] = {"ephemeral_5m_input_tokens": e5 or 0, "ephemeral_1h_input_tokens": e1 or 0}
    usage.update(more)
    return usage


def lines(*items: str, end: bytes = b"\n") -> bytes:
    return b"".join(item.encode("utf-8") + end for item in items)


T0 = "2026-06-01T00:00:00.000Z"
T1 = "2026-06-01T00:00:01.500Z"
T2 = "2026-06-02T12:00:00.250Z"

FILES: dict[str, bytes] = {
    # Streaming merge, value types, sub-buckets, skips.
    "proj-a/sess.jsonl": lines(
        line("req_FAKE01", "msg_FAKE01", usage=u(1000, 1, 500, 200)),
        line("req_FAKE01", "msg_FAKE01", ts=T1, usage=u(1000, 2000, 500, 200)),
        line("req_FAKE01", "msg_FAKE01", ts=T2, usage=u(900, 7, 800, 100)),
        # floats count as 0, bools as ints, the last duplicate member wins
        line("req_FAKE02", "msg_FAKE02", usage={"input_tokens": 5.0, "output_tokens": True, "cache_read_input_tokens": 2.5}),
        '{"type":"assistant","requestId":"req_FAKE03","timestamp":"2026-06-01T00:00:00Z","message":{"id":"msg_FAKE03","model":"claude-opus-4-8","usage":{"input_tokens":5,"input_tokens":7,"output_tokens":1e3}}}',
        # the aggregate derived from sub-buckets; sub-buckets kept as 0 vs absent
        line("req_FAKE04", "msg_FAKE04", usage=u(1, 1, e5=300, e1=700)),
        line("req_FAKE05", "msg_FAKE05", usage=u(1, 1, cc=40, e5=0, e1=0)),
        line("req_FAKE06", "msg_FAKE06", usage=u(1, 1, cc=40)),
        # merge keeps a sub-bucket once either line reports it
        line("req_FAKE07", "msg_FAKE07", usage=u(1, 1, cc=50)),
        line("req_FAKE07", "msg_FAKE07", usage=u(1, 2, cc=50, e5=50, e1=0)),
        # skipped: synthetic, not assistant, usage not an object, message not an object
        line("req_FAKE08", "msg_FAKE08", model="<synthetic>"),
        line("req_FAKE09", "msg_FAKE09", kind="user"),
        line("req_FAKE10", "msg_FAKE10", usage=[1, 2]),
        '{"type":"assistant","requestId":"req_FAKE11","timestamp":"2026-06-01T00:00:00Z","message":"usage"}',
        # no model: kept with an empty model id
        line("req_FAKE12", "msg_FAKE12", drop=("model",)),
        # fast mode (cc-usage ignores the speed; tokenhud records tier 1)
        line("req_FAKE13", "msg_FAKE13", usage=u(10, 20, speed="fast")),
        line("req_FAKE14", "msg_FAKE14", usage=u(10, 20, speed="standard")),
        "",
        "   ",
        # broken JSON that passes the byte checks
        '{"type":"assistant","message":{"usage":{"input_tokens": NOT JSON }}}',
    ),
    # Keys: uuid fallback, no key at all, odd id types.
    "proj-a/keys.jsonl": lines(
        line(None, None, uuid=fake_uuid(1), usage=u(3, 4)),
        line(None, None, usage=u(5, 6)),
        line(None, "msg_FAKE20", usage=u(1, 1), drop=("requestId",)),
        line(None, "msg_FAKE21", usage=u(1, 2)),
        line(12345, "msg_FAKE22", usage=u(1, 3)),
        line(1.5, "msg_FAKE23", usage=u(1, 4)),
        line(1e16, "msg_FAKE24", usage=u(1, 5)),
        line(123456789012345678901, "msg_FAKE25", usage=u(1, 6)),
        line(True, "msg_FAKE26", usage=u(1, 7)),
        line("req_FAKE27", 98765, usage=u(1, 8)),
        line("req_FAKE28", 0, uuid=fake_uuid(2), usage=u(1, 9)),
        line("req_FAKE29", "", uuid=fake_uuid(3), usage=u(1, 10)),
        line("req_FAKE30\ud800", "msg_FAKE30", usage=u(1, 11)),
        line("req_FAKE31", "msg_FAKE31", model="claude-opus-4-8\udc00", usage=u(1, 12)),
        line({"b": 1, "a": [True, None, 2.5, "x'y"]}, "msg_FAKE32", usage=u(1, 13)),
        line("req_FAKE33", "msg_FAKE33", usage=u(1, 14), extra={"uuid": 7}),
    ),
    # Timestamps: a first line without one cannot create the event; a later one merges.
    "proj-a/ts.jsonl": lines(
        line("req_FAKE40", "msg_FAKE40", usage=u(999, 999), drop=("timestamp",)),
        line("req_FAKE40", "msg_FAKE40", ts=T1, usage=u(5, 5)),
        line("req_FAKE41", "msg_FAKE41", ts=T1, usage=u(5, 5)),
        line("req_FAKE41", "msg_FAKE41", ts="not a time", usage=u(8, 1)),
        line("req_FAKE42", "msg_FAKE42", ts="garbage", usage=u(9, 9)),
        line("req_FAKE43", "msg_FAKE43", ts="2026-06-01T05:30:00+05:30", usage=u(1, 1)),
        line("req_FAKE44", "msg_FAKE44", ts="2026-6-1T1:2:3", usage=u(1, 1)),
        line("req_FAKE45", "msg_FAKE45", ts=" 2026-06-01T00:00:00.0005Z ", usage=u(1, 1)),
        line("req_FAKE46", "msg_FAKE46", ts=12345, usage=u(1, 1)),
        line("req_FAKE47", "msg_FAKE47", ts="1969-12-31T23:59:59Z", usage=u(1, 1)),
    ),
    # Byte-level rules: the markers cc-usage checks before it parses.
    "proj-b/bytes.jsonl": (
        lines(
            # a Codex marker sends the line to cc-usage's Codex rules: not Claude usage
            line("req_FAKE50", "msg_FAKE50", usage=u(1, 1), extra={"note": {"token_count": 1}}),
            line("req_FAKE51", "msg_FAKE51", usage=u(1, 1), extra={"turn_context": True}),
            # "assistant" only through a JSON escape: no such bytes, skipped
            '{"type":"\\u0061ssistant","requestId":"req_FAKE52","timestamp":"2026-06-01T00:00:00Z","message":{"id":"msg_FAKE52","model":"m","usage":{"input_tokens":1}}}',
            # "usage" only through a JSON escape: no such bytes, skipped
            '{"type":"assistant","requestId":"req_FAKE53","timestamp":"2026-06-01T00:00:00Z","message":{"id":"msg_FAKE53","model":"m","\\u0075sage":{"input_tokens":1}}}',
            # "assistant" in text elsewhere and the type escaped: counted (type decodes)
            '{"type":"\\u0061ssistant","requestId":"req_FAKE54","timestamp":"2026-06-01T00:00:00Z","message":{"id":"msg_FAKE54","role":"assistant","model":"m","usage":{"input_tokens":2}}}',
        )
        + line("req_FAKE55", "msg_FAKE55", usage=u(1, 1)).encode().replace(b'"model"', b'"note": "\xff\xfe", "model"')
        + b"\n"
        + lines(line("req_FAKE56", "msg_FAKE56", usage=u(4, 4)), end=b"\r\n")
        # a final line without a newline is not read yet
        + line("req_FAKE57", "msg_FAKE57", usage=u(9, 9)).encode()
    ),
    # Python's path order: "abc/..." sorts before "abc.jsonl", and the first line seen
    # decides the event's timestamp and model.
    "proj-c/abc.jsonl": lines(
        line("req_FAKE60", "msg_FAKE60", ts=T0, model="model-from-abc", usage=u(1, 1)),
        line("req_FAKE61", "msg_FAKE61", ts=T1, usage=u(30, 30)),
    ),
    "proj-c/abc/subagents/agent.jsonl": lines(
        line("req_FAKE60", "msg_FAKE60", ts=T2, model="model-from-agent", usage=u(2, 2)),
        # a line without a timestamp before the event exists anywhere: dropped
        line("req_FAKE61", "msg_FAKE61", usage=u(99, 99), drop=("timestamp",)),
        # one with only timestamp-less lines: no event
        line("req_FAKE62", "msg_FAKE62", usage=u(5, 5), drop=("timestamp",)),
    ),
    "proj-c/zzz.jsonl": lines(
        # an event created earlier in path order takes a later timestamp-less line's max
        line("req_FAKE60", "msg_FAKE60", usage=u(50, 1), drop=("timestamp",)),
    ),
    # Values the store cannot hold: negative and oversized counts.
    "proj-d/odd.jsonl": lines(
        line("req_FAKE70", "msg_FAKE70", usage=u(-5, 1)),
        line("req_FAKE71", "msg_FAKE71", usage=u(9007199254740993, 1)),
        line("req_FAKE72", "msg_FAKE72", usage={"input_tokens": 1e21, "output_tokens": 1}),
    ),
}


def main() -> None:
    for name, data in FILES.items():
        assert_fake(name)
        assert_fake(data.decode("utf-8", "replace"))
    with tempfile.TemporaryDirectory() as tmp:
        projects = Path(tmp) / "projects"
        for name, data in FILES.items():
            path = projects / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        parser = Parser({}, roots=[(projects, "personal")])
        parser.scan()
        records = []
        unkeyed = 0
        for rec in parser.records:
            if rec.lkey is None:
                unkeyed += 1
                continue
            records.append(
                {
                    "key": str(rec.lkey),
                    "ts": round(rec.ts * 1000),
                    "model": rec.model_raw,
                    # int(): a JSON `true` counts as the int 1, as SQLite stores it
                    "inp": int(rec.input_tokens),
                    "outp": int(rec.output_tokens),
                    "cr": int(rec.cache_read),
                    "cc": int(rec.cache_creation),
                    "e5": None if rec._eph_5m is None else int(rec._eph_5m),
                    "e1": None if rec._eph_1h is None else int(rec._eph_1h),
                }
            )
    records.sort(key=lambda r: int(r["key"]))
    out = {
        "files": {name: base64.b64encode(data).decode("ascii") for name, data in FILES.items()},
        "records": records,
        "unkeyed": unkeyed,
        "malformed": parser.stats.malformed,
    }
    text = json.dumps(out, indent=1, ensure_ascii=True) + "\n"
    assert_fake(text)
    OUT.write_text(text, "utf-8")
    print(f"wrote {len(records)} records ({unkeyed} unkeyed) to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
