// The made-up store behind the README's screenshots (scripts/readme-shots.ts): five
// accounts with obviously fake labels, identities and paths, 200 days of usage up to a
// fixed clock, the limits each account last captured, limit events, and two MCP agents.
// Built in a temp dir from the TUI test fixture's helpers; nothing here reads a real file.
//
// What each account is there to show:
// - `work`: near its 5-hour limit and spending now, so its card counts down to 100 %;
// - `old-laptop`: history only (it moved to another machine), "not signed in here";
// - `home`: spending a little, "safe until reset";
// - `lab`: limits captured 52 minutes ago (stale), nothing spent since, but 62 % of a week
//   one day old: at that week's average it fills tonight, within 18 hours ("100% <18h");
// - `codex-main`: its weekly window high, "week ends ~N%".
// Models include an unpriced one (`*`) and an estimated one (`≈`).
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { type Config, defaultConfig } from "../src/config.ts";
import { saveLimitsCache } from "../src/limits/cache.ts";
import type { Capture } from "../src/limits/capture.ts";
import { recordCaptureEvents } from "../src/limits/events.ts";
import { Limits, spendFromQueries } from "../src/limits/index.ts";
import type { McpActivity } from "../src/mcp/heartbeat.ts";
import { addDays, Zone } from "../src/query/tz.ts";
import type { Root } from "../src/sources/roots.ts";
import { openStore, openStoreReader, type UsageRow } from "../src/store/store.ts";
import { COMPUTE, type ComputeContext } from "../src/tui/vm/compute.ts";
import { readAccountEvents } from "../src/tui/vm/history.ts";
import { createQueries, displayAccounts, readStoreAccounts } from "../src/tui/vm/session.ts";
import { type AccountInfo, VIEW_IDS, type ViewId, type ViewModels } from "../src/tui/vm/types.ts";
import { prng } from "../test/query/synthetic.ts";
import { bundledTable, type Fixture, makeFixtureStore, NOW, TZ } from "../test/tui/fixture.ts";

export { TZ };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Days of history: more than the History heat map's 26 weeks. */
const HISTORY_DAYS = 200;
/** The made-up home every root sits under; shown as `~`. */
const HOME = "/home/someone";

type Provider = "claude" | "codex";

interface Account {
  readonly provider: Provider;
  readonly identity: string;
  readonly label: string;
  readonly dir: string;
  /** Chance of a working day on a weekday, and on a weekend. */
  readonly weekday: number;
  readonly weekend: number;
  /** Sessions on a working day, at most. */
  readonly sessions: number;
  /** Models and their weights. */
  readonly models: readonly (readonly [string, number])[];
  /** Hours of the day sessions start in. */
  readonly hours: readonly [number, number];
  /** The last day with usage, in days before now (the history-only account stopped). */
  readonly until: number;
}

/** In the order the Overview shows their cards (roots order). */
const ACCOUNTS: readonly Account[] = [
  {
    provider: "claude",
    identity: "readme-identity-work",
    label: "work",
    dir: ".claude-work",
    weekday: 0.92,
    weekend: 0.15,
    sessions: 4,
    models: [
      ["claude-opus-5-5", 6],
      ["claude-sonnet-5-5", 3],
      ["claude-haiku-4-5", 1],
    ],
    hours: [8, 17],
    until: 0,
  },
  {
    provider: "claude",
    identity: "readme-identity-old-laptop",
    label: "old-laptop",
    dir: ".claude-old-laptop",
    weekday: 0.6,
    weekend: 0.3,
    sessions: 2,
    models: [
      ["claude-opus-4-8", 3],
      ["claude-sonnet-4-6", 2],
    ],
    hours: [9, 20],
    until: 24,
  },
  {
    provider: "claude",
    identity: "readme-identity-home",
    label: "home",
    dir: ".claude-home",
    weekday: 0.35,
    weekend: 0.7,
    sessions: 2,
    models: [
      ["claude-sonnet-5-5", 4],
      ["claude-mystery-9", 1],
    ],
    hours: [18, 22],
    until: 0,
  },
  {
    provider: "claude",
    identity: "readme-identity-lab",
    label: "lab",
    dir: ".claude-lab",
    weekday: 0.3,
    weekend: 0.05,
    sessions: 2,
    models: [
      ["claude-opus-5-5", 2],
      ["claude-sonnet-5-5", 1],
    ],
    hours: [10, 16],
    until: 0,
  },
  {
    provider: "codex",
    identity: "readme-identity-codex-main",
    label: "codex-main",
    dir: ".codex",
    weekday: 0.75,
    weekend: 0.4,
    sessions: 3,
    models: [
      ["gpt-5.6-sol", 4],
      ["gpt-5.5", 3],
      ["codex-auto-review", 2],
    ],
    hours: [9, 21],
    until: 0,
  },
];

