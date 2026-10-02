// Models: the rate board (T13, gen.py `models_a`). Per model and tier over the window: its
// tokens, the rate each is billed at now, cost and share; under it the footnotes, and the
// selected model's rates card and who used it.
import { WINDOW_CHOICES, type Window } from "../../config.ts";
import { type Line, type Seg, seg } from "../components/base.ts";
import type { Column } from "../components/index.ts";
import { Lines, Table } from "../elements.tsx";
import { clip, percent, textWidth, tokens } from "../format.ts";
import { type Tab, tabsHeader } from "../frame.ts";
import { type Keymap, moveKey } from "../keys.ts";
import { splitWidth } from "../layout.ts";
import type { Role } from "../theme.ts";
import type { ModelRow, ModelSort, ModelsVM, PriceChange } from "../vm/models.ts";
import type { Priced } from "../vm/types.ts";
import { grouped, localDay } from "./accounts.tsx";
import { costText } from "./cells.ts";
import { type Section, type View, type ViewContext, withCommand } from "./types.ts";

export type ModelsState = {
  /** The selected row (`rowKey`), or null for the first. */
  readonly selected: string | null;
  readonly sort: ModelSort;
  /** Enter: the selected model's cards come before the footnotes; narrow, they show at all. */
  readonly cards: boolean;
};

export const WINDOW_LABELS: Readonly<Record<Window, string>> = {
  today: "today",
  this_week: "this week",
  this_month: "this month",
  all: "all time",
  "1h": "last 1h",
  "5h": "last 5h",
  "24h": "last 24h",
};
const TAB_LABELS: Readonly<Record<Window, string>> = {
  ...WINDOW_LABELS,
  all: "all",
  "1h": "1h",
  "5h": "5h",
  "24h": "24h",
};
const SHORT_LABELS: Readonly<Partial<Record<Window, string>>> = {
  this_week: "week",
  this_month: "month",
};
/** The window tabs: config's `WINDOW_CHOICES`, in its order (the shell steps through it). */
const WINDOW_TABS: readonly Tab[] = WINDOW_CHOICES.map((w) => ({
  label: TAB_LABELS[w],
  ...(SHORT_LABELS[w] === undefined ? {} : { short: SHORT_LABELS[w] }),
}));
const SORTS: readonly ModelSort[] = ["cost", "tokens", "name"];

export const RATE_FOOTNOTE =
  "$/M = base rate · cache = read rate; writes and long-context requests cost more";
/**
 * The Model column gives way to the rates only down to this (cc-usage T16's floor: the
 * longest bundled priced name, `gpt-5.6-terra`); narrower, the rates go instead.
 */
export const MODEL_MIN_WIDTH = 13;
const SHARE_BAR = 10;
const MAX_GAP = 3;
/** Cells the name column may take beyond its widest name, so a wide board doesn't sprawl. */
const NAME_SLACK = 6;
const CARD_LABEL = 9;
const MAX_USERS = 5;
/** Cards narrower than this are drawn as one; wider than `MAX_CARD` they would sprawl. */
const MIN_CARD = 44;
const MAX_CARD = 62;

export const rowKey = (r: Pick<ModelRow, "model" | "tier">) => `${r.model}\0${r.tier}`;
const label = (r: ModelRow) => `${r.name}${r.tier === "fast" ? " (fast)" : ""}`;
/** Some of its tokens have no price: the name carries `*`, tied to the coverage footnote. */
const marked = (r: ModelRow) => r.status !== "priced";

/**
 * cc-usage's `human_rate`: two decimals, and only as many more (up to six) as the rate
 * needs to be shown without rounding it off ($0.075 never reads as 0.07 or 0.08).
 */
export function humanRate(rate: number): string {
  let text = rate.toFixed(2);
  for (let places = 3; places <= 6; places++) {
    if (Math.abs(Number(text) - rate) < 1e-9) break;
    text = rate.toFixed(places);
  }
  return text;
}

/** A rate in a sentence: `$5`, `$0.25`. */
function rateShort(rate: number): string {
  return Number.isInteger(rate) ? `$${rate}` : `$${humanRate(rate)}`;
}

