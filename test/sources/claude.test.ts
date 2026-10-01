import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Counts,
  extractClaude,
  type FileEntry,
  mergeCounts,
  readClaudeFile,
} from "../../src/sources/claude.ts";
import { ledgerKey } from "../../src/store/key.ts";
import { cleanup, tempDir } from "../ingest/helpers.ts";

afterEach(cleanup);

function fileWith(text: string | Buffer): string {
  const path = join(tempDir(), "s.jsonl");
  writeFileSync(path, text);
  return path;
}

/** One assistant usage line, as cc-usage's test_parser.py `_asst_line` builds it. */
function asst(
  req: string | null,
  mid: string | null,
  o: {
    inp?: number;
    out?: number;
    cacheRead?: number;
    cacheCreation?: number;
    e5?: number;
    e1?: number;
    model?: string;
    ts?: string;
  } = {},
): string {
  const usage: Record<string, unknown> = {
    input_tokens: o.inp ?? 0,
    output_tokens: o.out ?? 0,
    cache_read_input_tokens: o.cacheRead ?? 0,
    cache_creation_input_tokens: o.cacheCreation ?? 0,
  };
  if (o.e5 !== undefined || o.e1 !== undefined) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: o.e5 ?? 0,
      ephemeral_1h_input_tokens: o.e1 ?? 0,
    };
  }
  const message: Record<string, unknown> = { model: o.model ?? "claude-opus-4-8", usage };
  if (mid !== null) message.id = mid;
  return `${JSON.stringify({ type: "assistant", requestId: req, timestamp: o.ts ?? "2026-06-01T00:00:00.000Z", message })}\n`;
}

/** The single event a file's entries make when applied to an empty index. */
function only(entries: FileEntry[]): Counts {
  expect(entries).toHaveLength(1);
  return entries[0]?.post as Counts;
}

// ── ported from cc-usage tests/test_parser.py ───────────────────────────────────
// Its fixtures/sample.jsonl, rebuilt with fake ids: a streaming pair, an unknown model,
// a [1m] model id, broken JSON, a user line and an assistant line without usage.
const SAMPLE = [
  '{"type":"assistant","requestId":"req_FAKEA","timestamp":"2026-06-01T00:00:00.000Z","message":{"id":"msg_FAKEA","model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1,"cache_read_input_tokens":10000,"cache_creation_input_tokens":4000,"cache_creation":{"ephemeral_5m_input_tokens":1000,"ephemeral_1h_input_tokens":3000}}}}',
  '{"type":"assistant","requestId":"req_FAKEA","timestamp":"2026-06-01T00:00:01.000Z","message":{"id":"msg_FAKEA","model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":2000,"cache_read_input_tokens":10000,"cache_creation_input_tokens":4000,"cache_creation":{"ephemeral_5m_input_tokens":1000,"ephemeral_1h_input_tokens":3000}}}}',
  '{"type":"assistant","requestId":"req_FAKEB","timestamp":"2026-06-01T00:00:02.000Z","message":{"id":"msg_FAKEB","model":"claude-sonnet-4-6","usage":{"input_tokens":500,"output_tokens":100,"cache_read_input_tokens":2000,"cache_creation_input_tokens":800}}}',
  '{"type":"assistant","requestId":"req_FAKEC","timestamp":"2026-06-01T00:00:03.000Z","message":{"id":"msg_FAKEC","model":"claude-mystery-9","usage":{"input_tokens":1000,"output_tokens":1000}}}',
  '{"type":"assistant","requestId":"req_FAKED","timestamp":"2026-06-01T00:00:04.000Z","message":{"id":"msg_FAKED","model":"claude-opus-4-8[1m]","usage":{"input_tokens":200,"output_tokens":50}}}',
  '{"type":"assistant","requestId":"req_FAKEBAD","message":{"usage":{"input_tokens": THIS IS NOT VALID JSON }}}',
  '{"type":"user","timestamp":"2026-06-01T00:00:05.000Z","message":{"role":"user","content":"the assistant usage spiked today"}}',
  '{"type":"assistant","requestId":"req_FAKENoU","timestamp":"2026-06-01T00:00:06.000Z","message":{"id":"msg_FAKENoU","model":"claude-opus-4-8"}}',
]
  .map((l) => `${l}\n`)
  .join("");

