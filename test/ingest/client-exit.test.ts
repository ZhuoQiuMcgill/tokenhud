// The ingest Worker's client reports a Worker that ends unasked (critique m8), so the TUI
// can say so and start another; a stop it asked for is not reported.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../../src/config.ts";
import { startIngestWorker, type WorkerOptions } from "../../src/ingest/client.ts";
import { cleanup, tempDir } from "./helpers.ts";

afterEach(cleanup);

function options(broken = false): WorkerOptions {
  const dir = tempDir();
  return {
    storePath: join(dir, "tokenhud.db"),
    cachePath: join(dir, "cache.db"),
    config: defaultConfig(),
    discover: broken
      ? (null as unknown as WorkerOptions["discover"])
      : { home: join(dir, "home"), env: {}, wslUsersDir: null },
    importLedger: null,
    poolSize: 1,
  };
}

test("a Worker that dies is reported, with the error in one log message", async () => {
  const exits: number[] = [];
  const errors: string[] = [];
  // No discovery options: the engine throws a TypeError while opening, uncaught.
  startIngestWorker(
    options(true),
    (m) => {
      if (m.type === "log" && m.level === "error") errors.push(m.message);
    },
    (code) => exits.push(code),
  );
  for (let i = 0; i < 400 && exits.length === 0; i++) await Bun.sleep(25);
  expect(exits).toHaveLength(1);
  expect(errors.join("\n")).toContain("TypeError: null is not an object");
}, 15_000);

test("a Worker stopped on request is not reported", async () => {
  const exits: number[] = [];
  let ready = false;
  const worker = startIngestWorker(
    options(),
    (m) => {
      if (m.type === "ready") ready = true;
    },
    (code) => exits.push(code),
  );
  for (let i = 0; i < 400 && !ready; i++) await Bun.sleep(25);
  expect(ready).toBe(true);
  await worker.stop();
  await Bun.sleep(100);
  expect(exits).toEqual([]);
}, 15_000);
