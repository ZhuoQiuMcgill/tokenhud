import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LimitFetchError, SignedOut } from "../../src/limits/capture.ts";
import {
  type ClaudeFetchOptions,
  credentialsMtime,
  fetchClaudeLimits,
  type HttpFetch,
  type RefreshRun,
} from "../../src/limits/claude.ts";
import {
  CLAUDE_RESPONSE,
  cleanup,
  FAKE_TOKEN,
  FAKE_TOKEN_2,
  tempDir,
  writeCredentials,
} from "./helpers.ts";

afterEach(cleanup);

const NOW = Date.parse("2026-07-12T20:00:00Z");
const LATER = NOW + 3_600_000;

interface Seen {
  url: string;
  authorization: string | null;
  beta: string | null;
  userAgent: string | null;
  hasSignal: boolean;
}

/** HTTP that answers each request with the next of `responses` and records what it saw. */
function http(responses: (Response | Error)[]): { fetch: HttpFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      seen.push({
        url,
        authorization: headers.get("authorization"),
        beta: headers.get("anthropic-beta"),
        userAgent: headers.get("user-agent"),
        hasSignal: init.signal instanceof AbortSignal,
      });
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected request");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const ok = () => Response.json(CLAUDE_RESPONSE);

function options(over: Partial<ClaudeFetchOptions> = {}): ClaudeFetchOptions {
  return {
    now: () => NOW,
    which: (name) => (name === "claude" ? "/fake/bin/claude" : null),
    env: { PATH: "/usr/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", HOME: "/home/x" },
    runRefresh: async () => {
      throw new Error("no refresh expected");
    },
    ...over,
  };
}

describe("fetchClaudeLimits", () => {
  test("reads the OAuth token in memory and calls the usage endpoint with the beta", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, LATER);
    const h = http([ok()]);
    const capture = await fetchClaudeLimits(
      { path: dir, source: "auto" },
      options({ fetch: h.fetch, timeoutMs: 7000 }),
    );
    expect(h.seen).toEqual([
      {
        url: "https://api.anthropic.com/api/oauth/usage",
        authorization: `Bearer ${FAKE_TOKEN}`,
        beta: "oauth-2025-04-20",
        userAgent: expect.stringMatching(/^tokenhud\//),
        hasSignal: true,
      },
    ]);
    expect(capture).toMatchObject({ captured_at: NOW / 1000, source: "claude", via: "api" });
    expect(Object.keys(capture.rate_limits)).toEqual(["session", "weekly_all", "weekly_scoped"]);
    expect(JSON.stringify(capture)).not.toContain(FAKE_TOKEN);
  });

  test("an expired token is refreshed by the official client before the fetch", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, 1);
    const runs: RefreshRun[] = [];
    const h = http([ok()]);
    await fetchClaudeLimits(
      { path: dir, source: "config" },
      options({
        fetch: h.fetch,
        runRefresh: async (run) => {
          runs.push(run);
          writeCredentials(dir, FAKE_TOKEN_2, LATER);
          return "";
        },
      }),
    );
    expect(h.seen[0]?.authorization).toBe(`Bearer ${FAKE_TOKEN_2}`);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.argv).toEqual(["/fake/bin/claude", "--print", "--max-turns", "0", ""]);
    // That root's config dir, and none of the launching Claude Code session's variables.
    expect(runs[0]?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", CLAUDE_CONFIG_DIR: dir });
  });

  test("the default root refreshes with CLAUDE_CONFIG_DIR removed, not inherited", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, 1);
    let env: Record<string, string> = {};
    await fetchClaudeLimits(
      { path: dir, source: "auto" },
      options({
        fetch: http([ok()]).fetch,
        env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/some/other/account" },
        runRefresh: async (run) => {
          env = run.env;
          writeCredentials(dir, FAKE_TOKEN_2, LATER);
          return "";
        },
      }),
    );
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("a token still expired after the refresh run means not signed in here", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, 1);
    const h = http([]);
    const error = await fetchClaudeLimits(
      { path: dir, source: "config" },
      options({ fetch: h.fetch, runRefresh: async () => "OAuth session expired. Run /login" }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(SignedOut);
    expect(error.message).toBe("the Claude sign-in on this machine has expired");
    expect(h.seen).toHaveLength(0);
  });

  test("still expired with no recognisable output: cc-usage's message, still signed out", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, 1);
    const error = await fetchClaudeLimits(
      { path: dir, source: "config" },
      options({ fetch: http([]).fetch, runRefresh: async () => "" }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(SignedOut);
    expect(error.message).toBe("Claude credentials remain expired; run Claude Code to sign in");
  });

  test("no credential file: signed out, without a request or a refresh", async () => {
    const dir = tempDir();
    const h = http([]);
    const error = await fetchClaudeLimits(
      { path: dir, source: "home" },
      options({ fetch: h.fetch }),
    )
      .then(() => null)
      .catch((e) => e);
    expect(error).toBeInstanceOf(SignedOut);
    expect(h.seen).toHaveLength(0);
    expect(credentialsMtime(dir)).toBeNull();
  });

  test("a credential file without an OAuth login is signed out; a torn one is transient", async () => {
    const dir = tempDir();
    const path = writeCredentials(dir, FAKE_TOKEN, LATER);
    await Bun.write(path, JSON.stringify({ apiKeyHelper: "x" }));
    const signedOut = await fetchClaudeLimits({ path: dir, source: "home" }, options()).catch(
      (e) => e,
    );
    expect(signedOut).toBeInstanceOf(SignedOut);
    await Bun.write(path, '{"claudeAiOauth": {"accessToken": "sk-ant-oat01-FAKE');
    const torn = await fetchClaudeLimits({ path: dir, source: "home" }, options()).catch((e) => e);
    expect(torn).toBeInstanceOf(LimitFetchError);
    expect(torn).not.toBeInstanceOf(SignedOut);
    expect(credentialsMtime(dir)).toBeNumber();
  });

  test("a 401 refreshes once and retries", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, LATER);
    let refreshes = 0;
    const h = http([new Response("no", { status: 401 }), ok()]);
    const capture = await fetchClaudeLimits(
      { path: dir, source: "config" },
      options({
        fetch: h.fetch,
        runRefresh: async () => {
          refreshes++;
          writeCredentials(dir, FAKE_TOKEN_2, LATER);
          return "";
        },
      }),
    );
    expect(refreshes).toBe(1);
    expect(h.seen.map((s) => s.authorization)).toEqual([
      `Bearer ${FAKE_TOKEN}`,
      `Bearer ${FAKE_TOKEN_2}`,
    ]);
    expect(capture.source).toBe("claude");
  });

  test("a 401 after the refresh means the sign-in is not usable here", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, LATER);
    const h = http([new Response("no", { status: 401 }), new Response("no", { status: 401 })]);
    const error = await fetchClaudeLimits(
      { path: dir, source: "config" },
      options({ fetch: h.fetch, runRefresh: async () => "" }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(SignedOut);
    expect(h.seen).toHaveLength(2);
  });

  test.each([
    [new Response("busy", { status: 429 }), "Claude usage fetch failed: HTTP 429"],
    [new Response("oops", { status: 500 }), "Claude usage fetch failed: HTTP 500"],
    [new Response("<html>", { status: 200 }), "Claude returned an invalid usage response"],
    [Response.json({ limits: [] }), "Claude returned no usable usage limits"],
    [
      Object.assign(new Error("boom"), { code: "ECONNREFUSED" }),
      "Claude usage fetch failed: ECONNREFUSED",
    ],
    [new DOMException("t", "TimeoutError"), "Claude usage fetch failed: timed out"],
  ])("a failed request is a retryable LimitFetchError (%#)", async (response, message) => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, LATER);
    const error = await fetchClaudeLimits(
      { path: dir, source: "auto" },
      options({ fetch: http([response]).fetch }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(LimitFetchError);
    expect(error).not.toBeInstanceOf(SignedOut);
    expect(error.message).toBe(message);
  });

  test("an expired token with no claude executable is a retryable error", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, 1);
    const error = await fetchClaudeLimits(
      { path: dir, source: "auto" },
      options({ which: () => null }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(LimitFetchError);
    expect(error).not.toBeInstanceOf(SignedOut);
    expect(error.message).toContain("executable was not found");
  });

  (process.platform === "win32" ? test.skip : test)(
    "the refresh really runs the client, pointed at the account, stdin closed",
    async () => {
      const dir = tempDir();
      writeCredentials(dir, FAKE_TOKEN, 1);
      const seen = join(tempDir(), "seen.txt");
      const fresh = JSON.stringify({
        claudeAiOauth: { accessToken: FAKE_TOKEN_2, expiresAt: LATER },
      });
      const claude = join(tempDir(), "claude");
      writeFileSync(
        claude,
        [
          "#!/bin/sh",
          `printf '%s|' "$@" > '${seen}'`,
          `printf '%s|%s' "$CLAUDE_CONFIG_DIR" "\${CLAUDECODE:-unset}" >> '${seen}'`,
          `read -r line && printf 'stdin open' >> '${seen}'`,
          `printf '%s' '${fresh}' > "$CLAUDE_CONFIG_DIR/.credentials.json"`,
          "echo 'all good'",
        ].join("\n"),
      );
      chmodSync(claude, 0o755);
      const h = http([ok()]);
      await fetchClaudeLimits(
        { path: dir, source: "config" },
        {
          now: () => NOW,
          which: () => claude,
          fetch: h.fetch,
          env: { ...process.env, CLAUDECODE: "1" },
        },
      );
      expect(readFileSync(seen, "utf8")).toBe(`--print|--max-turns|0||${dir}|unset`);
      expect(h.seen[0]?.authorization).toBe(`Bearer ${FAKE_TOKEN_2}`);
    },
  );

  test("the credential file vanishing during the refresh run means signed out", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, 1);
    const error = await fetchClaudeLimits(
      { path: dir, source: "config" },
      options({
        runRefresh: async () => {
          rmSync(join(dir, ".credentials.json"));
          return "";
        },
      }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(SignedOut);
  });
});
