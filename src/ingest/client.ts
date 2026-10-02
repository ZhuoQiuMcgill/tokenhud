import type { RefreshOutcome } from "../limits/service.ts";
import type { EngineOptions } from "./engine.ts";
import type { ChangedEvent, LogLevel, PassReport } from "./pass.ts";
import { workerUrl } from "./worker-url.ts";

/**
 * Starting and stopping the ingest Worker (src/ingest/worker.ts) from the UI thread or a
 * command. The Worker posts a `changed` message after every pass that inserted or raised
 * rows, naming the accounts and the timestamp span, so the reader refreshes just that.
 *
 * With `limits` set, the Worker also keeps subscription limits current (src/limits/):
 * after its first scan, then every 5 minutes per account, and on `refreshLimits`. It posts
 * `limits` naming the accounts whose entry in limits.json changed; read them with
 * `Limits.getLimits`.
 */

/** Where the Worker keeps limits. */
export interface LimitsWorkerOptions {
  /** limits.json. */
  limitsPath: string;
  /** cc-usage's provider-limits.json, imported when limits.json does not exist yet; null never. */
  ccUsageLimits: string | null;
}

/** Engine options that can cross to the Worker: no callbacks, no file-system port. */
export type WorkerOptions = Omit<EngineOptions, "log" | "onChanged" | "onPass"> & {
  /** Fetch subscription limits in the Worker; absent, limits are off. */
  limits?: LimitsWorkerOptions;
};

export type IngestRequest =
  | { type: "start"; options: WorkerOptions }
  | { type: "refreshLimits"; id: number; account: string | null; maxAgeS: number }
  | { type: "stop" };

export type IngestMessage =
  | ChangedEvent
  | { type: "log"; level: LogLevel; message: string }
  | { type: "pass"; report: PassReport }
  | { type: "imported"; rows: number }
  | { type: "ready"; roots: string[] }
  | { type: "limits"; accounts: string[] }
  | { type: "limitsRefreshed"; id: number; outcomes: RefreshOutcome[] }
  | { type: "stopped" };

export interface IngestWorker {
  /**
   * Refreshes the limits of `account` (an identity or label; every account when null)
   * whose data is older than `maxAgeS`, within the back-off and the Claude rate limit
   * (concurrent requests share one fetch). Resolves with what was done; with no outcomes
   * when limits are off or the Worker stops first.
   */
  refreshLimits(account: string | null, maxAgeS: number): Promise<RefreshOutcome[]>;
  /** Asks the Worker to finish its pass, close the store and exit; resolves when it has. */
  stop(): Promise<void>;
}

const WORKER_URL = workerUrl("ingest/worker.ts");

/**
 * `onExit` hears of the Worker ending without being asked to (an uncaught error, an exit),
 * with its exit code, so the caller can say so and start another.
 */
export function startIngestWorker(
  options: WorkerOptions,
  onMessage: (message: IngestMessage) => void,
  onExit?: (code: number) => void,
): IngestWorker {
  const worker = new Worker(WORKER_URL);
  let stopping = false;
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const pending = new Map<number, (outcomes: RefreshOutcome[]) => void>();
  let nextId = 1;
  const settlePending = () => {
    for (const resolve of pending.values()) resolve([]);
    pending.clear();
  };
  worker.addEventListener("close", (event) => {
    settlePending();
    resolveStopped();
    if (!stopping) onExit?.((event as CloseEvent).code);
  });
  worker.onmessage = (event: MessageEvent<IngestMessage>) => {
    const message = event.data;
    if (message.type === "limitsRefreshed") {
      pending.get(message.id)?.(message.outcomes);
      pending.delete(message.id);
    }
    onMessage(message);
    if (message.type === "stopped") {
      settlePending();
      resolveStopped();
    }
  };
  worker.onerror = (event) => {
    onMessage({ type: "log", level: "error", message: `ingest worker error: ${event.message}` });
  };
  const send = (message: IngestRequest) => worker.postMessage(message);
  send({ type: "start", options });
  return {
    refreshLimits(account, maxAgeS) {
      const id = nextId++;
      const reply = new Promise<RefreshOutcome[]>((resolve) => pending.set(id, resolve));
      send({ type: "refreshLimits", id, account, maxAgeS });
      return reply;
    },
    stop() {
      stopping = true;
      send({ type: "stop" });
      return stopped;
    },
  };
}
