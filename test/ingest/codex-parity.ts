// Manual check (T5 acceptance criteria 1-6) on this machine's real Codex rollouts:
//
//   bun test/ingest/codex-parity.ts [ledger path]
//
// 1. Scheme-1 parity: every record `extractCodexV1` makes of the rollouts against the
//    cc-usage ledger row of the same key.
// 2. Replay: rollouts with an inherited prefix, and the tokens and cost (cc-usage v2.6.1
//    standard rates) scheme 2 no longer counts.
// 3. Tiers per account: fast records (from the rollouts' settings events only).
// 4. The re-key on a temp copy: a first-run import of the ledger, then the full pass that
//    re-keys it; then a second import of the ledger (whose replay rows must stay out) and
//    the second re-key it triggers, which must change nothing.
// 5. Totals per account, cc-usage's against tokenhud's, and the steps between them.
//
// Read-only on both sides: rollouts are only read, and the ledger only through
// importCcUsage's snapshot copy. Every store lives in the OS temp dir and is deleted at the
// end. Prints counts, tokens and dollars only: no ids, paths, labels or content.
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
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
import { type Counts, type FileEntry, KEY_SEP } from "../../src/sources/claude.ts";
import { codexSessionId, readCodexFile } from "../../src/sources/codex.ts";
import { comparePyPaths } from "../../src/sources/pypath.ts";
import { discoverCodexRoots, type Root } from "../../src/sources/roots.ts";
import { importCcUsage } from "../../src/store/import-cc-usage.ts";
import { ledgerKey } from "../../src/store/key.ts";
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

