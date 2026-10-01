// T10 acceptance 3 and 4 in a real terminal: tokenhud under a pseudo-terminal (util-linux
// `script`), driven by keystrokes, its screen read back through a small VT emulator.
// Linux only; skipped where `script` isn't available.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CLI, makeHome, type PtyRun, ptyAvailable, runInPty } from "./pty/driver.ts";

const BUN = process.execPath;
// After tokenhud exits, the same pty reports the exit code and the line discipline's modes.
const AFTER = `echo "EXIT=$?"; stty -a`;
const LIVE = (s: string) => s.includes("● live");

function restored(run: PtyRun): void {
  expect(run.vt.altScreen).toBe(false);
  expect(run.vt.cursorVisible).toBe(true);
  const modes = run.output().split("EXIT=")[1] ?? "";
  // Cooked mode again: canonical input and echo, not raw mode's -icanon -echo.
  expect(modes).toMatch(/(^|\s)icanon(\s|;|$)/m);
  expect(modes).toMatch(/(^|\s)echo(\s|;|$)/m);
}

const exitCode = (run: PtyRun) => Number(/EXIT=(\d+)/.exec(run.output())?.[1]);

describe.skipIf(!ptyAvailable())("under a real pty", () => {
  test("start, switch views 1–4, settings and help open and close, mouse input, quit: terminal restored", async () => {
    const home = makeHome();
    const run = runInPty(`${BUN} ${CLI}; ${AFTER}`, home.env);
    try {
      await run.waitFor(LIVE, "the live indicator");
      expect(run.vt.altScreen).toBe(true);
      for (const [key, marker] of [
        ["2", "BY DAY"],
        ["3", "MODELS ·"],
        ["4", "ACCOUNTS ·"],
        ["1", " LIMITS"],
      ] as const) {
        run.send(key);
        await run.waitFor((s) => s.includes(marker), `view ${key}`);
      }
      run.send("s");
      await run.waitFor((s) => s.includes("╭─ Settings"), "settings");
      run.send("\x1b");
      await run.waitFor(
        (s) => !s.includes("╭─ Settings") && s.includes(" LIMITS"),
        "settings closed",
      );
      run.send("?");
      await run.waitFor((s) => s.includes("╭─ Keys"), "help");
      run.send("q");
      await run.waitFor((s) => !s.includes("╭─ Keys"), "help closed");
      // Mouse reports (SGR press, release, wheel; an X10 press) are ignored, never read as keys.
      run.send("\x1b[<0;12;6M\x1b[<0;12;6m\x1b[<64;12;6M\x1b[M !!");
      await Bun.sleep(300);
      expect(run.vt.text()).toContain(" LIMITS");
      run.send("q");
      await run.exited;
      expect(exitCode(run)).toBe(0);
      restored(run);
    } finally {
      run.kill();
      home.remove();
    }
  }, 60_000);

  test("a crash in a view: the error is printed, the exit code is 1, the terminal is restored", async () => {
    const home = makeHome();
    const run = runInPty(`${BUN} ${join(import.meta.dir, "pty", "crash.ts")}; ${AFTER}`, home.env);
    try {
      await run.waitFor(LIVE, "the live indicator");
      run.send("2");
      await run.exited;
      expect(exitCode(run)).toBe(1);
      expect(run.output()).toContain("simulated crash in a view");
      restored(run);
    } finally {
      run.kill();
      home.remove();
    }
  }, 60_000);

  test("lock: a second instance runs read-only with the notice, and takes over when the first quits", async () => {
    const home = makeHome();
    const first = runInPty(`${BUN} ${CLI}; ${AFTER}`, home.env);
    let second: PtyRun | null = null;
    try {
      await first.waitFor(LIVE, "the first instance live");
      second = runInPty(`${BUN} ${CLI}; ${AFTER}`, home.env);
      const s2 = second;
      await s2.waitFor(
        (s) => s.includes("another tokenhud is ingesting") && s.includes("● stale"),
        "the read-only notice",
      );
      // It still shows the stored data.
      await s2.waitFor((s) => s.includes(" SPEND") && !s.includes("reading the store"), "data");
      first.send("q");
      await first.exited;
      expect(exitCode(first)).toBe(0);
      // refresh_interval is 2 s: the next tick takes the lock and starts ingesting.
      await s2.waitFor(
        (s) => LIVE(s) && !s.includes("another tokenhud is ingesting"),
        "the takeover",
        15_000,
      );
      s2.send("q");
      await s2.exited;
      expect(exitCode(s2)).toBe(0);
      restored(s2);
    } finally {
      first.kill();
      second?.kill();
      home.remove();
    }
  }, 60_000);
});
