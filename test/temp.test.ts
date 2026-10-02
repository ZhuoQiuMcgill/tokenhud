// The test suite's own temp-dir plumbing (T15): where temp dirs go on a Windows runner, and
// removing one whose files another process is still closing.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guard } from "./guard.ts";
import { removeTempDir } from "./temp.ts";

guard();

const windows = process.platform === "win32";

test.skipIf(!(windows && process.env.RUNNER_TEMP))(
  "on a Windows runner, temp dirs are made on RUNNER_TEMP, not the OS disk",
  () => {
    expect(tmpdir()).toBe(process.env.RUNNER_TEMP as string);
  },
);

describe("removeTempDir", () => {
  test("removes a dir and everything in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tokenhud-temp-test-"));
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "f"), "x");
    removeTempDir(dir);
    expect(existsSync(dir)).toBe(false);
    removeTempDir(dir); // already gone: nothing to do
  });

  // Windows only: elsewhere an open file can be deleted, so nothing is ever held.
  test.skipIf(!windows)("waits out a file held by a process that is exiting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tokenhud-temp-test-"));
    const script = `
const { Database } = require("bun:sqlite");
const db = new Database(${JSON.stringify(join(dir, "held.db"))});
db.exec("CREATE TABLE t (x)");
console.log("open");
await Bun.sleep(60_000);
`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe" });
    try {
      const reader = child.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      // Held now. Node's rmSync would retry this for 1 + 2 + 3 + 4 + 5 = 15 s before it
      // threw; Bun 1.4.2 ignores the options and throws at once.
      const t0 = performance.now();
      expect(() =>
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 }),
      ).toThrow();
      expect(performance.now() - t0).toBeLessThan(5000);
      child.kill();
      removeTempDir(dir); // the handle goes as the process tears down
      expect(existsSync(dir)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test.skipIf(!windows)("a file this process never closes still fails it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tokenhud-temp-test-"));
    const db = new Database(join(dir, "leaked.db"));
    db.exec("CREATE TABLE t (x)");
    try {
      expect(() => removeTempDir(dir, 200)).toThrow(/EBUSY|EPERM/);
    } finally {
      db.close();
      removeTempDir(dir);
    }
  });
});
