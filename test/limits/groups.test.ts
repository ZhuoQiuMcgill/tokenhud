// Roots on one subscription account (T16): auto-detection from limit captures, manual links,
// and the groups they make. Pure functions: no files, no clock but the one passed in.
import { describe, expect, test } from "bun:test";
import { validateConfig } from "../../src/config.ts";
import type { Capture } from "../../src/limits/capture.ts";
import {
  CONFIRM_PAIRS,
  decidePair,
  detectPairs,
  groupId,
  type ManualLinks,
  manualLinks,
  NO_LINKS,
  PAIR_WINDOW_S,
  type PairState,
  pairKey,
  recordGroups,
  resolveGroups,
  sameAccount,
} from "../../src/limits/groups.ts";
import type { Root } from "../../src/sources/roots.ts";
import { guard } from "../guard.ts";
import { capture, fakeRoot } from "./helpers.ts";

guard();

/** 2026-10-01T12:00:00Z in epoch seconds, the captures' clock. */
const T = Date.parse("2026-10-01T12:00:00Z") / 1000;
const NOW_MS = T * 1000;
const MIN = 60;

/** A Claude capture at `at` (epoch s): 5-hour and weekly windows, resets in epoch s. */
function claude(at: number, session = 26, weekly = 69, sessionReset = T + 3600.25): Capture {
  return capture("claude", at, {
    session: { pct: session, resets: sessionReset, label: "5-HOUR" },
    weekly_all: { pct: weekly, resets: T + 4 * 86_400.5, label: "WEEKLY" },
  });
}

/** Feeds pairs of captures to `decidePair`, as rounds of fetches would. */
function run(pairs: [Capture, Capture][], start?: PairState): PairState | undefined {
  let state = start;
  for (const [a, b] of pairs) state = decidePair(state, a, b, NOW_MS);
  return state;
}

describe("sameAccount", () => {
  test("every window both have: the same reset to the millisecond and the same %", () => {
    expect(sameAccount(claude(T), claude(T + 20))).toBe(true);
  });

  test("a reset 1 ms apart is another account", () => {
    expect(sameAccount(claude(T), claude(T, 26, 69, T + 3600.251))).toBe(false);
  });

  test("another % is another account (or the same one, moved: not the same pair)", () => {
    expect(sameAccount(claude(T), claude(T, 27))).toBe(false);
  });

  test("a window only one capture has is ignored; no shared window can't tell", () => {
    const extra = claude(T);
    extra.rate_limits.weekly_scoped = { label: "FABLE WEEKLY", used_percentage: 99, resets_at: T };
    expect(sameAccount(claude(T), extra)).toBe(true);
    const old = capture("claude", T, { five_hour: { pct: 26, resets: T + 3600.25 } });
    expect(sameAccount(claude(T), old)).toBeNull();
  });
});

describe("decidePair: two consecutive pairs link, two unlink", () => {
  test("identical captures on two pairs: linked, dated when confirmed", () => {
    const state = run([
      [claude(T), claude(T + 5)],
      [claude(T + 5 * MIN), claude(T + 5 * MIN + 5)],
    ]);
    expect(CONFIRM_PAIRS).toBe(2);
    expect(state).toEqual({
      agree: 2,
      disagree: 0,
      linked: true,
      detected_at: NOW_MS,
      last: [T + 5 * MIN, T + 5 * MIN + 5],
    });
  });

  test("one pair only: not yet", () => {
    expect(run([[claude(T), claude(T + 5)]])).toMatchObject({ agree: 1, linked: false });
  });

  test("a reset 1 ms apart: never linked, however many pairs", () => {
    const pairs: [Capture, Capture][] = [0, 1, 2, 3, 4].map((k) => [
      claude(T + k * 5 * MIN),
      claude(T + k * 5 * MIN + 5, 26, 69, T + 3600.251),
    ]);
    expect(run(pairs)).toMatchObject({ agree: 0, disagree: 5, linked: false });
  });

  test("captures over 10 minutes apart decide nothing", () => {
    expect(run([[claude(T), claude(T + PAIR_WINDOW_S + 1)]])).toBeUndefined();
    const pending = run([[claude(T), claude(T + 5)]]);
    expect(run([[claude(T + 20 * MIN), claude(T + 40 * MIN)]], pending)).toBe(pending);
    // Exactly 10 minutes apart still counts.
    expect(run([[claude(T), claude(T + PAIR_WINDOW_S)]])).toMatchObject({ agree: 1 });
  });

  test("a capture already compared is not a new pair", () => {
    const once = run([[claude(T), claude(T + 5)]]);
    // Only one side is new: the same fetch of the other side can't count twice.
    expect(run([[claude(T + 5 * MIN), claude(T + 5)]], once)).toBe(once);
    expect(run([[claude(T), claude(T + 5 * MIN)]], once)).toBe(once);
  });

  test("a pair with no window in common decides nothing", () => {
    const old = capture("claude", T + 5, { five_hour: { pct: 26, resets: T + 3600.25 } });
    expect(run([[claude(T), old]])).toBeUndefined();
  });

  test("a disagreeing pair resets the count: agreement must be consecutive", () => {
    expect(
      run([
        [claude(T), claude(T + 5)],
        [claude(T + 5 * MIN), claude(T + 5 * MIN + 5, 30)],
        [claude(T + 10 * MIN), claude(T + 10 * MIN + 5)],
      ]),
    ).toMatchObject({ agree: 1, disagree: 0, linked: false });
  });

  test("unlinked after two mismatching pairs; one mismatch keeps the link", () => {
    const linked = run([
      [claude(T), claude(T + 5)],
      [claude(T + 5 * MIN), claude(T + 5 * MIN + 5)],
    ]);
    const once = run([[claude(T + 10 * MIN, 40), claude(T + 10 * MIN + 5, 41)]], linked);
    expect(once).toMatchObject({ disagree: 1, linked: true, detected_at: NOW_MS });
    const twice = run([[claude(T + 15 * MIN, 40), claude(T + 15 * MIN + 5, 52)]], once);
    expect(twice).toMatchObject({ agree: 0, disagree: 2, linked: false, detected_at: null });
    // An agreeing pair in between would have kept it linked.
    const kept = run(
      [
        [claude(T + 15 * MIN), claude(T + 15 * MIN + 5)],
        [claude(T + 20 * MIN, 40), claude(T + 20 * MIN + 5, 52)],
      ],
      once,
    );
    expect(kept).toMatchObject({ disagree: 1, linked: true });
  });
});

