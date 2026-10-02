import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { type ResolveContext, resolveAccount, transcriptExists } from "../../src/mcp/accounts.ts";
import { ToolError } from "../../src/mcp/errors.ts";
import type { Root } from "../../src/sources/roots.ts";
import { cleanup, type Machine, machine, rootsOf, SESSION, transcript } from "./helpers.ts";

afterEach(cleanup);

// Real discovery over a fake HOME: ~/.claude (personal), ~/.claude-work (work), ~/.codex.
function ctx(
  m: Machine,
  env: Record<string, string> = {},
  lastSeen: Record<string, number> = {},
): ResolveContext & { checked: string[] } {
  const full = { ...m.env, ...env };
  const checked: string[] = [];
  return {
    env: full,
    home: m.home,
    roots: rootsOf(m, full).filter((r) => r.enabled),
    hasTranscript: (root: Root, id: string) => {
      checked.push(root.label);
      return transcriptExists(root, id);
    },
    lastSeen: (root) => lastSeen[root.label] ?? null,
    checked,
  };
}

function failure(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error("expected a ToolError");
}

describe("explicit account", () => {
  test("a label, in any case, or a root identity", () => {
    const m = machine();
    const c = ctx(m, { CLAUDE_CONFIG_DIR: m.claude });
    expect(resolveAccount({ account: "WORK" }, c)).toMatchObject({
      root: { label: "work", path: m.work },
      detectedVia: "argument",
    });
    const work = c.roots.find((r) => r.label === "work") as Root;
    expect(resolveAccount({ account: work.identity }, c).root.label).toBe("work");
    // The argument wins over the env and needs no transcript check.
    expect(c.checked).toEqual([]);
  });

  test("an unknown account names the known ones", () => {
    const m = machine();
    const error = failure(() => resolveAccount({ account: "nope" }, ctx(m)));
    expect(error.code).toBe("unknown_account");
    expect(error.message).toBe("unknown account 'nope' (accounts: personal, work, codex)");
  });

  test("a provider that doesn't match the account is refused", () => {
    const m = machine();
    const error = failure(() => resolveAccount({ account: "codex", provider: "claude" }, ctx(m)));
    expect(error.code).toBe("bad_argument");
    expect(error.message).toBe("account 'codex' is a codex account, not claude");
  });
});

describe("Claude: env and default", () => {
  test("CLAUDE_CONFIG_DIR unset: ~/.claude", () => {
    const m = machine();
    expect(resolveAccount({}, ctx(m))).toMatchObject({
      root: { label: "personal", path: m.claude },
      detectedVia: "default",
    });
  });

  test("CLAUDE_CONFIG_DIR set: the root at that resolved path", () => {
    const m = machine();
    expect(resolveAccount({}, ctx(m, { CLAUDE_CONFIG_DIR: m.work }))).toMatchObject({
      root: { label: "work" },
      detectedVia: "env",
    });
    // A trailing slash or a symlink to the dir is the same account.
    expect(resolveAccount({}, ctx(m, { CLAUDE_CONFIG_DIR: `${m.work}/` })).root.label).toBe("work");
    if (process.platform !== "win32") {
      // Discovery lists the env path first, so it names the account after the link; the
      // identity (the resolved path's hash) is the same.
      const work = rootsOf(m).find((r) => r.label === "work") as Root;
      const link = join(m.home, "work-link");
      symlinkSync(m.work, link);
      const viaLink = resolveAccount({}, ctx(m, { CLAUDE_CONFIG_DIR: link }));
      expect(viaLink.detectedVia).toBe("env");
      expect(viaLink.root.identity).toBe(work.identity);
    }
  });

  test("CLAUDE_CONFIG_DIR naming no known dir, with no transcript to go by, is an error", () => {
    const m = machine();
    const error = failure(() =>
      resolveAccount({}, ctx(m, { CLAUDE_CONFIG_DIR: join(m.home, ".claude-gone") })),
    );
    expect(error.code).toBe("unknown_account");
    expect(error.message).toContain("CLAUDE_CONFIG_DIR");
    expect(error.message).not.toContain(m.home);
  });
});

