import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, defaultConfig } from "../../src/config.ts";
import {
  CODEX_ACCOUNT,
  type DiscoverOptions,
  dedupeLabel,
  deriveLabel,
  discoverClaudeRoots,
  discoverCodexRoots,
  rootIdentity,
} from "../../src/sources/roots.ts";
import vectors from "../fixtures/sources/identity-vectors.json";
import { cleanup, makeRoot, tempDir } from "../ingest/helpers.ts";

afterEach(cleanup);

function cfg(over: Partial<Config> = {}): Config {
  return { ...defaultConfig(), ...over };
}

function opts(
  home: string,
  env: Record<string, string> = {},
  wslUsersDir: string | null = null,
): DiscoverOptions {
  return { home, env, wslUsersDir };
}

function codexRoot(base: string, name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, "sessions"), { recursive: true });
  return root;
}

describe("identity (cc-usage's root_identity)", () => {
  // Python resolved these lexically (no component exists), so the port runs with a file
  // system that has no symlinks; the real file system is covered below.
  const noLinks = {
    isSymlink: (): boolean => {
      throw new Error("ENOENT");
    },
    readlink: (): string => {
      throw new Error("ENOENT");
    },
    cwd: () => "/nowhere",
  };

  test.each(vectors.map((v) => [v.path, v.identity]))("%j", (path, identity) => {
    expect(rootIdentity(path, "/home/example", "linux", noLinks)).toBe(identity);
  });

  test("covers WSL drive paths and unicode", () => {
    expect(vectors.filter((v) => v.path.startsWith("/mnt/")).length).toBeGreaterThanOrEqual(3);
    expect(
      vectors.filter((v) => [...v.path].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)).length,
    ).toBeGreaterThanOrEqual(3);
    expect(vectors.length).toBeGreaterThanOrEqual(10);
  });

  test.skipIf(process.platform === "win32")(
    "a symlinked root has its target's identity and dedupes with it",
    () => {
      const base = realpathSync(tempDir());
      const home = join(base, "home");
      const real = makeRoot(home, ".claude");
      symlinkSync(real, join(base, "alias"));
      expect(rootIdentity(join(base, "alias"), home)).toBe(rootIdentity(real, home));
      const roots = discoverClaudeRoots(
        cfg({ claude_roots: [{ path: join(base, "alias") }] }),
        opts(home),
      );
      expect(roots).toHaveLength(1);
    },
  );
});

describe("labels", () => {
  test("derive strips the provider prefix, else a leading dot; never empty", () => {
    expect(deriveLabel(".claude-work", ".claude-")).toBe("work");
    expect(deriveLabel(".codex", ".codex-")).toBe("codex");
    expect(deriveLabel("work", ".claude-")).toBe("work");
    expect(deriveLabel(".claude-", ".claude-")).toBe(".claude-");
    expect(deriveLabel(".", "")).toBe(".");
  });

  test("dedupe suffixes -2, -3, ...", () => {
    const used = new Set(["all"]);
    expect(["a", "a", "a", "all"].map((l) => dedupeLabel(l, used))).toEqual([
      "a",
      "a-2",
      "a-3",
      "all-2",
    ]);
  });
});

// ── ported from cc-usage tests/test_accounts.py (R1, T12 discovery) ────────────────

