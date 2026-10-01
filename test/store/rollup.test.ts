// Property test: random sequences of writes keep roll_hour equal to a from-scratch GROUP BY,
// and rebuildRollups() reproduces the same table. A plain reference model in JavaScript
// applies the merge rules independently, so the stored rows are checked too.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openStore, UNATTRIBUTED, type UsageRow } from "../../src/store/store.ts";
import { cleanup, HOUR, T0, tempDir, track } from "./helpers.ts";

afterEach(cleanup);

const SEQUENCES = 2000;
const SEED = 0x7015e9d;

// mulberry32: small, fast, reproducible.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNTS = [
  { provider: "claude", identity: "id-a", label: "a" },
  { provider: "claude", identity: "id-b", label: "b" },
  { provider: "codex", identity: "id-c", label: "c" },
] as const;
const MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "gpt-5.5"] as const;

interface Ref {
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

/** cc-usage's merge rule, written out independently of the SQL. */
function mergeRef(stored: Ref | undefined, incoming: UsageRow): Ref {
  if (stored === undefined) {
    const { identity, ts, model, inp, outp, cr, cc, e5, e1, tier } = incoming;
    return { identity, ts, model, inp, outp, cr, cc, e5, e1, tier };
  }
  const sub = (a: number | null, b: number | null) =>
    a === null ? b : b === null ? a : Math.max(a, b);
  return {
    identity: stored.identity,
    ts: stored.ts,
    model:
      stored.model === UNATTRIBUTED && incoming.model !== UNATTRIBUTED
        ? incoming.model
        : stored.model,
    inp: Math.max(stored.inp, incoming.inp),
    outp: Math.max(stored.outp, incoming.outp),
    cr: Math.max(stored.cr, incoming.cr),
    cc: Math.max(stored.cc, incoming.cc),
    e5: sub(stored.e5, incoming.e5),
    e1: sub(stored.e1, incoming.e1),
    tier: Math.max(stored.tier, incoming.tier),
  };
}

type Bucket = [hour: number, acct: number, model: number, tier: number, ...sums: number[]];

function rollupOf(
  ref: Map<bigint, Ref>,
  acctId: Map<string, number>,
  modelId: Map<string, number>,
): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const r of ref.values()) {
    const hour = Math.floor(r.ts / HOUR);
    const acct = acctId.get(r.identity) ?? -1;
    const model = modelId.get(r.model) ?? -1;
    const id = `${hour},${acct},${model},${r.tier}`;
    const b: Bucket = buckets.get(id) ?? [hour, acct, model, r.tier, 0, 0, 0, 0, 0, 0, 0, 0];
    const add = [
      r.inp,
      r.outp,
      r.cr,
      r.cc,
      r.e5 ?? 0,
      r.e1 ?? 0,
      r.e5 === null && r.e1 === null ? r.cc : 0,
      1,
    ];
    add.forEach((v, i) => {
      b[4 + i] = (b[4 + i] ?? 0) + v;
    });
    buckets.set(id, b);
  }
  return [...buckets.values()].sort(compareBuckets);
}

