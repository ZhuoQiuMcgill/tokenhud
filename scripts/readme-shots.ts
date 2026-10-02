// The README's screenshots (T19): every view rendered from a made-up store, framed, with
// coloured numbered boxes on its regions, and the README's legends to match.
//
//   bun run shots                     # docs-public/images/*.png and the legends in README.md
//   CHROME=/path/to/chrome bun run shots
//   SHOTS_KEEP=1 bun run shots        # and keep the HTML and text frames, in a temp dir
//
// Each view is drawn by the TUI's own `Frame`, as the snapshot tests draw it, at 120 × 45
// (the top half of a portrait monitor) in the dark theme. A box's place comes from the
// layout (the view's sections, fitted as the shell fits them) or from anchors in the drawn
// frame (a card's title, a column's divider), never from typed coordinates, so the boxes
// follow the layout when it changes. What each box marks, its number, colour and legend are
// in SHOTS below. A box whose anchor is gone is left out with a warning.
//
// The frames go to HTML (DejaVu Sans Mono embedded: its box and block glyphs are one cell
// wide, unlike the fallbacks a browser picks), which headless Chrome screenshots at device
// scale 2. Under WSL the Windows Chrome is used. Not part of `bun test`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { type CapturedFrame, type RGBA, rgbToHex, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { createElement } from "react";
import { isWsl } from "../src/sources/roots.ts";
import { Frame, viewLayout } from "../src/tui/app.tsx";
import { Controller, initialState, type Ports } from "../src/tui/controller.ts";
import { theme } from "../src/tui/theme.ts";
import type { AccountInfo, ViewModels } from "../src/tui/vm/types.ts";
import { MCP, makeShotsFixture, type ShotsFixture, TZ } from "./readme-shots-fixture.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "docs-public", "images");
const README = join(ROOT, "README.md");
/** The README links images by this path. */
const IMAGE_URL = "docs-public/images";
const WIDTH = 120;
const HEIGHT = 45;
const FONTS = "/usr/share/fonts/truetype/dejavu";
/** DejaVu Sans Mono's advance, 1233 of 2048 units per em. */
const ADVANCE = 1233 / 2048;
/** Rows this tall keep box-drawing rows joined. */
const LINE_HEIGHT = 1.17;
const SCALE = 2;
const MAX_BYTES = 400 * 1024;

// ── the annotation colours ───────────────────────────────────────────────────────────

/**
 * The README's markers are these emoji squares, so the boxes take their hues: saturated,
 * apart from the TUI's own muted palette, and readable on GitHub's light and dark pages.
 */
const COLOURS = [
  { emoji: "🟥", hex: "#ff4d4f", ink: "#ffffff" },
  { emoji: "🟧", hex: "#ff8f1f", ink: "#1b1300" },
  { emoji: "🟨", hex: "#ffd60a", ink: "#1b1600" },
  { emoji: "🟩", hex: "#40c057", ink: "#03140a" },
  { emoji: "🟦", hex: "#4c6ef5", ink: "#ffffff" },
  { emoji: "🟪", hex: "#c95ff0", ink: "#ffffff" },
  { emoji: "🟫", hex: "#b0713f", ink: "#ffffff" },
] as const;

// ── a drawn frame, and where things are in it ────────────────────────────────────────

/** Cells: x and w in columns, y and h in rows. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Cell {
  readonly ch: string;
  readonly fg: string;
  readonly bg: string;
  readonly bold: boolean;
}

/** One rendered view: its cells, and the rectangles of its layout's sections. */
class Screen {
  readonly cells: Cell[][];
  readonly lines: string[];
  readonly sections: ReadonlyMap<string, Rect>;
  readonly #bg: string;

  constructor(frame: CapturedFrame, sections: ReadonlyMap<string, Rect>, bg: string) {
    this.#bg = bg;
    this.sections = sections;
    this.cells = frame.lines.map((line, y) => {
      const row: Cell[] = [];
      for (const span of line.spans) {
        const fg = rgbToHex(span.fg as RGBA).toLowerCase();
        const back = rgbToHex(span.bg as RGBA).toLowerCase();
        const bold = (span.attributes & TextAttributes.BOLD) !== 0;
        for (const ch of span.text) {
          // One cell, one UTF-16 unit: then a row's string indexes are its columns.
          if (Bun.stringWidth(ch) > 1 || ch.length > 1)
            throw new Error(`row ${y}: "${ch}" is wide`);
          row.push({ ch, fg, bg: back, bold });
        }
      }
      if (row.length !== frame.cols) throw new Error(`row ${y} has ${row.length} cells`);
      return row;
    });
    this.lines = this.cells.map((row) => row.map((c) => c.ch).join(""));
  }

  get all(): Rect {
    return { x: 0, y: 0, w: this.lines[0]?.length ?? 0, h: this.lines.length };
  }

  header(): Rect {
    return { x: 0, y: 0, w: this.all.w, h: 1 };
  }

  /** Under the frame's last rule: one line, or two from 30 rows. */
  footer(): Rect {
    const rule = this.lines.findLastIndex((l) => /^─+$/.test(l));
    return { x: 0, y: rule + 1, w: this.all.w, h: this.all.h - rule - 1 };
  }

  section(id: string): Rect | null {
    return this.sections.get(id) ?? null;
  }

  #ink(x: number, y: number): boolean {
    const c = this.cells[y]?.[x];
    return c !== undefined && (c.ch.trim() !== "" || c.bg !== this.#bg);
  }

