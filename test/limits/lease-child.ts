// A process of its own for lease.test.ts: a LimitsService, or a stream of limits.json
// updates, over a limits.json shared with another such process.
import { appendFileSync } from "node:fs";
import { initialStatus, updateLimitsCache } from "../../src/limits/cache.ts";
import { LimitsService } from "../../src/limits/service.ts";
import { capture, fakeRoot } from "./helpers.ts";

const [mode, limitsPath, arg, startAt] = process.argv.slice(2) as [string, string, string, string];
await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));

if (mode === "fetch") {
  // `arg` is a log of fetches: one line per fetch, from whichever process made it.
  const root = {
    ...fakeRoot("claude", "personal", "/home/x/.claude", { source: "auto" }),
    identity: "00000000000000000000000000000001",
  };
  const service = new LimitsService({
    limitsPath,
    roots: () => [root],
    fetchClaude: async () => {
      appendFileSync(arg, `${process.pid}\n`);
      await Bun.sleep(300);
      const now = Date.now() / 1000;
      return capture("claude", now, { session: { pct: 10, resets: now + 3600 } });
    },
  });
  process.stdout.write(JSON.stringify(await service.refresh(null, 60)));
} else {
  // `arg` is this process's key prefix; each update names a different account.
  for (let i = 0; i < 40; i++) {
    updateLimitsCache(limitsPath, new Map([[`${arg}${i}`, { status: initialStatus() }]]));
  }
}
