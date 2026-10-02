// The parity gate's judgement (scripts/parity.ts), free of I/O so it can be tested on
// synthetic data (test/parity/classify.test.ts).
//
// Row by row, cc-usage's row is walked to tokenhud's through the known fixes (ARCHITECTURE
// §6.4), in order, and each fix's effect is accepted only when an independent derivation
// gives exactly the same:
// - replay: the row is gone from tokenhud, its key is tombstoned as a Codex replay,
//   cc-usage's own parser, run on the rollouts today, still emits exactly that row (same
//   key, timestamp, model and counts), and the rollout's structure, read by the harness's
//   own code, puts it in a child rollout's replay of its parent (see parity_cc_usage.py);
// - dated-price: the change equals the row's tokens at the dated card in effect then minus
//   cc-usage's flat card, priced by independent code (independent.ts);
// - tier / unpriced-tier: tokenhud prices the row fast exactly when its rollout's own
//   `thread_settings_applied` events, read by the harness's own code, say so, and the change
//   equals the fast card minus the standard one (or, when the fast tier has no price for the
//   row, the standard price taken away);
// - estimated: the change equals the row priced with the estimated alias's cited model;
// - new-data: lines written within the last few minutes before cc-usage's last sync.
// Whatever a row still differs by after that, in tokens or dollars, is `unexplained`, and so
// is any row whose fix does not match its derivation. Two cell-level checks frame the walk:
// cc-usage's own numbers (its Python) against the walk's start, and tokenhud's queries (T6)
// against the walk's end.

import { normalizeModel } from "../../src/pricing/normalize.ts";
import type { PriceTable } from "../../src/pricing/table.ts";
import { formatDate, type Zone } from "../../src/query/tz.ts";
import { UNATTRIBUTED } from "../../src/store/schema.ts";
import { dollars, type IndependentPrices, type Price } from "./independent.ts";

/** A cell's cost may differ by float rounding (sums vs rows, Python vs TS order), never by a cent. */
export const CENT = 0.005;
/** A row's change must equal its derivation to this (float rounding of differently ordered sums). */
const ROW_TOLERANCE = 1e-9;
/** Lines written this long before cc-usage's last sync may not be in its ledger yet. */
export const SYNC_WINDOW_MS = 5 * 60_000;

