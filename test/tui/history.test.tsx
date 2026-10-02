// History (T12) on its own store: six months of made-up usage in Toronto up to Thu Dec 3
// 2026, so the heat map's 26 weeks cross the end of DST (Sun Nov 1, a 25-hour day) and
// months that begin mid-week (Jul 1, Oct 1, Dec 1), plus limit events. Expected values come
// from an independent oracle: every row priced on its own, summed over hand-written
// boundaries. Calendar periods are checked on a fixed clock in America/Toronto.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RGBA, rgbToHex } from "@opentui/core";
import { addDays, compareDates, type LocalDate, Zone } from "../../src/query/tz.ts";
import {
  type LimitEventChanges,
  type LimitEventRow,
  openStore,
  openStoreReader,
  type UsageRow,
} from "../../src/store/store.ts";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState, type Key } from "../../src/tui/controller.ts";
import { dayLabel, money } from "../../src/tui/format.ts";
import { theme } from "../../src/tui/theme.ts";
import { costText } from "../../src/tui/views/cells.ts";
import {
  type HistoryState,
  history,
  listing,
  selectedIndex,
  selectedRow,
} from "../../src/tui/views/history.tsx";
import { computeHistory, readAccountEvents } from "../../src/tui/vm/history.ts";
import {
  createQueries,
  displayAccounts,
  readStoreAccounts,
  VmSession,
} from "../../src/tui/vm/session.ts";
import type {
  HistoryDay,
  HistoryEvent,
  HistoryPeriod,
  HistoryVM,
  VmMessage,
} from "../../src/tui/vm/types.ts";
import { prng } from "../query/synthetic.ts";
import { bundledTable, fixtureConfig } from "./fixture.ts";
import { chars, cleanupRenderers, render, roles, settle } from "./render.ts";

cleanupRenderers();

const TZ = "America/Toronto";
const zone = Zone.of(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Thu 2026-12-03 15:40 EST (UTC-5). */
const NOW = Date.parse("2026-12-03T20:40:00Z");
/** Sun 2026-11-01 12:00 EST: the day DST ends, a Sunday and the 1st. */
const SUNDAY_THE_1ST = Date.parse("2026-11-01T17:00:00Z");
/** Wed 2026-11-04 10:00 EST. */
const WEDNESDAY = Date.parse("2026-11-04T15:00:00Z");

const ACCOUNTS = [
  { provider: "claude", identity: "fixture-history-personal", label: "personal" },
  { provider: "claude", identity: "fixture-history-work", label: "work" },
  { provider: "codex", identity: "fixture-history-codex", label: "codex" },
] as const;
const MODELS: Record<string, readonly string[]> = {
  claude: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-mystery-9"],
  codex: ["gpt-5.6-sol", "gpt-5.5"],
};

/**
 * Rows at the calendar edges the tests reason about, as UTC instants with their Toronto
 * wall-clock times.
 */
const EDGES = {
  sunOct25late: Date.parse("2026-10-26T03:30:00Z"), // Sun Oct 25 23:30 EDT
  monOct26early: Date.parse("2026-10-26T04:30:00Z"), // Mon Oct 26 00:30 EDT
  satOct31late: Date.parse("2026-11-01T03:30:00Z"), // Sat Oct 31 23:30 EDT
  nov1first0130: Date.parse("2026-11-01T05:30:00Z"), // Sun Nov 1 01:30 EDT
  nov1second0130: Date.parse("2026-11-01T06:30:00Z"), // Sun Nov 1 01:30 EST, an hour later
  sunNov1late: Date.parse("2026-11-02T04:30:00Z"), // Sun Nov 1 23:30 EST
  monNov2early: Date.parse("2026-11-02T05:30:00Z"), // Mon Nov 2 00:30 EST
  sep30late: Date.parse("2026-10-01T03:30:00Z"), // Wed Sep 30 23:30 EDT
  oct1early: Date.parse("2026-10-01T04:30:00Z"), // Thu Oct 1 00:30 EDT
};

function fixtureRows(): UsageRow[] {
  const rnd = prng(26);
  const rows: UsageRow[] = [];
  let key = 1n;
  const push = (a: (typeof ACCOUNTS)[number], ts: number, model: string, scale: number) => {
    rows.push({
      key: key++ * 0x9e3779b9n,
      ...a,
      ts,
      model,
      inp: Math.floor((300 + rnd() * 3000) * scale),
      outp: Math.floor((80 + rnd() * 1500) * scale),
      cr: Math.floor(rnd() * 60_000 * scale),
      cc: Math.floor(rnd() * 5000 * scale),
      e5: null,
      e1: null,
      tier: model === "claude-opus-4-8" && rnd() < 0.1 ? 1 : 0,
    });
  };
  // From before the first month shown (Jun 1), so the edge is tested, to now; busier as
  // the months go on, quieter at weekends.
  const first: LocalDate = { year: 2026, month: 5, day: 25 };
  const today = zone.dateAt(NOW);
  for (let date = first, i = 0; compareDates(date, today) <= 0; date = addDays(date, 1), i++) {
    const midnight = zone.startOf(date);
    const weekend = new Date(midnight).getUTCDay() % 6 === 0;
    const scale = 0.3 + i / 120;
    for (const a of ACCOUNTS) {
      if (rnd() > (weekend ? 0.35 : 0.8)) continue;
      const sessions = 1 + Math.floor(rnd() * 2);
      for (let s = 0; s < sessions; s++) {
        const models = MODELS[a.provider] as readonly string[];
        const model = models[Math.floor(rnd() * models.length)] as string;
        let ts = midnight + Math.floor((7 + rnd() * 14) * HOUR);
        for (let t = 4 + Math.floor(rnd() * 16); t > 0 && ts <= NOW; t--, ts += 180_000) {
          push(a, ts, model, scale);
        }
      }
    }
  }
  for (const ts of Object.values(EDGES)) push(ACCOUNTS[0], ts, "claude-sonnet-4-6", 1);
  return rows;
}

const ROWS = fixtureRows();
const table = bundledTable();

/** Cost and tokens of the rows with `from <= ts < to`, each priced on its own. */
function oracle(from: number, to: number, keep: (r: UsageRow) => boolean = () => true) {
  let cost = 0;
  let tokens = 0;
  for (const r of ROWS) {
    if (r.ts < from || r.ts >= to || !keep(r)) continue;
    tokens += r.inp + r.outp + r.cr + r.cc;
    const c = table.cost({
      model: r.model,
      tier: r.tier === 1 ? "fast" : "standard",
      atMs: r.ts,
      input: r.inp,
      output: r.outp,
      cacheRead: r.cr,
      cacheCreation: r.cc,
      ephemeral5m: r.e5,
      ephemeral1h: r.e1,
    });
    if (typeof c === "number") cost += c;
  }
  return { cost, tokens };
}

function close(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-6);
}

