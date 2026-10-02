import { rmSync } from "node:fs";

/** What Windows says when a file is still open somewhere (or a delete is still pending). */
const HELD = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/**
 * Removes the temp dir `dir` and everything in it.
 *
 * On Windows a file can't be deleted while any handle to it is open, so a dir holding a
 * store a Worker or child process is still closing as it exits fails with EBUSY or EPERM
 * for a moment. Node's `rmSync` retries that with `maxRetries`; Bun 1.4.2 accepts the
 * option and ignores it (T15 measured it on a Windows runner: EBUSY at once, with
 * `maxRetries: 10`). So this retries for up to `waitMs`. A handle a test never closes
 * still fails the cleanup, with the same error.
 */
export function removeTempDir(dir: string, waitMs = 2000): void {
  const deadline = performance.now() + waitMs;
  for (let delay = 10; ; delay = Math.min(2 * delay, 200)) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!HELD.has(code) || performance.now() + delay > deadline) throw error;
      Bun.sleepSync(delay);
    }
  }
}
