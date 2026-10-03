// The Overview, "limits first" (T11; gen.py `overview_a`): a card per account with its
// 5-hour and weekly meters, reset countdowns and what the spend pace means for them, an MCP
// agents card, spend, activity and its window's top models, and the week's limit events.
//
// Built for half a 1080p screen (about 105×50) and the top half of a portrait one (about
// 120×45). Sections keep their priority order and the lowest go first when rows run out;
// the limit cards keep their full height until everything below them has gone. Cards sit
// 3 to a row at 120 columns and up, 2 from 100, and below that become two compact lines
// each. No number is ever cut: every line tries shorter forms, then drops parts, instead.
import { type Line, type Seg, seg, segsWidth } from "../components/base.ts";
import type { Column, XLabel } from "../components/index.ts";
import { filledCells } from "../components/meter.ts";
import { Lines, Table } from "../elements.tsx";
import {
  clip,
  countdown,
  fit,
  money,
  moneyShort,
  percent,
  textWidth,
  tokens,
  truncate,
} from "../format.ts";
import { sectionLine, type Tab, tabsHeader } from "../frame.ts";
import { GLOBAL_KEYS, type Keymap, moveKey } from "../keys.ts";
import { cardsPerRow, splitWidth } from "../layout.ts";
import { level, type Role } from "../theme.ts";
import type {
  ActivitySeries,
  ActivityWindow,
  AgentCall,
  LimitCard,
  LimitMeter,
  OverviewEvent,
  OverviewVM,
  SpendColumn,
  TopModel,
  Verdict,
} from "../vm/types.ts";
import { ACTIVITY_WINDOWS, SPEND_PERIODS, VIEW_IDS } from "../vm/types.ts";
import { costNote, costText } from "./cells.ts";
import { projectedForms } from "./projection.ts";
import { type Section, type View, type ViewContext, withCommand } from "./types.ts";

export interface OverviewState {
  /** The activity chart's span, and the top models' with it: its tab (`a`/`d`). */
  readonly window: ActivityWindow;
  /** Chart and rank by tokens even while costs show (`t`). */
  readonly tokens: boolean;
  /** The selected limits card (`w`/`s`), by position; null for none (Enter opens the first). */
  readonly card: number | null;
}

const CARD_HEIGHT = 5;
/** Limits captured longer ago than this show their age on the card. */
const STALE_MS = 15 * 60_000;
const CHART_ROWS = 7;
/** The chart's y labels: `188.0M` and `$1.23K` are the widest. */
const CHART_LABEL_WIDTH = 6;
/** Top models beside the chart (wide screens): from this wide… */
const TOP_WIDTH = 38;
/** …to this, taking what a 96-column plot (24 h at 15 minutes) leaves. */
const TOP_MAX_WIDTH = 56;
/** The top models' table itself: at most this wide, unless its names need more. */
const TOP_TABLE_WIDTH = 46;
const AGENT_ROWS = 3;
/** An agent line's project is cut to this many cells. */
const PROJECT_WIDTH = 16;
const EVENT_ROWS = 8;
const SPEND_LABELS: Readonly<Record<SpendColumn, string>> = {
  "1h": "1h",
  "5h": "5h",
  today: "today",
  this_week: "this week",
  this_month: "this month",
  all: "all-time",
};
const WINDOW_TABS: readonly Tab[] = ACTIVITY_WINDOWS.map((w) => ({ label: w }));
/** The activity chart's section (and, wide, the top models beside it). */
const ACTIVITY = "activity";
const ticks = (texts: readonly string[]): XLabel[] =>
  texts.map((text, i) => ({ at: i / (texts.length - 1), text }));
const X_LABELS: Readonly<Record<ActivityWindow, readonly XLabel[]>> = {
  "5h": ticks(["-5h", "-4h", "-3h", "-2h", "-1h", "now"]),
  "24h": ticks(["-24h", "-18h", "-12h", "-6h", "now"]),
  "7d": ticks(["-7d", "-6d", "-5d", "-4d", "-3d", "-2d", "-1d", "now"]),
};
const SPANS: Readonly<Record<ActivityWindow, string>> = {
  "5h": "5 hours",
  "24h": "24 hours",
  "7d": "7 days",
};
/**
 * Under the top models when a row is spare (T27): the Models view has the windows the
 * Overview doesn't (today, this week, …). It is the header's tab for that view.
 */
const MODELS_HINT = `more windows: ${VIEW_IDS.indexOf("models") + 1} Models`;

// ── times and amounts ──────────────────────────────────────────────────────────────

const FORMATS = {
  day: { locale: "en-CA", options: {} },
  weekday: { locale: "en-GB", options: { weekday: "short" } },
  clock: { locale: "en-GB", options: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } },
} as const satisfies Record<string, { locale: string; options: Intl.DateTimeFormatOptions }>;
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * One formatter per zone and kind, kept: building one costs about 0.1 ms, and a frame
 * writes dozens of times (format.ts `clock` builds one per call).
 */
function format(t: number, tz: string, kind: keyof typeof FORMATS): string {
  const key = `${kind}\0${tz}`;
  let f = formatters.get(key);
  if (f === undefined) {
    const { locale, options } = FORMATS[kind];
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: tz });
    formatters.set(key, f);
  }
  return f.format(t);
}

/** `Thu 16:20`. */
function dayClock(t: number, tz: string): string {
  return `${format(t, tz, "weekday")} ${format(t, tz, "clock")}`;
}

