// scripts/mcp-smoke.ts, the release jobs' check of each binary's `tokenhud mcp`: it passes
// the server built from this source, and fails with a clear message on each way a stand-in
// server (fake-mcp.ts) goes wrong, stopping that server.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_TIMEOUT_MS,
  mcpMachine,
  REPLY_TIMEOUT_MS,
  smokeMcp,
} from "../../scripts/mcp-smoke.ts";
import { guard } from "../guard.ts";
import { removeTempDir } from "../temp.ts";

guard();

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "mcp-smoke.ts");
const CLI = join(ROOT, "src", "cli.ts");
const FAKE = join(import.meta.dir, "fake-mcp.ts");

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) removeTempDir(dir);
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-mcp-smoke-test-"));
  made.push(dir);
  return dir;
}

/** Runs the script as a release job does, with its temp dirs made under `tmp`. */
async function script(args: string[], tmp: string) {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Whether process `pid` still runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("scripts/mcp-smoke.ts", () => {
  test("waits up to 10 s for each reply, and 5 s for the exit once stdin closes", () => {
    expect(REPLY_TIMEOUT_MS).toBe(10_000);
    expect(EXIT_TIMEOUT_MS).toBe(5_000);
  });

  test("passes `tokenhud mcp` from this source, and removes its temp machine", async () => {
    const tmp = tempDir();
    const run = await script([process.execPath, CLI], tmp);
    expect(run.stderr).toBe("");
    expect(run.stdout).toEndWith(" mcp: initialize, tools/list, accounts, clean exit\n");
    expect(run.code).toBe(0);
    expect(readdirSync(tmp).filter((name) => name.startsWith("tokenhud-mcp-smoke-"))).toEqual([]);
  }, 30_000);

  test("exits 1, naming the tool, when tools/list misses one", async () => {
    const run = await script([process.execPath, FAKE, "missing-tool"], tempDir());
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("FAIL ");
    expect(run.stderr).toContain(
      "tools/list is missing wait_for_reset (it lists limits, should_wait, usage, accounts, set_alert, list_alerts, clear_alert)",
    );
  }, 30_000);

  test("exits 1 when the server exits non-zero after stdin closes", async () => {
    const run = await script([process.execPath, FAKE, "bad-exit"], tempDir());
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("exited with code 3 after stdin closed, not 0");
  }, 30_000);

  test("exits 2 with its usage when no command is given", async () => {
    const run = await script([], tempDir());
    expect(run.code).toBe(2);
    expect(run.stderr).toStartWith("usage: bun scripts/mcp-smoke.ts <command>");
  });

  // Under WSL it would run, with the real Windows home.
  test.skipIf(process.platform === "win32")("refuses a Windows binary off Windows", async () => {
    const tmp = tempDir();
    const run = await script([join(tmp, "tokenhud-windows-x64.exe")], tmp);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("a Windows binary run from here would not get the temp HOME");
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe("smokeMcp against a stand-in server", () => {
  /** The problems smokeMcp finds in fake-mcp.ts's `mode`, and whether the fake still runs. */
  async function smoke(mode: string, timeouts = { replyMs: 10_000, exitMs: 5_000 }) {
    const env = await mcpMachine(tempDir());
    const problems = await smokeMcp(
      [process.execPath, FAKE, mode, "mcp"],
      { ...process.env, ...env },
      timeouts,
    );
    // As in the other kill tests, liveness is checked on POSIX only. A fake stopped before
    // it wrote its pid has no pid to check.
    const pidFile = join(env.HOME as string, "fake-mcp.pid");
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    return { problems, running: process.platform !== "win32" && pid > 0 && alive(pid) };
  }

  test("a server that answers as tokenhud does passes", async () => {
    expect(await smoke("ok")).toEqual({ problems: [], running: false });
  }, 30_000);

  test("a reply later than the timeout fails as a hang, and the server is stopped", async () => {
    expect(await smoke("hang", { replyMs: 500, exitMs: 5_000 })).toEqual({
      problems: ["no answer to initialize within 0.5 s: it hangs"],
      running: false,
    });
  }, 30_000);

  test("a server still running after the exit timeout fails, and is stopped", async () => {
    expect(await smoke("slow-exit", { replyMs: 10_000, exitMs: 500 })).toEqual({
      problems: ["still running 0.5 s after stdin closed"],
      running: false,
    });
  }, 30_000);

  test("a server that dies on start fails, with its stderr", async () => {
    expect(await smoke("crash")).toEqual({
      problems: [
        "the server exited (code 1) before it answered initialize",
        "stderr: fake-mcp: crashed on start",
      ],
      running: false,
    });
  }, 30_000);

  test("a line on stdout that is not JSON-RPC fails", async () => {
    expect((await smoke("noise")).problems).toEqual([
      "stdout carried a line that is not JSON-RPC: a stray log line on stdout",
    ]);
  }, 30_000);

  test("an error from the accounts tool fails", async () => {
    expect((await smoke("accounts-error")).problems).toEqual([
      'accounts answered with an error: [{"type":"text","text":"store unreadable"}]',
    ]);
  }, 30_000);
});
