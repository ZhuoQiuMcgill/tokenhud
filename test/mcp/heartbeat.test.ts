import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, parse } from "node:path";
import {
  AGENT_WINDOW_MS,
  Heartbeat,
  mcpDir,
  projectOf,
  readMcpActivity,
} from "../../src/mcp/heartbeat.ts";
import { guard } from "../guard.ts";
import { cleanup, MIN, NOW, tempDir } from "./helpers.ts";

guard();

afterEach(cleanup);

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** A made-up working directory for a server: its project is `name`. */
const cwd = (name: string) => join(tempDir(), "code", name);

describe("the MCP heartbeat file", () => {
  test("lives at <config dir>/mcp/<pid>.json", () => {
    expect(mcpDir({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe(join("/x", "tokenhud", "mcp"));
  });

  test("written on start with T10's fields, removed on stop", () => {
    const dir = join(tempDir(), "mcp");
    const beat = new Heartbeat(dir, { pid: 4242, cwd: cwd("demo-app"), now: () => NOW });
    beat.start();
    expect(readdirSync(dir)).toEqual(["4242.json"]);
    expect(read(beat.path)).toEqual({
      pid: 4242,
      host: hostname(),
      project: "demo-app",
      started_at: NOW,
      updated_at: NOW,
      calls: [],
    });
    beat.stop();
    expect(existsSync(beat.path)).toBe(false);
  });

  test("names the project by its directory's name alone, never its path", () => {
    const dir = join(tempDir(), "mcp");
    const where = cwd("demo-app");
    const beat = new Heartbeat(dir, { pid: 7, cwd: where, now: () => NOW });
    beat.record("limits", "personal");
    const text = readFileSync(beat.path, "utf8");
    expect(JSON.parse(text).project).toBe("demo-app");
    expect(text).not.toContain(parse(where).dir);
    expect(text).not.toContain(JSON.stringify(parse(where).dir).slice(1, -1));
    beat.stop();
  });

  test("no project for the home directory, whose name is the user's, or a filesystem root", () => {
    const home = join(tempDir(), "someone");
    expect(projectOf(join(home, "code", "demo-app"), home)).toBe("demo-app");
    expect(projectOf(join(home, "demo-app", "/"), home)).toBe("demo-app");
    expect(projectOf(home, home)).toBeNull();
    expect(projectOf(join(home, "/"), home)).toBeNull();
    expect(projectOf(parse(home).root, home)).toBeNull();
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

// The TUI's side: its footer ("MCP ● 2 agents", or a dim "MCP ○") reads these files.
describe("read by the TUI (readMcpActivity)", () => {
  const here = { host: hostname(), isAlive: (pid: number) => pid === 4242 || pid === 4343 };

  test("no directory, or nothing in it: no servers and no agents", () => {
    expect(readMcpActivity(join(tempDir(), "mcp"), NOW, here)).toEqual({
      servers: 0,
      agents: 0,
      recent: [],
      latest: [],
    });
  });

  test("a running server is counted; with a call in the last 10 minutes it is an agent", () => {
    const dir = join(tempDir(), "mcp");
    let now = NOW;
    const a = new Heartbeat(dir, { pid: 4242, cwd: cwd("demo-app"), now: () => now });
    const b = new Heartbeat(dir, { pid: 4343, cwd: cwd("demo-api"), now: () => now });
    a.start();
    b.start();
    a.record("limits", "personal");
    now += 2 * MIN;
    b.record("should_wait", "work");
    expect(readMcpActivity(dir, now, here)).toEqual({
      servers: 2,
      agents: 2,
      recent: [
        { at: now, tool: "should_wait", account: "work" },
        { at: NOW, tool: "limits", account: "personal" },
      ],
      latest: [
        { at: now, tool: "should_wait", account: "work", project: "demo-api" },
        { at: NOW, tool: "limits", account: "personal", project: "demo-app" },
      ],
    });
    // Ten minutes later the first call has aged out; both servers still beat.
    now += 9 * MIN;
    a.write();
    b.write();
    expect(readMcpActivity(dir, now, here)).toMatchObject({ servers: 2, agents: 1 });
    a.stop();
    b.stop();
  });

  test("each agent session's latest call and project, newest first, for the Overview's agents card", () => {
    const dir = join(tempDir(), "mcp");
    let now = NOW;
    const a = new Heartbeat(dir, { pid: 4242, cwd: cwd("demo-app"), now: () => now });
    const b = new Heartbeat(dir, { pid: 4343, cwd: cwd("demo-api"), now: () => now });
    a.record("limits", "personal");
    now += MIN;
    b.record("should_wait", "work");
    now += MIN;
    a.record("usage", "personal");
    a.record("limits", "personal");
    const activity = readMcpActivity(dir, now, here);
    expect(activity.recent).toHaveLength(4);
    expect(activity.latest).toEqual([
      { at: now, tool: "limits", account: "personal", project: "demo-app" },
      { at: now - MIN, tool: "should_wait", account: "work", project: "demo-api" },
    ]);
    a.stop();
    b.stop();
  });

  test("no heartbeat in the last 10 minutes, or a crashed server on this host: not running", () => {
    const dir = join(tempDir(), "mcp");
    const old = new Heartbeat(dir, { pid: 4242, now: () => NOW - AGENT_WINDOW_MS - 1 });
    old.write();
    const crashed = new Heartbeat(dir, { pid: 999_999, now: () => NOW });
    crashed.write();
    expect(readMcpActivity(dir, NOW, here)).toEqual({
      servers: 0,
      agents: 0,
      recent: [],
      latest: [],
    });
  });

  test("a heartbeat's project is a name: none from an older server, never a path or control characters", () => {
    const dir = join(tempDir(), "mcp");
    const beat = (pid: number, project?: unknown) =>
      writeFileSync(
        join(dir, `${pid}.json`),
        JSON.stringify({
          pid,
          host: "elsewhere",
          ...(project === undefined ? {} : { project }),
          started_at: NOW,
          updated_at: NOW,
          calls: [{ at: NOW - pid, tool: "limits", account: null }],
        }),
      );
    const one = new Heartbeat(dir, { pid: 1, cwd: cwd("demo-app"), now: () => NOW });
    one.record("limits", null);
    beat(2);
    beat(3, "/somewhere/else/demo\u001b-api");
    beat(4, "");
    beat(5, 42);
    expect(readMcpActivity(dir, NOW, here).latest.map((c) => c.project)).toEqual([
      "demo-app",
      null,
      "demo-api",
      null,
      null,
    ]);
  });

  test("damaged and unrelated files are ignored", () => {
    const dir = join(tempDir(), "mcp");
    const beat = new Heartbeat(dir, { pid: 4242, cwd: cwd("demo-app"), now: () => NOW });
    beat.record("limits", null);
    writeFileSync(join(dir, "1.json"), "{broken");
    writeFileSync(join(dir, "2.json"), JSON.stringify({ pid: "x" }));
    writeFileSync(join(dir, "notes.txt"), "hello");
    expect(readMcpActivity(dir, NOW, here)).toEqual({
      servers: 1,
      agents: 1,
      recent: [{ at: NOW, tool: "limits", account: null }],
      latest: [{ at: NOW, tool: "limits", account: null, project: "demo-app" }],
    });
    beat.stop();
  });
});
