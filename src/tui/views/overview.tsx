// Overview placeholder (T11 builds the real "limits first" view). It already runs on the
// real view model with the shared renderables: account cards, the spend row, the 24 h
// activity chart and the top models, in priority order.
import { type Line, seg, segsWidth } from "../components/base.ts";
import type { Column, XLabel } from "../components/index.ts";
import { chartColumns } from "../components/vchart.ts";
import { Lines, Table } from "../elements.tsx";
import { clock, fit, money, moneyShort, percent, textWidth, tokens } from "../format.ts";
import { sectionLine } from "../frame.ts";
import { cardsPerRow, splitWidth } from "../layout.ts";
import type { Role } from "../theme.ts";
import type { OverviewAccount, OverviewVM, Priced, SpendPeriod, TopModel } from "../vm/types.ts";
import { SPEND_PERIODS } from "../vm/types.ts";
import { costNote, costText } from "./cells.ts";
import type { Section, View, ViewContext } from "./types.ts";

const CARD_HEIGHT = 5;
const CHART_ROWS = 7;
/** The chart's y labels: `188.0M` and `$1.23K` are the widest. */
const CHART_LABEL_WIDTH = 6;
const TOP_WIDTH = 38;
const X_LABELS: readonly XLabel[] = [
  { at: 0, text: "-24h" },
  { at: 0.25, text: "-18h" },
  { at: 0.5, text: "-12h" },
  { at: 0.75, text: "-6h" },
  { at: 1, text: "now" },
];
const PERIOD_LABELS: Readonly<Record<SpendPeriod, string>> = {
  today: "today",
  this_week: "this week",
  this_month: "this month",
  all: "all-time",
};

/** A cost and its tokens, the cost right-aligned in `costWidth` so a card's rows line up. */
function amountSegs(p: Priced, ctx: ViewContext, costWidth: number, bold = false) {
  if (!ctx.showCost) return [seg(tokens(p.tokens), "tokens", bold)];
  const cost = costText(p);
  return [
    seg(fit(cost.text, costWidth, "right"), cost.role, bold && cost.role === "cost"),
    seg(`  ${tokens(p.tokens)}`, "tokens"),
  ];
}

function cardLines(a: OverviewAccount, ctx: ViewContext): Line[] {
  const costWidth = Math.max(
    textWidth(costText(a.today).text),
    textWidth(costText(a.last24h).text),
  );
  return [
    { left: [seg("today ", "mute"), ...amountSegs(a.today, ctx, costWidth, true)] },
    { left: [seg("24h   ", "mute"), ...amountSegs(a.last24h, ctx, costWidth)] },
    { left: [seg(a.historyOnly ? "not signed in here" : "limits: coming soon", "dim")] },
  ];
}

/**
 * One line per account for narrow screens. Every line has the same shape, the first of
 * these that fits: with the provider; without it; compact money ($1.2K); a shorter label;
 * then without the 24 h figure. Numbers are never cut (critique m2).
 */
function compactLines(accounts: readonly OverviewAccount[], ctx: ViewContext): Line[] {
  const value = (p: Priced, short: boolean) =>
    ctx.showCost ? costText(p, short) : { text: tokens(p.tokens), role: "tokens" as const };
  const shapes = [
    { provider: true, short: false, label: 13, day: true },
    { provider: false, short: false, label: 13, day: true },
    { provider: false, short: true, label: 13, day: true },
    { provider: false, short: true, label: 9, day: true },
    { provider: false, short: true, label: 9, day: false },
  ];
  const build = (shape: (typeof shapes)[number]) => {
    const today = accounts.map((a) => value(a.today, shape.short));
    const day = accounts.map((a) => value(a.last24h, shape.short));
    const w1 = Math.max(...today.map((v) => textWidth(v.text)));
    const w2 = Math.max(...day.map((v) => textWidth(v.text)));
    return accounts.map((a, i): Line => {
      const t = today[i] as { text: string; role: Role };
      const d = day[i] as { text: string; role: Role };
      return {
        left: [
          seg(" ● ", a.historyOnly ? "dim" : "live"),
          seg(fit(a.label, shape.label), "fg"),
          ...(shape.provider ? [seg(` ${fit(a.provider, 6)}`, "mute")] : []),
          seg(" today ", "dim"),
          seg(fit(t.text, w1, "right"), t.role),
          ...(shape.day ? [seg("  24h ", "dim"), seg(fit(d.text, w2, "right"), d.role)] : []),
        ],
      };
    });
  };
  for (const shape of shapes) {
    const lines = build(shape);
    if (lines.every((l) => segsWidth(l.left) <= ctx.width - 1)) return lines;
  }
  return build(shapes[shapes.length - 1] as (typeof shapes)[number]);
}