describe("detectPairs", () => {
  test("every same-provider pair, Codex homes as well as Claude dirs", () => {
    const a = fakeRoot("claude", "personal-like", "/home/x/.claude");
    const b = fakeRoot("claude", "win-like", "/mnt/c/Users/x/.claude", { source: "wsl" });
    const c = fakeRoot("codex", "codex-like", "/home/x/.codex");
    const d = fakeRoot("codex", "codex-win-like", "/mnt/c/Users/x/.codex", { source: "wsl" });
    const codexAt = (at: number) =>
      capture("codex", at, {
        codex_primary: { pct: 12, resets: T + 7200.5, minutes: 300 },
        codex_secondary: { pct: 40, resets: T + 5 * 86_400, minutes: 10_080 },
      });
    let pairs: Record<string, PairState> = {};
    for (const at of [T, T + 5 * MIN]) {
      const captures = new Map<string, Capture | null>([
        [a.identity, claude(at)],
        [b.identity, claude(at + 3)],
        [c.identity, codexAt(at + 1)],
        [d.identity, codexAt(at + 2)],
      ]);
      pairs = detectPairs([a, b, c, d], captures, pairs, NOW_MS);
    }
    // Claude and Codex captures are never compared with each other.
    expect(Object.keys(pairs).sort()).toEqual(
      [pairKey(a.identity, b.identity), pairKey(c.identity, d.identity)].sort(),
    );
    expect(pairs[pairKey(a.identity, b.identity)]?.linked).toBe(true);
    expect(pairs[pairKey(c.identity, d.identity)]?.linked).toBe(true);
  });

  test("a root not listed keeps its pairs as they were", () => {
    const a = fakeRoot("claude", "a", "/a");
    const b = fakeRoot("claude", "b", "/b");
    const kept: PairState = { agree: 2, disagree: 0, linked: true, detected_at: 1, last: [1, 2] };
    const before = { [pairKey(a.identity, "f".repeat(32))]: kept };
    expect(detectPairs([a, b], new Map(), before, NOW_MS)).toEqual(before);
  });
});

