// The frame every view plugs into: header, rule, body (the active view's sections, fitted
// to the rows there are), rule, footer (two lines from 30 rows: the view's keys, then the
// global ones); plus the help and settings overlays and the action menu. Pure rendering of
// the controller's state.
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Component, memo, type ReactNode, useLayoutEffect, useSyncExternalStore } from "react";
import type { Config } from "../config.ts";
import "./components/index.ts";
import { type Line, type Seg, seg, segsWidth } from "./components/base.ts";
import type { Controller, Overlay, UiState } from "./controller.ts";
import { Lines } from "./elements.tsx";
import { fit, textWidth, truncate } from "./format.ts";
import {
  footerLine,
  type HeaderState,
  type Hint,
  headerLine,
  mcpSegs,
  ruleLine,
  type Status,
} from "./frame.ts";
import { footerHints, GLOBAL_KEYS, hintText, type KeyHelp, MOVE_KEYS } from "./keys.ts";
import { breakpoint, fitSections } from "./layout.ts";
import {
  MENU_KEYMAP,
  type MenuInput,
  type MenuState,
  menuItems,
  menuLines,
  menuRoot,
  menuTitle,
} from "./menu.ts";
import {
  choices,
  filterZones,
  linkCandidates,
  ROW_LABELS,
  rowValue,
  SETTINGS_KEYS,
  SETTINGS_ROWS,
  type SettingsInput,
  type SettingsState,
} from "./settings.ts";
import { type Theme, theme as themeNamed } from "./theme.ts";
import { VIEWS } from "./views/index.ts";
import { activeKeymap, type ViewContext } from "./views/types.ts";
import { type RootInfo, VIEW_IDS, type ViewId } from "./vm/types.ts";

export const MIN_WIDTH = 40;
export const MIN_HEIGHT = 10;
/** From this many rows the footer takes two lines: the view's keys, then the global ones. */
const TWO_LINE_FOOTER = 30;
/** Header, rule and rule; the footer's lines come on top. */
const CHROME_ROWS = 3;

