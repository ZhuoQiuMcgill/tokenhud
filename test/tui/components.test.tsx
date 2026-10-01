// Unit snapshots of every shared renderable (T10 §5), plus the arithmetic behind them.
// Each renders in a box painted with the theme background, so every cell has a role.
import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import "../../src/tui/components/index.ts";
import { type Line, seg } from "../../src/tui/components/base.ts";
import { shareCells } from "../../src/tui/components/hbar.ts";
import { heatLevel } from "../../src/tui/components/heat-grid.ts";
import { filledCells } from "../../src/tui/components/meter.ts";
import { sparkChar } from "../../src/tui/components/spark.ts";
import { type Column, columnWidths, scrollTop } from "../../src/tui/components/table.ts";
import { chartCell, chartColumns } from "../../src/tui/components/vchart.ts";
import { Table } from "../../src/tui/elements.tsx";
import { theme } from "../../src/tui/theme.ts";
import { chars, cleanupRenderers, render, roles } from "./render.ts";

cleanupRenderers();
const dark = theme("dark");

function Canvas(props: { width: number; height: number; children: ReactNode }) {
  return (
    <box
      width={props.width}
      height={props.height}
      backgroundColor={dark.hex.bg}
      flexDirection="column"
    >
      {props.children}
    </box>
  );
}

// One spare row: OpenTUI's test renderer drops a 1-row frame's box-drawing characters.
async function snap(node: ReactNode, width: number, height: number) {
  const setup = await render(
    <Canvas width={width} height={height + 1}>
      {node}
    </Canvas>,
    width,
    height + 1,
  );
  const keep = (text: string) => text.split("\n").slice(0, height).join("\n");
  return `${keep(chars(setup))}\n${keep(roles(setup.captureSpans(), dark))}`;
}

describe("Lines", () => {
  const lines: Line[] = [
    { left: [seg(" LIMITS", "head", true)], right: [seg("pace = spend rate ", "dim")] },
    { left: [seg("5h   ", "mute"), seg("62%", "mid", true), seg(" 1h48m", "dim")] },
    { left: [seg("a long left part that must be cut", "fg")], right: [seg("right", "cost")] },
    { left: [seg("selected row", "head", true)], bg: "sel" },
  ];

  test("left flush left, right flush right, cut with … where they meet", async () => {
    expect(await snap(<th-lines lines={lines} theme={dark} height={4} />, 30, 4)).toMatchSnapshot();
  });
});

describe("Card", () => {
  test("rounded border, bold title, content inset two cells (gen.py card)", async () => {
    const node = (
      <th-card
        title="personal · Claude Max 20x"
        theme={dark}
        width={38}
        height={5}
        flexDirection="column"
      >
        <th-lines
          lines={[{ left: [seg("5h   ", "mute"), seg("62%", "mid", true)] }]}
          theme={dark}
          height={1}
        />
        <th-lines
          lines={[{ left: [seg("week ", "mute"), seg("27%", "low", true)] }]}
          theme={dark}
          height={1}
        />
        <th-lines
          lines={[{ left: [seg("pace ", "mute"), seg("$41/h", "cost")] }]}
          theme={dark}
          height={1}
        />
      </th-card>
    );
    expect(await snap(node, 40, 5)).toMatchSnapshot();
  });

  test("a title too long for the width is cut, keeping one rule cell before the corner", async () => {
    const node = (
      <th-card title="a-very-long-account-label · plan" theme={dark} width={20} height={3} />
    );
    const out = await snap(node, 20, 3);
    expect(out.split("\n")[0]).toBe("╭─ a-very-long-a… ─╮");
    expect(out).toMatchSnapshot();
  });

  test("the title role is configurable (the agents card uses live)", async () => {
    const out = await snap(
      <th-card title="agents · MCP" titleRole="live" theme={dark} width={20} height={3} />,
      20,
      3,
    );
    expect(out).toContain("[live/bg/b]agents · MCP");
  });
});

