// Plays the frozen cc-usage app writing its ledger, for import-cc-usage.test.ts. Commit c
// (from 1) inserts PER rows with keys FIRST + (c-1)*PER ... and, in the same transaction,
// sets the counter row (key FIRST - 1) to outp = c. A consistent snapshot therefore holds
// exactly the rows of commits 1..counter; a torn one does not.
//
// Modes: "bursty" writes a few commits, then sleeps a few ms, checkpointing every few
// pages and sometimes truncating the WAL. "aggressive" checkpoints on every commit
// (wal_autocheckpoint = 1), the worst case for a copy, and alternates 300 ms of writing
// without a pause with 300 ms of short bursts separated by 2-6 ms pauses: the first
// phase should defer every import, the second lets some through under the same pressure.
//
// Usage: bun ledger-writer.ts <ledger> <first key> <per commit> <ms> <bursty|aggressive>
// Prints "ready" once the counter row exists, then the number of commits at exit.
import { Database } from "bun:sqlite";

const [path, first, per, ms, mode] = process.argv.slice(2);
if (path === undefined || first === undefined || per === undefined) {
  throw new Error("usage: <ledger> <first key> <per commit> <ms> <bursty|aggressive>");
}
const aggressive = mode === "aggressive";
const FIRST = BigInt(first);
const PER = BigInt(per);
const db = new Database(path, { safeIntegers: true });
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`PRAGMA wal_autocheckpoint = ${aggressive ? 1 : 4}`);
const ids = db
  .query<{ acct: bigint; model: bigint }, []>(
    `SELECT (SELECT id FROM accounts WHERE label = 'personal') AS acct,
            (SELECT id FROM models WHERE name = 'claude-opus-4-8') AS model`,
  )
  .get();
const acct = ids?.acct ?? 0n;
const model = ids?.model ?? 0n;
const insert = db.query(
  "INSERT INTO usage (key, acct, ts, model, inp, outp, cr, cc, e5, e1) VALUES (?1, ?2, 1780000000000, ?3, 1, ?4, 0, 0, NULL, NULL)",
);
const counter = db.query("UPDATE usage SET outp = ?1 WHERE key = ?2");
insert.run(FIRST - 1n, acct, model, 0n);
const commit = db.transaction((c: bigint) => {
  for (let i = 0n; i < PER; i++) insert.run(FIRST + (c - 1n) * PER + i, acct, model, c);
  counter.run(c, FIRST - 1n);
});
console.log("ready");
const start = Date.now();
const end = start + Number(ms);
let commits = 0n;
while (Date.now() < end) {
  commit(++commits);
  if (aggressive) {
    const nonstop = Math.floor((Date.now() - start) / 300) % 2 === 0;
    if (!nonstop && Math.random() < 0.3) Bun.sleepSync(2 + Math.floor(Math.random() * 5));
    continue;
  }
  if (commits % 3n === 0n) Bun.sleepSync(2 + Math.floor(Math.random() * 10));
  if (commits % 21n === 0n) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
db.close();
console.log(String(commits));