export const CATEGORIES = [
  "replay",
  "dated-price",
  "tier",
  "unpriced-tier",
  "estimated",
  "new-data",
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * What each category may add up to: a backstop behind the row-by-row derivations, from the
 * architecture and the measurements on this machine.
 */
export const BOUNDS: Record<
  Category,
  { tokens: [number, number]; usd: [number, number]; why: string }
> = {
  replay: {
    tokens: [-2.0e9, 0],
    usd: [-1500, 0],
    why: "removes Codex replay only: up to ~1.73B tokens / ~$1.17K (ARCHITECTURE §6.4)",
  },
  "dated-price": {
    tokens: [0, 0],
    usd: [-250, 250],
    why: "reprices GPT-5.6 Terra/Luna/Sol by date; never changes tokens",
  },
  tier: {
    tokens: [0, 0],
    usd: [0, 300],
    why: "prices priority/fast rows at their tier (about +$103); moves no tokens",
  },
  "unpriced-tier": {
    tokens: [0, 0],
    usd: [-50, 0],
    why: "fast rows with no fast price for their context (one row, -$1.55, on this machine)",
  },
  estimated: {
    tokens: [0, 0],
    usd: [0, 20],
    why: "prices codex-auto-review from its cited estimate (+$4.13); no tokens",
  },
  "new-data": {
    tokens: [0, 2.0e8],
    usd: [0, 500],
    why: `adds only lines from the last ${SYNC_WINDOW_MS / 60_000} minutes before cc-usage's last sync`,
  },
};

export interface Row {
  key: bigint;
  identity: string;
  provider: string;
  ts: number;
  model: string;
  inp: number;
  outp: number;
  cr: number;
  cc: number;
  e5: number | null;
  e1: number | null;
  tier: number;
}

/**
 * A Codex record as cc-usage's parser emits it today, with the tier its rollout sets and
 * whether it lies in a child rollout's replay of its parent.
 */
export interface CodexRecord {
  ts: number;
  model: string;
  inp: number;
  outp: number;
  cr: number;
  tier: number;
  replay: boolean;
}

export interface Cell {
  inp: number;
  outp: number;
  cr: number;
  cc: number;
  cost: number;
  rows: number;
}

/** day|identity|model|tier -> cell. */
export type Cells = Map<string, Cell>;

export interface Inputs {
  zone: Zone;
  /** The pinned now: the ledger copy's newest row. */
  now: number;
  /** cc-usage's rows (its ledger copy). */
  ledger: readonly Row[];
  /** tokenhud's rows (the temp store). */
  ours: readonly Row[];
  /** tokenhud's tombstones: key -> reason. */
  tombstones: ReadonlyMap<bigint, string>;
  /** cc-usage's parse of the Codex rollouts on disk, tiers derived by the harness. */
  codex: ReadonlyMap<bigint, CodexRecord>;
  /** tokenhud's price table: flat (cc-usage's cards for dated models, no aliases), dated (no aliases), full. */
  tables: { flat: PriceTable; dated: PriceTable; full: PriceTable };
  independent: IndependentPrices;
  /** cc-usage's own cells, priced by its Python. */
  theirs: Cells;
  /** tokenhud's queries for these (account identity, local day) pairs. */
  query: (wanted: Array<[identity: string, day: string]>) => Cells;
  labels: ReadonlyMap<string, string>;
}

export interface Tally {
  cells: number;
  rows: number;
  tokens: number;
  usd: number;
}

export interface Verdict {
  cells: number;
  categories: Record<Category | "unexplained", Tally>;
  totals: {
    cc_usage: { tokens: number; usd: number; rows: number };
    tokenhud: { tokens: number; usd: number; rows: number };
  };
  after_now: { rows: number; tokens: number };
  unexplained: {
    rows: Record<string, number>;
    cells: Array<{
      day: string;
      account: string;
      model: string;
      tier: string;
      tokens: number;
      usd: number;
      at: "base" | "queries";
    }>;
  };
  bounds_failed: string[];
  passed: boolean;
}

const COUNTS = ["inp", "outp", "cr", "cc", "e5", "e1"] as const;
const tierName = (tier: number) => (tier === 0 ? "standard" : "fast");
export const tokensOf = (c: { inp: number; outp: number; cr: number; cc: number }) =>
  c.inp + c.outp + c.cr + c.cc;

function priceOf(r: Row, table: PriceTable, tier: number): Price {
  return table.cost({
    model: r.model,
    tier: tierName(tier),
    atMs: r.ts,
    input: r.inp,
    output: r.outp,
    cacheRead: r.cr,
    cacheCreation: r.cc,
    ephemeral5m: r.e5,
    ephemeral1h: r.e1,
  });
}

/** One row's cost at `tier` from `table`; 0 when it has no price, as cc-usage's views count it. */
export function costOf(r: Row, table: PriceTable, tier: number): number {
  return dollars(priceOf(r, table, tier));
}

function cellKey(zone: Zone, r: Row, tier: number): string {
  return `${formatDate(zone.dateAt(r.ts))}|${r.identity}|${normalizeModel(r.model)}|${tierName(tier)}`;
}

/** Prices every row on its own with `table` (at tier 0 unless `tiers`) and sums per cell. */
export function cellsOf(rows: Iterable<Row>, table: PriceTable, zone: Zone, tiers: boolean): Cells {
  const cells: Cells = new Map();
  for (const r of rows) {
    const tier = tiers ? r.tier : 0;
    const key = cellKey(zone, r, tier);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { inp: 0, outp: 0, cr: 0, cc: 0, cost: 0, rows: 0 };
      cells.set(key, cell);
    }
    cell.inp += r.inp;
    cell.outp += r.outp;
    cell.cr += r.cr;
    cell.cc += r.cc;
    cell.cost += costOf(r, table, tier);
    cell.rows++;
  }
  return cells;
}

