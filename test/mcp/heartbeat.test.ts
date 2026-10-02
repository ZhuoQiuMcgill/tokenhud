import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { AGENT_WINDOW_MS, Heartbeat, mcpDir } from "../../src/mcp/heartbeat.ts";
import { cleanup, MIN, NOW, tempDir } from "./helpers.ts";

afterEach(cleanup);

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("the MCP heartbeat file", () => {
  test("lives at <config dir>/mcp/<pid>.json", () => {
    expect(mcpDir({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe(join("/x", "tokenhud", "mcp"));
  });

  test("written on start with T10's fields, removed on stop", () => {
    const dir = join(tempDir(), "mcp");
    const beat = new Heartbeat(dir, { pid: 4242, now: () => NOW });
    beat.start();
    expect(readdirSync(dir)).toEqual(["4242.json"]);
    expect(read(beat.path)).toEqual({
      pid: 4242,
      host: hostname(),
      started_at: NOW,
      updated_at: NOW,
      calls: [],
    });
    beat.stop();
    expect(existsSync(beat.path)).toBe(false);
  });

  test("keeps only the last 10 minutes of calls, at most 20", () => {
    const dir = join(tempDir(), "mcp");
    let now = NOW;
    const beat = new Heartbeat(dir, { pid: 1, now: () => now });
    beat.record("limits", "personal");
    now += AGENT_WINDOW_MS + 1;
    for (let i = 0; i < 25; i++) beat.record("usage", null);
    const calls = read(beat.path).calls as Array<{ at: number; tool: string }>;
    expect(calls).toHaveLength(20);
    expect(calls.every((c) => c.tool === "usage" && c.at === now)).toBe(true);
    beat.stop();
  });

  test("a later rewrite drops calls that aged out", () => {
    const dir = join(tempDir(), "mcp");
    let now = NOW;
    const beat = new Heartbeat(dir, { pid: 2, now: () => now });
    beat.record("should_wait", "work");
    now += 11 * MIN;
    beat.write();
    expect(read(beat.path)).toMatchObject({ updated_at: now, calls: [] });
    beat.stop();
  });

  test.skipIf(process.platform === "win32")(
    "an unwritable dir is logged once, never thrown",
    () => {
      const base = tempDir();
      chmodSync(base, 0o500);
      const logs: string[] = [];
      try {
        const beat = new Heartbeat(join(base, "mcp"), { pid: 3, log: (m) => logs.push(m) });
        beat.start();
        beat.record("limits", null);
        beat.stop();
      } finally {
        chmodSync(base, 0o700);
      }
      expect(logs).toEqual(["cannot write the heartbeat file (EACCES)"]);
    },
  );
});
