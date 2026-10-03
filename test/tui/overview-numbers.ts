// What must appear whole on the Overview (T11 AC 1): every number of the view model, for
// every section on screen. Shared by the TUI's and `--once`'s tests.
import { expect } from "bun:test";
import type { Config } from "../../src/config.ts";
import { clock, countdown, money, tokens } from "../../src/tui/format.ts";
import { costText } from "../../src/tui/views/cells.ts";
import { fitBuckets, listedEvents } from "../../src/tui/views/overview.tsx";
import type {
  ActivityWindow,
  LimitCard,
  OverviewVM,
  Priced,
  SpendColumn,
} from "../../src/tui/vm/types.ts";
import { TZ } from "./fixture.ts";
import { appearsWhole, expectWhole } from "./whole.ts";

const pct = (u: number) => `${Math.round(u * 100)}%`;
const day = (t: number) =>
  `${new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" }).format(t)} ${clock(t, TZ)}`;
const sameDay = (a: number, b: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(a) ===
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(b);
const when = (t: number, asOf: number) => (sameDay(t, asOf) ? clock(t, TZ) : day(t));

function paceText(c: LimitCard, showCost: boolean): string {
  if (!showCost) return `${tokens(c.pace.tokens)}/h`;
  const v = c.pace.cost;
  if (v >= 10) return `$${Math.round(v)}/h`;
  if (v >= 1) return `$${v.toFixed(1)}/h`;
  return v > 0 ? `$${v.toFixed(2)}/h` : "$0/h";
}

/**
 * Every number of the cards: meters, countdowns, the pace, the verdict's time or share (a
 * weekly window's part of a day, an idle card's full window), the age.
 */
function cardNumbers(vm: OverviewVM, showCost: boolean, resets: boolean): string[] {
  const out: string[] = [];
  for (const c of vm.cards ?? []) {
    out.push(paceText(c, showCost));
    if (c.signedIn && c.capturedAt !== null) {
      for (const m of [c.fiveHour, c.week]) {
        if (m === null) continue;
        out.push(pct(m.utilization));
        if (resets) out.push(countdown(m.resetsAt - vm.asOf));
      }
      if (vm.asOf - c.capturedAt > 15 * 60_000) {
        out.push(`(${countdown(vm.asOf - c.capturedAt)} old)`);
      }
    }
    const v = c.verdict;
    // A weekly window's time is a part of a day (T18): `~Sun evening`, whole.
    if (v.kind === "hits") out.push(v.rough ?? when(v.at, vm.asOf));
    if (v.kind === "full") out.push(when(v.until, vm.asOf));
    if (v.kind === "week") out.push(`~${pct(v.utilization)}`);
    if (v.kind === "idle" && v.high !== null)
      out.push(`${v.high.window} ${pct(v.high.utilization)}`);
  }
  for (const call of vm.agents?.calls ?? []) {
    out.push(vm.asOf - call.at < 60_000 ? "<1m" : countdown(vm.asOf - call.at));
  }
  return out;
}

/** The forms a cost may take on screen: full money, else compact. */
const costForms = (p: Priced) => [costText(p).text, costText(p, true).text];

/**
 * Checks every number of every Overview section on screen. Which spend columns show is read
 * off the header row, and the chart's bucket from the same width rule the view uses; the
 * peak note, its amount and time, and the top models are `window`'s (the chart's tab).
 */
export function expectOverviewWhole(
  text: string,
  vm: OverviewVM,
  width: number,
  config: Config,
  window: ActivityWindow = "24h",
) {
  const show = config.show_cost;
  const numbers = cardNumbers(vm, show, true);
  const alternatives: string[][] = [];
  if (text.includes(" SPEND")) {
    const header = text.split("\n").find((l) => l.includes("today")) ?? "";
    const columns: SpendColumn[] = ["today", "all"];
    if (/\b1h\b/.test(header)) columns.push("1h", "5h");
    if (header.includes("this week")) columns.push("this_week");
    if (header.includes("this month")) columns.push("this_month");
    for (const col of columns) {
      numbers.push(tokens(vm.spend[col].tokens));
      if (show) alternatives.push(costForms(vm.spend[col]));
    }
  }
  if (text.includes(" ACTIVITY")) {
    const series = vm.activity[window];
    const beside = width >= 120;
    const top = Math.max(38, Math.min(56, width - 2 - 103));
    const plot = (beside ? width - top - 2 : width) - 7;
    const { values, group } = fitBuckets(show ? series.cost : series.tokens, plot);
    const peak = values.indexOf(Math.max(...values));
    const amount = show ? money(values[peak] as number) : tokens(values[peak] as number);
    // The time is the start of the drawn bucket: it moves with the bucket's size (T24).
    const at = when(series.from + peak * group * series.bucketMs, vm.asOf);
    if (text.includes("peak ")) numbers.push(`peak ${amount} at ${at}`);
  }
  if (text.includes(" TOP MODELS")) {
    // The list is the chart's window's (T27).
    const ranked = vm.topModels[window];
    for (const m of show ? ranked.byCost : ranked.byTokens) {
      // Each model's name whole, and its tier (critique M1).
      numbers.push(`${m.name}${m.tier === "fast" ? " (fast)" : ""}`);
      if (show) alternatives.push(costForms(m));
      else numbers.push(tokens(m.tokens));
    }
  }
  if (text.includes(" LIMIT EVENTS")) {
    // The events on screen are the list's first ones; any others are counted as "+N more".
    const listed = listedEvents(vm);
    const more = Number(/\+(\d+) more events/.exec(text)?.[1] ?? 0);
    for (const e of listed.slice(0, listed.length - more)) {
      numbers.push(day(e.at));
      if (e.resumedAt !== null) numbers.push(`resumed ${when(e.resumedAt, e.at)}`);
    }
  }
  expectWhole(text, numbers, width);
  for (const forms of alternatives) {
    expect({ forms, found: forms.some((f) => appearsWhole(text, f)) }).toEqual({
      forms,
      found: true,
    });
  }
}
