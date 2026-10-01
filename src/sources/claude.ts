import { closeSync, openSync, readSync } from "node:fs";
import { ledgerKey } from "../store/key.ts";
import { needsPyJson, PyBigInt, PyFloat, parsePyJson, pyStr, pyTruthy } from "./pyjson.ts";
import { timestampMs } from "./timestamp.ts";

/**
 * Claude Code transcripts, ported rule for rule from cc-usage's `parser.py` (`_ingest_line`,
 * `_extract`, `_dedup_key`, `_merge`, `_read_new`).
 *
 * A line counts when its bytes contain `"usage"` and `assistant` but neither
 * `"token_count"` nor `"turn_context"` (cc-usage sends those to its Codex rules, which a
 * Claude line never satisfies), it parses as a JSON object of type "assistant" whose
 * `message.usage` is an object, and its model is not `<synthetic>`. Lines sharing a key,
 * `(requestId, message.id)` or else the line's `uuid`, are one usage event: Claude Code
 * streams one reply over several lines, so their counts merge by field-wise max. The first
 * line with a usable timestamp creates the event and fixes its timestamp and model; a line
 * before that, with no timestamp, counts only toward an event that already exists.
 *
 * New in tokenhud: `usage.speed === "fast"` marks the event tier 1 (fast mode pricing);
 * the tier merges by max and is not part of the key.
 */

/** Separator in key material (cc-usage's `_KEY_SEP`): never occurs in ids or numbers. */
export const KEY_SEP = "\x1f";

/** Token counts of one line or event. e5/e1 are null when the line had no `cache_creation` object. */
export interface Counts {
  inp: number;
  outp: number;
  cr: number;
  cc: number;
  e5: number | null;
  e1: number | null;
  tier: number;
}

/** What one usage line contributes. */
export interface UsageLine {
  /** Key material, or null when the line has neither message.id nor uuid (it cannot be stored). */
  material: string | null;
  /** Epoch ms, or null when cc-usage could not parse the timestamp. */
  ts: number | null;
  model: string;
  counts: Counts;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PyFloat) &&
    !(value instanceof PyBigInt)
  );
}

/** cc-usage's `_int`: an int (bool included) as itself, anything else, floats too, as 0. */
function pyIntField(value: unknown): number {
  if (typeof value === "number") return Number.isInteger(value) ? value : 0;
  if (value === true) return 1;
  if (value instanceof PyBigInt) return Number(value.value);
  return 0;
}

