// The TUI keeps limits current (PM addendum to T11): its ingest Worker runs T8's schedule.
// A real ingest Worker, with the fetchers mocked by its test entry (no network), started
// with the options the TUI gives it: limits are fetched after the first scan and then on
// schedule, history-only accounts are never fetched, and an account whose fetch fails
// keeps its last-good limits on the Overview, with their age.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, defaultConfig } from "../../src/config.ts";
import { type IngestMessage, startIngestWorker } from "../../src/ingest/client.ts";
import { saveLimitsCache } from "../../src/limits/cache.ts";
import { Limits, spendFromQueries } from "../../src/limits/index.ts";
import { Zone } from "../../src/query/tz.ts";
import { rootIdentity } from "../../src/sources/roots.ts";
import { openStoreReader } from "../../src/store/store.ts";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState, type Ports } from "../../src/tui/controller.ts";
import { computeOverview } from "../../src/tui/vm/overview.ts";
import { createQueries, discoverRoots } from "../../src/tui/vm/session.ts";
import type { OverviewVM } from "../../src/tui/vm/types.ts";
import { bundledTable } from "./fixture.ts";
import { chars, cleanupRenderers, render } from "./render.ts";

cleanupRenderers();

const ENTRY = new URL("./vm/limits-ingest-worker.ts", import.meta.url).href;
const MIN = 60_000;

let dir: string | null = null;
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  dir = null;
});

async function until(pred: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

test("the TUI's ingest Worker fetches limits on schedule, never history-only accounts, and a failed fetch keeps its last-good limits with their age", async () => {
  dir = mkdtempSync(join(tmpdir(), "tokenhud-limits-worker-"));
  const home = join(dir, "home");
  // `personal` is the default ~/.claude; the others are configured roots.
  const path = (name: string) => join(dir as string, "roots", name);
  for (const name of ["flaky", "signedout", "old"]) mkdirSync(path(name), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const config: Config = {
    ...defaultConfig(),
    claude_roots: ["flaky", "signedout", "old"].map((label) => ({ path: path(label), label })),
    history_only_roots: [rootIdentity(path("old"), home)],
  };
  const discover = { home, env: {}, wslUsersDir: null };
  const limitsPath = join(dir, "config", "limits.json");
  // flaky's last-good limits, captured 47 minutes ago.
  const seededAt = Date.now() - 47 * MIN;
  saveLimitsCache(
    {
      providers: {
        [rootIdentity(path("flaky"), home)]: {
          captured_at: seededAt / 1000,
          source: "claude",
          via: "api",
          rate_limits: {
            session: {
              label: "5-HOUR",
              used_percentage: 64,
              resets_at: (seededAt + 3 * 3_600_000) / 1000,
            },
          },
        },
      },
      status: {},
    },
    limitsPath,
  );

  const messages: IngestMessage[] = [];
  const storePath = join(dir, "config", "tokenhud.db");
  const worker = startIngestWorker(
    {
      storePath,
      cachePath: join(dir, "config", "cache.db"),
      config,
      discover,
      importLedger: null,
      poolSize: 1,
      // As src/tui/run.tsx starts it.
      limits: { limitsPath, ccUsageLimits: null },
    },
    (m) => messages.push(m),
    undefined,
    ENTRY,
  );
  const fetches = () => {
    let text = "";
    try {
      text = readFileSync(join(dir as string, "config", "fetches.log"), "utf8");
    } catch {
      // none yet
    }
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => ({ label: l.split(" ")[0] as string, at: Number(l.split(" ")[1]) }));
  };
  try {
    // The first round after the first scan, then rounds at least a second apart.
    await until(() => fetches().filter((f) => f.label === "personal").length >= 3, "3 rounds");
    const ready = messages.findIndex((m) => m.type === "ready");
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(ready).toBeLessThan(messages.findIndex((m) => m.type === "limits"));
    const personal = fetches().filter((f) => f.label === "personal");
    for (let i = 1; i < personal.length; i++) {
      expect(
        (personal[i] as { at: number }).at - (personal[i - 1] as { at: number }).at,
      ).toBeGreaterThanOrEqual(900);
    }
    // Configured history-only: never asked. Refused once: never asked again. Failing: backed
    // off (the next try is a minute away).
    const count = (label: string) => fetches().filter((f) => f.label === label).length;
    expect(count("old")).toBe(0);
    expect(count("signedout")).toBe(1);
    expect(count("flaky")).toBe(1);
    // Every change to limits.json was announced, for the TUI to recompute its Overview.
    const announced = new Set(messages.flatMap((m) => (m.type === "limits" ? m.accounts : [])));
    expect(announced.has(rootIdentity(join(home, ".claude"), home))).toBe(true);
  } finally {
    await worker.stop();
  }

  // The Overview the view-model Worker computes from that limits.json.
  const db = openStoreReader(storePath);
  if (db === null) throw new Error("no store");
  let vm: OverviewVM;
  try {
    const now = Date.now();
    const prices = bundledTable();
    const q = createQueries(db, prices, "UTC", () => now);
    const roots = discoverRoots(config, discover);
    vm = q.snapshot(
      () =>
        computeOverview({
          q,
          now,
          zone: Zone.of("UTC"),
          accounts: [],
          scope: null,
          window: "all",
          prices,
          sources: {
            roots,
            limits: new Limits({
              limitsPath,
              roots: () => roots,
              db,
              spend: spendFromQueries(q),
              now: () => now,
            }),
            mcp: null,
            wsl: false,
            home,
          },
        }).vm,
    );
  } finally {
    db.close();
  }
  const card = (label: string) => (vm.cards ?? []).find((c) => c.label === label);
  expect(card("personal")?.fiveHour?.utilization).toBe(0.35);
  expect(Date.now() - (card("personal")?.capturedAt ?? 0)).toBeLessThan(MIN);
  // The failed fetch left flaky's limits as they were: 47 minutes old, and the card says so.
  expect(card("flaky")?.capturedAt).toBe(Math.round(seededAt));
  expect(card("flaky")?.fiveHour?.utilization).toBe(0.64);
  expect(card("signedout")?.signedIn).toBe(false);
  expect(card("old")?.signedIn).toBe(false);

  // On screen: fresh meters, the stale card's age, and "not signed in here" for the others.
  const ports: Ports = {
    saveConfig: () => {},
    vmSettings: () => {},
    vmConfig: () => {},
    vmRoots: () => {},
    accountsEdited: () => {},
    quit: () => {},
  };
  const c = new Controller(initialState({ ...config, time_zone: "UTC" }, "owner"), ports, "UTC");
  c.vmMessage({ type: "views", views: { overview: vm }, accounts: [], scope: null, ms: 0 });
  const text = chars(await render(<Frame controller={c} width={120} height={45} />, 120, 45));
  expect(text).toMatch(/flaky · claude \(4[78]m old\)/);
  expect(text).toContain(" 35%");
  expect(text.split("not signed in here").length - 1).toBe(2);
}, 60_000);
