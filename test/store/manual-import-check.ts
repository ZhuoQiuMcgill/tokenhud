// Manual check (T3 acceptance criterion 5): import a real cc-usage ledger into a
// throwaway store and print aggregates to compare with `ccusage --ledger-info`.
//
//   bun test/store/manual-import-check.ts [ledger path]
//
// The ledger defaults to $XDG_CONFIG_HOME/cc-usage/ledger.sqlite3 (else ~/.config/...).
// It is only read, through importCcUsage's snapshot copy; the throwaway store lives in
// the OS temp dir and is deleted at the end. Prints counts and timings only.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importCcUsage } from "../../src/store/import-cc-usage.ts";
import { openStore } from "../../src/store/store.ts";

const ledger =
  process.argv[2] ??
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cc-usage", "ledger.sqlite3");

function sideFiles(): string {
  const name = ledger.split(/[\\/]/).pop() ?? "";
  return readdirSync(dirname(ledger))
    .filter((f) => f.startsWith(name))
    .sort()
    .map((f) => {
      const st = statSync(join(dirname(ledger), f), { bigint: true });
      return `${f}:${st.size}@${st.mtimeNs}`;
    })
    .join(" ");
}

const dir = mkdtempSync(join(tmpdir(), "tokenhud-import-check-"));
try {
  const before = sideFiles();
  const store = openStore(join(dir, "tokenhud.db"));
  let t0 = performance.now();
  const summary = importCcUsage(store, ledger);
  if (summary.status === "deferred") throw new Error(summary.warning);
  const importMs = performance.now() - t0;
  const after = sideFiles();

  t0 = performance.now();
  store.rebuildRollups();
  const rebuildMs = performance.now() - t0;
  t0 = performance.now();
  const consistent = store.rollupConsistent();
  const verifyMs = performance.now() - t0;

  const accounts = store.accounts();
  const perAccount = new Map<number, number>();
  let total = 0;
  for (const row of store.rows([...store.keys()])) {
    perAccount.set(row.acct, (perAccount.get(row.acct) ?? 0) + 1);
    total++;
  }
  const byProvider = new Map<string, number>();
  const lines = [...perAccount]
    .map(([id, n]) => ({
      label: accounts.get(id)?.label ?? "?",
      provider: accounts.get(id)?.provider ?? "?",
      n,
    }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  for (const { provider, n } of lines)
    byProvider.set(provider, (byProvider.get(provider) ?? 0) + n);

  console.log(
    `import summary   ${JSON.stringify({ ...summary, lineage: summary.lineage ? "(set)" : null })}`,
  );
  console.log(
    `rows in store    ${total}  (${[...byProvider].map(([p, n]) => `${p} ${n}`).join(" · ")})`,
  );
  for (const { label, provider, n } of lines) console.log(`  ${label} (${provider})  ${n}`);
  console.log(
    `import           ${importMs.toFixed(0)} ms (snapshot, read, upsert with rollup triggers)`,
  );
  console.log(`rollup rebuild   ${rebuildMs.toFixed(0)} ms`);
  console.log(`rollup verify    ${verifyMs.toFixed(0)} ms, consistent: ${consistent}`);
  console.log(
    `ledger files     ${before === after ? "unchanged during the import" : "CHANGED (is cc-usage running?)"}`,
  );
  store.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
