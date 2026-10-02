// A deterministic store for the TUI's view-model, frame and --once tests: five made-up
// accounts (one history-only), sixty days of usage up to a fixed "now", priced, unpriced
// and fast-tier models. Identities and labels are obviously fake.
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, defaultConfig } from "../../src/config.ts";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import type { UsageQueries } from "../../src/query/engine.ts";
import { Zone } from "../../src/query/tz.ts";
import { openStore, openStoreReader, type UsageRow } from "../../src/store/store.ts";
import type { AccountSources } from "../../src/tui/vm/accounts.ts";
import { COMPUTE, type ComputeContext } from "../../src/tui/vm/compute.ts";
import { createQueries, displayAccounts, readStoreAccounts } from "../../src/tui/vm/session.ts";
import {
  type AccountInfo,
  VIEW_IDS,
  type ViewId,
  type ViewModels,
} from "../../src/tui/vm/types.ts";
import { prng } from "../query/synthetic.ts";

/** Tuesday 2026-09-29, 11:40 in Toronto. */
export const NOW = Date.parse("2026-09-29T15:40:00Z");
export const TZ = "America/Toronto";
const DAY = 86_400_000;

export const FIXTURE_ACCOUNTS = [
  { provider: "claude", identity: "fixture-identity-personal", label: "personal" },
  { provider: "claude", identity: "fixture-identity-work", label: "work" },
  { provider: "claude", identity: "fixture-identity-old", label: "old-laptop" },
  { provider: "codex", identity: "fixture-identity-codex", label: "codex" },
  { provider: "codex", identity: "fixture-identity-codex-win", label: "codex-win" },
] as const;

const MODELS: Record<string, readonly string[]> = {
  claude: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-mystery-9"],
  codex: ["gpt-5.6-sol", "gpt-5.5"],
};

/** Usage rows: each account works a few sessions a day; the history-only one stopped 20 days ago. */
export function fixtureRows(): UsageRow[] {
  const rnd = prng(42);
  const rows: UsageRow[] = [];
  let key = 1n;
  for (let day = 59; day >= 0; day--) {
    for (const [a, account] of FIXTURE_ACCOUNTS.entries()) {
      if (account.identity === "fixture-identity-old" && day < 20) continue;
      if (rnd() < 0.25) continue; // a day off
      const sessions = 1 + Math.floor(rnd() * 3);
      for (let s = 0; s < sessions; s++) {
        const models = MODELS[account.provider] as readonly string[];
        const model = models[Math.floor(rnd() * models.length)] as string;
        let ts = NOW - day * DAY - Math.floor(rnd() * 20 * 3_600_000) - a * 60_000;
        if (ts > NOW) ts = NOW - 60_000;
        const turns = 5 + Math.floor(rnd() * 25);
        for (let t = 0; t < turns && ts <= NOW; t++, ts += 45_000) {
          rows.push({
            key: key++ * 0x9e3779b9n,
            ...account,
            ts,
            model,
            inp: 200 + Math.floor(rnd() * 3000),
            outp: 50 + Math.floor(rnd() * 2000),
            cr: Math.floor(rnd() * 80_000),
            cc: Math.floor(rnd() * 6000),
            e5: null,
            e1: null,
            tier: model === "claude-opus-4-8" && rnd() < 0.1 ? 1 : 0,
          });
        }
      }
    }
  }
  return rows;
}

export function fixtureConfig(over: Partial<Config> = {}): Config {
  return {
    ...defaultConfig(),
    time_zone: TZ,
    history_only_roots: ["fixture-identity-old"],
    ...over,
  };
}

export interface Fixture {
  readonly dir: string;
  readonly storePath: string;
  remove(): void;
}

/** A store with the fixture rows, in a temp dir. */
export function makeFixtureStore(rows: readonly UsageRow[] = fixtureRows()): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-tui-fixture-"));
  const storePath = join(dir, "tokenhud.db");
  const store = openStore(storePath);
  store.upsert(rows);
  store.close();
  return {
    dir,
    storePath,
    remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
  };
}

/** The bundled table as the app loads it (no overrides): estimated aliases included. */
export function bundledTable(): PriceTable {
  return new PriceTable(bundledPricing().models, bundledPricing().aliases);
}

/** Every view model of the fixture store at NOW, the way the view-model Worker computes them. */
export function fixtureViews(
  storePath: string,
  config: Config = fixtureConfig(),
  scope: number | null = null,
  /** What the Accounts view reads besides usage, over the fixture's connection. */
  sources: ((db: Database, q: UsageQueries) => AccountSources) | null = null,
): { views: ViewModels; accounts: AccountInfo[] } {
  const db = openStoreReader(storePath);
  if (db === null) throw new Error("fixture store missing");
  try {
    const prices = bundledTable();
    const q = createQueries(db, prices, TZ, () => NOW);
    const accounts = displayAccounts(readStoreAccounts(db), new Map(), config);
    const ctx: ComputeContext = {
      q,
      now: NOW,
      zone: Zone.of(TZ),
      accounts,
      scope,
      window: config.default_window,
      prices,
      sources: sources?.(db, q) ?? null,
    };
    const views: ViewModels = {};
    q.snapshot(() => {
      for (const id of VIEW_IDS) (views as Record<ViewId, unknown>)[id] = COMPUTE[id](ctx).vm;
    });
    return { views, accounts };
  } finally {
    db.close();
  }
}
