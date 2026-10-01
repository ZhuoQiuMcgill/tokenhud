import { describe, expect, test } from "bun:test";
import {
  clip,
  clock,
  countdown,
  dayLabel,
  fit,
  money,
  moneyShort,
  percent,
  periodLabel,
  textWidth,
  tokens,
  truncate,
} from "../../src/tui/format.ts";

describe("money", () => {
  test.each([
    [0, "$0.00"],
    [0.004, "$0.00"],
    [0.005, "$0.01"],
    [212.4, "$212.40"],
    [1284.55, "$1,284.55"],
    [16305.1, "$16,305.10"],
    [1234567.891, "$1,234,567.89"],
    [-5.5, "-$5.50"],
  ])("%p → %s", (value, text) => expect(money(value)).toBe(text));
});

describe("moneyShort (chart labels)", () => {
  test.each([
    [0, "$0.00"],
    [9.2, "$9.20"],
    [18.4, "$18.4"],
    [340, "$340"],
    [1234, "$1.23K"],
    [1500, "$1.5K"],
    [16_000, "$16K"],
    [2_500_000, "$2.5M"],
  ])("%p → %s", (value, text) => expect(moneyShort(value)).toBe(text));
});

describe("tokens, written as the prototype writes them", () => {
  test.each([
    [0, "0"],
    [374, "374"],
    [92_000, "92K"],
    [880_400, "880K"],
    [999_499, "999K"],
    [999_500, "1.0M"],
    [41_200_000, "41.2M"],
    [188_000_000, "188.0M"],
    [1_920_000_000, "1.92B"],
    [2_100_000_000, "2.10B"],
    [24_600_000_000, "24.6B"],
    [124_600_000_000, "125B"],
  ])("%p → %s", (n, text) => expect(tokens(n)).toBe(text));
});

test("percent", () => {
  expect(percent(0.692)).toBe("69.2%");
  expect(percent(0)).toBe("0.0%");
  expect(percent(0.68, 0)).toBe("68%");
});

describe("countdown", () => {
  test.each([
    [0, "0s"],
    [45_000, "45s"],
    [12 * 60_000, "12m"],
    [(60 + 48) * 60_000, "1h48m"],
    [(19 * 60 + 5) * 60_000, "19h05m"],
    [(4 * 24 + 6) * 3_600_000, "4d06h"],
    [-5, "0s"],
  ])("%p ms → %s", (ms, text) => expect(countdown(ms)).toBe(text));
});

test("dayLabel and periodLabel read local keys without a zone", () => {
  expect(dayLabel("2026-09-29")).toBe("Tue Sep 29");
  expect(dayLabel("2026-10-01")).toBe("Thu Oct 1");
  expect(periodLabel("2026-09")).toBe("Sep 2026");
  expect(periodLabel("2026-09-28")).toBe("wk of Sep 28");
});

test("clock formats wall time in the given zone", () => {
  const t = Date.parse("2026-09-29T15:40:00Z");
  expect(clock(t, "America/Toronto")).toBe("11:40");
  expect(clock(t, "Asia/Kolkata")).toBe("21:10");
  expect(clock(t, "UTC")).toBe("15:40");
});

describe("truncation (OpenTUI has no ellipsis of its own)", () => {
  test("text that fits is unchanged", () => {
    expect(truncate("personal", 8)).toBe("personal");
    expect(truncate("personal", 20)).toBe("personal");
  });

  test("text that doesn't ends in … within the width", () => {
    expect(truncate("claude-opus-4-8", 10)).toBe("claude-op…");
    expect(textWidth(truncate("claude-opus-4-8", 10))).toBe(10);
    expect(truncate("abc", 1)).toBe("…");
    expect(truncate("abc", 0)).toBe("");
  });

  test("wide characters count two cells and are never split", () => {
    expect(textWidth("账户")).toBe(4);
    expect(truncate("账户名称", 5)).toBe("账户…");
    expect(clip("账户名称", 3)).toBe("账");
  });

  test("fit pads or cuts to exactly the width, either alignment", () => {
    expect(fit("$9.20", 8, "right")).toBe("   $9.20");
    expect(fit("Opus", 6)).toBe("Opus  ");
    expect(fit("claude-opus", 6, "right")).toBe("claud…");
    expect(fit("账户", 5)).toBe("账户 ");
  });
});
