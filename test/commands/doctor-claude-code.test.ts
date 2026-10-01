// doctor's Claude Code section, run as a fresh process on a fake HOME: it reads each
// account's settings files and writes nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, cleanup, envOf, machine } from "../mcp/helpers.ts";

afterEach(cleanup);

describe("doctor: Claude Code", () => {
  test("a line per Claude account, from that account's settings files, without paths", () => {
    const m = machine();
    mkdirSync(join(m.claude), { recursive: true });
    writeFileSync(
      join(m.claude, "settings.json"),
      JSON.stringify({ enabledPlugins: { "tokenhud@tokenhud": true } }),
    );
    writeFileSync(
      join(m.work, ".claude.json"),
      JSON.stringify({ mcpServers: { tokenhud: { command: "tokenhud", args: ["mcp"] } } }),
    );
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, CLI, "doctor", ...args], { env: envOf(m) });
    const text = run().stdout.toString();
    const section = text.slice(text.indexOf("Claude Code"));
    expect(section).toBe(
      [
        "Claude Code (tokenhud plugin or MCP server, per account)",
        "  personal      plugin",
        "  work          MCP server",
        "",
      ].join("\n"),
    );
    expect(text).not.toMatch(/[\\/]\.claude/);
    const report = JSON.parse(run("--json").stdout.toString());
    expect(report.claude_code).toEqual({
      accounts: [
        { label: "personal", plugin: "enabled", mcp: false },
        { label: "work", plugin: null, mcp: true },
      ],
    });
  });

  test("accounts without it get a pointer to the README", () => {
    const m = machine();
    const text = Bun.spawnSync([process.execPath, CLI, "doctor"], {
      env: envOf(m),
    }).stdout.toString();
    expect(text.slice(text.indexOf("Claude Code"))).toBe(
      [
        "Claude Code (tokenhud plugin or MCP server, per account)",
        "  personal      not installed",
        "  work          not installed",
        "                install once per account (each CLAUDE_CONFIG_DIR); see the README,",
        '                "Use with Claude Code"',
        "",
      ].join("\n"),
    );
  });
});
