// Renaming accounts end to end (PM ruling for T10): the settings screen writes a config
// label for any root, the default ~/.claude and the CLAUDE_CONFIG_DIR root included; the
// label survives a restart; the TUI shows it at once; and the store takes it with that
// account's next ingested row, through the explicit-label path T4 added.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  defaultConfig,
  ensureConfig,
  loadConfig,
  saveConfig,
} from "../../src/config.ts";
import { IngestEngine } from "../../src/ingest/engine.ts";
import { rootIdentity } from "../../src/sources/roots.ts";
import { ledgerKey } from "../../src/store/key.ts";
import { openStoreReader } from "../../src/store/store.ts";
import { initialSettings, type SettingsState, settingsKey } from "../../src/tui/settings.ts";
import {
  configuredLabels,
  discoverRoots,
  displayAccounts,
  readStoreAccounts,
  rootInfos,
} from "../../src/tui/vm/session.ts";
import { claudeLine } from "../ingest/helpers.ts";

const dirs: string[] = [];
const engines: IngestEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

/** A home with ~/.claude and a CLAUDE_CONFIG_DIR root, one transcript line each. */
function place() {
  const base = mkdtempSync(join(tmpdir(), "tokenhud-rename-"));
  dirs.push(base);
  const home = join(base, "home");
  const defaultRoot = join(home, ".claude");
  const envRoot = join(base, "elsewhere", ".claude-company");
  const transcript = (root: string) => join(root, "projects", "p", "s.jsonl");
  for (const [root, id] of [
    [defaultRoot, "D1"],
    [envRoot, "E1"],
  ] as const) {
    mkdirSync(join(root, "projects", "p"), { recursive: true });
    writeFileSync(transcript(root), claudeLine(id, id, 100, 0, { ts: "2026-09-01T00:00:00Z" }));
  }
  const env = { CLAUDE_CONFIG_DIR: envRoot };
  return {
    base,
    home,
    env,
    configPath: join(base, "config", "tokenhud", "config.json"),
    storePath: join(base, "config", "tokenhud", "tokenhud.db"),
    defaultRoot,
    envRoot,
    transcript,
    identity: (root: string) => rootIdentity(root, home),
  };
}
type Place = ReturnType<typeof place>;

function engine(p: Place, config: Config): IngestEngine {
  const e = IngestEngine.open({
    storePath: p.storePath,
    cachePath: join(p.base, "cache.db"),
    config,
    discover: { home: p.home, env: p.env, wslUsersDir: null },
    importLedger: null,
    poolSize: 1,
  });
  engines.push(e);
  return e;
}

/** What cc-usage's import left: the account under the label cc-usage stored. */
function imported(e: IngestEngine, identity: string, label: string): void {
  e.store.upsert([
    {
      key: ledgerKey(`c\x1freq_FAKEold-${label}\x1fmsg_FAKEold-${label}`),
      provider: "claude",
      identity,
      label,
      ts: Date.parse("2026-01-01T00:00:00Z"),
      model: "claude-opus-4-8",
      inp: 1,
      outp: 1,
      cr: 0,
      cc: 0,
      e5: null,
      e1: null,
      tier: 0,
    },
  ]);
}

const storeLabel = (e: IngestEngine, identity: string) =>
  [...e.store.accounts().values()].find((a) => a.identity === identity)?.label;

/** The settings screen: Accounts, the root labelled `from`, `l`, a new label, Enter. */
function renameInSettings(p: Place, config: Config, from: string, to: string): Config {
  const roots = rootInfos(discoverRoots(config, { home: p.home, env: p.env }), config, p.home);
  const pick = roots.findIndex((r) => r.label === from);
  expect(pick).toBeGreaterThanOrEqual(0);
  const keys = [
    "end",
    "return",
    ...Array(pick).fill("down"),
    "l",
    ...Array(from.length).fill("backspace"),
    ...to,
    "return",
  ];
  let state: SettingsState | null = initialSettings();
  let out = config;
  for (const name of keys) {
    const r = settingsKey(
      state as SettingsState,
      { name, sequence: name.length === 1 ? name : "" },
      { config: out, roots, zones: ["system"], systemZone: "UTC" },
    );
    state = r.state;
    if (r.config) out = r.config;
  }
  expect(state).toMatchObject({ screen: "accounts", message: null });
  return out;
}

