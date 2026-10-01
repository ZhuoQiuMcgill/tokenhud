import { RGBA } from "@opentui/core";
import type { Theme as ThemeName } from "../config.ts";

/**
 * Colour roles. Every renderable draws with roles, never raw colours, so a theme switch is
 * one prop change. The roles are the prototype's (docs/design/gen.py `P`), plus:
 * - `bg`, the screen behind everything;
 * - `rule`, the faint rule inside tables (the frame's rules use `border`);
 * - `heat0`…`heat4`, the heat map's 5-level scale (gen.py `HEAT`).
 */
export const ROLES = [
  "bg",
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
  "sel",
  "tab",
  "border",
  "rule",
  "empty",
  "heat0",
  "heat1",
  "heat2",
  "heat3",
  "heat4",
] as const;

export type Role = (typeof ROLES)[number];

export type Palette = Readonly<Record<Role, string>>;

/** A palette resolved to OpenTUI colours, ready to draw with. */
export interface Theme {
  readonly name: ThemeName;
  readonly hex: Palette;
  readonly rgba: Readonly<Record<Role, RGBA>>;
}

/** The prototype's palette, as designed. */
const DARK: Palette = {
  bg: "#0e1116",
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
  border: "#2b3440",
  rule: "#232b36",
  empty: "#2c3542",
  heat0: "#1a2029",
  heat1: "#16384f",
  heat2: "#1d5a80",
  heat3: "#2b82b3",
  heat4: "#6cb6ff",
};

/**
 * The dark palette's hues on a light background, darkened until every text role reads at
 * 4.5:1 or better against the background (WCAG AA; checked by test/tui/theme.test.ts).
 */
const LIGHT: Palette = {
  bg: "#fbfcfd",
  fg: "#24292f",
  dim: "#5e6773",
  mute: "#4a5360",
  head: "#0b0f14",
  cost: "#8a5100",
  tokens: "#0757b0",
  low: "#0f61a8",
  mid: "#8a5100",
  high: "#b42b10",
  live: "#05705f",
  sel: "#dde8f5",
  tab: "#d3dfed",
  border: "#b9c3ce",
  rule: "#dfe4ea",
  empty: "#dfe4ea",
  heat0: "#eceff3",
  heat1: "#c6dcf0",
  heat2: "#8cbbe3",
  heat3: "#4a90cf",
  heat4: "#1a5fa8",
};

/** Black background, near-white text, saturated accents: 7:1 or better for main text. */
const HIGH_CONTRAST: Palette = {
  bg: "#000000",
  fg: "#ffffff",
  dim: "#b8b8b8",
  mute: "#dcdcdc",
  head: "#ffffff",
  cost: "#ffc233",
  tokens: "#66ccff",
  low: "#66ccff",
  mid: "#ffc233",
  high: "#ff6e5e",
  live: "#3dffd0",
  sel: "#16365e",
  tab: "#24507f",
  border: "#9a9a9a",
  rule: "#5c5c5c",
  empty: "#4a4a4a",
  heat0: "#262626",
  heat1: "#0b4f7a",
  heat2: "#1580c4",
  heat3: "#3db1ff",
  heat4: "#b0e4ff",
};

export const PALETTES: Readonly<Record<ThemeName, Palette>> = {
  dark: DARK,
  light: LIGHT,
  "high-contrast": HIGH_CONTRAST,
};

const resolved = new Map<ThemeName, Theme>();

export function theme(name: ThemeName): Theme {
  let out = resolved.get(name);
  if (out === undefined) {
    const hex = PALETTES[name];
    const rgba = Object.fromEntries(ROLES.map((r) => [r, RGBA.fromHex(hex[r])])) as Record<
      Role,
      RGBA
    >;
    out = { name, hex, rgba };
    resolved.set(name, out);
  }
  return out;
}

/** gen.py `level`: utilisation below 50 % is low, below 80 % mid, else high. */
export function level(fraction: number): "low" | "mid" | "high" {
  return fraction < 0.5 ? "low" : fraction < 0.8 ? "mid" : "high";
}

export const HEAT_ROLES: readonly Role[] = ["heat0", "heat1", "heat2", "heat3", "heat4"];
