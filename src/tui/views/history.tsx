// History, "calendar + table" (gen.py `history_a()`, without its Project and Session tabs):
// a 26-week heat map of daily cost, the selected day's detail card, and a table by day,
// week or month with "this week" (from Monday) and "this month" (from the 1st) filters.
//
// One selection drives both halves: the selected day. The heat map's cursor is that day,
// and the table's selected row is the row holding it, so moving either moves the other.
// `/` filters by model: every number on screen is then that model's (rows without it go).
// Everything here picks from the view model; nothing queries (ARCHITECTURE §9).
import { type Line, type Seg, seg, segsWidth } from "../components/base.ts";
import type { Column, MonthLabel } from "../components/index.ts";
import { Lines, Table } from "../elements.tsx";
import { clock, countdown, dayLabel, monthName, textWidth, tokens, truncate } from "../format.ts";
import { sectionLine } from "../frame.ts";
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
  /** Only the models whose id contains this, ignoring case; "" for all. */
  readonly filter: string;
  /** The filter is being typed: every key goes to it. */
  readonly typing: boolean;
  /** The selected day's limit events are listed in place of the table (Enter on a day). */
  readonly events: boolean;
}

const GUTTER = 5;
/** The heat map (title, months, 7 days) and the day card are each this tall, at least. */
const HEAT_HEIGHT = 9;
const CARD_MAX = 80;
/** The "vs average" bar is full at this ratio, so 1× is 8 of its 18 cells (gen.py). */
const BAR_FULL = 2.25;
const BAR_WIDTH = 18;
/** Above this ratio the bar turns `high`. */
const BAR_HIGH = 1.5;
const PAGE = 10;
const MAX_FILTER = 32;
const LABEL = 9;
/** The table's least height (tabs, header, 3 rows, rule, totals): the card leaves it. */
const TABLE_LEAST = 7;
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

// ── the model filter ─────────────────────────────────────────────────────────────

/** The sum of `parts`, with the share of priced tokens weighted by tokens. */
function sum(parts: readonly HistoryTotal[]): HistoryTotal {
  let cost = 0;
  let count = 0;
  let priced = 0;
  let estimatedCost = 0;
  let input = 0;
  let output = 0;
  let cache = 0;
  for (const p of parts) {
    cost += p.cost;
    count += p.tokens;
    priced += p.pricedShare * p.tokens;
    estimatedCost += p.estimatedCost;
    input += p.input;
    output += p.output;
    cache += p.cache;
  }
  const pricedShare = count > 0 ? priced / count : 1;
  return { cost, tokens: count, pricedShare, estimatedCost, input, output, cache };
}

const slices = new WeakMap<HistoryPeriod, { filter: string; slice: HistoryPeriod }>();

/**
 * The period counting only the models whose id contains `filter`: their cost and tokens,
 * no accounts (the view model has no account split per model). The whole period when
 * there is no filter.
 */
function slice<P extends HistoryPeriod>(p: P, filter: string): P {
  if (filter === "") return p;
  const cached = slices.get(p);
  if (cached?.filter === filter) return cached.slice as P;
  const f = filter.toLowerCase();
  const models = p.models.filter((m) => m.name.toLowerCase().includes(f));
  const out = { ...p, ...sum(models), models, accounts: [] };
  slices.set(p, { filter, slice: out });
  return out;
}

const averages = new WeakMap<HistoryVM, { filter: string; average: HistoryVM["average"] }>();

/** The ratios' baseline: the view model's, or the filtered models' over the same days. */
function baseline(vm: HistoryVM, filter: string): HistoryVM["average"] {
  if (filter === "" || vm.averageDays === 0) return vm.average;
  const cached = averages.get(vm);
  if (cached?.filter === filter) return cached.average;
  const last = vm.days.length - 1;
  const total = sum(vm.days.slice(last - vm.averageDays, last).map((d) => slice(d, filter)));
  const average = { cost: total.cost / vm.averageDays, tokens: total.tokens / vm.averageDays };
  averages.set(vm, { filter, average });
  return average;
}

// ── what the table lists ─────────────────────────────────────────────────────────

