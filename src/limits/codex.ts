import { statSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.ts";
import {
  type Capture,
  CodexAppServerUnavailable,
  LimitFetchError,
  normalizeCodexLimits,
  SignedOut,
} from "./capture.ts";
import { findOnPath, RefusedClient, refuseRealClient } from "./clients.ts";

/**
 * Codex's current limits over the app-server JSON-RPC, ported from cc-usage's
 * `_run_codex_rpc`. Codex authenticates (and refreshes) by itself; tokenhud never touches
 * Codex auth. The conversation is newline-delimited JSON on the child's stdin/stdout:
 * `initialize` (id 1), then the `initialized` notification and `account/rateLimits/read`
 * (id 2).
 *
 * The child runs as `codex app-server`, whose default transport is stdio. cc-usage passed
 * `--stdio`, which codex-cli 0.135.0 rejects (exit 2 before `initialize`), so its RPC has
 * been latching off; the flag is dropped here.
 *
 * Failures are classified as cc-usage does. A child that never answered `initialize`
 * (missing executable, unsupported subcommand, instant exit) is `CodexAppServerUnavailable`,
 * which the caller latches on. A child that answered and then died, a timeout, a JSON-RPC
 * error or a transient spawn failure is a plain, retryable `LimitFetchError`.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
/** How long to wait for a child that closed its stdout to report its exit status. */
const EXIT_WAIT_MS = 1_000;
const KILL_WAIT_MS = 3_000;

/** The subset of `Bun.Subprocess` the RPC uses; tests may inject a spawner. */
export interface RpcProcess {
  readonly stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: number | NodeJS.Signals): void;
}

export type RpcSpawner = (argv: string[], env: Record<string, string>) => RpcProcess;

export interface CodexFetchOptions {
  /** The account's CODEX_HOME. */
  codexHome: string;
  timeoutMs?: number;
  /** The executable; found on PATH when absent. */
  executable?: string | null;
  spawn?: RpcSpawner;
  env?: Readonly<Record<string, string | undefined>>;
  /** Epoch ms. */
  now?: () => number;
  /** Aborting kills the app-server and ends the fetch at once. */
  signal?: AbortSignal;
}

/** Login refusals as the app-server words them, e.g. 0.135.0's "codex account authentication required to read rate limits". */
const SIGNED_OUT_TEXT =
  /authentication required|unauthori[sz]ed|not (logged|signed) in|log ?in required|sign(ing)? in again/i;
/** Where a quoted HTTP response starts in an app-server error. */
const QUOTED_BODY = /;\s*(?:content-type|body)\s*[=:]|\bbody\s*[=:]|[{[]/i;
/** An HTTP status in what precedes it: "status 500", "HTTP 429", "failed: 401 Unauthorized". */
const HTTP_STATUS = /\b(?:status|HTTP)\s*:?\s*([1-5]\d\d)\b|\b([1-5]\d\d)\s+[A-Za-z]/i;

/**
 * An app-server error as a fixed message. Its text can quote the HTTP response the
 * app-server got (`...; content-type=...; body={...}`), and nothing a provider sent may
 * reach a log or the cache. So only the text before any quoted body is looked at, for an
 * HTTP status and for a refused login, and only that status (or the JSON-RPC error code)
 * is reported. A refused login (401, 403, "authentication required", ...) is `SignedOut`:
 * the home is then history-only until its auth.json changes.
 */
export function rpcError(error: unknown): LimitFetchError {
  const field = (name: string) =>
    typeof error === "object" && error !== null ? Reflect.get(error, name) : undefined;
  const text = typeof error === "string" ? error : field("message");
  const raw = typeof text === "string" ? text : "";
  const head = raw.split(/\r?\n/, 1)[0]?.split(QUOTED_BODY, 1)[0] ?? "";
  const match = HTTP_STATUS.exec(head);
  const status = match === null ? null : Number(match[1] ?? match[2]);
  if (status === 401 || status === 403) {
    return new SignedOut(`Codex is not signed in here (HTTP ${status})`);
  }
  if (SIGNED_OUT_TEXT.test(head)) return new SignedOut("Codex is not signed in here");
  if (status !== null) return new LimitFetchError(`Codex rate-limit fetch failed: HTTP ${status}`);
  const code = field("code");
  return new LimitFetchError(
    typeof code === "number"
      ? `Codex rate-limit fetch failed (app-server error ${code})`
      : "Codex rate-limit fetch failed (app-server error)",
  );
}

/** The mtime (epoch ms) of a Codex home's auth.json, or null; only stat-ed, never read. */
export function codexAuthMtime(codexHome: string): number | null {
  try {
    return statSync(join(codexHome, "auth.json")).mtimeMs;
  } catch {
    return null;
  }
}

/** The `codex` executable on PATH (`codex.cmd` first on Windows), or null. */
export function codexExecutable(
  which: (name: string) => string | null = findOnPath,
): string | null {
  const names = process.platform === "win32" ? ["codex.cmd", "codex"] : ["codex"];
  for (const name of names) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

const defaultSpawn: RpcSpawner = (argv, env) => {
  refuseRealClient(argv[0] as string);
  return Bun.spawn(argv, { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
};

/** Splits a byte stream into lines; resolves null at the end of the stream. */
class LineReader {
  readonly #reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel(): Promise<void>;
  };
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async next(): Promise<string | null> {
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl >= 0) {
        const line = this.#buffer.slice(0, nl);
        this.#buffer = this.#buffer.slice(nl + 1);
        return line;
      }
      if (this.#done) {
        if (this.#buffer === "") return null;
        const rest = this.#buffer;
        this.#buffer = "";
        return rest;
      }
      const { done, value } = await this.#reader.read();
      if (done || value === undefined) this.#done = true;
      else this.#buffer += this.#decoder.decode(value, { stream: true });
    }
  }

  cancel(): void {
    this.#reader.cancel().catch(() => {});
  }
}

function timeoutAfter(ms: number): { promise: Promise<"timeout">; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
  });
  return { promise, clear: () => clearTimeout(timer) };
}

/**
 * A pipe write to a child that has gone may fail later, as a rejected promise; the read
 * side classifies that child, so the rejection itself is only silenced.
 */
function settle(result: unknown): void {
  if (result instanceof Promise) result.catch(() => {});
}

/** The child's exit status once it has exited, waiting up to `ms`; null if still running. */
async function exitStatus(proc: RpcProcess, ms: number): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode;
  const wait = timeoutAfter(ms);
  const status = await Promise.race([proc.exited, wait.promise]);
  wait.clear();
  return status === "timeout" ? null : status;
}

