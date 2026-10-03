// `tokenhud mcp install --hooks` and `--remove` (T29), on temp config dirs only: the
// tolerant command, the merge, the backup, mode, owner and symlinks kept, only tokenhud's
// own hooks touched, and the command line around it.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  backupPath,
  editHooks,
  hookCommand,
  hooksInstalled,
  isTokenhudHook,
  PLUGIN_COMMAND,
  SettingsError,
  selfHookCommand,
  tokenhudHooks,
} from "../../src/alerts/install.ts";
import { guard } from "../guard.ts";
import { CLI, cleanup, envOf, type Machine, machine, NOW, tempDir } from "../mcp/helpers.ts";

guard();

afterEach(cleanup);

const BIN = "/opt/tokenhud/bin/tokenhud";
const CMD = hookCommand([BIN], "linux");
const LINE = "'/opt/tokenhud/bin/tokenhud' hook; exit 0";
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const posix = process.platform !== "win32";

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

const backups = (path: string) =>
  readdirSync(join(path, "..")).filter((n) => n.includes(".tokenhud-") && n.endsWith(".bak"));

describe("the command", () => {
  test("a shell line that always exits 0: quoted for sh, and for PowerShell (with &) on Windows", () => {
    expect(CMD).toEqual({ command: LINE });
    expect(hookCommand(["/home/u/it's here/tokenhud"], "darwin")).toEqual({
      command: `'/home/u/it'\\''s here/tokenhud' hook; exit 0`,
    });
    expect(hookCommand(["C:\\Users\\Jo O'Neil\\tokenhud.exe"], "win32")).toEqual({
      command: "& 'C:\\Users\\Jo O''Neil\\tokenhud.exe' hook; exit 0",
      shell: "powershell",
    });
    expect(selfHookCommand("/opt/t/tokenhud", "/$bunfs/root/cli.js", "linux")).toEqual({
      command: "'/opt/t/tokenhud' hook; exit 0",
    });
    expect(selfHookCommand("C:\\t\\tokenhud.exe", "B:\\~BUN\\root\\cli.js", "win32")).toEqual({
      command: "& 'C:\\t\\tokenhud.exe' hook; exit 0",
      shell: "powershell",
    });
    expect(selfHookCommand("/usr/bin/bun", "/src/tokenhud/src/cli.ts", "linux")).toEqual({
      command: "'/usr/bin/bun' '/src/tokenhud/src/cli.ts' hook; exit 0",
    });
  });

  test("only the hooks tokenhud writes are its own; a user's hook that mentions tokenhud is not", () => {
    const yes = [
      { type: "command", command: PLUGIN_COMMAND },
      { type: "command", command: LINE, timeout: 10 },
      { type: "command", command: `'/home/u/it'\\''s/tokenhud' hook; exit 0` },
      { type: "command", command: "& 'C:\\t\\tokenhud.exe' hook; exit 0", shell: "powershell" },
      { type: "command", command: "'/usr/bin/bun' '/src/tokenhud/src/cli.ts' hook; exit 0" },
    ];
    const no = [
      // The critic's cases: they contain "tokenhud" and end in "hook".
      { type: "command", command: "bash /home/u/projects/tokenhud/scripts/notify.sh hook" },
      { type: "command", command: "python3 /home/u/tokenhud-tools/lint.py --mode hook" },
      { type: "command", command: "my-tokenhud-wrapper hook" },
      { type: "command", command: "tokenhud hook" },
      { type: "command", command: "'/opt/tools/notify' hook; exit 0" },
      { type: "command", command: "'/opt/tokenhud/bin/tokenhud' mcp; exit 0" },
      { type: "command", command: "tokenhud", args: ["hook"] },
      { type: "command", command: PLUGIN_COMMAND, shell: "powershell" },
      { type: "command", command: "& 'C:\\t\\tokenhud.exe' hook; exit 0" },
      { type: "command", command: LINE, shell: "powershell" },
      { type: "http", url: "http://localhost/tokenhud/hook" },
      "tokenhud hook; exit 0",
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
});

describe("editHooks", () => {
  test("into no settings file: creates it, owner-only, with exactly tokenhud's hooks", () => {
    const path = settingsFile();
    const change = editHooks(path, CMD, { remove: false, now: NOW });
    expect(change).toEqual({
      changed: true,
      created: true,
      backup: null,
      added: [`PostToolBatch: ${LINE}`, `UserPromptSubmit: ${LINE}`, `SessionEnd: ${LINE}`],
      removed: [],
    });
    // The snippet the handoff quotes.
    expect(read(path)).toEqual({
      hooks: {
        PostToolBatch: [{ hooks: [{ type: "command", command: LINE, timeout: 10 }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: LINE, timeout: 10 }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: LINE }] }],
      },
    });
    expect(hooksInstalled(read(path))).toBe(true);
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("on Windows the entries name PowerShell", () => {
    const path = settingsFile();
    editHooks(path, hookCommand(["C:\\t\\tokenhud.exe"], "win32"), { remove: false, now: NOW });
    expect(read(path).hooks.UserPromptSubmit).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: "& 'C:\\t\\tokenhud.exe' hook; exit 0",
            shell: "powershell",
            timeout: 10,
          },
        ],
      },
    ]);
  });

  test("merges: every other setting and hook kept, a backup of the file as it was", () => {
    const path = settingsFile(THEIRS);
    const before = readFileSync(path, "utf8");
    const change = editHooks(path, CMD, { remove: false, now: NOW });
    expect(change.backup).toBe(backupPath(path, NOW));
    expect(change.backup).toEndWith("settings.json.tokenhud-20261001T150000000Z.bak");
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

  test.if(posix)(
    "keeps the file's mode and owner: 0600 stays 0600, and the backup has it too",
    () => {
      for (const mode of [0o600, 0o640]) {
        const path = settingsFile(THEIRS);
        chmodSync(path, mode);
        const owner = statSync(path).uid;
        const change = editHooks(path, CMD, { remove: false, now: NOW });
        expect(statSync(path).mode & 0o777).toBe(mode);
        expect(statSync(change.backup as string).mode & 0o777).toBe(mode);
        expect(statSync(path).uid).toBe(owner);
        editHooks(path, CMD, { remove: true, now: NOW + 1 });
        expect(statSync(path).mode & 0o777).toBe(mode);
      }
    },
  );

  test.if(posix)(
    "follows a symlinked settings.json: the target is edited and backed up beside it, the link kept",
    () => {
      const dir = join(tempDir(), ".claude");
      const dotfiles = join(tempDir(), "dotfiles");
      mkdirSync(dir, { recursive: true });
      mkdirSync(dotfiles, { recursive: true });
      const target = join(dotfiles, "claude-settings.json");
      writeFileSync(target, JSON.stringify(THEIRS));
      const link = join(dir, "settings.json");
      symlinkSync(target, link);
      const change = editHooks(link, CMD, { remove: false, now: NOW });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(target);
      expect(hooksInstalled(read(target))).toBe(true);
      expect(change.backup).toBe(backupPath(target, NOW));
      expect(read(change.backup as string)).toEqual(THEIRS);
      // Nothing but the link in the config dir; no temp file left anywhere.
      expect(readdirSync(dir)).toEqual(["settings.json"]);
      expect(readdirSync(dotfiles).sort()).toEqual([
        "claude-settings.json",
        "claude-settings.json.tokenhud-20261001T150000000Z.bak",
      ]);
    },
  );

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
    expect(backups(path)).toHaveLength(1);
    const moved = hookCommand(["/usr/local/bin/tokenhud"], "linux");
    const change = editHooks(path, moved, { remove: false, now: NOW + 2000 });
    expect(change.removed).toHaveLength(3);
    expect(change.added).toEqual([
      "PostToolBatch: '/usr/local/bin/tokenhud' hook; exit 0",
      "UserPromptSubmit: '/usr/local/bin/tokenhud' hook; exit 0",
      "SessionEnd: '/usr/local/bin/tokenhud' hook; exit 0",
    ]);
    const hooks = read(path).hooks;
    expect(JSON.stringify(hooks)).not.toContain("/opt/tokenhud");
    expect(hooks.PostToolBatch).toEqual([
      ...THEIRS.hooks.PostToolBatch,
      ...tokenhudHooks(moved).PostToolBatch,
    ]);
  });

  test("two edits in one millisecond keep both backups", () => {
    const path = settingsFile(THEIRS);
    const first = editHooks(path, CMD, { remove: false, now: NOW });
    const second = editHooks(path, CMD, { remove: true, now: NOW });
    expect(first.backup).toEndWith(".tokenhud-20261001T150000000Z.bak");
    expect(second.backup).toEndWith(".tokenhud-20261001T150000000Z-2.bak");
    // The first backup is still the original.
    expect(read(first.backup as string)).toEqual(THEIRS);
  });

  test("--remove takes out only tokenhud's hooks, and the groups and events they leave empty", () => {
    const path = settingsFile(THEIRS);
    editHooks(path, CMD, { remove: false, now: NOW });
    // A group of the user's that also runs tokenhud's hook: only tokenhud's entry goes.
    // Their hooks that mention tokenhud stay, on every event.
    const file = read(path);
    const lookalike = { type: "command", command: "bash ~/tokenhud/notify.sh hook" };
    file.hooks.SessionEnd[0].hooks.unshift({ type: "command", command: "say done" });
    file.hooks.PreToolUse.push({ hooks: [lookalike] });
    file.hooks.UserPromptSubmit.push({ hooks: [lookalike] });
    writeFileSync(path, JSON.stringify(file));
    const change = editHooks(path, CMD, { remove: true, now: NOW + 1000 });
    expect(change.changed).toBe(true);
    expect(change.removed).toEqual([
      `PostToolBatch: ${LINE}`,
      `UserPromptSubmit: ${LINE}`,
      `SessionEnd: ${LINE}`,
    ]);
    expect(read(path)).toEqual({
      ...THEIRS,
      hooks: {
        ...THEIRS.hooks,
        PreToolUse: [...THEIRS.hooks.PreToolUse, { hooks: [lookalike] }],
        UserPromptSubmit: [{ hooks: [lookalike] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "say done" }] }],
      },
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
    const ours = hookCommand([process.execPath, CLI]);
    const lines = added.out.trim().split("\n");
    expect(lines[0]).toBe(
      `tokenhud: updated ${short(m, m.work, "settings.json")} with tokenhud's alert hooks`,
    );
    expect(lines.slice(1, 4)).toEqual([
      `  + PostToolBatch: ${ours.command}`,
      `  + UserPromptSubmit: ${ours.command}`,
      `  + SessionEnd: ${ours.command}`,
    ]);
    expect(lines[4]).toMatch(/^ {2}the file as it was: .*\.tokenhud-\d{8}T\d{9}Z\.bak$/);
    const hook = read(join(m.work, "settings.json")).hooks.UserPromptSubmit[0].hooks[0];
    expect(hook).toEqual({
      type: "command",
      command: ours.command,
      ...(ours.shell !== undefined && { shell: ours.shell }),
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
