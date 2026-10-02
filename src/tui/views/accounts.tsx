// Accounts: list + detail (T13, gen.py `accounts_a`). Left, every account with its status
// and highest current utilisation; right, the selected one's root and history, its limit
// meters, the weekly window's last 8 weeks, its 30-day spend and models, and its last MCP
// call. A root on a subscription account it shares (T16) says which roots it shares it
// with and shows the account's meters and total spend. Narrow, the detail stacks under the
// list.
import { type Line, type Seg, seg, segsWidth } from "../components/base.ts";
import type { Column } from "../components/index.ts";
import { filledCells } from "../components/meter.ts";
import { sparkChar } from "../components/spark.ts";
import { chartCell } from "../components/vchart.ts";
import { Lines, Table } from "../elements.tsx";
import { dayLabel, fit, percent, textWidth, tokens, truncate } from "../format.ts";
import { fitSections, type SectionSpec } from "../layout.ts";
import { level, type Role } from "../theme.ts";
import type { AccountRow, AccountsVM, ModelSpend, WeekSlot } from "../vm/accounts.ts";
import type { Priced } from "../vm/types.ts";
import { costText } from "./cells.ts";
import { type Section, type View, type ViewContext, withCommand } from "./types.ts";

export type AccountsState = {
  /** The selected account's id, `ADD_ROOT` for "+ add a root…", or null for the first. */
  readonly selected: number | null;
};

/** The list's last entry, which opens the settings account editor. */
export const ADD_ROOT = -1;
/** Side by side from this width; narrower, the detail goes under the list. */
const SIDE_BY_SIDE = 72;
const DIVIDER = 3;
const FIELD = 11;
const CHART_ROWS = 4;
/** A week's column in the chart: 6 cells of bar and 2 of gap at most (gen.py). */
const MAX_WEEK = 8;
const SPARK_DAYS = 30;

type ListRow = AccountRow | { readonly add: true };
const isAdd = (r: ListRow): r is { readonly add: true } => "add" in r;

// Formatters by zone: building one costs far more than using it, and a frame formats
// dates for every row it sizes.
const dayFormats = new Map<string, Intl.DateTimeFormat>();
const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** `2026-09-29`: the local day of `t` in `tz`. */
function dayKey(t: number, tz: string): string {
  let f = dayFormats.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    dayFormats.set(tz, f);
  }
  return f.format(t);
}

/** A first or last day: `Sep 9`, with the year when it isn't the year of `asOf` (`Oct 2 '25`). */
export function localDay(t: number | null, asOf: number, tz: string): string {
  if (t === null) return "—";
  const day = dayKey(t, tz);
  const label = dayLabel(day).slice(4);
  return day.slice(0, 4) === dayKey(asOf, tz).slice(0, 4) ? label : `${label} '${day.slice(2, 4)}`;
}

/** `14:31:58` in `tz`. */
function clockSeconds(t: number, tz: string): string {
  let f = clockFormats.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    clockFormats.set(tz, f);
  }
  return f.format(t);
}

function clockMinutes(t: number, tz: string): string {
  return clockSeconds(t, tz).slice(0, 5);
}