/** `16:20` on the day of `asOf`, else `Thu 16:20`. */
function when(t: number, asOf: number, tz: string): string {
  return format(t, tz, "day") === format(asOf, tz, "day")
    ? format(t, tz, "clock")
    : dayClock(t, tz);
}

/** How long ago, to the minute the view model is recomputed at: `<1m`, `4m`, `1h05m`. */
function ago(ms: number): string {
  return ms < 60_000 ? "<1m" : countdown(ms);
}

function pct(u: number): string {
  return `${Math.round(u * 100)}%`;
}

/** The pace as the design writes it: `$41/h`, `$6.4/h`, `$0.40/h`, `$1.2K/h`; or tokens. */
function paceText(card: LimitCard, showCost: boolean): string {
  if (!showCost) return `${tokens(card.pace.tokens)}/h`;
  const v = card.pace.cost;
  const amount =
    v >= 1000
      ? moneyShort(v)
      : v >= 10
        ? `$${Math.round(v)}`
        : v >= 1
          ? `$${v.toFixed(1)}`
          : v > 0
            ? `$${v.toFixed(2)}`
            : "$0";
  return `${amount}/h`;
}

/**
 * The pace and, while it fits, which pace it is (T18): `pace $1.3/h (30m)` for the last 30
 * minutes, `avg $16/h this week` for a weekly window's average. Narrower, the basis goes
 * (`pace $1.3/h`, `avg $16/h`), then the word (`$16/h`); the number never does.
 */
function paceSegs(card: LimitCard, showCost: boolean, form: 0 | 1 | 2): Seg[] {
  const amount = paceText(card, showCost);
  if (form === 2) return [seg(`${amount} `, "cost")];
  const avg = card.pace.basis === "window_avg";
  const lead = seg(avg ? "avg " : "pace ", "mute");
  if (form === 1) return [lead, seg(`${amount} `, "cost")];
  return [lead, seg(amount, "cost"), seg(avg ? " this week " : " (30m) ", "dim")];
}

/**
 * How much of the verdict shows: all of it (0); a projected 100 % without its time (1);
 * short (2). Only a projection has a form 1: the others read long until form 2.
 */
type VerdictForm = 0 | 1 | 2;

/**
 * The verdict in `form`, and its colour. A projected 100 % counts down first and gives the
 * time second (T26): `100% in <2h (16:20)`, then `100% in <2h`, then `100% <2h`. A weekly
 * window's time is only good to a part of a day, and says so: `100% in ~3d (~Sun evening)`
 * (T18). The others are long (`week ends ~94%`) or short (`wk ~94%`).
 */
function verdictSeg(v: Verdict, form: VerdictForm, asOf: number, tz: string): Seg {
  const short = form === 2;
  switch (v.kind) {
    case "full":
      return seg(`${short ? "" : "at "}100% until ${when(v.until, asOf, tz)}`, "high", true);
    case "hits":
      return seg(projectedForms(v.at, asOf, v.rough ?? when(v.at, asOf, tz))[form], "high", true);
    case "week":
      return seg(`${short ? "wk" : "week ends"} ~${pct(v.utilization)}`, "mid");
    case "safe":
      return seg(short ? "safe" : "safe until reset", "mute");
    case "idle":
      // Nothing spent lately, but a window nearly full is no reason to relax.
      return v.high === null
        ? seg("idle", "dim")
        : seg(`idle · ${v.high.window} ${pct(v.high.utilization)}`, "high");
    case "unknown":
      return seg(short ? "—" : "no estimate yet", "dim");
  }
}

/** `(12m old)` for limits captured over 15 minutes ago; null when fresh or not shown. */
function staleNote(card: LimitCard, asOf: number): string | null {
  if (!card.signedIn || card.capturedAt === null || asOf - card.capturedAt <= STALE_MS) {
    return null;
  }
  return `(${countdown(asOf - card.capturedAt)} old)`;
}

/** The first of `forms` that fits `width`, else the last. */
function firstFit(forms: readonly Line[], width: number): Line {
  for (const line of forms) {
    const right = line.right === undefined ? 0 : segsWidth(line.right) + 1;
    if (segsWidth(line.left) + right <= width) return line;
  }
  return forms[forms.length - 1] as Line;
}

/** `segs` in exactly `width` cells: cut with `…` if they overflow, else padded. */
function fitSegs(segs: readonly Seg[], width: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    const w = textWidth(s.text);
    if (used + w > width) {
      if (width > used) out.push({ ...s, text: truncate(s.text, width - used) });
      return out;
    }
    out.push(s);
    used += w;
  }
  if (used < width) out.push(seg(" ".repeat(width - used), "fg"));
  return out;
}

/**
 * gen.py's `card()`: `╭─ title note ─╮`, three body lines between `│ ` and ` │`, and the
 * bottom border, each exactly `width` cells. The note (a stale age) is kept whole; the
 * title is the first of `titles` that fits, else the last one, cut.
 */