/** A multiplier as written: `0.05×`, `2×`. */
function times(m: number): string {
  return `${Number(m.toFixed(4))}×`;
}

/**
 * cc-usage's `_fit_name`: the name plus its ` *` marker, the name (never the marker, which
 * ties the row to its footnote) cut with `…` to `width`.
 */
export function fitName(name: string, marker: boolean, width: number | null): string {
  const tail = marker ? " *" : "";
  if (width === null || textWidth(name + tail) <= width) return name + tail;
  return `${clip(name, Math.max(0, width - textWidth(tail) - 1))}…${tail}`;
}

/** Which of the board's optional columns show, and how wide the names are. */
export interface BoardShape {
  readonly rates: boolean;
  readonly provider: boolean;
  readonly bar: boolean;
  readonly cache: boolean;
  readonly pct: boolean;
  /** The Model column's width; a longer name is cut, its marker kept. */
  readonly nameWidth: number;
}

type ColumnId =
  | "name"
  | "provider"
  | "input"
  | "inputRate"
  | "output"
  | "outputRate"
  | "cache"
  | "cacheRate"
  | "cost"
  | "bar"
  | "pct";

/** The total under the rows. */
interface Total extends Priced {
  readonly total: true;
  readonly input: number;
  readonly output: number;
  readonly cache: number;
}
type BoardRow = ModelRow | Total;
const isTotal = (r: BoardRow): r is Total => "total" in r;

export interface Board {
  readonly shape: BoardShape;
  readonly columns: Column<BoardRow>[];
  readonly gap: number;
  /** Cells the table takes. */
  readonly width: number;
}

function shareOf(r: ModelRow, vm: ModelsVM, showCost: boolean): number {
  if (showCost) return r.share;
  return vm.total.tokens > 0 ? r.tokens / vm.total.tokens : 0;
}

function count(title: string, f: (r: BoardRow) => number): Omit<Column<BoardRow>, "width"> {
  return { title, align: "right", role: "tokens", text: (r) => tokens(f(r)) };
}

function price(f: (rates: NonNullable<ModelRow["rates"]>) => number) {
  const col: Omit<Column<BoardRow>, "width"> = {
    title: "$/M",
    align: "right",
    role: "dim",
    // Rates don't add up across models: the total has none.
    text: (r) => (isTotal(r) ? "" : r.rates === null ? "—" : humanRate(f(r.rates))),
  };
  return col;
}

/** Every column the board can have, in order. */
function allColumns(
  vm: ModelsVM,
  ctx: ViewContext,
  nameWidth: number | null,
): { id: ColumnId; col: Omit<Column<BoardRow>, "width"> }[] {
  const cols: { id: ColumnId; col: Omit<Column<BoardRow>, "width"> }[] = [
    {
      id: "name",
      col: {
        title: "model",
        role: (r) => (isTotal(r) ? "head" : r.status === "priced" ? "fg" : "mute"),
        bold: (r) => isTotal(r),
        text: (r) => (isTotal(r) ? "Total" : fitName(label(r), marked(r), nameWidth)),
      },
    },
    {
      id: "provider",
      col: { title: "provider", role: "mute", text: (r) => (isTotal(r) ? "" : r.provider) },
    },
    { id: "input", col: count("input", (r) => r.input) },
    { id: "inputRate", col: price((p) => p.input) },
    { id: "output", col: count("output", (r) => r.output) },
    { id: "outputRate", col: price((p) => p.output) },
    { id: "cache", col: count("cache", (r) => r.cache) },
    { id: "cacheRate", col: price((p) => p.cacheRead) },
  ];
  if (ctx.showCost) {
    cols.push({
      id: "cost",
      col: {
        title: "cost",
        align: "right",
        role: (r) => costText(r).role,
        bold: (r) => costText(r).role === "cost",
        text: (r) => costText(r).text,
      },
    });
  }
  cols.push({
    id: "bar",
    col: {
      title: "share",
      role: ctx.showCost ? "cost" : "tokens",
      bar: (r) => (isTotal(r) ? 0 : shareOf(r, vm, ctx.showCost)),
    },
  });
  cols.push({
    id: "pct",
    col: {
      title: "",
      align: "right",
      role: "mute",
      text: (r) => (isTotal(r) ? "" : percent(shareOf(r, vm, ctx.showCost))),
    },
  });
  return cols;
}

