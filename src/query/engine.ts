// The query layer: every question the TUI, `tokenhud json` and the MCP server ask about
// usage, answered from the store to the cent.
//
// A query is a list of time slots (one for totals; days, weeks, months or activity buckets
// otherwise) split by account, model and tier as needed. Each slot is cut into:
// - whole UTC hours, summed from `roll_hour` buckets. A bucket holds one account, model
//   and tier in one hour, so one rate card prices it, as sums (see price.ts), with its
//   long-context rows priced one by one;
// - "raw" pieces: the rest (the edges of a range that isn't hour-aligned, sub-hour
//   buckets, local days in a +05:30 zone, an hour in which a price changes), from `usage`
//   rows over the `usage_ts` index, each row priced on its own.
// So a query's cost equals the sum of every row's computeCost, up to floating-point
// rounding.
//
// Both are cached in memory once priced: buckets a UTC day at a time, rows an hour at a
// time. A view's queries then cost a few loops over typed arrays instead of scans of the
// store. The caches are dropped when another connection commits (PRAGMA data_version), or,
// with `autoInvalidate: false`, only for the ranges passed to `invalidate()`.
//
// The first use of a range reads and prices it (about 20-80 ms for a year of 1M rows);
// later queries over it take well under a millisecond. A long-lived caller (the TUI) warms
// the engine at startup with `warm()` and, on each ingest, calls `invalidate(range)` and
// recomputes its view models off the input path.

import type { Database } from "bun:sqlite";
import { cacheReadRate, computeCost, EPHEMERAL_5M_MULT, type Rates } from "../pricing/cost.ts";
import { normalizeModel } from "../pricing/normalize.ts";
import type { Tier } from "../pricing/schema.ts";
import type { PriceTable } from "../pricing/table.ts";
import { guard } from "../store/errors.ts";
import { LONG_CONTEXT_INDEX_MIN, LONG_CONTEXT_PREDICATE } from "../store/schema.ts";
import {
  type Calendar,
  calendarSlices,
  type Extent,
  equalBuckets,
  type Period,
  resolvePeriod,
} from "./periods.ts";
import { type CandidateRow, type Priced, priceGroup, type Sums } from "./price.ts";
import type {
  AccountPace,
  AccountRef,
  AccountSummary,
  AccountUsage,
  Activity,
  CalendarUsage,
  DisplayRates,
  ModelUsage,
  Pace,
  PriceStatus,
  Range,
  Totals,
  UnpricedModel,
  Usage,
} from "./types.ts";
import { Zone } from "./tz.ts";

const HOUR = 3_600_000;
const DAY_HOURS = 24;
// Between queries the row cache keeps at most this many rows (an empty hour counts as
// one), dropping the least recently used hours first. A single query may hold more while
// it runs.
const DEFAULT_MAX_CACHED_ROWS = 200_000;

export interface QueryArgs {
  /** Default "all". Ignored when `range` is given. */
  readonly period?: Period;
  readonly range?: Range;
  /** Account ids; default every account. */
  readonly accounts?: readonly number[];
  /** Providers ("claude", "codex"); default every provider. */
  readonly providers?: readonly string[];
  /** IANA zone for calendar periods and groups; default the engine's. */
  readonly tz?: string;
}

export interface QueryOptions {
  /** Default zone; the system's when absent. */
  readonly tz?: string;
  readonly now?: () => number;
  /**
   * Drop every cached hour when another connection has committed. On by default. The TUI
   * turns it off and calls `invalidate(range)` for what its ingest worker reports.
   */
  readonly autoInvalidate?: boolean;
  /** The row cache's bound between queries; default 200,000 rows (about 20 MB). */
  readonly maxCachedRows?: number;
}

// ── measures ─────────────────────────────────────────────────────────────────────
// Per bucket and per result cell, in this order.
const INP = 0;
const OUTP = 1;
const CR = 2;
const CC = 3;
const RECORDS = 4;
const COST = 5;
const UNPRICED = 6;
const UNPRICED_TIER = 7;
const MEASURES = 8;

/** One UTC day of priced roll_hour buckets, in (hour, acct, model, tier) order. */
interface Chunk {
  readonly length: number;
  readonly hour: Int32Array;
  readonly acct: Int32Array;
  readonly model: Int32Array;
  readonly tier: Uint8Array;
  readonly values: Float64Array;
}

/** One UTC hour of usage rows, in time order, each priced on its own. */
interface RowHour {
  readonly length: number;
  readonly ts: Float64Array;
  readonly acct: Int32Array;
  readonly model: Int32Array;
  readonly tier: Uint8Array;
  readonly values: Float64Array;
}

const EMPTY_CHUNK: Chunk = {
  length: 0,
  hour: new Int32Array(0),
  acct: new Int32Array(0),
  model: new Int32Array(0),
  tier: new Uint8Array(0),
  values: new Float64Array(0),
};

/** How results are split: cell = ((slot * accounts + a) * models + m) * tiers + t. */
interface Layout {
  readonly slots: number;
  readonly byAccount: boolean;
  readonly byModel: boolean;
  readonly byTier: boolean;
}

interface Cells {
  readonly accounts: number;
  readonly models: number;
  readonly tiers: number;
  readonly values: Float64Array;
}

