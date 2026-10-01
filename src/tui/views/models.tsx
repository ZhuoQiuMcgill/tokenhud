// Models placeholder (T13 builds the rate board): per model and tier over the configured
// window, on the real view model, in one virtual table with a share bar.
import type { Column } from "../components/index.ts";
import { Lines, Table } from "../elements.tsx";
import { money, percent, tokens } from "../format.ts";
import { sectionLine } from "../frame.ts";
import type { ModelRow, ModelsVM } from "../vm/types.ts";
import type { Section, View, ViewContext } from "./types.ts";

export type ModelsState = { readonly selected: number };

export const WINDOW_LABELS: Readonly<Record<string, string>> = {
  today: "today",
  this_week: "this week",
  this_month: "this month",
  all: "all time",
  "1h": "last 1h",
  "5h": "last 5h",
  "24h": "last 24h",
};

const rate = (v: number | undefined) => (v === undefined ? "—" : v.toFixed(2));

function columns(ctx: ViewContext, totals: ModelRow): Column<ModelRow>[] {
  const name = (m: ModelRow) =>
    `${m.model || "(no model)"}${m.tier === "fast" ? " (fast)" : ""}${m.status === "priced" ? "" : " *"}`;
  const wide = ctx.bp !== "narrow";
  const cols: Column<ModelRow>[] = [
    { title: "model", width: "fill", role: "fg", text: name },
    { title: "input", width: 8, align: "right", role: "tokens", text: (m) => tokens(m.input) },
  ];
  if (wide)
    cols.push({
      title: "$/M",
      width: 6,
      align: "right",
      role: "dim",
      text: (m) => rate(m.rates?.input),
    });
  cols.push({
    title: "output",
    width: 8,
    align: "right",
    role: "tokens",
    text: (m) => tokens(m.output),
  });
  if (wide)
    cols.push({
      title: "$/M",
      width: 6,
      align: "right",
      role: "dim",
      text: (m) => rate(m.rates?.output),
    });
  cols.push({
    title: "cache",
    width: 8,
    align: "right",
    role: "tokens",
    text: (m) => tokens(m.cache),
  });
  if (wide)
    cols.push({
      title: "$/M",
      width: 5,
      align: "right",
      role: "dim",
      text: (m) => rate(m.rates?.cacheRead),
    });
  if (ctx.showCost) {
    cols.push({
      title: "cost",
      width: 12,
      align: "right",
      role: (m) => (m.status === "unpriced" ? "dim" : "cost"),
      bold: (m) => m.status !== "unpriced",
      text: (m) => (m.status === "unpriced" ? "unpriced" : money(m.cost)),
    });
    cols.push({ title: "share", width: 10, role: "cost", bar: (m) => m.share });
    cols.push({
      title: "",
      width: 5,
      align: "right",
      role: "mute",
      text: (m) => (m === totals ? "" : percent(m.share)),
    });
  }
  return cols;
}

function tableSection(vm: ModelsVM, state: ModelsState, ctx: ViewContext): Section {
  const totals: ModelRow = {
    model: "Total",
    tier: "standard",
    input: vm.total.input,
    output: vm.total.output,
    cache: vm.total.cache,
    tokens: vm.total.tokens,
    cost: vm.total.cost,
    share: 0,
    status: "priced",
    rates: null,
  };
  return {
    id: "models",
    priority: 1,
    height: 1 + 1 + vm.rows.length + 2,
    minHeight: Math.min(5, 4 + vm.rows.length),
    render: (height) => (
      <box flexDirection="column" height={height} flexShrink={0}>
        <Lines
          theme={ctx.theme}
          lines={[
            sectionLine(
              `MODELS · ${WINDOW_LABELS[vm.window] ?? vm.window}`,
              `${percent(vm.pricedShare)} of tokens priced`,
            ),
          ]}
        />
        <Table
          columns={columns(ctx, totals)}
          rows={vm.rows}
          selected={Math.min(state.selected, vm.rows.length - 1)}
          totals={vm.rows.length > 0 ? totals : null}
          theme={ctx.theme}
          height={height - 1}
          width={ctx.width - 1}
          marginLeft={1}
        />
      </box>
    ),
  };
}

export const models: View<ModelsVM, ModelsState> = {
  id: "models",
  title: "Models",
  hints: [{ key: "↑/↓", label: "select" }],
  initial: { selected: 0 },
  keys(key, state, vm) {
    if (vm === undefined || (key !== "up" && key !== "down")) return undefined;
    const last = Math.max(0, vm.rows.length - 1);
    const next = Math.min(state.selected, last) + (key === "down" ? 1 : -1);
    return { selected: Math.max(0, Math.min(last, next)) };
  },
  sections: (vm, state, ctx) => [tableSection(vm, state, ctx)],
};
