import { mkdirSync, mkdtempSync, writeFileSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, defaultConfig } from "../config.ts";
import { type IngestWorker, startIngestWorker } from "../ingest/client.ts";
import { superviseVmWorker, type VmWorker } from "../tui/vm/client.ts";
import { vmSettingsOf } from "../tui/vm/types.ts";

// `tokenhud selftest workers`: a developer command, left out of --help like `ingest`. It
// starts each of tokenhud's Workers as the TUI does and round-trips a message through it, so
// that the release smoke tests prove a compiled binary can start them (T31: 0.1.4's Windows
// binaries could not, and nothing ran a compiled binary's Workers before a release).
//
// - The ingest Worker ingests two tiny synthetic transcripts into a temp store, through two
//   parse Workers: the pool is told to use them even for a few bytes.
// - A parse Worker that fails has its share read inline, so the pass still succeeds; the
//   pool's warning about it fails the parse Worker.
// - The view-model Worker computes its views from that store, which must list the account
//   the ingest Worker reported.
//
// Everything is in a temp dir deleted afterwards. Nothing of this machine's is read (no
// config, no provider dirs, no WSL side) and nothing touches the network (limits are off).
// Prints a line per Worker; exits 0 when every one passed, else 1.

const USAGE = "usage: tokenhud selftest workers";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

/** How long each Worker may take to answer: GitHub's Windows runners can be slow. */
const TIMEOUT_MS = 30_000;
/** One transcript per parse Worker. */
const TRANSCRIPTS = 2;

type Result =
  | { worker: string; ok: true; detail: string }
  | { worker: string; ok: false; reason: string };

/** One synthetic Claude usage line, with obviously fake ids. */
function usageLine(n: number, ts: number): string {
  return `${JSON.stringify({
    type: "assistant",
    requestId: `req_SELFTEST${n}`,
    timestamp: new Date(ts).toISOString(),
    message: {
      id: `msg_SELFTEST${n}`,
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 100 + n, output_tokens: 10 },
    },
  })}\n`;
}

interface Machine {
  home: string;
  store: string;
  cache: string;
  config: Config;
}

/** `<dir>/home/.claude`, the default Claude root of a home, with the transcripts. */
function makeMachine(dir: string, now: number): Machine {
  const home = join(dir, "home");
  const project = join(home, ".claude", "projects", "-selftest");
  mkdirSync(project, { recursive: true });
  for (let n = 1; n <= TRANSCRIPTS; n++) {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    writeFileSync(join(project, `${id}.jsonl`), usageLine(n, now - 60_000));
  }
  return {
    home,
    store: join(dir, "tokenhud.db"),
    cache: join(dir, "cache.db"),
    config: defaultConfig(),
  };
}

