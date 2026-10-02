import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLimitsCache } from "../../src/limits/cache.ts";
import {
  type Capture,
  CodexAppServerUnavailable,
  LimitFetchError,
  SignedOut,
} from "../../src/limits/capture.ts";
import { credentialsMtime, fetchClaudeLimits } from "../../src/limits/claude.ts";
import { codexAuthMtime, fetchCodexLimits } from "../../src/limits/codex.ts";
import { Limits } from "../../src/limits/index.ts";
import { LimitsService, type LimitsServiceOptions } from "../../src/limits/service.ts";
import type { Root } from "../../src/sources/roots.ts";
import { guard } from "../guard.ts";
import {
  capture,
  cleanup,
  FAKE_TOKEN,
  fakeRoot,
  posixOnly,
  stubExecutable,
  tempDir,
  writeCredentials,
} from "./helpers.ts";

guard();

afterEach(cleanup);

const T0 = Date.parse("2026-10-01T12:00:00Z");
const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;

type Fetcher = (root: Root) => Promise<Capture>;

/** A service over fake roots and fetchers with a hand-driven clock. */
function harness(roots: Root[], over: Partial<LimitsServiceOptions> = {}) {
  const dir = tempDir();
  const clock = { now: T0 };
  const calls: string[] = [];
  const state = {
    claude: (async () => capture("claude", clock.now / 1000, {})) as Fetcher,
    codex: (async () => capture("codex", clock.now / 1000, {})) as Fetcher,
    snapshots: new Map<string, Capture>(),
    mtime: 1 as number | null,
    logs: [] as string[],
    changed: [] as string[],
    recorded: [] as [string, number][],
  };
  const limitsPath = join(dir, "limits.json");
  const service = new LimitsService({
    limitsPath,
    roots: () => roots,
    fetchClaude: (root) => {
      calls.push(root.label);
      return state.claude(root);
    },
    fetchCodex: (root) => {
      calls.push(root.label);
      return state.codex(root);
    },
    snapshots: () => state.snapshots,
    credentialsMtime: () => state.mtime,
    usesRpc: (root) => root.provider === "codex" && root.source === "auto",
    recordEvents: (root, c) => state.recorded.push([root.label, c.captured_at]),
    onChanged: (ids) => state.changed.push(...ids),
    log: (level, message) => state.logs.push(`${level}: ${message}`),
    now: () => clock.now,
    ...over,
  });
  const file = () => loadLimitsCache(limitsPath);
  return { service, clock, calls, state, file, limitsPath, dir };
}

const at = (ms: number, pct = 10, resetsIn = HOUR) =>
  capture("codex", ms / 1000, {
    codex_primary: { pct, resets: (ms + resetsIn) / 1000, minutes: 300 },
  });

