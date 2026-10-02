// View models and the view-model Worker's protocol. Everything here is plain data that
// crosses postMessage: the UI thread renders it and never queries the store (T6 critic Q1).

import type { Config, Window } from "../../config.ts";
import type { McpActivity } from "../../mcp/heartbeat.ts";
import type { PriceStatus } from "../../query/types.ts";
import type { Provider, RootSource } from "../../sources/roots.ts";
import type { AccountRow, AccountsVM } from "./accounts.ts";
import type { ModelRow, ModelsVM } from "./models.ts";

export type ViewId = "overview" | "history" | "models" | "accounts";
export const VIEW_IDS: readonly ViewId[] = ["overview", "history", "models", "accounts"];

/** A cost and its tokens, with how much of it has a price. */
export interface Priced {
  readonly cost: number;
  readonly tokens: number;
  /** Share of the tokens priced, 0..1 (1 when there are none). Below 1 the cost leaves some out. */
  readonly pricedShare: number;
  /** The part of `cost` priced from an estimated card (e.g. Codex auto-review). */
  readonly estimatedCost: number;
}

export type Amount = Priced;

/** An account as the TUI shows it: the store's account with its display label. */
export interface AccountInfo {
  readonly id: number;
  readonly label: string;
  readonly provider: string;
  /** The root identity, `sha256(resolved root path)[:32]`. */
  readonly identity: string;
  readonly historyOnly: boolean;
}

export type SpendPeriod = "today" | "this_week" | "this_month" | "all";
export const SPEND_PERIODS: readonly SpendPeriod[] = ["today", "this_week", "this_month", "all"];

export interface OverviewAccount extends AccountInfo {
  readonly today: Amount;
  readonly last24h: Amount;
}

export interface TopModel extends Priced {
  readonly model: string;
  readonly tier: "standard" | "fast";
  readonly share: number;
  readonly status: PriceStatus;
}

export interface OverviewVM {
  readonly accounts: readonly OverviewAccount[];
  readonly spend: Readonly<Record<SpendPeriod, Amount>>;
  /** Cost and tokens in 72 buckets of 20 minutes, the last one holding now. */
  readonly activity: {
    readonly from: number;
    readonly bucketMs: number;
    readonly cost: readonly number[];
    readonly tokens: readonly number[];
  };
  /** The 24 h of the activity chart, most cost first, at most 5. */
  readonly topModels: readonly TopModel[];
  /** Share of all-time tokens that have a price. */
  readonly pricedShare: number;
}

/** Tokens split as History's table shows them, with their cost. */
export interface HistoryTotal extends Priced {
  readonly input: number;
  readonly output: number;
  readonly cache: number;
}

/**
 * A model's or an account's part of a period, split like the period itself, so the `/`
 * filter can show one model's numbers alone.
 */
export interface HistoryShare extends HistoryTotal {
  /** A model id, or an account's display label. */
  readonly name: string;
}

/** A local day, Monday-start week or calendar month of usage, as History lists it. */
export interface HistoryPeriod extends HistoryTotal {
  /** YYYY-MM-DD for a day or a week (its Monday), YYYY-MM for a month. */
  readonly key: string;
  /** Its days up to today (1 for a day): the base of its "vs average" ratio. */
  readonly days: number;
  /** Every model used, most cost first, then most tokens. */
  readonly models: readonly HistoryShare[];
  /** Every account with usage, most cost first, then most tokens. */
  readonly accounts: readonly HistoryShare[];
}

/** A limit event (T8) as the day detail shows it. */
export interface HistoryEvent {
  /** The account's display label. */
  readonly account: string;
  /** Reached 100 %, or a weekly window passed 80 %. */
  readonly kind: "reached" | "passed_80";
  /** The window's label when the event was recorded ("5-HOUR", "WEEKLY"). */
  readonly window: string;
  readonly at: number;
  /** For `reached`: when the window was found usable again, or null. */
  readonly resumedAt: number | null;
}

export interface HistoryDay extends HistoryPeriod {
  /** Its limit events, oldest first. */
  readonly events: readonly HistoryEvent[];
}

