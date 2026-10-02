// History, "calendar + table" (gen.py `history_a()`, without its Project and Session tabs):
// a 26-week heat map of daily cost, the selected day's detail card, and a table by day,
// week or month with "this week" (from Monday) and "this month" (from the 1st) filters.
//
// One selection drives both halves: the selected day. The heat map's cursor is that day,
// and the table's selected row is the row holding it, so moving either moves the other.
// Everything here picks from the view model; nothing queries (ARCHITECTURE §9).
import { type Line, type Seg, seg, segsWidth } from "../components/base.ts";
import type { Column, MonthLabel } from "../components/index.ts";
import { Lines, Table } from "../elements.tsx";
import { clock, countdown, dayLabel, monthName, textWidth, tokens } from "../format.ts";
import { HEAT_ROLES, type Role } from "../theme.ts";
import type {
  HistoryDay,
  HistoryEvent,
  HistoryPeriod,
  HistoryShare,
  HistoryTotal,
  HistoryVM,
} from "../vm/types.ts";
import { costNote, costText } from "./cells.ts";
import type { Section, View, ViewContext } from "./types.ts";

export type Group = "day" | "week" | "month";

export interface HistoryState {
  readonly focus: "heat" | "table";
  readonly group: Group;
  /** The table lists the days of the week or month holding the selected day (Enter, W, M). */
  readonly open: "week" | "month" | null;
  /** The selected day, YYYY-MM-DD; null follows today. */
  readonly day: string | null;
  /** Rows whose models or accounts match this, ignoring case; "" for all. */
  readonly filter: string;
  /** The filter is being typed: every key goes to it. */
  readonly typing: boolean;
}

const GUTTER = 5;
/** The heat map (title, months, 7 days) and the day card are each this tall. */
const HEAT_HEIGHT = 9;
const CARD_MAX = 64;
/** The "vs average" bar is full at this ratio, so 1× is 8 of its 18 cells (gen.py). */
const BAR_FULL = 2.25;
const BAR_WIDTH = 18;
/** Above this ratio the bar turns `high`. */
const BAR_HIGH = 1.5;
const PAGE = 10;
const MAX_FILTER = 32;
const LABEL = 9;
const GROUP_KEYS: Readonly<Record<string, Group>> = { d: "day", w: "week", m: "month" };

// ── days ─────────────────────────────────────────────────────────────────────────

function dayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function keyOf(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** 0 for Monday … 6 for Sunday. */
function weekday(key: string): number {
  return (new Date(dayNumber(key) * 86_400_000).getUTCDay() + 6) % 7;
}

function shortDate(key: string): string {
  return `${monthName(Number(key.slice(5, 7)))} ${Number(key.slice(8, 10))}`;
}

/** `Sep 28–Oct 4`, `Sep 7–13`. */
function weekLabel(monday: string): string {
  const sunday = keyOf(dayNumber(monday) + 6);
  const end =
    sunday.slice(5, 7) === monday.slice(5, 7) ? String(Number(sunday.slice(8))) : shortDate(sunday);
  return `${shortDate(monday)}–${end}`;
}

/** `Sep 2026`. */
function monthLabel(key: string): string {
  return `${monthName(Number(key.slice(5, 7)))} ${key.slice(0, 4)}`;
}

function today(vm: HistoryVM): string {
  return (vm.days[vm.days.length - 1] as HistoryDay).key;
}

/** Index of the selected day in `vm.days`, clamped to them (a day may have rolled off). */
export function selectedIndex(vm: HistoryVM, state: HistoryState): number {
  const last = vm.days.length - 1;
  if (state.day === null) return last;
  const first = (vm.days[0] as HistoryDay).key;
  return Math.max(0, Math.min(last, dayNumber(state.day) - dayNumber(first)));
}

function selectedKey(vm: HistoryVM, state: HistoryState): string {
  return (vm.days[selectedIndex(vm, state)] as HistoryDay).key;
}

/** The key of the period of `kind` holding `day`: a Monday for a week, YYYY-MM for a month. */
function holding(kind: Group, day: string): string {
  if (kind === "week") return keyOf(dayNumber(day) - weekday(day));
  if (kind === "month") return day.slice(0, 7);
  return day;
}

// ── what the table lists ─────────────────────────────────────────────────────────

export interface Listing {
  /** What each row is: days when one week or month is open. */
  readonly kind: Group;
  /** Newest first, filtered. */
  readonly rows: readonly HistoryPeriod[];
  /** The open week or month (null when none is, or it is older than the heat map). */
  readonly parent: HistoryPeriod | null;
  /** The open week's Monday or month's YYYY-MM. */
  readonly parentKey: string | null;
}

function matches(p: HistoryPeriod, filter: string): boolean {
  if (filter === "") return true;
  const f = filter.toLowerCase();
  const has = (s: HistoryShare) => s.name.toLowerCase().includes(f);
  return p.models.some(has) || p.accounts.some(has);
}

export function listing(vm: HistoryVM, state: HistoryState): Listing {
  const { open } = state;
  let rows: readonly HistoryPeriod[];
  let parent: HistoryPeriod | null = null;
  let parentKey: string | null = null;
  if (open !== null) {
    const key = holding(open, selectedKey(vm, state));
    parentKey = key;
    rows = vm.days.filter((d) => holding(open, d.key) === key);
    parent = (open === "week" ? vm.weeks : vm.months).find((p) => p.key === key) ?? null;
  } else if (state.group === "day") {
    rows = vm.days.slice(vm.gridStart);
  } else {
    rows = state.group === "week" ? vm.weeks : vm.months;
  }
  return {
    kind: open === null ? state.group : "day",
    rows: rows.filter((p) => matches(p, state.filter)).reverse(),
    parent,
    parentKey,
  };
}

/** The listed row holding the selected day, or -1 (filtered out). */
export function selectedRow(vm: HistoryVM, state: HistoryState, list: Listing): number {
  const key = holding(list.kind, selectedKey(vm, state));
  return list.rows.findIndex((p) => p.key === key);
}

/**
 * The day to select in `row` coming from `from`: the same weekday of a week, the same day
 * of a month (or its last), never after today.
 */
function dayIn(vm: HistoryVM, kind: Group, row: HistoryPeriod, from: string): string {
  let day = row.key;
  if (kind === "week") day = keyOf(dayNumber(row.key) + weekday(from));
  if (kind === "month") {
    const [y, m] = row.key.split("-").map(Number) as [number, number];
    const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
    day = `${row.key}-${String(Math.min(Number(from.slice(8, 10)), length)).padStart(2, "0")}`;
  }
  return day > today(vm) ? today(vm) : day;
}

/** Selects listed row `to` (clamped to the rows). */
function selectRow(vm: HistoryVM, state: HistoryState, to: number): HistoryState {
  const list = listing(vm, state);
  if (list.rows.length === 0) return state;
  const row = list.rows[Math.max(0, Math.min(list.rows.length - 1, to))] as HistoryPeriod;
  return { ...state, day: dayIn(vm, list.kind, row, selectedKey(vm, state)) };
}

/** Once a filter is applied, a selection it hides moves to the first row shown. */
function snap(vm: HistoryVM, state: HistoryState): HistoryState {
  return selectedRow(vm, state, listing(vm, state)) >= 0 ? state : selectRow(vm, state, 0);
}

// ── keys ─────────────────────────────────────────────────────────────────────────

function typed(
  key: string,
  state: HistoryState,
  vm: HistoryVM | undefined,
): HistoryState | undefined {
  if (key === "escape") return { ...state, typing: false, filter: "" };
  if (key === "return" || key === "enter") {
    const done = { ...state, typing: false };
    return vm === undefined ? done : snap(vm, done);
  }
  if (key === "backspace") return { ...state, filter: [...state.filter].slice(0, -1).join("") };
  const ch = key === "space" ? " " : key;
  if ([...ch].length !== 1 || [...state.filter].length >= MAX_FILTER) return undefined;
  return { ...state, filter: state.filter + ch };
}

/** W and M: the days of this week or this month, keeping the selection if it is in them. */
function openCurrent(vm: HistoryVM, state: HistoryState, open: "week" | "month"): HistoryState {
  const keep = holding(open, selectedKey(vm, state)) === holding(open, today(vm));
  return { ...state, open, day: keep ? state.day : null };
}

function move(key: string, state: HistoryState, vm: HistoryVM): HistoryState | undefined {
  if (state.focus === "heat") {
    // Rows are weekdays and columns weeks: ↑/↓ a day, ←/→ a week, within the heat map.
    const step = { up: -1, down: 1, left: -7, right: 7 }[key];
    if (step === undefined) return undefined;
    const last = vm.days.length - 1;
    const at = Math.max(vm.gridStart, Math.min(last, selectedIndex(vm, state) + step));
    return { ...state, day: (vm.days[at] as HistoryDay).key };
  }
  const list = listing(vm, state);
  const at = selectedRow(vm, state, list);
  // With the selected day filtered out, any move starts at the first row.
  const to = {
    up: at - 1,
    down: at + 1,
    pageup: at - PAGE,
    pagedown: at + PAGE,
    home: 0,
    end: list.rows.length - 1,
  }[key];
  if (to === undefined) return undefined;
  return selectRow(vm, state, at < 0 ? 0 : to);
}

// ── the heat map and the day card ────────────────────────────────────────────────

/** Month names over the week columns where a month starts (T10's placement). */
function monthLabels(mondays: readonly string[]): MonthLabel[] {
  const out: MonthLabel[] = [];
  let last = "";
  mondays.forEach((key, w) => {
    const month = key.slice(5, 7);
    if (month === last) return;
    // The first column gets its month only if the month starts in it.
    if (last !== "" || Number(key.slice(8)) <= 7) {
      out.push({ week: w, text: monthName(Number(month)) });
    }
    last = month;
  });
  return out;
}

/** `5-HOUR` → `5h`, `FABLE WEEKLY` → `fable weekly`. */
function windowName(label: string): string {
  return label
    .toLowerCase()
    .replace(/(\d+)-(min|hour|day|week)\b/, (_, n: string, unit: string) => `${n}${unit[0]}`);
}

/**
 * gen.py: `personal 5h hit 100% at 15:42 (waited 1h18m)`; the wait goes on a second line
 * when the whole doesn't fit `width`.
 */
function eventLines(e: HistoryEvent, tz: string, width: number): Seg[][] {
  const what = `${e.account} ${windowName(e.window)}`;
  const at = clock(e.at, tz);
  if (e.kind === "passed_80") return [[seg(`${what} passed 80% at ${at}`, "mid")]];
  const hit = `${what} hit 100% at ${at}`;
  if (e.resumedAt === null) return [[seg(hit, "high")]];
  const waited = `waited ${countdown(e.resumedAt - e.at)}`;
  const whole = `${hit} (${waited})`;
  return textWidth(whole) <= width
    ? [[seg(whole, "high")]]
    : [[seg(hit, "high")], [seg(waited, "high")]];
}

/** The first of `shapes` that fits `width` cells, else the last. */
function firstFit(shapes: readonly Seg[][], width: number): Seg[] {
  return shapes.find((s) => segsWidth(s) <= width) ?? (shapes[shapes.length - 1] as Seg[]);
}

/** `a 74% · b 15% · +2`: as many whole entries as fit `width`. */
function entries(texts: readonly string[], width: number): string {
  for (let n = texts.length; n > 0; n--) {
    const more = n < texts.length ? ` · +${texts.length - n}` : "";
    const text = texts.slice(0, n).join(" · ") + more;
    if (textWidth(text) <= width) return text;
  }
  return texts.length === 0 ? "—" : `+${texts.length}`;
}

/**
 * Shares most first by what is shown: the view model ranks them by cost, so with costs
 * hidden they are re-ranked by tokens.
 */
function ranked(shares: readonly HistoryShare[], showCost: boolean): readonly HistoryShare[] {
  return showCost ? shares : [...shares].sort((a, b) => b.tokens - a.tokens);
}

/** A period's cost (tokens with costs hidden) over the daily average times its days. */
function ratioOf(p: HistoryPeriod, vm: HistoryVM, showCost: boolean): number | null {
  const base = (showCost ? vm.average.cost : vm.average.tokens) * p.days;
  return base > 0 ? (showCost ? p.cost : p.tokens) / base : null;
}

function ratioText(r: number): string {
  return r < 9.95 ? `${r.toFixed(1)}×` : `${Math.round(r)}×`;
}

function cardLines(
  vm: HistoryVM,
  day: HistoryDay,
  state: HistoryState,
  ctx: ViewContext,
  width: number,
  rows: number,
): Line[] {
  const label = (text: string) => seg(text.padEnd(LABEL), "mute");
  const ratio = ratioOf(day, vm, ctx.showCost);
  const vs = (words: string): Seg[] =>
    ratio === null ? [] : [seg(`   ${ratioText(ratio)} ${words}`, "dim")];
  const split = `in ${tokens(day.input)} · out ${tokens(day.output)} · cache ${tokens(day.cache)}`;
  const lines: Line[] = [];
  if (ctx.showCost) {
    const c = costText(day);
    const cost = [label("cost"), seg(c.text, c.role, c.role === "cost")];
    lines.push({
      left: firstFit([[...cost, ...vs("your 30-day avg")], [...cost, ...vs("avg")], cost], width),
    });
    const count = [label("tokens"), seg(tokens(day.tokens), "tokens")];
    lines.push({ left: firstFit([[...count, seg(`  ${split}`, "dim")], count], width) });
  } else {
    const count = [label("tokens"), seg(tokens(day.tokens), "tokens", true)];
    lines.push({
      left: firstFit(
        [[...count, ...vs("your 30-day avg")], [...count, ...vs("avg")], count],
        width,
      ),
    });
    lines.push({ left: firstFit([[label(""), seg(split, "dim")], []], width) });
  }
  const all = ctx.showCost ? day.cost : day.tokens;
  const percent = (s: HistoryShare) =>
    `${all > 0 ? Math.round(((ctx.showCost ? s.cost : s.tokens) / all) * 100) : 0}%`;
  const models = ranked(day.models, ctx.showCost)
    .slice(0, 3)
    .map((m) => `${m.name} ${percent(m)}`);
  lines.push({ left: [label("models"), seg(entries(models, width - LABEL), "fg")] });
  const accounts = ranked(day.accounts, ctx.showCost).map(
    (a) => `${a.name} ${ctx.showCost ? costText(a).text : tokens(a.tokens)}`,
  );
  lines.push({ left: [label("accounts"), seg(entries(accounts, width - LABEL), "fg")] });
  // Limit events take the rows left (a "+N more" line if not all fit), then the key hint.
  const room = rows - lines.length;
  const events = day.events.map((e) => eventLines(e, ctx.tz, width - LABEL));
  let shown = events.length;
  const height = (n: number) =>
    events.slice(0, n).reduce((h, e) => h + e.length, 0) + (n < events.length ? 1 : 0);
  while (shown > 0 && height(shown) > room) shown--;
  const body = events.slice(0, shown).flat();
  if (shown < events.length) body.push([seg(`+${events.length - shown} more`, "high")]);
  if (body.length === 0) body.push([seg("none", "dim")]);
  body.forEach((segs, i) => {
    lines.push({ left: [label(i === 0 ? "limits" : ""), ...segs] });
  });
  const hint =
    state.focus === "heat"
      ? "tab table · ←/→ week · ↑/↓ day"
      : "tab heat map · ↑/↓ row · enter open";
  if (lines.length < rows) lines.push({ left: [seg(hint, "dim")] });
  return lines.slice(0, rows);
}

function dayCard(
  vm: HistoryVM,
  state: HistoryState,
  ctx: ViewContext,
  width: number,
  height: number,
) {
  const day = vm.days[selectedIndex(vm, state)] as HistoryDay;
  const title = `${dayLabel(day.key)}${day.key === today(vm) ? " · today" : ""}`;
  return (
    <th-card
      title={title}
      theme={ctx.theme}
      width={width}
      height={height}
      flexShrink={0}
      flexDirection="column"
    >
      <Lines theme={ctx.theme} lines={cardLines(vm, day, state, ctx, width - 4, height - 2)} />
    </th-card>
  );
}

/** The 26 weeks, or the most recent that fit, moved back as far as the selection is. */
function heatWindow(vm: HistoryVM, selected: number, width: number) {
  const weeks = vm.weeks.length;
  const shown = Math.max(1, Math.min(weeks, Math.floor((width - GUTTER) / 2)));
  const week = selected >= vm.gridStart ? Math.floor((selected - vm.gridStart) / 7) : -1;
  const end = week >= 0 && week < weeks - shown ? week + shown : weeks;
  return { first: end - shown, end, shown };
}

function heatSection(vm: HistoryVM, state: HistoryState, ctx: ViewContext): Section {
  const selected = selectedIndex(vm, state);
  const gridWidth = Math.min(GUTTER + vm.weeks.length * 2, ctx.width);
  const { first, end, shown } = heatWindow(vm, selected, gridWidth);
  const values: (number | null)[] = [];
  for (let i = vm.gridStart + first * 7; i < vm.gridStart + end * 7; i++) {
    const d = vm.days[i];
    values.push(d === undefined ? null : ctx.showCost ? d.cost : d.tokens);
  }
  const at = selected - vm.gridStart - first * 7;
  const mondays = vm.weeks.slice(first, end).map((w) => w.key);
  const span =
    end === vm.weeks.length
      ? `LAST ${shown} WEEKS`
      : `${shown} WEEKS TO ${shortDate(keyOf(dayNumber(mondays[mondays.length - 1] as string) + 6)).toUpperCase()}`;
  const focused = state.focus === "heat";
  const left = [
    seg(` ${span} · daily ${ctx.showCost ? "cost" : "tokens"}`, focused ? "head" : "mute", focused),
  ];
  const legend = [seg("less ", "dim"), ...HEAT_ROLES.map((r) => seg("■ ", r)), seg("more ", "dim")];
  const title: Line =
    segsWidth(left) + 1 + segsWidth(legend) <= gridWidth ? { left, right: legend } : { left };
  const beside = ctx.bp !== "narrow";
  return {
    id: "heat",
    priority: 2,
    height: HEAT_HEIGHT,
    render: (height) => (
      <box flexDirection="row" height={height} flexShrink={0} columnGap={2}>
        <box flexDirection="column" width={gridWidth} height={height} flexShrink={0}>
          <Lines theme={ctx.theme} lines={[title]} width={gridWidth} />
          <th-heat
            values={values}
            weeks={shown}
            selected={at >= 0 && at < values.length ? at : -1}
            months={monthLabels(mondays)}
            theme={ctx.theme}
            width={gridWidth}
            height={height - 1}
            flexShrink={0}
          />
        </box>
        {beside && dayCard(vm, state, ctx, Math.min(CARD_MAX, ctx.width - gridWidth - 2), height)}
      </box>
    ),
  };
}

/** Narrow screens: the day card under the heat map. */
function cardSection(vm: HistoryVM, state: HistoryState, ctx: ViewContext): Section {
  return {
    id: "card",
    priority: 3,
    height: HEAT_HEIGHT,
    render: (height) => (
      <box flexDirection="row" height={height} flexShrink={0} paddingLeft={1}>
        {dayCard(vm, state, ctx, Math.min(CARD_MAX, ctx.width - 2), height)}
      </box>
    ),
  };
}

// ── the table ────────────────────────────────────────────────────────────────────

/** A table row: a listed period, or the totals (which name no period). */
type Row = HistoryPeriod | HistoryTotal;

function periodLabel(kind: Group, key: string): string {
  if (kind === "week") return weekLabel(key);
  if (kind === "month") return monthLabel(key);
  return dayLabel(key);
}

/** The sum of `rows`: the totals row of a filtered table. */
function sum(rows: readonly HistoryTotal[]): HistoryTotal {
  let cost = 0;
  let count = 0;
  let priced = 0;
  let estimatedCost = 0;
  let input = 0;
  let output = 0;
  let cache = 0;
  for (const r of rows) {
    cost += r.cost;
    count += r.tokens;
    priced += r.pricedShare * r.tokens;
    estimatedCost += r.estimatedCost;
    input += r.input;
    output += r.output;
    cache += r.cache;
  }
  const pricedShare = count > 0 ? priced / count : 1;
  return { cost, tokens: count, pricedShare, estimatedCost, input, output, cache };
}

/**
 * The table's columns. Cells are worked out only for the rows on screen (the table asks
 * for them), so a 182-day table costs no more to draw than the rows it shows.
 */
function columns(
  vm: HistoryVM,
  list: Listing,
  ctx: ViewContext,
  selected: Row | undefined,
  totals: { readonly row: Row; readonly label: string },
): Column<Row>[] {
  const period = (r: Row) => (r === totals.row ? null : (r as HistoryPeriod));
  const ratio = (r: Row) => {
    const p = period(r);
    return p === null ? null : ratioOf(p, vm, ctx.showCost);
  };
  const amount = (r: Row) =>
    ctx.showCost ? costText(r) : { text: tokens(r.tokens), role: "tokens" as Role };
  const right = { align: "right" as const, role: "tokens" as Role };
  return [
    {
      title: list.kind === "day" ? "date" : list.kind,
      width: 10,
      role: (r) => (r === selected ? "head" : r === totals.row ? "mute" : "fg"),
      bold: (r) => r === selected,
      text: (r) =>
        period(r) === null ? totals.label : periodLabel(list.kind, (r as HistoryPeriod).key),
    },
    { title: "input", width: 7, ...right, text: (r) => tokens(r.input), drop: 4 },
    { title: "output", width: 7, ...right, text: (r) => tokens(r.output), drop: 5 },
    { title: "cache", width: 8, ...right, text: (r) => tokens(r.cache), drop: 6 },
    {
      title: ctx.showCost ? "cost" : "tokens",
      width: ctx.showCost ? 11 : 8,
      align: "right",
      role: (r) => amount(r).role,
      bold: (r) => ctx.showCost && amount(r).role === "cost",
      text: (r) => amount(r).text,
    },
    {
      title: "vs 30-day avg",
      width: BAR_WIDTH,
      role: (r) => ((ratio(r) ?? 0) > BAR_HIGH ? "high" : ctx.showCost ? "cost" : "tokens"),
      bar: (r) => Math.min(1, (ratio(r) ?? 0) / BAR_FULL),
      drop: 3,
    },
    {
      title: "",
      width: 5,
      align: "right",
      role: "mute",
      text: (r) => {
        const x = ratio(r);
        return x === null ? "" : ratioText(x);
      },
      drop: 2,
    },
    {
      title: "top model",
      width: 9,
      role: "fg",
      text: (r) => ranked(period(r)?.models ?? [], ctx.showCost)[0]?.name ?? "",
      drop: 7,
    },
    {
      title: "accounts",
      width: "fill",
      role: "mute",
      text: (r) =>
        ranked(period(r)?.accounts ?? [], ctx.showCost)
          .map((a) => a.name)
          .join(", "),
      drop: 8,
    },
  ];
}

function tabsLine(
  vm: HistoryVM,
  state: HistoryState,
  list: Listing,
  rows: readonly HistoryTotal[],
  ctx: ViewContext,
): Line {
  if (state.typing) {
    return {
      left: [seg(" filter ", "dim"), seg(`${state.filter}▏`, "head", true)],
      right: [seg("model or account · enter apply · esc clear ", "dim")],
    };
  }
  const current = state.open !== null && list.parentKey === holding(state.open, today(vm));
  const active = state.open === null ? state.group : current ? `this ${state.open}` : state.open;
  const tabs: Seg[] = [seg(" ", "fg")];
  for (const [id, name] of [
    ["day", "Day"],
    ["week", "Week"],
    ["month", "Month"],
    ["this week", "This week"],
    ["this month", "This month"],
  ] as const) {
    if (id === "this week") tabs.push(seg("  ", "fg"));
    tabs.push(id === active ? seg(` ${name} `, "head", true, "tab") : seg(` ${name} `, "mute"));
    tabs.push(seg(" ", "fg"));
  }
  if (state.open !== null && !current && list.parentKey !== null) {
    tabs.push(seg(` › ${periodLabel(state.open, list.parentKey)}`, "head", true));
  }
  const filter =
    state.filter === ""
      ? [seg("/ ", "head", true), seg("filter ", "dim")]
      : [seg("filter ", "dim"), seg(state.filter, "head", true), seg(" · esc clear ", "dim")];
  const note = ctx.showCost ? costNote(rows) : null;
  const room = ctx.width - segsWidth(tabs) - 1;
  const right =
    note !== null && textWidth(`${note} · `) + segsWidth(filter) <= room
      ? [seg(`${note} · `, "dim"), ...filter]
      : segsWidth(filter) <= room
        ? filter
        : [];
  return { left: tabs, right };
}

function tableSection(vm: HistoryVM, state: HistoryState, ctx: ViewContext): Section {
  const list = listing(vm, state);
  const selected = selectedRow(vm, state, list);
  const { rows } = list;
  const whole =
    state.filter !== ""
      ? null
      : state.open !== null
        ? list.parent
        : state.group === "month"
          ? vm.monthsTotal
          : vm.weeksTotal;
  const n = rows.length;
  const totals = {
    // A copy: the open period's own object must not double as its totals row.
    row: { ...(whole ?? sum(rows)) },
    label: `${n} ${list.kind}${n === 1 ? "" : "s"}`,
  };
  const head = tabsLine(vm, state, list, rows, ctx);
  return {
    id: "table",
    priority: 1,
    height: 1 + 1 + n + 2,
    minHeight: 1 + 1 + Math.min(3, n) + 2,
    render: (height) => (
      <box flexDirection="column" height={height} flexShrink={0}>
        <Lines theme={ctx.theme} lines={[head]} />
        <Table
          columns={columns(vm, list, ctx, rows[selected], totals)}
          rows={rows}
          selected={selected}
          totals={totals.row}
          theme={ctx.theme}
          height={height - 1}
          width={ctx.width - 1}
          marginLeft={1}
        />
      </box>
    ),
  };
}

export const history: View<HistoryVM, HistoryState> = {
  id: "history",
  title: "History",
  hints: [
    { key: "d/w/m", label: "group" },
    { key: "/", label: "filter" },
    { key: "W/M", label: "this week/month" },
    { key: "tab", label: "heat map/table" },
    { key: "enter", label: "open" },
    { key: "esc", label: "back" },
  ],
  initial: { focus: "heat", group: "day", open: null, day: null, filter: "", typing: false },
  capturing: (state) => state.typing,
  keys(key, state, vm) {
    if (state.typing) return typed(key, state, vm);
    if (vm === undefined) return undefined;
    if (key === "tab") return { ...state, focus: state.focus === "heat" ? "table" : "heat" };
    const group = GROUP_KEYS[key];
    if (group !== undefined) return { ...state, group, open: null };
    if (key === "W") return openCurrent(vm, state, "week");
    if (key === "M") return openCurrent(vm, state, "month");
    if (key === "/") return { ...state, typing: true };
    if (key === "return" || key === "enter") {
      const list = listing(vm, state);
      if (list.kind === "day" || selectedRow(vm, state, list) < 0) return undefined;
      return { ...state, open: list.kind };
    }
    if (key === "escape") {
      if (state.open !== null) return { ...state, open: null };
      return state.filter === "" ? undefined : { ...state, filter: "" };
    }
    return move(key, state, vm);
  },
  sections(vm, state, ctx) {
    const sections = [heatSection(vm, state, ctx), tableSection(vm, state, ctx)];
    if (ctx.bp === "narrow") sections.splice(1, 0, cardSection(vm, state, ctx));
    return sections;
  },
};