function shown(id: ColumnId, shape: BoardShape): boolean {
  switch (id) {
    case "provider":
      return shape.provider;
    case "inputRate":
    case "outputRate":
    case "cacheRate":
      return shape.rates;
    case "cache":
      return shape.cache;
    case "bar":
      return shape.bar;
    case "pct":
      return shape.pct;
    default:
      return true;
  }
}

function totalRow(vm: ModelsVM): Total {
  return { total: true, ...vm.total };
}

/**
 * The board in `width` cells: the first shape that fits, cc-usage T16's rules extended to
 * this board's extra columns.
 * 1. Every column, names whole.
 * 2. Names squeezed to keep the rates: never below `MODEL_MIN_WIDTH`, the ` *` kept, and
 *    only while no two names then read the same.
 * 3. Without the rate columns, names whole; then also without the share bar, the provider,
 *    cache, and the share %, until Model, input, output and cost are left.
 * 4. Those four with the names cut, as a last resort: a number is never cut.
 * The rates also need costs shown, a row with a price, and their footnote to fit. Spare
 * cells widen the gaps (up to 3) and, a little, the names.
 */
export function boardFor(vm: ModelsVM, ctx: ViewContext, width: number): Board {
  const rows: BoardRow[] = [...vm.rows, totalRow(vm)];
  const names = vm.rows.map((r) => ({ name: label(r), marker: marked(r) }));
  const fullName = Math.max(
    textWidth("model"),
    textWidth("Total"),
    ...names.map((n) => textWidth(fitName(n.name, n.marker, null))),
  );
  const columns = allColumns(vm, ctx, null);
  const widths = new Map<ColumnId, number>();
  for (const { id, col } of columns) {
    if (id === "name") continue;
    let w = textWidth(col.title);
    if (col.bar) w = SHARE_BAR;
    else for (const r of rows) w = Math.max(w, textWidth(col.text?.(r) ?? ""));
    widths.set(id, w);
  }
  const used = (shape: BoardShape) => {
    const ids = columns.map((c) => c.id).filter((id) => shown(id, shape));
    let sum = ids.length - 1;
    for (const id of ids) sum += id === "name" ? shape.nameWidth : (widths.get(id) as number);
    return { sum, n: ids.length };
  };
  const distinct = (w: number) =>
    new Set(names.map((n) => fitName(n.name, n.marker, w))).size === names.length;
  const full: BoardShape = {
    rates:
      ctx.showCost &&
      vm.rows.some((r) => r.rates !== null) &&
      textWidth(` ${RATE_FOOTNOTE}`) <= ctx.width,
    provider: true,
    bar: true,
    cache: true,
    pct: true,
    nameWidth: fullName,
  };
  const plain: BoardShape[] = [
    { ...full, rates: false },
    { ...full, rates: false, bar: false },
    { ...full, rates: false, bar: false, provider: false },
    { ...full, rates: false, bar: false, provider: false, cache: false },
    { ...full, rates: false, bar: false, provider: false, cache: false, pct: false },
  ];
  let shape: BoardShape | undefined;
  if (used(full).sum <= width) {
    shape = full;
  } else if (full.rates) {
    const budget = width - (used(full).sum - fullName);
    if (budget >= MODEL_MIN_WIDTH && distinct(budget)) shape = { ...full, nameWidth: budget };
  }
  shape ??= plain.find((s) => used(s).sum <= width);
  if (shape === undefined) {
    const last = plain[plain.length - 1] as BoardShape;
    shape = { ...last, nameWidth: Math.max(1, width - (used(last).sum - fullName)) };
  }
  const chosen = shape;
  const { sum, n } = used(chosen);
  const spare = Math.max(0, width - sum);
  const gap = n > 1 ? 1 + Math.min(MAX_GAP - 1, Math.floor(spare / (n - 1))) : 1;
  const slack = chosen.nameWidth < fullName ? 0 : Math.min(NAME_SLACK, spare - (gap - 1) * (n - 1));
  const nameWidth = chosen.nameWidth + slack;
  const cols = allColumns(vm, ctx, chosen.nameWidth)
    .filter(({ id }) => shown(id, chosen))
    .map(({ id, col }) => ({
      ...col,
      width: id === "name" ? nameWidth : (widths.get(id) as number),
    }));
  return {
    shape: { ...chosen, nameWidth },
    columns: cols,
    gap,
    width: cols.reduce((a, c) => a + c.width, 0) + gap * (n - 1),
  };
}

