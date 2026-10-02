// The "no cut numbers" checker (T11 AC 1, reused by later views): every line fits the
// width, nothing numeric touches a `…`, and each expected number appears whole, never as
// part of a longer one.
import { expect } from "bun:test";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where `text` appears in `frame` with no digit, `.` or `,` right before or after it. */
export function appearsWhole(frame: string, text: string): boolean {
  return new RegExp(`(?<![\\d.,])${escapeRegExp(text)}(?![\\d.,])`).test(frame);
}

export function expectWhole(frame: string, numbers: readonly string[], width: number): void {
  for (const line of frame.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
  expect(frame).not.toMatch(/[\d$%*]…|…[\d$]/);
  const missing = numbers.filter((n) => !appearsWhole(frame, n));
  expect({ missing }).toEqual({ missing: [] });
}
