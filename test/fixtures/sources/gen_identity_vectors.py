"""Generate identity-vectors.json: cc-usage's account identity for root paths.

Run with cc-usage's Python (it must be able to `import cc_usage`), from anywhere:

    /mnt/d/Projects/CC_Usage/.venv/bin/python test/fixtures/sources/gen_identity_vectors.py

Each vector is a configured root path and `accounts.root_identity(Path(path))`, with HOME
set to the fake `/home/example` so `~` expands the same everywhere. Every path is a literal
that does not exist (its first missing component is a made-up name), so Python resolves it
lexically: the TypeScript port is tested with a file system that has no symlinks, and
symlinks are tested against the real file system separately. Nothing is read from this
machine beyond the lstat calls `resolve()` makes.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from cc_usage.accounts import root_identity

OUT = Path(__file__).with_name("identity-vectors.json")
HOME = "/home/example"

PATHS = [
    "/home/example/.claude",
    "/home/example/.claude-work",
    "~/.claude",
    "~/.claude-work/",
    "~",
    "~/",
    "/home/example//.claude/",
    "/home/example/./.claude",
    "/home/example/x/../.claude",
    "/home/example/../example/.claude",
    "//home/example/.claude",
    "///home/example/.claude",
    "/mnt/c/Users/Example User/.claude",
    "/mnt/c/Users/Example User/.codex",
    "/mnt/c/Users/example/.claude-team",
    "/mnt/d/Work Dirs/claude config",
    "/home/example/.claude-équipe",
    "/home/example/.claude-équipe",
    "/home/example/配置/.claude",
    "/home/example/\U0001f600/.claude",
    "/home/example/.codex",
    "/srv/claude/../../home/example/.claude",
    "/..",
    "/",
]


def main() -> None:
    os.environ["HOME"] = HOME
    vectors = [{"path": p, "identity": root_identity(Path(p))} for p in PATHS]
    OUT.write_text(json.dumps(vectors, indent=1, ensure_ascii=True) + "\n", "utf-8")
    print(f"wrote {len(vectors)} vectors to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
