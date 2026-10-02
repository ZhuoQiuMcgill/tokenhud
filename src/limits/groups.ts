import { createHash } from "node:crypto";
import type { Config } from "../config.ts";
import type { Provider, Root } from "../sources/roots.ts";
import { type Capture, orderedBuckets } from "./capture.ts";
import { SAME_INSTANCE_MS } from "./events.ts";

/**
 * Roots on one subscription account (T16). Two config dirs signed in to the same Claude
 * (or ChatGPT) account share one set of limits, so tokenhud treats them as one *limits
 * account*: one card, one fetch, and a pace summed over all of them. Usage history stays
 * per root.
 *
 * **Auto-detection** reads nothing new: only the limit captures tokenhud already keeps.
 * - **A pair** is the current capture of each of two roots of one provider, taken at most
 *   10 minutes apart, both newer than the two compared last (no capture counts twice).
 *   Windows they both have are compared; one whose instance ended between the two
 *   captures is left out.
 * - **Resets** agree within 2 s: Claude reports a window's reset with up to ~0.7 s of
 *   jitter per request, while a new instance of a window is hours away.
 * - **Utilisation** is compared only on captures at most 60 s apart: an account in use
 *   moves in between. Further apart, the resets can only veto.
 * - **Agree:** the resets agree and, close enough to judge, the utilisations are equal.
 *   **Disagree:** a reset differs, or close captures differ in utilisation.
 * - **Link:** two agreeing pairs in a row, with a shared window's utilisation changed
 *   between them (equally on both, since both agree) and one window above 0 %. Idle
 *   accounts prove nothing: two different idle accounts can report the same whole-hour
 *   resets at 0 %.
 * - **Unlink:** a disagreeing pair suspends a link (the roots show apart at once); a second
 *   one in a row unlinks, an agreeing one restores it. The limits service keeps pairs
 *   fresh: it fetches a candidate partner back to back, and re-checks every other member
 *   of a group every 30 minutes (src/limits/service.ts).
 *
 * **Manual links** come from config: `same_account` links roots, `separate_accounts` keeps
 * two roots apart. Manual entries win over auto-detection, and a separate pair wins over a
 * link. A manual link whose roots disagree is kept, and reported.
 *
 * **Groups** are the connected roots: manual links first, then auto ones, each skipped
 * when it would put a separate pair in one group. A group's id hashes its members'
 * identities.
 *
 * Detection state (`pairs`) and its result (`groups`, per root identity) live in
 * limits.json beside the captures, so every process that reads or fetches limits agrees.
 */

/** Captures further apart than this (seconds) decide nothing about two roots. */
export const PAIR_WINDOW_S = 10 * 60;
/** Captures at most this far apart (seconds) are close enough to compare utilisation. */
export const CLOSE_S = 60;
/** Two roots' reset times of one window agree within this (ms): Claude's jitter is < 1 s. */
export const RESET_TOLERANCE_MS = 2000;
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

/**
 * A window of an agreeing pair: its utilisation (%) and reset (epoch ms), as the first
 * root saw it.
 */
export interface PairWindow {
  u: number;
  r: number;
}