describe("Codex precedence: the freshest of snapshot, last-good and RPC", () => {
  const codex = () => fakeRoot("codex", "codex", "/home/x/.codex", { source: "auto" });

  test("a fresher rollout snapshot beats an older RPC capture", async () => {
    const root = codex();
    const h = harness([root]);
    h.state.snapshots.set(root.identity, at(T0, 28));
    h.state.codex = async () => at(T0 - HOUR, 5);
    await h.service.refreshDue();
    expect(h.file().providers[root.identity]?.rate_limits.codex_primary?.used_percentage).toBe(28);
  });

  test("a fresher RPC capture beats an older snapshot", async () => {
    const root = codex();
    const h = harness([root]);
    h.state.snapshots.set(root.identity, at(T0 - 2 * HOUR, 28));
    h.state.codex = async () => ({ ...at(T0, 5), via: "rpc" });
    await h.service.refreshDue();
    const stored = h.file().providers[root.identity];
    expect(stored?.rate_limits.codex_primary?.used_percentage).toBe(5);
    expect(stored?.via).toBe("rpc");
  });

  test("another Codex home never gets the RPC: its snapshot alone", async () => {
    const def = codex();
    const win = fakeRoot("codex", "codex-win", "/mnt/c/Users/x/.codex", { source: "wsl" });
    const h = harness([def, win]);
    h.state.snapshots.set(def.identity, at(T0, 10));
    h.state.snapshots.set(win.identity, at(T0 - 99 * HOUR, 28));
    h.state.codex = async () => at(T0 + 10 * S, 99);
    await h.service.refreshDue();
    expect(h.calls).toEqual(["codex"]);
    const file = h.file();
    expect(file.providers[def.identity]?.rate_limits.codex_primary?.used_percentage).toBe(99);
    expect(file.providers[win.identity]?.rate_limits.codex_primary?.used_percentage).toBe(28);
  });

  test("on a captured_at tie the snapshot beats last-good, as in cc-usage", async () => {
    const win = fakeRoot("codex", "codex-win", "/mnt/c/Users/x/.codex", { source: "wsl" });
    const h = harness([win]);
    writeFileSync(h.limitsPath, JSON.stringify({ providers: { [win.identity]: at(T0, 11) } }));
    h.state.snapshots.set(win.identity, { ...at(T0, 22), via: "rollout" });
    await h.service.refreshDue();
    expect(h.file().providers[win.identity]?.rate_limits.codex_primary?.used_percentage).toBe(22);
  });

  test("the last-good capture survives when its snapshot is gone", async () => {
    const win = fakeRoot("codex", "codex-win", "/mnt/c/Users/x/.codex", { source: "wsl" });
    const h = harness([win]);
    h.state.snapshots.set(win.identity, at(T0, 28));
    await h.service.refreshDue();
    h.state.snapshots.clear();
    h.clock.now += 10 * MIN;
    await h.service.refreshDue();
    expect(h.file().providers[win.identity]?.rate_limits.codex_primary?.used_percentage).toBe(28);
  });
});

describe("the Codex app-server latch", () => {
  const codex = () => fakeRoot("codex", "codex", "/home/x/.codex", { source: "auto" });

  test("a permanent failure is asked once per process, and still reported", async () => {
    const root = codex();
    const h = harness([root]);
    h.state.codex = async () => {
      throw new CodexAppServerUnavailable("Codex app-server exited (status 2)");
    };
    await h.service.refreshDue();
    h.clock.now += HOUR;
    await h.service.refreshDue();
    await h.service.refresh(null, 0);
    expect(h.calls).toEqual(["codex"]);
    expect(h.service.codexLatch).toContain("status 2");
    const outcome = await h.service.refresh(root.identity, 0);
    expect(outcome[0]?.error).toContain("status 2"); // nothing covers it: surfaced
  });

  test("the failure is not shown while a snapshot covers the account", async () => {
    const root = codex();
    const h = harness([root]);
    h.state.snapshots.set(root.identity, at(T0, 28));
    h.state.codex = async () => {
      throw new LimitFetchError("Codex app-server closed before returning rate limits");
    };
    h.clock.now += 10 * S;
    const [outcome] = await h.service.refresh(root.identity, 0);
    expect(outcome).toEqual({ account: root.identity, fetched: true, error: null });
    expect(h.file().providers[root.identity]?.rate_limits.codex_primary?.used_percentage).toBe(28);
  });

  test("a transient failure is retried after its back-off", async () => {
    const root = codex();
    const h = harness([root]);
    h.state.codex = async () => {
      throw new LimitFetchError("Codex rate-limit fetch timed out");
    };
    await h.service.refreshDue();
    h.clock.now += 31 * S;
    await h.service.refreshDue();
    expect(h.calls).toEqual(["codex", "codex"]);
    expect(h.service.codexLatch).toBeNull();
  });
});

