// Overview placeholder (T11 builds the real "limits first" view). It already runs on the
// real view model with the shared renderables: account cards, the spend row, the 24 h
// activity chart and the top models, in priority order.
import { type Line, seg } from "../components/base.ts";
import type { Column, XLabel } from "../components/index.ts";
import { Lines, Table } from "../elements.tsx";
import { clock, fit, money, moneyShort, percent, tokens } from "../format.ts";
import { sectionLine } from "../frame.ts";
import { cardsPerRow, splitWidth } from "../layout.ts";
import type { OverviewAccount, OverviewVM, SpendPeriod, TopModel } from "../vm/types.ts";
import { SPEND_PERIODS } from "../vm/types.ts";
import type { Section, View, ViewContext } from "./types.ts";

const CARD_HEIGHT = 5;
const CHART_ROWS = 7;
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

function amountSegs(cost: number, n: number, ctx: ViewContext, bold = false) {
  return ctx.showCost
    ? [seg(money(cost), "cost", bold), seg(`  ${tokens(n)}`, "tokens")]
    : [seg(tokens(n), "tokens", bold)];
}

function cardLines(a: OverviewAccount, ctx: ViewContext): Line[] {
  return [
    { left: [seg("today ", "mute"), ...amountSegs(a.today.cost, a.today.tokens, ctx, true)] },
    { left: [seg("24h   ", "mute"), ...amountSegs(a.last24h.cost, a.last24h.tokens, ctx)] },
    { left: [seg(a.historyOnly ? "not signed in here" : "limits: coming soon", "dim")] },
  ];
}

function compactLine(a: OverviewAccount, ctx: ViewContext): Line {
  const value = (cost: number, n: number) =>
    ctx.showCost
      ? seg(fit(money(cost), 11, "right"), "cost")
      : seg(fit(tokens(n), 8, "right"), "tokens");
  return {
    left: [
      seg(" ● ", a.historyOnly ? "dim" : "live"),
      seg(fit(a.label, 13), "fg"),
      seg(fit(a.provider, 7), "mute"),
      seg("today", "dim"),
      value(a.today.cost, a.today.tokens),
      seg("   24h", "dim"),
      value(a.last24h.cost, a.last24h.tokens),
    ],
  };
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
            lines={[title, ...vm.accounts.map((a) => compactLine(a, ctx))]}
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

function spendSection(vm: OverviewVM, ctx: ViewContext): Section {
  const cell = (text: string, role: Parameters<typeof seg>[1], bold = false) =>
    seg(fit(text, 13, "right"), role, bold);
  const lines: Line[] = [
    sectionLine("SPEND"),
    { left: [seg(fit("", 10), "dim"), ...SPEND_PERIODS.map((p) => cell(PERIOD_LABELS[p], "dim"))] },
  ];
  if (ctx.showCost) {
    lines.push({
      left: [
        seg(fit("  cost", 10), "mute"),
        ...SPEND_PERIODS.map((p) => cell(money(vm.spend[p].cost), "cost", true)),
      ],
    });
  }
  lines.push({
    left: [
      seg(fit("  tokens", 10), "mute"),
      ...SPEND_PERIODS.map((p) => cell(tokens(vm.spend[p].tokens), "tokens")),
    ],
  });
  return {
    id: "spend",
    priority: 2,
    height: lines.length,
    render: (height) => <Lines theme={ctx.theme} lines={lines} height={height} />,
  };
}

const topColumns = (ctx: ViewContext): Column<TopModel>[] => [
  {
    title: "model",
    width: "fill",
    role: "fg",
    text: (m) => (m.tier === "fast" ? `${m.model} (fast)` : m.model),
  },
  ctx.showCost
    ? { title: "cost", width: 9, align: "right", role: "cost", text: (m) => money(m.cost) }
    : { title: "tokens", width: 9, align: "right", role: "tokens", text: (m) => tokens(m.tokens) },
  { title: "share", width: 4, align: "right", role: "mute", text: (m) => percent(m.share, 0) },
  { title: "", width: 6, role: "cost", bar: (m) => m.share },
];

function topModels(vm: OverviewVM, ctx: ViewContext, width: number, height: number) {
  return (
    <box flexDirection="column" width={width} height={height} flexShrink={0}>
      <Lines theme={ctx.theme} lines={[sectionLine("TOP MODELS · 24h")]} />
      {vm.topModels.length === 0 ? (
        <Lines theme={ctx.theme} lines={[{ left: [seg("  no usage in the last 24 h", "dim")] }]} />
      ) : (
        <Table
          columns={topColumns(ctx)}
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
  let peak = 0;
  values.forEach((v, i) => {
    if (v > (values[peak] as number)) peak = i;
  });
  const peakValue = values[peak] ?? 0;
  const note =
    peakValue > 0
      ? `peak ${ctx.showCost ? money(peakValue) : tokens(peakValue)} at ${clock(vm.activity.from + peak * vm.activity.bucketMs, ctx.tz)}`
      : undefined;
  const beside = ctx.bp === "wide";
  const chartWidth = beside ? ctx.width - TOP_WIDTH - 2 : ctx.width;
  const title = `ACTIVITY · ${ctx.showCost ? "cost" : "tokens"} per 20 min · 24h`;
  const topHeight = 1 + Math.max(1, vm.topModels.length);
  const chart = (height: number) => (
    <box flexDirection="column" width={chartWidth} height={height} flexShrink={0}>
      <Lines theme={ctx.theme} lines={[sectionLine(title, beside ? undefined : note)]} />
      <th-vchart
        values={values}
        colorRole={ctx.showCost ? "cost" : "tokens"}
        format={ctx.showCost ? moneyShort : tokens}
        xLabels={X_LABELS}
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
