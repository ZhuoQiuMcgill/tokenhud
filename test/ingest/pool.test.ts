import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { POOL_MIN_BYTES, readAll } from "../../src/ingest/pool.ts";
import { type ReadResult, type ReadTask, readTask } from "../../src/ingest/read.ts";
import { guard } from "../guard.ts";
import { claudeLine, cleanup, tempDir } from "./helpers.ts";

guard();

afterEach(cleanup);

const withoutTime = (r: ReadResult) => ({ ...r, ms: 0 });

/** Seven small transcripts and one missing file. */
function someTasks(): ReadTask[] {
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
  return tasks;
}

// Claim each task is big, so the work goes to the Workers.
const big = (tasks: ReadTask[]) => tasks.map(() => POOL_MIN_BYTES);

test("parse Workers return exactly what an inline read returns, in task order", async () => {
  const tasks = someTasks();
  const inline = tasks.map((task) => readTask(task));
  const pooled = await readAll(tasks, big(tasks), { poolSize: 3 });
  expect(pooled.map(withoutTime)).toEqual(inline.map(withoutTime));
  expect(pooled.at(-1)?.error).toBe("ENOENT");
});

describe("a parse Worker that does not reply", () => {
  test.each([
    ["exits mid-batch", "worker-exits.ts", "exited without replying"],
    ["throws", "worker-throws.ts", "failed"],
  ])("%s: its share is read here instead, and the next read works", async (_name, script, why) => {
    const tasks = someTasks();
    const inline = tasks.map((task) => readTask(task));
    const logs: string[] = [];
    const url = new URL(`./${script}`, import.meta.url).href;
    const pooled = await readAll(tasks, big(tasks), {
      poolSize: 3,
      workerUrl: url,
      log: (_level, message) => logs.push(message),
    });
    expect(pooled.map(withoutTime)).toEqual(inline.map(withoutTime));
    expect(logs).toHaveLength(3);
    for (const message of logs) {
      expect(message).toContain(why);
      expect(message).not.toContain("\n"); // one line, without Bun's code frame
    }
    const again = await readAll(tasks, big(tasks), { poolSize: 3 });
    expect(again.map(withoutTime)).toEqual(inline.map(withoutTime));
  });
});

test("small jobs stay on the calling thread", async () => {
  const path = join(tempDir(), "s.jsonl");
  writeFileSync(path, claudeLine("1", "1", 1));
  const task: ReadTask = { provider: "claude", path, start: 0, tail: null, state: null };
  const [result] = await readAll([task, task], [10, 10], { poolSize: 8 });
  expect(result?.entries).toHaveLength(1);
});

test("with minBytes 0 (selftest workers), even a few bytes go to the Workers", async () => {
  const path = join(tempDir(), "s.jsonl");
  writeFileSync(path, claudeLine("1", "1", 1));
  const task: ReadTask = { provider: "claude", path, start: 0, tail: null, state: null };
  const logs: string[] = [];
  // A Worker that throws: its warning shows the work went to the Workers.
  const results = await readAll([task, task], [10, 10], {
    poolSize: 2,
    minBytes: 0,
    workerUrl: new URL("./worker-throws.ts", import.meta.url).href,
    log: (_level, message) => logs.push(message),
  });
  expect(logs).toHaveLength(2);
  expect(results.map((r) => r.entries.length)).toEqual([1, 1]);
  expect(
    (await readAll([task, task], [10, 10], { poolSize: 2, minBytes: 0 }))[1]?.entries,
  ).toHaveLength(1);
});

test("every provider has a reader: a missing rollout is an error, not a crash", () => {
  const result = readTask({
    provider: "codex",
    path: join(tempDir(), "missing.jsonl"),
    start: 0,
    tail: null,
    state: null,
  });
  expect(result.error).toBe("ENOENT");
});
