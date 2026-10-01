import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  configFromCcUsage,
  configPath,
  defaultConfig,
  ensureConfig,
  loadConfig,
  saveConfig,
  validateConfig,
  WINDOW_CHOICES,
} from "../src/config.ts";
import ccUsage from "./fixtures/config/cc-usage-config.json";
import ccUsageInvalid from "./fixtures/config/cc-usage-config-invalid.json";
import { cleanup, tempDir } from "./ingest/helpers.ts";

afterEach(cleanup);

// ── ported from cc-usage tests/test_config.py ─────────────────────────────────────

test("config_roundtrip", () => {
  const path = join(tempDir(), "config.json");
  const config: Config = {
    ...defaultConfig(),
    refresh_interval: 10,
    default_window: "5h",
    show_cost: false,
    theme: "light",
  };
  saveConfig(config, path);
  expect(loadConfig(path)).toEqual(config);
});

test("invalid_values_fall_back_to_defaults", () => {
  const path = join(tempDir(), "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      refresh_interval: 999,
      default_window: "weird",
      show_cost: "yes",
      theme: "neon",
    }),
  );
  const config = loadConfig(path);
  expect(config.refresh_interval).toBe(5);
  expect(config.default_window).toBe("all");
  expect(config.show_cost).toBe(true);
  expect(config.theme).toBe("dark");
});

test("missing_file_returns_defaults", () => {
  expect(loadConfig(join(tempDir(), "nope.json"))).toEqual(defaultConfig());
});

// ── tokenhud ─────────────────────────────────────────────────────────────────────

describe("validation never throws", () => {
  test.each([["not json"], ["[1, 2]"], ["null"], ['"string"'], ["42"], [""]])(
    "%j gives the defaults",
    (text) => {
      const path = join(tempDir(), "config.json");
      writeFileSync(path, text);
      expect(loadConfig(path)).toEqual(defaultConfig());
    },
  );

  test("bad roots and lists are dropped entry by entry", () => {
    expect(
      validateConfig({
        claude_roots: [
          { path: "/a", label: 5, enabled: "no" },
          { path: "" },
          null,
          { path: "/b", label: "b", enabled: false },
        ],
        disabled_roots: ["/x", 1, null],
        history_only_roots: ["0123456789abcdef0123456789abcdef", {}],
        account_scope: "",
      }),
    ).toEqual({
      ...defaultConfig(),
      claude_roots: [{ path: "/a" }, { path: "/b", label: "b", enabled: false }],
      disabled_roots: ["/x"],
      history_only_roots: ["0123456789abcdef0123456789abcdef"],
    });
  });

  test("the windows are today, this_week, this_month, all and the rolling 1h/5h/24h", () => {
    expect([...WINDOW_CHOICES].sort()).toEqual([
      "1h",
      "24h",
      "5h",
      "all",
      "this_month",
      "this_week",
      "today",
    ]);
    for (const w of WINDOW_CHOICES)
      expect(validateConfig({ default_window: w }).default_window).toBe(w);
    expect(validateConfig({ default_window: "7d" }).default_window).toBe("all");
  });
});

test("saving is atomic: the file is replaced whole and no temp file is left", () => {
  const dir = join(tempDir(), "nested", "tokenhud");
  const path = join(dir, "config.json");
  saveConfig({ ...defaultConfig(), theme: "light" }, path);
  saveConfig({ ...defaultConfig(), theme: "high-contrast" }, path);
  expect(readdirSync(dir)).toEqual(["config.json"]);
  expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("high-contrast");
});

test("saving validates first", () => {
  const path = join(tempDir(), "config.json");
  saveConfig({ ...defaultConfig(), theme: "neon" as Config["theme"] }, path);
  expect(loadConfig(path).theme).toBe("dark");
});

test("configPath follows XDG_CONFIG_HOME like the rest of tokenhud", () => {
  const home = join("/", "home", "someone");
  expect(configPath({}, home)).toBe(join(home, ".config", "tokenhud", "config.json"));
});