function ordered(vm: ModelsVM, state: ModelsState): ModelRow[] {
  return vm.order[state.sort].map((i) => vm.rows[i] as ModelRow);
}

function selectedIndex(rows: readonly ModelRow[], state: ModelsState): number {
  if (rows.length === 0) return -1;
  const at = state.selected === null ? 0 : rows.findIndex((r) => rowKey(r) === state.selected);
  return Math.max(0, at);
}

/** The title, then the window's tab strip flush right: the title shortens before any tab goes. */
function titleLine(vm: ModelsVM, state: ModelsState, ctx: ViewContext): Line {
  return tabsHeader(
    [[seg(` MODELS · by ${state.sort}`, "head", true)], [seg(" MODELS", "head", true)]],
    WINDOW_TABS,
    WINDOW_CHOICES.indexOf(vm.window),
    ctx.width,
  );
}

function tableSection(
  vm: ModelsVM,
  board: Board,
  rows: readonly ModelRow[],
  selected: number,
  state: ModelsState,
  ctx: ViewContext,
): Section {
  const n = rows.length;
  const title = titleLine(vm, state, ctx);
  if (n === 0) {
    const empty: Line = {
      left: [seg(`  no usage in ${WINDOW_LABELS[vm.window]} · a/d changes the window`, "dim")],
    };
    return {
      id: "models",
      priority: 1,
      height: 2,
      render: () => <Lines theme={ctx.theme} lines={[title, empty]} />,
    };
  }
  return {
    id: "models",
    // Title, header, the rows, then a rule and the total. The footnotes and cards get rows
    // only once every model has one. Enter puts the selected model's cards first instead:
    // the table then keeps its selected row. Either way, a table cut short scrolls and says
    // how many rows are off screen, so no model is hidden without a cue.
    priority: state.cards ? 2 : 1,
    height: 2 + n + 2,
    ...(state.cards ? { minHeight: 2 + 1 + 2 } : {}),
    render: (height) => (
      <box flexDirection="column" height={height} flexShrink={0}>
        <Lines theme={ctx.theme} lines={[title]} />
        <Table<BoardRow>
          columns={board.columns}
          rows={rows}
          selected={selected}
          totals={totalRow(vm)}
          theme={ctx.theme}
          height={height - 1}
          width={board.width}
          gap={board.gap}
          more={true}
          marginLeft={1}
        />
      </box>
    ),
  };
}

/** The first of `variants` that fits `width` (the last one otherwise). */
function firstFit(variants: readonly string[], width: number): string {
  return variants.find((v) => textWidth(v) <= width) ?? (variants[variants.length - 1] as string);
}

/** The footnotes: what $/M means (when the rates show), price coverage, and estimates. */
export function noteLines(vm: ModelsVM, board: Board, ctx: ViewContext): Line[] {
  if (vm.rows.length === 0) return [];
  const room = ctx.width - 1;
  const note = (text: string): Line => ({ left: [seg(` ${text}`, "dim")] });
  const lines: Line[] = [];
  if (board.shape.rates) lines.push(note(RATE_FOOTNOTE));
  if (!ctx.showCost) return lines;
  const priced = `${percent(vm.pricedShare)} of tokens priced`;
  lines.push(
    note(
      vm.rows.some(marked)
        ? firstFit(
            [
              `* no published rate: tokens counted, cost excluded · ${priced}`,
              `* no published rate · ${priced}`,
              `* unpriced · ${percent(vm.pricedShare)} priced`,
            ],
            room,
          )
        : priced,
    ),
  );
  const estimated = vm.rows.filter((r) => r.estimatedCost > 0);
  if (estimated.length > 0) {
    const what = [
      ...new Set(
        estimated.map((r) =>
          r.card?.estimatedAs ? `${r.name} priced as ${r.card.estimatedAs}` : r.name,
        ),
      ),
    ].join(", ");
    lines.push(
      note(
        firstFit(
          [
            `≈ estimated: ${what}; its provider doesn't say which model serves it`,
            `≈ estimated: ${what}`,
            "≈ partly estimated",
          ],
          room,
        ),
      ),
    );
  }
  return lines;
}

