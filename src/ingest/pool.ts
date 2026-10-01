import { availableParallelism } from "node:os";
import { clearParentStreams } from "../sources/codex.ts";
import type { ParseRequest } from "./parse-worker.ts";
import type { Log } from "./pass.ts";
import { type ReadContext, type ReadResult, type ReadTask, readTask } from "./read.ts";
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

/**
 * Runs `tasks` on a fresh Worker. Settles exactly once: with the results, or with an error
 * when the Worker reports one or closes without replying (which would otherwise leave the
 * pass, and every pass queued behind it, waiting for ever).
 */
function runOn(url: string, tasks: ReadTask[], context: ReadContext): Promise<ReadResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url);
    let settled = false;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      done();
    };
    const send = (message: ParseRequest) => worker.postMessage(message);
    worker.onmessage = (event: MessageEvent<Reply>) => {
      send({ type: "stop" });
      settle(() => resolve(event.data.results));
    };
    worker.onerror = (event) => {
      send({ type: "stop" });
      // Bun's message carries a multi-line code frame; its first line says what failed.
      const reason = (event.message ?? "").split("\n", 1)[0]?.trim() || "an error";
      settle(() => reject(new Error(`a parse Worker failed (${reason})`)));
    };
    worker.addEventListener("close", () =>
      settle(() => reject(new Error("a parse Worker exited without replying"))),
    );
    send({ type: "read", id: 0, tasks, context });
  });
}

export interface PoolOptions {
  /** Up to this many Workers; 1 reads inline. */
  poolSize?: number;
  log?: Log;
  /** The Worker script (tests substitute one that fails). */
  workerUrl?: string;
  context?: ReadContext;
}

/**
 * Reads every task and returns the results in task order. `bytes[i]` estimates task i's
 * work. Small jobs, or a pool of one, run inline on the calling thread. A Worker that
 * fails or exits without replying has its share read inline instead, so the pass still
 * completes.
 */
export async function readAll(
  tasks: readonly ReadTask[],
  bytes: readonly number[],
  options: PoolOptions = {},
): Promise<ReadResult[]> {
  const context = options.context ?? {};
  const inline = (task: ReadTask) => readTask(task, context);
  // A parent rollout read for an earlier pass may have grown or been rewritten since.
  clearParentStreams();
  const total = bytes.reduce((a, b) => a + b, 0);
  const workers = Math.min(options.poolSize ?? defaultPoolSize(), tasks.length);
  if (workers <= 1 || total < POOL_MIN_BYTES) return tasks.map(inline);
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
      const batch = bin.map((i) => tasks[i] as ReadTask);
      let results: ReadResult[];
      try {
        results = await runOn(options.workerUrl ?? WORKER_URL, batch, context);
      } catch (error) {
        options.log?.(
          "warn",
          `${(error as Error).message}; reading its ${batch.length} transcript(s) here instead`,
        );
        results = batch.map(inline);
      }
      results.forEach((result, k) => {
        out[bin[k] as number] = result;
      });
    }),
  );
  return out;
}
