// The Claude Code plugin's files. CI also runs `claude plugin validate --strict` on them.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";

const ROOT = join(import.meta.dir, "..");
const PLUGIN = join(ROOT, "plugin");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("the plugin", () => {
  test(".mcp.json runs `tokenhud mcp` from PATH: no shell, no npx", () => {
    // A shell launcher fails on native Windows, and an npx fallback downloads tens of MB at
    // startup; installing tokenhud first is the documented route.
    expect(json(join(PLUGIN, ".mcp.json"))).toEqual({
      mcpServers: { tokenhud: { command: "tokenhud", args: ["mcp"] } },
    });
  });

  test("manifest, layout and version", () => {
    const manifest = json(join(PLUGIN, ".claude-plugin", "plugin.json"));
    expect(manifest).toMatchObject({ name: "tokenhud", version, license: "MIT" });
    expect(readdirSync(PLUGIN).sort()).toEqual([".claude-plugin", ".mcp.json", "skills"]);
    expect(existsSync(join(PLUGIN, "bin"))).toBe(false);
  });

  test("the skill is short and tells agents to pass their model", () => {
    // Windows runners check text files out with CRLF line endings.
    const skill = readFileSync(
      join(PLUGIN, "skills", "usage-limits", "SKILL.md"),
      "utf8",
    ).replaceAll("\r\n", "\n");
    expect(skill.split("\n").length).toBeLessThan(40);
    expect(skill).toStartWith("---\nname: usage-limits\ndescription: ");
    for (const tool of ["should_wait", "wait_for_reset", "`model`"]) expect(skill).toContain(tool);
  });

  test("the repo's marketplace lists it", () => {
    expect(json(join(ROOT, ".claude-plugin", "marketplace.json")).plugins).toEqual([
      expect.objectContaining({ name: "tokenhud", source: "./plugin" }),
    ]);
  });
});
