// Rendering helpers for the TUI snapshot tests: render a node headless at a fixed size and
// serialise the frame as characters, or as runs labelled with the theme roles they use.
import { afterEach } from "bun:test";
import { type CapturedFrame, type RGBA, rgbToHex } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import { ROLES, type Theme } from "../../src/tui/theme.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;
let live: Setup[] = [];

/** Registers cleanup of every renderer the test file creates. */
export function cleanupRenderers(): void {
  afterEach(() => {
    for (const setup of live) setup.renderer.destroy();
    live = [];
  });
}

export async function render(node: ReactNode, width: number, height: number): Promise<Setup> {
  const setup = await testRender(node, { width, height });
  live.push(setup);
  await setup.renderOnce();
  return setup;
}

/** Re-renders after state changes made outside React (key presses, controller events). */
export async function settle(setup: Setup, fn?: () => void): Promise<void> {
  await act(async () => fn?.());
  await setup.renderOnce();
}

/** Each line's characters, trailing spaces kept so widths are visible in snapshots. */
export function chars(setup: Setup): string {
  return setup.captureCharFrame();
}

function roleOf(hex: string, t: Theme): string {
  const names = ROLES.filter((r) => t.hex[r] === hex.toLowerCase());
  return names.length > 0 ? names.join("|") : hex;
}

/** `[fg/bg/bold]text` runs with roles in place of colours: what a frame looks like, in words. */
export function roles(frame: CapturedFrame, t: Theme): string {
  return frame.lines
    .map((line) =>
      line.spans
        .map((s) => {
          // Blank cells have no visible foreground.
          const fg = s.text.trim() === "" ? "-" : roleOf(rgbToHex(s.fg as RGBA), t);
          const bg = roleOf(rgbToHex(s.bg as RGBA), t);
          return `[${fg}/${bg}${s.attributes & 1 ? "/b" : ""}]${s.text}`;
        })
        .join(""),
    )
    .join("\n");
}
