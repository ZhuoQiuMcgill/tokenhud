import type { Database } from "bun:sqlite";
import { KEY_SCHEME } from "./key.ts";

/**
 * Marks a file as a tokenhud store (`PRAGMA application_id`, "TkHD"). A file with tables
 * but without this id is refused instead of migrated, so a misconfigured path, such as
 * cc-usage's own ledger, is never written to.
 */
export const APPLICATION_ID = 0x546b4844;

/** The model Codex events carry until the rollout names one; a real model replaces it. */
export const UNATTRIBUTED = "codex-unattributed";

const TABLES = [
  `CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  identity TEXT NOT NULL,
  label TEXT NOT NULL,
  UNIQUE (provider, identity)
)`,
  "CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)",
  `CREATE TABLE usage (
  key INTEGER PRIMARY KEY,
  acct INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  model INTEGER NOT NULL,
  inp INTEGER NOT NULL,
  outp INTEGER NOT NULL,
  cr INTEGER NOT NULL,
  cc INTEGER NOT NULL,
  e5 INTEGER,
  e1 INTEGER,
  tier INTEGER NOT NULL DEFAULT 0
)`,
  "CREATE INDEX usage_ts ON usage (ts)",
  "CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID",
];

// ── hourly rollup ────────────────────────────────────────────────────────────────
// One row per (UTC epoch hour, account, model, tier) holding the linear sums of its
// usage rows. e5/e1 count NULL as 0; ccx is the cc of rows whose e5 and e1 are both NULL
// (priced by the 1.25x fallback), so cost stays exact from sums. A bucket exists exactly
// while it has rows: the triggers delete one whose n reaches 0, so the table always
// equals a from-scratch GROUP BY. `hour` is SQLite integer division: ts is positive.

const ROLL_HOUR_TABLE = `CREATE TABLE roll_hour (
  hour INTEGER NOT NULL,
  acct INTEGER NOT NULL,
  model INTEGER NOT NULL,
  tier INTEGER NOT NULL,
  inp INTEGER NOT NULL,
  outp INTEGER NOT NULL,
  cr INTEGER NOT NULL,
  cc INTEGER NOT NULL,
  e5 INTEGER NOT NULL,
  e1 INTEGER NOT NULL,
  ccx INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (hour, acct, model, tier)
) WITHOUT ROWID`;

const ROLL_COLUMNS = "hour, acct, model, tier, inp, outp, cr, cc, e5, e1, ccx, n";

/** The rollup recomputed from `usage`, in `ROLL_COLUMNS` order. */
const ROLL_FROM_USAGE = `SELECT ts / 3600000, acct, model, tier, sum(inp), sum(outp), sum(cr), sum(cc),
  sum(coalesce(e5, 0)), sum(coalesce(e1, 0)),
  sum(CASE WHEN e5 IS NULL AND e1 IS NULL THEN cc ELSE 0 END), count(*)
FROM usage GROUP BY 1, 2, 3, 4`;

const ccx = (r: string) => `CASE WHEN ${r}.e5 IS NULL AND ${r}.e1 IS NULL THEN ${r}.cc ELSE 0 END`;
const bucketOf = (r: string) =>
  `hour = ${r}.ts / 3600000 AND acct = ${r}.acct AND model = ${r}.model AND tier = ${r}.tier`;
const sameBucket =
  "NEW.ts / 3600000 = OLD.ts / 3600000 AND NEW.acct = OLD.acct AND NEW.model = OLD.model AND NEW.tier = OLD.tier";

const add = (r: string) => `INSERT INTO roll_hour (${ROLL_COLUMNS})
  VALUES (${r}.ts / 3600000, ${r}.acct, ${r}.model, ${r}.tier, ${r}.inp, ${r}.outp, ${r}.cr, ${r}.cc,
    coalesce(${r}.e5, 0), coalesce(${r}.e1, 0), ${ccx(r)}, 1)
  ON CONFLICT (hour, acct, model, tier) DO UPDATE SET
    inp = inp + excluded.inp, outp = outp + excluded.outp, cr = cr + excluded.cr,
    cc = cc + excluded.cc, e5 = e5 + excluded.e5, e1 = e1 + excluded.e1,
    ccx = ccx + excluded.ccx, n = n + 1;`;

const subtract = (r: string) => `UPDATE roll_hour SET
    inp = inp - ${r}.inp, outp = outp - ${r}.outp, cr = cr - ${r}.cr, cc = cc - ${r}.cc,
    e5 = e5 - coalesce(${r}.e5, 0), e1 = e1 - coalesce(${r}.e1, 0),
    ccx = ccx - (${ccx(r)}), n = n - 1
  WHERE ${bucketOf(r)};
  DELETE FROM roll_hour WHERE ${bucketOf(r)} AND n = 0;`;