interface CellDiff {
  key: string;
  before: Cell;
  after: Cell;
}

const empty = (): Cell => ({ inp: 0, outp: 0, cr: 0, cc: 0, cost: 0, rows: 0 });

/** Cells that differ in any token count, or by more than `tolerance` dollars. */
function diff(before: Cells, after: Cells, tolerance: number): CellDiff[] {
  const out: CellDiff[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key) ?? empty();
    const b = after.get(key) ?? empty();
    const tokens = a.inp !== b.inp || a.outp !== b.outp || a.cr !== b.cr || a.cc !== b.cc;
    if (tokens || Math.abs(b.cost - a.cost) > tolerance) out.push({ key, before: a, after: b });
  }
  return out.sort((x, y) => (x.key < y.key ? -1 : 1));
}

function total(cells: Cells): { tokens: number; usd: number; rows: number } {
  let tokens = 0;
  let usd = 0;
  let rows = 0;
  for (const c of cells.values()) {
    tokens += tokensOf(c);
    usd += c.cost;
    rows += c.rows;
  }
  return { tokens, usd, rows };
}

/** Whether two prices agree: both a number within the row tolerance, or the same reason for none. */
function agree(a: Price, b: Price): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= ROW_TOLERANCE;
  return a === b;
}

/** Whether cc-usage's ledger row is exactly what its parser emits for that key today. */
function sameRecord(c: Row, p: CodexRecord | undefined): boolean {
  return (
    p !== undefined &&
    p.ts === c.ts &&
    p.model === c.model &&
    p.inp === c.inp &&
    p.outp === c.outp &&
    p.cr === c.cr &&
    c.cc === 0
  );
}

