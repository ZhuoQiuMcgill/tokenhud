// Manual check (T4 acceptance criterion 3): parse every Claude root on this machine into
// a throwaway store and compare each record with the cc-usage ledger row of the same key.
//
//   bun test/ingest/manual-parity.ts [ledger path]
//
// Read-only on both sides: transcripts are only read, and the ledger is read through
// importCcUsage's snapshot copy into a second throwaway store. Both stores live in the OS
// temp dir and are deleted at the end. Prints counts only: no ids, paths or content.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ccUsageDir, ensureConfig } from "../../src/config.ts";
import { IngestEngine } from "../../src/ingest/engine.ts";
import { importCcUsage } from "../../src/store/import-cc-usage.ts";
import { openStore, type Store, type StoredRow } from "../../src/store/store.ts";

const ledger = process.argv[2] ?? join(ccUsageDir(), "ledger.sqlite3");
const dir = mkdtempSync(join(tmpdir(), "tokenhud-parity-"));

interface Named extends StoredRow {
  identity: string;
  provider: string;
  modelName: string;
}

function named(store: Store): Map<bigint, Named> {
  const accounts = store.accounts();
  const models = store.models();
  return new Map(
    store.rows([...store.keys()]).map((r) => [
      r.key,
      {
        ...r,
        identity: accounts.get(r.acct)?.identity ?? "?",
        provider: accounts.get(r.acct)?.provider ?? "?",
        modelName: models.get(r.model) ?? "?",
      },
    ]),
  );
}

try {
  // The ledger first, so lines written while transcripts are read count as tokenhud-only.
  const reference = openStore(join(dir, "ledger-copy.db"));
  const imported = importCcUsage(reference, ledger);
  if (imported.status !== "imported") throw new Error(imported.warning);
  const theirs = named(reference);
  const ledgerLabels = new Map(
    [...reference.accounts().values()].map((a) => [a.identity, a.label]),
  );
  reference.close();

  const t0 = performance.now();
  const engine = IngestEngine.open({
    storePath: join(dir, "tokenhud.db"),
    cachePath: join(dir, "cache.db"),
    // A first run: tokenhud's config is created (in the temp dir) from cc-usage's.
    config: ensureConfig(join(dir, "config.json"), join(ccUsageDir(), "config.json")).config,
    discover: { home: homedir(), env: { ...process.env } },
    importLedger: null,
  });
  const report = await engine.fullPass();
  const ingestMs = performance.now() - t0;
  const ours = named(engine.store);
  const ourAccounts = [...engine.store.accounts().values()].filter((a) =>
    ledgerLabels.has(a.identity),
  );
  const labelsMatch = ourAccounts.filter((a) => ledgerLabels.get(a.identity) === a.label).length;
  const claudeRoots = engine.roots.filter((r) => r.provider === "claude").map((r) => r.identity);
  engine.close();
  if (report === null) throw new Error("the pass failed");

  // Per-account last ledger timestamp: a record past it may simply be newer than cc-usage's last sync.
  const lastSync = new Map<string, number>();
  for (const row of theirs.values()) {
    if (row.provider !== "claude") continue;
    lastSync.set(row.identity, Math.max(lastSync.get(row.identity) ?? 0, row.ts));
  }

  const fields = ["inp", "outp", "cr", "cc", "e5", "e1", "ts"] as const;
  let matched = 0;
  const mismatched = new Map<string, number>();
  let ledgerHigher = 0;
  let oursHigher = 0;
  let tsOnly = 0;
  let accountDiffers = 0;
  let modelDiffers = 0;
  let oursOnly = 0;
  let oursOnlyAfterSync = 0;
  for (const [key, row] of ours) {
    const ref = theirs.get(key);
    if (ref === undefined) {
      oursOnly++;
      if (row.ts > (lastSync.get(row.identity) ?? 0) - 5 * 60_000) oursOnlyAfterSync++;
      continue;
    }
    if (ref.identity !== row.identity) accountDiffers++;
    if (ref.modelName !== row.modelName) modelDiffers++;
    const diff = fields.filter((f) => ref[f] !== row[f]);
    if (diff.length === 0) {
      matched++;
      continue;
    }
    for (const f of diff) mismatched.set(f, (mismatched.get(f) ?? 0) + 1);
    if (diff.length === 1 && diff[0] === "ts") tsOnly++;
    const counts = fields.filter((f) => f !== "ts");
    if (counts.some((f) => (ref[f] ?? -1) > (row[f] ?? -1))) ledgerHigher++;
    if (counts.some((f) => (row[f] ?? -1) > (ref[f] ?? -1))) oursHigher++;
  }
  let ledgerOnly = 0;
  let ledgerOnlyOtherRoot = 0;
  for (const [key, ref] of theirs) {
    if (ref.provider !== "claude" || ours.has(key)) continue;
    ledgerOnly++;
    if (!claudeRoots.includes(ref.identity)) ledgerOnlyOtherRoot++;
  }

  const t = report.roots.reduce(
    (a, r) => ({
      files: a.files + r.files,
      bytes: a.bytes + r.bytes,
      records: a.records + r.records,
    }),
    { files: 0, bytes: 0, records: 0 },
  );
  console.log(
    JSON.stringify(
      {
        roots: report.roots.length,
        files: t.files,
        MB: +(t.bytes / 1e6).toFixed(1),
        records: t.records,
        ingest_ms: Math.round(ingestMs),
        ledger_claude_rows: [...theirs.values()].filter((r) => r.provider === "claude").length,
        matched,
        mismatched: [...mismatched.values()].length === 0 ? 0 : Object.fromEntries(mismatched),
        mismatch_ts_only: tsOnly,
        mismatch_ledger_higher: ledgerHigher,
        mismatch_ours_higher: oursHigher,
        account_differs: accountDiffers,
        model_differs: modelDiffers,
        ledger_only: ledgerOnly,
        ledger_only_from_roots_not_scanned: ledgerOnlyOtherRoot,
        tokenhud_only: oursOnly,
        tokenhud_only_near_or_after_last_sync: oursOnlyAfterSync,
        account_labels_equal_to_ledger: `${labelsMatch}/${ourAccounts.length}`,
      },
      null,
      1,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