/** A piece of a slot read from raw rows (within one or two UTC hours). */
interface RawPiece {
  readonly slot: number;
  readonly lo: number;
  readonly hi: number;
}

interface HourSpan {
  readonly slot: number;
  readonly lo: number;
  readonly hi: number;
}

interface Resolved {
  readonly range: Range;
  readonly zone: Zone;
  /** acct id -> 1 when selected; null selects every account. */
  readonly allowed: Uint8Array | null;
  /** The selected accounts, by id. */
  readonly accounts: readonly AccountRef[];
}

const tierName = (tier: number): Tier => (tier === 0 ? "standard" : "fast");

type Row = Array<bigint | null>;

const num = (v: bigint | number | null | undefined): number => Number(v ?? 0);

export class UsageQueries {
  readonly #db: Database;
  readonly #prices: PriceTable;
  readonly #zone: Zone;
  readonly #now: () => number;
  readonly #autoInvalidate: boolean;
  /** Hours in which some card changes: always read raw, so a bucket has one card. */
  readonly #splitHours: readonly number[];
  readonly #splitHourSet: ReadonlySet<number>;
  readonly #longThreshold: number | undefined;

  #dataVersion: bigint | undefined;
  readonly #chunks = new Map<number, Chunk>();
  /** Hour -> rows, least recently used first (a use moves an hour to the end). */
  readonly #rowHours = new Map<number, RowHour>();
  #cachedRows = 0;
  readonly #maxCachedRows: number;

  // Store ids -> names and dense indexes; refreshed with the cache.
  #accounts: AccountRef[] = [];
  #accountIndex = new Int32Array(0);
  #modelNames: string[] = [];
  #modelKeyOfId = new Int32Array(0);
  readonly #modelKeys = new Map<string, number>();
  readonly #modelKeyNames: string[] = [];
  #mapsLoaded = false;

