// Smoke-tests `tokenhud mcp` over stdio, as Claude Code drives it: `initialize`,
// `notifications/initialized` and `tools/list`, which must name the five tools; a call to
// `accounts`, which answers from cached data alone; then stdin closed, after which the server
// must exit 0 within 5 s. A reply that takes over 10 s fails it as a hang.
//
//   bun scripts/mcp-smoke.ts <command> [args...]   # runs `<command> [args...] mcp`
//
// e.g. `bun scripts/mcp-smoke.ts dist/tokenhud`, or `bun scripts/mcp-smoke.ts bun src/cli.ts`
// for the source. The server runs on a new temp HOME and config home, deleted afterwards, so
// no real account, config or network is touched. `scripts/build.ts --smoke` runs the same
// check on every release binary it smoke-tests, so each release job covers its platforms.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The tools `tokenhud mcp` serves (src/mcp/server.ts). */
export const MCP_TOOLS = ["limits", "should_wait", "wait_for_reset", "usage", "accounts"];
/** The longest wait for any one reply: a server silent for longer hangs. */
export const REPLY_TIMEOUT_MS = 10_000;
/** How soon the server must exit once stdin closes, as when a Claude Code session ends. */
export const EXIT_TIMEOUT_MS = 5_000;

type Env = Record<string, string | undefined>;
type Message = {
  id?: unknown;
  method?: unknown;
  result?: Record<string, unknown>;
  error?: { message?: unknown };
};

/**
 * A fresh machine under `dir` for the server: an empty home, where tokenhud still lists its
 * default Claude and Codex accounts, and a config home. Returns the variables that point the
 * server at it and away from this machine's own accounts.
 */
export async function mcpMachine(dir: string): Promise<Record<string, string>> {
  const home = join(dir, "mcp-home");
  const xdg = join(dir, "mcp-xdg");
  await mkdir(home, { recursive: true });
  // Made here, not by the server: in the musl container the server runs as root, and a
  // directory root makes could not be emptied afterwards.
  await mkdir(join(xdg, "tokenhud"), { recursive: true });
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    TOKENHUD_WSL_USERS: "",
    CLAUDE_CONFIG_DIR: "",
    CODEX_HOME: "",
    // Inherited from a Claude Code session running this, it would name a transcript to find.
    CLAUDE_CODE_SESSION_ID: "",
    // tokenhud's own refusal (src/limits/clients.ts): the server can't start `claude` or
    // `codex` at all. `accounts` never would; this keeps a regression from doing it here.
    TOKENHUD_TEST: "1",
    NO_COLOR: "1",
  };
}

class Failure extends Error {}

const seconds = (ms: number) => `${ms / 1000} s`;
const stderrLines = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, 10)
    .map((line) => `stderr: ${line}`);
/** Whatever a stdin write or close returns: a pipe the server already closed rejects. */
const quietly = (written: number | Promise<number>) => {
  if (written instanceof Promise) written.catch(() => {});
};

