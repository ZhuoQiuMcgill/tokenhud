// Store benchmark: the T3 budgets, plus what a large store costs on open.
// Usage: bun run bench:store   (exits 1 if a budget is missed)
// Stores go in the OS temp dir (a Linux filesystem under WSL), never under the repo.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerKey } from "../../src/store/key.ts";
import { openStore, type UsageRow } from "../../src/store/store.ts";

const MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "gpt-5.5",
  "codex-unattributed",
  "claude-haiku-4-5",
];
const T0 = 1_750_000_000_000;
let failed = false;

function time<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const out = fn();
  return [out, performance.now() - t0];
}

function report(label: string, ms: number, budget?: number): void {
  const verdict =
    budget === undefined
      ? ""
      : ms < budget
        ? `  (budget ${budget} ms: ok)`
        : `  (budget ${budget} ms: MISSED)`;
  if (budget !== undefined && ms >= budget) failed = true;
  console.log(`${label.padEnd(44)} ${ms.toFixed(1).padStart(9)} ms${verdict}`);
}

function rows(from: number, count: number): UsageRow[] {
  return Array.from({ length: count }, (_, j) => {
    const i = from + j;
    return {
      key: ledgerKey(`c\x1freq_FAKE${i}\x1fmsg_FAKE${i}`),
      provider: i % 3 === 0 ? "codex" : "claude",
      identity: `identity-${i % 3}`,
      label: `account-${i % 3}`,
      ts: T0 + i * 30_000, // one row per 30 s: 100k rows span about 35 days
      model: MODELS[i % MODELS.length] ?? "m",
      inp: i % 997,
      outp: i % 4999,
      cr: (i * 7) % 150_000,
      cc: i % 7000,
      e5: i % 20 ? i % 5000 : null,
      e1: i % 20 ? i % 2000 : null,
      tier: i % 50 === 0 ? 1 : 0,
    };
  });
}

const dir = mkdtempSync(join(tmpdir(), "tokenhud-bench-"));
try {
  const materials = Array.from(
    { length: 50_000 },
    (_, i) => `c\x1freq_FAKE${i}x\x1fmsg_FAKE${i * 7919}`,
  );
  ledgerKey(materials[0] ?? "");
  report("ledgerKey x 50,000", time(() => materials.forEach(ledgerKey))[1], 300);

  const path = join(dir, "tokenhud.db");
  const store = openStore(path);
  const batch = rows(0, 100_000);
  const [changed, ms] = time(() => store.upsert(batch));
  if (changed !== 100_000) throw new Error(`upsert changed ${changed}`);
  report("upsert 100,000 new rows (triggers on)", ms, 2000);
  report("re-send the same 100,000 (no change)", time(() => store.upsert(batch))[1]);
  report("rebuildRollups at 100,000 rows", time(() => store.rebuildRollups())[1]);
  report("rollupConsistent at 100,000 rows", time(() => store.rollupConsistent())[1]);

  for (let from = 100_000; from < 1_000_000; from += 100_000) store.upsert(rows(from, 100_000));
  store.close();
  report("open at 1,000,000 rows (incl. drift probe)", time(() => openStore(path).close())[1]);
  const big = openStore(path);
  report("rollupConsistent at 1,000,000 rows", time(() => big.rollupConsistent())[1]);
  report("rebuildRollups at 1,000,000 rows", time(() => big.rebuildRollups())[1]);
  big.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
