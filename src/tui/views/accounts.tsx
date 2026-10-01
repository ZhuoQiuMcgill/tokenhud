// Accounts placeholder (T13 builds list + detail): every account's all-time usage on the
// real view model, and a 30-day spend sparkline for the selected one.
import { type Line, seg } from "../components/base.ts";
import type { Column } from "../components/index.ts";
import { Lines, Table } from "../elements.tsx";
import { dayLabel, money, percent, tokens } from "../format.ts";
import { sectionLine } from "../frame.ts";
import type { AccountRow, AccountsVM } from "../vm/types.ts";
import type { Section, View, ViewContext } from "./types.ts";

export type AccountsState = { readonly selected: number };

function localDay(t: number | null, tz: string): string {
  if (t === null) return "—";
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(t);
  return dayLabel(key).slice(4);
}

function columns(ctx: ViewContext): Column<AccountRow>[] {
  const marker = (a: AccountRow) => (a.id === ctx.scope ? "▸ " : "  ");
  const cols: Column<AccountRow>[] = [
    {
      title: "  account",
      width: "fill",
      role: (a) => (a.historyOnly ? "mute" : "fg"),
      text: (a) => `${marker(a)}${a.label}${a.historyOnly ? " (history only)" : ""}`,
    },
    { title: "provider", width: 8, role: "mute", text: (a) => a.provider },
  ];
  if (ctx.showCost) {
    cols.push({
      title: "cost",
      width: 12,
      align: "right",
      role: "cost",
      bold: true,
      text: (a) => money(a.cost),
    });
  }
  cols.push({
    title: "tokens",
    width: 8,
    align: "right",
    role: "tokens",
    text: (a) => tokens(a.tokens),
  });
  if (ctx.showCost && ctx.bp !== "narrow") {
    cols.push({ title: "share", width: 10, role: "cost", bar: (a) => a.share });
    cols.push({
      title: "",
      width: 5,
      align: "right",
      role: "mute",
      text: (a) => percent(a.share, 0),
    });
  }
  cols.push({ title: "first", width: 6, role: "dim", text: (a) => localDay(a.firstSeen, ctx.tz) });
  cols.push({ title: "last", width: 6, role: "dim", text: (a) => localDay(a.lastSeen, ctx.tz) });
  return cols;
}

function listSection(vm: AccountsVM, selected: number, ctx: ViewContext): Section {
  return {
    id: "list",
    priority: 1,
    height: 2 + Math.max(1, vm.rows.length),
    minHeight: Math.min(4, 2 + vm.rows.length),
    render: (height) => (
      <box flexDirection="column" height={height} flexShrink={0}>
        <Lines theme={ctx.theme} lines={[sectionLine("ACCOUNTS · all time", "▸ = scope")]} />
        <Table
          columns={columns(ctx)}
          rows={vm.rows}
          selected={selected}
          theme={ctx.theme}
          height={height - 1}
          width={ctx.width - 1}
          marginLeft={1}
        />
      </box>
    ),
  };
}

function sparkSection(row: AccountRow, ctx: ViewContext): Section {
  const total = row.spark.reduce((a, b) => a + b, 0);
  const label: Line = { left: [seg(" spend 30d ", "mute")] };
  return {
    id: "spark",
    priority: 2,
    height: 2,
    render: (height) => (
      <box flexDirection="column" height={height} flexShrink={0}>
        <Lines theme={ctx.theme} lines={[sectionLine(row.label)]} />
        <box flexDirection="row" height={1} flexShrink={0}>
          <Lines theme={ctx.theme} lines={[label]} width={11} />
          <th-spark
            values={row.spark}
            colorRole="cost"
            theme={ctx.theme}
            width={row.spark.length}
            height={1}
            flexShrink={0}
          />
          <Lines
            theme={ctx.theme}
            lines={[{ left: [seg(`  ${money(total)}`, "cost", true)] }]}
            width={16}
          />
        </box>
      </box>
    ),
  };
}

export const accounts: View<AccountsVM, AccountsState> = {
  id: "accounts",
  title: "Accounts",
  hints: [{ key: "↑/↓", label: "account" }],
  initial: { selected: 0 },
  keys(key, state, vm) {
    if (vm === undefined || (key !== "up" && key !== "down")) return undefined;
    const last = Math.max(0, vm.rows.length - 1);
    const next = Math.min(state.selected, last) + (key === "down" ? 1 : -1);
    return { selected: Math.max(0, Math.min(last, next)) };
  },
  sections(vm, state, ctx) {
    const selected = Math.min(state.selected, Math.max(0, vm.rows.length - 1));
    const row = vm.rows[selected];
    const out = [listSection(vm, selected, ctx)];
    if (row !== undefined && ctx.showCost) out.push(sparkSection(row, ctx));
    return out;
  },
};