/** Runs one `account/rateLimits/read` and returns its raw result object. */
export async function runCodexRpc(options: CodexFetchOptions): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const executable = options.executable === undefined ? codexExecutable() : options.executable;
  if (!executable) throw new CodexAppServerUnavailable("Codex executable was not found");
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined) env[name] = value;
  }
  env.CODEX_HOME = options.codexHome;

  let proc: RpcProcess;
  try {
    proc = (options.spawn ?? defaultSpawn)([executable, "app-server"], env);
  } catch (error) {
    if (error instanceof RefusedClient) throw error; // a test's, and says why
    // Only a vanished executable is permanent. ENOMEM/EAGAIN (fork under memory pressure)
    // and ETXTBSY (the CLI being upgraded) are transient.
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    const Failure = code === "ENOENT" ? CodexAppServerUnavailable : LimitFetchError;
    throw new Failure(`Codex app-server could not start (${code})`);
  }

  const lines = new LineReader(proc.stdout);
  // Stopping kills the child at once; the read loop sees "aborted" instead of waiting.
  let onAbort = () => {};
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => {
      proc.kill("SIGKILL");
      resolve("aborted");
    };
  });
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const send = (message: object) => {
    settle(proc.stdin.write(`${JSON.stringify(message)}\n`));
    settle(proc.stdin.flush());
  };
  // Answering `initialize` proves this CLI serves app-server, so a later death is not permanent.
  let initialized = false;
  const deadline = performance.now() + timeoutMs;
  try {
    try {
      send({
        method: "initialize",
        id: 1,
        params: { clientInfo: { name: "tokenhud", title: "tokenhud", version: VERSION } },
      });
    } catch {
      // The child already hung up; the read below sees its stdout close and classifies it.
    }
    for (;;) {
      const wait = timeoutAfter(deadline - performance.now());
      const line = await Promise.race([lines.next(), wait.promise, aborted]);
      wait.clear();
      if (line === "aborted") throw new LimitFetchError("Codex limits fetch cancelled");
      if (line === "timeout") throw new LimitFetchError("Codex rate-limit fetch timed out");
      if (line === null) break;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      // The protocol frames objects; a bare scalar or array is not ours.
      if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
      const frame = message as Record<string, unknown>;
      if (frame.id === 1 && !initialized) {
        initialized = true;
        try {
          send({ method: "initialized" });
          send({ method: "account/rateLimits/read", id: 2 });
        } catch {
          const status = await exitStatus(proc, 0);
          throw new LimitFetchError(
            status === null
              ? "Codex app-server connection failed"
              : `Codex app-server exited mid-request (status ${status})`,
          );
        }
      } else if (frame.id === 2) {
        if (frame.error) throw rpcError(frame.error);
        const result = frame.result;
        if (typeof result !== "object" || result === null || Array.isArray(result)) {
          throw new LimitFetchError("Codex returned an invalid rate-limit response");
        }
        return result as Record<string, unknown>;
      }
    }
    // The child closed its stdout. Never having answered `initialize` means this CLI cannot
    // serve app-server at all; closing *after* the handshake may well be transient.
    const status = await exitStatus(proc, EXIT_WAIT_MS);
    const suffix = status === null ? "" : ` (status ${status})`;
    if (!initialized) {
      throw new CodexAppServerUnavailable(
        `Codex app-server exited before accepting the request${suffix}; the installed codex CLI may not support 'app-server'`,
      );
    }
    throw new LimitFetchError(`Codex app-server closed before returning rate limits${suffix}`);
  } catch (error) {
    if (error instanceof LimitFetchError) throw error;
    throw new LimitFetchError(`Codex app-server connection failed: ${(error as Error).name}`);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    lines.cancel();
    try {
      settle(proc.stdin.end());
    } catch {
      // already closed
    }
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      if ((await exitStatus(proc, KILL_WAIT_MS)) === null) proc.kill("SIGKILL");
    }
  }
}

/** One Codex account's limits, normalised. */
export async function fetchCodexLimits(options: CodexFetchOptions): Promise<Capture> {
  const result = await runCodexRpc(options);
  return normalizeCodexLimits(result, (options.now ?? Date.now)() / 1000);
}