/** `promise`'s value, or `late` once `ms` pass; no timer outlives it. */
async function within<T, L>(promise: Promise<T>, ms: number, late: L): Promise<T | L> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<L>((resolve) => {
        timer = setTimeout(() => resolve(late), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deletes `dir`, retrying for a while: Windows can hold a file the server just closed (an
 * antivirus scan, say), and Bun's `rm` ignores `maxRetries`.
 */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rm(dir, { recursive: true, force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 20 || !["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(code)) throw error;
      await Bun.sleep(250);
    }
  }
}

/**
 * Runs `cmd`, a command that starts `tokenhud mcp` on the machine `mcpMachine` made (`env`
 * points at it), speaks MCP to it over stdio, and returns what went wrong: nothing when it
 * passed. The server is stopped whatever happens.
 */
export async function smokeMcp(
  cmd: string[],
  env: Env,
  timeouts = { replyMs: REPLY_TIMEOUT_MS, exitMs: EXIT_TIMEOUT_MS },
): Promise<string[]> {
  const proc = Bun.spawn(cmd, { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let exitCode: number | null = null;
  const exited = proc.exited.then((code) => {
    exitCode = code;
    return code;
  });
  const stderr = new Response(proc.stderr).text();
  const replies = new Map<number, Message>();
  const notJsonRpc: string[] = [];
  const reader = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    const take = (line: string) => {
      if (line.trim() === "") return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        message = null;
      }
      const m = message as (Message & { jsonrpc?: unknown }) | null;
      if (m === null || typeof m !== "object" || m.jsonrpc !== "2.0") notJsonRpc.push(line);
      // A request from the server would carry a method; only replies answer ours.
      else if (typeof m.id === "number" && m.method === undefined) replies.set(m.id, m);
    };
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        take(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    }
    take(buffer);
  })();

  const send = (message: Record<string, unknown>) => {
    try {
      quietly(proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
      quietly(proc.stdin.flush());
    } catch {
      // The server is gone: the reply wait reports how it exited.
    }
  };
  /** The result of request `id`, or a Failure naming what the server did instead. */
  const result = async (id: number, what: string): Promise<Record<string, unknown>> => {
    const deadline = performance.now() + timeouts.replyMs;
    while (!replies.has(id)) {
      if (exitCode !== null) {
        // Its last lines may still be in the pipe.
        await within(reader, 1000, null);
        if (replies.has(id)) break;
        throw new Failure(`the server exited (code ${exitCode}) before it answered ${what}`);
      }
      if (performance.now() >= deadline) {
        throw new Failure(`no answer to ${what} within ${seconds(timeouts.replyMs)}: it hangs`);
      }
      await Bun.sleep(20);
    }
    const reply = replies.get(id) as Message;
    if (reply.error !== undefined) {
      throw new Failure(`${what} failed: ${String(reply.error.message ?? "no message")}`);
    }
    if (reply.result === undefined) throw new Failure(`${what}: a reply with no result`);
    return reply.result;
  };

  const problems: string[] = [];
  try {
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tokenhud-mcp-smoke", version: "0" },
      },
    });
    const server = (await result(1, "initialize")).serverInfo as { name?: unknown } | undefined;
    if (server?.name !== "tokenhud") {
      problems.push(`initialize: the server is ${JSON.stringify(server ?? null)}, not tokenhud`);
    }
    send({ method: "notifications/initialized" });

    send({ id: 2, method: "tools/list" });
    const listed = (await result(2, "tools/list")).tools;
    const names = Array.isArray(listed) ? listed.map((t) => (t as { name?: unknown }).name) : [];
    const missing = MCP_TOOLS.filter((name) => !names.includes(name));
    const extra = names.filter((name) => !MCP_TOOLS.includes(name as string));
    if (missing.length > 0) {
      problems.push(`tools/list is missing ${missing.join(", ")} (it lists ${names.join(", ")})`);
    }
    if (extra.length > 0) problems.push(`tools/list has unexpected tools: ${extra.join(", ")}`);

    send({ id: 3, method: "tools/call", params: { name: "accounts", arguments: {} } });
    const answer = await result(3, "the accounts tool");
    const accounts = (answer.structuredContent as { accounts?: unknown } | undefined)?.accounts;
    const providers = Array.isArray(accounts)
      ? accounts.map((a) => (a as { provider?: unknown }).provider)
      : [];
    if (answer.isError === true) {
      problems.push(`accounts answered with an error: ${JSON.stringify(answer.content)}`);
    } else if (!providers.includes("claude") || !providers.includes("codex")) {
      problems.push(
        `accounts should list the default Claude and Codex accounts, but answered ${JSON.stringify(answer.structuredContent ?? null).slice(0, 300)}`,
      );
    }

    quietly(proc.stdin.end());
    const code = await within(exited, timeouts.exitMs, null);
    if (code === null) {
      problems.push(`still running ${seconds(timeouts.exitMs)} after stdin closed`);
    } else if (code !== 0) {
      problems.push(`exited with code ${code} after stdin closed, not 0`);
    }
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    problems.push(error.message);
  } finally {
    if (exitCode === null) {
      proc.kill();
      if ((await within(exited, 2000, null)) === null) proc.kill("SIGKILL");
    }
  }
  await within(reader, 2000, null);
  if (notJsonRpc.length > 0) {
    problems.push(`stdout carried a line that is not JSON-RPC: ${notJsonRpc[0]?.slice(0, 200)}`);
  }
  if (problems.length > 0) {
    problems.push(...stderrLines(await within(stderr, 1000, "")));
  }
  return problems;
}

if (import.meta.main) {
  const command = Bun.argv.slice(2);
  if (command.length === 0) {
    console.error("usage: bun scripts/mcp-smoke.ts <command> [args...]   (runs <command> mcp)");
    process.exit(2);
  }
  // From WSL a Windows program gets only the variables WSLENV names: it would run on the real
  // Windows home and config, not the temp ones. scripts/build.ts --smoke passes them on.
  if (process.platform !== "win32" && /\.exe$/i.test(command[0] ?? "")) {
    console.error(
      "mcp-smoke: a Windows binary run from here would not get the temp HOME; use\n" +
        "  bun scripts/build.ts --smoke windows-x64 --workdir=<a dir on a Windows drive>",
    );
    process.exit(2);
  }
  const dir = await mkdtemp(join(tmpdir(), "tokenhud-mcp-smoke-"));
  let problems: string[];
  try {
    problems = await smokeMcp([...command, "mcp"], { ...process.env, ...(await mcpMachine(dir)) });
  } finally {
    await removeDir(dir);
  }
  if (problems.length > 0) {
    console.error(`FAIL ${command.join(" ")} mcp\n${problems.map((p) => `     ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`ok   ${command.join(" ")} mcp: initialize, tools/list, accounts, clean exit`);
}
