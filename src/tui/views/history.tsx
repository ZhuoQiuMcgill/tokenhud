// History placeholder (T12 builds the calendar view): the 26-week heat map and a by-day
// table on the real view model, with the selection shared between them.
import { type Line, seg } from "../components/base.ts";
import type { Column, MonthLabel } from "../components/index.ts";
import { Lines, Table } from "../elements.tsx";
import { dayLabel, money, monthName, tokens } from "../format.ts";
import { sectionLine } from "../frame.ts";
import { HEAT_ROLES } from "../theme.ts";
import type { HistoryDay, HistoryVM } from "../vm/types.ts";
import type { Section, View, ViewContext } from "./types.ts";

/** The selected day, as an index into the view model's days; null means today. */
export type HistoryState = { readonly selected: number | null };

const HEAT_WIDTH = 5 + 26 * 2;

function months(vm: HistoryVM): MonthLabel[] {
  const out: MonthLabel[] = [];
  let last = "";
  for (let w = 0; w < vm.weeks; w++) {
    const day = vm.days[w * 7];
    if (!day) continue;
    const month = day.key.slice(5, 7);
    if (month !== last) {
      // A label goes over the first week that starts in the month, except a partial first one.
      if (last !== "" || Number(day.key.slice(8)) <= 7) {
        out.push({ week: w, text: monthName(Number(month)) });
      }
      last = month;
    }
  }
  return out;
}

function detailLines(day: HistoryDay | null, ctx: ViewContext): Line[] {
  if (day === null) return [];
  return [
    { left: [seg(dayLabel(day.key), "head", true)] },
    ...(ctx.showCost
      ? [{ left: [seg("cost    ", "mute"), seg(money(day.cost), "cost", true)] }]
      : []),
    { left: [seg("tokens  ", "mute"), seg(tokens(day.tokens), "tokens")] },
    {
      left: [
        seg("        ", "mute"),
        seg(
          `in ${tokens(day.input)} · out ${tokens(day.output)} · cache ${tokens(day.cache)}`,
          "dim",
        ),
      ],
    },
    { left: [seg("top     ", "mute"), seg(day.topModel ?? "—", "fg")] },
  ];
}

function heatSection(vm: HistoryVM, selected: number, ctx: ViewContext): Section {
  const title: Line = {
    left: [
      seg(` LAST ${vm.weeks} WEEKS · daily ${ctx.showCost ? "cost" : "tokens"}`, "head", true),
    ],
    right: [seg("less ", "dim"), ...HEAT_ROLES.map((r) => seg("■ ", r)), seg("more ", "dim")],
  };
  const values = vm.days.map((d) => (d === null ? null : ctx.showCost ? d.cost : d.tokens));
  const showDetail = ctx.width >= HEAT_WIDTH + 30;
  return {
    id: "heat",
    priority: 2,
    height: 9,
    render: (height) => (
      <box flexDirection="column" height={height} flexShrink={0}>
        <Lines theme={ctx.theme} lines={[title]} />
        <box flexDirection="row" height={height - 1} flexShrink={0} columnGap={3}>
          <th-heat
            values={values}
            weeks={vm.weeks}
            selected={selected}
            months={months(vm)}
            theme={ctx.theme}
            width={HEAT_WIDTH}
            height={height - 1}
            flexShrink={0}
          />
          {showDetail && (
            <box flexDirection="column" paddingTop={1} flexGrow={1}>
              <Lines theme={ctx.theme} lines={detailLines(vm.days[selected] ?? null, ctx)} />
            </box>
          )}
        </box>
      </box>
    ),
  };
}

function tableSection(vm: HistoryVM, selected: number, ctx: ViewContext): Section {
  // Newest first; the selection is a day index, so map it to a row.
  const rows = vm.days.slice(0, vm.today + 1).reverse() as HistoryDay[];
  const columns: Column<HistoryDay>[] = [
    { title: "date", width: 11, role: "fg", text: (d) => dayLabel(d.key) },
    { title: "input", width: 7, align: "right", role: "tokens", text: (d) => tokens(d.input) },
    { title: "output", width: 7, align: "right", role: "tokens", text: (d) => tokens(d.output) },
    { title: "cache", width: 8, align: "right", role: "tokens", text: (d) => tokens(d.cache) },
    ctx.showCost
      ? {
          title: "cost",
          width: 11,
          align: "right",
          role: "cost",
          bold: true,
          text: (d) => money(d.cost),
        }
      : {
          title: "tokens",
          width: 8,
          align: "right",
          role: "tokens",
          text: (d) => tokens(d.tokens),
        },
    { title: "top model", width: "fill", role: "mute", text: (d) => d.topModel ?? "" },
  ];
  return {
    id: "table",
    priority: 1,
    height: 2 + rows.length,
    minHeight: Math.min(4, 2 + rows.length),
    render: (height) => (
      <box flexDirection="column" height={height} flexShrink={0}>
        <Lines theme={ctx.theme} lines={[sectionLine("BY DAY", "↑/↓ day · ←/→ week")]} />
        <Table
          columns={columns}
          rows={rows}
          selected={vm.today - selected}
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
    { key: "↑/↓", label: "day" },
    { key: "←/→", label: "week" },
  ],
  initial: { selected: null },
  keys(key, state, vm) {
    if (vm === undefined) return undefined;
    const step = { up: 1, down: -1, left: -7, right: 7 }[key];
    if (step === undefined) return undefined;
    const current = state.selected ?? vm.today;
    return { selected: Math.max(0, Math.min(vm.today, current + step)) };
  },
  sections(vm, state, ctx) {
    const selected = Math.min(state.selected ?? vm.today, vm.today);
    return [heatSection(vm, selected, ctx), tableSection(vm, selected, ctx)];
  },
};
