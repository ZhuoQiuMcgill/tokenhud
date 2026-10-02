// Roots on one subscription account (T16): auto-detection from limit captures, manual links,
// and the groups they make. Pure functions: no files, no clock but the one passed in.
import { describe, expect, test } from "bun:test";
import { validateConfig } from "../../src/config.ts";
import type { Capture } from "../../src/limits/capture.ts";
import {
  CLOSE_S,
  compareCaptures,
  decidePair,
  detectPairs,
  groupId,
  linkedNow,
  type ManualLinks,
  manualLinks,
  mergeGroups,
  NO_LINKS,
  PAIR_WINDOW_S,
  type PairState,
  pairKey,
  resolveGroups,
} from "../../src/limits/groups.ts";
import type { Root } from "../../src/sources/roots.ts";
import { guard } from "../guard.ts";
import { capture, fakeRoot } from "./helpers.ts";

guard();

/** 2026-10-01T12:00:00Z in epoch seconds, the captures' clock. */
const T = Date.parse("2026-10-01T12:00:00Z") / 1000;
const NOW_MS = T * 1000;
const MIN = 60;
/** Whole-minute and whole-hour resets: what the provider's jitter is added to. */
const FIVE_HOUR = T + 3 * 3600;
const WEEK = T + 4 * 86_400;

/**
 * A Claude capture at `at` (epoch s): 5-hour and weekly windows used at `session` and
 * `weekly` %, their resets off the whole minute and hour by `jitter` seconds.
 */
function claude(
  at: number,
  session: number,
  weekly: number,
  jitter: { five: number; week: number } = { five: 0, week: 0 },
): Capture {
  return capture("claude", at, {
    session: { pct: session, resets: FIVE_HOUR + jitter.five, label: "5-HOUR" },
    weekly_all: { pct: weekly, resets: WEEK + jitter.week, label: "WEEKLY" },
  });
}

/** Feeds pairs of captures to `decidePair`, as rounds of fetches would. */
function run(pairs: [Capture, Capture][], start?: PairState): PairState | undefined {
  let state = start;
  for (const [a, b] of pairs) state = decidePair(state, a, b, NOW_MS);
  return state;
}

/** Jitter in seconds, within the ±0.7 s seen live, crossing whole seconds both ways. */
const JITTER = [0.337, -0.153, 0.847, -0.5, 0.12, -0.69, 0.5, 0.01, -0.35, 0.66, -0.06, 0.41];
const jitter = (i: number) => JITTER[i % JITTER.length] as number;

/**
 * One account seen from two roots over `n` rounds 5 minutes apart: each round's two
 * captures are 3 s apart, each with its own jitter, and the 5-hour use grows 2 % a round.
 */
function oneAccount(n: number, start = 0): [Capture, Capture][] {
  return Array.from({ length: n }, (_, i) => {
    const k = start + i;
    const at = T + k * 5 * MIN;
    const use = 20 + 2 * k;
    return [
      claude(at, use, 40, { five: jitter(2 * k), week: jitter(2 * k + 1) }),
      claude(at + 3, use, 40, { five: jitter(2 * k + 1), week: jitter(2 * k + 3) }),
    ];
  });
}

/** `c` with its 5-hour window resetting at `resets` (epoch s). */
function withFiveHour(c: Capture, resets: number): Capture {
  const session = c.rate_limits.session as Capture["rate_limits"][string];
  return { ...c, rate_limits: { ...c.rate_limits, session: { ...session, resets_at: resets } } };
}

describe("compareCaptures", () => {
  test("resets agree within 2 s, across a whole second (the live data)", () => {
    // 5-HOUR …600.337 vs …599.847, WEEKLY …600.337 vs …600.847.
    const a = claude(T, 19, 51, { five: 0.337, week: 0.337 });
    const b = claude(T + 37, 19, 51, { five: -0.153, week: 0.847 });
    expect(compareCaptures(a, b)).toMatchObject({
      shared: 2,
      resetsAgree: true,
      close: true,
      sameUse: true,
    });
  });

  test("3 s apart is another account; another % on close captures too", () => {
    const a = claude(T, 19, 51);
    expect(compareCaptures(a, claude(T + 5, 19, 51, { five: 3, week: 0 })).resetsAgree).toBe(false);
    expect(compareCaptures(a, claude(T + 5, 20, 51)).sameUse).toBe(false);
  });

  test("utilisation is only judged on captures at most 60 s apart", () => {
    const a = claude(T, 19, 51);
    expect(compareCaptures(a, claude(T + CLOSE_S, 19, 51)).close).toBe(true);
    expect(compareCaptures(a, claude(T + CLOSE_S + 1, 19, 51)).close).toBe(false);
  });

  test("a window whose instance ended between the captures is left out", () => {
    // The 5-hour window reset at T + 60 s: the later capture sees the next instance.
    const before = capture("claude", T, {
      session: { pct: 90, resets: T + 60 },
      weekly_all: { pct: 40, resets: WEEK },
    });
    const after = capture("claude", T + 120, {
      session: { pct: 1, resets: T + 120 + 5 * 3600 },
      weekly_all: { pct: 40, resets: WEEK },
    });
    expect(compareCaptures(before, after)).toMatchObject({ shared: 1, resetsAgree: true });
  });
});

