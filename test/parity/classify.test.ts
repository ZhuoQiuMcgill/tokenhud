// The parity gate's judgement (scripts/parity/classify.ts) on a small synthetic machine:
// clean, it passes with each fix in its category; with any of the T7 critique's injected
// regressions (a Codex double count, raised rows, rows wrongly marked fast, legitimate rows
// dropped as replay), or a replay row cc-usage's parser does not confirm, or a pricing
// bug, it fails.
import { describe, expect, test } from "bun:test";
import {
  type CodexRecord,
  cellsOf,
  type Inputs,
  judge,
  type Row,
} from "../../scripts/parity/classify.ts";
import { type Card, IndependentPrices } from "../../scripts/parity/independent.ts";
import ccUsagePricing from "../../src/pricing/cc-usage-v2.6.1-pricing.json";
import bundledJson from "../../src/pricing/pricing.json";
import { isDated, type ModelPricing, parseModelPricing } from "../../src/pricing/schema.ts";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import { Zone } from "../../src/query/tz.ts";
import { guard } from "../guard.ts";

guard();

const zone = Zone.of("UTC");
const now = Date.parse("2026-09-30T12:00:00Z");
const ccCards = ccUsagePricing.models as unknown as Record<string, Card>;

function row(key: bigint, over: Partial<Row>): Row {
  return {
    key,
    identity: "id-codex",
    provider: "codex",
    ts: Date.parse("2026-09-10T10:00:00Z"),
    model: "gpt-5.5",
    inp: 10_000,
    outp: 1_000,
    cr: 50_000,
    cc: 0,
    e5: 0,
    e1: 0,
    tier: 0,
    ...over,
  };
}

const claude = { identity: "id-claude", provider: "claude", e5: null, e1: null };

/** cc-usage's rows: what its ledger holds. */
const ledger = (): Row[] => [
  row(1n, { ...claude, model: "claude-opus-4-8", cc: 2_000 }),
  row(2n, { model: "gpt-5.6-sol", ts: Date.parse("2026-09-10T10:00:00Z") }), // promotional price
  row(3n, {}), // fast in its rollout
  row(4n, { model: "codex-auto-review", ts: Date.parse("2026-09-15T10:00:00Z") }), // estimated
  row(5n, { model: "gpt-5.6-sol", ts: Date.parse("2026-08-01T10:00:00Z"), inp: 300_000 }), // fast, long context, no fast long-context price yet
  row(6n, { ts: Date.parse("2026-09-12T10:00:00Z") }), // a child rollout's replay of its parent
  row(7n, { ts: Date.parse("2026-09-12T11:00:00Z") }),
];

/** tokenhud's rows: the replay gone, fast rows fast, one line after cc-usage's last sync. */
const ours = (): Row[] => [
  ...ledger()
    .filter((r) => r.key !== 6n)
    .map((r) => (r.key === 3n || r.key === 5n ? { ...r, tier: 1 } : r)),
  row(8n, { ts: now - 60_000 }),
];

/**
 * cc-usage's parser over today's rollouts, with the tier each rollout sets and the replay
 * status its structure gives: only key 6 lies in a child rollout's replayed head.
 */
function codex(rows: Row[]): Map<bigint, CodexRecord> {
  const fast = new Set([3n, 5n]);
  return new Map(
    rows
      .filter((r) => r.provider === "codex")
      .map((r) => [
        r.key,
        {
          ts: r.ts,
          model: r.model,
          inp: r.inp,
          outp: r.outp,
          cr: r.cr,
          tier: fast.has(r.key) ? 1 : 0,
          replay: r.key === 6n,
        },
      ]),
  );
}

function tables(models: Record<string, ModelPricing>) {
  const flat: Record<string, ModelPricing> = { ...models };
  for (const [id, entry] of Object.entries(models)) {
    if (!isDated(entry)) continue;
    const card = ccCards[id];
    if (card === undefined) delete flat[id];
    else flat[id] = parseModelPricing(card, id, { coerce: false });
  }
  return {
    flat: new PriceTable(flat),
    dated: new PriceTable(models),
    full: new PriceTable(models, bundledPricing().aliases),
  };
}

function inputs(
  over: {
    ours?: Row[];
    codex?: Map<bigint, CodexRecord>;
    models?: Record<string, ModelPricing>;
  } = {},
): Inputs {
  const theirRows = ledger();
  const ourRows = over.ours ?? ours();
  const t = tables(over.models ?? bundledPricing().models);
  return {
    zone,
    now,
    ledger: theirRows,
    ours: ourRows,
    tombstones: new Map([[6n, "codex-replay"]]),
    codex: over.codex ?? codex([...theirRows, row(8n, { ts: now - 60_000 })]),
    tables: t,
    independent: new IndependentPrices(
      bundledJson as unknown as ConstructorParameters<typeof IndependentPrices>[0],
      {},
      ccCards,
    ),
    // cc-usage prices its rows exactly as tokenhud's cost port does (T2's parity vectors).
    theirs: cellsOf(theirRows, tables(bundledPricing().models).flat, zone, false),
    query: () =>
      cellsOf(
        ourRows.filter((r) => r.ts <= now),
        t.full,
        zone,
        true,
      ),
    labels: new Map([
      ["id-codex", "codex"],
      ["id-claude", "personal"],
    ]),
  };
}

