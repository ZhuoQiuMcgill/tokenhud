// Runs before every test file when `bun test` is run from the repo root (bunfig.toml).
// It installs the test guard (test/guard.ts) before any test file loads, with its check on
// every test. Run from elsewhere, Bun reads no bunfig.toml; each test file's own `guard()`
// call installs it then.
import { guardEveryTest } from "./guard.ts";

guardEveryTest();