/** Auto-detection's state for two roots of one provider (limits.json `pairs`). */
export interface PairState {
  /** Consecutive pairs of captures that agreed; 0 after one that disagreed. */
  agree: number;
  /** Consecutive pairs that disagreed; 0 after one that agreed. */
  disagree: number;
  /** Linked; suspended while `disagree` is 1. */
  linked: boolean;
  /** When the link was confirmed (epoch ms); null while not linked. */
  detected_at: number | null;
  /** `captured_at` (epoch s) of the two captures compared last, in key order. */
  last: [number, number];
  /**
   * The windows of the last agreeing pair, by kind, to see whether the next one moved;
   * null after a disagreeing pair (and in a file from before co-movement, which therefore
   * starts unconfirmed).
   */
  windows: Record<string, PairWindow> | null;
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
  /**
   * The last pair compared between two of its members disagreed: kept apart for an auto
   * link (which is then not a group), reported for a manual one.
   */
  readonly differs: boolean;
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

/** What two captures say about being one account. */
export interface Comparison {
  /** Windows both have whose instance both captures saw; 0: they can't be compared. */
  shared: number;
  /** Every shared window resets within 2 s on both. */
  resetsAgree: boolean;
  /** Taken at most 60 s apart: utilisation can be compared. */
  close: boolean;
  /** Every shared window has the same utilisation on both. */
  sameUse: boolean;
  /** The shared windows as `a` saw them. */
  windows: Record<string, PairWindow>;
}

/**
 * Compares the windows two captures both have. A window whose instance had ended by the
 * later capture (its reset in the earlier one is not after the later one) is left out: the
 * later capture saw the next instance.
 */
export function compareCaptures(a: Capture, b: Capture): Comparison {
  const later = Math.max(a.captured_at, b.captured_at);
  const left = new Map(orderedBuckets(a));
  const windows: Record<string, PairWindow> = {};
  let shared = 0;
  let resetsAgree = true;
  let sameUse = true;
  for (const [kind, bucket] of orderedBuckets(b)) {
    const other = left.get(kind);
    if (other === undefined) continue;
    if (Math.min(other.resets_at, bucket.resets_at) <= later) continue;
    shared++;
    if (Math.abs(ms(other.resets_at) - ms(bucket.resets_at)) > RESET_TOLERANCE_MS) {
      resetsAgree = false;
    }
    if (other.used_percentage !== bucket.used_percentage) sameUse = false;
    windows[kind] = { u: other.used_percentage, r: ms(other.resets_at) };
  }
  const close = Math.abs(a.captured_at - b.captured_at) <= CLOSE_S;
  return { shared, resetsAgree, close, sameUse, windows };
}

/**
 * Whether the account moved between two agreeing pairs: a window of the same instance
 * (resets under 15 minutes apart) changed utilisation.
 */
function moved(before: Readonly<Record<string, PairWindow>>, now: Record<string, PairWindow>) {
  return Object.entries(now).some(([kind, w]) => {
    const was = before[kind];
    return was !== undefined && Math.abs(was.r - w.r) < SAME_INSTANCE_MS && was.u !== w.u;
  });
}

/**
 * Two roots' state after comparing their captures `a` and `b` (in key order). Unchanged
 * when either is missing, they are over 10 minutes apart, either was compared before, they
 * share no window, or their resets agree but they are too far apart to judge utilisation.
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
  const c = compareCaptures(a, b);
  if (c.shared === 0 || (c.resetsAgree && !c.close)) return prior;
  const last: [number, number] = [a.captured_at, b.captured_at];
  const was = prior ?? {
    agree: 0,
    disagree: 0,
    linked: false,
    detected_at: null,
    last,
    windows: null,
  };
  if (c.resetsAgree && c.sameUse) {
    const used = Object.values(c.windows).some((w) => w.u > 0);
    const confirmed =
      was.agree >= CONFIRM_PAIRS - 1 && was.windows !== null && moved(was.windows, c.windows);
    const linked = was.linked || (confirmed && used);
    return {
      agree: was.agree + 1,
      disagree: 0,
      linked,
      detected_at: linked ? (was.detected_at ?? now) : null,
      last,
      windows: c.windows,
    };
  }
  const disagree = was.disagree + 1;
  const linked = was.linked && disagree < CONFIRM_PAIRS;
  return {
    agree: 0,
    disagree,
    linked,
    detected_at: linked ? was.detected_at : null,
    last,
    windows: null,
  };
}

/** Whether a pair's state links its roots now: linked, and not suspended by a mismatch. */
export function linkedNow(state: PairState | undefined): boolean {
  return state?.linked === true && state.disagree === 0;
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
    if (!linkedNow(pairs[key])) continue;
    const [a, b] = key.split("|") as [string, string];
    link(a, b, false);
  }

  const out = new Map<string, AccountGroup>();
  for (const [i, root] of roots.entries()) {
    if (find(i) !== i || (members[i] as number[]).length < 2) continue;
    const list = [...(members[i] as number[])].sort((x, y) => x - y).map((k) => roots[k] as Root);
    const id = groupId(list.map((r) => r.identity));
    const previous = recorded[(list[0] as Root).identity];
    const differs = list.some((x, k) =>
      list.slice(k + 1).some((y) => (pairs[pairKey(x.identity, y.identity)]?.disagree ?? 0) > 0),
    );
    const group: AccountGroup = {
      id,
      provider: root.provider,
      members: list,
      source: manualRoot.has(i) ? "manual" : "auto",
      detected_at: previous?.id === id ? previous.detected_at : null,
      differs,
    };
    for (const member of list) out.set(member.identity, group);
  }
  return out;
}

/**
 * limits.json's `groups` after this process evaluated `roots`: each of them in a group gets
 * its group's id, how it formed, and when this exact group was first recorded (kept from
 * `previous`, else `now`); each of them on its own loses its entry. Entries of roots this
 * process didn't evaluate (disabled here, or not found by it) are kept as they are, and so
 * is a recorded group with such a member: this process can't see all of it.
 */
export function mergeGroups(
  roots: readonly Root[],
  groups: ReadonlyMap<string, AccountGroup>,
  previous: Readonly<Record<string, GroupRecord>>,
  now: number,
): Record<string, GroupRecord> {
  const known = new Set(roots.map((root) => root.identity));
  const unseen = new Set(
    Object.entries(previous)
      .filter(([identity]) => !known.has(identity))
      .map(([, record]) => record.id),
  );
  const out: Record<string, GroupRecord> = { ...previous };
  for (const root of roots) {
    const group = groups.get(root.identity);
    const before = previous[root.identity];
    if (before !== undefined && unseen.has(before.id)) continue;
    if (group === undefined) {
      delete out[root.identity];
      continue;
    }
    out[root.identity] = {
      id: group.id,
      detected_at: before?.id === group.id ? before.detected_at : now,
      source: group.source,
    };
  }
  return out;
}
