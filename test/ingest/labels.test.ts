import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangedEvent } from "../../src/ingest/pass.ts";
import { rootIdentity } from "../../src/sources/roots.ts";
import { ledgerKey } from "../../src/store/key.ts";
import { claudeLine, cleanup, makeRoot, openEngine, tempDir, watcherReady } from "./helpers.ts";

afterEach(cleanup);

/** A Windows-side Claude root under a fake Users dir, with one transcript. */
function windowsRoot() {
  const base = tempDir();
  const users = join(base, "Users");
  const root = makeRoot(join(users, "someone"), ".claude");
  const file = join(root, "projects", "s.jsonl");
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(file, claudeLine("1", "1", 100));
  return { base, users, root, file, home: join(base, "home") };
}

/** The account cc-usage's import left: the Windows root under its configured label `win`. */
function imported(engine: ReturnType<typeof openEngine>, root: string, home: string) {
  engine.store.upsert([
    {
      key: ledgerKey("c\x1freq_FAKEold\x1fmsg_FAKEold"),
      provider: "claude",
      identity: rootIdentity(root, home),
      label: "win",
      ts: Date.parse("2026-01-01T00:00:00Z"),
      model: "claude-opus-4-8",
      inp: 1,
      outp: 1,
      cr: 0,
      cc: 0,
      e5: null,
      e1: null,
      tier: 0,
    },
  ]);
}

const labelOf = (engine: ReturnType<typeof openEngine>, identity: string) =>
  [...engine.store.accounts().values()].find((a) => a.identity === identity)?.label;

test("with no config, a live row from the Windows root keeps the imported label", async () => {
  const { users, root, file, home } = windowsRoot();
  const events: ChangedEvent[] = [];
  let passes = 0;
  const engine = openEngine([], {
    discover: { home, env: {}, wslUsersDir: users },
    onChanged: (e) => events.push(e),
    onPass: () => passes++,
  });
  imported(engine, root, home);
  await engine.startLive();
  await watcherReady(join(root, "projects"), () => passes);
  const discovered = engine.roots.find((r) => r.source === "wsl");
  expect(discovered).toMatchObject({ label: "claude-win", labelExplicit: false });
  const identity = discovered?.identity as string;
  appendFileSync(file, claudeLine("2", "2", 200, 0, { ts: "2026-06-03T00:00:00Z" }));
  const deadline = performance.now() + 1000;
  while (events.length < 2 && performance.now() < deadline) await Bun.sleep(10);
  expect(events).toHaveLength(2);
  expect(labelOf(engine, identity)).toBe("win");
  expect(engine.store.rows([ledgerKey("c\x1freq_FAKE2\x1fmsg_FAKE2")])).toHaveLength(1);
});

test("a label set in config renames the account", async () => {
  const { users, root, home } = windowsRoot();
  const engine = openEngine([{ path: root, label: "laptop" }], {
    discover: { home, env: {}, wslUsersDir: users },
  });
  imported(engine, root, home);
  await engine.fullPass();
  expect(labelOf(engine, rootIdentity(root, home))).toBe("laptop");
});

test("a new account takes its derived label", async () => {
  const { users, root, home } = windowsRoot();
  const engine = openEngine([], { discover: { home, env: {}, wslUsersDir: users } });
  await engine.fullPass();
  expect(labelOf(engine, rootIdentity(root, home))).toBe("claude-win");
});

test("pass reports and the ready list name an account by its stored label", async () => {
  const { users, root, file, home } = windowsRoot();
  const engine = openEngine([], { discover: { home, env: {}, wslUsersDir: users } });
  imported(engine, root, home);
  appendFileSync(file, claudeLine("3", "3", 300));
  const report = await engine.fullPass();
  const identity = rootIdentity(root, home);
  expect(report?.roots.find((r) => r.identity === identity)?.label).toBe("win");
  const windows = engine.roots.filter((r) => r.identity === identity);
  expect(windows[0]?.label).toBe("claude-win"); // the root's own, derived label
  expect(engine.labels(windows)).toEqual(["win"]);
});
