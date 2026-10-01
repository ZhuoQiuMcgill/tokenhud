import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.ts";
import { type Capture, LimitFetchError, normalizeClaudeLimits, SignedOut } from "./capture.ts";

/**
 * Claude's current limits, ported from cc-usage's `fetch_claude_limits`.
 *
 * Claude has no account RPC, so the OAuth access token in the account's
 * `<config dir>/.credentials.json` is read for one read-only request to the usage endpoint
 * Claude Code itself uses. This module is the only code in tokenhud allowed to read a
 * credential (AGENT_RULEBOOK hard rule 3), and only in memory:
 * - the token lives in local variables for the length of one fetch;
 * - no error message, log line, cache entry or return value contains it, the credential
 *   file's contents, or the raw response (errors are built from fixed text, an HTTP status
 *   or an error name, and every message is passed through `redact` regardless);
 * - an expired token is never refreshed here: the official `claude` client refreshes it
 *   through an empty zero-turn invocation, pointed at the same config dir.
 *
 * macOS keeps Claude's credentials in the Keychain rather than this file; like cc-usage,
 * tokenhud does not read the Keychain, so such an account reads as not signed in here.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_TIMEOUT_MS = 15_000;
/** A token this close to its expiry is refreshed first, as cc-usage does. */
const EXPIRY_MARGIN_MS = 30_000;
/** How much of the refresh run's output is kept (in memory, only to look for a sign-in error). */
const OUTPUT_LIMIT = 64 * 1024;
/**
 * What the official client prints when the sign-in itself is gone. Only matched, never
 * stored or shown. The definitive signal is still the token: unchanged and expired after
 * the refresh run.
 */
const SIGNED_OUT_OUTPUT = /oauth (session|token) (has )?expired|run \/login|not logged in/i;
/**
 * Variables that tie a process to the Claude Code session that launched tokenhud (the MCP
 * server runs inside one). The refresh run must behave like a fresh terminal's.
 */
const SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
];

/** The account to fetch: a Claude root's config dir and how it was discovered. */
export interface ClaudeAccount {
  path: string;
  /** The default `~/.claude` ("auto") refreshes with CLAUDE_CONFIG_DIR unset. */
  source: string;
}

export interface RefreshRun {
  argv: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

/** Runs the official client; resolves with its combined output (truncated), never rejects on exit status. */
export type RefreshRunner = (run: RefreshRun) => Promise<string>;

/** `fetch`'s signature, narrowed to what this module calls. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ClaudeFetchOptions {
  timeoutMs?: number;
  /** Tests inject HTTP; the default is the global `fetch`. */
  fetch?: HttpFetch;
  /** Tests inject the refresh run; the default spawns the executable. */
  runRefresh?: RefreshRunner;
  /** Finds the `claude` executable; tests inject it. */
  which?: (name: string) => string | null;
  env?: Readonly<Record<string, string | undefined>>;
  /** Epoch ms. */
  now?: () => number;
}

export function credentialsPath(configDir: string): string {
  return join(configDir, ".credentials.json");
}

/** The credential file's mtime (epoch ms), or null when it is missing; reads no contents. */
export function credentialsMtime(configDir: string): number | null {
  try {
    return statSync(credentialsPath(configDir)).mtimeMs;
  } catch {
    return null;
  }
}

/** Replaces every occurrence of `secret` in `text`, as a last line of defence. */
export function redact(text: string, secret: string | null): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

interface OAuth {
  accessToken: string;
  /** Epoch ms, when the file says. */
  expiresAt: number | null;
}

/** Reads the OAuth login from the credential file. Nothing read is ever echoed. */
function readOAuth(path: string): OAuth {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SignedOut("no Claude credentials in this config dir");
    }
    throw new LimitFetchError("Claude OAuth credentials are unavailable");
  }
  let oauth: unknown;
  try {
    const data: unknown = JSON.parse(text);
    oauth = typeof data === "object" && data !== null ? Reflect.get(data, "claudeAiOauth") : null;
  } catch {
    // A half-written file while the client saves it: try again later.
    throw new LimitFetchError("Claude OAuth credentials are unavailable");
  }
  if (typeof oauth !== "object" || oauth === null) {
    throw new SignedOut("no Claude OAuth sign-in in this config dir");
  }
  const token: unknown = Reflect.get(oauth, "accessToken");
  if (typeof token !== "string" || token === "") {
    throw new SignedOut("no Claude OAuth sign-in in this config dir");
  }
  const expires: unknown = Reflect.get(oauth, "expiresAt");
  return {
    accessToken: token,
    expiresAt: typeof expires === "number" && Number.isFinite(expires) ? expires : null,
  };
}

