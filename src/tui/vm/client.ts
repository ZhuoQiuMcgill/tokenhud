import { workerUrl } from "../../ingest/worker-url.ts";
import type { VmMessage, VmRequest, VmStart } from "./types.ts";

/** The UI side of the view-model Worker (src/tui/vm/worker.ts). */
export interface VmWorker {
  send(request: Exclude<VmRequest, VmStart>): void;
  /** Asks the Worker to close the store and exit; resolves when it has. */
  stop(): Promise<void>;
}

const WORKER_URL = workerUrl("tui/vm/worker.ts");

export function startVmWorker(start: VmStart, onMessage: (message: VmMessage) => void): VmWorker {
  const worker = new Worker(WORKER_URL);
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  worker.addEventListener("close", () => resolveStopped());
  worker.onmessage = (event: MessageEvent<VmMessage>) => {
    onMessage(event.data);
    if (event.data.type === "stopped") resolveStopped();
  };
  worker.onerror = (event) => {
    onMessage({ type: "error", message: `view-model worker error: ${event.message}` });
  };
  worker.postMessage(start);
  return {
    send: (request) => worker.postMessage(request),
    stop() {
      worker.postMessage({ type: "stop" } satisfies VmRequest);
      return stopped;
    },
  };
}
