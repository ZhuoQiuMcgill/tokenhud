// The Claude Code plugin's files. CI also runs `claude plugin validate --strict` on them.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";
import { HOOK_EVENTS, isTokenhudHook, tokenhudHooks } from "../src/alerts/install.ts";
import { guard } from "./guard.ts";

guard();

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
    expect(readdirSync(PLUGIN).sort()).toEqual([".claude-plugin", ".mcp.json", "hooks", "skills"]);
    expect(existsSync(join(PLUGIN, "bin"))).toBe(false);
  });

  test("hooks/hooks.json runs `tokenhud hook` as .mcp.json runs the server, on the three events", () => {
    // From PATH in exec form (no shell), like .mcp.json: the hooks `tokenhud mcp install
    // --hooks` writes, but by name rather than by this binary's path.
    const hooks = json(join(PLUGIN, "hooks", "hooks.json"));
    expect(Object.keys(hooks).sort()).toEqual(["description", "hooks"]);
    expect(hooks.description).toContain("set_alert");
    expect(hooks.hooks).toEqual(tokenhudHooks({ command: "tokenhud", args: ["hook"] }));
    expect(Object.keys(hooks.hooks)).toEqual([...HOOK_EVENTS]);
    for (const event of HOOK_EVENTS) {
      const [group] = hooks.hooks[event];
      // None of the three events filters on a matcher.
      expect(group.matcher).toBeUndefined();
      expect(group.hooks).toHaveLength(1);
      expect(isTokenhudHook(group.hooks[0])).toBe(true);
      // SessionEnd keeps Claude Code's 1.5 s budget; the others are bounded at 10 s.
      expect(group.hooks[0].timeout).toBe(event === "SessionEnd" ? undefined : 10);
    }
  });

  test("the skill is short and tells agents to pass their model", () => {
    // Windows runners check text files out with CRLF line endings.
    const skill = readFileSync(
      join(PLUGIN, "skills", "usage-limits", "SKILL.md"),
      "utf8",
    ).replaceAll("\r\n", "\n");
    expect(skill.split("\n").length).toBeLessThan(40);
    expect(skill).toStartWith("---\nname: usage-limits\ndescription: ");
    for (const tool of ["should_wait", "wait_for_reset", "`model`", "set_alert", "clear_alert"]) {
      expect(skill).toContain(tool);
    }
  });

  test("the repo's marketplace lists it", () => {
    expect(json(join(ROOT, ".claude-plugin", "marketplace.json")).plugins).toEqual([
      expect.objectContaining({ name: "tokenhud", source: "./plugin" }),
    ]);
  });
});
