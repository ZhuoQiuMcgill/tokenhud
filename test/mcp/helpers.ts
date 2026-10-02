import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { defaultConfig } from "../../src/config.ts";
import {
  type AccountStatus,
  initialStatus,
  limitsPath,
  saveLimitsCache,
} from "../../src/limits/cache.ts";
import type { Bucket, Capture } from "../../src/limits/capture.ts";
import { serveTools, type Wiring, type WiringOptions, wireTools } from "../../src/mcp/server.ts";
import type { WaitClock } from "../../src/mcp/wait.ts";
import { storePath } from "../../src/paths.ts";
import { Zone } from "../../src/query/tz.ts";
import { discoverClaudeRoots, discoverCodexRoots, type Root } from "../../src/sources/roots.ts";
import { openStore, type UsageRow } from "../../src/store/store.ts";

const made: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

/** Closes servers and removes temp dirs; each test file registers it with afterEach. */
export async function cleanup(): Promise<void> {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-mcp-test-"));
  made.push(dir);
  return dir;
}

/** 2026-10-01T15:00:00Z, the fixed "now" of these tests. */
export const NOW = Date.UTC(2026, 9, 1, 15);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** An obviously fake Claude Code session id. */
export const SESSION = "00000000-0000-4000-8000-000000000001";

type Env = Record<string, string>;

/**
 * A fake machine: HOME with `~/.claude` (label personal), `~/.claude-work` (work) and
 * `~/.codex` (codex), none signed in, and a config home for tokenhud. Never the real ones:
 * the Windows side is switched off and no Claude or Codex variable is inherited.
 */
export interface Machine {
  home: string;
  xdg: string;
  env: Env;
  claude: string;
  work: string;
  codex: string;
}

export function machine(): Machine {
  const base = tempDir();
  const home = join(base, "home");
  const claude = join(home, ".claude");
  const work = join(home, ".claude-work");
  const codex = join(home, ".codex");
  for (const dir of [join(claude, "projects"), join(work, "projects"), join(codex, "sessions")]) {
    mkdirSync(dir, { recursive: true });
  }
  const xdg = join(base, "xdg");
  return {
    home,
    xdg,
    env: { HOME: home, XDG_CONFIG_HOME: xdg, TOKENHUD_WSL_USERS: "" },
    claude,
    work,
    codex,
  };
}

/** The CLI entry, for tests that run tokenhud as a fresh process. */
export const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

/** The parent's env without any Claude Code or Codex variable, pointed at the fake machine. */
export function envOf(m: Machine): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(CLAUDE|CODEX|XDG_CONFIG_HOME$)/.test(k)) env[k] = v;
  }
  return { ...env, ...m.env, USERPROFILE: m.home };
}

/** Every root of `m` as discovery finds it under `env`. */
export function rootsOf(m: Machine, env: Env = m.env): Root[] {
  const options = { home: m.home, env, wslUsersDir: null };
  const claude = discoverClaudeRoots(defaultConfig(), options);
  return [...claude, ...discoverCodexRoots(defaultConfig(), options, claude)];
}

export function rootNamed(m: Machine, label: string): Root {
  const root = rootsOf(m).find((r) => r.label === label);
  if (root === undefined) throw new Error(`no root ${label}`);
  return root;
}

/** Writes a transcript `<root>/projects/<project>/<session>.jsonl` (content irrelevant). */
export function transcript(
  configDir: string,
  session = SESSION,
  project = "-fake-project",
): string {
  const dir = join(configDir, "projects", project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path, "{}\n");
  return path;
}

let nextKey = 1n;

/** A usage row of a root, priced as claude-opus-4-8 unless told otherwise. */
export function usageRow(root: Root, ts: number, over: Partial<UsageRow> = {}): UsageRow {
  return {
    key: nextKey++,
    provider: root.provider,
    identity: root.identity,
    label: root.label,
    ts,
    model: "claude-opus-4-8",
    inp: 1_000,
    outp: 100,
    cr: 0,
    cc: 0,
    e5: null,
    e1: null,
    tier: 0,
    ...over,
  };
}

export function writeStore(m: Machine, rows: readonly UsageRow[]): void {
  const store = openStore(storePath(m.env, m.home));
  try {
    store.upsert(rows);
  } finally {
    store.close();
  }
}

export interface WindowSpec {
  pct: number;
  resetsAt: number;
  label?: string;
}

// The labels T8's Claude normaliser gives these kinds.
const LABELS: Record<string, string> = { session: "5-HOUR", weekly_all: "WEEKLY" };

