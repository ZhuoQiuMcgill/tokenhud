// The Models view (T13): the rate board's view model against independent sums and the
// bundled cards, cc-usage T16's narrow fallback (ported with its tests), the selected
// model's cards, the window and sort keys, and snapshots at the four sizes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "../../src/config.ts";
import { normalizeModel } from "../../src/pricing/normalize.ts";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import { Zone } from "../../src/query/tz.ts";
import { openStoreReader, type UsageRow } from "../../src/store/store.ts";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState, type Ports } from "../../src/tui/controller.ts";
import { modelName, tokens } from "../../src/tui/format.ts";
import { breakpoint } from "../../src/tui/layout.ts";
import { theme } from "../../src/tui/theme.ts";
import { costText } from "../../src/tui/views/cells.ts";
import {
  boardFor,
  changeText,
  fitName,
  humanRate,
  MODEL_MIN_WIDTH,
  type ModelsState,
  RATE_FOOTNOTE,
  rateLines,
  rowKey,
} from "../../src/tui/views/models.tsx";
import type { ViewContext } from "../../src/tui/views/types.ts";
import { ALL_TIME } from "../../src/tui/vm/compute.ts";
import {
  computeModels,
  type ModelRow,
  type ModelsVM,
  type PriceChange,
  priceChanges,
  rateCard,
} from "../../src/tui/vm/models.ts";
import { createQueries } from "../../src/tui/vm/session.ts";
import type { AccountInfo, ViewModels } from "../../src/tui/vm/types.ts";
import { guard } from "../guard.ts";
import { bundledTable, fixtureConfig, fixtureRows, NOW, TZ } from "./fixture.ts";
import { extraRows, makeT13Fixture, type T13Fixture, t13Views } from "./fixture-t13.ts";
import { chars, cleanupRenderers, render, settle } from "./render.ts";

guard();

cleanupRenderers();

const rows: UsageRow[] = [...fixtureRows(), ...extraRows()];
const table = bundledTable();
let fx: T13Fixture;
let views: ViewModels;
let accounts: AccountInfo[];
let vm: ModelsVM;

beforeAll(() => {
  fx = makeT13Fixture();
  ({ views, accounts } = t13Views(fx));
  vm = views.models as ModelsVM;
});
afterAll(() => fx.remove());

const row = (model: string, tier: "standard" | "fast" = "standard") =>
  vm.rows.find((r) => r.model === model && r.tier === tier) as ModelRow;

function close(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-6);
}

/** Each row priced on its own, by the pricing module: the oracle. */
function oracle(keep: (r: UsageRow) => boolean) {
  let cost = 0;
  let tokens = 0;
  let records = 0;
  for (const r of rows) {
    if (!keep(r)) continue;
    records++;
    tokens += r.inp + r.outp + r.cr + r.cc;
    const c = table.cost({
      model: r.model,
      tier: r.tier === 1 ? "fast" : "standard",
      atMs: r.ts,
      input: r.inp,
      output: r.outp,
      cacheRead: r.cr,
      cacheCreation: r.cc,
      ephemeral5m: r.e5,
      ephemeral1h: r.e1,
    });
    if (typeof c === "number") cost += c;
  }
  return { cost, tokens, records };
}

