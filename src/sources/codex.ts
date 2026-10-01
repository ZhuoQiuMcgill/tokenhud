import { closeSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { ledgerKey } from "../store/key.ts";
import { UNATTRIBUTED } from "../store/schema.ts";
import { emptyStats, type FileEntry, KEY_SEP, type ReadStats } from "./claude.ts";
import { needsPyJson, PyBigInt, PyFloat, parsePyJson } from "./pyjson.ts";
import { timestampMs } from "./timestamp.ts";

/**
 * Codex rollouts (`<CODEX_HOME>/sessions/**` and `archived_sessions/`).
 *
 * **Scheme 1** is cc-usage's parser, ported rule for rule (`codex_session_id`, `_codex_int`,
 * `_extract_codex`, `_reconcile_codex_model`, `_capture_codex_limits` and the Codex parts
 * of `_ingest_line`):
 * - A line is looked at when its bytes contain `"token_count"` or `"turn_context"`.
 * - A `turn_context` with a non-empty string model sets the rollout's model; records made
 *   before the first one carry `codex-unattributed` until it arrives, then take its model.
 * - A `token_count` counts by the rollout's cumulative counters: the first event counts its
 *   `last_token_usage`, an unchanged total counts nothing, growth counts the delta, a reset
 *   (every counter fell, or the total fell to exactly `last`) counts the new total, and
 *   anything else counts `last`. Cached input is split off the input.
 * - The key is the session (the UUID in the file name), the event's timestamp and its total
 *   and last counters, so an archived copy or a re-read yields the same keys.
 *
 * **Scheme 2** (tokenhud's live rule) is scheme 1 with the same keys, plus:
 * - **Replay skip.** A *child* rollout (its first line is a `session_meta` naming a parent:
 *   `forked_from_id`, else `source.subagent.thread_spawn.parent_thread_id`) may open with
 *   usage it inherited from its parent. Which usage that is, is decided in its *head*:
 *   - **replay.rs's rule** (logic adapted from ccusage (MIT), `replay.rs` and `parser.rs`):
 *     the leading events that continue the parent's usage stream (up to the fork time), or,
 *     when the very first one does not, the burst Codex wrote at the head of the file;
 *   - **in a subagent rollout** (`thread_spawn`), the first trigger-turn marker
 *     (`inter_agent_communication_metadata`, or the older `inter_agent_communication`, with
 *     `payload.trigger_turn === true`) overrides that rule whenever it comes: usage before
 *     the `task_started` that precedes the marker (or before the marker, if none does) is
 *     inherited, and the rest is the child's own. Until a marker arrives, replay.rs's
 *     judgement stands, and the head stays open.
 *   A fork without `thread_spawn` follows replay.rs alone, and its head ends with replay.rs's
 *   first own event. Inherited usage is not counted, and its keys are reported (`drop`) so
 *   they never stay in the store; keys a marker gives back are reported too (`restore`).
 *   The counters run through inherited usage, so the first own event counts only its own
 *   growth.
 * - **Speed tier.** `thread_settings_applied` sets the tier from `service_tier`
 *   (`priority`/`fast` 1, `default`/`standard` 0); a settings event without the key keeps
 *   the previous tier, and any other value is standard. A rollout's events are the only
 *   evidence of a tier: no settings event means standard (0). The current `config.toml` is
 *   never consulted, because it says nothing about the history being priced.
 *
 * Reads are incremental: everything a later read needs is in the JSON state returned with
 * each read (counters, model, pending records, tier, replay progress). A decision the
 * head of a child cannot make yet is made optimistically and corrected later, so any way of
 * splitting a file into reads stores exactly what one read of the whole file stores.
 */

/** `thread_settings_applied` spellings (ccusage's `codex_service_tier`): 1 fast, 0 standard. */
const TIERS: ReadonlyMap<string, number> = new Map([
  ["priority", 1],
  ["fast", 1],
  ["default", 0],
  ["standard", 0],
]);

/** cc-usage's `_ROLLOUT_UUID`: the session id at the end of a rollout's file name. */
const ROLLOUT_UUID =
  /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/**
 * cc-usage's `codex_session_id`: the UUID in the file name (lower case), else the stem.
 * Codex keeps the name when it archives a rollout, so the key survives the move.
 */
export function codexSessionId(path: string): string {
  let stem = basename(path);
  if (stem.endsWith(".jsonl")) stem = stem.slice(0, -".jsonl".length);
  const match = ROLLOUT_UUID.exec(stem);
  return match ? (match[1] as string).toLowerCase() : stem;
}

/** ccusage's `CODEX_REWRITTEN_BURST_PAUSE_MS`: the longest pause inside a replayed burst. */
const BURST_PAUSE_MS = 1000;

// ── rate-limit snapshots ─────────────────────────────────────────────────────────

export interface CodexLimitWindow {
  usedPercentage: number;
  /** Epoch seconds. */
  resetsAt: number;
  windowMinutes: number | null;
}

/** cc-usage's per-account `latest_rate_limits` capture, as numbers. */
export interface CodexLimitSnapshot {
  /** Epoch seconds of the token_count event; 0 when it had no usable timestamp. */
  capturedAt: number;
  primary: CodexLimitWindow | null;
  secondary: CodexLimitWindow | null;
}

/** cc-usage's newest-wins rule: a later capture replaces an equally new one. */
export function newerLimits(
  current: CodexLimitSnapshot | null | undefined,
  candidate: CodexLimitSnapshot,
): boolean {
  return current === null || current === undefined || candidate.capturedAt >= current.capturedAt;
}

// ── values ───────────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PyFloat) &&
    !(value instanceof PyBigInt)
  );
}

