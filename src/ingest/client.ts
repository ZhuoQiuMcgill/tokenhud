import type { EngineOptions } from "./engine.ts";
import type { ChangedEvent, LogLevel, PassReport } from "./pass.ts";
import { workerUrl } from "./worker-url.ts";

/**
 * Starting and stopping the ingest Worker (src/ingest/worker.ts) from the UI thread or a
 * command. The Worker posts a `changed` message after every pass that inserted or raised
 * rows, naming the accounts and the timestamp span, so the reader refreshes just that.
 */

/** Engine options that can cross to the Worker: no callbacks, no file-system port. */
export type WorkerOptions = Omit<EngineOptions, "log" | "onChanged" | "onPass">;

export type IngestRequest = { type: "start"; options: WorkerOptions } | { type: "stop" };

export type IngestMessage =
  | ChangedEvent
  | { type: "log"; level: LogLevel; message: string }
  | { type: "pass"; report: PassReport }
  | { type: "imported"; rows: number }
  | { type: "ready"; roots: string[] }
  | { type: "stopped" };

export interface IngestWorker {
  /** Asks the Worker to finish its pass, close the store and exit; resolves when it has. */
  stop(): Promise<void>;
}

const WORKER_URL = workerUrl("ingest/worker.ts");

export function startIngestWorker(
  options: WorkerOptions,
  onMessage: (message: IngestMessage) => void,
): IngestWorker {
  const worker = new Worker(WORKER_URL);
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  worker.addEventListener("close", () => resolveStopped());
  worker.onmessage = (event: MessageEvent<IngestMessage>) => {
    onMessage(event.data);
    if (event.data.type === "stopped") resolveStopped();
  };
  worker.onerror = (event) => {
    onMessage({ type: "log", level: "error", message: `ingest worker error: ${event.message}` });
  };
  const send = (message: IngestRequest) => worker.postMessage(message);
  send({ type: "start", options });
  return {
    stop() {
      send({ type: "stop" });
      return stopped;
    },
  };
}