/**
 * The triggers that keep `roll_hour` current, by name. An UPDATE applies -OLD then +NEW:
 * in place when the row stays in its bucket (the common streaming merge), as a move when
 * the hour, account, model or tier changes (re-attribution, tier change, a ts change).
 */
export const ROLL_TRIGGERS: ReadonlyMap<string, string> = new Map([
  [
    "usage_roll_insert",
    `CREATE TRIGGER usage_roll_insert AFTER INSERT ON usage BEGIN
  ${add("NEW")}
END`,
  ],
  [
    "usage_roll_delete",
    `CREATE TRIGGER usage_roll_delete AFTER DELETE ON usage BEGIN
  ${subtract("OLD")}
END`,
  ],
  [
    "usage_roll_update",
    `CREATE TRIGGER usage_roll_update AFTER UPDATE ON usage WHEN ${sameBucket} BEGIN
  UPDATE roll_hour SET
    inp = inp + NEW.inp - OLD.inp, outp = outp + NEW.outp - OLD.outp,
    cr = cr + NEW.cr - OLD.cr, cc = cc + NEW.cc - OLD.cc,
    e5 = e5 + coalesce(NEW.e5, 0) - coalesce(OLD.e5, 0),
    e1 = e1 + coalesce(NEW.e1, 0) - coalesce(OLD.e1, 0),
    ccx = ccx + (${ccx("NEW")}) - (${ccx("OLD")})
  WHERE ${bucketOf("NEW")};
END`,
  ],
  [
    "usage_roll_move",
    `CREATE TRIGGER usage_roll_move AFTER UPDATE ON usage WHEN NOT (${sameBucket}) BEGIN
  ${subtract("OLD")}
  ${add("NEW")}
END`,
  ],
]);

/** Recreates `roll_hour` from `usage` and (re)installs its triggers. Caller holds a write transaction. */
export function rebuildRollups(db: Database): void {
  for (const name of ROLL_TRIGGERS.keys()) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec("DROP TABLE IF EXISTS roll_hour");
  db.exec(ROLL_HOUR_TABLE);
  db.exec(`INSERT INTO roll_hour (${ROLL_COLUMNS}) ${ROLL_FROM_USAGE}`);
  for (const sql of ROLL_TRIGGERS.values()) db.exec(sql);
}

/** Whether `roll_hour` and every trigger exist exactly as this version defines them. */
export function rollupSchemaIntact(db: Database): boolean {
  const stored = new Map(
    db
      .query<{ name: string; sql: string | null }, []>(
        "SELECT name, sql FROM sqlite_master WHERE name = 'roll_hour' OR (type = 'trigger' AND tbl_name = 'usage')",
      )
      .all()
      .map((row) => [row.name, row.sql]),
  );
  if (stored.get("roll_hour") !== ROLL_HOUR_TABLE) return false;
  for (const [name, sql] of ROLL_TRIGGERS) if (stored.get(name) !== sql) return false;
  return true;
}

/**
 * A cheap drift probe for every open: the rollup's row count against `usage`'s, read in
 * one statement (one snapshot). It reads an index and the small rollup, not every row.
 */
export function rollupCountsAgree(db: Database): boolean {
  const row = db
    .query<{ rows: bigint; counted: bigint }, []>(
      "SELECT (SELECT count(*) FROM usage) AS rows, (SELECT coalesce(sum(n), 0) FROM roll_hour) AS counted",
    )
    .get();
  return row !== null && row.rows === row.counted;
}

/** The full check: `roll_hour` equals the rollup recomputed from `usage`, row for row. */
export function rollupMatchesUsage(db: Database): boolean {
  const row = db
    .query<{ ok: bigint }, []>(
      `SELECT NOT EXISTS (SELECT ${ROLL_COLUMNS} FROM roll_hour EXCEPT ${ROLL_FROM_USAGE})
          AND NOT EXISTS (${ROLL_FROM_USAGE} EXCEPT SELECT ${ROLL_COLUMNS} FROM roll_hour) AS ok`,
    )
    .get();
  return row?.ok === 1n;
}

// ── schema versions (PRAGMA user_version) ────────────────────────────────────────
// SCHEMA_MIGRATIONS[n] upgrades a store at schema version n to n + 1, inside the write
// transaction that also records the new version. Later tasks append entries (such as a
// `limit_events` table); never edit a shipped one.

type SchemaMigration = (db: Database) => void;

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  // v1: the initial store.
  (db) => {
    for (const sql of TABLES) db.exec(sql);
    rebuildRollups(db);
    db.query(
      `INSERT INTO meta (k, v) VALUES
         ('store_id', ?1), ('key_scheme', ?2), ('created_at', ?3), ('imports', '[]')`,
    ).run(crypto.randomUUID(), String(KEY_SCHEME), new Date().toISOString());
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  },
];

export const SCHEMA_VERSION = SCHEMA_MIGRATIONS.length;