  constructor(db: Database, prices: PriceTable, options: QueryOptions = {}) {
    this.#db = db;
    this.#prices = prices;
    this.#zone = options.tz === undefined ? Zone.system() : Zone.of(options.tz);
    this.#now = options.now ?? Date.now;
    this.#autoInvalidate = options.autoInvalidate ?? true;
    this.#maxCachedRows = options.maxCachedRows ?? DEFAULT_MAX_CACHED_ROWS;
    // Several boundaries can fall in one hour; it is still one hour, read once.
    this.#splitHourSet = new Set(
      prices
        .boundaries()
        .filter((t) => t % HOUR !== 0)
        .map((t) => Math.floor(t / HOUR)),
    );
    this.#splitHours = [...this.#splitHourSet].sort((a, b) => a - b);
    this.#longThreshold = prices.minLongContextThreshold();
  }

  /** The default zone's IANA name. */
  get timeZone(): string {
    return this.#zone.name;
  }

  /**
   * Forgets cached hours overlapping `range` (all of them without one), and re-reads the
   * account and model names. Call it after a write that the engine can't see coming.
   */
  invalidate(range?: Range): void {
    if (range === undefined) {
      this.#chunks.clear();
      this.#rowHours.clear();
      this.#cachedRows = 0;
    } else if (range.to > range.from) {
      const firstHour = Math.floor(range.from / HOUR);
      const lastHour = Math.floor((range.to - 1) / HOUR);
      for (const hour of [...this.#rowHours.keys()]) {
        if (hour >= firstHour && hour <= lastHour) this.#dropRowHour(hour);
      }
      const firstDay = Math.floor(firstHour / DAY_HOURS);
      const lastDay = Math.floor(lastHour / DAY_HOURS);
      for (const day of [...this.#chunks.keys()]) {
        if (day >= firstDay && day <= lastDay) this.#chunks.delete(day);
      }
    }
    this.#mapsLoaded = false;
  }

  /**
   * Reads and prices everything a query over the range would (default: all of the store),
   * so the next queries over it are cached. The TUI calls it at startup, within its
   * first-frame budget.
   */
  warm(args: QueryArgs = {}): void {
    this.#read(() => {
      const r = this.#resolve(args);
      this.#collect([r.range.from, r.range.to], null, {
        slots: 1,
        byAccount: false,
        byModel: false,
        byTier: false,
      });
    });
  }

  // ── queries ────────────────────────────────────────────────────────────────────

  /** The resolved range of a period (for "all", the store's extent). */
  range(args: QueryArgs = {}): Range {
    return this.#read(() => this.#resolve(args).range);
  }

  totals(args: QueryArgs = {}): Totals {
    return this.#read(() => {
      const r = this.#resolve(args);
      const cells = this.#collect([r.range.from, r.range.to], r.allowed, {
        slots: 1,
        byAccount: false,
        byModel: true,
        byTier: true,
      });
      return { range: r.range, usage: this.#sum(cells, 0), unpriced: this.#unpriced(cells) };
    });
  }

  /** Per model and tier, most cost first, then most tokens. */
  byModel(args: QueryArgs = {}): ModelUsage[] {
    return this.#read(() => {
      const r = this.#resolve(args);
      const cells = this.#collect([r.range.from, r.range.to], r.allowed, {
        slots: 1,
        byAccount: false,
        byModel: true,
        byTier: true,
      });
      const total = this.#sum(cells, 0).cost;
      const now = this.#now();
      const out: ModelUsage[] = [];
      for (let m = 0; m < cells.models; m++) {
        for (let t = 0; t < 2; t++) {
          const at = (m * 2 + t) * MEASURES;
          if (cells.values[at + RECORDS] === 0) continue;
          const model = this.#modelKeyNames[m] ?? "";
          const tier = tierName(t);
          const usage = usageOf(cells.values, at);
          out.push({
            model,
            tier,
            usage,
            share: total > 0 ? usage.cost / total : 0,
            status: statusOf(cells.values, at),
            rates: displayRates(this.#prices.rates(model, tier, now)),
          });
        }
      }
      return out.sort(
        byCostThenTokens(
          (m) => m.usage,
          (m) => `${m.model}\0${m.tier}`,
        ),
      );
    });
  }

  /** Every selected account, most cost first, then most tokens. */
  byAccount(args: QueryArgs = {}): AccountUsage[] {
    return this.#read(() => {
      const r = this.#resolve(args);
      const cells = this.#collect([r.range.from, r.range.to], r.allowed, {
        slots: 1,
        byAccount: true,
        byModel: false,
        byTier: false,
      });
      const usages = r.accounts.map((account) => ({
        account,
        usage: usageOf(cells.values, this.#accountIndexOf(account.id) * MEASURES),
      }));
      const total = usages.reduce((sum, a) => sum + a.usage.cost, 0);
      return usages
        .map((a) => ({ ...a, share: total > 0 ? a.usage.cost / total : 0 }))
        .sort(
          byCostThenTokens(
            (a) => a.usage,
            (a) => a.account.label,
          ),
        );
    });
  }

  /** Local calendar days in the range, in order, empty ones included. */
  byDay(args: QueryArgs = {}): CalendarUsage[] {
    return this.#calendar(args, "day");
  }

  /** Monday-start weeks in the range, in order. */
  byWeek(args: QueryArgs = {}): CalendarUsage[] {
    return this.#calendar(args, "week");
  }

  /** Calendar months in the range, in order. */
  byMonth(args: QueryArgs = {}): CalendarUsage[] {
    return this.#calendar(args, "month");
  }

  /** `buckets` equal slices of the range (e.g. 72 × 20 min over 24 h): cost and tokens. */
  activity(args: QueryArgs & { readonly buckets: number }): Activity {
    if (!Number.isInteger(args.buckets) || args.buckets < 1) {
      throw new RangeError("buckets must be a positive integer");
    }
    return this.#read(() => {
      const r = this.#resolve(args);
      if (r.range.to <= r.range.from) return { range: r.range, buckets: [] };
      const bounds = equalBuckets(r.range, args.buckets);
      const cells = this.#collect(bounds, r.allowed, {
        slots: args.buckets,
        byAccount: false,
        byModel: false,
        byTier: false,
      });
      const buckets = [];
      for (let slot = 0; slot < args.buckets; slot++) {
        const at = slot * MEASURES;
        buckets.push({
          range: { from: bounds[slot] as number, to: bounds[slot + 1] as number },
          cost: cells.values[at + COST] as number,
          tokens: tokensAt(cells.values, at),
        });
      }
      return { range: r.range, buckets };
    });
  }

  /** Cost and tokens per hour over the last `minutes` (default 30), per selected account. */
  pace(args: Omit<QueryArgs, "period" | "range"> & { readonly minutes?: number } = {}): Pace {
    const minutes = args.minutes ?? 30;
    if (!(minutes > 0)) throw new RangeError("minutes must be positive");
    const now = this.#now();
    const range = { from: now - minutes * 60_000, to: now + 1 };
    return this.#read(() => {
      const r = this.#resolve({ ...args, range });
      const cells = this.#collect([range.from, range.to], r.allowed, {
        slots: 1,
        byAccount: true,
        byModel: false,
        byTier: false,
      });
      const perHour = 60 / minutes;
      const accounts: AccountPace[] = r.accounts.map((account) => {
        const at = this.#accountIndexOf(account.id) * MEASURES;
        const cost = cells.values[at + COST] as number;
        const tokens = tokensAt(cells.values, at);
        return {
          account,
          cost,
          tokens,
          costPerHour: cost * perHour,
          tokensPerHour: tokens * perHour,
        };
      });
      return { range, minutes, accounts };
    });
  }

  /**
   * Runs `fn` against one snapshot of the store, so the queries it makes agree with each
   * other even while another process writes.
   */
  snapshot<T>(fn: () => T): T {
    return this.#read(fn);
  }

  /** Every account (id, label, provider), by id. */
  accountList(): AccountRef[] {
    return this.#read(() => {
      this.#ensureMaps();
      return [...this.#accounts];
    });
  }

  /** Every account with its first and last usage time, by id. */
  accounts(): AccountSummary[] {
    return this.#read(() => {
      this.#ensureMaps();
      const hourOf = (acct: number, order: "ASC" | "DESC") =>
        this.#db
          .query<{ hour: bigint }, [number]>(
            `SELECT hour FROM roll_hour WHERE acct = ?1 ORDER BY hour ${order} LIMIT 1`,
          )
          .get(acct)?.hour;
      const edge = (acct: number, hour: bigint | undefined, fn: "min" | "max") => {
        if (hour === undefined) return null;
        const h = Number(hour) * HOUR;
        const row = this.#db
          .query<{ ts: bigint | null }, [number, number, number]>(
            `SELECT ${fn}(ts) AS ts FROM usage WHERE acct = ?1 AND ts >= ?2 AND ts < ?3`,
          )
          .get(acct, h, h + HOUR);
        return row?.ts === null || row?.ts === undefined ? null : Number(row.ts);
      };
      return this.#accounts.map((account) => ({
        ...account,
        firstSeen: edge(account.id, hourOf(account.id, "ASC"), "min"),
        lastSeen: edge(account.id, hourOf(account.id, "DESC"), "max"),
      }));
    });
  }

  // ── plumbing ───────────────────────────────────────────────────────────────────

  /** Runs `fn` in one read transaction, so every statement sees the same snapshot. */
  #read<T>(fn: () => T): T {
    const db = this.#db;
    return guard(() => {
      const own = !db.inTransaction;
      if (own) db.exec("BEGIN");
      try {
        if (this.#autoInvalidate) {
          const version = db
            .query<{ data_version: bigint }, []>("PRAGMA data_version")
            .get()?.data_version;
          if (version !== this.#dataVersion) {
            this.#dataVersion = version;
            this.invalidate();
          }
        }
        const out = fn();
        if (own) db.exec("COMMIT");
        return out;
      } catch (error) {
        if (own && db.inTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  #resolve(args: QueryArgs): Resolved {
    this.#ensureMaps();
    const zone = args.tz === undefined ? this.#zone : Zone.of(args.tz);
    let range: Range;
    if (args.range !== undefined) {
      range = args.range;
    } else {
      const period = args.period ?? "all";
      range = resolvePeriod(period, this.#now(), zone, period === "all" ? this.#extent() : null);
    }
    const ids = args.accounts === undefined ? null : new Set(args.accounts);
    const providers = args.providers === undefined ? null : new Set(args.providers);
    const accounts = this.#accounts.filter(
      (a) => (ids === null || ids.has(a.id)) && (providers === null || providers.has(a.provider)),
    );
    let allowed: Uint8Array | null = null;
    if (ids !== null || providers !== null) {
      allowed = new Uint8Array(this.#accountIndex.length);
      for (const a of accounts) allowed[a.id] = 1;
    }
    return { range, zone, allowed, accounts };
  }

  #extent(): Extent {
    const row = this.#db
      .query<{ first: bigint | null; last: bigint | null }, []>(
        "SELECT (SELECT min(ts) FROM usage) AS first, (SELECT max(ts) FROM usage) AS last",
      )
      .get();
    if (row?.first === null || row?.first === undefined || row.last === null) return null;
    return { first: Number(row.first), last: Number(row.last) };
  }

  #ensureMaps(): void {
    if (this.#mapsLoaded) return;
    const accounts = this.#db
      .query<{ id: bigint; label: string; provider: string }, []>(
        "SELECT id, label, provider FROM accounts ORDER BY id",
      )
      .all()
      .map((a) => ({ id: Number(a.id), label: a.label, provider: a.provider }));
    const models = this.#db
      .query<{ id: bigint; name: string }, []>("SELECT id, name FROM models")
      .all();
    this.#accounts = accounts;
    this.#accountIndex = new Int32Array(Math.max(0, ...accounts.map((a) => a.id)) + 1).fill(-1);
    accounts.forEach((a, i) => {
      this.#accountIndex[a.id] = i;
    });
    const maxModel = Math.max(0, ...models.map((m) => Number(m.id)));
    this.#modelNames = new Array<string>(maxModel + 1).fill("");
    this.#modelKeyOfId = new Int32Array(maxModel + 1);
    this.#modelKeyOfId.fill(this.#modelKey(""));
    for (const { id, name } of models) {
      const i = Number(id);
      this.#modelNames[i] = name;
      this.#modelKeyOfId[i] = this.#modelKey(normalizeModel(name));
    }
    this.#mapsLoaded = true;
  }

  #modelKey(name: string): number {
    let key = this.#modelKeys.get(name);
    if (key === undefined) {
      key = this.#modelKeyNames.length;
      this.#modelKeys.set(name, key);
      this.#modelKeyNames.push(name);
    }
    return key;
  }

  /** An account id's dense index, or the index of an account the maps don't know yet. */
  #accountIndexOf(id: number): number {
    return this.#accountIndex[id] ?? -1;
  }

  #modelNameOf(id: number): string {
    return this.#modelNames[id] ?? "";
  }

  #modelKeyOfStoreId(id: number): number {
    return this.#modelKeyOfId[id] ?? this.#modelKey("");
  }

  // ── collecting ─────────────────────────────────────────────────────────────────

  /** Sums and prices every slot [bounds[i], bounds[i + 1]) of the selected accounts. */
  #collect(bounds: readonly number[], allowed: Uint8Array | null, layout: Layout): Cells {
    // Loading can meet an account or model written since the names were read, which adds
    // to them, so the layout is fixed only after every bucket and row is read.
    const { hours, raw } = this.#plan(bounds);
    if (hours.length > 0) this.#ensureDays(hours);
    if (raw.length > 0) this.#ensureRowHours(raw);
    const accounts = layout.byAccount ? this.#accounts.length : 1;
    const models = layout.byModel ? this.#modelKeyNames.length : 1;
    const tiers = layout.byTier ? 2 : 1;
    const values = new Float64Array(layout.slots * accounts * models * tiers * MEASURES);
    // The cell's offset, or -1 for an account the accounts table doesn't name.
    const cellOf = (slot: number, acct: number, model: number, tier: number): number => {
      let cell = slot;
      if (layout.byAccount) {
        const a = this.#accountIndex[acct] ?? -1;
        if (a < 0) return -1;
        cell = cell * accounts + a;
      }
      cell = cell * models + (layout.byModel ? model : 0);
      cell = cell * tiers + (layout.byTier ? Math.min(tier, 1) : 0);
      return cell * MEASURES;
    };

    for (const span of hours) {
      const firstDay = Math.floor(span.lo / DAY_HOURS);
      const lastDay = Math.floor((span.hi - 1) / DAY_HOURS);
      for (let day = firstDay; day <= lastDay; day++) {
        const chunk = this.#chunks.get(day);
        if (chunk === undefined) throw new Error(`internal: UTC day ${day} was not loaded`);
        const { hour, acct, model, tier, values: v } = chunk;
        for (let i = 0; i < chunk.length; i++) {
          const h = hour[i] as number;
          if (h < span.lo) continue;
          if (h >= span.hi) break;
          const a = acct[i] as number;
          if (allowed !== null && allowed[a] !== 1) continue;
          const at = cellOf(span.slot, a, model[i] as number, tier[i] as number);
          if (at >= 0) addInto(values, at, v, i * MEASURES);
        }
      }
    }
    for (const piece of raw) {
      const firstHour = Math.floor(piece.lo / HOUR);
      const lastHour = Math.floor((piece.hi - 1) / HOUR);
      for (let h = firstHour; h <= lastHour; h++) {
        const rows = this.#rowHours.get(h);
        if (rows === undefined) throw new Error(`internal: UTC hour ${h} was not loaded`);
        const { ts, acct, model, tier, values: v } = rows;
        for (let i = 0; i < rows.length; i++) {
          const t = ts[i] as number;
          if (t < piece.lo) continue;
          if (t >= piece.hi) break;
          const a = acct[i] as number;
          if (allowed !== null && allowed[a] !== 1) continue;
          const at = cellOf(piece.slot, a, model[i] as number, tier[i] as number);
          if (at >= 0) addInto(values, at, v, i * MEASURES);
        }
      }
    }
    // Only now, with every row summed, may the row cache shrink.
    this.#trimRowCache();
    return { accounts, models, tiers, values };
  }

  /**
   * Cuts every slot into whole UTC hours, served from roll_hour, and raw pieces. An hour in
   * which a card changes is always raw, so a bucket never straddles two cards.
   */
  #plan(bounds: readonly number[]): { hours: HourSpan[]; raw: RawPiece[] } {
    const hours: HourSpan[] = [];
    const raw: RawPiece[] = [];
    for (let slot = 0; slot + 1 < bounds.length; slot++) {
      const lo = bounds[slot] as number;
      const hi = bounds[slot + 1] as number;
      if (hi <= lo) continue;
      const first = Math.ceil(lo / HOUR);
      const end = Math.floor(hi / HOUR);
      if (first >= end) {
        raw.push({ slot, lo, hi });
        continue;
      }
      if (lo < first * HOUR) raw.push({ slot, lo, hi: first * HOUR });
      let h = first;
      for (const split of this.#splitHours) {
        if (split < first || split >= end) continue;
        if (h < split) hours.push({ slot, lo: h, hi: split });
        raw.push({ slot, lo: split * HOUR, hi: (split + 1) * HOUR });
        h = split + 1;
      }
      if (h < end) hours.push({ slot, lo: h, hi: end });
      if (end * HOUR < hi) raw.push({ slot, lo: end * HOUR, hi });
    }
    return { hours, raw };
  }

  /**
   * Rows that may be above a long-context threshold, in [from, to), through the partial
   * index. Only models with a long-context tier are read, and which those are is read from
   * this snapshot's models table, so a model written after the names were cached still
   * counts. If some card's threshold is below the index's, the range is scanned instead.
   */
  #candidates(
    from: number,
    to: number,
  ): Array<CandidateRow & { acct: number; model: number; tier: number }> {
    const threshold = this.#longThreshold;
    if (threshold === undefined) return [];
    const longModels = this.#db
      .query<{ id: bigint; name: string }, []>("SELECT id, name FROM models")
      .all()
      .filter((m) => this.#prices.hasLongContext(m.name))
      .map((m) => m.id);
    if (longModels.length === 0) return [];
    const predicate =
      threshold >= LONG_CONTEXT_INDEX_MIN ? LONG_CONTEXT_PREDICATE : `inp + cr > ${threshold}`;
    const stmt = this.#db.prepare<Row, [number, number]>(
      `SELECT ts, acct, model, tier, inp, outp, cr, cc, e5, e1 FROM usage
       WHERE ${predicate} AND model IN (${longModels.join(", ")}) AND ts >= ?1 AND ts < ?2`,
    );
    try {
      return (stmt.values(from, to) as Row[]).map((r) => ({
        ts: num(r[0]),
        acct: num(r[1]),
        model: num(r[2]),
        tier: num(r[3]),
        inp: num(r[4]),
        outp: num(r[5]),
        cr: num(r[6]),
        cc: num(r[7]),
        e5: r[8] === null ? null : num(r[8]),
        e1: r[9] === null ? null : num(r[9]),
      }));
    } finally {
      stmt.finalize();
    }
  }

  #price(
    sums: Sums,
    candidates: readonly CandidateRow[] | undefined,
    model: number,
    tier: number,
    at: number,
  ): Priced {
    return priceGroup(
      sums,
      candidates,
      this.#prices.rates(this.#modelNameOf(model), tierName(tier), at),
    );
  }

  // ── the hour cache ─────────────────────────────────────────────────────────────

  /** Loads and prices every UTC day the spans touch that isn't cached yet. */
  #ensureDays(spans: readonly HourSpan[]): void {
    let firstDay = Number.POSITIVE_INFINITY;
    let lastDay = Number.NEGATIVE_INFINITY;
    for (const span of spans) {
      firstDay = Math.min(firstDay, Math.floor(span.lo / DAY_HOURS));
      lastDay = Math.max(lastDay, Math.floor((span.hi - 1) / DAY_HOURS));
    }
    let runStart: number | null = null;
    for (let day = firstDay; day <= lastDay + 1; day++) {
      const missing = day <= lastDay && !this.#chunks.has(day);
      if (missing && runStart === null) runStart = day;
      if (!missing && runStart !== null) {
        this.#loadDays(runStart, day);
        runStart = null;
      }
    }
  }

  /** Reads, prices and caches roll_hour for the UTC days [firstDay, endDay). */
  #loadDays(firstDay: number, endDay: number): void {
    const hourLo = firstDay * DAY_HOURS;
    const hourHi = endDay * DAY_HOURS;
    const rows = this.#db
      .query<Row, [number, number]>(
        `SELECT hour, acct, model, tier, inp, outp, cr, cc, e5, e1, ccx, n FROM roll_hour
         WHERE hour >= ?1 AND hour < ?2`,
      )
      .values(hourLo, hourHi) as Row[];
    this.#ensureIds(rows, 1, 2);
    const candidates = new Map<string, CandidateRow[]>();
    for (const row of this.#candidates(hourLo * HOUR, hourHi * HOUR)) {
      const key = `${Math.floor(row.ts / HOUR)},${row.acct},${row.model},${row.tier}`;
      const list = candidates.get(key);
      if (list === undefined) candidates.set(key, [row]);
      else list.push(row);
    }

    // Rows come in primary-key order, so each day is a contiguous run.
    let i = 0;
    for (let day = firstDay; day < endDay; day++) {
      const end = (day + 1) * DAY_HOURS;
      const start = i;
      while (i < rows.length && num((rows[i] as Row)[0]) < end) i++;
      this.#chunks.set(day, start === i ? EMPTY_CHUNK : this.#chunk(rows, start, i, candidates));
    }
  }

  #chunk(
    rows: readonly Row[],
    start: number,
    end: number,
    candidates: ReadonlyMap<string, CandidateRow[]>,
  ): Chunk {
    const length = end - start;
    const chunk = {
      length,
      hour: new Int32Array(length),
      acct: new Int32Array(length),
      model: new Int32Array(length),
      tier: new Uint8Array(length),
      values: new Float64Array(length * MEASURES),
    };
    let n = 0;
    for (let i = start; i < end; i++) {
      const r = rows[i] as Row;
      const hour = num(r[0]);
      // An hour in which a card changes is always read raw; its bucket is never used.
      if (this.#splitHourSet.has(hour)) continue;
      const acct = num(r[1]);
      const model = num(r[2]);
      const tier = num(r[3]);
      const sums: Sums = {
        inp: num(r[4]),
        outp: num(r[5]),
        cr: num(r[6]),
        cc: num(r[7]),
        e5: num(r[8]),
        e1: num(r[9]),
        ccx: num(r[10]),
      };
      const priced = this.#price(
        sums,
        candidates.get(`${hour},${acct},${model},${tier}`),
        model,
        tier,
        hour * HOUR,
      );
      chunk.hour[n] = hour;
      chunk.acct[n] = acct;
      chunk.model[n] = this.#modelKeyOfStoreId(model);
      chunk.tier[n] = Math.min(tier, 1);
      store(chunk.values, n * MEASURES, sums, num(r[11]), priced);
      n++;
    }
    return n === length ? chunk : { ...chunk, length: n };
  }

  /** Re-reads the names when rows carry an account or model id the maps don't know yet. */
  #ensureIds(rows: readonly Row[], acctColumn: number, modelColumn: number): void {
    for (const r of rows) {
      const acct = num(r[acctColumn]);
      const model = num(r[modelColumn]);
      if (
        acct >= this.#accountIndex.length ||
        this.#accountIndex[acct] === -1 ||
        model >= this.#modelNames.length
      ) {
        this.#mapsLoaded = false;
        this.#ensureMaps();
        return;
      }
    }
  }

  // ── the row cache ──────────────────────────────────────────────────────────────

  /**
   * Makes every UTC hour the raw pieces touch present in the row cache: cached ones move to
   * the most recently used end, missing ones are read and priced. Nothing is evicted here,
   * so every hour the query needs stays until it has been summed.
   */
  #ensureRowHours(pieces: readonly RawPiece[]): void {
    const wanted = new Set<number>();
    for (const piece of pieces) {
      const last = Math.floor((piece.hi - 1) / HOUR);
      for (let h = Math.floor(piece.lo / HOUR); h <= last; h++) {
        const cached = this.#rowHours.get(h);
        if (cached === undefined) {
          wanted.add(h);
        } else {
          this.#rowHours.delete(h);
          this.#rowHours.set(h, cached);
        }
      }
    }
    if (wanted.size === 0) return;
    // Consecutive hours load in one range read.
    const hours = [...wanted].sort((a, b) => a - b);
    let runStart = hours[0] as number;
    for (let i = 1; i <= hours.length; i++) {
      const h = hours[i];
      if (h !== undefined && h === (hours[i - 1] as number) + 1) continue;
      this.#loadRowHours(runStart, (hours[i - 1] as number) + 1);
      if (h !== undefined) runStart = h;
    }
  }

  /** Reads, prices and caches the usage rows of the UTC hours [firstHour, endHour). */
  #loadRowHours(firstHour: number, endHour: number): void {
    const rows = this.#db
      .query<Row, [number, number]>(
        `SELECT ts, acct, model, tier, inp, outp, cr, cc, e5, e1 FROM usage
         WHERE ts >= ?1 AND ts < ?2 ORDER BY ts`,
      )
      .values(firstHour * HOUR, endHour * HOUR) as Row[];
    this.#ensureIds(rows, 1, 2);
    let i = 0;
    for (let hour = firstHour; hour < endHour; hour++) {
      const end = (hour + 1) * HOUR;
      const start = i;
      while (i < rows.length && num((rows[i] as Row)[0]) < end) i++;
      const loaded = this.#rowHour(rows, start, i);
      this.#rowHours.set(hour, loaded);
      this.#cachedRows += Math.max(1, loaded.length);
    }
  }

  #dropRowHour(hour: number): void {
    const cached = this.#rowHours.get(hour);
    if (cached === undefined) return;
    this.#rowHours.delete(hour);
    this.#cachedRows -= Math.max(1, cached.length);
  }

  /** Drops the least recently used hours until the cache is within its bound. */
  #trimRowCache(): void {
    for (const hour of this.#rowHours.keys()) {
      if (this.#cachedRows <= this.#maxCachedRows) return;
      this.#dropRowHour(hour);
    }
  }

  #rowHour(rows: readonly Row[], start: number, end: number): RowHour {
    const length = end - start;
    const out = {
      length,
      ts: new Float64Array(length),
      acct: new Int32Array(length),
      model: new Int32Array(length),
      tier: new Uint8Array(length),
      values: new Float64Array(length * MEASURES),
    };
    for (let i = 0; i < length; i++) {
      const r = rows[start + i] as Row;
      const ts = num(r[0]);
      const model = num(r[2]);
      const tier = num(r[3]);
      const row = {
        input: num(r[4]),
        output: num(r[5]),
        cacheRead: num(r[6]),
        cacheCreation: num(r[7]),
        ephemeral5m: r[8] === null ? null : num(r[8]),
        ephemeral1h: r[9] === null ? null : num(r[9]),
      };
      const tokens = row.input + row.output + row.cacheRead + row.cacheCreation;
      const cost = computeCost(
        row,
        this.#prices.rates(this.#modelNameOf(model), tierName(tier), ts),
      );
      out.ts[i] = ts;
      out.acct[i] = num(r[1]);
      out.model[i] = this.#modelKeyOfStoreId(model);
      out.tier[i] = Math.min(tier, 1);
      store(
        out.values,
        i * MEASURES,
        { inp: row.input, outp: row.output, cr: row.cacheRead, cc: row.cacheCreation },
        1,
        {
          cost: typeof cost === "number" ? cost : 0,
          unpricedTokens: cost === "unpriced" ? tokens : 0,
          unpricedTierTokens: cost === "unpriced-tier" ? tokens : 0,
        },
      );
    }
    return out;
  }

  // ── results ────────────────────────────────────────────────────────────────────

  #calendar(args: QueryArgs, unit: Calendar): CalendarUsage[] {
    return this.#read(() => {
      const r = this.#resolve(args);
      const slices = calendarSlices(r.range, unit, r.zone);
      if (slices.length === 0) return [];
      const bounds = [
        ...slices.map((s) => s.from),
        (slices[slices.length - 1] as { to: number }).to,
      ];
      const cells = this.#collect(bounds, r.allowed, {
        slots: slices.length,
        byAccount: false,
        byModel: true,
        byTier: false,
      });
      return slices.map((slice, slot) => {
        const total = new Float64Array(MEASURES);
        let top = -1;
        let topCost = -1;
        let topTokens = -1;
        for (let m = 0; m < cells.models; m++) {
          const at = (slot * cells.models + m) * MEASURES;
          if (cells.values[at + RECORDS] === 0) continue;
          addInto(total, 0, cells.values, at);
          const cost = cells.values[at + COST] as number;
          const tokens = tokensAt(cells.values, at);
          if (cost > topCost || (cost === topCost && tokens > topTokens)) {
            top = m;
            topCost = cost;
            topTokens = tokens;
          }
        }
        return {
          key: slice.key,
          range: { from: slice.from, to: slice.to },
          usage: usageOf(total, 0),
          topModel: top < 0 ? null : (this.#modelKeyNames[top] ?? ""),
        };
      });
    });
  }

  /** The usage of every model and tier in `slot` together. */
  #sum(cells: Cells, slot: number): Usage {
    const total = new Float64Array(MEASURES);
    const per = cells.accounts * cells.models * cells.tiers;
    for (let c = slot * per; c < (slot + 1) * per; c++) {
      addInto(total, 0, cells.values, c * MEASURES);
    }
    return usageOf(total, 0);
  }

  /** Unpriced tokens per model and tier of a one-slot, model-and-tier layout. */
  #unpriced(cells: Cells): UnpricedModel[] {
    const out: UnpricedModel[] = [];
    for (let m = 0; m < cells.models; m++) {
      for (let t = 0; t < cells.tiers; t++) {
        const at = (m * cells.tiers + t) * MEASURES;
        const model = this.#modelKeyNames[m] ?? "";
        const tier = tierName(t);
        const unpriced = cells.values[at + UNPRICED] as number;
        const unpricedTier = cells.values[at + UNPRICED_TIER] as number;
        if (unpriced > 0) out.push({ model, tier, reason: "unpriced", tokens: unpriced });
        if (unpricedTier > 0)
          out.push({ model, tier, reason: "unpriced-tier", tokens: unpricedTier });
      }
    }
    return out.sort(
      (a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
    );
  }
}

