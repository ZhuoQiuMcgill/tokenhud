// The Accounts view (T13): every account in the store with its root, its subscription
// limits and their weekly history, its 30-day spend and models, and its last MCP call.
// Computed in the view-model Worker; the view only formats it.

import { sep } from "node:path";
import type { AccountLimits, LimitEvent, Limits, LimitWindow } from "../../limits/index.ts";
import type { McpActivity } from "../../mcp/heartbeat.ts";
import type { Range } from "../../query/types.ts";
import { addDays } from "../../query/tz.ts";
import { onWindowsDrive, type Root } from "../../sources/roots.ts";
import { ALL_TIME, amount, type ComputeContext, type Computed } from "./compute.ts";
import { modelName } from "./models.ts";
import type { AccountInfo, Priced } from "./types.ts";

export const SPARK_DAYS = 30;
/** Weeks in the weekly-usage chart, this one included. */
export const WEEKS_SHOWN = 8;
const WEEK_MS = 7 * 86_400_000;

/** What the Accounts view reads besides usage. */
export interface AccountSources {
  /** Every discovered root, enabled or not. */
  readonly roots: readonly Root[];
  /** limits.json, Codex rollout snapshots and the store's limit events; null when off. */
  readonly limits: Limits | null;
  readonly mcp: McpActivity | null;
  /** Under WSL, Windows roots are polled rather than watched. */
  readonly wsl: boolean;
  /** Shown as `~` in root paths. */
  readonly home: string;
}

export interface LimitMeter {
  readonly kind: string;
  /** "5-HOUR", "WEEKLY", "FABLE WEEKLY", ... */
  readonly label: string;
  /** 0..1 (a provider may report more); 0 once the window has reset. */
  readonly utilization: number;
  readonly resetsAt: number;
}

export interface AccountLimitsInfo {
  /** False: history-only, configured or detected ("not signed in here"). */
  readonly signedIn: boolean;
  /** When the windows were captured; null when nothing ever was. */
  readonly asOf: number | null;
  /** The last fetch error, when the windows are older than it. */
  readonly error: string | null;
  /** In cc-usage's order: 5-HOUR, WEEKLY, then the rest. */
  readonly windows: readonly LimitMeter[];
}

/** One week of the weekly window, as far as anything recorded it. */
export interface WeekSlot {
  /** When that week's window reset (this week's: when it will). */
  readonly resetsAt: number;
  /**
   * This week: its utilisation now, or null when the capture is from an earlier week. A
   * past week: the least it is known to have reached, 1 (a `reached` event) or 0.8
   * (`passed_80`); null when nothing was recorded.
   */
  readonly value: number | null;
  readonly source: "now" | "reached" | "passed_80" | null;
}

export interface ModelSpend {
  readonly name: string;
  readonly cost: number;
  readonly tokens: number;
  /** None of its tokens has a price. */
  readonly unpriced: boolean;
}

export interface AccountRow extends AccountInfo, Priced {
  /** The root this account's transcripts come from here; null when none is found. */
  readonly root: {
    /** The directory, with the home directory as `~`. */
    readonly path: string;
    readonly enabled: boolean;
    /** Polled (a Windows drive under WSL) rather than watched. */
    readonly polled: boolean;
  } | null;
  readonly firstSeen: number | null;
  readonly lastSeen: number | null;
  /** All-time usage rows. */
  readonly records: number;
  /** Share of all accounts' all-time cost. */
  readonly share: number;
  /** Daily cost over the last 30 days, oldest first. */
  readonly spark: readonly number[];
  /** Daily tokens over the same days. */
  readonly sparkTokens: readonly number[];
  readonly last30: Priced;
  /** Models over the last 30 days, both tiers together, most cost first. */
  readonly topModels: readonly ModelSpend[];
  /** Null when no limits are read for it (a disabled or missing root, or limits off). */
  readonly limits: AccountLimitsInfo | null;
  /** The weekly window's last weeks, oldest first; null without a weekly window. */
  readonly weekly: readonly WeekSlot[] | null;
  /** Its newest MCP tool call in the last 10 minutes. */
  readonly agent: { readonly at: number; readonly tool: string; readonly calls: number } | null;
}

export interface AccountsVM {
  /** Accounts active here first, then history-only, disabled or rootless ones; by cost. */
  readonly rows: readonly AccountRow[];
  /** When it was computed (epoch ms) and in which zone: dates show a year unless it's this one. */
  readonly asOf: number;
  readonly tz: string;
  /** An MCP server is running: an account without calls can say so. */
  readonly mcp: boolean;
}