const account = (label: string): Account => {
  const a = ACCOUNTS.find((x) => x.label === label);
  if (a === undefined) throw new Error(`no account ${label}`);
  return a;
};

/** The roots discovery would find for them, under the made-up home. */
const ROOTS: readonly Root[] = ACCOUNTS.map((a) => ({
  provider: a.provider,
  label: a.label,
  // `~/.codex` would be labelled "codex": its label was set by hand.
  labelExplicit: a.provider === "codex",
  path: `${HOME}/${a.dir}`,
  projects: `${HOME}/${a.dir}/${a.provider === "codex" ? "sessions" : "projects"}`,
  source: "auto",
  enabled: true,
  identity: a.identity,
  historyOnly: a.label === "old-laptop",
}));

function shotsConfig(): Config {
  return {
    ...defaultConfig(),
    time_zone: TZ,
    history_only_roots: [account("old-laptop").identity],
  };
}

function pick<T>(rnd: () => number, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r < 0) return item;
  }
  return (items[items.length - 1] as readonly [T, number])[0];
}

/** Local midnight `days` before NOW's day, in TZ. */
function dayStart(zone: Zone, days: number): number {
  return zone.startOf(addDays(zone.dateAt(NOW), -days));
}

/**
 * Sessions on working days, busier lately, a quiet week in August, up to the day before
 * yesterday: the last two days are `recentRows`, laid out by hand.
 */
function historyRows(zone: Zone): UsageRow[] {
  const rnd = prng(19);
  const rows: UsageRow[] = [];
  let key = 1n;
  for (let day = HISTORY_DAYS; day >= 2; day--) {
    const start = dayStart(zone, day);
    const weekday = (new Date(start + 12 * HOUR).getUTCDay() + 6) % 7;
    const holiday = day >= 52 && day <= 58;
    const ramp = 0.55 + 0.45 * (1 - day / HISTORY_DAYS);
    for (const a of ACCOUNTS) {
      if (day < a.until) continue;
      const chance = (weekday >= 5 ? a.weekend : a.weekday) * (holiday ? 0.2 : 1);
      if (rnd() >= chance) continue;
      const sessions = 1 + Math.floor(rnd() * a.sessions * ramp);
      // Most days are ordinary, a few are big.
      const intensity = 0.4 + 3 * rnd() ** 3;
      for (let s = 0; s < sessions; s++) {
        const model = pick(rnd, a.models);
        const [from, to] = a.hours;
        let ts = start + (from + rnd() * (to - from)) * HOUR;
        const turns = 8 + Math.floor(rnd() * 40 * ramp);
        for (let t = 0; t < turns; t++, ts += 30_000 + rnd() * 90_000) {
          rows.push({
            key: key++ * 0x9e3779b9n,
            provider: a.provider,
            identity: a.identity,
            label: a.label,
            ts: Math.round(ts),
            model,
            inp: 200 + Math.floor(rnd() * 3000),
            outp: 80 + Math.floor(rnd() * 2200 * intensity),
            cr: Math.floor(rnd() * 120_000 * intensity),
            cc: Math.floor(rnd() * 6000 * intensity),
            e5: null,
            e1: null,
            tier: model === "claude-opus-5-5" && rnd() < 0.12 ? 1 : 0,
          });
        }
      }
    }
  }
  return rows;
}

const HEAVY = { inp: 3000, outp: 3500, cr: 350_000, cc: 15_000 };
const MEDIUM = { inp: 1500, outp: 1500, cr: 120_000, cc: 4000 };
const LIGHT = { inp: 600, outp: 500, cr: 30_000, cc: 0 };

/**
 * Yesterday and today session by session, plus the days the 5-hour limits were reached:
 * what the cards' paces and projections, the 24-hour chart and the top models come from.
 * Times are local (Toronto); NOW is Tuesday 11:40.
 */
