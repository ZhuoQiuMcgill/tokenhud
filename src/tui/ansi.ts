// A captured frame as terminal text: truecolour SGR runs, or plain characters. Used by
// `tokenhud --once`, which prints to the normal screen (no alternate screen, no cursor
// movement), so it can be piped, logged or pasted.
import { type CapturedFrame, type RGBA, rgbToHex, TextAttributes } from "@opentui/core";

function sgr(hex: string, ground: 38 | 48): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return `\x1b[${ground};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/**
 * The frame's lines with each run's foreground, its background where it differs from
 * `background` (the theme's, left to the terminal), and bold. Trailing blanks are trimmed.
 */
export function frameToAnsi(frame: CapturedFrame, background: string): string {
  const bg = background.toLowerCase();
  const lines = frame.lines.map((line) => {
    // Drop trailing runs that are blank on the default background.
    const spans = [...line.spans];
    while (spans.length > 0) {
      const last = spans[spans.length - 1] as (typeof spans)[number];
      if (last.text.trim() !== "" || rgbToHex(last.bg as RGBA).toLowerCase() !== bg) break;
      spans.pop();
    }
    let out = "";
    for (const [i, span] of spans.entries()) {
      const spanBg = rgbToHex(span.bg as RGBA).toLowerCase();
      // The last run's own trailing blanks, on the default background, go too.
      const text = i === spans.length - 1 && spanBg === bg ? span.text.trimEnd() : span.text;
      const bold = (span.attributes & TextAttributes.BOLD) !== 0;
      if (text.trim() === "" && spanBg === bg) {
        out += text;
        continue;
      }
      out += `\x1b[0m${bold ? "\x1b[1m" : ""}${sgr(rgbToHex(span.fg as RGBA), 38)}`;
      if (spanBg !== bg) out += sgr(spanBg, 48);
      out += text;
    }
    return out === "" ? "" : `${out}\x1b[0m`;
  });
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** The frame's characters only, trailing spaces trimmed. */
export function frameToText(frame: CapturedFrame): string {
  const lines = frame.lines.map((line) =>
    line.spans
      .map((s) => s.text)
      .join("")
      .trimEnd(),
  );
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
