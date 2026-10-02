// The frame every view plugs into: header, rule, body (the active view's sections, fitted
// to the rows there are), rule, footer; plus the help and settings overlays. Pure
// rendering of the controller's state.
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Component, memo, type ReactNode, useLayoutEffect, useSyncExternalStore } from "react";
import type { Config } from "../config.ts";
import "./components/index.ts";
import { type Line, type Seg, seg } from "./components/base.ts";
import type { Controller, Overlay, UiState } from "./controller.ts";
import { Lines } from "./elements.tsx";
import { fit, truncate } from "./format.ts";
import {
  footerLine,
  type HeaderState,
  type Hint,
  headerLine,
  mcpSegs,
  ruleLine,
  type Status,
} from "./frame.ts";
import { breakpoint, fitSections } from "./layout.ts";
import {
  choices,
  filterZones,
  ROW_LABELS,
  rowValue,
  SETTINGS_ROWS,
  type SettingsInput,
  type SettingsState,
} from "./settings.ts";
import { type Theme, theme as themeNamed } from "./theme.ts";
import { VIEWS } from "./views/index.ts";
import type { ViewContext } from "./views/types.ts";
import { type RootInfo, VIEW_IDS, type ViewId } from "./vm/types.ts";

export const MIN_WIDTH = 40;
export const MIN_HEIGHT = 10;
/** Header, rule, rule, footer. */
const CHROME_ROWS = 4;

const GLOBAL = {
  views: { key: "1-4", label: "views" },
  scope: { key: "a", label: "account" },
  settings: { key: "s", label: "settings" },
  help: { key: "?", label: "help" },
  quit: { key: "q", label: "quit" },
} as const satisfies Record<string, Hint>;

function statusOf(state: UiState): Status {
  if (state.vmDown !== null) return { kind: "error" };
  if (state.mode === "owner" && state.ingest === "live") {
    return { kind: "live", refresh: state.config.refresh_interval };
  }
  return { kind: "stale" };
}

function scopeLabel(state: UiState): string {
  if (state.scope === null) return "all accounts";
  return state.accounts.find((a) => a.id === state.scope)?.label ?? "all accounts";
}

function headerState(state: UiState): HeaderState {
  return {
    active: VIEW_IDS.indexOf(state.view),
    scope: scopeLabel(state),
    status: statusOf(state),
  };
}

function footer(state: UiState, width: number): Line {
  let hints: Hint[];
  let order: Hint[];
  if (state.overlay === "settings") {
    hints = [
      { key: "esc", label: "back" },
      { key: "enter", label: "change" },
      { key: "↑/↓", label: "move" },
    ];
    order = [...hints].reverse();
  } else if (state.overlay === "help") {
    hints = [{ key: "esc", label: "close" }];
    order = hints;
  } else {
    const own = VIEWS[state.view].hints;
    // Shown in this order; dropped from the end of `hints` when the footer is narrow.
    order = [GLOBAL.views, ...own, GLOBAL.scope, GLOBAL.settings, GLOBAL.help, GLOBAL.quit];
    hints = [GLOBAL.quit, GLOBAL.help, GLOBAL.views, GLOBAL.scope, GLOBAL.settings, ...own];
  }
  const notice: Seg[] =
    state.mode === "reader"
      ? [seg(state.readOnlyReason ?? "another tokenhud is ingesting", "mid"), seg("   ", "dim")]
      : [];
  return footerLine(width, hints, order, [...notice, ...mcpSegs(state.mcp)]);
}

function HelpPanel(props: { view: ViewId; width: number; height: number; t: Theme }) {
  const { t } = props;
  const row = (key: string, label: string): Line => ({
    left: [seg(`  ${fit(key, 9)}`, "head", true), seg(label, "fg")],
  });
  const view = VIEWS[props.view];
  const lines: Line[] = [
    row("1 2 3 4", "Overview, History, Models, Accounts"),
    row("a", "cycle the account scope: all → each account → all"),
    row("s", "settings"),
    row("?", "this help"),
    row("q", "quit (or Ctrl-C)"),
  ];
  if (view.hints.length > 0) {
    lines.push({ left: [] }, { left: [seg(`  ${view.title}`, "mute", true)] });
    for (const h of view.hints) lines.push(row(h.key, h.label));
  }
  const width = Math.min(64, props.width - 2);
  const height = Math.min(props.height, lines.length + 2);
  return (
    <box flexDirection="column" alignItems="center" height={props.height} flexShrink={0}>
      <th-card
        title="Keys"
        theme={t}
        width={width}
        height={height}
        flexShrink={0}
        flexDirection="column"
      >
        <Lines theme={t} lines={lines} height={height - 2} />
      </th-card>
    </box>
  );
}

