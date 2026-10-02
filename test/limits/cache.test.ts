import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ccUsageLimitsPath,
  importCcUsageLimits,
  initialStatus,
  limitsPath,
  loadLimitsCache,
  saveLimitsCache,
  updateLimitsCache,
} from "../../src/limits/cache.ts";
import { normalizeClaudeLimits, normalizeCodexLimits } from "../../src/limits/capture.ts";
import { guard } from "../guard.ts";
import { CLAUDE_RESPONSE, CODEX_RESPONSE, capture, cleanup, tempDir } from "./helpers.ts";

guard();

afterEach(cleanup);

const ID_A = "0000000000000000000000000000000a";
const ID_B = "0000000000000000000000000000000b";

describe("limits.json", () => {
  test("paths follow the config dir rules", () => {
    const home = join("/home", "x");
    expect(limitsPath({}, home)).toBe(join(home, ".config", "tokenhud", "limits.json"));
    const xdg = join(home, "xdg");
    expect(limitsPath({ XDG_CONFIG_HOME: xdg }, home)).toBe(join(xdg, "tokenhud", "limits.json"));
    expect(ccUsageLimitsPath({}, home)).toBe(
      join(home, ".config", "cc-usage", "provider-limits.json"),
    );
  });

  test("round-trips captures and status, in cc-usage's capture shape", () => {
    const path = join(tempDir(), "limits.json");
    const file = {
      providers: {
        [ID_A]: normalizeClaudeLimits(CLAUDE_RESPONSE, 10),
        [ID_B]: normalizeCodexLimits(CODEX_RESPONSE, 20),
      },
      status: { [ID_A]: { ...initialStatus(), errors: 2, last_error: "HTTP 500", next_at: 99 } },
    };
    saveLimitsCache(file, path);
    expect(loadLimitsCache(path)).toEqual(file);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.providers[ID_A].rate_limits.session).toEqual({
      label: "5-HOUR",
      used_percentage: 26,
      resets_at: 1_783_903_800,
    });
    expect(readdirSync(join(path, ".."))).toEqual(["limits.json"]); // no temp file left
  });

  test("a missing, damaged or foreign file loads empty; bad entries are dropped", () => {
    const dir = tempDir();
    const empty = { providers: {}, status: {} };
    expect(loadLimitsCache(join(dir, "none.json"))).toEqual(empty);
    const path = join(dir, "limits.json");
    writeFileSync(path, "{not json");
    expect(loadLimitsCache(path)).toEqual(empty);
    writeFileSync(path, "[1, 2]");
    expect(loadLimitsCache(path)).toEqual(empty);
    writeFileSync(
      path,
      JSON.stringify({
        providers: { [ID_A]: { captured_at: "x" }, [ID_B]: capture("codex", 5, {}) },
        status: { [ID_A]: "nope", [ID_B]: { signed_in: false, errors: -3, history_only: "maybe" } },
      }),
    );
    expect(loadLimitsCache(path)).toEqual({
      providers: { [ID_B]: capture("codex", 5, {}) },
      status: { [ID_B]: { ...initialStatus(), signed_in: false } },
    });
  });

  test("an update re-reads the file and replaces a capture only with a fresher one", () => {
    const path = join(tempDir(), "limits.json");
    const newer = capture("claude", 200, { session: { pct: 50, resets: 900 } });
    const older = capture("claude", 100, { session: { pct: 10, resets: 900 } });
    // Another process wrote a newer capture meanwhile.
    saveLimitsCache({ providers: { [ID_A]: newer }, status: {} }, path);
    const status = { ...initialStatus(), last_attempt_at: 150 };
    const merged = updateLimitsCache(
      path,
      new Map([
        [ID_A, { capture: older, status }],
        [ID_B, { capture: capture("codex", 1, {}) }],
      ]),
    );
    expect(merged.providers[ID_A]).toEqual(newer);
    expect(merged.status[ID_A]).toEqual(status);
    expect(loadLimitsCache(path)).toEqual(merged);
  });
});

describe("importing cc-usage's provider-limits.json", () => {
  function ccUsageFile(providers: Record<string, unknown>): string {
    const path = join(tempDir(), "provider-limits.json");
    writeFileSync(path, JSON.stringify({ providers }));
    return path;
  }

  test("keys by provider and label map to identities; store labels first", () => {
    const claude = normalizeClaudeLimits(CLAUDE_RESPONSE, 10);
    const codex = normalizeCodexLimits(CODEX_RESPONSE, 20);
    const path = ccUsageFile({
      "claude:personal": claude,
      "claude:laptop": claude,
      "codex:codex": codex,
      "claude:gone": claude,
      claude: claude,
      "codex:personal": claude,
    });
    const imported = importCcUsageLimits(path, [
      { provider: "claude", identity: ID_A, label: "personal" },
      { provider: "claude", identity: ID_B, label: "laptop" },
      // The discovered root's derived label for the same account differs, and comes later.
      { provider: "claude", identity: "c".repeat(32), label: "laptop" },
      { provider: "codex", identity: "d".repeat(32), label: "codex" },
      { provider: "codex", identity: "e".repeat(32), label: "personal" },
    ]);
    expect(Object.keys(imported).sort()).toEqual([ID_A, ID_B, "d".repeat(32)].sort());
    expect(imported[ID_A]).toEqual({ ...claude, via: "cc-usage" });
    expect(imported["d".repeat(32)]?.source).toBe("codex");
  });

  test("a missing or damaged file imports nothing", () => {
    expect(importCcUsageLimits(join(tempDir(), "none.json"), [])).toEqual({});
    const path = join(tempDir(), "bad.json");
    writeFileSync(path, "{");
    expect(importCcUsageLimits(path, [])).toEqual({});
  });
});
