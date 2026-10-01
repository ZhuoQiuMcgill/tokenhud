// cc-usage's own parser on synthetic rollouts (test/fixtures/sources/gen_codex_cases.py)
// against tokenhud's scheme-1 reading of the same bytes, then tokenhud's scheme-2 ingest of
// them: the replayed usage of child rollouts gone, every other record identical.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { walk } from "../../src/ingest/files.ts";
import type { FileEntry } from "../../src/sources/claude.ts";
import {
  type CodexLimitSnapshot,
  extractCodexV1,
  newerLimits,
  readCodexFile,
} from "../../src/sources/codex.ts";
import { comparePyPaths } from "../../src/sources/pypath.ts";
import { ledgerKey } from "../../src/store/key.ts";
import { UNATTRIBUTED } from "../../src/store/store.ts";
import cases from "../fixtures/sources/codex-cases.json";
import { cleanup, storedRows, tempDir } from "../ingest/helpers.ts";
import { codexRoot, materialize, openCodexEngine } from "./codex-helpers.ts";

afterEach(cleanup);

const isCount = (v: number) => Number.isSafeInteger(v) && v >= 0;
const SEP = "\x1f";
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** The key of a token_count event, as cc-usage derives it. */
const key = (n: number, ts: string, total: string, last: string) =>
  ledgerKey(["x", sid(n), ts, total, last].join(SEP));

/** Every rollout of a Codex home in cc-usage's order (Python path order). */
function rollouts(home: string): string[] {
  return [
    ...walk(join(home, "sessions")).files,
    ...walk(join(home, "archived_sessions")).files,
  ].sort((a, b) => comparePyPaths(a, b));
}

/** Scheme-1 records of every rollout, merged across files as the ingest pass merges them. */
function schemeOne(home: string): Map<bigint, FileEntry> {
  const out = new Map<bigint, FileEntry>();
  for (const path of rollouts(home)) {
    for (const entry of extractCodexV1(path)) {
      const seen = out.get(entry.key);
      if (seen === undefined) {
        out.set(entry.key, { ...entry, post: entry.post && { ...entry.post } });
        continue;
      }
      const a = seen.post;
      const b = entry.post;
      if (a !== null && b !== null) {
        a.inp = Math.max(a.inp, b.inp);
        a.outp = Math.max(a.outp, b.outp);
        a.cr = Math.max(a.cr, b.cr);
      }
      if (seen.model === UNATTRIBUTED) seen.model = entry.model;
    }
  }
  return out;
}

const storable = cases.records.filter((r) => [r.ts, r.inp, r.outp, r.cr, r.cc].every(isCount));

describe("scheme 1 equals cc-usage", () => {
  test("the fixture exercises what it should", () => {
    expect(cases.records.length).toBe(48);
    expect(cases.records.length - storable.length).toBe(1); // a counter past 2^53
    expect(cases.malformed).toBe(1);
  });

  test("every record cc-usage keeps, and no other", () => {
    const ours = schemeOne(materialize());
    expect(new Set(ours.keys())).toEqual(new Set(cases.records.map((r) => BigInt(r.key))));
    for (const want of storable) {
      const got = ours.get(BigInt(want.key));
      expect({
        ts: got?.ts,
        model: got?.model,
        inp: got?.post?.inp,
        outp: got?.post?.outp,
        cr: got?.post?.cr,
        cc: got?.post?.cc,
        e5: got?.post?.e5,
        e1: got?.post?.e1,
      }).toEqual({
        ts: want.ts,
        model: want.model,
        inp: want.inp,
        outp: want.outp,
        cr: want.cr,
        cc: want.cc,
        e5: want.e5,
        e1: want.e1,
      });
    }
  });

  test("malformed lines are counted as cc-usage counts them", () => {
    const home = materialize();
    const malformed = rollouts(home).reduce(
      (n, path) => n + readCodexFile(path, 0, null, { scheme: 1 }).stats.malformed,
      0,
    );
    expect(malformed).toBe(cases.malformed);
  });

  test("the account's rate-limit capture is cc-usage's", () => {
    let latest: CodexLimitSnapshot | null = null;
    for (const path of rollouts(materialize())) {
      const { limits } = readCodexFile(path, 0, null, { scheme: 1 });
      if (limits !== null && newerLimits(latest, limits)) latest = limits;
    }
    const want = cases.limits;
    expect(latest?.capturedAt).toBe(want.captured_at);
    expect(latest?.primary).toBeNull();
    expect(latest?.secondary).toEqual({
      usedPercentage: want.rate_limits.codex_secondary.used_percentage,
      resetsAt: want.rate_limits.codex_secondary.resets_at,
      windowMinutes: want.rate_limits.codex_secondary.window_minutes,
    });
  });

  test("chunk size does not change what is read", () => {
    for (const path of rollouts(materialize())) {
      const whole = readCodexFile(path, 0, null);
      for (const chunkBytes of [1, 7, 64, 300]) {
        const small = readCodexFile(path, 0, null, { chunkBytes });
        expect(small.entries).toEqual(whole.entries);
        expect(small.offset).toBe(whole.offset);
        expect(small.stats).toEqual(whole.stats);
      }
    }
  });
});

