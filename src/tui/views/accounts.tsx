// Accounts placeholder (T13 builds list + detail): every account's all-time usage on the
// real view model, and a 30-day spend sparkline for the selected one.
import { type Line, seg } from "../components/base.ts";
import type { Column } from "../components/index.ts";
import { Lines, Table } from "../elements.tsx";
import { dayLabel, money, percent, textWidth, tokens } from "../format.ts";
import { sectionLine } from "../frame.ts";
import type { AccountRow, AccountsVM } from "../vm/types.ts";
import { costText, noteWithLegend } from "./cells.ts";
import type { Section, View, ViewContext } from "./types.ts";

export type AccountsState = { readonly selected: number };

/** A first or last day: `Sep 9`, with the year when it isn't the year of `asOf` (`Oct 2 '25`). */
export function localDay(t: number | null, asOf: number, tz: string): string {
  if (t === null) return "—";
  const key = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
  const day = key(t);
  const label = dayLabel(day).slice(4);
  return day.slice(0, 4) === key(asOf).slice(0, 4) ? label : `${label} '${day.slice(2, 4)}`;
}

/** Narrow, the columns go in this order: share bar, provider, first seen, share %, tokens. */
function columns(vm: AccountsVM, ctx: ViewContext): Column<AccountRow>[] {
  const marker = (a: AccountRow) => (a.id === ctx.scope ? "▸ " : "  ");
  const cols: Column<AccountRow>[] = [
    {
      title: "  account",
      width: "fill",
      min: 14,
      role: (a) => (a.historyOnly ? "mute" : "fg"),
      text: (a) => `${marker(a)}${a.label}${a.historyOnly ? " (history only)" : ""}`,
    },
    { title: "provider", width: 8, role: "mute", text: (a) => a.provider, drop: 5 },
  ];
  if (ctx.showCost) {
    cols.push({
      title: "cost",
      width: 12,
      align: "right",
      role: (a) => costText(a).role,
      bold: (a) => costText(a).role === "cost",
      text: (a) => costText(a).text,
    });
  }
  cols.push({
    title: "tokens",
    width: 8,
    align: "right",
    role: "tokens",
    text: (a) => tokens(a.tokens),
    drop: 2,
  });
  if (ctx.showCost) {
    cols.push({ title: "share", width: 10, role: "cost", bar: (a) => a.share, drop: 6 });
    cols.push({
      title: "",
      width: 5,
      align: "right",
      role: "mute",
      text: (a) => percent(a.share, 0),
      drop: 3,
    });
  }
  const day = (t: number | null) => localDay(t, vm.asOf, vm.tz);
  cols.push({ title: "first", width: 6, role: "dim", text: (a) => day(a.firstSeen), drop: 4 });
  cols.push({ title: "last", width: 6, role: "dim", text: (a) => day(a.lastSeen) });
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
        <Lines
          theme={ctx.theme}
          lines={[
            sectionLine(
              "ACCOUNTS · all time",
              noteWithLegend("ACCOUNTS · all time", "▸ = scope", vm.rows, ctx.showCost, ctx.width),
            ),
          ]}
        />
        <Table
          columns={columns(vm, ctx)}
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
  const total = `  ${money(row.spark.reduce((a, b) => a + b, 0))}`;
  const label: Line = { left: [seg(" spend 30d ", "mute")] };
  // The total keeps its room; the sparkline shows the latest days that fit beside it.
  const sparkWidth = Math.max(0, Math.min(row.spark.length, ctx.width - 11 - textWidth(total) - 1));
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
            width={sparkWidth}
            height={1}
            flexShrink={0}
          />
          <Lines
            theme={ctx.theme}
            lines={[{ left: [seg(total, "cost", true)] }]}
            width={textWidth(total)}
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