describe("Meter", () => {
  // The dark palette's mid is the cost amber, so the role reads "cost|mid".
  test.each([
    [0.27, "low"],
    [0.62, "cost|mid"],
    [0.83, "high"],
  ])(
    "%p fills round(value · width) cells in the %s colour, the rest empty",
    async (value, role) => {
      const out = await snap(<th-meter value={value} theme={dark} width={14} height={1} />, 14, 1);
      const n = filledCells(value, 14);
      expect(out.split("\n")[0]).toBe("━".repeat(14));
      expect(out.split("\n")[1]).toBe(
        `[${role}/bg]${"━".repeat(n)}[empty/bg]${"━".repeat(14 - n)}`,
      );
      expect(n).toBe(Math.round(value * 14));
    },
  );

  test("filled cells: none at 0, full above 100 %, an override role", async () => {
    expect([0, 0.5, 1, 1.4, Number.NaN].map((v) => filledCells(v, 14))).toEqual([0, 7, 14, 14, 0]);
    const out = await snap(
      <th-meter value={0.5} colorRole="cost" theme={dark} width={10} height={1} />,
      10,
      1,
    );
    expect(out).toMatchSnapshot();
  });
});

describe("HBar", () => {
  test("a nonzero share shows at least one cell; the track is optional", async () => {
    expect(shareCells(0.001, 12)).toBe(1);
    expect(shareCells(0, 12)).toBe(0);
    expect(shareCells(0.692, 12)).toBe(8);
    const node = (
      <box flexDirection="column">
        <th-hbar value={0.692} theme={dark} width={12} height={1} />
        <th-hbar value={0.047} theme={dark} width={12} height={1} />
        <th-hbar value={0.25} track colorRole="tokens" theme={dark} width={12} height={1} />
      </box>
    );
    expect(await snap(node, 12, 3)).toMatchSnapshot();
  });
});

describe("Spark", () => {
  test("ticks scale to the largest value (gen.py spark); null is a gap", () => {
    expect([0, 1, 4, 7, 8].map((v) => sparkChar(v, 8)).join("")).toBe("▁▁▄▇█");
    expect(sparkChar(null, 8)).toBe(" ");
  });

  test("the latest values show when there are more than cells", async () => {
    const values = [9, 9, 9, 0, 1, 2, 3, null, 5, 6, 7, 8];
    const node = <th-spark values={values} theme={dark} width={9} height={1} />;
    const out = await snap(node, 9, 1);
    // The last 9: 0 1 2 3 null 5 6 7 8, scaled to 8.
    expect(out.split("\n")[0]).toBe("▁▁▂▃ ▅▆▇█");
    expect(out).toMatchSnapshot();
  });

  test("a fixed max keeps scales comparable", async () => {
    const out = await snap(
      <th-spark values={[1, 2]} max={8} theme={dark} width={2} height={1} />,
      2,
      1,
    );
    expect(out.split("\n")[0]).toBe("▁▂");
  });
});

describe("VChart", () => {
  test("eighth blocks on top (gen.py vchart)", () => {
    // 7 rows: a value at 50 % of the top fills 3.5 rows: three full cells, a half block.
    const column = [0, 1, 2, 3, 4, 5, 6].map((r) => chartCell(5, 10, 7, r)).join("");
    expect(column).toBe("   ▄███");
    expect(chartCell(0.01, 10, 7, 6)).toBe("▁");
    expect(chartCell(0, 10, 7, 6)).toBe(" ");
  });

  test("columns: wider cells when values are few, summed groups when they are many", () => {
    expect(chartColumns([1, 2, 3], 10)).toEqual({ columns: [1, 2, 3], colw: 3 });
    expect(chartColumns([1, 2, 3, 4, 5], 2)).toEqual({ columns: [6, 9], colw: 1 });
    expect(chartColumns([], 10)).toEqual({ columns: [], colw: 1 });
    // 72 twenty-minute buckets in 60 cells: pairs, 40 minutes a column.
    expect(chartColumns(Array(72).fill(1), 60).columns).toHaveLength(36);
  });

  test("y labels (top, middle, 0), bars and x tick labels", async () => {
    const values = [0, 1, 2, 4, 8, 16, 12, 6, 3, 0, 0, 5, 18.4, 9];
    const node = (
      <th-vchart
        values={values}
        format={(v: number) => `$${v.toFixed(1)}`}
        xLabels={[
          { at: 0, text: "-24h" },
          { at: 0.5, text: "-12h" },
          { at: 1, text: "now" },
        ]}
        theme={dark}
        width={36}
        height={8}
      />
    );
    expect(await snap(node, 36, 8)).toMatchSnapshot();
  });

  test("an empty chart shows only the 0 label", async () => {
    const out = await snap(
      <th-vchart values={[0, 0, 0]} theme={dark} width={20} height={4} />,
      20,
      4,
    );
    expect(out.split("\n").slice(0, 4)).toEqual([
      " ".repeat(20),
      " ".repeat(20),
      " ".repeat(20),
      `     0${" ".repeat(14)}`,
    ]);
  });
});