/** `20,101`. */
export function grouped(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `16:58` today, `Mon 09:00` within the week, else `Oct 9`. */
function whenText(t: number, asOf: number, tz: string): string {
  if (dayKey(t, tz) === dayKey(asOf, tz)) return clockMinutes(t, tz);
  if (t - asOf < 6.5 * 86_400_000)
    return `${dayLabel(dayKey(t, tz)).slice(0, 3)} ${clockMinutes(t, tz)}`;
  return localDay(t, asOf, tz);
}

/** The first of `variants` that fits `width` (the last one otherwise). */
function firstFit(variants: readonly string[], width: number): string {
  return variants.find((v) => textWidth(v) <= width) ?? (variants[variants.length - 1] as string);
}

/** `45m`, `3h`, `12d`: how long ago, for a stale capture. */
function age(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * Not active on this machine: history-only (configured, or detected as not signed in
 * here), disabled, or without a root here.
 */
function inactive(a: AccountRow): boolean {
  return a.historyOnly || a.limits?.signedIn === false || a.root === null || !a.root.enabled;
}

/**
 * The highest utilisation among its windows still running at `asOf`, or null when none is
 * known. A window past its reset says nothing about the one running now.
 */
export function highest(a: AccountRow, asOf: number): number | null {
  if (a.limits === null || !a.limits.signedIn) return null;
  const running = a.limits.windows.filter((w) => w.resetsAt > asOf);
  return running.length === 0 ? null : Math.max(...running.map((w) => w.utilization));
}

/** Its capture's age when every window it holds has since reset; null otherwise. */
function staleAge(a: AccountRow, asOf: number): string | null {
  const l = a.limits;
  if (l === null || !l.signedIn || l.asOf === null || l.windows.length === 0) return null;
  return highest(a, asOf) === null ? age(asOf - l.asOf) : null;
}

const pct = (u: number) => `${Math.round(u * 100)}%`;

function statusDot(a: AccountRow, asOf: number): { text: string; role: Role } {
  if (inactive(a)) return { text: "○", role: "dim" };
  const u = highest(a, asOf);
  return { text: "●", role: u === null ? "dim" : level(u) };
}

// ── the list ─────────────────────────────────────────────────────────────────────

function listColumns(vm: AccountsVM, ctx: ViewContext, width: number): Column<ListRow>[] {
  const { asOf } = vm;
  return [
    {
      title: "",
      width: 1,
      role: (r) => (isAdd(r) ? "dim" : statusDot(r, asOf).role),
      text: (r) => (isAdd(r) ? "+" : statusDot(r, asOf).text),
    },
    {
      title: "",
      width: Math.max(4, width - 1 - 1 - 6 - 1 - 4 - 1),
      role: (r) => (isAdd(r) ? "dim" : inactive(r) ? "mute" : "fg"),
      bold: (r) => !isAdd(r) && r.id === ctx.scope,
      text: (r) => (isAdd(r) ? "add a root…" : r.label),
    },
    {
      title: "",
      width: 6,
      role: "mute",
      text: (r) => (isAdd(r) ? "" : r.provider),
    },
    {
      title: "",
      width: 4,
      align: "right",
      role: (r) => {
        if (isAdd(r)) return "dim";
        const u = highest(r, asOf);
        return u === null ? "dim" : level(u);
      },
      // A capture from before the windows running now: its age, dim, never a current 0%.
      text: (r) => {
        if (isAdd(r)) return "";
        const u = highest(r, asOf);
        return u !== null ? pct(u) : (staleAge(r, asOf) ?? "—");
      },
    },
  ];
}

function listRows(vm: AccountsVM): ListRow[] {
  return [...vm.rows, { add: true }];
}

function selectedIndex(rows: readonly ListRow[], state: AccountsState): number {
  if (state.selected === null) return 0;
  const at = rows.findIndex((r) =>
    isAdd(r) ? state.selected === ADD_ROOT : r.id === state.selected,
  );
  return Math.max(0, at);
}

const HINTS: Line[] = [
  { left: [seg(" enter ", "head", true), seg("scope to it", "dim")] },
  { left: [seg(" e ", "head", true), seg("enable/disable", "dim")] },
  { left: [seg(" l ", "head", true), seg("rename label", "dim")] },
  { left: [seg(" h ", "head", true), seg("history only", "dim")] },
];

/** The list column: title, the accounts and "+ add a root…", then the keys if rows allow. */
function ListColumn(props: {
  vm: AccountsVM;
  rows: readonly ListRow[];
  selected: number;
  ctx: ViewContext;
  width: number;
  height: number;
}) {
  const { rows, ctx, width, height } = props;
  // Short of rows, the blank line under the title goes before any account does.
  const top = height >= rows.length + 2 ? 2 : 1;
  const table = Math.min(rows.length, Math.max(1, height - top));
  const left = height - top - table;
  const hints = left >= HINTS.length + 1 ? [{ left: [] }, ...HINTS] : [];
  const legend = rows.some((r) => !isAdd(r) && inactive(r)) ? "○ inactive here " : "";
  const title: Line = { left: [seg(" ACCOUNTS", "head", true)], right: [seg(legend, "dim")] };
  return (
    <box flexDirection="column" width={width} height={height} flexShrink={0}>
      <Lines theme={ctx.theme} lines={top === 2 ? [title, { left: [] }] : [title]} width={width} />
      <Table<ListRow>
        columns={listColumns(props.vm, ctx, width - 1)}
        rows={rows}
        selected={props.selected}
        header={false}
        more={true}
        theme={ctx.theme}
        height={table}
        width={width - 1}
        marginLeft={1}
      />
      {hints.length > 0 ? <Lines theme={ctx.theme} lines={hints} width={width} /> : null}
    </box>
  );
}

// ── the detail ───────────────────────────────────────────────────────────────────

/** A block of the detail: its lines at a height between `minHeight` and `height`. */
interface Part extends SectionSpec {
  lines(height: number): Line[];
}

const label = (name: string): Seg => seg(` ${name.padEnd(FIELD - 1)}`, "mute");

/** The first of `variants` whose segments fit `width` (the last one otherwise). */
function fitSegs(variants: readonly Seg[][], width: number): Seg[] {
  return variants.find((v) => segsWidth(v) <= width) ?? (variants[variants.length - 1] as Seg[]);
}

/** A labelled note, its text the first of `variants` that fits. */
function noteLine(
  name: string,
  variants: readonly string[],
  width: number,
  role: Role = "dim",
): Line {
  return { left: [label(name), seg(firstFit(variants, width - FIELD), role)] };
}

function headPart(a: AccountRow, vm: AccountsVM, width: number): Part {
  const left = [seg(` ${a.label}`, "head", true), seg(` · ${a.provider}`, "mute")];
  let right: Seg[] = [];
  if (a.limits?.asOf != null) {
    const at = a.limits.asOf;
    const when =
      dayKey(at, vm.tz) === dayKey(vm.asOf, vm.tz)
        ? clockSeconds(at, vm.tz)
        : `${localDay(at, vm.asOf, vm.tz)} ${clockMinutes(at, vm.tz)}`;
    const room = width - segsWidth(left) - 1;
    right = [
      seg(`${firstFit([`limits fetched ${when} `, `fetched ${when} `, `${when} `], room)}`, "dim"),
    ];
    if (segsWidth(right) > room) right = [];
  }
  return { id: "head", priority: 1, height: 1, lines: () => [{ left, right }] };
}

function wherePart(a: AccountRow, vm: AccountsVM, width: number): Part {
  let root: Line;
  if (a.root === null) {
    root = noteLine("root", ["not found on this machine: history only", "not found here"], width);
  } else {
    const status = !a.root.enabled ? "disabled" : a.root.polled ? "polled" : "watched";
    const extra = a.historyOnly
      ? ", history only"
      : a.limits?.signedIn === false
        ? ", not signed in"
        : "";
    const path = [label("root"), seg(a.root.path, "fg")];
    // The annotation gives way before the path is cut.
    root = {
      left: fitSegs(
        [
          [...path, seg(`  (${status}${extra})`, "dim")],
          [...path, seg(`  (${status})`, "dim")],
          path,
        ],
        width,
      ),
    };
  }
  const history: Line =
    a.records === 0
      ? { left: [label("history"), seg("no records yet", "dim")] }
      : {
          left: [
            label("history"),
            seg(`${grouped(a.records)} record${a.records === 1 ? "" : "s"}`, "fg"),
            seg(` since ${localDay(a.firstSeen, vm.asOf, vm.tz)}`, "fg"),
          ],
        };
  return { id: "where", priority: 2, height: 2, lines: () => [root, history] };
}

/**
 * One meter line per window: the label, a bar, the % and when it resets. Narrow, the bar
 * shrinks, then "resets" goes, then the bar: the % and the time are never cut. A window
 * past its reset is stale: an empty bar, `—`, and how long ago it reset.
 */
function meterLines(a: AccountRow, vm: AccountsVM, width: number): Line[] {
  const windows = a.limits?.windows ?? [];
  const labelWidth = Math.max(8, ...windows.map((w) => textWidth(w.label) + 1));
  const stale = (t: number) => t <= vm.asOf;
  const when = (t: number) => (stale(t) ? `${age(vm.asOf - t)} ago` : whenText(t, vm.asOf, vm.tz));
  const shapes = [
    { word: true, bar: true },
    { word: false, bar: true },
    { word: false, bar: false },
  ];
  const resetText = (t: number, word: boolean) =>
    word ? `${stale(t) ? "reset" : "resets"} ${when(t)}` : when(t);
  for (const [i, shape] of shapes.entries()) {
    const resetWidth = Math.max(
      ...windows.map((w) => textWidth(resetText(w.resetsAt, shape.word))),
    );
    const fixed = 1 + labelWidth + 6 + 3 + resetWidth;
    const bar = shape.bar ? Math.min(44, width - fixed) : 0;
    if (shape.bar && bar < 4 && i < shapes.length - 1) continue;
    return windows.map((w) => {
      const old = stale(w.resetsAt);
      const n = old ? 0 : filledCells(w.utilization, bar);
      const role: Role = old ? "dim" : level(w.utilization);
      return {
        left: [
          seg(` ${w.label.padEnd(labelWidth)}`, "head", true),
          seg("━".repeat(n), role),
          seg("━".repeat(Math.max(0, bar - n)), "empty"),
          seg((old ? "—" : pct(w.utilization)).padStart(6), role, !old),
          seg(`   ${resetText(w.resetsAt, shape.word)}`, "dim"),
        ],
      };
    });
  }
  return [];
}

/** `shared with win-like, work`: as many labels as fit, then how many more. */
function sharedLine(labels: readonly string[], width: number): Line {
  const lead = " shared with ";
  const room = width - textWidth(lead) - 1;
  const all = labels.join(", ");
  let text = all;
  if (textWidth(all) > room) {
    const cut = (n: number) => `${labels.slice(0, n).join(", ")} +${labels.length - n} more`;
    let n = labels.length - 1;
    while (n > 0 && textWidth(cut(n)) > room) n--;
    text = n > 0 ? cut(n) : truncate(all, room);
  }
  return { left: [seg(lead, "dim"), seg(text, "fg")] };
}

/**
 * The limit meters (5-HOUR, WEEKLY, then any other), or why there are none. A root on a
 * shared account says so first: the meters are the account's.
 */
function limitsPart(a: AccountRow, vm: AccountsVM, width: number): Part {
  let lines: Line[];
  const l = a.limits;
  const shared = a.sharedWith.length > 0;
  // A history-only root on an account signed in through another root shows its meters.
  if ((a.historyOnly && !(shared && l?.signedIn === true)) || (l !== null && !l.signedIn)) {
    lines = [{ left: [seg(" not signed in here", "mid")] }];
  } else if (a.root === null) {
    lines = [noteLine("limits", ["not fetched: no root on this machine", "no root here"], width)];
  } else if (!a.root.enabled) {
    lines = [
      noteLine(
        "limits",
        [
          "not fetched: this root is disabled (e enables it)",
          "not fetched: root disabled (e enables it)",
          "root disabled (e enables it)",
          "root disabled",
        ],
        width,
      ),
    ];
  } else if (l === null || l.windows.length === 0) {
    lines = [noteLine("limits", ["none fetched yet"], width)];
  } else {
    lines = meterLines(a, vm, width);
  }
  const failed: Line[] =
    l?.error == null
      ? []
      : [
          noteLine(
            "",
            [`last fetch failed: ${l.error}`, `fetch failed: ${l.error}`, l.error],
            width,
            "mid",
          ),
        ];
  const head = shared ? [sharedLine(a.sharedWith, width)] : [];
  if (a.sharedDiffers) {
    const why = [
      " their limits differed at the last check: one account?",
      " limits differed at the last check",
      " limits differ",
    ];
    head.push({ left: [seg(firstFit(why, width - 1), "mid")] });
  }
  // Short of rows, the meters after the 5-hour and weekly ones go first.
  return {
    id: "limits",
    priority: 3,
    height: head.length + lines.length + failed.length,
    minHeight: head.length + Math.min(lines.length, 2) + failed.length,
    lines: (h) => [...head, ...lines.slice(0, h - head.length - failed.length), ...failed],
  };
}

/** A week's value under its bar: `62%`, `100%`, `≥80%`, or `—` when nothing recorded it. */
function slotText(s: WeekSlot): string {
  if (s.source === "passed_80") return "≥80%";
  return s.value === null ? "—" : pct(s.value);
}

function slotRole(s: WeekSlot): Role {
  if (s.value === null) return "dim";
  return s.source === "now" ? "mute" : level(s.value);
}

/**
 * The weekly window's last 8 weeks: bars on a fixed 0–100 % scale (VChart's cells), the
 * value and the reset date under each, and what the history leaves out.
 */
function weeklyPart(a: AccountRow, vm: AccountsVM, width: number): Part | null {
  const slots = a.weekly;
  if (slots === null || a.limits === null || !a.limits.signedIn) return null;
  const slotWidth = Math.max(5, Math.min(MAX_WEEK, Math.floor((width - 3) / slots.length)));
  const colw = Math.max(1, slotWidth - 2);
  const known = slots.filter((s) => s.source !== "now" && s.value !== null).length;
  const now = slots[slots.length - 1] as WeekSlot;
  const captured = a.limits.asOf === null ? "" : ` (${age(vm.asOf - a.limits.asOf)} old)`;
  const note = firstFit(
    now.value === null
      ? [
          `this week isn't captured yet: the last capture${captured} is from an earlier one`,
          `this week isn't captured yet${captured}`,
          "this week not captured yet",
        ]
      : known === 0
        ? [
            "no limit events recorded yet: only this week is known",
            "no limit events yet: only this week is known",
            "only this week is known",
          ]
        : [
            "only weeks past 80 % or at 100 % are recorded; — = no record",
            "only weeks past 80 % or at 100 % are recorded",
            "— = no record",
          ],
    width - 4,
  );
  // `Aug 10`, or `8/10` for every week when one is too narrow for that.
  const keys = slots.map((s) => dayKey(s.resetsAt, vm.tz));
  const long = keys.every((k) => textWidth(dayLabel(k).slice(4)) < slotWidth);
  const date = (s: WeekSlot, i: number) => {
    if (s.source === "now") return "now";
    const key = keys[i] as string;
    const [, m, d] = key.split("-").map(Number) as [number, number, number];
    return long ? dayLabel(key).slice(4) : `${m}/${d}`;
  };
  // Title, the bars, values, dates and the note: the bars give way first.
  const lines = (h: number): Line[] => {
    const rows = Math.max(2, Math.min(CHART_ROWS, h - 4));
    const out: Line[] = [{ left: [seg(" weekly usage when it reset · last 8 weeks", "dim")] }];
    for (let r = 0; r < rows; r++) {
      const segs: Seg[] = [seg("   ", "fg")];
      for (const s of slots) {
        const cell = s.value === null ? " " : chartCell(Math.min(1, s.value), 1, rows, r);
        segs.push(seg(cell.repeat(colw), slotRole(s)), seg(" ".repeat(slotWidth - colw), "fg"));
      }
      out.push({ left: segs });
    }
    out.push({
      left: [seg("   ", "fg"), ...slots.map((s) => seg(fit(slotText(s), slotWidth), slotRole(s)))],
    });
    out.push({
      left: [seg("   ", "fg"), ...slots.map((s, i) => seg(fit(date(s, i), slotWidth), "dim"))],
    });
    out.push({ left: [seg(`   ${note}`, "dim")] });
    return out;
  };
  return { id: "weekly", priority: 6, height: CHART_ROWS + 4, minHeight: 6, lines };
}

/** The 30-day total, as cost, or as tokens with costs hidden. */
function totalText(p: Priced, ctx: ViewContext): { text: string; role: Role } {
  return ctx.showCost ? costText(p) : { text: tokens(p.tokens), role: "tokens" };
}

/**
 * 30-day spend: a sparkline of daily cost (tokens with costs hidden) and the total; for a
 * root on a shared subscription account, the account's total under it.
 */
function spendPart(a: AccountRow, ctx: ViewContext, width: number): Part {
  const values = ctx.showCost ? a.spark : a.sparkTokens;
  const total = totalText(a.last30, ctx);
  /** The spend line, the sparkline as long as `after` leaves room for. */
  const spendLine = (after: readonly Seg[]): Line => {
    const fixed = FIELD + 2 + textWidth(total.text) + 1 + segsWidth(after);
    const shown = values.slice(-Math.max(0, Math.min(SPARK_DAYS, width - fixed)));
    const hi = Math.max(0, ...shown);
    return {
      left: [
        label(ctx.showCost ? "spend 30d" : "tokens 30d"),
        seg(
          shown.map((v) => sparkChar(v, hi > 0 ? hi : 1)).join(""),
          ctx.showCost ? "cost" : "tokens",
        ),
        seg(`  ${total.text}`, total.role, total.role === "cost"),
        ...after,
      ],
    };
  };
  const line = spendLine([]);
  if (a.accountLast30 === null) return { id: "spend", priority: 4, height: 1, lines: () => [line] };
  const sum = totalText(a.accountLast30, ctx);
  const sumSeg = seg(sum.text, sum.role, sum.role === "cost");
  const account: Line = {
    left: [
      label(""),
      ...fitSegs(
        ["account total (all linked roots): ", "account total: ", "total: "].map((lead) => [
          seg(lead, "dim"),
          sumSeg,
        ]),
        width - FIELD,
      ),
    ],
  };
  // Short of rows, the account's total follows the root's on the one line.
  const one = spendLine([seg("  total ", "dim"), sumSeg]);
  return {
    id: "spend",
    priority: 4,
    height: 2,
    minHeight: 1,
    lines: (h) => (h >= 2 ? [line, account] : [one]),
  };
}

/** Top models over 30 days, one line: as many as fit, by share of cost (tokens). */
function modelsPart(a: AccountRow, ctx: ViewContext, width: number): Part {
  // Shares of cost, or of tokens when costs are hidden or nothing has a price; unpriced
  // models are listed after the priced ones, marked `*`.
  const byCost = ctx.showCost && a.topModels.some((m) => m.cost > 0);
  const value = (m: ModelSpend) => (byCost ? m.cost : m.tokens);
  const total = a.topModels.reduce((s, m) => s + value(m), 0);
  const items = [...a.topModels]
    .filter((m) => m.tokens > 0)
    .sort((x, y) => value(y) - value(x) || y.tokens - x.tokens)
    .map((m) =>
      byCost && m.unpriced
        ? `${m.name} *`
        : `${m.name}${m.unpriced ? " *" : ""} ${percent(value(m) / total, 0)}`,
    );
  let text = "";
  for (const [i, item] of items.entries()) {
    const more = items.length - i - 1;
    const next = text === "" ? item : `${text} · ${item}`;
    const tail = more > 0 ? ` · +${more} more` : "";
    if (FIELD + textWidth(next + tail) > width - 1) {
      text = `${text} · +${items.length - i} more`;
      break;
    }
    text = next;
  }
  const line: Line = {
    left: [
      label("models"),
      seg(text === "" ? "none in 30 days" : text, text === "" ? "dim" : "fg"),
    ],
  };
  return { id: "models", priority: 5, height: 1, lines: () => [line] };
}

/** Its last MCP call in the last 10 minutes, when MCP servers report any. */
function agentPart(a: AccountRow, vm: AccountsVM, width: number): Part | null {
  if (a.agent === null) {
    if (!vm.mcp) return null;
    const line = noteLine(
      "agents",
      ["no MCP calls in the last 10 min", "no calls in 10 min"],
      width,
    );
    return { id: "agents", priority: 7, height: 1, lines: () => [line] };
  }
  const { at, tool, calls } = a.agent;
  const head = [label("agents"), seg("● ", "live")];
  const time = clockSeconds(at, vm.tz);
  const line: Line = {
    left: fitSegs(
      [
        [
          ...head,
          seg(`${tool} at ${time}`, "fg"),
          seg(` · ${calls} call${calls === 1 ? "" : "s"} in 10 min`, "dim"),
        ],
        [...head, seg(`${tool} at ${time}`, "fg")],
        [...head, seg(`${tool} ${time.slice(0, 5)}`, "fg")],
        [...head, seg(time.slice(0, 5), "fg")],
      ],
      width,
    ),
  };
  return { id: "agents", priority: 7, height: 1, lines: () => [line] };
}

/** The detail's blocks in display order (priorities say what drops first). */
function detailParts(a: AccountRow, vm: AccountsVM, ctx: ViewContext, width: number): Part[] {
  const parts: (Part | null)[] = [
    headPart(a, vm, width),
    wherePart(a, vm, width),
    limitsPart(a, vm, width),
    weeklyPart(a, vm, width),
    spendPart(a, ctx, width),
    modelsPart(a, ctx, width),
    agentPart(a, vm, width),
  ];
  return parts.filter((p): p is Part => p !== null);
}

/** The detail's lines in `height` rows: the parts that fit, a blank row between them. */
function detailLines(parts: readonly Part[], height: number): Line[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  return fitSections(parts, height).flatMap((f, i) => [
    ...(i > 0 ? [{ left: [] }] : []),
    ...(byId.get(f.id) as Part).lines(f.height),
  ]);
}

function addRootLines(): Line[] {
  return [
    { left: [seg(" add a root", "head", true)] },
    { left: [] },
    { left: [seg(" enter opens the settings account editor: every root found here,", "dim")] },
    { left: [seg(" to enable, rename or mark history-only", "dim")] },
  ];
}

function partHeight(parts: readonly Part[]): number {
  return parts.reduce((n, p) => n + p.height, 0) + Math.max(0, parts.length - 1);
}

export const accounts: View<AccountsVM, AccountsState> = {
  id: "accounts",
  title: "Accounts",
  hints: [
    { key: "↑/↓", label: "account" },
    { key: "enter", label: "scope" },
    { key: "e", label: "enable" },
    { key: "l", label: "label" },
    { key: "h", label: "history only" },
  ],
  initial: { selected: null },
  // Selection is by account id, so an account from another view is selected as it is.
  select: (_state, account) => ({ selected: account }),
  keys(key, state, vm) {
    if (vm === undefined) return undefined;
    const rows = listRows(vm);
    if (key === "up" || key === "down") {
      const at = selectedIndex(rows, state) + (key === "down" ? 1 : -1);
      const row = rows[Math.max(0, Math.min(rows.length - 1, at))] as ListRow;
      return { selected: isAdd(row) ? ADD_ROOT : row.id };
    }
    // The rest act on what the shell owns: the scope, a root's config, the settings.
    const row = rows[selectedIndex(rows, state)];
    if (row === undefined) return undefined;
    if (key === "return" || key === "enter") {
      return withCommand(
        state,
        isAdd(row) ? { type: "settings" } : { type: "scope", account: row.id },
      );
    }
    if (isAdd(row)) return undefined;
    const edit = key === "e" ? "enable" : key === "l" ? "rename" : key === "h" ? "history" : null;
    if (edit === null) return undefined;
    return withCommand(state, { type: "root", identity: row.identity, label: row.label, edit });
  },
  sections(vm, state, ctx) {
    const rows = listRows(vm);
    const at = selectedIndex(rows, state);
    const row = rows[at] as ListRow;
    const listHeight = 2 + rows.length;
    if (ctx.width >= SIDE_BY_SIDE) {
      const listWidth = Math.max(26, Math.min(34, Math.floor(ctx.width * 0.32)));
      const detailWidth = ctx.width - listWidth - DIVIDER;
      const parts = isAdd(row) ? null : detailParts(row, vm, ctx, detailWidth);
      const full = Math.max(listHeight + 1 + HINTS.length, parts === null ? 4 : partHeight(parts));
      return [
        {
          id: "accounts",
          priority: 1,
          height: full,
          minHeight: Math.min(full, Math.max(listHeight, 4)),
          render: (height) => (
            <box flexDirection="row" height={height} flexShrink={0}>
              <ListColumn
                vm={vm}
                rows={rows}
                selected={at}
                ctx={ctx}
                width={listWidth}
                height={height}
              />
              <Lines
                theme={ctx.theme}
                lines={Array.from({ length: height }, () => ({ left: [seg(" │ ", "border")] }))}
                width={DIVIDER}
              />
              <Lines
                theme={ctx.theme}
                lines={parts === null ? addRootLines() : detailLines(parts, height)}
                width={detailWidth}
                height={height}
              />
            </box>
          ),
        },
      ];
    }
    // Narrow: the list, then the detail's blocks as sections of their own.
    // At least the title, three accounts and the cue for the rest.
    const list: Section = {
      id: "list",
      priority: 1,
      height: listHeight,
      minHeight: Math.min(listHeight, 5),
      render: (height) => (
        <ListColumn vm={vm} rows={rows} selected={at} ctx={ctx} width={ctx.width} height={height} />
      ),
    };
    if (isAdd(row)) {
      return [
        list,
        {
          id: "add",
          priority: 2,
          height: 4,
          render: (height) => <Lines theme={ctx.theme} lines={addRootLines()} height={height} />,
        },
      ];
    }
    const parts = detailParts(row, vm, ctx, ctx.width);
    return [
      list,
      ...parts.map(
        (p): Section => ({
          id: p.id,
          priority: p.priority + 1,
          height: p.height,
          ...(p.minHeight === undefined ? {} : { minHeight: p.minHeight }),
          render: (height) => <Lines theme={ctx.theme} lines={p.lines(height)} height={height} />,
        }),
      ),
    ];
  },
};
