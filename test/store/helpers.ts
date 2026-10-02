import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store, UsageRow } from "../../src/store/store.ts";
import { removeTempDir } from "../temp.ts";

const made: string[] = [];
const opened: Store[] = [];

/**
 * Closes tracked stores and removes temp dirs. Each test file registers it with
 * `afterEach(cleanup)`: Bun evaluates this module once per run, so a hook registered here
 * would attach to the first test file only.
 */
export function cleanup(): void {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of made.splice(0)) removeTempDir(dir);
}

/** A fresh temp dir, removed after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-store-test-"));
  made.push(dir);
  return dir;
}

/** Registers `store` to be closed after the test (before its temp dir is removed). */
export function track<T extends Store>(store: T): T {
  opened.push(store);
  return store;
}

export const T0 = 1_780_000_000_000; // 2026-05-28T20:26:40Z, a fixed epoch-ms "now"
export const HOUR = 3_600_000;

/** A usage row with neutral defaults; tests override what they exercise. */
export function row(key: bigint, over: Partial<UsageRow> = {}): UsageRow {
  return {
    key,
    provider: "claude",
    identity: "id-personal",
    label: "personal",
    ts: T0,
    model: "claude-opus-4-8",
    inp: 10,
    outp: 1,
    cr: 0,
    cc: 400,
    e5: null,
    e1: null,
    tier: 0,
    ...over,
  };
}
