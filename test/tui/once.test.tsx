// `tokenhud --once` (T10 §7, AC 5): the Overview once, at a given width, from the same view
// model and renderables as the TUI. Plain text off a TTY; truecolour ANSI on one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openStoreReader } from "../../src/store/store.ts";
import { renderOverview } from "../../src/tui/once.tsx";
import { displayAccounts, readStoreAccounts } from "../../src/tui/vm/session.ts";
import { bundledTable, type Fixture, fixtureConfig, makeFixtureStore, NOW } from "./fixture.ts";

const ESC = String.fromCharCode(27);
let fixture: Fixture;
beforeAll(() => {
  fixture = makeFixtureStore();
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
    // Stripping the escapes gives the plain frame.
    expect(ansi.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "")).toBe(await once(width, false));
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
