// One contender in the lock stress (test/lock/stress.ts): it says it is ready, waits for
// the start signal, then until `until` keeps trying to take the lock. Each time it holds
// it, it logs the interval it is sure it held it for: "acquire" after taking it, "release"
// before giving it up. Any two logged intervals that overlap are two holders at once.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WriterLock } from "../../src/lock.ts";

const [path, dir, until] = process.argv.slice(2) as [string, string, string];
const log = join(dir, `log-${process.pid}`);
const now = () => performance.timeOrigin + performance.now();
writeFileSync(join(dir, `ready-${process.pid}`), "");
while (!existsSync(join(dir, "go"))) await Bun.sleep(1);
while (Date.now() < Number(until)) {
  const lock = WriterLock.tryAcquire({ path, owner: "cli" });
  if (lock === null) {
    await Bun.sleep(Math.random() * 3);
    continue;
  }
  appendFileSync(log, `acquire ${process.pid} ${now()}\n`);
  await Bun.sleep(Math.random() * 15);
  appendFileSync(log, `release ${process.pid} ${now()}\n`);
  lock.release();
  await Bun.sleep(Math.random() * 3);
}