describe("cadence, back-off and rate limits", () => {
  test("every 5 minutes per account; the round says when the next is due", async () => {
    const root = fakeRoot("claude", "personal", "/home/x/.claude", { source: "auto" });
    const h = harness([root]);
    expect(await h.service.refreshDue()).toBe(5 * MIN);
    h.clock.now += 4 * MIN;
    expect(await h.service.refreshDue()).toBe(MIN);
    h.clock.now += MIN;
    await h.service.refreshDue();
    expect(h.calls).toEqual(["personal", "personal"]);
  });

  test("errors back off exponentially from 30 s to 30 minutes, keeping last-good", async () => {
    const root = fakeRoot("claude", "personal", "/home/x/.claude", { source: "auto" });
    const h = harness([root]);
    await h.service.refreshDue();
    const good = h.file().providers[root.identity];
    const attempts: number[] = [];
    h.state.claude = async () => {
      attempts.push(h.clock.now);
      throw new LimitFetchError("Claude usage fetch failed: HTTP 500");
    };
    h.clock.now += 5 * MIN;
    // Each round wakes when the next account is due, at the latest after 5 minutes.
    while (attempts.length < 10) h.clock.now += await h.service.refreshDue();
    const gaps = attempts.slice(1).map((t, i) => (t - (attempts[i] as number)) / S);
    expect(gaps).toEqual([30, 60, 120, 240, 480, 960, 1800, 1800, 1800]);
    expect(h.calls).toHaveLength(11);
    const file = h.file();
    expect(file.providers[root.identity]).toEqual(good as Capture);
    expect(file.status[root.identity]).toMatchObject({ errors: 10, signed_in: true });
    h.state.claude = async () => capture("claude", h.clock.now / 1000, {});
    h.clock.now = (attempts[9] as number) + 30 * MIN;
    await h.service.refreshDue();
    expect(h.file().status[root.identity]).toMatchObject({ errors: 0, last_error: null });
  });

  test("on demand: fresh enough data is not fetched; Claude at most once per 30 s", async () => {
    const root = fakeRoot("claude", "personal", "/home/x/.claude", { source: "auto" });
    const h = harness([root]);
    await h.service.refresh("personal", 60);
    h.clock.now += 20 * S;
    expect((await h.service.refresh("personal", 60))[0]?.fetched).toBe(false);
    expect((await h.service.refresh(root.identity, 0))[0]?.fetched).toBe(false); // < 30 s
    h.clock.now += 11 * S;
    expect((await h.service.refresh(root.identity, 0))[0]?.fetched).toBe(true);
    expect(h.calls).toEqual(["personal", "personal"]);
    expect(await h.service.refresh("nobody", 0)).toEqual([]);
  });

  test("on demand respects the back-off after a failure", async () => {
    const root = fakeRoot("claude", "personal", "/home/x/.claude", { source: "auto" });
    const h = harness([root]);
    h.state.claude = async () => {
      throw new LimitFetchError("Claude usage fetch failed: HTTP 429");
    };
    await h.service.refresh(null, 60);
    h.clock.now += 31 * S;
    await h.service.refresh(null, 60); // second failure: back-off now 60 s
    h.clock.now += 45 * S;
    const [outcome] = await h.service.refresh(null, 60);
    expect(outcome).toEqual({
      account: root.identity,
      fetched: false,
      error: "Claude usage fetch failed: HTTP 429",
    });
    expect(h.calls).toHaveLength(2);
  });

  test("concurrent requests for one account share one fetch", async () => {
    const root = fakeRoot("claude", "personal", "/home/x/.claude", { source: "auto" });
    const h = harness([root]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.state.claude = async () => {
      await gate;
      return capture("claude", h.clock.now / 1000, {});
    };
    const requests = [
      h.service.refresh("personal", 60),
      h.service.refresh(root.identity, 60),
      h.service.refreshDue(),
    ];
    release();
    const [a, b] = await Promise.all(requests);
    expect(h.calls).toEqual(["personal"]);
    expect(a).toEqual(b as typeof a);
  });

  test("nothing escapes: an unexpected exception or a failing account list", async () => {
    const root = fakeRoot("claude", "personal", "/home/x/.claude", { source: "auto" });
    const h = harness([root]);
    h.state.claude = async () => {
      throw new TypeError("boom");
    };
    const [outcome] = await h.service.refresh(null, 0);
    expect(outcome?.error).toBe("limits fetch failed unexpectedly (TypeError)");
    const broken = harness([], {
      roots: () => {
        throw new Error("discovery exploded");
      },
    });
    expect(await broken.service.refresh(null, 0)).toEqual([]);
    expect(await broken.service.refreshDue()).toBe(5 * MIN);
    expect(broken.state.logs.join("\n")).toContain("cannot list accounts");
  });

  test("changes are announced and every round records events", async () => {
    const root = fakeRoot("claude", "personal", "/home/x/.claude", { source: "auto" });
    const h = harness([root]);
    await h.service.refreshDue();
    h.clock.now += MIN;
    await h.service.refreshDue(); // not due: no change, events still re-applied
    expect(h.state.changed).toEqual([root.identity]);
    expect(h.state.recorded).toEqual([
      ["personal", T0 / 1000],
      ["personal", T0 / 1000],
    ]);
  });
});

describe("history-only accounts", () => {
  test("in history_only_roots: never fetched, signed out, last-good still shown", async () => {
    const root = fakeRoot("claude", "elsewhere", "/home/x/.claude-elsewhere", {
      historyOnly: true,
    });
    const h = harness([root]);
    writeFileSync(
      h.limitsPath,
      JSON.stringify({
        providers: { [root.identity]: capture("claude", T0 / 1000 - 600, {}) },
      }),
    );
    await h.service.refreshDue();
    await h.service.refresh(null, 0);
    expect(h.calls).toEqual([]);
    expect(h.file().status[root.identity]).toMatchObject({
      signed_in: false,
      history_only: "config",
    });
  });

  test("a missing credential file: signed_in false, no attempt within the day, data still shown", async () => {
    const dir = tempDir();
    const root = fakeRoot("claude", "elsewhere", join(dir, ".claude-elsewhere"), {
      source: "home",
    });
    let requests = 0;
    const h = harness([root], {
      // The real fetcher over a config dir without .credentials.json; HTTP must never run.
      fetchClaude: (r) => {
        h.calls.push(r.label);
        return fetchClaudeLimits(r, {
          fetch: async () => {
            requests++;
            return new Response("{}");
          },
        });
      },
      credentialsMtime: (r) => credentialsMtime(r.path),
    });
    // Last-good windows, e.g. imported from cc-usage, from when it was signed in here.
    const lastGood = capture("claude", T0 / 1000 - 3 * 86_400, {
      weekly_all: { pct: 9, resets: T0 / 1000 + 86_400, label: "WEEKLY" },
    });
    writeFileSync(h.limitsPath, JSON.stringify({ providers: { [root.identity]: lastGood } }));

    await h.service.refreshDue();
    for (let t = 5 * MIN; t < 24 * HOUR; t += 5 * MIN) {
      h.clock.now = T0 + t;
      await h.service.refreshDue();
      await h.service.refresh("elsewhere", 60);
    }
    expect(h.calls).toEqual(["elsewhere"]);
    expect(requests).toBe(0);
    expect(h.file().status[root.identity]).toMatchObject({
      signed_in: false,
      history_only: "detected",
      cred_mtime: null,
    });

    const limits = new Limits({
      limitsPath: h.limitsPath,
      roots: () => [root],
      db: null,
      spend: null,
      now: () => h.clock.now,
    });
    const shown = limits.getLimits("elsewhere");
    expect(shown?.account.signed_in).toBe(false);
    expect(shown?.windows.map((w) => [w.label, w.utilization])).toEqual([["WEEKLY", 0.09]]);
    expect(shown?.as_of).toBe(T0 - 3 * 86_400_000);

    h.clock.now = T0 + 24 * HOUR;
    await h.service.refreshDue(); // the daily re-check
    expect(h.calls).toEqual(["elsewhere", "elsewhere"]);
  });

  test("an expired sign-in the client cannot refresh is history-only until the file changes", async () => {
    const root = fakeRoot("claude", "elsewhere", "/home/x/.claude-elsewhere", { source: "home" });
    const h = harness([root]);
    h.state.claude = async () => {
      throw new SignedOut("the Claude sign-in on this machine has expired");
    };
    await h.service.refreshDue();
    h.clock.now += 2 * HOUR;
    await h.service.refreshDue();
    await h.service.refresh(null, 0);
    expect(h.calls).toEqual(["elsewhere"]);
    expect(h.state.logs).toEqual([
      "info: limits: elsewhere is not signed in here (the Claude sign-in on this machine has expired); history only",
    ]);
    // The user signs in again: the credential file changes, and the next round fetches.
    h.state.mtime = 2;
    h.state.claude = async () => capture("claude", h.clock.now / 1000, {});
    await h.service.refreshDue();
    expect(h.calls).toEqual(["elsewhere", "elsewhere"]);
    expect(h.file().status[root.identity]).toMatchObject({ signed_in: true, history_only: null });
  });

  test("a root taken out of history_only_roots is fetched again", async () => {
    const root = fakeRoot("claude", "elsewhere", "/home/x/.claude-elsewhere", {
      historyOnly: true,
    });
    const roots = [root];
    const h = harness(roots);
    await h.service.refreshDue();
    roots[0] = { ...root, historyOnly: false };
    await h.service.refreshDue();
    expect(h.calls).toEqual(["elsewhere"]);
    expect(h.file().status[root.identity]?.signed_in).toBe(true);
  });
});

describe("a Codex home whose login is refused", () => {
  test("is history-only: no app-server within the day, again once auth.json changes", async () => {
    const root = fakeRoot("codex", "codex", "/home/x/.codex", { source: "auto" });
    const h = harness([root]);
    h.state.snapshots.set(root.identity, at(T0 - HOUR, 40));
    h.state.codex = async () => {
      throw new SignedOut("Codex rate-limit fetch failed: GET ... failed: 401 Unauthorized");
    };
    await h.service.refreshDue();
    for (let t = 5 * MIN; t < 6 * HOUR; t += 5 * MIN) {
      h.clock.now = T0 + t;
      await h.service.refreshDue();
      await h.service.refresh(null, 0);
    }
    expect(h.calls).toEqual(["codex"]);
    expect(h.file().status[root.identity]).toMatchObject({
      signed_in: false,
      history_only: "detected",
    });
    // Its rollout snapshot still shows.
    expect(h.file().providers[root.identity]?.rate_limits.codex_primary?.used_percentage).toBe(40);
    h.state.mtime = 99; // `codex login` rewrote auth.json
    await h.service.refreshDue();
    expect(h.calls).toEqual(["codex", "codex"]);
  });
});

describe("transient failures never sign an account out", () => {
  const lastGood = capture("claude", T0 / 1000 - 600, {
    session: { pct: 40, resets: T0 / 1000 + 3600, label: "5-HOUR" },
  });

  function signedInRoot(over: Partial<LimitsServiceOptions> = {}) {
    const dir = tempDir();
    const root = fakeRoot("claude", "personal", join(dir, ".claude"), { source: "auto" });
    const h = harness([root], { credentialsMtime: (r) => credentialsMtime(r.path), ...over });
    writeFileSync(h.limitsPath, JSON.stringify({ providers: { [root.identity]: lastGood } }));
    return { root, h };
  }

  test("an offline refresh run: back-off, last-good kept and shown stale, still signed in", async () => {
    let requests = 0;
    const { root, h } = signedInRoot({
      fetchClaude: (r, signal) => {
        h.calls.push(r.label);
        return fetchClaudeLimits(r, {
          signal,
          which: () => "/fake/claude",
          runRefresh: async () =>
            "API Error: Connection error. getaddrinfo EAI_AGAIN api.anthropic.com",
          fetch: async () => {
            requests++;
            return new Response("{}");
          },
        });
      },
    });
    writeCredentials(root.path, FAKE_TOKEN, 1); // expired; the client cannot reach the server
    await h.service.refreshDue();
    h.clock.now += 30 * S;
    await h.service.refreshDue();
    h.clock.now += 60 * S;
    await h.service.refreshDue();
    expect(h.calls).toHaveLength(3); // backing off, not given up for the day
    expect(requests).toBe(0);
    expect(h.file().status[root.identity]).toMatchObject({
      signed_in: true,
      history_only: null,
      errors: 3,
    });
    const shown = new Limits({
      limitsPath: h.limitsPath,
      roots: () => [root],
      db: null,
      spend: null,
      now: () => h.clock.now,
    }).getLimits("personal");
    expect(shown?.account.signed_in).toBe(true);
    expect(shown?.windows.map((w) => w.utilization)).toEqual([0.4]);
    expect(shown?.windows[0]?.stale_s).toBe(690);
    expect(shown?.error).toBe("Claude credentials are expired and the refresh did not complete");
  });

  test.each([
    ["offline", Object.assign(new Error("x"), { code: "ConnectionRefused" })],
    ["DNS", Object.assign(new Error("x"), { code: "ENOTFOUND" })],
    ["a timeout", new DOMException("t", "TimeoutError")],
    ["a 500", 500],
    ["a 429", 429],
  ])("%s: back-off from 30 s, still signed in", async (_name, failure) => {
    let requests = 0;
    const { root, h } = signedInRoot({
      fetchClaude: (r, signal) =>
        fetchClaudeLimits(r, {
          signal,
          // The token expires an hour after T0 on the harness's clock. On the wall clock it
          // expired on 2026-10-01, and the fetcher then ran the refresh instead: the real
          // `claude` from PATH, against the real home (an "auto" root), never the fetch.
          now: () => h.clock.now,
          which: () => null,
          fetch: async () => {
            requests++;
            if (typeof failure === "number") return new Response("", { status: failure });
            throw failure;
          },
        }),
    });
    writeCredentials(root.path, FAKE_TOKEN, T0 + HOUR);
    await h.service.refreshDue();
    expect(requests).toBe(1);
    expect(h.file().status[root.identity]).toMatchObject({
      signed_in: true,
      history_only: null,
      errors: 1,
      next_at: T0 + 30 * S,
    });
    expect(h.file().providers[root.identity]).toEqual(lastGood);
  });
});

describe("a Codex home without a login", () => {
  (posixOnly ? test.skip : test)(
    "codex 0.135.0's 'authentication required': at most one app-server spawn a day",
    async () => {
      const dir = tempDir();
      const spawns = join(dir, "spawns.txt");
      const executable = stubExecutable(
        "codex",
        [
          `echo spawn >> '${spawns}'`,
          `read a; printf '{"id":1,"result":{}}\\n'; read b; read c`,
          `printf '{"id":2,"error":{"code":-32600,"message":"codex account authentication required to read rate limits"}}\\n'`,
        ].join("\n"),
      );
      const root = fakeRoot("codex", "codex", join(dir, ".codex"), { source: "auto" });
      const h = harness([root], {
        fetchCodex: (r, signal) => fetchCodexLimits({ codexHome: r.path, executable, signal }),
        credentialsMtime: (r) => codexAuthMtime(r.path), // no auth.json: null, unchanged
      });
      const count = () => readFileSync(spawns, "utf8").trim().split("\n").length;
      await h.service.refreshDue();
      for (let t = 5 * MIN; t < 24 * HOUR; t += 5 * MIN) {
        h.clock.now = T0 + t;
        await h.service.refreshDue();
        await h.service.refresh(null, 0);
      }
      expect(count()).toBe(1);
      expect(h.file().status[root.identity]).toMatchObject({
        signed_in: false,
        history_only: "detected",
        last_error: "Codex is not signed in here",
      });
      h.clock.now = T0 + 24 * HOUR; // the daily re-check
      await h.service.refreshDue();
      expect(count()).toBe(2);
      mkdirSync(root.path, { recursive: true });
      writeFileSync(join(root.path, "auth.json"), "{}"); // `codex login`: checked at once
      h.clock.now += 5 * MIN;
      await h.service.refreshDue();
      expect(count()).toBe(3);
    },
  );
});

describe("stop()", () => {
  const claudeRoot = () => fakeRoot("claude", "personal", "/home/x/.claude", { source: "auto" });

  test("aborts a fetch in flight, returns at once, and leaves the account unmarked", async () => {
    const root = claudeRoot();
    const h = harness([root], {
      fetchClaude: (_r, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new LimitFetchError("Claude limits fetch cancelled")),
          );
        }),
    });
    const pending = h.service.refresh(null, 0);
    await Bun.sleep(20);
    const t0 = performance.now();
    await h.service.stop();
    expect(performance.now() - t0).toBeLessThan(500);
    expect((await pending)[0]?.fetched).toBe(true);
    expect(h.file().status[root.identity]).toMatchObject({ errors: 0, last_error: null });
  });

  test("returns within 2 s even if a fetcher ignores the abort", async () => {
    const h = harness([claudeRoot()], { fetchClaude: () => new Promise(() => {}) });
    void h.service.refresh(null, 0);
    await Bun.sleep(20);
    const t0 = performance.now();
    await h.service.stop();
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  (posixOnly ? test.skip : test)("kills a hanging app-server within 2 s", async () => {
    const dir = tempDir();
    const pidFile = join(dir, "pid");
    const executable = stubExecutable("codex", `echo $$ > '${pidFile}'\nexec sleep 30`);
    const root = fakeRoot("codex", "codex", join(dir, ".codex"), { source: "auto" });
    const h = harness([root], {
      fetchCodex: (r, signal) => fetchCodexLimits({ codexHome: r.path, executable, signal }),
    });
    void h.service.refresh(null, 0);
    while (!existsSync(pidFile)) await Bun.sleep(5);
    const t0 = performance.now();
    await h.service.stop();
    expect(performance.now() - t0).toBeLessThan(2000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("first run and the schedule", () => {
  test("cc-usage's cache is imported once, before the first round", async () => {
    const dir = tempDir();
    const root = fakeRoot("claude", "personal", "/home/x/.claude", { source: "auto" });
    const cc = join(dir, "provider-limits.json");
    const old = capture("claude", T0 / 1000 - 600, { session: { pct: 19, resets: T0 / 1000 } });
    writeFileSync(cc, JSON.stringify({ providers: { "claude:laptop": old } }));
    const h = harness([root], {
      ccUsageLimits: cc,
      knownAccounts: () => [{ provider: "claude", identity: root.identity, label: "laptop" }],
    });
    expect(h.service.importIfFirstRun()).toBe(1);
    expect(h.file().providers[root.identity]).toEqual({ ...old, via: "cc-usage" });
    expect(h.service.importIfFirstRun()).toBe(0); // limits.json exists now
  });

  test("start runs a round at once, stop waits for it and ends the schedule", async () => {
    const root = fakeRoot("claude", "personal", "/home/x/.claude", { source: "auto" });
    const h = harness([root]);
    h.service.start();
    for (let i = 0; i < 100 && h.calls.length === 0; i++) await Bun.sleep(5);
    await h.service.stop();
    expect(h.calls).toEqual(["personal"]);
    h.service.start(); // a stopped service stays stopped
    await Bun.sleep(20);
    expect(h.calls).toEqual(["personal"]);
  });
});