export function judge(input: Inputs): Verdict {
  const { zone, now, tables, independent: ind } = input;
  const windowStart = now - SYNC_WINDOW_MS;
  const ledger = new Map(input.ledger.map((r) => [r.key, r]));
  const ours = new Map<bigint, Row>();
  const afterNow = { rows: 0, tokens: 0 };
  for (const t of input.ours) {
    if (t.ts > now) {
      afterNow.rows++;
      afterNow.tokens += tokensOf(t);
    } else ours.set(t.key, t);
  }

  const tallies = new Map<
    Category,
    { cells: Set<string>; rows: number; tokens: number; usd: number }
  >(CATEGORIES.map((c) => [c, { cells: new Set(), rows: 0, tokens: 0, usd: 0 }]));
  const unexplainedRows = new Map<string, number>();
  const residue = { rows: 0, tokens: 0, usd: 0, cells: new Set<string>() };

  for (const key of new Set([...ledger.keys(), ...ours.keys()])) {
    const c = ledger.get(key) ?? null;
    const t = ours.get(key) ?? null;
    const why: string[] = [];
    let tokens = c === null ? 0 : tokensOf(c);
    let usd = c === null ? 0 : costOf(c, tables.flat, 0);
    const count = (cat: Category, row: Row, tier: number, dTokens: number, dUsd: number) => {
      const tally = tallies.get(cat) as {
        cells: Set<string>;
        rows: number;
        tokens: number;
        usd: number;
      };
      tally.cells.add(cellKey(zone, row, tier));
      tally.rows++;
      tally.tokens += dTokens;
      tally.usd += dUsd;
      tokens += dTokens;
      usd += dUsd;
    };

    // replay: gone from tokenhud, tombstoned, and still emitted as stored by cc-usage's parser.
    let s: Row | null = c;
    if (c !== null && t === null) {
      const parsed = input.codex.get(key);
      if (!tombstoneIsReplay(input, c) && input.tombstones.has(key)) {
        why.push("a row removed for a reason other than a Codex replay");
      } else if (tombstoneIsReplay(input, c) && !sameRecord(c, parsed)) {
        why.push("a tombstoned row cc-usage's parser does not emit as stored");
      } else if (tombstoneIsReplay(input, c) && parsed?.replay !== true) {
        why.push("a removed row that is not in a child rollout's replay of its parent");
      } else if (tombstoneIsReplay(input, c)) {
        count("replay", c, 0, -tokensOf(c), -costOf(c, tables.flat, 0));
        s = null;
      } else {
        why.push("a cc-usage row tokenhud does not have");
      }
    }
    if (c !== null && t !== null && (c.identity !== t.identity || c.ts !== t.ts)) {
      why.push("a row whose account or timestamp differs");
    }

    if (s !== null) {
      // dated-price: tokenhud's periods against cc-usage's flat card.
      const datedDelta = costOf(s, tables.dated, 0) - costOf(s, tables.flat, 0);
      if (datedDelta !== 0) {
        const expected = dollars(ind.price(s, 0, false)) - dollars(ind.ccUsagePrice(s));
        if (Math.abs(datedDelta - expected) <= ROW_TOLERANCE) {
          count("dated-price", s, 0, 0, datedDelta);
        } else why.push("a dated-price change its rates do not account for");
      }
      // tier: tokenhud's flag must be what the rollout's own settings events say.
      const ourTier = t?.tier ?? 0;
      const rolloutTier = s.provider === "codex" ? (input.codex.get(key)?.tier ?? 0) : 0;
      let tier = 0;
      if (t !== null && ourTier !== rolloutTier) {
        why.push(
          ourTier === 1
            ? s.provider === "codex"
              ? "a row tokenhud prices fast that its rollout does not set fast"
              : "a fast Claude row (no independent derivation for it)"
            : "a row its rollout sets fast that tokenhud prices standard",
        );
      } else if (ourTier === 1) {
        tier = 1;
        const fast = priceOf(s, tables.dated, 1);
        const stdPrice = priceOf(s, tables.dated, 0);
        const std = dollars(stdPrice);
        if (!agree(fast, ind.price(s, 1, false)) || !agree(stdPrice, ind.price(s, 0, false))) {
          why.push("a fast price its rates do not account for");
        } else if (fast === "unpriced-tier") {
          count("unpriced-tier", s, 1, 0, -std);
        } else count("tier", s, 1, 0, dollars(fast) - std);
      }
      // estimated: an aliased model priced with its cited estimate.
      const estimated = costOf(s, tables.full, tier) - costOf(s, tables.dated, tier);
      if (estimated !== 0) {
        const expected = dollars(ind.price(s, tier, true)) - dollars(ind.price(s, tier, false));
        if (Math.abs(estimated - expected) <= ROW_TOLERANCE) {
          count("estimated", s, tier, 0, estimated);
        } else why.push("an estimated price that is not its cited estimate");
      }
    }

    // new-data: what the transcripts added after cc-usage last read them.
    if (t !== null) {
      const recent = t.ts > windowStart;
      if (s === null) {
        const rolloutTier = t.provider === "codex" ? (input.codex.get(key)?.tier ?? 0) : 0;
        if (c === null && t.tier !== rolloutTier) {
          why.push("a new row whose tier its rollout does not set");
        } else if (c === null && recent) {
          count("new-data", t, t.tier, tokensOf(t), costOf(t, tables.full, t.tier));
        } else if (c === null) {
          why.push(
            `a ${t.provider} row tokenhud has and cc-usage does not, from before its last sync`,
          );
        }
      } else {
        const lower = COUNTS.some((f) => (t[f] ?? -1) < (s[f] ?? -1));
        const higher = COUNTS.some((f) => (t[f] ?? -1) > (s[f] ?? -1));
        const resolved = s.model === UNATTRIBUTED && t.model !== UNATTRIBUTED;
        const remodelled = normalizeModel(s.model) !== normalizeModel(t.model) && !resolved;
        if (lower || remodelled) {
          why.push("a row tokenhud holds lower, or under another model");
        } else if (higher || resolved) {
          if (recent) {
            count(
              "new-data",
              t,
              t.tier,
              tokensOf(t) - tokensOf(s),
              costOf(t, tables.full, t.tier) - costOf(s, tables.full, t.tier),
            );
          } else why.push("a row tokenhud holds higher, from before cc-usage's last sync");
        }
      }
    }

    // Whatever is left is unexplained.
    const finalTokens = t === null ? 0 : tokensOf(t);
    const finalUsd = t === null ? 0 : costOf(t, tables.full, t.tier);
    const leftTokens = finalTokens - tokens;
    const leftUsd = finalUsd - usd;
    if (why.length > 0 || leftTokens !== 0 || Math.abs(leftUsd) > ROW_TOLERANCE) {
      const kind = why[0] ?? "a difference no fix accounts for";
      unexplainedRows.set(kind, (unexplainedRows.get(kind) ?? 0) + 1);
      residue.rows++;
      residue.tokens += leftTokens;
      residue.usd += leftUsd;
      const shown = t ?? c;
      if (shown !== null) residue.cells.add(cellKey(zone, shown, t?.tier ?? 0));
    }
  }

  // The two ends of the walk, cell by cell: cc-usage's own numbers, and tokenhud's queries.
  const base = cellsOf(input.ledger, tables.flat, zone, false);
  const end = cellsOf(ours.values(), tables.full, zone, true);
  const wanted = new Set<string>();
  for (const key of end.keys()) wanted.add(key.split("|").slice(0, 2).join("|"));
  const queried = input.query(
    [...wanted].map((w) => {
      const [day, identity] = w.split("|") as [string, string];
      return [identity, day];
    }),
  );
  const atBase = diff(input.theirs, base, CENT).map((d) => ({ ...d, at: "base" as const }));
  const atQueries = diff(end, queried, CENT).map((d) => ({ ...d, at: "queries" as const }));
  const cells = [...atBase, ...atQueries].map((d) => {
    const [day, identity, model, tier] = d.key.split("|") as [string, string, string, string];
    return {
      day,
      account: input.labels.get(identity) ?? "?",
      model: model || "(none)",
      tier,
      tokens: tokensOf(d.after) - tokensOf(d.before),
      usd: d.after.cost - d.before.cost,
      at: d.at,
    };
  });

  const categories = {} as Verdict["categories"];
  for (const [name, t] of tallies) {
    categories[name] = { cells: t.cells.size, rows: t.rows, tokens: t.tokens, usd: t.usd };
  }
  categories.unexplained = {
    cells: residue.cells.size + cells.length,
    rows: residue.rows,
    tokens: residue.tokens + cells.reduce((s, c) => s + c.tokens, 0),
    usd: residue.usd + cells.reduce((s, c) => s + c.usd, 0),
  };

  const boundsFailed: string[] = [];
  for (const name of CATEGORIES) {
    const c = categories[name];
    const b = BOUNDS[name];
    const inside = (v: number, [lo, hi]: [number, number], slack: number) =>
      v >= lo - slack && v <= hi + slack;
    if (!inside(c.tokens, b.tokens, 0) || !inside(c.usd, b.usd, CENT)) {
      boundsFailed.push(`${name}: ${c.tokens} tokens, $${c.usd.toFixed(2)} (${b.why})`);
    }
  }

  return {
    cells: new Set([...input.theirs.keys(), ...queried.keys()]).size,
    categories,
    totals: { cc_usage: total(input.theirs), tokenhud: total(queried) },
    after_now: afterNow,
    unexplained: { rows: Object.fromEntries(unexplainedRows), cells },
    bounds_failed: boundsFailed,
    passed: residue.rows === 0 && cells.length === 0 && boundsFailed.length === 0,
  };
}

function tombstoneIsReplay(input: Inputs, c: Row): boolean {
  return c.provider === "codex" && input.tombstones.get(c.key) === "codex-replay";
}