describe("decidePair: resets within 2 s, moving together, twice in a row", () => {
  test("a jittered pair crossing a second boundary links, once the account moved", () => {
    // The critic's case: 12 pairs, jitter up to ±0.85 s. The exact rule disagreed 12 times.
    expect(run(oneAccount(12))).toMatchObject({ agree: 12, disagree: 0, linked: true });
    // Linked on the second pair: the 5-hour use moved from 20 % to 22 % on both.
    expect(run(oneAccount(2))).toMatchObject({ agree: 2, linked: true, detected_at: NOW_MS });
  });

  test("the same change seen hours apart doesn't link: the confirming pair must follow within two rounds", () => {
    // The critic's case: two different accounts on the same weekly reset hour, both at 0 %
    // at 08:00, both at 1 % at 20:00 (tokenhud not running in between). One also has a
    // 5-hour window open then, which the other lacks, so it isn't compared.
    const weekly = (at: number, pct: number, jitter: number, fiveHour: boolean) =>
      capture("claude", at, {
        weekly_all: { pct, resets: WEEK + jitter, label: "WEEKLY" },
        ...(fiveHour ? { session: { pct: 40, resets: at + 3600, label: "5-HOUR" } } : {}),
      });
    const later = T + 12 * 3600;
    const pairs: [Capture, Capture][] = [
      [weekly(T, 0, 0, false), weekly(T + 2, 0, 0, false)],
      [weekly(later, 1, 0.4, true), weekly(later + 2, 1, -0.4, false)],
    ];
    expect(run(pairs)).toMatchObject({ agree: 1, linked: false, agreed_at: later });
    // Two rounds and a minute later is too late as well; within two rounds confirms.
    const [first, second] = oneAccount(2) as [[Capture, Capture], [Capture, Capture]];
    const delayed = (c: Capture, by: number): Capture => ({
      ...c,
      captured_at: c.captured_at + by,
    });
    const late = 11 * MIN + 1 - 5 * MIN;
    expect(run([first, [delayed(second[0], late), delayed(second[1], late)]])).toMatchObject({
      agree: 1,
      linked: false,
    });
    const inTime = 10 * MIN - 5 * MIN;
    expect(run([first, [delayed(second[0], inTime), delayed(second[1], inTime)]])).toMatchObject({
      agree: 2,
      linked: true,
    });
  });

  test("one pair only: not yet", () => {
    expect(run(oneAccount(1))).toMatchObject({ agree: 1, linked: false });
  });

  test("resets 3 s apart never link, however the use moves", () => {
    const pairs = oneAccount(8).map(([a, b]): [Capture, Capture] => [
      a,
      withFiveHour(b, FIVE_HOUR + 3),
    ]);
    expect(run(pairs)).toMatchObject({ agree: 0, disagree: 8, linked: false });
  });

  test("two different idle accounts with the same reset hour never link", () => {
    // The critic's case: each has WEEKLY and a model's weekly at 0 %, resetting on the same
    // whole hour, and no 5-hour window. They agree on every pair, but nothing moves.
    const idle = (at: number) =>
      capture("claude", at, {
        weekly_all: { pct: 0, resets: WEEK },
        weekly_scoped: { pct: 0, resets: WEEK, label: "FABLE WEEKLY" },
      });
    const pairs: [Capture, Capture][] = Array.from({ length: 12 }, (_, k) => [
      idle(T + k * 5 * MIN),
      idle(T + k * 5 * MIN + 2),
    ]);
    expect(run(pairs)).toMatchObject({ agree: 12, linked: false });
  });

  test("two accounts at the same steady use never link either: no move, no link", () => {
    const pairs: [Capture, Capture][] = Array.from({ length: 6 }, (_, k) => [
      claude(T + k * 5 * MIN, 7, 12),
      claude(T + k * 5 * MIN + 2, 7, 12),
    ]);
    expect(run(pairs)).toMatchObject({ agree: 6, linked: false });
  });

  test("captures over 60 s apart don't compare use; resets can still veto", () => {
    const pending = run(oneAccount(1));
    // Same resets, 2 minutes apart, different use: no decision either way.
    const apart: [Capture, Capture] = [claude(T + 10 * MIN, 30, 40), claude(T + 12 * MIN, 31, 40)];
    expect(run([apart], pending)).toBe(pending);
    // A 5-hour reset an hour off: another account, even 2 minutes apart.
    const veto = run(
      [
        [
          claude(T + 10 * MIN, 30, 40),
          withFiveHour(claude(T + 12 * MIN, 30, 40), FIVE_HOUR + 3600),
        ],
      ],
      pending,
    );
    expect(veto).toMatchObject({ agree: 0, disagree: 1, linked: false });
  });

  test("captures over 10 minutes apart decide nothing", () => {
    expect(run([[claude(T, 20, 40), claude(T + PAIR_WINDOW_S + 1, 20, 40)]])).toBeUndefined();
  });

  test("a capture already compared is not a new pair", () => {
    const [first] = oneAccount(1) as [[Capture, Capture]];
    const once = run([first]);
    expect(run([[claude(T + 5 * MIN, 22, 40), first[1]]], once)).toBe(once);
  });

  test("a pair with no window in common decides nothing", () => {
    const old = capture("claude", T + 5, { five_hour: { pct: 26, resets: FIVE_HOUR } });
    expect(run([[claude(T, 26, 40), old]])).toBeUndefined();
  });

  test("a use-only difference while resets agree is inconclusive; two in a row are one mismatch", () => {
    const linked = run(oneAccount(2)) as PairState;
    // Use ticked between the two requests: resets agree, use differs by 1 %.
    const tick = (k: number): [Capture, Capture] => [
      claude(T + k * 5 * MIN, 30, 40),
      claude(T + k * 5 * MIN + 2, 31, 40),
    ];
    const once = run([tick(2)], linked) as PairState;
    expect(once).toMatchObject({ inconclusive: 1, disagree: 0, linked: true });
    // The link stays whole: the card doesn't split.
    expect(linkedNow(once)).toBe(true);
    // An agreeing pair clears it; a second inconclusive one counts as a mismatch.
    expect(run(oneAccount(1, 3), once)).toMatchObject({ inconclusive: 0, disagree: 0 });
    const twice = run([tick(3)], once) as PairState;
    expect(twice).toMatchObject({ inconclusive: 0, disagree: 1, linked: true });
    expect(linkedNow(twice)).toBe(false);
    // A reset beyond 2 s still splits at once.
    const moved = run(
      [
        [
          claude(T + 10 * MIN, 30, 40),
          withFiveHour(claude(T + 10 * MIN + 2, 30, 40), FIVE_HOUR + 3),
        ],
      ],
      linked,
    );
    expect(moved).toMatchObject({ disagree: 1 });
    expect(linkedNow(moved)).toBe(false);
  });

  test("one mismatch suspends a link, a match restores it, two in a row unlink", () => {
    const linked = run(oneAccount(2)) as PairState;
    expect(linkedNow(linked)).toBe(true);
    // The second root now shows another account: other use, other resets.
    const switched = (k: number): [Capture, Capture] => [
      claude(T + k * 5 * MIN, 30, 40),
      withFiveHour(claude(T + k * 5 * MIN + 2, 3, 11), FIVE_HOUR + 7200),
    ];
    const once = run([switched(2)], linked) as PairState;
    expect(once).toMatchObject({ disagree: 1, linked: true, detected_at: NOW_MS });
    expect(linkedNow(once)).toBe(false);
    expect(linkedNow(run(oneAccount(1, 3), once))).toBe(true);
    const twice = run([switched(3)], once);
    expect(twice).toMatchObject({ agree: 0, disagree: 2, linked: false, detected_at: null });
  });
});

