// The Models and Accounts fixture (T13): the shared TUI fixture's five made-up accounts and
// sixty days of usage, plus what these two views show beyond it:
// - Models: an estimated model (codex-auto-review), a fast tier with a price (Opus 5.5
//   fast) beside the unpriced model and gpt-5.6-sol's Aug 21 price change already there;
// - Accounts: roots (one history-only, one disabled, one on a polled Windows drive),
//   limits.json captures (one account near its 5-hour limit, one with a failed fetch),
//   limit events over the last weeks, and an MCP call.
// Paths, identities and labels are obviously fake; nothing is read from the user's files.

import { writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Alert } from "../../src/alerts/store.ts";
import type { Config } from "../../src/config.ts";
import { Limits, spendFromQueries } from "../../src/limits/index.ts";
import type { McpActivity } from "../../src/mcp/heartbeat.ts";
import type { Root } from "../../src/sources/roots.ts";
import { openStore, type UsageRow } from "../../src/store/store.ts";
import type { AccountSources } from "../../src/tui/vm/accounts.ts";
import { prng } from "../query/synthetic.ts";
import {
  FIXTURE_ACCOUNTS,
  type Fixture,
  fixtureConfig,
  fixtureRows,
  fixtureViews,
  makeFixtureStore,
  NOW,
} from "./fixture.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
export const HOME = "/home/someone";

const account = (label: string) =>
  FIXTURE_ACCOUNTS.find((a) => a.label === label) as (typeof FIXTURE_ACCOUNTS)[number];

/** Opus 5.5 at both tiers (personal) and the estimated codex-auto-review (codex). */
export function extraRows(): UsageRow[] {
  const rnd = prng(7);
  const rows: UsageRow[] = [];
  let key = 1n << 60n;
  const add = (label: string, model: string, ts: number, tier: 0 | 1) =>
    rows.push({
      key: key++,
      ...account(label),
      ts,
      model,
      inp: 300 + Math.floor(rnd() * 2000),
      outp: 100 + Math.floor(rnd() * 1500),
      cr: Math.floor(rnd() * 60_000),
      cc: Math.floor(rnd() * 4000),
      e5: null,
      e1: null,
      tier,
    });
  for (let day = 20; day >= 0; day--) {
    for (let t = 0; t < 12; t++) {
      const ts = NOW - day * DAY - 3 * HOUR - t * 90_000;
      add("personal", "claude-opus-5-5", ts, t % 3 === 0 ? 1 : 0);
      if (t % 2 === 0) add("codex", "codex-auto-review", ts - 7 * MIN, 0);
    }
  }
  return rows;
}

/** Discovered roots as discovery would make them for the five accounts. */
export function fixtureRoots(): Root[] {
  const root = (label: string, path: string, over: Partial<Root> = {}): Root => {
    const a = account(label);
    return {
      provider: a.provider as Root["provider"],
      label,
      labelExplicit: false,
      path,
      // The roots are WSL-style paths on every OS the tests run on.
      projects: posix.join(path, a.provider === "codex" ? "sessions" : "projects"),
      source: "auto",
      enabled: true,
      identity: a.identity,
      historyOnly: false,
      ...over,
    };
  };
  return [
    root("personal", `${HOME}/.claude`),
    root("work", "/mnt/c/Users/someone/.claude"),
    root("old-laptop", `${HOME}/.claude-old`, { historyOnly: true }),
    root("codex", `${HOME}/.codex`),
    root("codex-win", "/mnt/c/Users/someone/.codex", { enabled: false }),
  ];
}

/** This week's weekly reset for the Claude accounts: Monday Oct 5, 09:00 in Toronto. */
export const WEEKLY_RESET = Date.parse("2026-10-05T13:00:00Z");
const CODEX_WEEKLY_RESET = NOW + 19 * HOUR + 5 * MIN;
const CAPTURED = NOW - 90_000;