describe("configFromCcUsage", () => {
  test("maps roots, labels, disabled roots, theme, show-cost, refresh and 7d -> this_week", () => {
    expect(configFromCcUsage(ccUsage)).toEqual({
      refresh_interval: 10,
      default_window: "this_week",
      show_cost: false,
      theme: "light",
      account_scope: "all",
      claude_roots: [
        { path: "/home/example/.claude-work", label: "work", enabled: true },
        { path: "/mnt/c/Users/Example/.claude", label: "win", enabled: false },
        { path: "/srv/claude" },
      ],
      codex_roots: [{ path: "/mnt/c/Users/Example/.codex", label: "codex-win", enabled: true }],
      disabled_roots: ["/home/example/.claude-old"],
      history_only_roots: [],
    });
  });

  test("the other cc-usage windows carry over unchanged", () => {
    for (const w of ["all", "1h", "5h", "24h"] as const)
      expect(configFromCcUsage({ default_window: w }).default_window).toBe(w);
  });

  test("bad values give the defaults", () => {
    expect(configFromCcUsage(ccUsageInvalid)).toEqual(defaultConfig());
    expect(configFromCcUsage(null)).toEqual(defaultConfig());
    expect(configFromCcUsage([])).toEqual(defaultConfig());
  });
});

describe("ensureConfig: tokenhud owns its config, imported from cc-usage once", () => {
  function files() {
    const dir = tempDir();
    const own = join(dir, "tokenhud", "config.json");
    const theirs = join(dir, "cc-usage", "config.json");
    mkdirSync(join(dir, "cc-usage"));
    return { own, theirs };
  }

  test("the first run creates tokenhud's config from cc-usage's", () => {
    const { own, theirs } = files();
    writeFileSync(theirs, JSON.stringify(ccUsage));
    const first = ensureConfig(own, theirs);
    expect(first).toEqual({ config: configFromCcUsage(ccUsage), imported: true, saveError: null });
    expect(loadConfig(own)).toEqual(configFromCcUsage(ccUsage));
    expect(readdirSync(join(own, ".."))).toEqual(["config.json"]);
  });

  test("a later run reads only tokenhud's config, whatever cc-usage's says now", () => {
    const { own, theirs } = files();
    writeFileSync(theirs, JSON.stringify(ccUsage));
    ensureConfig(own, theirs);
    writeFileSync(theirs, JSON.stringify({ ...ccUsage, theme: "high-contrast", claude_roots: [] }));
    const second = ensureConfig(own, theirs);
    expect(second.imported).toBe(false);
    expect(second.config).toEqual(configFromCcUsage(ccUsage));
    rmSync(theirs);
    expect(ensureConfig(own, theirs).config).toEqual(configFromCcUsage(ccUsage));
  });

  test("without cc-usage's config: the defaults, and nothing is written", () => {
    const { own, theirs } = files();
    expect(ensureConfig(own, theirs)).toEqual({
      config: defaultConfig(),
      imported: false,
      saveError: null,
    });
    expect(existsSync(own)).toBe(false);
  });

  test("a damaged tokenhud config gives the defaults and is not replaced", () => {
    const { own, theirs } = files();
    writeFileSync(theirs, JSON.stringify(ccUsage));
    mkdirSync(join(own, ".."), { recursive: true });
    writeFileSync(own, "not json");
    expect(ensureConfig(own, theirs)).toEqual({
      config: defaultConfig(),
      imported: false,
      saveError: null,
    });
    expect(readFileSync(own, "utf8")).toBe("not json");
  });

  test("a cc-usage config that does not parse imports as the defaults", () => {
    const { own, theirs } = files();
    writeFileSync(theirs, "{");
    expect(ensureConfig(own, theirs)).toMatchObject({ config: defaultConfig(), imported: true });
    expect(loadConfig(own)).toEqual(defaultConfig());
  });
});
