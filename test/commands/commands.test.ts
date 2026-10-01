// `tokenhud json`, `doctor` and `import-cc-usage`, run as users run them: a fresh process
// with XDG_CONFIG_HOME pointing at a temp dir, which holds both tokenhud's config and a copy
// of the fixture cc-usage directory (a synthetic ledger and pricing.json).
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadPriceTable } from "../../src/pricing/overrides.ts";
import type {
  JsonAccountsDocument,
  JsonError,
  JsonModelsDocument,
  JsonUsageDocument,
} from "../../src/query/types.ts";
import { openStore } from "../../src/store/store.ts";
import expectedLedger from "../fixtures/store/cc-usage-ledger.expected.json";
import { cleanup, tempDir } from "../store/helpers.ts";

afterEach(cleanup);

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const FIXTURES = join(import.meta.dir, "..", "fixtures");

interface Env {
  xdg: string;
  cc: string;
  store: string;
  overrides: string;
}

/** A config home with cc-usage's fixture files in it, and no tokenhud store yet. */
function home(): Env {
  const xdg = tempDir();
  const cc = join(xdg, "cc-usage");
  mkdirSync(cc);
  copyFileSync(join(FIXTURES, "store", "cc-usage-ledger.sqlite3"), join(cc, "ledger.sqlite3"));
  copyFileSync(join(FIXTURES, "pricing", "cc-usage-user-pricing.json"), join(cc, "pricing.json"));
  return {
    xdg,
    cc,
    store: join(xdg, "tokenhud", "tokenhud.db"),
    overrides: join(xdg, "tokenhud", "pricing.overrides.json"),
  };
}

function run(env: Env, ...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: env.xdg, TZ: "America/Toronto" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function json<T>(env: Env, ...args: string[]): T {
  const out = run(env, "json", ...args);
  expect(out.stderr).toBe("");
  expect(out.code).toBe(0);
  return JSON.parse(out.stdout) as T;
}

function hashes(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((f) => [
        f,
        createHash("sha256")
          .update(readFileSync(join(dir, f)))
          .digest("hex"),
      ]),
  );
}

/** The fixture ledger's cost, row by row, at the given overrides. */
function referenceCost(overridesPath: string): number {
  const { table } = loadPriceTable(overridesPath);
  let total = 0;
  for (const r of expectedLedger.rows) {
    const cost = table.cost({
      model: r.model,
      tier: "standard",
      atMs: r.ts,
      input: r.inp,
      output: r.outp,
      cacheRead: r.cr,
      cacheCreation: r.cc,
      ephemeral5m: r.e5,
      ephemeral1h: r.e1,
    });
    if (typeof cost === "number") total += cost;
  }
  return total;
}