describe("detectPairs", () => {
  test("every same-provider pair, Codex homes as well as Claude dirs", () => {
    const a = fakeRoot("claude", "personal-like", "/home/x/.claude");
    const b = fakeRoot("claude", "win-like", "/mnt/c/Users/x/.claude", { source: "wsl" });
    const c = fakeRoot("codex", "codex-like", "/home/x/.codex");
    const d = fakeRoot("codex", "codex-win-like", "/mnt/c/Users/x/.codex", { source: "wsl" });
    const codexAt = (at: number, use: number) =>
      capture("codex", at, {
        codex_primary: { pct: use, resets: T + 7200.5, minutes: 300 },
        codex_secondary: { pct: 40, resets: T + 5 * 86_400, minutes: 10_080 },
      });
    let pairs: Record<string, PairState> = {};
    for (const [k, [x, y]] of oneAccount(2).entries()) {
      const captures = new Map<string, Capture | null>([
        [a.identity, x],
        [b.identity, y],
        [c.identity, codexAt(x.captured_at + 1, 12 + k)],
        [d.identity, codexAt(x.captured_at + 2, 12 + k)],
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
    const kept: PairState = {
      agree: 2,
      disagree: 0,
      inconclusive: 0,
      linked: true,
      detected_at: 1,
      last: [1, 2],
      agreed_at: 1,
      resets: [{}, {}],
      windows: {},
    };
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
  const linked = (a: Root, b: Root, over: Partial<PairState> = {}) => ({
    [pairKey(a.identity, b.identity)]: {
      agree: 2,
      disagree: 0,
      inconclusive: 0,
      linked: true,
      detected_at: 5,
      last: [1, 2] as [number, number],
      agreed_at: 1,
      resets: [{}, {}] as PairState["resets"],
      windows: {},
      ...over,
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
      differs: false,
    });
    expect(groupId([p.identity, w.identity])).toBe(groupId([w.identity, p.identity]));
    expect(groupId([p.identity, w.identity])).toMatch(/^[0-9a-f]{32}$/);
  });

  test("an auto link suspended by a mismatch is no group: its roots show apart", () => {
    const [p, w] = roots() as [Root, Root];
    expect(resolveGroups([p, w], NO_LINKS, linked(p, w, { disagree: 1 })).size).toBe(0);
  });

  test("a manual link is kept when its roots disagree, and says so", () => {
    const [p, w] = roots() as [Root, Root];
    const manual: ManualLinks = { same: [[p.identity, w.identity]], separate: [] };
    const groups = resolveGroups([p, w], manual, linked(p, w, { linked: false, disagree: 2 }));
    expect(groups.get(w.identity)).toMatchObject({ source: "manual", differs: true });
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
    const groups = resolveGroups([p, w, k], manual, linked(w, k));
    expect(labels(groups, k)).toEqual(["personal-like", "win-like", "work-like"]);
    expect(groups.get(k.identity)?.source).toBe("manual");
  });

  test("roots not passed (disabled) are left out of groups", () => {
    const [p, w] = roots() as [Root, Root];
    expect(resolveGroups([p], NO_LINKS, linked(p, w)).size).toBe(0);
  });
});

describe("mergeGroups: limits.json's record, merged per root", () => {
  const [p, w, k] = [
    fakeRoot("claude", "personal-like", "/home/x/.claude"),
    fakeRoot("claude", "win-like", "/mnt/c/Users/x/.claude", { source: "wsl" }),
    fakeRoot("claude", "work-like", "/home/x/.claude-work", { source: "home" }),
  ] as [Root, Root, Root];
  const pw: ManualLinks = { same: [[p.identity, w.identity]], separate: [] };
  const id = groupId([p.identity, w.identity]);

  test("keeps when a group was first recorded while its members stay", () => {
    const first = mergeGroups([p, w, k], resolveGroups([p, w, k], pw), {}, 100);
    expect(first).toEqual({
      [p.identity]: { id, detected_at: 100, source: "manual" },
      [w.identity]: { id, detected_at: 100, source: "manual" },
    });
    expect(mergeGroups([p, w, k], resolveGroups([p, w, k], pw, {}, first), first, 200)).toEqual(
      first,
    );
    // A group read back takes its first-recorded time.
    expect(resolveGroups([p, w, k], pw, {}, first).get(w.identity)?.detected_at).toBe(100);
    // Joined by work-like: a new group, recorded now.
    const pwk: ManualLinks = { same: [[p.identity, w.identity, k.identity]], separate: [] };
    const later = mergeGroups([p, w, k], resolveGroups([p, w, k], pwk, {}, first), first, 300);
    expect(later[k.identity]).toEqual({
      id: groupId([p.identity, w.identity, k.identity]),
      detected_at: 300,
      source: "manual",
    });
  });

  test("a root this process found on its own loses its entry; others' entries stay", () => {
    const first = mergeGroups([p, w], resolveGroups([p, w], pw), {}, 100);
    const elsewhere = {
      [k.identity]: { id: "f".repeat(32), detected_at: 1, source: "auto" as const },
    };
    const merged = mergeGroups(
      [p, w],
      resolveGroups([p, w], NO_LINKS),
      { ...first, ...elsewhere },
      200,
    );
    expect(merged).toEqual(elsewhere);
  });

  test("a process that can't see every member of a recorded group leaves it alone", () => {
    // A process that doesn't know win-like (disabled or not found in its view) must neither
    // record personal-like on its own nor re-date the group.
    const first = mergeGroups([p, w], resolveGroups([p, w], pw), {}, 100);
    expect(mergeGroups([p], resolveGroups([p], pw), first, 200)).toEqual(first);
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