function cardText(
  titles: readonly string[],
  role: Role,
  note: string | null,
  body: (width: number) => Line[],
  width: number,
): Seg[][] {
  const inner = width - 4;
  const room = width - 6;
  const after = note === null || textWidth(note) + 2 > room ? "" : ` ${note}`;
  const fits = titles.find((t) => textWidth(t) <= room - textWidth(after));
  const head = fits ?? truncate(titles[titles.length - 1] as string, room - textWidth(after));
  const fill = width - 5 - textWidth(head) - textWidth(after);
  const lines = body(inner);
  const out: Seg[][] = [
    [
      seg("╭─ ", "border"),
      seg(head, role, true),
      ...(after === "" ? [] : [seg(after, "dim")]),
      seg(` ${"─".repeat(Math.max(1, fill))}╮`, "border"),
    ],
  ];
  for (let r = 0; r < CARD_HEIGHT - 2; r++) {
    const line = lines[r] ?? { left: [] };
    const right = line.right ?? [];
    const gap = Math.max(1, inner - segsWidth(line.left) - segsWidth(right));
    const content =
      right.length === 0 ? line.left : [...line.left, seg(" ".repeat(gap), "fg"), ...right];
    out.push([seg("│ ", "border"), ...fitSegs(content, inner), seg(" │", "border")]);
  }
  out.push([seg(`╰${"─".repeat(width - 2)}╯`, "border")]);
  return out;
}

// ── limits: cards ──────────────────────────────────────────────────────────────────

function meterSegs(m: LimitMeter, cells: number): Seg[] {
  const n = filledCells(m.utilization, cells);
  return [seg("━".repeat(n), level(m.utilization)), seg("━".repeat(cells - n), "empty")];
}

function resetIn(m: LimitMeter, asOf: number): string {
  return m.resetsAt > asOf ? countdown(m.resetsAt - asOf) : "—";
}

/** gen.py's meter line, filling `width`: `5h   ━━━━━━━━━━━──────  62%   1h48m`. */
function meterLine(name: string, m: LimitMeter | null, width: number, asOf: number): Line {
  const label = seg(fit(name, 5), "mute");
  if (m === null) return { left: [label, seg("—", "dim")] };
  return {
    left: [
      label,
      ...meterSegs(m, Math.max(4, width - 17)),
      seg(fit(pct(m.utilization), 5, "right"), level(m.utilization), true),
      seg(fit(resetIn(m, asOf), 7, "right"), "dim"),
    ],
  };
}

/**
 * The pace and its verdict, in the first form that fits `width`: the verdict gives way
 * first (a projection's time, then its `in`; T26), then the pace's basis, then its word
 * (T18). A weekly average's `this week` goes before its time, though: the LIMITS note
 * already says what `avg` is, and the part of the day is worth more. Exported for the
 * drop-order tests.
 */
export function paceLine(card: LimitCard, width: number, ctx: ViewContext, asOf: number): Line {
  const line = (pace: 0 | 1 | 2, verdict: VerdictForm): Line => ({
    left: [
      ...paceSegs(card, ctx.showCost, pace),
      seg("→ ", "dim"),
      verdictSeg(card.verdict, verdict, asOf, ctx.tz),
    ],
  });
  const weeklyTime = card.pace.basis === "window_avg" && card.verdict.kind === "hits";
  return firstFit(
    [
      line(0, 0),
      ...(weeklyTime ? [line(1, 0)] : []),
      line(0, 1),
      line(0, 2),
      line(1, 2),
      line(2, 2),
    ],
    width,
  );
}

function cardBody(card: LimitCard, width: number, ctx: ViewContext, asOf: number): Line[] {
  const pace = paceLine(card, width, ctx, asOf);
  if (!card.signedIn) return [{ left: [seg("not signed in here", "dim")] }, { left: [] }, pace];
  if (card.capturedAt === null) {
    return [{ left: [seg("no limits captured yet", "dim")] }, { left: [] }, pace];
  }
  return [
    meterLine("5h", card.fiveHour, width, asOf),
    meterLine("week", card.week, width, asOf),
    pace,
  ];
}

/**
 * One line per agent session: `● tokenhud  personal  should_wait`, the time ago flush right.
 * The project is the name of the directory the session runs in, as its heartbeat gives it,
 * or "claude session" when it gives none; the projects take one width, so the accounts line
 * up. Every line takes the same shape, the first that fits them all: the account goes
 * first, then the project.
 */
function agentLines(
  agents: NonNullable<OverviewVM["agents"]>,
  width: number,
  asOf: number,
  dot = true,
): Line[] {
  const { calls, servers } = agents;
  if (calls.length === 0) {
    return [
      { left: [seg("no tool calls in the last 10 min", "dim")] },
      { left: [seg(`${servers} server${servers === 1 ? "" : "s"} running`, "dim")] },
    ];
  }
  const shown = calls.length <= AGENT_ROWS ? calls : calls.slice(0, AGENT_ROWS - 1);
  const named = (call: AgentCall) => call.project ?? "claude session";
  const projectWidth = Math.min(PROJECT_WIDTH, Math.max(...shown.map((c) => textWidth(named(c)))));
  const line = (call: AgentCall, project: boolean, account: boolean): Line => ({
    left: [
      ...(dot ? [seg("● ", "live")] : []),
      ...(project ? [seg(fit(truncate(named(call), projectWidth), projectWidth + 2), "fg")] : []),
      ...(account && call.account !== null ? [seg(`${call.account}  `, "mute")] : []),
      seg(call.tool, "fg"),
    ],
    right: [seg(ago(asOf - call.at), "dim")],
  });
  const fits = (l: Line) => segsWidth(l.left) + 1 + segsWidth(l.right ?? []) <= width;
  const shapes: [boolean, boolean][] = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ];
  const [project, account] = shapes.find(([p, a]) => shown.every((c) => fits(line(c, p, a)))) ?? [
    false,
    false,
  ];
  const lines = shown.map((c) => line(c, project, account));
  if (shown.length < calls.length) {
    lines.push({ left: [seg(`+${calls.length - shown.length} more`, "dim")] });
  }
  return lines;
}

