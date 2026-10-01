// The TUI's lifecycle on the UI thread: the renderer, the ingest Worker, the single-writer
// lock, the refresh tick and shutdown. Every exit path (q, Ctrl-C, a signal, a crash)
// restores the terminal, stops the Workers by message and releases the lock.
import { appendFileSync } from "node:fs";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { type Config, saveConfig } from "../config.ts";
import { type IngestMessage, type IngestWorker, startIngestWorker } from "../ingest/client.ts";
import { HEARTBEAT_MS, WriterLock } from "../lock.ts";
import { App } from "./app.tsx";
import { Controller, initialState, type UiState } from "./controller.ts";
import { theme } from "./theme.ts";
import type { VmWorker } from "./vm/client.ts";
import type { VmMessage } from "./vm/types.ts";

export interface TuiPaths {
  readonly config: string;
  readonly store: string;
  readonly cache: string;
  readonly overrides: string;
  readonly lock: string;
  readonly mcp: string;
  readonly ccUsageLedger: string;
}

export interface Boot {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly paths: TuiPaths;
  readonly config: Config;
  /** Null when another process holds the lock (or it could not be written). */
  readonly lock: WriterLock | null;
  readonly lockError: string | null;
  readonly vm: VmWorker;
  /** View-model messages that arrived while OpenTUI loaded. */
  readonly early: readonly VmMessage[];
  attach(deliver: (message: VmMessage) => void): void;
  /** A file to append timing events to (TOKENHUD_TRACE), for the budget measurements. */
  readonly trace: string | null;
}

/** How long quitting waits for the ingest Worker to finish its pass. */
const INGEST_STOP_MS = 5000;
const VM_STOP_MS = 1000;
/** Start ingest anyway if the first frame with data hasn't come by then (e.g. a store error). */
const INGEST_FALLBACK_MS = 2000;

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

