// T16 AC4: roots on one subscription account in the TUI, at the user's half-screen sizes
// (105×50, 120×45). Three made-up Claude roots: `personal-like` and `win-like` on one
// account (auto-detected, as limits.json records it), `work-like` on its own. The Overview
// shows one card for the pair; Accounts says what a root shares; settings link and unlink
// roots, saved through src/config.ts. Labels, identities and paths are obviously fake.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Config, loadConfig, saveConfig } from "../../src/config.ts";
import { saveLimitsCache } from "../../src/limits/cache.ts";
import type { Capture } from "../../src/limits/capture.ts";
import { pairKey } from "../../src/limits/groups.ts";
import { Limits, manualLinks, spendFromQueries } from "../../src/limits/index.ts";
import { Zone } from "../../src/query/tz.ts";
import type { Root } from "../../src/sources/roots.ts";
import { openStoreReader, type UsageRow } from "../../src/store/store.ts";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState, type Ports } from "../../src/tui/controller.ts";
import { costText } from "../../src/tui/views/cells.ts";
import type { AccountRow, AccountsVM } from "../../src/tui/vm/accounts.ts";
import { COMPUTE, type ComputeContext } from "../../src/tui/vm/compute.ts";
import {
  createQueries,
  displayAccounts,
  readStoreAccounts,
  rootInfos,
} from "../../src/tui/vm/session.ts";
import {
  type AccountInfo,
  type OverviewVM,
  type RootInfo,
  VIEW_IDS,
  type ViewId,
  type ViewModels,
} from "../../src/tui/vm/types.ts";
import { guard } from "../guard.ts";
import { bundledTable, type Fixture, fixtureConfig, makeFixtureStore, NOW, TZ } from "./fixture.ts";
import { expectOverviewWhole } from "./overview-numbers.ts";
import { chars, cleanupRenderers, render, settle } from "./render.ts";

guard();

cleanupRenderers();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HOME = "/home/fixture";

const root = (label: string, path: string, source: Root["source"]): Root => ({
  provider: "claude",
  label,
  labelExplicit: false,
  path,
  projects: `${path}/projects`,
  source,
  enabled: true,
  identity: `fixture-identity-${label}`,
  historyOnly: false,
});

const PERSONAL = root("personal-like", `${HOME}/.claude`, "auto");
const WIN = root("win-like", "/mnt/c/Users/fixture/.claude", "wsl");
const WORK = root("work-like", `${HOME}/.claude-work`, "home");
const ROOTS = [PERSONAL, WIN, WORK];

/** A month of usage on each root, and spending in the last half hour on both linked ones. */
function rows(): UsageRow[] {
  const out: UsageRow[] = [];
  let key = 1n;
  const add = (r: Root, ts: number, model: string, inp: number, outp: number, cr: number) =>
    out.push({
      key: key++ * 0x9e3779b9n,
      provider: r.provider,
      identity: r.identity,
      label: r.label,
      ts,
      model,
      inp,
      outp,
      cr,
      cc: 0,
      e5: null,
      e1: null,
      tier: 0,
    });
  for (let day = 29; day >= 1; day--) {
    add(PERSONAL, NOW - day * DAY - 5 * HOUR, "claude-opus-4-8", 4000, 6000, 300_000);
    if (day % 2 === 0)
      add(WIN, NOW - day * DAY - 2 * HOUR, "claude-sonnet-4-6", 9000, 4000, 200_000);
    if (day % 3 === 0) add(WORK, NOW - day * DAY - 3 * HOUR, "claude-opus-4-8", 2000, 3000, 90_000);
  }
  for (const m of [150, 90, 24, 3])
    add(PERSONAL, NOW - m * MIN, "claude-opus-4-8", 3000, 4000, 200_000);
  for (const m of [120, 18, 9]) add(WIN, NOW - m * MIN, "claude-sonnet-4-6", 3000, 5000, 150_000);
  add(WORK, NOW - 5 * HOUR, "claude-opus-4-8", 1000, 1000, 10_000);
  return out;
}

const S = (ms: number) => ms / 1000;

function claude(at: number, session: number, weekly: number, sessionReset: number): Capture {
  return {
    captured_at: S(at),
    source: "claude",
    via: "api",
    rate_limits: {
      session: { label: "5-HOUR", used_percentage: session, resets_at: S(sessionReset) },
      weekly_all: { label: "WEEKLY", used_percentage: weekly, resets_at: S(NOW + 70 * HOUR) },
    },
  };
}

interface SharedFixture extends Fixture {
  readonly limitsPath: string;
  views(config: Config): { views: ViewModels; accounts: AccountInfo[] };
  roots(config: Config): RootInfo[];
}

