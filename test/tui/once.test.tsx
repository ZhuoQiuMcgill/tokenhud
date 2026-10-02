// `tokenhud --once` (T10 §7, AC 5): the Overview once, at a given width, from the same view
// model and renderables as the TUI. Plain text off a TTY; truecolour ANSI on one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Limits, spendFromQueries } from "../../src/limits/index.ts";
import { openStoreReader } from "../../src/store/store.ts";
import { shareCells } from "../../src/tui/components/hbar.ts";
import { renderOverview } from "../../src/tui/once.tsx";
import { readAccountEvents } from "../../src/tui/vm/history.ts";
import { displayAccounts, readStoreAccounts } from "../../src/tui/vm/session.ts";
import type { OverviewVM } from "../../src/tui/vm/types.ts";
import { bundledTable, fixtureConfig, NOW } from "./fixture.ts";
import { MCP, makeOverviewFixture, type OverviewFixture, ROOTS } from "./overview-fixture.ts";
import { expectOverviewWhole } from "./overview-numbers.ts";

const ESC = String.fromCharCode(27);
let fixture: OverviewFixture;
beforeAll(() => {
  fixture = makeOverviewFixture();
});
afterAll(() => fixture.remove());

async function once(width: number, color: boolean, config = fixtureConfig()): Promise<string> {
  const db = openStoreReader(fixture.storePath);
  if (db === null) throw new Error("no store");
  try {
    return await renderOverview({
      db,
      prices: bundledTable(),
      config,
      accounts: displayAccounts(readStoreAccounts(db), new Map(), config),
      width,
      color,
      now: NOW,
      systemZone: "UTC",
      sources: (q) => ({
        roots: ROOTS,
        limits: new Limits({
          limitsPath: fixture.limitsPath,
          roots: () => ROOTS,
          db,
          spend: spendFromQueries(q),
          now: () => NOW,
        }),
        mcp: MCP,
        wsl: false,
        home: "/home/fixture",
      }),
      limitEvents: (range) => readAccountEvents(db, readStoreAccounts(db), range),
    });
  } finally {
    db.close();
  }
}

describe.each([105, 120])("at width %i", (width) => {
  test("plain text matches the snapshot", async () => {
    const text = await once(width, false);
    for (const line of text.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    expect(text).not.toContain(ESC);
    expect(text.split("\n")[0]).toContain("as of 11:40");
    expect(text).toMatchSnapshot();
  });

  test("ANSI colours match the snapshot and carry the same characters", async () => {
    const ansi = await once(width, true);
    expect(ansi).toContain(`${ESC}[38;2;232;163;61m`); // cost amber, gen.py P["cost"]
    // Stripping the escapes gives the plain frame, but for the bars' tracks, which plain
    // text leaves blank.
    const stripped = ansi.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "").split("\n");
    const plain = (await once(width, false)).split("\n");
    expect(stripped).toHaveLength(plain.length);
    stripped.forEach((line, i) => {
      const p = (plain[i] as string).padEnd(line.length);
      for (let k = 0; k < line.length; k++) {
        if (p[k] !== line[k]) expect(`${p[k]}${line[k]}`).toBe(" ━");
      }
    });
    expect(ansi).toMatchSnapshot();
  });
});

test("every section shows, at full height: --once has no rows to fit", async () => {
  const text = await once(80, false);
  for (const title of [" LIMITS", " SPEND", " ACTIVITY", " TOP MODELS", " LIMIT EVENTS"]) {
    expect(text).toContain(title);
  }
});

test("the saved scope filters it, and the header says so", async () => {
  const text = await once(120, false, fixtureConfig({ account_scope: "work" }));
  expect(text.split("\n")[0]).toContain("scope work");
  expect(text).toContain("work · claude");
  expect(text).not.toContain("personal · claude");
});

// Critique m3: without colour a bar has no track, so its length is its share.
test("plain-text share bars are as long as their share", async () => {
  const text = await once(120, false);
  const top = text.slice(text.indexOf(" TOP MODELS"), text.indexOf(" LIMIT EVENTS"));
  const bars = [...top.matchAll(/(\d+)%( ━*)?$/gm)].map((m) => ({
    share: Number(m[1]) / 100,
    cells: (m[2] ?? "").trim().length,
  }));
  expect(bars.length).toBeGreaterThanOrEqual(3);
  for (const { share, cells } of bars) expect(cells).toBe(shareCells(share, 6));
  expect(new Set(bars.map((b) => b.cells)).size).toBeGreaterThan(1);
});

// Critique m2: narrow widths drop sections and columns and use compact numbers, but never
// cut one. Every number of the view model the Overview shows appears whole (T11's checker).
describe.each([50, 60, 80, 105, 120])("--once --width %i", (width) => {
  test.each([true, false])("show_cost %p: every number appears intact", async (showCost) => {
    const config = fixtureConfig({ show_cost: showCost });
    const text = await once(width, false, config);
    const vm = fixture.overview() as OverviewVM;
    expectOverviewWhole(text, vm, width, config);
    for (const title of [" LIMITS", " SPEND", " ACTIVITY", " TOP MODELS", " LIMIT EVENTS"]) {
      expect(text).toContain(title);
    }
    if (showCost) expect(text).toContain("unpriced");
  });
});
