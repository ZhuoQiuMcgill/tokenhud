import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectInstall } from "../../src/mcp/install.ts";
import { cleanup, machine } from "./helpers.ts";

afterEach(cleanup);

function json(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("detectInstall", () => {
  test("nothing installed", () => {
    const m = machine();
    expect(detectInstall({ path: m.claude })).toEqual({ plugin: null, mcp: false });
  });

  test("the plugin: enabled in settings.json, or installed but switched off", () => {
    const m = machine();
    json(join(m.claude, "settings.json"), {
      enabledPlugins: { "other@market": true, "tokenhud@tokenhud": true },
    });
    expect(detectInstall({ path: m.claude }).plugin).toBe("enabled");
    json(join(m.claude, "settings.json"), { enabledPlugins: { "tokenhud@tokenhud": false } });
    expect(detectInstall({ path: m.claude }).plugin).toBe("installed");
    json(join(m.work, "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { "tokenhud@tokenhud": [{ scope: "user" }] },
    });
    expect(detectInstall({ path: m.work }).plugin).toBe("installed");
  });

  test("the MCP server: ~/.claude.json for ~/.claude, <dir>/.claude.json for other dirs", () => {
    const m = machine();
    json(join(m.home, ".claude.json"), {
      mcpServers: { tokenhud: { command: "tokenhud", args: ["mcp"] } },
    });
    expect(detectInstall({ path: m.claude }).mcp).toBe(true);
    // ~/.claude.json belongs to ~/.claude only.
    expect(detectInstall({ path: m.work }).mcp).toBe(false);
    json(join(m.work, ".claude.json"), {
      mcpServers: { usage: { type: "stdio", command: "npx", args: ["-y", "tokenhud@0", "mcp"] } },
    });
    expect(detectInstall({ path: m.work }).mcp).toBe(true);
  });

  test("other servers, a tokenhud command that isn't mcp, and damaged files read as not installed", () => {
    const m = machine();
    json(join(m.work, ".claude.json"), {
      mcpServers: {
        other: { command: "node", args: ["server.js"] },
        odd: { command: "tokenhud", args: ["json"] },
      },
    });
    json(join(m.work, "settings.json"), { enabledPlugins: ["tokenhud@tokenhud"] });
    expect(detectInstall({ path: m.work })).toEqual({ plugin: null, mcp: false });
    writeFileSync(join(m.work, ".claude.json"), "{ not json");
    writeFileSync(join(m.work, "settings.json"), "");
    expect(detectInstall({ path: m.work })).toEqual({ plugin: null, mcp: false });
  });

  test("only reads: every file is left as it was", () => {
    const m = machine();
    json(join(m.claude, "settings.json"), { enabledPlugins: { "tokenhud@tokenhud": true } });
    json(join(m.home, ".claude.json"), {
      mcpServers: { tokenhud: { command: "tokenhud", args: ["mcp"] } },
    });
    const snapshot = () =>
      [join(m.claude, "settings.json"), join(m.home, ".claude.json")].map((p) => [
        createHash("sha256").update(readFileSync(p)).digest("hex"),
        statSync(p).mtimeMs,
      ]);
    const before = snapshot();
    const entries = readdirSync(m.claude).sort();
    expect(detectInstall({ path: m.claude })).toEqual({ plugin: "enabled", mcp: true });
    expect(snapshot()).toEqual(before);
    expect(readdirSync(m.claude).sort()).toEqual(entries);
  });
});
