"""Generate key-vectors.json: cc-usage's own ledger keys and stored-text forms.

Run with cc-usage's Python (it must be able to `import cc_usage`), from anywhere:

    /mnt/d/Projects/CC_Usage/.venv/bin/python test/fixtures/store/gen_key_vectors.py

Every expected value comes from cc-usage v2.6.1 itself (`parser.ledger_key` and
`ledger._text`), not from a re-implementation. Strings are written with JSON escapes, so
lone surrogates reach JavaScript as lone UTF-16 code units.

Nothing is read from this machine: every id below is a literal, obviously fake value
(`FAKE` request and message ids, `00000000-0000-4000-8000-0000000000NN` uuids), and
`main()` refuses to write a vector holding any other id-shaped string.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from cc_usage.ledger import _text
from cc_usage.parser import KEY_SCHEME, ledger_key

OUT = Path(__file__).with_name("key-vectors.json")
SEP = "\x1f"  # parser._KEY_SEP

HI, HI_MAX, LO, LO_MAX = chr(0xD800), chr(0xDBFF), chr(0xDC00), chr(0xDFFF)
GRIN = "\U0001f600"  # one code point here, a surrogate pair in JavaScript


def fake_uuid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
FAKE_UUID = re.compile(r"00000000-0000-4000-8000-0000000000\d\d")
API_ID = re.compile(r"(?:req|msg)_[0-9A-Za-z]+")


def assert_fake(text: str) -> None:
    """Every uuid and request/message id is one of this script's own fakes."""
    for found in UUID.findall(text):
        assert FAKE_UUID.fullmatch(found), "a uuid that is not a fake one"
    for found in API_ID.findall(text):
        assert "FAKE" in found, "a request or message id that is not a fake one"

CASES: list[tuple[str, str]] = [
    ("empty", ""),
    # ASCII
    ("one char", "a"),
    ("abc", "abc"),
    ("sentence", "The quick brown fox jumps over the lazy dog"),
    ("digits", "0123456789"),
    ("separator only", SEP),
    ("nul and controls", "\x00\x01\x1f\x7f"),
    # real key material shapes (parser._dedup_key and the Codex key)
    ("claude request+message", f"c{SEP}req_FAKE0000000000000000000001{SEP}msg_FAKE000000000000000001"),
    ("claude message without request", f"c{SEP}{SEP}msg_FAKE000000000000000002"),
    ("claude uuid", f"u{SEP}{fake_uuid(1)}"),
    (
        "codex event",
        SEP.join(("x", fake_uuid(2), "2026-05-27T10:01:00.000Z", "400,120,60", "300,100,50")),
    ),
    ("codex event without counters", SEP.join(("x", fake_uuid(3), "None", "", ""))),
    # multi-byte UTF-8
    ("2-byte e-acute", "é"),
    ("2-byte boundaries", "\u0080߿"),
    ("3-byte boundaries", "ࠀ￿"),
    ("replacement char", "�"),
    ("byte order mark", "﻿"),
    ("cjk", "日本語"),
    ("greek", "Ωμέγα"),
    ("mixed latin", "naïve café"),
    # astral code points: surrogate pairs in JavaScript
    ("emoji", GRIN),
    ("first astral", "\U00010000"),
    ("last code point", "\U0010ffff"),
    ("zwj family", "\U0001f468‍\U0001f469‍\U0001f467‍\U0001f466"),
    ("flag", "\U0001f1fa\U0001f1f8"),
    ("emoji in material", f"c{SEP}req-{GRIN}{SEP}msg-{GRIN}"),
    # lone surrogates (surrogatepass: 3 bytes each)
    ("lone high", HI),
    ("lone high max", HI_MAX),
    ("lone low", LO),
    ("lone low max", LO_MAX),
    ("lone high in text", f"req-{HI}"),
    ("lone low in text", f"msg-{LO_MAX}"),
    ("low then high", LO + HI),
    ("high, char, low", HI + "x" + LO),
    ("high at end", "a" + chr(0xD83D)),
    ("low at start", chr(0xDE00) + "b"),
    ("pair then lone high", GRIN + HI),
    ("lone low then pair", LO + GRIN),
    ("lone surrogates in material", f"c{SEP}req-{HI}{SEP}msg-{LO_MAX}"),
    # around the 128-byte block boundary (lengths are encoded bytes)
    ("127 ascii", "a" * 127),
    ("128 ascii", "b" * 128),
    ("129 ascii", "c" * 129),
    ("255 ascii", "d" * 255),
    ("256 ascii", "e" * 256),
    ("257 ascii", "f" * 257),
    ("128 bytes of 2-byte chars", "é" * 64),
    ("128 bytes of 3-byte chars", "日" * 42 + "ab"),
    ("128 bytes ending in a lone surrogate", "a" * 125 + HI),
    ("128 bytes ending in an emoji", "a" * 124 + GRIN),
    ("emoji straddling 128", "a" * 126 + GRIN),
    ("lone surrogate straddling 128", "a" * 126 + LO),
    ("256 bytes of 4-byte chars", GRIN * 64),
    # long inputs
    ("1000 ascii", ("0123456789" * 100)),
    ("10000 mixed", ("ab" + GRIN + "é" + LO + "日") * 1000),
    ("20000 ascii", "z" * 20_000),
]

TEXT = [
    ("plain", "claude-opus-4-8"),
    ("lone high", f"claude-{HI}-odd"),
    ("lone low", f"a{LO_MAX}b"),
    ("low then high", LO + HI),
    ("emoji kept", f"model-{GRIN}"),
    ("high at end", "x" + chr(0xD83D)),
]


def main() -> int:
    names = [name for name, _ in CASES]
    assert len(names) == len(set(names)), "duplicate case name"
    out_cases = []
    for name, material in CASES:
        assert_fake(material)
        # JavaScript cannot hold a high and a low surrogate as two separate code points
        # (they read as one astral character), so no vector may contain that sequence.
        for a, b in zip(material, material[1:]):
            assert not (0xD800 <= ord(a) <= 0xDBFF and 0xDC00 <= ord(b) <= 0xDFFF), name
        out_cases.append(
            {
                "name": name,
                "material": material,
                "bytes": len(material.encode("utf-8", "surrogatepass")),
                "key": str(ledger_key(material)),
            }
        )
    doc = {
        "about": "Generated by gen_key_vectors.py from cc-usage's parser.ledger_key and "
        "ledger._text; do not edit by hand.",
        "key_scheme": KEY_SCHEME,
        "cases": out_cases,
        "text": [{"name": name, "input": value, "stored": _text(value)} for name, value in TEXT],
    }
    text = json.dumps(doc, ensure_ascii=True, indent=2) + "\n"
    assert_fake(text)
    OUT.write_text(text, "utf-8")
    print(f"wrote {len(out_cases)} key vectors and {len(TEXT)} text vectors to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
