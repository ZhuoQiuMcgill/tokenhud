import { describe, expect, test } from "bun:test";
import {
  assetName,
  bunTarget,
  formatSums,
  npmPackage,
  RELEASE_TARGETS,
  sumFor,
  targetById,
  targetId,
} from "../../src/release.ts";
import { guard } from "../guard.ts";

guard();

describe("release targets", () => {
  test("every target's asset, Bun target and npm package, as the release and npm name them", () => {
    expect(
      RELEASE_TARGETS.map((t) => [targetId(t), assetName(t), bunTarget(t), npmPackage(t)]),
    ).toEqual([
      ["linux-x64", "tokenhud-linux-x64", "bun-linux-x64", "@tokenhud/linux-x64"],
      ["linux-arm64", "tokenhud-linux-arm64", "bun-linux-arm64", "@tokenhud/linux-arm64"],
      [
        "linux-x64-musl",
        "tokenhud-linux-x64-musl",
        "bun-linux-x64-musl",
        "@tokenhud/linux-x64-musl",
      ],
      [
        "linux-arm64-musl",
        "tokenhud-linux-arm64-musl",
        "bun-linux-arm64-musl",
        "@tokenhud/linux-arm64-musl",
      ],
      ["darwin-x64", "tokenhud-darwin-x64", "bun-darwin-x64", "@tokenhud/darwin-x64"],
      ["darwin-arm64", "tokenhud-darwin-arm64", "bun-darwin-arm64", "@tokenhud/darwin-arm64"],
      ["windows-x64", "tokenhud-windows-x64.exe", "bun-windows-x64", "@tokenhud/win32-x64"],
      ["windows-arm64", "tokenhud-windows-arm64.exe", "bun-windows-arm64", "@tokenhud/win32-arm64"],
    ]);
  });

  test("ids find their target, and nothing else does", () => {
    for (const t of RELEASE_TARGETS) expect(targetById(targetId(t))).toBe(t);
    expect(targetById("win32-x64")).toBeUndefined();
    expect(targetById("linux-x64-gnu")).toBeUndefined();
  });
});

describe("SHA256SUMS", () => {
  const a = "a".repeat(64);
  const b = "0123456789abcdef".repeat(4);

  test("is sha256sum's format, sorted by name", () => {
    const sums = new Map([
      ["tokenhud-windows-x64.exe", a],
      ["tokenhud-darwin-arm64", b],
    ]);
    expect(formatSums(sums)).toBe(`${b}  tokenhud-darwin-arm64\n${a}  tokenhud-windows-x64.exe\n`);
  });

  test("reads back what it writes, by exact name", () => {
    const text = formatSums(
      new Map([
        ["tokenhud-linux-x64", a],
        ["tokenhud-linux-x64-musl", b],
      ]),
    );
    expect(sumFor(text, "tokenhud-linux-x64")).toBe(a);
    expect(sumFor(text, "tokenhud-linux-x64-musl")).toBe(b);
    expect(sumFor(text, "tokenhud-linux")).toBeNull();
    expect(sumFor("not a sums file", "tokenhud-linux-x64")).toBeNull();
  });
});