function compareBuckets(a: Bucket, b: Bucket): number {
  for (let i = 0; i < 4; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const ROLL = "SELECT hour, acct, model, tier, inp, outp, cr, cc, e5, e1, ccx, n FROM roll_hour";
const GROUP_BY = `SELECT ts / 3600000 AS hour, acct, model, tier, sum(inp), sum(outp), sum(cr), sum(cc),
  sum(coalesce(e5, 0)), sum(coalesce(e1, 0)), sum(CASE WHEN e5 IS NULL AND e1 IS NULL THEN cc ELSE 0 END),
  count(*) FROM usage GROUP BY 1, 2, 3, 4`;

function buckets(db: Database, sql: string): Bucket[] {
  return (db.query(sql).values() as bigint[][])
    .map((r) => r.map(Number) as Bucket)
    .sort(compareBuckets);
}

test(`roll_hour equals a from-scratch GROUP BY after ${SEQUENCES} random write sequences`, () => {
  const random = prng(SEED);
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T;
  const chance = (p: number) => random() < p;

  const path = join(tempDir(), "tokenhud.db");
  const store = track(openStore(path));
  // A second connection plays an external writer (a migration, a repair) for the
  // operations upsert never performs: deletes and moving a row's ts or account.
  const raw = new Database(path, { safeIntegers: true });
  let nextKey = 1n;
  const tally = {
    sequences: 0,
    ops: 0,
    inserts: 0,
    merges: 0,
    reattributions: 0,
    tiers: 0,
    deletes: 0,
    moves: 0,
  };

  try {
    for (let s = 0; s < SEQUENCES; s++) {
      const ref = new Map<bigint, Ref>();
      const existing = () => [...ref.keys()];
      const counts = () => [int(1000), int(5000), int(20000), int(3000)] as const;
      const subBuckets = (): [number | null, number | null] =>
        chance(0.3) ? [null, null] : chance(0.1) ? [int(500), null] : [int(500), int(500)];
      const fresh = (): UsageRow => {
        const [inp, outp, cr, cc] = counts();
        const [e5, e1] = subBuckets();
        const account = pick(ACCOUNTS);
        return {
          // An odd multiplier mod 2^64 is a bijection: unique keys spread over the signed range.
          key: BigInt.asIntN(64, nextKey++ * 0x9e3779b97f4a7c15n),
          ...account,
          ts: T0 + int(6 * HOUR),
          model: account.provider === "codex" && chance(0.5) ? UNATTRIBUTED : pick(MODELS),
          inp,
          outp,
          cr,
          cc,
          e5,
          e1,
          tier: chance(0.15) ? 1 : 0,
        };
      };
      // A re-sent copy of a stored row: some counts higher, some lower, maybe a later ts
      // (ignored: the first-seen ts is kept). Same account and model, so the result does
      // not depend on order within a batch.
      const resend = (key: bigint, over: Partial<UsageRow> = {}): UsageRow => {
        const r = ref.get(key) as Ref;
        const account = ACCOUNTS.find((a) => a.identity === r.identity) ?? ACCOUNTS[0];
        const jiggle = (v: number) => Math.max(0, v + int(200) - 100);
        const [e5, e1] = chance(0.5) ? [r.e5, r.e1] : subBuckets();
        return {
          key,
          ...account,
          ts: r.ts + (chance(0.2) ? int(3 * HOUR) : 0),
          model: r.model,
          inp: jiggle(r.inp),
          outp: jiggle(r.outp),
          cr: jiggle(r.cr),
          cc: jiggle(r.cc),
          e5,
          e1,
          tier: r.tier,
          ...over,
        };
      };
      const write = (batch: UsageRow[]) => {
        store.upsert(batch);
        for (const r of batch) ref.set(r.key, mergeRef(ref.get(r.key), r));
      };

      const ops = 1 + int(15);
      for (let o = 0; o < ops; o++) {
        const keys = existing();
        const op = keys.length === 0 ? 0 : int(7);
        if (op === 0) {
          write(Array.from({ length: 1 + int(5) }, fresh));
          tally.inserts++;
        } else if (op === 1) {
          // merge-update, sometimes the same key twice in one batch
          const key = pick(keys);
          write(chance(0.3) ? [resend(key), resend(key)] : [resend(key)]);
          tally.merges++;
        } else if (op === 2) {
          // model re-attribution: codex-unattributed resolved (or a no-op for a real model)
          const unattributed = keys.filter((k) => ref.get(k)?.model === UNATTRIBUTED);
          const key = unattributed.length > 0 ? pick(unattributed) : pick(keys);
          write([resend(key, { model: pick(MODELS) })]);
          tally.reattributions++;
        } else if (op === 3) {
          write([resend(pick(keys), { tier: chance(0.7) ? 1 : 0 })]);
          tally.tiers++;
        } else if (op === 4) {
          // a mixed batch: new rows, merges and a re-attribution together
          const key = pick(keys);
          write([fresh(), resend(key), resend(pick(keys), { tier: 1 }), fresh()]);
          tally.merges++;
        } else if (op === 5) {
          const key = pick(keys);
          raw.query("DELETE FROM usage WHERE key = ?1").run(key);
          ref.delete(key);
          tally.deletes++;
        } else {
          // move a row's ts across hours, and sometimes its account
          const key = pick(keys);
          const r = ref.get(key) as Ref;
          const ts = T0 + int(6 * HOUR);
          const account = chance(0.3) ? pick(ACCOUNTS) : undefined;
          raw.query("UPDATE usage SET ts = ?1 WHERE key = ?2").run(ts, key);
          if (account !== undefined) {
            raw
              .query(
                "UPDATE usage SET acct = (SELECT id FROM accounts WHERE identity = ?1) WHERE key = ?2",
              )
              .run(account.identity, key);
          }
          ref.set(key, { ...r, ts, identity: account?.identity ?? r.identity });
          tally.moves++;
        }
        tally.ops++;
      }

      // The stored rows follow the reference merge.
      const acctId = new Map([...store.accounts().values()].map((a) => [a.identity, a.id]));
      const modelId = new Map([...store.models()].map(([id, name]) => [name, id]));
      const modelName = store.models();
      const stored = new Map(
        store.rows(existing()).map((r) => [
          r.key,
          {
            identity: store.accounts().get(r.acct)?.identity,
            ts: r.ts,
            model: modelName.get(r.model),
            inp: r.inp,
            outp: r.outp,
            cr: r.cr,
            cc: r.cc,
            e5: r.e5,
            e1: r.e1,
            tier: r.tier,
          },
        ]),
      );
      if (stored.size !== ref.size || [...store.keys()].length !== ref.size) {
        throw new Error(
          `sequence ${s} (seed ${SEED}): ${stored.size} rows stored, ${ref.size} expected`,
        );
      }
      for (const [key, r] of ref) expect(stored.get(key)).toEqual(r);

      // roll_hour = GROUP BY = the reference rollup, and a rebuild reproduces it.
      const rolled = buckets(raw, ROLL);
      expect(rolled).toEqual(buckets(raw, GROUP_BY));
      expect(rolled).toEqual(rollupOf(ref, acctId, modelId));
      expect(store.rollupConsistent()).toBe(true);
      store.rebuildRollups();
      expect(buckets(raw, ROLL)).toEqual(rolled);

      // Deleting everything empties the rollup: no zero buckets are left behind.
      raw.exec("DELETE FROM usage");
      expect(buckets(raw, ROLL)).toEqual([]);
      tally.sequences++;
    }
  } finally {
    raw.close();
  }
  console.log("rollup property test:", JSON.stringify(tally));
  expect(tally.sequences).toBe(SEQUENCES);
  for (const n of Object.values(tally)) expect(n).toBeGreaterThan(100);
}, 300_000);