describe("Claude discovery", () => {
  test("default_only", () => {
    const home = join(tempDir(), "home");
    makeRoot(home, ".claude");
    const roots = discoverClaudeRoots(cfg(), opts(home));
    expect(roots.map((r) => [r.label, r.source, r.enabled])).toEqual([["personal", "auto", true]]);
  });

  test("the default root is listed even before it exists", () => {
    const home = join(tempDir(), "home");
    expect(discoverClaudeRoots(cfg(), opts(home)).map((r) => r.label)).toEqual(["personal"]);
  });

  test("env_root_labeled_and_ordered", () => {
    const home = join(tempDir(), "home");
    makeRoot(home, ".claude");
    const company = join(tempDir(), "elsewhere", ".claude-company");
    mkdirSync(join(company, "projects"), { recursive: true });
    const roots = discoverClaudeRoots(cfg(), opts(home, { CLAUDE_CONFIG_DIR: company }));
    expect(roots.map((r) => r.label)).toEqual(["personal", "company"]);
    expect(roots.map((r) => r.source)).toEqual(["auto", "env"]);
    expect(roots[1]?.projects).toBe(join(company, "projects"));
  });

  test("env_equal_to_default_is_deduped", () => {
    const home = join(tempDir(), "home");
    makeRoot(home, ".claude");
    const roots = discoverClaudeRoots(
      cfg(),
      opts(home, { CLAUDE_CONFIG_DIR: join(home, ".claude") }),
    );
    expect(roots.map((r) => r.source)).toEqual(["auto"]);
  });

  test("config_roots_and_missing_skipped", () => {
    const base = tempDir();
    const home = join(base, "home");
    makeRoot(home, ".claude");
    const extra = makeRoot(base, "extra");
    const config = cfg({
      claude_roots: [{ path: extra, label: "work" }, { path: join(base, "ghost") }],
    });
    expect(discoverClaudeRoots(config, opts(home)).map((r) => r.label)).toEqual([
      "personal",
      "work",
    ]);
  });

  test("label_derivation_and_collision_suffix", () => {
    const base = tempDir();
    const home = join(base, "home");
    makeRoot(home, ".claude");
    const a = makeRoot(join(base, "a"), ".claude-team");
    const b = makeRoot(join(base, "b"), ".claude-team");
    const roots = discoverClaudeRoots(
      cfg({ claude_roots: [{ path: a }, { path: b }] }),
      opts(home),
    );
    expect(roots.map((r) => r.label)).toEqual(["personal", "team", "team-2"]);
  });

  test("codex_label_is_reserved", () => {
    const base = tempDir();
    const home = join(base, "home");
    makeRoot(home, ".claude");
    const c = makeRoot(join(base, "c"), ".claude-codex");
    const roots = discoverClaudeRoots(cfg({ claude_roots: [{ path: c }] }), opts(home));
    expect(roots.map((r) => r.label)).not.toContain(CODEX_ACCOUNT);
    expect(roots.at(-1)?.label).toBe("codex-2");
  });

  test("all_label_is_reserved", () => {
    const base = tempDir();
    const home = join(base, "home");
    makeRoot(home, ".claude");
    const a = makeRoot(join(base, "x"), ".claude-all");
    const b = makeRoot(join(base, "y"), "work");
    const roots = discoverClaudeRoots(
      cfg({ claude_roots: [{ path: a }, { path: b, label: "all" }] }),
      opts(home),
    );
    expect(roots.map((r) => r.label)).toEqual(["personal", "all-2", "all-3"]);
  });

  test("enabled_false_and_disabled_roots", () => {
    const base = tempDir();
    const home = join(base, "home");
    makeRoot(home, ".claude");
    const e = makeRoot(base, "e");
    const f = makeRoot(base, "f");
    const config = cfg({
      claude_roots: [
        { path: e, label: "e", enabled: false },
        { path: f, label: "f" },
      ],
      disabled_roots: [f],
    });
    const by = new Map(discoverClaudeRoots(config, opts(home)).map((r) => [r.label, r.enabled]));
    expect(Object.fromEntries(by)).toEqual({ personal: true, e: false, f: false });
  });
});

