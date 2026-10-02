import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.ts";
import { type Capture, LimitFetchError, normalizeClaudeLimits, SignedOut } from "./capture.ts";
import { findOnPath, refuseRealClient } from "./clients.ts";

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
 *   through an empty zero-turn invocation, pointed at the same config dir;
 * - every request passes `verbose: false`, so `BUN_CONFIG_VERBOSE_FETCH` in the
 *   environment (which Claude Code passes on to MCP servers) cannot print its headers.
 *
 * Only definitive evidence makes an account "not signed in here" (`SignedOut`): no
 * credential file (or no OAuth login in it), a refresh run that reports the sign-in is gone,
 * or a 401/403 for a token the refresh run had just replaced. Anything else (offline, DNS,
 * timeouts, 5xx, 429, a refresh run that failed for its own reasons) is a retryable
 * `LimitFetchError`, so a signed-in account is never written off by a bad network.
 *
 * macOS keeps Claude's credentials in the Keychain rather than this file; like cc-usage,
 * tokenhud does not read the Keychain, so such an account reads as not signed in here.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_TIMEOUT_MS = 15_000;
/** A token this close to its expiry is refreshed first, as cc-usage does. */
const EXPIRY_MARGIN_MS = 30_000;
/** How much of the refresh run's output is kept (in memory, only to be matched). */
const OUTPUT_LIMIT = 64 * 1024;
/**
 * What the official client prints when the sign-in itself is gone: an expired or revoked
 * OAuth session, a refused refresh grant, or a request to log in again. Only matched,
 * never stored or shown.
 */
const SIGNED_OUT_OUTPUT =
  /oauth (session|token) (has )?(expired|been revoked)|token (has been )?revoked|invalid_grant|(please )?run \/login|not logged in|session (has )?expired/i;
/**
 * A refresh run that could not reach the server says so; that is never a sign-out, even
 * when the message also mentions logging in.
 */
const NETWORK_OUTPUT =
  /connection (error|refused|reset)|getaddrinfo|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out|network|fetch failed|socket hang up|unable to connect/i;
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
  /** Aborting kills the run. */
  signal?: AbortSignal;
}

/** Runs the official client; resolves with its combined output (truncated), never rejects on exit status. */
export type RefreshRunner = (run: RefreshRun) => Promise<string>;

/** `fetch`'s signature, narrowed to what this module calls. */
export type HttpFetch = (url: string, init: BunFetchRequestInit) => Promise<Response>;

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
  /** Aborting cancels the request and kills a refresh run. */
  signal?: AbortSignal;
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

/**
 * The only `fetch` in tokenhud, so the verbose switch cannot be forgotten: Bun's
 * `BUN_CONFIG_VERBOSE_FETCH` would otherwise print the request's Authorization header.
 */
export const quietFetch: HttpFetch = (url, init) => fetch(url, { ...init, verbose: false });

const CANCELLED = "Claude limits fetch cancelled";

interface OAuth {
  accessToken: string;
  /** Epoch ms, when the file says. */
  expiresAt: number | null;
}

/**
 * Reads the OAuth login from the credential file. Nothing read is ever echoed. A missing
 * file, or one without an OAuth login, means there is nothing to sign in with here.
 */
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
  refuseRealClient(run.argv[0] as string);
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(run.argv, {
      env: run.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: run.timeoutMs,
      killSignal: "SIGKILL",
      ...(run.signal ? { signal: run.signal } : {}),
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
 * CLAUDE_CONFIG_DIR set to its dir.
 *
 * Returns the token afterwards and whether the run replaced it. A token left unchanged is
 * `SignedOut` only when the client's output says the sign-in is gone (and not that it was
 * offline); left unchanged and expired otherwise, it is a retryable failure.
 */
async function refresh(
  account: ClaudeAccount,
  before: OAuth,
  options: ClaudeFetchOptions,
  timeoutMs: number,
): Promise<{ oauth: OAuth; replaced: boolean }> {
  const which = options.which ?? findOnPath;
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
  const run: RefreshRun = {
    argv: [executable, "--print", "--max-turns", "0", ""],
    env,
    timeoutMs,
  };
  if (options.signal) run.signal = options.signal;
  const output = await (options.runRefresh ?? spawnRefresh)(run);
  if (options.signal?.aborted) throw new LimitFetchError(CANCELLED);
  const after = readOAuth(credentialsPath(account.path));
  if (after.accessToken !== before.accessToken) return { oauth: after, replaced: true };
  if (SIGNED_OUT_OUTPUT.test(output) && !NETWORK_OUTPUT.test(output)) {
    throw new SignedOut("the Claude sign-in on this machine has expired");
  }
  if (expired(after, (options.now ?? Date.now)())) {
    throw new LimitFetchError("Claude credentials are expired and the refresh did not complete");
  }
  return { oauth: after, replaced: false };
}

/** A failed request's description: the error's name only, so no URL, header or body can leak. */
function describe(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "timed out";
  if (error instanceof Error && error.name === "AbortError") return "timed out";
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "network error";
}

/**
 * Fetches and normalises one Claude account's limits. Throws `SignedOut` when the account
 * is definitely not signed in here and `LimitFetchError` for anything else; nothing else
 * escapes, and no message carries a credential or any part of a response body.
 */
export async function fetchClaudeLimits(
  account: ClaudeAccount,
  options: ClaudeFetchOptions = {},
): Promise<Capture> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const http = options.fetch ?? quietFetch;
  const now = options.now ?? Date.now;
  const path = credentialsPath(account.path);
  let token: string | null = null;
  try {
    let oauth = readOAuth(path);
    // Whether a refresh run has replaced the token: a 401/403 after that is definitive.
    let replaced = false;
    if (expired(oauth, now()))
      ({ oauth, replaced } = await refresh(account, oauth, options, timeoutMs));
    token = oauth.accessToken;

    const request = async (accessToken: string): Promise<Response> => {
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        return await http(USAGE_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            "anthropic-beta": OAUTH_BETA,
            "User-Agent": `tokenhud/${VERSION}`,
          },
          signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
          verbose: false,
        });
      } catch (error) {
        if (options.signal?.aborted) throw new LimitFetchError(CANCELLED);
        throw new LimitFetchError(`Claude usage fetch failed: ${describe(error)}`);
      }
    };

    let response = await request(token);
    if (response.status === 401 && !replaced) {
      // As cc-usage: a rejected token gets one refresh run. Only a token it replaced is
      // worth a retry; the same token would be rejected again.
      await response.body?.cancel();
      ({ oauth, replaced } = await refresh(account, oauth, options, timeoutMs));
      token = oauth.accessToken;
      if (!replaced) throw new LimitFetchError("Claude usage fetch failed: HTTP 401");
      response = await request(token);
    }
    if (replaced && (response.status === 401 || response.status === 403)) {
      await response.body?.cancel();
      throw new SignedOut(
        `Claude rejected this machine's refreshed sign-in (HTTP ${response.status})`,
      );
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
    if (options.signal?.aborted) throw new LimitFetchError(CANCELLED);
    if (error instanceof SignedOut) throw new SignedOut(redact(error.message, token));
    if (error instanceof LimitFetchError) throw new LimitFetchError(redact(error.message, token));
    throw new LimitFetchError(`Claude usage fetch failed: ${describe(error)}`);
  }
}