/** limits.json as the fetcher leaves it: captures by identity, and one failed fetch. */
export function limitsFile() {
  const s = (ms: number) => ms / 1000;
  const bucket = (label: string, used: number, resetsAt: number, minutes?: number) => ({
    label,
    used_percentage: used,
    resets_at: s(resetsAt),
    ...(minutes === undefined ? {} : { window_minutes: minutes }),
  });
  const capture = (source: "claude" | "codex", rate_limits: Record<string, unknown>) => ({
    captured_at: s(CAPTURED),
    source,
    via: source === "claude" ? "api" : "rpc",
    rate_limits,
  });
  return {
    providers: {
      [account("personal").identity]: capture("claude", {
        session: bucket("5-HOUR", 62, NOW + HOUR + 48 * MIN),
        weekly_all: bucket("WEEKLY", 27, WEEKLY_RESET),
        weekly_scoped: bucket("FABLE WEEKLY", 0, WEEKLY_RESET),
      }),
      [account("work").identity]: capture("claude", {
        session: bucket("5-HOUR", 92, NOW + 35 * MIN),
        weekly_all: bucket("WEEKLY", 58, Date.parse("2026-10-02T16:00:00Z")),
      }),
      [account("codex").identity]: capture("codex", {
        codex_primary: bucket("5-HOUR", 8, NOW + 4 * HOUR + 31 * MIN, 300),
        codex_secondary: bucket("WEEKLY", 83, CODEX_WEEKLY_RESET, 10_080),
      }),
    },
    status: {
      [account("work").identity]: {
        signed_in: true,
        history_only: null,
        checked_at: null,
        cred_mtime: null,
        errors: 1,
        last_error: "HTTP 429",
        last_attempt_at: NOW - 30_000,
        next_at: NOW + 30_000,
      },
    },
  };
}

/** Limit events: personal's weekly window passed 80 % or reached 100 % in some past weeks. */
function recordEvents(storePath: string): void {
  const store = openStore(storePath);
  const record = (
    label: string,
    events: { kind: string; window: string; label: string; resetsAt: number; at: number }[],
  ) =>
    store.recordLimitEvents({ ...account(label), derivedLabel: false }, NOW - 10 * WEEK, () => ({
      insert: events,
      resume: [],
    }));
  const weekly = (k: number, kind: string, before: number) => ({
    kind,
    window: "weekly_all",
    label: "WEEKLY",
    resetsAt: WEEKLY_RESET - k * WEEK,
    at: WEEKLY_RESET - k * WEEK - before,
  });
  record("personal", [
    weekly(1, "passed_80", 2 * DAY),
    weekly(3, "passed_80", 4 * DAY),
    weekly(3, "reached", 2 * DAY),
    weekly(6, "reached", 2 * DAY),
    // A 5-hour window reached: not part of the weekly chart.
    {
      kind: "reached",
      window: "session",
      label: "5-HOUR",
      resetsAt: NOW - 3 * DAY,
      at: NOW - 3 * DAY - HOUR,
    },
  ]);
  record("codex", [
    {
      kind: "reached",
      window: "codex_secondary",
      label: "WEEKLY",
      resetsAt: CODEX_WEEKLY_RESET - 2 * WEEK,
      at: CODEX_WEEKLY_RESET - 2 * WEEK - DAY,
    },
  ]);
  store.close();
}

export const MCP: McpActivity = {
  servers: 1,
  agents: 1,
  recent: [
    { at: NOW - 12_000, tool: "get_limits", account: "personal" },
    { at: NOW - 4 * MIN, tool: "usage", account: "personal" },
  ],
  latest: [{ at: NOW - 12_000, tool: "get_limits", account: "personal", project: "demo-app" }],
};

export interface T13Fixture extends Fixture {
  readonly limitsPath: string;
}

export function makeT13Fixture(limits: unknown = limitsFile()): T13Fixture {
  const fx = makeFixtureStore([...fixtureRows(), ...extraRows()]);
  const limitsPath = join(fx.dir, "limits.json");
  writeFileSync(limitsPath, `${JSON.stringify(limits, null, 2)}\n`);
  recordEvents(fx.storePath);
  return { ...fx, limitsPath };
}

/** Every view model of the T13 fixture at NOW, with roots, limits, MCP activity and alerts. */
export function t13Views(
  fx: T13Fixture,
  config: Config = fixtureConfig(),
  scope: number | null = null,
  mcp: McpActivity | null = MCP,
  alerts: readonly Alert[] = [],
): ReturnType<typeof fixtureViews> {
  const roots = fixtureRoots();
  return fixtureViews(fx.storePath, config, scope, (db, q) => {
    const sources: AccountSources = {
      roots,
      limits: new Limits({
        limitsPath: fx.limitsPath,
        roots: () => roots,
        db,
        spend: spendFromQueries(q),
        now: () => NOW,
      }),
      mcp,
      wsl: true,
      home: HOME,
      alerts,
    };
    return sources;
  });
}