describe("formatting, as cc-usage writes it", () => {
  test("rates: two decimals, and only the more a rate needs (format.py human_rate)", () => {
    expect(humanRate(5)).toBe("5.00");
    expect(humanRate(25)).toBe("25.00");
    expect(humanRate(0.25)).toBe("0.25");
    expect(humanRate(0.1)).toBe("0.10");
    expect(humanRate(3 * 0.1)).toBe("0.30");
    expect(humanRate(0.075)).toBe("0.075");
    expect(humanRate(0.0375)).toBe("0.0375");
    expect(humanRate(0.0004)).toBe("0.0004");
    expect(humanRate(3.125)).toBe("3.125");
    expect(humanRate(1 / 3)).toBe("0.333333");
  });

  test("model names (format.py pretty_model_name)", () => {
    expect(modelName("claude-opus-4-8")).toBe("Opus 4.8");
    expect(modelName("claude-fable-5")).toBe("Fable 5");
    expect(modelName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(modelName("")).toBe("(unknown)");
  });

  test("a cut name keeps its unpriced marker (render.py _fit_name)", () => {
    expect(fitName("codex-unattributed", true, null)).toBe("codex-unattributed *");
    expect(fitName("codex-unattributed", true, 13)).toBe("codex-unat… *");
    expect(fitName("gpt-5.6-terra", false, 13)).toBe("gpt-5.6-terra");
    expect(fitName("Opus 4.8", false, 4)).toBe("Opu…");
  });
});

describe("the view model", () => {
  test("every model and tier of the window, priced as each row is on its own", () => {
    const models = new Set(rows.map((r) => `${normalizeModel(r.model)}/${r.tier}`));
    expect(vm.rows.map((r) => `${r.model}/${r.tier === "fast" ? 1 : 0}`).sort()).toEqual(
      [...models].sort(),
    );
    for (const r of vm.rows) {
      const tier = r.tier === "fast" ? 1 : 0;
      const want = oracle((u) => normalizeModel(u.model) === r.model && u.tier === tier);
      close(r.cost, want.cost);
      expect(r.tokens).toBe(want.tokens);
      expect(r.records).toBe(want.records);
    }
    close(vm.total.cost, oracle(() => true).cost);
    expect(vm.window).toBe("all");
  });

  test("markers: unpriced, estimated and a priced fast tier", () => {
    const mystery = row("claude-mystery-9");
    expect(mystery).toMatchObject({ status: "unpriced", rates: null, card: null, cost: 0 });
    expect(costText(mystery).text).toBe("unpriced");

    const review = row("codex-auto-review");
    expect(review.cost).toBeGreaterThan(0);
    expect(review.estimatedCost).toBe(review.cost);
    expect(costText(review).text.startsWith("≈")).toBe(true);
    expect(review.card?.estimatedAs).toBe("gpt-5.6-luna");
    close(vm.total.estimatedCost, review.cost);
    // Only the alias is an estimate.
    expect(vm.rows.filter((r) => r.estimatedCost > 0).map((r) => r.model)).toEqual([
      "codex-auto-review",
    ]);

    // Opus 5.5 fast: $8 / $40, cache reads at the standard card's 0.05x of the fast input.
    const fast = row("claude-opus-5-5", "fast");
    expect(fast.status).toBe("priced");
    expect(fast.rates).toEqual({ input: 8, output: 40, cacheRead: 0.4 });
    expect(row("claude-opus-5-5").rates).toEqual({ input: 4, output: 20, cacheRead: 0.2 });
  });

  test("the rates card: the bundled card now, its cache rates, fast rates and source", () => {
    const opus = row("claude-opus-5-5").card;
    const anthropic = bundledPricing().sources.anthropic;
    expect(opus).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheReadMultiplier: 0.05,
      cacheWrite: { m5: 5, h1: 8 },
      fast: { input: 8, output: 40, cacheRead: 0.4 },
      longContext: null,
      source: { name: "platform.claude.com", checked: anthropic?.checked ?? "" },
      estimatedAs: null,
    });
    const sol = row("gpt-5.6-sol").card;
    expect(sol?.cacheWrite).toEqual({ flat: 5 });
    expect(sol?.longContext).toEqual({
      threshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    });
    expect(sol?.source.name).toBe("developers.openai.com");
    expect(row("codex-auto-review").card?.source).toEqual({ name: "x.com", checked: null });
  });

  test("a user's override is the source of the card it changes", () => {
    const { models, aliases } = bundledPricing();
    const prices = new PriceTable(
      { ...models, "claude-opus-5-5": { input: 7, output: 35 } },
      aliases,
    );
    const card = rateCard(prices, "claude-opus-5-5", "claude", NOW);
    expect(card?.input).toBe(7);
    expect(card?.cacheRead).toBeCloseTo(0.7, 12);
    expect(card?.source).toEqual({ name: "pricing.overrides.json", checked: null });
    expect(rateCard(prices, "claude-opus-4-8", "claude", NOW)?.source.name).toBe(
      "platform.claude.com",
    );
  });

  test("price changes inside the window: gpt-5.6-sol on Aug 21, nothing this month", () => {
    const aug21 = Date.parse("2026-08-21T07:00:00Z");
    expect(row("gpt-5.6-sol").changes).toEqual([
      {
        at: aug21,
        before: { input: 5, output: 30, cacheRead: 0.5 },
        after: { input: 4, output: 20, cacheRead: 0.4 },
      },
    ]);
    // Aug 5 changed only the fast card's long-context price: no rate shown changed.
    expect(row("gpt-5.6-sol", "standard").changes).toHaveLength(1);
    expect(row("claude-opus-5-5").changes).toEqual([]);
    const month = {
      from: Date.parse("2026-09-01T04:00:00Z"),
      to: Date.parse("2026-10-01T04:00:00Z"),
    };
    expect(priceChanges(table, "gpt-5.6-sol", "standard", month, NOW)).toEqual([]);
    // A change after now is not in the window yet.
    expect(
      priceChanges(table, "gpt-5.6-sol", "standard", { from: 0, to: aug21 + 1 }, aug21 - 1),
    ).toEqual([]);
  });

  test("who used it: each account's part sums to the row; first use; provider", () => {
    for (const r of vm.rows) {
      close(
        r.users.reduce((s, u) => s + u.cost, 0),
        r.cost,
      );
      expect(r.users.reduce((s, u) => s + u.tokens, 0)).toBe(r.tokens);
      const costs = r.users.map((u) => u.cost);
      expect(costs).toEqual([...costs].sort((a, b) => b - a));
      const firsts = rows.filter((u) => normalizeModel(u.model) === r.model).map((u) => u.ts);
      expect(r.firstSeen).toBe(Math.min(...firsts));
    }
    expect(row("claude-opus-5-5").provider).toBe("claude");
    expect(row("gpt-5.5").provider).toBe("codex");
    expect(row("claude-opus-5-5").users.map((u) => u.label)).toEqual(["personal"]);
  });

  test("sort orders: by cost (the query's), tokens, name", () => {
    const at = (i: number) => vm.rows[i] as ModelRow;
    expect(vm.order.cost).toEqual(vm.rows.map((_, i) => i));
    const t = vm.order.tokens.map((i) => at(i).tokens);
    expect(t).toEqual([...t].sort((a, b) => b - a));
    const names = vm.order.name.map((i) => at(i).name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  });

  test("scoped to one account: its models only, and it alone used them", () => {
    const work = accounts.find((a) => a.label === "work") as AccountInfo;
    const scoped = t13Views(fx, fixtureConfig(), work.id).views.models as ModelsVM;
    const mine = rows.filter((r) => r.identity === "fixture-identity-work");
    expect(scoped.rows.reduce((s, r) => s + r.records, 0)).toBe(mine.length);
    for (const r of scoped.rows) expect(r.users.map((u) => u.label)).toEqual(["work"]);
  });

  test("it depends on the window's range and dates itself by the next card change", () => {
    const db = openStoreReader(fx.storePath);
    if (db === null) throw new Error("no store");
    try {
      const q = createQueries(db, table, TZ, () => NOW);
      const base = {
        q,
        now: NOW,
        zone: Zone.of(TZ),
        accounts,
        scope: null,
        prices: table,
        sources: null,
      };
      const all = computeModels({ ...base, window: "all" });
      expect(all.deps).toEqual([ALL_TIME]);
      const later = table.boundaries().find((b) => b > NOW) ?? Number.POSITIVE_INFINITY;
      expect(all.validUntil).toBe(later);
      const today = computeModels({ ...base, window: "today" });
      expect(today.deps).toEqual([
        { from: Date.parse("2026-09-29T04:00:00Z"), to: Date.parse("2026-09-30T04:00:00Z") },
      ]);
      expect(today.validUntil).toBe(Math.min(later, Date.parse("2026-09-30T04:00:00Z")));
      expect(computeModels({ ...base, window: "5h" }).validUntil).toBe(NOW + 60_000);
    } finally {
      db.close();
    }
  });
});

