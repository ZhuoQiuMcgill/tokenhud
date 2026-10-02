import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capture } from "../../src/limits/capture.ts";
import type { Provider, Root, RootSource } from "../../src/sources/roots.ts";
import { removeTempDir } from "../temp.ts";

const made: string[] = [];

/** Removes the temp dirs; each test file registers it with afterEach. */
export function cleanup(): void {
  for (const dir of made.splice(0)) removeTempDir(dir);
}

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-limits-test-"));
  made.push(dir);
  return dir;
}

/** An obviously fake OAuth access token: tests assert it never leaves memory. */
export const FAKE_TOKEN = "sk-ant-oat01-FAKE0000TOKEN0000DO0NOT0USE0000000000000000";
export const FAKE_TOKEN_2 = "sk-ant-oat01-FAKE1111TOKEN1111DO0NOT0USE1111111111111111";

/** Writes `<dir>/.credentials.json` holding a fake OAuth login. */
export function writeCredentials(dir: string, token: string, expiresAt: number | null): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".credentials.json");
  const oauth: Record<string, unknown> = { accessToken: token, refreshToken: `${token}-refresh` };
  if (expiresAt !== null) oauth.expiresAt = expiresAt;
  writeFileSync(path, JSON.stringify({ claudeAiOauth: oauth }));
  return path;
}

let nextIdentity = 1;

/** A root as discovery returns it, with an obviously fake identity. */
export function fakeRoot(
  provider: Provider,
  label: string,
  path: string,
  over: Partial<Root> & { source?: RootSource } = {},
): Root {
  const identity = (nextIdentity++).toString(16).padStart(32, "0");
  return {
    provider,
    label,
    labelExplicit: true,
    path,
    projects: join(path, provider === "claude" ? "projects" : "sessions"),
    source: "config",
    enabled: true,
    identity,
    historyOnly: false,
    ...over,
  };
}

/** Claude's usage response in its current shape (`limits` list), as cc-usage's tests use it. */
export const CLAUDE_RESPONSE = {
  limits: [
    { kind: "session", percent: 26, resets_at: "2026-07-13T00:50:00+00:00", scope: null },
    { kind: "weekly_all", percent: 69, resets_at: "2026-07-13T10:00:00+00:00", scope: null },
    {
      kind: "weekly_scoped",
      percent: 99,
      resets_at: "2026-07-13T10:00:00+00:00",
      scope: { model: { display_name: "Fable" } },
    },
  ],
};

export const CODEX_RESPONSE = {
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: 2_000_000_000 },
      secondary: null,
    },
    codex_spark: {
      limitId: "codex_spark",
      limitName: "GPT Spark",
      primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 2_000_000_100 },
      secondary: null,
    },
  },
};

/** A capture of one window, times in epoch seconds. */
export function capture(
  source: Capture["source"],
  capturedAt: number,
  windows: Record<string, { pct: number; resets: number; minutes?: number; label?: string }>,
): Capture {
  const rate_limits: Capture["rate_limits"] = {};
  for (const [key, w] of Object.entries(windows)) {
    rate_limits[key] = { used_percentage: w.pct, resets_at: w.resets };
    if (w.minutes !== undefined) rate_limits[key].window_minutes = w.minutes;
    if (w.label !== undefined) rate_limits[key].label = w.label;
  }
  return { captured_at: capturedAt, source, rate_limits };
}

/** A POSIX shell script standing in for a CLI (`codex`, `claude`); returns its path. */
export function stubExecutable(name: string, body: string): string {
  const path = join(tempDir(), name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** The stub scripts are POSIX shell. */
export const posixOnly = process.platform === "win32";