/** A capture taken at `at` (epoch ms) with windows by kind, labelled as T8 labels them. */
export function capture(
  at: number,
  windows: Record<string, WindowSpec>,
  source: "claude" | "codex" = "claude",
): Capture {
  const rate_limits: Record<string, Bucket> = {};
  for (const [kind, w] of Object.entries(windows)) {
    const label = w.label ?? LABELS[kind];
    rate_limits[kind] = {
      ...(label !== undefined && { label }),
      used_percentage: w.pct,
      resets_at: w.resetsAt / 1000,
    };
  }
  return { captured_at: at / 1000, source, via: "api", rate_limits };
}

/** limits.json with these captures and statuses, keyed by root identity. */
export function writeLimits(
  m: Machine,
  entries: Record<string, { capture?: Capture; status?: Partial<AccountStatus> }>,
): void {
  const providers: Record<string, Capture> = {};
  const status: Record<string, AccountStatus> = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.capture) providers[id] = entry.capture;
    if (entry.status) status[id] = { ...initialStatus(), ...entry.status };
  }
  saveLimitsCache({ providers, status }, limitsPath(m.env, m.home));
}

/**
 * Virtual time for waits: `sleep` yields one event-loop turn (so protocol messages get
 * through), then moves time on, unless the signal aborted meanwhile.
 */
export class FakeClock implements WaitClock {
  t: number;
  readonly sleeps: number[] = [];
  onSleep: ((now: number) => void) | null = null;

  constructor(t: number = NOW) {
    this.t = t;
  }

  now = (): number => this.t;

  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (signal.aborted) return;
    this.sleeps.push(ms);
    this.t += ms;
    this.onSleep?.(this.t);
  }
}

/** Real T8 reading and real stores, with T8's fetching replaced by `refresh`. */
export function wire(m: Machine, options: Partial<WiringOptions> = {}): Wiring {
  const wiring = wireTools({
    env: m.env,
    home: m.home,
    now: () => NOW,
    zone: Zone.of("UTC"),
    refresh: async () => {},
    log: () => {},
    ...options,
  });
  closers.push(() => wiring.close());
  return wiring;
}

// ── a JSON-RPC client over the server's stdio pipe ───────────────────────────────

export interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class McpPipe {
  /** What the server reads as stdin, and writes as stdout. */
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  /** Every message the server wrote, in order. */
  readonly received: RpcMessage[] = [];
  /** Lines on the server's stdout that were not JSON-RPC (must stay empty). */
  readonly noise: string[] = [];
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<number | string, (message: RpcMessage) => void>();
  onNotification: ((message: RpcMessage) => void) | null = null;

  constructor() {
    this.stdout.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("utf8");
      let at = this.#buffer.indexOf("\n");
      while (at >= 0) {
        const line = this.#buffer.slice(0, at);
        this.#buffer = this.#buffer.slice(at + 1);
        at = this.#buffer.indexOf("\n");
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          this.noise.push(line);
          continue;
        }
        this.received.push(message);
        if (message.id !== undefined && message.method === undefined) {
          this.#pending.get(message.id)?.(message);
          this.#pending.delete(message.id);
        } else {
          this.onNotification?.(message);
        }
      }
    });
  }

  send(message: Omit<RpcMessage, "jsonrpc">): void {
    this.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request(method: string, params?: Record<string, unknown>): Promise<RpcMessage> {
    const id = this.#nextId++;
    const reply = new Promise<RpcMessage>((resolve) => this.#pending.set(id, resolve));
    this.send({ id, method, ...(params !== undefined && { params }) });
    return reply;
  }

  /** Sends a request without waiting; returns its id. */
  start(
    method: string,
    params?: Record<string, unknown>,
  ): { id: number; reply: Promise<RpcMessage> } {
    const id = this.#nextId;
    return { id, reply: this.request(method, params) };
  }

  async initialize(): Promise<RpcMessage> {
    const reply = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokenhud-test", version: "0" },
    });
    this.send({ method: "notifications/initialized" });
    return reply;
  }

  /** A tool call's result: `structuredContent` (or the error text) and `isError`. */
  async call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ value: Record<string, unknown>; isError: boolean; text: string }> {
    const reply = await this.request("tools/call", { name, arguments: args });
    return toolResult(reply);
  }
}

export function toolResult(reply: RpcMessage): {
  value: Record<string, unknown>;
  isError: boolean;
  text: string;
} {
  const result = reply.result as {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  const text = result.content?.[0]?.text ?? "";
  return { value: result.structuredContent ?? {}, isError: result.isError === true, text };
}

/** The server over `wiring`, connected to a fresh pipe and initialised. */
export async function connect(wiring: Wiring): Promise<McpPipe> {
  const pipe = new McpPipe();
  const handle = serveTools(wiring.tools, () => {}, pipe.stdin, pipe.stdout);
  closers.push(() => handle.close());
  await pipe.initialize();
  return pipe;
}