describe("the query layer: first use of each model", () => {
  test("normalised ids, every account or some", () => {
    const db = openStoreReader(fx.storePath);
    if (db === null) throw new Error("no store");
    try {
      const q = createQueries(db, table, TZ, () => NOW);
      const want = (keep: (r: UsageRow) => boolean) => {
        const out = new Map<string, number>();
        for (const r of rows.filter(keep)) {
          const m = normalizeModel(r.model);
          out.set(m, Math.min(out.get(m) ?? Number.POSITIVE_INFINITY, r.ts));
        }
        return out;
      };
      expect(q.modelsFirstSeen()).toEqual(want(() => true));
      const work = accounts.find((a) => a.label === "work") as AccountInfo;
      expect(q.modelsFirstSeen({ accounts: [work.id] })).toEqual(
        want((r) => r.identity === "fixture-identity-work"),
      );
      expect(q.modelsFirstSeen({ accounts: [] })).toEqual(new Map());
    } finally {
      db.close();
    }
  });
});

// ── the narrow fallback: cc-usage T16's rules, on this board ─────────────────────

function ctxAt(width: number, showCost = true): ViewContext {
  return {
    width,
    bp: breakpoint(width),
    theme: theme("dark"),
    showCost,
    tz: TZ,
    scope: null,
  };
}