describe("HeatGrid", () => {
  test("level: 0 for none, then quarters of the largest value", () => {
    expect([0, -1, 0.1, 2.4, 2.5, 5, 7.5, 10].map((v) => heatLevel(v, 10))).toEqual([
      0, 0, 1, 1, 2, 3, 4, 4,
    ]);
  });

  const weeks = 6;
  const values = Array.from({ length: weeks * 7 }, (_, i) =>
    i >= weeks * 7 - 3 ? null : (i * 7) % 11,
  );

  test("weeks × days of ■, five levels, the selected day in head, blanks after today", async () => {
    const node = (
      <th-heat
        values={values}
        weeks={weeks}
        selected={weeks * 7 - 5}
        months={[
          { week: 0, text: "Aug" },
          { week: 3, text: "Sep" },
        ]}
        theme={dark}
        width={5 + weeks * 2}
        height={8}
      />
    );
    expect(await snap(node, 5 + weeks * 2, 8)).toMatchSnapshot();
  });

  test("when narrower than the weeks, the latest weeks show", async () => {
    const node = (
      <th-heat values={values} weeks={weeks} dayLabels={false} theme={dark} width={6} height={7} />
    );
    const out = await snap(node, 6, 7);
    // Three weeks fit; the last week's Fri–Sun are blank.
    expect(out.split("\n")[0]).toBe("■ ■ ■ ");
    expect(out.split("\n")[6]).toBe("■ ■   ");
  });
});

describe("Table", () => {
  interface Row {
    readonly name: string;
    readonly cost: number;
    readonly share: number;
  }
  const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
    name: `model-${String.fromCharCode(97 + i)}${i === 3 ? "-with-a-long-name" : ""}`,
    cost: 1000 / (i + 1),
    share: 1 / (i + 2),
  }));
  const columns: Column<Row>[] = [
    {
      title: "model",
      width: "fill",
      role: (r) => (r.cost > 500 ? "head" : "fg"),
      text: (r) => r.name,
    },
    {
      title: "cost",
      width: 9,
      align: "right",
      role: "cost",
      bold: true,
      text: (r) => `$${r.cost.toFixed(2)}`,
    },
    { title: "share", width: 6, role: "cost", bar: (r) => r.share },
  ];

  test("column widths: fixed as given, one fill column takes the rest", () => {
    expect(columnWidths(columns, 40, 1)).toEqual([23, 9, 6]);
    expect(columnWidths(columns, 10, 1)).toEqual([0, 9, 6]);
  });

  test("scrolling keeps the selection on screen, moving as little as possible", () => {
    expect(scrollTop(0, 2, 5, 12)).toBe(0);
    expect(scrollTop(0, 7, 5, 12)).toBe(3);
    expect(scrollTop(3, 4, 5, 12)).toBe(3);
    expect(scrollTop(3, 1, 5, 12)).toBe(1);
    expect(scrollTop(9, -1, 5, 12)).toBe(7);
    expect(scrollTop(0, 0, 5, 3)).toBe(0);
  });

  test("header, the rows on screen with the selection on sel, a totals row under a rule", async () => {
    const node = (
      <Table
        columns={columns}
        rows={rows}
        selected={6}
        totals={{ name: "Total", cost: 3103.17, share: 0 }}
        theme={dark}
        height={8}
        width={40}
      />
    );
    expect(await snap(node, 40, 8)).toMatchSnapshot();
  });

  test("draws only the rows that fit, however many there are", async () => {
    const many = Array.from({ length: 100_000 }, (_, i) => ({
      name: `row ${i}`,
      cost: i,
      share: 0,
    }));
    const node = (
      <Table columns={columns} rows={many} selected={99_999} theme={dark} height={4} width={40} />
    );
    const out = (await snap(node, 40, 4)).split("\n").slice(0, 4);
    expect(out[0]).toStartWith("model");
    expect(out.slice(1).map((l) => l.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual([
      "row 99997",
      "row 99998",
      "row 99999",
    ]);
  });
});