describe("test_parser.py", () => {
  const sample = () => readClaudeFile(fileWith(SAMPLE), 0);

  test("counts_dedup_and_malformed", () => {
    const { entries, stats } = sample();
    expect(entries).toHaveLength(4); // A, B, C, D (A's second line merged)
    expect(stats.usageLines - entries.length).toBe(1); // the merged duplicate
    expect(stats.malformed).toBe(1); // the broken-JSON line
  });

  test("unknown_model_kept_with_its_tokens", () => {
    const c = sample().entries.find((e) => e.model === "claude-mystery-9");
    expect(c?.post).toMatchObject({ inp: 1000, outp: 1000 });
  });

  test("token_totals_match_hand_sum", () => {
    const posts = sample().entries.map((e) => e.post as Counts);
    const sum = (f: (c: Counts) => number) => posts.reduce((a, c) => a + f(c), 0);
    expect(sum((c) => c.inp)).toBe(2700);
    expect(sum((c) => c.outp)).toBe(3150);
    expect(sum((c) => c.cr)).toBe(12000);
    expect(sum((c) => c.cc)).toBe(4800);
  });

  test("the [1m] model id is stored raw", () => {
    expect(sample().entries.map((e) => e.model)).toContain("claude-opus-4-8[1m]");
  });

  test("streaming_lines_merge_to_final_not_first", () => {
    const a = sample().entries.find((e) => e.post?.cr === 10000)?.post;
    expect(a).toMatchObject({ outp: 2000, inp: 1000, cr: 10000, cc: 4000 });
  });

  test("streaming_lines_merge_keep_final_output", () => {
    const file = fileWith(
      asst("r", "m", { inp: 1000, out: 7, cacheRead: 500, cacheCreation: 200 }) +
        asst("r", "m", { inp: 1000, out: 500, cacheRead: 500, cacheCreation: 200 }) +
        asst("r", "m", { inp: 1000, out: 2000, cacheRead: 500, cacheCreation: 200 }),
    );
    const { entries, stats } = readClaudeFile(file, 0);
    expect(stats.usageLines - entries.length).toBe(2);
    expect(only(entries)).toMatchObject({ outp: 2000, inp: 1000 });
  });

  test("merge_takes_field_max_not_sum", () => {
    const file = fileWith(
      asst("r", "m", { inp: 1000, out: 500, cacheRead: 800, cacheCreation: 300 }) +
        asst("r", "m", { inp: 1000, out: 2000, cacheRead: 800, cacheCreation: 300 }) +
        asst("r", "m", { inp: 1000, out: 7, cacheRead: 800, cacheCreation: 300 }),
    );
    expect(only(readClaudeFile(file, 0).entries)).toMatchObject({
      outp: 2000,
      inp: 1000,
      cr: 800,
      cc: 300,
    });
  });

  test("merge_max_applies_to_every_counter_out_of_order", () => {
    const file = fileWith(
      asst("r", "m", { inp: 300, out: 7, cacheRead: 800, cacheCreation: 100 }) +
        asst("r", "m", { inp: 900, out: 2000, cacheRead: 200, cacheCreation: 400 }) +
        asst("r", "m", { inp: 600, out: 500, cacheRead: 500, cacheCreation: 250 }),
    );
    expect(only(readClaudeFile(file, 0).entries)).toMatchObject({
      inp: 900,
      outp: 2000,
      cr: 800,
      cc: 400,
    });
  });

  test("distinct_message_ids_stay_separate", () => {
    const file = fileWith(
      asst("r1", "m1", { inp: 100, out: 10 }) + asst("r2", "m2", { inp: 200, out: 20 }),
    );
    const { entries } = readClaudeFile(file, 0);
    expect(entries).toHaveLength(2);
    expect(entries.reduce((a, e) => a + (e.post?.outp ?? 0), 0)).toBe(30);
  });

  test("lines_without_message_id_are_not_merged: neither is stored, both are counted as unkeyed", () => {
    // cc-usage counted such a line live but could never store it (lkey None); tokenhud
    // keeps only stored history, so it reports them instead.
    const file = fileWith(
      asst("r1", null, { inp: 100, out: 10 }) + asst("r1", null, { inp: 200, out: 20 }),
    );
    const { entries, stats } = readClaudeFile(file, 0);
    expect(entries).toHaveLength(0);
    expect(stats.unkeyed).toBe(2);
  });

  test("merge_preserves_subbuckets", () => {
    const file = fileWith(
      asst("r", "m", { inp: 1000, out: 7, cacheCreation: 4000, e5: 1000, e1: 3000 }) +
        asst("r", "m", { inp: 1000, out: 2000, cacheCreation: 4000, e5: 1000, e1: 3000 }),
    );
    expect(only(readClaudeFile(file, 0).entries)).toMatchObject({ cc: 4000, e5: 1000, e1: 3000 });
  });

  test("merge_without_subbuckets_keeps_them_null (the 1.25x fallback)", () => {
    const file = fileWith(
      asst("r", "m", { inp: 1000, out: 7, cacheCreation: 4000 }) +
        asst("r", "m", { inp: 1000, out: 2000, cacheCreation: 4000 }),
    );
    expect(only(readClaudeFile(file, 0).entries)).toMatchObject({ cc: 4000, e5: null, e1: null });
  });
});