function addInto(into: Float64Array, at: number, from: Float64Array, start: number): void {
  for (let k = 0; k < MEASURES; k++)
    into[at + k] = (into[at + k] as number) + (from[start + k] as number);
}

function store(
  values: Float64Array,
  at: number,
  sums: Pick<Sums, "inp" | "outp" | "cr" | "cc">,
  records: number,
  priced: Priced,
): void {
  values[at + INP] = sums.inp;
  values[at + OUTP] = sums.outp;
  values[at + CR] = sums.cr;
  values[at + CC] = sums.cc;
  values[at + RECORDS] = records;
  values[at + COST] = priced.cost;
  values[at + UNPRICED] = priced.unpricedTokens;
  values[at + UNPRICED_TIER] = priced.unpricedTierTokens;
}

function tokensAt(values: Float64Array, at: number): number {
  return (
    (values[at + INP] as number) +
    (values[at + OUTP] as number) +
    (values[at + CR] as number) +
    (values[at + CC] as number)
  );
}

function usageOf(values: Float64Array, at: number): Usage {
  const total = tokensAt(values, at);
  const unpriced = values[at + UNPRICED] as number;
  const unpricedTier = values[at + UNPRICED_TIER] as number;
  const priced = total - unpriced - unpricedTier;
  return {
    tokens: {
      input: values[at + INP] as number,
      output: values[at + OUTP] as number,
      cacheRead: values[at + CR] as number,
      cacheWrite: values[at + CC] as number,
      total,
    },
    records: values[at + RECORDS] as number,
    cost: values[at + COST] as number,
    estimatedCost: 0,
    coverage: {
      pricedTokens: priced,
      unpricedTokens: unpriced,
      unpricedTierTokens: unpricedTier,
      estimatedTokens: 0,
      pricedShare: total > 0 ? priced / total : 1,
    },
  };
}

