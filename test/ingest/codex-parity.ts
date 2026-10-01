// Manual check (T5 acceptance criteria 1-6) on this machine's real Codex rollouts:
//
//   bun test/ingest/codex-parity.ts [ledger path]
//
// 1. Scheme-1 parity: every record `extractCodexV1` makes of the rollouts against the
//    cc-usage ledger row of the same key.
// 2. Replay: rollouts with an inherited prefix, and the tokens and cost (cc-usage v2.6.1
//    standard rates) scheme 2 no longer counts.
// 3. Tiers per account: fast records, from events or from config.toml.
// 4. The re-key on a temp copy: a first-run import of the ledger, then the full pass that
//    re-keys it; then a second re-key, which must change nothing.
// 5. Totals per account, cc-usage's against tokenhud's, and the steps between them.
//
// Read-only on both sides: rollouts are only read, and the ledger only through
// importCcUsage's snapshot copy. Every store lives in the OS temp dir and is deleted at the
// end. Prints counts, tokens and dollars only: no ids, paths, labels or content.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ccUsageDir, ensureConfig } from "../../src/config.ts";
import { IngestEngine, transcriptDirs } from "../../src/ingest/engine.ts";
import { walk } from "../../src/ingest/files.ts";
import { codexSessionIndex } from "../../src/ingest/pass.ts";
import ccUsagePricing from "../../src/pricing/cc-usage-v2.6.1-pricing.json";
import { loadPriceTable } from "../../src/pricing/overrides.ts";
import type { RateCard } from "../../src/pricing/schema.ts";
import { PriceTable } from "../../src/pricing/table.ts";
import type { Counts, FileEntry } from "../../src/sources/claude.ts";
import { readCodexFile, TIER_UNKNOWN } from "../../src/sources/codex.ts";
import { configFallbackTier } from "../../src/sources/codex-config.ts";
import { comparePyPaths } from "../../src/sources/pypath.ts";
import { discoverCodexRoots, type Root } from "../../src/sources/roots.ts";
import { importCcUsage } from "../../src/store/import-cc-usage.ts";
import { openStore, type Store, UNATTRIBUTED } from "../../src/store/store.ts";

const ledger = process.argv[2] ?? join(ccUsageDir(), "ledger.sqlite3");
const dir = mkdtempSync(join(tmpdir(), "tokenhud-codex-parity-"));
const v261 = new PriceTable(ccUsagePricing.models as Record<string, RateCard>);
const { table: ours } = loadPriceTable(join(dir, "no-overrides.json"));

interface Row {
  key: bigint;
  identity: string;
  ts: number;
  model: string;
  inp: number;
  outp: number;
  cr: number;
  cc: number;
  e5: number | null;
  e1: number | null;
  tier: number;
}

const tokens = (r: { inp: number; outp: number; cr: number; cc: number }) =>
  r.inp + r.outp + r.cr + r.cc;

function cost(table: PriceTable, r: Row, tier: number = r.tier): number {
  const c = table.cost({
    model: r.model,
    tier: tier === 1 ? "fast" : "standard",
    atMs: r.ts,
    input: r.inp,
    output: r.outp,
    cacheRead: r.cr,
    cacheCreation: r.cc,
    ephemeral5m: r.e5,
    ephemeral1h: r.e1,
  });
  return typeof c === "number" ? c : 0;
}

function codexRows(store: Store): Map<bigint, Row> {
  const accounts = store.accounts();
  const models = store.models();
  const out = new Map<bigint, Row>();
  for (const r of store.rows([...store.keys()])) {
    const account = accounts.get(r.acct);
    if (account?.provider !== "codex") continue;
    out.set(r.key, { ...r, identity: account.identity, model: models.get(r.model) ?? "?" });
  }
  return out;
}

const sum = <T>(items: Iterable<T>, f: (t: T) => number) => {
  let s = 0;
  for (const t of items) s += f(t);
  return s;
};
const usd = (x: number) => Math.round(x * 100) / 100;
const B = (x: number) => +(x / 1e9).toFixed(3);