function recentRows(zone: Zone): UsageRow[] {
  const rows: UsageRow[] = [];
  let key = 1n << 60n;
  /** Rows every `step` minutes from `from` to `to` ("HH:MM"), `days` before today. */
  const session = (
    label: string,
    model: string,
    days: number,
    from: string,
    to: string,
    step: number,
    size: { inp: number; outp: number; cr: number; cc: number },
  ) => {
    const a = account(label);
    const minutes = (hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number) as [number, number];
      return h * 60 + m;
    };
    const day = dayStart(zone, days);
    for (let m = minutes(from); m <= minutes(to); m += step) {
      const ts = day + m * MIN;
      if (ts > NOW) break;
      rows.push({
        key: key++,
        provider: a.provider,
        identity: a.identity,
        label: a.label,
        ts,
        model,
        ...size,
        e5: null,
        e1: null,
        tier: 0,
      });
    }
  };
  // Thursday: work runs into its 5-hour limit at 15:20. codex-main works Thursday and Friday.
  session("work", "claude-opus-5-5", 5, "10:20", "15:18", 3, HEAVY);
  session("codex-main", "gpt-5.6-sol", 5, "13:00", "17:00", 4, MEDIUM);
  session("codex-main", "gpt-5.5", 4, "10:00", "15:00", 5, MEDIUM);
  // Saturday: lab runs into its 5-hour limit at 16:30.
  session("lab", "claude-opus-5-5", 3, "12:00", "16:28", 3, HEAVY);
  // Monday: work hits its 5-hour limit at 14:10, and carries on after the 16:05 reset.
  session("work", "claude-opus-5-5", 1, "09:10", "14:08", 3, HEAVY);
  session("work", "claude-sonnet-5-5", 1, "16:10", "17:30", 4, MEDIUM);
  session("codex-main", "gpt-5.6-sol", 1, "13:00", "18:00", 6, MEDIUM);
  session("home", "claude-sonnet-5-5", 1, "19:30", "21:10", 5, MEDIUM);
  session("home", "claude-mystery-9", 1, "21:15", "22:00", 5, MEDIUM);
  session("codex-main", "codex-auto-review", 1, "21:00", "22:30", 6, MEDIUM);
  // Today: lab early, then work since 08:35 and still going; home and codex-main a little.
  session("lab", "claude-opus-5-5", 0, "06:10", "10:40", 4, MEDIUM);
  session("codex-main", "gpt-5.6-sol", 0, "09:00", "10:30", 6, MEDIUM);
  session("work", "claude-opus-5-5", 0, "08:35", "11:39", 2, HEAVY);
  session("home", "claude-sonnet-5-5", 0, "10:05", "11:35", 15, MEDIUM);
  session("codex-main", "codex-auto-review", 0, "10:40", "10:52", 4, LIGHT);
  session("codex-main", "gpt-5.5", 0, "11:30", "11:30", 1, { ...LIGHT, outp: 1000, cr: 60_000 });
  return rows;
}

function capture(
  source: Provider,
  at: number,
  windows: Record<string, { u: number; resets: number; minutes?: number; label: string }>,
): Capture {
  const rate_limits: Capture["rate_limits"] = {};
  for (const [kind, w] of Object.entries(windows)) {
    rate_limits[kind] = {
      used_percentage: w.u,
      resets_at: w.resets / 1000,
      label: w.label,
      ...(w.minutes === undefined ? {} : { window_minutes: w.minutes }),
    };
  }
  return { captured_at: at / 1000, source, via: source === "claude" ? "api" : "rpc", rate_limits };
}

/** This week's weekly reset for work and lab: Monday Oct 5, 09:00 in Toronto. */
const WEEKLY_RESET = Date.parse("2026-10-05T13:00:00Z");
const CODEX_WEEKLY_RESET = NOW + 19 * HOUR + 5 * MIN;

/** limits.json: each account's last capture (old-laptop, history only, has none). */
const CAPTURES: Readonly<Record<string, Capture>> = {
  "readme-identity-work": capture("claude", NOW - 2 * MIN, {
    session: { u: 84, resets: NOW + 112 * MIN, label: "5-HOUR" },
    weekly_all: { u: 41, resets: WEEKLY_RESET, label: "WEEKLY" },
  }),
  "readme-identity-home": capture("claude", NOW - 3 * MIN, {
    session: { u: 22, resets: NOW + 200 * MIN, label: "5-HOUR" },
    weekly_all: { u: 18, resets: NOW + 30 * HOUR, label: "WEEKLY" },
  }),
  "readme-identity-lab": capture("claude", NOW - 52 * MIN, {
    session: { u: 35, resets: NOW + 160 * MIN, label: "5-HOUR" },
    weekly_all: { u: 62, resets: WEEKLY_RESET, label: "WEEKLY" },
  }),
  "readme-identity-codex-main": capture("codex", NOW - MIN, {
    codex_primary: { u: 9, resets: NOW + 271 * MIN, minutes: 300, label: "5-HOUR" },
    codex_secondary: { u: 83, resets: CODEX_WEEKLY_RESET, minutes: 10_080, label: "WEEKLY" },
  }),
};

