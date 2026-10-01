import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_WINDOW_MS,
  MCP_ALIVE_MS,
  mcpDir,
  readMcpActivity,
  removeMcpHeartbeat,
  writeMcpHeartbeat,
} from "../../src/mcp-heartbeat.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "tokenhud-mcp-test-"));
  dirs.push(d);
  return join(d, "mcp");
}

const NOW = 1_800_000_000_000;
const alive = (pids: number[]) => ({ host: "here", isAlive: (pid: number) => pids.includes(pid) });

test("the heartbeat dir is <config dir>/mcp", () => {
  expect(mcpDir({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/h")).toBe(join("/x/cfg", "tokenhud", "mcp"));
});

test("no directory, or nothing in it: no servers, no agents", () => {
  expect(readMcpActivity(dir(), NOW)).toEqual({ servers: 0, agents: 0, recent: [] });
});

test("servers: running pids on this host, fresh heartbeats from other hosts", () => {
  const d = dir();
  writeMcpHeartbeat(d, {
    pid: 101,
    host: "here",
    startedAt: NOW - 1000,
    updatedAt: NOW - 1000,
    calls: [],
  });
  writeMcpHeartbeat(d, {
    pid: 102,
    host: "here",
    startedAt: NOW - 1000,
    updatedAt: NOW,
    calls: [],
  });
  writeMcpHeartbeat(d, {
    pid: 7,
    host: "elsewhere",
    startedAt: 0,
    updatedAt: NOW - MCP_ALIVE_MS + 1,
    calls: [],
  });
  writeMcpHeartbeat(d, {
    pid: 8,
    host: "elsewhere",
    startedAt: 0,
    updatedAt: NOW - MCP_ALIVE_MS - 1,
    calls: [],
  });
  expect(readMcpActivity(d, NOW, alive([101])).servers).toBe(2);
});

test("agents: servers with a tool call in the last 10 minutes; recent calls newest first", () => {
  const d = dir();
  const call = (ago: number, tool: string) => ({ at: NOW - ago, tool, account: "personal" });
  writeMcpHeartbeat(d, {
    pid: 201,
    host: "here",
    startedAt: NOW - 3_600_000,
    updatedAt: NOW,
    calls: [call(AGENT_WINDOW_MS + 1, "usage"), call(12_000, "limits")],
  });
  writeMcpHeartbeat(d, {
    pid: 202,
    host: "here",
    startedAt: NOW,
    updatedAt: NOW,
    calls: [call(48_000, "should_wait")],
  });
  writeMcpHeartbeat(d, { pid: 203, host: "here", startedAt: NOW, updatedAt: NOW, calls: [] });
  const activity = readMcpActivity(d, NOW, alive([201, 202, 203]));
  expect(activity.agents).toBe(2);
  expect(activity.servers).toBe(3);
  expect(activity.recent.map((c) => c.tool)).toEqual(["limits", "should_wait"]);
});

test("writes keep only the agent window's calls (at most 20) and replace the file atomically", () => {
  const d = dir();
  const calls = Array.from({ length: 30 }, (_, i) => ({
    at: NOW - i * 1000,
    tool: "limits",
    account: null,
  }));
  calls.push({ at: NOW - AGENT_WINDOW_MS - 1, tool: "usage", account: null });
  writeMcpHeartbeat(d, { pid: 301, host: "here", startedAt: NOW, updatedAt: NOW, calls });
  const disk = JSON.parse(readFileSync(join(d, "301.json"), "utf8"));
  expect(disk.calls).toHaveLength(20);
  expect(disk.calls.every((c: { tool: string }) => c.tool === "limits")).toBe(true);
  expect(readdirSync(d)).toEqual(["301.json"]);
  removeMcpHeartbeat(d, 301);
  expect(readdirSync(d)).toEqual([]);
});

test("damaged and unrelated files are ignored", () => {
  const d = dir();
  writeMcpHeartbeat(d, {
    pid: 401,
    host: "here",
    startedAt: NOW,
    updatedAt: NOW,
    calls: [{ at: NOW, tool: "limits", account: null }],
  });
  writeFileSync(join(d, "402.json"), "{broken");
  writeFileSync(join(d, "403.json"), JSON.stringify({ pid: "x" }));
  writeFileSync(join(d, "notes.txt"), "hello");
  writeFileSync(
    join(d, "404.json"),
    JSON.stringify({
      pid: 404,
      host: "here",
      started_at: NOW,
      updated_at: NOW,
      calls: [{ at: "soon" }],
    }),
  );
  expect(readMcpActivity(d, NOW, alive([401, 404]))).toEqual({
    servers: 2,
    agents: 1,
    recent: [{ at: NOW, tool: "limits", account: null }],
  });
});