  /** The smallest rectangle in `r` holding every cell drawn there; null when none is. */
  tight(r: Rect | null): Rect | null {
    if (r === null) return null;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = -1;
    let y1 = -1;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (!this.#ink(x, y)) continue;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** Where `re` first matches inside `r`, row by row: one row, as wide as the match. */
  find(re: RegExp, r: Rect | null = this.all): Rect | null {
    if (r === null) return null;
    for (let y = r.y; y < r.y + r.h; y++) {
      const text = (this.lines[y] ?? "").slice(r.x, r.x + r.w);
      const m = re.exec(text);
      if (m !== null && m[0].length > 0) return { x: r.x + m.index, y, w: m[0].length, h: 1 };
    }
    return null;
  }

  /** `r`'s rows from the first matching `from` to the next matching `to`, both included. */
  rows(r: Rect | null, from: RegExp, to: RegExp = from): Rect | null {
    const start = this.find(from, r);
    if (r === null || start === null) return null;
    const rest = { ...r, y: start.y, h: r.y + r.h - start.y };
    const end = this.find(to, rest);
    if (end === null) return null;
    return { x: r.x, y: start.y, w: r.w, h: end.y - start.y + 1 };
  }

  /** `r`'s rows from the first matching `re` through those right under it that match too. */
  run(r: Rect | null, re: RegExp): Rect | null {
    const start = this.find(re, r);
    if (r === null || start === null) return null;
    let end = start.y;
    while (end + 1 < r.y + r.h && re.test((this.lines[end + 1] ?? "").slice(r.x, r.x + r.w))) end++;
    return { x: r.x, y: start.y, w: r.w, h: end - start.y + 1 };
  }

  /** The rounded box (`╭─ title ─╮` … `╰─╯`) whose top border matches `title`, inside `r`. */
  box(title: RegExp, r: Rect | null = this.all): Rect | null {
    if (r === null) return null;
    for (let y = r.y; y < r.y + r.h; y++) {
      const line = this.lines[y] ?? "";
      for (let x = line.indexOf("╭", r.x); x >= 0 && x < r.x + r.w; x = line.indexOf("╭", x + 1)) {
        const right = line.indexOf("╮", x);
        if (right < 0 || !title.test(line.slice(x, right + 1))) continue;
        let bottom = y + 1;
        while (bottom < this.lines.length && this.lines[bottom]?.[x] === "│") bottom++;
        if (this.lines[bottom]?.[x] !== "╰") continue;
        return { x, y, w: right - x + 1, h: bottom - y + 1 };
      }
    }
    return null;
  }

  /** `r` from column `from` (absolute) to column `to` (excluded). */
  static cols(r: Rect | null, from: number, to: number): Rect | null {
    if (r === null) return null;
    const x0 = Math.max(r.x, from);
    const x1 = Math.min(r.x + r.w, to);
    return x1 > x0 ? { x: x0, y: r.y, w: x1 - x0, h: r.h } : null;
  }

  /** `r` without its first `top` and last `bottom` rows. */
  static inset(r: Rect | null, top: number, bottom = 0): Rect | null {
    if (r === null || r.h - top - bottom <= 0) return null;
    return { x: r.x, y: r.y + top, w: r.w, h: r.h - top - bottom };
  }

  /** The smallest rectangle holding all of `rects`; null when one is missing. */
  static union(...rects: (Rect | null)[]): Rect | null {
    return rects.includes(null) ? null : Screen.span(...rects);
  }

  /** The smallest rectangle holding those of `rects` that were found. */
  static span(...rects: (Rect | null)[]): Rect | null {
    const some = rects.filter((r): r is Rect => r !== null);
    if (some.length === 0) return null;
    const x = Math.min(...some.map((r) => r.x));
    const y = Math.min(...some.map((r) => r.y));
    const w = Math.max(...some.map((r) => r.x + r.w)) - x;
    const h = Math.max(...some.map((r) => r.y + r.h)) - y;
    return { x, y, w, h };
  }
}

// ── what the screenshots show ───────────────────────────────────────────────────────

type Locate = (s: Screen) => Rect | null;

interface Note {
  /** The layout section it marks ("header" and "footer" are the frame's). */
  readonly section: string;
  readonly locate: Locate;
  /** The legend entry: a name, then what it shows (markdown). */
  readonly name: string;
  readonly text: string;
  /** Where its badge goes, when the best place isn't found by itself. */
  readonly badge?: Spot;
  /**
   * Marked by its badge alone, without a box: a one-line header with text right above and
   * under it leaves no line spacing for a border that wouldn't cross its text.
   */
  readonly bare?: true;
}

interface Shot {
  /** The image's file name, and the README block (`<!-- shots:<block> -->`) it goes in. */
  readonly file: string;
  readonly block: string | null;
  readonly alt: string;
  /** Keys pressed before the frame is drawn, as the TUI names them. */
  readonly keys: readonly string[];
  /** Only this part of the frame, larger: a close-up. */
  readonly crop?: Locate;
  readonly font: number;
  readonly notes: readonly Note[];
}

const tight = (s: Screen, id: string) => s.tight(s.section(id));
/** The column where a section's first-row `anchor` starts. */
const at = (s: Screen, id: string, anchor: RegExp) => s.find(anchor, s.section(id))?.x ?? null;
/** The Accounts view's detail column: right of the list's ` │ ` divider. */
function detail(s: Screen): Rect | null {
  const x = at(s, "accounts", / │ /);
  return x === null ? null : Screen.cols(s.section("accounts"), x + 3, WIDTH);
}
const card = (s: Screen, title: RegExp) => s.box(title, s.section("limits"));
/** A card's inside: between its borders. */
function inside(r: Rect | null): Rect | null {
  return r === null ? null : { x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 };
}
/** Both meter rows of a card: the part of each matching `re`. */
const meters = (s: Screen, title: RegExp, re: RegExp) => {
  const r = inside(card(s, title));
  return Screen.union(s.find(re, r), s.find(re, Screen.inset(r, 1)));
};

/**
 * The screenshots, in the order they are made: what each shows and, for each box, where it
 * is and what its legend says. A box's number is its place in `notes`, and its colour
 * `COLOURS` at that place. Readings quoted in `code` with a digit in them are checked
 * against the frame, so a legend that falls out of date says so; a form rather than a
 * reading (`at 100% until …`) has a `…` in it.
 */
const SHOTS: readonly Shot[] = [
  {
    file: "hero.png",
    block: null,
    alt: "tokenhud's Overview on made-up accounts: a limits card per account, spend from the last hour to all time, a 24-hour cost chart, the top models and the week's limit events",
    keys: [],
    font: 13,
    notes: [],
  },
  {
    file: "overview.png",
    block: "overview",
    alt: "The Overview with seven numbered boxes: header, limits cards, MCP agents, spend, activity chart, top models, limit events",
    keys: [],
    font: 13,
    notes: [
      {
        section: "header",
        locate: (s) => s.tight(s.header()),
        name: "Header",
        text: "The four views, the one you are on highlighted. On the right, the account scope: `all accounts`, or the one account that every number in every view is narrowed to. Then the status dot. `● live · 5s` (teal): this tokenhud reads new transcript lines as Claude Code and Codex write them, and refreshes its clock-driven numbers every 5 seconds (the refresh interval setting). `● stale` (amber): it isn't reading transcripts itself, because another tokenhud is (this one shows what that one stores), or it is still starting, or reading failed. `● error` (red): the numbers have stopped updating while tokenhud restarts the part that computes them.",
      },
      {
        section: "limits",
        locate: (s) => tight(s, "limits"),
        name: "Limits",
        text: "A card per account, Claude Code and Codex alike: its 5-hour and weekly subscription limits, and what its current spending means for them. The note on the right is a reminder that pace is measured over the last 30 minutes and that every time on a card is an estimate. [Reading a limits card](#reading-a-limits-card) explains each reading.",
      },
      {
        section: "limits",
        locate: (s) => card(s, /agents · MCP/),
        name: "Agents",
        text: "Shown while tokenhud's MCP server runs for a Claude Code session (see [Use with Claude Code](#use-with-claude-code)). One line per agent session that called a tool in the last 10 minutes: the account the call was about, the tool, and how long ago. With no recent calls, it says how many servers are running.",
      },
      {
        section: "spend",
        locate: (s) => tight(s, "spend"),
        name: "Spend",
        text: "What your usage would cost at the providers' API prices (not what your subscription costs), and its tokens: input, output, cache reads and cache writes together. `1h` and `5h` are the last 60 minutes and the last 5 hours (shown on screens 120 columns wide or more). `today`, `this week` and `this month` start at local midnight, on Monday and on the 1st. `all-time` is everything tokenhud has stored, including usage whose transcripts are gone. For `*` and `≈`, see [Glyphs and colours](#glyphs-and-colours).",
      },
      {
        section: "activity",
        locate: (s) => {
          const split = at(s, "activity", /TOP MODELS/);
          return split === null ? null : s.tight(Screen.cols(s.section("activity"), 0, split - 1));
        },
        name: "Activity",
        text: "Cost over the last 24 hours, one bar per time slot. The tabs on the right switch to the last 5 hours or 7 days (`a`/`d`; the one shown is in brackets), and `t` switches to tokens. The title gives the slot's length, which grows until the chart fits the width: 30 minutes here. On the left, the tallest slot's cost, half of it, and zero; below, hours back from now.",
      },
      {
        section: "activity",
        locate: (s) => {
          const split = at(s, "activity", /TOP MODELS/);
          return split === null
            ? null
            : s.tight(Screen.cols(s.section("activity"), split - 1, WIDTH));
        },
        name: "Top models",
        text: "The five models with the most cost in the last 24 hours: the cost, its share of the 24 hours' cost, and a bar of that share. A fast or priority tier gets its own row, marked `(fast)`. A model with no published price shows `unpriced` and comes last. Under the list, the chart's tallest slot and when it started.",
      },
      {
        section: "events",
        locate: (s) => tight(s, "events"),
        name: "Limit events",
        text: "Limits hit in the last 7 days: day and time, account, and what happened. `5-hour limit reached` (red) is a window that reached 100 %; `weekly passed 80%` (amber) is a weekly window crossing 80 %. After a reached limit, `resumed 16:05` is when tokenhud first saw the window usable again after its reset; `resets` and a time, when a window that is still full will reset; `—`, that no fetch has seen it since. Limits reached come first, newest first, then the 80 % marks. Up to 8 lines; the rest are counted on the last one.",
      },
    ],
  },
  {
    file: "overview-card.png",
    block: "overview-card",
    alt: "Close-up of four limits cards, with the account, meters, percentages and countdowns, pace, verdict, stale age and a not-signed-in account boxed and numbered",
    keys: [],
    crop: (s) =>
      Screen.union(
        card(s, /work · claude/),
        card(s, /old-laptop · claude/),
        card(s, /lab · claude/),
        card(s, /codex-main · codex/),
      ),
    font: 19,
    notes: [
      {
        section: "limits",
        locate: (s) => s.find(/work · claude/, card(s, /work · claude/)),
        badge: "tl",
        name: "Account",
        text: "The account's label and its provider, `claude` or `codex`. The label comes from the account's config directory (`~/.claude-work` is `work`) unless you renamed it.",
      },
      {
        section: "limits",
        locate: (s) => meters(s, /work · claude/, /^\S+\s+━+/),
        badge: "l",
        name: "Meters",
        text: "The `5h` row is the 5-hour window, the `week` row the weekly one. Each bar is how much of that limit is used: blue below 50 %, amber from 50 %, red-orange from 80 %. A model's own weekly limit isn't on the card; the Accounts view lists it.",
      },
      {
        section: "limits",
        locate: (s) => meters(s, /work · claude/, /\d+%\s+\S+/),
        badge: "tr",
        name: "Used, and time to reset",
        text: "`84%` is the share of the 5-hour limit used, as the provider reported it the last time tokenhud fetched the limits; `1h52m` is the time left until that window resets. On the weekly row, `41%` used and `5d21h` (5 days 21 hours) to go. Once a window has reset, the card reads 0 % and `—` until the next fetch.",
      },
      {
        section: "limits",
        locate: (s) => s.find(/pace \S+/, card(s, /work · claude/)),
        badge: "bl",
        name: "Pace",
        text: "What this account spent in the last 30 minutes at API prices, as dollars per hour (tokens per hour with costs hidden). `$0/h`: nothing in the last 30 minutes.",
      },
      {
        section: "limits",
        locate: (s) => s.find(/→ .*\S/, card(s, /work · claude/)),
        badge: "br",
        name: "Verdict",
        text: "What that pace means for the two windows: an estimate (see [How the projection works](#how-the-projection-works)). The first of these that applies: `at 100% until …`, a window is full now, until the last full one resets; `hits 100% at 12:13`, the time the first window fills at this pace (with the day when it isn't today); `idle`, nothing spent in 30 minutes; `week ends ~89%`, the weekly window is on course to end its week at 80 % or more; `safe until reset`, both windows last until they reset; `no estimate yet`, too little spending in a window to tell. Red means a window is or will be full, amber a high week.",
      },
      {
        section: "limits",
        locate: (s) => s.find(/\(\S+ old\)/, card(s, /lab · claude/)),
        badge: "r",
        name: "Stale limits",
        text: "The limits were fetched more than 15 minutes ago: `(52m old)` says how long ago, and the card shows them as they were then.",
      },
      {
        section: "limits",
        locate: (s) => s.find(/not signed in here/, card(s, /old-laptop · claude/)),
        badge: "r",
        name: "Not signed in here",
        text: "A history-only account: one you marked history only, or one that isn't signed in on this machine (it runs on another computer now, say). Its limits can't be read here, so it has no meters, but its usage history stays. See [Accounts](#accounts).",
      },
    ],
  },
  {
    file: "history.png",
    block: "history",
    alt: "The History view with six numbered boxes: tabs, heat map, day card, period table, totals, footer",
    // The days tab (History opens on this week), on the day before today, which reached a
    // limit.
    keys: ["2", "d", "d", "s"],
    font: 13,
    notes: [
      {
        section: "tabs",
        locate: (s) => tight(s, "tabs"),
        // The strip sits right on the heat map, with text under it: a badge, no box.
        bare: true,
        badge: "l",
        name: "Tabs",
        text: "What the table lists, switched with `a`/`d`; the one shown is in brackets. `this week` and `this month` list the days so far of the current week or month (History opens on this week), `days` every day of the heat map, `weeks` (Monday to Sunday) and `months` one row each. On the right, what `*` and `≈` mean, and `f`, the model filter: with a filter, every number on the screen counts only the models whose id contains what you typed.",
      },
      {
        section: "heat",
        locate: (s) => {
          const split = s.box(/./, s.section("heat"))?.x ?? WIDTH;
          return s.tight(Screen.cols(s.section("heat"), 0, split));
        },
        name: "Heat map",
        text: "One square per day for the last 26 weeks: a column per week, Monday at the top. The shade is the day's cost against the busiest day shown: the darkest square is a day without usage, and the four lighter shades are under a quarter of the busiest day, under a half, under three quarters, and the rest. The table's selected row is white: here a day; on the weeks or months tab, that week's or month's days. Days after today are blank.",
      },
      {
        section: "heat",
        locate: (s) => s.box(/./, s.section("heat")),
        name: "Day card",
        text: "The selected day. `cost`, and how it compares with your usual day: `2.4×` is the day's cost divided by your average daily cost over the 30 days before today (or fewer, if your usage started more recently). `tokens`, split into input, output and cache (reads and writes). `models`: its three most expensive models, with their share of the day's cost. `accounts`: each account's cost that day. `limits`: the day's limit events. `hit 100% at 14:10 (waited 1h55m)` is a window that reached its limit, and how long it was until tokenhud saw it usable again; a weekly window crossing 80 % reads passed 80%.",
      },
      {
        section: "table",
        locate: (s) => s.tight(Screen.inset(s.section("table"), 0, 2)),
        name: "Period table",
        text: "The rows of the tab shown, newest first, moved through with `w`/`s`. On the weeks or months tab, `enter` lists a row's days and `esc` goes back; on a day with limit events, `enter` lists them. `input`, `output` and `cache` (reads and writes) are tokens; `cost` is at API prices. `vs 30-day avg` compares the period with your average day times the period's days so far: the bar is full at 2.25 times, 1 times is a little under half of it, and it turns red-orange above 1.5 times; the ratio follows it. `top model` is the period's most expensive model, `accounts` those with usage, most cost first.",
      },
      {
        section: "table",
        locate: (s) => {
          const r = s.section("table");
          return r === null ? null : s.tight({ ...r, y: r.y + r.h - 1, h: 1 });
        },
        name: "Totals",
        text: "Every period listed, added up: here the `177 days` of the heat map's 26 weeks, today included.",
      },
      {
        section: "footer",
        locate: (s) => s.tight(s.footer()),
        name: "Footer",
        text: "Its first line is the keys of the view you are on: `a/d` its tabs, `w/s` the selection, `enter` to open it, then the view's own; `esc back` joins them while there is something to go back from. Its second line is the keys every view has (all of them are in [Keys](#keys)). On the right, `MCP ● 2 agents`: tokenhud's MCP server is running (teal dot) and two agent sessions called it in the last 10 minutes; `MCP ○` means no server is running. A newer release, or another tokenhud reading the transcripts, is noted here too.",
      },
    ],
  },
  {
    file: "models.png",
    block: "models",
    alt: "The Models view with five numbered boxes: rate board, total, footnotes, rates card, who used it",
    keys: ["3"],
    font: 13,
    notes: [
      {
        section: "models",
        locate: (s) => s.tight(Screen.inset(s.section("models"), 0, 2)),
        name: "Rate board",
        text: "Every model used in the window, by cost (`r` sorts by tokens, then by name). The tabs on the right are the windows, switched with `a`/`d`; the one shown is in brackets. Today, this week, this month and all time are calendar periods, and 1h, 5h and 24h the last hours. One row per model and tier; a fast or priority tier is its own row, `(fast)`. For input, output and cache (reads and writes): the tokens used, and the `$/M` rate they are billed at today, in dollars per million tokens (`—`: no price). `cost` prices each request at the rate in effect on its date, so it can differ from tokens times today's rate. The bar and the percentage are the model's share of the window's cost. `*` after a name: some or all of its tokens have no published rate, so they are counted but not priced. The selected row (`w`/`s`) is highlighted, and `enter` shows or hides its cards below.",
      },
      {
        section: "models",
        locate: (s) => {
          const r = s.section("models");
          return r === null ? null : s.tight({ ...r, y: r.y + r.h - 1, h: 1 });
        },
        name: "Total",
        text: "All models together. Rates don't add up, so the total has none.",
      },
      {
        section: "notes",
        locate: (s) => tight(s, "notes"),
        name: "Footnotes",
        text: "`$/M` is the base rate; cache writes, and requests over a model's long-context threshold, cost more. Then the share of the window's tokens that have a price, and which costs are estimates: `codex-auto-review` is priced as the model OpenAI said serves it.",
      },
      {
        section: "cards",
        locate: (s) => s.box(/· rates/, s.section("cards")),
        name: "Rates",
        text: "The selected model's prices today, per million tokens: input and output; cache reads, and what fraction of the input rate they are; cache writes, for 5 minutes and for 1 hour (Anthropic) or one rate (OpenAI); the fast tier's prices; the long-context threshold and its multipliers, for models that have one; where the prices come from and when they were last checked; and any price change inside the window.",
      },
      {
        section: "cards",
        locate: (s) => s.box(/who used it/, s.section("cards")),
        name: "Who used it",
        text: "Each account's share of the selected model's cost in the window, and that cost. Then the day the model was first used, and how many requests the window holds.",
      },
    ],
  },
  {
    file: "accounts.png",
    block: "accounts",
    alt: "The Accounts view with six numbered boxes: account list, selected account, where it comes from, limits, weekly history, last 30 days",
    // The Overview's first card, opened in Accounts.
    keys: ["return"],
    font: 13,
    notes: [
      {
        section: "accounts",
        locate: (s) => {
          const x = at(s, "accounts", / │ /);
          return x === null ? null : s.tight(Screen.cols(s.section("accounts"), 0, x + 1));
        },
        name: "Accounts",
        text: "Every account tokenhud has usage for: those active on this machine first, then by all-time cost. The dot and the percentage show the account's most-used limit among its windows that haven't reset yet: blue below 50 %, amber from 50 %, red-orange from 80 %. `○` and a grey label: inactive here (history only, not signed in, turned off, or its config directory isn't on this machine). `+ add a root…` opens the account settings. Under the list, the keys: `w`/`s` select an account, and `enter` opens its menu: show only this account, enable or disable it, rename it, history only, and linking it to another directory on the same subscription account.",
      },
      {
        section: "accounts",
        locate: (s) => s.tight(s.rows(detail(s), /\S/)),
        name: "Account",
        text: "The selected account, its provider, and when its limits were last fetched.",
      },
      {
        section: "accounts",
        locate: (s) => s.tight(s.rows(detail(s), /^ root /, /^ history /)),
        name: "Where it comes from",
        text: "`root` is the config directory its transcripts are read from, and how: `watched` (read as they are written), `polled` (checked at intervals, for a Windows drive under WSL) or `disabled`. `history`: how many requests tokenhud has stored for it, and the day of the first.",
      },
      {
        section: "accounts",
        locate: (s) => s.tight(s.run(detail(s), /resets? |reset .* ago|failed/)),
        name: "Limits",
        text: "Every limit window of the account: 5-hour, weekly, then any of a model's own. The bar and the percentage are how much is used (colours as on the cards), then when the window resets: a time today, a weekday and a time within a week, else a date. A window that has reset since the last fetch shows an empty bar, `—`, and how long ago it reset. A failed fetch is noted under the meters.",
      },
      {
        section: "accounts",
        locate: (s) => s.tight(s.rows(detail(s), /weekly usage/, /recorded|known|captured/)),
        name: "Weekly history",
        text: "The weekly window over the last 8 weeks, on a 0–100 % scale, each week labelled with the day it reset. The last bar (grey) is this week so far. Earlier weeks are known only from limit events: `100%` for a week that reached its limit, `≥80%` for one that passed 80 %, `—` for no record: under 80 %, or not seen by tokenhud.",
      },
      {
        section: "accounts",
        locate: (s) =>
          s.tight(
            Screen.span(
              s.rows(detail(s), /^ (spend|tokens) 30d /),
              s.rows(detail(s), /^ models /),
              s.rows(detail(s), /^ agents /),
            ),
          ),
        name: "Last 30 days",
        text: "`spend 30d`: one bar per day for the last 30 days, today last, each against the busiest of them; then their total cost. `models`: the account's models over those 30 days, by share of cost. `agents`: its latest MCP tool call in the last 10 minutes, and how many calls it made.",
      },
    ],
  },
];

// ── rendering a view ────────────────────────────────────────────────────────────────

const PORTS: Ports = {
  saveConfig: () => {},
  vmSettings: () => {},
  vmConfig: () => {},
  vmRoots: () => {},
  accountsEdited: () => {},
  quit: () => {},
};

/** The frame after `keys`, with its sections placed as the shell's body places them. */
async function render(
  fx: ShotsFixture,
  data: { views: ViewModels; accounts: AccountInfo[] },
  keys: readonly string[],
): Promise<Screen> {
  const c = new Controller(initialState(fx.config, "owner"), PORTS, TZ);
  c.vmMessage({ type: "views", views: data.views, accounts: data.accounts, scope: null, ms: 0 });
  c.vmMessage({ type: "mcp", activity: MCP });
  c.setIngest("live");
  for (const k of keys) c.key({ name: k, sequence: k.length === 1 ? k : "", ctrl: false });
  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const root = createRoot(setup.renderer);
  let frame: CapturedFrame;
  try {
    flushSync(() =>
      root.render(createElement(Frame, { controller: c, width: WIDTH, height: HEIGHT })),
    );
    await setup.renderOnce();
    frame = setup.captureSpans();
  } finally {
    flushSync(() => root.unmount());
    setup.renderer.destroy();
  }
  const state = c.getState();
  const t = theme(state.config.theme);
  // The body starts under the frame's first rule, its first line for notices; its sections
  // are where the shell's own layout puts them, gaps and all.
  const text = frame.lines.map((l) => l.spans.map((s) => s.text).join(""));
  const top = text.indexOf("─".repeat(WIDTH));
  if (top < 0) throw new Error("the frame has no rule");
  const layout = viewLayout(
    state.view,
    state.views[state.view],
    state.viewState[state.view],
    state.config,
    state.scope,
    WIDTH,
    HEIGHT,
    TZ,
  );
  const sections = new Map<string, Rect>(
    layout.placed.map((p) => [p.id, { x: 0, y: top + 2 + p.top, w: WIDTH, h: p.height }]),
  );
  return new Screen(frame, sections, t.hex.bg);
}

// ── HTML ────────────────────────────────────────────────────────────────────────────

/** A box to draw: its number (and colour), and its cells relative to what is shown. */
interface Placed {
  readonly n: number;
  readonly rect: Rect;
  readonly spot?: Spot;
  /** A badge with no box (`Note.bare`). */
  readonly bare?: true;
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function fontFace(file: string, weight: number): string {
  const path = join(FONTS, file);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing: install DejaVu Sans Mono (fonts-dejavu-core)`);
  }
  const data = readFileSync(path).toString("base64");
  return `@font-face{font-family:"T";font-weight:${weight};src:url(data:font/ttf;base64,${data}) format("truetype")}`;
}

/** Pixels from the top left of the cells shown. */
interface Px {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const contains = (a: Rect, b: Rect) =>
  b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
const overlap = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/**
 * Each box's outer edges: a few pixels outside its cells, more for a box holding others so
 * both show; and, facing a neighbour, no further than halfway to it, so two boxes never
 * touch (on adjacent rows the borders go inside them, where the line spacing is).
 */
function boxEdges(
  screen: Screen,
  view: Rect,
  boxes: readonly Placed[],
  cw: number,
  ch: number,
  font: number,
): Px[] {
  const base = font * 0.3;
  /** Text in row `y` (of what is shown) over the columns of `r`: a border can't go there. */
  const text = (y: number, r: Rect) =>
    y >= 0 &&
    y < view.h &&
    (screen.lines[view.y + y] ?? "")
      .slice(view.x + r.x, view.x + r.x + r.w)
      .split("")
      .some((c) => c.trim() !== "" && !LINEWORK.test(c));
  const px = boxes.map(({ rect: r }) => ({
    left: r.x * cw,
    top: r.y * ch,
    right: (r.x + r.w) * cw,
    bottom: (r.y + r.h) * ch,
  }));
  const out = boxes.map(({ rect }) => {
    const holds = boxes.filter((b) => b.rect !== rect && contains(rect, b.rect)).length;
    const o = base + holds * font * 0.4;
    // Text right above or under it: the border goes in the box's own line spacing instead.
    return {
      left: o,
      top: text(rect.y - 1, rect) ? -0.5 : o,
      right: o,
      bottom: text(rect.y + rect.h, rect) ? -0.5 : o,
    };
  });
  const gap = 2;
  boxes.forEach((a, i) => {
    boxes.forEach((b, j) => {
      if (i === j || a.bare || b.bare || contains(a.rect, b.rect) || contains(b.rect, a.rect)) {
        return;
      }
      const p = px[i] as Px;
      const q = px[j] as Px;
      const oa = out[i] as Px;
      if (overlap(p.top, p.bottom, q.top, q.bottom) && p.right <= q.left) {
        oa.right = Math.min(oa.right, (q.left - p.right - gap) / 2);
      }
      if (overlap(p.top, p.bottom, q.top, q.bottom) && q.right <= p.left) {
        oa.left = Math.min(oa.left, (p.left - q.right - gap) / 2);
      }
      if (overlap(p.left, p.right, q.left, q.right) && p.bottom <= q.top) {
        oa.bottom = Math.min(oa.bottom, (q.top - p.bottom - gap) / 2);
      }
      if (overlap(p.left, p.right, q.left, q.right) && q.bottom <= p.top) {
        oa.top = Math.min(oa.top, (p.top - q.bottom - gap) / 2);
      }
    });
  });
  return px.map((p, i) => {
    const o = out[i] as Px;
    return {
      left: p.left - o.left,
      top: p.top - o.top,
      right: p.right + o.right,
      bottom: p.bottom + o.bottom,
    };
  });
}

/** The lower block elements, one to eight eighths of a cell high. */
const BLOCKS = "▁▂▃▄▅▆▇█";

/** Box-drawing, block and bar glyphs: covering a little of them hides no reading. */
const LINEWORK = /[─-▟■]/;

/** Where a badge sits: just outside a corner of its box, or beside its left or right side. */
type Spot = "tl" | "tr" | "l" | "r" | "bl" | "br";
const SPOTS: readonly Spot[] = ["tl", "tr", "l", "r", "bl", "br"];

/**
 * Where each badge goes: its note's spot if it names one, else the spot that covers the
 * least text, other boxes and badges, top left when that is as good as any.
 */
function badgeCentres(
  screen: Screen,
  view: Rect,
  edges: readonly Px[],
  spots: readonly (Spot | undefined)[],
  size: number,
  bounds: Px,
  cw: number,
  ch: number,
): { x: number; y: number }[] {
  const r = size / 2;
  const off = size * 0.35;
  const placed: { x: number; y: number }[] = [];
  const centre = (e: Px, spot: Spot) => {
    const mid = (e.top + e.bottom) / 2;
    switch (spot) {
      case "tl":
        return { x: e.left - off, y: e.top - off };
      case "tr":
        return { x: e.right + off, y: e.top - off };
      case "l":
        return { x: e.left - r - 2, y: mid };
      case "r":
        return { x: e.right + r + 2, y: mid };
      case "bl":
        return { x: e.left - off, y: e.bottom + off };
      case "br":
        return { x: e.right + off, y: e.bottom + off };
    }
  };
  const cost = (x: number, y: number, own: number) => {
    let score = 0;
    if (
      x - r < bounds.left ||
      y - r < bounds.top ||
      x + r > bounds.right ||
      y + r > bounds.bottom
    ) {
      score += 1000;
    }
    for (const p of placed) if (Math.hypot(p.x - x, p.y - y) < size + 3) score += 1000;
    // Over another box: by how much of the badge, so grazing its border costs little.
    edges.forEach((e, i) => {
      if (i === own) return;
      const w = Math.min(x + r, e.right) - Math.max(x - r, e.left);
      const h = Math.min(y + r, e.bottom) - Math.max(y - r, e.top);
      if (w > 0 && h > 0) score += (40 * w * h) / (size * size);
    });
    const inset = r * 0.3;
    for (let cy = Math.floor((y - r + inset) / ch); cy <= Math.floor((y + r - inset) / ch); cy++) {
      for (
        let cx = Math.floor((x - r + inset) / cw);
        cx <= Math.floor((x + r - inset) / cw);
        cx++
      ) {
        if (cx < 0 || cy < 0 || cx >= view.w || cy >= view.h) continue;
        const c = screen.cells[view.y + cy]?.[view.x + cx]?.ch ?? " ";
        if (c.trim() !== "") score += LINEWORK.test(c) ? 2 : 10;
      }
    }
    return score;
  };
  edges.forEach((e, i) => {
    const wanted = spots[i];
    let best = centre(e, wanted ?? "tl");
    if (wanted === undefined) {
      let bestCost = Number.POSITIVE_INFINITY;
      SPOTS.forEach((spot, k) => {
        const c = centre(e, spot);
        const s = cost(c.x, c.y, i) + 3 * k;
        if (s < bestCost) {
          best = c;
          bestCost = s;
        }
      });
    }
    placed.push(best);
  });
  return placed;
}

/** The page for `view` (cells), at `font` px, with `boxes`; and its size in CSS px. */
function page(
  screen: Screen,
  view: Rect,
  font: number,
  boxes: readonly Placed[],
  faces: string,
  bg: string,
): { html: string; width: number; height: number } {
  const cw = font * ADVANCE;
  // Whole device pixels, so rows of block glyphs join without a seam.
  const ch = Math.floor(font * LINE_HEIGHT * SCALE) / SCALE;
  // Room for the badges, and a neutral frame around the terminal.
  const pad = Math.round(font * 1.3);
  const margin = Math.round(font * 1.4);
  const termW = Math.ceil(view.w * cw) + 2 * pad;
  const termH = Math.ceil(view.h * ch) + 2 * pad;
  const width = termW + 2 * margin;
  const height = termH + 2 * margin;
  const runs: string[] = [];
  for (let y = view.y; y < view.y + view.h; y++) {
    const row = screen.cells[y] ?? [];
    let x = view.x;
    while (x < view.x + view.w) {
      const first = row[x] as Cell;
      let end = x + 1;
      while (end < view.x + view.w) {
        const c = row[end] as Cell;
        if (c.fg !== first.fg || c.bg !== first.bg || c.bold !== first.bold) break;
        end++;
      }
      const left = (at: number) => ((at - view.x) * cw).toFixed(3);
      const top = (y - view.y) * ch;
      const across = (from: number, to: number) =>
        `left:${left(from)}px;width:${((to - from) * cw).toFixed(3)}px`;
      if (first.bg !== bg) {
        runs.push(
          `<i style="${across(x, end)};top:${top}px;height:${ch}px;background:${first.bg}"></i>`,
        );
      }
      // Text as text; block elements (bars, charts) as rectangles, a run of them as one, so
      // neighbouring cells join without the seams anti-aliased glyph edges leave.
      for (let at = x; at < end; ) {
        const c = (row[at] as Cell).ch;
        const eighths = BLOCKS.indexOf(c) + 1;
        let to = at + 1;
        if (eighths > 0) {
          while (to < end && (row[to] as Cell).ch === c) to++;
          const h = (ch * eighths) / 8;
          runs.push(
            `<i style="${across(at, to)};top:${top + ch - h}px;height:${h}px;background:${first.fg}"></i>`,
          );
        } else {
          while (to < end && !BLOCKS.includes((row[to] as Cell).ch)) to++;
          const text = row
            .slice(at, to)
            .map((cell) => cell.ch)
            .join("");
          if (text.trim() !== "") {
            const weight = first.bold ? ";font-weight:700" : "";
            runs.push(
              `<span style="${across(at, to)};top:${top}px;color:${first.fg}${weight}">${escapeHtml(text)}</span>`,
            );
          }
        }
        at = to;
      }
      x = end;
    }
  }
  // One size in every image, about a row of the full-size ones.
  const size = 22;
  const edges = boxEdges(screen, view, boxes, cw, ch, font);
  const bounds = {
    left: -pad - margin,
    top: -pad - margin,
    right: termW - pad + margin,
    bottom: termH - pad + margin,
  };
  const spots = boxes.map((b) => b.spot);
  const centres = badgeCentres(screen, view, edges, spots, size, bounds, cw, ch);
  const marks = boxes.map(({ n, bare }, i) => {
    const colour = COLOURS[n - 1] as (typeof COLOURS)[number];
    const e = edges[i] as Px;
    const c = centres[i] as { x: number; y: number };
    return {
      box: bare
        ? ""
        : `<div class="box" style="left:${e.left.toFixed(2)}px;top:${e.top.toFixed(2)}px;width:${(e.right - e.left).toFixed(2)}px;height:${(e.bottom - e.top).toFixed(2)}px;border-color:${colour.hex}"></div>`,
      tag: `<div class="badge" style="left:${(c.x - size / 2).toFixed(2)}px;top:${(c.y - size / 2).toFixed(2)}px;background:${colour.hex};color:${colour.ink}">${n}</div>`,
    };
  });
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${faces}
html,body{margin:0;padding:0;background:transparent}
.frame{position:relative;width:${width}px;height:${height}px;box-sizing:border-box;padding:${margin}px;border-radius:${Math.round(margin * 0.7)}px;background:#59626d}
.term{position:relative;width:${termW}px;height:${termH}px;box-sizing:border-box;padding:${pad}px;border-radius:${Math.round(pad * 0.4)}px;background:${bg};box-shadow:0 0 0 1px #2b3138}
.cells{position:relative;width:100%;height:100%}
.cells i{position:absolute}
.cells span{position:absolute;height:${ch}px;line-height:${ch}px;white-space:pre;font-family:"T";font-size:${font}px;font-kerning:none;font-variant-ligatures:none}
.box{position:absolute;box-sizing:border-box;border:${(font * 0.16).toFixed(2)}px solid;border-radius:${Math.round(font * 0.45)}px;box-shadow:0 0 0 1px rgba(0,0,0,.6)}
.badge{position:absolute;width:${size}px;height:${size}px;border-radius:50%;font:700 ${Math.round(size * 0.62)}px/${size}px "T";text-align:center;box-shadow:0 0 0 1.5px #0e1116,0 0 0 3px rgba(255,255,255,.9)}
</style></head><body><div class="frame"><div class="term"><div class="cells">
${runs.join("\n")}
${marks.map((m) => m.box).join("\n")}
${marks.map((m) => m.tag).join("\n")}
</div></div></div></body></html>
`;
  return { html, width, height };
}

// ── Chrome ──────────────────────────────────────────────────────────────────────────

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

function chromePath(): string {
  const set = process.env.CHROME;
  if (set !== undefined && set !== "") return set;
  const candidates = isWsl()
    ? ["/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find((c) => existsSync(c));
  if (found === undefined) throw new Error("no Chrome found: set CHROME to its path");
  return found;
}

/** A path as Chrome sees it: Windows Chrome under WSL needs Windows paths. */
function chromeSees(path: string, windows: boolean): string {
  if (!windows) return path;
  const run = Bun.spawnSync(["wslpath", "-w", path], { env: ENV, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`wslpath failed: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

function screenshot(
  chrome: string,
  html: string,
  png: string,
  width: number,
  height: number,
  dir: string,
): void {
  const windows = chrome.endsWith(".exe");
  // `file:///D:/x`, `file:////wsl.localhost/x` (a UNC path) or `file:///tmp/x`.
  const url = encodeURI(
    `file:///${chromeSees(html, windows)
      .replaceAll("\\", "/")
      .replace(/^\/+/, windows ? "//" : "")}`,
  );
  const run = Bun.spawnSync(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${chromeSees(join(dir, "profile"), windows)}`,
      `--force-device-scale-factor=${SCALE}`,
      `--window-size=${width},${height}`,
      "--default-background-color=00000000",
      "--force-color-profile=srgb",
      // Greyscale anti-aliasing: no colour fringes, and smaller files.
      "--disable-lcd-text",
      `--screenshot=${chromeSees(png, windows)}`,
      url,
    ],
    { env: ENV, stdout: "pipe", stderr: "pipe", timeout: 120_000 },
  );
  if (!existsSync(png)) {
    throw new Error(
      `Chrome wrote no screenshot (exit ${run.exitCode}): ${run.stderr.toString().slice(-500)}`,
    );
  }
}

// ── PNG ─────────────────────────────────────────────────────────────────────────────

/**
 * Chrome's screenshot rewritten with a 256-colour palette (median cut): a frame has a few
 * thousand colours, mostly its anti-aliased text, and a palette makes the file about a
 * third the size.
 */
function paletted(png: Uint8Array): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [depth, colour, , , interlace] = data.subarray(8, 13);
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) return png;
    } else if (type === "IDAT") {
      idat.push(data);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (pixels[y * stride + i - channels] as number) : 0;
      const b = y > 0 ? (pixels[(y - 1) * stride + i] as number) : 0;
      const c = y > 0 && i >= channels ? (pixels[(y - 1) * stride + i - channels] as number) : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const predict =
        [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter] ?? 0;
      pixels[y * stride + i] = ((line[i] as number) + predict) & 255;
    }
  }
  // Every colour and how often it is used.
  const counts = new Map<number, number>();
  for (let i = 0; i < pixels.length; i += channels) {
    const alpha = channels === 4 ? (pixels[i + 3] as number) : 255;
    const rgba =
      ((pixels[i] as number) << 24) |
      ((pixels[i + 1] as number) << 16) |
      ((pixels[i + 2] as number) << 8) |
      alpha;
    counts.set(rgba >>> 0, (counts.get(rgba >>> 0) ?? 0) + 1);
  }
  const channel = (rgba: number, k: number) => (rgba >>> (24 - 8 * k)) & 255;
  // Median cut: split the box with the widest weighted spread at its weighted median.
  let boxes: [number, number][][] = [[...counts]];
  while (boxes.length < 256) {
    let pick = -1;
    let pickSpread = 0;
    let pickChannel = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let k = 0; k < 4; k++) {
        let lo = 255;
        let hi = 0;
        let n = 0;
        for (const [c, count] of box) {
          lo = Math.min(lo, channel(c, k));
          hi = Math.max(hi, channel(c, k));
          n += count;
        }
        const spread = (hi - lo) * Math.sqrt(n);
        if (spread > pickSpread) {
          pick = i;
          pickSpread = spread;
          pickChannel = k;
        }
      }
    });
    if (pick < 0) break;
    const box = (boxes[pick] as [number, number][]).sort(
      (x, y) => channel(x[0], pickChannel) - channel(y[0], pickChannel),
    );
    const total = box.reduce((n, [, count]) => n + count, 0);
    let half = 0;
    let cut = 1;
    for (; cut < box.length - 1; cut++) {
      half += (box[cut - 1] as [number, number])[1];
      if (half * 2 >= total) break;
    }
    boxes = [...boxes.slice(0, pick), box.slice(0, cut), box.slice(cut), ...boxes.slice(pick + 1)];
  }
  const palette = boxes.map((box) => {
    const sum = [0, 0, 0, 0];
    let n = 0;
    for (const [c, count] of box) {
      for (let k = 0; k < 4; k++) sum[k] = (sum[k] as number) + channel(c, k) * count;
      n += count;
    }
    return sum.map((v) => Math.round(v / n));
  });
  const nearest = new Map<number, number>();
  for (const c of counts.keys()) {
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    palette.forEach((p, i) => {
      let d = 0;
      for (let k = 0; k < 4; k++) d += (channel(c, k) - (p[k] as number)) ** 2;
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    });
    nearest.set(c, best);
  }
  const rows = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * channels;
      const alpha = channels === 4 ? (pixels[i + 3] as number) : 255;
      const rgba =
        (((pixels[i] as number) << 24) |
          ((pixels[i + 1] as number) << 16) |
          ((pixels[i + 2] as number) << 8) |
          alpha) >>>
        0;
      rows[y * (width + 1) + 1 + x] = nearest.get(rgba) as number;
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 3, 0, 0, 0], 8);
  return Buffer.concat([
    png.subarray(0, 8),
    chunk("IHDR", ihdr),
    chunk("PLTE", Uint8Array.from(palette.flatMap((p) => p.slice(0, 3)))),
    chunk("tRNS", Uint8Array.from(palette.map((p) => p[3] as number))),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// ── the README ──────────────────────────────────────────────────────────────────────

function legend(shot: Shot): string {
  const items = shot.notes.map((note, i) => {
    const colour = COLOURS[i] as (typeof COLOURS)[number];
    return `${i + 1}. ${colour.emoji} **${note.name}.** ${note.text}`;
  });
  return [`![${shot.alt}](${IMAGE_URL}/${shot.file})`, "", ...items].join("\n");
}

/** The README with each shot's block (between its markers) regenerated. */
function readmeWith(text: string, shots: readonly Shot[]): string {
  let out = text;
  for (const shot of shots) {
    if (shot.block === null) continue;
    const open = `<!-- shots:${shot.block} -->`;
    const close = `<!-- /shots:${shot.block} -->`;
    const from = out.indexOf(open);
    const to = out.indexOf(close);
    if (from < 0 || to < from) {
      console.warn(`README.md has no ${open} … ${close}: its legend is not written`);
      continue;
    }
    out = `${out.slice(0, from + open.length)}\n${legend(shot)}\n${out.slice(to)}`;
  }
  return out;
}

/** Warns of each reading a legend quotes (in `code`, with a digit) that the frame lacks. */
function checkQuotes(shot: Shot, screen: Screen): void {
  const frame = screen.lines.join("\n");
  shot.notes.forEach((note, i) => {
    for (const m of note.text.matchAll(/`([^`]+)`/g)) {
      const quote = m[1] as string;
      // A form with a gap (`at 100% until …`) is not a reading.
      if (/\d/.test(quote) && !quote.includes("…") && !frame.includes(quote)) {
        console.warn(
          `${shot.file}: legend ${i + 1} (${note.name}) quotes "${quote}", not in the frame`,
        );
      }
    }
  });
}

// ── main ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (SHOTS.some((s) => s.notes.length > COLOURS.length))
    throw new Error("too many boxes in a shot");
  const chrome = chromePath();
  const faces = fontFace("DejaVuSansMono.ttf", 400) + fontFace("DejaVuSansMono-Bold.ttf", 700);
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-shots-"));
  const fx = makeShotsFixture();
  try {
    const data = fx.views();
    const bg = theme(fx.config.theme).hex.bg;
    mkdirSync(OUT, { recursive: true });
    for (const shot of SHOTS) {
      const screen = await render(fx, data, shot.keys);
      const view = shot.crop?.(screen) ?? screen.all;
      const boxes: Placed[] = [];
      shot.notes.forEach((note, i) => {
        const rect = note.locate(screen);
        if (rect === null) {
          console.warn(`${shot.file}: box ${i + 1} (${note.name}, in ${note.section}) not found`);
          return;
        }
        const placed = { ...rect, x: rect.x - view.x, y: rect.y - view.y };
        boxes.push({
          n: i + 1,
          rect: placed,
          ...(note.badge === undefined ? {} : { spot: note.badge }),
          ...(note.bare === undefined ? {} : { bare: note.bare }),
        });
      });
      checkQuotes(shot, screen);
      const { html, width, height } = page(screen, view, shot.font, boxes, faces, bg);
      const base = shot.file.replace(/\.png$/, "");
      const htmlPath = join(dir, `${base}.html`);
      writeFileSync(htmlPath, html);
      writeFileSync(join(dir, `${base}.txt`), `${screen.lines.join("\n")}\n`);
      const png = join(dir, shot.file);
      screenshot(chrome, htmlPath, png, width, height, dir);
      const small = paletted(readFileSync(png));
      writeFileSync(join(OUT, shot.file), small);
      const bytes = small.length;
      console.log(
        `${shot.file}: ${width * SCALE}×${height * SCALE}, ${Math.round(bytes / 1024)} KB, ${boxes.length} boxes`,
      );
      if (bytes > MAX_BYTES) console.warn(`${shot.file} is over ${MAX_BYTES / 1024} KB`);
    }
    const before = readFileSync(README, "utf8");
    const after = readmeWith(before, SHOTS);
    if (after !== before) writeFileSync(README, after);
    console.log(after === before ? "README.md legends unchanged" : "README.md legends written");
    if (process.env.SHOTS_KEEP !== undefined) console.log(`HTML and frames kept in ${dir}`);
  } finally {
    fx.remove();
    if (process.env.SHOTS_KEEP === undefined)
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

await main();
