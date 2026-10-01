// One contender in the lock race (test/lock/lock.test.ts). It says it's ready, waits for
// the start signal, tries to take the lock once, writes the result, and a winner holds the
// lock until every contender has reported, so nobody can win it after a release.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WriterLock } from "../../src/lock.ts";

const [path, dir] = process.argv.slice(2) as [string, string];
writeFileSync(join(dir, `ready-${process.pid}`), "");
while (!existsSync(join(dir, "go"))) await Bun.sleep(1);
const lock = WriterLock.tryAcquire({ path, owner: "cli" });
writeFileSync(join(dir, `result-${process.pid}`), lock === null ? "lost" : "won");
if (lock !== null) {
  while (!existsSync(join(dir, "done"))) await Bun.sleep(5);
  lock.release();
}
