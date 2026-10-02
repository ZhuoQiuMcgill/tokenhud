// For test/limits/clients.test.ts: what a Worker sees of the test guard.
import { findOnPath } from "../../src/limits/clients.ts";

declare const self: Worker;

self.postMessage({
  test: process.env.TOKENHUD_TEST ?? null,
  stubs: process.env.TOKENHUD_TEST_STUBS ?? null,
  claude: findOnPath("claude"),
});