function notesSection(
  vm: ModelsVM,
  board: Board,
  ctx: ViewContext,
  priority: number,
): Section | null {
  const lines = noteLines(vm, board, ctx);
  if (lines.length === 0) return null;
  return {
    id: "notes",
    priority,
    height: lines.length,
    render: (height) => <Lines theme={ctx.theme} lines={lines} height={height} />,
  };
}

// ── the selected model's cards ───────────────────────────────────────────────────

const field = (name: string, ...rest: Seg[]): Line => ({
  left: [seg(name.padEnd(CARD_LABEL), "mute"), ...rest],
});

/** `Aug 21: $5/$30 → $4/$20`, or the cache-read rate when only that changed. */
export function changeText(c: PriceChange, asOf: number, tz: string): string {
  const when = localDay(c.at, asOf, tz);
  const io = (p: PriceChange["before"]) =>
    p === null ? "no price" : `${rateShort(p.input)}/${rateShort(p.output)}`;
  const { before, after } = c;
  if (
    before !== null &&
    after !== null &&
    before.input === after.input &&
    before.output === after.output
  ) {
    return before.cacheRead === after.cacheRead
      ? `${when}: cache writes changed`
      : `${when}: cache read ${rateShort(before.cacheRead)} → ${rateShort(after.cacheRead)}`;
  }
  return `${when}: ${io(before)} → ${io(after)}`;
}

/** The rates card for `r`, its lines at most `inner` cells where they can be. */
export function rateLines(r: ModelRow, vm: ModelsVM, inner: number): Line[] {
  const card = r.card;
  const usd = (v: number) => `$${humanRate(v)}`;
  if (card === null) {
    return [
      { left: [seg("no published rate:", "dim")] },
      { left: [seg("tokens counted, cost excluded", "dim")] },
    ];
  }
  const lines: Line[] = [
    field(
      "input",
      seg(usd(card.input), "fg"),
      seg(" · output ", "mute"),
      seg(usd(card.output), "fg"),
    ),
    field(
      "cache",
      seg(`read ${usd(card.cacheRead)}`, "fg"),
      seg(` (${times(card.cacheReadMultiplier)} input)`, "dim"),
    ),
    "flat" in card.cacheWrite
      ? field("write", seg(usd(card.cacheWrite.flat), "fg"))
      : field(
          "write",
          seg(`5m ${usd(card.cacheWrite.m5)}`, "fg"),
          seg(" · ", "dim"),
          seg(`1h ${usd(card.cacheWrite.h1)}`, "fg"),
        ),
  ];
  if (card.fast !== null) {
    lines.push(
      field(
        "fast",
        seg(`${usd(card.fast.input)} · ${usd(card.fast.output)}`, "fg"),
        seg(` · read ${usd(card.fast.cacheRead)}`, "dim"),
      ),
    );
  } else if (r.tier === "fast") {
    lines.push(field("fast", seg("no fast price: unpriced", "dim")));
  }
  if (card.longContext !== null) {
    const lc = card.longContext;
    lines.push(
      field(
        "long",
        seg(
          `>${tokens(lc.threshold)}: input ${times(lc.inputMultiplier)}, output ${times(lc.outputMultiplier)}`,
          "dim",
        ),
      ),
    );
  }
  if (card.estimatedAs !== null) {
    lines.push(field("estimate", seg(`priced as ${card.estimatedAs}`, "mid")));
  }
  const { name, checked } = card.source;
  const both = `${name} · checked ${checked}`;
  if (checked !== null && CARD_LABEL + textWidth(both) <= inner) {
    lines.push(field("source", seg(both, "dim")));
  } else {
    lines.push(field("source", seg(name, "dim")));
    if (checked !== null) lines.push(field("checked", seg(checked, "dim")));
  }
  // The two latest changes; how many earlier ones there were.
  for (const c of r.changes.slice(-2)) {
    lines.push(field("changed", seg(changeText(c, vm.asOf, vm.tz), "mid")));
  }
  if (r.changes.length > 2) lines.push(field("", seg(`+${r.changes.length - 2} earlier`, "dim")));
  return lines;
}

