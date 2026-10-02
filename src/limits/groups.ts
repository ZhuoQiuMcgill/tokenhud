import { createHash } from "node:crypto";
import type { Config } from "../config.ts";
import type { Provider, Root } from "../sources/roots.ts";
import { type Capture, orderedBuckets } from "./capture.ts";

/**
 * Roots on one subscription account (T16). Two config dirs signed in to the same Claude
 * (or ChatGPT) account share one set of limits, so tokenhud treats them as one *limits
 * account*: one card, one fetch, and a pace summed over all of them. Usage history stays
 * per root.
 *
 * - **Auto-detection** reads nothing new: only the limit captures tokenhud already keeps.
 *   Two roots of one provider whose captures were taken within 10 minutes of each other
 *   agree when every window kind both have resets at the same millisecond with the same
 *   utilisation, and they share at least one window. Two consecutive agreeing pairs link
 *   them; two consecutive disagreeing pairs unlink them. A pair is two captures both newer
 *   than the last pair compared, so a capture never counts twice.
 * - **Manual links** come from config: `same_account` links roots, `separate_accounts`
 *   keeps two roots apart. Manual entries win over auto-detection, and a separate pair wins
 *   over a link.
 * - **Groups** are the connected roots: manual links first, then auto ones, each skipped
 *   when it would put a separate pair in one group. A group's id hashes its members'
 *   identities.
 *
 * Detection state (`pairs`) and its result (`groups`, per root identity) live in
 * limits.json beside the captures, so every process that reads or fetches limits agrees.
 */

/** Captures further apart than this (seconds) decide nothing about two roots. */
export const PAIR_WINDOW_S = 10 * 60;
/** Consecutive pairs that agree (or disagree) before two roots are linked (or unlinked). */
export const CONFIRM_PAIRS = 2;

export type GroupSource = "auto" | "manual";

/** Manual links, from config. */
export interface ManualLinks {
  /** Each entry: root identities on one account. */
  readonly same: readonly (readonly string[])[];
  /** Each entry: two root identities that are never one account. */
  readonly separate: readonly (readonly string[])[];
}

export const NO_LINKS: ManualLinks = { same: [], separate: [] };

export function manualLinks(
  config: Pick<Config, "same_account" | "separate_accounts">,
): ManualLinks {
  return { same: config.same_account, separate: config.separate_accounts };
}

/** Auto-detection's state for two roots of one provider (limits.json `pairs`). */
export interface PairState {
  /** Consecutive pairs of captures that agreed; 0 after one that disagreed. */
  agree: number;
  /** Consecutive pairs that disagreed; 0 after one that agreed. */
  disagree: number;
  linked: boolean;
  /** When the link was confirmed (epoch ms); null while not linked. */
  detected_at: number | null;
  /** `captured_at` (epoch s) of the two captures compared last, in key order. */
  last: [number, number];
}

/** A root's group as limits.json records it (`groups`, by root identity). */
export interface GroupRecord {
  /** The group id: a hash of its members' identities. */
  id: string;
  /** When a group with exactly these members was first recorded (epoch ms). */
  detected_at: number;
  source: GroupSource;
}

/** Roots on one account. */
export interface AccountGroup {
  readonly id: string;
  readonly provider: Provider;
  /** Two or more, in discovery order. */
  readonly members: readonly Root[];
  /** "manual" when a config link joins it, else "auto". */
  readonly source: GroupSource;
  /** When it was first recorded in limits.json (`GroupRecord`); null until it is. */
  readonly detected_at: number | null;
}

/** The `pairs` key of two roots: their identities in code point order. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** A group's id: the first 32 hex digits of the SHA-256 of its sorted member identities. */
export function groupId(identities: readonly string[]): string {
  const sorted = [...identities].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex").slice(0, 32);
}

const ms = (seconds: number) => Math.round(seconds * 1000);

/**
 * Whether two captures show one account: true when every window kind both have resets at
 * the same millisecond with the same utilisation; false when one differs; null (can't
 * tell) when they share no window.
 */
export function sameAccount(a: Capture, b: Capture): boolean | null {
  const left = new Map(orderedBuckets(a));
  let shared = 0;
  for (const [kind, bucket] of orderedBuckets(b)) {
    const other = left.get(kind);
    if (other === undefined) continue;
    shared++;
    if (ms(other.resets_at) !== ms(bucket.resets_at)) return false;
    if (other.used_percentage !== bucket.used_percentage) return false;
  }
  return shared > 0 ? true : null;
}

/**
 * Two roots' state after comparing their captures `a` and `b` (in key order). Unchanged
 * when either is missing, they are over 10 minutes apart, either was compared before, or
 * they share no window.
 */
