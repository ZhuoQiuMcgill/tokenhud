import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { POOL_MIN_BYTES, readAll } from "../../src/ingest/pool.ts";
import { type ReadResult, type ReadTask, readTask } from "../../src/ingest/read.ts";
import { workerUrl } from "../../src/ingest/worker-url.ts";
import { claudeLine, cleanup, tempDir } from "./helpers.ts";

afterEach(cleanup);

const withoutTime = (r: ReadResult) => ({ ...r, ms: 0 });

test("parse Workers return exactly what an inline read returns, in task order", async () => {
  const dir = tempDir();
  const tasks: ReadTask[] = [];
  for (let i = 0; i < 7; i++) {
    const path = join(dir, `s${i}.jsonl`);
    let text = "";
    for (let j = 0; j <= i * 3; j++) text += claudeLine(`${i}x${j % 4}`, `${i}x${j % 4}`, j, i);
    writeFileSync(path, text);
    tasks.push({ provider: "claude", path, start: 0, tail: null, state: null });
  }
  tasks.push({
    provider: "claude",
    path: join(dir, "missing.jsonl"),
    start: 0,
    tail: null,
    state: null,
  });
  const inline = tasks.map(readTask);
  // Claim each task is big, so the work goes to 3 Workers.
  const pooled = await readAll(
    tasks,
    tasks.map(() => POOL_MIN_BYTES),
    3,
  );
  expect(pooled.map(withoutTime)).toEqual(inline.map(withoutTime));
  expect(pooled.at(-1)?.error).toBe("ENOENT");
});

test("small jobs stay on the calling thread", async () => {
  const path = join(tempDir(), "s.jsonl");
  writeFileSync(path, claudeLine("1", "1", 1));
  const task: ReadTask = { provider: "claude", path, start: 0, tail: null, state: null };
  const [result] = await readAll([task, task], [10, 10], 8);
  expect(result?.entries).toHaveLength(1);
});

test("a provider without a reader yet (Codex, T5) is reported, not read", () => {
  const result = readTask({
    provider: "codex",
    path: "/nowhere",
    start: 0,
    tail: null,
    state: null,
  });
  expect(result.error).toBe("ENOTSUP");
});

describe("workerUrl", () => {
  test("from source: the file under src/", () => {
    expect(workerUrl("ingest/parse-worker.ts")).toBe(
      new URL("../../src/ingest/parse-worker.ts", import.meta.url).href,
    );
  });

  test("in a compiled binary: under the bundle root, whichever chunk asks", () => {
    for (const base of ["file:///$bunfs/root/tokenhud", "file:///$bunfs/root/ingest/worker.js"]) {
      expect(workerUrl("ingest/parse-worker.ts", base)).toBe(
        "file:///$bunfs/root/ingest/parse-worker.ts",
      );
    }
    expect(workerUrl("ingest/worker.ts", "file:///B:/~BUN/root/tokenhud.exe")).toBe(
      "file:///B:/~BUN/root/ingest/worker.ts",
    );
  });
});