/** `path` with the home directory written `~`. */
export function homePath(path: string, home: string): string {
  if (home === "" || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  return rest === "" || rest.startsWith(sep) || rest.startsWith("/") ? `~${rest}` : path;
}

/** The account's weekly window: the all-models one, else any 7-day window that isn't scoped. */
function weeklyWindow(windows: readonly LimitWindow[]): LimitWindow | undefined {
  return (
    windows.find((w) => w.kind === "weekly_all" || w.kind === "seven_day") ??
    windows.find((w) => w.window_s === WEEK_MS / 1000 && !w.kind.startsWith("weekly_scoped"))
  );
}

/**
 * The weekly window's last `WEEKS_SHOWN` weeks. This week's figure is the capture's; a
 * past week's comes from limit events, which record only that it passed 80 % or reached
 * 100 %, so a week without one is unknown rather than low. Weeks are counted back from
 * this week's reset; an event belongs to the week whose reset is nearest its own.
 */
export function weeklySlots(
  windows: readonly LimitWindow[],
  events: readonly LimitEvent[],
  now: number,
): WeekSlot[] | null {
  const week = weeklyWindow(windows);
  if (week === undefined) return null;
  let current = week.resets_at;
  let value: number | null = week.utilization;
  // A capture of a week that has since reset: this week is the one running now, and
  // nothing is known of it yet.
  while (current <= now) {
    current += WEEK_MS;
    value = null;
  }
  const slots: WeekSlot[] = [];
  for (let k = WEEKS_SHOWN - 1; k >= 0; k--) {
    const resetsAt = current - k * WEEK_MS;
    if (k === 0) {
      slots.push({ resetsAt, value, source: "now" });
      continue;
    }
    const mine = events.filter(
      (e) => e.window === week.kind && Math.abs(e.resets_at - resetsAt) < WEEK_MS / 2,
    );
    if (mine.some((e) => e.kind === "reached")) {
      slots.push({ resetsAt, value: 1, source: "reached" });
    } else if (mine.some((e) => e.kind === "passed_80")) {
      slots.push({ resetsAt, value: 0.8, source: "passed_80" });
    } else {
      slots.push({ resetsAt, value: null, source: null });
    }
  }
  return slots;
}

function limitsInfo(l: AccountLimits): AccountLimitsInfo {
  return {
    signedIn: l.account.signed_in,
    asOf: l.as_of,
    error: l.error,
    windows: l.windows.map((w) => ({
      kind: w.kind,
      label: w.label,
      utilization: w.utilization,
      resetsAt: w.resets_at,
    })),
  };
}

function topModels(ctx: ComputeContext, id: number, range: Range): ModelSpend[] {
  const byName = new Map<string, { cost: number; tokens: number; priced: number }>();
  for (const m of ctx.q.byModel({ range, accounts: [id] })) {
    const name = modelName(m.model);
    const seen = byName.get(name) ?? { cost: 0, tokens: 0, priced: 0 };
    byName.set(name, {
      cost: seen.cost + m.usage.cost,
      tokens: seen.tokens + m.usage.tokens.total,
      priced: seen.priced + m.usage.coverage.pricedTokens,
    });
  }
  return [...byName]
    .map(([name, m]) => ({
      name,
      cost: m.cost,
      tokens: m.tokens,
      unpriced: m.tokens > 0 && m.priced === 0,
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

export function computeAccounts(ctx: ComputeContext): Computed<AccountsVM> {
  const { q, now } = ctx;
  const sources = ctx.sources;
  const summaries = new Map(q.accounts().map((a) => [a.id, a]));
  const usage = new Map(q.byAccount({ period: "all" }).map((a) => [a.account.id, a]));
  const today = ctx.zone.dateAt(now);
  const last30: Range = {
    from: ctx.zone.startOf(addDays(today, -(SPARK_DAYS - 1))),
    to: ctx.zone.startOf(addDays(today, 1)),
  };
  const limits = new Map(
    (sources?.limits?.getLimits() ?? []).map((l) => [`${l.account.provider}\0${l.account.id}`, l]),
  );
  const recent = sources?.mcp?.recent ?? [];
  let validUntil = last30.to;
  const rows: AccountRow[] = ctx.accounts.map((a) => {
    const s = summaries.get(a.id);
    const u = usage.get(a.id);
    const root = sources?.roots.find((r) => r.provider === a.provider && r.identity === a.identity);
    const days = q.byDay({ range: last30, accounts: [a.id] });
    const l = limits.get(`${a.provider}\0${a.identity}`);
    let weekly: WeekSlot[] | null = null;
    if (l !== undefined) {
      // Meters drop to 0 % at their reset: the view is out of date then.
      for (const w of l.windows)
        if (w.resets_at > now) validUntil = Math.min(validUntil, w.resets_at);
      const events =
        sources?.limits?.limitEvents(
          { from: now - (WEEKS_SHOWN + 1) * WEEK_MS, to: now + 1 },
          a.identity,
        ) ?? [];
      weekly = weeklySlots(l.windows, events, now);
    }
    const calls = recent.filter((c) => c.account === a.label);
    const call = calls[0];
    return {
      ...a,
      ...(u === undefined
        ? { cost: 0, tokens: 0, pricedShare: 1, estimatedCost: 0 }
        : amount(u.usage)),
      root:
        root === undefined
          ? null
          : {
              path: homePath(root.path, sources?.home ?? ""),
              enabled: root.enabled,
              polled: (sources?.wsl ?? false) && onWindowsDrive(root),
            },
      firstSeen: s?.firstSeen ?? null,
      lastSeen: s?.lastSeen ?? null,
      records: u?.usage.records ?? 0,
      share: u?.share ?? 0,
      spark: days.map((d) => d.usage.cost),
      sparkTokens: days.map((d) => d.usage.tokens.total),
      last30: amount(q.totals({ range: last30, accounts: [a.id] }).usage),
      topModels: topModels(ctx, a.id, last30),
      limits: l === undefined ? null : limitsInfo(l),
      weekly,
      agent: call === undefined ? null : { at: call.at, tool: call.tool, calls: calls.length },
    };
  });
  // Accounts active here first (signed in, enabled), then the rest; most cost first in each.
  const away = (r: AccountRow) =>
    r.historyOnly || r.limits?.signedIn === false || r.root === null || !r.root.enabled ? 1 : 0;
  rows.sort((x, y) => away(x) - away(y) || y.cost - x.cost || y.tokens - x.tokens || x.id - y.id);
  return {
    vm: { rows, asOf: now, tz: ctx.zone.name, mcp: (sources?.mcp?.servers ?? 0) > 0 },
    deps: [ALL_TIME],
    validUntil,
  };
}