/** The "who used it" card for `r`: each account's share and amount, first use, requests. */
export function userLines(r: ModelRow, vm: ModelsVM, ctx: ViewContext, inner: number): Line[] {
  // Shares of cost; of tokens when costs are hidden or the model has no priced cost.
  const byTokens = !ctx.showCost || !(r.cost > 0);
  const value = (u: Priced): { text: string; role: Role } =>
    byTokens ? { text: tokens(u.tokens), role: "tokens" } : costText(u);
  const users = r.users.slice(0, MAX_USERS);
  const texts = users.map(value);
  const valueWidth = Math.max(0, ...texts.map((t) => textWidth(t.text)));
  const nameWidth = Math.min(12, Math.max(0, ...users.map((u) => textWidth(u.label))));
  const barWidth = Math.max(4, inner - nameWidth - 1 - 6 - valueWidth);
  const whole = (byTokens ? r.tokens : r.cost) || 1;
  const lines: Line[] = users.map((u, i) => {
    const share = (byTokens ? u.tokens : u.cost) / whole;
    const n = share > 0 ? Math.max(1, Math.min(barWidth, Math.round(share * barWidth))) : 0;
    const t = texts[i] as { text: string; role: Role };
    return {
      left: [
        seg(`${clip(u.label, nameWidth).padEnd(nameWidth)} `, "mute"),
        seg("━".repeat(n), byTokens ? "tokens" : "cost"),
        seg("━".repeat(barWidth - n), "empty"),
        seg(` ${percent(share, 0).padStart(4)} `, "fg"),
        seg(t.text.padStart(valueWidth), t.role),
      ],
    };
  });
  if (r.users.length > users.length) {
    lines.push({ left: [seg(`+ ${r.users.length - users.length} more`, "dim")] });
  }
  const by = byTokens ? "by tokens · " : "";
  const first =
    r.firstSeen === null ? "" : `first seen ${localDay(r.firstSeen, vm.asOf, vm.tz)} · `;
  const requests = `${grouped(r.records)} request${r.records === 1 ? "" : "s"}`;
  lines.push({
    left: [seg(firstFit([`${by}${first}${requests}`, `${by}${requests}`, requests], inner), "dim")],
  });
  return lines;
}

/**
 * The selected model's rates card and "who used it" card, side by side when both fit at
 * `MIN_CARD`, else one card holding both; costs hidden, the second alone. As tall as the
 * tallest row's, so moving the selection never moves the layout.
 */
