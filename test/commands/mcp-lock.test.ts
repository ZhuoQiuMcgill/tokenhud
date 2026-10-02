// `tokenhud mcp` with the real single-writer lock (src/lock.ts), as a fresh process on a
// fake HOME: while another process (a TUI) holds the lock it answers usage from the store as
// it is, with stale_s; with the lock free it ingests the stale store once first.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockPath, WriterLock } from "../../src/lock.ts";
import { storePath } from "../../src/paths.ts";
import { rootIdentity } from "../../src/sources/roots.ts";
import { openStore } from "../../src/store/store.ts";
import { guard } from "../guard.ts";
import { claudeLine } from "../ingest/helpers.ts";
import { CLI, cleanup, envOf, type Machine, machine } from "../mcp/helpers.ts";

guard();

afterEach(cleanup);

const HOUR = 3_600_000;

/** A store whose newest row is 3 h old, and a transcript holding one newer line. */
function staleMachine(): Machine {
  const m = machine();
  const store = openStore(storePath(m.env, m.home));
  store.upsert([
    {
      key: 123_456_789n,
      provider: "claude",
      identity: rootIdentity(m.claude, m.home),
      label: "personal",
      ts: Date.now() - 3 * HOUR,
      model: "claude-opus-4-8",
      inp: 10,
      outp: 0,
      cr: 0,
      cc: 0,
      e5: null,
      e1: null,
      tier: 0,
    },
  ]);
  store.close();
  const dir = join(m.claude, "projects", "-fake-project");
  mkdirSync(dir, { recursive: true });
  const ts = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    join(dir, "00000000-0000-4000-8000-000000000042.jsonl"),
    claudeLine("LOCK1", "LOCK1", 500, 0, { ts }),
  );
  return m;
}

/** Starts `tokenhud mcp`, calls `usage` once, and stops it. */
async function usageFromMcp(m: Machine): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([process.execPath, CLI, "mcp"], {
    env: envOf(m),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const replies = new Map<number, Record<string, unknown>>();
  const reader = (async () => {
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += new TextDecoder().decode(chunk);
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, at));
        if (typeof message.id === "number") replies.set(message.id, message);
        buffer = buffer.slice(at + 1);
      }
    }
  })();
  const send = (message: Record<string, unknown>) => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    proc.stdin.flush();
  };
  const reply = async (id: number) => {
    for (let i = 0; i < 800 && !replies.has(id); i++) await Bun.sleep(25);
    return replies.get(id) as { result: { structuredContent: Record<string, unknown> } };
  };
  try {
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    await reply(1);
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: "usage", arguments: { period: "all" } } });
    return (await reply(2)).result.structuredContent;
  } finally {
    proc.stdin.end();
    await Promise.race([proc.exited, Bun.sleep(10_000)]);
    proc.kill();
    await reader;
  }
}

const recordsOf = (doc: Record<string, unknown>) => (doc.totals as { records: number }).records;

test("while a TUI holds the lock, usage answers from the store as it is, with stale_s", async () => {
  const m = staleMachine();
  const tui = WriterLock.tryAcquire({ path: lockPath(m.env, m.home), owner: "tui" });
  expect(tui).not.toBeNull();
  try {
    const doc = await usageFromMcp(m);
    expect(recordsOf(doc)).toBe(1); // the new transcript line was not ingested
    expect(doc.stale_s as number).toBeGreaterThanOrEqual(3 * 3600 - 60);
    expect(doc.warnings).toContain(
      "the store was not refreshed: another tokenhud process holds the ingest lock and keeps the store current",
    );
  } finally {
    tui?.release();
  }
}, 30_000);

test("with no holder, usage ingests the stale store once, then answers, and frees the lock", async () => {
  const m = staleMachine();
  const doc = await usageFromMcp(m);
  expect(recordsOf(doc)).toBe(2);
  expect(doc.stale_s as number).toBeLessThan(120);
  expect(doc.warnings).toEqual([]);
  // The server released the lock: the next process can take it.
  const next = WriterLock.tryAcquire({ path: lockPath(m.env, m.home), owner: "tui" });
  expect(next).not.toBeNull();
  next?.release();
}, 30_000);
