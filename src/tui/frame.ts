// The frame around every view: header (gen.py `header()`), footer (`footer()`), rules and
// section titles, as `Line`s for the `th-lines` renderable. Pure functions of the width, so
// each degrades the same way every time when the terminal is narrow.

import type { McpActivity } from "../mcp-heartbeat.ts";
import { type Line, type Seg, seg, segsWidth } from "./components/base.ts";

export const TABS = ["Overview", "History", "Models", "Accounts"] as const;

export type Status =
  | { readonly kind: "live"; readonly refresh: number }
  | { readonly kind: "stale" }
  /** `--once`: a static frame says when its data is from. */
  | { readonly kind: "asof"; readonly time: string };

export interface HeaderState {
  /** 0-based index into TABS. */
  readonly active: number;
  /** "all accounts", or the scoped account's label. */
  readonly scope: string;
  readonly status: Status;
}

function tabs(active: number, compact: boolean): Seg[] {
  const out: Seg[] = [seg(" tokenhud ", "head", true), seg(" ", "fg")];
  TABS.forEach((name, i) => {
    if (i === active) {
      out.push(seg(` ${i + 1} ${name} `, "head", true, "tab"));
    } else {
      out.push(seg(` ${i + 1} `, "dim"));
      if (!compact) out.push(seg(`${name} `, "mute"));
    }
    out.push(seg(" ", "fg"));
  });
  return out;
}

function status(s: Status, short: boolean): Seg[] {
  if (s.kind === "asof") return [seg("   as of ", "dim"), seg(`${s.time} `, "fg")];
  if (s.kind === "stale") return [seg("   ● ", "mid"), seg("stale ", "dim")];
  return [seg("   ● ", "live"), seg(short ? "live " : `live · ${s.refresh}s `, "dim")];
}

/**
 * The header: name, tabs with the active one highlighted, and on the right the scope and
 * the live indicator. When it doesn't fit, it sheds in this order: the word "scope", the
 * inactive tabs' names, the refresh interval, then the scope.
 */
export function headerLine(width: number, state: HeaderState): Line {
  const scope = (word: boolean): Seg[] => [
    ...(word ? [seg("scope ", "dim")] : []),
    seg(`${state.scope}${state.status.kind === "asof" ? "" : " ▾"}`, "fg"),
  ];
  const candidates: Line[] = [
    { left: tabs(state.active, false), right: [...scope(true), ...status(state.status, false)] },
    { left: tabs(state.active, false), right: [...scope(false), ...status(state.status, false)] },
    { left: tabs(state.active, true), right: [...scope(false), ...status(state.status, false)] },
    { left: tabs(state.active, true), right: [...scope(false), ...status(state.status, true)] },
    { left: tabs(state.active, true), right: status(state.status, true) },
  ];
  for (const line of candidates) {
    if (segsWidth(line.left) + segsWidth(line.right ?? []) + 1 <= width) return line;
  }
  return candidates[candidates.length - 1] as Line;
}

export interface Hint {
  readonly key: string;
  readonly label: string;
}

/**
 * Footer key hints, left, and MCP status (plus any notice), right. Hints that don't fit
 * are dropped from the end of `hints`, which callers order by importance.
 */
export function footerLine(
  width: number,
  hints: readonly Hint[],
  order: readonly Hint[],
  right: readonly Seg[],
): Line {
  const render = (shown: readonly Hint[]): Seg[] => {
    const out: Seg[] = [seg(" ", "fg")];
    for (const h of order) {
      if (!shown.includes(h)) continue;
      out.push(seg(h.key, "head", true), seg(` ${h.label}   `, "dim"));
    }
    return out;
  };
  const rightWidth = segsWidth(right);
  for (let n = hints.length; n >= 0; n--) {
    const left = render(hints.slice(0, n));
    if (n === 0 || segsWidth(left) + rightWidth + 1 <= width) return { left, right };
  }
  return { left: [], right };
}

/** gen.py `footer()`'s right side: `MCP ● 2 agents`, or a hollow dot with no server running. */
export function mcpSegs(activity: McpActivity | null): Seg[] {
  if (activity === null) return [];
  if (activity.servers === 0 && activity.agents === 0) {
    return [seg("MCP ", "dim"), seg("○", "dim"), seg(" ", "dim")];
  }
  const agents =
    activity.agents > 0 ? ` ${activity.agents} agent${activity.agents === 1 ? "" : "s"} ` : " ";
  return [
    seg("MCP ", "dim"),
    seg(activity.servers > 0 ? "●" : "○", activity.servers > 0 ? "live" : "dim"),
    seg(agents, "dim"),
  ];
}

export function ruleLine(width: number): Line {
  return { left: [seg("─".repeat(Math.max(0, width)), "border")] };
}

/** gen.py `section()`: a bold title, with an optional dim note flush right. */
export function sectionLine(title: string, note?: string): Line {
  return note === undefined
    ? { left: [seg(` ${title}`, "head", true)] }
    : { left: [seg(` ${title}`, "head", true)], right: [seg(`${note} `, "dim")] };
}

export function blankLine(): Line {
  return { left: [] };
}