describe("resolveGroups: manual links win over auto-detection", () => {
  const roots = (): Root[] => [
    fakeRoot("claude", "personal-like", "/home/x/.claude"),
    fakeRoot("claude", "win-like", "/mnt/c/Users/x/.claude", { source: "wsl" }),
    fakeRoot("claude", "work-like", "/home/x/.claude-work", { source: "home" }),
    fakeRoot("codex", "codex-like", "/home/x/.codex"),
  ];
  const linked = (a: Root, b: Root, at = 5): Record<string, PairState> => ({
    [pairKey(a.identity, b.identity)]: {
      agree: 2,
      disagree: 0,
      linked: true,
      detected_at: at,
      last: [1, 2],
    },
  });
  const labels = (groups: ReturnType<typeof resolveGroups>, root: Root) =>
    groups.get(root.identity)?.members.map((m) => m.label) ?? null;

  test("an auto link: one group, in discovery order, its id a hash of the members", () => {
    const [p, w, k] = roots() as [Root, Root, Root];
    const groups = resolveGroups([p, w, k], NO_LINKS, linked(w, p));
    expect(labels(groups, w)).toEqual(["personal-like", "win-like"]);
    expect(groups.get(p.identity)).toBe(groups.get(w.identity));
    expect(groups.get(k.identity)).toBeUndefined();
    expect(groups.get(p.identity)).toMatchObject({
      id: groupId([w.identity, p.identity]),
      source: "auto",
      // Not recorded in limits.json yet.
      detected_at: null,
      provider: "claude",
    });
    expect(groupId([p.identity, w.identity])).toBe(groupId([w.identity, p.identity]));
    expect(groupId([p.identity, w.identity])).toMatch(/^[0-9a-f]{32}$/);
  });

  test("same_account links roots auto-detection never saw; across providers it does not", () => {
    const [p, w, k, c] = roots() as [Root, Root, Root, Root];
    const manual: ManualLinks = { same: [[p.identity, k.identity, c.identity]], separate: [] };
    const groups = resolveGroups([p, w, k, c], manual);
    expect(labels(groups, k)).toEqual(["personal-like", "work-like"]);
    expect(groups.get(k.identity)).toMatchObject({ source: "manual", detected_at: null });
    expect(groups.get(c.identity)).toBeUndefined();
  });

  test("separate_accounts keeps an auto-linked pair apart", () => {
    const [p, w] = roots() as [Root, Root];
    const manual: ManualLinks = { same: [], separate: [[w.identity, p.identity]] };
    expect(resolveGroups([p, w], manual, linked(p, w)).size).toBe(0);
  });

  test("a separate pair wins over a same_account link too", () => {
    const [p, w] = roots() as [Root, Root];
    const manual: ManualLinks = {
      same: [[p.identity, w.identity]],
      separate: [[p.identity, w.identity]],
    };
    expect(resolveGroups([p, w], manual).size).toBe(0);
  });

  test("links never chain two separate roots into one group", () => {
    const [p, w, k] = roots() as [Root, Root, Root];
    // personal~win by hand, win~work found; but personal and work are kept apart.
    const manual: ManualLinks = {
      same: [[p.identity, w.identity]],
      separate: [[p.identity, k.identity]],
    };
    const groups = resolveGroups([p, w, k], manual, linked(w, k));
    expect(labels(groups, p)).toEqual(["personal-like", "win-like"]);
    expect(groups.get(k.identity)).toBeUndefined();
  });

  test("a manual and an auto link make one manual group", () => {
    const [p, w, k] = roots() as [Root, Root, Root];
    const manual: ManualLinks = { same: [[p.identity, w.identity]], separate: [] };
    const groups = resolveGroups([p, w, k], manual, linked(w, k, 9));
    expect(labels(groups, k)).toEqual(["personal-like", "win-like", "work-like"]);
    expect(groups.get(k.identity)?.source).toBe("manual");
  });

  test("roots not passed (disabled) are left out of groups", () => {
    const [p, w] = roots() as [Root, Root];
    expect(resolveGroups([p], NO_LINKS, linked(p, w)).size).toBe(0);
  });

  test("recordGroups keeps when a group was first recorded while its members stay", () => {
    const [p, w, k] = roots() as [Root, Root, Root];
    const first = recordGroups(resolveGroups([p, w, k], NO_LINKS, linked(p, w, 5)), {}, 100);
    expect(first[p.identity]).toEqual({
      id: groupId([p.identity, w.identity]),
      detected_at: 100,
      source: "auto",
    });
    const manual = { same: [[p.identity, k.identity]], separate: [] };
    const later = recordGroups(
      resolveGroups([p, w, k], manual, linked(p, w, 5), first),
      first,
      200,
    );
    // personal and win were joined by work: a new group, recorded now.
    expect(later[w.identity]).toEqual({
      id: groupId([p.identity, w.identity, k.identity]),
      detected_at: 200,
      source: "manual",
    });
    const again = recordGroups(
      resolveGroups([p, w, k], manual, linked(p, w, 5), later),
      later,
      300,
    );
    expect(again).toEqual(later);
    // A group read back takes its first-recorded time.
    expect(
      resolveGroups([p, w, k], manual, linked(p, w, 5), later).get(k.identity)?.detected_at,
    ).toBe(200);
  });
});

describe("config: same_account and separate_accounts", () => {
  test("default to none; manualLinks reads them", () => {
    const config = validateConfig({});
    expect(config.same_account).toEqual([]);
    expect(config.separate_accounts).toEqual([]);
    expect(manualLinks(config)).toEqual(NO_LINKS);
  });

  test("bad entries are dropped: not a list, fewer than two ids, repeats; pairs only apart", () => {
    const config = validateConfig({
      same_account: [["a", "b", "a", 5, ""], ["c"], "d", null, ["e", "f", "g"]],
      separate_accounts: [["a", "b"], ["a", "b", "c"], ["c", "c"], {}, ["d", "e"]],
    });
    expect(config.same_account).toEqual([
      ["a", "b"],
      ["e", "f", "g"],
    ]);
    expect(config.separate_accounts).toEqual([
      ["a", "b"],
      ["d", "e"],
    ]);
    expect(validateConfig({ same_account: "a,b", separate_accounts: 7 })).toMatchObject({
      same_account: [],
      separate_accounts: [],
    });
  });
});