/** The rows of `items` to show in `rows` lines so that `pick` is visible. */
function windowAround<T>(
  items: readonly T[],
  pick: number,
  rows: number,
): { start: number; shown: T[] } {
  const start = Math.max(0, Math.min(pick - Math.floor(rows / 2), items.length - rows));
  return { start, shown: items.slice(start, start + Math.max(0, rows)) };
}

function settingsLines(
  s: SettingsState,
  input: SettingsInput,
  rows: number,
): { title: string; lines: Line[] } {
  const hint = (text: string): Line => ({ left: [seg(text, "dim")] });
  const message: Line[] = s.message === null ? [] : [{ left: [seg(s.message, "high")] }];
  const picked = (selected: boolean, left: Seg[]): Line =>
    selected
      ? { left: [seg("› ", "head", true), ...left], bg: "sel" }
      : { left: [seg("  ", "fg"), ...left] };
  switch (s.screen) {
    case "main":
      return {
        title: "Settings",
        lines: [
          ...SETTINGS_ROWS.map((r, i) =>
            picked(i === s.cursor, [
              seg(fit(ROW_LABELS[r], 24), "fg"),
              seg(rowValue(r, input), "cost"),
            ]),
          ),
          { left: [] },
          ...message,
          hint("↑/↓ move · enter change · esc back to the view"),
        ],
      };
    case "choice": {
      const now = rowValue(s.row, input);
      return {
        title: `Settings › ${ROW_LABELS[s.row]}`,
        lines: [
          ...choices(s.row).map((c, i) =>
            picked(i === s.pick, [seg(c.label === now ? "● " : "  ", "live"), seg(c.label, "fg")]),
          ),
          { left: [] },
          hint("● current · ↑/↓ move · enter select · esc back"),
        ],
      };
    }
    case "tz": {
      const zones = filterZones(input.zones, s.filter);
      const { start, shown } = windowAround(zones, s.pick, rows - 4);
      return {
        title: "Settings › Time zone",
        lines: [
          { left: [seg("filter ", "mute"), seg(`${s.filter}▏`, "head")] },
          ...shown.map((z, i) =>
            picked(start + i === s.pick, [
              seg(z === input.config.time_zone ? "● " : "  ", "live"),
              seg(z === "system" ? `system (${input.systemZone})` : z, "fg"),
            ]),
          ),
          ...message,
          hint("type to filter · ↑/↓ move · enter select · esc back"),
        ],
      };
    }
    case "accounts":
    case "rename": {
      const { start, shown } = windowAround(input.roots, s.pick, rows - 4);
      const lines = shown.map((r, i) =>
        picked(start + i === s.pick, [
          seg(r.enabled ? "● " : "○ ", r.enabled ? "live" : "dim"),
          seg(fit(r.label, 14), r.enabled ? "fg" : "dim"),
          seg(fit(r.provider, 7), "mute"),
          seg(fit(r.historyOnly ? "history only" : "", 13), "mid"),
          seg(r.path, "dim"),
        ]),
      );
      if (input.roots.length === 0) lines.push({ left: [seg("  no accounts found", "dim")] });
      const footerLines: Line[] =
        s.screen === "rename"
          ? [
              { left: [seg("new label ", "mute"), seg(`${s.text}▏`, "head")] },
              ...message,
              hint("enter save · esc cancel"),
            ]
          : [...message, hint("e enable/disable · l rename · h history only · esc back")];
      return { title: "Settings › Accounts", lines: [...lines, { left: [] }, ...footerLines] };
    }
  }
}

function SettingsPanel(props: {
  controller: Controller;
  settings: SettingsState;
  config: Config;
  roots: readonly RootInfo[];
  width: number;
  height: number;
  t: Theme;
}) {
  const { t, controller } = props;
  const width = Math.min(96, props.width - 2);
  const rows = props.height - 2;
  const { title, lines } = settingsLines(
    props.settings,
    {
      config: props.config,
      roots: props.roots,
      zones: controller.zones,
      systemZone: controller.systemZone,
    },
    rows,
  );
  const height = Math.min(props.height, lines.length + 2);
  return (
    <box flexDirection="column" alignItems="center" height={props.height} flexShrink={0}>
      <th-card
        title={title}
        theme={t}
        width={width}
        height={height}
        flexShrink={0}
        flexDirection="column"
      >
        <Lines theme={t} lines={lines.slice(0, height - 2)} height={height - 2} />
      </th-card>
    </box>
  );
}

