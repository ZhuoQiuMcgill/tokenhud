// `tokenhud mcp` run as a fresh process, the way Claude Code runs it, on a fake HOME: no
// real account, config or network is touched.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { guard } from "../guard.ts";
import { CLI, cleanup, envOf, machine } from "../mcp/helpers.ts";

guard();

afterEach(cleanup);

describe("tokenhud mcp", () => {
  test("speaks MCP on stdout only, and exits when stdin closes, removing its heartbeat", async () => {
    const m = machine();
    const proc = Bun.spawn([process.execPath, CLI, "mcp"], {
      env: envOf(m),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (message: Record<string, unknown>) => {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      proc.stdin.flush();
    };
    const lines: string[] = [];
    const replies = new Map<number, Record<string, unknown>>();
    const reader = (async () => {
      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += new TextDecoder().decode(chunk);
        let at = buffer.indexOf("\n");
        while (at >= 0) {
          const line = buffer.slice(0, at);
          lines.push(line);
          const message = JSON.parse(line);
          if (typeof message.id === "number") replies.set(message.id, message);
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf("\n");
        }
      }
    })();
    const reply = async (id: number) => {
      for (let i = 0; i < 400 && !replies.has(id); i++) await Bun.sleep(25);
      return replies.get(id) as { result: Record<string, unknown> };
    };

    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    expect((await reply(1)).result.serverInfo).toMatchObject({ name: "tokenhud" });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    const tools = (await reply(2)).result.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual([
      "limits",
      "should_wait",
      "wait_for_reset",
      "usage",
      "accounts",
    ]);
    // No credentials in the fake ~/.claude: answered without any request.
    send({ id: 3, method: "tools/call", params: { name: "should_wait", arguments: {} } });
    expect((await reply(3)).result.structuredContent).toEqual({
      wait: false,
      reason: "limits unavailable: not signed in on this machine",
      utilization: null,
      wait_s: 0,
    });
    expect(readdirSync(join(m.xdg, "tokenhud", "mcp"))).toEqual([`${proc.pid}.json`]);

    proc.stdin.end();
    const code = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "timeout")]);
    expect(code).toBe(0);
    await reader;
    // Every stdout line was a JSON-RPC message.
    expect(lines.every((l) => JSON.parse(l).jsonrpc === "2.0")).toBe(true);
    expect(readdirSync(join(m.xdg, "tokenhud", "mcp"))).toEqual([]);
  });

  test("--help, and an unexpected argument", () => {
    const m = machine();
    const help = Bun.spawnSync([process.execPath, CLI, "mcp", "--help"], { env: envOf(m) });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("claude mcp add -s user tokenhud -- tokenhud mcp");
    const bad = Bun.spawnSync([process.execPath, CLI, "mcp", "--port", "1"], { env: envOf(m) });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toStartWith("tokenhud mcp: unexpected argument '--port'");
  });
});
