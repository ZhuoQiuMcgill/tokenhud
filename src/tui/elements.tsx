// Typed wrappers for the shared renderables where JSX can't infer a row type, plus the
// one-line text helper every section uses.
import type { Line } from "./components/base.ts";
import type { Column, TableOptions } from "./components/table.ts";
import type { Theme } from "./theme.ts";

export interface TableProps<R> {
  readonly columns: readonly Column<R>[];
  readonly rows: readonly R[];
  readonly theme: Theme;
  readonly height: number;
  readonly selected?: number;
  readonly totals?: R | null;
  readonly header?: boolean;
  readonly width?: number;
  readonly marginLeft?: number;
}

export function Table<R>(props: TableProps<R>) {
  const options = { flexShrink: 0, ...props } as unknown as TableOptions<unknown>;
  return <th-table {...options} />;
}

/** Fixed-height styled lines. */
export function Lines(props: {
  readonly lines: readonly Line[];
  readonly theme: Theme;
  readonly height?: number;
  readonly width?: number;
}) {
  return (
    <th-lines
      lines={props.lines}
      theme={props.theme}
      height={props.height ?? props.lines.length}
      flexShrink={0}
      {...(props.width === undefined ? {} : { width: props.width })}
    />
  );
}