// ── limits: compact (narrow) ───────────────────────────────────────────────────────

/** How a compact card's first line is drawn: one shape for every card, so they align. */
interface CompactShape {
  readonly provider: boolean;
  readonly name: number;
  /** Meter cells, or 0 for none. */
  readonly cells: number;
  readonly resets: boolean;
}

function compactName(card: LimitCard, shape: CompactShape): Seg {
  const text = shape.provider ? `${card.label} · ${card.provider}` : card.label;
  return seg(fit(text, shape.name), "fg", true);
}

function compactFirst(card: LimitCard, shape: CompactShape, asOf: number): Line {
  const dot = !card.signedIn
    ? seg(" ○ ", "dim")
    : seg(" ● ", staleNote(card, asOf) === null ? "live" : "mid");
  if (!card.signedIn || card.capturedAt === null) {
    const why = card.signedIn ? "no limits captured yet" : "not signed in here";
    return { left: [dot, compactName(card, shape), seg(`  ${why}`, "dim")] };
  }
  const window = (label: string, m: LimitMeter | null): Seg[] => {
    if (m === null) return [seg(`  ${label} `, "mute"), seg("—", "dim")];
    return [
      seg(`  ${label} `, "mute"),
      ...(shape.cells > 0 ? [...meterSegs(m, shape.cells), seg(" ", "fg")] : []),
      seg(fit(pct(m.utilization), 4, "right"), level(m.utilization), true),
      ...(shape.resets ? [seg(fit(resetIn(m, asOf), 7, "right"), "dim")] : []),
    ];
  };
  return {
    left: [
      dot,
      compactName(card, shape),
      ...window("5h", card.fiveHour),
      ...window("week", card.week),
    ],
  };
}

/** The second line: the pace and its verdict, and the age when the limits are stale. */
function compactSecond(card: LimitCard, ctx: ViewContext, asOf: number): Line {
  const width = ctx.width - 1;
  const indent = seg("   ", "fg");
  const pace = paceLine(card, width - 3, ctx, asOf);
  const age = staleNote(card, asOf);
  return firstFit(
    [
      { left: [indent, ...pace.left, ...(age === null ? [] : [seg(`  ${age}`, "dim")])] },
      { left: [indent, ...pace.left] },
    ],
    width,
  );
}

/**
 * Two lines per card (the name, 5h and week; the pace and its verdict), in the first shape
 * that fits every card: with meters, without them, without the provider, with shorter
 * labels, then without the reset countdowns.
 */
function compactLines(
  vm: OverviewVM,
  cards: readonly LimitCard[],
  ctx: ViewContext,
  selected: number | null,
): Line[] {
  const widest = (texts: string[]) => Math.max(0, ...texts.map((t) => textWidth(t)));
  const full = Math.min(22, widest(cards.map((c) => `${c.label} · ${c.provider}`)));
  const label = Math.min(14, widest(cards.map((c) => c.label)));
  const shapes: CompactShape[] = [
    { provider: true, name: full, cells: 8, resets: true },
    { provider: true, name: full, cells: 0, resets: true },
    { provider: false, name: label, cells: 0, resets: true },
    { provider: false, name: Math.min(label, 9), cells: 0, resets: true },
    { provider: false, name: Math.min(label, 9), cells: 0, resets: false },
  ];
  const shape =
    shapes.find((sh) =>
      cards.every((c) => segsWidth(compactFirst(c, sh, vm.asOf).left) <= ctx.width - 1),
    ) ?? (shapes[shapes.length - 1] as CompactShape);
  const lines = cards.flatMap((c, i) => {
    const pair = [compactFirst(c, shape, vm.asOf), compactSecond(c, ctx, vm.asOf)];
    return i === selected ? pair.map((l): Line => ({ ...l, bg: "sel" })) : pair;
  });
  if (vm.agents !== null) {
    const lead = [seg(" ◆ ", "live"), seg("MCP  ", "mute")];
    for (const line of agentLines(vm.agents, ctx.width - 9, vm.asOf, false)) {
      lines.push({ ...line, left: [...lead, ...line.left] });
    }
  }
  return lines;
}

