import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  comparePyPaths,
  pyExpandUser,
  pyNormPath,
  pyRealpath,
  type RealpathFs,
} from "../../src/sources/pypath.ts";
import { guard } from "../guard.ts";
import { cleanup, tempDir } from "../ingest/helpers.ts";

guard();

afterEach(cleanup);

describe("pyNormPath (str(PurePosixPath))", () => {
  test.each([
    ["", "."],
    [".", "."],
    ["a/b/", "a/b"],
    ["a//b/./c", "a/b/c"],
    ["/a/../b", "/a/../b"],
    ["//a", "//a"],
    ["///a", "/a"],
    ["/", "/"],
  ])("%j -> %j", (input, want) => {
    expect(pyNormPath(input)).toBe(want);
  });
});

test("pyExpandUser expands ~ and ~/..., not ~user or an inner ~", () => {
  expect(pyExpandUser("~", "/home/me/")).toBe("/home/me");
  expect(pyExpandUser("~/.claude/", "/home/me")).toBe("/home/me/.claude");
  expect(pyExpandUser("~other/.claude", "/home/me")).toBe("~other/.claude");
  expect(pyExpandUser("/x/~/y", "/home/me")).toBe("/x/~/y");
  expect(pyExpandUser("~", "/")).toBe("/");
});

/** A fake file system: `links` maps a path to its symlink target; everything else is a plain entry. */
function fakeFs(links: Record<string, string>, cwd = "/cwd"): RealpathFs {
  return {
    isSymlink: (p) => p in links,
    readlink: (p) => links[p] as string,
    cwd: () => cwd,
  };
}

describe("pyRealpath (posixpath.realpath, strict=False)", () => {
  test("follows absolute and relative links, and .. after a link pops the target", () => {
    const fs = fakeFs({ "/a/link": "/real/dir", "/b/rel": "../other" });
    expect(pyRealpath("/a/link/x", fs)).toBe("/real/dir/x");
    expect(pyRealpath("/a/link/../y", fs)).toBe("/real/y");
    expect(pyRealpath("/b/rel/z", fs)).toBe("/other/z");
  });

  test("a relative path starts from the cwd", () => {
    expect(pyRealpath("x/../y", fakeFs({}, "/w"))).toBe("/w/y");
  });

  test("a symlink loop leaves the looping link in place", () => {
    const fs = fakeFs({ "/loop/a": "/loop/b", "/loop/b": "/loop/a" });
    expect(pyRealpath("/loop/a/x", fs)).toBe("/loop/a/x");
  });

  test("a chain of links resolves fully, and a resolved link is reused", () => {
    const fs = fakeFs({ "/c1": "/c2", "/c2": "/c3/d", "/c3/d": "/end" });
    expect(pyRealpath("/c1/f", fs)).toBe("/end/f");
  });

  test.skipIf(process.platform === "win32")("matches realpath on the real file system", () => {
    const base = realpathSync(tempDir());
    mkdirSync(join(base, "real", "deep"), { recursive: true });
    symlinkSync(join(base, "real"), join(base, "abs"));
    symlinkSync("real/deep", join(base, "rel"));
    for (const p of ["abs", "abs/deep", "rel", "rel/..", "abs/deep/../deep"]) {
      expect(pyRealpath(join(base, p))).toBe(realpathSync(join(base, p)));
    }
    // a missing tail is kept as written
    expect(pyRealpath(join(base, "abs", "missing", "x"))).toBe(join(base, "real", "missing", "x"));
  });
});

describe("comparePyPaths (Python's Path order)", () => {
  test("parts compare one by one: a subdirectory sorts before a sibling file with a longer name", () => {
    const paths = ["/p/abc.jsonl", "/p/abc/subagents/x.jsonl", "/p/ab.jsonl", "/p/abc-2.jsonl"];
    expect([...paths].sort((a, b) => comparePyPaths(a, b, "linux"))).toEqual([
      "/p/ab.jsonl",
      "/p/abc/subagents/x.jsonl",
      "/p/abc-2.jsonl",
      "/p/abc.jsonl",
    ]);
    // a plain string sort puts "abc.jsonl" ("." < "/") before the subdirectory
    expect([...paths].sort()[2]).toBe("/p/abc.jsonl");
  });

  test("by code point, not UTF-16 unit, and case-sensitively", () => {
    expect(comparePyPaths("/p/\u{1F600}", "/p/\uFFFF", "linux")).toBeGreaterThan(0);
    expect(comparePyPaths("/p/B", "/p/a", "linux")).toBeLessThan(0);
  });

  test("Windows paths compare case-insensitively on backslash parts", () => {
    expect(comparePyPaths("C:\\P\\b", "c:\\p\\A", "win32")).toBeGreaterThan(0);
    expect(comparePyPaths("C:\\p\\abc\\x", "C:\\p\\abc.jsonl", "win32")).toBeLessThan(0);
  });
});
