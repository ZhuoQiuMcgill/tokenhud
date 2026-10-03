// The TUI's lifecycle on the UI thread: the renderer, the ingest Worker, the single-writer
// lock, the refresh tick and shutdown. Every exit path (q, Ctrl-C, a signal, a crash)
// restores the terminal and asks the Workers to stop by message, waiting for them at most
// QUIT_STOP_MS; the lock is released then, or by the kernel at exit while ingest still runs.
import { appendFileSync } from "node:fs";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { type Config, saveConfig } from "../config.ts";
import { type IngestMessage, type IngestWorker, startIngestWorker } from "../ingest/client.ts";
import { HEARTBEAT_MS, lockFailure, WriterLock } from "../lock.ts";
import { availableUpdate } from "../update.ts";
import { VERSION } from "../version.ts";
import { App } from "./app.tsx";
import { Controller, initialState, type UiState } from "./controller.ts";
import { errorLine, fileLog } from "./log.ts";
import { QuitSteps } from "./quit.ts";
import { theme } from "./theme.ts";
import { RestartBackoff, type VmWorker } from "./vm/client.ts";
import type { VmMessage } from "./vm/types.ts";

export interface TuiPaths {
  readonly config: string;
  readonly store: string;
  readonly cache: string;
  /** limits.json, which the Overview's limit cards read. */
  readonly limits: string;
  readonly overrides: string;
  readonly lock: string;
  readonly mcp: string;
  readonly ccUsageLedger: string;
  /** cc-usage's provider-limits.json, imported once into limits.json (read-only). */
  readonly ccUsageLimits: string;
  /** The log file (`<config dir>/logs/tokenhud.log`). */
  readonly log: string;
  /** When GitHub was last asked about a newer release (`<config dir>/update-check.json`). */
  readonly updateCheck: string;
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

/** How long restarting ingest (accounts edited) waits for the old Worker to finish its pass. */
const INGEST_STOP_MS = 5000;
/**
 * How long quitting waits for the Workers to stop, both at once: q quits within 1 s (T22).
 * A pass still running then (a large history's cold scan takes seconds) is cut short by the
 * exit, which is safe: the store commits in one transaction before the cursors move, so the
 * next start reads the same bytes again.
 */
const QUIT_STOP_MS = 500;
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
  const log = fileLog(paths.log, boot.home);
  let lock = boot.lock;
  let ingest: IngestWorker | null = null;
  let generation = 0;
  // Reset only after a minute up since `ready`, never on `ready` itself (critique m3).
  const ingestBackoff = new RestartBackoff();
  let ingestRetry: ReturnType<typeof setTimeout> | null = null;
  let ingestError: string | null = null;
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
      void stopIngest(INGEST_STOP_MS).then(startIngest);
    },
    quit: () => void shutdown(0),
  });
  // Why the lock can't be taken (an unwritable config dir, a lock file or journal that can't
  // be repaired): shown while read-only, logged once per reason, retried on every tick.
  let lockProblem: string | null = null;
  const lockFailed = (problem: string | null) => {
    if (problem === lockProblem) return;
    lockProblem = problem;
    if (problem !== null) log.write("warn", `${problem}; read-only, retrying`);
    controller.setReadOnlyReason(problem === null ? null : `read-only: ${problem}; retrying`);
  };
  if (boot.lockError !== null) lockFailed(boot.lockError);

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
    // The Worker rewrote limits.json: the Overview's cards, at once.
    if (message.type === "limits") {
      vm.send({ type: "limits" });
      return;
    }
    if (message.type === "log" && message.level !== "info") {
      log.write(message.level, `ingest: ${message.message}`);
    }
    if (own !== generation) return;
    if (message.type === "log" && message.level === "error")
      ingestError = errorLine(message.message);
    if (message.type === "ready") {
      ingestBackoff.up();
      controller.setIngestDown(null);
      controller.setIngest("live");
    }
    if (message.type === "pass" && message.report.storeError !== null)
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
        // T8's schedule: a fetch after the first scan, then every 5 minutes per account,
        // with its back-off, history-only accounts left alone and the cross-process lease.
        limits: {
          limitsPath: paths.limits,
          ccUsageLimits: paths.ccUsageLimits,
          configPath: paths.config,
        },
      },
      (message) => onIngest(own, message),
      (code) => {
        // It died: say why on one line, and start another after 1 s, 2 s, 5 s, then 30 s.
        if (closing || own !== generation) return;
        ingest = null;
        const delay = ingestBackoff.next();
        const reason = ingestError ?? `exited with code ${code}`;
        ingestError = null;
        log.write("error", `ingest worker stopped: ${reason}; restarting in ${delay} ms`);
        controller.setIngest("error");
        controller.setIngestDown(
          `ingest stopped (${reason}); restarting in ${Math.round(delay / 1000)} s`,
        );
        ingestRetry = setTimeout(() => {
          ingestRetry = null;
          startIngest();
        }, delay);
      },
    );
  }

  /** Whether the ingest Worker (if any) stopped within `ms`. */
  async function stopIngest(ms: number): Promise<boolean> {
    const worker = ingest;
    ingest = null;
    if (worker === null) return true;
    const stopped = await within(
      worker.stop().then(() => true),
      ms,
    );
    return stopped === true;
  }

  // At most once a day, and never before the first frame: a newer release for the footer.
  // It only looks; `tokenhud update` installs.
  function checkForUpdate(): void {
    if (!controller.getState().config.update_check) return;
    void availableUpdate({
      statePath: paths.updateCheck,
      env: boot.env,
      version: VERSION,
      now: Date.now(),
    }).then((version) => {
      if (!closing) controller.setUpdate(version);
    });
  }

  function promote(taken: WriterLock): void {
    lock = taken;
    controller.setMode("owner");
    // The previous owner's last writes were never reported to us: start from the store.
    vm.send({ type: "mode", mode: "owner" });
    startIngest();
  }

  // ── refresh tick and lock heartbeat ────────────────────────────────────────────

  function tick(): void {
    const t0 = performance.now();
    if (lock === null || !lock.held) {
      try {
        const taken = WriterLock.tryAcquire({
          path: paths.lock,
          owner: "tui",
          log: (message) => log.write("warn", message),
        });
        // Taken, or held by another process: either way the problem is gone.
        lockFailed(null);
        if (taken !== null) promote(taken);
      } catch (error) {
        lockFailed(lockFailure(error));
      }
    }
    vm.send({ type: "tick" });
    trace("tick", performance.now() - t0);
  }

  let refresh = boot.config.refresh_interval;
  let tickTimer = setInterval(tick, refresh * 1000);
  // The lock is the kernel's and can't be lost; the beat only refreshes "who holds it".
  const beatTimer = setInterval(() => lock?.heartbeat(), HEARTBEAT_MS);
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
      checkForUpdate();
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
    const steps = new QuitSteps();
    let exitCode = code;
    // Whatever fails on the way out, the process still exits: a later fatal error finds
    // `closing` set and returns, so nothing else would (T22).
    try {
      clearInterval(tickTimer);
      clearInterval(beatTimer);
      clearTimeout(fallback);
      if (ingestRetry !== null) clearTimeout(ingestRetry);
      unsubscribe();
      await steps.run("restoring the terminal", () => renderer.destroy());
      // OpenTUI turns on grapheme clustering (mode 2027) and leaves it on (critique n1).
      if (process.stdout.isTTY) process.stdout.write("\x1b[?2027l");
      if (error !== undefined) {
        const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
        log.write("error", `crashed: ${text}`);
        process.stderr.write(`tokenhud: crashed: ${text}\n`);
      }
      const [ingestStopped] = await Promise.all([
        steps.run("stopping the ingest worker", () => stopIngest(QUIT_STOP_MS)),
        steps.run("stopping the view-model worker", () => within(vm.stop(), QUIT_STOP_MS)),
      ]);
      // Released by hand only once the Worker this quit stopped has said so. One still in
      // its pass keeps the lock until the exit, when the kernel drops it. A Worker that an
      // accounts-edited restart is still stopping is not tracked here, so a quit during
      // that restart releases at once; lock.ts allows it, as the store stays correct with
      // two writers.
      if (ingestStopped === true) {
        await steps.run("releasing the ingest lock", () => lock?.release());
      }
      exitCode = steps.finish(code, log, (line) => process.stderr.write(line));
    } finally {
      resolveExit(exitCode);
    }
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

  const fromVm = (message: VmMessage) => {
    if (message.type === "down") {
      log.write(
        "error",
        `view-model worker stopped: ${message.reason}; restarting in ${message.retryInMs} ms`,
      );
    } else if (message.type === "error") {
      log.write("warn", message.message);
    }
    controller.vmMessage(message);
  };
  boot.attach(fromVm);
  for (const message of boot.early) fromVm(message);
  // Keys go to the controller from before the first render. OpenTUI reads stdin from the
  // moment it sets raw mode and drops a key nothing listens for; React's useKeyboard
  // subscribes in an effect that runs after the first frame is drawn, so a q pressed then
  // was lost (T22). A key handler that throws is a crash like a render error.
  renderer.keyInput.on("keypress", (key) => {
    try {
      controller.key({ name: key.name, sequence: key.sequence, ctrl: key.ctrl, shift: key.shift });
    } catch (error) {
      fatal(error);
    }
  });
  createRoot(renderer).render(<App controller={controller} onFatal={fatal} onCommit={onCommit} />);
  return exited;
}