function cardsSection(
  vm: ModelsVM,
  rows: readonly ModelRow[],
  row: ModelRow,
  ctx: ViewContext,
  priority: number,
): Section {
  const available = ctx.width - 2;
  const title = label(row);
  const card = (name: string, width: number, h: number, lines: Line[]) => (
    <th-card
      title={`${title} · ${name}`}
      theme={ctx.theme}
      width={width}
      height={h}
      flexShrink={0}
      flexDirection="column"
    >
      <Lines theme={ctx.theme} lines={lines} height={h - 2} />
    </th-card>
  );
  if (!ctx.showCost) {
    // Rates are cost information (cc-usage T16): costs hidden, only who used it.
    const width = Math.min(available, MAX_CARD);
    const height = Math.max(...rows.map((r) => userLines(r, vm, ctx, width - 4).length)) + 2;
    return {
      id: "cards",
      priority,
      height,
      render: (h) => (
        <box flexDirection="column" height={h} flexShrink={0} paddingLeft={1}>
          {card("who used it", width, h, userLines(row, vm, ctx, width - 4))}
        </box>
      ),
    };
  }
  if (available < 2 * MIN_CARD + 2) {
    const inner = available - 4;
    const height =
      Math.max(
        ...rows.map((r) => rateLines(r, vm, inner).length + userLines(r, vm, ctx, inner).length),
      ) + 2;
    return {
      id: "cards",
      priority,
      height,
      render: (h) => (
        <box flexDirection="column" height={h} flexShrink={0} paddingLeft={1}>
          {card("rates and use", available, h, [
            ...rateLines(row, vm, inner),
            ...userLines(row, vm, ctx, inner),
          ])}
        </box>
      ),
    };
  }
  // The rates card takes a little more than half: its lines are the longer.
  const [half, other] = splitWidth(available, 2, 2) as [number, number];
  const rateWidth = Math.min(MAX_CARD, half + Math.floor(other / 8));
  const userWidth = Math.min(MAX_CARD, available - 2 - rateWidth);
  const rateRows = Math.max(...rows.map((r) => rateLines(r, vm, rateWidth - 4).length));
  const userRows = Math.max(...rows.map((r) => userLines(r, vm, ctx, userWidth - 4).length));
  const height = Math.max(rateRows, userRows) + 2;
  return {
    id: "cards",
    priority,
    height,
    render: (h) => (
      <box flexDirection="row" height={h} flexShrink={0} paddingLeft={1} columnGap={2}>
        {card("rates", rateWidth, h, rateLines(row, vm, rateWidth - 4))}
        {card("who used it", userWidth, h, userLines(row, vm, ctx, userWidth - 4))}
      </box>
    ),
  };
}

const keymap: Keymap<ModelsState, ModelsVM | undefined> = [
  // The window is config's: the shell steps it.
  moveKey("tabs", {
    label: "window",
    does: `Switch the window: ${WINDOW_TABS.map((t) => t.label).join(" · ")}`,
    act: (state, _vm, key) =>
      withCommand(state, { type: "window", step: key === "right" ? 1 : -1 }),
  }),
  moveKey("select", {
    label: "model",
    does: "Select a model",
    act: (state, vm, key) => {
      if (vm === undefined) return undefined;
      const rows = ordered(vm, state);
      if (rows.length === 0) return undefined;
      const at = selectedIndex(rows, state) + (key === "down" ? 1 : -1);
      const next = rows[Math.max(0, Math.min(rows.length - 1, at))] as ModelRow;
      return { ...state, selected: rowKey(next) };
    },
  }),
  moveKey("open", {
    label: "rates",
    does: "Show or hide the selected model's rates and who used it",
    act: (state) => ({ ...state, cards: !state.cards }),
  }),
  {
    // `o` was the sort key before T17: kept, unlisted, for hands that remember it.
    keys: ["r", "o"],
    show: "r",
    label: "sort",
    does: "Sort by cost, tokens or name",
    act: (state) => ({
      ...state,
      sort: SORTS[(SORTS.indexOf(state.sort) + 1) % SORTS.length] as ModelSort,
    }),
  },
];

export const models: View<ModelsVM, ModelsState> = {
  id: "models",
  title: "Models",
  keymap,
  initial: { selected: null, sort: "cost", cards: false },
  sections(vm, state, ctx) {
    const rows = ordered(vm, state);
    const at = selectedIndex(rows, state);
    const board = boardFor(vm, ctx, ctx.width - 2);
    const out: Section[] = [tableSection(vm, board, rows, at, state, ctx)];
    const notes = notesSection(vm, board, ctx, state.cards ? 3 : 2);
    if (notes !== null) out.push(notes);
    const row = rows[at];
    // Wide and medium, the cards show when rows allow; narrow, on Enter. Enter puts them
    // first, so at a small size they show even if the table must go.
    if (row !== undefined && (state.cards || ctx.bp !== "narrow")) {
      out.push(cardsSection(vm, rows, row, ctx, state.cards ? 1 : 3));
    }
    return out;
  },
};