// Replay of the parent (sid 20), hand-derived from the fixture: in each child, the events
// before the boundary repeat the parent's usage stream or the burst at the head.
const T = (h: number, m: number, s: number, ms = 0) =>
  `2026-07-12T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}Z`;
const INHERITED = [
  // V2 subagent: everything before the task_started that precedes the trigger turn
  key(21, T(18, 7, 0), "1000,100,200", "1000,100,200"),
  key(21, T(18, 7, 0), "1500,150,300", "500,50,100"),
  // the older event name, no task_started: everything before the trigger turn
  key(22, T(18, 10, 0), "1000,100,200", "1000,100,200"),
  key(22, T(18, 10, 0), "1500,150,300", "500,50,100"),
  // a fork replaying the parent's stream from the start
  key(23, T(18, 1, 0), "1000,100,200", "1000,100,200"),
  key(23, T(18, 2, 0), "1500,150,300", "500,50,100"),
  // a fork whose parent is gone: the burst at its head
  key(24, T(18, 14, 0, 100), "5000,4000,100", "5000,4000,100"),
  key(24, T(18, 14, 0, 200), "6000,4500,150", "1000,500,50"),
  // trigger_turn false is no marker: the fork rule matches the parent's first event
  key(25, T(18, 15, 0), "1000,100,200", "1000,100,200"),
];

