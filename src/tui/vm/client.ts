import { workerUrl } from "../../ingest/worker-url.ts";
import { errorLine } from "../log.ts";
import type { VmFatal, VmMessage, VmRequest, VmStart } from "./types.ts";

/**
 * The UI side of the view-model Worker (src/tui/vm/worker.ts), kept alive by a supervisor.
 *
 * A Worker that dies (an uncaught throw or rejection, an exit, any of Bun's Worker
 * fragility) is reported once as `down` with a one-line reason, and started again after
 * 1 s, 2 s, 5 s, then every 30 s. The back-off starts over only once a Worker has stayed
 * up for a minute after its first view models, so one that posts them and dies soon after,
 * every time (a crash in a tick or `changed` path), still backs off (critique r1). Its
 * session is rebuilt from the store, so nothing is lost: the start message
 * carries the latest settings, config and mode, because the supervisor folds every
 * `settings`, `config` and `mode` request into it on the way through. Requests sent while
 * it is down are dropped for the same reason.
 */
export interface VmWorker {
  send(request: Exclude<VmRequest, VmStart>): void;
  /** Asks the Worker to close the store and exit; resolves when it has. */
  stop(): Promise<void>;
}

export const RESTART_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 30_000];
/** How long a Worker must stay up, once it came up, before the back-off resets. */
export const STABLE_MS = 60_000;

/**
 * The restart delays of a Worker that keeps dying, for both of the TUI's Workers: 1 s, 2 s,
 * 5 s, then every 30 s. They start over only once a Worker has stayed up `STABLE_MS` since
 * it came up (its first view models; ingest's `ready`): one that comes up and dies soon
 * after, every time, still backs off (critique r1, and m3 for the ingest Worker).
 */
export class RestartBackoff {
  readonly #steps: readonly number[];
  readonly #now: () => number;
  #failures = 0;
  #upSince: number | null = null;

  constructor(steps: readonly number[] = RESTART_BACKOFF_MS, now = () => performance.now()) {
    this.#steps = steps;
    this.#now = now;
  }

  /** The Worker came up. Only the first call of each life counts. */
  up(): void {
    this.#upSince ??= this.#now();
  }

  /** The Worker died: how long to wait before starting the next. */
  next(): number {
    if (this.#upSince !== null && this.#now() - this.#upSince >= STABLE_MS) this.#failures = 0;
    this.#upSince = null;
    const delay = this.#steps[Math.min(this.#failures, this.#steps.length - 1)] as number;
    this.#failures++;
    return delay;
  }
}

export interface SupervisorOptions {
  start: VmStart;
  /** Worker messages, plus the supervisor's own `down`. */
  onMessage: (message: VmMessage) => void;
  backoffMs?: readonly number[];
  /** Tests: another Worker entry (one that injects faults). */
  url?: string;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Monotonic ms, for how long a Worker stayed up. */
  now?: () => number;
}

const WORKER_URL = workerUrl("tui/vm/worker.ts");

export function superviseVmWorker(options: SupervisorOptions): VmWorker {
  const backoff = new RestartBackoff(options.backoffMs, options.now);
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let start: VmStart = options.start;
  let worker: Worker | null = null;
  let retry: unknown = null;
  let stopping = false;
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const down = (reason: string) => {
    worker = null;
    const delay = backoff.next();
    options.onMessage({ type: "down", reason, retryInMs: delay });
    retry = schedule(() => {
      retry = null;
      if (!stopping) spawn();
    }, delay);
  };

  const spawn = () => {
    const w = new Worker(options.url ?? WORKER_URL);
    worker = w;
    let reason: string | null = null;
    w.addEventListener("error", (event) => {
      reason ??= errorLine(String((event as ErrorEvent).message ?? ""));
    });
    w.addEventListener("close", (event) => {
      if (w !== worker) return;
      if (stopping) {
        resolveStopped();
        return;
      }
      down(reason ?? `exited with code ${(event as CloseEvent).code}`);
    });
    w.onmessage = (event: MessageEvent<VmMessage | VmFatal>) => {
      const message = event.data;
      if (message.type === "fatal") {
        reason = message.message;
        return;
      }
      if (message.type === "views") backoff.up();
      options.onMessage(message);
      if (message.type === "stopped") resolveStopped();
    };
    w.postMessage(start);
  };

  spawn();
  return {
    send(request) {
      if (request.type === "settings") {
        start = { ...start, settings: request.settings, scopeLabel: null };
      } else if (request.type === "config") {
        start = { ...start, config: request.config };
      } else if (request.type === "mode") {
        start = { ...start, mode: request.mode };
      }
      worker?.postMessage(request);
    },
    stop() {
      stopping = true;
      if (retry !== null) cancel(retry);
      if (worker === null) resolveStopped();
      else worker.postMessage({ type: "stop" } satisfies VmRequest);
      return stopped;
    },
  };
}
