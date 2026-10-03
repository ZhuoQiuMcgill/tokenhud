// The Claude Code process above a hook or an MCP server (T29 critique m2): pid and start
// time, through the shell a hook command runs in; nothing where it can't be verified.
import { describe, expect, test } from "bun:test";
import { claudeProcess, type ProcInfo, procReader } from "../../src/alerts/proc.ts";
import { guard } from "../guard.ts";

guard();

/** A made-up process table: Claude Code 100, its hook's sh 200 (and a bash 250 under it). */
const TABLE: Record<number, ProcInfo> = {
  100: { ppid: 50, start: "9000", name: "claude" },
  200: { ppid: 100, start: "9100", name: "sh" },
  250: { ppid: 200, start: "9150", name: "bash" },
  300: { ppid: 1, start: "9200", name: "sh" },
};
const read = (pid: number) => TABLE[pid] ?? null;

describe("claudeProcess", () => {
  test("a hook's parent is the shell its command runs in: the process above it is Claude Code", () => {
    expect(claudeProcess(200, read)).toEqual({ pid: 100, start: "9000" });
    expect(claudeProcess(250, read)).toEqual({ pid: 100, start: "9000" });
  });

  test("an MCP server's parent is Claude Code itself", () => {
    expect(claudeProcess(100, read)).toEqual({ pid: 100, start: "9000" });
  });

  test("nothing when it can't be told: no reader (Windows), pid 1, a vanished process, a shell under init", () => {
    expect(claudeProcess(100, null)).toBeNull();
    expect(claudeProcess(1, read)).toBeNull();
    expect(claudeProcess(0, read)).toBeNull();
    expect(claudeProcess(999, read)).toBeNull();
    expect(claudeProcess(300, read)).toBeNull();
  });

  test("only Linux and macOS are read", () => {
    expect(procReader("win32")).toBeNull();
    expect(procReader("freebsd")).toBeNull();
    expect(procReader("linux")).not.toBeNull();
    expect(procReader("darwin")).not.toBeNull();
  });

  test.if(process.platform === "linux" || process.platform === "darwin")(
    "this OS's reader sees this process: its parent, a start time, a name",
    () => {
      const reader = procReader() as NonNullable<ReturnType<typeof procReader>>;
      const me = reader(process.pid);
      expect(me?.ppid).toBe(process.ppid);
      expect(me?.start).not.toBe("");
      expect(me?.name).not.toBe("");
      // The same process reads the same start time again.
      expect(reader(process.pid)?.start).toBe(me?.start as string);
    },
  );
});
