// Synthetic usage for the query tests and benchmark: deterministic, made-up, and shaped like
// real use. Work comes in sessions: one account, one main model (sometimes a helper model
// alongside), rows every few seconds to a minute. The mix covers what pricing from sums
// must get right: every bundled dated period, both tiers (with tiers a model has no price
// for), unpriced models, raw model ids that normalise, NULL and half-NULL cache buckets,
// and long-context rows (above OpenAI's 272k threshold, and Claude rows that size, which
// have no long-context tier).
//
// Nothing here reads a real file; identities and labels are obviously fake.

import type { UsageRow } from "../../src/store/store.ts";

export const ACCOUNTS = [
  { provider: "claude", identity: "fake-claude-identity-1", label: "claude-one" },
  { provider: "claude", identity: "fake-claude-identity-2", label: "claude-two" },
  { provider: "claude", identity: "fake-claude-identity-3", label: "claude-three" },
  { provider: "codex", identity: "fake-codex-identity-1", label: "codex-one" },
  { provider: "codex", identity: "fake-codex-identity-2", label: "codex-two" },
] as const;

const CLAUDE_MODELS = [
  "claude-opus-5-5",
  "claude-opus-4-8",
  "claude-opus-4-8-20260101",
  "Claude-Opus-4-8[1m]",
  "claude-opus-4-7", // no fast card: fast rows are unpriced-tier
  "claude-sonnet-4-6",
  "claude-mystery-9", // not in the table
];
const CLAUDE_HELPER = "claude-haiku-4-5";
const CODEX_MODELS = [
  "gpt-5.6-sol", // dated: Jul 30, Aug 5 and Aug 21 2026
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6", // an alias of gpt-5.6-sol
  "gpt-5.5", // fast has no long-context price
  "gpt-6-astra",
  "codex-unattributed",
];
const CODEX_HELPER = "gpt-6-luna";

/** A small, fast, seedable PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticOptions {
  readonly rows: number;
  /** Epoch ms span the sessions start in. */
  readonly from: number;
  readonly to: number;
  readonly seed: number;
  /** Fraction of Codex rows above the 272k long-context threshold. */
  readonly longContext?: number;
}

/** `options.rows` usage rows with unique keys, in session order (not sorted by time). */
export function syntheticRows(options: SyntheticOptions): UsageRow[] {
  const rnd = prng(options.seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const longShare = options.longContext ?? 0.01;
  const rows: UsageRow[] = [];
  let key = 0x1234_5678_9abcn;
  while (rows.length < options.rows) {
    const account = pick(ACCOUNTS);
    const codex = account.provider === "codex";
    const main = pick(codex ? CODEX_MODELS : CLAUDE_MODELS);
    const helper = rnd() < 0.3 ? (codex ? CODEX_HELPER : CLAUDE_HELPER) : null;
    const tier = rnd() < 0.15 ? 1 : 0;
    let ts = options.from + Math.floor(rnd() * (options.to - options.from));
    const length = int(5, 400);
    for (let i = 0; i < length && rows.length < options.rows; i++) {
      ts += int(1_000, 60_000);
      const model = helper !== null && rnd() < 0.25 ? helper : main;
      const long = rnd() < (codex ? longShare : longShare / 4);
      const cc = int(0, 20_000);
      const shape = rnd();
      // Most rows split creation into the 5m/1h buckets; some have none (NULL, priced at the
      // 1.25x fallback) and a few have one bucket only.
      const [e5, e1] =
        shape < 0.7
          ? (() => {
              const five = int(0, cc);
              return [five, cc - five];
            })()
          : shape < 0.85
            ? [null, null]
            : shape < 0.93
              ? [cc, null]
              : [null, cc];
      key += BigInt(int(1, 1_000_003)) * 7919n;
      rows.push({
        key: BigInt.asIntN(64, key * 0x9e3779b97f4a7c15n),
        ...account,
        ts,
        model,
        inp: long ? int(1_000, 120_000) : int(0, 2_000),
        outp: int(0, 8_000),
        cr: long ? int(280_000, 900_000) : int(0, 200_000),
        cc,
        e5,
        e1,
        tier,
      });
    }
  }
  return rows;
}
