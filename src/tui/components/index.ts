// The shared renderables (T10 §5), registered as JSX elements. Each draws straight to the
// buffer: a table or chart is one renderable, never a React node per row or cell.
import { extend } from "@opentui/react";
import { CardRenderable } from "./card.ts";
import { HBarRenderable } from "./hbar.ts";
import { HeatGridRenderable } from "./heat-grid.ts";
import { LinesRenderable } from "./lines.ts";
import { MeterRenderable } from "./meter.ts";
import { SparkRenderable } from "./spark.ts";
import { TableRenderable } from "./table.ts";
import { VChartRenderable } from "./vchart.ts";

export type { Line, Seg } from "./base.ts";
export { seg, segsWidth } from "./base.ts";
export type { MonthLabel } from "./heat-grid.ts";
export type { Column } from "./table.ts";
export type { XLabel } from "./vchart.ts";

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "th-card": typeof CardRenderable;
    "th-hbar": typeof HBarRenderable;
    "th-heat": typeof HeatGridRenderable;
    "th-lines": typeof LinesRenderable;
    "th-meter": typeof MeterRenderable;
    "th-spark": typeof SparkRenderable;
    "th-table": typeof TableRenderable;
    "th-vchart": typeof VChartRenderable;
  }
}

extend({
  "th-card": CardRenderable,
  "th-hbar": HBarRenderable,
  "th-heat": HeatGridRenderable,
  "th-lines": LinesRenderable,
  "th-meter": MeterRenderable,
  "th-spark": SparkRenderable,
  "th-table": TableRenderable,
  "th-vchart": VChartRenderable,
});
