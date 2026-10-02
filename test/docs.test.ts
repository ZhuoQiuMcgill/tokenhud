import { describe, expect, test } from "bun:test";
import {
  checkDocs,
  checkInvocation,
  cliSpec,
  documentedKeys,
  invocations,
  proseKeys,
} from "../scripts/check-docs.ts";

describe("the user docs", () => {
  test("mention only commands, options, variables and keys that exist", () => {
    expect(checkDocs()).toEqual([]);
  });
});

describe("the docs checker", () => {
  const spec = cliSpec();
  const check = (line: string) =>
    invocations(`\`${line}\``).flatMap(({ words }) => checkInvocation(words, spec));

  test("accepts real commands, options with values, and usage notation", () => {
    expect(check("tokenhud --once --width 100")).toEqual([]);
    expect(check("tokenhud json usage --period today --group-by model")).toEqual([]);
    expect(check("tokenhud json usage [--period P] [--account A]... [--refresh]")).toEqual([]);
    expect(check("tokenhud update --check --prerelease")).toEqual([]);
    expect(check("claude mcp add -s user tokenhud -- tokenhud mcp")).toEqual([]);
  });

  test("flags commands, queries and options that don't exist", () => {
    expect(check("tokenhud frobnicate")).toEqual(["there is no command 'tokenhud frobnicate'"]);
    expect(check("tokenhud json sessions")).toEqual(["there is no 'tokenhud json sessions'"]);
    expect(check("tokenhud update --force")).toEqual(["tokenhud update has no --force"]);
    expect(check("tokenhud --twice")).toEqual(["tokenhud has no --twice"]);
    expect(check("tokenhud doctor extra")).toEqual(["tokenhud doctor takes no argument 'extra'"]);
    expect(check("tokenhud json usage today")).toEqual([
      "tokenhud json usage takes no argument 'today'",
    ]);
  });

  test("checks every tokenhud on a line, the one after `--` too", () => {
    expect(check("claude mcp add -s user tokenhud -- tokenhud mcpp")).toEqual([
      "there is no command 'tokenhud mcpp'",
    ]);
    expect(check("tokenhud doctor && tokenhud frob")).toEqual([
      "there is no command 'tokenhud frob'",
    ]);
    expect(check("tokenhud doctor # then tokenhud frob")).toEqual([]);
  });

  test("leaves paths, packages and URLs alone", () => {
    expect(invocations("`~/.config/tokenhud/tokenhud.db` `npm i -g tokenhud@latest`")).toEqual([]);
    expect(invocations("`claude plugin marketplace add ZhuoQiuMcgill/tokenhud`")).toEqual([]);
  });

  test("finds keys named in prose, not other inline code", () => {
    const md =
      "Press `z` or `Ctrl-X`, then `↑/↓`; `*` marks totals; see `tokenhud doctor`.\n```sh\n`q`\n```";
    expect(proseKeys(md).map((k) => k.key)).toEqual(["z", "Ctrl-X", "↑/↓"]);
  });

  test("reads keys from the first column of the Keys section's tables only", () => {
    const md = [
      "## Keys",
      "",
      "| Key | Does |",
      "|---|---|",
      "| `a` | account scope (not `b`) |",
      "| `q` or `Ctrl-C` | quit |",
      "## Other",
      "| `z` | not a key |",
    ].join("\n");
    expect(documentedKeys(md)).toEqual([
      { line: 5, key: "a" },
      { line: 6, key: "q" },
      { line: 6, key: "Ctrl-C" },
    ]);
  });
});
