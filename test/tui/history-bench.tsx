// History's budgets (T12 acceptance 4) on a 1M-row synthetic store:
// - the view model computed cold, in the view-model Worker's way, off the input path;
// - opening History and switching its grouping, with the view model warm: key → frame.
// Usage: bun test/tui/history-bench.tsx   (exits 1 if a budget is missed)
//
// The store goes in the OS temp dir (TMPDIR; on this WSL machine /tmp is tmpfs, so point
// TMPDIR at an ext4 directory to measure there) and is removed afterwards.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { Zone } from "../../src/query/tz.ts";
import { openStore, openStoreReader } from "../../src/store/store.ts";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState } from "../../src/tui/controller.ts";
import { computeHistory, readAccountEvents } from "../../src/tui/vm/history.ts";
import { createQueries, displayAccounts, readStoreAccounts } from "../../src/tui/vm/session.ts";
import type { HistoryVM } from "../../src/tui/vm/types.ts";
import { syntheticRows } from "../query/synthetic.ts";
import { bundledTable, fixtureConfig } from "./fixture.ts";
import { render } from "./render.ts";

const ROWS = 1_000_000;
const TZ = "America/Toronto";
/** Thu 2026-12-03 15:40 EST: a year of data behind it. */
const NOW = Date.parse("2026-12-03T20:40:00Z");
const BUDGET = { compute: 50, frame: 16 };
let failed = false;

function verdict(label: string, value: number, budget: number): void {
  const ok = value <= budget;
  if (!ok) failed = true;
  console.log(
    `  ${label.padEnd(52)} ${value.toFixed(2).padStart(8)} ms  (budget ${budget} ms: ${ok ? "ok" : "MISSED"})`,
  );
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] as number };
}

const base = mkdtempSync(join(tmpdir(), "tokenhud-history-bench-"));
try {
  const storePath = join(base, "tokenhud.db");
  let t = performance.now();
  const rows = syntheticRows({ rows: ROWS, from: NOW - 365 * 86_400_000, to: NOW, seed: 11 });
  const store = openStore(storePath);
  for (let i = 0; i < rows.length; i += 100_000) store.upsert(rows.slice(i, i + 100_000));
  store.close();
  console.log(
    `store: ${ROWS.toLocaleString("en-US")} rows, built in ${((performance.now() - t) / 1000).toFixed(1)} s`,
  );

  const db = openStoreReader(storePath);
  if (db === null) throw new Error("store missing");
  const stored = readStoreAccounts(db);
  const accounts = displayAccounts(stored, new Map(), fixtureConfig());
  const table = bundledTable();
  const compute = (q: ReturnType<typeof createQueries>) =>
    q.snapshot(
      () =>
        computeHistory({
          q,
          now: NOW,
          zone: Zone.of(TZ),
          accounts,
          scope: null,
          window: "all",
          limitEvents: (range) => readAccountEvents(db, stored, range),
          prices: table,
          sources: null,
        }).vm,
    );

  console.log("\nthe view model, in the Worker (off the input path)");
  // Cold: a new engine that has read nothing, as after a time-zone change or a reopen.
  const cold: number[] = [];
  for (let i = 0; i < 5; i++) {
    const q = createQueries(db, table, TZ, () => NOW);
    t = performance.now();
    compute(q);
    cold.push(performance.now() - t);
  }
  console.log(`  cold engine, 5 runs: ${cold.map((x) => x.toFixed(1)).join(", ")} ms`);
  verdict("computed with a cold engine (max of 5)", stats(cold).max, BUDGET.compute);
  // As the session runs: the engine warmed at startup, every view recomputed after a change.
  const q = createQueries(db, table, TZ, () => NOW);
  t = performance.now();
  q.warm();
  console.log(`  engine warm-up over the whole store: ${(performance.now() - t).toFixed(1)} ms`);
  const warm: number[] = [];
  let vm: HistoryVM | null = null;
  for (let i = 0; i < 20; i++) {
    t = performance.now();
    vm = compute(q);
    warm.push(performance.now() - t);
  }
  const w = stats(warm);
  console.log(`  warm engine, 20 runs: p50 ${w.p50.toFixed(2)} max ${w.max.toFixed(2)} ms`);
  verdict("computed with the warm engine (max of 20)", w.max, BUDGET.compute);
  console.log(
    `  ${vm?.days.length} days, ${JSON.stringify(vm).length.toLocaleString("en-US")} bytes as JSON`,
  );
  db.close();

  console.log("\nframes in-process (OpenTUI test renderer, 105×50), the view model warm");
  const ports = {
    saveConfig() {},
    vmSettings() {},
    vmConfig() {},
    vmRoots() {},
    accountsEdited() {},
    quit() {},
  };
  const c = new Controller(initialState(fixtureConfig(), "owner"), ports, TZ);
  c.vmMessage({ type: "views", views: { history: vm as HistoryVM }, accounts, scope: null, ms: 0 });
  c.setIngest("live");
  const setup = await render(<Frame controller={c} width={105} height={50} />, 105, 50);
  const press = async (name: string, sequence = name) => {
    const a = performance.now();
    await act(async () => c.key({ name, sequence, ctrl: false }));
    await setup.renderOnce();
    return performance.now() - a;
  };
  // The first opens compile the view's code; a user sees that once.
  for (let i = 0; i < 5; i++) {
    await press("1");
    await press("2");
  }
  const open: number[] = [];
  for (let i = 0; i < 50; i++) {
    await press("1");
    open.push(await press("2"));
  }
  const o = stats(open);
  console.log(
    `  open History: p50 ${o.p50.toFixed(2)} p95 ${o.p95.toFixed(2)} max ${o.max.toFixed(2)} ms`,
  );
  verdict("open History (key → frame, p95 of 50)", o.p95, BUDGET.frame);
  // T17: the table's tabs (a/d), and a week opened and closed (enter, esc).
  const group: number[] = [];
  for (let i = 0; i < 80; i++) group.push(await press(i % 10 < 5 ? "right" : "left"));
  for (let i = 0; i < 10; i++)
    group.push(await press("return", "\r"), await press("escape", "\u001b"));
  const g = stats(group);
  console.log(
    `  tabs, a week opened and closed: p50 ${g.p50.toFixed(2)} p95 ${g.p95.toFixed(2)} max ${g.max.toFixed(2)} ms`,
  );
  verdict("switch tabs (key → frame, p95 of 100)", g.p95, BUDGET.frame);
  // A model filter narrows every number on screen, worked out per frame from the view model.
  for (const k of ["f", "o", "p", "u", "s", "return"]) await press(k);
  const filtered: number[] = [];
  for (let i = 0; i < 60; i++) filtered.push(await press(i % 10 < 5 ? "right" : "left"));
  const fl = stats(filtered);
  console.log(
    `  tabs with "opus": p50 ${fl.p50.toFixed(2)} p95 ${fl.p95.toFixed(2)} max ${fl.max.toFixed(2)} ms`,
  );
  verdict("switch tabs, filtered by model (p95 of 60)", fl.p95, BUDGET.frame);
  await press("escape", "\u001b");
  const moves: number[] = [];
  for (let i = 0; i < 50; i++) moves.push(await press(["up", "down", "up", "up"][i % 4] as string));
  const m = stats(moves);
  console.log(
    `  row moves: p50 ${m.p50.toFixed(2)} p95 ${m.p95.toFixed(2)} max ${m.max.toFixed(2)} ms`,
  );
  setup.renderer.destroy();
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