function limitsSection(vm: OverviewVM, ctx: ViewContext): Section {
  const n = vm.accounts.length;
  const perRow = cardsPerRow(ctx.bp);
  const compact = 1 + Math.max(1, n);
  const cards = ctx.bp !== "narrow" && n > 0;
  const full = cards ? 1 + Math.ceil(n / perRow) * CARD_HEIGHT : compact;
  const title = sectionLine("LIMITS", "limits: coming soon");
  return {
    id: "limits",
    priority: 1,
    height: full,
    minHeight: compact,
    render(height) {
      if (n === 0) {
        return (
          <Lines
            theme={ctx.theme}
            lines={[
              title,
              { left: [seg("  no accounts yet: waiting for the first ingest", "dim")] },
            ]}
          />
        );
      }
      if (!cards || height < full) {
        return (
          <Lines
            theme={ctx.theme}
            lines={[title, ...compactLines(vm.accounts, ctx)]}
            height={height}
          />
        );
      }
      // Integer widths, one margin cell each side, two between cards (gen.py overview_a).
      const widths = splitWidth(ctx.width - 2, perRow, 2);
      const rows: OverviewAccount[][] = [];
      for (let i = 0; i < n; i += perRow) rows.push(vm.accounts.slice(i, i + perRow));
      return (
        <box flexDirection="column" height={height} flexShrink={0}>
          <Lines theme={ctx.theme} lines={[title]} />
          {rows.map((row) => (
            <box
              key={(row[0] as OverviewAccount).id}
              flexDirection="row"
              height={CARD_HEIGHT}
              flexShrink={0}
              paddingLeft={1}
              columnGap={2}
            >
              {row.map((a, i) => (
                <th-card
                  key={a.id}
                  title={`${a.label} · ${a.provider}`}
                  theme={ctx.theme}
                  width={widths[i] as number}
                  height={CARD_HEIGHT}
                  flexShrink={0}
                  flexDirection="column"
                >
                  <Lines theme={ctx.theme} lines={cardLines(a, ctx)} />
                </th-card>
              ))}
            </box>
          ))}
        </box>
      );
    },
  };
}

/**
 * The spend table: today, this week, this month and all-time, cost and tokens. When it
 * doesn't fit it switches to compact money, then drops this month, then this week, so no
 * number is ever cut (critique m2).
 */