try {
  // ── the ledger, through the import's snapshot ─────────────────────────────────
  const reference = openStore(join(dir, "ledger-copy.db"));
  const imported = importCcUsage(reference, ledger);
  if (imported.status !== "imported") throw new Error(imported.warning);
  const theirs = codexRows(reference);
  reference.close();

  // ── the rollouts, as cc-usage would discover and order them ───────────────────
  const config = ensureConfig(join(dir, "config.json"), join(ccUsageDir(), "config.json")).config;
  const roots = discoverCodexRoots(config, { home: homedir(), env: { ...process.env } }).filter(
    (r) => r.enabled,
  );
  const rootOf = new Map<string, Root>();
  for (const root of roots) {
    for (const d of transcriptDirs(root))
      for (const p of walk(d).files) if (!rootOf.has(p)) rootOf.set(p, root);
  }
  const files = [...rootOf.keys()].sort((a, b) => comparePyPaths(a, b));
  const sessions = codexSessionIndex(
    files.map((path) => ({ path, root: rootOf.get(path) as Root })),
  );
  const parents = (sid: string, child: string) => sessions[sid]?.find((p) => p !== child) ?? null;

  const one = new Map<bigint, Row>();
  const two = new Map<bigint, Row>();
  const merge = (into: Map<bigint, Row>, entry: FileEntry, root: Root) => {
    const post = entry.post as Counts;
    const seen = into.get(entry.key);
    if (seen === undefined) {
      into.set(entry.key, {
        key: entry.key,
        identity: root.identity,
        ts: entry.ts as number,
        model: entry.model,
        ...post,
      });
      return;
    }
    seen.inp = Math.max(seen.inp, post.inp);
    seen.outp = Math.max(seen.outp, post.outp);
    seen.cr = Math.max(seen.cr, post.cr);
    if (seen.model === UNATTRIBUTED) seen.model = entry.model;
  };
  const replay = { rollouts: 0, events: 0, keys: new Set<bigint>() };
  const tierStats = new Map<
    string,
    { records: number; fast: number; fromEvents: number; fromConfig: number }
  >();
  const fallback = new Map(roots.map((r) => [r.identity, configFallbackTier(r.path)]));
  const t0 = performance.now();
  for (const path of files) {
    const root = rootOf.get(path) as Root;
    const s1 = readCodexFile(path, 0, null, { scheme: 1 });
    for (const e of s1.entries) merge(one, e, root);
    const s2 = readCodexFile(path, 0, null, { parents });
    for (const e of s2.entries) {
      const tier = e.post?.tier ?? 0;
      merge(
        two,
        {
          ...e,
          post: {
            ...(e.post as Counts),
            tier: tier === TIER_UNKNOWN ? (fallback.get(root.identity) ?? 0) : tier,
          },
        },
        root,
      );
    }
    if (s2.drop.length > 0) {
      replay.rollouts++;
      replay.events += s2.drop.length;
      for (const k of s2.drop) replay.keys.add(k);
    }
    const t = tierStats.get(root.identity) ?? { records: 0, fast: 0, fromEvents: 0, fromConfig: 0 };
    for (const e of s2.entries) {
      t.records++;
      const raw = e.post?.tier ?? 0;
      const tier = raw === TIER_UNKNOWN ? (fallback.get(root.identity) ?? 0) : raw;
      if (tier === 1) {
        t.fast++;
        if (raw === TIER_UNKNOWN) t.fromConfig++;
        else t.fromEvents++;
      }
    }
    tierStats.set(root.identity, t);
  }
  const readMs = performance.now() - t0;

  // ── 1. scheme-1 parity ─────────────────────────────────────────────────────────
  const lastSync = new Map<string, number>();
  for (const r of theirs.values())
    lastSync.set(r.identity, Math.max(lastSync.get(r.identity) ?? 0, r.ts));
  const fields = ["inp", "outp", "cr", "cc", "e5", "e1", "ts", "model", "identity"] as const;
  let matched = 0;
  const mismatched = new Map<string, number>();
  let oursOnly = 0;
  let oursOnlyAfterSync = 0;
  for (const [key, row] of one) {
    const ref = theirs.get(key);
    if (ref === undefined) {
      oursOnly++;
      if (row.ts > (lastSync.get(row.identity) ?? 0) - 5 * 60_000) oursOnlyAfterSync++;
      continue;
    }
    const diff = fields.filter((f) => ref[f] !== row[f]);
    if (diff.length === 0) matched++;
    for (const f of diff) mismatched.set(f, (mismatched.get(f) ?? 0) + 1);
  }
  const scanned = new Set(roots.map((r) => r.identity));
  let ledgerOnly = 0;
  let ledgerOnlyOtherRoot = 0;
  for (const [key, ref] of theirs) {
    if (one.has(key)) continue;
    ledgerOnly++;
    if (!scanned.has(ref.identity)) ledgerOnlyOtherRoot++;
  }

  // ── 2. replay: what scheme 1 counted and scheme 2 does not ────────────────────
  const removed = [...replay.keys].map((k) => one.get(k)).filter((r) => r !== undefined) as Row[];

  // ── 4. the re-key on a temp copy ──────────────────────────────────────────────
  const engine = IngestEngine.open({
    storePath: join(dir, "tokenhud.db"),
    cachePath: join(dir, "cache.db"),
    config,
    discover: { home: homedir(), env: { ...process.env } },
    importLedger: ledger,
  });
  const firstImport = engine.importIfFirstRun();
  const pendingAfterImport = engine.store.meta.codexRekeyPending.length;
  const t1 = performance.now();
  const pass = await engine.fullPass();
  const passMs = performance.now() - t1;
  const after = codexRows(engine.store);
  const pendingAfterPass = engine.store.meta.codexRekeyPending.length;
  engine.close();
  // A second re-key of the same rollouts (as a second import would trigger): a no-op.
  {
    const again = openStore(join(dir, "tokenhud.db"));
    again.importRows(
      [],
      [],
      [],
      { at: new Date().toISOString(), source: "re-run", lineage: null, rows: 0, accounts: 0 },
      [...scanned],
    );
    again.close();
  }
  const second = IngestEngine.open({
    storePath: join(dir, "tokenhud.db"),
    cachePath: join(dir, "cache.db"),
    config,
    discover: { home: homedir(), env: { ...process.env } },
    importLedger: null,
  });
  const pass2 = await second.fullPass();
  const afterSecond = codexRows(second.store);
  second.close();
  let secondDiffers = 0;
  for (const [key, r] of after) {
    const s = afterSecond.get(key);
    if (s === undefined || fields.some((f) => s[f] !== r[f]) || s.tier !== r.tier) secondDiffers++;
  }

  // ── 5. totals per account and the steps between them ──────────────────────────
  const steps = [...scanned].map((identity) => {
    const mine = (m: Map<bigint, Row>) => [...m.values()].filter((r) => r.identity === identity);
    const before = mine(theirs);
    const stored = mine(after);
    const keysAfter = new Set(stored.map((r) => r.key));
    const replayed = before.filter((r) => replay.keys.has(r.key) && !keysAfter.has(r.key));
    const kept = before.filter((r) => !replay.keys.has(r.key) || keysAfter.has(r.key));
    const v261Cost = (rows: Row[]) => sum(rows, (r) => cost(v261, r, 0));
    const L0 = v261Cost(before);
    const L1 = v261Cost(kept);
    const L2 = v261Cost(stored); // + rows written since cc-usage's last sync (and raises)
    const ourStandard = (rows: Row[], autoReview: boolean) =>
      sum(rows, (r) => (!autoReview && r.model === "codex-auto-review" ? 0 : cost(ours, r, 0)));
    const L3 = ourStandard(stored, false); // tokenhud's price table (dated GPT-5.6 cards)
    const L4 = ourStandard(stored, true); // + codex-auto-review as an estimate
    const L5 = sum(stored, (r) => cost(ours, r)); // + tiers
    return {
      account: roots.find((r) => r.identity === identity)?.source,
      cc_usage: { rows: before.length, tokens_B: B(sum(before, tokens)), usd: usd(L0) },
      tokenhud: { rows: stored.length, tokens_B: B(sum(stored, tokens)), usd: usd(L5) },
      steps: {
        replay: { rows: -replayed.length, tokens_B: -B(sum(replayed, tokens)), usd: usd(L1 - L0) },
        new_since_last_sync: {
          rows: stored.length - kept.length,
          tokens_B: B(sum(stored, tokens) - sum(kept, tokens)),
          usd: usd(L2 - L1),
        },
        dated_prices: { usd: usd(L3 - L2) },
        auto_review_estimate: {
          rows: stored.filter((r) => r.model === "codex-auto-review").length,
          usd: usd(L4 - L3),
        },
        tier: { fast_rows: stored.filter((r) => r.tier === 1).length, usd: usd(L5 - L4) },
      },
    };
  });

  console.log(
    JSON.stringify(
      {
        roots: roots.length,
        rollouts: files.length,
        read_ms_both_schemes: Math.round(readMs),
        parity: {
          ledger_codex_rows: theirs.size,
          scheme1_records: one.size,
          matched,
          mismatched: mismatched.size === 0 ? 0 : Object.fromEntries(mismatched),
          ledger_only: ledgerOnly,
          ledger_only_from_roots_not_scanned: ledgerOnlyOtherRoot,
          new_only: oursOnly,
          new_only_near_or_after_last_sync: oursOnlyAfterSync,
        },
        replay: {
          rollouts_with_inherited_prefix: replay.rollouts,
          events: replay.events,
          tokens_B: B(sum(removed, tokens)),
          usd_v261_standard: usd(sum(removed, (r) => cost(v261, r, 0))),
        },
        scheme2_records: two.size,
        tiers: [...tierStats].map(([identity, t]) => ({
          account: roots.find((r) => r.identity === identity)?.source,
          config_fallback: fallback.get(identity),
          ...t,
        })),
        rekey: {
          imported_rows: firstImport?.status === "imported" ? firstImport.inserted : null,
          pending_after_import: pendingAfterImport,
          pass_ms: Math.round(passMs),
          report: pass?.rekey?.accounts.map(({ identity, ...rest }) => ({
            account: roots.find((r) => r.identity === identity)?.source,
            ...rest,
          })),
          pending_after_pass: pendingAfterPass,
          second_run: {
            report: pass2?.rekey?.accounts.map(({ identity, ...rest }) => rest),
            rows_differing: secondDiffers,
          },
        },
        totals: steps,
      },
      null,
      1,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