export interface Listing {
  /** What each row is: days when one week or month is open. */
  readonly kind: Group;
  /** Newest first; with a filter, the filtered models' part of the periods using them. */
  readonly rows: readonly HistoryPeriod[];
  /** The open week or month (null when none is, or it is older than the heat map). */
  readonly parent: HistoryPeriod | null;
  /** The open week's Monday or month's YYYY-MM. */
  readonly parentKey: string | null;
}

export function listing(vm: HistoryVM, state: HistoryState): Listing {
  const { open, filter } = state;
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
  const shown =
    filter === ""
      ? [...rows]
      : rows.map((p) => slice(p, filter)).filter((p) => p.models.length > 0);
  return {
    kind: open === null ? state.group : "day",
    rows: shown.reverse(),
    parent: parent === null ? null : slice(parent, filter),
    parentKey,
  };
}

/** The listed row holding the selected day, or -1 (filtered out, or before the heat map). */
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

/**
 * Keeps one side highlighted (critique m4): a day older than the heat map that no listed
 * row holds (left after closing the oldest month) moves to the heat map's first day.
 */
function settle(vm: HistoryVM, state: HistoryState): HistoryState {
  if (selectedIndex(vm, state) >= vm.gridStart) return state;
  if (selectedRow(vm, state, listing(vm, state)) >= 0) return state;
  return { ...state, day: (vm.days[vm.gridStart] as HistoryDay).key };
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
  // With no row holding the selected day (it's filtered out), moves start from where it
  // would be: ↓ goes to the next older row, ↑ to the next newer one.
  const key0 = holding(list.kind, selectedKey(vm, state));
  const older = list.rows.findIndex((p) => p.key < key0);
  const from = at >= 0 ? at : older < 0 ? list.rows.length : older;
  const to = {
    up: from - 1,
    down: at >= 0 ? from + 1 : from,
    pageup: from - PAGE,
    pagedown: at >= 0 ? from + PAGE : from + PAGE - 1,
    home: 0,
    end: list.rows.length - 1,
  }[key];
  return to === undefined ? undefined : selectRow(vm, state, to);
}

// ── the heat map and the day card ────────────────────────────────────────────────

/**
 * Month names over the week columns holding a month's 1st (Dec over the week of Tue Dec 1),
 * and over the first column for its month when the next name leaves room.
 */
function monthLabels(mondays: readonly string[]): MonthLabel[] {
  const out: MonthLabel[] = [];
  mondays.forEach((monday, w) => {
    const sunday = keyOf(dayNumber(monday) + 6);
    if (monday.slice(8) === "01")
      out.push({ week: w, text: monthName(Number(monday.slice(5, 7))) });
    else if (sunday.slice(5, 7) !== monday.slice(5, 7)) {
      out.push({ week: w, text: monthName(Number(sunday.slice(5, 7))) });
    }
  });
  const first = mondays[0];
  if (first !== undefined && (out[0]?.week ?? mondays.length) >= 2) {
    out.unshift({ week: 0, text: monthName(Number(first.slice(5, 7))) });
  }
  return out;
}

/** `5-HOUR` → `5h`, `FABLE WEEKLY` → `fable weekly`. */
function windowName(label: string): string {
  return label
    .toLowerCase()
    .replace(/(\d+)-(min|hour|day|week)\b/, (_, n: string, unit: string) => `${n}${unit[0]}`);
}

/** `text` cut to `width` with `…`, never leaving a space before the `…`. */
function cut(text: string, width: number): string {
  return truncate(text, width).replace(/\s+…$/, "…");
}

/** `account window` in `room` cells: the account is cut first, then the window, with `…`. */
function eventLabel(account: string, window: string, room: number): string {
  const whole = `${account} ${window}`;
  if (textWidth(whole) <= room) return whole;
  const keep = room - textWidth(window) - 1;
  if (keep >= 4) return `${cut(account, keep)} ${window}`;
  const short = cut(account, Math.min(textWidth(account), 4));
  return `${short} ${cut(window, room - textWidth(short) - 1)}`;
}