/** The global keys as the footer shows them: `1-4/tab views · c account · …`. */
const GLOBAL_HINTS = {
  views: { key: "1-4/tab", label: GLOBAL_KEYS.views.label },
  scope: { key: GLOBAL_KEYS.scope.show, label: GLOBAL_KEYS.scope.label },
  settings: { key: GLOBAL_KEYS.settings.show, label: GLOBAL_KEYS.settings.label },
  help: { key: GLOBAL_KEYS.help.show, label: GLOBAL_KEYS.help.label },
  quit: { key: GLOBAL_KEYS.quit.show, label: GLOBAL_KEYS.quit.label },
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

/** The keys of what has them now: the menu, the settings screen, the help, or the view. */
function ownHints(state: UiState): Hint[] {
  if (state.menu !== null) return footerHints(MENU_KEYMAP);
  if (state.overlay === "settings") return footerHints(SETTINGS_KEYS[state.settings.screen]);
  if (state.overlay === "help") return [{ key: "esc", label: "close" }];
  const view = VIEWS[state.view];
  const viewState = state.viewState[state.view];
  const vm = state.views[state.view];
  return footerHints(activeKeymap(view, viewState), (e) => e.when?.(viewState, vm) ?? true);
}

/** The footer's right side: a reader's notice, the update note while it leaves room, MCP. */
function footerRight(state: UiState, width: number): Seg[] {
  const notice: Seg[] =
    state.mode === "reader"
      ? [seg(state.readOnlyReason ?? "another tokenhud is ingesting", "mid"), seg("   ", "dim")]
      : [];
  const right = [...notice, ...mcpSegs(state.mcp)];
  // Dim, and only while it leaves room for a hint or two.
  // A prerelease is installed only with --prerelease, so the note says so.
  const update =
    state.update !== null && state.config.update_check
      ? [
          seg(
            `update ${state.update} available${state.update.includes("-") ? " (--prerelease)" : ""}`,
            "dim",
          ),
          seg("   ", "dim"),
        ]
      : [];
  const withUpdate = [...update, ...right];
  return segsWidth(withUpdate) + 20 <= width ? withUpdate : right;
}

/**
 * The footer: with `lines` 2, the keys of what has them (the view, an overlay or the menu),
 * then the global keys with the status on the right; with 1, both on one line, dropping
 * from the end of the priority order (`? help`, `a/d`, `w/s`, `enter`, then the rest) and
 * shown in the two lines' order. Overlays take every key, so no global key shows with one.
 */
function footer(state: UiState, width: number, lines: 1 | 2): Line[] {
  const own = ownHints(state);
  const overlay = state.menu !== null || state.overlay !== "none";
  const G = GLOBAL_HINTS;
  const global: Hint[] = overlay ? [] : [G.views, G.scope, G.settings, G.help, G.quit];
  const right = footerRight(state, width);
  if (lines === 2) {
    return [
      footerLine(width, own, own, []),
      footerLine(
        width,
        overlay ? [] : [G.help, G.views, G.scope, G.settings, G.quit],
        global,
        right,
      ),
    ];
  }
  const help = overlay ? [] : [G.help];
  return [
    footerLine(
      width,
      [...help, ...own, ...global.filter((h) => h !== G.help)],
      [...own, ...global],
      right,
    ),
  ];
}

/** `text` in lines of at most `width` cells, broken between words. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && textWidth(next) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  return [...lines, line];
}

/**
 * The help overlay's lines in `width` cells: how to move (the same in every view), this
 * view's keys (its keymap, tab names included) and the global keys. Short of `rows`, the
 * moves and the global keys take a line each; then descriptions are cut instead of wrapped.
 */
function helpLines(view: ViewId, width: number, rows: number): Line[] {
  const move = Object.values(MOVE_KEYS);
  const own = VIEWS[view].keymap;
  const global = Object.values(GLOBAL_KEYS);
  const keyText = (e: KeyHelp) => (e.alias === undefined ? e.show : `${e.show}  ${e.alias}`);
  const keyWidth = Math.max(...[...move, ...own, ...global].map((e) => textWidth(keyText(e)))) + 2;
  const title = (text: string): Line => ({ left: [seg(` ${text}`, "mute", true)] });
  const rowsOf = (entries: readonly KeyHelp[], wrapped: boolean): Line[] =>
    entries.flatMap((e) =>
      (wrapped ? wrap(e.does, width - 2 - keyWidth) : [e.does]).map((text, i) => ({
        left: [seg(`  ${fit(i === 0 ? keyText(e) : "", keyWidth)}`, "head", true), seg(text, "fg")],
      })),
    );
  const oneLine = (entries: readonly KeyHelp[]): Line => ({
    left: [
      seg("  ", "fg"),
      ...entries.flatMap((e, i) => [
        ...(i > 0 ? [seg(" · ", "dim")] : []),
        seg(e.show, "head", true),
        seg(` ${e.label}`, "fg"),
      ]),
    ],
  });
  const name = VIEWS[view].title.toUpperCase();
  const full: Line[] = [
    title("MOVE"),
    ...rowsOf(move, true),
    { left: [seg("  WASD works like the arrow keys; letters work with Caps Lock on", "dim")] },
    { left: [] },
    title(name),
    ...rowsOf(own, true),
    { left: [] },
    title("GLOBAL"),
    ...rowsOf(global, true),
  ];
  const short = (wrapped: boolean): Line[] => [
    title("MOVE"),
    oneLine(move),
    title(name),
    ...rowsOf(own, wrapped),
    title("GLOBAL"),
    oneLine(global),
  ];
  return [full, short(true)].find((lines) => lines.length <= rows) ?? short(false);
}

function HelpPanel(props: { view: ViewId; width: number; height: number; t: Theme }) {
  const { t } = props;
  const width = Math.min(96, props.width - 2);
  const lines = helpLines(props.view, width - 4, props.height - 2);
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

/** The action menu's card, over whatever the body shows, with a blank cell around it. */
function MenuCard(props: { menu: MenuState; input: MenuInput; width: number; t: Theme }) {
  const { menu, input, t } = props;
  const items = menuItems(menu.target, input);
  const lines = menuLines(menu, items, menuRoot(menu.target, input.roots) !== undefined);
  const title = menuTitle(menu.target);
  const inner = Math.max(textWidth(title) + 2, ...lines.map((l) => segsWidth(l.left)), 24);
  const width = Math.min(props.width - 4, inner + 4);
  const height = lines.length + 2;
  return (
    <box
      position="absolute"
      top={1}
      left={Math.max(0, Math.floor((props.width - width) / 2) - 1)}
      width={width + 2}
      height={height + 2}
      padding={1}
      zIndex={10}
      backgroundColor={t.hex.bg}
    >
      <th-card
        title={title}
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
          hint(hintText(SETTINGS_KEYS.main)),
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
          hint(`● current · ${hintText(SETTINGS_KEYS.choice)}`),
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
          hint(hintText(SETTINGS_KEYS.tz)),
        ],
      };
    }
    case "accounts":
    case "rename": {
      const { start, shown } = windowAround(input.roots, s.pick, rows - 4);
      const labelOf = new Map(input.roots.map((r) => [r.identity, r.label]));
      // The roots each shares a subscription account with (T16), when any does.
      const shared = (r: RootInfo) =>
        r.group === null
          ? ""
          : `same as ${r.group.others.map((id) => labelOf.get(id) ?? "?").join(", ")}`;
      const sharing = input.roots.some((r) => r.group !== null);
      const lines = shown.map((r, i) =>
        picked(start + i === s.pick, [
          seg(r.enabled ? "● " : "○ ", r.enabled ? "live" : "dim"),
          seg(fit(r.label, 14), r.enabled ? "fg" : "dim"),
          seg(fit(r.provider, 7), "mute"),
          seg(fit(r.historyOnly ? "history only" : "", 13), "mid"),
          ...(sharing ? [seg(fit(shared(r), 24), "live")] : []),
          seg(r.path, "dim"),
        ]),
      );
      if (input.roots.length === 0) lines.push({ left: [seg("  no accounts found", "dim")] });
      const footerLines: Line[] =
        s.screen === "rename"
          ? [
              { left: [seg("new label ", "mute"), seg(`${s.text}▏`, "head")] },
              ...message,
              hint(hintText(SETTINGS_KEYS.rename)),
            ]
          : [...message, hint(hintText(SETTINGS_KEYS.accounts))];
      return { title: "Settings › Accounts", lines: [...lines, { left: [] }, ...footerLines] };
    }
    case "link": {
      const root = input.roots[s.pick];
      const candidates = root === undefined ? [] : linkCandidates(root, input.roots);
      const { start, shown } = windowAround(candidates, s.choice, rows - 5);
      return {
        title: "Settings › Accounts › Same account",
        lines: [
          {
            left: [
              seg(root?.label ?? "", "head", true),
              seg(" is on the same subscription account as:", "mute"),
            ],
          },
          ...shown.map((r, i) =>
            picked(start + i === s.choice, [
              seg(fit(r.label, 14), r.enabled ? "fg" : "dim"),
              seg(fit(r.provider, 7), "mute"),
              seg(r.path, "dim"),
            ]),
          ),
          { left: [] },
          ...message,
          hint(hintText(SETTINGS_KEYS.link)),
        ],
      };
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
  readonly menu: MenuState | null;
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
      height: rows,
      bp: breakpoint(width),
      theme: t,
      showCost: config.show_cost,
      tz: config.time_zone === "system" ? props.controller.systemZone : config.time_zone,
      scope: props.scope,
    };
    const sections = VIEWS[props.view].sections(props.vm, props.viewState, ctx);
    const byId = new Map(sections.map((s) => [s.id, s]));
    const fitted = fitSections(sections, rows);
    content = fitted.flatMap((f, i) => {
      const above = fitted[i - 1];
      const gap = above === undefined ? 0 : (byId.get(above.id)?.gap ?? 1);
      return [
        ...(gap > 0 ? [<box key={`gap-${f.id}`} height={gap} flexShrink={0} />] : []),
        <box key={f.id} flexDirection="column" height={f.height} flexShrink={0}>
          {byId.get(f.id)?.render(f.height)}
        </box>,
      ];
    });
  }
  return (
    <box flexDirection="column" height={height} flexShrink={0}>
      <Lines theme={t} lines={[top]} />
      {content}
      {props.menu === null ? null : (
        <MenuCard
          menu={props.menu}
          input={{ config, roots: props.roots, scope: props.scope }}
          width={width}
          t={t}
        />
      )}
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
  const footerRows = height >= TWO_LINE_FOOTER ? 2 : 1;
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
        height={height - CHROME_ROWS - footerRows}
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
        menu={state.menu}
      />
      <Lines theme={t} lines={[ruleLine(width), ...footer(state, width, footerRows)]} />
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
      props.controller.key({
        name: key.name,
        sequence: key.sequence,
        ctrl: key.ctrl,
        shift: key.shift,
      });
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
