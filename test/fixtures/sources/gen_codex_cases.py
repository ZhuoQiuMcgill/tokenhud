"""Generate codex-cases.json: synthetic Codex rollouts and what cc-usage makes of them.

Run with cc-usage's Python (it must be able to `import cc_usage`), from anywhere:

    /mnt/d/Projects/CC_Usage/.venv/bin/python test/fixtures/sources/gen_codex_cases.py

The rollouts below are literals with fake session ids (`00000000-0000-4000-8000-0000000000NN`);
nothing is read from this machine. They are written to a temp Codex home (`sessions/` and
`archived_sessions/`), cc-usage's own `Parser.scan()` reads both as one `codex` root, and
every record it keeps is written out as the ledger would store it (`LedgerRow`): key, ts
in ms (`round(ts * 1000)`), raw model and token counts. The rate-limit capture of the
account is written out too. Files are stored base64-encoded so their exact bytes survive
any checkout.
"""

from __future__ import annotations

import base64
import json
import re
import sys
import tempfile
from pathlib import Path

from cc_usage.parser import Parser

OUT = Path(__file__).with_name("codex-cases.json")

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
FAKE_UUID = re.compile(r"00000000-0000-4000-8000-0000000000\d\d")


def assert_fake(text: str) -> None:
    for found in UUID.findall(text):
        assert FAKE_UUID.fullmatch(found), "a uuid that is not a fake one"


def sid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def rollout_name(n: int, day: str = "2026-07-12") -> str:
    return f"rollout-{day}T12-00-00-{sid(n)}.jsonl"


def dump(obj) -> str:
    return json.dumps(obj, separators=(",", ":"))


def meta(n: int, ts: str, parent: str | None = None, spawn: bool = False) -> str:
    payload: dict = {"id": sid(n), "cwd": "/fake", "originator": "codex_cli_rs"}
    if parent is not None:
        if spawn:
            payload["source"] = {"subagent": {"thread_spawn": {"parent_thread_id": parent}}}
        payload["forked_from_id"] = parent
    return dump({"timestamp": ts, "type": "session_meta", "payload": payload})


def ctx(ts: str, model="gpt-test") -> str:
    return dump({"timestamp": ts, "type": "turn_context", "payload": {"model": model}})


def usage(t) -> dict:
    return {"input_tokens": t[0], "cached_input_tokens": t[1], "output_tokens": t[2]}


def tok(ts, total=None, last=None, *, limits=None, kind="event_msg", info_extra=None, drop_info=False) -> str:
    payload: dict = {"type": "token_count"}
    if not drop_info:
        info: dict = {}
        if total is not None:
            info["total_token_usage"] = usage(total)
        if last is not None:
            info["last_token_usage"] = usage(last)
        if info_extra:
            info.update(info_extra)
        payload["info"] = info
    if limits is not None:
        payload["rate_limits"] = limits
    obj: dict = {"type": kind, "payload": payload}
    if ts is not None:
        obj = {"timestamp": ts, **obj}
    return dump(obj)


def ev(ts: str, kind: str, **payload) -> str:
    return dump({"timestamp": ts, "type": "event_msg", "payload": {"type": kind, **payload}})


def iac(ts: str, trigger: bool, name="inter_agent_communication_metadata") -> str:
    return dump({"timestamp": ts, "type": name, "payload": {"trigger_turn": trigger}})


def settings(ts: str, tier=None, *, absent=False) -> str:
    thread = {} if absent else {"service_tier": tier}
    return ev(ts, "thread_settings_applied", thread_settings=thread)


def win(pct, minutes, reset) -> dict:
    return {"used_percent": pct, "window_minutes": minutes, "resets_at": reset}


def lines(*items: str, end: bytes = b"\n") -> bytes:
    return b"".join(item.encode("utf-8") + end for item in items)


def T(h: int, m: int, s: int, ms: int = 0) -> str:
    return f"2026-07-12T{h:02d}:{m:02d}:{s:02d}.{ms:03d}Z"


PARENT = sid(20)