/**
 * gen.py: `personal 5h hit 100% at 15:42 (waited 1h18m)`. Its time is never cut
 * (critique M2): the account and window give way first, and the wait goes on a second
 * line when the whole doesn't fit `width`.
 */
function eventLines(e: HistoryEvent, tz: string, width: number): Seg[][] {
  const reached = e.kind === "reached";
  const what = `${reached ? "hit 100%" : "passed 80%"} at ${clock(e.at, tz)}`;
  const role: Role = reached ? "high" : "mid";
  const waited = reached && e.resumedAt !== null ? `waited ${countdown(e.resumedAt - e.at)}` : null;
  const name = windowName(e.window);
  const whole = `${e.account} ${name} ${what}${waited === null ? "" : ` (${waited})`}`;
  if (textWidth(whole) <= width) return [[seg(whole, role)]];
  const head = `${eventLabel(e.account, name, width - textWidth(what) - 1)} ${what}`;
  return waited === null ? [[seg(head, role)]] : [[seg(head, role)], [seg(waited, role)]];
}

/** Hits first (critique m1), then 80 % marks, each oldest first. */
function byImportance(events: readonly HistoryEvent[]): HistoryEvent[] {
  const rank = (e: HistoryEvent) => (e.kind === "reached" ? 0 : 1);
  return [...events].sort((a, b) => rank(a) - rank(b) || a.at - b.at);
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

/** A period's cost (tokens with costs hidden) over the daily baseline times its days. */
function ratioOf(
  p: HistoryPeriod,
  average: HistoryVM["average"],
  showCost: boolean,
): number | null {
  const base = (showCost ? average.cost : average.tokens) * p.days;
  return base > 0 ? (showCost ? p.cost : p.tokens) / base : null;
}

function ratioText(r: number): string {
  return r < 9.95 ? `${r.toFixed(1)}×` : `${Math.round(r)}×`;
}

/** The card's lines before the limit events: 4, or 3 with a filter (no account split). */
function cardHead(
  vm: HistoryVM,
  day: HistoryDay,
  state: HistoryState,
  ctx: ViewContext,
  width: number,
): Line[] {
  const label = (text: string) => seg(text.padEnd(LABEL), "mute");
  const ratio = ratioOf(day, baseline(vm, state.filter), ctx.showCost);
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
  if (state.filter === "") {
    const accounts = ranked(day.accounts, ctx.showCost).map(
      (a) => `${a.name} ${ctx.showCost ? costText(a).text : tokens(a.tokens)}`,
    );
    lines.push({ left: [label("accounts"), seg(entries(accounts, width - LABEL), "fg")] });
  }
  return lines;
}

/** The selected day as the card shows it: with a filter, the filtered models' part. */
function selectedDay(vm: HistoryVM, state: HistoryState): HistoryDay {
  return slice(vm.days[selectedIndex(vm, state)] as HistoryDay, state.filter);
}

/** Rows the card needs to show every hit of the day (critique m1), at least the heat map's. */
function cardHeight(vm: HistoryVM, state: HistoryState, ctx: ViewContext, width: number): number {
  const day = selectedDay(vm, state);
  const inner = width - 4;
  const head = cardHead(vm, day, state, ctx, inner).length;
  const events = byImportance(day.events);
  const hits = events.filter((e) => e.kind === "reached");
  const lines = hits.reduce((n, e) => n + eventLines(e, ctx.tz, inner - LABEL).length, 0);
  const marks = events.length > hits.length ? 1 : 0;
  return Math.max(HEAT_HEIGHT, 2 + head + Math.max(1, lines + marks));
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
  const lines = cardHead(vm, day, state, ctx, width);
  // Limit events take the rows left, hits first; 80 % marks that don't fit become
  // "+N more". Hits that don't all fit become one line counting them, listed by Enter.
  const room = rows - lines.length;
  const events = byImportance(day.events).map((e) => eventLines(e, ctx.tz, width - LABEL));
  const hits = day.events.filter((e) => e.kind === "reached").length;
  let shown = events.length;
  const height = (n: number) =>
    events.slice(0, n).reduce((h, e) => h + e.length, 0) + (n < events.length ? 1 : 0);
  while (shown > 0 && height(shown) > room) shown--;
  let body = events.slice(0, shown).flat();
  if (shown < events.length) body.push([seg(`+${events.length - shown} more`, "high")]);
  if (shown < hits) {
    const count = limitCount(day);
    const hitsOnly = limitCount(day, false);
    const shapes = [
      `${count} · enter lists them`,
      `${hitsOnly} · enter lists them`,
      count,
      hitsOnly,
    ];
    body = [[seg(shapes.find((t) => textWidth(t) <= width - LABEL) ?? count, "high")]];
  }
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

function cardTitle(vm: HistoryVM, day: HistoryDay, state: HistoryState): string {
  const when = `${dayLabel(day.key)}${day.key === today(vm) ? " · today" : ""}`;
  return state.filter === "" ? when : `${when} · filter: ${state.filter}`;
}

function dayCard(
  vm: HistoryVM,
  state: HistoryState,
  ctx: ViewContext,
  width: number,
  height: number,
) {
  const day = selectedDay(vm, state);
  return (
    <th-card
      title={cardTitle(vm, day, state)}
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

/** `4 limit hits · 2 at 80%` (without the marks when `marks` is false); "" with none. */
function limitCount(day: HistoryDay, marks = true): string {
  const hits = day.events.filter((e) => e.kind === "reached").length;
  const at80 = day.events.length - hits;
  return [
    ...(hits > 0 ? [`${hits} limit hit${hits === 1 ? "" : "s"}`] : []),
    ...(marks && at80 > 0 ? [`${at80} at 80%`] : []),
  ].join(" · ");
}

/**
 * The day card in one line, for screens too short for the card (critique m3): date,
 * cost, ratio, tokens, top model and limit events, dropping from the end to fit.
 */
function summaryLine(vm: HistoryVM, state: HistoryState, ctx: ViewContext): Line {
  const day = selectedDay(vm, state);
  const ratio = ratioOf(day, baseline(vm, state.filter), ctx.showCost);
  const c = costText(day);
  const limits = limitCount(day);
  const parts: Seg[][] = [
    [seg(` ${cardTitle(vm, day, state)}`, "head", true)],
    ctx.showCost ? [seg(`  ${c.text}`, c.role, c.role === "cost")] : [],
    ratio === null ? [] : [seg(`  ${ratioText(ratio)} avg`, "dim")],
    [seg(`  ${tokens(day.tokens)} tokens`, "tokens")],
    limits === "" ? [] : [seg(`  ${limits}`, "high")],
    limits === "" ? [] : [seg("  enter lists them", "dim")],
    [seg(`  ${ranked(day.models, ctx.showCost)[0]?.name ?? "—"}`, "fg")],
  ];
  // Least important last: the top model goes first, then tokens, the hint and the ratio.
  const drop = [6, 3, 5, 2];
  const shapes: Seg[][] = [parts.flat()];
  const kept = [...parts];
  for (const i of drop) {
    kept[i] = [];
    shapes.push(kept.flat());
  }
  return { left: firstFit(shapes, ctx.width - 1) };
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
  // One cell past the last week, so a month name can start over it.
  const gridWidth = Math.min(GUTTER + vm.weeks.length * 2 + 1, ctx.width);
  const { first, end, shown } = heatWindow(vm, selected, gridWidth);
  const values: (number | null)[] = [];
  for (let i = vm.gridStart + first * 7; i < vm.gridStart + end * 7; i++) {
    const d = vm.days[i];
    const p = d === undefined ? null : slice(d, state.filter);
    values.push(p === null ? null : ctx.showCost ? p.cost : p.tokens);
  }
  const at = selected - vm.gridStart - first * 7;
  const mondays = vm.weeks.slice(first, end).map((w) => w.key);
  const span =
    end === vm.weeks.length
      ? `LAST ${shown} WEEKS`
      : `${shown} WEEKS TO ${shortDate(keyOf(dayNumber(mondays[mondays.length - 1] as string) + 6)).toUpperCase()}`;
  const focused = state.focus === "heat";
  const what = `daily ${ctx.showCost ? "cost" : "tokens"}`;
  const left = [
    seg(
      ` ${span} · ${what}${state.filter === "" ? "" : ` · filter: ${state.filter}`}`,
      focused ? "head" : "mute",
      focused,
    ),
  ];
  const legend = [seg("less ", "dim"), ...HEAT_ROLES.map((r) => seg("■ ", r)), seg("more ", "dim")];
  const title: Line =
    segsWidth(left) + 1 + segsWidth(legend) <= gridWidth ? { left, right: legend } : { left };
  const beside = ctx.bp !== "narrow";
  // The grid ends in a blank cell, so one more makes the usual two-cell gap.
  const cardWidth = Math.min(CARD_MAX, ctx.width - gridWidth - 1);
  // The card grows for the day's hits, but never past leaving the table its least, so it
  // can't push the heat map off a short screen (critique R1). Hits it can't list then
  // show as a count, listed in full by Enter.
  const want = beside ? cardHeight(vm, state, ctx, cardWidth) : HEAT_HEIGHT;
  const room = ctx.height === undefined ? want : ctx.height - 1 - TABLE_LEAST;
  const height = want <= room ? want : HEAT_HEIGHT;
  return {
    id: "heat",
    priority: 2,
    height,
    render: (h) => (
      <box flexDirection="row" height={h} flexShrink={0} columnGap={1}>
        <box flexDirection="column" width={gridWidth} height={h} flexShrink={0}>
          <Lines theme={ctx.theme} lines={[title]} width={gridWidth} />
          <th-heat
            values={values}
            weeks={shown}
            selected={at >= 0 && at < values.length ? at : -1}
            months={monthLabels(mondays)}
            theme={ctx.theme}
            width={gridWidth}
            height={HEAT_HEIGHT - 1}
            flexShrink={0}
          />
        </box>
        {beside && dayCard(vm, state, ctx, cardWidth, h)}
      </box>
    ),
  };
}

/** Narrow screens: the day card under the heat map, or its one-line summary when short. */
function cardSection(vm: HistoryVM, state: HistoryState, ctx: ViewContext): Section {
  const width = Math.min(CARD_MAX, ctx.width - 2);
  return {
    id: "card",
    priority: 3,
    height: cardHeight(vm, state, ctx, width),
    minHeight: 1,
    render: (height) =>
      height < HEAT_HEIGHT ? (
        <Lines theme={ctx.theme} lines={[summaryLine(vm, state, ctx)]} />
      ) : (
        <box flexDirection="row" height={height} flexShrink={0} paddingLeft={1}>
          {dayCard(vm, state, ctx, width, height)}
        </box>
      ),
  };
}

/** Enter on a day: its limit events in full, hits first, in place of the table. */
function eventsSection(vm: HistoryVM, state: HistoryState, ctx: ViewContext): Section {
  const day = selectedDay(vm, state);
  const lines: Line[] = [
    sectionLine(`LIMIT EVENTS · ${cardTitle(vm, day, state)}`, "esc back"),
    ...byImportance(day.events).flatMap((e) =>
      eventLines(e, ctx.tz, ctx.width - 4).map(
        (segs): Line => ({ left: [seg("   ", "fg"), ...segs] }),
      ),
    ),
  ];
  if (day.events.length === 0) lines.push({ left: [seg("   none", "dim")] });
  return {
    id: "events",
    priority: 1,
    height: lines.length,
    minHeight: Math.min(lines.length, TABLE_LEAST),
    render: (height) => <Lines theme={ctx.theme} lines={lines} height={height} />,
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

/**
 * The table's columns. Cells are worked out only for the rows on screen (the table asks
 * for them), so a 182-day table costs no more to draw than the rows it shows. With a
 * filter there's no accounts column: the view model has no account split per model.
 */
function columns(
  vm: HistoryVM,
  state: HistoryState,
  list: Listing,
  ctx: ViewContext,
  selected: Row | undefined,
  totals: { readonly row: Row; readonly label: string },
): Column<Row>[] {
  const average = baseline(vm, state.filter);
  const period = (r: Row) => (r === totals.row ? null : (r as HistoryPeriod));
  const ratio = (r: Row) => {
    const p = period(r);
    return p === null ? null : ratioOf(p, average, ctx.showCost);
  };
  const amount = (r: Row) =>
    ctx.showCost ? costText(r) : { text: tokens(r.tokens), role: "tokens" as Role };
  const right = { align: "right" as const, role: "tokens" as Role };
  const out: Column<Row>[] = [
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
  ];
  if (state.filter === "") {
    out.push({
      title: "accounts",
      width: "fill",
      role: "mute",
      text: (r) =>
        ranked(period(r)?.accounts ?? [], ctx.showCost)
          .map((a) => a.name)
          .join(", "),
      drop: 8,
    });
  }
  return out;
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
      left: [seg(" filter: ", "dim"), seg(`${state.filter}▏`, "head", true)],
      right: [seg("a model's id · enter apply · esc clear ", "dim")],
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
      : [seg("filter: ", "dim"), seg(state.filter, "head", true), seg(" · esc clear ", "dim")];
  const note = ctx.showCost ? costNote(rows) : null;
  const room = ctx.width - segsWidth(tabs) - 1;
  const right =
    note !== null && textWidth(`${note} · `) + segsWidth(filter) <= room
      ? [seg(`${note} · `, "dim"), ...filter]
      : segsWidth(filter) <= room
        ? filter
        : [];
  // A filter on screen is never dropped: the tabs give way to it.
  return right.length === 0 && state.filter !== "" ? { left: filter } : { left: tabs, right };
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
          columns={columns(vm, state, list, ctx, rows[selected], totals)}
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

function historyKeys(key: string, state: HistoryState, vm: HistoryVM): HistoryState | undefined {
  if (key === "tab") return { ...state, focus: state.focus === "heat" ? "table" : "heat" };
  const group = GROUP_KEYS[key];
  if (group !== undefined) return { ...state, group, open: null, events: false };
  if (key === "W") return { ...openCurrent(vm, state, "week"), events: false };
  if (key === "M") return { ...openCurrent(vm, state, "month"), events: false };
  if (key === "/") return { ...state, typing: true };
  if (key === "return" || key === "enter") {
    // A week or month row in the table opens its days; otherwise a day with limit events
    // lists them in full.
    const list = listing(vm, state);
    const row = list.kind !== "day" && selectedRow(vm, state, list) >= 0;
    if (state.focus === "table" && row) return { ...state, open: list.kind as "week" | "month" };
    if (!state.events && selectedDay(vm, state).events.length > 0) {
      return { ...state, events: true };
    }
    return row ? { ...state, open: list.kind as "week" | "month" } : undefined;
  }
  if (key === "escape") {
    if (state.events) return { ...state, events: false };
    if (state.open !== null) return { ...state, open: null };
    return state.filter === "" ? undefined : { ...state, filter: "" };
  }
  return move(key, state, vm);
}

export const history: View<HistoryVM, HistoryState> = {
  id: "history",
  title: "History",
  hints: [
    { key: "d/w/m", label: "group" },
    { key: "/", label: "filter by model" },
    { key: "W/M", label: "this week/month" },
    { key: "tab", label: "heat map/table" },
    { key: "enter", label: "open" },
    { key: "esc", label: "back" },
    { key: "←→↑↓", label: "move" },
  ],
  initial: {
    focus: "heat",
    group: "day",
    open: null,
    day: null,
    filter: "",
    typing: false,
    events: false,
  },
  capturing: (state) => state.typing,
  keys(key, state, vm) {
    if (state.typing) {
      const next = typed(key, state, vm);
      return next === undefined || vm === undefined ? next : settle(vm, next);
    }
    if (vm === undefined) return undefined;
    const next = historyKeys(key, state, vm);
    return next === undefined ? undefined : settle(vm, next);
  },
  sections(vm, state, ctx) {
    const below = state.events ? eventsSection(vm, state, ctx) : tableSection(vm, state, ctx);
    const sections = [heatSection(vm, state, ctx), below];
    if (ctx.bp === "narrow") sections.splice(1, 0, cardSection(vm, state, ctx));
    return sections;
  },
};