export interface HistoryVM {
  /** Every day from the 1st of the heat map's first month to today, oldest first. */
  readonly days: readonly HistoryDay[];
  /** Index in `days` of the heat map's first day: the Monday 25 weeks before this week's. */
  readonly gridStart: number;
  /** The heat map's 26 weeks, oldest first; the last runs to today. */
  readonly weeks: readonly HistoryPeriod[];
  /** Whole months from the heat map's first, oldest first; the last runs to today. */
  readonly months: readonly HistoryPeriod[];
  /** The 26 weeks together, and all the months together: the tables' totals rows. */
  readonly weeksTotal: HistoryTotal;
  readonly monthsTotal: HistoryTotal;
  /**
   * How many days before today the "vs average" baseline covers: 30, or fewer when the
   * usage started more recently (0 with none before today). The baseline is the average
   * of those days, the last ones in `days` before today.
   */
  readonly averageDays: number;
  /** Daily cost and tokens averaged over those days: the ratios' baseline. */
  readonly average: { readonly cost: number; readonly tokens: number };
}

export type { AccountRow, AccountsVM, ModelRow, ModelsVM };

export interface ViewModels {
  overview?: OverviewVM;
  history?: HistoryVM;
  models?: ModelsVM;
  accounts?: AccountsVM;
}

/** A discovered root for the settings screen's account editor. */
export interface RootInfo {
  readonly provider: Provider;
  readonly label: string;
  readonly path: string;
  readonly source: RootSource;
  readonly enabled: boolean;
  readonly historyOnly: boolean;
  readonly identity: string;
  /** Entries of `disabled_roots` that disable this root. */
  readonly disabledBy: readonly string[];
  /**
   * Index of the entry in `claude_roots` / `codex_roots` that resolves to this root, if
   * any. It may name the default or env root too: its label then relabels that root.
   */
  readonly configIndex: number | null;
}

/** What the view models depend on besides the store. */
export interface VmSettings {
  /** IANA zone, or null for the system's. */
  readonly tz: string | null;
  /** The Models window (config `default_window`). */
  readonly window: Window;
  /** The account scope: an account id, or null for every account. */
  readonly scope: number | null;
}

/** The view-model settings a config asks for, at an account scope. */
export function vmSettingsOf(config: Config, scope: number | null): VmSettings {
  return {
    tz: config.time_zone === "system" ? null : config.time_zone,
    window: config.default_window,
    scope,
  };
}

export type IngestMode = "owner" | "reader";

export interface VmStart {
  readonly type: "start";
  readonly storePath: string;
  readonly overridesPath: string;
  readonly mcpDir: string;
  /** limits.json; absent, the Accounts view shows no limits. */
  readonly limitsPath?: string;
  /** cache.db, for Codex rate-limit snapshots. */
  readonly cachePath?: string;
  readonly mode: IngestMode;
  readonly settings: VmSettings;
  /** The scope as saved in config (a label), resolved once the accounts are known. */
  readonly scopeLabel: string | null;
  readonly config: Config;
  readonly discover: {
    readonly home: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  };
  /** A frozen clock (tests and snapshots); the real one when absent. */
  readonly now?: number;
}

export type VmRequest =
  | VmStart
  /** Rows were inserted or raised: forwarded from the ingest Worker's `changed`. */
  | {
      readonly type: "changed";
      readonly fromTs: number;
      readonly toTs: number;
      readonly accounts: readonly string[];
    }
  /** Something changed that no range describes (an import, a takeover): drop every cache. */
  | { readonly type: "invalidate" }
  | { readonly type: "settings"; readonly settings: VmSettings }
  | { readonly type: "config"; readonly config: Config }
  | { readonly type: "mode"; readonly mode: IngestMode }
  | { readonly type: "tick" }
  | { readonly type: "roots" }
  | { readonly type: "stop" };

export type VmMessage =
  | {
      readonly type: "views";
      readonly views: ViewModels;
      readonly accounts: readonly AccountInfo[];
      readonly scope: number | null;
      /** Milliseconds the recompute took in the Worker. */
      readonly ms: number;
    }
  | { readonly type: "mcp"; readonly activity: McpActivity }
  | { readonly type: "roots"; readonly roots: readonly RootInfo[] }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "stopped" }
  /** From the supervisor, not the Worker: it died, and restarts after `retryInMs`. */
  | { readonly type: "down"; readonly reason: string; readonly retryInMs: number };

/** The Worker's last word before it exits on an uncaught error: one clean line. */
export interface VmFatal {
  readonly type: "fatal";
  readonly message: string;
}