function makeFixture(): SharedFixture {
  const fixture = makeFixtureStore(rows());
  const limitsPath = join(fixture.dir, "limits.json");
  const reset = NOW + 95 * MIN;
  saveLimitsCache(
    {
      providers: {
        [PERSONAL.identity]: claude(NOW - 2 * MIN, 64, 31, reset),
        // win-like's own capture is older: the card shows personal-like's, the freshest.
        [WIN.identity]: claude(NOW - 12 * MIN, 61, 31, reset),
        [WORK.identity]: claude(NOW - 3 * MIN, 12, 40, NOW + 4 * HOUR),
      },
      status: {},
      // What auto-detection recorded: two agreeing pairs.
      pairs: {
        [pairKey(PERSONAL.identity, WIN.identity)]: {
          agree: 2,
          disagree: 0,
          linked: true,
          detected_at: NOW - 3 * HOUR,
          last: [S(NOW - 3 * HOUR), S(NOW - 3 * HOUR + 2000)],
        },
      },
    },
    limitsPath,
  );
  return {
    ...fixture,
    limitsPath,
    views(config) {
      const db = openStoreReader(fixture.storePath);
      if (db === null) throw new Error("fixture store missing");
      try {
        const prices = bundledTable();
        const q = createQueries(db, prices, TZ, () => NOW);
        const stored = readStoreAccounts(db);
        const accounts = displayAccounts(stored, new Map(), config);
        const ctx: ComputeContext = {
          q,
          now: NOW,
          zone: Zone.of(TZ),
          accounts,
          scope: null,
          window: config.default_window,
          prices,
          sources: {
            roots: ROOTS,
            limits: new Limits({
              limitsPath,
              roots: () => ROOTS,
              db,
              spend: spendFromQueries(q),
              links: () => manualLinks(config),
              now: () => NOW,
            }),
            mcp: null,
            wsl: false,
            home: HOME,
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
    },
    roots(config) {
      const groups = new Limits({
        limitsPath,
        roots: () => ROOTS,
        db: null,
        spend: null,
        links: () => manualLinks(config),
      }).groups();
      return rootInfos(ROOTS, config, HOME, groups);
    },
  };
}

let fx: SharedFixture;
let views: ViewModels;
let accounts: AccountInfo[];
const config = fixtureConfig({ history_only_roots: [] });

beforeAll(() => {
  fx = makeFixture();
  ({ views, accounts } = fx.views(config));
});
afterAll(() => fx.remove());

const key = (name: string) => ({ name, sequence: name, ctrl: false });

function controller(saved: Config[] = [], start: Config = config) {
  const ports: Ports = {
    saveConfig: (c) => saved.push(c),
    vmSettings: () => {},
    vmConfig: () => {},
    vmRoots: () => {},
    accountsEdited: () => {},
    quit: () => {},
  };
  const c = new Controller(initialState(start, "owner"), ports, TZ);
  c.vmMessage({ type: "views", views, accounts, scope: null, ms: 1 });
  c.vmMessage({ type: "roots", roots: fx.roots(start) });
  c.setIngest("live");
  return c;
}

async function frame(width: number, height: number, c: Controller) {
  const setup = await render(<Frame controller={c} width={width} height={height} />, width, height);
  return { setup, text: () => chars(setup) };
}

const overviewVm = () => views.overview as OverviewVM;
const accountsVm = () => views.accounts as AccountsVM;
const row = (label: string) => accountsVm().rows.find((r) => r.label === label) as AccountRow;

describe("the view models", () => {
  test("the Overview: one card for the two linked roots, one for the other", () => {
    const cards = overviewVm().cards ?? [];
    expect(cards.map((c) => c.label)).toEqual(["personal-like + win-like", "work-like"]);
    const [pair] = cards;
    // personal-like's capture, the freshest of the two.
    expect(pair?.fiveHour?.utilization).toBe(0.64);
    expect(pair?.capturedAt).toBe(NOW - 2 * MIN);
    const id = (label: string) => accounts.find((a) => a.label === label)?.id;
    expect(pair?.account).toBe(id("personal-like"));
  });

  test("the card's pace is the sum of both roots' last 30 minutes", () => {
    const db = openStoreReader(fx.storePath);
    if (db === null) throw new Error("no store");
    try {
      const spend = spendFromQueries(createQueries(db, bundledTable(), TZ, () => NOW));
      const ids = readStoreAccounts(db);
      const acct = (r: Root) => ids.find((a) => a.identity === r.identity)?.id as number;
      const alone = (r: Root) => spend.pace([acct(r)], 30).costPerHour;
      const pair = overviewVm().cards?.[0];
      expect(alone(PERSONAL)).toBeGreaterThan(0);
      expect(alone(WIN)).toBeGreaterThan(0);
      expect(pair?.pace.cost).toBeCloseTo(alone(PERSONAL) + alone(WIN), 12);
    } finally {
      db.close();
    }
  });

  test("Accounts: each root listed, the linked ones sharing windows and a 30-day total", () => {
    expect(
      accountsVm()
        .rows.map((r) => r.label)
        .sort(),
    ).toEqual(["personal-like", "win-like", "work-like"]);
    expect(row("win-like").sharedWith).toEqual(["personal-like"]);
    expect(row("personal-like").sharedWith).toEqual(["win-like"]);
    expect(row("work-like").sharedWith).toEqual([]);
    expect(row("work-like").accountLast30).toBeNull();
    // win-like shows the account's windows, captured through personal-like.
    expect(row("win-like").limits?.asOf).toBe(NOW - 2 * MIN);
    expect(row("win-like").limits?.windows[0]?.utilization).toBe(0.64);
    // The sparkline stays per root; the account total adds both.
    const total = row("win-like").accountLast30?.cost ?? 0;
    expect(total).toBeCloseTo(row("win-like").last30.cost + row("personal-like").last30.cost, 9);
    expect(row("personal-like").accountLast30?.cost).toBe(total);
  });
});

describe.each([
  [105, 50],
  [120, 45],
] as const)("%i×%i", (width, height) => {
  test("Overview: one card titled with both labels", async () => {
    const { text } = await frame(width, height, controller());
    const screen = text();
    expect(screen).toMatchSnapshot();
    expect(screen).toContain("personal-like + win-like");
    expect(screen).not.toMatch(/─ win-like/);
    expectOverviewWhole(screen, overviewVm(), width, config);
  });

  test("Accounts: win-like says what it shares, and the account's total", async () => {
    const c = controller();
    const { setup, text } = await frame(width, height, c);
    const order = accountsVm().rows.map((r) => r.label);
    await settle(setup, () => {
      c.key(key("4"));
      for (let i = 0; i < order.indexOf("win-like"); i++) c.key(key("down"));
    });
    const screen = text();
    expect(screen).toMatchSnapshot();
    expect(screen).toContain("shared with personal-like");
    const sum = costText(row("win-like").accountLast30 as AccountRow["last30"]).text;
    expect(screen).toContain(`account total (all linked roots): ${sum}`);
  });

  test("settings: the shared column, linking work-like, then unlinking win-like", async () => {
    const saved: Config[] = [];
    const c = controller(saved);
    const { setup, text } = await frame(width, height, c);
    const pick = (label: string) => fx.roots(config).findIndex((r) => r.label === label);
    await settle(setup, () => {
      c.key(key("s"));
      for (let i = 0; i < 6; i++) c.key(key("down"));
      c.key(key("return"));
      for (let i = 0; i < pick("work-like"); i++) c.key(key("down"));
    });
    const list = text();
    expect(list).toMatchSnapshot();
    expect(list).toContain("same as win-like");
    expect(list).toContain("same as personal-like");
    expect(list).toContain("a same account as… · u unlink");
    await settle(setup, () => c.key(key("a")));
    const picker = text();
    expect(picker).toMatchSnapshot();
    expect(picker).toContain("work-like is on the same subscription account as:");
    await settle(setup, () => {
      c.key(key("down"));
      c.key(key("return"));
    });
    // Linked to win-like, the second choice: one same_account entry, saved.
    expect(saved.at(-1)?.same_account).toEqual([[WORK.identity, WIN.identity]]);
    // Unlink win-like (auto-linked to personal-like): kept apart from both roots it shared
    // with now, and out of the link just made.
    const linked = saved.at(-1) as Config;
    c.vmMessage({ type: "roots", roots: fx.roots(linked) });
    await settle(setup, () => {
      c.key(key("up"));
      c.key(key("u"));
    });
    const after = saved.at(-1) as Config;
    expect(after.same_account).toEqual([]);
    expect(after.separate_accounts.map((p) => [...p].sort())).toEqual(
      [
        [WIN.identity, PERSONAL.identity],
        [WIN.identity, WORK.identity],
      ].map((p) => p.sort()),
    );
    c.vmMessage({ type: "roots", roots: fx.roots(after) });
    await settle(setup, () => {});
    const unlinked = text();
    expect(unlinked).toMatchSnapshot();
    expect(unlinked).not.toContain("same as");
  });
});

test("link and unlink persist through config.json", () => {
  const path = join(fx.dir, "config.json");
  const saved: Config[] = [];
  const c = controller(saved);
  c.key(key("s"));
  for (let i = 0; i < 6; i++) c.key(key("down"));
  c.key(key("return"));
  // work-like: same account as personal-like (the first choice).
  for (let i = 0; i < 2; i++) c.key(key("down"));
  c.key(key("a"));
  c.key(key("return"));
  saveConfig(saved.at(-1) as Config, path);
  expect(loadConfig(path).same_account).toEqual([[WORK.identity, PERSONAL.identity]]);
  // With that saved, all three are one account; work-like unlinked again.
  c.vmMessage({ type: "roots", roots: fx.roots(loadConfig(path)) });
  c.key(key("u"));
  saveConfig(saved.at(-1) as Config, path);
  const back = loadConfig(path);
  expect(back.same_account).toEqual([]);
  expect(back.separate_accounts).toEqual([
    [WORK.identity, PERSONAL.identity],
    [WORK.identity, WIN.identity],
  ]);
  expect(fx.roots(back).map((r) => [r.label, r.group?.others.length ?? 0])).toEqual([
    ["personal-like", 1],
    ["win-like", 1],
    ["work-like", 0],
  ]);
});