/** Settles with `run`'s outcome, or a timeout failure after `TIMEOUT_MS`. */
function within<T>(
  what: string,
  run: (done: (value: T) => void, fail: (reason: string) => void) => void,
) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no answer in ${TIMEOUT_MS / 1000} s (${what})`)),
      TIMEOUT_MS,
    );
    run(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(new Error(reason));
      },
    );
  });
}

const firstLine = (text: string) => text.split("\n", 1)[0]?.trim() || "an error";

/** Asks a Worker to stop, waiting for it at most `TIMEOUT_MS`. */
const stop = (worker: { stop(): Promise<void> } | null) =>
  worker === null ? undefined : Promise.race([worker.stop(), Bun.sleep(TIMEOUT_MS)]);

/** Tests: other Worker entries (to see a failing one named), and where the lines go. */
export interface SelftestOptions {
  ingestUrl?: string;
  vmUrl?: string;
  write?: (text: string) => void;
}

/** The ingest Worker's first pass, and what its parse Workers said; then it is stopped. */
async function ingest(
  machine: Machine,
  url: string | undefined,
): Promise<{ results: Result[]; identities: string[] }> {
  let worker: IngestWorker | null = null;
  let parseFailure: string | null = null;
  let error: string | null = null;
  try {
    const pass = await within<{ inserted: number; identities: string[] }>(
      "the first pass",
      (done, fail) => {
        worker = startIngestWorker(
          {
            storePath: machine.store,
            cachePath: machine.cache,
            config: machine.config,
            discover: { home: machine.home, env: {}, wslUsersDir: null },
            importLedger: null,
            poolSize: TRANSCRIPTS,
            poolMinBytes: 0,
          },
          (message) => {
            if (message.type === "log" && message.message.includes("parse Worker")) {
              parseFailure ??= message.message;
            } else if (message.type === "log" && message.level === "error") {
              error ??= message.message;
            } else if (message.type === "pass") {
              const { report } = message;
              if (report.storeError !== null) {
                fail(`the store write failed: ${report.storeError}`);
                return;
              }
              done({
                inserted: report.roots.reduce((sum, root) => sum + root.inserted, 0),
                identities: report.event?.accounts ?? [],
              });
            }
          },
          (code) => fail(error === null ? `exited with code ${code}` : firstLine(error)),
          url,
        );
      },
    );
    const results: Result[] = [];
    results.push(
      pass.inserted === TRANSCRIPTS
        ? { worker: "ingest Worker", ok: true, detail: `${pass.inserted} rows stored` }
        : {
            worker: "ingest Worker",
            ok: false,
            reason: `stored ${pass.inserted} rows of ${TRANSCRIPTS}${error === null ? "" : ` (${firstLine(error)})`}`,
          },
    );
    results.push(
      parseFailure === null
        ? { worker: "parse Worker", ok: true, detail: `${TRANSCRIPTS} read a transcript each` }
        : { worker: "parse Worker", ok: false, reason: firstLine(parseFailure) },
    );
    return { results, identities: pass.identities };
  } catch (e) {
    return {
      results: [{ worker: "ingest Worker", ok: false, reason: (e as Error).message }],
      identities: [],
    };
  } finally {
    await stop(worker as IngestWorker | null);
  }
}

/** The view-model Worker's first views of the store, then it is stopped. */
async function viewModels(
  machine: Machine,
  dir: string,
  identities: string[],
  url: string | undefined,
): Promise<Result> {
  const worker = "view-model Worker";
  let vm: VmWorker | null = null;
  try {
    const accounts = await within<string[]>("the first views", (done, fail) => {
      vm = superviseVmWorker({
        start: {
          type: "start",
          storePath: machine.store,
          overridesPath: join(dir, "pricing-overrides.json"),
          mcpDir: join(dir, "mcp"),
          limitsPath: join(dir, "limits.json"),
          cachePath: machine.cache,
          mode: "owner",
          settings: vmSettingsOf(machine.config, null),
          scopeLabel: null,
          config: machine.config,
          discover: { home: machine.home, env: { TOKENHUD_WSL_USERS: "" } },
        },
        onMessage: (message) => {
          if (message.type === "views") done(message.accounts.map((a) => a.identity));
          else if (message.type === "down") fail(message.reason);
          else if (message.type === "error") fail(firstLine(message.message));
        },
        ...(url === undefined ? {} : { url }),
      });
    });
    const missing = identities.filter((id) => !accounts.includes(id));
    if (missing.length > 0) {
      return { worker, ok: false, reason: "its views lack the account the ingest Worker stored" };
    }
    return { worker, ok: true, detail: `views of ${accounts.length} account(s)` };
  } catch (e) {
    return { worker, ok: false, reason: (e as Error).message };
  } finally {
    await stop(vm as VmWorker | null);
  }
}

/**
 * Written straight to the file descriptor: the CLI exits right after, so that a Worker that
 * never stopped can't keep a failed selftest running.
 */
const writeOut = (text: string) => writeSync(1, text);

export async function runSelftest(
  args: readonly string[],
  options: SelftestOptions = {},
): Promise<number> {
  const write = options.write ?? writeOut;
  if (args.length !== 1 || args[0] !== "workers") {
    const help = args[0] === "--help" || args[0] === "-h";
    if (help) write(`${USAGE}\n`);
    else writeSync(2, `${USAGE}\n`);
    return help ? EXIT_OK : EXIT_USAGE;
  }
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-selftest-"));
  try {
    const machine = makeMachine(dir, Date.now());
    const ingested = await ingest(machine, options.ingestUrl);
    const vm = await viewModels(machine, dir, ingested.identities, options.vmUrl);
    const results = [...ingested.results, vm];
    for (const r of results) {
      write(r.ok ? `ok   ${r.worker}: ${r.detail}\n` : `FAIL ${r.worker}: ${r.reason}\n`);
    }
    return results.every((r) => r.ok) ? EXIT_OK : EXIT_FAIL;
  } finally {
    // Windows may hold a just-closed store for a moment.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
      () => {},
    );
  }
}
