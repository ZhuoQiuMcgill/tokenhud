import { availableParallelism } from "node:os";
import type { ParseRequest } from "./parse-worker.ts";
import { type ReadResult, type ReadTask, readTask } from "./read.ts";
import { workerUrl } from "./worker-url.ts";

/**
 * Reads transcripts on up to `min(8, cores)` parse Workers. Files are dealt out by size,
 * largest first, each to the least-loaded Worker; a Worker reads its share in one go and
 * posts the results back. The Workers live for one `read` call and are then stopped by a
 * message (never `terminate()`), so the cold scan's memory goes once it is done.
 */

/** Below this many bytes to read, Workers cost more to start than they save. */
export const POOL_MIN_BYTES = 8 * 1024 * 1024;
const MAX_WORKERS = 8;

export function defaultPoolSize(): number {
  return Math.max(1, Math.min(MAX_WORKERS, availableParallelism()));
}

const WORKER_URL = workerUrl("ingest/parse-worker.ts");

type Reply = { type: "results"; id: number; results: ReadResult[] };

function runOn(tasks: ReadTask[]): Promise<ReadResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL);
    const send = (message: ParseRequest) => worker.postMessage(message);
    worker.onmessage = (event: MessageEvent<Reply>) => {
      send({ type: "stop" });
      resolve(event.data.results);
    };
    worker.onerror = (event) => {
      send({ type: "stop" });
      reject(new Error(`parse worker failed: ${event.message}`));
    };
    send({ type: "read", id: 0, tasks });
  });
}

/**
 * Reads every task and returns the results in task order. `bytes[i]` estimates task i's
 * work. Small jobs, or a pool of one, run inline on the calling thread.
 */
export async function readAll(
  tasks: readonly ReadTask[],
  bytes: readonly number[],
  poolSize: number = defaultPoolSize(),
): Promise<ReadResult[]> {
  const total = bytes.reduce((a, b) => a + b, 0);
  const workers = Math.min(poolSize, tasks.length);
  if (workers <= 1 || total < POOL_MIN_BYTES) return tasks.map(readTask);
  const order = tasks.map((_, i) => i).sort((a, b) => (bytes[b] ?? 0) - (bytes[a] ?? 0));
  const bins: number[][] = Array.from({ length: workers }, () => []);
  const load = new Array<number>(workers).fill(0);
  for (const i of order) {
    let least = 0;
    for (let w = 1; w < workers; w++) if ((load[w] as number) < (load[least] as number)) least = w;
    (bins[least] as number[]).push(i);
    load[least] = (load[least] as number) + (bytes[i] ?? 0);
  }
  const out = new Array<ReadResult>(tasks.length);
  await Promise.all(
    bins.map(async (bin) => {
      const results = await runOn(bin.map((i) => tasks[i] as ReadTask));
      results.forEach((result, k) => {
        out[bin[k] as number] = result;
      });
    }),
  );
  return out;
}