/** Captures over the past weeks that crossed thresholds: the limit events they recorded. */
function recordEvents(storePath: string): void {
  const store = openStore(storePath);
  const root = (label: string) => ROOTS.find((r) => r.label === label) as Root;
  const at = (iso: string) => Date.parse(iso);
  const record = (label: string, when: string, windows: Parameters<typeof capture>[2]) => {
    const r = root(label);
    recordCaptureEvents(store, r, capture(r.provider, at(when), windows));
  };
  const five = (u: number, resets: string) => ({
    session: { u, resets: at(resets), label: "5-HOUR" },
  });
  const weekly = (u: number, resets: number) => ({
    weekly_all: { u, resets, label: "WEEKLY" },
  });
  try {
    // work's weekly window in earlier weeks: past 80 % three times, full once.
    for (const [weeksAgo, u] of [
      [6, 84],
      [4, 100],
      [3, 88],
      [1, 91],
    ] as const) {
      const resets = WEEKLY_RESET - weeksAgo * 7 * DAY;
      record("work", new Date(resets - (u === 100 ? 1 : 2) * DAY).toISOString(), weekly(u, resets));
    }
    // work's 5-hour window, full on Thursday and Monday, usable again after each reset.
    record("work", "2026-09-24T19:20:00Z", five(100, "2026-09-24T21:00:00Z"));
    record("work", "2026-09-24T21:02:00Z", five(2, "2026-09-25T02:02:00Z"));
    record("work", "2026-09-28T18:10:00Z", five(100, "2026-09-28T20:00:00Z"));
    record("work", "2026-09-28T20:05:00Z", five(3, "2026-09-29T01:05:00Z"));
    // lab's 5-hour window full on Saturday afternoon, with no capture since.
    record("lab", "2026-09-26T20:30:00Z", five(100, "2026-09-26T22:00:00Z"));
    // codex-main's week passed 80 % on Sunday evening.
    record("codex-main", "2026-09-28T01:10:00Z", {
      codex_secondary: { u: 81, resets: CODEX_WEEKLY_RESET, minutes: 10_080, label: "WEEKLY" },
    });
  } finally {
    store.close();
  }
}

/** Two agent sessions using tokenhud's MCP server, as its heartbeat files report them. */
export const MCP: McpActivity = {
  servers: 2,
  agents: 2,
  recent: [
    { at: NOW - 40_000, tool: "limits", account: "work" },
    { at: NOW - 3 * MIN, tool: "should_wait", account: "work" },
    { at: NOW - 7 * MIN, tool: "usage", account: "home" },
  ],
  latest: [
    { at: NOW - 40_000, tool: "limits", account: "work", project: "api-server" },
    { at: NOW - 7 * MIN, tool: "usage", account: "home", project: "web-app" },
  ],
};

export interface ShotsFixture extends Fixture {
  readonly config: Config;
  /** Every view model at NOW, computed as the view-model Worker computes them. */
  views(): { views: ViewModels; accounts: AccountInfo[] };
}

export function makeShotsFixture(): ShotsFixture {
  const zone = Zone.of(TZ);
  const fixture = makeFixtureStore([...historyRows(zone), ...recentRows(zone)]);
  const limitsPath = join(fixture.dir, "limits.json");
  saveLimitsCache({ providers: { ...CAPTURES }, status: {} }, limitsPath);
  recordEvents(fixture.storePath);
  const config = shotsConfig();
  const views = () => {
    const db: Database | null = openStoreReader(fixture.storePath);
    if (db === null) throw new Error("fixture store missing");
    try {
      const prices = bundledTable();
      const q = createQueries(db, prices, TZ, () => NOW);
      const stored = readStoreAccounts(db);
      const accounts = displayAccounts(stored, new Map(), config);
      const ctx: ComputeContext = {
        q,
        now: NOW,
        zone,
        accounts,
        scope: null,
        window: config.default_window,
        prices,
        limitEvents: (range) => readAccountEvents(db, stored, range),
        sources: {
          roots: ROOTS,
          limits: new Limits({
            limitsPath,
            roots: () => ROOTS,
            db,
            spend: spendFromQueries(q),
            now: () => NOW,
          }),
          mcp: MCP,
          wsl: false,
          home: HOME,
        },
      };
      const out: ViewModels = {};
      q.snapshot(() => {
        for (const id of VIEW_IDS) (out as Record<ViewId, unknown>)[id] = COMPUTE[id](ctx).vm;
      });
      return { views: out, accounts };
    } finally {
      db.close();
    }
  };
  return { ...fixture, config, views };
}