export function decidePair(
  prior: PairState | undefined,
  a: Capture | null,
  b: Capture | null,
  now: number,
): PairState | undefined {
  if (a === null || b === null) return prior;
  if (Math.abs(a.captured_at - b.captured_at) > PAIR_WINDOW_S) return prior;
  if (prior !== undefined && (a.captured_at <= prior.last[0] || b.captured_at <= prior.last[1])) {
    return prior;
  }
  const same = sameAccount(a, b);
  if (same === null) return prior;
  const last: [number, number] = [a.captured_at, b.captured_at];
  const was = prior ?? { agree: 0, disagree: 0, linked: false, detected_at: null, last };
  if (same) {
    const agree = was.agree + 1;
    const linked = was.linked || agree >= CONFIRM_PAIRS;
    return {
      agree,
      disagree: 0,
      linked,
      detected_at: linked ? (was.detected_at ?? now) : null,
      last,
    };
  }
  const disagree = was.disagree + 1;
  const linked = was.linked && disagree < CONFIRM_PAIRS;
  return { agree: 0, disagree, linked, detected_at: linked ? was.detected_at : null, last };
}

/**
 * Every same-provider pair of `roots` decided on their current captures. Pairs of roots
 * not in `roots` (disabled, or not found by this process) are kept as they were.
 */
export function detectPairs(
  roots: readonly Root[],
  captures: ReadonlyMap<string, Capture | null>,
  pairs: Readonly<Record<string, PairState>>,
  now: number,
): Record<string, PairState> {
  const out: Record<string, PairState> = { ...pairs };
  for (const [i, x] of roots.entries()) {
    for (const y of roots.slice(i + 1)) {
      if (x.provider !== y.provider || x.identity === y.identity) continue;
      const [lo, hi] = x.identity < y.identity ? [x, y] : [y, x];
      const key = pairKey(lo.identity, hi.identity);
      const next = decidePair(
        out[key],
        captures.get(lo.identity) ?? null,
        captures.get(hi.identity) ?? null,
        now,
      );
      if (next !== undefined) out[key] = next;
    }
  }
  return out;
}

/**
 * The groups among `roots` (pass the enabled ones), by member identity; a root on its own
 * has no entry. Manual links join first, then auto-detected ones (in key order); a link
 * that would put a `separate` pair in one group is skipped.
 */
export function resolveGroups(
  roots: readonly Root[],
  manual: ManualLinks,
  pairs: Readonly<Record<string, PairState>> = {},
  recorded: Readonly<Record<string, GroupRecord>> = {},
): Map<string, AccountGroup> {
  const at = new Map(roots.map((r, i) => [r.identity, i]));
  const parent = roots.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  const members = roots.map((_, i) => [i]);
  const manualRoot = new Set<number>();
  const separate = new Set(
    manual.separate
      .filter((p) => p.length === 2)
      .map((p) => pairKey(p[0] as string, p[1] as string)),
  );
  const providerOf = (id: string) => (roots[at.get(id) as number] as Root).provider;
  const link = (a: string, b: string, manual: boolean) => {
    const i = at.get(a);
    const j = at.get(b);
    if (i === undefined || j === undefined || providerOf(a) !== providerOf(b)) return;
    const ri = find(i);
    const rj = find(j);
    if (ri === rj) return;
    const left = members[ri] as number[];
    const right = members[rj] as number[];
    const ids = (k: number) => (roots[k] as Root).identity;
    if (left.some((x) => right.some((y) => separate.has(pairKey(ids(x), ids(y)))))) return;
    parent[rj] = ri;
    members[ri] = [...left, ...right];
    if (manual || manualRoot.has(rj)) manualRoot.add(ri);
  };
  for (const entry of manual.same) {
    const present = entry.filter((id) => at.has(id));
    // Each root to the entry's first root of its own provider.
    for (const id of present) {
      const anchor = present.find((x) => providerOf(x) === providerOf(id)) as string;
      if (anchor !== id) link(anchor, id, true);
    }
  }
  for (const key of Object.keys(pairs).sort()) {
    if (!pairs[key]?.linked) continue;
    const [a, b] = key.split("|") as [string, string];
    link(a, b, false);
  }

  const out = new Map<string, AccountGroup>();
  for (const [i, root] of roots.entries()) {
    if (find(i) !== i || (members[i] as number[]).length < 2) continue;
    const list = [...(members[i] as number[])].sort((x, y) => x - y).map((k) => roots[k] as Root);
    const id = groupId(list.map((r) => r.identity));
    const previous = recorded[(list[0] as Root).identity];
    const group: AccountGroup = {
      id,
      provider: root.provider,
      members: list,
      source: manualRoot.has(i) ? "manual" : "auto",
      detected_at: previous?.id === id ? previous.detected_at : null,
    };
    for (const member of list) out.set(member.identity, group);
  }
  return out;
}

/**
 * What limits.json records of `groups` (from `resolveGroups`): each member's group id, how
 * it was formed, and when this exact group was first recorded: kept from `previous`, else
 * `now`.
 */
export function recordGroups(
  groups: ReadonlyMap<string, AccountGroup>,
  previous: Readonly<Record<string, GroupRecord>>,
  now: number,
): Record<string, GroupRecord> {
  const out: Record<string, GroupRecord> = {};
  for (const [identity, group] of groups) {
    const before = previous[identity];
    out[identity] = {
      id: group.id,
      detected_at: before?.id === group.id ? before.detected_at : now,
      source: group.source,
    };
  }
  return out;
}
