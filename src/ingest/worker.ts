// The long-lived ingest Worker: owns discovery, the parse pool and every store write, and
// tells its owner what changed. It is stopped by a message and then exits by itself; it
// is never terminate()d. Nothing a transcript holds can stop it: bad lines are skipped,
// unreadable files and a busy store are logged and retried on the next pass.
import { StoreError } from "../store/errors.ts";
import type { IngestMessage, IngestRequest, WorkerOptions } from "./client.ts";
import { IngestEngine } from "./engine.ts";

declare const self: Worker;

const RETRY_OPEN_MS = 5000;

const post = (message: IngestMessage) => postMessage(message);
let engine: IngestEngine | null = null;
let stopping = false;
let retry: ReturnType<typeof setTimeout> | null = null;

function start(options: WorkerOptions): void {
  if (stopping) return;
  try {
    engine = IngestEngine.open({
      ...options,
      log: (level, message) => post({ type: "log", level, message }),
      onChanged: (event) => post(event),
      onPass: (report) => post({ type: "pass", report }),
    });
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    post({
      type: "log",
      level: "error",
      message: `cannot open the store: ${error.message}; retrying`,
    });
    retry = setTimeout(() => start(options), RETRY_OPEN_MS);
    return;
  }
  const live = engine;
  const imported = live.importIfFirstRun();
  if (imported?.status === "imported") post({ type: "imported", rows: imported.inserted });
  void live.startLive().then(() => post({ type: "ready", roots: live.roots.map((r) => r.label) }));
}

async function stop(): Promise<void> {
  stopping = true;
  if (retry !== null) clearTimeout(retry);
  await engine?.stop();
  post({ type: "stopped" });
  self.onmessage = null;
  process.exit(0);
}

self.onmessage = (event: MessageEvent<IngestRequest>) => {
  const message = event.data;
  if (message.type === "start") start(message.options);
  else void stop();
};
