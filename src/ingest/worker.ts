// The long-lived ingest Worker: owns discovery, the parse pool and every store write, and
// tells its owner what changed. It is stopped by a message and then exits by itself; it
// is never terminate()d. Nothing a transcript holds can stop it: bad lines are skipped,
// unreadable files and a busy store are logged and retried on the next pass.
//
// With limits on, it also runs the limits schedule (src/limits/service.ts): the first
// round after the first scan, so the UI thread never waits on the network.
import { recordCaptureEvents } from "../limits/events.ts";
import { LimitsService } from "../limits/service.ts";
import { codexSnapshotsFrom } from "../limits/snapshots.ts";
import { StoreError } from "../store/errors.ts";
import type { IngestMessage, IngestRequest, LimitsWorkerOptions, WorkerOptions } from "./client.ts";
import { IngestEngine } from "./engine.ts";

declare const self: Worker;

const RETRY_OPEN_MS = 5000;

const post = (message: IngestMessage) => postMessage(message);
let engine: IngestEngine | null = null;
let limits: LimitsService | null = null;
let stopping = false;
let retry: ReturnType<typeof setTimeout> | null = null;

// An error nothing here expected ends the Worker, said in one line first, rather than
// leaving it alive and doing nothing: its owner hears the exit and starts another.
const fatal = (error: unknown) => {
  const message = error instanceof Error ? error.message : `uncaught ${String(error)}`;
  post({ type: "log", level: "error", message: (message.split("\n")[0] as string) || "error" });
  process.exit(1);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

function limitsService(live: IngestEngine, options: LimitsWorkerOptions, cachePath: string) {
  return new LimitsService({
    limitsPath: options.limitsPath,
    ccUsageLimits: options.ccUsageLimits,
    roots: () => live.discover(),
    knownAccounts: () => [...live.store.accounts().values()],
    snapshots: codexSnapshotsFrom(cachePath),
    recordEvents: (root, capture) => recordCaptureEvents(live.store, root, capture),
    log: (level, message) => post({ type: "log", level, message }),
    onChanged: (accounts) => post({ type: "limits", accounts }),
  });
}

function start(workerOptions: WorkerOptions): void {
  if (stopping) return;
  const { limits: limitsOptions, ...options } = workerOptions;
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
    retry = setTimeout(() => start(workerOptions), RETRY_OPEN_MS);
    return;
  }
  const live = engine;
  const imported = live.importIfFirstRun();
  if (imported?.status === "imported") post({ type: "imported", rows: imported.inserted });
  if (limitsOptions) limits = limitsService(live, limitsOptions, options.cachePath);
  void live.startLive().then(() => {
    post({ type: "ready", roots: live.labels(live.roots) });
    if (!stopping) limits?.start();
  });
}

async function refreshLimits(id: number, account: string | null, maxAgeS: number): Promise<void> {
  const outcomes = limits === null || stopping ? [] : await limits.refresh(account, maxAgeS);
  post({ type: "limitsRefreshed", id, outcomes });
}

async function stop(): Promise<void> {
  stopping = true;
  if (retry !== null) clearTimeout(retry);
  await limits?.stop();
  await engine?.stop();
  post({ type: "stopped" });
  self.onmessage = null;
  process.exit(0);
}

self.onmessage = (event: MessageEvent<IngestRequest>) => {
  const message = event.data;
  if (message.type === "start") start(message.options);
  else if (message.type === "refreshLimits") {
    void refreshLimits(message.id, message.account, message.maxAgeS);
  } else void stop();
};
