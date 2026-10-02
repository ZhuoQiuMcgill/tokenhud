import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServerUnavailable, LimitFetchError, SignedOut } from "../../src/limits/capture.ts";
import {
  codexAuthMtime,
  codexExecutable,
  fetchCodexLimits,
  rpcError,
  runCodexRpc,
} from "../../src/limits/codex.ts";
import { guard } from "../guard.ts";
import { CODEX_RESPONSE, cleanup, stubExecutable, tempDir } from "./helpers.ts";

guard();

afterEach(cleanup);

// Ported from cc-usage's T14 tests: the RPC is driven for real against a stub process
// standing in for the `codex` CLI, because the failures under test live in the process
// plumbing itself. The stubs are POSIX shell scripts.
const posix = process.platform === "win32" ? test.skip : test;

const stub = (body: string) => stubExecutable("codex", body);

const run = (executable: string, timeoutMs = 5000) =>
  runCodexRpc({ codexHome: "/nonexistent/codex-home", executable, timeoutMs });

describe("runCodexRpc", () => {
  posix("a child that exits at once is unavailable, and says its status", async () => {
    const error = await run(stub("exit 2")).catch((e) => e);
    expect(error).toBeInstanceOf(CodexAppServerUnavailable);
    expect(error.message).toContain("status 2");
  });

  posix("a child that reads the request, then exits, never answered: unavailable", async () => {
    const error = await run(stub("read line\nexit 2")).catch((e) => e);
    expect(error).toBeInstanceOf(CodexAppServerUnavailable);
    expect(error.message).toContain("exited before accepting the request");
  });

  posix("a child that answered initialize, then hung up on stdin, stays retryable", async () => {
    const error = await run(
      stub(`read line\nexec 0<&-\nprintf '{"id":1,"result":{}}\\n'\nexec sleep 30`),
      1500,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(LimitFetchError);
    expect(error).not.toBeInstanceOf(CodexAppServerUnavailable);
  });

  posix("death after the handshake is retryable and still says what happened", async () => {
    const error = await run(stub(`read line\nprintf '{"id":1,"result":{}}\\n'\nexit 137`)).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(LimitFetchError);
    expect(error).not.toBeInstanceOf(CodexAppServerUnavailable);
    expect(error.message).toContain("137");
  });

  posix("valid JSON that is not an object is ignored, not a crash", async () => {
    const error = await run(
      stub(`read line\nprintf '123\\n[]\\n"nope"\\nnull\\nnot json\\n'`),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(CodexAppServerUnavailable);
  });

  posix("a JSON-RPC error is a retryable failure, reported by its code only", async () => {
    const error = await run(
      stub(
        `read a\nprintf '{"id":1,"result":{}}\\n'\nread b\nread c\nprintf '{"id":2,"error":{"code":-1,"message":"usage service unavailable"}}\\n'`,
      ),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(LimitFetchError);
    expect(error).not.toBeInstanceOf(CodexAppServerUnavailable);
    expect(error).not.toBeInstanceOf(SignedOut);
    expect(error.message).toBe("Codex rate-limit fetch failed (app-server error -1)");
  });

  posix("codex 0.135.0's answer for a home without a login is SignedOut", async () => {
    // The exact frame the real app-server sends offline with an empty CODEX_HOME.
    const error = await run(
      stub(
        `read a\nprintf '{"id":1,"result":{}}\\n'\nread b\nread c\nprintf '{"id":2,"error":{"code":-32600,"message":"codex account authentication required to read rate limits"}}\\n'`,
      ),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(SignedOut);
    expect(error.message).toBe("Codex is not signed in here");
  });

  posix("an abort kills the app-server and ends the fetch at once", async () => {
    const dir = tempDir();
    const pidFile = join(dir, "pid");
    const abort = new AbortController();
    const t0 = performance.now();
    const pending = runCodexRpc({
      codexHome: dir,
      executable: stub(`echo $$ > '${pidFile}'\nexec sleep 30`),
      timeoutMs: 20_000,
      signal: abort.signal,
    }).catch((e) => e);
    while (!existsSync(pidFile)) await Bun.sleep(5);
    abort.abort();
    const error = await pending;
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(error).toBeInstanceOf(LimitFetchError);
    expect(error.message).toBe("Codex limits fetch cancelled");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(); // the child is gone
  });

  posix("a silent child times out, retryably", async () => {
    const error = await run(stub("exec sleep 30"), 300).catch((e) => e);
    expect(error).toBeInstanceOf(LimitFetchError);
    expect(error).not.toBeInstanceOf(CodexAppServerUnavailable);
    expect(error.message).toBe("Codex rate-limit fetch timed out");
  });

  posix(
    "the conversation: initialize, initialized, then the read, with that CODEX_HOME",
    async () => {
      const dir = tempDir();
      const log = join(dir, "seen.txt");
      const body = JSON.stringify(CODEX_RESPONSE);
      const executable = stub(
        [
          `printf '%s\\n' "$@" > '${log}'`,
          `printf '%s\\n' "$CODEX_HOME" >> '${log}'`,
          `read a; printf '%s\\n' "$a" >> '${log}'`,
          `printf 'noise\\n{"method":"x"}\\n{"id":1,"result":{}}\\n'`,
          `read b; printf '%s\\n' "$b" >> '${log}'`,
          `read c; printf '%s\\n' "$c" >> '${log}'`,
          `printf '{"id":2,"result":%s}\\n' '${body}'`,
        ].join("\n"),
      );
      const capture = await fetchCodexLimits({
        codexHome: "/home/x/.codex",
        executable,
        now: () => 1_000_000,
      });
      expect(capture).toMatchObject({ captured_at: 1000, source: "codex", via: "rpc" });
      expect(Object.keys(capture.rate_limits)).toEqual(["codex_primary", "codex_spark_primary"]);
      const seen = readFileSync(log, "utf8").trim().split("\n");
      expect(seen[0]).toBe("app-server");
      expect(seen[1]).toBe("/home/x/.codex");
      expect(JSON.parse(seen[2] as string)).toMatchObject({
        method: "initialize",
        id: 1,
        params: { clientInfo: { name: "tokenhud" } },
      });
      expect(JSON.parse(seen[3] as string)).toEqual({ method: "initialized" });
      expect(JSON.parse(seen[4] as string)).toEqual({ method: "account/rateLimits/read", id: 2 });
    },
  );
});

describe("app-server errors become fixed messages", () => {
  // The shape codex-cli 0.135.0 reports when the backend refuses the login (body made up).
  const refused = [
    "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; content-type=text/plain; body={",
    '  "error": {"message": "Could not parse your authentication token. FAKE0000TOKEN"},',
    '  "status": 401',
    "}",
  ].join("\n");

  test.each([
    [{ code: -32603, message: refused }, true, "Codex is not signed in here (HTTP 401)"],
    [
      { code: -32600, message: "codex account authentication required to read rate limits" },
      true,
      "Codex is not signed in here",
    ],
    [
      { message: "chatgpt authentication required to read rate limits" },
      true,
      "Codex is not signed in here",
    ],
    [{ message: "Not logged in. Run codex login" }, true, "Codex is not signed in here"],
    [
      { message: "GET /x failed: 403 Forbidden; body=FAKE0000TOKEN" },
      true,
      "Codex is not signed in here (HTTP 403)",
    ],
    // A 429 whose body happens to hold "401" is a 429: the body is never looked at.
    [
      { message: 'GET /x failed: 429 Too Many Requests; body={"id":"req-401-FAKE0000TOKEN"}' },
      false,
      "Codex rate-limit fetch failed: HTTP 429",
    ],
    [
      { message: 'unexpected status 500: {"detail":"FAKE0000TOKEN unauthorized"}' },
      false,
      "Codex rate-limit fetch failed: HTTP 500",
    ],
    [
      { message: "upstream timeout body: <html>FAKE0000TOKEN</html>" },
      false,
      "Codex rate-limit fetch failed (app-server error)",
    ],
    [
      { code: 7, message: "x".repeat(500) },
      false,
      "Codex rate-limit fetch failed (app-server error 7)",
    ],
    ["plain", false, "Codex rate-limit fetch failed (app-server error)"],
    [42, false, "Codex rate-limit fetch failed (app-server error)"],
  ])("%p", (error, signedOut, message) => {
    const mapped = rpcError(error);
    expect(mapped instanceof SignedOut).toBe(signedOut);
    expect(mapped).toBeInstanceOf(LimitFetchError);
    expect(mapped.message).toBe(message);
  });

  test("auth.json is only stat-ed", () => {
    const home = tempDir();
    expect(codexAuthMtime(home)).toBeNull();
    writeFileSync(join(home, "auth.json"), "{}");
    expect(codexAuthMtime(home)).toBeNumber();
  });
});

describe("starting the app-server", () => {
  test("no executable on PATH is permanent", async () => {
    expect(codexExecutable(() => null)).toBeNull();
    const error = await runCodexRpc({ codexHome: "/x", executable: null }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexAppServerUnavailable);
  });

  test("a spawn that fails transiently is retryable; a vanished executable is permanent", async () => {
    const failWith = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    for (const code of ["ENOMEM", "EAGAIN", "ETXTBSY"]) {
      const error = await runCodexRpc({
        codexHome: "/x",
        executable: "/fake/codex",
        spawn: failWith(code),
      }).catch((e) => e);
      expect(error).toBeInstanceOf(LimitFetchError);
      expect(error).not.toBeInstanceOf(CodexAppServerUnavailable);
    }
    const gone = await runCodexRpc({
      codexHome: "/x",
      executable: "/fake/codex",
      spawn: failWith("ENOENT"),
    }).catch((e) => e);
    expect(gone).toBeInstanceOf(CodexAppServerUnavailable);
  });

  test("a real spawn of a missing path is permanent", async () => {
    const error = await runCodexRpc({
      codexHome: "/x",
      executable: join(tempDir(), "no-such-codex"),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexAppServerUnavailable);
  });
});