describe("the parity gate", () => {
  test("passes a clean machine, each fix in its own category", () => {
    const v = judge(inputs());
    expect(v.unexplained).toEqual({ rows: {}, cells: [] });
    expect(v.passed).toBe(true);
    const rows = Object.fromEntries(
      Object.entries(v.categories).map(([name, c]) => [name, c.rows]),
    );
    expect(rows).toEqual({
      replay: 1,
      "dated-price": 1,
      tier: 1,
      "unpriced-tier": 1,
      estimated: 1,
      "new-data": 1,
      unexplained: 0,
    });
    expect(v.categories.replay.tokens).toBe(-61_000);
    expect(v.categories["unpriced-tier"].usd).toBeLessThan(0);
    // Sol's promotion: $4/$20 instead of $5/$30, cache reads $0.40 instead of $0.50.
    expect(v.categories["dated-price"].usd).toBeCloseTo(
      (10_000 * -1 + 1_000 * -10 + 50_000 * -0.1) / 1e6,
      12,
    );
  });

  test("fails a Codex double count: rows tokenhud has that cc-usage never had", () => {
    const extra = [20n, 21n, 22n].map((key) =>
      row(key, { ts: Date.parse("2026-09-20T10:00:00Z") }),
    );
    const v = judge(inputs({ ours: [...ours(), ...extra] }));
    expect(v.passed).toBe(false);
    expect(v.unexplained.rows).toEqual({
      "a codex row tokenhud has and cc-usage does not, from before its last sync": 3,
    });
    expect(v.categories.unexplained.tokens).toBe(3 * 61_000);
  });

  test("fails raised rows", () => {
    const raised = ours().map((r) => (r.key === 7n ? { ...r, outp: r.outp + 20_000 } : r));
    const v = judge(inputs({ ours: raised }));
    expect(v.passed).toBe(false);
    expect(v.unexplained.rows).toEqual({
      "a row tokenhud holds higher, from before cc-usage's last sync": 1,
    });
    expect(v.categories.unexplained.tokens).toBe(20_000);
  });

  test("fails rows wrongly marked fast, and fast rows priced standard", () => {
    const wronglyFast = ours().map((r) => (r.key === 7n ? { ...r, tier: 1 } : r));
    const fast = judge(inputs({ ours: wronglyFast }));
    expect(fast.passed).toBe(false);
    expect(fast.unexplained.rows).toEqual({
      "a row tokenhud prices fast that its rollout does not set fast": 1,
    });
    expect(fast.categories.unexplained.usd).toBeGreaterThan(0);
    const missed = ours().map((r) => (r.key === 3n ? { ...r, tier: 0 } : r));
    expect(judge(inputs({ ours: missed })).unexplained.rows).toEqual({
      "a row its rollout sets fast that tokenhud prices standard": 1,
    });
  });

  // The T7 re-review's regression: an over-reaching replay skip drops real usage.
  test("fails legitimate rows dropped as replay: a child's own turn, or a main session's", () => {
    const dropped = ours().filter((r) => r.key !== 3n && r.key !== 7n); // fast and standard
    const given = inputs({ ours: dropped });
    const tombstones = new Map([
      [6n, "codex-replay"],
      [3n, "codex-replay"],
      [7n, "codex-replay"],
    ]);
    const v = judge({ ...given, tombstones });
    expect(v.passed).toBe(false);
    expect(v.unexplained.rows).toEqual({
      "a removed row that is not in a child rollout's replay of its parent": 2,
    });
    expect(v.categories.replay.rows).toBe(1); // only the real one
    expect(v.categories.unexplained.tokens).toBe(-2 * 61_000);
  });

  test("fails a removed row cc-usage's parser does not emit as stored", () => {
    const parsed = codex(ledger());
    parsed.set(6n, { ...(parsed.get(6n) as CodexRecord), outp: 999 });
    const v = judge(inputs({ codex: parsed }));
    expect(v.unexplained.rows).toEqual({
      "a tombstoned row cc-usage's parser does not emit as stored": 1,
    });
  });

  test("fails a pricing bug: a dated price its rates do not give", () => {
    const models = { ...bundledPricing().models };
    const sol = models["gpt-5.6-sol"] as { periods: { from: string | null; card: object }[] };
    models["gpt-5.6-sol"] = {
      periods: sol.periods.map((p, i) =>
        i === sol.periods.length - 1 ? { ...p, card: { ...p.card, input: 4.5 } } : p,
      ),
    } as ModelPricing;
    const v = judge(inputs({ models }));
    expect(v.passed).toBe(false);
    expect(v.unexplained.rows).toEqual({
      "a dated-price change its rates do not account for": 1,
    });
  });

  test("fails when cc-usage's own numbers differ from the walk's start", () => {
    const given = inputs();
    const theirs = new Map(given.theirs);
    const [key, cell] = [...theirs][0] as [string, NonNullable<ReturnType<typeof theirs.get>>];
    theirs.set(key, { ...cell, cost: cell.cost + 0.02 });
    const v = judge({ ...given, theirs });
    expect(v.passed).toBe(false);
    expect(v.unexplained.cells.map((c) => c.at)).toEqual(["base"]);
  });
});
