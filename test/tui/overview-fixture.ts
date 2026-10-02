// The Overview's fixture (T11 AC 1): the TUI fixture's five made-up accounts, plus limits
// and limit events, so every kind of card shows:
// - `personal` near its 5-hour limit, with a projection (it is spending now);
// - `work` with limits 47 minutes old (stale);
// - `old-laptop` history-only;
// - `codex` with its weekly window high, `codex-win` idle;
// - limit events over the last week, and two MCP agent sessions.
// Identities, labels and paths are obviously fake; nothing here reads a real directory.
import { join } from "node:path";
import { saveLimitsCache } from "../../src/limits/cache.ts";
import type { Capture } from "../../src/limits/capture.ts";
import { recordCaptureEvents } from "../../src/limits/events.ts";
import { codexSnapshotsFrom, Limits, spendFromQueries } from "../../src/limits/index.ts";
import type { McpActivity } from "../../src/mcp/heartbeat.ts";
import { Zone } from "../../src/query/tz.ts";
import type { Root } from "../../src/sources/roots.ts";
import { openStore, openStoreReader, type UsageRow } from "../../src/store/store.ts";
import { COMPUTE, type ComputeContext } from "../../src/tui/vm/compute.ts";
import { readAccountEvents } from "../../src/tui/vm/history.ts";
import { createQueries, displayAccounts, readStoreAccounts } from "../../src/tui/vm/session.ts";
import {
  type AccountInfo,
  type OverviewVM,
  VIEW_IDS,
  type ViewId,
  type ViewModels,
} from "../../src/tui/vm/types.ts";
import {
  bundledTable,
  FIXTURE_ACCOUNTS,
  type Fixture,
  fixtureConfig,
  fixtureRows,
  makeFixtureStore,
  NOW,
  TZ,
} from "./fixture.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const S = (ms: number) => ms / 1000;

/** The fixture's accounts as enabled roots, under a made-up home. */
export const ROOTS: readonly Root[] = FIXTURE_ACCOUNTS.map((a) => ({
  provider: a.provider,
  label: a.label,
  labelExplicit: false,
  path: `/home/fixture/.${a.label}`,
  projects: `/home/fixture/.${a.label}/projects`,
  source: "auto",
  enabled: true,
  identity: a.identity,
  historyOnly: a.identity === "fixture-identity-old",
}));

function root(label: string): Root {
  return ROOTS.find((r) => r.label === label) as Root;
}

/** Recent spending: personal through the morning and now, the Codex accounts a little. */
function recentRows(): UsageRow[] {
  const rows: UsageRow[] = [];
  let key = 1_000_000_000n;
  const add = (
    label: string,
    model: string,
    minutesAgo: number[],
    inp: number,
    outp: number,
    cr: number,
  ) => {
    const a = FIXTURE_ACCOUNTS.find((f) => f.label === label);
    if (a === undefined) throw new Error(label);
    for (const m of minutesAgo) {
      rows.push({
        key: key++ * 0x9e3779b9n,
        provider: a.provider,
        identity: a.identity,
        label: a.label,
        ts: NOW - m * MIN,
        model,
        inp,
        outp,
        cr,
        cc: 0,
        e5: null,
        e1: null,
        tier: 0,
      });
    }
  };
  // personal's 5-hour window: heavy work earlier, steady now.
  add("personal", "claude-opus-4-8", [150, 120, 90, 60], 20_000, 30_000, 1_000_000);
  add("personal", "claude-opus-4-8", [24, 12, 3], 3000, 4000, 200_000);
  add("codex", "gpt-5.5", [10], 500, 300, 20_000);
  add("codex-win", "gpt-5.5", [15], 500, 300, 20_000);
  return rows;
}

function capture(
  source: "claude" | "codex",
  at: number,
  windows: Record<string, { u: number; resets: number; minutes?: number; label?: string }>,
): Capture {
  const rate_limits: Capture["rate_limits"] = {};
  for (const [kind, w] of Object.entries(windows)) {
    rate_limits[kind] = {
      used_percentage: w.u,
      resets_at: S(w.resets),
      ...(w.minutes === undefined ? {} : { window_minutes: w.minutes }),
      ...(w.label === undefined ? {} : { label: w.label }),
    };
  }
  return { captured_at: S(at), source, via: "api", rate_limits };
}

/** The limits each account last captured (limits.json). */
export const CAPTURES: Readonly<Record<string, Capture>> = {
  "fixture-identity-personal": capture("claude", NOW - 2 * MIN, {
    session: { u: 78, resets: NOW + 108 * MIN, label: "5-HOUR" },
    weekly_all: { u: 27, resets: NOW + 102 * HOUR, label: "WEEKLY" },
    // A model's own weekly limit: not one of the card's account-wide meters.
    weekly_scoped: { u: 40, resets: NOW + 102 * HOUR, label: "FABLE WEEKLY" },
  }),
  "fixture-identity-work": capture("claude", NOW - 47 * MIN, {
    session: { u: 12, resets: NOW + 235 * MIN, label: "5-HOUR" },
    weekly_all: { u: 9, resets: NOW + 59 * HOUR, label: "WEEKLY" },
  }),
  "fixture-identity-codex": capture("codex", NOW - MIN, {
    codex_primary: { u: 8, resets: NOW + 271 * MIN, minutes: 300, label: "5-HOUR" },
    codex_secondary: { u: 83, resets: NOW + 1145 * MIN, minutes: 10_080, label: "WEEKLY" },
  }),
  "fixture-identity-codex-win": capture("codex", NOW - 3 * MIN, {
    codex_primary: { u: 44, resets: NOW + 130 * MIN, minutes: 300, label: "5-HOUR" },
    codex_secondary: { u: 58, resets: NOW + 27 * HOUR, minutes: 10_080, label: "WEEKLY" },
  }),
};