/** Toronto midnight starting `key` (YYYY-MM-DD). */
function midnight(key: string): number {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return zone.startOf({ year, month, day });
}

function nextDay(key: string): string {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  const d = addDays({ year, month, day }, 1);
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/**
 * Limit events: a 5-hour hit this morning that cleared 1h18m later, a weekly 80 % mark,
 * and a hit in the repeated hour of the night DST ended.
 */
function recordEvents(storePath: string): void {
  const store = openStore(storePath);
  const record = (
    account: (typeof ACCOUNTS)[number],
    decide: (existing: LimitEventRow[]) => LimitEventChanges,
  ) => store.recordLimitEvents(account, 0, decide);
  const event = (kind: string, window: string, label: string, resetsAt: string, at: string) => ({
    kind,
    window,
    label,
    resetsAt: Date.parse(resetsAt),
    at: Date.parse(at),
  });
  // personal: 10:02 EST, usable again at 11:20 EST.
  const reset = "2026-12-03T16:20:00Z";
  record(ACCOUNTS[0], () => ({
    insert: [event("reached", "session", "5-HOUR", reset, "2026-12-03T15:02:00Z")],
    resume: [],
  }));
  record(ACCOUNTS[0], (existing) => ({
    insert: [event("resumed", "session", "5-HOUR", reset, reset)],
    resume: existing.map((e) => ({ id: e.id, at: Date.parse(reset) })),
  }));
  // work: 09:05 EST.
  record(ACCOUNTS[1], () => ({
    insert: [
      event(
        "passed_80",
        "weekly_scoped",
        "FABLE WEEKLY",
        "2026-12-06T17:00:00Z",
        "2026-12-03T14:05:00Z",
      ),
    ],
    resume: [],
  }));
  // codex: 01:10 EST on Nov 1, the second 01:10 that night.
  record(ACCOUNTS[2], () => ({
    insert: [
      event("reached", "codex_primary", "5-HOUR", "2026-11-01T09:00:00Z", "2026-11-01T06:10:00Z"),
    ],
    resume: [],
  }));
  store.close();
}

let dir: string;
let storePath: string;
let vm: HistoryVM;
let ids: Map<string, number>;

/** History's view model at `now`, as the view-model Worker computes it. */
function computeAt(now: number, scope: number | null = null, path = storePath): HistoryVM {
  const db = openStoreReader(path);
  if (db === null) throw new Error("store missing");
  try {
    const q = createQueries(db, table, TZ, () => now);
    const stored = readStoreAccounts(db);
    const accounts = displayAccounts(stored, new Map(), fixtureConfig());
    return q.snapshot(
      () =>
        computeHistory({
          q,
          now,
          zone,
          accounts,
          scope,
          window: "all",
          limitEvents: (range) => readAccountEvents(db, stored, range),
        }).vm,
    );
  } finally {
    db.close();
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tokenhud-history-"));
  storePath = join(dir, "tokenhud.db");
  const store = openStore(storePath);
  store.upsert(ROWS);
  store.close();
  recordEvents(storePath);
  vm = computeAt(NOW);
  const db = openStoreReader(storePath);
  if (db === null) throw new Error("store missing");
  ids = new Map(readStoreAccounts(db).map((a) => [a.label, a.id]));
  db.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const START = history.initial;
/** The state after `keys`, as the shell hands them to the view. */
function press(model: HistoryVM, ...keys: string[]): HistoryState {
  let state = START;
  for (const k of keys) state = history.keys(k, state, model) ?? state;
  return state;
}

function rowKeys(model: HistoryVM, state: HistoryState): string[] {
  return listing(model, state).rows.map((r) => r.key);
}

function selectedDay(model: HistoryVM, state: HistoryState): string {
  return model.days[selectedIndex(model, state)]?.key as string;
}

// ── the view model ───────────────────────────────────────────────────────────────

describe("the view model", () => {
  test("days from Jun 1 to today; the heat map's 26 Monday weeks; whole months", () => {
    expect(vm.days[0]?.key).toBe("2026-06-01");
    expect(vm.days[vm.gridStart]?.key).toBe("2026-06-08"); // 25 weeks before Mon Nov 30
    expect(vm.days.at(-1)?.key).toBe("2026-12-03");
    expect(vm.days).toHaveLength(186);
    expect(vm.weeks).toHaveLength(26);
    expect(vm.weeks[0]?.key).toBe("2026-06-08");
    expect(vm.weeks.at(-1)).toMatchObject({ key: "2026-11-30", days: 4 });
    expect(vm.months.map((m) => [m.key, m.days])).toEqual([
      ["2026-06", 30],
      ["2026-07", 31],
      ["2026-08", 31],
      ["2026-09", 30],
      ["2026-10", 31],
      ["2026-11", 30],
      ["2026-12", 3],
    ]);
  });

  test("every day, week and month is its Toronto calendar span, across DST", () => {
    for (const d of vm.days) {
      const want = oracle(midnight(d.key), midnight(nextDay(d.key)));
      close(d.cost, want.cost);
      expect(d.tokens).toBe(want.tokens);
    }
    // The day DST ends has 25 hours, and both 01:30s.
    const nov1 = vm.days.find((d) => d.key === "2026-11-01") as HistoryPeriod;
    expect(midnight("2026-11-02") - midnight("2026-11-01")).toBe(25 * HOUR);
    const both = oracle(EDGES.nov1first0130, EDGES.nov1second0130 + 1);
    expect(both.tokens).toBeGreaterThan(0);
    expect(nov1.tokens).toBeGreaterThanOrEqual(both.tokens);
    // Weeks run Monday to Monday local: 7 days and an hour across the week DST ends.
    expect(midnight("2026-11-02") - midnight("2026-10-26")).toBe(7 * DAY + HOUR);
    const end = midnight("2026-12-04");
    for (const w of vm.weeks) {
      const want = oracle(midnight(w.key), Math.min(end, midnight(addKey(w.key, 7))));
      close(w.cost, want.cost);
      expect(w.tokens).toBe(want.tokens);
    }
    for (const m of vm.months) {
      const want = oracle(
        midnight(`${m.key}-01`),
        Math.min(end, midnight(`${nextMonth(m.key)}-01`)),
      );
      close(m.cost, want.cost);
      expect(m.tokens).toBe(want.tokens);
    }
  });

  test("a month that begins mid-week splits its week: Sep 28–Oct 4 holds Sep 30 and Oct 1", () => {
    const week = vm.weeks.find((w) => w.key === "2026-09-28") as HistoryPeriod;
    const sep = vm.months.find((m) => m.key === "2026-09") as HistoryPeriod;
    const oct = vm.months.find((m) => m.key === "2026-10") as HistoryPeriod;
    const late = oracle(EDGES.sep30late, EDGES.sep30late + 1).cost;
    const early = oracle(EDGES.oct1early, EDGES.oct1early + 1).cost;
    expect(late).toBeGreaterThan(0);
    close(week.cost, oracle(midnight("2026-09-28"), midnight("2026-10-05")).cost);
    close(sep.cost, oracle(midnight("2026-09-01"), midnight("2026-10-01")).cost);
    close(oct.cost, oracle(midnight("2026-10-01"), midnight("2026-11-01")).cost);
    // Each edge row counts once in each grouping.
    close(sep.cost + oct.cost, oracle(midnight("2026-09-01"), midnight("2026-11-01")).cost);
    expect(early).toBeGreaterThan(0);
  });

  test("each day's models and accounts are its own, most cost first", () => {
    for (const d of vm.days.slice(-40)) {
      const from = midnight(d.key);
      const to = midnight(nextDay(d.key));
      for (const m of d.models) close(m.cost, oracle(from, to, (r) => r.model === m.name).cost);
      for (const a of d.accounts) close(a.cost, oracle(from, to, (r) => r.label === a.name).cost);
      const costs = d.models.map((m) => m.cost);
      expect(costs).toEqual([...costs].sort((a, b) => b - a));
      const used = new Set(ROWS.filter((r) => r.ts >= from && r.ts < to).map((r) => r.model));
      expect(new Set(d.models.map((m) => m.name))).toEqual(used);
    }
    // A week's models and accounts are its days'.
    const week = vm.weeks.at(-2) as HistoryPeriod;
    const from = midnight(week.key);
    for (const a of week.accounts) {
      close(a.cost, oracle(from, midnight(addKey(week.key, 7)), (r) => r.label === a.name).cost);
    }
  });

  test("the average is the 30 days before today, per day", () => {
    const want = oracle(midnight("2026-11-03"), midnight("2026-12-03"));
    expect(vm.averageDays).toBe(30);
    close(vm.average.cost, want.cost / 30);
    close(vm.average.tokens, want.tokens / 30);
    close(vm.weeksTotal.cost, oracle(midnight("2026-06-08"), midnight("2026-12-04")).cost);
    close(vm.monthsTotal.cost, oracle(midnight("2026-06-01"), midnight("2026-12-04")).cost);
  });

  test("limit events by local day, with display labels; a resume folds into its hit", () => {
    const today = vm.days.at(-1);
    expect(today?.events).toEqual([
      {
        account: "work",
        kind: "passed_80",
        window: "FABLE WEEKLY",
        at: Date.parse("2026-12-03T14:05:00Z"),
        resumedAt: null,
      },
      {
        account: "personal",
        kind: "reached",
        window: "5-HOUR",
        at: Date.parse("2026-12-03T15:02:00Z"),
        resumedAt: Date.parse("2026-12-03T16:20:00Z"),
      },
    ]);
    // 06:10Z on Nov 1 is 01:10 EST: still Nov 1 in Toronto.
    const nov1 = vm.days.find((d) => d.key === "2026-11-01");
    expect(nov1?.events.map((e) => e.account)).toEqual(["codex"]);
    expect(vm.days.filter((d) => d.events.length > 0)).toHaveLength(2);
  });

  test("an account scope narrows the days, their accounts and their events", () => {
    const work = computeAt(NOW, ids.get("work") as number);
    const today = work.days.at(-1) as HistoryPeriod & { events: unknown[] };
    expect(today.events).toHaveLength(1);
    for (const d of work.days) expect(d.accounts.every((a) => a.name === "work")).toBe(true);
    const from = midnight("2026-06-01");
    close(
      work.monthsTotal.cost,
      oracle(from, midnight("2026-12-04"), (r) => r.label === "work").cost,
    );
  });

  test("the view-model Worker's session posts History with its limit events", () => {
    const posted: VmMessage[] = [];
    const session = new VmSession(
      {
        type: "start",
        storePath,
        overridesPath: join(dir, "no-overrides.json"),
        mcpDir: join(dir, "mcp"),
        mode: "owner",
        settings: { tz: TZ, window: "all", scope: null },
        scopeLabel: null,
        config: fixtureConfig(),
        discover: { home: join(dir, "home"), env: {} },
        now: NOW,
      },
      (m) => posted.push(m),
    );
    try {
      session.begin();
      const views = posted.find((m) => m.type === "views");
      const model = views?.type === "views" ? views.views.history : undefined;
      expect(model?.days.at(-1)?.events).toHaveLength(2);
    } finally {
      session.close();
    }
  });

  test("a limit event recorded with no new usage reaches History through `changed` (critique m2)", () => {
    // Its own store, built like the fixture's (a file copy could miss what's in the WAL).
    const copy = join(dir, "events-copy.db");
    const fresh = openStore(copy);
    fresh.upsert(ROWS);
    fresh.close();
    recordEvents(copy);
    const posted: VmMessage[] = [];
    const queue: (() => void)[] = [];
    const session = new VmSession(
      {
        type: "start",
        storePath: copy,
        overridesPath: join(dir, "no-overrides.json"),
        mcpDir: join(dir, "mcp"),
        mode: "owner",
        settings: { tz: TZ, window: "all", scope: null },
        scopeLabel: null,
        config: fixtureConfig(),
        discover: { home: join(dir, "home"), env: {} },
        now: NOW,
      },
      (m) => posted.push(m),
      {
        monotonic: () => 0,
        setTimeout: (fn) => queue.push(fn),
        clearTimeout: () => {},
      },
    );
    const history_ = () =>
      posted.flatMap((m) => (m.type === "views" && m.views.history ? [m.views.history] : []));
    try {
      session.begin();
      expect(history_().at(-1)?.days.at(-1)?.events).toHaveLength(2);
      // The Worker records codex's hit at 15:30 EST and says so, as for usage.
      const at = Date.parse("2026-12-03T20:30:00Z");
      const store = openStore(copy);
      store.recordLimitEvents(ACCOUNTS[2], 0, () => ({
        insert: [
          { kind: "reached", window: "codex_primary", label: "5-HOUR", resetsAt: at + HOUR, at },
        ],
        resume: [],
      }));
      store.close();
      session.handle({ type: "changed", fromTs: at, toTs: at, accounts: [ACCOUNTS[2].identity] });
      while (queue.length > 0) queue.shift()?.();
      const events = history_().at(-1)?.days.at(-1)?.events ?? [];
      expect(events.map((e) => [e.account, e.kind])).toContainEqual(["codex", "reached"]);
    } finally {
      session.close();
    }
  });

  test("the baseline averages the days since usage began, when fewer than 30 (critique n3)", () => {
    const small = join(dir, "new-user.db");
    const store = openStore(small);
    // Usage on the 5 days before today and today: Nov 28 – Dec 3.
    const rows = ROWS.filter((r) => r.ts >= midnight("2026-11-28"));
    store.upsert(rows);
    store.close();
    const model = computeAt(NOW, null, small);
    expect(rows.some((r) => r.ts < midnight("2026-11-29"))).toBe(true);
    expect(model.averageDays).toBe(5);
    close(model.average.cost, oracle(midnight("2026-11-28"), midnight("2026-12-03")).cost / 5);
    // Usage only today: no baseline, so no ratio.
    const fresh = join(dir, "today-only.db");
    const s2 = openStore(fresh);
    s2.upsert(ROWS.filter((r) => r.ts >= midnight("2026-12-03")));
    s2.close();
    const first = computeAt(NOW, null, fresh);
    expect(first.averageDays).toBe(0);
    expect(first.average).toEqual({ cost: 0, tokens: 0 });
  });
});

function isOpusName(name: string): boolean {
  return name.includes("opus");
}

function addKey(key: string, days: number): string {
  let out = key;
  for (let i = 0; i < days; i++) out = nextDay(out);
  return out;
}

function nextMonth(key: string): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// ── calendar periods ─────────────────────────────────────────────────────────────

describe("calendar periods on a fixed clock in Toronto", () => {
  test("this week on a Sunday is the Monday before to today, not 7 rolling days", () => {
    const sunday = computeAt(SUNDAY_THE_1ST);
    const state = press(sunday, "W");
    expect(rowKeys(sunday, state)).toEqual([
      "2026-11-01",
      "2026-10-31",
      "2026-10-30",
      "2026-10-29",
      "2026-10-28",
      "2026-10-27",
      "2026-10-26",
    ]);
    const week = sunday.weeks.at(-1) as HistoryPeriod;
    expect(listing(sunday, state).parent).toBe(week);
    expect(week).toMatchObject({ key: "2026-10-26", days: 7 });
    // Mon Oct 26 00:00 EDT to Mon Nov 2 00:00 EST, hand-written.
    const calendar = oracle(Date.parse("2026-10-26T04:00:00Z"), Date.parse("2026-11-02T05:00:00Z"));
    close(week.cost, calendar.cost);
    expect(week.tokens).toBe(calendar.tokens);
    // Seven rolling days would take Sunday Oct 25's late row and miss tonight's.
    const rolling = oracle(SUNDAY_THE_1ST - 7 * DAY, SUNDAY_THE_1ST + 1);
    expect(oracle(EDGES.sunOct25late, EDGES.sunOct25late + 1).tokens).toBeGreaterThan(0);
    expect(rolling.tokens).not.toBe(calendar.tokens);
  });

  test("this week on a Wednesday is Monday to Wednesday", () => {
    const wednesday = computeAt(WEDNESDAY);
    expect(rowKeys(wednesday, press(wednesday, "W"))).toEqual([
      "2026-11-04",
      "2026-11-03",
      "2026-11-02",
    ]);
    const week = wednesday.weeks.at(-1) as HistoryPeriod;
    expect(week.days).toBe(3);
    close(
      week.cost,
      oracle(Date.parse("2026-11-02T05:00:00Z"), Date.parse("2026-11-05T05:00:00Z")).cost,
    );
  });

  test("this month on the 1st is just today", () => {
    const first = computeAt(SUNDAY_THE_1ST);
    const state = press(first, "M");
    expect(rowKeys(first, state)).toEqual(["2026-11-01"]);
    const month = first.months.at(-1) as HistoryPeriod;
    expect(listing(first, state).parent).toBe(month);
    expect(month).toMatchObject({ key: "2026-11", days: 1 });
    // Nov 1 00:00 EDT to Nov 2 00:00 EST: 25 hours, not Oct 31's late row.
    const day = oracle(Date.parse("2026-11-01T04:00:00Z"), Date.parse("2026-11-02T05:00:00Z"));
    close(month.cost, day.cost);
    expect(month.tokens).toBe(day.tokens);
    expect(oracle(EDGES.satOct31late, EDGES.satOct31late + 1).tokens).toBeGreaterThan(0);
    expect(oracle(SUNDAY_THE_1ST - 30 * DAY, SUNDAY_THE_1ST + 1).tokens).toBeGreaterThan(
      day.tokens,
    );
  });

  test("on screen: the tabs and totals rows say the same", async () => {
    const first = computeAt(SUNDAY_THE_1ST);
    const { frame } = await frameOf(first, 120, 45, ["W"]);
    const week = first.weeks.at(-1) as HistoryPeriod;
    expect(line(frame, " 7 days")).toContain(costText(week).text);
    expect(frame).toContain("Mon Oct 26");
    expect(frame).not.toContain("Sun Oct 25");
    const { frame: month } = await frameOf(first, 120, 45, ["M"]);
    const nov = first.months.at(-1) as HistoryPeriod;
    expect(line(month, " 1 day ")).toContain(costText(nov).text);
    expect(month).not.toContain("Sat Oct 31");
  });
});

// ── keys and the shared selection ───────────────────────────────────────────────

const ports = {
  saveConfig() {},
  vmSettings() {},
  vmConfig() {},
  vmRoots() {},
  accountsEdited() {},
  quit() {},
};

function keyOf(k: string): Key {
  // Shifted letters arrive as their lowercase name with the typed character.
  if (/^[A-Z]$/.test(k)) return { name: k.toLowerCase(), sequence: k, ctrl: false };
  return { name: k, sequence: k.length === 1 ? k : "", ctrl: false };
}

async function frameOf(
  model: HistoryVM,
  width: number,
  height: number,
  keys: string[] = [],
  config = fixtureConfig(),
) {
  const c = new Controller(initialState(config, "owner"), ports, TZ);
  c.vmMessage({ type: "views", views: { history: model }, accounts: [], scope: null, ms: 1 });
  c.vmMessage({ type: "mcp", activity: { servers: 1, agents: 2, recent: [] } });
  c.setIngest("live");
  const setup = await render(<Frame controller={c} width={width} height={height} />, width, height);
  await settle(setup, () => c.key(keyOf("2")));
  for (const k of keys) await settle(setup, () => c.key(keyOf(k)));
  return { c, setup, frame: chars(setup) };
}

function line(frame: string, start: string): string {
  return frame.split("\n").find((l) => l.startsWith(start)) ?? "";
}

type Setup = Awaited<ReturnType<typeof render>>;
const dark = theme("dark");

/** The table row drawn on the selection background, as text. */
function selectedLine(setup: Setup): string | null {
  for (const l of setup.captureSpans().lines) {
    if (l.spans.some((s) => rgbToHex(s.bg as RGBA) === dark.hex.sel)) {
      return l.spans
        .map((s) => s.text)
        .join("")
        .trim();
    }
  }
  return null;
}

/** The heat map's cursor (the cell drawn bold in `head`), as the day it stands for. */
function heatCursor(setup: Setup, model: HistoryVM): string | null {
  const lines = setup.captureSpans().lines;
  const monday = chars(setup)
    .split("\n")
    .findIndex((l) => l.startsWith(" Mon ■"));
  for (const [y, l] of lines.entries()) {
    let x = 0;
    for (const s of l.spans) {
      const head = rgbToHex(s.fg as RGBA) === dark.hex.head && (s.attributes & 1) === 1;
      if (head && s.text.includes("■")) {
        const week = (x + s.text.indexOf("■") - 5) / 2;
        return model.days[model.gridStart + week * 7 + (y - monday)]?.key ?? null;
      }
      x += Bun.stringWidth(s.text);
    }
  }
  return null;
}

describe("the heat map and the table share one selection", () => {
  test("moving on the heat map moves the table's row, by day, week and month", async () => {
    let state = press(vm, "left", "up");
    expect(selectedDay(vm, state)).toBe("2026-11-25");
    for (const [group, row] of [
      ["d", "2026-11-25"],
      ["w", "2026-11-23"],
      ["m", "2026-11"],
    ] as const) {
      state = history.keys(group, state, vm) ?? state;
      const list = listing(vm, state);
      expect(list.rows[selectedRow(vm, state, list)]?.key).toBe(row);
    }
    const { setup } = await frameOf(vm, 120, 45, ["left", "up"]);
    expect(heatCursor(setup, vm)).toBe("2026-11-25");
    expect(selectedLine(setup)).toStartWith("Wed Nov 25");
    const { setup: weeks } = await frameOf(vm, 120, 45, ["left", "up", "w"]);
    expect(selectedLine(weeks)).toStartWith("Nov 23–29");
    const { setup: months } = await frameOf(vm, 120, 45, ["left", "up", "m", "left", "left"]);
    expect(heatCursor(months, vm)).toBe("2026-11-11");
    expect(selectedLine(months)).toStartWith("Nov 2026");
  });

  test("moving in the table moves the heat map's cursor, keeping the weekday or the date", async () => {
    let state = press(vm, "tab", "down", "down", "down");
    expect(state.focus).toBe("table");
    expect(selectedDay(vm, state)).toBe("2026-11-30");
    state = history.keys("w", state, vm) ?? state;
    state = history.keys("down", state, vm) ?? state;
    expect(selectedDay(vm, state)).toBe("2026-11-23"); // the Monday a week back
    state = history.keys("m", state, vm) ?? state;
    state = history.keys("down", state, vm) ?? state;
    expect(selectedDay(vm, state)).toBe("2026-10-23");
    state = history.keys("up", state, vm) ?? state;
    state = history.keys("up", state, vm) ?? state;
    expect(selectedDay(vm, state)).toBe("2026-12-03"); // Dec 23 is after today
    const { setup } = await frameOf(vm, 105, 50, ["tab", "down", "down", "down"]);
    expect(heatCursor(setup, vm)).toBe("2026-11-30");
    expect(selectedLine(setup)).toStartWith("Mon Nov 30");
    const { setup: weeks } = await frameOf(vm, 105, 50, ["tab", "w", "down", "down"]);
    expect(selectedLine(weeks)).toStartWith("Nov 16–22");
    expect(heatCursor(weeks, vm)).toBe("2026-11-19");
  });

  test("Enter opens a week's days, the heat map carries it to the next week, Esc goes back", () => {
    let state = press(vm, "tab", "w", "down", "return");
    expect(state.open).toBe("week");
    expect(rowKeys(vm, state)).toEqual([
      "2026-11-29",
      "2026-11-28",
      "2026-11-27",
      "2026-11-26",
      "2026-11-25",
      "2026-11-24",
      "2026-11-23",
    ]);
    state = history.keys("tab", state, vm) ?? state;
    state = history.keys("left", state, vm) ?? state;
    expect(rowKeys(vm, state)[0]).toBe("2026-11-22");
    state = history.keys("escape", state, vm) ?? state;
    expect(state).toMatchObject({ open: null, group: "week" });
    expect(history.keys("escape", state, vm)).toBeUndefined();
    // Enter on a day row opens nothing.
    expect(history.keys("return", press(vm, "tab"), vm)).toBeUndefined();
  });

  test("W and M keep a selection that's in this week or month, else jump to today", () => {
    expect(press(vm, "up", "W")).toMatchObject({ open: "week", day: "2026-12-02" });
    expect(press(vm, "left", "W")).toMatchObject({ open: "week", day: null });
    expect(press(vm, "left", "M")).toMatchObject({ open: "month", day: null });
    expect(press(vm, "up", "up", "M")).toMatchObject({ open: "month", day: "2026-12-01" });
    expect(press(vm, "up", "up", "up", "M")).toMatchObject({ open: "month", day: null });
  });

  test("/ filters by model; typing takes every key; Enter applies, Esc clears", () => {
    let state = press(vm, "w", "/");
    expect(history.capturing?.(state)).toBe(true);
    for (const k of ["m", "Y", "s", "t", "e", "r", "y"]) {
      state = history.keys(k, state, vm) ?? state;
    }
    expect(state.filter).toBe("mYstery");
    state = history.keys("return", state, vm) ?? state;
    expect(state.typing).toBe(false);
    const rows = listing(vm, state).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.models.map((m) => m.name)).toEqual(["claude-mystery-9"]);
    // Accounts are the `a` scope's: an account's name matches nothing.
    expect(listing(vm, press(vm, "/", "c", "o", "d", "e", "x", "return")).rows).toEqual([]);
    expect(listing(vm, press(vm, "/", "z", "z", "return")).rows).toEqual([]);
    state = history.keys("escape", state, vm) ?? state;
    expect(state.filter).toBe("");
    const typing = press(vm, "/", "o", "p", "backspace", "escape");
    expect(typing).toMatchObject({ typing: false, filter: "" });
  });

  test("a model filter narrows every number to that model: rows, totals, bars, heat map, card", async () => {
    const keys = ["/", "o", "p", "u", "s", "return"];
    const isOpus = (r: UsageRow) => r.model.includes("opus");
    const grid = { from: midnight("2026-06-08"), to: midnight("2026-12-04") };
    const opus = oracle(grid.from, grid.to, isOpus);
    const all = oracle(grid.from, grid.to);
    expect(opus.cost).toBeGreaterThan(0);
    expect(opus.cost).toBeLessThan(all.cost / 2);
    const { frame, setup } = await frameOf(vm, 120, 45, keys);
    const shown = listing(vm, press(vm, ...keys)).rows;
    // Days without Opus go; each day left shows Opus's own cost and tokens.
    const used = vm.days
      .slice(vm.gridStart)
      .filter((d) => d.models.some((m) => isOpusName(m.name)));
    expect(shown.map((r) => r.key)).toEqual(used.map((d) => d.key).reverse());
    for (const r of shown) {
      const want = oracle(midnight(r.key), midnight(nextDay(r.key)), isOpus);
      close(r.cost, want.cost);
      expect(r.tokens).toBe(want.tokens);
    }
    // The totals row is Opus's spend over the 26 weeks, not every model's.
    const totals = line(frame, ` ${shown.length} days`);
    expect(totals).toContain(costText({ ...opus, pricedShare: 1, estimatedCost: 0 }).text);
    expect(totals).not.toContain(money(all.cost));
    // Titles say so; the heat map's cells and the card are Opus's too.
    expect(frame).toContain("daily cost · filter: opus");
    expect(frame).toContain("filter: opus · esc clear");
    expect(frame).toContain("filter: opus ─");
    const day = shown[0] as HistoryPeriod;
    expect(selectedLine(setup)).toStartWith(dayLabel(day.key));
    expect(frame).toContain(`cost     ${costText(day).text}`);
    // Ratios are against Opus's own 30-day average.
    const average = oracle(midnight("2026-11-03"), midnight("2026-12-03"), isOpus).cost / 30;
    expect(line(frame, ` ${dayLabel(day.key)}`)).toContain(`${(day.cost / average).toFixed(1)}×`);
    // No accounts column: the view model has no account split per model.
    expect(line(frame, " date")).not.toContain("accounts");
  });

  test("Esc clears the filter, and every number is whole again", async () => {
    const { frame } = await frameOf(vm, 120, 45, ["/", "o", "p", "u", "s", "return", "escape"]);
    expect(line(frame, " 179 days")).toContain(costText(vm.weeksTotal).text);
    expect(frame).not.toContain("filter:");
  });

  test("narrow: the heat map shows the latest weeks that fit, and follows the selection back", async () => {
    const back = Array.from({ length: 24 }, () => "left");
    const { setup, frame } = await frameOf(vm, 50, 30, back);
    expect(frame).toContain("22 WEEKS TO");
    expect(heatCursor(setup, vm)).toBe("2026-06-11");
    const { frame: now } = await frameOf(vm, 50, 30);
    expect(now).toContain("LAST 22 WEEKS");
  });
});

// ── the day card and the selection's edges ───────────────────────────────────────

describe("limit events on the card", () => {
  test("hits come first and are never hidden behind +N more; the card grows for them", async () => {
    const today = vm.days.at(-1) as HistoryDay;
    const at = (utc: string) => Date.parse(`2026-12-03T${utc}:00Z`);
    const marks: HistoryEvent[] = ["13:00", "13:30", "14:00", "14:20"].map((t) => ({
      account: "work",
      kind: "passed_80",
      window: "WEEKLY",
      at: at(t),
      resumedAt: null,
    }));
    const hits: HistoryEvent[] = ["15:00", "17:00", "19:00", "20:00"].map((t) => ({
      account: "personal",
      kind: "reached",
      window: "5-HOUR",
      at: at(t),
      resumedAt: at(t) + 30 * 60_000,
    }));
    const busy: HistoryVM = {
      ...vm,
      days: [...vm.days.slice(0, -1), { ...today, events: [...marks, ...hits] }],
    };
    for (const [width, height] of [
      [105, 50],
      [120, 45],
    ] as const) {
      const { frame } = await frameOf(busy, width, height);
      // 15:00Z is 10:00 EST.
      for (const t of ["10:00", "12:00", "14:00", "15:00"]) {
        expect(frame).toContain(`hit 100% at ${t}`);
      }
      expect(frame).toContain("+4 more");
      expect(frame.indexOf("hit 100% at 15:00")).toBeLessThan(frame.indexOf("+4 more"));
      expect(frame).not.toContain("passed 80%");
    }
  });
});

describe("one side is always highlighted (critique m4)", () => {
  test("a day older than the heat map, left by closing the oldest month, moves onto it", async () => {
    // By month, the oldest month opened, its 3rd selected: Jun 3, before the heat map.
    const opened = press(vm, "m", "tab", "end", "return");
    expect(opened.open).toBe("month");
    expect(selectedDay(vm, opened)).toBe("2026-06-03");
    const back = history.keys("escape", opened, vm) as HistoryState;
    expect(selectedDay(vm, back)).toBe("2026-06-03"); // the June row holds it
    for (const k of ["d", "w"]) {
      const next = history.keys(k, back, vm) as HistoryState;
      expect(selectedDay(vm, next)).toBe("2026-06-08");
      expect(selectedRow(vm, next, listing(vm, next))).toBeGreaterThanOrEqual(0);
    }
    const { setup } = await frameOf(vm, 120, 45, ["m", "tab", "end", "return", "escape", "d"]);
    expect(heatCursor(setup, vm)).toBe("2026-06-08");
    expect(selectedLine(setup)).toStartWith("Mon Jun 8");
  });

  test("from a day the filter hides, ↓ goes to the next older row and ↑ to the next newer", () => {
    // Opus rows: … Dec 2, Nov 28 …; the heat map moves to Dec 1, which has no Opus.
    const hidden = press(vm, "/", "o", "p", "u", "s", "return", "up");
    expect(selectedDay(vm, hidden)).toBe("2026-12-01");
    expect(selectedRow(vm, hidden, listing(vm, hidden))).toBe(-1);
    const table = history.keys("tab", hidden, vm) as HistoryState;
    expect(selectedDay(vm, history.keys("down", table, vm) as HistoryState)).toBe("2026-11-28");
    expect(selectedDay(vm, history.keys("up", table, vm) as HistoryState)).toBe("2026-12-02");
  });
});

// ── frames ───────────────────────────────────────────────────────────────────────

describe.each([
  [105, 50],
  [120, 45],
  [80, 24],
  [160, 50],
] as const)("%i×%i", (width, height) => {
  test("History", async () => {
    const { frame } = await frameOf(vm, width, height);
    const lines = frame.split("\n").slice(0, height);
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
    expect(frame).not.toMatch(/[\d$%*]…|…\d/);
    const today = vm.days.at(-1) as HistoryPeriod;
    expect(frame).toContain(costText(today).text);
    if (width >= 100) {
      expect(frame).toContain("personal 5h hit 100% at 10:02");
      expect(frame).toContain("waited 1h18m");
      // A scoped window's label gives way before its time does (critique M2).
      expect(frame).toContain("passed 80% at 09:05");
      if (width >= 120) expect(frame).toContain("work fable weekly passed 80% at 09:05");
      else expect(frame).toContain("work fable w… passed 80% at 09:05");
    } else {
      // Too short for the card: its one-line summary (critique m3).
      expect(frame).toContain(` Thu Dec 3 · today  ${costText(today).text}  `);
      expect(frame).toContain("1 limit hit · 1 at 80%");
    }
    // Every month has its name: the first, partial one and this one included (critique n1).
    expect(line(frame, "     Jun")).toMatch(/^ {5}Jun +Jul +Aug +Sep +Oct +Nov +Dec( |$)/);
    expect(frame).toMatchSnapshot();
  });

  test("History by week, the table focused", async () => {
    const { frame } = await frameOf(vm, width, height, ["tab", "w", "down"]);
    expect(frame).toMatchSnapshot();
  });
});

test("with costs hidden, tokens take their place: heat map, ratios, card and table", async () => {
  const { frame } = await frameOf(vm, 120, 45, [], fixtureConfig({ show_cost: false }));
  expect(frame).not.toContain("$");
  expect(frame).toContain("LAST 26 WEEKS · daily tokens");
  const today = vm.days.at(-1) as HistoryPeriod;
  const ratio = today.tokens / vm.average.tokens;
  expect(line(frame, " Thu Dec 3")).toContain(`${ratio.toFixed(1)}×`);
  // Shares and the top model follow tokens, not cost.
  const top = [...today.models].sort((a, b) => b.tokens - a.tokens)[0];
  expect(line(frame, " Thu Dec 3")).toContain(top?.name as string);
  expect(frame).toContain(`models   ${top?.name}`);
  expect(frame).toMatchSnapshot();
});

test("colours at 120×45, by role: the cursor, the selected row, the bars", async () => {
  const { setup } = await frameOf(vm, 120, 45, ["left", "up"]);
  expect(roles(setup.captureSpans(), dark)).toMatchSnapshot();
});
