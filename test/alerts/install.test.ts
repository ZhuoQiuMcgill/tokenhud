// `tokenhud mcp install --hooks` and `--remove` (T29), on temp config dirs only: the merge,
// the backup, other hooks untouched, and the command line around it.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  backupPath,
  editHooks,
  hooksInstalled,
  isTokenhudHook,
  SettingsError,
  selfHookCommand,
  tokenhudHooks,
} from "../../src/alerts/install.ts";
import { guard } from "../guard.ts";
import { CLI, cleanup, envOf, type Machine, machine, NOW, tempDir } from "../mcp/helpers.ts";

guard();

afterEach(cleanup);

const CMD = { command: "/opt/tokenhud/bin/tokenhud", args: ["hook"] };
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** A user's settings with their own hooks, including one on an event tokenhud uses. */
const THEIRS = {
  model: "opus",
  enabledPlugins: { "other@market": true },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "~/.claude/hooks/check.sh" }] },
    ],
    PostToolBatch: [{ hooks: [{ type: "command", command: "notify-send batch", timeout: 5 }] }],
  },
};

function settingsFile(content?: unknown): string {
  const dir = join(tempDir(), ".claude");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  if (content !== undefined) {
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return path;
}

describe("editHooks", () => {
  test("into no settings file: creates it with exactly tokenhud's hooks", () => {
    const path = settingsFile();
    const change = editHooks(path, CMD, { remove: false, now: NOW });
    expect(change).toEqual({
      changed: true,
      created: true,
      backup: null,
      added: [
        "PostToolBatch: /opt/tokenhud/bin/tokenhud hook",
        "UserPromptSubmit: /opt/tokenhud/bin/tokenhud hook",
        "SessionEnd: /opt/tokenhud/bin/tokenhud hook",
      ],
      removed: [],
    });
    // The snippet the handoff quotes.
    expect(read(path)).toEqual({
      hooks: {
        PostToolBatch: [
          {
            hooks: [
              {
                type: "command",
                command: "/opt/tokenhud/bin/tokenhud",
                args: ["hook"],
                timeout: 10,
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "/opt/tokenhud/bin/tokenhud",
                args: ["hook"],
                timeout: 10,
              },
            ],
          },
        ],
        SessionEnd: [
          { hooks: [{ type: "command", command: "/opt/tokenhud/bin/tokenhud", args: ["hook"] }] },
        ],
      },
    });
    expect(hooksInstalled(read(path))).toBe(true);
  });

  test("merges: every other setting and hook kept, a backup of the file as it was", () => {
    const path = settingsFile(THEIRS);
    const before = readFileSync(path, "utf8");
    const change = editHooks(path, CMD, { remove: false, now: NOW });
    expect(change.backup).toBe(backupPath(path, NOW));
    expect(change.backup).toEndWith("settings.json.tokenhud-20261001T150000Z.bak");
    expect(readFileSync(change.backup as string, "utf8")).toBe(before);
    const ours = tokenhudHooks(CMD);
    expect(read(path)).toEqual({
      ...THEIRS,
      hooks: {
        PreToolUse: THEIRS.hooks.PreToolUse,
        PostToolBatch: [...THEIRS.hooks.PostToolBatch, ...ours.PostToolBatch],
        UserPromptSubmit: ours.UserPromptSubmit,
        SessionEnd: ours.SessionEnd,
      },
    });
  });

  test("again: nothing changes and no backup is made; a new binary path replaces the old", () => {
    const path = settingsFile(THEIRS);
    editHooks(path, CMD, { remove: false, now: NOW });
    const installed = readFileSync(path, "utf8");
    expect(editHooks(path, CMD, { remove: false, now: NOW + 1000 })).toEqual({
      changed: false,
      created: false,
      backup: null,
      added: [],
      removed: [],
    });
    expect(readFileSync(path, "utf8")).toBe(installed);
    expect(readdirSync(join(path, "..")).filter((n) => n.endsWith(".bak"))).toHaveLength(1);
    const moved = { command: "/usr/local/bin/tokenhud", args: ["hook"] };
    const change = editHooks(path, moved, { remove: false, now: NOW + 2000 });
    expect(change.removed).toHaveLength(3);
    expect(change.added).toEqual([
      "PostToolBatch: /usr/local/bin/tokenhud hook",
      "UserPromptSubmit: /usr/local/bin/tokenhud hook",
      "SessionEnd: /usr/local/bin/tokenhud hook",
    ]);
    const hooks = read(path).hooks;
    expect(JSON.stringify(hooks)).not.toContain("/opt/tokenhud");
    expect(hooks.PostToolBatch).toEqual([
      ...THEIRS.hooks.PostToolBatch,
      ...tokenhudHooks(moved).PostToolBatch,
    ]);
  });

  test("--remove takes out only tokenhud's hooks, and the groups and events they leave empty", () => {
    const path = settingsFile(THEIRS);
    editHooks(path, CMD, { remove: false, now: NOW });
    // A group of the user's that also runs tokenhud: only tokenhud's entry goes.
    const file = read(path);
    file.hooks.Stop = [
      {
        hooks: [
          { type: "command", command: "say done" },
          { type: "command", command: "tokenhud hook" },
        ],
      },
    ];
    writeFileSync(path, JSON.stringify(file));
    const change = editHooks(path, CMD, { remove: true, now: NOW + 1000 });
    expect(change.changed).toBe(true);
    expect(change.removed).toEqual([
      "PostToolBatch: /opt/tokenhud/bin/tokenhud hook",
      "UserPromptSubmit: /opt/tokenhud/bin/tokenhud hook",
      "SessionEnd: /opt/tokenhud/bin/tokenhud hook",
      "Stop: tokenhud hook",
    ]);
    expect(read(path)).toEqual({
      ...THEIRS,
      hooks: { ...THEIRS.hooks, Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    });
    expect(hooksInstalled(read(path))).toBe(false);
    // Nothing left to remove: nothing changes.
    expect(editHooks(path, CMD, { remove: true, now: NOW + 2000 }).changed).toBe(false);
  });

  test("hooks that were only tokenhud's leave no empty hooks object behind", () => {
    const path = settingsFile({ theme: "dark" });
    editHooks(path, CMD, { remove: false, now: NOW });
    editHooks(path, CMD, { remove: true, now: NOW + 1000 });
    expect(read(path)).toEqual({ theme: "dark" });
  });

  test("a settings file that isn't a JSON object is left as it is", () => {
    for (const [content, why] of [
      ["{ not json", "it is not valid JSON"],
      ["[1, 2]", "it is not a JSON object"],
      ['{"hooks": []}', 'its "hooks" is not an object'],
    ] as const) {
      const path = settingsFile(content);
      expect(() => editHooks(path, CMD, { remove: false, now: NOW })).toThrow(SettingsError);
      expect(() => editHooks(path, CMD, { remove: false, now: NOW })).toThrow(why);
      expect(readFileSync(path, "utf8")).toBe(content);
      expect(readdirSync(join(path, "..")).sort()).toEqual(["settings.json"]);
    }
  });
});

describe("recognising tokenhud's hook", () => {
  test("exec form or a command line, by any path; never another command", () => {
    const yes = [
      { type: "command", command: "tokenhud", args: ["hook"] },
      { type: "command", command: "/home/u/.bun/bin/tokenhud", args: ["hook"] },
      { type: "command", command: "C:\\Tools\\tokenhud.exe", args: ["hook"] },
      { type: "command", command: "/usr/bin/bun", args: ["/src/tokenhud/src/cli.ts", "hook"] },
      { type: "command", command: "tokenhud hook" },
    ];
    const no = [
      { type: "command", command: "tokenhud", args: ["mcp"] },
      { type: "command", command: "other-tool", args: ["hook"] },
      { type: "http", url: "http://localhost/tokenhud/hook" },
      "tokenhud hook",
      null,
    ];
    expect(yes.map(isTokenhudHook)).toEqual(yes.map(() => true));
    expect(no.map(isTokenhudHook)).toEqual(no.map(() => false));
  });

  test("installed means both PostToolBatch and UserPromptSubmit run it", () => {
    const all = { hooks: tokenhudHooks(CMD) };
    expect(hooksInstalled(all)).toBe(true);
    const { UserPromptSubmit: _, ...partial } = all.hooks;
    expect(hooksInstalled({ hooks: partial })).toBe(false);
    expect(hooksInstalled(null)).toBe(false);
    expect(hooksInstalled({ hooks: "x" })).toBe(false);
  });

  test("this tokenhud: the compiled binary itself, or Bun running cli.ts", () => {
    expect(selfHookCommand("/opt/t/tokenhud", "/$bunfs/root/cli.ts")).toEqual({
      command: "/opt/t/tokenhud",
      args: ["hook"],
    });
    expect(selfHookCommand("C:\\t\\tokenhud.exe", "B:\\~BUN\\root\\cli.ts")).toEqual({
      command: "C:\\t\\tokenhud.exe",
      args: ["hook"],
    });
    expect(selfHookCommand("/usr/bin/bun", "/src/tokenhud/src/cli.ts")).toEqual({
      command: "/usr/bin/bun",
      args: ["/src/tokenhud/src/cli.ts", "hook"],
    });
  });
});

describe("tokenhud mcp install --hooks", () => {
  /** A path under the fake home as the command prints it: `~` and this OS's separators. */
  const short = (m: Machine, ...parts: string[]) => join(...parts).replace(m.home, "~");

  function install(env: Record<string, string>, ...args: string[]) {
    const run = Bun.spawnSync([process.execPath, CLI, "mcp", "install", ...args], { env });
    return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
  }

  test("into CLAUDE_CONFIG_DIR's settings, by this tokenhud's absolute path; --remove undoes it", () => {
    const m = machine();
    writeFileSync(join(m.work, "settings.json"), JSON.stringify(THEIRS));
    const env = { ...envOf(m), CLAUDE_CONFIG_DIR: m.work };
    const added = install(env, "--hooks");
    expect(added.code).toBe(0);
    const line = `${process.execPath} ${CLI} hook`;
    const lines = added.out.trim().split("\n");
    expect(lines[0]).toBe(
      `tokenhud: updated ${short(m, m.work, "settings.json")} with tokenhud's alert hooks`,
    );
    expect(lines.slice(1, 4)).toEqual([
      `  + PostToolBatch: ${line}`,
      `  + UserPromptSubmit: ${line}`,
      `  + SessionEnd: ${line}`,
    ]);
    expect(lines[4]).toMatch(/^ {2}the file as it was: .*\.tokenhud-\d{8}T\d{6}Z\.bak$/);
    const hook = read(join(m.work, "settings.json")).hooks.UserPromptSubmit[0].hooks[0];
    expect(hook).toEqual({
      type: "command",
      command: process.execPath,
      args: [CLI, "hook"],
      timeout: 10,
    });
    // ~/.claude was never touched.
    expect(existsSync(join(m.claude, "settings.json"))).toBe(false);
    expect(install(env, "--hooks").out).toBe(
      `tokenhud: ${short(m, m.work, "settings.json")} already has tokenhud's alert hooks; nothing changed\n`,
    );
    const removed = install(env, "--hooks", "--remove");
    expect(removed.code).toBe(0);
    expect(removed.out).toStartWith(
      `tokenhud: took tokenhud's alert hooks out of ${short(m, m.work, "settings.json")}\n`,
    );
    expect(read(join(m.work, "settings.json"))).toEqual(THEIRS);
  });

  test("--config-dir names the dir; without it, ~/.claude", () => {
    const m = machine();
    expect(install(envOf(m), "--hooks").code).toBe(0);
    expect(hooksInstalled(read(join(m.claude, "settings.json")))).toBe(true);
    expect(install(envOf(m), "--hooks", "--config-dir", m.work).code).toBe(0);
    expect(hooksInstalled(read(join(m.work, "settings.json")))).toBe(true);
  });

  test("refuses: no --hooks, an unknown option, a missing dir, a damaged settings file", () => {
    const m = machine();
    const env = envOf(m);
    const none = install(env);
    expect(none.code).toBe(2);
    expect(none.err).toContain("pass --hooks");
    expect(install(env, "--hooks", "--force").code).toBe(2);
    const missing = install(env, "--hooks", "--config-dir", join(m.home, ".claude-gone"));
    expect(missing.code).toBe(1);
    expect(missing.err).toBe(
      `tokenhud mcp install: there is no Claude config dir at ${short(m, m.home, ".claude-gone")}\n`,
    );
    expect(existsSync(join(m.home, ".claude-gone"))).toBe(false);
    writeFileSync(join(m.claude, "settings.json"), "{ broken");
    const damaged = install(env, "--hooks");
    expect(damaged.code).toBe(1);
    expect(damaged.err).toStartWith(
      `tokenhud mcp install: ${short(m, m.claude, "settings.json")} was left as it is: it is not valid JSON`,
    );
    expect(readFileSync(join(m.claude, "settings.json"), "utf8")).toBe("{ broken");
  });
});
