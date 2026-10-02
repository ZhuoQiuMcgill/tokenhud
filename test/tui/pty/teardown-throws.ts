// The TUI with a lock that throws when released, for the pty check that quitting exits
// even when a step of the teardown fails (T22).
import { WriterLock } from "../../../src/lock.ts";

WriterLock.prototype.release = () => {
  throw new Error("simulated failure releasing the lock");
};
const { runTui } = await import("../../../src/tui/main.ts");
process.exit(await runTui());