/** The labels the TUI shows: the store's accounts with configured labels laid over them. */
function shown(p: Place, config: Config): Record<string, string> {
  const db = openStoreReader(p.storePath);
  if (db === null) throw new Error("no store");
  try {
    const labels = configuredLabels(discoverRoots(config, { home: p.home, env: p.env }));
    return Object.fromEntries(
      readStoreAccounts(db).map((a) => [
        a.identity,
        displayAccounts([a], labels, config)[0]?.label ?? "",
      ]),
    );
  } finally {
    db.close();
  }
}

describe.each([
  ["the default root", "personal", "main", (p: Place) => p.defaultRoot],
  ["the CLAUDE_CONFIG_DIR root", "company", "client", (p: Place) => p.envRoot],
] as const)("renaming %s", (_name, before, after, rootOf) => {
  test("shows at once, survives a restart, and reaches the store with its next row", async () => {
    const p = place();
    const root = rootOf(p);
    const id = p.identity(root);
    saveConfig(defaultConfig(), p.configPath);

    // First run: the account as cc-usage's import left it, then a pass.
    const first = engine(p, loadConfig(p.configPath));
    imported(first, id, before);
    await first.fullPass();
    expect(storeLabel(first, id)).toBe(before);

    // Rename in settings and save, as the TUI does.
    const renamed = renameInSettings(p, loadConfig(p.configPath), before, after);
    saveConfig(renamed, p.configPath);
    expect(shown(p, renamed)[id]).toBe(after); // the TUI shows it at once
    await first.stop();
    engines.splice(engines.indexOf(first), 1);

    // Restart: the label comes back from config, by identity, for discovery and display.
    const config = loadConfig(p.configPath);
    const second = engine(p, config);
    const discovered = second.discover().find((r) => r.identity === id);
    expect(discovered).toMatchObject({ label: after, labelExplicit: true });
    expect(
      rootInfos(second.discover(), config, p.home).find((r) => r.identity === id),
    ).toMatchObject({ label: after, configIndex: 0 });
    await second.fullPass();
    // Nothing new to ingest yet: the store keeps the old label, the TUI shows the new one.
    expect(storeLabel(second, id)).toBe(before);
    expect(shown(p, config)[id]).toBe(after);

    // The account's next row carries the explicit label, and the store takes it.
    appendFileSync(
      p.transcript(root),
      claudeLine("N1", `N1${after}`, 50, 0, { ts: "2026-09-02T00:00:00Z" }),
    );
    await second.fullPass();
    expect(storeLabel(second, id)).toBe(after);
  });
});

test("an imported cc-usage label on the default root sticks: cc-usage's ignored entries aren't imported", async () => {
  const p = place();
  // A cc-usage config with an entry for ~/.claude, which cc-usage itself never applied.
  const theirs = join(p.base, "cc-usage-config.json");
  writeFileSync(theirs, JSON.stringify({ claude_roots: [{ path: "~/.claude", label: "main" }] }));
  const { config, imported: fromCcUsage } = ensureConfig(p.configPath, theirs, {
    home: p.home,
    env: p.env,
  });
  expect(fromCcUsage).toBe(true);
  expect(config.claude_roots).toEqual([]);

  const e = engine(p, config);
  const id = p.identity(p.defaultRoot);
  imported(e, id, "personal");
  appendFileSync(
    p.transcript(p.defaultRoot),
    claudeLine("N2", "N2", 50, 0, { ts: "2026-09-02T00:00:00Z" }),
  );
  await e.fullPass();
  expect(storeLabel(e, id)).toBe("personal");
  expect(shown(p, config)[id]).toBe("personal");
});
