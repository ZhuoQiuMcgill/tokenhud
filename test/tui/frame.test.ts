import { describe, expect, test } from "bun:test";
import type { Line } from "../../src/tui/components/base.ts";
import { segsWidth } from "../../src/tui/components/base.ts";
import { footerLine, headerLine, mcpSegs, sectionLine } from "../../src/tui/frame.ts";

const text = (line: Line) => ({
  left: line.left.map((s) => s.text).join(""),
  right: (line.right ?? []).map((s) => s.text).join(""),
});

const live = { kind: "live", refresh: 5 } as const;

describe("header (gen.py header())", () => {
  test("at 120 columns: every tab named, the scope and the live indicator", () => {
    const line = headerLine(120, { active: 0, scope: "all accounts", status: live });
    expect(text(line)).toEqual({
      left: " tokenhud   1 Overview   2 History   3 Models   4 Accounts  ",
      right: "scope all accounts ▾   ● live · 5s ",
    });
    // The active tab is bold head text on the tab background.
    expect(line.left.find((s) => s.text === " 1 Overview ")).toEqual({
      text: " 1 Overview ",
      role: "head",
      bold: true,
      bg: "tab",
    });
  });

  test("at 80 columns the word 'scope' and the inactive tab names go first", () => {
    const line = headerLine(80, { active: 2, scope: "personal", status: live });
    expect(text(line)).toEqual({
      left: " tokenhud   1   2   3 Models   4  ",
      right: "personal ▾   ● live · 5s ",
    });
    expect(segsWidth(line.left) + segsWidth(line.right ?? []) + 1).toBeLessThanOrEqual(80);
  });

  test("narrower still: the refresh interval, then the scope", () => {
    expect(text(headerLine(61, { active: 0, scope: "all accounts", status: live })).right).toBe(
      "all accounts ▾   ● live ",
    );
    expect(text(headerLine(60, { active: 0, scope: "all accounts", status: live })).right).toBe(
      "   ● live ",
    );
  });

  test("stale and --once's 'as of' replace the live indicator", () => {
    expect(
      text(headerLine(120, { active: 0, scope: "work", status: { kind: "stale" } })).right,
    ).toBe("scope work ▾   ● stale ");
    const once = headerLine(120, {
      active: 0,
      scope: "work",
      status: { kind: "asof", time: "11:40" },
    });
    expect(text(once).right).toBe("scope work   as of 11:40 ");
    expect(once.right?.[2]).toMatchObject({ text: "   as of ", role: "dim" });
  });
});

describe("footer (gen.py footer())", () => {
  const q = { key: "q", label: "quit" };
  const help = { key: "?", label: "help" };
  const views = { key: "1-4", label: "views" };
  const order = [views, help, q];

  test("hints in display order, MCP on the right", () => {
    const line = footerLine(
      120,
      [q, help, views],
      order,
      mcpSegs({ servers: 1, agents: 2, recent: [] }),
    );
    expect(text(line)).toEqual({
      left: " 1-4 views   ? help   q quit   ",
      right: "MCP ● 2 agents ",
    });
    expect(line.left[1]).toEqual({ text: "1-4", role: "head", bold: true });
  });

  test("hints that don't fit drop from the end of the priority list", () => {
    const right = mcpSegs({ servers: 0, agents: 0, recent: [] });
    expect(text(footerLine(28, [q, help, views], order, right)).left).toBe(" ? help   q quit   ");
    expect(text(footerLine(18, [q, help, views], order, right)).left).toBe(" q quit   ");
  });

  test("MCP: hollow dot with no server, one agent singular, nothing before the first read", () => {
    expect(mcpSegs(null)).toEqual([]);
    expect(
      mcpSegs({ servers: 0, agents: 0, recent: [] })
        .map((s) => s.text)
        .join(""),
    ).toBe("MCP ○ ");
    expect(
      mcpSegs({ servers: 1, agents: 0, recent: [] })
        .map((s) => s.text)
        .join(""),
    ).toBe("MCP ● ");
    expect(
      mcpSegs({ servers: 1, agents: 1, recent: [] })
        .map((s) => s.text)
        .join(""),
    ).toBe("MCP ● 1 agent ");
  });
});

test("section titles: bold head title, dim note flush right", () => {
  expect(sectionLine("SPEND")).toEqual({ left: [{ text: " SPEND", role: "head", bold: true }] });
  expect(sectionLine("LIMITS", "pace = …")).toEqual({
    left: [{ text: " LIMITS", role: "head", bold: true }],
    right: [{ text: "pace = … ", role: "dim", bold: false }],
  });
});
