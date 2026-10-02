// The view-model Worker dying and coming back (critique M1): a real Worker with an injected
// uncaught throw, unhandled rejection or exit. The header shows `● error` with one clean
// line, the Worker restarts with back-off, data resumes and the header is `● live` again.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState, type Ports } from "../../src/tui/controller.ts";
import { RESTART_BACKOFF_MS, superviseVmWorker, type VmWorker } from "../../src/tui/vm/client.ts";
import type { VmMessage, VmStart } from "../../src/tui/vm/types.ts";
import { type Fixture, fixtureConfig, makeFixtureStore, NOW, TZ } from "./fixture.ts";
import { chars, cleanupRenderers, render, settle } from "./render.ts";

cleanupRenderers();

const FAULT_WORKER = new URL("./vm/fault-worker.ts", import.meta.url).href;
const ports: Ports = {
  saveConfig: () => {},
  vmSettings: () => {},
  vmConfig: () => {},
  vmRoots: () => {},
  accountsEdited: () => {},
  quit: () => {},
};

let fixture: Fixture | null = null;
let dir: string | null = null;
let vm: VmWorker | null = null;
afterEach(async () => {
  await vm?.stop();
  vm = null;
  fixture?.remove();
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  fixture = null;
  dir = null;
});

/** The start message, carrying the fault for the fault Worker. */
function start(f: Fixture, mcp: string, testFault: { kind: string; marker: string }): VmStart {
  const message: VmStart = {
    type: "start",
    storePath: f.storePath,
    overridesPath: join(f.dir, "none.json"),
    mcpDir: mcp,
    mode: "owner",
    settings: { tz: TZ, window: "all", scope: null },
    scopeLabel: null,
    config: fixtureConfig(),
    discover: { home: join(f.dir, "home"), env: { TOKENHUD_WSL_USERS: "" } },
    now: NOW,
  };
  return Object.assign(message, { testFault });
}

async function until(pred: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe.each([
  ["throw", "injected fault"],
  ["reject", "injected rejection"],
  ["exit", "exited with code 3"],
] as const)("an injected %s in the view-model Worker", (kind, reason) => {
  test("shows ● error with one clean line, restarts, and resumes ● live", async () => {
    fixture = makeFixtureStore();
    dir = mkdtempSync(join(tmpdir(), "tokenhud-supervisor-"));
    const c = new Controller(initialState(fixtureConfig(), "owner"), ports, "America/Toronto");
    const seen: VmMessage[] = [];
    vm = superviseVmWorker({
      start: start(fixture, join(dir, "mcp"), { kind, marker: join(dir, "fired") }),
      onMessage: (m) => {
        seen.push(m);
        c.vmMessage(m);
      },
      url: FAULT_WORKER,
      backoffMs: [300, 600],
    });
    await until(() => c.getState().views.overview !== undefined, "the first views");
    c.setIngest("live");
    const setup = await render(<Frame controller={c} width={105} height={30} />, 105, 30);
    expect(chars(setup).split("\n")[0]).toContain("● live");

    await until(() => c.getState().vmDown !== null, "the Worker to die");
    await settle(setup);
    const screen = chars(setup).split("\n");
    expect(screen[0]).toContain("● error");
    expect(c.getState().vmDown).toBe(`view models stopped (${reason}); restarting in 1 s`);
    expect(screen[2]?.trim()).toBe(c.getState().vmDown as string);
    expect(seen.filter((m) => m.type === "down")).toEqual([
      { type: "down", reason, retryInMs: 300 },
    ]);

    // Restarted: view models arrive again, the error clears and the header is live.
    const before = seen.filter((m) => m.type === "views").length;
    await until(() => seen.filter((m) => m.type === "views").length > before, "the restart");
    await settle(setup);
    expect(c.getState().vmDown).toBeNull();
    expect(chars(setup).split("\n")[0]).toContain("● live");
    // And it still answers: a settings change recomputes.
    const views = seen.filter((m) => m.type === "views").length;
    vm.send({ type: "settings", settings: { tz: TZ, window: "today", scope: null } });
    await until(() => seen.filter((m) => m.type === "views").length > views, "a recompute");
  }, 30_000);
});

test("a Worker that keeps dying is retried after 1 s, 2 s, 5 s, then every 30 s", async () => {
  fixture = makeFixtureStore();
  dir = mkdtempSync(join(tmpdir(), "tokenhud-supervisor-"));
  const delays: number[] = [];
  const downs: string[] = [];
  vm = superviseVmWorker({
    start: start(fixture, join(dir, "mcp"), { kind: "always", marker: join(dir, "x") }),
    onMessage: (m) => {
      if (m.type === "down") downs.push(m.reason);
    },
    url: FAULT_WORKER,
    // Record each back-off, and retry at once.
    schedule: (fn, ms) => {
      delays.push(ms);
      return setTimeout(fn, 0);
    },
  });
  await until(() => delays.length >= 6, "six failures");
  expect(RESTART_BACKOFF_MS).toEqual([1000, 2000, 5000, 30_000]);
  expect(delays.slice(0, 6)).toEqual([1000, 2000, 5000, 30_000, 30_000, 30_000]);
  expect(new Set(downs)).toEqual(new Set(["injected fault"]));
}, 30_000);