function maxOpt(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Field-wise max of two count sets (cc-usage's `_merge`, plus tier). Either may be null. */
export function mergeCounts(a: Counts | null, b: Counts | null): Counts | null {
  if (a === null) return b && { ...b };
  if (b === null) return a;
  a.inp = Math.max(a.inp, b.inp);
  a.outp = Math.max(a.outp, b.outp);
  a.cr = Math.max(a.cr, b.cr);
  a.cc = Math.max(a.cc, b.cc);
  a.e5 = maxOpt(a.e5, b.e5);
  a.e1 = maxOpt(a.e1, b.e1);
  a.tier = Math.max(a.tier, b.tier);
  return a;
}

/**
 * cc-usage's `_extract` and `_dedup_key` for one parsed line: the usage it carries, or
 * null when the line is not a usage line. Throws `TypeError` for a model id that is
 * neither a string nor falsy (cc-usage itself crashes on one); the caller counts the line
 * as malformed.
 */
export function extractClaude(obj: unknown): UsageLine | null {
  if (!isObject(obj) || obj.type !== "assistant") return null;
  const msg = obj.message;
  if (!isObject(msg)) return null;
  const usage = msg.usage;
  if (!isObject(usage)) return null;
  const rawModel = pyTruthy(msg.model) ? msg.model : "";
  if (typeof rawModel !== "string") throw new TypeError("model id is not a string");
  if (rawModel === "<synthetic>") return null;

  const inp = pyIntField(usage.input_tokens);
  const outp = pyIntField(usage.output_tokens);
  const cr = pyIntField(usage.cache_read_input_tokens);
  let cc = pyIntField(usage.cache_creation_input_tokens);
  let e5: number | null = null;
  let e1: number | null = null;
  const sub = usage.cache_creation;
  if (isObject(sub)) {
    e5 = pyIntField(sub.ephemeral_5m_input_tokens);
    e1 = pyIntField(sub.ephemeral_1h_input_tokens);
    // An absent aggregate is derived from the buckets.
    if (cc === 0 && (e5 || e1)) cc = e5 + e1;
  }

  let material: string | null = null;
  if (pyTruthy(msg.id)) {
    const req = obj.requestId;
    material = `c${KEY_SEP}${req === null || req === undefined ? "" : pyStr(req)}${KEY_SEP}${pyStr(msg.id)}`;
  } else if (typeof obj.uuid === "string" && obj.uuid !== "") {
    material = `u${KEY_SEP}${obj.uuid}`;
  }
  return {
    material,
    ts: timestampMs(obj.timestamp),
    model: rawModel,
    counts: { inp, outp, cr, cc, e5, e1, tier: usage.speed === "fast" ? 1 : 0 },
  };
}

// ── reading a file ────────────────────────────────────────────────────────────────

/**
 * One key's lines in one file. Applied to the events seen so far, in cc-usage's file order:
 * if the key exists, `pre` and `post` merge into it; else, if `ts` is set, the event is
 * created with `ts`, `model` and `post` (and `pre` is dropped, as cc-usage drops a line
 * that cannot create an event); else nothing is created.
 */
export interface FileEntry {
  key: bigint;
  /** Lines before the first one with a usable timestamp. */
  pre: Counts | null;
  /** The first usable timestamp, from the line that would create the event. */
  ts: number | null;
  model: string;
  /** That line and every later one. */
  post: Counts | null;
}

export interface ReadStats {
  /** Bytes read, through the last complete line. */
  bytes: number;
  /** Complete lines read. */
  lines: number;
  /** Lines containing `"usage"`. */
  candidates: number;
  /** Candidates that passed the byte checks but not JSON or model checks. */
  malformed: number;
  /** Usage lines kept (with a key). */
  usageLines: number;
  /** Usage lines without message.id or uuid: cc-usage counted them live but never stored them. */
  unkeyed: number;
}

export interface FileRead {
  /** File offset after the last complete line: where the next read starts. */
  offset: number;
  entries: FileEntry[];
  stats: ReadStats;
}

export interface ReadOptions {
  /** Read buffer size; a longer line grows it. Tests shrink it to cross chunk edges. */
  chunkBytes?: number;
}

export const CHUNK_BYTES = 4 * 1024 * 1024;

// One read buffer per thread, reused from file to file: allocating 4 MB for each file costs
// more than parsing most of them, and with several Workers the page faults contend.
let spare: Buffer | null = null;

function takeBuffer(size: number): Buffer {
  if (size === CHUNK_BYTES && spare !== null) {
    const buf = spare;
    spare = null;
    return buf;
  }
  return Buffer.allocUnsafe(size);
}

const NEWLINE = 0x0a;
const MARK = Buffer.from('"usage"');

export function emptyStats(): ReadStats {
  return { bytes: 0, lines: 0, candidates: 0, malformed: 0, usageLines: 0, unkeyed: 0 };
}

/** Folds lines into per-key file entries, keeping first-appearance order. */
class FileFold {
  readonly byMaterial = new Map<string, Omit<FileEntry, "key">>();

  add(line: UsageLine & { material: string }): void {
    let entry = this.byMaterial.get(line.material);
    if (entry === undefined) {
      entry = { pre: null, ts: null, model: "", post: null };
      this.byMaterial.set(line.material, entry);
    }
    if (entry.ts !== null) {
      entry.post = mergeCounts(entry.post, line.counts);
    } else if (line.ts !== null) {
      entry.ts = line.ts;
      entry.model = line.model;
      entry.post = { ...line.counts };
    } else {
      entry.pre = mergeCounts(entry.pre, line.counts);
    }
  }

  entries(): FileEntry[] {
    return [...this.byMaterial].map(([material, entry]) => ({
      key: ledgerKey(material),
      ...entry,
    }));
  }
}

/**
 * Applies cc-usage's checks to the complete line `buf[start, end)`, which contains
 * `"usage"`, and folds its usage into `fold`.
 */
function handleCandidate(
  buf: Buffer,
  start: number,
  end: number,
  fold: FileFold,
  stats: ReadStats,
): void {
  stats.candidates++;
  // Invalid UTF-8 becomes U+FFFD, as cc-usage's `decode("utf-8", "replace")`. Decoding
  // never adds, drops or alters an ASCII character, so these substring tests on the text
  // answer exactly what cc-usage's tests on the bytes answer.
  const text = buf.toString("utf8", start, end);
  if (
    !text.includes("assistant") ||
    text.includes('"token_count"') ||
    text.includes('"turn_context"')
  ) {
    return;
  }
  let line: UsageLine | null;
  try {
    line = extractClaude(JSON.parse(text));
    if (line !== null && needsPyJson(text)) line = extractClaude(parsePyJson(text));
  } catch {
    stats.malformed++;
    return;
  }
  if (line === null) return;
  if (line.material === null) {
    stats.unkeyed++;
    return;
  }
  stats.usageLines++;
  fold.add(line as UsageLine & { material: string });
}

/**
 * Reads the complete lines of `path` from byte `start` on, the way cc-usage's `_read_new`
 * does, but in large chunks: a native search for `"usage"` jumps straight to candidate
 * lines and only those are decoded and parsed.
 *
 * Why no counted line can be skipped: cc-usage parses a line only if its bytes contain
 * `"usage"`, and every such line is found here. Each chunk is searched only up to its last
 * newline, the unfinished tail moves to the front of the next read, and a line longer
 * than the buffer grows the buffer; so every complete line is searched whole, in one piece.
 * After a hit the search resumes after that line's newline, so a line between two hits
 * holds no `"usage"`. A final line without a newline is left for the next read, as
 * cc-usage leaves it (`offset` stops before it). Throws on I/O errors.
 */
export function readClaudeFile(path: string, start: number, options: ReadOptions = {}): FileRead {
  const fold = new FileFold();
  const stats = emptyStats();
  let buf = takeBuffer(options.chunkBytes ?? CHUNK_BYTES);
  let have = 0;
  let base = start;
  const fd = openSync(path, "r");
  try {
    for (;;) {
      if (have === buf.length) {
        const bigger = Buffer.allocUnsafe(buf.length * 2);
        buf.copy(bigger, 0, 0, have);
        buf = bigger;
      }
      const n = readSync(fd, buf, have, buf.length - have, base + have);
      if (n === 0) break;
      have += n;
      const limit = buf.lastIndexOf(NEWLINE, have - 1) + 1;
      if (limit === 0) continue;
      const view = buf.subarray(0, limit);
      for (let nl = view.indexOf(NEWLINE); nl >= 0; nl = view.indexOf(NEWLINE, nl + 1))
        stats.lines++;
      let pos = 0;
      for (;;) {
        const hit = view.indexOf(MARK, pos);
        if (hit < 0) break;
        const lineStart = view.lastIndexOf(NEWLINE, hit) + 1;
        const lineEnd = view.indexOf(NEWLINE, hit);
        handleCandidate(view, lineStart, lineEnd, fold, stats);
        pos = lineEnd + 1;
      }
      buf.copy(buf, 0, limit, have);
      base += limit;
      have -= limit;
    }
  } finally {
    closeSync(fd);
    if (buf.length === CHUNK_BYTES) spare = buf;
  }
  stats.bytes = base - start;
  return { offset: base, entries: fold.entries(), stats };
}