describe("Claude: the transcript cross-check", () => {
  test("the session's transcript under another root wins: detected_via transcript", () => {
    const m = machine();
    transcript(m.work);
    // The env says nothing, so the default would be personal; the session lives in work.
    const c = ctx(m, { CLAUDE_CODE_SESSION_ID: SESSION });
    expect(resolveAccount({}, c)).toMatchObject({
      root: { label: "work" },
      detectedVia: "transcript",
    });
    expect(c.checked).toEqual(["personal", "work"]);
  });

  test("it also corrects a CLAUDE_CONFIG_DIR that points elsewhere", () => {
    const m = machine();
    transcript(m.claude);
    const c = ctx(m, { CLAUDE_CONFIG_DIR: m.work, CLAUDE_CODE_SESSION_ID: SESSION });
    expect(resolveAccount({}, c)).toMatchObject({
      root: { label: "personal" },
      detectedVia: "transcript",
    });
  });

  test("the transcript where the env says: env stands, other roots aren't searched", () => {
    const m = machine();
    transcript(m.work);
    const c = ctx(m, { CLAUDE_CONFIG_DIR: m.work, CLAUDE_CODE_SESSION_ID: SESSION });
    expect(resolveAccount({}, c)).toMatchObject({ root: { label: "work" }, detectedVia: "env" });
    expect(c.checked).toEqual(["work"]);
  });

  test("a transcript found nowhere, or no session id at all, leaves the env answer", () => {
    const m = machine();
    expect(resolveAccount({}, ctx(m, { CLAUDE_CODE_SESSION_ID: SESSION })).detectedVia).toBe(
      "default",
    );
    const c = ctx(m, { CLAUDE_CONFIG_DIR: m.work });
    expect(resolveAccount({}, c).detectedVia).toBe("env");
    expect(c.checked).toEqual([]);
  });

  test("an unknown CLAUDE_CONFIG_DIR is rescued by the transcript", () => {
    const m = machine();
    transcript(m.work);
    const c = ctx(m, {
      CLAUDE_CONFIG_DIR: join(m.home, ".claude-gone"),
      CLAUDE_CODE_SESSION_ID: SESSION,
    });
    expect(resolveAccount({}, c)).toMatchObject({
      root: { label: "work" },
      detectedVia: "transcript",
    });
  });

  test("a session id that isn't a plain id is ignored, never joined into a path", () => {
    const m = machine();
    // A file that a traversal through the session id would find.
    mkdirSync(join(m.work, "x"), { recursive: true });
    transcript(m.work, "evil", "..");
    for (const id of ["../evil", "..", "a/b", ".hidden", ""]) {
      const c = ctx(m, { CLAUDE_CODE_SESSION_ID: id });
      expect(resolveAccount({}, c).detectedVia).toBe("default");
      expect(c.checked).toEqual([]);
    }
  });

  test.skipIf(process.platform === "win32")(
    "only the transcript's existence is checked: an unreadable one is found",
    () => {
      const m = machine();
      const path = transcript(m.work);
      chmodSync(path, 0o000);
      try {
        expect(resolveAccount({}, ctx(m, { CLAUDE_CODE_SESSION_ID: SESSION })).detectedVia).toBe(
          "transcript",
        );
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );
});

describe("Codex", () => {
  test("provider codex: the root CODEX_HOME names", () => {
    const m = machine();
    const other = join(m.home, "codex-other");
    mkdirSync(join(other, "sessions"), { recursive: true });
    const c = ctx(m, { CODEX_HOME: other });
    expect(resolveAccount({ provider: "codex" }, c)).toMatchObject({
      root: { provider: "codex", path: other },
      detectedVia: "env",
    });
  });

  test("without CODEX_HOME: the most recently active Codex account, else ~/.codex", () => {
    const m = machine();
    const other = join(m.home, "codex-other");
    mkdirSync(join(other, "sessions"), { recursive: true });
    // CODEX_HOME makes discovery list the second home; the server's env may lack it later.
    const listed = ctx(m, { CODEX_HOME: other });
    const codexRoots = listed.roots.filter((r) => r.provider === "codex");
    expect(codexRoots.map((r) => r.label)).toEqual(["codex", "codex-other"]);
    const recent: ResolveContext = {
      ...listed,
      env: m.env,
      lastSeen: (root) =>
        root.label === "codex-other" ? 2_000 : root.label === "codex" ? 1_000 : null,
    };
    expect(resolveAccount({ provider: "codex" }, recent)).toMatchObject({
      root: { label: "codex-other" },
      detectedVia: "recent",
    });
    expect(resolveAccount({ provider: "codex" }, ctx(m))).toMatchObject({
      root: { label: "codex", path: m.codex },
      detectedVia: "default",
    });
  });
});

describe("transcriptExists", () => {
  test("looks one project deep for <id>.jsonl", () => {
    const m = machine();
    const work = rootsOf(m).find((r) => r.label === "work") as Root;
    expect(transcriptExists(work, SESSION)).toBe(false);
    transcript(m.work, SESSION, "-some-project");
    expect(transcriptExists(work, SESSION)).toBe(true);
    expect(transcriptExists(work, "00000000-0000-4000-8000-000000000002")).toBe(false);
  });

  test("a root without a projects dir has no transcripts", () => {
    const m = machine();
    const codex = rootsOf(m).find((r) => r.label === "codex") as Root;
    expect(transcriptExists({ ...codex, projects: join(m.home, "missing") }, SESSION)).toBe(false);
  });
});