/** A counter: its value, and Python's `str()` of `_codex_int`'s result for the key. */
interface Counter {
  n: number;
  s: string;
}

const ZERO: Counter = { n: 0, s: "0" };

/** cc-usage's `_codex_int`: a non-negative int (a bool counts: True is 1) as itself, else 0. */
function codexInt(value: unknown): Counter {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? { n: value, s: String(value) } : ZERO;
  }
  if (value === true) return { n: 1, s: "True" };
  if (value === false) return { n: 0, s: "False" };
  if (value instanceof PyBigInt && value.value >= 0n) {
    return { n: Number(value.value), s: value.value.toString() };
  }
  return ZERO;
}

/** Python's `isinstance(v, (int, float))` as a float (bools included), else null. */
function pyNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof PyFloat) return value.value;
  if (value instanceof PyBigInt) return Number(value.value);
  return null;
}

/** (input, cached input, output) of a usage object. */
function triple(usage: Record<string, unknown>): [Counter, Counter, Counter] {
  return [
    codexInt(usage.input_tokens),
    codexInt(usage.cached_input_tokens),
    codexInt(usage.output_tokens),
  ];
}

const values = (t: readonly Counter[]) => t.map((c) => c.n);
const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => v === b[i]);

/**
 * A fork time from `session_meta.timestamp` (ccusage's `codex_value_timestamp`): an ISO
 * string, or a non-negative integer of seconds (milliseconds above 1e10).
 */
function forkTime(value: unknown): number | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" ? null : timestampMs(text);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  return null;
}

// ── state ────────────────────────────────────────────────────────────────────────

/** One counted event, as kept in the state (key as a decimal string). */
interface Rec {
  k: string;
  ts: number;
  m: string;
  i: number;
  o: number;
  c: number;
  t: number;
}

/** A usage event of a child's head: `s` task_started markers came before it; `own` is its current judgement. */
interface HeadEntry {
  r: Rec;
  s: number;
  own: boolean;
}

/** replay.rs's states: matching the parent's usage stream, skipping a burst, or past it. */
type Fork = { m: "match"; i: number } | { m: "burst"; p: number } | { m: "done" };