// ── tokenhud's own rules ─────────────────────────────────────────────────────────

describe("extractClaude", () => {
  const base = { type: "assistant", requestId: "req_FAKE1", timestamp: "2026-06-01T00:00:00Z" };

  test("keys on requestId and message.id, else uuid, else none", () => {
    const usage = { input_tokens: 1 };
    expect(extractClaude({ ...base, message: { id: "msg_FAKE1", usage } })?.material).toBe(
      "c\x1freq_FAKE1\x1fmsg_FAKE1",
    );
    expect(
      extractClaude({
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000001",
        message: { usage },
      })?.material,
    ).toBe("u\x1f00000000-0000-4000-8000-000000000001");
    expect(extractClaude({ type: "assistant", message: { usage } })?.material).toBeNull();
  });

  test("speed fast is tier 1; anything else tier 0", () => {
    const line = (speed: unknown) =>
      extractClaude({ ...base, message: { id: "msg_FAKE1", usage: { input_tokens: 1, speed } } })
        ?.counts.tier;
    expect(line("fast")).toBe(1);
    expect(line("standard")).toBe(0);
    expect(line(undefined)).toBe(0);
    expect(line("FAST")).toBe(0);
  });

  test("a model id that is not a string throws (cc-usage itself crashes there)", () => {
    expect(() =>
      extractClaude({ ...base, message: { id: "msg_FAKE1", model: 5, usage: {} } }),
    ).toThrow(TypeError);
  });
});

test("mergeCounts keeps null sub-buckets only while both lack them, and takes the max tier", () => {
  const a: Counts = { inp: 1, outp: 5, cr: 0, cc: 0, e5: null, e1: 3, tier: 0 };
  const b: Counts = { inp: 2, outp: 1, cr: 0, cc: 0, e5: 4, e1: null, tier: 1 };
  expect(mergeCounts(a, b)).toEqual({ inp: 2, outp: 5, cr: 0, cc: 0, e5: 4, e1: 3, tier: 1 });
  expect(mergeCounts(null, b)).toEqual(b);
  expect(mergeCounts(null, b)).not.toBe(b);
});

