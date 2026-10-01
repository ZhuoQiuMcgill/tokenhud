// `tokenhud --once`: the Overview, rendered once to stdout with the same view model and
// renderables as the TUI, at the terminal's width (or --width). ANSI colours on a TTY,
// plain text otherwise; never the alternate screen. It reads the store as it is, like
// `tokenhud json`, through a read-only connection, and so may run beside the TUI.
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { testRender } from "@opentui/react/test-utils";
import { type Config, configPath, loadConfig } from "../config.ts";
import { pricingOverridesPath, storePath } from "../paths.ts";
import { loadPriceTable } from "../pricing/overrides.ts";
import type { PriceTable } from "../pricing/table.ts";
import { Zone } from "../query/tz.ts";
import { StoreError } from "../store/errors.ts";
import { emptyStoreDatabase, openStoreReader } from "../store/store.ts";
import { frameToAnsi, frameToText } from "./ansi.ts";
import { MIN_WIDTH } from "./app.tsx";
import "./components/index.ts";
import { Lines } from "./elements.tsx";
import { clock } from "./format.ts";
import { headerLine, ruleLine } from "./frame.ts";
import { breakpoint } from "./layout.ts";
import { theme } from "./theme.ts";
import { overview } from "./views/overview.tsx";
import type { ViewContext } from "./views/types.ts";
import { computeOverview } from "./vm/compute.ts";
import {
  configuredLabels,
  createQueries,
  discoverRoots,
  displayAccounts,
  readStoreAccounts,
} from "./vm/session.ts";
import type { AccountInfo } from "./vm/types.ts";

export interface OnceInput {
  readonly db: Database;
  readonly prices: PriceTable;
  readonly config: Config;
  readonly accounts: readonly AccountInfo[];
  readonly width: number;
  readonly color: boolean;
  readonly now: number;
  /** The zone config's "system" means. */
  readonly systemZone: string;
}

/** The Overview as text: header, rule, then every section at its full height. */
export async function renderOverview(input: OnceInput): Promise<string> {
  const { config } = input;
  const tz = config.time_zone === "system" ? input.systemZone : config.time_zone;
  const zone = Zone.of(tz);
  const scoped = input.accounts.find((a) => a.label === config.account_scope) ?? null;
  const q = createQueries(input.db, input.prices, zone.name, () => input.now);
  const { vm } = q.snapshot(() =>
    computeOverview({
      q,
      now: input.now,
      zone,
      accounts: input.accounts,
      scope: scoped?.id ?? null,
      window: config.default_window,
    }),
  );
  const width = Math.max(MIN_WIDTH, input.width);
  const t = theme(config.theme);
  const ctx: ViewContext = {
    width,
    bp: breakpoint(width),
    theme: t,
    showCost: config.show_cost,
    tz,
    scope: scoped?.id ?? null,
  };
  const sections = overview.sections(vm, null, ctx);
  const height = 3 + sections.reduce((n, s) => n + s.height, 0) + sections.length - 1;
  const header = headerLine(width, {
    active: 0,
    scope: scoped?.label ?? "all accounts",
    status: { kind: "asof", time: clock(input.now, tz) },
  });
  const setup = await testRender(
    <box flexDirection="column" width={width} height={height} backgroundColor={t.hex.bg}>
      <Lines theme={t} lines={[header, ruleLine(width), { left: [] }]} />
      {sections.flatMap((s, i) => [
        ...(i > 0 ? [<box key={`gap-${s.id}`} height={1} flexShrink={0} />] : []),
        <box key={s.id} flexDirection="column" height={s.height} flexShrink={0}>
          {s.render(s.height)}
        </box>,
      ])}
    </box>,
    { width, height },
  );
  // testRender turns on React's act() checks, which only make sense in tests.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await setup.renderOnce();
    const frame = setup.captureSpans();
    return input.color ? frameToAnsi(frame, t.hex.bg) : frameToText(frame);
  } finally {
    setup.renderer.destroy();
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** The CLI side: the user's store, config and terminal. */
export async function runOnce(
  width: number | null,
  env: Env = process.env,
  home: string = homedir(),
): Promise<number> {
  const config = loadConfig(configPath(env, home));
  let db: Database;
  try {
    db = openStoreReader(storePath(env, home)) ?? emptyStoreDatabase();
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    process.stderr.write(`tokenhud: cannot read the store: ${error.message}\n`);
    return 1;
  }
  try {
    const labels = configuredLabels(discoverRoots(config, { home, env }));
    const tty = process.stdout.isTTY === true;
    const text = await renderOverview({
      db,
      prices: loadPriceTable(pricingOverridesPath(env, home)).table,
      config,
      accounts: displayAccounts(readStoreAccounts(db), labels, config),
      width: width ?? (tty ? process.stdout.columns : 120),
      color: tty && env.NO_COLOR === undefined,
      now: Date.now(),
      systemZone: Zone.system().name,
    });
    process.stdout.write(text);
    return 0;
  } finally {
    db.close();
  }
}