interface CodexState {
  v: 2;
  /** Scheme the state was built under; a read never mixes schemes. */
  scheme: 1 | 2;
  /** Whether the first line has been read (child detection happens there). */
  started: boolean;
  totals: number[] | null;
  model: string | null;
  /** Counted records still carrying codex-unattributed, re-sent once a model arrives. */
  pending: Rec[];
  tier: number;
  /** The parent's session id, the fork time, and whether this is a subagent (`thread_spawn`). */
  child: { parent: string; at: number | null; spawn: boolean } | null;
  phase: "own" | "head" | "provisional";
  /** task_started markers seen in the head. */
  s: number;
  fork: Fork;
  /** Timestamps of the first two token_count events with counters (replay.rs's burst probe). */
  t1: number | null;
  t2: number | null;
  head: HeadEntry[];
}

function newState(scheme: 1 | 2): CodexState {
  return {
    v: 2,
    scheme,
    started: false,
    totals: null,
    model: null,
    pending: [],
    tier: 0,
    child: null,
    phase: "own",
    s: 0,
    fork: { m: "match", i: 0 },
    t1: null,
    t2: null,
    head: [],
  };
}

function parseState(text: string | null, scheme: 1 | 2): CodexState | null {
  if (text === null) return null;
  try {
    const state = JSON.parse(text) as CodexState;
    return isObject(state) && state.v === 2 && state.scheme === scheme && state.started === true
      ? state
      : null;
  } catch {
    return null;
  }
}

// ── parent usage streams (replay.rs) ─────────────────────────────────────────────

/** One counted event of a parent: its timestamp and (input, cached, output). */
interface ParentEvent {
  ts: number;
  u: [number, number, number];
}

/** Finds a parent's rollout from its session id; the child's own path is never returned. */
export type ParentLookup = (sessionId: string, child: string) => string | null;

const TOKEN_COUNT = Buffer.from('"token_count"');
const NEWLINE = 0x0a;

/**
 * A parent's counted usage, read lazily from its start: the parent is never skipped
 * (ccusage matches against the parent's whole, immutable stream), and usually only its
 * first event is needed.
 */
class ParentStream {
  readonly events: ParentEvent[] = [];
  /** cc-usage's counter state, as `advance` keeps it. */
  totals: number[] | null = null;
  #offset = 0;
  #done = false;
  #chunk = 256 * 1024;

  constructor(readonly path: string) {}

  at(i: number): ParentEvent | undefined {
    while (this.events.length <= i && !this.#done) this.#more();
    return this.events[i];
  }

  #more(): void {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      this.#done = true;
      return;
    }
    try {
      let buf = Buffer.allocUnsafe(this.#chunk);
      let have = 0;
      for (;;) {
        if (have === buf.length) {
          const bigger = Buffer.allocUnsafe(buf.length * 2);
          buf.copy(bigger, 0, 0, have);
          buf = bigger;
        }
        const n = readSync(fd, buf, have, buf.length - have, this.#offset + have);
        if (n === 0) {
          this.#done = true;
          return;
        }
        have += n;
        const limit = buf.lastIndexOf(NEWLINE, have - 1) + 1;
        if (limit === 0) continue;
        const view = buf.subarray(0, limit);
        for (let pos = view.indexOf(TOKEN_COUNT); pos >= 0; ) {
          const start = view.lastIndexOf(NEWLINE, pos) + 1;
          const end = view.indexOf(NEWLINE, pos);
          this.#line(view.toString("utf8", start, end));
          pos = view.indexOf(TOKEN_COUNT, end + 1);
        }
        this.#offset += limit;
        this.#chunk = Math.min(this.#chunk * 2, 4 * 1024 * 1024);
        return;
      }
    } catch {
      this.#done = true;
    } finally {
      closeSync(fd);
    }
  }

  #line(text: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
      if (needsPyJson(text)) obj = parsePyJson(text);
    } catch {
      return;
    }
    if (!isObject(obj) || obj.type === "turn_context") return;
    const payload = obj.payload;
    if (!isObject(payload) || payload.type !== "token_count") return;
    const ts = timestampMs(obj.timestamp);
    const info = payload.info;
    if (ts === null || !isObject(info)) return;
    const counted = advance(this, info);
    if (counted !== null) this.events.push({ ts, u: counted.usage });
  }
}