function spendSection(vm: OverviewVM, ctx: ViewContext): Section {
  const attempts: [readonly SpendPeriod[], boolean][] = [
    [SPEND_PERIODS, false],
    [SPEND_PERIODS, true],
    [["today", "this_week", "all"], true],
    [["today", "all"], true],
  ];
  const build = (periods: readonly SpendPeriod[], short: boolean): Line[] => {
    const costs = periods.map((p) => costText(vm.spend[p], short));
    const counts = periods.map((p) => tokens(vm.spend[p].tokens));
    const widths = periods.map((p, i) =>
      Math.max(
        short ? 0 : 13,
        2 +
          Math.max(
            PERIOD_LABELS[p].length,
            textWidth((costs[i] as { text: string }).text),
            textWidth(counts[i] as string),
          ),
      ),
    );
    const cell = (i: number, text: string, role: Role, bold = false) =>
      seg(fit(text, widths[i] as number, "right"), role, bold);
    const lines: Line[] = [
      {
        left: [seg(fit("", 8), "dim"), ...periods.map((p, i) => cell(i, PERIOD_LABELS[p], "dim"))],
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
  let body = build(...(attempts[attempts.length - 1] as [readonly SpendPeriod[], boolean]));
  for (const [periods, short] of attempts) {
    const lines = build(periods, short);
    if (lines.every((l) => segsWidth(l.left) <= ctx.width)) {
      body = lines;
      break;
    }
  }
  const note = ctx.showCost ? costNote(SPEND_PERIODS.map((p) => vm.spend[p])) : null;
  const lines = [sectionLine("SPEND", note ?? undefined), ...body];
  return {
    id: "spend",
    priority: 2,
    height: lines.length,
    render: (height) => <Lines theme={ctx.theme} lines={lines} height={height} />,
  };
}

/** Each model's share of the 24 h: of the cost, or of the tokens when costs are hidden. */
function topColumns(vm: OverviewVM, ctx: ViewContext): Column<TopModel>[] {
  let dayTokens = 0;
  for (const t of vm.activity.tokens) dayTokens += t;
  const share = (m: TopModel) =>
    ctx.showCost ? m.share : dayTokens > 0 ? m.tokens / dayTokens : 0;
  return [
    {
      title: "model",
      width: "fill",
      role: "fg",
      text: (m) => (m.tier === "fast" ? `${m.model} (fast)` : m.model),
    },
    ctx.showCost
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
      text: (m) => percent(share(m), 0),
      drop: 2,
    },
    { title: "", width: 6, role: ctx.showCost ? "cost" : "tokens", bar: share, drop: 3 },
  ];
}

function topModels(vm: OverviewVM, ctx: ViewContext, width: number, height: number) {
  return (
    <box flexDirection="column" width={width} height={height} flexShrink={0}>
      <Lines theme={ctx.theme} lines={[sectionLine("TOP MODELS · 24h")]} />
      {vm.topModels.length === 0 ? (
        <Lines theme={ctx.theme} lines={[{ left: [seg("  no usage in the last 24 h", "dim")] }]} />
      ) : (
        <Table
          columns={topColumns(vm, ctx)}
          rows={vm.topModels}
          theme={ctx.theme}
          header={false}
          height={Math.min(height - 1, vm.topModels.length)}
          width={width - 1}
          marginLeft={1}
        />
      )}
    </box>
  );
}

function activitySections(vm: OverviewVM, ctx: ViewContext): Section[] {
  const values = ctx.showCost ? vm.activity.cost : vm.activity.tokens;
  const beside = ctx.bp === "wide";
  const chartWidth = beside ? ctx.width - TOP_WIDTH - 2 : ctx.width;
  // What the chart draws: below 72 columns it sums neighbouring buckets, so the title, the
  // y scale and the peak all speak of the same, wider, bucket.
  const { columns } = chartColumns(values, chartWidth - CHART_LABEL_WIDTH - 1);
  const group = columns.length > 0 ? Math.ceil(values.length / columns.length) : 1;
  const minutes = Math.round((vm.activity.bucketMs * group) / 60_000);
  const per =
    minutes % 60 === 0 ? (minutes === 60 ? "hour" : `${minutes / 60} h`) : `${minutes} min`;
  let peak = 0;
  columns.forEach((v, i) => {
    if (v > (columns[peak] as number)) peak = i;
  });
  const peakValue = columns[peak] ?? 0;
  const note =
    peakValue > 0
      ? `peak ${ctx.showCost ? money(peakValue) : tokens(peakValue)} at ${clock(vm.activity.from + peak * group * vm.activity.bucketMs, ctx.tz)}`
      : undefined;
  // The full title with the peak note when both fit; then the title alone; then "ACTIVITY · 24h".
  const full = `ACTIVITY · ${ctx.showCost ? "cost" : "tokens"} per ${per} · 24h`;
  const fits = (title: string, withNote?: string) =>
    textWidth(` ${title}`) + (withNote === undefined ? 0 : textWidth(withNote) + 2) <= chartWidth;
  const shownNote = !beside && note !== undefined && fits(full, note) ? note : undefined;
  const title = fits(full, shownNote) ? full : "ACTIVITY · 24h";
  const topHeight = 1 + Math.max(1, vm.topModels.length);
  const chart = (height: number) => (
    <box flexDirection="column" width={chartWidth} height={height} flexShrink={0}>
      <Lines theme={ctx.theme} lines={[sectionLine(title, shownNote)]} />
      <th-vchart
        values={values}
        colorRole={ctx.showCost ? "cost" : "tokens"}
        format={ctx.showCost ? moneyShort : tokens}
        xLabels={X_LABELS}
        labelWidth={CHART_LABEL_WIDTH}
        theme={ctx.theme}
        height={height - 1}
        flexShrink={0}
      />
    </box>
  );
  const activity: Section = {
    id: "activity",
    priority: 3,
    height: 2 + CHART_ROWS,
    minHeight: beside ? Math.max(5, topHeight) : 5,
    render: (height) =>
      beside ? (
        <box flexDirection="row" height={height} flexShrink={0} columnGap={2}>
          {chart(height)}
          {topModels(vm, ctx, TOP_WIDTH, height)}
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
      height: topHeight,
      // Full width would push the numbers far from the names: cap it like the wide layout.
      render: (height) => topModels(vm, ctx, Math.min(ctx.width, TOP_WIDTH + 22), height),
    },
  ];
}

function eventsSection(ctx: ViewContext): Section {
  const lines: Line[] = [
    sectionLine("LIMIT EVENTS · 7 days"),
    { left: [seg("  limit events: coming soon", "dim")] },
  ];
  return {
    id: "events",
    priority: 5,
    height: lines.length,
    render: (height) => <Lines theme={ctx.theme} lines={lines} height={height} />,
  };
}

export const overview: View<OverviewVM, null> = {
  id: "overview",
  title: "Overview",
  hints: [],
  initial: null,
  keys: () => undefined,
  sections: (vm, _state, ctx) => [
    limitsSection(vm, ctx),
    spendSection(vm, ctx),
    ...activitySections(vm, ctx),
    eventsSection(ctx),
  ],
};
