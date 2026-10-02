import { describe, expect, test } from "bun:test";
import { THEME_CHOICES } from "../../src/config.ts";
import { level, onSel, PALETTES, ROLES, theme } from "../../src/tui/theme.ts";
import { guard } from "../guard.ts";

guard();

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** WCAG 2 contrast ratio. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_ROLES = [
  "fg",
  "dim",
  "mute",
  "head",
  "cost",
  "tokens",
  "low",
  "mid",
  "high",
  "live",
] as const;

test("every theme defines every role as #rrggbb", () => {
  for (const name of THEME_CHOICES) {
    for (const role of ROLES) expect(PALETTES[name][role]).toMatch(/^#[0-9a-f]{6}$/);
    expect(theme(name).name).toBe(name);
  }
});

test("dark is the prototype's palette (docs/design/gen.py P and HEAT)", () => {
  expect(PALETTES.dark).toMatchObject({
    bg: "#0e1116",
    border: "#2b3440",
    rule: "#232b36",
    fg: "#c8d0d9",
    dim: "#5f6a77",
    mute: "#8b96a4",
    head: "#eef2f6",
    cost: "#e8a33d",
    tokens: "#6cb6ff",
    low: "#5aa9e6",
    mid: "#e8a33d",
    high: "#ff7a59",
    live: "#56d4c1",
    sel: "#1c2634",
    tab: "#273447",
    empty: "#2c3542",
    heat0: "#1a2029",
    heat1: "#16384f",
    heat2: "#1d5a80",
    heat3: "#2b82b3",
    heat4: "#6cb6ff",
  });
});

describe("readable contrast", () => {
  test.each([...TEXT_ROLES])("light: %s reads at 4.5:1 or better on the background", (role) => {
    expect(contrast(PALETTES.light[role], PALETTES.light.bg)).toBeGreaterThanOrEqual(4.5);
  });

  test.each([...TEXT_ROLES])(
    "high-contrast: %s reads at 4.5:1 or better on the background",
    (role) => {
      expect(
        contrast(PALETTES["high-contrast"][role], PALETTES["high-contrast"].bg),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  test("high-contrast main text reads at 7:1 or better (WCAG AAA)", () => {
    const p = PALETTES["high-contrast"];
    for (const role of ["fg", "head", "mute", "cost", "tokens", "live"] as const) {
      expect(contrast(p[role], p.bg)).toBeGreaterThanOrEqual(7);
    }
  });

  test.each([...THEME_CHOICES])(
    "%s: text on a selected row or active tab stays readable",
    (name) => {
      const p = PALETTES[name];
      // Any text can sit on a selected row (dim drawn as mute there); the active tab
      // holds only its name.
      for (const role of TEXT_ROLES) {
        expect({ role, ok: contrast(p[onSel(role)], p.sel) >= 4.5 }).toEqual({ role, ok: true });
      }
      for (const role of ["fg", "head", "cost", "tokens"] as const) {
        expect(contrast(p[role], p.tab)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  test.each([...THEME_CHOICES])(
    "%s: the heat scale gets lighter or darker step by step",
    (name) => {
      const p = PALETTES[name];
      const steps = [p.heat0, p.heat1, p.heat2, p.heat3, p.heat4].map((h) => contrast(h, p.bg));
      for (let i = 1; i < steps.length; i++)
        expect(steps[i] as number).toBeGreaterThan(steps[i - 1] as number);
    },
  );
});

test("level: low below 50 %, mid below 80 %, high from 80 % (gen.py level)", () => {
  expect([0, 0.49, 0.5, 0.79, 0.8, 1.2].map(level)).toEqual([
    "low",
    "low",
    "mid",
    "mid",
    "high",
    "high",
  ]);
});