/** A view model of hand-made rows: a model, priced or not, with huge or small numbers. */
function vmOf(
  list: { model: string; priced: boolean; n: number; cost: number }[],
  prices: PriceTable = table,
): ModelsVM {
  const rows = list.map((m): ModelRow => {
    const card = prices.rates(m.model, "standard", NOW);
    const rates =
      typeof card === "string"
        ? null
        : {
            input: card.input,
            output: card.output,
            cacheRead: card.cache_read ?? card.input * 0.1,
          };
    return {
      model: m.model,
      name: modelName(m.model),
      tier: "standard",
      provider: "codex",
      input: m.n,
      output: m.n,
      cache: m.n,
      tokens: 3 * m.n,
      cost: m.cost,
      pricedShare: m.priced ? 1 : 0,
      estimatedCost: 0,
      share: 0,
      status: m.priced ? "priced" : "unpriced",
      rates: m.priced ? rates : null,
      records: 1,
      firstSeen: null,
      users: [],
      card: null,
      changes: [],
    };
  });
  const sum = (f: (r: ModelRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  return {
    window: "all",
    rows,
    order: {
      cost: rows.map((_, i) => i),
      tokens: rows.map((_, i) => i),
      name: rows.map((_, i) => i),
    },
    total: {
      cost: sum((r) => r.cost),
      tokens: sum((r) => r.tokens),
      pricedShare: 1,
      estimatedCost: 0,
      input: sum((r) => r.input),
      output: sum((r) => r.output),
      cache: sum((r) => r.cache),
    },
    pricedShare: 1,
    asOf: NOW,
    tz: TZ,
  };
}

const ids = (vm: ModelsVM, width: number) => {
  const b = boardFor(vm, ctxAt(width + 2), width);
  return b.columns.map((c) => c.title);
};

describe("narrow fallback (cc-usage T16)", () => {
  test("by width on the fixture: rates first, then the share bar, provider, cache, share %", () => {
    // The body is the terminal width less a margin each side.
    const shape = (w: number) => {
      const { rates, provider, bar, cache, pct, nameWidth } = boardFor(vm, ctxAt(w), w - 2).shape;
      return { rates, provider, bar, cache, pct, nameWidth };
    };
    const all = { rates: true, provider: true, bar: true, cache: true, pct: true };
    // 105 and 100: everything, names whole ("codex-auto-review" is the widest, 17).
    expect(shape(105)).toEqual({ ...all, nameWidth: 20 });
    expect(shape(100)).toEqual({ ...all, nameWidth: 23 });
    // 90: the rates stay, the names squeezed to the room left (15 >= the floor of 13).
    expect(shape(90)).toEqual({ ...all, nameWidth: 15 });
    // 80: squeezing would go below 13, so the rates go; names whole again.
    expect(shape(80)).toEqual({ ...all, rates: false, nameWidth: 22 });
    expect(shape(70)).toEqual({ ...all, rates: false, bar: false, nameWidth: 17 });
    expect(shape(60)).toEqual({ ...all, rates: false, bar: false, provider: false, nameWidth: 17 });
    expect(shape(50)).toEqual({
      rates: false,
      provider: false,
      bar: false,
      cache: false,
      pct: true,
      nameWidth: 19,
    });
    expect(shape(40)).toMatchObject({ rates: false, cache: false, pct: false });
  });

  test("never wider than the room; once the rates show, wider boards keep them", () => {
    let from: number | null = null;
    for (let w = 40; w <= 160; w++) {
      const b = boardFor(vm, ctxAt(w), w - 2);
      expect(b.width).toBeLessThanOrEqual(w - 2);
      if (b.shape.rates) from ??= w;
      else expect(from).toBeNull();
    }
    // At 88 the board has 86 cells: just enough for the names at the floor of 13.
    expect(from).toBe(88);
    expect(boardFor(vm, ctxAt(88), 86).shape.nameWidth).toBe(MODEL_MIN_WIDTH);
  });

  test("the rates need their footnote to fit and costs shown", () => {
    expect(RATE_FOOTNOTE).toBe(
      "$/M = base rate · cache = read rate; writes and long-context requests cost more",
    );
    const small = vmOf([{ model: "claude-opus-4-8", priced: true, n: 1200, cost: 4.75 }]);
    // The board alone fits in 78 cells, but the footnote needs 80 with its margin.
    expect(boardFor(small, ctxAt(79), 78).shape.rates).toBe(false);
    expect(boardFor(small, ctxAt(80), 78).shape.rates).toBe(true);
    expect(boardFor(small, ctxAt(120, false), 118).shape.rates).toBe(false);
    expect(ids(small, 118)).toContain("$/M");
  });

  test("nothing to price, no rates: an empty or all-unpriced window", () => {
    const unpriced = vmOf([{ model: "codex-unattributed", priced: false, n: 900, cost: 0 }]);
    expect(boardFor(unpriced, ctxAt(160), 158).shape.rates).toBe(false);
  });

  test("rates drop rather than squeeze the Model column below its floor", () => {
    const { models, aliases } = bundledPricing();
    const prices = new PriceTable(
      {
        ...models,
        "acme-experimental-model": { input: 12.3456, output: 123.4567, cache_read: 1.23456 },
      },
      aliases,
    );
    const wide = vmOf(
      [{ model: "acme-experimental-model", priced: true, n: 999_900_000, cost: 123_456.78 }],
      prices,
    );
    const at = (w: number) => boardFor(wide, ctxAt(w + 2), w);
    // Every column but the name, one cell apart.
    const { columns } = at(200);
    const others =
      columns.slice(1).reduce((sum, c) => sum + (c.width as number), 0) + columns.length - 1;
    const first = others + MODEL_MIN_WIDTH;
    expect(at(first).shape).toMatchObject({ rates: true, nameWidth: MODEL_MIN_WIDTH });
    expect(fitName("acme-experimental-model", false, MODEL_MIN_WIDTH)).toBe("acme-experim…");
    expect(at(first - 1).shape.rates).toBe(false);
    expect(at(first - 1).shape.nameWidth).toBeGreaterThanOrEqual(23);
  });

  test("names that a squeeze would make identical keep the plain board", () => {
    const { models, aliases } = bundledPricing();
    const prices = new PriceTable(
      {
        ...models,
        "gpt-5.1-codex-max": { input: 1.25, output: 10, cache_read: 0.125 },
        "gpt-5.1-codex-mini": { input: 0.25, output: 2, cache_read: 0.025 },
      },
      aliases,
    );
    const pair = vmOf(
      [
        { model: "gpt-5.6-sol", priced: true, n: 91_400_000, cost: 2639.2 },
        { model: "gpt-5.1-codex-max", priced: true, n: 40_000_000, cost: 10 },
        { model: "gpt-5.1-codex-mini", priced: true, n: 9_000_000, cost: 1 },
      ],
      prices,
    );
    for (let w = 60; w <= 140; w++) {
      const b = boardFor(pair, ctxAt(w + 2), w);
      if (!b.shape.rates) continue;
      const labels = pair.rows.map((r) => fitName(r.name, false, b.shape.nameWidth));
      expect(new Set(labels).size).toBe(3);
    }
    // At the floor the two would both read "gpt-5.1-codex…".
    expect(fitName("gpt-5.1-codex-max", false, 13)).toBe(fitName("gpt-5.1-codex-mini", false, 13));
  });
});

// ── frames ───────────────────────────────────────────────────────────────────────

const ports: Ports = {
  saveConfig: () => {},
  vmSettings: () => {},
  vmConfig: () => {},
  vmRoots: () => {},
  accountsEdited: () => {},
  quit: () => {},
};

function controller(config: Config = fixtureConfig()) {
  const c = new Controller(initialState(config, "owner"), ports, TZ);
  c.vmMessage({ type: "views", views, accounts, scope: null, ms: 1 });
  c.vmMessage({ type: "mcp", activity: { servers: 1, agents: 1, recent: [], latest: [] } });
  c.setIngest("live");
  c.key({ name: "3", sequence: "3", ctrl: false });
  return c;
}

const press = (c: Controller, name: string) => c.key({ name, sequence: name, ctrl: false });

/** No number cut: no digit, $, % or * next to an ellipsis. */
function noCutNumbers(frame: string) {
  expect(frame).not.toMatch(/[\d$%*]…|…[\d$]/);
}

async function frameAt(width: number, height: number, keys: string[] = []) {
  const c = controller();
  const setup = await render(<Frame controller={c} width={width} height={height} />, width, height);
  await settle(setup, () => {
    for (const k of keys) press(c, k);
  });
  return chars(setup);
}

describe("frames", () => {
  test.each([
    [105, 50, []],
    [120, 45, ["down"]],
    [80, 24, []],
    [160, 50, []],
  ] as const)("%i×%i", async (width, height, keys) => {
    const frame = await frameAt(width, height, [...keys]);
    const lines = frame.split("\n").slice(0, height);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    noCutNumbers(frame);
    expect(frame).toMatchSnapshot();
  });

  test("80×24 with Enter: the selected model's cards, the table down to its row", async () => {
    const frame = await frameAt(80, 24, ["down", "return"]);
    expect(frame).toContain("gpt-5.6-sol · rates and use");
    expect(frame).toContain("changed  Aug 21: $5/$30 → $4/$20");
    expect(frame).toMatchSnapshot();
  });

  // The acceptance widths: numbers whole whichever shape the board takes.
  test.each([80, 90, 100, 105])("width %i: every number of the board whole", async (width) => {
    const frame = await frameAt(width, 50);
    noCutNumbers(frame);
    const board = boardFor(vm, ctxAt(width), width - 2);
    for (const r of vm.rows) {
      expect(frame).toContain(costText(r).text);
      expect(frame).toContain(tokens(r.input));
      expect(frame).toContain(tokens(r.output));
      if (board.shape.cache) expect(frame).toContain(tokens(r.cache));
      const name = fitName(
        `${r.name}${r.tier === "fast" ? " (fast)" : ""}`,
        r.status !== "priced",
        board.shape.nameWidth,
      );
      expect(frame).toContain(name);
      if (board.shape.rates && r.rates !== null) {
        expect(frame).toContain(humanRate(r.rates.input));
        expect(frame).toContain(humanRate(r.rates.output));
      }
    }
    expect(frame).toContain(costText(vm.total).text);
    expect(frame.includes("$/M")).toBe(board.shape.rates);
    expect(frame.includes(RATE_FOOTNOTE)).toBe(board.shape.rates);
  });

  test("costs hidden: no rates, no dollars; shares are of tokens", async () => {
    const c = controller(fixtureConfig({ show_cost: false }));
    const setup = await render(<Frame controller={c} width={120} height={45} />, 120, 45);
    const frame = chars(setup);
    expect(frame).not.toContain("$");
    expect(frame).not.toContain("$/M");
    expect(frame).toContain("who used it");
  });
});

// Critique M1: the footnotes and cards never take rows from the table; a table cut short
// scrolls and says how many models are off screen.
describe("every model reachable at every height", () => {
  const label = (r: ModelRow) =>
    fitName(`${r.name}${r.tier === "fast" ? " (fast)" : ""}`, r.status !== "priced", null);

  test.each(Array.from({ length: 8 }, (_, i) => 25 + i))("105×%i", async (height) => {
    const c = controller();
    const setup = await render(<Frame controller={c} width={105} height={height} />, 105, height);
    const seen = new Set<string>();
    for (let i = 0; i <= vm.rows.length; i++) {
      const frame = chars(setup);
      const shown = vm.rows.filter((r) => frame.includes(label(r)));
      for (const r of shown) seen.add(rowKey(r));
      if (shown.length < vm.rows.length) {
        // Rows off screen: the table says how many, and nothing else takes rows from it.
        expect(frame).toMatch(/\d+ more ↓|↑ \d+ more/);
        expect(frame).not.toContain("who used it");
        expect(frame).not.toContain("$/M = base rate");
      }
      await settle(setup, () => press(c, "down"));
    }
    expect(seen.size).toBe(vm.rows.length);
  });

  test("the unpriced row is never hidden without the cue", async () => {
    const mystery = label(row("claude-mystery-9"));
    for (let height = 12; height <= 40; height++) {
      const c = controller();
      const setup = await render(<Frame controller={c} width={105} height={height} />, 105, height);
      const frame = chars(setup);
      if (!frame.includes(mystery)) expect(frame).toMatch(/\d+ more ↓/);
    }
  });

  test("the cue counts what is off screen above and below", async () => {
    const c = controller();
    const setup = await render(<Frame controller={c} width={105} height={14} />, 105, 14);
    expect(chars(setup)).toContain("5 more ↓");
    await settle(setup, () => {
      for (let i = 0; i < 7; i++) press(c, "down");
    });
    expect(chars(setup)).toContain("↑ 3 more · 2 more ↓");
  });
});

describe("the critique's smaller fixes", () => {
  test("who used an unpriced model: shares of tokens, said so", async () => {
    const c = controller();
    const setup = await render(<Frame controller={c} width={120} height={45} />, 120, 45);
    const at = vm.rows.findIndex((r) => r.model === "claude-mystery-9");
    await settle(setup, () => {
      for (let i = 0; i < at; i++) press(c, "down");
    });
    const frame = chars(setup);
    const mystery = row("claude-mystery-9");
    expect(frame).toContain("by tokens");
    for (const u of mystery.users) {
      const share = `${Math.round((u.tokens / mystery.tokens) * 100)}%`;
      expect(frame).toMatch(new RegExp(`${u.label} +━+ +${share} +${tokens(u.tokens)}`));
    }
  });

  test("a change of cache writes alone is a change; more than two say how many more", () => {
    const { models, aliases } = bundledPricing();
    const card = (input: number, cache_write: number) => ({
      input,
      output: input * 5,
      cache_read: input / 10,
      cache_write,
    });
    const prices = new PriceTable(
      {
        ...models,
        "acme-model": {
          periods: [
            { from: null, card: card(2, 2.5) },
            { from: "2026-09-10T00:00:00Z", card: card(2, 3) },
            { from: "2026-09-15T00:00:00Z", card: card(1, 3) },
            { from: "2026-09-20T00:00:00Z", card: card(0.5, 3) },
          ],
        },
      },
      aliases,
    );
    const month = {
      from: Date.parse("2026-09-01T04:00:00Z"),
      to: Date.parse("2026-10-01T04:00:00Z"),
    };
    const changes = priceChanges(prices, "acme-model", "standard", month, NOW);
    expect(changes.map((c) => c.at)).toEqual([
      Date.parse("2026-09-10T00:00:00Z"),
      Date.parse("2026-09-15T00:00:00Z"),
      Date.parse("2026-09-20T00:00:00Z"),
    ]);
    expect(changeText(changes[0] as PriceChange, NOW, TZ)).toBe("Sep 9: cache writes changed");
    const r = { ...row("gpt-5.6-sol"), changes };
    const text = rateLines(r, vm, 60).map((l) => l.left.map((x) => x.text).join(""));
    expect(text.filter((t) => t.startsWith("changed"))).toHaveLength(2);
    expect(text.at(-1)?.trim()).toBe("+1 earlier");
  });

  test("an override of the fast card alone is the user's", () => {
    const { models, aliases } = bundledPricing();
    const prices = new PriceTable(
      {
        ...models,
        "claude-opus-5-5": {
          input: 4,
          output: 20,
          cache_read: 0.2,
          fast: { input: 9, output: 45 },
        },
      },
      aliases,
    );
    expect(rateCard(prices, "claude-opus-5-5", "claude", NOW)?.source.name).toBe(
      "pricing.overrides.json",
    );
  });

  test("the footer keeps r sort at 105 columns, on the view's line", async () => {
    const frame = await frameAt(105, 50);
    expect(frame.split("\n")[48]).toContain("r sort");
  });
});

describe("keys", () => {
  function recording() {
    const calls: { window?: string; saved?: string }[] = [];
    const c = new Controller(
      initialState(fixtureConfig(), "owner"),
      {
        ...ports,
        saveConfig: (config) => calls.push({ saved: config.default_window }),
        vmSettings: (s) => calls.push({ window: s.window }),
      },
      TZ,
    );
    c.vmMessage({ type: "views", views, accounts, scope: null, ms: 1 });
    press(c, "3");
    return { c, calls };
  }

  test("←/→ step the window through the calendar ones and the rolling ones, saved", () => {
    const { c, calls } = recording();
    press(c, "right"); // all → 1h
    press(c, "right"); // → 5h
    press(c, "left"); // → 1h
    press(c, "left"); // → all
    press(c, "left"); // → this_month
    expect(calls).toEqual([
      { saved: "1h" },
      { window: "1h" },
      { saved: "5h" },
      { window: "5h" },
      { saved: "1h" },
      { window: "1h" },
      { saved: "all" },
      { window: "all" },
      { saved: "this_month" },
      { window: "this_month" },
    ]);
    expect(c.getState().config.default_window).toBe("this_month");
    // The command rode on the view's state once: the state kept has none, so the next
    // key of the view doesn't step the window again.
    expect(Object.getOwnPropertySymbols(c.getState().viewState.models as object)).toEqual([]);
    press(c, "r");
    expect(calls).toHaveLength(10);
  });

  test("↑/↓ select in the order shown; r sorts (o too, as before); Enter shows the cards", () => {
    const { c } = recording();
    const state = () => c.getState().viewState.models as ModelsState;
    expect(state()).toEqual({ selected: null, sort: "cost", cards: false });
    press(c, "down");
    expect(state().selected).toBe(rowKey(vm.rows[1] as ModelRow));
    press(c, "up");
    press(c, "up");
    expect(state().selected).toBe(rowKey(vm.rows[0] as ModelRow));
    press(c, "r");
    expect(state().sort).toBe("tokens");
    // The selection stays on its row; down is the next one in the new order.
    const next = vm.order.tokens[vm.order.tokens.indexOf(0) + 1] as number;
    press(c, "down");
    expect(state().selected).toBe(rowKey(vm.rows[next] as ModelRow));
    press(c, "R");
    press(c, "o");
    expect(state().sort).toBe("cost");
    press(c, "return");
    expect(state().cards).toBe(true);
  });
});