FILES: dict[str, bytes] = {
    # The counter-advance rule on one rollout (cc-usage's _EVENTS, plus odd shapes).
    f"sessions/2026/07/12/{rollout_name(1)}": lines(
        meta(1, T(12, 0, 0)),
        tok(T(12, 0, 1), (1000, 200, 50), (1000, 200, 50)),  # before the first turn_context
        ctx(T(12, 0, 2)),
        tok(T(12, 1, 0), (3000, 1500, 90), (2000, 1300, 40)),
        tok(T(12, 1, 0), (3000, 1500, 90), (2000, 1300, 40)),  # exact repeat
        tok(T(12, 1, 30), (3000, 1500, 90), (2000, 1300, 40)),  # later re-emit
        tok(T(12, 2, 0), (7000, 4000, 120), (0, 0, 0)),  # jump, empty last
        tok(T(12, 3, 0), (9500, 6000, 160), (2500, 2000, 40)),
        tok(T(12, 10, 0), (800, 100, 20), (800, 100, 20)),  # reset: total == last
        tok(T(12, 11, 0), (1300, 400, 45), (500, 300, 25)),
        tok(T(12, 12, 0), (1200, 300, 40), None),  # every counter fell, no last: a reset
        tok(T(12, 13, 0), (1000, 500, 41), (7, 1, 1)),  # partial fall with last: count last
        tok(T(12, 14, 0), (900, 600, 42), None),  # partial fall without last: nothing
        tok(T(12, 15, 0), None, (30, 10, 3)),  # no total: count last
        tok(T(12, 16, 0), (900, 600, 42), (0, 50, 0)),  # unchanged
        tok(T(12, 17, 0), (900, 700, 42), (0, 100, 0)),  # cached-only growth: no record
        ctx(T(12, 18, 0), model=""),  # an empty model changes nothing
        ctx(T(12, 18, 1), model=7),  # nor does a non-string one
        tok(T(12, 19, 0), (1000, 700, 50), (100, 0, 8)),
        ctx(T(12, 20, 0), model="gpt-other"),  # the model from here on
        tok(T(12, 21, 0), (1100, 700, 60), (100, 0, 10)),
        ev(T(12, 22, 0), "token_count", info="not an object"),
        dump({"timestamp": T(12, 23, 0), "type": "event_msg", "payload": "token_count"}),
        tok(T(12, 24, 0), (1200, 700, 70), (100, 0, 10), kind="something_else"),  # any type counts
        # "token_count" only inside text: parsed, nothing counted
        dump({"timestamp": T(12, 25, 0), "type": "response_item", "payload": {"type": "message", "text": "the \"token_count\" event"}}),
        '{"timestamp":"2026-07-12T12:26:00.000Z","type":"event_msg","payload":{"type":"token_count", BROKEN',
    ),
    # Value types: bools are ints, floats/negatives/strings are 0, big ints are kept.
    f"sessions/2026/07/12/{rollout_name(2)}": lines(
        ctx(T(13, 0, 0)),
        '{"timestamp":"2026-07-12T13:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":true,"cached_input_tokens":false,"output_tokens":5},"last_token_usage":{"input_tokens":true,"cached_input_tokens":false,"output_tokens":5}}}}',
        '{"timestamp":"2026-07-12T13:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10.0,"cached_input_tokens":-3,"output_tokens":"9"},"last_token_usage":{"input_tokens":4,"cached_input_tokens":1e2,"output_tokens":6}}}}',
        '{"timestamp":"2026-07-12T13:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9007199254740993,"cached_input_tokens":0,"output_tokens":7},"last_token_usage":{"input_tokens":20,"cached_input_tokens":0,"output_tokens":2}}}}',
        tok(T(13, 0, 4), (50, 70, 9), (5, 9, 1)),  # cached above input: cache read capped
    ),
    # Timestamps and limits: a token_count without a usable timestamp still yields limits.
    f"sessions/2026/07/12/{rollout_name(3)}": lines(
        tok(None, (10, 0, 1), (10, 0, 1), limits={"primary": win(10.0, 10080, 111), "secondary": None}),
        tok("not a time", (20, 0, 2), (10, 0, 1), limits={"primary": win(11.0, 10080, 112)}),
        tok(T(14, 0, 0), (30, 0, 3), (10, 0, 1), limits={"primary": win(28.5, 10080, 222), "secondary": win(5, 300, 333)}),
        tok(T(13, 59, 0), None, None, limits={"primary": win(99, 10080, 999)}),  # older: ignored
        tok(T(14, 0, 1), None, None, drop_info=True, limits={"primary": {"window_minutes": 300, "resets_at": 5}, "secondary": win(True, 300, 444)}),
        tok(T(14, 0, 2), None, None, drop_info=True, limits={"primary": None, "secondary": None}),
        tok("2026-07-12T14:00:03+00:00", (40, 0, 4), (10, 0, 1)),
        tok(" 2026-07-12T14:00:04.0005Z ", (50, 0, 5), (10, 0, 1)),
    ),
    # The same session archived while its active copy is still on disk: one set of keys.
    f"archived_sessions/{rollout_name(4)}": lines(
        ctx(T(15, 0, 0), model="gpt-copy"),
        tok(T(15, 0, 1), (100, 0, 10), (100, 0, 10)),
        tok(T(15, 0, 2), (300, 0, 30), (200, 0, 20)),
    ),
    f"sessions/2026/07/12/{rollout_name(4)}": lines(
        ctx(T(15, 0, 0), model="gpt-copy"),
        tok(T(15, 0, 1), (100, 0, 10), (100, 0, 10)),
        tok(T(15, 0, 2), (300, 0, 30), (200, 0, 20)),
        tok(T(15, 0, 3), (450, 0, 40), (150, 0, 10)),
    ),
    # A rollout whose name has no uuid: the stem is the session id. No turn_context at all.
    "sessions/2026/07/12/odd-name.jsonl": lines(
        tok(T(16, 0, 0), (60, 0, 6), (60, 0, 6)),
        tok(T(16, 0, 1), (90, 0, 9), (30, 0, 3)),
    ),
    # CRLF line ends, and a final line without a newline (not read yet).
    f"sessions/2026/07/12/{rollout_name(5)}": lines(
        ctx(T(17, 0, 0)), tok(T(17, 0, 1), (11, 0, 1), (11, 0, 1)), end=b"\r\n"
    )
    + tok(T(17, 0, 2), (22, 0, 2), (11, 0, 1)).encode(),
    # A parent and its replaying children (scheme 1 counts the replay; scheme 2 does not).
    f"sessions/2026/07/12/{rollout_name(20)}": lines(
        meta(20, T(18, 0, 0)),
        ctx(T(18, 0, 0)),
        ev(T(18, 0, 1), "task_started"),
        tok(T(18, 1, 0), (1000, 100, 200), (1000, 100, 200)),
        tok(T(18, 2, 0), (1500, 150, 300), (500, 50, 100)),
        settings(T(18, 2, 30), "priority"),
        tok(T(18, 3, 0), (1700, 150, 330), (200, 0, 30)),
        settings(T(18, 3, 30), absent=True),  # no key: still priority
        tok(T(18, 4, 0), (1800, 150, 340), (100, 0, 10)),
        settings(T(18, 4, 30), "turbo"),  # unknown: fall back to config.toml
        tok(T(18, 5, 0), (1900, 150, 350), (100, 0, 10)),
        settings(T(18, 5, 30), "standard"),
        tok(T(18, 6, 0), (2000, 150, 360), (100, 0, 10)),
    ),
    # MultiAgent V2 subagent: replayed parent history, then task_started, turn_context and
    # the trigger turn; usage before that task_started is inherited.
    f"sessions/2026/07/12/{rollout_name(21)}": lines(
        meta(21, T(18, 7, 0), PARENT, spawn=True),
        ctx(T(18, 7, 0)),
        tok(T(18, 7, 0), (1000, 100, 200), (1000, 100, 200)),
        ev(T(18, 7, 0), "task_started"),
        tok(T(18, 7, 0), (1500, 150, 300), (500, 50, 100)),
        iac(T(18, 7, 0), False),
        ev(T(18, 7, 0), "task_started"),
        ctx(T(18, 7, 0)),
        iac(T(18, 7, 0), True),
        tok(T(18, 8, 0), (1600, 160, 320), (100, 10, 20)),
        tok(T(18, 9, 0), (1650, 165, 330), (50, 5, 10)),
    ),
    # The older event name, and a trigger_turn without a task_started before it.
    f"sessions/2026/07/12/{rollout_name(22)}": lines(
        meta(22, T(18, 10, 0), PARENT, spawn=True),
        tok(T(18, 10, 0), (1000, 100, 200), (1000, 100, 200)),
        tok(T(18, 10, 0), (1500, 150, 300), (500, 50, 100)),
        iac(T(18, 10, 0), True, name="inter_agent_communication"),
        tok(T(18, 11, 0), (1520, 150, 305), (20, 0, 5)),
    ),
    # A fork without markers: its head replays the parent's stream from the start.
    f"sessions/2026/07/12/{rollout_name(23)}": lines(
        meta(23, T(18, 12, 0), PARENT),
        ev(T(18, 12, 0), "task_started"),
        tok(T(18, 1, 0), (1000, 100, 200), (1000, 100, 200)),
        tok(T(18, 2, 0), (1500, 150, 300), (500, 50, 100)),
        tok(T(18, 13, 0), (1600, 150, 310), (100, 0, 10)),
    ),
    # A fork whose parent is not on disk: the burst written at its head is inherited.
    f"sessions/2026/07/12/{rollout_name(24)}": lines(
        meta(24, T(18, 14, 0), sid(99)),
        tok(T(18, 14, 0, 100), (5000, 4000, 100), (5000, 4000, 100)),
        tok(T(18, 14, 0, 200), (6000, 4500, 150), (1000, 500, 50)),
        tok(T(18, 14, 10), (6100, 4500, 160), (100, 0, 10)),
    ),
    # Markers with trigger_turn false: no trigger turn, so the fork rule decides.
    f"sessions/2026/07/12/{rollout_name(25)}": lines(
        meta(25, T(18, 15, 0), PARENT, spawn=True),
        tok(T(18, 15, 0), (1000, 100, 200), (1000, 100, 200)),
        iac(T(18, 15, 0), False),
        ev(T(18, 15, 0), "task_started"),
        tok(T(18, 16, 0), (1100, 100, 220), (100, 0, 20)),
    ),
    # Markers in a rollout with no parent: nothing is inherited.
    f"sessions/2026/07/12/{rollout_name(26)}": lines(
        meta(26, T(18, 17, 0)),
        tok(T(18, 17, 1), (70, 0, 7), (70, 0, 7)),
        ev(T(18, 17, 2), "task_started"),
        iac(T(18, 17, 3), True),
        tok(T(18, 17, 4), (80, 0, 8), (10, 0, 1)),
    ),
}