export async function runApp(boot: Boot): Promise<number> {
  const { paths, vm } = boot;
  const trace = (event: string, ms: number) => {
    if (boot.trace !== null) {
      appendFileSync(boot.trace, `${JSON.stringify({ event, ms, at: performance.now() })}\n`);
    }
  };
  let lock = boot.lock;
  let ingest: IngestWorker | null = null;
  let generation = 0;
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let closing = false;

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    // Signals are ours: OpenTUI's handler would restore the terminal but leave the
    // Workers running and the lock held.
    exitSignals: [],
    useMouse: false,
    backgroundColor: theme(boot.config.theme).hex.bg,
  });

  const controller = new Controller(initialState(boot.config, lock === null ? "reader" : "owner"), {
    saveConfig: (config) => saveConfig(config, paths.config),
    vmSettings: (settings) => vm.send({ type: "settings", settings }),
    vmConfig: (config) => vm.send({ type: "config", config }),
    vmRoots: () => vm.send({ type: "roots" }),
    accountsEdited: () => {
      if (ingest === null) return;
      void stopIngest().then(startIngest);
    },
    quit: () => void shutdown(0),
  });
  if (boot.lockError !== null) controller.setReadOnlyReason(`read-only: ${boot.lockError}`);

  function onIngest(own: number, message: IngestMessage): void {
    // A replaced Worker's changes still count; its status no longer does.
    if (message.type === "changed") {
      vm.send({
        type: "changed",
        fromTs: message.fromTs,
        toTs: message.toTs,
        accounts: message.accounts,
      });
      return;
    }
    if (message.type === "imported") {
      vm.send({ type: "invalidate" });
      return;
    }
    if (own !== generation) return;
    if (message.type === "ready") controller.setIngest("live");
    else if (message.type === "pass" && message.report.storeError !== null)
      controller.setIngest("error");
    else if (message.type === "pass" && controller.getState().ingest === "error")
      controller.setIngest("live");
    else if (message.type === "log" && message.level === "error") controller.setIngest("error");
  }

  function startIngest(): void {
    if (closing || ingest !== null || lock === null || !lock.held) return;
    const own = ++generation;
    controller.setIngest("starting");
    ingest = startIngestWorker(
      {
        storePath: paths.store,
        cachePath: paths.cache,
        config: controller.getState().config,
        discover: { home: boot.home, env: { ...boot.env } },
        importLedger: paths.ccUsageLedger,
      },
      (message) => onIngest(own, message),
    );
  }

  async function stopIngest(): Promise<void> {
    const worker = ingest;
    ingest = null;
    if (worker !== null) await within(worker.stop(), INGEST_STOP_MS);
  }

  function promote(taken: WriterLock): void {
    lock = taken;
    controller.setMode("owner");
    // The previous owner's last writes were never reported to us: start from the store.
    vm.send({ type: "mode", mode: "owner" });
    startIngest();
  }

  function demote(): void {
    void stopIngest();
    controller.setMode("reader");
    vm.send({ type: "mode", mode: "reader" });
  }

  // ── refresh tick and lock heartbeat ────────────────────────────────────────────

  function tick(): void {
    const t0 = performance.now();
    if (lock === null || !lock.held) {
      try {
        const taken = WriterLock.tryAcquire({ path: paths.lock, owner: "tui" });
        if (taken !== null) promote(taken);
      } catch {
        // still not writable; stay read-only
      }
    }
    vm.send({ type: "tick" });
    trace("tick", performance.now() - t0);
  }

  let refresh = boot.config.refresh_interval;
  let tickTimer = setInterval(tick, refresh * 1000);
  const beatTimer = setInterval(() => {
    if (lock?.held && !lock.heartbeat()) demote();
  }, HEARTBEAT_MS);
  let theme_ = boot.config.theme;
  const unsubscribe = controller.subscribe(() => {
    const { config } = controller.getState();
    if (config.refresh_interval !== refresh) {
      refresh = config.refresh_interval;
      clearInterval(tickTimer);
      tickTimer = setInterval(tick, refresh * 1000);
    }
    if (config.theme !== theme_) {
      theme_ = config.theme;
      renderer.setBackgroundColor(theme(theme_).hex.bg);
    }
  });

  // ── frames: the first one with data, then view switches ────────────────────────

  let dataShown = false;
  let pendingData = false;
  let pendingSwitch: number | null = null;
  const fallback = setTimeout(startIngest, INGEST_FALLBACK_MS);
  const onCommit = (state: UiState) => {
    if (!dataShown && state.views.overview !== undefined) pendingData = true;
    if (controller.switchStartedAt !== null) {
      pendingSwitch = controller.switchStartedAt;
      controller.switchStartedAt = null;
    }
  };
  renderer.on("frame", () => {
    const now = performance.now();
    if (pendingData) {
      pendingData = false;
      dataShown = true;
      trace("first-frame", now);
      clearTimeout(fallback);
      // Ingest starts only now, so the cold scan never competes with the first frame.
      startIngest();
    }
    if (pendingSwitch !== null) {
      trace("switch", now - pendingSwitch);
      pendingSwitch = null;
    }
  });

  // ── shutdown ───────────────────────────────────────────────────────────────────

  async function shutdown(code: number, error?: unknown): Promise<void> {
    if (closing) return;
    closing = true;
    clearInterval(tickTimer);
    clearInterval(beatTimer);
    clearTimeout(fallback);
    unsubscribe();
    try {
      renderer.destroy();
    } catch {
      // the terminal is restored as far as OpenTUI could
    }
    if (error !== undefined) {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`tokenhud: crashed: ${text}\n`);
    }
    await stopIngest();
    await within(vm.stop(), VM_STOP_MS);
    lock?.release();
    resolveExit(code);
  }

  const fatal = (error: unknown) => void shutdown(1, error);
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  renderer.on("render:error", (event: { error: Error }) => fatal(event.error));
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    process.on(signal, () => void shutdown(code));
  }

  boot.attach((message) => controller.vmMessage(message));
  for (const message of boot.early) controller.vmMessage(message);
  createRoot(renderer).render(<App controller={controller} onFatal={fatal} onCommit={onCommit} />);
  return exited;
}