function priced(r: Row) {
  return {
    model: r.model,
    tier: "standard" as const,
    atMs: r.ts,
    input: r.inp,
    output: r.outp,
    cacheRead: r.cr,
    cacheCreation: r.cc,
    ephemeral5m: r.e5,
    ephemeral1h: r.e1,
  };
}

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
  const tierStats = new Map<string, { records: number; fast: number }>();
  const children = new Map<string, bigint[]>();
  const t0 = performance.now();
  for (const path of files) {
    const root = rootOf.get(path) as Root;
    const s1 = readCodexFile(path, 0, null, { scheme: 1 });
    for (const e of s1.entries) merge(one, e, root);
    const s2 = readCodexFile(path, 0, null, { parents });
    for (const e of s2.entries) merge(two, e, root);
    if (s2.drop.length > 0) {
      replay.rollouts++;
      replay.events += s2.drop.length;
      for (const k of s2.drop) replay.keys.add(k);
      children.set(path, s2.drop);
    }
    const t = tierStats.get(root.identity) ?? { records: 0, fast: 0 };
    for (const e of s2.entries) {
      t.records++;
      if (e.post?.tier === 1) t.fast++;
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
  // Which removed events are anchored in the parent (their cumulative totals occur in the
  // parent's stream), and which are removed on the marker's position alone.
  const tokenLines = (path: string) => {
    const out: { key: bigint; total: string }[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes('"token_count"')) continue;
      let o: {
        timestamp?: unknown;
        payload?: { type?: unknown; info?: Record<string, Record<string, number> | undefined> };
      };
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const info = o.payload?.type === "token_count" ? o.payload.info : undefined;
      if (typeof o.timestamp !== "string" || info === undefined || info === null) continue;
      const triple = (u: Record<string, number> | undefined) =>
        u === undefined || u === null
          ? ""
          : [u.input_tokens, u.cached_input_tokens, u.output_tokens]
              .map((v) => (v !== undefined && Number.isInteger(v) && v >= 0 ? v : 0))
              .join(",");
      const total = triple(info.total_token_usage);
      const material = [
        "x",
        codexSessionId(path),
        o.timestamp,
        total,
        triple(info.last_token_usage),
      ];
      out.push({ key: ledgerKey(material.join(KEY_SEP)), total });
    }
    return out;
  };
  const firstLine = (path: string) => {
    const buf = Buffer.alloc(1 << 20);
    const fd = openSync(path, "r");
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const end = buf.indexOf(10);
    try {
      return JSON.parse(buf.toString("utf8", 0, end < 0 ? n : end)) as {
        payload?: Record<string, unknown>;
      };
    } catch {
      return null;
    }
  };
  const anchored: Row[] = [];
  const markerOnly: Row[] = [];
  let markerOnlyRollouts = 0;
  for (const [path, drop] of children) {
    const meta = firstLine(path)?.payload ?? {};
    const spawn = (
      meta.source as { subagent?: { thread_spawn?: { parent_thread_id?: string } } } | undefined
    )?.subagent?.thread_spawn;
    const parentId = String(meta.forked_from_id ?? spawn?.parent_thread_id ?? "").toLowerCase();
    const parentPath = parents(parentId, path);
    const parentTotals = new Set(
      parentPath === null ? [] : tokenLines(parentPath).map((l) => l.total),
    );
    const totals = new Map(tokenLines(path).map((l) => [l.key, l.total]));
    let any = false;
    for (const key of drop) {
      const row = one.get(key);
      if (row === undefined) continue;
      if (parentTotals.has(totals.get(key) ?? "")) anchored.push(row);
      else {
        markerOnly.push(row);
        any = true;
      }
    }
    if (any) markerOnlyRollouts++;
  }

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
  // A second import of the same ledger: its replay rows are tombstoned and stay out; it
  // marks the accounts again, so the next pass re-keys them once more, which is a no-op.
  const reimport = IngestEngine.open({
    storePath: join(dir, "tokenhud.db"),
    cachePath: join(dir, "cache.db"),
    config,
    discover: { home: homedir(), env: { ...process.env } },
    importLedger: null,
  });
  const tombstones = reimport.store.tombstones();
  const secondImport = importCcUsage(reimport.store, ledger);
  reimport.close();
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
    const isAr = (r: Row) => r.model === "codex-auto-review";
    const others = stored.filter((r) => !isAr(r));
    // tokenhud's price table (dated GPT-5.6 cards), standard tier, auto-review left out
    const L3 = sum(others, (r) => cost(ours, r, 0));
    // codex-auto-review as an estimate, at its own tier
    const autoReview = sum(stored.filter(isAr), (r) => cost(ours, r));
    // the other fast rows: priced at fast, or newly unpriced at the fast tier
    const fastOthers = others.filter((r) => r.tier === 1);
    const isPricedFast = (r: Row) => typeof ours.cost({ ...priced(r), tier: "fast" }) === "number";
    const uplift = sum(fastOthers.filter(isPricedFast), (r) => cost(ours, r) - cost(ours, r, 0));
    const unpricedTier = fastOthers.filter((r) => !isPricedFast(r));
    const lost = -sum(unpricedTier, (r) => cost(ours, r, 0));
    const L5 = sum(stored, (r) => cost(ours, r));
    if (Math.abs(L3 + autoReview + uplift + lost - L5) > 1e-6) throw new Error("steps do not sum");
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
          rows: stored.filter(isAr).length,
          fast_rows: stored.filter((r) => isAr(r) && r.tier === 1).length,
          usd: usd(autoReview),
        },
        tier_fast: { rows: fastOthers.length - unpricedTier.length, usd: usd(uplift) },
        became_unpriced_tier: {
          rows: unpricedTier.length,
          models: [...new Set(unpricedTier.map((r) => r.model))],
          usd: usd(lost),
        },
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
          anchored_in_parent: {
            events: anchored.length,
            tokens_B: B(sum(anchored, tokens)),
            usd_v261_standard: usd(sum(anchored, (r) => cost(v261, r, 0))),
          },
          marker_only: {
            rollouts: markerOnlyRollouts,
            events: markerOnly.length,
            tokens_B: B(sum(markerOnly, tokens)),
            usd_v261_standard: usd(sum(markerOnly, (r) => cost(v261, r, 0))),
          },
        },
        scheme2_records: two.size,
        tiers: [...tierStats].map(([identity, t]) => ({
          account: roots.find((r) => r.identity === identity)?.source,
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
          tombstones,
          second_import: {
            tombstoned: secondImport.status === "imported" ? secondImport.tombstoned : null,
            inserted: secondImport.status === "imported" ? secondImport.inserted : null,
          },
          second_run: {
            report: pass2?.rekey?.accounts.map(({ identity, ...rest }) => rest),
            rows_differing: secondDiffers,
            rows: afterSecond.size,
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