/** A parse Worker's (or the ingest thread's) parent streams, kept for one pass. */
const parentStreams = new Map<string, ParentStream>();

/** Forgets cached parent streams; a pass starts with this so a changed parent is re-read. */
export function clearParentStreams(): void {
  parentStreams.clear();
}

function parentStream(path: string): ParentStream {
  let stream = parentStreams.get(path);
  if (stream === undefined) {
    stream = new ParentStream(path);
    parentStreams.set(path, stream);
  }
  return stream;
}

// ── counting (cc-usage's _extract_codex) ─────────────────────────────────────────

interface Counted {
  usage: [number, number, number];
  total: [Counter, Counter, Counter] | null;
  last: [Counter, Counter, Counter] | null;
}

/**
 * cc-usage's counter-advance rule for one token_count `info`, updating `holder.totals`.
 * Null when the event adds nothing.
 */
function advance(
  holder: { totals: number[] | null },
  info: Record<string, unknown>,
): Counted | null {
  const total = isObject(info.total_token_usage) ? triple(info.total_token_usage) : null;
  const last = isObject(info.last_token_usage) ? triple(info.last_token_usage) : null;
  let usage: number[];
  if (total !== null) {
    const current = values(total);
    const previous = holder.totals;
    holder.totals = current;
    if (previous === null) {
      if (last === null) return null;
      usage = values(last);
    } else if (same(current, previous)) {
      return null;
    } else if (current.every((v, i) => v >= (previous[i] as number))) {
      usage = current.map((v, i) => v - (previous[i] as number));
    } else if (
      (last !== null && same(current, values(last))) ||
      current.every((v, i) => v < (previous[i] as number))
    ) {
      usage = current;
    } else if (last !== null) {
      usage = values(last);
    } else {
      return null;
    }
  } else if (last !== null) {
    usage = values(last);
  } else {
    return null;
  }
  const [raw, , output] = usage as [number, number, number];
  if (raw === 0 && output === 0) return null;
  return { usage: usage as [number, number, number], total, last };
}

// ── one file ─────────────────────────────────────────────────────────────────────

export interface CodexRead {
  /** File offset after the last complete line. */
  offset: number;
  /** Records counted (scheme 2: the rollout's own usage), new or re-sent. */
  entries: FileEntry[];
  /** Keys of inherited usage: never stored under scheme 2 (removed if they are). */
  drop: bigint[];
  /** Keys this read counts that an earlier read reported in `drop` (a trigger turn gave them back). */
  restore: bigint[];
  /** State for the next read. */
  state: string;
  /** The newest rate-limit snapshot in the bytes read, if any. */
  limits: CodexLimitSnapshot | null;
  stats: ReadStats;
  /** True when the state could not be resumed and the file was read from the start. */
  restarted: boolean;
}

export interface CodexReadOptions {
  /** 2 (default): tokenhud's rule; 1: cc-usage's, for parity checks and migration. */
  scheme?: 1 | 2;
  /** Read buffer size; a longer line grows it. Tests shrink it to cross chunk edges. */
  chunkBytes?: number;
  parents?: ParentLookup;
}

const MARKS = [
  Buffer.from('"token_count"'),
  Buffer.from('"turn_context"'),
  Buffer.from("thread_settings_applied"),
  Buffer.from('"task_started"'),
  Buffer.from("inter_agent_communication"),
];
/** cc-usage looks at a line only if it holds one of the first two marks. */
const CC_USAGE_MARKS = 0b11;
const SESSION_META = Buffer.from("session_meta");
const CHUNK_BYTES = 4 * 1024 * 1024;

let spare: Buffer | null = null;

function takeBuffer(size: number): Buffer {
  if (size === CHUNK_BYTES && spare !== null) {
    const buf = spare;
    spare = null;
    return buf;
  }
  return Buffer.allocUnsafe(size);
}

function parseLine(text: string): unknown {
  const obj: unknown = JSON.parse(text);
  return needsPyJson(text) ? parsePyJson(text) : obj;
}

