// Quitting's steps (src/tui/quit.ts; T22 critique m1): a step that fails stops neither the
// others nor the exit, and is reported once, by name, with exit code 1 for a quit.
import { describe, expect, test } from "bun:test";
import type { Log } from "../../src/tui/log.ts";
import { QuitSteps } from "../../src/tui/quit.ts";
import { guard } from "../guard.ts";

guard();

function recorder() {
  const logged: string[] = [];
  const written: string[] = [];
  const log: Log = { write: (level, message) => logged.push(`${level} ${message}`) };
  return { logged, written, log, stderr: (line: string) => written.push(line) };
}

describe("quitting's steps", () => {
  test("all succeed: their values come back, nothing is reported, the code is kept", async () => {
    const steps = new QuitSteps();
    const out = recorder();
    expect(await steps.run("stopping the ingest worker", () => true)).toBe(true);
    expect(await steps.run("releasing the ingest lock", async () => "done")).toBe("done");
    expect(steps.finish(0, out.log, out.stderr)).toBe(0);
    expect(out.logged).toEqual([]);
    expect(out.written).toEqual([]);
  });

  test("a throw and a rejection: later steps still run, one report names both, exit 1", async () => {
    const steps = new QuitSteps();
    const out = recorder();
    const ran: string[] = [];
    const thrown = await steps.run("restoring the terminal", () => {
      throw new Error("the tty is gone");
    });
    const rejected = await steps.run("releasing the ingest lock", () =>
      Promise.reject(new Error("simulated failure releasing the lock")),
    );
    await steps.run("stopping the view-model worker", () => ran.push("vm"));
    expect([thrown, rejected]).toEqual([undefined, undefined]);
    expect(ran).toEqual(["vm"]);
    expect(steps.finish(0, out.log, out.stderr)).toBe(1);
    const line =
      "quitting: restoring the terminal failed: the tty is gone; " +
      "releasing the ingest lock failed: simulated failure releasing the lock";
    expect(out.logged).toEqual([`error ${line}`]);
    expect(out.written).toEqual([`tokenhud: ${line}\n`]);
  });

  test("a crash or a signal whose step fails keeps its own code", async () => {
    for (const code of [1, 130, 143]) {
      const steps = new QuitSteps();
      const out = recorder();
      await steps.run("releasing the ingest lock", () => {
        throw "not an Error";
      });
      expect(steps.finish(code, out.log, out.stderr)).toBe(code);
      expect(out.written).toEqual([
        "tokenhud: quitting: releasing the ingest lock failed: not an Error\n",
      ]);
    }
  });
});