describe("scheme 2 (the ingest)", () => {
  test("drops exactly the inherited usage and stores every other record as cc-usage does", async () => {
    const engine = openCodexEngine([materialize()]);
    const report = await engine.fullPass();
    const rows = storedRows(engine.store);
    const kept = storable.filter((r) => !INHERITED.includes(BigInt(r.key)));
    expect(kept.length).toBe(storable.length - INHERITED.length);
    expect(rows.size).toBe(kept.length);
    for (const want of kept) {
      const got = rows.get(BigInt(want.key));
      expect({
        ts: got?.ts,
        model: got?.model,
        inp: got?.inp,
        outp: got?.outp,
        cr: got?.cr,
      }).toEqual({ ts: want.ts, model: want.model, inp: want.inp, outp: want.outp, cr: want.cr });
      expect([got?.cc, got?.e5, got?.e1]).toEqual([0, 0, 0]);
    }
    for (const k of INHERITED) expect(rows.has(k)).toBe(false);
    expect(report?.roots[0]?.inherited).toBe(INHERITED.length);
  });

  test("the children's own usage after the boundary counts only its own growth", async () => {
    const engine = openCodexEngine([materialize()]);
    await engine.fullPass();
    const rows = storedRows(engine.store);
    const own = (n: number, ts: string, total: string, last: string) =>
      rows.get(key(n, ts, total, last));
    expect(own(21, T(18, 8, 0), "1600,160,320", "100,10,20")).toMatchObject({
      inp: 90,
      cr: 10,
      outp: 20,
    });
    expect(own(22, T(18, 11, 0), "1520,150,305", "20,0,5")).toMatchObject({
      inp: 20,
      cr: 0,
      outp: 5,
    });
    expect(own(23, T(18, 13, 0), "1600,150,310", "100,0,10")).toMatchObject({ inp: 100, outp: 10 });
    expect(own(24, T(18, 14, 10), "6100,4500,160", "100,0,10")).toMatchObject({
      inp: 100,
      outp: 10,
    });
    expect(own(25, T(18, 16, 0), "1100,100,220", "100,0,20")).toMatchObject({ inp: 100, outp: 20 });
    // markers in a rollout that names no parent change nothing
    expect(own(26, T(18, 17, 1), "70,0,7", "70,0,7")).toMatchObject({ inp: 70, outp: 7 });
    expect(own(26, T(18, 17, 4), "80,0,8", "10,0,1")).toMatchObject({ inp: 10, outp: 1 });
  });

  const parentTiers = (rows: ReturnType<typeof storedRows>) =>
    [
      key(20, T(18, 1, 0), "1000,100,200", "1000,100,200"),
      key(20, T(18, 2, 0), "1500,150,300", "500,50,100"),
      key(20, T(18, 3, 0), "1700,150,330", "200,0,30"),
      key(20, T(18, 4, 0), "1800,150,340", "100,0,10"),
      key(20, T(18, 5, 0), "1900,150,350", "100,0,10"),
      key(20, T(18, 6, 0), "2000,150,360", "100,0,10"),
    ].map((k) => rows.get(k)?.tier);

  test("tiers: events, inheritance, unknown values and the config.toml fallback", async () => {
    const home = materialize();
    writeFileSync(
      join(home, "config.toml"),
      'model = "x"\nservice_tier = "priority"\n[profiles.a]\nservice_tier = "default"\n',
    );
    const engine = openCodexEngine([home]);
    const report = await engine.fullPass();
    // before any settings: config (1); priority (1); no key: kept (1); "turbo": config (1); standard (0)
    expect(parentTiers(storedRows(engine.store))).toEqual([1, 1, 1, 1, 1, 0]);
    const stats = report?.roots[0];
    expect(stats?.fast).toBe((stats?.records ?? 0) - 1);
    expect(stats?.tierFromConfig).toBe((stats?.records ?? 0) - 3);
  });

  test("without config.toml (or its key) the fallback tier is 0", async () => {
    const engine = openCodexEngine([materialize()]);
    await engine.fullPass();
    expect(parentTiers(storedRows(engine.store))).toEqual([0, 0, 1, 1, 0, 0]);
  });

  test("growing each rollout one line per pass stores what one pass stores", async () => {
    const once = openCodexEngine([materialize()]);
    await once.fullPass();
    const content = (rows: ReturnType<typeof storedRows>) =>
      [...rows.values()].map(({ acct: _a, identity: _i, label: _l, ...row }) => row);
    const want = content(storedRows(once.store));

    // Rollouts grow in name order, as a parent's history is written before its forks.
    const home = join(tempDir(), ".codex");
    const live = openCodexEngine([home]);
    for (const [name, b64] of Object.entries(cases.files).sort(([a], [b]) =>
      comparePyPaths(a, b),
    )) {
      const bytes = Buffer.from(b64, "base64");
      const path = join(home, ...name.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
      for (let at = 0; at < bytes.length; ) {
        const nl = bytes.indexOf(0x0a, at);
        const end = nl < 0 ? bytes.length : nl + 1;
        appendFileSync(path, bytes.subarray(at, end));
        at = end;
        await live.fullPass();
      }
    }
    expect(content(storedRows(live.store))).toEqual(want);
  });

  test("the rate-limit snapshot is kept in cache.db", async () => {
    const home = materialize();
    const engine = openCodexEngine([home]);
    await engine.fullPass();
    const snapshot = engine.cursors.codexLimitSnapshots().get(codexRoot(engine, home).identity);
    expect(snapshot?.capturedAt).toBe(cases.limits.captured_at);
    expect(snapshot?.secondary?.usedPercentage).toBe(1);
  });
});