interface BodyProps {
  readonly controller: Controller;
  readonly width: number;
  readonly height: number;
  readonly t: Theme;
  readonly error: string | null;
  readonly overlay: Overlay;
  readonly view: ViewId;
  readonly vm: unknown;
  readonly viewState: unknown;
  readonly config: Config;
  readonly scope: number | null;
  readonly settings: SettingsState;
  readonly roots: readonly RootInfo[];
}

/**
 * Everything between the rules. Memoised on what it reads, so a change only the header or
 * footer shows (the live indicator, MCP status) doesn't redraw the view.
 */
const Body = memo(function Body(props: BodyProps) {
  const { width, height, t, config } = props;
  const top: Line =
    props.error === null ? { left: [] } : { left: [seg(` ${props.error}`, "high")] };
  const rows = height - 1;
  let content: ReactNode;
  if (props.overlay === "settings") {
    content = (
      <SettingsPanel
        controller={props.controller}
        settings={props.settings}
        config={config}
        roots={props.roots}
        width={width}
        height={rows}
        t={t}
      />
    );
  } else if (props.overlay === "help") {
    content = <HelpPanel view={props.view} width={width} height={rows} t={t} />;
  } else if (props.vm === undefined) {
    content = <Lines theme={t} lines={[{ left: [seg("  reading the store…", "dim")] }]} />;
  } else {
    const ctx: ViewContext = {
      width,
      bp: breakpoint(width),
      theme: t,
      showCost: config.show_cost,
      tz: config.time_zone === "system" ? props.controller.systemZone : config.time_zone,
      scope: props.scope,
    };
    const sections = VIEWS[props.view].sections(props.vm, props.viewState, ctx);
    const byId = new Map(sections.map((s) => [s.id, s]));
    content = fitSections(sections, rows).flatMap((f, i) => [
      ...(i > 0 ? [<box key={`gap-${f.id}`} height={1} flexShrink={0} />] : []),
      <box key={f.id} flexDirection="column" height={f.height} flexShrink={0}>
        {byId.get(f.id)?.render(f.height)}
      </box>,
    ]);
  }
  return (
    <box flexDirection="column" height={height} flexShrink={0}>
      <Lines theme={t} lines={[top]} />
      {content}
    </box>
  );
});

/** A render error is fatal: the shell restores the terminal and exits (T10 §2). */
class Fatal extends Component<
  { onError: (error: Error) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function Frame(props: {
  controller: Controller;
  width: number;
  height: number;
  /** Called after each commit, before the frame it produced is drawn. */
  onCommit?: (state: UiState) => void;
}) {
  const { controller, width, height, onCommit } = props;
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useLayoutEffect(() => onCommit?.(state), [state, onCommit]);
  const t = themeNamed(state.config.theme);
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return (
      <box width={width} height={height} backgroundColor={t.hex.bg}>
        <Lines
          theme={t}
          lines={[
            {
              left: [
                seg(truncate(`tokenhud needs ${MIN_WIDTH}×${MIN_HEIGHT} or more`, width), "mid"),
              ],
            },
          ]}
        />
      </box>
    );
  }
  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={t.hex.bg}>
      <Lines theme={t} lines={[headerLine(width, headerState(state)), ruleLine(width)]} />
      <Body
        controller={controller}
        width={width}
        height={height - CHROME_ROWS}
        t={t}
        error={state.vmDown ?? state.ingestDown ?? state.error}
        overlay={state.overlay}
        view={state.view}
        vm={state.views[state.view]}
        viewState={state.viewState[state.view]}
        config={state.config}
        scope={state.scope}
        settings={state.settings}
        roots={state.roots}
      />
      <Lines theme={t} lines={[ruleLine(width), footer(state, width)]} />
    </box>
  );
}

export function App(props: {
  controller: Controller;
  onFatal: (error: Error) => void;
  onCommit?: (state: UiState) => void;
}) {
  const { width, height } = useTerminalDimensions();
  // A key handler that throws is a crash like a render error (OpenTUI would swallow it).
  useKeyboard((key) => {
    try {
      props.controller.key({ name: key.name, sequence: key.sequence, ctrl: key.ctrl });
    } catch (error) {
      props.onFatal(error as Error);
    }
  });
  return (
    <Fatal onError={props.onFatal}>
      <Frame
        controller={props.controller}
        width={width}
        height={height}
        {...(props.onCommit === undefined ? {} : { onCommit: props.onCommit })}
      />
    </Fatal>
  );
}
