import { describe, expect, test } from "bun:test";
import { breakpoint, cardsPerRow, fitSections, splitWidth } from "../../src/tui/layout.ts";
import { guard } from "../guard.ts";

guard();

test("breakpoints: wide ≥ 120, medium 100–119, narrow < 100", () => {
  expect([160, 120, 119, 105, 100, 99, 80].map(breakpoint)).toEqual([
    "wide",
    "wide",
    "medium",
    "medium",
    "medium",
    "narrow",
    "narrow",
  ]);
  expect(["wide", "medium", "narrow"].map((b) => cardsPerRow(b as never))).toEqual([3, 2, 1]);
});

describe("fitSections", () => {
  // The Overview's shape: limits, spend, activity (can shrink), top models, events.
  const overview = [
    { id: "limits", priority: 1, height: 16, minHeight: 6 },
    { id: "spend", priority: 2, height: 4 },
    { id: "activity", priority: 3, height: 9, minHeight: 5 },
    { id: "top", priority: 4, height: 6 },
    { id: "events", priority: 5, height: 2 },
  ];

  test("everything at full height when it fits, with a gap row between sections", () => {
    // 16 + 4 + 9 + 6 + 2 = 37, plus 4 gaps = 41.
    expect(fitSections(overview, 41)).toEqual([
      { id: "limits", height: 16 },
      { id: "spend", height: 4 },
      { id: "activity", height: 9 },
      { id: "top", height: 6 },
      { id: "events", height: 2 },
    ]);
  });

  test("one row short: sections shrink before anything drops", () => {
    // Minimums 6 + 4 + 5 + 6 + 2 + 4 gaps = 27; 13 spare rows go to limits (+10), then activity (+3).
    expect(fitSections(overview, 40)).toEqual([
      { id: "limits", height: 16 },
      { id: "spend", height: 4 },
      { id: "activity", height: 8 },
      { id: "top", height: 6 },
      { id: "events", height: 2 },
    ]);
  });

  test("the lowest priority drops first, and nothing below a dropped section shows", () => {
    // 80×24 leaves 19 rows: limits 6, spend 4, activity 5 (+ 2 gaps) = 17; top (6) can't fit,
    // so top and events go even though events alone (2 + gap) would fit.
    const fitted = fitSections(overview, 19);
    expect(fitted.map((f) => f.id)).toEqual(["limits", "spend", "activity"]);
    expect(fitted).toEqual([
      { id: "limits", height: 8 },
      { id: "spend", height: 4 },
      { id: "activity", height: 5 },
    ]);
  });

  test("display order is the order given, whatever the priorities", () => {
    const history = [
      { id: "heat", priority: 2, height: 9 },
      { id: "table", priority: 1, height: 40, minHeight: 4 },
    ];
    expect(fitSections(history, 20)).toEqual([
      { id: "heat", height: 9 },
      { id: "table", height: 10 },
    ]);
    expect(fitSections(history, 12)).toEqual([{ id: "table", height: 12 }]);
  });

  test("the top section always shows, cut to the rows there are", () => {
    expect(fitSections([{ id: "a", priority: 1, height: 30, minHeight: 20 }], 7)).toEqual([
      { id: "a", height: 7 },
    ]);
    expect(fitSections([], 10)).toEqual([]);
    expect(fitSections(overview, 0)).toEqual([]);
  });

  test("used rows never exceed the rows given", () => {
    for (let rows = 1; rows <= 60; rows++) {
      const fitted = fitSections(overview, rows);
      const used = fitted.reduce((n, f) => n + f.height, 0) + Math.max(0, fitted.length - 1);
      expect(used).toBeLessThanOrEqual(rows);
    }
  });
});

describe("splitWidth: integer widths (Yoga's are fractional)", () => {
  test("cards of the 120-column Overview: 3 × 38 with 2-cell gaps", () => {
    expect(splitWidth(118, 3, 2)).toEqual([38, 38, 38]);
  });

  test("the remainder goes to the first columns, one cell each", () => {
    expect(splitWidth(103, 2, 2)).toEqual([51, 50]);
    expect(splitWidth(117, 4)).toEqual([30, 29, 29, 29]);
    expect(splitWidth(10, 0)).toEqual([]);
  });
});
