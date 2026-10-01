// Acceptance criterion 2: no credential value can reach a log, an error, the cache or a
// test snapshot. A fake token is pushed through every failure path, including ones where
// the HTTP layer itself echoes it back, and every output is searched for it. The source
// tree is then searched for credential access outside the limits module.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { LimitFetchError } from "../../src/limits/capture.ts";
import { fetchClaudeLimits, type HttpFetch, redact } from "../../src/limits/claude.ts";
import { Limits } from "../../src/limits/index.ts";
import { LimitsService } from "../../src/limits/service.ts";
import {
  CLAUDE_RESPONSE,
  cleanup,
  FAKE_TOKEN,
  FAKE_TOKEN_2,
  fakeRoot,
  tempDir,
  writeCredentials,
} from "./helpers.ts";

afterEach(cleanup);

const NOW = Date.parse("2026-07-12T20:00:00Z");
const LATER = NOW + 3_600_000;
const SECRETS = [FAKE_TOKEN, FAKE_TOKEN_2, `${FAKE_TOKEN}-refresh`, "FAKE0000TOKEN"];

/** Everything an error exposes, as text. */
function exposed(error: unknown): string {
  const e = error as Error & { cause?: unknown };
  return [
    String(e),
    e.message,
    e.stack ?? "",
    JSON.stringify(e),
    e.cause === undefined ? "" : exposed(e.cause),
  ].join("\n");
}

function expectClean(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

/** HTTP that leaks the request back in every way it can. */
const leaky: Record<string, HttpFetch> = {
  "throws with the headers in its message": async (_url, init) => {
    throw new Error(`connect failed: ${JSON.stringify(init.headers)}`);
  },
  "throws a coded error naming the token": async (_url, init) => {
    const auth = new Headers(init.headers).get("authorization");
    throw Object.assign(new Error(`ECONNRESET for ${auth}`), { code: "ECONNRESET", auth });
  },
  "answers 500 with the token in the body": async (_url, init) =>
    new Response(`bad ${new Headers(init.headers).get("authorization")}`, { status: 500 }),
  "answers 200 with a non-JSON body holding the token": async (_url, init) =>
    new Response(`<${new Headers(init.headers).get("authorization")}>`, { status: 200 }),
  "answers 200 with JSON echoing the token and no limits": async (_url, init) =>
    Response.json({ echo: new Headers(init.headers).get("authorization"), limits: [] }),
  "answers 401 twice": async () => new Response(FAKE_TOKEN, { status: 401 }),
};

describe("a fake token never leaves memory", () => {
  for (const [name, fetch] of Object.entries(leaky)) {
    test(`fetch error: HTTP ${name}`, async () => {
      const dir = tempDir();
      writeCredentials(dir, FAKE_TOKEN, LATER);
      const error = await fetchClaudeLimits(
        { path: dir, source: "config" },
        {
          fetch,
          now: () => NOW,
          which: () => "/fake/claude",
          runRefresh: async () => `refreshed ${FAKE_TOKEN} -> ${FAKE_TOKEN_2}`,
        },
      ).catch((e) => e);
      expect(error).toBeInstanceOf(LimitFetchError);
      expectClean(exposed(error));
    });
  }

  test("refresh errors: still expired, client missing, client output echoing tokens", async () => {
    for (const which of [() => "/fake/claude", () => null]) {
      const dir = tempDir();
      writeCredentials(dir, FAKE_TOKEN, 1);
      const error = await fetchClaudeLimits(
        { path: dir, source: "config" },
        {
          now: () => NOW,
          which,
          runRefresh: async () => `OAuth session expired for ${FAKE_TOKEN}`,
        },
      ).catch((e) => e);
      expect(error).toBeInstanceOf(LimitFetchError);
      expectClean(exposed(error));
    }
  });

  test("a successful capture holds no part of the response but the numbers", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, LATER);
    const capture = await fetchClaudeLimits(
      { path: dir, source: "config" },
      {
        now: () => NOW,
        fetch: async () => Response.json({ ...CLAUDE_RESPONSE, account: FAKE_TOKEN }),
      },
    );
    expectClean(JSON.stringify(capture));
  });

  test("logs, limits.json, outcomes and getLimits stay clean through the service", async () => {
    const dir = tempDir();
    const root = (label: string) =>
      fakeRoot("claude", label, join(dir, `.claude-${label}`), { source: "home" });
    const [a, b, c, d] = [root("a"), root("b"), root("c"), root("d")];
    const roots = [a, b, c, d];
    writeCredentials(a.path, FAKE_TOKEN, LATER); // fails with a leaky 500
    writeCredentials(b.path, FAKE_TOKEN, 1); // expired, refresh fails
    writeCredentials(c.path, FAKE_TOKEN, LATER); // succeeds
    // d has no credential file.
    const logs: string[] = [];
    const limitsPath = join(dir, "limits.json");
    const service = new LimitsService({
      limitsPath,
      roots: () => roots,
      fetchClaude: (root) =>
        fetchClaudeLimits(root, {
          now: () => NOW,
          which: () => "/fake/claude",
          runRefresh: async () => `still ${FAKE_TOKEN}`,
          fetch: async (_url, init) => {
            const auth = new Headers(init.headers).get("authorization") ?? "";
            if (root === a) return new Response(auth, { status: 500 });
            return Response.json({ ...CLAUDE_RESPONSE, echo: auth });
          },
        }),
      log: (level, message) => logs.push(`${level}: ${message}`),
      now: () => NOW,
    });
    const outcomes = await service.refresh(null, 0);
    expect(outcomes.map((o) => o.fetched)).toEqual([true, true, true, true]);
    expect(outcomes.map((o) => o.error === null)).toEqual([false, false, true, false]);
    const limits = new Limits({
      limitsPath,
      roots: () => roots,
      db: null,
      spend: null,
      now: () => NOW,
    });
    expect(logs.length).toBeGreaterThan(0);
    expectClean(logs.join("\n"));
    expectClean(JSON.stringify(outcomes));
    expectClean(readFileSync(limitsPath, "utf8"));
    expectClean(JSON.stringify(limits.getLimits()));
  });

  test("redact is the last line of defence for any message", () => {
    expect(redact(`a ${FAKE_TOKEN} b ${FAKE_TOKEN}`, FAKE_TOKEN)).toBe("a [redacted] b [redacted]");
    expect(redact("nothing", null)).toBe("nothing");
  });
});

describe("the source tree", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
      return [path];
    });
  }

  const rel = (path: string) => relative(ROOT, path).split("\\").join("/");

  test("only the Claude limits fetcher names the credential file or the OAuth fields", () => {
    const readers = files(join(ROOT, "src"))
      .filter((path) =>
        /\.credentials\.json|claudeAiOauth|accessToken/.test(readFileSync(path, "utf8")),
      )
      .map(rel);
    expect(readers).toEqual(["src/limits/claude.ts"]);
  });

  test("the limits module never writes to the console; it logs through its caller", () => {
    const offenders = files(join(ROOT, "src", "limits"))
      .filter((path) => /console\.|process\.std(out|err)/.test(readFileSync(path, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  test("no test snapshot exists to hold a credential", () => {
    const snapshots = files(join(ROOT, "test")).filter((path) =>
      /__snapshots__|\.snap$/.test(path),
    );
    for (const path of snapshots) expectClean(readFileSync(path, "utf8"));
    expect(snapshots.map(rel)).toEqual([]);
  });
});