describe("Codex discovery", () => {
  test("default_only", () => {
    const home = join(tempDir(), "home");
    codexRoot(home, ".codex");
    const roots = discoverCodexRoots(cfg(), opts(home));
    expect(roots.map((r) => [r.label, r.source, r.enabled])).toEqual([["codex", "auto", true]]);
    expect(roots[0]?.projects).toBe(join(home, ".codex", "sessions"));
  });

  test("env_is_additive", () => {
    const base = tempDir();
    const home = join(base, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const win = codexRoot(base, ".codex-win");
    const roots = discoverCodexRoots(cfg(), opts(home, { CODEX_HOME: win }));
    expect(roots.map((r) => r.label)).toEqual(["codex", "win"]);
    expect(roots.map((r) => r.source)).toEqual(["auto", "env"]);
    expect(roots[1]?.projects).toBe(join(win, "sessions"));
  });

  test("env_equal_to_default_is_deduped", () => {
    const home = join(tempDir(), "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const roots = discoverCodexRoots(cfg(), opts(home, { CODEX_HOME: join(home, ".codex") }));
    expect(roots.map((r) => r.source)).toEqual(["auto"]);
  });

  test("config_roots_and_missing_skipped", () => {
    const base = tempDir();
    const home = join(base, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const extra = codexRoot(base, "extra-codex");
    const config = cfg({
      codex_roots: [{ path: extra, label: "work" }, { path: join(base, "ghost") }],
    });
    expect(discoverCodexRoots(config, opts(home)).map((r) => r.label)).toEqual(["codex", "work"]);
  });

  test("labels_reserved_against_claude_and_all", () => {
    const base = tempDir();
    const home = join(base, "home");
    makeRoot(home, ".claude");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const claudeWork = makeRoot(join(base, "cl"), ".claude-work");
    const codexWork = codexRoot(join(base, "cx"), ".codex-work");
    const codexAll = codexRoot(join(base, "cy"), ".codex-all");
    const config = cfg({
      claude_roots: [{ path: claudeWork }],
      codex_roots: [{ path: codexWork }, { path: codexAll }],
    });
    const claude = discoverClaudeRoots(config, opts(home));
    const codex = discoverCodexRoots(config, opts(home), claude);
    expect(claude.map((r) => r.label)).toEqual(["personal", "work"]);
    expect(codex.map((r) => r.label)).toEqual(["codex", "work-2", "all-2"]);
  });

  test("enabled_false_and_disabled_roots", () => {
    const base = tempDir();
    const home = join(base, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const e = codexRoot(base, "ce");
    const f = codexRoot(base, "cf");
    const config = cfg({
      codex_roots: [
        { path: e, label: "ce", enabled: false },
        { path: f, label: "cf" },
      ],
      disabled_roots: [f],
    });
    const by = Object.fromEntries(
      discoverCodexRoots(config, opts(home)).map((r) => [r.label, r.enabled]),
    );
    expect(by).toEqual({ codex: true, ce: false, cf: false });
  });
});

// ── new in tokenhud ──────────────────────────────────────────────────────────────

describe("globbed roots", () => {
  test("~/.claude-* directories are roots; files and other names are not", () => {
    const home = join(tempDir(), "home");
    makeRoot(home, ".claude");
    makeRoot(home, ".claude-b");
    mkdirSync(join(home, ".claude-a"));
    writeFileSync(join(home, ".claude-file.json"), "{}");
    writeFileSync(join(home, ".claude.json"), "{}");
    const roots = discoverClaudeRoots(cfg(), opts(home));
    expect(roots.map((r) => [r.label, r.source])).toEqual([
      ["personal", "auto"],
      ["a", "home"],
      ["b", "home"],
    ]);
  });

  test("a configured label wins over a globbed one for the same root", () => {
    const home = join(tempDir(), "home");
    const team = makeRoot(home, ".claude-team");
    const roots = discoverClaudeRoots(
      cfg({ claude_roots: [{ path: team, label: "company" }] }),
      opts(home),
    );
    expect(roots.map((r) => [r.label, r.source])).toEqual([
      ["personal", "auto"],
      ["company", "config"],
    ]);
  });

  test("Windows-side roots under WSL: .claude* and .codex* dirs per user, labelled -win", () => {
    const base = tempDir();
    const home = join(base, "home");
    const users = join(base, "Users");
    makeRoot(join(users, "someone"), ".claude");
    makeRoot(join(users, "someone"), ".claude-team");
    writeFileSync(join(users, "someone", ".claude.json"), "{}");
    codexRoot(join(users, "someone"), ".codex");
    mkdirSync(join(users, "Public"), { recursive: true });
    const options = opts(home, {}, users);
    const claude = discoverClaudeRoots(cfg(), options);
    expect(claude.map((r) => [r.label, r.source])).toEqual([
      ["personal", "auto"],
      ["claude-win", "wsl"],
      ["team-win", "wsl"],
    ]);
    const codex = discoverCodexRoots(cfg(), options, claude);
    expect(codex.map((r) => [r.label, r.source])).toEqual([
      ["codex", "auto"],
      ["codex-win", "wsl"],
    ]);
  });

  test("TOKENHUD_WSL_USERS points the Windows search elsewhere; empty turns it off", () => {
    const base = tempDir();
    const home = join(base, "home");
    const users = join(base, "Users");
    makeRoot(join(users, "someone"), ".claude");
    const env = (v: string) => ({ home, env: { TOKENHUD_WSL_USERS: v } });
    expect(discoverClaudeRoots(cfg(), env(users)).map((r) => r.label)).toEqual([
      "personal",
      "claude-win",
    ]);
    expect(discoverClaudeRoots(cfg(), env("")).map((r) => r.label)).toEqual(["personal"]);
  });
});

test("history_only_roots marks roots by identity", () => {
  const base = tempDir();
  const home = join(base, "home");
  makeRoot(home, ".claude");
  const old = makeRoot(home, ".claude-old");
  const roots = discoverClaudeRoots(
    cfg({ history_only_roots: [rootIdentity(old, home)] }),
    opts(home),
  );
  expect(roots.map((r) => [r.label, r.historyOnly, r.enabled])).toEqual([
    ["personal", false, true],
    ["old", true, true],
  ]);
});

// ── tokenhud: config labels apply by identity (PM ruling for T10) ────────────────────
// cc-usage dropped a config entry that resolved to the default or env root, so those two
// could never be renamed. tokenhud applies the entry's label and enabled flag to the
// root it resolves to, wherever discovery found that root.

describe("config entries apply to the root they resolve to", () => {
  test("a config label renames the default root, which stays first and 'auto'", () => {
    const home = join(tempDir(), "home");
    makeRoot(home, ".claude");
    for (const path of [join(home, ".claude"), "~/.claude", `${join(home, ".claude")}/`]) {
      const roots = discoverClaudeRoots(
        cfg({ claude_roots: [{ path, label: "main" }] }),
        opts(home),
      );
      expect(roots.map((r) => [r.label, r.source, r.labelExplicit])).toEqual([
        ["main", "auto", true],
      ]);
    }
  });

  test("a config label renames the CLAUDE_CONFIG_DIR root", () => {
    const home = join(tempDir(), "home");
    makeRoot(home, ".claude");
    const company = join(tempDir(), "elsewhere", ".claude-company");
    mkdirSync(join(company, "projects"), { recursive: true });
    const roots = discoverClaudeRoots(
      cfg({ claude_roots: [{ path: company, label: "client" }] }),
      opts(home, { CLAUDE_CONFIG_DIR: company }),
    );
    expect(roots.map((r) => [r.label, r.source, r.labelExplicit])).toEqual([
      ["personal", "auto", false],
      ["client", "env", true],
    ]);
  });

  test("through a symlink: the entry matches by resolved path", () => {
    const base = tempDir();
    const home = join(base, "home");
    makeRoot(home, ".claude");
    symlinkSync(join(home, ".claude"), join(base, "link"));
    const roots = discoverClaudeRoots(
      cfg({ claude_roots: [{ path: join(base, "link"), label: "main" }] }),
      opts(home),
    );
    expect(roots.map((r) => r.label)).toEqual(["main"]);
  });

  test("an entry's enabled: false switches the default root off", () => {
    const home = join(tempDir(), "home");
    makeRoot(home, ".claude");
    const roots = discoverClaudeRoots(
      cfg({ claude_roots: [{ path: "~/.claude", enabled: false }] }),
      opts(home),
    );
    expect(roots.map((r) => [r.label, r.enabled, r.labelExplicit])).toEqual([
      ["personal", false, false],
    ]);
  });

  test("a configured name is taken first; a later derived one is suffixed", () => {
    const home = join(tempDir(), "home");
    makeRoot(home, ".claude");
    makeRoot(home, ".claude-work");
    const roots = discoverClaudeRoots(
      cfg({ claude_roots: [{ path: "~/.claude", label: "work" }] }),
      opts(home),
    );
    expect(roots.map((r) => [r.label, r.source])).toEqual([
      ["work", "auto"],
      ["work-2", "home"],
    ]);
  });

  test("Codex: a config label renames ~/.codex", () => {
    const home = join(tempDir(), "home");
    codexRoot(home, ".codex");
    const roots = discoverCodexRoots(
      cfg({ codex_roots: [{ path: "~/.codex", label: "openai" }] }),
      opts(home),
    );
    expect(roots.map((r) => [r.label, r.source, r.labelExplicit])).toEqual([
      ["openai", "auto", true],
    ]);
  });
});