describe("reading", () => {
  test("a final line without a newline is left for later; the offset stops before it", () => {
    const first = asst("r1", "m1", { inp: 100 });
    const second = asst("r2", "m2", { inp: 200 });
    const path = fileWith(first + second.trimEnd());
    const read = readClaudeFile(path, 0);
    expect(read.entries).toHaveLength(1);
    expect(read.offset).toBe(Buffer.byteLength(first));
    expect(read.stats.lines).toBe(1);
    writeFileSync(path, first + second);
    const rest = readClaudeFile(path, read.offset);
    expect(rest.entries.map((e) => e.post?.inp)).toEqual([200]);
    expect(rest.offset).toBe(Buffer.byteLength(first + second));
  });

  test("reads from the given offset only", () => {
    const first = asst("r1", "m1", { inp: 100 });
    const path = fileWith(first + asst("r2", "m2", { inp: 200 }));
    expect(readClaudeFile(path, Buffer.byteLength(first)).entries.map((e) => e.post?.inp)).toEqual([
      200,
    ]);
  });

  test("a line longer than the buffer grows it", () => {
    const big = asst("r", "m", { inp: 7, model: `claude-${"x".repeat(5000)}` });
    const read = readClaudeFile(fileWith(big + asst("r2", "m2", { inp: 8 })), 0, {
      chunkBytes: 64,
    });
    expect(read.entries.map((e) => e.post?.inp)).toEqual([7, 8]);
  });
});

// ── the prefilter cannot skip a line cc-usage would count ─────────────────────────

/** A seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reference: cc-usage's `_read_new` loop over the same bytes, line by line. */
function naive(bytes: Buffer): {
  lines: number;
  candidates: number;
  keys: Map<bigint, Counts>;
  offset: number;
} {
  const keys = new Map<bigint, Counts>();
  let lines = 0;
  let candidates = 0;
  let pos = 0;
  for (;;) {
    const nl = bytes.indexOf(10, pos);
    if (nl < 0) break;
    lines++;
    const raw = bytes.subarray(pos, nl);
    pos = nl + 1;
    if (raw.indexOf('"usage"') < 0) continue;
    candidates++;
    if (
      raw.indexOf("assistant") < 0 ||
      raw.indexOf('"token_count"') >= 0 ||
      raw.indexOf('"turn_context"') >= 0
    )
      continue;
    let line: ReturnType<typeof extractClaude> = null;
    try {
      line = extractClaude(JSON.parse(raw.toString("utf8")));
    } catch {
      continue;
    }
    if (line?.material == null) continue;
    const key = ledgerKey(line.material);
    keys.set(key, mergeCounts(keys.get(key) ?? null, line.counts) as Counts);
  }
  return { lines, candidates, keys, offset: pos };
}

function randomLine(next: () => number, i: number): string {
  const r = next();
  if (r < 0.35)
    return asst(`r${i % 7}`, `m${i % 7}`, { inp: i, out: Math.floor(next() * 1000) }).trimEnd();
  if (r < 0.5) return `{"type":"user","note":"the \\"usage\\" word","n":${i}}`;
  if (r < 0.6) return `"usage"`.repeat(1 + Math.floor(next() * 3));
  if (r < 0.7) return "";
  if (r < 0.8)
    return `{"type":"assistant","message":{"usage":{"input_tokens":${i}}},"pad":"${"y".repeat(Math.floor(next() * 300))}"}`;
  return "x".repeat(Math.floor(next() * 200));
}

test("chunked reading finds exactly the lines a line-by-line read finds, at any chunk size", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const next = rng(seed);
    const count = 1 + Math.floor(next() * 40);
    const body = Array.from({ length: count }, (_, i) => randomLine(next, i)).join("\n");
    const bytes = Buffer.from(next() < 0.5 ? body : `${body}\n`);
    const path = fileWith(bytes);
    const want = naive(bytes);
    for (const chunkBytes of [1, 2, 7, 8, 13, 64, 255, 4096]) {
      const got = readClaudeFile(path, 0, { chunkBytes });
      expect({
        seed,
        chunkBytes,
        lines: got.stats.lines,
        candidates: got.stats.candidates,
        offset: got.offset,
      }).toEqual({
        seed,
        chunkBytes,
        lines: want.lines,
        candidates: want.candidates,
        offset: want.offset,
      });
      expect(
        new Map(got.entries.map((e) => [e.key, mergeCounts(mergeCounts(null, e.pre), e.post)])),
      ).toEqual(want.keys);
    }
  }
});
