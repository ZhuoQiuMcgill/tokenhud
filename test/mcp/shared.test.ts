// T16 AC5: roots on one subscription account over MCP. A session from either root gets the
// account's windows and the pace of both roots together; `accounts` gives each root its
// group. T8's reading is real; its fetching is mocked.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupId } from "../../src/limits/groups.ts";
import type { Root } from "../../src/sources/roots.ts";
import { guard } from "../guard.ts";
import {
  capture,
  cleanup,
  connect,
  HOUR,
  type Machine,
  MIN,
  machine,
  NOW,
  rootNamed,
  usageRow,
  wire,
  writeLimits,
  writeStore,
} from "./helpers.ts";

guard();

afterEach(cleanup);

const DAY = 24 * HOUR;

interface Fixture {
  m: Machine;
  personal: Root;
  work: Root;
  refreshed: string[];
}

/**
 * `~/.claude` (personal) and `~/.claude-work` (work), linked in config as one account.
 * Opus at $5/M in: personal $5.00 at 14:50Z and $11.00 at 13:00Z; work $2.50 at 14:40Z.
 * limits.json holds personal's capture only: 95 % (5-HOUR, resets 15:38Z) and 40 %
 * (WEEKLY, resets Oct 4), 30 s old.
 */
function fixture(linked = true): Fixture {
  const m = machine();
  const personal = rootNamed(m, "personal");
  const work = rootNamed(m, "work");
  if (linked) {
    mkdirSync(join(m.xdg, "tokenhud"), { recursive: true });
    writeFileSync(
      join(m.xdg, "tokenhud", "config.json"),
      JSON.stringify({ same_account: [[personal.identity, work.identity]] }),
    );
  }
  writeStore(m, [
    usageRow(personal, NOW - 10 * MIN, { inp: 1_000_000, outp: 0 }),
    usageRow(personal, NOW - 2 * HOUR, { inp: 2_000_000, outp: 40_000 }),
    usageRow(work, NOW - 20 * MIN, { inp: 500_000, outp: 0 }),
  ]);
  writeLimits(m, {
    [personal.identity]: {
      capture: capture(NOW - 30_000, {
        session: { pct: 95, resetsAt: NOW + 38 * MIN },
        weekly_all: { pct: 40, resetsAt: NOW + 3 * DAY },
      }),
      status: { last_attempt_at: NOW - 30_000, next_at: NOW + 5 * MIN },
    },
  });
  return { m, personal, work, refreshed: [] };
}

async function serve(f: Fixture, env: Record<string, string> = {}) {
  const wiring = wire(f.m, {
    env: { ...f.m.env, ...env },
    refresh: async (account) => {
      f.refreshed.push(account);
    },
  });
  return connect(wiring);
}

describe("limits and should_wait for a session in either root", () => {
  test.each(["personal", "work"])(
    "from %s: the account's windows and combined pace",
    async (from) => {
      const f = fixture();
      const dir = from === "work" ? f.m.work : f.m.claude;
      const pipe = await serve(f, { CLAUDE_CONFIG_DIR: dir });
      const { value } = await pipe.call("limits");
      const other = from === "work" ? "personal" : "work";
      expect(value.account).toEqual({
        label: from,
        provider: "claude",
        config_dir: dir,
        signed_in: true,
        detected_via: "env",
        group: groupId([f.personal.identity, f.work.identity]),
        shared_with: [other],
      });
      // Pace: $5.00 (personal) + $2.50 (work) in the last 30 min = $15/h.
      // 5-HOUR from 10:38Z: $11 + $5 + $2.50 = $18.50 before the capture at 95 %, so
      // 0.95 / 18.5 per dollar; the last 5 % lasts 0.05 * 18.5 / (0.95 * 15) h = 233.684 s.
      // WEEKLY (T18): both roots' average since Sep 27 15:00Z, $18.50 over 96 h = $0.19/h;
      // 0.4 / 18.5 per dollar, so 0.6 * 96 / 0.4 = 144 h, after the Oct 4 reset: safe.
      expect(value.windows).toEqual([
        {
          kind: "session",
          label: "5-HOUR",
          utilization: 0.95,
          resets_at: "2026-10-01T15:38:00.000Z",
          pace_cost_per_h: 15,
          pace_basis: "30m",
          projected_exhaustion_at: "2026-10-01T15:03:53.684Z",
          projected_exhaustion_in_s: 233,
          stale_s: 30,
        },
        {
          kind: "weekly_all",
          label: "WEEKLY",
          utilization: 0.4,
          resets_at: "2026-10-04T15:00:00.000Z",
          pace_cost_per_h: 0.19,
          pace_basis: "window_avg",
          projected_exhaustion_at: "safe",
          projected_exhaustion_in_s: null,
          stale_s: 30,
        },
      ]);
      expect(f.refreshed).toEqual([from === "work" ? f.work.identity : f.personal.identity]);
    },
  );

  test("should_wait scales estimated_cost by both roots' spend", async () => {
    const f = fixture();
    const pipe = await serve(f, { CLAUDE_CONFIG_DIR: f.m.work });
    // WEEKLY: 0.4 + (0.4 / 18.5) * 9.25 = 0.6. Work's $2.50 alone would make it 1.88.
    const fits = await pipe.call("should_wait", { window: "weekly", estimated_cost: 9.25 });
    expect(fits.value).toMatchObject({ wait: false, window: "WEEKLY", utilization: 0.4 });
    expect(fits.value.reason).toContain("an estimated $9.25 takes WEEKLY to about 60%");
    const plain = await pipe.call("should_wait");
    expect(plain.value).toMatchObject({ wait: true, window: "5-HOUR", wait_s: 38 * 60 + 30 });
  });

  test("unlinked, the work session sees only its own (no) limits", async () => {
    const f = fixture(false);
    const pipe = await serve(f, { CLAUDE_CONFIG_DIR: f.m.work });
    const { value } = await pipe.call("limits");
    expect(value.account).toMatchObject({ label: "work", group: null, shared_with: [] });
    expect(value.windows).toEqual([]);
  });
});

test("accounts: every root with its group", async () => {
  const f = fixture();
  const pipe = await serve(f);
  const { value } = await pipe.call("accounts");
  const id = groupId([f.personal.identity, f.work.identity]);
  expect(
    (
      value.accounts as Array<{ label: string; group: string | null; signed_in: boolean | null }>
    ).map((a) => [a.label, a.group, a.signed_in]),
  ).toEqual([
    ["personal", id, true],
    // Never checked itself: its limits are read through personal.
    ["work", id, true],
    ["codex", null, null],
  ]);
});
