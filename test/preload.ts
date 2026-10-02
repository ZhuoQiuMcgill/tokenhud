// Runs before every test file (bunfig.toml).
import { afterAll, afterEach } from "bun:test";
import { installClientStubs, takeSpawned } from "./stubs.ts";
import { removeTempDir } from "./temp.ts";

// GitHub's Windows runners keep %TEMP% on the VM's OS disk, C:. Measured on two runners
// (T15): there a 4 KB write plus fsync took 5–8 ms at the median and up to 92 ms, and
// creating a store with a backup 120–200 ms; on the runner's temp disk, RUNNER_TEMP on D:,
// 0.3 ms and 11 ms. The whole suite took 150–310 s on C: and 71–81 s on D:. The store
// syncs whenever it creates a file, backs up or checkpoints, so tests that make stores
// waited seconds on C:, and in a slow spell ran past their 5 s timeout. On a Windows
// runner, tests therefore make their temp dirs under RUNNER_TEMP, which GitHub provides
// per job and empties after it. Child processes inherit the setting. Elsewhere nothing
// changes.
const runnerTemp = process.env.RUNNER_TEMP;
if (process.platform === "win32" && runnerTemp) {
  process.env.TEMP = runnerTemp;
  process.env.TMP = runnerTemp;
}

// No test may run the real `claude` or `codex` (T15: one ran the real claude against the
// real home). Stubs come first on PATH, and the product refuses any other client while
// TOKENHUD_TEST is set. Either way the attempt is recorded, and fails the test that made
// it, even if the code under test swallowed the error. Tests that need a client make their
// own stub and pass its path explicitly.
const stubs = installClientStubs();
afterEach(() => {
  const spawned = takeSpawned();
  if (spawned.length > 0) {
    throw new Error(
      `this test reached a real provider client (${spawned.join(", ")}); give it an explicit stub`,
    );
  }
});
afterAll(() => removeTempDir(stubs));