describe("import-cc-usage", () => {
  test("imports the ledger and edited prices once, and never changes cc-usage's files", () => {
    const env = home();
    const before = hashes(env.cc);
    const first = run(env, "import-cc-usage");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("16 rows read: 16 new, 0 updated, 0 already here, 0 skipped");
    expect(first.stdout).toContain("added overrides for claude-opus-4-7, my-local-model");
    // Opus 4.8 has a fast price in tokenhud, which a flat cc-usage card would drop.
    expect(first.stdout).toContain("warning: skipped your cc-usage price for claude-opus-4-8");
    expect(first.stdout).toContain("tokenhud prices it with a fast price");
    const overrides = JSON.parse(readFileSync(env.overrides, "utf8"));
    expect(overrides.models).toEqual({
      "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.5 },
      "my-local-model": { input: 0.5, output: 1.5 },
    });

    const second = run(env, "import-cc-usage");
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("16 rows read: 0 new, 0 updated, 16 already here, 0 skipped");
    expect(second.stdout).toContain("already overridden in tokenhud");
    expect(JSON.parse(readFileSync(env.overrides, "utf8"))).toEqual(overrides);
    expect(hashes(env.cc)).toEqual(before);
  });

  test("keeps the user's own tokenhud overrides", () => {
    const env = home();
    mkdirSync(join(env.xdg, "tokenhud"));
    writeFileSync(
      env.overrides,
      JSON.stringify({ models: { "Claude-Opus-4-7": { input: 1, output: 2 } }, note: "mine" }),
    );
    const out = run(env, "import-cc-usage");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("already overridden in tokenhud: claude-opus-4-7");
    const overrides = JSON.parse(readFileSync(env.overrides, "utf8"));
    expect(overrides.note).toBe("mine");
    expect(overrides.models["Claude-Opus-4-7"]).toEqual({ input: 1, output: 2 });
    expect(overrides.models["claude-opus-4-7"]).toBeUndefined();
    expect(overrides.models["my-local-model"]).toEqual({ input: 0.5, output: 1.5 });
  });

  test("skips an edit to a dated or fast-priced model, with a warning, and reprices nothing", () => {
    const env = home();
    // A hand-set GPT-5.6 Sol promo, and an edit to gpt-5.5, which has a fast price.
    writeFileSync(
      join(env.cc, "pricing.json"),
      JSON.stringify({
        models: {
          "gpt-5.6-sol": {
            input: 4,
            output: 20,
            cache_read: 0.4,
            cache_write: 5,
            long_context_threshold: 272000,
            long_context_input_multiplier: 2,
            long_context_output_multiplier: 1.5,
          },
          "gpt-5.5": { input: 4, output: 24, cache_read: 0.4 },
          "my-local-model": { input: 0.5, output: 1.5 },
        },
      }),
    );
    const out = run(env, "import-cc-usage");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("warning: skipped your cc-usage price for gpt-5.6-sol");
    expect(out.stdout).toContain("tokenhud prices it with dated prices and a fast price");
    expect(out.stdout).toContain("warning: skipped your cc-usage price for gpt-5.5");
    expect(out.stdout).toContain("add a dated entry by hand to");
    expect(out.stdout).toContain("added overrides for my-local-model");
    const overrides = JSON.parse(readFileSync(env.overrides, "utf8"));
    expect(Object.keys(overrides.models)).toEqual(["my-local-model"]);

    // Sol usage either side of its 2026-08-21T07:00Z cut, beside the fixture's gpt-5.5 rows.
    const store = openStore(env.store);
    const sol = (key: bigint, iso: string) => ({
      key,
      provider: "codex",
      identity: "fake-codex-identity",
      label: "codex-test",
      ts: Date.parse(iso),
      model: "gpt-5.6-sol",
      inp: 200_000,
      outp: 10_000,
      cr: 50_000,
      cc: 0,
      e5: null,
      e1: null,
      tier: 0,
    });
    store.upsert([sol(-77n, "2026-08-20T12:00:00Z"), sol(-78n, "2026-08-22T12:00:00Z")]);
    store.close();
    const withImport = json<JsonUsageDocument>(env, "usage", "--provider", "codex");
    rmSync(env.overrides);
    const bundledOnly = json<JsonUsageDocument>(env, "usage", "--provider", "codex");
    expect(withImport.totals.cost_usd).toBe(bundledOnly.totals.cost_usd);
    // Sol at its dated rates: $5/$30 then $4/$20, cache reads $0.50 then $0.40.
    const solCost =
      200_000 * 5e-6 +
      10_000 * 30e-6 +
      50_000 * 0.5e-6 +
      (200_000 * 4e-6 + 10_000 * 20e-6 + 50_000 * 0.4e-6);
    // The fixture's own Codex rows, all in May 2026.
    const fixtureCodex = json<JsonUsageDocument>(
      env,
      "usage",
      "--provider",
      "codex",
      "--since",
      "2026-05-01",
      "--until",
      "2026-06-01",
    );
    expect(withImport.totals.cost_usd).toBeCloseTo(fixtureCodex.totals.cost_usd + solCost, 6);
  });

  test("leaves a malformed overrides file alone and says so", () => {
    const env = home();
    mkdirSync(join(env.xdg, "tokenhud"));
    writeFileSync(env.overrides, "{ not json");
    const out = run(env, "import-cc-usage");
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("pricing     not imported");
    expect(readFileSync(env.overrides, "utf8")).toBe("{ not json");
    expect(out.stdout).toContain("16 new"); // the ledger still came over
  });

  test("with no cc-usage directory there is nothing to import", () => {
    const env = home();
    const out = run(env, "import-cc-usage", "--from", join(env.xdg, "nowhere"));
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("no cc-usage ledger found");
    expect(out.stdout).toContain("no edited prices");
  });

  test("bad arguments exit 2", () => {
    const env = home();
    expect(run(env, "import-cc-usage", "--bogus").code).toBe(2);
    expect(run(env, "import-cc-usage", "extra").code).toBe(2);
    const help = run(env, "import-cc-usage", "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("tokenhud import-cc-usage [--from DIR]");
  });
});

describe("json", () => {
  test("answers zeros without a store, and creates none", () => {
    const env = home();
    const doc = json<JsonUsageDocument>(env, "usage");
    expect(doc.schema).toBe(1);
    expect(doc.query).toBe("usage");
    expect(doc.period).toEqual({ name: "all", from: null, to: null, tz: "America/Toronto" });
    expect(doc.totals.cost_usd).toBe(0);
    expect(doc.totals.coverage.priced_pct).toBe(100);
    expect(doc.groups).toEqual([]);
    expect(doc.warnings).toEqual([]);
    expect(Date.parse(doc.generated_at)).toBeGreaterThan(0);
    expect(existsSync(env.store)).toBe(false);
  });

  test("usage totals equal the per-row cost of the imported ledger", () => {
    const env = home();
    expect(run(env, "import-cc-usage").code).toBe(0);
    const doc = json<JsonUsageDocument>(env, "usage", "--group-by", "account");
    expect(doc.totals.cost_usd).toBeCloseTo(referenceCost(env.overrides), 6);
    expect(doc.totals.records).toBe(16);
    expect(doc.totals.tokens.total).toBe(
      expectedLedger.rows.reduce((s, r) => s + r.inp + r.outp + r.cr + r.cc, 0),
    );
    expect(doc.totals.unpriced.map((u) => u.model).sort()).toEqual([
      "claude-mystery-1",
      "claude-\ufffd\ufffd\ufffd-odd",
    ]);
    const groups = doc.groups as unknown as Array<{ account: { label: string }; cost_usd: number }>;
    expect(groups.map((g) => g.account.label).sort()).toEqual(["codex", "personal", "work"]);
    const sum = groups.reduce((s, g) => s + g.cost_usd, 0);
    expect(sum).toBeCloseTo(doc.totals.cost_usd, 5);
  });

  test("groups by day in the asked zone, a custom period's last day included", () => {
    const env = home();
    run(env, "import-cc-usage");
    const doc = json<JsonUsageDocument>(
      env,
      "usage",
      "--group-by",
      "day",
      "--since",
      "2026-05-20",
      "--until",
      "2026-05-21",
      "--tz",
      "Asia/Kolkata",
    );
    expect(doc.period).toEqual({
      name: "custom",
      from: "2026-05-20T00:00:00.000+05:30",
      to: "2026-05-22T00:00:00.000+05:30",
      tz: "Asia/Kolkata",
    });
    expect(doc.groups.map((g) => (g as { key: string }).key)).toEqual(["2026-05-20", "2026-05-21"]);
  });

  test("models, filtered by account, and accounts", () => {
    const env = home();
    run(env, "import-cc-usage");
    const models = json<JsonModelsDocument>(env, "models", "--account", "Personal");
    expect(models.filter.accounts?.map((a) => a.label)).toEqual(["personal"]);
    expect(models.models.every((m) => m.model.startsWith("claude-"))).toBe(true);
    const opus = models.models.find((m) => m.model === "claude-opus-4-8");
    expect(opus?.rates).toEqual({
      input: 5,
      output: 25,
      cache_read: 0.5,
      cache_write: 6.25,
      long_context: null,
    });
    expect(models.models.find((m) => m.model === "claude-mystery-1")?.status).toBe("unpriced");

    const accounts = json<JsonAccountsDocument>(env, "accounts");
    expect(accounts.accounts.map((a) => [a.label, a.provider, a.records])).toEqual([
      ["personal", "claude", 10],
      ["work", "claude", 3],
      ["codex", "codex", 3],
    ]);
    expect(accounts.accounts[0]?.first_seen).toMatch(/^2026-05-\d\dT.*-04:00$/);
  });

  test("a malformed overrides file is a warning, not an error", () => {
    const env = home();
    mkdirSync(join(env.xdg, "tokenhud"));
    writeFileSync(env.overrides, "[]");
    const doc = json<JsonUsageDocument>(env, "usage");
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toContain("using bundled prices");
  });

  test.each([
    [[], "name a query"],
    [["bogus"], "unknown query"],
    [["usage", "extra"], "unexpected argument"],
    [["usage", "--period", "yesterday"], "unknown period"],
    [["usage", "--period", "custom"], "needs --since"],
    [["usage", "--period", "today", "--since", "2026-01-01"], "--since and --until need"],
    [["usage", "--since", "2026-02-30"], "--since must be"],
    [["usage", "--since", "0001-01-01"], "1970 or later"],
    [["usage", "--since", "1969-12-31T23:59:59Z"], "1970 or later"],
    [["usage", "--since", "2026-05-01T10:00"], "--since must be"],
    [["usage", "--since", "2026-05-02", "--until", "2026-05-01"], "--until must be after"],
    [["usage", "--group-by", "project"], "unknown group"],
    [["models", "--group-by", "day"], "usage query only"],
    [["accounts", "--provider", "codex"], "lists every account"],
    [["usage", "--provider", "gemini"], "unknown provider"],
    [["usage", "--tz", "Mars/Olympus"], "unknown time zone"],
    [["usage", "--account", "nobody"], "unknown account"],
    [["usage", "--bogus"], "--bogus"],
    [["usage", "--period"], "--period"],
  ])("%j exits 2 with a JSON error", (args, message) => {
    const out = run(home(), "json", ...args);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    const error = JSON.parse(out.stderr) as JsonError;
    expect(error.schema).toBe(1);
    expect(error.error.code).toBe("bad_argument");
    expect(error.error.message).toContain(message);
  });

  test("a store that can't be read exits 1 with a JSON error", () => {
    const env = home();
    mkdirSync(join(env.xdg, "tokenhud"));
    writeFileSync(env.store, "this is not a database, just text long enough to have a header");
    const out = run(env, "json", "usage");
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect((JSON.parse(out.stderr) as JsonError).error.code).toBe("store_error");
  });

  test("--help", () => {
    const out = run(home(), "json", "--help");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("tokenhud json usage");
  });
});

describe("doctor", () => {
  // Paths doctor may print: tokenhud's config files and cc-usage's directory.
  function onlyConfigPaths(env: Env, text: string): void {
    for (const line of text.split("\n")) {
      if (!line.includes(env.xdg)) continue;
      expect(
        [env.store, env.overrides, env.cc].some((p) => line.includes(p)),
        `unexpected path in: ${line}`,
      ).toBe(true);
    }
    expect(text).not.toMatch(/[\\/]\.claude|[\\/]\.codex|\.jsonl|credentials/);
  }

  test("on an empty config home", () => {
    const env = home();
    const out = run(env, "doctor");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("no store yet");
    expect(out.stdout).toContain("only there    16 rows: run tokenhud import-cc-usage");
    onlyConfigPaths(env, out.stdout);
    const report = JSON.parse(run(env, "doctor", "--json").stdout);
    expect(report.store.exists).toBe(false);
    expect(report.store.rollups).toBeNull();
    expect(report.pricing.priced_pct).toBe(100);
    expect(report.cc_usage).toMatchObject({
      ledger: true,
      last_import: null,
      rows_only_in_cc_usage: 16,
    });
    expect(existsSync(env.store)).toBe(false);
  });

  test("on an imported store", () => {
    const env = home();
    run(env, "import-cc-usage");
    const out = run(env, "doctor");
    expect(out.code).toBe(0);
    for (const text of [
      "rows          16  (claude 13 · codex 3)",
      "personal (claude) 10 rows",
      "schema        v3 · key scheme 2",
      "rollups       consistent (quick check)",
      "long context  indexed",
      "overrides",
      "unpriced      claude-mystery-1",
      "only there    0 rows",
    ]) {
      expect(out.stdout).toContain(text);
    }
    onlyConfigPaths(env, out.stdout);
    const doctorJson = run(env, "doctor", "--json");
    onlyConfigPaths(env, doctorJson.stdout);
    const report = JSON.parse(doctorJson.stdout);
    expect(report.store).toMatchObject({ exists: true, rows: 16, models: 5, schema_version: 3 });
    expect(report.store.rollups).toEqual({ triggers_intact: true, counts_agree: true });
    expect(report.store.imports).toHaveLength(1);
    expect(report.pricing.overrides.models).toBe(2);
    expect(report.pricing.unpriced.map((u: { model: string }) => u.model)).toContain(
      "claude-mystery-1",
    );
    expect(report.cc_usage.rows_only_in_cc_usage).toBe(0);
  });

  test("reports an unreadable store and still checks the rest", () => {
    const env = home();
    mkdirSync(join(env.xdg, "tokenhud"));
    writeFileSync(env.store, "this is not a database, just text long enough to have a header");
    const out = run(env, "doctor");
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("unreadable");
    expect(out.stdout).toContain("only there    16 rows");
    const report = JSON.parse(run(env, "doctor", "--json").stdout);
    expect(report.store.error).toBeString();
  });

  test("sweeps ledger copies a killed doctor left in the temp dir, and nothing else", () => {
    const env = home();
    const tmp = tempDir();
    const old = Date.now() / 1000 - 2 * 3600;
    for (const name of ["tokenhud-doctor-stale", "tokenhud-doctor-fresh", "someone-else-stale"]) {
      mkdirSync(join(tmp, name));
      writeFileSync(join(tmp, name, "ledger.sqlite3"), "x");
    }
    utimesSync(join(tmp, "tokenhud-doctor-stale"), old, old);
    utimesSync(join(tmp, "someone-else-stale"), old, old);
    const proc = Bun.spawnSync([process.execPath, CLI, "doctor"], {
      env: { ...process.env, XDG_CONFIG_HOME: env.xdg, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(readdirSync(tmp).sort()).toEqual(["someone-else-stale", "tokenhud-doctor-fresh"]);
  });

  test("bad arguments exit 2", () => {
    expect(run(home(), "doctor", "--bogus").code).toBe(2);
    expect(run(home(), "doctor", "--help").stdout).toContain("tokenhud doctor [--json]");
  });
});