/** Folds one read of one rollout into records, drops and the next state. */
class CodexFold {
  readonly #path: string;
  readonly #sid: string;
  readonly #st: CodexState;
  readonly #parents: ParentLookup | undefined;
  readonly #own = new Map<string, Rec>();
  readonly #drop = new Set<string>();
  /** Keys judged inherited earlier and given back by a trigger turn. */
  readonly #restore = new Set<string>();
  readonly #pending: Set<string>;
  #parent: ParentStream | null | undefined;
  limits: CodexLimitSnapshot | null = null;
  readonly stats: ReadStats = emptyStats();

  constructor(path: string, state: CodexState, parents: ParentLookup | undefined) {
    this.#path = path;
    this.#sid = codexSessionId(path);
    this.#st = state;
    this.#parents = parents;
    this.#pending = new Set(state.pending.map((rec) => rec.k));
  }

  get state(): CodexState {
    return this.#st;
  }

  // ── lines ──────────────────────────────────────────────────────────────────────

  /** The first line of the file: a session_meta naming a parent makes this a child. */
  firstLine(text: string): void {
    const st = this.#st;
    st.started = true;
    if (st.scheme !== 2) return;
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(obj) || obj.type !== "session_meta" || !isObject(obj.payload)) return;
    const payload = obj.payload;
    const spawn = isObject(payload.source) ? payload.source.subagent : undefined;
    const thread = isObject(spawn) ? spawn.thread_spawn : undefined;
    // As ccusage: a forked_from_id string (even "") stands, else the thread_spawn parent.
    const parent =
      typeof payload.forked_from_id === "string"
        ? payload.forked_from_id
        : isObject(thread) && typeof thread.parent_thread_id === "string"
          ? thread.parent_thread_id
          : "";
    if (parent === "") return;
    st.child = {
      parent: parent.toLowerCase(),
      at: forkTime(obj.timestamp),
      spawn: isObject(thread),
    };
    st.phase = "head";
  }

  /** A complete line containing at least one of MARKS (`hits` has a bit per mark). */
  line(text: string, hits: number): void {
    this.stats.candidates++;
    let obj: unknown;
    try {
      obj = parseLine(text);
    } catch {
      if (hits & CC_USAGE_MARKS) this.stats.malformed++;
      return;
    }
    if (!isObject(obj)) return;
    const payload = isObject(obj.payload) ? obj.payload : null;
    if (hits & CC_USAGE_MARKS) {
      if (obj.type === "turn_context") {
        const model = payload?.model;
        if (typeof model === "string" && model !== "") this.#model(model);
        return;
      }
      if (payload?.type === "token_count") {
        this.#token(obj, payload);
        return;
      }
    }
    if (this.#st.scheme !== 2 || payload === null) return;
    if (obj.type === "event_msg") {
      if (payload.type === "thread_settings_applied") this.#settings(payload);
      else if (payload.type === "task_started") this.#taskStarted();
    } else if (
      (obj.type === "inter_agent_communication_metadata" ||
        obj.type === "inter_agent_communication") &&
      payload.trigger_turn === true
    ) {
      this.#triggerTurn();
    }
  }

  // ── cc-usage's rules ───────────────────────────────────────────────────────────

  /** `_reconcile_codex_model`: the model from now on; records made without one take it. */
  #model(model: string): void {
    const st = this.#st;
    st.model = model;
    for (const rec of st.pending) {
      rec.m = model;
      this.#emit(rec);
    }
    st.pending = [];
    this.#pending.clear();
    for (const entry of st.head) if (entry.r.m === UNATTRIBUTED) entry.r.m = model;
  }

  #token(obj: Record<string, unknown>, payload: Record<string, unknown>): void {
    const st = this.#st;
    const ts = timestampMs(obj.timestamp);
    // Limits are captured before the timestamp check: a token_count without a usable
    // timestamp or usage still carries a usable snapshot.
    this.#limits(payload, ts);
    if (ts === null) return;
    const info = payload.info;
    if (!isObject(info)) return;
    if (
      st.child !== null &&
      obj.type === "event_msg" &&
      (isObject(info.total_token_usage) || isObject(info.last_token_usage))
    ) {
      this.#burstProbe(ts);
    }
    const counted = advance(st, info);
    if (counted === null) return;
    const [raw, cached, output] = counted.usage;
    const cacheRead = Math.min(raw, cached);
    const key = ledgerKey(
      [
        "x",
        this.#sid,
        String(obj.timestamp),
        counted.total === null ? "" : counted.total.map((c) => c.s).join(","),
        counted.last === null ? "" : counted.last.map((c) => c.s).join(","),
      ].join(KEY_SEP),
    );
    this.stats.usageLines++;
    const k = String(key);
    const existing = this.#own.get(k);
    if (existing !== undefined) {
      // The same event read again (a rewritten file): fold it in, as cc-usage's `_merge`.
      existing.i = Math.max(existing.i, raw - cacheRead);
      existing.o = Math.max(existing.o, output);
      existing.c = Math.max(existing.c, cacheRead);
      return;
    }
    if (this.#drop.has(k)) return;
    const rec: Rec = {
      k,
      ts,
      m: st.model ?? UNATTRIBUTED,
      i: raw - cacheRead,
      o: output,
      c: cacheRead,
      t: st.scheme === 2 ? st.tier : 0,
    };
    if (st.phase === "own") this.#emit(rec);
    else this.#judge(rec, counted.usage);
  }

  /** `_capture_codex_limits`, keeping the newest snapshot of this read. */
  #limits(payload: Record<string, unknown>, ts: number | null): void {
    const limits = payload.rate_limits;
    if (!isObject(limits)) return;
    const window = (name: string): CodexLimitWindow | null => {
      const value = limits[name];
      if (!isObject(value)) return null;
      const used = pyNumber(value.used_percent);
      const resets = pyNumber(value.resets_at);
      if (used === null || resets === null) return null;
      return {
        usedPercentage: used,
        resetsAt: resets,
        windowMinutes: pyNumber(value.window_minutes),
      };
    };
    const primary = window("primary");
    const secondary = window("secondary");
    if (primary === null && secondary === null) return;
    const snapshot = { capturedAt: ts === null ? 0 : ts / 1000, primary, secondary };
    if (newerLimits(this.limits, snapshot)) this.limits = snapshot;
  }

  // ── scheme 2 ───────────────────────────────────────────────────────────────────

  #settings(payload: Record<string, unknown>): void {
    const settings = payload.thread_settings;
    if (!isObject(settings) || typeof settings.service_tier !== "string") return;
    this.#st.tier = TIERS.get(settings.service_tier) ?? 0;
  }

  #taskStarted(): void {
    const st = this.#st;
    if (st.phase === "own") return;
    st.s++;
    // Inherited usage before this marker stays inherited whatever comes next; only events
    // counted so far (which a trigger turn would make inherited) must be remembered.
    st.head = st.head.filter((entry) => entry.own);
  }

  /** A subagent's first trigger turn re-judges its whole head, whatever replay.rs said. */
  #triggerTurn(): void {
    const st = this.#st;
    if (st.phase === "own" || st.child?.spawn !== true) return;
    const markers = st.s;
    for (const entry of st.head) {
      const own = markers > 0 && entry.s === markers;
      if (own && !entry.own) {
        this.#emit(entry.r);
        this.#restore.add(entry.r.k);
      } else if (!own && entry.own) {
        this.#retract(entry.r);
      }
    }
    this.#endHead();
  }

  /** replay.rs's judgement of one usage event in a child's head. */
  #judge(rec: Rec, usage: [number, number, number]): void {
    const st = this.#st;
    if (st.phase === "provisional") {
      // Only a token_count outside an event_msg gets here before the burst probe settles;
      // ccusage would already be past the head.
      this.#emitHead(rec);
      return;
    }
    for (;;) {
      const fork = st.fork;
      if (fork.m === "match") {
        const parent = this.#parentAt(fork.i);
        if (parent !== undefined && same(parent.u, usage)) {
          fork.i++;
          this.#skip(rec);
          return;
        }
        if (fork.i === 0) {
          if (st.t2 === null) {
            // The burst probe needs the next token_count. Count this event for now; the
            // probe or a trigger turn may still make it inherited.
            st.phase = "provisional";
            this.#emitHead(rec);
            return;
          }
          const burst = this.#burstStart();
          if (burst !== null) {
            st.fork = { m: "burst", p: burst };
            continue;
          }
        }
        st.fork = { m: "done" };
        continue;
      }
      if (fork.m === "burst") {
        const pause = rec.ts - fork.p;
        if (pause >= 0 && pause <= BURST_PAUSE_MS) {
          fork.p = rec.ts;
          this.#skip(rec);
          return;
        }
        st.fork = { m: "done" };
        continue;
      }
      // replay.rs counts it. A subagent's head stays open: its trigger turn may yet say
      // otherwise. A fork's head ends here.
      if (st.child?.spawn === true) {
        this.#emitHead(rec);
        return;
      }
      this.#endHead();
      this.#emit(rec);
      return;
    }
  }

  /** Records the first two token_count timestamps; the second may settle a provisional event. */
  #burstProbe(ts: number): void {
    const st = this.#st;
    if (st.t1 === null) {
      st.t1 = ts;
      return;
    }
    if (st.t2 !== null) return;
    st.t2 = ts;
    if (st.phase !== "provisional") return;
    const burst = this.#burstStart();
    const pending = st.head.find((entry) => entry.own);
    const pause = burst === null || pending === undefined ? -1 : pending.r.ts - burst;
    if (pending !== undefined && pause >= 0 && pause <= BURST_PAUSE_MS) {
      st.fork = { m: "burst", p: pending.r.ts };
      pending.own = false;
      this.#retract(pending.r);
      st.phase = "head";
    } else if (st.child?.spawn === true) {
      st.fork = { m: "done" };
      st.phase = "head";
    } else {
      this.#endHead();
    }
  }

  /** ccusage's `detect_rewritten_burst`: the head burst's start, if the file opens with one. */
  #burstStart(): number | null {
    const { t1, t2 } = this.#st;
    if (t1 === null || t2 === null) return null;
    const pause = t2 - t1;
    return pause >= 0 && pause <= BURST_PAUSE_MS ? t1 : null;
  }

  #parentAt(i: number): ParentEvent | undefined {
    const child = this.#st.child;
    if (child === null) return undefined;
    if (this.#parent === undefined) {
      // A rollout naming itself has no parent to match (ccusage never picks the child).
      const path =
        child.parent === this.#sid ? null : (this.#parents?.(child.parent, this.#path) ?? null);
      this.#parent = path === null ? null : parentStream(path);
    }
    const event = this.#parent?.at(i);
    // Usage the parent recorded after the fork was never replayed.
    if (event === undefined || (child.at !== null && event.ts > child.at)) return undefined;
    return event;
  }

  #endHead(): void {
    const st = this.#st;
    st.phase = "own";
    st.head = [];
    st.fork = { m: "done" };
  }

  // ── output ─────────────────────────────────────────────────────────────────────

  /** An event counted for now, which the head may still judge inherited. */
  #emitHead(rec: Rec): void {
    this.#emit(rec);
    this.#st.head.push({ r: rec, s: this.#st.s, own: true });
  }

  #emit(rec: Rec): void {
    const st = this.#st;
    this.#drop.delete(rec.k);
    const seen = this.#own.get(rec.k);
    if (seen === undefined) this.#own.set(rec.k, { ...rec });
    else seen.m = rec.m === UNATTRIBUTED ? seen.m : rec.m;
    if (rec.m === UNATTRIBUTED && !this.#pending.has(rec.k)) {
      this.#pending.add(rec.k);
      st.pending.push({ ...rec });
    }
  }

  /** An event the head judges inherited. */
  #skip(rec: Rec): void {
    this.#drop.add(rec.k);
    this.#st.head.push({ r: rec, s: this.#st.s, own: false });
  }

  /** An event counted earlier that turned out to be inherited. */
  #retract(rec: Rec): void {
    const st = this.#st;
    this.#own.delete(rec.k);
    this.#drop.add(rec.k);
    if (this.#pending.delete(rec.k)) st.pending = st.pending.filter((p) => p.k !== rec.k);
  }

  entries(): FileEntry[] {
    return [...this.#own.values()].map((r) => ({
      key: BigInt(r.k),
      pre: null,
      ts: r.ts,
      model: r.m,
      post: { inp: r.i, outp: r.o, cr: r.c, cc: 0, e5: 0, e1: 0, tier: r.t },
    }));
  }

  drops(): bigint[] {
    return [...this.#drop].map((k) => BigInt(k));
  }

  restores(): bigint[] {
    return [...this.#restore].map((k) => BigInt(k));
  }
}

/**
 * Reads the complete lines of the rollout at `path` from byte `start`, resuming `state`
 * (the previous read's), in large chunks: native searches for the marks jump straight to
 * candidate lines, and only those are decoded and parsed. A state that cannot be resumed
 * (missing, damaged or of another scheme) restarts the read at 0. Throws on I/O errors.
 */
export function readCodexFile(
  path: string,
  start: number,
  state: string | null,
  options: CodexReadOptions = {},
): CodexRead {
  const scheme = options.scheme ?? 2;
  let st = start > 0 ? parseState(state, scheme) : null;
  const restarted = start > 0 && st === null;
  if (st === null) {
    st = newState(scheme);
    start = 0;
  }
  const fold = new CodexFold(path, st, options.parents);
  const chunk = options.chunkBytes ?? CHUNK_BYTES;
  let buf = takeBuffer(chunk);
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
        fold.stats.lines++;
      if (!fold.state.started) {
        const end = view.indexOf(NEWLINE);
        if (view.subarray(0, end).includes(SESSION_META))
          fold.firstLine(view.toString("utf8", 0, end));
        else fold.state.started = true;
      }
      scanMarks(view, (lineStart, lineEnd, hits) =>
        fold.line(view.toString("utf8", lineStart, lineEnd), hits),
      );
      buf.copy(buf, 0, limit, have);
      base += limit;
      have -= limit;
    }
  } finally {
    closeSync(fd);
    if (buf.length === CHUNK_BYTES) spare = buf;
  }
  fold.stats.bytes = base - start;
  return {
    offset: base,
    entries: fold.entries(),
    drop: fold.drops(),
    restore: fold.restores(),
    state: JSON.stringify(fold.state),
    limits: fold.limits,
    stats: fold.stats,
    restarted,
  };
}

