// doctor's Claude Code section, run as a fresh process on a fake HOME: it reads each
// account's settings files and writes nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guard } from "../guard.ts";
import { CLI, cleanup, envOf, type Machine, machine, tempDir } from "../mcp/helpers.ts";

guard();

afterEach(cleanup);

/** doctor with PATH holding only `bin` (an empty dir unless a test fills it). */
function doctor(m: Machine, bin: string, ...args: string[]): string {
  const env = { ...envOf(m), PATH: bin };
  return Bun.spawnSync([process.execPath, CLI, "doctor", ...args], { env }).stdout.toString();
}

const NOT_ON_PATH = [
  "  tokenhud      not on PATH: the plugin and the MCP server run `tokenhud mcp`",
  "                from PATH, so install tokenhud first",
];

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
    const bin = tempDir();
    const text = doctor(m, bin);
    const section = text.slice(text.indexOf("Claude Code"));
    expect(section).toBe(
      [
        "Claude Code (tokenhud plugin or MCP server, per account)",
        ...NOT_ON_PATH,
        "  personal      plugin",
        "  work          MCP server",
        "",
      ].join("\n"),
    );
    expect(text).not.toMatch(/[\\/]\.claude/);
    const report = JSON.parse(doctor(m, bin, "--json"));
    expect(report.claude_code).toEqual({
      tokenhud_on_path: false,
      npm_shim: false,
      accounts: [
        { label: "personal", plugin: "enabled", mcp: false },
        { label: "work", plugin: null, mcp: true },
      ],
    });
  });

  test("accounts without it get a pointer to the README", () => {
    const m = machine();
    const text = doctor(m, tempDir());
    expect(text.slice(text.indexOf("Claude Code"))).toBe(
      [
        "Claude Code (tokenhud plugin or MCP server, per account)",
        ...NOT_ON_PATH,
        "  personal      not installed",
        "  work          not installed",
        "                install once per account (each CLAUDE_CONFIG_DIR); see the README,",
        '                "Use with Claude Code"',
        "",
      ].join("\n"),
    );
  });

  test.skipIf(process.platform === "win32")("finds tokenhud on PATH", () => {
    const m = machine();
    const bin = tempDir();
    writeFileSync(join(bin, "tokenhud"), "#!/bin/sh\n");
    chmodSync(join(bin, "tokenhud"), 0o755);
    const text = doctor(m, bin);
    expect(text).toContain(
      "Claude Code (tokenhud plugin or MCP server, per account)\n  tokenhud      on PATH\n",
    );
    expect(JSON.parse(doctor(m, bin, "--json")).claude_code).toMatchObject({
      tokenhud_on_path: true,
      npm_shim: false,
    });
  });
});
