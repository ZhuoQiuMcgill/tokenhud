// Models placeholder (T13 builds the rate board): per model and tier over the configured
// window, on the real view model, in one virtual table with a share bar.
import type { Column } from "../components/index.ts";
import { Lines, Table } from "../elements.tsx";
import { percent, tokens } from "../format.ts";
import { sectionLine } from "../frame.ts";
import type { ModelRow, ModelsVM } from "../vm/types.ts";
import { costText } from "./cells.ts";
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

/**
 * The rate board's columns. Narrow, they go in this order: the $/M rates, the share bar,
 * cache, output, input, then the share %; the model and its cost stay.
 */
function columns(ctx: ViewContext, totals: ModelRow): Column<ModelRow>[] {
  const name = (m: ModelRow) =>
    `${m.model || "(no model)"}${m.tier === "fast" ? " (fast)" : ""}${m.status === "priced" ? "" : " *"}`;
  const count = (title: string, f: (m: ModelRow) => number, drop: number): Column<ModelRow> => ({
    title,
    width: 8,
    align: "right",
    role: "tokens",
    text: (m) => tokens(f(m)),
    drop,
  });
  const price = (width: number, f: (m: ModelRow) => number | undefined): Column<ModelRow> => ({
    title: "$/M",
    width,
    align: "right",
    role: "dim",
    text: (m) => rate(f(m)),
    drop: 7,
  });
  const cols: Column<ModelRow>[] = [
    { title: "model", width: "fill", min: 18, role: "fg", text: name },
    count("input", (m) => m.input, 3),
    price(6, (m) => m.rates?.input),
    count("output", (m) => m.output, 4),
    price(6, (m) => m.rates?.output),
    count("cache", (m) => m.cache, 5),
    price(5, (m) => m.rates?.cacheRead),
  ];
  if (ctx.showCost) {
    cols.push({
      title: "cost",
      width: 12,
      align: "right",
      role: (m) => costText(m).role,
      bold: (m) => costText(m).role === "cost",
      text: (m) => costText(m).text,
    });
    cols.push({ title: "share", width: 10, role: "cost", bar: (m) => m.share, drop: 6 });
    cols.push({
      title: "",
      width: 5,
      align: "right",
      role: "mute",
      text: (m) => (m === totals ? "" : percent(m.share)),
      drop: 2,
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
    pricedShare: vm.total.pricedShare,
    estimatedCost: vm.total.estimatedCost,
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
