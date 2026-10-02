// The real view-model Worker, end to end: started from the UI side's client, fed a change,
// stopped by message (never terminate()d).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/store/store.ts";
import { superviseVmWorker } from "../../src/tui/vm/client.ts";
import type { OverviewVM, VmMessage } from "../../src/tui/vm/types.ts";
import { guard } from "../guard.ts";
import { type Fixture, fixtureConfig, makeFixtureStore, NOW, TZ } from "./fixture.ts";

guard();

let fixture: Fixture | null = null;
let mcp: string | null = null;
afterEach(() => {
  fixture?.remove();
  if (mcp !== null) rmSync(mcp, { recursive: true, force: true });
  fixture = null;
  mcp = null;
});

async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

test("views on start, a reported change recomputed, a clean stop", async () => {
  fixture = makeFixtureStore();
  mcp = mkdtempSync(join(tmpdir(), "tokenhud-worker-mcp-"));
  const messages: VmMessage[] = [];
  const vm = superviseVmWorker({
    start: {
      type: "start",
      storePath: fixture.storePath,
      overridesPath: join(fixture.dir, "none.json"),
      mcpDir: mcp,
      limitsPath: join(fixture.dir, "limits.json"),
      cachePath: join(fixture.dir, "cache.db"),
      mode: "owner",
      settings: { tz: TZ, window: "all", scope: null },
      scopeLabel: null,
      config: fixtureConfig(),
      discover: { home: join(fixture.dir, "home"), env: { TOKENHUD_WSL_USERS: "" } },
      now: NOW,
    },
    onMessage: (m) => messages.push(m),
  });
  const views = () =>
    messages.filter((m) => m.type === "views") as Extract<VmMessage, { type: "views" }>[];
  await until(() => views().length >= 1, "the first views");
  expect(Object.keys(views()[0]?.views ?? {}).sort()).toEqual([
    "accounts",
    "history",
    "models",
    "overview",
  ]);
  const first = views()[0] as Extract<VmMessage, { type: "views" }>;
  const before = (first.views.overview as OverviewVM).spend.today.tokens;

  const store = openStore(fixture.storePath);
  store.upsert([
    {
      key: 1n << 50n,
      provider: "claude",
      identity: "fixture-identity-work",
      label: "work",
      ts: NOW - 5000,
      model: "claude-sonnet-4-6",
      inp: 777,
      outp: 0,
      cr: 0,
      cc: 0,
      e5: null,
      e1: null,
      tier: 0,
    },
  ]);
  store.close();
  vm.send({
    type: "changed",
    fromTs: NOW - 5000,
    toTs: NOW - 5000,
    accounts: ["fixture-identity-work"],
  });
  // Roots found after the first frame recompute the Accounts view on their own; the
  // change's recompute is the one with the Overview in it.
  const recomputed = () => views().find((v, i) => i > 0 && v.views.overview !== undefined);
  await until(() => recomputed() !== undefined, "the recompute");
  const second = recomputed() as Extract<VmMessage, { type: "views" }>;
  expect((second.views.overview as OverviewVM).spend.today.tokens).toBe(before + 777);

  await vm.stop();
  expect(messages[messages.length - 1]).toEqual({ type: "stopped" });
});
