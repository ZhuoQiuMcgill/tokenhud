// T10 acceptance 3 and 4 in a real terminal: tokenhud under a pseudo-terminal (util-linux
// `script`), driven by keystrokes, its screen read back through a small VT emulator.
// Linux only; skipped where `script` isn't available.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guard } from "../guard.ts";
import { CLI, makeHome, type PtyRun, ptyAvailable, runInPty } from "./pty/driver.ts";

guard();

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
/** Starts for the q-at-the-first-frame check; before T22's fix, 93 in 100 lost the q. */
const QUIT_RUNS = 20;

describe.skipIf(!ptyAvailable())("under a real pty", () => {
  test("start, switch views 1–4, settings and help open and close, mouse input, quit: terminal restored", async () => {
    const home = makeHome();
    const run = runInPty(`${BUN} ${CLI}; ${AFTER}`, home.env);
    try {
      await run.waitFor(LIVE, "the live indicator");
      expect(run.vt.altScreen).toBe(true);
      for (const [key, marker] of [
        ["2", " this month "],
        ["3", "MODELS ·"],
        ["4", " ACCOUNTS"],
        ["1", " LIMITS"],
      ] as const) {
        run.send(key);
        await run.waitFor((s) => s.includes(marker), `view ${key}`);
      }
      run.send("x");
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

  // T22: OpenTUI reads keys from the moment it sets raw mode and drops any that nothing
  // listens for, and the TUI listened only once React's effects ran, after the first frame
  // was drawn: a q sent as soon as the first frame was read was lost in 93 of 100 runs, and
  // the TUI never quit. Here q goes at that moment, many times.
  test("q at the first frame quits within 1 s, every time", async () => {
    for (let i = 0; i < QUIT_RUNS; i++) {
      const home = makeHome();
      const run = runInPty(`${BUN} ${CLI}; ${AFTER}`, home.env);
      try {
        await run.whenSeen(
          () => run.vt.altScreen && run.vt.text().includes(" tokenhud "),
          "a frame",
        );
        const sent = performance.now();
        run.send("q");
        await run.whenSeen(() => /EXIT=\d+/.test(run.output()), `run ${i + 1} to quit`, 5000);
        expect(performance.now() - sent).toBeLessThan(1000);
        expect(exitCode(run)).toBe(0);
        await run.exited;
        restored(run);
      } finally {
        run.kill();
        home.remove();
      }
    }
  }, 60_000);

  // PM addendum to T11: the TUI's ingest Worker runs T8's limits schedule. This home has no
  // Claude login, so the first round finds the account signed out without any request, and
  // the card says so; before, it waited for limits that nothing fetched.
  test("the TUI fetches limits itself: a home without a login is not signed in", async () => {
    const home = makeHome();
    const run = runInPty(`${BUN} ${CLI}; ${AFTER}`, home.env);
    try {
      await run.waitFor((s) => LIVE(s) && s.includes("personal · claude"), "the card");
      await run.waitFor((s) => s.includes("not signed in here"), "the first limits round");
      const file = JSON.parse(readFileSync(join(home.configDir, "limits.json"), "utf8"));
      const status = Object.values(file.status as Record<string, { history_only: unknown }>);
      expect(status.map((s) => s.history_only)).toContain("detected");
      run.send("q");
      await run.exited;
      expect(exitCode(run)).toBe(0);
    } finally {
      run.kill();
      home.remove();
    }
  }, 60_000);

  // Critique m2: a lock journal that can't be used kept the TUI read-only for good. Here it
  // can't be moved aside either (the config dir is read-only): read-only with the reason,
  // logged once, retried, and live as soon as it can be fixed.
  test.skipIf(process.getuid?.() === 0)(
    "a lock journal that can't be fixed: read-only with the reason, then live once it can be",
    async () => {
      const home = makeHome();
      const lock = join(home.configDir, "ingest.lock.db");
      writeFileSync(lock, "");
      mkdirSync(`${lock}-journal`);
      mkdirSync(join(home.configDir, "logs"));
      chmodSync(home.configDir, 0o555);
      const run = runInPty(`${BUN} ${CLI}; ${AFTER}`, home.env, 140, 30);
      try {
        await run.waitFor(
          (s) =>
            s.includes("read-only: cannot take the ingest lock (SQLITE_") && s.includes("● stale"),
          "the read-only notice",
        );
        // Ticks every 2 s keep trying; once the journal can be moved aside, the lock is taken.
        await Bun.sleep(4500);
        chmodSync(home.configDir, 0o755);
        await run.waitFor((s) => LIVE(s) && !s.includes("read-only"), "the lock taken");
        run.send("q");
        await run.exited;
        expect(exitCode(run)).toBe(0);
        const log = readFileSync(join(home.configDir, "logs", "tokenhud.log"), "utf8");
        expect(log.split("cannot take the ingest lock").length - 1).toBe(1);
        expect(log).toContain("ingest.lock.db-journal could not be used");
      } finally {
        chmodSync(home.configDir, 0o755);
        run.kill();
        home.remove();
      }
    },
    60_000,
  );

  test("a newer release on GitHub shows in the footer, from the once-a-day check", async () => {
    const home = makeHome();
    // A fake api.github.com with one release, newer than any build.
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname.startsWith("/releases")
          ? Response.json(
              new URL(req.url).pathname === "/releases/latest"
                ? { tag_name: "v99.0.0", draft: false, prerelease: false, assets: [] }
                : [{ tag_name: "v99.0.0", draft: false, prerelease: false, assets: [] }],
            )
          : new Response("", { status: 404 }),
    });
    const env = { ...home.env, TOKENHUD_RELEASES_API: `http://127.0.0.1:${api.port}` };
    const run = runInPty(`${BUN} ${CLI}; ${AFTER}`, env);
    try {
      await run.waitFor((s) => s.includes("update 99.0.0 available"), "the update note");
      run.send("q");
      await run.exited;
      expect(exitCode(run)).toBe(0);
    } finally {
      run.kill();
      api.stop(true);
      home.remove();
    }
  }, 60_000);

  test("the default account renamed in settings keeps its new label after a restart", async () => {
    const home = makeHome();
    try {
      const first = runInPty(`${BUN} ${CLI}; ${AFTER}`, home.env);
      try {
        await first.waitFor((s) => LIVE(s) && s.includes("personal · claude"), "the card");
        first.send("x");
        await first.waitFor((s) => s.includes("╭─ Settings"), "settings");
        first.send("\x1b[F"); // End: the Accounts row
        await Bun.sleep(100);
        first.send("\r");
        await first.waitFor((s) => s.includes("Settings › Accounts"), "the account list");
        first.send("\r");
        await first.waitFor(
          (s) => s.includes("Show only this account") && s.includes("Rename…"),
          "the action menu",
        );
        first.send("ss\r"); // Rename… is the third item
        await first.waitFor((s) => s.includes("new label"), "the rename prompt");
        first.send(`${"\x7f".repeat(8)}main\r`);
        await first.waitFor((s) => s.includes("● main"), "the renamed root");
        first.send("\x1b");
        await Bun.sleep(300);
        first.send("\x1b");
        await first.waitFor((s) => s.includes("main · claude"), "the renamed card");
        first.send("q");
        await first.exited;
        expect(exitCode(first)).toBe(0);
      } finally {
        first.kill();
      }
      const second = runInPty(`${BUN} ${CLI}; ${AFTER}`, home.env);
      try {
        await second.waitFor((s) => s.includes("main · claude"), "the label after a restart");
        expect(second.vt.text()).not.toContain("personal · claude");
        second.send("q");
        await second.exited;
        expect(exitCode(second)).toBe(0);
      } finally {
        second.kill();
      }
    } finally {
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
