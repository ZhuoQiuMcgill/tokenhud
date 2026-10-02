// View models and the view-model Worker's protocol. Everything here is plain data that
// crosses postMessage: the UI thread renders it and never queries the store (T6 critic Q1).

import type { Config, Window } from "../../config.ts";
import type { GroupSource } from "../../limits/groups.ts";
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

/** The Overview's spend columns: rolling 1 h and 5 h (wide screens), then the calendar ones. */
export type SpendColumn = "1h" | "5h" | SpendPeriod;

export interface TopModel extends Priced {
  readonly model: string;
  /** How the model is written: `Opus 4.8` for `claude-opus-4-8`, other ids as they are. */
  readonly name: string;
  readonly tier: "standard" | "fast";
  readonly share: number;
  readonly status: PriceStatus;
}

/** One limit window on a card: utilisation 0..1 (may exceed 1) and its reset (epoch ms). */
export interface LimitMeter {
  readonly utilization: number;
  readonly resetsAt: number;
}

/**
 * What the pace means for an account's limits, all **estimates** (T8): an account-wide
 * window at 100 % now (`full`, until the last of them resets), one projected to reach it
 * (`hits`), a weekly window projected to end high but under 100 % (`week`, its projected
 * share), all projected to last (`safe`), no spend (`idle`), or too little data (`unknown`).
 */
export type Verdict =
  | { readonly kind: "full"; readonly until: number }
  | { readonly kind: "hits"; readonly at: number }
  | { readonly kind: "week"; readonly utilization: number }
  | { readonly kind: "safe" }
  | { readonly kind: "idle" }
  | { readonly kind: "unknown" };

/**
 * One account's limits card: an enabled root, with its store account when it has usage; or
 * every root on a subscription account they share (T16), with their limits and summed pace.
 */
export interface LimitCard {
  /**
   * The store's account id (for roots on one account, the first with usage); null before
   * any usage is stored.
   */
  readonly account: number | null;
  /** The root's label, or for roots on one account their labels joined by " + ". */
  readonly label: string;
  readonly provider: string;
  /**
   * False for a history-only account: "not signed in here" instead of meters. Roots on one
   * account are signed in when any of them is.
   */
  readonly signedIn: boolean;
  /** The account-wide 5-hour and weekly windows; null when the limits have none. */
  readonly fiveHour: LimitMeter | null;
  readonly week: LimitMeter | null;
  /** Spend per hour over the last 30 minutes. */
  readonly pace: { readonly cost: number; readonly tokens: number };
  readonly verdict: Verdict;
  /** When the limits were captured (epoch ms); null when none ever were. */
  readonly capturedAt: number | null;
}

/** An MCP agent session's latest tool call in the last 10 minutes (T9's heartbeat). */
export interface AgentCall {
  readonly tool: string;
  /** The account label the call resolved to, or null. */
  readonly account: string | null;
  readonly at: number;
}

/** A limit event of the last 7 days (T8's `limit_events`). */
export interface OverviewEvent {
  readonly at: number;
  /** The account's label. */
  readonly account: string;
  readonly kind: "reached" | "passed_80" | "resumed";
  /** The window's label when recorded ("5-HOUR", "WEEKLY", "FABLE WEEKLY"). */
  readonly window: string;
  readonly resetsAt: number;
  /** For `reached`: when the window was usable again, or null while it isn't. */
  readonly resumedAt: number | null;
}

export type ActivityWindow = "5h" | "24h" | "7d";
export const ACTIVITY_WINDOWS: readonly ActivityWindow[] = ["5h", "24h", "7d"];

/** Cost and tokens in equal buckets, oldest first, the last one holding now. */
export interface ActivitySeries {
  readonly from: number;
  readonly bucketMs: number;
  readonly cost: readonly number[];
  readonly tokens: readonly number[];
}

export interface OverviewVM {
  /** When it was computed: countdowns and "ago" times count from here. */
  readonly asOf: number;
  /**
   * One card per enabled account in scope, roots on one subscription account sharing one;
   * null until the roots are known.
   */
  readonly cards: readonly LimitCard[] | null;
  /** MCP agent sessions' latest calls, newest first; null with no MCP server about. */
  readonly agents: { readonly servers: number; readonly calls: readonly AgentCall[] } | null;
  readonly spend: Readonly<Record<SpendColumn, Amount>>;
  readonly activity: Readonly<Record<ActivityWindow, ActivitySeries>>;
  /** The last 24 h (the 24 h chart's range), most cost first, at most 5. */
  readonly topModels: readonly TopModel[];
  /** The same 24 h, most tokens first, at most 5: the list when costs are hidden. */
  readonly topModelsByTokens: readonly TopModel[];
  /** Newest first. */
  readonly events: readonly OverviewEvent[];
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
  /**
   * The roots on its subscription account besides itself (T16), by identity, and how they
   * were linked; null for a root on its own.
   */
  readonly group: { readonly others: readonly string[]; readonly source: GroupSource } | null;
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
  /** limits.json (T8), the last-good limits of every account. */
  readonly limitsPath: string;
  /** The ingest cache (cache.db), for Codex rollout limit snapshots. */
  readonly cachePath: string;
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
  /** The ingest Worker rewrote limits.json (T8's `limits` message). */
  | { readonly type: "limits" }
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