def main() -> None:
    for name, data in FILES.items():
        assert_fake(name)
        assert_fake(data.decode("utf-8", "replace"))
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / ".codex"
        for name, data in FILES.items():
            path = home / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        parser = Parser({}, roots=[(home / "sessions", "codex"), (home / "archived_sessions", "codex")])
        parser.scan()
        records = []
        for rec in parser.records:
            assert rec.lkey is not None and rec.provider == "codex"
            records.append(
                {
                    "key": str(rec.lkey),
                    "ts": round(rec.ts * 1000),
                    "model": rec.model_raw,
                    "inp": int(rec.input_tokens),
                    "outp": int(rec.output_tokens),
                    "cr": int(rec.cache_read),
                    "cc": int(rec.cache_creation),
                    "e5": rec._eph_5m,
                    "e1": rec._eph_1h,
                }
            )
        limits = parser.latest_rate_limits_by_account.get("codex")
    records.sort(key=lambda r: int(r["key"]))
    out = {
        "files": {name: base64.b64encode(data).decode("ascii") for name, data in FILES.items()},
        "records": records,
        "limits": limits,
        "malformed": parser.stats.malformed,
    }
    text = json.dumps(out, indent=1, ensure_ascii=True) + "\n"
    assert_fake(text)
    OUT.write_text(text, "utf-8")
    print(f"wrote {len(records)} records to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