/**
 * Calls `visit` for every line of `view` (complete lines only) that contains one of MARKS,
 * once per line, with a bit set in `hits` for each mark it contains. Each mark's next
 * occurrence is searched for once and reused until the scan passes it, so the cost is one
 * native search pass per mark.
 */
function scanMarks(
  view: Buffer,
  visit: (lineStart: number, lineEnd: number, hits: number) => void,
): void {
  const next = MARKS.map((mark) => view.indexOf(mark));
  for (;;) {
    let hit = -1;
    for (const at of next) if (at >= 0 && (hit < 0 || at < hit)) hit = at;
    if (hit < 0) return;
    const lineStart = view.lastIndexOf(NEWLINE, hit) + 1;
    const lineEnd = view.indexOf(NEWLINE, hit);
    let hits = 0;
    next.forEach((at, i) => {
      if (at >= 0 && at < lineEnd) hits |= 1 << i;
    });
    visit(lineStart, lineEnd, hits);
    next.forEach((at, i) => {
      if (at >= 0 && at <= lineEnd) next[i] = view.indexOf(MARKS[i] as Buffer, lineEnd + 1);
    });
  }
}

/**
 * Every record cc-usage's parser makes of the rollout at `path` read from the start
 * (scheme 1): the parity and migration reference.
 */
export function extractCodexV1(path: string): FileEntry[] {
  return readCodexFile(path, 0, null, { scheme: 1 }).entries;
}