/** Captures over the past week that crossed thresholds: what T8 recorded as events. */
function recordEvents(storePath: string): void {
  const store = openStore(storePath);
  try {
    const at = (iso: string) => Date.parse(iso);
    const personal = root("personal");
    // Fri Sep 25: 5-hour full at 11:05 Toronto, usable again at 12:57.
    recordCaptureEvents(
      store,
      personal,
      capture("claude", at("2026-09-25T15:05:00Z"), {
        session: { u: 100, resets: at("2026-09-25T16:00:00Z"), label: "5-HOUR" },
      }),
    );
    recordCaptureEvents(
      store,
      personal,
      capture("claude", at("2026-09-25T16:57:00Z"), {
        session: { u: 4, resets: at("2026-09-25T21:57:00Z"), label: "5-HOUR" },
      }),
    );
    // Sun Sep 27, 21:10: codex's week passed 80 %.
    recordCaptureEvents(
      store,
      root("codex"),
      capture("codex", at("2026-09-28T01:10:00Z"), {
        codex_secondary: {
          u: 81,
          resets: at("2026-09-30T10:45:00Z"),
          minutes: 10_080,
          label: "WEEKLY",
        },
      }),
    );
    // Mon Sep 28: 5-hour full at 14:10, usable again at 16:05.
    recordCaptureEvents(
      store,
      personal,
      capture("claude", at("2026-09-28T18:10:00Z"), {
        session: { u: 100, resets: at("2026-09-28T20:00:00Z"), label: "5-HOUR" },
      }),
    );
    recordCaptureEvents(
      store,
      personal,
      capture("claude", at("2026-09-28T20:05:00Z"), {
        session: { u: 3, resets: at("2026-09-29T01:05:00Z"), label: "5-HOUR" },
      }),
    );
    // Today 09:30: work's 5-hour full until 10:00, with no capture since its reset.
    recordCaptureEvents(
      store,
      root("work"),
      capture("claude", at("2026-09-29T13:30:00Z"), {
        session: { u: 100, resets: at("2026-09-29T14:00:00Z"), label: "5-HOUR" },
      }),
    );
  } finally {
    store.close();
  }
}

/**
 * Two agent sessions with recent calls, as T9's heartbeat files report them: one in a
 * project, one from a heartbeat that names none.
 */
export const MCP: McpActivity = {
  servers: 2,
  agents: 2,
  recent: [],
  latest: [
    { at: NOW - 40_000, tool: "limits", account: "work", project: "demo-app" },
    { at: NOW - 3 * MIN, tool: "should_wait", account: "personal", project: null },
  ],
};

export interface OverviewFixture extends Fixture {
  readonly limitsPath: string;
  /** The Overview view model at NOW, as the view-model Worker computes it. */
  overview(scope?: number | null, over?: { mcp?: McpActivity | null }): OverviewVM;
  /** Every view model, the Overview's with limits, events and agents. */
  views(scope?: number | null): { views: ViewModels; accounts: AccountInfo[] };
}

/** The TUI fixture's rows plus the recent spending the cards' paces come from. */
export function overviewRows(): UsageRow[] {
  return [...fixtureRows(), ...recentRows()];
}

export function makeOverviewFixture(): OverviewFixture {
  const fixture = makeFixtureStore(overviewRows());
  const limitsPath = join(fixture.dir, "limits.json");
  saveLimitsCache({ providers: { ...CAPTURES }, status: {} }, limitsPath);
  recordEvents(fixture.storePath);
  const config = fixtureConfig();
  const compute = (scope: number | null, mcp: McpActivity | null) => {
    const db = openStoreReader(fixture.storePath);
    if (db === null) throw new Error("fixture store missing");
    try {
      const prices = bundledTable();
      const q = createQueries(db, prices, TZ, () => NOW);
      const stored = readStoreAccounts(db);
      const accounts = displayAccounts(stored, new Map(), config);
      // As the view-model Worker's session builds it (T13's sources, T12's events).
      const ctx: ComputeContext = {
        q,
        now: NOW,
        zone: Zone.of(TZ),
        accounts,
        scope,
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
            snapshots: codexSnapshotsFrom(join(fixture.dir, "no-cache.db")),
            now: () => NOW,
          }),
          mcp,
          wsl: false,
          home: "/home/fixture",
        },
      };
      const views: ViewModels = {};
      q.snapshot(() => {
        for (const id of VIEW_IDS) (views as Record<ViewId, unknown>)[id] = COMPUTE[id](ctx).vm;
      });
      return { views, accounts };
    } finally {
      db.close();
    }
  };
  return {
    ...fixture,
    limitsPath,
    overview: (scope = null, over = {}) =>
      compute(scope, over.mcp === undefined ? MCP : over.mcp).views.overview as OverviewVM,
    views: (scope = null) => compute(scope, MCP),
  };
}