function expired(oauth: OAuth, now: number): boolean {
  return oauth.expiresAt !== null && oauth.expiresAt <= now + EXPIRY_MARGIN_MS;
}

/** Spawns the client with stdin closed and its output captured in memory, bounded. */
async function spawnRefresh(run: RefreshRun): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(run.argv, {
      env: run.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: run.timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    throw new LimitFetchError(`Claude credential refresh failed to start (${code})`);
  }
  const read = async (stream: ReadableStream<Uint8Array>) => {
    let out = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      if (out.length < OUTPUT_LIMIT) out += decoder.decode(chunk, { stream: true });
    }
    return out.slice(0, OUTPUT_LIMIT);
  };
  const [stdout, stderr] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
  return `${stdout}\n${stderr}`;
}

/**
 * cc-usage's `_refresh_claude_credentials`: runs `claude --print --max-turns 0 ""` against
 * the account's config dir, then reads the token again. The default root runs with
 * CLAUDE_CONFIG_DIR removed (cc-usage inherited the env; removing it keeps a session
 * launched for another account from refreshing that one instead), every other root with
 * CLAUDE_CONFIG_DIR set to its dir. A token still expired afterwards means the sign-in is
 * gone: `SignedOut`.
 */
async function refresh(
  account: ClaudeAccount,
  before: OAuth,
  options: ClaudeFetchOptions,
  timeoutMs: number,
): Promise<OAuth> {
  const which = options.which ?? ((name: string) => Bun.which(name));
  const executable =
    process.platform === "win32" ? (which("claude.exe") ?? which("claude")) : which("claude");
  if (executable === null) {
    throw new LimitFetchError("Claude credentials expired and the Claude executable was not found");
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined && !SESSION_ENV.includes(name)) env[name] = value;
  }
  if (account.source === "auto") delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = account.path;
  const output = await (options.runRefresh ?? spawnRefresh)({
    argv: [executable, "--print", "--max-turns", "0", ""],
    env,
    timeoutMs,
  });
  const after = readOAuth(credentialsPath(account.path));
  const now = (options.now ?? Date.now)();
  if (after.accessToken === before.accessToken && expired(after, now)) {
    throw new SignedOut(
      SIGNED_OUT_OUTPUT.test(output)
        ? "the Claude sign-in on this machine has expired"
        : "Claude credentials remain expired; run Claude Code to sign in",
    );
  }
  return after;
}

/** A failed request's description: the error's name only, so no URL, header or body can leak. */
function describe(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "timed out";
  if (error instanceof Error && error.name === "AbortError") return "timed out";
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "network error";
}

/**
 * Fetches and normalises one Claude account's limits. Throws `SignedOut` when the
 * account is not signed in here and `LimitFetchError` for anything else; nothing else
 * escapes, and no message carries a credential.
 */
export async function fetchClaudeLimits(
  account: ClaudeAccount,
  options: ClaudeFetchOptions = {},
): Promise<Capture> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const http = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const path = credentialsPath(account.path);
  let token: string | null = null;
  try {
    let oauth = readOAuth(path);
    if (expired(oauth, now())) oauth = await refresh(account, oauth, options, timeoutMs);
    token = oauth.accessToken;

    const request = async (accessToken: string): Promise<Response> => {
      try {
        return await http(USAGE_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            "anthropic-beta": OAUTH_BETA,
            "User-Agent": `tokenhud/${VERSION}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new LimitFetchError(`Claude usage fetch failed: ${describe(error)}`);
      }
    };

    let response = await request(token);
    if (response.status === 401) {
      // As cc-usage: a rejected token gets one refresh and one retry. Rejected again, the
      // sign-in is not usable here.
      await response.body?.cancel();
      oauth = await refresh(account, oauth, options, timeoutMs);
      token = oauth.accessToken;
      response = await request(token);
      if (response.status === 401) {
        await response.body?.cancel();
        throw new SignedOut("Claude rejected this machine's sign-in (HTTP 401)");
      }
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LimitFetchError(`Claude usage fetch failed: HTTP ${response.status}`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new LimitFetchError("Claude returned an invalid usage response");
    }
    return normalizeClaudeLimits(data, now() / 1000);
  } catch (error) {
    if (error instanceof SignedOut) throw new SignedOut(redact(error.message, token));
    if (error instanceof LimitFetchError) throw new LimitFetchError(redact(error.message, token));
    throw new LimitFetchError(`Claude usage fetch failed: ${describe(error)}`);
  }
}