function limitsSection(vm: OverviewVM, state: OverviewState, ctx: ViewContext): Section {
  const note = [
    "pace (30m) = spend rate over the last 30 min · avg = this week so far · <2h = within 2 h · estimates",
    "pace = last 30 min · avg = this week so far · <2h = within 2 h · estimates",
    "pace = last 30 min · avg = this week so far · estimates",
    "pace = last 30 min · estimates",
  ].find((n) => textWidth(" LIMITS") + 2 + textWidth(`${n} `) <= ctx.width);
  const title = sectionLine("LIMITS", note);
  const cards = vm.cards;
  if (cards === null || (cards.length === 0 && vm.agents === null)) {
    const text =
      cards === null
        ? "reading limits…"
        : ctx.scope === null
          ? `no enabled accounts: add one in settings (${GLOBAL_KEYS.settings.show})`
          : "no limits for this account";
    const lines = [title, { left: [seg(`  ${text}`, "dim")] }];
    return {
      id: "limits",
      priority: 1,
      height: lines.length,
      render: (height) => <Lines theme={ctx.theme} lines={lines} height={height} />,
    };
  }
  const selected = state.card !== null && state.card < cards.length ? state.card : null;
  const compact = [title, ...compactLines(vm, cards, ctx, selected)];
  const grid = ctx.bp !== "narrow";
  const perRow = cardsPerRow(ctx.bp);
  const boxes: {
    titles: readonly string[];
    role: Role;
    note: string | null;
    body: (w: number) => Line[];
  }[] = cards.map((c, i) => {
    const mark = i === selected ? "▸ " : "";
    // Roots on one account are titled "a + b": the provider goes before their labels are cut.
    return {
      titles: [`${mark}${c.label} · ${c.provider}`, `${mark}${c.label}`],
      role: i === selected ? "live" : "head",
      note: staleNote(c, vm.asOf),
      body: (w) => cardBody(c, w, ctx, vm.asOf),
    };
  });
  const agents = vm.agents;
  if (agents !== null) {
    boxes.push({
      titles: ["agents · MCP"],
      role: "live",
      note: null,
      body: (w) => agentLines(agents, w, vm.asOf),
    });
  }
  const full = grid ? 1 + Math.ceil(boxes.length / perRow) * CARD_HEIGHT : compact.length;
  return {
    id: "limits",
    priority: 1,
    height: full,
    // Limits first: every section below goes before the cards shrink (T10 critique Q2).
    minHeight: full,
    render(height) {
      if (!grid || height < full) {
        return <Lines theme={ctx.theme} lines={compact} height={height} />;
      }
      // Integer widths, one margin cell each side, two between cards (gen.py overview_a).
      // The cards are drawn as text, as gen.py does: one renderable for the whole grid
      // mounts in a fraction of the time of a card renderable per account.
      const widths = splitWidth(ctx.width - 2, perRow, 2);
      const lines: Line[] = [title];
      for (let i = 0; i < boxes.length; i += perRow) {
        const row = boxes
          .slice(i, i + perRow)
          .map((b, k) => cardText(b.titles, b.role, b.note, b.body, widths[k] as number));
        for (let r = 0; r < CARD_HEIGHT; r++) {
          lines.push({
            left: [
              seg(" ", "fg"),
              ...row.flatMap((card, k) => [
                ...(k > 0 ? [seg("  ", "fg")] : []),
                ...(card[r] as Seg[]),
              ]),
            ],
          });
        }
      }
      return <Lines theme={ctx.theme} lines={lines} height={height} />;
    },
  };
}

// ── spend ──────────────────────────────────────────────────────────────────────────

/**
 * Cost and tokens for today, this week, this month and all-time (calendar periods, as in
 * History), with the rolling last hour and 5 hours first on wide screens. When it doesn't
 * fit it switches to compact money, then drops columns, so no number is ever cut.
 */
function spendSection(vm: OverviewVM, ctx: ViewContext): Section {
  const calendar: readonly SpendColumn[] = SPEND_PERIODS;
  const rolling: readonly SpendColumn[] = ["1h", "5h", ...calendar];
  const attempts: [readonly SpendColumn[], boolean][] = [
    ...(ctx.bp === "wide"
      ? ([
          [rolling, false],
          [rolling, true],
        ] as [readonly SpendColumn[], boolean][])
      : []),
    [calendar, false],
    [calendar, true],
    [["today", "this_week", "all"], true],
    [["today", "all"], true],
  ];
  const build = (columns: readonly SpendColumn[], short: boolean): Line[] => {
    const costs = columns.map((p) => costText(vm.spend[p], short));
    const counts = columns.map((p) => tokens(vm.spend[p].tokens));
    const widths = columns.map((p, i) =>
      Math.max(
        short ? 0 : 13,
        2 +
          Math.max(
            SPEND_LABELS[p].length,
            textWidth((costs[i] as { text: string }).text),
            textWidth(counts[i] as string),
          ),
      ),
    );
    const cell = (i: number, text: string, role: Role, bold = false) =>
      seg(fit(text, widths[i] as number, "right"), role, bold);
    const lines: Line[] = [
      {
        left: [seg(fit("", 8), "dim"), ...columns.map((p, i) => cell(i, SPEND_LABELS[p], "dim"))],
      },
    ];
    if (ctx.showCost) {
      lines.push({
        left: [
          seg(fit("  cost", 8), "mute"),
          ...costs.map((c, i) => cell(i, c.text, c.role, c.role === "cost")),
        ],
      });
    }
    lines.push({
      left: [seg(fit("  tokens", 8), "mute"), ...counts.map((t, i) => cell(i, t, "tokens"))],
    });
    return lines;
  };
  let columns = attempts[attempts.length - 1] as [readonly SpendColumn[], boolean];
  for (const attempt of attempts) {
    if (build(...attempt).every((l) => segsWidth(l.left) <= ctx.width)) {
      columns = attempt;
      break;
    }
  }
  const note = ctx.showCost ? costNote(columns[0].map((p) => vm.spend[p])) : null;
  const lines = [sectionLine("SPEND", note ?? undefined), ...build(...columns)];
  return {
    id: "spend",
    priority: 2,
    height: lines.length,
    render: (height) => <Lines theme={ctx.theme} lines={lines} height={height} />,
  };
}

// ── activity and top models ────────────────────────────────────────────────────────

