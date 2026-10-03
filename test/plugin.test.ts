// The Claude Code plugin's files. CI also runs `claude plugin validate --strict` on them.
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { checkHookCommands } from "../scripts/hook-compat.ts";
import {
  HOOK_EVENTS,
  isTokenhudHook,
  PLUGIN_COMMAND,
  tokenhudHooks,
} from "../src/alerts/install.ts";
import { guard } from "./guard.ts";
import { removeTempDir } from "./temp.ts";

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

  test("hooks/hooks.json runs `tokenhud hook` from PATH, as .mcp.json runs the server, and always exits 0", () => {
    // A shell line ending `; exit 0`, never exec form: a tokenhud from before `hook` exits 2
    // on it, which would block every prompt (critique B1).
    const hooks = json(join(PLUGIN, "hooks", "hooks.json"));
    expect(Object.keys(hooks).sort()).toEqual(["description", "hooks"]);
    expect(hooks.description).toContain("set_alert");
    expect(hooks.hooks).toEqual(tokenhudHooks({ command: PLUGIN_COMMAND }));
    expect(PLUGIN_COMMAND).toBe("tokenhud hook; exit 0");
    expect(Object.keys(hooks.hooks)).toEqual([...HOOK_EVENTS]);
    for (const event of HOOK_EVENTS) {
      const [group] = hooks.hooks[event];
      // None of the three events filters on a matcher.
      expect(group.matcher).toBeUndefined();
      expect(group.hooks).toHaveLength(1);
      expect(isTokenhudHook(group.hooks[0])).toBe(true);
      expect(group.hooks[0].args).toBeUndefined();
      // SessionEnd keeps Claude Code's 1.5 s budget; the others are bounded at 10 s.
      expect(group.hooks[0].timeout).toBe(event === "SessionEnd" ? undefined : 10);
    }
  });

  describe.if(process.platform !== "win32")(
    "the hook commands, run as Claude Code runs them",
    () => {
      // scripts/hook-compat.ts with stand-ins; CI runs it on every OS against the released
      // 0.1.3 binary and a build of this one, through every shell Claude Code uses.
      function bin(script: string): string {
        const dir = mkdtempSync(join(tmpdir(), "tokenhud-plugin-test-"));
        made.push(dir);
        writeFileSync(join(dir, "tokenhud"), `#!/bin/sh\n${script}\n`);
        chmodSync(join(dir, "tokenhud"), 0o755);
        return dir;
      }
      const made: string[] = [];
      afterAll(() => {
        for (const dir of made) removeTempDir(dir);
      });

      test("a tokenhud without `hook` (0.1.3 answers exit 2, on stderr), or none: exit 0, nothing on stdout", () => {
        const old = bin(
          `echo "tokenhud: unknown command '$1'" >&2\necho "run tokenhud --help for usage" >&2\nexit 2`,
        );
        expect(checkHookCommands({ binDir: old, expect: "silent" })).toEqual([]);
        // Crashing, killed: the same.
        expect(checkHookCommands({ binDir: bin("kill -9 $$"), expect: "silent" })).toEqual([]);
      });

      test("this tokenhud: the alert's hook reply comes through", () => {
        const now = bin(`exec "${process.execPath}" "${join(ROOT, "src", "cli.ts")}" "$@"`);
        expect(checkHookCommands({ binDir: now, expect: "alert" })).toEqual([]);
      });
    },
  );

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