function statusOf(values: Float64Array, at: number): PriceStatus {
  const total = tokensAt(values, at);
  if ((values[at + UNPRICED] as number) > 0) return "unpriced";
  const unpricedTier = values[at + UNPRICED_TIER] as number;
  if (unpricedTier > 0) return unpricedTier >= total ? "unpriced-tier" : "partial";
  return "priced";
}

function displayRates(card: Rates | string): DisplayRates | null {
  if (typeof card === "string") return null;
  const threshold = card.long_context_threshold;
  const longContext =
    threshold !== undefined && !card.long_context_unpriced
      ? {
          threshold,
          inputMultiplier: card.long_context_input_multiplier ?? 1,
          outputMultiplier: card.long_context_output_multiplier ?? 1,
        }
      : null;
  return {
    input: card.input,
    output: card.output,
    cacheRead: cacheReadRate(card),
    cacheWrite: card.cache_write ?? card.input * EPHEMERAL_5M_MULT,
    longContext,
  };
}

function byCostThenTokens<T>(usage: (item: T) => Usage, name: (item: T) => string) {
  return (a: T, b: T): number => {
    const ua = usage(a);
    const ub = usage(b);
    if (ub.cost !== ua.cost) return ub.cost - ua.cost;
    if (ub.tokens.total !== ua.tokens.total) return ub.tokens.total - ua.tokens.total;
    const na = name(a);
    const nb = name(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  };
}