/**
 * The series summed into the most columns that fit `width` at a cell each: the fewest
 * neighbouring buckets per column that divide them evenly, so the finest whole bucket that
 * fits. 288 five-minute buckets make 96 columns of 15 minutes in 98 cells, and 72 of 20
 * minutes in 73. The chart spreads the columns over the whole width (`columnEdges`), and a
 * finer bucket on narrower bars beats a coarser one on wider bars: 168 hours make 84
 * columns of 2 h, 1 to 2 cells wide, in 150 cells, and are drawn by the hour from 168.
 */
export function fitBuckets(
  values: readonly number[],
  width: number,
): { values: number[]; group: number } {
  const n = values.length;
  let group = Math.max(1, n);
  for (let g = 1; g <= n; g++) {
    if (n % g === 0 && n / g <= width) {
      group = g;
      break;
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i += group) {
    let sum = 0;
    for (let k = i; k < i + group; k++) sum += values[k] as number;
    out.push(sum);
  }
  return { values: out, group };
}

function per(minutes: number): string {
  if (minutes % 60 !== 0) return `${minutes} min`;
  return minutes === 60 ? "hour" : `${minutes / 60} h`;
}

const fastTail = (m: TopModel) => (m.tier === "fast" ? " (fast)" : "");

/**
 * The models' labels (`Sonnet 4.6`, `Opus 4.8 (fast)`) in at most `width` cells: whole when
 * they fit. Otherwise a label is cut, never its "(fast)": at the end, then in the middle
 * keeping more of the end (the version), until no two labels read the same.
 */
export function fitLabels(models: readonly TopModel[], width: number): string[] {
  const whole = models.map((m) => `${m.name}${fastTail(m)}`);
  if (whole.every((l) => textWidth(l) <= width)) return whole;
  const cut = (keep: number) =>
    models.map((m, i) => {
      const label = whole[i] as string;
      if (textWidth(label) <= width) return label;
      const room = Math.max(0, width - textWidth(fastTail(m)) - 1);
      const end = Math.min(keep, Math.max(0, room - 1), m.name.length);
      return `${clip(m.name, room - end)}…${m.name.slice(m.name.length - end)}${fastTail(m)}`;
    });
  for (let keep = 0; keep < width; keep++) {
    const labels = cut(keep);
    if (new Set(labels).size === labels.length) return labels;
  }
  return cut(0);
}

/** Cells the top models' cost (or tokens) column takes: its widest text, at least 9. */
function amountWidth(models: readonly TopModel[], costs: boolean): number {
  const texts = models.map((m) => (costs ? costText(m).text : tokens(m.tokens)));
  return Math.max(9, ...texts.map((t) => textWidth(t)));
}

/**
 * The top models' table: by cost, or by tokens when the chart shows tokens. The names keep
 * their width (`min`): the bar, then the share, go before a name is cut.
 */
function topColumns(costs: boolean, labels: readonly string[], rows: readonly TopModel[]) {
  const label = new Map(rows.map((m, i) => [m, labels[i] as string]));
  const columns: Column<TopModel>[] = [
    {
      title: "model",
      width: "fill",
      min: Math.max(0, ...labels.map((l) => textWidth(l))),
      role: "fg",
      text: (m) => label.get(m) ?? m.name,
    },
    costs
      ? {
          title: "cost",
          width: 9,
          align: "right",
          role: (m) => costText(m).role,
          text: (m) => costText(m).text,
        }
      : {
          title: "tokens",
          width: 9,
          align: "right",
          role: "tokens",
          text: (m) => tokens(m.tokens),
        },
    {
      title: "share",
      width: 4,
      align: "right",
      role: "mute",
      text: (m) => percent(m.share, 0),
      drop: 2,
    },
    { title: "", width: 6, role: costs ? "cost" : "tokens", bar: (m) => m.share, drop: 3 },
  ];
  return columns;
}

/**
 * The chart and its window's top models: beside it on wide screens, else a section below it,
 * one row taller for the Models hint when `spare` (a row no section wants).
 */
function activitySections(
  vm: OverviewVM,
  state: OverviewState,
  ctx: ViewContext,
  spare: boolean,
): Section[] {
  const costs = ctx.showCost && !state.tokens;
  const series: ActivitySeries = vm.activity[state.window];
  const ranked = vm.topModels[state.window];
  const models = costs ? ranked.byCost : ranked.byTokens;
  const beside = ctx.bp === "wide";
  // Top models whole: margin, names, amount, share and bar, with a gap between each.
  const amountCells = amountWidth(models, costs);
  const widestName = Math.max(0, ...fitLabels(models, 999).map((l) => textWidth(l)));
  const topNeeds = 1 + widestName + 1 + amountCells + 1 + 4 + 1 + 6;
  const topWidth = Math.max(
    TOP_WIDTH,
    Math.min(TOP_MAX_WIDTH, Math.max(topNeeds, ctx.width - 2 - (CHART_LABEL_WIDTH + 1 + 96))),
  );
  const chartWidth = beside ? ctx.width - topWidth - 2 : ctx.width;
  const plotted = fitBuckets(
    costs ? series.cost : series.tokens,
    chartWidth - CHART_LABEL_WIDTH - 1,
  );
  // The title, the y scale and the peak all speak of the bucket actually drawn.
  const bucketMs = series.bucketMs * plotted.group;
  let peak = 0;
  plotted.values.forEach((v, i) => {
    if (v > (plotted.values[peak] as number)) peak = i;
  });
  const peakValue = plotted.values[peak] ?? 0;
  const at = when(series.from + peak * bucketMs, vm.asOf, ctx.tz);
  const note =
    peakValue > 0 ? `peak ${costs ? money(peakValue) : tokens(peakValue)} at ${at}` : undefined;
  // The title, then the window's tab strip flush right; narrow, the title gives way first.
  const metric = `ACTIVITY · ${costs ? "cost" : "tokens"} per ${per(bucketMs / 60_000)}`;
  const header = tabsHeader(
    [
      ...(beside || note === undefined
        ? []
        : [[seg(` ${metric}`, "head", true), seg(` · ${note}`, "dim")]]),
      [seg(` ${metric}`, "head", true)],
      [seg(" ACTIVITY", "head", true)],
    ],
    WINDOW_TABS,
    ACTIVITY_WINDOWS.indexOf(state.window),
    chartWidth,
  );
  const topRows = Math.max(1, models.length);
  const chart = (height: number) => (
    <box flexDirection="column" width={chartWidth} height={height} flexShrink={0}>
      <Lines theme={ctx.theme} lines={[header]} />
      <th-vchart
        values={plotted.values}
        colorRole={costs ? "cost" : "tokens"}
        format={costs ? moneyShort : tokens}
        xLabels={X_LABELS[state.window]}
        labelWidth={CHART_LABEL_WIDTH}
        theme={ctx.theme}
        height={height - 1}
        flexShrink={0}
      />
    </box>
  );
  const top = (width: number, height: number, peakNote?: string) => {
    const tableWidth = Math.min(width, Math.max(TOP_TABLE_WIDTH, topNeeds)) - 1;
    // Names never cut while the bar and the share can go: the room they then have.
    const labels = fitLabels(models, tableWidth - amountCells - 1);
    // gen.py puts the peak under the list, a blank line apart, when it sits beside the chart.
    const showPeak =
      peakNote !== undefined && height >= topRows + 3 && textWidth(peakNote) + 1 <= width;
    // The hint takes a row only once the list and the peak have theirs.
    const showHint =
      height >= topRows + 2 + (showPeak ? 2 : 0) && textWidth(MODELS_HINT) + 1 <= width;
    return (
      <box flexDirection="column" width={width} height={height} flexShrink={0}>
        <Lines theme={ctx.theme} lines={[sectionLine(`TOP MODELS · ${state.window}`)]} />
        {models.length === 0 ? (
          <Lines
            theme={ctx.theme}
            lines={[{ left: [seg(`  no usage in the last ${SPANS[state.window]}`, "dim")] }]}
          />
        ) : (
          <Table
            columns={topColumns(costs, labels, models)}
            rows={models}
            theme={ctx.theme}
            header={false}
            height={Math.min(height - 1, models.length)}
            // Wider would push the numbers far from the names.
            width={tableWidth}
            marginLeft={1}
          />
        )}
        {showHint ? (
          <Lines theme={ctx.theme} lines={[{ left: [seg(` ${MODELS_HINT}`, "dim")] }]} />
        ) : null}
        {showPeak ? (
          <Lines theme={ctx.theme} lines={[{ left: [] }, { left: [seg(` ${peakNote}`, "dim")] }]} />
        ) : null}
      </box>
    );
  };
  const activity: Section = {
    id: ACTIVITY,
    priority: 3,
    height: 2 + CHART_ROWS,
    minHeight: beside ? Math.max(5, 1 + topRows) : 5,
    render: (height) =>
      beside ? (
        <box flexDirection="row" height={height} flexShrink={0} columnGap={2}>
          {chart(height)}
          {top(topWidth, height, note)}
        </box>
      ) : (
        chart(height)
      ),
  };
  if (beside) return [activity];
  return [
    activity,
    {
      id: "top",
      priority: 4,
      height: 1 + topRows + (spare ? 1 : 0),
      minHeight: 1 + topRows,
      render: (height) => top(ctx.width, height),
    },
  ];
}

// ── limit events ───────────────────────────────────────────────────────────────────

function eventText(e: OverviewEvent, short: boolean): Seg {
  const window = e.window.toLowerCase();
  if (e.kind === "reached") {
    return seg(short ? `${window} 100%` : `${window} limit reached`, "high", true);
  }
  if (e.kind === "passed_80") {
    return seg(short ? `${window} 80%` : `${window} passed 80%`, "mid", true);
  }
  return seg(`${window} resumed`, "live", true);
}

/**
 * When the work could go on: "resumed 17:00", or the reset still to come. No MCP wait data
 * reaches the store (the heartbeat keeps 10 minutes of calls), so it never says how long
 * agents waited.
 */
function eventNote(e: OverviewEvent, asOf: number, tz: string): string {
  if (e.kind !== "reached") return "—";
  if (e.resumedAt !== null) return `resumed ${when(e.resumedAt, e.at, tz)}`;
  return e.resetsAt > asOf ? `resets ${when(e.resetsAt, asOf, tz)}` : "—";
}

/**
 * The events the list shows, in its order: `reached` first, then the rest, each newest
 * first. A `resumed` event already shows as the note of the `reached` event it closed.
 */
export function listedEvents(vm: OverviewVM): OverviewEvent[] {
  const closed = new Set(
    vm.events
      .filter((e) => e.kind === "reached" && e.resumedAt !== null)
      .map((e) => `${e.account}\0${e.window}\0${e.resumedAt}`),
  );
  return vm.events
    .filter((e) => e.kind !== "resumed" || !closed.has(`${e.account}\0${e.window}\0${e.at}`))
    .sort((a, b) => Number(b.kind === "reached") - Number(a.kind === "reached"));
}

function eventsSection(vm: OverviewVM, ctx: ViewContext): Section {
  const title = sectionLine("LIMIT EVENTS · 7 days");
  const events = listedEvents(vm);
  if (events.length === 0) {
    const lines = [title, { left: [seg("  no limit events in the last 7 days", "dim")] }];
    return {
      id: "events",
      priority: 5,
      height: lines.length,
      render: (height) => <Lines theme={ctx.theme} lines={lines} height={height} />,
    };
  }
  const accountWidth = Math.min(14, Math.max(...events.map((e) => textWidth(e.account))));
  const build = (short: boolean, account: boolean, note: boolean) => {
    const what = Math.max(...events.map((e) => textWidth(eventText(e, short).text)));
    return events.map(
      (e): Line => ({
        left: [
          seg(`  ${fit(dayClock(e.at, ctx.tz), 11)}`, "dim"),
          // Cut to the column, then two cells apart: a long label (a shared account's) never
          // runs into the event.
          ...(account ? [seg(fit(truncate(e.account, accountWidth), accountWidth + 2), "fg")] : []),
          { ...eventText(e, short), text: fit(eventText(e, short).text, what + 2) },
          ...(note ? [seg(eventNote(e, vm.asOf, ctx.tz), "mute")] : []),
        ],
      }),
    );
  };
  const shapes: [boolean, boolean, boolean][] = [
    [false, true, true],
    [true, true, true],
    [true, true, false],
    [true, false, false],
  ];
  let rows = build(true, false, false);
  for (const shape of shapes) {
    const candidate = build(...shape);
    if (candidate.every((l) => segsWidth(l.left) <= ctx.width - 1)) {
      rows = candidate;
      break;
    }
  }
  // Every event that doesn't fit is counted on a last line (critique m1), so a short list
  // never reads as the whole week.
  const shown = (room: number): Line[] =>
    rows.length <= room
      ? rows
      : [
          ...rows.slice(0, Math.max(0, room - 1)),
          { left: [seg(`  +${rows.length - Math.max(0, room - 1)} more events`, "dim")] },
        ];
  return {
    id: "events",
    priority: 5,
    height: 1 + Math.min(rows.length, EVENT_ROWS),
    minHeight: 1 + Math.min(rows.length, 2),
    render: (height) => (
      <Lines theme={ctx.theme} lines={[title, ...shown(height - 1)]} height={height} />
    ),
  };
}

// ── the view ───────────────────────────────────────────────────────────────────────

function cycle<T>(items: readonly T[], at: T, step: number): T {
  const i = items.indexOf(at);
  return items[(i + step + items.length) % items.length] as T;
}

const keymap: Keymap<OverviewState, OverviewVM | undefined> = [
  moveKey("tabs", {
    label: "window",
    does: `Switch the activity and top models window: ${ACTIVITY_WINDOWS.join(" · ")}`,
    // The chart's: with no room for it, there's nothing on screen to switch.
    section: ACTIVITY,
    act: (state, _vm, key) => ({
      ...state,
      window: cycle(ACTIVITY_WINDOWS, state.window, key === "right" ? 1 : -1),
    }),
  }),
  moveKey("select", {
    label: "card",
    does: "Select an account card (none is selected at first)",
    act: (state, vm, key) => {
      const n = vm?.cards?.length ?? 0;
      if (n === 0) return undefined;
      const at = state.card === null ? 0 : state.card + (key === "down" ? 1 : -1);
      return { ...state, card: Math.max(0, Math.min(n - 1, at)) };
    },
  }),
  moveKey("open", {
    label: "open",
    does: "Open the selected card's account in Accounts (the first card's when none is selected)",
    act: (state, vm) => {
      const cards = vm?.cards ?? [];
      const card = cards[state.card !== null && state.card < cards.length ? state.card : 0];
      if (card === undefined || card.account === null) return undefined;
      return withCommand(state, { type: "open", view: "accounts", account: card.account });
    },
  }),
  moveKey("back", {
    label: "back",
    does: "Clear the card selection",
    when: (state) => state.card !== null,
    act: (state) => (state.card === null ? undefined : { ...state, card: null }),
  }),
  {
    keys: ["t"],
    show: "t",
    label: "cost/tokens",
    does: "Show cost or tokens in the activity chart and the top models",
    section: ACTIVITY,
    act: (state) => ({ ...state, tokens: !state.tokens }),
  },
];

export const overview: View<OverviewVM, OverviewState> = {
  id: "overview",
  title: "Overview",
  keymap,
  initial: { window: "24h", tokens: false, card: null },
  sections: (vm, state, ctx) => {
    const limits = limitsSection(vm, state, ctx);
    const spend = spendSection(vm, ctx);
    const events = eventsSection(vm, ctx);
    const all = (spare: boolean) => [
      limits,
      spend,
      ...activitySections(vm, state, ctx, spare),
      events,
    ];
    const whole = all(false);
    // A row left with every section at its full height: none of them is short of it.
    const used = whole.reduce(
      (n, s, i) => n + s.height + (i < whole.length - 1 ? (s.gap ?? 1) : 0),
      0,
    );
    return ctx.height !== undefined && ctx.height > used ? all(true) : whole;
  },
};
